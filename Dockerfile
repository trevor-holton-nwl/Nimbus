# syntax=docker/dockerfile:1
# NIMBUS single-container image: FastAPI serves both the API and the static
# frontend (same origin). Build in the cloud with:  az acr build -r <ACR> -t nimbus:v1 .

# Frontend build stage: compiles the TypeScript modules tracked in
# docs/typescript_migration.md (web/*.ts, web/*.mts) to their in-place .js/.mjs
# output. COPY web ./web happens right before RUN npm run build so Docker's layer
# cache invalidates correctly whenever any file under web/ changes — no risk of a
# stale compiled-output layer surviving a source edit.
FROM node:20-slim AS webbuild
WORKDIR /build
COPY package.json package-lock.json tsconfig.json tsconfig.worker.json ./
RUN npm ci
COPY web ./web
RUN npm run build

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    COLOR_FILE=/data/color_wheel.xlsx \
    COLOR_WHEEL_DIR=/data/color_wheels

WORKDIR /app

# Dependencies first for better layer caching. psycopg[binary] ships libpq in the
# wheel, so no system build tools / libpq-dev are needed on slim.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Backend code + everything else (schema.sql kept for reference; it is NOT served).
COPY . .

# The frontend now lives under web/ in the repo, so a single directory copy is
# the whole isolation boundary: the public ingress serves ONLY /app/web, which
# never contains brain.py / db.py / master_data.py / schema.sql. Add a new
# frontend file under web/ and it's picked up automatically — no list to maintain.
# Copied from the webbuild stage (not this stage's own COPY . .) so the served
# tree includes tsc's compiled output, not just the checked-in .ts/.mts sources.
COPY --from=webbuild /build/web/ /app/web/

# Run as a non-root user; it owns the app dir and the writable color-wheel dir.
RUN useradd --create-home --uid 10001 nimbus \
 && mkdir -p /data \
 && chown -R nimbus:nimbus /app /data
USER nimbus

EXPOSE 8000

# Single worker on purpose: the color-wheel cache and the log ring buffer are
# in-process. 0.0.0.0 so Azure Container Apps ingress can reach the listener.
CMD ["uvicorn", "brain:api", "--host", "0.0.0.0", "--port", "8000"]
