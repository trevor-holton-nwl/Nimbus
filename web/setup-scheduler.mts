/*
 * Detached candidate scheduling contract.
 *
 * This module receives the complete scheduling read model as a snapshot and
 * returns only patches. It never mutates Store, DOM, persistence, alerts, or
 * Timeline; the workbench owns the one explicit Store commit after Apply.
 */

import type { RemoveBacklogResult } from './schedule-services.mjs';
import { Engine } from './schedule-services.mjs';
import type {
  NimbusBlock,
  NimbusLineSetting,
  NimbusMasterData,
  NimbusPlantBlock,
  NimbusTask,
  OptimizerMode,
  PriorityRankMaps,
  SplitOrderPolicy,
  WorkHours,
} from './types.mjs';

export interface SchedulePatch {
  id: string;
  changes: Partial<NimbusTask>;
}

/** Phase-1 split policy: productive pieces are never shorter than this fixed
 * system boundary, except one complete unsplit order below the boundary. */
export const MIN_PRODUCTIVE_SEGMENT_MINUTES = 30;

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
  reason: 'initial-state-unknown' | 'transition-unresolved' | 'no-feasible-capacity';
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
function productiveAllocations(capacities: ReadonlyArray<number>, totalMinutes: number): number[] | null {
  const firstCapacity = capacities[0] ?? 0;
  if (firstCapacity < MIN_PRODUCTIVE_SEGMENT_MINUTES) return null;
  const states: IntegerRange[][] = [[{
    lo: MIN_PRODUCTIVE_SEGMENT_MINUTES,
    hi: Math.min(firstCapacity, totalMinutes),
  }]];
  if (rangeContains(states[0], totalMinutes)) return [totalMinutes];

  for (let index = 1; index < capacities.length; index += 1) {
    const capacity = capacities[index];
    const prior = states[index - 1];
    const next = prior.map(range => ({ ...range })); // skip this fragment
    if (capacity >= MIN_PRODUCTIVE_SEGMENT_MINUTES) {
      for (const range of prior) {
        next.push({
          lo: range.lo + MIN_PRODUCTIVE_SEGMENT_MINUTES,
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
      const lo = Math.max(MIN_PRODUCTIVE_SEGMENT_MINUTES, remaining - range.hi);
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
  if (remaining < MIN_PRODUCTIVE_SEGMENT_MINUTES || remaining > firstCapacity) return null;
  allocations[0] = remaining;
  return allocations;
}

function capacityFailure(): PlacementInfeasibility {
  return { kind: 'infeasible', reason: 'no-feasible-capacity', productiveSegments: [] };
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
  if (!Number.isFinite(runtimeMinutes) || runtimeMinutes <= 0) return capacityFailure();
  const intervals = normalizedIntervals(request.freeIntervals, request.earliestStart);
  if (!intervals.length) return capacityFailure();

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

  // The under-30 exemption is explicitly complete-and-unsplit. It does not
  // permit a setup-only tail followed by a tiny continuation.
  if (runtimeMinutes < MIN_PRODUCTIVE_SEGMENT_MINUTES) {
    for (const interval of intervals) {
      if (interval.minutes >= setup.minutes + runtimeMinutes) return place(interval.start, runtimeMinutes, []);
    }
    return capacityFailure();
  }

  for (let first = 0; first < intervals.length; first += 1) {
    const firstInterval = intervals[first];
    const firstProductiveStart = new Date(firstInterval.start.getTime() + setup.minutes * 60 * 1000);
    const firstCapacity = Math.floor((firstInterval.end.getTime() - firstProductiveStart.getTime()) / (60 * 1000));
    if (firstCapacity < MIN_PRODUCTIVE_SEGMENT_MINUTES) continue;

    const slots: MinuteInterval[] = [{ start: firstProductiveStart, end: firstInterval.end, minutes: firstCapacity }];
    for (let index = first + 1; index < intervals.length; index += 1) slots.push(intervals[index]);
    const allocations = productiveAllocations(slots.map(slot => slot.minutes), runtimeMinutes);
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
  fixedIds: ReadonlySet<string> | ReadonlyArray<string>;
  alerts: ReadonlyArray<unknown>;
  selectedPlant: string | null;
  blocks: ReadonlyArray<NimbusBlock>;
  plantBlocks: ReadonlyArray<NimbusPlantBlock>;
  calendars: Readonly<Record<string, { workHours: WorkHours }>>;
  plants: Readonly<Record<string, { workHours: WorkHours }>>;
  lineSettings: Readonly<Record<string, NimbusLineSetting>>;
  masterData: NimbusMasterData | null;
  priorityRankMaps: PriorityRankMaps;
}

export interface EvaluationRequest {
  mode?: OptimizerMode;
  plant?: string | null;
  lines?: ReadonlyArray<string> | null;
  startDate?: Date | string | number | null;
  endDate?: Date | string | number | null;
  respectFixed?: boolean;
  respectCalendar?: boolean;
  /** Tests and callers that need deterministic candidate placement supply this. */
  now?: Date;
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
  method: 'legacy-detached';
  termination: 'completed' | 'no-plant';
  runtimeMs: number;
  limitReached: boolean;
  events: ReadonlyArray<CandidateDiagnostic>;
}

export interface MissingSetupEdge {
  line: string;
  predecessorOrderId?: string | null;
  successorOrderId?: string | null;
  reason: string;
}

export interface CandidateResult {
  patches: ReadonlyArray<SchedulePatch>;
  score: readonly number[];
  explanation: ReadonlyArray<CandidateReason>;
  diagnostics: SearchDiagnostics;
  unchangedLines: readonly string[];
  missingEdges: readonly MissingSetupEdge[];
  /** Compatibility detail consumed only by the existing backlog-preview UI. */
  backlogResult?: RemoveBacklogResult;
}

/**
 * Evaluate against the existing placement algorithm, but with its reads bound
 * to `snapshot`.  The Engine adapter shares the legacy mode implementation;
 * it emits patches and never applies them while evaluating a candidate.
 */
export function evaluateSchedule(snapshot: Readonly<ScheduleSnapshot>, request: EvaluationRequest = {}): CandidateResult {
  const { mode = 'combined', ...opts } = request;
  return Engine.evaluateSchedule(mode, opts, snapshot);
}

/** Apply a detached patch set to detached task values for before/after
 * comparison.  The original snapshot and task objects are never changed. */
export function applyPatchesToSnapshot(tasks: ReadonlyArray<NimbusTask>, patches: ReadonlyArray<SchedulePatch>): NimbusTask[] {
  const byId = new Map(patches.map(patch => [String(patch.id), patch.changes]));
  return tasks.map(task => {
    const changes = byId.get(String(task.id));
    return changes ? { ...structuredClone(task), ...structuredClone(changes) } : structuredClone(task);
  });
}
