/*
 * Detached candidate scheduling contract.
 *
 * This module receives the complete scheduling read model as a snapshot and
 * returns only patches. It never mutates Store, DOM, persistence, alerts, or
 * Timeline; the workbench owns the one explicit Store commit after Apply.
 */

import type { RemoveBacklogResult } from './scheduler-contract.mjs';
import { MIN_PRODUCTIVE_SEGMENT_MINUTES, capAwareSequence } from './scheduler-contract.mjs';
import { candidateDefaultWorkHours } from '../calendar/calendar-engine.mjs';
import { buildSetupResolutionIndex, normalizedValue, resolveSetup, stateForOrder } from '../setup/setup-domain.mjs';
import type { SetupResolutionIndex } from '../setup/setup-domain.mjs';
import type {
  NimbusBlock,
  ConstraintConfig,
  NimbusLineSetting,
  NimbusMasterData,
  NimbusPlantBlock,
  NimbusTask,
  OptimizerMode,
  PriorityRankMaps,
  SetupDefinition,
  SetupOccurrenceOverride,
  SetupSnapshot as SetupTruthSnapshot,
  SetupStateKey,
  SplitOrderPolicy,
  WorkHours,
} from '../platform/types.mjs';

export interface SchedulePatch {
  id: string;
  changes: Partial<NimbusTask>;
}

export interface PlacementInterval {
  start: Date;
  end: Date;
}

export interface SetupPlacementInterval extends PlacementInterval {
  /** The full derived transition capacity, never shortened to fit a tail. */
  minutes: number;
}

export type UnresolvedSetupReason = 'initial-state-unknown' | 'transition-unresolved';

export interface UnresolvedSetupPlacement {
  kind: 'unresolved';
  reason: UnresolvedSetupReason;
}

/** Callers resolve matrix/override truth before placement.  Keeping this
 * explicit makes the placement primitive Store-free and lets a missing state
 * remain an auditable infeasibility instead of silently becoming zero setup. */
export type SetupRequirement =
  | { kind: 'resolved'; minutes: number }
  | UnresolvedSetupPlacement;

export interface PlaceWithSetupRequest {
  earliestStart: Date;
  runtimeMinutes: number;
  policy: SplitOrderPolicy;
  /** Omitted setup is an unknown initial state, not an implicit zero. */
  setup?: SetupRequirement;
  /** Effective operating fragments, already intersected with line/plant hours
   * and excluding blackout time.  The function does not read calendars. */
  freeIntervals: ReadonlyArray<PlacementInterval>;
  /** Relevant only to `overlong_only`; Calendar derives it from nominal
   * operating windows so a blackout does not make ordinary work splitable. */
  isInherentlyOverlong?: boolean;
  /** B3 (2026-08-21): the plant's configured productive-segment floor
   * (schedule-services.mjs's MIN_PRODUCTIVE_SEGMENT_MINUTES default when
   * omitted or not a positive integer). Callers resolve this from the
   * snapshot's masterData — see minProductiveSegmentMinutesForSnapshot below
   * — so this primitive stays Store-free. */
  minProductiveSegmentMinutes?: number;
}

export interface PlacementSuccess {
  kind: 'placed';
  /** Absent for a covered zero transition. */
  setup?: SetupPlacementInterval;
  /** Productive capacity only. These map directly to the existing
   * `order_schedule_segments` child shape if/when a caller persists them. */
  productiveSegments: PlacementInterval[];
}

export interface PlacementInfeasibility {
  kind: 'infeasible';
  reason: 'initial-state-unknown' | 'transition-unresolved' | 'no-feasible-capacity' | 'invalid-runtime';
  /** Missing setup truth is retained here; capacity failures do not invent a
   * partial setup interval that was never placed. */
  setup?: UnresolvedSetupPlacement;
  productiveSegments: [];
}

export type PlacementResult = PlacementSuccess | PlacementInfeasibility;

interface MinuteInterval {
  start: Date;
  end: Date;
  minutes: number;
}

interface IntegerRange {
  lo: number;
  hi: number;
}

function ceilMinute(value: Date): Date | null {
  const ms = value?.getTime?.();
  if (!Number.isFinite(ms)) return null;
  const minuteMs = 60 * 1000;
  const rounded = ms % minuteMs ? ms + minuteMs - (ms % minuteMs) : ms;
  return new Date(rounded);
}

function floorMinute(value: Date): Date | null {
  const ms = value?.getTime?.();
  if (!Number.isFinite(ms)) return null;
  const minuteMs = 60 * 1000;
  return new Date(ms - (ms % minuteMs));
}

/** Normalize only caller-supplied availability. Adjacent entries are one
 * continuous operating interval, while a real downtime gap stays separate. */
function normalizedIntervals(intervals: ReadonlyArray<PlacementInterval>, earliestStart: Date): MinuteInterval[] {
  const earliest = ceilMinute(earliestStart);
  if (!earliest) return [];
  const sorted = intervals
    .map(interval => {
      const rawStart = ceilMinute(interval.start);
      const rawEnd = floorMinute(interval.end);
      if (!rawStart || !rawEnd) return null;
      const start = new Date(Math.max(rawStart.getTime(), earliest.getTime()));
      return start < rawEnd ? { start, end: rawEnd } : null;
    })
    .filter((interval): interval is PlacementInterval => interval !== null)
    .sort((left, right) => left.start.getTime() - right.start.getTime());

  const merged: PlacementInterval[] = [];
  for (const interval of sorted) {
    const prior = merged.at(-1);
    if (prior && interval.start <= prior.end) {
      if (interval.end > prior.end) prior.end = new Date(interval.end);
    } else {
      merged.push({ start: new Date(interval.start), end: new Date(interval.end) });
    }
  }
  return merged.map(interval => ({
    start: interval.start,
    end: interval.end,
    minutes: Math.floor((interval.end.getTime() - interval.start.getTime()) / (60 * 1000)),
  })).filter(interval => interval.minutes > 0);
}

function mergeRanges(ranges: IntegerRange[]): IntegerRange[] {
  const ordered = ranges
    .filter(range => range.lo <= range.hi)
    .sort((left, right) => left.lo - right.lo || left.hi - right.hi);
  const merged: IntegerRange[] = [];
  for (const range of ordered) {
    const prior = merged.at(-1);
    if (prior && range.lo <= prior.hi + 1) prior.hi = Math.max(prior.hi, range.hi);
    else merged.push({ ...range });
  }
  return merged;
}

function rangeContains(ranges: ReadonlyArray<IntegerRange>, target: number): boolean {
  return ranges.some(range => target >= range.lo && target <= range.hi);
}

/** Find a legal set of productive pieces without enumerating each minute. A
 * range represents every integer allocation reachable through the intervals
 * seen so far, so this remains bounded by calendar fragments rather than
 * runtime length. The first interval is deliberately non-skippable: setup
 * cannot be placed without productive work immediately after it. */
function productiveAllocations(
  capacities: ReadonlyArray<number>, totalMinutes: number, minProductiveSegmentMinutes: number,
): number[] | null {
  const firstCapacity = capacities[0] ?? 0;
  if (firstCapacity < minProductiveSegmentMinutes) return null;
  const states: IntegerRange[][] = [[{
    lo: minProductiveSegmentMinutes,
    hi: Math.min(firstCapacity, totalMinutes),
  }]];
  if (rangeContains(states[0], totalMinutes)) return [totalMinutes];

  for (let index = 1; index < capacities.length; index += 1) {
    const capacity = capacities[index];
    const prior = states[index - 1];
    const next = prior.map(range => ({ ...range })); // skip this fragment
    if (capacity >= minProductiveSegmentMinutes) {
      for (const range of prior) {
        next.push({
          lo: range.lo + minProductiveSegmentMinutes,
          hi: Math.min(totalMinutes, range.hi + capacity),
        });
      }
    }
    const merged = mergeRanges(next);
    states.push(merged);
    if (rangeContains(merged, totalMinutes)) break;
  }

  const finalIndex = states.length - 1;
  if (!rangeContains(states[finalIndex], totalMinutes)) return null;

  const allocations = Array.from({ length: states.length }, () => 0);
  let remaining = totalMinutes;
  for (let index = finalIndex; index > 0; index -= 1) {
    const prior = states[index - 1];
    if (rangeContains(prior, remaining)) continue;
    const capacity = capacities[index];
    let chosen: number | null = null;
    for (const range of prior) {
      const lo = Math.max(minProductiveSegmentMinutes, remaining - range.hi);
      const hi = Math.min(capacity, remaining - range.lo);
      if (lo <= hi) {
        // Prefer the smallest later piece: it leaves the earliest productive
        // interval as full as possible without creating a short final tail.
        chosen = lo;
        break;
      }
    }
    if (chosen === null) return null;
    allocations[index] = chosen;
    remaining -= chosen;
  }
  if (remaining < minProductiveSegmentMinutes || remaining > firstCapacity) return null;
  allocations[0] = remaining;
  return allocations;
}

// B3a: a NaN/zero/negative runtime is a data defect, not a genuinely full
// calendar — the two used to share the same 'no-feasible-capacity' reason,
// which misled the planner into treating a master-data problem as a
// capacity problem. Default stays 'no-feasible-capacity' for every other
// caller; only the runtime-validity check below passes 'invalid-runtime'.
function capacityFailure(reason: PlacementInfeasibility['reason'] = 'no-feasible-capacity'): PlacementInfeasibility {
  return { kind: 'infeasible', reason, productiveSegments: [] };
}

/**
 * Pure setup-aware placement over caller-supplied effective operating
 * intervals. It emits only derived setup capacity plus productive ranges;
 * Store, persistence, alerts, and the order child-segment schema are outside
 * this primitive's boundary.
 */
export function placeWithSetup(request: Readonly<PlaceWithSetupRequest>): PlacementResult {
  const setup = request.setup ?? { kind: 'unresolved' as const, reason: 'initial-state-unknown' as const };
  if (setup.kind === 'unresolved') {
    return {
      kind: 'infeasible', reason: setup.reason, setup: { kind: 'unresolved', reason: setup.reason }, productiveSegments: [],
    };
  }
  if (!Number.isInteger(setup.minutes) || setup.minutes < 0) {
    return {
      kind: 'infeasible', reason: 'transition-unresolved',
      setup: { kind: 'unresolved', reason: 'transition-unresolved' }, productiveSegments: [],
    };
  }

  const runtimeMinutes = Math.round(Number(request.runtimeMinutes));
  if (!Number.isFinite(runtimeMinutes) || runtimeMinutes <= 0) return capacityFailure('invalid-runtime');
  const intervals = normalizedIntervals(request.freeIntervals, request.earliestStart);
  if (!intervals.length) return capacityFailure();
  const minProductiveSegmentMinutes = Number.isInteger(request.minProductiveSegmentMinutes)
    && (request.minProductiveSegmentMinutes as number) > 0
    ? (request.minProductiveSegmentMinutes as number)
    : MIN_PRODUCTIVE_SEGMENT_MINUTES;

  const place = (start: Date, productiveMinutes: number, productiveSegments: PlacementInterval[]): PlacementSuccess => {
    const productiveStart = new Date(start.getTime() + setup.minutes * 60 * 1000);
    return {
      kind: 'placed',
      ...(setup.minutes > 0 ? {
        setup: { start: new Date(start), end: productiveStart, minutes: setup.minutes },
      } : {}),
      productiveSegments: productiveSegments.length
        ? productiveSegments
        : [{ start: productiveStart, end: new Date(productiveStart.getTime() + productiveMinutes * 60 * 1000) }],
    };
  };

  const requiresContinuous = request.policy === 'never'
    || (request.policy === 'overlong_only' && request.isInherentlyOverlong !== true);
  if (requiresContinuous) {
    const requiredMinutes = setup.minutes + runtimeMinutes;
    for (const interval of intervals) {
      if (interval.minutes < requiredMinutes) continue;
      return place(interval.start, runtimeMinutes, []);
    }
    return capacityFailure();
  }

  // The under-floor exemption is explicitly complete-and-unsplit. It does not
  // permit a setup-only tail followed by a tiny continuation.
  if (runtimeMinutes < minProductiveSegmentMinutes) {
    for (const interval of intervals) {
      if (interval.minutes >= setup.minutes + runtimeMinutes) return place(interval.start, runtimeMinutes, []);
    }
    return capacityFailure();
  }

  for (let first = 0; first < intervals.length; first += 1) {
    const firstInterval = intervals[first];
    const firstProductiveStart = new Date(firstInterval.start.getTime() + setup.minutes * 60 * 1000);
    const firstCapacity = Math.floor((firstInterval.end.getTime() - firstProductiveStart.getTime()) / (60 * 1000));
    if (firstCapacity < minProductiveSegmentMinutes) continue;

    const slots: MinuteInterval[] = [{ start: firstProductiveStart, end: firstInterval.end, minutes: firstCapacity }];
    for (let index = first + 1; index < intervals.length; index += 1) slots.push(intervals[index]);
    const allocations = productiveAllocations(slots.map(slot => slot.minutes), runtimeMinutes, minProductiveSegmentMinutes);
    if (!allocations) continue;

    const productiveSegments = allocations.flatMap((minutes, index) => {
      if (minutes === 0) return [];
      const start = slots[index].start;
      return [{ start: new Date(start), end: new Date(start.getTime() + minutes * 60 * 1000) }];
    });
    return place(firstInterval.start, runtimeMinutes, productiveSegments);
  }
  return capacityFailure();
}

/** All reads needed for one candidate run.  The evaluator treats every field
 * as immutable and never fills missing calendar defaults back into this object. */
export interface ScheduleSnapshot {
  tasks: ReadonlyArray<NimbusTask>;
  /** Manually firmed ids; callers additionally fold ECC-firmed and
   * frozen-horizon ids in before invoking. */
  firmedIds: ReadonlySet<string> | ReadonlyArray<string>;
  alerts: ReadonlyArray<unknown>;
  selectedPlant: string | null;
  blocks: ReadonlyArray<NimbusBlock>;
  plantBlocks: ReadonlyArray<NimbusPlantBlock>;
  calendars: Readonly<Record<string, { workHours: WorkHours }>>;
  plants: Readonly<Record<string, { workHours: WorkHours }>>;
  lineSettings: Readonly<Record<string, NimbusLineSetting>>;
  masterData: NimbusMasterData | null;
  priorityRankMaps: PriorityRankMaps;
  /** Captured setup truth for detached evaluation. Optional for legacy
   * callers that provide `DueDateFirstBounds.setup` separately. */
  setupSnapshot?: SetupTruthSnapshot | null;
  /** Frozen-horizon value captured with the rest of the read model. */
  frozenHorizonEnd?: Date | null;
  /** Store/read-model revision used to reject stale Apply operations. */
  readModelVersion?: string;
}

export interface OptimizerRunContext {
  plant: string;
  planningStart: Date;
  runNow: Date;
  placementStart: Date;
  horizonEnd: Date;
  respectCalendar: boolean;
  respectFirmed: boolean;
  lines: readonly string[] | null;
  deadlineAt: number;
  readModelVersion: string;
}

export interface ObjectiveFacts {
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

export interface EvaluationRequest {
  mode?: OptimizerMode;
  plant?: string | null;
  lines?: ReadonlyArray<string> | null;
  startDate?: Date | string | number | null;
  endDate?: Date | string | number | null;
  respectFirmed?: boolean;
  respectCalendar?: boolean;
  /** Tests and callers that need deterministic candidate placement supply this. */
  now?: Date;
  /** Explicit wall-clock instant; unlike `startDate`, this is never the
   * planning-window lower bound. */
  runNow?: Date;
  /** Explicit planning-window lower bound. `startDate` remains its alias. */
  planningStart?: Date | string | number | null;
  /** Normalized effective placement floor, primarily for detached callers. */
  placementStart?: Date | string | number | null;
  /** Phase 2 (Pkg D): an absolute performance.now() timestamp overriding the
   *  setup-aware evaluators' default SETUP_AWARE_DEADLINE_MS search window
   *  (schedule-services.mts). Used by the optimizer preview's deferred Plan B
   *  comparison run, which gets a smaller, fixed budget instead of a full
   *  fresh deadline on the synchronous path. */
  deadlineAt?: number;
}

/** All search limits are intentionally supplied by the caller. Stage 0's
 * measurement gate chooses them; this detached evaluator must never invent
 * production thresholds, iteration caps, or time budgets. */
export interface DueDateFirstBounds {
  setup: SetupTruthSnapshot;
  lines?: readonly string[];
  strategy?: FragmentMode;
  exactSearchThreshold: number;
  iterationCap: number;
  clock: () => number;
  deadline: number;
  now: Date;
  horizonEnd: Date;
  /** User-selected planning lower bound. Defaults to `now` for legacy
   * detached callers. */
  planningStart?: Date;
  /** Captured wall-clock instant. Defaults to `now` for legacy callers. */
  runNow?: Date;
  /** Effective lower bound for newly generated setup/production. Defaults to
   * `now` for legacy callers. */
  placementStart?: Date;
  /** True uses line/plant calendars and blackout blocks; false uses
   * continuous capacity. */
  respectCalendar?: boolean;
  /** Optional plant rule supplied by the live engine; absent retains detached legacy behavior. */
  notBefore?: (task: NimbusTask) => Date | null;
  /** Optional plant rule: latest allowed END for a task (due-date push-forward
   * limit). Null = unconstrained. Mirrors notBefore. */
  notAfter?: (task: NimbusTask) => Date | null;
  /** Phase 1a: an optional caller-owned per-run context of indexes/memos
   *  (see `SetupRunContext`/`buildRunContext` below). Every hot-loop consumer
   *  reads this only when `runContext.snapshot` is the SAME object reference
   *  as the snapshot being evaluated; a stale or absent context degrades to
   *  the original unmemoized computation rather than a wrong answer. Never
   *  built or owned by this module beyond the one call that constructs it —
   *  it lives entirely on this bounds object for one evaluator invocation. */
  runContext?: SetupRunContext;
  /** Phase 1e: overrides `SETUP_AWARE_CONVERGENCE_WINDOW` for this run. Absent
   * falls back to that constant — the live engine wiring in
   * schedule-services.mts sets this explicitly alongside the other
   * `SETUP_AWARE_*` constants; tests may shrink it to make a plateau cheap. */
  convergenceWindow?: number;
}

/**
 * Per-run context of indexes and memos for the setup-aware evaluators
 * (Phase 1a). `evaluateDueDateFirst`/`evaluateSptWithSetup` build one of
 * these once per (snapshot, bounds.setup) pair via `buildRunContext` and
 * thread it to every hot loop below via `bounds.runContext`, so a single
 * optimize run's many candidate evaluations stop re-deriving the same
 * run-constant values (setup-resolution lookups, per-task state/rank
 * decoding, plant-constant reads, calendar windows). This is never
 * module-global state: it is a plain object that lives only as long as the
 * `bounds` it is attached to, built fresh by the caller for each run.
 */
export interface SetupRunContext {
  /** Identity guard: valid only for this exact snapshot object reference. */
  snapshot: Readonly<ScheduleSnapshot>;
  /** Phase 1b resolution index built from `bounds.setup`. Null when no setup
   *  definition is available for the plant — `resolveSetup` already treats a
   *  missing `index` as "use the unindexed scan", so callers simply pass this
   *  through unconditionally. */
  resolutionIndex: SetupResolutionIndex | null;
  plant: string;
  respectCalendar: boolean;
  /** Hoisted once: identical for every candidate this run evaluates. */
  activePriorityKeys: ReadonlyArray<string>;
  splitOrderPolicy: SplitOrderPolicy;
  minProductiveSegmentMinutes: number;
  /** Lazy per-task-id memos. */
  _stateForOrder: Map<string, SetupStateKey | null>;
  _stateSignatureKey: Map<string, string | null>;
  _notBefore: Map<string, Date | null>;
  _notAfter: Map<string, Date | null>;
  /** Lazy per-(line, taskId) memos, keyed by NUL-joined `line + taskId`
   *  (mirrors `setup-domain.mts`'s `joinIndexKey` convention). */
  _rankVector: Map<string, number[]>;
  _policyKeyForTask: Map<string, string>;
  /** Per-(plant, line) pre-filtered/merged/sorted blackout blocks (ms
   *  timestamps), filled in once per (plant, line) on first use — the
   *  `Calendar._runBlocks` equivalent for this detached evaluator. Keyed by
   *  plant too (not just line): machine codes are documented as reusable
   *  across plants, so a line-only key could return one plant's cached
   *  blocks for another. */
  _lineBlocks: Map<string, ReadonlyArray<{ start: number; end: number }>>;
  /** Lazy per-(plant, line, dayStartMs) joint (line ∩ plant) work-window
   *  memo — plant is folded into the key for the same reuse-across-plants
   *  reason as `_lineBlocks`. */
  _dayWindow: Map<string, PlacementInterval | null>;
  /** Lazy per-line pre-filtered active/version-matched overrides consumed by
   *  `inactiveOverrideForTransition` — the per-call residual checks
   *  (successor id, states) still run against this small filtered array. */
  _overridesByLine: Map<string, ReadonlyArray<SetupOccurrenceOverride>>;
  /** Built once, in full, on first use — covers every line at once. */
  _plantByLine: Map<string, string | null> | null;
}

/**
 * Builds a fresh `SetupRunContext` for one (snapshot, bounds.setup) pair.
 * Pure: reads only `snapshot` and `bounds.setup`, returns a new object, and
 * never mutates its inputs or any module-level state. Cheap plant-constant
 * fields are computed eagerly; everything keyed by task/line/day is an empty
 * lazy `Map` filled in by the memo helpers below on first use.
 */
export function buildRunContext(
  snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>,
): SetupRunContext {
  const plant = bounds.setup.plant;
  const definition = bounds.setup.definition;
  const resolutionIndex = definition
    ? buildSetupResolutionIndex({
      definition,
      machineRows: bounds.setup.machine_rows,
      plantRows: bounds.setup.plant_rows,
      overrides: bounds.setup.overrides,
    })
    : null;
  return {
    snapshot,
    resolutionIndex,
    plant,
    respectCalendar: bounds.respectCalendar ?? true,
    activePriorityKeys: activePriorityKeys(snapshot, plant),
    splitOrderPolicy: bounds.respectCalendar === false ? 'never' : splitOrderPolicyForSnapshot(snapshot, plant),
    minProductiveSegmentMinutes: minProductiveSegmentMinutesForSnapshot(snapshot, plant),
    _stateForOrder: new Map(),
    _stateSignatureKey: new Map(),
    _notBefore: new Map(),
    _notAfter: new Map(),
    _rankVector: new Map(),
    _policyKeyForTask: new Map(),
    _lineBlocks: new Map(),
    _dayWindow: new Map(),
    _overridesByLine: new Map(),
    _plantByLine: null,
  };
}

/** The detached evaluator has three related clocks. `planningStart` defines
 * which already scheduled work belongs to this run's mutable scope, while
 * `placementStart` is the earliest instant at which a newly generated setup
 * or production interval may begin. Legacy callers only provide `now`, so it
 * remains the fallback for all three values. */
function normalizeRunDates(bounds: Readonly<DueDateFirstBounds>): Readonly<DueDateFirstBounds> {
  const legacyNow = timestamp(bounds.now) ?? new Date(0);
  const planningStart = timestamp(bounds.planningStart) ?? legacyNow;
  const runNow = timestamp(bounds.runNow) ?? legacyNow;
  const placementStart = timestamp(bounds.placementStart)
    ?? new Date(Math.max(+planningStart, +runNow));
  return {
    ...bounds,
    now: new Date(placementStart),
    planningStart: new Date(planningStart),
    runNow: new Date(runNow),
    placementStart: new Date(placementStart),
  };
}

/** Builds the run's `SetupRunContext` fresh only when `bounds.runContext` is
 * absent or was built for a different snapshot object, and otherwise reuses
 * it unchanged. Returns the (possibly augmented) bounds to thread below, so
 * every nested helper can read `bounds.runContext` without a second identity
 * check — safe because that returned bounds object is never mutated again.
 *
 * Invariant this guard does NOT check: a reused `runContext` is only valid
 * for the same `bounds.setup` (definition/matrix rows/overrides) it was
 * built from — `resolutionIndex` and the hoisted plant constants are derived
 * from `bounds.setup`, not `snapshot`, so a caller that reused a `snapshot`
 * object but swapped in different `bounds.setup` would silently get stale
 * setup truth. Every caller today satisfies this for free: a `runContext` is
 * created and consumed entirely within one `runAndApply`/evaluator
 * invocation, which never changes `bounds.setup` mid-call. A future caller
 * must preserve that pairing (or extend this guard with a `bounds.setup`
 * identity check) rather than reuse a `runContext` across a `bounds.setup`
 * change. */
function withRunContext(
  snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>,
): Readonly<DueDateFirstBounds> {
  const normalized = normalizeRunDates(bounds);
  if (normalized.runContext && normalized.runContext.snapshot === snapshot) return normalized;
  return { ...normalized, runContext: buildRunContext(snapshot, normalized) };
}

export interface SetupPolicyThresholds {
  throughputMinSavingsMin: number;
  throughputMaxSlipMin: number;
}

export interface CandidateReason {
  code: string;
  message: string;
  line?: string;
  taskId?: string;
}

/** A non-persistent diagnostic produced while evaluating one detached candidate. */
export interface CandidateDiagnostic {
  level: 'warn' | 'error';
  scope: string;
  code: string;
  message: string;
  context: Readonly<Record<string, unknown>>;
}

export interface SearchDiagnostics {
  candidateCount: number;
  method: 'legacy-detached' | 'due-date-first-exact' | 'due-date-first-greedy' | 'spt-detached';
  /** 'converged' (Phase 1e) means the search stopped by choice after a long
   * non-improving plateau, with a feasible winner already in hand — it
   * counts like completion, never like starvation (see the min-changeover
   * starvation guard and `limitReached` below, both of which deliberately
   * omit it). */
  termination: 'completed' | 'no-plant' | 'deadline' | 'iteration-cap' | 'infeasible' | 'converged';
  runtimeMs: number;
  limitReached: boolean;
  events: ReadonlyArray<CandidateDiagnostic>;
  budgetMs?: number;
  deadlineAt?: number;
  iterationsUsed?: number;
  eligibleCount?: number;
  evaluatedCount?: number;
  placedCount?: number;
  unknownTailCount?: number;
  unknownEdgeCount?: number;
  exhaustive?: boolean;
  quality?: 'exact' | 'heuristic';
  respectCalendar?: boolean;
}

export interface MissingSetupEdge {
  line: string;
  predecessorOrderId?: string | null;
  successorOrderId?: string | null;
  reason: string;
}

const UNCOVERED_SETUP_TRANSITION_REASON = 'No version-matched setup transition covers this state pair';
const PROTECTED_FIRMED_BOUNDARY_OUTSIDE_HORIZON_REASON = 'protected-firmed-boundary-outside-horizon';

/** Phase 1e early-convergence exit: once `exactSearch`/`greedySearch` have
 * evaluated this many candidates in a row with no winner improvement (and a
 * feasible winner already exists), stop searching and report `'converged'`
 * rather than continuing to burn iterations/wall-clock on a plateaued
 * search. Overridable per-run via `bounds.convergenceWindow` (the live
 * engine wiring in schedule-services.mts defaults it to this constant); a
 * test can shrink it to make a plateau cheap to construct. */
export const SETUP_AWARE_CONVERGENCE_WINDOW = 2000;

/** Phase 1.5 tail-pass valve: `placeUnknownTail`/`placeWholeLineAsTail` stop
 * ATTEMPTING placement once wall-clock time exceeds `bounds.deadline` by more
 * than this many milliseconds — time-based only, never gated on iteration
 * budget — routing every remaining order through the existing
 * 'unknown-setup-tail-unplaced' diagnostic instead (never-freeze: retained at
 * its current dates, not dropped). */
export const SETUP_AWARE_TAIL_OVERRUN_MS = 1000;

/** Score index carrying the count of uncovered-but-admitted transitions in a
 * candidate (A2). Appended, never inserted: `score[5]` is read as setup-minute
 * savings elsewhere (`evaluateMinChangeover`/`selectThroughputCandidate`), so
 * renumbering would corrupt the min-changeover accept/reject decision.
 * Compared explicitly in `compareCandidate` immediately after `policyKey` —
 * never folded into the mode-permuted `terms` list — so it stays mode-
 * independent: fewest uncovered edges always outranks every term except the
 * over-cap tier (SCORE_OVER_CAP), which is compared first. This ordering is
 * mode-independent EXCEPT for `'due-date'` (2026-09-09), whose dedicated
 * `compareDueDateCandidate` puts lateness (score[2]/score[3]) and even
 * `policyKey` itself ahead of both this tier and SCORE_OVER_CAP — see that
 * function. */
const SCORE_UNCOVERED = 6;

/** Score index carrying the count of over-cap orders in a candidate
 * (due-date push-forward limit, 2026-09-09): an order whose scheduled end
 * exceeds `bounds.notAfter(task)`. Appended, never inserted — same rule as
 * SCORE_UNCOVERED above. Compared in `compareCandidate` immediately after
 * `policyKey` and BEFORE the coverage tier (SCORE_UNCOVERED): on a plant with
 * no real matrix, coverage is effectively same-signature grouping, so the cap
 * must outrank it or a changeover saving could push an order arbitrarily far
 * past its cap. Null/absent `bounds.notAfter` means every candidate's
 * score[SCORE_OVER_CAP] is 0 — a provable no-op default. Mode-independent
 * except for `'due-date'`, where `compareDueDateCandidate` still compares this
 * tier second (right after hard feasibility) but ahead of `policyKey` — see
 * that function's own comment. */
const SCORE_OVER_CAP = 7;

/** The canonical hard-infeasible score vector (`score[0] = 1`), now 8-wide so
 * every candidate — feasible or not — carries the same arity as `score[
 * SCORE_OVER_CAP]`. Arity is not type-enforced (`score` is `number[]`), so
 * this exists to keep every literal in one place rather than drifting. */
function infeasibleScore(): number[] {
  return [1, 0, 0, 0, 0, 0, 0, 0];
}

/** The canonical zero (fully-neutral) 8-wide score vector — every
 * accumulator/placeholder site that used to hand-write a 7-wide zero literal
 * now calls this instead, so widening the vector again means editing one
 * function rather than re-auditing every call site. */
function zeroScore(): number[] {
  return [0, 0, 0, 0, 0, 0, 0, 0];
}

export interface PlanningDisposition {
  id: string;
  line: string;
  status: 'scheduled' | 'needs_planning' | 'protected';
  reason?: { code: string; message: string };
}
export interface ValidationFinding {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  taskId?: string;
  line?: string;
}
export interface CandidateResult {
  dispositions?: readonly PlanningDisposition[];
  validationFindings?: readonly ValidationFinding[];
  searchComplete?: boolean;
  gapFill?: { complete: boolean; placed: number; unchecked: number; runtimeMs: number };
  validationContext?: { baselineSnapshot?: Readonly<ScheduleSnapshot>; snapshot: Readonly<ScheduleSnapshot>; bounds: Readonly<DueDateFirstBounds> };
  patches: ReadonlyArray<SchedulePatch>;
  score: readonly number[];
  objective?: ObjectiveFacts;
  explanation: ReadonlyArray<CandidateReason>;
  diagnostics: SearchDiagnostics;
  unchangedLines: readonly string[];
  missingEdges: readonly MissingSetupEdge[];
  /** Compatibility detail consumed only by the existing backlog-preview UI. */
  backlogResult?: RemoveBacklogResult;
}

interface DueDateGroup {
  key: string;
  state: SetupStateKey;
  tasks: NimbusTask[];
}

interface DueDateCandidate {
  feasible: boolean;
  patches: SchedulePatch[];
  score: number[];
  /** Full lexicographic policy vector. `score[1]` is a compact diagnostic
   * contribution; this preserves every configured priority tier without a
   * lossy numeric encoding. */
  policyKey: string;
  sequenceKey: string;
  admissionKey?: string;
  /** Orders deliberately deferred from this capacity-bounded fragment. They
   * remain eligible for the next fragment after a firmed boundary. */
  unadmitted: NimbusTask[];
  explanation: CandidateReason[];
  missingEdges: MissingSetupEdge[];
  /** The predecessor identity/state this covered core actually ended on, set
   * only on a feasible result. A subsequent `placeUnknownTail` call or a
   * firmed boundary's incoming-setup reservation chains from this rather than
   * re-deriving it from the fragment's original predecessor. */
  finalState?: SetupStateKey | null;
  finalPredecessorOrderId?: string | null;
}

interface SearchRun {
  candidateCount: number;
  method: 'due-date-first-exact' | 'due-date-first-greedy';
  termination: 'completed' | 'deadline' | 'iteration-cap' | 'converged';
  winner: DueDateCandidate | null;
  missingEdges: MissingSetupEdge[];
  /** Orders whose setup state (or matrix coverage) could not be resolved
   * inside this fragment's covered-core search — never charged into the
   * min-changeover objective (no fake zero-cost edge). Placed afterward via
   * `placeUnknownTail`, strictly after the covered core and never
   * interleaved: an unknown order mid-chain would make every downstream
   * covered transition's predecessor unknown too. */
  unknownTail: NimbusTask[];
}

/** True when a `SearchRun` reached a real, trustworthy conclusion — either it
 * fully completed or it converged with a confirmed winner (Phase 1e) — as
 * opposed to being cut off mid-enumeration by 'deadline'/'iteration-cap' with
 * no guarantee the result is final. Boundary-fallback enumeration (below)
 * must treat both the same: a fallback/continuation run that converged with
 * a real winner is a legitimate, usable result, not a truncated one — using
 * the strict `=== 'completed'` check on its own would silently discard a
 * converged winner and fall through to inferior unknown-tail placement.
 * Exported (rather than kept module-private like most helpers here) solely
 * so this exact truth table can be pinned by a direct unit test — see
 * tests/modules/setup-scheduler.test.mjs for why: `supportsBoundaryFallback`
 * (below) is provably unreachable with `run.winner === null` under current
 * `candidateForSequence` semantics, so the boundary-fallback branches that
 * consume this predicate cannot be driven through the public
 * `evaluateDueDateFirst`/`evaluateSptWithSetup` API to prove the fix
 * end-to-end. */
export function isSearchConclusive(termination: SearchRun['termination']): boolean {
  return termination === 'completed' || termination === 'converged';
}

/** Severity ranking used to aggregate multiple line/fragment `SearchRun`
 * terminations into one overall value: the WORST (most severe) one wins,
 * never simply "the last one seen". Without this, a later line/fragment that
 * converges (Phase 1e) could silently overwrite an earlier line's genuine
 * 'deadline'/'iteration-cap', falsifying `limitReached` (the preview's "may
 * not be optimal" signal) and defeating `evaluateMinChangeover`'s
 * `candidateStarved` guard. Order: deadline > iteration-cap > converged >
 * completed — 'converged' outranks 'completed' (it IS worth surfacing
 * distinctly on the aggregate) but must never be conflated with, or ranked
 * above, a genuine budget cutoff. */
const TERMINATION_SEVERITY: Record<SearchRun['termination'], number> = {
  deadline: 3,
  'iteration-cap': 2,
  converged: 1,
  completed: 0,
};

function worseTermination(
  current: SearchRun['termination'], next: SearchRun['termination'],
): SearchRun['termination'] {
  return TERMINATION_SEVERITY[next] > TERMINATION_SEVERITY[current] ? next : current;
}

/** A per-line counter. Constructed fresh inside the per-line loop of both
 * `evaluateDueDateFirst` and `evaluateSptWithSetup` (Part 2b) so one large
 * line's search can never exhaust the budget for every other line on the
 * plant; a firmed-boundary fragment run still shares it with every other
 * fragment on the same line. */
interface SearchBudget {
  remainingIterations: number;
}

interface FirmedBoundary {
  task: NimbusTask;
  /** Nullable (never-freeze widening, e24b12b follow-up): an in-progress or
   * past firmed order with an unresolvable setup state (e.g. a blank
   * signature under strict_blanks) still occupies a real, valid interval —
   * it is admitted as an opaque time block rather than freezing the line. */
  state: SetupStateKey | null;
  start: Date;
  end: Date;
}

interface FragmentContext {
  start: Date;
  end: Date;
  /** Nullable: an unknown line-initial state (no persisted state, no
   * scheduled anchor) no longer skips the whole line. The first known order
   * in a fragment whose predecessor state is null places via the same
   * zero-minute mechanism as an unknown-tail order (Part 1d). */
  predecessorState: SetupStateKey | null;
  predecessorOrderId: string | null;
  /** Every order still present on the immutable line snapshot, including a
   * preserved unknown-state anchor that is deliberately absent from this
   * fragment's mutable task list. */
  lineOrderIds: ReadonlySet<string>;
  /** Only the unknown-current-state preservation path can safely continue
   * past a binding whose predecessor has been deleted; ordinary known-state
   * evaluation retains the existing fail-closed override behavior. */
  allowsDeletedPredecessorBinding?: boolean;
  nextFirmed?: FirmedBoundary;
  /** An active override crossing a firmed boundary makes the named free order
   * the exact first/last member of this obstacle-free fragment. */
  requiredFirstOrderId?: string;
  requiredLastOrderId?: string;
}

interface LineSearchResult {
  patches: SchedulePatch[];
  score: number[];
  explanation: CandidateReason[];
  missingEdges: MissingSetupEdge[];
  candidateCount: number;
  method: 'due-date-first-exact' | 'due-date-first-greedy';
  termination: SearchRun['termination'];
  unchanged: boolean;
}

type FragmentMode = 'due-date-first' | 'spt' | 'min-changeover' | 'throughput' | 'due-date';

interface BoundaryOverrideLocks {
  requiredFirstOrderId?: string;
  requiredLastOrderId?: string;
  /** A persisted current line state can bind directly to the first firmed
   * order. In that case no free work may occupy the preceding fragment. */
  requiresInitialState?: boolean;
  /** Like `requiresInitialState`, but the protected predecessor is a
   * preserved current first order rather than persisted line state. */
  requiresInitialPredecessorId?: string;
  /** A firmed predecessor and successor can be a protected occurrence too. The
   * successor fragment must remain empty so no free production breaks that
   * physical adjacency. */
  requiredFirmedPredecessorId?: string;
  requiredFirmedSuccessorId?: string;
  issue?: MissingSetupEdge;
}

/** A persisted initial state can itself be the protected predecessor of a
 * free order. Unlike an ordinary free/free pair, that successor must be the
 * very first physical order in the plan and therefore belongs before the
 * first firmed boundary even when its due date is later. */
interface InitialFreeOverrideLock {
  requiredFirstOrderId?: string;
  issue?: MissingSetupEdge;
}

/** When persisted physical state is unavailable, the first usable scheduled
 * order remains physical truth for this detached run. It is never patched;
 * only its known successor state is used to plan later work. */
interface PreservedInitialAnchor {
  task: NimbusTask;
  state: SetupStateKey;
  start: Date;
  end: Date;
}

interface InitialScheduledAnchor {
  task: NimbusTask;
  state: SetupStateKey | null;
  start: Date;
  end: Date;
}

interface LineInitialContext {
  predecessorOrderId: string | null;
  fragmentStart: Date;
  /** Original line tasks are retained for override-binding diagnostics even
   * when a preserved anchor is removed from the mutable candidate list. */
  allTasks: ReadonlyArray<NimbusTask>;
  preservedAnchor?: PreservedInitialAnchor;
}

/** Active occurrence overrides are physical adjacency constraints, not merely
 * a preferred setup-duration lookup. These maps only contain pairs whose two
 * free orders belong to the fragment currently being searched; firmed-boundary
 * pairs stay with BoundaryOverrideLocks. */
interface FragmentAdjacency {
  predecessorBySuccessor: ReadonlyMap<string, string>;
  successorByPredecessor: ReadonlyMap<string, string>;
  /** An override whose predecessor is the persisted current line state. */
  requiredInitialSuccessorId?: string;
  issue?: MissingSetupEdge;
}

function timestamp(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value) : null;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

function dueTimestamp(task: NimbusTask): number {
  return (timestamp(task.original_end_date) ?? timestamp(task.ORIGINAL_END_DATE))?.getTime()
    ?? Number.MAX_SAFE_INTEGER;
}

function taskId(task: NimbusTask): string {
  return String(task.id);
}

function stateKey(state: SetupStateKey): string {
  return JSON.stringify(state);
}

/** Ordinal (code-point) string comparison. `localeCompare` walks ICU
 * collation tables on every call, which dominates sort/compare cost once it
 * runs per candidate permutation. Used only where the compared alphabet is
 * known ASCII (zero-padded digit policy keys, MD5-hex task ids), where
 * ordinal order is identical to `localeCompare`'s order. */
function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Phase 1a memo: `stateForOrder` is a pure function of (task, definition),
 * both constant for the whole run once an evaluator starts — a candidate
 * search calls it on the very same task repeatedly across permutations,
 * fragments, and fallback attempts. Falls back to the unmemoized call
 * whenever no run context is threaded (`bounds.runContext` absent). */
function orderState(
  bounds: Readonly<DueDateFirstBounds>, task: Readonly<NimbusTask>, definition: SetupDefinition,
): SetupStateKey | null {
  const ctx = bounds.runContext;
  if (!ctx) return stateForOrder(task, definition);
  const id = taskId(task);
  const cached = ctx._stateForOrder.get(id);
  if (cached !== undefined) return cached;
  const state = stateForOrder(task, definition);
  ctx._stateForOrder.set(id, state);
  return state;
}

/** Phase 1a memo: the canonical `stateKey` string for a task's resolved
 * state, replacing repeated `stateKey(stateForOrder(...))`/JSON.stringify
 * calls for the same task within one run. Reuses `orderState`'s cache rather
 * than re-deriving the state. */
function orderStateKey(
  bounds: Readonly<DueDateFirstBounds>, task: Readonly<NimbusTask>, definition: SetupDefinition,
): string | null {
  const ctx = bounds.runContext;
  if (!ctx) {
    const state = stateForOrder(task, definition);
    return state ? stateKey(state) : null;
  }
  const id = taskId(task);
  const cached = ctx._stateSignatureKey.get(id);
  if (cached !== undefined) return cached;
  const state = orderState(bounds, task, definition);
  const key = state ? stateKey(state) : null;
  ctx._stateSignatureKey.set(id, key);
  return key;
}

/** Phase 1a memo: `bounds.notBefore` is an engine-supplied pull-forward rule
 * that a hot loop calls on the same task repeatedly across permutations.
 * Falls back to the direct call whenever no run context is threaded. */
function notBeforeFor(bounds: Readonly<DueDateFirstBounds>, task: Readonly<NimbusTask>): Date | null {
  if (!bounds.notBefore) return null;
  const ctx = bounds.runContext;
  if (!ctx) return bounds.notBefore(task) ?? null;
  const id = taskId(task);
  const cached = ctx._notBefore.get(id);
  if (cached !== undefined) return cached;
  const value = bounds.notBefore(task) ?? null;
  ctx._notBefore.set(id, value);
  return value;
}

/** Phase 1a memo: `bounds.notAfter` (due-date push-forward limit ceiling) is
 * an engine-supplied rule a hot loop calls on the same task repeatedly across
 * permutations. Falls back to the direct call whenever no run context is
 * threaded. Mirrors `notBeforeFor` exactly. */
function notAfterFor(bounds: Readonly<DueDateFirstBounds>, task: Readonly<NimbusTask>): Date | null {
  if (!bounds.notAfter) return null;
  const ctx = bounds.runContext;
  if (!ctx) return bounds.notAfter(task) ?? null;
  const id = taskId(task);
  const cached = ctx._notAfter.get(id);
  if (cached !== undefined) return cached;
  const value = bounds.notAfter(task) ?? null;
  ctx._notAfter.set(id, value);
  return value;
}

const PRIORITY_TASK_FIELDS: Readonly<Record<string, string>> = {
  colorWheel: 'COLOR',
  prt01: 'PRT_01',
  prt02: 'PRT_02',
  productionVersion: 'PRODUCTION_VERSION',
};

// Rank-lookup values here are always order attribute values for
// PRIORITY_TASK_FIELDS (color / prt01 / prt02 / productionVersion) — never
// boolean-shaped — so this delegates to setup-domain's `normalizedValue`
// fold for a single source of truth rather than keeping an independent
// `toUpperCase()`. The boolean exemption in `normalizedValue` is inert here
// (no priority field value is ever literally "true"/"false"), so behavior
// is unchanged from the prior standalone implementation.
function normalizedPriorityValue(value: unknown): string {
  return normalizedValue(value);
}

/** Mirrors the active, tree-aware priority order without reaching into Store.
 * A detached candidate must consume only the master-data and rank snapshot it
 * was supplied, otherwise a plant switch can make a private search compare
 * against another plant's policy. */
export function activePriorityKeys(snapshot: Readonly<ScheduleSnapshot>, plant: string): string[] {
  const tree = snapshot.masterData?.plants.find(row => row.plant === plant)?.constraints;
  if (!tree?.length) return ['colorWheel'];

  const seen = new Set<string>();
  const keys: string[] = [];
  const walk = (nodes: ReadonlyArray<ConstraintConfig>): void => {
    const indexed = nodes.map((node, index) => ({ node, index }));
    indexed.sort((left, right) => (
      (left.node.order ?? 99) - (right.node.order ?? 99) || left.index - right.index
    ));
    for (const { node } of indexed) {
      if (!node.enabled) continue;
      if (!seen.has(node.key)) {
        seen.add(node.key);
        keys.push(node.key);
      }
      if (node.children?.length) walk(node.children);
    }
  };
  walk(tree);
  return keys;
}

function rankForTask(
  snapshot: Readonly<ScheduleSnapshot>,
  fieldKey: string,
  line: string,
  task: NimbusTask,
): number {
  const taskField = PRIORITY_TASK_FIELDS[fieldKey];
  if (!taskField) return 999999;
  const value = normalizedPriorityValue((task as unknown as Record<string, unknown>)[taskField]);
  const byLine = snapshot.priorityRankMaps ?? {};
  const scoped = byLine[line]?.[fieldKey];
  const map = scoped && Object.keys(scoped).length ? scoped : byLine['']?.[fieldKey];
  const raw = map?.[value] ?? 999999;
  return Number.isFinite(raw) ? Math.max(0, Math.min(9999999, Math.round(raw))) : 999999;
}

/** Compound-key join for the per-(line, taskId) memo caches below. NUL
 * (`String.fromCharCode(0)`, not a literal backslash-escape — see
 * `setup-domain.mts`'s `joinIndexKey`), not a printable separator, because a
 * line/machine code is a real, uncontrolled string that can legitimately
 * contain spaces (e.g. "LINE 1"), which would otherwise let two different
 * (line, taskId) pairs collide on the same cache key. */
const CTX_KEY_SEP = String.fromCharCode(0);

/** Phase 1a memo: the per-task rank vector (one rank per active priority
 * key, in the same order as `ctx.activePriorityKeys`) that both
 * `policyKeyForTask` and `policyScore` derive their result from. Memoized
 * per-(line, task) since a rank depends on the line-scoped priority-rank
 * map. Falls back to a fresh, unmemoized vector when `ctx` is absent. */
function rankVectorForTask(
  snapshot: Readonly<ScheduleSnapshot>, plant: string, line: string, task: NimbusTask, ctx?: SetupRunContext,
): number[] {
  const keys = ctx ? ctx.activePriorityKeys : activePriorityKeys(snapshot, plant);
  if (!ctx) return keys.map(fieldKey => rankForTask(snapshot, fieldKey, line, task));
  const cacheKey = line + CTX_KEY_SEP + taskId(task);
  const cached = ctx._rankVector.get(cacheKey);
  if (cached) return cached;
  const vector = keys.map(fieldKey => rankForTask(snapshot, fieldKey, line, task));
  ctx._rankVector.set(cacheKey, vector);
  return vector;
}

function policyKeyForTask(
  snapshot: Readonly<ScheduleSnapshot>, plant: string, line: string, task: NimbusTask, ctx?: SetupRunContext,
): string {
  if (!ctx) {
    return activePriorityKeys(snapshot, plant)
      .map(fieldKey => String(rankForTask(snapshot, fieldKey, line, task)).padStart(7, '0'))
      .join('|');
  }
  const cacheKey = line + CTX_KEY_SEP + taskId(task);
  const cached = ctx._policyKeyForTask.get(cacheKey);
  if (cached !== undefined) return cached;
  const vector = rankVectorForTask(snapshot, plant, line, task, ctx);
  const key = vector.map(rank => String(rank).padStart(7, '0')).join('|');
  ctx._policyKeyForTask.set(cacheKey, key);
  return key;
}

function policyKeyForSequence(
  snapshot: Readonly<ScheduleSnapshot>, plant: string, line: string, sequence: ReadonlyArray<NimbusTask>,
  ctx?: SetupRunContext,
): string {
  return sequence.map(task => policyKeyForTask(snapshot, plant, line, task, ctx)).join('\u0000');
}

function policyScore(
  snapshot: Readonly<ScheduleSnapshot>, plant: string, line: string, sequence: ReadonlyArray<NimbusTask>,
  ctx?: SetupRunContext,
): number {
  // Kept as a numeric score slot for preview consumers. Candidate comparison
  // uses the full policyKey above, because a scalar sum cannot preserve a
  // nested policy tree's lexicographic precedence.
  const keys = ctx ? ctx.activePriorityKeys : activePriorityKeys(snapshot, plant);
  if (!keys.length) return 0;
  return sequence.reduce((total, task, position) => {
    const vector = ctx ? rankVectorForTask(snapshot, plant, line, task, ctx) : null;
    const taskScore = keys.reduce((rankTotal, fieldKey, depth) => (
      rankTotal + (vector ? vector[depth] : rankForTask(snapshot, fieldKey, line, task)) * (keys.length - depth)
    ), 0);
    return total + taskScore * (sequence.length - position);
  }, 0);
}

/** Decorate-sort-undecorate: each task's policy key is computed once (via
 * the ctx memo when present) rather than up to twice per comparator call,
 * and compared ordinally — the policy-key alphabet is zero-padded ASCII
 * digits joined by `|`, so ordinal order is identical to `localeCompare`'s
 * order there, without walking ICU collation tables on every comparison. */
function orderedByPolicyThenDue(
  snapshot: Readonly<ScheduleSnapshot>, plant: string, line: string, tasks: ReadonlyArray<NimbusTask>,
  ctx?: SetupRunContext,
): NimbusTask[] {
  const decorated = tasks.map(task => ({ task, key: policyKeyForTask(snapshot, plant, line, task, ctx) }));
  decorated.sort((left, right) => (
    ordinalCompare(left.key, right.key)
    || dueTimestamp(left.task) - dueTimestamp(right.task)
    || taskId(left.task).localeCompare(taskId(right.task))
  ));
  return decorated.map(entry => entry.task);
}

/** `'due-date'` mode's counterpart to `orderedByPolicyThenDue` above: same
 * decorate-sort-undecorate shape, but due date is compared FIRST so search
 * seeding matches `compareDueDateCandidate`'s tier order (lateness ahead of
 * policyKey). Falling back to `orderedByPolicyThenDue`'s ordering here would
 * seed the search away from the very sequences `compareDueDateCandidate`
 * prefers. */
function orderedByDueThenPolicy(
  snapshot: Readonly<ScheduleSnapshot>, plant: string, line: string, tasks: ReadonlyArray<NimbusTask>,
  ctx?: SetupRunContext,
): NimbusTask[] {
  const decorated = tasks.map(task => ({ task, key: policyKeyForTask(snapshot, plant, line, task, ctx) }));
  decorated.sort((left, right) => (
    dueTimestamp(left.task) - dueTimestamp(right.task)
    || ordinalCompare(left.key, right.key)
    || taskId(left.task).localeCompare(taskId(right.task))
  ));
  return decorated.map(entry => entry.task);
}

/** Phase 1a memo: the status/machine/signature-version predicate every
 * override-lookup helper in this module repeats over `bounds.setup.overrides`
 * for one line. `inactiveOverrideForTransition` is the only caller that reads
 * this cached slice (it is the only one invoked per-transition, i.e. per
 * candidate); the once-per-line-eval callers keep filtering directly since
 * they gain nothing from a run-scoped cache. */
function overridesForLine(
  bounds: Readonly<DueDateFirstBounds>, line: string, definition: SetupDefinition,
): ReadonlyArray<SetupOccurrenceOverride> {
  const matches = (override: SetupOccurrenceOverride): boolean => (
    override.status === 'active'
    && override.machine === line
    && override.signature_version === definition.signature_version
  );
  const ctx = bounds.runContext;
  if (!ctx) return bounds.setup.overrides.filter(matches);
  const cached = ctx._overridesByLine.get(line);
  if (cached) return cached;
  const filtered = bounds.setup.overrides.filter(matches);
  ctx._overridesByLine.set(line, filtered);
  return filtered;
}

/** An active occurrence override belongs to one physical adjacency. When a
 * candidate puts its successor behind a different order/state, the override
 * does not travel with that order; the candidate is infeasible and reports
 * the binding as inactive. */
function inactiveOverrideForTransition(
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  predecessorState: SetupStateKey | null,
  successorState: SetupStateKey | null,
  predecessorOrderId: string | null,
  successorOrderId: string,
  lineOrderIds: ReadonlySet<string>,
  allowsDeletedPredecessorBinding = false,
): MissingSetupEdge | null {
  const definition = bounds.setup.definition!;
  const bound = overridesForLine(bounds, line, definition).filter(override => (
    override.successor_order_id === successorOrderId
  ));
  for (const override of bound) {
    // A binding to a deleted predecessor is already surfaced as an inactive
    // diagnostic at line scope. It must not make otherwise safe later work
    // unschedulable merely because the exact historical adjacency no longer
    // exists in this immutable snapshot.
    if (allowsDeletedPredecessorBinding
      && override.predecessor_order_id !== null
      && !lineOrderIds.has(String(override.predecessor_order_id))) {
      continue;
    }
    if (override.predecessor_order_id !== predecessorOrderId
      // An unknown predecessor or successor state can never confirm a bound
      // override; treat it as a mismatch rather than skipping the check. A
      // null successor state means the firmed boundary itself has an
      // unresolvable setup state.
      || predecessorState === null
      || successorState === null
      || stateKey(override.predecessor_state_key) !== stateKey(predecessorState)
      || stateKey(override.successor_state_key) !== stateKey(successorState)) {
      return { line, predecessorOrderId, successorOrderId, reason: 'override-inactive' };
    }
  }
  return null;
}

function inactiveOverrideEdge(
  line: string,
  predecessorOrderId: string | null | undefined,
  successorOrderId: string | null | undefined,
): MissingSetupEdge {
  return { line, predecessorOrderId, successorOrderId, reason: 'override-inactive' };
}

/** A deleted successor cannot participate in any later fragment lookup, so
 * detect it from the immutable line snapshot once and retain an auditable
 * inactive-binding diagnostic while allowing unrelated work to continue. */
function missingSuccessorOverrideEdges(
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  tasks: ReadonlyArray<NimbusTask>,
): MissingSetupEdge[] {
  const definition = bounds.setup.definition!;
  const presentIds = new Set(tasks.map(taskId));
  return bounds.setup.overrides.flatMap(override => {
    if (override.status !== 'active'
      || override.machine !== line
      || override.signature_version !== definition.signature_version) {
      return [];
    }
    const successorOrderId = String(override.successor_order_id);
    if (presentIds.has(successorOrderId)) return [];
    return [inactiveOverrideEdge(line, override.predecessor_order_id, successorOrderId)];
  });
}

function missingSuccessorOverrideReasons(
  line: string,
  edges: ReadonlyArray<MissingSetupEdge>,
): CandidateReason[] {
  return edges.map(edge => ({
    code: 'override-inactive',
    message: `Active override successor ${edge.successorOrderId ?? 'unknown'} is no longer on this line.`,
    line,
    taskId: edge.successorOrderId ?? undefined,
  }));
}

/** The inverse stale-binding case matters just as much as a removed
 * successor: a still-present successor must not silently retain an active
 * override that names an order no longer on this line. */
function missingPredecessorOverrideEdges(
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  tasks: ReadonlyArray<NimbusTask>,
): MissingSetupEdge[] {
  const definition = bounds.setup.definition!;
  const presentIds = new Set(tasks.map(taskId));
  return bounds.setup.overrides.flatMap(override => {
    if (override.status !== 'active'
      || override.machine !== line
      || override.signature_version !== definition.signature_version
      || override.predecessor_order_id === null) {
      return [];
    }
    const predecessorOrderId = String(override.predecessor_order_id);
    const successorOrderId = String(override.successor_order_id);
    if (!presentIds.has(successorOrderId) || presentIds.has(predecessorOrderId)) return [];
    return [inactiveOverrideEdge(line, predecessorOrderId, successorOrderId)];
  });
}

function missingPredecessorOverrideReasons(
  line: string,
  edges: ReadonlyArray<MissingSetupEdge>,
): CandidateReason[] {
  return edges.map(edge => ({
    code: 'override-inactive',
    message: `Active override predecessor ${edge.predecessorOrderId ?? 'unknown'} is no longer on this line.`,
    line,
    taskId: edge.successorOrderId ?? undefined,
  }));
}

/** A preserved unknown-state anchor is the first physical scheduled order for
 * this run. Any active override that names a different order as its
 * predecessor cannot remain adjacent to that anchor, even when both records
 * still appear in the snapshot; report it instead of silently dropping it
 * when the anchor is removed from mutable fragment work. */
function preservedAnchorOverrideEdges(
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  anchor: Readonly<PreservedInitialAnchor> | undefined,
): MissingSetupEdge[] {
  if (!anchor) return [];
  const definition = bounds.setup.definition!;
  const anchorId = taskId(anchor.task);
  return bounds.setup.overrides.flatMap(override => {
    if (override.status !== 'active'
      || override.machine !== line
      || override.signature_version !== definition.signature_version
      || String(override.successor_order_id) !== anchorId
      || override.predecessor_order_id === null) {
      return [];
    }
    const predecessorOrderId = String(override.predecessor_order_id);
    return predecessorOrderId === anchorId
      ? []
      : [inactiveOverrideEdge(line, predecessorOrderId, anchorId)];
  });
}

function initialFreeOverrideLock(
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  free: ReadonlyArray<NimbusTask>,
  initialState: SetupStateKey | null,
  initialPredecessorOrderId: string | null,
): InitialFreeOverrideLock {
  const definition = bounds.setup.definition!;
  const freeById = new Map(free.map(task => [taskId(task), task]));
  let requiredFirstOrderId: string | undefined;
  let issue: MissingSetupEdge | undefined;

  for (const override of bounds.setup.overrides) {
    if (override.status !== 'active'
      || override.machine !== line
      || override.signature_version !== definition.signature_version
      || override.predecessor_order_id !== initialPredecessorOrderId) {
      continue;
    }
    const successorOrderId = String(override.successor_order_id);
    const successor = freeById.get(successorOrderId);
    // Firmed successors are validated by boundaryOverrideLocks. A missing
    // successor has already been diagnosed without freezing this line.
    if (!successor) continue;
    const successorState = orderState(bounds, successor, definition);
    if (!successorState
      || initialState === null
      || stateKey(initialState) !== stateKey(override.predecessor_state_key)
      || orderStateKey(bounds, successor, definition) !== stateKey(override.successor_state_key)
      || (requiredFirstOrderId && requiredFirstOrderId !== successorOrderId)) {
      issue ??= inactiveOverrideEdge(line, initialPredecessorOrderId, successorOrderId);
      continue;
    }
    requiredFirstOrderId = successorOrderId;
  }
  return { requiredFirstOrderId, issue };
}

/** Extract only fragment-local active overrides. A non-local free/firmed pair
 * is deliberately left to the firmed-boundary lock layer, where its physical
 * boundary can be validated without letting the override follow an order. */
function fragmentAdjacency(
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  tasks: ReadonlyArray<NimbusTask>,
  fragment: Readonly<FragmentContext>,
): FragmentAdjacency {
  const definition = bounds.setup.definition!;
  const byId = new Map(tasks.map(task => [taskId(task), task]));
  const predecessorBySuccessor = new Map<string, string>();
  const successorByPredecessor = new Map<string, string>();
  let requiredInitialSuccessorId: string | undefined;
  let issue: MissingSetupEdge | undefined;

  const markIssue = (predecessorOrderId: string | null | undefined, successorOrderId: string | null | undefined): void => {
    if (!issue) issue = inactiveOverrideEdge(line, predecessorOrderId, successorOrderId);
  };

  for (const override of bounds.setup.overrides) {
    if (override.status !== 'active'
      || override.machine !== line
      || override.signature_version !== definition.signature_version) {
      continue;
    }
    const successorId = String(override.successor_order_id);
    const successor = byId.get(successorId);
    if (!successor) continue;
    const successorState = orderState(bounds, successor, definition);
    if (!successorState || orderStateKey(bounds, successor, definition) !== stateKey(override.successor_state_key)) {
      markIssue(override.predecessor_order_id, successorId);
      continue;
    }

    const predecessorId = override.predecessor_order_id == null ? null : String(override.predecessor_order_id);
    if (predecessorId === null) {
      if (fragment.predecessorOrderId !== null
        || fragment.predecessorState === null
        || stateKey(fragment.predecessorState) !== stateKey(override.predecessor_state_key)
        || (requiredInitialSuccessorId && requiredInitialSuccessorId !== successorId)) {
        markIssue(null, successorId);
      } else {
        requiredInitialSuccessorId = successorId;
      }
      continue;
    }

    const predecessor = byId.get(predecessorId);
    if (!predecessor) {
      // The immediate physical predecessor can be a firmed boundary or a
      // preserved unknown-state anchor, so it is intentionally absent from
      // this fragment's free list. A truly deleted predecessor is diagnosed
      // at line scope and is not allowed to freeze unrelated later work.
      if (predecessorId === fragment.predecessorOrderId
        && fragment.predecessorState !== null
        && stateKey(fragment.predecessorState) === stateKey(override.predecessor_state_key)
        && (!requiredInitialSuccessorId || requiredInitialSuccessorId === successorId)) {
        requiredInitialSuccessorId = successorId;
      }
      continue;
    }
    const predecessorState = orderState(bounds, predecessor, definition);
    if (!predecessorState || orderStateKey(bounds, predecessor, definition) !== stateKey(override.predecessor_state_key)) {
      markIssue(predecessorId, successorId);
      continue;
    }
    const previousSuccessor = successorByPredecessor.get(predecessorId);
    const previousPredecessor = predecessorBySuccessor.get(successorId);
    if ((previousSuccessor && previousSuccessor !== successorId)
      || (previousPredecessor && previousPredecessor !== predecessorId)) {
      markIssue(predecessorId, successorId);
      continue;
    }
    successorByPredecessor.set(predecessorId, successorId);
    predecessorBySuccessor.set(successorId, predecessorId);
  }

  const requiredFirstOrderId = fragment.requiredFirstOrderId ?? requiredInitialSuccessorId;
  if (fragment.requiredFirstOrderId && requiredInitialSuccessorId
    && fragment.requiredFirstOrderId !== requiredInitialSuccessorId) {
    markIssue(null, requiredInitialSuccessorId);
  }
  if (requiredFirstOrderId && predecessorBySuccessor.has(requiredFirstOrderId)) {
    markIssue(predecessorBySuccessor.get(requiredFirstOrderId), requiredFirstOrderId);
  }
  if (fragment.requiredLastOrderId && successorByPredecessor.has(fragment.requiredLastOrderId)) {
    markIssue(fragment.requiredLastOrderId, successorByPredecessor.get(fragment.requiredLastOrderId));
  }

  for (const origin of successorByPredecessor.keys()) {
    const seen = new Set<string>();
    let cursor = origin;
    while (successorByPredecessor.has(cursor)) {
      if (seen.has(cursor)) {
        markIssue(cursor, successorByPredecessor.get(cursor));
        break;
      }
      seen.add(cursor);
      cursor = successorByPredecessor.get(cursor)!;
    }
  }

  return { predecessorBySuccessor, successorByPredecessor, requiredInitialSuccessorId, issue };
}

/** Free/free active override chains are indivisible while assigning work to
 * obstacle-free fragments. Without this, due-based partitioning can put one
 * end before a firmed run and the other after it, even though both endpoints
 * are individually valid. Fragment-local validation still owns the exact
 * order/state binding; this helper only prevents the physical pair splitting. */
function freeOverrideComponents(
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  free: ReadonlyArray<NimbusTask>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const definition = bounds.setup.definition!;
  const freeIds = new Set(free.map(taskId));
  const links = new Map<string, Set<string>>();
  const link = (left: string, right: string): void => {
    const leftLinks = links.get(left) ?? new Set<string>();
    leftLinks.add(right);
    links.set(left, leftLinks);
    const rightLinks = links.get(right) ?? new Set<string>();
    rightLinks.add(left);
    links.set(right, rightLinks);
  };
  for (const override of bounds.setup.overrides) {
    const predecessorId = override.predecessor_order_id == null ? null : String(override.predecessor_order_id);
    const successorId = String(override.successor_order_id);
    if (override.status === 'active'
      && override.machine === line
      && override.signature_version === definition.signature_version
      && predecessorId
      && freeIds.has(predecessorId)
      && freeIds.has(successorId)) {
      link(predecessorId, successorId);
    }
  }

  const components = new Map<string, ReadonlySet<string>>();
  const visited = new Set<string>();
  for (const origin of links.keys()) {
    if (visited.has(origin)) continue;
    const component = new Set<string>();
    const pending = [origin];
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      component.add(id);
      for (const neighbor of links.get(id) ?? []) {
        if (!visited.has(neighbor)) pending.push(neighbor);
      }
    }
    for (const id of component) components.set(id, component);
  }
  return components;
}

function requiredFirstOrderId(fragment: Readonly<FragmentContext>, adjacency: Readonly<FragmentAdjacency>): string | undefined {
  return fragment.requiredFirstOrderId ?? adjacency.requiredInitialSuccessorId;
}

function sequenceAdjacencyFailure(
  line: string,
  sequence: ReadonlyArray<NimbusTask>,
  fragment: Readonly<FragmentContext>,
  adjacency: Readonly<FragmentAdjacency>,
): MissingSetupEdge | null {
  if (adjacency.issue) return adjacency.issue;
  const requiredFirst = requiredFirstOrderId(fragment, adjacency);
  const firstId = sequence.length ? taskId(sequence[0]) : null;
  const lastId = sequence.length ? taskId(sequence.at(-1)!) : null;
  if (requiredFirst && firstId !== requiredFirst) {
    return inactiveOverrideEdge(line, fragment.predecessorOrderId, requiredFirst);
  }
  if (fragment.requiredLastOrderId && lastId !== fragment.requiredLastOrderId) {
    return inactiveOverrideEdge(
      line,
      fragment.requiredLastOrderId,
      fragment.nextFirmed ? taskId(fragment.nextFirmed.task) : undefined,
    );
  }
  for (let index = 0; index < sequence.length; index += 1) {
    const id = taskId(sequence[index]);
    const requiredSuccessor = adjacency.successorByPredecessor.get(id);
    const next = sequence[index + 1];
    if (requiredSuccessor && (!next || taskId(next) !== requiredSuccessor)) {
      return inactiveOverrideEdge(line, id, requiredSuccessor);
    }
    const requiredPredecessor = adjacency.predecessorBySuccessor.get(id);
    const previous = sequence[index - 1];
    if (requiredPredecessor && (!previous || taskId(previous) !== requiredPredecessor)) {
      return inactiveOverrideEdge(line, requiredPredecessor, id);
    }
  }
  return null;
}

function sequenceSatisfiesAdjacency(
  sequence: ReadonlyArray<NimbusTask>,
  fragment: Readonly<FragmentContext>,
  adjacency: Readonly<FragmentAdjacency>,
): boolean {
  if (adjacency.issue) return false;
  const requiredFirst = requiredFirstOrderId(fragment, adjacency);
  const first = sequence[0];
  const last = sequence.at(-1);
  if (requiredFirst && (!first || taskId(first) !== requiredFirst)) return false;
  if (fragment.requiredLastOrderId && (!last || taskId(last) !== fragment.requiredLastOrderId)) return false;
  for (let index = 0; index < sequence.length; index += 1) {
    const id = taskId(sequence[index]);
    const requiredSuccessor = adjacency.successorByPredecessor.get(id);
    const next = sequence[index + 1];
    if (requiredSuccessor && (!next || taskId(next) !== requiredSuccessor)) return false;
    const requiredPredecessor = adjacency.predecessorBySuccessor.get(id);
    const previous = sequence[index - 1];
    if (requiredPredecessor && (!previous || taskId(previous) !== requiredPredecessor)) return false;
  }
  return true;
}

function deferredAdjacencyFailure(
  line: string,
  unadmitted: ReadonlyArray<NimbusTask>,
  adjacency: Readonly<FragmentAdjacency>,
): MissingSetupEdge | null {
  const deferredIds = new Set(unadmitted.map(taskId));
  for (const [predecessorOrderId, successorOrderId] of adjacency.successorByPredecessor) {
    if (deferredIds.has(predecessorOrderId) !== deferredIds.has(successorOrderId)) {
      return inactiveOverrideEdge(line, predecessorOrderId, successorOrderId);
    }
  }
  return null;
}

/** Produce one deterministic policy/due (or SPT) sequence while enforcing
 * active exact pairs. Unrelated tasks retain their base-order relationship;
 * only an override can pull its predecessor ahead of a blocked successor. */
function orderWithAdjacency(
  baseOrder: ReadonlyArray<NimbusTask>,
  fragment: Readonly<FragmentContext>,
  adjacency: Readonly<FragmentAdjacency>,
): NimbusTask[] | null {
  if (adjacency.issue) return null;
  const byId = new Map(baseOrder.map(task => [taskId(task), task]));
  const selectedIds = new Set<string>();
  const result: NimbusTask[] = [];
  const requiredFirst = requiredFirstOrderId(fragment, adjacency);
  let baseIndex = 0;

  while (result.length < baseOrder.length) {
    const previous = result.at(-1);
    const expectedId = previous ? adjacency.successorByPredecessor.get(taskId(previous)) : undefined;
    let selected: NimbusTask | undefined;
    if (expectedId) {
      selected = byId.get(expectedId);
      if (!selected || selectedIds.has(expectedId)) return null;
    } else if (result.length === 0 && requiredFirst) {
      selected = byId.get(requiredFirst);
      if (!selected || adjacency.predecessorBySuccessor.has(requiredFirst)) return null;
    } else {
      while (baseIndex < baseOrder.length) {
        const candidate = baseOrder[baseIndex++];
        const candidateId = taskId(candidate);
        if (selectedIds.has(candidateId)
          || adjacency.predecessorBySuccessor.has(candidateId)
          || (fragment.requiredLastOrderId === candidateId && result.length !== baseOrder.length - 1)) {
          continue;
        }
        selected = candidate;
        break;
      }
      if (!selected && fragment.requiredLastOrderId && result.length === baseOrder.length - 1) {
        const last = byId.get(fragment.requiredLastOrderId);
        if (last && !selectedIds.has(taskId(last)) && !adjacency.predecessorBySuccessor.has(taskId(last))) {
          selected = last;
        }
      }
      if (!selected) return null;
    }
    const selectedId = taskId(selected);
    if (selectedIds.has(selectedId)
      || (fragment.requiredLastOrderId === selectedId && result.length !== baseOrder.length - 1)) {
      return null;
    }
    selectedIds.add(selectedId);
    result.push(selected);
  }
  return sequenceSatisfiesAdjacency(result, fragment, adjacency) ? result : null;
}

function productiveRuntimeMinutes(task: NimbusTask): number {
  const minutes = Math.round(Number(task.RUN_TIME) * 60);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : Number.MAX_SAFE_INTEGER;
}

function orderedByProductiveRuntime(tasks: ReadonlyArray<NimbusTask>): NimbusTask[] {
  return [...tasks].sort((left, right) => (
    productiveRuntimeMinutes(left) - productiveRuntimeMinutes(right) || taskId(left).localeCompare(taskId(right))
  ));
}

function taskIsFirmed(snapshot: Readonly<ScheduleSnapshot>, task: NimbusTask): boolean {
  const firmedIds = snapshot.firmedIds instanceof Set
    ? snapshot.firmedIds
    : new Set(Array.from(snapshot.firmedIds, String));
  return task.firmed === true || firmedIds.has(taskId(task));
}

// B7: resolve an order's plant the same way the legacy engine does
// (`t.PLANT || Store.getPlantForLine(t.MACHINE)`, schedule-state.mts)
// instead of an exact `task.PLANT` match. Without this, a null-PLANT order on
// a line that maps to this plant is optimized by the legacy engine and
// counted in the preview's KPIs, but is completely invisible to the
// setup-aware evaluators — no patch, no explanation, no toast. Mirrors
// `Store.getPlantForLine`'s own precedence: line settings first, then the
// master-data line→plant mapping.
/** Phase 1a memo: built once, in full, on first use — a single linear scan
 * over `masterData.lines` replaces a `.find()` repeated for every task on
 * every line in the grouping loops below. */
function plantByLineMap(ctx: SetupRunContext, snapshot: Readonly<ScheduleSnapshot>): ReadonlyMap<string, string | null> {
  if (ctx._plantByLine) return ctx._plantByLine;
  const map = new Map<string, string | null>();
  for (const row of snapshot.masterData?.lines ?? []) {
    if (!map.has(row.machine)) map.set(row.machine, row.plant ?? null);
  }
  ctx._plantByLine = map;
  return map;
}

function resolveTaskPlant(
  task: Readonly<NimbusTask>, snapshot: Readonly<ScheduleSnapshot>, ctx?: SetupRunContext,
): string | null {
  const direct = task.PLANT || task.plant;
  if (direct) return String(direct);
  const line = String(task.MACHINE ?? '');
  if (!line) return null;
  const fromSettings = snapshot.lineSettings?.[line]?.plant;
  if (fromSettings) return fromSettings;
  if (ctx) return plantByLineMap(ctx, snapshot).get(line) ?? null;
  const mdLine = (snapshot.masterData?.lines ?? []).find(row => row.machine === line);
  return mdLine?.plant ?? null;
}

function localWindow(hours: WorkHours, date: Date): PlacementInterval | null {
  const range = hours[date.getDay()];
  if (!range || range.length !== 2 || !Number.isFinite(range[0]) || !Number.isFinite(range[1])) return null;
  const atHour = (hour: number): Date => {
    const result = new Date(date);
    const wholeHours = Math.trunc(hour);
    const minutes = Math.round((hour - wholeHours) * 60);
    result.setHours(wholeHours, minutes, 0, 0);
    return result;
  };
  const start = atHour(range[0]);
  const end = atHour(range[1]);
  return end > start ? { start, end } : null;
}

/** Phase 1d: the plant+line-eligible blackout block set is constant for the
 * whole run (blocks/plantBlocks never change mid-evaluation), so this merges
 * it once per line — globally, unbound by any particular query window — and
 * caches it on `ctx`. `indexedOverlapBlocks` then binary-searches this
 * per-line array per query instead of re-filtering/re-sorting/re-merging
 * every call. Clipping an already-merged, already-disjoint interval set to a
 * query window can only shrink each interval, never introduce a new merge,
 * so this produces byte-identical output to the unindexed path below. */
function lineBlocksFor(
  ctx: SetupRunContext, snapshot: Readonly<ScheduleSnapshot>, line: string, plant: string,
): ReadonlyArray<{ start: number; end: number }> {
  // Machine codes are documented as reusable across plants — fold `plant`
  // into the key (not just `line`) so a ctx that ever saw two plants for the
  // same line code can't return one plant's cached blocks for the other.
  // Today every call site passes the single plant `ctx` was built for, so
  // this is defense-in-depth, not a live bug fix.
  const cacheKey = plant + CTX_KEY_SEP + line;
  const cached = ctx._lineBlocks.get(cacheKey);
  if (cached) return cached;
  const candidates = [
    ...snapshot.blocks.filter(block => (
      (!block.plant || block.plant === plant) && (!block.line || block.line === line)
    )),
    ...snapshot.plantBlocks.filter(block => !block.plant || block.plant === plant),
  ];
  const intervals = candidates.flatMap(block => {
    const blockStart = timestamp(block.start);
    const blockEnd = timestamp(block.end);
    if (!blockStart || !blockEnd) return [];
    return [{ start: blockStart.getTime(), end: blockEnd.getTime() }];
  }).sort((left, right) => left.start - right.start);

  const merged: { start: number; end: number }[] = [];
  for (const interval of intervals) {
    const prior = merged.at(-1);
    if (prior && interval.start <= prior.end) {
      if (interval.end > prior.end) prior.end = interval.end;
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  ctx._lineBlocks.set(cacheKey, merged);
  return merged;
}

/** Binary-searches a sorted, disjoint, per-line merged block array for the
 * first block overlapping `[startMs, endMs)`, then walks forward — replacing
 * `overlapBlocks`'s per-call filter+flatMap+sort+merge with an O(log n + k)
 * lookup into a run-constant structure. */
function indexedOverlapBlocks(
  merged: ReadonlyArray<{ start: number; end: number }>, startMs: number, endMs: number,
): PlacementInterval[] {
  if (!merged.length || endMs <= startMs) return [];
  let lo = 0;
  let hi = merged.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (merged[mid].end > startMs) hi = mid; else lo = mid + 1;
  }
  const result: PlacementInterval[] = [];
  for (let index = lo; index < merged.length && merged[index].start < endMs; index += 1) {
    result.push({
      start: new Date(Math.max(startMs, merged[index].start)),
      end: new Date(Math.min(endMs, merged[index].end)),
    });
  }
  return result;
}

function overlapBlocks(
  snapshot: Readonly<ScheduleSnapshot>, line: string, plant: string, start: Date, end: Date,
  ctx?: SetupRunContext,
): PlacementInterval[] {
  if (ctx) return indexedOverlapBlocks(lineBlocksFor(ctx, snapshot, line, plant), start.getTime(), end.getTime());
  const candidates = [
    ...snapshot.blocks.filter(block => (
      (!block.plant || block.plant === plant) && (!block.line || block.line === line)
    )),
    ...snapshot.plantBlocks.filter(block => !block.plant || block.plant === plant),
  ];
  const intervals = candidates.flatMap(block => {
    const blockStart = timestamp(block.start);
    const blockEnd = timestamp(block.end);
    if (!blockStart || !blockEnd || blockEnd <= start || blockStart >= end) return [];
    return [{
      start: new Date(Math.max(start.getTime(), blockStart.getTime())),
      end: new Date(Math.min(end.getTime(), blockEnd.getTime())),
    }];
  }).sort((left, right) => left.start.getTime() - right.start.getTime());

  const merged: PlacementInterval[] = [];
  for (const interval of intervals) {
    const prior = merged.at(-1);
    if (prior && interval.start <= prior.end) {
      if (interval.end > prior.end) prior.end = new Date(interval.end);
    } else {
      merged.push({ start: new Date(interval.start), end: new Date(interval.end) });
    }
  }
  return merged;
}

/** Intersects two already-resolved line/plant work windows, mirroring the
 * inline `Math.max`/`Math.min` combination `freeIntervalsFor`/
 * `hasNominalWindow` each used to repeat. Null in, null out. */
function intersectWindows(
  lineWindow: PlacementInterval | null, plantWindow: PlacementInterval | null,
): PlacementInterval | null {
  if (!lineWindow || !plantWindow) return null;
  return {
    start: new Date(Math.max(lineWindow.start.getTime(), plantWindow.start.getTime())),
    end: new Date(Math.min(lineWindow.end.getTime(), plantWindow.end.getTime())),
  };
}

/** Phase 1d: the raw (line ∩ plant) work window for one calendar day is a
 * run-constant fact — independent of any particular call's `[from, through]`
 * clip — so it is memoized per-(line, dayStartMs) rather than recomputed via
 * `localWindow` twice per day on every `freeIntervalsFor`/`hasNominalWindow`
 * call. Null means a closed day (either side has no window that day). */
function jointWindowForDay(
  ctx: SetupRunContext, snapshot: Readonly<ScheduleSnapshot>, line: string, plant: string, day: Date,
): PlacementInterval | null {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  // Machine codes are documented as reusable across plants — fold `plant`
  // into the key (via CTX_KEY_SEP, not the printable `|` used for line/day)
  // so a ctx that ever saw two plants for the same line code can't return
  // one plant's cached hours for the other. Today every call site passes
  // the single plant `ctx` was built for, so this is defense-in-depth.
  const key = `${plant}${CTX_KEY_SEP}${line}|${dayStart.getTime()}`;
  if (ctx._dayWindow.has(key)) return ctx._dayWindow.get(key)!;
  const lineHours = snapshot.calendars[line]?.workHours ?? candidateDefaultWorkHours();
  const plantHours = snapshot.plants[plant]?.workHours ?? candidateDefaultWorkHours();
  const result = intersectWindows(localWindow(lineHours, dayStart), localWindow(plantHours, dayStart));
  ctx._dayWindow.set(key, result);
  return result;
}

/** Derive only the availability present in the supplied immutable snapshot.
 * A missing calendar is unavailable rather than a prompt to synthesize a
 * default calendar into a detached candidate. */
function freeIntervalsFor(
  snapshot: Readonly<ScheduleSnapshot>, line: string, plant: string, from: Date, through: Date,
  ctx?: SetupRunContext,
): PlacementInterval[] {
  // B6: fall back to the same default work hours the alerts path and the
  // detached-candidate path already use (schedule-services.mts's
  // setupDefaultWorkHours/candidateDefaultWorkHours) instead of returning []
  // when a line or plant calendar is missing. Without this, one plant with
  // no `Store.plants` entry silently placed nothing for every line in it,
  // while alerts kept computing as though hours existed.
  const lineHours = snapshot.calendars[line]?.workHours ?? candidateDefaultWorkHours();
  const plantHours = snapshot.plants[plant]?.workHours ?? candidateDefaultWorkHours();
  if (through <= from) return [];
  if (ctx?.respectCalendar === false) {
    return [{ start: new Date(from), end: new Date(through) }];
  }

  const result: PlacementInterval[] = [];
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  while (day <= through) {
    const joint = ctx
      ? jointWindowForDay(ctx, snapshot, line, plant, day)
      : intersectWindows(localWindow(lineHours, day), localWindow(plantHours, day));
    if (joint) {
      const start = new Date(Math.max(joint.start.getTime(), from.getTime()));
      const end = new Date(Math.min(joint.end.getTime(), through.getTime()));
      if (end > start) {
        let cursor = start;
        for (const block of overlapBlocks(snapshot, line, plant, start, end, ctx)) {
          if (block.start > cursor) result.push({ start: new Date(cursor), end: new Date(block.start) });
          if (block.end > cursor) cursor = new Date(block.end);
        }
        if (cursor < end) result.push({ start: new Date(cursor), end: new Date(end) });
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return result;
}

/** Match the legacy Engine contract without reading its live master-data
 * resolver: only the two persisted split choices opt into split placement;
 * absent or malformed snapshot data retains continuous scheduling. */
function splitOrderPolicyForSnapshot(snapshot: Readonly<ScheduleSnapshot>, plant: string): SplitOrderPolicy {
  const value = snapshot.masterData?.plants.find(candidate => candidate.plant === plant)?.split_order_policy;
  return value === 'overlong_only' || value === 'partial_allowed' ? value : 'never';
}

/** B3 (2026-08-21): mirrors splitOrderPolicyForSnapshot above — resolves the
 * plant's configured productive-segment floor from the snapshot's
 * masterData rather than Engine.minProductiveSegmentMinutesFor's live Store
 * read, so this detached evaluator stays Store-free even though it shares
 * the same fallback default (MIN_PRODUCTIVE_SEGMENT_MINUTES) Engine's
 * version falls back to. */
function minProductiveSegmentMinutesForSnapshot(snapshot: Readonly<ScheduleSnapshot>, plant: string): number {
  const value = snapshot.masterData?.plants.find(candidate => candidate.plant === plant)?.min_productive_segment_minutes;
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : MIN_PRODUCTIVE_SEGMENT_MINUTES;
}

/** The Task 2 overlong decision is based on nominal line/plant operating
 * windows, not dated blackouts. Keep that same 90-day bounded definition in
 * the detached snapshot evaluator so policy routing remains Store-free. */
function hasNominalWindow(
  snapshot: Readonly<ScheduleSnapshot>, line: string, plant: string, from: Date, runtimeMinutes: number,
  ctx?: SetupRunContext,
): boolean {
  const lineHours = snapshot.calendars[line]?.workHours;
  const plantHours = snapshot.plants[plant]?.workHours;
  if (!lineHours || !plantHours || !Number.isFinite(runtimeMinutes) || runtimeMinutes <= 0) return false;
  const requiredMs = Math.round(runtimeMinutes) * 60 * 1000;
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  for (let offset = 0; offset < 90; offset += 1) {
    const date = new Date(day);
    date.setDate(day.getDate() + offset);
    // `lineHours`/`plantHours` are already confirmed present above, so the
    // memo's own defaulting (for a missing calendar) never triggers here —
    // safe to share with `freeIntervalsFor`'s per-(line,day) window cache.
    const joint = ctx
      ? jointWindowForDay(ctx, snapshot, line, plant, date)
      : intersectWindows(localWindow(lineHours, date), localWindow(plantHours, date));
    if (!joint) continue;
    if (joint.end.getTime() - joint.start.getTime() >= requiredMs) return true;
  }
  return false;
}

/** `'due-date'` mode (2026-09-09): lateness outranks BOTH the priority-list
 * order (`policyKey`) and setup/coverage grouping — the inverse of every
 * other mode's tier order below. Order: hard feasibility (score[0]) ->
 * over-cap count (SCORE_OVER_CAP) -> late count (score[2]) -> lateness
 * minutes (score[3]) -> policyKey -> coverage count (SCORE_UNCOVERED) ->
 * -patches (score[4]) -> setup minutes (score[5]) -> sequenceKey. Over-cap is
 * still compared ahead of lateness here (both are "how late/how far past a
 * hard ceiling" facts, and over-cap is the more severe of the two), but both
 * now sit ahead of `policyKey`, unlike every other mode where `policyKey`
 * comes first. */
function compareDueDateCandidate(left: DueDateCandidate, right: DueDateCandidate): number {
  const hardConstraintDelta = (left.score[0] ?? 0) - (right.score[0] ?? 0);
  if (hardConstraintDelta) return hardConstraintDelta;
  const overCapDelta = (left.score[SCORE_OVER_CAP] ?? 0) - (right.score[SCORE_OVER_CAP] ?? 0);
  if (overCapDelta) return overCapDelta;
  const lateCountDelta = (left.score[2] ?? 0) - (right.score[2] ?? 0);
  if (lateCountDelta) return lateCountDelta;
  const latenessDelta = (left.score[3] ?? 0) - (right.score[3] ?? 0);
  if (latenessDelta) return latenessDelta;
  const policyDelta = ordinalCompare(left.policyKey, right.policyKey);
  if (policyDelta) return policyDelta;
  const coverageDelta = (left.score[SCORE_UNCOVERED] ?? 0) - (right.score[SCORE_UNCOVERED] ?? 0);
  if (coverageDelta) return coverageDelta;
  const patchesDelta = (left.score[4] ?? 0) - (right.score[4] ?? 0);
  if (patchesDelta) return patchesDelta;
  const setupDelta = (left.score[5] ?? 0) - (right.score[5] ?? 0);
  if (setupDelta) return setupDelta;
  return ordinalCompare(left.sequenceKey, right.sequenceKey);
}

function compareCandidate(left: DueDateCandidate, right: DueDateCandidate,
                          mode: FragmentMode = 'due-date-first'): number {
  // `'due-date'` (2026-09-09) inverts the usual tier order (lateness ahead of
  // both policyKey and coverage) — routed to its own comparator up front
  // rather than folded into the terms below, since it isn't just a
  // reordering of the mode-permuted `terms` list further down.
  if (left.feasible !== right.feasible) return left.feasible ? -1 : 1;
  const admissionDelta = ordinalCompare(left.admissionKey ?? '', right.admissionKey ?? '');
  if (admissionDelta) return admissionDelta;
  if (mode === 'due-date') return compareDueDateCandidate(left, right);
  if (mode === 'min-changeover') {
    return compareObjectiveFacts(fragmentObjectiveFacts(left), fragmentObjectiveFacts(right), mode);
  }
  const hardConstraintDelta = (left.score[0] ?? 0) - (right.score[0] ?? 0);
  if (hardConstraintDelta) return hardConstraintDelta;
  // Ordinal, not localeCompare: policyKey is zero-padded ASCII digits joined
  // by `|`/` ` (see `ordinalCompare`), and this comparison runs on every
  // candidate pair a search evaluates. Mode-independent except for
  // `'due-date'` (handled above, before this point), where lateness outranks
  // policyKey instead.
  const policyDelta = ordinalCompare(left.policyKey, right.policyKey);
  if (policyDelta) return policyDelta;
  // Due-date push-forward limit (2026-09-09): compared immediately after
  // policyKey and BEFORE the coverage tier — deliberate. On a plant with no
  // real matrix, the coverage tier is effectively same-signature grouping
  // (identical states resolve implicit-zero/covered), so the cap must outrank
  // it or "pushed 30 days out to save a changeover" persists. Hard
  // feasibility (score[0]) and the priority tree (policyKey) still come
  // first. `compareBoundaryFallback` calls this without `mode`; that's fine —
  // this tier sits before the mode-permuted terms below.
  const overCapDelta = (left.score[SCORE_OVER_CAP] ?? 0) - (right.score[SCORE_OVER_CAP] ?? 0);
  if (overCapDelta) return overCapDelta;
  // Coverage tier (A2): compared outside the mode-permuted `terms` list below
  // so it is immune to future reordering there, and so a mode like
  // `throughput` (which puts score[5] first) can never prefer a cheaper
  // zero-minute uncovered admission over fewer uncovered edges. Minimizing
  // the count of uncovered edges = minimizing state changes = maximal
  // same-signature grouping; a fully-covered sequence always wins when one
  // exists, since it has zero uncovered edges. Mode-independent except for
  // `'due-date'` (handled above, before this point), where coverage is
  // compared only after lateness AND policyKey.
  const coverageDelta = (left.score[SCORE_UNCOVERED] ?? 0) - (right.score[SCORE_UNCOVERED] ?? 0);
  if (coverageDelta) return coverageDelta;
  // All policies retain hard feasibility and configured policy tiers. Only the
  // lower-order comparison changes: Min Changeover remains due-safe, while
  // Throughput may prefer setup savings and is constrained by its explicit
  // post-evaluation slip gate below.
  const terms = mode === 'throughput' ? [5, 2, 3, 4] : [2, 3, 4, 5];
  for (const index of terms) {
    const delta = (left.score[index] ?? 0) - (right.score[index] ?? 0);
    if (delta) return delta;
  }
  return ordinalCompare(left.sequenceKey, right.sequenceKey);
}

function candidateForSequence(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  sequence: ReadonlyArray<NimbusTask>,
  fragment: Readonly<FragmentContext>,
  adjacency: Readonly<FragmentAdjacency>,
  // Phase 1e: `exactSearch`/`greedySearch` evaluate many losing candidates
  // per winner found; building this success-path explanation text (template
  // strings, fresh Dates) for every one of them is pure waste, since only the
  // eventual winner's explanation is ever read. Search-time callers pass
  // `true` to skip building the 'due-date-first-placement' /
  // 'admitted-without-setup' / 'firmed-incoming-setup' entries below, then
  // re-run this function once against the chosen winner with the default
  // `false` to get its real explanation. Failure-path entries and
  // `missingEdges` are never suppressed — diagnostics must stay intact
  // regardless of which candidate loses.
  suppressExplanations = false,
): DueDateCandidate {
  const definition = bounds.setup.definition!;
  let predecessorState = fragment.predecessorState;
  let predecessorOrderId = fragment.predecessorOrderId;
  let cursor = new Date(fragment.start);
  const patches: SchedulePatch[] = [];
  const explanation: CandidateReason[] = [];
  const missingEdges: MissingSetupEdge[] = [];
  let setupMinutes = 0;
  let lateCount = 0;
  let latenessMinutes = 0;
  // Due-date push-forward limit: count of orders in this sequence whose
  // simulated end exceeds `bounds.notAfter(task)`. Rolled into
  // score[SCORE_OVER_CAP] on the feasible return below; compareCandidate
  // minimizes it ahead of every other tier except hard feasibility/policyKey.
  let overCapCount = 0;
  const unadmitted: NimbusTask[] = [];
  // A1/A2: count of uncovered-but-admitted transitions in this sequence
  // (mid-sequence + firmed-boundary-incoming). Rolled into score[SCORE_UNCOVERED]
  // on the feasible return below so `compareCandidate` can minimize it —
  // minimizing uncovered edges is what drives same-signature grouping.
  let uncoveredEdgeCount = 0;
  const checkpoints: Array<{ task: NimbusTask; predecessorState: SetupStateKey | null; predecessorOrderId: string | null; cursor: Date; setupMinutes: number; lateCount: number; latenessMinutes: number; overCapCount: number; uncoveredEdgeCount: number }> = [];

  const constraintFailure = (edge: MissingSetupEdge): DueDateCandidate => ({
    feasible: false,
    patches: [],
    score: infeasibleScore(),
    policyKey: '',
    sequenceKey: '',
    unadmitted: [],
    explanation,
    missingEdges: [...missingEdges, edge],
  });

  const adjacencyFailure = sequenceAdjacencyFailure(line, sequence, fragment, adjacency);
  if (adjacencyFailure) return constraintFailure(adjacencyFailure);

  for (let taskIndex = 0; taskIndex < sequence.length; taskIndex += 1) {
    const task = sequence[taskIndex];
    const priorCursor = new Date(cursor);
    const checkpoint = { task, predecessorState, predecessorOrderId, cursor: priorCursor, setupMinutes, lateCount, latenessMinutes, overCapCount, uncoveredEdgeCount };
    if (planningDefect(snapshot, bounds, task)) { unadmitted.push(task); continue; }
    const pullForwardFloor = notBeforeFor(bounds, task);
    if (pullForwardFloor && cursor < pullForwardFloor) cursor = new Date(pullForwardFloor);
    const successorState = orderState(bounds, task, definition);
    const inactiveOverride = inactiveOverrideForTransition(
      bounds,
      line,
      predecessorState,
      successorState,
      predecessorOrderId,
      taskId(task),
      fragment.lineOrderIds,
      fragment.allowsDeletedPredecessorBinding,
    );
    if (inactiveOverride) {
      missingEdges.push(inactiveOverride);
      return {
        feasible: false, patches: [], score: infeasibleScore(), policyKey: '', sequenceKey: '', unadmitted: [], explanation, missingEdges,
      };
    }

    // An unknown line-initial predecessor state (Part 1d) is a missing-data
    // fact, not a reason to reject the whole permutation: place this order
    // via the same zero-minute mechanism as an unknown-tail order, charge
    // nothing into setupMinutes, and keep chaining from its own known state.
    const unknownPredecessor = predecessorState === null || successorState === null;
    // A1: a known signature whose transition simply has no matrix row is the
    // same shape of missing-data fact as an unknown predecessor (above) — it
    // stays in the covered-core sequence, charged zero setup minutes, rather
    // than being demoted to the tail. The coverage tier (A2) is what keeps a
    // fully-covered sequence winning when one exists.
    let uncoveredAdmission = false;
    let effectiveSetupMinutes = 0;
    let setupRequirement: SetupRequirement;
    if (unknownPredecessor) {
      missingEdges.push(unknownInitialStateEdge(line, task));
      explanation.push(unknownInitialStateReason(line, task));
      setupRequirement = { kind: 'resolved', minutes: 0 };
    } else {
      const resolved = resolveSetup({
        definition,
        machine: line,
        predecessorState,
        successorState: successorState!,
        predecessorOrderId,
        successorOrderId: taskId(task),
        plantRows: bounds.setup.plant_rows,
        machineRows: bounds.setup.machine_rows,
        overrides: bounds.setup.overrides,
        index: bounds.runContext?.resolutionIndex ?? undefined,
      });
      if (!resolved.covered || resolved.effectiveMin === null) {
        uncoveredAdmission = true;
        uncoveredEdgeCount += 1;
        // Reuse 'scheduled-without-setup' (F1) — the single existing authority
        // for the live toast (schedule-services.mts) and the preview tally
        // (schedule-workbench.mts), both of which already intersect against
        // patched ids. Emitting UNCOVERED_SETUP_TRANSITION_REASON here would be
        // wrong: appendRejectedCoverageDiagnostics would then stamp this
        // *admitted* order "Rejected X -> Y" and tally it into prunes.setup.
        missingEdges.push({
          line,
          predecessorOrderId,
          successorOrderId: taskId(task),
          reason: 'scheduled-without-setup',
        });
        // Explanation code deliberately avoids unavailable|unknown|uncovered|
        // infeasible|missing|disabled|fail — summarizeCandidate
        // (schedule-workbench.mts) regex-matches those tokens to stamp
        // outcome:'rejected', and this order was accepted, not rejected. Not
        // added to PRUNE_BUCKET_BY_CODE for the same reason.
        if (!suppressExplanations) {
          explanation.push({
            code: 'admitted-without-setup',
            message: `Admitted ${taskId(task)} into the covered sequence without a matching setup transition; charged zero setup minutes.`,
            line,
            taskId: taskId(task),
          });
        }
        setupRequirement = { kind: 'resolved', minutes: 0 };
      } else {
        effectiveSetupMinutes = resolved.effectiveMin;
        setupRequirement = { kind: 'resolved', minutes: resolved.effectiveMin };
      }
    }

    const runtimeMinutes = Math.round(Number(task.RUN_TIME) * 60);
    const splitPolicy = bounds.runContext?.splitOrderPolicy ?? splitOrderPolicyForSnapshot(snapshot, bounds.setup.plant);
    const placement = placeWithSetup({
      earliestStart: cursor,
      runtimeMinutes,
      setup: setupRequirement,
      policy: splitPolicy,
      ...(splitPolicy === 'overlong_only' ? {
        isInherentlyOverlong: !hasNominalWindow(
          snapshot,
          line,
          bounds.setup.plant,
          cursor,
          runtimeMinutes,
          bounds.runContext,
        ),
      } : {}),
      freeIntervals: freeIntervalsFor(snapshot, line, bounds.setup.plant, cursor, completionEnd(bounds, task, fragment.end), bounds.runContext),
      minProductiveSegmentMinutes: bounds.runContext?.minProductiveSegmentMinutes
        ?? minProductiveSegmentMinutesForSnapshot(snapshot, bounds.setup.plant),
    });
    if (placement.kind !== 'placed' || !placement.productiveSegments.length) {
      unadmitted.push(task);
      cursor = priorCursor;
      explanation.push({ code: 'due-work-unadmitted', message: `No legal placement found for ${taskId(task)}.`, line, taskId: taskId(task) });
      continue;
    }

    const productiveSegments = placement.productiveSegments;
    const first = productiveSegments[0];
    const last = productiveSegments.at(-1)!;
    patches.push({
      id: taskId(task),
      changes: {
        start_date: new Date(first.start),
        end_date: new Date(last.end),
        scheduleSegments: productiveSegments.length > 1
          ? productiveSegments.map((segment, index) => ({
            sequence: index + 1, startDate: new Date(segment.start), endDate: new Date(segment.end),
          }))
          : [],
      },
    });
    setupMinutes += effectiveSetupMinutes;
    const due = dueTimestamp(task);
    if (Number.isFinite(due) && last.end.getTime() > due) {
      lateCount += 1;
      latenessMinutes += Math.ceil((last.end.getTime() - due) / (60 * 1000));
    }
    const ceiling = notAfterFor(bounds, task);
    if (ceiling && last.end.getTime() > ceiling.getTime()) overCapCount += 1;
    if (!unknownPredecessor && !uncoveredAdmission && !suppressExplanations) {
      explanation.push({
        code: 'due-date-first-placement',
        message: `Placed ${taskId(task)} after ${effectiveSetupMinutes} minutes of setup.`,
        line,
        taskId: taskId(task),
      });
    }
    checkpoints.push(checkpoint);
    cursor = new Date(last.end);
    predecessorState = successorState;
    predecessorOrderId = taskId(task);
  }

  // Only the final admitted predecessor owes the setup into fixed work.
  // A later bridge may reduce this transition, so do not reject intermediate
  // occurrences. Backtrack a conflicting suffix into the existing next-fragment retry.
  while (fragment.nextFirmed?.state && predecessorState && checkpoints.length) {
    const boundary = fragment.nextFirmed;
    const outgoing = resolveSetup({ definition, machine: line, predecessorState, successorState: boundary.state!, predecessorOrderId, successorOrderId: taskId(boundary.task), plantRows: bounds.setup.plant_rows, machineRows: bounds.setup.machine_rows, overrides: bounds.setup.overrides, index: bounds.runContext?.resolutionIndex ?? undefined });
    if (!outgoing.covered || !outgoing.effectiveMin) break;
    const setupStart = new Date(+boundary.start - outgoing.effectiveMin * 60000);
    if (cursor <= setupStart && coversInterval(freeIntervalsFor(snapshot, line, bounds.setup.plant, setupStart, boundary.start, bounds.runContext), { start: setupStart, end: boundary.start })) break;
    const prior = checkpoints.pop()!;
    patches.pop(); unadmitted.push(prior.task);
    predecessorState = prior.predecessorState; predecessorOrderId = prior.predecessorOrderId; cursor = prior.cursor;
    setupMinutes = prior.setupMinutes; lateCount = prior.lateCount; latenessMinutes = prior.latenessMinutes;
    overCapCount = prior.overCapCount; uncoveredEdgeCount = prior.uncoveredEdgeCount;
  }

  const deferredPairFailure = deferredAdjacencyFailure(line, unadmitted, adjacency);
  if (deferredPairFailure) return constraintFailure(deferredPairFailure);

  if (fragment.nextFirmed) {
    const firmed = fragment.nextFirmed;
    const inactiveOverride = inactiveOverrideForTransition(
      bounds,
      line,
      predecessorState,
      firmed.state,
      predecessorOrderId,
      taskId(firmed.task),
      fragment.lineOrderIds,
      fragment.allowsDeletedPredecessorBinding,
    );
    if (inactiveOverride) {
      missingEdges.push(inactiveOverride);
      return {
        feasible: false, patches: [], score: infeasibleScore(), policyKey: '', sequenceKey: '', unadmitted: [], explanation, missingEdges,
      };
    }
    // An uncovered matrix pair or a temporally infeasible reservation
    // (`incoming-firmed-setup-infeasible`) is a missing-setup-data fact, not a
    // reason to freeze the whole line (Part 1f): skip the reservation, keep
    // the diagnostic edge, and stay feasible. `deriveSetupObservation`/alerts
    // surface it against the applied schedule instead of a fake bar here.
    // A null `firmed.state` (never-freeze widening) means the boundary's own
    // setup state is unresolvable — the same zero-minute skip applies.
    if (predecessorState === null || firmed.state === null) {
      missingEdges.push(unknownInitialStateEdge(line, firmed.task));
    } else {
      const resolved = resolveSetup({
        definition,
        machine: line,
        predecessorState,
        successorState: firmed.state,
        predecessorOrderId,
        successorOrderId: taskId(firmed.task),
        plantRows: bounds.setup.plant_rows,
        machineRows: bounds.setup.machine_rows,
        overrides: bounds.setup.overrides,
        index: bounds.runContext?.resolutionIndex ?? undefined,
      });
      if (!resolved.covered || resolved.effectiveMin === null) {
        // A1: counted into uncoveredEdgeCount (only this !resolved.covered
        // branch — not `incoming-firmed-setup-infeasible` below, which is a
        // capacity fact about a covered transition, not a coverage gap).
        // The reason stays UNCOVERED_SETUP_TRANSITION_REASON (resolved.reason)
        // rather than 'scheduled-without-setup': this is the firmed order's own
        // incoming edge, not an order this call placed, and
        // `candidateEntersBoundaryUncovered` keys on this exact reason.
        uncoveredEdgeCount += 1;
        missingEdges.push({
          line,
          predecessorOrderId,
          successorOrderId: taskId(firmed.task),
          reason: resolved.reason,
        });
      } else {
        const setupStart = new Date(firmed.start.getTime() - resolved.effectiveMin * 60 * 1000);
        const fitsIncomingSetup = resolved.effectiveMin === 0
          ? cursor <= firmed.start
          : setupStart >= cursor && freeIntervalsFor(
            snapshot, line, bounds.setup.plant, cursor, firmed.start, bounds.runContext,
          ).some(interval => interval.start <= setupStart && interval.end >= firmed.start);
        if (!fitsIncomingSetup) {
          missingEdges.push({
            line,
            predecessorOrderId,
            successorOrderId: taskId(firmed.task),
            reason: 'incoming-firmed-setup-infeasible',
          });
        } else {
          setupMinutes += resolved.effectiveMin;
          if (!suppressExplanations) {
            explanation.push({
              code: 'firmed-incoming-setup',
              message: `Reserved ${resolved.effectiveMin} minutes of setup before firmed ${taskId(firmed.task)}.`,
              line,
              taskId: taskId(firmed.task),
            });
          }
        }
      }
    }
  }

  return {
    feasible: true,
    patches,
    // Lower is better. The due-date objective intentionally remains ahead of
    // admitted work and setup consumption; the sequence key is the final tie.
    // score[SCORE_OVER_CAP] (due-date push-forward limit) and
    // score[SCORE_UNCOVERED] (A2) are both compared in compareCandidate
    // immediately after policyKey, ahead of every term below — over-cap first.
    score: [
      0, policyScore(snapshot, bounds.setup.plant, line, sequence, bounds.runContext), lateCount, latenessMinutes, -patches.length,
      setupMinutes, uncoveredEdgeCount, overCapCount,
    ],
    policyKey: policyKeyForSequence(snapshot, bounds.setup.plant, line, sequence, bounds.runContext),
    sequenceKey: sequence.map(taskId).join('|'),
    admissionKey: admissionKey(snapshot, bounds, line, sequence, patches, fragment.end),
    unadmitted,
    explanation,
    missingEdges,
    finalState: predecessorState,
    finalPredecessorOrderId: predecessorOrderId,
  };
}

/** Two patch lists are equivalent for the re-run dev-guard below iff they
 * name the same ids, in the same order, with the same start/end instants —
 * schedule segments are derived from the same start/end pair and are not
 * separately compared. */
function patchesMatch(left: ReadonlyArray<SchedulePatch>, right: ReadonlyArray<SchedulePatch>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a.id !== b.id) return false;
    const aStart = a.changes.start_date instanceof Date ? a.changes.start_date.getTime() : null;
    const bStart = b.changes.start_date instanceof Date ? b.changes.start_date.getTime() : null;
    const aEnd = a.changes.end_date instanceof Date ? a.changes.end_date.getTime() : null;
    const bEnd = b.changes.end_date instanceof Date ? b.changes.end_date.getTime() : null;
    if (aStart !== bStart || aEnd !== bEnd) return false;
  }
  return true;
}

/**
 * Phase 1e: `exactSearch`/`greedySearch` evaluate every candidate with
 * `suppressExplanations` so the many losers never pay for building
 * placement-message text. Once the search settles on a winner, re-run
 * `candidateForSequence` exactly once against the winning sequence with
 * explanations enabled, and use THAT result — `candidateForSequence` is pure
 * and reads only `snapshot`/`bounds`/its arguments (any `bounds.runContext`
 * memo it touches is idempotent: a repeat read returns the same cached
 * value), and it never charges `budget`, so this re-run cannot diverge from
 * or cost anything the search-time evaluation didn't already pay for. The
 * dev-guard below compares the re-run's patches (ids + times) against the
 * search-time winner's and falls back to the search-time result — flagging a
 * diagnostic rather than throwing — if they somehow differ.
 */
function reexplainWinner(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  winner: DueDateCandidate | null,
  winnerSequence: ReadonlyArray<NimbusTask> | null,
  fragment: Readonly<FragmentContext>,
  adjacency: Readonly<FragmentAdjacency>,
): DueDateCandidate | null {
  if (!winner || !winnerSequence) return winner;
  const reexplained = candidateForSequence(snapshot, bounds, line, winnerSequence, fragment, adjacency);
  if (reexplained.feasible && patchesMatch(reexplained.patches, winner.patches)) return reexplained;
  winner.explanation.push({
    code: 'setup-candidate-reexplain-mismatch',
    message: 'Re-running the winning sequence with explanations enabled produced a different result; kept the search-time result.',
    line,
  });
  return winner;
}

function exactSearch(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  groups: ReadonlyArray<DueDateGroup>,
  fragment: Readonly<FragmentContext>,
  adjacency: Readonly<FragmentAdjacency>,
  budget: SearchBudget,
  mode: FragmentMode = 'due-date-first',
): SearchRun {
  if (adjacency.issue) {
    return {
      candidateCount: 0,
      method: 'due-date-first-exact',
      termination: 'completed',
      winner: null,
      missingEdges: [adjacency.issue],
      unknownTail: [],
    };
  }
  let candidateCount = 0;
  let termination: SearchRun['termination'] = 'completed';
  let winner: DueDateCandidate | null = null;
  // Phase 1e: the winning selection at the moment `winner` was last set, so
  // the post-loop re-run (below) can reproduce it with explanations enabled
  // without re-deriving it from patches (a partial winner's patches can be
  // shorter than its full selected sequence — see `due-work-unadmitted`).
  let winnerSequence: NimbusTask[] | null = null;
  // Phase 1e early-convergence exit: candidates evaluated since `winner` last
  // improved. Once this reaches the window AND a feasible winner already
  // exists, the search stops by choice ('converged') rather than continuing
  // to churn a plateau.
  let sinceImprovement = 0;
  const convergenceWindow = bounds.convergenceWindow ?? SETUP_AWARE_CONVERGENCE_WINDOW;
  const missingEdges: MissingSetupEdge[] = [];
  // A3: since A1, most permutations are feasible (mid-sequence uncovered
  // transitions are admitted, not rejected), so the "explored alternative"
  // diagnostic — an edge collected only from `!candidate.feasible` below —
  // would otherwise vanish for permutations whose OWN incoming-firmed-boundary
  // transition is uncovered (still `UNCOVERED_SETUP_TRANSITION_REASON`, since
  // that leniency predates A1 and is unaffected by it). Collect those from
  // feasible candidates too, Set-guarded so a large search cannot push
  // millions of duplicates.
  const seenFeasibleUncoveredEdgeKeys = new Set<string>();
  /** State groups remain the measured search dimension, but each occurrence
   * can be selected independently. This allows BLUE(09) -> RED(10) ->
  * BLUE(12), rather than flattening every BLUE order into one block. */
  const remainingCounts = groups.map(group => group.tasks.length);
  const totalTasks = remainingCounts.reduce((total, count) => total + count, 0);
  // A bounded DFS must reach a useful delivery sequence before exploring
  // color-group alternatives. Alphabetical group order can spend the whole
  // budget on late-due prefixes and never try open capacity for urgent work.
  const urgencyRank = new Map(urgencyOrder(snapshot, bounds, line, groups.flatMap(group => group.tasks))
    .map((item, index) => [taskId(item), index]));
  const selected: NimbusTask[] = [];
  const selectedIds = new Set<string>();
  const constrained = adjacency.predecessorBySuccessor.size > 0
    || adjacency.requiredInitialSuccessorId !== undefined
    || fragment.requiredFirstOrderId !== undefined
    || fragment.requiredLastOrderId !== undefined;
  /** A protected successor is never a normal group choice: it is selected only
   * immediately after its predecessor. Keeping a cursor over the remaining
   * normal occurrences makes a high-occurrence constrained fragment bounded
   * by the caller's work cap rather than repeatedly scanning its full group. */
  const normalTasks = constrained
    ? groups.map(group => group.tasks.filter(task => !adjacency.predecessorBySuccessor.has(taskId(task))))
    : [];
  const normalCursors = groups.map(() => 0);

  interface ExactChoice {
    task: NimbusTask;
    normalCursorAfter?: number;
  }
  const nextChoiceForGroup = (groupIndex: number): ExactChoice | null => {
    const group = groups[groupIndex];
    if (!remainingCounts[groupIndex]) return null;
    if (!constrained) return { task: group.tasks[group.tasks.length - remainingCounts[groupIndex]] };

    const previous = selected.at(-1);
    const expectedId = previous ? adjacency.successorByPredecessor.get(taskId(previous)) : undefined;
    if (expectedId) {
      const task = group.tasks.find(candidate => taskId(candidate) === expectedId && !selectedIds.has(expectedId));
      return task ? { task } : null;
    }
    const requiredFirst = requiredFirstOrderId(fragment, adjacency);
    if (selected.length === 0 && requiredFirst) {
      const task = group.tasks.find(candidate => taskId(candidate) === requiredFirst && !selectedIds.has(requiredFirst));
      return task ? { task } : null;
    }
    if (fragment.requiredLastOrderId && selected.length === totalTasks - 1) {
      const task = group.tasks.find(candidate => (
        taskId(candidate) === fragment.requiredLastOrderId && !selectedIds.has(fragment.requiredLastOrderId)
      ));
      return task ? { task } : null;
    }
    const candidates = normalTasks[groupIndex];
    for (let cursor = normalCursors[groupIndex]; cursor < candidates.length; cursor += 1) {
      const task = candidates[cursor];
      const id = taskId(task);
      if (selectedIds.has(id)
        || fragment.requiredLastOrderId === id) {
        continue;
      }
      return { task, normalCursorAfter: cursor + 1 };
    }
    return null;
  };

  interface ExactFrame {
    choices: number[];
    nextChoice: number;
    selectedGroupIndex: number | null;
    selectedTask: NimbusTask | null;
    previousNormalCursor: number | null;
  }
  const makeFrame = (selectedGroupIndex: number | null, selectedTask: NimbusTask | null): ExactFrame => ({
    choices: selected.length === totalTasks
      ? []
      : groups.flatMap((_, index) => {
        const choice = nextChoiceForGroup(index);
        return choice ? [{ index, rank: urgencyRank.get(taskId(choice.task))! }] : [];
      }).sort((a, b) => a.rank - b.rank).map(choice => choice.index),
    nextChoice: 0,
    selectedGroupIndex,
    selectedTask,
    previousNormalCursor: null,
  });
  const frames: ExactFrame[] = [makeFrame(null, null)];
  const popFrame = (): void => {
    const frame = frames.pop();
    if (!frame?.selectedTask || frame.selectedGroupIndex === null) return;
    selected.pop();
    selectedIds.delete(taskId(frame.selectedTask));
    remainingCounts[frame.selectedGroupIndex] += 1;
    if (frame.previousNormalCursor !== null) normalCursors[frame.selectedGroupIndex] = frame.previousNormalCursor;
  };

  // An explicit DFS stack replaces recursion. A caller can legitimately
  // choose an occurrence cap larger than JavaScript's call-stack limit; the
  // cap still bounds selections, while this representation cannot overflow it.
  while (frames.length && termination === 'completed') {
    if (bounds.clock() >= bounds.deadline) {
      termination = 'deadline';
      break;
    }
    const frame = frames.at(-1)!;
    if (selected.length === totalTasks) {
      // A zero-order fragment has no selected occurrence to charge as a
      // traversal edge, but it still evaluates a firmed-boundary transition.
      if (totalTasks === 0) {
        if (budget.remainingIterations <= 0) {
          termination = 'iteration-cap';
          break;
        }
        budget.remainingIterations -= 1;
      }
      candidateCount += 1;
      const candidate = candidateForSequence(snapshot, bounds, line, selected, fragment, adjacency, true);
      if (candidate.feasible && (!winner || compareCandidate(candidate, winner, mode) < 0)) {
        winner = candidate;
        winnerSequence = [...selected];
        sinceImprovement = 0;
      } else {
        sinceImprovement += 1;
      }
      if (!candidate.feasible) {
        missingEdges.push(...candidate.missingEdges);
      } else {
        for (const edge of candidate.missingEdges) {
          if (edge.reason !== UNCOVERED_SETUP_TRANSITION_REASON) continue;
          const key = missingEdgeKey(edge);
          if (seenFeasibleUncoveredEdgeKeys.has(key)) continue;
          seenFeasibleUncoveredEdgeKeys.add(key);
          missingEdges.push(edge);
        }
      }
      if (winner && sinceImprovement >= convergenceWindow) termination = 'converged';
      popFrame();
      continue;
    }
    if (frame.nextChoice >= frame.choices.length) {
      popFrame();
      continue;
    }
    const groupIndex = frame.choices[frame.nextChoice++];
    const choice = nextChoiceForGroup(groupIndex);
    if (!choice) continue;
    if (budget.remainingIterations <= 0) {
      termination = 'iteration-cap';
      break;
    }
    budget.remainingIterations -= 1;
    const previousNormalCursor = choice.normalCursorAfter === undefined ? null : normalCursors[groupIndex];
    if (choice.normalCursorAfter !== undefined) normalCursors[groupIndex] = choice.normalCursorAfter;
    remainingCounts[groupIndex] -= 1;
    selected.push(choice.task);
    selectedIds.add(taskId(choice.task));
    const child = makeFrame(groupIndex, choice.task);
    child.previousNormalCursor = previousNormalCursor;
    frames.push(child);
  }
  winner = reexplainWinner(snapshot, bounds, line, winner, winnerSequence, fragment, adjacency);
  return { candidateCount, method: 'due-date-first-exact', termination, winner, missingEdges, unknownTail: [] };
}

function greedySearch(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  groups: ReadonlyArray<DueDateGroup>,
  fragment: Readonly<FragmentContext>,
  adjacency: Readonly<FragmentAdjacency>,
  budget: SearchBudget,
  mode: FragmentMode = 'due-date-first',
): SearchRun {
  if (adjacency.issue) {
    return {
      candidateCount: 0, method: 'due-date-first-greedy', termination: 'completed', winner: null, missingEdges: [adjacency.issue], unknownTail: [],
    };
  }
  if (bounds.clock() >= bounds.deadline) {
    return {
      candidateCount: 0, method: 'due-date-first-greedy', termination: 'deadline', winner: null, missingEdges: [], unknownTail: [],
    };
  }
  if (budget.remainingIterations <= 0) {
    return {
      candidateCount: 0, method: 'due-date-first-greedy', termination: 'iteration-cap', winner: null, missingEdges: [], unknownTail: [],
    };
  }
  // Decorate-sort-undecorate: compute each task's (ctx-memoized) policy key
  // once rather than up to twice per comparator call, and compare it
  // ordinally (see `ordinalCompare` — identical order to `localeCompare` for
  // this zero-padded-digit alphabet, without the ICU collation cost).
  const decoratedTasks = groups.flatMap(group => group.tasks).map(task => (
    { task, key: policyKeyForTask(snapshot, bounds.setup.plant, line, task, bounds.runContext) }
  ));
  decoratedTasks.sort((left, right) => (
    ordinalCompare(left.key, right.key)
    || dueTimestamp(left.task) - dueTimestamp(right.task)
    || taskId(left.task).localeCompare(taskId(right.task))
  ));
  const orderedTasks = decoratedTasks.map(entry => entry.task);
  let candidateCount = 0;
  let termination: SearchRun['termination'] = 'completed';
  let winner: DueDateCandidate | null = null;
  // Phase 1e: see the matching declarations in exactSearch.
  let winnerSequence: ReadonlyArray<NimbusTask> | null = null;
  let sinceImprovement = 0;
  const convergenceWindow = bounds.convergenceWindow ?? SETUP_AWARE_CONVERGENCE_WINDOW;
  const missingEdges: MissingSetupEdge[] = [];
  const seen = new Set<string>();
  // A3: see the matching comment in exactSearch — preserves the "explored
  // alternative" diagnostic for a feasible candidate's own uncovered
  // incoming-firmed-boundary edge, now that most permutations no longer fail
  // outright on a mid-sequence uncovered transition.
  const seenFeasibleUncoveredEdgeKeys = new Set<string>();

  const evaluate = (sequence: ReadonlyArray<NimbusTask>): DueDateCandidate | null => {
    if (bounds.clock() >= bounds.deadline) {
      termination = 'deadline';
      return null;
    }
    if (budget.remainingIterations <= 0) {
      termination = 'iteration-cap';
      return null;
    }
    const key = sequence.map(taskId).join('\u0000');
    if (seen.has(key)) return null;
    seen.add(key);
    budget.remainingIterations -= 1;
    candidateCount += 1;
    const candidate = candidateForSequence(
      snapshot,
      bounds,
      line,
      sequence,
      fragment,
      adjacency,
      true,
    );
    if (!candidate.feasible) {
      missingEdges.push(...candidate.missingEdges);
      sinceImprovement += 1;
      if (winner && sinceImprovement >= convergenceWindow) termination = 'converged';
      return null;
    }
    for (const edge of candidate.missingEdges) {
      if (edge.reason !== UNCOVERED_SETUP_TRANSITION_REASON) continue;
      const edgeKey = missingEdgeKey(edge);
      if (seenFeasibleUncoveredEdgeKeys.has(edgeKey)) continue;
      seenFeasibleUncoveredEdgeKeys.add(edgeKey);
      missingEdges.push(edge);
    }
    if (!winner || compareCandidate(candidate, winner, mode) < 0) {
      winner = candidate;
      winnerSequence = sequence;
      sinceImprovement = 0;
    } else {
      sinceImprovement += 1;
    }
    // Phase 1e nuance: a full non-improving sweep already terminates this
    // hill-climb naturally (`improved` stays false); the window only needs to
    // cut a long sweep short, and never before `winner` exists.
    if (winner && sinceImprovement >= convergenceWindow) termination = 'converged';
    return candidate;
  };

  const protectedOrder = orderWithAdjacency(orderedTasks, fragment, adjacency);
  if (!protectedOrder) {
    return {
      candidateCount: 0,
      method: 'due-date-first-greedy',
      termination: 'completed',
      winner: null,
      missingEdges: [inactiveOverrideEdge(line, null, requiredFirstOrderId(fragment, adjacency))],
      unknownTail: [],
    };
  }
  let currentOrder = protectedOrder;
  let current = evaluate(currentOrder);
  let improved = true;
  while (improved && termination === 'completed') {
    improved = false;
    for (let index = 0; index < currentOrder.length - 1; index += 1) {
      const neighbor = [...currentOrder];
      [neighbor[index], neighbor[index + 1]] = [neighbor[index + 1], neighbor[index]];
      const candidate = evaluate(neighbor);
      if (termination !== 'completed') break;
      if (candidate && current && compareCandidate(candidate, current, mode) < 0) {
        currentOrder = neighbor;
        current = candidate;
        improved = true;
        break;
      }
      if (candidate && !current) {
        currentOrder = neighbor;
        current = candidate;
        improved = true;
        break;
      }
    }
  }
  winner = reexplainWinner(snapshot, bounds, line, winner, winnerSequence, fragment, adjacency);
  return {
    candidateCount,
    method: 'due-date-first-greedy',
    termination,
    winner,
    missingEdges,
    unknownTail: [],
  };
}

function missingEdgeKey(edge: Readonly<MissingSetupEdge>): string {
  return [edge.line, edge.predecessorOrderId ?? '', edge.successorOrderId ?? '', edge.reason].join('\u0000');
}

function uniqueMissingEdges(edges: ReadonlyArray<MissingSetupEdge>): MissingSetupEdge[] {
  const seen = new Set<string>();
  return edges.filter(edge => {
    const key = missingEdgeKey(edge);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Build the set of missing-edge keys a winning candidate itself admitted, so
 * `appendRejectedCoverageDiagnostics` can skip reporting the winner's own
 * incoming-firmed-boundary edge as "Rejected …" (A3) — otherwise the winner's
 * own pair would be reported as rejected, contradicting the placement just
 * made. */
function winnerEdgeKeySet(candidate: Readonly<DueDateCandidate> | null | undefined): ReadonlySet<string> {
  return new Set((candidate?.missingEdges ?? []).map(missingEdgeKey));
}

/** Successful Due-date-first search can exclude an uncovered permutation.
 * Keep only that actionable coverage fact for preview review; rejected
 * capacity/override branches are search noise, and SPT never explores an
 * alternate productive-time sequence.
 * `winnerEdgeKeys` (A3) — the keys of edges the just-selected winner itself
 * carries — are skipped here: since A3 also collects a feasible candidate's
 * own uncovered incoming-firmed-boundary edge (see `exactSearch`/
 * `greedySearch`), the winner's own edge can otherwise appear in `edges` and
 * get reported as "Rejected …" even though it was the placement just made.
 * Precondition (2026-09-09): this assumes the winner was chosen for having
 * (among) the fewest uncovered edges, which only holds for the tier order
 * every mode except `'due-date'` uses — callers on the `'due-date'` path must
 * not call this (or must gate the call on `mode !== 'due-date'`). */
function appendRejectedCoverageDiagnostics(
  missingEdges: MissingSetupEdge[],
  explanation: CandidateReason[],
  edges: ReadonlyArray<MissingSetupEdge>,
  winnerEdgeKeys: ReadonlySet<string> = new Set(),
): void {
  const existing = new Set(missingEdges.map(missingEdgeKey));
  for (const edge of uniqueMissingEdges(edges)) {
    if (edge.reason !== UNCOVERED_SETUP_TRANSITION_REASON) continue;
    const key = missingEdgeKey(edge);
    if (winnerEdgeKeys.has(key)) continue;
    if (!existing.has(key)) {
      existing.add(key);
      missingEdges.push(edge);
    }
    const message = `Rejected ${edge.predecessorOrderId ?? 'initial state'} -> ${edge.successorOrderId ?? 'unknown'} because no version-matched setup transition covers that state pair.`;
    if (explanation.some(reason => (
      reason.code === 'rejected-uncovered-transition'
      && reason.line === edge.line
      && reason.taskId === (edge.successorOrderId ?? undefined)
      && reason.message === message
    ))) continue;
    explanation.push({ code: 'rejected-uncovered-transition', message, line: edge.line, taskId: edge.successorOrderId ?? undefined });
  }
}

function searchFragment(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  tasks: ReadonlyArray<NimbusTask>,
  fragment: Readonly<FragmentContext>,
  budget: SearchBudget,
  mode: FragmentMode = 'due-date-first',
): SearchRun {
  const definition = bounds.setup.definition!;
  const groupsByState = new Map<string, DueDateGroup>();
  const missingEdges: MissingSetupEdge[] = [];
  const unknownTail: NimbusTask[] = [];
  for (const task of tasks) {
    const state = orderState(bounds, task, definition);
    // A null successor signature is opaque: retaining it in the permutation
    // core would let a later known order appear to have a trustworthy
    // predecessor. Keep known-but-uncovered matrix transitions in the core;
    // only the order's own unresolved signature belongs in the tail.
    if (!state) {
      unknownTail.push(task);
      continue;
    }
    const key = orderStateKey(bounds, task, definition)!;
    const group = groupsByState.get(key) ?? { key, state: state ?? [], tasks: [] };
    group.tasks.push(task);
    groupsByState.set(key, group);
  }
  const adjacency = fragmentAdjacency(bounds, line, tasks, fragment);
  if (adjacency.issue) {
    // An active-override conflict is an explicit user assertion and stays
    // fail-closed (Part 1f); it is not a missing-data fact to route around.
    return {
      candidateCount: 0,
      method: 'due-date-first-exact',
      termination: 'completed',
      winner: null,
      missingEdges: [...missingEdges, adjacency.issue],
      unknownTail,
    };
  }
  const groups = [...groupsByState.values()]
    .map(group => ({ ...group, tasks: urgencyOrder(snapshot, bounds, line, group.tasks) }))
    .sort((left, right) => left.key.localeCompare(right.key));
  unknownTail.sort((left, right) => {
    const ordered = urgencyOrder(snapshot, bounds, line, [left, right]);
    if (taskId(ordered[0]) === taskId(left)) return -1;
    if (taskId(ordered[0]) === taskId(right)) return 1;
    return ordinalCompare(taskId(left), taskId(right));
  });
  if (mode === 'spt') {
    if (bounds.clock() >= bounds.deadline) {
      return {
        candidateCount: 0, method: 'due-date-first-exact', termination: 'deadline', winner: null, missingEdges, unknownTail,
      };
    }
    if (budget.remainingIterations <= 0) {
      return {
        candidateCount: 0, method: 'due-date-first-exact', termination: 'iteration-cap', winner: null, missingEdges, unknownTail,
      };
    }
    const workingTasks = groups.flatMap(group => group.tasks);
    // A4: the coverage-demotion backstop (Part 1b) is gone — `allUncoveredTransitions`
    // can no longer be true (A1 admits uncovered mid-sequence transitions
    // instead of rejecting the candidate), so a single evaluation replaces
    // the former retry-with-demotion loop.
    budget.remainingIterations -= 1;
    // Due-date push-forward limit: this is a single fixed run-time-ordered
    // walk (no ranking search to steer via score[SCORE_OVER_CAP]), so
    // capAwareSequence pulls a still-savable capped order ahead of the SPT
    // head when the head would otherwise push it past its latest allowed
    // start. A no-op when no task in this fragment has a ceiling
    // (bounds.notAfter absent/null) — capAwareSequence returns its input
    // unchanged in that case.
    const sequence = orderWithAdjacency(
      capAwareSequence(
        orderedByProductiveRuntime(workingTasks),
        fragment.start.getTime(),
        task => notAfterFor(bounds, task)?.getTime() ?? null,
        task => productiveRuntimeMinutes(task) * 60 * 1000,
      ),
      fragment,
      adjacency,
    );
    if (!sequence) {
      return {
        candidateCount: 1,
        method: 'due-date-first-exact',
        termination: 'completed',
        winner: null,
        missingEdges: [...missingEdges, inactiveOverrideEdge(line, null, requiredFirstOrderId(fragment, adjacency))],
        unknownTail,
      };
    }
    let candidate = candidateForSequence(snapshot, bounds, line, sequence, fragment, adjacency);
    const urgentSequence = orderWithAdjacency(urgencyOrder(snapshot, bounds, line, workingTasks), fragment, adjacency);
    if (urgentSequence && bounds.clock() < bounds.deadline && budget.remainingIterations > 0) {
      budget.remainingIterations--;
      const urgent = candidateForSequence(snapshot, bounds, line, urgentSequence, fragment, adjacency);
      if (urgent.feasible && (!candidate.feasible || ordinalCompare(urgent.admissionKey ?? '', candidate.admissionKey ?? '') < 0)) candidate = urgent;
    }
    return {
      candidateCount: 1,
      method: 'due-date-first-exact',
      termination: 'completed',
      winner: candidate.feasible ? candidate : null,
      missingEdges: candidate.feasible ? missingEdges : [...missingEdges, ...candidate.missingEdges],
      unknownTail,
    };
  }

  // A4: the coverage-demotion backstop (Part 1b) is gone — `allUncoveredTransitions`
  // can no longer be true (A1 admits uncovered transitions instead of
  // rejecting the candidate), so a single exact/greedy run replaces the
  // former retry-with-demotion loop.
  const run: SearchRun = groups.length <= bounds.exactSearchThreshold
    ? exactSearch(snapshot, bounds, line, groups, fragment, adjacency, budget, mode)
    : greedySearch(snapshot, bounds, line, groups, fragment, adjacency, budget, mode);
  return {
    ...run,
    missingEdges: [...missingEdges, ...run.missingEdges],
    unknownTail,
  };
}

function unchangedLineResult(
  line: string,
  code: string,
  message: string,
  missingEdges: MissingSetupEdge[] = [],
  priorExplanation: ReadonlyArray<CandidateReason> = [],
): LineSearchResult {
  return {
    patches: [],
    score: zeroScore(),
    explanation: [...priorExplanation, { code, message, line }],
    missingEdges,
    candidateCount: 0,
    method: 'due-date-first-exact',
    termination: 'completed',
    unchanged: true,
  };
}

function initialStateForLine(
  bounds: Readonly<DueDateFirstBounds>, line: string, signatureVersion: number,
): { state: SetupStateKey | null; reason: 'initial-state-unknown' | 'signature-incompatible' } {
  const lineStates = bounds.setup.machine_states.filter(state => state.machine === line);
  const matching = lineStates.find(state => state.signature_version === signatureVersion);
  if (matching) return { state: matching.state_key, reason: 'initial-state-unknown' };
  return {
    state: null,
    reason: lineStates.length ? 'signature-incompatible' : 'initial-state-unknown',
  };
}

/** Select the physical first scheduled interval before considering its setup
 * state. Ties are deterministic by end then task ID. We must never skip an
 * earlier order with an unusable state to anchor a later order, because that
 * would rewrite the physical predecessor rather than preserving it. */
function initialScheduledAnchor(
  tasks: ReadonlyArray<NimbusTask>,
  definition: NonNullable<SetupTruthSnapshot['definition']>,
): InitialScheduledAnchor | null {
  const candidates = tasks.flatMap(task => {
    const start = timestamp(task.start_date);
    const end = timestamp(task.end_date);
    if (!start || !end || end <= start) return [];
    return [{ task, start, end }];
  }).sort((left, right) => (
    left.start.getTime() - right.start.getTime()
    || left.end.getTime() - right.end.getTime()
    || taskId(left.task).localeCompare(taskId(right.task))
  ));
  const current = candidates[0];
  if (!current) return null;
  return { ...current, state: stateForOrder(current.task, definition) };
}

function preservedInitialAnchor(selection: Readonly<InitialScheduledAnchor> | null): PreservedInitialAnchor | null {
  return selection?.state ? { ...selection, state: selection.state } : null;
}

function unknownInitialStateEdge(
  line: string,
  task: Readonly<NimbusTask> | null | undefined,
): MissingSetupEdge {
  return {
    line,
    predecessorOrderId: null,
    ...(task ? { successorOrderId: taskId(task) } : {}),
    reason: 'initial-state-unknown',
  };
}

function unknownInitialStateReason(line: string, task: Readonly<NimbusTask> | null | undefined): CandidateReason {
  const id = task ? taskId(task) : undefined;
  return {
    code: 'initial-state-unknown',
    message: id
      ? `Preserved current first order ${id}; its incoming setup is unknown.`
      : 'No usable current setup state or scheduled first order is available for this line.',
    line,
    ...(id ? { taskId: id } : {}),
  };
}

/** Compatibility is snapshot-owned setup truth. An absent field intentionally
 * retains the legacy compatible behavior so older cached master-data payloads
 * cannot silently exclude a line. */
function setupCompatibilityForLine(
  snapshot: Readonly<ScheduleSnapshot>, plant: string, line: string,
): { reason: string | null } | null {
  const masterLine = snapshot.masterData?.lines.find(candidate => (
    candidate.plant === plant && candidate.machine === line
  ));
  if (masterLine?.setup_compatible !== false) return null;
  return { reason: masterLine.setup_compatibility_reason ?? null };
}

function boundaryOverrideLocks(
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  firmed: ReadonlyArray<FirmedBoundary>,
  free: ReadonlyArray<NimbusTask>,
  initialState: SetupStateKey | null,
  initialPredecessorOrderId: string | null,
): ReadonlyMap<string, BoundaryOverrideLocks> {
  const definition = bounds.setup.definition!;
  const firmedById = new Map(firmed.map(boundary => [taskId(boundary.task), boundary]));
  const firmedIndexById = new Map(firmed.map((boundary, index) => [taskId(boundary.task), index]));
  const freeById = new Map(free.map(task => [taskId(task), task]));
  const locks = new Map<string, BoundaryOverrideLocks>();

  const lockFor = (firmedId: string): BoundaryOverrideLocks => {
    const existing = locks.get(firmedId);
    if (existing) return existing;
    const created: BoundaryOverrideLocks = {};
    locks.set(firmedId, created);
    return created;
  };
  const conflict = (firmedId: string, successorOrderId: string): void => {
    const lock = lockFor(firmedId);
    lock.issue = { line, successorOrderId, reason: 'override-inactive' };
  };

  for (const override of bounds.setup.overrides) {
    if (override.status !== 'active' || override.machine !== line || override.signature_version !== definition.signature_version) {
      continue;
    }
    const successorFirmed = firmedById.get(override.successor_order_id);
    const predecessorFirmed = override.predecessor_order_id ? firmedById.get(override.predecessor_order_id) : undefined;

    if (successorFirmed && override.predecessor_order_id === initialPredecessorOrderId) {
      const successorId = taskId(successorFirmed.task);
      const successorIndex = firmedIndexById.get(successorId);
      const lock = lockFor(successorId);
      if (successorIndex !== 0
        || initialState === null
        // A firmed boundary with an unresolvable setup state (never-freeze
        // widening) can never confirm a bound override's exact state match.
        || successorFirmed.state === null
        || stateKey(override.predecessor_state_key) !== stateKey(initialState)
        || stateKey(override.successor_state_key) !== stateKey(successorFirmed.state)
        || lock.requiredFirmedPredecessorId
        || lock.requiredLastOrderId) {
        conflict(successorId, override.successor_order_id);
      } else {
        if (initialPredecessorOrderId === null) lock.requiresInitialState = true;
        else lock.requiresInitialPredecessorId = initialPredecessorOrderId;
      }
      continue;
    }

    if (predecessorFirmed && successorFirmed) {
      const predecessorId = taskId(predecessorFirmed.task);
      const successorId = taskId(successorFirmed.task);
      const predecessorIndex = firmedIndexById.get(predecessorId);
      const successorIndex = firmedIndexById.get(successorId);
      const predecessorLock = lockFor(predecessorId);
      const successorLock = lockFor(successorId);
      if (predecessorIndex === undefined
        || successorIndex !== predecessorIndex + 1
        || predecessorLock.requiredFirstOrderId
        || (predecessorLock.requiredFirmedSuccessorId && predecessorLock.requiredFirmedSuccessorId !== successorId)
        || successorLock.requiredLastOrderId
        || (successorLock.requiredFirmedPredecessorId && successorLock.requiredFirmedPredecessorId !== predecessorId)) {
        conflict(predecessorId, override.successor_order_id);
        conflict(successorId, override.successor_order_id);
      } else {
        predecessorLock.requiredFirmedSuccessorId = successorId;
        successorLock.requiredFirmedPredecessorId = predecessorId;
      }
      continue;
    }

    if (successorFirmed && override.predecessor_order_id) {
      const predecessor = freeById.get(override.predecessor_order_id);
      if (!predecessor) {
        conflict(taskId(successorFirmed.task), override.successor_order_id);
        continue;
      }
      const lock = lockFor(taskId(successorFirmed.task));
      if (lock.requiresInitialState
        || lock.requiredFirmedPredecessorId
        || (lock.requiredLastOrderId && lock.requiredLastOrderId !== taskId(predecessor))) {
        conflict(taskId(successorFirmed.task), override.successor_order_id);
      } else {
        lock.requiredLastOrderId = taskId(predecessor);
      }
    }

    if (predecessorFirmed) {
      const successor = freeById.get(override.successor_order_id);
      if (!successor) {
        // A removed successor is reported by missingSuccessorOverrideEdges;
        // it does not justify freezing unrelated remaining work on the line.
        if (!firmedById.has(override.successor_order_id)) continue;
        conflict(taskId(predecessorFirmed.task), override.successor_order_id);
        continue;
      }
      const lock = lockFor(taskId(predecessorFirmed.task));
      if (lock.requiredFirmedSuccessorId
        || (lock.requiredFirstOrderId && lock.requiredFirstOrderId !== taskId(successor))) {
        conflict(taskId(predecessorFirmed.task), override.successor_order_id);
      } else {
        lock.requiredFirstOrderId = taskId(successor);
      }
    }
  }
  return locks;
}

interface OutOfHorizonFirmedOverrideAudit {
  protectedEdges: MissingSetupEdge[];
  inactiveEdges: MissingSetupEdge[];
}

/** A hard candidate horizon may omit ordinary future firmed production, but it
 * cannot erase an active exact relation to that production. A valid matching
 * pair must fail closed because the detached plan cannot preserve it without
 * scheduling through the caller's bound. A stale or missing pair is instead
 * retained as an inactive diagnostic, never silently dropped or protected. */
function auditOutOfHorizonFirmedOverrides(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  initialState: SetupStateKey | null,
  initial: Readonly<LineInitialContext>,
): OutOfHorizonFirmedOverrideAudit {
  const definition = bounds.setup.definition!;
  const tasksById = new Map(initial.allTasks.map(task => [taskId(task), task]));
  const postHorizonFirmedIds = new Set(initial.allTasks.flatMap(task => {
    const start = timestamp(task.start_date);
    return taskIsFirmed(snapshot, task) && start && start > bounds.horizonEnd ? [taskId(task)] : [];
  }));
  if (!postHorizonFirmedIds.size) return { protectedEdges: [], inactiveEdges: [] };

  const stateForEndpoint = (orderId: string | null): SetupStateKey | null => {
    if (orderId === null) return initial.predecessorOrderId === null ? initialState : null;
    const task = tasksById.get(orderId);
    return task ? orderState(bounds, task, definition) : null;
  };
  const protectedEdges: MissingSetupEdge[] = [];
  const inactiveEdges: MissingSetupEdge[] = [];
  for (const override of bounds.setup.overrides) {
    if (override.status !== 'active'
      || override.machine !== line
      || override.signature_version !== definition.signature_version) {
      continue;
    }
    const predecessorOrderId = override.predecessor_order_id === null
      ? null
      : String(override.predecessor_order_id);
    const successorOrderId = String(override.successor_order_id);
    if (!postHorizonFirmedIds.has(predecessorOrderId ?? '')
      && !postHorizonFirmedIds.has(successorOrderId)) {
      continue;
    }
    const predecessorState = stateForEndpoint(predecessorOrderId);
    const successorState = stateForEndpoint(successorOrderId);
    if (!predecessorState || !successorState
      || stateKey(predecessorState) !== stateKey(override.predecessor_state_key)
      || stateKey(successorState) !== stateKey(override.successor_state_key)) {
      inactiveEdges.push(inactiveOverrideEdge(line, predecessorOrderId, successorOrderId));
      continue;
    }
    protectedEdges.push({
      line,
      predecessorOrderId,
      successorOrderId,
      reason: PROTECTED_FIRMED_BOUNDARY_OUTSIDE_HORIZON_REASON,
    });
  }
  const sortEdges = (edges: ReadonlyArray<MissingSetupEdge>): MissingSetupEdge[] => (
    uniqueMissingEdges(edges).sort((left, right) => (
      [left.predecessorOrderId ?? '', left.successorOrderId ?? ''].join('\u0000').localeCompare(
        [right.predecessorOrderId ?? '', right.successorOrderId ?? ''].join('\u0000'),
      )
    ))
  );
  return { protectedEdges: sortEdges(protectedEdges), inactiveEdges: sortEdges(inactiveEdges) };
}

function protectedOutOfHorizonFirmedBoundaryReasons(
  line: string,
  edges: ReadonlyArray<MissingSetupEdge>,
): CandidateReason[] {
  return edges.map(edge => ({
    code: PROTECTED_FIRMED_BOUNDARY_OUTSIDE_HORIZON_REASON,
    message: `Active override ${edge.predecessorOrderId ?? 'initial state'} -> ${edge.successorOrderId ?? 'unknown'} crosses a firmed boundary outside the caller horizon.`,
    line,
    taskId: edge.successorOrderId ?? undefined,
  }));
}

function inactiveOutOfHorizonFirmedOverrideReasons(
  line: string,
  edges: ReadonlyArray<MissingSetupEdge>,
): CandidateReason[] {
  return edges.map(edge => ({
    code: 'override-inactive',
    message: `Active override ${edge.predecessorOrderId ?? 'initial state'} -> ${edge.successorOrderId ?? 'unknown'} no longer matches a firmed boundary outside the caller horizon.`,
    line,
    taskId: edge.successorOrderId ?? undefined,
  }));
}

function belongsBeforeFirmedBoundary(task: NimbusTask, boundary: FirmedBoundary, mode: FragmentMode): boolean {
  if (mode === 'due-date-first' || mode === 'due-date') return dueTimestamp(task) <= boundary.start.getTime();
  // Pure SPT is ordered only by productive runtime. A stale or null planned
  // date must not pre-partition work behind the next firmed order; bounded
  // fragment placement decides what capacity can actually be admitted first.
  return true;
}

/** Represent whole free components that may safely defer around a firmed
 * boundary. A reroute is permitted only for a coverage failure or for setup
 * capacity that cannot fit before the boundary; an active free/free component
 * always moves together. */
interface BoundaryFallbackOption {
  retained: NimbusTask[];
  deferred: NimbusTask[];
}

/** Only setup-coverage and firmed incoming-capacity failures can safely try a
 * different obstacle-free fragment admission. Broken override bindings and
 * unknown states remain hard failures rather than excuses to drop work. */
function supportsBoundaryFallback(run: Readonly<SearchRun>): boolean {
  return run.missingEdges.length > 0 && run.missingEdges.every(edge => (
    edge.reason === UNCOVERED_SETUP_TRANSITION_REASON
    || edge.reason === 'incoming-firmed-setup-infeasible'
  ));
}

/** F3b secondary hardening: Part 1f's incoming-boundary leniency means
 * `candidateForSequence` still reports `feasible: true` for a fragment whose
 * LAST order's transition into `fragment.nextFirmed` is uncovered — it just
 * skips the reservation and pushes a diagnostic edge rather than freezing.
 * That is correct for the covered-core search itself, but the non-terminal
 * fallback-ambiguity count below must not treat such a "leniently tolerated"
 * route as equally genuine to one whose incoming reservation is actually
 * covered — otherwise a single order that can never really enter this
 * boundary (e.g. RED when only BLUE -> firmed is covered) counts as a second
 * "feasible" route and manufactures a false ambiguity where only one real
 * route exists. */
function candidateEntersBoundaryUncovered(
  candidate: Readonly<DueDateCandidate>,
  boundaryTaskId: string,
): boolean {
  return candidate.missingEdges.some(edge => (
    edge.successorOrderId === boundaryTaskId && edge.reason === UNCOVERED_SETUP_TRANSITION_REASON
  ));
}

interface BoundaryFallbackComponentPlan {
  components: string[][];
  removable: boolean[];
}

/** Resolve the deterministic ordered free components eligible for a local
 * firmed-boundary fallback. A component is atomic: active free/free overrides
 * may never be split across a boundary, and required boundary endpoints can
 * never be deferred. */
function boundaryFallbackComponentPlan(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  admitted: ReadonlyArray<NimbusTask>,
  fragment: Readonly<FragmentContext>,
  freeComponents: ReadonlyMap<string, ReadonlySet<string>>,
  mode: FragmentMode,
): BoundaryFallbackComponentPlan | null {
  if (!fragment.nextFirmed || !admitted.length) return null;
  const baseOrder = mode === 'spt'
    ? orderedByProductiveRuntime(admitted)
    : mode === 'due-date'
      ? orderedByDueThenPolicy(snapshot, bounds.setup.plant, line, admitted, bounds.runContext)
      : orderedByPolicyThenDue(snapshot, bounds.setup.plant, line, admitted, bounds.runContext);
  const adjacency = fragmentAdjacency(bounds, line, admitted, fragment);
  const sequence = orderWithAdjacency(baseOrder, fragment, adjacency);
  if (!sequence) return null;
  const admittedIds = new Set(admitted.map(taskId));
  const protectedIds = new Set([
    fragment.requiredFirstOrderId,
    fragment.requiredLastOrderId,
  ].filter((id): id is string => Boolean(id)));
  const seenComponents = new Set<string>();
  const components: string[][] = [];

  for (const task of sequence) {
    const id = taskId(task);
    const component = freeComponents.get(id) ?? new Set([id]);
    const members = [...component].sort();
    const componentKey = members.join('\u0000');
    if (seenComponents.has(componentKey)) continue;
    seenComponents.add(componentKey);
    components.push(members);
  }

  return {
    components,
    removable: components.map(members => (
      members.every(member => admittedIds.has(member) && !protectedIds.has(member))
    )),
  };
}

function fallbackOptionForDeferredIds(
  admitted: ReadonlyArray<NimbusTask>,
  deferredIds: ReadonlySet<string>,
): BoundaryFallbackOption | null {
  if (!deferredIds.size) return null;
  const retained = admitted.filter(task => !deferredIds.has(taskId(task)));
  const deferred = admitted.filter(task => deferredIds.has(taskId(task)));
  return deferred.length ? { retained, deferred } : null;
}

/** Pure SPT remains limited to its established deterministic suffix fallback:
 * productive runtime selected the sequence, so setup coverage cannot introduce
 * a hidden alternate-order objective. */
function sptBoundaryFallbackOptions(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  admitted: ReadonlyArray<NimbusTask>,
  fragment: Readonly<FragmentContext>,
  freeComponents: ReadonlyMap<string, ReadonlySet<string>>,
): BoundaryFallbackOption[] {
  const plan = boundaryFallbackComponentPlan(
    snapshot, bounds, line, admitted, fragment, freeComponents, 'spt',
  );
  if (!plan) return [];
  const options: BoundaryFallbackOption[] = [];

  const suffixDeferredIds = new Set<string>();
  for (let index = plan.components.length - 1; index >= 0; index -= 1) {
    const members = plan.components[index];
    // A component that already straddles a boundary or contains a required
    // endpoint cannot participate in a cumulative suffix.
    if (!plan.removable[index]) break;
    for (const member of members) suffixDeferredIds.add(member);
    const option = fallbackOptionForDeferredIds(admitted, suffixDeferredIds);
    if (option) options.push(option);
  }
  return options;
}

interface BoundaryFallbackCursor {
  next(): BoundaryFallbackOption | null;
  readonly termination: SearchRun['termination'];
}

/** Enumerate every non-empty subset of removable Due-date-first components
 * lazily in deterministic cardinality/sequence order. One unit of the shared
 * search budget is charged before each subset, so an exponential combination
 * space cannot escape the caller's existing cap or deadline. Phase 1.5
 * budget-honesty check (requirement 5): the `budget` passed in here is the
 * SAME `SearchBudget` object `evaluateLineWithFirmedBoundaries` received as a
 * parameter (constructed once per line by its caller) — and every
 * `searchFragment` continuation run triggered per component-subset option
 * below (both the terminal-boundary and non-terminal-boundary branches)
 * reuses that identical object reference too, never a fresh one. Confirmed
 * by inspection, not by a code change: nothing here needed fixing.
 *
 * `mode` (2026-09-09, due-date mode): despite the name/comment predating it,
 * this is reached by every non-`'spt'` mode, not only `'due-date-first'` —
 * `evaluateLineWithFirmedBoundaries` calls it for `'min-changeover'`/
 * `'throughput'`/`'due-date'` too. It is threaded straight through to
 * `boundaryFallbackComponentPlan` (rather than the previously hardcoded
 * `'due-date-first'` literal) purely so that call picks
 * `orderedByDueThenPolicy` over `orderedByPolicyThenDue` for `'due-date'`;
 * every other mode maps to the same `orderedByPolicyThenDue` branch either
 * way, so this is a no-op for them. */
function dueDateBoundaryFallbackCursor(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  admitted: ReadonlyArray<NimbusTask>,
  fragment: Readonly<FragmentContext>,
  freeComponents: ReadonlyMap<string, ReadonlySet<string>>,
  budget: SearchBudget,
  mode: FragmentMode,
): BoundaryFallbackCursor {
  const plan = boundaryFallbackComponentPlan(
    snapshot, bounds, line, admitted, fragment, freeComponents, mode,
  );
  const removableComponents = plan
    ? plan.components.filter((_, index) => plan.removable[index])
    : [];
  let subsetSize = removableComponents.length ? 1 : 0;
  let subsetIndexes = subsetSize ? [0] : [];
  let exhausted = !subsetSize;
  let termination: SearchRun['termination'] = 'completed';

  const advance = (): void => {
    for (let index = subsetIndexes.length - 1; index >= 0; index -= 1) {
      const maxIndex = removableComponents.length - subsetIndexes.length + index;
      if (subsetIndexes[index] < maxIndex) {
        subsetIndexes[index] += 1;
        for (let trailing = index + 1; trailing < subsetIndexes.length; trailing += 1) {
          subsetIndexes[trailing] = subsetIndexes[trailing - 1] + 1;
        }
        return;
      }
    }
    subsetSize += 1;
    if (subsetSize > removableComponents.length) {
      exhausted = true;
      return;
    }
    subsetIndexes = Array.from({ length: subsetSize }, (_, index) => index);
  };

  return {
    get termination(): SearchRun['termination'] {
      return termination;
    },
    next(): BoundaryFallbackOption | null {
      if (exhausted) return null;
      if (bounds.clock() >= bounds.deadline) {
        termination = 'deadline';
        exhausted = true;
        return null;
      }
      if (budget.remainingIterations <= 0) {
        termination = 'iteration-cap';
        exhausted = true;
        return null;
      }
      budget.remainingIterations -= 1;
      const deferredIds = new Set<string>();
      for (const index of subsetIndexes) {
        for (const id of removableComponents[index]) deferredIds.add(id);
      }
      advance();
      return fallbackOptionForDeferredIds(admitted, deferredIds);
    },
  };
}

interface EvaluatedBoundaryFallback {
  option: BoundaryFallbackOption;
  run: SearchRun;
  continuation?: SearchRun;
  candidate: DueDateCandidate;
}

/** A final-boundary fallback can be scored only after its deferred work has
 * been evaluated from the firmed order's outgoing state. Rebuild its complete
 * free-order candidate from actual patches so partially admitted pre-firmed
 * work is not counted twice in policy or admitted-work scoring. */
function completeFinalBoundaryCandidate(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  tasksById: ReadonlyMap<string, NimbusTask>,
  preFirmed: DueDateCandidate,
  continuation: DueDateCandidate,
): DueDateCandidate {
  const patches = [...preFirmed.patches, ...continuation.patches];
  const orderedTasks = patches.map(patch => tasksById.get(patch.id)!);
  const joinKey = (left: string, right: string): string => (
    left && right ? `${left}\u0000${right}` : left || right
  );
  return {
    feasible: true,
    patches,
    score: [
      0,
      policyScore(snapshot, bounds.setup.plant, line, orderedTasks, bounds.runContext),
      (preFirmed.score[2] ?? 0) + (continuation.score[2] ?? 0),
      (preFirmed.score[3] ?? 0) + (continuation.score[3] ?? 0),
      -patches.length,
      (preFirmed.score[5] ?? 0) + (continuation.score[5] ?? 0),
      // A2: sum both halves' uncovered-edge counts — required, since
      // compareBoundaryFallback routes through compareCandidate, which reads
      // score[SCORE_UNCOVERED] directly.
      (preFirmed.score[SCORE_UNCOVERED] ?? 0) + (continuation.score[SCORE_UNCOVERED] ?? 0),
      // Due-date push-forward limit: sum both halves' over-cap counts for the
      // same reason — compareCandidate reads score[SCORE_OVER_CAP] directly,
      // and it is compared even earlier than score[SCORE_UNCOVERED] above.
      (preFirmed.score[SCORE_OVER_CAP] ?? 0) + (continuation.score[SCORE_OVER_CAP] ?? 0),
    ],
    policyKey: policyKeyForSequence(snapshot, bounds.setup.plant, line, orderedTasks, bounds.runContext),
    sequenceKey: joinKey(preFirmed.patches.map(patch => patch.id).join('|'), continuation.patches.map(patch => patch.id).join('|')),
    unadmitted: [],
    explanation: [...preFirmed.explanation, ...continuation.explanation],
    missingEdges: [...preFirmed.missingEdges, ...continuation.missingEdges],
  };
}

/** Final-boundary alternatives represent complete candidates, so they use the
 * same immutable lexicographic comparison as normal Due-date-first search.
 * The deferred-id key is only a deterministic tie-break after that
 * comparison. `mode` is forwarded to `compareCandidate` (2026-09-09, due-date
 * mode) so a terminal-boundary fallback comparison for `'due-date'` uses
 * `compareDueDateCandidate` too, instead of always defaulting to
 * `'due-date-first'`'s tier order. */
function compareBoundaryFallback(
  left: Readonly<EvaluatedBoundaryFallback>, right: Readonly<EvaluatedBoundaryFallback>, mode: FragmentMode,
): number {
  const candidateDelta = compareCandidate(left.candidate, right.candidate, mode);
  if (candidateDelta) return candidateDelta;
  return left.option.deferred.map(taskId).join('\u0000').localeCompare(right.option.deferred.map(taskId).join('\u0000'));
}

export interface UnknownTailPlacement {
  patches: SchedulePatch[];
  explanation: CandidateReason[];
  /** Orders that could not be placed within `[start, capacityEnd)`. They
   * defer like covered overflow work — to the next fragment, or (in the
   * trailing fragment / whole-line fallback) stay at their current dates
   * with a diagnostic rather than freezing the line. */
  unadmitted: NimbusTask[];
  /** One `'scheduled-without-setup'` edge per order actually placed by this
   * call (F1) — read by the live run and OptimizerPreview to report orders
   * "scheduled without a changeover bar". Since A1, `candidateForSequence`'s
   * in-sequence admission of a known-but-uncovered transition also emits this
   * same reason directly (never via this tail-placement call), so this is no
   * longer the only producer — just the tail-placement one. */
  missingEdges: MissingSetupEdge[];
}

/**
 * Place unknown/uncovered orders at the tail of a fragment, strictly after
 * its covered core (Part 1c). Setup is charged as zero minutes purely as a
 * `placeWithSetup` placement mechanism — never a real changeover, and never
 * added to `score[5]`/setupMinutes — so no fake bar is ever charged for a
 * transition nobody actually knows. Capacity, the split policy, and
 * `bounds.notBefore` are the real, unmodified mechanisms used elsewhere.
 *
 * Note (F10): this function does not contribute to `score[2]`/`score[3]`
 * (lateness) either — those tiers are diagnostics-fidelity only within
 * `DueDateCandidate`/the min-changeover objective, not read back from the
 * applied schedule. This is safe because every caller re-derives real
 * lateness from the fully applied patches afterward (see
 * `evaluateMinChangeover`'s `lateOrderFacts(applyPatchesToSnapshot(...))`),
 * so a tail placement's lateness is never silently lost — it just isn't
 * double-counted into this candidate's own score vector.
 */
export function placeUnknownTail(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  tasks: ReadonlyArray<NimbusTask>,
  start: Date,
  capacityEnd: Date,
  mode: FragmentMode,
  // The covered core's actual final predecessor (or the previous tail
  // fragment's last placed order), used only to label the `missingEdges`
  // this call emits (F1) — never consumed by the zero-minute placement
  // mechanism above, which is state-agnostic by design.
  initialPredecessorOrderId: string | null = null,
): UnknownTailPlacement {
  const ordered = mode === 'spt'
    ? urgencyOrder(snapshot, bounds, line, tasks)
    : mode === 'due-date'
      ? orderedByDueThenPolicy(snapshot, bounds.setup.plant, line, tasks, bounds.runContext)
      : orderedByPolicyThenDue(snapshot, bounds.setup.plant, line, tasks, bounds.runContext);
  const splitPolicy = bounds.runContext?.splitOrderPolicy ?? splitOrderPolicyForSnapshot(snapshot, bounds.setup.plant);
  const patches: SchedulePatch[] = [];
  const explanation: CandidateReason[] = [];
  const missingEdges: MissingSetupEdge[] = [];
  let cursor = new Date(start);
  let previousOrderId = initialPredecessorOrderId;
  const deferred: NimbusTask[] = [];
  // Phase 1.5 tail-pass valve: once wall-clock time has overrun the run's
  // deadline by more than SETUP_AWARE_TAIL_OVERRUN_MS, stop ATTEMPTING
  // placement altogether — time-based only, never gated on iteration budget
  // — and route every remaining order through the same
  // 'unknown-setup-tail-unplaced' diagnostic shape used below, so the
  // never-freeze invariant's diagnostics stay intact (retained at current
  // dates, never dropped silently).
  const hardStop = bounds.deadline + SETUP_AWARE_TAIL_OVERRUN_MS;

  for (let index = 0; index < ordered.length; index += 1) {
    if (bounds.clock() >= hardStop) {
      for (const remainingTask of ordered.slice(index)) {
        deferred.push(remainingTask);
        explanation.push({
          code: 'unknown-setup-tail-unplaced',
          message: `Deferred ${taskId(remainingTask)}: tail placement stopped after overrunning the search deadline.`,
          line,
          taskId: taskId(remainingTask),
        });
      }
      break;
    }
    const task = ordered[index];
    // B2: once the cursor has reached the fragment's own capacity end there
    // is no window left for ANY remaining order (a shorter order behind a
    // long one has already had its chance), so stop attempting placement —
    // but still record every remaining order as deferred rather than
    // returning early, so callers keep seeing the accurate unplaced set.
    if (cursor >= capacityEnd) {
      for (const remainingTask of ordered.slice(index)) {
        deferred.push(remainingTask);
        explanation.push({
          code: 'unknown-setup-tail-unplaced',
          message: `Deferred ${taskId(remainingTask)}: no tail capacity remained in the horizon.`,
          line,
          taskId: taskId(remainingTask),
        });
      }
      break;
    }
    if (planningDefect(snapshot, bounds, task)) { deferred.push(task); continue; }
    const priorCursor = new Date(cursor);
    const pullForwardFloor = notBeforeFor(bounds, task);
    if (pullForwardFloor && cursor < pullForwardFloor) cursor = new Date(pullForwardFloor);
    const runtimeMinutes = Math.round(Number(task.RUN_TIME) * 60);
    const placement = placeWithSetup({
      earliestStart: cursor,
      runtimeMinutes,
      setup: { kind: 'resolved', minutes: 0 },
      policy: splitPolicy,
      ...(splitPolicy === 'overlong_only' ? {
        isInherentlyOverlong: !hasNominalWindow(snapshot, line, bounds.setup.plant, cursor, runtimeMinutes, bounds.runContext),
      } : {}),
      freeIntervals: freeIntervalsFor(snapshot, line, bounds.setup.plant, cursor, completionEnd(bounds, task, capacityEnd), bounds.runContext),
      minProductiveSegmentMinutes: bounds.runContext?.minProductiveSegmentMinutes
        ?? minProductiveSegmentMinutesForSnapshot(snapshot, bounds.setup.plant),
    });
    if (placement.kind !== 'placed' || !placement.productiveSegments.length) {
      // B2: this order alone doesn't fit at the current cursor — defer it
      // and continue, rather than abandoning every order behind it. Failure
      // here is length-dependent (a long runtime can fail where a shorter
      // one behind it would fit), so cursor/previousOrderId intentionally do
      // not advance past a deferred order.
      deferred.push(task);
      cursor = priorCursor;
      // B3a: an invalid RUN_TIME is a data defect, not a capacity shortfall —
      // say so rather than reporting it as "no capacity" alongside genuine
      // capacity exhaustion.
      explanation.push({
        code: 'unknown-setup-tail-unplaced',
        message: placement.kind === 'infeasible' && placement.reason === 'invalid-runtime'
          ? `Deferred ${taskId(task)}: has an invalid RUN_TIME (missing, zero, or negative) — a data defect, not a capacity shortfall.`
          : `Deferred ${taskId(task)}: no remaining tail capacity fit its runtime.`,
        line,
        taskId: taskId(task),
      });
      continue;
    }
    const first = placement.productiveSegments[0];
    const last = placement.productiveSegments.at(-1)!;
    patches.push({
      id: taskId(task),
      changes: {
        start_date: new Date(first.start),
        end_date: new Date(last.end),
        scheduleSegments: placement.productiveSegments.length > 1
          ? placement.productiveSegments.map((segment, segIndex) => ({
            sequence: segIndex + 1, startDate: new Date(segment.start), endDate: new Date(segment.end),
          }))
          : [],
      },
    });
    explanation.push({
      code: 'unknown-setup-tail-placement',
      message: `Placed ${taskId(task)} at the tail without a changeover bar; setup data is missing or uncovered.`,
      line,
      taskId: taskId(task),
    });
    // Dedicated reason (F1) so the live-run toast and OptimizerPreview's tally
    // can count exactly the orders actually scheduled without setup — never
    // conflated with a rejected-permutation `UNCOVERED_SETUP_TRANSITION_REASON`
    // edge that may happen to name the same id. Since A1, `candidateForSequence`
    // also emits this exact reason for a known-but-uncovered in-sequence
    // admission — this tail call is one of two producers, not the only one.
    missingEdges.push({ line, predecessorOrderId: previousOrderId, successorOrderId: taskId(task), reason: 'scheduled-without-setup' });
    previousOrderId = taskId(task);
    cursor = new Date(last.end);
  }
  return { patches, explanation, unadmitted: deferred, missingEdges };
}

/** The incoming setup a covered core reserved before a firmed boundary stays
 * authoritative (Part 1c): tail capacity for the same fragment must end at
 * that reservation's start, never inside it. Re-derives the same reservation
 * `candidateForSequence` already validated, from the covered core's actual
 * final predecessor rather than the fragment's original one. An unknown
 * final predecessor state means the reservation itself cannot be computed —
 * the firmed order's own incoming setup then also becomes a diagnostic
 * further downstream, and tail capacity simply runs to the boundary. */
function tailCapacityEnd(
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  fragmentEnd: Date,
  nextFirmed: FirmedBoundary | undefined,
  finalState: SetupStateKey | null,
  finalPredecessorOrderId: string | null,
): Date {
  // A null `nextFirmed.state` (never-freeze widening) means the boundary's
  // own setup state is unresolvable — there is nothing to reserve minutes
  // against, so tail capacity simply runs to the boundary's start.
  if (!nextFirmed || finalState === null || nextFirmed.state === null) return fragmentEnd;
  const definition = bounds.setup.definition!;
  const resolved = resolveSetup({
    definition,
    machine: line,
    predecessorState: finalState,
    successorState: nextFirmed.state,
    predecessorOrderId: finalPredecessorOrderId,
    successorOrderId: taskId(nextFirmed.task),
    plantRows: bounds.setup.plant_rows,
    machineRows: bounds.setup.machine_rows,
    overrides: bounds.setup.overrides,
    index: bounds.runContext?.resolutionIndex ?? undefined,
  });
  const reserveMinutes = resolved.covered && resolved.effectiveMin !== null ? resolved.effectiveMin : 0;
  return new Date(nextFirmed.start.getTime() - reserveMinutes * 60 * 1000);
}

/** Cursor to start tail placement from: the covered core's last placed
 * order, or the fragment start when the core is empty. */
function tailCursorFor(candidate: Readonly<DueDateCandidate> | null, fallbackStart: Date): Date {
  const end = candidate?.patches.at(-1)?.changes.end_date;
  return end instanceof Date ? new Date(end) : new Date(fallbackStart);
}

/** Place unknown-tail orders and merge the result directly into the
 * caller's accumulators, mirroring `applyCandidate`'s merge shape. */
function applyUnknownTail(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  mode: FragmentMode,
  tasks: ReadonlyArray<NimbusTask>,
  start: Date,
  capacityEnd: Date,
  patches: SchedulePatch[],
  explanation: CandidateReason[],
  missingEdges: MissingSetupEdge[],
  initialPredecessorOrderId: string | null = null,
): NimbusTask[] {
  if (!tasks.length) return [];
  const placement = placeUnknownTail(snapshot, bounds, line, tasks, start, capacityEnd, mode, initialPredecessorOrderId);
  patches.push(...placement.patches);
  explanation.push(...placement.explanation);
  missingEdges.push(...placement.missingEdges);
  return placement.unadmitted;
}

/**
 * Whole-line fallback (Part 1e) for a line that cannot be evaluated as
 * setup-aware at all — no compatible setup definition, or the line is
 * explicitly `setup_compatible === false`. Free orders are still placed
 * (policy-then-due or SPT order, zero setup capacity) around whatever firmed
 * orders exist, rather than skipping the line; overflow at the very end
 * stays at its current dates with a diagnostic.
 */
function placeWholeLineAsTail(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  tasks: ReadonlyArray<NimbusTask>,
  mode: FragmentMode,
): { patches: SchedulePatch[]; explanation: CandidateReason[]; missingEdges: MissingSetupEdge[] } {
  const free = tasks.filter(task => !taskIsFirmed(snapshot, task));
  const firmedWindows = tasks
    .filter(task => taskIsFirmed(snapshot, task))
    .flatMap(task => {
      const start = timestamp(task.start_date);
      const end = timestamp(task.end_date);
      return start && end && end > start && start <= bounds.horizonEnd ? [{ start, end }] : [];
    })
    .sort((left, right) => left.start.getTime() - right.start.getTime());

  const patches: SchedulePatch[] = [];
  const explanation: CandidateReason[] = [];
  const missingEdges: MissingSetupEdge[] = [];
  let remaining = free;
  let cursor = new Date(bounds.now);
  // Track the last order actually placed by this function's own tail calls —
  // there is no covered core here, so this is the only predecessor chain
  // `missingEdges` (F1) has to work with across firmed windows.
  let previousOrderId: string | null = null;
  // Phase 1.5 tail-pass valve: once overrun, skip attempting placement for
  // every remaining firmed-window gap entirely — `placeUnknownTail` itself
  // enforces the same hard stop, but checking here too avoids repeatedly
  // re-entering it (and re-emitting the same per-order diagnostic) once
  // there's nothing left to attempt. Whatever stays in `remaining` still
  // flows through the 'unknown-setup-tail-unplaced' loop below.
  const hardStop = bounds.deadline + SETUP_AWARE_TAIL_OVERRUN_MS;
  for (const window of firmedWindows) {
    if (remaining.length && cursor < window.start && bounds.clock() < hardStop) {
      remaining = applyUnknownTail(
        snapshot, bounds, line, mode, remaining, cursor, window.start, patches, explanation, missingEdges, previousOrderId,
      );
      if (patches.length) previousOrderId = String(patches.at(-1)!.id);
    }
    if (window.end > cursor) cursor = new Date(window.end);
  }
  if (remaining.length && bounds.clock() < hardStop) {
    remaining = applyUnknownTail(
      snapshot, bounds, line, mode, remaining, cursor, bounds.horizonEnd, patches, explanation, missingEdges, previousOrderId,
    );
  }
  for (const task of remaining) {
    explanation.push({
      code: 'unknown-setup-tail-unplaced',
      message: `Left ${taskId(task)} at its current dates; no remaining capacity for tail placement.`,
      line,
      taskId: taskId(task),
    });
  }
  return { patches, explanation, missingEdges };
}

function evaluateLineWithFirmedBoundaries(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  tasks: ReadonlyArray<NimbusTask>,
  initialState: SetupStateKey | null,
  initial: Readonly<LineInitialContext>,
  budget: SearchBudget,
  mode: FragmentMode = 'due-date-first',
): LineSearchResult {
  const definition = bounds.setup.definition!;
  const lineOrderIds = new Set(initial.allTasks.map(taskId));
  const missingSuccessorEdges = missingSuccessorOverrideEdges(bounds, line, initial.allTasks);
  const missingPredecessorEdges = missingPredecessorOverrideEdges(bounds, line, initial.allTasks);
  const initialEdges = initial.preservedAnchor ? [unknownInitialStateEdge(line, initial.preservedAnchor.task)] : [];
  const initialReasons = initial.preservedAnchor ? [unknownInitialStateReason(line, initial.preservedAnchor.task)] : [];
  const preservedAnchorEdges = preservedAnchorOverrideEdges(bounds, line, initial.preservedAnchor);
  const ordinaryBaseMissingEdges = [
    ...initialEdges,
    ...missingSuccessorEdges,
    ...missingPredecessorEdges,
    ...preservedAnchorEdges,
  ];
  const postHorizonOverrideAudit = auditOutOfHorizonFirmedOverrides(
    snapshot, bounds, line, initialState, initial,
  );
  const ordinaryEdgeKeys = new Set(ordinaryBaseMissingEdges.map(missingEdgeKey));
  const additionalInactivePostHorizonEdges = postHorizonOverrideAudit.inactiveEdges.filter(edge => (
    !ordinaryEdgeKeys.has(missingEdgeKey(edge))
  ));
  const baseMissingEdges = [...ordinaryBaseMissingEdges, ...additionalInactivePostHorizonEdges];
  const baseExplanation = [
    ...initialReasons,
    ...missingSuccessorOverrideReasons(line, missingSuccessorEdges),
    ...missingPredecessorOverrideReasons(line, missingPredecessorEdges),
    ...missingPredecessorOverrideReasons(line, preservedAnchorEdges),
    ...inactiveOutOfHorizonFirmedOverrideReasons(line, additionalInactivePostHorizonEdges),
  ];
  if (postHorizonOverrideAudit.protectedEdges.length) {
    return unchangedLineResult(
      line,
      PROTECTED_FIRMED_BOUNDARY_OUTSIDE_HORIZON_REASON,
      'An active firmed-boundary override cannot be preserved inside the caller scheduling horizon.',
      [...baseMissingEdges, ...postHorizonOverrideAudit.protectedEdges],
      [...baseExplanation, ...protectedOutOfHorizonFirmedBoundaryReasons(line, postHorizonOverrideAudit.protectedEdges)],
    );
  }
  const firmed: FirmedBoundary[] = [];
  for (const task of tasks.filter(task => taskIsFirmed(snapshot, task))) {
    const start = timestamp(task.start_date);
    const end = timestamp(task.end_date);
    // An equal-start firmed run remains the terminal incoming boundary: its
    // setup can still occupy time inside the caller horizon. Strictly later
    // unprotected runs cannot lend capacity to this detached candidate.
    if (start && start > bounds.horizonEnd) continue;
    if (!start || !end || end <= start) {
      // Never-freeze (e24b12b follow-up): an unusable interval cannot become
      // a boundary at all — an in-progress/SAP-firmed order can legitimately
      // have odd interval data. Skip it as a boundary rather than freezing
      // every other order on the line; it stays excluded from `free` via
      // `taskIsFirmed` above and keeps its own current dates either way.
      baseMissingEdges.push({ line, successorOrderId: taskId(task), reason: 'firmed-boundary-invalid' });
      baseExplanation.push({
        code: 'firmed-boundary-invalid',
        message: `Firmed order ${taskId(task)} lacks a usable interval; skipped as a boundary.`,
        line,
        taskId: taskId(task),
      });
      continue;
    }
    const state = orderState(bounds, task, definition);
    if (state === null) {
      // Never-freeze: an unresolvable setup state (e.g. a blank signature
      // under strict_blanks) still occupies a real, valid interval — admit
      // it as an opaque time block rather than freezing the line.
      baseMissingEdges.push(unknownInitialStateEdge(line, task));
      baseExplanation.push({
        code: 'firmed-boundary-state-unknown',
        message: `Firmed order ${taskId(task)} has an unresolvable setup state; treated as an opaque time block.`,
        line,
        taskId: taskId(task),
      });
    }
    firmed.push({ task, state, start, end });
  }
  firmed.sort((left, right) => left.start.getTime() - right.start.getTime() || taskId(left.task).localeCompare(taskId(right.task)));

  const free = tasks.filter(task => !taskIsFirmed(snapshot, task));
  const locks = boundaryOverrideLocks(bounds, line, firmed, free, initialState, initial.predecessorOrderId);
  const initialFreeLock = initialFreeOverrideLock(
    bounds, line, free, initialState, initial.predecessorOrderId,
  );
  if (initialFreeLock.issue) {
    return unchangedLineResult(
      line,
      'override-inactive',
      'An active occurrence override no longer matches the persisted initial state.',
      [...baseMissingEdges, initialFreeLock.issue],
      baseExplanation,
    );
  }
  if (initialFreeLock.requiredFirstOrderId
    && firmed.length
    && locks.get(taskId(firmed[0].task))?.requiresInitialState) {
    return unchangedLineResult(
      line,
      'override-inactive',
      'Multiple active overrides claim the persisted initial state.',
      [
        ...baseMissingEdges,
        inactiveOverrideEdge(line, initial.predecessorOrderId, initialFreeLock.requiredFirstOrderId),
      ],
      baseExplanation,
    );
  }
  const freeComponents = freeOverrideComponents(bounds, line, free);
  const freeById = new Map(free.map(task => [taskId(task), task]));
  let remaining = [...free];
  let fragmentStart = new Date(initial.fragmentStart);
  let predecessorState = initialState;
  let predecessorOrderId: string | null = initial.predecessorOrderId;
  let requiredFirstOrderId: string | undefined = initialFreeLock.requiredFirstOrderId;
  const patches: SchedulePatch[] = [];
  const score = zeroScore();
  const explanation: CandidateReason[] = [...baseExplanation];
  const missingEdges: MissingSetupEdge[] = [...baseMissingEdges];
  let candidateCount = 0;
  let method: LineSearchResult['method'] = 'due-date-first-exact';
  let termination: SearchRun['termination'] = 'completed';

  const recordRun = (run: Readonly<SearchRun>): void => {
    candidateCount += run.candidateCount;
    if (run.method === 'due-date-first-greedy') method = run.method;
    termination = worseTermination(termination, run.termination);
  };
  const applyCandidate = (candidate: Readonly<DueDateCandidate>): DueDateCandidate => {
    patches.push(...candidate.patches);
    explanation.push(...candidate.explanation);
    for (let index = 0; index < score.length; index += 1) score[index] += candidate.score[index] ?? 0;
    // A3: without this, a winner's own 'scheduled-without-setup' edges (A1's
    // in-sequence admission) never escape candidateForSequence — they'd stay
    // trapped in this local `candidate` and never reach `run.missingEdges`,
    // so neither the live-run toast nor OptimizerPreview's tally would ever
    // see these orders. Filtered to that one reason so we don't newly leak
    // 'initial-state-unknown' / 'incoming-firmed-setup-infeasible' winner
    // edges (already-existing, differently-consumed diagnostics) into every
    // line result.
    missingEdges.push(...candidate.missingEdges.filter(edge => edge.reason === 'scheduled-without-setup'));
    return candidate;
  };
  const applyWinner = (run: Readonly<SearchRun>): DueDateCandidate => {
    const candidate = run.winner!;
    if (mode === 'due-date-first') {
      appendRejectedCoverageDiagnostics(missingEdges, explanation, run.missingEdges, winnerEdgeKeySet(candidate));
    }
    return applyCandidate(candidate);
  };
  const accept = (run: SearchRun, retainFailureDiagnostics = true): DueDateCandidate | null => {
    recordRun(run);
    if (!run.winner) {
      if (retainFailureDiagnostics) missingEdges.push(...run.missingEdges);
      return null;
    }
    return applyWinner(run);
  };

  // Monotone-cursor union bookkeeping (never-freeze, e24b12b follow-up): an
  // SAP ECC-firmed order folded into `firmedIds` may already be in progress
  // or fully in the past, so its boundary can legitimately start at or
  // before `fragmentStart`. Tracks the latest boundary END actually adopted
  // as a predecessor so a shorter, earlier-ending past run can never
  // overwrite the effective predecessor state established by a later-ending
  // one — the same union model `placeWholeLineAsTail` already uses.
  let lastAdoptedBoundaryEnd = Number.NEGATIVE_INFINITY;

  for (let boundaryIndex = 0; boundaryIndex < firmed.length; boundaryIndex += 1) {
    const boundary = firmed[boundaryIndex];
    // F3: only a fragment before a LATER firmed boundary needs the caller to
    // own arbitration — that is the "cannot legitimately rank two
    // alternatives ahead of later firmed boundaries" scenario the ambiguity
    // guard below exists for. The terminal boundary's local fallback already
    // compares every complete candidate directly (no separate ambiguity
    // guard is needed there), so letting its own per-boundary run resolve
    // coverage via demotion first — exactly like the trailing fragment —
    // is safe and matches every other never-freeze fragment's behavior.
    const isTerminalBoundary = boundaryIndex === firmed.length - 1;
    const boundaryLock = locks.get(taskId(boundary.task));
    if (boundaryLock?.issue) {
      return unchangedLineResult(
        line,
        'override-inactive',
        'An active occurrence override cannot be preserved at this firmed boundary.',
        [...baseMissingEdges, boundaryLock.issue],
        baseExplanation,
      );
    }
    if (boundaryLock?.requiredFirmedPredecessorId
      && predecessorOrderId !== boundaryLock.requiredFirmedPredecessorId) {
      return unchangedLineResult(
        line,
        'override-inactive',
        'An active occurrence override no longer has its bound firmed predecessor.',
        [...baseMissingEdges, {
          line,
          predecessorOrderId,
          successorOrderId: taskId(boundary.task),
          reason: 'override-inactive',
        }],
        baseExplanation,
      );
    }
    if (boundaryLock?.requiresInitialState && predecessorOrderId !== null) {
      return unchangedLineResult(
        line,
        'override-inactive',
        'An active occurrence override no longer has its persisted initial predecessor state.',
        [...baseMissingEdges, {
          line,
          predecessorOrderId,
          successorOrderId: taskId(boundary.task),
          reason: 'override-inactive',
        }],
        baseExplanation,
      );
    }
    if (boundaryLock?.requiresInitialPredecessorId
      && predecessorOrderId !== boundaryLock.requiresInitialPredecessorId) {
      return unchangedLineResult(
        line,
        'override-inactive',
        'An active occurrence override no longer has its preserved first-order predecessor.',
        [...baseMissingEdges, {
          line,
          predecessorOrderId,
          successorOrderId: taskId(boundary.task),
          reason: 'override-inactive',
        }],
        baseExplanation,
      );
    }

    // Never-freeze clamp (e24b12b follow-up): an SAP ECC-firmed order that is
    // already in progress or fully in the past has a boundary that starts at
    // or before the cursor — a zero-width (or negative-width) pre-fragment
    // that needs no search at all. Every override-lock check above already
    // ran and would have failed closed on a genuine conflict; anything else
    // is folded into the cursor via the same monotone-union model
    // `placeWholeLineAsTail` uses, instead of freezing the whole line.
    if (boundary.start.getTime() <= fragmentStart.getTime()) {
      if (boundary.end.getTime() > fragmentStart.getTime()) {
        // Spanning: the boundary's run still occupies time ahead of the
        // cursor (in progress) — jump the cursor to its end and adopt it as
        // the predecessor for whatever comes next.
        fragmentStart = new Date(boundary.end);
        predecessorState = boundary.state;
        predecessorOrderId = taskId(boundary.task);
        lastAdoptedBoundaryEnd = Math.max(lastAdoptedBoundaryEnd, boundary.end.getTime());
      } else if (boundary.end.getTime() > lastAdoptedBoundaryEnd) {
        // Fully past: the cursor does not move, but the latest-ENDING past
        // run defines the effective predecessor state for what comes next —
        // an earlier-ending past run must not overwrite a later one.
        predecessorState = boundary.state;
        predecessorOrderId = taskId(boundary.task);
        lastAdoptedBoundaryEnd = boundary.end.getTime();
      }
      requiredFirstOrderId = boundaryLock?.requiredFirstOrderId;
      explanation.push({
        code: 'firmed-boundary-elapsed',
        message: `Firmed ${taskId(boundary.task)} has already elapsed or is in progress; adopted as predecessor without a search fragment.`,
        line,
        taskId: taskId(boundary.task),
      });
      continue;
    }

    const reservedForAnotherBoundary = new Set<string>();
    for (let futureIndex = boundaryIndex; futureIndex < firmed.length; futureIndex += 1) {
      const futureLock = locks.get(taskId(firmed[futureIndex].task));
      if (futureLock?.requiredFirstOrderId) reservedForAnotherBoundary.add(futureLock.requiredFirstOrderId);
      if (futureLock?.requiredLastOrderId && futureIndex !== boundaryIndex) {
        reservedForAnotherBoundary.add(futureLock.requiredLastOrderId);
      }
    }
    if (requiredFirstOrderId) reservedForAnotherBoundary.delete(requiredFirstOrderId);

    let componentConflict: MissingSetupEdge | null = null;
    const admitted = boundaryLock?.requiresInitialState
      || boundaryLock?.requiresInitialPredecessorId
      || boundaryLock?.requiredFirmedPredecessorId
      ? []
      : remaining.filter(task => {
        const id = taskId(task);
        const component = freeComponents.get(id) ?? new Set([id]);
        const members = [...component];
        const needsThisFragment = members.some(member => (
          member === requiredFirstOrderId || member === boundaryLock?.requiredLastOrderId
        ));
        const reservedForFutureFragment = members.some(member => reservedForAnotherBoundary.has(member));
        if (needsThisFragment && reservedForFutureFragment) {
          if (!componentConflict) {
            componentConflict = inactiveOverrideEdge(
              line,
              members.find(member => member === requiredFirstOrderId || member === boundaryLock?.requiredLastOrderId),
              members.find(member => reservedForAnotherBoundary.has(member)),
            );
          }
          return false;
        }
        if (needsThisFragment) return true;
        if (reservedForFutureFragment) return false;
        return members.some(member => belongsBeforeFirmedBoundary(freeById.get(member)!, boundary, mode));
      });
    if (componentConflict) {
      return unchangedLineResult(
        line,
        'override-inactive',
        'An active occurrence override cannot remain adjacent across firmed boundaries.',
        [...baseMissingEdges, componentConflict],
        baseExplanation,
      );
    }
    const admittedIds = new Set(admitted.map(taskId));
    const later = remaining.filter(task => !admittedIds.has(taskId(task)));
    const fragment: FragmentContext = {
      start: fragmentStart,
      end: boundary.start,
      predecessorState,
      predecessorOrderId,
      lineOrderIds,
      allowsDeletedPredecessorBinding: initial.preservedAnchor !== undefined,
      nextFirmed: boundary,
      requiredFirstOrderId,
      requiredLastOrderId: boundaryLock?.requiredLastOrderId,
    };
    const run = searchFragment(snapshot, bounds, line, admitted, fragment, budget, mode);
    // A failed pre-firmed sequence may still have a fully covered route after
    // the firmed run. Search bounded whole-component deferrals under the same
    // shared budget; the rejected edge stays visible when a later route wins.
    let winner = accept(run, false);
    // Tracks whichever run's unknown-tail set actually corresponds to the
    // admitted batch that produced `winner` (Part 1c) — the plain run, or
    // whichever fallback run below replaces it.
    let tailSource: ReadonlyArray<NimbusTask> = run.unknownTail;
    let deferredAcrossFirmed: NimbusTask[] = [];
    const fallbackRuns: SearchRun[] = [];
    const continuationRuns: SearchRun[] = [];
    if (!winner && run.termination === 'completed' && supportsBoundaryFallback(run)) {
      if (mode === 'spt') {
        // SPT retains its established deterministic suffix fallback: productive
        // runtime selected this order already, so coverage must not become a
        // hidden alternate-order comparator.
        const fallbackOptions = sptBoundaryFallbackOptions(
          snapshot, bounds, line, admitted, fragment, freeComponents,
        );
        for (const option of fallbackOptions) {
          const fallbackRun = searchFragment(snapshot, bounds, line, option.retained, fragment, budget, mode);
          fallbackRuns.push(fallbackRun);
          recordRun(fallbackRun);
          if (fallbackRun.winner) {
            winner = applyWinner(fallbackRun);
            tailSource = fallbackRun.unknownTail;
            deferredAcrossFirmed = option.deferred;
            missingEdges.push(...run.missingEdges);
            explanation.push({
              code: 'covered-firmed-boundary-fallback',
              message: `Deferred ${deferredAcrossFirmed.length} order(s) past firmed ${taskId(boundary.task)} to preserve a covered firmed boundary.`,
              line,
              taskId: taskId(boundary.task),
            });
            break;
          }
          if (fallbackRun.termination !== 'completed') break;
        }
      } else if (isTerminalBoundary) {
        // Only the terminal firmed boundary can be compared locally without
        // changing planner architecture: each option is extended through the
        // one remaining free fragment, yielding a complete candidate.
        const completeFallbacks: EvaluatedBoundaryFallback[] = [];
        const fallbackCursor = dueDateBoundaryFallbackCursor(
          snapshot, bounds, line, admitted, fragment, freeComponents, budget, mode,
        );
        let completeEnumeration = true;
        for (let option = fallbackCursor.next(); option; option = fallbackCursor.next()) {
          const fallbackRun = searchFragment(snapshot, bounds, line, option.retained, fragment, budget, mode);
          fallbackRuns.push(fallbackRun);
          recordRun(fallbackRun);
          // A converged run (Phase 1e) reached a real, trustworthy winner —
          // it must not be mistaken for an enumeration cut short by
          // 'deadline'/'iteration-cap' and discarded (Critical fix).
          if (!isSearchConclusive(fallbackRun.termination)) {
            completeEnumeration = false;
            break;
          }
          if (!fallbackRun.winner) continue;
          const continuation = searchFragment(snapshot, bounds, line, [
            ...fallbackRun.winner.unadmitted,
            ...option.deferred,
            ...later,
          ], {
            start: boundary.end,
            end: bounds.horizonEnd,
            predecessorState: boundary.state,
            predecessorOrderId: taskId(boundary.task),
            lineOrderIds,
            allowsDeletedPredecessorBinding: initial.preservedAnchor !== undefined,
            requiredFirstOrderId: boundaryLock?.requiredFirstOrderId,
          }, budget, mode);
          continuationRuns.push(continuation);
          recordRun(continuation);
          if (!isSearchConclusive(continuation.termination)) {
            completeEnumeration = false;
            break;
          }
          if (!continuation.winner || continuation.winner.unadmitted.length) continue;
          completeFallbacks.push({
            option,
            run: fallbackRun,
            continuation,
            candidate: completeFinalBoundaryCandidate(
              snapshot, bounds, line, freeById, fallbackRun.winner, continuation.winner,
            ),
          });
        }
        if (fallbackCursor.termination !== 'completed') {
          completeEnumeration = false;
          termination = worseTermination(termination, fallbackCursor.termination);
        }
        if (!completeEnumeration) {
          missingEdges.push(
            ...run.missingEdges,
            ...fallbackRuns.flatMap(fallbackRun => fallbackRun.missingEdges),
            ...continuationRuns.flatMap(continuation => continuation.missingEdges),
          );
          // Suppressed for 'due-date' (2026-09-09): see appendRejectedCoverageDiagnostics's precondition comment.
          if (mode !== 'due-date') appendRejectedCoverageDiagnostics(missingEdges, explanation, run.missingEdges);
          explanation.push({
            code: 'firmed-boundary-fallback-ambiguous',
            message: `The bounded fallback search could not compare every route around firmed ${taskId(boundary.task)}.`,
            line,
            taskId: taskId(boundary.task),
          });
          // A7: this was the only failure path that returned `unchanged: true`
          // with no tail placement — genuine ambiguity about which covered
          // route to pick is not a reason to leave the orders unscheduled.
          // Same never-freeze treatment as every other non-override failure:
          // tail-place the fragment up to this boundary's reserved incoming
          // setup and continue, keeping the explanation above so the reason
          // stays visible. Override conflicts still fail closed (unaffected —
          // this branch is only reached when `supportsBoundaryFallback(run)`
          // already excluded 'override-inactive' edges).
          const tailEnd = tailCapacityEnd(bounds, line, boundary.start, boundary, predecessorState, predecessorOrderId);
          const tailUnadmitted = applyUnknownTail(
            snapshot, bounds, line, mode, admitted, fragmentStart, tailEnd, patches, explanation, missingEdges,
            predecessorOrderId,
          );
          remaining = [...tailUnadmitted, ...later];
          fragmentStart = new Date(boundary.end);
          predecessorState = boundary.state;
          predecessorOrderId = taskId(boundary.task);
          requiredFirstOrderId = boundaryLock?.requiredFirstOrderId;
          continue;
        }
        let selectedFallback: EvaluatedBoundaryFallback | null = null;
        // Historically this fallback comparison always ran with the implicit
        // 'due-date-first' default (compareCandidate called with no mode arg)
        // regardless of the outer mode — 'min-changeover' ([2,3,5,4]) and
        // 'throughput' ([5,2,3,4]) must keep getting that same
        // 'due-date-first' ([2,3,4,5]) terminal-boundary comparison, byte-
        // identical to before this file introduced 'due-date'. Only 'due-date'
        // itself opts into its own comparator (compareDueDateCandidate) here.
        const fallbackCompareMode = mode === 'due-date' ? 'due-date' : 'due-date-first';
        for (const candidate of completeFallbacks) {
          if (!selectedFallback || compareBoundaryFallback(candidate, selectedFallback, fallbackCompareMode) < 0) {
            selectedFallback = candidate;
          }
        }
        if (selectedFallback) {
          missingEdges.push(...run.missingEdges);
          // Suppressed for 'due-date' (2026-09-09): see appendRejectedCoverageDiagnostics's precondition comment.
          if (mode !== 'due-date') {
            const selectedFallbackEdgeKeys = winnerEdgeKeySet(selectedFallback.candidate);
            appendRejectedCoverageDiagnostics(missingEdges, explanation, run.missingEdges, selectedFallbackEdgeKeys);
            appendRejectedCoverageDiagnostics(missingEdges, explanation, selectedFallback.run.missingEdges, selectedFallbackEdgeKeys);
            appendRejectedCoverageDiagnostics(missingEdges, explanation, selectedFallback.continuation!.missingEdges, selectedFallbackEdgeKeys);
          }
          applyCandidate(selectedFallback.candidate);
          explanation.push({
            code: 'covered-firmed-boundary-fallback',
            message: `Deferred ${selectedFallback.option.deferred.length} order(s) past firmed ${taskId(boundary.task)} to preserve a covered firmed boundary.`,
            line,
            taskId: taskId(boundary.task),
          });
          // This complete candidate already spans the firmed boundary through
          // to the horizon end (Part 1c): place each half's unknown tail
          // against its own capacity — the pre-firmed half up to firmed's
          // reserved incoming setup, the continuation half up to the
          // horizon, since there is no further fragment to defer to.
          const preFirmedTailUnadmitted = applyUnknownTail(
            snapshot, bounds, line, mode, selectedFallback.run.unknownTail,
            tailCursorFor(selectedFallback.run.winner, fragmentStart),
            tailCapacityEnd(
              bounds, line, boundary.start, boundary,
              selectedFallback.run.winner!.finalState ?? predecessorState,
              selectedFallback.run.winner!.finalPredecessorOrderId ?? predecessorOrderId,
            ),
            patches, explanation, missingEdges,
            selectedFallback.run.winner!.finalPredecessorOrderId ?? predecessorOrderId,
          );
          const continuationTailUnadmitted = applyUnknownTail(
            snapshot, bounds, line, mode, selectedFallback.continuation!.unknownTail,
            tailCursorFor(selectedFallback.continuation!.winner, boundary.end),
            bounds.horizonEnd,
            patches, explanation, missingEdges,
            selectedFallback.continuation!.winner!.finalPredecessorOrderId ?? taskId(boundary.task),
          );
          for (const task of [...preFirmedTailUnadmitted, ...continuationTailUnadmitted]) {
            explanation.push({
              code: 'unknown-setup-tail-unplaced',
              message: `Left ${taskId(task)} at its current dates; no remaining capacity for tail placement.`,
              line,
              taskId: taskId(task),
            });
          }
          return {
            patches, score, explanation, missingEdges, candidateCount, method, termination, unchanged: false,
          };
        }
      } else {
        // A local pre-firmed fragment cannot legitimately rank two alternatives
        // ahead of later firmed boundaries. Accept the only proven route; when
        // there is more than one (or the shared budget stops enumeration), fail
        // closed instead of inventing a local admission-first objective.
        const feasibleFallbacks: EvaluatedBoundaryFallback[] = [];
        const fallbackCursor = dueDateBoundaryFallbackCursor(
          snapshot, bounds, line, admitted, fragment, freeComponents, budget, mode,
        );
        let completeEnumeration = true;
        for (let option = fallbackCursor.next(); option; option = fallbackCursor.next()) {
          const fallbackRun = searchFragment(snapshot, bounds, line, option.retained, fragment, budget, mode);
          fallbackRuns.push(fallbackRun);
          recordRun(fallbackRun);
          // F3b secondary hardening: only count a route whose incoming
          // reservation into this boundary is genuinely covered — not one
          // merely tolerated by Part 1f's leniency (see
          // `candidateEntersBoundaryUncovered`).
          if (fallbackRun.winner && !candidateEntersBoundaryUncovered(fallbackRun.winner, taskId(boundary.task))) {
            feasibleFallbacks.push({ option, run: fallbackRun, candidate: fallbackRun.winner });
            if (feasibleFallbacks.length > 1) break;
          }
          // A converged run (Phase 1e) reached a real, trustworthy winner —
          // it must not be mistaken for an enumeration cut short by
          // 'deadline'/'iteration-cap' and discarded (Critical fix), which
          // would otherwise wrongly drop even a single-feasible-fallback
          // result below.
          if (!isSearchConclusive(fallbackRun.termination)) {
            completeEnumeration = false;
            break;
          }
        }
        if (fallbackCursor.termination !== 'completed') {
          completeEnumeration = false;
          termination = worseTermination(termination, fallbackCursor.termination);
        }
        if (!completeEnumeration || feasibleFallbacks.length > 1) {
          missingEdges.push(...run.missingEdges, ...fallbackRuns.flatMap(fallbackRun => fallbackRun.missingEdges));
          // Suppressed for 'due-date' (2026-09-09): see appendRejectedCoverageDiagnostics's precondition comment.
          if (mode !== 'due-date') appendRejectedCoverageDiagnostics(missingEdges, explanation, run.missingEdges);
          explanation.push({
            code: 'firmed-boundary-fallback-ambiguous',
            message: completeEnumeration
              ? `Multiple covered fallback routes remain before firmed ${taskId(boundary.task)}; no local route was selected.`
              : `The bounded fallback search could not enumerate every route before firmed ${taskId(boundary.task)}.`,
            line,
            taskId: taskId(boundary.task),
          });
          // A7: same never-freeze treatment as the terminal-boundary branch
          // above — genuine ambiguity about which covered route to pick, or a
          // budget/deadline cutoff mid-enumeration, is not a reason to leave
          // the orders unscheduled. Tail-place and continue instead of
          // returning zero patches with `unchanged: true`.
          const tailEnd = tailCapacityEnd(bounds, line, boundary.start, boundary, predecessorState, predecessorOrderId);
          const tailUnadmitted = applyUnknownTail(
            snapshot, bounds, line, mode, admitted, fragmentStart, tailEnd, patches, explanation, missingEdges,
            predecessorOrderId,
          );
          remaining = [...tailUnadmitted, ...later];
          fragmentStart = new Date(boundary.end);
          predecessorState = boundary.state;
          predecessorOrderId = taskId(boundary.task);
          requiredFirstOrderId = boundaryLock?.requiredFirstOrderId;
          continue;
        }
        if (feasibleFallbacks.length === 1) {
          const selectedFallback = feasibleFallbacks[0];
          winner = applyWinner(selectedFallback.run);
          tailSource = selectedFallback.run.unknownTail;
          deferredAcrossFirmed = selectedFallback.option.deferred;
          missingEdges.push(...run.missingEdges);
          // Suppressed for 'due-date' (2026-09-09): see appendRejectedCoverageDiagnostics's precondition comment.
          if (mode !== 'due-date') {
            appendRejectedCoverageDiagnostics(missingEdges, explanation, run.missingEdges, winnerEdgeKeySet(winner));
          }
          explanation.push({
            code: 'covered-firmed-boundary-fallback',
            message: `Deferred ${deferredAcrossFirmed.length} order(s) past firmed ${taskId(boundary.task)} to preserve a covered firmed boundary.`,
            line,
            taskId: taskId(boundary.task),
          });
        }
      }
    }
    if (!winner) {
      const attemptedEdges = [
        ...run.missingEdges,
        ...fallbackRuns.flatMap(fallbackRun => fallbackRun.missingEdges),
        ...continuationRuns.flatMap(continuation => continuation.missingEdges),
      ];
      missingEdges.push(...attemptedEdges);
      // An active-override conflict is an explicit user assertion and stays
      // fail-closed (Part 1f). Anything else — unresolved coverage/capacity,
      // or the shared budget running out before any covered sequence
      // completed — is a missing-data fact, not a reason to freeze.
      // An active-override conflict must still fail closed even mixed in with
      // other (missing-data) causes — otherwise a fragment with one blank-
      // signature order alongside a genuine override conflict would silently
      // discard the override and tail-place the bound order away from its
      // required neighbour (F4/F5).
      const isOverrideConflict = attemptedEdges.some(edge => edge.reason === 'override-inactive');
      if (isOverrideConflict) {
        explanation.push({
          code: 'firmed-boundary-infeasible',
          message: `Cannot preserve the required incoming setup before firmed ${taskId(boundary.task)}.`,
          line,
          taskId: taskId(boundary.task),
        });
        return {
          patches: [], score: zeroScore(), explanation, missingEdges,
          candidateCount, method, termination, unchanged: true,
        };
      }
      // A4: no arbitrated fallback route won this fragment, and it is not an
      // override conflict — never freeze. There is no longer a second
      // "re-run with coverage-demotion enabled" attempt here: A1 removed the
      // trigger for that backstop (an uncovered transition can no longer make
      // `run` infeasible in the first place), so a second attempt over the
      // same `admitted` batch could not find anything `run` didn't already.
      // Place the whole admitted+later set as a tail up to this boundary's
      // reserved incoming setup instead.
      const tailEnd = tailCapacityEnd(bounds, line, boundary.start, boundary, predecessorState, predecessorOrderId);
      const tailUnadmitted = applyUnknownTail(
        snapshot, bounds, line, mode, admitted, fragmentStart, tailEnd, patches, explanation, missingEdges,
        predecessorOrderId,
      );
      remaining = [...tailUnadmitted, ...later];
      fragmentStart = new Date(boundary.end);
      predecessorState = boundary.state;
      predecessorOrderId = taskId(boundary.task);
      requiredFirstOrderId = boundaryLock?.requiredFirstOrderId;
      continue;
    }
    const tailEnd = tailCapacityEnd(
      bounds, line, boundary.start, boundary,
      winner.finalState ?? predecessorState, winner.finalPredecessorOrderId ?? predecessorOrderId,
    );
    const tailUnadmitted = applyUnknownTail(
      snapshot, bounds, line, mode, tailSource, tailCursorFor(winner, fragmentStart), tailEnd, patches, explanation,
      missingEdges, winner.finalPredecessorOrderId ?? predecessorOrderId,
    );
    remaining = [...winner.unadmitted, ...deferredAcrossFirmed, ...tailUnadmitted, ...later];
    fragmentStart = new Date(boundary.end);
    predecessorState = boundary.state;
    predecessorOrderId = taskId(boundary.task);
    requiredFirstOrderId = boundaryLock?.requiredFirstOrderId;
  }

  const trailing = searchFragment(snapshot, bounds, line, remaining, {
    start: fragmentStart,
    end: bounds.horizonEnd,
    predecessorState,
    predecessorOrderId,
    lineOrderIds,
    allowsDeletedPredecessorBinding: initial.preservedAnchor !== undefined,
    requiredFirstOrderId,
  }, budget, mode);
  recordRun(trailing);
  // Terminal discard guard (Part 1f): a partial or absent trailing winner no
  // longer discards every patch the earlier fragments already produced. The
  // covered winner (if any) is applied, its own unadmitted overflow and the
  // fragment's unknown-state/uncovered orders are placed as a tail up to the
  // horizon, and whatever still cannot fit stays at its current dates with a
  // diagnostic — the line is never frozen.
  let tailStart = fragmentStart;
  let tailTasks: ReadonlyArray<NimbusTask> = trailing.unknownTail;
  let tailPredecessorOrderId = predecessorOrderId;
  if (trailing.winner) {
    if (mode === 'due-date-first') {
      appendRejectedCoverageDiagnostics(missingEdges, explanation, trailing.missingEdges, winnerEdgeKeySet(trailing.winner));
    }
    applyCandidate(trailing.winner);
    tailStart = tailCursorFor(trailing.winner, fragmentStart);
    tailTasks = [...tailTasks, ...trailing.winner.unadmitted];
    tailPredecessorOrderId = trailing.winner.finalPredecessorOrderId ?? predecessorOrderId;
  } else {
    missingEdges.push(...trailing.missingEdges);
    // .some, not .every (F5): an override conflict must fail closed even
    // alongside missing-data edges from the same trailing fragment.
    const isOverrideConflict = trailing.missingEdges.some(edge => edge.reason === 'override-inactive');
    if (isOverrideConflict) {
      explanation.push({ code: 'setup-sequence-infeasible', message: 'No covered feasible setup sequence was found.', line });
      return {
        patches: [], score: zeroScore(), explanation, missingEdges,
        candidateCount, method, termination, unchanged: true,
      };
    }
    // Budget exhaustion or unresolved coverage before any covered sequence
    // completed (Part 2b): never freeze — place the entire remaining
    // fragment as an unknown tail instead.
    tailTasks = [...tailTasks, ...remaining];
  }
  const tailUnadmitted = applyUnknownTail(
    snapshot, bounds, line, mode, tailTasks, tailStart, bounds.horizonEnd, patches, explanation, missingEdges, tailPredecessorOrderId,
  );
  for (const task of tailUnadmitted) {
    explanation.push({
      code: 'unknown-setup-tail-unplaced',
      message: `Left ${taskId(task)} at its current dates; no remaining capacity for tail placement.`,
      line,
      taskId: taskId(task),
    });
  }
  return { patches, score, explanation, missingEdges, candidateCount, method, termination, unchanged: false };
}

function requireDueDateBounds(bounds: Readonly<DueDateFirstBounds>): void {
  if (!bounds.setup || !bounds.setup.plant) throw new TypeError('Due-date-first evaluation requires setup truth.');
  if (!Number.isInteger(bounds.exactSearchThreshold) || bounds.exactSearchThreshold < 0) {
    throw new TypeError('Due-date-first evaluation requires an exact-search threshold.');
  }
  if (!Number.isInteger(bounds.iterationCap) || bounds.iterationCap <= 0) {
    throw new TypeError('Due-date-first evaluation requires a positive iteration cap.');
  }
  if (typeof bounds.clock !== 'function' || !Number.isFinite(bounds.deadline)) {
    throw new TypeError('Due-date-first evaluation requires an injected clock and deadline.');
  }
  if (!timestamp(bounds.now) || !timestamp(bounds.horizonEnd) || bounds.horizonEnd <= bounds.now) {
    throw new TypeError('Due-date-first evaluation requires a valid scheduling horizon.');
  }
}

/**
 * Pure setup-aware SPT evaluation. Productive runtime is the only order key:
 * setup is always reserved as capacity after that order is chosen, never used
 * as a hidden changeover sort term. A missing SPT transition leaves the line
 * unchanged instead of selecting a different, covered sequence.
 */
export function evaluateSptWithSetup(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
): CandidateResult {
  requireDueDateBounds(bounds);
  const started = bounds.clock();
  // Phase 1a: reuse the caller's run context when it matches this snapshot,
  // otherwise build one fresh — then thread the (possibly augmented) bounds
  // to everything below so every hot loop can read `bounds.runContext`.
  bounds = withRunContext(snapshot, hardBounds(snapshot, bounds));
  const plant = bounds.setup.plant;
  const definition = bounds.setup.definition;
  const byLine = new Map<string, NimbusTask[]>();
  for (const task of eligibleTasks(snapshot, bounds)) {
    const line = String(task.MACHINE ?? '');
    const group = byLine.get(line) ?? [];
    group.push(task);
    byLine.set(line, group);
  }

  let candidateCount = 0;
  // Narrower than SearchDiagnostics['termination'] (excludes 'no-plant' /
  // 'infeasible', which this per-line aggregation never produces — every
  // value here comes from a LineSearchResult, whose termination type is
  // exactly SearchRun['termination']) so `worseTermination` below can accept
  // it directly.
  let termination: SearchRun['termination'] = 'completed';
  const patches: SchedulePatch[] = [];
  const explanation: CandidateReason[] = [];
  const unchangedLines: string[] = [];
  const missingEdges: MissingSetupEdge[] = [];
  const score = zeroScore();

  const orderedLines = [...byLine.entries()].sort(([left], [right]) => left.localeCompare(right));
  let linesRemaining = orderedLines.length;
  for (const [line, tasks] of orderedLines) {
    // Phase 1.5: a fair share of whatever wall-clock budget remains, so one
    // early line can no longer consume the caller's entire `bounds.deadline`
    // and leave every line behind it with zero — recomputed fresh from the
    // clock each iteration (not decremented by a fixed slice), so a line
    // that finishes early lets its unused share roll forward to the rest.
    const now = bounds.clock();
    const remainingMs = Math.max(0, bounds.deadline - now);
    const lineDeadline = Math.min(bounds.deadline, now + remainingMs / linesRemaining);
    const lineBounds: Readonly<DueDateFirstBounds> = { ...bounds, deadline: lineDeadline };
    linesRemaining -= 1;
    // Part 2b: a fresh per-line budget so one large line's search can never
    // exhaust the iteration cap for every other line on the plant.
    const budget: SearchBudget = { remainingIterations: bounds.iterationCap };
    if (!definition || definition.plant !== plant) {
      // Part 1e: no setup definition at all means setup-awareness cannot run
      // for this line, but the line is never frozen — free orders still get
      // a policy/due-ordered tail placement around any firmed orders.
      const wholeLine = placeWholeLineAsTail(snapshot, lineBounds, line, tasks, 'spt');
      patches.push(...wholeLine.patches);
      explanation.push({ code: 'setup-definition-unavailable', message: 'No compatible setup definition is available.', line });
      explanation.push(...wholeLine.explanation);
      missingEdges.push(...wholeLine.missingEdges);
      if (!wholeLine.patches.length) unchangedLines.push(line);
      continue;
    }
    const missingSuccessorEdgesForLine = missingSuccessorOverrideEdges(bounds, line, tasks);
    const missingSuccessorReasonsForLine = missingSuccessorOverrideReasons(line, missingSuccessorEdgesForLine);
    const missingPredecessorEdgesForLine = missingPredecessorOverrideEdges(bounds, line, tasks);
    const missingPredecessorReasonsForLine = missingPredecessorOverrideReasons(line, missingPredecessorEdgesForLine);
    const compatibility = setupCompatibilityForLine(snapshot, plant, line);
    if (compatibility) {
      // Part 1e: an explicit setup_compatible=false opt-out still never
      // freezes the line — whole-line tail placement, one line-level edge,
      // no per-order override-diagnostic noise.
      const wholeLine = placeWholeLineAsTail(snapshot, lineBounds, line, tasks, 'spt');
      patches.push(...wholeLine.patches);
      missingEdges.push({ line, reason: 'setup-compatibility-disabled' });
      explanation.push({
        code: 'setup-incompatible',
        message: compatibility.reason
          ? `This line is marked incompatible with the active setup signature: ${compatibility.reason}`
          : 'This line is marked incompatible with the active setup signature.',
        line,
      });
      explanation.push(...wholeLine.explanation);
      missingEdges.push(...wholeLine.missingEdges);
      if (!wholeLine.patches.length) unchangedLines.push(line);
      continue;
    }
    const initial = initialStateForLine(bounds, line, definition.signature_version);
    // A stale signature is not merely unknown physical state: global setup
    // safety rules require exclusion until the version mismatch is resolved.
    const initialScheduled = !initial.state && initial.reason === 'initial-state-unknown'
      ? initialScheduledAnchor(tasks, definition)
      : null;
    const anchor = initialScheduled && taskIsFirmed(snapshot, initialScheduled.task) ? preservedInitialAnchor(initialScheduled) : null;
    // Part 1d: an unknown line-initial state (no persisted state, no
    // scheduled anchor) no longer skips the line. Proceed with a null
    // initial state — its diagnostic is retained either way.
    const initialDiagnosticEdges: MissingSetupEdge[] = [];
    const initialDiagnosticReasons: CandidateReason[] = [];
    if (!initial.state && !anchor) {
      initialDiagnosticEdges.push(
        initial.reason === 'initial-state-unknown'
          ? unknownInitialStateEdge(line, initialScheduled?.task)
          : { line, predecessorOrderId: null, reason: initial.reason },
      );
      initialDiagnosticReasons.push({
        code: initial.reason === 'signature-incompatible' ? 'setup-signature-incompatible' : 'initial-state-unknown',
        message: initial.reason === 'signature-incompatible'
          ? 'The line state uses a different setup-signature version.'
          : unknownInitialStateReason(line, initialScheduled?.task).message,
        line,
        ...(initial.reason === 'initial-state-unknown' && initialScheduled?.task
          ? { taskId: taskId(initialScheduled.task) }
          : {}),
      });
    }
    const candidateTasks = anchor ? tasks.filter(task => taskId(task) !== taskId(anchor.task)) : tasks;
    const result = evaluateLineWithFirmedBoundaries(
      snapshot,
      lineBounds,
      line,
      candidateTasks,
      initial.state ?? anchor?.state ?? null,
      {
        predecessorOrderId: anchor ? taskId(anchor.task) : null,
        fragmentStart: anchor
          ? new Date(Math.max(anchor.end.getTime(), bounds.now.getTime()))
          : new Date(bounds.now),
        allTasks: tasks,
        ...(anchor ? { preservedAnchor: anchor } : {}),
      },
      budget,
      'spt',
    );
    candidateCount += result.candidateCount;
    termination = worseTermination(termination, result.termination);
    if (result.unchanged) {
      unchangedLines.push(line);
      missingEdges.push(...initialDiagnosticEdges, ...result.missingEdges);
      explanation.push(...initialDiagnosticReasons, ...result.explanation);
      explanation.push({ code: 'spt-sequence-infeasible', message: 'Pure SPT sequence has no covered feasible setup path.', line });
      continue;
    }
    patches.push(...result.patches);
    explanation.push(...initialDiagnosticReasons, ...result.explanation);
    missingEdges.push(...initialDiagnosticEdges, ...result.missingEdges);
    for (let index = 0; index < score.length; index += 1) score[index] += result.score[index] ?? 0;
  }

  return finalizeCandidate(snapshot, { ...bounds, strategy: 'spt' }, {
    patches,
    score,
    explanation,
    diagnostics: {
      candidateCount,
      method: 'spt-detached',
      termination,
      runtimeMs: Math.max(0, bounds.clock() - started),
      limitReached: termination === 'deadline' || termination === 'iteration-cap',
      events: [],
      budgetMs: Math.max(0, bounds.deadline - started),
      deadlineAt: bounds.deadline,
      iterationsUsed: candidateCount,
      eligibleCount: byLine.size ? [...byLine.values()].reduce((sum, lineTasks) => sum + lineTasks.length, 0) : 0,
      evaluatedCount: candidateCount,
      placedCount: patches.length,
      exhaustive: termination === 'completed',
      quality: 'exact',
      respectCalendar: bounds.respectCalendar ?? true,
    },
    unchangedLines,
    missingEdges: uniqueMissingEdges(missingEdges),
  });
}

/**
 * Pure, detached Smart / Due-date-first candidate evaluator. It consumes only
 * its supplied snapshot and setup truth, returns patches, and deliberately
 * has no Store or live Engine path. Bounds are all mandatory because Stage 0
 * measurement—not a hidden production default—owns the search budget.
 */
export function evaluateDueDateFirst(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  mode: Extract<FragmentMode, 'due-date-first' | 'min-changeover' | 'throughput' | 'due-date'> = 'due-date-first',
): CandidateResult {
  requireDueDateBounds(bounds);
  const started = bounds.clock();
  // Phase 1a: reuse the caller's run context when it matches this snapshot,
  // otherwise build one fresh — then thread the (possibly augmented) bounds
  // to everything below so every hot loop can read `bounds.runContext`.
  bounds = withRunContext(snapshot, hardBounds(snapshot, bounds));
  const plant = bounds.setup.plant;
  const definition = bounds.setup.definition;
  const byLine = new Map<string, NimbusTask[]>();
  for (const task of eligibleTasks(snapshot, bounds)) {
    const line = String(task.MACHINE ?? '');
    const group = byLine.get(line) ?? [];
    group.push(task);
    byLine.set(line, group);
  }

  let candidateCount = 0;
  let method: SearchDiagnostics['method'] = 'due-date-first-exact';
  // Narrower than SearchDiagnostics['termination'] (excludes 'no-plant' /
  // 'infeasible', which this per-line aggregation never produces — every
  // value here comes from a LineSearchResult, whose termination type is
  // exactly SearchRun['termination']) so `worseTermination` below can accept
  // it directly.
  let termination: SearchRun['termination'] = 'completed';
  const patches: SchedulePatch[] = [];
  const explanation: CandidateReason[] = [];
  const unchangedLines: string[] = [];
  const missingEdges: MissingSetupEdge[] = [];
  const score = zeroScore();

  const orderedLines = [...byLine.entries()].sort(([left], [right]) => left.localeCompare(right));
  let linesRemaining = orderedLines.length;
  for (const [line, tasks] of orderedLines) {
    // Phase 1.5: a fair share of whatever wall-clock budget remains, so one
    // early line can no longer consume the caller's entire `bounds.deadline`
    // and leave every line behind it with zero — recomputed fresh from the
    // clock each iteration (not decremented by a fixed slice), so a line
    // that finishes early lets its unused share roll forward to the rest.
    const now = bounds.clock();
    const remainingMs = Math.max(0, bounds.deadline - now);
    const lineDeadline = Math.min(bounds.deadline, now + remainingMs / linesRemaining);
    const lineBounds: Readonly<DueDateFirstBounds> = { ...bounds, deadline: lineDeadline };
    linesRemaining -= 1;
    // Part 2b: a fresh per-line budget so one large line's search can never
    // exhaust the iteration cap for every other line on the plant.
    const budget: SearchBudget = { remainingIterations: bounds.iterationCap };
    if (!definition || definition.plant !== plant) {
      // Part 1e: no setup definition at all means setup-awareness cannot run
      // for this line, but the line is never frozen — free orders still get
      // a policy/due-ordered tail placement around any firmed orders.
      const wholeLine = placeWholeLineAsTail(snapshot, lineBounds, line, tasks, mode);
      patches.push(...wholeLine.patches);
      explanation.push({ code: 'setup-definition-unavailable', message: 'No compatible setup definition is available.', line });
      explanation.push(...wholeLine.explanation);
      missingEdges.push(...wholeLine.missingEdges);
      if (!wholeLine.patches.length) unchangedLines.push(line);
      continue;
    }
    const missingSuccessorEdgesForLine = missingSuccessorOverrideEdges(bounds, line, tasks);
    const missingSuccessorReasonsForLine = missingSuccessorOverrideReasons(line, missingSuccessorEdgesForLine);
    const missingPredecessorEdgesForLine = missingPredecessorOverrideEdges(bounds, line, tasks);
    const missingPredecessorReasonsForLine = missingPredecessorOverrideReasons(line, missingPredecessorEdgesForLine);
    const compatibility = setupCompatibilityForLine(snapshot, plant, line);
    if (compatibility) {
      // Part 1e: an explicit setup_compatible=false opt-out still never
      // freezes the line — whole-line tail placement, one line-level edge,
      // no per-order override-diagnostic noise.
      const wholeLine = placeWholeLineAsTail(snapshot, lineBounds, line, tasks, mode);
      patches.push(...wholeLine.patches);
      missingEdges.push({ line, reason: 'setup-compatibility-disabled' });
      explanation.push({
        code: 'setup-incompatible',
        message: compatibility.reason
          ? `This line is marked incompatible with the active setup signature: ${compatibility.reason}`
          : 'This line is marked incompatible with the active setup signature.',
        line,
      });
      explanation.push(...wholeLine.explanation);
      missingEdges.push(...wholeLine.missingEdges);
      if (!wholeLine.patches.length) unchangedLines.push(line);
      continue;
    }
    const initial = initialStateForLine(bounds, line, definition.signature_version);
    // Preserve an anchor only for genuinely absent current state. A
    // signature-incompatible state remains a hard detached-evaluation gate.
    const initialScheduled = !initial.state && initial.reason === 'initial-state-unknown'
      ? initialScheduledAnchor(tasks, definition)
      : null;
    const anchor = initialScheduled && taskIsFirmed(snapshot, initialScheduled.task) ? preservedInitialAnchor(initialScheduled) : null;
    // Part 1d: an unknown line-initial state (no persisted state, no
    // scheduled anchor) no longer skips the line — including the stale
    // signature-incompatible case. Proceed with a null initial state; the
    // diagnostic is retained either way.
    const initialDiagnosticEdges: MissingSetupEdge[] = [];
    const initialDiagnosticReasons: CandidateReason[] = [];
    if (!initial.state && !anchor) {
      initialDiagnosticEdges.push(
        initial.reason === 'initial-state-unknown'
          ? unknownInitialStateEdge(line, initialScheduled?.task)
          : { line, predecessorOrderId: null, reason: initial.reason },
      );
      initialDiagnosticReasons.push({
        code: initial.reason === 'signature-incompatible' ? 'setup-signature-incompatible' : 'initial-state-unknown',
        message: initial.reason === 'signature-incompatible'
          ? 'The line state uses a different setup-signature version.'
          : unknownInitialStateReason(line, initialScheduled?.task).message,
        line,
        ...(initial.reason === 'initial-state-unknown' && initialScheduled?.task
          ? { taskId: taskId(initialScheduled.task) }
          : {}),
      });
    }
    const candidateTasks = anchor ? tasks.filter(task => taskId(task) !== taskId(anchor.task)) : tasks;

    const result = evaluateLineWithFirmedBoundaries(
      snapshot,
      lineBounds,
      line,
      candidateTasks,
      initial.state ?? anchor?.state ?? null,
      {
        predecessorOrderId: anchor ? taskId(anchor.task) : null,
        fragmentStart: anchor
          ? new Date(Math.max(anchor.end.getTime(), bounds.now.getTime()))
          : new Date(bounds.now),
        allTasks: tasks,
        ...(anchor ? { preservedAnchor: anchor } : {}),
      },
      budget,
      mode,
    );
    candidateCount += result.candidateCount;
    if (result.method === 'due-date-first-greedy') method = result.method;
    termination = worseTermination(termination, result.termination);
    if (result.unchanged) {
      unchangedLines.push(line);
      missingEdges.push(...initialDiagnosticEdges, ...result.missingEdges);
      explanation.push(...initialDiagnosticReasons, ...result.explanation);
      continue;
    }
    patches.push(...result.patches);
    explanation.push(...initialDiagnosticReasons, ...result.explanation);
    missingEdges.push(...initialDiagnosticEdges, ...result.missingEdges);
    for (let index = 0; index < score.length; index += 1) score[index] += result.score[index] ?? 0;
  }

  return finalizeCandidate(snapshot, { ...bounds, strategy: mode }, {
    patches,
    score,
    explanation,
    diagnostics: {
      candidateCount,
      method,
      termination,
      runtimeMs: Math.max(0, bounds.clock() - started),
      limitReached: termination === 'deadline' || termination === 'iteration-cap',
      events: [],
      budgetMs: Math.max(0, bounds.deadline - started),
      deadlineAt: bounds.deadline,
      iterationsUsed: candidateCount,
      eligibleCount: byLine.size ? [...byLine.values()].reduce((sum, lineTasks) => sum + lineTasks.length, 0) : 0,
      evaluatedCount: candidateCount,
      placedCount: patches.length,
      exhaustive: termination === 'completed',
      quality: method.endsWith('exact') ? 'exact' : 'heuristic',
      respectCalendar: bounds.respectCalendar ?? true,
    },
    unchangedLines,
    missingEdges: uniqueMissingEdges(missingEdges),
  });
}

function scheduledEndMinutes(task: Readonly<NimbusTask>): number | null {
  const end = timestamp(task.end_date);
  return end ? Math.floor(end.getTime() / (60 * 1000)) : null;
}

/** `notAfter` is optional and, when supplied, mirrors `bounds.notAfter` (the
 * due-date push-forward limit ceiling) so a caller can compare before/after
 * over-cap counts the same way it already compares before/after lateness.
 * `selectThroughputCandidate` deliberately calls this WITHOUT `notAfter` —
 * the cap is a min-changeover-only due-safe rule, not a throughput one — so
 * every entry's `overCap` there is simply `false`. */
function lateOrderFacts(
  tasks: ReadonlyArray<NimbusTask>,
  notAfter?: (task: NimbusTask) => Date | null,
): Map<string, { late: boolean; end: number | null; overCap: boolean }> {
  const facts = new Map<string, { late: boolean; end: number | null; overCap: boolean }>();
  for (const task of tasks) {
    const end = scheduledEndMinutes(task);
    const due = dueTimestamp(task);
    const ceiling = notAfter ? notAfter(task) ?? null : null;
    const overCap = end !== null && ceiling !== null && end * 60 * 1000 > ceiling.getTime();
    facts.set(taskId(task), { late: end !== null && Number.isFinite(due) && end * 60 * 1000 > due, end, overCap });
  }
  return facts;
}

function withPolicyReason(result: CandidateResult, code: string, message: string): CandidateResult {
  return { ...result, explanation: [...result.explanation, { code, message }] };
}

/** Use available slack: run the shared candidate evaluator with setup as the
 * first non-due comparator, then fail closed to Due-date-first if it made an
 * originally on-time order late or increased the line's existing late count.
 */
export function evaluateMinChangeover(
  snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>,
): CandidateResult {
  bounds = withRunContext(snapshot, hardBounds(snapshot, bounds));
  const now = bounds.clock();
  const remainingMs = Math.max(0, bounds.deadline - now);
  const baseline = evaluateDueDateFirst(snapshot, { ...bounds, deadline: now + remainingMs / 2 });
  const candidate = evaluateDueDateFirst(snapshot, bounds, 'min-changeover');
  const urgency = urgencyOrder(snapshot, bounds, '', eligibleTasks(snapshot, bounds));
  const admission = (result: CandidateResult): string => {
    const queued = new Set(result.dispositions?.filter(d => d.status === 'needs_planning').map(d => d.id));
    return urgency.map(task => queued.has(taskId(task)) ? '1' : '0').join('');
  };
  const admissionDelta = ordinalCompare(admission(candidate), admission(baseline));
  const chooseCandidate = !candidate.validationFindings?.some(f => f.severity === 'error')
    && (admissionDelta < 0 || (admissionDelta === 0 && compareFinalObjectives(snapshot, { ...bounds, strategy: 'min-changeover' }, candidate, baseline) <= 0));
  const chosen = chooseCandidate ? candidate : baseline;
  const incomplete = baseline.searchComplete === false || candidate.searchComplete === false;
  const termination = incomplete
    ? (baseline.diagnostics.termination === 'deadline' || candidate.diagnostics.termination === 'deadline' ? 'deadline' : 'iteration-cap')
    : chosen.diagnostics.termination;
  return {
    ...chosen,
    searchComplete: !incomplete,
    diagnostics: { ...chosen.diagnostics, termination, limitReached: incomplete, candidateCount: baseline.diagnostics.candidateCount + candidate.diagnostics.candidateCount, runtimeMs: Math.max(0, bounds.clock() - now) },
    explanation: [...chosen.explanation, { code: chooseCandidate ? 'min-changeover-due-safe' : 'min-changeover-incumbent', message: chooseCandidate ? 'Selected the best validated admission and delivery/setup objective.' : 'Retained the better validated incumbent.' }],
  };
}

/** Select between two already-detached candidates. Keeping the guard here
 * makes every per-order delay visible to a single, testable fail-closed
 * comparison; it neither constructs nor applies a schedule patch. */
export function selectThroughputCandidate(
  snapshot: Readonly<ScheduleSnapshot>,
  baseline: Readonly<CandidateResult>,
  candidate: Readonly<CandidateResult>,
  thresholds: Readonly<SetupPolicyThresholds>,
): CandidateResult {
  const before = lateOrderFacts(snapshot.tasks);
  const afterTasks = applyPatchesToSnapshot(snapshot.tasks, candidate.patches);
  const after = lateOrderFacts(afterTasks);
  const savings = Math.max(0, (baseline.score[5] ?? 0) - (candidate.score[5] ?? 0));
  const slips = [...after.entries()].flatMap(([id, fact]) => {
    const prior = before.get(id)?.end;
    return prior === null || prior === undefined || fact.end === null ? [] : [{ id, minutes: Math.max(0, fact.end - prior) }];
  });
  const overCap = slips.filter(slip => slip.minutes > thresholds.throughputMaxSlipMin);
  if (savings < thresholds.throughputMinSavingsMin || overCap.length) {
    const reason = overCap.length
      ? `${overCap.map(slip => `${slip.id} (${slip.minutes} min)`).join(', ')} exceeds the ${thresholds.throughputMaxSlipMin}-minute slip cap`
      : `${savings} setup minutes saved is below the ${thresholds.throughputMinSavingsMin}-minute minimum`;
    return withPolicyReason(baseline, 'throughput-rejected-threshold', `Rejected throughput alternative: ${reason}.`);
  }
  const maxSlip = Math.max(0, ...slips.map(slip => slip.minutes));
  return withPolicyReason(
    candidate,
    'throughput-accepted',
    `Accepted ${savings} setup minutes saved; every order slips no more than ${maxSlip} minutes.`,
  );
}

/** Throughput-first may trade schedule delay for setup savings, but only when
 * every delayed order is individually under the configured cap. This compares
 * the same detached candidate path against the Due-date-first baseline; it
 * does not create a second placement or mutation mechanism. */
export function evaluateThroughput(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  thresholds: Readonly<SetupPolicyThresholds>,
): CandidateResult {
  if (!Number.isInteger(thresholds.throughputMinSavingsMin) || thresholds.throughputMinSavingsMin < 0) {
    throw new TypeError('Throughput policy requires nonnegative setup-savings minutes.');
  }
  if (!Number.isInteger(thresholds.throughputMaxSlipMin) || thresholds.throughputMaxSlipMin <= 0) {
    throw new TypeError('Throughput policy requires a positive per-order slip cap.');
  }
  // Phase 1a: build the run context ONCE and share it across both of this
  // function's internal `evaluateDueDateFirst` sweeps (baseline + throughput),
  // instead of each sweep independently rebuilding its own.
  bounds = withRunContext(snapshot, hardBounds(snapshot, bounds));
  return selectThroughputCandidate(
    snapshot,
    evaluateDueDateFirst(snapshot, bounds),
    evaluateDueDateFirst(snapshot, bounds, 'throughput'),
    thresholds,
  );
}

/** Apply a detached patch set to detached task values for before/after
 * comparison. The original snapshot and task objects are never changed.
 *
 * Sharing contract (Phase 2, Pkg D — clone reduction): an unpatched entry in
 * the returned array is the CALLER'S OWN original snapshot task object,
 * returned BY REFERENCE, not a clone — only patched entries are freshly
 * cloned. Every consumer of this function's output must therefore treat
 * unpatched entries as read-only. Verified downstream: the KPI path
 * (Util.scheduleKpis via schedule-workbench.mts's runWithPreview) reads
 * fields and separately clones its own `coreTasks` inside
 * Utilization.computeMatrix; `lateOrderFacts` (this module) only reads
 * fields off each task. Neither mutates a task object. */
export function applyPatchesToSnapshot(tasks: ReadonlyArray<NimbusTask>, patches: ReadonlyArray<SchedulePatch>): NimbusTask[] {
  const byId = new Map(patches.map(patch => [String(patch.id), patch.changes]));
  return tasks.map(task => {
    const changes = byId.get(String(task.id));
    return changes ? { ...structuredClone(task), ...structuredClone(changes) } : task;
  });
}

/** SAP-only local calendar-day bounds; scheduled finish is never a due-date fallback. */
export function allowedPlanningWindow(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, task: NimbusTask): { floor: Date | null; ceiling: Date | null; missingDue: boolean } {
  const plant = snapshot.masterData?.plants?.find(row => row.plant === bounds.setup.plant);
  const pull = plant?.max_pull_forward_days;
  const push = plant?.max_push_forward_days;
  const hasPull = Number.isInteger(pull) && Number(pull) >= 0;
  const hasPush = Number.isInteger(push) && Number(push) >= 0;
  const due = timestamp(task.original_end_date) ?? timestamp(task.ORIGINAL_END_DATE);
  const day = (offset: number): Date | null => {
    if (!due) return null;
    const value = new Date(due); value.setHours(0, 0, 0, 0); value.setDate(value.getDate() + offset); return value;
  };
  return { floor: hasPull ? day(-Number(pull)) : null, ceiling: hasPush ? day(Number(push) + 1) : null, missingDue: (hasPull || hasPush) && !due };
}

function hardBounds(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>): Readonly<DueDateFirstBounds> {
  const priorFloor = bounds.notBefore;
  const priorCeiling = bounds.notAfter;
  return { ...bounds, notBefore: task => {
    const own = allowedPlanningWindow(snapshot, bounds, task).floor;
    const supplied = priorFloor?.(task);
    return own && supplied ? new Date(Math.max(+own, +supplied)) : own ?? supplied ?? null;
  }, notAfter: task => {
    const own = allowedPlanningWindow(snapshot, bounds, task).ceiling;
    const supplied = priorCeiling?.(task);
    return own && supplied ? new Date(Math.min(+own, +supplied)) : own ?? supplied ?? null;
  } };
}

function completionEnd(bounds: Readonly<DueDateFirstBounds>, task: NimbusTask, end: Date): Date {
  const ceiling = notAfterFor(bounds, task);
  return ceiling && ceiling < end ? ceiling : end;
}

function planningDefect(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, task: NimbusTask): { code: string; message: string } | null {
  if (allowedPlanningWindow(snapshot, bounds, task).missingDue) return { code: 'missing_due_date', message: 'A SAP due date is required for the configured planning window.' };
  if (!Number.isFinite(Number(task.RUN_TIME)) || Math.round(Number(task.RUN_TIME) * 60) <= 0) return { code: 'invalid_runtime', message: 'Runtime must be a positive number.' };
  const ceiling = notAfterFor(bounds, task);
  const floor = notBeforeFor(bounds, task);
  if (ceiling && +ceiling <= Math.max(+bounds.now, floor ? +floor : -Infinity)) return { code: 'expired_window', message: 'The allowed completion window ends before available planning time.' };
  return null;
}

function urgencyOrder(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, line: string, tasks: ReadonlyArray<NimbusTask>): NimbusTask[] {
  return [...tasks].sort((a, b) => {
    const deadline = (notAfterFor(bounds, a)?.getTime() ?? Infinity) - (notAfterFor(bounds, b)?.getTime() ?? Infinity);
    if (deadline && !Number.isNaN(deadline)) return deadline;
    const priority = ordinalCompare(policyKeyForSequence(snapshot, bounds.setup.plant, line || String(a.MACHINE), [a], bounds.runContext), policyKeyForSequence(snapshot, bounds.setup.plant, line || String(b.MACHINE), [b], bounds.runContext));
    return priority || dueTimestamp(a) - dueTimestamp(b) || (timestamp(a.start_date)?.getTime() ?? Number.MAX_SAFE_INTEGER) - (timestamp(b.start_date)?.getTime() ?? Number.MAX_SAFE_INTEGER) || ordinalCompare(taskId(a), taskId(b));
  });
}

function eligibleTasks(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>): NimbusTask[] {
  return snapshot.tasks.filter(task => {
    const line = String(task.MACHINE ?? '');
    if (!line || resolveTaskPlant(task, snapshot, bounds.runContext) !== bounds.setup.plant
      || snapshot.lineSettings[line]?.excludeFromOpt
      || (bounds.lines?.length && !bounds.lines.includes(line))) return false;
    // Protected work remains in the detached line model as an immutable
    // occupancy/predecessor boundary even when it sits outside this run's
    // mutable planning window. Unprotected scheduled work is scoped by
    // interval intersection with [planningStart, horizonEnd); queued or
    // malformed work is always eligible for repair.
    if (taskIsFirmed(snapshot, task)) return true;
    if (task.planning_status === 'needs_planning') return true;
    const start = timestamp(task.start_date);
    const end = timestamp(task.end_date);
    if (!start || !end || end <= start) return true;
    const planningStart = timestamp(bounds.planningStart)?.getTime() ?? +bounds.now;
    return end.getTime() > planningStart && start.getTime() < +bounds.horizonEnd;
  });
}

function productiveIntervals(task: NimbusTask): PlacementInterval[] {
  if (task.scheduleSegments?.length) return task.scheduleSegments.flatMap(segment => {
    const start = timestamp(segment.startDate); const end = timestamp(segment.endDate);
    return start && end ? [{ start, end }] : [];
  });
  const start = timestamp(task.start_date); const end = timestamp(task.end_date);
  return start && end ? [{ start, end }] : [];
}

/** Revalidates the complete proposal. Protected legacy violations are warnings, never a partial-Apply veto. */
export function validateCandidate(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, candidate: Readonly<CandidateResult>, currentSnapshot?: Readonly<ScheduleSnapshot>): ValidationFinding[] {
  bounds = withRunContext(snapshot, hardBounds(snapshot, bounds));
  const findings: ValidationFinding[] = [];
  const add = (code: string, message: string, task?: NimbusTask, protectedTask = false): void => { findings.push({ code, message, severity: protectedTask ? 'warning' : 'error', ...(task ? { taskId: taskId(task), line: String(task.MACHINE) } : {}) }); };
  if (currentSnapshot) {
    const baselineSnapshot = candidate.validationContext?.baselineSnapshot ?? snapshot;
    const baseline = JSON.stringify({ ...baselineSnapshot, alerts: [], firmedIds: [...baselineSnapshot.firmedIds].sort() });
    const current = JSON.stringify({ ...currentSnapshot, alerts: [], firmedIds: [...currentSnapshot.firmedIds].sort() });
    if (baseline !== current) add('stale_candidate', 'The schedule or scheduling inputs changed after this proposal was evaluated.');
  }
  const tasks = eligibleTasks(snapshot, bounds);
  const ids = new Set(tasks.map(taskId));
  const patches = new Map<string, SchedulePatch>();
  for (const patch of candidate.patches) {
    if (!ids.has(patch.id)) add('scope', `Patch ${patch.id} is outside the requested scope.`);
    if (patches.has(patch.id)) add('duplicate_patch', `Order ${patch.id} appears twice.`);
    if (Object.keys(patch.changes).some(key => !['start_date', 'end_date', 'scheduleSegments', 'planning_status', 'planning_reason'].includes(key))) add('business_fields', 'Optimizer patches may only change schedule and planning state.');
    patches.set(patch.id, patch);
  }
  const dispositions = new Map<string, PlanningDisposition>();
  for (const disposition of candidate.dispositions ?? []) {
    if (!ids.has(disposition.id) || dispositions.has(disposition.id)) add('accounting', `Invalid or duplicate disposition ${disposition.id}.`);
    dispositions.set(disposition.id, disposition);
  }
  const occupied = new Map<string, { interval: PlacementInterval; task: NimbusTask; protectedTask: boolean }[]>();
  for (const task of tasks) {
    const protectedTask = taskIsFirmed(snapshot, task);
    const patch = patches.get(taskId(task));
    const result = { ...task, ...patch?.changes };
    const disposition = dispositions.get(taskId(task));
    if (!disposition) add('accounting', 'Every scoped order requires one disposition.', task);
    if (disposition && (disposition.line !== String(task.MACHINE) || (disposition.status === 'protected') !== protectedTask)) add('accounting', 'Disposition line or protected status disagrees with the baseline.', task);
    if (protectedTask && patch) add('protected_changed', 'Protected orders must be preserved exactly.', task);
    if (result.planning_status === 'needs_planning') {
      if (protectedTask) continue;
      if (result.start_date !== null || result.end_date !== null || result.scheduleSegments?.length || !result.planning_reason?.code) add('queue_shape', 'Queued orders require null dates, no segments and a structured reason.', task);
      if (disposition?.status !== 'needs_planning') add('accounting', 'Disposition disagrees with queued state.', task);
      continue;
    }
    if (disposition && disposition.status !== (protectedTask ? 'protected' : 'scheduled')) add('accounting', 'Disposition disagrees with scheduled state.', task);
    const intervals = productiveIntervals(result);
    const start = timestamp(result.start_date); const end = timestamp(result.end_date);
    if (!start || !end || !intervals.length || intervals.some(i => i.end <= i.start) || +intervals[0].start !== +start || +intervals.at(-1)!.end !== +end) {
      add('invalid_schedule', 'Scheduled dates and segments must describe a positive interval.', task, protectedTask); continue;
    }
    const defect = planningDefect(snapshot, bounds, task);
    if (defect) add(defect.code, defect.message, task, protectedTask);
    const floor = notBeforeFor(bounds, task); const ceiling = notAfterFor(bounds, task);
    if ((!protectedTask && (+start < +bounds.now || end > bounds.horizonEnd)) || (floor && start < floor) || (ceiling && end > ceiling)) add('date_window', 'Production lies outside its allowed planning window.', task, protectedTask);
    const minutes = intervals.reduce((sum, i) => sum + (+i.end - +i.start) / 60000, 0);
    if (Math.abs(minutes - Math.round(Number(task.RUN_TIME) * 60)) > 0.001) add('runtime', 'Productive duration does not match runtime.', task, protectedTask);
    const policy = splitOrderPolicyForSnapshot(snapshot, bounds.setup.plant);
    if (intervals.length > 1 && (policy === 'never' || (policy === 'overlong_only' && hasNominalWindow(snapshot, String(task.MACHINE), bounds.setup.plant, start, Math.round(Number(task.RUN_TIME) * 60), bounds.runContext)))) add('split_policy', 'Order splitting violates plant policy.', task, protectedTask);
    const minimum = minProductiveSegmentMinutesForSnapshot(snapshot, bounds.setup.plant);
    for (let index = 0; index < intervals.length; index++) {
      const interval = intervals[index];
      if (index && intervals[index - 1].end > interval.start) add('segments', 'Productive segments overlap or are out of order.', task, protectedTask);
      if (intervals.length > 1 && (+interval.end - +interval.start) / 60000 < minimum) add('segment_floor', 'A productive segment is below the plant minimum.', task, protectedTask);
      const free = freeIntervalsFor(snapshot, String(task.MACHINE), bounds.setup.plant, interval.start, interval.end, bounds.runContext);
      if (!coversInterval(free, interval)) add('calendar', 'Production overlaps nonworking time or a blackout.', task, protectedTask);
      const line = String(task.MACHINE); const list = occupied.get(line) ?? []; list.push({ interval, task: result, protectedTask }); occupied.set(line, list);
    }
  }
  for (const list of occupied.values()) {
    list.sort((a, b) => +a.interval.start - +b.interval.start);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length && list[j].interval.start < list[i].interval.end; j++) {
      const reject = list[j].protectedTask ? list[i].task : list[i].protectedTask ? list[j].task : urgencyOrder(snapshot, bounds, String(list[i].task.MACHINE), [list[i].task, list[j].task])[1];
      add('capacity_overlap', `Orders ${taskId(list[i].task)} and ${taskId(list[j].task)} overlap.`, reject, list[i].protectedTask && list[j].protectedTask);
    }
  }
  // Setup occupies the calendar immediately before each productive start.
  const proposed = applyPatchesToSnapshot(tasks, candidate.patches).filter(task => task.planning_status !== 'needs_planning' && timestamp(task.start_date) && timestamp(task.end_date));
  const lines = new Set(proposed.map(task => String(task.MACHINE)));
  for (const line of lines) {
    const lineTasks = proposed.filter(task => String(task.MACHINE) === line).sort((a, b) => +timestamp(a.start_date)! - +timestamp(b.start_date)! || ordinalCompare(taskId(a), taskId(b)));
    const definition = bounds.setup.definition;
    let state = definition ? initialStateForLine(bounds, line, definition.signature_version).state : null;
    let predecessor: NimbusTask | null = null;
    for (const task of lineTasks) {
      const protectedTask = taskIsFirmed(snapshot, task);
      const successor = definition ? stateForOrder(task, definition) : null;
      const resolution = definition && state && successor && !setupCompatibilityForLine(snapshot, bounds.setup.plant, line) ? resolveSetup({ definition, machine: line, predecessorState: state, successorState: successor, predecessorOrderId: predecessor ? taskId(predecessor) : null, successorOrderId: taskId(task), plantRows: bounds.setup.plant_rows, machineRows: bounds.setup.machine_rows, overrides: bounds.setup.overrides }) : null;
      if (!resolution?.covered && !bounds.setup.synthetic) findings.push({ code: 'missing_setup', message: 'A missing setup transition uses zero minutes.', severity: 'warning', taskId: taskId(task), line });
      const minutes = resolution?.covered ? resolution.effectiveMin ?? 0 : 0;
      if (minutes > 0) {
        const end = timestamp(task.start_date)!; const start = new Date(+end - minutes * 60000);
        const floor = notBeforeFor(bounds, task);
        if ((!protectedTask && start < bounds.now) || (floor && start < floor)) add('setup_floor', 'Setup begins before the allowed placement floor.', task, protectedTask);
        const free = freeIntervalsFor(snapshot, line, bounds.setup.plant, start, end, bounds.runContext);
        if (!coversInterval(free, { start, end })) add('setup_calendar', 'Setup overlaps nonworking time or a blackout.', task, protectedTask);
        if (predecessor && timestamp(predecessor.end_date)! > start) {
          const bothProtected = protectedTask && taskIsFirmed(snapshot, predecessor);
          add('setup_overlap', 'Required setup overlaps preceding production.', protectedTask && !bothProtected ? predecessor : task, bothProtected);
        }
      }
      predecessor = task; state = successor;
    }
  }
  return findings;
}

export function validateCandidateForApply(candidate: Readonly<CandidateResult>, currentSnapshot: Readonly<ScheduleSnapshot>): ValidationFinding[] {
  const context = candidate.validationContext;
  return context ? validateCandidate(context.snapshot, context.bounds, candidate, currentSnapshot) : [];
}

function repairCandidate(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, candidate: CandidateResult): CandidateResult {
  let result = candidate;
  result = { ...result, validationFindings: validateCandidate(snapshot, bounds, result) };
  for (let attempt = 0; attempt < (result.dispositions?.length ?? 0); attempt++) {
    const failures = (result.validationFindings ?? []).filter(f => f.severity === 'error' && f.taskId);
    if (!failures.length) break;
    const reject = new Set(failures.map(f => f.taskId!));
    const repairPatches = result.patches.map(patch => reject.has(patch.id) ? { id: patch.id, changes: { start_date: null, end_date: null, scheduleSegments: [], planning_status: 'needs_planning' as const, planning_reason: { code: 'no_fit_found', message: 'The proposed placement failed final capacity or setup validation.' } } } : patch);
    const repaired = (result.dispositions ?? []).map(d => reject.has(d.id) && d.status !== 'protected' ? { ...d, status: 'needs_planning' as const, reason: { code: 'no_fit_found', message: 'The proposed placement failed final capacity or setup validation.' } } : d);
    result = { ...result, patches: repairPatches, dispositions: repaired };
    result = { ...result, validationFindings: validateCandidate(snapshot, bounds, result) };
  }
  return result;
}

/** Keep compatible placements from the other validated proposal without moving
 * or evicting any order in the preferred admission. Validate additions per line:
 * unrelated lines cannot invalidate them, and the expired search is not rerun. */
function retainCompatiblePlacements(
  snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>,
  preferred: CandidateResult, alternative: CandidateResult,
): CandidateResult {
  const preferredStatus = new Map(preferred.dispositions?.map(d => [d.id, d.status]));
  const additions = new Map(alternative.patches.filter(patch =>
    patch.changes.planning_status === 'scheduled' && preferredStatus.get(patch.id) === 'needs_planning',
  ).map(patch => [patch.id, patch]));
  if (!additions.size) return preferred;
  const patches = new Map(preferred.patches.map(patch => [patch.id, patch]));
  const dispositions = new Map(preferred.dispositions?.map(d => [d.id, d]));
  const byLine = new Map<string, NimbusTask[]>();
  for (const item of eligibleTasks(snapshot, bounds)) {
    const line = String(item.MACHINE);
    const tasks = byLine.get(line) ?? []; tasks.push(item); byLine.set(line, tasks);
  }
  for (const [line, tasks] of byLine) {
    let pending = urgencyOrder(snapshot, bounds, line, tasks).filter(item => additions.has(taskId(item)));
    if (!pending.length) continue;
    const localSnapshot = { ...snapshot, tasks };
    const localBounds = { ...bounds, lines: [line] };
    let progressed = true;
    while (pending.length && progressed) {
      progressed = false;
      const retry: NimbusTask[] = [];
      for (const item of pending) {
        const id = taskId(item);
        const placement = additions.get(id)!;
        const disposition: PlanningDisposition = { id, line, status: 'scheduled' };
        const proposal = {
          ...preferred,
          patches: tasks.flatMap(peer => taskId(peer) === id ? [placement] : patches.has(taskId(peer)) ? [patches.get(taskId(peer))!] : []),
          dispositions: tasks.map(peer => taskId(peer) === id ? disposition : dispositions.get(taskId(peer))!),
        };
        const errors = validateCandidate(localSnapshot, localBounds, proposal).filter(f => f.severity === 'error');
        if (!errors.length) {
          patches.set(id, placement); dispositions.set(id, disposition); progressed = true;
        } else if (errors.every(f => f.code.startsWith('setup_'))) {
          // Another accepted addition can supply a setup bridge. Production
          // overlaps and window failures cannot be repaired by adding orders.
          retry.push(item);
        }
      }
      pending = retry;
    }
  }
  const result = { ...preferred, patches: [...patches.values()], dispositions: [...dispositions.values()] };
  return { ...result, validationFindings: validateCandidate(snapshot, bounds, result) };
}

function finalizeCandidate(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, candidate: CandidateResult): CandidateResult {
  const originals = new Map(snapshot.tasks.map(task => [taskId(task), task]));
  const patches = new Map(candidate.patches.map(patch => [patch.id, patch]));
  const dispositions: PlanningDisposition[] = [];
  for (const task of eligibleTasks(snapshot, bounds)) {
    const id = taskId(task); const line = String(task.MACHINE);
    if (taskIsFirmed(snapshot, task)) { patches.delete(id); dispositions.push({ id, line, status: 'protected' }); continue; }
    let patch = patches.get(id);
    const defect = planningDefect(snapshot, bounds, task);
    if (patch && !defect) {
      patch = { ...patch, changes: { ...patch.changes, planning_status: 'scheduled', planning_reason: null } }; patches.set(id, patch);
      dispositions.push({ id, line, status: 'scheduled' });
    } else {
      const reason = defect ?? { code: candidate.diagnostics.limitReached ? 'search_limit' : 'no_fit_found', message: candidate.diagnostics.limitReached ? 'Search ended before a legal placement was found.' : 'No fit found within the available capacity and planning window.' };
      patches.set(id, { id, changes: { start_date: null, end_date: null, scheduleSegments: [], planning_status: 'needs_planning', planning_reason: reason } });
      dispositions.push({ id, line, status: 'needs_planning', reason });
    }
  }
  let result: CandidateResult = { ...candidate, patches: [...patches.values()], dispositions, searchComplete: !candidate.diagnostics.limitReached, validationContext: { snapshot, bounds } };
  // Build the incumbent solely from original intervals. Mixing new candidate
  // placements with restored originals can create artificial overlaps and
  // incorrectly reject a valid, more urgent baseline admission.
  const baselinePatches: SchedulePatch[] = result.patches.map(patch => {
    const original = originals.get(patch.id)!;
    if (baselineWithinWindow(snapshot, bounds, original)) {
      return { id: patch.id, changes: { start_date: original.start_date, end_date: original.end_date, scheduleSegments: original.scheduleSegments ?? [], planning_status: 'scheduled', planning_reason: null } };
    }
    const reason = planningDefect(snapshot, bounds, original) ?? {
      code: candidate.diagnostics.limitReached ? 'search_limit' : 'no_fit_found',
      message: candidate.diagnostics.limitReached ? 'Search ended before a legal placement was found.' : 'No fit found within the available capacity and planning window.',
    };
    return { id: patch.id, changes: { start_date: null, end_date: null, scheduleSegments: [], planning_status: 'needs_planning', planning_reason: reason } };
  });
  const baselineById = new Map(baselinePatches.map(patch => [patch.id, patch.changes]));
  const baselineDispositions: PlanningDisposition[] = dispositions.map(disposition => {
    if (disposition.status === 'protected') return disposition;
    const changes = baselineById.get(disposition.id)!;
    return changes.planning_status === 'scheduled'
      ? { ...disposition, status: 'scheduled', reason: undefined }
      : { ...disposition, status: 'needs_planning', reason: changes.planning_reason! };
  });
  const incumbent = repairCandidate(snapshot, bounds, { ...result, patches: baselinePatches, dispositions: baselineDispositions });
  result = repairCandidate(snapshot, bounds, result);
  const urgency = urgencyOrder(snapshot, bounds, '', eligibleTasks(snapshot, bounds));
  const admitted = (proposal: CandidateResult): string => { const queued = new Set(proposal.dispositions?.filter(d => d.status === 'needs_planning').map(d => d.id)); return urgency.map(task => queued.has(taskId(task)) ? '1' : '0').join(''); };
  const preferIncumbent = (admitted(incumbent) < admitted(result) || (admitted(incumbent) === admitted(result) && compareFinalObjectives(snapshot, bounds, incumbent, result) < 0)) && !incumbent.validationFindings?.some(f => f.severity === 'error');
  result = preferIncumbent
    ? retainCompatiblePlacements(snapshot, bounds, incumbent, result)
    : retainCompatiblePlacements(snapshot, bounds, result, incumbent);
  return refreshFinalMetrics(snapshot, bounds, result);
}

function refreshFinalMetrics(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, result: CandidateResult): CandidateResult {
  const originals = new Map(snapshot.tasks.map(task => [taskId(task), task]));
  const explanations = [...result.explanation];
  const score = [...result.score];
  const final = applyPatchesToSnapshot(snapshot.tasks, result.patches);
  const scopeIds = new Set(result.dispositions?.map(d => d.id));
  const predecessorById = new Map<string, string | null>();
  const orderedFinal = final.filter(task => scopeIds.has(taskId(task)) && task.planning_status !== 'needs_planning' && timestamp(task.start_date)).sort((a, b) => ordinalCompare(String(a.MACHINE), String(b.MACHINE)) || +timestamp(a.start_date)! - +timestamp(b.start_date)! || ordinalCompare(taskId(a), taskId(b)));
  for (let index = 0; index < orderedFinal.length; index++) predecessorById.set(taskId(orderedFinal[index]), index && orderedFinal[index - 1].MACHINE === orderedFinal[index].MACHINE ? taskId(orderedFinal[index - 1]) : null);
  const definition = bounds.setup.definition;
  const unknownStateIds = new Set(orderedFinal.flatMap(task => definition && !stateForOrder(task, definition) ? [taskId(task)] : []));
  const missingFindingIds = new Set((result.validationFindings ?? [])
    .filter(finding => finding.code === 'missing_setup' && finding.taskId)
    .map(finding => finding.taskId!));
  const edgeReasons = new Map<string, 'successor-state-unknown' | 'scheduled-without-setup' | 'initial-state-unknown'>();
  for (const line of new Set(orderedFinal.map(task => String(task.MACHINE)))) {
    const lineTasks = orderedFinal.filter(task => String(task.MACHINE) === line);
    let previousState = definition ? initialStateForLine(bounds, line, definition.signature_version).state : null;
    let previousUnknown = false;
    for (const task of lineTasks) {
      const successorState = definition ? stateForOrder(task, definition) : null;
      if (missingFindingIds.has(taskId(task))) {
        edgeReasons.set(taskId(task), !successorState || previousUnknown
          ? 'successor-state-unknown'
          : previousState ? 'scheduled-without-setup' : 'initial-state-unknown');
      }
      previousUnknown = !successorState;
      previousState = successorState;
    }
  }
  const actualMissing = (result.validationFindings ?? []).filter(f => f.code === 'missing_setup' && f.taskId).map(f => {
    const predecessorOrderId = predecessorById.get(f.taskId!) ?? null;
    return { line: f.line!, predecessorOrderId, successorOrderId: f.taskId!, reason: edgeReasons.get(f.taskId!) ?? 'scheduled-without-setup' };
  });
  const knownUncovered = actualMissing.filter(edge => edge.reason === 'scheduled-without-setup');
  const unknownEdges = actualMissing.length - knownUncovered.length;
  for (const task of orderedFinal) {
    if (!unknownStateIds.has(taskId(task))) continue;
    if (!explanations.some(reason => reason.code === 'unknown-setup-tail-placement' && reason.taskId === taskId(task))) {
      explanations.push({
        code: 'unknown-setup-tail-placement',
        message: `Placed ${taskId(task)} after the known setup sequence because its signature is unresolved.`,
        line: String(task.MACHINE),
        taskId: taskId(task),
      });
    }
  }
  const changedPatches = result.patches.filter(patch => {
    const original = originals.get(patch.id)!;
    if (patch.changes.planning_status !== 'scheduled' || original.planning_status === 'needs_planning' || original.planning_reason) return true;
    return +timestamp(original.start_date)! !== +timestamp(patch.changes.start_date)! || +timestamp(original.end_date)! !== +timestamp(patch.changes.end_date)! || JSON.stringify(original.scheduleSegments ?? []) !== JSON.stringify(patch.changes.scheduleSegments ?? []);
  });
  const finalMissingEdges = uniqueMissingEdges([
    ...result.missingEdges.filter(edge => !['scheduled-without-setup', 'successor-state-unknown', 'initial-state-unknown'].includes(edge.reason)),
    ...actualMissing,
  ]);
  const objective = objectiveFactsForCandidate(snapshot, bounds, { ...result, missingEdges: finalMissingEdges });
  score[0] = objective.hardErrors;
  score[1] = [...new Set(orderedFinal.map(task => String(task.MACHINE)))].reduce((sum, line) => sum + policyScore(snapshot, bounds.setup.plant, line, orderedFinal.filter(task => String(task.MACHINE) === line), bounds.runContext), 0);
  score[2] = objective.lateCount;
  score[3] = objective.latenessMinutes;
  score[4] = -objective.scheduledCount;
  score[5] = objective.setupMinutes;
  score[SCORE_UNCOVERED] = objective.uncoveredEdges;
  score[SCORE_OVER_CAP] = objective.overCap;
  const diagnostics: SearchDiagnostics = {
    ...result.diagnostics,
    budgetMs: result.diagnostics.budgetMs ?? Math.max(0, bounds.deadline),
    deadlineAt: result.diagnostics.deadlineAt ?? bounds.deadline,
    iterationsUsed: result.diagnostics.iterationsUsed ?? result.diagnostics.candidateCount,
    eligibleCount: result.diagnostics.eligibleCount ?? scopeIds.size,
    evaluatedCount: result.diagnostics.evaluatedCount ?? result.diagnostics.candidateCount,
    placedCount: result.diagnostics.placedCount ?? orderedFinal.length,
    unknownTailCount: unknownStateIds.size,
    unknownEdgeCount: unknownEdges,
    exhaustive: result.diagnostics.exhaustive ?? result.diagnostics.termination === 'completed',
    quality: result.diagnostics.quality ?? (result.diagnostics.method.endsWith('exact') ? 'exact' : 'heuristic'),
    respectCalendar: result.diagnostics.respectCalendar ?? (bounds.respectCalendar ?? true),
  };
  return { ...result, patches: changedPatches, score, objective, diagnostics, explanation: explanations, missingEdges: finalMissingEdges };
}

/** One final insertion pass, shared across all selected lines. Accepted production
 * stays fixed. A new predecessor can make an earlier failure fit, so recheck that
 * line until stable or the separate, soft wall-clock budget expires. */
export function fillPlanningGaps(
  snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>,
  candidate: CandidateResult, budgetMs = 1000,
): CandidateResult {
  const started = bounds.clock();
  const expired = (): boolean => bounds.clock() - started >= budgetMs;
  bounds = withRunContext(snapshot, hardBounds(snapshot, { ...bounds, runContext: undefined }));
  const tasks = eligibleTasks(snapshot, bounds);
  const patches = new Map(candidate.patches.map(p => [p.id, p]));
  const dispositions = new Map(candidate.dispositions?.map(d => [d.id, d]));
  const pending = urgencyOrder(snapshot, bounds, '', tasks).filter(task =>
    dispositions.get(taskId(task))?.status === 'needs_planning' && !planningDefect(snapshot, bounds, task));
  if (!pending.length) return { ...candidate, gapFill: { complete: true, placed: 0, unchecked: 0, runtimeMs: bounds.clock() - started } };
  const revision = new Map<string, number>();
  const checked = new Map<string, number>();
  const availability = new Map<string, PlacementInterval[]>();
  const byLine = new Map<string, NimbusTask[]>();
  for (const task of tasks) {
    const line = String(task.MACHINE);
    const peers = byLine.get(line) ?? []; peers.push(task); byLine.set(line, peers);
  }
  const definition = bounds.setup.definition;
  const state = (task: NimbusTask): SetupStateKey | null => definition ? orderState(bounds, task, definition) : null;
  let placed = 0;
  // Do not try to repair an internally invalid proposal by inserting more work.
  const valid = !validateCandidate(snapshot, bounds, candidate).some(f => f.severity === 'error');
  while (valid && !expired()) {
    const task = pending.find(item => dispositions.get(taskId(item))?.status === 'needs_planning'
      && checked.get(taskId(item)) !== (revision.get(String(item.MACHINE)) ?? 0));
    if (!task) break;
    const id = taskId(task); const line = String(task.MACHINE);
    const peers = byLine.get(line)!;
    const lineIds = new Set(peers.map(taskId));
    const accepted = applyPatchesToSnapshot(peers, [...patches.values()]).filter(item =>
      dispositions.get(taskId(item))?.status !== 'needs_planning' && timestamp(item.start_date) && timestamp(item.end_date),
    ).sort((a, b) => +timestamp(a.start_date)! - +timestamp(b.start_date)! || ordinalCompare(taskId(a), taskId(b)));
    if (!availability.has(line)) availability.set(line, freeIntervalsFor(snapshot, line, bounds.setup.plant, bounds.now, bounds.horizonEnd, bounds.runContext));
    const free = availability.get(line)!;
    const transition = (predecessor: NimbusTask | null, successor: NimbusTask): number | null => {
      const from = predecessor ? state(predecessor) : definition ? initialStateForLine(bounds, line, definition.signature_version).state : null;
      const to = state(successor);
      if (definition && inactiveOverrideForTransition(bounds, line, from, to, predecessor ? taskId(predecessor) : null, taskId(successor), lineIds, true)) return null;
      if (!definition || !from || !to || setupCompatibilityForLine(snapshot, bounds.setup.plant, line)) return 0;
      const resolution = resolveSetup({ definition, machine: line, predecessorState: from, successorState: to,
        predecessorOrderId: predecessor ? taskId(predecessor) : null, successorOrderId: taskId(successor),
        plantRows: bounds.setup.plant_rows, machineRows: bounds.setup.machine_rows, overrides: bounds.setup.overrides,
        index: bounds.runContext?.resolutionIndex ?? undefined });
      return resolution.covered ? resolution.effectiveMin ?? 0 : 0;
    };
    let cursor = +bounds.now;
    let predecessor: NimbusTask | null = null;
    let completed = true;
    for (let index = 0; index <= accepted.length; index++) {
      if (expired()) { completed = false; break; }
      const next = accepted[index];
      const gapEnd = Math.min(+bounds.horizonEnd, next ? +timestamp(next.start_date)! : Infinity);
      const floor = Math.max(cursor, +(notBeforeFor(bounds, task) ?? bounds.now));
      const incoming = gapEnd > floor ? transition(predecessor, task) : null;
      const outgoing = next && incoming !== null ? transition(task, next) : 0;
      if (incoming !== null && outgoing !== null) {
        const nextStart = next ? +timestamp(next.start_date)! : gapEnd;
        const setupStart = nextStart - outgoing * 60000;
        const ceiling = Math.min(gapEnd, setupStart, +(notAfterFor(bounds, task) ?? bounds.horizonEnd));
        const outgoingFits = !next || outgoing === 0 || (
          setupStart >= +(notBeforeFor(bounds, next) ?? bounds.now)
          && coversInterval(nextStart > +bounds.horizonEnd
            ? freeIntervalsFor(snapshot, line, bounds.setup.plant, new Date(setupStart), new Date(nextStart), bounds.runContext) : free,
          { start: new Date(setupStart), end: new Date(nextStart) }));
        if (ceiling > floor && outgoingFits) {
          const runtimeMinutes = Math.round(Number(task.RUN_TIME) * 60);
          const policy = bounds.runContext!.splitOrderPolicy;
          const placement = placeWithSetup({ earliestStart: new Date(floor), runtimeMinutes,
            setup: { kind: 'resolved', minutes: incoming }, policy,
            isInherentlyOverlong: policy === 'overlong_only' && !hasNominalWindow(snapshot, line, bounds.setup.plant, new Date(floor), runtimeMinutes, bounds.runContext),
            minProductiveSegmentMinutes: bounds.runContext!.minProductiveSegmentMinutes,
            freeIntervals: free.flatMap(slot => {
              const start = Math.max(+slot.start, floor); const end = Math.min(+slot.end, ceiling);
              return end > start ? [{ start: new Date(start), end: new Date(end) }] : [];
            }),
          });
          if (placement.kind === 'placed') {
            const segments = placement.productiveSegments;
            const patch: SchedulePatch = { id, changes: { start_date: segments[0].start, end_date: segments.at(-1)!.end,
              scheduleSegments: segments.length > 1 ? segments.map((segment, i) => ({ sequence: i + 1, startDate: segment.start, endDate: segment.end })) : [],
              planning_status: 'scheduled', planning_reason: null } };
            const disposition: PlanningDisposition = { id, line, status: 'scheduled' };
            const trial = { ...candidate,
              patches: peers.flatMap(peer => taskId(peer) === id ? [patch] : patches.has(taskId(peer)) ? [patches.get(taskId(peer))!] : []),
              dispositions: peers.map(peer => taskId(peer) === id ? disposition : dispositions.get(taskId(peer))!),
            };
            if (!validateCandidate({ ...snapshot, tasks: peers }, { ...bounds, lines: [line] }, trial).some(f => f.severity === 'error')) {
              patches.set(id, patch); dispositions.set(id, disposition); placed++;
              revision.set(line, (revision.get(line) ?? 0) + 1);
              break;
            }
          }
        }
      }
      if (next) {
        // Overlapping protected orders reserve their entire union, including
        // split-order envelopes; the last chronological order supplies state.
        cursor = Math.max(cursor, +timestamp(next.end_date)!);
        predecessor = next;
      }
    }
    if (completed) checked.set(id, revision.get(line) ?? 0);
    else break;
  }
  let unchecked = 0;
  for (const task of pending) {
    const id = taskId(task); const line = String(task.MACHINE);
    if (dispositions.get(id)?.status !== 'needs_planning') continue;
    const complete = checked.get(id) === (revision.get(line) ?? 0);
    if (!complete) unchecked++;
    const reason = complete
      ? { code: 'no_fit_found', message: 'No slot found within the allowed window without moving scheduled orders.' }
      : { code: 'search_limit', message: 'Capacity check incomplete: time limit reached before all available gaps were checked.' };
    patches.set(id, { id, changes: { start_date: null, end_date: null, scheduleSegments: [], planning_status: 'needs_planning', planning_reason: reason } });
    dispositions.set(id, { id, line, status: 'needs_planning', reason });
  }
  const result: CandidateResult = { ...candidate, patches: [...patches.values()], dispositions: [...dispositions.values()],
    unchangedLines: candidate.unchangedLines.filter(line => !revision.has(line)),
    gapFill: { complete: valid && unchecked === 0, placed, unchecked, runtimeMs: bounds.clock() - started } };
  result.validationFindings = validateCandidate(snapshot, bounds, result);
  const final = refreshFinalMetrics(snapshot, bounds, result);
  return { ...final, gapFill: { ...result.gapFill!, runtimeMs: bounds.clock() - started } };
}

function baselineWithinWindow(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, task: NimbusTask): boolean {
  if (task.planning_status === 'needs_planning' || planningDefect(snapshot, bounds, task)) return false;
  const start = timestamp(task.start_date); const end = timestamp(task.end_date);
  const floor = notBeforeFor(bounds, task); const ceiling = notAfterFor(bounds, task);
  return !!(start && end && end > start && start >= bounds.now && (!floor || start >= floor) && (!ceiling || end <= ceiling));
}
function admissionKey(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, line: string, sequence: ReadonlyArray<NimbusTask>, patches: readonly SchedulePatch[], fragmentEnd: Date): string {
  const ids = new Set(patches.map(patch => patch.id));
  return urgencyOrder(snapshot, bounds, line, sequence).map(task => ids.has(taskId(task)) || (fragmentEnd < bounds.horizonEnd && (notAfterFor(bounds, task)?.getTime() ?? Infinity) > +fragmentEnd) ? '0' : '1').join('');
}

function fragmentObjectiveFacts(candidate: Readonly<DueDateCandidate>): ObjectiveFacts {
  return {
    hardErrors: candidate.score[0] ?? 0,
    overCap: candidate.score[SCORE_OVER_CAP] ?? 0,
    lateCount: candidate.score[2] ?? 0,
    latenessMinutes: candidate.score[3] ?? 0,
    uncoveredEdges: candidate.score[SCORE_UNCOVERED] ?? 0,
    setupMinutes: candidate.score[5] ?? 0,
    scheduledCount: Math.max(0, -(candidate.score[4] ?? 0)),
    instabilityMinutes: 0,
    policyKey: candidate.policyKey,
    sequenceKey: candidate.sequenceKey,
  };
}

/** Compare the typed objective facts used by both fragment search and final
 * arbitration. Admission remains a separate prefix comparison because it is
 * derived from the complete candidate's dispositions rather than one
 * fragment. Every remaining term is a lower-is-better scalar or a stable
 * ordinal key. */
export function compareObjectiveFacts(
  left: Readonly<ObjectiveFacts>, right: Readonly<ObjectiveFacts>,
  mode: FragmentMode = 'due-date-first',
): number {
  const compareNumber = (leftValue: number, rightValue: number): number => leftValue - rightValue;
  const compare = (leftValue: number | string, rightValue: number | string, descending = false): number => {
    if (typeof leftValue === 'string' && typeof rightValue === 'string') return ordinalCompare(leftValue, rightValue);
    const result = compareNumber(Number(leftValue), Number(rightValue));
    return descending ? -result : result;
  };
  const terms: Array<[keyof ObjectiveFacts, boolean]> = mode === 'min-changeover'
    ? [
      ['hardErrors', false], ['overCap', false], ['lateCount', false], ['latenessMinutes', false],
      ['uncoveredEdges', false], ['setupMinutes', false], ['policyKey', false],
      ['scheduledCount', true], ['instabilityMinutes', false], ['sequenceKey', false],
    ]
    : mode === 'due-date'
      ? [
        ['hardErrors', false], ['overCap', false], ['lateCount', false], ['latenessMinutes', false],
        ['policyKey', false], ['uncoveredEdges', false], ['setupMinutes', false],
        ['scheduledCount', true], ['instabilityMinutes', false], ['sequenceKey', false],
      ]
      : mode === 'spt'
        ? [
          ['hardErrors', false], ['uncoveredEdges', false], ['overCap', false], ['lateCount', false],
          ['latenessMinutes', false], ['setupMinutes', false], ['scheduledCount', true],
          ['instabilityMinutes', false], ['sequenceKey', false],
        ]
        : mode === 'throughput'
          ? [
            ['hardErrors', false], ['overCap', false], ['uncoveredEdges', false], ['setupMinutes', false],
            ['lateCount', false], ['latenessMinutes', false], ['policyKey', false],
            ['scheduledCount', true], ['instabilityMinutes', false], ['sequenceKey', false],
          ]
          : [
            ['hardErrors', false], ['policyKey', false], ['overCap', false], ['uncoveredEdges', false],
            ['lateCount', false], ['latenessMinutes', false], ['scheduledCount', true],
            ['setupMinutes', false], ['instabilityMinutes', false], ['sequenceKey', false],
          ];
  for (const [key, descending] of terms) {
    const delta = compare(left[key], right[key], descending);
    if (delta) return delta;
  }
  return 0;
}

/** Derive objective facts from the final validated candidate. This function
 * reads only the detached snapshot, bounds, and proposal, so the same result
 * can be attached to a preview, compared at Apply, or tested without Store. */
export function objectiveFactsForCandidate(
  snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, candidate: Readonly<CandidateResult>,
): ObjectiveFacts {
  const ids = new Set(eligibleTasks(snapshot, bounds).map(taskId));
  const tasks = applyPatchesToSnapshot(snapshot.tasks, candidate.patches).filter(task => ids.has(taskId(task)));
  let lateCount = 0; let lateness = 0; let setupMinutes = 0; let instability = 0;
  let overCap = 0;
  const original = new Map(snapshot.tasks.map(task => [taskId(task), task]));
  for (const task of tasks) {
    const end = timestamp(task.end_date); const due = dueTimestamp(task);
    if (task.planning_status === 'needs_planning') {
      lateCount++;
      if (Number.isFinite(due)) lateness += Math.max(0, (+bounds.horizonEnd - due) / 60000);
    } else if (end && Number.isFinite(due) && +end > due) {
      lateCount++;
      lateness += (+end - due) / 60000;
    }
    const ceiling = notAfterFor(bounds, task);
    if (end && ceiling && +end > +ceiling) overCap++;
    const before = timestamp(original.get(taskId(task))?.start_date); const after = timestamp(task.start_date);
    if (before && after) instability += Math.abs(+after - +before) / 60000;
  }
  const definition = bounds.setup.definition;
  if (definition) for (const line of new Set(tasks.map(task => String(task.MACHINE)))) {
    let state = initialStateForLine(bounds, line, definition.signature_version).state;
    let previous: string | null = null;
    const ordered = tasks.filter(task => String(task.MACHINE) === line && task.planning_status !== 'needs_planning' && timestamp(task.start_date)).sort((a,b) => +timestamp(a.start_date)! - +timestamp(b.start_date)! || ordinalCompare(taskId(a), taskId(b)));
    for (const task of ordered) {
      const successor = stateForOrder(task, definition);
      if (state && successor && !setupCompatibilityForLine(snapshot, bounds.setup.plant, line)) {
        const resolved = resolveSetup({ definition, machine: line, predecessorState: state, successorState: successor, predecessorOrderId: previous, successorOrderId: taskId(task), plantRows: bounds.setup.plant_rows, machineRows: bounds.setup.machine_rows, overrides: bounds.setup.overrides, index: bounds.runContext?.resolutionIndex ?? undefined });
        if (resolved.covered) setupMinutes += resolved.effectiveMin ?? 0;
      }
      state = successor; previous = taskId(task);
    }
  }
  const uncoveredKeys = new Set(candidate.missingEdges
    .filter(edge => edge.reason === 'scheduled-without-setup' || edge.reason === UNCOVERED_SETUP_TRANSITION_REASON)
    .map(missingEdgeKey));
  const scheduled = tasks.filter(task => task.planning_status !== 'needs_planning'
    && timestamp(task.start_date) && timestamp(task.end_date));
  const lines = [...new Set(scheduled.map(task => String(task.MACHINE)))].sort(ordinalCompare);
  const orderedByLine = lines.map(line => scheduled
    .filter(task => String(task.MACHINE) === line)
    .sort((left, right) => +timestamp(left.start_date)! - +timestamp(right.start_date)! || ordinalCompare(taskId(left), taskId(right))));
  const policyKey = orderedByLine.map((lineTasks, index) => (
    `${lines[index]}:${policyKeyForSequence(snapshot, bounds.setup.plant, lines[index], lineTasks, bounds.runContext)}`
  )).join('|');
  const sequenceKey = orderedByLine.map((lineTasks, index) => (
    `${lines[index]}:${lineTasks.map(taskId).join(',')}`
  )).join('|');
  const scoreUncovered = Number(candidate.score[SCORE_UNCOVERED]);
  return {
    hardErrors: (candidate.validationFindings ?? []).filter(finding => finding.severity === 'error').length,
    overCap,
    lateCount,
    latenessMinutes: lateness,
    uncoveredEdges: uncoveredKeys.size || (Number.isFinite(scoreUncovered) ? Math.max(0, scoreUncovered) : 0),
    setupMinutes,
    scheduledCount: scheduled.length,
    instabilityMinutes: instability,
    policyKey,
    sequenceKey,
  };
}

function finalObjective(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, candidate: Readonly<CandidateResult>): number[] {
  const facts = objectiveFactsForCandidate(snapshot, bounds, candidate);
  return [facts.lateCount, facts.latenessMinutes, facts.setupMinutes, facts.instabilityMinutes, -facts.scheduledCount];
}
function compareFinalObjectives(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, left: Readonly<CandidateResult>, right: Readonly<CandidateResult>): number {
  return compareObjectiveFacts(
    objectiveFactsForCandidate(snapshot, bounds, left),
    objectiveFactsForCandidate(snapshot, bounds, right),
    (bounds.strategy ?? 'due-date-first') as FragmentMode,
  );
}

function coversInterval(free: readonly PlacementInterval[], interval: PlacementInterval): boolean {
  let cursor = +interval.start;
  for (const slot of free) { if (+slot.start > cursor) return false; cursor = Math.max(cursor, +slot.end); if (cursor >= +interval.end) return true; }
  return false;
}
