import json
import time
import numpy as np
from numba import njit


def _norm_id(val: str) -> str:
    """Приводит идентификатор или имя позиции к каноническому виду для сопоставления."""
    return str(val).strip().lower().replace(" ", "_")


def _pretty_name(raw: str) -> str:
    """Формирует аккуратное отображаемое имя, если явный label не передан."""
    return str(raw).strip().replace("_", " ")


def _extract_arcs_map(arc_container) -> dict[str, int]:
    """
    Универсально извлекает словарь {norm_place_id: weight} из разных форматов:
    - dict: {"quiet_l": 1} или {"quiet l": {"weight": 1}}
    - list: [{"place": "quiet_l", "weight": 1}, ...] или [{"sourceId": "quiet_l", ...}]
    """
    res: dict[str, int] = {}
    if not arc_container:
        return res

    if isinstance(arc_container, dict):
        for k, v in arc_container.items():
            norm_k = _norm_id(k)
            if isinstance(v, dict):
                w = int(v.get("weight", v.get("tokens", 1)))
            else:
                w = int(v)
            res[norm_k] = res.get(norm_k, 0) + w

    elif isinstance(arc_container, list):
        for item in arc_container:
            if isinstance(item, str):
                norm_k = _norm_id(item)
                res[norm_k] = res.get(norm_k, 0) + 1
            elif isinstance(item, dict):
                raw_p = (
                    item.get("place")
                    or item.get("placeId")
                    or item.get("uuid")
                    or item.get("id")
                    or item.get("sourceId")
                    or item.get("targetId")
                    or item.get("name")
                )
                if raw_p is not None:
                    norm_k = _norm_id(raw_p)
                    w = int(item.get("weight", item.get("tokens", 1)))
                    res[norm_k] = res.get(norm_k, 0) + w
    return res


@njit
def _simulate_mc_numba(
    m0: np.ndarray,
    pre: np.ndarray,
    post: np.ndarray,
    runs: int,
    max_steps: int,
    seed: int
):
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
            for p in range(num_p):
                val = marking[p]
                p_sum[p] += val
                if val > p_max[p]:
                    p_max[p] = val

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

            if n_en == 0:
                deadlocks += 1
                total_steps += (step - 1)
                bucket = ((step - 1) * 10) // max_steps
                if bucket >= 10:
                    bucket = 9
                step_hist[bucket] += 1
                break

            chosen_t = enabled[np.random.randint(0, n_en)]
            t_firings[chosen_t] += 1

            for p in range(num_p):
                marking[p] = marking[p] - pre[chosen_t, p] + post[chosen_t, p]
        else:
            total_steps += max_steps

    return deadlocks, total_steps, t_firings, p_sum, p_max, step_hist


def _record_sample_trace(m0, pre, post, place_names, t_names, max_steps, seed, prefer_deadlock):
    rng = np.random.default_rng(seed)
    num_t, num_p = pre.shape
    attempts = 200 if prefer_deadlock else 1

    best_trace = []
    best_is_deadlock = False

    for _ in range(attempts):
        marking = m0.copy()
        m_str = ", ".join(f"{place_names[p]}: {marking[p]}" for p in range(num_p) if marking[p] > 0)
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
            m_str = ", ".join(f"{place_names[p]}: {marking[p]}" for p in range(num_p) if marking[p] > 0)
            en_names = [t_names[idx] for idx in enabled]
            trace.append(
                f"[Шаг {step:03d}] Сработал [{t_names[chosen]}] (доступны: {', '.join(en_names)}) -> M = {{{m_str or 'пусто'}}}"
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
    raw_transitions = payload.get("transitions", [])
    raw_init_marking = payload.get("initial_marking", {})
    raw_places_meta = payload.get("places", [])  # Если оркестратор или платформа передали метаданные позиций

    runs = int(payload.get("runs", 1000))
    max_steps = int(payload.get("max_steps", 500))
    seed = int(payload.get("seed", 42))
    record_trace = bool(payload.get("record_trace", False))

    # 1. Собираем словарь отображаемых имен для всех позиций (norm_id -> Display Name)
    display_names: dict[str, str] = {}

    if isinstance(raw_places_meta, list):
        for p_obj in raw_places_meta:
            if isinstance(p_obj, dict):
                uid = p_obj.get("uuid") or p_obj.get("id") or p_obj.get("name")
                lbl = p_obj.get("name") or uid
                if uid:
                    display_names[_norm_id(uid)] = str(lbl).strip()
    elif isinstance(raw_places_meta, dict):
        for k, v in raw_places_meta.items():
            lbl = v.get("name", k) if isinstance(v, dict) else str(v)
            display_names[_norm_id(k)] = str(lbl).strip()

    # 2. Нормализуем начальную разметку M0
    norm_m0: dict[str, int] = {}
    if isinstance(raw_init_marking, dict):
        for k, val in raw_init_marking.items():
            nk = _norm_id(k)
            tokens = int(val.get("tokens", val.get("initialTokens", 0))) if isinstance(val, dict) else int(val)
            norm_m0[nk] = norm_m0.get(nk, 0) + tokens
            if nk not in display_names:
                display_names[nk] = _pretty_name(k)

    # 3. Разбираем переходы и их дуги
    parsed_transitions = []
    for i, t in enumerate(raw_transitions):
        t_label = str(t.get("name") or t.get("uuid") or t.get("id") or f"T_{i+1}").strip()
        in_map = _extract_arcs_map(t.get("inputs") or t.get("in") or t.get("pre"))
        out_map = _extract_arcs_map(t.get("outputs") or t.get("out") or t.get("post"))

        for nk in in_map.keys():
            if nk not in display_names:
                display_names[nk] = _pretty_name(nk)
        for nk in out_map.keys():
            if nk not in display_names:
                display_names[nk] = _pretty_name(nk)

        parsed_transitions.append({
            "name": t_label,
            "sort_key": (t_label.lower(), str(t.get("uuid") or t.get("id") or i)),
            "inputs": in_map,
            "outputs": out_map,
        })

    # Сортируем для детерминированного порядка во всех воркерах
    parsed_transitions.sort(key=lambda item: item["sort_key"])
    all_norm_places = sorted(display_names.keys(), key=lambda nk: (display_names[nk].lower(), nk))

    p_idx = {nk: idx for idx, nk in enumerate(all_norm_places)}
    place_names = [display_names[nk] for nk in all_norm_places]
    t_names = [t["name"] for t in parsed_transitions]

    num_p = len(all_norm_places)
    num_t = len(parsed_transitions)

    m0 = np.zeros(num_p, dtype=np.int64)
    for nk, tokens in norm_m0.items():
        if nk in p_idx:
            m0[p_idx[nk]] = tokens

    pre = np.zeros((num_t, num_p), dtype=np.int64)
    post = np.zeros((num_t, num_p), dtype=np.int64)
    for t_i, t in enumerate(parsed_transitions):
        for nk, w in t["inputs"].items():
            pre[t_i, p_idx[nk]] = w
        for nk, w in t["outputs"].items():
            post[t_i, p_idx[nk]] = w

    t0 = time.perf_counter()
    deadlocks, total_steps, t_firings, p_sum, p_max, step_hist = _simulate_mc_numba(
        m0, pre, post, runs, max_steps, seed
    )
    compute_ms = (time.perf_counter() - t0) * 1000.0

    trace, trace_is_deadlock = [], False
    if record_trace:
        trace, trace_is_deadlock = _record_sample_trace(
            m0, pre, post, place_names, t_names, max_steps, seed + 1, prefer_deadlock=(deadlocks > 0)
        )

    return json.dumps({
        "places": place_names,
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
    }, ensure_ascii=False)

