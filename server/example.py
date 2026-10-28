from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app) # Разрешаем кросс-доменные запросы от фронтенда

ANALYSIS_TYPES = [
    {"id": "some_1", "name": "Анализ достижимости (Reachability)"},
    {"id": "some_2", "name": "Поиск тупиков (Deadlock Detection)"},
    {"id": "some_3", "name": "Расчет Т-инвариантов (T-Invariants)"},
    {"id": "some_4", "name": "Расчет Р-инвариантов (P-Invariants)"},
    {"id": "some_5", "name": "Анализ ограниченности (Boundedness)"},
    {"id": "some_6", "name": "Анализ живости (Liveness Analysis)"}
]

# Схемы параметров для каждого вида анализа
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
        {"id": "description",
         "name": "Это описание работы данного вида анализа",
         "type": "description"},
        {"id": "liveness_level", "name": "Интересующий уровень живости (0-4)", "type": "number"},
        {
            "id": "fairness_constraints", 
            "name": "Условия справедливости (Fairness)", 
            "type": "list",
            "options": [
                {"name": "Слабая справедливость (Weak)", "value": "weak"},
                {"name": "Сильная справедливость (Strong)", "value": "strong"}
            ]
        }
    ]
}

@app.route('/api/v1/get_types', methods=['GET'])
def get_types():
    return jsonify(ANALYSIS_TYPES)

@app.route('/api/v1/get_schema', methods=['GET'])
def get_schema():
    # Получаем id из параметров запроса, например: /api/v1/get_schema?id=some_1
    analysis_id = request.args.get('id')
    
    # Ищем схему для данного ID, если не нашли — возвращаем пустой список
    schema = ANALYSIS_SCHEMAS.get(analysis_id, [])
    return jsonify(schema)

if __name__ == '__main__':
    print("Сервер анализа сетей Петри запущен!")
    print("Адрес для ввода в клиенте: http://127.0.0.1:5000")
    app.run(host='127.0.0.1', port=5000, debug=True)
