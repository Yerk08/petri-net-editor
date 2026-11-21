import time
import uuid
import random
from flask import Flask, jsonify, request, render_template_string
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# База данных задач в памяти
TASKS_DB = {}

# Список видов анализа (Сценарий 1 и Сценарий 2)
ANALYSIS_TYPES = [
    {"id": "some_1", "name": "Успешный анализ (Сценарий 1)"},
    {"id": "some_2", "name": "Ошибочный анализ (Сценарий 2)"}
]

# Схемы параметров для фронтенда
ANALYSIS_SCHEMAS = {
    # Сценарий 1: по одному экземпляру базовых типов, по два для color и marking
    "some_1": [
        {"id": "param_num", "name": "Числовой параметр (number)", "type": "number"},
        {"id": "param_str", "name": "Строковый параметр (string)", "type": "string"},
        {"id": "param_desc", "name": "Текстовое описание (description)", "type": "description"},
        {"id": "param_dict", "name": "Выпадающий список (dict)", "type": "dict", "options": {"opt1": "Вариант А", "opt2": "Вариант Б"}},
        {"id": "param_list", "name": "Список чекбоксов (list)", "type": "list", "options": [{"name": "Элемент 1", "value": "val1"}, {"name": "Элемент 2", "value": "val2"}]},
        # Фильтры цвета и разметки (в двойном экземпляре)
        {"id": "color_filter_1", "name": "Фильтр цвета 1", "type": "color_filter"},
        {"id": "color_filter_2", "name": "Фильтр цвета 2", "type": "color_filter"},
        {"id": "marking_filter_1", "name": "Фильтр разметки 1", "type": "marking_filter"},
        {"id": "marking_filter_2", "name": "Фильтр разметки 2", "type": "marking_filter"}
    ],
    # Сценарий 2: пустая схема
    "some_2": []
}


@app.route('/api/v1/cluster_status', methods=['GET'])
def cluster_status():
    """Возвращает симулируемое состояние вычислительного кластера для Диспетчера."""
    active_tasks = sum(1 for t in TASKS_DB.values() if t["status"] == "active")
    online_workers = random.randint(3, 6)
    total_cores = online_workers * 8
    total_ram_mb = online_workers * 16384
    total_benchmark = online_workers * 1450
    queued_chunks = active_tasks * random.randint(12, 35)

    return jsonify({
        "isAvailable": online_workers > 0,
        "onlineWorkers": online_workers,
        "totalCpuCores": total_cores,
        "totalRamMb": total_ram_mb,
        "totalBenchmarkScore": total_benchmark,
        "activeTasksCount": active_tasks,
        "queuedChunksCount": queued_chunks
    })


@app.route('/api/v1/get_types', methods=['GET'])
def get_types():
    return jsonify(ANALYSIS_TYPES)


@app.route('/api/v1/get_schema', methods=['GET'])
def get_schema():
    analysis_id = request.args.get('id')
    return jsonify(ANALYSIS_SCHEMAS.get(analysis_id, []))


@app.route('/api/v1/submit_task', methods=['POST'])
def submit_task():
    data = request.get_json() or {}
    analysis_type = data.get("analysis_type")
    params = data.get("params", {})

    if not analysis_type:
        return jsonify({"error": "Missing analysis_type"}), 400

    task_id = str(uuid.uuid4())[:8]

    short_res = (
        "Анализ успешно завершен (Да). Все параметры верифицированы."
        if analysis_type == "some_1"
        else "Ошибка инициализации."
    )

    TASKS_DB[task_id] = {
        "status": "active",
        "created_at": time.time(),
        "type": analysis_type,
        "params": params,
        "short_result": short_res
    }
    return jsonify({"taskId": task_id})


@app.route('/api/v1/check_task', methods=['GET'])
def check_task():
    task_id = request.args.get('taskId')
    task = TASKS_DB.get(task_id)

    if not task:
        return jsonify({"status": "failed", "error": "Задача не найдена"}), 404

    # Имитация работы распределенного кластера (5 секунд)
    elapsed_time = time.time() - task["created_at"]
    if task["status"] == "active" and elapsed_time > 5.0:
        if task["type"] == "some_1":
            task["status"] = "ready"
        else:
            task["status"] = "failed"
            task["error"] = "Критический сбой: Анализ не может быть выполнен (Превышено время ожидания / Тупик)"

    response = {"status": task["status"]}
    if task["status"] == "ready":
        response["short_result"] = task["short_result"]
    elif task["status"] == "failed":
        response["error"] = task.get("error", "Внутренняя ошибка сервера")

    return jsonify(response)


@app.route('/api/v1/cancel_task', methods=['POST'])
def cancel_task():
    data = request.get_json() or {}
    task_id = data.get("taskId")
    task = TASKS_DB.get(task_id)

    if task:
        task["status"] = "cancelled"
        return jsonify({"status": "success", "message": "Task cancelled"})
    return jsonify({"error": "Task not found"}), 404


@app.route('/api/v1/get_full_result', methods=['GET'])
def get_full_result():
    task_id = request.args.get('taskId')
    task = TASKS_DB.get(task_id)

    if not task:
        return "<h3>Ошибка: Задача не найдена</h3>", 404

    if task["status"] == "failed":
        return f"<h3>Критическая ошибка расчетов: {task.get('error')}</h3>", 500

    html_template = """
    <!DOCTYPE html>
    <html lang="ru">
    <head>
        <meta charset="UTF-8">
        <style>
            body { font-family: sans-serif; padding: 20px; color: #333; line-height: 1.4; }
            h2 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 8px; }
            .meta { color: #7f8c8d; font-size: 0.9em; margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; margin-top: 15px; }
            th, td { border: 1px solid #bdc3c7; padding: 10px; text-align: left; }
            th { background-color: #ecf0f1; font-weight: bold; }
            code { background: #f8f9fa; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
        </style>
    </head>
    <body>
        <h2>📄 Отчет по анализу параметров задачи</h2>
        <div class="meta">Статус: <b>{{ task['status'] }}</b></div>
        
        <p><b>Результат:</b> {{ task['short_result'] }}</p>
        
        <h3>Входные конфигурационные параметры:</h3>
        <table>
            <thead>
                <tr>
                    <th>Параметр (Ключ)</th>
                    <th>Значение</th>
                </tr>
            </thead>
            <tbody>
                {% for k, v in task['params'].items() %}
                <tr>
                    <td><code>{{ k }}</code></td>
                    <td>{{ v }}</td>
                </tr>
                {% endfor %}
            </tbody>
        </table>
    </body>
    </html>
    """
    return render_template_string(html_template, task=task)


if __name__ == '__main__':
    print("Mock Client-сервер запущен на http://127.0.0.1:5000")
    app.run(host='0.0.0.0', port=5000, debug=True)
