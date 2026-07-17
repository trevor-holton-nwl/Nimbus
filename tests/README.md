# NIMBUS tests

## JavaScript tests (`tests/js/` and `tests/modules/`)

```bash
npm run test:legacy   # tests/js/*.test.js  — CommonJS, covers compute-core + timezone
npm run test:modules  # tests/modules/*.test.mjs — ESM, covers CQ-1 compatibility surface
npm test              # both suites
npm run check:legacy-surface  # diff scanner output vs contract snapshot
```

**`tests/modules/` harness notes:**
- `helpers/load-legacy-app.mjs` loads `app.js` in a Node VM with browser-global stubs.
  `DOMContentLoaded` is captured but never fired — no DOM layout, no network, no real Worker.
- `legacy-surface.test.mjs` pins the inline-handler/cross-module contract from the
  generated `tests/contracts/cq1-legacy-surface.json`. Update the contract only after a
  caller is deliberately migrated: `node scripts/legacy-surface.mjs --write`.
- `legacy-app-characterization.test.mjs` pins selected-plant scoping, save payload shape,
  and the public namespace surface. These survive Phase 1–4 refactoring as regression guards.
- The harness throws on any unrecognised network call so missing stubs are immediately visible.
- `foundation.test.mjs` / `schedule-state.test.mjs` — plain ESM `import` shape
  and behavior tests for `application-foundation.mjs`/`schedule-state.mjs`
  (no VM sandbox needed — these are real native modules). `app-entry.test.mjs`
  covers the loader's load-then-load-in-order contract via dependency
  injection (`loadScript`), not real DOM script tags — real-browser boot
  ordering is a Phase 4 browser-smoke responsibility, not unit-tested here.
- `schedule-services.test.mjs` / `schedule-data.test.mjs` — plain ESM `import`
  shape and behavior tests for `schedule-services.mjs` (Calendar capacity
  math, Compute, Alerts computation, Utilization, Engine) and
  `schedule-data.mjs` (Persistence, CalendarSync, Session state/API), the
  Phase 2 modules. Cover the worker-protocol/memoization/optimistic-
  concurrency contracts plus the two data→services seams
  (`schedule:hydrated` event, `Persistence.setCalendarService`) — no VM
  sandbox needed, these are real native modules too.
- `schedule-workbench.test.mjs` — plain ESM `import` shape and behavior tests
  for `schedule-workbench.mjs` (`Timeline`, `Table`, `Inspector`, `Hierarchy`,
  `Dashboard`, `TimelineNav`, `GanttFilter`, `DependencyOverlay`,
  `ContextMenu`, `Interaction`, `OptimizeDialog`, `OptimizerPreview`,
  `EditCalendar`, `ColorWheelViewer`, `Printer`, plus the relocated
  `SandboxAdapter`/`AlertsUIAdapter` DOM adapters), the Phase 3 module — no
  VM sandbox needed, these are real native modules too. A minimal
  hand-rolled `document`/`#vis-timeline`-container stub with
  call-counting `addEventListener`/`removeEventListener` (defined at the top
  of the file, only installed if `globalThis.document` isn't already set)
  backs the `Interaction` characterization tests: idempotent `install()`,
  the new `uninstall()` teardown removing every listener `install()`
  attached, and the `_onDataSetUpdate` fixed-task drag behavior (a real
  drag on a fixed order commits to the Store — it is not reverted, despite
  the module's original header comment claiming otherwise; the comment was
  corrected, the behavior was not changed). `load-legacy-app.mjs`'s VM
  harness bridges `window.__NIMBUS_WORKBENCH` the same way as the Phase 1/2
  bridges, for the legacy-app characterization suite.

## Backend tests (`tests/*.py`)

## Run

```bash
# from the project root, using the app venv
./.venv/Scripts/python.exe -m pytest -q
```

- **No Postgres needed for the pure tests** (`test_make_id.py`) — they always run.
- **DB-integration tests** (`test_data_integrity.py`) are marked `@pytest.mark.pg`
  and **auto-skip** when Postgres is unreachable. To run them, start Postgres and
  ensure `.env` points at a DB with `schema.sql` applied (the `WTG/1006` and
  `HMF/5512` plant seeds are required by the #202 test).

## What's covered

| Finding | File | Current guard | Target (xfail until fixed) |
|---------|------|---------------|----------------------------|
| #202 cross-plant attribution | `test_data_integrity.py::TestCrossPlantAttribution_202` | reattribute picks lexically-lowest plant | ambiguous shared line code stays NULL + warn |
| #211 cascade preview | `…::TestCascadePreviewMaterials_211` | `materials` preview omits `material_plants` | preview reports `material_plants` count |
| #203 bulk-update contract | `…::TestBulkUpdateContract_203` | happy-path + inverted-range rejection | lost-rows-as-failed (needs concurrency harness) |
| #202 root cause | `test_make_id.py` | `make_id` is plant-blind (collision) | (flip when `make_id` gains a plant arg) |

When a fix lands: remove the matching `test_current_*` guard and drop the `xfail`
marker on the `test_desired_*` test so it becomes a hard assertion.
