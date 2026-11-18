/**
 * @file hotkeys.js
 * @brief Модуль диспетчеризации глобальных горячих клавиш и клавиатурных макросов.
 * @details Настраивает слушатели клавиатурных событий для быстрого переключения инструментов,
 *          удаления объектов, управления шагами симуляции (Undo/Redo), изменения цветов,
 *          а также реализует изолированный буфер обмена для копирования узлов вместе с их дугами.
 */

import {selectObject} from '../editor.js';

import {render} from './render.js';
import {arcSourceId, currentMode, deleteObject, dragTarget, findComment, findNode, fireTransition, getState, selectedId, setArcSourceId, setDragTarget, setSelectedId} from './state.js';
import {importFromFile} from './storage.js';

/**
 * @brief Внутренний изолированный буфер обмена для операций копирования и вставки.
 * @details Хранит сериализованный снимок узла, его тип и массив метаданных связанных дуг.
 *          `{ type: string, sourceUuid: string, node: Object, arcs: Array<Object> }`
 */
let clipboardData = null;

/**
 * @brief Инициализирует глобальный перехватчик клавиатурных событий `keydown`.
 * @details Навешивает слушатель на объект `window` и организует каскадную проверку условий.
 */
export function initHotKeys() {
    window.addEventListener('keydown', function(e) {
        // Если фокус находится в полях ввода, полностью отключаем глобальные горячие клавиши
        const targetTag = e.target.tagName.toUpperCase();
        if (targetTag === 'INPUT' || targetTag === 'TEXTAREA' || e.target.isContentEditable) {
            return;
        }

        const isCtrl = e.ctrlKey || e.metaKey;  // Поддержка Win/Linux (Ctrl) и Mac (Cmd)
        const code = e.code;

        // Системные комбинации браузера (обновление, новая вкладка, закрытие, печать и т.д.)
        const browserCodes = ['KeyR', 'KeyT', 'KeyW', 'KeyI', 'KeyP'];
        if (isCtrl && browserCodes.includes(code)) {
            return;
        }

        // --- 1. ОПЕРАЦИИ СИМУЛЯЦИИ (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) ---
        if (currentMode === 'simulation' && isCtrl) {
            if (code === 'KeyZ') {
                e.preventDefault();
                if (e.shiftKey) {
                    window.redoTransition();  // Ctrl + Shift + Z
                } else {
                    window.undoTransition();  // Ctrl + Z
                }
                return;
            }
            if (code === 'KeyY') {
                e.preventDefault();
                window.redoTransition();  // Ctrl + Y (альтернатива)
                return;
            }
        }

        // --- 2. КОПИРОВАНИЕ И ВСТАВКА ---
        if (isCtrl && currentMode !== 'simulation') {
            // Ctrl+C операция
            if (code === 'KeyC') {
                if (!selectedId) return;
                const node = findNode(selectedId) || findComment(selectedId);
                if (node) {
                    e.preventDefault();
                    const isPlace = getState().places.some(p => p.uuid === selectedId);
                    const isTrans = getState().transitions.some(t => t.uuid === selectedId);
                    const type = isPlace ? 'place' : (isTrans ? 'transition' : 'comment');

                    const connectedArcs = getState().arcs.filter(
                        arc => arc.sourceId === selectedId || arc.targetId === selectedId);
                    clipboardData = {
                        type: type,
                        sourceUuid: selectedId,
                        node: structuredClone(node),
                        arcs: structuredClone(connectedArcs)
                    };
                }
                return;
            }

            // Ctrl+V операция
            if (code === 'KeyV' && clipboardData) {
                e.preventDefault(); // Добавлено, чтобы избежать лишних событий вставки
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

                if (clipboardData.arcs && clipboardData.arcs.length > 0) {
                    clipboardData.arcs.forEach(oldArc => {
                        let shouldCreateArc = false;
                        let finalSourceId = oldArc.sourceId;
                        let finalTargetId = oldArc.targetId;

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
        if ((code === 'Backspace' || code === 'Delete') && selectedId) {
            e.preventDefault();
            deleteObject(selectedId);
            return;
        }

        // --- 4. ПЕРЕКЛЮЧЕНИЕ РЕЖИМОВ ---
        // Работает в любой раскладке и при включенном CapsLock, но только без зажатого Ctrl/Alt
        if (!isCtrl && !e.altKey) {
            const modesMapping = {
                'KeyR': 'select',
                'KeyS': 'simulation',
                'KeyD': 'place',
                'KeyT': 'transition',
                'KeyA': 'arc',
                'KeyE': 'token',
                'KeyW': 'comment',
                'KeyF': 'analysis',
                'KeyV': 'dispatcher'
            };

            if (modesMapping[code]) {
                e.preventDefault();
                window.setMode(modesMapping[code]);
                return;
            }
        }

        // --- 5. ПЕРЕКЛЮЧЕНИЕ ФИЛЬТРОВ ЦВЕТОВ ---
        const colorsMapping = {
            'Digit1': 'black',
            'Digit2': 'red',
            'Digit3': 'blue',
            'Digit4': 'green'
        };

        if (colorsMapping[code]) {
            e.preventDefault();
            const color = colorsMapping[code];
            if (isCtrl) {  // Обновление цвета элемента
                if (selectedId) {
                    window.updateElementColor(selectedId, color);
                    render();
                    window.selectObject(selectedId);
                }
            } else {  // Инвертирование состояния фильтра видимости на панели
                const checkbox = document.getElementById(`chk-filter-${color}`);
                if (checkbox) {
                    checkbox.checked = !checkbox.checked;
                    window.toggleFilterColor(color);
                }
            }
        }
    });
}