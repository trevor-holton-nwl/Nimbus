# Technology Stack

**Analysis Date:** 2026-06-17

## Languages

**Primary:**
- Python 3.x - Backend API and data layer (`brain.py`, `db.py`, `master_data.py`)
- JavaScript (vanilla ES6+) - Frontend UI, all modules in `app.js`, `nimbus-intelligence.js`, `nimbus-worker.js`
- SQL - PostgreSQL schema and queries (`schema.sql`)

**Secondary:**
- CSS3 - Styling with CSS variables and design tokens (`styles.css`)
- HTML5 - Document structure and inline styles (`index.html`)

## Runtime

**Environment:**
- Python 3 (via FastAPI runtime)
- Node.js (for static file serving during development; not required for deployment)
- Browser (modern ES6-capable: Chrome, Firefox, Safari, Edge)

**Package Manager:**
- pip (Python dependency manager)
- No npm/yarn (frontend uses only CDN-delivered libraries)

**Lockfile:** Missing - `requirements.txt` specified; no lockfile (pip.lock or poetry.lock)

## Frameworks

**Core:**
- FastAPI 0.x - HTTP API framework, ASGI server (`brain.py`)
- Uvicorn - ASGI server runtime for FastAPI (`brain.py` startup)

**Frontend Components:**
- vis-timeline 7.7.3 (Gantt chart timeline with drag-drop support) - `index.html`, CDN unpkg
- AG Grid Community 31.3.2 (data table with inline editing, filtering, pinning) - `index.html`, CDN jsdelivr
- Chart.js 4.4.4 (dashboard charts and utilization visualizations) - `index.html`, CDN jsdelivr
- Flatpickr 4.6.13 (date/time picker widget for modals) - `index.html`, CDN jsdelivr

**Fonts (Google Fonts):**
- Archivo 500, 600, 700, 800 (display headings)
- Public Sans 400, 500, 600, 700 (body text)
- JetBrains Mono 400, 500, 600 (monospace data)

**Data & State:**
- pandas - Data manipulation, Excel/CSV parsing (`brain.py`, `db.py`)
- numpy - Numeric operations (indirectly via pandas)

## Key Dependencies

**Critical:**
- FastAPI - HTTP framework, routing, dependency injection
- uvicorn - ASGI server for local dev and production deployment
- psycopg[binary] - Postgres client driver with binary extensions (psycopg 3.x)
- psycopg_pool - Connection pooling for stateless read-heavy workload (`db.py`)
- pandas - DataFrame engine for Excel ingest and data transformation
- openpyxl - Excel file I/O (`pandas.read_excel` backend for order uploads)
- pydantic - Request/response validation (FastAPI integration)
- python-dotenv - Environment variable loading from `.env` file

**Infrastructure:**
- PostgreSQL 18+ - Relational database, order storage, master data tables
- CORS middleware (fastapi.middleware.cors) - Cross-origin requests (allow_origins=["*"] for dev)

## Configuration

**Environment:**
- Configuration via environment variables in `.env` file (loaded by `python-dotenv`)
- **Postgres connection:** `PG_HOST`, `PG_PORT`, `PG_DB`, `PG_USER`, `PG_PASS`, `PG_SSLMODE`
- **Postgres pool tuning:** `NIMBUS_PG_POOL_MIN`, `NIMBUS_PG_POOL_MAX`, `NIMBUS_PG_POOL_TIMEOUT`, `NIMBUS_PG_STATEMENT_TIMEOUT_MS`
- **File paths:** `COLOR_FILE` (global color wheel Excel), `COLOR_WHEEL_DIR` (per-plant color wheels)

**Build:**
- No build step for frontend — JavaScript and CSS are served directly from disk
- Static asset cache-busting via `NIMBUS_BUILD_ID` query parameter on `<script>` and `<link>` tags (`index.html`)
- Structured JSON logging to stdout (one JSON object per line via `_JsonFormatter` in `brain.py`)

## Platform Requirements

**Development:**
- PostgreSQL 18 running locally (schema bootstrapped via `schema.sql`)
- Python 3.x with pip
- Static file server for frontend (`python -m http.server 9000` or similar)
- Modern browser with ES6 support
- CORS must allow frontend origin (currently set to `["*"]`)

**Production:**
- Python 3.x runtime with FastAPI + uvicorn
- PostgreSQL 18+ (Azure Database for PostgreSQL Flexible Server compatible)
- Static HTTP server or CDN for frontend assets (`index.html`, `app.js`, `styles.css`, `nimbus-intelligence.js`, `nimbus-worker.js`)
- TLS/SSL for Postgres connections when hosted remotely (`PG_SSLMODE=require` in production `.env`)
- Load balancer for multi-worker uvicorn deployments (stateless app)

---

*Stack analysis: 2026-06-17*
