// optimization/engine.mjs — Engine (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split schedule-services.mts
// (3,544 lines) into 4 domain files, AND broke import cycle 1 between the
// former schedule-services.mts and optimization/setup-scheduler.mjs as part
// of the same move — see this phase's task brief Part B and
// optimization/scheduler-contract.mjs's header comment). Owns the optimizer
// (dispatch, auto-reflow), the detached candidate-evaluation machinery
// (`_candidateSnapshot`/the `source*` accessors below, which let the SAME
// Calendar capacity math answer either "against live Store" or "against one
// detached candidate snapshot" depending on whether a candidate run is in
// flight), setup-observation derivation, and the `evaluateSchedule` adapter
// that used to live in setup-scheduler.mts (see below).
//
// Cross-file notes (real couplings, not new ones — all three predate this
// phase, inside the single schedule-services.mts file, as sibling top-level
// declarations the file's own comments already flagged as forward-references
// safe only because nothing fires until well after module evaluation
// completes):
//   - `Calendar` (calendar/calendar-engine.mjs) is imported for placement
//     (`Engine.runAndApply`/`autoReflow`/`reconcileRuntimeSchedules` etc. call
//     Calendar directly). The REVERSE edge is real too: Calendar's own
//     capacity methods (`workWindow`/`nextAvailable`/`allocateRuntime`/etc.)
//     must honor the SAME detached-candidate snapshot Engine installs during
//     a candidate run, so they call this file's `sourceBlocks`/
//     `sourcePlantBlocks`/`sourceGetPlantForLine`/`sourceLineWorkHours`/
//     `sourcePlantWorkHours`/`reportSchedulerDiagnostic` (exported below) —
//     and `Calendar.allocateRuntime` also calls
//     `Engine.minProductiveSegmentMinutesFor`. This is a genuine two-way ESM
//     cycle between this file and calendar/calendar-engine.mjs; safe under
//     the same rule as every other cycle in this split — every cross-
//     reference is inside a method body invoked after both modules finish
//     loading, never at top-level evaluation. `RuntimeAllocation` and the
//     `placeWithSetup`/`PlaceWithSetupRequest`/`PlacementResult` re-exports
//     below exist for calendar/calendar-engine.mjs to consume through this
//     SAME cycle edge (see the note on those below) rather than opening a
//     second, independent cycle edge directly against
//     optimization/setup-scheduler.mjs.
//   - `Alerts`/`scheduleAlertsForPatches` (insights/services.mjs) are
//     imported because `Alerts.applyFix`'s auto-fix action calls
//     `Engine.splitOrderPolicyFor`/`schedulePatchFor`/`autoReflow`/
//     `runAndApply` (the REVERSE edge), and this file's own
//     `runAndApply`/`autoReflow`/`reconcileRuntimeSchedules` call
//     `Alerts.clearDismissed`/`scheduleRecompute`/`scheduleRecomputeLines`/
//     `scheduleAlertsForPatches`. A genuine two-way ESM cycle between this
//     file and insights/services.mjs; safe under the same rule.
//   - `deriveSetupObservation`/`SetupObservation` are consumed by
//     insights/services.mjs's `Compute._snap`/`Alerts`/`Utilization` (a
//     one-directional edge — insights/services.mjs imports from here, this
//     file never imports insights/services.mjs for this).
//
// This whole `optimization/setup-scheduler.mjs` import block (the 4 pure
// evaluators, `placeWithSetup`, `SETUP_AWARE_CONVERGENCE_WINDOW`, and the 9
// types below) moves here with `Engine` per this phase's brief Part B step 1
// — but `placeWithSetup`/`PlaceWithSetupRequest`/`PlacementResult` are
// actually consumed only by `Calendar.placeWithSetup`
// (calendar/calendar-engine.mjs), not by anything in this file; they are
// re-exported below so calendar/calendar-engine.mjs can pull them through
// the cycle edge this file already has with it, rather than opening a
// second cycle edge straight into optimization/setup-scheduler.mjs. Likewise
// `RuntimeAllocation` (this file, per the brief's line-range table) is
// re-exported for the same reason: its only real consumer is
// `Calendar.allocateRuntime`. `EvaluationRequest` is an additional type this
// file's `evaluateSchedule` adapter needs that the brief's original 8-type
// list did not include (the adapter used to live IN setup-scheduler.mts, so
// it referenced this locally-defined type without an import).
import { Config, Util, ErrorLog, PerfMonitor, Toast, Modal } from '../platform/foundation.mjs';
import { Store, UndoStack } from '../platform/store.mjs';
import { Runtime } from '../routing/runtime-client.mjs';
import { Calendar, candidateDefaultWorkHours } from '../calendar/calendar-engine.mjs';
import { CalendarSync } from '../calendar/calendar-sync.mjs';
import { Persistence } from '../scheduling/persistence.mjs';
import { Alerts, scheduleAlertsForPatches, taskCarriesTool, taskCarriesDistribution } from '../insights/services.mjs';
import {
  placeWithSetup as placeWithSetupPure,
  evaluateDueDateFirst as evaluateDueDateFirstPure,
  evaluateMinChangeover as evaluateMinChangeoverPure,
  evaluateSptWithSetup as evaluateSptWithSetupPure,
  evaluateThroughput as evaluateThroughputPure,
  fillPlanningGaps,
  attachDetachedValidationContext,
  SETUP_AWARE_CONVERGENCE_WINDOW,
  resolveTaskPlant,
  dueInstant,
} from './setup-scheduler.mjs';
import { resolveSetup, stateForOrder } from '../setup/setup-domain.mjs';
import type {
  CandidateDiagnostic,
  CandidateResult,
  DueDateFirstBounds,
  SetupPolicyThresholds,
  PlacementResult,
  PlaceWithSetupRequest,
  SchedulePatch,
  ScheduleSnapshot,
  EvaluationRequest,
} from './setup-scheduler.mjs';
import type { NimbusTask, NimbusBlock, NimbusPlantBlock, WorkHours, NimbusLineSetting, NimbusMasterData, ConstraintConfig, OptimizerMode, OrderScheduleSegment, SplitOrderPolicy, SetupSnapshot, SetupStateKey } from '../platform/types.mjs';
import { MIN_PRODUCTIVE_SEGMENT_MINUTES } from './scheduler-contract.mjs';
import type { RemoveBacklogResult, RemoveBacklogDiagnostics } from './scheduler-contract.mjs';
import type { SerializedOptimizerValidation } from './optimizer-worker-contract.mjs';

// -- Local type declarations (Phase 3 conversion; scoped to this file) ------
// Structurally identical to the copy in calendar/calendar-engine.mjs and
// insights/services.mjs (and platform/store.mjs's exported version) — same
// "duplicate this trivial 3-line type per file" convention already
// established between schedule-state.mts and schedule-services.mjs before
// this split.
interface CalendarEntry {
  workHours: WorkHours;
}

export { MIN_PRODUCTIVE_SEGMENT_MINUTES };
// Re-exported for compatibility — anything importing `RemoveBacklogResult`
// from this file (rather than from optimization/scheduler-contract.mjs
// directly) keeps working. Nothing in this codebase does so today (checked
// before adding this), but the brief's Part B step 1 asks for it explicitly.
export type { RemoveBacklogResult };
// Re-exported so calendar/calendar-engine.mjs's Calendar.placeWithSetup can
// consume these through the cycle edge this file already has with it — see
// this file's header comment.
export { placeWithSetupPure };
export type { PlaceWithSetupRequest, PlacementResult };

export type RuntimeAllocation =
  | { kind: 'allocated'; start: Date; end: Date; scheduleSegments: OrderScheduleSegment[] }
  | { kind: 'unavailable' | 'exhausted' };

/** Why a finish-anchored placement was refused (nothing is placed, the caller reports it). */
export type FinishRefusal = 'overlong_never' | 'run_time_zero' | 'plant_no_timezone' | 'no_operating_window';

/** Result of `Engine.finishAnchoredPatchFor`. `placed.changes` always carries BOTH edges (and the
 *  segments, empty for a continuous bar). `finishMoved` is true when the finish had to move (the walk's own
 *  answer, or a reversal forward from now); `reversed` marks the reversal. `reached_now` is returned only
 *  when the caller asked to defer reversals (`opts.deferReversal`) so it can batch them per line. */
export type FinishAnchoredResult =
  | { kind: 'placed'; changes: Partial<NimbusTask>; finishMoved: boolean;
      moveReason?: 'closed_finish' | 'no_slot_at_finish' | 'min_piece' | 'blackout'; reversed?: boolean }
  | { kind: 'reached_now' }
  | { kind: 'refuse'; reason: FinishRefusal };

export interface FinishAnchoredOptions {
  /** Return `{kind:'reached_now'}` unresolved instead of reversing forward from now. */
  deferReversal?: boolean;
  /** Minutes of changeover to reserve immediately before the earliest productive piece, in the same operating
   *  fragment (OQ2 V1). The reconcile fills it from the setup domain; a manual drop leaves it 0 (OQ40). */
  setupMinutes?: number;
}

/** One order in a forward sequence: `notBefore` is the earliest it may start (the cursor still wins when later). */
export interface ForwardSequenceItem { task: NimbusTask; notBefore?: Date }

/** What `Engine.placeForwardSequence` placed, and why it stopped when it did not place everything. */
export interface ForwardSequenceResult<T extends ForwardSequenceItem> {
  placed: Array<{ item: T; start: Date; end: Date; scheduleSegments?: OrderScheduleSegment[] }>;
  /** Items skipped for a missing or non-positive run time. */
  invalidRuntime: T[];
  /** Items longer than any single working window under the contiguous policy. They are NOT placed (OQ50 c: no
   *  continuous elapsed bar on a forward path) and do not advance the cursor; the caller sends them to Needs
   *  Planning with reason `overlong_never`. */
  overlong: T[];
  /** The item the calendar could not place; the walk ends there. */
  failure: { item: T; reason: 'no-operating-interval' | 'search-exhausted' } | null;
}

export interface ReconcileOptions {
  /** `'cutover'` (Task 4.2) tags every reversal `detail: 'cutover'`; `'undo'` marks the re-derivation after an undo. */
  reason?: string;
  /** Restrict the pass to these task ids and bypass the unsaved-edit skip for them. The undo path passes the
   *  rows it just restored: they are dirty by construction, and their start must still follow the run time. */
  ids?: ReadonlySet<string>;
}

/** Options for a manual (planner) placement. */
export interface ManualPlacementOptions {
  /** The planner confirmed an overtime placement for a firmed order (OQ63). */
  confirmedOvertime?: boolean;
  /** A run-time, machine or version edit: a RUNNING order holds its START and re-derives its finish forward
   *  (OQ3) instead of holding the finish. Never set for a drop, a typed finish or the Override dialog. */
  holdStartIfRunning?: boolean;
  /** Batch callers (Push +1 hour): do not toast a finish that cannot be held; the caller reports one summary. */
  quiet?: boolean;
}

/** Why the last manual placement returned null (read by callers right after the call). */
export type ManualRefusal = FinishRefusal | 'finish_cannot_hold' | 'needs_overtime_confirm';

/** Deliberately loose (see this plan's "Why Engine gets looser typing" section):
 *  cmp's params are `any` (not `T`) so a heterogeneous array of terms with
 *  different key types (number for runHours, string for the padded
 *  rank|value priority keys / FORM_SIZE / MATERIAL_NUMBER) can share one array
 *  type without fighting strict-mode function-parameter variance. Precision
 *  here is intentionally deferred to a future Engine-focused phase. */
interface SortTerm {
  get(t: NimbusTask): number | string;
  cmp(a: any, b: any): number;
}

/** Capture the complete read model for one optimizer candidate.  Every member
 * is cloned at the Store boundary so candidate scheduling cannot hold a live
 * reference that a later Store mutation could alter while it is evaluating.
 *
 * `plant` is optional: when the caller already knows which plant it is about
 * to evaluate, calendars are cloned only for machine lines belonging to that
 * plant. The line set is resolved from the cloned task, line-settings, and
 * master-data snapshots with the same resolver used by the detached
 * scheduler, including a task's direct plant value for reused or mismapped
 * machine codes. Every other member stays whole because downstream planning
 * and apply validation depend on the complete snapshot. Omitting `plant`
 * preserves the unscoped session snapshot. */
export function snapshotSchedule(plant?: string): ScheduleSnapshot {
  const _pmT0s = performance.now();
  try {
    const tasks = plant
      ? structuredClone(Store.tasksArr.filter(task => resolveTaskPlant(task, { lineSettings: Store.lineSettings, masterData: Store.masterData }) === plant))
      : structuredClone(Store.tasksArr);
    const lineSettings = structuredClone(Store.lineSettings);
    const masterData = structuredClone(Store.masterData);
    // Capture calendars from the actual scoped task lines using the same
    // task-level resolver as the detached scheduler. A reused machine code
    // may have a direct task plant that differs from line metadata.
    const scopedLines = plant
      ? new Set(tasks
        .filter(task => resolveTaskPlant(task, { lineSettings, masterData }) === plant)
        .map(task => String(task.MACHINE ?? ''))
        .filter(Boolean))
      : null;
    const sourceCalendars = scopedLines
      ? Object.fromEntries(Object.entries(Store.calendars).filter(([line]) => scopedLines.has(line)))
      : Store.calendars;
    return {
      tasks,
      firmedIds: Array.from(Store.firmedIds), // manual firms only — ECC/frozen derivation joins at the setup-aware fold; do not union here.
      selectedPlant: Store.selectedPlant,
      // Every consumer (setup-scheduler lineBlocksFor/overlapBlocks, Calendar._indexBlocks,
      // nextAvailable) skips blocks of another plant, so a plant-scoped snapshot clones
      // only that plant's (and un-stamped) blocks.
      blocks: structuredClone(plant ? Store.blocks.filter(block => !block.plant || block.plant === plant) : Store.blocks),
      plantBlocks: structuredClone(plant ? Store.plantBlocks.filter(block => !block.plant || block.plant === plant) : Store.plantBlocks),
      calendars: structuredClone(sourceCalendars),
      plants: structuredClone(Store.plants),
      lineSettings,
      masterData,
      priorityRankMaps: structuredClone(Store.priorityRankMaps),
      setupSnapshot: structuredClone(Store.setupSnapshot),
      frozenHorizonEnd: Store.frozenHorizonEnd ? new Date(Store.frozenHorizonEnd) : null,
      readModelVersion: String(Store.rev()),
    };
  } finally {
    PerfMonitor.record('Optimize.snapshotSchedule', performance.now() - _pmT0s);
  }
}

/** The only bridge from a detached candidate into live schedule state.  Keep
 * this as one Store.updateMany call: candidates never publish intermediate
 * task, alert, autosave, or Timeline changes. */
export function applySchedulePatches(patches: ReadonlyArray<SchedulePatch>): void {
  if (patches.length) Store.updateMany(Array.from(patches), 'engine');
}

/** The setup-aware evaluators' single notion of "immovable" for a run: the
 * caller's own firmed set (manual `Store.isFirmed` ids, gated by
 * `respectFirmed`), folded with every running (in-progress) and frozen-horizon
 * task. Running and frozen fold in regardless of `respectFirmed`: a running
 * order never moves, and the frozen horizon is a scheduling-window constraint.
 * SAP's firm flag (`ecc_firmed`) is display-only and never locks anything.
 * Pure and run-local: never written back to Store. */
export function effectiveFirmedIdSet(
  tasks: ReadonlyArray<NimbusTask>,
  baseFirmedIds: ReadonlySet<string> | ReadonlyArray<string>,
  runNow: Date,
  respectFirmed: boolean,
  frozenHorizonEnd?: Date | null,
): Set<string> {
  const ids = new Set<string>(respectFirmed ? Array.from(baseFirmedIds, String) : []);
  const frozenEnd = frozenHorizonEnd === undefined ? Engine.frozenHorizonEnd() : frozenHorizonEnd;
  for (const t of tasks) {
    // G-0.25: a row carrying an approved placement exception ('overtime' / 'overlong') is fixed exactly like a
    // firmed row, whatever the "Respect firmed" toggle says.
    if (t.placement_exception || Engine.isInProgress(t, runNow) || Engine.isFrozenHorizon(t, runNow, frozenEnd)) ids.add(String(t.id));
  }
  return ids;
}

/** Resolved setup is observation data for capacity/alerts, never a task or a
 * persisted link.  This is the sole main-thread projection sent to the core
 * and worker; they must not receive raw setup rows or re-resolve transitions. */
export interface SetupComputeInterval {
  line: string;
  scope: string;
  predecessorOrderId: string | null;
  successorOrderId: string;
  start: Date;
  end: Date;
  requiredMinutes: number;
  availableMinutes: number;
}

export interface SetupComputeDiagnostic {
  type: 'setup-uncovered' | 'initial-state-unknown' | 'current-state-diverged' | 'override-inactive'
    | 'predecessor-state-unknown' | 'successor-state-unknown' | 'setup-no-change';
  line: string;
  scope: string;
  pairKey?: string;
  predecessorOrderId?: string | null;
  successorOrderId?: string;
  time?: Date;
  message?: string;
  // Populated only by the 'setup-no-change' diagnostic below (D4): an
  // identical-signature, zero-minute, covered transition that never had a
  // matrix row or override consulted. Carried here so a caller (Inspector,
  // tests) that reads observation.diagnostics directly — rather than
  // re-resolving through resolveSetup() — still sees the full fact set.
  // Never populated for any other diagnostic type.
  predecessorState?: SetupStateKey | null;
  successorState?: SetupStateKey | null;
  requiredMinutes?: number;
  effectiveMinutes?: number;
  standardMinutes?: number;
  source?: string;
}

export interface SetupObservation {
  intervals: SetupComputeInterval[];
  diagnostics: SetupComputeDiagnostic[];
}

interface SetupAvailabilityContext {
  calendars: Record<string, CalendarEntry>;
  plants: Record<string, CalendarEntry>;
  lineSettings: Record<string, NimbusLineSetting>;
  masterData: NimbusMasterData | null;
  blocks: ReadonlyArray<NimbusBlock>;
  plantBlocks: ReadonlyArray<NimbusPlantBlock>;
}

function setupStateKey(state: SetupStateKey | null): string {
  return state ? JSON.stringify(state.map(({ fieldKey, value }) => [fieldKey, value])) : 'unknown';
}

function setupOrderIntervals(task: NimbusTask): Array<{ start: Date; end: Date }> {
  return globalThis.NimbusComputeCore!.scheduleIntervals(task).map(interval => ({ start: interval.start, end: interval.end }));
}

function observedAt(value: unknown): Date | null {
  const date = value ? new Date(String(value)) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

/** Match the core's ensureCalendar/ensurePlant fallback without mutating Store-owned maps. */
function setupDefaultWorkHours(): WorkHours {
  const core = globalThis.NimbusComputeCore!;
  const workHours: WorkHours = {};
  for (let day = 0; day < 7; day++) {
    workHours[day] = core.WEEKEND_OFF && (day === 0 || day === 6) ? null : [...core.DEFAULT_SHIFT];
  }
  return workHours;
}

/** One line's order intervals, built once per line: starts ascending with a running
 *  maximum of the interval ends. setupAvailabilityMinutes used to rescan (and re-derive the
 *  intervals of) every order on the line for each setup bar, O(n^2) per recompute. */
interface LineIntervalIndex {
  starts: number[];
  prefixMaxEnd: number[];
}

function buildLineIntervalIndex(orders: ReadonlyArray<{ task: NimbusTask }>): LineIntervalIndex {
  const flat: Array<{ start: number; end: number }> = [];
  for (const order of orders) {
    for (const interval of setupOrderIntervals(order.task)) flat.push({ start: interval.start.getTime(), end: interval.end.getTime() });
  }
  flat.sort((a, b) => a.start - b.start);
  const starts: number[] = [];
  const prefixMaxEnd: number[] = [];
  let running = -Infinity;
  for (const interval of flat) {
    running = Math.max(running, interval.end);
    starts.push(interval.start);
    prefixMaxEnd.push(running);
  }
  return { starts, prefixMaxEnd };
}

/** How many days back the free-time scan follows touching windows (the predecessor's end usually stops it sooner). */
const SETUP_AVAILABILITY_MERGE_DAYS = 14;

function setupAvailabilityMinutes(
  context: SetupAvailabilityContext | undefined,
  line: string,
  plant: string,
  end: Date,
  index: LineIntervalIndex,
  fallbackStart: Date | null,
): number {
  if (!context) return fallbackStart ? Math.max(0, (end.getTime() - fallbackStart.getTime()) / (60 * 1000)) : 0;
  // Setup observations are already scoped by the setup snapshot plant. A line
  // code may be reused at another plant, so master-data lookup is unsafe here.
  const mappedPlant = plant;
  const probe = new Date(end.getTime() - 1);
  const lineHours = context.calendars[line]?.workHours ?? setupDefaultWorkHours();
  const plantHours = context.plants[mappedPlant]?.workHours ?? setupDefaultWorkHours();
  /** The line and plant working windows intersected for the day holding `day`, or null when closed. */
  const windowOf = (day: Date): readonly [Date, Date] | null => {
    const lineWindow = globalThis.NimbusComputeCore!._dayWindow(lineHours, day);
    if (!lineWindow) return null;
    const plantWindow = globalThis.NimbusComputeCore!._dayWindow(plantHours, day);
    if (!plantWindow) return null;
    const both = [
      new Date(Math.max(lineWindow[0].getTime(), plantWindow[0].getTime())),
      new Date(Math.min(lineWindow[1].getTime(), plantWindow[1].getTime())),
    ] as const;
    return both[0] < both[1] ? both : null;
  };
  const window = windowOf(probe);
  if (!window) return 0;
  if (end > window[1] || end <= window[0]) return 0;
  let lower = window[0].getTime();
  // Touching windows merge across midnight (a 24/7 line is one continuous interval, OQ47), so the free time
  // before this window's opening continues back through every window that ends exactly where this one opens.
  for (let back = 1; back <= SETUP_AVAILABILITY_MERGE_DAYS; back++) {
    const earlier = windowOf(new Date(probe.getFullYear(), probe.getMonth(), probe.getDate() - back, 12));
    if (!earlier || earlier[1].getTime() !== lower) break;
    lower = earlier[0].getTime();
  }
  const applyBlock = (block: NimbusBlock | NimbusPlantBlock): boolean => {
    const start = globalThis.NimbusComputeCore!.parseDate(block.start);
    const blockEnd = globalThis.NimbusComputeCore!.parseDate(block.end);
    if (!start || !blockEnd || start >= end || blockEnd <= new Date(lower)) return false;
    if (blockEnd >= end) return true;
    lower = Math.max(lower, blockEnd.getTime());
    return false;
  };
  for (const block of context.blocks) {
    if (block.plant && block.plant !== mappedPlant) continue;
    if (block.line && block.line !== line) continue;
    if (applyBlock(block)) return 0;
  }
  for (const block of context.plantBlocks) {
    if (block.plant && block.plant !== mappedPlant) continue;
    if (applyBlock(block)) return 0;
  }
  // Intervals starting before `end` are the candidates (the successor's own intervals start at
  // or after `end`, since the setup bar ends where the successor begins, so they never qualify
  // and need no explicit exclusion). If any of them reaches `end`, the setup point is covered
  // by production: 0 available. Otherwise every candidate ends before `end` and the latest of
  // them (or the window/blackout floor) bounds the free time: the prefix maximum.
  let lo = 0, hi = index.starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (index.starts[mid] < end.getTime()) lo = mid + 1; else hi = mid;
  }
  if (lo > 0) {
    const latestEnd = index.prefixMaxEnd[lo - 1];
    if (latestEnd >= end.getTime()) return 0;
    lower = Math.max(lower, latestEnd);
  }
  return Math.max(0, (end.getTime() - lower) / (60 * 1000));
}

/**
 * Resolve scheduled setup occurrences exactly once, before either compute path
 * runs. This pure projection neither mutates Store nor invokes Engine; both
 * core callers receive its output as opaque interval/diagnostic facts.
 */
export function deriveSetupObservation(
  setup: SetupSnapshot | null | undefined,
  tasks: ReadonlyArray<NimbusTask>,
  scopedLines?: ReadonlySet<string>,
  availability?: SetupAvailabilityContext,
): SetupObservation {
  const observation: SetupObservation = { intervals: [], diagnostics: [] };
  const definition = setup?.definition;
  // Activation controls setup-aware placement only.  The existing schedule
  // must continue to expose its setup bars and diagnostics while activation
  // is deliberately disabled for observation-only rollout.
  if (!setup || !definition) return observation;

  const stateForLine = new Map(setup.machine_states
    .filter(state => state.signature_version === definition.signature_version)
    .map(state => [state.machine, state]));
  const taskById = new Map(tasks.map(task => [String(task.id), task]));
  const byLine = new Map<string, Array<{ task: NimbusTask; start: Date; end: Date }>>();
  for (const task of tasks) {
    // A truthy-only PLANT check lets NULL/empty-PLANT orders leak into any
    // plant's chain, and `|| 'Unknown'` would chain every line-less order
    // together across plants/lines. A line code can be reused across plants
    // (db.reattribute_null_plant_orders deliberately leaves PLANT null when a
    // line code maps to >1 plant), so both PLANT and MACHINE must be
    // exact, non-empty matches — mirroring the optimizer's rule.
    const taskPlant = String(task.PLANT ?? task.plant ?? '');
    const line = String(task.MACHINE ?? '');
    if (!line || taskPlant !== setup.plant) continue;
    if (scopedLines && !scopedLines.has(line)) continue;
    const intervals = setupOrderIntervals(task);
    if (!intervals.length) continue;
    const first = intervals[0], last = intervals.at(-1)!;
    const list = byLine.get(line) || [];
    list.push({ task, start: first.start, end: last.end });
    byLine.set(line, list);
  }

  const lines = new Set(byLine.keys());
  for (const override of setup.overrides) {
    // Only add an override's line when it's either explicitly in scope, or it
    // already has loaded orders. Otherwise, on the (always) unscoped Timeline
    // path, EVERY active override's line gets pulled in — including lines
    // with zero loaded orders — producing override-inactive diagnostics with
    // time: undefined for lines outside the caller's scope.
    if (override.status === 'active' && (scopedLines?.has(override.machine) || byLine.has(override.machine))) lines.add(override.machine);
  }
  for (const line of lines) {
    const orders = byLine.get(line) || [];
    orders.sort((left, right) => (
      left.start.getTime() - right.start.getTime()
      || left.end.getTime() - right.end.getTime()
      || String(left.task.id).localeCompare(String(right.task.id))
    ));
    const scope = `${setup.plant}/${line}`;
    const lineIntervalIndex = availability ? buildLineIntervalIndex(orders) : { starts: [], prefixMaxEnd: [] };
    const resolvedEdges = new Set<string>();
    const assertedState = stateForLine.get(line);
    const observationTime = observedAt(assertedState?.observed_at);
    if (assertedState && observationTime) {
      const planned = orders.filter(order => order.end <= observationTime).at(-1);
      const plannedState = planned ? stateForOrder(planned.task, definition) : null;
      if (plannedState && setupStateKey(plannedState) !== setupStateKey(assertedState.state_key)) {
        observation.diagnostics.push({
          type: 'current-state-diverged', line, scope, successorOrderId: String(planned!.task.id), time: observationTime,
          message: `Asserted state on ${line} differs from the state planned by order ${Util.orderNumber(planned!.task)} at observation time.`,
        });
      }
    }
    let predecessorState = assertedState?.state_key || null;
    let predecessorOrderId: string | null = null;
    let predecessorEnd: Date | null = null;
    for (const order of orders) {
      const successorState = stateForOrder(order.task, definition);
      if (!predecessorState && predecessorOrderId === null) {
        // Genuinely the line's first order: no asserted line state and no
        // predecessor order exists to derive one from.
        observation.diagnostics.push({
          type: 'initial-state-unknown', line, scope, successorOrderId: String(order.task.id), time: order.start,
          message: `The setup state before order ${Util.orderNumber(order.task)} on ${line} is unknown.`,
        });
      } else if (!predecessorState) {
        // A real predecessor order exists but stateForOrder couldn't derive
        // its state (e.g. strict_blanks + a blank signature field). Do not
        // let this null propagate as "no predecessor" to every later order.
        observation.diagnostics.push({
          type: 'predecessor-state-unknown', line, scope, predecessorOrderId, successorOrderId: String(order.task.id), time: order.start,
          message: `The order before ${Util.orderNumber(order.task)} on ${line} (${Util.orderNumber(taskById.get(String(predecessorOrderId)))}) is missing the setup attributes needed to determine its state.`,
        });
      } else if (!successorState) {
        observation.diagnostics.push({
          type: 'successor-state-unknown', line, scope,
          pairKey: `${setupStateKey(predecessorState)}->unknown`, predecessorOrderId, successorOrderId: String(order.task.id), time: order.start,
          message: `The setup attributes needed to determine the state of order ${Util.orderNumber(order.task)} on ${line} are missing.`,
        });
      } else {
        const resolved = resolveSetup({
          definition, machine: line, predecessorState, successorState, predecessorOrderId, successorOrderId: String(order.task.id),
          plantRows: setup.plant_rows, machineRows: setup.machine_rows, overrides: setup.overrides,
        });
        if (!resolved.covered || resolved.effectiveMin == null) {
          observation.diagnostics.push({
            type: 'setup-uncovered', line, scope,
            pairKey: `${setupStateKey(predecessorState)}->${setupStateKey(successorState)}`,
            predecessorOrderId, successorOrderId: String(order.task.id), time: order.start,
          });
        } else if (resolved.effectiveMin > 0) {
          resolvedEdges.add(`${predecessorOrderId ?? 'initial'}|${String(order.task.id)}`);
          const end = new Date(order.start);
          const start = new Date(end.getTime() - resolved.effectiveMin * 60 * 1000);
          const availableMinutes = setupAvailabilityMinutes(
            availability, line, setup.plant, end, lineIntervalIndex, predecessorEnd,
          );
          observation.intervals.push({
            line, scope, predecessorOrderId, successorOrderId: String(order.task.id), start, end,
            requiredMinutes: resolved.effectiveMin, availableMinutes,
          });
        } else {
          resolvedEdges.add(`${predecessorOrderId ?? 'initial'}|${String(order.task.id)}`);
          // D4: an identical-signature, zero-minute transition (setup-domain's
          // resolveSetup 'implicit-zero' branch — no matrix row or override was
          // consulted) previously produced neither an interval nor a
          // diagnostic, so the Inspector's hasObservedEntry gate found nothing
          // and blanked every detail row to '—'. Push a non-alerting
          // diagnostic here (never an interval — no bar is drawn, nothing
          // consumes capacity) so the detail card populates honestly. A
          // matrix-row- or override-sourced zero-minute transition (source
          // 'line'/'plant'/'occurrence') is a genuinely different, already-
          // correctly-silent case and must NOT take this branch — only the
          // no-matrix-consulted identical-state case does.
          if (resolved.source === 'implicit-zero') {
            observation.diagnostics.push({
              type: 'setup-no-change', line, scope,
              predecessorOrderId, successorOrderId: String(order.task.id), time: order.start,
              predecessorState, successorState,
              requiredMinutes: 0, effectiveMinutes: 0, standardMinutes: 0,
              source: resolved.source,
            });
          }
        }
      }
      predecessorState = successorState;
      predecessorOrderId = String(order.task.id);
      predecessorEnd = order.end;
    }

    for (const override of setup.overrides.filter(override => override.status === 'active' && override.machine === line)) {
      const key = `${override.predecessor_order_id ?? 'initial'}|${override.successor_order_id}`;
      if (!resolvedEdges.has(key)) observation.diagnostics.push({
        type: 'override-inactive', line, scope, predecessorOrderId: override.predecessor_order_id,
        successorOrderId: override.successor_order_id, time: orders[0]?.start,
        message: `Active setup override from ${override.predecessor_order_id == null ? 'the initial state' : `order ${Util.orderNumber(taskById.get(String(override.predecessor_order_id)))}`} to order ${Util.orderNumber(taskById.get(String(override.successor_order_id)))} on ${line} no longer matches the scheduled adjacency.`,
      });
    }
  }
  return observation;
}

// One synchronous candidate evaluation may temporarily select this immutable,
// deep-cloned read model.  It is deliberately module-private: no Store field is
// swapped, no listener can observe it, and it is cleared in finally{} before
// control returns to the preview.  The existing placement algorithms below use
// these accessors so the migration does not silently rewrite their behavior.
let _candidateSnapshot: ScheduleSnapshot | null = null;
let _candidateDiagnostics: CandidateDiagnostic[] | null = null;

/** Search-safety limits for the setup-aware evaluators (setup-scheduler.mjs).
 *  Stage 0's originally-planned perf-measurement gate (docs/changeover_matrix_
 *  stage_2.md) was never run, so these are hardcoded rather than measured —
 *  chosen to bias toward the fast/greedy path and a safe bail-out over
 *  exactness. Revisit once real per-plant timing data exists. */
const SETUP_AWARE_EXACT_SEARCH_THRESHOLD = 8;
const SETUP_AWARE_ITERATION_CAP = 20000;
// Exported (Phase 2, Pkg D) so schedule-workbench.mts's optimizer preview can
// compute its own explicit `deadlineAt` for both the primary run and the
// deferred Plan B comparison run (a fraction of this budget) instead of
// duplicating the number.
export const SETUP_AWARE_DEADLINE_MS = 5000;

function parseDateOnlyAsWallClock(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

/** Project an absolute instant into the naive wall-clock Date convention used
 * by Calendar and the persisted schedule. Date-only/naive date-time inputs
 * are already wall-clock values and are handled without this projection. */
function plantWallClockFromInstant(timezone: string | null | undefined, instant: Date): Date | null {
  // The implementation lives in the compute core (shared with Store.plantNow and the worker).
  // Reads the global at call time: Node tests must set globalThis.NimbusComputeCore (see engine.test.mjs).
  return globalThis.NimbusComputeCore!.plantWallClockFromInstant(timezone, instant);
}

function hasExplicitDate(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function normalizeOptimizerDate(
  value: unknown,
  timezone: string | null | undefined,
  absolute = false,
): Date | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return absolute ? plantWallClockFromInstant(timezone, value) : new Date(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const instant = new Date(value);
    return absolute ? plantWallClockFromInstant(timezone, instant) : instant;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const dateOnly = parseDateOnlyAsWallClock(text);
  if (dateOnly) return dateOnly;
  const instant = new Date(text);
  if (!Number.isFinite(instant.getTime())) return null;
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  // A naive date-time follows the same plant wall-clock convention as a
  // date-only value. Only an explicit zone (or a Date/number supplied as an
  // absolute instant above) is projected through the plant timezone.
  return hasTimezone ? plantWallClockFromInstant(timezone, instant) : instant;
}

function addLocalDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function finiteDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value) : null;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
}

interface BacklogRunDates {
  runAt: Date;
  now: Date;
  from: Date;
  to: Date;
}

function normalizeBacklogRunDates(plant: string, opts: Record<string, unknown>): BacklogRunDates {
  const timezone = sourceMasterData()?.plants?.find(row => row.plant === plant)?.timezone;
  if (typeof timezone !== 'string' || !timezone.trim()) {
    throw new Error(`Remove Backlog requires a configured IANA timezone for plant ${plant}`);
  }
  const parseAbsolute = (value: unknown): Date | null => {
    if (!hasExplicitDate(value)) return null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value) : null;
    if (typeof value === 'number' || typeof value === 'string') {
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed : null;
    }
    return null;
  };
  const runAt = parseAbsolute(opts.runAt) ?? (hasExplicitDate(opts.runAt) ? null : Store.serverNow());
  if (!runAt) throw new Error('Remove Backlog requires a valid runAt timestamp');
  const now = Engine._plantWallNow(timezone, runAt);
  const from = hasExplicitDate(opts.startDate)
    ? normalizeOptimizerDate(opts.startDate, timezone)
    : new Date(now);
  const to = hasExplicitDate(opts.endDate)
    ? normalizeOptimizerDate(opts.endDate, timezone)
    : addLocalDays(now, 35);
  if (!from || !to || to <= from) throw new Error('Remove Backlog requires a valid From and To date range');
  return { runAt, now, from, to };
}

/** Reproduce Remove Backlog's immutable selection boundary for detached Apply
 * validation. The mutable set is exactly the positive-runtime existing
 * intervals whose snapshot start is in [from, to); every other valid interval
 * on the selected line is occupancy only, so a moved backlog order cannot
 * overlap it without admitting that collision during final validation. Rows
 * skipped by Remove Backlog for invalid runtime remain boundary-only and never
 * receive a fabricated disposition or clearing patch. */
function backlogValidationScope(
  snapshot: Readonly<ScheduleSnapshot>, plant: string, lines: ReadonlySet<string> | null,
  from: Date, to: Date,
): { scopeTaskIds: string[]; boundaryTaskIds: string[] } {
  const candidates = snapshot.tasks.filter(task => {
    const line = String(task.MACHINE ?? 'Unknown');
    return resolveTaskPlant(task, snapshot) === plant
      && (!lines || lines.has(line))
      && !snapshot.lineSettings[line]?.excludeFromOpt;
  });
  const valid = candidates.flatMap(task => {
    const start = finiteDate(task.start_date);
    const end = finiteDate(task.end_date);
    const runtimeHours = Number(task.RUN_TIME);
    return start && end && end > start ? [{ task, start, usableRuntime: Number.isFinite(runtimeHours) && runtimeHours > 0 }] : [];
  });
  const selected = new Set(valid
    .filter(({ start, usableRuntime }) => usableRuntime && start >= from && start < to)
    .map(({ task }) => String(task.id)));
  return {
    scopeTaskIds: valid.filter(({ task }) => selected.has(String(task.id))).map(({ task }) => String(task.id)),
    boundaryTaskIds: valid.filter(({ task }) => !selected.has(String(task.id))).map(({ task }) => String(task.id)),
  };
}

/** Keep candidate-only warnings/errors out of ErrorLog's IndexedDB/backend path.
 * Live optimizer and repair runs retain their existing ErrorLog behavior. */
export function reportSchedulerDiagnostic(
  level: CandidateDiagnostic['level'],
  scope: string,
  code: string,
  message: string,
  context?: Readonly<Record<string, unknown>>,
): void {
  if (_candidateDiagnostics) {
    _candidateDiagnostics.push({ level, scope, code, message, context: context ?? {} });
    return;
  }
  if (level === 'error') ErrorLog.error(scope, message, context);
  else ErrorLog.warn(scope, message, context);
}

function sourceTasks(): ReadonlyArray<NimbusTask> { return _candidateSnapshot?.tasks ?? Store.tasksArr; }
export function sourceBlocks(): ReadonlyArray<NimbusBlock> { return _candidateSnapshot?.blocks ?? Store.blocks; }
export function sourcePlantBlocks(): ReadonlyArray<NimbusPlantBlock> { return _candidateSnapshot?.plantBlocks ?? Store.plantBlocks; }
function sourceLineSettings(): Readonly<Record<string, NimbusLineSetting>> { return _candidateSnapshot?.lineSettings ?? Store.lineSettings; }
function sourceMasterData(): NimbusMasterData | null { return _candidateSnapshot?.masterData ?? Store.masterData; }
function sourcePriorityRankMaps() { return _candidateSnapshot?.priorityRankMaps ?? Store.priorityRankMaps; }
function sourceSelectedPlant(): string | null { return _candidateSnapshot?.selectedPlant ?? Store.selectedPlant; }

// Last-resort ownership from the snapshot's own tasks (mirrors Store.getPlantForLine's final
// fallback, and compute-core's), memoized per snapshot so the hot path stays O(1).
const _snapshotTaskPlants = new WeakMap<object, Map<string, string>>();
function snapshotTaskPlant(snapshot: Readonly<ScheduleSnapshot>, line: string): string | null {
  let m = _snapshotTaskPlants.get(snapshot);
  if (!m) {
    m = new Map();
    for (const t of snapshot.tasks) if (t.MACHINE && t.PLANT && !m.has(t.MACHINE)) m.set(t.MACHINE, t.PLANT);
    _snapshotTaskPlants.set(snapshot, m);
  }
  return m.get(line) ?? null;
}

export function sourceGetPlantForLine(line: string): string | null {
  if (!_candidateSnapshot) return Store.getPlantForLine(line);
  return _candidateSnapshot.lineSettings[line]?.plant
    ?? _candidateSnapshot.masterData?.lines.find(row => row.machine === line)?.plant
    ?? snapshotTaskPlant(_candidateSnapshot, line);
}

function sourceTasksByPlant(plant: string | null): NimbusTask[] {
  if (!_candidateSnapshot) return Store.tasksByPlant(plant);
  if (!plant) return [];
  return _candidateSnapshot.tasks.filter(task => resolveTaskPlant(task, _candidateSnapshot!) === plant);
}

function sourceTask(id: string): NimbusTask | undefined {
  return _candidateSnapshot ? _candidateSnapshot.tasks.find(task => String(task.id) === String(id)) : Store.tasks[id];
}

function isFirmedIdSet(firmed: readonly string[] | ReadonlySet<string>): firmed is ReadonlySet<string> {
  return !Array.isArray(firmed);
}

function sourceIsFirmed(id: string | number): boolean {
  if (!_candidateSnapshot) return Store.isFirmed(id);
  const firmed = _candidateSnapshot.firmedIds;
  if (isFirmedIdSet(firmed)) return firmed.has(String(id));
  return firmed.map(String).includes(String(id));
}



export function sourceLineWorkHours(line: string): WorkHours {
  if (!_candidateSnapshot) {
    Store.ensureCalendar(line);
    return Store.calendars[line].workHours;
  }
  return _candidateSnapshot.calendars[line]?.workHours ?? candidateDefaultWorkHours();
}

/** The order's SAP due as an instant for the date-window bounds below: a date-only (exact
 *  midnight) value reads as the end of that date's working window, exactly as the detached
 *  scheduler's own `allowedPlanningWindow` reads it (same `dueInstant`), so the two bounds
 *  agree. Reads calendar rows without creating defaults. Null when the order has no SAP due. */
function sourceDueInstant(task: NimbusTask, plant: string | null): Date | null {
  const view = _candidateSnapshot ?? {
    calendars: Store.calendars, plants: Store.plants, lineSettings: Store.lineSettings, masterData: Store.masterData,
  };
  return dueInstant(task, { snapshot: view, plant });
}

export function sourcePlantWorkHours(plant: string): WorkHours {
  if (!_candidateSnapshot) {
    Store.ensurePlant(plant);
    return Store.plants[plant].workHours;
  }
  return _candidateSnapshot.plants[plant]?.workHours ?? candidateDefaultWorkHours();
}

function detachedCandidateResult(
  patches: ReadonlyArray<SchedulePatch>,
  startedAt: number,
  termination: 'completed' | 'no-plant' = 'completed',
  backlogResult?: RemoveBacklogResult,
): CandidateResult {
  return {
    patches,
    // A2: 7th element is the uncovered-edge-count tier (SCORE_UNCOVERED in
    // setup-scheduler.mts) — a detached placement result has no coverage concept
    // of its own, so it contributes 0.
    // score[7] = SCORE_OVER_CAP (setup-scheduler), never populated on this detached path
    score: [0, 0, 0, 0, 0, patches.length, 0, 0],
    explanation: [],
    diagnostics: {
      candidateCount: termination === 'completed' ? 1 : 0,
      method: 'legacy-detached',
      termination,
      runtimeMs: performance.now() - startedAt,
      limitReached: false,
      events: _candidateDiagnostics ? [..._candidateDiagnostics] : [],
    },
    unchangedLines: [],
    missingEdges: [],
    ...(backlogResult ? { backlogResult } : {}),
  };
}

/* =============================================================================
   ENGINE — scheduling + optimisation.
   Two run modes:
     • runAndApply(mode): full global re-optimise, respecting fixed + calendars.
     • autoReflow(changedId): after a manual edit, re-flow downstream orders on
       the same (line, day) around the change.
   Genuinely DOM-free (CQ-1 Phase 2 Task 3 removed the last DOM read — a
   `document.getElementById('chk-respect-fixed'/'chk-respect-calendar')`
   fallback whose target ids do not exist anywhere in the rendered markup, so
   the lookup always returned null and the `?? true` default always applied;
   see the comment inline in runAndApply below).
   ========================================================================== */
export const Engine = {
  /** Structured result from the latest explicit Remove Backlog trial. The
   * preview consumes it immediately after `runAndApply`; all other modes clear
   * it so stale diagnostics cannot leak into their shared preview. */
  lastBacklogResult: null as RemoveBacklogResult | null,

  /** Full `CandidateResult` from the latest applied setup-aware run (mirrors
   * `lastBacklogResult`). Lets the preview / diagnostics UI inspect the same
   * `missingEdges`/`unchangedLines` the live toast summary was derived from,
   * without re-running the evaluator. Only set on a live (non-candidateRun)
   * setup-aware apply — never cleared by other modes since it is read
   * on-demand, not consumed-and-wiped like `lastBacklogResult`. */
  lastSetupAwareResult: null as CandidateResult | null,

  /** Evaluate the detached forward placement path (the optimizer's retained forward placement) against a deep,
   * detached snapshot. This is synchronous, so the private source selector is
   * always cleared before another caller can observe it. */
  evaluateSchedule(
    mode: OptimizerMode = 'changeover',
    opts: Record<string, unknown> = {},
    snapshot: ScheduleSnapshot = snapshotSchedule(),
  ): CandidateResult {
    if (_candidateSnapshot) throw new Error('Nested detached schedule evaluation is not supported');
    _candidateSnapshot = snapshot;
    _candidateDiagnostics = [];
    const _pmT0es = performance.now();
    try {
      return Engine.runAndApply(mode, { ...opts, __candidateRun: true })
        ?? detachedCandidateResult([], performance.now());
    } finally {
      _candidateSnapshot = null;
      _candidateDiagnostics = null;
      PerfMonitor.record('Engine.evaluateSchedule', performance.now() - _pmT0es);
    }
  },

  /** Explicit detached setup-aware seam. Existing runAndApply/UI calls do
   * not route here; a caller must supply both the immutable snapshot and the
   * measured search bounds/setup truth before any setup-aware candidate exists. */
  evaluateSetupAware(
    mode: 'due-date-first' | 'due-date' | 'spt' | 'min-changeover' | 'throughput',
    bounds: Readonly<DueDateFirstBounds>,
    snapshot: ScheduleSnapshot = snapshotSchedule(),
    thresholds?: Readonly<SetupPolicyThresholds>,
  ): CandidateResult {
    // Workstream D2: the real gate is plants.setup_active (bounds.setup.plant_active),
    // not the vestigial per-signature-version setup_definition.active.
    if (!bounds.setup.plant_active) {
      throw new Error('Setup-aware evaluation is disabled for this plant');
    }
    // Finish only the chosen proposal, once per run (Min Changeover compares
    // multiple primary searches internally). Backlog retains its date policy.
    if (mode !== 'throughput') {
      const candidate = mode === 'min-changeover' ? evaluateMinChangeoverPure(snapshot, bounds)
        : mode === 'spt' ? evaluateSptWithSetupPure(snapshot, bounds)
          : evaluateDueDateFirstPure(snapshot, bounds, mode);
      return fillPlanningGaps(snapshot, bounds, candidate);
    }
    return evaluateThroughputPure(snapshot, bounds, thresholds ?? {
      throughputMinSavingsMin: 60,
      throughputMaxSlipMin: 1440,
    });
  },

  /** B3a: fabricates a `plant_active: true`, zero-cost `SetupSnapshot` so
   *  `runAndApply`'s `'changeover'` path can route an inactive (or
   *  never-configured) plant through `evaluateSetupAware` exactly like an
   *  active plant, instead of falling through to the now-retired legacy
   *  day-integrity walk. `evaluateSetupAware` throws unless
   *  `bounds.setup.plant_active` is truthy — that's the whole reason this
   *  sets it `true` here, even though nothing was actually activated.
   *
   *  Field selection (Step 1): a plant that configured a setup signature but
   *  never flipped the "include setup times" checkbox still has a real,
   *  persisted `setup_definition.fields` row — `GET /setup/{plant}`
   *  (`setup_data.get_setup_snapshot`) returns `fields` regardless of
   *  activation, so `Store.setupSnapshot` already carries them whenever it's
   *  loaded for this plant. Prefer those real fields so priority grouping
   *  still reflects what the plant actually configured; a plant with no
   *  stored definition at all falls back to `['colorWheel']` — the same
   *  default `setup-scheduler.mts`'s `activePriorityKeys` already uses when a
   *  plant has no configured constraint tree, not a new convention.
   *
   *  `signature_version: 0` and `definition.active: true` are internal-only
   *  shape-satisfiers for `hasUsableDefinition` (setup-domain.mts) — never
   *  persisted, never sent to the backend. `plant_rows`/`machine_rows`/
   *  `overrides` are deliberately empty: every transition then resolves via
   *  `resolveSetup`'s `uncovered(...)` branch, which the never-freeze
   *  invariant already treats as zero setup minutes, never a block.
   *  `synthetic: true` marks this for diagnostic suppression — see
   *  `SetupSnapshot.synthetic`'s doc comment in types.mts. This is a pure
   *  builder: it never reads or writes `Store.setupSnapshot` itself beyond
   *  the one read below, and callers must never assign its result back onto
   *  `Store.setupSnapshot` (Step 6 depends on this staying a local-only
   *  value). */
  _syntheticZeroCostSetupSnapshot(plant: string, sourceSnapshot?: Readonly<ScheduleSnapshot> | null): SetupSnapshot {
    const stored = sourceSnapshot?.setupSnapshot !== undefined ? sourceSnapshot.setupSnapshot : Store.setupSnapshot;
    const storedFields = stored && stored.plant === plant ? stored.definition?.fields : undefined;
    const fields = storedFields && storedFields.length ? storedFields : ['colorWheel'];
    return {
      plant,
      definition: {
        plant,
        fields,
        signature_version: 0,
        strict_blanks: false,
        active: true,
      },
      plant_rows: [],
      machine_rows: [],
      machine_states: [],
      overrides: [],
      plant_active: true,
      synthetic: true,
    };
  },

  /** Apply a selected candidate exactly once.  Preview callers use this rather
   * than calling Store.updateMany themselves so the mutation boundary remains
   * visible and auditable. */
  applySchedulePatches(patches: ReadonlyArray<SchedulePatch>): void {
    applySchedulePatches(patches);
  },

  /** Plant-level behavior only; an absent/malformed value deliberately keeps
   * the established continuous-order scheduler unchanged. */
  splitOrderPolicyFor(plant: string | null): SplitOrderPolicy {
    const value = sourceMasterData()?.plants?.find(row => row.plant === plant)?.split_order_policy;
    return value === 'overlong_only' || value === 'partial_allowed' ? value : 'never';
  },

  /** B3 (2026-08-21): the plant's configured productive-segment floor
   *  (plants.min_productive_segment_minutes), falling back to the exported
   *  MIN_PRODUCTIVE_SEGMENT_MINUTES default when the plant row is missing or
   *  the value is null/not a positive integer — same lookup shape as
   *  splitOrderPolicyFor above. Consulted by both Calendar.allocateRuntime
   *  here and, via setup-scheduler.mjs's own snapshot-scoped mirror of this
   *  lookup, by placeWithSetup. */
  minProductiveSegmentMinutesFor(plant: string | null): number {
    const value = sourceMasterData()?.plants?.find(row => row.plant === plant)?.min_productive_segment_minutes;
    return Number.isInteger(value) && (value as number) > 0 ? (value as number) : MIN_PRODUCTIVE_SEGMENT_MINUTES;
  },

  /** C2 (2026-08-20): the plant's frozen-horizon boundary, as computed
   *  server-side (db.compute_frozen_horizon_end, the SAME anchor-day/
   *  roll-hour clock C1's visibility horizon uses) and cached in
   *  Store.frozenHorizonEnd — the frontend deliberately carries no copy of
   *  that clock math, same reasoning as Store.visibilityHorizonEnd. null
   *  when the plant has no frozen window (frozen_horizon_days NULL/0). */
  frozenHorizonEnd(): Date | null {
    return Store.frozenHorizonEnd;
  },

  /** True when `task`'s CURRENT start already falls inside the plant's
   *  frozen window (OD-C2a: frozen iff start is inside). Unlike C1's
   *  visibility gate (a legitimate from-the-beginning-of-time cutoff — the
   *  past is always visible), C2's frozen window is a near-term protection
   *  BAND, not a from-time-zero cutoff: it's drawn on the Gantt as
   *  `[now, Store.frozenHorizonEnd]` (Timeline's `.frozen-horizon-zone`,
   *  advancing every second, same shape as the alert-horizon band it layers
   *  above) — bounded on BOTH sides. This check must agree with that visual
   *  band: `[now, end)`, not `(-infinity, end)`. An earlier version checked
   *  only the upper bound, which silently treated every already-overdue
   *  order (however long ago) as frozen/immovable everywhere this is
   *  consulted — a real regression, caught in review, not merely a
   *  removeBacklog-specific quirk. `now` defaults to the current moment at
   *  call time (not plant-local midnight, not cached, no new value needed
   *  from the backend) — but callers that already carry their OWN
   *  authoritative "now" pass it explicitly instead, so this stays
   *  consistent with the rest of that call site's own scoping rather than
   *  splitting into two different clocks in the same run:
   *  runAndApply's isAged/isOutOfWin (its planningStart, with runNow
   *  injected for candidate runs) and removeBacklog's plant-local
   *  wall-clock `now` (Engine._plantWallNow) both thread their own value
   *  through; autoReflow has no such concept and relies on the default.
   *
   *  Such an order is treated as implicitly pinned by every placement call
   *  site below — a reason DISTINCT from Store.isFirmed (a genuine manual
   *  pin) so the UI can explain why it didn't move without conflating the
   *  two. This check alone never blocks anything — callers decide what
   *  "pinned" means in their own context (excluded from the free/movable
   *  set, an obstacle for peers, etc). Manual drags never consult this
   *  (OD-C2c): only optimizer/auto-reflow placement code does. */
  isFrozenHorizon(task: NimbusTask, now?: Date, frozenHorizonEnd?: Date | null): boolean {
    const end = frozenHorizonEnd === undefined ? Engine.frozenHorizonEnd() : frozenHorizonEnd;
    if (!end || !task.start_date || !Engine.hasPersistedPlacement(task)) return false;
    const at = now ?? Engine._clockFor(task);
    // A plant with no valid timezone has no clock (OQ52): not frozen, never a throw.
    return !!at && task.start_date >= at && task.start_date < end;
  },

  /** Senior review I10 (OQ3): running/frozen arithmetic applies only to a row with a real placement, i.e. `user_scheduled`
   *  (the server sets it for planner placements, legacy placed rows and running rows). A never-placed row's start is
   *  display-derived or just its basic start, so it is neither running nor frozen. */
  hasPersistedPlacement(task: NimbusTask): boolean {
    return task.user_scheduled === true;
  },

  /** True while the order is in progress: start_date <= now < end_date (both set).
   *  Running orders never move (optimizer, autoReflow, alert fixes); Remove Backlog
   *  is the one exemption. Not gated by "Respect firmed". */
  isInProgress(task: NimbusTask, now?: Date): boolean {
    if (!task.start_date || !task.end_date || !Engine.hasPersistedPlacement(task)) return false;
    const at = now ?? Engine._clockFor(task);
    // A plant with no valid timezone has no clock (OQ52): not running, never a throw.
    return !!at && task.start_date <= at && at < task.end_date;
  },

  /** The default "now" for a task: its plant's wall clock projected from the server instant
   *  (Store.plantNow), or null when that plant is blocked (no valid timezone). The plant is the
   *  task's own, else its line's, else the selected plant. */
  _clockFor(task: NimbusTask): Date | null {
    const plant = task.PLANT || (task.MACHINE ? Store.getPlantForLine(task.MACHINE) : null) || Store.selectedPlant;
    return Store.plantNow(plant);
  },

  /** SAP's firm flag. DISPLAY ONLY — NIMBUS never locks on it. */
  isSapFirmed(task: NimbusTask): boolean {
    return !!task.ecc_firmed;
  },

  /** The one Delete / Unschedule patch (Gantt key + command palette). The order goes to
   *  Needs Planning with no committed dates or segments; SAP's own dates stay on the row
   *  (original_*) for reference, and a following Due Date run re-places it. Fresh object
   *  per call so callers never share a mutable patch. */
  plannerUnscheduleChanges(): Partial<NimbusTask> {
    return {
      start_date: null,
      end_date: null,
      scheduleSegments: [],
      // Back in the queue the order has no placed bar, so an approved exception (overtime / overlong) goes too.
      placement_exception: null,
      planning_status: 'needs_planning',
      planning_reason: { code: 'planner_unscheduled', message: 'Unscheduled by planner' },
    };
  },

  /** The Needs Planning change-set for an order that cannot be one bar under the plant's contiguous policy
   *  (OQ50): no dates or segments, reason `overlong_never`, no stale marker. Fresh object per call. */
  overlongNeverChanges(): Partial<NimbusTask> {
    return {
      ...Engine.plannerUnscheduleChanges(),
      planning_reason: { code: 'overlong_never', message: Util.t('planning_reason.overlong_never') },
      runtime_schedule_mismatch: false, derivationIssue: null, systemMove: null,
    };
  },

  /** Union firming status. UI/live-path ONLY — reads live Store (isFirmed, frozenHorizonEnd).
   *  Detached optimizer runs must use the snapshot fold in the fixed/free split + setup-aware
   *  fold below, never this. reasons: 'frozen' (horizon band), 'manual' (planner),
   *  'running' (in progress). SAP firm is never a reason. */
  firmingStatus(task: NimbusTask, now?: Date): { firmed: boolean; reasons: Array<'frozen'|'manual'|'running'> } {
    const reasons: Array<'frozen'|'manual'|'running'> = [];
    if (Engine.isFrozenHorizon(task, now)) reasons.push('frozen');
    if (Store.isFirmed(task.id)) reasons.push('manual');
    if (Engine.isInProgress(task, now)) reasons.push('running');
    return { firmed: reasons.length > 0, reasons };
  },

  /** Push `at` forward to the frozen-horizon boundary when it falls short —
   *  the one clamp every OPTIMIZER-side placement call site (autoReflow,
   *  earliestAllowedStart below, setup-scheduler's bounds.notBefore) applies before committing a NEW start for a task
   *  that isn't itself frozen-pinned. Manual-path code
   *  (manualSchedulePatchFor, Alerts.applyFix) deliberately never calls
   *  this (OD-C2c). */
  applyFrozenFloor(at: Date, frozenHorizonEnd?: Date | null): Date {
    const end = frozenHorizonEnd === undefined ? Engine.frozenHorizonEnd() : frozenHorizonEnd;
    return (end && at < end) ? new Date(end) : at;
  },

  /** Local due-date calendar-day floor for a plant's optional pull-forward
   *  limit, MAXED with the plant's C2 frozen-horizon floor (Engine.
   *  frozenHorizonEnd) so every one of this function's callers — the reconcile's
   *  pull-floor check and setup-scheduler's bounds.notBefore seam — gets the
   *  frozen floor for free, with no call site needing to know a second floor
   *  exists. */
  earliestAllowedStart(
    task: NimbusTask, plant: string | null, frozenHorizonEnd?: Date | null,
    masterDataOverride?: NimbusMasterData | null,
  ): Date | null {
    let floor: Date | null = null;
    const masterData = masterDataOverride === undefined ? sourceMasterData() : masterDataOverride;
    const value = masterData?.plants?.find(row => row.plant === plant)?.max_pull_forward_days;
    if (Number.isInteger(value) && (value as number) >= 0) {
      const due = sourceDueInstant(task, plant);
      if (due) {
        floor = new Date(+due - 1);   // a due on a 24:00 close is next-day 00:00 exclusive: its due DAY is the day before (R-I6)
        floor.setHours(0, 0, 0, 0);
        floor.setDate(floor.getDate() - (value as number));
      }
    }
    const frozenEnd = frozenHorizonEnd === undefined ? Engine.frozenHorizonEnd() : frozenHorizonEnd;
    if (frozenEnd && (!floor || frozenEnd > floor)) floor = new Date(frozenEnd);
    return floor;
  },

  /** Local due-date calendar-day CEILING for a plant's optional push-forward
   *  (max lateness) limit — the mirror image of earliestAllowedStart. An order
   *  may not FINISH after (due-date local midnight) + (N + 1) days, so N = 0
   *  means "by end of its due day". Null when the plant has no limit or the
   *  order has no SAP due date (Util.sapDueDate). Optimizer-only, like the
   *  pull-forward floor: manual moves, Alerts fixes, autoReflow and Remove
   *  Backlog never consult it. Unlike earliestAllowedStart this is NOT maxed
   *  with the frozen horizon — the two floors/ceilings are independent. */
  latestAllowedEnd(task: NimbusTask, plant: string | null, masterDataOverride?: NimbusMasterData | null): Date | null {
    const masterData = masterDataOverride === undefined ? sourceMasterData() : masterDataOverride;
    const value = masterData?.plants?.find(row => row.plant === plant)?.max_push_forward_days;
    if (!Number.isInteger(value) || (value as number) < 0) return null;
    const due = sourceDueInstant(task, plant);
    if (!due) return null;
    const ceiling = new Date(+due - 1);   // due-DAY midnight even when the due is a 24:00 close (R-I6)
    ceiling.setHours(0, 0, 0, 0);
    ceiling.setDate(ceiling.getDate() + (value as number) + 1);
    return ceiling;
  },

  /** Post-hoc over-cap reporting for the due-date push-forward limit
   *  (`plants.max_push_forward_days`). Walks the APPLIED patches (never the
   *  evaluator's own score tally, which counts something slightly different
   *  mid-search) and counts how many now finish after `latestAllowedEnd`.
   *  Fast-exits with an all-zero/`days: null` result when the plant has no
   *  configured limit, so a default (no-cap) plant never pays the per-patch
   *  scan. `tasks` must be the pre-apply task list the patches were computed
   *  against (a task's own due date is never itself patched, so the pre-apply
   *  copy is equivalent to a post-apply one for this purpose, but MACHINE
   *  lookups need a real object). */
  _overCapSummary(
    patches: ReadonlyArray<{ id: string; changes: Partial<NimbusTask> }>,
    tasks: ReadonlyArray<NimbusTask>,
    plant: string | null,
    masterDataOverride?: NimbusMasterData | null,
  ): { orders: number; lines: number; days: number | null } {
    const masterData = masterDataOverride === undefined ? sourceMasterData() : masterDataOverride;
    const value = masterData?.plants?.find(row => row.plant === plant)?.max_push_forward_days;
    const days = Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null;
    if (days === null) return { orders: 0, lines: 0, days: null };
    const byId = new Map(tasks.map(t => [String(t.id), t]));
    const overCapLines = new Set<string>();
    let orders = 0;
    for (const patch of patches) {
      const endDate = patch.changes.end_date;
      if (!endDate) continue;
      const task = byId.get(String(patch.id));
      if (!task) continue;
      const ceiling = Engine.latestAllowedEnd(task, plant, masterData);
      if (!ceiling) continue;
      if (new Date(endDate).getTime() > ceiling.getTime()) {
        orders += 1;
        overCapLines.add(task.MACHINE || 'Unknown');
      }
    }
    return { orders, lines: overCapLines.size, days };
  },

  /** Regenerate one logical order from its requested parent start. Segments
   * are never shifted independently; a one-piece result explicitly clears an
   * obsolete child aggregate. */
  schedulePatchFor(task: NimbusTask, line: string, requestedStart: Date,
                   policy: SplitOrderPolicy = Engine.splitOrderPolicyFor(sourceGetPlantForLine(line))): Partial<NimbusTask> | null {
    const runtimeMinutes = Math.round(Util.runHours(task) * 60);
    if (!Number.isFinite(runtimeMinutes) || runtimeMinutes <= 0) return null;
    if (policy === 'never') {
      const start = Calendar.nextAvailable(line, requestedStart, runtimeMinutes * Config.MS_MIN);
      if (!start) return null;
      return { start_date: start, end_date: new Date(start.getTime() + runtimeMinutes * Config.MS_MIN), scheduleSegments: [] };
    }
    const allocation = Calendar.allocateRuntime(line, requestedStart, runtimeMinutes, policy);
    return allocation.kind === 'allocated'
      ? { start_date: allocation.start, end_date: allocation.end, scheduleSegments: allocation.scheduleSegments }
      : null;
  },

  /** OQ3: a started order keeps its real start and only the finish follows the run time. The allocator may move
   * the start (`never` snaps it to the 15-minute step; any policy skips closed time), and a running order never
   * loses its start, so in that case the bar is the held start plus the run time as one continuous piece. Shared
   * by the reconcile's running branch and the manual (grid/Inspector) edit. Null when no window is found. */
  heldStartPatchFor(task: NimbusTask, line: string, policy: SplitOrderPolicy): Partial<NimbusTask> | null {
    if (!task.start_date) return null;
    const held = Engine.schedulePatchFor(task, line, task.start_date, policy);
    if (!held?.start_date || !held.end_date) return null;
    if (held.start_date.getTime() === task.start_date.getTime()) return held;
    return { start_date: task.start_date, end_date: new Date(task.start_date.getTime() + Math.round(Util.runHours(task) * 60) * Config.MS_MIN), scheduleSegments: [] };
  },

  /** Finish-anchored placement (backward scheduling OQ1/OQ7/OQ13): lay the order's run time so it ENDS at
   * `finish`, walking the line's working time backward (Calendar.allocateRuntimeBackward), and derive the
   * start. Pure: no Store writes. Both edges are always in `changes` (a continuous bar has empty segments).
   * - run time <= 0 or missing: `refuse` run_time_zero (nothing is placed).
   * - a plant with no valid timezone has no clock: `refuse` plant_no_timezone (no derivation on a blocked plant).
   * - a task carrying `placement_exception` is an approved exception: its stored bar is translated verbatim to
   *   the requested finish (width kept, calendar ignored), so a later run-time change leaves the bar alone.
   * - `overlong` (the order cannot be one bar under the plant's policy): `refuse` overlong_never. Under
   *   overlong_only such an order is split instead, exactly as the forward allocator does.
   * - the walk reached "now" with minutes left (`reached_now`): by default reverse forward from the plant's now,
   *   floored to the minute, and report `finishMoved`/`reversed`; with `opts.deferReversal` return
   *   `{kind:'reached_now'}` unresolved so a batch caller can place reversals per line in finish order. */
  finishAnchoredPatchFor(task: NimbusTask, line: string, finish: Date,
                         policy?: SplitOrderPolicy, opts: FinishAnchoredOptions = {}): FinishAnchoredResult {
    const plant = task.PLANT || Store.getPlantForLine(line) || Store.selectedPlant;
    const effectivePolicy: SplitOrderPolicy = policy ?? Engine.splitOrderPolicyFor(plant);
    const runtimeMinutes = Math.round(Util.runHours(task) * 60);
    if (!Number.isFinite(runtimeMinutes) || runtimeMinutes <= 0) return { kind: 'refuse', reason: 'run_time_zero' };

    if (task.placement_exception && task.start_date && task.end_date) {
      const deltaMs = finish.getTime() - task.end_date.getTime();
      const pieces = task.scheduleSegments && task.scheduleSegments.length >= 2
        ? task.scheduleSegments.map(segment => ({
          ...segment,
          startDate: new Date(segment.startDate.getTime() + deltaMs),
          endDate: new Date(segment.endDate.getTime() + deltaMs),
        }))
        : [];
      return {
        kind: 'placed', finishMoved: false,
        changes: {
          start_date: pieces.length ? pieces[0].startDate : new Date(task.start_date.getTime() + deltaMs),
          end_date: pieces.length ? pieces[pieces.length - 1].endDate : new Date(finish),
          scheduleSegments: pieces,
        },
      };
    }

    const now = Store.plantNow(plant);
    if (!now) return { kind: 'refuse', reason: 'plant_no_timezone' };
    const floor = Calendar._floorMinute(now);
    const plantTz = Store.masterData?.plants?.find(row => row.plant === plant)?.timezone?.trim() || null;
    const walk = (walkPolicy: SplitOrderPolicy) => Calendar.allocateRuntimeBackward(line, finish, runtimeMinutes, walkPolicy,
      { floor, minSegmentMinutes: Engine.minProductiveSegmentMinutesFor(plant), plantTz, setupMinutes: opts.setupMinutes ?? 0 });
    let result = walk(effectivePolicy);
    if (result.kind === 'overlong' && effectivePolicy === 'overlong_only') result = walk('partial_allowed');

    if (result.kind === 'placed') {
      return {
        kind: 'placed', finishMoved: result.finishMoved,
        ...(result.moveReason ? { moveReason: result.moveReason } : {}),
        changes: { start_date: result.start, end_date: result.end, scheduleSegments: result.scheduleSegments },
      };
    }
    if (result.kind === 'overlong') return { kind: 'refuse', reason: 'overlong_never' };
    if (result.kind === 'unavailable') return { kind: 'refuse', reason: 'no_operating_window' };
    if (opts.deferReversal) return { kind: 'reached_now' };
    const forward = Calendar.allocateRuntime(line, floor, runtimeMinutes, effectivePolicy, plantTz);
    if (forward.kind !== 'allocated') return { kind: 'refuse', reason: 'no_operating_window' };
    return {
      kind: 'placed', finishMoved: true, reversed: true,
      changes: { start_date: forward.start, end_date: forward.end, scheduleSegments: forward.scheduleSegments },
    };
  },

  /** Resolve a moved routing-derived order before constructing its schedule.
   * Manual/order-file runtimes keep their existing authority on machine moves. The held FINISH is the
   * anchor (the third argument); the start follows from the resolved run time. */
  manualRoutingSchedulePatchFor(task: NimbusTask, line: string, requestedFinish: Date,
                                opts: ManualPlacementOptions = {}): Partial<NimbusTask> | null {
    Engine.lastManualRefusal = null;
    const plant = task.PLANT || Store.getPlantForLine(task.MACHINE) || Store.selectedPlant;
    const enabled = Store.masterData?.plants?.some(p => p.plant === plant && p.routing_runtime_enabled);
    if (!enabled || line === task.MACHINE || (task.run_time_source !== 'routing' && task.RUN_TIME != null)) {
      return Engine.manualSchedulePatchFor(task, line, requestedFinish, undefined, opts);
    }
    const resolved = Runtime.resolve(task, line);
    if (!resolved.ok) return null;
    const changes = Engine.manualSchedulePatchFor({ ...task, RUN_TIME: resolved.hours }, line, requestedFinish, undefined, opts);
    return changes ? {
      ...changes, RUN_TIME: resolved.hours, run_time_source: 'routing',
      run_time_basis: resolved.basis as unknown as Record<string, unknown>,
    } : null;
  },

  /** Why the most recent `manualSchedulePatchFor` returned null (null when it placed something). Read by the
   *  caller right after the call: a refusal the engine already toasted (`finish_cannot_hold`) must not be toasted
   *  again, and `needs_overtime_confirm` means "ask the planner, then call again with confirmedOvertime". */
  lastManualRefusal: null as ManualRefusal | null,

  /** Ask the planner to approve an overtime placement for a firmed order (OQ63). Resolves true on confirm. */
  confirmOvertimePlacement(task: NimbusTask): Promise<boolean> {
    return Modal.confirm({
      title: Util.t('modal.confirm_overtime_title'),
      message: Util.t('modal.confirm_overtime_msg', { order: Util.orderNumber(task) }),
      confirmLabel: Util.t('modal.confirm_overtime_confirm'),
      tone: 'warn',
    });
  },

  /** Apply a planner-requested placement. The third argument is the FINISH the planner wants (backward
   * scheduling OQ1): a drop, a typed end, a run-time/machine/version edit that holds the finish, or the
   * Override dialog's finish. The start is derived backward through the working time and the result carries
   * both edges.
   * - An order that already has two or more schedule segments of the right total is translated rigidly by the
   *   finish delta (OQ17 b: the dragged piece's same-edge delta), never re-derived and never calendar-checked;
   *   a changed total (rate or version edit) is re-derived from the held finish under the plant's policy.
   * - Otherwise `finishAnchoredPatchFor(snap(finish))`. A backward start before the plant's now reverses forward
   *   from now with a `reversal_forward` note (O2, OQ3, OQ7 a, OQ19 c), never a refusal. A manual drop whose finish
   *   cannot be held (it would have to move EARLIER) returns null with `toast.finish_cannot_hold` and the caller reverts (OQ13 b). A FIRMED order
   *   in that situation asks for confirmation first (`lastManualRefusal === 'needs_overtime_confirm'`); with
   *   `opts.confirmedOvertime` it is placed raw (start = finish minus run time, calendar ignored) and marked
   *   `placement_exception = 'overtime'` (OQ63).
   * - A row queued as `overlong_never` that is still overlong on the chosen line is released as ONE continuous
   *   elapsed bar ending at the finish, marked `'overlong'` (OQ50). Queued `overlong_never`/`run_time_over_cap`
   *   rows that place normally return to `scheduled` in the same patch.
   * Manual placement deliberately ignores the frozen horizon (OD-C2c). Null on any refusal; the reason is in
   * `Engine.lastManualRefusal`. */
  manualSchedulePatchFor(task: NimbusTask, line: string, requestedFinish: Date,
                         policy?: SplitOrderPolicy, opts: ManualPlacementOptions = {}): Partial<NimbusTask> | null {
    Engine.lastManualRefusal = null;
    const refuse = (reason: ManualRefusal): null => { Engine.lastManualRefusal = reason; return null; };
    const runtimeMinutes = Math.round(Util.runHours(task) * 60);
    if (!Number.isFinite(runtimeMinutes) || runtimeMinutes <= 0) return refuse('run_time_zero');
    const finish = Util.snap(requestedFinish);
    const plant = task.PLANT || Store.getPlantForLine(line) || Store.selectedPlant;
    const queuedCode = task.planning_status === 'needs_planning' ? task.planning_reason?.code : undefined;
    // Only these two queue reasons are releasable by a placement; any other queued row follows the ordinary rule.
    const releasable = queuedCode === 'overlong_never' || queuedCode === 'run_time_over_cap';
    const released: Partial<NimbusTask> = releasable ? { planning_status: 'scheduled', planning_reason: null } : {};

    if (opts.holdStartIfRunning && task.start_date && Engine.isInProgress(task)) {
      // OQ3: it is already producing, so its start cannot move; the finish follows from the new run time.
      const held = Engine.heldStartPatchFor(task, line, policy ?? Engine.splitOrderPolicyFor(plant));
      return held ? { ...held, MACHINE: line } : refuse('no_operating_window');
    }

    const segments = task.scheduleSegments;
    if (segments && segments.length >= 2) {
      const productiveMinutes = Math.round(segments.reduce((sum, segment) =>
        sum + (segment.endDate.getTime() - segment.startDate.getTime()) / Config.MS_MIN, 0));
      if (productiveMinutes === runtimeMinutes) {
        const deltaMs = finish.getTime() - segments[segments.length - 1].endDate.getTime();
        const shifted = segments.map(segment => ({
          ...segment,
          startDate: new Date(segment.startDate.getTime() + deltaMs),
          endDate: new Date(segment.endDate.getTime() + deltaMs),
        }));
        return {
          start_date: shifted[0].startDate,
          end_date: shifted[shifted.length - 1].endDate,
          MACHINE: line,
          scheduleSegments: shifted,
        };
      }
      // A rate/version edit changes the productive total: translating the old pieces would keep an invalid
      // aggregate, so re-derive from the held finish under the plant's own policy.
    }

    const result = Engine.finishAnchoredPatchFor(task, line, finish, policy ?? Engine.splitOrderPolicyFor(plant));
    if (result.kind === 'refuse') {
      if (result.reason === 'overlong_never' && queuedCode === 'overlong_never') {
        // A release has no held finish to protect: a due instant already in the past starts the bar at the
        // plant's now instead (reversal, OQ53) and records why.
        const now = Store.plantNow(plant);
        const floor = now ? Calendar._floorMinute(now) : null;
        const reversed = !!floor && finish.getTime() < floor.getTime() + runtimeMinutes * Config.MS_MIN;
        const start = reversed ? floor! : new Date(finish.getTime() - runtimeMinutes * Config.MS_MIN);
        return {
          start_date: start,
          end_date: reversed ? new Date(start.getTime() + runtimeMinutes * Config.MS_MIN) : finish,
          scheduleSegments: [],
          MACHINE: line,
          placement_exception: 'overlong',
          ...released,
          ...(reversed ? { derivationIssue: { code: 'reversal_forward', detail: 'due_date_past' } } : {}),
        };
      }
      return refuse(result.reason);
    }
    if (result.kind === 'reached_now') return refuse('no_operating_window');   // unreachable: reversal is not deferred
    if (result.finishMoved) {
      if (result.reversed) {
        // OQ3 / OQ7(a) / OQ19(c) / O2: the backward start would be before now, so the order places forward from
        // the plant's now (late) instead of being refused. Only a finish that would have to move EARLIER is refused.
        const nowForDetail = Store.plantNow(plant);
        const detail = nowForDetail && finish.getTime() <= Calendar._floorMinute(nowForDetail).getTime() ? 'due_date_past' : 'run_time_grew';
        return { ...result.changes, MACHINE: line, ...released,
          derivationIssue: { code: 'reversal_forward', detail } };
      }
      if (result.moveReason && !result.reversed && Store.isFirmed(task.id)) {
        if (!opts.confirmedOvertime) return refuse('needs_overtime_confirm');
        return {
          start_date: new Date(finish.getTime() - runtimeMinutes * Config.MS_MIN),
          end_date: finish,
          scheduleSegments: [],
          MACHINE: line,
          placement_exception: 'overtime',
          ...released,
        };
      }
      if (!opts.quiet) Toast.show(Util.t('toast.finish_cannot_hold', { order: Util.orderNumber(task), machine: line }), 'warn', 5000);
      return refuse('finish_cannot_hold');
    }
    return { ...result.changes, MACHINE: line, ...released };
  },

  /** Push +1 hour (OQ8) for a batch: each placed order's FINISH moves `ms` later and the start is re-derived.
   *  Firmed, frozen and running orders stay where they are, and so does an order whose new finish cannot be
   *  held on its machine's working hours (quiet: the caller reports one summary). The walks of one plant share
   *  one calendar run cache. */
  pushFinishPatches(tasks: NimbusTask[], ms: number): Array<{ id: string; changes: Partial<NimbusTask> }> {
    const patches: Array<{ id: string; changes: Partial<NimbusTask> }> = [];
    const byPlant = new Map<string, NimbusTask[]>();
    for (const task of tasks) {
      if (!task.start_date || !task.end_date || Engine.firmingStatus(task).firmed) continue;
      const plant = task.PLANT || Store.getPlantForLine(task.MACHINE || 'Unknown') || Store.selectedPlant || '';
      (byPlant.get(plant) ?? byPlant.set(plant, []).get(plant)!).push(task);
    }
    for (const [plant, group] of byPlant) {
      Calendar._beginRun(plant || null);
      try {
        for (const task of group) {
          const changes = Engine.manualSchedulePatchFor(task, task.MACHINE || 'Unknown',
            new Date(task.end_date!.getTime() + ms), undefined, { quiet: true });
          if (changes) patches.push({ id: task.id, changes });
        }
      } finally { Calendar._endRun(); }
    }
    return patches;
  },

  /** Plants whose derive-and-save is paused because their server calendar has not landed (OQ51). Session only;
   *  `_renderDerivePaused` shows the banner while the set is non-empty. */
  derivePausedPlants: new Set<string>(),

  _setDerivePaused(plant: string, paused: boolean): void {
    if (paused) Engine.derivePausedPlants.add(plant); else Engine.derivePausedPlants.delete(plant);
    Engine._renderDerivePaused();
  },

  _renderDerivePaused(): void {
    if (typeof document === 'undefined') return;
    const banner = document.getElementById('derive-paused-banner');
    if (!banner) return;
    const plants = [...Engine.derivePausedPlants];
    banner.hidden = plants.length === 0;
    banner.textContent = plants.length ? Util.t('ui.derive_paused', { plant: plants.join(', ') }) : '';
    document.body?.classList?.toggle('derive-paused', plants.length > 0);
  },

  /** Re-derive starts from the held finish (backward scheduling OQ3, OQ4, OQ33, OQ34, OQ51, OQ53, OQ62).
   *
   * Which rows: `runtime_schedule_mismatch` (the stored start may be out of date) or never placed
   * (`!user_scheduled`); queued rows and rows carrying `placement_exception` are left alone. The held finish
   * is the anchor: a placed row's stored end, a never-placed row's due instant. A RUNNING placed row keeps its
   * start and lets the finish follow the run time (OQ3, no reversal). A firmed row is re-derived like any other
   * and stays firmed (OQ4); a derived start that lands in the frozen window is only noted.
   *
   * Two write kinds. A row the server flagged stale gets a DIRTY patch (the cutover path: the next Save persists
   * it and the server clears the flag). A never-placed row that is not flagged is derived for DISPLAY only
   * (source `engine-runtime-reconcile-display`, skipped by the dirty tracker), so Save leaves the server row
   * never-placed. Every patch carries both edges (and the segments), and every touched or skipped row carries a
   * session-only `derivationIssue`.
   *
   * Nothing is derived from a plant whose server calendar is `pending` or `failed` (default 07:00-19:00 hours
   * would be saved as truth), from a plant with no time zone, or on a line with no server calendar row. Rows
   * whose walk reaches "now" are collected per line and placed forward in finish order from now (OQ53 b).
   * No undo entry (OQ57); one Toast counts the dirty patches. `opts.reason === 'cutover'` tags the reversals. */
  reconcileRuntimeSchedules(plant: string | null, opts: ReconcileOptions = {}): void {
    if (!plant) return;
    const candidates = Store.tasksByPlant(plant).filter(task =>
      (task.runtime_schedule_mismatch || !task.user_scheduled)
      && task.planning_status !== 'needs_planning' && !task.placement_exception && !!task.MACHINE
      // A row with unsaved local edits is the planner's own work in progress: never re-derive it.
      && (opts.ids ? opts.ids.has(String(task.id)) : !Persistence._dirtyIds.has(String(task.id))));
    if (!candidates.length) { Engine._setDerivePaused(plant, false); return; }
    // OQ51: only an authoritative (server) calendar may derive a start; otherwise wait for it.
    if (CalendarSync.calendarState(plant) !== 'hydrated') { Engine._setDerivePaused(plant, true); return; }
    Engine._setDerivePaused(plant, false);

    interface ReconcilePatch { id: string; changes: Partial<NimbusTask>; dirty: boolean }
    type Issue = NonNullable<NimbusTask['derivationIssue']>;
    const patches: ReconcilePatch[] = [];
    const sameIssue = (a: NimbusTask['derivationIssue'], b: NimbusTask['derivationIssue']): boolean =>
      (a ?? null) === (b ?? null) || (!!a && !!b && a.code === b.code && a.detail === b.detail
        && a.from?.getTime() === b.from?.getTime() && a.to?.getTime() === b.to?.getTime());
    // A note on a row the reconcile did not (or could not) place: session-only, never dirty, and not repeated.
    const noteOnly = (task: NimbusTask, issue: Issue): void => {
      if (sameIssue(task.derivationIssue, issue)) return;
      patches.push({ id: task.id, changes: { derivationIssue: issue }, dirty: false });
    };
    const plantNow = Store.plantNow(plant);
    // OQ53 (Task 4.2): the first load after the backward-scheduling cutover is recognised by the data signature the
    // cutover SQL leaves: every non-queued row is flagged stale and NEVER PLACED (`!user_scheduled`), except the
    // running rows, which keep both edges. When those two kinds of stale row are more than half of the plant's
    // non-queued rows (queued rows count on neither side) the pass is the cutover pass: its reversals are tagged
    // 'cutover' and one summary Toast, counted over the STALE rows only, replaces the per-row "N moved" Toast.
    // A stale row that still carries a placement (an ordinary SAP or routing re-upload flagging placed orders) never
    // counts, so such a load keeps its per-row Toasts and 'run_time_grew'. An undo pass (opts.ids) never is a cutover
    // pass; an explicit reason wins.
    const nonQueuedCount = Store.tasksByPlant(plant).filter(task => task.planning_status !== 'needs_planning').length;
    const signatureCount = candidates.filter(task => task.runtime_schedule_mismatch
      && (!task.user_scheduled
        || (!!plantNow && !!task.start_date && !!task.end_date && Engine.isInProgress(task, plantNow)))).length;
    const cutover = opts.reason === 'cutover'
      || (opts.reason === undefined && !opts.ids && nonQueuedCount > 0 && signatureCount * 2 > nonQueuedCount);
    const cutoverCounts = { anchored: 0, reversed: 0, running: 0, blocked: 0 };
    const tally = (stale: boolean, kind: keyof typeof cutoverCounts): void => { if (stale) cutoverCounts[kind]++; };
    const commit = (): void => {
      const dirty = patches.filter(patch => patch.dirty);
      const display = patches.filter(patch => !patch.dirty);
      if (dirty.length) Store.updateMany(dirty.map(({ id, changes }) => ({ id, changes })), 'engine-runtime-reconcile');
      if (display.length) Store.updateMany(display.map(({ id, changes }) => ({ id, changes })), 'engine-runtime-reconcile-display');
      // An undo already announces itself ("Undone: ..."), so its re-derivation is not counted again.
      if (opts.reason === 'undo') return;
      const counted = cutoverCounts.anchored + cutoverCounts.reversed + cutoverCounts.running + cutoverCounts.blocked;
      if (cutover && counted > 0) {
        Toast.show(Util.t('toast.cutover_summary', {
          n: cutoverCounts.anchored, m: cutoverCounts.reversed, k: cutoverCounts.running, j: cutoverCounts.blocked,
        }), 'info', 12000);
      } else if (dirty.length) Toast.show(Util.t('toast.system_moved_n', { count: dirty.length }), 'info', 6000);
    };

    if (!plantNow) {
      // OQ52: a plant with no zone has no clock, so nothing is derived (Store.plantNow already announced it once).
      for (const task of candidates) { noteOnly(task, { code: 'plant_no_timezone' }); tally(!!task.runtime_schedule_mismatch, 'blocked'); }
      commit();
      return;
    }
    const policy = Engine.splitOrderPolicyFor(plant);
    const floor = Calendar._floorMinute(plantNow);
    const plantTz = Store.masterData?.plants?.find(row => row.plant === plant)?.timezone?.trim() || null;   // the reversal's forward leg runs on plant-zone instants (U16)
    const moveReason = (stale: boolean): string => cutover ? 'cutover' : (stale ? 'run_time_changed' : 'due_date_derivation');
    // A schedule patch always carries both edges, the segments and both session notes (the notes are cleared
    // by the next edit, Store._clearStaleNotes, unless a change-set carries them).
    const schedulePatch = (task: NimbusTask, stale: boolean, changes: Partial<NimbusTask>,
                           issue: Issue | null, reason: string, moved: 'start' | 'end' = 'start'): void => {
      const before = moved === 'start' ? task.start_date : task.end_date;
      const after = (moved === 'start' ? changes.start_date : changes.end_date) ?? before;
      const full: Partial<NimbusTask> = {
        ...changes, scheduleSegments: changes.scheduleSegments ?? [], runtime_schedule_mismatch: false,
        derivationIssue: issue,
        systemMove: after ? { from: before ?? after, to: after, reason } : null,
      };
      // A display-only row whose derivation changes nothing is not rewritten on every pass.
      if (!stale && task.start_date?.getTime() === full.start_date?.getTime()
        && task.end_date?.getTime() === full.end_date?.getTime()
        && Engine._sameScheduleSegments(task.scheduleSegments, full.scheduleSegments ?? [])
        && sameIssue(task.derivationIssue, issue)) return;
      patches.push({ id: task.id, changes: full, dirty: stale });
    };

    // OQ2 V1 / OQ40: the changeover the derivation reserves ahead of the earliest piece is the one the setup
    // domain requires for the (predecessor -> this order) pair on the line. Adjacency is by start, exactly as the
    // setup observation reads it: the predecessor is the latest-starting scheduled row on the line that starts
    // before this order's start. Built once per pass, per line, so the lookup is a binary search.
    const setup = Store.setupSnapshot;
    const setupDefinition = setup?.definition;
    const setupLive = !!(setup && setupDefinition && setup.plant_active && setup.plant === plant);
    const lineSchedule = new Map<string, NimbusTask[]>();
    const scheduleOf = (line: string): NimbusTask[] => {
      let rows = lineSchedule.get(line);
      if (!rows) {
        rows = Store.tasksByPlant(plant).filter(row => row.MACHINE === line && row.planning_status !== 'needs_planning'
          && row.start_date && row.end_date);
        rows.sort((a, b) => a.start_date!.getTime() - b.start_date!.getTime() || String(a.id).localeCompare(String(b.id)));
        lineSchedule.set(line, rows);
      }
      return rows;
    };
    /** The changeover minutes to reserve before `task` starting at `start` (0 when it is unknown: the predecessor
     *  is not placed, the pair has no rule or an attribute is missing; the unknown-setup alert covers those), and
     *  whether an active override of this order no longer names the row that now sits before it. */
    const setupBefore = (task: NimbusTask, line: string, start: Date): { minutes: number; orphaned: boolean } => {
      if (!setupLive || !setup || !setupDefinition) return { minutes: 0, orphaned: false };
      const rows = scheduleOf(line);
      let lo = 0, hi = rows.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].start_date!.getTime() < start.getTime()) lo = mid + 1; else hi = mid; }
      let predecessor: NimbusTask | null = null;
      for (let i = lo - 1; i >= 0; i--) { if (String(rows[i].id) !== String(task.id)) { predecessor = rows[i]; break; } }
      const predecessorId = predecessor ? String(predecessor.id) : null;
      const orphaned = setup.overrides.some(override => override.status === 'active' && override.machine === line
        && String(override.successor_order_id) === String(task.id) && (override.predecessor_order_id == null ? null : String(override.predecessor_order_id)) !== predecessorId);
      let predecessorState: SetupStateKey | null = null;
      if (predecessor) {
        if (!predecessor.user_scheduled) return { minutes: 0, orphaned };   // not placed: the required changeover is unknown
        predecessorState = stateForOrder(predecessor, setupDefinition);
      } else {
        predecessorState = setup.machine_states.find(state => state.machine === line
          && state.signature_version === setupDefinition.signature_version)?.state_key ?? null;
      }
      const successorState = stateForOrder(task, setupDefinition);
      if (!predecessorState || !successorState) return { minutes: 0, orphaned };
      const resolved = resolveSetup({
        definition: setupDefinition, machine: line, predecessorState, successorState, predecessorOrderId: predecessorId,
        successorOrderId: String(task.id), plantRows: setup.plant_rows, machineRows: setup.machine_rows, overrides: setup.overrides,
      });
      return { minutes: resolved.covered && resolved.effectiveMin != null ? resolved.effectiveMin : 0, orphaned };
    };

    interface Reversal { task: NimbusTask; anchor: Date; stale: boolean }
    const reversals = new Map<string, Reversal[]>();
    Calendar._beginRun(plant);
    try {
      for (const task of candidates) {
        const line = task.MACHINE;
        // OQ62: a line on the client default hours has no server calendar to derive from.
        const stale = !!task.runtime_schedule_mismatch;
        if (!CalendarSync.hasServerLineCalendar(plant, line)) { noteOnly(task, { code: 'line_no_calendar' }); tally(stale, 'blocked'); continue; }
        const placed = !!task.user_scheduled;

        if (placed && task.start_date && task.end_date && Engine.isInProgress(task, plantNow)) {
          // OQ3: it is already producing. The start holds and the finish follows the run time (no reversal).
          const changes = Engine.heldStartPatchFor(task, line, policy);
          if (!changes) {
            ErrorLog.warn('engine',
              `Runtime changed for running order "${task.text || task.id}", but its finish could not be regenerated within the 90-day calendar search.`,
              { line, taskId: task.id, policy, reason: 'runtime-schedule-mismatch' });
            noteOnly(task, { code: 'no_operating_window' });
            continue;
          }
          schedulePatch(task, stale, changes, null, moveReason(stale), 'end');
          tally(stale, 'running');
          continue;
        }

        const anchor = placed ? task.end_date : Util.dueInstant(task);
        if (!anchor) { noteOnly(task, { code: 'no_anchor' }); tally(stale, 'blocked'); continue; }   // no finish to hold, so nothing can be derived
        let result = Engine.finishAnchoredPatchFor(task, line, anchor, policy, { deferReversal: true, setupMinutes: 0 });
        if (result.kind === 'placed' && setupLive) {
          // The first walk shows where the order starts, which names its predecessor; walk again with that
          // pair's changeover so the earliest piece also holds it (only the start can move, never the finish).
          const { minutes } = setupBefore(task, line, result.changes.start_date!);
          if (minutes > 0) {
            // The reservation alone never sends a row to the forward reversal: when the setup-aware walk cannot
            // place, the zero-setup placement at the held finish stands and the setup-violated alert fires.
            const withSetup = Engine.finishAnchoredPatchFor(task, line, anchor, policy, { deferReversal: true, setupMinutes: minutes });
            // Senior review I8 (ruling 3.2): a second walk that moved the finish (a window too tight for run + changeover)
            // is discarded too; setup is a preference, never a reason to move a held finish.
            if (withSetup.kind === 'placed'
              && (!withSetup.finishMoved || withSetup.changes.end_date?.getTime() === result.changes.end_date?.getTime())) result = withSetup;
          }
        }
        if (result.kind === 'reached_now') {
          (reversals.get(line) ?? reversals.set(line, []).get(line)!).push({ task, anchor, stale });
          continue;
        }
        if (result.kind === 'refuse') {
          if (result.reason === 'overlong_never') {
            // OQ50: it cannot be one bar under this plant's policy. Queue it; the planner releases it by editing it.
            patches.push({ id: task.id, dirty: stale, changes: Engine.overlongNeverChanges() });
          } else if (result.reason === 'run_time_zero') noteOnly(task, { code: 'run_time_zero' });   // OQ13: no bar
          else if (result.reason === 'plant_no_timezone') { noteOnly(task, { code: 'plant_no_timezone' }); tally(stale, 'blocked'); }
          else {
            ErrorLog.warn('engine',
              `Order "${task.text || task.id}" could not be re-derived: no operating window within the 90-day calendar search.`,
              { line, taskId: task.id, policy, reason: result.reason });
            noteOnly(task, { code: 'no_operating_window' });
          }
          continue;
        }

        // Placed. Several findings can apply to one row; the most important one is recorded.
        const derivedStart = result.changes.start_date!;
        let issue: Issue | null = null;
        const orphaned = setupLive && setupBefore(task, line, derivedStart).orphaned;
        if (result.finishMoved) issue = { code: 'finish_moved_earlier', from: anchor, to: result.changes.end_date! };
        else if (orphaned) issue = { code: 'setup_override_orphaned' };   // an active override no longer names the row before it (recorded only, Task 3.3 alerts)
        else if (Store.isFirmed(task.id) && Engine.isFrozenHorizon({ ...task, start_date: derivedStart, user_scheduled: true }, plantNow)) {
          issue = { code: 'frozen_window_crossed' };   // OQ4: alert only, nothing is un-firmed
        } else if (placed && !Store.isFirmed(task.id) && task.start_date
          && !Engine.isFrozenHorizon(task, plantNow) && Engine.isFrozenHorizon({ ...task, start_date: derivedStart, user_scheduled: true }, plantNow)) {
          // R26 (gate 14): a PLACED, unfirmed row whose start moves from outside to inside the frozen window in
          // this reconcile becomes frozen, and a frozen start is sent firm (irreversible in SAP). Warn the planner.
          // Never-placed, display-only and queued rows stay excluded (no flood).
          issue = { code: 'frozen_window_crossed', from: task.start_date, to: derivedStart };
        } else {
          const pullFloor = Engine.earliestAllowedStart(task, plant, null);
          if (pullFloor && derivedStart < pullFloor) issue = { code: 'pull_floor_crossed', from: derivedStart, to: pullFloor };   // OQ20
        }
        schedulePatch(task, stale, result.changes, issue, moveReason(stale));
        tally(stale, 'anchored');
      }

      // OQ53 b: rows whose walk reached "now" go forward from now, per line, in finish order, one after another.
      for (const [line, rows] of reversals) {
        rows.sort((a, b) => a.anchor.getTime() - b.anchor.getTime() || String(a.task.id).localeCompare(String(b.task.id)));
        const sequence = Engine.placeForwardSequence(line, rows.map(row => ({ task: row.task, row })), floor, policy, { plantTz });
        const placedIds = new Set<string>();
        for (const { item, start, end, scheduleSegments } of sequence.placed) {
          placedIds.add(String(item.row.task.id));
          const detail = cutover ? 'cutover' : (item.row.stale ? 'run_time_grew' : 'due_date_past');
          schedulePatch(item.row.task, item.row.stale, { start_date: start, end_date: end, scheduleSegments: scheduleSegments ?? [] },
            { code: 'reversal_forward', detail }, cutover ? 'cutover' : 'reversal_forward');
          tally(item.row.stale, 'reversed');
        }
        const overlongIds = new Set(sequence.overlong.map(item => String(item.row.task.id)));
        for (const row of rows) {
          if (placedIds.has(String(row.task.id))) continue;
          if (overlongIds.has(String(row.task.id))) {
            // OQ50: it cannot be one bar under this plant's policy, so it is queued exactly like the backward refusal.
            patches.push({ id: row.task.id, dirty: row.stale, changes: Engine.overlongNeverChanges() });
            continue;
          }
          ErrorLog.warn('engine',
            `Order "${row.task.text || row.task.id}" could not be placed forward from now: no operating window found.`,
            { line, taskId: row.task.id, policy, reason: 'reversal-forward' });
          noteOnly(row.task, { code: 'no_operating_window' });
        }
      }
    } finally {
      Calendar._endRun();
    }
    commit();
  },

  /** After rows were restored (undo, Time Machine) their stored start is a placeholder: re-derive each plant's
   *  restored rows from their restored finish under the current run time (OQ21). */
  reconcileRestored(ids: Iterable<string>, wasDirty: ReadonlySet<string> = new Set()): void {
    const byPlant = new Map<string, Set<string>>();
    const neverPlaced: string[] = [];
    for (const raw of ids) {
      const id = String(raw);
      const task = Store.tasks[id];
      const plant = task ? (task.PLANT || Store.getPlantForLine(task.MACHINE)) : null;
      if (plant) (byPlant.get(plant) ?? byPlant.set(plant, new Set()).get(plant)!).add(id);
      // F10: the reconcile's own never-placed test (`!user_scheduled`, the display-only derive of Task 2.6).
      if (task && !task.user_scheduled) neverPlaced.push(id);
    }
    // A row that was never placed server-side stays display-only after an undo / Time Machine restore: restoreTasks
    // flagged it stale and the undo write dirtied it, and either would route it through the dirty reconcile patch
    // (`_markPlaced`) so the next Save persisted a placement it never had. Clear both; the pass below derives it
    // from its due date through the display source, which the dirty tracker skips. A row that was ALREADY dirty
    // before the undone edit (`wasDirty`, recorded by UndoStack.snapshotTasks) carries an unsaved attribute edit of
    // its own (run time, text, priority) and stays dirty; Save leaves its derived dates and segments out of the
    // payload (Persistence._taskEditSnapshot, never-placed rows), so only the placement is dropped.
    if (neverPlaced.length) {
      Store.updateMany(neverPlaced.map(id => ({ id, changes: { runtime_schedule_mismatch: false } })), 'engine-runtime-reconcile-display');
      for (const id of neverPlaced) {
        if (wasDirty.has(id)) continue;
        Persistence._dirtyIds.delete(id); Persistence._forceIds.delete(id);
      }
    }
    for (const [plant, restored] of byPlant) Engine.reconcileRuntimeSchedules(plant, { reason: 'undo', ids: restored });
  },

  /** Place `items` one after another on `line`, each starting at the later of the running cursor and its own
   *  `notBefore`, walking the calendar forward under `policy` (the cursor loop Remove Backlog and the reversal
   *  queue share). Pure: nothing is written. `opts.stopWhen` ends the walk before an item (Remove Backlog stops
   *  when the compressing cursor has caught up with an item that has not started yet); the first item the
   *  calendar cannot place ends it too, reported in `failure`. Callers own the surrounding calendar run. */
  placeForwardSequence<T extends ForwardSequenceItem>(
    line: string, items: ReadonlyArray<T>, from: Date, policy: SplitOrderPolicy,
    opts: { stopWhen?: (item: T, cursor: Date) => boolean; plantTz?: string | null } = {},
  ): ForwardSequenceResult<T> {
    const out: ForwardSequenceResult<T> = { placed: [], invalidRuntime: [], overlong: [], failure: null };
    let cursor = new Date(from);
    for (const item of items) {
      if (opts.stopWhen?.(item, cursor)) break;
      const runtimeHours = Number(item.task.RUN_TIME);
      if (!Number.isFinite(runtimeHours) || runtimeHours <= 0) {
        out.invalidRuntime.push(item);
        continue;
      }
      const runtimeMs = Math.round(runtimeHours * 60) * Config.MS_MIN;   // whole minutes like every other path (senior review M1)
      const candidate = item.notBefore ? new Date(Math.max(item.notBefore.getTime(), cursor.getTime())) : cursor;
      let start: Date;
      let end: Date;
      let scheduleSegments: OrderScheduleSegment[] | undefined;
      if (policy === 'never') {
        // Preserve the existing continuous-bar contract exactly for legacy
        // schedules. A split schedule that is explicitly regenerated under
        // this policy is cleared below as one atomic parent aggregate.
        const slot = Calendar.findContiguousSlot(line, candidate, runtimeMs);
        if (slot.kind === 'unavailable' || (!opts.plantTz && !('start' in slot))) {
          out.failure = { item, reason: slot.kind === 'unavailable' ? 'no-operating-interval' : 'search-exhausted' };
          break;
        }
        if (slot.kind === 'overlong' && !opts.plantTz) { out.overlong.push(item); continue; }
        if (opts.plantTz) {
          // The reversal's forward leg picks the slot AND the end in plant-zone instants (OQ46, U16), so a window
          // whose edge lies on a DST jump is neither overrun nor skipped. Overlong / unavailable were classified above.
          const allocation = Calendar.allocateRuntime(line, candidate, Math.round(runtimeHours * 60), 'never', opts.plantTz);
          if (allocation.kind !== 'allocated') {
            // Wall-clock said overlong and plant-zone time agrees (no window holds it): the continuous-bar exception.
            if (slot.kind === 'overlong') { out.overlong.push(item); continue; }
            out.failure = { item, reason: allocation.kind === 'unavailable' ? 'no-operating-interval' : 'search-exhausted' };
            break;
          }
          start = allocation.start;
          end = allocation.end;
        } else {
          start = (slot as { start: Date }).start;
          end = new Date(start.getTime() + runtimeMs);
        }
        if (item.task.scheduleSegments?.length && item.task.scheduleSegments.length >= 2) scheduleSegments = [];
      } else {
        const allocation = Calendar.allocateRuntime(line, candidate, Math.round(runtimeHours * 60), policy, opts.plantTz ?? null);
        if (allocation.kind !== 'allocated') {
          out.failure = { item, reason: allocation.kind === 'unavailable' ? 'no-operating-interval' : 'search-exhausted' };
          break;
        }
        start = allocation.start;
        end = allocation.end;
        // Always include the full child aggregate, including [], so a
        // regenerated continuous parent removes obsolete child rows.
        scheduleSegments = allocation.scheduleSegments;
      }
      cursor = end;
      out.placed.push({ item, start, end, ...(scheduleSegments !== undefined ? { scheduleSegments } : {}) });
    }
    return out;
  },
  _sameScheduleSegments(a: OrderScheduleSegment[] | undefined, b: OrderScheduleSegment[]): boolean {
    const left = Array.isArray(a) ? a : [];
    if (left.length !== b.length) return false;
    return left.every((segment, index) => {
      const other = b[index];
      return !!other && segment.sequence === other.sequence
        && segment.startDate?.getTime() === other.startDate.getTime()
        && segment.endDate?.getTime() === other.endDate.getTime();
    });
  },

  /** Convert a captured instant to the Date-as-naive-wall-clock convention
   * NIMBUS already persists. Calendar methods intentionally use Date's local
   * getters because task values are naive wall-clock values, so this adapter
   * first projects the instant into the plant IANA zone, then recreates those
   * wall-clock components for the existing calendar engine. */
  _plantWallNow(timezone: string, runAt: Date): Date {
    // The projection is the compute core's shared helper (one implementation for Store.plantNow, the
    // worker and this); Remove Backlog additionally REQUIRES a real zone, so a blank or invalid one
    // still throws, with the same message as before.
    const wall = typeof timezone === 'string' && timezone.trim()
      ? plantWallClockFromInstant(timezone, runAt) : null;
    if (!wall) {
      throw new Error(`Remove Backlog requires a valid IANA timezone for the selected plant (${timezone}): could not resolve plant-local clock`);
    }
    wall.setSeconds(0, 0);
    return wall;
  },

  /** Planner-invoked, sequence-preserving backlog repair. This deliberately
   * has no priority, due-date, firmed-protection, day-integrity, or
   * frozen-horizon branches. The C2 (2026-08-20) frozen-horizon guard --
   * obstacle-skip on encountering a frozen-window order, and a placement
   * floor on every candidate start -- was removed for this mode on
   * 2026-08-22 by planner decision (SAP002 "Remove Backlog" parity):
   * insert-operation semantics require the overdue backlog to compress
   * fully into now, including into the frozen window. A frozen-window
   * order is still moved "when reached" by the compressing cursor -- it is
   * never pulled earlier than its own snapshot start (the
   * `item.snapshotStart >= now && cursor <= item.snapshotStart` break above
   * still guarantees that) -- mirroring the pre-existing treatment of a
   * genuinely Store.isFirmed-pinned order, and is now counted separately via
   * diagnostics.frozenMoved. All other placement sites (runAndApply's
   * firmedTasks/freeTasks split, the setup-aware evaluator's firmedIds,
   * autoReflow, Engine.earliestAllowedStart) are unaffected and keep
   * applying Engine.isFrozenHorizon / Engine.applyFrozenFloor exactly as
   * before. */
  removeBacklog(opts: Record<string, unknown> = {}): RemoveBacklogResult {
    const plant = (opts.plant as string | undefined) ?? sourceSelectedPlant();
    if (!plant) throw new Error('Remove Backlog requires a selected plant');
    const splitPolicy = Engine.splitOrderPolicyFor(plant);
    const { now, from, to } = normalizeBacklogRunDates(plant, opts);

    const diagnostics: RemoveBacklogDiagnostics = {
      backlogFound: 0, moved: 0, firmedMoved: 0, frozenMoved: 0, movedRuntimeHours: 0, largestDelayMinutes: 0,
      invalidRuntimeIds: [], missingStartIds: [], overlongIds: [], calendarSearchFailures: [], boundaryConflicts: [],
    };
    const lines = Array.isArray(opts.lines) && opts.lines.length
      ? new Set((opts.lines as unknown[]).map(String))
      : null;
    const grouped = new Map<string, Array<{ task: NimbusTask; snapshotStart: Date }>>();
    const scopedTasks = sourceTasksByPlant(plant).filter(t => !lines || lines.has(t.MACHINE || 'Unknown'));
    for (const task of scopedTasks) {
      // G-0.25: an approved placement exception is fixed; Remove Backlog leaves it where the planner put it.
      if (task.placement_exception) continue;
      if (!task.start_date) {
        diagnostics.missingStartIds.push(task.id);
        continue;
      }
      const snapshotStart = finiteDate(task.start_date);
      const snapshotEnd = finiteDate(task.end_date);
      if (!snapshotStart) {
        diagnostics.missingStartIds.push(task.id);
        continue;
      }
      // A repair pass may only move a trustworthy existing interval. A
      // one-sided, reversed, or invalid scheduled row is retained for an
      // explicit data-repair flow instead of being rewritten from RUN_TIME.
      if (!snapshotEnd || snapshotEnd <= snapshotStart) continue;
      if (snapshotStart < from || snapshotStart >= to) continue;
      const line = task.MACHINE || 'Unknown';
      const list = grouped.get(line) || [];
      list.push({ task, snapshotStart });
      grouped.set(line, list);
    }

    const patches: RemoveBacklogResult['patches'] = [];
    Calendar._beginRun(plant);
    try {
      for (const [line, items] of grouped) {
        if ((sourceLineSettings()[line] || {}).excludeFromOpt) continue;
        items.sort((a, b) => a.snapshotStart.getTime() - b.snapshotStart.getTime() || a.task.id.localeCompare(b.task.id));
        const firstBacklog = items.findIndex(item => item.snapshotStart < now);
        if (firstBacklog < 0) continue;
        diagnostics.backlogFound += items.filter(item => item.snapshotStart < now).length;
        // The compressing cursor walk is shared with the reversal queue (placeForwardSequence).
        const sequence = Engine.placeForwardSequence(
          line,
          items.slice(firstBacklog).map(item => ({ ...item, notBefore: item.snapshotStart >= now ? item.snapshotStart : undefined })),
          now, splitPolicy,
          { stopWhen: (item, cursor) => item.snapshotStart >= now && cursor <= item.snapshotStart });
        for (const item of sequence.invalidRuntime) diagnostics.invalidRuntimeIds.push(item.task.id);
        // OQ50 c: an order that cannot be one bar under the `never` policy is queued, not stretched over closed time.
        for (const item of sequence.overlong) {
          diagnostics.overlongIds.push(item.task.id);
          patches.push({ id: item.task.id, changes: Engine.overlongNeverChanges() });
        }
        if (sequence.failure) {
          diagnostics.calendarSearchFailures.push({ line, taskId: sequence.failure.item.task.id, reason: sequence.failure.reason });
        }
        for (const { item, start, end, scheduleSegments } of sequence.placed) {
          const runtimeHours = Number(item.task.RUN_TIME);
          const currentStart = item.snapshotStart.getTime();
          const currentEnd = finiteDate(item.task.end_date)?.getTime() ?? NaN;
          const segmentsChanged = scheduleSegments !== undefined
            && !Engine._sameScheduleSegments(item.task.scheduleSegments, scheduleSegments);
          if (currentStart === start.getTime() && currentEnd === end.getTime() && !segmentsChanged) continue;
          const changes: Partial<NimbusTask> = { start_date: start, end_date: end };
          if (scheduleSegments !== undefined) changes.scheduleSegments = scheduleSegments;
          patches.push({ id: item.task.id, changes });
          diagnostics.moved++;
          if (sourceIsFirmed(item.task.id)) diagnostics.firmedMoved++;
          if (Engine.isFrozenHorizon(item.task, now)) diagnostics.frozenMoved++;
          if (item.snapshotStart < now) diagnostics.movedRuntimeHours += runtimeHours;
          diagnostics.largestDelayMinutes = Math.max(diagnostics.largestDelayMinutes,
            Math.round((start.getTime() - item.snapshotStart.getTime()) / Config.MS_MIN));
        }
      }
    } finally {
      Calendar._endRun();
    }

    const patchById = new Map(patches.map(patch => [patch.id, patch]));
    for (const patch of patches) {
      const movedStart = patch.changes.start_date;
      const movedEnd = patch.changes.end_date;
      if (!movedStart || !movedEnd) continue;   // a queued (overlong_never) row has no bar to conflict
      const movedTask = sourceTask(patch.id);
      for (const protectedTask of scopedTasks) {
        if (protectedTask.MACHINE !== movedTask?.MACHINE || !protectedTask.start_date || !protectedTask.end_date) continue;
        if (protectedTask.start_date <= to || patchById.has(protectedTask.id)) continue;
        if (movedStart < protectedTask.end_date && movedEnd > protectedTask.start_date) {
          diagnostics.boundaryConflicts.push({ line: movedTask.MACHINE, movedTaskId: patch.id, protectedTaskId: protectedTask.id, type: 'overlap' });
        }
      }
    }
    return { patches, diagnostics };
  },

  /* ----- Per-plant switchable constraints (phased registry) -------------
     CONSTRAINT_CATALOG declares which fields are rankable; every enabled key
     gets an optimizer sort term generically (see _sortTerms). Per-plant config
     (which constraints are enabled, in what order, and — Stage 3 — nested
     under which parent) lives in plants.constraints JSONB, surfaced on
     Store.masterData.plants[*].constraints. */

  /** Now sourced dynamically from GET /priority-fields (App boot, cached here
   *  as the offline/loading-state fallback — R8). Order matches the backend
   *  registry (master_data.RANKABLE_FIELDS' declaration order). */
  CONSTRAINT_CATALOG: [
    { key: 'colorWheel', label: 'Color',
      desc: 'Sequence orders by color priority to minimize color changeovers.' },
  ] as Array<{ key: string; label: string; desc: string }>,

  /** Local, static field_key -> description fallback. `GET /priority-fields`
   *  (PriorityFieldMeta, frontend/types.mts) carries no description field — that's
   *  deliberate; Stage 3 keeps descriptions an entirely frontend concern
   *  rather than growing the backend contract for cosmetic copy. Same
   *  hardcoded-default-object shape as `_fieldTaskFields` below, so
   *  setConstraintCatalog has a real value to source `desc` from instead of
   *  hardcoding `''` (which blanked the Scheduling Constraints UI's
   *  per-field description text for every field once the registry started
   *  driving the catalog). Never written to by a registry call — there is
   *  nothing for the backend to merge in — so unlike `_fieldTaskFields` this
   *  stays read-only after module init. */
  _fieldDescriptions: {
    colorWheel:        'Sequence orders by color-wheel priority to minimize color changeovers.',
    prt01:             'Sequence orders by Prod. Resource Tool (01) priority.',
    prt02:             'Sequence orders by Prod. Resource Tool (02) priority.',
    productionVersion: 'Sequence orders by production-version priority.',
  } as Record<string, string>,

  /** Called once at boot (after GET /priority-fields resolves) to replace the
   *  hardcoded single-entry fallback above with the real registry. Safe to
   *  call multiple times (e.g. on /reload). MERGES per-key over whatever
   *  CONSTRAINT_CATALOG already holds (hardcoded default or a prior call's
   *  result) rather than replacing the whole array — an empty or partial
   *  response (a degraded /reload, or a future registry that only returns
   *  a subset) must not wipe out entries for fields it simply doesn't
   *  mention, mirroring setFieldTaskFields' merge semantics below. */
  setConstraintCatalog(fields: Array<{ field_key: string; default_label: string }>): void {
    if (!fields || !fields.length) return; // keep the offline fallback rather than emptying the list
    const byKey = new Map(Engine.CONSTRAINT_CATALOG.map(c => [c.key, c] as const));
    for (const f of fields) {
      if (!f.field_key) continue;
      byKey.set(f.field_key, {
        key: f.field_key,
        label: f.default_label,
        desc: Engine._fieldDescriptions[f.field_key] || '',
      });
    }
    Engine.CONSTRAINT_CATALOG = Array.from(byKey.values());
  },

  /** Ordered constraint config stored for a plant, or null if never configured. */
  constraintsFor(plant: string | null): ConstraintConfig[] | null {
    const row = sourceMasterData()?.plants?.find(p => p.plant === plant);
    const list = row && row.constraints;
    return Array.isArray(list) ? list : null;
  },

  /** Is a given constraint enabled for this plant? Unconfigured default:
   *  colorWheel ON (a no-op when the plant has no list — every lookup then
   *  returns 999999), everything else OFF. So "respect a wheel where one
   *  exists" emerges without a synchronous wheel probe in the optimizer.
   *
   *  TREE-AWARE (Stage 3). This used to be a top-level-only
   *  `constraintsFor(plant)?.find(x => x.key === key)`, which was harmless
   *  while `plants.constraints` was always a flat list — but nesting is now
   *  reachable from the Scheduling Constraints UI, and a key nested as a CHILD
   *  was invisible to that `find()`. It then fell through to the
   *  `key === 'colorWheel'` default and reported `true` for a colorWheel that
   *  was nested and switched OFF (and `false` for any non-colorWheel field
   *  configured below the root). Sequencing was never affected — _sortTerms
   *  goes through flattenConstraints, which has always walked the tree — but
   *  OptimizeDialog's pre-run "no color wheel configured" confirm
   *  (schedule-workbench.mts) reads this directly and could nag or stay
   *  silent for the wrong tree.
   *
   *  Semantics mirror flattenConstraints', so for a CONFIGURED (non-empty)
   *  tree the two are exactly equivalent —
   *  `constraintEnabled(p, k) === flattenConstraints(p).includes(k)`:
   *    • a disabled node takes its ENTIRE subtree with it (an unreachable
   *      priority is off, not "half-configured");
   *    • with the key present more than once, ANY reachable enabled occurrence
   *      makes it enabled — exactly the occurrence flattenConstraints would
   *      emit, so the answer is position-independent;
   *    • a key a configured tree does not mention AT ALL is off. It must not
   *      fall through to the colorWheel default — doing so reproduced the very
   *      same spurious-nag bug one level up, and it is reachable in practice:
   *      removing the Color Wheel row in the tree UI leaves a non-empty tree
   *      with no colorWheel node in it, where flattenConstraints correctly
   *      reports colorWheel as not in effect.
   *  The colorWheel-ON default therefore now applies to exactly one case: a
   *  plant with no stored tree at all (null, or an empty array — which
   *  flattenConstraints also treats as never-configured). That is also the only
   *  branch on which flattenConstraints routes back through here, via its own
   *  CONSTRAINT_CATALOG fallback, so there is no mutual recursion. (In that
   *  one branch the equivalence above is bounded by the catalog, since
   *  flattenConstraints can only emit keys the catalog lists.) */
  constraintEnabled(plant: string | null, key: string): boolean {
    const tree = Engine.constraintsFor(plant);
    if (!tree) return key === 'colorWheel';
    // `present` and `effective` are tracked separately so "configured but
    // unreachable" (found under a disabled ancestor, or itself disabled)
    // returns false instead of falling through to the default — that
    // fall-through is the actual bug this replaces.
    let present = false;
    let effective = false;
    const walk = (nodes: ConstraintConfig[], reachable: boolean): void => {
      for (const node of nodes) {
        const nodeReachable = reachable && !!node.enabled;
        if (node.key === key) {
          present = true;
          if (nodeReachable) effective = true;
        }
        if (node.children && node.children.length) walk(node.children, nodeReachable);
      }
    };
    walk(tree, true);
    // A configured tree is authoritative about what it omits; only a genuinely
    // empty/never-configured one gets the historical default.
    return present ? effective : (tree.length ? false : key === 'colorWheel');
  },

  /** Pre-order DFS flatten of the (possibly nested) constraint tree — a field
   *  nested under a field is mathematically identical to the next key in a
   *  lexicographic sort (docs/scheduling_priority.md "Sub-sort model"
   *  decision), so this is the ONLY tree-aware function in the optimizer;
   *  every existing caller of activeConstraintKeys (including _sortTerms)
   *  gets tree support for free. A disabled node skips its ENTIRE subtree
   *  (an unreachable priority is not "half-configured," it's off). An
   *  already-emitted key is skipped on a later occurrence (duplicates
   *  collapse — the UI marks these "(no effect)"). Falls back to the flat
   *  CONSTRAINT_CATALOG default (today: colorWheel only) when the plant has
   *  no stored tree at all, matching activeConstraintKeys' old behavior
   *  exactly for a never-configured plant. */
  flattenConstraints(plant: string | null): string[] {
    const tree = Engine.constraintsFor(plant);
    if (!tree || !tree.length) {
      return Engine.CONSTRAINT_CATALOG
        .filter(c => Engine.constraintEnabled(plant, c.key))
        .map(c => c.key);
    }
    return Engine._walkPriorityTree(tree).map(n => n.key);
  },

  /** THE tree walk — the single traversal `flattenConstraints` and
   *  `effectiveConstraintPaths` both run, so "which key is in effect" and
   *  "which NODE put it there" can never disagree. Returns the emitted nodes in
   *  effective order, each tagged with its positional `path`
   *  ("0", "0.2", "0.2.1" — index into the ORIGINAL sibling array at each
   *  level, not into the order-sorted view, so a caller rendering the array can
   *  address them directly).
   *
   *  Semantics, unchanged from the version that lived inline in
   *  `flattenConstraints`: siblings walk in `order` (stable, `?? 99`); a
   *  disabled node skips its ENTIRE subtree; a key already emitted is not
   *  emitted again, but its children are still walked (a duplicate parent can
   *  legitimately introduce a new child key). */
  _walkPriorityTree(tree: ConstraintConfig[]): Array<{ key: string; path: string }> {
    const seen = new Set<string>();
    const out: Array<{ key: string; path: string }> = [];
    const walk = (nodes: ConstraintConfig[], prefix: string): void => {
      // Sort a index-carrying copy so `path` stays keyed to the caller's own
      // array positions while traversal order follows `order`.
      const indexed = nodes.map((node, i) => ({ node, i }));
      indexed.sort((a, b) => (a.node.order ?? 99) - (b.node.order ?? 99));
      for (const { node, i } of indexed) {
        if (!node.enabled) continue; // disabled -> whole subtree skipped
        const path = prefix ? `${prefix}.${i}` : String(i);
        if (!seen.has(node.key)) { seen.add(node.key); out.push({ key: node.key, path }); }
        if (node.children && node.children.length) walk(node.children, path);
      }
    };
    walk(tree, '');
    return out;
  },

  /** Positional paths of the nodes that are ACTUALLY in effect in `tree` —
   *  i.e. exactly the occurrences `flattenConstraints` emits. Takes a tree
   *  rather than a plant because its consumer (the Scheduling Constraints
   *  "Effective sequence" panel) renders its own working copy of the tree, not
   *  the persisted one, and needs per-NODE truth about that copy.
   *
   *  Exists because `flat.includes(key)` cannot answer "is THIS row the one in
   *  effect?" when a key appears more than once: it credits whichever
   *  occurrence is walked first, which for a disabled duplicate preceding an
   *  enabled one is precisely backwards. */
  effectiveConstraintPaths(tree: ConstraintConfig[] | null): Set<string> {
    if (!tree || !tree.length) return new Set<string>();
    return new Set(Engine._walkPriorityTree(tree).map(n => n.path));
  },

  /** Delegates to flattenConstraints — every existing caller (this file's
   *  _sortTerms, and anything else that asked "which constraints are active,
   *  in order") picks up tree support with no call-site change. */
  activeConstraintKeys(plant: string | null): string[] {
    return Engine.flattenConstraints(plant);
  },

  /** Reads the task field a rankable key maps to. Sourced from the same
   *  GET /priority-fields registry as setConstraintCatalog — cached
   *  alongside it so this stays a pure lookup, no fetch.
   *
   *  The four known mappings are hardcoded as the offline fallback (the same
   *  pattern CONSTRAINT_CATALOG already uses) and the registry MERGES over
   *  them rather than replacing them, because a `key.toUpperCase()` guess is
   *  wrong for 3 of the 4 ('prt01' -> 'PRT01', not 'PRT_01';
   *  'productionVersion' -> 'PRODUCTIONVERSION', not 'PRODUCTION_VERSION').
   *  That path is reachable: flattenConstraints sources keys from the plant's
   *  STORED tree (Store.masterData), not from CONSTRAINT_CATALOG, so a plant
   *  with prt01 configured emits that key whether or not the /priority-fields
   *  fetch ever resolved (it has a `.catch(() => {})`). A wrong guess would
   *  make Util.norm(t['PRT01']) === '' -> rank 999999 for every order:
   *  configured, inert, silent. */
  _fieldTaskFields: {
    colorWheel:        'COLOR',
    prt01:             'PRT_01',
    prt02:             'PRT_02',
    productionVersion: 'PRODUCTION_VERSION',
  } as Record<string, string>,

  _taskFieldFor(key: string): string {
    const f = Engine._fieldTaskFields[key];
    if (f) return f;
    // No known mapping: warn rather than guess a field name that will
    // silently resolve to undefined for every order.
    reportSchedulerDiagnostic(
      'warn', 'engine', 'engine.unknown-task-field',
      `No task field registered for priority field "${key}" — orders will not rank on it.`, { key },
    );
    return '';
  },

  setFieldTaskFields(fields: Array<{ field_key: string; task_field: string }>): void {
    if (!fields || !fields.length) return; // keep the offline fallback
    for (const f of fields) {
      if (f.field_key && f.task_field) Engine._fieldTaskFields[f.field_key] = f.task_field;
    }
  },

  /** Does the loaded rank cache carry ANY ranks for this priority field —
   *  plant-wide ('') or scoped to a specific line? Reads the exact same
   *  Store.priorityRankMaps that _sortTerms' terms read, so every "is this
   *  field actually configured?" UI hint agrees with what a run will actually
   *  do. Two consumers today: OptimizeDialog's wheel badge + its pre-Run
   *  "no color wheel" confirm (schedule-workbench.mts) and Plant → System
   *  Settings' "(no wheel)" note (plant-and-administration.mts) — both
   *  previously probed `GET /color-wheel/{plant}` independently, which saw
   *  `line=''` rows only and so mis-reported a plant configured purely with
   *  per-line overrides.
   *
   *  A pure read: callers own making the cache fresh for the plant they care
   *  about (`Persistence._rankMapsPlant`). Both current callers' plant IS
   *  `Store.selectedPlant`, which is why this single non-plant-keyed cache is
   *  safe to read without a plant argument. */
  hasPriorityRanks(fieldKey: string): boolean {
    const byLine = sourcePriorityRankMaps() || {};
    for (const line of Object.keys(byLine)) {
      const m = byLine[line]?.[fieldKey];
      if (m && Object.keys(m).length > 0) return true;
    }
    return false;
  },

  /** Which of this plant's ACTIVE priority fields would rank nothing — i.e.
   *  are switched on in the tree but have no list loaded for them. The generic
   *  form of the old "does this plant have a color wheel?" question (N11,
   *  docs/scheduling_priority.md): every field in `flattenConstraints`' output
   *  contributes a real sort term now, so every one of them can be silently
   *  inert, not just colorWheel.
   *
   *  Reads the same `Store.priorityRankMaps` the terms read, so a cache that is
   *  empty because the fetch FAILED yields "every active field unranked" —
   *  which is the honest answer, and is what lets one call cover both
   *  "nothing uploaded" and "ranks unavailable" for the pre-Run confirm.
   *  Callers own cache freshness for the plant they pass
   *  (`Persistence._rankMapsPlant`), same contract as `hasPriorityRanks`. */
  unrankedActiveFields(plant: string | null): string[] {
    return Engine.activeConstraintKeys(plant).filter(k => !Engine.hasPriorityRanks(k));
  },

  /** Task fields whose change between two adjacent orders constitutes a
   *  changeover for this plant: every ACTIVE priority field's task field, plus
   *  FORM_SIZE (which `_sortTerms` appends to the tail unconditionally in both
   *  grouping modes, so form really is always part of what a run groups on).
   *
   *  The single source of truth for "what counts as a changeover", shared by
   *  `Util.countChangeovers` (via the resolver app.js injects — Util is the
   *  Foundation layer and must not import Engine) and the alert cell-briefing's
   *  own count, so the optimizer's objective and every number reported about it
   *  are derived from one list. For a never-configured plant this returns
   *  ['COLOR', 'FORM_SIZE'] — byte-identical to the hardcoded pair it
   *  replaces.
   *
   *  Reads `_fieldTaskFields` directly rather than through `_taskFieldFor`: an
   *  unregistered key is a sequencing concern and `_taskFieldFor` warns about
   *  it there, once per run. This runs on every KPI computation (twice per
   *  optimizer preview, and on Dashboard renders), so routing it through the
   *  warning path would turn one diagnostic into a flood of duplicates. */
  changeoverTaskFields(plant: string | null): string[] {
    const fields = Engine.activeConstraintKeys(plant)
      .map(k => Engine._fieldTaskFields[k])
      .filter(Boolean);
    if (!fields.includes('FORM_SIZE')) fields.push('FORM_SIZE');
    return fields;
  },

  /** Ordered list of sort terms for a mode — single source of truth for
   *  optimizer ordering, shared by _comparator and runAndApply's decorate
   *  sort. Term-factory rewrite (Stage 3, seam 3): each active constraint key
   *  (from flattenConstraints, so tree-aware for free) gets an ordinal term
   *  reading Store.priorityRankMaps — no more single hardcoded colorWheel
   *  branch, and ORDER_Y is no longer consulted at all. Key encoding is
   *  pad(rank,7)+'|'+value (N12): a fixed-width zero-padded rank so
   *  equal/unranked values GROUP by value instead of interleaving (999999
   *  unranked sorts after any real rank; two orders both at 999999 still sort
   *  deterministically against each other by value). Each term yields one
   *  scalar string key (a single allocation, not a decorate object) for a
   *  Schwartzian sort — same shape as before, just built generically instead
   *  of only for color.
   *
   *  opts.plant selects which plant's constraint tree applies. The line scope
   *  is resolved PER TASK inside each term's get(), off the task's *current*
   *  MACHINE (line override winning over plant-wide, ''), which is
   *  what makes a cross-line drag or an Orders-grid line edit picked up with
   *  no refetch (the N2 fix — see docs/scheduling_priority.md's Seam 1). */
  _sortTerms(mode: string, opts: { plant?: string | null } = {}): SortTerm[] {
    const { plant } = opts;
    const numCmp = (a: number, b: number) => a - b;
    const strCmp = (a: string, b: string) => a.localeCompare(b);

    if (mode === 'spt') {
      return [{ get: (t: NimbusTask) => Util.runHours(t), cmp: numCmp }];
    }
    if (mode === 'changeover') {
      // Changeover groups identical attributes adjacently to minimize setups.
      // Domain constraints come FIRST, in the plant's
      // configured (now possibly nested) order; the intrinsic form / material /
      // hours heuristic always follows as the tail.
      const terms: SortTerm[] = [];
      for (const key of Engine.activeConstraintKeys(plant ?? null)) {
        const taskField = Engine._taskFieldFor(key);
        // No registered task field (_taskFieldFor already warned): pushing the
        // term anyway would decorate every task, on every calendar day, with
        // the SAME constant '0999999|' key — pure cost for a term that can
        // never discriminate. Skip it instead.
        if (!taskField) continue;
        terms.push({
          get: (t: NimbusTask): string => {
            const v = Util.norm((t as unknown as Record<string, unknown>)[taskField]);
            const byLine = sourcePriorityRankMaps() || {};
            const line = t.MACHINE || '';
            // An EMPTY line-scoped map must fall through to the plant-wide list,
            // not shadow it: `??` only bridges null/undefined, and a stored
            // override with zero entries ({} — reachable from an all-blank-value
            // upload, which the generic upload route does not reject) is truthy.
            // Left unguarded, one such override silently unranked every order on
            // that line while every other line ranked correctly.
            const lineScoped = byLine[line]?.[key];
            const scoped = (lineScoped && Object.keys(lineScoped).length) ? lineScoped : byLine['']?.[key];
            const raw = scoped?.[v] ?? 999999;
            // Defensive floor on the SORT KEY, not on what gets stored or
            // uploaded: ranks are floats end to end (brain.py persists
            // float(rank), and JSON round-trips 1.5 verbatim), and a
            // non-integer — or a rank >= 1e7 — silently defeats the
            // fixed-width padding this encoding depends on.
            // String(1.5).padStart(7,'0') is '00001.5': already 7 chars, so
            // NOTHING is padded, and it compares AFTER '0000002' on the 4th
            // character. Round + clamp so the rank half is always exactly 7
            // digits and lexicographic order always matches numeric order.
            // (Whether fractional ranks should be a supported input at all is
            // a separate product question — this only guarantees the sort
            // can't silently invert.) A non-finite/non-numeric rank from a
            // malformed payload falls back to unranked rather than NaN.
            const rank = Number.isFinite(raw) ? Math.max(0, Math.min(9999999, Math.round(raw))) : 999999;
            return String(rank).padStart(7, '0') + '|' + v;
          },
          cmp: strCmp,
        });
      }
      terms.push({ get: (t: NimbusTask) => Util.norm(t.FORM_SIZE), cmp: strCmp });
      terms.push({ get: (t: NimbusTask) => Util.norm(t.MATERIAL_NUMBER), cmp: strCmp });
      terms.push({ get: (t: NimbusTask) => Util.runHours(t), cmp: numCmp });
      return terms;
    }
    return []; // default: preserve input order
  },

  /** Comparator built from _sortTerms — kept for callers that want a plain
   *  comparator. runAndApply uses the decorate variant for the Schwartzian win.
   *  For 'changeover' this reflects only the color/form-grouping tie-break
   *  order those terms encode — B3a (2026-08-21): 'changeover' no longer
   *  dispatches through any comparator-driven walk at all; it always routes
   *  through Engine.evaluateSetupAware('min-changeover', ...) instead (see
   *  runAndApply). */
  _comparator(mode: string, opts: { plant?: string | null } = {}): (a: NimbusTask, b: NimbusTask) => number {
    const terms = Engine._sortTerms(mode, opts);
    return (a, b) => {
      for (const tm of terms) { const c = tm.cmp(tm.get(a), tm.get(b)); if (c) return c; }
      return 0;
    };
  },

  /** Main optimiser. Groups by line, optionally respects firmed + calendar.
   *  Writes results through Store.
   *  opts.plant restricts to lines belonging to that plant. Priority ranks are
   *  no longer passed in — _sortTerms resolves them from Store.priorityRankMaps
   *  (kept current for the selected plant by Persistence.loadPriorityRankMaps),
   *  and every caller's effective plant IS Store.selectedPlant.
   *  opts.deadlineAt (Phase 2, Pkg D): an optional absolute performance.now()
   *  timestamp for the setup-aware evaluators' search deadline, consumed where
   *  DueDateFirstBounds.deadline is built below. Absent it, a fresh
   *  SETUP_AWARE_DEADLINE_MS window is used, unchanged from before. */
  runAndApply(mode: OptimizerMode = 'changeover', opts: Record<string, unknown> = {}): CandidateResult | void {
    const _pmT0e = performance.now();
    const candidateRun = opts.__candidateRun === true;
    // Mirrors lastBacklogResult's lifecycle: cleared at the top of every real
    // (non-candidate) run so it never goes stale after a later non-setup-aware
    // run, and always reflects the most recent live apply (F8).
    if (!candidateRun) Engine.lastSetupAwareResult = null;
    if (!sourceTasks().length) {
      if (!candidateRun) Toast.show(Util.t('toast.no_tasks_to_optimise'), 'error');
      return candidateRun ? detachedCandidateResult([], _pmT0e) : undefined;
    }
    const plant: string | null = (opts.plant as string | null | undefined) ?? sourceSelectedPlant();
    if (!plant) {
      if (!candidateRun) Toast.show(Util.t('toast.select_plant_before_opt'), 'warn');
      return candidateRun ? detachedCandidateResult([], _pmT0e, 'no-plant') : undefined;
    }
    // Remove Backlog is a schedule-repair pass, not an optimizer. Dispatch it
    // before priority-term creation so this path cannot accidentally read rank
    // maps, firmed protection, or the day-integrity resequencer.
    if (mode === 'backlog') {
      const backlogDates = normalizeBacklogRunDates(plant, opts);
      const result = Engine.removeBacklog({ ...opts, plant, runAt: backlogDates.runAt });
      if (candidateRun) {
        const baselineSnapshot = _candidateSnapshot ?? snapshotSchedule(plant);
        const validationSetup = Engine._syntheticZeroCostSetupSnapshot(plant, baselineSnapshot);
        const maxPatchedEnd = result.patches.reduce((latest, patch) => {
          const end = finiteDate(patch.changes.end_date)?.getTime() ?? NaN;
          return Number.isFinite(end) ? Math.max(latest, end) : latest;
        }, backlogDates.to.getTime());
        const validationHorizon = new Date(Math.min(8_640_000_000_000_000, maxPatchedEnd + 1));
        const allowedLines = Array.isArray(opts.lines) && opts.lines.length
          ? new Set((opts.lines as unknown[]).map(String)) : null;
        const backlogScope = backlogValidationScope(
          baselineSnapshot, plant, allowedLines, backlogDates.from, backlogDates.to,
        );
        const placementStart = new Date(Math.max(backlogDates.from.getTime(), backlogDates.now.getTime()));
        const backlogBounds: DueDateFirstBounds = {
          setup: validationSetup,
          exactSearchThreshold: SETUP_AWARE_EXACT_SEARCH_THRESHOLD,
          iterationCap: SETUP_AWARE_ITERATION_CAP,
          clock: () => performance.now(),
          deadline: (opts.deadlineAt as number | undefined) ?? performance.now() + SETUP_AWARE_DEADLINE_MS,
          now: placementStart,
          planningStart: backlogDates.from,
          runNow: backlogDates.now,
          placementStart,
          horizonEnd: validationHorizon,
          lines: Array.isArray(opts.lines) ? (opts.lines as unknown[]).map(String) : undefined,
          scopeTaskIds: backlogScope.scopeTaskIds,
          boundaryTaskIds: backlogScope.boundaryTaskIds,
          respectCalendar: true,
          notBefore: () => null,
          notAfter: () => null,
        };
        return attachDetachedValidationContext(
          detachedCandidateResult(result.patches, _pmT0e, 'completed', result),
          baselineSnapshot,
          backlogBounds,
          new Set(),
        );
      }
      Engine.lastBacklogResult = result;
      if (result.patches.length) Store.updateMany(result.patches, 'engine-backlog');
      Store.setLastOptimize(new Date(), 'engine-backlog');
      Alerts.clearDismissed();
      Alerts.scheduleRecompute();
      PerfMonitor.record('Engine.runAndApply', performance.now() - _pmT0e);
      return;
    }
    if (!candidateRun) Engine.lastBacklogResult = null;
    // CQ-1 Phase 2 Task 3: the pre-migration DOM-read fallback
    // (`document.getElementById('chk-respect-fixed'/'chk-respect-calendar')`)
    // referenced ids that do not exist anywhere in index.html/app.js's
    // rendered markup (confirmed by inspection) — the lookup always returned
    // null, so `?.checked` was always undefined and the `?? true` fallback
    // always applied. This plain default reproduces that real runtime
    // behavior exactly, while making Engine genuinely DOM-free.
    const respectFirmed   = (opts.respectFirmed as boolean | undefined)   ?? true;
    const respectCalendar = (opts.respectCalendar as boolean | undefined) ?? true;

    const plantTimezone = sourceMasterData()?.plants?.find(row => row.plant === plant)?.timezone ?? null;
    const invalidDateFields: string[] = [];
    const invalidDate = (): Date => new Date(Number.NaN);
    const readDate = (value: unknown, field: string, absolute = false): Date | null => {
      if (!hasExplicitDate(value)) return null;
      const parsed = normalizeOptimizerDate(value, plantTimezone, absolute);
      if (!parsed) invalidDateFields.push(field);
      return parsed;
    };
    const liveClock = (): Date => {
      // One clock (OQ52): the server instant in the plant's zone, floored to the minute. A plant with
      // no valid zone is blocked (recorded by Store.plantNow); the run keeps its viewer-clock fallback
      // here and placement-blocking for such plants belongs to the derivation tasks that follow.
      const now = Store.plantNow(plant);
      if (now) { now.setSeconds(0, 0); return now; }
      const fallback = Store.serverNow();
      fallback.setSeconds(0, 0);
      return plantWallClockFromInstant(plantTimezone, fallback) ?? fallback;
    };
    const injectedNow = candidateRun ? readDate(opts.now, 'now', true) : null;
    const explicitRunNow = hasExplicitDate(opts.runNow) ? readDate(opts.runNow, 'runNow', true)
      : hasExplicitDate(opts.runAt) ? readDate(opts.runAt, 'runAt', true)
        : injectedNow;
    const runNow = explicitRunNow ?? (invalidDateFields.length ? invalidDate() : liveClock());
    const explicitPlanning = hasExplicitDate(opts.planningStart) ? readDate(opts.planningStart, 'planningStart')
      : hasExplicitDate(opts.startDate) ? readDate(opts.startDate, 'startDate')
        : null;
    const planningStart = explicitPlanning ?? (invalidDateFields.length ? invalidDate() : new Date(runNow));
    // placementStart is derived only from planningStart and runNow. A legacy
    // supplied value is validated for a useful error, then deliberately
    // ignored so it cannot backdate newly generated work.
    if (hasExplicitDate(opts.placementStart)) readDate(opts.placementStart, 'placementStart');
    const placementStart = Number.isFinite(planningStart.getTime()) && Number.isFinite(runNow.getTime())
      ? new Date(Math.max(planningStart.getTime(), runNow.getTime()))
      : invalidDate();
    const explicitHorizonEnd = hasExplicitDate(opts.endDate) ? readDate(opts.endDate, 'endDate') : null;
    const horizonEnd = explicitHorizonEnd ?? (invalidDateFields.length
      ? invalidDate()
      : addLocalDays(planningStart, 35));
    if (invalidDateFields.length) {
      const invalid: CandidateResult = {
        ...detachedCandidateResult([], _pmT0e),
        status: 'invalid_horizon',
        explanation: [{ code: 'invalid_horizon', message: `The optimizer received invalid date input(s): ${invalidDateFields.join(', ')}.` }],
        diagnostics: {
          ...detachedCandidateResult([], _pmT0e).diagnostics,
          termination: 'infeasible',
          runtimeMs: performance.now() - _pmT0e,
          events: [],
        },
      };
      if (candidateRun) return invalid;
      Toast.show(invalid.explanation[0].message, 'error');
      return;
    }
    if (horizonEnd <= placementStart) {
      const invalid: CandidateResult = {
        ...detachedCandidateResult([], _pmT0e),
        status: 'invalid_horizon',
        explanation: [{ code: 'invalid_horizon', message: 'The optimizer horizon must end after the effective placement start.' }],
        diagnostics: {
          ...detachedCandidateResult([], _pmT0e).diagnostics,
          termination: 'infeasible',
          runtimeMs: performance.now() - _pmT0e,
          events: [],
        },
      };
      if (candidateRun) return invalid;
      Toast.show('The optimizer horizon must end after the effective placement start.', 'error');
      return;
    }

    // "Include Setup Times in Optimizer" (plants.setup_active, surfaced as
    // SetupSnapshot.plant_active — Workstream D2 relocated this off the
    // vestigial per-signature-version setup_definition.active) routes
    // changeover, duedate, and spt through the setup-aware evaluators
    // (setup-scheduler.mjs). This is the only optimizer path: the old
    // per-line forward walk and its policy-aware allocator are deleted
    // (backward-scheduling Task 3.1, OQ22). Search-safety limits are
    // hardcoded (see SETUP_AWARE_* above) —
    // the perf-measurement gate this was meant to come from was never run.
    //
    // B3a (2026-08-21): 'changeover' no longer falls through to the legacy
    // per-line walk at all, active-and-matching setup snapshot or not — that
    // walk (and its Engine._dispatchDayIntegrity tiering) is retired. When
    // there's no genuine active-and-matching snapshot, a fabricated
    // zero-cost one (Engine._syntheticZeroCostSetupSnapshot) stands in so the
    // SAME evaluator ('min-changeover') always decides changeover's
    // sequencing — the two dispatchers can no longer disagree about it.
    // 'duedate' (2026-09-09) routes exactly like 'changeover': it always
    // takes the setup-aware branch, synthesizing the same zero-cost snapshot
    // when the plant has no genuine active-and-matching one, but selects the
    // 'due-date' evaluator mode instead of 'min-changeover'.
    // 'spt' uses the same setup-aware evaluator as the other optimizer modes;
    // an inactive or mismatched setup snapshot receives the synthetic
    // zero-cost snapshot above so mode selection cannot silently switch
    // algorithms between plants.
    const setupSnapshot = _candidateSnapshot?.setupSnapshot !== undefined
      ? _candidateSnapshot.setupSnapshot
      : Store.setupSnapshot;
    const setupSnapshotActiveAndMatching = !!(setupSnapshot && setupSnapshot.plant === plant && setupSnapshot.plant_active);
    const baseSnapshot = _candidateSnapshot ?? snapshotSchedule(plant);
    const effectiveSetupSnapshot: SetupSnapshot = setupSnapshotActiveAndMatching
      ? setupSnapshot!
      : Engine._syntheticZeroCostSetupSnapshot(plant, baseSnapshot);
    const evaluatorMode = mode === 'spt' ? 'spt' : mode === 'duedate' ? 'due-date' : 'min-changeover';
    // Phase 2 (Pkg D): scope the fallback snapshot's calendars to this run's
    // plant — every consumer of ScheduleSnapshot.calendars in this path
    // (freeIntervalsFor/jointWindowForDay/hasNominalWindow in
    // setup-scheduler.mts, sourceLineWorkHours above) only ever looks up a
    // line that survived this same plant's task filter, so no other
    // plant's lines are ever needed here.
    // C2: fold any running or frozen-window order into the SAME firmedIds
    // set the setup-aware evaluators already treat as immovable — Engine.
    // isFrozenHorizon carries its own distinct reason for the UI (never
    // written to Store.isFirmed itself), this is purely an internal input
    // to the evaluator so it never re-sequences an order it shouldn't touch.
    // respectFirmed gates only the manual firmed ids. The running and
    // frozen-horizon folds are unconditional regardless of respectFirmed.
    // SAP's firm flag never locks. Passes runNow (this run's
    // own "now", injectedNow-aware for candidate runs) rather than the
    // real-time default, so a detached preview evaluated at a simulated
    // instant agrees with itself. Never written back to the Store — this
    // fold is run-local only (see effectiveFirmedIdSet).
    const effectiveFirmedIds = effectiveFirmedIdSet(baseSnapshot.tasks, baseSnapshot.firmedIds, runNow, respectFirmed, baseSnapshot.frozenHorizonEnd);
    const snapshot: ScheduleSnapshot = { ...baseSnapshot, firmedIds: effectiveFirmedIds };
    // F4: Calculate lines in scope for iteration cap scaling. If opts.lines is
    // provided, use its length (deduplicated); otherwise count distinct lines
    // in the snapshot's tasks for this plant.
    const optsLinesSet = Array.isArray(opts.lines) && opts.lines.length
      ? new Set(opts.lines as string[])
      : null;
    // An injected candidate snapshot may be unscoped (evaluateSchedule's
    // default is snapshotSchedule()), so count only this plant's non-blank
    // lines, resolved the same way the evaluator groups them.
    const linesInScope = optsLinesSet?.size ?? new Set(snapshot.tasks
      .filter(t => resolveTaskPlant(t, snapshot) === plant)
      .map(t => String(t.MACHINE ?? ''))
      .filter(Boolean)).size;
    const bounds: DueDateFirstBounds = {
      // Non-null by construction: this branch is only reached when either
      // mode is one of the setup-aware modes, so effectiveSetupSnapshot is
      // always the real active-and-matching snapshot or the synthetic
      // fallback.
      setup: effectiveSetupSnapshot,
      exactSearchThreshold: SETUP_AWARE_EXACT_SEARCH_THRESHOLD,
      // F4: Scale iteration cap per line. The cap is a stack-safety net; after
      // F2 a shared 20,000 iterations starved later lines on big plants. With
      // F1 no exact fragment exceeds ~500 leaves and greedy tops ~165 candidates
      // per fragment, so per-line scaling keeps the pool usable for every line.
      iterationCap: SETUP_AWARE_ITERATION_CAP * Math.max(1, linesInScope),
      clock: () => performance.now(),
      // Phase 2 (Pkg D): an absolute deadline the caller already computed
      // (e.g. the preview's one-shot primary budget, or the deferred Plan B
      // comparison's smaller budget) takes precedence over a fresh
      // SETUP_AWARE_DEADLINE_MS window here. A past `opts.deadlineAt` is
      // not special-cased: the search just terminates immediately with
      // tail placement, which is the existing, safe deadline-exceeded path.
      deadline: (opts.deadlineAt as number | undefined) ?? performance.now() + SETUP_AWARE_DEADLINE_MS,
      now: placementStart,
      planningStart,
      runNow,
      placementStart,
      horizonEnd,
      lines: Array.isArray(opts.lines) ? opts.lines as string[] : undefined,
      respectCalendar,
      notBefore: (task: NimbusTask) => Engine.earliestAllowedStart(task, plant, baseSnapshot.frozenHorizonEnd, baseSnapshot.masterData),
      notAfter: (task: NimbusTask) => Engine.latestAllowedEnd(task, plant, baseSnapshot.masterData),
      convergenceWindow: SETUP_AWARE_CONVERGENCE_WINDOW,
    };
    let result = Engine.evaluateSetupAware(evaluatorMode, bounds, snapshot);
    if (result.validationContext) result.validationContext = { ...result.validationContext, baselineSnapshot: baseSnapshot };
    // The setup-aware evaluators group every line for the plant with no
    // opts.lines/excludeFromOpt filter of their own (unlike the retired per-line walk) — apply both as a post-filter over the returned patches so a
    // line-scoped run or an opted-out line still behaves as promised.
    const optsLines = opts.lines as string[] | undefined;
    const allowedLines = Array.isArray(optsLines) && optsLines.length ? new Set(optsLines) : null;
    // Hoisted so an unfiltered run can still resolve a patched/unplaced id
    // back to its line below (B3/B4) — previously scoped inside the filter
    // guard, so an unfiltered run had no map to consult.
    const byId = new Map(snapshot.tasks.map(t => [String(t.id), t]));
    if (allowedLines || Object.values(sourceLineSettings()).some(setting => setting?.excludeFromOpt)) {
      result = {
        ...result,
        patches: result.patches.filter(patch => {
          const line = byId.get(String(patch.id))?.MACHINE || 'Unknown';
          if (allowedLines && !allowedLines.has(line)) return false;
          if (sourceLineSettings()[line]?.excludeFromOpt) return false;
          return true;
        }),
      };
    }
    if (candidateRun) return result;
    if (result.validationFindings?.some(finding => finding.severity === 'error')) {
      Engine.lastSetupAwareResult = result;
      return result;
    }
    if (result.patches.length) {
      const patchIds = new Set(result.patches.map(patch => patch.id));
      const undoTasks = structuredClone(snapshot.tasks.filter(task => patchIds.has(String(task.id))));
      UndoStack.push(`Optimization (${mode})`, () => UndoStack.restoreTasks(undoTasks), patchIds);
    }
    applySchedulePatches(result.patches);
    Engine.lastSetupAwareResult = result;
    Store.setLastOptimize(new Date(), 'engine');
    const hadDismissed = Alerts.clearDismissed();
    // Phase 3 (Pkg E): scope the recompute to the lines these patches actually
    // touched instead of a full-plant recompute. `byId` (built above from the
    // pre-apply snapshot) resolves each patch id to its line/MACHINE; patches
    // never change MACHINE, so pre- and post-apply line membership match.
    // If any alert was dismissed before this apply, a scoped merge would
    // retain untouched lines' stale (dismissal-filtered) alert lists as-is —
    // those cleared dismissals would never re-surface until some later full
    // recompute. A pending full recompute already wins over a scoped one by
    // design, so force it whenever there was something to clear.
    if (hadDismissed) Alerts.scheduleRecompute();
    else scheduleAlertsForPatches(result.patches, id => byId.get(String(id))?.MACHINE || 'Unknown', id => byId.get(String(id)));
    // Surface the never-freeze fallbacks that actually landed in this apply:
    // orders scheduled without a resolvable setup transition (no changeover
    // bar) and, separately, any line still guarded off entirely (only
    // firmed/override protection can do that now — see Part 1f). Both are
    // derived from the applied patches, never the whole-run diagnostics, so
    // a line-scoped/excludeFromOpt run only reports what it actually
    // touched.
    const patchedIds = new Set(result.patches.filter(patch => patch.changes.planning_status !== 'needs_planning').map(patch => String(patch.id)));
    const unknownSetupOrderIds = new Set<string>();
    const unknownSetupLines = new Set<string>();
    // 'scheduled-without-setup' (F1) is the single dedicated reason for an
    // order actually placed without a resolvable setup transition — emitted
    // both by `placeUnknownTail` (tail placement) and, since A1, by
    // `candidateForSequence`'s in-sequence admission of a known-but-uncovered
    // transition. Counting this reason instead of the raw
    // 'successor-state-unknown'/'initial-state-unknown' partition edges
    // avoids double-counting a rejected permutation's edge that happens to
    // name the same patched id.
    for (const edge of result.missingEdges) {
      if (edge.reason !== 'scheduled-without-setup') continue;
      if (!edge.successorOrderId || !patchedIds.has(String(edge.successorOrderId))) continue;
      unknownSetupOrderIds.add(String(edge.successorOrderId));
      unknownSetupLines.add(edge.line);
    }
    // A null successor signature is intentionally kept out of the covered
    // permutation core. Its deterministic tail placement is a distinct
    // unresolved-state fact, so include it in the same operator warning
    // without relabeling the edge as a known uncovered transition.
    for (const reason of result.explanation) {
      if (reason.code !== 'unknown-setup-tail-placement' || !reason.taskId || !patchedIds.has(String(reason.taskId))) continue;
      unknownSetupOrderIds.add(String(reason.taskId));
      unknownSetupLines.add(reason.line ?? byId.get(String(reason.taskId))?.MACHINE ?? 'Unknown');
    }
    // B3a: a synthetic (fabricated zero-cost) snapshot's matrix is always
    // empty by construction, so its uncovered-but-admitted edges are an
    // artifact of routing an inactive/never-configured plant through this
    // evaluator at all — never a real data gap the plant needs to fix.
    // Suppress ONLY this missing-setup-summary toast for a synthetic run.
    // The two toasts below (orders left in place / lines guarded) are NOT
    // setup-specific — they report genuine unplaced orders or untouched
    // lines for reasons that have nothing to do with setup data (e.g. a
    // permanently-uncalendarable order), so they must fire regardless of
    // `synthetic`. Blanket-suppressing them for every setup-inactive plant
    // would silently violate the never-freeze invariant's own "drops can't
    // happen silently" guarantee for the majority of NIMBUS plants — those
    // that haven't activated setup tracking. A genuinely active-and-
    // matching snapshot (synthetic undefined/false) is unaffected either way.
    if (unknownSetupOrderIds.size && !effectiveSetupSnapshot.synthetic) {
      Toast.show(Util.t('toast.optimize_missing_setup_summary', {
        orders: unknownSetupOrderIds.size,
        lines: unknownSetupLines.size,
      }), 'warn');
    }
    // Due-date push-forward limit (plants.max_push_forward_days): report
    // violations post-hoc from the applied patches, same as the missing-
    // setup summary above, but NOT gated on `synthetic` — a plant with no
    // active setup definition can still configure a push-forward cap, and
    // the never-freeze "minimize violations, always place everything" rule
    // applies regardless of the synthetic-snapshot mechanism.
    const overCapSummary = Engine._overCapSummary(result.patches, snapshot.tasks, plant);
    if (overCapSummary.orders) {
      Toast.show(Util.t('toast.optimize_over_lateness_cap', {
        orders: overCapSummary.orders,
        lines: overCapSummary.lines,
        // days is never null here: overCapSummary.orders > 0 only when the
        // plant has a configured limit (see _overCapSummary's null fast-exit).
        days: overCapSummary.days ?? 0,
      }), 'warn');
    }
    // Sub-order distribution separation (SAP aggregate work center -> per-
    // machine sub-orders): report parents whose siblings landed in
    // different calendar buckets, same post-hoc pattern as the push-
    // forward cap above and NOT gated on `synthetic` — separation is a
    // scheduling-outcome fact, not a setup-data fact, so it applies to
    // every plant regardless of setup-tracking activation.
    const distributionSeparationCount = result.validationFindings?.filter(f => f.code === 'distribution_separation').length ?? 0;
    if (distributionSeparationCount) {
      Toast.show(Util.t('toast.optimize_distribution_separation', { parents: distributionSeparationCount }), 'warn');
    }
    // B3: derive the unplaced set by difference, in this one place, rather
    // than threading an unplacedOrderIds field through CandidateResult —
    // the worst drops (plant/line mismatch, this same opts.lines/
    // excludeFromOpt post-filter, a firmed order the setup-aware path never
    // touches) produce no diagnostic object at all, so there is nothing for
    // a threaded field to collect. An order that places successfully
    // always yields a patch — even when its dates are unchanged — so
    // "in scope, not firmed, not patched" is exactly "not scheduled".
    // Scoping uses the SAME plant resolution as B7 (`t.PLANT ||
    // sourceGetPlantForLine(t.MACHINE)`) so this reporting and the
    // setup-aware evaluators' own scoping agree on which orders exist for
    // this plant. "Firmed" here means membership in `effectiveFirmedIds` —
    // the SAME effectively-folded set (manual + ECC-firmed, gated by
    // respectFirmed, plus the unconditional frozen-horizon fold; see
    // effectiveFirmedIdSet) actually handed to the evaluator above, not
    // just a manual `sourceIsFirmed` check — so an ECC-firmed or
    // frozen-horizon order the evaluator deliberately left untouched is
    // never miscounted here as "left in place".
    const unplacedLines = new Set<string>();
    let unplacedCount = 0;
    for (const task of snapshot.tasks) {
      const id = String(task.id);
      if (patchedIds.has(id)) continue;
      if (effectiveFirmedIds.has(id)) continue;
      const taskPlant = task.PLANT || sourceGetPlantForLine(task.MACHINE);
      if (taskPlant !== plant) continue;
      const line = task.MACHINE || 'Unknown';
      if (allowedLines && !allowedLines.has(line)) continue;
      if (sourceLineSettings()[line]?.excludeFromOpt) continue;
      unplacedCount += 1;
      unplacedLines.add(line);
    }
    if (unplacedCount) {
      Toast.show(`${unplacedCount} order(s) on ${unplacedLines.size} line(s) need planning. These orders have no committed schedule dates.`, 'warn');
    }
    if (result.unchangedLines.length) {
      Toast.show(Util.t('toast.optimize_lines_guarded', { count: result.unchangedLines.length }), 'warn');
    }
    PerfMonitor.record('Engine.runAndApply', performance.now() - _pmT0e);
    return;
  },

  /** After a manual edit to one task, re-flow subsequent unfirmed orders on the
   *  same line to eliminate overlap. Spans day boundaries so Day-1 overflow
   *  cascades correctly into Day-2 tasks. Does NOT move firmed orders (manual
   *  or ECC-firmed). */
  autoReflow(changedId: string): void {
    const changed = Store.tasks[changedId];
    if (!changed || !changed.start_date || !changed.end_date) return;
    // "Today" in the order's plant (one clock, OQ52); a blocked plant keeps the server instant read as
    // wall-clock, which is what this aged-task guard always did with the viewer's clock.
    const _horizonStart = Util.startOfDay(Engine._clockFor(changed) ?? Store.serverNow())!;
    if (changed.end_date < _horizonStart) return; // aged task — don't reflow
    const line = changed.MACHINE || 'Unknown';
    const splitPolicy = Engine.splitOrderPolicyFor(Store.getPlantForLine(line) ?? Store.selectedPlant);
    const setup = Store.setupSnapshot;
    const definition = setup?.definition;
    // Workstream D2: the real gate is plants.setup_active (setup.plant_active),
    // not the vestigial per-signature-version setup_definition.active.
    const setupActive = !!(setup && setup.plant_active && setup.plant === (changed.PLANT || Store.selectedPlant));
    const setupMinutes = (predecessor: NimbusTask, successor: NimbusTask): number => {
      if (!setupActive || !setup || !definition) return 0;
      const predecessorState = stateForOrder(predecessor, definition);
      const successorState = stateForOrder(successor, definition);
      if (!predecessorState || !successorState) return 0;
      const resolved = resolveSetup({
        definition, machine: line, predecessorState, successorState,
        predecessorOrderId: String(predecessor.id), successorOrderId: String(successor.id),
        plantRows: setup.plant_rows, machineRows: setup.machine_rows, overrides: setup.overrides,
      });
      return resolved.covered && resolved.effectiveMin != null ? resolved.effectiveMin : 0;
    };

    const peers = Store.tasksByPlant(Store.selectedPlant)
      .filter(t => (t.MACHINE || 'Unknown') === line
                && t.start_date && t.end_date
                && t.id !== changedId)
      .sort((a, b) => Number(a.start_date) - Number(b.start_date) || String(a.id).localeCompare(String(b.id)));

    // One deterministic forward walk: the direct drop stays untouched, then
    // covered setup is reserved before each permitted downstream peer.
    let cursor = new Date(changed.end_date);
    let predecessor = changed;
    const patches: Array<{ id: string; changes: Partial<NimbusTask> }> = [];
    if (splitPolicy !== 'never') {
      const plant = Store.getPlantForLine(line) ?? Store.selectedPlant;
      Calendar._beginRun(plant);
      try {
        for (const p of peers) {
          if (p.end_date! <= changed.start_date) continue;
          const requiredSetupMinutes = setupMinutes(predecessor, p);
          const requiredStart = new Date(cursor.getTime() + requiredSetupMinutes * Config.MS_MIN);
          if (p.start_date! >= requiredStart) { cursor = new Date(p.end_date!); predecessor = p; continue; }
          // G-0.25: a row carrying an approved placement exception is as fixed as a firmed one.
          if (Store.isFirmed(p.id) || p.placement_exception || Engine.isInProgress(p) || Engine.isFrozenHorizon(p) || p.end_date! < _horizonStart) {
            // Firmed, frozen-window, or aged orders don't move — if there's a
            // conflict, an alert will fire — but later unfirmed peers must
            // still be de-overlapped, and the immovable order becomes the
            // setup predecessor they pay for.
            cursor = new Date(Math.max(cursor.getTime(), p.end_date!.getTime()));
            predecessor = p;
            continue;
          }
          // C2: this peer is about to be MOVED (not merely left in place) —
          // its new start must never land inside the plant's frozen window.
          const placement = Calendar.placeWithSetup(line, {
            earliestStart: Engine.applyFrozenFloor(cursor), runtimeMinutes: Math.round(Util.runHours(p) * 60), policy: splitPolicy,
            setup: { kind: 'resolved', minutes: requiredSetupMinutes },
          });
          const changes: Partial<NimbusTask> | null = placement.kind === 'placed' && placement.productiveSegments.length
            ? {
              start_date: placement.productiveSegments[0].start,
              end_date: placement.productiveSegments.at(-1)!.end,
              scheduleSegments: placement.productiveSegments.length >= 2
                ? placement.productiveSegments.map((segment, index) => ({ sequence: index + 1, startDate: segment.start, endDate: segment.end }))
                : [],
            }
            : null;
          if (!changes?.start_date || !changes.end_date) {
            ErrorLog.warn('engine',
              `Could not reflow order "${p.text || p.id}" on "${line}" within the 90-day calendar search.`,
              { line, taskId: p.id, policy: splitPolicy });
            break;
          }
          patches.push({ id: p.id, changes });
          cursor = new Date(changes.end_date);
          predecessor = { ...p, ...changes };
        }
      } finally {
        Calendar._endRun();
      }
      if (patches.length) Store.updateMany(patches, 'engine');
      // A `tool-conflict` alert is emitted on the LATER order's line, and a
      // `distribution-separation` alert can be emitted on any sibling
      // sub-order's line — both can be a different line than this reflow's
      // own `line` — a moved task carrying a real PRT_01/PRT_02 tool id or a
      // PARENT_ORDER forces a full recompute instead of trusting the
      // single-line scope.
      if (taskCarriesTool(changed) || taskCarriesDistribution(changed)
        || patches.some(p => taskCarriesTool(Store.tasks[p.id]) || taskCarriesDistribution(Store.tasks[p.id])))
        Alerts.scheduleRecompute();
      else Alerts.scheduleRecomputeLines(new Set([line]));
      return;
    }
    for (const p of peers) {
      // Peer ends before the changed task starts — entirely prior, cannot overlap; skip.
      if (p.end_date! <= changed.start_date) continue;
      const requiredSetupMinutes = setupMinutes(predecessor, p);
      const requiredStart = new Date(cursor.getTime() + requiredSetupMinutes * Config.MS_MIN);
      if (p.start_date! >= requiredStart) { cursor = new Date(p.end_date!); predecessor = p; continue; }
      if (Store.isFirmed(p.id) || p.placement_exception || Engine.isInProgress(p) || Engine.isFrozenHorizon(p) || p.end_date! < _horizonStart) {
        // Firmed, frozen-window, or aged orders don't move — if there's a
        // conflict, an alert will fire — but later unfirmed peers must still
        // be de-overlapped, and the immovable order becomes the setup
        // predecessor they pay for.
        cursor = new Date(Math.max(cursor.getTime(), p.end_date!.getTime()));
        predecessor = p;
        continue;
      }
      // C2: this peer is about to be MOVED (not merely left in place) — its
      // new start must never land inside the plant's frozen window.
      const placement = Calendar.placeWithSetup(line, {
        earliestStart: Engine.applyFrozenFloor(cursor), runtimeMinutes: Math.round(Util.runHours(p) * 60), policy: splitPolicy,
        setup: { kind: 'resolved', minutes: requiredSetupMinutes },
      });
      if (placement.kind !== 'placed' || !placement.productiveSegments.length) {
        ErrorLog.warn('engine',
          `Could not reflow order "${p.text || p.id}" on "${line}" within the 90-day calendar search.`,
          { line, taskId: p.id, policy: splitPolicy });
        break;
      }
      const changes: Partial<NimbusTask> = {
        start_date: placement.productiveSegments[0].start,
        end_date: placement.productiveSegments.at(-1)!.end,
        scheduleSegments: placement.productiveSegments.length >= 2
          ? placement.productiveSegments.map((segment, index) => ({ sequence: index + 1, startDate: segment.start, endDate: segment.end }))
          : [],
      };
      patches.push({ id: p.id, changes });
      cursor = new Date(changes.end_date!);
      predecessor = { ...p, ...changes };
    }
    if (patches.length) Store.updateMany(patches, 'engine');
    // Reflow only ever shifts dates within `line`, so scope the alert recompute to it —
    // unless a moved task carries a real PRT_01/PRT_02 tool id or a PARENT_ORDER:
    // `tool-conflict` is emitted on the LATER order's (possibly different) line, and
    // `distribution-separation` can be emitted on any sibling sub-order's (possibly
    // different) line, so either case forces a full recompute instead of trusting the
    // single-line scope.
    if (taskCarriesTool(changed) || taskCarriesDistribution(changed)
      || patches.some(p => taskCarriesTool(Store.tasks[p.id]) || taskCarriesDistribution(Store.tasks[p.id])))
      Alerts.scheduleRecompute();
    else Alerts.scheduleRecomputeLines(new Set([line]));
  }
};

// CalendarSync emits this only after its authoritative plant hours and blackout
// slices have landed. Reconciliation is intentionally *not* subscribed to
// ordinary calendar edits or policy changes: those must alert existing schedules
// rather than silently rewrite them. A remote task refresh also retries a
// mismatch that arrived after the calendar was already hydrated.
Store.subscribe(evt => {
  if (evt.type === 'calendar:change' && evt.source === 'calendar-sync') {
    Engine.reconcileRuntimeSchedules(typeof evt.plant === 'string' ? evt.plant : Store.selectedPlant);
    return;
  }
  if (evt.type === 'tasks:bulkUpdate' && evt.source === 'refresh' && Array.isArray(evt.ids)) {
    const plants = new Set<string>();
    for (const id of evt.ids) {
      const task = Store.tasks[String(id)];
      // Only a refreshed row the reconcile could re-derive wakes a plant-wide pass (the same candidate test as
      // reconcileRuntimeSchedules): a refresh of rows that are all placed and current needs no pass (F16).
      if (!task || !(task.runtime_schedule_mismatch || !task.user_scheduled)
        || task.planning_status === 'needs_planning' || task.placement_exception || !task.MACHINE) continue;
      const plant = Store.getPlantForLine(task.MACHINE);
      if (plant) plants.add(plant);
    }
    for (const plant of plants) Engine.reconcileRuntimeSchedules(plant);
  }
}, 'engine.runtime-reconcile');

// OQ21: an undo restores the finish, so the start is re-derived under the run time as it is now. The Store cannot
// import the engine (platform sits below it); the engine registers this hook once at load.
UndoStack.afterRestore = (ids: string[], wasDirty: ReadonlySet<string>): void => Engine.reconcileRestored(ids, wasDirty);
// F10: the snapshot records which rows already carried unsaved edits (the platform cannot see Persistence).
UndoStack.dirtyProbe = (id: string): boolean => Persistence._dirtyIds.has(id);

/**
 * Evaluate against the existing placement algorithm, but with its reads bound
 * to `snapshot`.  This adapter shares the Engine's mode implementation; it
 * emits patches and never applies them while evaluating a candidate.
 *
 * Moved here verbatim from optimization/setup-scheduler.mts (this phase's
 * cycle-break, Part B step 3 — see optimization/scheduler-contract.mjs's
 * header comment for the full mechanics). Its only external caller is
 * optimization/optimize-ui.mts, which now imports it from here instead of
 * from setup-scheduler.mjs.
 */
export function evaluateSchedule(snapshot: Readonly<ScheduleSnapshot>, request: EvaluationRequest = {}): CandidateResult {
  const { mode = 'changeover', ...opts } = request;
  return Engine.evaluateSchedule(mode, opts, snapshot);
}

function rehydrateDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Reattach the function-bearing validation seam after a worker response.
 * Every date lookup was captured by the worker from its detached bounds, so
 * this reconstruction does not consult live master data or setup state. */
export function rehydrateOptimizerCandidate(
  candidate: CandidateResult,
  snapshot: ScheduleSnapshot,
  serialized?: SerializedOptimizerValidation,
): CandidateResult {
  if (!serialized || typeof serialized !== 'object') {
    throw new TypeError('Optimizer worker returned no validation metadata.');
  }
  const isObject = (value: unknown): value is Record<string, unknown> => (
    !!value && typeof value === 'object' && !Array.isArray(value)
  );
  const isDateFieldValid = (value: unknown): boolean => !!rehydrateDate(value as Date | string | number);
  const setup = isObject(serialized.setup) ? serialized.setup : null;
  const definition = setup?.definition;
  const validDefinition = definition === null || (isObject(definition)
    && Array.isArray(definition.fields)
    && definition.fields.every(field => typeof field === 'string')
    && Number.isInteger(definition.signature_version)
    && typeof definition.strict_blanks === 'boolean'
    && typeof definition.active === 'boolean');
  const validSetup = !!setup
    && typeof setup.plant === 'string'
    && typeof setup.plant_active === 'boolean'
    && validDefinition
    && Array.isArray(setup.plant_rows)
    && Array.isArray(setup.machine_rows)
    && Array.isArray(setup.machine_states)
    && Array.isArray(setup.overrides);
  const validDateMap = (value: unknown): value is Record<string, Date | string | number | null> => (
    isObject(value) && Object.values(value).every(entry => entry === null || !!rehydrateDate(entry as Date | string | number))
  );
  const malformed = (field: string): never => { throw new TypeError(`Optimizer worker returned malformed validation metadata: ${field}`); };
  if (!validSetup) malformed('setup');
  if (!Number.isInteger(serialized.exactSearchThreshold) || serialized.exactSearchThreshold < 0) malformed('exactSearchThreshold');
  if (!Number.isInteger(serialized.iterationCap) || serialized.iterationCap <= 0) malformed('iterationCap');
  if (!Number.isFinite(serialized.deadline)) malformed('deadline');
  if (!Array.isArray(serialized.effectiveFirmedIds)
    || !serialized.effectiveFirmedIds.every(id => typeof id === 'string')) malformed('effectiveFirmedIds');
  if (!validDateMap(serialized.notBeforeById)) malformed('notBeforeById');
  if (!validDateMap(serialized.notAfterById)) malformed('notAfterById');
  if (serialized.lines !== undefined && (!Array.isArray(serialized.lines) || !serialized.lines.every(line => typeof line === 'string'))) malformed('lines');
  if (serialized.scopeTaskIds !== undefined && (!Array.isArray(serialized.scopeTaskIds) || !serialized.scopeTaskIds.every(id => typeof id === 'string'))) malformed('scopeTaskIds');
  if (typeof serialized.respectCalendar !== 'boolean') malformed('respectCalendar');
  if (serialized.boundaryTaskIds !== undefined && (!Array.isArray(serialized.boundaryTaskIds) || !serialized.boundaryTaskIds.every(id => typeof id === 'string'))) malformed('boundaryTaskIds');
  if (!isDateFieldValid(serialized.now)) malformed('now');
  if (!isDateFieldValid(serialized.planningStart)) malformed('planningStart');
  if (!isDateFieldValid(serialized.runNow)) malformed('runNow');
  if (!isDateFieldValid(serialized.placementStart)) malformed('placementStart');
  if (!isDateFieldValid(serialized.horizonEnd)) malformed('horizonEnd');
  if (!snapshot.tasks.every(task => Object.prototype.hasOwnProperty.call(serialized.notBeforeById, String(task.id))
    && Object.prototype.hasOwnProperty.call(serialized.notAfterById, String(task.id)))) {
    throw new TypeError('Optimizer worker returned incomplete validation metadata.');
  }
  const now = rehydrateDate(serialized.now);
  const horizonEnd = rehydrateDate(serialized.horizonEnd);
  if (!now || !horizonEnd) throw new TypeError('Optimizer worker returned invalid validation metadata dates.');
  const planningStart = rehydrateDate(serialized.planningStart);
  const runNow = rehydrateDate(serialized.runNow);
  const placementStart = rehydrateDate(serialized.placementStart);
  if (!planningStart || !runNow || !placementStart) throw new TypeError('Optimizer worker returned invalid validation metadata dates.');
  const dateFor = (values: Readonly<Record<string, Date | string | number | null>>, task: NimbusTask): Date | null => (
    rehydrateDate(values[String(task.id)])
  );
  const bounds: DueDateFirstBounds = {
    setup: serialized.setup,
    exactSearchThreshold: serialized.exactSearchThreshold,
    iterationCap: serialized.iterationCap,
    clock: () => performance.now(),
    deadline: serialized.deadline,
    now,
    planningStart,
    runNow,
    placementStart,
    horizonEnd,
    lines: serialized.lines,
    scopeTaskIds: serialized.scopeTaskIds,
    boundaryTaskIds: serialized.boundaryTaskIds,
    respectCalendar: serialized.respectCalendar,
    notBefore: task => dateFor(serialized.notBeforeById, task),
    notAfter: task => dateFor(serialized.notAfterById, task),
  };
  const validationSnapshot: ScheduleSnapshot = {
    ...snapshot,
    firmedIds: new Set(serialized.effectiveFirmedIds),
  };
  return { ...candidate, validationContext: { snapshot: validationSnapshot, baselineSnapshot: snapshot, bounds } };
}
