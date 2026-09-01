# Changeover Matrix Stage 1 Implementation Plan

> **Behavior revised 2026-08-18:** the fail-closed rule ("missing edges leave the line unchanged") is
> superseded — the optimizer now schedules orders with missing setup data at the tail of their day bucket
> with no setup bar plus an alert; lines are never frozen. See `docs/changeover_matrix.md` and
> `docs/architecture/optimizer-dispatch.md`.

> **Status: shipped.** Every task below reads as an unticked checkbox, but this entire vertical slice
> landed across ~50 commits well before this note was added (see `docs/changeover_matrix.md`'s "Status"
> line and §1.1's correction, and `docs/Setup_matrix_redesign.md` §15 for what changed on top of it).
> The checkboxes were never updated as work completed — **do not treat an unticked box here as evidence
> a task is undone; trust `git log`/the current codebase instead** (`web/setup-scheduler.mts`,
> `setup_data.py`, `schema.sql`'s setup tables).

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make setup time schedule-real for Due-date first—and preserve pure SPT ordering with real setup capacity—as one complete vertical slice: private candidate evaluation, placement, split/fixed rules, capacity and alerts, derived Gantt bars, preview explanations, and manual reflow.

**Architecture:** Stage 1 consumes the versioned data and pure resolution contracts from Stage 0. A pure setup-aware scheduling layer evaluates immutable snapshots and returns patches, scores, explanations, and bounded diagnostics; it never mutates `Store`. Existing `Engine` delegates Due-date-first evaluation to that layer, `OptimizerPreview` renders detached before/after data, and Apply is the sole Store commit. Main-thread and worker compute share setup interval semantics.

**Tech Stack:** TypeScript ES modules, vanilla DOM, vis-timeline, Web Worker, UMD compute core, Node test runner, existing FastAPI snapshot APIs.

## Global Constraints

- `docs/changeover_matrix.md` remains authoritative.
- Stage 0 exit gates must be met for the activation plant before Stage 1 starts.
- Do not ship setup charging without setup-aware sequencing, derived bars, alert/utilization parity, preview explanation, and reflow in the same release.
- Setup is contiguous immediately before the first productive segment and never occupies closed/blackout time.
- Setup occurrences are derived; never persist pseudo-orders or adjacency links.
- Candidate search operates on immutable snapshots. Intermediate candidates never enter Store, render, persist, publish alerts, or trigger autosave.
- One explicit user action creates at most one candidate run and one commit. Alerts never recursively invoke optimization.
- Missing non-diagonal edges cannot win. If a line has no covered feasible sequence, leave that line unchanged without blocking unaffected lines. **(Revised 2026-08-18 — superseded, see top-of-doc note: the line is no longer left unchanged; uncovered orders are tail-placed with no setup bar plus an alert.)**
- Valid occurrence overrides protect their exact adjacency. Fixed-order boundaries and Remove Backlog's documented exception remain intact.
- Signature-incompatible lines are excluded from setup-aware optimization with a reported reason; they do not block unaffected lines.
- Setup bars are non-editable/non-selectable, but equivalent detail must be keyboard-accessible through the successor order.
- During drag, perform no setup lookup or adjacency rebuild per animation frame; rebuild affected old/new lines once after drop/cancel.
- Maintain main-thread/worker alert and utilization parity.
- Use a fixed clock or relative dates in scheduling tests.

## Stage Boundary

**Consumes from Stage 0:** Versioned `SetupSnapshot`, pure `stateForOrder`/`resolveSetup`, accepted reachable coverage, current line state, occurrence overrides, permissions, and measured search/performance budgets.

**Produces for Stage 2:** A policy-neutral pure candidate evaluator, stable lexicographic scoring, structured preview explanation/diagnostics, one enabled setup-aware policy (`Smart / Due-date first`), and pure SPT ordering that reserves covered setup without using setup as a sort term.

**Explicitly excluded:** Enabling Min Changeover/available slack or Throughput first, shared molds, global solving, persistent explanations, or automatic maintenance resets.

---

### Task 1: Extract immutable candidate evaluation from the mutating preview path

**Files:**
- Create: `web/setup-scheduler.mts`
- Create: `tests/modules/setup-scheduler.test.mjs`
- Modify: `web/schedule-services.mts`
- Modify: `web/schedule-workbench.mts`
- Modify: `tests/modules/schedule-services.test.mjs`
- Modify: `tests/modules/schedule-workbench.test.mjs`

**Interfaces:**

```ts
export interface CandidateResult {
  patches: ReadonlyArray<SchedulePatch>;
  score: readonly number[];
  explanation: ReadonlyArray<CandidateReason>;
  diagnostics: SearchDiagnostics;
  unchangedLines: readonly string[];
  missingEdges: readonly MissingSetupEdge[];
}
export function evaluateSchedule(snapshot: Readonly<ScheduleSnapshot>, request: EvaluationRequest): CandidateResult;
export function applySchedulePatches(patches: ReadonlyArray<SchedulePatch>): void;
```

- [ ] **Step 1: Characterize current `Engine.runAndApply` and `OptimizerPreview.runWithPreview` behavior with tests that detect temporary Store mutation/publication.**

- [ ] **Step 2: Add failing tests requiring `evaluateSchedule` to leave Store revision, tasks, fixed IDs, alerts, autosave calls, and timeline items unchanged.**

- [ ] **Step 3: Extract snapshot construction, evaluation, patch generation, and explicit patch application while preserving legacy non-setup mode behavior.**

- [ ] **Step 4: Change preview to compare detached before/after snapshots and commit only from `OptimizerPreview.apply()`. Discard/close must destroy candidate details without rollback because Store was never changed.**

- [ ] **Step 5: Run focused services/workbench/scheduler tests, then `npm run typecheck` and `npm run lint:errors`.**

- [ ] **Step 6: Commit with `refactor: evaluate optimizer candidates off store`.**

### Task 2: Implement setup-aware contiguous placement and split policies

**Files:**
- Modify: `web/setup-scheduler.mts`
- Modify: `web/schedule-services.mts`
- Modify: `tests/modules/setup-scheduler.test.mjs`
- Modify: `tests/modules/split-order.test.mjs`
- Modify: `tests/modules/remove-backlog.test.mjs`

**Interfaces:**
- `placeWithSetup(request) -> PlacementResult` returns setup interval plus productive segments or a typed infeasibility.
- `PlacementResult.setup` is absent for covered zero, present with exact full duration for positive setup, and unresolved for missing initial/transition state.

- [ ] **Step 1: Add failing tests for `never`, `overlong_only`, and `partial_allowed`, including the fixed 30-minute productive minimum and the complete-unsplit-under-30 exception.**

- [ ] **Step 2: Test that setup alone or partial setup near shift end places nothing and moves complete setup plus required production to the next feasible block.**

- [ ] **Step 3: Test downtime state preservation, split continuation without repeated setup, and defensive intervening-order transitions.**

- [ ] **Step 4: Implement contiguous placement using existing calendar windows without changing the persisted `order_schedule_segments` shape.**

- [ ] **Step 5: Preserve Remove Backlog sequence and its `never` overlong compatibility exception; use current line state only as the predecessor of its first resulting order.**

- [ ] **Step 6: Run split, backlog, scheduler, and services tests; commit with `feat: place production with setup capacity`.**

### Task 3: Implement fixed boundaries, override protection, and deterministic Due-date-first search

**Files:**
- Modify: `web/setup-scheduler.mts`
- Modify: `web/schedule-services.mts`
- Modify: `tests/modules/setup-scheduler.test.mjs`
- Modify: `tests/modules/schedule-services.test.mjs`

**Interfaces:**
- `evaluateDueDateFirst(snapshot, bounds) -> CandidateResult` uses Stage 0's measured exact-search threshold and deterministic greedy/local fallback.
- Lexicographic score order is hard feasibility/constraints, policy precedence, late count/lateness, admitted due work, setup minutes, deterministic sequence key.

- [ ] **Step 1: Add free/fixed boundary tests for incoming setup, fixed outgoing state, next-fixed boundary condition, and infeasible incoming setup that preserves the fixed production run.**

- [ ] **Step 2: Add tests proving active overrides protect exact adjacency and become inactive when a binding changes rather than following an order.**

- [ ] **Step 3: Add deterministic rerun, repeated-state elimination, iteration/time termination, and strict-improvement tests using an injected clock/budget.**

- [ ] **Step 4: Add missing-edge tests: exclude uncovered alternatives, report them, preserve an infeasible line, and still optimize unaffected lines.**

- [ ] **Step 5: Add pure SPT tests proving productive runtime alone determines order, covered setup still consumes capacity, and a missing required edge leaves the line unchanged rather than secretly selecting a different SPT sequence.**

- [ ] **Step 6: Implement group eligibility as same line plus fully known state while retaining policy tiers and order due obligations. Exclude setup-incompatible lines before candidate generation and report them as unchanged.**

- [ ] **Step 7: Run focused tests multiple times to prove deterministic output; commit with `feat: add setup-aware due date search`.**

### Task 4: Add setup utilization and alert parity to the compute core and worker

**Files:**
- Modify: `web/nimbus-compute-core.js`
- Modify: `web/nimbus-compute-core.d.ts`
- Modify: `web/nimbus-worker.ts`
- Modify: `web/schedule-services.mts`
- Modify: `tests/js/compute-core.test.js`
- Modify: `tests/modules/schedule-services.test.mjs`
- Modify: `tests/modules/split-order.test.mjs`

**Interfaces:**
- Worker snapshots carry only plant/line-scoped resolved setup intervals and state diagnostics.
- `computeUtilization` counts productive plus setup occupied hours.
- `computeAlerts` adds `setup-violated`, `setup-uncovered`, `initial-state-unknown`, `current-state-diverged`, and `override-inactive` diagnostics.

- [ ] **Step 1: Add parity fixtures covering positive/zero/missing setup, split schedules, fixed boundaries, and overrides.**

- [ ] **Step 2: Test uncovered alert deduplication by pair/scope and required/available/short-minute details for violations.**

- [ ] **Step 3: Implement one shared setup-interval representation; do not independently re-resolve matrix rows inside both main and worker paths.**

- [ ] **Step 4: Prove alert computation/publication never calls `Engine`, including after explicit Fix It completes.**

- [ ] **Step 5: Measure worker structured-clone cost with representative scoped setup data and record it in `PerfMonitor`.**

- [ ] **Step 6: Run legacy core, module services, split tests, typecheck, and build; commit with `feat: include setup in capacity diagnostics`.**

### Task 5: Render semantic derived setup items and accessible order detail

**Files:**
- Modify: `web/schedule-workbench.mts`
- Modify: `web/types.mts`
- Modify: `web/styles.css`
- Modify: `web/locales/en.js`, `de.js`, `es.js`, `fr.js`, `pt.js`
- Modify: `tests/modules/schedule-workbench.test.mjs`
- Modify: `tests/modules/locale-completeness.test.mjs`

**Interfaces:**
- Timeline item `kind` is `order | order-segment | setup | blackout | zone`.
- Positive setup renders an exact interval before processing; zero renders nothing; missing renders a leading-edge warning marker.
- Successor tooltip/Inspector exposes predecessor state, required/effective/standard minutes, source, override status, and missing detail.

- [ ] **Step 1: Add tests for derived item timing, zero/missing behavior, split first segment, override label, and conflict rendering at full required duration.**

- [ ] **Step 2: Add interaction-guard tests for click, double-click, hover, context menu, marquee, selection, focus, dependency, drag, and ghost paths; setup items must never resolve to business orders.**

- [ ] **Step 3: Replace scattered item-ID assumptions in touched paths with semantic `kind` dispatch and line/task indexes.**

- [ ] **Step 4: Implement accessible successor-order detail and ensure color/hatch/hover is not the sole carrier of meaning.**

- [ ] **Step 5: Apply existing design tokens, hairlines, signal colors, typography, and dark-mode remaps; do not introduce a new status-color family.**

- [ ] **Step 6: Run focused workbench/locale tests, lint, typecheck, and build; commit with `feat: render derived setup intervals`.**

### Task 6: Make drag and manual reflow setup-aware within the performance contract

**Files:**
- Modify: `web/schedule-workbench.mts`
- Modify: `web/schedule-services.mts`
- Modify: `tests/modules/schedule-workbench.test.mjs`
- Modify: `tests/modules/schedule-services.test.mjs`

**Interfaces:**
- Direct drops are honored even when incoming setup is short; they create diagnostics.
- Reflow is one deterministic forward walk that preserves sequence, reserves setup, moves only permitted peers, and stops at impossible fixed boundaries.
- `Timeline.rebuildSetupForLines(lines: ReadonlySet<string>)` batches all additions/updates/removals once.

- [ ] **Step 1: Add tests for same-line and cross-line single/multi-order drag, cancel/revert, predecessor/successor invalidation, fixed stop, and short incoming setup.**

- [ ] **Step 2: During drag, hide/dim setup items only on affected lines while preserving existing production ghosts. Assert no resolution/rebuild occurs in animation-frame callbacks.**

- [ ] **Step 3: After drop/cancel, resolve and batch-rebuild affected old/new lines once; never full-plant rebuild for a one-order move.**

- [ ] **Step 4: Instrument derivation, diff, redraw, and worker clone time through `PerfMonitor`; benchmark representative positive-setup density and rapid cross-line drag.**

- [ ] **Step 5: Meet the Stage 0 interaction budget or keep plant activation disabled and document the measured blocker.**

- [ ] **Step 6: Run focused tests and commit with `feat: make drag reflow setup aware`.**

### Task 7: Complete preview explanation, stale invalidation, and missing-setup review

**Files:**
- Modify: `web/schedule-workbench.mts`
- Modify: `web/plant-and-administration.mts`
- Modify: `web/schedule-data.mts`
- Modify: `tests/modules/schedule-workbench.test.mjs`
- Modify: `tests/modules/plant-and-administration.test.mjs`

**Interfaces:**
- Preview shows before/after production, setup, occupied time, lateness, utilization, sequences, concise accepted/rejected reasons, constraints, missing edges, unchanged lines, candidate count, method, termination, runtime, and limit status. **(Revised 2026-08-18 — superseded, see top-of-doc note: the never-freeze rework added a separate `scheduledWithoutSetup {orders, lines}` tally for orders scheduled without setup bars, rendered as its own banner alongside — not instead of — "unchanged lines," which still means lines actually left in place.)**
- `Review missing setups` opens the editor filtered to relevant pairs for writers; readers retain copy/export only.

- [ ] **Step 1: Add tests for bounded/aggregated explanations and confirm full per-candidate schedule snapshots are not retained.**

- [ ] **Step 2: Add tests that apply/discard/close destroys explanation data and writes none to Postgres, localStorage, audit logs, or permanent caches.**

- [ ] **Step 3: Add tests that any definition/matrix/state/override write marks an open preview stale, disables Apply, and requires explicit rerun.**

- [ ] **Step 4: Implement copy-friendly and CSV-exportable missing-pair tables and permission-aware review action. Saving in the editor must not silently rerun preview.**

- [ ] **Step 5: Run focused tests and commit with `feat: explain setup optimizer previews`.**

### Task 8: Activate Due-date first and verify the complete vertical slice

**Files:**
- Modify: `web/plant-and-administration.mts` or the existing settings owner for per-plant activation.
- Modify: `docs/MIGRATION.md`
- Modify: `docs/archive/changeover_matrix_stage_1.md` only to record checked gates and measurements during execution.

- [ ] **Step 1: Keep activation disabled unless definition/version, reachable coverage, current-state acknowledgement, and performance gates all pass.**

- [ ] **Step 2: Verify safe disable prevents new setup-aware runs but leaves bars, durations, states, overrides, missing markers, and alerts visible.**

- [ ] **Step 3a: Run `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `pytest -m "not pg"`, and `ruff check .`.**

- [ ] **Step 3b: Before going into step 4 - keep this in mind. The goal is not perfection in testing. We have done MANY code reviews. We are aiming for simplistic testing to catch BIG issues. We don't want to be testing for issues that are minor. That is true user testing anyways and can burn unnessecary tokens.**

- [ ] **Step 4: Unless this test is absolutely CRITICAL - continue to step 5. I will be unavailable for prompting so it is encouraged to move on to Step 5 unless you are unwaveringly confident this needs to be done now. Otherwise, we can note for later or at the end of this full Stage Plan. Details for this step: With a safe local DB, run setup endpoint/data/schema tests and the full `@pytest.mark.pg` subset.**

- [ ] **Step 5: If you run into errors spinning it up - do not prompt me, I will be unavailable. Continue to step 6 and call out to me as a note. Step 5 details: Perform browser UAT for matrix update -> stale preview -> rerun -> apply, manual drag/reflow, split policies, fixed boundaries, unknown state, overrides, and rapid cross-line drag.**

- [ ] **Step 6: Capture representative performance results, and deployment/migration implications in the PR; commit with `feat: activate setup-aware due date scheduling`.**

## Stage 1 Exit Gate

- Preview candidates never mutate Store before Apply.
- Due-date-first charges setup and sequences with the same setup truth.
- SPT remains pure shortest productive processing time while covered setup consumes real capacity; missing setup leaves its line unchanged. **(Revised 2026-08-18 — superseded, see top-of-doc note: missing setup no longer leaves the line unchanged; the affected order is tail-placed with no setup bar plus an alert.)**
- Split policies, fixed boundaries, current state, missing edges, and active overrides match the authoritative design.
- Worker/main-thread alerts and utilization are parity-pinned.
- Setup items are exact-time, semantic, non-business items with accessible successor detail.
- Direct drag remains honored; downstream reflow is deterministic and setup-aware.
- Setup derivation/diff/redraw/clone performance meets the accepted budget.
- Matrix changes stale previews but never optimize or move existing orders automatically.
- All automated gates and browser UAT pass before activation.

## Recovery / Token-Limit Handoff

On a new session, read only:

1. This file.
2. Stage 0's exit-gate/results section.
3. `docs/changeover_matrix.md` sections 4-10 and 12-14 when resolving ambiguity.
4. The latest checked task and recent commits.

Resume at the first unchecked step and rerun its focused tests before editing.
