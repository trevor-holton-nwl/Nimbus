# Optimizer reason codes and deterministic schedule stability

**Status:** Reviewed design; ready for implementation planning

## Goal

Make NIMBUS automatic scheduling decisions explainable and repeatable. A
planner should be able to see why an order moved or did not move, why
alternative candidates were rejected, and why the selected candidate is the
best result found within the configured search limits.

The optimizer must also avoid unnecessary schedule churn: identical inputs
must produce identical results, and a candidate that is equal to or worse
than the current plan must not be applied automatically.

## Agreed product decisions

- Reason detail: run-level counts plus bounded order-level examples.
- Coverage: legacy optimization, setup-aware optimization, automatic reflow,
  and alert-driven fixes. Explicit manual drag/scheduling remains an
  intentional override.
- Stability policy: conservative. Preserve the existing schedule when
  objectives are equal; prefer fewer moved orders and less total movement.
- No-op policy: an optimization candidate that does not improve the accepted
  objective is not applyable. Constraint-repair actions may still move orders
  when movement is required to restore legality.
- Retention: detailed reasons remain in the detached candidate/preview.
  Optimization audit entries receive bounded aggregate counts only in the
  first release; task IDs and full order decisions remain preview-only. The
  file-backed audit remains operational telemetry, not a durable compliance
  record. No new database table is required by this design.
- Candidate explanation: the preview should show aggregate rejected/pruned
  candidate outputs where the search actually enumerates alternatives. Legacy
  dispatch should report blocked/unchanged order totals rather than pretending
  it evaluated alternate candidates.
- Determinism: a fixed search-work budget, with a stable charging rule, is the
  reproducibility contract. Candidate evaluations are reported separately
  from charged search work. A wall-clock emergency cutoff may fail closed, but
  must never be described as deterministic.
- Apply safety: a preview candidate is valid only against the complete captured
  optimizer input bundle. Any intervening change to a relevant task, calendar,
  blackout, fixed flag, rank map, setup record, line setting, or run option
  rejects the entire candidate rather than applying a partial patch set.

## Current state and gaps

The setup-aware scheduler already has `CandidateReason[]`, search diagnostics,
candidate scores, and a deterministic `sequenceKey`. The optimizer preview
already renders a bounded explanation and setup prune buckets.

The important gaps are:

- Legacy detached results return little or no explanation metadata.
- The preview infers accepted/rejected status from English text instead of an
  explicit outcome field.
- Setup search counts candidates but does not expose a complete aggregate of
  feasible and rejected alternatives.
- Several legacy equal-key comparators return `0`, allowing input order to
  influence the result.
- Legacy scheduling emits patches even when dates are unchanged.
- `autoReflow` and alert fixes do not return a common mutation report.
- The existing setup prune mapping is owned by the UI and can drift from the
  engine's reason vocabulary.
- The draft's no-op rule does not yet define a comparable baseline objective
  for legacy versus setup-aware evaluation.
- The draft's determinism claim conflicts with the current wall-clock search
  deadline.
- The existing audit write route accepts arbitrary client JSON and trusts a
  client-supplied actor header; adding task IDs to that payload would increase
  exposure without route hardening.
- `Store.updateMany()` silently skips missing task IDs, so stale previews could
  otherwise apply partially.
- Setup-aware evaluation currently searches every line in the plant and
  post-filters patches for `opts.lines` and `excludeFromOpt`. That makes the
  score, explanations, search budget, and no-op decision describe a different
  scope from the patch set that can actually be applied.
- `Store.rev()` increments for unrelated state such as alert/UI activity, while
  some optimizer inputs such as priority-rank maps can change without a Store
  revision. It is neither a precise nor a complete stale-preview guard.
- The Store and patch APIs are globally keyed by task ID. A collision has
  already overwritten a row before `snapshotSchedule()` runs, so a scoped
  fingerprint cannot make duplicate IDs safe.
- Preview Apply mutates local Store state, but durable PostgreSQL persistence is
  deferred to `Persistence.saveAll()`. An audit POST from Apply therefore
  cannot truthfully mean that the schedule was durably committed.

## Safety invariants for this change

Reason reporting and stability selection must not become a wrapper around
known placement inconsistencies. Before enabling the new behavior, all
automatic placement paths must satisfy the same effective bounds:

```text
earliest legal start = max(
  captured run-at instant,
  selected horizon start,
  configured pull-forward floor,
  applicable fixed/calendar boundary
)
```

The selected horizon is an optimization scope, not an implicit fixed-order
flag. Orders outside the scope remain untouched and are reported as
`horizon-out-of-scope`; they must not prevent eligible orders from moving.
Force-placement fallbacks must never bypass a pull-forward floor. Setup-aware,
legacy, auto-reflow, and alert-fix paths must use the same floor semantics.
`runAt` is captured once per preview/run and reused by the primary evaluation,
alternate-mode comparison, baseline evaluation, and all line searches. It is an
instant; plant timezone is used only when deriving plant-local day boundaries.

Release/material-availability and predecessor-ready floors are not added by
this change because NIMBUS does not yet have an authoritative scheduling input
for either one, and precedence/pegging remains a non-goal. The shared bounds
helper must provide an extension point for future authoritative floors, but it
must not infer one from due dates, notes, or other proxy fields.

The implementation must also close the already-observed setup-aware time
anchor, scope, and option-parity risks: setup-aware evaluation cannot schedule
before captured `runAt` merely because `From` is earlier; plant, line filter,
`excludeFromOpt`, horizon, `respectFixed`, `respectCalendar`, and split policy
must be applied before candidate generation; and fixed/calendar options must
have the same documented meaning in both scheduler families. Filtering patches
after a broader candidate was scored is forbidden.

Both scheduler families must use one plant/line scope resolver. Materialized
`task.PLANT` is authoritative when present; line-to-plant mapping is only a
compatibility fallback for a missing task plant. A disagreement or ambiguous
fallback is a `data-*` failure, not permission to move the row. Scope keys and
stable keys always include both plant and line because line codes may be reused
across plants at enterprise scale.

The current pull-forward regression changes in `web/schedule-services.mts`
and `tests/modules/schedule-services.test.mjs` are separate work and must be
preserved while this design is implemented.

## Proposed design

### 1. Shared diagnostics and stability contract

Introduce a pure module, proposed as `web/schedule-diagnostics.mts`, with no
Store, DOM, persistence, or API dependencies. It owns the shared types and
helpers used by both scheduler families.

```ts
type ReasonOutcome = 'accepted' | 'rejected' | 'unchanged' | 'not-considered';
type ReasonSeverity = 'info' | 'warning' | 'error';

type ReasonBucket =
  | 'placement' | 'fixed' | 'horizon' | 'pull-forward'
  | 'capacity' | 'calendar' | 'setup' | 'stability'
  | 'data' | 'search';

interface CandidateReason {
  code: ScheduleReasonCode;
  bucket: ReasonBucket;
  outcome: ReasonOutcome;
  severity: ReasonSeverity;
  source: 'winner' | 'rejected-candidate' | 'baseline' | 'dispatch' | 'repair';
  parameters?: ScheduleReasonParameters;
  line?: string;
  taskId?: string;
}

interface OrderDecision {
  taskId: string;
  line?: string;
  outcome: 'newly-scheduled' | 'rescheduled' | 'unchanged' | 'not-considered' | 'blocked';
  primaryReasonCode: ScheduleReasonCode;
  reasonCodes: readonly ScheduleReasonCode[];
}

interface ScheduleStabilitySummary {
  newlyScheduledOrderCount: number;
  rescheduledOrderCount: number;
  movedOrderCount: number;
  unchangedOrderCount: number;
  shiftedEarlierOrderCount: number;
  shiftedLaterOrderCount: number;
  lineChangeCount: number;
  segmentChangeCount: number;
  totalAbsoluteStartShiftMinutes: number;
  maxAbsoluteStartShiftMinutes: number;
  sequenceChanges: number;
  noOp: boolean;
}

interface CandidateSearchSummary {
  kind: 'candidate-search' | 'dispatch';
  algorithm: 'exact' | 'greedy' | 'mixed' | 'legacy-dispatch';
  completeness: 'exhaustive' | 'heuristic' | 'work-budget-exhausted' | 'interrupted';
  termination: 'completed' | 'work-budget' | 'emergency-cutoff' | 'infeasible' | 'invalid';
  searchWorkConsumed: number;
  searchWorkLimit: number;
  candidateEvaluations: number;
  feasibleCandidates: number;
  infeasibleCandidates: number;
  scopeWinningCandidates: number;
  nonWinningFeasibleCandidates: number;
  prunedBranches: number;
  duplicateSequencesSkipped: number;
  infeasibleByBucket: Partial<Record<ReasonBucket, number>>;
  prunedByBucket: Partial<Record<ReasonBucket, number>>;
  scope: 'line' | 'plant';
}

interface ObjectiveVector {
  hardViolationCount: number;
  primary: readonly number[];
  movedOrderCount: number;
  totalAbsoluteShiftMinutes: number;
  sequenceChanges: number;
  stableSequenceKey: string;
}

type CandidateDisposition =
  | { status: 'applyable'; objective: ObjectiveVector; baseline: ObjectiveVector }
  | { status: 'no-improvement'; objective: ObjectiveVector; baseline: ObjectiveVector }
  | { status: 'infeasible'; baseline?: ObjectiveVector }
  | { status: 'interrupted'; bestFound?: ObjectiveVector; baseline?: ObjectiveVector }
  | { status: 'stale' | 'invalid'; reasonCode: ScheduleReasonCode };

type RunDisposition =
  | { status: 'applyable'; applyableLines: readonly string[]; unchangedLines: readonly string[] }
  | { status: 'no-improvement' | 'infeasible'; unchangedLines: readonly string[] }
  | { status: 'interrupted' | 'stale' | 'invalid'; reasonCode: ScheduleReasonCode };

interface CandidateApplyGuard {
  scheduleRevision: number;
  inputFingerprint: string;
  scopedTaskFingerprints: Readonly<Record<string, string>>;
}

interface CandidateResult {
  reasonSchemaVersion: 1;
  runContext: { runAt: string; plant: string; lines: readonly string[] };
  lineDispositions: Readonly<Record<string, CandidateDisposition>>;
  disposition: RunDisposition;
  // existing patches, explanation, diagnostics, unchangedLines, and missingEdges
}
```

The module also provides pure helpers to:

- compare text and IDs by normalized Unicode code-point order with no locale or
  browser dependency;
- compare current and candidate schedules;
- calculate actual movement from patches, ignoring no-op patches;
- count sequence changes from before/after line order;
- merge reason counts and retain bounded representative examples;
- classify reason codes into stable preview/audit buckets.

Reason codes are a versioned registry. Each emitted code must have exactly one
bucket, default outcome, default severity, localization key, deterministic
primary-reason precedence, and bounded parameter shape. Producers emit codes
and parameters, not localized prose. The UI resolves the localization key and
escapes every parameter. A short developer-only diagnostic message may remain
on `CandidateDiagnostic`, but it is not the planner-facing reason contract.
Unknown codes are treated as `data-unknown-reason` in the UI rather than being
rendered as arbitrary HTML or silently dropped. `reasonSchemaVersion` is
included in preview and audit summaries so later vocabulary changes are
interpretable.

`ReasonOutcome` describes what happened; `ReasonSeverity` describes how much
attention it needs. For example, forced placement is `accepted` with severity
`warning`, not an outcome named `warning`. An order may have multiple causal
reasons, but `primaryReasonCode` is selected by registry precedence so aggregate
counts do not double-count it. Bounded secondary codes may still be shown in
the preview.

`CandidateReason` currently defined in `setup-scheduler.mts` should move to
this shared contract and be re-exported from its existing module to minimize
consumer churn.

### 2. Reason-code vocabulary

All producers should emit an explicit code, bucket, and outcome. The first
release should cover at least these behaviors:

| Situation | Code family | Outcome | Severity |
|---|---|---|---|
| Order placed by the selected candidate | `placement-*` | accepted | info |
| Fixed/manual protected order | `fixed-*` | unchanged/rejected | info/warning by exact code |
| Aged or outside selected horizon | `horizon-*` | not-considered | info |
| Waiting for pull-forward floor | `pull-forward-*` | rejected | info |
| Closed calendar, blackout, or no finite slot | `capacity-*` / `calendar-*` | rejected | warning |
| Missing setup state or transition | `setup-*` | rejected | warning |
| Invalid runtime or missing schedule data | `data-*` | rejected | error |
| Search work cap reached | `search-work-budget` | unchanged | warning |
| Emergency wall-clock interruption | `search-emergency-cutoff` | unchanged | error |
| Candidate equal to or worse than baseline | `stability-no-improvement` | rejected | info |
| Patch equals current dates/segments | `stability-no-change` | unchanged | info |
| Forced placement after a bounded search | `capacity-forced-placement` | accepted | warning |

Existing setup-specific codes remain meaningful, but each producer must add
the explicit metadata rather than relying on UI text matching. The preview's
current regex-based accepted/rejected inference and local prune map should be
removed in favor of this contract.

The implementation plan must enumerate the exact initial registry, not only
the families above. Renaming or reclassifying a code requires incrementing the
schema version or providing an explicit compatibility alias.

### 3. Deterministic candidate selection and no-op gating

Preserve each mode's current primary objective ordering, but expose it through
an explicit `ObjectiveDefinition` rather than relying on positional score-array
indexes. Each definition names every metric, direction, unit, and tolerance;
UI display tolerances such as the current `0.05` finalist threshold are not
silently reused as engine tolerances. Baseline and candidate metrics are
computed by the same function over the same immutable, pre-filtered line scope.

Candidate comparison is scoped per line because the current optimizer does not
intentionally trade one line against another. Append stability as a shared
suffix to candidate-to-candidate comparison:

1. hard feasibility;
2. the mode's existing policy/lateness/setup objective;
3. fewer moved orders;
4. lower total absolute shift minutes;
5. fewer line-sequence changes;
6. canonical order-ID sequence using the shared locale-independent comparator.

The candidate evaluator must compare a candidate against the current baseline
schedule using named metrics, not opaque positional score fields alone. For a
line to contribute patches, its candidate must be feasible and its full
objective vector must be strictly better than that line's baseline after the
definition's explicit tolerances. Equal primary performance with lower
movement is a valid improvement; equal performance with equal or greater
movement is not. No-op patches are removed before movement and objective
comparison.

The plant result is applyable when at least one requested line is applyable and
no run-global failure occurred. Lines that are feasible but do not improve are
left unchanged with `no-improvement`; line-local setup/capacity infeasibility is
also left unchanged and explained. Duplicate IDs, invalid scope, stale inputs,
and an emergency cutoff are run-global failures and disable Apply for the whole
preview. A plant-level summary may be shown, but it must retain every line's
disposition and must not hide a regression on an individual line.

The hard no-op gate applies to optimizer candidates in both detached preview
and direct `Engine.runAndApply` calls. Direct callers must use the same
evaluate-then-apply boundary; there must not be a second legacy mutation path
that bypasses disposition checks. A no-improvement candidate keeps its
diagnostics for explanation but is not applyable. The Apply button and the
mutation boundary enforce this independently; UI state alone is not a safety
control.

Automatic repairs have a separate rule: overlap/blackout repair may move an
order when necessary to restore legal placement, even if no KPI improves.
Manual scheduling remains an explicit user override.

All candidate and dispatch ordering must have a final stable tie-break. In
particular:

- sort line groups by canonical line key before processing;
- sort equal-key orders by current start, original snapshot position, then ID;
- never depend on database/task-array insertion order;
- suppress patches whose start/end/segments equal the source snapshot.

Stable keys include plant/line scope so logs and candidate-search deduplication
remain unambiguous. However, the current Store, fixed set, selection model, and
patch API are globally keyed by task ID. Until a separate project introduces a
composite task key end to end, any duplicate ID detected during hydration is a
run-global data-quality failure and all optimization must fail closed. Store
must retain collision state and carry it into the schedule snapshot; the lost
row cannot be reconstructed after `setTasks()` overwrites it.

Running the same evaluation twice against the same snapshot and inputs must
return the same patch IDs, dates, segments, reasons, and summary counts. A
second run against the already-applied schedule must be a no-op.

### 3.1 Search work budgets and determinism

The setup-aware evaluator must use a deterministic search-work cap as the
primary budget. The charging contract must name each charged operation (for
example, an exact-search traversal edge or a complete greedy neighbor
evaluation) and remain stable within the reason schema version. Completed
candidate evaluations are measured separately; they are not assumed to equal
work units. Candidate enumeration order, line order, group order, budget
allocation, and final tie-breaks must all be deterministic. The existing
`performance.now()` deadline remains an emergency responsiveness guard only.

Budgeting is per requested line, using either a fixed per-line cap or a
deterministic allocation calculated before search begins. A mutable plant-wide
pool that lets early lines consume all work and starve later lines is forbidden.
Fallback and continuation work is charged to the owning line's same budget.

- Exact search that completes its search space is `exhaustive`; greedy search
  that completes is still `heuristic`.
- If a deterministic work cap is exhausted, the result is reproducible,
  labeled `work-budget-exhausted`, and may be applyable if the best fully
  evaluated candidate improves the baseline and passes all hard constraints.
- If the wall-clock emergency cutoff fires first, set
  `termination: 'emergency-cutoff'`, set disposition `interrupted`, and disable
  Apply for the entire requested run. The preview must say the search was
  interrupted, not that the result is the stable best candidate.
- Tests inject the clock and work cap so they never depend on machine speed.
- Primary and alternate-mode preview runs reuse the same immutable run context
  and captured `runAt`, but receive independent, identical policy-defined work
  budgets so one comparison cannot consume another's allowance.

### 4. Search accounting and "Why this candidate"

Setup-aware exact and greedy search record separate populations at the point
each work unit or complete sequence is processed:

- charged search-work units;
- complete candidate evaluations;
- feasible candidates;
- infeasible candidates;
- non-winning feasible candidates;
- branches pruned before a complete candidate existed;
- duplicate sequences skipped without evaluation;
- one primary reason bucket/code per infeasible candidate or pruned branch;
- bounded examples for actionable order-level failures.

The following identities must hold for every line and aggregate summary:

```text
candidateEvaluations = feasibleCandidates + infeasibleCandidates
feasibleCandidates = scopeWinningCandidates + nonWinningFeasibleCandidates
```

Pruned branches and duplicate sequences are never called rejected candidates
and are not included in `candidateEvaluations`. A failure that has multiple
causes is assigned one primary aggregate bucket using registry precedence;
secondary reasons remain available only in bounded detail. Examples are chosen
by a stable sort on code, line, and task ID rather than first-observed timing.
`scopeWinningCandidates` counts the winner of each explicitly keyed fragment or
fallback scope; it is not a claim that every local winner survives into the
final line result. A plant aggregate whose lines used different algorithms is
reported as `algorithm: 'mixed'` and retains the per-line summaries.

The aggregate must include fallback and continuation searches. Each evaluation
must carry a scope key consisting of line, fragment/fixed-boundary context,
predecessor state, and ordered task IDs. Counts are explicitly
`candidateEvaluations`, not claims about globally unique alternatives. A
candidate may be counted once per distinct evaluation scope.

If the deterministic work cap is exhausted, the result may say "best candidate
found within the configured search-work budget." If the emergency wall-clock
cutoff fires, the result must be preview-only and say "search interrupted."

Legacy dispatch does not enumerate alternate candidates. It should report
orders considered, moved, unchanged, fixed, out-of-horizon, pull-forward
blocked, and capacity blocked. Its preview wording should describe a
deterministic dispatch result rather than a candidate search.

Extend the existing `OptimizerPreview` "Why this candidate" section with:

- selected candidate and per-line dispositions;
- algorithm, completeness, termination, and work-budget usage;
- candidate evaluations, feasible, infeasible, non-winning, pruned, and
  duplicate-skipped counts when available;
- top infeasibility and prune buckets with counts;
- moved-order count, unchanged-order count, total shift, and sequence churn;
- up to eight representative order decisions, grouped by reason;
- a clear no-op explanation when Apply is disabled.

The existing setup missing-pair table remains available as a detailed setup
diagnostic. The new aggregate complements it rather than duplicating it. The
existing A/B alternate-mode comparison is also labeled separately: it compares
two optimizer modes and is not presented as an enumerated search finalist.

### 5. Automatic-path reports and audit summary

The optimizer result remains the primary report shape. Add a common
`ScheduleMutationReport` for automatic repair paths, containing patches,
order decisions, reason counts, and stability summary.

- `Engine.autoReflow` returns a report while preserving its current callers.
- Alert overlap/blackout fixes return or record the same report.
- Alert overload optimization uses the normal optimizer disposition and
  no-op gate.
- Remove Backlog keeps its specialized diagnostics and explicit repair
  semantics; it is not treated as a KPI-improvement candidate.

When an applied preview is durably saved, record a bounded
`optimization_run` summary:

```json
{
  "reason_schema_version": 1,
  "candidate_status": "applyable",
  "search_algorithm": "exact",
  "search_completeness": "exhaustive",
  "search_termination": "completed",
  "search_work_consumed": 91,
  "search_work_limit": 500,
  "candidate_evaluations": 24,
  "feasible_candidates": 5,
  "infeasible_candidates": 19,
  "non_winning_feasible_candidates": 4,
  "pruned_branches": 12,
  "infeasible_by_bucket": {"setup": 7, "capacity": 12},
  "moved_order_count": 6,
  "total_absolute_start_shift_minutes": 145,
  "sequence_changes": 2
}
```

Do not persist the full candidate schedule or every order-level decision in
the first release. Task IDs and representative order examples remain
preview-only even after route hardening.

There are two distinct commits and the UI must name them honestly:

1. **Local Apply** performs one checked Store mutation and creates the undo
   entry. It does not claim that PostgreSQL or audit storage has committed.
2. **Durable Save** sends the exact optimizer patch set as an atomic optimizer
   batch through `/tasks/update`. The backend locks and validates every target,
   compares the row versions captured by the candidate, then updates all rows
   or none. Optimizer persistence must not use the current `force=true` bypass;
   a server-side concurrent edit makes the whole batch stale. Only after every
   intended task commits may the server append the corresponding audit event.
   An invalid, not-found, stale, or rolled-back batch records no success event;
   it may record a separate bounded failure event.

The preferred integration is a typed optional `atomic_optimizer_run` context on
the `/tasks/update` request. The backend validates the summary, exact task-ID
set, captured row versions, and plant scope before committing, then appends the
event from the validated server result. The existing best-effort/per-row update
contract remains available for ordinary edits, but is forbidden for an
optimizer batch. If file append fails after the database commit, the save
remains successful but returns an explicit audit-warning field for UI/backend
logging. The frontend must not independently POST a success event before or
after `Persistence.saveAll()`.

Local Apply queues the candidate's patch IDs, applied-value fingerprints, base
row versions, and summary as one pending optimizer save. Persistence sends that
set in its own batch before unrelated dirty edits; it must not mix a candidate
summary with older or later manual changes. If any optimizer-owned value is
edited again before Save, the pending summary is marked superseded and cannot
produce a success audit. A stale atomic save leaves the local state visibly
unsaved and offers reload/undo; it never falls back to a forced or partial save.

Route hardening requirements are:

- accept only a typed, allowlisted, size-bounded optimization summary;
- verify that every updated task and the claimed run scope belongs to the
  caller's allowed plant set;
- derive persisted counts and success/failure from the server's update result,
  never from client claims;
- use the standard traced request wrapper and carry the save request ID into
  the audit entry;
- restrict or remove generic client writes to `/audit/log`, because leaving it
  open would still allow forged `optimization_run` events;
- record the supplied username as `unverified_actor` under the current
  header-based identity model.

The server can verify that the header names an existing user and enforce that
user's configured plant scope, but it cannot make actor attribution
server-authoritative while identity itself is a spoofable header. Verified
actor attribution is explicitly deferred to authenticated sessions or Entra
SSO. This requires backend route hardening but no database migration. The
file-backed log remains best-effort and unsuitable for compliance guarantees.

### 6. Stale and atomic Apply protection

`OptimizerPreview` captures a `CandidateApplyGuard` over the complete immutable
input bundle. Add a schedule-input revision that changes only when optimizer
inputs change; do not use the general `Store.rev()`, which also changes for
unrelated alert/UI state. The canonical input fingerprint includes:

- every task in the requested evaluation scope, including unchanged tasks and
  fixed boundaries, with dates, normalized segments, line/plant, runtime, due
  fields, priority/setup attributes, and row version;
- fixed IDs and the retained global duplicate-ID/collision state;
- plant/line calendars and blackout blocks used by placement;
- priority-rank maps, setup definition/state/rows/overrides, line settings, and
  plant constraints used by the selected mode;
- normalized run options, selected scope, reason schema version, and captured
  `runAt`.

Canonical serialization sorts object keys, task keys, sets, blocks, and
segments and represents dates as epoch milliseconds. Apply must preflight all
of the following immediately before the single Store mutation:

- the schedule-input revision and full input fingerprint still match;
- every scoped task still exists and every patch ID occurs exactly once;
- the candidate remains applyable and is not stale or emergency-cutoff;
- no global duplicate-ID/data-integrity flag is active;
- every patch has valid finite dates, a positive interval, normalized segments,
  and a line/plant inside the captured scope.

Any mismatch rejects the entire candidate, marks the preview stale, and applies
zero patches. A new checked mutation helper performs validation before changing
the first task, then applies all patches and emits once. `Store.updateMany()`
must not be used as the only guard because it silently ignores unknown IDs.
JavaScript's single-threaded mutation makes that local Store commit atomic with
respect to synchronous callers; durable PostgreSQL atomicity is the separate
Save contract in section 5.

### 7. Movement definitions and repair transactions

Stability summaries must distinguish:

- newly scheduled orders;
- rescheduled orders;
- shifted-earlier and shifted-later orders;
- schedule-segment changes;
- line changes;
- total absolute start-shift minutes.

Movement is defined as follows:

- scheduled before and after: start shift is the absolute difference between
  start instants in elapsed minutes; direction comes from the signed difference;
- undated before and scheduled after: count `newlyScheduledOrderCount`, but do
  not invent shift minutes from a horizon or epoch;
- scheduled before and undated after: invalid for optimizer candidates;
- changed line: count a line change separately and compare sequence only among
  tasks that remain on the same line;
- changed split segments: compare normalized `(sequence,start,end)` tuples and
  count the order once in `segmentChangeCount`;
- sequence changes: count pairwise order inversions among tasks present before
  and after on the same line, ordering by start, original snapshot position,
  then canonical ID. Newly scheduled tasks do not create inversions against an
  undefined baseline position.

All elapsed-minute calculations use epoch milliseconds, so DST transitions
have their real elapsed duration. Plant timezone is used for day-boundary and
calendar interpretation, not for subtracting two instants. Primary objectives
must explicitly reward required placement of previously undated work; the
stability suffix must never prefer leaving eligible work unscheduled merely
because a new schedule has no shift-minute baseline.

Automatic repair reports must include every affected task. In particular,
alert overlap fixes snapshot the target and all downstream peers moved by
`autoReflow`; undo must restore the complete mutation set, not only the order
that triggered the alert.

## Proposed implementation surfaces

- Create `web/schedule-diagnostics.mts` for shared reason/stability types and
  pure helpers.
- Modify `web/setup-scheduler.mts` to use the shared contract, instrument
  search work and candidate populations, accept an already-filtered scope, and
  append per-line stability comparison.
- Modify `web/schedule-services.mts` to instrument legacy dispatch, automatic
  repair reports, stable sorting, exact pre-evaluation scoping, no-op patch
  suppression, and the shared evaluate-then-apply gate.
- Modify `web/schedule-workbench.mts` to render explicit reason outcomes,
  aggregate candidate evidence, bounded order examples, stale Apply guards,
  and audit summaries.
- Modify `web/schedule-state.mts` to retain global collision state, expose a
  schedule-input revision, and provide checked all-or-nothing local patch
  preflight.
- Modify `web/schedule-data.mts` so durable optimizer saves carry a pending
  typed summary and report audit-write warnings only after full persistence.
- Modify `db.py` to provide the atomic compare-and-swap optimizer update: lock
  the complete task set, validate all row versions/targets, and commit all rows
  or none while preserving the existing best-effort path for ordinary edits.
- Modify `brain.py` to validate, plant-scope, bound, and record optimization
  summaries from the successful bulk-update result; restrict generic audit
  writes. Do not claim verified actor identity under spoofable-header auth.
- Add localized preview strings to all existing locale maps.
- Keep generated `.mjs` outputs synchronized through the normal TypeScript
  build; do not hand-edit generated files.

## Verification plan

### Pure diagnostics tests

- identical snapshots with shuffled task input produce identical stable keys;
- movement summary ignores unchanged patches and counts absolute shifts;
- sequence-change count is stable across equal-start tasks;
- reason counts merge without duplicate candidate accounting;
- bounded examples never exceed the configured limit;
- reason outcome and severity remain orthogonal;
- canonical serialization is invariant to object/set/input ordering;
- movement handles undated, split, line-change, and DST cases exactly as
  specified.

### Setup-aware scheduler tests

- exact search reports feasible/infeasible/non-winning candidate totals;
- greedy neighbor candidates use the same infeasibility buckets;
- fallback and continuation candidates are included once;
- work-unit charging is deterministic and distinct from candidate counts;
- no line can consume another requested line's search budget;
- candidate selection prefers fewer moves after equal primary scores;
- input-order shuffling produces identical patches and reasons;
- deterministic work-budget exhaustion is labeled separately from interruption;
- emergency wall-clock interruption is non-applyable;
- equal/worse candidates become no-op and cannot be applied.

### Legacy and automatic-path tests

- equal priority/due/start orders use the same ID/order-position tie-break;
- legacy results report fixed, horizon, pull-forward, capacity, and forced
  placement reasons;
- setup-aware scoring and reasons use the same pre-filtered line/exclusion scope
  as the returned patches;
- unchanged date/segment patches are omitted;
- repeated optimization produces no additional movement;
- auto-reflow and alert fixes produce reason reports;
- repair paths still move work when required to remove an overlap or blackout;
- alert-repair undo restores every peer moved by auto-reflow;
- manual scheduling remains an explicit override.

### Preview and audit tests

- preview uses explicit outcome metadata rather than text matching;
- "Why this candidate" shows work, evaluation, feasible, infeasible,
  non-winning, prune, and duplicate-skip counts without conflating them;
- bounded order examples and missing setup pairs remain capped;
- no-improvement candidates disable Apply and explain why;
- stale schedule-input revision or full input fingerprint disables Apply and
  applies zero patches;
- work-budget-limited candidates use qualified "best found" wording;
- applied audit payload contains only bounded summary fields.

### Security and data-integrity tests

- unknown users and cross-plant audit summaries are rejected;
- current header-based identity is labeled unverified rather than represented
  as server-authenticated;
- oversized or unknown audit fields are rejected or dropped;
- reason parameters containing markup are escaped in the preview;
- any retained hydration collision disables optimization before snapshot
  evaluation;
- stale candidates cannot partially apply;
- audit success is absent for partial/failed saves and appears only after every
  intended optimizer task is durably persisted;
- an optimizer row-version conflict updates zero database rows and never falls
  back to `force=true`;
- manual edits made after local Apply supersede the pending optimizer summary
  rather than being mixed into its atomic batch;
- generic `/audit/log` writes cannot forge an `optimization_run` success event.

Run the focused module tests first, followed by `npm run typecheck`,
`npm run lint`, `npm run build`, and `npm test`. Existing date-sensitive tests
and the current pull-forward regression tests must be kept separate from any
new failures caused by this work.

## Rollout and compatibility

Implement this as two tracks with safety-gated slices. Track A can ship without
audit expansion; Track B must not weaken Track A if authentication work is
deferred.

**Track A - optimizer diagnostics and stability**

1. Add pure diagnostics and shadow summaries without changing applied patches.
2. Apply exact scope before both scheduler families evaluate; add deterministic
   work allocation and compare old/new patch sets on replay
   fixtures; investigate every difference before enabling the new selector.
3. Enable the named baseline objective and no-op gate only after per-line
   replay tests pass.
4. Enable complete-input stale guards and checked local Apply.
5. Retain a feature flag to disable stability selection while keeping normal
   scheduling and reason reporting available.

The feature flag is a startup/config value, not a DOM-only toggle. When off,
reason reporting and existing scheduling continue, while the new baseline
selector/no-op gate remains disabled. The preview must disclose which selector
version produced its candidate.

**Track B - durable audit integration**

1. Add the typed summary to durable bulk save and derive success counts from
   the server result.
2. Restrict generic audit writes and add size/plant/user-existence validation.
3. Enable audit summaries only after full-save ordering and audit-write warning
   behavior are verified.
4. Upgrade `unverified_actor` to verified attribution only when the application
   has a server-verifiable authenticated identity.

Every rollout slice must preserve the existing pull-forward regression tests,
setup-matrix tests, undo behavior, and manual scheduling semantics.

## Non-goals

- No new global optimization algorithm or solver.
- No cross-line rebalancing, labor-capacity integration, or precedence/pegging
  implementation in this change.
- No change to manual drag semantics.
- No full order-level history database.
- No claim that a work-budget-limited or heuristic search is globally optimal.
- No repair-path KPI gate that could leave an overlap or blackout unresolved.

## Defaults for the next revision

- Maximum preview reason examples: 8.
- Candidate infeasibility and prune counts are separate, aggregate, and
  bucketed; representative examples carry task ID and line in the preview only,
  not in the first audit payload.
- Existing mode objectives remain primary; stability is appended after them.
- Deterministic search-work-budget exhaustion may remain applyable when the
  candidate improves the baseline and passes all hard constraints; emergency
  wall-clock interruption is never applyable.
- No-op means the full named objective vector is not strictly better than the
  same-line baseline after explicitly defined objective tolerances.
- A schedule-input revision plus a canonical fingerprint of every relevant
  optimizer input is the stale-preview guard; general `Store.rev()` is not.
- Plant scope and persisted result counts are server-validated. Actor identity
  remains explicitly unverified until authenticated sessions or Entra SSO.
