import time
import json
import urllib.request
import urllib.error

MASTER_URL = "http://localhost:5000"


def http_request(path, payload=None):
    """Вспомогательная функция для GET (если payload=None) и POST запросов."""
    url = f"{MASTER_URL}{path}"
    if payload is not None:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
    else:
        req = urllib.request.Request(url, method="GET")

    with urllib.request.urlopen(req, timeout=10) as resp:
        raw = resp.read().decode("utf-8")
        # Для /get_full_result сервер отдает HTML, для остальных эндпоинтов — JSON
        if "application/json" in resp.headers.get("Content-Type", ""):
            return json.loads(raw)
        return raw


def run_demo():
    # 1. Проверяем, жив ли кластер и есть ли онлайн-воркеры
    status = http_request("/api/v1/cluster_status")
    print(f"[1] Статус кластера: воркеров онлайн = {status['onlineWorkers']}, ядер = {status['totalCpuCores']}")
    if not status["isAvailable"]:
        print("Внимание: в кластере нет ни одного активного воркера, задача будет висеть в очереди!")

    # 2. Получаем список доступных алгоритмов и схему параметров нужного нам плагина
    algos = http_request("/api/v1/get_types")
    print(f"[2] Доступные алгоритмы: {[a['id'] for a in algos]}")

    target_algo = "_template_minimal"
    schema = http_request(f"/api/v1/get_schema?id={target_algo}")
    print(f"    Схема параметров '{target_algo}': {schema}")

    # 3. Отправляем задачу на выполнение
    submit_res = http_request("/api/v1/submit_task", {
        "analysis_type": target_algo,
        "params": {"x": 21}
    })
    task_id = submit_res["taskId"]
    print(f"[3] Задача создана! ID: {task_id}")

    # 4. Опрашиваем статус задачи (polling), пока она не перейдет в ready или failed
    while True:
        check = http_request(f"/api/v1/check_task?taskId={task_id}")
        state = check["status"]
        print(f"    Текущий статус: {state}")

        if state == "ready":
            print(f"[4] Краткий результат: {check['short_result']}")
            break
        elif state in ("failed", "cancelled"):
            print(f"[!] Задача завершилась с ошибкой: {check.get('error')}")
            return

        time.sleep(1)

    # 5. Забираем полный HTML-отчет
    html_report = http_request(f"/api/v1/get_full_result?taskId={task_id}")
    print(f"[5] Полный HTML-отчет:\n{html_report}")


if __name__ == "__main__":
    try:
        run_demo()
    except urllib.error.HTTPError as e:
        print(f"HTTP ошибка {e.code}: {e.read().decode('utf-8')}")
    except Exception as e:
        print(f"Ошибка соединения с мастером: {e}")

