# Test coverage additions — 2026-10-13

Added **376 executable cases in 12 new test files**, plus one shared PostgreSQL
fixture. Of these, **360 pass** and **16 reproduce five existing defects**.
No production code, existing tests, dependencies, or test configuration changed.
These files are discovered by the existing pytest and npm test commands.

## Coverage added

| New files | Cases | Contracts exercised |
|---|---:|---|
| `test_api_labor_coverage.py` | 49 | HTTP validation, plant authorization, filter forwarding, actor attribution, mixed zero/upsert/delete batches, failed writes |
| `test_api_security_coverage.py` | 40 | Login input, user settings, identity boundaries, profile responses, errors before database access |
| `test_api_admin_ops_coverage.py` | 29 | Liveness, degraded health, error redaction, admin guards, maintenance failures, settings, request-correlated logs |
| `test_domain_sap_sync_coverage.py`, `test_domain_sap_staging_edges_coverage.py`, `test_domain_setup_contract_coverage.py`, `test_domain_routing_combinations_coverage.py` | 131 | SAP transforms and dispatch, configuration failures, DST/date boundaries, outbound group isolation, setup trust/time precedence, composite keys, routing rounding and fallback precedence |
| `test_labor_persistence_workflows.py` | 23 | Real PostgreSQL round trips, repeated writes, explicit deletion, zero hours, plant isolation, filters, audit records, rollback after a delete and partial batch |
| `test_calendar_persistence_workflows.py` | 40 | Real PostgreSQL calendar hydration, inheritance, delta blackouts, UTC offsets/DST folds, atomic validation, transaction recovery, HTTP save/read/delete flow |
| `modules/insights/compute-transport.test.mjs` | 13 | Concurrent worker requests, response correlation, crashes, retries, plant-scoped snapshots and snapshot isolation |
| `modules/calendar/calendar-sync-boundaries.test.mjs` | 29 | 70-line debounce, independent plant timers, edits during requests, hydration, durable delete storage, retries from current state, What-If discard and promotion |
| `modules/calendar/capacity-allocation-integration.test.mjs` | 22 | Calendar/Store/compute integration, scope, interval boundaries, allocation and utilization |

The PostgreSQL fixture uses the existing `pg` safety gate. Each invocation creates
unique test subnetworks/plants and deletes only its owned rows. The tests exercise
real commits, rollback, SQL joins, JSONB, and audit persistence. Database-free API
tests replace external I/O while retaining HTTP routing and validation. Node
tests use real modules, with controlled timers and transport boundaries.

## Confirmed defects captured without changing production

1. **Malformed labor cells return HTTP 500.** `cells: null` or non-object array
   members reach unchecked data-layer operations. Eight cases expect 400/422.
2. **Nonstring login usernames return HTTP 500.** Numbers, arrays, objects and
   booleans reach `.strip()` in the throttle key. Four cases expect 400/422.
3. **SAP configuration failures escape the documented error result.**
   `sync_object()` reads configuration before its exception boundary. One case
   expects the structured failure response.
4. **Discarded What-If hours can be persisted.** A queued line-hours timer fires
   after sandbox discard, when the sandbox guard is no longer active. One case
   expects no backend write.
5. **What-If blackout edits erase live pending deletions.** Speculative line and
   plant blackout upserts clear the durable pending-delete record before the
   sandbox write guard. Two cases expect those records to remain.

Python uses strict expected failures. Malformed-input tests check the exact
exception type, message and origin, as well as absence of database access.
Node's three executable TODO tests use a wrapper that accepts only the known
assertion failure and fails on unexpected success or a different failure.
These markers must be removed when the corresponding production defects are fixed.

## Verification

- Full Python suite with required, reachable local PostgreSQL:
  **1,599 passed, 1 pre-existing skip, 13 expected failures**.
- Full `npm test`: **1,198 passed, 3 expected failures** across legacy and module
  suites. Its TypeScript build passed. The final strengthening of the calendar
  race assertion was also verified with its focused suite.
- `npm run typecheck`: passed.
- `npm run lint`: no errors; 35 existing warnings. New JavaScript files also
  passed focused ESLint checks.
- Ruff on all new Python files: passed.
- Repository-wide Ruff finds one existing `SIM115` in
  `test_sap_staging.py:1311`; that existing file was left unchanged.
- Independent review checked fixture cleanup, isolation, and expected-failure
  precision. Its two findings were addressed.

The local app environment pointed at Azure. Verification instead used a fresh
PostgreSQL cluster bound to `127.0.0.1`, a dedicated test database, process-local
environment settings, and the unchanged collection-time safety guard. Windows
sandbox permissions initially blocked Node workers, pytest temp access and
PostgreSQL process signaling. Normal execution permissions resolved those
environment issues; the completed full Python run took 76 seconds.

## Running these tests

Use `npm test` for all frontend tests. For Python, configure `PG_HOST`, `PG_PORT`,
`PG_DB`, `PG_USER`, `PG_PASS`, and `PG_SSLMODE` in the current shell for a disposable
local database initialized from `schema.sql`. Set `NIMBUS_TEST_DB=1` and
`NIMBUS_REQUIRE_TEST_DB=1`, then run `.venv/Scripts/python.exe -m pytest -q`.
Do not run against the application's Azure database or bypass the safety guard.

This expansion covers specific audited gaps; it is not a claim of complete
application coverage. It does not add real-browser automation, live SAP/Mulesoft
tests, or distributed load tests. The existing skipped concurrent-delete scenario
in `test_data_integrity.py` also remains outstanding.
