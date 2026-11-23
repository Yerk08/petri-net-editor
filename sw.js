const CACHE_NAME = 'petri-editor-v1.47'; // МЕНЯЙТЕ ВЕРСИЮ ДЛЯ ОБНОВЛЕНИЯ (v2, v3...)
const JIT_CACHE_NAME = 'petri-jit-cache-v1';
const JIT_TTL_MS = 7 * 86400 * 1000; // 7 дней в миллисекундах
const JIT_META_KEY = '/__jit_last_used__';

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
  './client/modules/theme.js',
  './client/modules/analysis.js',
  './client/modules/dispatcher.js',
  './client/modules/web-worker.js'
];

// Проверяет, не устарел ли кэш jit/ (если прошло > 7 дней с последнего визита — удаляет)
async function cleanupExpiredJitCache() {
  const hasJit = await caches.has(JIT_CACHE_NAME);
  if (!hasJit) return;

  const cache = await caches.open(JIT_CACHE_NAME);
  const metaResp = await cache.match(JIT_META_KEY);
  if (metaResp) {
    const lastUsed = Number(await metaResp.text());
    if (Date.now() - lastUsed > JIT_TTL_MS) {
      await caches.delete(JIT_CACHE_NAME);
    }
  }
}

// Обновляет таймер жизни кэша jit/ (продлевает еще на 7 дней)
async function touchJitCache() {
  const cache = await caches.open(JIT_CACHE_NAME);
  await cache.put(JIT_META_KEY, new Response(String(Date.now())));
}

// Установка: кэшируем все ресурсы редактора
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Активация: чистим старые версии кэша редактора и устаревший jit-кэш
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME && key !== JIT_CACHE_NAME) {
              return caches.delete(key);
            }
          })
        )
      ),
      cleanupExpiredJitCache()
    ]).then(() => self.clients.claim())
  );
});

// Перехват запросов
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Отдельное кэширование тяжелых WASM/empack файлов из /jit/ (Cache-First + TTL 7 дней)
  if (event.request.method === 'GET' && url.pathname.includes('/jit/')) {
    event.respondWith(
      (async () => {
        await cleanupExpiredJitCache();
        const cache = await caches.open(JIT_CACHE_NAME);
        const cached = await cache.match(event.request);

        if (cached) {
          event.waitUntil(touchJitCache()); // Продлеваем жизнь кэша еще на 7 дней
          return cached;
        }

        const networkResp = await fetch(event.request);
        if (networkResp.ok) {
          await cache.put(event.request, networkResp.clone());
          await touchJitCache();
        }
        return networkResp;
      })()
    );
    return;
  }

  // 2. Обычные ресурсы редактора
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request);
    })
  );
});
