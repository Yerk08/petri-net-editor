/**
 * @file analysis.js
 * @brief Модуль интеграции подсистемы анализа сетей Петри.
 */

import {getAnalysisSession, getAnalysisState, getState, setAnalysisState, setDefaultServer} from './state.js';
import {saveToLocalStorage} from './storage.js';

let currentAbortController = null;
let analysisTimeout = null;

/**
 * @brief Управляет визуальным индикатором статуса подключения к серверу.
 */
export function updateConnectionIndicator(status) {
    let indicator = document.getElementById('analysis-server-indicator');
    if (!indicator) {
        const serverInput = document.getElementById('analysis-server-input');
        if (serverInput && serverInput.parentElement) {
            indicator = document.createElement('div');
            indicator.id = 'analysis-server-indicator';
            serverInput.parentElement.appendChild(indicator);
        }
    }
    if (!indicator) return;

    if (status === 'loading') {
        indicator.innerHTML = '<kbd>⏳ Загрузка</kbd>';
    } else if (status === 'online') {
        indicator.innerHTML = '<kbd>🟢 В сети</kbd>';
    } else if (status === 'offline') {
        indicator.innerHTML = '<kbd>🔴 Оффлайн</kbd>';
    }
}

/**
 * @brief Обработчик изменения текстового поля адреса сервера.
 */
export function onServerUrlInput(value) {
    setDefaultServer(value);
    clearTimeout(analysisTimeout);
    analysisTimeout = setTimeout(() => {
        window.loadAnalysisTypes();
    }, 600);
    saveToLocalStorage();
}

/**
 * @brief Асинхронно загружает доступные типы анализа с сервера.
 */
export async function loadAnalysisTypes() {
    const serverInput = document.getElementById('analysis-server-input');
    const selectEl = document.getElementById('analysis-type-select');
    if (!selectEl || !serverInput) return;

    const serverUrl = getAnalysisSession().defaultServer.trim();
    if (!serverUrl) {
        selectEl.innerHTML = '<option value="">Укажите адрес сервера</option>';
        return;
    }

    if (currentAbortController) currentAbortController.abort();
    currentAbortController = new AbortController();
    updateConnectionIndicator('loading');

    try {
        const cleanUrl = serverUrl.replace(/\/+$/, '');
        const response =
            await fetch(`${cleanUrl}/api/v1/get_types`, {signal: currentAbortController.signal});

        if (!response.ok) throw new Error(`Ошибка сервера: ${response.status}`);
        const types = await response.json();
        if (!Array.isArray(types) || types.length === 0) {
            selectEl.innerHTML = '<option value="">Нет доступных видов</option>';
            return;
        }

        updateConnectionIndicator('online');
        const currentAnalysis = getAnalysisState();
        const currentSavedTypeId = currentAnalysis.selectedType || null;

        selectEl.innerHTML =
            types
                .map(t => {
                    const isSelected = t.id === currentSavedTypeId ? 'selected' : '';
                    return `<option value="${t.id}" ${isSelected}>${t.name}</option>`;
                })
                .join('');

        if (!currentSavedTypeId && selectEl.value) {
            await updateAnalysisType(selectEl.value);
        } else if (currentSavedTypeId) {
            await loadParamSchema(currentSavedTypeId);
        }

    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('Ошибка при загрузке видов анализа:', error);

        updateConnectionIndicator('offline');
        const currentAnalysis = getAnalysisState();
        if (currentAnalysis.selectedType && currentAnalysis.selectedTypeName) {
            loadParamSchema(currentAnalysis.selectedType);
        } else {
            selectEl.innerHTML = '<option value="">Сервер недоступен</option>';
        }
    }
}

/**
 * @brief Динамически обновляет тип анализа и запрашивает его схему полей.
 */
export async function updateAnalysisType(value) {
    if (!value) {
        if (getState().analysis) {
            delete getState().analysis;
        }
        const dynamicContainer = document.getElementById('analysis-dynamic-container');
        if (dynamicContainer) dynamicContainer.innerHTML = '';
    } else {
        const selectEl = document.getElementById('analysis-type-select');
        let typeName = '';
        if (selectEl && selectEl.selectedOptions && selectEl.selectedOptions[0]) {
            typeName = selectEl.selectedOptions[0].text;
        }

        setAnalysisState(
            {selectedType: value, selectedTypeName: typeName, serverSchema: null, params: {}});

        let dynamicContainer = document.getElementById('analysis-dynamic-container');
        if (dynamicContainer) {
            dynamicContainer.innerHTML = '<p>⏳ Загрузка параметров...</p>';
        }
        await loadParamSchema(value);
    }

    saveToLocalStorage();
}

/**
 * @brief Вспомогательный метод для загрузки и сохранения схемы полей в state.analysis.
 */
async function loadParamSchema(typeId) {
    const serverUrl = getAnalysisSession().defaultServer.replace(/\/+$/, '');
    if (!serverUrl || !typeId) return;

    const renderDynamicFields = (serverSchema, currentAnalysis) => {
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
                        const isChecked =
                            Array.isArray(savedValue) && savedValue.includes(opt.value) ?
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

            } else if (fieldType === 'description') {
                html += `<p>ℹ️ ${fieldName}</p>`;

            } else if (fieldType === 'dict') {
                html += `<select id="param-field-${
                    fieldId}" onchange="window.updateAnalysisParamValue('${
                    fieldId}', this.value)">`;
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
                    savedValue}" oninput="window.updateAnalysisParamValue('${
                    fieldId}', this.value)">`;

            } else {
                html += `<input type="text" id="param-field-${fieldId}" value="${
                    savedValue}" oninput="window.updateAnalysisParamValue('${
                    fieldId}', this.value)">`;
            }

            html += `</div>`;
        });

        dynamicContainer.innerHTML = html;
    };

    try {
        const response = await fetch(`${serverUrl}/api/v1/get_schema?id=${typeId}`);
        if (response.ok) {
            const schema = await response.json();
            const currentAnalysis = getAnalysisState();
            currentAnalysis.serverSchema = schema;
            setAnalysisState(currentAnalysis);
            saveToLocalStorage();
            renderDynamicFields(schema, currentAnalysis);
        }
    } catch (e) {
        console.warn('Не удалось загрузить схему параметров с сервера, используем сохраненную:', e);
        const currentAnalysis = getAnalysisState();
        if (currentAnalysis.serverSchema) {
            renderDynamicFields(currentAnalysis.serverSchema, currentAnalysis);
        }
    }
}



/**
 * @brief Обновляет значение одиночного динамического параметра в состоянии анализа.
 * @param {string} paramId - Идентификатор параметра из схемы.
 * @param {any} value - Установленное значение.
 */
export function updateAnalysisParamValue(paramId, value) {
    const currentAnalysis = getAnalysisState();
    if (!currentAnalysis.params) {
        currentAnalysis.params = {};
    }

    currentAnalysis.params[paramId] = value;
    setAnalysisState(currentAnalysis);
    saveToLocalStorage();
}

/**
 * @brief Обновляет массив значений для параметров типа список (группы чекбоксов).
 * @param {string} fieldId - Идентификатор поля из схемы.
 * @param {string} optionValue - Значение выбранного элемента.
 * @param {boolean} isChecked - Состояние флага (выбран или снят).
 */
export function updateAnalysisParamGroup(fieldId, optionValue, isChecked) {
    const currentAnalysis = getAnalysisState();
    if (!currentAnalysis.params) {
        currentAnalysis.params = {};
    }
    if (!Array.isArray(currentAnalysis.params[fieldId])) {
        currentAnalysis.params[fieldId] = [];
    }

    const targetArray = currentAnalysis.params[fieldId];
    if (isChecked) {
        if (!targetArray.includes(optionValue)) {
            targetArray.push(optionValue);
        }
    } else {
        currentAnalysis.params[fieldId] = targetArray.filter(v => v !== optionValue);
    }

    setAnalysisState(currentAnalysis);
    saveToLocalStorage();
}
