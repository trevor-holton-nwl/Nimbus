# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**NIMBUS** (Newell Integrated Batch & Unified Scheduling) — a production scheduling and order optimization tool for Newell Brands manufacturing. It renders a Gantt chart timeline, an AG Grid orders table, a dashboard with KPIs/charts, and a calendar manager for working hours and blackout blocks.

## Production Scale Roadmap

NIMBUS is designed to grow to enterprise scale. **All UI and data design decisions must anticipate this:**

| Dimension | Current (prototype) | Target scale |
|-----------|--------------------|--------------:|
| Plants | 1–3 | **50+** |
| Production lines per plant | ~5 | **70+** |
| Total lines across system | ~15 | **3,500+** |

**Design implications:**
- **Never use bubble/chip selectors for plants or lines** — these break at any scale beyond ~10 entries. Use searchable dropdowns (comboboxes) instead.
- **Plant and line lists must always be filterable** — at 50+ plants and 70+ lines, scrolling is not enough.
- **Hierarchy navigation** (plant → line) must be scoped to reduce cognitive load; showing all lines for all plants simultaneously will not scale.
- **API endpoints that return plant or line lists** must support pagination or filtering at the server level — full list queries become untenable.
- **Color wheels, blackout blocks, and calendar configs are per-plant** — storage and retrieval must be keyed by plant ID, not assumed to be global.
- **Utilization and dashboard charts** must be filterable and aggregatable by plant, not rendered for all plants at once.

This is the primary long-term scalability constraint for every feature in NIMBUS.

## Running the App

The backend serves **both** the JSON API and the static frontend (a `StaticFiles` mount at `/`), so local dev is a single process.

```bash
pip install -r requirements.txt
uvicorn brain:api --port 8000      # add --reload for auto-reload during dev
# Then open http://localhost:8000/
```

> `brain.py` has **no `if __name__ == "__main__"` block** — `python brain.py` does nothing. The entrypoint is always `uvicorn brain:api` (this is also the container `CMD`).

No build step — JavaScript and CSS are loaded directly; most libraries come from CDN.

**Legacy two-process split** (serving the UI separately on another port) still works but now needs a shim, because `app.js` `API_BASE` defaults to same-origin (relative). Set `window.NIMBUS_API_BASE = 'http://localhost:8000'` before `app.js` loads, then `python -m http.server 9000`. Prefer the single-process command above.

## Database Setup

Postgres must be running locally. Bootstrap the schema (idempotent by design, but **not strictly run-once**: `schema.sql` contains data-mutating migrations — notably `plants` horizon columns are multiplied ×1440 for any value `<= 365` on every run, so re-applying after a legitimate sub-365 horizon edit silently re-multiplies):
```bash
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE nimbus;"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d nimbus -f schema.sql
```

Connection credentials are read from environment variables (via `.env` file in the project root, loaded by `python-dotenv`):
```
PG_HOST=localhost
PG_PORT=5432
PG_DB=nimbus
PG_USER=postgres
PG_PASS=your_password
```

Pool tuning knobs (all optional): `NIMBUS_PG_POOL_MIN`, `NIMBUS_PG_POOL_MAX`, `NIMBUS_PG_POOL_TIMEOUT`, `NIMBUS_PG_STATEMENT_TIMEOUT_MS`.

> **Color-wheel paths are env-driven:** `COLOR_FILE` and `COLOR_WHEEL_DIR` in `brain.py` read from env vars (`os.getenv`), defaulting to a local Windows path for dev — override them via `.env` on a new machine. The container image sets them to `/data/color_wheel.xlsx` and `/data/color_wheels` (an **ephemeral** dir on the pilot — uploaded wheels are lost on restart; see `MIGRATION.md` for the Azure Files durability fix).

## Data Sources

**Orders live in Postgres**, not Excel. `db.py` owns all connection management and queries; `brain.py` is **stateless** — it holds no in-memory order cache. Every `GET /tasks` request queries the DB directly via `db.query_orders()`. This allows multiple uvicorn workers or replicas without shared state.

- **Order ingest** — `POST /upload` accepts a `sequence_testing`-shaped `.xlsx` and upserts rows into the `orders` table (`db.ingest_orders_from_excel`). The actual orders-upsert is now factored into `db.upsert_orders`, the **shared** upsert used by both the `/upload` path and the SAP sync path (`sap_sync.py`). Each order's **plant is materialized on the row** (`orders.plant`) at ingest — from a `WERKS`/`PLANT` upload column when present, else derived from the line→plant mapping — so the `/tasks` read path selects `o.plant` directly instead of `LEFT JOIN`ing `production_lines` on the line code alone (which fanned out / mis-attributed orders when a line code is reused across plants). `orders.plant` is added by a `schema.sql` migration: **re-run `schema.sql`** after pulling this change or `GET /tasks` errors on the missing column. A real authoritative plant source (Excel column or upload picker) and a plant-aware `make_id` are still needed before line codes are reused across plants — see `MIGRATION.md`.
- **Color wheels** — still file-based: a global `color_wheel.xlsx` (`COLOR_FILE` in `brain.py`) plus per-plant `color_wheel_<PLANT>.xlsx` files under `COLOR_WHEEL_DIR`, uploaded via the Plant tab. These are cached in `GLOBAL_CW` / `PLANT_CWS` at startup, on `POST /reload`, and **inline after every color-wheel upload/delete** (so a new wheel takes effect without an explicit `/reload`).
- **Master data** — `master_data.py` backs the `/master-data/*` and `/labor-plan*` endpoints against Postgres. `ALLOWED_TABLES` covers five tables — `subnetworks`, `plants`, `production_lines`, `materials`, `material_plants` — keyed by composite keys (plants by `(subnetwork, plant)`, not plant alone). Beyond list/bulk CRUD it owns runtime DDL (add/drop/rename-label column), the cascade-delete preview, an `admin_audit` log, per-plant JSONB constraint config (`set_plant_constraints`), the **Labor Planning** subsystem (`labor_plan` + `labor_plan_line` tables, aggregate + line-level load/upsert), and `known_plant_line_codes()` (used by `/upload` validation). Most dynamic SQL goes through `psycopg.sql.Identifier` / parameterized placeholders; `add_column`'s `NUMERIC(length)` is validated as `precision[,scale]` and rebuilt via `sql.Literal` before composing (previously a raw DDL-injection sink). Maintenance DDL in `db.py` (`VACUUM ANALYZE`/`ANALYZE`) uses an allowlist check against `pg_stat_user_tables` rather than `Identifier`.
- **SAP sync (skeleton)** — `sap_sync.py` is a **transport-agnostic** SAP→NIMBUS sync engine; its connectors are **stubs today** (no live SAP calls). It is backed by three Postgres tables: `sap_sync_config` (per-object sync settings), `sap_sync_run` (run history/status), and `sap_field_map` (SAP field → NIMBUS column mapping). The synced orders are written through `db.upsert_orders` (the same upsert as `/upload`). Surfaced in the Admin **Interface** sub-tab.

## Deployment Notes

- **Hosted on Azure (single-container pilot, live since 2026-06-30).** Deployed as one container to **Azure Container Apps** — FastAPI serves the API and the static UI from the same origin, against Azure Database for PostgreSQL. Live URL: `https://ca-nimbus-dev.delightfulwater-7252cdf0.eastus2.azurecontainerapps.io/`. Resources (RG `rg-nimbus-dev`, region `eastus2`): ACR `acrnimbusdev` (image `nimbus:vN`), Container App `ca-nimbus-dev`, env `cae-nimbus-dev`, Postgres `pgdb-nimbus-dev`/`nimbus`. **Redeploy:** `az acr build -r acrnimbusdev -t nimbus:vN <repo>` then `az containerapp update -g rg-nimbus-dev -n ca-nimbus-dev --image acrnimbusdev.azurecr.io/nimbus:vN`. Full runbook + gotchas in **`DEPLOYMENT.md`**; remaining hardening (Entra SSO, Key Vault, color-wheel durability) in **`MIGRATION.md`**. The pilot runs **single-replica** (in-process color-wheel cache + log buffer), and CORS is effectively vestigial since the UI is same-origin.
- **`POST /reload`** refreshes the in-process color-wheel file cache only. It does **not** reload orders (they are never cached — every `/tasks` request hits Postgres).
- **`APP_VERSION`** in `app.js` and **`NIMBUS_BUILD_ID`** in `index.html` must be kept in sync and bumped on every deploy to bust static asset caches.
- **CORS / optional auth env:** `NIMBUS_ALLOWED_ORIGINS` (comma-separated; default `*`, with `allow_credentials=False`) pins allowed origins for hosting. `NIMBUS_API_KEY` (unset by default ⇒ no-op) gates the destructive/DDL/maintenance routes behind an `X-API-Key` header — a deployment-config stopgap, **not** user-level auth (actor identity is still read from spoofable `X-User`/`x-user-email`; the real fix is Entra SSO — see `MIGRATION.md`).
- Structured JSON logs are emitted to stdout (`nimbus.*` logger tree, one JSON object per line). `x-request-id` is threaded through every request (only requests slower than 1500 ms are logged). A 500-entry in-memory ring buffer (`_BACKEND_LOG`) is surfaced via `GET /logs/backend` — it is **per-process** (lost on restart, not shared across replicas). Frontend `ErrorLog` entries do not currently store the `x-request-id`, so correlation to backend logs is effectively by timestamp/scope.

## Architecture

### Frontend (`app.js` — ~32 sequential IIFE modules; plus `nimbus-intelligence.js`)

> The module count is approximate and undercounts: beyond the layer table below, `app.js` also defines `VirtualList` and `PerfMonitor` (Foundation infra), the `OptimizeDialog` + `OptimizerPreview` optimize-with-preview pair, `ColorWheelViewer` and `EditCalendar` modals, `EmptyState`/`WelcomeSplash` boot UI, and a full `MasterData` CRUD grid (the "Manage Data Tables" admin sub-tab, distinct from `Plant`/`ProdLines`/`LaborPlanning`).

All modules are plain vanilla JS IIFEs that execute top-to-bottom and attach to a single `window.NIMBUS` namespace. The module load order matters — each module can only reference modules declared above it.

A second frontend file, **`nimbus-intelligence.js`** (~2,200 lines, loaded after `app.js` in `index.html`), extends `window.NIMBUS` with the intelligence layer: `CommandPalette` (Cmd+K), `NeedsEngine`, `TimeMachine`, `Confidence`, `RipplePreview`, `Diff`, `Patterns`, `DarkMode`, and `LangSwitcher`, plus an `IntelDB` IndexedDB helper. (There are **no** `Voice` or `Haptic` modules.) Depth varies by module — `CommandPalette`, `NeedsEngine`, and `Confidence` are the most mature.

**Localization:** `locales/` holds i18n string maps (en, de, es, fr, pt). Loaded **before** `app.js` (first in the script chain) — `app.js` reads these maps when it defines `window.t`, so they must exist on `window` first.

**Web Worker:** `nimbus-worker.js` runs Alerts and Utilization compute off the main thread. It is **standalone** — zero DOM access, no `window.NIMBUS` dependency — and duplicates not just `Config` constants and `Util` helpers (`OVERLOAD_THRESHOLD`, `WARN_THRESHOLD`, `SHOW_NEAR_CAPACITY_ALERTS`, `DEFAULT_SHIFT`, `WEEKEND_OFF`, `parseDate`, `dayKey`, `startOfDay`, `runHours`, `mergedOverlapHours`, `fmtDTReadable`) but a **full hand-port of the `Calendar` capacity engine** (`getPlantForLine`, `ensureCalendar`, `ensurePlant`, `_dayWindow`, `workWindow`, `dailyCapacityHours`, `effectiveCapacityHours`) **and the entire `Alerts._recomputeSync` rule set** (overlap / overload / closed / blackout / fixed-closed / fixed-out-of-hours). Any change to `Calendar`, `Store.getPlantForLine`, or the alert rules **must be mirrored here rule-for-rule** — a code comment is the only guard against drift. The `Compute` module in `app.js` (a singleton `new Worker('nimbus-worker.js')` wrapper) posts plant-scoped Store snapshots over `postMessage` and falls back to synchronous main-thread compute if the worker fails to load or errors — **and this fallback is permanent for the session** (a single worker `onerror` sets `_dead=true` with no auto-restart, routing all later compute to the main thread until reload). The snapshot is deliberately scoped to the selected plant's lines — the structured-clone on each `postMessage` is the dominant main-thread cost, so `calendars`/`lineSettings` are pruned to on-screen lines. Note: the worker is loaded by bare filename (no `?v=` cache-bust), unlike the versioned `<script>` tags.

**Core layers (bottom-up dependency order):**

| Layer | Modules | Role |
|-------|---------|------|
| Foundation | `Config`, `Util` | Constants, pure helpers |
| | `VirtualList`, `PerfMonitor` | Windowed list (binary-search variable-height); ring-buffer p50/p95 profiler read by AdminCockpit's Thread tab |
| State | `Store` | Reactive pub/sub; single source of truth. All state lives here. |
| Domain | `Calendar`, `Alerts`, `Utilization`, `Engine` | Business logic that reads/writes Store |
| Infrastructure | `ErrorLog`, `DataIntegrity`, `Toast`, `Modal`, `UndoStack` | Cross-cutting concerns |
| Master Data UI | `Plant`, `ProdLines`, `LaborPlanning` | Plant/line management tabs; labor plan editor |
| UI components | `Timeline`, `Table`, `Inspector`, `Hierarchy`, `Dashboard`, `UtilStrip`, `TimelineNav`, `GanttFilter`, `DependencyOverlay`, `ContextMenu`, `Selection` | Render and respond to Store changes |
| What-if | `Sandbox` | What-if mode; edits the **live** Store directly and keeps a deep-cloned pre-edit snapshot (tasks/blocks/calendars/fixedIds) reverted on discard — **not** an isolated Store copy. Autosave is suppressed while `Sandbox.active`, but live in-memory state IS mutated. |
| | `OptimizeDialog`, `OptimizerPreview` | Optimize modal; `OptimizerPreview.runWithPreview` wraps `Engine.runAndApply` with a before/after KPI preview, snapshots the whole plant for undo, then applies or discards. The user-driven optimize flow routes through here; the alert auto-fix path calls `Engine.runAndApply` directly. |
| | `ColorWheelViewer`, `EditCalendar`, `MasterData` | Color-wheel preview modal; per-line/plant working-hours modal (14 Flatpickr pickers); "Manage Data Tables" CRUD grid (paste, FK selects, add/drop/rename column, cascade-delete preview). |
| Input | `Interaction` | Unified click/keyboard/drag pipeline; calls Engine and mutates Store |
| Data | `Persistence` | Backend fetch, localStorage cache (key `nimbus.state.v3`, shape gated by `Config.SCHEMA_VERSION` — currently 4 — **not** the key suffix; cache discarded on schema mismatch), auto-save |
| Boot | `PlantSelector`, `AdminCockpit`, `Printer`, `App` | Plant picker, upload/data management, print/export, tab switching |

> `Util` is **not** purely "pure helpers": it also owns `fetchTraced` (the standard fetch wrapper — attaches `x-request-id`, logs slow/failed requests), the i18n resolver `Util.t` / global `window.t`, the `fpDatetime` Flatpickr factory, and the SAP-variance/optimizer-KPI helpers (`sapDueDate`/`scheduledEnd`/`latenessHours`/`countChangeovers`/`scheduleKpis` — the last calls `Utilization.computeMatrix`, so it is not stateless).

> `Interaction` also owns a Ctrl/Cmd+drag marquee multi-select (edge-scroll), a 500 ms hover-preview card, double-click-label line isolation, 60 fps multi-order ghost-drag, and two-way AG Grid ↔ `Selection` sync.

> `AdminCockpit` is far more than upload/data management: it embeds a Postgres ops console (pool utilization, server info, table bloat + VACUUM/ANALYZE triggers, active-connection stacks, blocking-lock chains, index usage/unused detection, slow-query bars via `pg_stat_statements`, sequence exhaustion), a `PerfMonitor` thread profiler, and a diagnostics-bundle exporter. `App` manages top tabs (home/gantt/masterdata/admin/labor) plus three independent sub-tab dimensions (`_ganttSub` timeline|orders, `_laborSub`, `_currentMasterSub`). The admin area carries an **Interface** sub-tab (Overview → Manage Data Tables → Interface), backed by a dedicated `Interface` frontend module that manages the SAP sync config, field mapping, and run history (see Backend → `sap_sync.py`); the SAP connectors are **stub skeletons** today.

**State flow:** User action → `Interaction` → mutate `Store` → `Store.publish()` → subscribed UI modules re-render.

**Undo:** `UndoStack` (10 levels) wraps any destructive Store mutation. Always snapshot before calling Engine optimization or bulk drag operations.

**Known plants:** `Config.KNOWN_PLANTS` (`['5512', '1006']`) is only a **fallback** seed. `Store.knownPlants()` prefers master-data plants and returns them alone when present, ignoring `KNOWN_PLANTS` entirely; the seed (merged with order-derived discovery) is used only when master data has no plants. The authoritative onboarding path is the Master Data `plants` table, not editing `KNOWN_PLANTS`.

### Backend (`brain.py` — FastAPI; data layer in `db.py`, `master_data.py`)

`brain.py` exposes ~38 endpoints (tasks, task notes, concurrency refresh, diagnostics + DB deep-dive/maintenance, upload/purge/audit, color wheels, master data + column DDL + constraints, labor planning, backend log buffer, health). A separate `sap_sync.py` module owns the SAP→NIMBUS sync engine and an **in-process APScheduler started in the lifespan hook — disabled by default**, gated by `NIMBUS_SAP_SYNC_ENABLED` (unset ⇒ scheduler never starts). The pilot runs single-replica, so this in-process scheduler is safe today; multi-replica needs an advisory-lock guard (see `MIGRATION.md`). The most load-bearing endpoints:
- `GET /tasks` — task list with finish-to-start links and metadata; supports `?plant=`/`?line=` server-side scoping plus optional `?limit=`/`?offset=` pagination (`meta.total` carries the full filtered row count when paging). Calls `db.query_orders()` on every request — no cache.
- `GET /diagnostics` / `GET /diagnostics/deep` — load statistics and DB stats. `GET /diagnostics/db` exposes a deep DB-observability layer (pool stats, server info, table health, connection activity, blocking-lock chains, index usage, slow queries via `pg_stat_statements`, sequence health); `POST /maintenance/vacuum-analyze` and `/maintenance/analyze` trigger maintenance behind a table allowlist. Driven by the AdminCockpit console.
- `POST /task/note`, `POST /tasks/refresh` (concurrency reconciliation), `GET/POST /logs/backend`(+`/clear`), `GET /upload/audit`, `GET/POST /audit/log`(+`/clear`), `GET /health`, `/labor-plan` + `/labor-plan/line`, `POST /master-data/plants/{plant}/constraints`, `/master-data/{table}/cascade-preview`, `/master-data/{table}/columns` (ADD/DROP/rename label DDL), `/master-data/_audit`
- `POST /reload` — refreshes color-wheel file cache (`GLOBAL_CW` / `PLANT_CWS`); does **not** affect orders
- `POST /task/update` — update one task's start/end
- `POST /tasks/update` — bulk update (the frontend autosave path; payload `{ tasks, blocks?, calendars? }`)
- `POST /tasks/bulk_update` — flat-list alias for external tooling
- `POST /upload` — ingest a `sequence_testing`-shaped `.xlsx` into the `orders` table

All three `/update` endpoints call `db.update_task_dates_bulk()`, which validates payloads, **persists each edit to Postgres** (`scheduled_start` / `scheduled_end`), and rejects inverted ranges (end ≤ start). A DB-write failure leaves Postgres unchanged (single transaction). `POST /reload` does not touch orders.

**Optimistic concurrency:** each update carries `base_version` (the row's Postgres `xmin`, surfaced as `ROW_VERSION` on the read path) and a `force` flag. Under `SELECT … FOR UPDATE`, a `base_version` mismatch is **not** a 4xx — the id is returned in a `stale` list (HTTP 200) along with new `versions`, and the frontend reconciles via `POST /tasks/refresh` with **last-writer-loses** semantics (the local edit is discarded and server truth refetched). `force` (set for optimizer-dirtied ids, or when `Config.CONCURRENCY_CHECK` is false) bypasses the check. `db.py` also has single-row `update_task_dates()` and `update_task_note()` paths.

Task IDs are MD5 hashes of `f"{PRODUCTION_ORDER}|{MATERIAL_NUMBER}"` computed by `make_id()` in `db.py`. Because the hash excludes time, IDs are stable across reloads and reschedules — the frontend relies on this for keying drag/edit operations.

### Key Patterns

- **Optimization** runs through `Engine.runAndApply(mode)` where `mode ∈ {'spt', 'changeover', 'combined'}`. These are **dispatching heuristics, not true optimization** — there is no changeover-cost matrix, no finite-capacity constraint, and finish-to-start precedence is not consulted. `'spt'` sorts by run-hours ascending. `'changeover'` groups each line's orders by `COLOR` priority → `FORM_SIZE` → `MATERIAL_NUMBER` so same-attribute orders sit adjacent (approximating setup minimization). `'combined'` keeps that color+form grouping but runs the shortest job first **within** each group (SPT inside changeover groups). It differs from `'changeover'` only in the **last two sort terms** (`'combined'`: runHours → MATERIAL_NUMBER; `'changeover'`: MATERIAL_NUMBER → runHours), i.e. a within-group tie-break — not a different grouping. The greedy dispatcher then places sorted orders back-to-back, jumping fixed orders and calendar/blackout-closed windows (with a 200-iteration guard that now logs via `ErrorLog.warn` if it fails to converge). `Engine` carries a per-plant switchable-constraint registry (`CONSTRAINT_CATALOG` / `constraintsFor` / `activeConstraintKeys`) backed by the `plants.constraints` JSONB column and surfaced in the per-plant System Settings pane (`App._renderSettingsPane`). Today only `colorWheel` is wired into the optimizer; the registry is the extension point for future constraints.
- **Auto-reflow** after manual edits: `Engine.autoReflow()` re-flows subsequent unfixed orders on the affected line to eliminate overlap created by a drag. It only shifts dates within one line, so it triggers an incremental, line-scoped alert recompute. Anything in the Interaction → Engine path needs to be aware of this.
- **Alerts** (overlap, overload, blackout, fixed-closed, fixed-out-of-hours) are computed by `Alerts.recompute(opts)`. A bare call scans all lines; `recompute({ lines })` does an **incremental pass** scoped to specific lines and merges the result into the existing alert list. The debounced dispatcher (`scheduleRecompute` / `scheduleRecomputeLines`) is **adaptive** — its delay scales with the last recompute's measured cost (replacing the old fixed 80 ms window). The actual compute is offloaded to `nimbus-worker.js` via the `Compute` wrapper (sync fallback if the worker is down — see Web Worker above). **Note:** `Confidence.init` (in `nimbus-intelligence.js`) monkey-patches `Alerts.recompute` to also trigger a debounced confidence recompute, but it **forwards all arguments** (`Alerts.recompute = (...args) => { const r = origRecompute(...args); … }`), so the `{ lines }` incremental scope is **preserved** (a previous version of this note wrongly claimed an arity-0 wrapper dropped the scope). Blackouts are also visually enforced by `Calendar` — dragging onto a blackout block snaps to the next valid slot.
- **Utilization** is computed per-line per-day in `Utilization.computeMatrix()` (surfaced in `Hierarchy`, `UtilStrip`, and `Dashboard`). There is a second utilization path — `Utilization.dayByLine` / `todayByLine` (backing today/day summaries) — that is **unmemoized and not worker-offloaded**: it re-parses every blackout block on each call. The Store-backed path (`srcTasks === null`) is **memoized** on `(startMs, days, Store._rev)`; `Store._rev` bumps on every mutation, so a cache hit reflects current data **only for that path**. Two scope caveats: (1) `Dashboard` always passes a **non-null filtered** task subset (`srcTasks !== null`), which bypasses the memo entirely — the matrix is rebuilt several times per dashboard render. (2) The off-thread prewarm writes a **plant-scoped** matrix under the same `(startMs, days, rev)` key the synchronous path expects to be **global** (all lines), so for a given key whichever producer runs first wins — the key carries no plant discriminator. Heavy matrix builds are pre-warmed off-thread through the same `nimbus-worker.js` worker.
- **Auto-save** is debounced 1,200 ms in `Persistence` and writes the **localStorage cache only** (`_saveCache`) — it does **not** post to the backend. Backend persistence (`saveAll` → `POST /tasks/update`) is **explicit**: Cmd/Ctrl+S or the Save button. Note `saveAll` always POSTs full `blocks`/`calendars` even with an empty dirty-task set, and on a partial save it clears all dirty ids before checking `persisted < total`, so un-persisted rows are not auto-retried.

### Date / Time Inputs — Flatpickr Standard

**All date and time inputs in NIMBUS use [Flatpickr](https://flatpickr.js.org/) — never native `<input type="date">`, `<input type="datetime-local">`, or `<input type="time">`.**

Flatpickr is loaded via CDN in `index.html` (before `styles.css`). The NIMBUS amber theme lives mid-file (~line 2226) under `/* Flatpickr calendar — NIMBUS amber theme */`, with dark-mode counterparts at ~line 4158. **Exception:** the AG Grid inline `start_date` cell editor (`Table._DateTimeEditor`) is a native `<input type="datetime-local">`, not Flatpickr.

**Configs by input type:**

| Type | `enableTime` | `noCalendar` | `dateFormat` | `altInput` | `altFormat` |
|------|:---:|:---:|---|:---:|---|
| Date-only | — | — | `"Y-m-d"` | `true` | `"M j, Y"` |
| Datetime | `true` | — | `"Y-m-d\\TH:i"` | `true` | `"M j, Y · h:i K"` |
| Time-only (hours table) | `true` | `true` | `"H:i"` | — | — |

**Pattern for modal inputs (lazy init + setDate):**
```js
if (!Module._fpMyInput) {
  Module._fpMyInput = flatpickr('#my-input', {
    enableTime: true, dateFormat: 'Y-m-d\\TH:i',
    altInput: true, altFormat: 'M j, Y · h:i K', minuteIncrement: 30,
  });
}
Module._fpMyInput.setDate(someDate, false); // false = suppress onChange
```

**Pattern for dynamic/table time inputs (wiring loops):**
```js
flatpickr(inS, { enableTime: true, noCalendar: true, time_24hr: true, dateFormat: 'H:i', onChange: upd });
flatpickr(inE, { enableTime: true, noCalendar: true, time_24hr: true, dateFormat: 'H:i', onChange: upd });
```

With `altInput: true`, existing `.value` reads in save functions keep working — the hidden original input holds the machine-readable `dateFormat` value; the visible alt input shows `altFormat`.

**Registered Flatpickr instances** (module-level, lazy init):
- `OptimizeDialog._fpStart` / `._fpEnd` — optimization modal time window
- `Plant._pillFps` — 7 per-day {start,end} working-hours pickers; `EditCalendar._fp` — 14 working-hours time pickers; `LaborPlanning._fpHorizon` — horizon date-jump
- `Calendar._fpBlkStart` / `._fpBlkEnd` — blackout block modal (line-level)
- `Plant._fpBlkStart` / `._fpBlkEnd` — plant blackout modal
- `ProdLines._fpBlkStart` / `._fpBlkEnd` — production lines blackout modal
- `Table._fpOvrStart` — order override modal
- `Printer._fpStart` / `._fpEnd` — export/print modal
- `AdminCockpit._fpPurgeStart` / `._fpPurgeEnd` — admin purge date range
- Inspector `start_date` — initialized fresh on each `Inspector._render()` call (no stored instance; old one is discarded with innerHTML reset)

### Files

`styles.css` (~4,900 lines) uses a CSS-variable design-token system (warm off-white light base, deep-slate dark mode, amber accent) with a `body.dark` layer that is **incomplete** — several newer components hardcode light colors (e.g. `.cw-active-card`, `.welcome-splash`, `.lp-hm-grad`, `.tab-btn.active` outline) and a few tokens are referenced but never defined (`--border`, `--border-subtle`, `--font-mono`, `--amber`, `--nimbus-amber`, `--bg-float`). `index.html` also carries ~850 lines of inline `<style>` that have not yet been migrated into `styles.css`. (`nimbus-interaction.js` was previously a separate file, but the `Interaction` module is now inlined into `app.js`.) `nimbus-worker.js` is the standalone Web Worker (see Frontend → Web Worker); it is **not** part of the `window.NIMBUS` IIFE chain and must never `import`/reference `app.js`.

**Container files (repo root):** `Dockerfile` builds the single-container image (`python:3.12-slim`, non-root) — it copies the frontend into `/app/web` and serves it through the `StaticFiles` mount registered as the **last** route in `brain.py`, so the API and UI share one origin and backend source (`*.py`, `schema.sql`) is never web-served. `.dockerignore` trims the build context. Build/run via the commands in `DEPLOYMENT.md`.
