# Scale, optimization, and multi-user test additions

Second coverage pass: **73 new passing cases**, comprising 27 Python cases and
46 Node cases in 11 new test modules, supported by two new test helpers.
This pass creates files only; production code, existing tests, dependencies,
and test configuration are unchanged. The earlier coverage report remains in
`COVERAGE_ADDITIONS_2026_10_13.md`.

## Coverage added

| New test module | Cases | Workload and regression protection |
|---|---:|---|
| `modules/optimization/scheduler-plant-scale.test.mjs` | 36 | Real DueDate, MinChangeover, and SPT scheduling of 840 orders across 70 machines; independent demand, runtime, non-overlap, setup occupancy, calendar, protected-order, and objective checks. Enterprise metadata with 50 plants and 3,500 machines; scoped optimization; capacity overflow, splits, mid-shift firm orders, closures, machine-specific setups, shared iteration budgets, deadlines, retained incumbents, and gap-fill preservation. |
| `modules/platform/store-scale.test.mjs` | 3 | 14,000 orders and alert memberships; bulk notification coalescing, indexed identities, sibling-cache reuse and invalidation, and plant isolation. |
| `modules/routing/runtime-scale.test.mjs` | 2 | 105,000 runtime resolutions across 50 plants; one rate fetch per plant, bounded indexed reads without map enumeration, and replacement of stale same-plant rates. |
| `modules/scheduling/persistence-scale.test.mjs` | 2 | Real App dirty tracking, Store, and Persistence integration: 2,100 edits across 70 machines, preservation of 210 edits made during an in-flight save, refreshed versions on the next save, durable local state, and precise firm flags for 700 orders. Transport responses are controlled. |
| `modules/setup/setup-resolution-scale.test.mjs` | 3 | 9,900 and 39,800 directional changeovers; bounded index construction and 50,000 repeated pair lookups without rescanning arrays or iterating Maps. Two plant indexes with shared version/key values and 70-machine overrides preserve occurrence > line > plant precedence and uncovered-transition semantics. |
| `test_scale_catalog_paging.py` | 5 | Real PostgreSQL catalog of 2,003 materials and 60 plants: complete page traversal, sparse membership, literal wildcard-character search, access scope, and policy enrichment limited to visible plants. Bounded SQL work prevents per-row reads. |
| `test_scale_catalog_routing.py` | 2 | 160 materials, multiple production versions and operations, two plants, and 70 eligible machines: join cardinality, missing operations, paging completeness, material identity, and plant-scoped machine enrichment. |
| `test_scale_distribution_reads.py` | 2 | Two plants with 70 machines each, 240 headers per plant, and 960 children: constant bounded SQL work for page sizes 1 and 100, hydration of visible keys only, filtering, plant isolation, segment extents, and queued-order date handling. |
| `test_scale_schedule_multiuser.py` | 10 | Real HTTP routing, database-backed user/role/plant scope, and PostgreSQL writes: 2/8 concurrent planners, stale-version refresh/retry, competing strict optimizer saves, reversed overlapping atomic batches, manual versus atomic rejection scope, parallel request identity, and immediate role reassignment. Observed database lock contention proves a busy machine in one plant does not block the same machine code in another. |
| `test_scale_schedule_batching.py` | 7 | 70/500/501/2,100-order saves across 70 machines, bounded update batching, mixed edit shapes, version return completeness, unchanged omitted columns, and atomic stale-row rejection. A genuine PostgreSQL statement timeout interrupts the second update batch: the first batch rolls back and retry succeeds. |
| `test_scale_sql_observer.py` | 1 | Validates the performance-test instrumentation against real PostgreSQL: connection convenience execution, cursor execution, composed SQL, generator-backed batch execution, and no double counting. |

Helpers: `modules/helpers/optimizer-scale-fixture.mjs` builds realistic scheduler
inputs and checks results independently; `support/scale_catalog_sql.py` records
attempted SQL statements while delegating to real PostgreSQL. Batch parameter
sets count individually, so pipelining cannot hide per-row database work.

## Why these performance assertions are meaningful

- SQL budgets detect extra per-material, per-order, and per-page database work.
- Collection instrumentation detects repeated full scans and redundant index
  construction; upper bounds allow future implementations to do less work.
- Real large inputs exercise save chunk boundaries, catalog joins, cache
  invalidation, and optimizer feasibility without replacing those implementations.
- Deterministic optimizer clocks test deadline behavior and incumbent retention.
- Concurrent HTTP requests exercise transaction results and identity isolation;
  the explicit advisory-lock test additionally proves actual database contention.

These are regression checks for correctness and work performed. They do not
establish deployment latency, throughput, browser rendering speed, or a production
service-level objective. Distributed load tests, browser profiling, and production
query-plan benchmarks remain separate work. Simultaneous request launch alone
does not prove every request overlapped at every database operation.

## Verification

- Full Python suite before the final instrumentation hardening and its additional
  observer case: **1,625 passed, 1 existing skip, 13 existing expected failures**.
- After that hardening: **all 27 new Python cases passed** against real local
  PostgreSQL, including every caller of the shared SQL observer.
- Full `npm test`: **1,244 passed, 3 existing executable TODO cases**, including
  the TypeScript build. Final setup/routing instrumentation hardening was followed
  by a fresh **5/5 passing** focused run.
- `npm run typecheck`: passed.
- `npm run lint`: no errors; 35 existing warnings. Final changed Node tests also
  passed focused ESLint checks.
- Ruff on all new Python files: passed. The earlier repository-wide check's
  existing `SIM115` in `test_sap_staging.py:1311` remains outside this addition.
- Independent review covered fixture isolation, cleanup, realistic contracts,
  optimizer result checks, and weaknesses in performance instrumentation. Its
  SQL-counting and Map-iteration findings were addressed and verified.

No new expected failures were introduced. The earlier report documents the five
defects represented by the existing 13 Python expected failures and three Node
TODO cases; production fixes were outside this test-only request.

## Running

The existing `npm test` command discovers all new Node modules. For Python,
initialize a disposable local PostgreSQL database from `schema.sql`, configure
the process-local `PG_HOST`, `PG_PORT`, `PG_DB`, `PG_USER`, `PG_PASS`, and
`PG_SSLMODE`, and set `NIMBUS_TEST_DB=1` and `NIMBUS_REQUIRE_TEST_DB=1` before
running pytest. The catalog fixture also invokes the application's existing
idempotent plant-constraints bootstrap, as normal app startup does.

Verification used a separate temporary cluster bound to `127.0.0.1`; the live
Azure environment and collection-time database safety guard were unchanged.
Fixtures own uniquely named records and clean up their own data. The tests are
automatically included in the existing full test commands.
