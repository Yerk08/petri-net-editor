/**
 * @file dispatcher.js
 * @brief Модуль диспетчеризации, адаптивного поллинга и отмены фоновых задач анализа.
 */

import {updateConnectionIndicator} from './analysis.js';
import {renderAnalysisTaskControl} from './render.js';
import {getAnalysisSession} from './state.js';


let pollingTimeoutId = null;

/**
 * @brief Запускает адаптивный интервальный опрос состояния задачи.
 */
export function startPolling(taskId, serverUrl, currentDelay = 500) {
    if (pollingTimeoutId) clearTimeout(pollingTimeoutId);

    pollingTimeoutId = setTimeout(async () => {
        const session = getAnalysisSession();
        if (!session.taskId || session.taskId !== taskId || session.taskStatus !== 'active') {
            return;
        }

        try {
            const response = await fetch(`${serverUrl}/api/v1/check_task?taskId=${taskId}`);
            if (!response.ok) throw new Error(`Ошибка сервера при опросе: ${response.status}`);
            const data = await response.json();

            if (data.status === 'ready') {
                session.taskStatus = 'ready';
                session.shortResult = data.short_result || 'Анализ успешно завершен.';
                updateConnectionIndicator('online');
                renderAnalysisTaskControl();
                return;
            } else if (data.status === 'failed') {
                session.taskStatus = 'failed';
                session.shortResult = data.error || 'Ошибка при выполнении расчетов.';
                updateConnectionIndicator('online');
                renderAnalysisTaskControl();
                return;
            }

            updateConnectionIndicator('online');
            const nextDelay = Math.min(60000, Math.round(currentDelay * 1.3));
            startPolling(taskId, serverUrl, nextDelay);

        } catch (error) {
            updateConnectionIndicator('offline');
            startPolling(taskId, serverUrl, 2000);
        }
    }, currentDelay);
}

/**
 * @brief Безопасно отменяет активную задачу на сервере с подтверждением пользователя.
 */
export async function cancelAnalysisTask() {
    const session = getAnalysisSession();
    const taskId = session.taskId;
    if (!taskId) return;

    if (!confirm('Вы уверены, что хотите отменить выполнение текущей задачи анализа?')) {
        return;
    }

    if (pollingTimeoutId) clearTimeout(pollingTimeoutId);
    const serverUrl = session.defaultServer.replace(/\/+$/, '');
    updateConnectionIndicator('loading');

    try {
        const response = await fetch(`${serverUrl}/api/v1/cancel_task`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({taskId: taskId})
        });

        if (!response.ok) {
            throw new Error(`Сервер вернул статус ${response.status} при отмене`);
        }

        session.taskStatus = 'cancelled';
        session.taskId = null;
        session.shortResult = null;
        updateConnectionIndicator('online');

    } catch (e) {
        console.error('Не удалось отправить запрос отмены на сервер:', e);
        updateConnectionIndicator('offline');
        session.taskStatus = 'failed';
        session.shortResult = `Не удалось отменить задачу на сервере: ${e.message}`;
    }

    renderAnalysisTaskControl();
}

/**
 * @brief Открывает детальный просмотр задачи в Диспетчере.
 */
export function viewInDispatcher() {
    const session = getAnalysisSession();
    if (session.taskId) {
        alert(`Переход к детальному просмотру задачи ${session.taskId} в Диспетчере.`);
    }
}
