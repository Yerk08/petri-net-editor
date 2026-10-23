import {onCanvasMouseDown, onCanvasMouseMove, onNodeMouseDown, onNodeMouseMove, onNodeMouseUp, fitToView} from './modules/events.js';
import {initHotKeys} from './modules/hotkeys.js';
import {render} from './modules/render.js';
import {applySimulationState, clearPetriNet, currentMode, deleteObject, exitSimulation, findComment, findNode, fireTransition, getSimulation, getState, redoTransition, resetSimulation, selectedId, setMode, setSelectedId, toggleFilterColor, undoTransition, updateArcWeight, updateCommentText, updateElementColor, updateName, updateTokens} from './modules/state.js';
import {exportToFile, exportToPDF, exportToSVG, importFromFile, loadFromLocalStorage} from './modules/storage.js';
import {loadToggleTheme, toggleTheme} from './modules/theme.js';


// --- ПАНЕЛЬ СВОЙСТВ (СПРАВА) ---
export function selectObject(id) {
    setSelectedId(id);
    render();

    const inspectorBtn = document.getElementById('mobile-inspector-btn');
    if (inspectorBtn) {
        inspectorBtn.classList.toggle('has-selection', !!id);
    }

    const panel = document.getElementById('properties-panel');
    if (!id) {
        if (getSimulation().isSimMode) {
            const simulation = getSimulation();

            const filteredHistory = simulation.history.filter(item => {
                const itemColor = item.color || 'black';
                const chk = document.getElementById(`chk-filter-${itemColor}`);
                return chk ? chk.checked : true;
            });

            if (filteredHistory.length === 0) {
                panel.innerHTML = `
                    <div class="prop-title">
                        <span class="prop-kind">История</span>
                        <span class="prop-id">симуляция</span>
                    </div>
                    <div class="prop-empty">
                        <p>История пуста</p>
                        <span>или отфильтрована по цвету</span>
                    </div>
                `;
                return;
            }

            const colorEmojis = {black: '⚫', red: '🔴', blue: '🔵', green: '🟢', white: '⚪'};

            let historyHtml = `
                <div class="prop-title">
                    <span class="prop-kind">История</span>
                    <span class="prop-id">${filteredHistory.length} шагов</span>
                </div>
                <ol class="sim-history">
            `;

            filteredHistory.forEach(item => {
                const emoji = colorEmojis[item.color] || '⚫';
                historyHtml += `
                    <li>
                        <span class="hist-emoji">${emoji}</span>
                        <b>${item.name}</b>
                    </li>
                `;
            });

            historyHtml += `
                </ol>
                <div class="prop-note foot">Всего шагов: ${filteredHistory.length}</div>
            `;

            panel.innerHTML = historyHtml;
            return;
        }

        panel.innerHTML = `
            <div class="prop-empty">
                <div class="empty-mark" aria-hidden="true">
                    <svg width="34" height="34" viewBox="0 0 34 34" fill="none" stroke="currentColor" stroke-width="1.2">
                        <circle cx="11" cy="17" r="7"/>
                        <rect x="23" y="11" width="7" height="12" rx="1.5"/>
                        <path d="M18 17h5"/>
                    </svg>
                </div>
                <p>Выберите объект на холсте</p>
                <span>Свойства появятся здесь</span>
                <div class="empty-hints">
                    <span>P — позиция</span><span>T — переход</span><span>A — дуга</span>
                </div>
            </div>
        `;
        return;
    }

    const place = getState().places.find(p => p.uuid === id);
    const transition = getState().transitions.find(t => t.uuid === id);
    const arc = getState().arcs.find(a => a.uuid === id);
    const comment = getState().comments.find(a => a.uuid === id);

    if (place) {
        panel.innerHTML = `
            <div class="prop-title">
                <span class="prop-kind">Позиция</span>
                <span class="prop-id">${id}</span>
            </div>
            <div class="prop-field">
                <label>Имя</label>
                <input type="text" value="${place.name}" oninput="updateName('${id}', this.value)">
            </div>
            <div class="prop-field">
                <label>Маркеры (фишки)</label>
                <div class="token-row">
                    <button class="stepper" title="Убрать фишку" onclick="const input = document.getElementById('property-tokens-input'); const val = Math.max(0, (parseInt(input.value) || 0) - 1); input.value = val; updateTokens('${id}', val);">−</button>
                    <input id="property-tokens-input" type="number" min="0" value="${place.tokens}" onchange="updateTokens('${id}', this.value)">
                    <button class="stepper plus" title="Добавить фишку" onclick="const input = document.getElementById('property-tokens-input'); const val = (parseInt(input.value) || 0) + 1; input.value = val; updateTokens('${id}', val);">+</button>
                </div>
            </div>
        `;
    } else if (transition) {
        panel.innerHTML = `
            <div class="prop-title">
                <span class="prop-kind">Переход</span>
                <span class="prop-id">${id}</span>
            </div>
            <div class="prop-field">
                <label>Имя</label>
                <input type="text" value="${transition.name}" oninput="updateName('${id}', this.value)">
            </div>
        `;
    } else if (arc) {
        const srcNode = findNode(arc.sourceId);
        const tgtNode = findNode(arc.targetId);
        panel.innerHTML = `
            <div class="prop-title">
                <span class="prop-kind">Дуга</span>
                <span class="prop-id">${id}</span>
            </div>
            <div class="prop-field">
                <label>Связывает</label>
                <div class="prop-note"><b>${srcNode ? srcNode.name : '?'}</b> → <b>${tgtNode ? tgtNode.name : '?'}</b></div>
            </div>
            <div class="prop-field">
                <label>Кратность (вес)</label>
                <input type="number" min="1" value="${arc.weight}" oninput="updateArcWeight('${id}', this.value)">
            </div>
        `;
    } else if (comment) {
        panel.innerHTML = `
            <div class="prop-title">
                <span class="prop-kind">Комментарий</span>
                <span class="prop-id">${id}</span>
            </div>
            <div class="prop-field">
                <label>Текст</label>
                <textarea rows="4" oninput="updateCommentText('${id}', this.value)">${comment.text}</textarea>
            </div>
        `;
    }

    const currentObj = place || transition || arc || comment;
    panel.innerHTML += `
    <div class="prop-field">
        <label>Цвет элемента</label>
        <select onchange="updateElementColor('${id}', this.value)">
            <option value="black" ${
        currentObj.color === 'black' || !currentObj.color ? 'selected' : ''}>⚫ Чёрный</option>
            <option value="red" ${currentObj.color === 'red' ? 'selected' : ''}>🔴 Красный</option>
            <option value="blue" ${currentObj.color === 'blue' ? 'selected' : ''}>🔵 Синий</option>
            <option value="green" ${
        currentObj.color === 'green' ? 'selected' : ''}>🟢 Зелёный</option>
        </select>
    </div>
    <div class="prop-actions">
        <button class="btn-danger" onclick="deleteObject('${id}')">Удалить объект</button>
    </div>
`;
}

// Чтобы HTML инлайн-события (onclick, onpointerdown) видели эти функции
window.selectObject = selectObject;
window.setMode = setMode;
window.resetSimulation = resetSimulation;
window.applySimulationState = applySimulationState;
window.exitSimulation = exitSimulation;
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

window.exportToFile = exportToFile;
window.importFromFile = importFromFile;
window.exportToSVG = exportToSVG;
window.exportToPDF = exportToPDF;
window.toggleTheme = toggleTheme;

window.onCanvasMouseDown = onCanvasMouseDown;
window.onNodeMouseDown = onNodeMouseDown;
window.fitToView = fitToView;

function updateStatusCounts() {
    const counts = document.getElementById('status-counts');
    if (!counts) return;

    const places = document.querySelectorAll('#nodes-group .place').length;
    const transitions = document.querySelectorAll('#nodes-group .transition').length;
    const arcs = document.querySelectorAll('#arcs-group .arc').length;

    counts.textContent = `${places} поз. · ${transitions} пер. · ${arcs} дуг`;
}

function isMobileLayout() {
    return window.matchMedia('(max-width: 900px)').matches;
}

function closeMobilePanels() {
    document.body.classList.remove('menu-open', 'inspector-open');
}

function toggleMobileMenu() {
    if (!isMobileLayout()) return;
    document.body.classList.remove('inspector-open');
    document.body.classList.toggle('menu-open');
}

function toggleInspector() {
    if (!isMobileLayout()) return;
    document.body.classList.remove('menu-open');
    document.body.classList.toggle('inspector-open');
}

function syncModeLabel() {
    const label = document.getElementById('mode-label');
    const active = document.querySelector('#left-menu .tool.active');
    if (label && active) {
        label.textContent = active.dataset.label || 'Редактор';
    }

    // На телефоне при входе в симуляцию сразу показываем ее управление,
    // иначе кнопки сброса/отмены остались бы в закрытой шторке.
    if (isMobileLayout() && active) {
        const isSimulation = active.id === 'btn-simulation';
        document.body.classList.toggle('menu-open', isSimulation);
        if (isSimulation) {
            document.body.classList.remove('inspector-open');
        }
    }
}

function initUI() {
    const nodesGroup = document.getElementById('nodes-group');
    const arcsGroup = document.getElementById('arcs-group');
    const leftMenu = document.getElementById('left-menu');

    if (nodesGroup) {
        new MutationObserver(updateStatusCounts).observe(nodesGroup, {childList: true});
    }
    if (arcsGroup) {
        new MutationObserver(updateStatusCounts).observe(arcsGroup, {childList: true});
    }
    if (leftMenu) {
        new MutationObserver(syncModeLabel)
            .observe(leftMenu, {subtree: true, attributes: true, attributeFilter: ['class']});
    }

    window.addEventListener('resize', () => {
        if (!isMobileLayout()) closeMobilePanels();
    });

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMobilePanels();
    });

    updateStatusCounts();
    syncModeLabel();
}

window.toggleMobileMenu = toggleMobileMenu;
window.toggleInspector = toggleInspector;
window.closeMobilePanels = closeMobilePanels;

function init() {
    loadFromLocalStorage();  // Загружаем сохраненную сеть
    loadToggleTheme();       // Восстанавливаем тему оформления
    initHotKeys();           // Инициализируем горячие клавиши
    render();                // Делаем первичный рендеринг
    initUI();                // Синхронизируем счетчики и подпись режима

    // На маленьких экранах показываем сеть целиком, а не случайный угол
    if (isMobileLayout()) {
        requestAnimationFrame(() => fitToView(26));
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}