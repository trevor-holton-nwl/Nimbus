/*
 * Detached candidate scheduling contract.
 *
 * This module receives the complete scheduling read model as a snapshot and
 * returns only patches. It never mutates Store, DOM, persistence, alerts, or
 * Timeline; the workbench owns the one explicit Store commit after Apply.
 */

import type { RemoveBacklogResult } from './schedule-services.mjs';
import { Engine } from './schedule-services.mjs';
import { resolveSetup, stateForOrder } from './setup-domain.mjs';
import type {
  NimbusBlock,
  NimbusLineSetting,
  NimbusMasterData,
  NimbusPlantBlock,
  NimbusTask,
  OptimizerMode,
  PriorityRankMaps,
  SetupSnapshot as SetupTruthSnapshot,
  SetupStateKey,
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

/** All search limits are intentionally supplied by the caller. Stage 0's
 * measurement gate chooses them; this detached evaluator must never invent
 * production thresholds, iteration caps, or time budgets. */
export interface DueDateFirstBounds {
  setup: SetupTruthSnapshot;
  exactSearchThreshold: number;
  iterationCap: number;
  clock: () => number;
  deadline: number;
  now: Date;
  horizonEnd: Date;
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
  termination: 'completed' | 'no-plant' | 'deadline' | 'iteration-cap' | 'infeasible';
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

interface DueDateGroup {
  key: string;
  state: SetupStateKey;
  tasks: NimbusTask[];
}

interface DueDateCandidate {
  feasible: boolean;
  patches: SchedulePatch[];
  score: number[];
  sequenceKey: string;
  explanation: CandidateReason[];
  missingEdges: MissingSetupEdge[];
}

interface SearchRun {
  candidateCount: number;
  method: 'due-date-first-exact' | 'due-date-first-greedy';
  termination: 'completed' | 'deadline' | 'iteration-cap';
  winner: DueDateCandidate | null;
  missingEdges: MissingSetupEdge[];
}

/** A run-scoped counter shared by every line and fixed-boundary fragment. */
interface SearchBudget {
  remainingIterations: number;
}

interface FixedBoundary {
  task: NimbusTask;
  state: SetupStateKey;
  start: Date;
  end: Date;
}

interface FragmentContext {
  start: Date;
  end: Date;
  predecessorState: SetupStateKey;
  predecessorOrderId: string | null;
  nextFixed?: FixedBoundary;
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

function timestamp(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value) : null;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

function dueTimestamp(task: NimbusTask): number {
  return timestamp(task.original_end_date)?.getTime()
    ?? timestamp(task.BASIC_FINISH_DATE)?.getTime()
    ?? Number.MAX_SAFE_INTEGER;
}

function taskId(task: NimbusTask): string {
  return String(task.id);
}

function stateKey(state: SetupStateKey): string {
  return JSON.stringify(state);
}

/** An active occurrence override belongs to one physical adjacency. When a
 * candidate puts its successor behind a different order/state, the override
 * does not travel with that order; the candidate is infeasible and reports
 * the binding as inactive. */
function inactiveOverrideForTransition(
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  predecessorState: SetupStateKey,
  successorState: SetupStateKey,
  predecessorOrderId: string | null,
  successorOrderId: string,
): MissingSetupEdge | null {
  const definition = bounds.setup.definition!;
  const bound = bounds.setup.overrides.filter(override => (
    override.status === 'active'
    && override.line === line
    && override.signature_version === definition.signature_version
    && override.successor_order_id === successorOrderId
  ));
  for (const override of bound) {
    if (override.predecessor_order_id !== predecessorOrderId
      || stateKey(override.predecessor_state_key) !== stateKey(predecessorState)
      || stateKey(override.successor_state_key) !== stateKey(successorState)) {
      return { line, predecessorOrderId, successorOrderId, reason: 'override-inactive' };
    }
  }
  return null;
}

function orderedByDue(tasks: ReadonlyArray<NimbusTask>): NimbusTask[] {
  return [...tasks].sort((left, right) => (
    dueTimestamp(left) - dueTimestamp(right) || taskId(left).localeCompare(taskId(right))
  ));
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

function taskIsFixed(snapshot: Readonly<ScheduleSnapshot>, task: NimbusTask): boolean {
  const fixedIds = snapshot.fixedIds instanceof Set
    ? snapshot.fixedIds
    : new Set(Array.from(snapshot.fixedIds, String));
  return task.fixed === true || fixedIds.has(taskId(task));
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

function overlapBlocks(
  snapshot: Readonly<ScheduleSnapshot>, line: string, plant: string, start: Date, end: Date,
): PlacementInterval[] {
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

/** Derive only the availability present in the supplied immutable snapshot.
 * A missing calendar is unavailable rather than a prompt to synthesize a
 * default calendar into a detached candidate. */
function freeIntervalsFor(
  snapshot: Readonly<ScheduleSnapshot>, line: string, plant: string, from: Date, through: Date,
): PlacementInterval[] {
  const lineHours = snapshot.calendars[line]?.workHours;
  const plantHours = snapshot.plants[plant]?.workHours;
  if (!lineHours || !plantHours || through <= from) return [];

  const result: PlacementInterval[] = [];
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  while (day <= through) {
    const lineWindow = localWindow(lineHours, day);
    const plantWindow = localWindow(plantHours, day);
    if (lineWindow && plantWindow) {
      const start = new Date(Math.max(lineWindow.start.getTime(), plantWindow.start.getTime(), from.getTime()));
      const end = new Date(Math.min(lineWindow.end.getTime(), plantWindow.end.getTime(), through.getTime()));
      if (end > start) {
        let cursor = start;
        for (const block of overlapBlocks(snapshot, line, plant, start, end)) {
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

function compareCandidate(left: DueDateCandidate, right: DueDateCandidate): number {
  for (let index = 0; index < Math.max(left.score.length, right.score.length); index += 1) {
    const delta = (left.score[index] ?? 0) - (right.score[index] ?? 0);
    if (delta) return delta;
  }
  return left.sequenceKey.localeCompare(right.sequenceKey);
}

function candidateForSequence(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  sequence: ReadonlyArray<NimbusTask>,
  fragment: Readonly<FragmentContext>,
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

  for (const task of sequence) {
    const successorState = stateForOrder(task, definition);
    if (!successorState) {
      missingEdges.push({ line, predecessorOrderId, successorOrderId: taskId(task), reason: 'successor-state-unknown' });
      return {
        feasible: false, patches: [], score: [1, 0, 0, 0, 0, 0], sequenceKey: '', explanation, missingEdges,
      };
    }
    const inactiveOverride = inactiveOverrideForTransition(
      bounds, line, predecessorState, successorState, predecessorOrderId, taskId(task),
    );
    if (inactiveOverride) {
      missingEdges.push(inactiveOverride);
      return {
        feasible: false, patches: [], score: [1, 0, 0, 0, 0, 0], sequenceKey: '', explanation, missingEdges,
      };
    }
    const resolved = resolveSetup({
      definition,
      line,
      predecessorState,
      successorState,
      predecessorOrderId,
      successorOrderId: taskId(task),
      plantRows: bounds.setup.plant_rows,
      lineRows: bounds.setup.line_rows,
      overrides: bounds.setup.overrides,
    });
    if (!resolved.covered || resolved.effectiveMin === null) {
      missingEdges.push({
        line,
        predecessorOrderId,
        successorOrderId: taskId(task),
        reason: resolved.reason,
      });
      return {
        feasible: false, patches: [], score: [1, 0, 0, 0, 0, 0], sequenceKey: '', explanation, missingEdges,
      };
    }

    const placement = placeWithSetup({
      earliestStart: cursor,
      runtimeMinutes: Math.round(Number(task.RUN_TIME) * 60),
      setup: { kind: 'resolved', minutes: resolved.effectiveMin },
      policy: 'never',
      freeIntervals: freeIntervalsFor(snapshot, line, bounds.setup.plant, cursor, fragment.end),
    });
    if (placement.kind !== 'placed' || !placement.productiveSegments.length) {
      missingEdges.push({
        line,
        predecessorOrderId,
        successorOrderId: taskId(task),
        reason: placement.kind === 'infeasible' ? placement.reason : 'no-feasible-capacity',
      });
      return {
        feasible: false, patches: [], score: [1, 0, 0, 0, 0, 0], sequenceKey: '', explanation, missingEdges,
      };
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
    setupMinutes += resolved.effectiveMin;
    const due = dueTimestamp(task);
    if (Number.isFinite(due) && last.end.getTime() > due) {
      lateCount += 1;
      latenessMinutes += Math.ceil((last.end.getTime() - due) / (60 * 1000));
    }
    explanation.push({
      code: 'due-date-first-placement',
      message: `Placed ${taskId(task)} after ${resolved.effectiveMin} minutes of setup.`,
      line,
      taskId: taskId(task),
    });
    cursor = new Date(last.end);
    predecessorState = successorState;
    predecessorOrderId = taskId(task);
  }

  if (fragment.nextFixed) {
    const fixed = fragment.nextFixed;
    const inactiveOverride = inactiveOverrideForTransition(
      bounds, line, predecessorState, fixed.state, predecessorOrderId, taskId(fixed.task),
    );
    if (inactiveOverride) {
      missingEdges.push(inactiveOverride);
      return {
        feasible: false, patches: [], score: [1, 0, 0, 0, 0, 0], sequenceKey: '', explanation, missingEdges,
      };
    }
    const resolved = resolveSetup({
      definition,
      line,
      predecessorState,
      successorState: fixed.state,
      predecessorOrderId,
      successorOrderId: taskId(fixed.task),
      plantRows: bounds.setup.plant_rows,
      lineRows: bounds.setup.line_rows,
      overrides: bounds.setup.overrides,
    });
    if (!resolved.covered || resolved.effectiveMin === null) {
      missingEdges.push({
        line,
        predecessorOrderId,
        successorOrderId: taskId(fixed.task),
        reason: resolved.reason,
      });
      return {
        feasible: false, patches: [], score: [1, 0, 0, 0, 0, 0], sequenceKey: '', explanation, missingEdges,
      };
    }
    const setupStart = new Date(fixed.start.getTime() - resolved.effectiveMin * 60 * 1000);
    const fitsIncomingSetup = setupStart >= cursor && freeIntervalsFor(
      snapshot, line, bounds.setup.plant, cursor, fixed.start,
    ).some(interval => interval.start <= setupStart && interval.end >= fixed.start);
    if (!fitsIncomingSetup) {
      missingEdges.push({
        line,
        predecessorOrderId,
        successorOrderId: taskId(fixed.task),
        reason: 'incoming-fixed-setup-infeasible',
      });
      return {
        feasible: false, patches: [], score: [1, 0, 0, 0, 0, 0], sequenceKey: '', explanation, missingEdges,
      };
    }
    setupMinutes += resolved.effectiveMin;
    explanation.push({
      code: 'fixed-incoming-setup',
      message: `Reserved ${resolved.effectiveMin} minutes of setup before fixed ${taskId(fixed.task)}.`,
      line,
      taskId: taskId(fixed.task),
    });
  }

  return {
    feasible: true,
    patches,
    // Lower is better. The due-date objective intentionally remains ahead of
    // admitted work and setup consumption; the sequence key is the final tie.
    score: [0, 0, lateCount, latenessMinutes, -patches.length, setupMinutes],
    sequenceKey: sequence.map(taskId).join('|'),
    explanation,
    missingEdges,
  };
}

function exactSearch(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  groups: ReadonlyArray<DueDateGroup>,
  fragment: Readonly<FragmentContext>,
  budget: SearchBudget,
): SearchRun {
  let candidateCount = 0;
  let termination: SearchRun['termination'] = 'completed';
  let winner: DueDateCandidate | null = null;
  const missingEdges: MissingSetupEdge[] = [];
  const used = new Array(groups.length).fill(false);
  const selected: DueDateGroup[] = [];

  const visit = (): void => {
    if (bounds.clock() >= bounds.deadline) {
      termination = 'deadline';
      return;
    }
    if (budget.remainingIterations <= 0) {
      termination = 'iteration-cap';
      return;
    }
    if (selected.length === groups.length) {
      candidateCount += 1;
      budget.remainingIterations -= 1;
      const sequence = selected.flatMap(group => orderedByDue(group.tasks));
      const candidate = candidateForSequence(snapshot, bounds, line, sequence, fragment);
      if (candidate.feasible && (!winner || compareCandidate(candidate, winner) < 0)) winner = candidate;
      if (!candidate.feasible) missingEdges.push(...candidate.missingEdges);
      return;
    }
    for (let index = 0; index < groups.length; index += 1) {
      if (used[index] || termination !== 'completed') continue;
      used[index] = true;
      selected.push(groups[index]);
      visit();
      selected.pop();
      used[index] = false;
    }
  };
  visit();
  return { candidateCount, method: 'due-date-first-exact', termination, winner, missingEdges };
}

function greedySearch(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  groups: ReadonlyArray<DueDateGroup>,
  fragment: Readonly<FragmentContext>,
  budget: SearchBudget,
): SearchRun {
  if (bounds.clock() >= bounds.deadline) {
    return {
      candidateCount: 0, method: 'due-date-first-greedy', termination: 'deadline', winner: null, missingEdges: [],
    };
  }
  if (budget.remainingIterations <= 0) {
    return {
      candidateCount: 0, method: 'due-date-first-greedy', termination: 'iteration-cap', winner: null, missingEdges: [],
    };
  }
  const orderedGroups = [...groups].sort((left, right) => {
    const leftDue = dueTimestamp(orderedByDue(left.tasks)[0]);
    const rightDue = dueTimestamp(orderedByDue(right.tasks)[0]);
    return leftDue - rightDue || left.key.localeCompare(right.key);
  });
  let candidateCount = 0;
  let termination: SearchRun['termination'] = 'completed';
  let winner: DueDateCandidate | null = null;
  const missingEdges: MissingSetupEdge[] = [];
  const seen = new Set<string>();

  const evaluate = (groupOrder: ReadonlyArray<DueDateGroup>): DueDateCandidate | null => {
    if (bounds.clock() >= bounds.deadline) {
      termination = 'deadline';
      return null;
    }
    if (budget.remainingIterations <= 0) {
      termination = 'iteration-cap';
      return null;
    }
    const key = groupOrder.map(group => group.key).join('\u0000');
    if (seen.has(key)) return null;
    seen.add(key);
    budget.remainingIterations -= 1;
    candidateCount += 1;
    const candidate = candidateForSequence(
      snapshot,
      bounds,
      line,
      groupOrder.flatMap(group => orderedByDue(group.tasks)),
      fragment,
    );
    if (!candidate.feasible) {
      missingEdges.push(...candidate.missingEdges);
      return null;
    }
    if (!winner || compareCandidate(candidate, winner) < 0) winner = candidate;
    return candidate;
  };

  let currentOrder = orderedGroups;
  let current = evaluate(currentOrder);
  let improved = true;
  while (improved && termination === 'completed') {
    improved = false;
    for (let index = 0; index < currentOrder.length - 1; index += 1) {
      const neighbor = [...currentOrder];
      [neighbor[index], neighbor[index + 1]] = [neighbor[index + 1], neighbor[index]];
      const candidate = evaluate(neighbor);
      if (termination !== 'completed') break;
      if (candidate && current && compareCandidate(candidate, current) < 0) {
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
  return {
    candidateCount,
    method: 'due-date-first-greedy',
    termination,
    winner,
    missingEdges,
  };
}

function uniqueMissingEdges(edges: ReadonlyArray<MissingSetupEdge>): MissingSetupEdge[] {
  const seen = new Set<string>();
  return edges.filter(edge => {
    const key = [edge.line, edge.predecessorOrderId ?? '', edge.successorOrderId ?? '', edge.reason].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function searchFragment(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  tasks: ReadonlyArray<NimbusTask>,
  fragment: Readonly<FragmentContext>,
  budget: SearchBudget,
): SearchRun {
  const definition = bounds.setup.definition!;
  const groupsByState = new Map<string, DueDateGroup>();
  const missingEdges: MissingSetupEdge[] = [];
  for (const task of tasks) {
    const state = stateForOrder(task, definition);
    if (!state) {
      missingEdges.push({ line, successorOrderId: taskId(task), reason: 'successor-state-unknown' });
      continue;
    }
    const key = stateKey(state);
    const group = groupsByState.get(key) ?? { key, state, tasks: [] };
    group.tasks.push(task);
    groupsByState.set(key, group);
  }
  if (missingEdges.length) {
    return {
      candidateCount: 0,
      method: 'due-date-first-exact',
      termination: 'completed',
      winner: null,
      missingEdges,
    };
  }
  const groups = [...groupsByState.values()].sort((left, right) => left.key.localeCompare(right.key));
  return groups.length <= bounds.exactSearchThreshold
    ? exactSearch(snapshot, bounds, line, groups, fragment, budget)
    : greedySearch(snapshot, bounds, line, groups, fragment, budget);
}

function unchangedLineResult(
  line: string,
  code: string,
  message: string,
  missingEdges: MissingSetupEdge[] = [],
): LineSearchResult {
  return {
    patches: [],
    score: [0, 0, 0, 0, 0, 0],
    explanation: [{ code, message, line }],
    missingEdges,
    candidateCount: 0,
    method: 'due-date-first-exact',
    termination: 'completed',
    unchanged: true,
  };
}

function evaluateLineWithFixedBoundaries(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  tasks: ReadonlyArray<NimbusTask>,
  initialState: SetupStateKey,
  budget: SearchBudget,
): LineSearchResult {
  const definition = bounds.setup.definition!;
  const fixed: FixedBoundary[] = [];
  for (const task of tasks.filter(task => taskIsFixed(snapshot, task))) {
    const start = timestamp(task.start_date);
    const end = timestamp(task.end_date);
    const state = stateForOrder(task, definition);
    if (!start || !end || end <= start || !state) {
      return unchangedLineResult(
        line,
        'fixed-boundary-invalid',
        'A fixed order lacks a usable interval or setup state.',
        [{ line, successorOrderId: taskId(task), reason: 'fixed-boundary-invalid' }],
      );
    }
    fixed.push({ task, state, start, end });
  }
  fixed.sort((left, right) => left.start.getTime() - right.start.getTime() || taskId(left.task).localeCompare(taskId(right.task)));

  const free = tasks.filter(task => !taskIsFixed(snapshot, task));
  let remaining = [...free];
  let fragmentStart = new Date(bounds.now);
  let predecessorState = initialState;
  let predecessorOrderId: string | null = null;
  const patches: SchedulePatch[] = [];
  const score = [0, 0, 0, 0, 0, 0];
  const explanation: CandidateReason[] = [];
  const missingEdges: MissingSetupEdge[] = [];
  let candidateCount = 0;
  let method: LineSearchResult['method'] = 'due-date-first-exact';
  let termination: SearchRun['termination'] = 'completed';

  const accept = (run: SearchRun): boolean => {
    candidateCount += run.candidateCount;
    if (run.method === 'due-date-first-greedy') method = run.method;
    if (run.termination !== 'completed') termination = run.termination;
    if (!run.winner) {
      missingEdges.push(...run.missingEdges);
      return false;
    }
    patches.push(...run.winner.patches);
    explanation.push(...run.winner.explanation);
    for (let index = 0; index < score.length; index += 1) score[index] += run.winner.score[index] ?? 0;
    return true;
  };

  for (const boundary of fixed) {
    if (boundary.start < fragmentStart) {
      return unchangedLineResult(
        line,
        'fixed-boundary-invalid',
        'Fixed boundaries overlap or precede the scheduling horizon.',
        [{ line, successorOrderId: taskId(boundary.task), reason: 'fixed-boundary-invalid' }],
      );
    }
    const admitted = remaining.filter(task => dueTimestamp(task) <= boundary.start.getTime());
    remaining = remaining.filter(task => dueTimestamp(task) > boundary.start.getTime());
    const run = searchFragment(snapshot, bounds, line, admitted, {
      start: fragmentStart,
      end: boundary.start,
      predecessorState,
      predecessorOrderId,
      nextFixed: boundary,
    }, budget);
    if (!accept(run)) {
      explanation.push({
        code: 'fixed-boundary-infeasible',
        message: `Cannot preserve the required incoming setup before fixed ${taskId(boundary.task)}.`,
        line,
        taskId: taskId(boundary.task),
      });
      return {
        patches: [], score: [0, 0, 0, 0, 0, 0], explanation, missingEdges,
        candidateCount, method, termination, unchanged: true,
      };
    }
    fragmentStart = new Date(boundary.end);
    predecessorState = boundary.state;
    predecessorOrderId = taskId(boundary.task);
  }

  const trailing = searchFragment(snapshot, bounds, line, remaining, {
    start: fragmentStart,
    end: bounds.horizonEnd,
    predecessorState,
    predecessorOrderId,
  }, budget);
  if (!accept(trailing)) {
    const incompatible = missingEdges.some(edge => edge.reason === 'successor-state-unknown');
    explanation.push(incompatible
      ? { code: 'setup-incompatible', message: 'Line has an order without a complete setup state.', line }
      : { code: 'setup-sequence-infeasible', message: 'No covered feasible setup sequence was found.', line });
    return {
      patches: [], score: [0, 0, 0, 0, 0, 0], explanation, missingEdges,
      candidateCount, method, termination, unchanged: true,
    };
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
  const plant = bounds.setup.plant;
  const definition = bounds.setup.definition;
  const byLine = new Map<string, NimbusTask[]>();
  for (const task of snapshot.tasks) {
    const taskPlant = String(task.PLANT ?? task.plant ?? '');
    const line = String(task.PRODUCTION_LINE ?? '');
    if (!line || taskPlant !== plant) continue;
    const group = byLine.get(line) ?? [];
    group.push(task);
    byLine.set(line, group);
  }

  let candidateCount = 0;
  let termination: SearchDiagnostics['termination'] = 'completed';
  const patches: SchedulePatch[] = [];
  const explanation: CandidateReason[] = [];
  const unchangedLines: string[] = [];
  const missingEdges: MissingSetupEdge[] = [];
  const score = [0, 0, 0, 0, 0, 0];
  const budget: SearchBudget = { remainingIterations: bounds.iterationCap };

  for (const [line, tasks] of [...byLine.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!definition || definition.plant !== plant) {
      unchangedLines.push(line);
      explanation.push({ code: 'setup-definition-unavailable', message: 'No compatible setup definition is available.', line });
      continue;
    }
    if (tasks.some(task => taskIsFixed(snapshot, task))) {
      unchangedLines.push(line);
      explanation.push({ code: 'fixed-boundary', message: 'SPT line retained pending fixed-boundary evaluation.', line });
      continue;
    }
    const initial = bounds.setup.line_states.find(state => (
      state.line === line && state.signature_version === definition.signature_version
    ));
    if (!initial) {
      unchangedLines.push(line);
      missingEdges.push({ line, predecessorOrderId: null, reason: 'initial-state-unknown' });
      continue;
    }
    if (bounds.clock() >= bounds.deadline) {
      termination = 'deadline';
      unchangedLines.push(line);
      continue;
    }
    if (budget.remainingIterations <= 0) {
      termination = 'iteration-cap';
      unchangedLines.push(line);
      continue;
    }
    candidateCount += 1;
    budget.remainingIterations -= 1;
    const candidate = candidateForSequence(snapshot, bounds, line, orderedByProductiveRuntime(tasks), {
      start: bounds.now,
      end: bounds.horizonEnd,
      predecessorState: initial.state_key,
      predecessorOrderId: null,
    });
    if (!candidate.feasible) {
      unchangedLines.push(line);
      missingEdges.push(...candidate.missingEdges);
      explanation.push({ code: 'spt-sequence-infeasible', message: 'Pure SPT sequence has no covered feasible setup path.', line });
      continue;
    }
    patches.push(...candidate.patches);
    explanation.push(...candidate.explanation);
    const setupMinutes = candidate.score[5] ?? 0;
    score[4] -= candidate.patches.length;
    score[5] += setupMinutes;
  }

  return {
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
    },
    unchangedLines,
    missingEdges: uniqueMissingEdges(missingEdges),
  };
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
): CandidateResult {
  requireDueDateBounds(bounds);
  const started = bounds.clock();
  const plant = bounds.setup.plant;
  const definition = bounds.setup.definition;
  const byLine = new Map<string, NimbusTask[]>();
  for (const task of snapshot.tasks) {
    const taskPlant = String(task.PLANT ?? task.plant ?? '');
    const line = String(task.PRODUCTION_LINE ?? '');
    if (!line || taskPlant !== plant) continue;
    const group = byLine.get(line) ?? [];
    group.push(task);
    byLine.set(line, group);
  }

  let candidateCount = 0;
  let method: SearchDiagnostics['method'] = 'due-date-first-exact';
  let termination: SearchDiagnostics['termination'] = 'completed';
  const patches: SchedulePatch[] = [];
  const explanation: CandidateReason[] = [];
  const unchangedLines: string[] = [];
  const missingEdges: MissingSetupEdge[] = [];
  const score = [0, 0, 0, 0, 0, 0];
  const budget: SearchBudget = { remainingIterations: bounds.iterationCap };

  for (const [line, tasks] of [...byLine.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!definition || definition.plant !== plant) {
      unchangedLines.push(line);
      explanation.push({ code: 'setup-definition-unavailable', message: 'No compatible setup definition is available.', line });
      continue;
    }
    const initial = bounds.setup.line_states.find(state => (
      state.line === line && state.signature_version === definition.signature_version
    ));
    if (!initial) {
      unchangedLines.push(line);
      missingEdges.push({ line, predecessorOrderId: null, reason: 'initial-state-unknown' });
      continue;
    }

    const result = evaluateLineWithFixedBoundaries(snapshot, bounds, line, tasks, initial.state_key, budget);
    candidateCount += result.candidateCount;
    if (result.method === 'due-date-first-greedy') method = result.method;
    if (result.termination !== 'completed') termination = result.termination;
    if (result.unchanged) {
      unchangedLines.push(line);
      missingEdges.push(...result.missingEdges);
      explanation.push(...result.explanation);
      continue;
    }
    patches.push(...result.patches);
    explanation.push(...result.explanation);
    missingEdges.push(...result.missingEdges);
    for (let index = 0; index < score.length; index += 1) score[index] += result.score[index] ?? 0;
  }

  return {
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
    },
    unchangedLines,
    missingEdges: uniqueMissingEdges(missingEdges),
  };
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
