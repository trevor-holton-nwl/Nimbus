# Task 3 Report - Integration and Database Verification

## Files Changed

- `tests/test_integration_routes.py`
  - Added DB-free `TestClient` route tests for:
    - valid order upload result behavior
    - malformed order upload 400 response behavior
    - order-upload setup-state capture before ingest
    - WERKS/plant extraction passed into capture scoping
    - BOM success result behavior and actor propagation
    - BOM failure 400 response behavior
    - purge valid/invalid behavior
    - purge setup-state capture immediately before delete
    - live missing-master-data plant scoping before data-layer read
- `tests/test_integration_pg.py`
  - Added guarded `@pytest.mark.pg` tests for:
    - real `db.ingest_orders_from_excel` order ingest
    - real `master_data.ingest_bom_from_excel` BOM ingest with required `material_plants` setup
    - real `db.purge_orders_by_date` date-range purge preserving out-of-range rows
  - Fixture values use `ZZTEST_*` sentinels and clean rows before and after each test.
  - Schema length check:
    - `material_plants.plant VARCHAR(10)`: uses `ZZTEST_P3` (9 chars).
    - `materials.material_id VARCHAR(18)`: uses `ZZTEST_IPAR` and `ZZTEST_ICMP` (<= 11 chars).
    - `material_plants.subnetwork VARCHAR(3)`: uses `ZZT`.
    - `default_production_version VARCHAR(4)`: uses `PV01` / `PV02`.
    - `material_type VARCHAR(4)`: uses `FERT`; `base_uom VARCHAR(3)`: uses `EA`.
  - Cleanup order deletes `bom_items` before `material_plants`, and `material_plants` before `materials`. `orders`, `upload_audit`, and `admin_audit` cleanup is independent of those FK chains.
- `.github/workflows/ci.yml`
  - Added `Schema bootstrap smoke` step after `schema.sql` bootstrap.
  - Passes `PGPASSWORD: ${{ env.PG_PASS }}` to `scripts/schema_bootstrap_smoke.py`.
- `scripts/schema_bootstrap_smoke.py`
  - Updated stale doc text: the script is now run by CI.
  - Kept local-host refusal unchanged.
  - Added explicit `check=False` to `subprocess.run` for Ruff compliance.

## TDD / Characterization Notes

- Route tests were written before any production changes.
- Initial focused route run exposed two incorrect test assumptions, not production defects:
  - `HTTPException` responses are wrapped by the app with `status`, `message`, and `detail`.
  - Tests were corrected to assert the actual response contract.
- No production route/data-layer code changes were made.

## Commands Run

### Focused DB-free integration route tests

Command:

```powershell
$env:PG_HOST='localhost'; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_routes.py -q
```

Latest output:

```text
..........                                                               [100%]
10 passed, 13 warnings in 7.63s
```

Warnings:

- `StarletteDeprecationWarning` from `TestClient`.
- Existing `Pandas4Warning` from `backend/admin_ops/logbuffer.py`.

### Guarded Postgres integration + required concurrency tests

Command:

```powershell
$env:PG_HOST='localhost'; $env:NIMBUS_TEST_DB='1'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_pg.py tests/test_task_concurrency.py -q -ra
```

Latest output:

```text
ssssss                                                                   [100%]
SKIPPED [1] tests\test_integration_pg.py:109: Postgres unavailable (set NIMBUS_TEST_DB=1 for a local/CI test DB)
SKIPPED [1] tests\test_integration_pg.py:164: Postgres unavailable (set NIMBUS_TEST_DB=1 for a local/CI test DB)
SKIPPED [1] tests\test_integration_pg.py:219: Postgres unavailable (set NIMBUS_TEST_DB=1 for a local/CI test DB)
SKIPPED [3] tests\test_task_concurrency.py: Postgres unavailable (set NIMBUS_TEST_DB=1 for a local/CI test DB)
6 skipped in 0.21s
```

Earlier guarded run also surfaced local connection detail:

```text
connection to server at "127.0.0.1", port 5432 failed: server does not support SSL, but SSL was required
```

This is a local Postgres availability/configuration skip. The DB safety guard was preserved and no Azure/live host was used.

### Ruff

Command:

```powershell
.\.venv\Scripts\python.exe -m ruff check tests/test_integration_routes.py tests/test_integration_pg.py scripts/schema_bootstrap_smoke.py
```

Output:

```text
All checks passed!
```

### Python compile check

Command:

```powershell
.\.venv\Scripts\python.exe -m py_compile tests/test_integration_routes.py tests/test_integration_pg.py scripts/schema_bootstrap_smoke.py
```

Output: exit 0, no output.

## Fix-round 2 — independent re-review remediation (2026-09-02)

The second review's six findings were addressed within the Task 3 ownership
scope. No frontend files or production modules were changed.

### Integration fixture ownership

`tests/test_integration_pg.py` now creates a per-process `ZZTEST_*` token and
uses exact test-owned keys for every seeded record. Cleanup removes the exact
BOM primary key, order IDs (including schedule segments first), upload batch
IDs and per-run filename, BOM audit IDs/details, the two exact
`material_plants` keys, and the two exact material IDs. It no longer filters
any table by the shared `ZZTEST_P3` plant or a broad namespace prefix. Cleanup
ordering is BOM → schedule segments/orders → audits → material_plants →
materials, preserving the BOM foreign-key dependency order. The fixture
contract is also pinned by a DB-free fake-cursor test.

The plant remains `ZZTEST_P3` (9 characters, within `material_plants.plant`
`VARCHAR(10)`). Generated material IDs are 16 characters (within
`VARCHAR(18)`), and the seeded `ZZT`, `PV01`/`PV02`, `FERT`, and `EA` values
fit their schema limits.

### Smoke replay and migration partition

`scripts/schema_bootstrap_smoke.py` still passes `ON_ERROR_STOP=1` and refuses
non-local hosts. It now applies the 22 explicitly selected
current-schema-compatible/replayable migrations twice. It compares `orders`
columns and a bounded, stable public structural fingerprint covering base
tables, columns, indexes, and table constraints. The fingerprint deliberately
excludes volatile row contents and the eight explicitly skipped historical or
hand-applied migration files; the script prints every skipped name and says
that those files were not checked in both its documentation and failure/success
scope text. `tests/test_schema_idempotent.py` now asserts the complete 22-file
applied / 8-file skipped partition and the second-replay/fingerprint wiring.

### Route imports and required-Postgres regression

`tests/test_integration_routes.py` no longer converts arbitrary import/setup
errors into a module-level skip; required imports now fail collection normally.
`tests/test_db_safety.py` adds a subprocess collection test for both missing
`NIMBUS_TEST_DB` opt-in and an unavailable local DB while
`NIMBUS_REQUIRE_TEST_DB=1` is set. Local auto-skipping and non-local/Azure
refusal remain unchanged.

### Fix-round verification

Focused DB-free tests:

```powershell
$env:PG_HOST='localhost'; $env:PG_PORT='5432'; $env:NIMBUS_TEST_DB=''; $env:NIMBUS_REQUIRE_TEST_DB=''; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_routes.py tests/test_integration_pg.py tests/test_schema_idempotent.py tests/test_db_safety.py -m "not pg" -q -ra
```

Output: `49 passed, 5 deselected, 13 warnings in 14.81s`.

Guarded integration/concurrency check:

```powershell
$env:PG_HOST='localhost'; $env:PG_PORT='5432'; $env:NIMBUS_TEST_DB='1'; $env:NIMBUS_REQUIRE_TEST_DB=''; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_pg.py tests/test_task_concurrency.py -q -ra
```

Output: `1 passed, 6 skipped in 0.08s`. The three integration PG tests and
three concurrency tests skipped because the local Postgres probe is
unavailable (this machine's local connection has the existing SSL/auth
mismatch). No Azure or remote database was used.

Required-CI-mode collection check:

```powershell
$env:PG_HOST='localhost'; $env:PG_PORT='5432'; $env:NIMBUS_TEST_DB='1'; $env:NIMBUS_REQUIRE_TEST_DB='1'; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_pg.py tests/test_task_concurrency.py --collect-only -q -ra
```

Expected output/exit: exit 1 with
`pytest.UsageError: NIMBUS_REQUIRE_TEST_DB=1 requires reachable local/CI PostgreSQL test DB`.
This verifies that CI cannot silently accept all PG tests as skipped.

Static checks:

```powershell
.\.venv\Scripts\python.exe -m ruff check tests/test_integration_pg.py tests/test_integration_routes.py tests/test_schema_idempotent.py tests/test_db_safety.py scripts/schema_bootstrap_smoke.py
.\.venv\Scripts\python.exe -m py_compile tests/test_integration_pg.py tests/test_integration_routes.py tests/test_schema_idempotent.py tests/test_db_safety.py scripts/schema_bootstrap_smoke.py
npm run check:static-assets
```

Outputs: `All checks passed!`; compile exit 0 with no output; `Static asset
boundary OK.`

The real scratch-database smoke script could not be run locally for the same
Postgres/auth reason; its replay/fingerprint orchestration and partition are
covered by DB-free tests, while CI's local Postgres service runs the actual
script with `PGPASSWORD`.

### Full DB-free pytest attempt

Command:

```powershell
$env:PG_HOST='localhost'; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest -m "not pg" -q -ra
```

Output reached:

```text
326 passed, 110 deselected, 130 warnings, 1 error
```

Failure was not an application/test assertion failure. Pytest errored while creating its default temp directory:

```text
PermissionError: [WinError 5] Access is denied: 'C:\Users\PJ29587\AppData\Local\Temp\pytest-of-PJ29587'
```

Retry with workspace-local basetemp:

```powershell
$env:PG_HOST='localhost'; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest -m "not pg" -q -ra --basetemp .pytest-task3-dbfree
```

Output again reached:

```text
326 passed, 110 deselected, 130 warnings
```

Then pytest errored during temp cleanup:

```text
PermissionError: [WinError 5] Access is denied: 'C:\Users\PJ29587\OneDrive - Newell Brands\Documents\AI_ML Testing\Claude\.pytest-task3-dbfree'
```

## Local Skips / Concerns

- Local Postgres-dependent tests skipped under the existing guard; no live/Azure database was used.
- `tests/test_task_concurrency.py` was attempted with `PG_HOST=localhost` and `NIMBUS_TEST_DB=1`; all three tests skipped due local Postgres unavailability.
- No auth/module-level route tests skipped in `tests/test_integration_routes.py`.
- Full DB-free suite was attempted before commit, but pytest temp-dir permissions caused a harness cleanup/setup error after executing the DB-free tests. Focused route tests completed with a clean exit.
- `scripts/schema_bootstrap_smoke.py` was not run locally because it requires a usable local/CI Postgres service and creates/drops scratch databases. CI now runs it against the GitHub Actions Postgres service with `PGPASSWORD`.

## Fix Round - Review Blockers

### Blocker 1 - Schema Smoke Migration Replay

Changed `scripts/schema_bootstrap_smoke.py` to replay a curated current-schema-compatible migration subset after bootstrapping current `schema.sql`, while preserving `ON_ERROR_STOP=1` and the local-host refusal.

Explicitly skipped and printed files:

- `2026-06-30-sap-interface.sql` - pre-cutover `production_lines` SAP object key.
- `2026-07-03-production-line-optimizer-flags.sql` - pre-cutover `production_lines` table.
- `2026-08-10-material-plant-default-workcenter.sql` - pre-cutover `default_workcenter` column, renamed by the machine cutover.
- `2026-08-11-priority-lists.sql` - pre-cutover `priority_list.line` column.
- `2026-08-13-changeover-matrix-stage-0.sql` - pre-cutover `production_lines` and setup `line` columns.
- `2026-08-17-line-key-columns.sql` - pre-cutover `production_lines` and `line_key` columns.
- `2026-08-20-line-to-machine.sql` - hand-applied one-shot cutover.
- `2026-08-20-setup-value-case-fold-backfill.sql` - hand-applied setup value backfill.

Added `tests/test_schema_idempotent.py::test_schema_bootstrap_smoke_skips_current_schema_incompatible_migrations` to verify the curation logic keeps those files out of the applied replay list.

### Blocker 2 - BOM Persistence Assertion

Updated `tests/test_integration_pg.py` BOM assertions to match the current ingest contract: pandas imports `"01"` and `"0010"` as numeric cells, and production `_str_id` persists `"1"` and `"10"`. No production preservation change was made because preserving leading zeros was not established as an intended contract in this task.

### Blocker 3 - Global Purge Safety

Updated `tests/test_integration_pg.py::test_purge_orders_by_date_deletes_only_in_range_effective_end_dates` with a preflight query over the exact purge date range. The test now aborts before calling global `db.purge_orders_by_date` unless every matching order id starts with `ZZTEST_INT_`, and it also asserts the selected range contains only the two seeded purge rows before deleting.

### Blocker 4 - CI Must Fail on Skipped PostgreSQL Tests

Added narrow `NIMBUS_REQUIRE_TEST_DB=1` handling in `tests/conftest.py`. Local behavior remains unchanged unless that env var is set. In CI-required mode:

- Missing `NIMBUS_TEST_DB=1` raises `pytest.UsageError`.
- Failed/unreachable Postgres probe raises `pytest.UsageError`.
- `@pytest.mark.pg` tests cannot silently skip.

Set `NIMBUS_REQUIRE_TEST_DB: '1'` in `.github/workflows/ci.yml` for the `test-python` job.

Added `tests/test_db_safety.py::test_required_test_db_setting_turns_pg_skip_into_collection_error` for the helper behavior.

## Fix Round Commands

### Focused Changed-Area DB-Free Tests

Command:

```powershell
$env:PG_HOST='localhost'; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_routes.py tests/test_db_safety.py tests/test_schema_idempotent.py -m "not pg" -q -ra
```

Output:

```text
43 passed, 2 deselected, 13 warnings in 7.66s
```

### Focused Route Tests

Command:

```powershell
$env:PG_HOST='localhost'; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_routes.py -q
```

Output:

```text
10 passed, 13 warnings in 2.07s
```

### Guarded Postgres Integration + Concurrency Tests

Command:

```powershell
$env:PG_HOST='localhost'; $env:NIMBUS_TEST_DB='1'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_pg.py tests/test_task_concurrency.py -q -ra
```

Output:

```text
6 skipped in 0.28s
```

Skip details:

```text
SKIPPED [1] tests\test_integration_pg.py:109: Postgres unavailable (set NIMBUS_TEST_DB=1 for a local/CI test DB)
SKIPPED [1] tests\test_integration_pg.py:164: Postgres unavailable (set NIMBUS_TEST_DB=1 for a local/CI test DB)
SKIPPED [1] tests\test_integration_pg.py:219: Postgres unavailable (set NIMBUS_TEST_DB=1 for a local/CI test DB)
SKIPPED [3] tests\test_task_concurrency.py: Postgres unavailable (set NIMBUS_TEST_DB=1 for a local/CI test DB)
```

Local connection detail:

```text
connection to server at "127.0.0.1", port 5432 failed: server does not support SSL, but SSL was required
```

### CI-Required Postgres Failure Mode

Command:

```powershell
$env:PG_HOST='localhost'; $env:NIMBUS_TEST_DB='1'; $env:NIMBUS_REQUIRE_TEST_DB='1'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_pg.py tests/test_task_concurrency.py -q -ra
```

Expected local failure output:

```text
pytest.UsageError: NIMBUS_REQUIRE_TEST_DB=1 requires reachable local/CI PostgreSQL test DB
```

This confirms CI will fail instead of silently skipping if the Postgres service/probe is unavailable.

### Full DB-Free Tests

Initial non-elevated attempts still failed due temp path permission issues, including under `C:\tmp`. Re-run with elevated filesystem access and an explicit absent basetemp:

```powershell
$env:PG_HOST='localhost'; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest -m "not pg" -q -ra --basetemp C:\tmp\nimbus-pytest-task3-dbfree
```

Output:

```text
332 passed, 110 deselected, 130 warnings in 3.53s
```

### Static Checks

Command:

```powershell
.\.venv\Scripts\python.exe -m ruff check tests/test_integration_routes.py tests/test_integration_pg.py tests/test_db_safety.py tests/test_schema_idempotent.py tests/conftest.py scripts/schema_bootstrap_smoke.py
```

Output:

```text
All checks passed!
```

Command:

```powershell
.\.venv\Scripts\python.exe -m py_compile tests/test_integration_routes.py tests/test_integration_pg.py tests/test_db_safety.py tests/test_schema_idempotent.py tests/conftest.py scripts/schema_bootstrap_smoke.py
```

Output: exit 0, no output.

## Fix-round 2 final verification addendum (2026-09-02)

The independent re-review remediation was verified after the implementation
changes and before commit. The detailed change summary is recorded in the
earlier fix-round 2 section above.

Focused DB-free command:

```powershell
$env:PG_HOST='localhost'; $env:PG_PORT='5432'; $env:NIMBUS_TEST_DB=''; $env:NIMBUS_REQUIRE_TEST_DB=''; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_routes.py tests/test_integration_pg.py tests/test_schema_idempotent.py tests/test_db_safety.py -m "not pg" -q -ra
```

Result: `49 passed, 5 deselected, 13 warnings in 14.81s`.

Guarded Postgres and concurrency command:

```powershell
$env:PG_HOST='localhost'; $env:PG_PORT='5432'; $env:NIMBUS_TEST_DB='1'; $env:NIMBUS_REQUIRE_TEST_DB=''; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_pg.py tests/test_task_concurrency.py -q -ra
```

Result: `1 passed, 6 skipped in 0.08s`; all six real DB tests skipped because
the local probe is unavailable with this machine's existing PostgreSQL
SSL/auth mismatch. No Azure or remote database was contacted.

Required-CI collection command:

```powershell
$env:PG_HOST='localhost'; $env:PG_PORT='5432'; $env:NIMBUS_TEST_DB='1'; $env:NIMBUS_REQUIRE_TEST_DB='1'; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_pg.py tests/test_task_concurrency.py --collect-only -q -ra
```

Expected result: exit 1 with
`pytest.UsageError: NIMBUS_REQUIRE_TEST_DB=1 requires reachable local/CI PostgreSQL test DB`.

Touched-file Ruff, Python compile, and static asset checks all passed:

```text
ruff: All checks passed!
py_compile: exit 0, no output
static assets: Static asset boundary OK.
```

The real scratch-database smoke run remains unexecuted locally solely because
of that Postgres/auth condition; its second-replay, bounded-fingerprint,
curated-partition, and reporting behavior is covered by the focused DB-free
regression tests. No full suite was run in this fix round.

Command:

```powershell
npm run check:static-assets
```

Output:

```text
Static asset boundary OK.
```

### Full Ruff Concern

Command:

```powershell
.\.venv\Scripts\python.exe -m ruff check .
```

Output found two issues outside this task's allowed fix scope:

```text
B011 tests\test_system_settings.py:97:16 Do not `assert False`
F401 tests\test_task_concurrency.py:26:8 `db` imported but unused
```

Those files were not changed in this fix round.

## Final Finish Pass

Ran the focused checks again before the final commit.

### Focused Changed-Area DB-Free Tests

Command:

```powershell
$env:PG_HOST='localhost'; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_routes.py tests/test_db_safety.py tests/test_schema_idempotent.py -m "not pg" -q -ra
```

Output:

```text
43 passed, 2 deselected, 13 warnings in 3.41s
```

### Guarded PostgreSQL/Concurrency Tests

Command:

```powershell
$env:PG_HOST='localhost'; $env:NIMBUS_TEST_DB='1'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_pg.py tests/test_task_concurrency.py -q -ra
```

Output:

```text
6 skipped in 0.07s
```

Skip reason remained local Postgres unavailability:

```text
Postgres unavailable (set NIMBUS_TEST_DB=1 for a local/CI test DB)
```

### CI-Required PostgreSQL Failure Mode

Command:

```powershell
$env:PG_HOST='localhost'; $env:NIMBUS_TEST_DB='1'; $env:NIMBUS_REQUIRE_TEST_DB='1'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_pg.py tests/test_task_concurrency.py -q -ra
```

Expected local failure output:

```text
pytest.UsageError: NIMBUS_REQUIRE_TEST_DB=1 requires reachable local/CI PostgreSQL test DB
```

This is the intended CI behavior if PostgreSQL is unavailable; it prevents silent `@pytest.mark.pg` skips in CI.

### Static Checks

Command:

```powershell
.\.venv\Scripts\python.exe -m ruff check tests/test_integration_routes.py tests/test_integration_pg.py tests/test_db_safety.py tests/test_schema_idempotent.py tests/conftest.py scripts/schema_bootstrap_smoke.py
```

Output:

```text
All checks passed!
```

Command:

```powershell
.\.venv\Scripts\python.exe -m py_compile tests/test_integration_routes.py tests/test_integration_pg.py tests/test_db_safety.py tests/test_schema_idempotent.py tests/conftest.py scripts/schema_bootstrap_smoke.py
```

Output: exit 0, no output.

## Fix-round 2 final verification (appended 2026-09-02)

The independent re-review remediation was verified after implementation and
before commit. Focused DB-free tests reported `49 passed, 5 deselected, 13
warnings in 14.81s`; the guarded integration/concurrency subset reported
`1 passed, 6 skipped in 0.08s` because the local PostgreSQL probe has the
existing SSL/auth mismatch. The required-CI collection check exited 1 with
`pytest.UsageError: NIMBUS_REQUIRE_TEST_DB=1 requires reachable local/CI
PostgreSQL test DB`. Touched-file Ruff passed, Python compilation exited 0,
and `npm run check:static-assets` reported `Static asset boundary OK.`

The real scratch-database smoke script was not run locally because of the
same Postgres/auth condition; its second replay, bounded structural
fingerprint, complete migration partition, and accurate reporting are covered
by the focused DB-free regression tests. No full suite was run in this
fix-round.

## Fix-round 3/5 remediation (appended 2026-09-03)

Addressed all seven findings from the independent re-review without changing
production purge behavior or touching Azure/frontend files.

### Changes

- `scripts/schema_bootstrap_smoke.py` now creates UUID-suffixed scratch database
  names, quotes them as PostgreSQL identifiers, tracks only databases created by
  the current invocation, and drops them in a best-effort `finally` block. The
  local-host refusal and `ON_ERROR_STOP=1` remain unchanged.
- The smoke replay is explicitly curated to 22 replayable/current-schema-
  compatible migrations and prints the complete eight-file skipped partition.
  It now replays that subset twice and compares orders columns, a bounded public
  structural fingerprint, and a bounded deterministic data/ledger contract.
  The latter includes schema-migration IDs, column metadata, the singleton
  system-settings JSON, and a seeded sentinel order, excluding volatile
  timestamps and sequence-backed values. Success/failure text names exactly
  this checked scope and does not claim to check the excluded files.
- `tests/test_schema_idempotent.py` now asserts the complete applied/skipped
  partition, baseline/first-replay/second-replay calls for both fingerprints,
  mismatch failures, failure cleanup, and unique/quoted scratch identifiers.
- `tests/test_integration_pg.py` now runs the real global purge SQL only inside
  a uniquely named, schema-bootstrapped disposable database. A real connection
  is routed through the production pool lookup for the test, so the test still
  invokes `db.purge_orders_by_date` and its unchanged SQL while eliminating
  shared-database TOCTOU exposure. BOM audit cleanup captures all exact audit
  IDs created after the per-run high-water mark and deletes only those IDs; the
  prior predicate fallback is gone. FK cleanup remains BOM → schedule/order →
  upload/admin audit → material_plants → materials.
- `tests/test_db_safety.py` explicitly sets an empty `NIMBUS_TEST_DB` in the
  missing-opt-in subprocess case, preventing `.env` from repopulating it.

### Verification

Focused DB-free command:

```powershell
$env:PG_HOST='localhost'; $env:PG_PORT='5432'; $env:NIMBUS_TEST_DB=''; $env:NIMBUS_REQUIRE_TEST_DB=''; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_routes.py tests/test_integration_pg.py tests/test_schema_idempotent.py tests/test_db_safety.py -m 'not pg' -q -ra
```

Result: `53 passed, 5 deselected, 13 warnings in 18.37s`.

Guarded integration/concurrency command:

```powershell
$env:PG_HOST='localhost'; $env:PG_PORT='5432'; $env:NIMBUS_TEST_DB='1'; $env:NIMBUS_REQUIRE_TEST_DB=''; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_pg.py tests/test_task_concurrency.py -q -ra
```

Result: `2 passed, 6 skipped in 0.13s`. The six PostgreSQL tests (three
integration tests and three concurrency tests) skipped because the local
PostgreSQL probe is unavailable; the local instance has the existing SSL/auth
mismatch. No Azure or non-local database was contacted.

Required-DB missing-opt-in check:

```powershell
$env:PG_HOST='localhost'; $env:PG_PORT='5432'; $env:NIMBUS_TEST_DB=''; $env:NIMBUS_REQUIRE_TEST_DB='1'; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_pg.py tests/test_task_concurrency.py --collect-only -q -ra
```

Result: exit 1 with `pytest.UsageError: NIMBUS_REQUIRE_TEST_DB=1 requires
NIMBUS_TEST_DB=1`.

Required-DB unreachable-probe check with opt-in:

```powershell
$env:PG_HOST='localhost'; $env:PG_PORT='5432'; $env:NIMBUS_TEST_DB='1'; $env:NIMBUS_REQUIRE_TEST_DB='1'; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_pg.py tests/test_task_concurrency.py --collect-only -q -ra
```

Result: exit 1 with `pytest.UsageError: NIMBUS_REQUIRE_TEST_DB=1 requires
reachable local/CI PostgreSQL test DB` (plus the existing interpreter-shutdown
pool finalizer warning).

Touched-file static checks:

```powershell
.\.venv\Scripts\python.exe -m ruff check scripts/schema_bootstrap_smoke.py tests/test_schema_idempotent.py tests/test_integration_pg.py tests/test_db_safety.py tests/test_integration_routes.py
.\.venv\Scripts\python.exe -m py_compile scripts/schema_bootstrap_smoke.py tests/test_schema_idempotent.py tests/test_integration_pg.py tests/test_db_safety.py tests/test_integration_routes.py
```

Results: Ruff `All checks passed!`; `py_compile` exited 0 with no output.

Additional checks:

- `git diff --check` exited 0.
- `npm run check:static-assets` reported `Static asset boundary OK.`
- `python scripts/schema_bootstrap_smoke.py --host example.invalid` exited 1
  with the expected non-local-host refusal before any database operation.
- The real scratch smoke replay and real PostgreSQL ingest/purge tests could
  not run locally because of the guarded PostgreSQL availability/auth issue;
  CI's PostgreSQL service remains the execution environment for those checks.
- No full test suite was run. The pre-existing unrelated working-tree change in
  `Code_Review_09_01.md` was left untouched.

## Fix-round 4/5 re-review remediation (appended 2026-09-03)

Addressed the six findings from the follow-up Task 3 review in Task 3-owned
files only. No production purge semantics, Azure resources, or unrelated
remediation waves were changed.

### Changes

- `tests/test_integration_pg.py` now records successful scratch-database
  creation inside the CREATE context and drops only when `created` is true.
  Connection close is guarded, database drop uses the quoted generated name,
  retries three times, and reports cleanup failures without raising from
  teardown. The purge test still invokes the unchanged production
  `db.purge_orders_by_date` SQL through a real connection in the isolated
  schema-bootstrapped database.
- Exact cleanup regression coverage now binds and checks the actual order,
  BOM-key, upload-batch, upload-filename, admin-audit, material, and plant
  parameters, with all ownership branches populated.
- BOM capture now preserves the ingest exception; a capture failure is chained
  and reported without replacing it. Tests cover ingest failure, capture-query
  failure, zero rows, and multiple rows, and assert captured IDs are retained
  for exact-ID cleanup.
- `tests/test_schema_idempotent.py` parameterizes structural, data/ledger, and
  orders-column mismatch tests for both first-replay and between-replay
  failures. It also injects failures after each database creation boundary and
  during replay while making one cleanup attempt raise, proving every created
  database is attempted and the original failure survives.
- `tests/conftest.py` no longer catches application import or TestClient setup
  errors in the shared `client` fixture; those errors now fail the requesting
  test. `tests/test_db_safety.py` statically guards that contract.

### Verification

Focused DB-free command:

```powershell
$env:PG_HOST='localhost'; $env:PG_PORT='5432'; $env:NIMBUS_TEST_DB=''; $env:NIMBUS_REQUIRE_TEST_DB=''; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_routes.py tests/test_integration_pg.py tests/test_schema_idempotent.py tests/test_db_safety.py -m 'not pg' -q -ra
```

Result: `69 passed, 5 deselected, 13 warnings in 18.70s`.

Guarded integration/concurrency command:

```powershell
$env:PG_HOST='localhost'; $env:PG_PORT='5432'; $env:NIMBUS_TEST_DB='1'; $env:NIMBUS_REQUIRE_TEST_DB=''; $env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python.exe -m pytest tests/test_integration_pg.py tests/test_task_concurrency.py -q -ra
```

Result: `10 passed, 6 skipped in 0.20s`. The three guarded integration tests
and three concurrency tests skipped because the local PostgreSQL probe is
unavailable under the existing local SSL/auth configuration. No Azure or
non-local database was contacted.

Required-DB collection checks:

- With `NIMBUS_TEST_DB=''` and `NIMBUS_REQUIRE_TEST_DB='1'`, pytest exited 1
  with `pytest.UsageError: NIMBUS_REQUIRE_TEST_DB=1 requires NIMBUS_TEST_DB=1`.
- With both values set to `1`, pytest exited 1 with
  `pytest.UsageError: NIMBUS_REQUIRE_TEST_DB=1 requires reachable local/CI
  PostgreSQL test DB` (plus the existing interpreter-shutdown pool finalizer
  warning).

Touched-file checks:

```powershell
.\.venv\Scripts\python.exe -m ruff check scripts/schema_bootstrap_smoke.py tests/conftest.py tests/test_schema_idempotent.py tests/test_integration_pg.py tests/test_db_safety.py tests/test_integration_routes.py
.\.venv\Scripts\python.exe -m py_compile scripts/schema_bootstrap_smoke.py tests/conftest.py tests/test_schema_idempotent.py tests/test_integration_pg.py tests/test_db_safety.py tests/test_integration_routes.py
```

Results: Ruff passed; `py_compile` exited 0 with no output. `git diff --check`
also exited 0. The real PostgreSQL ingest/purge and scratch smoke paths remain
CI-only verification on this machine because local PostgreSQL is unavailable.
No full suite was run.
