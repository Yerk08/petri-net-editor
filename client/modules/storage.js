/**
 * @file storage.js
 * @brief Модуль подсистемы хранения, экспорта и импорта данных сети Петри.
 * @details Обеспечивает сериализацию состояния, дроттлинг автосохранения в LocalStorage,
 *          а также выгрузку сети в форматы JSON, SVG и PDF с корректным расчетом границ (BBox).
 */

import {selectObject} from '../editor.js';

import {render} from './render.js';
import {getAnalysisSession, getCleanState, getDispatcherView, replaceState, resetSimulation, setDefaultServer, setDispatcherTasks} from './state.js';


// --- LOCAL STORAGE ---
let lastSaveTime = 0;    ///< Метка времени (timestamp) последнего успешного сохранения
let saveTimeout = null;  ///< Ссылка на активный таймер отложенного сохранения (debounce/throttle)

/**
 * @brief Сохраняет текущую сеть Петри в `localStorage` с защитой от частой перезаписи (Debounce).
 * @details Функция ограничивает частоту сохранений интервалом в 660 миллисекунд. Если вызовы
 *          происходят чаще, фактическая запись откладывается.
 *
 * @note **ИНСТРУКЦИЯ ПО РАСШИРЕНИЮ:** Если вы захотите добавить облачное автосохранение
 * (например, через Fetch API / WebSockets на бэкенд), интегрируйте вызов API внутрь
 * вложенной функции `doSave()`, чтобы сетевые запросы тоже автоматически дросселировались.
 */
export function saveToLocalStorage() {
    const now = Date.now();
    const remaining = 660 - (now - lastSaveTime);
    clearTimeout(saveTimeout);

    const doSave = () => {
        lastSaveTime = Date.now();
        localStorage.setItem('petri_net_save', JSON.stringify(getCleanState()));

        const serverUrl = getAnalysisSession().defaultServer;
        localStorage.setItem('analysis_server_save', JSON.stringify(serverUrl));

        const dispatcherTasks = getDispatcherView().tasks;
        localStorage.setItem('dispatcher_tasks_save', JSON.stringify(dispatcherTasks));
    };

    if (remaining <= 0) {
        doSave();
    } else {
        saveTimeout = setTimeout(doSave, remaining);
    }
}

export function loadFromLocalStorage() {
    const savedServer = localStorage.getItem('analysis_server_save');
    if (savedServer) {
        const url = JSON.parse(savedServer);
        if (url) {
            setDefaultServer(url);
        }
    }

    const dispatcherTasks = localStorage.getItem('dispatcher_tasks_save');
    if (dispatcherTasks) {
        const tasks = JSON.parse(dispatcherTasks);
        if (tasks) {
            setDispatcherTasks(tasks);
        }
    }

    const data = localStorage.getItem('petri_net_save');
    if (data) {
        replaceState(JSON.parse(data));
        selectObject(null);
        render();
    }
}

// --- ЭКСПОРТ И ИМПОРТ ФАЙЛОВ ---
/**
 * @brief Экспортирует текущую сеть Петри в `.json` файл.
 * @details Пытается использовать современный `showSaveFilePicker` (File System Access API).
 *          В случае его отсутствия в браузере автоматически переключается на классический
 * fallback-метод с генерацией ссылки `<a download>`. Перед экспортом принудительно сбрасывает
 * симуляцию.
 */
export async function exportToFile() {
    resetSimulation();

    const formattedDate =
        new Date().toISOString().slice(0, 16).replace('T', '_').replace(/:/g, '-');
    const defaultFileName = `petri_net_${formattedDate}.json`;

    if ('showSaveFilePicker' in window) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: defaultFileName,
                types: [{description: 'JSON Files', accept: {'application/json': ['.json']}}]
            });

            const stateData = JSON.stringify(getCleanState(), null, 2);
            const writable = await handle.createWritable();
            await writable.write(stateData);
            await writable.close();
            return;
        } catch (err) {
            if (err.name === 'AbortError') return;
            console.error('Ошибка File System Access API, переключаемся на fallback:', err);
        }
    }

    // (Если API недоступно или упало)
    const stateDataFallback = JSON.stringify(getCleanState(), null, 2);
    const blob = new Blob([stateDataFallback], {type: 'application/json;charset=utf-8'});
    const dataUrl = URL.createObjectURL(blob);

    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataUrl);
    downloadAnchor.setAttribute('download', defaultFileName);

    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();

    URL.revokeObjectURL(dataUrl);
}

/**
 * @brief Импортирует состояние сети Петри из выбранного пользователем JSON-файла.
 * @param {Event} event - Событие изменения (`change`) инпута или события сброса файла (`drop`).
 *
 * @warning **КРИТИЧЕСКОЕ МЕСТО ДЛЯ ИЗМЕНЕНИЙ (ВАЛИДАЦИЯ ФОРМАТА):**
 * Сейчас проверка структуры файла поверхностная: `importedState.places && importedState.transitions
 * && importedState.arcs`. Если вы добавляете новые обязательные корневые сущности в структуру сети
 * (например, `subnets` или глобальные переменные):
 * - Обязательно добавьте их проверку в условие `if`, иначе импорт дефектного файла может вызвать
 * падение `render()`.
 */
export function importFromFile(event) {
    if (event) {
        event.preventDefault();
    }
    const files = event.dataTransfer ? event.dataTransfer.files : event.target.files;
    const file = files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importedState = JSON.parse(e.target.result);
            if (importedState.places && importedState.transitions && importedState.arcs) {
                replaceState(importedState);
                selectObject(null);
                render();
            } else {
                alert('Неверный формат файла сети Петри.');
            }
        } catch (err) {
            alert('Ошибка при чтении JSON-файла.');
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}



export function exportToSVG() {
    const serialized = serializeSVG();
    if (!serialized) return;
    const {svgClone} = serialized;

    const svgString = new XMLSerializer().serializeToString(svgClone);
    const svgBlob = new Blob([svgString], {type: 'image/svg+xml;charset=utf-8'});
    const svgUrl = URL.createObjectURL(svgBlob);

    const downloadLink = document.createElement('a');
    downloadLink.href = svgUrl;
    const formattedDate =
        new Date().toISOString().slice(0, 16).replace('T', '_').replace(/:/g, '-');
    downloadLink.download = `petri_net_${formattedDate}.svg`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(svgUrl);
}

/**
 * @brief Инициирует экспорт графа сети Петри в формат PDF с помощью системного диалога печати.
 * @details Создает временный контейнер `@media print`, подменяет им текущее тело страницы
 *          и вызывает окно `window.print()`.
 */
export async function exportToPDF() {
    const serialized = serializeSVG();
    if (!serialized) return;
    const {svgClone, width, height} = serialized;

    const printContainer = document.createElement('div');
    printContainer.id = 'pdf-print-container';
    const style = document.createElement('style');
    style.textContent = `
        @media print {
            body > * { display: none !important; }
            #pdf-print-container { display: block !important; position: absolute; left: 0; top: 0; width: 100%; }
            svg { width: 100% !important; height: auto !important; max-height: 100vh; }
        }
        #pdf-print-container { display: none; }
    `;

    printContainer.appendChild(svgClone);
    document.body.appendChild(printContainer);
    document.head.appendChild(style);
    window.print();
    setTimeout(() => {
        printContainer.remove();
        style.remove();
    }, 1000);
}

/**
 * @brief Сериализует текущий DOM-элемент SVG, высчитывает его реальные границы (BBox) и упаковывает
 * стили.
 * @return {Object|undefined} Объект `{ svgClone, width, height }` или `undefined`, если SVG не
 *     найден в DOM.
 *
 * @warning **МЕСТО ПОВЫШЕННОЙ ОПАСНОСТИ ДЛЯ СТИЛЕЙ (CORS):**
 * Цикл `for (const stylesheet of document.styleSheets)` обходит все подключенные CSS-правила
 * приложения для их инжекции прямо внутрь тега `<defs>` результирующего SVG (чтобы цвета, шрифты и
 * маркеры стрелок не пропали). Если в проект будут подключены сторонние CSS-шрифты или библиотеки с
 * внешних CDN (например, Google Fonts):
 * - Браузер выбросит **SecurityError** при попытке прочесть `cssRules` из-за ограничений CORS.
 * - Перехватчик `catch(e)` подавляет эту ошибку, но внешние стили не попадут в SVG. Учитывайте это
 * при кастомизации UI!
 */
export function serializeSVG() {
    const svgElement = document.getElementById('petri-svg');
    if (!svgElement) return;

    const svgClone = svgElement.cloneNode(true);
    svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    // Сразу вычищаем пустые комментарии в клоне, чтобы они не ломали расчет границ
    const emptyComments = svgClone.querySelectorAll('.is-empty');
    emptyComments.forEach(comment => comment.remove());

    // Это возвращает элементы к их истинным локальным координатам
    const clonedViewport = svgClone.getElementById('viewport') || svgClone.firstElementChild;
    if (clonedViewport) {
        clonedViewport.removeAttribute('transform');
    }

    svgClone.style.position = 'absolute';
    svgClone.style.top = '-9999px';
    svgClone.style.left = '-9999px';
    svgClone.style.visibility = 'hidden';
    document.body.appendChild(svgClone);

    const bbox = svgClone.getBBox();
    document.body.removeChild(svgClone);
    svgClone.removeAttribute('style');

    const padding = 20;
    const minX = bbox.x - padding;
    const minY = bbox.y - padding;
    const width = bbox.width + padding * 2;
    const height = bbox.height + padding * 2;

    // Браузер сам отмасштабирует отрицательные области в плюс
    svgClone.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);
    svgClone.setAttribute('width', width);
    svgClone.setAttribute('height', height);

    let styles = '';
    for (const stylesheet of document.styleSheets) {
        try {
            for (const rule of stylesheet.cssRules) {
                styles += rule.cssText + '\n';
            }
        } catch (e) {
            // Игнорируем внешние стили
        }
    }

    const styleElement = document.createElement('style');
    styleElement.textContent = styles;
    let defs = svgClone.querySelector('defs');
    if (!defs) {
        defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        svgClone.insertBefore(defs, svgClone.firstChild);
    }
    defs.appendChild(styleElement);

    return {svgClone, width, height};
}



// --- ИНТЕГРАЦИЯ С GOOGLE AI (КОПИРОВАНИЕ И ВСТАВКА JSON) ---

/**
 * @brief Показывает короткое всплывающее уведомление в правом нижнем углу экрана.
 * @param {string} message - Текст уведомления.
 */
function showToast(message) {
    const toast = document.createElement('div');
    toast.textContent = message;
    Object.assign(toast.style, {
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        background: '#323232',
        color: '#ffffff',
        padding: '10px 18px',
        borderRadius: '6px',
        fontSize: '14px',
        zIndex: '99999',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
        opacity: '0',
        transition: 'opacity 0.25s ease'
    });

    document.body.appendChild(toast);
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
    });

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 250);
    }, 2500);
}

/**
 * @brief Универсальное копирование текста в буфер обмена (работает на HTTP и HTTPS).
 * @param {string} text - Строка для копирования.
 */
async function copyTextSafe(text) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '-9999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
        document.execCommand('copy');
    } finally {
        document.body.removeChild(textArea);
    }
}

/**
 * @brief Копирует чистый JSON текущей сети Петри в буфер обмена без лишнего текста и окон.
 */
export async function copyJSONToClipboard() {
    const cleanJson = JSON.stringify(getCleanState(), null, 2);

    try {
        await copyTextSafe(cleanJson);
        showToast('✅ Было скопировано');
    } catch (err) {
        console.warn('Не удалось скопировать в буфер:', err);
        showToast('⚠️ Не удалось скопировать');
    }
}

/**
 * @brief Импортирует сеть Петри из буфера обмена (или через ручной ввод по HTTP) и обновляет холст.
 */
export async function pasteJSONFromClipboard() {
    let text = '';

    if (navigator.clipboard && window.isSecureContext) {
        try {
            text = await navigator.clipboard.readText();
        } catch (err) {
            console.warn('Доступ к буферу отклонен, переключаемся на ручной ввод:', err);
        }
    }

    if (!text) {
        text = window.prompt('Вставьте JSON (Ctrl+V):');
        if (!text) return;
    }

    try {
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            alert('В тексте не найден валидный JSON.');
            return;
        }

        const importedState = JSON.parse(match);

        if (importedState.places && importedState.transitions && importedState.arcs) {
            replaceState(importedState);
            selectObject(null);
            render();
            showToast('✅ Сеть загружена');
        } else {
            alert('JSON не соответствует формату сети Петри (нет places, transitions или arcs).');
        }
    } catch (err) {
        alert('Ошибка при парсинге JSON: ' + err.message);
    }
}