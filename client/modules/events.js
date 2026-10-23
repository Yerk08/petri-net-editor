import {selectObject} from '../editor.js';

import {render, updatePropertyWhileSimulation} from './render.js';
import {arcSourceId, currentMode, deleteObject, dragTarget, findComment, findNode, fireTransition, getState, selectedId, setArcSourceId, setDragTarget, setSelectedId} from './state.js';
import {importFromFile} from './storage.js';


const svg = document.getElementById('petri-svg');

// --- ПЕРЕМЕННЫЕ ДЛЯ ПЕРЕМЕЩЕНИЯ ---
let startX = 0, startY = 0;
let isPanning = false;

// --- ПЕРЕМЕННЫЕ ДЛЯ МАСШТАБИРОВАНИЯ ---
let scale = 1;
let translateX = 0;
let translateY = 0;
let touchCenterX = 0;
let touchCenterY = 0;
let initialTranslateX = 0;
let initialTranslateY = 0;
let initialPinchDistance = 0; // Mobile pinch-to-Zoom
let initialScale = 1;
let isPinching = false;

// --- ОБРАБОТКА КЛИКОВ НА ХОЛСТЕ ---
export function onCanvasMouseDown(e) {
    if (e.target !== svg) return;

    if (currentMode === 'select' || currentMode === 'simulation' ||
        (currentMode === 'arc' || currentMode == 'token')) {
        isPanning = true;
        startX = e.clientX - translateX;
        startY = e.clientY - translateY;

        window.addEventListener('pointermove', onCanvasMouseMove);
        window.addEventListener('pointerup', () => {
            isPanning = false;
            window.removeEventListener('pointermove', onCanvasMouseMove);
        });
        return;
    }

    const rect = svg.getBoundingClientRect();
    const x = (e.clientX - rect.left - translateX) / scale;
    const y = (e.clientY - rect.top - translateY) / scale;

    if (currentMode === 'place') {
        const name = `P${getState().counters.P++}`;
        const newPlace = {uuid: name, name, x, y, tokens: 0, initialTokens: 0};
        getState().places.push(newPlace);
        selectObject(newPlace.uuid);
    } else if (currentMode === 'transition') {
        const name = `T${getState().counters.T++}`;
        const newTrans = {uuid: name, name, x, y};
        getState().transitions.push(newTrans);
        selectObject(newTrans.uuid);
    } else if (currentMode === 'comment') {
        const id = `C${getState().counters.C++}`;
        const newComment = {uuid: id, text: '', x, y};
        if (!getState().comments) getState().comments = [];
        getState().comments.push(newComment);
        selectObject(newComment.uuid);
    } else {
        selectObject(null);
    }
    render();
}

export function onCanvasMouseMove(e) {
    if (!isPanning) return;
    if (e.cancelable) e.preventDefault();
    const container = document.getElementById('canvas-container');

    translateX = e.clientX - startX;
    translateY = e.clientY - startY;
    applyTransform();
}

export function onNodeMouseDown(e, id) {
    if (e.pointerType === 'touch' && (!e.isPrimary || isPinching)) {
        onNodeMouseUp(e);
        return;
    }
    e.stopPropagation();

    if (currentMode === 'simulation') {
        const isTrans = getState().transitions.some(t => t.uuid === id);
        const isPlace = getState().places.some(t => t.uuid === id);
        if (isTrans)
            fireTransition(id);
        else if (isPlace)
            selectObject(id);  // Для работы с ресурсами и разметками во время симуляции
        return;
    }

    if (currentMode === 'select' ||
        (currentMode === 'place' || currentMode === 'transition' ||
         currentMode === 'comment')) {  // Для перетаскивания при создании элементов
        const node = findNode(id) || findComment(id);
        setDragTarget({id: id, node: node})
        selectObject(id);

        window.addEventListener('pointermove', onNodeMouseMove);
        window.addEventListener('pointerup', onNodeMouseUp);

    } else if (currentMode === 'arc') {
        if (findComment(id)) return;
        if (!arcSourceId) {
            setArcSourceId(id);
            window.addEventListener('pointerup', onNodeMouseUp);
        } else {
            const srcIsPlace = getState().places.some(p => p.uuid === arcSourceId);
            const tgtIsPlace = getState().places.some(p => p.uuid === id);

            if (srcIsPlace !== tgtIsPlace) {
                const existingArc = getState().arcs.find(
                    arc => arc.sourceId === arcSourceId && arc.targetId === id);

                if (existingArc) {
                    existingArc.weight = (existingArc.weight || 1) + 1;
                    selectObject(existingArc.uuid);
                } else {
                    const transitionId = srcIsPlace ? id : arcSourceId;
                    const transition = getState().transitions?.find(t => t.uuid === transitionId);
                    const transitionColor = transition?.color
                    const newArc = {
                        uuid: `${arcSourceId}-${id}`,
                        sourceId: arcSourceId,
                        targetId: id,
                        weight: 1,
                        ...(transitionColor && {color: transitionColor})
                    };
                    getState().arcs.push(newArc);
                    selectObject(newArc.uuid);
                }

                setArcSourceId(null);
            } else {
                alert('Дуга должна соединять Позицию и Переход (или наоборот)!');
                setArcSourceId(null);
            }
        }
    } else if (currentMode === 'token') {
        const place = getState().places.find(p => p.uuid === id);
        if (place) {
            place.tokens++;
            place.initialTokens = place.tokens;
        }
    }
    render();
    // Если инспектор открыт на этой позиции, синхронизируем счетчик фишек
    updatePropertyWhileSimulation();
}

export function onNodeMouseMove(e) {
    if (e.pointerType === 'touch' && (!e.isPrimary || isPinching)) {
        onNodeMouseUp(e);
        return;
    }
    if (!dragTarget || !dragTarget.node) return;
    
    const rect = svg.getBoundingClientRect();
    dragTarget.node.x = (e.clientX - rect.left - translateX) / scale;
    dragTarget.node.y = (e.clientY - rect.top - translateY) / scale;
    render();
}

export function onNodeMouseUp(e) {
    if (e && currentMode === 'arc' && arcSourceId) {  // Размещение дуги "натягиванием"
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const targetElement = el?.closest('[onpointerdown]');
        const pointerDownAttr = targetElement?.getAttribute('onpointerdown');

        const match = pointerDownAttr?.match(/onNodeMouseDown\(event,\s*'([^']+)'\)/);
        const targetId = match ? match[1] : null;

        if (targetId && targetId !== arcSourceId) {
            onNodeMouseDown(e, targetId);
        }
        // Ничего не делаем, если отпустили в пустоту
    }

    setDragTarget(null);
    window.removeEventListener('pointermove', onNodeMouseMove);
    window.removeEventListener('pointerup', onNodeMouseUp);
}



// Масштабирование холста
function applyTransform() {
    const viewport = document.getElementById('viewport') || svg.firstElementChild;
    if (viewport) {
        viewport.setAttribute('transform', `translate(${translateX}, ${translateY}) scale(${scale})`);
    }
}

// Вписать все элементы сети в видимую область холста
export function fitToView(padding = 48) {
    const state = getState();
    const nodes = [
        ...(state.places || []),
        ...(state.transitions || [])
    ];

    if (!nodes.length) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    const include = (x1, y1, x2, y2) => {
        minX = Math.min(minX, x1);
        minY = Math.min(minY, y1);
        maxX = Math.max(maxX, x2);
        maxY = Math.max(maxY, y2);
    };

    (state.places || []).forEach(p => include(p.x - 26, p.y - 62, p.x + 26, p.y + 30));
    (state.transitions || []).forEach(t => include(t.x - 20, t.y - 62, t.x + 20, t.y + 34));

    // Запас под изгибы дуг и подписи. Комментарии не учитываем,
    // чтобы один далеко отставленный текст не уменьшал всю схему.
    minX -= 12;
    minY -= 12;
    maxX += 12;
    maxY += 12;

    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const availableW = Math.max(80, rect.width - padding * 2);
    const availableH = Math.max(80, rect.height - padding * 2);
    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);

    scale = Math.max(0.2, Math.min(1.6, Math.min(availableW / contentW, availableH / contentH)));
    translateX = (rect.width - (minX + maxX) * scale) / 2;
    translateY = (rect.height - (minY + maxY) * scale) / 2;

    applyTransform();
}

svg.addEventListener('wheel', function(e) {
    // Проверяем, зажат ли Ctrl (или Cmd на Mac). 
    // На тачпадах ноутбуков жест "щипок" тоже генерирует событие wheel с зажатым ctrlKey!
    if (e.ctrlKey || e.metaKey) {
        e.preventDefault();

        const zoomFactor = 1.1;
        const oldScale = scale;

        if (e.deltaY < 0) {
            scale = Math.min(5, scale * zoomFactor); // Макс зум x5
        } else {
            scale = Math.max(0.2, scale / zoomFactor); // Мин зум x0.2
        }

        const rect = svg.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        translateX = mouseX - (mouseX - translateX) * (scale / oldScale);
        translateY = mouseY - (mouseY - translateY) * (scale / oldScale);

        applyTransform();
    }
}, { passive: false });

let touchStartPoints = [];
svg.addEventListener('touchstart', function(e) {
    if (e.touches.length === 2) {
        setDragTarget(null);
        window.removeEventListener('pointermove', onNodeMouseMove);
        window.removeEventListener('pointerup', onNodeMouseUp);

        isPinching = true;
        e.preventDefault(); 

        initialPinchDistance = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        initialScale = scale;

        // Фиксируем координаты центра между пальцами строго В МОМЕНТ КАСАНИЯ
        const rect = svg.getBoundingClientRect();
        touchCenterX = ((e.touches[0].clientX + e.touches[1].clientX) / 2) - rect.left;
        touchCenterY = ((e.touches[0].clientY + e.touches[1].clientY) / 2) - rect.top;

        initialTranslateX = translateX;
        initialTranslateY = translateY;
    }
}, { passive: false });

svg.addEventListener('touchmove', function(e) {
    if (isPinching && e.touches.length === 2) {
        e.preventDefault();

        const currentDistance = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );

        if (initialPinchDistance > 0) {
            const pinchFactor = currentDistance / initialPinchDistance;
            scale = Math.max(0.2, Math.min(5, initialScale * pinchFactor));

            translateX = touchCenterX - (touchCenterX - initialTranslateX) * (scale / initialScale);
            translateY = touchCenterY - (touchCenterY - initialTranslateY) * (scale / initialScale);
            applyTransform();
        }
    }
}, { passive: false });

svg.addEventListener('touchend', function(e) {
    if (e.touches.length < 2) {
        isPinching = false;
        initialPinchDistance = 0;
    }
});



// --- ИМПОРТ DRAG-and-DROP ---
let dragCounter = 0;
document.body.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragCounter++;
    if (dragCounter === 1) {
        document.body.classList.add('drag-active');
    }
});

document.body.addEventListener('dragover', (event) => {
    event.preventDefault();
});

document.body.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
        document.body.classList.remove('drag-active');
    }
});

document.body.addEventListener('drop', (event) => {
    dragCounter = 0;
    document.body.classList.remove('drag-active');
    importFromFile(event);
});
