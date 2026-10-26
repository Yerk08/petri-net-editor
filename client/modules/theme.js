/**
 * @file theme.js
 * @brief Модуль управления темой оформления приложения (светлая/тёмная).
 * @details Обеспечивает переключение CSS-классов темы, изменение текста на кнопках управления
 *          и сохранение/восстановление пользовательских предпочтений в LocalStorage.
 */

/**
 * @brief Переключает тему оформления между светлой и тёмной.
 * @details Функция инвертирует класс `dark-theme` на элементе `<body>`, обновляет текстовое
 *          содержимое кнопки переключения темы и сохраняет новое состояние в LocalStorage.
 *
 * @note **ИНСТРУКЦИЯ ПО РАСШИРЕНИЮ:** Если вы решите добавить третью тему (например, "системную"
 * или "высококонтрастную"), вам потребуется:
 * 1. Заменить метод `classList.toggle('dark-theme')` на циклическое переключение или явную
 * установку класса на основе текущего индекса массива тем.
 * 2. Обновить логику записи в LocalStorage, сохраняя строковое название темы вместо булева флага.
 */
export function toggleTheme() {
    const body = document.body;
    const btn = document.getElementById('theme-btn');
    body.classList.toggle('dark-theme');

    const isDark = body.classList.contains('dark-theme');
    if (isDark) {
        btn.innerHTML = '☀️ Светлая тема';
    } else {
        btn.innerHTML = '🌙 Тёмная тема';
    }

    localStorage.setItem('inverted', isDark);
}

/**
 * @brief Принудительно применяет тёмную тему к документу и обновляет текст кнопки.
 * @details Вспомогательная внутренняя функция, используемая при первоначальной загрузке страницы.
 */
function applyDarkTheme() {
    document.body.classList.add('dark-theme');
    const btn = document.getElementById('theme-btn');
    if (btn) btn.innerHTML = '☀️ Светлая тема';
}

/**
 * @brief Проверяет сохраненные настройки пользователя и восстанавливает тему при инициализации
 * приложения.
 * @details Анализирует ключ `inverted` в LocalStorage. Безопасно обрабатывает вызовы в зависимости
 * от текущего состояния готовности документа (`document.readyState`)
 */
export function loadToggleTheme() {
    if (localStorage.getItem('inverted') === 'true') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', applyDarkTheme);
        } else {
            applyDarkTheme();
        }
    }
}
