const CACHE_NAME = 'petri-editor-v1.35'; // МЕНЯЙТЕ ВЕРСИЮ ДЛЯ ОБНОВЛЕНИЯ (v2, v3...)
const ASSETS = [
  './',
  './index.html',
  './client/styles.css',
  './client/editor.js',
  './client/manifest.json',
  './client/icon.png',
  './client/modules/events.js',
  './client/modules/hotkeys.js',
  './client/modules/render.js',
  './client/modules/state.js',
  './client/modules/storage.js',
  './client/modules/theme.js'
];

// Установка: кэшируем все ресурсы
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting()) // Активируем сразу
  );
});

// Активация: удаляем старые версии кэша, если они были
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim()) // Перехватываем управление вкладками мгновенно
  );
});

// Перехват запросов: онлайн — свежие файлы и обновление кэша, офлайн — из кэша
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, copy);
          });
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

