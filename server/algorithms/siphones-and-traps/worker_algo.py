import json
import numpy as np
from numba import njit


@njit
def _reduce_to_siphon_numba(mask: np.uint64, pre_p: np.ndarray, post_p: np.ndarray) -> np.uint64:
    """Сужает множество позиций mask до наибольшего корректного подсифона (•S ⊆ S•)."""
    S = mask
    num_p = len(pre_p)
    one = np.uint64(1)
    zero = np.uint64(0)

    while S != zero:
        pre_S = zero
        post_S = zero
        for i in range(num_p):
            if (S & (one << np.uint64(i))) != zero:
                pre_S |= pre_p[i]
                post_S |= post_p[i]

        bad = pre_S & ~post_S
        if bad == zero:
            return S

        for i in range(num_p):
            bit = one << np.uint64(i)
            if ((S & bit) != zero) and ((pre_p[i] & bad) != zero):
                S &= ~bit

    return zero


@njit
def _find_minimal_siphons_numba(num_p: int, pre_p: np.ndarray, post_p: np.ndarray, max_results: int = 16384) -> np.ndarray:
    """
    Итеративный поиск всех минимальных сифонов методом ветвей и границ на битовых масках uint64.
    (Для ловушек на вход подаются swapped массивы: post_p, pre_p).
    """
    one = np.uint64(1)
    zero = np.uint64(0)

    if num_p == 0:
        return np.empty(0, dtype=np.uint64)

    full_mask = np.uint64(0)
    for i in range(num_p):
        full_mask |= (one << np.uint64(i))

    # Явный стек для DFS (исключает рекурсию в Numba)
    stack_cap = 4096
    stack_S = np.empty(stack_cap, dtype=np.uint64)
    stack_fixed = np.empty(stack_cap, dtype=np.uint64)
    sp = 0

    stack_S[sp] = full_mask
    stack_fixed[sp] = zero
    sp += 1

    results = np.empty(max_results, dtype=np.uint64)
    n_res = 0

    while sp > 0:
        sp -= 1
        S = stack_S[sp]
        fixed = stack_fixed[sp]

        S = _reduce_to_siphon_numba(S, pre_p, post_p)
        if S == zero or (fixed & S) != fixed:
            continue

        # Проверяем минимальность S
        pivot = zero
        non_minimal = False
        for i in range(num_p):
            bit = one << np.uint64(i)
            if (S & bit) != zero:
                if _reduce_to_siphon_numba(S ^ bit, pre_p, post_p) != zero:
                    if (fixed & bit) == zero:
                        pivot = bit
                        break
                    else:
                        non_minimal = True
                        break

        if non_minimal:
            continue

        if pivot == zero:
            # S минимален: проверяем, нет ли уже найденного подмножества
            already_covered = False
            for r_i in range(n_res):
                if (results[r_i] & S) == results[r_i]:
                    already_covered = True
                    break
            if not already_covered and n_res < max_results:
                results[n_res] = S
                n_res += 1
            continue

        # Расширяем стек при необходимости
        if sp + 2 >= stack_cap:
            new_cap = stack_cap * 2
            new_S = np.empty(new_cap, dtype=np.uint64)
            new_F = np.empty(new_cap, dtype=np.uint64)
            for k in range(sp):
                new_S[k] = stack_S[k]
                new_F[k] = stack_fixed[k]
            stack_S = new_S
            stack_fixed = new_F
            stack_cap = new_cap

        # Правая ветвь: фиксируем pivot
        stack_S[sp] = S
        stack_fixed[sp] = fixed | pivot
        sp += 1

        # Левая ветвь: исключаем pivot
        stack_S[sp] = S ^ pivot
        stack_fixed[sp] = fixed
        sp += 1

    return results[:n_res]


def run_chunk(raw_data: str) -> str:
    payload = json.loads(raw_data)
    mode = payload.get("mode", "siphons")
    transitions = payload.get("transitions", [])

    places = sorted({
        p for t in transitions
        for p in list(t.get("inputs", {}).keys()) + list(t.get("outputs", {}).keys())
    })
    p_idx = {p: i for i, p in enumerate(places)}
    num_p = len(places)

    if num_p > 64 or len(transitions) > 64:
        return json.dumps({
            "error": "Битовая Numba-реализация поддерживает до 64 позиций и 64 переходов."
        })

    pre_p = np.zeros(num_p, dtype=np.uint64)
    post_p = np.zeros(num_p, dtype=np.uint64)

    for t_i, t in enumerate(transitions):
        t_bit = np.uint64(1) << np.uint64(t_i)
        for p, w in t.get("inputs", {}).items():
            if int(w) > 0:
                post_p[p_idx[p]] |= t_bit
        for p, w in t.get("outputs", {}).items():
            if int(w) > 0:
                pre_p[p_idx[p]] |= t_bit

    # Ловушка — это сифон в сети с обращенными дугами
    if mode == "traps":
        pre_p, post_p = post_p, pre_p

    masks = _find_minimal_siphons_numba(num_p, pre_p, post_p)

    subsets = []
    for m in masks:
        val = int(m)
        subsets.append([places[i] for i in range(num_p) if val & (1 << i)])

    subsets.sort(key=lambda s: (len(s), s))
    return json.dumps({"mode": mode, "subsets": subsets})

