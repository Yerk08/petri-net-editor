import os
import time
import platform
import subprocess
import threading
import tempfile
import urllib.request
import json

MASTER_URL = os.getenv("MASTER_URL", "http://master:5000")
MAX_WORKERS = int(os.getenv("MAX_WORKERS", os.cpu_count() or 2))

def api_post(path, payload):
    req = urllib.request.Request(
        f"{MASTER_URL}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))

class PetriWorker:
    def __init__(self):
        self.worker_id = None
        self.hb_interval = 3.0
        self.running = True
        self.lock = threading.Lock()
        self.active_procs = {}  # chunk_id -> subprocess.Popen

    def register(self):
        while self.running:
            try:
                res = api_post("/worker/register", {
                    "arch": platform.machine(),
                    "os": platform.system().lower(),
                    "cpu_cores": MAX_WORKERS,
                    "ram_mb": 4096,
                    "benchmark_score": MAX_WORKERS * 250
                })
                self.worker_id = res["workerId"]
                self.hb_interval = res["heartbeatIntervalMs"] / 1000.0
                print(f"[Worker] Зарегистрирован как {self.worker_id} (слотов: {MAX_WORKERS})")
                return
            except Exception as e:
                print(f"[Worker] Ожидание мастера ({e})...")
                time.sleep(2)

    def heartbeat_loop(self):
        while self.running:
            time.sleep(self.hb_interval)
            if not self.worker_id:
                continue
            with self.lock:
                active_ids = list(self.active_procs.keys())
            try:
                res = api_post("/worker/heartbeat", {
                    "workerId": self.worker_id,
                    "activeChunkIds": active_ids,
                    "cpuLoadPercent": (len(active_ids) / MAX_WORKERS) * 100.0
                })
                if res.get("workerCommand") == "ban":
                    print("[Worker] Узел заблокирован мастером (BFT ban). Остановка.")
                    self.running = False
                    return

                for cid in res.get("abortChunkIds", []):
                    with self.lock:
                        proc = self.active_procs.get(cid)
                        if proc:
                            print(f"[Worker] Прерывание чанка {cid} по команде мастера")
                            proc.kill()
            except Exception:
                self.worker_id = None
                self.register()

    def execute_chunk(self, chunk):
        cid = chunk["chunkId"]
        timeout_sec = chunk["maxExecutionMs"] / 1000.0
        start_time = time.time()

        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
            f.write(chunk["script"])
            script_path = f.name

        try:
            proc = subprocess.Popen(
                ["python3", script_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            with self.lock:
                self.active_procs[cid] = proc

            stdout, stderr = proc.communicate(timeout=timeout_sec)
            elapsed_ms = int((time.time() - start_time) * 1000)

            if proc.returncode == 0:
                api_post("/worker/submit", {
                    "workerId": self.worker_id,
                    "chunkId": cid,
                    "status": "success",
                    "executionTimeMs": elapsed_ms,
                    "output": stdout.strip()
                })
            elif proc.returncode != -9:  # -9 означает принудительный abort от мастера
                api_post("/worker/submit", {
                    "workerId": self.worker_id,
                    "chunkId": cid,
                    "status": "error",
                    "errorType": "SANDBOX_CRASH",
                    "errorMessage": stderr.strip()[:300] or f"Exit code {proc.returncode}"
                })
        except subprocess.TimeoutExpired:
            proc.kill()
            api_post("/worker/submit", {
                "workerId": self.worker_id,
                "chunkId": cid,
                "status": "error",
                "errorType": "OOM_OR_TIMEOUT",
                "errorMessage": f"Execution exceeded {chunk['maxExecutionMs']} ms"
            })
        except Exception as e:
            print(f"[Worker] Ошибка отправки результата {cid}: {e}")
        finally:
            with self.lock:
                self.active_procs.pop(cid, None)
            if os.path.exists(script_path):
                os.remove(script_path)

    def run(self):
        self.register()
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()

        try:
            while self.running:
                with self.lock:
                    free_slots = MAX_WORKERS - len(self.active_procs)

                if free_slots > 0 and self.worker_id:
                    try:
                        res = api_post("/worker/pull", {
                            "workerId": self.worker_id,
                            "freeSlots": free_slots,
                            "availableRamMb": 4096
                        })
                        for ch in res.get("chunks", []):
                            threading.Thread(target=self.execute_chunk, args=(ch,), daemon=True).start()
                        time.sleep(res.get("retryAfterMs", 2000) / 1000.0)
                    except Exception:
                        time.sleep(2)
                else:
                    time.sleep(0.5)
        finally:
            if self.worker_id:
                try:
                    api_post("/worker/unregister", {"workerId": self.worker_id})
                except Exception:
                    pass

if __name__ == "__main__":
    PetriWorker().run()

