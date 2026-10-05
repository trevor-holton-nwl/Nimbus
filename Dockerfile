# syntax=docker/dockerfile:1
# NIMBUS single-container image: FastAPI serves both the API and the static
# frontend (same origin). Build in the cloud with:  az acr build -r <ACR> -t nimbus:v1 .

# Frontend build stage: compiles the TypeScript modules tracked in
# docs/archive/typescript_migration.md (frontend/*.ts, frontend/*.mts) to their in-place .js/.mjs
# output. COPY frontend ./frontend happens right before RUN npm run build so Docker's layer
# cache invalidates correctly whenever any file under frontend/ changes — no risk of a
# stale compiled-output layer surviving a source edit.
FROM node:22.23.3-slim AS frontendbuild
WORKDIR /build
COPY package.json package-lock.json tsconfig.json tsconfig.worker.json ./
RUN npm ci
COPY frontend ./frontend
RUN npm run build

# Cache-bust stamp: pass the git SHA at build time, e.g.
#   az acr build -r <ACR> -t nimbus:vN --build-arg BUILD_ID=$(git rev-parse --short HEAD) .
# It overwrites the hand-set NIMBUS_BUILD_ID / styles.css?v= in index.html. Without the arg
# (local dev, plain docker build) the hand stamp already in index.html is kept as-is.
ARG BUILD_ID=
RUN if [ -n "$BUILD_ID" ]; then \
      case "$BUILD_ID" in *[!A-Za-z0-9._-]*) echo "invalid BUILD_ID" >&2; exit 1;; esac; \
      sed -i -E -e "s/(NIMBUS_BUILD_ID = ')[^']*(')/\1${BUILD_ID}\2/" -e 's/(styles\.css\?v=)[^"]*/\1'"${BUILD_ID}"'/' frontend/index.html; \
      grep -q "NIMBUS_BUILD_ID = '${BUILD_ID}'" frontend/index.html; \
      grep -q "styles.css?v=${BUILD_ID}\"" frontend/index.html; \
    fi

FROM python:3.12.15-slim

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

# The frontend now lives under frontend/ in the repo, so a single directory copy is
# the whole isolation boundary: the public ingress serves ONLY /app/frontend, which
# never contains brain.py / db.py / master_data.py / backend/ / schema.sql. Add
# a new frontend file under frontend/ and it's picked up automatically — no list to maintain.
# Copied from the frontendbuild stage (not this stage's own COPY . .) so the served
# tree includes tsc's compiled output, not just the checked-in .ts/.mts sources.
COPY --from=frontendbuild /build/frontend/ /app/frontend/

# Run as a non-root user; it owns the app dir and the writable color-wheel dir.
RUN useradd --create-home --uid 10001 nimbus \
 && mkdir -p /data \
 && chown -R nimbus:nimbus /app /data
USER nimbus

EXPOSE 8000

# Single worker on purpose: the color-wheel cache and the log ring buffer are
# in-process. 0.0.0.0 so Azure Container Apps ingress can reach the listener.
CMD ["uvicorn", "brain:api", "--host", "0.0.0.0", "--port", "8000"]
