// --- КОРРЕКТНОЕ СОСТОЯНИЕ (STATE) ---
let state = {
    places: [],       // { uuid, name, x, y, tokens, initialTokens }
    transitions: [],  // { uuid, name, x, y }
    arcs: [],         // { uuid, sourceId, targetId, weight }
    comments: [],     // { uuid, text, x, y }
    counters: {P: 1, T: 1, C: 1}
};

let simulation = {
    isSimMode: false,  // Запоминаем статус запущенной симуляции
    history: [],       // История совершенных переходов в симуляции
    redoHistory: []    // Стек для возврата отката (Redo)
}

export let currentMode = 'select';  // select, simulation, place, transition, arc, token, comment
export let selectedId = null;
export let dragTarget = null;
export let arcSourceId = null;

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
export function replaceState(newState) {
    state = newState;
}


// --- УПРАВЛЕНИЕ РЕЖИМАМИ ---
export function setMode(mode) {
    // Вход в симуляцию: начальную разметку фиксируем только при первом входе.
    // Если вернуться из правки графа, текущая разметка и история сохраняются.
    if (mode === 'simulation') {
        if (!simulation.isSimMode) {
            state.places.forEach(p => p.initialTokens = p.tokens);
            simulation.isSimMode = true;
        }
        selectObject(null);
    }

    currentMode = mode;
    document.querySelectorAll('#left-menu button').forEach(b => b.classList.remove('active'));

    const btn = document.getElementById(`btn-${mode}`);
    if (btn) btn.classList.add('active');

    // Пока симуляция активна, ее панель остается доступной,
    // даже если выбран инструмент редактирования.
    const isSim = simulation.isSimMode || currentMode === 'simulation';

    document.getElementById('btn-reset-sim').style.display = isSim ? 'block' : 'none';
    document.getElementById('btn-apply-sim').style.display = isSim ? 'block' : 'none';
    document.getElementById('btn-undo-redo-sim').style.display = isSim ? 'flex' : 'none';
    document.body.classList.toggle('mode-simulation', isSim);
    document.body.classList.toggle('mode-sim-edit', isSim && currentMode !== 'simulation');

    arcSourceId = null;
    render();
}

// Полный выход из симуляции: вернуть начальную разметку и обычный редактор
export function exitSimulation() {
    simulation.isSimMode = false;
    currentMode = 'select';
    setMode('select');
    resetSimulation();
    selectObject(null);
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

export function resetSimulation() {
    state.places.forEach(p => {
        if (p.initialTokens !== undefined) p.tokens = p.initialTokens;
    });
    simulation.history = [];
    simulation.redoHistory = [];
    render();
    updatePropertyWhileSimulation();
}

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


export function findNode(id) {
    return state.places.find(p => p.uuid === id) || state.transitions.find(t => t.uuid === id);
}

export function findComment(id) {
    return state.comments.find(c => c.uuid === id);
}

// Проверка активности перехода
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

// Срабатывание перехода
export function fireTransition(transId, isRedoAction = false) {
    if (!isTransitionEnabled(transId)) return;
    const transition = state.transitions.find(t => t.uuid === transId);
    const snapshotBefore = createTokensSnapshot();

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

    if (transition) {
        if (!isRedoAction) {
            simulation.history.push({
                uuid: transId,
                name: transition.name,
                color: transition.color || 'black',
                tokensSnapshot: snapshotBefore
            });
            simulation.redoHistory = [];
        } else {
            simulation.history.push({
                uuid: transId,
                name: transition.name,
                color: transition.color || 'black',
                tokensSnapshot: snapshotBefore
            });
        }
    }

    render();
    updatePropertyWhileSimulation();
}


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


export function deleteObject(id) {
    state.places = state.places.filter(p => p.uuid !== id);
    state.transitions = state.transitions.filter(t => t.uuid !== id);
    state.arcs = state.arcs.filter(a => a.uuid !== id && a.sourceId !== id && a.targetId !== id);
    state.comments = state.comments.filter(c => c.uuid !== id);
    selectObject(null);
    render();
}

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
    if (simulation.redoHistory.length === 0) return;

    const nextAction = simulation.redoHistory.pop();
    if (nextAction.uuid) {
        fireTransition(nextAction.uuid, true);
    } else {
        simulation.history.push({
            name: nextAction.name,
            color: nextAction.color,
            tokensSnapshot: createTokensSnapshot()
        });
        restoreTokensFromSnapshot(nextAction.tokensSnapshot);
        render();
        updatePropertyWhileSimulation();
    }
}
