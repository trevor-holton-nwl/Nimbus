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
import { Config, Util, ErrorLog, PerfMonitor, Toast } from '../platform/foundation.mjs';
import { Store, UndoStack } from '../platform/store.mjs';
import { Calendar, candidateDefaultWorkHours } from '../calendar/calendar-engine.mjs';
import { Alerts, scheduleAlertsForPatches } from '../insights/services.mjs';
import {
  placeWithSetup as placeWithSetupPure,
  evaluateDueDateFirst as evaluateDueDateFirstPure,
  evaluateMinChangeover as evaluateMinChangeoverPure,
  evaluateSptWithSetup as evaluateSptWithSetupPure,
  evaluateThroughput as evaluateThroughputPure,
  fillPlanningGaps,
  SETUP_AWARE_CONVERGENCE_WINDOW,
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
import { MIN_PRODUCTIVE_SEGMENT_MINUTES, capAwareSequence } from './scheduler-contract.mjs';
import type { RemoveBacklogResult, RemoveBacklogDiagnostics } from './scheduler-contract.mjs';

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
 * member stays whole (tasks/firmedIds/alerts/blocks/plantBlocks/plants/
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
      firmedIds: Array.from(Store.firmedIds), // manual firms only — ECC/frozen derivation joins at the setup-aware fold; do not union here.
      alerts: structuredClone(Store.alerts),
      selectedPlant: Store.selectedPlant,
      blocks: structuredClone(Store.blocks),
      plantBlocks: structuredClone(Store.plantBlocks),
      calendars: structuredClone(sourceCalendars),
      plants: structuredClone(Store.plants),
      lineSettings: structuredClone(Store.lineSettings),
      masterData: structuredClone(Store.masterData),
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
 * caller's own firmed set (manual `Store.isFirmed` ids), folded with every
 * ECC-firmed and frozen-horizon task. `respectFirmed` gates BOTH the manual
 * ids and the ECC fold — matching the legacy per-line walk's
 * `(respectFirmed && (sourceIsFirmed(t.id) || !!t.ecc_firmed))` gate exactly
 * — while `Engine.isFrozenHorizon` always folds in regardless, since the
 * frozen horizon is a scheduling-window constraint, not a firming concept.
 * Pure and run-local: never written back to Store. */
export function effectiveFirmedIdSet(
  tasks: ReadonlyArray<NimbusTask>,
  baseFirmedIds: ReadonlySet<string> | ReadonlyArray<string>,
  horizonStart: Date,
  respectFirmed: boolean,
): Set<string> {
  const ids = new Set<string>(respectFirmed ? Array.from(baseFirmedIds, String) : []);
  for (const t of tasks) {
    if ((respectFirmed && t.ecc_firmed) || Engine.isFrozenHorizon(t, horizonStart)) ids.add(String(t.id));
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

export function sourceGetPlantForLine(line: string): string | null {
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
    // setup-scheduler.mts) — a detached legacy result has no coverage concept
    // of its own, so it contributes 0.
    // score[7] = SCORE_OVER_CAP (setup-scheduler), never populated on the legacy path
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
   *  site below — a reason DISTINCT from Store.isFirmed (a genuine manual
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

  /** Union firming status. UI/live-path ONLY — reads live Store (isFirmed, frozenHorizonEnd).
   *  Detached optimizer runs must use the snapshot fold in the fixed/free split + setup-aware
   *  fold below, never this. reasons: 'ecc' (SAP), 'frozen' (horizon band), 'manual' (planner). */
  firmingStatus(task: NimbusTask, now: Date = new Date()): { firmed: boolean; reasons: Array<'ecc'|'frozen'|'manual'> } {
    const reasons: Array<'ecc'|'frozen'|'manual'> = [];
    if (task.ecc_firmed) reasons.push('ecc');
    if (Engine.isFrozenHorizon(task, now)) reasons.push('frozen');
    if (Store.isFirmed(task.id)) reasons.push('manual');
    return { firmed: reasons.length > 0, reasons };
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
   *  the legacy walk's cursor floor, _dispatchPolicyAware, and setup-scheduler's
   *  bounds.notBefore seam — gets the frozen floor for free, with no call site
   *  needing to know a second floor exists. This is the "single shared floor
   *  helper" the C2 placement-floor fix hangs on: the originally-proposed reuse
   *  of `bounds.notBefore` didn't generalize (it's per-order, due-date-derived,
   *  null without a due date), but THIS function is already consulted at every
   *  legacy-walk placement site, so folding the frozen floor in here — rather
   *  than a second, parallel check scattered across those same sites — is the
   *  actual fix. */
  earliestAllowedStart(task: NimbusTask, plant: string | null): Date | null {
    let floor: Date | null = null;
    const value = sourceMasterData()?.plants?.find(row => row.plant === plant)?.max_pull_forward_days;
    if (Number.isInteger(value) && (value as number) >= 0) {
      const rawDue = task.original_end_date ?? task.ORIGINAL_END_DATE;
      const parsedDue = rawDue ? new Date(rawDue as string | number | Date) : null;
      const due = parsedDue && Number.isFinite(+parsedDue) ? parsedDue : null;
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

  /** Local due-date calendar-day CEILING for a plant's optional push-forward
   *  (max lateness) limit — the mirror image of earliestAllowedStart. An order
   *  may not FINISH after (due-date local midnight) + (N + 1) days, so N = 0
   *  means "by end of its due day". Null when the plant has no limit or the
   *  order has no SAP due date (Util.sapDueDate). Optimizer-only, like the
   *  pull-forward floor: manual moves, Alerts fixes, autoReflow and Remove
   *  Backlog never consult it. Unlike earliestAllowedStart this is NOT maxed
   *  with the frozen horizon — the two floors/ceilings are independent. */
  latestAllowedEnd(task: NimbusTask, plant: string | null): Date | null {
    const value = sourceMasterData()?.plants?.find(row => row.plant === plant)?.max_push_forward_days;
    if (!Number.isInteger(value) || (value as number) < 0) return null;
    const rawDue = task.original_end_date ?? task.ORIGINAL_END_DATE;
      const parsedDue = rawDue ? new Date(rawDue as string | number | Date) : null;
      const due = parsedDue && Number.isFinite(+parsedDue) ? parsedDue : null;
    if (!due) return null;
    const ceiling = new Date(due);
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
  ): { orders: number; lines: number; days: number | null } {
    const value = sourceMasterData()?.plants?.find(row => row.plant === plant)?.max_push_forward_days;
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
      const ceiling = Engine.latestAllowedEnd(task, plant);
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
   * critical mismatch flag in place. Firmed is parent-level only and does not
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
      backlogFound: 0, moved: 0, firmedMoved: 0, frozenMoved: 0, movedRuntimeHours: 0, largestDelayMinutes: 0,
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
          const candidate = item.snapshotStart < now
            ? cursor
            : new Date(Math.max(item.snapshotStart.getTime(), cursor.getTime()));
          let start: Date;
          let end: Date;
          let scheduleSegments: OrderScheduleSegment[] | undefined;
          if (splitPolicy === 'never') {
            // Preserve the existing continuous-bar contract exactly for legacy
            // schedules. A split schedule that is explicitly regenerated under
            // this policy is cleared below as one atomic parent aggregate.
            const slot = Calendar.findContiguousSlot(line, candidate, runtimeMs);
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
            const allocation = Calendar.allocateRuntime(line, candidate, Math.round(runtimeHours * 60), splitPolicy);
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

  /** Allocate a sequence already selected by an optimizer strategy. The
   * selection/order remains the strategy's responsibility; this pass only
   * turns each selected logical parent into its calendar-valid aggregate.
   * Firmed parents are treated as atomic envelope obstacles so no free order is
   * interleaved between the productive pieces of another logical order. */
  _dispatchPolicyAware(
    line: string,
    orderedTasks: NimbusTask[],
    firmedTasks: NimbusTask[],
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
        const blocker = firmedTasks.find(f => f.start_date && f.end_date
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
    // maps, firmed protection, or the day-integrity resequencer.
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
    const respectFirmed   = (opts.respectFirmed as boolean | undefined)   ?? true;
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
    // 'duedate' (2026-09-09) routes exactly like 'changeover': it always
    // takes the setup-aware branch, synthesizing the same zero-cost snapshot
    // when the plant has no genuine active-and-matching one, but selects the
    // 'due-date' evaluator mode instead of 'min-changeover'.
    // 'spt' is untouched: it still only takes this branch when genuinely
    // active-and-matching, exactly as before B3a.
    const setupSnapshot = Store.setupSnapshot;
    const setupSnapshotActiveAndMatching = !!(setupSnapshot && setupSnapshot.plant === plant && setupSnapshot.plant_active);
    const effectiveSetupSnapshot: SetupSnapshot | null = (mode === 'changeover' || mode === 'duedate' || mode === 'spt') && !setupSnapshotActiveAndMatching
      ? Engine._syntheticZeroCostSetupSnapshot(plant)
      : setupSnapshot;
    if (mode === 'changeover' || mode === 'duedate' || mode === 'spt' || setupSnapshotActiveAndMatching) {
      const evaluatorMode = mode === 'spt' ? 'spt' : mode === 'duedate' ? 'due-date' : 'min-changeover';
      // Phase 2 (Pkg D): scope the fallback snapshot's calendars to this run's
      // plant — every consumer of ScheduleSnapshot.calendars in this path
      // (freeIntervalsFor/jointWindowForDay/hasNominalWindow in
      // setup-scheduler.mts, sourceLineWorkHours above) only ever looks up a
      // line that survived this same plant's task filter, so no other
      // plant's lines are ever needed here.
      const baseSnapshot = _candidateSnapshot ?? snapshotSchedule(plant);
      // C2: fold any ECC-firmed or frozen-window order into the SAME firmedIds
      // set the setup-aware evaluators already treat as immovable — Engine.
      // isFrozenHorizon carries its own distinct reason for the UI (never
      // written to Store.isFirmed itself), this is purely an internal input
      // to the evaluator so it never re-sequences an order it shouldn't touch.
      // respectFirmed gates BOTH the manual firmed ids and the ECC-firmed
      // fold, exactly like the legacy walk's `(respectFirmed && (sourceIsFirmed
      // (t.id) || !!t.ecc_firmed))` guard below — unchecking "Respect firmed"
      // in the Optimize dialog must free ECC-firmed orders here too, not just
      // in the legacy per-line path. The frozen-horizon fold is unconditional
      // regardless of respectFirmed, since it is a scheduling-window
      // constraint, not a firming concept. Passes horizonStart (this run's
      // own "now", injectedNow-aware for candidate runs) rather than the
      // real-time default, so a detached preview evaluated at a simulated
      // instant agrees with itself. Never written back to the Store — this
      // fold is run-local only (see effectiveFirmedIdSet).
      const effectiveFirmedIds = effectiveFirmedIdSet(baseSnapshot.tasks, baseSnapshot.firmedIds, horizonStart, respectFirmed);
      const snapshot: ScheduleSnapshot = { ...baseSnapshot, firmedIds: effectiveFirmedIds };
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
        lines: opts.lines as string[] | undefined,
        notBefore: (task: NimbusTask) => Engine.earliestAllowedStart(task, plant),
        notAfter: (task: NimbusTask) => Engine.latestAllowedEnd(task, plant),
        convergenceWindow: SETUP_AWARE_CONVERGENCE_WINDOW,
      };
      let result = Engine.evaluateSetupAware(evaluatorMode, bounds, snapshot);
      if (result.validationContext) result.validationContext = { ...result.validationContext, baselineSnapshot: baseSnapshot };
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
      if (result.validationFindings?.some(finding => finding.severity === 'error')) {
        Engine.lastSetupAwareResult = result;
        return result;
      }
      if (result.patches.length) {
        const undoTasks = structuredClone(snapshot.tasks.filter(task => result.patches.some(patch => patch.id === String(task.id))));
        UndoStack.push(`Optimization (${mode})`, () => UndoStack.restoreTasks(undoTasks));
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
      else scheduleAlertsForPatches(result.patches, id => byId.get(String(id))?.MACHINE || 'Unknown');
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
      // respectFirmed, same as isAged/isOutOfWin) — so every dispatcher fed
      // by this split (_dispatchPolicyAware, the SPT walk below) leaves it
      // untouched. Engine.isFrozenHorizon carries its
      // own distinct reason for the UI; this split itself doesn't care why
      // a task is immovable, only that it is. Passes horizonStart as this
      // check's "now" — the SAME reference isAged/isOutOfWin already use —
      // so all three agree on one clock for this run instead of splitting.
      // ECC-firmed rides the respectFirmed gate exactly like a manual firm — so
      // 'backlog' mode (which sets respect off / moves firmed by design) may
      // move ECC-firmed orders too (confirmed product decision).
      const firmedTasks = tasks.filter(t =>
        (respectFirmed && (sourceIsFirmed(t.id) || !!t.ecc_firmed)) || isAged(t) || isOutOfWin(t) || Engine.isFrozenHorizon(t, horizonStart)
      );
      let freeTasks = tasks.filter(t =>
        !(respectFirmed && (sourceIsFirmed(t.id) || !!t.ecc_firmed)) && !isAged(t) && !isOutOfWin(t) && !Engine.isFrozenHorizon(t, horizonStart)
      );

      firmedTasks.sort((a,b) => (a.start_date?.getTime()||0) - (b.start_date?.getTime()||0));

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
        // Cap-aware resequencing for the plant's due-date push-forward limit
        // (`plants.max_push_forward_days`): identity when no task on this
        // line has a ceiling, otherwise pulls an otherwise-savable capped
        // order ahead of the SPT head when the head would push it past its
        // latest allowed start.
        const selectedOrder = capAwareSequence(
          decorated.map(d => d.t),
          cursor.getTime(),
          t => Engine.latestAllowedEnd(t, plant)?.getTime() ?? null,
          t => Util.runHours(t) * Config.MS_HOUR,
        );
        patches.push(...Engine._dispatchPolicyAware(line, selectedOrder, firmedTasks, cursor, splitPolicy, plant));
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
      // Cap-aware resequencing for the plant's due-date push-forward limit
      // (`plants.max_push_forward_days`): identity when no task on this line
      // has a ceiling, otherwise pulls an otherwise-savable capped order
      // ahead of the SPT head when the head would push it past its latest
      // allowed start.
      freeTasks = capAwareSequence(
        decorated.map(d => d.t),
        cursor.getTime(),
        t => Engine.latestAllowedEnd(t, plant)?.getTime() ?? null,
        t => Util.runHours(t) * Config.MS_HOUR,
      );

      // Walk through free tasks, jumping past each firmed task we encounter.
      let firmIdx = 0;
      for (const t of freeTasks) {
        const durMs = Util.runHours(t) * Config.MS_HOUR;
        if (durMs <= 0) continue;
        const floor = Engine.earliestAllowedStart(t, plant);
        if (floor && cursor < floor) cursor = new Date(floor);

        // Alternate between firmed-task collision check and calendar adjustment
        // until cursor is stable. This handles the case where a calendar gap
        // (blackout, closed hours) pushes cursor into a firmed task's window.
        let guard = 0;
        for (; guard < 200; guard++) {
          const prevMs = cursor.getTime();

          // Step 1: jump past any firmed task that cursor + duration would overlap.
          while (firmIdx < firmedTasks.length) {
            const f = firmedTasks[firmIdx];
            if (!f.start_date || !f.end_date) { firmIdx++; continue; }
            if (cursor >= f.end_date) { firmIdx++; continue; }
            if (cursor.getTime() + durMs <= f.start_date.getTime()) break;
            cursor = new Date(f.end_date);
            firmIdx++;
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
        // Guard exhausted without converging: the firmed-task + calendar constraints never
        // settled on a stable slot. Placement still proceeds at `cursor`, but surface it
        // so the condition isn't silently swallowed (previously a hard-to-diagnose "why
        // didn't this order move?" at scale).
        if (guard >= 200) {
          reportSchedulerDiagnostic(
            'warn', 'engine', 'engine.placement-guard',
            `Placement guard hit 200 iterations on "${line}" for order "${t.text || t.id}" — ` +
            `schedule may be suboptimal; check firmed orders / blackouts on this line.`,
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

    // Due-date push-forward limit (plants.max_push_forward_days): same
    // post-hoc reporting as the setup-aware branch above, using this run's
    // own patches and the plant's pre-apply tasks.
    const overCapSummary = Engine._overCapSummary(patches, sourceTasksByPlant(plant), plant);
    if (overCapSummary.orders) {
      Toast.show(Util.t('toast.optimize_over_lateness_cap', {
        orders: overCapSummary.orders,
        lines: overCapSummary.lines,
        // days is never null here: overCapSummary.orders > 0 only when the
        // plant has a configured limit (see _overCapSummary's null fast-exit).
        days: overCapSummary.days ?? 0,
      }), 'warn');
    }

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

  /** After a manual edit to one task, re-flow subsequent unfirmed orders on the
   *  same line to eliminate overlap. Spans day boundaries so Day-1 overflow
   *  cascades correctly into Day-2 tasks. Does NOT move firmed orders (manual
   *  or ECC-firmed). */
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
          if (Store.isFirmed(p.id) || !!p.ecc_firmed || Engine.isFrozenHorizon(p) || p.end_date! < _horizonStart) {
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
      Alerts.scheduleRecomputeLines(new Set([line]));
      return;
    }
    for (const p of peers) {
      // Peer ends before the changed task starts — entirely prior, cannot overlap; skip.
      if (p.end_date! <= changed.start_date) continue;
      const requiredSetupMinutes = setupMinutes(predecessor, p);
      const requiredStart = new Date(cursor.getTime() + requiredSetupMinutes * Config.MS_MIN);
      if (p.start_date! >= requiredStart) { cursor = new Date(p.end_date!); predecessor = p; continue; }
      if (Store.isFirmed(p.id) || !!p.ecc_firmed || Engine.isFrozenHorizon(p) || p.end_date! < _horizonStart) {
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
}, 'engine.runtime-reconcile');

/**
 * Evaluate against the existing placement algorithm, but with its reads bound
 * to `snapshot`.  This adapter shares the legacy mode implementation; it
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
