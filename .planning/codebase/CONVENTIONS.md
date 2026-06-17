# Coding Conventions

**Analysis Date:** 2026-06-17

## Naming Patterns

**Files:**
- Python backend: `snake_case.py` — `brain.py`, `db.py`, `master_data.py`
- JavaScript frontend: `kebab-case.js` — `app.js`, `nimbus-intelligence.js`, `nimbus-worker.js`
- Locales: `locales/{language}.js` (e.g., `locales/en.js`, `locales/de.js`)
- Utility modules: Named after their primary domain (e.g., `db.py` = all Postgres queries, `master_data.py` = plants/lines/materials DDL)

**Functions:**
- Python: `snake_case_function()`
  - Private/internal helpers: Prefix with `_` (e.g., `_cw_safe_name()`, `_log_event()`)
  - Async handlers: Named with intent (e.g., `async def request_id_mw()` for middleware, `async def upload_orders()`)
- JavaScript: `camelCaseFunction()`
  - Methods inside IIFE modules: `const ModuleName = { methodName() { } }`
  - Private/internal helpers: No formal prefix — use closure scope instead
  - Event handlers: Use inline arrow functions where convenient (e.g., `onChange: upd` in modal configs)

**Variables:**
- Python: `snake_case` across all scopes — `loaded_at`, `color_wheel_dir`, `pool_timeout_ms`
- JavaScript: `camelCase` — `loadedAt`, `colorWheelDir`, `poolTimeoutMs`
- Constants: UPPERCASE in both languages
  - Python: `COLOR_FILE`, `PG_POOL_MAX`, `DEFAULT_SHIFT`
  - JavaScript: `Config.STEP_MS`, `Config.DEFAULT_SHIFT`, `OVERLOAD_THRESHOLD`
- Single-letter loop vars are acceptable in tight, short loops: `for (let i = 0; i < n; i++)`
- Database column names (Postgres): `snake_case` in schema; returned as UPPERCASE in SELECT alias projections for frontend readability (e.g., `production_order AS "PRODUCTION_ORDER"`)

**Types:**
- Python: Type hints on function signatures using `|` for union (Python 3.10+); e.g., `start_date: str | None`
- JavaScript: JSDoc comments rare but used for complex modules. Inline object literal types via structure; e.g., `{ id, start, end }` in comments/docs

## Code Style

**Formatting:**
- Python: **ruff** formatter (check `LINT_REPORT_BACKEND.md` for active rules)
- JavaScript: **No autoformatter enforced** — code is hand-maintained; follows ES6 conventions
- **Indentation:** 2 spaces in JavaScript IIFE blocks; Python uses 4 spaces (PEP 8)

**Linting:**
- Python: **ruff** with rules as documented in `LINT_REPORT_BACKEND.md`
- JavaScript: **ESLint** configuration not enforced at commit time; linting was manual (see `LINT_REPORT_FRONTEND.md`)

**Line Length:**
- Soft limit 100–120 characters; hard breaks at ~120 in both languages
- Database queries wrapped for readability even if under limit

## Import Organization

**Python Order:**
1. Standard library (`import logging`, `import os`, `import json`)
2. Third-party packages (`import pandas`, `from fastapi import`, `from psycopg import`)
3. Local modules (`import db`, `import master_data as md`)
- Relative imports NOT used; modules are imported by name from project root

**JavaScript Order (top of file):**
- Global feature detection (e.g., cache-bust guard)
- IIFE wrapper opening (`const NIMBUS = (function () {`)
- Module declarations in order (each module is a const inside the IIFE)
- At bottom: `return { /* public API */ }`
- Inline DOM queries only inside render functions, never at module top-level

**JavaScript: Modules as IIFEs**
- All modules (except `nimbus-worker.js`, which is standalone) are declared inside a single `window.NIMBUS` namespace
- Load order is **critical**: each module can only reference modules declared earlier in the file
- Cross-module calls: `Store.method()`, `Calendar.method()`, etc. (not `NIMBUS.method()` — block-scoped)

**Path Aliases:**
- None formally configured; modules are imported by relative path or via CDN script tags
- Backend imports: `from db import query_orders` (pool is shared via `from db import _pool`)

## Error Handling

**Python Patterns:**

- **HTTP Errors:** FastAPI HTTPException, re-shaped by exception handler to `{"status": "error", "message": "...", "detail": "..."}` envelope
- **Validation:** ValueError raised with descriptive message; caught by `_value_error_handler()` → 400 response
- **Unhandled:** Caught by `_unhandled_handler()` → 500 JSON response; original traceback logged via `request_id_mw`
- **Database:** Exceptions from psycopg/pool bubble up and are logged; transaction rolled back on error in `update_task_dates_bulk()` via try/except around `conn.commit()`
- **File I/O:** Wrapped in try/except for color-wheel load operations; failures logged but don't crash startup (graceful degradation in `load_color_wheels()`)
- **Logging:** Structured JSON format via `_JsonFormatter` — one object per line to stdout; logger name, level, category, message, and exception info captured

**JavaScript Patterns:**

- **No global error handler** — individual modules handle their own errors
- **Network errors:** Caught by `fetchTraced()` → logged via `ErrorLog.error()`, toast to user, promise rejection bubbles
- **Date parsing:** `Util.parseDate()` returns `null` on invalid input; all date consumers check for null
- **Missing Store keys:** Defensive programming with optional chaining (e.g., `const cal = Store.calendars[line]?.workHours; if (!cal) return;`)
- **UI validation:** Modal inputs validated before write (e.g., check `end > start` in calendar/block editors)
- **Logging:** `ErrorLog.warn()`, `ErrorLog.error()`, `ErrorLog.info()` — logged to in-memory ring buffer and sent to backend via `/logs` POST for audit trail
- **Graceful fallbacks:** Optimizations missing a color? Use default. Worker fails to load? Run compute on main thread. Backend unreachable? Show cached data.

## Logging

**Framework:** 
- Python: `logging` stdlib with custom `_JsonFormatter` emitting JSON lines to stdout
- JavaScript: Homegrown `ErrorLog` module (ring buffer + UI badge + toast integration)

**Patterns:**
- **Python structured logs:** `_log_event(level, category, msg, **ctx)` appends to ring buffer AND logs via logger tree `nimbus.*`
- **Categories:** "startup", "request", "load", "event", "warn" — used for filtering/indexing in log pipelines
- **Request IDs:** UUID threaded through HTTP middleware, echoed in response header `x-request-id`, logged alongside every message so frontend and backend logs can be joined
- **JavaScript diagnostics:** `ErrorLog` is readable in Admin Cockpit "Thread" tab; includes category, timestamp, message
- **Performance traces:** `PerfMonitor` (JavaScript) records named operations and their durations in a ring buffer; exposed via `PerfMonitor.all()` for thread inspector

## Comments

**When to Comment:**
- Docstrings on functions explain purpose, params, return (Python/JavaScript)
- Comments explain WHY, not WHAT (code is self-explanatory)
- Non-obvious algorithms get inline comments (e.g., `VirtualList` binary search, `mergedOverlapHours` interval union)
- Database queries include inline notes (e.g., "server-side plant/line scoping" in `query_orders()`)
- Known workarounds/gotchas get /* GOTCHA: … */ marks

**JSDoc/TSDoc:**
- Used sparingly in JavaScript; prefer inline comments
- Public API functions document params/return; example: `/** Sum the hours of `intervals` … */` over `Util.mergedOverlapHours()`
- No @param/@returns style — just markdown + example code

**Example (Python docstring):**
```python
def update_task_dates_bulk(items: list[dict]) -> dict:
    """
    Persist a batch of start/end edits in a SINGLE transaction (one commit),
    replacing the old commit-per-row path. Each item: {id, start, end} where
    start/end are datetime|None.

    Optimistic concurrency: each item may carry `base_version` (the xmin the client
    last saw) and `force`.
    """
```

## Function Design

**Size:** 
- Short, focused functions — most are <50 lines
- Long functions break on logical boundaries (e.g., `load_color_wheels()` reads global + per-plant wheels in separate blocks, ~40 lines total)
- UI render functions may exceed 100 lines (e.g., `Calendar.render()`) because they build large HTML strings; these are refactored if logic becomes complex

**Parameters:**
- Python: Use named params for optional values; e.g., `def query_orders(plant: str | None = None, ...)`
- JavaScript: Objects for multiple params; e.g., `{ rowH, getRowH, renderFn, mountEl, buffer = 5 }`
- No trailing positional arguments without defaults

**Return Values:**
- Python: Single value or dict with named keys; e.g., `{"status": "ok", "deleted": 5}`
- JavaScript: Plain objects, sometimes wrapped in class instances (e.g., `VirtualList` instance)
- Always return something meaningful or `None`/`null`; no bare `return` statements

**Early Returns:**
- Guard clauses at function start to bail on null/invalid input
- `if (!date) return null;` patterns are common across date helpers

## Module Design

**Exports:**
- Python: All public functions are module-level; no class-based exports (no OOP beyond Pydantic models for validation)
- JavaScript IIFE modules: All state is closure-local; return an object at bottom with public methods/properties
- Examples:
  - `const Calendar = { workWindow, dailyCapacityHours, isAvailable, render, ... }`
  - `const Store = { ..., publish: (key) => { ... }, _rev: 0, ... }`

**Barrel Files:**
- Not used in this codebase — modules are imported by direct file reference

**Singleton Pattern:**
- `Store` is the canonical example: single mutable object holding all app state, accessed globally as `Store.property` or mutated via `Store.setState()`
- Connection pools (`db._pool`) are singletons initialized at module import
- `GLOBAL_CW` and `PLANT_CWS` are module-level color-wheel caches (mutated only by `load_color_wheels()` at startup or `/reload`)

## State Management

**Frontend (JavaScript):**
- **Single source of truth:** `Store` object in-memory; persisted to Postgres by `Persistence` module
- **Reactivity:** `Store.publish(key)` calls all subscribed modules' handlers (e.g., `Timeline`, `Table`, `Inspector` re-render when `Store.publish('tasks')` is called)
- **Undo/Redo:** `UndoStack` snapshots Store before destructive ops (bulk drag, optimization); 10-level limit
- **Sandboxing:** `Sandbox` wraps an isolated Store copy for what-if preview; changes not persisted unless "Apply" is clicked

**Backend (Python):**
- **Stateless:** No in-memory cache of orders — every `GET /tasks` queries Postgres
- **Color wheels:** Cached in `GLOBAL_CW` / `PLANT_CWS` at startup, refreshed by `POST /reload` (for multi-replica deployments)
- **Transactionality:** Multi-row updates via single `UPDATE` statement (one commit); single-row updates use autocommit

## Object Literals & Plain Data

**JavaScript:**
- Task objects: `{ id, PRODUCTION_LINE, MATERIAL_NUMBER, start_date, end_date, COLOR, FORM_SIZE, RUN_TIME, notes, ... }`
- Calendar objects: `{ workHours: [7, 19], lineSettings: { bufferPct, bufferUnit }, ... }`
- Blackout blocks: `{ id, plant?, line?, start, end, type? }`
- No getters/setters; plain property access

**Python:**
- Pydantic models for request/response validation (e.g., `TaskDateUpdate`, `TasksUpdatePayload`)
- DataFrames for bulk data (orders from Postgres, color wheels from Excel)
- Plain dicts for JSON serialization/deserialization

## Async/Threading

**Python:**
- FastAPI handlers are async (`async def`); I/O (DB, file) is synchronous but executed in a thread pool via `run_in_threadpool()`
- No explicit locks — Postgres row-level locking via `FOR UPDATE` handles concurrency
- Connection pooling is automatic (psycopg_pool)

**JavaScript:**
- **Main thread:** All DOM/UI code, Store mutations, event handling
- **Web Worker:** `nimbus-worker.js` handles Alerts and Utilization compute; communicates via `postMessage`
- **No explicit async/await for UI:** Callbacks and promises used for network I/O only
- **Debouncing:** Used for auto-recompute debouncing (e.g., `Alerts.scheduleRecompute()` with adaptive 80–500ms delay)

## Validation

**Python:**
- Pydantic models for request bodies (implicit validation + coercion)
- Manual checks for business rules (e.g., `if new_end <= new_start: raise ValueError(...)`)
- SQL parameterization via psycopg placeholders (`%s`) — never raw string interpolation
- SQL identifiers routed through `psycopg.sql.Identifier()` for DDL operations (master_data.py)

**JavaScript:**
- Date parsing via `Util.parseDate()` (returns null on invalid)
- Range checks: `if (end <= start) { Toast.error('...'); return; }`
- DOM attribute validation: `data-*` attributes are lowercase, values are escaped when inserted via `.innerHTML`
- No form validation framework — manual checks in modal show handlers

## Internationalization (i18n)

**Framework:** No i18n library; hand-rolled key-based translation system.

**Pattern:**
- `window.__NIMBUS_LOCALES = { en: {...}, de: {...}, ... }`
- Keys are dot-separated, e.g., `'toast.order_overridden'`, `'ui.cal_filter_line'`
- Translation lookup via `t(key, vars)` function, which merges English defaults
- Variable substitution: `t('toast.loaded_count', {count: 42})` → "Loaded {{count}} orders" → "Loaded 42 orders"
- Supported languages: en, de, es, fr, pt
- Locale stored in localStorage: `localStorage.getItem('nimbus.locale')`

---

*Convention analysis: 2026-06-17*
