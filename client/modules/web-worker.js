/**
 * @file web_worker.js
 * @brief Браузерный вычислительный узел (PyJS + Numba WASM) для помощи кластеру.
 */

import {getAnalysisSession, getDispatcherView} from './state.js';

const workerState = {
    status: 'stopped',  // 'stopped' | 'loading' | 'running' | 'error'
    workerId: null,
    slots: Math.min(4, navigator.hardwareConcurrency || 2),
    completedChunks: 0,
    errorMessage: '',
    masterUrl: '',
    wasmCdnUrl: '',
    pool: [],
    hbIntervalMs: 3000,
    blobUrl: null
};

export function getWebWorkerState() {
    return workerState;
}

export function setWebWorkerSlots(val) {
    const n = parseInt(val, 10);
    if (!isNaN(n) && n >= 1 && n <= 16) {
        workerState.slots = n;
    }
}

/**
 * @brief Генерирует Blob URL с кодом фонового Web Worker (PyJS + Numba).
 */
function buildWorkerBlobUrl(cdnUrl) {
    const pySetup = [
        'import os, sys, io, json, time, traceback, types, numba',
        'from numba import njit',
        '@njit(fastmath=True)',
        'def _k(n):',
        '    a = 0.0',
        '    for i in range(1, n): a += (i * 0.5) / (i % 7 + 1.0) - (a * 1e-9)',
        '    return a',
        'def _bench():',
        '    _k(10); t = time.time(); _k(20_000_000)',
        '    return int(40 / max(time.time() - t, 0.001))',
        'def _run(code, raw):',
        '    old, buf = sys.stdout, io.StringIO()',
        '    sys.stdout = buf',
        '    try:',
        '        mod = types.ModuleType("m")',
        '        exec(code, mod.__dict__)',
        '        res = mod.run_chunk(raw)',
        '        if res is not None: print(res)',
        '        return json.dumps({"status": "ok", "output": buf.getvalue().strip()})',
        '    except Exception:',
        '        tb = traceback.format_exc()',
        '        et = "SyntaxError" if "SyntaxError" in tb else ("FatalAlgorithmError" if any(e in tb for e in ("NameError","TypeError","ValueError","RuntimeError")) else "SANDBOX_CRASH")',
        '        return json.dumps({"status": "error", "errorType": et, "errorMessage": tb[-300:]})',
        '    finally:',
        '        sys.stdout = old'
    ].join('\n');

    const workerCode = `
      importScripts('${cdnUrl}/pyjs_runtime_browser.js');
      let pyjs;
      self.onmessage = async ({ data: m }) => {
        if (m.type === 'init') {
          try {
            pyjs = await createModule({ locateFile: p => '${cdnUrl}/' + p });
            await pyjs.bootstrap_from_empack_packed_environment('${
        cdnUrl}/empack_env_meta.json', '${cdnUrl}', false);
            pyjs.exec('import os, numba');
            const sos = pyjs.eval('[os.path.join(r,f) for r,_,fs in os.walk(os.path.dirname(numba.__file__)) for f in fs if f.endswith(".so")]');
            for (const so of sos) {
              await pyjs.loadDynamicLibrary(so, { loadAsync: true, global: true, nodelete: true });
            }
            pyjs.exec(${JSON.stringify(pySetup)});
            self.postMessage({ type: 'ready', score: pyjs.eval('_bench()') });
          } catch (err) {
            self.postMessage({ type: 'init_error', error: String(err) });
          }
        } else if (m.type === 'run') {
          const t0 = performance.now();
          try {
            const expr = '_run(' + JSON.stringify(m.script) + ', ' + JSON.stringify(m.data) + ')';
            const res = JSON.parse(pyjs.eval(expr));
            const heapMb = pyjs.HEAP8 ? Math.round(pyjs.HEAP8.length / 1048576) : 256;
            self.postMessage({ type: 'res', id: m.id, ms: Math.round(performance.now() - t0), heapMb, ...res });
          } catch (e) {
            self.postMessage({ type: 'res', id: m.id, status: 'error', errorType: 'OOM_OR_TIMEOUT', errorMessage: String(e) });
          }
        }
      };
    `;
    return URL.createObjectURL(new Blob([workerCode], {type: 'application/javascript'}));
}

async function apiPost(path, payload) {
    const resp = await fetch(`${workerState.masterUrl}${path}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
}

function spawnSlot(idx) {
    return new Promise((resolve, reject) => {
        const w = new Worker(workerState.blobUrl);
        const slot = {idx, w, busy: false, cid: null, tm: null};
        w.onmessage = ({data: m}) => {
            if (m.type === 'ready')
                resolve({slot, score: m.score});
            else if (m.type === 'init_error') {
                w.terminate();
                reject(new Error(m.error));
            }
        };
        w.onerror = (err) => {
            w.terminate();
            reject(new Error(err.message || 'Ошибка загрузки скрипта воркера'));
        };
        w.postMessage({type: 'init'});
    });
}

async function respawnSlot(s) {
    try {
        s.w.terminate();
    } catch (_) {
    }
    if (workerState.status !== 'running') return;
    s.busy = true;
    s.cid = null;
    try {
        const fresh = await spawnSlot(s.idx);
        s.w = fresh.slot.w;
        s.busy = false;
    } catch (_) {
        s.busy = false;
    }
}

function notifyUi() {
    if (getDispatcherView().isDispatcherMode && typeof window.refreshClusterStatus === 'function') {
        window.refreshClusterStatus();
    }
}

/**
 * @brief Запускает браузерный воркер и подключает его к текущему серверу.
 */
export async function startBrowserWorker() {
    if (workerState.status === 'loading' || workerState.status === 'running') return;

    const rawUrl = getAnalysisSession().defaultServer || '';
    const serverUrl = rawUrl.trim().replace(/\/+$/, '');
    if (!serverUrl) {
        workerState.status = 'error';
        workerState.errorMessage = 'Не задан адрес сервера';
        notifyUi();
        return;
    }

    workerState.status = 'loading';
    workerState.errorMessage = '';
    workerState.completedChunks = 0;
    workerState.masterUrl = serverUrl;
    // Подключаемся к подпути /jit/ текущего defaultServer
    workerState.wasmCdnUrl = `${serverUrl}/jit`;
    notifyUi();

    try {
        if (workerState.blobUrl) URL.revokeObjectURL(workerState.blobUrl);
        workerState.blobUrl = buildWorkerBlobUrl(workerState.wasmCdnUrl);

        const n = workerState.slots;
        const inits = await Promise.all(Array.from({length: n}, (_, i) => spawnSlot(i)));
        if (workerState.status !== 'loading') {
            inits.forEach(x => x.slot.w.terminate());
            return;
        }

        workerState.pool = inits.map(x => x.slot);
        const totalScore = (inits.score || 500) * n;
        const ramMb = (navigator.deviceMemory || 4) * 1024;

        const reg = await apiPost('/worker/register', {
            arch: 'wasm32',
            os: 'browser',
            cpu_cores: n,
            ram_mb: ramMb,
            benchmark_score: totalScore
        });

        workerState.workerId = reg.workerId;
        workerState.hbIntervalMs = reg.heartbeatIntervalMs || 3000;
        workerState.status = 'running';
        notifyUi();

        runHeartbeatLoop(n, ramMb, totalScore);
        runPullLoop(ramMb);
    } catch (err) {
        console.error('[WebWorker] Ошибка старта:', err);
        workerState.status = 'error';
        workerState.errorMessage = err.message || 'Сбой инициализации WASM';
        workerState.pool.forEach(s => {
            try {
                s.w.terminate();
            } catch (_) {
            }
        });
        workerState.pool = [];
        notifyUi();
    }
}

async function runHeartbeatLoop(n, ramMb, totalScore) {
    while (workerState.status === 'running' && workerState.workerId) {
        await new Promise(r => setTimeout(r, workerState.hbIntervalMs));
        if (workerState.status !== 'running') break;

        const active = workerState.pool.filter(s => s.cid).map(s => s.cid);
        try {
            const hb = await apiPost('/worker/heartbeat', {
                workerId: workerState.workerId,
                activeChunkIds: active,
                cpuLoadPercent: Math.round((active.length / n) * 1000) / 10
            });
            if (hb.workerCommand === 'ban') {
                await stopBrowserWorker('Узел заблокирован сервером (BFT)');
                return;
            }
            for (const cid of (hb.abortChunkIds || [])) {
                const s = workerState.pool.find(x => x.cid === cid);
                if (s) {
                    clearTimeout(s.tm);
                    await respawnSlot(s);
                }
            }
        } catch (_) {
            // Попытка перерегистрации при временном отвале мастера
            try {
                const reg = await apiPost('/worker/register', {
                    arch: 'wasm32',
                    os: 'browser',
                    cpu_cores: n,
                    ram_mb: ramMb,
                    benchmark_score: totalScore
                });
                workerState.workerId = reg.workerId;
            } catch (__) {
            }
        }
    }
}

async function runPullLoop(ramMb) {
    while (workerState.status === 'running') {
        const free = workerState.pool.filter(s => !s.busy);
        if (free.length > 0 && workerState.workerId) {
            try {
                const {chunks = [], retryAfterMs = 2000} = await apiPost('/worker/pull', {
                    workerId: workerState.workerId,
                    freeSlots: free.length,
                    availableRamMb: ramMb
                });

                chunks.forEach((ch, i) => {
                    const s = free[i];
                    if (!s) return;
                    s.busy = true;
                    s.cid = ch.chunkId;
                    const limitMs = ch.maxExecutionMs || 15000;
                    const limitRam = ch.maxRamMb || 1024;

                    s.tm = setTimeout(async () => {
                        await apiPost('/worker/submit', {
                            workerId: workerState.workerId,
                            chunkId: ch.chunkId,
                            status: 'error',
                            errorType: 'OOM_OR_TIMEOUT',
                            errorMessage: 'Browser timeout'
                        }).catch(() => {});
                        await respawnSlot(s);
                    }, limitMs);
                    s.w.onmessage = async ({data: r}) => {
                        if (r.type !== 'res' || r.id !== ch.chunkId) return;
                        clearTimeout(s.tm);
                        if (r.heapMb > limitRam) {
                            await apiPost('/worker/submit', {
                                workerId: workerState.workerId,
                                chunkId: ch.chunkId,
                                status: 'error',
                                errorType: 'OOM_OR_TIMEOUT',
                                errorMessage: 'WASM OOM'
                            }).catch(() => {});
                            await respawnSlot(s);
                            return;
                        }
                        await apiPost(
                            '/worker/submit',
                            r.status === 'ok' ? {
                                workerId: workerState.workerId,
                                chunkId: ch.chunkId,
                                status: 'ok',
                                executionTimeMs: r.ms,
                                output: r.output
                            } :
                                                {
                                                    workerId: workerState.workerId,
                                                    chunkId: ch.chunkId,
                                                    status: 'error',
                                                    errorType: r.errorType,
                                                    errorMessage: r.errorMessage
                                                })
                            .catch(() => {});
                        workerState.completedChunks++;
                        s.busy = false;
                        s.cid = null;
                        notifyUi();
                    };
                    s.w.postMessage({
                        type: 'run',
                        id: ch.chunkId,
                        script: ch.script,
                        data: typeof ch.data === 'string' ? ch.data : JSON.stringify(ch.data ?? {})
                    });
                });
                await new Promise(r => setTimeout(r, retryAfterMs));
            } catch (_) {
                await new Promise(r => setTimeout(r, 2000));
            }
        } else {
            await new Promise(r => setTimeout(r, 300));
        }
    }
}
/**
 * @brief Штатно останавливает воркер, убивает потоки и уведомляет мастер.
 */
export async function stopBrowserWorker(errMsg = '') {
    const prevId = workerState.workerId;
    const prevUrl = workerState.masterUrl;
    workerState.status = errMsg ? 'error' : 'stopped';
    workerState.errorMessage = errMsg;
    workerState.workerId = null;
    workerState.pool.forEach(s => {
        clearTimeout(s.tm);
        try {
            s.w.terminate();
        } catch (_) {
        }
    });
    workerState.pool = [];
    notifyUi();
    if (prevId && prevUrl) {
        try {
            await fetch(`${prevUrl}/worker/unregister`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({workerId: prevId})
            });
        } catch (_) {
        }
    }
}
// Автоматическое отключение при закрытии вкладки браузера
window.addEventListener('beforeunload', () => {
    if (workerState.workerId && workerState.masterUrl) {
        fetch(`${workerState.masterUrl}/worker/unregister`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({workerId: workerState.workerId}),
            keepalive: true
        });
    }
});