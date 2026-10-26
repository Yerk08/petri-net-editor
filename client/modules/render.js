import {selectObject} from '../editor.js';

import {arcSourceId, currentMode, findNode, getColorDimClass, getState, isTransitionEnabled, selectedId} from './state.js';
import {saveToLocalStorage} from './storage.js';

const svg = document.getElementById('petri-svg');
const nodesGroup = document.getElementById('nodes-group');
const arcsGroup = document.getElementById('arcs-group');


function renderMultilineSVGText(text, x, baseY, maxLength = 12, lineHeightEm = 1.2) {
    if (!text) return '';

    // Разбиваем строку на слова и собираем строки по лимиту длины
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';

    words.forEach(word => {
        if (word.length > maxLength) {
            if (currentLine) {
                lines.push(currentLine.trim());
                currentLine = '';
            }

            let i = 0;
            while (i < word.length) {
                lines.push(word.substring(i, i + maxLength));
                i += maxLength;
            }
        } else if ((currentLine + word).length > maxLength) {
            if (currentLine) lines.push(currentLine.trim());
            currentLine = word + ' ';
        } else {
            currentLine += word + ' ';
        }
    });

    if (currentLine) lines.push(currentLine.trim());
    const tspans = lines
                       .map((line, index) => {
                           const dyAttr = index > 0 ? 'dy="14"' : '';
                           return `<tspan x="${x}" ${dyAttr}>${line}</tspan>`;
                       })
                       .join('');

    // Вычисляем правильный сдвиг Y вверх (14px — базовая высота строки шрифта)
    const correctedY = baseY - ((lines.length - 1) * 14);
    return `<text x="${x}" y="${correctedY}" class="label" text-anchor="middle">${tspans}</text>`;
}


// --- ОТРИСОВКА В SVG ---
export function render() {
    nodesGroup.innerHTML = '';
    arcsGroup.innerHTML = '';

    saveToLocalStorage();

    // 1. Рисуем ДУГИ
    getState().arcs.forEach(arc => {
        const src = findNode(arc.sourceId);
        const tgt = findNode(arc.targetId);
        if (!src || !tgt) return;

        const hasReturn =
            getState().arcs.some(a => a.sourceId === arc.targetId && a.targetId === arc.sourceId);

        // Базовые геометрические расчеты расстояния между нодами
        const midX = (src.x + tgt.x) / 2;
        const midY = (src.y + tgt.y) / 2;
        const dx = tgt.x - src.x;
        const dy = tgt.y - src.y;
        const len = Math.hypot(dx, dy) || 1;

        // Расчет опорной точки Q кривой Безье для изгиба дуги
        const curveIntensity = hasReturn ? 35 : 12;
        const qx = midX - (dy / len) * curveIntensity;
        const qy = midY + (dx / len) * curveIntensity;

        // Вычисляем вектор касательной и направление входа в цель
        const tangentX = tgt.x - qx;
        const tangentY = tgt.y - qy;
        const tangentLen = Math.hypot(tangentX, tangentY) || 1;
        const dirX = tangentX / tangentLen;
        const dirY = tangentY / tangentLen;

        // Размеры стрелки и базовый отступ для круглых позиций
        const arrowLength = 10;
        let offset = 20;
        const isTargetTransition = getState().transitions.some(t => t.uuid === tgt.uuid);

        // Расчет точки пересечения дуги с контуром прямоугольника перехода
        if (isTargetTransition) {
            const halfWidth = 10;
            const halfHeight = 25;
            const tX = dirX !== 0 ? Math.abs(halfWidth / dirX) : Infinity;
            const tY = dirY !== 0 ? Math.abs(halfHeight / dirY) : Infinity;
            offset = Math.min(tX, tY);
        }

        const endX = tgt.x - dirX * offset;
        const endY = tgt.y - dirY * offset;

        // Подготовка данных пути кривой Безье и состояния выбора
        const pathData = `M ${src.x} ${src.y} Q ${qx} ${qy} ${endX} ${endY}`;
        const isSelected = selectedId === arc.uuid;
        const pointerEvents = currentMode === 'simulation' ? 'style="pointer-events: none;"' : '';

        const dimClass = getColorDimClass(arc.color);
        const arcColor = arc.color || 'black';
        const strokeWidth = isSelected ? '3.5px' : '2px';
        const arrowWidth = 5;

        // Геометрический расчет координат треугольника стрелки (ушек)
        const baseX = endX - dirX * arrowLength;
        const baseY = endY - dirY * arrowLength;
        const leftX = baseX - dirY * arrowWidth;
        const leftY = baseY + dirX * arrowWidth;
        const rightX = baseX + dirY * arrowWidth;
        const rightY = baseY - dirX * arrowWidth;
        const arrowPoints = `${endX},${endY} ${leftX},${leftY} ${rightX},${rightY}`;

        // Формирование SVG-разметки для невидимого ховера, самой дуги и стрелки
        const pathMarkup = `
<path d="${pathData}" class="arc-hover ${dimClass}" ${pointerEvents} onpointerdown="selectObject('${
            arc.uuid}'); event.stopPropagation();" style="fill: none;"/>
<path d="${pathData}" class="arc ${isSelected ? 'selected' : ''} ${dimClass}" id="${
            arc.uuid}" style="stroke: ${arcColor}; stroke-width: ${strokeWidth}; fill: none;"/>
<polygon points="${arrowPoints}" class="${dimClass}" style="fill: ${arcColor};" />
`;
        arcsGroup.insertAdjacentHTML('beforeend', pathMarkup);

        // Отрисовка веса дуги (количества), если он больше 1
        if (arc.weight > 1) {
            const tx = (midX + qx) / 2;
            const ty = (midY + qy) / 2 - 5;
            arcsGroup.insertAdjacentHTML(
                'beforeend',
                `<text x="${tx}" y="${ty}" class="arc-weight ${dimClass}">${arc.weight}</text>`);
        }
    });

    // 2. Рисуем ПОЗИЦИИ
    getState().places.forEach(p => {
        const isSelected = selectedId === p.uuid;
        const isArcSource = arcSourceId === p.uuid;

        let tokensMarkup = '';
        if (p.tokens === 1) {
            tokensMarkup = `<circle cx="${p.x}" cy="${p.y}" r="5" class="token"/>`;
        } else if (p.tokens > 1) {
            tokensMarkup = `<text x="${p.x}" y="${p.y + 4}" class="token label">${p.tokens}</text>`;
        }

        const dimClass = getColorDimClass(p.color);
        const pColor = p.color || 'black';

        // Генерируем многострочный текст с базовой точки y = p.y - 25
        const textMarkup = renderMultilineSVGText(p.name, p.x, p.y - 25);

        const markup = `
    <g class="${dimClass}" onpointerdown="onNodeMouseDown(event, '${p.uuid}')">
        <circle cx="${p.x}" cy="${p.y}" r="20" class="place ${isSelected ? 'selected' : ''} ${
            isArcSource ? 'source-selected' : ''}" style="stroke: ${pColor};"/>
        ${tokensMarkup}
        <!-- Добавляем инлайн-стиль цвета к сгенерированному тексту -->
        <g style="fill: ${pColor};">${textMarkup}</g>
    </g>
`;
        nodesGroup.insertAdjacentHTML('beforeend', markup);
    });

    // 3. Рисуем ПЕРЕХОДЫ
    getState().transitions.forEach(t => {
        const isSelected = selectedId === t.uuid;
        const isArcSource = arcSourceId === t.uuid;
        const enabledClass =
            (currentMode === 'simulation' && isTransitionEnabled(t.uuid)) ? 'enabled' : '';
        const dimClass = getColorDimClass(t.color);
        const tColor = t.color || 'black';

        // Генерируем многострочный текст с базовой точки y = t.y - 32
        const textMarkup = renderMultilineSVGText(t.name, t.x, t.y - 32);

        const markup = `
    <g class="${dimClass}" onpointerdown="onNodeMouseDown(event, '${t.uuid}')">
        <rect x="${t.x - 10}" y="${t.y - 25}" width="20" height="50" class="transition ${
            isSelected ? 'selected' : ''} ${enabledClass} ${isArcSource ? 'source-selected' : ''}" 
            style="stroke: ${tColor}; ${currentMode !== 'simulation' ? 'fill: white;' : ''}"/>
        <g style="fill: ${tColor};">${textMarkup}</g>
    </g>
`;
        nodesGroup.insertAdjacentHTML('beforeend', markup);
    });


    // 4. Рисуем КОММЕНТАРИИ
    getState().comments.forEach(c => {
        const isSelected = selectedId === c.uuid;
        const dimClass = getColorDimClass(c.color);
        const cColor = c.color || 'black';

        const isEmpty = !c.text || c.text.trim() === '';
        const displayText = isEmpty ? 'Пустой комментарий' : c.text;

        const safeText =
            displayText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const tempId = `comment-div-${c.uuid}`;
        const markup = `
<g class="comment-g ${isSelected ? 'selected' : ''} ${isEmpty ? 'is-empty' : ''} ${dimClass}"
    onpointerdown="onNodeMouseDown(event, '${c.uuid}')">
    <!-- Изначально ставим заведомо большую или минимальную высоту, её мы скорректируем ниже -->
    <rect x="${c.x - 100}" y="${c.y - 15}" width="200" height="30" class="comment-click-handler"/>
    <foreignObject x="${c.x - 100}" y="${
            c.y - 15}" width="200" height="9999" class="comment-foreign-object">
        <div id="${tempId}" class="comment-box-html" style="color: ${cColor}; height: auto;">${
            safeText}</div>
    </foreignObject>
</g>
`;
        nodesGroup.insertAdjacentHTML('beforeend', markup);
        const renderedDiv = document.getElementById(tempId);
        if (renderedDiv) {
            const realHeight = Math.max(30, renderedDiv.offsetHeight + 8);
            const parentGroup = renderedDiv.closest('.comment-g');
            const rect = parentGroup.querySelector('.comment-click-handler');
            const foreignObject = parentGroup.querySelector('.comment-foreign-object');
            rect.setAttribute('height', realHeight);
            foreignObject.setAttribute('height', realHeight);
            renderedDiv.removeAttribute('id');
        }
    });
}

export function updatePropertyWhileSimulation() {
    if (selectedId) {  // Только для обновления количества фишек если выбрана позиция при
                       // симуляции
        const selectedPlace = getState().places.find(p => p.uuid === selectedId);
        const tokensInput = document.getElementById('property-tokens-input');
        if (selectedPlace && tokensInput) {
            tokensInput.value = selectedPlace.tokens;
        }
    } else if (currentMode === 'simulation') {  // Для обновления переходов при срабатывании в
                                                // симуляции
        selectObject(null);
    }
}