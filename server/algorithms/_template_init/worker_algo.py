import json
import numpy as np
from numba import njit


@njit(fastmath=True)
def _compute_kernel(seed: int, iterations: int, multiplier: int) -> int:
    """Скомпилированное математическое ядро (поддерживает только числа и массивы NumPy)."""
    acc = seed
    for i in range(1, iterations + 1):
        acc += i * multiplier
    return acc


def run_chunk(raw_data: str) -> str:
    """
    Обязательная точка входа для раннера воркера.
    Принимает строку (JSON из поля data чанка) и возвращает строку в stdout.
    """
    payload = json.loads(raw_data)

    seed = int(payload.get("seed", 0))
    iterations = int(payload.get("iterations", 1))
    multiplier = int(payload.get("multiplier", 1))

    # Подготовка данных для Numba и вызов расчета
    arr = np.array([seed, iterations, multiplier], dtype=np.int64)
    computed_value = _compute_kernel(int(arr[0]), int(arr[1]), int(arr[2]))

    result = {
        "value": int(computed_value)
    }

    # ВАЖНО ДЛЯ BFT: sort_keys=True и separators=(",", ":") гарантируют,
    # что два разных воркера выдадут идентичную байтовую строку для одного результата.
    return json.dumps(result, sort_keys=True, separators=(",", ":"))
