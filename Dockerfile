# syntax=docker/dockerfile:1
# NIMBUS single-container image: FastAPI serves both the API and the static
# frontend (same origin). Build in the cloud with:  az acr build -r <ACR> -t nimbus:v1 .
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    COLOR_FILE=/data/color_wheel.xlsx \
    COLOR_WHEEL_DIR=/data/color_wheels \
    NIMBUS_STATIC_DIR=/app/web

WORKDIR /app

# Dependencies first for better layer caching. psycopg[binary] ships libpq in the
# wheel, so no system build tools / libpq-dev are needed on slim.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Backend code + everything else (schema.sql kept for reference; it is NOT served).
COPY . .

# Serve ONLY the frontend from a dedicated dir so the public ingress never exposes
# brain.py / db.py / master_data.py / schema.sql as downloadable static files.
# NOTE: if you add a new frontend file, add it to this list.
RUN mkdir -p /app/web \
 && cp index.html styles.css app.js nimbus-intelligence.js nimbus-worker.js nimbus-compute-core.js /app/web/ \
 && cp -r locales /app/web/ \
 && cp -r Images /app/web/

# Run as a non-root user; it owns the app dir and the writable color-wheel dir.
RUN useradd --create-home --uid 10001 nimbus \
 && mkdir -p /data \
 && chown -R nimbus:nimbus /app /data
USER nimbus

EXPOSE 8000

# Single worker on purpose: the color-wheel cache and the log ring buffer are
# in-process. 0.0.0.0 so Azure Container Apps ingress can reach the listener.
CMD ["uvicorn", "brain:api", "--host", "0.0.0.0", "--port", "8000"]
