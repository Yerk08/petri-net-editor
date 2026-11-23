/**
 * @file dispatcher.js
 * @brief Модуль диспетчеризации, адаптивного поллинга и отмены фоновых задач анализа.
 */

import {updateConnectionIndicator} from './analysis.js';
import {renderAnalysisTaskControl} from './render.js';
import {getAnalysisSession, getDispatcherView, pushDispatcherTask} from './state.js';
import {saveToLocalStorage} from './storage.js';
import {getWebWorkerState} from './web-worker.js';


let batchPollTimers = new Map(); // serverUrl -> timeoutId

/**
 * @brief Запускает (или гарантирует работу) пакетного поллера для указанного сервера.
 */
export function startPolling(taskId, serverUrl) {
    const cleanUrl = serverUrl.replace(/\/+$/, '');
    if (!batchPollTimers.has(cleanUrl)) {
        scheduleBatchPoll(cleanUrl, 0); // Первый опрос сразу или с минимальной задержкой
    }
}

function scheduleBatchPoll(serverUrl, delay = 500) {
    if (batchPollTimers.has(serverUrl)) {
        clearTimeout(batchPollTimers.get(serverUrl));
    }

    const timeoutId = setTimeout(async () => {
        const dView = getDispatcherView();
        const session = getAnalysisSession();
        const activeStatuses = ['active', 'processing', 'pending'];

        // Собираем все активные задачи этого сервера (из реестра диспетчера + текущую сессию)
        const taskIdsSet = new Set();
        dView.tasks.forEach(t => {
            if (t.serverUrl.replace(/\/+$/, '') === serverUrl && activeStatuses.includes(t.taskStatus)) {
                taskIdsSet.add(t.taskId);
            }
        });
        if (session.taskId && activeStatuses.includes(session.taskStatus) &&
            (session.defaultServer || '').replace(/\/+$/, '') === serverUrl) {
            taskIdsSet.add(session.taskId);
        }

        const taskIds = Array.from(taskIdsSet);
        if (taskIds.length === 0) {
            batchPollTimers.delete(serverUrl);
            return;
        }

        try {
            const response = await fetch(`${serverUrl}/api/v1/check_tasks`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({taskIds})
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const payload = await response.json();
            const tasksMap = payload.tasks || {};

            let anyFinished = false;
            let sessionUpdated = false;

            for (const id of taskIds) {
                const data = tasksMap[id];
                if (!data) continue;

                pushDispatcherTask({
                    taskId: id,
                    taskStatus: data.status,
                    shortResult: data.status === 'ready'
                        ? data.short_result
                        : (data.status === 'failed' ? data.error : null)
                });

                if (session.taskId === id && session.taskStatus !== data.status) {
                    if (data.status === 'ready') {
                        session.taskStatus = 'ready';
                        session.shortResult = data.short_result || 'Анализ успешно завершен.';
                        sessionUpdated = true;
                    } else if (data.status === 'failed') {
                        session.taskStatus = 'failed';
                        session.shortResult = data.error || 'Ошибка при выполнении расчетов.';
                        sessionUpdated = true;
                    } else if (data.status === 'cancelled') {
                        session.taskStatus = 'cancelled';
                        sessionUpdated = true;
                    }
                }

                if (['ready', 'failed', 'cancelled'].includes(data.status)) {
                    anyFinished = true;
                }
            }

            updateConnectionIndicator('online');

            // 1. Сначала проверяем, остались ли активные задачи ИМЕННО на этом сервере
            const hasRemaining = dView.tasks.some(
                t => t.serverUrl.replace(/\/+$/, '') === serverUrl && activeStatuses.includes(t.taskStatus)
            ) || (
                session.taskId &&
                activeStatuses.includes(session.taskStatus) &&
                (session.defaultServer || '').replace(/\/+$/, '') === serverUrl
            );

            // 2. Сначала обновляем/очищаем таймер, и ТОЛЬКО ПОТОМ перерисовываем UI!
            if (hasRemaining) {
                scheduleBatchPoll(serverUrl, 500);
            } else {
                batchPollTimers.delete(serverUrl);
            }

            if (anyFinished || sessionUpdated) {
                renderAnalysisTaskControl();
                if (dView.isDispatcherMode) viewInDispatcher();
                saveToLocalStorage();
            }


        } catch (error) {
            updateConnectionIndicator('offline');
            scheduleBatchPoll(serverUrl, 1000);
        }
    }, delay);

    batchPollTimers.set(serverUrl, timeoutId);
}

/**
 * @brief Отменяет задачу на сервере и останавливает её локальный таймер.
 * @async
 * @param {string} targetTaskId ID отменяемой задачи.
 * @note **Зависимости:** Удаляет таймер из `pollingTimeoutsMap`. Индицирует фазы через
 * `updateConnectionIndicator()` (`analysis.js`). Меняет статус в `getDispatcherView()` (`state.js`)
 * и форсирует перерисовку UI.
 */
export async function cancelAnalysisTaskById(targetTaskId) {
    const dView = getDispatcherView();
    const task = dView.tasks.find(t => t.taskId === targetTaskId);
    if (!task) return;

    if (!confirm(`Вы уверены, что хотите отменить задачу \"${task.typeName}\"?`)) return;

    const serverUrl = task.serverUrl;
    updateConnectionIndicator('loading');

    try {
        const response = await fetch(`${serverUrl}/api/v1/cancel_task`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({taskId: targetTaskId})
        });
        if (!response.ok) throw new Error(`Сервер вернул статус ${response.status}`);

        // Локально переводим в статус отмены
        task.taskStatus = 'cancelled';
        task.shortResult = 'Отменено пользователем.';

        const session = getAnalysisSession();
        if (session.taskId === targetTaskId) {
            session.taskStatus = 'cancelled';
            session.taskId = null;
            session.shortResult = null;
        }
        updateConnectionIndicator('online');
    } catch (e) {
        console.error('Не удалось отменить задачу на сервере:', e);
        updateConnectionIndicator('offline');
    }

    renderAnalysisTaskControl();
    if (dView.isDispatcherMode) {
        viewInDispatcher();
    }
}

/**
 * @brief Обертка для отмены текущей активной сессионной задачи.
 * @async
 * @note **Зависимости:** Считывает `taskId` из `getAnalysisSession()` (`state.js`) и перенаправляет
 * вызов в `cancelAnalysisTaskById()`.
 */
export async function cancelAnalysisTask() {
    const session = getAnalysisSession();
    if (session.taskId) {
        await cancelAnalysisTaskById(session.taskId);
    }
}



/**
 * @brief Отрисовывает полноэкранный интерфейс Диспетчера задач поверх SVG-холста.
 * @note **Зависимости:** Считывает задачи из `getDispatcherView()` (`state.js`), блокирует рендер
 * холста (`isDispatcherMode = true`). Каскадно запускает автоопрос через
 * `initActiveTasksPolling()`.
 */
export function viewInDispatcher() {
    const dView = getDispatcherView();
    dView.isDispatcherMode = true;

    initActiveTasksPolling();
    startClusterStatusPolling();

    let overlay = document.getElementById('dispatcher-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'dispatcher-overlay';
        const container = document.getElementById('canvas-container');
        if (container) container.appendChild(overlay);
    }

    const statusLabels = {
        active: '⏳ Выполняется',
        ready: '✅ Готово',
        failed: '❌ Ошибка',
        cancelled: '🚫 Отменено'
    };

    const statusColors =
        {active: '#fff3cd', ready: '#d4edda', failed: '#f8d7da', cancelled: '#e2e3e5'};

    let tasksHtml =
        dView.tasks
            .map(t => {
                const currentBg = statusColors[t.taskStatus] || '#ffffff';
                const statusText = statusLabels[t.taskStatus] || t.taskStatus;

                return `
            <div class="dispatcher-task-card" style="background: ${currentBg};">
                <div class="dispatcher-task-info" style="min-width: 0; flex: 1;" onclick="window.openDetailedResult('${
                    t.taskId}', '${t.serverUrl}')">
                    <div class="dispatcher-task-meta" style="margin-bottom: 4px; font-size: 0.9em;">
                        <b>${
                    statusText}</b> <span class="dispatcher-task-time" style="color: #555;">[${
                    t.timestamp}]</span>
                    </div>
                    <div class="dispatcher-task-title" style="font-weight: 600; line-height: 1.3; word-break: break-word; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">
                        ${t.typeName}
                    </div>
                    ${
                    t.shortResult ?
                        `<div class="dispatcher-task-result" style="margin-top: 6px;"><h3 style="margin: 0; font-size: 0.95em; font-weight: normal;">${
                            t.shortResult}</h3></div>` :
                        ''}
                </div>
                <div class="dispatcher-task-actions">
                    ${
                    t.taskStatus === 'active' ? `
                        <button class="btn-danger" style="padding: 4px 8px; margin: 0;" onclick="window.cancelAnalysisTaskById('${
                                                    t.taskId}')">🛑 Отмена</button>
                    ` :
                                                ''}
                    <button class="btn-secondary" style="padding: 4px 8px; margin: 0; background: #eee; border: 1px solid #aaa;" onclick="window.openDetailedResult('${
                    t.taskId}', '${t.serverUrl}')">👁️ Подробно</button>
                </div>
            </div>
        `;
            })
            .join('');

    overlay.innerHTML = `
        <div class="dispatcher-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 15px; margin-bottom: 20px;">
            <h2 style="margin: 0; min-width: 300px;">📊 Диспетчер задач</h2>
            ${
        dView.tasks.length > 0 ? `
                    <button class="btn-danger" 
                            onclick="window.clearAllDispatcherTasks()">
                        🗑️ Очистить список
                    </button>
                ` :
                                 ''}
            </div>
        </div>

        <div class="dispatcher-list">
            ${
        dView.tasks.length === 0 ?
            '<p style="color: #666; text-align: center; margin-top: 40px;">Список запущенных задач пуст.</p>' :
            tasksHtml}
        </div>
    `;
}

/**
 * @brief Автоматически возобновляет опрос для всех незавершенных задач в реестре.
 * @private
 * @note **Зависимости:** Фильтрует задачи со статусом active/pending из `getDispatcherView()`
 * (`state.js`) и инициализирует для них сетевой конвейер `startPolling()`.
 */
function initActiveTasksPolling() {
    const dView = getDispatcherView();
    const activeStatuses = ['active', 'processing', 'pending'];

    dView.tasks.forEach(t => {
        if (activeStatuses.includes(t.taskStatus)) {
            console.log(`[Dispatcher] Автозапуск поллинга для незавершенной задачи: ${t.taskId}`);
            startPolling(t.taskId, t.serverUrl);
        }
    });
}

/**
 * @brief Очищает историю диспетчера и принудительно останавливает все таймеры.
 * @note **Зависимости:** Сбрасывает таймауты в `pollingTimeoutsMap`. Очищает данные в
 * `getDispatcherView()` и `getAnalysisSession()` (`state.js`). Сохраняет состояние через
 * `saveToLocalStorage()` и обновляет UI.
 */
export function clearAllDispatcherTasks() {
    const dView = getDispatcherView();
    if (dView.tasks.length === 0) return;

    const confirmed = confirm(
        'Вы уверены, что хотите полностью очистить историю фоновых задач? Активные таймеры опроса будут остановлены.');

    if (confirmed) {
        batchPollTimers.forEach((timeoutId) => clearTimeout(timeoutId));
        batchPollTimers.clear();
        dView.tasks = [];

        const session = getAnalysisSession();
        session.taskId = null;
        session.taskStatus = null;
        session.shortResult = null;

        saveToLocalStorage();
        renderAnalysisTaskControl();
        viewInDispatcher();
    }
}

/**
 * @brief Регистрирует произвольный ID задачи для ручного отслеживания.
 * @note Добавление этой функции в UI признано излишним, поэтому такая кнопка отсутствует, тем не
 * менее она полностью поддерживается и работает корректно.
 * @note **Зависимости:** Читает хост из `getAnalysisSession()` (`state.js`), добавляет задачу в
 * реестр через `pushDispatcherTask()`, фиксирует в `saveToLocalStorage()`, запускает слежение через
 * `startPolling()` и обновляет Диспетчер.
 */
export function trackTaskByIdManual() {
    const inputEl = document.getElementById('manual-task-id-input');
    if (!inputEl) return;

    const taskId = inputEl.value.trim();
    if (!taskId) {
        alert('Пожалуйста, введите корректный ID задачи.');
        return;
    }

    const dView = getDispatcherView();

    // Проверяем, не отслеживается ли уже эта задача
    const exists = dView.tasks.some(t => t.taskId === taskId);
    if (exists) {
        alert('Эта задача уже добавлена в список диспетчера.');
        return;
    }

    const session = getAnalysisSession();
    const serverUrl = session.defaultServer ? session.defaultServer.replace(/\/+$/, '') : '';

    if (!serverUrl) {
        alert('Не удалось определить адрес сервера. Укажите его на панели анализа.');
        return;
    }

    // Создаем новую запись в реестре диспетчера
    const newTask = {
        taskId: taskId,
        serverUrl: serverUrl,
        typeName: 'Ручной трекинг',
        taskStatus: 'active',  // Инициализируем как активную, поллинг сам актуализирует статус при
                               // первом запросе
        shortResult: null
    };

    pushDispatcherTask(newTask);
    saveToLocalStorage();
    startPolling(taskId, serverUrl);
    viewInDispatcher();
}

/**
 * @brief Закрывает оверлей диспетчера и восстанавливает отображение SVG-холста сети.
 * @note **Зависимости:** Сбрасывает флаг режима в `getDispatcherView()` (`state.js`). Вызывается из
 * координатора режимов `setMode()` (`state.js`).
 */
export function closeDispatcher() {
    stopClusterStatusPolling();

    const overlay = document.getElementById('dispatcher-overlay');
    if (overlay) overlay.remove();
    getDispatcherView().isDispatcherMode = false;

    const svgCanvas = document.getElementById('petri-svg');
    if (svgCanvas) {
        svgCanvas.style.display = 'block';
    }
};

/**
 * @brief Открывает iframe с подробным HTML-отчетом о результатах задачи.
 * @param {string} taskId ID задачи.
 * @param {string} serverUrl URL сервера.
 * @note **Зависимости:** Переводит состояние диспетчера в `isDetailedResultMode = true`
 * (`state.js`) и монтирует iframe, запрашивающий эндпоинт `/api/v1/get_full_result`.
 */
export function openDetailedResult(taskId, serverUrl) {
    const dView = getDispatcherView();
    dView.isDetailedResultMode = true;
    let detailedWindow = document.getElementById('dispatcher-detailed-window');
    if (!detailedWindow) {
        detailedWindow = document.createElement('div');
        detailedWindow.id = 'dispatcher-detailed-window';
        document.getElementById('canvas-container').appendChild(detailedWindow);
    }

    const fullResultUrl =
        `${serverUrl.replace(/\/+$/, '')}/api/v1/get_full_result?taskId=${taskId}`;
    detailedWindow.innerHTML = `
        <div class="dispatcher-header">
            <button class="btn-secondary" onclick="window.closeDetailedResult()">⬅️ Назад в список</button>
        </div>
        <div class="dispatcher-iframe-wrapper">
            <iframe src="${fullResultUrl}"></iframe>
        </div>
    `;
}

/**
 * @brief Закрывает окно детального отчета и возвращает пользователя к списку задач.
 * @note **Зависимости:** Удаляет DOM-окно отчета и сбрасывает флаг `isDetailedResultMode` в
 * `getDispatcherView()` (`state.js`). Вызывается автоматически при экстренной смене режимов в
 * `state.js`.
 */
export function closeDetailedResult() {
    const dView = getDispatcherView();
    if (dView.isDetailedResultMode) {
        document.getElementById('dispatcher-detailed-window').remove();
        dView.isDetailedResultMode = false;
    }
}


// ** ОБНОВЛЕНИЕ СОСТОЯНИЕ КЛАСТЕРА **
let clusterStatusTimeout = null;

function stopClusterStatusPolling() {
    if (clusterStatusTimeout) {
        clearTimeout(clusterStatusTimeout);
        clusterStatusTimeout = null;
    }
}

function startClusterStatusPolling() {
    stopClusterStatusPolling();

    const poll = async () => {
        if (!getDispatcherView().isDispatcherMode) {
            stopClusterStatusPolling();
            return;
        }

        // Если вкладка свернута — не нагружаем сеть, проверяем реже (раз в 5 сек)
        if (document.hidden) {
            clusterStatusTimeout = setTimeout(poll, 5000);
            return;
        }

        await refreshClusterStatus();

        // Планируем следующий запрос только ПОСЛЕ завершения текущего
        if (getDispatcherView().isDispatcherMode) {
            clusterStatusTimeout = setTimeout(poll, 1000);
        }
    };

    poll();
}

/**
 * @brief Запрашивает состояние вычислительного кластера с текущего сервера и обновляет виджет в
 * правой панели.
 * @async
 * @note **Зависимости:** Читает адрес сервера из `getAnalysisSession().defaultServer` и проверяет
 * режим диспетчера через `getDispatcherView()` (`state.js`). Обращается к эндпоинту
 * `/api/v1/cluster_status`, монтирует сводку в DOM-элемент `#properties-panel` или останавливает
 * фоновый опрос через `stopClusterStatusPolling()` при закрытии Диспетчера.
 */
export async function refreshClusterStatus() {
    const panel = document.getElementById('properties-panel');
    if (!panel || !getDispatcherView().isDispatcherMode) {
        stopClusterStatusPolling();
        return;
    }

    const rawUrl = getAnalysisSession().defaultServer || '';
    const serverUrl = rawUrl.trim().replace(/\/+$/, '');

    if (!serverUrl) {
        panel.innerHTML = `
            <div class="property-group"><h3>Кластер</h3></div>
            <p style="color:#888;">Сервер не задан.</p>
        `;
        return;
    }

    // Инициализируем раздельные слоты в DOM только один раз
    let statusContainer = document.getElementById('cluster-status-container');
    let workerContainer = document.getElementById('web-worker-control-container');

    if (!statusContainer || !workerContainer) {
        panel.innerHTML = `
            <div id="cluster-status-container"></div>
            <div id="web-worker-control-container"></div>
        `;
        statusContainer = document.getElementById('cluster-status-container');
        workerContainer = document.getElementById('web-worker-control-container');
    }

    updateWebWorkerControlIfNeeded(workerContainer);

    try {
        const res = await fetch(`${serverUrl}/api/v1/cluster_status`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const ramGb = (data.totalRamMb / 1024).toFixed(1);
        const availabilityBadge = data.isAvailable ?
            `<span style="color:#155724; font-weight:bold;">🟢 Готов</span>` :
            `<span style="color:#856404; font-weight:bold;">🟡 Нет узлов</span>`;

        statusContainer.innerHTML = `
            <div class="property-group">
                <h3>Кластер</h3>
            </div>
            <div style="color:#666; word-break:break-all; margin-bottom:8px;">
                <code>${serverUrl}</code>
            </div>
            <div style="padding: 10px; border: 1px solid rgba(128,128,128,0.3); border-radius: 6px; background: rgba(128,128,128,0.06); line-height:1.6;">
                <div style="margin-bottom:6px;">${availabilityBadge}</div>
                <div>🖥️ Узлы: <b>${data.onlineWorkers}</b></div>
                <div>⚙️ Cores: <b>${data.totalCpuCores}</b></div>
                <div>⚙️ RAM: <b>${ramGb} ГБ</b></div>
                <div>⚡ Power: <b>${data.totalBenchmarkScore}</b></div>
                <div>📦 Задачи: <b>${data.activeTasksCount}</b></div>
                <div>🧩 Очередь: <b>${data.queuedChunksCount}</b></div>
            </div>
        `;
    } catch (e) {
        statusContainer.innerHTML = `
            <div class="property-group">
                <h3>Кластер</h3>
            </div>
            <div style="color:#666; word-break:break-all; margin-bottom:8px;">
                <code>${serverUrl}</code>
            </div>
            <div style="padding: 10px; border: 1px solid rgba(220,53,69,0.4); border-radius: 6px; background: rgba(220,53,69,0.08); color:#721c24; font-weight:bold;">
                🔴 Недоступен
            </div>
        `;
    }
}



/**
 * @brief Аккуратно обновляет текущее состояние веб-воркера для помощи серверу.
 */
function updateWebWorkerControlIfNeeded(container) {
    if (document.activeElement && document.activeElement.id === 'ww-slots-input') {
        return;
    }

    const ws = getWebWorkerState();
    const currentKey = `${ws.status}|${ws.slots}|${ws.backgroundMode}|${ws.workerId}|${ws.completedChunks}|${ws.errorMessage}`;

    if (container.dataset.renderKey === currentKey) {
        return;
    }

    container.dataset.renderKey = currentKey;
    container.innerHTML = renderWebWorkerControlHtml(ws);
}

/**
 * @brief Формирует HTML-блок управления локальным браузерным воркером для помощи серверу.
 */
function renderWebWorkerControlHtml(ws = getWebWorkerState()) {
    if (ws.status === 'loading') {
        return `
            <div class="property-group" style="margin-top: 16px;"><h3>Помощь кластеру</h3></div>
            <div style="padding: 10px; border: 1px solid rgba(128,128,128,0.3); border-radius: 6px; background: rgba(128,128,128,0.06);">
                <div style="color: #856404; font-weight: bold; margin-bottom: 6px;">⏳ Загрузка Python + Numba...</div>
                <div style="font-size: 0.85em; color: #666; margin-bottom: 8px;">Инициализация WASM (${ws.slots} поток.)</div>
                <button class="btn-danger" style="width: 100%;" onclick="window.stopBrowserWorker()">Отмена</button>
            </div>
        `;
    }

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const mobileBatteryHint = (ws.backgroundMode && isMobile) ? `
        <div style="margin-top: 6px; padding: 6px 8px; border-radius: 4px; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.35); font-size: 0.78em; line-height: 1.4; color: #92400e;">
            💡 Для работы при выключенном экране отключите ограничение батареи: <b>Настройки → Приложения → Chrome → Батарея → Без ограничений</b>.
        </div>
    ` : '';

    const bgCheckboxHtml = `
        <label class="ww-bg-toggle ${ws.backgroundMode ? 'active' : ''}"
               title="Удерживает вкладку и экран активными при сворачивании на телефоне или ПК">
            <span class="ww-bg-toggle-label">
                <span>🔋</span>
                <span>В фоне</span>
            </span>
            <input type="checkbox" ${ws.backgroundMode ? 'checked' : ''}
                   onchange="window.setWebWorkerBackgroundMode(this.checked)">
        </label>
        ${mobileBatteryHint}
    `;

    if (ws.status === 'running') {
        return `
            <div class="property-group" style="margin-top: 16px;"><h3>Помощь кластеру</h3></div>
            <div style="padding: 10px; border: 1px solid rgba(40,167,69,0.4); border-radius: 6px; background: rgba(40,167,69,0.08); line-height: 1.6;">
                <div style="color: #155724; font-weight: bold; margin-bottom: 4px;">🟢 Узел активен</div>
                <div style="font-size: 0.85em;">ID: <code>${ws.workerId}</code></div>
                <div style="font-size: 0.85em;">Потоков: <b>${ws.slots}</b> | Чанков: <b>${ws.completedChunks}</b></div>
                ${bgCheckboxHtml}
                <button class="btn-danger" style="width: 100%; margin-top: 8px;" onclick="window.stopBrowserWorker()">⏹️ Остановить помощь</button>
            </div>
        `;
    }

    return `
        <div class="property-group" style="margin-top: 16px;"><h3>Помощь кластеру</h3></div>
        <div style="padding: 10px; border: 1px solid rgba(128,128,128,0.3); border-radius: 6px; background: rgba(128,128,128,0.06);">
            ${ws.status === 'error' ? `<div style="color: #721c24; font-size: 0.85em; margin-bottom: 6px;">⚠️ ${ws.errorMessage}</div>` : ''}
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 0.9em;">
                <label for="ww-slots-input">Потоки (WASM):</label>
                <input id="ww-slots-input" type="number" min="1" max="16" value="${ws.slots}" 
                       style="width: 55px; padding: 3px 6px;" oninput="window.setWebWorkerSlots(this.value)">
            </div>
            ${bgCheckboxHtml}
            <button style="width: 100%; margin-top: 8px; background: #2563eb; color: #fff; border: none; padding: 7px; border-radius: 4px; cursor: pointer; font-weight: 600;" 
                    onclick="window.startBrowserWorker()">
                🤝 Помогать серверу
            </button>
        </div>
    `;
}
