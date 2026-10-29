/**
 * @file analysis.js
 * @brief Модуль интеграции подсистемы анализа сетей Петри.
 */

import {startPolling} from './dispatcher.js';
import {render, renderAnalysisTaskControl, renderDynamicFields} from './render.js';
import {createTokensSnapshot, getAnalysisSession, getAnalysisState, getState, pushDispatcherTask, restoreTokensFromSnapshot, setAnalysisState, setDefaultServer, visibleColors} from './state.js';
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
    clearTimeout(analysisTimeout);

    const serverInput = document.getElementById('analysis-server-input');
    const selectEl = document.getElementById('analysis-type-select');
    if (!selectEl || !serverInput) return;

    const serverUrl = getAnalysisSession().defaultServer.trim();
    if (!serverUrl && !getState().analysis) {
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

        analysisTimeout = setTimeout(() => loadAnalysisTypes(), 30000);

    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('Ошибка при загрузке видов анализа:', error);

        updateConnectionIndicator('offline');
        const rootAnalysis = getState().analysis;
        if (rootAnalysis && rootAnalysis.selectedType) {
            setAnalysisState(rootAnalysis);
            const currentAnalysis = getAnalysisState();
            selectEl.innerHTML = `<option value="${currentAnalysis.selectedType}" selected>${
                currentAnalysis.selectedTypeName || 'Сохраненный анализ'}</option>`;
            loadParamSchema(currentAnalysis.selectedType);
        } else {
            selectEl.innerHTML = '<option value="">Сервер недоступен</option>';
        }

        analysisTimeout = setTimeout(() => loadAnalysisTypes(), 5000);
    }
}

/**
 * @brief Вспомогательный метод для загрузки и сохранения схемы полей в state.analysis.
 */
async function loadParamSchema(typeId) {
    const serverUrl = getAnalysisSession().defaultServer.replace(/\/+$/, '');
    if ((!serverUrl && !getState().analysis) || !typeId) return;

    try {
        const response = await fetch(`${serverUrl}/api/v1/get_schema?id=${typeId}`);
        if (response.ok) {
            const schema = await response.json();
            const currentAnalysis = getAnalysisState();
            currentAnalysis.serverSchema = schema;
            setAnalysisState(currentAnalysis);
            saveToLocalStorage();
            renderDynamicFields(schema, currentAnalysis);
        } else {
            throw new Error(`Ошибка сервера: ${response.status}`);
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
 * @brief Динамически обновляет тип анализа и запрашивает его схему полей.
 */
export async function updateAnalysisType(value) {
    const session = getAnalysisSession();
    const oldElement = session.selectedElement;
    if (session.isMarkingSetMode) {
        toggleAnalysisMarkingCapture(oldElement);  // Закрываем режим разметки старого поля
    } else if (session.isColorSetMode) {
        toggleAnalysisColorCapture(oldElement);  // Закрываем режим цвета старого поля
    }

    // Очистка значения старых анализов
    session.taskId = null;
    session.taskStatus = null;
    session.shortResult = null;
    renderAnalysisTaskControl();

    // Само обновление вида анализа
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

/**
 * @brief Включает или выключает режим захвата/изменения цветов для конкретного аргумента анализа.
 * @param {string} fieldId - Уникальный идентификатор поля из схемы.
 */
export function toggleAnalysisColorCapture(fieldId) {
    const session = getAnalysisSession();
    const currentAnalysis = getAnalysisState();

    const isClosing = (session.selectedElement === fieldId);
    if (!currentAnalysis.params) currentAnalysis.params = {};

    if (!isClosing && session.selectedElement) {
        const oldElement = session.selectedElement;
        if (session.isMarkingSetMode) {
            toggleAnalysisMarkingCapture(oldElement);  // Закрываем режим разметки старого поля
        } else if (session.isColorSetMode) {
            toggleAnalysisColorCapture(oldElement);  // Закрываем режим цвета старого поля
        }
    }

    if (isClosing) {
        currentAnalysis.params[fieldId] =
            Object.keys(visibleColors).filter(color => visibleColors[color]);
        setAnalysisState(currentAnalysis);
        saveToLocalStorage();

        session.selectedElement = null;
        session.isColorSetMode = false;
        document.body.classList.remove('mode-analysis-color');
    } else {
        if (!session.backupColors) {
            session.backupColors = Object.keys(visibleColors).filter(color => visibleColors[color]);
        }

        const savedColors = currentAnalysis.params[fieldId] || [];
        Object.keys(visibleColors).forEach(color => {
            visibleColors[color] = savedColors.includes(color);
        });

        session.selectedElement = fieldId;
        session.isColorSetMode = true;
        document.body.classList.add('mode-analysis-color');
    }

    if (isClosing && session.backupColors) {
        Object.keys(visibleColors).forEach(color => {
            visibleColors[color] = session.backupColors.includes(color);
        });
        session.backupColors = null;
    }

    Object.keys(visibleColors).forEach(color => {
        const chk = document.getElementById(`chk-filter-${color}`);
        if (chk) chk.checked = visibleColors[color];
    });

    if (currentAnalysis.serverSchema) {
        renderDynamicFields(currentAnalysis.serverSchema, currentAnalysis);
    }
    render();
}

/**
 * @brief Переключает интерактивный режим изменения и захвата разметки позиций для анализа.
 * @param {string} fieldId - Уникальный идентификатор поля из схемы.
 */
export function toggleAnalysisMarkingCapture(fieldId) {
    const session = getAnalysisSession();
    const currentAnalysis = getAnalysisState();

    const isClosing = (session.selectedElement === fieldId && session.isMarkingSetMode);
    if (!currentAnalysis.params) currentAnalysis.params = {};

    if (!isClosing && session.selectedElement) {
        const oldElement = session.selectedElement;
        if (session.isMarkingSetMode) {
            toggleAnalysisMarkingCapture(oldElement);  // Закрываем режим разметки старого поля
        } else if (session.isColorSetMode) {
            toggleAnalysisColorCapture(oldElement);  // Закрываем режим цвета старого поля
        }
    }

    if (isClosing) {
        currentAnalysis.params[fieldId] = createTokensSnapshot();
        setAnalysisState(currentAnalysis);
        saveToLocalStorage();

        if (session.backupMarking) restoreTokensFromSnapshot(session.backupMarking);
        session.selectedElement = null;
        session.isMarkingSetMode = false;
        session.backupMarking = null;

    } else {
        session.backupMarking = createTokensSnapshot();
        if (currentAnalysis.params[fieldId] &&
            typeof currentAnalysis.params[fieldId] === 'object') {
            restoreTokensFromSnapshot(currentAnalysis.params[fieldId]);
        } else {
            // Если сохраненных параметров нет, инициализируем пустую разметку (0 фишек)
            const emptySnapshot = {};
            getState().places.forEach(p => {
                emptySnapshot[p.uuid] = 0;
            });

            currentAnalysis.params[fieldId] = emptySnapshot;
            setAnalysisState(currentAnalysis);
            saveToLocalStorage();
            restoreTokensFromSnapshot(emptySnapshot);
        }

        session.selectedElement = fieldId;
        session.isMarkingSetMode = true;
    }

    if (currentAnalysis.serverSchema) {
        renderDynamicFields(currentAnalysis.serverSchema, currentAnalysis);
    }
    render();
}

/**
 * @brief Заполняет параметр разметки значениями initialTokens из всех существующих позиций.
 */
export function resetAnalysisMarkingToInitial(fieldId) {
    if (!confirm(
            'Вы уверены, что хотите восстановить разметку для анализа из исходных настроек позиций холста?'))
        return;

    const currentAnalysis = getAnalysisState();
    if (!currentAnalysis.params) currentAnalysis.params = {};

    const markingSnapshot = {};
    getState().places.forEach(p => {
        markingSnapshot[p.uuid] = p.initialTokens !== undefined ? p.initialTokens : p.tokens;
    });

    currentAnalysis.params[fieldId] = markingSnapshot;
    setAnalysisState(currentAnalysis);
    saveToLocalStorage();

    const session = getAnalysisSession();
    if (session.selectedElement === fieldId && session.isMarkingSetMode) {
        restoreTokensFromSnapshot(markingSnapshot);
    }

    if (currentAnalysis.serverSchema) {
        renderDynamicFields(currentAnalysis.serverSchema, currentAnalysis);
    }
}

/**
 * @brief Обнуляет все фишки в разметке параметров анализа.
 */
export function clearAnalysisMarkingToEmpty(fieldId) {
    if (!confirm(
            'Вы уверены, что хотите сделать разметку для анализа абсолютно пустой (0 фишек во всех позициях)?'))
        return;

    const currentAnalysis = getAnalysisState();
    if (!currentAnalysis.params) currentAnalysis.params = {};

    const markingSnapshot = {};
    getState().places.forEach(p => {
        markingSnapshot[p.uuid] = 0;
    });

    currentAnalysis.params[fieldId] = markingSnapshot;
    setAnalysisState(currentAnalysis);
    saveToLocalStorage();

    const session = getAnalysisSession();
    if (session.selectedElement === fieldId && session.isMarkingSetMode) {
        restoreTokensFromSnapshot(markingSnapshot);
    }

    if (currentAnalysis.serverSchema) {
        renderDynamicFields(currentAnalysis.serverSchema, currentAnalysis);
    }
}



/**
 * @brief Генерирует плоский список переходов для конкретного набора разрешенных цветов.
 * @details Учитывает цвета самого перехода, дуг и позиций, отсекая только не подходящие по цвету
 * связи.
 * @param {string[]} allowedColors - Массив названий цветов (например, ['red', 'blue']).
 */
function buildTransitionsList(allowedColors) {
    if (!Array.isArray(allowedColors) || allowedColors.length === 0) {
        return [];
    }

    const state = getState();
    const transitionsList = [];

    state.transitions.forEach(t => {
        const tColor = t.color || 'black';
        if (!allowedColors.includes(tColor)) return;

        const inputs = {}; 
        state.arcs.filter(a => a.targetId === t.uuid).forEach(a => {
            const arcColor = a.color || 'black';
            if (!allowedColors.includes(arcColor)) return;

            const srcPlace = state.places.find(p => p.uuid === a.sourceId);
            if (srcPlace) {
                const placeColor = srcPlace.color || 'black';
                if (!allowedColors.includes(placeColor)) return;

                const weight = a.weight || 1;
                inputs[srcPlace.name] = (inputs[srcPlace.name] || 0) + weight;
            }
        });

        const outputs = {};

        state.arcs.filter(a => a.sourceId === t.uuid).forEach(a => {
            const arcColor = a.color || 'black';
            if (!allowedColors.includes(arcColor)) return;

            const tgtPlace = state.places.find(p => p.uuid === a.targetId);
            if (tgtPlace) {
                const placeColor = tgtPlace.color || 'black';
                if (!allowedColors.includes(placeColor)) return;

                const weight = a.weight || 1;
                outputs[tgtPlace.name] = (outputs[tgtPlace.name] || 0) + weight;
            }
        });
        transitionsList.push({name: t.name, inputs: inputs, outputs: outputs});
    });

    return transitionsList;
}

/**
 * @brief Собирает полные данные анализа и отправляет задачу на сервер обработки.
 */
export async function submitAnalysisTask() {
    const currentAnalysis = getAnalysisState();
    const typeId = currentAnalysis.selectedType;
    if (!typeId) {
        alert('Пожалуйста, выберите вид анализа.');
        return;
    }

    const serverUrl = getAnalysisSession().defaultServer.replace(/\/+$/, '');
    if (!serverUrl) {
        alert('Укажите адрес сервера.');
        return;
    }

    updateConnectionIndicator('loading');
    const payload = {analysis_type: typeId, params: structuredClone(currentAnalysis.params || {})};

    const params = currentAnalysis.params || {};
    const validColors = ['black', 'red', 'blue', 'green'];

    Object.keys(params).forEach(fieldId => {
        const value = params[fieldId];
        if (Array.isArray(value) && value.length > 0) {
            const isColorFilter = value.every(item => validColors.includes(item));
            if (isColorFilter) {
                payload.params[fieldId] = buildTransitionsList(value);
            }
        }
    });


    try {
        const response = await fetch(`${serverUrl}/api/v1/submit_task`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error(`Ошибка создания задачи: ${response.status}`);

        const data = await response.json();
        if (data && data.taskId) {
            const session = getAnalysisSession();
            // Запоминаем задачу
            session.taskId = data.taskId;
            session.taskStatus = 'active';
            session.shortResult = null;

            pushDispatcherTask({
                taskId: data.taskId,
                serverUrl: serverUrl,
                typeName: currentAnalysis.selectedTypeName || 'Анализ',
                taskStatus: 'active',
                shortResult: null
            });

            renderAnalysisTaskControl();
            startPolling(data.taskId, serverUrl);
        } else {
            throw new Error('Сервер не вернул taskId');
        }
        updateConnectionIndicator('online');

    } catch (error) {
        console.error('Ошибка при отправке задачи анализа:', error);
        alert(`Не удалось отправить задачу: ${error.message}`);
        updateConnectionIndicator('offline');
        analysisTimeout = setTimeout(() => loadAnalysisTypes(), 5000);
    }
}