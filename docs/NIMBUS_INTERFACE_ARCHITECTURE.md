# NIMBUS Interface Architecture — SAP ECC → NIMBUS Data Feed

> **Audience:** NIMBUS engineering (the team building and operating the integration on the NIMBUS side).
> **Companion doc:** `SAP_INTEGRATION_ROADMAP.md` covers the *SAP-side* build (t-codes, ABAP, transports, Basis open questions). This doc covers the *NIMBUS-side* engineering structure that consumes that feed.
>
> **Status:** Two layers. (1) The **pull connectors** (sections 1-6) remain a non-live skeleton: every connector is a stub that returns `[]` / `{ok: false}` and the per-object cron scheduler is **disabled by default**. (2) **SAP staging** (section 7, design of record `SAP_STAGING_DESIGN.md`) is implemented on `feature/sap-staging`: Mulesoft writes SAP snapshots straight into Postgres staging tables, NIMBUS polls, validates and applies them under admin control, and an outbound queue carries the plant schedule back to SAP. Staging is inert until `NIMBUS_SAP_STAGING_POLL_SECONDS` is set and Mulesoft has a database login (see `DEPLOYMENT.md`). This document is the contract for both.
>
> **Interface contract version:** `2026-10-07-2` (the `NIMBUS_BUILD_ID` in `frontend/index.html` at the time of the staging release; `NIMBUS_BUILD_ID` single-source-drives the asset cache-bust query, and a `BUILD_ID` build arg stamps it at image build time, see `DEPLOYMENT.md`).

---

## Table of Contents

1. [Component map](#1-component-map)
2. [The exact contract](#2-the-exact-contract)
3. [Data flow](#3-data-flow)
4. [Security posture](#4-security-posture)
5. [Deferred hardening](#5-deferred-hardening)
6. [How to go live](#6-how-to-go-live)
7. [Staging contract (Mulesoft)](#7-staging-contract-mulesoft)

---

## 1. Component map

The interface is one new Python module (`sap_sync.py`), three new Postgres tables, a set of endpoints in `backend/integration/routes.py`, a scheduler hosted inside the existing FastAPI lifespan, and one new frontend admin tab. It **reuses** the existing upsert paths rather than reimplementing persistence.

### 1.1 Overview

```
                         ┌─────────────────────────────────────────────┐
                         │                 routes.py                    │
                         │  /sap/interface/* endpoints   (§2.4)         │
                         │  lifespan-hosted APScheduler  (§1.5)         │
                         └───────────────┬─────────────────────────────┘
                                         │ import sap_sync
                         ┌───────────────▼─────────────────────────────┐
                         │                 sap_sync.py                  │
                         │  SAP_OBJECTS catalog · TRANSFORMS · mapping  │
                         │  SapConnector (+ 3 stub transports)          │
                         │  sync_object() orchestrator                  │
                         └──────┬───────────────────────┬──────────────┘
                  master objects│                       │orders
                       ┌─────────▼────────┐    ┌─────────▼──────────────┐
                       │ master_data.py   │    │ db.upsert_orders()      │
                       │ md.bulk_apply()  │    │ (extracted from         │
                       │                  │    │  ingest_orders_from_    │
                       │                  │    │  excel — shared path)   │
                       └─────────┬────────┘    └─────────┬──────────────┘
                                 │                       │
                       ┌─────────▼───────────────────────▼──────────────┐
                       │                  Postgres                       │
                       │  master tables · orders · sap_sync_config ·     │
                       │  sap_sync_run · sap_field_map                   │
                       └─────────────────────────────────────────────────┘
```

### 1.2 `sap_sync.py` — the engine

A single module beside `db.py` and `master_data.py`. It imports the shared connection pool exactly like `master_data.py` does (`from db import _pool`) and imports the two persistence facades (`import db`, `import master_data as md`). **No network library is imported at module top** — `httpx` (OData) and `pyrfc` (RFC) are imported *lazily inside the connector methods* so the skeleton runs with zero new runtime dependencies and a CDN/network-restricted box can still boot.

It is composed of five layers:

| Layer | Members | Responsibility |
|---|---|---|
| **Object catalog** | `SAP_OBJECTS` | The 6-entry map of what can be synced (5 master objects + `orders`), each `{kind, table, label}`. The single source of truth for "what objects exist". |
| **Transport abstraction** | `SapConnector` (base) · `FileDropConnector` · `ODataConnector` · `RfcConnector` · `make_connector()` | Pluggable per-transport extraction. Base defines `test_connection()` and `extract(object_key, since)`. All three concrete classes are **stubs this pass**. `make_connector(transport, params)` is the factory (raises `ValueError` on unknown transport). |
| **Transform helpers** | `TRANSFORMS` dict · `apply_transform()` · `NULL_SENTINELS` | Per-field value normalization (ALPHA, DATS, decimal sign, UoM, boolean `X`, …). SAP raw fields are dirty; these clean them to NIMBUS column types. |
| **Mapping layer** | `load_field_map()` · `replace_field_map()` · `map_records()` | Config-driven SAP-field → NIMBUS-column translation, read from `sap_field_map`. No mappings are hardcoded in Python; they live in the DB and are editable from the UI. |
| **Orchestrator** | `sync_object()` · `get_config()` / `set_config()` / `update_watermark()` · `list_enabled_jobs()` · `list_runs()` · `test_connection()` | Ties config → connector → extract → map → upsert → run-record. Plus config/run read-write helpers and the scheduler's job list. |

**Transport reuse rationale:** `FileDropConnector` is the recommended MVP because it can reuse the exact Excel ingest path NIMBUS already has. `ODataConnector` is the strategic target (clean HTTP/JSON, `$filter` delta). `RfcConnector` is the high-volume / fine-control option. All three implement the same `SapConnector` interface, so `sync_object()` is transport-agnostic.

**Upsert reuse — no new persistence code:**

- **Master objects** (`subnetworks`, `plants`, `production_lines`, `materials`, `material_plants`) dispatch to `md.bulk_apply(table, {"upserts": rows, "deletes": []}, user_email)` — the same path the "Manage Data Tables" admin grid uses, including its `admin_audit` logging (actor tagged `sap-sync`). Mapped master rows **must** carry each table's key columns (`master_data._KEY_COLUMNS`) or the insert hits NOT-NULL; this is enforced by the field-map seeds.
- **Orders** dispatch to `db.upsert_orders(rows, source="sap", ...)` — the pure upsert helper **extracted** from `ingest_orders_from_excel` for this effort (see §1.3). This inherits `make_id()` stable hashing, the cumcount dedup, the plant backfill, the ambiguous-plant warning, and the `upload_audit` insert.

`master_data._KEY_COLUMNS` (the NOT-NULL key set the master field-maps must supply):

| Table | Key columns |
|---|---|
| `subnetworks` | `code` |
| `plants` | `subnetwork`, `plant` |
| `production_lines` | `subnetwork`, `plant`, `production_line` |
| `materials` | `material_id` |
| `material_plants` | `material_id`, `plant` |

### 1.3 `db.upsert_orders` — extracted shared upsert

The pure order-upsert is split out of `ingest_orders_from_excel` so both the Excel `POST /upload` path **and** the SAP orders path call one helper:

```python
def upsert_orders(rows: list[dict], *, batch_id: str | None = None, source: str = "excel",
                  filename: str | None = None, raw_row_count: int | None = None,
                  warnings: list[dict] | None = None) -> dict:
    """Upsert pre-cleaned order dicts (keyed by orders columns). Computes make_id()
    when absent + cumcount dedup, chunked executemany via the upsert SQL, plant
    backfill, ambiguous-plant warn, upload_audit insert. Returns counts + batch_id."""
```

- **`rows`** are dicts keyed by `orders` columns: `production_order`, `material_number`, `material_description`, `production_line`, `plant`, `basic_start_date`, `basic_finish_date`, `run_time`, `color`, `order_quantity`, `form_size`, `firming_indicator`. `id` is computed via `make_id()` when absent.
- **Returns** `{"status": "ok", "batch_id": ..., "inserted": int, "updated": int, "failed": int, "warnings": [...]}`.
- **`filename`** defaults to `f"sap:{source}"` when `source != "excel"`.
- **Critical invariant preserved:** the deliberate **non-overwrite** of `scheduled_start` / `scheduled_end` / `notes` lives in the upsert SQL constant (`ON CONFLICT (id) DO UPDATE`), which does **not** move during the extraction. This is exactly what makes idempotent re-sync safe — re-syncing an order from SAP never clobbers a scheduler's manual reschedule or notes.
- **`ingest_orders_from_excel`** becomes a thin Excel adapter: it still parses/cleans/renames/date-hygienes the workbook, then builds row dicts and calls `upsert_orders(..., source="excel")`. `POST /upload` behaves identically (regression-checked: same inserted/updated counts, prior manual `scheduled_start` edits survive).

### 1.4 Three new Postgres tables

Appended to `schema.sql`, **strictly idempotent** (`CREATE … IF NOT EXISTS` + `INSERT … ON CONFLICT DO NOTHING`, **zero re-mutating `UPDATE`s**). This is non-negotiable: `schema.sql` re-runs on every deploy and already carries a data-mutating migration (the `plants` horizon ×1440), so any new DDL that re-mutates would corrupt on re-run.

| Table | Purpose |
|---|---|
| `sap_sync_config` | Per-object configuration: enabled flag, transport, cron schedule, source params (JSONB), last watermark. One row per object_key. |
| `sap_sync_run` | Append-only run history: read/insert/update/fail counts, status, error, watermark before/after, actor. Drives the run-history UI section and watermark recovery. |
| `sap_field_map` | The editable SAP-field → NIMBUS-column mapping per object, with transform name, active flag, and ordering. |

Full DDL in §2.3.

### 1.5 Lifespan-hosted APScheduler (disabled by default; also hosts the staging poll)

The scheduler lives **inside the single existing FastAPI `lifespan`** (`brain.py`) — no separate process. It is governed by **two-level safety**:

1. **Master env flag** `SAP_SYNC_ENABLED` = `os.getenv("NIMBUS_SAP_SYNC_ENABLED", "0") in ("1", "true", "True")`, declared near `NIMBUS_API_KEY`. **Defaults off.** With it unset, the lifespan logs "scheduler disabled" and nothing is scheduled.
2. **Per-object `enabled`** in `sap_sync_config`. Even with the master flag on, only objects that are *both* `enabled = TRUE` *and* have a non-null `schedule_cron` are scheduled (`list_enabled_jobs()`).

When `SAP_SYNC_ENABLED` is true, the lifespan (after the existing DB probe) **lazy-imports** `AsyncIOScheduler` + `CronTrigger`, adds one job per `list_enabled_jobs()` (with `max_instances=1`, `coalesce=True`, job id `"sap:" + object_key`), calls `start()`, and stashes the scheduler on `app.state.sap_scheduler`. After the `yield` it calls `shutdown(wait=False)`. A module-level `async def _run_sap_job(object_key)` offloads to `run_in_threadpool(sap_sync.sync_object, ...)` so the synchronous DB/connector work never blocks the event loop (mirrors how `/upload` offloads ingest).

**Single-replica today, multi-replica later.** The pilot runs `min = max = 1` replica, so an in-process scheduler cannot double-fire. When NIMBUS scales beyond one replica, every replica would otherwise run its own scheduler and a cron tick would fan out N concurrent syncs of the same object. The documented guard for that future is a **Postgres advisory lock** wrapped around the body of `sync_object`:

```sql
SELECT pg_try_advisory_lock(hashtext('sap:' || :object_key));
-- run sync only if the lock was acquired; release in a finally
```

`max_instances=1` only prevents overlap *within one process*; the advisory lock is what makes it safe *across replicas*. This is a deferred-hardening item (§5), not built this pass.

**Staging poll (added with SAP staging).** A third knob, `NIMBUS_SAP_STAGING_POLL_SECONDS` (`brain.py`, integer seconds, default `0` = no job), adds an `IntervalTrigger` job `sap:staging-poll` (`max_instances=1`, `coalesce=True`) whose body `_run_sap_staging_poll` offloads `sap_staging.poll_once` to the threadpool. It is independent of the per-object cron schedule. **The scheduler object is created when either `NIMBUS_SAP_SYNC_ENABLED` or the poll interval is on**; the per-object cron jobs are still only registered when `SAP_SYNC_ENABLED` is true, so turning on only the poll starts a scheduler with exactly one job. `poll_once` also takes `pg_try_advisory_lock(hashtext('sap:staging-poll'))` (acquire-or-skip), so a second replica or an overlapping manual poll (`POST /sap/staging/poll`) skips instead of double-processing.

`requirements.txt` adds `apscheduler==3.11.0`. (`httpx` is **not** added yet — it is deferred to OData go-live and lazy-imported.)

### 1.6 Endpoint surface (`backend/integration/routes.py`)

Eight endpoints under `/sap/interface/*` (plus the `/sap/staging/*` routes of section 7), declared in `backend/integration/routes.py` (the module is `backend/integration/sap_sync.py`; `brain.py` only includes the router). **Every route needs `require_admin`** (reads included); **writes additionally carry `require_api_key`** (the existing `X-API-Key` shared-secret guard, a no-op until `NIMBUS_API_KEY` is set). Actor identity for audit is read from the `x-user-email` header, and every write calls `_log_event("info", "sap_sync", ...)`. Any object not in `sap_sync.SAP_OBJECTS` → 404. Full list in §2.4.

### 1.7 Interface admin tab (frontend UX — 4 sections)

An **Interface** admin sub-tab (after "Manage Data Tables"), implemented as the `Interface` module in `frontend/integration/sap-interface-ui.mts` (compiled to the `.mjs` twin; it also hosts the Staging section of section 7), rendering into `#sap-interface-host`. It reads via `Util.fetchTraced` and writes via plain `fetch` with `{"content-type": "application/json", "x-user-email": <current user>}` headers (matching the MasterData save pattern). The tab has **four sections**:

| # | Section | Backs onto | What it does |
|---|---|---|---|
| **(a)** | **Transport panel + Test Connection** | `POST /sap/interface/test-connection` | Pick transport, edit source params, hit **Test Connection** → shows the `{ok, detail}` result (stub returns `ok:false` with a "not configured" detail this pass). |
| **(b)** | **Object catalog table** (one row per catalog object) | `GET /objects`, `GET/POST /config/{object}`, `POST /sync/{object}` | Per object: enabled toggle, cron schedule, last-run status pill + counts, next-run, and a **Run Now** button (supports dry-run). |
| **(c)** | **Field-mapping grid** (per object) | `GET/POST /mappings/{object}` | Editable rows: `sap_field` · `nimbus_column` · `transform` (select) · `active`. **Save** replaces the object's map in one transaction. Mirrors the MasterData grid UX with a slim local dirty-track + Save (no refactor of MasterData internals). |
| **(d)** | **Run history** | `GET /runs` | Reuses the `admin-log-*` CSS classes (same look as the backend-log viewer) to render recent `sap_sync_run` rows: object, status, counts, timestamps, actor. |

Localization: the tab label and UI strings are i18n keys (§2.6). The five locale files are `.js` files setting `window.__NIMBUS_LOCALES.<lang>`; English is the automatic fallback via `Util.t`.

---

## 2. The exact contract

This section is the authoritative interface contract. All NIMBUS-side code (backend + frontend, built in parallel) must conform to exactly these signatures, names, and shapes. **Version string: `2026-10-07-2`** (the current `NIMBUS_BUILD_ID` in `frontend/index.html`; the skeleton shipped as `2026-06-30-b`).

### 2.1 Object catalog (11 entries: 7 pull objects + 4 staging objects)

`SAP_OBJECTS` in `backend/integration/sap_sync.py` — `key -> {kind, table, label}`:

| key | kind | table | label |
|---|---|---|---|
| `subnetworks` | `master` | `subnetworks` | "Subnetworks" |
| `plants` | `master` | `plants` | "Plants" |
| `machine` | `master` | `machine` | "Machines" |
| `materials` | `master` | `materials` | "Materials" |
| `material_plants` | `master` | `material_plants` | "Material Plants" |
| `sap_workcenter` | `master` | `sap_workcenter` | "SAP Work Centers" |
| `orders` | `orders` | `orders` | "Production Orders" |
| `stage_material_plants`, `stage_production_version`, `stage_routing_operation`, `stage_planned_orders` | `staging` | the `sap_stage_*` row table | the four inbound staging objects of section 7 (extra keys on these entries; they never go through `sync_object`) |

(The original 2026-06-30 migration seeded six config rows, still under the older key `production_lines` and with none for `machine` / `sap_workcenter`; the staging migration seeds the four staging keys. See `MIGRATION.md`, "SAP sync skeleton — discrepancies".)

### 2.2 `sap_sync.py` public API

```python
SAP_OBJECTS: dict          # the 6-entry catalog above

TRANSFORMS: dict           # name -> callable. Names (exactly):
                           #   none, alpha, strip_zeros, dats, tims,
                           #   decimal, uom, bool_x
NULL_SENTINELS = {"00000000", "0000-00-00", ""}

apply_transform(name, value)

# Mapping layer
load_field_map(object_key) -> list[dict]
    # includes INACTIVE rows; each row: sap_field, nimbus_column, transform, active, field_order
replace_field_map(object_key, mappings, user_email=None)
map_records(object_key, raw_records, field_map=None) -> list[dict]

# Transport abstraction
class SapConnector:
    def test_connection(self) -> dict:        # {"ok": bool, "detail": str}
    def extract(self, object_key, since) -> list[dict]

# Concrete connectors — ALL STUBS this pass:
#   extract() returns []
#   test_connection() returns {"ok": False, "detail": "stub: <transport> not configured"}
#   httpx / pyrfc imported LAZILY inside methods only
class FileDropConnector(SapConnector): ...
class ODataConnector(SapConnector): ...
class RfcConnector(SapConnector): ...

make_connector(transport, params) -> SapConnector
    # transport in {"file_drop", "odata", "rfc"}; ValueError on unknown

# Config / run / watermark persistence (uses `from db import _pool`)
get_config(object_key) -> dict
set_config(object_key, **fields)
update_watermark(object_key, value)
list_enabled_jobs() -> list[dict]          # enabled = TRUE AND schedule_cron NOT NULL
list_runs(object_key=None, limit=50) -> list[dict]

# Module-level convenience wrapper
test_connection(transport, params) -> dict

# Orchestrator
sync_object(object_key, *, user_email=None, dry_run=False) -> dict
    # -> {"object_key", "status": "ok"|"error", "rows_read", "rows_inserted",
    #     "rows_updated", "rows_failed", "error", "run_id"}
    # dispatch by kind:
    #   master -> md.bulk_apply(table, {"upserts": rows, "deletes": []}, user_email)
    #   orders -> db.upsert_orders(rows, source="sap")   (user_email via triggered_by)
```

**Imports:** `import db`, `import master_data as md`. No network library at module top. Persistence helpers use `from db import _pool` exactly as `master_data.py` does.

### 2.3 Postgres table DDL

Appended to `schema.sql`, strictly idempotent (`CREATE … IF NOT EXISTS` + `INSERT … ON CONFLICT DO NOTHING`; **no `UPDATE`s**).

```sql
CREATE TABLE IF NOT EXISTS sap_sync_config (
    object_key      TEXT PRIMARY KEY,
    enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    transport       TEXT    NOT NULL DEFAULT 'file_drop',
    schedule_cron   TEXT,
    source_params   JSONB   NOT NULL DEFAULT '{}'::jsonb,   -- secrets by reference only
    last_watermark  TEXT,
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sap_sync_run (
    id               BIGSERIAL PRIMARY KEY,
    object_key       TEXT NOT NULL,
    started_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    ended_at         TIMESTAMP,
    status           TEXT NOT NULL DEFAULT 'running',
    rows_read        INT  NOT NULL DEFAULT 0,
    rows_inserted    INT  NOT NULL DEFAULT 0,
    rows_updated     INT  NOT NULL DEFAULT 0,
    rows_failed      INT  NOT NULL DEFAULT 0,
    error            TEXT,
    watermark_before TEXT,
    watermark_after  TEXT,
    triggered_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sap_run_object_started
    ON sap_sync_run (object_key, started_at DESC);

CREATE TABLE IF NOT EXISTS sap_field_map (
    object_key    TEXT NOT NULL,
    sap_field     TEXT NOT NULL,
    nimbus_column TEXT NOT NULL,
    transform     TEXT NOT NULL DEFAULT 'none',
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    field_order   INT NOT NULL DEFAULT 0,
    PRIMARY KEY (object_key, sap_field)
);
CREATE INDEX IF NOT EXISTS idx_sap_field_map_object
    ON sap_field_map (object_key, field_order);
```

**Seeds (all `ON CONFLICT DO NOTHING`):**
- 6 `sap_sync_config` rows in the original migration (one per object_key then in the catalog, `transport = 'file_drop'`, `enabled = FALSE`; the four staging keys are seeded by the staging migration).
- Starter `orders` field-map rows, e.g.:

  | object_key | sap_field | nimbus_column | transform |
  |---|---|---|---|
  | orders | AUFNR | production_order | strip_zeros |
  | orders | MATNR | material_number | alpha |
  | orders | GSTRP | basic_start_date | dats |
  | orders | GLTRP | basic_finish_date | dats |
  | orders | GAMNG | order_quantity | decimal |

### 2.4 Endpoints (`backend/integration/routes.py`)

Routes live in `backend/integration/routes.py`. Every route needs `require_admin`; writes also carry `require_api_key` (no-op until `NIMBUS_API_KEY` is set). Actor from `x-user-email`; each write `_log_event("info", "sap_sync", ...)`. 404 if object not in `sap_sync.SAP_OBJECTS`.

| Method · Path | Gating | Body / Query | Returns |
|---|---|---|---|
| `GET /sap/interface/objects` | `require_admin` | — | `{"objects":[{object_key, label, kind, enabled, transport, schedule_cron, last_run\|null, next_run\|null}]}` |
| `GET /sap/interface/mappings/{object}` | `require_admin` | — | `{"object_key":..., "mappings":[...]}` |
| `POST /sap/interface/mappings/{object}` | `require_api_key` + `require_admin` | `{"mappings":[...]}` | replaces map in one txn |
| `GET /sap/interface/config/{object}` | `require_admin` | — | `{object_key, enabled, transport, schedule_cron, source_params (NON-SECRET keys only), has_secret}` |
| `POST /sap/interface/config/{object}` | `require_api_key` + `require_admin` | `{enabled?, transport?, schedule_cron?, source_params?}` | validate transport + cron; **MERGE** source_params (never wipe omitted keys) |
| `POST /sap/interface/test-connection` | `require_api_key` + `require_admin` | `{transport, source_params}` | `{"ok":bool, "detail":str}` |
| `POST /sap/interface/sync/{object}` | `require_api_key` + `require_admin` | `{dry_run?}` | `sync_object` result, run via `run_in_threadpool` |
| `GET /sap/interface/runs` | `require_admin` | `?object=&limit=` | `{"runs":[...]}` |

### 2.5 Transform names

`none`, `alpha`, `strip_zeros`, `dats`, `tims`, `decimal`, `uom`, `bool_x`.

| Transform | Handles |
|---|---|
| `none` | pass-through |
| `alpha` | SAP ALPHA conversion (e.g. MATNR) |
| `strip_zeros` | strip leading zeros (e.g. AUFNR) |
| `dats` | SAP `DATS` `YYYYMMDD` → datetime; sentinel → None |
| `tims` | SAP `TIMS` time string |
| `decimal` | decimal with trailing-sign / locale handling |
| `uom` | unit-of-measure normalization |
| `bool_x` | SAP `X`/blank → boolean |

`NULL_SENTINELS = {"00000000", "0000-00-00", ""}`.

### 2.6 i18n keys

Locales are `.js` files at `locales/{en,de,es,fr,pt}.js` setting `window.__NIMBUS_LOCALES.<lang> = { key: value, ... }`. English fallback is automatic via `Util.t`.

- **`tab.interface`** — add to **all 5** locales (en, de, es, fr, pt).
- Add the following to **`en.js`** (English fallback covers the others until translated):

  `ui.sap_transport`, `ui.sap_test_connection`, `ui.sap_run_now`, `ui.sap_enabled`, `ui.sap_schedule`, `ui.sap_last_run`, `ui.sap_next_run`, `ui.sap_last_result`, `ui.sap_field`, `ui.sap_nimbus_column`, `ui.sap_transform`, `ui.sap_active`, `ui.sap_save_mappings`, `ui.sap_runs_title`, `ui.sap_no_runs`, `toast.sap_conn_ok`, `toast.sap_conn_fail`, `toast.sap_sync_done`, `toast.sap_sync_failed`, `toast.sap_mappings_saved`.

### 2.7 Frontend fetch contract

- Endpoint base in `app.js`: `Config.API_BASE + "/sap/interface/..."`.
- **Reads** via `Util.fetchTraced`.
- **Writes** via `fetch` with headers `{"content-type": "application/json", "x-user-email": <current user>}`.

---

## 3. Data flow

### 3.1 End-to-end sync (one object)

```
  SAP ECC
    │  (file drop on a share/SFTP/Blob │ OData $filter pull │ RFC custom Z FM)
    ▼
  Connector.extract(object_key, since)          ← make_connector(transport, source_params)
    │   returns list[dict] of RAW SAP records    (STUB this pass → returns [])
    ▼
  map_records(object_key, raw_records)           ← reads sap_field_map (active rows)
    │   per record: SAP field → NIMBUS column, apply_transform(name, value)
    │   NULL_SENTINELS → None
    ▼
  list[dict] keyed by NIMBUS columns
    │
    ├── kind == master  ──► md.bulk_apply(table, {"upserts": rows, "deletes": []}, user_email)
    │                         └─ writes master table + admin_audit (actor 'sap-sync')
    │
    └── kind == orders  ──► db.upsert_orders(rows, source="sap", ...)
                              └─ make_id() + cumcount dedup, chunked upsert,
                                 plant backfill, ambiguous-plant warn, upload_audit
                                 ❗ scheduled_start/scheduled_end/notes NEVER overwritten
    ▼
  Postgres (master tables / orders)
```

Throughout, `sync_object()` brackets the work with a **run record**:

```
  sync_object(object_key, user_email, dry_run)
    │
    1. get_config(object_key)            → transport, source_params, last_watermark, enabled
    2. INSERT sap_sync_run (status='running', watermark_before=last_watermark, triggered_by)
    3. connector = make_connector(transport, source_params)
    4. raw = connector.extract(object_key, since=last_watermark)
    5. rows = map_records(object_key, raw)
    6. if dry_run: skip persistence (rows_read counted, 0 inserted/updated)
       else:       dispatch by kind (master/orders) → capture inserted/updated/failed
    7. on success: update_watermark(object_key, new_value)   ← only persisted on success
    8. UPDATE sap_sync_run (ended_at, status='ok'|'error', counts, error, watermark_after)
    │
    └─► return {object_key, status, rows_read, rows_inserted, rows_updated,
                rows_failed, error, run_id}
```

### 3.2 Two trigger paths into `sync_object`

```
  ┌─ Scheduled (automatic) ───────────────────────────────────────────┐
  │ APScheduler CronTrigger (in lifespan, only if NIMBUS_SAP_SYNC_     │
  │ ENABLED=1) fires job "sap:<object_key>"                            │
  │   → _run_sap_job(object_key)                                       │
  │   → run_in_threadpool(sap_sync.sync_object, object_key,            │
  │                       user_email="scheduler")                      │
  │ Jobs come from list_enabled_jobs() = enabled=TRUE AND cron NOT NULL│
  └───────────────────────────────────────────────────────────────────┘

  ┌─ Manual "Run Now" (user) ─────────────────────────────────────────┐
  │ Interface tab → POST /sap/interface/sync/{object} {dry_run?}       │
  │   → run_in_threadpool(sap_sync.sync_object, object,                │
  │                       user_email=<x-user-email>, dry_run=...)      │
  └───────────────────────────────────────────────────────────────────┘

  Both write a row to sap_sync_run → surfaced by GET /sap/interface/runs
  → rendered in the Interface tab's run-history section (d).
```

### 3.3 Run history read path

```
  Interface tab section (d)
    → Util.fetchTraced(API_BASE + "/sap/interface/runs?object=&limit=")
    → list_runs(object_key, limit)   reads sap_sync_run ORDER BY started_at DESC
    → {"runs": [...]}  → rendered with admin-log-* CSS classes
```

---

## 4. Security posture

| Control | Implementation |
|---|---|
| **Secrets via env only** | SAP credentials (RFC user/password, OData basic/OAuth secrets, SFTP keys) come from **environment variables only** — never stored in the UI, never written to the DB, never logged. `source_params` (JSONB in `sap_sync_config`) holds **non-secret** config only (host, path, object selection); a secret is referenced **by name**, with the value resolved from env at connection time. This mirrors the existing pattern where `PG_PASS` and the color-wheel paths come from env. |
| **Config endpoint strips secrets** | `GET /sap/interface/config/{object}` returns `source_params` with **non-secret keys only** plus a boolean `has_secret` — it never echoes a credential value back to the browser. `POST /sap/interface/config/{object}` **merges** `source_params` (never wipes keys the caller omitted), so partial edits can't accidentally blank a secret-reference key. |
| **Routes gated** | Every `/sap/interface/*` and `/sap/staging/*` route needs `require_admin`, reads included. The mutating endpoints (`POST /mappings/{object}`, `POST /config/{object}`, `POST /test-connection`, `POST /sync/{object}`, and the staging writes) additionally carry `require_api_key`, the existing `X-API-Key` shared-secret guard. That guard is a **no-op until `NIMBUS_API_KEY` is set**, so local/dev runs are unchanged; when set, those routes require a matching `X-API-Key` header (else 401). |
| **Actor attribution + audit** | Each write reads the actor from the `x-user-email` header and calls `_log_event("info", "sap_sync", ...)`. Master syncs additionally append `bulk_apply` rows to `admin_audit` tagged with the `sap-sync` actor. *(Caveat, same as the rest of NIMBUS: `x-user-email` is still spoofable — the real fix is Entra SSO, tracked in MIGRATION.md.)* |
| **Parameterized SQL** | All `sap_sync.py` persistence uses parameterized placeholders against the shared pool (`from db import _pool`), exactly like `master_data.py` / `db.py`. No string-built SQL with user/SAP values. Object keys are validated against `SAP_OBJECTS` (404 otherwise) before any query; transport is validated against the `{file_drop, odata, rfc}` set and cron is validated before persistence. |
| **No network deps in the skeleton** | `httpx` / `pyrfc` are imported **lazily inside connector methods**, so the non-live skeleton has no new attack surface and no outbound network capability until a transport is deliberately built and configured. |
| **Disabled by default** | The scheduler does nothing unless `NIMBUS_SAP_SYNC_ENABLED=1` **and** an object is individually `enabled` with a cron — two independent switches must both be flipped before any automated SAP traffic occurs. |

---

## 5. Deferred hardening

These items are **not** built this pass. They are mirrored as a "SAP Interface — deferred hardening" workstream in `MIGRATION.md` so they stay on the plan of record alongside the rest of the Azure hardening backlog.

| Item | Why deferred / what's needed |
|---|---|
| **SAP creds → Azure Key Vault** | Today SAP credentials are env-only (Container App secrets / local env). Production should resolve them from **Key Vault** via the user-assigned managed identity (same model MIGRATION.md WS7 plans for `pg-pass`), so SAP secrets are never in app config or env dumps. |
| **Private network path for pull (OData / RFC)** | The recommended MVP is file-drop precisely because it needs no inbound path to SAP. OData and RFC require **Azure ↔ on-prem connectivity** (VNet + VPN/ExpressRoute, or SAP Cloud Connector). Until that exists, only file-drop is viable; the pull connectors stay stubs. |
| **PyRFC + SAP NW RFC SDK in the Dockerfile** | If RFC is chosen, the container must ship the **SAP NetWeaver RFC SDK** and `pyrfc` (licensed binary download from SAP). Not added to the image yet — `RfcConnector` lazy-imports `pyrfc` and stays a stub. |
| **Multi-replica advisory lock** | The in-process APScheduler is safe only at `min=max=1`. Before scaling out, wrap `sync_object` in `pg_try_advisory_lock(hashtext('sap:'||object_key))` (acquire-or-skip, release in `finally`) so only one replica runs a given object's sync per tick. `max_instances=1` guards within a process; the advisory lock guards across replicas. |
| **Classification extraction performance** | `COLOR` / `FORM_SIZE` live in SAP classification (`AUSP`/`CABN`/`CAWN`), not transparent tables — a per-material lookup is a known performance trap. The live extractor must **resolve classification server-side / in bulk** (in the Z FM or CDS view) rather than per-record from NIMBUS. Documented in `SAP_INTEGRATION_ROADMAP.md` §1.4; flagged here because it shapes the OData/RFC connector design. |

---

## 6. How to go live

The skeleton is intentionally inert. Bringing a real feed online is a deliberate, ordered sequence — nothing fires until every switch below is flipped.

1. **Build a real transport.** Replace the stub body of the chosen connector (`FileDropConnector` first — it can reuse the Excel ingest path) so `extract()` returns real records and `test_connection()` actually probes the source. For OData add `httpx` to `requirements.txt` and implement the lazy-imported pull; for RFC add `pyrfc` + the SAP NW RFC SDK to the Dockerfile (§5). Resolve the Basis open questions in `SAP_INTEGRATION_ROADMAP.md` first (auth, network path, object/field availability).

2. **Configure `source_params` per object.** Via `POST /sap/interface/config/{object}` (or the Interface tab transport panel), set the **non-secret** connection params (host, path, OData service URL, RFC destination, object/plant scope). Put **secret values in environment variables** referenced by name — never in `source_params`, the DB, or the UI.

3. **Verify the field map.** Open the Interface tab → field-mapping grid for the object; confirm the seeded `orders` map (and add master-object maps), ensuring every map carries the table's key columns (§1.2 / `_KEY_COLUMNS`). Save → `POST /mappings/{object}`.

4. **Test the connection.** Use the Interface tab **Test Connection** button (`POST /test-connection`) — it should return `{ok: true}` once the transport and params are real.

5. **Dry-run, then real run.** Hit **Run Now** with `dry_run: true` to validate extraction + mapping with zero writes; confirm the `rows_read` count and inspect the `sap_sync_run` row in the history section. Then run for real and verify inserted/updated counts (and that any manual `scheduled_start`/`notes` edits survived).

6. **Set per-object `enabled` + `schedule_cron`.** In `sap_sync_config` (via the config endpoint / tab toggle + cron field). This makes the object eligible for `list_enabled_jobs()`.

7. **Flip the master flag.** Set `NIMBUS_SAP_SYNC_ENABLED=1` on the backend and restart. The lifespan schedules one job per enabled object and logs "scheduler started, jobs=N". *(If still single-replica, this is safe as-is; if scaled out, the multi-replica advisory lock from §5 must be in place first.)*

8. **Bump the version string** (`NIMBUS_BUILD_ID` in `frontend/index.html`, currently `2026-10-07-2`) and the styles cache-bust on any deploy that changes static assets (a `BUILD_ID` build arg stamps both at image build time, see `DEPLOYMENT.md`).

---

## 7. Staging contract (Mulesoft)

SAP staging is the live path for SAP data. Mulesoft does not call a NIMBUS endpoint: **the staging tables are the interface**. Mulesoft logs into Postgres as the restricted role `nimbus_mulesoft`, writes one full snapshot per object and plant, and marks it ready. NIMBUS polls, validates, and promotes ("applies") the snapshot into the live tables only under admin control. A second set of tables carries the plant schedule back to SAP. Design of record, with the settled decisions D1-D35: `SAP_STAGING_DESIGN.md`. Implementation: `backend/integration/sap_staging.py` (invariants in `backend/integration/CLAUDE.md`).

### 7.1 What Mulesoft delivers

| SAP export | Object key (`sap_stage_batch.object_key`) | Row table | Live target |
|---|---|---|---|
| Material Plant | `stage_material_plants` | `sap_stage_material_plant` | `material_plants` |
| Routing, part 1 (production versions) | `stage_production_version` | `sap_stage_production_version` | `production_version` |
| Routing, part 2 (operations) | `stage_routing_operation` | `sap_stage_routing_operation` | `routing_operation` |
| Planned Order | `stage_planned_orders` | `sap_stage_planned_order` | `orders` |

Every delivery is a **full snapshot for one plant** and one object: absence from the snapshot is meaningful (it can delete rows, see 7.5). Deliver in the order Material Plant, Routing part 1 (production versions), Routing part 2 (operations), Planned Orders; NIMBUS applies ready batches in that order within one poll regardless of arrival order. **You do not need to wait for NIMBUS to apply a snapshot before sending the next one**: a newer complete snapshot for the same object and plant supersedes an older one that has not been applied yet (7.13), so the safe pacing is "send when SAP has produced a new export", not "send when NIMBUS has caught up". The list of plants to deliver for is not readable by your login (no `SELECT` on `plants`): ask the NIMBUS admin for it (7.11).

### 7.2 The exact SQL sequence (per object, per plant, per attempt)

```sql
-- 1. Header. The UUID is generated by Mulesoft (a fresh UUIDv4 for EVERY attempt).
--    Do NOT name `status`: Mulesoft has no INSERT right on it (a statement that lists it fails with
--    "permission denied"); every new batch starts `loading` and `source` is forced to `mulesoft`.
INSERT INTO sap_stage_batch (batch_id, object_key, plant, source)
VALUES (:batch_id, 'stage_planned_orders', :plant, 'mulesoft');

-- 2. Rows, carrying that batch_id. Never set row_status, reject_reason or the resolved columns.
INSERT INTO sap_stage_planned_order (batch_id, plnum, mdv01, psttr, pstti, pedtr, pedti, gsmng, abmng,
                                     matnr, verid, plwrk, auffx, stlan, stalt /* , ...the rest of the 25 */)
VALUES (:batch_id, ...), (:batch_id, ...), ...;

-- 3. Mark ready. N = the number of rows actually inserted in step 2.
UPDATE sap_stage_batch
   SET status = 'ready', ready_at = now(), row_count_expected = :n
 WHERE batch_id = :batch_id;
```

If anything fails on the Mulesoft side before step 3, `UPDATE sap_stage_batch SET status = 'rejected', error = :reason WHERE batch_id = :batch_id`, then **retry with a brand-new `batch_id`**. Set `row_count_expected` in the same statement that sets `ready` (or earlier, while the batch is still `loading`): once the batch leaves `loading` your login can no longer update it. What to do after a crash, a dropped connection or a NIMBUS rejection is in 7.10.

### 7.3 Rules

1. **A fresh UUID per attempt.** Never re-use a `batch_id`, never append rows to a batch that was already marked ready or rejected. A retry is a new header plus a full set of rows.
2. **Plant match.** The header `plant` must equal the plant field of every row (`werks` for Material Plant, `plwrk` for Planned Orders, `plant` for the two routing tables). A row that disagrees is rejected `plant_mismatch`. The plant must exist in NIMBUS's `plants` table (`unknown_plant` otherwise).
3. **Empty snapshot semantics.** `row_count_expected = 0` with no rows is legal and means "nothing in the planning window" (send the `0` explicitly: a missing count is an incomplete batch). What NIMBUS does with it, per object, is in 7.13; in short an admin must confirm.
4. **Never modify rows after `ready`.** No updates, deletes or late inserts. Mulesoft has no UPDATE right on the row tables and no DELETE right anywhere, and a late insert into a batch that is no longer `loading` is refused by the row-guard trigger (7.8).
5. **Completeness gate.** NIMBUS only takes a `ready` batch whose actual row count equals `row_count_expected`. A mismatch is skipped; once `NIMBUS_SAP_STAGING_LOADING_TIMEOUT_MIN` (default 120) has passed since `ready_at` the batch is rejected (`incomplete_rows`).
6. **Stale `loading`.** A batch left in `loading` longer than `NIMBUS_SAP_STAGING_LOADING_TIMEOUT_MIN` is rejected as stale (`stale_loading`), so a crashed job never blocks the plant.
7. **Newest wins.** When a newer complete batch exists for the same object and plant, older un-applied batches become `superseded`. "Newer" is defined in 7.13.
8. **Formats.** Planned-order dates and times are raw text so a malformed value is a rejected row, never a failed insert: dates `YYYYMMDD` or `YYYY-MM-DD` (`00000000` or blank = not sent), times `HHMMSS` or `HH:MM:SS`; a missing or `000000` time means date-only. Dates and times are in the **SAP system time zone** (`NIMBUS_SAP_SYSTEM_TZ`); NIMBUS converts to each plant's own zone. Quantities are `NUMERIC(13,3)` and typed, so a non-numeric quantity fails the insert on the Mulesoft side. Materials may arrive zero-padded; NIMBUS strips leading zeros from all-digit materials and order numbers. The full per-table format reference (including the typed `BOOLEAN` / `DATE` columns of the routing tables, maximum lengths and encoding) is 7.12.
9. **Batch status machine** (written by NIMBUS except where noted):

```
loading (Mulesoft) -> ready (Mulesoft) -> validated | held | rejected
validated | held -> applying -> applied | error        (error is resumable: Apply again)
any un-applied state -> superseded (newer batch) | discarded (admin) | rejected
```

`held` means validated but waiting for an admin to confirm (reason in `warnings`: `vanish_threshold`, `routing_required`, `empty_snapshot`). Mulesoft may read `status`, `counts`, `warnings` and `error` on its own batches (SELECT is granted on the header).

### 7.4 Column lists (copied from `migrations/2026-10-08-sap-staging-tables.sql`)

**Header `sap_stage_batch`:** `batch_id UUID PK`, `object_key`, `plant`, `source` (`mulesoft` | `upload`), `status`, `row_count_expected INTEGER`, `received_at` (default now), `ready_at`, `validated_at`, `applied_at`, `applied_by`, `created_by`, `counts JSONB`, `warnings JSONB`, `error`. Mulesoft inserts `batch_id`, `object_key`, `plant`, `source` (and optionally `row_count_expected`, `error`; `status` always starts `loading` and cannot be named) and may update only `status`, `ready_at`, `row_count_expected`, `error`.

**Housekeeping on every row table (NIMBUS-owned, leave to defaults):** `id BIGSERIAL`, `batch_id` (FK to the header, cascade), `row_status` (`new` | `valid` | `rejected` | `applied` | `superseded`), `reject_reason`, `received_at`, `applied_at`.

**`sap_stage_material_plant` (13 SAP columns):** `matnr`, `werks`, `mmsta`, `webaz NUMERIC(3,0)`, `verkz`, `stlal`, `stlan`, `plnnr`, `aplal`, `minls NUMERIC(13,3)`, `ltinc NUMERIC(13,3)`, `zz_subnet`, `sauft`. Resolved by NIMBUS (do not write): `material_id`, `plant`.

**`sap_stage_planned_order` (25 SAP columns):** `plnum`, `mdv01`, `psttr`, `pedtr`, `gsmng NUMERIC(13,3)`, `matnr`, `verid`, `prvbe`, `plwrk`, `paart`, `umskz`, `auffx`, `kdauf`, `rsnum`, `stlan`, `stalt`, `abmng NUMERIC(13,3)`, `pstti`, `pedti`, `knttp`, `vfmng NUMERIC(13,3)`, `gsbtr`, `kzavc`, `badi`, `dac_creation_date` (all other columns `TEXT`). Resolved by NIMBUS (do not write): `production_order`, `material_id`, `plant`.

**`sap_stage_production_version` (18 columns, NIMBUS names until SAP Development supplies SAP names):** `plant`, `material_id VARCHAR(18)`, `production_version VARCHAR(4)`, `valid_from DATE`, `valid_to DATE`, `alternative_bom VARCHAR(2)`, `bom_usage VARCHAR(1)`, `task_list_type VARCHAR(1)`, `routing_group VARCHAR(8)`, `group_counter VARCHAR(2)`, `procurement_type VARCHAR(1)`, `special_procurement_type VARCHAR(2)`, `costing_lot_size NUMERIC(13,3)`, `sap_workcenter`, `production_version_text VARCHAR(40)`, `repetitive_mfg BOOLEAN`, `lot_size_from NUMERIC(13,3)`, `lot_size_to NUMERIC(13,3)`.

**`sap_stage_routing_operation` (34 columns, NIMBUS names for now):** `plant`, `material_id VARCHAR(18)`, `task_list_type VARCHAR(1)`, `routing_group VARCHAR(8)`, `group_counter VARCHAR(2)`, `sequence_no VARCHAR(6)`, `activity VARCHAR(4)`, `sap_workcenter`, `workcenter_category VARCHAR(4)`, `base_quantity NUMERIC(13,3)`, `control_key VARCHAR(4)`, `operation_text VARCHAR(40)`, `operation_unit VARCHAR(3)`, `activity_type_machine VARCHAR(6)`, `std_value_machine NUMERIC(9,3)`, `std_value_unit_machine VARCHAR(3)`, `activity_type_labor VARCHAR(6)`, `std_value_labor NUMERIC(9,3)`, `std_value_unit_labor VARCHAR(3)`, `required_overlap BOOLEAN`, `optional_overlap BOOLEAN`, `required_split BOOLEAN`, `field_key VARCHAR(7)`, `num_splits INTEGER`, `task_list_text VARCHAR(40)`, `sequence_category VARCHAR(1)`, `sequence_text VARCHAR(40)`, `num_employees NUMERIC(5,2)`, `setup_group_category VARCHAR(6)`, `setup_group_key VARCHAR(6)`, `deleted BOOLEAN`, `header_status VARCHAR(3)`, `header_valid_from DATE`, `header_valid_to DATE`. A row flagged `deleted` is rejected (`deleted_flag`).

**`sap_stage_planned_order_out` (outbound, 7.7):** `id`, `send_batch_id UUID`, `plant`, `matnr`, `plwrk`, `plnum`, `verid`, `pedtr DATE`, `pedti TIME`, `auffx`, `row_status` (`ready` | `sent` | `error`), `queued_at`, `queued_by`, `sent_at`, `error_text`, `nimbus_order_id`.

**`sap_stage_vanished_order` (NIMBUS-internal archive; no Mulesoft access):** `id`, `batch_id`, `plant`, `order_id`, `order_row JSONB`, `segments JSONB`, `shares JSONB`, `deleted_at`, `deleted_by`, `restored_at`, `restored_by`.

**NIMBUS-internal additions (no Mulesoft access; listed so the schema is complete):** `sap_sync_config.apply_mode TEXT NOT NULL DEFAULT 'manual'` (`manual` | `auto`, one per staging object); `material_plants.sap_missing_since TIMESTAMPTZ` and `production_version.sap_missing_since TIMESTAMPTZ` (nullable; stamped when a snapshot omits a row that something still references, cleared when SAP sends it again). Side table **`order_sap_sent`** (what NIMBUS last sent per order, design D20): `order_id TEXT PRIMARY KEY` (references `orders`, `ON DELETE CASCADE`), `plant TEXT NOT NULL`, `sent_finish TIMESTAMP`, `sent_version TEXT`, `sent_firm BOOLEAN`, `sent_at TIMESTAMPTZ NOT NULL DEFAULT now()`, index on `plant`; it lives outside `orders` so a Send never bumps an order's `xmin`.

Mapping from SAP column to live column is the editable `sap_field_map` (seeded in the same migration, Appendix C of the design doc). Only **active** mapping rows reach a live column; unmapped SAP fields stay staging-only. Composite rules (start/finish from date + time, open quantity = total minus reduced, and so on) are fixed in code, not in the map.

### 7.5 What NIMBUS does with a ready batch

Validation sets each row `valid` or `rejected` with a reason and puts the batch in `validated`, `held` or `rejected`. Apply (manual click, or automatic when that object's `apply_mode` is `auto` and the batch validated clean) writes the live tables. Planned-order apply goes through the same order upsert the Excel upload uses, then **deletes in-horizon orders that are absent from the snapshot** (archived for 30 days, restorable), with three gates: more than **25 %** of the in-horizon orders vanishing, **routing not enabled** for the plant (or no routings loaded), and an **empty snapshot** each hold the batch for admin confirmation (routing cannot be confirmed away). Material plants and production versions absent from a snapshot are deleted when nothing references them and flagged otherwise; absent routings are deleted and their dependent orders go on hold. Apply is a resumable step ladder, not one transaction.

### 7.6 Rejection and warning codes

| Row rejection (`reject_reason`) | Meaning |
|---|---|
| `missing_key` | Material, plant or order number blank (an all-zero order number counts) |
| `plant_mismatch` | Row plant differs from the header plant |
| `unknown_plant` | Plant is not in NIMBUS's `plants` table (also at header level: the whole batch is rejected `unknown_plant`; the header plant is compared trimmed) |
| `unknown_object_key` | Batch-level, not a row code: the header names an `object_key` NIMBUS does not stage; the poll rejects a `ready` batch with this error |
| `duplicate_key` | The key appears more than once in the batch (every copy is rejected) |
| `invalid_date` | Unparseable date, or a planned order with no start date |
| `invalid_time` | Unparseable time |
| `invalid_number` | Total quantity missing or negative, or reduced quantity negative |
| `invalid_int` | BOM usage / alternative is not a whole number |
| `key_too_long` | Material id longer than 18 or plant longer than 10 characters (Material Plant and Planned Order; for an order no master row could ever match such a material) |
| `value_too_long:<col>` | A value longer than the field it lands in; `<col>` is the staging column (today only `mmsta`, 2 characters). Material Plant only; the routing tables have `VARCHAR(n)` columns that refuse an over-long value at insert time instead |
| `deleted_flag` | Routing operation row flagged deleted by SAP |
| `rejected_by_validator` / routing messages | The shared routing validators refused the row; their message is the reason |

| Batch warning / hold (`warnings[].code`) | Meaning |
|---|---|
| `vanish_threshold` | More than 25 % of in-horizon orders are missing from the snapshot; admin must confirm |
| `routing_required` | Plant routing runtime is off or no routings are loaded; planned orders cannot apply yet |
| `empty_snapshot` | Zero rows delivered for a non-order object |
| `horizon_unlimited_no_deletes` | Plant has an unlimited visibility horizon, so nothing is deleted |
| `stale_loading` / `incomplete_rows` | Batch was never completed or its row count never matched; rejected |
| `lot_size_rounded` | Fractional lot sizes were rounded to whole numbers |
| `unknown_columns` / `rows_not_staged` | Excel/CSV test upload only: ignored headers / rows that did not fit their column |
| `discarded` | An admin discarded the batch |
| `sap_system_tz_invalid` | NIMBUS's own SAP time-zone setting (`NIMBUS_SAP_SYSTEM_TZ`) is not a valid zone; NIMBUS refuses planned-order apply and Send to SAP until an admin fixes it. Nothing for Mulesoft to do |

Apply and restore refusals (admin side). They reach the admin's browser as `409` codes or appear in `warnings` / `error`; Mulesoft never has to act on them, but they explain why a batch sits in `validated`, `held` or `error`:

| Code | Meaning |
|---|---|
| `apply_in_progress` | Another apply for the same object and plant is running (one apply per object and plant at a time); try again when it finishes |
| `revalidate_required` | The reviewed state changed before apply (the deletion set grew past what the admin reviewed, or the plant's visibility horizon was set after review); re-validate and confirm again |
| `vanish_not_reviewed` | Batch warning: some orders became deletion candidates after the admin's review and were kept; the next snapshot decides |
| `order_exists` | Restoring an archived order was refused because that order number is live again |

Planned-order apply also reports the shared order-upsert warnings (the same ones an Excel upload shows), informational for the admin: `sap_changed` (orders whose dates, work center, quantity or version SAP changed had their planned slot cleared, so the browser re-derives the start from the SAP finish, the due date), `unfirmed` (manually firmed orders un-firmed because SAP changed them), `sap_changed_running` (running orders SAP changed keep their slot and firm), `routing_running_kept` (running orders keep their run time), `unparseable_dates` (dates that could not be read count as "not sent"), and `not_applicable` / `superseded` (the batch is no longer in an applicable state, or a newer batch exists).

### 7.7 Outbound contract (NIMBUS to SAP)

An admin's **Send to SAP** click queues one row per firmed planned order of the plant (an order that is not firmed is skipped; distribution sub-orders roll up to their parent with the latest end, and an aggregate is sent when any of its sub-orders is firmed) into `sap_stage_planned_order_out` with `row_status = 'ready'`, `pedtr`/`pedti` converted to the SAP system zone, and `auffx = 'X'` when the order is firmed (planner-firmed, already firmed in SAP, or inside the frozen horizon; **add-only**, NIMBUS never clears an SAP firm). Materials and order numbers are sent as NIMBUS stores them (no leading zeros); pad them on the Mulesoft side if SAP requires fixed width. Mulesoft then:

```sql
BEGIN;
SELECT id, send_batch_id, plant, matnr, plwrk, plnum, verid, pedtr, pedti, auffx
  FROM sap_stage_planned_order_out
 WHERE row_status = 'ready' AND plant = :plant
 ORDER BY id
   FOR UPDATE SKIP LOCKED;
-- push to SAP, then per row:
UPDATE sap_stage_planned_order_out SET row_status = 'sent',  sent_at = now()                    WHERE id = :id;
UPDATE sap_stage_planned_order_out SET row_status = 'error', sent_at = now(), error_text = :why WHERE id = :id;  -- SAP import-log reason
COMMIT;
```

Mulesoft may update only `row_status`, `sent_at` and `error_text` and never deletes; a trigger lets its login move a row only `ready` to `sent` or `error`, so a row never leaves `sent`/`error` (to resend, NIMBUS creates new `ready` rows); NIMBUS purges `sent` rows and every `error` row (rows it retired as `requeued` and failures Mulesoft reported) after 30 days. If Mulesoft cannot write per-row status back, the Outbound tiles stay at `ready`; that capability is a go-live prerequisite (design D31). A later click retires any still-`ready` rows first (`error`, `error_text = 'requeued'`). NIMBUS also remembers what it sent on each order (side table `order_sap_sent`; no `orders` row is written) so SAP's echo of that finish is not misread as an SAP change (design D20).

Notes for the Mulesoft developer:

- **Poll cadence is yours to choose.** NIMBUS does not wait for you and does not read your status updates except to show the admin ready / sent / error tiles; a click of Send to SAP simply adds `ready` rows.
- **`sent_at`** is the moment Mulesoft pushed the row to SAP (set it yourself, as in the SQL above). **`error_text`** is the SAP import-log text for a row SAP refused. NIMBUS keeps both for 30 days.
- **Never re-read `sent` or `error` rows.** They never go back to `ready` (the transition trigger of 7.8 forbids it). When NIMBUS resends, it inserts **new** `ready` rows; rows retired as `requeued` (a later Send click replaced them before you picked them up) are `error` with `error_text = 'requeued'` and are not yours to resend.
- **Padding.** SAP may need the 18-character zero-padded `matnr` and the 10-character `plnum`; NIMBUS sends them unpadded (as stored) and `verid` as stored (it can be blank). Padding is Mulesoft's job unless the integration team decides otherwise.
- **OPEN CONFIRMATION (integration team): blank `auffx`.** NIMBUS sends `auffx = 'X'` for a firm order and an empty string (not `NULL`) for any other order, meaning "not firm, leave SAP's firming as it is": it never asks SAP to un-firm. Confirm that SAP's planned-order import treats a blank firming indicator that way and does not clear an existing firm.

### 7.8 The `nimbus_mulesoft` role

Created by hand from `migrations/manual/2026-10-08-nimbus-mulesoft-role.sql` (environment-specific; password set out of band, never in git; steps in `DEPLOYMENT.md`). Least privilege: `USAGE` on schema `public`; `SELECT` on `sap_stage_batch` and the four inbound row tables; **column-level `INSERT`** on the four row tables for the SAP-supplied columns only (never `row_status`, `reject_reason`, `received_at`, `applied_at`, and not the columns NIMBUS resolves: `material_id`/`plant` on material plants, `production_order`/`material_id`/`plant` on planned orders) and on the header for `batch_id, object_key, plant, source, row_count_expected, error` (never `status`, `received_at`, `created_by`, `validated_at`, `applied_at`, `applied_by`, `counts`, `warnings`: `received_at` is the server default so a future-dated header can never be the newest batch forever); a `BEFORE INSERT` trigger on each of the four row tables (`trg_<table>_mulesoft_guard`, function `sap_stage_row_mulesoft_guard`) refuses a row unless its batch is still `loading` and `mulesoft`-sourced (so a late row, or a row into an Excel-upload batch, is impossible); a `BEFORE INSERT OR UPDATE` trigger (`trg_sap_stage_batch_mulesoft_guard`, function `sap_stage_batch_mulesoft_guard`) forces a new batch to `loading` / source `mulesoft` / `received_at = now()` for this login, lets it move a batch only `loading` to `ready` or `rejected`, and sets `ready_at = now()` itself when the batch becomes `ready` (the client's value is ignored); column-level `UPDATE` on the header (`status`, `ready_at`, `row_count_expected`, `error`) and on the outbound table (`row_status`, `sent_at`, `error_text`); `SELECT` on `sap_stage_planned_order_out`; `USAGE, SELECT` on the five `BIGSERIAL` sequences; `CONNECTION LIMIT 10`. Nothing else: no live NIMBUS table, no `DELETE`, no `sap_stage_vanished_order`. The grants go with the table, so re-run the file if a staging table is ever dropped and recreated. A `BEFORE UPDATE` trigger on the outbound table (`trg_sap_stage_out_mulesoft_guard`, function `sap_stage_out_mulesoft_guard`) lets this login move a row only `ready` to `sent` or `error` (or leave its status unchanged), so a row never leaves `sent`/`error`; to resend, NIMBUS creates new `ready` rows. Accepted residual (verified by hand 2026-10-08): PostgreSQL lets every login take any advisory lock, so a runaway or leaked Mulesoft session could hold `hashtext('sap:staging-poll')` and make NIMBUS skip each poll until that session ends; it is mitigated by the connection cap and `pg_terminate_backend`, and a code fix is deferred. The login is a second way into a public database endpoint (`MIGRATION.md`), so it needs `sslmode=require` and a firewall rule limited to Mulesoft's egress addresses.

### 7.9 Retention

Latest applied batch per object and plant only (the previous applied batch is deleted at the next apply); rejected, discarded and superseded batches 7 days; vanished-order archive 30 days; outbound `sent` rows 30 days. The poll sweeps all of them.

### 7.10 Retry and failure

What a Mulesoft developer has to decide when something goes wrong:

- **A new UUID for every attempt.** A retry is a brand-new header plus a full set of rows. Never re-use a `batch_id`.
- **You can only reject a batch while it is still `loading`.** Your login may move a batch `loading` to `ready` or `loading` to `rejected` and nothing else (trigger `trg_sap_stage_batch_mulesoft_guard`, 7.8). You cannot delete rows either, so a half-loaded batch can never be cleaned up and re-used: reject it and start a new one.
- **After NIMBUS rejects a batch you cannot touch it.** NIMBUS rejects a batch for: `stale_loading` (still `loading` after `NIMBUS_SAP_STAGING_LOADING_TIMEOUT_MIN`, default 120 minutes from the header insert), `incomplete_rows` (marked `ready` but the row count never matched `row_count_expected` within that timeout, or `row_count_expected` was never set), `no valid rows in batch` (every row was rejected), `unknown_object_key` (the header names an object NIMBUS does not stage) and `unknown_plant` (the header plant is not a NIMBUS plant; individual rows can also be `plant_mismatch`). Read `status`, `error` and `warnings` on the header; the fix is always **send a NEW batch** after correcting the cause.
- **Network drop between the row inserts and the `ready` update.** Do not guess. `SELECT status, error FROM sap_stage_batch WHERE batch_id = :id` and compare `SELECT count(*)` on the row table with what you meant to insert. If the batch is still `loading`: either finish it (only when you know exactly which rows are missing) or reject it and resend the whole snapshot (the safe choice). If it is anything else (`rejected`, `superseded`, `ready` ...): it is NIMBUS's now; **never reuse a batch NIMBUS marked rejected**, and do not touch a `ready` batch, just wait for its status to change.
- **Re-sending a chunk that may have committed duplicates its rows.** NIMBUS counts duplicate rows toward the completeness check (so the batch passes) and then rejects every copy as `duplicate_key` (7.13). Make chunk retries idempotent or compare counts before retrying.
- **Transactions.** Inserting the rows in chunks (several commits) inside one batch is fine: a batch is invisible to NIMBUS until it is `ready`, so a half-loaded batch is never read. You do not need one big transaction for the whole snapshot. Make the `ready` update a separate, final statement after you have counted the rows. A row inserted into a batch that is no longer `loading` is refused by the row-guard trigger (`trg_<table>_mulesoft_guard`: "may only add rows to a mulesoft batch that is still loading"), so a late insert fails loudly instead of being silently ignored.

### 7.11 What NIMBUS tells you

Your login can read the header (`status`, `counts`, `warnings`, `error`) and the row tables of its own batches (`row_status`, `reject_reason`).

| Batch `status` | Meaning | Mulesoft action |
|---|---|---|
| `loading` | You are still writing it | Finish or reject |
| `ready` | Waiting for NIMBUS's next poll | None |
| `validated` | Every row was checked; waiting for apply (automatic for an object switched to `auto`, otherwise an admin clicks Apply) | None |
| `held` | Validated, but an admin must confirm first (reasons in `warnings`: `vanish_threshold`, `routing_required`, `empty_snapshot`) | None: an admin acts |
| `applying` | NIMBUS is writing the live tables (a multi-step process; if the server was restarted mid-apply an admin resumes it with Apply) | None |
| `applied` | Done; the latest applied batch per object and plant is kept | None |
| `error` | An apply step failed; the step is named in `error`; an admin presses Apply again to resume | None |
| `superseded` | A newer batch for the same object and plant replaced it (nothing is wrong) | None |
| `rejected` | Rejected by you or by NIMBUS (see `error` / `warnings`, 7.10) | Send a new batch |
| `discarded` | An admin dismissed it | None |

- **Partial acceptance is normal.** A `validated` batch can contain rejected rows. The batch `counts` (JSON) carry `total`, `valid`, `rejected` and `by_reason`; the reason for each row is in `reject_reason` (`SELECT id, plnum, reject_reason FROM sap_stage_planned_order WHERE batch_id = :id AND row_status = 'rejected'`). Rejected rows are not retried by NIMBUS: they are fixed at the source and arrive in the next snapshot. Only a batch with rows but **no** valid row is rejected as a whole.
- **`held` needs no Mulesoft action.** It waits for an administrator.
- **Plants.** Your login has no `SELECT` on `plants`. Ask the NIMBUS admin for the list of plant codes NIMBUS knows; a batch for any other plant is rejected `unknown_plant`.

### 7.12 Formats per table

Encoding is **UTF-8** (the database encoding). A value that a typed column cannot hold fails **your insert** (a database error on your side); a malformed value in a text column is a **rejected row** (visible in `reject_reason`) and the rest of the batch continues.

| Table | Column(s) | Accepted values | Otherwise |
|---|---|---|---|
| `sap_stage_planned_order` | `psttr`, `pedtr` (dates, `TEXT`) | `YYYYMMDD` or `YYYY-MM-DD` (a trailing time part after a space or `T` is ignored). `00000000`, `0000-00-00` or blank = not sent | Any other shape: `invalid_date`. A missing start date is `invalid_date`; a missing or unreadable finish date is also `invalid_date`, because NIMBUS no longer derives a finish and stores the one SAP sends exactly as received |
| `sap_stage_planned_order` | `pstti`, `pedti` (times, `TEXT`) | `HHMMSS` (always send all six digits: a shorter digit string is left-padded with zeros, so `1530` would read as 00:15:30), `HH:MM:SS` or `HH:MM`. Blank or `000000` = date only (no time-zone conversion for a date-only value) | `240000` and any hour past 23 is `invalid_time`. For an end-of-day finish send `235959`: do **not** send the next day with `000000`, because a midnight finish is treated as a date only (no real time). A date-only finish is stored as received, and the browser reads it as the end of that day's working window |
| `sap_stage_planned_order` | `gsmng`, `abmng`, `vfmng` (`NUMERIC(13,3)`) | A number with `.` as the decimal separator and no thousands separator, at most 10 integer digits and 3 decimals | A non-number (for example `1,234.5`) fails your insert. `gsmng` blank or negative, or `abmng` negative: `invalid_number`. `abmng` blank = 0 |
| `sap_stage_planned_order` | `stlan`, `stalt` | Whole numbers (as text); blank is fine | A fractional or non-numeric value: `invalid_int` |
| `sap_stage_planned_order` | `plnum`, `matnr`, `plwrk` | `matnr` up to 18 characters and `plwrk` up to 10 after NIMBUS strips leading zeros from an all-digit `matnr`; `plnum` has no length limit in NIMBUS (SAP's own planned-order number is 10 characters); an all-zero `plnum` counts as blank | Blank: `missing_key`. Over-long `matnr` / `plwrk`: `key_too_long` |
| `sap_stage_material_plant` | `matnr`, `werks` | `matnr` up to 18 characters (leading zeros of an all-digit value are stripped first), `werks` up to 10; `mmsta` at most 2 characters | `key_too_long`; `mmsta`: `value_too_long:mmsta` |
| `sap_stage_material_plant` | `minls`, `ltinc` (`NUMERIC(13,3)`), `webaz` (`NUMERIC(3,0)`) | Numbers as above. `minls` / `ltinc` are stored as whole numbers: a fraction is rounded and counted in a `lot_size_rounded` warning | A non-finite value: `invalid_int`. `zz_subnet`: NIMBUS keeps its first 3 characters |
| `sap_stage_production_version`, `sap_stage_routing_operation` | `DATE` columns (`valid_from`, `valid_to`, `header_valid_from`, `header_valid_to`) | A `DATE` value, or a string `YYYY-MM-DD` or `YYYYMMDD`. Use `NULL` for "none" | `00000000`, an empty string or any other shape **fails your insert**: map SAP's `00000000` to `NULL` |
| `sap_stage_production_version`, `sap_stage_routing_operation` | `BOOLEAN` columns (`repetitive_mfg`, `required_overlap`, `optional_overlap`, `required_split`, `deleted`) | `true` / `false` (also `t` `f` `yes` `no` `y` `n` `on` `off` `1` `0`, any case). `NULL` is read as false. **SAP's `X` is not accepted** by the database | `X` fails your insert: send `true` for `X` and `false` or `NULL` for blank. A routing operation with `deleted = true` is rejected `deleted_flag` |
| the two routing tables | numeric and `VARCHAR(n)` columns | The types listed in 7.4 | A number with a thousands separator or a string longer than `n` fails your insert |

Maximum lengths NIMBUS checks itself: material 18, plant 10, `mmsta` 2. Everything else is the declared column type. Routing codes (`production_version` 4, `group_counter` 2, `sequence_no` 6, `activity` 4) are zero-padded for matching, so `1` and `01` are the same key.

### 7.13 Duplicates, newest wins, empty snapshots

**Duplicate key per object** (every copy of a duplicated key is rejected `duplicate_key`; none of them is applied):

| Object | Key |
|---|---|
| Material Plant | material (zero-stripped) and plant |
| Planned Order | order number (zero-stripped) and material (zero-stripped) |
| Routing part 1, production versions | plant, material, production version (padded to 4) |
| Routing part 2, operations | plant, material, task list type, routing group, group counter (padded to 2), sequence number (padded to 6), operation / activity (padded to 4) |

**"Newest wins".** Among the batches of one object and plant that are not applied yet (`ready`, `validated`, `held`), the newest is the one with the latest `received_at` (the server time of the header insert; your login cannot set it), then the latest `ready_at`, then the highest `batch_id`. Every older one becomes `superseded` at the next poll. An `applying` or `applied` batch is never superseded. A newer batch that is still incomplete does not block an older complete one from being processed.

**Empty snapshot (`row_count_expected = 0`, no rows) per object:**

| Object | What NIMBUS does |
|---|---|
| Planned Orders | Not held as `empty_snapshot`; the 25 % rule decides. If NIMBUS holds any live in-horizon order for the plant, every one is a deletion candidate, so the batch is always **held** `vanish_threshold` until an admin confirms. If the plant has an unlimited visibility horizon nothing is ever deleted (warning `horizon_unlimited_no_deletes`). If there are no live in-horizon orders the batch is `validated` (routing must still be on, see `routing_required`) |
| Material Plant, production versions, routing operations | **Held** `empty_snapshot` (always), plus `vanish_threshold` when more than 25 % of the live rows would go; an admin must confirm |

Send the `0` explicitly: a batch whose `row_count_expected` was never set is an incomplete batch (7.10).
