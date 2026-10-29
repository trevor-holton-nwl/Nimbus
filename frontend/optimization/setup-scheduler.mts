/*
 * Detached candidate scheduling contract.
 *
 * This module receives the complete scheduling read model as a snapshot and
 * returns only patches. It never mutates Store, DOM, persistence, alerts, or
 * Timeline; the workbench owns the one explicit Store commit after Apply.
 */

import type { RemoveBacklogResult } from './scheduler-contract.mjs';
import { MIN_PRODUCTIVE_SEGMENT_MINUTES, capAwareSequence } from './scheduler-contract.mjs';
import { candidateAllDayWorkHours, candidateDefaultWorkHours, fitsMergedSpan } from '../calendar/calendar-engine.mjs';
import { buildSetupResolutionIndex, normalizedValue, resolveSetup, stateForOrder } from '../setup/setup-domain.mjs';
import type { SetupResolutionIndex } from '../setup/setup-domain.mjs';
import type {
  NimbusBlock,
  ConstraintConfig,
  NimbusLineSetting,
  NimbusMasterData,
  NimbusMasterWorkcenter,
  NimbusPlantBlock,
  NimbusTask,
  OptimizerMode,
  PriorityRankMaps,
  SetupDefinition,
  SetupOccurrenceOverride,
  SetupSnapshot as SetupTruthSnapshot,
  SetupStateKey,
  SetupValueDefault,
  SplitOrderPolicy,
  UnknownSetupPolicy,
  WorkHours,
  PlantCalendarEntry,
} from '../platform/types.mjs';

/** Shared empty value-defaults list so an absent `value_defaults` allocates nothing per resolve call. */
const NO_VALUE_DEFAULTS: ReadonlyArray<SetupValueDefault> = [];

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

/** F2: `normalizedIntervals` minus the alignment/sort/merge work, for arrays
 * `freeIntervalsForPlacement` already produced in that shape. Only the
 * `earliestStart` clip remains; unclipped intervals are reused as-is. */
function clipAlignedIntervals(intervals: ReadonlyArray<MinuteInterval>, earliestStart: Date): MinuteInterval[] {
  const earliest = ceilMinute(earliestStart);
  if (!earliest) return [];
  const earliestMs = earliest.getTime();
  const result: MinuteInterval[] = [];
  for (const interval of intervals) {
    if (interval.start.getTime() >= earliestMs) {
      result.push(interval);
    } else if (interval.end.getTime() > earliestMs) {
      result.push({
        start: new Date(earliestMs), end: interval.end,
        minutes: Math.floor((interval.end.getTime() - earliestMs) / (60 * 1000)),
      });
    }
  }
  return result;
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

function normalizedMinProductiveSegment(value: number | undefined): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : MIN_PRODUCTIVE_SEGMENT_MINUTES;
}

/** True when `placeWithSetup` must place the order whole in a single free
 * interval: `never`, `overlong_only` for an order that is not inherently
 * overlong, or a runtime under the productive-segment floor. The single source
 * of truth for that branch, also used to decide when interval building may stop
 * at the first fit (T3). */
function placementIsContinuous(
  policy: SplitOrderPolicy, isInherentlyOverlong: boolean | undefined, runtimeMinutes: number, minProductiveSegmentMinutes: number,
): boolean {
  return policy === 'never'
    || (policy === 'overlong_only' && isInherentlyOverlong !== true)
    || runtimeMinutes < minProductiveSegmentMinutes;
}

/** T3: minutes of one free interval that satisfy a continuous placement
 * (setup + runtime), or undefined when the placement may split, the setup is
 * unresolved, or the runtime is invalid — in all of which `placeWithSetup`
 * needs every interval and the builder must not stop early. */
function continuousFitMinutes(
  setup: PlaceWithSetupRequest['setup'], runtimeMinutes: number, policy: SplitOrderPolicy,
  isInherentlyOverlong: boolean | undefined, minProductiveSegmentMinutes: number | undefined,
): number | undefined {
  if (!setup || setup.kind !== 'resolved' || !Number.isInteger(setup.minutes) || setup.minutes < 0) return undefined;
  const runtime = Math.round(Number(runtimeMinutes));
  if (!Number.isFinite(runtime) || runtime <= 0) return undefined;
  if (!placementIsContinuous(policy, isInherentlyOverlong, runtime, normalizedMinProductiveSegment(minProductiveSegmentMinutes))) return undefined;
  return setup.minutes + runtime;
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
  const intervals = (request.freeIntervals as unknown as Record<symbol, unknown>)[ALIGNED_FREE] === true
    ? clipAlignedIntervals(request.freeIntervals as ReadonlyArray<MinuteInterval>, request.earliestStart)
    : normalizedIntervals(request.freeIntervals, request.earliestStart);
  if (!intervals.length) return capacityFailure();
  const minProductiveSegmentMinutes = normalizedMinProductiveSegment(request.minProductiveSegmentMinutes);

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

  // Whole-order placement: policy forbids splitting, or the under-floor
  // exemption (explicitly complete-and-unsplit; it does not permit a
  // setup-only tail followed by a tiny continuation). The first interval that
  // holds setup + runtime wins.
  if (placementIsContinuous(request.policy, request.isInherentlyOverlong, runtimeMinutes, minProductiveSegmentMinutes)) {
    const requiredMinutes = setup.minutes + runtimeMinutes;
    for (const interval of intervals) {
      if (interval.minutes < requiredMinutes) continue;
      return place(interval.start, runtimeMinutes, []);
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
  /** Manually firmed ids; callers additionally fold running and
   * frozen-horizon ids in before invoking (SAP's firm flag never locks). */
  firmedIds: ReadonlySet<string> | ReadonlyArray<string>;
  selectedPlant: string | null;
  blocks: ReadonlyArray<NimbusBlock>;
  plantBlocks: ReadonlyArray<NimbusPlantBlock>;
  calendars: Readonly<Record<string, { workHours: WorkHours; inherited?: boolean }>>;
  plants: Readonly<Record<string, PlantCalendarEntry>>;
  lineSettings: Readonly<Record<string, NimbusLineSetting>>;
  masterData: NimbusMasterData | null;
  priorityRankMaps: PriorityRankMaps;
  /** Captured setup truth for detached evaluation. Optional for legacy
   * callers that provide `DueDateFirstBounds.setup` separately. */
  setupSnapshot?: SetupTruthSnapshot | null;
  /** Frozen-horizon value captured with the rest of the read model. */
  frozenHorizonEnd?: Date | null;
  /** Store/read-model revision, diagnostics only (stale Apply is decided by a structural snapshot diff that ignores it). */
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
  /** Largest single-order lateness in minutes (N5, 2026-09). Compared right
   * after `latenessMinutes` in every mode so equal totals prefer the schedule
   * that does not make one already-late order much later. */
  maxLatenessMinutes: number;
  uncoveredEdges: number;
  setupMinutes: number;
  scheduledCount: number;
  instabilityMinutes: number;
  /** Deterministic per-order productive-runtime sequence used by SPT after
   * hard feasibility, admission, and coverage safeguards. */
  productiveRuntimeKey: string;
  productiveRuntimeMinutes: number;
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
  now?: Date | string | number | null;
  /** Explicit wall-clock instant; unlike `startDate`, this is never the
   * planning-window lower bound. */
  runNow?: Date | string | number | null;
  /** Alias for runNow used by audit/replay callers. */
  runAt?: Date | string | number | null;
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
  /** Caller-chosen primary search budget in ms (Normal 8000, Exhaustive 180000). Drives the
   *  iteration cap and the gap-fill budget through the engine's bounds builder; absent = 5000. */
  searchBudgetMs?: number;
  /** Absolute iteration cap replacing the scaled default (deterministic headless runs and tests); absent = scaled default. */
  iterationCap?: number;
  /** Exhaustive mode: also raises exactSearchThreshold / exactSearchLeafCap / convergenceWindow. */
  exhaustive?: boolean;
}

/** All search limits are intentionally supplied by the caller. Stage 0's
 * measurement gate chooses them; this detached evaluator must never invent
 * production thresholds, iteration caps, or time budgets. */
export interface DueDateFirstBounds {
  setup: SetupTruthSnapshot;
  lines?: readonly string[];
  /** Optional detached validation scope. Used by non-search repair modes to
   * keep malformed/out-of-window records out of the apply accounting while
   * retaining only the task ids that the repair actually promises to assess. */
  scopeTaskIds?: readonly string[] | ReadonlySet<string>;
  /** Optional immutable occupancy ids supplied by a repair mode. These rows
   * constrain capacity and setup while remaining outside disposition and
   * objective accounting. */
  boundaryTaskIds?: readonly string[] | ReadonlySet<string>;
  strategy?: FragmentMode;
  exactSearchThreshold: number;
  /** Remove Backlog only: skip the plant's pull/push planning window (no floor, no ceiling, no missing-due
   * defect). Backlog pulls orders off the schedule on purpose, so the window that governs scheduling
   * does not apply to it. Set only in Engine's backlogBounds literal; never serialized (foreground-only). */
  ignorePlantWindow?: boolean;
  /** True for the planner's Exhaustive run: the capacity-check limit message then omits the "choose Exhaustive" advice. */
  exhaustive?: boolean;
  /** Optional ceiling on the number of distinct orderings an exact search may
   * enumerate (default `EXACT_SEARCH_LEAF_CAP`). Engine leaves it unset; tests
   * that pin exact traversal pass `Infinity`. */
  exactSearchLeafCap?: number;
  iterationCap: number;
  /** Soft wall-clock budget for fillPlanningGaps; absent = 1000. */
  gapFillBudgetMs?: number;
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
  /** Internal caller-owned primary budget. Nested comparisons reuse this
   * object so one evaluator run cannot reset its iteration allowance. */
  searchBudget?: SearchBudget;
  /** True uses line/plant calendars and blackout blocks; false uses
   * continuous capacity. */
  respectCalendar?: boolean;
  /** Optional plant rule supplied by the live engine; absent retains detached legacy behavior. */
  notBefore?: (task: NimbusTask) => Date | null;
  /** Frozen-horizon FINISH floor (2026-10-27, D3): no unprotected order may
   * finish before it. Null/absent = none. A run-wide instant (not per task), set
   * by the engine from the snapshot's frozenHorizonEnd; Remove Backlog omits it. */
  finishFloor?: Date | null;
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
  /** F2 test-only off switch: true makes `buildRunContext` skip the per-line
   * free-interval index so the plain day-walk serves every request. Not part
   * of the worker contract. */
  disableFreeIndex?: boolean;
  /** Tool Inventory: Remove Backlog only (set in Engine's backlogBounds literal, never serialized): skips the tool
   * overflow pass, the `tool_overflow` finding and the `tool_unavailable` static defect. */
  ignoreToolRule?: boolean;
  /** Tool Inventory: the base tool facts carried WITH the `snapshot.tasks` reference they were built from; every reader
   * rebuilds when the reference differs. Internal; never serialized. */
  toolIndex?: ToolStatic;
  /** Internal: the per-line gap/retain trials validate a single line, so the plant-wide `tool_overflow` finding is
   * skipped there (the tool check is made through the occupancy index instead). */
  skipToolOverflowFinding?: boolean;
}

/** F2: one line's free intervals over the indexed span. `rs/re` hold the
 * exact day-walk output (raw, possibly adjacent-but-separate at day
 * boundaries, never minute-aligned); `ms/me` hold the same set minute-aligned
 * (start ceil, end floor), empties dropped and touching pieces merged — what
 * `normalizedIntervals` would produce for placement. */
interface FreeIndexEntry {
  rs: Float64Array;
  re: Float64Array;
  ms: Float64Array;
  me: Float64Array;
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
  unknownSetupPolicy: UnknownSetupPolicy;
  unknownSetupDefaultMinutes: number;
  /** N8: taskId -> planning reason for orders this run refused to admit under
   *  'excludeFromSearch'; read by finalizeCandidate/normalizer when the order
   *  ends the run queued, so the planner sees the missing transition instead
   *  of a generic no_fit_found. */
  _setupExclusions: Map<string, { code: string; message: string }>;
  /** Lazy per-task-id memos. */
  _stateForOrder: Map<string, SetupStateKey | null>;
  _stateSignatureKey: Map<string, string | null>;
  _notBefore: Map<string, Date | null>;
  _notAfter: Map<string, Date | null>;
  /** Lazy per-(line, taskId) memos, keyed by NUL-joined `line + taskId`
   *  (mirrors `setup-domain.mts`'s `joinIndexKey` convention). */
  _rankVector: Map<string, number[]>;
  _policyKeyForTask: Map<string, string>;
  /** T1: per-(effective line, taskId) urgency-sort tuple (see `urgencyKeyFor`). */
  _urgencyKey: Map<string, UrgencyKey>;
  /** T4: per-taskId static part of `planningDefect` (see `staticPlanningDefect`). */
  _staticDefect: Map<string, StaticDefectEntry>;
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
  /** O5: lazy per-(line, floor minutes) memo of whether any merged working window can hold one productive
   *  segment of that length (see `unfittableReason`). */
  _floorFits: Map<string, boolean>;
  /** Lazy per-(plant, line, dayStartMs) work-window memo for reading a date-only SAP due date
   *  (see `dueWindowForDay`); distinct from `_dayWindow` because a missing calendar row means
   *  "no calendar" here, not default hours. */
  _dueWindow: Map<string, PlacementInterval | null>;
  /** Per-task memo of the due instant (see `dueInstantMs`); each entry carries the inputs it
   *  was computed from and is ignored when any of them differ. Weak so tasks can be collected. */
  _dueInstant: WeakMap<NimbusTask, DueInstantEntry>;
  /** F2: lazy per-(plant, line) index of the line's free intervals over
   *  `freeIndexSpan`, built once by running the day-walk over the whole span.
   *  Null caches "this line's walk output is not sorted/disjoint, never
   *  index it". Same plant-in-key rationale as `_lineBlocks`. */
  _freeIndex: Map<string, FreeIndexEntry | null>;
  /** F2: [ms, ms] span the free index covers (planningStart floored to local
   *  midnight through horizonEnd); null disables the index entirely
   *  (`bounds.disableFreeIndex`, or an unusable span). Requests outside it
   *  use the plain day-walk. */
  freeIndexSpan: { from: number; through: number } | null;
  /** Lazy per-line pre-filtered active/version-matched overrides consumed by
   *  `inactiveOverrideForTransition` — the per-call residual checks
   *  (successor id, states) still run against this small filtered array. */
  _overridesByLine: Map<string, ReadonlyArray<SetupOccurrenceOverride>>;
  /** Built once, in full, on first use — covers every line at once. */
  _plantByLine: Map<string, string | null> | null;
}

/** F2: the span a run's free index covers, or null when the index is off or
 * the bounds carry no usable dates. */
function freeIndexSpanFor(bounds: Readonly<DueDateFirstBounds>): { from: number; through: number } | null {
  if (bounds.disableFreeIndex === true) return null;
  const start = timestamp(bounds.planningStart ?? bounds.now);
  const end = timestamp(bounds.horizonEnd);
  if (!start || !end) return null;
  const from = new Date(start);
  from.setHours(0, 0, 0, 0);
  return +end > +from ? { from: +from, through: +end } : null;
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
      overrides: bounds.setup.overrides, valueDefaults: bounds.setup.value_defaults ?? NO_VALUE_DEFAULTS,
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
    // N8 fix-up: a synthetic zero-cost snapshot (setup inactive or
    // signature-mismatched — see Engine._syntheticZeroCostSetupSnapshot)
    // never charges the plant default, mirroring how splitOrderPolicy is
    // forced to 'never' when respectCalendar === false just above.
    unknownSetupPolicy: bounds.setup.synthetic ? 'zero' : unknownSetupPolicyForSnapshot(snapshot, plant),
    unknownSetupDefaultMinutes: unknownSetupDefaultMinutesForSnapshot(snapshot, plant),
    _setupExclusions: new Map(),
    _stateForOrder: new Map(),
    _stateSignatureKey: new Map(),
    _notBefore: new Map(),
    _notAfter: new Map(),
    _rankVector: new Map(),
    _policyKeyForTask: new Map(),
    _urgencyKey: new Map(),
    _staticDefect: new Map(),
    _lineBlocks: new Map(),
    _dayWindow: new Map(),
    _floorFits: new Map(),
    _dueWindow: new Map(),
    _dueInstant: new WeakMap(),
    _freeIndex: new Map(),
    freeIndexSpan: freeIndexSpanFor(bounds),
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
  const invalid = (): Date => new Date(Number.NaN);
  const legacyNow = timestamp(bounds.now) ?? invalid();
  const supplied = (value: unknown, fallback: Date): Date => {
    if (value === undefined || value === null) return new Date(fallback);
    return timestamp(value) ?? invalid();
  };
  const planningStart = supplied(bounds.planningStart, legacyNow);
  const runNow = supplied(bounds.runNow, legacyNow);
  // placementStart is derived exclusively from the two authoritative clocks.
  // Validate a legacy supplied value so malformed detached requests fail
  // closed, but never allow it to move the effective floor backwards.
  const suppliedPlacement = bounds.placementStart === undefined || bounds.placementStart === null
    ? null
    : timestamp(bounds.placementStart);
  const placementStart = suppliedPlacement === null && bounds.placementStart !== undefined && bounds.placementStart !== null
    ? invalid()
    : Number.isFinite(planningStart.getTime()) && Number.isFinite(runNow.getTime())
      ? new Date(Math.max(+planningStart, +runNow))
      : invalid();
  return {
    ...bounds,
    now: new Date(placementStart),
    planningStart: new Date(planningStart),
    runNow: new Date(runNow),
    placementStart: new Date(placementStart),
    respectCalendar: bounds.respectCalendar ?? true,
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
  unplacedCount?: number;
  unknownTailCount?: number;
  unknownTailPlacedCount?: number;
  unknownTailUnplacedCount?: number;
  unknownEdgeCount?: number;
  exhaustive?: boolean;
  quality?: 'exact' | 'heuristic';
  respectCalendar?: boolean;
  /** Number of deterministic starting sequences considered by heuristic search. */
  seedCount?: number;
  /** Number of bounded insertion/swap neighborhood moves attempted. */
  localMoveCount?: number;
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
 * independent: fewest uncovered edges outranks every term except the over-cap
 * tier (SCORE_OVER_CAP), which sits just ahead of it (after `policyKey`) and is
 * a no-op for unprotected orders now that the push limit is hard. This ordering is
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
 * score[SCORE_OVER_CAP] is 0 — a provable no-op default. The ceiling is
 * HARD (an order past it is queued, never placed), so this term is also 0 for
 * every unprotected order; it can only count a protected/firmed order that
 * already sits past its ceiling. Kept for score-vector arity. Mode-independent
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
  /** Sibling sub-order ids implicated in a cross-order finding (e.g.
   * `distribution_separation`) — orthogonal to `taskId`, which stays
   * single-task. */
  parents?: readonly string[];
  /** `tool_overflow` only: the tool, copies available, machines in use and the OTHER holder order ids (sorted, capped to
   * 10). Kept out of `message` so the message stays fixed and `_pruneAgainstLive`'s code|taskId|message key is stable. */
  detail?: { tool: string; available: number; inUse: number; holders: readonly string[] };
}
export interface CandidateResult {
  /** A malformed or reversed normalized planning horizon is a caller error;
   * no schedule proposal is produced and Apply must treat this as terminal. */
  status?: 'invalid_horizon';
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
  /** Ids of placed, user-scheduled orders that straddle the window end and are
   * held in place (see `isWindowEndBoundary`). Preview-only tally. */
  windowEndHeldIds?: readonly string[];
  /** Tool Inventory: orders queued to Needs Planning because a tool had no free copy (Wave 6 fills these; absent = none).
   * Plain arrays so they survive the worker structuredClone and `rehydrateOptimizerCandidate`'s spread. */
  toolBlocked?: readonly ToolBlockedEntry[];
  /** Tool Inventory: orders re-placed into a tool-free gap (Wave 6; absent = none). */
  toolMoved?: readonly ToolMovedEntry[];
  /** Tool Inventory: `complete: false` = the overflow pass hit its budget and queued the rest without a full search. */
  toolPass?: { complete: boolean; elapsedMs: number; /** The pass threw (not the stale core): fail closed, Apply is disabled by a tool_overflow_failed error. */ failed?: true; error?: string };
}
/** `cause: 'cascade'` = queued by the repair cascade after a tool move (the old successor needed a longer or an unrecorded
 * setup), not by tool contention itself; `tool` is then the tool of the order whose move caused it. */
export interface ToolBlockedEntry { orderId: string; tool: string; available: number; inUse: number; holderIds: readonly string[]; cause?: 'cascade';
  /** Cascade entries only: the reason code the order carried when the marker was attached; a later relabel to another reason drops the marker. */
  reasonCode?: string }
export interface ToolMovedEntry { orderId: string; tool: string; fromStart: string | null; fromEnd: string | null; toStart: string; toEnd: string }

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
  productiveRuntimeKey?: string;
  productiveRuntimeMinutes?: number;
  /** N5: per-fragment maxima/sums carried beside `score[]` rather than as new
   * score slots — the score vector is pinned 8-wide and is SUMMED across lines
   * (a maximum must not be). Combined with Math.max at fragment concatenation. */
  maxLatenessMinutes?: number;
  instabilityMinutes?: number;
  /** The predecessor identity/state this covered core actually ended on, set
   * only on a feasible result. A subsequent `placeUnknownTail` call or a
   * firmed boundary's incoming-setup reservation chains from this rather than
   * re-deriving it from the fragment's original predecessor. */
  finalState?: SetupStateKey | null;
  finalPredecessorOrderId?: string | null;
  /** Orders this sequence refused to admit under the 'excludeFromSearch' unknown-setup policy (both states known,
   * no matrix row), with the reason to show if they end the run unplaced. Carried on the candidate rather than
   * written to the run context so only the ACCEPTED sequence's exclusions are merged (see `applyCandidate`). */
  setupExclusions?: Map<string, { code: string; message: string }>;
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
  /** Heuristic-search accounting; exact runs may leave these at zero. */
  seedCount?: number;
  localMoveCount?: number;
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

/** A completed exact enumeration is the only search that can honestly claim
 * exhaustive quality. Convergence is a deliberate heuristic stop even when
 * the underlying traversal uses the exact-search method label. */
function searchQuality(
  method: SearchDiagnostics['method'], termination: SearchDiagnostics['termination'],
): 'exact' | 'heuristic' {
  return method === 'due-date-first-exact' && termination === 'completed' ? 'exact' : 'heuristic';
}

function searchExhaustive(
  method: SearchDiagnostics['method'], termination: SearchDiagnostics['termination'],
): boolean {
  return searchQuality(method, termination) === 'exact';
}

/** Queue reasons preserve the distinction between a proof of no fit, a hard
 * budget cutoff, and a completed heuristic that did not enumerate every
 * legal sequence. Callers that construct legacy diagnostics without the new
 * fields retain the historic no-fit fallback. */
function noFitReason(
  candidate: Readonly<CandidateResult>,
  completeMessage = 'No fit found within the available capacity and planning window.',
): { code: string; message: string } {
  if (candidate.diagnostics.limitReached) {
    return { code: 'search_limit', message: 'Search ended before a legal placement was found.' };
  }
  // A one-order search has no alternate sequence to discover. Preserve a
  // proven no-fit result for that trivial case even when the surrounding
  // strategy is structurally heuristic (SPT always reports heuristic quality).
  const hasAlternateSequence = (candidate.diagnostics.eligibleCount ?? 2) > 1;
  if (hasAlternateSequence && (candidate.diagnostics.quality === 'heuristic'
    || candidate.diagnostics.exhaustive === false
    || candidate.diagnostics.termination === 'converged')) {
    return {
      code: 'search_incomplete',
      message: 'The heuristic search completed without proving that no alternate legal sequence exists.',
    };
  }
  return { code: 'no_fit_found', message: completeMessage };
}

/** OQ50 c: under the `never` split policy an order whose run time exceeds every contiguous operating window on its
 * line (while the line does have windows) is queued as `overlong_never`, the code the planner's release path keys
 * on. A line with no window at all, or an order that merely failed to find room, keeps its existing reason. */
function neverOverlongReason(
  snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, task: NimbusTask,
): { code: string; message: string } | null {
  const plant = bounds.setup.plant;
  if (splitOrderPolicyForSnapshot(snapshot, plant) !== 'never') return null;
  const minutes = Math.round(Number(task.RUN_TIME) * 60);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const line = String(task.MACHINE);
  const from = bounds.placementStart ?? bounds.now;
  if (hasNominalWindow(snapshot, line, plant, from, minutes, bounds.runContext)) return null;
  if (!hasNominalWindow(snapshot, line, plant, from, 1, bounds.runContext)) return null;
  return {
    code: 'overlong_never',
    message: 'Longer than any single working period on this machine, and this plant does not split orders.',
  };
}

/** O5: the productive segment floor can be longer than every merged working window on the line. Such an order
 * can never be split into floor-sized pieces and does not fit one window either, so the generic no-fit reason
 * hides a setting the planner can change. Emitted only when the order fits no single window (that case never
 * needs a split), the line does have windows, and no window can hold one floor-sized segment. The minimum
 * possible setup is taken as 0, so this never reports a floor that setup alone would make unfittable. Not for
 * the `never` policy: a floor does not apply there, and `neverOverlongReason` already covers it. */
function unfittableReason(
  snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, task: NimbusTask,
): { code: string; message: string } | null {
  const plant = bounds.setup.plant;
  if (splitOrderPolicyForSnapshot(snapshot, plant) === 'never') return null;
  const minutes = Math.round(Number(task.RUN_TIME) * 60);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const floor = bounds.runContext?.minProductiveSegmentMinutes ?? minProductiveSegmentMinutesForSnapshot(snapshot, plant);
  if (!Number.isFinite(floor) || floor <= 0) return null;
  const line = String(task.MACHINE);
  const from = bounds.placementStart ?? bounds.now;
  if (hasNominalWindow(snapshot, line, plant, from, minutes, bounds.runContext)) return null;
  const ctx = bounds.runContext;
  const key = `${line}${CTX_KEY_SEP}${floor}`;
  let floorFits = ctx?._floorFits.get(key);
  if (floorFits === undefined) {
    floorFits = hasNominalWindow(snapshot, line, plant, from, floor, ctx);
    ctx?._floorFits.set(key, floorFits);
  }
  if (floorFits) return null;
  if (!hasNominalWindow(snapshot, line, plant, from, 1, ctx)) return null;
  return {
    code: 'segment_floor_unfittable',
    message: 'The productive segment floor is longer than any working period on this machine, so this order cannot be split into pieces that meet it. Lower the floor in the plant settings or change the machine.',
  };
}

/** O6: the plant's push-forward limit is a HARD ceiling. When an order has one that ends before the horizon and
 * the queue reason would otherwise be the generic `no_fit_found`, name the limit so the planner knows what to
 * change. Only `no_fit_found` is rewritten: `search_incomplete`/`search_limit` (unproven) and the calendar-fact
 * reasons (`overlong_never`, `segment_floor_unfittable`, `expired_window`) are never replaced. */
function pushLimitAware(
  bounds: Readonly<DueDateFirstBounds>, task: NimbusTask, reason: { code: string; message: string },
): { code: string; message: string } {
  if (reason.code !== 'no_fit_found') return reason;
  const ceiling = notAfterFor(bounds, task);
  if (!ceiling || !(+ceiling < +bounds.horizonEnd)) return reason;
  return {
    code: 'push_limit_unmet',
    message: 'No open window in the push/pull-forward range on its current machine.',
  };
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

/** One evaluator-wide counter. Constructed once by each top-level evaluator
 * and threaded through every selected line, fragment, fallback, and internal
 * baseline/candidate comparison so no nested search can reset the primary
 * budget. */
export interface SearchBudget {
  remainingIterations: number;
  iterationsUsed: number;
  startedAt: number;
  deadlineAt: number;
  budgetMs: number;
}

function createSearchBudget(bounds: Readonly<DueDateFirstBounds>): SearchBudget {
  const startedAt = bounds.clock();
  return {
    remainingIterations: bounds.iterationCap,
    iterationsUsed: 0,
    startedAt,
    deadlineAt: bounds.deadline,
    budgetMs: Math.max(0, bounds.deadline - startedAt),
  };
}

function consumeSearchIteration(budget: SearchBudget): boolean {
  if (budget.remainingIterations <= 0) return false;
  budget.remainingIterations -= 1;
  budget.iterationsUsed += 1;
  return true;
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
  seedCount?: number;
  localMoveCount?: number;
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
    // ECMAScript parses a date-only string as UTC, while the scheduler's
    // persisted timestamps are plant wall-clock values. Keep date-only bounds
    // in the same local wall-clock convention as date-time strings without a
    // zone; zoned/instant inputs retain normal Date parsing below.
    const dateOnly = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    const parsed = dateOnly
      ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
      : new Date(value);
    if (dateOnly && (parsed.getFullYear() !== Number(dateOnly[1])
      || parsed.getMonth() !== Number(dateOnly[2]) - 1
      || parsed.getDate() !== Number(dateOnly[3]))) return null;
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

/** What a due-date read needs beyond the task: the snapshot's calendars (a date-only SAP
 * finish arrives as exact midnight and reads as the end of that date's working window), the
 * run's plant when known (else resolved per task), and the run context for memoization. */
export interface DueScope {
  snapshot: Pick<ScheduleSnapshot, 'calendars' | 'plants' | 'lineSettings' | 'masterData'>;
  plant?: string | null;
  ctx?: SetupRunContext;
}

interface DueInstantEntry {
  rawMs: number;
  snapshot: DueScope['snapshot'];
  plant: string | null | undefined;
  line: string;
  core: unknown;
  ms: number;
}

function dueScopeFor(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>): DueScope {
  return { snapshot, plant: bounds.setup.plant, ctx: bounds.runContext };
}

/** The order's SAP due as an instant: a timed value as received; an exact-midnight (date-only)
 * value as the close of that date's (line ∩ plant) working window via the compute core's
 * `dueDateInstant`. A line with no calendar row in the snapshot reads as "no calendar"
 * (raw + 23:59:59), matching `Util.sapDueDate` on the main thread. Null when the order has no
 * SAP due date. */
export function dueInstant(task: NimbusTask, scope: DueScope): Date | null {
  const ms = dueInstantMs(task, scope);
  return ms === null ? null : new Date(ms);
}

/** The due instant as epoch milliseconds (null = no SAP due date), memoized per task on the
 * run context. The memo entry is served only while the raw due value, the snapshot, the
 * scope's plant, the task's line and the compute core all still match, so a changed due, a
 * moved order or a different run never reads a stale instant. A scope with no run context
 * (ad-hoc callers) is never memoized. */
function dueInstantMs(task: NimbusTask, scope: DueScope): number | null {
  const raw = timestamp(task.original_end_date) ?? timestamp(task.ORIGINAL_END_DATE);
  if (!raw) return null;
  const rawMs = raw.getTime();
  const core = globalThis.NimbusComputeCore;
  if (!core?.dueDateInstant) return rawMs;
  const line = task.MACHINE ? String(task.MACHINE) : '';
  const memo = scope.ctx?._dueInstant;
  const hit = memo?.get(task);
  if (hit && hit.rawMs === rawMs && hit.snapshot === scope.snapshot && hit.plant === scope.plant
    && hit.line === line && hit.core === core) return hit.ms;
  const plant = scope.plant ?? resolveTaskPlant(task, scope.snapshot, scope.ctx);
  const ms = core.dueDateInstant(raw, day => {
    const win = line ? dueWindowForDay(scope, line, plant, day) : null;
    return win ? { open: win.start, close: win.end } : null;
  }).getTime();
  memo?.set(task, { rawMs, snapshot: scope.snapshot, plant: scope.plant, line, core, ms });
  return ms;
}

/** (line ∩ plant) work window of one calendar day for due-date reading, or null when closed or
 * when the snapshot holds no calendar row for the line. Memoized per (plant, line, day) on the
 * run context (a separate memo from `_dayWindow`: that one falls back to default hours). */
function dueWindowForDay(scope: DueScope, line: string, plant: string | null, day: Date): PlacementInterval | null {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const key = `${plant ?? ''}${CTX_KEY_SEP}${line}|${dayStart.getTime()}`;
  const memo = scope.ctx?._dueWindow;
  if (memo?.has(key)) return memo.get(key)!;
  const lineRow = scope.snapshot.calendars[line];
  let result: PlacementInterval | null = null;
  if (lineRow) {
    const lineWin = localWindow(lineRow.workHours, dayStart);
    const plantRow = plant ? scope.snapshot.plants[plant] : undefined;
    // An inherited line is open all day and relies on the plant to bound it; with no plant entry use the default week.
    const plantWin = plantRow ? localWindow(plantHoursOn(plantRow, dayStart)!, dayStart)
      : lineRow.inherited ? localWindow(candidateDefaultWorkHours(), dayStart) : lineWin;
    result = lineWin && plantWin ? intersectWindows(lineWin, plantWin) : null;
    if (result && result.start >= result.end) result = null;
  }
  memo?.set(key, result);
  return result;
}

function dueTimestamp(task: NimbusTask, scope: DueScope): number {
  return dueInstantMs(task, scope) ?? Number.MAX_SAFE_INTEGER;
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
  const scope: DueScope = { snapshot, plant, ctx };
  const decorated = tasks.map(task => ({ task, key: policyKeyForTask(snapshot, plant, line, task, ctx) }));
  decorated.sort((left, right) => (
    ordinalCompare(left.key, right.key)
    || dueTimestamp(left.task, scope) - dueTimestamp(right.task, scope)
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
  const scope: DueScope = { snapshot, plant, ctx };
  const decorated = tasks.map(task => ({ task, key: policyKeyForTask(snapshot, plant, line, task, ctx) }));
  decorated.sort((left, right) => (
    dueTimestamp(left.task, scope) - dueTimestamp(right.task, scope)
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

function productiveRuntimeKey(tasks: ReadonlyArray<NimbusTask>): string {
  return tasks.map(task => String(productiveRuntimeMinutes(task)).padStart(16, '0')).join('|');
}

function productiveRuntimeTotal(tasks: ReadonlyArray<NimbusTask>): number {
  return tasks.reduce((total, task) => total + productiveRuntimeMinutes(task), 0);
}

function orderedByProductiveRuntime(tasks: ReadonlyArray<NimbusTask>): NimbusTask[] {
  return [...tasks].sort((left, right) => (
    productiveRuntimeMinutes(left) - productiveRuntimeMinutes(right) || taskId(left).localeCompare(taskId(right))
  ));
}

/** Keep heuristic search broad enough to find a useful route while making its
 * work visible and bounded. Exact fragments still enumerate their declared
 * search space; these limits apply only after a fragment is large enough to
 * use the greedy path. */
/** Exact search is only chosen when a fragment has at most this many distinct
 * orderings (multiset permutations). State count alone is not a bound: 12
 * orders in 4 states is 369,600 leaves and drains the whole plant budget. */
const EXACT_SEARCH_LEAF_CAP = 500;

/** N! / (k1! * k2! * ...) built as a product of binomials, so every
 * intermediate is an exact integer. Returns `cap + 1` as soon as the running
 * value exceeds `cap`, which keeps it from overflowing on large fragments. */
function multisetLeafCount(groupSizes: ReadonlyArray<number>, cap: number): number {
  let total = 1;
  let placed = 0;
  for (const size of groupSizes) {
    for (let i = 1; i <= size; i++) {
      placed++;
      // total * placed / i is an exact integer at every step (C(placed, i)
      // accumulated one factor at a time).
      total = (total * placed) / i;
      if (total > cap) return cap + 1;
    }
  }
  return total;
}

function exactSearchEligible(
  groupSizes: ReadonlyArray<number>,
  bounds: Readonly<DueDateFirstBounds>,
): boolean {
  const cap = bounds.exactSearchLeafCap ?? EXACT_SEARCH_LEAF_CAP;
  return groupSizes.length <= bounds.exactSearchThreshold
    && multisetLeafCount(groupSizes, cap) <= cap;
}

const HEURISTIC_INSERTION_LIMIT = 16;
const HEURISTIC_SWAP_LIMIT = 16;

function sequenceIdentity(sequence: ReadonlyArray<NimbusTask>): string {
  return sequence.map(taskId).join('\u0000');
}

/** Stable runtime ordering keeps source order for equal runtimes before using
 * the task id as the final tie-break. This gives SPT a reproducible current
 * order seed without changing its primary productive-runtime rule. */
function orderedByRuntimeThenCurrent(
  tasks: ReadonlyArray<NimbusTask>,
): NimbusTask[] {
  const sourceOrder = new Map(tasks.map((task, index) => [taskId(task), index]));
  return [...tasks].sort((left, right) => (
    productiveRuntimeMinutes(left) - productiveRuntimeMinutes(right)
    || (sourceOrder.get(taskId(left)) ?? Number.MAX_SAFE_INTEGER)
      - (sourceOrder.get(taskId(right)) ?? Number.MAX_SAFE_INTEGER)
    || taskId(left).localeCompare(taskId(right))
  ));
}

/** Earliest slack first is the Due Date mode's second independent view of a
 * fragment. Slack uses the effective due/cap instant minus productive runtime
 * so a long order with the same deadline is considered before a short one. */
function orderedBySlack(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  tasks: ReadonlyArray<NimbusTask>,
): NimbusTask[] {
  const scope = dueScopeFor(snapshot, bounds);
  const decorated = tasks.map(task => {
    const deadline = notAfterFor(bounds, task)?.getTime() ?? dueTimestamp(task, scope);
    const slack = Number.isFinite(deadline)
      ? deadline - productiveRuntimeMinutes(task) * 60 * 1000
      : Number.MAX_SAFE_INTEGER;
    return { task, slack, policy: policyKeyForTask(snapshot, bounds.setup.plant, line, task, bounds.runContext) };
  });
  decorated.sort((left, right) => (
    left.slack - right.slack
    || ordinalCompare(left.policy, right.policy)
    || dueTimestamp(left.task, scope) - dueTimestamp(right.task, scope)
    || taskId(left.task).localeCompare(taskId(right.task))
  ));
  return decorated.map(entry => entry.task);
}

/** Build a deterministic setup-nearest seed by repeatedly selecting the
 * lowest covered transition from the current fragment predecessor. Missing
 * transitions sort after covered ones and then by setup minutes, while the
 * canonical comparator remains responsible for the final winner. */
function orderedBySetupNearest(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  tasks: ReadonlyArray<NimbusTask>,
  fragment: Readonly<FragmentContext>,
): NimbusTask[] {
  const definition = bounds.setup.definition;
  if (!definition) return [...tasks];
  const remaining = [...tasks];
  const dueScope = dueScopeFor(snapshot, bounds);
  const result: NimbusTask[] = [];
  let predecessorState = fragment.predecessorState;
  let predecessorOrderId = fragment.predecessorOrderId;
  while (remaining.length) {
    const ranked = remaining.map(task => {
      const successorState = orderState(bounds, task, definition);
      const resolution = predecessorState && successorState
        ? resolveSetup({
          definition,
          machine: line,
          predecessorState,
          successorState,
          predecessorOrderId,
          successorOrderId: taskId(task),
          plantRows: bounds.setup.plant_rows,
          machineRows: bounds.setup.machine_rows,
          overrides: bounds.setup.overrides, valueDefaults: bounds.setup.value_defaults ?? NO_VALUE_DEFAULTS,
          index: bounds.runContext?.resolutionIndex ?? undefined,
        })
        : null;
      return {
        task,
        covered: !resolution || resolution.covered ? 0 : 1,
        minutes: resolution?.covered ? resolution.effectiveMin ?? 0 : Number.MAX_SAFE_INTEGER,
        policy: policyKeyForTask(snapshot, bounds.setup.plant, line, task, bounds.runContext),
      };
    });
    ranked.sort((left, right) => (
      left.covered - right.covered
      || left.minutes - right.minutes
      || ordinalCompare(left.policy, right.policy)
      || dueTimestamp(left.task, dueScope) - dueTimestamp(right.task, dueScope)
      || taskId(left.task).localeCompare(taskId(right.task))
    ));
    const next = ranked[0].task;
    result.push(next);
    remaining.splice(remaining.findIndex(task => taskId(task) === taskId(next)), 1);
    predecessorState = orderState(bounds, next, definition);
    predecessorOrderId = taskId(next);
  }
  return result;
}

/** Return deterministic seed orders for one covered fragment. Each strategy
 * starts with the ordering that expresses its mode, then considers stable
 * orders that expose a different admission/setup tradeoff. The caller still
 * enforces active adjacency and the shared SearchBudget for every sequence. */
function heuristicSeedOrders(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  tasks: ReadonlyArray<NimbusTask>,
  groups: ReadonlyArray<DueDateGroup>,
  fragment: Readonly<FragmentContext>,
  mode: FragmentMode,
): NimbusTask[][] {
  const policy = orderedByPolicyThenDue(snapshot, bounds.setup.plant, line, tasks, bounds.runContext);
  const due = orderedByDueThenPolicy(snapshot, bounds.setup.plant, line, tasks, bounds.runContext);
  const urgent = mode === 'due-date-first' ? urgencyOrder(snapshot, bounds, line, tasks) : [];
  const runtime = orderedByProductiveRuntime(tasks);
  const runtimeThenCurrent = orderedByRuntimeThenCurrent(tasks);
  const slack = mode === 'due-date' ? orderedBySlack(snapshot, bounds, line, tasks) : [];
  const setupNearest = mode === 'due-date-first' || mode === 'min-changeover' || mode === 'throughput'
    ? orderedBySetupNearest(snapshot, bounds, line, tasks, fragment)
    : [];
  const grouped = groups.flatMap(group => group.tasks);
  const source = [...tasks];
  const seeds = mode === 'spt'
    ? [runtime, due, policy, runtimeThenCurrent, source]
    : mode === 'due-date'
      ? [due, slack, runtime, policy, source]
      : mode === 'min-changeover' || mode === 'throughput'
        ? [setupNearest, grouped, policy, runtime]
        : [policy, urgent, setupNearest, runtime];
  const seen = new Set<string>();
  return seeds.filter(seed => {
    const key = sequenceIdentity(seed);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Generate one bounded insertion and one bounded swap neighborhood. A move
 * is normalized through `orderWithAdjacency`, so active overrides and fixed
 * boundary endpoints remain hard constraints for every evaluated candidate. */
function boundedLocalMoveSequences(
  seed: ReadonlyArray<NimbusTask>,
  fragment: Readonly<FragmentContext>,
  adjacency: Readonly<FragmentAdjacency>,
): NimbusTask[][] {
  const result: NimbusTask[][] = [];
  const seen = new Set<string>([sequenceIdentity(seed)]);
  const add = (raw: NimbusTask[]): boolean => {
    const normalized = orderWithAdjacency(raw, fragment, adjacency);
    if (!normalized) return false;
    const key = sequenceIdentity(normalized);
    if (seen.has(key)) return false;
    seen.add(key);
    result.push(normalized);
    return true;
  };

  let insertionMoves = 0;
  outerInsertion: for (let from = 0; from < seed.length; from += 1) {
    for (let to = 0; to < seed.length; to += 1) {
      if (from === to) continue;
      const moved = [...seed];
      const [task] = moved.splice(from, 1);
      moved.splice(to, 0, task);
      add(moved);
      insertionMoves += 1;
      if (insertionMoves >= HEURISTIC_INSERTION_LIMIT) break outerInsertion;
    }
  }

  let swapMoves = 0;
  outerSwap: for (let left = 0; left < seed.length - 1; left += 1) {
    for (let right = left + 1; right < seed.length; right += 1) {
      const swapped = [...seed];
      [swapped[left], swapped[right]] = [swapped[right], swapped[left]];
      add(swapped);
      swapMoves += 1;
      if (swapMoves >= HEURISTIC_SWAP_LIMIT) break outerSwap;
    }
  }
  return result;
}

function taskIsFirmed(snapshot: Readonly<ScheduleSnapshot>, task: NimbusTask): boolean {
  const firmedIds = snapshot.firmedIds instanceof Set
    ? snapshot.firmedIds
    : new Set(Array.from(snapshot.firmedIds, String));
  // `task.firmed` is a Store mirror and may be stale in a detached snapshot.
  // The caller folds manual/running/frozen protection into this effective set
  // before evaluation; membership in that set is the only authoritative
  // protection contract here.
  return firmedIds.has(taskId(task));
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
function plantByLineMap(
  ctx: SetupRunContext,
  snapshot: Pick<ScheduleSnapshot, 'masterData'>,
): ReadonlyMap<string, string | null> {
  if (ctx._plantByLine) return ctx._plantByLine;
  const map = new Map<string, string | null>();
  for (const row of snapshot.masterData?.lines ?? []) {
    if (!map.has(row.machine)) map.set(row.machine, row.plant ?? null);
  }
  ctx._plantByLine = map;
  return map;
}

export function resolveTaskPlant(
  task: Readonly<NimbusTask>, snapshot: Pick<ScheduleSnapshot, 'lineSettings' | 'masterData'>, ctx?: SetupRunContext,
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

/** The plant's weekly hours on `day`: the dated period covering it replaces the default pattern. No Store
 *  access (this module is detached). A plant with no periods returns its default hours by reference, so
 *  Core-less callers keep working; periods without the compute core fail loudly rather than silently using
 *  the default pattern on dates a period covers (a stale cached worker bundle). */
function plantHoursOn(entry: PlantCalendarEntry | undefined, day: Date): WorkHours | undefined {
  if (!entry) return undefined;
  if (!entry.periods?.length) return entry.workHours;
  const core = (globalThis as any).NimbusComputeCore;
  if (!core || typeof core.plantWorkHoursOn !== 'function') throw new Error('compute-core-stale');
  return core.plantWorkHoursOn(entry, day);
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
  const lineHours = snapshot.calendars[line]?.workHours
    ?? (snapshot.plants[plant] ? candidateAllDayWorkHours() : candidateDefaultWorkHours());
  const plantHours = plantHoursOn(snapshot.plants[plant], dayStart) ?? candidateDefaultWorkHours();
  const result = intersectWindows(localWindow(lineHours, dayStart), localWindow(plantHours, dayStart));
  ctx._dayWindow.set(key, result);
  return result;
}

/** The original day-walk: the exact free intervals for `[from, through]`
 * from the snapshot's calendars and blackouts. `freeIntervalsFor` serves from
 * the F2 index when it can and otherwise lands here. */
function walkFreeIntervals(
  snapshot: Readonly<ScheduleSnapshot>, line: string, plant: string, from: Date, through: Date,
  ctx?: SetupRunContext,
): PlacementInterval[] {
  // B6: fall back to the same default work hours the alerts path and the
  // detached-candidate path already use (schedule-services.mts's
  // setupDefaultWorkHours/candidateDefaultWorkHours) instead of returning []
  // when a line or plant calendar is missing. Without this, one plant with
  // no `Store.plants` entry silently placed nothing for every line in it,
  // while alerts kept computing as though hours existed.
  const lineHours = snapshot.calendars[line]?.workHours
    ?? (snapshot.plants[plant] ? candidateAllDayWorkHours() : candidateDefaultWorkHours());
  const plantEntry = snapshot.plants[plant];
  const result: PlacementInterval[] = [];
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  while (day <= through) {
    const joint = ctx
      ? jointWindowForDay(ctx, snapshot, line, plant, day)
      : intersectWindows(localWindow(lineHours, day), localWindow(plantHoursOn(plantEntry, day) ?? candidateDefaultWorkHours(), day));
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

/** F2: builds (once per plant+line) the index over the run's span, or caches
 * null when the day-walk output over the span is not strictly sorted and
 * disjoint (e.g. work hours that overflow midnight), which binary search
 * could not serve exactly. Returns null whenever this request must use the
 * plain walk: no span, a different snapshot, or a window outside the span. */
function freeIndexFor(
  ctx: SetupRunContext | undefined, snapshot: Readonly<ScheduleSnapshot>, line: string, plant: string,
  from: Date, through: Date,
): FreeIndexEntry | null {
  const span = ctx?.freeIndexSpan;
  if (!ctx || !span || ctx.snapshot !== snapshot || ctx.respectCalendar === false) return null;
  if (!(+from >= span.from && +through <= span.through)) return null; // also rejects NaN
  const key = plant + CTX_KEY_SEP + line;
  const cached = ctx._freeIndex.get(key);
  if (cached !== undefined) return cached;
  // The day-walk only visits days from a request's own midnight, so work
  // hours that spill past a day's edge (outside 0-24) would make a span-wide
  // build include pieces a narrower walk omits. Never index such a line.
  const withinDay = (hours: WorkHours): boolean => Object.values(hours).every(range => (
    !range || range.length !== 2 || (range[0] >= 0 && range[1] <= 24)
  ));
  const lineHours = snapshot.calendars[line]?.workHours
    ?? (snapshot.plants[plant] ? candidateAllDayWorkHours() : candidateDefaultWorkHours());
  const plantHours = snapshot.plants[plant]?.workHours ?? candidateDefaultWorkHours();
  // Every dated period's pattern can replace the default on some day, so each must stay within the day too.
  const periods = snapshot.plants[plant]?.periods ?? [];
  if (!withinDay(lineHours) || !withinDay(plantHours) || !periods.every(period => withinDay(period.workHours))) {
    ctx._freeIndex.set(key, null);
    return null;
  }
  const raw = walkFreeIntervals(snapshot, line, plant, new Date(span.from), new Date(span.through), ctx);
  let sorted = true;
  for (let index = 0; index < raw.length; index += 1) {
    if (!(+raw[index].end > +raw[index].start) || (index && +raw[index].start < +raw[index - 1].end)) { sorted = false; break; }
  }
  if (!sorted) {
    ctx._freeIndex.set(key, null);
    return null;
  }
  const rs = new Float64Array(raw.length);
  const re = new Float64Array(raw.length);
  const alignedStarts: number[] = [];
  const alignedEnds: number[] = [];
  const MIN_MS = 60 * 1000;
  for (let index = 0; index < raw.length; index += 1) {
    const start = +raw[index].start;
    const end = +raw[index].end;
    rs[index] = start;
    re[index] = end;
    const alignedStart = start % MIN_MS ? start + MIN_MS - (start % MIN_MS) : start;
    const alignedEnd = end - (end % MIN_MS);
    if (alignedStart >= alignedEnd) continue;
    if (alignedStarts.length && alignedStart <= alignedEnds[alignedEnds.length - 1]) {
      if (alignedEnd > alignedEnds[alignedEnds.length - 1]) alignedEnds[alignedEnds.length - 1] = alignedEnd;
    } else {
      alignedStarts.push(alignedStart);
      alignedEnds.push(alignedEnd);
    }
  }
  const entry: FreeIndexEntry = { rs, re, ms: Float64Array.from(alignedStarts), me: Float64Array.from(alignedEnds) };
  ctx._freeIndex.set(key, entry);
  return entry;
}

/** First index whose end is strictly after `value`. */
function firstEndAfter(ends: Float64Array, value: number): number {
  let lo = 0;
  let hi = ends.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ends[mid] > value) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/** Derive only the availability present in the supplied immutable snapshot.
 * A missing calendar is unavailable rather than a prompt to synthesize a
 * default calendar into a detached candidate.
 *
 * F2: with a run context, requests inside the run's indexed span are served
 * from the per-line index (binary search + clip) and are exactly what the
 * day-walk would return — raw, unmerged, unaligned. Everything else walks. */
function freeIntervalsFor(
  snapshot: Readonly<ScheduleSnapshot>, line: string, plant: string, from: Date, through: Date,
  ctx?: SetupRunContext,
): PlacementInterval[] {
  if (through <= from) return [];
  if (ctx?.respectCalendar === false) {
    return [{ start: new Date(from), end: new Date(through) }];
  }
  const entry = freeIndexFor(ctx, snapshot, line, plant, from, through);
  if (!entry) return walkFreeIntervals(snapshot, line, plant, from, through, ctx);
  const fromMs = +from;
  const throughMs = +through;
  const result: PlacementInterval[] = [];
  for (let index = firstEndAfter(entry.re, fromMs); index < entry.rs.length && entry.rs[index] < throughMs; index += 1) {
    const start = Math.max(entry.rs[index], fromMs);
    const end = Math.min(entry.re[index], throughMs);
    if (end > start) result.push({ start: new Date(start), end: new Date(end) });
  }
  return result;
}

/**
 * Frozen FINISH floor placement (universal firm, 2026-10-27, D3). Places so the
 * productive finish is at or after `finishFloor`, never starting before
 * `earliestStart`. `attempt(start)` MUST rebuild the free intervals AND
 * `isInherentlyOverlong` from `start` on every call: `freeIntervalsForPlacement`
 * stops at the first fitting interval (T3), so intervals built from an earlier
 * cursor would wrongly leave the order unplaced.
 *
 * - `never` (contiguous): closed form. setup + run sit in one interval, so the
 *   earliest start that can finish at the floor is `floor - setup - run`; if
 *   closed time still leaves the finish short, shift by the shortfall and retry
 *   (bounded).
 * - split-capable policies: a closed-form shift overshoots (windows 0-8 and
 *   24-32, 6 h run, floor 26: the minimal start is 4, a naive shift gives 24),
 *   so bisect between the unconstrained start and a start AT the floor (which
 *   always finishes at or after it) with at most 4 probes, keeping the best
 *   legal result.
 * Returns the last infeasible result when nothing at or after the floor fits.
 */
export function placeWithFinishFloor(
  attempt: (earliestStart: Date) => PlacementResult,
  earliestStart: Date,
  finishFloor: Date | null | undefined,
  setupMinutes: number,
  runtimeMinutes: number,
  policy: SplitOrderPolicy,
): PlacementResult {
  if (!finishFloor) return attempt(earliestStart);
  const floorMs = +finishFloor;
  const earliestMs = +earliestStart;
  const MIN_MS = 60 * 1000;
  const finishOf = (result: PlacementResult): number | null =>
    result.kind === 'placed' && result.productiveSegments.length ? +result.productiveSegments.at(-1)!.end : null;
  if (policy === 'never') {
    let start = Math.max(earliestMs, floorMs - (Math.max(0, setupMinutes) + Math.max(0, runtimeMinutes)) * MIN_MS);
    let result = attempt(new Date(start));
    for (let retry = 0; retry < 4; retry += 1) {
      const finish = finishOf(result);
      if (finish === null || finish >= floorMs) return result;
      start += floorMs - finish;
      result = attempt(new Date(start));
    }
    const finish = finishOf(result);
    if (finish === null || finish >= floorMs) return result;
    return attempt(new Date(Math.max(earliestMs, floorMs)));
  }
  const first = attempt(earliestStart);
  const firstFinish = finishOf(first);
  if (firstFinish === null || firstFinish >= floorMs) return first;
  let hiStart = Math.max(earliestMs, floorMs);
  const top = attempt(new Date(hiStart));
  const topFinish = finishOf(top);
  let best: PlacementResult | null = topFinish !== null && topFinish >= floorMs ? top : null;
  let loStart = earliestMs;
  // Even when the probe at the floor is infeasible (e.g. it overshoots the completion
  // ceiling), an earlier start can still finish just after the floor, so search anyway.
  // A probe that does not place is "too late" (hi moves down); a placed probe that
  // finishes before the floor is "too early" (lo moves up).
  for (let probe = 0; probe < 4; probe += 1) {
    const mid = Math.floor((loStart + hiStart) / 2 / MIN_MS) * MIN_MS;
    if (mid <= loStart || mid >= hiStart) break;
    const result = attempt(new Date(mid));
    const finish = finishOf(result);
    if (finish !== null && finish >= floorMs) { best = result; hiStart = mid; }
    else if (finish === null) hiStart = mid;
    else loStart = mid;
  }
  return best ?? top;
}

/** Marker on arrays `freeIntervalsForPlacement` returns: every interval is
 * minute-aligned, sorted, disjoint, merged and non-empty, so `placeWithSetup`
 * may skip `normalizedIntervals` (it still clips to `earliestStart`). */
const ALIGNED_FREE = Symbol('nimbus.alignedFreeIntervals');

/** F2: free intervals shaped for `placeWithSetup`. Served from the index's
 * pre-normalized arrays and marked so the placement skips re-normalizing
 * them; any request the index cannot serve returns the plain (unmarked)
 * `freeIntervalsFor` output, which `placeWithSetup` normalizes as before. */
function freeIntervalsForPlacement(
  snapshot: Readonly<ScheduleSnapshot>, line: string, plant: string, from: Date, through: Date,
  ctx?: SetupRunContext, stopAfterFitMinutes?: number,
): PlacementInterval[] {
  if (through <= from || ctx?.respectCalendar === false) return freeIntervalsFor(snapshot, line, plant, from, through, ctx);
  const entry = freeIndexFor(ctx, snapshot, line, plant, from, through);
  if (!entry) return freeIntervalsFor(snapshot, line, plant, from, through, ctx);
  const MIN_MS = 60 * 1000;
  const fromMs = +from;
  const throughMs = +through;
  const lower = fromMs % MIN_MS ? fromMs + MIN_MS - (fromMs % MIN_MS) : fromMs;
  const upper = throughMs - (throughMs % MIN_MS);
  const result: MinuteInterval[] = [];
  for (let index = firstEndAfter(entry.me, lower); index < entry.ms.length && entry.ms[index] < upper; index += 1) {
    const start = Math.max(entry.ms[index], lower);
    const end = Math.min(entry.me[index], upper);
    if (end > start) {
      const minutes = (end - start) / MIN_MS;
      result.push({ start: new Date(start), end: new Date(end), minutes });
      // T3: a continuous placement takes the first interval that fits, so
      // later windows can never be chosen. `from` is the placement's
      // earliestStart at both call sites, so the earliestStart clip is already
      // applied above.
      if (stopAfterFitMinutes !== undefined && minutes >= stopAfterFitMinutes) break;
    }
  }
  (result as unknown as Record<symbol, unknown>)[ALIGNED_FREE] = true;
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

/** N8: mirrors splitOrderPolicyForSnapshot — Store-free read of the plant's
 * unknown-setup policy; absent/malformed → 'zero' (today's behavior). */
function unknownSetupPolicyForSnapshot(snapshot: Readonly<ScheduleSnapshot>, plant: string): UnknownSetupPolicy {
  const value = snapshot.masterData?.plants.find(candidate => candidate.plant === plant)?.setup_policy_config?.unknownSetupPolicy;
  return value === 'plantDefaultMinutes' || value === 'excludeFromSearch' ? value : 'zero';
}
/** Tool Inventory: Store-free read of the plant's tooling rule; absent/garbage -> 'off'. Deliberately NOT gated on
 * `bounds.setup.synthetic` (setup-off plants still get the tool rule). */
export function toolingRuleForSnapshot(snapshot: Readonly<ScheduleSnapshot>, plant: string): 'off' | 'hard' {
  const value = snapshot.masterData?.plants?.find(candidate => candidate.plant === plant)?.setup_policy_config?.toolingRule;
  return value === 'hard' ? 'hard' : 'off';
}
function unknownSetupDefaultMinutesForSnapshot(snapshot: Readonly<ScheduleSnapshot>, plant: string): number {
  const value = snapshot.masterData?.plants.find(candidate => candidate.plant === plant)?.setup_policy_config?.unknownSetupDefaultMinutes;
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}
/** Whether an unresolved (unrecorded-state or uncovered-row) transition on
 * this line may ever be charged the plant's configured
 * `plantDefaultMinutes`: the plant must have a real setup definition and the
 * line must not be marked setup-incompatible (the same check
 * `validateCandidate` already applies before calling `resolveSetup`). A
 * synthetic zero-cost snapshot (`bounds.setup.synthetic`) is handled
 * upstream — `buildRunContext` forces `unknownSetupPolicy` to `'zero'` for
 * it — so this predicate only needs to gate the definition/compatibility
 * case; `chargedSetupMinutes` combines both gates. */
function setupChargeableOnLine(bounds: Readonly<DueDateFirstBounds>, snapshot: Readonly<ScheduleSnapshot>, line: string): boolean {
  return !!bounds.setup.definition && !setupCompatibilityForLine(snapshot, bounds.setup.plant, line);
}
/** Minutes to charge for a resolution under the run's unknown-setup policy:
 * covered rows are always their own minutes; an uncovered row (or no row at
 * all) is 0 unless `chargeable` (the line has a real definition and is
 * setup-compatible), in which case it is the plant default. Shared by
 * admission, gap-fill, `placeUnknownTail`, validation and final facts so
 * none of them ever disagree about what a placement actually reserved. */
function chargedSetupMinutes(
  ctx: Readonly<SetupRunContext> | undefined,
  resolved: { covered: boolean; effectiveMin: number | null } | null,
  chargeable: boolean,
): number {
  return chargedSetupMinutesFor(
    ctx?.unknownSetupPolicy, ctx?.unknownSetupDefaultMinutes ?? 0,
    !!resolved?.covered, resolved ? resolved.effectiveMin : null, chargeable,
  );
}
/** The pure rule behind `chargedSetupMinutes`, exported so the Store-backed reconcile / Fix paths in
 * engine.mts charge the plant default the same way the optimizer does (no behavior of its own). */
export function chargedSetupMinutesFor(
  policy: UnknownSetupPolicy | undefined,
  defaultMin: number,
  covered: boolean,
  effectiveMin: number | null,
  chargeable: boolean,
): number {
  if (covered && effectiveMin !== null) return effectiveMin;
  return chargeable && policy === 'plantDefaultMinutes' ? defaultMin : 0;
}

/** Display form of a setup state for exclusion / unrecorded-transition messages. */
function setupStateLabel(state: SetupStateKey | null): string {
  return state?.map(part => part.value).join(' · ') || '?';
}

/** The Task 2 overlong decision is based on nominal line/plant operating
 * windows, not dated blackouts. Keep that same 90-day bounded definition in
 * the detached snapshot evaluator so policy routing remains Store-free. */
function hasNominalWindow(
  snapshot: Readonly<ScheduleSnapshot>, line: string, plant: string, from: Date, runtimeMinutes: number,
  ctx?: SetupRunContext,
): boolean {
  // A line with no calendar row, or a plant with no hours, falls back to the same defaults as
  // `walkFreeIntervals`/`jointWindowForDay` (all-day line when the plant exists, default plant hours), so
  // the overlong decision agrees with where the order can actually be placed.
  const plantEntry = snapshot.plants[plant];
  const lineHours = snapshot.calendars[line]?.workHours
    ?? (plantEntry ? candidateAllDayWorkHours() : candidateDefaultWorkHours());
  if (!Number.isFinite(runtimeMinutes) || runtimeMinutes <= 0) return false;
  const requiredMs = Math.round(runtimeMinutes) * 60 * 1000;
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  // Senior review I9 (OQ47): windows that touch at midnight are one contiguous span, the same definition the
  // backward walk and Calendar.hasNominalWindow use (calendar-engine's fitsMergedSpan).
  const windows = function* (): Generator<{ s: number; e: number } | null> {
    for (let offset = 0; offset < 90; offset += 1) {
      const date = new Date(day);
      date.setDate(day.getDate() + offset);
      // The memo defaults a missing calendar exactly as above, so it is safe to
      // share with `freeIntervalsFor`'s per-(line,day) window cache.
      const joint = ctx
        ? jointWindowForDay(ctx, snapshot, line, plant, date)
        : intersectWindows(localWindow(lineHours, date), localWindow(plantHoursOn(plantEntry, date) ?? candidateDefaultWorkHours(), date));
      yield joint ? { s: joint.start.getTime(), e: joint.end.getTime() } : null;
    }
  };
  return fitsMergedSpan(windows(), requiredMs);
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
  const maxLatenessDelta = (left.maxLatenessMinutes ?? 0) - (right.maxLatenessMinutes ?? 0);
  if (maxLatenessDelta) return maxLatenessDelta;
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

function admittedCount(key: string | undefined): number {
  let count = 0;
  const text = key ?? '';
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 48) count += 1;
  return count;
}

function compareCandidate(left: DueDateCandidate, right: DueDateCandidate,
                          mode: FragmentMode = 'due-date-first'): number {
  // `'due-date'` (2026-09-09) inverts the usual tier order (lateness ahead of
  // both policyKey and coverage) — routed to its own comparator up front
  // rather than folded into the terms below, since it isn't just a
  // reordering of the mode-permuted `terms` list further down.
  if (left.feasible !== right.feasible) return left.feasible ? -1 : 1;
  // Min Changeover (D1/D11) compares admission by COUNT, not by which
  // urgency-ranked orders were admitted ('0' = admitted in the key); more
  // admitted wins, then the objective terms decide. Other modes keep the
  // urgency-ordered string compare unchanged.
  const admissionDelta = mode === 'min-changeover'
    ? admittedCount(right.admissionKey) - admittedCount(left.admissionKey)
    : ordinalCompare(left.admissionKey ?? '', right.admissionKey ?? '');
  if (admissionDelta) return admissionDelta;
  if (mode === 'due-date') return compareDueDateCandidate(left, right);
  if (mode === 'min-changeover' || mode === 'spt') {
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
  // lower-order comparison changes: (Min Changeover and SPT return earlier via
  // compareObjectiveFacts), while
  // Throughput may prefer setup savings and is constrained by its explicit
  // post-evaluation slip gate below.
  const terms = mode === 'throughput' ? [5, 2, 3, 4] : [2, 3, 4, 5];
  for (const index of terms) {
    const delta = (left.score[index] ?? 0) - (right.score[index] ?? 0);
    if (delta) return delta;
    if (index === 3) {
      const maxLatenessDelta = (left.maxLatenessMinutes ?? 0) - (right.maxLatenessMinutes ?? 0);
      if (maxLatenessDelta) return maxLatenessDelta;
    }
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
  // 'admitted-without-setup' / 'admitted-state-unrecorded' / 'firmed-incoming-setup' entries below, then
  // re-run this function once against the chosen winner with the default
  // `false` to get its real explanation. Failure-path entries and
  // `missingEdges` are never suppressed — diagnostics must stay intact
  // regardless of which candidate loses.
  suppressExplanations = false,
): DueDateCandidate {
  const definition = bounds.setup.definition!;
  const dueScope = dueScopeFor(snapshot, bounds);
  let predecessorState = fragment.predecessorState;
  let predecessorOrderId = fragment.predecessorOrderId;
  let cursor = new Date(fragment.start);
  const patches: SchedulePatch[] = [];
  const explanation: CandidateReason[] = [];
  const missingEdges: MissingSetupEdge[] = [];
  const setupExclusions = new Map<string, { code: string; message: string }>();
  let setupMinutes = 0;
  let lateCount = 0;
  let latenessMinutes = 0;
  let maxLatenessMinutes = 0;
  // N5c: Σ|Δstart| in minutes across this fragment's own placements, against
  // each task's pre-patch `start_date` (the same baseline
  // `objectiveFactsForCandidate` reads via `timestamp(...)`). Carried beside
  // `score[]` like `maxLatenessMinutes`, but summed (not maxed) at fragment
  // concatenation since it is already a per-fragment total, not a maximum.
  let instabilityMinutes = 0;
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
  const checkpoints: Array<{ task: NimbusTask; predecessorState: SetupStateKey | null; predecessorOrderId: string | null; cursor: Date; setupMinutes: number; lateCount: number; latenessMinutes: number; maxLatenessMinutes: number; instabilityMinutes: number; overCapCount: number; uncoveredEdgeCount: number }> = [];

  const constraintFailure = (edge: MissingSetupEdge): DueDateCandidate => ({
    feasible: false,
    patches: [],
    score: infeasibleScore(),
    policyKey: '',
    sequenceKey: '',
    unadmitted: [],
    explanation,
    missingEdges: [...missingEdges, edge],
    productiveRuntimeKey: productiveRuntimeKey(sequence),
    productiveRuntimeMinutes: productiveRuntimeTotal(sequence),
  });

  const adjacencyFailure = sequenceAdjacencyFailure(line, sequence, fragment, adjacency);
  if (adjacencyFailure) return constraintFailure(adjacencyFailure);

  // `line` is invariant across this loop — hoist the chargeable-minutes lookup
  // out of the per-task hot path instead of recomputing it at both call sites below.
  const lineChargeable = setupChargeableOnLine(bounds, snapshot, line);

  for (let taskIndex = 0; taskIndex < sequence.length; taskIndex += 1) {
    const task = sequence[taskIndex];
    const priorCursor = new Date(cursor);
    const checkpoint = { task, predecessorState, predecessorOrderId, cursor: priorCursor, setupMinutes, lateCount, latenessMinutes, maxLatenessMinutes, instabilityMinutes, overCapCount, uncoveredEdgeCount };
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
      // N6: an ADMITTED order whose incoming state is simply not recorded is
      // not a rejection. `initial-state-unknown` (still the edge reason above,
      // and still used by the preserved-anchor/rejection paths) trips
      // summarizeCandidate's rejected-token regex; this code and message
      // deliberately avoid unavailable|unknown|uncovered|infeasible|missing|
      // disabled|fail so the preview stamps the order accepted.
      // All three admission sites (candidateForSequence + preambles) use the
      // shared helper to ensure wording consistency.
      effectiveSetupMinutes = chargedSetupMinutes(bounds.runContext, null, lineChargeable);
      if (!suppressExplanations) {
        explanation.push(admittedStateUnrecordedReason(line, task, effectiveSetupMinutes));
      }
      setupRequirement = { kind: 'resolved', minutes: effectiveSetupMinutes };
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
        overrides: bounds.setup.overrides, valueDefaults: bounds.setup.value_defaults ?? NO_VALUE_DEFAULTS,
        index: bounds.runContext?.resolutionIndex ?? undefined,
      });
      if (!resolved.covered || resolved.effectiveMin === null) {
        const ctx = bounds.runContext;
        if (ctx?.unknownSetupPolicy === 'excludeFromSearch') {
          // N8: refuse to admit here; the order stays eligible for later
          // fragments/sequences where its predecessor may be covered. Only if
          // it is never placed does this reason surface (finalizeCandidate).
          // Recorded on THIS candidate only: a losing permutation must not leave an exclusion behind.
          setupExclusions.set(taskId(task), {
            code: 'setup_transition_unrecorded',
            message: `No setup transition is recorded from ${setupStateLabel(predecessorState)} to ${setupStateLabel(successorState)} on ${line}; this plant excludes such orders from automatic placement.`,
          });
          unadmitted.push(task);
          cursor = priorCursor;
          continue;
        }
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
        effectiveSetupMinutes = chargedSetupMinutes(ctx, resolved, lineChargeable);
        if (!suppressExplanations) {
          explanation.push({
            code: 'admitted-without-setup',
            message: `Admitted ${taskId(task)} into the covered sequence without a matching setup transition; charged ${effectiveSetupMinutes} setup minutes.`,
            line,
            taskId: taskId(task),
          });
        }
        setupRequirement = { kind: 'resolved', minutes: effectiveSetupMinutes };
      } else {
        effectiveSetupMinutes = resolved.effectiveMin;
        setupRequirement = { kind: 'resolved', minutes: resolved.effectiveMin };
      }
    }

    const runtimeMinutes = Math.round(Number(task.RUN_TIME) * 60);
    const splitPolicy = bounds.runContext?.splitOrderPolicy ?? splitOrderPolicyForSnapshot(snapshot, bounds.setup.plant);
    const minProductiveSegmentMinutes = bounds.runContext?.minProductiveSegmentMinutes
      ?? minProductiveSegmentMinutesForSnapshot(snapshot, bounds.setup.plant);
    const candidateEnd = completionEnd(bounds, task, fragment.end);
    // Frozen finish floor: a fragment that ends before it can admit nothing.
    const finishFloor = bounds.finishFloor ?? null;
    // Each attempt rebuilds the free intervals and isInherentlyOverlong from ITS start (T3 early exit).
    const attemptPlacement = (earliest: Date): PlacementResult => {
      const isInherentlyOverlong = splitPolicy === 'overlong_only'
        ? !hasNominalWindow(snapshot, line, bounds.setup.plant, earliest, runtimeMinutes, bounds.runContext)
        : undefined;
      return placeWithSetup({
        earliestStart: earliest,
        runtimeMinutes,
        setup: setupRequirement,
        policy: splitPolicy,
        ...(isInherentlyOverlong !== undefined ? { isInherentlyOverlong } : {}),
        freeIntervals: freeIntervalsForPlacement(
          snapshot, line, bounds.setup.plant, earliest, candidateEnd, bounds.runContext,
          continuousFitMinutes(setupRequirement, runtimeMinutes, splitPolicy, isInherentlyOverlong, minProductiveSegmentMinutes),
        ),
        minProductiveSegmentMinutes,
      });
    };
    const placement: PlacementResult = finishFloor && candidateEnd < finishFloor
      ? { kind: 'infeasible', reason: 'no-feasible-capacity', productiveSegments: [] }
      : placeWithFinishFloor(attemptPlacement, cursor, finishFloor, setupRequirement.kind === 'resolved' ? setupRequirement.minutes : 0, runtimeMinutes, splitPolicy);
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
    // Instability is keyed on the finish (Reading A): the placed finish is the anchor, so a task whose
    // finish held but whose start moved because its run time changed is not unstable.
    const priorFinish = timestamp(task.end_date);
    if (priorFinish) instabilityMinutes += Math.abs(last.end.getTime() - priorFinish.getTime()) / 60000;
    setupMinutes += effectiveSetupMinutes;
    const due = dueTimestamp(task, dueScope);
    if (Number.isFinite(due) && last.end.getTime() > due) {
      const lateMinutes = Math.ceil((last.end.getTime() - due) / (60 * 1000));
      lateCount += 1;
      latenessMinutes += lateMinutes;
      maxLatenessMinutes = Math.max(maxLatenessMinutes, lateMinutes);
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
  while (fragment.nextFirmed && predecessorState && checkpoints.length) {
    const boundary = fragment.nextFirmed;
    const outgoing = boundary.state
      ? resolveSetup({ definition, machine: line, predecessorState, successorState: boundary.state, predecessorOrderId, successorOrderId: taskId(boundary.task), plantRows: bounds.setup.plant_rows, machineRows: bounds.setup.machine_rows, overrides: bounds.setup.overrides, valueDefaults: bounds.setup.value_defaults ?? NO_VALUE_DEFAULTS, index: bounds.runContext?.resolutionIndex ?? undefined })
      : null;
    // Under plantDefaultMinutes an uncovered pair, or a boundary with no setup state, still reserves the plant
    // default (same charge the boundary block below and `validateCandidate` make); zero/excludeFromSearch
    // charge 0 here, so they break as before.
    const outgoingMinutes = chargedSetupMinutes(bounds.runContext, outgoing, setupChargeableOnLine(bounds, snapshot, line));
    if (!outgoingMinutes) break;
    const setupStart = new Date(+boundary.start - outgoingMinutes * 60000);
    if (cursor <= setupStart && coversInterval(freeIntervalsFor(snapshot, line, bounds.setup.plant, setupStart, boundary.start, bounds.runContext), { start: setupStart, end: boundary.start })) break;
    const prior = checkpoints.pop()!;
    patches.pop(); unadmitted.push(prior.task);
    predecessorState = prior.predecessorState; predecessorOrderId = prior.predecessorOrderId; cursor = prior.cursor;
    setupMinutes = prior.setupMinutes; lateCount = prior.lateCount; latenessMinutes = prior.latenessMinutes;
    maxLatenessMinutes = prior.maxLatenessMinutes;
    instabilityMinutes = prior.instabilityMinutes;
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
    // Under plantDefaultMinutes the null-state and uncovered edges still reserve the plant default before the
    // firmed order (the charge `validateCandidate` makes), so the predecessor is not dropped at validation.
    const boundaryChargeable = setupChargeableOnLine(bounds, snapshot, line);
    const reserveBoundaryDefault = (): void => {
      const minutes = chargedSetupMinutes(bounds.runContext, null, boundaryChargeable);
      if (!minutes) return;
      const setupStart = new Date(firmed.start.getTime() - minutes * 60 * 1000);
      const fits = setupStart >= cursor && freeIntervalsFor(
        snapshot, line, bounds.setup.plant, cursor, firmed.start, bounds.runContext,
      ).some(interval => interval.start <= setupStart && interval.end >= firmed.start);
      if (!fits) {
        missingEdges.push({
          line,
          predecessorOrderId,
          successorOrderId: taskId(firmed.task),
          reason: 'incoming-firmed-setup-infeasible',
        });
        return;
      }
      setupMinutes += minutes;
      if (!suppressExplanations) {
        explanation.push({
          code: 'firmed-incoming-setup',
          message: `Reserved ${minutes} minutes of setup before firmed ${taskId(firmed.task)}.`,
          line,
          taskId: taskId(firmed.task),
        });
      }
    };
    if (predecessorState === null || firmed.state === null) {
      missingEdges.push(unknownInitialStateEdge(line, firmed.task));
      reserveBoundaryDefault();
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
        overrides: bounds.setup.overrides, valueDefaults: bounds.setup.value_defaults ?? NO_VALUE_DEFAULTS,
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
        reserveBoundaryDefault();
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
    productiveRuntimeKey: productiveRuntimeKey(sequence),
    productiveRuntimeMinutes: productiveRuntimeTotal(sequence),
    maxLatenessMinutes,
    instabilityMinutes,
    finalState: predecessorState,
    finalPredecessorOrderId: predecessorOrderId,
    ...(setupExclusions.size ? { setupExclusions } : {}),
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
        if (!consumeSearchIteration(budget)) {
          termination = 'iteration-cap';
          break;
        }
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
    if (!consumeSearchIteration(budget)) {
      termination = 'iteration-cap';
      break;
    }
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
  const dueScope = dueScopeFor(snapshot, bounds);
  const decoratedTasks = groups.flatMap(group => group.tasks).map(task => (
    { task, key: policyKeyForTask(snapshot, bounds.setup.plant, line, task, bounds.runContext) }
  ));
  decoratedTasks.sort((left, right) => (
    ordinalCompare(left.key, right.key)
    || dueTimestamp(left.task, dueScope) - dueTimestamp(right.task, dueScope)
    || taskId(left.task).localeCompare(taskId(right.task))
  ));
  const orderedTasks = decoratedTasks.map(entry => entry.task);
  let candidateCount = 0;
  let seedCount = 0;
  let localMoveCount = 0;
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
    // F4: Check for duplicate neighbors before consuming a budget iteration,
    // so duplicate sequences don't burn budget.
    const key = sequence.map(taskId).join('\u0000');
    if (seen.has(key)) return null;
    seen.add(key);
    if (!consumeSearchIteration(budget)) {
      termination = 'iteration-cap';
      return null;
    }
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
      // The bounded greedy route could not construct even its protected seed;
      // it did not exhaust the legal search space, so completion would be a
      // false exact-search claim. Preserve the conflict edge while reporting
      // the heuristic conclusion honestly.
      termination: 'converged',
      winner: null,
      missingEdges: [inactiveOverrideEdge(line, null, requiredFirstOrderId(fragment, adjacency))],
      unknownTail: [],
      seedCount,
      localMoveCount,
    };
  }
  // Two-state fragments retain the historical adjacent-swap walk so its
  // small candidate counts and tie behavior stay compatible. Larger greedy
  // fragments use several mode-specific starts and a bounded insertion/swap
  // neighborhood; every move still flows through the same evaluator and
  // shared budget.
  if (groups.length < 3) {
    seedCount = 1;
    let currentOrder = protectedOrder;
    let current = evaluate(currentOrder);
    let improved = true;
    while (improved && termination === 'completed') {
      improved = false;
      for (let index = 0; index < currentOrder.length - 1; index += 1) {
        const neighbor = [...currentOrder];
        [neighbor[index], neighbor[index + 1]] = [neighbor[index + 1], neighbor[index]];
        localMoveCount += 1;
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
  } else {
    const seeds = heuristicSeedOrders(
      snapshot, bounds, line, groups.flatMap(group => group.tasks), groups, fragment, mode,
    );
    for (const seed of seeds) {
      if (termination !== 'completed') break;
      const normalized = orderWithAdjacency(seed, fragment, adjacency);
      if (!normalized) continue;
      seedCount += 1;
      evaluate(normalized);
      if (termination !== 'completed') break;
      for (const move of boundedLocalMoveSequences(normalized, fragment, adjacency)) {
        localMoveCount += 1;
        evaluate(move);
        if (termination !== 'completed') break;
      }
    }
  }
  winner = reexplainWinner(snapshot, bounds, line, winner, winnerSequence, fragment, adjacency);
  return {
    candidateCount,
    method: 'due-date-first-greedy',
    termination: termination === 'completed' ? 'converged' : termination,
    winner,
    missingEdges,
    unknownTail: [],
    seedCount,
    localMoveCount,
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
    // SPT and over-threshold Due Date fragments are still heuristic runs even
    // when the hard adjacency check prevents the first candidate from being
    // evaluated. Reserve `completed` for an exhaustive exact traversal; a
    // bounded heuristic that found no winner has converged on its explored
    // search space.
    const heuristic = mode === 'spt'
      || !exactSearchEligible([...groupsByState.values()].map((g) => g.tasks.length), bounds);
    return {
      candidateCount: 0,
      method: 'due-date-first-exact',
      termination: heuristic ? 'converged' : 'completed',
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
    const workingIds = new Set(workingTasks.map(taskId));
    const sourceOrder = tasks.filter(task => workingIds.has(taskId(task)));
    const allSeeds = heuristicSeedOrders(snapshot, bounds, line, sourceOrder, groups, fragment, mode);
    const seeds = groups.length >= 3 ? allSeeds : allSeeds.slice(0, 2);
    // SPT keeps its runtime-first candidate as the incumbent, then explores
    // deterministic due/policy/current-order seeds and bounded local moves.
    // The shared budget and admission-only replacement rule prevent setup
    // ranking from becoming a hidden SPT objective.
    let candidateCount = 0;
    let seedCount = 0;
    let localMoveCount = 0;
    let termination: SearchRun['termination'] = 'completed';
    let winner: DueDateCandidate | null = null;
    const seen = new Set<string>();
    const addMissingEdges = (evaluated: Readonly<DueDateCandidate>): void => {
      for (const edge of evaluated.missingEdges) {
        if (edge.reason !== UNCOVERED_SETUP_TRANSITION_REASON) continue;
        const key = missingEdgeKey(edge);
        if (!missingEdges.some(existing => missingEdgeKey(existing) === key)) missingEdges.push(edge);
      }
    };
    const isBetterSptCandidate = (left: Readonly<DueDateCandidate>, right: Readonly<DueDateCandidate> | null): boolean => {
      if (!right || left.feasible !== right.feasible) return left.feasible;
      if (!left.feasible) return false;
      // Admission remains the hard strategy gate. Once admissions tie, keep
      // the known coverage safeguard ahead of the deterministic productive
      // runtime sequence, then use the remaining canonical facts as stable
      // tie-breakers. This prevents an SPT seed from winning merely because
      // it was visited first when it leaves an uncovered edge behind.
      const admissionDelta = ordinalCompare(left.admissionKey ?? '', right.admissionKey ?? '');
      if (admissionDelta) return admissionDelta < 0;
      return compareObjectiveFacts(fragmentObjectiveFacts(left), fragmentObjectiveFacts(right), 'spt') < 0;
    };
    const normalizeSptSequence = (base: ReadonlyArray<NimbusTask>): NimbusTask[] | null => (
      orderWithAdjacency(
        capAwareSequence(
          base,
          fragment.start.getTime(),
          task => notAfterFor(bounds, task)?.getTime() ?? null,
          task => productiveRuntimeMinutes(task) * 60 * 1000,
        ),
        fragment,
        adjacency,
      )
    );
    const evaluate = (base: ReadonlyArray<NimbusTask>): DueDateCandidate | null => {
      const sequence = normalizeSptSequence(base);
      if (!sequence) return null;
      const key = sequenceIdentity(sequence);
      if (seen.has(key)) return null;
      if (bounds.clock() >= bounds.deadline) {
        termination = 'deadline';
        return null;
      }
      if (!consumeSearchIteration(budget)) {
        termination = 'iteration-cap';
        return null;
      }
      seen.add(key);
      candidateCount += 1;
      const evaluated = candidateForSequence(snapshot, bounds, line, sequence, fragment, adjacency);
      if (!evaluated.feasible) {
        missingEdges.push(...evaluated.missingEdges);
      } else {
        addMissingEdges(evaluated);
      }
      if (isBetterSptCandidate(evaluated, winner)) winner = evaluated;
      return evaluated;
    };
    for (const seed of seeds) {
      if (termination !== 'completed') break;
      const normalized = normalizeSptSequence(seed);
      if (!normalized) continue;
      seedCount += 1;
      evaluate(normalized);
      if (termination !== 'completed') break;
      if (groups.length >= 3) {
        for (const move of boundedLocalMoveSequences(normalized, fragment, adjacency)) {
          localMoveCount += 1;
          evaluate(move);
          if (termination !== 'completed') break;
        }
      }
    }
    if (!seeds.length || (!winner && candidateCount === 0 && termination === 'completed')) {
      missingEdges.push(inactiveOverrideEdge(line, null, requiredFirstOrderId(fragment, adjacency)));
    }
    // Each seed remains cap-aware: a capped order is pulled ahead only when
    // the runtime-first walk would otherwise exceed its latest allowed start.
    return {
      candidateCount,
      method: 'due-date-first-exact',
      termination: termination === 'completed' ? 'converged' : termination,
      winner,
      missingEdges,
      unknownTail,
      seedCount,
      localMoveCount,
    };
  }

  // A4: the coverage-demotion backstop (Part 1b) is gone — `allUncoveredTransitions`
  // can no longer be true (A1 admits uncovered transitions instead of
  // rejecting the candidate), so a single exact/greedy run replaces the
  // former retry-with-demotion loop.
  const run: SearchRun = exactSearchEligible(groups.map((g) => g.tasks.length), bounds)
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

function admittedStateUnrecordedReason(line: string, task: Readonly<NimbusTask>, minutes = 0): CandidateReason {
  return {
    code: 'admitted-state-unrecorded',
    message: `Admitted ${taskId(task)} as the line's first order; the line's current setup state is not recorded, so charged ${minutes} setup minutes.`,
    line,
    taskId: taskId(task),
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

function belongsBeforeFirmedBoundary(task: NimbusTask, boundary: FirmedBoundary, mode: FragmentMode, scope: DueScope): boolean {
  if (mode === 'due-date-first' || mode === 'due-date') return dueTimestamp(task, scope) <= boundary.start.getTime();
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
      if (!consumeSearchIteration(budget)) {
        termination = 'iteration-cap';
        exhausted = true;
        return null;
      }
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
    productiveRuntimeKey: productiveRuntimeKey(orderedTasks),
    productiveRuntimeMinutes: productiveRuntimeTotal(orderedTasks),
    maxLatenessMinutes: Math.max(preFirmed.maxLatenessMinutes ?? 0, continuation.maxLatenessMinutes ?? 0),
    instabilityMinutes: (preFirmed.instabilityMinutes ?? 0) + (continuation.instabilityMinutes ?? 0),
    ...(preFirmed.setupExclusions || continuation.setupExclusions
      ? { setupExclusions: new Map([...(preFirmed.setupExclusions ?? []), ...(continuation.setupExclusions ?? [])]) }
      : {}),
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
 * its covered core (Part 1c). Setup is charged via `chargedSetupMinutes(...)`
 * — zero by default, or the plant's configured default under the
 * `plantDefaultMinutes` unknown-setup policy — purely as a `placeWithSetup`
 * placement mechanism; never a real changeover, and never added to
 * `score[5]`/setupMinutes. That reservation is counted in
 * `objectiveFactsForCandidate` so validation and the objective never disagree
 * about what the placement actually occupies (see the N8 fix-up comment on
 * `tailChargeableMinutes` below). Capacity, the split policy, and
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
  // N8 fix-up: a tail placement reserves the same chargeable minutes
  // validateCandidate/objectiveFactsForCandidate expect for this line, so
  // the three never disagree about what the placement actually occupies.
  // Definition-less/setup-incompatible lines (chargeable === false) or the
  // 'zero'/default-'excludeFromSearch' policies still reserve zero, exactly
  // as before.
  const tailChargeableMinutes = chargedSetupMinutes(bounds.runContext, null, setupChargeableOnLine(bounds, snapshot, line));
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
    // N8: an order this run refused to admit under 'excludeFromSearch' (both
    // states known, no matrix row) never gets the zero-cost tail fallback
    // either — that would silently defeat the policy. It stays deferred; its
    // recorded _setupExclusions reason surfaces only if it ends the run
    // unplaced everywhere (finalizeCandidate/normalizer).
    if (bounds.runContext?._setupExclusions.has(taskId(task))) { deferred.push(task); continue; }
    const priorCursor = new Date(cursor);
    const pullForwardFloor = notBeforeFor(bounds, task);
    if (pullForwardFloor && cursor < pullForwardFloor) cursor = new Date(pullForwardFloor);
    const runtimeMinutes = Math.round(Number(task.RUN_TIME) * 60);
    const tailSetup = { kind: 'resolved' as const, minutes: tailChargeableMinutes };
    const minProductiveSegmentMinutes = bounds.runContext?.minProductiveSegmentMinutes
      ?? minProductiveSegmentMinutesForSnapshot(snapshot, bounds.setup.plant);
    const tailEnd = completionEnd(bounds, task, capacityEnd);
    const tailFloor = bounds.finishFloor ?? null;
    // Frozen finish floor; every attempt rebuilds the free intervals and isInherentlyOverlong (T3 early exit).
    const attemptTail = (earliest: Date): PlacementResult => {
      const isInherentlyOverlong = splitPolicy === 'overlong_only'
        ? !hasNominalWindow(snapshot, line, bounds.setup.plant, earliest, runtimeMinutes, bounds.runContext)
        : undefined;
      return placeWithSetup({
        earliestStart: earliest,
        runtimeMinutes,
        setup: tailSetup,
        policy: splitPolicy,
        ...(isInherentlyOverlong !== undefined ? { isInherentlyOverlong } : {}),
        freeIntervals: freeIntervalsForPlacement(
          snapshot, line, bounds.setup.plant, earliest, tailEnd, bounds.runContext,
          continuousFitMinutes(tailSetup, runtimeMinutes, splitPolicy, isInherentlyOverlong, minProductiveSegmentMinutes),
        ),
        minProductiveSegmentMinutes,
      });
    };
    const placement: PlacementResult = tailFloor && tailEnd < tailFloor
      ? { kind: 'infeasible', reason: 'no-feasible-capacity', productiveSegments: [] }
      : placeWithFinishFloor(attemptTail, cursor, tailFloor, tailSetup.minutes, runtimeMinutes, splitPolicy);
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
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  fragmentEnd: Date,
  nextFirmed: FirmedBoundary | undefined,
  finalState: SetupStateKey | null,
  finalPredecessorOrderId: string | null,
): Date {
  if (!nextFirmed) return fragmentEnd;
  // Under plantDefaultMinutes an unresolvable edge (null state on either side, or an uncovered pair) still
  // reserves the plant default, the same charge `validateCandidate` makes. Under zero/excludeFromSearch
  // `chargedSetupMinutes` is 0, so tail capacity simply runs to the boundary's start as before.
  const chargeable = setupChargeableOnLine(bounds, snapshot, line);
  if (finalState === null || nextFirmed.state === null) {
    return new Date(nextFirmed.start.getTime() - chargedSetupMinutes(bounds.runContext, null, chargeable) * 60 * 1000);
  }
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
    overrides: bounds.setup.overrides, valueDefaults: bounds.setup.value_defaults ?? NO_VALUE_DEFAULTS,
    index: bounds.runContext?.resolutionIndex ?? undefined,
  });
  const reserveMinutes = chargedSetupMinutes(bounds.runContext, resolved, chargeable);
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
  const free = tasks.filter(task => !taskIsEvaluationProtected(snapshot, bounds, task));
  const firmedWindows = tasks
    .filter(task => taskIsEvaluationProtected(snapshot, bounds, task))
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
  for (const task of tasks.filter(task => taskIsEvaluationProtected(snapshot, bounds, task))) {
    const start = timestamp(task.start_date);
    const end = timestamp(task.end_date);
    // An equal-start firmed run remains the terminal incoming boundary: its
    // setup can still occupy time inside the caller horizon. Strictly later
    // unprotected runs cannot lend capacity to this detached candidate.
    if (start && start > bounds.horizonEnd) continue;
    if (!start || !end || end <= start) {
      // Never-freeze (e24b12b follow-up): an unusable interval cannot become
      // a boundary at all — an in-progress (running) order can legitimately
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

  const free = tasks.filter(task => !taskIsEvaluationProtected(snapshot, bounds, task));
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
  let seedCount = 0;
  let localMoveCount = 0;
  let method: LineSearchResult['method'] = 'due-date-first-exact';
  let termination: SearchRun['termination'] = 'completed';

  const recordRun = (run: Readonly<SearchRun>): void => {
    candidateCount += run.candidateCount;
    seedCount += run.seedCount ?? 0;
    localMoveCount += run.localMoveCount ?? 0;
    if (run.method === 'due-date-first-greedy') method = run.method;
    termination = worseTermination(termination, run.termination);
  };
  const applyCandidate = (candidate: Readonly<DueDateCandidate>): DueDateCandidate => {
    // Winner-only exclusions: only an accepted sequence's refusals reach the run context, and an order a winner
    // places is no longer excluded.
    const exclusions = bounds.runContext?._setupExclusions;
    if (exclusions) {
      for (const [id, entry] of candidate.setupExclusions ?? []) exclusions.set(id, entry);
      for (const patch of candidate.patches) exclusions.delete(patch.id);
    }
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

  // Monotone-cursor union bookkeeping (never-freeze, e24b12b follow-up): a
  // running or frozen order folded into `firmedIds` may already be in progress
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

    // Never-freeze clamp (e24b12b follow-up): a running (or frozen) order that is
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
        return members.some(member => belongsBeforeFirmedBoundary(freeById.get(member)!, boundary, mode, dueScopeFor(snapshot, bounds)));
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
          const tailEnd = tailCapacityEnd(snapshot, bounds, line, boundary.start, boundary, predecessorState, predecessorOrderId);
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
        // Complete boundary alternatives use the same mode-aware comparator
        // as the primary search; never fall back to due-date-first ordering.
        const fallbackCompareMode = mode;
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
              snapshot, bounds, line, boundary.start, boundary,
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
          const tailEnd = tailCapacityEnd(snapshot, bounds, line, boundary.start, boundary, predecessorState, predecessorOrderId);
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
          candidateCount, method, termination, unchanged: true, seedCount, localMoveCount,
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
      const tailEnd = tailCapacityEnd(snapshot, bounds, line, boundary.start, boundary, predecessorState, predecessorOrderId);
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
      snapshot, bounds, line, boundary.start, boundary,
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
        candidateCount, method, termination, unchanged: true, seedCount, localMoveCount,
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
  return {
    patches, score, explanation, missingEdges, candidateCount, method, termination, unchanged: false,
    seedCount, localMoveCount,
  };
}

function requireDueDateBounds(bounds: Readonly<DueDateFirstBounds>): void {
  if (!bounds.setup || !bounds.setup.plant) throw new TypeError('Due-date-first evaluation requires setup truth.');
  if (!Number.isInteger(bounds.exactSearchThreshold) || bounds.exactSearchThreshold < 0) {
    throw new TypeError('Due-date-first evaluation requires an exact-search threshold.');
  }
  if (bounds.exactSearchLeafCap !== undefined && !(bounds.exactSearchLeafCap > 0)) {
    throw new TypeError('Due-date-first evaluation requires a positive exact-search leaf cap.');
  }
  if (!Number.isInteger(bounds.iterationCap) || bounds.iterationCap <= 0) {
    throw new TypeError('Due-date-first evaluation requires a positive iteration cap.');
  }
  if (typeof bounds.clock !== 'function' || !Number.isFinite(bounds.deadline)) {
    throw new TypeError('Due-date-first evaluation requires an injected clock and deadline.');
  }
}

function invalidHorizonResult(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  method: SearchDiagnostics['method'],
): CandidateResult {
  const planningStart = timestamp(bounds.planningStart);
  const placementStart = timestamp(bounds.placementStart);
  const horizonEnd = timestamp(bounds.horizonEnd);
  const detail = !planningStart || !placementStart || !horizonEnd
    ? 'The optimizer requires valid planning and horizon timestamps.'
    : `The horizon must end after the effective placement start (${placementStart.toISOString()}); received ${horizonEnd.toISOString()}.`;
  return {
    status: 'invalid_horizon',
    patches: [],
    score: zeroScore(),
    explanation: [{ code: 'invalid_horizon', message: detail }],
    diagnostics: {
      candidateCount: 0,
      method,
      termination: 'infeasible',
      runtimeMs: 0,
      limitReached: false,
      events: [],
      budgetMs: 0,
      deadlineAt: Number.isFinite(bounds.deadline) ? bounds.deadline : 0,
      iterationsUsed: 0,
      eligibleCount: 0,
      evaluatedCount: 0,
      placedCount: 0,
      exhaustive: false,
      quality: searchQuality(method, 'infeasible'),
      respectCalendar: bounds.respectCalendar ?? true,
    },
    unchangedLines: [],
    missingEdges: [],
    searchComplete: false,
    validationContext: { snapshot, bounds },
  };
}

function hasInvalidHorizon(bounds: Readonly<DueDateFirstBounds>): boolean {
  // normalizeRunDates always materializes placementStart. Falling back to
  // `now` here would turn an explicitly malformed placementStart back into a
  // valid horizon and silently accept a bad detached request.
  const placementStart = timestamp(bounds.placementStart);
  const horizonEnd = timestamp(bounds.horizonEnd);
  return !placementStart || !horizonEnd || horizonEnd <= placementStart;
}

/**
 * Pure setup-aware SPT evaluation. Productive runtime supplies the primary
 * seed and equal-admission ties retain it; deterministic due/policy/current
 * seeds may replace it only when they admit more urgent work. Setup is always
 * reserved as capacity after an order is chosen, never used as a hidden
 * changeover sort term. A missing SPT transition remains a visible warning.
 */
export function evaluateSptWithSetup(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
): CandidateResult {
  requireDueDateBounds(bounds);
  bounds = normalizeRunDates(bounds);
  if (hasInvalidHorizon(bounds)) return invalidHorizonResult(snapshot, bounds, 'spt-detached');
  const started = bounds.clock();
  // Phase 1a: reuse the caller's run context when it matches this snapshot,
  // otherwise build one fresh — then thread the (possibly augmented) bounds
  // to everything below so every hot loop can read `bounds.runContext`.
  bounds = withRunContext(snapshot, hardBounds(snapshot, bounds));
  const budget = bounds.searchBudget ?? createSearchBudget(bounds);
  bounds = { ...bounds, searchBudget: budget };
  const plant = bounds.setup.plant;
  const definition = bounds.setup.definition;
  const mutableTaskCount = eligibleTasks(snapshot, bounds).length;
  const byLine = new Map<string, NimbusTask[]>();
  for (const task of evaluationTasks(snapshot, bounds)) {
    const line = String(task.MACHINE ?? '');
    const group = byLine.get(line) ?? [];
    group.push(task);
    byLine.set(line, group);
  }

  let candidateCount = 0;
  let seedCount = 0;
  let localMoveCount = 0;
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
  for (const [line, tasks] of orderedLines) {
    // Every line reuses this run-scoped wall-clock budget and deadline.
    const lineBounds: Readonly<DueDateFirstBounds> = bounds;
    // The iteration cap is shared across this evaluator's lines and fragments.
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
    const anchor = initialScheduled && taskIsEvaluationProtected(snapshot, bounds, initialScheduled.task)
      ? preservedInitialAnchor(initialScheduled) : null;
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
      if (initial.reason === 'signature-incompatible') {
        initialDiagnosticReasons.push({
          code: 'setup-signature-incompatible',
          message: 'The line state uses a different setup-signature version.',
          line,
        });
      } else if (initialScheduled?.task) {
        // N6: when a task is attached and incoming state is unrecorded,
        // emit the admitted code. The shared helper ensures consistent wording
        // across all three emission sites.
        initialDiagnosticReasons.push(admittedStateUnrecordedReason(
          line, initialScheduled.task,
          chargedSetupMinutes(bounds.runContext, null, setupChargeableOnLine(bounds, snapshot, line)),
        ));
      } else {
        initialDiagnosticReasons.push(unknownInitialStateReason(line, null));
      }
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
    seedCount += result.seedCount ?? 0;
    localMoveCount += result.localMoveCount ?? 0;
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
      budgetMs: budget.budgetMs,
      deadlineAt: budget.deadlineAt,
      iterationsUsed: budget.iterationsUsed,
      eligibleCount: mutableTaskCount,
      evaluatedCount: candidateCount,
      placedCount: patches.length,
      seedCount,
      localMoveCount,
      exhaustive: false,
      quality: 'heuristic',
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
  bounds = normalizeRunDates(bounds);
  if (hasInvalidHorizon(bounds)) return invalidHorizonResult(snapshot, bounds, 'due-date-first-exact');
  const started = bounds.clock();
  // Phase 1a: reuse the caller's run context when it matches this snapshot,
  // otherwise build one fresh — then thread the (possibly augmented) bounds
  // to everything below so every hot loop can read `bounds.runContext`.
  bounds = withRunContext(snapshot, hardBounds(snapshot, bounds));
  const budget = bounds.searchBudget ?? createSearchBudget(bounds);
  bounds = { ...bounds, searchBudget: budget };
  const plant = bounds.setup.plant;
  const definition = bounds.setup.definition;
  const mutableTaskCount = eligibleTasks(snapshot, bounds).length;
  const byLine = new Map<string, NimbusTask[]>();
  for (const task of evaluationTasks(snapshot, bounds)) {
    const line = String(task.MACHINE ?? '');
    const group = byLine.get(line) ?? [];
    group.push(task);
    byLine.set(line, group);
  }

  let candidateCount = 0;
  let seedCount = 0;
  let localMoveCount = 0;
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
  for (const [line, tasks] of orderedLines) {
    // Every line reuses this run-scoped wall-clock budget and deadline.
    const lineBounds: Readonly<DueDateFirstBounds> = bounds;
    // The iteration cap is shared across this evaluator's lines and fragments.
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
    const anchor = initialScheduled && taskIsEvaluationProtected(snapshot, bounds, initialScheduled.task)
      ? preservedInitialAnchor(initialScheduled) : null;
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
      if (initial.reason === 'signature-incompatible') {
        initialDiagnosticReasons.push({
          code: 'setup-signature-incompatible',
          message: 'The line state uses a different setup-signature version.',
          line,
        });
      } else if (initialScheduled?.task) {
        // N6: when a task is attached and incoming state is unrecorded,
        // emit the admitted code. The shared helper ensures consistent wording
        // across all three emission sites.
        initialDiagnosticReasons.push(admittedStateUnrecordedReason(
          line, initialScheduled.task,
          chargedSetupMinutes(bounds.runContext, null, setupChargeableOnLine(bounds, snapshot, line)),
        ));
      } else {
        initialDiagnosticReasons.push(unknownInitialStateReason(line, null));
      }
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
    seedCount += result.seedCount ?? 0;
    localMoveCount += result.localMoveCount ?? 0;
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
      budgetMs: budget.budgetMs,
      deadlineAt: budget.deadlineAt,
      iterationsUsed: budget.iterationsUsed,
      eligibleCount: mutableTaskCount,
      evaluatedCount: candidateCount,
      placedCount: patches.length,
      seedCount,
      localMoveCount,
      exhaustive: searchExhaustive(method, termination),
      quality: searchQuality(method, termination),
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

/** Per-order lateness facts. The push-forward limit is a hard ceiling now, so no over-cap fact is kept here. */
function lateOrderFacts(
  tasks: ReadonlyArray<NimbusTask>,
  scope: DueScope,
): Map<string, { late: boolean; end: number | null }> {
  const facts = new Map<string, { late: boolean; end: number | null }>();
  for (const task of tasks) {
    const end = scheduledEndMinutes(task);
    const due = dueTimestamp(task, scope);
    facts.set(taskId(task), { late: end !== null && Number.isFinite(due) && end * 60 * 1000 > due, end });
  }
  return facts;
}

function withPolicyReason(result: CandidateResult, code: string, message: string): CandidateResult {
  return { ...result, explanation: [...result.explanation, { code, message }] };
}

/** Min Changeover (D1, D8-D11): least setup inside the date limits. Due date is
 * not an objective; only the pull-forward floor and the push-forward limit apply,
 * and both are hard placement bounds (an order that cannot finish inside its
 * window is queued as Needs Planning, e.g. `push_limit_unmet`, never placed past it).
 * One search per run; `finalizeCandidate` keeps the current schedule only when
 * the new plan would schedule fewer orders (by count).
 */
export function evaluateMinChangeover(
  snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>,
): CandidateResult {
  requireDueDateBounds(bounds);
  bounds = normalizeRunDates(bounds);
  if (hasInvalidHorizon(bounds)) return invalidHorizonResult(snapshot, bounds, 'due-date-first-exact');
  bounds = withRunContext(snapshot, hardBounds(snapshot, bounds));
  const budget = bounds.searchBudget ?? createSearchBudget(bounds);
  bounds = { ...bounds, searchBudget: budget };
  const candidate = evaluateDueDateFirst(snapshot, { ...bounds, searchBudget: budget }, 'min-changeover');
  const incomplete = candidate.searchComplete === false;
  const deadlineCutoff = candidate.diagnostics.termination === 'deadline';
  const iterationCutoff = candidate.diagnostics.termination === 'iteration-cap';
  const budgetCutoff = deadlineCutoff || iterationCutoff;
  const termination = budgetCutoff
    ? (deadlineCutoff ? 'deadline' : 'iteration-cap')
    : candidate.diagnostics.termination;
  return {
    ...candidate,
    searchComplete: !incomplete,
    diagnostics: {
      ...candidate.diagnostics,
      termination,
      limitReached: budgetCutoff,
      runtimeMs: Math.max(0, bounds.clock() - budget.startedAt),
      budgetMs: budget.budgetMs,
      deadlineAt: budget.deadlineAt,
      iterationsUsed: budget.iterationsUsed,
      exhaustive: !incomplete && candidate.diagnostics.exhaustive === true,
      quality: candidate.diagnostics.quality === 'heuristic' ? 'heuristic' : 'exact',
    },
    explanation: [...candidate.explanation, { code: 'min-changeover-selected', message: 'Selected the validated plan with the least setup inside the date limits.' }],
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
  const dueScope: DueScope = { snapshot };
  const before = lateOrderFacts(snapshot.tasks, dueScope);
  const afterTasks = applyPatchesToSnapshot(snapshot.tasks, candidate.patches);
  const after = lateOrderFacts(afterTasks, dueScope);
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
  requireDueDateBounds(bounds);
  bounds = normalizeRunDates(bounds);
  if (hasInvalidHorizon(bounds)) return invalidHorizonResult(snapshot, bounds, 'due-date-first-exact');
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
  const budget = bounds.searchBudget ?? createSearchBudget(bounds);
  bounds = { ...bounds, searchBudget: budget };
  const baseline = evaluateDueDateFirst(snapshot, bounds);
  const candidate = evaluateDueDateFirst(snapshot, bounds, 'throughput');
  const selected = selectThroughputCandidate(
    snapshot,
    baseline,
    candidate,
    thresholds,
  );
  const baselineEvaluated = baseline.diagnostics.evaluatedCount ?? baseline.diagnostics.candidateCount;
  const candidateEvaluated = candidate.diagnostics.evaluatedCount ?? candidate.diagnostics.candidateCount;
  const incomplete = baseline.searchComplete === false || candidate.searchComplete === false;
  const deadlineCutoff = baseline.diagnostics.termination === 'deadline' || candidate.diagnostics.termination === 'deadline';
  const iterationCutoff = baseline.diagnostics.termination === 'iteration-cap' || candidate.diagnostics.termination === 'iteration-cap';
  const budgetCutoff = deadlineCutoff || iterationCutoff;
  return {
    ...selected,
    searchComplete: !incomplete,
    diagnostics: {
      ...selected.diagnostics,
      candidateCount: baseline.diagnostics.candidateCount + candidate.diagnostics.candidateCount,
      runtimeMs: Math.max(0, bounds.clock() - budget.startedAt),
      budgetMs: budget.budgetMs,
      deadlineAt: budget.deadlineAt,
      iterationsUsed: budget.iterationsUsed,
      evaluatedCount: baselineEvaluated + candidateEvaluated,
      seedCount: (baseline.diagnostics.seedCount ?? 0) + (candidate.diagnostics.seedCount ?? 0),
      localMoveCount: (baseline.diagnostics.localMoveCount ?? 0) + (candidate.diagnostics.localMoveCount ?? 0),
      placedCount: selected.patches.length,
      exhaustive: !incomplete && baseline.diagnostics.exhaustive === true && candidate.diagnostics.exhaustive === true,
      quality: baseline.diagnostics.quality === 'heuristic' || candidate.diagnostics.quality === 'heuristic' ? 'heuristic' : 'exact',
      termination: budgetCutoff
        ? (deadlineCutoff ? 'deadline' : 'iteration-cap')
        : selected.diagnostics.termination,
      limitReached: budgetCutoff,
    },
  };
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

/** Attach the complete apply contract to a legacy or repair candidate. These
 * paths do not run `finalizeCandidate`, but a worker response still needs
 * detached dispositions and effective firming so Apply can validate it
 * against the captured read model. */
export function attachDetachedValidationContext(
  candidate: CandidateResult,
  baselineSnapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  effectiveFirmedIds: ReadonlySet<string>,
): CandidateResult {
  const snapshot: ScheduleSnapshot = { ...baselineSnapshot, firmedIds: new Set(effectiveFirmedIds) };
  const patches = new Map(candidate.patches.map(patch => [String(patch.id), patch]));
  const finalById = new Map(applyPatchesToSnapshot(snapshot.tasks, candidate.patches).map(task => [String(task.id), task]));
  const dispositions: PlanningDisposition[] = [];
  const reasonFor = (task: NimbusTask): { code: string; message: string } => (
    planningDefect(snapshot, bounds, task)
      ?? unfittableReason(snapshot, bounds, task)
      ?? pushLimitAware(bounds, task, { code: 'no_fit_found', message: 'The repair did not produce a valid scheduled interval.' })
  );
  for (const task of eligibleTasks(snapshot, bounds)) {
    const id = String(task.id);
    const line = String(task.MACHINE);
    if (taskIsFirmed(snapshot, task)) {
      dispositions.push({ id, line, status: 'protected' });
      continue;
    }
    const result = finalById.get(id) ?? task;
    const start = timestamp(result.start_date);
    const end = timestamp(result.end_date);
    const runtimeMinutes = Math.round(Number(task.RUN_TIME) * 60);
    const scheduled = result.planning_status !== 'needs_planning'
      && !!start && !!end && end > start && Number.isFinite(runtimeMinutes) && runtimeMinutes > 0;
    if (scheduled) {
      // A legacy patch changes only dates. Clear a stale queued status/reason
      // when it has nevertheless produced a valid interval, while avoiding a
      // redundant patch for an unchanged healthy incumbent.
      if (result.planning_status === 'needs_planning' || result.planning_reason) {
        patches.set(id, { id, changes: { ...patches.get(id)?.changes, planning_status: 'scheduled', planning_reason: null } });
      }
      dispositions.push({ id, line, status: 'scheduled' });
      continue;
    }
    const reason = result.planning_reason?.code
      ? result.planning_reason
      : (planningDefect(snapshot, bounds, task) ?? bounds.runContext?._setupExclusions.get(id) ?? reasonFor(task));
    patches.set(id, {
      id,
      changes: {
        ...patches.get(id)?.changes,
        start_date: null,
        end_date: null,
        scheduleSegments: [],
        planning_status: 'needs_planning',
        planning_reason: reason,
      },
    });
    dispositions.push({ id, line, status: 'needs_planning', reason });
  }
  const normalized = {
    ...candidate,
    patches: [...patches.values()],
    dispositions,
    validationContext: { snapshot, baselineSnapshot, bounds },
  };
  return { ...normalized, validationFindings: validateCandidate(snapshot, bounds, normalized) };
}

/** SAP-only local calendar-day bounds; scheduled finish is never a due-date fallback. */
export function allowedPlanningWindow(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, task: NimbusTask): { floor: Date | null; ceiling: Date | null; missingDue: boolean } {
  if (bounds.ignorePlantWindow) return { floor: null, ceiling: null, missingDue: false };
  const plant = snapshot.masterData?.plants?.find(row => row.plant === bounds.setup.plant);
  const pull = plant?.max_pull_forward_days;
  const push = plant?.max_push_forward_days;
  const hasPull = Number.isInteger(pull) && Number(pull) >= 0;
  const hasPush = Number.isInteger(push) && Number(push) >= 0;
  const due = dueInstant(task, dueScopeFor(snapshot, bounds));
  const day = (offset: number): Date | null => {
    if (!due) return null;
    const value = new Date(+due - 1); value.setHours(0, 0, 0, 0); value.setDate(value.getDate() + offset); return value;
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

type PlanningDefect = { code: string; message: string; tool_id?: string; available?: number; holders?: string[] };

/** T4: the part of `planningDefect` that depends only on the task and the
 * plant's configuration (missing SAP due date, run-time validity). The entry is
 * reused only for the same task object, master-data object and plant, so any
 * other snapshot or task copy sharing the run context recomputes. */
interface StaticDefectEntry {
  task: NimbusTask;
  masterData: NimbusMasterData | null;
  plant: string;
  defect: PlanningDefect | null;
}

function staticPlanningDefect(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, task: NimbusTask): PlanningDefect | null {
  const compute = (): PlanningDefect | null => {
    if (allowedPlanningWindow(snapshot, bounds, task).missingDue) return { code: 'missing_due_date', message: 'A SAP due date is required for the configured planning window.' };
    if (!Number.isFinite(Number(task.RUN_TIME)) || Math.round(Number(task.RUN_TIME) * 60) <= 0) return { code: 'invalid_runtime', message: 'Runtime must be a positive number.' };
    // Tool Inventory: a carried tool with no available copy can never be placed. This sits FIRST in every reason chain
    // (finalizeCandidate's result and baseline chains, repair, attachDetachedValidationContext), so a tool wait is
    // never relabelled push-limit / search-incomplete. Off / not loaded / Remove Backlog: null, nothing changes.
    return toolUnavailableDefect(snapshot, bounds, task);
  };
  const ctx = bounds.runContext;
  if (!ctx) return compute();
  const id = taskId(task);
  const hit = ctx._staticDefect.get(id);
  if (hit && hit.task === task && hit.masterData === snapshot.masterData && hit.plant === bounds.setup.plant) return hit.defect && { ...hit.defect };
  const defect = compute();
  ctx._staticDefect.set(id, { task, masterData: snapshot.masterData, plant: bounds.setup.plant, defect });
  return defect && { ...defect };
}

function planningDefect(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, task: NimbusTask): PlanningDefect | null {
  const staticDefect = staticPlanningDefect(snapshot, bounds, task);
  if (staticDefect) return staticDefect;
  const ceiling = notAfterFor(bounds, task);
  const floor = notBeforeFor(bounds, task);
  if (ceiling && +ceiling <= Math.max(+bounds.now, floor ? +floor : -Infinity)) return { code: 'expired_window', message: 'The allowed completion window ends before available planning time.' };
  // Frozen finish floor: a completion ceiling before it can never hold an unprotected order (equality is valid).
  if (ceiling && bounds.finishFloor && +ceiling < +bounds.finishFloor) return { code: 'expired_window', message: 'The allowed completion window ends before available planning time.' };
  return null;
}

/** T1: everything the `urgencyOrder` comparator reads about one order. `task`
 * is the object the tuple was computed from: an entry is reused only for that
 * same object (a patched copy with the same id recomputes), so a changed
 * `start_date` can never be served stale. */
interface UrgencyKey {
  task: NimbusTask;
  deadline: number;
  policy: string;
  due: number;
  start: number;
  id: string;
}

function urgencyKeyFor(
  snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, line: string, task: NimbusTask,
  dueScope: DueScope,
): UrgencyKey {
  const effectiveLine = line || String(task.MACHINE);
  const ctx = bounds.runContext;
  // Only cache when notAfterFor would itself memoize per id (ctx present and a
  // notAfter rule supplied); otherwise recompute exactly as the old path did.
  const cacheKey = ctx && bounds.notAfter ? effectiveLine + CTX_KEY_SEP + taskId(task) : null;
  if (cacheKey) {
    const hit = ctx!._urgencyKey.get(cacheKey);
    if (hit && hit.task === task) return hit;
  }
  const key: UrgencyKey = {
    task,
    deadline: notAfterFor(bounds, task)?.getTime() ?? Infinity,
    policy: policyKeyForSequence(snapshot, bounds.setup.plant, effectiveLine, [task], ctx),
    due: dueTimestamp(task, dueScope),
    start: timestamp(task.start_date)?.getTime() ?? Number.MAX_SAFE_INTEGER,
    id: taskId(task),
  };
  if (cacheKey) ctx!._urgencyKey.set(cacheKey, key);
  return key;
}

function urgencyOrder(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, line: string, tasks: ReadonlyArray<NimbusTask>): NimbusTask[] {
  const dueScope = dueScopeFor(snapshot, bounds);
  const keyed = tasks.map(task => ({ task, key: urgencyKeyFor(snapshot, bounds, line, task, dueScope) }));
  keyed.sort((a, b) => {
    const deadline = a.key.deadline - b.key.deadline;
    if (deadline && !Number.isNaN(deadline)) return deadline;
    const priority = ordinalCompare(a.key.policy, b.key.policy);
    return priority || a.key.due - b.key.due || a.key.start - b.key.start || ordinalCompare(a.key.id, b.key.id);
  });
  return keyed.map(entry => entry.task);
}

interface TaskScope {
  /** Orders that receive patches, dispositions, and objective facts. */
  mutable: NimbusTask[];
  /** Immutable occupancy/predecessor rows used during evaluation and apply
   * validation. They are deliberately absent from mutable accounting. */
  boundaries: NimbusTask[];
  /** The physical line model: mutable orders plus immutable boundaries. */
  evaluation: NimbusTask[];
}

function idSet(value: readonly string[] | ReadonlySet<string> | undefined): ReadonlySet<string> | null {
  if (value instanceof Set) return value;
  return value ? new Set(Array.from(value, String)) : null;
}

function normalizedQueuedTask(task: NimbusTask): NimbusTask {
  return {
    ...task,
    start_date: null,
    end_date: null,
    scheduleSegments: [],
    planning_status: 'needs_planning',
  };
}

/** A placed, user-scheduled order that starts inside the window and finishes
 * past `horizonEnd` is held in place (SAP fixes partly-inside activities).
 * Mirrors `engine.mts` user_scheduled semantics without importing engine
 * (import cycle). Protected rows keep their own path; explicit-scope callers
 * (Remove Backlog) are exempt. */
function isWindowEndBoundary(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, task: NimbusTask): boolean {
  if (task.user_scheduled !== true) return false;
  if (bounds.scopeTaskIds) return false;
  const horizonEnd = timestamp(bounds.horizonEnd)?.getTime();
  if (horizonEnd === undefined) return false;
  const start = timestamp(task.start_date);
  const end = timestamp(task.end_date);
  if (!start || !end || !(end > start)) return false;
  if (task.planning_status === 'needs_planning') return false;
  if (!(end.getTime() > horizonEnd) || !(start.getTime() < horizonEnd)) return false;
  return !taskIsFirmed(snapshot, task);
}

function buildTaskScope(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>): TaskScope {
  const scopedTaskIds = idSet(bounds.scopeTaskIds);
  const boundaryTaskIds = idSet(bounds.boundaryTaskIds);
  const planningStart = timestamp(bounds.planningStart)?.getTime();
  const horizonEnd = timestamp(bounds.horizonEnd)?.getTime();
  const mutable: NimbusTask[] = [];
  const boundaries: NimbusTask[] = [];
  for (const task of snapshot.tasks) {
    const line = String(task.MACHINE ?? '');
    if (!line || resolveTaskPlant(task, snapshot, bounds.runContext) !== bounds.setup.plant
      || snapshot.lineSettings[line]?.excludeFromOpt
      || (bounds.lines?.length && !bounds.lines.includes(line))) continue;
    const id = taskId(task);
    const explicitlyScoped = !scopedTaskIds || scopedTaskIds.has(id);
    const explicitlyBoundary = boundaryTaskIds?.has(id) === true;
    const start = timestamp(task.start_date);
    const end = timestamp(task.end_date);
    const validInterval = !!start && !!end && end > start;
    const queued = task.planning_status === 'needs_planning' || (!start && !end);
    const intersects = validInterval && planningStart !== undefined && horizonEnd !== undefined
      && end!.getTime() > planningStart && start!.getTime() < horizonEnd;
    const protectedTask = taskIsFirmed(snapshot, task);

    // A caller-owned boundary set is authoritative for repair modes such as
    // Remove Backlog: selected rows are mutable, every other valid row named
    // as a boundary is occupancy only, even if it overlaps the horizon.
    if (explicitlyBoundary) {
      if (validInterval) boundaries.push(task);
      continue;
    }
    // An explicit repair scope is exact. A protected valid interval that falls
    // outside the planning window remains an automatic occupancy boundary;
    // every other unselected row, including queued demand, stays out.
    if (scopedTaskIds && !explicitlyScoped) {
      if (protectedTask && validInterval && !intersects) boundaries.push(task);
      continue;
    }
    // Queue status is checked before any stale-date interval test. Imported
    // rows can retain one-sided/reversed dates while explicitly asking for
    // planning; normalize that stale shape to a detached queue row.
    if (queued) {
      mutable.push(normalizedQueuedTask(task));
      continue;
    }
    // A placed order crossing the window end is fixed occupancy, not demand.
    if (isWindowEndBoundary(snapshot, bounds, task)) {
      boundaries.push(task);
      continue;
    }
    // A protected interval remains a physical obstacle even when a caller
    // supplies only the mutable ids. This keeps an omitted boundary list from
    // allowing a selected repair to overlap firmed/running/frozen work.
    if (protectedTask && validInterval && !intersects) {
      boundaries.push(task);
      continue;
    }
    if (scopedTaskIds && !explicitlyScoped) continue;
    if (scopedTaskIds?.has(id) || intersects) {
      mutable.push(task);
      continue;
    }
    // Keep malformed protected rows in the mutable accounting seam for
    // compatibility with the existing protected-data diagnostics. They have
    // no usable occupancy interval and therefore cannot affect placement.
    if (protectedTask && !validInterval) {
      mutable.push(task);
      continue;
    }
    // A valid protected row outside [planningStart, horizonEnd) is an
    // immutable physical boundary. It constrains line placement/setup but is
    // never assigned a disposition or counted as scheduled optimizer work.
    if (protectedTask && validInterval) boundaries.push(task);
  }
  return { mutable, boundaries, evaluation: [...mutable, ...boundaries] };
}

function eligibleTasks(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>): NimbusTask[] {
  return buildTaskScope(snapshot, bounds).mutable;
}

function evaluationTasks(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>): NimbusTask[] {
  return buildTaskScope(snapshot, bounds).evaluation;
}

function taskIsEvaluationProtected(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, task: NimbusTask): boolean {
  return taskIsFirmed(snapshot, task) || (idSet(bounds.boundaryTaskIds)?.has(taskId(task)) ?? false)
    || isWindowEndBoundary(snapshot, bounds, task);
}

function productiveIntervals(task: NimbusTask): PlacementInterval[] {
  if (task.scheduleSegments?.length) return task.scheduleSegments.flatMap(segment => {
    const start = timestamp(segment.startDate); const end = timestamp(segment.endDate);
    return start && end ? [{ start, end }] : [];
  });
  const start = timestamp(task.start_date); const end = timestamp(task.end_date);
  return start && end ? [{ start, end }] : [];
}

/* =============================================================================
   TOOL INVENTORY OVERFLOW PASS (Tool Inventory Wave 6; design: the plan's section E)

   A tool id is a TYPE: the plant owns several interchangeable copies (master data `tool_inventory`), and the
   capacity is the number of DISTINCT MACHINES using the tool at the same instant (half-open intervals; the
   order's occupancy is the ENVELOPE first segment start .. last segment end, run time only: setup may overlap).
   Everything here is gated on the plant's tooling rule being 'hard' AND the inventory being LOADED
   (`snapshot.masterData.tool_inventory` is an array; undefined = not loaded = unconstrained) AND the run not
   being Remove Backlog (`bounds.ignoreToolRule`). With the rule Off every function below returns its input
   untouched, so an Off plant is byte-identical to a build without this feature.

   Overflow detection is the compute core's `findToolOverages` (the Gantt alert uses the same function), so the
   alert and the optimizer can never disagree. The rule and the inventory are read ONLY from
   `snapshot.masterData` (the worker contract drops unknown bounds fields, `fillPlanningGaps` rebuilds
   `runContext`).

   The pass (`resolveToolOverflow`) runs AFTER the search, on a finished candidate:
     loop: re-sweep -> the first cluster that has a mutable holder -> offender = its LEAST URGENT mutable holder
     (`urgencyOrder(snapshot, bounds, '', ...)`, the same plant-wide ordering `finalizeCandidate` uses for
     admission; policy ranks are line-scoped, so mixing lines is the existing convention) ->
       (a) re-place the offender on ITS OWN line (never another machine) through the gap-fill loop with every gap
           intersected with the tool-free windows of every tool it carries (setup + run, so conservative), then
           re-check the ENVELOPE (a split order spans the gap) against the full index; first gap that passes
           both wins (it may be EARLIER than the current slot);
       (b) otherwise QUEUE it (null dates, structured `tool_contention` / `tool_unavailable` reason).
   TERMINATION: every step either queues an order (the number of placed orders strictly decreases) or moves it into
   a window in which, for each tool it carries, fewer OTHER machines than copies are in use; later steps only
   remove intervals or add intervals into such windows, so an order that has been moved is never part of a
   later cluster, and a queued order has no interval. Each step therefore consumes one mutable tool-carrying
   order, giving at most that many steps (the loop is also bounded by it defensively).
   BUDGET: Normal 1 s, Exhaustive 10 s, soft, checked at step boundaries and inside the gap walk; on expiry the
   remaining offenders are queued with `incomplete: true` and `toolPass.complete = false`.
   PROTECTED rows (firmed, running, frozen, placement_exception, window-end held, explicit boundaries), rows on
   unselected / excludeFromOpt lines, rows outside the window and finish-only rows all RESERVE copies and are
   never patched, EXCEPT a never-committed baseline bar (both dates, user_scheduled !== true) that is neither mutable
   nor firmed (owner decision F3): it does not reserve for mutable work and only raises a WARNING. A cluster with no
   mutable holder is a WARNING (grandfathered), never an error.
   RECOVERY then re-offers every tool_contention order to the final occupancy, again after the repair cascade;
   the pass on its own output changes nothing (idempotent). Exceptions: compute-core-stale is rethrown, anything
   else fails closed (toolPass.failed + the tool_overflow_failed error finding).
   ============================================================================= */

const TOOL_PASS_NORMAL_BUDGET_MS = 1000;
const TOOL_PASS_EXHAUSTIVE_BUDGET_MS = 10000;
const TOOL_HOLDER_CAP = 10;
const TOOL_CONTENTION_MESSAGE = 'No copy of a tool this order needs is free within its allowed planning window.';
const TOOL_CONTENTION_INCOMPLETE_MESSAGE = 'The tool check ran out of time before every free slot was searched.';
const TOOL_UNAVAILABLE_MESSAGE = 'A tool this order needs has no copies available.';
const TOOL_OVERFLOW_ERROR_MESSAGE = 'More machines need a tool at the same time than there are copies available.';
const TOOL_OVERFLOW_FAILED_MESSAGE = 'The tool check could not be completed, so this proposal cannot be applied. Try again or contact support.';
const TOOL_OVERFLOW_WARNING_MESSAGE = 'Protected or out-of-scope orders already need more copies of a tool than are available.';
const TOOL_CORE_FUNCTIONS = ['normalizeToolId', 'taskToolIds', 'toolOccupancyInterval', 'buildToolCapacity', 'availableCopies',
  'findToolOverages', 'buildToolIndex', 'toolIndexUpdate', 'toolHeadroom'] as const;

interface ToolCapacity { available: number; hasRow: boolean }
interface ToolCore {
  taskToolIds(task: NimbusTask): string[];
  toolOccupancyInterval(task: NimbusTask): { start: Date; end: Date } | null;
  buildToolCapacity(masterData?: NimbusMasterData | null): Map<string, ToolCapacity>;
  availableCopies(capacity: Map<string, ToolCapacity> | null | undefined, plant: string | null | undefined, tool: string): ToolCapacity;
  findToolOverages(args: { items: ToolItem[]; capacityFor: (plant: string, tool: string) => ToolCapacity; now?: Date | number }): ToolCluster[];
  buildToolIndex(args: { items: ToolItem[]; capacityFor: (plant: string, tool: string) => ToolCapacity }): unknown;
  toolIndexUpdate(index: unknown, id: string, oldInterval: Omit<ToolItem, 'id'> | null, newInterval: Omit<ToolItem, 'id'> | null): unknown;
  toolHeadroom(index: unknown, plant: string, tools: string[], from: Date | number, to: Date | number, excludeLine?: string | null): Array<{ start: Date; end: Date }>;
}
interface ToolItem { id: string; line: string; plant: string; tools: string[]; start: Date; end: Date }
interface ToolCluster {
  plant: string; tool: string; at: Date; available: number; hasRow: boolean; inUse: number;
  pusher: string; pusherLine: string; holders: Array<{ id: string; line: string; start: Date; end: Date }>;
}
interface ToolRuleCtx { plant: string; core: ToolCore; capacityFor: (plant: string, tool: string) => ToolCapacity }
/** The tool facts that depend only on the BASE task list (not on a candidate's patches): which orders carry which
 * tools and in which plant. Carried on `bounds.toolIndex` together with the `snapshot.tasks` reference it was
 * built from; every reader rebuilds when the reference (or the master-data object) differs (a `runContext` memo
 * would be lost: `fillPlanningGaps` rebuilds it and the per-line trials validate against `{...snapshot, tasks: peers}`). */
export interface ToolStatic {
  tasks: ReadonlyArray<NimbusTask>;
  masterData: NimbusMasterData | null;
  byId: Map<string, { tools: string[]; plant: string | null }>;
  /** Owner decision F3: tool-carrying rows with BOTH dates and `user_scheduled !== true` (a never-committed baseline bar).
   * They do not reserve copies against mutable work (the alert still counts them); finish-only rows are not in this set. */
  neverCommitted: Set<string>;
}
interface ToolOcc {
  ctx: ToolRuleCtx; items: Map<string, ToolItem>; index: unknown; runNowMs: number;
  /** Items per tool, and the per-tool overflow clusters (`hot`: only tools with a cluster); `dirty` tools are re-swept on the next
   * read, so a step re-sweeps only the tools of the order it moved or queued. */
  byTool: Map<string, Map<string, ToolItem>>; dirty: Set<string>; hot: Map<string, ToolCluster[]>;
}
/** Who may reserve copies: with this set, never-committed rows that are neither mutable nor firmed are left out (F3). */
interface ToolReserveScope { mutableIds: ReadonlySet<string>; snapshot: Readonly<ScheduleSnapshot> }
interface ToolGapHooks { windows(from: number, to: number): PlacementInterval[]; envelopeFits(start: Date, end: Date): boolean }

const toolCapacityMemo = new WeakMap<object, Map<string, ToolCapacity>>();
const toolStaticMemo = new WeakMap<object, ToolStatic>();

/** The compute core, or `compute-core-stale` when a function the pass needs is missing (a proxy-cached old core).
 * Only ever reached for a plant whose rule is Hard with a loaded inventory: an Off plant never touches it, so it
 * keeps using the worker with an older cached core. */
function toolCoreOrThrow(): ToolCore {
  const core = (globalThis as any).NimbusComputeCore;
  for (const name of TOOL_CORE_FUNCTIONS) {
    if (!core || typeof core[name] !== 'function') throw new Error('compute-core-stale');
  }
  return core as ToolCore;
}

/** Non-null only when the tool rule is ACTIVE for this run: rule Hard, inventory loaded, not Remove Backlog. */
export function toolRuleContext(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>): ToolRuleCtx | null {
  if (bounds.ignoreToolRule === true) return null;
  const plant = bounds.setup.plant;
  if (toolingRuleForSnapshot(snapshot, plant) !== 'hard') return null;
  const inventory = snapshot.masterData?.tool_inventory;
  if (!Array.isArray(inventory)) return null;
  const core = toolCoreOrThrow();
  let capacity = toolCapacityMemo.get(inventory);
  if (!capacity) { capacity = core.buildToolCapacity(snapshot.masterData); toolCapacityMemo.set(inventory, capacity); }
  const table = capacity;
  return { plant, core, capacityFor: (p, tool) => core.availableCopies(table, p, tool) };
}

/** The engine's stale-core guard: throws `compute-core-stale` ONLY for a Hard plant with a loaded inventory. */
export function assertToolCoreFor(snapshot: Readonly<ScheduleSnapshot>, plant: string): void {
  if (toolingRuleForSnapshot(snapshot, plant) === 'hard' && Array.isArray(snapshot.masterData?.tool_inventory)) toolCoreOrThrow();
}

function toolStaticFor(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, ctx: ToolRuleCtx): ToolStatic {
  const carried = bounds.toolIndex;
  if (carried && carried.tasks === snapshot.tasks && carried.masterData === snapshot.masterData) return carried;
  const memo = toolStaticMemo.get(snapshot.tasks as object);
  if (memo && memo.masterData === snapshot.masterData) return memo;
  const byId = new Map<string, { tools: string[]; plant: string | null }>();
  const neverCommitted = new Set<string>();
  for (const task of snapshot.tasks) {
    const tools = ctx.core.taskToolIds(task);
    if (!tools.length) continue;
    byId.set(taskId(task), { tools, plant: resolveTaskPlant(task, snapshot, bounds.runContext) });
    if (task.user_scheduled !== true && timestamp(task.start_date) && timestamp(task.end_date)) neverCommitted.add(taskId(task));
  }
  const built: ToolStatic = { tasks: snapshot.tasks, masterData: snapshot.masterData, byId, neverCommitted };
  toolStaticMemo.set(snapshot.tasks as object, built);
  return built;
}

/** Shallow patched view (the tool code only reads fields). */
function patchedTaskView(tasks: ReadonlyArray<NimbusTask>, patches: ReadonlyMap<string, SchedulePatch>): NimbusTask[] {
  return tasks.map(task => { const patch = patches.get(taskId(task)); return patch ? { ...task, ...patch.changes } as NimbusTask : task; });
}

function toolRunNowMs(bounds: Readonly<DueDateFirstBounds>): number {
  return +(timestamp(bounds.runNow ?? bounds.now) ?? new Date(0));
}

/** The order's tool occupancy (envelope, run time only), clipped to the run's now; null when it holds nothing. */
function toolItemFor(ctx: ToolRuleCtx, stat: ToolStatic, runNowMs: number, task: NimbusTask): ToolItem | null {
  const info = stat.byId.get(taskId(task));
  if (!info || info.plant !== ctx.plant || task.planning_status === 'needs_planning') return null;
  const interval = ctx.core.toolOccupancyInterval(task);
  if (!interval) return null;
  let start = +interval.start; const end = +interval.end;
  if (end <= runNowMs) return null;
  if (start < runNowMs) start = runNowMs;
  if (!(end > start)) return null;
  return { id: taskId(task), line: String(task.MACHINE ?? '') || 'Unknown', plant: ctx.plant, tools: info.tools, start: new Date(start), end: new Date(end) };
}

function buildToolOcc(
  ctx: ToolRuleCtx, stat: ToolStatic, bounds: Readonly<DueDateFirstBounds>, patched: ReadonlyArray<NimbusTask>,
  reserve?: ToolReserveScope,
): ToolOcc {
  const runNowMs = toolRunNowMs(bounds);
  const items = new Map<string, ToolItem>();
  const byTool = new Map<string, Map<string, ToolItem>>();
  for (const task of patched) {
    if (reserve && stat.neverCommitted.has(taskId(task)) && !reserve.mutableIds.has(taskId(task)) && !taskIsFirmed(reserve.snapshot, task)) continue;
    const item = toolItemFor(ctx, stat, runNowMs, task);
    if (!item) continue;
    items.set(item.id, item);
    for (const tool of item.tools) { let list = byTool.get(tool); if (!list) byTool.set(tool, list = new Map()); list.set(item.id, item); }
  }
  return { ctx, items, index: ctx.core.buildToolIndex({ items: [...items.values()], capacityFor: ctx.capacityFor }), runNowMs,
    byTool, dirty: new Set(byTool.keys()), hot: new Map() };
}

function toolOccRemove(occ: ToolOcc, id: string): void {
  const item = occ.items.get(id);
  if (!item) return;
  occ.items.delete(id);
  occ.ctx.core.toolIndexUpdate(occ.index, id, item, null);
  for (const tool of item.tools) { occ.byTool.get(tool)?.delete(id); occ.dirty.add(tool); }
}

function toolOccAdd(occ: ToolOcc, item: ToolItem): void {
  occ.items.set(item.id, item);
  occ.ctx.core.toolIndexUpdate(occ.index, item.id, null, item);
  for (const tool of item.tools) { let list = occ.byTool.get(tool); if (!list) occ.byTool.set(tool, list = new Map()); list.set(item.id, item); occ.dirty.add(tool); }
}

/** Re-sweep the DIRTY tools only; the core orders its events totally (time, end before start, start, end, id, line), so a
 * tool's clusters never depend on item order. `hot` keeps only the tools that currently overflow. */
function refreshToolClusters(occ: ToolOcc): void {
  for (const tool of occ.dirty) {
    const list = occ.byTool.get(tool);
    const found = list && list.size
      ? occ.ctx.core.findToolOverages({ items: [...list.values()].map(item => ({ ...item, tools: [tool] })), capacityFor: occ.ctx.capacityFor })
      : [];
    if (found.length) occ.hot.set(tool, found); else occ.hot.delete(tool);
  }
  occ.dirty.clear();
}

/** Every overflow cluster, tools ascending (the order the core's own sweep uses). */
function toolClusters(occ: ToolOcc): ToolCluster[] {
  refreshToolClusters(occ);
  const out: ToolCluster[] = [];
  for (const tool of [...occ.hot.keys()].sort()) out.push(...occ.hot.get(tool)!);
  return out;
}

/** The first cluster (tool, then time order) the predicate accepts, without materialising the whole list. */
function findToolCluster(occ: ToolOcc, accept: (cluster: ToolCluster) => boolean): ToolCluster | null {
  refreshToolClusters(occ);
  for (const tool of [...occ.hot.keys()].sort()) for (const cluster of occ.hot.get(tool)!) if (accept(cluster)) return cluster;
  return null;
}

function toolGapHooks(occ: ToolOcc, tools: string[], line: string): ToolGapHooks {
  return {
    windows: (from, to) => occ.ctx.core.toolHeadroom(occ.index, occ.ctx.plant, tools, from, to, line),
    envelopeFits: (start, end) => {
      const windows = occ.ctx.core.toolHeadroom(occ.index, occ.ctx.plant, tools, start, end, line);
      return windows.length === 1 && +windows[0].start <= +start && +windows[0].end >= +end;
    },
  };
}

/** Intersection of two ascending, disjoint interval lists. */
function intersectIntervals(a: ReadonlyArray<PlacementInterval>, b: ReadonlyArray<PlacementInterval>): PlacementInterval[] {
  const out: PlacementInterval[] = [];
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(+a[i].start, +b[j].start);
    const end = Math.min(+a[i].end, +b[j].end);
    if (end > start) out.push({ start: new Date(start), end: new Date(end) });
    if (+a[i].end < +b[j].end) i++; else j++;
  }
  return out;
}

function toolClusterHolderIds(cluster: ToolCluster): string[] {
  return [cluster.pusher, ...cluster.holders.map(holder => holder.id)];
}

/** Which rows the pass may move: in the mutable scope, not protected, and currently scheduled. Decided from the
 * ORIGINAL row (a patched copy that crosses the window end must not look protected). */
function toolMovablePredicate(
  snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, scope: TaskScope,
  dispositions: ReadonlyMap<string, PlanningDisposition>,
): (id: string) => boolean {
  const mutable = new Map(scope.mutable.map(task => [taskId(task), task]));
  const original = new Map(snapshot.tasks.map(task => [taskId(task), task]));
  return id => {
    if (!mutable.has(id)) return false;
    const row = original.get(id) ?? mutable.get(id)!;
    if (taskIsEvaluationProtected(snapshot, bounds, row)) return false;
    return dispositions.get(id)?.status === 'scheduled';
  };
}

function toolUrgencyRank(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, tasks: ReadonlyArray<NimbusTask>): Map<string, number> {
  return new Map(urgencyOrder(snapshot, bounds, '', tasks).map((task, index) => [taskId(task), index]));
}

function leastUrgentToolHolder(ids: ReadonlyArray<string>, rank: ReadonlyMap<string, number>): string {
  let best = ids[0];
  for (const id of ids) {
    const a = rank.get(id) ?? Number.MAX_SAFE_INTEGER; const b = rank.get(best) ?? Number.MAX_SAFE_INTEGER;
    if (a > b || (a === b && ordinalCompare(id, best) > 0)) best = id;
  }
  return best;
}

function toolHoldersDetail(cluster: ToolCluster, offender: string | null): string[] {
  return toolClusterHolderIds(cluster).filter(id => id !== offender).sort(ordinalCompare).slice(0, TOOL_HOLDER_CAP);
}

/** The structured planning reason for an order queued by the tool pass. The message is FIXED text (no holder ids or
 * numbers that change run to run); the planner-visible wording is rendered from the structured fields. */
function toolQueueReason(
  code: 'tool_contention' | 'tool_unavailable', tool: string, available: number, holders: string[], incomplete: boolean,
): { code: string; message: string; tool_id: string; available: number; holders: string[]; incomplete?: true } {
  const message = code === 'tool_unavailable' ? TOOL_UNAVAILABLE_MESSAGE : incomplete ? TOOL_CONTENTION_INCOMPLETE_MESSAGE : TOOL_CONTENTION_MESSAGE;
  return { code, message, tool_id: tool, available, holders, ...(incomplete ? { incomplete: true as const } : {}) };
}

function toolQueuePatch(id: string, reason: { code: string; message: string }): SchedulePatch {
  return { id, changes: { start_date: null, end_date: null, scheduleSegments: [], planning_status: 'needs_planning', planning_reason: reason } };
}

/** Static check behind `staticPlanningDefect`: an order carrying a tool whose plant has NO copy available can never be
 * placed, so every search path skips it and it goes straight to Needs Planning with the structured reason. */
function toolUnavailableDefect(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, task: NimbusTask): PlanningDefect | null {
  const ctx = toolRuleContext(snapshot, bounds);
  if (!ctx) return null;
  for (const tool of [...ctx.core.taskToolIds(task)].sort()) {
    if (ctx.capacityFor(ctx.plant, tool).available <= 0) {
      return { code: 'tool_unavailable', message: TOOL_UNAVAILABLE_MESSAGE, tool_id: tool, available: 0, holders: [] };
    }
  }
  return null;
}

/** The plant-wide `tool_overflow` findings for `validateCandidate`. ERROR (naming exactly ONE order, the least urgent
 * mutable holder, with a fixed message; the holders go in `detail`) only for a candidate the pass has run on; WARNING
 * when every holder is protected / out of scope, or before the pass ran. */
function toolOverflowFindings(
  snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, candidate: Readonly<CandidateResult>,
  scope: TaskScope, dispositions: ReadonlyMap<string, PlanningDisposition>, ctx: ToolRuleCtx,
): ValidationFinding[] {
  const stat = toolStaticFor(snapshot, bounds, ctx);
  if (!stat.byId.size) return [];
  const patches = new Map(candidate.patches.map(patch => [patch.id, patch]));
  const patchedView = patchedTaskView(snapshot.tasks, patches);
  const mutableIds = new Set(scope.mutable.map(taskId));
  const occ = buildToolOcc(ctx, stat, bounds, patchedView, { mutableIds, snapshot });
  const clusters = toolClusters(occ);
  // F3: a never-committed bar that is neither mutable nor firmed does not reserve copies, but an overflow it takes part in is
  // still shown, as a WARNING only (the alert counts it too).
  const warnOnly: ToolCluster[] = [];
  if ([...stat.neverCommitted].some(id => !mutableIds.has(id))) {
    const seenKeys = new Set(clusters.map(cluster => cluster.pusher + '\u0000' + cluster.tool));
    const everything = toolClusters(buildToolOcc(ctx, stat, bounds, patchedView));
    for (const cluster of everything) {
      if (seenKeys.has(cluster.pusher + '\u0000' + cluster.tool)) continue;
      if (toolClusterHolderIds(cluster).some(id => stat.neverCommitted.has(id) && !mutableIds.has(id))) warnOnly.push(cluster);
    }
  }
  if (!clusters.length && !warnOnly.length) return [];
  const movable = toolMovablePredicate(snapshot, bounds, scope, dispositions);
  const rank = toolUrgencyRank(snapshot, bounds, scope.mutable);
  const ran = candidate.toolPass !== undefined;
  const lineOf = new Map(snapshot.tasks.map(task => [taskId(task), String(task.MACHINE ?? '')]));
  const findings: ValidationFinding[] = [];
  const seen = new Set<string>();
  for (const cluster of clusters) {
    const movableIds = toolClusterHolderIds(cluster).filter(movable);
    const offender = ran && movableIds.length ? leastUrgentToolHolder(movableIds, rank) : null;
    const subject = offender ?? cluster.pusher;
    const key = subject + '\u0000' + cluster.tool + '\u0000' + (offender ? 'e' : 'w');
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      code: 'tool_overflow',
      message: offender ? TOOL_OVERFLOW_ERROR_MESSAGE : TOOL_OVERFLOW_WARNING_MESSAGE,
      severity: offender ? 'error' : 'warning',
      taskId: subject,
      line: lineOf.get(subject) ?? cluster.pusherLine,
      detail: { tool: cluster.tool, available: cluster.available, inUse: cluster.inUse, holders: toolHoldersDetail(cluster, offender) },
    });
  }
  for (const cluster of warnOnly) {
    const key = cluster.pusher + '\u0000' + cluster.tool + '\u0000w';
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      code: 'tool_overflow', message: TOOL_OVERFLOW_WARNING_MESSAGE, severity: 'warning', taskId: cluster.pusher,
      line: lineOf.get(cluster.pusher) ?? cluster.pusherLine,
      detail: { tool: cluster.tool, available: cluster.available, inUse: cluster.inUse, holders: toolHoldersDetail(cluster, null) },
    });
  }
  return findings;
}

function isStaleCoreError(error: unknown): boolean {
  return error instanceof Error && error.message === 'compute-core-stale';
}

function toolOverflowFailedFinding(): ValidationFinding {
  return { code: 'tool_overflow_failed', message: TOOL_OVERFLOW_FAILED_MESSAGE, severity: 'error' };
}

/** After retain / gap-fill / repair: keep `toolBlocked` / `toolMoved` truthful (an order that was later placed or
 * un-queued drops out; orders queued by the static `tool_unavailable` check or by repair on a tool finding join).
 * Absent (not empty) arrays when there is nothing to report; a candidate the pass never ran on is returned as is. */
export function reconcileToolOutcomes(result: CandidateResult): CandidateResult {
  if (result.toolPass === undefined) return result;
  const status = new Map((result.dispositions ?? []).map(d => [d.id, d]));
  const isToolCode = (code: unknown): boolean => code === 'tool_contention' || code === 'tool_unavailable';
  const blocked = new Map<string, ToolBlockedEntry>();
  for (const entry of result.toolBlocked ?? []) {
    const d = status.get(entry.orderId);
    const cascadeKept = entry.cause === 'cascade' && (entry.reasonCode ?? d?.reason?.code) === d?.reason?.code;
    if (d?.status === 'needs_planning' && (isToolCode(d.reason?.code) || cascadeKept)) blocked.set(entry.orderId, entry);
  }
  for (const patch of result.patches) {
    const reason = patch.changes.planning_reason;
    if (patch.changes.planning_status !== 'needs_planning' || !reason || !isToolCode(reason.code) || blocked.has(patch.id)) continue;
    const holders = Array.isArray(reason.holders) ? reason.holders.map(String) : [];
    blocked.set(patch.id, {
      orderId: patch.id, tool: String(reason.tool_id ?? ''), available: Number(reason.available ?? 0),
      inUse: reason.code === 'tool_unavailable' ? 0 : holders.length + 1, holderIds: holders,
    });
  }
  const patchById = new Map(result.patches.map(patch => [patch.id, patch]));
  const moved = (result.toolMoved ?? []).filter(entry =>
    status.get(entry.orderId)?.status === 'scheduled' && patchById.get(entry.orderId)?.changes.planning_status === 'scheduled');
  const { toolBlocked: _blocked, toolMoved: _moved, ...rest } = result;
  return {
    ...rest,
    ...(blocked.size ? { toolBlocked: [...blocked.values()].sort((a, b) => ordinalCompare(a.orderId, b.orderId)) } : {}),
    ...(moved.length ? { toolMoved: moved } : {}),
  };
}

function isToolReasonCode(code: unknown): boolean {
  return code === 'tool_contention' || code === 'tool_unavailable';
}

function toolIso(value: unknown): string | null {
  return timestamp(value)?.toISOString() ?? null;
}

/** Which tool a placement of `tools` on `line` over [start, end) is blocked by, with its copies and the OTHER-line holders in
 * that span (sorted, capped). Pure read of the occupancy; the first tool whose own headroom does not cover the span wins. */
export function toolContentionDetail(
  occ: ToolOcc, tools: readonly string[], line: string, start: Date | null, end: Date | null,
): { tool: string; available: number; holders: string[]; inUse: number } {
  const sorted = [...tools].sort();
  let tool = sorted[0] ?? '';
  if (start && end) {
    for (const candidate of sorted) {
      const windows = occ.ctx.core.toolHeadroom(occ.index, occ.ctx.plant, [candidate], start, end, line);
      if (!(windows.length === 1 && +windows[0].start <= +start && +windows[0].end >= +end)) { tool = candidate; break; }
    }
  }
  const available = occ.ctx.capacityFor(occ.ctx.plant, tool).available;
  const others = [...(occ.byTool.get(tool)?.values() ?? [])]
    .filter(item => item.line !== line && (!start || !end || (+item.start < +end && +item.end > +start)));
  const holders = others.map(item => item.id).sort(ordinalCompare).slice(0, TOOL_HOLDER_CAP);
  // In use = the DISTINCT other machines holding a copy (two items on one machine are one copy), from the untruncated list.
  return { tool, available, holders, inUse: new Set(others.map(item => item.line)).size + 1 };
}

export function mergeToolBlocked(prior: readonly ToolBlockedEntry[] | undefined, added: readonly ToolBlockedEntry[]): ToolBlockedEntry[] {
  const byOrder = new Map<string, ToolBlockedEntry>();
  for (const entry of [...(prior ?? []), ...added]) {
    const held = byOrder.get(entry.orderId);
    if (held && held.cause !== 'cascade' && entry.cause === 'cascade') continue;   // a tool queue outranks a cascade marker
    byOrder.set(entry.orderId, entry);
  }
  return [...byOrder.values()];
}

/** One entry per order (a second pass may move the same order again): the FIRST from, the LAST to; a net no-op is dropped. */
export function mergeToolMoved(prior: readonly ToolMovedEntry[] | undefined, added: readonly ToolMovedEntry[]): ToolMovedEntry[] {
  const byOrder = new Map<string, ToolMovedEntry>();
  for (const entry of [...(prior ?? []), ...added]) {
    const held = byOrder.get(entry.orderId);
    byOrder.set(entry.orderId, held ? { ...entry, fromStart: held.fromStart, fromEnd: held.fromEnd } : entry);
  }
  return [...byOrder.values()].filter(entry => !(entry.fromStart === entry.toStart && entry.fromEnd === entry.toEnd));
}

/**
 * Resolve every tool overflow on a finished candidate (see the header comment above for the algorithm and its
 * termination argument). Returns the candidate UNTOUCHED (same object, none of the tool fields) when the rule is not
 * active. Otherwise returns a repaired candidate carrying `toolPass`, plus `toolBlocked` / `toolMoved` when non-empty.
 * `budgetMs` defaults to 1 s (10 s for an Exhaustive run). `compute-core-stale` is rethrown unchanged (the worker client
 * answers it); any other exception fails CLOSED: the candidate comes back untouched except for `toolPass.failed`, and
 * `validateCandidate` then reports the fixed `tool_overflow_failed` ERROR, so Apply is disabled with a visible reason.
 */
export function resolveToolOverflow(
  snapshot: Readonly<ScheduleSnapshot>, boundsIn: Readonly<DueDateFirstBounds>, candidate: CandidateResult, budgetMs?: number,
): CandidateResult {
  try {
    return resolveToolOverflowRun(snapshot, boundsIn, candidate, budgetMs);
  } catch (error) {
    if (isStaleCoreError(error)) throw error;
    return {
      ...candidate,
      toolPass: { complete: false, elapsedMs: candidate.toolPass?.elapsedMs ?? 0, failed: true, error: String((error as Error | undefined)?.message ?? error).slice(0, 300) },
      validationFindings: [...(candidate.validationFindings ?? []).filter(f => f.code !== 'tool_overflow_failed'), toolOverflowFailedFinding()],
    };
  }
}

function resolveToolOverflowRun(
  snapshot: Readonly<ScheduleSnapshot>, boundsIn: Readonly<DueDateFirstBounds>, candidate: CandidateResult, budgetMs?: number,
): CandidateResult {
  const ctx = toolRuleContext(snapshot, boundsIn);
  if (!ctx) return candidate;
  const bounds = withRunContext(snapshot, hardBounds(snapshot, boundsIn));
  const started = bounds.clock();
  const limit = budgetMs ?? (bounds.exhaustive === true ? TOOL_PASS_EXHAUSTIVE_BUDGET_MS : TOOL_PASS_NORMAL_BUDGET_MS);
  const expired = (): boolean => bounds.clock() - started >= limit;
  const stat = toolStaticFor(snapshot, bounds, ctx);
  const scope = buildTaskScope(snapshot, bounds);
  const patches = new Map(candidate.patches.map(patch => [patch.id, patch]));
  const dispositions = new Map((candidate.dispositions ?? []).map(d => [d.id, d]));
  const mutableIds = new Set(scope.mutable.map(taskId));
  const reserve: ToolReserveScope = { mutableIds, snapshot };
  let occ = buildToolOcc(ctx, stat, bounds, patchedTaskView(snapshot.tasks, patches), reserve);
  const movable = toolMovablePredicate(snapshot, bounds, scope, dispositions);
  const mutableById = new Map(scope.mutable.map(task => [taskId(task), task]));
  const originalById = new Map(snapshot.tasks.map(task => [taskId(task), task]));
  const moved: ToolMovedEntry[] = [];
  const blocked: ToolBlockedEntry[] = [];
  const beforeDates = new Map<string, { start: string | null; end: string | null }>();
  const byLine = new Map<string, NimbusTask[]>();
  for (const task of scope.evaluation) {
    const line = String(task.MACHINE);
    const peers = byLine.get(line) ?? []; peers.push(task); byLine.set(line, peers);
  }
  const env: GapEnv = { snapshot, bounds, candidate, byLine, availability: new Map(), patches, dispositions, expired, toolRuleActive: true };
  let rankMemo: Map<string, number> | null = null;
  const rank = (): Map<string, number> => rankMemo ??= toolUrgencyRank(snapshot, bounds, scope.mutable);
  const settled = new Set<string>();
  let complete = true;
  let changed = false;
  let degraded = false;

  const originalDates = (id: string): { start: string | null; end: string | null } => {
    const row = originalById.get(id);
    return { start: toolIso(row?.start_date), end: toolIso(row?.end_date) };
  };
  /** Queue one order with the structured reason and record it (the caller has already taken it out of the occupancy). */
  const queueOrder = (id: string, tools: readonly string[], cluster: { tool: string; inUse: number }, holders: string[], incomplete: boolean): void => {
    const line = String(mutableById.get(id)!.MACHINE);
    const zero = [...tools].sort().find(tool => ctx.capacityFor(ctx.plant, tool).available <= 0);
    const tool = zero ?? cluster.tool;
    const available = ctx.capacityFor(ctx.plant, tool).available;
    const reason = toolQueueReason(zero ? 'tool_unavailable' : 'tool_contention', tool, available, holders, incomplete);
    patches.set(id, toolQueuePatch(id, reason));
    dispositions.set(id, { id, line, status: 'needs_planning', reason });
    blocked.push({ orderId: id, tool, available, inUse: zero ? 0 : cluster.inUse, holderIds: holders });
    changed = true;
  };
  const recordMove = (id: string, tool: string, patch: SchedulePatch): void => {
    const was = beforeDates.get(id) ?? originalDates(id);
    moved.push({
      orderId: id, tool, fromStart: was.start, fromEnd: was.end,
      toStart: toolIso(patch.changes.start_date) ?? '', toEnd: toolIso(patch.changes.end_date) ?? '',
    });
  };

  /** Budget expired: ONE greedy sweep per tool queues the least urgent movable holder whenever the machines in use exceed the copies. */
  const queueSweep = (): void => {
    complete = false; degraded = true;
    for (const tool of [...occ.byTool.keys()].sort()) {
      const list = [...(occ.byTool.get(tool)?.values() ?? [])];
      const available = ctx.capacityFor(ctx.plant, tool).available;
      if (!list.length || new Set(list.map(item => item.line)).size <= available) continue;
      const events: Array<{ t: number; type: 0 | 1; item: ToolItem }> = [];
      for (const item of list) { events.push({ t: +item.start, type: 1, item }, { t: +item.end, type: 0, item }); }
      events.sort((a, b) => a.t - b.t || a.type - b.type || +a.item.start - +b.item.start || +a.item.end - +b.item.end
        || ordinalCompare(a.item.id, b.item.id) || ordinalCompare(a.item.line, b.item.line));
      const active = new Map<string, ToolItem>();
      const lineCount = new Map<string, number>();
      const gone = new Set<string>();
      const drop = (item: ToolItem): void => {
        active.delete(item.id);
        const n = (lineCount.get(item.line) ?? 0) - 1;
        if (n <= 0) lineCount.delete(item.line); else lineCount.set(item.line, n);
      };
      for (const ev of events) {
        if (gone.has(ev.item.id)) continue;
        if (ev.type === 0) { if (active.has(ev.item.id)) drop(ev.item); continue; }
        active.set(ev.item.id, ev.item);
        lineCount.set(ev.item.line, (lineCount.get(ev.item.line) ?? 0) + 1);
        while (lineCount.size > available) {
          const ids = [...active.keys()].filter(id => movable(id) && !settled.has(id));
          if (!ids.length) break;
          const victim = leastUrgentToolHolder(ids, rank());
          const holders = [...active.keys()].filter(id => id !== victim).sort(ordinalCompare).slice(0, TOOL_HOLDER_CAP);
          const inUse = lineCount.size;
          drop(active.get(victim)!); gone.add(victim);
          beforeDates.set(victim, originalDates(victim));
          toolOccRemove(occ, victim);
          queueOrder(victim, stat.byId.get(victim)?.tools ?? [], { tool, inUse }, holders, true);
        }
      }
    }
  };

  const pickOffender = (): { cluster: ToolCluster; offender: string } | null => {
    let pick: { cluster: ToolCluster; offender: string } | null = null;
    findToolCluster(occ, cluster => {
      const ids = toolClusterHolderIds(cluster).filter(id => movable(id) && !settled.has(id));
      if (!ids.length) return false;
      pick = { cluster, offender: leastUrgentToolHolder(ids, rank()) };
      return true;
    });
    return pick;
  };

  if (stat.byId.size && toolClusters(occ).length) {
    let movableTools = 0;
    for (const id of occ.items.keys()) if (movable(id)) movableTools++;
    const maxSteps = movableTools + 1;
    let steps = 0;
    for (;;) {
      const pick = pickOffender();
      if (!pick) break;
      if (steps >= maxSteps) { complete = false; break; }
      steps++;
      if (expired()) { queueSweep(); break; }
      const { cluster, offender } = pick;
      const task = mutableById.get(offender)!;
      const line = String(task.MACHINE);
      const tools = stat.byId.get(offender)?.tools ?? [];
      const before = { ...originalById.get(offender)!, ...patches.get(offender)?.changes } as NimbusTask;
      beforeDates.set(offender, { start: toolIso(before.start_date), end: toolIso(before.end_date) });
      toolOccRemove(occ, offender);
      // Tentatively queue the offender so the gap walk sees the line without it (exactly the gap-fill situation).
      patches.set(offender, toolQueuePatch(offender, { code: 'tool_contention', message: TOOL_CONTENTION_MESSAGE }));
      dispositions.set(offender, { id: offender, line, status: 'needs_planning', reason: { code: 'tool_contention', message: TOOL_CONTENTION_MESSAGE } });
      const outcome: GapOutcome = placeTaskInLineGaps(env, task, toolGapHooks(occ, tools, line));
      changed = true;
      if (outcome.kind === 'placed') {
        patches.set(offender, outcome.patch);
        dispositions.set(offender, outcome.disposition);
        const item = toolItemFor(ctx, stat, occ.runNowMs, { ...task, ...outcome.patch.changes } as NimbusTask);
        if (item) toolOccAdd(occ, item);
        settled.add(offender);
        recordMove(offender, cluster.tool, outcome.patch);
        continue;
      }
      if (outcome.kind === 'incomplete') complete = false;
      queueOrder(offender, tools, cluster, toolHoldersDetail(cluster, offender), outcome.kind === 'incomplete');
    }
  }

  /** Budget ran out with queued tool orders still waiting for a slot: say so on the orders this pass queued. */
  const markIncomplete = (): void => {
    complete = false;
    for (const entry of blocked) {
      const reason = patches.get(entry.orderId)?.changes.planning_reason as { code?: string; tool_id?: string; available?: number; holders?: string[]; incomplete?: boolean } | null | undefined;
      if (dispositions.get(entry.orderId)?.status !== 'needs_planning' || reason?.code !== 'tool_contention' || reason.incomplete) continue;
      const next = toolQueueReason('tool_contention', String(reason.tool_id ?? entry.tool), Number(reason.available ?? entry.available), reason.holders ?? [], true);
      patches.set(entry.orderId, toolQueuePatch(entry.orderId, next));
      dispositions.set(entry.orderId, { id: entry.orderId, line: String(mutableById.get(entry.orderId)?.MACHINE ?? ''), status: 'needs_planning', reason: next });
      changed = true;
    }
  };

  // RECOVERY: a step decides an order's fate against the occupancy of its moment, and a later step (or the repair
  // cascade) can vacate a slot an earlier queued order needed. Re-offer every tool_contention order the candidate holds
  // (this pass's AND those an earlier run of the pass left), most urgent first, to the gaps of the FINAL occupancy until
  // nothing changes: each success un-queues one order (a finite, strictly decreasing count) and never re-creates overflow
  // (tool-free windows + envelope check), so the queued orders that remain really have no legal tool-free slot.
  const recover = (): boolean => {
    if (degraded || !complete) return false;
    let placedAny = false;
    for (;;) {
      const retry = [...dispositions.values()]
        .filter(d => d.status === 'needs_planning' && d.reason?.code === 'tool_contention' && mutableIds.has(d.id))
        .map(d => d.id)
        .sort((a, b) => (rank().get(a) ?? 0) - (rank().get(b) ?? 0) || ordinalCompare(a, b));
      if (!retry.length) return placedAny;
      if (expired()) { markIncomplete(); return placedAny; }
      let progressed = false;
      for (const id of retry) {
        const task = mutableById.get(id)!;
        const line = String(task.MACHINE);
        const outcome = placeTaskInLineGaps(env, task, toolGapHooks(occ, stat.byId.get(id)?.tools ?? [], line));
        if (outcome.kind === 'incomplete') { markIncomplete(); return placedAny; }
        if (outcome.kind !== 'placed') continue;
        const queuedReason = patches.get(id)?.changes.planning_reason as { tool_id?: string } | null | undefined;
        patches.set(id, outcome.patch);
        dispositions.set(id, outcome.disposition);
        const item = toolItemFor(ctx, stat, occ.runNowMs, { ...task, ...outcome.patch.changes } as NimbusTask);
        if (item) toolOccAdd(occ, item);
        const entry = blocked.find(b => b.orderId === id);
        if (entry) blocked.splice(blocked.indexOf(entry), 1);
        recordMove(id, entry?.tool ?? String(queuedReason?.tool_id ?? ''), outcome.patch);
        progressed = true; placedAny = true; changed = true;
        break;
      }
      if (!progressed) return placedAny;
    }
  };
  recover();

  const assemble = (base: CandidateResult): CandidateResult => ({
    ...base,
    ...(changed ? { patches: [...patches.values()], dispositions: [...dispositions.values()] } : {}),
    toolPass: { complete: complete && candidate.toolPass?.complete !== false, elapsedMs: (candidate.toolPass?.elapsedMs ?? 0) + Math.max(0, bounds.clock() - started) },
    toolBlocked: mergeToolBlocked(base.toolBlocked, blocked),
    toolMoved: mergeToolMoved(base.toolMoved, moved),
  });
  /** Orders the repair cascade queued (they were scheduled before it) on the line of an order this pass moved or queued. */
  const cascadeOf = (after: CandidateResult, before: ReadonlyMap<string, PlanningDisposition>): ToolBlockedEntry[] => {
    const causes = new Map<string, string>();                       // order id -> tool, for every order this pass moved or queued
    for (const entry of moved) causes.set(entry.orderId, entry.tool);
    for (const entry of blocked) causes.set(entry.orderId, entry.tool);
    const out: ToolBlockedEntry[] = [];
    for (const d of after.dispositions ?? []) {
      if (d.status !== 'needs_planning' || before.get(d.id)?.status !== 'scheduled' || !mutableIds.has(d.id) || blocked.some(b => b.orderId === d.id)) continue;
      const row = { ...originalById.get(d.id)!, ...patches.get(d.id)?.changes } as NimbusTask;
      const startMs = +(timestamp(row.start_date) ?? 0);
      const onLine = [...causes.keys()].filter(id => id !== d.id && String(mutableById.get(id)?.MACHINE) === d.line).sort(ordinalCompare);
      if (!onLine.length && !causes.has(d.id)) continue;
      if (!onLine.length) onLine.push(d.id);
      // The cause is the order whose ORIGINAL slot ended last at or before this order's start; else the first on the line.
      let cause = onLine[0]; let best = -Infinity;
      for (const id of onLine) {
        const end = +(timestamp((beforeDates.get(id) ?? originalDates(id)).end) ?? -Infinity);
        if (end <= startMs && end > best) { best = end; cause = id; }
      }
      const tool = causes.get(cause) ?? '';
      const entry: ToolBlockedEntry = { orderId: d.id, tool, available: ctx.capacityFor(ctx.plant, tool).available, inUse: 0, holderIds: [cause], cause: 'cascade', ...(d.reason?.code ? { reasonCode: String(d.reason.code) } : {}) };
      out.push(entry);
    }
    return out;
  };

  // The old successor of a moved or queued order may now need a longer (or an unrecorded) setup: the existing repair
  // cascade handles that exactly as it does for any queued order. It also refreshes `validationFindings`.
  let statusBefore = new Map(dispositions);
  let result = repairCandidate(snapshot, bounds, assemble(candidate));
  let exhausted = true;
  for (let round = 0; round < 2; round++) {
    const queuedByRepair = (result.dispositions ?? []).some(d => d.status === 'needs_planning' && statusBefore.get(d.id)?.status === 'scheduled');
    if (!queuedByRepair) { exhausted = false; break; }
    blocked.push(...cascadeOf(result, statusBefore));
    // Repair freed copies (the queued successor holds none) and may have opened a slot an earlier tool_contention order
    // never saw: sync the working state to the repaired candidate and run recovery once more.
    patches.clear(); for (const patch of result.patches) patches.set(patch.id, patch);
    dispositions.clear(); for (const d of result.dispositions ?? []) dispositions.set(d.id, d);
    occ = buildToolOcc(ctx, stat, bounds, patchedTaskView(snapshot.tasks, patches), reserve);
    changed = true;
    statusBefore = new Map(dispositions);
    if (!recover()) { result = assemble(result); exhausted = false; break; }
    result = repairCandidate(snapshot, bounds, assemble(result));
  }
  // The rounds are capped: orders the LAST repair queued still get their cascade attribution (no further recovery runs).
  if (exhausted) {
    const late = cascadeOf(result, statusBefore);
    if (late.length) result = { ...result, toolBlocked: mergeToolBlocked(result.toolBlocked, late) };
  }
  return reconcileToolOutcomes(result);
}

/** Revalidates the complete proposal. Protected legacy violations are warnings, never a partial-Apply veto. */
export function validateCandidate(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, candidate: Readonly<CandidateResult>, currentSnapshot?: Readonly<ScheduleSnapshot>): ValidationFinding[] {
  bounds = withRunContext(snapshot, hardBounds(snapshot, bounds));
  const plantSetupReallyActive = snapshot.masterData?.plants?.find(row => row.plant === bounds.setup.plant)?.setup_active !== false;
  const findings: ValidationFinding[] = [];
  const add = (code: string, message: string, task?: NimbusTask, protectedTask = false, setupRelated = false): void => { findings.push({ code, message, severity: protectedTask || (setupRelated && !plantSetupReallyActive) ? 'warning' : 'error', ...(task ? { taskId: taskId(task), line: String(task.MACHINE) } : {}) }); };
  if (currentSnapshot) {
    const baselineSnapshot = candidate.validationContext?.baselineSnapshot ?? snapshot;
    // `readModelVersion` is recorded for diagnostics only and is deliberately
    // NOT a validity signal: it mirrors Store.rev(), a global counter that
    // moves on every Store event (alerts:change from the async alert
    // recompute, lines:selected, settings:change, ...), none of which alter
    // the evaluator's inputs. Treating it as staleness rejected every Apply
    // on the pilot. The structural comparison below covers the complete
    // scheduling read model, so identical state means the candidate is
    // exactly as valid as when it was evaluated.
    // `frozenHorizonEnd` is excluded for the same reason: the frozen horizon rolls with the
    // clock (now + N days, 2026-10-19), so the instant captured at snapshot time is always
    // behind a later snapshot. The horizon's actual input, the plant's `frozen_horizon_days`,
    // lives in `masterData.plants[]` and stays inside the comparison.
    const { readModelVersion: _baselineRevision, frozenHorizonEnd: _baselineFrozenEnd, ...baselineState } = baselineSnapshot;
    const { readModelVersion: _currentRevision, frozenHorizonEnd: _currentFrozenEnd, ...currentState } = currentSnapshot;
    const baseline = JSON.stringify({ ...baselineState, alerts: [], firmedIds: [...baselineSnapshot.firmedIds].sort() });
    const current = JSON.stringify({ ...currentState, alerts: [], firmedIds: [...currentSnapshot.firmedIds].sort() });
    if (baseline !== current) add('stale_candidate', 'The schedule or scheduling inputs changed after this proposal was evaluated.');
  }
  const taskScope = buildTaskScope(snapshot, bounds);
  const tasks = taskScope.mutable;
  const occupancyTasks = taskScope.evaluation;
  const ids = new Set(tasks.map(taskId));
  const boundaryIds = new Set(taskScope.boundaries.map(taskId));
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
  for (const task of occupancyTasks) {
    const boundaryOnly = boundaryIds.has(taskId(task)) && !ids.has(taskId(task));
    const protectedTask = taskIsFirmed(snapshot, task) || boundaryOnly;
    const patch = patches.get(taskId(task));
    const result = { ...task, ...patch?.changes };
    const disposition = dispositions.get(taskId(task));
    if (boundaryOnly) {
      // Occupancy rows are outside the mutable contract. They cannot create a
      // disposition or a scope error, and their historical calendar/runtime
      // defects must not veto the selected repair. A usable interval still
      // reserves physical capacity for overlap/setup checks below.
      const intervals = productiveIntervals(result);
      const start = timestamp(result.start_date); const end = timestamp(result.end_date);
      if (!start || !end || end <= start || !intervals.length
        || intervals.some(interval => interval.end <= interval.start)
        || +intervals[0].start !== +start || +intervals.at(-1)!.end !== +end) continue;
      const line = String(task.MACHINE); const list = occupied.get(line) ?? [];
      for (const interval of intervals) list.push({ interval, task: result, protectedTask: true });
      occupied.set(line, list);
      continue;
    }
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
    // Frozen finish floor (unprotected orders only): the message is fixed so applyPartial's code|taskId|message baseline key is stable.
    if (!protectedTask && bounds.finishFloor && end < bounds.finishFloor) add('date_window', 'Production finishes inside the frozen horizon.', task, protectedTask);
    const minutes = intervals.reduce((sum, i) => sum + (+i.end - +i.start) / 60000, 0);
    if (Math.abs(minutes - Math.round(Number(task.RUN_TIME) * 60)) > 0.001) add('runtime', 'Productive duration does not match runtime.', task, protectedTask);
    const policy = splitOrderPolicyForSnapshot(snapshot, bounds.setup.plant);
    // The overlong decision is made from the placement origin (as `neverOverlongReason` and the placement walk do),
    // not from each order's own start, so a split placed under that decision is not flagged here.
    if (intervals.length > 1 && (policy === 'never' || (policy === 'overlong_only' && hasNominalWindow(snapshot, String(task.MACHINE), bounds.setup.plant, bounds.placementStart ?? bounds.now, Math.round(Number(task.RUN_TIME) * 60), bounds.runContext)))) add('split_policy', 'Order splitting violates plant policy.', task, protectedTask);
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
  // Tool Inventory: plant-wide tool overflow (rule Hard + inventory loaded + not Remove Backlog; skipped by per-line trials).
  const toolCtx = bounds.skipToolOverflowFinding === true ? null : toolRuleContext(snapshot, bounds);
  if (toolCtx) {
    // Fail closed: a throw here (anything but the stale core, which the worker client answers) must not silently skip the
    // rule. The candidate then carries an ERROR finding with a fixed, planner-visible message and Apply stays disabled.
    try { findings.push(...toolOverflowFindings(snapshot, bounds, candidate, taskScope, dispositions, toolCtx)); }
    catch (error) { if (isStaleCoreError(error)) throw error; findings.push(toolOverflowFailedFinding()); }
    if (candidate.toolPass?.failed === true) findings.push(toolOverflowFailedFinding());
  }
  // Setup occupies the calendar immediately before each productive start.
  const proposed = applyPatchesToSnapshot(occupancyTasks, candidate.patches).filter(task => task.planning_status !== 'needs_planning' && timestamp(task.start_date) && timestamp(task.end_date));
  const lines = new Set(proposed.map(task => String(task.MACHINE)));
  for (const line of lines) {
    const lineTasks = proposed.filter(task => String(task.MACHINE) === line).sort((a, b) => +timestamp(a.start_date)! - +timestamp(b.start_date)! || ordinalCompare(taskId(a), taskId(b)));
    const definition = bounds.setup.definition;
    // N8 fix-up: a definition-less or setup-incompatible line never charges
    // the plant default (this is the same gate resolveSetup's own callers
    // already applied); an unrecorded initial/order state on an otherwise
    // chargeable line still resolves through chargedSetupMinutes below via a
    // null resolution.
    const chargeable = setupChargeableOnLine(bounds, snapshot, line);
    let state = definition ? initialStateForLine(bounds, line, definition.signature_version).state : null;
    let predecessor: NimbusTask | null = null;
    for (const task of lineTasks) {
      const protectedTask = taskIsEvaluationProtected(snapshot, bounds, task);
      const successor = definition ? stateForOrder(task, definition) : null;
      const resolution = chargeable && state && successor
        ? resolveSetup({ definition: definition!, machine: line, predecessorState: state, successorState: successor, predecessorOrderId: predecessor ? taskId(predecessor) : null, successorOrderId: taskId(task), plantRows: bounds.setup.plant_rows, machineRows: bounds.setup.machine_rows, overrides: bounds.setup.overrides, valueDefaults: bounds.setup.value_defaults ?? NO_VALUE_DEFAULTS, index: bounds.runContext?.resolutionIndex ?? undefined })
        : null;
      // excludeFromSearch (O2): the search refuses an unprotected order whose transition has no matrix row, so an incumbent
      // sitting behind one is an error too (repairCandidate queues it). Both states are known (resolution exists only then) and the
      // line is chargeable. Not flagged setupRelated, so it stays an error on setup-inactive plants; synthetic snapshots
      // (Remove Backlog, setup-inactive plants) force the policy to zero and never reach it.
      if (bounds.runContext?.unknownSetupPolicy === 'excludeFromSearch' && resolution && !resolution.covered && !protectedTask) {
        add('setup_transition_unrecorded', `No setup transition is recorded from ${setupStateLabel(state)} to ${setupStateLabel(successor)} on ${line}; this plant excludes such orders from automatic placement.`, task, protectedTask, false);
      }
      if (!resolution?.covered && !bounds.setup.synthetic) findings.push({ code: 'missing_setup', message: "A missing setup transition uses the plant's configured default (zero unless plantDefaultMinutes is set).", severity: 'warning', taskId: taskId(task), line });
      const minutes = chargedSetupMinutes(bounds.runContext, resolution, chargeable);
      if (minutes > 0) {
        const end = timestamp(task.start_date)!; const start = new Date(+end - minutes * 60000);
        const floor = notBeforeFor(bounds, task);
        if ((!protectedTask && start < bounds.now) || (floor && start < floor)) add('setup_floor', 'Setup begins before the allowed placement floor.', task, protectedTask, true);
        const free = freeIntervalsFor(snapshot, line, bounds.setup.plant, start, end, bounds.runContext);
        if (!coversInterval(free, { start, end })) add('setup_calendar', 'Setup overlaps nonworking time or a blackout.', task, protectedTask, true);
        if (predecessor && timestamp(predecessor.end_date)! > start) {
          const bothProtected = protectedTask && taskIsEvaluationProtected(snapshot, bounds, predecessor);
          add('setup_overlap', 'Required setup overlaps preceding production.', protectedTask && !bothProtected ? predecessor : task, bothProtected, true);
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
    // A queued order changes its successor's predecessor, so an unrecorded-transition error can clear itself
    // down the line: reject only the earliest such order per line per pass and let the re-validation decide the rest.
    // Every other failure is rejected outright, as before.
    const patchedTasks = applyPatchesToSnapshot(snapshot.tasks, result.patches);
    const startById = new Map(patchedTasks.map(task => [taskId(task), +(timestamp(task.start_date) ?? 0)]));
    const patchedById = new Map(patchedTasks.map(task => [taskId(task), task]));
    const reasonBy = new Map<string, ValidationFinding>();
    const earliestUnrecorded = new Map<string, ValidationFinding>();
    for (const f of failures) {
      if (f.code !== 'setup_transition_unrecorded') { reasonBy.set(f.taskId!, f); continue; }
      const held = earliestUnrecorded.get(f.line ?? '');
      if (!held || (startById.get(f.taskId!) ?? 0) < (startById.get(held.taskId!) ?? 0)) earliestUnrecorded.set(f.line ?? '', f);
    }
    for (const f of earliestUnrecorded.values()) if (!reasonBy.has(f.taskId!)) reasonBy.set(f.taskId!, f);
    const queueReason = (id: string): { code: string; message: string } => {
      const f = reasonBy.get(id);
      if (f?.code === 'setup_transition_unrecorded') return { code: f.code, message: f.message };
      if (f?.code === 'tool_overflow' && f.detail) return toolQueueReason('tool_contention', f.detail.tool, f.detail.available, [...f.detail.holders], false);
      const generic = { code: 'no_fit_found', message: 'The proposed placement failed final capacity or setup validation.' };
      // O6: a date_window error caused by the end passing the push-forward ceiling is the limit's doing.
      if (f?.code !== 'date_window') return generic;
      const task = patchedById.get(id);
      const end = task ? timestamp(task.end_date) : null;
      const ceiling = task ? notAfterFor(bounds, task) : null;
      return task && end !== null && ceiling && +end > +ceiling ? pushLimitAware(bounds, task, generic) : generic;
    };
    const repairPatches = result.patches.map(patch => reasonBy.has(patch.id) ? { id: patch.id, changes: { start_date: null, end_date: null, scheduleSegments: [], planning_status: 'needs_planning' as const, planning_reason: queueReason(patch.id) } } : patch);
    const repaired = (result.dispositions ?? []).map(d => reasonBy.has(d.id) && d.status !== 'protected' ? { ...d, status: 'needs_planning' as const, reason: queueReason(d.id) } : d);
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
  // Tool Inventory: occupancy from the FULL plant task list (the per-line trials below are tool-blind).
  const toolCtx = toolRuleContext(snapshot, bounds);
  const toolStat = toolCtx ? toolStaticFor(snapshot, bounds, toolCtx) : null;
  const toolMutable = toolCtx ? new Set(eligibleTasks(snapshot, bounds).map(taskId)) : null;
  const toolOcc = toolCtx && toolStat && toolMutable ? buildToolOcc(toolCtx, toolStat, bounds, patchedTaskView(snapshot.tasks, patches), { mutableIds: toolMutable, snapshot }) : null;
  const toolDropped = new Map<string, { tools: string[]; line: string; start: Date; end: Date }>();
  const byLine = new Map<string, NimbusTask[]>();
  for (const item of evaluationTasks(snapshot, bounds)) {
    const line = String(item.MACHINE);
    const tasks = byLine.get(line) ?? []; tasks.push(item); byLine.set(line, tasks);
  }
  for (const [line, tasks] of byLine) {
    let pending = urgencyOrder(snapshot, bounds, line, tasks).filter(item => additions.has(taskId(item)));
    if (!pending.length) continue;
    const localSnapshot = { ...snapshot, tasks };
    const localBounds = { ...bounds, lines: [line], skipToolOverflowFinding: true };
    let progressed = true;
    while (pending.length && progressed) {
      progressed = false;
      const retry: NimbusTask[] = [];
      for (const item of pending) {
        const id = taskId(item);
        const placement = additions.get(id)!;
        // A retained placement may not re-create tool overflow: its ENVELOPE must be tool-free against the whole plant.
        const toolAdd = toolOcc ? toolItemFor(toolOcc.ctx, toolStat!, toolOcc.runNowMs, { ...item, ...placement.changes } as NimbusTask) : null;
        const toolBlockedHere = !!(toolOcc && toolAdd && !toolGapHooks(toolOcc, toolAdd.tools, line).envelopeFits(toolAdd.start, toolAdd.end));
        if (toolBlockedHere && preferred.toolPass === undefined) continue;
        const disposition: PlanningDisposition = { id, line, status: 'scheduled' };
        const proposal = {
          ...preferred,
          patches: tasks.flatMap(peer => taskId(peer) === id ? [placement] : patches.has(taskId(peer)) ? [patches.get(taskId(peer))!] : []),
          dispositions: tasks.flatMap(peer => {
            const value = taskId(peer) === id ? disposition : dispositions.get(taskId(peer));
            return value ? [value] : [];
          }),
        };
        const errors = validateCandidate(localSnapshot, localBounds, proposal).filter(f => f.severity === 'error');
        if (toolBlockedHere) {
          // The incumbent slot is dropped for tooling alone when nothing else rejects it: report it as a tool queue below.
          if (!errors.length && toolAdd) toolDropped.set(id, { tools: toolAdd.tools, line, start: toolAdd.start, end: toolAdd.end });
          continue;
        }
        if (!errors.length) {
          patches.set(id, placement); dispositions.set(id, disposition); progressed = true;
          if (toolOcc && toolAdd) toolOccAdd(toolOcc, toolAdd);
        } else if (errors.every(f => f.code.startsWith('setup_'))) {
          // Another accepted addition can supply a setup bridge. Production
          // overlaps and window failures cannot be repaired by adding orders.
          retry.push(item);
        }
      }
      pending = retry;
    }
  }
  const droppedBlocked: ToolBlockedEntry[] = [];
  if (toolOcc && toolDropped.size) {
    // Decision 7: an order whose only obstacle was a tool is a tool queue (reason + toolBlocked), whatever reason it carried.
    for (const [id, info] of toolDropped) {
      if (dispositions.get(id)?.status !== 'needs_planning' || isToolReasonCode(dispositions.get(id)?.reason?.code)) continue;
      const detail = toolContentionDetail(toolOcc, info.tools, info.line, info.start, info.end);
      const reason = toolQueueReason('tool_contention', detail.tool, detail.available, detail.holders, false);
      patches.set(id, toolQueuePatch(id, reason));
      dispositions.set(id, { id, line: info.line, status: 'needs_planning', reason });
      droppedBlocked.push({ orderId: id, tool: detail.tool, available: detail.available, inUse: detail.inUse, holderIds: detail.holders });
    }
  }
  const result = { ...preferred, patches: [...patches.values()], dispositions: [...dispositions.values()],
    ...(droppedBlocked.length ? { toolBlocked: mergeToolBlocked(preferred.toolBlocked, droppedBlocked) } : {}) };
  return { ...result, validationFindings: validateCandidate(snapshot, bounds, result) };
}

/**
 * P3a — detection only. Warns (never blocks, never affects the score vector)
 * Severity (D50): this finding stays 'warning' while the compute-core ALERT for the same
 * condition is sev 'err' - a validation 'error' would block Apply on a condition the
 * optimizer cannot always repair, whereas the alert is the planner-facing red flag.
 * when a SAP aggregate order's distributed sub-orders (siblings sharing
 * `PARENT_ORDER`) finish further apart than their work center's configured
 * `max_separation` policy allows (judged on the FINISH, backward scheduling OQ38:
 * siblings share the finish, so a family that finishes together raises nothing).
 * Hand-mirrored by nimbus-compute-core.js `computeAlerts` rule 1c - keep the two in step. A future alignment pass may actually fix
 * these; this only surfaces them.
 */
function checkDistributionSeparation(
  patches: ReadonlyArray<SchedulePatch>,
  snapshot: Readonly<ScheduleSnapshot>,
): ValidationFinding[] {
  const finalTasks = applyPatchesToSnapshot(snapshot.tasks, patches);

  const machineToWorkcenter = new Map<string, string>();
  for (const line of snapshot.masterData?.lines ?? []) {
    if (line.sap_workcenter) machineToWorkcenter.set(line.machine, line.sap_workcenter);
  }
  const workcenterPolicy = new Map<string, NimbusMasterWorkcenter>();
  for (const workcenter of snapshot.masterData?.workcenters ?? []) {
    workcenterPolicy.set(workcenter.sap_workcenter, workcenter);
  }

  const groups = new Map<string, NimbusTask[]>();
  for (const task of finalTasks) {
    if (!task.PARENT_ORDER || task.planning_status === 'needs_planning') continue;
    const plant = resolveTaskPlant(task, snapshot) ?? '';
    const key = `${plant}\u0000${task.PARENT_ORDER}\u0000${task.MATERIAL_NUMBER ?? ''}`;
    const group = groups.get(key);
    if (group) group.push(task); else groups.set(key, [task]);
  }

  const findings: ValidationFinding[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Mirror nimbus-compute-core.js's computeAlerts: scan every sibling (not
    // just group[0]) for the first machine that resolves to a workcenter with
    // a truthy max_separation policy, so the two never disagree purely due to
    // sibling-iteration order.
    let maxSeparation: NimbusMasterWorkcenter['max_separation'] | undefined;
    for (const task of group) {
      const machine = String(task.MACHINE ?? '');
      const workcenterId = machineToWorkcenter.get(machine);
      const policy = workcenterId ? workcenterPolicy.get(workcenterId) : undefined;
      if (policy?.max_separation) { maxSeparation = policy.max_separation; break; }
    }
    if (!maxSeparation || maxSeparation === 'none') continue;
    // D50: mirror nimbus-compute-core.js's computeAlerts — an undated sibling
    // (no start_date yet, e.g. still mid-placement) is not yet part of the
    // "do these siblings finish together" question and must not be bucketed at
    // all, let alone bucketed as its own mismatching group of one.
    const dated = group.filter(task => task.end_date);
    if (dated.length < 2) continue;
    const buckets = dated.map(task => globalThis.NimbusComputeCore!.separationBucketKey(task.end_date, maxSeparation));
    if (buckets.some(bucket => bucket !== buckets[0])) {
      findings.push({
        code: 'distribution_separation',
        severity: 'warning',
        parents: dated.map(taskId),
        message: `Sub-orders of ${dated[0].PARENT_ORDER} finish in different ${maxSeparation} buckets.`,
      });
    }
  }
  return findings;
}

/** Recompute `distribution_separation` findings fresh against a result's
 * truly-final patches and merge them into its validationFindings, replacing
 * (never duplicating) any stale entries a caller already had — the finding
 * must always reflect the last placement pass to touch `result.patches`, not
 * whatever pass happened to run `checkDistributionSeparation` first. */
function withFreshDistributionFindings(result: CandidateResult, snapshot: Readonly<ScheduleSnapshot>): CandidateResult {
  const distributionFindings = checkDistributionSeparation(result.patches, snapshot);
  return {
    ...result,
    validationFindings: [
      ...(result.validationFindings ?? []).filter(f => f.code !== 'distribution_separation'),
      ...distributionFindings,
    ],
  };
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
      const reason = defect ?? bounds.runContext?._setupExclusions.get(id) ?? neverOverlongReason(snapshot, bounds, task) ?? unfittableReason(snapshot, bounds, task) ?? pushLimitAware(bounds, task, noFitReason(candidate));
      patches.set(id, { id, changes: { start_date: null, end_date: null, scheduleSegments: [], planning_status: 'needs_planning', planning_reason: reason } });
      dispositions.push({ id, line, status: 'needs_planning', reason });
    }
  }
  let result: CandidateResult = {
    ...candidate,
    patches: [...patches.values()],
    dispositions,
    searchComplete: candidate.diagnostics.exhaustive === true && candidate.diagnostics.termination === 'completed',
    validationContext: { snapshot, bounds },
    windowEndHeldIds: buildTaskScope(snapshot, bounds).boundaries
      .filter(task => isWindowEndBoundary(snapshot, bounds, task)).map(taskId),
  };
  // Build the incumbent solely from original intervals. Mixing new candidate
  // placements with restored originals can create artificial overlaps and
  // incorrectly reject a valid, more urgent baseline admission.
  const baselinePatches: SchedulePatch[] = result.patches.map(patch => {
    const original = originals.get(patch.id)!;
    if (baselineWithinWindow(snapshot, bounds, original)) {
      return { id: patch.id, changes: { start_date: original.start_date, end_date: original.end_date, scheduleSegments: original.scheduleSegments ?? [], planning_status: 'scheduled', planning_reason: null } };
    }
    const reason = planningDefect(snapshot, bounds, original) ?? neverOverlongReason(snapshot, bounds, original) ?? unfittableReason(snapshot, bounds, original) ?? pushLimitAware(bounds, original, noFitReason(candidate));
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
  let incumbent = repairCandidate(snapshot, bounds, { ...result, patches: baselinePatches, dispositions: baselineDispositions });
  result = repairCandidate(snapshot, bounds, result);
  // Tool Inventory (rule Hard + inventory loaded only; both calls return their input untouched otherwise): resolve tool
  // overflow on BOTH candidates before the admission comparison, so the comparison is coherent and a pre-existing
  // overlap on the live schedule is judged under the same rule.
  incumbent = resolveToolOverflow(snapshot, bounds, incumbent);
  result = resolveToolOverflow(snapshot, bounds, result);
  const urgency = urgencyOrder(snapshot, bounds, '', eligibleTasks(snapshot, bounds));
  const admitted = (proposal: CandidateResult): string => { const queued = new Set(proposal.dispositions?.filter(d => d.status === 'needs_planning').map(d => d.id)); return urgency.map(task => queued.has(taskId(task)) ? '1' : '0').join(''); };
  // Min Changeover (D11) keeps the incumbent only when the new plan schedules
  // fewer ORDERS; the urgency string would let an earlier-due order outrank
  // count. Other strategies keep the urgency-ordered comparison.
  const queuedCount = (proposal: CandidateResult): number => proposal.dispositions?.filter(d => d.status === 'needs_planning').length ?? 0;
  const admissionDelta = bounds.strategy === 'min-changeover'
    ? queuedCount(incumbent) - queuedCount(result)
    : ordinalCompare(admitted(incumbent), admitted(result));
  const preferIncumbent = (admissionDelta < 0 || (admissionDelta === 0 && compareFinalObjectives(snapshot, bounds, incumbent, result) < 0)) && !incumbent.validationFindings?.some(f => f.severity === 'error');
  result = preferIncumbent
    ? retainCompatiblePlacements(snapshot, bounds, incumbent, result)
    : retainCompatiblePlacements(snapshot, bounds, result, incumbent);
  const finalResult = reconcileToolOutcomes(refreshFinalMetrics(snapshot, bounds, result));
  return withFreshDistributionFindings(finalResult, snapshot);
}

function refreshFinalMetrics(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, result: CandidateResult): CandidateResult {
  const originals = new Map(snapshot.tasks.map(task => [taskId(task), task]));
  const explanations = [...result.explanation];
  const score = [...result.score];
  const final = applyPatchesToSnapshot(snapshot.tasks, result.patches);
  const mutableTasks = eligibleTasks(snapshot, bounds);
  const scopeIds = new Set(mutableTasks.map(taskId));
  const predecessorById = new Map<string, string | null>();
  const orderedFinal = final.filter(task => {
    const start = timestamp(task.start_date);
    const end = timestamp(task.end_date);
    return scopeIds.has(taskId(task))
      && task.planning_status !== 'needs_planning'
      && start && end && end > start;
  }).sort((a, b) => ordinalCompare(String(a.MACHINE), String(b.MACHINE)) || +timestamp(a.start_date)! - +timestamp(b.start_date)! || ordinalCompare(taskId(a), taskId(b)));
  for (let index = 0; index < orderedFinal.length; index++) predecessorById.set(taskId(orderedFinal[index]), index && orderedFinal[index - 1].MACHINE === orderedFinal[index].MACHINE ? taskId(orderedFinal[index - 1]) : null);
  const definition = bounds.setup.definition;
  const opaqueTasks = definition
    ? mutableTasks.filter(task => (
      !taskIsEvaluationProtected(snapshot, bounds, task)
      && !stateForOrder(task, definition)
    ))
    : [];
  const unknownStateIds = new Set(opaqueTasks.map(taskId));
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
    eligibleCount: result.diagnostics.eligibleCount ?? mutableTasks.length,
    evaluatedCount: result.diagnostics.evaluatedCount ?? result.diagnostics.candidateCount,
    // This is a final-state count, not the number of patch records emitted by
    // the primary search. Gap fill can add placements and unchanged incumbents
    // can be represented without a patch.
    placedCount: orderedFinal.length,
    unplacedCount: Math.max(0, mutableTasks.length - orderedFinal.length),
    unknownTailCount: unknownStateIds.size,
    unknownTailPlacedCount: opaqueTasks.filter(task => orderedFinal.some(finalTask => taskId(finalTask) === taskId(task))).length,
    unknownTailUnplacedCount: Math.max(0, unknownStateIds.size
      - opaqueTasks.filter(task => orderedFinal.some(finalTask => taskId(finalTask) === taskId(task))).length),
    unknownEdgeCount: unknownEdges,
    exhaustive: result.diagnostics.exhaustive ?? searchExhaustive(result.diagnostics.method, result.diagnostics.termination),
    quality: result.diagnostics.quality ?? searchQuality(result.diagnostics.method, result.diagnostics.termination),
    respectCalendar: result.diagnostics.respectCalendar ?? (bounds.respectCalendar ?? true),
  };
  return { ...result, patches: changedPatches, score, objective, diagnostics, explanation: explanations, missingEdges: finalMissingEdges };
}

/** Shared state of one gap walk. `patches` / `dispositions` are the caller's LIVE maps (never copied): the walk reads the
 * accepted production from them and the caller records a placement afterwards. */
interface GapEnv {
  snapshot: Readonly<ScheduleSnapshot>;
  bounds: Readonly<DueDateFirstBounds>;
  /** Spread under every per-line trial candidate. */
  candidate: CandidateResult;
  byLine: Map<string, NimbusTask[]>;
  availability: Map<string, PlacementInterval[]>;
  patches: Map<string, SchedulePatch>;
  dispositions: Map<string, PlanningDisposition>;
  expired: () => boolean;
  /** The tool rule is active for this run (every order of it, tool-carrying or not): the walk may fall back to the second,
   *  relaxed pass and reserves a split order's segments (see `placeTaskInLineGaps`). Absent = the historical Off walk. */
  toolRuleActive?: boolean;
}
type GapOutcome =
  | { kind: 'placed'; patch: SchedulePatch; disposition: PlanningDisposition }
  | { kind: 'none' }
  | { kind: 'incomplete' };

/** Try to place ONE queued order into the gaps between the accepted production of its own line (the body of the
 * gap-fill loop, shared with the tool overflow pass). Earliest gap first; each candidate placement is validated
 * against the whole line before it is accepted. With `hooks` (tool rule active) every gap is first intersected with
 * the tool-free windows of the tools the order carries (setup + run, conservative), and a placement whose ENVELOPE
 * (a split order spans the gap between its segments) is not entirely tool-free is skipped. Without `hooks` this is
 * exactly the historical gap-fill walk. 'incomplete' = the soft budget expired mid-walk. */
function placeTaskInLineGaps(env: GapEnv, task: NimbusTask, hooks?: ToolGapHooks): GapOutcome {
  const { snapshot, bounds, candidate, patches, dispositions, expired } = env;
  const id = taskId(task); const line = String(task.MACHINE);
  const peers = env.byLine.get(line)!;
  const lineIds = new Set(peers.map(taskId));
  const definition = bounds.setup.definition;
  const state = (item: NimbusTask): SetupStateKey | null => definition ? orderState(bounds, item, definition) : null;
  // A shallow patched view of THIS line only (the walk reads fields; it never mutates, never needs the deep copies).
  const placedOnLine = peers.map(peer => { const patch = patches.get(taskId(peer)); return patch ? { ...peer, ...patch.changes } as NimbusTask : peer; }).filter(item => {
    const start = timestamp(item.start_date);
    const end = timestamp(item.end_date);
    return dispositions.get(taskId(item))?.status !== 'needs_planning' && start && end && end > start;
  });
  const byStart = (a: NimbusTask, b: NimbusTask): number => +timestamp(a.start_date)! - +timestamp(b.start_date)! || ordinalCompare(taskId(a), taskId(b));
  // Tool walks only: a SPLIT order reserves its SEGMENTS, not its whole envelope, so another order may take the idle stretch
  // between two of its segments (the validator allows it; the historical walk, kept for Off, reserves the envelope).
  const toolWalk = !!hooks || env.toolRuleActive === true;
  const accepted = (toolWalk ? placedOnLine.flatMap(item => {
    const pieces = (item.scheduleSegments ?? []).flatMap(segment => {
      const a = timestamp(segment.startDate); const b = timestamp(segment.endDate);
      return a && b && b > a ? [{ ...item, start_date: a, end_date: b, scheduleSegments: [] } as NimbusTask] : [];
    });
    return pieces.length > 1 ? pieces : [item];
  }) : placedOnLine).sort(byStart);
  if (!env.availability.has(line)) env.availability.set(line, freeIntervalsFor(snapshot, line, bounds.setup.plant, bounds.now, bounds.horizonEnd, bounds.runContext));
  const free = env.availability.get(line)!;
  // `relaxExclude` (tool walks only, a PROTECTED successor): an unrecorded transition under excludeFromSearch is a warning for a
  // protected order in the validator, so the tool walk charges it like any unresolved transition instead of refusing the gap.
  const transition = (predecessor: NimbusTask | null, successor: NimbusTask, relaxExclude = false): number | null => {
    const from = predecessor ? state(predecessor) : definition ? initialStateForLine(bounds, line, definition.signature_version).state : null;
    const to = state(successor);
    if (definition && inactiveOverrideForTransition(bounds, line, from, to, predecessor ? taskId(predecessor) : null, taskId(successor), lineIds, true)) return null;
    const chargeable = setupChargeableOnLine(bounds, snapshot, line);
    // N8 fix-up: no definition / setup-incompatible line never charges,
    // regardless of policy. An unrecorded predecessor/successor state is
    // otherwise the same "unresolved transition" shape as an uncovered row
    // below, so it goes through the same chargedSetupMinutes gate rather
    // than a hardcoded zero.
    if (!chargeable) return 0;
    if (!from || !to) return chargedSetupMinutes(bounds.runContext, null, true);
    const resolution = resolveSetup({ definition: definition!, machine: line, predecessorState: from, successorState: to,
      predecessorOrderId: predecessor ? taskId(predecessor) : null, successorOrderId: taskId(successor),
      plantRows: bounds.setup.plant_rows, machineRows: bounds.setup.machine_rows, overrides: bounds.setup.overrides, valueDefaults: bounds.setup.value_defaults ?? NO_VALUE_DEFAULTS,
      index: bounds.runContext?.resolutionIndex ?? undefined });
    if (!resolution.covered && bounds.runContext?.unknownSetupPolicy === 'excludeFromSearch' && !relaxExclude) return null;
    return chargedSetupMinutes(bounds.runContext, resolution, true);
  };
  // Tool walks make a SECOND pass that relaxes the setup after a PROTECTED successor (the validator only warns about it for a
  // protected order): the strict pass runs first, so a placement that was legal before is never replaced by a relaxed one.
  // Decided on the WHOLE order (a window-end crosser's first segment alone does not cross the window end).
  const protectedOnLine = toolWalk ? new Set(placedOnLine.filter(item => taskIsEvaluationProtected(snapshot, bounds, item)).map(taskId)) : null;
  const anyProtectedNext = !!protectedOnLine && protectedOnLine.size > 0;
  let relaxBaseline: Set<string> | null = null;
  for (const relax of anyProtectedNext ? [false, true] : [false]) {
  let cursor = +bounds.now;
  let predecessor: NimbusTask | null = null;
  for (let index = 0; index <= accepted.length; index++) {
    if (expired()) return { kind: 'incomplete' };
    const next = accepted[index];
    const gapEnd = Math.min(+bounds.horizonEnd, next ? +timestamp(next.start_date)! : Infinity);
    const floor = Math.max(cursor, +(notBeforeFor(bounds, task) ?? bounds.now));
    const incoming = gapEnd > floor ? transition(predecessor, task) : null;
    const relaxNext = relax && !!next && !!protectedOnLine?.has(taskId(next));
    // The relaxed pass only differs from the strict one where the successor is protected: skip every other gap.
    const outgoing = relax && !relaxNext ? null : next && incoming !== null ? transition(task, next, relaxNext) : 0;
    if (incoming !== null && outgoing !== null) {
      const nextStart = next ? +timestamp(next.start_date)! : gapEnd;
      const setupStart = nextStart - outgoing * 60000;
      const ceiling = Math.min(gapEnd, setupStart, +(notAfterFor(bounds, task) ?? bounds.horizonEnd));
      const outgoingFits = !next || outgoing === 0 || relaxNext || (
        setupStart >= +(notBeforeFor(bounds, next) ?? bounds.now)
        && coversInterval(nextStart > +bounds.horizonEnd
          ? freeIntervalsFor(snapshot, line, bounds.setup.plant, new Date(setupStart), new Date(nextStart), bounds.runContext) : free,
        { start: new Date(setupStart), end: new Date(nextStart) }));
      // Frozen finish floor: a gap whose ceiling is before it admits nothing (equality is valid).
      const gapFinishFloor = bounds.finishFloor ?? null;
      if (ceiling > floor && outgoingFits && !(gapFinishFloor && ceiling < +gapFinishFloor)) {
        const runtimeMinutes = Math.round(Number(task.RUN_TIME) * 60);
        const policy = bounds.runContext!.splitOrderPolicy;
        // Tool rule: only the tool-free part of the calendar is usable (setup + run). Each MAXIMAL tool-free window of the
        // gap is tried on its own: a split-policy order placed across a tool-blocked stretch fails the envelope check, and
        // that must not abandon the later tool-free windows of the same gap. Without hooks: one pass over the whole `free`.
        const toolWindows = hooks ? hooks.windows(floor, ceiling) : null;
        for (const toolWindow of toolWindows ?? [null]) {
          const usable = toolWindow ? intersectIntervals(free, [toolWindow]) : free;
          // Each attempt rebuilds the clipped intervals and isInherentlyOverlong from its own start.
          const placement = placeWithFinishFloor((earliest: Date) => placeWithSetup({ earliestStart: earliest, runtimeMinutes,
            setup: { kind: 'resolved', minutes: incoming }, policy,
            isInherentlyOverlong: policy === 'overlong_only' && !hasNominalWindow(snapshot, line, bounds.setup.plant, earliest, runtimeMinutes, bounds.runContext),
            minProductiveSegmentMinutes: bounds.runContext!.minProductiveSegmentMinutes,
            freeIntervals: usable.flatMap(slot => {
              const start = Math.max(+slot.start, +earliest); const end = Math.min(+slot.end, ceiling);
              return end > start ? [{ start: new Date(start), end: new Date(end) }] : [];
            }),
          }), new Date(floor), gapFinishFloor, incoming, runtimeMinutes, policy);
          if (placement.kind === 'placed' && (!hooks || hooks.envelopeFits(placement.productiveSegments[0].start, placement.productiveSegments.at(-1)!.end))) {
            const segments = placement.productiveSegments;
            const patch: SchedulePatch = { id, changes: { start_date: segments[0].start, end_date: segments.at(-1)!.end,
              scheduleSegments: segments.length > 1 ? segments.map((segment, i) => ({ sequence: i + 1, startDate: segment.start, endDate: segment.end })) : [],
              planning_status: 'scheduled', planning_reason: null } };
            const disposition: PlanningDisposition = { id, line, status: 'scheduled' };
            const trial = { ...candidate,
              patches: peers.flatMap(peer => taskId(peer) === id ? [patch] : patches.has(taskId(peer)) ? [patches.get(taskId(peer))!] : []),
              dispositions: peers.flatMap(peer => {
                const value = taskId(peer) === id ? disposition : dispositions.get(taskId(peer));
                return value ? [value] : [];
              }),
            };
            // The per-line trial is single-line: the plant-wide tool check is made through `hooks`, never here.
            const trialFindings = validateCandidate({ ...snapshot, tasks: peers }, { ...bounds, lines: [line], skipToolOverflowFinding: true }, trial);
            if (!trialFindings.some(f => f.severity === 'error')) {
              // A relaxed placement ahead of a protected successor must not CREATE a setup warning on it (the validator only
              // warns for protected orders, so Apply would accept it): compare with the same line without this placement.
              if (relaxNext && outgoing! > 0) {
                const setupKeys = (list: readonly ValidationFinding[]): Set<string> => new Set(list.filter(f => f.taskId && String(f.code).startsWith('setup_') && protectedOnLine!.has(String(f.taskId))).map(f => `${f.code}|${f.taskId}`));
                // Edges already violated without this placement are not new (a warning key present in the baseline is allowed).
                if (!relaxBaseline) relaxBaseline = setupKeys(validateCandidate({ ...snapshot, tasks: peers }, { ...bounds, lines: [line], skipToolOverflowFinding: true },
                  { ...candidate, patches: peers.flatMap(peer => patches.has(taskId(peer)) ? [patches.get(taskId(peer))!] : []),
                    dispositions: peers.flatMap(peer => { const value = dispositions.get(taskId(peer)); return value ? [value] : []; }) }));
                if ([...setupKeys(trialFindings)].some(key => !relaxBaseline!.has(key))) continue;
              }
              return { kind: 'placed', patch, disposition };
            }
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
  }
  return { kind: 'none' };
}

/** One final insertion pass, shared across all selected lines. Accepted production
 * stays fixed. A new predecessor can make an earlier failure fit, so recheck that
 * line until stable or the separate, soft wall-clock budget expires. */
export function fillPlanningGaps(
  snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>,
  candidate: CandidateResult, budgetMs = bounds.gapFillBudgetMs ?? 1000,
): CandidateResult {
  const started = bounds.clock();
  const expired = (): boolean => bounds.clock() - started >= budgetMs;
  bounds = withRunContext(snapshot, hardBounds(snapshot, { ...bounds, runContext: undefined }));
  // Tool Inventory: rule Hard + inventory loaded + not Remove Backlog; otherwise everything below is the historical walk.
  const toolCtx = toolRuleContext(snapshot, bounds);
  const toolStat = toolCtx ? toolStaticFor(snapshot, bounds, toolCtx) : null;
  if (toolStat) bounds = { ...bounds, toolIndex: toolStat };
  const tasks = eligibleTasks(snapshot, bounds);
  const occupancyTasks = evaluationTasks(snapshot, bounds);
  const patches = new Map(candidate.patches.map(p => [p.id, p]));
  const dispositions = new Map(candidate.dispositions?.map(d => [d.id, d]));
  const pending = urgencyOrder(snapshot, bounds, '', tasks).filter(task =>
    dispositions.get(taskId(task))?.status === 'needs_planning' && !planningDefect(snapshot, bounds, task)
    // Tool Inventory: a tool_unavailable order is final (no copy exists). A tool_contention order IS walked again (with the
    // tool windows): retain / this walk may have labelled it for tooling before a later placement vacated its slot, and the
    // walk is the same one the pass's recovery makes; if it still fits nowhere it keeps its structured reason (below).
    && !(toolCtx && dispositions.get(taskId(task))?.reason?.code === 'tool_unavailable'));
  if (!pending.length) {
    // A completed gap check still needs the same final-state accounting pass
    // as a run that inserted work. The primary candidate may have emitted
    // fewer patches than the number of already-scheduled tasks in scope.
    const refreshed = refreshFinalMetrics(snapshot, bounds, {
      ...candidate,
      gapFill: { complete: true, placed: 0, unchecked: 0, runtimeMs: bounds.clock() - started },
    });
    // No pending orders to try doesn't guarantee nothing moved relative to
    // what finalizeCandidate last saw — recompute rather than assume the
    // incoming findings are still accurate.
    const fresh = withFreshDistributionFindings(refreshed, snapshot);
    return toolCtx && candidate.toolPass === undefined
      ? withFreshDistributionFindings(refreshFinalMetrics(snapshot, bounds, resolveToolOverflow(snapshot, bounds, fresh)), snapshot)
      : fresh;
  }
  const revision = new Map<string, number>();
  const checked = new Map<string, number>();
  const availability = new Map<string, PlacementInterval[]>();
  const byLine = new Map<string, NimbusTask[]>();
  for (const task of occupancyTasks) {
    const line = String(task.MACHINE);
    const peers = byLine.get(line) ?? []; peers.push(task); byLine.set(line, peers);
  }
  const env: GapEnv = { snapshot, bounds, candidate, byLine, availability, patches, dispositions, expired, toolRuleActive: !!toolCtx };
  let placed = 0;
  const toolProbed = new Map<string, { tool: string; available: number; holders: string[]; inUse: number }>();
  // Do not try to repair an internally invalid proposal by inserting more work.
  const valid = !validateCandidate(snapshot, bounds, candidate).some(f => f.severity === 'error');
  // Tool Inventory: occupancy from the FULL plant task list; every insertion must be tool-free (see placeTaskInLineGaps).
  const toolOcc = toolCtx && toolStat ? buildToolOcc(toolCtx, toolStat, bounds, patchedTaskView(snapshot.tasks, patches), { mutableIds: new Set(tasks.map(taskId)), snapshot }) : null;
  while (valid && !expired()) {
    const task = pending.find(item => dispositions.get(taskId(item))?.status === 'needs_planning'
      && checked.get(taskId(item)) !== (revision.get(String(item.MACHINE)) ?? 0));
    if (!task) break;
    const id = taskId(task); const line = String(task.MACHINE);
    const toolInfo = toolOcc ? toolStat!.byId.get(id) : undefined;
    const outcome = placeTaskInLineGaps(env, task, toolOcc && toolInfo ? toolGapHooks(toolOcc, toolInfo.tools, line) : undefined);
    if (outcome.kind === 'placed') {
      patches.set(id, outcome.patch); dispositions.set(id, outcome.disposition); placed++;
      revision.set(line, (revision.get(line) ?? 0) + 1);
      if (toolOcc && toolInfo) {
        const item = toolItemFor(toolOcc.ctx, toolStat!, toolOcc.runNowMs, { ...task, ...outcome.patch.changes } as NimbusTask);
        if (item) toolOccAdd(toolOcc, item);
      }
    }
    if (outcome.kind === 'incomplete') break;
    if (toolOcc && toolInfo && outcome.kind === 'none') {
      // Decision 7: the hooked walk found nothing. If the same walk WITHOUT the tool windows places the order in THIS state, the
      // tools alone kept it out (a later placement may take that slot, so the verdict is taken now). Pure probe, no state change.
      const probe = placeTaskInLineGaps({ ...env, expired: () => false }, task);
      if (probe.kind === 'placed') {
        const detail = toolContentionDetail(toolOcc, toolInfo.tools, line, timestamp(probe.patch.changes.start_date), timestamp(probe.patch.changes.end_date));
        toolProbed.set(id, { tool: detail.tool, available: detail.available, holders: detail.holders, inUse: detail.inUse });
      }
      // Sticky: a later re-check after ANOTHER order took the slot is a consequence of the same tool wait, so a negative probe
      // does not clear the verdict (the order is placed instead if a later check succeeds).
    }
    checked.set(id, revision.get(line) ?? 0);
  }
  let unchecked = 0;
  const toolQueued: ToolBlockedEntry[] = [];
  for (const task of pending) {
    const id = taskId(task); const line = String(task.MACHINE);
    if (dispositions.get(id)?.status !== 'needs_planning') continue;
    const complete = checked.get(id) === (revision.get(line) ?? 0);
    if (!complete) unchecked++;
    const toolHeld = toolCtx && dispositions.get(id)?.reason?.code === 'tool_contention';
    if (toolHeld) continue;                                   // still no tool-free slot: the structured tool reason stays
    const probed = complete ? toolProbed.get(id) : undefined;
    if (probed) {
      const toolReason = toolQueueReason('tool_contention', probed.tool, probed.available, probed.holders, false);
      patches.set(id, toolQueuePatch(id, toolReason));
      dispositions.set(id, { id, line, status: 'needs_planning', reason: toolReason });
      toolQueued.push({ orderId: id, tool: probed.tool, available: probed.available, inUse: probed.inUse, holderIds: probed.holders });
      continue;
    }
    // A completed capacity check that still finds nothing is NOT the real story for an order
    // the primary search refused because its setup transition is unrecorded (N8
    // excludeFromSearch) — keep that actionable reason instead of the generic "No slot found".
    const prior = dispositions.get(id)?.reason;
    // VI10: overlong is a calendar fact, not a search result; a budget expiry must not relabel it.
    const overlong = prior?.code !== 'setup_transition_unrecorded'
      ? neverOverlongReason(snapshot, bounds, task) ?? unfittableReason(snapshot, bounds, task)
      : null;
    const reason = complete && prior?.code === 'setup_transition_unrecorded'
      ? prior
      : overlong ?? (complete
      ? pushLimitAware(bounds, task, { code: 'no_fit_found', message: 'No slot found within the allowed window without moving scheduled orders.' })
      : { code: 'search_limit', message: bounds.exhaustive === true
        ? 'Capacity check incomplete: time limit reached before all available gaps were checked.'
        : 'Capacity check incomplete: time limit reached before all available gaps were checked. Tick Run in background in the Optimize dialog to check every gap.' });
    patches.set(id, { id, changes: { start_date: null, end_date: null, scheduleSegments: [], planning_status: 'needs_planning', planning_reason: reason } });
    dispositions.set(id, { id, line, status: 'needs_planning', reason });
  }
  const result: CandidateResult = { ...candidate, patches: [...patches.values()], dispositions: [...dispositions.values()],
    ...(toolQueued.length ? { toolBlocked: mergeToolBlocked(candidate.toolBlocked, toolQueued) } : {}),
    unchangedLines: candidate.unchangedLines.filter(line => !revision.has(line)),
    gapFill: { complete: valid && unchecked === 0, placed, unchecked, runtimeMs: bounds.clock() - started } };
  result.validationFindings = validateCandidate(snapshot, bounds, result);
  const final = withFreshDistributionFindings(refreshFinalMetrics(snapshot, bounds, result), snapshot);
  let out: CandidateResult = { ...final, gapFill: { ...result.gapFill!, runtimeMs: bounds.clock() - started } };
  if (toolCtx && (placed > 0 || candidate.toolPass === undefined)) {
    // Gap-fill can never re-create overflow (its gaps are tool-free), but the pass is re-run once on the final candidate:
    // it is the safety net, and it also repairs a candidate the pass never ran on.
    const passed = resolveToolOverflow(snapshot, bounds, out);
    out = withFreshDistributionFindings(refreshFinalMetrics(snapshot, bounds, passed), snapshot);
    out = { ...out, gapFill: { ...result.gapFill!, runtimeMs: bounds.clock() - started } };
  }
  return reconcileToolOutcomes(out);
}

function baselineWithinWindow(snapshot: Readonly<ScheduleSnapshot>, bounds: Readonly<DueDateFirstBounds>, task: NimbusTask): boolean {
  if (task.planning_status === 'needs_planning' || planningDefect(snapshot, bounds, task)) return false;
  const start = timestamp(task.start_date); const end = timestamp(task.end_date);
  const floor = notBeforeFor(bounds, task); const ceiling = notAfterFor(bounds, task);
  return !!(start && end && end > start && start >= bounds.now && (!floor || start >= floor) && (!ceiling || end <= ceiling) && (!bounds.finishFloor || end >= bounds.finishFloor));
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
    maxLatenessMinutes: candidate.maxLatenessMinutes ?? 0,
    uncoveredEdges: candidate.score[SCORE_UNCOVERED] ?? 0,
    setupMinutes: candidate.score[5] ?? 0,
    scheduledCount: Math.max(0, -(candidate.score[4] ?? 0)),
    instabilityMinutes: candidate.instabilityMinutes ?? 0,
    productiveRuntimeKey: candidate.productiveRuntimeKey ?? '',
    productiveRuntimeMinutes: candidate.productiveRuntimeMinutes ?? 0,
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
    const result = compareNumber(Number(leftValue ?? 0), Number(rightValue ?? 0));
    return descending ? -result : result;
  };
  const terms: Array<[keyof ObjectiveFacts, boolean]> = mode === 'min-changeover'
    ? [
      // D1/D10: Min Changeover minimizes setup inside the date limits. Admission
      // (by count) is settled before these terms; lateness is a tie-breaker only.
      ['hardErrors', false], ['overCap', false], ['uncoveredEdges', false], ['setupMinutes', false], ['policyKey', false],
      ['lateCount', false], ['latenessMinutes', false], ['maxLatenessMinutes', false],
      ['scheduledCount', true], ['instabilityMinutes', false], ['sequenceKey', false],
    ]
    : mode === 'due-date'
      ? [
        ['hardErrors', false], ['overCap', false], ['lateCount', false], ['latenessMinutes', false], ['maxLatenessMinutes', false],
        ['policyKey', false], ['uncoveredEdges', false], ['setupMinutes', false],
        ['scheduledCount', true], ['instabilityMinutes', false], ['sequenceKey', false],
      ]
      : mode === 'spt'
        ? [
          ['hardErrors', false], ['uncoveredEdges', false], ['productiveRuntimeKey', false], ['overCap', false], ['lateCount', false],
          ['latenessMinutes', false], ['maxLatenessMinutes', false], ['setupMinutes', false], ['scheduledCount', true],
          ['instabilityMinutes', false], ['sequenceKey', false],
        ]
        : mode === 'throughput'
          ? [
            ['hardErrors', false], ['overCap', false], ['uncoveredEdges', false], ['setupMinutes', false],
            ['lateCount', false], ['latenessMinutes', false], ['maxLatenessMinutes', false], ['policyKey', false],
            ['scheduledCount', true], ['instabilityMinutes', false], ['sequenceKey', false],
          ]
          : [
            ['hardErrors', false], ['policyKey', false], ['overCap', false], ['uncoveredEdges', false],
            ['lateCount', false], ['latenessMinutes', false], ['maxLatenessMinutes', false], ['scheduledCount', true],
            ['setupMinutes', false], ['instabilityMinutes', false], ['sequenceKey', false],
          ];
  for (const [key, descending] of terms) {
    const leftValue = key === 'productiveRuntimeKey'
      ? (left.productiveRuntimeKey ?? String(left.productiveRuntimeMinutes ?? 0).padStart(16, '0'))
      : left[key];
    const rightValue = key === 'productiveRuntimeKey'
      ? (right.productiveRuntimeKey ?? String(right.productiveRuntimeMinutes ?? 0).padStart(16, '0'))
      : right[key];
    const delta = compare(leftValue, rightValue, descending);
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
  // Final arbitration may receive the original request bounds, before an
  // evaluator has attached planningStart/runNow/placementStart and its run
  // context. Normalize at this read-only boundary so scope and setup facts
  // are identical during and after evaluation.
  bounds = withRunContext(snapshot, hardBounds(snapshot, bounds));
  const ids = new Set(eligibleTasks(snapshot, bounds).map(taskId));
  const tasks = applyPatchesToSnapshot(snapshot.tasks, candidate.patches).filter(task => ids.has(taskId(task)));
  let lateCount = 0; let lateness = 0; let maxLateness = 0; let setupMinutes = 0; let instability = 0;
  let overCap = 0;
  const dueScope = dueScopeFor(snapshot, bounds);
  const original = new Map(snapshot.tasks.map(task => [taskId(task), task]));
  for (const task of tasks) {
    const end = timestamp(task.end_date); const due = dueTimestamp(task, dueScope);
    if (task.planning_status === 'needs_planning') {
      lateCount++;
      if (Number.isFinite(due)) {
        const orderLateness = Math.max(0, (+bounds.horizonEnd - due) / 60000);
        lateness += orderLateness;
        maxLateness = Math.max(maxLateness, orderLateness);
      }
    } else if (end && Number.isFinite(due) && +end > due) {
      lateCount++;
      const orderLateness = (+end - due) / 60000;
      lateness += orderLateness;
      maxLateness = Math.max(maxLateness, orderLateness);
    }
    const ceiling = notAfterFor(bounds, task);
    if (end && ceiling && +end > +ceiling) overCap++;
    const before = timestamp(original.get(taskId(task))?.end_date); const after = timestamp(task.end_date);
    if (before && after) instability += Math.abs(+after - +before) / 60000;
  }
  const definition = bounds.setup.definition;
  if (definition) for (const line of new Set(tasks.map(task => String(task.MACHINE)))) {
    // N8 fix-up: setup-incompatible lines never charge, regardless of
    // policy; an unrecorded predecessor/successor state on an otherwise
    // chargeable line still resolves through chargedSetupMinutes below via a
    // null resolution, rather than being silently skipped.
    const chargeable = !setupCompatibilityForLine(snapshot, bounds.setup.plant, line);
    let state = initialStateForLine(bounds, line, definition.signature_version).state;
    let previous: string | null = null;
    const ordered = tasks.filter(task => {
      const start = timestamp(task.start_date);
      const end = timestamp(task.end_date);
      return String(task.MACHINE) === line && task.planning_status !== 'needs_planning' && start && end && end > start;
    }).sort((a,b) => +timestamp(a.start_date)! - +timestamp(b.start_date)! || ordinalCompare(taskId(a), taskId(b)));
    for (const task of ordered) {
      const successor = stateForOrder(task, definition);
      if (chargeable) {
        const resolved = state && successor
          ? resolveSetup({ definition, machine: line, predecessorState: state, successorState: successor, predecessorOrderId: previous, successorOrderId: taskId(task), plantRows: bounds.setup.plant_rows, machineRows: bounds.setup.machine_rows, overrides: bounds.setup.overrides, valueDefaults: bounds.setup.value_defaults ?? NO_VALUE_DEFAULTS, index: bounds.runContext?.resolutionIndex ?? undefined })
          : null;
        setupMinutes += chargedSetupMinutes(bounds.runContext, resolved, true);
      }
      state = successor; previous = taskId(task);
    }
  }
  const scheduled = tasks.filter(task => {
    const start = timestamp(task.start_date);
    const end = timestamp(task.end_date);
    return task.planning_status !== 'needs_planning' && start && end && end > start;
  });
  const lines = [...new Set(scheduled.map(task => String(task.MACHINE)))].sort(ordinalCompare);
  const orderedByLine = lines.map(line => scheduled
    .filter(task => String(task.MACHINE) === line)
    .sort((left, right) => +timestamp(left.start_date)! - +timestamp(right.start_date)! || ordinalCompare(taskId(left), taskId(right))));
  // Coverage is a fact of the final patched adjacency, never of a rejected
  // permutation's diagnostics. Rejected alternatives can contain many more
  // edges than the schedule that will actually be applied, so derive the
  // count from each final line sequence and carry unknown signatures as an
  // opaque break in the chain.
  let uncoveredEdges = 0;
  if (definition) for (const lineTasks of orderedByLine) {
    const line = String(lineTasks[0]?.MACHINE ?? '');
    let predecessorState = initialStateForLine(bounds, line, definition.signature_version).state;
    let predecessorOrderId: string | null = null;
    for (const task of lineTasks) {
      const successorState = stateForOrder(task, definition);
      if (predecessorState && successorState && !setupCompatibilityForLine(snapshot, bounds.setup.plant, line)) {
        const resolved = resolveSetup({
          definition,
          machine: line,
          predecessorState,
          successorState,
          predecessorOrderId,
          successorOrderId: taskId(task),
          plantRows: bounds.setup.plant_rows,
          machineRows: bounds.setup.machine_rows,
          overrides: bounds.setup.overrides, valueDefaults: bounds.setup.value_defaults ?? NO_VALUE_DEFAULTS,
          index: bounds.runContext?.resolutionIndex ?? undefined,
        });
        if (!resolved.covered || resolved.effectiveMin === null) uncoveredEdges += 1;
      }
      predecessorState = successorState;
      predecessorOrderId = taskId(task);
    }
  }
  const policyKey = orderedByLine.map((lineTasks, index) => (
    `${lines[index]}:${policyKeyForSequence(snapshot, bounds.setup.plant, lines[index], lineTasks, bounds.runContext)}`
  )).join('|');
  const sequenceKey = orderedByLine.map((lineTasks, index) => (
    `${lines[index]}:${lineTasks.map(taskId).join(',')}`
  )).join('|');
  const runtimeOrdered = orderedByLine.flatMap(lineTasks => lineTasks);
  return {
    hardErrors: (candidate.validationFindings ?? []).filter(finding => finding.severity === 'error').length,
    overCap,
    lateCount,
    latenessMinutes: lateness,
    maxLatenessMinutes: maxLateness,
    uncoveredEdges,
    setupMinutes,
    scheduledCount: scheduled.length,
    instabilityMinutes: instability,
    productiveRuntimeKey: productiveRuntimeKey(runtimeOrdered),
    productiveRuntimeMinutes: productiveRuntimeTotal(runtimeOrdered),
    policyKey,
    sequenceKey,
  };
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

export const fragmentObjectiveFactsForTest = fragmentObjectiveFacts;
export const checkDistributionSeparationForTest = checkDistributionSeparation;
export const freeIntervalsForTest = freeIntervalsFor;
export const freeIntervalsForPlacementTest = freeIntervalsForPlacement;
export const hasNominalWindowForTest = hasNominalWindow;
export const plantHoursOnForTest = plantHoursOn;
