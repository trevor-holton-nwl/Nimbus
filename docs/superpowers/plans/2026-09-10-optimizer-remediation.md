# NIMBUS Optimizer Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make setup-aware optimizer results correct, self-contained, diagnosable, responsive, and deterministically better across Min Changeover, Due Date, and SPT.

**Architecture:** Normalize an immutable run context and read model at the Engine boundary, then pass them through the existing detached scheduler. Centralize objective facts, final comparison, and one shared search budget. Run preview candidates through a cancellable worker while retaining the synchronous evaluator for tests and non-UI callers.

**Tech Stack:** TypeScript `.mts` modules compiled in place to `.mjs`, Node’s built-in test runner, Web Worker message passing, existing Store/Calendar/SetupSnapshot models, npm build/lint/typecheck/test scripts.

**Spec:** `docs/superpowers/specs/2026-09-10-optimizer-remediation-design.md`

## Global Constraints

- Preserve the Sep-9 local-calendar hard bounds: SAP due dates only, null limits unbounded, missing due dates are exceptions when a configured limit applies.
- Preserve protected/firmed incumbents and fixed machine assignment; every fallback and final result remains validated.
- `respectCalendar` defaults to `true`; calendar-neutral runs ignore work hours and blackouts but retain protected occupancy, runtime, horizon, and SAP bounds.
- One five-second monotonic primary search budget is shared across all primary lines, fragments, arbitration candidates, and fallback searches; the approved one-second gap-fill budget is separate and visible.
- Keep the synchronous evaluator export for tests and non-UI callers; the preview worker is cancellable and ignores stale responses.
- Do not implement cross-machine reassignment, labor, material, or precedence constraints.
- Never modify or stage the pre-existing untracked `data/` directory.

---

### Task 1: Establish failing contract tests and typed run/read-model contracts

**Files:**
- Modify: `frontend/optimization/setup-scheduler.mts` types near `ScheduleSnapshot`, `DueDateFirstBounds`, `SetupRunContext`, and `SearchDiagnostics`
- Modify: `frontend/optimization/engine.mts` snapshot/run option types
- Test: `tests/modules/setup-scheduler.test.mjs`
- Test: `tests/modules/optimization/engine.test.mjs`
- Test: `tests/modules/optimization/optimize-ui.test.mjs`

**Interfaces:**
- Consumes: existing `ScheduleSnapshot`, `SetupSnapshot`, `OptimizerRunOptions`, and `DueDateFirstBounds`.
- Produces: `OptimizerRunContext`, `ObjectiveFacts`, `SearchBudget`, `ScheduleSnapshot.setupSnapshot`, `ScheduleSnapshot.readModelVersion`, and compatibility normalization for `now`/`runAt`.

- [x] **Step 1: Write failing tests** for a captured `runAt` distinct from a past `startDate`, snapshot setup data surviving Store mutation, `respectCalendar` defaulting true, and diagnostics exposing `exhaustive`/`quality`.
- [x] **Step 2: Run the focused tests** with `node --test tests/modules/setup-scheduler.test.mjs tests/modules/optimization/engine.test.mjs tests/modules/optimization/optimize-ui.test.mjs`; confirm the new assertions fail because the fields and normalization do not exist.
- [x] **Step 3: Add the minimal types and normalizers**. Preserve old fields and aliases, capture `readModelVersion` and setup data in `snapshotSchedule`, and keep generated `.mjs` output out of git.
- [x] **Step 4: Rebuild and rerun the three focused suites**; confirm the contract tests pass without changing scheduling behavior.
- [x] **Step 5: Commit** with `git add frontend/optimization tests/modules docs/superpowers/specs/2026-09-10-optimizer-remediation-design.md docs/superpowers/plans/2026-09-10-optimizer-remediation.md` followed by `git commit -m "feat: define optimizer remediation contracts"`.

### Task 2: Fix runNow/planningStart, scope, and hard horizon eligibility

**Files:**
- Modify: `frontend/optimization/engine.mts` `runAndApply`, `snapshotSchedule`, and pure planning-window helpers
- Modify: `frontend/optimization/setup-scheduler.mts` `eligibleTasks`, `validateCandidate`, bounds helpers, and result accounting
- Test: `tests/modules/optimization/engine.test.mjs`
- Test: `tests/modules/setup-scheduler.test.mjs`

**Interfaces:**
- Consumes: `OptimizerRunContext` and snapshot revision from Task 1.
- Produces: one scoped task set, `placementStart` enforcement, `invalid_horizon` result, and unchanged out-of-window schedules.

- [x] **Step 1: Add failing tests** proving a past planning start cannot place new work before `runNow`, a future planning start is a placement floor, queued/in-window orders receive dispositions, fully out-of-window schedules remain unchanged, `start === horizonEnd` is excluded, and reversed dates return `invalid_horizon` with no patches.
- [x] **Step 2: Run only those tests** and verify each fails against the current `horizonStart`/`isAged` implementation and all-task `eligibleTasks`.
- [x] **Step 3: Normalize the context once** at `runAndApply`/`evaluateSchedule` entry; use `planningStart` for scope and `placementStart` for new placement, and pass a precomputed scoped read set into detached evaluation instead of post-filtering patches.
- [x] **Step 4: Update validation and dispositions** so only the normalized scope is accounted for while protected boundary orders remain immutable obstacles.
- [x] **Step 5: Run focused Engine and scheduler tests**, then commit with `git commit -m "fix: separate optimizer horizon and run clocks"`.

### Task 3: Implement calendar-neutral setup-aware placement

**Files:**
- Modify: `frontend/optimization/setup-scheduler.mts` `DueDateFirstBounds`, `SetupRunContext`, availability helpers, placement, validation, and gap fill
- Modify: `frontend/optimization/engine.mts` setup-aware bounds construction
- Test: `tests/modules/setup-scheduler.test.mjs`
- Test: `tests/modules/optimization/engine.test.mjs`

**Interfaces:**
- Consumes: normalized context and scoped snapshot from Tasks 1–2.
- Produces: `respectCalendar` behavior shared by production, setup, validation, and gap fill.

- [x] **Step 1: Add failing tests** with a working-hours gap and blackout where `true` skips the gap and `false` schedules continuously, including a setup interval and a protected order.
- [x] **Step 2: Run the calendar tests** and verify setup-aware evaluation currently ignores the request flag and rejects/segments incorrectly.
- [x] **Step 3: Add the calendar branch**: snapshot calendars/blocks for `true`; one continuous interval from `placementStart` to `horizonEnd` for `false`; force `never` splitting only in the false branch.
- [x] **Step 4: Route validation and gap fill through the same helper** and ensure `respectCalendar` is recorded in the run context/diagnostics.
- [x] **Step 5: Run the focused suites and commit** with `git commit -m "fix: honor calendar mode in setup-aware optimizer"`.

### Task 4: Correct unknown tails, coverage facts, and canonical arbitration

**Files:**
- Modify: `frontend/optimization/setup-scheduler.mts` search grouping, tail placement, objective scoring, `compareCandidate`, `finalObjective`, `compareFinalObjectives`, `refreshFinalMetrics`, and boundary fallback
- Test: `tests/modules/setup-scheduler.test.mjs`
- Test: `tests/modules/optimization/engine.test.mjs`

**Interfaces:**
- Consumes: scoped/context-aware scheduler from Tasks 1–3.
- Produces: `ObjectiveFacts`, strict `unknownTail`, separate unknown/uncovered diagnostics, and one mode-aware comparator.

- [x] **Step 1: Add failing tests** for null-signature orders being tail-only, known uncovered transitions remaining in the searchable core, Min Changeover preferring fewer uncovered edges when delivery facts tie, and final arbitration retaining the same decision as search.
- [x] **Step 2: Run those tests** and confirm null orders are interleaved and the Min Changeover branch skips both coverage and over-cap terms.
- [x] **Step 3: Partition unresolved successor states into `unknownTail`** and place them deterministically after the known core without charging synthetic setup; preserve unknown incoming state for known signatures as a warning-only core edge.
- [x] **Step 4: Build `ObjectiveFacts` from the final validated schedule**, populate compatibility score slots 6/7, and make all search/fallback/final arbitration calls use the same mode comparator.
- [x] **Step 5: Run all scheduler and Engine optimizer tests**, then commit with `git commit -m "fix: score optimizer coverage consistently"`.

### Task 5: Enforce one budget and honest diagnostics

**Files:**
- Modify: `frontend/optimization/setup-scheduler.mts` `SearchBudget`, search loops, Min Changeover arbitration, diagnostics aggregation, and gap-fill reporting
- Modify: `frontend/optimization/engine.mts` deadline construction and result metadata
- Test: `tests/modules/setup-scheduler.test.mjs`
- Test: `tests/modules/optimization/engine.test.mjs`

**Interfaces:**
- Consumes: canonical result/objective from Task 4.
- Produces: shared `SearchBudget`, exact/heuristic/exhaustive diagnostics, and distinct queue reasons.

- [x] **Step 1: Add failing fake-clock tests** where multiple lines and Min Changeover baseline/candidate searches share one absolute deadline and where a converged heuristic result reports `exhaustive: false`.
- [x] **Step 2: Run the tests** and confirm the current per-line/per-candidate budget reset and `isSearchConclusive` semantics fail them.
- [x] **Step 3: Thread one budget object** through every primary search and make iteration counts global; cap baseline work without creating a second deadline; keep gap fill on its separate one-second budget.
- [x] **Step 4: Add diagnostic aggregation and queue-reason mapping** so only proven complete searches emit `no_fit_found`.
- [x] **Step 5: Run focused tests and commit** with `git commit -m "fix: report optimizer search completeness honestly"`.

### Task 6: Complete detached snapshot isolation and apply validation

**Files:**
- Modify: `frontend/optimization/engine.mts` `snapshotSchedule`, synthetic setup creation, source accessors, planning-window helpers, and apply path
- Modify: `frontend/optimization/setup-scheduler.mts` validation context and read-model access
- Test: `tests/modules/optimization/engine.test.mjs`
- Test: `tests/modules/setup-scheduler.test.mjs`

**Interfaces:**
- Consumes: `ScheduleSnapshot.setupSnapshot`, `readModelVersion`, and context from earlier tasks.
- Produces: detached evaluation independent of live Store setup/master data and stale read-model rejection.

- [x] **Step 1: Add failing tests** that mutate Store setup rows, calendars, rank maps, due limits, and frozen horizon after snapshot capture; detached output must remain unchanged and apply must report `stale_candidate` after a revision change.
- [x] **Step 2: Run the isolation tests** and confirm current synthetic setup and Engine closures read live Store state.
- [x] **Step 3: Clone setup truth and revision metadata** into snapshots, derive synthetic setup from the clone, and replace live closures with snapshot-based maps/pure functions.
- [x] **Step 4: Include the complete read model in validation context** and reject stale setup/master-data revisions at apply time.
- [x] **Step 5: Run focused suites and commit** with `git commit -m "fix: isolate optimizer snapshots from live state"`.

### Task 7: Add cancellable worker preview execution

**Files:**
- Create: `frontend/optimization/optimizer-worker-contract.mts` clone-safe request/response and validation types
- Create: `frontend/optimization/optimizer-worker-client.mts` worker adapter and synchronous fallback
- Create: `frontend/optimization/optimizer-worker.mts`
- Modify: `frontend/optimization/optimize-ui.mts` preview scheduling, cancellation, and diagnostics
- Modify: `frontend/optimization/engine.mts` worker candidate validation rehydration
- Test: `tests/modules/optimization/optimize-ui.test.mjs`
- Test: `tests/modules/optimization/engine.test.mjs`
- Test: `tests/modules/optimization/optimizer-worker.test.mjs`

**Interfaces:**
- Consumes: serializable `ScheduleSnapshot`, `OptimizerRunContext`, and synchronous evaluator from Tasks 1–6.
- Produces: `OptimizerWorkerRequest { runId, mode, snapshot, request }`, clone-safe `SerializedOptimizerValidation`, and `OptimizerWorkerResponse { runId, candidate?, validation?, error?, stack? }`; stale/cancelled responses are ignored.

- [x] **Step 1: Add failing worker-adapter tests** for request cloning, cancellation, stale run IDs, and primary/alternate diagnostics.
- [x] **Step 2: Run the UI tests** and verify the current synchronous `requestAnimationFrame`/`setTimeout` path cannot satisfy cancellation or stale-response behavior.
- [x] **Step 3: Extract the worker entrypoint** to call the synchronous detached evaluator with no Store/DOM dependency and implement a main-thread adapter with run IDs and cancellation.
- [x] **Step 4: Route setup-aware preview candidates through the worker** while retaining the synchronous export for tests/non-UI callers; keep alternate candidates explicitly labelled and budgeted.
- [x] **Step 5: Run the UI/Engine focused suites and commit** with `git commit -m "feat: run optimizer previews in a worker"`.

### Task 8: Improve deterministic search quality for all setup-aware modes

**Files:**
- Modify: `frontend/optimization/setup-scheduler.mts` exact/greedy sequence generation and mode seed selection
- Modify: `frontend/optimization/optimize-ui.mts` preview explanation of heuristic quality if needed
- Test: `tests/modules/setup-scheduler.test.mjs`
- Test: `tests/modules/optimization/optimize-ui.test.mjs`

**Interfaces:**
- Consumes: shared budget, diagnostics, unknown-tail behavior, and canonical comparator from Tasks 1–7.
- Produces: deterministic multi-seed bounded local search without machine reassignment.

- [x] **Step 1: Add failing quality tests** with fixtures where one seed misses a better legal sequence: Min Changeover must compare setup-nearest/grouped/policy/runtime seeds, Due Date must compare due/slack/runtime/policy/source seeds, and SPT must apply stable runtime/due/policy/current-order/source ties.
- [x] **Step 2: Run the quality tests** and confirm the current single-seed greedy paths select the inferior sequence.
- [x] **Step 3: Add bounded deterministic seed evaluation** and insertion/swap/beam improvements, stopping on the shared deadline/iteration cap and preserving admission semantics.
- [x] **Step 4: Mark heuristic diagnostics accurately** and ensure every candidate goes through hard-bound, calendar, coverage, and final validation.
- [x] **Step 5: Run scheduler/UI focused suites and commit** with `git commit -m "feat: improve deterministic optimizer search quality"`.

### Task 9: Update optimizer routing documentation and future-work boundary

**Files:**
- Modify: `frontend/optimization/CLAUDE.md`
- Modify: `docs/architecture/optimizer-dispatch.md`
- Modify: `docs/superpowers/specs/2026-09-10-optimizer-remediation-design.md` only if implementation decisions materially change

**Interfaces:**
- Consumes: shipped behavior from Tasks 1–8.
- Produces: accurate routing, mode, budget, worker, snapshot, and future-capability documentation.

- [x] **Step 1: Search the docs** for stale legacy paths, per-line budget claims, missing `respectCalendar`, and statements that null signatures are already tail-partitioned.
- [x] **Step 2: Update the docs** to name the live modules and exact contracts, and document cross-machine/labor/material/precedence as future work.
- [x] **Step 3: Run the focused tests** after documentation edits and commit with `git commit -m "docs: align optimizer routing and contracts"`.

### Final verification gate

- [x] Run `npm run build` and inspect the full exit output.
- [x] Run `npm run lint` and inspect the full exit output.
- [x] Run `npm run typecheck` and inspect the full exit output.
- [x] Run `npm test` and inspect the full exit output.
- [x] Run `git status --short` and verify only intended tracked files changed; `data/` remains untracked and untouched.
- [x] Review `git diff --check` and the commit list before reporting completion.
