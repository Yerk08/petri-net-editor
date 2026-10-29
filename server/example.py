import time
import uuid
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # Разрешаем кросс-доменные запросы от фронтенда

# --- БАЗА ДАННЫХ ЗАДАЧ В ПАМЯТИ ---
# Хранит задачи в формате: { taskId: { "status": str, "created_at": float, "type": str, "short_result": str } }
TASKS_DB = {}

ANALYSIS_TYPES = [
    {"id": "some_1", "name": "Анализ достижимости (Reachability)"},
    {"id": "some_2", "name": "Поиск тупиков (Deadlock Detection)"},
    {"id": "some_3", "name": "Расчет Т-инвариантов (T-Invariants)"},
    {"id": "some_4", "name": "Расчет Р-инвариантов (P-Invariants)"},
    {"id": "some_5", "name": "Анализ ограниченности (Boundedness)"},
    {"id": "some_6", "name": "Анализ живости (Liveness Analysis)"}
]

ANALYSIS_SCHEMAS = {
    "some_1": [
        {"id": "max_depth", "name": "Максимальная глубина поиска дерева", "type": "number"},
        {"id": "target_marking", "name": "Целевая разметка (через запятую)", "type": "string"},
        {
            "id": "search_strategy", 
            "name": "Стратегия обхода графа", 
            "type": "dict", 
            "options": {
                "bfs": "Поиск в ширину (BFS)",
                "dfs": "Поиск в глубину (DFS)"
            }
        }
    ],
    "some_2": [
        {"id": "stop_on_first", "name": "Остановиться при первом найденном тупике", "type": "dict", "options": {"true": "Да", "false": "Нет"}},
        {
            "id": "ignored_places", 
            "name": "Исключить позиции из анализа (Тест списка)", 
            "type": "list",
            "options": [
                {"name": "Игнорировать входные буферы", "value": "p_input"},
                {"name": "Игнорировать выходные буферы", "value": "p_output"},
                {"name": "Игнорировать критические секции", "value": "p_critical"}
            ]
        }
    ],
    "some_3": [
        {"id": "max_invariants", "name": "Лимит вычисляемых инвариантов", "type": "number"},
        {"id": "algorithm_version", "name": "Версия алгоритма расчета", "type": "dict", "options": {"farkas": "Метод Фаркаша", "fourier": "Модифицированный метод Моцкина"}}
    ],
    "some_4": [
        {"id": "compress_matrix", "name": "Сжимать матрицу инцидентности", "type": "dict", "options": {"yes": "Включить", "no": "Выключить"}}
    ],
    "some_5": [
        {"id": "bound_limit", "name": "Верхняя граница K-ограниченности", "type": "number"}
    ],
    "some_6": [
        {"id": "description", "name": "Это описание работы данного вида анализа", "type": "description"},
        {"id": "liveness_level", "name": "Интересующий уровень живости (0-4)", "type": "number"},
        {
            "id": "fairness_constraints", 
            "name": "Условия справедливости (Fairness)", 
            "type": "list",
            "options": [
                {"name": "Слабая справедливость (Weak)", "value": "weak"},
                {"name": "Сильная справедливость (Strong)", "value": "strong"}
            ]
        },
        {"id": "analysis_net_colors", "name": "Цвета сети для проверки", "type": "color_filter"},
        {"id": "analysis_net_marking", "name": "Разметка сети для проверки", "type": "marking_filter"},
        {"id": "analysis_net_marking2", "name": "Разметка сети 2", "type": "marking_filter"}
    ]
}

@app.route('/api/v1/get_types', methods=['GET'])
def get_types():
    return jsonify(ANALYSIS_TYPES)

@app.route('/api/v1/get_schema', methods=['GET'])
def get_schema():
    analysis_id = request.args.get('id')
    schema = ANALYSIS_SCHEMAS.get(analysis_id, [])
    return jsonify(schema)


# --- НОВЫЙ МАРШРУТ: ПРИЕМ ЗАДАЧИ НА АНАЛИЗ ---
@app.route('/api/v1/submit_task', methods=['POST'])
def submit_task():
    data = request.get_json() or {}
    analysis_type = data.get("analysis_type")
    params = data.get("params", {})
    net_structure = data.get("net_structure", {})

    if not analysis_type:
        return jsonify({"error": "Missing analysis_type"}), 400

    # Генерируем уникальный taskId
    task_id = str(uuid.uuid4())[:8]

    # Считаем количество переданных переходов в структуре сетей для логирования
    total_transitions = 0
    for field_id, t_list in net_structure.items():
        if isinstance(t_list, list):
            total_transitions += len(t_list)

    print(f"\n[Task {task_id}] Принята задача типа '{analysis_type}'.")
    print(f"[Task {task_id}] Параметры: {params}")
    print(f"[Task {task_id}] Обнаружено переходов в структурах цветных полей: {total_transitions}")

    # Определяем индивидуальный тестовый текстовый результат на основе вида анализа
    if analysis_type == "some_1":
        short_res = f"Целевое состояние достижимо. Дерево раскрыто до уровня {params.get('max_depth', 10)}. Обработано переходов: {total_transitions}."
    elif analysis_type == "some_2":
        short_res = "Тупиковые состояния (deadlocks) в структуре сети не обнаружены." if total_transitions > 0 else "Сеть пуста. Тупиков нет."
    elif analysis_type == "some_3":
        short_res = f"Успешно вычислено Т-инвариантов: {min(int(params.get('max_invariants', 5)), total_transitions + 1)}. Матрица сбалансирована."
    elif analysis_type == "some_4":
        short_res = "Р-инварианты найдены. Структурные свойства сохранения веса фишек подтверждены."
    elif analysis_type == "some_5":
        short_res = f"Сеть является К-ограниченной. Максимальная емкость позиций не превышает предел {params.get('bound_limit', 5)}."
    elif analysis_type == "some_6":
        short_res = f"Живость сети соответствует уровню {params.get('liveness_level', 2)}. Асимптотические тупики отсутствуют."
    else:
        short_res = "Анализ успешно выполнен."

    # Сохраняем задачу со статусом вычисления 'active'
    TASKS_DB[task_id] = {
        "status": "active",
        "created_at": time.time(),
        "type": analysis_type,
        "short_result": short_res
    }

    return jsonify({"taskId": task_id})


# --- НОВЫЙ МАРШРУТ: АДАПТИВНЫЙ ОПРОС СОСТОЯНИЯ (POLLING) ---
@app.route('/api/v1/check_task', methods=['GET'])
def check_task():
    task_id = request.args.get('taskId')
    task = TASKS_DB.get(task_id)

    if not task:
        return jsonify({"status": "failed", "error": "Задача не найдена"}), 404

    # Имитируем фоновые вычисления: первые 4 секунды после создания задача находится в обработке
    elapsed_time = time.time() - task["created_at"]
    if task["status"] == "active" and elapsed_time > 3.0:
        task["status"] = "ready" if hash(task_id) % 2 == 0 else "failed"
        print(f"[Task {task_id}] Расчеты завершены! Статус изменен на '{task["status"]}'.")

    # Формируем ответ согласно требованиям фронтенда
    response = {"status": task["status"]}
    if task["status"] == "ready":
        response["short_result"] = task["short_result"]
    elif task["status"] == "failed":
        response["error"] = task.get("error", "Внутренняя ошибка сервера")

    return jsonify(response)


# --- НОВЫЙ МАРШРУТ: ОТМЕНА ЗАДАЧИ ---
@app.route('/api/v1/cancel_task', methods=['POST'])
def cancel_task():
    data = request.get_json() or {}
    task_id = data.get("taskId")
    task = TASKS_DB.get(task_id)

    if task:
        task["status"] = "cancelled"
        print(f"[Task {task_id}] Вычисление прервано пользователем (Отмена).")
        return jsonify({"status": "success", "message": "Task cancelled"})
    
    return jsonify({"error": "Task not found"}), 404


from flask import request, render_template_string
@app.route('/api/v1/get_full_result', methods=['GET'])
def get_full_result():
    task_id = request.args.get('taskId')
    task = TASKS_DB.get(task_id)

    if not task:
        return "<h3>Ошибка: Задача не найдена или была удалена из памяти сервера.</h3>", 404

    # Извлекаем данные для построения отчета
    status = task["status"]
    analysis_type = task["type"]
    params = task.get("params", {})
    
    # Ищем человекочитаемое имя типа анализа
    type_name = next((t["name"] for t in ANALYSIS_TYPES if t["id"] == analysis_type), "Неизвестный анализ")

    # Извлекаем список переходов (если он был сгенерирован и передан во фронтенде прямо в params)
    transitions_table_rows = ""
    for field_id, value in params.items():
        if isinstance(value, list) and len(value) > 0 and isinstance(value[0], dict):
            for idx, trans in enumerate(value):
                inputs_str = ", ".join(trans.get("inputs", [])) or "∅"
                outputs_str = ", ".join(trans.get("outputs", [])) or "∅"
                transitions_table_rows += f"""
                <tr>
                    <td><code>{field_id}</code></td>
                    <td><b>{trans.get('name', f'T_{idx}')}</b></td>
                    <td style="color: #0056b3; font-style: italic;">{inputs_str}</td>
                    <td style="color: #0056b3; font-style: italic;">{outputs_str}</td>
                </tr>
                """

    if not transitions_table_rows:
        transitions_table_rows = "<tr><td colspan='4' style='text-align:center; color:#888;'>Структурные цветовые фильтры не передавались или граф пуст</td></tr>"

    # HTML-шаблон со встроенными стилями для рендеринга внутри iframe
    html_template = """
    <!DOCTYPE html>
    <html lang="ru">
    <head>
        <meta charset="UTF-8">
        <title>Отчет об анализе сети Петри</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                line-height: 1.5; padding: 20px; color: #333; background-color: #fff; margin: 0;
            }
            .header { border-bottom: 2px solid #007bff; margin-bottom: 20px; padding-bottom: 10px; }
            .header h1 { margin: 0 0 5px 0; font-size: 1.8em; color: #007bff; }
            .status-badge {
                display: inline-block; padding: 4px 12px; font-weight: bold; border-radius: 12px; font-size: 0.9em;
            }
            .status-ready { background-color: #d4edda; color: #155724; }
            .status-active { background-color: #fff3cd; color: #856404; }
            .status-failed { background-color: #f8d7da; color: #721c24; }
            .status-cancelled { background-color: #e2e3e5; color: #383d41; }
            
            .section { margin-top: 25px; }
            .section h3 { margin: 0 0 10px 0; border-bottom: 1px solid #eee; padding-bottom: 5px; color: #555; }
            
            table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.9em; }
            th, td { border: 1px solid #dee2e6; padding: 8px 12px; text-align: left; }
            th { background-color: #f8f9fa; color: #495057; }
            tr:nth-child(even) { background-color: #fcfcfc; }
            
            code { background-color: #f1f3f5; padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 0.95em; }
            .log-box { background: #212529; color: #f8f9fa; padding: 15px; border-radius: 4px; font-family: monospace; font-size: 0.85em; white-space: pre-wrap; overflow-x: auto; }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>📄 Детальный отчет: {{ type_name }}</h1>
            <div>
                ID задачи: <code>{{ task_id }}</code> | 
                Статус: <span class="status-badge status-{{ status }}">{{ status }}</span>
            </div>
        </div>

        <div class="section">
            <h3>📌 Краткое резюме</h3>
            <p style="font-size: 1.1em; font-weight: 500; color: #2b2b2b;">
                {{ task.get('short_result', task.get('error', 'Информация отсутствует.')) }}
            </p>
        </div>

        <div class="section">
            <h3>⚙️ Конфигурация параметров алгоритма</h3>
            <table>
                <thead>
                    <tr>
                        <th>Идентификатор поля</th>
                        <th>Значение (Переданные настройки)</th>
                    </tr>
                </thead>
                <tbody>
                    {% for k, v in params.items() %}
                        {% if v is not iterable or v is string %}
                        <tr>
                            <td><code>{{ k }}</code></td>
                            <td>{{ v }}</td>
                        </tr>
                        {% endif %}
                    {% endfor %}
                </tbody>
            </table>
        </div>

        <div class="section">
            <h3>🔀 Извлеченная структура переходов (Мультимножества)</h3>
            <table>
                <thead>
                    <tr>
                        <th>Родительское поле</th>
                        <th>Название перехода</th>
                        <th>Входное мультимножество (Inputs)</th>
                        <th>Выходное мультимножество (Outputs)</th>
                    </tr>
                </thead>
                <tbody>
                    {{ transitions_table_rows|safe }}
                </tbody>
            </table>
        </div>

        <div class="section">
            <h3>💻 Машинные логи выполнения</h3>
            <div class="log-box">[INFO] {{ task.get('created_at') }} - Инициализация подсистемы расчетов сетей Петри.
[INFO] Парсинг конфигурационной матрицы инцидентности завершен.
[DEBUG] Найдено параметров в стэке: {{ params|length }}.
[INFO] Построение дерева состояний...
{% if status == 'ready' %}[SUCCESS] Вычисления завершены успешно. Код возврата: 0.
{% elif status == 'failed' %}[ERROR] Ошибка выполнения: Крах инвариантного уравнения. Код возврата: 1.
{% else %}[WARNING] Задача была принудительно прервана или находится в обработке.{% endif %}</div>
        </div>
    </body>
    </html>
    """

    return render_template_string(
        html_template, 
        task_id=task_id, 
        task=task, 
        status=status, 
        type_name=type_name, 
        params=params, 
        transitions_table_rows=transitions_table_rows
    )

if __name__ == '__main__':
    print("Сервер анализа сетей Петри запущен!")
    print("Адрес для ввода в клиенте: http://127.0.0.1:5000")
    app.run(host='0.0.0.0', port=5000, debug=True)
