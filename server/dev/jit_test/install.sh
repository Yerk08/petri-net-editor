#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="numba-wasm"
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"

if command -v micromamba &> /dev/null; then
    MAMBA_BIN="$(command -v micromamba)"
elif [ -x "./bin/micromamba" ]; then
    MAMBA_BIN="./bin/micromamba"
else
    mkdir -p bin
    curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xvj -C bin --strip-components=1 bin/micromamba
    MAMBA_BIN="./bin/micromamba"
fi

if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi
./.venv/bin/pip install --upgrade pip empack pyjs-code-runner playwright -q

if [ ! -d "./env" ]; then
    "$MAMBA_BIN" create -p ./env \
      -c https://prefix.dev/emscripten-forge-4x \
      -c https://prefix.dev/conda-forge \
      --platform=emscripten-wasm32 \
      python=3.13 pyjs "numpy=2.4.*" "llvmlite=0.48.0" "numba=0.66.0" -y
fi

echo "Установка завершена."
