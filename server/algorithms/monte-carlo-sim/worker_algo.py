import json
import numpy as np
from numba import njit
import time


@njit
def _simulate_mc_numba(
    m0: np.ndarray,
    pre: np.ndarray,
    post: np.ndarray,
    runs: int,
    max_steps: int,
    seed: int
):
    """
    Высокоскоростное Numba-ядро стохастической симуляции сети Петри.
    На каждом шаге равновероятно выбирается один из разрешенных переходов.
    """
    np.random.seed(seed)
    num_t, num_p = pre.shape

    deadlocks = 0
    total_steps = 0
    t_firings = np.zeros(num_t, dtype=np.int64)
    p_sum = np.zeros(num_p, dtype=np.int64)
    p_max = m0.copy()
    step_hist = np.zeros(10, dtype=np.int64)

    marking = np.empty(num_p, dtype=np.int64)
    enabled = np.empty(num_t, dtype=np.int64)

    for _ in range(runs):
        for p in range(num_p):
            marking[p] = m0[p]

        for step in range(1, max_steps + 1):
            # Учет плотности фишек
            for p in range(num_p):
                val = marking[p]
                p_sum[p] += val
                if val > p_max[p]:
                    p_max[p] = val

            # Поиск всех разрешенных (enabled) переходов
            n_en = 0
            for t in range(num_t):
                can_fire = True
                for p in range(num_p):
                    if marking[p] < pre[t, p]:
                        can_fire = False
                        break
                if can_fire:
                    enabled[n_en] = t
                    n_en += 1

            # Если нет активных переходов — зафиксирован тупик (deadlock)
            if n_en == 0:
                deadlocks += 1
                total_steps += (step - 1)
                bucket = ((step - 1) * 10) // max_steps
                if bucket >= 10:
                    bucket = 9
                step_hist[bucket] += 1
                break

            # Случайный выбор перехода из разрешенных
            chosen_t = enabled[np.random.randint(0, n_en)]
            t_firings[chosen_t] += 1

            # Обновление разметки M' = M - pre[t] + post[t]
            for p in range(num_p):
                marking[p] = marking[p] - pre[chosen_t, p] + post[chosen_t, p]
        else:
            total_steps += max_steps

    return deadlocks, total_steps, t_firings, p_sum, p_max, step_hist


def _record_sample_trace(m0, pre, post, places, t_names, max_steps, seed, prefer_deadlock):
    """Формирует текстовый лог одного прогона (если был тупик — ищет пример с тупиком)."""
    rng = np.random.default_rng(seed)
    num_t, num_p = pre.shape
    attempts = 200 if prefer_deadlock else 1

    best_trace = []
    best_is_deadlock = False

    for _ in range(attempts):
        marking = m0.copy()
        m_str = ", ".join(f"{places[p]}:{marking[p]}" for p in range(num_p) if marking[p] > 0)
        trace = [f"[Шаг 000] Начальная разметка M0 = {{{m_str or 'пусто'}}}"]
        is_deadlock = False

        for step in range(1, min(max_steps, 300) + 1):
            enabled = [t for t in range(num_t) if np.all(marking >= pre[t])]
            if not enabled:
                trace.append(f"[Шаг {step:03d}] >>> ТУПИК (DEADLOCK): нет активных переходов! <<<")
                is_deadlock = True
                break

            chosen = int(rng.choice(enabled))
            marking = marking - pre[chosen] + post[chosen]
            m_str = ", ".join(f"{places[p]}:{marking[p]}" for p in range(num_p) if marking[p] > 0)
            en_names = [t_names[idx] for idx in enabled]
            trace.append(
                f"[Шаг {step:03d}] Сработал {t_names[chosen]} (доступны: {en_names}) -> M = {{{m_str or 'пусто'}}}"
            )
        else:
            trace.append(f"[Шаг {min(max_steps, 300):03d}] Остановка по лимиту шагов (тупик не достигнут).")

        best_trace = trace
        best_is_deadlock = is_deadlock
        if not prefer_deadlock or is_deadlock:
            break

    return best_trace, best_is_deadlock


def run_chunk(raw_data: str) -> str:
    payload = json.loads(raw_data)
    transitions = sorted(payload.get("transitions", []), key=lambda t: t.get("name", ""))
    init_marking = payload.get("initial_marking", {})
    runs = int(payload.get("runs", 1000))
    max_steps = int(payload.get("max_steps", 500))
    seed = int(payload.get("seed", 42))
    record_trace = bool(payload.get("record_trace", False))

    place_set = set(init_marking.keys())
    for t in transitions:
        place_set.update(t.get("inputs", {}).keys())
        place_set.update(t.get("outputs", {}).keys())

    places = sorted(place_set)
    p_idx = {p: i for i, p in enumerate(places)}
    t_names = [t.get("name", f"T_{i}") for i, t in enumerate(transitions)]

    num_p = len(places)
    num_t = len(transitions)

    m0 = np.zeros(num_p, dtype=np.int64)
    for p, tokens in init_marking.items():
        m0[p_idx[p]] = int(tokens)

    pre = np.zeros((num_t, num_p), dtype=np.int64)
    post = np.zeros((num_t, num_p), dtype=np.int64)
    for t_i, t in enumerate(transitions):
        for p, w in t.get("inputs", {}).items():
            pre[t_i, p_idx[p]] = int(w)
        for p, w in t.get("outputs", {}).items():
            post[t_i, p_idx[p]] = int(w)

    t0 = time.perf_counter()
    deadlocks, total_steps, t_firings, p_sum, p_max, step_hist = _simulate_mc_numba(
        m0, pre, post, runs, max_steps, seed
    )
    compute_ms = (time.perf_counter() - t0) * 1000.0

    trace, trace_is_deadlock = [], False
    if record_trace:
        trace, trace_is_deadlock = _record_sample_trace(
            m0, pre, post, places, t_names, max_steps, seed + 1, prefer_deadlock=(deadlocks > 0)
        )

    return json.dumps({
        "places": places,
        "t_names": t_names,
        "runs": runs,
        "deadlocks": int(deadlocks),
        "total_steps": int(total_steps),
        "t_firings": t_firings.tolist(),
        "p_sum": p_sum.tolist(),
        "p_max": p_max.tolist(),
        "step_hist": step_hist.tolist(),
        "trace": trace,
        "trace_is_deadlock": trace_is_deadlock,
        "compute_ms": round(compute_ms, 2)
    })
