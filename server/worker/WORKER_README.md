# Подключение внешнего вычислительного узла (Worker)

Вы можете подключить свой компьютер (Windows, Linux или macOS) к кластеру `https://petricalc.duckdns.org` для ускорения расчетов.

## 1. Запуск через Python (рекомендуется для Windows)

### Требования
* Установленный **Python 3.10 – 3.12** ([скачать с python.org](https://python.org)). При установке на Windows обязательно поставьте галочку **Add Python to PATH**.

### Шаг 1. Установка зависимостей
Откройте терминал (PowerShell или CMD на Windows, Bash на Linux) в папке с файлом `worker.py` и выполните:

```bash
pip install numpy numba psutil
```
*(Примечание: если `worker.py` использует стандартный `urllib` вместо `requests`).*

### Шаг 2. Запуск воркера

**Windows (PowerShell):**
```powershell
$env:MASTER_URL="https://petricalc.duckdns.org/"
$env:MAX_CORES="8"
python -u worker.py
```

**Windows (CMD / командная строка):**
```cmd
set MASTER_URL=https://petricalc.duckdns.org/
set MAX_CORES=8
python -u worker.py
```

**Linux / macOS:**
```bash
MASTER_URL=https://petricalc.duckdns.org/ MAX_CORES=8 python3 -u worker.py
```

> Параметр `MAX_CORES` задает максимальное количество потоков/ядер, которое воркер займет на вашем ПК.

Для остановки узла нажмите **Ctrl + C** в окне терминала — воркер штатно отключится от кластера (`/worker/unregister`).

---

## 2. Запуск через Docker (если установлен Docker Desktop)

Если на машине установлен Docker, Python ставить не нужно. Положите `Dockerfile` и `worker.py` в одну папку и выполните:

```bash
docker build -t petri-worker .
docker run -d --restart unless-stopped \
  -e MASTER_URL=https://petricalc.duckdns.org/ \
  -e MAX_CORES=8 \
  --name petri-worker \
  petri-worker
```

Для остановки и удаления контейнера:
```bash
docker stop petri-worker && docker rm petri-worker
```
