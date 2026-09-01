# NIMBUS Domain-Oriented Refactor Plan

> **Status:** planned, not executed. Produced 2026-08-31 from a verified codebase inventory (file/line counts, exports, import graphs, and tooling pins were all checked against the live tree on that date — re-verify anything load-bearing before executing a phase, per the repo's standing doc-staleness warning). **Revised same day (v2)** to compress scope for agent execution: routes-only backend split (db.py/master_data.py carve-up deferred to `docs/MIGRATION.md`), coarser per-domain frontend extraction (~13 target files instead of ~24), the cycle-1 DI seam replaced by a verified 2-line adapter move, one substantive CLAUDE.md per domain, and a new branch-triage precondition (P-1). Revised sizing ≈ 13–16 focused hours.
>
> **Goal:** reorganize NIMBUS around meaningful product domains — each domain gets a dedicated folder with its components, logic, types, services, and its own `CLAUDE.md` — so a coding agent (or human) can locate a feature, read one folder's `CLAUDE.md`, and understand it without scanning unrelated code. **Behavior is preserved exactly.**
>
> **Why:** NIMBUS today is organized by *extraction history*, not product domain. The frontend is 8 mega-modules from the CQ-1 extraction (`plant-and-administration.mts`, 11,308 lines, holds 11 unrelated admin features; `schedule-workbench.mts`, 10,388 lines, holds 18 UI modules); the backend is 7 flat root `.py` files with `brain.py` (3,982 lines) holding all 103 routes. Working on the setup matrix means scanning files that also contain security, labor planning, and SAP-interface code.
>
> **Decisions of record (2026-08-31, incl. v2):** full-stack scope (frontend + backend); split the mega-modules by domain at **per-domain granularity** (one target file per domain per source mega-module — finer intra-domain splits are cheap optional follow-ons once code lives in the right folder); **backend split is routes-only** (`brain.py` → thin assembly + nine domain routers + four whole-file module moves; `db.py`/`master_data.py` stay intact at root, their split deferred); phased sequencing where **every phase ends green**; in-flight branches triaged before splitting begins (P-1).

---

## 0. Two load-bearing decisions (read first)

**D-A — The web root keeps the boot/classic-script layer; only ES modules move into domain folders.** `index.html`, `styles.css`, `app.js`, `nimbus-intelligence.js`, `nimbus-compute-core.js` (+`.d.ts`), `nimbus-worker.ts`/`.js`, `app-entry.mjs`, `locales/`, `Images/`, `types/` (generated+ambient), `_static-delivery-check.mjs` stay exactly where they are. Every one of these is flat-path-pinned (see §1), they are classic scripts or generated artifacts with no domain-split value, and leaving them eliminates ~70% of tooling churn.

**D-B — `brain.py` stays at repo root as a thin app assembly (~250 lines: app construction, middleware, exception handlers, lifespan bootstrap, `include_router` calls, StaticFiles mount last); the route layer moves into a new `server/` package, and `db.py`/`master_data.py` stay intact at repo root.** Routers import root `db` / `master_data` unchanged (repo root is already on `sys.path` for tests, uvicorn, and the container). This preserves the Dockerfile `CMD uvicorn brain:api`, the `Path(__file__).parent / "web"` STATIC_DIR resolution (pinned by `tests/test_static_delivery.py`), `tests/conftest.py`'s root `sys.path`, and — because `db.py`/`master_data.py` don't move — the 24 test files' bare `import db` / `import master_data as md`, the ruff per-file-ignore keys, and every private `db._pool`/`db._str_id` import. The full data-layer split is **deferred** (recorded in `docs/MIGRATION.md`), not abandoned.

**Mechanical rule for every frontend move:** each `.mts` compiles **in place** to a committed `.mjs` twin (`rootDir === outDir === "web"`; the tsconfig include `web/**/*.mts` is recursive, so subfolders Just Work). Every move must `git mv` **both** files, update import specifiers, run `npm run build`, and verify no orphan `.mjs` remains at the old path — an orphan would still be served and silently loadable.

## 1. Verified tooling pins (why §0 is shaped this way)

Breaks on frontend file moves:

1. `scripts/check-static-assets.mjs` — hardcoded flat `REQUIRED_ASSETS` list (index.html, styles.css, app.js, nimbus-intelligence.js, nimbus-worker.js, nimbus-compute-core.js, locales/{en,de,es,fr,pt}.js, Images/user.png). Also: `ALLOWED_EXTENSIONS` excludes `.md` (blocks CLAUDE.md under web/ — see §6); its forbidden-basename and import-closure checks are already subfolder-safe.
2. `tsconfig.worker.json` — include hardcodes `web/nimbus-worker.ts` + `web/nimbus-compute-core.d.ts`.
3. `scripts/legacy-surface.mjs` — **non-recursive** `readdirSync(web)` for `.mjs` discovery (a `.mjs` moved into a subfolder is silently dropped from the scan); 3 hardcoded flat reads (index.html, app.js, nimbus-intelligence.js); the contract `tests/contracts/cq1-legacy-surface.json` keys entries by **bare basename**.
4. `web/index.html` — `document.write` loader with flat relative paths (locales → nimbus-compute-core.js → app-entry.mjs → app.js → nimbus-intelligence.js); line 56 hardcodes `styles.css?v=2026-08-25-a` as a literal manually duplicated from `NIMBUS_BUILD_ID` (a standing drift hazard independent of this refactor).
5. `web/schedule-services.mts:1291` `new Worker('nimbus-worker.js?v=…')`; `web/nimbus-worker.js:37` `importScripts('nimbus-compute-core.js'+search)`; `/Images/user.png` absolute refs (index.html:1201, application-shell.mts:276); `npm test` globs are **non-recursive** (`tests/js/*.test.js`, `tests/modules/*.test.mjs`); ESLint pins the 3 classic `.js` files + `nimbus-worker.ts` by flat path (its `web/**/*` globs are otherwise recursive); `tests/test_static_delivery.py` GETs `/app.js` and `/_static-delivery-check.mjs`.

Breaks on backend moves (routes-only scope): Dockerfile CMD (unchanged — `brain.py` stays); test files doing bare `import setup_data` / `import auth` / `import admin_tables` / `import sap_sync` (those four modules move; the far larger `import db` / `import brain` / `import master_data as md` population is untouched); `ci.yml` (`import brain` smoke env, `ruff check .`, `psql -f schema.sql`, `pytest -ra` — re-verify, no path change expected); the promote-azure skill hardcodes `schema.sql` / `migrations/*.sql` (both untouched by this plan). Now moot under routes-only scope: the five modules importing private `db._pool`/`db._str_id` by name, the pyproject ruff keys for `"brain.py"`/`"db.py"`, and `.claude/settings.local.json`'s `py_compile brain.py master_data.py db.py` entry — all named files still exist at root with their symbols.

Already subfolder-safe: the `StaticFiles` directory mount, the `.mjs` no-cache middleware (path-suffix based), GZip, `Dockerfile COPY web ./web` (+ `COPY . .` covers `server/`), tsc's main include, and check-static-assets' forbidden-file & import-closure checks.

`.worktrees/` and `.claude/worktrees/` hold ~8 stale full copies of the repo — **never edit them; scope every search/replace to the main tree** (they will pollute grep results throughout).

## 2. Final domain map (13 domains)

Judgment calls vs. an initial seed: **intelligence merged into shell** (one pinned classic script; earns a CLAUDE.md section, not a folder); **system-settings merged into admin-ops**; **insights kept separate** from scheduling (it is the compute-core/worker consumer with its own hazards). On the backend, `server/<domain>/` folders hold routers plus the four whole-file module moves; there is **no `server/core/`** in this revision — the shared data layer (`db.py`, `master_data.py`) stays at root until the deferred split.

| # | Domain | Folders | Purpose | Boundary judgment calls |
|---|---|---|---|---|
| 1 | **platform** | `web/platform/` | Foundation primitives + app-wide reactive state: Config, Util, Toast, Modal, ErrorLog, VirtualList, PerfMonitor, Store, UndoStack, shared types. | **Store stays platform**, not scheduling — it holds calendars, blocks, master data, prefs, alerts; every domain subscribes. UndoStack is generic snapshot infra. `nimbus-compute-core.js` + worker stay at web root (§0 D-A) but are platform-owned in docs. `types.mts` → platform (leaf everyone imports). |
| 2 | **scheduling** | `web/scheduling/` + `server/scheduling/` | The planner's daily surface: Gantt timeline, orders grid, inspector, drag/keyboard interaction, explicit save — plus the `/tasks` read/write backend with the xmin concurrency contract. | **Selection** → scheduling (task selection synced Gantt↔grid). **Persistence** → scheduling (it is the `/tasks` client). **Hierarchy** → scheduling (the Gantt's plant→machine sidebar, despite reading Utilization). **order-field-catalog.mjs** → scheduling (catalogs *order* fields; SystemConfig imports it cross-domain — fine, leaf data module). **Printer** → scheduling (prints the schedule). |
| 3 | **optimization** | `web/optimization/` (client-side only) | The optimizer: Engine dispatch, the setup-aware evaluator (`setup-scheduler.mts`), OptimizeDialog/OptimizerPreview, Sandbox what-if. | **Sandbox + SandboxAdapter** → optimization (what-if is an optimizer workflow). `setup-scheduler.mts` lands here, **not** setup: it is the *scheduler* consuming setup data; setup owns data/resolution semantics. |
| 4 | **setup** | `web/setup/` + `server/setup/` | Changeover/setup signatures: definitions, matrices, machine states, overrides — pure resolution (`setup-domain.mts`), SetupAdmin UI, `setup_data.py`, `/setup/*` routes. | O(states²) hazard, never-render-full-matrix rule, observation-only invariant live here. |
| 5 | **calendar** | `web/calendar/` + `server/calendars/` | Working hours, blackouts, capacity math: `Calendar` engine, CalendarUI, EditCalendar, CalendarSync, `/plant-calendar*` routes. | The "capacity math must be mirrored in compute-core" rule is co-owned with platform. |
| 6 | **insights** | `web/insights/` | Derived signal over the schedule: Alerts (computation + AlertsUIAdapter bell/drawer), Utilization matrix, Dashboard KPIs, the `Compute` worker client. | **Compute** → insights (its only consumers are Alerts/Utilization offload). Dashboard renders aggregates, not the editing surface → here. |
| 7 | **priority-lists** | `web/priority-lists/` + `server/priority_lists/` | Per-plant/per-field rankable priority lists: PriorityListMapping upload/mapping UI, ColorWheelViewer/PriorityListViewer, `/priority-*` + legacy `/color-wheel*` endpoints, the `PLANT_LISTS` cache. | The field registry (`RANKABLE_FIELDS`/`CONFIGURABLE_PRIORITY_FIELDS`) **stays in `master_data.py` for now** — its extraction to `server/priority_lists/fields.py` (which would also remove the `setup_data → master_data` import edge) is deferred with the data-layer split. The routes module still treats it as this domain's single source of truth, documented in this domain's CLAUDE.md. |
| 8 | **master-data** | `web/master-data/` + `server/master_data/` | The nine ALLOWED_TABLES: CRUD grids, runtime DDL, constraints/policies, cascade preview, schema export, admin table browser. Frontend: MasterData, MaterialGrids, AdminTables, Plant, ProdLines. | `admin_tables.py` (read-only browser) → master-data, not admin-ops: it browses these tables under the same catalog rules. Plant/ProdLines edit `plants`/`machine` rows → here. |
| 9 | **labor** | `web/labor/` + `server/labor/` | Labor planning: LaborPlanning editor, `/labor-plan*` routes. | Small but self-contained with its own tables — worth the folder. |
| 10 | **security** | `web/security/` + `server/security/` | Login, users/roles, role_plants scoping, per-user settings: Security admin UI, `Session` service, `auth.py`, `/security/*`. | **Session** → security; **SessionUIAdapter/showLoginScreen stay in shell** (boot-time chrome) with a cross-link. |
| 11 | **integration** | `web/integration/` + `server/integration/` | Data in/out: Excel order ingest (`/upload`), BOM upload, purge, upload audit, missing-master-data reports, attribute resync, SAP sync skeleton + Interface UI. | The `/upload` + SAP-sync route surface lives here; the shared ingest/upsert/stamping *functions* stay in root `db.py` until the deferred split (this domain's CLAUDE.md points at them). `sap_sync.py` moves whole. |
| 12 | **admin-ops** | `web/admin-ops/` + `server/admin_ops/` | Operating the running system: AdminCockpit (diagnostics, pg console, perf, log viewers, diagnostics bundle), SystemConfig, `/diagnostics*`, `/maintenance/*`, `/logs/*`, `/system-settings`, `/reload`, the `_BACKEND_LOG` ring buffer. | The db-diagnostics *functions* stay in root `db.py` (deferred); the routes and the ring buffer move here. |
| 13 | **shell** | `web/shell/` | Boot + chrome: App tab orchestration, PlantSelector, Settings, EmptyState, login screen UI; custodian of the root-pinned classic scripts (`app.js`, `app-entry.mjs`, `nimbus-intelligence.js`, `index.html`, `styles.css`, locales) — the intelligence layer is documented in shell's CLAUDE.md. | — |

## 2b. Application-direction considerations (why the v2 scope cuts are safe)

- **Entra auth migration is the plan of record** (`Entra_Auth_Migration.md`: Easy Auth, login page kept, email re-key). `auth.py` therefore moves **whole and internally untouched** — do not invest in restructuring its internals; the `_actor_email` trusted-header seam gets rewritten by that migration anyway.
- **Multi-replica future** (`docs/MIGRATION.md`): the two pieces of in-process shared state — the `PLANT_LISTS` cache and the `_BACKEND_LOG` ring buffer — are exactly what a shared-state (e.g. Redis) change will touch. This plan extracts them into `server/priority_lists/cache.py` and `server/admin_ops/logbuffer.py` with module-private state behind narrow accessor functions, so that future swap stays file-local.
- **TypeScript migration** (`docs/archive/typescript_migration.md`): the domain folders become the unit that roadmap tracks — P6 updates its module table to the new paths.
- **50+ plants scale roadmap**: no structural impact; the per-plant scaling rules distribute into domain CLAUDE.md files via §7.
- **SAP integration roadmap**: connectors will grow inside `server/integration/` — the domain boundary anticipates that.

## 3. Complete frontend relocation table

Every row = the `.mts` source **and** its compiled `.mjs` twin; `git mv` both. **Granularity rule (v2): one target file per domain per source mega-module.** Finer intra-domain splits (e.g. pulling Interaction out of `gantt.mts`) are optional follow-ons — once code is in the right folder they're within-domain edits with no cross-domain seams, so they're cheap and can wait for a real need.

Stays at `web/` root (§0 D-A): `index.html`, `styles.css`, `app.js`, `nimbus-intelligence.js`, `nimbus-compute-core.js` + `.d.ts`, `nimbus-worker.ts`/`.js`, `app-entry.mjs`, `_static-delivery-check.mjs`, `locales/*`, `Images/*`, `types/*`.

| Current file → exported module(s) | Target |
|---|---|
| `application-foundation.mts` (Config, Util, VirtualList, PerfMonitor, ErrorLog, Toast, Modal) | `web/platform/foundation.mts` |
| `types.mts` (whole) | `web/platform/types.mts` |
| `schedule-state.mts` → Store, UndoStack, StoreEvent | `web/platform/store.mts` |
| `schedule-state.mts` → Selection | `web/scheduling/selection.mts` |
| `schedule-state.mts` → Sandbox | `web/optimization/sandbox.mts` |
| `schedule-services.mts` → Calendar + `candidateDefaultWorkHours` | `web/calendar/calendar-engine.mts` |
| `schedule-services.mts` → Alerts, Utilization, Compute + `scheduleAlertsForPatches` (Compute owns the `new Worker('nimbus-worker.js?v=…')` — the worker file itself stays at web root, URL unchanged) | `web/insights/services.mts` |
| `schedule-services.mts` → Engine, `snapshotSchedule`, `applySchedulePatches`, `effectiveFirmedIdSet`, `deriveSetupObservation`, `SETUP_AWARE_DEADLINE_MS`, RuntimeAllocation, SetupCompute* types | `web/optimization/engine.mts` |
| `schedule-services.mts` → `MIN_PRODUCTIVE_SEGMENT_MINUTES`, RemoveBacklog types | `web/optimization/scheduler-contract.mts` (new tiny leaf — see §5 cycle 1) |
| `setup-scheduler.mts` (whole, minus the 4-line `evaluateSchedule` adapter — see §5) | `web/optimization/setup-scheduler.mts` |
| `setup-domain.mts` (whole) | `web/setup/setup-domain.mts` |
| `schedule-data.mts` → Persistence | `web/scheduling/persistence.mts` |
| `schedule-data.mts` → CalendarSync | `web/calendar/calendar-sync.mts` |
| `schedule-data.mts` → Session | `web/security/session.mts` |
| `schedule-workbench.mts` → Timeline, TimelineNav, DependencyOverlay, Interaction, Hierarchy, GanttFilter | `web/scheduling/gantt.mts` |
| `schedule-workbench.mts` → Table, Inspector, ContextMenu, Printer | `web/scheduling/orders.mts` |
| `schedule-workbench.mts` → OptimizeDialog, OptimizerPreview, SandboxAdapter | `web/optimization/optimize-ui.mts` |
| `schedule-workbench.mts` → EditCalendar | `web/calendar/edit-calendar.mts` |
| `schedule-workbench.mts` → Dashboard, AlertsUIAdapter | `web/insights/insights-ui.mts` |
| `schedule-workbench.mts` → ColorWheelViewer, PriorityListViewer | `web/priority-lists/viewers.mts` |
| `plant-and-administration.mts` → SetupAdmin | `web/setup/setup-admin.mts` |
| `plant-and-administration.mts` → CalendarUI | `web/calendar/calendar-admin.mts` |
| `plant-and-administration.mts` → Plant, ProdLines, MasterData | `web/master-data/admin-ui.mts` |
| `plant-and-administration.mts` → PriorityListMapping | `web/priority-lists/mapping.mts` |
| `plant-and-administration.mts` → LaborPlanning | `web/labor/labor-planning.mts` |
| `plant-and-administration.mts` → AdminCockpit, SystemConfig | `web/admin-ops/admin-ui.mts` |
| `plant-and-administration.mts` → Interface | `web/integration/sap-interface-ui.mts` |
| `plant-and-administration.mts` → Security | `web/security/security-admin.mts` |
| `plant-and-administration.mts` → `setActiveTabResolvers` seam | `web/shell/tab-resolvers.mts` (tiny leaf; shell + admin modules import it) |
| `master-data-grids.mts` → MaterialGrids | `web/master-data/material-grids.mts` |
| `admin-tables.mts` → AdminTables, `parseFilterPasteText`, `buildTableQueryParams` | `web/master-data/admin-tables.mts` |
| `application-shell.mts` (Settings, SessionUIAdapter, showLoginScreen, EmptyState, PlantSelector, App) | `web/shell/application-shell.mts` |
| `order-field-catalog.mjs` + `order-field-catalog.d.mts` | `web/scheduling/order-field-catalog.mjs` (+ `.d.mts`) |

**Bridge compatibility (critical):** `app-entry.mjs` continues to assemble the same eight `window.__NIMBUS_*` namespace objects (and the `setup-domain` side-effect import) by importing from the new domain files and spreading — e.g. `window.__NIMBUS_WORKBENCH = { Timeline, TimelineNav, …, Printer }` with **identical keys**. `app.js`'s eight-bridge destructure and the legacy-surface contract are untouched. During each split phase, the old mega-module path is kept as a **temporary barrel re-export file** (e.g. `plant-and-administration.mts` becomes ~9 `export … from` lines) so intermediate commits stay green; the barrel is deleted within the same phase once `app-entry`/importers are repointed. Barrels never survive across phases.

**Splitting caveats:** intra-file shared private helpers get hoisted into a domain-local shared file only if ≥2 extracted files in the **same domain** need them (expect a few grid/form helpers in P2 → `web/master-data/admin-shared.mts`); a helper needed across domains goes to `web/platform/`. The coarse granularity keeps tightly coupled modules together by design (Timeline+Interaction share private drag state; Plant/ProdLines/MasterData share grid plumbing) — do not invent DI seams to separate them.

### Frontend tests → `tests/modules/<domain>/`

`foundation.test.mjs`, `schedule-state.test.mjs` → `platform/` · `schedule-workbench.test.mjs`, `schedule-data.test.mjs` → `scheduling/` (no split needed — repoint imports only) · `setup-scheduler.test.mjs`, `split-order.test.mjs`, `remove-backlog.test.mjs` → `optimization/` · `setup-domain.test.mjs`, `setup-resolution-index.test.mjs` → `setup/` · `schedule-services.test.mjs` → split three ways with P4 (calendar/insights/optimization) · `alert-order-display.test.mjs` → `insights/` · `admin-tables.test.mjs` → `master-data/` · `plant-and-administration.test.mjs` → split per the coarser P2 targets · `locale-completeness.test.mjs`, `legacy-app-characterization.test.mjs`, `app-entry.test.mjs`, `legacy-surface.test.mjs`, `static-assets.test.mjs`, `application-shell.test.mjs` → `shell/`. `helpers/` + `fixtures/` stay at `tests/modules/` root. **Required fix first (P0):** the `test:modules` glob is non-recursive — switch to recursive discovery (`node --test tests/modules/` on Node ≥20, or a `**/*.test.mjs` glob). `tests/js/` stays put.

## 4. Backend relocation table (routes-only split)

**Scope decision (v2):** `brain.py`'s 103 routes split into nine domain routers — the discoverability win — while `db.py` and `master_data.py` **stay intact at repo root** and routers import them unchanged. The line-range carve-up of those two files (plus a `server/core/` and the fields-registry extraction) is **deferred**, recorded in `docs/MIGRATION.md`. This eliminates the 24-test-file import rewrite, the `_pool`/`_str_id` alias hack, and the ruff key migration.

| Current | Target |
|---|---|
| `brain.py` app/middleware/exception-handlers/lifespan/StaticFiles mount | stays root, thin assembly (~250 lines) |
| `brain.py` `/tasks` family (lines 1420–1894) + Pydantic response models (1567–1703) | `server/scheduling/routes.py`, `server/scheduling/models.py` |
| `brain.py` upload/bom/purge/audit/missing-master-data (1895–2073), SAP interface (3464–3638), resync route (from 3225–3325) | `server/integration/routes.py` |
| `brain.py` priority + color-wheel legacy routes (2074–2424) | `server/priority_lists/routes.py` |
| `brain.py` `PLANT_LISTS` cache (module state + load/refresh) | `server/priority_lists/cache.py` — module-private dict behind narrow accessors (routers and `brain.py`'s lifespan/`/reload` import these; routers must not import `brain` — circular) |
| `brain.py` setup routes (2425–2746) | `server/setup/routes.py` |
| `brain.py` audit/schema-export (2747–2817), admin table browser (2852–2915), master-data CRUD/DDL (2916–3081), plant policies + page access (3082–3201), material-plant attrs (3225–3325) | `server/master_data/routes.py` |
| `brain.py` system-settings (3202–3224), diagnostics/health/reload (1282–1420), db-diag + maintenance (3782–3845), logs (3846–3982) | `server/admin_ops/routes.py` |
| `brain.py` `_BACKEND_LOG` ring buffer + `_log_event` (+ the admin-audit append helper) | `server/admin_ops/logbuffer.py` — module-private deque behind accessors (imported by the routes module **and** `brain.py`'s `request_id_mw`) |
| `db.py` (whole) | **stays at repo root, untouched** (split deferred — `docs/MIGRATION.md`) |
| `master_data.py` (whole, incl. the field registry) | **stays at repo root, untouched** (split deferred — `docs/MIGRATION.md`) |
| `setup_data.py` (whole) | `server/setup/data.py` |
| `auth.py` (whole, internally untouched — see §2b Entra note) | `server/security/auth.py` |
| `brain.py` security routes (3326–3463) | `server/security/routes.py` |
| `brain.py` labor (3639–3692) / calendars (3693–3781) | `server/labor/routes.py` / `server/calendars/routes.py` |
| `admin_tables.py` (whole) | `server/master_data/browser.py` |
| `sap_sync.py` (whole, incl. the APScheduler) | `server/integration/sap_sync.py` |

**Router mechanics:** each `server/<domain>/routes.py` exposes `router = APIRouter()` with **identical paths — URLs are a frozen contract, no prefixes**. `brain.py` does `api.include_router(...)` for all nine, then the StaticFiles mount **last** (order preserved). Auth guards live in `server/security/auth.py`; route modules import them (one-way).

**Import DAG (acyclic, enforced by review):** root `db.py`/`master_data.py` ← `server/security/auth.py` / `server/setup/data.py` / `server/integration/sap_sync.py` / `server/master_data/browser.py` / `cache.py` / `logbuffer.py` ← `server/*/routes.py` ← `brain.py`. The existing `setup_data → master_data` edge (field registry) remains until the deferred registry extraction. No route module may import `brain`.

**Lifespan bootstrap:** `brain.py`'s lifespan keeps calling the same `ensure_*` DDL functions in the **exact current call order** (roles before role_plants; plants columns before policies) — only the import paths of the four moved modules change. Copy the sequence verbatim; never reorder.

**Python tests stay flat** at `tests/*.py` (filenames already say the domain; grouping adds churn without discoverability win). Import updates are limited to the files doing bare `import setup_data` / `import auth` / `import admin_tables` / `import sap_sync` → `server.*` paths (P5). `import db` / `import master_data as md` / `import brain` are all unchanged. `conftest.py` itself is unchanged (root sys.path already resolves `server.*`).

**Config updates (P5):** `pyproject.toml` per-file-ignores — `"brain.py"` and `"db.py"` keys survive (files still exist); move only the `PLANT_LISTS`-cache PLW0603 ignore to `"server/priority_lists/cache.py"` (moot if the accessor-function shape removes the `global` statements). `ci.yml`: no path changes expected (`ruff check .`, `pytest -ra`, root `schema.sql`) — re-verify the `import brain` smoke env still passes. `.claude/settings.local.json`: the `py_compile brain.py master_data.py db.py` entry is unchanged. `Dockerfile`: CMD unchanged; `COPY . .` covers `server/`; update the lines-38–40 security comment to name `server/`. `check-static-assets`' forbidden-basename list needs nothing (it rejects `.py` by extension already).

## 5. Breaking the two import cycles (imports verified against source, 2026-08-31)

**Cycle 1: `schedule-services` ↔ `setup-scheduler`** (resolved in P4 — v2 replaces the earlier DI-seam idea with a plain code move).
Verified edges: services→scheduler pulls the five pure evaluators + `SETUP_AWARE_CONVERGENCE_WINDOW` + 8 types (`schedule-services.mts:35–53`); scheduler→services pulls `RemoveBacklogResult` (type only), `Engine`, `candidateDefaultWorkHours`, `MIN_PRODUCTIVE_SEGMENT_MINUTES` (`setup-scheduler.mts:9–10`). `Engine` is used at exactly **one** call site: the thin `evaluateSchedule` adapter (`setup-scheduler.mts:4883–4886`), whose **only external callers are `schedule-workbench.mts:8480` and `:8576`** (imported at `:148`) — code that lands in `web/optimization/optimize-ui.mts` anyway.
Seam: (a) new leaf `web/optimization/scheduler-contract.mts` holds `MIN_PRODUCTIVE_SEGMENT_MINUTES` + `RemoveBacklogResult` (re-exported from `engine.mts` for compatibility) — still needed because the constant is a runtime value setup-scheduler imports while engine imports setup-scheduler; (b) `candidateDefaultWorkHours` moves down into `web/calendar/calendar-engine.mts` (it is calendar semantics); (c) **move the 4-line `evaluateSchedule` adapter out of `setup-scheduler.mts` into `web/optimization/engine.mts`** (exported; `engine.mts` already owns `Engine`) and repoint the two `optimize-ui.mts` call sites' import. No DI, no runtime throw-if-unbound state, no test stubs. (`applyPatchesToSnapshot` stays in setup-scheduler.) Result: `setup-scheduler` imports only `setup-domain`, `platform/types`, calendar-engine, and the leaf contract — acyclic. Re-verify the adapter's caller list at P4 execution (grep for `evaluateSchedule` outside setup-scheduler).

**Cycle 2: `schedule-workbench` ↔ `plant-and-administration`** (dissolves with P2+P3, no DI needed).
Verified edges: workbench→admin uses only `SetupAdmin.mountStateEditor` (call sites `schedule-workbench.mts:152, 3910, 3950`); admin→workbench uses `AlertsUIAdapter.renderBell/renderDrawer` (`plant-and-administration.mts:3496–3497`) and `PriorityListViewer.open/close/search`. After the splits these become one-directional cross-domain edges: `scheduling/gantt.mts → setup/setup-admin.mts`, `admin-ops/admin-ui.mts → insights/insights-ui.mts`, `priority-lists/*` internal. Post-split check: `setup-admin.mts` must not import back into `scheduling/*` (grep during planning found no such references; re-verify at P2 execution).

## 6. Per-domain CLAUDE.md strategy

**Decision: CLAUDE.md lives inside each domain folder, including under `web/`, with a static-serving block.** Claude Code auto-loads CLAUDE.md from ancestor directories of edited files — a doc parked in `docs/domains/` would never auto-load and defeats the goal. Required enablers (P0):

1. A small middleware in `brain.py` (modeled on the existing `static_mjs_no_cache_mw`) returning 404 for any request path ending `.md` — internal docs must not be publicly served by the StaticFiles mount on the live pilot.
2. `scripts/check-static-assets.mjs`: add `.md` to `ALLOWED_EXTENSIONS`, restricted so only the basename `CLAUDE.md` is allowed under `web/`.
3. A pytest in `tests/test_static_delivery.py` pinning `GET /scheduling/CLAUDE.md → 404`.

**One substantive CLAUDE.md per domain (v2),** placed on the domain's heavier side, with a **3-line pointer CLAUDE.md** on the other side (so ancestor auto-load fires from either half, and the pointer names the substantive file). Substantive doc placement: `server/` side for priority-lists, master-data, integration, security, admin-ops, labor, calendars; `web/` side for platform, optimization, insights, shell. **Exceptions — scheduling and setup get two substantive files each** (both halves carry heavy invariants: xmin contract vs. drag/save UI semantics; observation-only data model vs. matrix admin UI). Because the `db.py`/`master_data.py` split is deferred, server-side docs **must reference the root files (with current line ranges) for their data functions** — e.g. `server/integration/CLAUDE.md` points at `db.py`'s ingest/upsert/stamp block.

**Template (each ≤ ~120 lines; pointer files ≤ 3 lines):**

```
# <Domain> — <one-line purpose>
## What lives here (file → exported modules/functions, one line each)
## Counterpart (link to the other half: web/… or server/… — and, until the deferred split, the root db.py/master_data.py ranges this domain owns)
## Key invariants & hazards (relocated from root CLAUDE.md — load-bearing ones only)
## Integration points (imports in/out; Store events; endpoints)
## Tests (exact files + the scoped command to run them)
## Gotchas (stale docs, known drift, perf traps)
```

## 7. Invariant relocation map (root CLAUDE.md → domain CLAUDE.md)

| Root-CLAUDE.md item | New home |
|---|---|
| xmin/`base_version` hazard ("any `UPDATE orders` bumps xmin"), stale-list last-writer-loses reconciliation, split-order segments contract, `make_id` MD5 stability | `server/scheduling/CLAUDE.md` (+ pointer in `web/scheduling/`) |
| Never-freeze invariant (2026-08-18), optimizer modes ('combined' removed, `_dispatchDayIntegrity` deleted), synthetic zero-cost snapshot, `Engine.lastSetupAwareResult`, detached-snapshot/patches contract, backlog frozen-horizon carve-out, `docs/architecture/optimizer-dispatch.md` pointer | `web/optimization/CLAUDE.md` |
| O(states²) / matrix-rows-not-snapshot rule, observation-only ("this module never changes an order's schedule"), derived<manual<actual trust ordering, activation checkbox, stale stage-doc warning | `web/setup/` + `server/setup/` CLAUDE.md |
| Capacity-math mirror rule (Calendar ↔ nimbus-compute-core, parity-pinned by `tests/js/compute-core.test.js`), blackout snap behavior, `line: null` = per-plant | `web/calendar/CLAUDE.md` (mirror rule cross-linked from `web/platform/`) |
| Alerts incremental `{lines}` scope, adaptive debounce, Confidence monkey-patch forwards args, worker fallback `_dead=true` permanent, utilization memo caveats (Dashboard bypass; prewarm cache-key collision) | `web/insights/CLAUDE.md` |
| Batch-scoped attribute stamp at ingest, `upsert_orders` shared by /upload + SAP, missing-master-data exception report, `runtime_schedule_mismatch`, APScheduler disabled-by-default + single-replica caveat | `server/integration/CLAUDE.md` |
| RANKABLE_FIELDS single source of truth (still physically in root `master_data.py` — deferred move), no-global-fallback tier, ranks-never-stamped-on-orders, `PLANT_LISTS` cache lifecycle (startup / POST /reload / inline), `_audit_log.json` durability caveat, scheduling_priority.md seams | `server/priority_lists/CLAUDE.md` |
| PLANT_SCOPED_TABLES static allowlist rationale, DDL-injection history (`sql.Literal` rebuild), `export_schema_sql` drift-recovery path, composite keys | `server/master_data/CLAUDE.md` |
| Trusted-header identity (`x-user-email` spoofable; the single line that changes for SSO), Entra_Auth_Migration.md plan-of-record, first-run admin grace, `NIMBUS_API_KEY` stopgap, role_plants scoping | `server/security/CLAUDE.md` |
| `Store.selectedLines` aliased-Set mutate-in-place, `nimbus.state.v3` + `Config.SCHEMA_VERSION` gating, autosave-is-localStorage-only vs explicit `saveAll`, UndoStack snapshot-before-destructive rule, `Store.knownPlants()` vs KNOWN_PLANTS fallback | `web/platform/CLAUDE.md` (save semantics also in `web/scheduling/`) |
| `NIMBUS_BUILD_ID` single-source cache-bust, script load order (locales → compute-core → app-entry → app.js → intelligence), classic-script constraints (intelligence needs bare `NIMBUS`), i18n `data-i18n`/`t()` rule, Flatpickr standard, Report-Only CSP / inline-handler backlog | `web/shell/CLAUDE.md` (Flatpickr also referenced from calendar) |
| Ring buffer per-process/lost-on-restart, `x-request-id` threading + 1500ms slow-log, admin-route auto-audit, maintenance allowlists | `server/admin_ops/CLAUDE.md` |
| **Stays in root CLAUDE.md** (target ≤ ⅓ current size): project overview + a domain directory table (the new "where is X" map), running the app, build/lint/test commands, DB setup + pytest live-DB guard, deploy/promote-azure + cache-bust-verify, production scale roadmap, git conventions, DESIGN/PRODUCT pointers, doc-staleness warning, and a one-line pointer to the deferred db.py/master_data.py split in MIGRATION.md | root `CLAUDE.md` |

## 8. Phase plan — every phase ends green

Green = `npm run build && npm run lint && npm test && python -m pytest tests/ -q` (pytest only where the DB guard permits) + boot `uvicorn brain:api --port 8000` + load `/` with a hard-reload and bumped `NIMBUS_BUILD_ID` when frontend files moved. Each phase is a separate branch/PR off `main`; rollback = revert the merge.

**P-1 — Branch triage (gate; no code).** Four unmerged branches (checked 2026-08-31) touch exactly the files P2–P5 split: `db-changes` (9 ahead, last commit 2026-08-07), `master-data` (3, 2026-08-06), `minor-bug-fixes` (3, 2026-08-07) — all touch `brain.py`/`db.py`/`master_data.py` — and `feature/optimizer-reason-codes` (8, WIP 2026-08-18), which touches `schedule-services.mts`/`setup-scheduler.mts` **and adds new `web/schedule-diagnostics.mts` + `web/schedule-diagnostics-contract-check.mts` modules absent from §3.** Each branch must be landed, rebased, or explicitly abandoned before the phase that splits its files; after the splits they are effectively unmergeable. If `optimizer-reason-codes` lands, §3 gains `schedule-diagnostics*.{mts,mjs}` → `web/optimization/` and its tests join the P4 targets.

**P0 — Tooling unpinning (size S, risk low; no file moves).**
1. `scripts/legacy-surface.mjs`: recursive `.mjs` discovery (replace the non-recursive `readdirSync`), record `file` as web-relative path instead of bare basename; regenerate `tests/contracts/cq1-legacy-surface.json` once (expected diff: `file` values only — review must show zero surface change).
2. `package.json`: recursive discovery for `test:modules` (`node --test tests/modules/` or a `**/*.test.mjs` glob).
3. The `.md` static-serving block + checker allowance + 404 pin test (§6 enablers).
4. Optional flagged fix: derive `index.html:56`'s `styles.css?v=` from `NIMBUS_BUILD_ID` via the loader instead of a hand-duplicated literal.
Verify: full green + `npm run check:static-assets` + `npm run check:legacy-surface`.

**P1 — Folderize single-domain modules (M, low).** Create the 13 `web/<domain>/` folders. `git mv` (both twins each): `setup-domain` → `web/setup/`; `setup-scheduler` → `web/optimization/`; `master-data-grids` + `admin-tables` → `web/master-data/`; `application-foundation` → `web/platform/foundation.*`; `types` → `web/platform/`; `application-shell` → `web/shell/`; `order-field-catalog.{mjs,d.mts}` → `web/scheduling/`. Update every flat `./x.mjs` specifier repo-wide (mechanical grep-replace, **main tree only** — exclude `.worktrees/`), `app-entry.mjs` imports, `tests/modules` imports. tsconfig main include already recursive; `web/types/*` pins unchanged. Mega-modules stay at root untouched. Verify: full green + both check scripts + app hard-reload.

**P2 — Split `plant-and-administration.mts` (L, medium).** Extract 11 modules + the tab-resolver seam into the **9** target files (§3); old file becomes a barrel → repoint `app-entry`/importers → delete barrel (same phase). `__NIMBUS_PLANT_ADMIN` bridge keys identical. Hoist shared private helpers to `web/master-data/admin-shared.mts` only when ≥2 extracted files need them. Split/move `plant-and-administration.test.mjs` accordingly. Re-verify `setup-admin.mts` doesn't import `scheduling/*`.

**P3 — Split `schedule-workbench.mts` (L, medium).** Extract 18 modules into the **6** target files (§3). With P2, cycle 2 dissolves. Same barrel-then-delete mechanics; `__NIMBUS_WORKBENCH` keys identical. The coarse targets keep Timeline+Interaction (and Table+Inspector) co-located by design — no new seams get invented.

**P4 — Split `schedule-services.mts` + `schedule-data.mts` + `schedule-state.mts`; break cycle 1 (L, highest frontend risk).** Extract per §3 (services → 3 files + the `scheduler-contract.mts` leaf); move the 4-line `evaluateSchedule` adapter into `engine.mts` and `candidateDefaultWorkHours` into calendar-engine (§5 — re-verify both call-site lists first). Split `schedule-services.test.mjs` along the same lines; other test files repoint imports minimally. Hazard: Calendar↔Engine `_runCache` coupling — Calendar keeps its cache-accepting function signatures; Engine passes its cache in (already the call shape). `tests/js/compute-core.test.js` parity pins must stay green **untouched**.

**P5 — Backend `server/` route layer (L, mechanical but deploy-sensitive).** Create `server/` per §4: nine `routes.py` extractions from `brain.py` (paths byte-identical), `brain.py` → thin assembly with `include_router` + lifespan bootstrap order preserved verbatim, four whole-file `git mv`s (`setup_data`, `auth`, `admin_tables`, `sap_sync`), `cache.py` + `logbuffer.py` extractions with narrow accessors. `db.py`/`master_data.py` untouched. Update only the four moved modules' imports in tests; pyproject PLW0603 note (§4); Dockerfile comment. Deploy-sensitive: also run `docker build` locally and hit `/health` + `/` in the container before calling green. No schema, URL, or payload changes anywhere.

**P6 — CLAUDE.md network + doc reconciliation (M, no code risk).** Write the substantive domain CLAUDE.md files + 3-line pointers (§6 rule, §7 content); rewrite root CLAUDE.md to the repo-wide remainder + domain directory table; update `AGENTS.md` to match; mark `docs/architecture/cq1-compatibility-inventory.md` historical with a pointer (it already carries a phantom `UtilStrip` row, a retired `WelcomeSplash` row, and is missing 5 newer modules); update `docs/archive/typescript_migration.md`'s module table and path references and `docs/architecture/optimizer-dispatch.md`'s paths.

### Execution & delegation notes (v2)

- **Model assignment:** P0/P1 are largely mechanical (Haiku-capable with Sonnet verification of the legacy-surface regen and the specifier sweep); P2–P5 are Sonnet with a per-file extraction checklist (git mv twins → cut modules → fix imports → build → no orphan `.mjs` at old path); P6 pointer files are Haiku, substantive CLAUDE.md files Sonnet.
- **Parallelism:** within a phase, dispatch parallel subagents only on non-overlapping files. P2 and P3 must run **sequentially** (both edit `app-entry.mjs` and the bridge). P6 doc-writing parallelizes freely.
- **Sizing (agent wall-clock):** P0 ≈ 1h · P1 ≈ 1.5h · P2 ≈ 2.5h · P3 ≈ 2.5h · P4 ≈ 2.5h · P5 ≈ 2.5h · P6 ≈ 1.5h → **≈ 13–16h total** (vs ~30h at the original fine-grained + full-backend scope).
- **History:** whole-file `git mv`s preserve blame; content extractions (P2–P5) don't — `git log --follow` won't bridge them. Accepted cost; the phase-per-PR structure keeps each extraction reviewable.

## 9. Non-goals / do-not-touch

- **Zero behavior change**: no endpoint path/payload changes, no `window.NIMBUS` name changes, no exported-symbol renames.
- `app.js`, `nimbus-intelligence.js`, `nimbus-compute-core.js` remain classic scripts at `web/` root; no ESM conversion; worker `importScripts` path untouched; the `document.write` loader keeps its shape.
- The legacy-surface contract mechanism survives (P0 regenerates `file` fields only).
- `schema.sql`, `migrations/`, the migration ledger, and the promote-azure skill: untouched (only *which Python file holds* the moved `ensure_*` functions changes; DDL content is byte-identical).
- Tests are repair-scoped: move/split and repoint imports only — no new suites (the two small P0 additions — contract regen + the `.md` 404 pin — are the whole exception).
- No TS strictness changes; `generate:api-types` output path (`web/types/`) unchanged.
- Never edit `.worktrees/` / `.claude/worktrees/` copies; scope all search/replace to the main tree.
- `auth.py` internals untouched (Entra migration will rewrite them — §2b).
- Explicitly deferred (recorded in `docs/MIGRATION.md`): the `db.py`/`master_data.py` domain split (+ `server/core/` and the `priority_lists/fields.py` registry extraction); further intra-domain frontend splits beyond the coarse §3 targets; moving `nimbus-intelligence.js` into a domain; `styles.css` decomposition / per-domain CSS; migrating index.html's ~1,000 inline `<style>` lines.
