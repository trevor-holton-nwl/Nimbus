<!-- refreshed: 2026-06-17 -->
# Architecture

**Analysis Date:** 2026-06-17

## System Overview

NIMBUS is a production scheduling system with a stateless FastAPI backend and a vanilla-JavaScript frontend. Orders live in Postgres; the frontend is a single-page app with 32 sequential modules in `app.js`, plus an intelligence layer in `nimbus-intelligence.js` and an off-thread computation worker (`nimbus-worker.js`). All state is reactive via a centralized Store.

```text
┌──────────────────────────────────────────────────────────────────┐
│                     Frontend (Browser)                            │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ PlantSelector (boot) → App (tab switching)                 │  │
│  │ index.html (load order: app.js → styles.css → locales)    │  │
│  └────────────────────────────────────────────────────────────┘  │
│                            │                                      │
│     ┌──────────────────────┼──────────────────────┐              │
│     │                      │                      │              │
│  ┌──▼─────────────┐  ┌────▼──────────────┐  ┌────▼────────────┐ │
│  │ Scheduling     │  │ Master Data UI    │  │ Admin           │ │
│  │ (Gantt view)   │  │ (Plant/Lines)     │  │ (Upload/Config) │ │
│  │ - Timeline     │  │ - Plant           │  │ - AdminCockpit  │ │
│  │ - Table        │  │ - ProdLines       │  │ - Printer       │ │
│  │ - Hierarchy    │  │ - LaborPlanning   │  │ - MasterData    │ │
│  │ - Inspector    │  │ - EditCalendar    │  │                 │ │
│  │ - Dashboard    │  │ - ColorWheelView  │  │                 │ │
│  │ - Interaction  │  │                   │  │                 │ │
│  └──┬─────────────┘  └───────────────────┘  └────────────────┘ │
│     │                                                             │
│  ┌──▼──────────────────────────────────────────────────────────┐│
│  │ CORE LAYERS (all within window.NIMBUS namespace)            ││
│  │                                                              ││
│  │  ┌─ Domain Business Logic ──────────────────────────────┐  ││
│  │  │ • Engine (SPT/changeover/combined optimization)      │  ││
│  │  │ • Alerts (overlap/overload/blackout/fixed-violation) │  ││
│  │  │ • Utilization (per-line-day scheduled vs. available) │  ││
│  │  │ • Calendar (working hours + blackout blocks)         │  ││
│  │  └──────────────────────────────────────────────────────┘  ││
│  │                                                              ││
│  │  ┌─ Reactive State ─────────────────────────────────────┐  ││
│  │  │ • Store (pub/sub; single source of truth)            │  ││
│  │  │   - tasks[], blocks, calendars, lineSettings, plants │  ││
│  │  │   - Store.publish() on every mutation                │  ││
│  │  └──────────────────────────────────────────────────────┘  ││
│  │                                                              ││
│  │  ┌─ Foundation ──────────────────────────────────────────┐  ││
│  │  │ • Config (constants, KNOWN_PLANTS, thresholds)       │  ││
│  │  │ • Util (date/time/duration pure helpers, no state)   │  ││
│  │  └──────────────────────────────────────────────────────┘  ││
│  └────────────────────────────────────────────────────────────┘│
│                                                                 │
│  Off-thread compute (isolated, zero DOM)                       │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ nimbus-worker.js (Web Worker)                            │ │
│  │ • Alerts compute (serialized Store → alerts[])           │ │
│  │ • Utilization matrix compute (tasks → matrix)            │ │
│  │ • Fallback: sync main-thread if worker fails             │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                 │
│  Intelligence layer (load: after app.js)                       │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ nimbus-intelligence.js                                   │ │
│  │ • CommandPalette (Cmd+K fuzzy search)                    │ │
│  │ • TimeMachine (IndexedDB history scrubber)               │ │
│  │ • Confidence (schedule health score)                     │ │
│  │ • RipplePreview (downstream-shift preview)               │ │
│  │ • Diff (snapshot diff viewer)                            │ │
│  │ • Patterns (sequence-pair learning)                      │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                             │
                    HTTP (x-request-id)
                             │
┌──────────────────────────────────────────────────────────────────┐
│                      Backend (FastAPI)                            │
│                      brain.py (~1,260 lines)                      │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Request Middleware                                         │  │
│  │ • Exception handling (ValueError, HTTPException, Exception)│  │
│  │ • Request-ID threading (x-request-id header)              │  │
│  │ • CORS middleware (allow origins *)                        │  │
│  │ • Slow request logging (>1500ms warn threshold)            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                            │                                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ API Routes (~30 endpoints)                                 │  │
│  │                                                            │  │
│  │ TASKS WRITE:                                               │  │
│  │ • POST /task/update        — single-task update           │  │
│  │ • POST /tasks/update       — bulk update (autosave path)  │  │
│  │ • POST /tasks/bulk_update  — flat-list alias             │  │
│  │ • POST /task/note          — add user notes               │  │
│  │                                                            │  │
│  │ TASKS READ:                                                │  │
│  │ • GET /tasks?plant=…&line=… — server-scoped stateless read│  │
│  │ • POST /tasks/refresh       — refresh trigger (no-op)    │  │
│  │                                                            │  │
│  │ MASTER DATA:                                               │  │
│  │ • GET /master-data/{table}  — plants/lines/subnetworks   │  │
│  │ • POST /master-data/{table}/bulk — batch CRUD            │  │
│  │ • POST /master-data/plants/{plant}/constraints — settings │  │
│  │ • GET  /labor-plan          — labor plans (read)          │  │
│  │ • POST /labor-plan          — labor plans (write)         │  │
│  │ • GET  /labor-plan/line     — per-line labor plan        │  │
│  │ • POST /labor-plan/line     — per-line labor plan (write) │  │
│  │                                                            │  │
│  │ COLOR WHEELS:                                              │  │
│  │ • POST /color-wheel/{plant} — upload per-plant wheel     │  │
│  │ • GET  /color-wheel/{plant} — fetch per-plant wheel      │  │
│  │ • DELETE /color-wheel/{plant} — delete per-plant wheel   │  │
│  │ • GET  /color-wheels        — list all wheels            │  │
│  │ • POST /reload              — refresh color cache        │  │
│  │                                                            │  │
│  │ UPLOAD & AUDIT:                                            │  │
│  │ • POST /upload              — ingest .xlsx to Postgres    │  │
│  │ • POST /purge               — delete orders by date range │  │
│  │ • GET  /upload/audit        — upload history              │  │
│  │ • POST /upload/audit/clear  — clear audit log             │  │
│  │ • GET  /audit/log           — event audit (color wheels)  │  │
│  │ • POST /audit/log           — append audit entry          │  │
│  │ • POST /audit/log/clear     — clear event log             │  │
│  │                                                            │  │
│  │ DIAGNOSTICS & HEALTH:                                      │  │
│  │ • GET  /diagnostics         — metadata + live DB counts   │  │
│  │ • GET  /diagnostics/deep    — full pipeline breakdown     │  │
│  │ • GET  /diagnostics/db      — DB stats + row counts       │  │
│  │ • GET  /health              — DB ping + system snapshot   │  │
│  │ • POST /maintenance/vacuum-analyze — compact DB           │  │
│  │ • POST /maintenance/analyze — refresh DB stats            │  │
│  │                                                            │  │
│  │ MASTER DATA SCHEMA:                                        │  │
│  │ • POST /master-data/{table}/columns — add column          │  │
│  │ • DELETE /master-data/{table}/columns/{col} — drop column │  │
│  │ • PATCH /master-data/{table}/columns/{col} — modify       │  │
│  │ • GET  /master-data/_audit — column modification log      │  │
│  │ • POST /master-data/{table}/cascade-preview — delete check│  │
│  └────────────────────────────────────────────────────────────┘  │
│                            │                                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Data Layer                                                 │  │
│  │                                                            │  │
│  │ • db.py (~1,025 lines) — Postgres connection pool,        │  │
│  │   parameterized queries, MD5-stable task IDs              │  │
│  │                                                            │  │
│  │ • master_data.py (~665 lines) — safe DDL surface,         │  │
│  │   psycopg.sql.Identifier escaping, column metadata        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                            │                                      │
│  Color-wheel cache (in-process, refreshed on POST /reload)      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ GLOBAL_CW (global color order)                             │  │
│  │ PLANT_CWS (per-plant overrides)                            │  │
│  │ CW_LOADED_AT (refresh timestamp)                           │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                             │
                    Postgres (pooled connections)
                             │
┌──────────────────────────────────────────────────────────────────┐
│                      PostgreSQL Database                          │
│                                                                    │
│  • orders (MD5-indexed, scoped by production_line)               │
│  • production_lines + plants + subnetworks (hierarchy)            │
│  • materials + material_plants (master data)                      │
│  • upload_audit (ingest history)                                 │
│  • column_metadata (schema extension registry)                    │
│  • labor_plans + labor_plan_lines (capacity planning)             │
│  • _alert_config (plant-specific optimization constraints)       │
└──────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| **Store** | Reactive pub/sub state; single source of truth; all mutations publish | `app.js:534` |
| **Calendar** | Working hours + blackout-block availability; visual enforcement on drag | `app.js:906` |
| **Alerts** | Overlap/overload/blackout/fixed-violation detection; debounced compute | `app.js:4518` |
| **Utilization** | Per-line-day scheduled vs. available hours; memoized matrix | `app.js:4164` |
| **Engine** | SPT/changeover/combined optimization; auto-reflow; greedy dispatcher | `app.js:4369` |
| **Timeline** | vis-timeline Gantt integration; drag/drop; diff rebuild on mutation | `app.js:5396` |
| **Table** | AG Grid orders table; inline edit; bulk selection; keyboard nav | `app.js:5979` |
| **Interaction** | Unified click/dblclick/keyboard/drag pipeline; owns all input events | `app.js:9244` |
| **Persistence** | Backend fetch; localStorage cache (nimbus.state.v3); debounced autosave | `app.js:10238` |
| **UndoStack** | 10-level undo for destructive operations (drag, bulk update) | `app.js:8747` |
| **Sandbox** | Sandboxed simulation; isolated Store copy for what-if preview | `app.js:9137` |
| **db.py** | Connection pool, parameterized queries, order ingest, batch upsertion | `/db.py` |
| **master_data.py** | Safe DDL surface; psycopg.sql.Identifier escaping; column registry | `/master_data.py` |
| **brain.py** | FastAPI routes, color-wheel cache, structured logging, request-ID threading | `/brain.py` |
| **nimbus-worker.js** | Off-thread Alerts/Utilization compute; serialized Store snapshot protocol | `/nimbus-worker.js` |

## Pattern Overview

**Overall:** Single-page app with stateless backend. All state lives in the browser's Store; Postgres owns persistent order scheduling data; every request queries fresh from DB with plant/line scoping so multiple replicas see concurrent edits immediately.

**Key Characteristics:**
- **Reactive UI:** Store.publish() triggers subscribed modules (Timeline, Table, Inspector, etc.) to re-render. A single mutation cascades to all views.
- **Stateless backend:** Orders are never cached in-process. GET /tasks always queries the DB with server-side plant/line filters.
- **Deterministic task IDs:** MD5 hashes of `"{PRODUCTION_ORDER}|{MATERIAL_NUMBER}"` computed in `db.make_id()`. IDs are stable across reloads and reschedules — the frontend relies on this for drag/edit keying.
- **Optimistic locking:** Task updates include `ROW_VERSION` (Postgres xmin) to detect concurrent edits. Write rejected if the row was modified between read and write (`db.update_task_dates_bulk()` checks xmin equality).
- **Off-thread compute:** Alerts and Utilization run in a Web Worker (`nimbus-worker.js`). Payload is a scoped Store snapshot (plant/line filtered to reduce structured-clone cost). Synchronous fallback if the worker fails.

## Layers

**Foundation (bottom — no state, pure):**
- Location: `app.js:68–466` (Config, Util)
- Purpose: Constants (STEP_MS, DEFAULT_SHIFT, color palette), date/time/duration helpers, threshold configs
- Depends on: Nothing
- Used by: Every module above

**State (reactive pub/sub):**
- Location: `app.js:534–905` (Store)
- Purpose: Centralized state holder; triggers `Store.publish()` on every mutation so UI modules can subscribe and re-render
- Structure: `tasks`, `blocks`, `calendars`, `lineSettings`, `plants`, `masterData`, `dismissed`
- Depends on: Foundation (Config, Util)
- Used by: All domain logic, all UI modules

**Domain (business logic):**
- Location: `app.js:906–4517` (Calendar, Plant, ProdLines, LaborPlanning, Alerts, Utilization, Engine)
- Purpose: Order scheduling logic (drag/edit validation), color wheel management, optimization (SPT/changeover), conflict/overload detection, utilization calculation
- Depends on: Store, Calendar (for date availability), Config/Util
- Used by: Interaction, Persistence, UI modules

**Infrastructure (cross-cutting concerns):**
- Location: `app.js:3414–5300` (Compute, ErrorLog, Toast, Modal)
- Purpose: Error logging + UI notifications, off-thread worker dispatch, generic modal/toast UI
- Depends on: Foundation, Store
- Used by: Everything

**UI Components:**
- **Master Data UI** (`app.js:1341–3247`) — Plant, ProdLines, LaborPlanning, EditCalendar, ColorWheelViewer; manage plant/line hierarchies, labor plans, color wheels
- **Scheduling UI** (`app.js:5396–8636`) — Timeline (Gantt), Table (AG Grid), Inspector (detail panel), Hierarchy (left sidebar), Dashboard (KPIs + charts), TimelineNav (minimap), GanttFilter (filter bar), DependencyOverlay (finish-to-start arrows), ContextMenu, Selection (multi-select)
- Location: `app.js:5396–8750`
- Depend on: Store (subscribed to mutations), Interaction (for input routing)
- Render on: Store.publish()

**Input (unified event routing):**
- Location: `app.js:9244–10237`
- Interaction module owns ALL vis-timeline and DOM click/keyboard/drag events. Calls Engine, mutates Store. UI modules never handle input directly — they only subscribe to Store changes.
- Depends on: Store, Engine, Calendar, UndoStack

**Data (backend sync):**
- Location: `app.js:10238–11048`
- Persistence owns all fetch() calls and localStorage caching. Debounced 1,200 ms autosave fires on every Store mutation affecting task dates.
- Depends on: Store, ErrorLog, Toast
- Used by: App bootstrap, Inspector (manual saves)

**Boot (app entry point):**
- Location: `app.js:13611–15096` (App, PlantSelector, WelcomeSplash, MasterData, EmptyState, Printer, AdminCockpit)
- Purpose: Plant picker, tab switching, upload/data management, print/export
- Depends on: All layers above

## Data Flow

### Primary Request Path (User Drag → Optimistic UI Update → Persist to DB)

1. **User drag or edit** (`Interaction.onDragEnd()` or cell edit, `app.js:9244+`) — calls `Engine.autoReflow()` if needed to eliminate overlap on the line
2. **Mutate Store** — `Store.tasks.push(modified)` or update existing; calls `Store.publish()` (`app.js:534`)
3. **All subscribed modules re-render** — Timeline (Gantt), Table (grid), Inspector (detail), Hierarchy (sidebar) receive Store change notification and repaint
4. **Debounced autosave** — Persistence (`app.js:10238`) batches the change and fires `POST /tasks/update` after 1,200 ms
5. **Optimistic locking check** — `db.update_task_dates_bulk()` verifies ROW_VERSION (xmin) hasn't changed since read; if it has, write rejected, frontend is notified
6. **Postgres transaction** — task dates persisted atomically; all other replicas see it on next /tasks query

### Alerts Compute Path (Store Mutation → Off-thread Recompute → Merge Result)

1. **Any task date/block change** triggers `Alerts.scheduleRecompute(opts)` (`app.js:4518`)
2. **Debounced dispatch** (adaptive 90–500 ms based on measured compute cost) posts Store snapshot to Web Worker (`Compute.dispatch()`)
3. **Worker computes** (alerts.js logic runs in `nimbus-worker.js:98+`) — checks overlap, overload, blackout violations
4. **Result posted back** — `{ type:'ALERTS_RESULT', id, alerts, elapsed }`
5. **Merge into Store** — `Store.alerts = merged_result`; triggers `Store.publish()`
6. **UI re-renders** — Hierarchy, Timeline (background items), Inspector reflect new alerts

**Fallback:** If worker fails or times out, `Compute.sync()` runs the same logic synchronously on the main thread.

### Master Data Upload Path (File → Excel Parse → Upsert to Postgres)

1. **User uploads .xlsx** via AdminCockpit `POST /upload`
2. **brain.py:820** calls `db.ingest_orders_from_excel()` (`db.py`)
   - Reads Excel sheet (expected columns: PRODUCTION_ORDER, MATERIAL_NUMBER, PRODUCTION_LINE, BASIC_START_DATE, BASIC_FINISH_DATE, RUN_TIME, COLOR, FORM_SIZE, ORDER_QUANTITY, NOTES, etc.)
   - Computes stable task IDs via `make_id()` (MD5 of "{PRODUCTION_ORDER}|{MATERIAL_NUMBER}")
   - **Upsert** (ON CONFLICT id DO UPDATE): inserts new rows, updates existing rows' basic_* columns, preserves user-scheduled_* columns
   - Returns counts (inserted, updated, warnings)
3. **Color wheel applied** — `apply_color_merge()` maps each order's COLOR to ORDER_Y priority (from GLOBAL_CW or per-plant wheels)
4. **Audit entry logged** — `upload_audit` table records filename, row counts, timestamp, any parsing warnings
5. **Frontend re-fetches** — Persistence `GET /tasks?plant=...` queries fresh, Store updates, UI re-renders

### Color Wheel Lifecycle

1. **Startup** — `brain.py:lifespan` calls `load_color_wheels(COLOR_FILE)` → populates GLOBAL_CW from global file + PLANT_CWS from per-plant files
2. **Per-plant upload** — User uploads color_wheel_<PLANT>.xlsx via Plant tab → `brain.py:888` saves to `COLOR_WHEEL_DIR/color_wheel_<PLANT>.xlsx`
3. **POST /reload** — `brain.py:518` re-reads all color-wheel files into GLOBAL_CW / PLANT_CWS (in-process cache only; does NOT touch orders)
4. **On every /tasks query** — `apply_color_merge()` maps colors using the cached wheels

**State Management:**
- Postgres orders table: source of truth for task dates and basic SAP data
- Frontend Store: source of truth for current UI state, selections, filters
- In-process color-wheel cache (GLOBAL_CW / PLANT_CWS): hot data for color priority mapping
- localStorage (nimbus.state.v3): browser-side snapshot for offline read + faster boot (Persistence._loadCache)

## Key Abstractions

**Task:**
- Purpose: Represents a production order with immutable SAP data (basic_* dates) and user overrides (scheduled_* dates)
- Examples: `{ id, PRODUCTION_ORDER, MATERIAL_NUMBER, PRODUCTION_LINE, PLANT, BASIC_START_DATE, BASIC_FINISH_DATE, RUN_TIME, COLOR, ORDER_Y, ROW_VERSION, ... }`
- Pattern: Immutable records; mutations create new objects; Store holds the array reference
- File paths: Defined in `db.py:101–127` (database projection), serialized/deserialized in `brain.py:420+` (color merge), validated in `db.py:300+` (update path)

**Block (calendar blackout):**
- Purpose: Time range when a production line is unavailable (maintenance, setup, manual block-out)
- Structure: `{ id, lineKey, title, startDate, endDate, isFixed, notes }`
- Pattern: Stored in Store.blocks; keyed by (lineKey, id); created/deleted via `Store.addBlock()` / `Store.removeBlock()`
- File paths: `app.js:534` (Store), `app.js:906` (Calendar enforcement), `app.js:5979+` (Table UI)

**PlantBlock (plant-wide calendar blackout):**
- Purpose: Plant-level blackout (shutdown, holiday); overrides line-level calendars
- Pattern: Stored separately in Store.plantBlocks; keyed by (plantKey, id)
- File paths: `app.js:1341` (Plant tab UI), `app.js:534` (Store)

**LineSettings:**
- Purpose: Per-line runtime configuration (shift hours, location, plant assignment, etc.)
- Structure: `{ line: { shift: [startHour, endHour], plant, ... } }`
- Pattern: Keyed by production_line string; merged from DB (master_data.lines) + user overrides
- File paths: `app.js:534` (Store), `app.js:1855` (ProdLines tab), `nimbus-worker.js:98` (Worker mirror)

**Color Wheel:**
- Purpose: Maps COLOR (string) → ORDER_Y (priority number) for sequencing same-color orders together (changeover grouping)
- Structure: `{ COLOR: ORDER_Y }` (CSV-like Excel table with two columns)
- Pattern: Loaded from file at startup + per-plant overrides; applied per-request in `apply_color_merge()` (brain.py:356)
- File paths: `brain.py:86–108` (paths + cache), `brain.py:317–354` (load logic), `brain.py:356–421` (apply)

**Optimization Mode (SPT / Changeover / Combined):**
- Purpose: Dispatching heuristic names (not true optimization — no changeover-cost matrix, no finite-capacity constraints)
- Patterns:
  - SPT: sort by RUN_TIME ascending; place back-to-back (greedy)
  - Changeover: group by COLOR → FORM_SIZE → MATERIAL_NUMBER; within each group apply SPT; place back-to-back
  - Combined: apply Changeover grouping, but within each group apply SPT (newest dispatcher; distinct from Changeover)
- File paths: `app.js:4369+` (Engine.runAndApply), `app.js:4670+` (OptimizeDialog)

## Entry Points

**Frontend:**
- **index.html** — Entry point; loads styles.css, then app.js (in IIFE), then nimbus-intelligence.js, then locales
- **app.js (top of IIFE)** — Calls PlantSelector or WelcomeSplash; waits for user to pick plant, then boots App
- **App.init()** — Loads initial /tasks from backend, populates Store, renders UI (Timeline, Table, Hierarchy, Dashboard)
- Location: `index.html:1–46` (script load order), `app.js:13611` (App entry), `app.js:13288` (PlantSelector)

**Backend:**
- **brain.py:api = FastAPI(lifespan=lifespan)** — ASGI app; routes all requests
- **lifespan()** — Startup: load color wheels, verify DB connection. Shutdown: log message.
- **@api.get("/tasks")** — Primary read path; called on every plant/line change + autosave refresh
- Location: `brain.py:139–138` (app creation), `brain.py:113–137` (lifespan), `brain.py:557–717` (GET /tasks)

**Web Worker:**
- **nimbus-worker.js:onmessage()** — Entry point; receives `{ type:'ALERTS' | 'UTILIZATION', payload, ... }`
- Computes and posts result back `{ type:'ALERTS_RESULT' | 'UTILIZATION_RESULT', ... }`
- Location: `nimbus-worker.js:1–50` (message handler)

**Localization:**
- **locales/{en,de,es,fr,pt}.js** — Loaded after app.js. Extend window.NIMBUS with translation maps.
- Location: `locales/*.js:1+` (each file)

## Architectural Constraints

- **Threading:** Single-threaded event loop on frontend; Web Worker offloads Alerts/Utilization compute to a second thread. Main thread holds the Store and drives UI re-renders.
- **Global state:** Module-level singletons (Store, Engine, Calendar, etc.) attached to `window.NIMBUS`. No functional reactive framework — manual pub/sub via `Store.publish()`.
- **Circular imports:** None enforced; the IIFE module load order in app.js is explicit (Config → Util → Store → domain → UI). No dynamic requires.
- **Color-wheel cache:** In-process on backend (brain.py:90–92). Refreshed by POST /reload only; does NOT refresh on every /tasks query. This is intentional — the cache is re-read per-request in apply_color_merge() from the module-level dict.
- **Postgres connection pooling:** psycopg3 async pool; min=2 (warm connections for stateless reads), max=20, timeout=10s, statement_timeout=30s. Configurable via env vars (NIMBUS_PG_POOL_MIN, etc.).
- **Form Date Inputs:** All date/time inputs MUST use Flatpickr (never native `<input type="date">`). See CLAUDE.md "Date / Time Inputs — Flatpickr Standard" for the config patterns per input type.
- **Plant + Line Scoping:** By CLAUDE.md design constraint, the app must scale to 50+ plants × 70+ lines = 3,500 total lines. APIs that return plant or line lists MUST support server-side filtering/pagination. Bubble/chip selectors are forbidden; use searchable dropdowns (comboboxes) instead.
- **xmin (optimistic locking):** Postgres xmin is a system column (transaction ID) that increments on every UPDATE to a row. `db.update_task_dates_bulk()` reads xmin as ROW_VERSION and checks equality on write to detect concurrent edits.

## Anti-Patterns

### Module Load Order Dependency (not truly anti-pattern, but fragile)

**What happens:** app.js is a single IIFE with 32 sequential module declarations. Each module can only reference modules declared above it in the file. If you move a module declaration down, it breaks all references to it from earlier modules.

**Why it's wrong:** It's a foot-gun for refactoring. No explicit dependency declaration; just implicit load-order coupling. Moving a 200-line module 50 lines down could silently break 5 other modules.

**Do this instead:** Keep the documented module load order (listed in comments at the top of app.js:1–34). If you add a new module, insert it in the correct layer (Foundation → State → Domain → Infrastructure → UI → Input → Data → Boot) and re-test all modules that depend on it. Consider a future refactor to named exports + import, but that would require a build step — currently there is none.

### Mutable Store (reactive but not immutable)

**What happens:** Store.tasks is an array; mutations like `Store.tasks[0].BASIC_START_DATE = newDate` modify in-place. UndoStack has to snapshot the entire Store before a destructive operation.

**Why it's wrong:** In-place mutation makes it harder to reason about what changed. Time-travel debugging (TimeMachine in nimbus-intelligence.js) requires serializing the entire Store every time you want to snapshot history.

**Do this instead:** For new large features, consider creating immutable reducer-style modules (e.g., `Store.applyUpdate(mutation) → newState`). But for now, the codebase uses mutable arrays + manual publish(). Keep mutations localized to the module that owns them (e.g., only Interaction calls `Store.tasks[i] = { ...task, BASIC_START_DATE }`).

### File-Based Color Wheels

**What happens:** Color wheels are loaded from .xlsx files on disk (global + per-plant). They are not in the database. This means:
- They are not transactional with order data (color wheel upload and order upload are separate operations).
- The sync path between global color_wheel.xlsx and per-plant color_wheel_<PLANT>.xlsx is manual (POST /reload).
- In a multi-region deployment, color wheels would need to be synced separately or moved to a shared blob store.

**Why it's wrong:** It creates a two-source-of-truth problem: orders in Postgres, colors on disk. For enterprise scale (50+ plants), this becomes an operational nightmare.

**Do this instead:** Migrate color wheels to a Postgres table (color_wheels: plant, color, order_y) before multi-region / multi-tenant deployment. See MIGRATION.md for the planned path. Until then, treat color wheels as operator-managed master data separate from the order feed.

### No Finite-Capacity Constraint in Optimization

**What happens:** Engine.runAndApply() dispatches orders greedily — it sorts by SPT or changeover grouping, then places each order back-to-back without checking total line capacity. A production line could be scheduled for 200 hours of work in a 5-day window (120 hours available) with no error.

**Why it's wrong:** It's not real optimization. It's a heuristic sorter that respects precedence and blackouts but ignores resource constraints.

**Do this instead:** If load-balancing across lines becomes critical, add a finite-capacity solver (or constraint-satisfaction library) that takes into account total hours available per line per shift. For now, the UI alerts users to overload (Utilization > 100%), but the optimizer doesn't prevent it.

## Error Handling

**Strategy:** Structured JSON logging on backend; ErrorLog panel on frontend.

**Patterns:**
- **Backend errors:** Caught by FastAPI exception handlers (ValueError → 400, HTTPException → status code, other Exception → 500). All error responses use a consistent envelope: `{ status: "error", message, detail }`
- **Frontend errors:** Toast notifications for user-facing messages (saving failed, etc.). ErrorLog module maintains a ring buffer of backend + frontend errors with timestamps and request IDs for support debugging.
- **Network errors:** Persistence retries POST /tasks/update on failure (exponential backoff; shows toast on user interaction). GET /tasks failures are fatal (user is prompted to reload).
- **Concurrency errors:** db.update_task_dates_bulk() checks ROW_VERSION (xmin) equality; if a concurrent edit is detected, the write is rejected. Frontend is notified via a 409 status code + message; user is prompted to reload to see the latest version.

## Cross-Cutting Concerns

**Logging:** Structured JSON logs on backend (nimbus logger tree, one JSON object per line). Request-ID middleware threads an x-request-id through every request so frontend ErrorLog entries can be joined to backend logs for support.

**Validation:** 
- Backend: db.update_task_dates_bulk() rejects inverted date ranges (end ≤ start). Excel ingest validates required columns (PRODUCTION_ORDER, MATERIAL_NUMBER, BASIC_START_DATE, BASIC_FINISH_DATE).
- Frontend: Interaction module prevents drags that would create inverted ranges or violate blackout blocks (snap to next valid slot instead).
- Database: Postgres CHECK constraint (chk_orders_sched_range) enforces scheduled_end > scheduled_start at the DB layer.

**Authentication:** Not implemented. CLAUDE.md does not mention auth; the app assumes all users are trusted. For enterprise deployment, add FastAPI security (JWT / OAuth2) and frontend middleware to bounce unauthenticated users to a login page.

**Plant Scoping:** Every API call that returns tasks or master data should include `?plant=…` to filter server-side. The frontend enforces this via the PlantSelector — you cannot view tasks without picking a plant first.

---

*Architecture analysis: 2026-06-17*
