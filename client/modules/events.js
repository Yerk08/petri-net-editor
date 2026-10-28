/**
 * @file events.js
 * @brief Модуль обработки пользовательских событий ввода (мышь, тач-интерфейсы, Drag-and-Drop).
 * @details Реализует логику создания узлов по клику, перетаскивания элементов (Drag),
 *          перемещения (Panning) и масштабирования (Zooming) холста, создания дуг натяжением,
 *          а также интеграцию системного Drag-and-Drop для импорта файлов.
 */

import {selectObject} from '../editor.js';

import {render} from './render.js';
import {arcSourceId, currentMode, deleteObject, dragTarget, findComment, findNode, fireTransition, getAnalysisSession, getState, selectedId, setArcSourceId, setDragTarget, setSelectedId} from './state.js';
import {importFromFile} from './storage.js';


const svg = document.getElementById('petri-svg');

// --- ПЕРЕМЕННЫЕ ДЛЯ ПЕРЕМЕЩЕНИЯ ---
let startX = 0;         ///< Начальная координата мыши X для расчета перемещения холста
let startY = 0;         ///< Начальная координата мыши Y для расчета перемещения холста
let isPanning = false;  ///< Флаг активного процесса перетаскивания (перемещения) холста

// --- ПЕРЕМЕННЫЕ ДЛЯ МАСШТАБИРОВАНИЯ ---
let scale = 1;                 ///< Текущий коэффициент масштабирования холста
let translateX = 0;            ///< Смещение холста по оси X
let translateY = 0;            ///< Смещение холста по оси Y
let touchCenterX = 0;          ///< Точка фокуса X между двумя пальцами при жесте масштабирования
let touchCenterY = 0;          ///< Точка фокуса Y между двумя пальцами при жесте масштабирования
let initialTranslateX = 0;     ///< Исходное смещение X на момент начала масштабирования
let initialTranslateY = 0;     ///< Исходное смещение Y на момент начала масштабирования
let initialPinchDistance = 0;  ///< Стартовое расстояние между пальцами при масштабировании
let initialScale = 1;          ///< Исходный масштаб на момент начала масштабирования
let isPinching = false;        ///< Флаг активного процесса двухпальцевого масштабирования

// --- ОБРАБОТКА КЛИКОВ НА ХОЛСТЕ ---
/**
 * @brief Обработчик нажатия мыши/указателя на пустую область холста SVG.
 * @param {PointerEvent} e - Объект события указателя.
 *
 * @note **ФОРМУЛА ТРАНСФОРМАЦИИ КООРДИНАТ:**
 * При создании элементов на холсте (`place`, `transition`, `comment`), экранные координаты
 * клика `clientX/clientY` переводятся в истинные локальные координаты внутри SVG-пространства с
 * учетом текущего сдвига и зума по формуле: `x = (e.clientX - rect.left - translateX) / scale`.
 * Если вы измените архитектуру вложенности групп холста, обновите этот расчет координат.
 */
export function onCanvasMouseDown(e) {
    if (e.target !== svg) return;

    if (currentMode === 'select' || currentMode === 'simulation' || currentMode == 'analysis' ||
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

/**
 * @brief Перемещает рабочую область холста вслед за движением мыши.
 * @param {PointerEvent} e - Объект события указателя.
 */
export function onCanvasMouseMove(e) {
    if (!isPanning) return;
    if (e.cancelable) e.preventDefault();
    const container = document.getElementById('canvas-container');

    translateX = e.clientX - startX;
    translateY = e.clientY - startY;
    applyTransform();
}

/**
 * @brief Обработчик нажатия на интерактивный узел (позицию, переход или комментарий).
 * @param {PointerEvent} e - Объект события.
 * @param {string} id - UUID узла, на который нажали.
 *
 * @warning **БИЗНЕС-ЛОГИКА СОЗДАНИЯ ДУГ (СЕМАНТИЧЕСКИЕ ПРАВИЛА):**
 * Функция контролирует чередование типов узлов: дуга **не может** соединять позицию с позицией
 * или переход с переходом (`srcIsPlace !== tgtIsPlace`). Если дуга между узлами уже существует,
 * вместо создания новой инкрементируется кратность (вес) существующей `existingArc.weight++`.
 *
 * @warning **ЛОГИКА ЦВЕТОВЫХ ДУГ:**
 * При генерации новой дуги, ей автоматически присваивается цвет перехода, с которым она связана,
 * обеспечивая визуальное разделение подсетей.
 */
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

    if (currentMode === 'analysis') {
        if (!getAnalysisSession().isMarkingSetMode) return;
        const isPlace = getState().places.some(t => t.uuid === id);
        if (isPlace) {
            selectObject(id);  // Для работы с ресурсами и разметками для задания анализа
        }
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
}

/**
 * @brief Рассчитывает новые координаты узла в реальном времени при его перетаскивании.
 * @param {PointerEvent} e - Объект события движения указателя.
 */
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

/**
 * @brief Завершает процесс перетаскивания узла или натягивания дуги.
 * @param {PointerEvent} e - Объект события отпускания указателя.
 *
 * @warning **ПАРСИНГ DOM ДЛЯ МЕХАНИКИ НАТЯГИВАНИЯ (DROP TARGET):**
 * Для создания дуги жестом "натягивания линии" используется метод `document.elementFromPoint`.
 * Если вы измените название функции `onNodeMouseDown` в инлайн-строках SVG-рендерера (`render.js`),
 * этот парсер сломается и дуги перестанут натягиваться жестом мыши.
 */
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
        viewport.setAttribute(
            'transform', `translate(${translateX}, ${translateY}) scale(${scale})`);
    }
}

/**
• @brief Обработчик прокрутки колеса мыши для зумирования холста (Zoom).
• @details Масштабирование центрируется относительно текущего положения курсора мыши на экране.
• Ограничение масштаба в пределах от x0.2 до x5.0.
*/
svg.addEventListener('wheel', function(e) {
    // Проверяем, зажат ли Ctrl (или Cmd на Mac).
    // На тачпадах ноутбуков жест "щипок" тоже генерирует событие wheel с зажатым ctrlKey!
    if (e.ctrlKey || e.metaKey) {
        e.preventDefault();

        const zoomFactor = 1.1;
        const oldScale = scale;

        if (e.deltaY < 0) {
            scale = Math.min(5, scale * zoomFactor);  // Макс зум x5
        } else {
            scale = Math.max(0.2, scale / zoomFactor);  // Мин зум x0.2
        }

        const rect = svg.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        translateX = mouseX - (mouseX - translateX) * (scale / oldScale);
        translateY = mouseY - (mouseY - translateY) * (scale / oldScale);

        applyTransform();
    }
}, {passive: false});

/**
• @brief Инициализация жеста Pinch-to-Zoom для мобильных устройств.
*/
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
            e.touches[0].clientY - e.touches[1].clientY);
        initialScale = scale;

        // Фиксируем координаты центра между пальцами строго В МОМЕНТ КАСАНИЯ
        const rect = svg.getBoundingClientRect();
        touchCenterX = ((e.touches[0].clientX + e.touches[1].clientX) / 2) - rect.left;
        touchCenterY = ((e.touches[0].clientY + e.touches[1].clientY) / 2) - rect.top;

        initialTranslateX = translateX;
        initialTranslateY = translateY;
    }
}, {passive: false});

/**
• @brief Пересчет масштаба в реальном времени при движении двух пальцев.
*/
svg.addEventListener('touchmove', function(e) {
    if (isPinching && e.touches.length === 2) {
        e.preventDefault();

        const currentDistance = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY);

        if (initialPinchDistance > 0) {
            const pinchFactor = currentDistance / initialPinchDistance;
            scale = Math.max(0.2, Math.min(5, initialScale * pinchFactor));

            translateX = touchCenterX - (touchCenterX - initialTranslateX) * (scale / initialScale);
            translateY = touchCenterY - (touchCenterY - initialTranslateY) * (scale / initialScale);
            applyTransform();
        }
    }
}, {passive: false});

/**
• @brief Сброс флагов масштабирования при отпускании пальцев от экрана.
*/
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
