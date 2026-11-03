/**
 * @file dispatcher.js
 * @brief Модуль диспетчеризации, адаптивного поллинга и отмены фоновых задач анализа.
 */

import {updateConnectionIndicator} from './analysis.js';
import {renderAnalysisTaskControl} from './render.js';
import {getAnalysisSession, getDispatcherView, pushDispatcherTask} from './state.js';
import {saveToLocalStorage} from './storage.js';


let pollingTimeoutsMap = new Map();

/**
 * @brief Адаптивный лонг-поллинг (Exponential Backoff) состояния задачи на сервере.
 * @async
 * @param {string} taskId ID задачи.
 * @param {string} serverUrl URL сервера.
 * @param {number} [currentDelay=500] Задержка опроса.
 * @note **Зависимости:** Вызывает `updateConnectionIndicator()` (`analysis.js`) при сбоях. Меняет
 * сессию и реестр через `pushDispatcherTask()` (`state.js`). Триггерит рендеры
 * `renderAnalysisTaskControl()` и `viewInDispatcher()`.
 */
export function startPolling(taskId, serverUrl, currentDelay = 500) {
    if (pollingTimeoutsMap.has(taskId)) {
        clearTimeout(pollingTimeoutsMap.get(taskId));
    }

    const timeoutId = setTimeout(async () => {
        const session = getAnalysisSession();

        try {
            const response = await fetch(`${serverUrl}/api/v1/check_task?taskId=${taskId}`);
            if (!response.ok) {
                console.log(`Ошибка сервера при опросе: ${response.status}`);
                return;
            }
            const data = await response.json();

            // Синхронизируем статус и результаты прямо в глобальный реестр Диспетчера задач
            const updatedTaskData = {
                taskId: taskId,
                taskStatus: data.status,
                shortResult: data.status === 'ready' ?
                    data.short_result :
                    (data.status === 'failed' ? data.error : null)
            };
            pushDispatcherTask(updatedTaskData);

            // Если опрашиваемая задача параллельно выбрана как активная в боковой панели —
            // обновляем сессию
            if (session.taskId === taskId) {
                if (data.status === 'ready') {
                    session.taskStatus = 'ready';
                    session.shortResult = data.short_result || 'Анализ успешно завершен.';
                } else if (data.status === 'failed') {
                    session.taskStatus = 'failed';
                    session.shortResult = data.error || 'Ошибка при выполнении расчетов.';
                }
            }

            if (data.status === 'ready' || data.status === 'failed' ||
                data.status === 'cancelled') {
                updateConnectionIndicator('online');
                renderAnalysisTaskControl();
                if (getDispatcherView().isDispatcherMode) viewInDispatcher();
                pollingTimeoutsMap.delete(taskId);
                saveToLocalStorage();
                return;
            }

            updateConnectionIndicator('online');
            const nextDelay = Math.min(60000, Math.round(currentDelay * 1.3));
            startPolling(taskId, serverUrl, nextDelay);

        } catch (error) {
            updateConnectionIndicator('offline');
            const nextDelay = Math.min(60000, Math.round(currentDelay * 1.5));
            startPolling(taskId, serverUrl, nextDelay);
        }
    }, currentDelay);

    pollingTimeoutsMap.set(taskId, timeoutId);
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

    if (!confirm(`Вы уверены, что хотите отменить задачу ${targetTaskId}?`)) return;

    // Останавливаем поллинг для отменяемой задачи
    if (pollingTimeoutsMap.has(targetTaskId)) {
        clearTimeout(pollingTimeoutsMap.get(targetTaskId));
        pollingTimeoutsMap.delete(targetTaskId);
    }

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

    let overlay = document.getElementById('dispatcher-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'dispatcher-overlay';
        const container = document.getElementById('canvas-container');
        if (container) container.appendChild(overlay);
    }

    let tasksHtml =
        dView.tasks
            .map(t => {
                const statusColors =
                    {active: '#fff3cd', ready: '#d4edda', failed: '#f8d7da', cancelled: '#e2e3e5'};
                const currentBg = statusColors[t.taskStatus] || '#ffffff';

                return `
            <div class="dispatcher-task-card" style="background: ${currentBg};">
                <div class="dispatcher-task-info" onclick="window.openDetailedResult('${
                    t.taskId}', '${t.serverUrl}')">
                    <div class="dispatcher-task-title">${
                    t.typeName} <span class="dispatcher-task-time">[${t.timestamp}]</span></div>
                    <div class="dispatcher-task-meta">ID: <code>${t.taskId}</code> | Статус: <b>${
                    t.taskStatus}</b></div>
                    ${
                    t.shortResult ?
                        `<div class="dispatcher-task-result"><h3>${t.shortResult}</h3></div>` :
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
        if (activeStatuses.includes(t.taskStatus) && !pollingTimeoutsMap.has(t.taskId)) {
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
        pollingTimeoutsMap.forEach((timeoutId) => clearTimeout(timeoutId));
        pollingTimeoutsMap.clear();
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