/**
 * @file editor.js
 * @brief Главный координационный модуль и точка входа графического редактора сетей Петри.
 * @details Настраивает глобальное пространство имен для inline HTML-событий, управляет
 *          интерактивной панелью свойств элементов и координирует инициализацию приложения.
 */

import {loadAnalysisTypes, onServerUrlInput, toggleAnalysisColorCapture, updateAnalysisParamGroup, updateAnalysisParamValue, updateAnalysisType, updateConnectionIndicator, toggleAnalysisMarkingCapture, resetAnalysisMarkingToInitial, clearAnalysisMarkingToEmpty} from './modules/analysis.js';
import {onCanvasMouseDown, onCanvasMouseMove, onNodeMouseDown, onNodeMouseMove, onNodeMouseUp} from './modules/events.js';
import {initHotKeys} from './modules/hotkeys.js';
import {render} from './modules/render.js';
import {applySimulationState, clearPetriNet, currentMode, deleteObject, findComment, findNode, fireTransition, getAnalysisSession, getAnalysisState, getSimulation, getState, redoTransition, resetSimulation, selectedId, setMode, setSelectedId, toggleFilterColor, undoTransition, updateArcWeight, updateCommentText, updateElementColor, updateName, updateTokens} from './modules/state.js';
import {exportToFile, exportToPDF, exportToSVG, importFromFile, loadFromLocalStorage} from './modules/storage.js';
import {loadToggleTheme, toggleTheme} from './modules/theme.js';



// --- ПАНЕЛЬ СВОЙСТВ (СПРАВА) ---
/**
 * @brief Выбирает объект сети Петри для редактирования и генерирует форму свойств в правой панели.
 * @details Если `id` равен `null` или не передан, панель отображает либо историю шагов симуляции
 *          (если включен режим симуляции), либо дефолтную заглушку «Выберите объект».
 *          Если `id` валиден, функция динамически строит HTML-форму для изменения полей (имя,
 * фишки, вес, цвет).
 * @param {string|null} id - Уникальный идентификатор (UUID) выбранного элемента (позиции, перехода,
 *     дуги, комментария) или null.
 *
 * @note **ИНСТРУКЦИЯ ПО РАСШИРЕНИЮ:** Если вы добавляете новые свойства элементам (например,
 * пропускная способность позиции или тип перевода):
 * 1. Найдите блок соответствующего элемента (например, `if (place)`).
 * 2. Добавьте новое поле ввода `<input>` в строку шаблона.
 * 3. Назначьте обработчик события (`oninput` или `onchange`), вызывающий функцию изменения из
 * `state.js`.
 */
export function selectObject(id) {
    setSelectedId(id);
    render();

    const panel = document.getElementById('properties-panel');
    if (!id) {
        // Если объект не выбран, но запущена симуляция — выводим историю переходов
        if (getSimulation().isSimMode) {
            const simulation = getSimulation();

            const filteredHistory = simulation.history.filter(item => {
                const itemColor = item.color || 'black';
                const chk = document.getElementById(`chk-filter-${itemColor}`);
                return chk ? chk.checked : true;
            });

            if (filteredHistory.length === 0) {
                panel.innerHTML = `
                    <div class="property-group"><h3>История симуляции</h3></div>
                    <p style="color:#888;">История пуста или отфильтрована по цвету.</p>
                `;
                return;
            }

            const colorEmojis = {black: '⚫', red: '🔴', blue: '🔵', green: '🟢', white: '⚪'};

            let historyHtml = `
                <div class="property-group"><h3>Совершенные переходы</h3></div>
                <div>
                    <ol style="padding-left: 20px; margin: 0;">
            `;

            filteredHistory.forEach(item => {
                const emoji = colorEmojis[item.color] || '⚫';
                historyHtml += `
                    <li>
                        <span>${emoji}</span> 
                        <b>${item.name}</b>
                    </li>
                `;
            });

            historyHtml += `
                    </ol>
                </div>
                <p style="font-size: 0.85em; color:#888;">Всего шагов: ${filteredHistory.length}</p>
            `;

            panel.innerHTML = historyHtml;
            return;
        }

        if (getAnalysisSession().isAnalysisMode) {
            const currentAnalysis = getAnalysisState();
            const serverUrl = getAnalysisSession().defaultServer || '';

            let html = `
                <div class="property-group">
                    <h3>Адрес сервера</h3>
                    <input type="text" id="analysis-server-input" value="${serverUrl}" 
                        oninput="window.onServerUrlInput(this.value)">
                </div>
                
                <div class="property-group">
                    <h3>Вид анализа</h3>
                    <select id="analysis-type-select" onchange="window.updateAnalysisType(this.value)">
                        ${
                currentAnalysis.selectedType ?
                    `<option value="${currentAnalysis.selectedType}" selected>${
                        currentAnalysis.selectedTypeName}</option>` :
                    '<option value="">Укажите адрес сервера</option>'}
                    </select>
                </div>
                
                <div id="analysis-dynamic-container" class="analysis-dynamic-params"></div>
            `;

            panel.innerHTML = html;
            setTimeout(() => {
                if (typeof window.loadAnalysisTypes === 'function') {
                    window.loadAnalysisTypes();
                }
            }, 0);
            return;
        }

        panel.innerHTML = `<p style="color:#888;">Выберите объект для редактирования</p>`;
        return;
    }

    // Поиск сущности в глобальном состоянии по UUID
    const place = getState().places.find(p => p.uuid === id);
    const transition = getState().transitions.find(t => t.uuid === id);
    const arc = getState().arcs.find(a => a.uuid === id);
    const comment = getState().comments.find(a => a.uuid === id);

    if (place) {
        panel.innerHTML = `
            <div class="property-group"><h3>Позиция</h3></div>
            <div class="property-group"><label>Имя:</label><input type="text" value="${
            place.name}" oninput="updateName('${id}', this.value)"></div>
            
            <div class="property-group">
                <div class="property-group"><label>Маркеры (фишки):</label><input  id="property-tokens-input" type="number" min="0" value="${
            place.tokens}" onchange="updateTokens('${id}', this.value)"></div>
                <div class="tokens-mobile-row" style="display: flex; gap: 6px; align-items: center; width: 100%;">
                    <button onclick="const input = document.getElementById('property-tokens-input'); const val = Math.max(0, (parseInt(input.value) || 0) - 1); input.value = val; updateTokens('${
            id}', val);"
                        style="font-weight: bold; background: #fff3cd; color: #856404;">-1</button>
                    
                    <button onclick="const input = document.getElementById('property-tokens-input'); const val = (parseInt(input.value) || 0) + 1; input.value = val; updateTokens('${
            id}', val);" 
                        style="font-weight: bold; background: #d4edda; color: #155724;">+1</button>
                </div>
            </div>
        `;
    } else if (transition) {
        panel.innerHTML = `
            <div class="property-group"><h3>Переход</h3></div>
            <div class="property-group"><label>Имя:</label><input type="text" value="${
            transition.name}" oninput="updateName('${id}', this.value)"></div>
        `;
    } else if (arc) {
        const srcNode = findNode(arc.sourceId);
        const tgtNode = findNode(arc.targetId);
        panel.innerHTML = `
            <div class="property-group"><h3>Дуга</h3></div>
            <div class="property-group"><p>Связывает: <b>${srcNode ? srcNode.name : '?'}</b> → <b>${
            tgtNode ? tgtNode.name : '?'}</b></p></div>
            <div class="property-group"><label>Кратность (Вес):</label><input type="number" min="1" value="${
            arc.weight}" oninput="updateArcWeight('${id}', this.value)"></div>
        `;
    } else if (comment) {
        panel.innerHTML = `
        <div class="property-group"><h3>Комментарий</h3></div>
        <div class="property-group">
            <label>Текст:</label>
            <textarea rows="4" style="resize: vertical; width: 100%;" 
                oninput="updateCommentText('${id}', this.value)"
            >${comment.text}</textarea>
        </div>
    `;
    }

    const currentObj = place || transition || arc || comment;
    // Общая для всех элементов секция выбора цвета и кнопка удаления
    panel.innerHTML += `
    <div class="property-group">
        <label>Цвет элемента:</label>
        <select onchange="updateElementColor('${id}', this.value)">
            <option value="black" ${
        currentObj.color === 'black' || !currentObj.color ? 'selected' : ''}>⚫ Черный</option>
            <option value="red" ${currentObj.color === 'red' ? 'selected' : ''}>🔴 Красный</option>
            <option value="blue" ${currentObj.color === 'blue' ? 'selected' : ''}>🔵 Синий</option>
            <option value="green" ${
        currentObj.color === 'green' ? 'selected' : ''}>🟢 Зеленый</option>
        </select>
    </div>
    <button class="btn-danger" onclick="deleteObject('${id}')">Удалить</button>
`;
}

/**
 * @section Экспорт функций в объект `window`.
 * @brief Обеспечивает видимость основных функций ядра из инлайновых атрибутов HTML-шаблона
 * (onclick, onchange).
 * @warning При добавлении новых функций, которые должны вызываться напрямую из тегов разметки UI,
 *          обязательно зарегистрируйте их здесь в формате `window.yourFunction = yourFunction;`.
 */
window.selectObject = selectObject;
window.setMode = setMode;
window.resetSimulation = resetSimulation;
window.applySimulationState = applySimulationState;
window.undoTransition = undoTransition;
window.redoTransition = redoTransition;
window.fireTransition = fireTransition;
window.toggleFilterColor = toggleFilterColor;
window.updateElementColor = updateElementColor;
window.updateName = updateName;
window.updateTokens = updateTokens;
window.updateArcWeight = updateArcWeight;
window.updateCommentText = updateCommentText;
window.deleteObject = deleteObject;
window.clearPetriNet = clearPetriNet;

window.updateConnectionIndicator = updateConnectionIndicator;
window.onServerUrlInput = onServerUrlInput;
window.updateAnalysisType = updateAnalysisType;
window.loadAnalysisTypes = loadAnalysisTypes;
window.updateAnalysisParamValue = updateAnalysisParamValue;
window.updateAnalysisParamGroup = updateAnalysisParamGroup;
window.toggleAnalysisColorCapture = toggleAnalysisColorCapture;
window.toggleAnalysisMarkingCapture = toggleAnalysisMarkingCapture;
window.resetAnalysisMarkingToInitial = resetAnalysisMarkingToInitial;
window.clearAnalysisMarkingToEmpty = clearAnalysisMarkingToEmpty;

window.exportToFile = exportToFile;
window.importFromFile = importFromFile;
window.exportToSVG = exportToSVG;
window.exportToPDF = exportToPDF;
window.toggleTheme = toggleTheme;

window.onCanvasMouseDown = onCanvasMouseDown;
window.onNodeMouseDown = onNodeMouseDown;

/**
 * @brief Функция инициализации приложения при старте страницы.
 * @details Конфигурирует окружение, последовательно загружая тему, структуры данных и биндинги
 * клавиш.
 */
function init() {
    loadToggleTheme();       // Восстанавливаем тему оформления
    loadFromLocalStorage();  // Загружаем сохраненную сеть
    initHotKeys();           // Инициализируем горячие клавиши
    render();                // Делаем первичный рендеринг
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}