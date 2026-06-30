# External Integrations

**Analysis Date:** 2026-06-17

## APIs & External Services

**None currently integrated.**

The backend exposes REST endpoints (`brain.py`) for internal use only — no external API calls to third-party services are made. The frontend does not call external APIs. All data flows between the frontend and the single backend instance.

## Data Storage

**Databases:**
- PostgreSQL 18+
  - Connection pool in `db.py` via `psycopg_pool.ConnectionPool`
  - Environment config: `PG_HOST`, `PG_PORT`, `PG_DB`, `PG_USER`, `PG_PASS`
  - SSL mode control: `PG_SSLMODE` (default "prefer"; set to "require" for Azure)
  - Pool tuning: `NIMBUS_PG_POOL_MIN`, `NIMBUS_PG_POOL_MAX`, `NIMBUS_PG_POOL_TIMEOUT`, `NIMBUS_PG_STATEMENT_TIMEOUT_MS`
  - Client: psycopg 3.x with Jsonb type support

**File Storage:**
- Local filesystem only
  - Color wheel files: `COLOR_FILE` (global) and per-plant `color_wheel_<PLANT>.xlsx` under `COLOR_WHEEL_DIR`
  - Excel upload ingest: `POST /upload` accepts `.xlsx` files shaped per `sequence_testing` template
  - Cached in-process: `GLOBAL_CW` and `PLANT_CWS` dicts, refreshed via `POST /reload`

**Caching:**
- In-process memory cache for color wheels (no external cache service)
- Frontend localStorage cache for app state: key `nimbus.state.v3`
- No Redis, Memcached, or distributed caching

## Authentication & Identity

**Auth Provider:** None

- No authentication layer implemented
- No user login or identity federation
- All requests are allowed (CORS configured for `allow_origins=["*"]`)
- No JWT, OAuth2, or basic auth
- **Design note:** Auth is left for future enterprise deployment; currently assumed to be a trusted network environment

## Monitoring & Observability

**Error Tracking:** None

- No third-party error tracking service (Sentry, Rollbar, etc.)
- No error reporting to external systems

**Logs:**
- Structured JSON logging to stdout (one JSON object per line)
- Logger tree: `nimbus.*` namespace with levels `info`, `debug`, `warning`, `error`
- Fields: `ts` (ISO timestamp), `level`, `logger` (name), `msg`, optional `category`, `ctx`, `rid` (request ID)
- Request IDs (`x-request-id`) are threaded through every request and logged so frontend ErrorLog entries can be joined to backend logs
- Container orchestration or cloud logging service expected to capture stdout
- **Note:** Not integrated to a centralized logging platform (ELK, Splunk, etc.)

## CI/CD & Deployment

> Updated 2026-06-30: deployed to Azure (single container). The June-17 snapshot is superseded.

**Hosting:** Live on **Azure Container Apps** as a single container — FastAPI serves both the API and the static frontend via a `StaticFiles` mount. Image built in **Azure Container Registry** (`acrnimbusdev`) with `az acr build`; full runbook in `DEPLOYMENT.md`.

- **Current:** one container on Azure Container Apps (`ca-nimbus-dev`) against Postgres `pgdb-nimbus-dev` over TLS. Locally, `uvicorn brain:api --port 8000` serves both API and UI at `http://localhost:8000/`.
- **Container files:** `Dockerfile` + `.dockerignore` now exist at repo root (they did not at the time of the original analysis).
- **Production path:** redeploy via `az acr build` + `az containerapp update` (`DEPLOYMENT.md`); hardening roadmap in `MIGRATION.md`.

**CI Pipeline:** None

- No GitHub Actions, GitLab CI, Azure Pipelines, or similar
- No automated tests in the repository
- No linting or formatting automation in CI
- Manual testing and deployment expected

## Environment Configuration

**Required env vars:**
- `PG_HOST` - Postgres hostname (default: "localhost")
- `PG_PORT` - Postgres port (default: "5432")
- `PG_DB` - Database name (default: "nimbus")
- `PG_USER` - Postgres user (default: "postgres")
- `PG_PASS` - Postgres password (default: "")
- `PG_SSLMODE` - SSL mode (default: "prefer"; set to "require" for Azure)

**Optional pool tuning:**
- `NIMBUS_PG_POOL_MIN` - Minimum warm connections (default: 2)
- `NIMBUS_PG_POOL_MAX` - Maximum connections (default: 20)
- `NIMBUS_PG_POOL_TIMEOUT` - Wait time for a free connection in seconds (default: 10)
- `NIMBUS_PG_STATEMENT_TIMEOUT_MS` - Query timeout in milliseconds (default: 30000)

**File paths (env-driven as of 2026-06-30):**
- `COLOR_FILE` - global color wheel Excel path; `os.getenv("COLOR_FILE", <local Windows default>)`, set to `/data/color_wheel.xlsx` in the container
- `COLOR_WHEEL_DIR` - per-plant color wheel dir; `os.getenv("COLOR_WHEEL_DIR", <local Windows default>)`, set to `/data/color_wheels` in the container (auto-created; ephemeral on the pilot)

**Secrets location:**
- Stored in `.env` file in project root (loaded by `python-dotenv` in `db.py`)
- **Important:** `.env` is in `.gitignore` — never committed to git

## Webhooks & Callbacks

**Incoming:** None

- No external systems POST to NIMBUS endpoints
- No webhook subscriptions from third-party services

**Outgoing:** None

- No data exported to external systems
- No periodic sync jobs to external databases
- No event notifications to external services

## Excel Ingest Workflow

**Source:** SAP export (sequence_testing template shape)
- Endpoint: `POST /upload`
- File: `.xlsx` with columns: `PRODUCTION_ORDER`, `MATERIAL_NUMBER`, `MATERIAL_DESCRIPTION`, `PRODUCTION_LINE`, `RUN_TIME`, `COLOR`, `ORDER_QUANTITY`, `FORM_SIZE`, `SCHEDULED_START`, `SCHEDULED_END`, etc.
- Processing: Parsed by `pandas.read_excel()`, normalized by `db.clean()`, upserted into `orders` table
- Upload audit trail: Logged to `upload_audit` table with `batch_id`, filename, insert/update counts, warnings

## Scheduled Tasks

**None implemented currently.**

- No background jobs or scheduled exports
- No periodic data synchronization
- All operations are request-driven (frontend calls backend endpoint → backend queries DB → JSON response)

## Master Data Hierarchy

**Storage:** PostgreSQL tables (no external master data service)
- `subnetworks` table — top-level organizational units
- `plants` table — manufacturing locations, keyed by (subnetwork, plant), carries per-plant JSONB `constraints` config
- `production_lines` table — equipment units within plants, keyed by (subnetwork, plant, production_line)
- `materials` table — material IDs and metadata
- `material_plants` table — material-to-plant associations
- `column_metadata` table — schema for dynamic user columns on master data tables

**API Surface:** `master_data.py` backs `GET /master-data/{table}`, `POST /master-data/{table}/bulk`, etc.
- All SQL parameterized; no string interpolation vulnerability
- Column/table whitelist validation before composition with `psycopg.sql.SQL`

---

*Integration audit: 2026-06-17*
