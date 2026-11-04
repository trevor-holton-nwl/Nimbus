// optimization/engine.mjs — Engine (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split the former
// schedule-services.mts into 4 domain files, AND broke import cycle 1 between
// it and optimization/setup-scheduler.mjs as part of the same move — see
// optimization/scheduler-contract.mjs's header comment). Owns the optimizer
// (detached dispatch, auto-reflow), the detached candidate-evaluation machinery
// (`_candidateSnapshot`/the `source*` accessors below, which let the SAME
// Calendar capacity math answer either "against live Store" or "against one
// detached candidate snapshot" depending on whether a candidate run is in
// flight), setup-observation derivation, and the `evaluateSchedule` adapter
// that used to live in setup-scheduler.mts (see below).
//
// Cross-file notes (real couplings, not new ones — all three predate this
// phase, inside the former single schedule-services.mts file, as sibling top-level
// declarations the file's own comments already flagged as forward-references
// safe only because nothing fires until well after module evaluation
// completes):
//   - `Calendar` (calendar/calendar-engine.mjs) is imported for placement
//     (`Engine._evaluateDetached`/`autoReflow`/`reconcileRuntimeSchedules` etc. call
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
//   - `Alerts` (insights/services.mjs) is imported because
//     `Alerts.applyFix`'s auto-fix action calls
//     `Engine.splitOrderPolicyFor`/`schedulePatchFor`/`autoReflow`/
//     `evaluateSchedule` (the REVERSE edge), and this file's own
//     `removeBacklog`/`autoReflow`/`reconcileRuntimeSchedules` call
//     `Alerts.clearDismissed`/`scheduleRecompute`/`scheduleRecomputeLines`.
//     A genuine two-way ESM cycle between this file and
//     insights/services.mjs; safe under the same rule.
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
import { Calendar, candidateAllDayWorkHours, candidateDefaultWorkHours } from '../calendar/calendar-engine.mjs';
import { CalendarSync } from '../calendar/calendar-sync.mjs';
import { Persistence } from '../scheduling/persistence.mjs';
import { Alerts, taskCarriesTool, taskCarriesDistribution } from '../insights/services.mjs';
import {
  chargedSetupMinutesFor,
  placeWithSetup as placeWithSetupPure,
  placeWithFinishFloor,
  evaluateDueDateFirst as evaluateDueDateFirstPure,
  evaluateMinChangeover as evaluateMinChangeoverPure,
  evaluateSptWithSetup as evaluateSptWithSetupPure,
  evaluateThroughput as evaluateThroughputPure,
  fillPlanningGaps,
  attachDetachedValidationContext,
  SETUP_AWARE_CONVERGENCE_WINDOW,
  resolveTaskPlant,
  dueInstant,
  assertToolCoreFor,
} from './setup-scheduler.mjs';
import { buildSetupResolutionIndex, resolveSetup, stateForOrder } from '../setup/setup-domain.mjs';
import type { SetupResolutionIndex } from '../setup/setup-domain.mjs';
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
import type { NimbusTask, NimbusBlock, NimbusPlantBlock, WorkHours, NimbusLineSetting, NimbusMasterData, ConstraintConfig, OptimizerMode, OrderScheduleSegment, SplitOrderPolicy, SetupSnapshot, SetupDefinition, SetupStateKey, SetupValueDefault, PlantCalendarEntry, PlantPeriod } from '../platform/types.mjs';
import { MIN_PRODUCTIVE_SEGMENT_MINUTES, PRIORITY_FIELD_DEFAULTS } from './scheduler-contract.mjs';
import { SETUP_AWARE_NORMAL_BUDGET_MS, SETUP_AWARE_EXHAUSTIVE_BUDGET_MS } from './run-params.mjs';
import type { RemoveBacklogResult, RemoveBacklogDiagnostics, EngineEvaluationRequest } from './scheduler-contract.mjs';
import type { SerializedOptimizerValidation } from './optimizer-worker-contract.mjs';
import { firmActionForReasons, firmReasonLabels, planFirmActions } from './firm-actions.mjs';
import type { FirmAction, FirmPlan, FirmReason } from './firm-actions.mjs';

// -- Local type declarations (Phase 3 conversion; scoped to this file) ------
// Structurally identical to the copy in calendar/calendar-engine.mjs and
// insights/services.mjs (and platform/store.mjs's exported version) — same
// "duplicate this trivial 3-line type per file" convention already
// established between schedule-state.mts and the former schedule-services
// before the P4 split.
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

/** Setup minutes a Store-backed pass (autoReflow, reconcile) reserves for a transition: a covered row keeps its own
 *  minutes; an uncovered row or an unrecorded state is charged the plant's unknown-setup default under
 *  plantDefaultMinutes, exactly as the optimizer's `chargedSetupMinutes` does (same eligibility as
 *  `setupChargeableOnLine`: the plant has a setup definition and the line is setup-compatible). Callers gate on
 *  `setupSnapshot.plant_active`; `resolved` is null when a state is unrecorded. */
function storeChargedSetupMinutes(plant: string, line: string,
  resolved: { covered: boolean; effectiveMin: number | null } | null): number {
  const config = Store.masterData?.plants?.find(row => row.plant === plant)?.setup_policy_config;
  const policy = config?.unknownSetupPolicy;
  const stored = config?.unknownSetupDefaultMinutes;
  const defaultMin = Number.isInteger(stored) && (stored as number) >= 0 ? (stored as number) : 0;
  const chargeable = !!Store.setupSnapshot?.definition
    && Store.masterData?.lines?.find(row => row.plant === plant && row.machine === line)?.setup_compatible !== false;
  return chargedSetupMinutesFor(policy === 'plantDefaultMinutes' || policy === 'excludeFromSearch' ? policy : 'zero',
    defaultMin, !!resolved?.covered, resolved ? resolved.effectiveMin : null, chargeable);
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
  /** Routing plants: the production version chosen together with the line (a drop that picked one of several
   *  covering versions). `manualRoutingSchedulePatchFor` hands it to `pairSchedulePatchFor`. */
  chosenPv?: string;
}

/** Why the last manual placement returned null (read by callers right after the call). */
export type ManualRefusal = FinishRefusal | 'finish_cannot_hold' | 'needs_overtime_confirm' | 'running_finish_locked';

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
    // `tasks` is already the plant-filtered clone set, so no second plant filter is needed.
    const scopedLines = plant
      ? new Set(tasks
        .map(task => String(task.MACHINE ?? ''))
        .filter(Boolean))
      : null;
    const sourceCalendars = scopedLines
      ? Object.fromEntries(Object.entries(Store.calendars).filter(([line]) => scopedLines.has(line)))
      : Store.calendars;
    return {
      tasks,
      firmedIds: Array.from(Store.firmedIds), // manual firms only — running/frozen/placement-exception derivation joins at the setup-aware fold (SAP's firm flag never locks); do not union here.
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
      // One concrete instant captured NOW (the live getter rolls with the clock); the worker realm
      // has an empty Store, so it must only ever read this captured Date, never recompute it.
      frozenHorizonEnd: (() => { const end = Store.frozenHorizonEnd; return end ? new Date(end) : null; })(),
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
 * Frozen means the planned FINISH is inside the window (2026-10-27); a straddler
 * is movable, bounded by the finish floor (`Engine.frozenFinishFloor`).
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
  plants: Record<string, PlantCalendarEntry>;
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

/** A line missing from the snapshot's calendars follows its plant (compute-core ensureCalendar allDay): all-day when
 *  the plant resolves, else the default shift week. */
function setupLineFallbackHours(plantResolves: boolean): WorkHours {
  return plantResolves ? candidateAllDayWorkHours() : setupDefaultWorkHours();
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

/** U24: the cutover data signature needs at least this many non-queued rows, so a tiny plant or a small re-upload keeps its per-row toasts. */
const CUTOVER_MIN_ROWS = 10;
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
  const lineHours = context.calendars[line]?.workHours ?? setupLineFallbackHours(!!context.plants[mappedPlant]);
  const plantEntry = context.plants[mappedPlant];
  /** The line and plant working windows intersected for the day holding `day`, or null when closed.
   *  The plant pattern is resolved per day (a dated period replaces the default). */
  const windowOf = (day: Date): readonly [Date, Date] | null => {
    const lineWindow = globalThis.NimbusComputeCore!._dayWindow(lineHours, day);
    if (!lineWindow) return null;
    const plantHours = resolvePlantHoursOn(plantEntry, day) ?? setupDefaultWorkHours();
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

type SetupSpan = { task: NimbusTask; start: Date; end: Date };

/** One chain order for deriveSetupObservation and predecessorOnMachine: first-interval start, then end, then id. */
function compareSetupOrders(left: SetupSpan, right: SetupSpan): number {
  return left.start.getTime() - right.start.getTime()
    || left.end.getTime() - right.end.getTime()
    || String(left.task.id).localeCompare(String(right.task.id));
}

/**
 * The order scheduled immediately before `task` on its own plant/machine;
 * null when it is genuinely first; undefined ("unknown") when the task has no
 * interval, plant or machine to place it. Independent of any setup definition or matrix, so the
 * Inspector can name the predecessor even where no setup is derived. A split
 * order is one span, so its own segments never make it its own predecessor.
 */
export function predecessorOnMachine(task: NimbusTask, tasks: ReadonlyArray<NimbusTask>): NimbusTask | null | undefined {
  const plant = String(task.PLANT ?? task.plant ?? '');
  const line = String(task.MACHINE ?? '');
  if (!plant || !line) return undefined;
  const spanOf = (candidate: NimbusTask): SetupSpan | null => {
    const intervals = setupOrderIntervals(candidate);
    return intervals.length ? { task: candidate, start: intervals[0].start, end: intervals.at(-1)!.end } : null;
  };
  const own = spanOf(task);
  if (!own) return undefined;
  let best: SetupSpan | null = null;
  for (const candidate of tasks) {
    if (String(candidate.id) === String(task.id)) continue;
    if (String(candidate.PLANT ?? candidate.plant ?? '') !== plant || String(candidate.MACHINE ?? '') !== line) continue;
    const span = spanOf(candidate);
    if (!span || compareSetupOrders(span, own) >= 0) continue;
    if (!best || compareSetupOrders(span, best) > 0) best = span;
  }
  return best?.task ?? null;
}

/** One resolution index per setup snapshot object (WeakMap, so a replaced snapshot is collected with its index).
 *  The entry also remembers the definition, the three row arrays and their lengths it was built from; an entry
 *  whose inputs no longer match (a replaced array or a changed length) is rebuilt, never reused. Rows are replaced,
 *  never mutated in place, so an in-place edit that keeps the same arrays and lengths is NOT detected. */
const _setupIndexBySnapshot = new WeakMap<object, {
  definition: SetupDefinition; machineRows: ReadonlyArray<unknown>; plantRows: ReadonlyArray<unknown>;
  overrides: ReadonlyArray<unknown>; machineLen: number; plantLen: number; overridesLen: number;
  valueDefaults: ReadonlyArray<unknown>; valueDefaultsLen: number;
  index: SetupResolutionIndex;
}>();

/** Shared empty value-defaults list so an absent `value_defaults` allocates nothing per call. */
const NO_VALUE_DEFAULTS: ReadonlyArray<SetupValueDefault> = [];

/** The memoised `buildSetupResolutionIndex` for a snapshot with a definition. Resolving through it returns exactly
 *  what the unindexed linear scan returns (first matching row wins; see setup-resolution-index.test.mjs). */
export function setupResolutionIndexFor(setup: SetupSnapshot & { definition: SetupDefinition }): SetupResolutionIndex {
  const cached = _setupIndexBySnapshot.get(setup);
  if (cached
    && cached.definition === setup.definition
    && cached.machineRows === setup.machine_rows && cached.machineLen === setup.machine_rows.length
    && cached.plantRows === setup.plant_rows && cached.plantLen === setup.plant_rows.length
    && cached.overrides === setup.overrides && cached.overridesLen === setup.overrides.length
    && cached.valueDefaults === (setup.value_defaults ?? NO_VALUE_DEFAULTS)
    && cached.valueDefaultsLen === (setup.value_defaults ?? NO_VALUE_DEFAULTS).length) return cached.index;
  const index = buildSetupResolutionIndex({
    definition: setup.definition, machineRows: setup.machine_rows, plantRows: setup.plant_rows, overrides: setup.overrides, valueDefaults: setup.value_defaults ?? NO_VALUE_DEFAULTS,
  });
  _setupIndexBySnapshot.set(setup, {
    definition: setup.definition, machineRows: setup.machine_rows, plantRows: setup.plant_rows, overrides: setup.overrides, valueDefaults: setup.value_defaults ?? NO_VALUE_DEFAULTS,
    machineLen: setup.machine_rows.length, plantLen: setup.plant_rows.length, overridesLen: setup.overrides.length,
    valueDefaultsLen: (setup.value_defaults ?? NO_VALUE_DEFAULTS).length, index,
  });
  return index;
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
  const _pmT0 = performance.now();
  try {
    return deriveSetupObservationUntimed(setup, tasks, scopedLines, availability);
  } finally {
    PerfMonitor.record('Setup.deriveObservation', performance.now() - _pmT0);
  }
}

/** @internal Test-only reference path for parity tests: the same derivation resolving every pair through the linear scans. */
export function deriveSetupObservationUnindexed(
  setup: SetupSnapshot | null | undefined,
  tasks: ReadonlyArray<NimbusTask>,
  scopedLines?: ReadonlySet<string>,
  availability?: SetupAvailabilityContext,
): SetupObservation {
  return deriveSetupObservationUntimed(setup, tasks, scopedLines, availability, false);
}

function deriveSetupObservationUntimed(
  setup: SetupSnapshot | null | undefined,
  tasks: ReadonlyArray<NimbusTask>,
  scopedLines?: ReadonlySet<string>,
  availability?: SetupAvailabilityContext,
  indexed = true,
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
  // P1-13: only the diagnostic messages read this, so it is built on first use.
  let taskByIdMemo: Map<string, NimbusTask> | null = null;
  const taskById = {
    get: (id: string): NimbusTask | undefined => (taskByIdMemo ??= new Map(tasks.map(task => [String(task.id), task]))).get(id),
  };
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

  // Built on the first covered-pair resolution (many passes never reach one); shared across lines.
  let resolutionIndex: SetupResolutionIndex | null = null;
  const lines = new Set(byLine.keys());
  // P1-13: active overrides grouped once (setup.overrides order kept within a machine).
  const activeOverridesByMachine = new Map<string, Array<(typeof setup.overrides)[number]>>();
  for (const override of setup.overrides) {
    if (override.status !== 'active') continue;
    const bucket = activeOverridesByMachine.get(override.machine);
    if (bucket) bucket.push(override); else activeOverridesByMachine.set(override.machine, [override]);
  }
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
    orders.sort(compareSetupOrders);
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
        if (indexed) resolutionIndex ??= setupResolutionIndexFor(setup as SetupSnapshot & { definition: SetupDefinition });
        const resolved = resolveSetup({
          definition, machine: line, predecessorState, successorState, predecessorOrderId, successorOrderId: String(order.task.id),
          plantRows: setup.plant_rows, machineRows: setup.machine_rows, overrides: setup.overrides, valueDefaults: setup.value_defaults ?? NO_VALUE_DEFAULTS, index: resolutionIndex ?? undefined,
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

    for (const override of activeOverridesByMachine.get(line) ?? []) {
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
// The two budgets live in the pure run-params leaf (shared with the dialog and the headless CLI); re-exported here.
export { SETUP_AWARE_NORMAL_BUDGET_MS, SETUP_AWARE_EXHAUSTIVE_BUDGET_MS };
const SETUP_AWARE_EXHAUSTIVE_EXACT_SEARCH_THRESHOLD = 10;
const SETUP_AWARE_EXHAUSTIVE_EXACT_LEAF_CAP = 5000;
const SETUP_AWARE_EXHAUSTIVE_CONVERGENCE_WINDOW = 10000;
function gapFillBudgetFor(searchBudgetMs: number | undefined): number {
  if (searchBudgetMs === undefined) return 1000;
  if (searchBudgetMs >= SETUP_AWARE_EXHAUSTIVE_BUDGET_MS) return 36000;
  if (searchBudgetMs >= SETUP_AWARE_NORMAL_BUDGET_MS) return 2000;
  return 1000;
}

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

/** The default optimizer / Remove Backlog window when the caller gives no end date. */
const DEFAULT_HORIZON_DAYS = 35;

function addLocalDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/** The reconcile's candidate test, shared by the plant pass and the refresh wake-up: a row flagged stale or never placed,
 *  not queued, carrying no placement exception, and with a machine. (The unsaved-edit skip is applied by the pass only.) */
function isReconcileEligible(task: NimbusTask): boolean {
  return !!(task.runtime_schedule_mismatch || !task.user_scheduled)
    && task.planning_status !== 'needs_planning' && !task.placement_exception && !!task.MACHINE;
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
  const parseAbsolute = (value: unknown): Date | null => (hasExplicitDate(value) ? finiteDate(value) : null);
  const runAt = parseAbsolute(opts.runAt) ?? (hasExplicitDate(opts.runAt) ? null : Store.serverNow());
  if (!runAt) throw new Error('Remove Backlog requires a valid runAt timestamp');
  const now = Engine._plantWallNow(timezone, runAt);
  const from = hasExplicitDate(opts.startDate)
    ? normalizeOptimizerDate(opts.startDate, timezone)
    : new Date(now);
  const to = hasExplicitDate(opts.endDate)
    ? normalizeOptimizerDate(opts.endDate, timezone)
    : addLocalDays(now, DEFAULT_HORIZON_DAYS);
  if (!from || !to || to <= from) throw new Error('Remove Backlog requires a valid From and To date range');
  return { runAt, now, from, to };
}

/** The one reading of an order's run time, in whole minutes (0 when missing, unparsable or non-finite). Every
 *  placement site and the Remove Backlog scope use it, so a sub-30-second or unit-suffixed RUN_TIME is judged
 *  the same way everywhere. */
function runMinutesOf(task: NimbusTask): number {
  const minutes = Math.round(Util.runHours(task) * 60);
  return Number.isFinite(minutes) ? minutes : 0;
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
  from: Date, to: Date, held: ReadonlySet<string> = new Set(),
): { scopeTaskIds: string[]; boundaryTaskIds: string[] } {
  const candidates = snapshot.tasks.filter(task => {
    const line = String(task.MACHINE || 'Unknown');
    return resolveTaskPlant(task, snapshot) === plant
      && (!lines || lines.has(line))
      && !snapshot.lineSettings[line]?.excludeFromOpt;
  });
  const valid = candidates.flatMap(task => {
    const start = finiteDate(task.start_date);
    const end = finiteDate(task.end_date);
    return start && end && end > start ? [{ task, start, usableRuntime: runMinutesOf(task) > 0 }] : [];
  });
  const selected = new Set(valid
    // `held` (holdRunning): an order left where it is is a boundary row, never a scope row the run must account for.
    // A placement-exception row is skipped by the run (fixed where the planner put it), so it is boundary-only here.
    .filter(({ task, start, usableRuntime }) => usableRuntime && !task.placement_exception
      && start >= from && start < to && !held.has(String(task.id)))
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
/** The plant's IANA zone (trimmed), or null when unset. Reads the detached candidate snapshot when one is installed. */
function plantTimezoneFor(plant: string | null | undefined): string | null {
  return sourceMasterData()?.plants?.find(row => row.plant === plant)?.timezone?.trim() || null;
}
/** Whether the plant has the routing run-time calculation switched on (same source rule as `plantTimezoneFor`). */
function routingEnabledFor(plant: string | null | undefined): boolean {
  return !!sourceMasterData()?.plants?.some(p => p.plant === plant && p.routing_runtime_enabled);
}
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
  // An array is never mutated after the snapshot is built: one Set per array (V-E1-01).
  let set = _firmedArraySets.get(firmed);
  if (!set) { set = new Set(firmed.map(String)); _firmedArraySets.set(firmed, set); }
  return set.has(String(id));
}
const _firmedArraySets = new WeakMap<readonly string[], ReadonlySet<string>>();



export function sourceLineWorkHours(line: string): WorkHours {
  if (!_candidateSnapshot) {
    Store.ensureCalendar(line);
    return Store.calendars[line].workHours;
  }
  return _candidateSnapshot.calendars[line]?.workHours
    ?? (sourceGetPlantForLine(line) ? candidateAllDayWorkHours() : candidateDefaultWorkHours());
}

/** The order's SAP due as an instant for the date-window bounds below: a date-only (exact
 *  midnight) value reads as the end of that date's working window, exactly as the detached
 *  scheduler's own `allowedPlanningWindow` reads it (same `dueInstant`), so the two bounds
 *  agree. Reads calendar rows without creating defaults. Null when the order has no SAP due. */
function sourceDueInstant(
  task: NimbusTask, plant: string | null,
  view?: Pick<ScheduleSnapshot, 'calendars' | 'plants' | 'lineSettings' | 'masterData'> | null,
): Date | null {
  // An explicit `view` wins over the ambient `_candidateSnapshot`: the optimizer worker serializes the
  // engine's bounds closures AFTER the run ends (optimizer-worker.mts), when `_candidateSnapshot` is already
  // null and the realm's Store is empty, so those closures must pass their captured snapshot here.
  const src = view ?? _candidateSnapshot ?? {
    calendars: Store.calendars, plants: Store.plants, lineSettings: Store.lineSettings, masterData: Store.masterData,
  };
  return dueInstant(task, { snapshot: src, plant });
}

/** The plant's weekly hours. With `date`, the pattern active on that date (a dated period replaces
 *  the default); without it, the default pattern. The no-periods path returns the default by reference. */
export function sourcePlantWorkHours(plant: string, date?: Date): WorkHours {
  if (!_candidateSnapshot) {
    Store.ensurePlant(plant);
    const entry = Store.plants[plant];
    return date ? (resolvePlantHoursOn(entry, date) ?? entry.workHours) : entry.workHours;
  }
  const entry = _candidateSnapshot.plants[plant];
  if (!entry) return candidateDefaultWorkHours();
  return date ? (resolvePlantHoursOn(entry, date) ?? candidateDefaultWorkHours()) : entry.workHours;
}

/** The plant's weekly hours on `date`. No periods: `entry.workHours` by reference with no compute-core call
 *  (so a stale core cannot affect plants without periods). With periods the core's `plantWorkHoursOn` is
 *  required; a missing one throws `compute-core-stale` (the optimizer worker client falls back to the main
 *  thread) rather than silently using the default pattern. */
export function resolvePlantHoursOn(entry: PlantCalendarEntry | undefined, date: Date): WorkHours | undefined {
  if (!entry) return undefined;
  if (!entry.periods?.length) return entry.workHours;
  const core = globalThis.NimbusComputeCore;
  if (!core || typeof core.plantWorkHoursOn !== 'function') throw new Error('compute-core-stale');
  return core.plantWorkHoursOn(entry, date);
}

const NO_PERIODS: ReadonlyArray<PlantPeriod> = Object.freeze([]);

/** The plant's dated calendar periods (live Store entry, or the detached candidate snapshot's); `[]` when none. */
export function sourcePlantPeriods(plant: string): ReadonlyArray<PlantPeriod> {
  const entry = _candidateSnapshot ? _candidateSnapshot.plants[plant] : Store.plants[plant];
  return entry?.periods ?? NO_PERIODS;
}

/** A tool pass that threw fails closed (tool_overflow_failed blocks Apply); this also carries the thrown message to the
 *  planner's diagnostics (a detached run) or ErrorLog (a live run), where it was previously dropped. */
function withToolPassDiagnostic(candidate: CandidateResult): CandidateResult {
  const pass = candidate.toolPass;
  if (!pass?.failed) return candidate;
  reportSchedulerDiagnostic(
    'error', 'optimizer', 'optimizer.tool-overflow-failed',
    `Tool overflow pass failed: ${pass.error ?? 'unknown error'}`, { error: pass.error ?? null },
  );
  const event = _candidateDiagnostics?.at(-1);
  if (!event) return candidate;
  return { ...candidate, diagnostics: { ...candidate.diagnostics, events: [...candidate.diagnostics.events, event] } };
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
      // Label for a result that never ran a search (empty scope, no plant, Remove Backlog's patches). The union member keeps
      // its historical name (setup-scheduler.mts `SearchDiagnostics.method`); it no longer implies a legacy walk exists.
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
     • evaluateSchedule(mode, opts, snapshot): the detached global re-optimise
       (respecting firmed + calendars). It returns patches only; the caller
       commits them (the Optimize preview's Apply, or `applySchedulePatches`).
       The old live runAndApply tail was deleted (P3-3b); the body is
       `Engine._evaluateDetached`.
     • autoReflow(changedId): after a manual edit, re-flow downstream orders on
       the same (line, day) around the change.
   Genuinely DOM-free (CQ-1 Phase 2 Task 3 removed the last DOM read — a
   `document.getElementById('chk-respect-fixed'/'chk-respect-calendar')`
   fallback whose target ids do not exist anywhere in the rendered markup, so
   the lookup always returned null and the `?? true` default always applied;
   see `respectFirmed`/`respectCalendar` in `_evaluateDetached`).
   ========================================================================== */
export const Engine = {
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
      return Engine._evaluateDetached(mode, opts);
    } finally {
      _candidateSnapshot = null;
      _candidateDiagnostics = null;
      PerfMonitor.record('Engine.evaluateSchedule', performance.now() - _pmT0es);
    }
  },

  /** Explicit detached setup-aware seam, called by `_evaluateDetached` (and directly by tests). A caller must supply
   * both the immutable snapshot and the measured search bounds/setup truth before any setup-aware candidate exists. */
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
      return withToolPassDiagnostic(fillPlanningGaps(snapshot, bounds, candidate, bounds.gapFillBudgetMs));
    }
    return evaluateThroughputPure(snapshot, bounds, thresholds ?? {
      throughputMinSavingsMin: 60,
      throughputMaxSlipMin: 1440,
    });
  },

  /** B3a: fabricates a `plant_active: true`, zero-cost `SetupSnapshot` so
   *  `_evaluateDetached`'s `'changeover'` path can route an inactive (or
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

  /** C2 (2026-08-20; rolling since 2026-10-19): the plant's frozen-horizon far
   *  edge, plant-local now + frozen_horizon_days days. Both edges of the frozen
   *  window advance with the clock (like the alert horizon); the value is
   *  computed live by the `Store.frozenHorizonEnd` getter from the plant clock
   *  and master data (mirrors db.compute_frozen_horizon_end), so every call
   *  can return a later instant than the last. null when the plant has no
   *  frozen window (frozen_horizon_days NULL/0) or no valid plant clock. */
  frozenHorizonEnd(): Date | null {
    return Store.frozenHorizonEnd;
  },

  /** True when `task`'s planned FINISH falls inside the plant's frozen window
   *  `[now, frozenHorizonEnd)` (finish-based since 2026-10-27, following SAP's
   *  planning time fence; it replaces the start-based OD-C2a rule, OQ27 and R26).
   *  Persisted placement only (`hasPersistedPlacement`). Rules:
   *   - An order that STRADDLES the edge (starts inside, finishes at or after
   *     it) is NOT frozen: Optimize may move it. The optimizer's frozen floor
   *     is a FINISH floor (`Engine.frozenFinishFloor`), so no unprotected order
   *     may end inside the window.
   *   - An overdue order (finish already past `now`) is NOT frozen.
   *   - finish == frozenHorizonEnd is not frozen (exclusive edge); finish == now is.
   *   - Only `end_date` is read, so a finish-only placed row (a distribution
   *     child with a NULL scheduled start) freezes on its real held finish.
   *  The window is bounded on BOTH sides, matching the Gantt's
   *  `.frozen-horizon-zone` band `[now, now + frozen days]`. `now` defaults to
   *  the task's plant clock (`_clockFor`); callers carrying their own
   *  authoritative "now" (`_evaluateDetached`'s runNow, removeBacklog's plant-wall
   *  clock) pass it so one run never splits across two clocks.
   *
   *  A frozen order is implicitly pinned by every optimizer/auto-reflow
   *  placement site: a reason DISTINCT from Store.isFirmed (a manual pin) so
   *  the UI can explain why it didn't move. This check alone blocks nothing;
   *  callers decide what "pinned" means. Manual drags never consult it (OD-C2c). */
  isFrozenHorizon(task: NimbusTask, now?: Date, frozenHorizonEnd?: Date | null): boolean {
    if (!task.end_date || !Engine.hasPersistedPlacement(task)) return false;
    const end = frozenHorizonEnd === undefined ? Engine.frozenHorizonEnd() : frozenHorizonEnd;
    if (!end) return false;
    const at = now ?? Engine._clockFor(task);
    // A plant with no valid timezone has no clock (OQ52): not frozen, never a throw.
    return !!at && task.end_date >= at && task.end_date < end;
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
  firmingStatus(task: NimbusTask, now?: Date): { firmed: boolean; reasons: FirmReason[] } {
    const reasons: FirmReason[] = [];
    if (Engine.isFrozenHorizon(task, now)) reasons.push('frozen');
    if (Store.isFirmed(task.id)) reasons.push('manual');
    if (Engine.isInProgress(task, now)) reasons.push('running');
    return { firmed: reasons.length > 0, reasons };
  },

  /** The one firm/unfirm action a surface may offer for `task` (D4): 'firm' when
   *  nothing firms it, 'unfirm' when only the planner does, null when the frozen
   *  horizon or a running state firms it (a planner can still drag it). UI/live
   *  path only. Callers re-check at click time because the window rolls. */
  firmActionFor(task: NimbusTask, now?: Date): FirmAction {
    return firmActionForReasons(Engine.firmingStatus(task, now).reasons);
  },

  /** Split `ids` into firm / unfirm / locked lists with ONE shared clock per
   *  plant and one frozenEnd (firmingStatus alone costs ~3 plantNow calls per
   *  task, so a 5,000-row selection must not repeat them). Ids that no longer
   *  resolve to a task are dropped. */
  firmPlan(ids: ReadonlyArray<string | number>, now?: Date): FirmPlan {
    const frozenEnd = Engine.frozenHorizonEnd();
    const clocks = new Map<string, Date | null>();
    return planFirmActions(ids, id => {
      const task = Store.tasks[id];
      if (!task) return null;
      let at: Date | null | undefined = now;
      if (at === undefined) {
        const plant = task.PLANT || (task.MACHINE ? Store.getPlantForLine(task.MACHINE) : null) || Store.selectedPlant || '';
        if (!clocks.has(plant)) clocks.set(plant, Store.plantNow(plant || null));
        at = clocks.get(plant) ?? null;
      }
      const reasons: FirmReason[] = [];
      if (at && frozenEnd && Engine.isFrozenHorizon(task, at, frozenEnd)) reasons.push('frozen');
      if (Store.isFirmed(task.id)) reasons.push('manual');
      if (at && Engine.isInProgress(task, at)) reasons.push('running');
      return reasons;
    });
  },

  /** "Running · Frozen horizon (finishes before Thu 30 Oct) · Planner", or ''
   *  when nothing firms the order. */
  firmReasonsText(task: NimbusTask): string {
    const { reasons } = Engine.firmingStatus(task);
    const end = Engine.frozenHorizonEnd();
    // The edge is an instant (plant-local now + N days): date AND time, through the per-user
    // date/time display prefs (the same formatter the Inspector uses), never the browser locale.
    const frozenUntil = end && reasons.includes('frozen') ? Util.fmtDTReadable(end) : null;
    return firmReasonLabels(reasons, { t: Util.t, frozenUntil }).join(' · ');
  },

  /** One line for tooltips and diagnostics: "Firmed: <reasons>" or ''. */
  firmStatusText(task: NimbusTask): string {
    const text = Engine.firmReasonsText(task);
    return text ? Util.t('ui.firm_status_line', { reasons: text }) : '';
  },

  /** THE choke point for firm writes (C10): filters `ids` through `firmPlan`
   *  (firm -> the not-firmed ids, unfirm -> the manual-only ids; frozen/running
   *  ids are refused) and only then calls `Store.setFirmed`. Returns the ids
   *  changed and the locked ids skipped; ids already in the requested state are
   *  neither. Sandbox, undo and Time Machine restores stay on raw Store.setFirmed. */
  applyFirm(ids: ReadonlyArray<string | number>, firmed: boolean, source?: string): { changed: string[]; skipped: string[] } {
    const plan = Engine.firmPlan(ids);
    const changed = firmed ? plan.firm : plan.unfirm;
    if (changed.length) Store.setFirmed(changed, firmed, source);
    return { changed, skipped: plan.locked };
  },

  /** The optimizer's frozen FINISH floor: `frozenEnd` when it lies after the run's
   *  now, else null. No unprotected order may finish before it (D3, 2026-10-27).
   *  Takes the snapshot's `frozenHorizonEnd`, never live Store (the worker's
   *  Store is empty). Manual-path code (manualSchedulePatchFor, Alerts.applyFix)
   *  deliberately never consults it (OD-C2c). */
  frozenFinishFloor(runNow: Date, frozenEnd: Date | null | undefined): Date | null {
    return frozenEnd && frozenEnd > runNow ? new Date(frozenEnd) : null;
  },

  /** Local due-date calendar-day START floor for a plant's optional pull-forward
   *  limit. This is the pull-forward floor ONLY; the frozen horizon is a separate
   *  FINISH floor (`frozenFinishFloor`, `DueDateFirstBounds.finishFloor`). */
  earliestAllowedStart(
    task: NimbusTask, plant: string | null,
    masterDataOverride?: NimbusMasterData | null,
    view?: Pick<ScheduleSnapshot, 'calendars' | 'plants' | 'lineSettings' | 'masterData'> | null,
  ): Date | null {
    let floor: Date | null = null;
    const masterData = masterDataOverride === undefined ? sourceMasterData() : masterDataOverride;
    const value = masterData?.plants?.find(row => row.plant === plant)?.max_pull_forward_days;
    if (Number.isInteger(value) && (value as number) >= 0) {
      const due = sourceDueInstant(task, plant, view);
      if (due) {
        floor = new Date(+due - 1);   // a due on a 24:00 close is next-day 00:00 exclusive: its due DAY is the day before (R-I6)
        floor.setHours(0, 0, 0, 0);
        floor.setDate(floor.getDate() - (value as number));
      }
    }
    return floor;
  },

  /** Local due-date calendar-day CEILING for a plant's optional push-forward
   *  (max lateness) limit — the mirror image of earliestAllowedStart. An order
   *  may not FINISH after (due-date local midnight) + (N + 1) days, so N = 0
   *  means "by end of its due day". Null when the plant has no limit or the
   *  order has no SAP due date (Util.sapDueDate). Optimizer-only, like the
   *  pull-forward floor: manual moves, Alerts fixes, autoReflow and Remove
   *  Backlog never consult it. Independent of the frozen horizon
   *  (that is a separate finish floor). */
  latestAllowedEnd(
    task: NimbusTask, plant: string | null, masterDataOverride?: NimbusMasterData | null,
    view?: Pick<ScheduleSnapshot, 'calendars' | 'plants' | 'lineSettings' | 'masterData'> | null,
  ): Date | null {
    const masterData = masterDataOverride === undefined ? sourceMasterData() : masterDataOverride;
    const value = masterData?.plants?.find(row => row.plant === plant)?.max_push_forward_days;
    if (!Number.isInteger(value) || (value as number) < 0) return null;
    const due = sourceDueInstant(task, plant, view);
    if (!due) return null;
    const ceiling = new Date(+due - 1);   // due-DAY midnight even when the due is a 24:00 close (R-I6)
    ceiling.setHours(0, 0, 0, 0);
    ceiling.setDate(ceiling.getDate() + (value as number) + 1);
    return ceiling;
  },

  /** Regenerate one logical order from its requested parent start. Segments
   * are never shifted independently; a one-piece result explicitly clears an
   * obsolete child aggregate. */
  schedulePatchFor(task: NimbusTask, line: string, requestedStart: Date,
                   policy: SplitOrderPolicy = Engine.splitOrderPolicyFor(sourceGetPlantForLine(line))): Partial<NimbusTask> | null {
    const runtimeMinutes = Math.round(Util.runHours(task) * 60);
    if (!Number.isFinite(runtimeMinutes) || runtimeMinutes <= 0) return null;
    // VI3 (D17): the plant's zone, so the run is measured in elapsed plant-zone time across a DST change.
    const plant = task.PLANT || Store.getPlantForLine(line) || Store.selectedPlant;
    const plantTz = plantTimezoneFor(plant);
    if (policy === 'never' && !plantTz) {
      const start = Calendar.nextAvailable(line, requestedStart, runtimeMinutes * Config.MS_MIN);
      if (!start) return null;
      return { start_date: start, end_date: new Date(start.getTime() + runtimeMinutes * Config.MS_MIN), scheduleSegments: [] };
    }
    const allocation = Calendar.allocateRuntime(line, requestedStart, runtimeMinutes, policy, plantTz);
    return allocation.kind === 'allocated'
      ? { start_date: allocation.start, end_date: allocation.end, scheduleSegments: allocation.scheduleSegments }
      : null;
  },

  /** OQ3: a started order keeps its real start and only the finish follows the run time. The allocator may move
   * the start (`never` may move it to the next open minute; any policy skips closed time), and a running order never
   * loses its start. In that case (D3, VU1) the remaining run is walked FORWARD through working time from the held
   * start and the allocation's own start, end and pieces are returned: one piece when the run fits a window, the
   * calendar pieces when it crosses closed time (the old start + run time as plain elapsed time is gone). When the
   * recorded start sits in closed time the first piece starts at the next open minute and the stored start follows
   * it. Shared by the reconcile's running branch and the manual (grid/Inspector) edit. Null when no window is found. */
  heldStartPatchFor(task: NimbusTask, line: string, policy: SplitOrderPolicy): Partial<NimbusTask> | null {
    if (!task.start_date) return null;
    const held = Engine.schedulePatchFor(task, line, task.start_date, policy);
    if (!held?.start_date || !held.end_date) return null;
    if (held.start_date.getTime() === task.start_date.getTime()) return held;
    // D3 (VU1): the allocator could not keep the real start (closed time, or a `never` window too short), so the
    // remaining run is walked forward through working time from that start. `partial_allowed` is used regardless of
    // the plant's split policy: a continuous bar across closed time is wider than the run time and fails the server
    // width check, while pieces are judged by their sum, so the pieces are returned as the bar.
    const plant = task.PLANT || Store.getPlantForLine(line) || Store.selectedPlant;
    const plantTz = plantTimezoneFor(plant);
    const runtimeMinutes = Math.round(Util.runHours(task) * 60);
    const forward = Calendar.allocateRuntime(line, task.start_date, runtimeMinutes, 'partial_allowed', plantTz);
    if (forward.kind !== 'allocated') return null;
    return { start_date: forward.start, end_date: forward.end, scheduleSegments: forward.scheduleSegments ?? [] };
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
    const plantTz = plantTimezoneFor(plant);
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
    if (result.kind === 'lookback_exhausted') return { kind: 'refuse', reason: 'no_operating_window' };
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
   * On a routing plant a LINE change always re-resolves the run time from routing (D9: a hand-timed or SAP-timed
   * order's run time resets to the new routing value when the planner moves it); a same-line call keeps the
   * existing run time. The held FINISH is the anchor (the third argument); the start follows from the run time.
   * `opts.chosenPv` (a drop that picked a covering production version) routes through `pairSchedulePatchFor`. */
  manualRoutingSchedulePatchFor(task: NimbusTask, line: string, requestedFinish: Date,
                                opts: ManualPlacementOptions = {}): Partial<NimbusTask> | null {
    Engine.lastManualRefusal = null;
    const plant = task.PLANT || Store.getPlantForLine(task.MACHINE) || Store.selectedPlant;
    const enabled = routingEnabledFor(plant);
    if (enabled && opts.chosenPv != null) {
      return Engine.pairSchedulePatchFor(task, opts.chosenPv, line, requestedFinish, opts);
    }
    if (!enabled || line === task.MACHINE) {
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

  /** One placement for a (production version, machine) pair. Resolves the run time from `pv`'s routing at
   * `line` whenever it is called (a PV-only change keeps the machine, so the same-line shortcut above must not
   * apply) and returns PRODUCTION_VERSION, MACHINE, RUN_TIME, run_time_source, run_time_basis and the dates in ONE
   * patch (one Store write, one undo step). Null when the pair does not resolve (no refusal is recorded: the
   * caller explains it with `toast.pv_machine_ineligible`) or when the placement itself is refused, in which case
   * `Engine.lastManualRefusal` says why exactly as for `manualSchedulePatchFor`. On a plant without routing the
   * pair is just written beside an ordinary placement. */
  pairSchedulePatchFor(task: NimbusTask, pv: string, line: string, requestedFinish: Date,
                       opts: ManualPlacementOptions = {}): Partial<NimbusTask> | null {
    Engine.lastManualRefusal = null;
    const plant = task.PLANT || Store.getPlantForLine(task.MACHINE) || Store.selectedPlant;
    const enabled = routingEnabledFor(plant);
    const pairTask = { ...task, PRODUCTION_VERSION: pv };
    if (!enabled) {
      const plain = Engine.manualSchedulePatchFor(pairTask, line, requestedFinish, undefined, opts);
      return plain ? { ...plain, PRODUCTION_VERSION: pv, MACHINE: line } : null;
    }
    const resolved = Runtime.resolve(pairTask, line);
    if (!resolved.ok) return null;
    const changes = Engine.manualSchedulePatchFor({ ...pairTask, RUN_TIME: resolved.hours }, line, requestedFinish, undefined, opts);
    return changes ? {
      ...changes, PRODUCTION_VERSION: pv, MACHINE: line, RUN_TIME: resolved.hours, run_time_source: 'routing',
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
   * - An order that already has two or more schedule segments of the right total rejoins into ONE bar when its
   *   whole run fits one working window ending at the finish (2026-10-28); otherwise it is translated rigidly by
   *   the finish delta (OQ17 b: the dragged piece's same-edge delta), never re-derived; a changed total (rate or
   *   version edit) is re-derived from the held finish under the plant's policy.
   * - Otherwise `finishAnchoredPatchFor(snap(finish))`. A backward start before the plant's now reverses forward
   *   from now with a `reversal_forward` note (O2, OQ3, OQ7 a, OQ19 c), never a refusal. A manual drop whose finish
   *   cannot be held (it would have to move EARLIER) returns null with `toast.finish_cannot_hold` and the caller reverts (OQ13 b). A FIRMED order
   *   in that situation asks for confirmation first (`lastManualRefusal === 'needs_overtime_confirm'`); with
   *   `opts.confirmedOvertime` it is placed raw (start = finish minus run time, calendar ignored) and marked
   *   `placement_exception = 'overtime'` (OQ63).
   * - A row queued as `overlong_never` or `run_time_over_cap` that is still overlong on the chosen line (D5) is released as ONE continuous
   *   elapsed bar ending at the finish, marked `'overlong'` (OQ50). Queued `overlong_never`/`run_time_over_cap`
   *   rows that place normally return to `scheduled` in the same patch.
   * Manual placement deliberately ignores the frozen horizon (OD-C2c). Null on any refusal; the reason is in
   * `Engine.lastManualRefusal`. */
  manualSchedulePatchFor(task: NimbusTask, line: string, requestedFinish: Date,
                         policy?: SplitOrderPolicy, opts: ManualPlacementOptions = {}): Partial<NimbusTask> | null {
    const patch = Engine._manualSchedulePatchForInner(task, line, requestedFinish, policy, opts);
    // VI5: a manual placement is the planner's own truth; the stale flag is cleared with it (the server clears
    // it too on a width-checked save; the client copy must not keep the "start may be out of date" alert alive).
    return patch ? { ...patch, runtime_schedule_mismatch: false } : null;
  },

  _manualSchedulePatchForInner(task: NimbusTask, line: string, requestedFinish: Date,
                               policy?: SplitOrderPolicy, opts: ManualPlacementOptions = {}): Partial<NimbusTask> | null {
    Engine.lastManualRefusal = null;
    const refuse = (reason: ManualRefusal): null => { Engine.lastManualRefusal = reason; return null; };
    const runtimeMinutes = Math.round(Util.runHours(task) * 60);
    if (!Number.isFinite(runtimeMinutes) || runtimeMinutes <= 0) return refuse('run_time_zero');
    // D1 (VI1): a held finish keeps its exact minute; only a horizontal Gantt drag snaps, and it does so before
    // reaching this function. Floor to the minute so the server's minute-granular width check sees whole minutes.
    const finish = Calendar._floorMinute(requestedFinish);
    const plant = task.PLANT || Store.getPlantForLine(line) || Store.selectedPlant;
    const queuedCode = task.planning_status === 'needs_planning' ? task.planning_reason?.code : undefined;
    // Only these two queue reasons are releasable by a placement; any other queued row follows the ordinary rule.
    const releasable = queuedCode === 'overlong_never' || queuedCode === 'run_time_over_cap';
    const released: Partial<NimbusTask> = releasable ? { planning_status: 'scheduled', planning_reason: null } : {};

    if (task.start_date && Engine.isInProgress(task)) {
      if (!opts.holdStartIfRunning) {
        // D2 (VI7): a started order's bar is not resized or moved by hand; the run-time edit is the only way to
        // change its finish, and it holds the real start (below).
        return refuse('running_finish_locked');
      }
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
        // 2026-10-28 owner decision (narrows D7/OQ17): when the whole run fits ONE working window ending at the
        // requested finish, the order rejoins into one bar instead of keeping its old gaps. Anything else (no-op,
        // approved exception, still needs splitting, finish in closed time) stays on the rigid shift below.
        if (!(deltaMs === 0 && line === task.MACHINE) && !task.placement_exception) {
          const joined = Engine.finishAnchoredPatchFor(task, line, finish, policy ?? Engine.splitOrderPolicyFor(plant));
          if (joined.kind === 'placed' && !joined.finishMoved && !joined.reversed
              && (joined.changes.scheduleSegments?.length ?? 0) === 0) {
            return { ...joined.changes, MACHINE: line, ...released };
          }
        }
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
      // D5 (VI6): an approved release of an over-cap order on a never plant has the same shape as an overlong
      // release: one continuous marked bar. OQ28 says a planner may approve and release it.
      if (result.reason === 'overlong_never' && (queuedCode === 'overlong_never' || queuedCode === 'run_time_over_cap')) {
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
      // No machine: there is no line to hold the finish on, and writing 'Unknown' would be rejected on Save
      // (machine_unknown). Skip it; the caller counts selected minus moved as skipped in the Push toast.
      if (!task.MACHINE) continue;
      const plant = task.PLANT || Store.getPlantForLine(task.MACHINE) || Store.selectedPlant || '';
      (byPlant.get(plant) ?? byPlant.set(plant, []).get(plant)!).push(task);
    }
    for (const [plant, group] of byPlant) {
      Calendar._beginRun(plant || null);
      try {
        for (const task of group) {
          const changes = Engine.manualSchedulePatchFor(task, task.MACHINE,
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
   * would be saved as truth), or from a plant with no time zone (a line with no server calendar row is derived, D14). Rows
   * whose walk reaches "now" are collected per line and placed forward in finish order from now (OQ53 b).
   * No undo entry (OQ57); one Toast counts the dirty patches. `opts.reason === 'cutover'` tags the reversals. */
  reconcileRuntimeSchedules(plant: string | null, opts: ReconcileOptions = {}): void {
    const _pmT0 = performance.now();
    try {
      Engine._reconcileRuntimeSchedulesPass(plant, opts);
    } finally {
      PerfMonitor.record('Engine.reconcileRuntimeSchedules', performance.now() - _pmT0);
    }
  },

  /** The untimed body of `reconcileRuntimeSchedules` (split only so the public entry point carries the timing key). */
  _reconcileRuntimeSchedulesPass(plant: string | null, opts: ReconcileOptions = {}): void {
    if (!plant) return;
    const candidates = Store.tasksByPlant(plant).filter(task =>
      isReconcileEligible(task)
      // A row with unsaved local edits is the planner's own work in progress: never re-derive it.
      && (opts.ids ? opts.ids.has(String(task.id)) : !Persistence.isDirty(String(task.id))));
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
    // Returns true when it wrote a (new or changed) note, so a caller that also logs can log once per change, not every pass.
    const noteOnly = (task: NimbusTask, issue: Issue): boolean => {
      if (sameIssue(task.derivationIssue, issue)) return false;
      patches.push({ id: task.id, changes: { derivationIssue: issue }, dirty: false });
      return true;
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
      || (opts.reason === undefined && !opts.ids && nonQueuedCount >= CUTOVER_MIN_ROWS && signatureCount * 2 > nonQueuedCount);
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
    const plantTz = plantTimezoneFor(plant);   // the reversal's forward leg runs on plant-zone instants (U16)
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
    // One grouping pass over the plant's rows (was one filter per machine), each line sorted on first use.
    let lineGroups: Map<string, NimbusTask[]> | null = null;
    const sortedLines = new Set<string>();
    const scheduleOf = (line: string): NimbusTask[] => {
      if (!lineGroups) {
        lineGroups = new Map();
        for (const row of Store.tasksByPlant(plant)) {
          if (!row.MACHINE || row.planning_status === 'needs_planning' || !row.start_date || !row.end_date) continue;
          const group = lineGroups.get(row.MACHINE);
          if (group) group.push(row); else lineGroups.set(row.MACHINE, [row]);
        }
      }
      const rows = lineGroups.get(line) ?? [];
      if (!sortedLines.has(line)) {
        rows.sort((a, b) => a.start_date!.getTime() - b.start_date!.getTime() || String(a.id).localeCompare(String(b.id)));
        sortedLines.add(line);
      }
      return rows;
    };
    // The resolution index is built once per pass (and memoised per snapshot), so each changeover lookup is O(1).
    let setupIndex: SetupResolutionIndex | null = null;
    // Active overrides by line + successor order, built once per pass: the orphan test no longer scans every override.
    let orphanMap: Map<string, Array<string | null>> | null = null;
    const isOrphaned = (task: NimbusTask, line: string, predecessorId: string | null): boolean => {
      if (!orphanMap) {
        orphanMap = new Map();
        for (const override of setup?.overrides ?? []) {
          if (override.status !== 'active') continue;
          const key = `${override.machine}\0${String(override.successor_order_id)}`;
          const entry = override.predecessor_order_id == null ? null : String(override.predecessor_order_id);
          const list = orphanMap.get(key);
          if (list) list.push(entry); else orphanMap.set(key, [entry]);
        }
      }
      const named = orphanMap.get(`${line}\0${String(task.id)}`);
      return !!named && named.some(entry => entry !== predecessorId);
    };
    /** The latest-starting scheduled row on `line` that starts before `start`, other than `task` itself. */
    const predecessorAt = (task: NimbusTask, line: string, start: Date): NimbusTask | null => {
      const rows = scheduleOf(line);
      let lo = 0, hi = rows.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].start_date!.getTime() < start.getTime()) lo = mid + 1; else hi = mid; }
      for (let i = lo - 1; i >= 0; i--) { if (String(rows[i].id) !== String(task.id)) return rows[i]; }
      return null;
    };
    // The orphan verdict the first (zero-setup) walk's setupBefore call reached, by task id and the start it was asked
    // about; the second call site reuses it when the final start is unchanged instead of resolving again.
    const orphanMemo = new Map<string, { startMs: number; orphaned: boolean }>();
    /** The changeover minutes to reserve before `task` starting at `start` (0 when it is unknown: the predecessor
     *  is not placed, the pair has no rule or an attribute is missing; the unknown-setup alert covers those), and
     *  whether an active override of this order no longer names the row that now sits before it. */
    const setupBefore = (task: NimbusTask, line: string, start: Date): { minutes: number; orphaned: boolean } => {
      if (!setupLive || !setup || !setupDefinition) return { minutes: 0, orphaned: false };
      const predecessor = predecessorAt(task, line, start);
      const predecessorId = predecessor ? String(predecessor.id) : null;
      const orphaned = isOrphaned(task, line, predecessorId);
      orphanMemo.set(String(task.id), { startMs: start.getTime(), orphaned });
      let predecessorState: SetupStateKey | null = null;
      if (predecessor) {
        if (!predecessor.user_scheduled) return { minutes: 0, orphaned };   // not placed: the required changeover is unknown
        predecessorState = stateForOrder(predecessor, setupDefinition);
      } else {
        predecessorState = setup.machine_states.find(state => state.machine === line
          && state.signature_version === setupDefinition.signature_version)?.state_key ?? null;
      }
      const successorState = stateForOrder(task, setupDefinition);
      // X2: an undo restores exact placements, so it keeps the legacy covered-only reservation; every other pass
      // (stale runtime, cutover, server refresh, distribution) also reserves the plant default for an unrecorded
      // or uncovered transition, the same minutes the optimizer's validator charges.
      const chargeDefault = opts.reason !== 'undo';
      if (!predecessorState || !successorState) {
        return { minutes: chargeDefault ? storeChargedSetupMinutes(plant, line, null) : 0, orphaned };
      }
      setupIndex ??= setupResolutionIndexFor(setup as SetupSnapshot & { definition: SetupDefinition });
      const resolved = resolveSetup({
        definition: setupDefinition, machine: line, predecessorState, successorState, predecessorOrderId: predecessorId,
        successorOrderId: String(task.id), plantRows: setup.plant_rows, machineRows: setup.machine_rows, overrides: setup.overrides, valueDefaults: setup.value_defaults ?? NO_VALUE_DEFAULTS,
        index: setupIndex,
      });
      if (chargeDefault) return { minutes: storeChargedSetupMinutes(plant, line, resolved), orphaned };
      return { minutes: resolved.covered && resolved.effectiveMin != null ? resolved.effectiveMin : 0, orphaned };
    };
    /** Only the orphan verdict for `task` starting at `start`: no changeover resolution. */
    const orphanedAt = (task: NimbusTask, line: string, start: Date): boolean => {
      if (!setupLive || !setup || !setupDefinition) return false;
      const memo = orphanMemo.get(String(task.id));
      if (memo && memo.startMs === start.getTime()) return memo.orphaned;
      const predecessor = predecessorAt(task, line, start);
      return isOrphaned(task, line, predecessor ? String(predecessor.id) : null);
    };

    interface Reversal { task: NimbusTask; anchor: Date; stale: boolean }
    const reversals = new Map<string, Reversal[]>();
    Calendar._beginRun(plant);
    try {
      for (const task of candidates) {
        const line = task.MACHINE;
        // D14: every line has a calendar (its own row or the plant default), so nothing is blocked here any more.
        const stale = !!task.runtime_schedule_mismatch;
        const placed = !!task.user_scheduled;

        if (placed && task.start_date && task.end_date && Engine.isInProgress(task, plantNow)) {
          // OQ3: it is already producing. The start holds and the finish follows the run time (no reversal).
          const changes = Engine.heldStartPatchFor(task, line, policy);
          if (!changes) {
            if (noteOnly(task, { code: 'no_operating_window' })) {
              ErrorLog.warn('engine',
                `Runtime changed for running order "${task.text || task.id}", but its finish could not be regenerated within the calendar search.`,
                { line, taskId: task.id, policy, reason: 'runtime-schedule-mismatch' });
            }
            tally(stale, 'blocked');
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
            tally(stale, 'blocked');
          } else if (result.reason === 'run_time_zero') noteOnly(task, { code: 'run_time_zero' });   // OQ13: no bar
          else if (result.reason === 'plant_no_timezone') { noteOnly(task, { code: 'plant_no_timezone' }); tally(stale, 'blocked'); }
          else {
            if (noteOnly(task, { code: 'no_operating_window' })) {
              ErrorLog.warn('engine',
                `Order "${task.text || task.id}" could not be re-derived: no operating window within the calendar search.`,
                { line, taskId: task.id, policy, reason: result.reason });
            }
            tally(stale, 'blocked');
          }
          continue;
        }

        // Placed. Several findings can apply to one row; the most important one is recorded.
        const derivedStart = result.changes.start_date!;
        let issue: Issue | null = null;
        const orphaned = setupLive && orphanedAt(task, line, derivedStart);
        // D9c (VP1): a date-only due that lands on a blackout day is read as that day's close and the walk
        // moves it before the blackout; that is the due date resolving, not a finish the planner lost. Silent.
        const dueOnBlackout = !placed && result.moveReason === 'blackout' && Util.isDateOnlyDue(task);
        if (result.finishMoved && !dueOnBlackout) issue = { code: 'finish_moved_earlier', from: anchor, to: result.changes.end_date! };
        else if (orphaned) issue = { code: 'setup_override_orphaned' };   // an active override no longer names the row before it (recorded only, Task 3.3 alerts)
        else {
          // 2026-10-27 (C4): the D19/VU17 `frozen_window_crossed` branch is gone. Under the finish rule a placed row's
          // finish is held, and a moved finish is reported as `finish_moved_earlier` first, so it was unreachable. Two
          // silent flips to frozen remain (a `reversal_forward` row re-placed from now, a calendar closure pulling a
          // finish in); each is already alerted by its own movement alert. The alert type id stays accepted for saved profiles.
          const pullFloor = Engine.earliestAllowedStart(task, plant);
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
        // The walk ends at the first item the calendar cannot place, so the rows after it were never tried: only the
        // failing row (and any skipped for an unusable run time) is noted; the later rows keep whatever note they had.
        const failedId = sequence.failure ? String(sequence.failure.item.row.task.id) : null;
        const invalidIds = new Set(sequence.invalidRuntime.map(item => String(item.row.task.id)));
        for (const row of rows) {
          if (placedIds.has(String(row.task.id))) continue;
          if (overlongIds.has(String(row.task.id))) {
            // OQ50: it cannot be one bar under this plant's policy, so it is queued exactly like the backward refusal.
            patches.push({ id: row.task.id, dirty: row.stale, changes: Engine.overlongNeverChanges() });
            tally(row.stale, 'blocked');
            continue;
          }
          if (String(row.task.id) !== failedId && !invalidIds.has(String(row.task.id))) continue;
          if (noteOnly(row.task, { code: 'no_operating_window' })) {
            ErrorLog.warn('engine',
              `Order "${row.task.text || row.task.id}" could not be placed forward from now: no operating window found.`,
              { line, taskId: row.task.id, policy, reason: 'reversal-forward' });
          }
          tally(row.stale, 'blocked');
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
        Persistence.discardDirty(id);
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
    opts: { stopWhen?: (item: T, cursor: Date) => boolean; plantTz?: string | null;
            /** Fixed intervals on the line (orders that must not move): a placement that would overlap one restarts from
             *  its end, so the sequence is planned AROUND them. Absent: the walk is unchanged. */
            obstacles?: ReadonlyArray<{ start: Date; end: Date }> } = {},
  ): ForwardSequenceResult<T> {
    const out: ForwardSequenceResult<T> = { placed: [], invalidRuntime: [], overlong: [], failure: null };
    let cursor = new Date(from);
    const obstacles = [...(opts.obstacles ?? [])];
    nextItem: for (const item of items) {
      if (opts.stopWhen?.(item, cursor)) break;
      const runtimeMinutes = runMinutesOf(item.task);
      if (runtimeMinutes <= 0) {
        out.invalidRuntime.push(item);
        continue;
      }
      const runtimeMs = runtimeMinutes * Config.MS_MIN;   // whole minutes like every other path (senior review M1)
      let candidate = item.notBefore ? new Date(Math.max(item.notBefore.getTime(), cursor.getTime())) : cursor;
      let start!: Date;
      let end!: Date;
      let scheduleSegments: OrderScheduleSegment[] | undefined;
      // A placement that would overlap a fixed interval (`opts.obstacles`) restarts from that interval's end.
      for (let attempt = 0; ; attempt++) {
        scheduleSegments = undefined;
        if (policy === 'never') {
          // Preserve the existing continuous-bar contract exactly for legacy
          // schedules. A split schedule that is explicitly regenerated under
          // this policy is cleared below as one atomic parent aggregate.
          const slot = Calendar.findContiguousSlot(line, candidate, runtimeMs, opts.plantTz ?? null);
          if (slot.kind === 'unavailable' || (!opts.plantTz && !('start' in slot))) {
            out.failure = { item, reason: slot.kind === 'unavailable' ? 'no-operating-interval' : 'search-exhausted' };
            break nextItem;
          }
          if (slot.kind === 'overlong' && !opts.plantTz) { out.overlong.push(item); continue nextItem; }
          if (opts.plantTz) {
            // The reversal's forward leg picks the slot AND the end in plant-zone instants (OQ46, U16), so a window
            // whose edge lies on a DST jump is neither overrun nor skipped. Overlong / unavailable were classified above.
            const allocation = Calendar.allocateRuntime(line, candidate, runtimeMinutes, 'never', opts.plantTz);
            if (allocation.kind !== 'allocated') {
              // Wall-clock said overlong and plant-zone time agrees (no window holds it): the continuous-bar exception.
              if (slot.kind === 'overlong') { out.overlong.push(item); continue nextItem; }
              out.failure = { item, reason: allocation.kind === 'unavailable' ? 'no-operating-interval' : 'search-exhausted' };
              break nextItem;
            }
            start = allocation.start;
            end = allocation.end;
          } else {
            start = (slot as { start: Date }).start;
            end = new Date(start.getTime() + runtimeMs);
          }
          if (item.task.scheduleSegments?.length && item.task.scheduleSegments.length >= 2) scheduleSegments = [];
        } else {
          const allocation = Calendar.allocateRuntime(line, candidate, runtimeMinutes, policy, opts.plantTz ?? null);
          if (allocation.kind !== 'allocated') {
            out.failure = { item, reason: allocation.kind === 'unavailable' ? 'no-operating-interval' : 'search-exhausted' };
            break nextItem;
          }
          start = allocation.start;
          end = allocation.end;
          // Always include the full child aggregate, including [], so a
          // regenerated continuous parent removes obsolete child rows.
          scheduleSegments = allocation.scheduleSegments;
        }
        const hit = obstacles.find(o => start.getTime() < o.end.getTime() && end.getTime() > o.start.getTime());
        if (!hit || attempt >= obstacles.length) break;
        candidate = new Date(hit.end);
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
   * floor (now the finish floor, `bounds.finishFloor`, which backlogBounds never sets) -- was removed for this mode on
   * 2026-08-22 by planner decision (SAP002 "Remove Backlog" parity):
   * insert-operation semantics require the overdue backlog to compress
   * fully into now, including into the frozen window. A frozen-window
   * order is still moved "when reached" by the compressing cursor -- it is
   * never pulled earlier than its own snapshot start (the
   * `item.snapshotStart >= now && cursor <= item.snapshotStart` break above
   * still guarantees that) -- mirroring the pre-existing treatment of a
   * genuinely Store.isFirmed-pinned order, and is now counted separately via
   * diagnostics.frozenMoved. Since 2026-10-27 `frozenMoved` counts orders whose
   * FINISH is inside the window, including running ones (Backlog moves running
   * orders). All other placement sites (the setup-aware evaluator's
   * firmedIds, autoReflow) keep applying
   * Engine.isFrozenHorizon and the finish floor (`Engine.frozenFinishFloor`). */
  removeBacklog(opts: Record<string, unknown> = {}): RemoveBacklogResult {
    const plant = (opts.plant as string | undefined) ?? sourceSelectedPlant();
    if (!plant) throw new Error('Remove Backlog requires a selected plant');
    const splitPolicy = Engine.splitOrderPolicyFor(plant);
    const { now, from, to } = normalizeBacklogRunDates(plant, opts);

    const diagnostics: RemoveBacklogDiagnostics = {
      backlogFound: 0, moved: 0, firmedMoved: 0, frozenMoved: 0, movedRuntimeHours: 0, largestDelayMinutes: 0,
      invalidRuntimeIds: [], missingStartIds: [], overlongIds: [], calendarSearchFailures: [], boundaryConflicts: [],
      ...(opts.holdRunning === true ? { runningHeldIds: [] } : {}),
    };
    // `holdRunning` (the headless job's include_running=false): an order in progress is NOT moved and the rest of the line
    // is planned around its real slot, so the patches this returns are exactly what a writer that skips running orders
    // writes. The browser's Backlog leaves it off (running orders are re-placed from now).
    const holdRunning = opts.holdRunning === true;
    const obstaclesByLine = new Map<string, Array<{ start: Date; end: Date }>>();
    const lines = Array.isArray(opts.lines) && opts.lines.length
      ? new Set((opts.lines as unknown[]).map(String))
      : null;
    // The preview runs in the worker, whose live Store is empty: read the frozen end and the zone from the
    // detached snapshot when there is one, never from the live Store (V-E2-01, V-E3-07).
    const frozenEnd = _candidateSnapshot ? (_candidateSnapshot.frozenHorizonEnd ?? null) : Engine.frozenHorizonEnd();
    const plantTz = plantTimezoneFor(plant);
    const grouped = new Map<string, Array<{ task: NimbusTask; snapshotStart: Date }>>();
    const scopedTasks = sourceTasksByPlant(plant).filter(t => !lines || lines.has(t.MACHINE || 'Unknown'));
    for (const task of scopedTasks) {
      // G-0.25: an approved placement exception is fixed; Remove Backlog leaves it where the planner put it.
      if (task.placement_exception) continue;
      if (holdRunning && Engine.isInProgress(task, now)) {
        const lineKey = task.MACHINE || 'Unknown';
        const held = obstaclesByLine.get(lineKey) || [];
        held.push({ start: new Date(task.start_date!), end: new Date(task.end_date!) });
        obstaclesByLine.set(lineKey, held);
        diagnostics.runningHeldIds!.push(task.id);
        continue;
      }
      if (!task.start_date) {
        // A queued row (needs_planning) has no bar by design; only a never-placed row counts as "no start".
        if (task.planning_status !== 'needs_planning') diagnostics.missingStartIds.push(task.id);
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
          { plantTz,
            stopWhen: (item, cursor) => item.snapshotStart >= now && cursor <= item.snapshotStart,
            ...(holdRunning && obstaclesByLine.has(line) ? { obstacles: obstaclesByLine.get(line) } : {}) });
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
          const runtimeHours = runMinutesOf(item.task) / 60;
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
          if (Engine.isFrozenHorizon(item.task, now, frozenEnd)) diagnostics.frozenMoved++;
          if (item.snapshotStart < now) diagnostics.movedRuntimeHours += runtimeHours;
          diagnostics.largestDelayMinutes = Math.max(diagnostics.largestDelayMinutes,
            Math.round((start.getTime() - item.snapshotStart.getTime()) / Config.MS_MIN));
        }
      }
    } finally {
      Calendar._endRun();
    }

    const patchById = new Map(patches.map(patch => [patch.id, patch]));
    // Indexed once (V-E1-01): id -> task and line -> scoped tasks (scopedTasks order kept, so the conflicts
    // come out in the same order as the linear scan produced them).
    const byId = new Map<string, NimbusTask>(scopedTasks.map(t => [String(t.id), t] as const));
    const scopedByLine = new Map<string | undefined, NimbusTask[]>();
    for (const t of scopedTasks) {
      const list = scopedByLine.get(t.MACHINE);
      if (list) list.push(t); else scopedByLine.set(t.MACHINE, [t]);
    }
    for (const patch of patches) {
      const movedStart = patch.changes.start_date;
      const movedEnd = patch.changes.end_date;
      if (!movedStart || !movedEnd) continue;   // a queued (overlong_never) row has no bar to conflict
      const movedTask = byId.get(String(patch.id)) ?? sourceTask(patch.id);
      if (!movedTask) continue;
      for (const protectedTask of scopedByLine.get(movedTask?.MACHINE) ?? []) {
        if (!protectedTask.start_date || !protectedTask.end_date) continue;
        // VM7: a marked bar inside the window is an obstacle too
        if ((protectedTask.start_date <= to && !protectedTask.placement_exception) || patchById.has(protectedTask.id)) continue;
        if (movedStart < protectedTask.end_date && movedEnd > protectedTask.start_date) {
          diagnostics.boundaryConflicts.push({ line: movedTask.MACHINE, movedTaskId: patch.id, protectedTaskId: protectedTask.id, type: 'overlap' });
        }
      }
    }
    return { patches, diagnostics };
  },

  /* ----- Per-plant switchable constraints (phased registry) -------------
     CONSTRAINT_CATALOG declares which fields are rankable; every enabled key
     gets a policy rank term generically (setup-scheduler's rankForTask). Per-plant config
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
   *  configured below the root). Sequencing was never affected — the scheduler's
   *  activePriorityKeys walks the tree, which has always walked the tree — but
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
    // Only a genuinely never-configured tree (none stored, or an empty array) gets the historical default.
    if (!tree || !tree.length) return key === 'colorWheel';
    // A configured tree is authoritative about what it omits or switches off: the key is enabled exactly when the one
    // shared walk emits it (a node unreachable under a disabled ancestor, or itself disabled, is "configured but off",
    // never the colorWheel default — the fall-through bug this replaced).
    return Engine._walkPriorityTree(tree).some(node => node.key === key);
  },

  /** Pre-order DFS flatten of the (possibly nested) constraint tree — a field
   *  nested under a field is mathematically identical to the next key in a
   *  lexicographic sort (docs/scheduling_priority.md "Sub-sort model"
   *  decision), so this is the ONLY tree-aware function in the optimizer;
   *  every existing caller of activeConstraintKeys
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

  /** Delegates to flattenConstraints — every caller that asks "which
   *  constraints are active, in order" picks up tree support with no
   *  call-site change. */
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
  _fieldTaskFields: { ...PRIORITY_FIELD_DEFAULTS } as Record<string, string>,

  setFieldTaskFields(fields: Array<{ field_key: string; task_field: string }>): void {
    if (!fields || !fields.length) return; // keep the offline fallback
    for (const f of fields) {
      if (f.field_key && f.task_field) Engine._fieldTaskFields[f.field_key] = f.task_field;
    }
  },

  /** Does the loaded rank cache carry ANY ranks for this priority field —
   *  plant-wide ('') or scoped to a specific line? Reads the exact same
   *  Store.priorityRankMaps the scheduler's rank lookup reads, so every "is this
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
   *  FORM_SIZE (always part of what a run groups on).
   *
   *  The single source of truth for "what counts as a changeover", shared by
   *  `Util.countChangeovers` (via the resolver app.js injects — Util is the
   *  Foundation layer and must not import Engine) and the alert cell-briefing's
   *  own count, so the optimizer's objective and every number reported about it
   *  are derived from one list. For a never-configured plant this returns
   *  ['COLOR', 'FORM_SIZE'] — byte-identical to the hardcoded pair it
   *  replaces.
   *
   *  An unregistered key contributes no field and never warns: this runs on
   *  every KPI computation (twice per optimizer preview, and on Dashboard
   *  renders), so a warning path would flood duplicates. */
  changeoverTaskFields(plant: string | null): string[] {
    const fields = Engine.activeConstraintKeys(plant)
      .map(k => Engine._fieldTaskFields[k])
      .filter(Boolean);
    if (!fields.includes('FORM_SIZE')) fields.push('FORM_SIZE');
    return fields;
  },

  /** The detached optimizer body behind `evaluateSchedule` (the only caller; it
   *  installs `_candidateSnapshot` first). Groups by line, optionally respects
   *  firmed + calendar, and returns a `CandidateResult` of patches: it never
   *  writes Store, raises toasts or touches Alerts/Undo. Apply is the caller's
   *  explicit step (`applySchedulePatches`, or the Optimize preview's Apply).
   *  opts.plant restricts to lines belonging to that plant. Priority ranks are
   *  not passed in: the scheduler reads them from the snapshot's
   *  `priorityRankMaps`.
   *  opts.deadlineAt (Phase 2, Pkg D): an optional absolute performance.now()
   *  timestamp for the setup-aware evaluators' search deadline, consumed where
   *  DueDateFirstBounds.deadline is built below. Absent it, a fresh
   *  SETUP_AWARE_DEADLINE_MS window is used, unchanged from before. */
  _evaluateDetached(mode: OptimizerMode = 'changeover', opts: Record<string, unknown> = {}): CandidateResult {
    const _pmT0e = performance.now();
    if (!sourceTasks().length) return detachedCandidateResult([], _pmT0e);
    const plant: string | null = (opts.plant as string | null | undefined) ?? sourceSelectedPlant();
    if (!plant) return detachedCandidateResult([], _pmT0e, 'no-plant');
    // Remove Backlog is a schedule-repair pass, not an optimizer. Dispatch it
    // before priority-term creation so this path cannot accidentally read rank
    // maps, firmed protection, or the day-integrity resequencer.
    if (mode === 'backlog') {
      const backlogDates = normalizeBacklogRunDates(plant, opts);
      const result = Engine.removeBacklog({ ...opts, plant, runAt: backlogDates.runAt });
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
        baselineSnapshot, plant, allowedLines, backlogDates.from, backlogDates.to, new Set(result.diagnostics.runningHeldIds ?? []),
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
        // X3: Backlog removal is exempt from the plant's pull/push window (candidate time and Apply time).
        ignorePlantWindow: true,
        // Tool Inventory: Remove Backlog is exempt from the tool rule (no pass, no finding, no static defect).
        ignoreToolRule: true,
      };
      return attachDetachedValidationContext(
        detachedCandidateResult(result.patches, _pmT0e, 'completed', result),
        baselineSnapshot,
        backlogBounds,
        new Set(),
      );
    }
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
    const injectedNow = readDate(opts.now, 'now', true);
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
      : addLocalDays(planningStart, DEFAULT_HORIZON_DAYS));
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
      return invalid;
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
      return invalid;
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
    const budgetMs = typeof opts.searchBudgetMs === 'number' && Number.isFinite(opts.searchBudgetMs) && opts.searchBudgetMs > 0
      ? opts.searchBudgetMs : SETUP_AWARE_DEADLINE_MS;
    const scale = Math.max(1, budgetMs / SETUP_AWARE_DEADLINE_MS);
    const exhaustive = opts.exhaustive === true;
    const bounds: DueDateFirstBounds = {
      // Non-null by construction: this branch is only reached when either
      // mode is one of the setup-aware modes, so effectiveSetupSnapshot is
      // always the real active-and-matching snapshot or the synthetic
      // fallback.
      setup: effectiveSetupSnapshot,
      exactSearchThreshold: exhaustive ? SETUP_AWARE_EXHAUSTIVE_EXACT_SEARCH_THRESHOLD : SETUP_AWARE_EXACT_SEARCH_THRESHOLD,
      exhaustive,
      ...(exhaustive ? { exactSearchLeafCap: SETUP_AWARE_EXHAUSTIVE_EXACT_LEAF_CAP } : {}),
      // F4: Scale iteration cap per line. The cap is a stack-safety net; after
      // F2 a shared 20,000 iterations starved later lines on big plants. With
      // F1 no exact fragment exceeds ~500 leaves and greedy tops ~165 candidates
      // per fragment, so per-line scaling keeps the pool usable for every line.
      // opts.iterationCap (headless runs, tests) replaces the scaled cap so a run can end on iterations alone, never on the clock.
      iterationCap: typeof opts.iterationCap === 'number' && opts.iterationCap >= 1
        ? Math.floor(opts.iterationCap)
        : Math.round(SETUP_AWARE_ITERATION_CAP * Math.max(1, linesInScope) * scale),
      gapFillBudgetMs: gapFillBudgetFor(opts.searchBudgetMs as number | undefined),
      clock: () => performance.now(),
      // Phase 2 (Pkg D): an absolute deadline the caller already computed
      // (e.g. the preview's one-shot primary budget, or the deferred Plan B
      // comparison's smaller budget) takes precedence over a fresh
      // SETUP_AWARE_DEADLINE_MS window here. A past `opts.deadlineAt` is
      // not special-cased: the search just terminates immediately with
      // tail placement, which is the existing, safe deadline-exceeded path.
      deadline: (opts.deadlineAt as number | undefined) ?? performance.now() + budgetMs,
      now: placementStart,
      planningStart,
      runNow,
      placementStart,
      horizonEnd,
      lines: Array.isArray(opts.lines) ? opts.lines as string[] : undefined,
      respectCalendar,
      // Snapshot-bound: the worker serializes these closures after the run ends (optimizer-worker.mts), so they
      // must never read the ambient _candidateSnapshot or the realm's Store.
      notBefore: (task: NimbusTask) => Engine.earliestAllowedStart(task, plant, baseSnapshot.masterData, baseSnapshot),
      // D3 (2026-10-27): the frozen horizon is a FINISH floor on every unprotected order (a run-wide instant, from the snapshot, never live Store).
      finishFloor: Engine.frozenFinishFloor(runNow, baseSnapshot.frozenHorizonEnd),
      notAfter: (task: NimbusTask) => Engine.latestAllowedEnd(task, plant, baseSnapshot.masterData, baseSnapshot),
      convergenceWindow: exhaustive ? SETUP_AWARE_EXHAUSTIVE_CONVERGENCE_WINDOW : SETUP_AWARE_CONVERGENCE_WINDOW,
    };
    // Tool Inventory stale-core guard: only a Hard plant with a loaded inventory needs the new core functions; an Off
    // plant never reaches this, so it keeps using the worker with an older cached core.
    assertToolCoreFor(snapshot, plant);
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
    return result;
  },

  /** After a manual edit to one task, re-flow subsequent unfirmed orders on the
   *  same line to eliminate overlap. Spans day boundaries so Day-1 overflow
   *  cascades correctly into Day-2 tasks. Does NOT move firmed orders (manual
   *  firms, running or frozen orders; SAP's firm flag never locks). */
  autoReflow(changedId: string): void {
    const changed = Store.tasks[changedId];
    if (!changed || !changed.start_date || !changed.end_date) return;
    // "Today" in the order's plant (one clock, OQ52); a blocked plant keeps the server instant read as
    // wall-clock, which is what this aged-task guard always did with the viewer's clock.
    const _horizonStart = Util.startOfDay(Engine._clockFor(changed) ?? Store.serverNow())!;
    if (changed.end_date < _horizonStart) return; // aged task — don't reflow
    const line = changed.MACHINE || 'Unknown';
    const lineOwner = Store.getPlantForLine(line) ?? Store.selectedPlant;
    const splitPolicy = Engine.splitOrderPolicyFor(lineOwner);
    // D3 (2026-10-27): a moved peer may not FINISH inside the frozen window. The floor reads the changed order's plant
    // clock; every attempt re-places through the calendar, which rebuilds its free intervals from that start.
    const _floorNow = Engine._clockFor(changed) ?? Store.serverNow();
    const _frozenEnd = Engine.frozenHorizonEnd();
    const _finishFloor = Engine.frozenFinishFloor(_floorNow, _frozenEnd);
    // Per-run calendar caches (split-capable plants only) start lazily, on the first peer that is actually re-placed, so a
    // reflow that moves nothing never indexes the blackout blocks. Always torn down in the finally below.
    let calendarRunStarted = false;
    const placeReflowed = (p: NimbusTask, from: Date, setupMinutes: number): PlacementResult => {
      const runtimeMinutes = Math.round(Util.runHours(p) * 60);
      if (splitPolicy !== 'never' && !calendarRunStarted) { Calendar._beginRun(lineOwner); calendarRunStarted = true; }
      return placeWithFinishFloor(
        earliest => Calendar.placeWithSetup(line, { earliestStart: earliest, runtimeMinutes, policy: splitPolicy, setup: { kind: 'resolved', minutes: setupMinutes } }),
        from, _finishFloor, setupMinutes, runtimeMinutes, splitPolicy);
    };
    const setup = Store.setupSnapshot;
    const definition = setup?.definition;
    // Workstream D2: the real gate is plants.setup_active (setup.plant_active),
    // not the vestigial per-signature-version setup_definition.active.
    const setupActive = !!(setup && setup.plant_active && setup.plant === (changed.PLANT || Store.selectedPlant));
    const setupMinutes = (predecessor: NimbusTask, successor: NimbusTask): number => {
      if (!setupActive || !setup || !definition) return 0;
      const predecessorState = stateForOrder(predecessor, definition);
      const successorState = stateForOrder(successor, definition);
      const plantOfLine = String(setup.plant);   // setupActive pinned setup.plant to the order's plant
      if (!predecessorState || !successorState) return storeChargedSetupMinutes(plantOfLine, line, null);
      const resolved = resolveSetup({
        definition, machine: line, predecessorState, successorState,
        predecessorOrderId: String(predecessor.id), successorOrderId: String(successor.id),
        plantRows: setup.plant_rows, machineRows: setup.machine_rows, overrides: setup.overrides, valueDefaults: setup.value_defaults ?? NO_VALUE_DEFAULTS,
        index: setupResolutionIndexFor(setup as SetupSnapshot & { definition: SetupDefinition }),
      });
      return storeChargedSetupMinutes(plantOfLine, line, resolved);
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
    try {
      for (const p of peers) {
        // Peer ends before the changed task starts — entirely prior, cannot overlap; skip.
        if (p.end_date! <= changed.start_date) continue;
        const requiredSetupMinutes = setupMinutes(predecessor, p);
        const requiredStart = new Date(cursor.getTime() + requiredSetupMinutes * Config.MS_MIN);
        if (p.start_date! >= requiredStart) { cursor = new Date(p.end_date!); predecessor = p; continue; }
        // G-0.25: a row carrying an approved placement exception is as fixed as a firmed one.
        if (Store.isFirmed(p.id) || p.placement_exception || Engine.isInProgress(p) || Engine.isFrozenHorizon(p, undefined, _frozenEnd) || p.end_date! < _horizonStart) {
          // Firmed, frozen-window, or aged orders don't move — if there's a
          // conflict, an alert will fire — but later unfirmed peers must still
          // be de-overlapped, and the immovable order becomes the setup
          // predecessor they pay for.
          cursor = new Date(Math.max(cursor.getTime(), p.end_date!.getTime()));
          predecessor = p;
          continue;
        }
        // This peer is about to be MOVED — its new FINISH must not land inside the plant's frozen window
        // (finish floor; a straddler may start inside it).
        const placement = placeReflowed(p, cursor, requiredSetupMinutes);
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
    } finally {
      if (calendarRunStarted) Calendar._endRun();
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
      if (!task || !isReconcileEligible(task)) continue;
      const plant = Store.getPlantForLine(task.MACHINE);
      if (plant) plants.add(plant);
    }
    for (const plant of plants) Engine.reconcileRuntimeSchedules(plant);
  }
}, 'engine.runtime-reconcile');

// OQ21: an undo restores the finish, so the start is re-derived under the run time as it is now. The Store cannot
// import the engine (platform sits below it); the engine registers this hook once at load.
UndoStack.afterRestore = (ids: string[], wasDirty: ReadonlySet<string>): void => Engine.reconcileRestored(ids, wasDirty);
// U23: restoreTasks flags a row stale only when the reconcile will process it (the same eligibility its candidate
// filter applies); any other row would keep the flag, and its error alert, until reload.
UndoStack.willRederive = (task: NimbusTask): boolean => {
  // D14: every line derives (own calendar row or the plant default), so the per-line calendar check is gone.
  return !!task.MACHINE && task.planning_status !== 'needs_planning' && !task.placement_exception;
};
// F10: the snapshot records which rows already carried unsaved edits (the platform cannot see Persistence).
UndoStack.dirtyProbe = (id: string): boolean => Persistence.isDirty(id);

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
export function evaluateSchedule(snapshot: Readonly<ScheduleSnapshot>, request: EngineEvaluationRequest = {}): CandidateResult {
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
  candidate: Omit<CandidateResult, 'validationContext'>,
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
  if (serialized.finishFloor !== undefined && serialized.finishFloor !== null && !isDateFieldValid(serialized.finishFloor)) malformed('finishFloor');
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
    finishFloor: serialized.finishFloor === undefined || serialized.finishFloor === null ? null : rehydrateDate(serialized.finishFloor),
    ...(serialized.ignorePlantWindow === true ? { ignorePlantWindow: true } : {}),
    ...(serialized.ignoreToolRule === true ? { ignoreToolRule: true } : {}),
  };
  const validationSnapshot: ScheduleSnapshot = {
    ...snapshot,
    firmedIds: new Set(serialized.effectiveFirmedIds),
  };
  return { ...candidate, validationContext: { snapshot: validationSnapshot, baselineSnapshot: snapshot, bounds } };
}
