# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**NIMBUS** (Newell Integrated Batch & Unified Scheduling) — a production scheduling and order optimization tool for Newell Brands manufacturing. It renders a Gantt chart timeline, an AG Grid orders table, a dashboard with KPIs/charts, and a calendar manager for working hours and blackout blocks.

## Git Branch Conventions

**`main` is the active trunk again** (as of 2026-08-03). It had gone stale for a stretch — an actively-developed branch (`feature/user-first-last-name`) quietly became the de facto trunk while `main` stopped being updated — but `main` has since been fast-forwarded to that branch's tip and is back to being kept current. Feature branches fork from `main`'s tip and merge back into it. `feature/user-first-last-name` is retired as a trunk (left in place for now, not deleted) — don't fork new work from it or treat it as the merge-base going forward.

## Design Context

Strategic and visual design decisions are captured in **`PRODUCT.md`** (register, users, positioning, brand personality, anti-references, design principles) and **`DESIGN.md`** (color/typography/component tokens, elevation, do's and don'ts — machine-readable frontmatter plus a sidecar at `.impeccable/design.json`). Read both before any UI/UX work; they were generated via `/impeccable init` and `/impeccable document` against the existing `styles.css` token system, not invented from scratch.

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
- **Priority lists (color, PRT tooling, production version), blackout blocks, and calendar configs are per-plant** — storage and retrieval must be keyed by plant ID, not assumed to be global. (Color wheels were the only priority list before 2026-08-11; see Data Sources.)
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

No build step for most of the frontend — JavaScript and CSS are loaded directly; most libraries come from CDN. **Exception:** a small, growing set of modules is real TypeScript compiled in place by `tsc` — the seven CQ-1 `*.mts`→`*.mjs` modules (`Engine` inside `schedule-services.mts` is deliberately typed loose; everything else is fully typed) plus `web/nimbus-worker.ts`→`.js`, the type-only `web/types.mts`, and the generated declaration-only `web/types/api-generated.d.mts` (OpenAPI→TS codegen of `brain.py`'s task-date-update response models). **Full module-by-module typing status and design decisions are in `docs/typescript_migration.md`.** If you edit a `.ts`/`.mts` file, run `npm run build` (or `npm run build:watch` in a second terminal, alongside `uvicorn --reload`) before `uvicorn` will serve the updated output — this is a deliberate, scoped-to-those-files regression from the single-command flow above, not a bug.

**Legacy two-process split** (serving the UI separately on another port) still works but now needs a shim, because `app.js` `API_BASE` defaults to same-origin (relative). Set `window.NIMBUS_API_BASE = 'http://localhost:8000'` before `app.js` loads, then serve the `web/` directory: `cd web && python -m http.server 9000`. Prefer the single-process command above.

## Database Setup

Postgres must be running locally. Bootstrap the schema — now **safe to re-apply**: one-time data-mutating migrations are guarded by a `schema_migrations` ledger (the former `plants` horizon ×1440 landmine, which re-multiplied any value `<= 365` on every run, is now recorded as applied and no longer re-mutates — see the note in `schema.sql` and `docs/MIGRATION.md`):
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

> **pytest is guarded against the live Azure DB:** `tests/conftest.py` + `tests/support/db_safety.py` validate `PG_HOST`/`PG_DB` at collection time and raise `pytest.UsageError` — not a per-test skip — if the host isn't `localhost`/`127.0.0.1`/`::1`/`postgres`, or if the local DB tests aren't explicitly opted into via `NIMBUS_TEST_DB=1`. This means **the entire pytest run fails to even collect** (not just the `@pytest.mark.pg` tests) whenever `.env`'s `PG_HOST` points at a non-local host — which it may, since `.env` on this machine has pointed at the live Azure pilot DB before. This is deliberate: it's the guard against local test runs mutating the live pilot DB, not a bug to work around by pointing `.env` at Azure.

> **Color-wheel paths are env-driven:** `COLOR_WHEEL_DIR` in `brain.py` reads from an env var (`os.getenv`), defaulting to a local Windows path for dev — override it via `.env` on a new machine. The container image sets it to `/data/color_wheels`. **Per-plant uploaded lists are durable in the Postgres `priority_list` table** (generalized 2026-08-11 from the color-only `color_wheel` table, 2026-07-07), so `COLOR_WHEEL_DIR` on `/data` only holds the shared `_audit_log.json`. **`COLOR_FILE` and the global wheel it backed (`GLOBAL_CW`) are retired** — Stage 1 of `docs/scheduling_priority.md` removed the global fallback tier entirely (per-plant only now); the env var is vestigial and can be dropped from deployment config in a follow-up.

## Data Sources

**Orders live in Postgres**, not Excel. `db.py` owns all connection management and queries; `brain.py` is **stateless** — it holds no in-memory order cache. Every `GET /tasks` request queries the DB directly via `db.query_orders()`. This allows multiple uvicorn workers or replicas without shared state.

- **Order ingest** — `POST /upload` accepts a `sequence_testing`-shaped `.xlsx` and upserts rows into the `orders` table (`db.ingest_orders_from_excel`). The actual orders-upsert is now factored into `db.upsert_orders`, the **shared** upsert used by both the `/upload` path and the SAP sync path (`sap_sync.py`). Each order's **plant is materialized on the row** (`orders.plant`) at ingest — from a `WERKS`/`PLANT` upload column when present, else derived from the line→plant mapping — so the `/tasks` read path selects `o.plant` directly instead of `LEFT JOIN`ing `production_lines` on the line code alone (which fanned out / mis-attributed orders when a line code is reused across plants). `orders.plant` is added by a `schema.sql` migration: **re-run `schema.sql`** after pulling this change or `GET /tasks` errors on the missing column. A real authoritative plant source (Excel column or upload picker) and a plant-aware `make_id` are still needed before line codes are reused across plants — see `docs/MIGRATION.md`.
- **Priority lists** — Stage 1 of `docs/scheduling_priority.md` (2026-08-11) generalized the old color-only `color_wheel` table into **`priority_list`**, one row per `(plant, line-or-'', field_key)` (JSONB `{VALUE: RANK}` map + upload metadata). `master_data.RANKABLE_FIELDS` is the single source of truth for which fields are rankable — today `colorWheel`/`prt01`/`prt02`/`productionVersion`. Cached in-process as `brain.PLANT_LISTS` (`{plant: {line: {field_key: {VALUE: RANK}}}}`) at startup, on `POST /reload`, and inline after every list upload/delete/resync. **No global fallback tier** — `GLOBAL_CW`/`COLOR_FILE` are retired; a plant with nothing uploaded just has no entry. The legacy-compat `/color-wheel/{plant}` and `/color-wheels` endpoints now read/write `priority_list` rows behind their old response shapes. **Stage 2** shipped the generic upload + column-mapping UI, per-field coverage, and the missing-master-data admin panel; `GET /priority-fields` is the field registry the frontend consumes at runtime. **Stage 3** wired all four fields into the optimizer (priority tree, effective-sequence panel, `GET /priority-rank-maps`, the generic `_sortTerms` term factory — see Key Patterns → Optimization and `docs/architecture/optimizer-dispatch.md`). **Full stage-by-stage detail, the three architecture seams, and open risks are in `docs/scheduling_priority.md`** — nobody has yet validated real `prt_01`/`prt_02` values against a real uploaded list, so per-field coverage is the only guard against a misspelled list silently ranking everything 999999.
  - **Seam 2 — attribute materialization.** `db._stamp_order_attributes` is the *only* place that copies `material_plants.{color,prt_01,prt_02,default_production_version}` onto `orders.{color,prt_01,prt_02,production_version}` (matched on `(plant, material_number = material_id)`), read directly by `db._ORDERS_SELECT` with **no JOIN** on the hot `/tasks` path. Runs automatically, batch-scoped, right after every ingest upsert (`db.upsert_orders`) — **uploads never block**, regardless of how many materials have no `material_plants` row; unmatched pairs become a per-batch exception report (`GET /upload/{batch_id}/missing-master-data`, `?format=csv`) instead. The batch-scoped stamp is convenience only — **`POST /master-data/resync-order-attributes`** (admin-gated) is the real mechanism for re-stamping a plant on demand, e.g. after adding `material_plants` rows for materials that existed before the master data did. Ranks are **never** stamped onto `orders` or the task DTO — Stage 3 resolves them client-side from per-plant maps, precisely because a stamped rank would go stale the instant an order changes line (which it can, via drag-between-lines or the editable Orders-grid line column).
  - The upload/delete **audit trail** still appends to `COLOR_WHEEL_DIR/_audit_log.json` (shared with `optimization_run` events; ephemeral — a separate durability follow-up).
- **Master data** — `master_data.py` backs the `/master-data/*` and `/labor-plan*` endpoints against Postgres. `ALLOWED_TABLES` covers eight tables (`subnetworks`, `plants`, `production_lines`, `materials`, `material_plants`, `bom_items`, `roles`, `role_plants`), keyed by composite keys (plants by `(subnetwork, plant)`, not plant alone). Beyond list/bulk CRUD it owns runtime DDL (add/drop/rename-label column, mutating whichever DB is live with no git record — deliberate), the cascade-delete preview, an `admin_audit` log, per-plant JSONB constraint config, the **Labor Planning** subsystem, and `known_plant_line_codes()`. `export_schema_sql()` (`GET /master-data/_schema-export`, "Export Schema" button) dumps every registered column as idempotent `ADD COLUMN IF NOT EXISTS` SQL — the recovery path for schema drift (see `docs/DEPLOYMENT.md` → "Syncing live schema changes back into files"); this is how `production_lines.bottleneck`/`excl_optimizer`/`buffer_*` were reconstructed after going missing from both `schema.sql` and Azure. Dynamic SQL goes through `psycopg.sql.Identifier`/parameterized placeholders (`add_column`'s `NUMERIC(length)` is validated and rebuilt via `sql.Literal`, previously a DDL-injection sink); maintenance DDL in `db.py` uses an allowlist against `pg_stat_user_tables` rather than `Identifier`.
- **SAP sync (skeleton)** — `sap_sync.py` is a **transport-agnostic** SAP→NIMBUS sync engine; its connectors are **stubs today** (no live SAP calls). It is backed by three Postgres tables: `sap_sync_config` (per-object sync settings), `sap_sync_run` (run history/status), and `sap_field_map` (SAP field → NIMBUS column mapping). The synced orders are written through `db.upsert_orders` (the same upsert as `/upload`). Surfaced in the Admin **Interface** sub-tab.

## Deployment Notes

- **Hosted on Azure (single-container pilot, live since 2026-06-30).** Deployed as one container to **Azure Container Apps** — FastAPI serves the API and the static UI from the same origin, against Azure Database for PostgreSQL. Live URL: `https://ca-nimbus-dev.delightfulwater-7252cdf0.eastus2.azurecontainerapps.io/`. Resources (RG `rg-nimbus-dev`, region `eastus2`): ACR `acrnimbusdev` (image `nimbus:vN`), Container App `ca-nimbus-dev`, env `cae-nimbus-dev`, Postgres `pgdb-nimbus-dev`/`nimbus`. **Redeploy:** `az acr build -r acrnimbusdev -t nimbus:vN <repo>` then `az containerapp update -g rg-nimbus-dev -n ca-nimbus-dev --image acrnimbusdev.azurecr.io/nimbus:vN`. Full runbook + gotchas in **`docs/DEPLOYMENT.md`**; remaining hardening (Entra SSO, Key Vault, color-wheel durability) in **`docs/MIGRATION.md`**. The pilot runs **single-replica** (in-process color-wheel cache + log buffer), and CORS is effectively vestigial since the UI is same-origin.
- **`POST /reload`** refreshes the in-process priority-list cache only (`PLANT_LISTS`, from the `priority_list` table — no more global tier). It does **not** reload orders (they are never cached — every `/tasks` request hits Postgres).
- **`NIMBUS_BUILD_ID`** in `index.html` must be bumped on every deploy to bust static asset caches — it single-source-drives the `?v=` on every script/locale/stylesheet URL, `Config.BUILD_ID`, and (CQ-1) `app-entry.mjs`'s `runCacheBustGuard()` version-mismatch redirect. There is no longer a separate `APP_VERSION` constant to keep in sync in `app.js` — that guard (and its own hardcoded version string) moved to `app-entry.mjs` and now reads `NIMBUS_BUILD_ID` directly.
- **CORS / optional auth env:** `NIMBUS_ALLOWED_ORIGINS` (comma-separated; default `*`, with `allow_credentials=False`) pins allowed origins for hosting. `NIMBUS_API_KEY` (unset by default ⇒ no-op) gates the destructive/DDL/maintenance routes behind an `X-API-Key` header — a deployment-config stopgap, **not** user-level auth (actor identity is still read from spoofable `X-User`/`x-user-email`; the real fix is Entra SSO — see `docs/MIGRATION.md`).
- Structured JSON logs are emitted to stdout (`nimbus.*` logger tree, one JSON object per line). `x-request-id` is threaded through every request (only requests slower than 1500 ms are logged). A 2000-entry in-memory ring buffer (`_BACKEND_LOG`) is surfaced via `GET /logs/backend` — it is **per-process** (lost on restart, not shared across replicas). Frontend `ErrorLog` entries **do** store the `x-request-id` (as `reqId`, set by `Util.fetchTraced` and carried through the log payload), so backend correlation is by `reqId` when present (falling back to timestamp/scope otherwise).
- **Admin-route actions are automatically audit-logged**: `request_id_mw` calls `_log_admin_action(operation, outcome, ...)` for any request `_admin_route_details()` recognizes, recording `actor` (from `x-user-email`/`x-user`), `route`, `method`, `duration_ms`, and `outcome` (`success`/`rejected`/`failure`) into the same `_BACKEND_LOG` ring buffer with `event`/`outcome` fields — filterable via `GET /logs/backend?event=...&outcome=...&rid=...`.

## Architecture

### Frontend (`app.js` — ~32 sequential IIFE modules; plus `nimbus-intelligence.js`)

> The module count is approximate and undercounts: beyond the layer table below, `app.js` also defines `VirtualList` and `PerfMonitor` (Foundation infra), the `OptimizeDialog` + `OptimizerPreview` optimize-with-preview pair, `ColorWheelViewer` and `EditCalendar` modals, `EmptyState`/`WelcomeSplash` boot UI, and a full `MasterData` CRUD grid (the "Manage Data Tables" admin sub-tab, distinct from `Plant`/`ProdLines`/`LaborPlanning`).

**CQ-1 module extraction (Phases 1-4, complete):** `app.js` now boots via `app-entry.mjs` (loaded as `<script type="module">` from `index.html`), which bridges seven real ES modules — `application-foundation.mjs`, `schedule-state.mjs`, `schedule-services.mjs`, `schedule-data.mjs`, `schedule-workbench.mjs`, `plant-and-administration.mjs`, `application-shell.mjs` (module→export mapping in the Core layers table below) — onto `window.__NIMBUS_*` globals before injecting `app.js` then `nimbus-intelligence.js` as classic scripts. `app.js` (731 lines) contains **no module bodies of its own** anymore — only the bridge destructure, DI-seam wiring, boot orchestration, and a compatibility `return {...}` namespace. `nimbus-intelligence.js` remains a classic script (documented, deliberate — it needs `NIMBUS` as a bare identifier via shared lexical scope); its former runtime monkey-patches are gone in favor of `Store` event subscriptions. `index.html` carries a Report-Only CSP meta tag pending elimination of the remaining static inline `onclick=`/`onchange=` handlers. **Full module ownership map, open `Store` encapsulation exceptions, inline-handler backlog, and the honest final-criteria report against the design doc's completion bar are in `docs/architecture/cq1-compatibility-inventory.md`** (§1, §6, §7, §8 respectively) — read it before assuming CQ-1 fully eliminated a given legacy pattern.

All modules are plain vanilla JS IIFEs that execute top-to-bottom and attach to a single `window.NIMBUS` namespace. The module load order matters — each module can only reference modules declared above it.

A second frontend file, **`nimbus-intelligence.js`** (~2,300 lines, loaded after `app.js` in `index.html`), extends `window.NIMBUS` with the intelligence layer: `CommandPalette` (Cmd+K), `NeedsEngine`, `TimeMachine`, `Confidence`, `RipplePreview`, `Diff`, `Patterns`, `DarkMode`, and `LangSwitcher`, plus an `IntelDB` IndexedDB helper. (There are **no** `Voice` or `Haptic` modules.) Depth varies by module — `CommandPalette`, `NeedsEngine`, and `Confidence` are the most mature.

**Localization:** `locales/` holds i18n string maps (en, de, es, fr, pt). Loaded **before** `app.js` (first in the script chain) — `app.js` reads these maps when it defines `window.t`, so they must exist on `window` first.

**Web Worker + compute core:** `nimbus-worker.js` runs Alerts and Utilization compute off the main thread (compiled from `nimbus-worker.ts` by `tsc` — see `docs/typescript_migration.md`). The actual compute logic lives in **`nimbus-compute-core.js`** — single source of truth for the `Config`/`Util` date-math constants and helpers, the **`Calendar` capacity engine**, and the **entire alert rule set** (overlap/overload/closed/blackout/fixed-closed/fixed-out-of-hours). It's a **UMD module**: the worker loads it via `importScripts`, the browser main thread loads it via a `<script>` just before `app.js` (`window.NimbusComputeCore`), and the Node test-suite `require`s it directly. `nimbus-worker.js` itself is just the `postMessage` protocol shim. Zero DOM access, no `window.NIMBUS` dependency; the core must never import/reference `app.js`. `app.js` fails fast at boot if the core global is missing.

**What delegates today:** `Alerts._recomputeSync` → `Core.computeAlerts`; `Utilization.computeMatrix` → `Core.computeUtilization` (passing an explicit plant-scoped `lines` set; the core returns `row.tasks` as IDs and `computeMatrix` resolves them back to task objects; memoization wrapper preserved); `Calendar._dayWindow` and `Calendar.effectiveFromCapacity` → the core. So the alert rules and the utilization matrix are now a **single implementation** shared by the worker and the main thread. The core was reconciled UP to app.js first (it now plant-scopes *line* blocks and carries the O(1) line→plant memo — behaviors the drifted worker had lost).

> **Remaining reconciled-but-not-delegated (follow-up):** `Calendar.workWindow` / `dailyCapacityHours` / `effectiveCapacityHours` stay in `app.js` because they are coupled to the Engine's per-run cache (`_runCache`) and `Store`'s O(1) plant index, and are called directly by the Engine/Interaction/Hierarchy on the main thread. They call the SAME math as the core's copies and are parity-pinned by `tests/js/compute-core.test.js`, but until they too delegate, a change to that capacity math must be mirrored in `nimbus-compute-core.js`. The separate unmemoized `Utilization.dayByLine`/`todayByLine` path also still uses `Calendar` directly.

The `Compute` module (in `schedule-services.mjs`; a singleton `new Worker('nimbus-worker.js?v=' + Config.BUILD_ID)` wrapper) posts plant-scoped Store snapshots over `postMessage` and falls back to synchronous main-thread compute if the worker fails to load or errors — **and this fallback is permanent for the session** (a single worker `onerror` sets `_dead=true` with no auto-restart, routing all later compute to the main thread until reload). The snapshot is deliberately scoped to the selected plant's lines — the structured-clone on each `postMessage` is the dominant main-thread cost, so `calendars`/`lineSettings` are pruned to on-screen lines.

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

> `AdminCockpit` is far more than upload/data management: it embeds a Postgres ops console (pool/server stats, table bloat + VACUUM/ANALYZE triggers, connection/lock activity, slow-query bars via `pg_stat_statements`, sequence exhaustion), a `PerfMonitor` thread profiler, and a diagnostics-bundle exporter. `App` manages top tabs (home/gantt/masterdata/admin/labor) plus three independent sub-tab dimensions. The admin area's **Interface** sub-tab manages the SAP sync config, field mapping, and run history (see Backend → `sap_sync.py`); the SAP connectors are **stub skeletons** today.

**State flow:** User action → `Interaction` → mutate `Store` → `Store.publish()` → subscribed UI modules re-render.

**Undo:** `UndoStack` (10 levels) wraps any destructive Store mutation. Always snapshot before calling Engine optimization or bulk drag operations.

**Known plants:** `Config.KNOWN_PLANTS` (`['5512', '1006']`) is only a **fallback** seed — `Store.knownPlants()` prefers master-data plants and ignores it entirely when present. The authoritative onboarding path is the Master Data `plants` table, not editing `KNOWN_PLANTS`.

### Backend (`brain.py` — FastAPI; data layer in `db.py`, `master_data.py`)

`brain.py` exposes ~77 endpoints (tasks, task notes, concurrency refresh, diagnostics + DB deep-dive/maintenance, upload/purge/audit, priority lists, master data + column DDL + constraints, labor planning, backend log buffer, health). A separate `sap_sync.py` module owns the SAP→NIMBUS sync engine and an **in-process APScheduler started in the lifespan hook — disabled by default**, gated by `NIMBUS_SAP_SYNC_ENABLED`; safe single-replica today, multi-replica needs an advisory-lock guard (see `docs/MIGRATION.md`). `GET /tasks` and the whole task-date-update path carry `response_model=`-backed Pydantic response contracts, so FastAPI validates its own responses at runtime; the frontend consumes OpenAPI-codegen'd TS types for these same endpoints in `web/schedule-data.mts` (see `docs/typescript_migration.md` Phase 4). No other endpoint family has `response_model=` yet. The most load-bearing endpoints:
- `GET /tasks` — task list with finish-to-start links and metadata; supports `?plant=`/`?line=` server-side scoping plus optional `?limit=`/`?offset=` pagination (`meta.total` carries the full filtered row count when paging). Calls `db.query_orders()` on every request — no cache.
- `GET /diagnostics` / `GET /diagnostics/deep` — load statistics and DB stats. `GET /diagnostics/db` exposes a deep DB-observability layer (pool stats, server info, table health, connection activity, blocking-lock chains, index usage, slow queries via `pg_stat_statements`, sequence health); `POST /maintenance/vacuum-analyze` and `/maintenance/analyze` trigger maintenance behind a table allowlist. Driven by the AdminCockpit console.
- `POST /task/note`, `POST /tasks/refresh` (concurrency reconciliation), `GET/POST /logs/backend`(+`/clear`), `GET /upload/audit`, `GET/POST /audit/log`(+`/clear`), `GET /health`, `/labor-plan` + `/labor-plan/line`, `POST /master-data/plants/{plant}/constraints`, `/master-data/{table}/cascade-preview`, `/master-data/{table}/columns` (ADD/DROP/rename label DDL), `/master-data/_audit`
- `POST /reload` — refreshes the priority-list cache (`PLANT_LISTS`); does **not** affect orders
- `POST /master-data/resync-order-attributes`, `GET /upload/{batch_id}/missing-master-data` (+`?format=csv`) — the priority-list attribute-materialization seam's admin/exception-reporting surface (see Data Sources)
- `GET /priority-fields` — the rankable-field registry (Stage 2); `GET /priority-lists?plant=` — per-field coverage/meta for a plant; `POST/GET/DELETE /priority-list/{plant}/{field_key}` — generic per-field, per-line-scoped upload/read/delete; `GET /master-data/{plant}/missing-master-data` (+`?format=csv`) — the live (not batch-scoped) counterpart to the upload-time exception report, same JSON/CSV shape
- `POST /task/update` — update one task's start/end
- `POST /tasks/update` — bulk update (the frontend autosave path; payload `{ tasks, blocks?, calendars? }`)
- `POST /tasks/bulk_update` — flat-list alias for external tooling
- `POST /upload` — ingest a `sequence_testing`-shaped `.xlsx` into the `orders` table

All three `/update` endpoints call `db.update_task_dates_bulk()`, which validates payloads, **persists each edit to Postgres** (`scheduled_start` / `scheduled_end`), and rejects inverted ranges (end ≤ start). A DB-write failure leaves Postgres unchanged (single transaction). `POST /reload` does not touch orders.

**Optimistic concurrency:** each update carries `base_version` (the row's Postgres `xmin`, surfaced as `ROW_VERSION`) and a `force` flag. Under `SELECT … FOR UPDATE`, a mismatch is **not** a 4xx — the id comes back in a `stale` list (HTTP 200) with new `versions`, and the frontend reconciles via `POST /tasks/refresh` with **last-writer-loses** semantics. `force` (optimizer-dirtied ids, or `Config.CONCURRENCY_CHECK` false) bypasses the check.

> **General hazard:** `orders.xmin` **is** `base_version`. **Any** `UPDATE orders` — even on a column no UI reads yet — bumps xmin for every row touched, so those ids come back `stale` on next save and the frontend discards the planner's unsaved edit. This is why the priority-list attribute stamp is batch-scoped at ingest and otherwise explicit-only (`POST /master-data/resync-order-attributes`). Before adding any new `UPDATE orders` statement, ask what it does to in-flight planner edits.

Task IDs are MD5 hashes of `f"{PRODUCTION_ORDER}|{MATERIAL_NUMBER}"` computed by `make_id()` in `db.py`. Because the hash excludes time, IDs are stable across reloads and reschedules — the frontend relies on this for keying drag/edit operations.

### Key Patterns

- **Optimization** runs through `Engine.runAndApply(mode)` where `mode ∈ {'spt', 'changeover', 'combined'}`. These are **dispatching heuristics, not true optimization** — no changeover-cost matrix, no finite-capacity constraint, finish-to-start precedence not consulted. `'spt'` is a legacy single-sort greedy walk. `'changeover'`/`'combined'` ("Smart") route through `Engine._dispatchDayIntegrity`, a day-integrity dispatch that gives each calendar day's "native" (due-that-day) orders first refusal before pulling in carry/pull-in/floater orders, ranked and placed via the generic `Engine._sortTerms(mode, { plant })` term factory — which resolves each configured priority field's rank per-task from `Store.priorityRankMaps` (loaded via `GET /priority-rank-maps`, **never** stamped onto the order row, so cross-line drags pick up the destination line's ranks with no refetch). **Full mechanics — tiering, phase 1/2 placement, force-place termination guard, rank-cache freshness hazard, constraint registry — are in `docs/architecture/optimizer-dispatch.md`; read it before touching dispatch/sort-term code.** Deliberately out of scope for now (see `docs/MIGRATION.md`): sequence-dependent setup-time minutes, a release-date floor on pull-forward, and auto-pinning — manual pinning (`Store.isFixed`) is the only protection an order has from being moved.
- **Auto-reflow** after manual edits: `Engine.autoReflow()` re-flows subsequent unfixed orders on the affected line to eliminate overlap created by a drag. It only shifts dates within one line, so it triggers an incremental, line-scoped alert recompute. Anything in the Interaction → Engine path needs to be aware of this.
- **Alerts** (overlap, overload, blackout, fixed-closed, fixed-out-of-hours) are computed by `Alerts.recompute(opts)`. A bare call scans all lines; `recompute({ lines })` does an **incremental pass** scoped to specific lines and merges into the existing alert list. The debounced dispatcher is **adaptive** — delay scales with the last recompute's measured cost. Compute is offloaded to `nimbus-worker.js` via `Compute` (sync fallback if the worker is down). `Confidence.init` (in `nimbus-intelligence.js`) monkey-patches `Alerts.recompute` but forwards all arguments, so the `{ lines }` scope is preserved. Blackouts are also visually enforced by `Calendar` — dragging onto a blackout block snaps to the next valid slot.
- **Utilization** is computed per-line per-day in `Utilization.computeMatrix()` (surfaced in `Hierarchy`, `UtilStrip`, `Dashboard`). A second path — `Utilization.dayByLine`/`todayByLine` — is **unmemoized and not worker-offloaded**. The Store-backed path (`srcTasks === null`) is memoized on `(startMs, days, Store._rev)`. Two caveats: `Dashboard` always passes a non-null filtered task subset, bypassing the memo entirely; and the off-thread prewarm writes a plant-scoped matrix under a cache key the synchronous path expects to be global, so whichever producer runs first wins.
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

**Frontend source lives under `web/`** (`index.html`, `styles.css`, `app.js`, `nimbus-intelligence.js`, `nimbus-worker.ts`/`.js`, `nimbus-compute-core.js`, the seven `*.mjs` CQ-1 modules + `app-entry.mjs`, `locales/`, `Images/`, plus TS ambient declarations). The TypeScript build is configured by the repo-root `tsconfig.json`/`tsconfig.worker.json`, run via `npm run build`/`npm run typecheck` — see `docs/typescript_migration.md`. `brain.py`'s `STATIC_DIR` defaults to `<repo>/web` (resolved from `Path(__file__)`, not the process cwd), so `uvicorn brain:api` always serves that dedicated tree and never `brain.py`/`db.py`/`schema.sql` alongside it. `scripts/check-static-assets.mjs` (`npm run check:static-assets`) enforces this: every local import reachable from a `.mjs` under `web/` must resolve inside `web/`, and no backend filename may appear there.

`styles.css` (~5,500 lines) uses a CSS-variable design-token system (warm off-white light base, deep-slate dark mode, amber accent) with a `body.dark` layer that is **incomplete** — several newer components hardcode light colors and a few tokens are referenced but never defined (`--border`, `--border-subtle`, `--font-mono`, `--bg-float`). `index.html` also carries ~1,000 lines of inline `<style>` not yet migrated into `styles.css`. `nimbus-worker.js` is the standalone Web Worker (see Frontend → Web Worker) — a compiled output of `nimbus-worker.ts`, never part of the `window.NIMBUS` IIFE chain, and must never `import`/reference `app.js`; same rule for `nimbus-compute-core.js`.

**Container files (repo root):** `Dockerfile` builds the single-container image (`python:3.12-slim`, non-root) — it copies the frontend into `/app/web` and serves it through the `StaticFiles` mount registered as the **last** route in `brain.py`, so the API and UI share one origin and backend source (`*.py`, `schema.sql`) is never web-served. `.dockerignore` trims the build context. Build/run via the commands in `docs/DEPLOYMENT.md`.

**Repo-root docs are pared down to only what tools require there:** `CLAUDE.md`/`AGENTS.md` (Claude Code/Codex look for these at the project root) and `DESIGN.md`/`PRODUCT.md` (Impeccable generates and reads these at the project root by hardcoded convention — moving them breaks `/impeccable` commands). Everything else — `docs/DEPLOYMENT.md`, `docs/MIGRATION.md`, `docs/NIMBUS_INTERFACE_ARCHITECTURE.md`, `docs/SAP_INTEGRATION_ROADMAP.md` — lives under `docs/`. Local-only sample data (`Color_Wheel.XLSX`, `Sequence_Testing.XLSX`, both gitignored and unreferenced by any code path) lives in `sample-data/`.
