import json
import numpy as np
from numba import njit


@njit
def _gcd(a: int, b: int) -> int:
    a = abs(a)
    b = abs(b)
    while b != 0:
        a, b = b, a % b
    return a


@njit
def _solve_invariants_numba(A: np.ndarray, max_rows: int = 65536) -> np.ndarray:
    """
    Скомпилированный поиск базиса минимальных неотрицательных решений x^T * A = 0.
    Для T-инвариантов передается транспонированная матрица C^T размером [|T|, |P|].
    """
    num_vars, num_eqs = A.shape
    if num_vars == 0:
        return np.empty((0, 0), dtype=np.int64)

    total_cols = num_eqs + num_vars
    rows = np.zeros((num_vars, total_cols), dtype=np.int64)
    for i in range(num_vars):
        for j in range(num_eqs):
            rows[i, j] = A[i, j]
        rows[i, num_eqs + i] = 1

    n_rows = num_vars

    for col in range(num_eqs):
        zero_idx = np.empty(n_rows, dtype=np.int64)
        pos_idx = np.empty(n_rows, dtype=np.int64)
        neg_idx = np.empty(n_rows, dtype=np.int64)
        n_z, n_p, n_n = 0, 0, 0

        for r in range(n_rows):
            val = rows[r, col]
            if val == 0:
                zero_idx[n_z] = r
                n_z += 1
            elif val > 0:
                pos_idx[n_p] = r
                n_p += 1
            else:
                neg_idx[n_n] = r
                n_n += 1

        cand_cap = n_z + n_p * n_n
        if cand_cap == 0:
            return np.empty((0, num_vars), dtype=np.int64)
        if cand_cap > max_rows:
            cand_cap = max_rows

        cands = np.zeros((cand_cap, total_cols), dtype=np.int64)
        supp_sizes = np.zeros(cand_cap, dtype=np.int64)
        n_cand = 0

        for i in range(n_z):
            r = zero_idx[i]
            sz = 0
            for k in range(total_cols):
                v = rows[r, k]
                cands[n_cand, k] = v
                if k >= num_eqs and v > 0:
                    sz += 1
            supp_sizes[n_cand] = sz
            n_cand += 1

        for i in range(n_p):
            rp = pos_idx[i]
            vp = rows[rp, col]
            for j in range(n_n):
                if n_cand >= cand_cap:
                    break
                rn = neg_idx[j]
                vn = -rows[rn, col]
                g = _gcd(vp, vn)
                mp = vn // g
                mn = vp // g

                row_gcd = 0
                sz = 0
                for k in range(total_cols):
                    val = mp * rows[rp, k] + mn * rows[rn, k]
                    cands[n_cand, k] = val
                    if val != 0:
                        row_gcd = _gcd(row_gcd, val)
                    if k >= num_eqs and val > 0:
                        sz += 1

                if row_gcd > 1:
                    for k in range(total_cols):
                        cands[n_cand, k] //= row_gcd

                supp_sizes[n_cand] = sz
                n_cand += 1

        order = np.argsort(supp_sizes[:n_cand])
        kept = np.zeros((n_cand, total_cols), dtype=np.int64)
        n_kept = 0

        for idx_pos in range(n_cand):
            r = order[idx_pos]
            is_dominated = False
            for k_idx in range(n_kept):
                subset = True
                for v_i in range(num_eqs, total_cols):
                    if kept[k_idx, v_i] > 0 and cands[r, v_i] == 0:
                        subset = False
                        break
                if subset:
                    is_dominated = True
                    break

            if not is_dominated:
                for k in range(total_cols):
                    kept[n_kept, k] = cands[r, k]
                n_kept += 1

        rows = kept[:n_kept]
        n_rows = n_kept

    return rows[:, num_eqs:]


def run_chunk(raw_data: str) -> str:
    payload = json.loads(raw_data)
    transitions = sorted(payload.get("transitions", []), key=lambda t: t.get("name", ""))
    t_names = [t.get("name", f"T_{i}") for i, t in enumerate(transitions)]

    places = sorted({
        p for t in transitions
        for p in list(t.get("inputs", {}).keys()) + list(t.get("outputs", {}).keys())
    })
    p_idx = {p: i for i, p in enumerate(places)}

    num_t = len(transitions)
    num_p = len(places)
    C_T = np.zeros((num_t, num_p), dtype=np.int64)

    for t_i, t in enumerate(transitions):
        for p, w in t.get("inputs", {}).items():
            C_T[t_i, p_idx[p]] -= int(w)
        for p, w in t.get("outputs", {}).items():
            C_T[t_i, p_idx[p]] += int(w)

    inv_matrix = _solve_invariants_numba(C_T)
    invariants = sorted(inv_matrix.tolist())

    covered = {i for inv in invariants for i, v in enumerate(inv) if v > 0}
    uncovered = [t_names[i] for i in range(num_t) if i not in covered]

    return json.dumps({
        "transitions": t_names,
        "invariants": invariants,
        "uncovered_transitions": uncovered
    })

