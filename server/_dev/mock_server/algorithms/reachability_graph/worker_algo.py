import json
import numpy as np
from numba import njit

# Numba работает только с числовыми массивами NumPy и примитивами
@njit
def compute_reachability(marking_arr, transitions_count, max_depth):
    # Имитация тяжелых матричных вычислений на C-скорости
    states_explored = len(marking_arr) * 16 + transitions_count * 8
    deadlock = False
    for i in range(len(marking_arr)):
        if marking_arr[i] < 0:
            deadlock = True
    return states_explored, deadlock

def solve(data):
    marking = data.get("marking", {})
    transitions = data.get("transitions", [])
    branch = data.get("start_transition") or "root"
    max_depth = int(data.get("max_depth", 100))

    # Конвертируем словарь разметки в одномерный массив NumPy перед передачей в @njit
    marking_arr = np.array(list(marking.values()), dtype=np.int64)
    
    # Вызываем скомпилированное ядро
    states_explored, deadlock = compute_reachability(marking_arr, len(transitions), max_depth)

    return {
        "branch": branch,
        "states": int(states_explored),
        "deadlock_found": bool(deadlock)
    }

if __name__ == "__main__":
    payload = json.loads(CHUNK_DATA_JSON)
    result = solve(payload)
    print(json.dumps(result))
