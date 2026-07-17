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
- `plant-and-administration.test.mjs` — plain ESM `import` shape tests for
  `plant-and-administration.mjs` (`CalendarUI`, `Plant`, `ProdLines`,
  `MasterData`, `LaborPlanning`, `Interface`, `Security`, `AdminCockpit`), the
  Phase 4 Task 1-3 module — no VM sandbox needed, a real native module.
  `load-legacy-app.mjs`'s VM harness bridges `window.__NIMBUS_PLANT_ADMIN`
  the same way as the earlier bridges.
- `application-shell.test.mjs` — plain ESM `import` shape tests for
  `application-shell.mjs` (`SessionUIAdapter`, `showLoginScreen`,
  `PlantSelector`, `WelcomeSplash`, `EmptyState`, `App`, `Settings`), the
  Phase 4 Task 4 module and the seventh and final CQ-1 file — asserts
  `App._renderSettingsPane` is `undefined` on this module (relocated to
  `Plant` in Task 1, not carried here). `load-legacy-app.mjs`'s VM harness
  bridges `window.__NIMBUS_SHELL` the same way as the earlier bridges.

**CQ-1 complete (all 4 phases):** all seven `.mjs` module files above are now
real ES modules with their own shape/behavior test files; `app.js` is a
731-line launcher with no module bodies of its own. See
`docs/architecture/cq1-compatibility-inventory.md` for the full ownership map
and the honest final-criteria report (§8) — including the one gate never
run in any of the four phases: a real Docker/browser boot smoke test.

## Backend tests (`tests/*.py`)

The pytest suite covers backend contracts, schema regressions, in-memory log
behavior, and PostgreSQL-backed workflows. Tests that need a database are marked
`@pytest.mark.pg`; `tests/conftest.py` skips them automatically when Postgres is
unreachable.

## Run locally

From the project root, with the app dependencies and pytest installed:

```powershell
.\.venv\Scripts\python.exe -m pytest
```

To run only the tests that do not require Postgres:

```powershell
.\.venv\Scripts\python.exe -m pytest -m "not pg"
```

To exercise the full suite, start Postgres, configure the `PG_*` values in
`.env`, and apply `schema.sql` to the test database before running pytest.
Database tests create and remove `ZZTEST_*` records, but use a dedicated local
database rather than a shared environment whenever possible.

## Coverage

| Area | Test files | Database required |
|---|---|:---:|
| Stable order IDs and Excel-value normalization | `test_make_id.py` | No |
| Datetime parsing and local-time persistence contract | `test_to_pydt.py` | No |
| PostgreSQL error translation | `test_translate_db_error.py` | No |
| Backend log-event schema and log-buffer endpoints | `test_log_event.py`, `test_logs_endpoints.py` | No |
| `schema.sql` static checks and re-application idempotency | `test_schema_idempotent.py` | Mixed |
| Durable per-plant color-wheel serialization and CRUD | `test_color_wheel_store.py` | Mixed |
| Cross-plant attribution, cascade preview, and bulk-update contracts | `test_data_integrity.py` | Yes |
| User-name validation and `user_security` persistence | `test_user_names.py` | Mixed |
| Self-service password changes | `test_change_password.py` | Yes |

Some no-database tests import `brain.py`. They may skip cleanly if the app cannot
be imported in the local environment; CI supplies temporary color-wheel paths so
those imports are deterministic.

## CI

GitHub Actions runs the complete Python suite against PostgreSQL 16. The workflow
installs application dependencies plus pytest, bootstraps `schema.sql`, then runs
`pytest -ra`. JavaScript linting and Node tests run in a separate CI job.
