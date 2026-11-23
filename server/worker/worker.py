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

## @brief URL мастер-сервера кластера.
MASTER_URL = os.getenv("MASTER_URL", "http://master:5000")
## @brief Максимальное количество одновременно выполняемых чанков (слотов).
MAX_CORES = int(os.getenv("MAX_CORES", os.cpu_count() or 2))
## @brief Резерв оперативной памяти для нужд ОС (в МБ).
RESERVED_RAM_MB = int(os.getenv("RESERVED_RAM_MB", 512))

## @brief Шаблон изолированного запуска пользовательского скрипта алгоритма в дочернем процессе.
RUNNER_WRAPPER = """
import os
import sys
import importlib.util

script_path = sys.argv[1]
raw_data = sys.stdin.read()

spec = importlib.util.spec_from_file_location("algo_module", script_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

if hasattr(module, "run_chunk"):
    print(module.run_chunk(raw_data))
else:
    raise RuntimeError("В скрипте не найдена функция run_chunk")
"""


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
def _numba_compute_kernel(n: int) -> float:
    """!
    @brief Вычислительное ядро на базе Numba JIT для нагрузочного замера FPU/SIMD процессора.
    @param n Количество итераций цикла.
    @return Накопленное значение с плавающей точкой.
    """
    acc = 0.0
    for i in range(1, n):
        acc += (i * 0.5) / (i % 7 + 1.0) - (acc * 1e-9)
    return acc


def run_micro_benchmark() -> int:
    """!
    @brief Выполняет прогрев JIT-компилятора и замеряет индекс производительности CPU.
    @return Суммарный балл производительности узла (benchmark_score).
    """
    _numba_compute_kernel(10)

    start = time.perf_counter()
    _numba_compute_kernel(50_000_000)
    elapsed = time.perf_counter() - start

    single_core_score = int(100 / max(elapsed, 0.001))
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

        # Инициализируем первый замер CPU psutil (первый вызов всегда возвращает 0.0)
        psutil.cpu_percent(interval=None)

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
        """!
        @brief Рекурсивно завершает процесс чанка и все его дочерние процессы.
        @param pid Идентификатор родительского процесса.
        @param reason Причина остановки ("OOM", "TIMEOUT", "MASTER_ABORT").
        @param cid Идентификатор чанка для фиксации причины в active_tasks.
        """
        if cid:
            with self.lock:
                if cid in self.active_tasks:
                    self.active_tasks[cid]["killed_by"] = reason
        try:
            parent = psutil.Process(pid)
            children = parent.children(recursive=True)
            for child in children:
                child.kill()
            parent.kill()
        except psutil.NoSuchProcess:
            pass

    def resource_watchdog_loop(self):
        """!
        @brief Фоновый поток контроля RSS-памяти активных чанков (защита от OOM).
        """
        while self.running:
            time.sleep(0.5)
            with self.lock:
                tasks_snapshot = list(self.active_tasks.items())

            for cid, info in tasks_snapshot:
                proc = info["proc"]
                limit_mb = info["max_ram_mb"]
                if not limit_mb or proc.poll() is not None:
                    continue

                try:
                    p = psutil.Process(proc.pid)
                    # Считаем RSS самого процесса и всех его дочерних процессов
                    rss_bytes = p.memory_info().rss
                    for child in p.children(recursive=True):
                        rss_bytes += child.memory_info().rss

                    used_mb = rss_bytes / (1024 * 1024)
                    if used_mb > limit_mb:
                        print(
                            f"[Watchdog] Чанк {cid} превысил лимит RAM ({used_mb:.1f} > {limit_mb} МБ). Убиваем."
                        )
                        self.kill_process_tree(proc.pid, reason="OOM", cid=cid)
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
        """!
        @brief Запускает отдельный чанк в изолированном подпроцессе с таймаутом и отправляет результат.
        @param chunk Словарь с параметрами чанка от мастера (chunkId, script, data, maxExecutionMs).
        """
        cid = chunk["chunkId"]
        timeout_sec = chunk.get("maxExecutionMs", 15000) / 1000.0
        # Мастер может прислать лимит памяти на чанк, иначе берем 1024 МБ по умолчанию
        max_ram_mb = chunk.get("maxRamMb", 1024)

        chunk_data = chunk.get("data", "{}")
        if not isinstance(chunk_data, str):
            chunk_data = json.dumps(chunk_data)

        start_time = time.time()

        with tempfile.NamedTemporaryFile(
            "w", suffix=".py", encoding="utf-8", delete=False
        ) as f:
            f.write(chunk["script"])
            script_path = f.name

        env = os.environ.copy()
        env["CHUNK_MAX_RAM_MB"] = str(max_ram_mb)

        proc = None
        try:
            proc = subprocess.Popen(
                [sys.executable, "-c", RUNNER_WRAPPER, script_path],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                env=env,
            )
            with self.lock:
                self.active_tasks[cid] = {
                    "proc": proc,
                    "max_ram_mb": max_ram_mb,
                    "killed_by": None,
                }

            stdout, stderr = proc.communicate(input=chunk_data, timeout=timeout_sec)
            elapsed_ms = int((time.time() - start_time) * 1000)

            with self.lock:
                killed_by = self.active_tasks.get(cid, {}).get("killed_by")

            if proc.returncode == 0 and not killed_by:
                api_post(
                    "/worker/submit",
                    {
                        "workerId": self.worker_id,
                        "chunkId": cid,
                        "status": "ok",
                        "executionTimeMs": elapsed_ms,
                        "output": stdout.strip(),
                    },
                )
            elif killed_by != "MASTER_ABORT":
                err_type = self.classify_error(stderr, proc.returncode, killed_by)
                err_msg = (
                    f"Memory limit ({max_ram_mb} MB) exceeded"
                    if killed_by == "OOM"
                    else (stderr.strip()[-300:] or f"Exit code {proc.returncode}")
                )
                api_post(
                    "/worker/submit",
                    {
                        "workerId": self.worker_id,
                        "chunkId": cid,
                        "status": "error",
                        "errorType": err_type,
                        "errorMessage": err_msg,
                    },
                )
        except subprocess.TimeoutExpired:
            if proc:
                self.kill_process_tree(proc.pid, reason="TIMEOUT", cid=cid)
            api_post(
                "/worker/submit",
                {
                    "workerId": self.worker_id,
                    "chunkId": cid,
                    "status": "error",
                    "errorType": "OOM_OR_TIMEOUT",
                    "errorMessage": f"Execution exceeded {chunk.get('maxExecutionMs')} ms",
                },
            )
        except Exception as e:
            print(f"[Worker] Ошибка обработки чанка {cid}: {e}")
        finally:
            with self.lock:
                self.active_tasks.pop(cid, None)
            if os.path.exists(script_path):
                os.remove(script_path)

    def run(self):
        """!
        @brief Главный цикл воркера: запускает фоновые потоки и запрашивает новые чанки (/worker/pull).
        """
        self.register()
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
    signal.signal(signal.SIGTERM, handle_sigterm)
    try:
        Worker().run()
    except KeyboardInterrupt:
        print("\n[Worker] Завершение работы...")
