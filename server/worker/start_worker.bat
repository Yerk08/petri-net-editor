@echo off
chcp 65001 >nul
cd /d "%~dp0"
set MASTER_URL=https://petricalc.duckdns.org
set MAX_CORES=8

echo Проверка и установка библиотек...
pip install -q numpy numba psutil

echo Запуск воркера для %MASTER_URL% (потоков: %MAX_CORES%)...
python -u worker.py
pause
