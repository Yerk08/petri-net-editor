/**
 * @file web_worker.js
 * @brief Браузерный вычислительный узел (PyJS + Numba WASM) для помощи кластеру.
 */

let uiUpdateCallback = null;
let defaultServerProvider = () => '';

/**
 * @brief Регистрирует внешние обработчики UI и провайдер адреса сервера (для интеграции с
 * редактором).
 */
export function configureWebWorker({onUiUpdate, getServerUrl} = {}) {
    if (onUiUpdate) uiUpdateCallback = onUiUpdate;
    if (getServerUrl) defaultServerProvider = getServerUrl;
}

function notifyUi() {
    if (typeof uiUpdateCallback === 'function') {
        uiUpdateCallback();
    }
}

/// Фоновый запуск воркера даже при свернутой вкладке
const BG_MODE_STORAGE_KEY = 'petri_ww_background_mode';

const workerState = {
    status: 'stopped',  // 'stopped' | 'loading' | 'running' | 'error'
    workerId: null,
    slots: Math.min(4, navigator.hardwareConcurrency || 2),
    backgroundMode: localStorage?.getItem(BG_MODE_STORAGE_KEY) === '1',
    completedChunks: 0,
    errorMessage: '',
    masterUrl: '',
    wasmCdnUrl: '',
    pool: [],
    hbIntervalMs: 2000,
    blobUrl: null,
    wasmModule: null
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
        'import os',
        'os.environ.setdefault("NUMBA_CPU_FEATURES", "+simd128,+nontrapping-fptoint,+bulk-memory,+sign-ext")',
        'import sys, io, json, time, traceback, types, numba',
        'import numpy as np',
        'from numba import njit',
        '@njit(fastmath=True)',
        'def _k(arr, value):',
        '    count = 0.0',
        '    for i in arr:',
        '        for j in arr:',
        '            for k in arr:',
        '                count += (i * j * k) / value',
        '    return count',
        'def _bench():',
        '    data = np.random.RandomState(42).randint(1, 101, size=400).astype(np.int32)',
        '    t0 = time.perf_counter()',
        '    _k(data, 1.0)',
        '    t1 = time.perf_counter()',
        '    _k(data, 16.0)',
        '    t2 = time.perf_counter()',
        '    run_s = max(t2 - t1, 0.001)',
        '    comp_s = max((t1 - t0) - run_s, 0.001)',
        '    return int(100.0 / (run_s + 0.07 * comp_s))',
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
            pyjs = await createModule({
              locateFile: p => '${cdnUrl}/' + p,
              ...(m.wasmModule ? { wasmModule: m.wasmModule } : {})
            });
            await pyjs.bootstrap_from_empack_packed_environment('${
        cdnUrl}/empack_env_meta.json', '${cdnUrl}', false);
            pyjs.exec('import os; os.environ["NUMBA_CPU_FEATURES"] = "+simd128,+nontrapping-fptoint,+bulk-memory,+sign-ext"');
            pyjs.exec('import numba');
            const sos = pyjs.eval('[os.path.join(r,f) for r,_,fs in os.walk(os.path.dirname(numba.__file__)) for f in fs if f.endswith(".so")]');
            for (const so of sos) {
              await pyjs.loadDynamicLibrary(so, { loadAsync: true, global: true, nodelete: true });
            }
            pyjs.exec(${JSON.stringify(pySetup)});
            // Запускаем бенчмарк ТОЛЬКО если передан флаг runBench (для нулевого слота)
            const score = m.runBench ? pyjs.eval('_bench()') : 0;
            self.postMessage({ type: 'ready', score });
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

let cachedBlobKey = '';
let cachedBlobUrl = null;

function getWorkerBlobUrl(cdnUrl) {
    if (cachedBlobUrl && cachedBlobKey === cdnUrl) {
        return cachedBlobUrl;
    }
    if (cachedBlobUrl) URL.revokeObjectURL(cachedBlobUrl);
    cachedBlobKey = cdnUrl;
    cachedBlobUrl = buildWorkerBlobUrl(cdnUrl);
    return cachedBlobUrl;
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
        // Передаем runBench: true только для первого слота (idx === 0)
        w.postMessage({type: 'init', runBench: idx === 0, wasmModule: workerState.wasmModule});
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






const keepAlive = {
    wakeLock: null,
    audioEl: null,
    releaseLock: null
};

async function enableBackgroundKeepAlive() {
    // 1. Web Lock: запрещает Chromium замораживать или выгружать вкладку
    if (navigator.locks && !keepAlive.releaseLock) {
        navigator.locks
            .request('petri-cluster-worker', () => new Promise(resolve => {
                                                 keepAlive.releaseLock = resolve;
                                             }))
            .catch(() => {});
    }

    // 2. Screen Wake Lock: не дает экрану погаснуть на телефоне
    if ('wakeLock' in navigator && !keepAlive.wakeLock) {
        try {
            const wl = await navigator.wakeLock.request('screen');
            if (workerState.status === 'running' && workerState.backgroundMode) {
                keepAlive.wakeLock = wl;
            } else {
                wl.release().catch(() => {});
            }
        } catch (_) {
        }
    }

    // 3. Silent Audio Loop: удерживает процесс живым при сворачивании на Android
    if (!keepAlive.audioEl) {
        try {
            const silentWav =
                'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
            const audio = new Audio(silentWav);
            audio.loop = true;
            audio.volume = 0.001;
            keepAlive.audioEl = audio;  // Сохраняем ссылку ДО await!
            await audio.play();

            // Если за время запуска пользователь успел выключить режим — сразу глушим
            if (workerState.status !== 'running' || !workerState.backgroundMode) {
                disableBackgroundKeepAlive();
            }
        } catch (_) {
            keepAlive.audioEl = null;
        }
    }
}

function disableBackgroundKeepAlive() {
    if (keepAlive.releaseLock) {
        keepAlive.releaseLock();
        keepAlive.releaseLock = null;
    }
    if (keepAlive.wakeLock) {
        keepAlive.wakeLock.release().catch(() => {});
        keepAlive.wakeLock = null;
    }
    if (keepAlive.audioEl) {
        try {
            keepAlive.audioEl.pause();
            keepAlive.audioEl.removeAttribute('src');
            keepAlive.audioEl.load();  // Принудительно закрывает медиа-сессию и убирает значок 🔊
        } catch (_) {
        }
        keepAlive.audioEl = null;
    }
}

// Повторно запрашиваем Wake Lock при возврате на вкладку (браузер сбрасывает его при сворачивании)
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && workerState.status === 'running' && workerState.backgroundMode &&
        'wakeLock' in navigator) {
        navigator.wakeLock.request('screen')
            .then(wl => {
                keepAlive.wakeLock = wl;
            })
            .catch(() => {});
    }
});

export function setWebWorkerBackgroundMode(enabled) {
    workerState.backgroundMode = Boolean(enabled);
    try {
        localStorage.setItem(BG_MODE_STORAGE_KEY, workerState.backgroundMode ? '1' : '0');
    } catch (_) {
    }

    if (workerState.status === 'running') {
        if (workerState.backgroundMode) {
            enableBackgroundKeepAlive();
        } else {
            disableBackgroundKeepAlive();
        }
    }
    notifyUi();
}






/**
 * @brief Запускает браузерный воркер и подключает его к текущему серверу.
 */
export async function startBrowserWorker(customServerUrl = '') {
    if (workerState.status === 'loading' || workerState.status === 'running') return;

    const rawUrl = customServerUrl || defaultServerProvider() || '';
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
        workerState.blobUrl = getWorkerBlobUrl(workerState.wasmCdnUrl);

        // Компилируем WASM-ядро ОДИН РАЗ в главном потоке перед запуском слотов
        if (!workerState.wasmModule && WebAssembly.compileStreaming) {
            try {
                workerState.wasmModule = await WebAssembly.compileStreaming(
                    fetch(`${workerState.wasmCdnUrl}/pyjs_runtime_browser.wasm`));
            } catch (_) {
                workerState.wasmModule = null;
            }
        }

        const n = workerState.slots;


        // 1. Сначала поднимаем ТОЛЬКО нулевой слот (он прогреет кэш и посчитает бенчмарк без
        // конкуренции за CPU)
        const first = await spawnSlot(0);
        if (workerState.status !== 'loading') {
            first.slot.w.terminate();
            return;
        }

        workerState.pool = [first.slot];
        const totalScore = (first.score || 500) * n;
        const ramMb = (navigator.deviceMemory || 4) * 1024;

        const reg = await apiPost('/worker/register', {
            arch: 'wasm32',
            os: 'browser',
            cpu_cores: n,
            ram_mb: ramMb,
            benchmark_score: totalScore
        });

        workerState.workerId = reg.workerId;
        workerState.hbIntervalMs = reg.heartbeatIntervalMs || 2000;
        workerState.status = 'running';
        if (workerState.backgroundMode) {
            enableBackgroundKeepAlive();
        }
        notifyUi();

        // Сразу запускаем работу на 1-м слоте!
        runHeartbeatLoop(n, ramMb, totalScore);
        runPullLoop(ramMb);

        // 2. Остальные слоты (1 .. n-1) поднимаем в фоне (уже из прогретого кэша) и добавляем в пул
        if (n > 1) {
            Promise.all(Array.from(
                {length: n - 1},
                (_, i) => spawnSlot(i + 1)
                              .then(res => {
                                  if (workerState.status === 'running') {
                                      workerState.pool.push(res.slot);
                                  } else {
                                      res.slot.w.terminate();
                                  }
                              })
                              .catch(() => {})));
        }

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
                const {chunks = [], retryAfterMs = 500} = await apiPost('/worker/pull', {
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
                await new Promise(r => setTimeout(r, 500));
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
    disableBackgroundKeepAlive();
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
window.addEventListener('pagehide', () => {
    if (workerState.workerId && workerState.masterUrl) {
        const url = `${workerState.masterUrl}/worker/unregister`;
        const payload = JSON.stringify({workerId: workerState.workerId});
        if (navigator.sendBeacon) {
            navigator.sendBeacon(url, new Blob([payload], {type: 'text/plain'}));
        } else {
            fetch(url, {method: 'POST', body: payload, keepalive: true});
        }
    }
});