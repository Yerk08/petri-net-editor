import {selectObject} from '../editor.js';

import {render} from './render.js';
import {arcSourceId, currentMode, deleteObject, dragTarget, findComment, findNode, fireTransition, getState, selectedId, setArcSourceId, setDragTarget, setSelectedId} from './state.js';
import {importFromFile} from './storage.js';

// Буфер обмена для функций Ctrl+C / Ctrl+V
let clipboardData = null;

export function initHotKeys() {
    window.addEventListener('keydown', function(e) {
        // Если фокус находится в полях ввода, полностью отключаем глобальные горячие клавиши
        const targetTag = e.target.tagName.toUpperCase();
        if (targetTag === 'INPUT' || targetTag === 'TEXTAREA' || e.target.isContentEditable) {
            return;
        }

        const isCtrl = e.ctrlKey || e.metaKey;  // Поддержка Win/Linux (Ctrl) и Mac (Cmd)
        const key = e.key.toLowerCase();
        if (isCtrl && (key === 'r' || key === 't' || key === 'w' || key === 'i' || key === 'p')) {
            return;  // Прерываем функцию и отдаем управление браузеру
        }

        // --- 1. ОПЕРАЦИИ СИМУЛЯЦИИ (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) ---
        if (currentMode === 'simulation' && isCtrl) {
            if (e.key.toLowerCase() === 'z') {
                e.preventDefault();
                if (e.shiftKey) {
                    window.redoTransition();  // Ctrl + Shift + Z
                } else {
                    window.undoTransition();  // Ctrl + Z
                }
                return;
            }
            if (e.key.toLowerCase() === 'y') {
                e.preventDefault();
                window.redoTransition();  // Ctrl + Y (альтернатива)
                return;
            }
        }

        // --- 2. КОПИРОВАНИЕ И ВСТАВКА ---
        if (isCtrl && currentMode !== 'simulation') {
            // Ctrl+C операция
            if (e.key.toLowerCase() === 'c') {
                if (!selectedId) return;
                const node = findNode(selectedId) || findComment(selectedId);
                if (node) {
                    e.preventDefault();
                    const isPlace = getState().places.some(p => p.uuid === selectedId);
                    const isTrans = getState().transitions.some(t => t.uuid === selectedId);
                    const type = isPlace ? 'place' : (isTrans ? 'transition' : 'comment');

                    // Находим все дуги, которые связаны с этим копируемым узлом
                    const connectedArcs = getState().arcs.filter(
                        arc => arc.sourceId === selectedId || arc.targetId === selectedId);
                    clipboardData = {
                        type: getState().places.some(p => p.uuid === selectedId)    ? 'place' :
                            getState().transitions.some(t => t.uuid === selectedId) ? 'transition' :
                                                                                      'comment',
                        sourceUuid: selectedId,
                        node: structuredClone(node),
                        arcs: structuredClone(connectedArcs)
                    };
                }
                return;
            }

            // Ctrl+V операция
            if (e.key.toLowerCase() === 'v' && clipboardData) {
                const newX = clipboardData.node.x + 40;
                const newY = clipboardData.node.y + 40;
                clipboardData.node.x = newX;
                clipboardData.node.y = newY;
                let newUuid = '';

                if (clipboardData.type === 'place') {
                    newUuid = `P${getState().counters.P++}`;
                    const newPlace = {
                        ...structuredClone(clipboardData.node),
                        uuid: newUuid,
                        x: newX,
                        y: newY,
                        initialTokens: clipboardData.node.tokens
                    };
                    getState().places.push(newPlace);
                    selectObject(newUuid);
                } else if (clipboardData.type === 'transition') {
                    newUuid = `T${getState().counters.T++}`;
                    const newTrans =
                        {...structuredClone(clipboardData.node), uuid: newUuid, x: newX, y: newY};
                    getState().transitions.push(newTrans);
                    selectObject(newUuid);
                } else if (clipboardData.type === 'comment') {
                    newUuid = `C${getState().counters.C++}`;
                    const newComment =
                        {...structuredClone(clipboardData.node), uuid: newUuid, x: newX, y: newY};
                    if (!getState().comments) getState().comments = [];
                    getState().comments.push(newComment);
                    selectObject(newUuid);
                }

                // Проверяем дуги, которые мы скопировали вместе с узлом
                if (clipboardData.arcs && clipboardData.arcs.length > 0) {
                    clipboardData.arcs.forEach(oldArc => {
                        let shouldCreateArc = false;
                        let finalSourceId = oldArc.sourceId;
                        let finalTargetId = oldArc.targetId;

                        // Если скопированная дуга шла ИЗ нашего старого узла
                        if (oldArc.sourceId === clipboardData.sourceUuid) {
                            finalSourceId = newUuid;
                            if (findNode(oldArc.targetId)) {
                                shouldCreateArc = true;
                            }
                        }

                        if (oldArc.targetId === clipboardData.sourceUuid) {
                            finalTargetId = newUuid;
                            if (findNode(oldArc.sourceId)) {
                                shouldCreateArc = true;
                            }
                        }

                        const arcExists = getState().arcs.some(
                            a => a.sourceId === finalSourceId && a.targetId === finalTargetId);

                        if (shouldCreateArc && !arcExists) {
                            const newArc = {
                                ...structuredClone(oldArc),
                                uuid: `${finalSourceId}-${finalTargetId}`,
                                sourceId: finalSourceId,
                                targetId: finalTargetId
                            };
                            getState().arcs.push(newArc);
                        }
                    });
                }

                render();
                return;
            }
        }

        // --- 3. УДАЛЕНИЕ ЭЛЕМЕНТОВ (Backspace / Delete) ---
        if ((e.key === 'Backspace' || e.key === 'Delete') && selectedId) {
            e.preventDefault();
            deleteObject(selectedId);
            return;
        }

        // --- 4. ПЕРЕКЛЮЧЕНИЕ РЕЖИМОВ ---
        // Соответствует порядку: Select, Simulation, Place, Transition, Arc, Token, Comment
        const modesMapping = {
            'r': 'select',
            's': 'simulation',
            'd': 'place',
            't': 'transition',
            'a': 'arc',
            'e': 'token',
            'w': 'comment'
        };

        if (modesMapping[e.key]) {
            e.preventDefault();
            window.setMode(modesMapping[e.key]);
        }

        // --- 5. ПЕРЕКЛЮЧЕНИЕ ФИЛЬТРОВ ЦВЕТОВ ---
        // Соответствует порядку: 1 -> black, 2 -> red, 3 -> blue, 4 -> green
        const colorsMapping = {'1': 'black', '2': 'red', '3': 'blue', '4': 'green'};

        if (colorsMapping[e.key]) {
            e.preventDefault();
            const color = colorsMapping[e.key];
            if (isCtrl) {
                if (selectedId) {
                    window.updateElementColor(selectedId, color);
                    render();
                    window.selectObject(selectedId);
                }
            } else {
                const checkbox = document.getElementById(`chk-filter-${color}`);
                if (checkbox) {
                    checkbox.checked = !checkbox.checked;
                    window.toggleFilterColor(color);
                }
            }
        }
    });
}