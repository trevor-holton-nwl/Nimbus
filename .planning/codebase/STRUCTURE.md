# Codebase Structure

**Analysis Date:** 2026-06-17

## Directory Layout

```
nimbus/ (project root)
├── app.js                      # Frontend IIFE (32 sequential modules; ~15,096 lines)
├── index.html                  # HTML entry point; loads scripts in order (~2,408 lines)
├── styles.css                  # Design tokens + CSS Grid layout (~4,930 lines)
├── nimbus-intelligence.js      # Intelligence layer (extends window.NIMBUS; ~2,141 lines)
├── nimbus-worker.js            # Web Worker (off-thread compute; ~482 lines)
├── locales/                    # Localization (i18n translation maps)
│   ├── en.js                   # English strings
│   ├── de.js                   # German strings
│   ├── es.js                   # Spanish strings
│   ├── fr.js                   # French strings
│   └── pt.js                   # Portuguese strings
├── brain.py                    # Backend FastAPI entry point (~1,264 lines)
├── db.py                       # Data layer (Postgres queries, pool, ingest; ~1,025 lines)
├── master_data.py              # Safe DDL surface (column metadata, plants/lines CRUD; ~663 lines)
├── schema.sql                  # Postgres DDL (run once at setup; ~250 lines)
├── migration_perf.sql          # Performance index migrations
├── requirements.txt            # Python dependencies (fastapi, uvicorn, pandas, psycopg, etc.)
├── .env                        # Environment variables (not in git; copied at setup)
├── .gitignore                  # Git exclusions (includes .env, __pycache__)
├── CLAUDE.md                   # Project instructions (this file; read FIRST)
├── NIMBUS_VISION.md            # Long-term roadmap and design principles
├── MIGRATION.md                # Deployment + migration checklist
├── .claude/                    # Claude Code workspace config (not in git)
│   └── settings.json           # Workspace settings
└── .planning/
    └── codebase/               # GSD codebase map artifacts (not in git)
        ├── ARCHITECTURE.md     # Architecture + layers + data flow
        ├── STRUCTURE.md        # This file: directory layout + naming
        ├── CONVENTIONS.md      # Coding patterns + style (future)
        └── TESTING.md          # Test organization + patterns (future)
```

**Data directories (not in git, created at runtime):**
```
C:\Users\pj29587\OneDrive - Newell Brands\Documents\AI_ML Testing\Scheduler\
├── color_wheel.xlsx            # Global color wheel (loaded at startup)
└── color_wheels/               # Per-plant color-wheel uploads
    ├── color_wheel_5512.xlsx   # Plant 5512 color wheel
    ├── color_wheel_1006.xlsx   # Plant 1006 color wheel
    ├── _meta.json              # Upload metadata per plant
    └── _audit_log.json         # Append-only event log
```

## Directory Purposes

**Root (project root):**
- Purpose: Single-page app + stateless backend in one directory
- Contains: Frontend code (JS/CSS/HTML), backend code (Python), configuration (schema, env)
- Key files: `app.js` (frontend logic), `brain.py` (API routes), `db.py` (data layer)

**locales/:**
- Purpose: Localization (i18n)
- Contains: Translation string maps for en, de, es, fr, pt
- Structure: Each file exports a translation object (e.g., `locales.en = { "order_table": "Orders", ... }`)
- Usage: Loaded after `app.js` in `index.html`; strings referenced via `NIMBUS.locales.get("key")`

**.planning/codebase/:**
- Purpose: GSD codebase analysis artifacts
- Contains: Architecture, structure, conventions, testing patterns
- Generated: By `/gsd-map-codebase` skill
- Used by: `/gsd-plan-phase` and `/gsd-execute-phase` to understand codebase patterns
- Committed: No (generated artifacts)

## Key File Locations

**Entry Points:**

| File | Purpose | Role |
|------|---------|------|
| `index.html` | HTML entry point | Loads styles.css, app.js, nimbus-intelligence.js, locales, Web Worker |
| `app.js:13611–15096` | App bootstrap | PlantSelector (plant picker) → App.init() (load tasks + render UI) |
| `brain.py:139` | Backend ASGI app | FastAPI(lifespan=lifespan) with exception handlers + middleware |

**Configuration:**

| File | Purpose |
|------|---------|
| `schema.sql` | Postgres DDL; run once at DB setup |
| `requirements.txt` | Python dependencies for backend |
| `.env` | Environment variables (DB credentials, API base URL, etc.); not in git |
| `CLAUDE.md` | Project instructions (read first when onboarding) |

**Core Logic:**

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| Frontend state | `app.js:534–905` | 372 | Reactive pub/sub Store; single source of truth |
| Scheduling logic | `app.js:906–4517` | 3,612 | Calendar, Alerts, Utilization, Engine (optimization) |
| UI components | `app.js:5396–8750` | 3,355 | Timeline, Table, Inspector, Hierarchy, Dashboard, etc. |
| User input | `app.js:9244–10237` | 994 | Unified click/keyboard/drag event pipeline |
| Backend sync | `app.js:10238–11048` | 811 | Persistence (fetch, localStorage cache, autosave) |
| Backend API | `brain.py:439–1250` | 812 | ~30 FastAPI routes (tasks, master data, color wheels, uploads) |
| Data layer | `db.py:95–1025` | 931 | Postgres connection pool, parameterized queries, ingest, validation |
| Master data DDL | `master_data.py:63–663` | 600 | Safe column CRUD, cascade preview, schema metadata |

**Testing:**

| File | Purpose |
|------|---------|
| Not present | No automated test suite yet (see CONCERNS.md) |

## Naming Conventions

**Files:**

- **Frontend:** `app.js` (main), `nimbus-intelligence.js` (intelligence layer), `nimbus-worker.js` (Web Worker), `styles.css` (CSS), `index.html` (HTML entry)
- **Backend:** `brain.py` (FastAPI routes), `db.py` (Postgres layer), `master_data.py` (DDL surface), `schema.sql` (DDL)
- **Data:** `color_wheel.xlsx`, `color_wheel_<PLANT>.xlsx` (plant-specific wheels)
- **Configuration:** `.env` (env vars), `requirements.txt` (Python deps), `CLAUDE.md` (project docs)
- **Localization:** `locales/{en,de,es,fr,pt}.js` (i18n maps)

**Directories:**

- **locales/:** Lowercase, plural (convention for i18n directory names)
- **.planning/codebase/:** GSD artifact directory (created by /gsd-map-codebase)
- **color_wheels/:** Lowercase, plural (convention for data directories with many items)

**JavaScript (frontend):**

- **Module names:** PascalCase (Store, Engine, Calendar, Timeline, etc.) — each is an IIFE that attaches to `window.NIMBUS`
- **Constants:** SCREAMING_SNAKE_CASE (OVERLOAD_THRESHOLD, DEFAULT_SHIFT, STEP_MS, LS_KEY, etc.)
- **Functions:** camelCase (runAndApply, applyColorMerge, scheduleRecompute, etc.)
- **Variables:** camelCase (tasks, blocks, calendars, lineSettings, etc.)
- **DOM IDs:** kebab-case with module prefix (e.g., #timeline-container, #table-body, #inspector-panel)
- **CSS classes:** kebab-case (e.g., .task-row, .timeline-item, .modal-overlay)

**Python (backend):**

- **Module names:** lowercase (app, brain, db, master_data)
- **Functions:** snake_case (get_health_stats, apply_color_merge, update_task_dates_bulk, etc.)
- **Constants:** SCREAMING_SNAKE_CASE (OVERLOAD_THRESHOLD, COLOR_FILE, COLOR_WHEEL_DIR, etc.)
- **Classes:** PascalCase (if any; currently minimal class usage)
- **Variables:** snake_case (df, tasks, plants, color_merge_ms, etc.)

**Postgres (database):**

- **Tables:** lowercase, plural (orders, plants, production_lines, materials, material_plants, upload_audit, column_metadata, labor_plans, labor_plan_lines)
- **Columns:** lowercase, snake_case (production_order, material_number, scheduled_start, scheduled_end, basic_start_date, etc.)
- **Indexes:** idx_<table>_<columns> (e.g., idx_orders_line_eff_start, idx_lines_plant_only)
- **Constraints:** chk_<table>_<condition> (e.g., chk_orders_sched_range)

## Where to Add New Code

**New Feature (e.g., a new scheduling algorithm or KPI):**
1. **Backend route:** Add a new `@api.post()` or `@api.get()` in `brain.py` (around line 500–1200)
2. **Data layer:** If you need a new query, add it to `db.py` (around line 95–400)
3. **Frontend logic:** Add a new domain module in `app.js` before the UI modules (insert between line 4517 and 5396)
4. **Frontend UI:** If you need a new panel/view, add a UI module in `app.js` after line 5396, or extend an existing module (Timeline, Inspector, etc.)
5. **Test:** Write tests in a new `test_*.py` (backend) or `test_*.js` (frontend) file; see TESTING.md (not yet written) for patterns

**New Component/Module (e.g., a new sidebar panel, modal, overlay):**
- **Location:** Insert in `app.js` in the correct layer order (Foundation, State, Domain, Infrastructure, UI, Input, Data, Boot)
- **Naming:** `const ModuleName = { ... }` or `const ModuleName = (() => { ... })()` if complex
- **Subscription:** If the module renders based on Store state, add a `Store.subscribe(..., () => ModuleName.render())` call
- **Event handling:** If the module handles user input, route events through the Interaction module (do NOT attach event listeners directly unless there's a good reason)

**Shared Utilities:**
- **Frontend:** Add to the Util module (`app.js:94+`), e.g., `Util.parseDate()`, `Util.formatDuration()`, `Util.dayKey()`
- **Backend:** Add to `db.py` (helpers like `make_id()`, `clean()`, `_str_id()`) or create a new utility module if it's large

**Localization Strings:**
- Add keys to each file in `locales/{en,de,es,fr,pt}.js`
- Use in code via `NIMBUS.locales.get("key")` (or a wrapper function if one exists)

**Database schema changes:**
- **For new tables:** Add CREATE TABLE to `schema.sql` and a corresponding `master_data.ensure_*()` call in `brain.py:lifespan`
- **For new columns:** Add ALTER TABLE + migration to `schema.sql` (migrations should be idempotent with IF NOT EXISTS / IF EXISTS)
- **For indexes:** Add CREATE INDEX IF NOT EXISTS to `schema.sql`

**Color wheel files:**
- **Global:** Update `C:\Users\pj29587\...\Scheduler\color_wheel.xlsx` and restart the app, or `POST /reload`
- **Per-plant:** Upload via the Plant tab UI (saves to `color_wheels/color_wheel_<PLANT>.xlsx` and appends audit entry)

## Special Directories

**color_wheels/ (data directory):**
- Purpose: Stores per-plant color-wheel .xlsx files and metadata
- Generated: Yes (created by POST /color-wheel/{plant} or on first app startup)
- Committed: No (data directory; not in git)
- Ownership: Operator-managed (uploaded via UI)
- Migration note: These files are on-disk, not in Postgres. For multi-region deployment, move to a blob store or cloud storage (see MIGRATION.md).

**.planning/codebase/ (GSD artifacts):**
- Purpose: Codebase map documents (architecture, structure, conventions, testing)
- Generated: Yes (by `/gsd-map-codebase` skill)
- Committed: No (generated artifacts; not in git)
- Used by: `/gsd-plan-phase` (loads ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, TESTING.md to understand code patterns) and `/gsd-execute-phase` (references when writing code)

**locales/ (i18n data):**
- Purpose: Translation maps for en, de, es, fr, pt
- Generated: No (hand-authored)
- Committed: Yes (part of the app)
- Pattern: Each file is a JS object literal; loaded after app.js so it can extend the namespace

## Example: Adding a New Production Line Feature

Scenario: You want to add a "Preferred Sequence" feature where each line can specify a preferred order of colors (e.g., always do Red before Blue before Green).

**Steps:**

1. **Database schema** (`schema.sql`):
   ```sql
   ALTER TABLE production_lines ADD COLUMN IF NOT EXISTS preferred_sequence TEXT;
   ```

2. **Backend route** (`brain.py`, after line 1143):
   ```python
   @api.post("/production-line/{plant}/{line}/preferred-sequence")
   def set_preferred_sequence(plant: str, line: str, sequence: list = Body(...)):
       # Validate, persist to DB
       # Return success or error
   ```

3. **Data layer** (`db.py`):
   ```python
   def set_preferred_sequence(plant: str, line: str, sequence: list) -> None:
       with _pool.connection() as conn, conn.cursor() as cur:
           cur.execute(
               "UPDATE production_lines SET preferred_sequence = %s WHERE plant = %s AND production_line = %s",
               (json.dumps(sequence), plant, line)
           )
   ```

4. **Frontend domain logic** (`app.js`, between line 4517 and 5396, e.g., after Engine):
   ```javascript
   const PreferredSequence = {
     load: async (plant, line) => { /* fetch */ },
     save: async (plant, line, sequence) => { /* POST to backend */ },
     applyToDrag: (tasks, sequence) => { /* sort tasks by sequence */ },
   };
   ```

5. **Frontend UI** (`app.js`, in the ProdLines module or a new LineSettings modal):
   ```javascript
   // In ProdLines._render() or a new modal:
   // Show a drag-drop list of colors, save via PreferredSequence.save()
   ```

6. **Test** (new file `test_preferred_sequence.py` or integration test in `test_*.js`):
   ```python
   def test_set_preferred_sequence():
       # POST to /production-line/5512/LINE01/preferred-sequence
       # Assert it's persisted and returned on GET /master-data/production_lines
   ```

---

*Structure analysis: 2026-06-17*
