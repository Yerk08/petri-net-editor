#!/usr/bin/env bash
set -euo pipefail
cd numba-wasm

# Упаковываем окружение, если dist еще не собран
if [ ! -f "./dist/empack_env_meta.json" ]; then
    rm -rf ./dist && mkdir -p ./dist
    ./.venv/bin/empack pack env --env-prefix ./env --outdir ./dist
    cp ./env/lib_js/pyjs/pyjs_runtime_browser.* ./dist/
fi

# Генерируем чистый index.html с официальным загрузчиком pyjs 4.1.0
cat << 'EOF' > ./dist/index.html
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <title>Numba WASM (Emscripten-Forge)</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
    pre { background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 6px; overflow-x: auto; line-height: 1.4; }
  </style>
</head>
<body>
  <h2>Numba @njit в WebAssembly</h2>
  <pre id="out">Загрузка WASM и распаковка пакетов...</pre>

  <script src="./pyjs_runtime_browser.js"></script>
  <script>
    const out = document.getElementById('out');
    const log = (t) => { out.textContent += '\n' + t; };

    async function main() {
      try {
        const pyjs = await createModule({
          print: (t) => log(t),
          printErr: (t) => log('[ERR] ' + t)
        });

        await pyjs.bootstrap_from_empack_packed_environment(
          './empack_env_meta.json',
          '.',
          false
        );

        // Находим все .so внутри numba и загружаем их с global: true,
        // чтобы NRT_adapt_ndarray_from_python и random-символы были видны JIT-модулям
        pyjs.exec(`
import os, numba
numba_dir = os.path.dirname(numba.__file__)
so_files = []
for root, _, files in os.walk(numba_dir):
    for f in files:
        if f.endswith('.so'):
            so_files.append(os.path.join(root, f))
        `);
        const soFiles = pyjs.eval('so_files');
        for (const soPath of soFiles) {
          await pyjs.loadDynamicLibrary(soPath, {
            loadAsync: true,
            global: true,
            nodelete: true
          });
        }

        log('Python и символы Numba NRT готовы. Запуск JIT-компиляции...\n');

        pyjs.exec(`
import time
import numpy as np
from numba import njit

@njit
def compute_pi_leibniz(n):
    acc = 0.0
    for i in range(n):
        term = 1.0 / (2 * i + 1)
        if i % 2 == 0:
            acc += term
        else:
            acc -= term
    return 4.0 * acc

@njit
def sum_sin_cos(arr):
    total = 0.0
    for i in range(arr.shape[0]):
        total += np.sin(arr[i]) * np.cos(arr[i])
    return total

@njit
def monte_carlo_pi(n):
    acc = 0
    for _ in range(n):
        x = np.random.random()
        y = np.random.random()
        if x*x + y*y < 1.0:
            acc += 1
    return 4.0 * acc / n

t0 = time.time()
_ = compute_pi_leibniz(100)
t1 = time.time()

t2 = time.time()
pi_est = compute_pi_leibniz(50_000_000)
t3 = time.time()

arr = np.linspace(0, 100, 5_000_000)
_ = sum_sin_cos(arr[:10])
t4 = time.time()
s = sum_sin_cos(arr)
t5 = time.time()

_ = monte_carlo_pi(100)
t6 = time.time()
pi_mc = monte_carlo_pi(5_000_000)
t7 = time.time()

print(f"JIT компиляция: {t1 - t0:.2f} сек")
print(f"Pi (ряд Лейбница, 50M): {pi_est:.8f} за {t3 - t2:.3f} сек")
print(f"NumPy sin*cos (5M): {s:.6f} за {t5 - t4:.3f} сек")
print(f"Monte Carlo np.random (5M): {pi_mc:.6f} за {t7 - t6:.3f} сек")
        `);
      } catch (err) {
        log('Ошибка: ' + err);
        console.error(err);
      }
    }

    main();
  </script>
</body>
</html>
EOF

echo "Сервер запущен: http://localhost:8000"
python3 -m http.server --directory ./dist 8000

