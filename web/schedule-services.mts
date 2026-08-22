// schedule-services.mts — CQ-1 schedule-services module.
//
// Owns calendar capacity math, the Compute worker client, Alerts computation,
// Utilization, and Engine (optimizer + auto-reflow). Delegates
// algorithmic truth to nimbus-compute-core.js and preserves the existing
// worker protocol byte-for-byte. May import from schedule-data.mjs; must
// never be imported by it. DOM/UI code that was co-located with these
// modules in app.js (the calendar blackout-block tab; the alerts drawer,
// bell badge, and cell-briefing modal) stays in app.js as thin adapters
// (`CalendarUI`, `AlertsUIAdapter`) — see
// docs/architecture/cq1-compatibility-inventory.md.
//
// This file subscribes (once, below Alerts) to the `schedule:hydrated` Store
// event that schedule-data.mjs's Persistence emits after every load/cache-
// restore/demo-seed, and triggers Alerts.scheduleRecompute() in response —
// the resolution for the one real data→services dependency Persistence used
// to satisfy with a direct `Alerts.scheduleRecompute()` call. This is a Store
// event subscription, not an import: schedule-data.mjs still never imports
// this file.
//
// nimbus-compute-core.js is loaded as a classic, parser-blocking <script> in
// index.html BEFORE app-entry.mjs's static imports run (see index.html's
// document.write chain), so `globalThis.NimbusComputeCore` (== window in the
// browser) is already populated by the time any function in this file is
// actually called. Referencing it via `globalThis` (rather than a bare
// identifier) keeps this file lint-clean under the `web/**/*.mjs` ESLint
// block, which does not declare NimbusComputeCore as a global (unlike the
// classic-script block covering the now-deleted app.js copy of Calendar).
// Node tests import this module directly and must set
// `globalThis.NimbusComputeCore` themselves before calling into Calendar —
// see tests/modules/schedule-services.test.mjs and the load-legacy-app.mjs
// VM harness for the two bootstrap sites.
import { Config, Util, ErrorLog, PerfMonitor, Toast } from './application-foundation.mjs';
import { Store, UndoStack } from './schedule-state.mjs';
import {
  placeWithSetup as placeWithSetupPure,
  evaluateDueDateFirst as evaluateDueDateFirstPure,
  evaluateMinChangeover as evaluateMinChangeoverPure,
  evaluateSptWithSetup as evaluateSptWithSetupPure,
  evaluateThroughput as evaluateThroughputPure,
  SETUP_AWARE_CONVERGENCE_WINDOW,
} from './setup-scheduler.mjs';
import { resolveSetup, stateForOrder } from './setup-domain.mjs';
import type {
  CandidateDiagnostic,
  CandidateResult,
  DueDateFirstBounds,
  SetupPolicyThresholds,
  PlacementResult,
  PlaceWithSetupRequest,
  SchedulePatch,
  ScheduleSnapshot,
} from './setup-scheduler.mjs';
import type { NimbusTask, NimbusBlock, NimbusPlantBlock, WorkHours, NimbusLineSetting, NimbusMasterData, ConstraintConfig, OptimizerMode, OrderScheduleSegment, SplitOrderPolicy, SetupSnapshot, SetupStateKey } from './types.mjs';

// -- Local type declarations (Phase 3 conversion; scoped to this file) ------
interface CalendarEntry {
  workHours: WorkHours;
}

interface BlockRec {
  s: number;
  e: number;
  startDate: Date;
  endDate: Date;
}

interface RunBlocksIndex {
  byLine: Map<string, BlockRec[]>;
  byPlant: Map<string, BlockRec[]>;
}

interface CapRec {
  s: Date;
  e: Date;
  plant: string | null;
}

interface PlantCapRec {
  s: Date;
  e: Date;
}

interface CapacityBlockIndex {
  lineBlocks: Map<string, CapRec[]>;
  globalLine: CapRec[];
  plantBlocks: Map<string, PlantCapRec[]>;
  globalPlant: PlantCapRec[];
}

export interface RemoveBacklogDiagnostics {
  backlogFound: number;
  moved: number;
  fixedMoved: number;
  movedRuntimeHours: number;
  largestDelayMinutes: number;
  invalidRuntimeIds: string[];
  missingStartIds: string[];
  overlongIds: string[];
  calendarSearchFailures: Array<{ line: string; taskId?: string; reason: 'no-operating-interval' | 'search-exhausted' }>;
  boundaryConflicts: Array<{ line: string; movedTaskId: string; protectedTaskId?: string; type: 'overlap' }>;
}

export interface RemoveBacklogResult {
  patches: Array<{ id: string; changes: Partial<NimbusTask> }>;
  diagnostics: RemoveBacklogDiagnostics;
}

type BacklogSlot =
  | { kind: 'slot'; start: Date }
  | { kind: 'overlong'; start: Date }
  | { kind: 'unavailable' | 'exhausted' };

export type RuntimeAllocation =
  | { kind: 'allocated'; start: Date; end: Date; scheduleSegments: OrderScheduleSegment[] }
  | { kind: 'unavailable' | 'exhausted' };

/** B3 (2026-08-21): default productive-segment floor (minutes) — no split
 * piece may be shorter than this, except one complete unsplit order below
 * the boundary. Phase-1 shipped this fixed system-wide; it is now the
 * DEFAULT ONLY, plant-overridable via `plants.min_productive_segment_minutes`
 * — see `Engine.minProductiveSegmentMinutesFor`, which resolves the per-plant
 * value and falls back to this default when unset/null. Keep allocator
 * arithmetic on this named boundary. Canonical for both this file's
 * `Calendar.allocateRuntime` (non-setup-aware) path and setup-scheduler.mjs's
 * `placeWithSetup` (setup-aware) path, which pulls this in through its
 * existing import of this module rather than declaring its own copy. */
export const MIN_PRODUCTIVE_SEGMENT_MINUTES = 30;

/** Fields common to both the ALERTS and UTILIZATION worker payloads (Compute._snap's return). */
interface WorkerSnapshotBase {
  tasks: NimbusTask[];
  blocks: NimbusBlock[];
  plantBlocks: NimbusPlantBlock[];
  calendars: Record<string, CalendarEntry>;
  plants: Record<string, CalendarEntry>;
  lineSettings: Record<string, NimbusLineSetting>;
  masterData: NimbusMasterData | null;
  setup: SetupObservation;
}

/** Utilization.computeMatrix's row shape — tasks RESOLVED to objects (see T-8 in
 *  docs/typescript_migration.md: this is deliberately NOT the same type as the
 *  ambient NimbusUtilizationRow, whose `tasks: string[]` is the pre-resolution
 *  worker/core contract shape). */
interface UtilizationRowResolved {
  date: Date;
  scheduled: number;
  capacity: number;
  effectiveCapacity: number;
  tasks: NimbusTask[];
  pct?: number;
}

interface UtilizationMatrixResolved {
  [line: string]: Record<string, UtilizationRowResolved>;
}

/** Utilization.dayByLine/todayByLine's row shape — a THIRD, distinct shape:
 *  no date/tasks at all. */
interface DayByLineRow {
  capacity: number;
  effectiveCapacity: number;
  scheduled: number;
  pct: number;
}

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
 * `plant` (Phase 2, Pkg D — clone reduction) is optional: when the caller
 * already knows which plant it is about to evaluate, only THAT plant's lines
 * are cloned into `calendars` (derived via Store.getPlantForLine, the same
 * lineSettings/masterData resolution every other line→plant lookup in this
 * file uses) instead of every line the session has ever visited. Every other
 * member stays whole (tasks/fixedIds/alerts/blocks/plantBlocks/plants/
 * lineSettings/masterData/priorityRankMaps) — downstream reads depend on
 * them being unscoped.
 *
 * The filter below only DROPS a line when Store.getPlantForLine positively
 * resolves it to a *different* plant. A line Store can't resolve (no
 * lineSettings/masterData entry) is KEPT rather than dropped: getPlantForLine
 * is lineSettings/masterData-only, but setup-scheduler's resolveTaskPlant
 * also checks each task's own PLANT field, so a line with no master-data
 * plant mapping can still be scheduled for this plant via its tasks' PLANT.
 * Dropping such a line's calendar here would silently starve it of real work
 * hours — freeIntervalsFor falls back to a default 7:00-19:00 window and
 * hasNominalWindow returns false, producing wrongful overlong splits under
 * 'overlong_only'. Confirmed safe otherwise: every ScheduleSnapshot.calendars
 * consumer (setup-scheduler.mts's freeIntervalsFor/jointWindowForDay/
 * hasNominalWindow, and sourceLineWorkHours below) only ever looks up a
 * `line` that already passed the SAME plant's task filter upstream. Omitting
 * `plant` (or passing none) reproduces the prior unscoped behavior exactly. */
export function snapshotSchedule(plant?: string): ScheduleSnapshot {
  const _pmT0s = performance.now();
  try {
    const sourceCalendars = plant
      ? Object.fromEntries(Object.entries(Store.calendars).filter(([line]) => {
          const p = Store.getPlantForLine(line);
          return !p || p === plant;
        }))
      : Store.calendars;
    return {
      tasks: structuredClone(Store.tasksArr),
      fixedIds: Array.from(Store.fixedIds),
      alerts: structuredClone(Store.alerts),
      selectedPlant: Store.selectedPlant,
      blocks: structuredClone(Store.blocks),
      plantBlocks: structuredClone(Store.plantBlocks),
      calendars: structuredClone(sourceCalendars),
      plants: structuredClone(Store.plants),
      lineSettings: structuredClone(Store.lineSettings),
      masterData: structuredClone(Store.masterData),
      priorityRankMaps: structuredClone(Store.priorityRankMaps),
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

function setupAvailabilityMinutes(
  context: SetupAvailabilityContext | undefined,
  line: string,
  plant: string,
  successorOrderId: string,
  end: Date,
  orders: ReadonlyArray<{ task: NimbusTask; start: Date; end: Date }>,
  fallbackStart: Date | null,
): number {
  if (!context) return fallbackStart ? Math.max(0, (end.getTime() - fallbackStart.getTime()) / (60 * 1000)) : 0;
  // Setup observations are already scoped by the setup snapshot plant. A line
  // code may be reused at another plant, so master-data lookup is unsafe here.
  const mappedPlant = plant;
  const probe = new Date(end.getTime() - 1);
  const lineHours = context.calendars[line]?.workHours ?? setupDefaultWorkHours();
  const lineWindow = globalThis.NimbusComputeCore!._dayWindow(lineHours, probe);
  if (!lineWindow) return 0;
  const plantHours = context.plants[mappedPlant]?.workHours ?? setupDefaultWorkHours();
  const plantWindow = globalThis.NimbusComputeCore!._dayWindow(plantHours, probe);
  if (!plantWindow) return 0;
  const window = [
    new Date(Math.max(lineWindow[0].getTime(), plantWindow[0].getTime())),
    new Date(Math.min(lineWindow[1].getTime(), plantWindow[1].getTime())),
  ] as const;
  if (window[0] >= window[1]) return 0;
  if (end > window[1] || end <= window[0]) return 0;
  let lower = window[0].getTime();
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
  for (const order of orders) {
    if (String(order.task.id) === successorOrderId) continue;
    for (const interval of setupOrderIntervals(order.task)) {
      if (interval.start >= end || interval.end <= new Date(lower)) continue;
      if (interval.end >= end) return 0;
      lower = Math.max(lower, interval.end.getTime());
    }
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
            availability, line, setup.plant, String(order.task.id), end, orders, predecessorEnd,
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

/** Keep candidate-only warnings/errors out of ErrorLog's IndexedDB/backend path.
 * Live optimizer and repair runs retain their existing ErrorLog behavior. */
function reportSchedulerDiagnostic(
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
function sourceBlocks(): ReadonlyArray<NimbusBlock> { return _candidateSnapshot?.blocks ?? Store.blocks; }
function sourcePlantBlocks(): ReadonlyArray<NimbusPlantBlock> { return _candidateSnapshot?.plantBlocks ?? Store.plantBlocks; }
function sourceLineSettings(): Readonly<Record<string, NimbusLineSetting>> { return _candidateSnapshot?.lineSettings ?? Store.lineSettings; }
function sourceMasterData(): NimbusMasterData | null { return _candidateSnapshot?.masterData ?? Store.masterData; }
function sourcePriorityRankMaps() { return _candidateSnapshot?.priorityRankMaps ?? Store.priorityRankMaps; }
function sourceSelectedPlant(): string | null { return _candidateSnapshot?.selectedPlant ?? Store.selectedPlant; }

function sourceGetPlantForLine(line: string): string | null {
  if (!_candidateSnapshot) return Store.getPlantForLine(line);
  return _candidateSnapshot.lineSettings[line]?.plant
    ?? _candidateSnapshot.masterData?.lines.find(row => row.machine === line)?.plant
    ?? null;
}

function sourceTasksByPlant(plant: string | null): NimbusTask[] {
  if (!_candidateSnapshot) return Store.tasksByPlant(plant);
  if (!plant) return [];
  return _candidateSnapshot.tasks.filter(task => (task.PLANT || sourceGetPlantForLine(task.MACHINE)) === plant);
}

function sourceTask(id: string): NimbusTask | undefined {
  return _candidateSnapshot ? _candidateSnapshot.tasks.find(task => String(task.id) === String(id)) : Store.tasks[id];
}

function isFixedIdSet(fixed: readonly string[] | ReadonlySet<string>): fixed is ReadonlySet<string> {
  return !Array.isArray(fixed);
}

function sourceIsFixed(id: string | number): boolean {
  if (!_candidateSnapshot) return Store.isFixed(id);
  const fixed = _candidateSnapshot.fixedIds;
  if (isFixedIdSet(fixed)) return fixed.has(String(id));
  return fixed.map(String).includes(String(id));
}

// B6: exported so setup-scheduler.mts's freeIntervalsFor can fall back to the
// same default work hours as the alerts path (setupDefaultWorkHours above)
// and the detached-candidate path (sourceLineWorkHours/sourcePlantWorkHours
// below), instead of returning [] and silently placing nothing for a whole
// plant/line missing a calendar.
export function candidateDefaultWorkHours(): WorkHours {
  const workHours: WorkHours = {};
  for (let day = 0; day < 7; day++) {
    workHours[day] = Config.WEEKEND_OFF && (day === 0 || day === 6)
      ? null
      : [Config.DEFAULT_SHIFT[0], Config.DEFAULT_SHIFT[1]];
  }
  return workHours;
}

function sourceLineWorkHours(line: string): WorkHours {
  if (!_candidateSnapshot) {
    Store.ensureCalendar(line);
    return Store.calendars[line].workHours;
  }
  return _candidateSnapshot.calendars[line]?.workHours ?? candidateDefaultWorkHours();
}

function sourcePlantWorkHours(plant: string): WorkHours {
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
    // setup-scheduler.mts) — a detached legacy result has no coverage concept
    // of its own, so it contributes 0.
    score: [0, 0, 0, 0, 0, patches.length, 0],
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
   CALENDAR — capacity math only (working hours, blackout-block availability).
   All functions operate on a `line` (string) + Date objects. The blackout-
   block-TAB UI (render/openBlockModal/saveBlockFromModal/etc.) stayed behind
   in app.js as `CalendarUI` — see CalendarUI there for the UI half.
   ========================================================================== */
export const Calendar = {
  /* ---------- Per-run caches (installed by Engine.runAndApply) ----------- */
  // workWindow memoization, keyed by `${line}|${startOfDayMs}`. Values are
  // `null` (closed day) or the same [Date, Date] tuple returned to every
  // caller during one run — callers must NOT mutate window endpoints.
  _runCache: null as { ww: Map<string, [Date, Date] | null> } | null,
  // Pre-parsed blackout blocks scoped to the plant being optimized.
  // { byLine: Map<line|'__any__', BlockRec[]>, byPlant: Map<plant|'__any__', BlockRec[]> }
  // where BlockRec = { s: ms, e: ms, startDate: Date, endDate: Date }.
  _runBlocks: null as RunBlocksIndex | null,

  /** Install per-run caches. Called once at the top of Engine.runAndApply. */
  _beginRun(plant: string | null): void {
    Calendar._runCache  = { ww: new Map() };
    Calendar._runBlocks = Calendar._indexBlocks(plant);
  },
  /** Tear down per-run caches. Called in a finally{} so it always runs. */
  _endRun(): void {
    Calendar._runCache  = null;
    Calendar._runBlocks = null;
  },
  /** Parse every blackout block once and bucket by line / plant for O(1) lookup. */
  _indexBlocks(plant: string | null): RunBlocksIndex {
    const byLine = new Map<string, BlockRec[]>();
    for (const b of sourceBlocks()) {
      // A block applies only within its own plant (line:null = all lines in that
      // plant). Un-stamped legacy blocks (no b.plant) fall back to global behavior.
      if (b.plant && plant && b.plant !== plant) continue;
      const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
      if (!s || !e) continue;
      const key = b.line || '__any__';
      let arr = byLine.get(key);
      if (!arr) { arr = []; byLine.set(key, arr); }
      arr.push({ s: s.getTime(), e: e.getTime(), startDate: s, endDate: e });
    }
    const byPlant = new Map<string, BlockRec[]>();
    for (const b of sourcePlantBlocks()) {
      if (b.plant && plant && b.plant !== plant) continue;
      const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
      if (!s || !e) continue;
      const key = b.plant || '__any__';
      let arr = byPlant.get(key);
      if (!arr) { arr = []; byPlant.set(key, arr); }
      arr.push({ s: s.getTime(), e: e.getTime(), startDate: s, endDate: e });
    }
    return { byLine, byPlant };
  },

  /** Returns [startDate, endDate] for a workHours map + date, or null if closed.
   *  Delegates to the shared compute core (single source of truth; handles the
   *  fractional-hour split so 08:30 isn't floored to 08:00). */
  _dayWindow(workHours: WorkHours, date: Date): [Date, Date] | null {
    return globalThis.NimbusComputeCore!._dayWindow(workHours, date);
  },

  /** Returns [startDate, endDate] for a line+day, intersected with plant hours.
   *  Returns null if either the line or plant is closed that day, or the
   *  intersection is empty. */
  workWindow(line: string, date: Date): [Date, Date] | null {
    const rc = Calendar._runCache;
    let key = '';
    if (rc) {
      const d = new Date(date); d.setHours(0, 0, 0, 0);
      key = line + '|' + d.getTime();
      if (rc.ww.has(key)) return rc.ww.get(key)!;
    }

    const lineWin = Calendar._dayWindow(sourceLineWorkHours(line), date);
    if (!lineWin) {
      if (rc) rc.ww.set(key, null);
      return null;
    }

    const plant = sourceGetPlantForLine(line);
    let result: [Date, Date];
    if (plant) {
      const plantWin = Calendar._dayWindow(sourcePlantWorkHours(plant), date);
      if (!plantWin) {
        if (rc) rc.ww.set(key, null);
        return null;
      }
      const s = new Date(Math.max(lineWin[0].getTime(), plantWin[0].getTime()));
      const e = new Date(Math.min(lineWin[1].getTime(), plantWin[1].getTime()));
      if (s >= e) {
        if (rc) rc.ww.set(key, null);
        return null;
      }
      result = [s, e];
    } else {
      result = lineWin;
    }

    if (rc) rc.ww.set(key, result);
    return result;
  },

  /** Total working hours in a day for a given line, after blackouts. Does not apply buffer.
   *  Uses interval union so overlapping (or accidentally duplicated) blackout
   *  blocks can never double-count and drive capacity negative. */
  /** Pre-parse + bucket all blackout blocks ONCE so a tight (line × day) loop can
   *  reuse the parsed Date objects instead of re-parsing every block per cell.
   *  Pass the returned index as the 3rd arg of dailyCapacityHours. Cheap to build
   *  (one parse pass over Store.blocks/plantBlocks); build it once per matrix call.
   *  Distinct from _indexBlocks(plant), which builds the Engine-run _runBlocks cache. */
  _indexCapacityBlocks(): CapacityBlockIndex {
    const lineBlocks = new Map<string, CapRec[]>(), globalLine: CapRec[] = [], plantBlocks = new Map<string, PlantCapRec[]>(), globalPlant: PlantCapRec[] = [];
    for (const b of Store.blocks) {
      const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
      if (!s || !e) continue;
      // Carry the block's plant so dailyCapacityHours can scope line:null blocks
      // (globalLine) to their own plant; line-code reuse across plants is likewise
      // resolved by plant, not just the line string.
      const rec: CapRec = { s, e, plant: b.plant || null };
      if (b.line) { let a = lineBlocks.get(b.line); if (!a) lineBlocks.set(b.line, a = []); a.push(rec); }
      else globalLine.push(rec);
    }
    for (const b of Store.plantBlocks) {
      const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
      if (!s || !e) continue;
      if (b.plant) { let a = plantBlocks.get(b.plant); if (!a) plantBlocks.set(b.plant, a = []); a.push({ s, e }); }
      else globalPlant.push({ s, e });
    }
    return { lineBlocks, globalLine, plantBlocks, globalPlant };
  },

  dailyCapacityHours(line: string, date: Date, idx?: CapacityBlockIndex): number {
    const win = Calendar.workWindow(line, date);
    if (!win) return 0;
    const winHours = (win[1].getTime() - win[0].getTime()) / Config.MS_HOUR;

    const plant = Store.getPlantForLine(line);
    let intervals: Array<{ s: Date; e: Date }>;
    if (idx) {
      // Reuse pre-parsed, bucketed intervals (no parseDate per cell). line:null
      // blocks (globalLine) apply only within their own plant.
      intervals = [];
      const lb = idx.lineBlocks.get(line); if (lb) for (const x of lb) if (!x.plant || x.plant === plant) intervals.push(x);
      for (const x of idx.globalLine) if (!x.plant || x.plant === plant) intervals.push(x);
      const pb = idx.plantBlocks.get(plant!); if (pb) for (const x of pb) intervals.push(x);
      for (const x of idx.globalPlant) intervals.push(x);
    } else {
      intervals = [];
      for (const b of Store.blocks) {
        if (b.plant && b.plant !== plant) continue;
        if (b.line && b.line !== line) continue;
        const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
        if (s && e) intervals.push({ s, e });
      }
      for (const b of Store.plantBlocks) {
        if (b.plant && b.plant !== plant) continue;
        const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
        if (s && e) intervals.push({ s, e });
      }
    }

    const consumed = Util.mergedOverlapHours(win, intervals);
    return Math.max(0, winHours - consumed);
  },

  /** Maximum schedulable hours after deducting the capacity buffer.
   *  Nothing should be scheduled past this value (= total − buffer). */
  /** Apply a line's capacity buffer to an already-computed full-capacity value.
   *  The single source of truth for the buffer formula — callers that have already
   *  computed dailyCapacityHours (matrix cells, the alert overload loop) call this
   *  instead of effectiveCapacityHours so the full-capacity scan is not repeated.
   *  Delegates to the shared compute core. */
  effectiveFromCapacity(line: string, full: number): number {
    return globalThis.NimbusComputeCore!.effectiveFromCapacity(line, full, Store.lineSettings as any);
  },

  effectiveCapacityHours(line: string, date: Date): number {
    return Calendar.effectiveFromCapacity(line, Calendar.dailyCapacityHours(line, date));
  },

  /** True if `date` is inside the working window and not inside any blackout. */
  isAvailable(line: string, date: Date): boolean {
    const win = Calendar.workWindow(line, date);
    if (!win) return false;
    if (date < win[0] || date >= win[1]) return false;

    const plant = Store.getPlantForLine(line);
    for (const b of Store.blocks) {
      if (b.plant && b.plant !== plant) continue;
      if (b.line && b.line !== line) continue;
      const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
      if (!s || !e) continue;
      if (date >= s && date < e) return false;
    }

    for (const b of Store.plantBlocks) {
      if (b.plant && b.plant !== plant) continue;
      const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
      if (!s || !e) continue;
      if (date >= s && date < e) return false;
    }

    return true;
  },

  /** Advances `from` forward until a contiguous block of `durationMs` is
   *  available on `line`. Returns the starting Date (snapped). */
  nextAvailable(line: string, from: Date, durationMs: number): Date {
    let cur = Util.snap(new Date(from));
    const MAX_ITERS = 90 * 24;  // 90-day explicit bound: max day-jumps
    let iter = 0;

    while (iter++ < MAX_ITERS) {
      const win = Calendar.workWindow(line, cur);
      if (!win) {
        // jump to start of next day
        const next = new Date(cur); next.setDate(next.getDate() + 1); next.setHours(0,0,0,0);
        cur = next; continue;
      }
      if (cur < win[0]) cur = new Date(win[0]);
      if (cur >= win[1]) {
        // out of today's window — jump to tomorrow 00:00
        const next = new Date(cur); next.setDate(next.getDate() + 1); next.setHours(0,0,0,0);
        cur = next; continue;
      }
      const candidateEnd = new Date(cur.getTime() + durationMs);
      // Check that the whole range [cur, candidateEnd] fits in the window
      // and doesn't overlap any blackout block.
      if (candidateEnd > win[1]) {
        // Won't fit in today's window — jump to tomorrow
        const next = new Date(cur); next.setDate(next.getDate() + 1); next.setHours(0,0,0,0);
        cur = next; continue;
      }
      const conflict = Calendar._overlapsBlock(line, cur, candidateEnd);
      if (conflict) {
        cur = Util.snap(new Date(conflict.end));
        continue;
      }
      return cur;
    }
    // Loop exhausted: no feasible slot found within 90 days. Log for diagnostics.
    const plant = sourceGetPlantForLine(line);
    reportSchedulerDiagnostic(
      'error',
      'calendar',
      'calendar.next-available-exhausted',
      `nextAvailable exhausted iteration limit (${MAX_ITERS}) for line ${line} (plant ${plant}) seeking ${durationMs}ms slot from ${Util.fmtDTReadable(from)}`,
    );
    // fallback: return the original from; caller must handle
    return Util.snap(new Date(from));
  },

  /** True when a proposed range is entirely inside one effective operating
   * interval and clear of both line and plant blackout blocks. */
  fitsContinuous(line: string, start: Date, durationMs: number): boolean {
    const win = Calendar.workWindow(line, start);
    const end = new Date(start.getTime() + durationMs);
    return !!win && start >= win[0] && end <= win[1] && !Calendar._overlapsBlock(line, start, end);
  },

  /** Find the first minute at or after `from` that is operating time. This is
   * intentionally weaker than `nextAvailable`: it is only used by the
   * documented continuous-bar exception for inherently overlong orders. */
  nextOperatingInstant(line: string, from: Date): Date | null {
    const startMs = from.getTime();
    const roundedMs = startMs % Config.MS_MIN ? startMs + Config.MS_MIN - (startMs % Config.MS_MIN) : startMs;
    let cur = new Date(roundedMs);
    const limit = new Date(cur);
    limit.setDate(limit.getDate() + 90);
    while (cur < limit) {
      const win = Calendar.workWindow(line, cur);
      if (!win || cur >= win[1]) {
        cur.setDate(cur.getDate() + 1);
        cur.setHours(0, 0, 0, 0);
        continue;
      }
      if (cur < win[0]) cur = new Date(win[0]);
      const blackout = Calendar._overlapsBlock(line, cur, new Date(cur.getTime() + Config.MS_MIN));
      if (blackout) {
        const blackoutEnd = blackout.end.getTime();
        const nextMinute = blackoutEnd % Config.MS_MIN
          ? blackoutEnd + Config.MS_MIN - (blackoutEnd % Config.MS_MIN)
          : blackoutEnd;
        cur = new Date(nextMinute);
        continue;
      }
      return cur;
    }
    return null;
  },

  /** Is there any nominal (hours-only) plant/line intersection in the next
   * 90 calendar days large enough for this runtime? Dated blackouts are
   * intentionally ignored: they can exhaust normal placement, but do not make
   * a fundamentally fittable order "inherently overlong". */
  hasNominalWindow(line: string, from: Date, durationMs: number): boolean {
    const cur = new Date(from);
    cur.setHours(0, 0, 0, 0);
    for (let day = 0; day < 90; day++) {
      const win = Calendar.workWindow(line, cur);
      if (win && win[1].getTime() - win[0].getTime() >= durationMs) return true;
      cur.setDate(cur.getDate() + 1);
    }
    return false;
  },

  /** Backlog must preserve minute-level candidates: the established
   * `nextAvailable` helper snaps to the application's coarser drag grid, which
   * could turn an 08:01 request into 08:00 and incorrectly fit it before shift
   * close. Keep that legacy behavior intact and use this exact-minute variant
   * only for the new heuristic. */
  _nextContiguousMinuteSlot(line: string, from: Date, durationMs: number): Date | null {
    const ceilMinute = (date: Date): Date => {
      const ms = date.getTime();
      const remainder = ms % Config.MS_MIN;
      return new Date(remainder ? ms + Config.MS_MIN - remainder : ms);
    };
    let cur = ceilMinute(new Date(from));
    const limit = new Date(cur);
    limit.setDate(limit.getDate() + 90);
    while (cur < limit) {
      const win = Calendar.workWindow(line, cur);
      if (!win || cur >= win[1]) {
        cur.setDate(cur.getDate() + 1);
        cur.setHours(0, 0, 0, 0);
        continue;
      }
      if (cur < win[0]) cur = new Date(win[0]);
      const end = new Date(cur.getTime() + durationMs);
      if (end > win[1]) {
        cur.setDate(cur.getDate() + 1);
        cur.setHours(0, 0, 0, 0);
        continue;
      }
      const blackout = Calendar._overlapsBlock(line, cur, end);
      if (blackout) {
        cur = ceilMinute(new Date(blackout.end));
        continue;
      }
      return cur;
    }
    return null;
  },

  /** Backlog-specific placement contract. Unlike legacy `nextAvailable`, its
   * fallback is never accepted as a real ordinary slot. */
  findContiguousSlot(line: string, from: Date, durationMs: number): BacklogSlot {
    const operatingStart = Calendar.nextOperatingInstant(line, from);
    if (!operatingStart) return { kind: 'unavailable' };
    if (!Calendar.hasNominalWindow(line, from, durationMs)) return { kind: 'overlong', start: operatingStart };
    const start = Calendar._nextContiguousMinuteSlot(line, from, durationMs);
    return start ? { kind: 'slot', start } : { kind: 'exhausted' };
  },

  _ceilMinute(date: Date): Date {
    const ms = date.getTime();
    const remainder = ms % Config.MS_MIN;
    return new Date(remainder ? ms + Config.MS_MIN - remainder : ms);
  },

  _floorMinute(date: Date): Date {
    return new Date(date.getTime() - (date.getTime() % Config.MS_MIN));
  },

  /** All blackout intervals applicable to one concrete parent range, merged so
   * overlapping line/plant blocks never create a false productive gap. */
  _blockingIntervals(line: string, start: Date, end: Date): Array<{ start: Date; end: Date }> {
    const intervals: Array<{ start: Date; end: Date }> = [];
    const add = (s: Date, e: Date): void => {
      if (s < end && e > start) {
        intervals.push({
          start: new Date(Math.max(s.getTime(), start.getTime())),
          end: new Date(Math.min(e.getTime(), end.getTime())),
        });
      }
    };
    const cached = Calendar._runBlocks;
    if (cached) {
      for (const block of cached.byLine.get(line) || []) add(block.startDate, block.endDate);
      for (const block of cached.byLine.get('__any__') || []) add(block.startDate, block.endDate);
      const plant = sourceGetPlantForLine(line);
      if (plant) for (const block of cached.byPlant.get(plant) || []) add(block.startDate, block.endDate);
      for (const block of cached.byPlant.get('__any__') || []) add(block.startDate, block.endDate);
    } else {
      const plant = sourceGetPlantForLine(line);
      for (const block of sourceBlocks()) {
        if (block.plant && block.plant !== plant) continue;
        if (block.line && block.line !== line) continue;
        const s = Util.parseDate(block.start), e = Util.parseDate(block.end);
        if (s && e) add(s, e);
      }
      for (const block of sourcePlantBlocks()) {
        if (block.plant && block.plant !== plant) continue;
        const s = Util.parseDate(block.start), e = Util.parseDate(block.end);
        if (s && e) add(s, e);
      }
    }
    intervals.sort((a, b) => a.start.getTime() - b.start.getTime());
    const merged: Array<{ start: Date; end: Date }> = [];
    for (const interval of intervals) {
      const prior = merged[merged.length - 1];
      if (prior && interval.start <= prior.end) {
        if (interval.end > prior.end) prior.end = interval.end;
      } else {
        merged.push({ start: new Date(interval.start), end: new Date(interval.end) });
      }
    }
    return merged;
  },

  /** Enumerate effective operating fragments without mutating task or calendar
   * state. The 90-day cap is shared with the existing slot search. */
  _freeIntervals(line: string, from: Date): Array<{ start: Date; end: Date }> {
    const earliest = Calendar._ceilMinute(new Date(from));
    const day = new Date(earliest); day.setHours(0, 0, 0, 0);
    const out: Array<{ start: Date; end: Date }> = [];
    for (let offset = 0; offset < 90; offset++) {
      const date = new Date(day); date.setDate(day.getDate() + offset);
      const win = Calendar.workWindow(line, date);
      if (!win) continue;
      let cursor = Calendar._ceilMinute(new Date(Math.max(win[0].getTime(), earliest.getTime())));
      const windowEnd = Calendar._floorMinute(win[1]);
      if (cursor >= windowEnd) continue;
      for (const block of Calendar._blockingIntervals(line, cursor, windowEnd)) {
        const freeEnd = Calendar._floorMinute(block.start);
        if (freeEnd > cursor) out.push({ start: new Date(cursor), end: freeEnd });
        const next = Calendar._ceilMinute(block.end);
        if (next > cursor) cursor = next;
        if (cursor >= windowEnd) break;
      }
      if (cursor < windowEnd) out.push({ start: new Date(cursor), end: new Date(windowEnd) });
    }
    return out;
  },

  _hasNominalOperatingWindow(line: string, from: Date): boolean {
    const day = new Date(from); day.setHours(0, 0, 0, 0);
    for (let offset = 0; offset < 90; offset++) {
      const date = new Date(day); date.setDate(day.getDate() + offset);
      const win = Calendar.workWindow(line, date);
      if (win && win[1] > win[0]) return true;
    }
    return false;
  },

  /** Allocate canonical runtime minutes under the selected plant policy. This
   * is deliberately task-store pure: callers receive a complete parent patch
   * or a bounded failure and decide when to mutate/preview/persist it. */
  allocateRuntime(line: string, earliestStart: Date, runtimeMinutes: number,
                  policy: SplitOrderPolicy = 'never'): RuntimeAllocation {
    const totalMinutes = Math.round(Number(runtimeMinutes));
    if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return { kind: 'exhausted' };
    const durationMs = totalMinutes * Config.MS_MIN;
    const from = Calendar._ceilMinute(new Date(earliestStart));
    const normalizedPolicy: SplitOrderPolicy =
      policy === 'overlong_only' || policy === 'partial_allowed' ? policy : 'never';

    if (normalizedPolicy === 'never') {
      const slot = Calendar.findContiguousSlot(line, from, durationMs);
      if (!('start' in slot)) return { kind: slot.kind };
      return {
        kind: 'allocated', start: slot.start,
        end: new Date(slot.start.getTime() + durationMs), scheduleSegments: [],
      };
    }

    const inherentlyOverlong = !Calendar.hasNominalWindow(line, from, durationMs);
    if (normalizedPolicy === 'overlong_only' && !inherentlyOverlong) {
      const start = Calendar._nextContiguousMinuteSlot(line, from, durationMs);
      return start
        ? { kind: 'allocated', start, end: new Date(start.getTime() + durationMs), scheduleSegments: [] }
        : { kind: 'exhausted' };
    }
    if (!Calendar._hasNominalOperatingWindow(line, from)) return { kind: 'unavailable' };

    const minSegmentMinutes = Engine.minProductiveSegmentMinutesFor(sourceGetPlantForLine(line));
    const pieces: Array<{ start: Date; end: Date }> = [];
    let remaining = totalMinutes;
    for (const free of Calendar._freeIntervals(line, from)) {
      const capacity = Math.floor((free.end.getTime() - free.start.getTime()) / Config.MS_MIN);
      if (capacity <= 0) continue;
      let take = Math.min(remaining, capacity);
      if (remaining > take && remaining - take < minSegmentMinutes) {
        take = remaining - minSegmentMinutes;
      }
      // A partial piece must never be smaller than the plant's configured (or
      // default 30-minute) floor. Skip a tiny fragment and continue the
      // bounded search for a usable one.
      if (take < minSegmentMinutes
          && !(pieces.length === 0 && remaining === totalMinutes
               && totalMinutes < minSegmentMinutes && take === totalMinutes)) {
        continue;
      }
      const end = new Date(free.start.getTime() + take * Config.MS_MIN);
      pieces.push({ start: new Date(free.start), end });
      remaining -= take;
      if (remaining === 0) break;
    }
    if (remaining !== 0 || !pieces.length) return { kind: 'exhausted' };

    const merged: Array<{ start: Date; end: Date }> = [];
    for (const piece of pieces) {
      const prior = merged[merged.length - 1];
      if (prior && prior.end.getTime() === piece.start.getTime()) prior.end = piece.end;
      else merged.push({ start: new Date(piece.start), end: new Date(piece.end) });
    }
    const start = merged[0].start;
    const end = merged[merged.length - 1].end;
    return {
      kind: 'allocated', start, end,
      scheduleSegments: merged.length >= 2
        ? merged.map((piece, index) => ({ sequence: index + 1, startDate: piece.start, endDate: piece.end }))
        : [],
    };
  },

  /** Adapter for the pure setup-placement primitive. It gathers the same
   * effective operating fragments the existing allocator uses, including
   * line/plant hours and blackouts, but never reads setup state or mutates a
   * task. Setup-aware Engine activation remains intentionally deferred. */
  placeWithSetup(
    line: string,
    request: Omit<PlaceWithSetupRequest, 'freeIntervals' | 'isInherentlyOverlong'>,
  ): PlacementResult {
    const runtimeMinutes = Math.round(Number(request.runtimeMinutes));
    const durationMs = runtimeMinutes * Config.MS_MIN;
    const isInherentlyOverlong = Number.isFinite(runtimeMinutes) && runtimeMinutes > 0
      && !Calendar.hasNominalWindow(line, request.earliestStart, durationMs);
    return placeWithSetupPure({
      ...request,
      freeIntervals: Calendar._freeIntervals(line, request.earliestStart),
      isInherentlyOverlong,
    });
  },

  /** Find the first blackout block overlapping [start,end) on `line`, else null. */
  _overlapsBlock(line: string, start: Date, end: Date): { start: Date; end: Date } | null {
    const rb = Calendar._runBlocks;
    if (rb) {
      const startMs = start.getTime ? start.getTime() : +start;
      const endMs   = end.getTime   ? end.getTime()   : +end;
      const scanLine = rb.byLine.get(line);
      if (scanLine) {
        for (const b of scanLine) {
          if (startMs < b.e && endMs > b.s) return { start: b.startDate, end: b.endDate };
        }
      }
      const scanLineAny = rb.byLine.get('__any__');
      if (scanLineAny) {
        for (const b of scanLineAny) {
          if (startMs < b.e && endMs > b.s) return { start: b.startDate, end: b.endDate };
        }
      }
      const plant = sourceGetPlantForLine(line);
      const scanPlant = plant ? rb.byPlant.get(plant) : null;
      if (scanPlant) {
        for (const b of scanPlant) {
          if (startMs < b.e && endMs > b.s) return { start: b.startDate, end: b.endDate };
        }
      }
      const scanPlantAny = rb.byPlant.get('__any__');
      if (scanPlantAny) {
        for (const b of scanPlantAny) {
          if (startMs < b.e && endMs > b.s) return { start: b.startDate, end: b.endDate };
        }
      }
      return null;
    }

    const plant = sourceGetPlantForLine(line);
    for (const b of sourceBlocks()) {
      if (b.plant && b.plant !== plant) continue;
      if (b.line && b.line !== line) continue;
      const bs = Util.parseDate(b.start), be = Util.parseDate(b.end);
      if (!bs || !be) continue;
      if (start < be && end > bs) return { start: bs, end: be };
    }
    for (const b of sourcePlantBlocks()) {
      if (b.plant && b.plant !== plant) continue;
      const bs = Util.parseDate(b.start), be = Util.parseDate(b.end);
      if (!bs || !be) continue;
      if (start < be && end > bs) return { start: bs, end: be };
    }
    return null;
  },
};

/* =============================================================================
   COMPUTE — singleton Web Worker wrapper for off-main-thread computation.
   Alerts.recompute and Utilization pre-warming post through here.
   Falls back to synchronous (main-thread) compute if the worker is unavailable.
   ========================================================================== */
export const Compute = (() => {
  let _worker: Worker | null = null;
  let _dead   = false;
  let _crashCount = 0;
  let _seq    = 0;
  const _pending = new Map<number, { resolve: (value: any) => void; reject: (reason?: any) => void }>(); // id → { resolve, reject }

  function _init(): Worker | null {
    if (_dead || _worker) return _worker;
    try {
      // Cache-bust the worker with the build id so a redeployed worker isn't served
      // stale from the HTTP cache — otherwise mirrored Calendar/Alerts fixes here
      // would silently diverge from the worker's hand-port. (Config.BUILD_ID tracks
      // NIMBUS_BUILD_ID, kept in sync with APP_VERSION on every deploy.)
      _worker = new Worker('nimbus-worker.js?v=' + Config.BUILD_ID);
      _worker.onmessage = ({ data }) => {
        const p = _pending.get(data.id);
        if (!p) return;
        _pending.delete(data.id);
        if (data.type === 'ERROR') {
          // Worker reported a compute failure (see §1.7 contract): carries
          // error/stack/failingType. Log before rejecting so the failure is
          // visible even if the caller swallows the rejection.
          const wMsg = `worker compute error${data.failingType ? ' (' + data.failingType + ')' : ''}: ${data.error || 'unknown'}`;
          ErrorLog.error('worker', wMsg,
            { failingType: data.failingType, jobId: data.jobId },
            { errorCode: 'worker.compute', stack: data.stack });
          p.reject(new Error(data.error));
        } else {
          p.resolve(data);
        }
      };
      _worker.onerror = (ev) => {
        // Build {message, filename, lineno, colno} from the ErrorEvent and log
        // BEFORE deciding whether to disable the worker (the only record of why
        // the worker crashed).
        const detail = {
          message:  ev?.message || 'worker error',
          filename: ev?.filename || '',
          lineno:   ev?.lineno ?? null,
          colno:    ev?.colno ?? null,
        };
        _crashCount++;
        const logFn = _crashCount === 1 ? 'warn' : 'error';
        try {
          ErrorLog[logFn]('worker', `worker crashed (attempt ${_crashCount}): ${detail.message}`, detail,
            { errorCode: 'worker.compute' });
        } catch {}
        for (const p of _pending.values()) p.reject(new Error('worker error'));
        _pending.clear();
        _worker = null;
        if (_crashCount >= 2) {
          // Permanent failure: give up on the worker for the session.
          _dead = true;
        }
        // Otherwise: allow retry on next _init() call (bounded at 1 retry + permanent fail on 2nd crash).
      };
    } catch {
      _dead = true;
      return null;
    }
    return _worker;
  }

  function _post(type: 'ALERTS' | 'UTILIZATION', payload: Record<string, unknown>): Promise<any> {
    const w = _init();
    if (!w) return Promise.reject(new Error('worker unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++_seq;
      _pending.set(id, { resolve, reject });
      // Diagnostic-only measurement: setup stays scoped and has no activation gate.
      if (payload.setup) {
        const _setupCloneT0 = performance.now();
        structuredClone(payload.setup);
        PerfMonitor.record('Worker.setupClone:' + type, performance.now() - _setupCloneT0);
      }
      const _cloneT0 = performance.now();
      w.postMessage({ type, id, payload });
      PerfMonitor.record('Worker.postClone:' + type, performance.now() - _cloneT0);
    });
  }

  // Alerts/Utilization compute never read these (docs/scheduling_priority.md
  // R10) — dropped before the structured-clone postMessage, the documented
  // dominant main-thread cost of the Worker.* round trip. Excludes only the
  // three fields Stage 1 added; every other field ships exactly as before.
  function _stripPriorityFields(t: NimbusTask): NimbusTask {
    const { PRT_01, PRT_02, PRODUCTION_VERSION, ...rest } = t;
    return rest as NimbusTask;
  }

  function _snap(): WorkerSnapshotBase {
    const plant = Store.selectedPlant;
    if (!plant) {
      // Setup state must be resolved from the un-stripped source: stateForOrder
      // reads PRT_01/PRT_02/PRODUCTION_VERSION, and _stripPriorityFields deletes
      // exactly those before transport. Deriving from the stripped copy would
      // silently blank every state for any definition using those fields.
      const src = Store.tasksArr;
      const setup = deriveSetupObservation(Store.setupSnapshot, src, undefined, {
        calendars: Store._state.calendars, plants: Store._state.plants, lineSettings: Store._state.lineSettings,
        masterData: Store._state.masterData, blocks: Store._state.blocks, plantBlocks: Store._state.plantBlocks,
      });
      const tasks = src.map(_stripPriorityFields);
      // No plant selected — nothing is rendered; fall back to the global snapshot.
      return {
        tasks,
        blocks:       Store._state.blocks,
        plantBlocks:  Store._state.plantBlocks,
        calendars:    Store._state.calendars,
        plants:       Store._state.plants,
        lineSettings: Store._state.lineSettings,
        masterData:   Store._state.masterData,
        setup,
      };
    }
    // Plant-scoped snapshot. The structured-clone of this payload runs synchronously
    // on the main thread on every postMessage (the dominant main-thread cost of the
    // Worker.* round trip), so we send only the selected plant's data. calendars and
    // lineSettings MUST be scoped too: computeUtilization derives its line set from
    // Object.keys(calendars), and those maps accumulate entries for every line visited
    // this session — an unscoped map would make the worker compute (and clone back) a
    // matrix for lines that aren't even on screen.
    const lines = new Set(Store.linesForSelectedPlant());
    const pick = <T,>(obj: Record<string, T>): Record<string, T> => {
      const out: Record<string, T> = {};
      for (const l of lines) if (obj[l] !== undefined) out[l] = obj[l];
      return out;
    };
    // Same rule as the no-plant branch above: derive from the un-stripped
    // source array so stateForOrder can still read PRT_01/PRT_02/PRODUCTION_VERSION.
    const src = Store.tasksByPlant(plant);
    const setup = deriveSetupObservation(Store.setupSnapshot, src, lines, {
      calendars: pick(Store._state.calendars), plants: Store._state.plants[plant] ? { [plant]: Store._state.plants[plant] } : {},
      lineSettings: pick(Store._state.lineSettings), masterData: Store._state.masterData,
      blocks: Store._state.blocks.filter(b => (!b.plant || b.plant === plant) && (!b.line || lines.has(b.line))),
      plantBlocks: Store._state.plantBlocks.filter(b => !b.plant || b.plant === plant),
    });
    const tasks = src.map(_stripPriorityFields);
    return {
      tasks,
      blocks:       Store._state.blocks.filter(b => (!b.plant || b.plant === plant) && (!b.line || lines.has(b.line))),
      plantBlocks:  Store._state.plantBlocks.filter(b => !b.plant || b.plant === plant),
      calendars:    pick(Store._state.calendars),
      plants:       Store._state.plants[plant] ? { [plant]: Store._state.plants[plant] } : {},
      lineSettings: pick(Store._state.lineSettings),
      masterData:   Store._state.masterData,
      setup,
    };
  }

  return {
    available(): boolean { return !_dead && typeof Worker !== 'undefined'; },

    alerts(opts: { lines?: Set<string> } = {}, dismissed?: Set<string>): Promise<{ alerts: NimbusAlert[]; elapsed: number }> {
      const _t0 = performance.now();
      return _post('ALERTS', {
        ..._snap(),
        dismissed: [...(dismissed || [])],
        opts: { lines: opts?.lines instanceof Set ? [...opts.lines] : null },
      }).then(r => { PerfMonitor.record('Worker.alerts', performance.now() - _t0); return r; });
    },

    utilization(startMs: number, days: number): Promise<{ matrix: NimbusUtilizationMatrix }> {
      const _t0 = performance.now();
      return _post('UTILIZATION', { ..._snap(), startMs, days })
        .then(r => { PerfMonitor.record('Worker.utilization', performance.now() - _t0); return r; });
    },
  };
})();

/* =============================================================================
   ALERTS — computation only (detect and maintain the active alert list).
   Re-runs on any task/block/calendar change. Alerts are de-duplicated by id.
   The DOM half (drawer, bell badge, cell-briefing modal) stayed behind in
   app.js, renamed `AlertsUIAdapter` — see
   docs/architecture/cq1-compatibility-inventory.md.
   ========================================================================== */
// Adaptive debounced dispatcher constants — all callers funnel through
// scheduleRecompute/scheduleRecomputeLines below so rapid successive
// mutations (drag → autoReflow → explicit call) collapse into one recompute.
// The delay scales with the last recompute's measured cost (×1.5, clamped) so
// small/incremental updates stay snappy while a heavy full recompute on a
// large board doesn't thrash the main thread — replacing the old fixed 80 ms
// window that was too short at scale. Declared here (rather than after the
// object literal, as in the pre-TS version) purely so _armTimer's closure
// below can reference them — TDZ-safe either way since _armTimer only reads
// them when called, well after module evaluation completes.
const _ALERTS_MIN_DEBOUNCE_MS = 90;
const _ALERTS_MAX_DEBOUNCE_MS = 500;
export const Alerts = {
  recompute(opts: { lines?: Set<string> } = {}): void {
    // Never post the global (all-line) snapshot to the worker: when no plant is
    // selected nothing is rendered, so route to the cheap sync path instead of
    // structured-cloning every line's calendars/lineSettings/masterData across.
    if (Compute.available() && Store.selectedPlant) {
      const reqRev = Store.rev();
      Compute.alerts(opts, Alerts._dismissed)
        .then(({ alerts, elapsed }) => {
          if (Store.rev() !== reqRev) return; // stale result — a newer compute is in-flight
          const onlyLines = opts.lines instanceof Set && opts.lines.size ? opts.lines : null;
          if (onlyLines) {
            const retained = (Store.alerts || []).filter(a => !onlyLines.has(a.line));
            Store.setAlerts(retained.concat(alerts), 'alerts');
          } else {
            Store.setAlerts(alerts, 'alerts');
          }
          Alerts._lastMs = elapsed;
        })
        .catch((e) => {
          ErrorLog.warn('worker', 'compute fell back to main thread', { error: String(e?.message || e) });
          Alerts._recomputeSync(opts);
        });
      return;
    }
    Alerts._recomputeSync(opts);
  },

  _recomputeSync(opts: { lines?: Set<string> } = {}): void {
    // Synchronous fallback (worker unavailable / no plant selected). Delegates to
    // nimbus-compute-core — the SAME implementation the worker runs — so a worker-dead
    // session and a healthy one produce identical alerts (no "two brains" divergence).
    // Reads the same GLOBAL Store data the previous inline rule engine did (all tasks/
    // blocks/plant-blocks/calendars/…). The core writes calendar defaults into
    // Store.calendars/plants exactly as Store.ensure* did (same in-place side effect).
    const _t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const onlyLines = (opts.lines instanceof Set && opts.lines.size) ? opts.lines : null;
    const { alerts: kept } = globalThis.NimbusComputeCore!.computeAlerts({
      tasks:        Store.tasksArr,
      blocks:       Store.blocks,
      plantBlocks:  Store.plantBlocks,
      calendars:    Store.calendars,
      plants:       Store.plants,
      lineSettings: Store.lineSettings as any,
      masterData:   Store.masterData as unknown as NimbusMasterData,
      setup:        deriveSetupObservation(Store.setupSnapshot, Store.tasksArr, onlyLines || undefined, {
        calendars: Store.calendars, plants: Store.plants, lineSettings: Store.lineSettings,
        masterData: Store.masterData, blocks: Store.blocks, plantBlocks: Store.plantBlocks,
      }),
      dismissed:    [...Alerts._dismissed],
      opts:         { lines: onlyLines ? [...onlyLines] : null },
    });
    if (onlyLines) {
      // Incremental merge: retain alerts on untouched lines, replace only the affected
      // ones. Callers of the scoped path never move a task across lines.
      const retained = (Store.alerts || []).filter(a => !onlyLines.has(a.line));
      Store.setAlerts(retained.concat(kept), 'alerts');
    } else {
      Store.setAlerts(kept, 'alerts');
    }
    Alerts._lastMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - _t0;
    PerfMonitor.record('Alerts.syncFallback', Alerts._lastMs);
  },

  _dismissed: new Set<string>(),

  dismiss(alertId: string): void {
    Alerts._dismissed.add(alertId);
    Store.dismissAlert(alertId, 'alerts');
  },
  dismissAll(): void {
    for (const a of Store.alerts) Alerts._dismissed.add(a.id);
    Store.dismissAllAlerts('alerts');
  },
  // Clear dismissals (so new runs of recompute() can re-surface the same issue).
  // Returns whether any dismissal actually existed — callers that follow this
  // with a SCOPED recompute (scheduleAlertsForPatches) need this: a scoped
  // merge retains the untouched lines' previously-computed (dismissal-filtered)
  // alert lists as-is, so a dismissal on an untouched line would otherwise
  // never re-surface until some later full recompute happened to run.
  clearDismissed(): boolean {
    const had = Alerts._dismissed.size > 0;
    Alerts._dismissed.clear();
    return had;
  },

  applyFix(alertId: string): void {
    const a = Store.alerts.find(x => x.id === alertId);
    if (!a) return;

    if (a.type === 'overlap' || a.type === 'blackout') {
      const task = Store.tasks[a.taskId!];
      if (!task || !task.start_date) { Toast.show(Util.t('toast.cannot_fix_task'), 'error'); return; }
      const line = task.MACHINE || 'Unknown';
      const splitPolicy = Engine.splitOrderPolicyFor(Store.getPlantForLine(line) ?? Store.selectedPlant);
      const dur  = (Number(task.end_date) - Number(task.start_date)) || Util.runHours(task) * Config.MS_HOUR || Config.MS_HOUR;

      // For overlap: start searching from end of the overlapping peer
      let searchFrom = task.start_date;
      if (a.type === 'overlap') {
        const peerId = a.id.replace(/^ovl-/, '').split('-')[0];
        const peer = peerId ? Store.tasks[peerId] : null;
        if (peer && peer.end_date) searchFrom = peer.end_date;
        else searchFrom = task.start_date;
      }

      const snap = UndoStack.snapshotTasks([task.id]);
      let newStart: Date;
      let changes: Partial<NimbusTask>;
      if (splitPolicy === 'never') {
        newStart = Calendar.nextAvailable(line, searchFrom, dur);
        const newEnd = new Date(newStart.getTime() + dur);
        changes = { start_date: newStart, end_date: newEnd };
        if (task.scheduleSegments?.length && task.scheduleSegments.length >= 2) changes.scheduleSegments = [];
      } else {
        const plant = Store.getPlantForLine(line) ?? Store.selectedPlant;
        Calendar._beginRun(plant);
        try {
          changes = Engine.schedulePatchFor(task, line, searchFrom, splitPolicy) || {};
        } finally {
          Calendar._endRun();
        }
        if (!changes.start_date || !changes.end_date) {
          Toast.show(Util.t('toast.cannot_fix_task'), 'error');
          return;
        }
        newStart = changes.start_date;
      }
      Store.updateTask(task.id, changes, 'alerts');
      try { Engine.autoReflow(task.id); } catch {}
      UndoStack.push(`Auto-fix overlap "${task.text || task.id}"`, () => UndoStack.restoreTasks(snap));
      Alerts.dismiss(alertId);
      Toast.show(Util.t('toast.order_moved', { name: task.text || task.id, date: Util.fmtDT(newStart) }), 'success');

    } else if (a.type === 'overload') {
      // Scope the changeover optimizer to just this line+day so the optimize and the
      // undo snapshot cover the SAME tasks. (Passing no opts re-optimized the whole
      // plant over a 35-day horizon while the snapshot only captured one line+day,
      // so undo silently lost every cross-line / cross-day move.)
      const line = a.line, day = Util.dayKey(a.time || new Date());
      const dayStart = Util.startOfDay(a.time || new Date())!;
      const dayEnd   = new Date(dayStart.getTime() + 24 * Config.MS_HOUR);
      // Snapshot a SUPERSET of what the optimizer can move: every task on this line
      // that runAndApply would NOT treat as aged/out-of-window — i.e. its free-set
      // predicate (!isAged && !isOutOfWin), null-dated tasks included. Keying on
      // dayKey(start) missed cross-midnight orders and lost them on undo.
      const snap = UndoStack.snapshotTasks(Store.tasksArr.filter(t =>
        (t.MACHINE || 'Unknown') === line &&
        (!t.end_date   || t.end_date   >= dayStart) &&
        (!t.start_date || t.start_date <= dayEnd)
      ).map(t => t.id));
      Engine.runAndApply('changeover', { lines: [line], startDate: dayStart, endDate: dayEnd });
      UndoStack.push(`Auto-fix overload ${line} ${day}`, () => UndoStack.restoreTasks(snap));
      Alerts.dismiss(alertId);
    }
  },

  // -- Adaptive debounced dispatcher state/methods -----------------------
  // Declared as literal properties (rather than post-hoc `Alerts.x = ...`
  // assignments, as in the pre-TS version) so TypeScript's object-literal
  // type inference includes them on Alerts's own type — see schedule-state.mts's
  // identical treatment of Store._alertsByTaskSrc/_rev for the precedent.
  _lastMs: 0,
  _timer: null as ReturnType<typeof setTimeout> | null,
  _pendingFull: false,
  _pendingLines: new Set<string>(),
  _fire(): void {
    const full  = Alerts._pendingFull;
    const lines = Alerts._pendingLines;
    Alerts._pendingFull = false;
    Alerts._pendingLines = new Set();
    Alerts._timer = null;
    Alerts.recompute(full ? {} : { lines });
  },
  _armTimer(): void {
    const delay = Math.min(_ALERTS_MAX_DEBOUNCE_MS,
                           Math.max(_ALERTS_MIN_DEBOUNCE_MS, Math.round(Alerts._lastMs * 1.5)));
    if (Alerts._timer) clearTimeout(Alerts._timer);
    Alerts._timer = setTimeout(Alerts._fire, delay);
  },
  // Full recompute — the default for block / calendar / plant / line-membership changes.
  scheduleRecompute(): void {
    Alerts._pendingFull = true;
    Alerts._armTimer();
  },
  // Incremental recompute scoped to specific lines. Only safe for callers that never move a
  // task across lines (optimize / auto-reflow only shift dates within a line); anything that
  // could change line membership or global state must use scheduleRecompute() instead. If a
  // full recompute is also pending in the same window, the full one wins (always correct).
  scheduleRecomputeLines(lines: Set<string> | null | undefined): void {
    if (lines) for (const l of lines) Alerts._pendingLines.add(l);
    Alerts._armTimer();
  },
};

/** Phase 3 (Pkg E): shared post-apply alert-recompute scoping for optimizer
 *  patches (used by both Engine.runAndApply's setup-aware branch and
 *  OptimizerPreview.apply). The optimizer only ever shifts dates within a
 *  line — never moves a task across lines/machines — which is exactly the
 *  invariant scheduleRecomputeLines' doc comment above requires of its
 *  callers. Defensive fallback: if any patch's `changes` actually carries a
 *  MACHINE field (shouldn't happen today), or a patch id can't be resolved
 *  to a line at all, fall back to the full recompute rather than trust a
 *  possibly-incomplete scope.
 *
 *  Both call sites gate the call on `Alerts.clearDismissed()`'s return value
 *  BEFORE reaching this function: if any dismissal actually existed, they
 *  call `Alerts.scheduleRecompute()` directly and skip this scoped helper
 *  entirely — a scoped merge retains untouched lines' stale (dismissal-
 *  filtered) alert lists as-is, so a cleared dismissal on an untouched line
 *  would otherwise never re-surface until some later full recompute. */
export function scheduleAlertsForPatches(
  patches: ReadonlyArray<{ id: string; changes: Partial<NimbusTask> }>,
  resolveLine: (id: string) => string | undefined,
): void {
  // No patches to scope to (e.g. an apply that changed nothing) — fall back
  // to a full recompute rather than silently skip one.
  if (!patches.length) { Alerts.scheduleRecompute(); return; }
  const lines = new Set<string>();
  for (const p of patches) {
    if ('MACHINE' in p.changes) { Alerts.scheduleRecompute(); return; }
    const line = resolveLine(p.id);
    if (!line) { Alerts.scheduleRecompute(); return; }
    lines.add(line);
  }
  Alerts.scheduleRecomputeLines(lines);
}

// schedule-data.mjs's Persistence used to call `Alerts.scheduleRecompute()` directly
// after every hydration (load()'s two branches, _loadCache(), _loadDemo()) — a reverse
// dependency schedule-data.mjs must never take (it may not import schedule-services.mjs).
// Persistence now emits this Store event instead; subscribe here, the legitimate
// importer of both Store and Alerts, so the recompute still fires exactly the same way.
Store.subscribe(evt => {
  if (evt.type === 'schedule:hydrated') Alerts.scheduleRecompute();
}, 'schedule-services.hydrated');

/** Phase 2 (Pkg D) clone-base reuse: `Utilization.computeMatrix`'s preview
 * path (`utilizationSnapshot` non-null) structured-clones this six-pack on
 * EVERY call — 2-3 calls per optimizer preview (pre/post/alt KPIs), all
 * against the SAME `utilizationSnapshot` object reference. Cache the first
 * call's clones per snapshot so later calls in the same preview reuse them.
 * Confirmed safe (see the finding recorded in the Task 5 report):
 * NimbusComputeCore.computeUtilization's only in-place writes to these
 * inputs are ensureCalendar/ensurePlant filling a MISSING line/plant entry
 * with the same deterministic default, guarded by an existence check —
 * idempotent normalization, never a destructive overwrite of real data.
 * lineSettings/masterData/blocks/plantBlocks are never mutated by the core.
 * A WeakMap keyed by the snapshot object needs no manual eviction — entries
 * disappear once the preview releases its snapshot reference. The task list
 * itself is NOT cached here: it genuinely differs per call (pre/post/alt). */
interface UtilizationSnapshotClones {
  lineSettings: Record<string, NimbusLineSetting>;
  calendars: Record<string, { workHours: WorkHours }>;
  plants: Record<string, { workHours: WorkHours }>;
  blocks: NimbusBlock[];
  plantBlocks: NimbusPlantBlock[];
  masterData: NimbusMasterData | null;
}
const _utilizationSnapshotCloneCache = new WeakMap<Readonly<ScheduleSnapshot>, UtilizationSnapshotClones>();

/* =============================================================================
   UTILIZATION — scheduled vs. available hours per line per day.
   ========================================================================== */
export const Utilization = {
  _cache: null as { key: string; matrix: UtilizationMatrixResolved } | null,  // memoized result of the Store-backed compute path
  /** Returns { [line]: { [dayKey]: { scheduled, capacity, pct, tasks } } }.
   *  Pass `srcTasks` to scope the result to a filtered task subset.
   *  The srcTasks===null path is memoized on (startMs, days, Store.rev()); rev() bumps on
   *  every Store mutation, so a cache hit always reflects current data. Subset calls
   *  (srcTasks provided) skip the cache. Treat the returned matrix as read-only. */
  computeMatrix(
    startDate: Date,
    days: number = 7,
    srcTasks: NimbusTask[] | null = null,
    utilizationSnapshot: Readonly<ScheduleSnapshot> | null = null,
  ): UtilizationMatrixResolved {
    const start = Util.startOfDay(startDate)!;
    const cacheable = srcTasks === null && !utilizationSnapshot;
    // Scope the memo key by selected plant. The worker prewarm (_prewarm) writes a
    // PLANT-SCOPED matrix; this sync path is otherwise GLOBAL. Without a plant
    // discriminator (and a matching line set) the two collide under one key and a
    // consumer can receive the wrong plant's matrix. 'all' = no plant selected.
    const selectedPlant = utilizationSnapshot ? utilizationSnapshot.selectedPlant : Store.selectedPlant;
    const scope = selectedPlant || 'all';
    const revision = utilizationSnapshot ? 'detached' : Store.rev();
    const cacheKey = `${start.getTime()}|${days}|${revision}|${scope}`;
    if (cacheable && Utilization._cache && Utilization._cache.key === cacheKey) {
      return Utilization._cache.matrix;
    }
    const _pmT0u = performance.now();
    const taskList = srcTasks !== null ? srcTasks : (utilizationSnapshot?.tasks ?? Store.tasksArr);
    // NimbusComputeCore fills omitted calendar/plant entries with defaults. For
    // a preview, give it clones of the detached candidate context so that
    // convenience normalization cannot mutate Store (or the candidate itself).
    // Phase 2 (Pkg D): reuse those clones across repeat calls against the
    // SAME snapshot instead of re-cloning every time (see
    // _utilizationSnapshotCloneCache above for the safety finding).
    let lineSettings: Record<string, NimbusLineSetting>;
    let calendars: Record<string, { workHours: WorkHours }>;
    let plants: Record<string, { workHours: WorkHours }>;
    let blocks: NimbusBlock[];
    let plantBlocks: NimbusPlantBlock[];
    let masterData: NimbusMasterData | null;
    if (utilizationSnapshot) {
      let clones = _utilizationSnapshotCloneCache.get(utilizationSnapshot);
      if (!clones) {
        clones = {
          lineSettings: structuredClone(utilizationSnapshot.lineSettings),
          calendars:    structuredClone(utilizationSnapshot.calendars),
          plants:       structuredClone(utilizationSnapshot.plants),
          blocks:       structuredClone(Array.from(utilizationSnapshot.blocks)),
          plantBlocks:  structuredClone(Array.from(utilizationSnapshot.plantBlocks)),
          masterData:   structuredClone(utilizationSnapshot.masterData),
        };
        _utilizationSnapshotCloneCache.set(utilizationSnapshot, clones);
      }
      ({ lineSettings, calendars, plants, blocks, plantBlocks, masterData } = clones);
    } else {
      lineSettings = Store.lineSettings;
      calendars    = Store.calendars;
      plants       = Store.plants;
      blocks       = Store.blocks;
      plantBlocks  = Store.plantBlocks;
      masterData   = Store.masterData;
    }
    // The task list genuinely differs per call (pre/post/alt) — never cached.
    const coreTasks: NimbusTask[] = utilizationSnapshot
      ? structuredClone(Array.from(taskList))
      : taskList as NimbusTask[];

    // Reproduce the exact line set the inline builder used: task lines, plus (when this
    // is NOT a filtered subset) either the selected plant's lines or every visited
    // calendar line. Passed explicitly so the core pins the same set.
    const lineSet = new Set(taskList.map(t => t.MACHINE || 'Unknown'));
    if (srcTasks === null) {
      if (utilizationSnapshot && selectedPlant) {
        for (const [line, settings] of Object.entries(lineSettings)) {
          const mappedPlant = settings.plant
            ?? masterData?.lines.find(row => row.machine === line)?.plant;
          if (mappedPlant === selectedPlant) lineSet.add(line);
        }
      } else if (!utilizationSnapshot && Store.selectedPlant) Store.linesForSelectedPlant().forEach(l => lineSet.add(l));
      else Object.keys(calendars).forEach(l => lineSet.add(l));
    }
    // Detached candidate snapshots deliberately do not retain setup truth;
    // never reach back into Store while rendering one. Live paths resolve once
    // and hand the core only the resulting plant/line-scoped observations.
    const setup = utilizationSnapshot
      ? { intervals: [], diagnostics: [] }
      : deriveSetupObservation(Store.setupSnapshot, coreTasks, lineSet, {
        calendars, plants, lineSettings, masterData, blocks, plantBlocks,
      });

    // Delegate the matrix build to nimbus-compute-core — the single source of truth,
    // shared with the worker's UTILIZATION path. The core returns row.tasks as task IDs
    // (its worker contract); resolve them back to task OBJECTS here, which is what
    // computeMatrix's callers expect (they read task fields off the rows).
    const { matrix } = globalThis.NimbusComputeCore!.computeUtilization({
      tasks:        coreTasks,
      lineSettings: lineSettings as any,
      calendars,
      plants,
      blocks,
      plantBlocks,
      masterData:   masterData as unknown as NimbusMasterData,
      startMs:      start.getTime(),
      days,
      lines:        [...lineSet],
      setup,
    });
    const byId = new Map(taskList.map(t => [t.id, t]));
    for (const line of Object.keys(matrix)) {
      const rows = matrix[line];
      for (const k of Object.keys(rows)) {
        rows[k].tasks = rows[k].tasks.map(id => byId.get(id)).filter(Boolean) as unknown as string[];
      }
    }

    if (cacheable) Utilization._cache = { key: cacheKey, matrix: matrix as unknown as UtilizationMatrixResolved };
    PerfMonitor.record('Utilization.computeMatrix', performance.now() - _pmT0u);
    return matrix as unknown as UtilizationMatrixResolved;
  },

  /** Severity bucket from a utilisation ratio.
   *  overloadAt defaults to OVERLOAD_THRESHOLD but callers should pass
   *  effectiveCapacity/capacity so the buffer limit is respected. */
  sev(pct: number, overloadAt: number = Config.OVERLOAD_THRESHOLD): 'err' | 'warn' | 'ok' {
    if (pct > overloadAt)               return 'err';
    if (pct > Config.WARN_THRESHOLD)    return 'warn';
    return 'ok';
  },

  /** Today's utilisation summary keyed by line. */
  todayByLine(): Record<string, DayByLineRow> {
    return Utilization.dayByLine(new Date());
  },

  /** Utilisation summary for any given day, keyed by line.
   *  Pass `srcTasks` to scope the result to a filtered task subset. */
  dayByLine(date: Date, srcTasks: NimbusTask[] | null = null): Record<string, DayByLineRow> {
    const taskList = srcTasks !== null ? srcTasks : Store.tasksArr;
    const d = Util.startOfDay(date) || Util.startOfDay(new Date())!;
    const dEndMs = (() => { const x = new Date(d); x.setDate(x.getDate() + 1); return x.getTime(); })();
    const out: Record<string, DayByLineRow> = {};
    const lines = new Set(taskList.map(t => t.MACHINE || 'Unknown'));
    const dayKeyTarget = Util.dayKey(d);
    // Pre-parse blackout blocks once; reused for both capacity and the per-task clip below.
    const blockIdx = Calendar._indexCapacityBlocks();
    for (const line of lines) {
      const cap = Calendar.dailyCapacityHours(line, d, blockIdx);
      const effectiveCap = Calendar.effectiveFromCapacity(line, cap);
      const workWin = Calendar.workWindow(line, d);
      let sched = 0;
      if (workWin) {
        const plant = Store.getPlantForLine(line);
        const blackouts: Array<{ s: Date; e: Date }> = [];
        // line:null blocks (globalLine) apply only within their own plant; concrete
        // blocks under a reused line code are likewise resolved by plant.
        const _lb = blockIdx.lineBlocks.get(line); if (_lb) for (const x of _lb) if (!x.plant || x.plant === plant) blackouts.push(x);
        for (const x of blockIdx.globalLine) if (!x.plant || x.plant === plant) blackouts.push(x);
        const _pb = blockIdx.plantBlocks.get(plant!); if (_pb) for (const x of _pb) blackouts.push(x);
        for (const x of blockIdx.globalPlant) blackouts.push(x);
        for (const t of taskList) {
          if ((t.MACHINE || 'Unknown') !== line) continue;
          if (!t.start_date) continue;
          const intervals = Util.scheduleIntervals(t);
          if (intervals.length >= 2) {
            for (const interval of intervals) {
              const tStartMs = interval.start.getTime();
              const tEndMs = interval.end.getTime();
              if (tEndMs <= d.getTime() || tStartMs >= dEndMs) continue;
              const workingHrs = Util.mergedOverlapHours(workWin, [{ s: interval.start, e: interval.end }]);
              if (workingHrs <= 0) continue;
              const blackoutsClipped = blackouts
                .filter(b => b.s.getTime() < tEndMs && b.e.getTime() > tStartMs)
                .map(b => ({
                  s: new Date(Math.max(b.s.getTime(), tStartMs)),
                  e: new Date(Math.min(b.e.getTime(), tEndMs))
                }));
              sched += Math.max(0, workingHrs - Util.mergedOverlapHours(workWin, blackoutsClipped));
            }
            continue;
          }
          if (!t.end_date) {
            if (Util.dayKey(t.start_date) === dayKeyTarget) sched += Util.runHours(t);
            continue;
          }
          const tStartMs = t.start_date.getTime();
          const tEndMs   = t.end_date.getTime();
          if (tEndMs <= tStartMs) continue;
          if (tEndMs <= d.getTime() || tStartMs >= dEndMs) continue;
          const taskRunHrs = Util.runHours(t);
          if (taskRunHrs <= 0) continue;
          const workingHrs = Util.mergedOverlapHours(workWin, [{ s: t.start_date, e: t.end_date }]);
          if (workingHrs <= 0) continue;
          const blackoutsClipped = blackouts
            .filter(b => b.s.getTime() < tEndMs && b.e.getTime() > tStartMs)
            .map(b => ({
              s: new Date(Math.max(b.s.getTime(), tStartMs)),
              e: new Date(Math.min(b.e.getTime(), tEndMs))
            }));
          const blackoutOverlap = Util.mergedOverlapHours(workWin, blackoutsClipped);
          const dayHrs = Math.max(0, workingHrs - blackoutOverlap);
          // Cap at RUN_TIME so SAP-bloated end_dates don't over-attribute.
          sched += Math.min(dayHrs, taskRunHrs);
        }
      }
      out[line] = {
        capacity: cap, effectiveCapacity: effectiveCap, scheduled: sched,
        pct: cap > 0 ? sched / cap : (sched > 0 ? 1 : 0)
      };
    }
    return out;
  },

  // Pre-warm Utilization._cache in the worker so the next synchronous computeMatrix
  // call returns instantly from cache. Declared as a literal method (rather than a
  // post-hoc `Utilization._prewarm = ...` assignment, as in the pre-TS version) so
  // TypeScript's object-literal type inference includes it on Utilization's own type
  // — same treatment as Alerts's debounce methods above.
  _prewarm(): void {
    // Skip when no plant is selected — _snap would otherwise post the global all-line
    // snapshot to the worker for a matrix nothing on screen consumes.
    if (!Compute.available() || !Store.selectedPlant) return;
    const plant   = Store.selectedPlant; // scope key so a global / other-plant consumer never reads this entry
    const startMs = Util.startOfDay(new Date())!.getTime();
    const rev     = Store.rev();
    Compute.utilization(startMs, 7)
      .then(({ matrix }) => {
        if (Store.rev() !== rev) return; // stale — a newer mutation arrived
        for (const line of Object.keys(matrix)) {
          for (const k of Object.keys(matrix[line])) {
            const row = matrix[line][k];
            row.tasks = row.tasks.map(id => Store.tasks[id]).filter(Boolean) as unknown as string[];
          }
        }
        Utilization._cache = { key: `${startMs}|7|${rev}|${plant}`, matrix: matrix as unknown as UtilizationMatrixResolved };
      })
      .catch(() => {});
  },
};
// Debounced so a drag-storm / autoReflow burst (many task:update/bulkUpdate events in
// quick succession) collapses into ONE worker round-trip — i.e. one synchronous
// structured-clone of the snapshot — instead of one per mutation.
let _prewarmTimer: ReturnType<typeof setTimeout> | null = null;
Store.subscribe(evt => {
  if (evt.type !== 'tasks:bulk' && evt.type !== 'tasks:bulkUpdate' && evt.type !== 'task:update') return;
  if (_prewarmTimer) clearTimeout(_prewarmTimer);
  _prewarmTimer = setTimeout(() => { _prewarmTimer = null; Utilization._prewarm(); }, 200);
}, 'Utilization.prewarm');

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

  /** Evaluate the established legacy placement algorithm against a deep,
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
    mode: 'due-date-first' | 'spt' | 'min-changeover' | 'throughput',
    bounds: Readonly<DueDateFirstBounds>,
    snapshot: ScheduleSnapshot = snapshotSchedule(),
    thresholds?: Readonly<SetupPolicyThresholds>,
  ): CandidateResult {
    // Workstream D2: the real gate is plants.setup_active (bounds.setup.plant_active),
    // not the vestigial per-signature-version setup_definition.active.
    if (!bounds.setup.plant_active) {
      throw new Error('Setup-aware evaluation is disabled for this plant');
    }
    if (mode === 'due-date-first') return evaluateDueDateFirstPure(snapshot, bounds);
    if (mode === 'spt') return evaluateSptWithSetupPure(snapshot, bounds);
    if (mode === 'min-changeover') return evaluateMinChangeoverPure(snapshot, bounds);
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
  _syntheticZeroCostSetupSnapshot(plant: string): SetupSnapshot {
    const stored = Store.setupSnapshot;
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
   *  runAndApply's isAged/isOutOfWin (its horizonStart, itself already
   *  injectedNow-aware for candidate runs) and removeBacklog's plant-local
   *  wall-clock `now` (Engine._plantWallNow) both thread their own value
   *  through; autoReflow has no such concept and relies on the default.
   *
   *  Such an order is treated as implicitly pinned by every placement call
   *  site below — a reason DISTINCT from Store.isFixed (a genuine manual
   *  pin) so the UI can explain why it didn't move without conflating the
   *  two. This check alone never blocks anything — callers decide what
   *  "pinned" means in their own context (excluded from the free/movable
   *  set, an obstacle for peers, etc). Manual drags never consult this
   *  (OD-C2c): only optimizer/auto-reflow placement code does. */
  isFrozenHorizon(task: NimbusTask, now: Date = new Date()): boolean {
    const end = Engine.frozenHorizonEnd();
    if (!end || !task.start_date) return false;
    return task.start_date >= now && task.start_date < end;
  },

  /** Push `at` forward to the frozen-horizon boundary when it falls short —
   *  the one clamp every OPTIMIZER-side placement call site (autoReflow,
   *  the legacy walk via earliestAllowedStart below, setup-scheduler's
   *  bounds.notBefore) applies before committing a NEW start for a task
   *  that isn't itself frozen-pinned. Manual-path code
   *  (manualSchedulePatchFor, Alerts.applyFix) deliberately never calls
   *  this (OD-C2c). */
  applyFrozenFloor(at: Date): Date {
    const end = Engine.frozenHorizonEnd();
    return (end && at < end) ? new Date(end) : at;
  },

  /** Local due-date calendar-day floor for a plant's optional pull-forward
   *  limit, MAXED with the plant's C2 frozen-horizon floor (Engine.
   *  frozenHorizonEnd) so every one of this function's existing callers —
   *  the legacy walk's fitsAt/nextPullForwardFloor/queueBlockedByPullForward/
   *  forcePlaceableTask, _dispatchPolicyAware, the SPT cursor floor, and
   *  setup-scheduler's bounds.notBefore seam — gets the frozen floor for
   *  free, with no call site needing to know a second floor exists. This is
   *  the "single shared floor helper" the C2 placement-floor fix hangs on:
   *  the originally-proposed reuse of `bounds.notBefore` didn't generalize
   *  (it's per-order, due-date-derived, null without a due date), but THIS
   *  function is already consulted at every legacy-walk placement site, so
   *  folding the frozen floor in here — rather than a second, parallel
   *  check scattered across those same sites — is the actual fix. */
  earliestAllowedStart(task: NimbusTask, plant: string | null): Date | null {
    let floor: Date | null = null;
    const value = sourceMasterData()?.plants?.find(row => row.plant === plant)?.max_pull_forward_days;
    if (Number.isInteger(value) && (value as number) >= 0) {
      const due = Util.sapDueDate(task);
      if (due) {
        floor = new Date(due);
        floor.setHours(0, 0, 0, 0);
        floor.setDate(floor.getDate() - (value as number));
      }
    }
    const frozenEnd = Engine.frozenHorizonEnd();
    if (frozenEnd && (!floor || frozenEnd > floor)) floor = new Date(frozenEnd);
    return floor;
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
      return { start_date: start, end_date: new Date(start.getTime() + runtimeMinutes * Config.MS_MIN), scheduleSegments: [] };
    }
    const allocation = Calendar.allocateRuntime(line, requestedStart, runtimeMinutes, policy);
    return allocation.kind === 'allocated'
      ? { start_date: allocation.start, end_date: allocation.end, scheduleSegments: allocation.scheduleSegments }
      : null;
  },

  /** Apply a planner-requested parent start/line edit verbatim — no
   * calendar-aware recomputation ever happens on a manual edit, and this is
   * policy-independent by design (OD-B1a). A task with fewer than two
   * existing schedule segments commits directly at the requested start; a
   * task that already has two or more segments (placed there by a prior
   * optimizer run) has its existing shape translated by the requested delta
   * rather than destroyed or re-derived. */
  manualSchedulePatchFor(task: NimbusTask, line: string, requestedStart: Date): Partial<NimbusTask> | null {
    const runtimeMinutes = Math.round(Util.runHours(task) * 60);
    if (!Number.isFinite(runtimeMinutes) || runtimeMinutes <= 0) return null;
    const segments = task.scheduleSegments;
    if (!segments || segments.length < 2 || !task.start_date) {
      const start = Util.snap(requestedStart);
      return {
        start_date: start,
        end_date: new Date(start.getTime() + runtimeMinutes * Config.MS_MIN),
        MACHINE: line,
        scheduleSegments: [],
      };
    }
    const deltaMs = Util.snap(requestedStart).getTime() - task.start_date.getTime();
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
  },

  /** Repair schedules whose authoritative runtime changed after their last
   * valid aggregate was persisted. The existing parent start is the anchor;
   * failures intentionally leave the previous valid intervals and their
   * critical mismatch flag in place. Fixed is parent-level only and does not
   * suppress this required runtime correction. */
  reconcileRuntimeSchedules(plant: string | null): void {
    if (!plant) return;
    const policy = Engine.splitOrderPolicyFor(plant);
    const patches: Array<{ id: string; changes: Partial<NimbusTask> }> = [];
    Calendar._beginRun(plant);
    try {
      for (const task of Store.tasksByPlant(plant)) {
        if (!task.runtime_schedule_mismatch || !task.start_date) continue;
        const line = task.MACHINE || 'Unknown';
        const changes = Engine.schedulePatchFor(task, line, task.start_date, policy);
        if (!changes?.start_date || !changes.end_date) {
          ErrorLog.warn('engine',
            `Runtime changed for order "${task.text || task.id}", but its schedule could not be regenerated within the 90-day calendar search.`,
            { line, taskId: task.id, policy, reason: 'runtime-schedule-mismatch' });
          continue;
        }
        changes.runtime_schedule_mismatch = false;
        patches.push({ id: task.id, changes });
      }
    } finally {
      Calendar._endRun();
    }
    if (patches.length) Store.updateMany(patches, 'engine-runtime-reconcile');
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
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
        hourCycle: 'h23',
      }).formatToParts(runAt);
      const values: Record<string, number> = {};
      for (const part of parts) {
        if (part.type !== 'literal') values[part.type] = Number(part.value);
      }
      if (![values.year, values.month, values.day, values.hour, values.minute].every(Number.isFinite)) {
        throw new Error('could not resolve plant-local clock');
      }
      return new Date(values.year, values.month - 1, values.day, values.hour, values.minute, 0, 0);
    } catch (err) {
      throw new Error(`Remove Backlog requires a valid IANA timezone for the selected plant (${timezone}): ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  /** Planner-invoked, sequence-preserving backlog repair. This deliberately
   * has no priority, due-date, fixed-protection, or day-integrity branches --
   * EXCEPT the C2 (2026-08-20) frozen-horizon guard below, which is
   * unconditional (no 'backlog'-mode carve-out) and pins/floors exactly like
   * every other placement site; it does not restore any of the other
   * intentionally-absent protections (a genuinely Store.isFixed-pinned
   * order is still moved "when reached", unchanged from before). */
  removeBacklog(opts: Record<string, unknown> = {}): RemoveBacklogResult {
    const plant = (opts.plant as string | undefined) ?? sourceSelectedPlant();
    if (!plant) throw new Error('Remove Backlog requires a selected plant');
    const splitPolicy = Engine.splitOrderPolicyFor(plant);
    const row = sourceMasterData()?.plants?.find(p => p.plant === plant);
    const timezone = row?.timezone;
    if (typeof timezone !== 'string' || !timezone.trim()) {
      throw new Error(`Remove Backlog requires a configured IANA timezone for plant ${plant}`);
    }
    const runAtInput = opts.runAt;
    const runAtRaw = runAtInput instanceof Date
      ? runAtInput
      : (typeof runAtInput === 'string' || typeof runAtInput === 'number') ? new Date(runAtInput) : new Date();
    const runAt = Number.isFinite(runAtRaw.getTime()) ? runAtRaw : new Date();
    const now = Engine._plantWallNow(timezone, runAt);
    const from = opts.startDate ? new Date(opts.startDate as string | number | Date) : new Date(now);
    const to = opts.endDate ? new Date(opts.endDate as string | number | Date) : new Date(now.getTime() + 35 * Config.MS_DAY);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
      throw new Error('Remove Backlog requires valid From and To dates');
    }

    const diagnostics: RemoveBacklogDiagnostics = {
      backlogFound: 0, moved: 0, fixedMoved: 0, movedRuntimeHours: 0, largestDelayMinutes: 0,
      invalidRuntimeIds: [], missingStartIds: [], overlongIds: [], calendarSearchFailures: [], boundaryConflicts: [],
    };
    const lines = Array.isArray(opts.lines) && opts.lines.length
      ? new Set((opts.lines as unknown[]).map(String))
      : null;
    const grouped = new Map<string, Array<{ task: NimbusTask; snapshotStart: Date }>>();
    const scopedTasks = sourceTasksByPlant(plant).filter(t => !lines || lines.has(t.MACHINE || 'Unknown'));
    for (const task of scopedTasks) {
      if (!task.start_date) {
        diagnostics.missingStartIds.push(task.id);
        continue;
      }
      const snapshotStart = new Date(task.start_date);
      if (snapshotStart < from || snapshotStart > to) continue;
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
        let cursor = new Date(now);
        for (let index = firstBacklog; index < items.length; index++) {
          const item = items[index];
          if (item.snapshotStart >= now && cursor <= item.snapshotStart) break;
          const runtimeHours = Number(item.task.RUN_TIME);
          if (!Number.isFinite(runtimeHours) || runtimeHours <= 0) {
            diagnostics.invalidRuntimeIds.push(item.task.id);
            continue;
          }
          const runtimeMs = runtimeHours * Config.MS_HOUR;
          // C2 (2026-08-20): an order whose CURRENT start already falls
          // inside the plant's frozen window is left EXACTLY where it is --
          // the same obstacle treatment Engine.isFrozenHorizon gets at every
          // other placement site (runAndApply's fixedTasks/freeTasks split,
          // the setup-aware evaluator's fixedIds, autoReflow). This is a NEW,
          // unconditional guard with no 'backlog'-mode carve-out (the C2
          // spec's placement-floor requirement is unconditional) -- it does
          // NOT touch removeBacklog's separate, pre-existing, intentionally
          // out-of-scope behavior of moving a genuinely Store.isFixed-pinned
          // order "when reached" (tracked only via diagnostics.fixedMoved
          // below, never gated here). Passes this function's own plant-local
          // wall-clock `now` (Engine._plantWallNow) rather than the
          // real-time default, so removeBacklog's timezone-aware clock and
          // its frozen-window check always agree on the same instant.
          if (Engine.isFrozenHorizon(item.task, now)) {
            const obstacleEnd = item.task.end_date ?? new Date(item.snapshotStart.getTime() + runtimeMs);
            cursor = new Date(Math.max(cursor.getTime(), obstacleEnd.getTime()));
            continue;
          }
          const candidate = item.snapshotStart < now
            ? cursor
            : new Date(Math.max(item.snapshotStart.getTime(), cursor.getTime()));
          // C2: nothing removeBacklog places may START before the plant's
          // frozen-horizon boundary either -- the same floor already
          // threaded through Engine.earliestAllowedStart/autoReflow.
          const flooredCandidate = Engine.applyFrozenFloor(candidate);
          let start: Date;
          let end: Date;
          let scheduleSegments: OrderScheduleSegment[] | undefined;
          if (splitPolicy === 'never') {
            // Preserve the existing continuous-bar contract exactly for legacy
            // schedules. A split schedule that is explicitly regenerated under
            // this policy is cleared below as one atomic parent aggregate.
            const slot = Calendar.findContiguousSlot(line, flooredCandidate, runtimeMs);
            if (!('start' in slot)) {
              diagnostics.calendarSearchFailures.push({
                line, taskId: item.task.id,
                reason: slot.kind === 'unavailable' ? 'no-operating-interval' : 'search-exhausted',
              });
              break;
            }
            start = slot.start;
            end = new Date(start.getTime() + runtimeMs);
            if (slot.kind === 'overlong') diagnostics.overlongIds.push(item.task.id);
            if (item.task.scheduleSegments?.length && item.task.scheduleSegments.length >= 2) scheduleSegments = [];
          } else {
            const allocation = Calendar.allocateRuntime(line, flooredCandidate, Math.round(runtimeHours * 60), splitPolicy);
            if (allocation.kind !== 'allocated') {
              diagnostics.calendarSearchFailures.push({
                line, taskId: item.task.id,
                reason: allocation.kind === 'unavailable' ? 'no-operating-interval' : 'search-exhausted',
              });
              break;
            }
            start = allocation.start;
            end = allocation.end;
            // Always include the full child aggregate, including [], so a
            // regenerated continuous parent removes obsolete child rows.
            scheduleSegments = allocation.scheduleSegments;
          }
          cursor = end;
          const currentStart = item.snapshotStart.getTime();
          const currentEnd = item.task.end_date?.getTime() ?? NaN;
          const segmentsChanged = scheduleSegments !== undefined
            && !Engine._sameScheduleSegments(item.task.scheduleSegments, scheduleSegments);
          if (currentStart === start.getTime() && currentEnd === end.getTime() && !segmentsChanged) continue;
          const changes: Partial<NimbusTask> = { start_date: start, end_date: end };
          if (scheduleSegments !== undefined) changes.scheduleSegments = scheduleSegments;
          patches.push({ id: item.task.id, changes });
          diagnostics.moved++;
          if (sourceIsFixed(item.task.id)) diagnostics.fixedMoved++;
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
      const movedStart = patch.changes.start_date!;
      const movedEnd = patch.changes.end_date!;
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
   *  (PriorityFieldMeta, web/types.mts) carries no description field — that's
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

  /** Allocate a sequence already selected by an optimizer strategy. The
   * selection/order remains the strategy's responsibility; this pass only
   * turns each selected logical parent into its calendar-valid aggregate.
   * Fixed parents are treated as atomic envelope obstacles so no free order is
   * interleaved between the productive pieces of another logical order. */
  _dispatchPolicyAware(
    line: string,
    orderedTasks: NimbusTask[],
    fixedTasks: NimbusTask[],
    cursorInit: Date,
    policy: Exclude<SplitOrderPolicy, 'never'>,
    plant: string | null,
  ): Array<{ id: string; changes: Partial<NimbusTask> }> {
    const patches: Array<{ id: string; changes: Partial<NimbusTask> }> = [];
    let cursor = new Date(cursorInit);

    for (const task of orderedTasks) {
      const runtimeMinutes = Math.round(Util.runHours(task) * 60);
      if (!Number.isFinite(runtimeMinutes) || runtimeMinutes <= 0) continue;

      let requested = new Date(cursor);
      const floor = Engine.earliestAllowedStart(task, plant);
      if (floor && requested < floor) requested = new Date(floor);
      let scheduled: Partial<NimbusTask> | null = null;
      for (let guard = 0; guard < 200; guard++) {
        const candidate = Engine.schedulePatchFor(task, line, requested, policy);
        if (!candidate?.start_date || !candidate.end_date) break;
        const blocker = fixedTasks.find(f => f.start_date && f.end_date
          && candidate.start_date! < f.end_date && candidate.end_date! > f.start_date);
        if (!blocker?.end_date) {
          scheduled = candidate;
          break;
        }
        requested = new Date(blocker.end_date);
      }

      if (!scheduled?.start_date || !scheduled.end_date) {
        reportSchedulerDiagnostic(
          'warn', 'engine', 'engine.allocation-exhausted',
          `Could not allocate order "${task.text || task.id}" on "${line}" within the 90-day calendar search; subsequent orders were left unchanged.`,
          { line, taskId: task.id, policy },
        );
        // Do not schedule later parents around one that could not be allocated:
        // doing so would silently break the strategy-selected sequence.
        break;
      }
      patches.push({ id: task.id, changes: scheduled });
      cursor = new Date(scheduled.end_date);
    }
    return patches;
  },

  /** Main optimiser. Groups by line, optionally respects fixed + calendar.
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
    let _pmCalMs = 0; // accumulates Calendar.nextAvailable time for the Engine.calendar breakout
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
    // maps, fixed protection, or the day-integrity resequencer.
    if (mode === 'backlog') {
      const result = Engine.removeBacklog({ ...opts, plant });
      if (candidateRun) return detachedCandidateResult(result.patches, _pmT0e, 'completed', result);
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
    const respectFixed    = (opts.respectFixed as boolean | undefined)    ?? true;
    const respectCalendar = (opts.respectCalendar as boolean | undefined) ?? true;
    // An explicit "ignore calendar" run remains continuous: there is no
    // effective availability map from which to derive productive pieces. The
    // plant setting takes effect on normal calendar-respecting scheduling.
    const splitPolicy: SplitOrderPolicy = respectCalendar ? Engine.splitOrderPolicyFor(plant) : 'never';
    const sortTerms = Engine._sortTerms(mode, { plant });

    const injectedNow = candidateRun && opts.now instanceof Date ? opts.now : null;
    const horizonStart = opts.startDate
      ? new Date(opts.startDate as string | number | Date)
      : (() => { const d = injectedNow ? new Date(injectedNow) : new Date(); d.setSeconds(0, 0); return d; })();
    const horizonEnd   = opts.endDate   ? new Date(opts.endDate as string | number | Date) : new Date(horizonStart.getTime() + 35 * 24 * Config.MS_HOUR);
    const isAged       = (t: NimbusTask) => t.end_date   && t.end_date   < horizonStart;
    const isOutOfWin   = (t: NimbusTask) => t.start_date && t.start_date > horizonEnd;

    // "Include Setup Times in Optimizer" (plants.setup_active, surfaced as
    // SetupSnapshot.plant_active — Workstream D2 relocated this off the
    // vestigial per-signature-version setup_definition.active) routes
    // spt/changeover through the setup-aware evaluators
    // (setup-scheduler.mjs) instead of the legacy per-line walk below. Mirrors
    // the same live gate Engine.autoReflow already reads for incremental
    // reflow. Search-safety limits are hardcoded (see SETUP_AWARE_* above) —
    // the perf-measurement gate this was meant to come from was never run.
    //
    // B3a (2026-08-21): 'changeover' no longer falls through to the legacy
    // per-line walk at all, active-and-matching setup snapshot or not — that
    // walk (and its Engine._dispatchDayIntegrity tiering) is retired. When
    // there's no genuine active-and-matching snapshot, a fabricated
    // zero-cost one (Engine._syntheticZeroCostSetupSnapshot) stands in so the
    // SAME evaluator ('min-changeover') always decides changeover's
    // sequencing — the two dispatchers can no longer disagree about it.
    // 'spt' is untouched: it still only takes this branch when genuinely
    // active-and-matching, exactly as before B3a.
    const setupSnapshot = Store.setupSnapshot;
    const setupSnapshotActiveAndMatching = !!(setupSnapshot && setupSnapshot.plant === plant && setupSnapshot.plant_active);
    const effectiveSetupSnapshot: SetupSnapshot | null = mode === 'changeover' && !setupSnapshotActiveAndMatching
      ? Engine._syntheticZeroCostSetupSnapshot(plant)
      : setupSnapshot;
    if (mode === 'changeover' || setupSnapshotActiveAndMatching) {
      const evaluatorMode = mode === 'spt' ? 'spt' : 'min-changeover';
      // Phase 2 (Pkg D): scope the fallback snapshot's calendars to this run's
      // plant — every consumer of ScheduleSnapshot.calendars in this path
      // (freeIntervalsFor/jointWindowForDay/hasNominalWindow in
      // setup-scheduler.mts, sourceLineWorkHours above) only ever looks up a
      // line that survived this same plant's task filter, so no other
      // plant's lines are ever needed here.
      const baseSnapshot = _candidateSnapshot ?? snapshotSchedule(plant);
      // C2: fold any frozen-window order into the SAME fixedIds set the
      // setup-aware evaluators already treat as immovable — Engine.
      // isFrozenHorizon carries its own distinct reason for the UI (never
      // written to Store.isFixed itself), this is purely an internal input
      // to the evaluator so it never re-sequences an order it shouldn't touch.
      // Passes horizonStart (this run's own "now", injectedNow-aware for
      // candidate runs) rather than the real-time default, so a detached
      // preview evaluated at a simulated instant agrees with itself.
      const frozenIds = baseSnapshot.tasks.filter(t => Engine.isFrozenHorizon(t, horizonStart)).map(t => String(t.id));
      const snapshot: ScheduleSnapshot = frozenIds.length
        ? { ...baseSnapshot, fixedIds: new Set([...Array.from(baseSnapshot.fixedIds, String), ...frozenIds]) }
        : baseSnapshot;
      const bounds: DueDateFirstBounds = {
        // Non-null by construction: this branch is only reached when either
        // mode === 'changeover' (effectiveSetupSnapshot is always the real
        // active-and-matching snapshot or the synthetic fallback) or the real
        // snapshot is genuinely active-and-matching ('spt').
        setup: effectiveSetupSnapshot!,
        exactSearchThreshold: SETUP_AWARE_EXACT_SEARCH_THRESHOLD,
        iterationCap: SETUP_AWARE_ITERATION_CAP,
        clock: () => performance.now(),
        // Phase 2 (Pkg D): an absolute deadline the caller already computed
        // (e.g. the preview's one-shot primary budget, or the deferred Plan B
        // comparison's smaller budget) takes precedence over a fresh
        // SETUP_AWARE_DEADLINE_MS window here. A past `opts.deadlineAt` is
        // not special-cased: the search just terminates immediately with
        // tail placement, which is the existing, safe deadline-exceeded path.
        deadline: (opts.deadlineAt as number | undefined) ?? performance.now() + SETUP_AWARE_DEADLINE_MS,
        now: horizonStart,
        horizonEnd,
        notBefore: (task: NimbusTask) => Engine.earliestAllowedStart(task, plant),
        convergenceWindow: SETUP_AWARE_CONVERGENCE_WINDOW,
      };
      let result = Engine.evaluateSetupAware(evaluatorMode, bounds, snapshot);
      // The setup-aware evaluators group every line for the plant with no
      // opts.lines/excludeFromOpt filter of their own (unlike the legacy walk
      // below) — apply both as a post-filter over the returned patches so a
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
      else scheduleAlertsForPatches(result.patches, id => byId.get(String(id))?.MACHINE || 'Unknown');
      // Surface the never-freeze fallbacks that actually landed in this apply:
      // orders scheduled without a resolvable setup transition (no changeover
      // bar) and, separately, any line still guarded off entirely (only
      // fixed/override protection can do that now — see Part 1f). Both are
      // derived from the applied patches, never the whole-run diagnostics, so
      // a line-scoped/excludeFromOpt run only reports what it actually
      // touched.
      const patchedIds = new Set(result.patches.map(patch => String(patch.id)));
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
      if (unknownSetupOrderIds.size && !effectiveSetupSnapshot!.synthetic) {
        Toast.show(Util.t('toast.optimize_missing_setup_summary', {
          orders: unknownSetupOrderIds.size,
          lines: unknownSetupLines.size,
        }), 'warn');
      }
      // B3: derive the unplaced set by difference, in this one place, rather
      // than threading an unplacedOrderIds field through CandidateResult —
      // the worst drops (plant/line mismatch, this same opts.lines/
      // excludeFromOpt post-filter, a fixed order the setup-aware path never
      // touches) produce no diagnostic object at all, so there is nothing for
      // a threaded field to collect. An order that places successfully
      // always yields a patch — even when its dates are unchanged — so
      // "in scope, not fixed, not patched" is exactly "not scheduled".
      // Scoping uses the SAME plant resolution as B7 (`t.PLANT ||
      // sourceGetPlantForLine(t.MACHINE)`) so this reporting and the
      // setup-aware evaluators' own scoping agree on which orders exist for
      // this plant.
      const unplacedLines = new Set<string>();
      let unplacedCount = 0;
      for (const task of snapshot.tasks) {
        const id = String(task.id);
        if (patchedIds.has(id)) continue;
        if (sourceIsFixed(task.id)) continue;
        const taskPlant = task.PLANT || sourceGetPlantForLine(task.MACHINE);
        if (taskPlant !== plant) continue;
        const line = task.MACHINE || 'Unknown';
        if (allowedLines && !allowedLines.has(line)) continue;
        if (sourceLineSettings()[line]?.excludeFromOpt) continue;
        unplacedCount += 1;
        unplacedLines.add(line);
      }
      if (unplacedCount) {
        Toast.show(Util.t('toast.optimize_orders_left_in_place', {
          orders: unplacedCount,
          lines: unplacedLines.size,
        }), 'warn');
      }
      if (result.unchangedLines.length) {
        Toast.show(Util.t('toast.optimize_lines_guarded', { count: result.unchangedLines.length }), 'warn');
      }
      PerfMonitor.record('Engine.runAndApply', performance.now() - _pmT0e);
      return;
    }

    // Optional caller-supplied line filter — when present, only these lines are optimized.
    const optsLines = opts.lines as string[] | undefined;
    const allowed = Array.isArray(optsLines) && optsLines.length
      ? new Set<string>(optsLines)
      : null;

    // Group tasks by line using the pre-built plant index (avoids a full tasksArr scan).
    // Skip non-allowed lines at insertion when a line filter is supplied so we don't
    // pay for grouping work that will just be discarded.
    const groups: Record<string, { line: string; tasks: NimbusTask[] }> = {};
    for (const t of sourceTasksByPlant(plant)) {
      const line = t.MACHINE || 'Unknown';
      if (allowed && !allowed.has(line)) continue;
      (groups[line] ||= { line, tasks: [] }).tasks.push(t);
    }

    const patches: Array<{ id: string; changes: Partial<NimbusTask> }> = [];

    // Install per-run Calendar caches (workWindow memo + pre-indexed blocks) for the
    // duration of the scheduling pass. Torn down in finally{} so an exception
    // mid-loop can't leak the cache into UI/Alerts callers.
    Calendar._beginRun(plant);
    try {

    for (const line of Object.keys(groups)) {
      if ((sourceLineSettings()[line] || {}).excludeFromOpt) continue;
      const { tasks } = groups[line];

      // C2: an order whose start already falls inside the plant's frozen
      // window is routed into the SAME obstacle bucket as a genuine manual
      // pin / aged / out-of-window task — unconditionally (not gated by
      // respectFixed, same as isAged/isOutOfWin) — so every dispatcher fed
      // by this split (_dispatchPolicyAware, the SPT walk below) leaves it
      // untouched. Engine.isFrozenHorizon carries its
      // own distinct reason for the UI; this split itself doesn't care why
      // a task is immovable, only that it is. Passes horizonStart as this
      // check's "now" — the SAME reference isAged/isOutOfWin already use —
      // so all three agree on one clock for this run instead of splitting.
      const fixedTasks = tasks.filter(t =>
        (respectFixed && sourceIsFixed(t.id)) || isAged(t) || isOutOfWin(t) || Engine.isFrozenHorizon(t, horizonStart)
      );
      let freeTasks = tasks.filter(t =>
        !(respectFixed && sourceIsFixed(t.id)) && !isAged(t) && !isOutOfWin(t) && !Engine.isFrozenHorizon(t, horizonStart)
      );

      fixedTasks.sort((a,b) => (a.start_date?.getTime()||0) - (b.start_date?.getTime()||0));

      // Cursor floor is max(horizonStart, now): extending "From" backwards
      // widens eligibility (older orders become free to move) but never
      // schedules anything in the literal past.
      const now = injectedNow ? new Date(injectedNow) : new Date();
      now.setSeconds(0, 0);
      const cursorFloor = horizonStart.getTime() > now.getTime() ? horizonStart : now;

      let cursor: Date;
      if (respectCalendar) {
        const win = Calendar.workWindow(line, cursorFloor);
        cursor = (win && win[0].getTime() > cursorFloor.getTime())
          ? new Date(win[0])
          : new Date(cursorFloor);
      } else {
        cursor = new Date(cursorFloor);
      }

      // B3a: 'changeover' always exits via the setup-aware branch above —
      // it can never reach the splitPolicy fork or the plain walk below.
      // Only 'spt' reaches either of them now (Engine._dispatchPolicyAware
      // remains 'spt''s split-policy-aware placement mechanism).
      if (splitPolicy !== 'never') {
        const decorated = freeTasks.map(t => ({ t, k: sortTerms.map(tm => tm.get(t)) }));
        decorated.sort((a, b) => {
          for (let i = 0; i < sortTerms.length; i++) {
            const c = sortTerms[i].cmp(a.k[i], b.k[i]);
            if (c) return c;
          }
          return 0;
        });
        const selectedOrder = decorated.map(d => d.t);
        patches.push(...Engine._dispatchPolicyAware(line, selectedOrder, fixedTasks, cursor, splitPolicy, plant));
        continue;
      }

      // Schwartzian transform: decorate each task once with its ordered sort
      // keys (from Engine._sortTerms — the single source of truth, so this can
      // no longer drift from _comparator), then sort by comparing keys
      // positionally.
      const decorated = freeTasks.map(t => ({ t, k: sortTerms.map(tm => tm.get(t)) }));
      decorated.sort((a, b) => {
        for (let i = 0; i < sortTerms.length; i++) {
          const c = sortTerms[i].cmp(a.k[i], b.k[i]);
          if (c) return c;
        }
        return 0;
      });
      freeTasks = decorated.map(d => d.t);

      // Walk through free tasks, jumping past each fixed task we encounter.
      let fixIdx = 0;
      for (const t of freeTasks) {
        const durMs = Util.runHours(t) * Config.MS_HOUR;
        if (durMs <= 0) continue;
        const floor = Engine.earliestAllowedStart(t, plant);
        if (floor && cursor < floor) cursor = new Date(floor);

        // Alternate between fixed-task collision check and calendar adjustment
        // until cursor is stable. This handles the case where a calendar gap
        // (blackout, closed hours) pushes cursor into a fixed task's window.
        let guard = 0;
        for (; guard < 200; guard++) {
          const prevMs = cursor.getTime();

          // Step 1: jump past any fixed task that cursor + duration would overlap.
          while (fixIdx < fixedTasks.length) {
            const f = fixedTasks[fixIdx];
            if (!f.start_date || !f.end_date) { fixIdx++; continue; }
            if (cursor >= f.end_date) { fixIdx++; continue; }
            if (cursor.getTime() + durMs <= f.start_date.getTime()) break;
            cursor = new Date(f.end_date);
            fixIdx++;
          }

          // Step 2: advance past any closed/blackout region.
          if (respectCalendar) {
            const _calT0 = performance.now();
            cursor = Calendar.nextAvailable(line, cursor, durMs);
            _pmCalMs += performance.now() - _calT0;
          }

          // If cursor didn't move, both constraints are satisfied — done.
          if (cursor.getTime() === prevMs) break;
        }
        // Guard exhausted without converging: the fixed-task + calendar constraints never
        // settled on a stable slot. Placement still proceeds at `cursor`, but surface it
        // so the condition isn't silently swallowed (previously a hard-to-diagnose "why
        // didn't this order move?" at scale).
        if (guard >= 200) {
          reportSchedulerDiagnostic(
            'warn', 'engine', 'engine.placement-guard',
            `Placement guard hit 200 iterations on "${line}" for order "${t.text || t.id}" — ` +
            `schedule may be suboptimal; check fixed orders / blackouts on this line.`,
            { line, taskId: t.id },
          );
        }

        const start = new Date(Math.round(cursor.getTime() / Config.MS_MIN) * Config.MS_MIN);
        const end   = new Date(start.getTime() + durMs);
        patches.push({ id: t.id, changes: { start_date: start, end_date: end } });
        cursor = new Date(end);
      }
    }

    } finally {
      Calendar._endRun();
    }

    if (candidateRun) return detachedCandidateResult(patches, _pmT0e);

    applySchedulePatches(patches);
    Store.setLastOptimize(new Date(), 'engine');
    Alerts.clearDismissed();
    // Route through the adaptive debounce instead of a direct synchronous recompute:
    // keeps the heavy alert pass off the tail of the placement loop and lets it
    // coalesce with the updateMany cascade rather than firing a second worker clone
    // in the same tick.
    Alerts.scheduleRecompute();
    PerfMonitor.record('Engine.calendar', _pmCalMs);
    PerfMonitor.record('Engine.runAndApply', performance.now() - _pmT0e);
  },

  /** After a manual edit to one task, re-flow subsequent unfixed orders on the
   *  same line to eliminate overlap. Spans day boundaries so Day-1 overflow
   *  cascades correctly into Day-2 tasks. Does NOT move fixed orders. */
  autoReflow(changedId: string): void {
    const changed = Store.tasks[changedId];
    if (!changed || !changed.start_date || !changed.end_date) return;
    const _horizonStart = Util.startOfDay(new Date())!;
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
          if (Store.isFixed(p.id) || Engine.isFrozenHorizon(p) || p.end_date! < _horizonStart) {
            // Fixed, frozen-window, or aged orders don't move — if there's a
            // conflict, an alert will fire — but later unfixed peers must
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
      Alerts.scheduleRecomputeLines(new Set([line]));
      return;
    }
    for (const p of peers) {
      // Peer ends before the changed task starts — entirely prior, cannot overlap; skip.
      if (p.end_date! <= changed.start_date) continue;
      const requiredSetupMinutes = setupMinutes(predecessor, p);
      const requiredStart = new Date(cursor.getTime() + requiredSetupMinutes * Config.MS_MIN);
      if (p.start_date! >= requiredStart) { cursor = new Date(p.end_date!); predecessor = p; continue; }
      if (Store.isFixed(p.id) || Engine.isFrozenHorizon(p) || p.end_date! < _horizonStart) {
        // Fixed, frozen-window, or aged orders don't move — if there's a
        // conflict, an alert will fire — but later unfixed peers must still
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
    // Reflow only ever shifts dates within `line`, so scope the alert recompute to it.
    Alerts.scheduleRecomputeLines(new Set([line]));
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
      const plant = task ? Store.getPlantForLine(task.MACHINE) : null;
      if (plant) plants.add(plant);
    }
    for (const plant of plants) Engine.reconcileRuntimeSchedules(plant);
  }
}, 'schedule-services.runtime-reconcile');
