FROM python:3.11-slim
WORKDIR /app
# Ставим numpy и numba согласно ТЗ
RUN pip install --no-cache-dir numpy numba
COPY worker.py /app/worker.py
CMD ["python3", "-u", "/app/worker.py"]

