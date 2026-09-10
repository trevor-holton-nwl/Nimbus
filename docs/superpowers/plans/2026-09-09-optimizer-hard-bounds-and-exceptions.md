# Optimizer Hard Bounds and Planning Exceptions Implementation Plan

> Execute task by task using superpowers:subagent-driven-development and verification-before-completion.

**Goal:** Enforce optimizer date windows while durably retaining unplaced demand.
**Architecture:** Extend the existing detached scheduler, task aggregate, explicit-save and grid contracts. Keep the existing calendar placement primitive and setup resolver.
**Tech Stack:** TypeScript, Node test runner, FastAPI/Pydantic, psycopg/PostgreSQL, pytest.
**Spec:** ../specs/2026-09-09-optimizer-hard-bounds-and-exceptions-design.md

## Global constraints

- Local calendar-day arithmetic and naive-local wire timestamps.
- No production DB tests; preserve database collection guard.
- Preserve unrelated working-copy edits; implement in feature worktree.
- No compiled frontend artifacts committed; build before tests.
- Existing non-optimizer policies and bulk best-effort callers stay compatible.

## Task 1: Durable planning state and atomic save

Files: schema.sql, migrations/2026-09-09_optimizer_planning_exceptions.sql, db.py, backend/scheduling/models.py, backend/scheduling/routes.py, integration ingest paths where necessary, tests/test_planning_exceptions.py.

Interface: planning_status = scheduled | needs_planning; planning_reason = nullable JSON object with code and message. Task dates nullable for queue. TasksUpdatePayload.atomic_optimizer boolean defaults false. Atomic failures persist zero rows and return existing stale/invalid/not_found accounting; force ignored and base_version required.

- [x] Reproduce nullable-date hydration and partial/version-bypass save risks with focused regression tests.
- [x] Add idempotent migration and schema fields/checks; clear queue dates and segments transactionally without changing SAP baseline.
- [x] Extend scoped query/count/refresh/read DTOs and preserve status across SAP ingest.
- [x] Add opt-in whole-batch validation/locking and rollback on any rejection; legacy route response behavior preserved.
- [x] Run guarded local Python tests and Ruff on modified Python.

## Task 2: Shared hard-bound scheduling and validation

Files: frontend/optimization/setup-scheduler.mts, scheduler-contract.mts, engine.mts; new leaf module if needed; tests/modules/setup-scheduler.test.mjs and optimization/engine.test.mjs.

Interface: CandidateResult gains dispositions, validation findings, search completeness. Queue patches set planning_status/structured reason, null dates, scheduleSegments: []; scheduled patches clear reason. All three modes share hard-bound enforcement.

- [x] Add failing acceptance tests for capacity overflow, violating baselines, all fallback paths, urgency, missing setup and timeout.
- [x] Compute SAP-only windows; clip availability at both bounds; continue after individual failures and account for every eligible order.
- [x] Compare urgency admission before strategy objective; retain valid incumbent and alternative sequences within budget.
- [x] Validate complete final outcomes including scope, segments/duration/calendar/setup occupancy/protected preservation. Recompute metrics including queues and expose incomplete search.
- [x] Route SPT synthetic/direct/preview consistently; preserve other modes.
- [x] Run focused scheduler and engine tests.

## Task 3: Queue hydration, explicit save, undo and planner UI

Files: frontend/platform/types.mts, store.mts, frontend/scheduling/persistence.mts, orders.mts, frontend/optimization/optimize-ui.mts, insights/services.mts and compute paths as needed; corresponding module tests.

Consumes task state and CandidateResult from Tasks 1/2. Uses existing grid column filters and current preview Apply boundary; no new selector pattern.

- [x] Add failing tests for queued hydration/normalization, atomic payload/failure dirty state, undo/retry, scoped visibility and reporting.
- [x] Extend frontend task/wire contracts; prevent SAP-baseline schedule restoration for queue in every load/refresh/normalization path.
- [x] Apply dependent queue/schedule patches together and one undo entry. Atomic save sends row versions without force; all failures retain dirty state.
- [x] Add status/reason/window to Orders and queue filtering, support existing date-edit return to scheduled.
- [x] Show proposal disposition counts, protected exceptions, warnings, and incomplete search; block stale/invalid Apply. Keep queued demand in reporting without utilization.
- [x] Run focused frontend tests.

## Task 4: Integration review and verification

- [x] Review full spec coverage and final diff; fix cross-layer issues.
- [x] Run npm test, npm run typecheck, npm run lint, npm run check:static-assets, npm run check:legacy-surface and relevant guarded Python checks.
- [x] Record actual verification results and deployment order in this plan. Prepare reviewable feature branch; do not deploy without completed verification.

## Execution ledger

Worktree: .worktrees/optimizer-hard-bounds; base ca9dc77. Existing root frontend/index.html and data/ edits preserved.
Ruling: perform implementation and verification before release actions; deployment readiness requires migration-first ordering.
Preflight: Tasks 1/3 share wire fields and atomic_optimizer; Tasks 2/3 share dispositions and patches; Task 4 verifies all. No conflicting requirements found. Structured reasons use snake_case codes consistently at wire and task level.

### Progress and evidence

- Task 1 implemented and reviewed with no confirmed backend defects. Initial six regressions failed before the implementation. Broadened real-DB coverage to exercise SAP upsert, scoped/paged horizon inclusion, and a trigger injecting failure on the second UPDATE. Guarded local PostgreSQL 18 at 127.0.0.1:55439, database nimbus_hard_bounds_test, created solely for this task. Relevant backend suite: 47 passed; Ruff passed.
- Task 2 implemented with hard-bound acceptance coverage. Baseline focused Node suite before code: 211 passed, 2 existing autoReflow failures caused by August fixtures aging past today's date. Pinning the clock in those two tests preserves their assertions and production reflow policy. Scheduler/engine suite reached 207 passed before final review added a two-order timeout regression.
- Task 3 implemented; queue hydration/atomic and status/reporting regressions each reproduced red before changes. Expanded integration suite: 105 passed. Offline dependent save metadata and persistent unsaved indicator added following cross-path inspection. Review found and fixed Undo restoring old row versions after Save, misleading queued-order toast wording, and normalization rounding validated setup timing. Each behavior has regression coverage.
- Setup-data confidence stays separate from protected date/capacity exceptions in preview counts. Final review found a hybrid baseline incumbent could discard valid urgent demand on timeout; the regression combines two six-hour orders and a ten-hour day at small search budgets.
- Browser validation attempted using browser skill: runtime exposes no browser connections (empty discovery list), so visual inspection remains unavailable in this session.
- Ruling: keep historical `_forceIds` name for existing cross-module callers but change its semantics to atomic version checks; never set force for optimizer saves. Cache quota degradation cannot trim a dependent optimizer outcome.


### Final verification

- Full `npm test` passed: 23 legacy tests and 563 module tests (586 total); its pretest compiled both frontend TypeScript projects successfully.
- Scheduler/engine focused suite: 211 passed. Final hard-bound acceptance suite: 18 passed, covering the independently repaired partial incumbents and the setup bridge before protected work. Review rechecked eight relevant regressions with no remaining findings for the reported issues.
- Frontend persistence/Orders/preview/Store/insights integration suite: 105 passed.
- `npm run typecheck`, `npm run check:static-assets`, `npm run check:legacy-surface`, and `git diff --check` passed.
- `npm run lint`: zero errors, 46 warnings. Two warnings introduced in the new timeout regression were removed; its 18-test acceptance suite was rerun successfully.
- Guarded local backend command: `pytest tests/test_planning_exceptions.py tests/test_task_concurrency.py tests/test_task_response_models.py tests/test_to_pydt.py tests/test_visibility_horizon.py tests/test_frozen_horizon.py tests/test_ingest_data_layer.py -q -p no:cacheprovider` with `PG_HOST=127.0.0.1`, `PG_PORT=55439`, `PG_DB=nimbus_hard_bounds_test`, `NIMBUS_TEST_DB=1`, and `NIMBUS_REQUIRE_TEST_DB=1`: 47 passed, two deprecation warnings. The test database guard remained enabled; no Azure/live database was used.
- `ruff check db.py backend/scheduling tests/test_planning_exceptions.py tests/test_task_response_models.py` passed.
- The additive migration was applied against the local schema and exercised again by real database tests. The deployment runbook documents migration-first release and queue-aware rollback constraints. No Azure migration or application deployment was performed.
- Browser visual QA remains unavailable because runtime browser discovery returned no connections. Automated UI contract tests passed; no visual verification is claimed.
- Integration: fold `feature/optimizer-hard-bounds` into `main` with a local merge commit, then remove its worktree and merged branch. The root build-ID edit and untracked `data/` remain untouched. Full merged-checkout verification repeated successfully: 23 legacy and 563 module tests, including the TypeScript build.

### Approved follow-up: final capacity check (2026-09-09)

- [x] Reproduce exhausted-search gaps, setup consumed on both sides, and an incomplete final check before implementation.
- [x] Add pure `fillPlanningGaps` after the chosen Due Date/SPT/Min Changeover proposal, with a separate soft 1,000 ms budget shared across all lines. Keep accepted production fixed, respect hard windows/calendars/blackouts/splits/override bindings, and retry earlier failures after setup bridges.
- [x] Recompute final metrics and validation, preserve insertions on expiration, and distinguish completed no-fit checks from unfinished checks in order reasons and preview. Clear recovered lines from unchanged-line notices.
- [x] Review machine-specific priority admission and successors beyond the search horizon; add failing regressions and fix both. Independent read-only review confirmed the corrections.
- [x] Verify 606 tests (23 legacy + 583 module), TypeScript build/typecheck, and lint with zero errors and the same 46 warnings. Sixteen focused regressions cover the final pass and preview, including protected overlaps/floors, missing setup, missing due/runtime/expired defects, selected lines, overrides, priorities, timeout retention and setup bridges.

Local Node benchmark, one-hour synthetic queued orders, 08:00-18:00 calendars over five days, zero setup, primary search already expired: 36 orders on one line all inserted in 122 ms; 700 orders on 70 lines all inserted in 533 ms. A full 300-order line stopped with 50 inserted and 80 unchecked in 1,015 ms; 2,100 orders across 70 lines stopped with 378 inserted and 1,722 unchecked in 1,141 ms. All four outcomes passed final validation. The latter elapsed times include validation after the soft search budget. These are local measurements, not browser latency guarantees.

This follow-up changes frontend scheduling and preview only. No database access, migration, build-ID bump, push, or Azure deployment was performed. Existing queue/undo/atomic persistence contracts consume the completed proposal. Root `data/` remains untouched.
