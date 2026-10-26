/**
 * @file state.js
 * @brief Модуль управления состоянием и логикой симуляции сети Петри.
 * @details Обеспечивает хранение структуры сети, переключение режимов работы,
 *          расчет активности переходов, выполнение шагов симуляции и функции Undo/Redo.
 */

// --- КОРРЕКТНОЕ СОСТОЯНИЕ (STATE) ---
/**
 * @brief Глобальный объект состояния сети Петри.
 *
 * @note **ИНСТРУКЦИЯ ПО РАСШИРЕНИЮ:**
 * Если вы добавляете новый тип элемента (например, `inhibitorArcs` или `subnets`):
 * 1. Добавьте новый массив в этот объект (например, `inhibitorArcs: []`).
 * 2. Обновите функцию clearPetriNet(), чтобы очищать этот массив.
 * 3. Обновите функцию deleteObject(), чтобы удалять связанные связи.
 * 4. Настройте инкремент счетчика в `counters` и обновите структуру в getCleanState().
 */
let state = {
    places: [],                   ///< { uuid, name, x, y, tokens, initialTokens, color }
    transitions: [],              ///< { uuid, name, x, y, color }
    arcs: [],                     ///< { uuid, sourceId, targetId, weight, color }
    comments: [],                 ///< { uuid, text, x, y, color }
    counters: {P: 1, T: 1, C: 1}  ///< Счетчики для генерации ID (Places, Transitions, Comments)
};


/**
 * @brief Объект состояния текущей сессии симуляции. Не эскпортируется никогда.
 */
let simulation = {
    isSimMode: false,  ///< Флаг активного режима симуляции
    history: [],       ///< Стек истории совершенных переходов (для Undo)
    redoHistory: []    ///< Стек отмененных переходов (для Redo)
}

export let currentMode = 'select';  ///< select, simulation, place, transition, arc, token, comment
export let selectedId = null;       ///< UUID выбранного в данный момент объекта
export let dragTarget = null;       ///< Ссылка на перетаскиваемый объект
export let arcSourceId = null;      ///< UUID начального узла при создании дуги

/**
 * @brief Карта видимости элементов по цветам.
 * @note **ИНСТРУКЦИЯ ПО РАСШИРЕНИЮ:** При добавлении нового цвета в палитру приложения
 * (например, 'yellow'), обязательно добавьте его сюда со значением `true`, иначе элементы
 * этого цвета по умолчанию станут невидимыми. Но добавлять новый цвет НЕ РЕКОМЕНДУЕТСЯ!
 */
export let visibleColors = {
    black: true,
    red: true,
    blue: true,
    green: true
};

import {render, updatePropertyWhileSimulation} from './render.js';
import {selectObject} from '../editor.js';

export function setSelectedId(id) {
    selectedId = id;
}
export function setDragTarget(target) {
    dragTarget = target;
}
export function setArcSourceId(id) {
    arcSourceId = id;
}
export function setCurrentMode(mode) {
    currentMode = mode;
}

export function getState() {
    return state;
}
export function getSimulation() {
    return simulation;
}
/**
 * @brief Полностью заменяет текущее состояние сети (используется при импорте).
 * @param {Object} newState - Новый объект состояния.
 */
export function replaceState(newState) {
    state = newState;
}


// --- УПРАВЛЕНИЕ РЕЖИМАМИ ---
/**
 * @brief Переключает глобальный режим работы приложения и обновляет интерфейс.
 * @param {string} mode - Целевой режим (например, 'simulation', 'place', 'select').
 *
 * @note **ИНСТРУКЦИЯ ПО РАСШИРЕНИЮ:**
 * Если вы добавляете новые кнопки управления симуляцией или новые интерактивные панели:
 * - Добавьте управление их видимостью (style.display) в конец этой функции.
 * - Обратите внимание на логику сброса/сохранения маркеров при переключении `simulation`.
 */
export function setMode(mode) {
    // Автоматический сброс к начальной разметке при выходе из симуляции
    if (currentMode === 'simulation' && mode !== 'simulation') {
        resetSimulation();
        simulation.isSimMode = false;
        selectObject(null);
    }

    // Вход в режим симуляции
    if (mode === 'simulation') {
        if (currentMode !== 'simulation') {
            state.places.forEach(p => p.initialTokens = p.tokens);
            simulation.isSimMode = true;
        }
        selectObject(null);
    }

    currentMode = mode;
    document.querySelectorAll('#left-menu button').forEach(b => b.classList.remove('active'));

    const btn = document.getElementById(`btn-${mode}`);
    if (btn) btn.classList.add('active');

    // Поддержка фокуса на симуляции
    const isSim = currentMode === 'simulation' || simulation.isSimMode;
    if (isSim && currentMode !== 'simulation') {
        currentMode = 'simulation';
        if (btn) btn.classList.remove('active');
        document.getElementById('btn-simulation').classList.add('active');
    }

    // Управление отображением элементов UI симуляции
    document.getElementById('btn-reset-sim').style.display = isSim ? 'block' : 'none';
    document.getElementById('btn-apply-sim').style.display = isSim ? 'block' : 'none';
    document.getElementById('btn-undo-redo-sim').style.display = isSim ? 'flex' : 'none';
    document.body.classList.toggle('mode-simulation', isSim);

    arcSourceId = null;
    render();
}


function createTokensSnapshot() {
    const snapshot = {};
    state.places.forEach(p => {
        snapshot[p.uuid] = p.tokens;
    });
    return snapshot;
}

function restoreTokensFromSnapshot(snapshot) {
    if (!snapshot) return;
    state.places.forEach(p => {
        if (snapshot[p.uuid] !== undefined) {
            p.tokens = snapshot[p.uuid];
        }
    });
    render();
    updatePropertyWhileSimulation();
}

/**
 * @brief Сбрасывает симуляцию к начальной разметке фишек и очищает историю.
 */
export function resetSimulation() {
    state.places.forEach(p => {
        if (p.initialTokens !== undefined) p.tokens = p.initialTokens;
    });
    simulation.history = [];
    simulation.redoHistory = [];
    render();
    updatePropertyWhileSimulation();
}

/**
 * @brief Фиксирует текущую разметку фишек как начальную (базовую).
 */
export function applySimulationState() {
    const confirmed = confirm(
        'Вы уверены, что хотите сделать текущее состояние маркеров начальной разметкой? Текущая история симуляции будет очищена.');

    if (confirmed) {
        state.places.forEach(p => {
            p.initialTokens = p.tokens;
        });
        simulation.history = [];
        simulation.redoHistory = [];
        render();
        updatePropertyWhileSimulation();
    }
}


/**
 * @brief Ищет узел (позицию или переход) по его UUID.
 * @param {string} id - UUID искомого узла.
 * @return {Object|undefined} Объект узла или undefined, если не найден.
 *
 * @note **ИНСТРУКЦИЯ ПО РАСШИРЕНИЮ:** Если вы внедрите составные/вложенные узлы
 * или макро-позиции, добавьте их поиск `.find()` через оператор `||` в возвращаемое значение.
 */
export function findNode(id) {
    return state.places.find(p => p.uuid === id) || state.transitions.find(t => t.uuid === id);
}

export function findComment(id) {
    return state.comments.find(c => c.uuid === id);
}


/**
 * @brief Проверяет, активен (разрешен) ли переход для срабатывания.
 * @param {string} transId - UUID проверяемого перехода.
 * @return {boolean} true, если переход может сработать, иначе false.
 *
 * @warning **КРИТИЧЕСКОЕ МЕСТО ДЛЯ ИЗМЕНЕНИЙ:**
 * Если вы добавляете:
 * 1. **Ингибиторные дуги (Inhibitor Arcs):** Нужно добавить проверку, что у ингибиторной дуги
 * количество фишек на входе СТРОГО МЕНЬШЕ веса дуги.
 * 2. **Информационные/кратные дуги:** Убедитесь, что логика фильтрации цветов `getColorDimClass`
 * корректно обрабатывает новые типы дуг.
 * 3. **Временные задержки (Timed Petri Nets):** Сюда потребуется внедрить проверку доступности
 * таймера перехода.
 */
export function isTransitionEnabled(transId) {
    // Выбираем только те входящие дуги, у которых источник (позиция) является видимым
    const inArcs = state.arcs.filter(a => {
        if (a.targetId !== transId) return false;
        if (getColorDimClass(a.color) === 'color-dimmed') return false;  // А также видима дуга
        const srcPlace = state.places.find(p => p.uuid === a.sourceId);
        if (!srcPlace || getColorDimClass(srcPlace.color) === 'color-dimmed') return false;
        return true;
    });
    if (inArcs.length === 0) return true;

    for (let arc of inArcs) {
        const srcPlace = state.places.find(p => p.uuid === arc.sourceId);
        if (!srcPlace || srcPlace.tokens < arc.weight) {
            return false;
        }
    }
    return true;
}

/**
 * @brief Выполняет срабатывание (производит активацию) перехода.
 * @param {string} transId - UUID срабатывающего перехода.
 *
 * @warning **КРИТИЧЕСКОЕ МЕСТО ДЛЯ ИЗМЕНЕНИЙ:**
 * Логика потребления и генерации фишек завязана строго на массивы `inArcs` и `outArcs`.
 * При добавлении новых типов дуг (например, двунаправленных или очищающих дуг Reset Arcs):
 * - Измените блоки списывания (inArcs.forEach) и начисления (outArcs.forEach) фишек.
 * - Убедитесь, что в `simulation.history` сохраняется корректный snapshot до изменения фишек.
 */
export function fireTransition(transId) {
    if (!isTransitionEnabled(transId)) return;
    const transition = state.transitions.find(t => t.uuid === transId);

    if (transition) {
        simulation.history.push({
            uuid: transId,
            name: transition.name,
            color: transition.color || 'black',
            tokensSnapshot: createTokensSnapshot()
        });

        simulation.redoHistory = [];
    }

    const inArcs = state.arcs.filter(a => a.targetId === transId);
    const outArcs = state.arcs.filter(a => a.sourceId === transId);

    inArcs.forEach(arc => {
        if (getColorDimClass(arc.color) !== 'color-dimmed') {
            const srcPlace = state.places.find(p => p.uuid === arc.sourceId);
            // Токены списываются, только если позиция существует и она видима
            if (srcPlace && getColorDimClass(srcPlace.color) !== 'color-dimmed') {
                srcPlace.tokens -= arc.weight;
            }
        }
    });

    outArcs.forEach(arc => {
        if (getColorDimClass(arc.color) !== 'color-dimmed') {
            const tgtPlace = state.places.find(p => p.uuid === arc.targetId);
            if (tgtPlace && getColorDimClass(tgtPlace.color) !== 'color-dimmed') {
                tgtPlace.tokens += arc.weight;
            }
        }
    });

    render();
    updatePropertyWhileSimulation();
}


/**
 * @brief Переключает видимость фильтра по цвету.
 * @param {string} color - Название цвета.
 */
export function toggleFilterColor(color) {
    if (visibleColors[color] !== undefined) {
        visibleColors[color] = document.getElementById(`chk-filter-${color}`).checked;
        render();
        updatePropertyWhileSimulation();
    }
}

export function getColorDimClass(elementColor) {
    const itemColor = elementColor || 'black';  // Если цвет не задан, считаем черным
    if (!visibleColors[itemColor]) {
        return 'color-dimmed';
    }
    return '';
}

/**
 * @brief Обновляет цвет любого объекта сети Петри по его ID.
 * @param {string} id - UUID объекта.
 * @param {string} newColor - Название нового цвета.
 * @note ИНСТРУКЦИЯ ПО РАСШИРЕНИЮ: Если вы добавили новый массив сущностей в state
 * (например, subnets), обязательно допишите его поиск через цепочку || state.subnets.find(...).
 */
export function updateElementColor(id, newColor) {
    const obj = state.places.find(p => p.uuid === id) ||
        state.transitions.find(t => t.uuid === id) || state.arcs.find(a => a.uuid === id) ||
        state.comments.find(c => c.uuid === id);

    if (obj) {
        obj.color = newColor;
        render();
    }
}


export function updateName(id, newName) {
    const node = findNode(id);
    if (node) {
        node.name = newName;
        render();
    }
}

export function updateTokens(id, value) {
    const place = state.places.find(p => p.uuid === id);
    if (place) {
        let tokens = Math.max(0, parseInt(value) || 0);
        if (simulation.isSimMode && place.tokens != tokens) {
            simulation.history.push({
                name: `Фишка "${place.name}"="${tokens}"`,
                color: 'white',
                tokensSnapshot: createTokensSnapshot()
            });
            simulation.redoHistory = [];
        }

        place.tokens = tokens;
        if (!simulation.isSimMode) {
            place.initialTokens = place.tokens;
        }
        render();
    }
}

export function updateArcWeight(id, value) {
    const arc = state.arcs.find(a => a.uuid === id);
    if (arc) {
        arc.weight = Math.max(1, parseInt(value) || 1);
        render();
    }
}

export function updateCommentText(id, newText) {
    const comment = findComment(id);
    if (comment) {
        comment.text = newText;
        render();
    }
}

/**
 * @brief Удаляет объект из структуры сети Петри по его ID.
 * @param {string} id - UUID удаляемого объекта.
 * @warning ОБЯЗАТЕЛЬНО К ИЗМЕНЕНИЮ ПРИ ДОБАВЛЕНИИ НОВЫХ СВЯЗЕЙ:
 * Если вы добавляете новые сущности (например, запрещающие дуги или привязанные скрипты к
 * позициям), вы должны добавить их очистку/фильтрацию в этой функции, чтобы не плодить "сиротские"
 * (dangling) связи. Пример: state.inhibitorArcs = state.inhibitorArcs.filter(a => a.sourceId !== id
 * && a.targetId !== id);
 */
export function deleteObject(id) {
    state.places = state.places.filter(p => p.uuid !== id);
    state.transitions = state.transitions.filter(t => t.uuid !== id);
    state.arcs = state.arcs.filter(a => a.uuid !== id && a.sourceId !== id && a.targetId !== id);
    state.comments = state.comments.filter(c => c.uuid !== id);
    selectObject(null);
    render();
}

/**
 * @brief Полностью очищает текущую сеть Петри, сбрасывая состояние в начальное.
 * @note ИНСТРУКЦИЯ ПО РАСШИРЕНИЮ: Если вы добавили новые глобальные массивы или счетчики в state,
 * не забудьте проинициализировать их пустыми значениями/дефолтами внутри этого метода.
 */
export function clearPetriNet() {
    const confirmed = confirm(
        'Вы уверены, что хотите полностью удалить текущую сеть Петри? Это действие нельзя отменить.');

    if (confirmed) {
        state = {places: [], transitions: [], arcs: [], comments: [], counters: {P: 1, T: 1, C: 1}};
        selectObject(null);
        setMode('select');
        render();
    }
}

/**
 * @brief Формирует чистую копию состояния сети, готовую к экспорту в JSON файл.
 * @return {Object} Глубокая копия объекта состояния с добавленной мета-информацией и правилами AI.
 * @warning ОБЯЗАТЕЛЬНО К ОБНОВЛЕНИЮ ПРИ ИЗМЕНЕНИИ АРХИТЕКТУРЫ:
 * Если вы меняете спецификацию полей объектов или добавляете новые типы элементов,
 * обязательно отредактируйте строковое поле cleanState.info. Текст в нем напрямую
 * инструктирует ИИ-помощников (LLM), в каком формате они должны генерировать JSON-файлы сетей
 * Петри. Также обновите маппинг в cleanState.counters для новых элементов.
 */
export function getCleanState() {
    const cleanState = structuredClone(getState());
    cleanState.places.forEach(p => {
        if (p.initialTokens !== undefined) {
            p.tokens = p.initialTokens;
        }
    });

    cleanState.info =
        `This is a PetriNetEditor export JSON file. Rules for AI assistants generated output:
    1. ID Rules: All elements (places, transitions, arcs) must have a unique 'uuid'. Places/transitions names must be spaces/text only, while 'uuid' must be lowercase snake_case based on the name.
    2. Node Schema: Places require 'uuid', 'name', 'x', 'y', 'tokens', and 'initialTokens'. Transitions require 'uuid', 'name', 'x', and 'y'. Comments require 'uuid', 'text', 'x', and 'y'.
    3. Arc Schema: Arcs require 'uuid', 'sourceId' (referencing source node uuid), 'targetId' (referencing target node uuid), 'weight' integer, and an optional 'color' string (supported values: 'black', 'red', 'blue', 'green').
    4. Network Counters: 'counters' must explicitly map to current arrays count: { 'P': places.length, 'T': transitions.length, 'C': comments.length }.`;
    return cleanState;
}


// --- ОПЕРАЦИЯ ОТКАТА И ВОЗВРАТА ОТКАТА (UNDO / REDO) ---
export function undoTransition() {
    if (simulation.history.length === 0) return;

    const snapshotCurrent = createTokensSnapshot();
    const lastAction = simulation.history.pop();
    restoreTokensFromSnapshot(lastAction.tokensSnapshot);

    simulation.redoHistory.push({
        uuid: lastAction.uuid,
        name: lastAction.name,
        color: lastAction.color,
        tokensSnapshot: snapshotCurrent
    });
    render();
    updatePropertyWhileSimulation();
}

export function redoTransition() {
    const nextAction = simulation.redoHistory.pop();
    if (!nextAction) return;

    simulation.history.push({
        uuid: nextAction.uuid,
        name: nextAction.name,
        color: nextAction.color,
        tokensSnapshot: createTokensSnapshot()
    });

    restoreTokensFromSnapshot(nextAction.tokensSnapshot);
    render();
    updatePropertyWhileSimulation();
}
