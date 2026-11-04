// optimization/scheduler-contract.mjs — tiny leaf module (Phase P4 of
// docs/architecture/domain-refactor-plan.md). Exists purely to break import
// cycle 1 between the former schedule-services.mts and setup-scheduler.mts,
// not for domain-grouping reasons (see docs/architecture/domain-refactor-plan.md
// §5 and this phase's task brief, Part B). Holds only
// `MIN_PRODUCTIVE_SEGMENT_MINUTES` and `RemoveBacklogResult`/
// `RemoveBacklogDiagnostics` — the two things setup-scheduler.mts needed from
// schedule-services.mts that have nothing to do with the `Engine` object
// itself (whose adapter function was the actual cycle-forming edge).
// A true leaf: no imports of its own beyond the ambient NimbusTask type, and
// it must stay that way — nothing it exports may start importing back into
// optimization/engine.mjs or optimization/setup-scheduler.mjs.
//
// This leaf breaks the NAMED cycle (schedule-services/engine.mjs <->
// setup-scheduler.mjs), but setup-scheduler.mjs still imports
// candidateDefaultWorkHours from calendar/calendar-engine.mjs, which in turn
// imports Engine/the pure evaluators back from engine.mjs — so
// engine.mjs -> setup-scheduler.mjs -> calendar-engine.mjs -> engine.mjs is a
// real transitive loop, and combined with engine.mjs's separate direct cycle
// with insights/services.mjs, all four files form one strongly-connected
// component (contradicting the "setup-scheduler is a detached module"
// framing elsewhere in this codebase's docs). P4's review empirically
// confirmed this is safe today — every cross-reference in the loop is
// touched only inside a function/method body invoked after all four modules
// finish top-level evaluation, verified by loading them under every possible
// entry order with no TDZ ReferenceError — but it is NOT two independent
// 2-file cycles the way it might look from any single file's imports.
// Reason about the whole four-file loop, not just your own two neighbors,
// before adding a new top-level (module-evaluation-time) reference anywhere
// in engine.mjs, setup-scheduler.mjs, calendar-engine.mjs, or
// insights/services.mjs.
import type { NimbusTask } from '../platform/types.mjs';

export interface RemoveBacklogDiagnostics {
  backlogFound: number;
  moved: number;
  firmedMoved: number;
  frozenMoved: number;
  movedRuntimeHours: number;
  largestDelayMinutes: number;
  invalidRuntimeIds: string[];
  missingStartIds: string[];
  overlongIds: string[];
  calendarSearchFailures: Array<{ line: string; taskId?: string; reason: 'no-operating-interval' | 'search-exhausted' }>;
  boundaryConflicts: Array<{ line: string; movedTaskId: string; protectedTaskId?: string; type: 'overlap' }>;
  /** `holdRunning` runs only: orders in progress left where they are (fixed obstacles the backlog plans around). */
  runningHeldIds?: string[];
}

export interface RemoveBacklogResult {
  patches: Array<{ id: string; changes: Partial<NimbusTask> }>;
  diagnostics: RemoveBacklogDiagnostics;
}

/** B3 (2026-08-21): default productive-segment floor (minutes) — no split
 * piece may be shorter than this, except one complete unsplit order below
 * the boundary. Phase-1 shipped this fixed system-wide; it is now the
 * DEFAULT ONLY, plant-overridable via `plants.min_productive_segment_minutes`
 * — see `Engine.minProductiveSegmentMinutesFor`, which resolves the per-plant
 * value and falls back to this default when unset/null. Keep allocator
 * arithmetic on this named boundary. Canonical for both calendar/
 * calendar-engine.mjs's `Calendar.allocateRuntime` (non-setup-aware) path and
 * optimization/setup-scheduler.mjs's `placeWithSetup` (setup-aware) path —
 * both import this constant from this leaf module rather than declaring
 * their own copy. */
export const MIN_PRODUCTIVE_SEGMENT_MINUTES = 30;

/** The four known rankable priority fields and the order attribute each one
 *  reads: the single offline-default mapping. `Engine._fieldTaskFields` seeds
 *  from it (and `Engine.setFieldTaskFields` merges the backend registry over a
 *  copy); setup-scheduler.mts keeps its own private `PRIORITY_TASK_FIELDS`
 *  table with the same four entries (it can import this instead). A
 *  `key.toUpperCase()` guess is wrong for three of the four. */
export const PRIORITY_FIELD_DEFAULTS: Readonly<Record<string, string>> = {
  colorWheel: 'COLOR',
  prt01: 'PRT_01',
  prt02: 'PRT_02',
  productionVersion: 'PRODUCTION_VERSION',
};

/** Capacity-aware task sequencer: reorders tasks to respect ceiling constraints.
 *
 * Given a sorted task list, cursor position (ms), and per-task ceiling/runtime
 * accessors, emits a reordered sequence that preempts tasks at risk of violating
 * their deadline-derived ceiling. Rule:
 * 1. If NO task has a non-null finite ceiling, return input unchanged (zero-cost).
 * 2. Tasks with runtime <= 0 or non-finite ceiling are excluded from cursor
 *    simulation but are emitted in their original relative position.
 * 3. Walk: cursor starts at cursorStartMs; remaining = [...sorted]. Loop while
 *    remaining non-empty:
 *    - head = remaining[0]; headEnd = cursor + runtime(head).
 *    - Among OTHER remaining tasks with a ceiling: X is "savable" iff
 *      latestStart(X) = ceiling(X) - runtime(X) >= cursor. X is "at risk" iff
 *      savable AND headEnd > latestStart(X).
 *    - If any at-risk task exists, pick the at-risk task with the EARLIEST
 *      ceiling (ties: earliest index in sorted). Otherwise pick head.
 *    - Emit pick, remove from remaining, cursor += runtime(pick) (only if > 0).
 * 4. O(n²) acceptable. Never mutates input array.
 */
export function capAwareSequence<T>(
  sorted: readonly T[],
  cursorStartMs: number,
  ceilingMsFor: (task: T) => number | null,
  runtimeMsFor: (task: T) => number,
): T[] {
  // Step 1: Check if ANY task has a non-null finite ceiling
  const hasCeiling = sorted.some(task => {
    const c = ceilingMsFor(task);
    return c !== null && Number.isFinite(c);
  });
  if (!hasCeiling) {
    return [...sorted];
  }

  // Step 2 & 3: Walk and reorder. P1-11: ceiling and runtime are read once per
  // task (parallel arrays kept in step with `remaining`) instead of once per
  // task per round.
  const result: T[] = [];
  const remaining = [...sorted];
  const ceilings = remaining.map(task => ceilingMsFor(task));
  const runtimes = remaining.map(task => runtimeMsFor(task));
  let cursor = cursorStartMs;

  while (remaining.length > 0) {
    const head = remaining[0];
    const headRuntime = runtimes[0];
    const headEnd = cursor + headRuntime;

    // Find at-risk tasks (excluding head)
    let atRiskTask: T | null = null;
    let earliestCeiling = Infinity;
    let earliestIndex = Infinity;

    for (let i = 1; i < remaining.length; i++) {
      const task = remaining[i];
      const ceiling = ceilings[i];
      const runtime = runtimes[i];

      // Skip if ceiling is null/non-finite or runtime is <= 0
      if (ceiling === null || !Number.isFinite(ceiling) || runtime <= 0) {
        continue;
      }

      const latestStart = ceiling - runtime;

      // Check if savable: latestStart >= cursor
      if (latestStart < cursor) {
        continue;
      }

      // Check if at risk: headEnd > latestStart
      if (headEnd <= latestStart) {
        continue;
      }

      // At-risk task found: compare by earliest ceiling, then earliest index
      if (ceiling < earliestCeiling || (ceiling === earliestCeiling && i < earliestIndex)) {
        atRiskTask = task;
        earliestCeiling = ceiling;
        earliestIndex = i;
      }
    }

    // Pick: either an at-risk task or head
    const pick = atRiskTask !== null ? atRiskTask : head;
    const pickIndex = remaining.indexOf(pick);
    const pickRuntime = runtimes[pickIndex];

    // Emit and advance
    result.push(pick);
    remaining.splice(pickIndex, 1);
    ceilings.splice(pickIndex, 1);
    runtimes.splice(pickIndex, 1);
    if (pickRuntime > 0) {
      cursor += pickRuntime;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// P3-5(c): shared time unit and plant-policy readers. Pure value-in, value-out
// helpers over the raw `plants` master-data fields, so the detached scheduler
// (snapshot read) and the Engine (live Store read) can validate a field the
// same way. No imports; this block stays a leaf.
// ---------------------------------------------------------------------------

/** Milliseconds in one minute (the divisor for every ms-to-minutes conversion). */
export const MS_PER_MINUTE = 60 * 1000;

/** A plant's productive-segment floor in minutes: a positive integer, else the default. */
export function plantSegmentFloor(value: unknown): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : MIN_PRODUCTIVE_SEGMENT_MINUTES;
}

/** A plant's split-order policy; absent or malformed keeps continuous scheduling ('never'). */
export function plantSplitPolicy(value: unknown): 'never' | 'overlong_only' | 'partial_allowed' {
  return value === 'overlong_only' || value === 'partial_allowed' ? value : 'never';
}

/** A plant's unknown-setup policy; absent or malformed means 'zero'. */
export function plantUnknownSetupPolicy(value: unknown): 'zero' | 'plantDefaultMinutes' | 'excludeFromSearch' {
  return value === 'plantDefaultMinutes' || value === 'excludeFromSearch' ? value : 'zero';
}

/** A plant's default minutes for an unknown setup: a non-negative integer, else 0. */
export function plantUnknownSetupDefaultMinutes(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

/** A plant's tooling rule; anything but 'hard' is 'off'. */
export function plantToolingRule(value: unknown): 'off' | 'hard' {
  return value === 'hard' ? 'hard' : 'off';
}

// ---------------------------------------------------------------------------
// P3-5(d): the candidate score vector. Eight slots, every one named; arity is
// not type-enforced (`score` is `number[]`), so `makeScore` is the one place
// the width lives. Slots 6 and 7 were appended after the first six (never
// inserted), so slot 5 stays the setup-minute term other code reads.
// ---------------------------------------------------------------------------

/** Slot 0: hard-constraint violations (1 on a hard-infeasible candidate). */
export const SCORE_HARD = 0;
/** Slot 1: compact priority-policy diagnostic. */
export const SCORE_POLICY = 1;
/** Slot 2: late-order count. */
export const SCORE_LATE_COUNT = 2;
/** Slot 3: total lateness minutes. */
export const SCORE_LATENESS = 3;
/** Slot 4: minus the admitted-order count (lower is better, so more admissions win). */
export const SCORE_PATCHES = 4;
/** Slot 5: setup minutes. */
export const SCORE_SETUP = 5;

/** Score index carrying the count of uncovered-but-admitted transitions in a
 * candidate (A2). Appended, never inserted: `score[5]` is read as setup-minute
 * savings elsewhere (`evaluateMinChangeover`/`selectThroughputCandidate`), so
 * renumbering would corrupt the min-changeover accept/reject decision.
 * Compared explicitly in `compareCandidate` immediately after `policyKey` —
 * never folded into the mode-permuted `terms` list — so it stays mode-
 * independent: fewest uncovered edges outranks every term except the over-cap
 * tier (SCORE_OVER_CAP), which sits just ahead of it (after `policyKey`) and is
 * a no-op for unprotected orders now that the push limit is hard. This ordering is
 * mode-independent EXCEPT for `'due-date'` (2026-09-09), whose dedicated
 * `compareDueDateCandidate` puts lateness (score[2]/score[3]) and even
 * `policyKey` itself ahead of both this tier and SCORE_OVER_CAP — see that
 * function. */
export const SCORE_UNCOVERED = 6;

/** Score index carrying the count of over-cap orders in a candidate
 * (due-date push-forward limit, 2026-09-09): an order whose scheduled end
 * exceeds `bounds.notAfter(task)`. Appended, never inserted — same rule as
 * SCORE_UNCOVERED above. Compared in `compareCandidate` immediately after
 * `policyKey` and BEFORE the coverage tier (SCORE_UNCOVERED): on a plant with
 * no real matrix, coverage is effectively same-signature grouping, so the cap
 * must outrank it or a changeover saving could push an order arbitrarily far
 * past its cap. Null/absent `bounds.notAfter` means every candidate's
 * score[SCORE_OVER_CAP] is 0 — a provable no-op default. The ceiling is
 * HARD (an order past it is queued, never placed), so this term is also 0 for
 * every unprotected order; it can only count a protected/firmed order that
 * already sits past its ceiling. Kept for score-vector arity. Mode-independent
 * except for `'due-date'`, where `compareDueDateCandidate` still compares this
 * tier second (right after hard feasibility) but ahead of `policyKey` — see
 * that function's own comment. */
export const SCORE_OVER_CAP = 7;

/** Number of slots in a score vector. */
export const SCORE_WIDTH = 8;

/** A fresh all-zero score vector of the canonical width; the one place that width is written. */
export function makeScore(): number[] {
  return new Array<number>(SCORE_WIDTH).fill(0);
}

// ---------------------------------------------------------------------------
// P3-5(e): the structured reasons an optimizer run queues an order under.
// ---------------------------------------------------------------------------

/** Every code the detached scheduler writes into a queued order's `planning_reason`. */
export type PlanningReasonCode =
  | 'expired_window'
  | 'missing_due_date'
  | 'invalid_runtime'
  | 'no_fit_found'
  | 'search_limit'
  | 'search_incomplete'
  | 'setup_transition_unrecorded'
  | 'segment_floor_unfittable'
  | 'push_limit_unmet'
  | 'overlong_never'
  | 'tool_contention'
  | 'tool_unavailable';

/** The code and message of a planning reason built by the detached scheduler. */
export interface PlanningReason {
  code: PlanningReasonCode;
  message: string;
}
