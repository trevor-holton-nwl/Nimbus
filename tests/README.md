# NIMBUS tests

## JavaScript tests (`tests/js/` and `tests/modules/`)

```bash
npm run test:legacy   # tests/js/*.test.js  — CommonJS, covers compute-core + timezone
npm run test:modules  # tests/modules/**/*.test.mjs — ESM, covers CQ-1 compatibility surface
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
- `foundation.test.mjs` — plain ESM `import` shape and behavior tests for the
  platform foundation module (no VM sandbox needed — a real native module).
  `app-entry.test.mjs` covers the loader's load-then-load-in-order contract via
  dependency injection (`loadScript`), not real DOM script tags — real-browser
  boot ordering is a browser-smoke responsibility, not unit-tested here.
  `application-shell.test.mjs` covers the shell module (`SessionUIAdapter`,
  `showLoginScreen`, `PlantSelector`, `EmptyState`, `App`, `Settings`).
- Every other frontend domain has its own folder, `tests/modules/<domain>/`
  (`scheduling`, `calendar`, `optimization`, `insights`, `platform`,
  `security`, ...), with real ESM imports and no VM. The CQ-1-era file names
  `schedule-state`, `schedule-services`, `schedule-data`, `schedule-workbench`
  and `plant-and-administration` no longer exist: their tests moved into those
  folders when the modules were split (for example `scheduling/persistence.test.mjs`,
  `calendar/calendar-engine.test.mjs`, `platform/store.test.mjs`). The
  `Persistence.setCalendarService` seam they once covered was removed in
  backward scheduling Task 2.5 (the load-time calendar re-snap it served is
  gone). Each domain's `CLAUDE.md` lists its own test files.

**CQ-1 complete (all 4 phases):** the compatibility-bridge modules were later
split per domain (see `frontend/<domain>/CLAUDE.md`); `app.js` is a 797-line
launcher with no module bodies of its own. See
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
