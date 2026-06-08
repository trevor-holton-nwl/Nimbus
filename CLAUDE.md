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

**Backend:**
```bash
pip install fastapi uvicorn pandas numpy openpyxl "psycopg[binary]" psycopg_pool pydantic
python brain.py
# Runs on http://localhost:8000
```

For backend iteration with auto-reload (since `python brain.py` does not reload on source changes):
```bash
uvicorn brain:api --reload --port 8000
```
Orders are loaded from **Postgres** (see `db.py`) once at startup via FastAPI's `lifespan` context manager into the in-memory `DATA` DataFrame; use `POST /reload` to re-query the DB without restarting. A local Postgres instance must be running — connection settings are in `db.py`.

**Frontend:** Serve `index.html` over HTTP (cannot open as `file://` due to CORS). Any static file server works:
```bash
python -m http.server 9000
# Then open http://localhost:9000
```

No build step — JavaScript and CSS are loaded directly; all libraries come from CDN.

## Data Sources

**Orders live in Postgres**, not Excel. `db.py` owns all connection management and queries; `brain.py` calls `db.load_orders_df()` at startup and on `POST /reload`, and user reschedules are persisted back to the `orders` table (`scheduled_start` / `scheduled_end`). Excel is no longer the source of truth for the schedule.

- **Order ingest** — `POST /upload` accepts a `sequence_testing`-shaped `.xlsx` and upserts rows into the `orders` table (`db.ingest_orders_from_excel`).
- **Color wheels** — still file-based: a global `color_wheel.xlsx` (`COLOR_FILE` constant in `brain.py`) plus per-plant `color_wheel_<PLANT>.xlsx` files under `COLOR_WHEEL_DIR`, uploaded via the Plant tab.
- **Master data** — `master_data.py` backs the `/master-data/*` endpoints (plants, production lines, custom columns) against Postgres.

> ⚠️ **Security:** `db.py` currently hard-codes the Postgres connection string (including the password) for the POC. Move it to env vars / Azure Key Vault before any hosted deployment — see `MIGRATION.md`.

## Architecture

### Frontend (`app.js` — ~31 sequential IIFE modules, ~13,100 lines; plus `nimbus-intelligence.js`)

All modules are plain vanilla JS IIFEs that execute top-to-bottom and attach to a single `window.NIMBUS` namespace. The module load order matters — each module can only reference modules declared above it.

A second frontend file, **`nimbus-intelligence.js`** (~2,200 lines, loaded after `app.js` in `index.html`), extends `window.NIMBUS` with the intelligence layer: `CommandPalette` (Cmd+K), `NeedsEngine`, `TimeMachine`, `Confidence`, `RipplePreview`, `Diff`, `Patterns`, `Voice`, `Haptic`, and `DarkMode`. Depth varies by module — `CommandPalette` and `NeedsEngine` are the most mature.

**Core layers (bottom-up dependency order):**

| Layer | Modules | Role |
|-------|---------|------|
| Foundation | `Config`, `Util` | Constants, pure helpers |
| State | `Store` | Reactive pub/sub; single source of truth. All state lives here. |
| Domain | `Calendar`, `Alerts`, `Utilization`, `Engine` | Business logic that reads/writes Store |
| Infrastructure | `ErrorLog`, `DataIntegrity`, `Toast`, `Modal`, `UndoStack` | Cross-cutting concerns |
| UI components | `Timeline`, `Table`, `Inspector`, `Hierarchy`, `Dashboard`, `UtilStrip`, `ContextMenu`, `Selection` | Render and respond to Store changes |
| Input | `Interaction` | Unified click/keyboard/drag pipeline; calls Engine and mutates Store |
| Data | `Persistence` | Backend fetch, localStorage cache (`nimbus.state.v3`), auto-save |
| Boot | `App` | Tab switching, side-panel resize, initialization sequence |

**State flow:** User action → `Interaction` → mutate `Store` → `Store.publish()` → subscribed UI modules re-render.

**Undo:** `UndoStack` (10 levels) wraps any destructive Store mutation. Always snapshot before calling Engine optimization or bulk drag operations.

### Backend (`brain.py` — FastAPI, ~1,060 lines; data layer in `db.py` ~750 lines, `master_data.py` ~410 lines)

`brain.py` exposes ~30 endpoints (tasks, diagnostics, upload/purge/audit, color wheels, master data, backend logs). The most load-bearing:
- `GET /tasks` — task list with finish-to-start links and metadata; supports `?plant=` server-side scoping (no limit/offset pagination yet)
- `GET /diagnostics` / `GET /diagnostics/deep` — load statistics and DB stats
- `POST /reload` — re-query orders from Postgres without restarting
- `POST /task/update` — update one task's start/end
- `POST /tasks/update` — bulk update (the frontend autosave path; payload `{ tasks, blocks?, calendars? }`)
- `POST /tasks/bulk_update` — flat-list alias for external tooling
- `POST /upload` — ingest a `sequence_testing`-shaped `.xlsx` into the `orders` table

All three `/update` endpoints share one helper, `_apply_task_date_updates()`, which validates payloads via the `TaskDateUpdate` Pydantic model, mutates the in-memory `DATA`, and **persists each edit to Postgres** (`scheduled_start` / `scheduled_end`). On a DB-write failure the in-memory mutation is rolled back so `DATA` and the DB stay consistent; inverted ranges (end ≤ start) are rejected. `POST /reload` discards in-memory edits and re-queries the DB.

Task IDs are MD5 hashes of `f"{PRODUCTION_ORDER}|{MATERIAL_NUMBER}"` computed by `make_id()` in `db.py`. Because the hash excludes time, IDs are stable across reloads and reschedules — the frontend relies on this for keying drag/edit operations.

### Key Patterns

- **Optimization** runs through `Engine.runAndApply(mode)` where `mode ∈ {'spt', 'changeover', 'combined'}`. These are **dispatching heuristics, not true optimization** — there is no changeover-cost matrix, no finite-capacity constraint, and finish-to-start precedence is not consulted. `'spt'` sorts by run-hours ascending. `'changeover'` groups each line's orders by `COLOR` priority → `FORM_SIZE` → `MATERIAL_NUMBER` so same-attribute orders sit adjacent (approximating setup minimization). `'combined'` keeps that color+form grouping but runs the shortest job first **within** each group (SPT inside changeover groups) — so it produces a genuinely different sequence from `'changeover'` (the two were previously identical code paths). The greedy dispatcher then places sorted orders back-to-back, jumping fixed orders and calendar/blackout-closed windows (with a 200-iteration guard that now logs via `ErrorLog.warn` if it fails to converge).
- **Auto-reflow** after manual edits: `Engine.autoReflow()` re-flows subsequent unfixed orders on the affected line to eliminate overlap created by a drag. It only shifts dates within one line, so it triggers an incremental, line-scoped alert recompute. Anything in the Interaction → Engine path needs to be aware of this.
- **Alerts** (overlap, overload, blackout, fixed-closed, fixed-out-of-hours) are computed by `Alerts.recompute(opts)`. A bare call scans all lines; `recompute({ lines })` does an **incremental pass** scoped to specific lines and merges the result into the existing alert list. The debounced dispatcher (`scheduleRecompute` / `scheduleRecomputeLines`) is **adaptive** — its delay scales with the last recompute's measured cost (replacing the old fixed 80 ms window). Blackouts are also visually enforced by `Calendar` — dragging onto a blackout block snaps to the next valid slot.
- **Utilization** is computed per-line per-day in `Utilization.computeMatrix()` (surfaced in `Hierarchy`, `UtilStrip`, and `Dashboard`). The Store-backed path (`srcTasks === null`) is **memoized** on `(startMs, days, Store._rev)`; `Store._rev` bumps on every mutation, so a cache hit always reflects current data.
- **Auto-save** is debounced 1,200 ms in `Persistence` — fires on every Store mutation that touches task data.

### Date / Time Inputs — Flatpickr Standard

**All date and time inputs in NIMBUS use [Flatpickr](https://flatpickr.js.org/) — never native `<input type="date">`, `<input type="datetime-local">`, or `<input type="time">`.**

Flatpickr is loaded via CDN in `index.html` (before `styles.css`). The NIMBUS amber theme overrides live at the bottom of `styles.css` under the `/* Flatpickr NIMBUS theme overrides */` block.

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
- `Calendar._fpBlkStart` / `._fpBlkEnd` — blackout block modal (line-level)
- `Plant._fpBlkStart` / `._fpBlkEnd` — plant blackout modal
- `ProdLines._fpBlkStart` / `._fpBlkEnd` — production lines blackout modal
- `Table._fpOvrStart` — order override modal
- `Printer._fpStart` / `._fpEnd` — export/print modal
- `AdminCockpit._fpPurgeStart` / `._fpPurgeEnd` — admin purge date range
- Inspector `start_date` — initialized fresh on each `Inspector._render()` call (no stored instance; old one is discarded with innerHTML reset)

### Files

`styles.css` (~4,600 lines) is present and uses a CSS-variable design-token system with a dark-mode layer. (`nimbus-interaction.js` was previously a separate file, but the `Interaction` module is now inlined into `app.js`.) Note that `index.html` also carries ~850 lines of inline `<style>` that have not yet been migrated into `styles.css`.
