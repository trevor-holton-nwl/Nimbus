# CQ-1 Phase 0: Prepare the Module Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish safe database-test isolation, executable legacy contracts, ESM-aware tooling, and reliable static-asset delivery before any `app.js` implementation moves into modules.

**Architecture:** Phase 0 does not change scheduling behavior or application boot. It creates tests and manifests around the legacy surface, makes the test harness fail closed before any remote database pool can open, and relocates public frontend assets under one source directory served locally and copied into the container by convention.

**Tech Stack:** Python 3.12+/pytest/FastAPI, Node 20 built-in test runner and `vm`, ESLint 9 flat config, native browser JavaScript, Docker, GitHub Actions.

## Global Constraints

- Preserve all current planner behavior, explicit Save semantics, optimistic-concurrency behavior, worker protocol, and UMD compute-core behavior.
- Never connect to Azure or any non-local PostgreSQL host from tests. DB-backed tests require `NIMBUS_TEST_DB=1` and a host in `localhost`, `127.0.0.1`, `::1`, or `postgres`.
- A test-only dependency override may bypass `require_admin` only inside tests that explicitly exercise non-auth endpoint behavior; production routes and auth tests remain unchanged.
- Do not add inline scripts, inline event-handler attributes, or inline style attributes. The committed legacy allowlist may only shrink.
- Preserve `APP_VERSION` and `NIMBUS_BUILD_ID` equality. Phase 0 does not bump either value because it is not a deployment.
- Keep `nimbus-compute-core.js` CommonJS/UMD-compatible and `nimbus-worker.js` on the existing `importScripts` protocol.
- Do not copy backend source, schema, migrations, credentials, or repository metadata into the public static mount.
- All source moves in Task 4 are path-only; content changes to moved frontend files are out of scope for Phase 0.

---

### Task 1: Fail-Closed Test Database Isolation

**Files:**
- Create: `tests/support/__init__.py`
- Create: `tests/support/db_safety.py`
- Create: `tests/test_db_safety.py`
- Modify: `tests/conftest.py`
- Modify: `tests/test_logs_endpoints.py`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `class UnsafeTestDatabase(RuntimeError)`
- Produces: `validate_test_database(host: str, database: str, *, opted_in: bool) -> None`
- Produces: `is_test_database_opted_in(value: str | None) -> bool`
- Produces: `LOCAL_TEST_HOSTS = frozenset({'localhost', '127.0.0.1', '::1', 'postgres'})`
- Consumed by: `tests/conftest.py` before importing `db`, `brain`, or any test module that can import them.

- [ ] **Step 1: Write guard tests before the helper exists**

```python
import pytest

from tests.support.db_safety import (
    UnsafeTestDatabase,
    is_test_database_opted_in,
    validate_test_database,
)


@pytest.mark.parametrize('value', ['1', 'true', 'TRUE', 'yes', ' on '])
def test_test_db_opt_in_accepts_explicit_truthy_values(value):
    assert is_test_database_opted_in(value)


@pytest.mark.parametrize('value', [None, '', '0', 'false', 'no'])
def test_test_db_opt_in_is_off_by_default(value):
    assert not is_test_database_opted_in(value)


@pytest.mark.parametrize('host', ['localhost', '127.0.0.1', '::1', 'postgres'])
def test_local_test_hosts_are_allowed_only_with_opt_in(host):
    validate_test_database(host, 'nimbus_test', opted_in=True)
    with pytest.raises(UnsafeTestDatabase, match='NIMBUS_TEST_DB=1'):
        validate_test_database(host, 'nimbus_test', opted_in=False)


@pytest.mark.parametrize('host', [
    'pgdb-nimbus-dev.postgres.database.azure.com',
    'db.example.com',
    '10.20.30.40',
])
def test_remote_hosts_are_rejected_even_with_opt_in(host):
    with pytest.raises(UnsafeTestDatabase, match='local/CI PostgreSQL'):
        validate_test_database(host, 'nimbus', opted_in=True)
```

- [ ] **Step 2: Verify the new tests fail because the helper is missing**

Run: `python -m pytest tests/test_db_safety.py -q`

Expected: collection fails with `ModuleNotFoundError: No module named 'tests.support'`.

- [ ] **Step 3: Implement the pure guard**

```python
TRUTHY = frozenset({'1', 'true', 'yes', 'on'})
LOCAL_TEST_HOSTS = frozenset({'localhost', '127.0.0.1', '::1', 'postgres'})


class UnsafeTestDatabase(RuntimeError):
    pass


def is_test_database_opted_in(value):
    return str(value or '').strip().lower() in TRUTHY


def validate_test_database(host, database, *, opted_in):
    normalized_host = str(host or '').strip().lower()
    if normalized_host not in LOCAL_TEST_HOSTS:
        raise UnsafeTestDatabase(
            f'Tests may use local/CI PostgreSQL only; rejected host {normalized_host!r}'
        )
    if not opted_in:
        raise UnsafeTestDatabase(
            'Database tests require explicit NIMBUS_TEST_DB=1 opt-in'
        )
    if not str(database or '').strip():
        raise UnsafeTestDatabase('Test database name must not be empty')
```

- [ ] **Step 4: Verify the pure guard passes**

Run: `python -m pytest tests/test_db_safety.py -q`

Expected: all guard tests pass without importing `db`.

- [ ] **Step 5: Refactor `tests/conftest.py` so validation happens before pool creation**

Resolve `PG_HOST`/`PG_DB` from environment after `load_dotenv()`, call `validate_test_database` before importing `db`, and set `PG_UP=False` when there is no explicit opt-in. If a non-local host is configured, raise `pytest.UsageError` during initial configuration. When not opted in, set `NIMBUS_PG_POOL_MIN=0` before test-module imports. Only `_pg_available()` may import `db`, and only after the guard has passed.

- [ ] **Step 6: Make backend-log tests truly DB-free**

In the `tc` fixture, install and remove only this dependency override:

```python
@pytest.fixture
def tc():
    brain.api.dependency_overrides[brain.require_admin] = lambda: 'test-admin'
    try:
        yield TestClient(brain.api)
    finally:
        brain.api.dependency_overrides.pop(brain.require_admin, None)
```

Add one assertion that `/logs/backend` still has the `require_admin` dependency in its route metadata before installing the override. This proves the application gate was not removed.

- [ ] **Step 7: Enable the guarded database suite in CI**

Add `NIMBUS_TEST_DB: '1'` to the Python job environment. Keep the service host `localhost` and existing schema bootstrap.

- [ ] **Step 8: Verify safe offline and opted-in behavior**

Run offline: `$env:PG_HOST='127.0.0.1'; $env:PG_DB='nimbus_test'; Remove-Item Env:NIMBUS_TEST_DB -ErrorAction SilentlyContinue; python -m pytest -q`

Expected: pure and DB-free tests pass; `@pytest.mark.pg` tests skip; no remote host appears in output.

Run rejection: `$env:PG_HOST='pgdb-nimbus-dev.postgres.database.azure.com'; $env:NIMBUS_TEST_DB='1'; python -m pytest --collect-only -q`

Expected: immediate usage error naming the rejected host before any pool warning or SQL error.

- [ ] **Step 9: Commit**

```bash
git add tests/support tests/test_db_safety.py tests/conftest.py tests/test_logs_endpoints.py .github/workflows/ci.yml
git commit -m "test: prevent remote database access from pytest"
```

---

### Task 2: Legacy Compatibility and Inline-Handler Contract

**Files:**
- Create: `scripts/legacy-surface.mjs`
- Create: `tests/contracts/cq1-legacy-surface.json`
- Create: `tests/modules/legacy-surface.test.mjs`
- Create: `docs/architecture/cq1-compatibility-inventory.md`
- Modify: `package.json`
- Modify: `eslint.config.js`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `scanLegacySurface({ htmlSource, intelligenceSource, appSource })`
- Produces: JSON `{ version, inlineHandlers, htmlCommands, intelligenceCommands, privateConsumers }`
- Produces: package scripts `test:legacy`, `test:modules`, `test`, and `check:legacy-surface`.

- [ ] **Step 1: Write a failing ESM scanner contract test**

The test imports `scanLegacySurface`, scans the current sources, and asserts:

```js
assert.equal(surface.version, 1);
assert.ok(surface.htmlCommands.includes('Persistence.saveAll'));
assert.ok(surface.htmlCommands.includes('OptimizeDialog.run'));
assert.ok(surface.intelligenceCommands.includes('Store.tasksArr'));
assert.ok(surface.intelligenceCommands.includes('Compute.utilization'));
assert.ok(surface.privateConsumers.includes('GanttFilter._selectedLines'));
assert.ok(surface.inlineHandlers.some(x => x.attribute === 'onclick'));
```

It also loads `tests/contracts/cq1-legacy-surface.json` and deep-compares the scan result. The mismatch message instructs maintainers to update the contract only when a caller is deliberately migrated or removed.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/modules/legacy-surface.test.mjs`

Expected: failure because `scripts/legacy-surface.mjs` and the contract do not exist.

- [ ] **Step 3: Implement deterministic source scanning**

Use regex only for lexical inventory, not code transformation. Normalize matches to sorted unique strings. Record each inline handler as `{ file, attribute, expression }`; scan `on[a-z]+=` in both `index.html` and JavaScript string literals in `app.js`. Record `NIMBUS.Module.member` references from HTML and intelligence separately. `privateConsumers` contains any member segment beginning with `_`.

- [ ] **Step 4: Generate and commit the initial snapshot**

Add a CLI branch guarded by `if (import.meta.url === pathToFileURL(process.argv[1]).href)` that writes formatted JSON only when passed `--write`; the default prints a mismatch summary and exits non-zero. Generate the initial contract with `node scripts/legacy-surface.mjs --write`.

- [ ] **Step 5: Document ownership and migration order**

`docs/architecture/cq1-compatibility-inventory.md` must map every top-level legacy module to exactly one of foundation, state, services, data, workbench, administration, or shell; call out Bill of Materials under administration; declare mount-once/show-hide for current major screens during the staged migration; document `{ plant, id }` task references; and list every intelligence/private consumer from the generated snapshot.

- [ ] **Step 6: Configure ESM lint and tests**

Add an ESLint block for `scripts/**/*.mjs`, `tests/modules/**/*.mjs`, and future `web/**/*.mjs` with `sourceType: 'module'` plus Node globals for scripts/tests and browser globals for `web/**/*.mjs`. Set scripts exactly:

```json
"test:legacy": "node --test \"tests/js/*.test.js\"",
"test:modules": "node --test \"tests/modules/*.test.mjs\"",
"test": "npm run test:legacy && npm run test:modules",
"check:legacy-surface": "node scripts/legacy-surface.mjs"
```

Add `npm run check:legacy-surface` to the JS CI job.

- [ ] **Step 7: Verify GREEN**

Run: `npm run lint:ci && npm test && npm run check:legacy-surface`

Expected: legacy 15/15 tests pass, module contract passes, scanner reports no drift, lint has no errors.

- [ ] **Step 8: Commit**

```bash
git add scripts tests/contracts tests/modules docs/architecture package.json eslint.config.js .github/workflows/ci.yml
git commit -m "test: inventory the CQ-1 compatibility surface"
```

---

### Task 3: Executable Legacy Characterization Harness

**Files:**
- Create: `tests/modules/helpers/load-legacy-app.mjs`
- Create: `tests/modules/legacy-app-characterization.test.mjs`
- Modify: `tests/README.md`

**Interfaces:**
- Produces: `loadLegacyApp({ fetchImpl, workerFactory, storageSeed } = {}) -> { nimbus, context, domReady }`
- Characterizes: selected-plant task/line scoping, worker snapshot scope, explicit Save/refresh request shapes, and main planner command availability.

- [ ] **Step 1: Write a failing selected-plant characterization**

Load the legacy app without firing `DOMContentLoaded`, seed master lines where line code `L1` exists in plant `5512` and `L2` exists in `1006`, seed one task per plant, select `5512`, and assert `Store.tasksForSelectedPlant()` returns only the `5512` task and `Store.linesForSelectedPlant()` excludes `L2`.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/modules/legacy-app-characterization.test.mjs`

Expected: failure because `load-legacy-app.mjs` does not exist.

- [ ] **Step 3: Implement the no-boot VM harness**

Read `app.js`, append `globalThis.__NIMBUS__ = NIMBUS;`, and evaluate it in `node:vm`. Provide deterministic stubs for `window`, `document`, `navigator`, `localStorage`, `sessionStorage`, `performance`, timers, `crypto.randomUUID`, `fetch`, `Worker`, `URL`, `Blob`, `CSS.escape`, `MutationObserver`, `ResizeObserver`, and the CDN globals. `document.addEventListener('DOMContentLoaded', fn)` stores `fn` as `domReady` but never runs it. The harness must throw on an unrecognized DOM or network operation so tests cannot silently pass through missing behavior.

- [ ] **Step 4: Characterize worker snapshot scope and late-job identity**

Create a fake Worker that records `postMessage`. Call the public Compute alert/utilization entry used by the app and assert the posted payload contains only selected-plant lines/calendars/settings, retains job ID, and carries the selected plant. Do not alter `nimbus-worker.js` or core messages in Phase 0.

- [ ] **Step 5: Characterize explicit Save and refresh**

Use a recording fetch implementation. Dirty one task, call `Persistence.saveAll()`, and assert one `/tasks/update` request includes task dates, `base_version`, `force`, blocks, and calendars. Assert no Store mutation or debounce alone sends that request. Simulate a stale response and assert the existing `/tasks/refresh` reconciliation path is invoked.

- [ ] **Step 6: Characterize planner commands used by legacy callers**

Assert the current namespace provides callable commands for Save, Gantt navigation, zoom-to-fit, optimizer open/run, sandbox enter/discard, print, table export/fix/override, alerts drawer, plant calendars, labor horizon navigation, and admin log navigation. Source the exact command list from `cq1-legacy-surface.json` rather than duplicating a second list.

- [ ] **Step 7: Verify and document harness limits**

Run: `npm run test:modules`

Expected: all characterizations pass without firing application boot, touching a database, or making a real network request. Document in `tests/README.md` that this harness pins orchestration contracts; browser layout/third-party rendering remains the later smoke-test responsibility.

- [ ] **Step 8: Commit**

```bash
git add tests/modules/helpers tests/modules/legacy-app-characterization.test.mjs tests/README.md
git commit -m "test: characterize the legacy scheduler seam"
```

---

### Task 4: Dedicated Frontend Source and Static Delivery Gate

**Files:**
- Create: `web/` by moving `index.html`, `styles.css`, `app.js`, `nimbus-intelligence.js`, `nimbus-worker.js`, `nimbus-compute-core.js`, `locales/`, and `Images/` without content changes
- Create: `scripts/check-static-assets.mjs`
- Create: `tests/modules/static-assets.test.mjs`
- Create: `tests/test_static_delivery.py`
- Modify: `brain.py`
- Modify: `Dockerfile`
- Modify: `package.json`
- Modify: `eslint.config.js`
- Modify: `.github/workflows/ci.yml`
- Modify: `AGENTS.md`

**Interfaces:**
- Produces: `STATIC_DIR` defaulting to `<repository>/web` via `Path(__file__).resolve().parent / 'web'`.
- Produces: middleware behavior `Cache-Control: no-cache` for `.mjs` responses only.
- Produces: `collectStaticImportClosure(entryPath) -> string[]` for local relative static imports.
- Produces: package script `check:static-assets`.

- [ ] **Step 1: Write failing static-delivery tests**

Python TestClient tests override `require_admin` only where needed and assert `/` returns the NIMBUS HTML, `/app.js` returns JavaScript, a fixture `.mjs` under the configured static directory returns a JavaScript MIME type plus `Cache-Control: no-cache`, and `/brain.py`, `/schema.sql`, `/.env`, and `/.git/config` return 404.

Node tests assert the expected legacy entry assets exist under `web/`, every local `import`/dynamic `import()` reachable from the future entry stays inside `web/`, and no backend filename appears in the public tree.

- [ ] **Step 2: Verify RED**

Run: `python -m pytest tests/test_static_delivery.py -q` and `node --test tests/modules/static-assets.test.mjs`

Expected: failure because `web/` and the static checker do not exist and `STATIC_DIR` still defaults to `.`.

- [ ] **Step 3: Move the public assets as one mechanical change**

Use Git path moves so history is retained. Update all test, lint, documentation, and runtime paths from root to `web/`. Do not change the contents of the moved assets in this step.

- [ ] **Step 4: Serve only the dedicated directory locally**

Resolve `STATIC_DIR` to an absolute path. Add request middleware that appends `Cache-Control: no-cache` only when `request.url.path.endswith('.mjs')`; do not change API response caching. Keep the catch-all StaticFiles mount last.

- [ ] **Step 5: Copy the directory by convention in Docker**

Replace the manually maintained `cp index.html ...` block with `COPY web/ /app/web/`. Keep backend `COPY` operations outside `/app/web`, preserve the non-root user, and do not add Node to the runtime image.

- [ ] **Step 6: Implement the import-closure checker**

Parse only local relative specifiers from static `import ... from`, side-effect `import '...'`, and `import('...')`. Resolve each path, require it to remain under `web/`, require it to exist, recurse once per file, and report the complete sorted closure. Reject absolute URLs, root escapes, and missing files only when they are application module imports; classic CDN tags remain governed by the compatibility inventory.

- [ ] **Step 7: Add local and CI gates**

Add `"check:static-assets": "node scripts/check-static-assets.mjs"`, include `web/**/*.js`, `web/**/*.mjs`, and `web/locales/*.js` in lint config/scripts, and run the checker in JS CI. Keep existing CommonJS core tests pointed at `web/nimbus-compute-core.js`.

- [ ] **Step 8: Verify GREEN**

Run: `npm run lint:ci && npm test && npm run check:legacy-surface && npm run check:static-assets`

Run: `$env:PG_HOST='127.0.0.1'; $env:PG_DB='nimbus_test'; Remove-Item Env:NIMBUS_TEST_DB -ErrorAction SilentlyContinue; python -m pytest -q`

Build smoke: `docker build -t nimbus:cq1-phase0 .` then run the image without database credentials and verify `/`, `/app.js`, and the test `.mjs` fixture return 200 while `/brain.py` returns 404. If Docker is unavailable, record that as an unverified environment gate rather than weakening the test.

- [ ] **Step 9: Commit**

```bash
git add -A web scripts tests brain.py Dockerfile package.json eslint.config.js .github/workflows/ci.yml AGENTS.md
git commit -m "build: establish the CQ-1 static asset boundary"
```

---

## Phase 0 completion gate

- [ ] Run `git diff --check`.
- [ ] Run `npm run lint:ci`.
- [ ] Run `npm test`.
- [ ] Run `npm run check:legacy-surface`.
- [ ] Run `npm run check:static-assets`.
- [ ] Run safe offline `pytest` and confirm all non-Postgres tests pass.
- [ ] Run remote-host collection rejection and confirm no pool connection is attempted.
- [ ] Run container/static smoke when Docker is available.
- [ ] Review the complete Phase 0 diff for security, behavior drift, and accidental public files before writing the Phase 1 extraction plan.
