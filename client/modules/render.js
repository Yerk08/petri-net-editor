/**
 * @file render.js
 * @brief Модуль графического рендеринга сети Петри в формат SVG.
 * @details Производит полную очистку холста и поочередную отрисовку (генерацию SVG-разметки)
 *          всех дуг, позиций, переходов и текстовых комментариев на основе текущего состояния.
 */

import {selectObject} from '../editor.js';

import {arcSourceId, currentMode, findNode, getColorDimClass, getState, isTransitionEnabled, selectedId, getAnalysisSession} from './state.js';
import {saveToLocalStorage} from './storage.js';

const svg = document.getElementById('petri-svg');
const nodesGroup = document.getElementById('nodes-group');
const arcsGroup = document.getElementById('arcs-group');

/**
 * @brief Формирует многострочный блок SVG-текста с автоматическим переносом слов по ограничению
 * длины.
 * @param {string} text - Исходный текст для рендеринга.
 * @param {number} x - Базовая координата X центра текста.
 * @param {number} baseY - Базовая координата Y нижней/опорной линии текста.
 * @param {number} [maxLength=12] - Максимальное количество символов в одной строке.
 * @param {number} [lineHeightEm=1.2] - Коэффициент высоты строки (14px).
 * @return {string} Валидная SVG-строка, содержащая тег `<text>` со вложенными `<tspan>`.
 */
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
/**
 * @brief Главная функция отрисовки графического интерфейса сети Петри.
 * @details Выполняет полную перерисовку (деструктивный innerHTML рендеринг) элементов.
 *          Вызывается при любом изменении состояния (перетаскивание, добавление, симуляция).
 *
 * @warning **МЕСТО ПОВЫШЕННОЙ ВЫЧИСЛИТЕЛЬНОЙ СЛОЖНОСТИ (ОТРИСОВКА ДУГ):**
 * Секция отрисовки дуг производит расчет изгиба кривых Безье первого порядка (`Q`).
 * - `curveIntensity`: Если существуют встречные дуги (туда и обратно), интенсивность изгиба
 * увеличивается до 35, чтобы линии не накладывались друг на друга.
 * - **Расчет пересечения контура перехода:** Прямоугольный переход требует вычисления пересечения
 * вектора дуги с границами отрезков `halfWidth=10` и `halfHeight=25`. При изменении размеров
 * переходов в CSS обязательно синхронизируйте эти константы здесь, иначе стрелки дуг будут
 * врезаться в прямоугольники или висеть в воздухе.
 *
 * @warning **ЛОГИКА HTML-КОММЕНТАРИЕВ (FOREIGN OBJECT):**
 * Для рендеринга комментариев используется тег `<foreignObject>`, внутрь которого инжектируется
 * HTML-блок `div`. Поскольку SVG не умеет автоматически рассчитывать высоту (`height: auto`) для
 * HTML элементов, в конце функции применяется **двухпроходный хак**: комментарий рендерится с
 * высотой 9999, затем через `renderedDiv.offsetHeight` замеряется его реальная высота в браузере, и
 * атрибуты `height` для `rect` и `foreignObject` принудительно перевыставляются под реальный размер
 * текста.
 */
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

        const session = getAnalysisSession();
        const markingClass = (session.isAnalysisMode && session.isMarkingSetMode) ? 'marking-enabled' : '';

        const markup = `
    <g class="${dimClass}" onpointerdown="onNodeMouseDown(event, '${p.uuid}')">
        <circle cx="${p.x}" cy="${p.y}" r="20" class="place ${isSelected ? 'selected' : ''} ${
            isArcSource ? 'source-selected' : ''} ${markingClass}" style="stroke: ${pColor};"/>
        ${tokensMarkup}
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

/**
 * @brief Обновление свойств UI во время активной фазы симуляции.
 * @details Он синхронизирует значение инпута фишек в панели свойств, если выбрана позиция,
 * либо сбрасывает выбор объекта при кликах по переходам.
 */
export function updatePropertyWhileSimulation() {
    if (selectedId) {
        // Только для обновления количества фишек если выбрана позиция при симуляции
        const selectedPlace = getState().places.find(p => p.uuid === selectedId);
        const tokensInput = document.getElementById('property-tokens-input');
        if (selectedPlace && tokensInput) {
            tokensInput.value = selectedPlace.tokens;
        }
    } else if (currentMode === 'simulation') {
        // Для обновления переходов при срабатывании в симуляции
        selectObject(null);
    }
}


/**
 * @brief Динамически генерирует и отрисовывает параметры запроса анализа на основе полученной схемы.
 * @param {Array} serverSchema - Массив объектов описания полей (схема), полученный от сервера.
 * @param {Object} currentAnalysis - Текущее состояние (стейт) подсистемы анализа с сохраненными параметрами.
 */
export function renderDynamicFields(serverSchema, currentAnalysis) {
    const dynamicContainer = document.getElementById('analysis-dynamic-container');
    if (!dynamicContainer || !serverSchema || !Array.isArray(serverSchema)) return;

    let html = '';
    serverSchema.forEach(field => {
        const fieldId = field.id;
        const fieldName = field.name;
        const fieldType = field.type;
        const savedValue = currentAnalysis.params?.[fieldId] ?? '';

        html += `<div class="property-group">`;
        if (fieldType !== 'description') {
            html += `<label><b>${fieldName}:</b></label>`;
        }

        if (fieldType === 'list') {
            html += `<div class="param-group-list" id="param-group-${fieldId}">`;
            if (Array.isArray(field.options)) {
                field.options.forEach(opt => {
                    const isChecked = Array.isArray(savedValue) && savedValue.includes(opt.value) ?
                        'checked' :
                        '';
                    html += `
                            <label>
                                <input type="checkbox" value="${opt.value}" ${isChecked} 
                                    onchange="window.updateAnalysisParamGroup('${fieldId}', '${
                        opt.value}', this.checked)">
                                ${opt.name}
                            </label>
                        `;
                });
            }
            html += `</div>`;

        } else if (fieldType === 'color_filter') {
            const session = getAnalysisSession();
            const isConfiguringThis = (session.selectedElement === fieldId);
            html += `
                    <button type="button" class="btn-analysis-color-trigger" 
                        onclick="window.toggleAnalysisColorCapture('${fieldId}')">
                        ${isConfiguringThis ? '🛑 Задать цвета' : '🎨 Цвета сети'}
                    </button>
                `;
            if (!isConfiguringThis && savedValue.length > 0) {
                const colorEmojis = {black: '⚫', red: '🔴', blue: '🔵', green: '🟢'};
                const symbolsHtml =
                    savedValue.map(color => colorEmojis[color] || '').filter(Boolean).join('');
                html += `
                        <div class="active-colors-preview">
                            <kbd>Цвета:${symbolsHtml}</kbd>
                        </div>
                    `;
            }
            html += `</div>`;

        } else if (fieldType === 'marking_filter') {
            const session = getAnalysisSession();
            const isConfiguringThis =
                (session.selectedElement === fieldId && session.isMarkingSetMode);
            html += `<div class="marking-filter-box">`;
            html += `
                    <button type="button" class="btn-analysis-marking-trigger ${
                isConfiguringThis ? 'active-stop' : ''}" 
                        onclick="window.toggleAnalysisMarkingCapture('${fieldId}')">
                        ${isConfiguringThis ? '🛑 Задать разметку' : '🎯 Разметка'}
                    </button>
                `;

            if (isConfiguringThis) {
                html += `
                        <div class="marking-actions-row">
                            <button type="button" onclick="window.resetAnalysisMarkingToInitial('${
                    fieldId}')">🔄 Из изначальной</button>
                            <button type="button" onclick="window.clearAnalysisMarkingToEmpty('${
                    fieldId}')">🗑️ Сделать пустым</button>
                        </div>
                    `;
            } else {
                const totalTokens = savedValue && typeof savedValue === 'object' ?
                    Object.values(savedValue).reduce((a, b) => a + (parseInt(b) || 0), 0) :
                    0;
                html += `
                        <div class="active-marking-preview" style="${
                    totalTokens > 0 ? '' : 'display: none;'}">
                            <kbd>Фишек: <span class="tokens-count-value">${totalTokens}</span></kbd>
                        </div>
                    `;
            }
            html += `</div>`;

        } else if (fieldType === 'description') {
            html += `<p>ℹ️ ${fieldName}</p>`;

        } else if (fieldType === 'dict') {
            html += `<select id="param-field-${
                fieldId}" onchange="window.updateAnalysisParamValue('${fieldId}', this.value)">`;
            html += `<option value="">-- Выберите --</option>`;
            if (field.options && typeof field.options === 'object') {
                Object.entries(field.options).forEach(([k, v]) => {
                    const isSel = String(savedValue) === String(k) ? 'selected' : '';
                    html += `<option value="${k}" ${isSel}>${v}</option>`;
                });
            }
            html += `</select>`;

        } else if (fieldType === 'number') {
            html += `<input type="number" id="param-field-${fieldId}" value="${
                savedValue}" oninput="window.updateAnalysisParamValue('${fieldId}', this.value)">`;

        } else {
            html += `<input type="text" id="param-field-${fieldId}" value="${
                savedValue}" oninput="window.updateAnalysisParamValue('${fieldId}', this.value)">`;
        }

        html += `</div>`;
    });

    dynamicContainer.innerHTML = html;
};