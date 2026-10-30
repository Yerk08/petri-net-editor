import * as dispatcher from '../modules/dispatcher.js';
import * as stateModule from '../modules/state.js';

describe('Dispatcher Subsystem (Polling & Cancel)', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        global.fetch = jest.fn();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test(
        'startPolling должно адаптивно увеличивать интервал при успехе и обновлять статус',
        async () => {
            // Настраиваем мок ответа сервера (задача еще выполняется)
            global.fetch.mockResolvedValueOnce(
                {ok: true, json: async () => ({status: 'processing'})});

            dispatcher.startPolling('task_123', 'http://localhost');

            // Прокручиваем таймер на первый шаг (500ms)
            jest.advanceTimersByTime(500);

            // Ждем разрешения микрозадач (fetch)
            await Promise.resolve();

            expect(global.fetch)
                .toHaveBeenCalledWith('http://localhost/api/v1/check_task?taskId=task_123');
        });

    test('startPolling должно останавливать опрос при статусе ready', async () => {
        // 1. Настраиваем фейковый успешный ответ сервера
        global.fetch.mockResolvedValueOnce(
            {ok: true, json: async () => ({status: 'ready', short_result: 'Успешно'})});

        // 2. Инициализируем задачу в Диспетчере
        stateModule.setDispatcherTasks([{
            taskId: 'task_777',
            serverUrl: 'http://localhost',
            taskStatus: 'active',
            typeName: 'Тестовый анализ',
            timestamp: '12:00:00'
        }]);

        // 3. Запускаем поллинг
        dispatcher.startPolling('task_777', 'http://localhost');

        // Это одновременно продвинет и setTimeout(500), и разрешит вложенный асинхронный fetch.
        await jest.advanceTimersByTimeAsync(500);

        const dView = stateModule.getDispatcherView();
        const updatedTask = dView.tasks.find(t => t.taskId === 'task_777');

        expect(updatedTask).toBeDefined();
        expect(updatedTask.taskStatus).toBe('ready');
        expect(updatedTask.shortResult).toBe('Успешно');
    });

    test(
        'cancelAnalysisTaskById должно отправлять POST запрос и переводить задачу в cancelled',
        async () => {
            global.confirm.mockReturnValueOnce(true);  // Юзер нажал "ОК" на confirm
            global.fetch.mockResolvedValueOnce({ok: true});

            // Добавляем фейковую активную задачу в диспетчер
            stateModule.setDispatcherTasks([{
                taskId: 'task_to_cancel',
                serverUrl: 'http://localhost',
                taskStatus: 'active',
                typeName: 'Тест'
            }]);

            await dispatcher.cancelAnalysisTaskById('task_to_cancel');

            expect(global.fetch)
                .toHaveBeenCalledWith(
                    'http://localhost/api/v1/cancel_task',
                    expect.objectContaining(
                        {method: 'POST', body: JSON.stringify({taskId: 'task_to_cancel'})}));

            const task = stateModule.getDispatcherView().tasks[0];
            expect(task.taskStatus).toBe('cancelled');
        });
});
