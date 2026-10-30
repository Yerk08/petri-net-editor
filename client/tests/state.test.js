import * as stateModule from '../modules/state.js';

describe('Petri Net State & Simulation Logic', () => {
    beforeEach(() => {
        // Инициализируем чистую сеть перед каждым тестом
        stateModule.replaceState({
            places: [
                { uuid: 'p1', name: 'Place 1', tokens: 2, initialTokens: 2, color: 'black' },
                { uuid: 'p2', name: 'Place 2', tokens: 0, initialTokens: 0, color: 'black' }
            ],
            transitions: [
                { uuid: 't1', name: 'Transition 1', color: 'black' }
            ],
            arcs: [
                { uuid: 'a1', sourceId: 'p1', targetId: 't1', weight: 1, color: 'black' },
                { uuid: 'a2', sourceId: 't1', targetId: 'p2', weight: 1, color: 'black' }
            ],
            comments: [],
            counters: { P: 2, T: 1, C: 0 }
        });
    });

    test('isTransitionEnabled должно возвращать true, если фишек достаточно', () => {
        expect(stateModule.isTransitionEnabled('t1')).toBe(true);
    });

    test('isTransitionEnabled должно возвращать false, если фишек меньше веса дуги', () => {
        stateModule.updateTokens('p1', 0); // Обнуляем фишки
        expect(stateModule.isTransitionEnabled('t1')).toBe(false);
    });

    test('fireTransition должно корректно перемещать фишки и сохранять историю (Undo)', () => {
        stateModule.fireTransition('t1');

        const state = stateModule.getState();
        const sim = stateModule.getSimulation();

        // Проверяем изменение разметки
        expect(state.places.find(p => p.uuid === 'p1').tokens).toBe(1);
        expect(state.places.find(p => p.uuid === 'p2').tokens).toBe(1);

        // Проверяем, что шаг записался в историю
        expect(sim.history.length).toBe(1);
        expect(sim.history[0].uuid).toBe('t1');
    });

    test('undoTransition должно возвращать состояние назад', () => {
        stateModule.fireTransition('t1');
        stateModule.undoTransition();

        const state = stateModule.getState();
        expect(state.places.find(p => p.uuid === 'p1').tokens).toBe(2);
        expect(state.places.find(p => p.uuid === 'p2').tokens).toBe(0);
    });

    test('deleteObject должно удалять связанную дугу при удалении позиции', () => {
        stateModule.deleteObject('p1');
        const state = stateModule.getState();
        
        expect(state.places.find(p => p.uuid === 'p1')).toBeUndefined();
        // Дуга a1 должна удалиться, так как вела из p1
        expect(state.arcs.find(a => a.uuid === 'a1')).toBeUndefined();
    });
});