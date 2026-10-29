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

    # Сохраняем задачу со статусом вычисления 'processing'
    TASKS_DB[task_id] = {
        "status": "processing",
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
    if task["status"] == "processing" and elapsed_time > 3.0:
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


if __name__ == '__main__':
    print("Сервер анализа сетей Петри запущен!")
    print("Адрес для ввода в клиенте: http://127.0.0.1:5000")
    app.run(host='0.0.0.0', port=5000, debug=True)
