# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**NIMBUS** (Newell Integrated Batch & Unified Scheduling) — a production scheduling and order optimization tool for Newell Brands manufacturing. It renders a Gantt timeline, an AG Grid orders table, a KPI dashboard, a calendar manager for working hours and blackout blocks, a master-data admin area, and a sequence-dependent **setup (changeover) matrix** feeding the optimizer.

## Git Branch Conventions

**`main` is the active trunk**; feature branches fork from its tip and merge back into it. `feature/user-first-last-name` — which had quietly become the de facto trunk while `main` went stale — is retired as a trunk (left in place, not deleted). Don't fork new work from it or treat it as the merge base.

## Design Context

Strategic and visual design decisions live in **`PRODUCT.md`** (register, users, positioning, brand personality, anti-references, design principles) and **`DESIGN.md`** (color/typography/component tokens, elevation, do's and don'ts — machine-readable frontmatter plus a sidecar at `.impeccable/design.json`). Read both before any UI/UX work; they were generated via `/impeccable` against the existing `styles.css` token system, not invented.

## Production Scale Roadmap

NIMBUS is designed to grow to enterprise scale. **All UI and data design decisions must anticipate this:**

| Dimension | Current (prototype) | Target scale |
|-----------|--------------------|--------------:|
| Plants | 1–3 | **50+** |
| Machines per plant | ~5 | **70+** |
| Total machines across system | ~15 | **3,500+** |

**Design implications:**
- **Never use bubble/chip selectors for plants or machines** — these break past ~10 entries. Use searchable, filterable dropdowns (comboboxes); scrolling is not enough at 50+ plants and 70+ machines.
- **Hierarchy navigation** (plant → machine) must be scoped, and **API endpoints returning plant or machine lists** must support server-side pagination or filtering.
- **Priority lists (color, PRT tooling, production version), setup definitions/matrices, blackout blocks, and calendar configs are per-plant** — storage and retrieval keyed by plant ID, never assumed global.
- **Utilization and dashboard charts** must be filterable and aggregatable by plant, not rendered for all plants at once.
- **The setup matrix is O(states²) per plant** — never render or fetch a full plant matrix snapshot for a UI that needs only one from-state's rows (`GET /setup/{plant}/matrix-rows` exists precisely to avoid that; see `docs/Setup_matrix_redesign.md`).

This is the primary long-term scalability constraint for every feature in NIMBUS.

## Running the App

The backend serves **both** the JSON API and the static frontend (a `StaticFiles` mount at `/`), so local dev is a single process.

```bash
pip install -r requirements.txt
uvicorn brain:api --port 8000      # add --reload for auto-reload during dev
# Then open http://localhost:8000/
```

> `brain.py` has **no `if __name__ == "__main__"` block** — `python brain.py` does nothing. The entrypoint is always `uvicorn brain:api` (this is also the container `CMD`).

Most of the frontend has no build step — JS/CSS load directly, libraries come from CDN. **Exception:** a growing set of modules is real TypeScript compiled in place by `tsc` (module-by-module typing status in `docs/typescript_migration.md`). **If you edit a `.ts`/`.mts` file, run `npm run build` before `uvicorn` will serve the updated output.**

## Build, Lint, Test

```bash
npm run build          # tsc: worker then main project (required after any .ts/.mts edit)
npm run build:watch    # worker project only, watch mode (pair with uvicorn --reload)
npm run typecheck      # both tsc projects, --noEmit
npm run lint           # ESLint over app.js, intelligence, compute-core, locales, *.mjs/*.mts, scripts, tests
npm run test           # pretest runs build; then test:legacy (tests/js) + test:modules (tests/modules)
node --test tests/modules/setup-scheduler.test.mjs   # single JS test file
npm run check:static-assets   # local imports from a web/ .mjs must resolve inside web/
npm run check:legacy-surface  # pins the app.js legacy compatibility surface
npm run generate:api-types    # OpenAPI dump -> web/types/api-generated.d.mts

python -m pytest tests/ -q                         # Python suite
python -m pytest tests/test_setup_data.py::test_x  # single Python test (drop ::test_x for the file)
```

> App dependencies live in the repo `.venv`, not a bare `py` install.

## Database Setup

Postgres must be running locally. `schema.sql` is **safe to re-apply** — one-time data-mutating migrations are guarded by a `schema_migrations` ledger (the former `plants` horizon ×1440 landmine, which re-multiplied any value `<= 365` on every run, is recorded as applied and no longer re-mutates; see `schema.sql` and `docs/MIGRATION.md`).

```bash
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE nimbus;"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d nimbus -f schema.sql
```

`migrations/` holds dated, additive, idempotent `.sql` files mirroring what `schema.sql` also carries. **Deploys apply `migrations/`, never `schema.sql`** (see the `promote-azure` skill). After pulling a change that adds a column, re-run `schema.sql` locally or the matching migration, or endpoints error on the missing column.

Credentials come from `.env` (loaded by `python-dotenv`): `PG_HOST`, `PG_PORT`, `PG_DB`, `PG_USER`, `PG_PASS`, plus optional `NIMBUS_PG_POOL_{MIN,MAX,TIMEOUT}` and `NIMBUS_PG_STATEMENT_TIMEOUT_MS`.

> **pytest is guarded against the live Azure DB:** `tests/conftest.py` + `tests/support/db_safety.py` validate `PG_HOST`/`PG_DB` at collection time and raise `pytest.UsageError` — not a per-test skip — unless the host is local and `NIMBUS_TEST_DB=1` is set. So **the entire pytest run fails to collect** whenever `.env`'s `PG_HOST` points at a non-local host — which it may, since `.env` on this machine has pointed at the live Azure pilot DB. Deliberate; not a bug to work around by pointing `.env` at Azure.

> **Color-wheel paths are env-driven:** `COLOR_WHEEL_DIR` in `brain.py` reads an env var (local Windows path for dev; `/data/color_wheels` in the container). Per-plant uploaded lists are durable in the Postgres `priority_list` table, so that directory only holds the shared `_audit_log.json`. **`COLOR_FILE`/`GLOBAL_CW` are retired** — the global fallback tier is gone (per-plant only); the env var is vestigial.

## Data Sources

**Orders live in Postgres**, not Excel. `db.py` owns all connection management and queries; `brain.py` is **stateless** — no in-memory order cache, so multiple uvicorn workers or replicas need no shared state.

- **Order ingest** — `POST /upload` accepts a `sequence_testing`-shaped `.xlsx` and upserts into `orders` (`db.ingest_orders_from_excel`). The upsert itself is factored into `db.upsert_orders`, **shared** by `/upload` and the SAP sync path. Each order's **plant is materialized on the row** (`orders.plant`) at ingest — from a `WERKS`/`PLANT` upload column when present, else derived from the machine→plant mapping — so `/tasks` selects `o.plant` directly instead of `LEFT JOIN`ing `machine` on the machine code alone, which mis-attributed orders when a machine code is reused across plants. A truly authoritative plant source and a plant-aware `make_id` are still needed before that reuse is safe — see `docs/MIGRATION.md`.
- **Priority lists** — the `priority_list` table holds one row per `(plant, machine-or-'', field_key)` (JSONB `{VALUE: RANK}` map + upload metadata), generalized 2026-08-11 from the color-only `color_wheel` table. `master_data.RANKABLE_FIELDS` is the single source of truth for which fields are rankable — today `colorWheel`/`prt01`/`prt02`/`productionVersion`. Cached in-process as `brain.PLANT_LISTS` (`{plant: {machine: {field_key: {VALUE: RANK}}}}`) at startup, on `POST /reload`, and inline after every upload/delete/resync. **No global fallback tier** — a plant with nothing uploaded just has no entry. Legacy-compat `/color-wheel/{plant}` and `/color-wheels` read/write `priority_list` rows behind their old response shapes. All three stages of `docs/scheduling_priority.md` shipped (generic upload + column-mapping UI, per-field coverage, missing-master-data admin panel, the `/priority-fields` registry, optimizer wiring). **Read that doc for the three architecture seams and open risks** — nobody has validated real `prt_01`/`prt_02` values against a real uploaded list, so per-field coverage is the only guard against a misspelled list silently ranking everything 999999.
  - **Seam 2 — attribute materialization.** `db._stamp_order_attributes` is the *only* place that copies `material_plants.{color,prt_01,prt_02,default_production_version}` onto `orders.{color,prt_01,prt_02,production_version}` (matched on `(plant, material_number = material_id)`), read directly by `db._ORDERS_SELECT` with **no JOIN** on the hot `/tasks` path. It runs automatically, batch-scoped, right after every ingest upsert — **uploads never block** on missing `material_plants` rows; unmatched pairs become a per-batch exception report (`GET /upload/{batch_id}/missing-master-data`, `?format=csv`). That stamp is convenience only — **`POST /master-data/resync-order-attributes`** is the real mechanism for re-stamping a plant on demand. Ranks are **never** stamped onto `orders` or the task DTO — they resolve client-side from per-plant maps, precisely because a stamped rank goes stale the instant an order changes machine (via drag-between-machines or the editable Orders-grid machine column). The upload/delete **audit trail** appends to `COLOR_WHEEL_DIR/_audit_log.json` (shared with `optimization_run` events; ephemeral — a durability follow-up).
- **Master data** — `master_data.py` backs `/master-data/*` and `/labor-plan*`. `ALLOWED_TABLES` covers nine tables (`subnetworks`, `plants`, `machine`, `materials`, `material_plants`, `bom_items`, `roles`, `role_plants`, `workcenter_mapping`), keyed by composite keys (plants by `(subnetwork, plant)`, not plant alone). `PLANT_SCOPED_TABLES` is a **static** allowlist of tables whose `plant` column is subject to per-user `role_plants` scoping — static so the Add-Column DDL wizard can't widen a security boundary by adding a column named `plant`. Beyond list/bulk CRUD it owns runtime DDL (add/drop/rename-label column, mutating whichever DB is live with no git record — deliberate), the cascade-delete preview, an `admin_audit` log, per-plant JSONB constraint config, per-plant `split_order_policy` / `max_pull_forward_days`, role page-access, the **Labor Planning** subsystem, and `known_plant_line_codes()`. `export_schema_sql()` (`GET /master-data/_schema-export`, "Export Schema" button) dumps every registered column as idempotent `ADD COLUMN IF NOT EXISTS` SQL — the recovery path for schema drift (`docs/DEPLOYMENT.md`), and how several `machine` columns were reconstructed after going missing from both `schema.sql` and Azure. Dynamic SQL uses `psycopg.sql.Identifier`/parameterized placeholders (`add_column`'s `NUMERIC(length)` was a DDL-injection sink, now validated and rebuilt via `sql.Literal`); maintenance DDL in `db.py` allowlists against `pg_stat_user_tables`.
- **Setup (changeover) data** — `setup_data.py` owns **plant-scoped, versioned, observation-only** persistence across four tables: `setup_definition` (which ordered subset of `RANKABLE_FIELDS` forms a plant's setup signature, plus the `active` flag), `setup_matrix` (from-state × to-state minutes, optionally machine-overridden), `machine_setup_state` (each machine's physical current state, `derived` < `manual` < `actual` trust ordering), and `setup_occurrence_override` (one-off adjustments) — plus `machine.setup_compatible`/`setup_compatibility_reason` (a machine may opt out of a signature it can't honor) and `plants.setup_policy_config`/`setup_release_evidence`. **This module never changes an order's schedule** — the scheduler reads it. Writes are gated by the `setup_scheduler` role permission.
- **SAP sync (skeleton)** — `sap_sync.py` is a **transport-agnostic** SAP→NIMBUS sync engine whose connectors are **stubs today** (no live SAP calls), backed by `sap_sync_config`, `sap_sync_run`, and `sap_field_map`. Synced orders go through `db.upsert_orders` (the same upsert as `/upload`). Surfaced in the Admin **Interface** sub-tab.

## Auth & RBAC

`auth.py` (landed 2026-07-08) implements **mandatory login plus role-based authorization** behind `/security/*` (login, admin user CRUD, self-service profile/password/settings, first-run bootstrap status). Roles carry a JSONB `settings` blob (permissions + per-role page access) and a `role_plants` table scoping which plants a user sees. Route guards: `auth.require_authenticated`; `auth.require_setup_scheduler` (needs `roles.settings.permissions.setup_scheduler === true` **and** at least one `role_plants` row — admin is the sole intentionally plant-unrestricted role); `auth.require_admin` (with a deliberate first-run grace: open to anyone until the first admin exists, so onboarding can't lock itself out). A bootstrap admin is seeded from `NIMBUS_BOOTSTRAP_ADMIN_USERNAME`.

> **Critical nuance:** authorization is real and server-enforced, but the **request-time identity still comes from a trusted header** — `auth._actor_email` reads `x-user-email`/`X-User`, which a client can spoof, and is the single line that changes when real SSO lands. `NIMBUS_API_KEY` (unset by default ⇒ no-op) gates destructive/DDL/maintenance routes behind an `X-API-Key` header — a deployment-config stopgap, not user identity. **`Entra_Auth_Migration.md` (repo root) is the plan of record** for closing this (Easy Auth, not MSAL.js; login page kept; email re-key), superseding `docs/MIGRATION.md` WS3 — which is *not* marked as superseded.

## Deployment Notes

- **Hosted on Azure (single-container pilot, live since 2026-06-30)** — one container on **Azure Container Apps**; FastAPI serves API and static UI from the same origin against Azure Database for PostgreSQL. Live URL: `https://ca-nimbus-dev.delightfulwater-7252cdf0.eastus2.azurecontainerapps.io/`. Resources (RG `rg-nimbus-dev`, `eastus2`): ACR `acrnimbusdev` (image `nimbus:vN`), Container App `ca-nimbus-dev`, Postgres `pgdb-nimbus-dev`/`nimbus`. **Deploy via the `promote-azure` skill** — it builds/rolls the image and applies pending `migrations/` through the ledger, never `schema.sql`. Runbook + gotchas in **`docs/DEPLOYMENT.md`**; remaining hardening in **`docs/MIGRATION.md`**. The pilot is **single-replica** (in-process priority-list cache + log ring buffer), and CORS is vestigial since the UI is same-origin (`NIMBUS_ALLOWED_ORIGINS`, default `*`, `allow_credentials=False`).
- **When verifying a deploy, cache-bust the request** (random query param + `no-cache` header) — the corporate proxy caches keyed on URL and will serve a pre-roll response, faking a failed deploy.
- **`NIMBUS_BUILD_ID`** in `index.html` must be bumped on every deploy to bust static asset caches — it single-source-drives the `?v=` on every script/locale/stylesheet URL, `Config.BUILD_ID`, and `app-entry.mjs`'s `runCacheBustGuard()` version-mismatch redirect. There is no separate `APP_VERSION` constant.
- Structured JSON logs go to stdout (`nimbus.*` logger tree, one object per line); `x-request-id` is threaded through every request (only requests slower than 1500 ms are logged). A 2000-entry ring buffer (`_BACKEND_LOG`) is surfaced via `GET /logs/backend` — **per-process**, lost on restart. Frontend `ErrorLog` entries carry the same id as `reqId` (set by `Util.fetchTraced`), so correlation is by `reqId` when present. **Admin-route actions are auto-audited** into that buffer by `request_id_mw` → `_log_admin_action` (`actor`/`route`/`method`/`duration_ms`/`outcome`), filterable via `?event=&outcome=&rid=`.

## Architecture

### Frontend

**CQ-1 module extraction (complete):** boot goes through `app-entry.mjs` (loaded as `<script type="module">` from `index.html`), which imports the real ES modules — `application-foundation`, `schedule-state`, `schedule-services`, `schedule-data`, `schedule-workbench`, `plant-and-administration`, `application-shell`, `master-data-grids`, plus side-effect `setup-domain` — bridges their exports onto `window.__NIMBUS_*` globals, then injects `app.js` and `nimbus-intelligence.js` as classic scripts. `app.js` (~730 lines) holds **no module bodies** anymore — only the bridge destructure, DI-seam wiring, boot orchestration, and a compatibility `return {...}` namespace. `nimbus-intelligence.js` stays a classic script (deliberate — it needs `NIMBUS` as a bare identifier via shared lexical scope) and now uses `Store` event subscriptions instead of runtime monkey-patches. `index.html` carries a Report-Only CSP meta tag pending removal of the remaining static inline `onclick=`/`onchange=` handlers. **Read `docs/architecture/cq1-compatibility-inventory.md`** (§1 module ownership map, §6 open `Store` encapsulation exceptions, §7 inline-handler backlog, §8 honest final-criteria report) before assuming CQ-1 eliminated a given legacy pattern. All non-module code is plain vanilla JS IIFEs attaching to `window.NIMBUS` and executing top-to-bottom — **load order matters**.

**`nimbus-intelligence.js`** (~2,300 lines, loaded after `app.js`) extends `window.NIMBUS` with the intelligence layer: `CommandPalette` (Cmd+K), `NeedsEngine`, `TimeMachine`, `Confidence`, `RipplePreview`, `Diff`, `Patterns`, `DarkMode`, `LangSwitcher`, plus an `IntelDB` IndexedDB helper. (There are **no** `Voice` or `Haptic` modules.) The first three named are the most mature.

**Localization:** `locales/` holds i18n string maps (en, de, es, fr, pt), loaded **before** `app.js` (first in the script chain) because `app.js` reads them when defining `window.t`. **Route all new/changed UI text through `data-i18n`/`t()`** — even tiny badges — rather than matching a hardcoded neighbor; `tests/modules/locale-completeness.test.mjs` pins coverage.

**Web Worker + compute core:** `nimbus-worker.js` (compiled from `nimbus-worker.ts`) runs Alerts and Utilization compute off the main thread, but the logic lives in **`nimbus-compute-core.js`** — single source of truth for the `Config`/`Util` date-math constants and helpers, the **`Calendar` capacity engine**, and the **entire alert rule set** (overlap/overload/closed/blackout/fixed-closed/fixed-out-of-hours). It's a **UMD module**: the worker `importScripts` it, the main thread loads it via `<script>` just before `app.js` (`window.NimbusComputeCore`), and the Node test suite `require`s it. `nimbus-worker.js` is just the `postMessage` shim. Zero DOM access, no `window.NIMBUS` dependency; the core must never reference `app.js`, and `app.js` fails fast at boot if the core global is missing. **Delegating today:** `Alerts._recomputeSync` → `Core.computeAlerts`; `Utilization.computeMatrix` → `Core.computeUtilization` (with an explicit plant-scoped `lines` set; the core returns `row.tasks` as IDs and `computeMatrix` resolves them back to task objects, memoization preserved); `Calendar._dayWindow`/`effectiveFromCapacity` → the core. The `Compute` wrapper (in `schedule-services.mjs`, a singleton `new Worker(...)`) posts plant-scoped Store snapshots and falls back to synchronous main-thread compute if the worker fails — **that fallback is permanent for the session** (one `onerror` sets `_dead=true`, no auto-restart). Scoping is deliberate: the structured clone per `postMessage` is the dominant main-thread cost, so `calendars`/`lineSettings` are pruned to on-screen lines.

> **Reconciled but not delegated:** `Calendar.workWindow` / `dailyCapacityHours` / `effectiveCapacityHours` stay in `app.js` because they're coupled to the Engine's per-run cache (`_runCache`) and `Store`'s O(1) plant index, and are called directly by Engine/Interaction/Hierarchy. They run the SAME math as the core's copies and are parity-pinned by `tests/js/compute-core.test.js`, but until they delegate too, **a change to that capacity math must be mirrored in `nimbus-compute-core.js`**. The unmemoized `Utilization.dayByLine`/`todayByLine` path also still uses `Calendar` directly.

**Core layers (bottom-up dependency order):**

| Layer | Modules | Role |
|-------|---------|------|
| Foundation | `Config`, `Util` | Constants, helpers |
| | `VirtualList`, `PerfMonitor` | Windowed list (binary-search variable-height); ring-buffer p50/p95 profiler read by AdminCockpit's Thread tab |
| State | `Store` | Reactive pub/sub; single source of truth. All state lives here. |
| Domain | `Calendar`, `Alerts`, `Utilization`, `Engine` | Business logic reading/writing Store |
| Setup | `setup-domain.mts`, `setup-scheduler.mts` | Pure setup resolution; detached candidate scheduler (Key Patterns) |
| Infrastructure | `ErrorLog`, `Toast`, `Modal`, `UndoStack` | Cross-cutting concerns |
| Admin / Master Data UI | `Plant`, `ProdLines`, `LaborPlanning`, `MasterData`, `MaterialGrids`, `SetupAdmin`, `SystemConfig`, `Security`, `Interface`, `CalendarUI`, `PriorityListMapping` | Plant/line management, labor plan editor, CRUD grids, Setup Matrix admin, System Configuration, users/roles, SAP interface |
| UI components | `Timeline`, `Table`, `Inspector`, `Hierarchy`, `Dashboard`, `UtilStrip`, `TimelineNav`, `GanttFilter`, `DependencyOverlay`, `ContextMenu`, `Selection` | Render and respond to Store changes |
| What-if | `Sandbox` | Edits the **live** Store directly, keeping a deep-cloned pre-edit snapshot (tasks/blocks/calendars/fixedIds) reverted on discard — **not** an isolated Store copy. Autosave is suppressed while `Sandbox.active`, but live in-memory state IS mutated. |
| | `OptimizeDialog`, `OptimizerPreview` | Optimize modal; `runWithPreview` wraps `Engine.runAndApply` with a before/after KPI preview, verdict scoring, plan comparison + prune tallies, finalist rationale, and a stale-preview banner, snapshots the plant for undo, then applies or discards. User-driven optimize routes here; the alert auto-fix path calls `Engine.runAndApply` directly. |
| | `ColorWheelViewer`, `EditCalendar` | Priority-list preview modal; per-line/plant working-hours modal (14 Flatpickr pickers) |
| Input | `Interaction` | Unified click/keyboard/drag pipeline; calls Engine and mutates Store |
| Data | `Persistence` | Backend fetch, localStorage cache (key `nimbus.state.v3`, shape gated by `Config.SCHEMA_VERSION` — **not** the key suffix; cache discarded on mismatch), auto-save |
| Boot | `PlantSelector`, `AdminCockpit`, `Printer`, `App` | Plant picker, upload/data management, print/export, tab switching (top tabs home/gantt/masterdata/admin/labor plus independent sub-tab dimensions) |

> Three modules are broader than their table row suggests. `Util` is **not** purely pure helpers — it owns `fetchTraced` (the standard fetch wrapper; attaches `x-request-id`, logs slow/failed requests), the i18n resolver `Util.t` / global `window.t`, the `fpDatetime` Flatpickr factory, and the SAP-variance/optimizer-KPI helpers (`sapDueDate`/`scheduledEnd`/`latenessHours`/`countChangeovers`/`scheduleKpis` — the last calls `Utilization.computeMatrix`, so it is not stateless). `Interaction` also owns a Ctrl/Cmd+drag marquee multi-select, a hover-preview card, double-click-label line isolation, multi-order ghost-drag, and two-way AG Grid ↔ `Selection` sync. `AdminCockpit` embeds a Postgres ops console, a `PerfMonitor` thread profiler, and a diagnostics-bundle exporter.

**State flow:** User action → `Interaction` → mutate `Store` → `Store.publish()` → subscribed UI modules re-render. `Store.selectedLines` is the **global line filter**, syncing line selection across Gantt, Orders, Dashboard, Labor Plan, and Master Data via an aliased `Set` mutated in place — don't replace the reference.

**Undo:** `UndoStack` (10 levels) wraps any destructive Store mutation. Always snapshot before Engine optimization or bulk drag operations.

**Known plants:** `Config.KNOWN_PLANTS` (`['5512', '1006']`) is only a **fallback** seed — `Store.knownPlants()` prefers master-data plants and ignores it entirely when present. Onboard a plant via the Master Data `plants` table, not by editing `KNOWN_PLANTS`.

### Backend (`brain.py` — FastAPI; data layer in `db.py`, `master_data.py`, `setup_data.py`, `auth.py`)

`brain.py` exposes ~96 endpoints (tasks, notes, concurrency refresh, diagnostics + DB maintenance, upload/purge/audit, priority lists, master data + column DDL + constraints, setup matrix, security/users, system settings, labor planning, plant calendars, SAP interface, log buffers, health). `sap_sync.py` owns an in-process APScheduler started in the lifespan hook — **disabled by default** via `NIMBUS_SAP_SYNC_ENABLED`; safe single-replica, multi-replica needs an advisory-lock guard (`docs/MIGRATION.md`). `GET /tasks` and the whole task-date-update path carry `response_model=`-backed Pydantic contracts, so FastAPI validates its own responses at runtime; the frontend consumes OpenAPI-codegen'd TS types for these in `web/schedule-data.mts`. No other endpoint family has `response_model=` yet.

Most load-bearing endpoints (`grep -nE '^@api\.' brain.py` for the full list):
- `GET /tasks` — task list with finish-to-start links and metadata; `?plant=`/`?machine=` scoping plus optional `?limit=`/`?offset=` (`meta.total` carries the full filtered count when paging). Hits `db.query_orders()` every request — no cache.
- `POST /task/update` (one task's start/end), `POST /tasks/update` (bulk — the frontend explicit-save path, payload `{ tasks, blocks?, calendars? }`), `POST /tasks/bulk_update` (flat-list alias for external tooling), plus `/tasks/baseline-correct` and `/tasks/refresh` (concurrency reconciliation).
- `GET /diagnostics[/deep|/db]` (pool stats, table health, connection activity, blocking-lock chains, index usage, slow queries via `pg_stat_statements`, sequence health) and `POST /maintenance/{vacuum-analyze,analyze}` behind a table allowlist — all driven by AdminCockpit.
- **`/setup/{plant}/*`** — `GET` the definition+matrix+machine states, `/coverage`, `/missing-pairs.csv`, and `/matrix-rows` (from-state-scoped — **use this, not a full snapshot**); `PUT …/active` is the "Include setup times in optimizer" activation checkbox; plus `…/definition`, `…/matrix/import` (validated mass-upload), `…/matrix` delete, `…/lines/{machine}/{state,compatibility}`, `…/overrides[/{id}]`.
- **`/security/*`** — see **Auth & RBAC** above.
- `GET|POST /system-settings` — global (not per-user, not per-plant) admin config in a singleton `system_settings` row, currently holding `orderFields`: which optional Orders fields are visible by default in the AG Grid / Inspector. Catalog: `web/order-field-catalog.mjs`; UI: the admin **System Configuration** sub-tab (`SystemConfig`).
- `/master-data/*` — per-plant `constraints`/`max-pull-forward-days`/`split-order-policy`, per-table `cascade-preview`/`columns`/`bulk`, `_schema-export`, `_material-grid`, `_material-plant-grid`, `resync-order-attributes`, `{plant}/missing-master-data` (+`?format=csv`).
- `/priority-fields`, `/priority-lists?plant=`, `/priority-list/{plant}/{field_key}`, `/priority-rank-maps` — see Priority lists above.
- `GET|POST /plant-calendar[/{plant,line}-hours|/{plant,line}-blackouts]` — durable calendars/blackouts. **Blackout management is plant-scoped** (`line: null` means per-plant, not global).
- `POST /reload` (refreshes `PLANT_LISTS` only — orders are never cached), `/upload`, `/bom/upload`, `/purge`, `/logs/frontend`; `GET /upload/audit`, `GET|POST /logs/backend`, `/audit/log`, `/health`, `/livez`, `/labor-plan`(`/line`).

All three `/update` endpoints call `db.update_task_dates_bulk()`, which validates payloads, **persists each edit to Postgres** (`scheduled_start`/`scheduled_end`), and rejects inverted ranges (end ≤ start) in a single transaction.

**Optimistic concurrency:** each update carries `base_version` (the row's `xmin`, surfaced as `ROW_VERSION`) and a `force` flag. Under `SELECT … FOR UPDATE`, a mismatch is **not** a 4xx — the id comes back in a `stale` list (HTTP 200) with new `versions`, and the frontend reconciles via `POST /tasks/refresh` with **last-writer-loses** semantics. `force` (optimizer-dirtied ids, or `Config.CONCURRENCY_CHECK` false) bypasses the check.

> **General hazard:** `orders.xmin` **is** `base_version`. **Any** `UPDATE orders` — even on a column no UI reads yet — bumps xmin for every row touched, so those ids come back `stale` on the next save and the frontend discards the planner's unsaved edit. This is why the priority-list attribute stamp is batch-scoped at ingest and otherwise explicit-only. Before adding any new `UPDATE orders` statement, ask what it does to in-flight planner edits.

**Split orders:** `order_schedule_segments` (`(order_id, segment_no)`) is a durable multi-segment schedule aggregate; **parent `orders.xmin` is the sole concurrency token** and segment rows are never independently exposed or updated by the API. Gated per plant by `plants.split_order_policy` (`never` | `overlong_only` | `partial_allowed`) — an absent/malformed value keeps the continuous-order scheduler unchanged. `orders.runtime_schedule_mismatch` flags an ingest-side `RUN_TIME` change that would otherwise make prior NIMBUS timing look valid; `MIN_PRODUCTIVE_SEGMENT_MINUTES` (30) is the phase-1 floor.

Task IDs are MD5 hashes of `f"{PRODUCTION_ORDER}|{MATERIAL_NUMBER}"` from `make_id()` in `db.py`. Because the hash excludes time, IDs are stable across reloads and reschedules — the frontend relies on this for keying drag/edit operations.

### Key Patterns

- **Optimization** runs through `Engine.runAndApply(mode)`. The UI offers three modes: `'spt'` (a legacy single-sort greedy walk), `'changeover'` ("Min Changeover", the default), and `'backlog'` ("Remove Backlog"). **`'combined'` / "Smart" was removed** (commit `b002b32`) — any code or doc still naming it is stale. `'changeover'` routes through `Engine._dispatchDayIntegrity`, giving each calendar day's "native" (due-that-day) orders first refusal before pulling in carry/pull-in/floater orders, ranked and placed via the generic `Engine._sortTerms(mode, { plant })` term factory — which resolves each configured priority field's rank per task from `Store.priorityRankMaps` (loaded via `GET /priority-rank-maps`, **never** stamped onto the order row, so cross-line drags pick up the destination line's ranks with no refetch). `'backlog'` forces calendar adherence, moves fixed orders when reached, and requires a plant-authoritative IANA `plants.timezone` rather than guessing the browser's; its result lands on `Engine.lastBacklogResult` (consumed-and-wiped by the preview). `plants.max_pull_forward_days` is an optional per-plant local-due-date floor on pull-forward. **Read `docs/architecture/optimizer-dispatch.md` before touching dispatch/sort-term code** — tiering, phase 1/2 placement, the force-place termination guard, the rank-cache freshness hazard, and the constraint registry are all there. These remain **dispatching heuristics, not a constraint solver**, and finish-to-start precedence is not consulted; manual pinning (`Store.isFixed`) is still the only protection an order has from being moved.
- **Setup-aware optimization** is a **detached** seam, not a mode: `Engine.evaluateSchedule(mode, opts, snapshot)` evaluates the legacy algorithm against a deep detached snapshot, and `Engine.evaluateSetupAware(mode, bounds, snapshot, thresholds)` runs the setup-aware evaluators (`'due-date-first'` | `'spt'` | `'min-changeover'` | `'throughput'`) — it **throws** unless the plant's setup definition is `active`. `web/setup-scheduler.mts` (~4,100 lines) receives the complete read model as a snapshot and returns only patches; it never touches Store, DOM, persistence, alerts, or Timeline — the workbench owns the single explicit Store commit after Apply (`Engine.applySchedulePatches`). `web/setup-domain.mts` is pure canonicalization/resolution with no browser, Store, network, or cache dependency. Results land on `Engine.lastSetupAwareResult` for the preview/diagnostics UI. Setup time is derived and drawn as a subordinate narrow bar — never stored as an order.
  - **Never-freeze invariant (approved 2026-08-18; commits `5c44458` + `0a17e74`):** missing setup data must **never** leave a line untouched. Blank/unresolvable signatures are placed at the tail of their day bucket by priority (no setup bar, alert raised). An order with a resolvable signature but **no matrix row** for its transition is admitted **in sequence at zero setup minutes**, kept near same-signature peers by a coverage tier at index 6 of the candidate score vector (right after `policyKey`, deliberately outside the mode-permuted terms so throughput's setup-minutes-first ordering can't invert it) — minimizing uncovered edges is what produces signature grouping. `runAndApply` derives the unplaced set by difference (in scope, not fixed, not patched) and warns, so drops can't happen silently.
  - **Docs vs. git:** the stage docs (`docs/changeover_matrix_stage_{0,1,2}.md`) carry **stale checkboxes** — Stage 0/1/2 all shipped (~50 commits), so **trust git log**. `docs/changeover_matrix.md` is the design of record, corrected by `docs/Setup_matrix_redesign.md` §1.1/§15 where activation simplified to one checkbox; `docs/Setup_teardown_bars.md` describes pre-feature NIMBUS.
- **Auto-reflow** after manual edits: `Engine.autoReflow()` re-flows subsequent unfixed orders on the affected line to eliminate drag-created overlap. It only shifts dates within one line, so it triggers an incremental, line-scoped alert recompute. Anything in the Interaction → Engine path must be aware of this.
- **Alerts** (overlap, overload, blackout, fixed-closed, fixed-out-of-hours, plus setup-specific rules) come from `Alerts.recompute(opts)`. A bare call scans all lines; `recompute({ lines })` does an **incremental pass** scoped to those lines and merges into the existing list. The debounced dispatcher is **adaptive** — delay scales with the last recompute's measured cost. Compute is offloaded to the worker via `Compute` (sync fallback if it's down). `Confidence.init` monkey-patches `Alerts.recompute` but forwards all arguments, so the `{ lines }` scope survives. Blackouts are also visually enforced by `Calendar` — dragging onto one snaps to the next valid slot. Alert rows show order numbers and are click-to-navigate.
- **Utilization** is computed per-line per-day in `Utilization.computeMatrix()` (surfaced in `Hierarchy`, `UtilStrip`, `Dashboard`). The Store-backed path (`srcTasks === null`) memoizes on `(startMs, days, Store._rev)`; the separate `Utilization.dayByLine`/`todayByLine` path is **unmemoized and not worker-offloaded**. Two caveats: `Dashboard` always passes a non-null filtered task subset, bypassing the memo; and the off-thread prewarm writes a plant-scoped matrix under a cache key the synchronous path expects to be global, so whichever producer runs first wins.
- **Auto-save** is debounced 1,200 ms in `Persistence` and writes the **localStorage cache only** (`_saveCache`) — it does **not** post to the backend. Backend persistence (`saveAll` → `POST /tasks/update`) is **explicit**: Cmd/Ctrl+S or the Save button. `saveAll` converts to local seconds (a client-UTC-offset corruption bug fixed 2026-07-07), always POSTs full `blocks`/`calendars` even with an empty dirty set, and on a partial save clears all dirty ids before checking `persisted < total`, so un-persisted rows are not auto-retried.

### Date / Time Inputs — Flatpickr Standard

**All date and time inputs use [Flatpickr](https://flatpickr.js.org/) — never native `<input type="date">`, `datetime-local`, or `time`.** Flatpickr loads via CDN in `index.html` (before `styles.css`). The NIMBUS amber theme lives mid-`styles.css` under `/* Flatpickr calendar — NIMBUS amber theme */`, with dark-mode counterparts later in the file. **Exception:** the AG Grid inline `start_date` cell editor (`Table._DateTimeEditor`) is a native `datetime-local`.

| Type | `enableTime` | `noCalendar` | `dateFormat` | `altInput` | `altFormat` |
|------|:---:|:---:|---|:---:|---|
| Date-only | — | — | `"Y-m-d"` | `true` | `"M j, Y"` |
| Datetime | `true` | — | `"Y-m-d\\TH:i"` | `true` | `"M j, Y · h:i K"` |
| Time-only (hours table) | `true` | `true` | `"H:i"` | — | — |

Modal pickers are **module-level, lazily initialized, and conventionally named `_fp*`** — built once behind an `if (!Module._fpX)` guard, then `Module._fpX.setDate(d, false)` (`false` suppresses `onChange`); table time inputs are built inline per row. `grep -n "flatpickr(" web/*.mjs` finds every instance. With `altInput: true`, existing `.value` reads keep working: the hidden original input holds the `dateFormat` value, the visible alt input shows `altFormat`.

### Files

**Frontend source lives under `web/`** — `index.html`, `styles.css`, `app.js`, `nimbus-intelligence.js`, `nimbus-worker.ts`/`.js`, `nimbus-compute-core.js`, the TypeScript-compiled ES modules listed above plus `setup-scheduler`, `types`, and `order-field-catalog`, `locales/`, `Images/`, and TS ambient declarations (`web/types/api-generated.d.mts` is OpenAPI→TS codegen). The TS build is configured by the repo-root `tsconfig.json`/`tsconfig.worker.json`. `brain.py`'s `STATIC_DIR` defaults to `<repo>/web` (resolved from `Path(__file__)`, not the process cwd), so `uvicorn brain:api` always serves that tree and never `brain.py`/`db.py`/`schema.sql`. `scripts/check-static-assets.mjs` enforces this: every local import reachable from a `.mjs` under `web/` must resolve inside `web/`, and no backend filename may appear there.

`styles.css` (~5,500 lines) uses a CSS-variable design-token system (warm off-white light base, deep-slate dark mode, amber accent) with a `body.dark` layer that is **incomplete** — several newer components hardcode light colors, and a few tokens are referenced but never defined (`--border`, `--border-subtle`, `--font-mono`, `--bg-float`). `index.html` carries ~1,000 lines of not-yet-migrated inline `<style>`.

**Tests:** `tests/` holds the Python suite (plus `contracts/` and `support/`), `tests/js/` the legacy Node tests (`compute-core.test.js` parity pins, `timezone-contract.test.js`), and `tests/modules/` the ES-module tests. Keep test work **repair-scoped** — fix what a change breaks rather than adding new suites, and run scoped commands rather than full sweeps.

**Container:** `Dockerfile` (repo root) builds the single-container image (`python:3.12-slim`, non-root), copying the frontend into `/app/web` and serving it through the `StaticFiles` mount registered as the **last** route in `brain.py`, so API and UI share one origin and backend source is never web-served.

**Docs.** Repo-root docs are limited to what tools require there — `CLAUDE.md`/`AGENTS.md` (Claude Code/Codex convention), `DESIGN.md`/`PRODUCT.md` (Impeccable reads these at the project root by hardcoded convention — moving them breaks `/impeccable`), plus `Entra_Auth_Migration.md`. Everything else is under `docs/`: `DEPLOYMENT.md`, `MIGRATION.md`, `typescript_migration.md`, `scheduling_priority.md`, the setup/changeover set, `NIMBUS_INTERFACE_ARCHITECTURE.md`, `SAP_INTEGRATION_ROADMAP.md`, `architecture/`, `superpowers/`, `archive/`. Gitignored sample data lives in `sample-data/`.

> **Doc-staleness warning, generally:** several NIMBUS planning docs track progress with checkboxes never updated after the work shipped, and past audit reports list findings already fixed. **Verify any doc claim against live code and git log before acting on it.**
