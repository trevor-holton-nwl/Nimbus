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
