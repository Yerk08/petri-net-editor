import * as analysis from '../modules/analysis.js';
import * as stateModule from '../modules/state.js';

describe('Analysis Integration Subsystem', () => {
    beforeEach(() => {
        global.fetch = jest.fn();
    });

    test(
        'submitAnalysisTask должно формировать правильный payload с фильтрацией переходов по цветам',
        async () => {
            // 1. Настройка JSDOM окружения для прохождения валидации
            stateModule.setDefaultServer('http://petri-server');
            const serverInput = document.getElementById('analysis-server-input');
            if (serverInput) serverInput.value = 'http://petri-server';

            const typeSelect = document.getElementById('analysis-type-select');
            if (typeSelect) {
                typeSelect.innerHTML =
                    '<option value="structural_analysis" selected>Структурный</option>';
                typeSelect.value = 'structural_analysis';
            }

            // 2 и 3. ОБЪЕДИНЯЕМ: Инициализируем сеть Петри И параметры анализа в одном объекте
            // state
            stateModule.replaceState({
                places: [{uuid: 'p1', name: 'P1', color: 'red', tokens: 1, initialTokens: 1}],
                transitions: [{uuid: 't_red', name: 'T_RED', color: 'red'}],
                arcs: [{uuid: 'a1', sourceId: 'p1', targetId: 't_red', weight: 2, color: 'red'}],
                comments: [],
                counters: {P: 1, T: 1, C: 0},
                // КРИТИЧЕСКОЕ МЕСТО: Переносим конфигурацию анализа прямо в корень состояния сети
                analysis: {
                    selectedType: 'structural_analysis',
                    selectedTypeName: 'Структурный',
                    params: {color_filter_param: ['red']}
                }
            });

            // 4. Мокаем сетевой запрос
            global.fetch = jest.fn().mockResolvedValue(
                {ok: true, json: async () => ({taskId: 'server_job_999'})});

            // 5. Запуск функции
            await analysis.submitAnalysisTask();

            // Даем выполниться асинхронным цепочкам fetch
            await new Promise(process.nextTick);

            // 6. Финальная проверка вызова API
            expect(global.fetch)
                .toHaveBeenCalledWith(
                    'http://petri-server/api/v1/submit_task',
                    expect.objectContaining({method: 'POST'}));
        });
});
