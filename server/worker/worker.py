##
# @file worker.py
# @brief Универсальный вычислительный воркер с JIT-бенчмарком, контролем RAM и телеметрией.

import os
import sys
import time
import json
import signal
import platform
import subprocess
import threading
import tempfile
import urllib.request
import psutil
from numba import njit
import numpy as np

import multiprocessing as mp
import queue
import traceback
import types
import io
import contextlib

## @brief URL мастер-сервера кластера.
MASTER_URL = os.getenv("MASTER_URL", "http://master:5000").rstrip("/")
## @brief Максимальное количество одновременно выполняемых чанков (слотов).
MAX_CORES = int(os.getenv("MAX_CORES", os.cpu_count() or 2))
## @brief Резерв оперативной памяти для нужд ОС (в МБ).
RESERVED_RAM_MB = int(os.getenv("RESERVED_RAM_MB", 512))

# Используем 'fork' на Linux (мгновенный старт и общая RAM через Copy-on-Write)
# и 'spawn' на Windows/macOS
MP_CTX = mp.get_context("fork" if sys.platform.startswith("linux") else "spawn")

def _worker_slot_loop(conn):
    """!
    @brief Цикл жизни одного прогретого процесса-слота.
    Библиотеки numpy и numba уже загружены в память до форка!
    """
    # На Windows (spawn) прогреваем импорты один раз при создании слота
    import numpy  # noqa: F401
    import numba  # noqa: F401

    while True:
        try:
            task = conn.recv()
        except EOFError:
            break
        if task is None:
            break

        script_code, raw_data = task
        buf = io.StringIO()
        try:
            mod = types.ModuleType("algo_module")
            with contextlib.redirect_stdout(buf):
                exec(script_code, mod.__dict__)
                if not hasattr(mod, "run_chunk"):
                    raise RuntimeError("В скрипте не найдена функция run_chunk")
                res = mod.run_chunk(raw_data)
                if res is not None:
                    print(res)
            conn.send(("ok", buf.getvalue().strip(), ""))
        except Exception:
            conn.send(("error", "", traceback.format_exc()))

class WarmSlot:
    """!
    @brief Обертка над одним прогретым дочерним процессом с возможностью жесткого перезапуска.
    """

    def __init__(self):
        self.parent_conn, child_conn = MP_CTX.Pipe()
        self.proc = MP_CTX.Process(target=_worker_slot_loop, args=(child_conn,), daemon=True)
        self.proc.start()
        child_conn.close()

    def kill_and_respawn(self):
        try:
            if self.proc.is_alive():
                parent = psutil.Process(self.proc.pid)
                for child in parent.children(recursive=True):
                    child.kill()
                parent.kill()
                self.proc.join(timeout=1)
        except Exception:
            pass
        try:
            self.parent_conn.close()
        except Exception:
            pass
        # Поднимаем свежий прогретый слот взамен убитого
        self.__init__()


def get_system_metrics():
    """!
    @brief Собирает текущие метрики ресурсов хоста.
    @return Кортеж (total_ram_mb, avail_ram_mb, cpu_percent).
    """
    vm = psutil.virtual_memory()
    total_ram_mb = int(vm.total / (1024 * 1024))
    # Доступная память за вычетом системного резерва
    avail_ram_mb = max(0, int(vm.available / (1024 * 1024)) - RESERVED_RAM_MB)
    cpu_percent = psutil.cpu_percent(interval=None)
    return total_ram_mb, avail_ram_mb, cpu_percent


@njit(fastmath=True)
def _numba_bench_kernel(arr, value):
    """!
    @brief Вычислительное ядро на базе Numba JIT (тройной проход по массиву с SIMD-векторизацией).
    """
    count = 0.0
    for i in arr:
        for j in arr:
            for k in arr:
                count += (i * j * k) / value
    return count


def run_micro_benchmark() -> int:
    """!
    @brief Замеряет скорость JIT-компиляции и чистого выполнения Numba на 1 ядре.
    @return Суммарный балл производительности узла (benchmark_score).
    """
    rng = np.random.default_rng(42)
    data = rng.integers(1, 101, size=400, dtype=np.int32)

    # Первый вызов включает JIT-компиляцию + прогон
    t0 = time.perf_counter()
    _numba_bench_kernel(data, 1.0)
    t1 = time.perf_counter()

    # Второй вызов — чистое выполнение скомпилированного машинного кода
    _numba_bench_kernel(data, 16.0)
    t2 = time.perf_counter()

    run_sec = max(t2 - t1, 0.001)
    comp_sec = max((t1 - t0) - run_sec, 0.001)

    # Учитываем и скорость счета (85%), и скорость JIT-компиляции (15%)
    effective_time = run_sec + 0.15 * comp_sec
    single_core_score = int(100.0 / effective_time)
    return single_core_score * MAX_CORES


def api_post(path, payload):
    """!
    @brief Отправляет синхронный HTTP POST-запрос с JSON-телом на мастер-сервер.
    @param path Относительный путь эндпоинта (например, "/worker/pull").
    @param payload Словарь с данными для сериализации в JSON.
    @return Десериализованный JSON-ответ от мастера.
    """
    req = urllib.request.Request(
        f"{MASTER_URL}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


class Worker:
    """!
    @brief Основной класс вычислительного узла: регистрация, heartbeat, контроль памяти и запуск чанков.
    """

    def __init__(self):
        self.worker_id = None
        self.hb_interval = 2.0
        self.running = True
        self.lock = threading.Lock()
        self.active_tasks = {}
        self.slot_pool = queue.Queue()

        # Запускаем прогретые процессы (после прогрева Numba в бенчмарке!)
        psutil.cpu_percent(interval=None)

    def init_pool(self):
        for _ in range(MAX_CORES):
            self.slot_pool.put(WarmSlot())

    def register(self):
        """!
        @brief Регистрирует узел на мастере. Повторяет попытки каждые 2 секунды при недоступности сети.
        """
        total_ram, _, _ = get_system_metrics()
        bench_score = run_micro_benchmark()

        while self.running:
            try:
                res = api_post(
                    "/worker/register",
                    {
                        "arch": platform.machine(),
                        "os": platform.system().lower(),
                        "cpu_cores": MAX_CORES,
                        "ram_mb": total_ram,
                        "benchmark_score": bench_score,
                    },
                )
                self.worker_id = res["workerId"]
                self.hb_interval = res["heartbeatIntervalMs"] / 1000.0
                print(
                    f"[Worker] Зарегистрирован: {self.worker_id} | "
                    f"Ядер: {MAX_CORES} | RAM: {total_ram} МБ | Score: {bench_score}"
                )
                return
            except Exception as e:
                print(f"[Worker] Ожидание мастера ({e})...")
                time.sleep(2)

    def kill_process_tree(self, pid, reason=None, cid=None):
        if cid:
            with self.lock:
                if cid in self.active_tasks:
                    self.active_tasks[cid]["killed_by"] = reason
        try:
            parent = psutil.Process(pid)
            for child in parent.children(recursive=True):
                child.kill()
            parent.kill()
        except psutil.NoSuchProcess:
            pass

    def resource_watchdog_loop(self):
        while self.running:
            time.sleep(0.5)
            with self.lock:
                tasks_snapshot = list(self.active_tasks.items())

            for cid, info in tasks_snapshot:
                slot = info["slot"]
                limit_mb = info["max_ram_mb"]
                if not limit_mb or not slot.proc.is_alive():
                    continue

                try:
                    p = psutil.Process(slot.proc.pid)
                    rss_bytes = p.memory_info().rss
                    for child in p.children(recursive=True):
                        rss_bytes += child.memory_info().rss

                    used_mb = rss_bytes / (1024 * 1024)
                    if used_mb > limit_mb:
                        print(f"[Watchdog] Чанк {cid} превысил лимит RAM ({used_mb:.1f} > {limit_mb} МБ). Убиваем.")
                        self.kill_process_tree(slot.proc.pid, reason="OOM", cid=cid)
                except psutil.NoSuchProcess:
                    pass

    def heartbeat_loop(self):
        """!
        @brief Фоновый поток отправки телеметрии на мастер и обработки команд (ban / abortChunkIds).
        """
        while self.running:
            time.sleep(self.hb_interval)
            if not self.worker_id:
                continue

            _, avail_ram, cpu_load = get_system_metrics()
            with self.lock:
                active_ids = list(self.active_tasks.keys())

            try:
                res = api_post(
                    "/worker/heartbeat",
                    {
                        "workerId": self.worker_id,
                        "activeChunkIds": active_ids,
                        "cpuLoadPercent": round(cpu_load, 1),
                        "availableRamMb": avail_ram,
                    },
                )
                if res.get("workerCommand") == "ban":
                    print("[Worker] Узел заблокирован мастером (BFT ban). Остановка.")
                    self.running = False
                    return

                for cid in res.get("abortChunkIds", []):
                    with self.lock:
                        task = self.active_tasks.get(cid)
                    if task:
                        print(f"[Worker] Прерывание чанка {cid} по команде мастера")
                        self.kill_process_tree(
                            task["proc"].pid, reason="MASTER_ABORT", cid=cid
                        )
            except Exception:
                # При потере связи или перезапуске мастера сбрасываем ID и перерегистрируемся
                self.worker_id = None
                self.register()

    def classify_error(self, stderr_text, returncode, killed_by):
        """!
        @brief Классифицирует ошибку выполнения скрипта для передачи мастеру и Lua-оркестратору.
        @return Строковый код ошибки ("OOM_OR_TIMEOUT", "SyntaxError", "FatalAlgorithmError", "SANDBOX_CRASH").
        """
        if killed_by == "OOM" or "MemoryError" in stderr_text:
            return "OOM_OR_TIMEOUT"
        if "SyntaxError" in stderr_text or "IndentationError" in stderr_text:
            return "SyntaxError"
        if any(
            err in stderr_text
            for err in (
                "NameError",
                "TypeError",
                "RuntimeError",
                "ValueError",
                "ZeroDivisionError",
            )
        ):
            return "FatalAlgorithmError"
        return "SANDBOX_CRASH"

    def execute_chunk(self, chunk):
        cid = chunk["chunkId"]
        timeout_sec = chunk.get("maxExecutionMs", 15000) / 1000.0
        max_ram_mb = chunk.get("maxRamMb", 1024)

        chunk_data = chunk.get("data", "{}")
        if not isinstance(chunk_data, str):
            chunk_data = json.dumps(chunk_data)

        slot = self.slot_pool.get()
        start_time = time.time()
        slot_broken = False

        try:
            with self.lock:
                self.active_tasks[cid] = {
                    "slot": slot,
                    "proc": slot.proc, # Для совместимости с heartbeat abortChunkIds
                    "max_ram_mb": max_ram_mb,
                    "killed_by": None,
                }

            slot.parent_conn.send((chunk["script"], chunk_data))

            # Ждем ответ с таймаутом
            if not slot.parent_conn.poll(timeout_sec):
                self.kill_process_tree(slot.proc.pid, reason="TIMEOUT", cid=cid)
                slot_broken = True
                api_post("/worker/submit", {
                    "workerId": self.worker_id,
                    "chunkId": cid,
                    "status": "error",
                    "errorType": "OOM_OR_TIMEOUT",
                    "errorMessage": f"Execution exceeded {chunk.get('maxExecutionMs')} ms",
                })
                return

            status, out_text, err_text = slot.parent_conn.recv()
            elapsed_ms = int((time.time() - start_time) * 1000)

            with self.lock:
                killed_by = self.active_tasks.get(cid, {}).get("killed_by")

            if status == "ok" and not killed_by:
                api_post("/worker/submit", {
                    "workerId": self.worker_id,
                    "chunkId": cid,
                    "status": "ok",
                    "executionTimeMs": elapsed_ms,
                    "output": out_text,
                })
            elif killed_by != "MASTER_ABORT":
                err_type = self.classify_error(err_text, 1, killed_by)
                err_msg = (
                    f"Memory limit ({max_ram_mb} MB) exceeded"
                    if killed_by == "OOM"
                    else (err_text.strip()[-300:] or "Worker execution error")
                )
                api_post("/worker/submit", {
                    "workerId": self.worker_id,
                    "chunkId": cid,
                    "status": "error",
                    "errorType": err_type,
                    "errorMessage": err_msg,
                })
        except (EOFError, BrokenPipeError, OSError):
            # Сюда попадаем, если процесс был убит по OOM или MASTER_ABORT во время ожидания recv()
            slot_broken = True
            with self.lock:
                killed_by = self.active_tasks.get(cid, {}).get("killed_by")
            if killed_by == "OOM":
                api_post("/worker/submit", {
                    "workerId": self.worker_id,
                    "chunkId": cid,
                    "status": "error",
                    "errorType": "OOM_OR_TIMEOUT",
                    "errorMessage": f"Memory limit ({max_ram_mb} MB) exceeded",
                })
        except Exception as e:
            slot_broken = True
            print(f"[Worker] Ошибка обработки чанка {cid}: {e}")
        finally:
            with self.lock:
                self.active_tasks.pop(cid, None)
            if slot_broken or not slot.proc.is_alive():
                slot.kill_and_respawn()
            self.slot_pool.put(slot)

    def run(self):
        """!
        @brief Главный цикл воркера: запускает фоновые потоки и запрашивает новые чанки (/worker/pull).
        """
        self.register()
        self.init_pool()
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()
        threading.Thread(target=self.resource_watchdog_loop, daemon=True).start()

        try:
            while self.running:
                _, avail_ram, cpu_load = get_system_metrics()
                with self.lock:
                    free_slots = MAX_CORES - len(self.active_tasks)

                # Не берем новые задачи, если свободной памяти меньше 256 МБ или CPU забит на 95%+
                if (
                    free_slots > 0
                    and avail_ram >= 256
                    and cpu_load < 95.0
                    and self.worker_id
                ):
                    try:
                        res = api_post(
                            "/worker/pull",
                            {
                                "workerId": self.worker_id,
                                "freeSlots": free_slots,
                                "availableRamMb": avail_ram,
                            },
                        )
                        for ch in res.get("chunks", []):
                            threading.Thread(
                                target=self.execute_chunk, args=(ch,), daemon=True
                            ).start()
                        time.sleep(res.get("retryAfterMs", 500) / 1000.0)
                    except Exception:
                        time.sleep(2)
                else:
                    time.sleep(0.5)
        finally:
            self.running = False
            with self.lock:
                for cid, info in list(self.active_tasks.items()):
                    self.kill_process_tree(info["proc"].pid)
            if self.worker_id:
                try:
                    api_post("/worker/unregister", {"workerId": self.worker_id})
                except Exception:
                    pass


def handle_sigterm(signum, frame):
    """!
    @brief Обработчик сигнала SIGTERM для корректного завершения работы контейнера/сервиса.
    """
    raise KeyboardInterrupt()


if __name__ == "__main__":
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, handle_sigterm)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, handle_sigterm)
    try:
        Worker().run()
    except KeyboardInterrupt:
        print("\n[Worker] Завершение работы...")

