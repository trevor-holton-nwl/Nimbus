/*
 * Detached candidate scheduling contract.
 *
 * This module receives the complete scheduling read model as a snapshot and
 * returns only patches. It never mutates Store, DOM, persistence, alerts, or
 * Timeline; the workbench owns the one explicit Store commit after Apply.
 */

import type { RemoveBacklogResult } from './schedule-services.mjs';
import { Engine, candidateDefaultWorkHours, MIN_PRODUCTIVE_SEGMENT_MINUTES } from './schedule-services.mjs';
import { normalizedValue, resolveSetup, stateForOrder } from './setup-domain.mjs';
import type {
  NimbusBlock,
  ConstraintConfig,
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
  /** Optional plant rule supplied by the live engine; absent retains detached legacy behavior. */
  notBefore?: (task: NimbusTask) => Date | null;
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

const UNCOVERED_SETUP_TRANSITION_REASON = 'No version-matched setup transition covers this state pair';
const PROTECTED_FIXED_BOUNDARY_OUTSIDE_HORIZON_REASON = 'protected-fixed-boundary-outside-horizon';

/** Score index carrying the count of uncovered-but-admitted transitions in a
 * candidate (A2). Appended, never inserted: `score[5]` is read as setup-minute
 * savings elsewhere (`evaluateMinChangeover`/`selectThroughputCandidate`), so
 * renumbering would corrupt the min-changeover accept/reject decision.
 * Compared explicitly in `compareCandidate` immediately after `policyKey` —
 * never folded into the mode-permuted `terms` list — so it stays mode-
 * independent: fewest uncovered edges always outranks every due/setup term. */
const SCORE_UNCOVERED = 6;

/** The canonical hard-infeasible score vector (`score[0] = 1`), now 7-wide so
 * every candidate — feasible or not — carries the same arity as `score[
 * SCORE_UNCOVERED]`. Arity is not type-enforced (`score` is `number[]`), so
 * this exists to keep every literal in one place rather than drifting. */
function infeasibleScore(): number[] {
  return [1, 0, 0, 0, 0, 0, 0];
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
  /** Full lexicographic policy vector. `score[1]` is a compact diagnostic
   * contribution; this preserves every configured priority tier without a
   * lossy numeric encoding. */
  policyKey: string;
  sequenceKey: string;
  /** Orders deliberately deferred from this capacity-bounded fragment. They
   * remain eligible for the next fragment after a fixed boundary. */
  unadmitted: NimbusTask[];
  explanation: CandidateReason[];
  missingEdges: MissingSetupEdge[];
  /** The predecessor identity/state this covered core actually ended on, set
   * only on a feasible result. A subsequent `placeUnknownTail` call or a
   * fixed boundary's incoming-setup reservation chains from this rather than
   * re-deriving it from the fragment's original predecessor. */
  finalState?: SetupStateKey | null;
  finalPredecessorOrderId?: string | null;
}

interface SearchRun {
  candidateCount: number;
  method: 'due-date-first-exact' | 'due-date-first-greedy';
  termination: 'completed' | 'deadline' | 'iteration-cap';
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

/** A per-line counter. Constructed fresh inside the per-line loop of both
 * `evaluateDueDateFirst` and `evaluateSptWithSetup` (Part 2b) so one large
 * line's search can never exhaust the budget for every other line on the
 * plant; a fixed-boundary fragment run still shares it with every other
 * fragment on the same line. */
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
  nextFixed?: FixedBoundary;
  /** An active override crossing a fixed boundary makes the named free order
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

type FragmentMode = 'due-date-first' | 'spt' | 'min-changeover' | 'throughput';

interface BoundaryOverrideLocks {
  requiredFirstOrderId?: string;
  requiredLastOrderId?: string;
  /** A persisted current line state can bind directly to the first fixed
   * order. In that case no free work may occupy the preceding fragment. */
  requiresInitialState?: boolean;
  /** Like `requiresInitialState`, but the protected predecessor is a
   * preserved current first order rather than persisted line state. */
  requiresInitialPredecessorId?: string;
  /** A fixed predecessor and successor can be a protected occurrence too. The
   * successor fragment must remain empty so no free production breaks that
   * physical adjacency. */
  requiredFixedPredecessorId?: string;
  requiredFixedSuccessorId?: string;
  issue?: MissingSetupEdge;
}

/** A persisted initial state can itself be the protected predecessor of a
 * free order. Unlike an ordinary free/free pair, that successor must be the
 * very first physical order in the plan and therefore belongs before the
 * first fixed boundary even when its due date is later. */
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
 * free orders belong to the fragment currently being searched; fixed-boundary
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
function activePriorityKeys(snapshot: Readonly<ScheduleSnapshot>, plant: string): string[] {
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

function policyKeyForTask(
  snapshot: Readonly<ScheduleSnapshot>, plant: string, line: string, task: NimbusTask,
): string {
  return activePriorityKeys(snapshot, plant)
    .map(fieldKey => String(rankForTask(snapshot, fieldKey, line, task)).padStart(7, '0'))
    .join('|');
}

function policyKeyForSequence(
  snapshot: Readonly<ScheduleSnapshot>, plant: string, line: string, sequence: ReadonlyArray<NimbusTask>,
): string {
  return sequence.map(task => policyKeyForTask(snapshot, plant, line, task)).join('\u0000');
}

function policyScore(
  snapshot: Readonly<ScheduleSnapshot>, plant: string, line: string, sequence: ReadonlyArray<NimbusTask>,
): number {
  // Kept as a numeric score slot for preview consumers. Candidate comparison
  // uses the full policyKey above, because a scalar sum cannot preserve a
  // nested policy tree's lexicographic precedence.
  const keys = activePriorityKeys(snapshot, plant);
  if (!keys.length) return 0;
  return sequence.reduce((total, task, position) => {
    const taskScore = keys.reduce((rankTotal, fieldKey, depth) => (
      rankTotal + rankForTask(snapshot, fieldKey, line, task) * (keys.length - depth)
    ), 0);
    return total + taskScore * (sequence.length - position);
  }, 0);
}

function orderedByPolicyThenDue(
  snapshot: Readonly<ScheduleSnapshot>, plant: string, line: string, tasks: ReadonlyArray<NimbusTask>,
): NimbusTask[] {
  return [...tasks].sort((left, right) => (
    policyKeyForTask(snapshot, plant, line, left).localeCompare(policyKeyForTask(snapshot, plant, line, right))
    || dueTimestamp(left) - dueTimestamp(right)
    || taskId(left).localeCompare(taskId(right))
  ));
}

/** An active occurrence override belongs to one physical adjacency. When a
 * candidate puts its successor behind a different order/state, the override
 * does not travel with that order; the candidate is infeasible and reports
 * the binding as inactive. */
function inactiveOverrideForTransition(
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  predecessorState: SetupStateKey | null,
  successorState: SetupStateKey,
  predecessorOrderId: string | null,
  successorOrderId: string,
  lineOrderIds: ReadonlySet<string>,
  allowsDeletedPredecessorBinding = false,
): MissingSetupEdge | null {
  const definition = bounds.setup.definition!;
  const bound = bounds.setup.overrides.filter(override => (
    override.status === 'active'
    && override.machine === line
    && override.signature_version === definition.signature_version
    && override.successor_order_id === successorOrderId
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
      // An unknown predecessor state can never confirm a bound override; treat
      // it as a mismatch rather than skipping the check.
      || predecessorState === null
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
    // Fixed successors are validated by boundaryOverrideLocks. A missing
    // successor has already been diagnosed without freezing this line.
    if (!successor) continue;
    const successorState = stateForOrder(successor, definition);
    if (!successorState
      || initialState === null
      || stateKey(initialState) !== stateKey(override.predecessor_state_key)
      || stateKey(successorState) !== stateKey(override.successor_state_key)
      || (requiredFirstOrderId && requiredFirstOrderId !== successorOrderId)) {
      issue ??= inactiveOverrideEdge(line, initialPredecessorOrderId, successorOrderId);
      continue;
    }
    requiredFirstOrderId = successorOrderId;
  }
  return { requiredFirstOrderId, issue };
}

/** Extract only fragment-local active overrides. A non-local free/fixed pair
 * is deliberately left to the fixed-boundary lock layer, where its physical
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
    const successorState = stateForOrder(successor, definition);
    if (!successorState || stateKey(successorState) !== stateKey(override.successor_state_key)) {
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
      // The immediate physical predecessor can be a fixed boundary or a
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
    const predecessorState = stateForOrder(predecessor, definition);
    if (!predecessorState || stateKey(predecessorState) !== stateKey(override.predecessor_state_key)) {
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
 * end before a fixed run and the other after it, even though both endpoints
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
      fragment.nextFixed ? taskId(fragment.nextFixed.task) : undefined,
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

function taskIsFixed(snapshot: Readonly<ScheduleSnapshot>, task: NimbusTask): boolean {
  const fixedIds = snapshot.fixedIds instanceof Set
    ? snapshot.fixedIds
    : new Set(Array.from(snapshot.fixedIds, String));
  return task.fixed === true || fixedIds.has(taskId(task));
}

// B7: resolve an order's plant the same way the legacy engine does
// (`t.PLANT || Store.getPlantForLine(t.MACHINE)`, schedule-state.mts)
// instead of an exact `task.PLANT` match. Without this, a null-PLANT order on
// a line that maps to this plant is optimized by the legacy engine and
// counted in the preview's KPIs, but is completely invisible to the
// setup-aware evaluators — no patch, no explanation, no toast. Mirrors
// `Store.getPlantForLine`'s own precedence: line settings first, then the
// master-data line→plant mapping.
function resolveTaskPlant(task: Readonly<NimbusTask>, snapshot: Readonly<ScheduleSnapshot>): string | null {
  const direct = task.PLANT || task.plant;
  if (direct) return String(direct);
  const line = String(task.MACHINE ?? '');
  if (!line) return null;
  const fromSettings = snapshot.lineSettings?.[line]?.plant;
  if (fromSettings) return fromSettings;
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
  // B6: fall back to the same default work hours the alerts path and the
  // detached-candidate path already use (schedule-services.mts's
  // setupDefaultWorkHours/candidateDefaultWorkHours) instead of returning []
  // when a line or plant calendar is missing. Without this, one plant with
  // no `Store.plants` entry silently placed nothing for every line in it,
  // while alerts kept computing as though hours existed.
  const lineHours = snapshot.calendars[line]?.workHours ?? candidateDefaultWorkHours();
  const plantHours = snapshot.plants[plant]?.workHours ?? candidateDefaultWorkHours();
  if (through <= from) return [];

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
    const lineWindow = localWindow(lineHours, date);
    const plantWindow = localWindow(plantHours, date);
    if (!lineWindow || !plantWindow) continue;
    const start = Math.max(lineWindow.start.getTime(), plantWindow.start.getTime());
    const end = Math.min(lineWindow.end.getTime(), plantWindow.end.getTime());
    if (end - start >= requiredMs) return true;
  }
  return false;
}

function compareCandidate(left: DueDateCandidate, right: DueDateCandidate,
                          mode: FragmentMode = 'due-date-first'): number {
  const hardConstraintDelta = (left.score[0] ?? 0) - (right.score[0] ?? 0);
  if (hardConstraintDelta) return hardConstraintDelta;
  const policyDelta = left.policyKey.localeCompare(right.policyKey);
  if (policyDelta) return policyDelta;
  // Coverage tier (A2): compared outside the mode-permuted `terms` list below
  // so it is immune to future reordering there, and so a mode like
  // `throughput` (which puts score[5] first) can never prefer a cheaper
  // zero-minute uncovered admission over fewer uncovered edges. Minimizing
  // the count of uncovered edges = minimizing state changes = maximal
  // same-signature grouping; a fully-covered sequence always wins when one
  // exists, since it has zero uncovered edges.
  const coverageDelta = (left.score[SCORE_UNCOVERED] ?? 0) - (right.score[SCORE_UNCOVERED] ?? 0);
  if (coverageDelta) return coverageDelta;
  // All policies retain hard feasibility and configured policy tiers. Only the
  // lower-order comparison changes: Min Changeover remains due-safe, while
  // Throughput may prefer setup savings and is constrained by its explicit
  // post-evaluation slip gate below.
  const terms = mode === 'min-changeover'
    ? [2, 3, 5, 4]
    : mode === 'throughput'
      ? [5, 2, 3, 4]
      : [2, 3, 4, 5];
  for (const index of terms) {
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
  adjacency: Readonly<FragmentAdjacency>,
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
  const unadmitted: NimbusTask[] = [];
  // A1/A2: count of uncovered-but-admitted transitions in this sequence
  // (mid-sequence + fixed-boundary-incoming). Rolled into score[SCORE_UNCOVERED]
  // on the feasible return below so `compareCandidate` can minimize it —
  // minimizing uncovered edges is what drives same-signature grouping.
  let uncoveredEdgeCount = 0;

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
    const pullForwardFloor = bounds.notBefore?.(task);
    if (pullForwardFloor && cursor < pullForwardFloor) cursor = new Date(pullForwardFloor);
    const successorState = stateForOrder(task, definition);
    if (!successorState) {
      missingEdges.push({ line, predecessorOrderId, successorOrderId: taskId(task), reason: 'successor-state-unknown' });
      return {
        feasible: false, patches: [], score: infeasibleScore(), policyKey: '', sequenceKey: '', unadmitted: [], explanation, missingEdges,
      };
    }
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
    const unknownPredecessor = predecessorState === null;
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
        successorState,
        predecessorOrderId,
        successorOrderId: taskId(task),
        plantRows: bounds.setup.plant_rows,
        machineRows: bounds.setup.machine_rows,
        overrides: bounds.setup.overrides,
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
        explanation.push({
          code: 'admitted-without-setup',
          message: `Admitted ${taskId(task)} into the covered sequence without a matching setup transition; charged zero setup minutes.`,
          line,
          taskId: taskId(task),
        });
        setupRequirement = { kind: 'resolved', minutes: 0 };
      } else {
        effectiveSetupMinutes = resolved.effectiveMin;
        setupRequirement = { kind: 'resolved', minutes: resolved.effectiveMin };
      }
    }

    const runtimeMinutes = Math.round(Number(task.RUN_TIME) * 60);
    const splitPolicy = splitOrderPolicyForSnapshot(snapshot, bounds.setup.plant);
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
        ),
      } : {}),
      freeIntervals: freeIntervalsFor(snapshot, line, bounds.setup.plant, cursor, fragment.end),
      minProductiveSegmentMinutes: minProductiveSegmentMinutesForSnapshot(snapshot, bounds.setup.plant),
    });
    if (placement.kind !== 'placed' || !placement.productiveSegments.length) {
      if (placement.kind === 'infeasible' && placement.reason === 'no-feasible-capacity') {
        const deferred = sequence.slice(taskIndex);
        if (deferred.some(candidate => (
          taskId(candidate) === fragment.requiredFirstOrderId || taskId(candidate) === fragment.requiredLastOrderId
        ))) {
          return constraintFailure({
            line,
            predecessorOrderId,
            successorOrderId: taskId(task),
            reason: 'override-inactive',
          });
        }
        unadmitted.push(...deferred);
        const protectedPairFailure = deferredAdjacencyFailure(line, unadmitted, adjacency);
        if (protectedPairFailure) return constraintFailure(protectedPairFailure);
        explanation.push({
          code: 'due-work-unadmitted',
          message: `Deferred ${deferred.length} order(s) after available capacity ended in this fragment.`,
          line,
          taskId: taskId(task),
        });
        break;
      }
      // B3a: a NaN/zero/negative RUN_TIME is a data defect, not a genuinely
      // full calendar — say so explicitly rather than letting it read as an
      // unfalsifiable "no capacity" complaint.
      if (placement.kind === 'infeasible' && placement.reason === 'invalid-runtime') {
        explanation.push({
          code: 'invalid-runtime-data',
          message: `${taskId(task)} has an invalid RUN_TIME (missing, zero, or negative) — a data defect, not a capacity shortfall.`,
          line,
          taskId: taskId(task),
        });
      }
      missingEdges.push({
        line,
        predecessorOrderId,
        successorOrderId: taskId(task),
        reason: placement.kind === 'infeasible' ? placement.reason : 'no-feasible-capacity',
      });
      return {
        feasible: false, patches: [], score: infeasibleScore(), policyKey: '', sequenceKey: '', unadmitted: [], explanation, missingEdges,
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
    setupMinutes += effectiveSetupMinutes;
    const due = dueTimestamp(task);
    if (Number.isFinite(due) && last.end.getTime() > due) {
      lateCount += 1;
      latenessMinutes += Math.ceil((last.end.getTime() - due) / (60 * 1000));
    }
    if (!unknownPredecessor && !uncoveredAdmission) {
      explanation.push({
        code: 'due-date-first-placement',
        message: `Placed ${taskId(task)} after ${effectiveSetupMinutes} minutes of setup.`,
        line,
        taskId: taskId(task),
      });
    }
    cursor = new Date(last.end);
    predecessorState = successorState;
    predecessorOrderId = taskId(task);
  }

  if (fragment.nextFixed) {
    const fixed = fragment.nextFixed;
    const inactiveOverride = inactiveOverrideForTransition(
      bounds,
      line,
      predecessorState,
      fixed.state,
      predecessorOrderId,
      taskId(fixed.task),
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
    // (`incoming-fixed-setup-infeasible`) is a missing-setup-data fact, not a
    // reason to freeze the whole line (Part 1f): skip the reservation, keep
    // the diagnostic edge, and stay feasible. `deriveSetupObservation`/alerts
    // surface it against the applied schedule instead of a fake bar here.
    if (predecessorState === null) {
      missingEdges.push(unknownInitialStateEdge(line, fixed.task));
    } else {
      const resolved = resolveSetup({
        definition,
        machine: line,
        predecessorState,
        successorState: fixed.state,
        predecessorOrderId,
        successorOrderId: taskId(fixed.task),
        plantRows: bounds.setup.plant_rows,
        machineRows: bounds.setup.machine_rows,
        overrides: bounds.setup.overrides,
      });
      if (!resolved.covered || resolved.effectiveMin === null) {
        // A1: counted into uncoveredEdgeCount (only this !resolved.covered
        // branch — not `incoming-fixed-setup-infeasible` below, which is a
        // capacity fact about a covered transition, not a coverage gap).
        // The reason stays UNCOVERED_SETUP_TRANSITION_REASON (resolved.reason)
        // rather than 'scheduled-without-setup': this is the fixed order's own
        // incoming edge, not an order this call placed, and
        // `candidateEntersBoundaryUncovered` keys on this exact reason.
        uncoveredEdgeCount += 1;
        missingEdges.push({
          line,
          predecessorOrderId,
          successorOrderId: taskId(fixed.task),
          reason: resolved.reason,
        });
      } else {
        const setupStart = new Date(fixed.start.getTime() - resolved.effectiveMin * 60 * 1000);
        const fitsIncomingSetup = resolved.effectiveMin === 0
          ? cursor <= fixed.start
          : setupStart >= cursor && freeIntervalsFor(
            snapshot, line, bounds.setup.plant, cursor, fixed.start,
          ).some(interval => interval.start <= setupStart && interval.end >= fixed.start);
        if (!fitsIncomingSetup) {
          missingEdges.push({
            line,
            predecessorOrderId,
            successorOrderId: taskId(fixed.task),
            reason: 'incoming-fixed-setup-infeasible',
          });
        } else {
          setupMinutes += resolved.effectiveMin;
          explanation.push({
            code: 'fixed-incoming-setup',
            message: `Reserved ${resolved.effectiveMin} minutes of setup before fixed ${taskId(fixed.task)}.`,
            line,
            taskId: taskId(fixed.task),
          });
        }
      }
    }
  }

  return {
    feasible: true,
    patches,
    // Lower is better. The due-date objective intentionally remains ahead of
    // admitted work and setup consumption; the sequence key is the final tie.
    // score[SCORE_UNCOVERED] (A2) is compared in compareCandidate immediately
    // after policyKey, ahead of every term below.
    score: [
      0, policyScore(snapshot, bounds.setup.plant, line, sequence), lateCount, latenessMinutes, -patches.length,
      setupMinutes, uncoveredEdgeCount,
    ],
    policyKey: policyKeyForSequence(snapshot, bounds.setup.plant, line, sequence),
    sequenceKey: sequence.map(taskId).join('|'),
    unadmitted,
    explanation,
    missingEdges,
    finalState: predecessorState,
    finalPredecessorOrderId: predecessorOrderId,
  };
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
  const missingEdges: MissingSetupEdge[] = [];
  // A3: since A1, most permutations are feasible (mid-sequence uncovered
  // transitions are admitted, not rejected), so the "explored alternative"
  // diagnostic — an edge collected only from `!candidate.feasible` below —
  // would otherwise vanish for permutations whose OWN incoming-fixed-boundary
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
      : groups.flatMap((_, index) => nextChoiceForGroup(index) ? [index] : []),
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
      // traversal edge, but it still evaluates a fixed-boundary transition.
      if (totalTasks === 0) {
        if (budget.remainingIterations <= 0) {
          termination = 'iteration-cap';
          break;
        }
        budget.remainingIterations -= 1;
      }
      candidateCount += 1;
      const candidate = candidateForSequence(snapshot, bounds, line, selected, fragment, adjacency);
      if (candidate.feasible && (!winner || compareCandidate(candidate, winner, mode) < 0)) winner = candidate;
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
  const orderedTasks = groups.flatMap(group => group.tasks).sort((left, right) => (
    policyKeyForTask(snapshot, bounds.setup.plant, line, left).localeCompare(
      policyKeyForTask(snapshot, bounds.setup.plant, line, right),
    ) || dueTimestamp(left) - dueTimestamp(right) || taskId(left).localeCompare(taskId(right))
  ));
  let candidateCount = 0;
  let termination: SearchRun['termination'] = 'completed';
  let winner: DueDateCandidate | null = null;
  const missingEdges: MissingSetupEdge[] = [];
  const seen = new Set<string>();
  // A3: see the matching comment in exactSearch — preserves the "explored
  // alternative" diagnostic for a feasible candidate's own uncovered
  // incoming-fixed-boundary edge, now that most permutations no longer fail
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
    );
    if (!candidate.feasible) {
      missingEdges.push(...candidate.missingEdges);
      return null;
    }
    for (const edge of candidate.missingEdges) {
      if (edge.reason !== UNCOVERED_SETUP_TRANSITION_REASON) continue;
      const edgeKey = missingEdgeKey(edge);
      if (seenFeasibleUncoveredEdgeKeys.has(edgeKey)) continue;
      seenFeasibleUncoveredEdgeKeys.add(edgeKey);
      missingEdges.push(edge);
    }
    if (!winner || compareCandidate(candidate, winner, mode) < 0) winner = candidate;
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
 * incoming-fixed-boundary edge as "Rejected …" (A3) — otherwise the winner's
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
 * own uncovered incoming-fixed-boundary edge (see `exactSearch`/
 * `greedySearch`), the winner's own edge can otherwise appear in `edges` and
 * get reported as "Rejected …" even though it was the placement just made. */
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
  // Unknown-state orders are partitioned out here rather than poisoning the
  // whole fragment (Part 1a): the covered-core search below never sees them,
  // so the min-changeover objective never charges a fake zero-cost edge for
  // one. They are appended strictly after the covered core by the caller via
  // `placeUnknownTail` — never interleaved, because an unknown order
  // mid-chain would make every downstream covered transition's predecessor
  // unknown too.
  const unknownTail: NimbusTask[] = [];
  for (const task of tasks) {
    const state = stateForOrder(task, definition);
    if (!state) {
      missingEdges.push({ line, successorOrderId: taskId(task), reason: 'successor-state-unknown' });
      unknownTail.push(task);
      continue;
    }
    const key = stateKey(state);
    const group = groupsByState.get(key) ?? { key, state, tasks: [] };
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
    .map(group => ({
      ...group,
      tasks: mode === 'spt'
        ? orderedByProductiveRuntime(group.tasks)
        : orderedByPolicyThenDue(snapshot, bounds.setup.plant, line, group.tasks),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
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
    const sequence = orderWithAdjacency(orderedByProductiveRuntime(workingTasks), fragment, adjacency);
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
    const candidate = candidateForSequence(snapshot, bounds, line, sequence, fragment, adjacency);
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
    score: [0, 0, 0, 0, 0, 0, 0],
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
  fixed: ReadonlyArray<FixedBoundary>,
  free: ReadonlyArray<NimbusTask>,
  initialState: SetupStateKey | null,
  initialPredecessorOrderId: string | null,
): ReadonlyMap<string, BoundaryOverrideLocks> {
  const definition = bounds.setup.definition!;
  const fixedById = new Map(fixed.map(boundary => [taskId(boundary.task), boundary]));
  const fixedIndexById = new Map(fixed.map((boundary, index) => [taskId(boundary.task), index]));
  const freeById = new Map(free.map(task => [taskId(task), task]));
  const locks = new Map<string, BoundaryOverrideLocks>();

  const lockFor = (fixedId: string): BoundaryOverrideLocks => {
    const existing = locks.get(fixedId);
    if (existing) return existing;
    const created: BoundaryOverrideLocks = {};
    locks.set(fixedId, created);
    return created;
  };
  const conflict = (fixedId: string, successorOrderId: string): void => {
    const lock = lockFor(fixedId);
    lock.issue = { line, successorOrderId, reason: 'override-inactive' };
  };

  for (const override of bounds.setup.overrides) {
    if (override.status !== 'active' || override.machine !== line || override.signature_version !== definition.signature_version) {
      continue;
    }
    const successorFixed = fixedById.get(override.successor_order_id);
    const predecessorFixed = override.predecessor_order_id ? fixedById.get(override.predecessor_order_id) : undefined;

    if (successorFixed && override.predecessor_order_id === initialPredecessorOrderId) {
      const successorId = taskId(successorFixed.task);
      const successorIndex = fixedIndexById.get(successorId);
      const lock = lockFor(successorId);
      if (successorIndex !== 0
        || initialState === null
        || stateKey(override.predecessor_state_key) !== stateKey(initialState)
        || stateKey(override.successor_state_key) !== stateKey(successorFixed.state)
        || lock.requiredFixedPredecessorId
        || lock.requiredLastOrderId) {
        conflict(successorId, override.successor_order_id);
      } else {
        if (initialPredecessorOrderId === null) lock.requiresInitialState = true;
        else lock.requiresInitialPredecessorId = initialPredecessorOrderId;
      }
      continue;
    }

    if (predecessorFixed && successorFixed) {
      const predecessorId = taskId(predecessorFixed.task);
      const successorId = taskId(successorFixed.task);
      const predecessorIndex = fixedIndexById.get(predecessorId);
      const successorIndex = fixedIndexById.get(successorId);
      const predecessorLock = lockFor(predecessorId);
      const successorLock = lockFor(successorId);
      if (predecessorIndex === undefined
        || successorIndex !== predecessorIndex + 1
        || predecessorLock.requiredFirstOrderId
        || (predecessorLock.requiredFixedSuccessorId && predecessorLock.requiredFixedSuccessorId !== successorId)
        || successorLock.requiredLastOrderId
        || (successorLock.requiredFixedPredecessorId && successorLock.requiredFixedPredecessorId !== predecessorId)) {
        conflict(predecessorId, override.successor_order_id);
        conflict(successorId, override.successor_order_id);
      } else {
        predecessorLock.requiredFixedSuccessorId = successorId;
        successorLock.requiredFixedPredecessorId = predecessorId;
      }
      continue;
    }

    if (successorFixed && override.predecessor_order_id) {
      const predecessor = freeById.get(override.predecessor_order_id);
      if (!predecessor) {
        conflict(taskId(successorFixed.task), override.successor_order_id);
        continue;
      }
      const lock = lockFor(taskId(successorFixed.task));
      if (lock.requiresInitialState
        || lock.requiredFixedPredecessorId
        || (lock.requiredLastOrderId && lock.requiredLastOrderId !== taskId(predecessor))) {
        conflict(taskId(successorFixed.task), override.successor_order_id);
      } else {
        lock.requiredLastOrderId = taskId(predecessor);
      }
    }

    if (predecessorFixed) {
      const successor = freeById.get(override.successor_order_id);
      if (!successor) {
        // A removed successor is reported by missingSuccessorOverrideEdges;
        // it does not justify freezing unrelated remaining work on the line.
        if (!fixedById.has(override.successor_order_id)) continue;
        conflict(taskId(predecessorFixed.task), override.successor_order_id);
        continue;
      }
      const lock = lockFor(taskId(predecessorFixed.task));
      if (lock.requiredFixedSuccessorId
        || (lock.requiredFirstOrderId && lock.requiredFirstOrderId !== taskId(successor))) {
        conflict(taskId(predecessorFixed.task), override.successor_order_id);
      } else {
        lock.requiredFirstOrderId = taskId(successor);
      }
    }
  }
  return locks;
}

interface OutOfHorizonFixedOverrideAudit {
  protectedEdges: MissingSetupEdge[];
  inactiveEdges: MissingSetupEdge[];
}

/** A hard candidate horizon may omit ordinary future fixed production, but it
 * cannot erase an active exact relation to that production. A valid matching
 * pair must fail closed because the detached plan cannot preserve it without
 * scheduling through the caller's bound. A stale or missing pair is instead
 * retained as an inactive diagnostic, never silently dropped or protected. */
function auditOutOfHorizonFixedOverrides(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  initialState: SetupStateKey | null,
  initial: Readonly<LineInitialContext>,
): OutOfHorizonFixedOverrideAudit {
  const definition = bounds.setup.definition!;
  const tasksById = new Map(initial.allTasks.map(task => [taskId(task), task]));
  const postHorizonFixedIds = new Set(initial.allTasks.flatMap(task => {
    const start = timestamp(task.start_date);
    return taskIsFixed(snapshot, task) && start && start > bounds.horizonEnd ? [taskId(task)] : [];
  }));
  if (!postHorizonFixedIds.size) return { protectedEdges: [], inactiveEdges: [] };

  const stateForEndpoint = (orderId: string | null): SetupStateKey | null => {
    if (orderId === null) return initial.predecessorOrderId === null ? initialState : null;
    const task = tasksById.get(orderId);
    return task ? stateForOrder(task, definition) : null;
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
    if (!postHorizonFixedIds.has(predecessorOrderId ?? '')
      && !postHorizonFixedIds.has(successorOrderId)) {
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
      reason: PROTECTED_FIXED_BOUNDARY_OUTSIDE_HORIZON_REASON,
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

function protectedOutOfHorizonFixedBoundaryReasons(
  line: string,
  edges: ReadonlyArray<MissingSetupEdge>,
): CandidateReason[] {
  return edges.map(edge => ({
    code: PROTECTED_FIXED_BOUNDARY_OUTSIDE_HORIZON_REASON,
    message: `Active override ${edge.predecessorOrderId ?? 'initial state'} -> ${edge.successorOrderId ?? 'unknown'} crosses a fixed boundary outside the caller horizon.`,
    line,
    taskId: edge.successorOrderId ?? undefined,
  }));
}

function inactiveOutOfHorizonFixedOverrideReasons(
  line: string,
  edges: ReadonlyArray<MissingSetupEdge>,
): CandidateReason[] {
  return edges.map(edge => ({
    code: 'override-inactive',
    message: `Active override ${edge.predecessorOrderId ?? 'initial state'} -> ${edge.successorOrderId ?? 'unknown'} no longer matches a fixed boundary outside the caller horizon.`,
    line,
    taskId: edge.successorOrderId ?? undefined,
  }));
}

function belongsBeforeFixedBoundary(task: NimbusTask, boundary: FixedBoundary, mode: FragmentMode): boolean {
  if (mode === 'due-date-first') return dueTimestamp(task) <= boundary.start.getTime();
  // Pure SPT is ordered only by productive runtime. A stale or null planned
  // date must not pre-partition work behind the next fixed order; bounded
  // fragment placement decides what capacity can actually be admitted first.
  return true;
}

/** Represent whole free components that may safely defer around a fixed
 * boundary. A reroute is permitted only for a coverage failure or for setup
 * capacity that cannot fit before the boundary; an active free/free component
 * always moves together. */
interface BoundaryFallbackOption {
  retained: NimbusTask[];
  deferred: NimbusTask[];
}

/** Only setup-coverage and fixed incoming-capacity failures can safely try a
 * different obstacle-free fragment admission. Broken override bindings and
 * unknown states remain hard failures rather than excuses to drop work. */
function supportsBoundaryFallback(run: Readonly<SearchRun>): boolean {
  return run.missingEdges.length > 0 && run.missingEdges.every(edge => (
    edge.reason === UNCOVERED_SETUP_TRANSITION_REASON
    || edge.reason === 'incoming-fixed-setup-infeasible'
  ));
}

/** F3b secondary hardening: Part 1f's incoming-boundary leniency means
 * `candidateForSequence` still reports `feasible: true` for a fragment whose
 * LAST order's transition into `fragment.nextFixed` is uncovered — it just
 * skips the reservation and pushes a diagnostic edge rather than freezing.
 * That is correct for the covered-core search itself, but the non-terminal
 * fallback-ambiguity count below must not treat such a "leniently tolerated"
 * route as equally genuine to one whose incoming reservation is actually
 * covered — otherwise a single order that can never really enter this
 * boundary (e.g. RED when only BLUE -> fixed is covered) counts as a second
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
 * fixed-boundary fallback. A component is atomic: active free/free overrides
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
  if (!fragment.nextFixed || !admitted.length) return null;
  const baseOrder = mode === 'spt'
    ? orderedByProductiveRuntime(admitted)
    : orderedByPolicyThenDue(snapshot, bounds.setup.plant, line, admitted);
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
 * space cannot escape the caller's existing cap or deadline. */
function dueDateBoundaryFallbackCursor(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  admitted: ReadonlyArray<NimbusTask>,
  fragment: Readonly<FragmentContext>,
  freeComponents: ReadonlyMap<string, ReadonlySet<string>>,
  budget: SearchBudget,
): BoundaryFallbackCursor {
  const plan = boundaryFallbackComponentPlan(
    snapshot, bounds, line, admitted, fragment, freeComponents, 'due-date-first',
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
 * been evaluated from the fixed order's outgoing state. Rebuild its complete
 * free-order candidate from actual patches so partially admitted pre-fixed
 * work is not counted twice in policy or admitted-work scoring. */
function completeFinalBoundaryCandidate(
  snapshot: Readonly<ScheduleSnapshot>,
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  tasksById: ReadonlyMap<string, NimbusTask>,
  preFixed: DueDateCandidate,
  continuation: DueDateCandidate,
): DueDateCandidate {
  const patches = [...preFixed.patches, ...continuation.patches];
  const orderedTasks = patches.map(patch => tasksById.get(patch.id)!);
  const joinKey = (left: string, right: string): string => (
    left && right ? `${left}\u0000${right}` : left || right
  );
  return {
    feasible: true,
    patches,
    score: [
      0,
      policyScore(snapshot, bounds.setup.plant, line, orderedTasks),
      (preFixed.score[2] ?? 0) + (continuation.score[2] ?? 0),
      (preFixed.score[3] ?? 0) + (continuation.score[3] ?? 0),
      -patches.length,
      (preFixed.score[5] ?? 0) + (continuation.score[5] ?? 0),
      // A2: sum both halves' uncovered-edge counts — required, since
      // compareBoundaryFallback routes through compareCandidate, which reads
      // score[SCORE_UNCOVERED] directly.
      (preFixed.score[SCORE_UNCOVERED] ?? 0) + (continuation.score[SCORE_UNCOVERED] ?? 0),
    ],
    policyKey: policyKeyForSequence(snapshot, bounds.setup.plant, line, orderedTasks),
    sequenceKey: joinKey(preFixed.patches.map(patch => patch.id).join('|'), continuation.patches.map(patch => patch.id).join('|')),
    unadmitted: [],
    explanation: [...preFixed.explanation, ...continuation.explanation],
    missingEdges: [...preFixed.missingEdges, ...continuation.missingEdges],
  };
}

/** Final-boundary alternatives represent complete candidates, so they use the
 * same immutable lexicographic comparison as normal Due-date-first search.
 * The deferred-id key is only a deterministic tie-break after that comparison. */
function compareBoundaryFallback(
  left: Readonly<EvaluatedBoundaryFallback>, right: Readonly<EvaluatedBoundaryFallback>,
): number {
  const candidateDelta = compareCandidate(left.candidate, right.candidate);
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
    ? orderedByProductiveRuntime(tasks)
    : orderedByPolicyThenDue(snapshot, bounds.setup.plant, line, tasks);
  const splitPolicy = splitOrderPolicyForSnapshot(snapshot, bounds.setup.plant);
  const patches: SchedulePatch[] = [];
  const explanation: CandidateReason[] = [];
  const missingEdges: MissingSetupEdge[] = [];
  let cursor = new Date(start);
  let previousOrderId = initialPredecessorOrderId;
  const deferred: NimbusTask[] = [];

  for (let index = 0; index < ordered.length; index += 1) {
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
    const pullForwardFloor = bounds.notBefore?.(task);
    if (pullForwardFloor && cursor < pullForwardFloor) cursor = new Date(pullForwardFloor);
    const runtimeMinutes = Math.round(Number(task.RUN_TIME) * 60);
    const placement = placeWithSetup({
      earliestStart: cursor,
      runtimeMinutes,
      setup: { kind: 'resolved', minutes: 0 },
      policy: splitPolicy,
      ...(splitPolicy === 'overlong_only' ? {
        isInherentlyOverlong: !hasNominalWindow(snapshot, line, bounds.setup.plant, cursor, runtimeMinutes),
      } : {}),
      freeIntervals: freeIntervalsFor(snapshot, line, bounds.setup.plant, cursor, capacityEnd),
      minProductiveSegmentMinutes: minProductiveSegmentMinutesForSnapshot(snapshot, bounds.setup.plant),
    });
    if (placement.kind !== 'placed' || !placement.productiveSegments.length) {
      // B2: this order alone doesn't fit at the current cursor — defer it
      // and continue, rather than abandoning every order behind it. Failure
      // here is length-dependent (a long runtime can fail where a shorter
      // one behind it would fit), so cursor/previousOrderId intentionally do
      // not advance past a deferred order.
      deferred.push(task);
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

/** The incoming setup a covered core reserved before a fixed boundary stays
 * authoritative (Part 1c): tail capacity for the same fragment must end at
 * that reservation's start, never inside it. Re-derives the same reservation
 * `candidateForSequence` already validated, from the covered core's actual
 * final predecessor rather than the fragment's original one. An unknown
 * final predecessor state means the reservation itself cannot be computed —
 * the fixed order's own incoming setup then also becomes a diagnostic
 * further downstream, and tail capacity simply runs to the boundary. */
function tailCapacityEnd(
  bounds: Readonly<DueDateFirstBounds>,
  line: string,
  fragmentEnd: Date,
  nextFixed: FixedBoundary | undefined,
  finalState: SetupStateKey | null,
  finalPredecessorOrderId: string | null,
): Date {
  if (!nextFixed || finalState === null) return fragmentEnd;
  const definition = bounds.setup.definition!;
  const resolved = resolveSetup({
    definition,
    machine: line,
    predecessorState: finalState,
    successorState: nextFixed.state,
    predecessorOrderId: finalPredecessorOrderId,
    successorOrderId: taskId(nextFixed.task),
    plantRows: bounds.setup.plant_rows,
    machineRows: bounds.setup.machine_rows,
    overrides: bounds.setup.overrides,
  });
  const reserveMinutes = resolved.covered && resolved.effectiveMin !== null ? resolved.effectiveMin : 0;
  return new Date(nextFixed.start.getTime() - reserveMinutes * 60 * 1000);
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
 * (policy-then-due or SPT order, zero setup capacity) around whatever fixed
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
  const free = tasks.filter(task => !taskIsFixed(snapshot, task));
  const fixedWindows = tasks
    .filter(task => taskIsFixed(snapshot, task))
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
  // `missingEdges` (F1) has to work with across fixed windows.
  let previousOrderId: string | null = null;
  for (const window of fixedWindows) {
    if (remaining.length && cursor < window.start) {
      remaining = applyUnknownTail(
        snapshot, bounds, line, mode, remaining, cursor, window.start, patches, explanation, missingEdges, previousOrderId,
      );
      if (patches.length) previousOrderId = String(patches.at(-1)!.id);
    }
    if (window.end > cursor) cursor = new Date(window.end);
  }
  if (remaining.length) {
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

function evaluateLineWithFixedBoundaries(
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
  const postHorizonOverrideAudit = auditOutOfHorizonFixedOverrides(
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
    ...inactiveOutOfHorizonFixedOverrideReasons(line, additionalInactivePostHorizonEdges),
  ];
  if (postHorizonOverrideAudit.protectedEdges.length) {
    return unchangedLineResult(
      line,
      PROTECTED_FIXED_BOUNDARY_OUTSIDE_HORIZON_REASON,
      'An active fixed-boundary override cannot be preserved inside the caller scheduling horizon.',
      [...baseMissingEdges, ...postHorizonOverrideAudit.protectedEdges],
      [...baseExplanation, ...protectedOutOfHorizonFixedBoundaryReasons(line, postHorizonOverrideAudit.protectedEdges)],
    );
  }
  const fixed: FixedBoundary[] = [];
  for (const task of tasks.filter(task => taskIsFixed(snapshot, task))) {
    const start = timestamp(task.start_date);
    const end = timestamp(task.end_date);
    // An equal-start fixed run remains the terminal incoming boundary: its
    // setup can still occupy time inside the caller horizon. Strictly later
    // unprotected runs cannot lend capacity to this detached candidate.
    if (start && start > bounds.horizonEnd) continue;
    const state = stateForOrder(task, definition);
    if (!start || !end || end <= start || !state) {
      return unchangedLineResult(
        line,
        'fixed-boundary-invalid',
        'A fixed order lacks a usable interval or setup state.',
        [
          ...baseMissingEdges,
          { line, successorOrderId: taskId(task), reason: 'fixed-boundary-invalid' },
        ],
        baseExplanation,
      );
    }
    fixed.push({ task, state, start, end });
  }
  fixed.sort((left, right) => left.start.getTime() - right.start.getTime() || taskId(left.task).localeCompare(taskId(right.task)));

  const free = tasks.filter(task => !taskIsFixed(snapshot, task));
  const locks = boundaryOverrideLocks(bounds, line, fixed, free, initialState, initial.predecessorOrderId);
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
    && fixed.length
    && locks.get(taskId(fixed[0].task))?.requiresInitialState) {
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
  const score = [0, 0, 0, 0, 0, 0, 0];
  const explanation: CandidateReason[] = [...baseExplanation];
  const missingEdges: MissingSetupEdge[] = [...baseMissingEdges];
  let candidateCount = 0;
  let method: LineSearchResult['method'] = 'due-date-first-exact';
  let termination: SearchRun['termination'] = 'completed';

  const recordRun = (run: Readonly<SearchRun>): void => {
    candidateCount += run.candidateCount;
    if (run.method === 'due-date-first-greedy') method = run.method;
    if (run.termination !== 'completed') termination = run.termination;
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
    // 'initial-state-unknown' / 'incoming-fixed-setup-infeasible' winner
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

  for (let boundaryIndex = 0; boundaryIndex < fixed.length; boundaryIndex += 1) {
    const boundary = fixed[boundaryIndex];
    // F3: only a fragment before a LATER fixed boundary needs the caller to
    // own arbitration — that is the "cannot legitimately rank two
    // alternatives ahead of later fixed boundaries" scenario the ambiguity
    // guard below exists for. The terminal boundary's local fallback already
    // compares every complete candidate directly (no separate ambiguity
    // guard is needed there), so letting its own per-boundary run resolve
    // coverage via demotion first — exactly like the trailing fragment —
    // is safe and matches every other never-freeze fragment's behavior.
    const isTerminalBoundary = boundaryIndex === fixed.length - 1;
    if (boundary.start < fragmentStart) {
      return unchangedLineResult(
        line,
        'fixed-boundary-invalid',
        'Fixed boundaries overlap or precede the scheduling horizon.',
        [
          ...baseMissingEdges,
          { line, successorOrderId: taskId(boundary.task), reason: 'fixed-boundary-invalid' },
        ],
        baseExplanation,
      );
    }
    const boundaryLock = locks.get(taskId(boundary.task));
    if (boundaryLock?.issue) {
      return unchangedLineResult(
        line,
        'override-inactive',
        'An active occurrence override cannot be preserved at this fixed boundary.',
        [...baseMissingEdges, boundaryLock.issue],
        baseExplanation,
      );
    }
    if (boundaryLock?.requiredFixedPredecessorId
      && predecessorOrderId !== boundaryLock.requiredFixedPredecessorId) {
      return unchangedLineResult(
        line,
        'override-inactive',
        'An active occurrence override no longer has its bound fixed predecessor.',
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

    const reservedForAnotherBoundary = new Set<string>();
    for (let futureIndex = boundaryIndex; futureIndex < fixed.length; futureIndex += 1) {
      const futureLock = locks.get(taskId(fixed[futureIndex].task));
      if (futureLock?.requiredFirstOrderId) reservedForAnotherBoundary.add(futureLock.requiredFirstOrderId);
      if (futureLock?.requiredLastOrderId && futureIndex !== boundaryIndex) {
        reservedForAnotherBoundary.add(futureLock.requiredLastOrderId);
      }
    }
    if (requiredFirstOrderId) reservedForAnotherBoundary.delete(requiredFirstOrderId);

    let componentConflict: MissingSetupEdge | null = null;
    const admitted = boundaryLock?.requiresInitialState
      || boundaryLock?.requiresInitialPredecessorId
      || boundaryLock?.requiredFixedPredecessorId
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
        return members.some(member => belongsBeforeFixedBoundary(freeById.get(member)!, boundary, mode));
      });
    if (componentConflict) {
      return unchangedLineResult(
        line,
        'override-inactive',
        'An active occurrence override cannot remain adjacent across fixed boundaries.',
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
      nextFixed: boundary,
      requiredFirstOrderId,
      requiredLastOrderId: boundaryLock?.requiredLastOrderId,
    };
    const run = searchFragment(snapshot, bounds, line, admitted, fragment, budget, mode);
    // A failed pre-fixed sequence may still have a fully covered route after
    // the fixed run. Search bounded whole-component deferrals under the same
    // shared budget; the rejected edge stays visible when a later route wins.
    let winner = accept(run, false);
    // Tracks whichever run's unknown-tail set actually corresponds to the
    // admitted batch that produced `winner` (Part 1c) — the plain run, or
    // whichever fallback run below replaces it.
    let tailSource: ReadonlyArray<NimbusTask> = run.unknownTail;
    let deferredAcrossFixed: NimbusTask[] = [];
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
            deferredAcrossFixed = option.deferred;
            missingEdges.push(...run.missingEdges);
            explanation.push({
              code: 'covered-fixed-boundary-fallback',
              message: `Deferred ${deferredAcrossFixed.length} order(s) past fixed ${taskId(boundary.task)} to preserve a covered fixed boundary.`,
              line,
              taskId: taskId(boundary.task),
            });
            break;
          }
          if (fallbackRun.termination !== 'completed') break;
        }
      } else if (isTerminalBoundary) {
        // Only the terminal fixed boundary can be compared locally without
        // changing planner architecture: each option is extended through the
        // one remaining free fragment, yielding a complete candidate.
        const completeFallbacks: EvaluatedBoundaryFallback[] = [];
        const fallbackCursor = dueDateBoundaryFallbackCursor(
          snapshot, bounds, line, admitted, fragment, freeComponents, budget,
        );
        let completeEnumeration = true;
        for (let option = fallbackCursor.next(); option; option = fallbackCursor.next()) {
          const fallbackRun = searchFragment(snapshot, bounds, line, option.retained, fragment, budget, mode);
          fallbackRuns.push(fallbackRun);
          recordRun(fallbackRun);
          if (fallbackRun.termination !== 'completed') {
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
          if (continuation.termination !== 'completed') {
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
          termination = fallbackCursor.termination;
        }
        if (!completeEnumeration) {
          missingEdges.push(
            ...run.missingEdges,
            ...fallbackRuns.flatMap(fallbackRun => fallbackRun.missingEdges),
            ...continuationRuns.flatMap(continuation => continuation.missingEdges),
          );
          appendRejectedCoverageDiagnostics(missingEdges, explanation, run.missingEdges);
          explanation.push({
            code: 'fixed-boundary-fallback-ambiguous',
            message: `The bounded fallback search could not compare every route around fixed ${taskId(boundary.task)}.`,
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
        for (const candidate of completeFallbacks) {
          if (!selectedFallback || compareBoundaryFallback(candidate, selectedFallback) < 0) {
            selectedFallback = candidate;
          }
        }
        if (selectedFallback) {
          missingEdges.push(...run.missingEdges);
          const selectedFallbackEdgeKeys = winnerEdgeKeySet(selectedFallback.candidate);
          appendRejectedCoverageDiagnostics(missingEdges, explanation, run.missingEdges, selectedFallbackEdgeKeys);
          appendRejectedCoverageDiagnostics(missingEdges, explanation, selectedFallback.run.missingEdges, selectedFallbackEdgeKeys);
          appendRejectedCoverageDiagnostics(missingEdges, explanation, selectedFallback.continuation!.missingEdges, selectedFallbackEdgeKeys);
          applyCandidate(selectedFallback.candidate);
          explanation.push({
            code: 'covered-fixed-boundary-fallback',
            message: `Deferred ${selectedFallback.option.deferred.length} order(s) past fixed ${taskId(boundary.task)} to preserve a covered fixed boundary.`,
            line,
            taskId: taskId(boundary.task),
          });
          // This complete candidate already spans the fixed boundary through
          // to the horizon end (Part 1c): place each half's unknown tail
          // against its own capacity — the pre-fixed half up to fixed's
          // reserved incoming setup, the continuation half up to the
          // horizon, since there is no further fragment to defer to.
          const preFixedTailUnadmitted = applyUnknownTail(
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
          for (const task of [...preFixedTailUnadmitted, ...continuationTailUnadmitted]) {
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
        // A local pre-fixed fragment cannot legitimately rank two alternatives
        // ahead of later fixed boundaries. Accept the only proven route; when
        // there is more than one (or the shared budget stops enumeration), fail
        // closed instead of inventing a local admission-first objective.
        const feasibleFallbacks: EvaluatedBoundaryFallback[] = [];
        const fallbackCursor = dueDateBoundaryFallbackCursor(
          snapshot, bounds, line, admitted, fragment, freeComponents, budget,
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
          if (fallbackRun.termination !== 'completed') {
            completeEnumeration = false;
            break;
          }
        }
        if (fallbackCursor.termination !== 'completed') {
          completeEnumeration = false;
          termination = fallbackCursor.termination;
        }
        if (!completeEnumeration || feasibleFallbacks.length > 1) {
          missingEdges.push(...run.missingEdges, ...fallbackRuns.flatMap(fallbackRun => fallbackRun.missingEdges));
          appendRejectedCoverageDiagnostics(missingEdges, explanation, run.missingEdges);
          explanation.push({
            code: 'fixed-boundary-fallback-ambiguous',
            message: completeEnumeration
              ? `Multiple covered fallback routes remain before fixed ${taskId(boundary.task)}; no local route was selected.`
              : `The bounded fallback search could not enumerate every route before fixed ${taskId(boundary.task)}.`,
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
          deferredAcrossFixed = selectedFallback.option.deferred;
          missingEdges.push(...run.missingEdges);
          appendRejectedCoverageDiagnostics(missingEdges, explanation, run.missingEdges, winnerEdgeKeySet(winner));
          explanation.push({
            code: 'covered-fixed-boundary-fallback',
            message: `Deferred ${deferredAcrossFixed.length} order(s) past fixed ${taskId(boundary.task)} to preserve a covered fixed boundary.`,
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
          code: 'fixed-boundary-infeasible',
          message: `Cannot preserve the required incoming setup before fixed ${taskId(boundary.task)}.`,
          line,
          taskId: taskId(boundary.task),
        });
        return {
          patches: [], score: [0, 0, 0, 0, 0, 0, 0], explanation, missingEdges,
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
    remaining = [...winner.unadmitted, ...deferredAcrossFixed, ...tailUnadmitted, ...later];
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
        patches: [], score: [0, 0, 0, 0, 0, 0, 0], explanation, missingEdges,
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
  const plant = bounds.setup.plant;
  const definition = bounds.setup.definition;
  const byLine = new Map<string, NimbusTask[]>();
  for (const task of snapshot.tasks) {
    const taskPlant = resolveTaskPlant(task, snapshot);
    const line = String(task.MACHINE ?? '');
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
  const score = [0, 0, 0, 0, 0, 0, 0];

  for (const [line, tasks] of [...byLine.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    // Part 2b: a fresh per-line budget so one large line's search can never
    // exhaust the iteration cap for every other line on the plant.
    const budget: SearchBudget = { remainingIterations: bounds.iterationCap };
    if (!definition || definition.plant !== plant) {
      // Part 1e: no setup definition at all means setup-awareness cannot run
      // for this line, but the line is never frozen — free orders still get
      // a policy/due-ordered tail placement around any fixed orders.
      const wholeLine = placeWholeLineAsTail(snapshot, bounds, line, tasks, 'spt');
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
      const wholeLine = placeWholeLineAsTail(snapshot, bounds, line, tasks, 'spt');
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
    const anchor = preservedInitialAnchor(initialScheduled);
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
    const result = evaluateLineWithFixedBoundaries(
      snapshot,
      bounds,
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
    if (result.termination !== 'completed') termination = result.termination;
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
  mode: Extract<FragmentMode, 'due-date-first' | 'min-changeover' | 'throughput'> = 'due-date-first',
): CandidateResult {
  requireDueDateBounds(bounds);
  const started = bounds.clock();
  const plant = bounds.setup.plant;
  const definition = bounds.setup.definition;
  const byLine = new Map<string, NimbusTask[]>();
  for (const task of snapshot.tasks) {
    const taskPlant = resolveTaskPlant(task, snapshot);
    const line = String(task.MACHINE ?? '');
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
  const score = [0, 0, 0, 0, 0, 0, 0];

  for (const [line, tasks] of [...byLine.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    // Part 2b: a fresh per-line budget so one large line's search can never
    // exhaust the iteration cap for every other line on the plant.
    const budget: SearchBudget = { remainingIterations: bounds.iterationCap };
    if (!definition || definition.plant !== plant) {
      // Part 1e: no setup definition at all means setup-awareness cannot run
      // for this line, but the line is never frozen — free orders still get
      // a policy/due-ordered tail placement around any fixed orders.
      const wholeLine = placeWholeLineAsTail(snapshot, bounds, line, tasks, mode);
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
      const wholeLine = placeWholeLineAsTail(snapshot, bounds, line, tasks, mode);
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
    const anchor = preservedInitialAnchor(initialScheduled);
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

    const result = evaluateLineWithFixedBoundaries(
      snapshot,
      bounds,
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
    if (result.termination !== 'completed') termination = result.termination;
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

function scheduledEndMinutes(task: Readonly<NimbusTask>): number | null {
  const end = timestamp(task.end_date);
  return end ? Math.floor(end.getTime() / (60 * 1000)) : null;
}

function lateOrderFacts(tasks: ReadonlyArray<NimbusTask>): Map<string, { late: boolean; end: number | null }> {
  const facts = new Map<string, { late: boolean; end: number | null }>();
  for (const task of tasks) {
    const end = scheduledEndMinutes(task);
    const due = dueTimestamp(task);
    facts.set(taskId(task), { late: end !== null && Number.isFinite(due) && end * 60 * 1000 > due, end });
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
  // Part 2a: the baseline pass only gets half of whatever wall-clock remains
  // right now. The candidate pass runs against the caller's own unmodified
  // `bounds.deadline` — i.e. everything left in the original budget — rather
  // than splitting the same window twice.
  const now = bounds.clock();
  const remainingMs = Math.max(0, bounds.deadline - now);
  const baseline = evaluateDueDateFirst(snapshot, { ...bounds, deadline: now + remainingMs / 2 });
  const candidate = evaluateDueDateFirst(snapshot, { ...bounds, deadline: bounds.deadline }, 'min-changeover');
  const before = lateOrderFacts(snapshot.tasks);
  const afterTasks = applyPatchesToSnapshot(snapshot.tasks, candidate.patches);
  const after = lateOrderFacts(afterTasks);
  const beforeLate = [...before.values()].filter(fact => fact.late).length;
  const afterLate = [...after.values()].filter(fact => fact.late).length;
  const newlyLate = [...after.entries()].filter(([id, fact]) => fact.late && !before.get(id)?.late);
  const savings = Math.max(0, (baseline.score[5] ?? 0) - (candidate.score[5] ?? 0));

  // Starvation guard: a candidate pass that hit its own deadline/iteration
  // cap and produced no patches (or strictly fewer patched lines than the
  // baseline) can never beat a non-empty baseline. This also covers a
  // candidate that terminates 'completed' with zero patches (F6) — that case
  // creates no new lateness and would otherwise fall through to the
  // min-changeover-due-safe return below, silently discarding a good baseline.
  const candidateStarved = (candidate.diagnostics.termination === 'deadline'
    || candidate.diagnostics.termination === 'iteration-cap')
    && (candidate.patches.length === 0 || candidate.unchangedLines.length > baseline.unchangedLines.length);
  if (baseline.patches.length > 0 && (candidateStarved || candidate.patches.length === 0)) {
    return withPolicyReason(
      baseline,
      'min-changeover-starved',
      'The min-changeover candidate pass was starved of search budget; kept the baseline schedule.',
    );
  }

  if (afterLate > beforeLate || newlyLate.length) {
    return withPolicyReason(
      baseline,
      'min-changeover-rejected-lateness',
      `Rejected ${savings} setup minutes saved because the alternative would create new lateness.`,
    );
  }
  return withPolicyReason(
    candidate,
    'min-changeover-due-safe',
    `Accepted ${savings} setup minutes saved without creating new lateness.`,
  );
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
  return selectThroughputCandidate(
    snapshot,
    evaluateDueDateFirst(snapshot, bounds),
    evaluateDueDateFirst(snapshot, bounds, 'throughput'),
    thresholds,
  );
}

/**
 * Evaluate against the existing placement algorithm, but with its reads bound
 * to `snapshot`.  The Engine adapter shares the legacy mode implementation;
 * it emits patches and never applies them while evaluating a candidate.
 */
export function evaluateSchedule(snapshot: Readonly<ScheduleSnapshot>, request: EvaluationRequest = {}): CandidateResult {
  const { mode = 'changeover', ...opts } = request;
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
