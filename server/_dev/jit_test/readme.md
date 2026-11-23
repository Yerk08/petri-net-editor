# Numba + Scientific Python в WebAssembly (Emscripten-Forge)

Запуск полноценного Python 3.13 с JIT-компиляцией **Numba (`@njit`)**, `numpy`, `scipy`, `pymc` и `dolo` в браузере без бэкенда.

Архитектура разделена на два слоя:
1. **Фронтенд (GitHub Pages / любая статика):** легкий HTML/JS интерфейс, запускающий вычисления в фоновом `Blob` Web Worker.
2. **CDN / Сервер ассетов (VPS / S3 / Nginx):** статическая папка `dist/` с рантаймом `pyjs_runtime_browser.wasm` и упакованными пакетами (`empack`).

---

## 1. Сборка окружения (`install.sh`)

Скрипт скачивает `micromamba`, собирает кросс-платформенное окружение `emscripten-wasm32` из каналов `emscripten-forge-4x` и `conda-forge`, а затем упаковывает его через `empack` в папку `numba-wasm/dist`.

```bash
#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="numba-wasm"
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"

# 1. Получаем micromamba
if command -v micromamba &> /dev/null; then
    MAMBA_BIN="$(command -v micromamba)"
elif [ -x "./bin/micromamba" ]; then
    MAMBA_BIN="./bin/micromamba"
else
    mkdir -p bin
    curl -Ls https://mamba.pm | tar -xvj -C bin --strip-components=1 bin/micromamba
    MAMBA_BIN="./bin/micromamba"
fi

# 2. Устанавливаем empack
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi
./.venv/bin/pip install --upgrade pip empack -q

# 3. Собираем WASM-окружение
rm -rf ./env ./dist
"$MAMBA_BIN" create -p ./env \
  --override-channels \
  -c https://prefix.dev \
  -c https://prefix.dev \
  --platform=emscripten-wasm32 \
  python=3.13 pyjs \
  "numpy=2.4.*" scipy pandas matplotlib-base \
  "llvmlite=0.48.0" "numba=0.66.0" \
  "pytensor-base=3.2.4" "pymc-base=6.2.0" \
  "interpolation=2.2.7" legacy-cgi "dolo=0.4.9.20" \
  -y

# 4. Упаковываем в статику dist/
mkdir -p ./dist
./.venv/bin/empack pack env --env-prefix ./env --out-dir ./dist
cp ./env/lib_js/pyjs/pyjs_runtime_browser.* ./dist/
```

Запуск сборки:
```bash
chmod +x install.sh && ./install.sh
```

---

## 2. Локальный запуск для разработки (`run.sh`)

Поднимает локальный HTTP-сервер с поддержкой CORS (`Access-Control-Allow-Origin: *`) для тестирования кросс-доменной загрузки из воркера.

```bash
#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-9000}"
DIST_DIR="numba-wasm/dist"

python3 -c "
import http.server, functools

class CORSHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

http.server.ThreadingHTTPServer(
    ('0.0.0.0', ${PORT}),
    functools.partial(CORSHandler, directory='${DIST_DIR}')
).serve_forever()
"
```

---

## 3. Подключение на фронтенде (GitHub Pages)

Поскольку браузеры запрещают создавать `new Worker('https://other-domain.com...')` напрямую, воркер инициализируется через локальный `Blob`, внутри которого подключаются скрипты и `.wasm` с внешнего сервера.

### Ключевые особенности инициализации:
* **`locateFile`:** перенаправляет загрузку `pyjs_runtime_browser.wasm` на внешний CDN.
* **`loadDynamicLibrary(..., { global: true })`:** принудительно экспортирует C-символы Numba (`NRT_adapt_ndarray_from_python`, `numba_get_np_random_state`) в глобальную таблицу линкера Emscripten, чтобы работали массивы `ndarray` и `np.random` внутри `@njit`.

```html
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <title>Numba WASM Worker</title>
</head>
<body>
  <pre id="out">Инициализация...</pre>

  <script>
    const out = document.getElementById('out');
    const log = (t) => { out.textContent += '\n' + t; };

    // Укажите URL сервера, где лежит содержимое папки dist/ (обязательно HTTPS для GitHub Pages)
    const CDN_BASE = 'https://example.com';

    const workerCode = `
      const CDN_BASE = '${CDN_BASE}';
      importScripts(CDN_BASE + '/pyjs_runtime_browser.js');

      let pyjs = null;

      async function initPyjs() {
        pyjs = await createModule({
          locateFile: (path) => CDN_BASE + '/' + path,
          print: (text) => self.postMessage({ type: 'stdout', text }),
          printErr: (text) => self.postMessage({ type: 'stderr', text })
        });

        await pyjs.bootstrap_from_empack_packed_environment(
          CDN_BASE + '/empack_env_meta.json',
          CDN_BASE,
          false
        );

        // Глобальная регистрация .so модулей Numba для динамического линкера WASM
        pyjs.exec(\`
import os, numba
numba_dir = os.path.dirname(numba.__file__)
so_files = [
    os.path.join(root, f)
    for root, _, files in os.walk(numba_dir)
    for f in files if f.endswith('.so')
]
        \`);
        for (const soPath of pyjs.eval('so_files')) {
          await pyjs.loadDynamicLibrary(soPath, {
            loadAsync: true,
            global: true,
            nodelete: true
          });
        }

        self.postMessage({ type: 'ready' });
      }

      self.onmessage = async (e) => {
        if (e.data.type === 'init') {
          try { await initPyjs(); }
          catch (err) { self.postMessage({ type: 'error', error: String(err) }); }
        } else if (e.data.type === 'exec') {
          try {
            pyjs.exec(e.data.code);
            self.postMessage({ type: 'done' });
          } catch (err) {
            self.postMessage({ type: 'error', error: String(err) });
          }
        }
      };
    `;

    const worker = new Worker(
      URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' }))
    );

    worker.onmessage = (e) => {
      const { type, text, error } = e.data;
      if (type === 'stdout') log(text);
      else if (type === 'stderr') log('[ERR] ' + text);
      else if (type === 'error') log('[FATAL] ' + error);
      else if (type === 'ready') {
        log('Python готов. Запуск @njit...\n');
        worker.postMessage({
          type: 'exec',
          code: `
import time, numpy as np
from numba import njit

@njit
def monte_carlo_pi(n):
    acc = 0
    for _ in range(n):
        if np.random.random()**2 + np.random.random()**2 < 1.0:
            acc += 1
    return 4.0 * acc / n

t0 = time.time()
res = monte_carlo_pi(5_000_000)
print(f"Pi = {res:.6f} за {time.time() - t0:.3f} сек")
          `
        });
      }
    };

    worker.postMessage({ type: 'init' });
  </script>
</body>
</html>
```

---

## 4. Деплой ассетов на сервер (Nginx)

1. Скопируйте содержимое `numba-wasm/dist/` на ваш сервер (например, в `/var/www/numba-wasm/dist/`).
2. Настройте HTTPS (Let's Encrypt), иначе GitHub Pages заблокирует загрузку по `http://` (Mixed Content).
3. Добавьте конфигурацию в Nginx:

```nginx
location /numba-wasm/ {
    alias /var/www/numba-wasm/dist/;

    add_header Access-Control-Allow-Origin "https://<username>.github.io" always;
    add_header Access-Control-Allow-Methods "GET, OPTIONS" always;
    add_header Cross-Origin-Resource-Policy "cross-origin" always;
    add_header Cache-Control "public, max-age=31536000, immutable";

    types {
        application/wasm wasm;
        application/javascript js;
        application/json json;
        application/gzip gz;
    }
}
```

---

## 5. Известные ограничения WebAssembly (`wasm32`)

* **Однопоточность:** `@njit(parallel=True)` и `prange` выполняются в одном потоке без OpenMP/TBB.
* **Память:** максимальный объем линейной памяти WASM ограничен ~2–4 ГБ на вкладку (базовый расход окружения с LLVM составляет ~220 МБ). Проверить текущий объем из консоли: `(pyjs.HEAP8.length / 1024 / 1024).toFixed(1) + ' MB'`.
* **Файловая система и сеть:** работа с файлами происходит в виртуальной памяти браузера (`MEMFS`), прямые TCP-сокеты недоступны.

