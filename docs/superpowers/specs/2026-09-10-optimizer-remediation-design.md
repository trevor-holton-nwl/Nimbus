# NIMBUS Optimizer Remediation Design

**Date:** 2026-09-10
**Status:** Approved for implementation
**Scope:** `frontend/optimization`, optimizer tests, and optimizer documentation

## Problem

The setup-aware optimizer already enforces the Sep-9 hard-bound contract, but several boundaries are incomplete. Min Changeover does not consistently score uncovered setup edges, final arbitration recomputes a smaller objective than search, unresolved signatures are not actually partitioned into the documented unknown tail, and `respectCalendar` stops at the legacy dispatcher. A selected planning start is also reused as the wall-clock floor, detached snapshots still depend on live Store setup/master-data reads, and the preview can start several independent five-second searches on the main thread.

These defects can produce a safe-looking candidate with a misleading quality signal, schedule a placement before the real run instant, or make a preview freeze while the search is still incomplete. This change preserves fixed machine assignment and the hard-bound/exception contract. Cross-machine reassignment, labor, material, and precedence constraints remain future architecture work.

## Decisions

### Run context and horizon

All optimizer paths normalize one `OptimizerRunContext`:

```ts
interface OptimizerRunContext {
  plant: string;
  planningStart: Date;       // user-selected From date
  runNow: Date;              // captured absolute run instant
  placementStart: Date;      // max(planningStart, runNow)
  horizonEnd: Date;          // exclusive upper bound
  respectCalendar: boolean;
  respectFirmed: boolean;
  lines: readonly string[] | null;
  deadlineAt: number;        // monotonic clock deadline
  readModelVersion: string;
}
```

`runAt` supplies `runNow`; a test-only `now` remains accepted as a compatibility alias. `DueDateFirstBounds.now` remains accepted by direct callers and normalizes to `placementStart`. Date-only planning inputs are interpreted in plant-local time. A past planning start widens the set of existing orders eligible for movement, but no newly generated production or setup starts before `placementStart`.

The optimizer scope contains queued orders and scheduled orders whose productive interval intersects `[planningStart, horizonEnd)`. Protected orders outside that interval may be carried only as immutable boundary/occupancy constraints. Scheduled orders wholly outside the interval remain unchanged and receive no optimizer disposition. `start_date === horizonEnd` is out of scope. Line filters and `excludeFromOpt` are applied before evaluation, never as a patch-only post-filter. Invalid or reversed horizons return a structured `invalid_horizon` result without patches.

### Calendar contract

`respectCalendar` is explicit on `DueDateFirstBounds` and `SetupRunContext`, defaulting to `true` for compatibility.

When true, availability is the line working calendar intersected with the plant working calendar, less blackout blocks. Both setup and production must fit, and the captured plant split policy applies. When false, availability is continuous between `placementStart` and `horizonEnd`; working-hour and blackout restrictions are ignored, but protected occupancy, runtime, SAP pull/push bounds, and hard horizon bounds remain. Calendar-neutral runs force `splitPolicy: 'never'`. Placement, validation, gap fill, and final metrics use the same branch.

### Setup state and unknown tails

An order with a null or invalid successor signature is an opaque order. It is removed from the setup permutation core and placed in a deterministic unknown tail after the known core. Unknown orders never provide a predecessor or successor setup state. Tail placement still obeys calendar, capacity, hard date bounds, and protected boundaries and reports `unknown-setup-tail-placement` (or `unknown-setup-tail-unplaced`).

A known-signature order whose machine's initial physical state is unavailable stays in the searchable core. Its incoming edge is reported as `initial-state-unknown` with zero setup. A known predecessor/successor pair with no matrix row stays in the core, reports `scheduled-without-setup`, and increments `uncoveredEdges`. Unknown edges and uncovered known edges are separate diagnostics.

### Canonical objective and final arbitration

Search and final arbitration use the same typed facts:

```ts
interface ObjectiveFacts {
  hardErrors: number;
  overCap: number;
  lateCount: number;
  latenessMinutes: number;
  uncoveredEdges: number;
  setupMinutes: number;
  scheduledCount: number;
  instabilityMinutes: number;
  policyKey: string;
  sequenceKey: string;
}
```

The existing eight-element `score` remains populated for UI/test compatibility; `score[6]` is `uncoveredEdges` and `score[7]` is `overCap` after final recomputation.

For Min Changeover, the lexicographic order is:

`feasibility → admission → over-cap → late count → lateness → uncovered edges → setup minutes → policy → scheduled count → instability → sequence`.

Due Date keeps delivery facts ahead of policy/setup. SPT keeps productive-runtime ordering after hard feasibility, admission, and coverage safeguards. `compareFinalObjectives` and firmed-boundary fallback call this same mode-aware comparator after final validation; they do not use a reduced due-date-only objective.

### Diagnostics and budgets

`SearchDiagnostics` gains the absolute deadline, budget, global iteration count, eligible/evaluated/placed counts, unknown-tail count, `exhaustive`, and `quality: 'exact' | 'heuristic'`. `termination: 'completed'` means the declared exact search finished; `termination: 'converged'` is explicitly heuristic with `exhaustive: false`. Deadline and iteration exhaustion set the compatibility `limitReached` flag. Queue reasons distinguish `no_fit_found`, `search_limit`, and `search_incomplete`.

One shared monotonic `SearchBudget` is passed through every line, fragment, Min Changeover baseline/candidate search, and fallback. The primary setup-aware search receives one five-second deadline per evaluator run. The approved one-second gap-fill pass remains a separate budget and is reported separately. Preview alternatives are separate labeled comparison runs, each with its own diagnostics, so no hidden budget is implied.

### Snapshot and runtime boundary

`ScheduleSnapshot` carries a cloned setup snapshot, frozen-horizon value, and read-model revision alongside tasks, calendars, blocks, plants, master data, line settings, ranks, and firmed IDs. Synthetic zero-cost setup data is derived from that captured snapshot. Detached planning-window and calendar helpers consume snapshot data rather than live Store closures. Apply-time validation compares the captured revision/read-model identity with the live Store.

Setup-aware preview evaluation runs in a cancellable Web Worker using a structured-clone request/response containing the snapshot, normalized context, mode, run ID, and deadline. A synchronous evaluator remains available for tests and non-UI callers. Stale or cancelled worker responses are ignored.

## Verification contract

The implementation adds regression coverage for:

- covered versus known-uncovered Min Changeover sequences, including final incumbent arbitration;
- strict null-signature tails, unknown incoming state, deterministic tail ordering, and tail overflow;
- calendar-respecting versus calendar-neutral setup and production placement;
- past planning starts, captured run instants, future planning starts, invalid/reversed horizons, and exact horizon boundaries;
- scoped dispositions and unchanged fully out-of-window schedules;
- global deadline/iteration accounting and exact versus heuristic diagnostics;
- self-contained setup/calendar/master-data snapshots and apply-time revision rejection;
- worker cancellation, stale-response handling, primary/alternate preview budgets, and main-thread responsiveness;
- deterministic multi-seed Min Changeover, Due Date, and SPT search quality.

Cross-machine, labor, material, and precedence behavior is documented as future work and has no implementation or acceptance criteria in this change.
