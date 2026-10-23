// Функция переключения темы (вызывается по клику на кнопку)
export function toggleTheme() {
    const body = document.body;
    const btn = document.getElementById('theme-btn');
    body.classList.toggle('dark-theme');

    const isDark = body.classList.contains('dark-theme');
    updateThemeButton(btn, isDark);

    localStorage.setItem('inverted', isDark);
}

function updateThemeButton(btn, isDark) {
    if (!btn) return;

    const label = btn.querySelector('.theme-label');
    if (label) {
        label.textContent = isDark ? 'Светлая тема' : 'Тёмная тема';
    } else {
        // Запасной вариант для старой разметки
        btn.innerHTML = isDark ? '☀️ Светлая тема' : '🌙 Тёмная тема';
    }

    btn.setAttribute('aria-label', isDark ? 'Включить светлую тему' : 'Включить тёмную тему');
}

function applyDarkTheme() {
    document.body.classList.add('dark-theme');
    updateThemeButton(document.getElementById('theme-btn'), true);
}

export function loadToggleTheme() {
    if (localStorage.getItem('inverted') === 'true') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', applyDarkTheme);
        } else {
            applyDarkTheme();
        }
    }
}
