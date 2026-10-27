// insights/services.mjs — Compute, Alerts, scheduleAlertsForPatches, and
// Utilization (Phase P4 of docs/architecture/domain-refactor-plan.md, which
// split schedule-services.mts (3,544 lines) into 4 domain files). Delegates
// algorithmic truth to nimbus-compute-core.js and preserves the existing
// worker protocol byte-for-byte. DOM/UI code that was co-located with these
// modules in app.js (the alerts drawer, bell badge, and cell-briefing modal)
// stays in app.js as a thin adapter (`AlertsUIAdapter`) — see
// docs/architecture/cq1-compatibility-inventory.md.
//
// This file subscribes (once, below Alerts) to the `schedule:hydrated` Store
// event that scheduling/persistence.mjs's Persistence emits after every
// load/cache-restore/demo-seed, and triggers Alerts.scheduleRecompute() in
// response — a Store event subscription, not an import: scheduling/
// persistence.mjs still never imports this file.
//
// `Engine` (optimization/engine.mjs) is a real cross-file import forming a
// two-way ESM cycle with that module (see optimization/engine.mjs's header
// comment for the full mechanics) — `Alerts.applyFix`'s auto-fix action
// calls `Engine.splitOrderPolicyFor`/`schedulePatchFor`/`autoReflow`/
// `runAndApply`, while Engine's own `runAndApply`/`autoReflow`/
// `reconcileRuntimeSchedules` call `Alerts.clearDismissed`/
// `scheduleRecompute`/`scheduleRecomputeLines`/`scheduleAlertsForPatches`
// (this file). This dependency predates this phase (sibling top-level
// consts in the single schedule-services.mts file) — the split only turns
// it into a real ESM cycle. Safe under the same rule as every cycle in this
// split: every cross-reference is inside a method body invoked after both
// modules finish loading, never at top-level evaluation.
//
// `Calendar` (calendar/calendar-engine.mjs) and `deriveSetupObservation`/
// `SetupObservation` (optimization/engine.mjs) are one-directional imports —
// nothing in calendar/calendar-engine.mjs or optimization/engine.mjs's
// deriveSetupObservation needs anything from this file.
//
// CRITICAL non-import path fix (found during this phase's split, not caught
// by `npm run build`): `Compute._init`'s `new Worker(...)` call used a
// relative URL (`'nimbus-worker.js?v=...'`) that resolved correctly when
// this code lived at the frontend/ root (schedule-services.mts) — a relative
// specifier passed to the Worker() constructor from an ES module resolves
// against THAT MODULE's own URL, not the document's URL, unlike a classic
// script. Now that this code lives one directory down
// (frontend/insights/services.mts), the path is `'../nimbus-worker.js?v=...'` —
// see `_init()` below. Left uncorrected, the worker would 404 silently and
// `Compute` would fall back to synchronous main-thread compute (its
// documented, permanent-for-the-session fallback), which build/lint/tsc
// cannot catch since it is a plain runtime string, not an import.
import { Config, Util, ErrorLog, PerfMonitor, Toast } from '../platform/foundation.mjs';
import { Store, UndoStack } from '../platform/store.mjs';
import { Calendar } from '../calendar/calendar-engine.mjs';
import { Engine, deriveSetupObservation } from '../optimization/engine.mjs';
import { Sandbox } from '../optimization/sandbox.mjs';
import { planningReasonText } from '../scheduling/planning-reason.mjs';
import { alertOrderIds } from './alert-profiles.mjs';
import type { SetupObservation } from '../optimization/engine.mjs';
import type { ScheduleSnapshot } from '../optimization/setup-scheduler.mjs';
import type { NimbusTask, NimbusBlock, NimbusPlantBlock, WorkHours, NimbusLineSetting, NimbusMasterData, PlantCalendarEntry } from '../platform/types.mjs';

// -- Local type declarations (Phase 3 conversion; scoped to this file) ------
interface CalendarEntry {
  workHours: WorkHours;
}

/** Fields common to both the ALERTS and UTILIZATION worker payloads (Compute._snap's return). */
interface WorkerSnapshotBase {
  tasks: NimbusTask[];
  blocks: NimbusBlock[];
  plantBlocks: NimbusPlantBlock[];
  calendars: Record<string, CalendarEntry>;
  plants: Record<string, PlantCalendarEntry>;
  lineSettings: Record<string, NimbusLineSetting>;
  masterData: NimbusMasterData | null;
  setup: SetupObservation;
}

/** Utilization.computeMatrix's row shape — tasks RESOLVED to objects (see T-8 in
 *  docs/archive/typescript_migration.md: this is deliberately NOT the same type as the
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

/** One clock for alerts (OQ52): each plant's wall-clock "now" (the server instant in the plant's zone,
 *  via Store.plantNow), keyed by plant, for the compute core's active-order horizon. A plant with no
 *  valid timezone has no entry (the core then keeps its own clock for that plant; the plant is
 *  recorded as blocked by Store.plantNow and surfaces as plant_no_timezone in Task 3.3). */
function _plantClocks(plants: Iterable<string>): Record<string, Date> {
  const out: Record<string, Date> = {};
  for (const plant of plants) {
    const now = Store.plantNow(plant);
    if (now) out[plant] = now;
  }
  return out;
}

/** The clock half of every alert payload: each plant's wall-clock "now" plus the plants Store.plantNow refused
 *  (no valid timezone), which the compute core renders as plant_no_timezone alerts. Worker request and the
 *  synchronous fallback both build it here, so the two paths cannot drift. Asking for the clocks first is what
 *  registers a blocked plant, so the blocked list is read after. */
function _alertClockPayload(plants: Iterable<string>): { now: Record<string, Date>; blockedPlants: string[] } {
  const list = [...plants];
  const now = _plantClocks(list);
  return { now, blockedPlants: list.filter(plant => Store._blockedPlants.has(plant)) };
}

/** Tool-conflict alerts consume PRT_01/PRT_02. Only production version is
 *  unused after setup observation has been derived from the full source. */
function _stripPriorityFields(t: NimbusTask): NimbusTask {
  const { PRODUCTION_VERSION, ...rest } = t;
  return rest as NimbusTask;
}

interface SnapshotOpts {
  /** Use this setup observation instead of deriving one (the leverage engine's what-if hook). */
  setupObservation?: NimbusSetupObservation;
  /** Default true: drop PRODUCTION_VERSION from the transported tasks. */
  stripPriorityFields?: boolean;
}

/** The plant-scoped worker payload body. Shared by Compute._snap (which must not touch the plant
 *  clock registry) and the exported buildPlantSnapshot. */
function _buildSnapshotBase(plant: string | null | undefined, opts: SnapshotOpts = {}): { snap: WorkerSnapshotBase; lines: string[] | null } {
  const strip = opts.stripPriorityFields !== false;
  const override = opts.setupObservation as SetupObservation | undefined;
  if (!plant) {
    // Setup state must be resolved from the un-stripped source: stateForOrder
    // reads PRODUCTION_VERSION, which is omitted from task transport.
    // Deriving from the stripped copy would
    // silently blank every state for any definition using those fields.
    const src = Store.tasksArr;
    const setup = override ?? deriveSetupObservation(Store.setupSnapshot, src, undefined, {
      calendars: Store._state.calendars, plants: Store._state.plants, lineSettings: Store._state.lineSettings,
      masterData: Store._state.masterData, blocks: Store._state.blocks, plantBlocks: Store._state.plantBlocks,
    });
    const tasks = strip ? src.map(_stripPriorityFields) : src;
    // No plant selected — nothing is rendered; fall back to the global snapshot.
    return { lines: null, snap: {
      tasks,
      blocks:       Store._state.blocks,
      plantBlocks:  Store._state.plantBlocks,
      calendars:    Store._state.calendars,
      plants:       Store._state.plants,
      lineSettings: Store._state.lineSettings,
      masterData:   Store._state.masterData,
      setup,
    } };
  }
  // Plant-scoped snapshot. The structured-clone of this payload runs synchronously
  // on the main thread on every postMessage (the dominant main-thread cost of the
  // Worker.* round trip), so we send only the selected plant's data. calendars and
  // lineSettings MUST be scoped too: computeUtilization derives its line set from
  // Object.keys(calendars), and those maps accumulate entries for every line visited
  // this session — an unscoped map would make the worker compute (and clone back) a
  // matrix for lines that aren't even on screen.
  const lineList = Store._linesByPlant[plant] || [];
  const lines = new Set(lineList);
  const pick = <T,>(obj: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const l of lines) if (obj[l] !== undefined) out[l] = obj[l];
    return out;
  };
  // Same rule as the no-plant branch above: derive from the un-stripped
  // source array so stateForOrder can still read PRT_01/PRT_02/PRODUCTION_VERSION.
  const src = Store.tasksByPlant(plant);
  const setup = override ?? deriveSetupObservation(Store.setupSnapshot, src, lines, {
    calendars: pick(Store._state.calendars), plants: Store._state.plants[plant] ? { [plant]: Store._state.plants[plant] } : {},
    lineSettings: pick(Store._state.lineSettings), masterData: Store._state.masterData,
    blocks: Store._state.blocks.filter(b => (!b.plant || b.plant === plant) && (!b.line || lines.has(b.line))),
    plantBlocks: Store._state.plantBlocks.filter(b => !b.plant || b.plant === plant),
  });
  const tasks = strip ? src.map(_stripPriorityFields) : src;
  return { lines: lineList, snap: {
    tasks,
    blocks:       Store._state.blocks.filter(b => (!b.plant || b.plant === plant) && (!b.line || lines.has(b.line))),
    plantBlocks:  Store._state.plantBlocks.filter(b => !b.plant || b.plant === plant),
    calendars:    pick(Store._state.calendars),
    plants:       Store._state.plants[plant] ? { [plant]: Store._state.plants[plant] } : {},
    lineSettings: pick(Store._state.lineSettings),
    masterData:   Store._state.masterData,
    setup,
  } };
}

/** The full alert/utilization payload for one plant, plus its line set and wall-clock fields.
 *  `opts.setupObservation` replaces the derived setup (what-if replay). */
export function buildPlantSnapshot(plant: string | null, opts: SnapshotOpts = {}): WorkerSnapshotBase & {
  lines: string[] | null; now: Record<string, Date>; blockedPlants: string[];
} {
  const _pmT0 = performance.now();
  try {
    const { snap, lines } = _buildSnapshotBase(plant, opts);
    return { ...snap, lines, ..._alertClockPayload(plant ? [plant] : []) };
  } finally {
    PerfMonitor.record('Leverage.buildPlantSnapshot', performance.now() - _pmT0);
  }
}

/** Upper bound on one dedicated-worker leverage batch. On expiry the worker is terminated and the call
 *  rejects with a TimeoutError (the caller keeps its quick ranking; nothing reruns on the main thread). */
const LEVERAGE_BATCH_TIMEOUT_MS = 30000;

function _leverageAbort(name: 'TimeoutError' | 'AbortError', message: string): Error {
  return new DOMException(message, name);
}

let _leverageSeq = 0;
/** Leverage-worker crashes this page load (separate from Compute._crashCount/_dead). After 2, batches skip worker
 *  creation and use the main-thread path directly; reset only by a page reload. */
let _leverageCrashes = 0;
const LEVERAGE_MAX_CRASHES = 2;
/** One short-lived worker per batch, so a slow replay never blocks the shared alerts/utilization worker
 *  and can be cancelled outright with terminate(). Settles exactly once; the worker is terminated on
 *  every exit (result, error, timeout, abort). A constructor throw or worker crash rejects with a plain
 *  Error (the caller then uses the synchronous core); timeout/abort reject with TimeoutError/AbortError
 *  and never touch the shared Compute worker state (_crashCount/_dead). */
function _leverageViaDedicatedWorker(base: LeverageBase, variants: LeverageVariant[], signal?: AbortSignal): Promise<LeverageResult[]> {
  return new Promise<LeverageResult[]>((resolve, reject) => {
    let w: Worker;
    try {
      w = new Worker('../nimbus-worker.js?v=' + Config.BUILD_ID);
    } catch (e) {
      reject(e instanceof Error ? e : new Error('worker unavailable'));
      return;
    }
    const id = ++_leverageSeq;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish(() => reject(_leverageAbort('AbortError', 'leverage batch aborted')));
    function finish(settle: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      w.onmessage = null;
      w.onerror = null;
      try { w.terminate(); } catch {}
      settle();
    }
    w.onmessage = ({ data }) => {
      if (!data || data.id !== id) return;
      if (data.type === 'ERROR') {
        const wMsg = `worker compute error${data.failingType ? ' (' + data.failingType + ')' : ''}: ${data.error || 'unknown'}`;
        try { ErrorLog.error('worker', wMsg, { failingType: data.failingType }, { errorCode: 'worker.compute', stack: data.stack }); } catch {}
        finish(() => reject(new Error(data.error || 'worker compute error')));
      } else if (data.type === 'LEVERAGE_BATCH_RESULT' && Array.isArray(data.results)) {
        finish(() => resolve(data.results as LeverageResult[]));
      } else {
        finish(() => reject(new Error('malformed leverage worker reply')));
      }
    };
    w.onerror = (ev) => {
      _leverageCrashes++;
      try { ErrorLog.warn('worker', `leverage worker crashed: ${ev?.message || 'worker error'}`, { filename: ev?.filename || '', lineno: ev?.lineno ?? null }, { errorCode: 'worker.compute' }); } catch {}
      finish(() => reject(new Error('worker error')));
    };
    timer = setTimeout(() => finish(() => reject(_leverageAbort('TimeoutError', 'leverage batch timed out'))), LEVERAGE_BATCH_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const _cloneT0 = performance.now();
      w.postMessage({ type: 'LEVERAGE_BATCH', id, payload: { base, variants } });
      PerfMonitor.record('Worker.postClone:LEVERAGE_BATCH', performance.now() - _cloneT0);
    } catch (e) {
      finish(() => reject(e instanceof Error ? e : new Error('postMessage failed')));
    }
  });
}

export type LeverageBase = ComputeAlertsPayload & { startMs: number; days: number; lines?: string[] };
export interface LeverageVariant { key: string; setup: NimbusSetupObservation }
export interface LeverageResult { key: string; alerts: NimbusAlert[]; matrix: NimbusUtilizationMatrix }

/** Main-thread equivalent of the worker's LEVERAGE_BATCH handler (used when the worker is dead or
 *  absent). calendars/plants get a shallow copy per core call: ensureCalendar/ensurePlant only ADD missing
 *  top-level keys (they never edit an existing entry), so a fresh top-level map keeps `base` (and the live
 *  Store maps it can alias) untouched without cloning every entry. */
export function runLeverageBatchSync(base: LeverageBase, variants: LeverageVariant[]): LeverageResult[] {
  const Core = globalThis.NimbusComputeCore!;
  const fresh = () => ({ calendars: { ...base.calendars }, plants: { ...base.plants } });
  return variants.map(({ key, setup }) => ({
    key,
    alerts: Core.computeAlerts({ ...base, ...fresh(), setup }).alerts,
    matrix: Core.computeUtilization({ ...base, ...fresh(), setup }).matrix,
  }));
}

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
      _worker = new Worker('../nimbus-worker.js?v=' + Config.BUILD_ID);
      _worker.onmessage = ({ data }) => {
        // Worker-global failure (self.onerror / unhandledrejection): no job id, so it must
        // be handled before the _pending lookup below drops it. Pending jobs are untouched.
        if (data.type === 'ERROR' && data.id == null) {
          ErrorLog.error('worker', `worker ${data.failingType || 'error'}: ${data.error || 'unknown'}`,
            { failingType: data.failingType, filename: data.filename, lineno: data.lineno },
            { errorCode: 'worker.uncaught', stack: data.stack });
          return;
        }
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
      _worker.onmessageerror = () => {
        ErrorLog.error('worker', 'messageerror: structured clone failed', {}, { errorCode: 'worker.messageerror' });
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
      const _cloneT0 = performance.now();
      w.postMessage({ type, id, payload });
      PerfMonitor.record('Worker.postClone:' + type, performance.now() - _cloneT0);
    });
  }

  function _snap(): WorkerSnapshotBase { return _buildSnapshotBase(Store.selectedPlant).snap; }

  return {
    available(): boolean { return !_dead && typeof Worker !== 'undefined'; },

    alerts(opts: { lines?: Set<string> } = {}, dismissed?: Set<string>): Promise<{ alerts: NimbusAlert[]; elapsed: number }> {
      const _t0 = performance.now();
      return _post('ALERTS', {
        ..._snap(),
        ..._alertClockPayload(Store.selectedPlant ? [Store.selectedPlant] : []),
        dismissed: [...(dismissed || [])],
        opts: { lines: opts?.lines instanceof Set ? [...opts.lines] : null },
      }).then(r => { PerfMonitor.record('Worker.alerts', performance.now() - _t0); return r; });
    },

    utilization(startMs: number, days: number): Promise<{ matrix: NimbusUtilizationMatrix }> {
      const _t0 = performance.now();
      const { snap, lines: plantLines } = _buildSnapshotBase(Store.selectedPlant);
      // With a plant, give the core the SAME line set Utilization.computeMatrix uses (task lines plus every plant line),
      // so an idle line with no orders and no calendar entry is present whichever producer filled the shared cache.
      const lines = plantLines ? [...new Set([...snap.tasks.map(t => t.MACHINE || 'Unknown'), ...plantLines])] : undefined;
      return _post('UTILIZATION', { ...snap, ...(lines ? { lines } : {}), startMs, days })
        .then(r => { PerfMonitor.record('Worker.utilization', performance.now() - _t0); return r; });
    },

    /** Replay alerts + utilization per hypothetical setup observation on a dedicated short-lived worker (one
     *  round trip). Timeout (30 s) and abort reject with TimeoutError/AbortError and never rerun on the main
     *  thread. The synchronous core runs only when there is no Worker, the constructor throws, the leverage
     *  worker crashed (or has crashed twice already this page load), it replied ERROR / a malformed reply, or
     *  postMessage threw. */
    async leverageBatch(base: LeverageBase, variants: LeverageVariant[], opts: { signal?: AbortSignal } = {}): Promise<LeverageResult[]> {
      const signal = opts?.signal;
      if (signal?.aborted) throw _leverageAbort('AbortError', 'leverage batch aborted');
      if (typeof Worker !== 'undefined' && _leverageCrashes < LEVERAGE_MAX_CRASHES) {
        try {
          return await _leverageViaDedicatedWorker(base, variants, signal);
        } catch (e) {
          // Timeout/abort are decided outcomes: the caller keeps its quick ranking. Never redo the heavy
          // batch on the main thread for them. Anything else (constructor throw, worker crash, compute
          // error) drops to the synchronous core as before.
          const name = (e as Error)?.name;
          if (name === 'TimeoutError' || name === 'AbortError') throw e;
          ErrorLog.warn('worker', 'leverage batch fell back to main thread', { error: String((e as Error)?.message || e) });
        }
      }
      if (signal?.aborted) throw _leverageAbort('AbortError', 'leverage batch aborted');
      return runLeverageBatchSync(base, variants);
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
  /** Gap A (2026-10-23): queued `overlong_never` rows that now fit one working period after the calendar widened.
   *  Frontend-only and display-only: no bar moves and nothing is persisted (D6); Optimize or a manual placement
   *  releases the row. The check uses the engine's own predicate (`Calendar.hasNominalWindow`) but only
   *  approximates the queueing decision: it measures the run time alone and from the plant's now, while the engine's
   *  walk anchors at the row's finish and may include setup minutes, so a row flagged here can still be refused (or
   *  one not flagged could still place) when the planner places it; the alert says "run Optimize or place it",
   *  never that it is guaranteed to fit. Recomputed with every
   *  alert pass (`calendar:change` already schedules one), so it clears itself when the row stops fitting, is
   *  placed or is dismissed. `onlyLines` scopes it like the core's incremental pass. */
  queuedNowFits(onlyLines: Set<string> | null = null): NimbusAlert[] {
    const out: NimbusAlert[] = [];
    for (const t of Store.tasksArr) {
      if (t.planning_status !== 'needs_planning' || t.planning_reason?.code !== 'overlong_never') continue;
      const line = t.MACHINE;
      if (!line || (onlyLines && !onlyLines.has(line))) continue;
      const plant = t.PLANT || Store.getPlantForLine(line);
      if (!plant) continue;
      const minutes = Math.round(Util.runHours(t) * 60);
      if (!Number.isFinite(minutes) || minutes <= 0) continue;
      const now = Store.plantNow(plant);
      if (!now) continue;                                          // no valid plant zone: nothing to judge against
      const tz = Store.masterData?.plants?.find(p => p.plant === plant)?.timezone ?? null;
      if (!Calendar.hasNominalWindow(line, now, minutes * Config.MS_MIN, tz)) continue;
      const id = `queued-now-fits-${t.id}`;
      if (Alerts._dismissed.has(id)) continue;
      const order = String(t.PRODUCTION_ORDER ?? t.id);
      out.push({
        id, sev: 'warn', type: 'queued_now_fits',
        msg: `Order "${order}" now fits the working calendar; run Optimize or place it to release it.`,
        msgKey: 'alert.queued_now_fits', msgVars: { order },
        taskId: t.id, line, time: now,
      });
    }
    return out;
  },

  /** Needs Planning (2026-10-26): one warn alert per queued order, so the rows are never buried in machine groups.
   *  Frontend-only (the reason text is localised, which the worker core cannot do) and display-only, like
   *  `queuedNowFits`. Two invariants the Top fixes card relies on: EXACTLY ONE alert per queued order (stable id
   *  `needs-planning-<taskId>`, which is also the acknowledgement key) and NO `peerId`. Skips the reasons that are
   *  already alerted or have nothing to place (`runtime_unknown`, `runtime_pending`, `zero_open_quantity`), rows with
   *  no machine, rows outside `onlyLines` and dismissed alerts. `time` is the due instant (the plant's now when the
   *  order has no due date); `err` once that instant is already before the plant's now. `nowFitsIds` are the order
   *  ids `queuedNowFits` just flagged, so an `overlong_never` row that now fits reads "now fits". */
  needsPlanning(onlyLines: Set<string> | null = null, nowFitsIds: ReadonlySet<string> = new Set()): NimbusAlert[] {
    const out: NimbusAlert[] = [];
    for (const t of Store.tasksArr) {
      if (t.planning_status !== 'needs_planning') continue;
      const code = t.planning_reason?.code;
      if (code === 'runtime_unknown' || code === 'runtime_pending' || code === 'zero_open_quantity') continue;
      const line = t.MACHINE;
      if (!line || (onlyLines && !onlyLines.has(line))) continue;
      const id = `needs-planning-${t.id}`;
      if (Alerts._dismissed.has(id)) continue;
      const plant = t.PLANT || Store.getPlantForLine(line);
      const now = plant ? Store.plantNow(plant) : null;
      const due = Util.dueInstant(t);
      const time = due ?? now;
      if (!time) continue;                                         // no due date and no valid plant clock: nothing to anchor on
      const order = Util.orderNumber(t, String(t.id));
      const reason = planningReasonText(t.planning_reason, (k, v) => Util.t(k, v), { nowFits: nowFitsIds.has(String(t.id)) });
      out.push({
        id, sev: due && now && due.getTime() < now.getTime() ? 'err' : 'warn', type: 'needs_planning',
        msg: reason ? `Order "${order}" has no slot yet: ${reason}` : `Order "${order}" has no slot yet.`,
        msgKey: reason ? 'alert.needs_planning' : 'alert.needs_planning_no_reason', msgVars: { order, reason },
        taskId: t.id, line, time,
      });
    }
    return out;
  },

  /** Both queue-alert producers in one call (the four publish sites use this): "now fits" first, then Needs Planning
   *  with the now-fits ids so its reason text agrees with the sibling alert. */
  queuedAlerts(onlyLines: Set<string> | null = null): NimbusAlert[] {
    const fits = Alerts.queuedNowFits(onlyLines);
    return fits.concat(Alerts.needsPlanning(onlyLines, new Set(fits.map(a => String(a.taskId)))));
  },

  recompute(opts: { lines?: Set<string> } = {}): void {
    // Never post the global (all-line) snapshot to the worker: when no plant is
    // selected nothing is rendered, so route to the cheap sync path instead of
    // structured-cloning every line's calendars/lineSettings/masterData across.
    if (Compute.available() && Store.selectedPlant) {
      const reqRev = Store.rev();
      Compute.alerts(opts, Alerts._dismissed)
        .then(({ alerts, elapsed }) => {
          if (Store.rev() !== reqRev) {
            Alerts.scheduleRecompute();
            return;
          }
          const onlyLines = opts.lines instanceof Set && opts.lines.size ? opts.lines : null;
          if (onlyLines) {
            const retained = (Store.alerts || []).filter(a => !onlyLines.has(a.line));
            Store.setAlerts(retained.concat(alerts, Alerts.queuedAlerts(onlyLines)), 'alerts');
          } else {
            Store.setAlerts(alerts.concat(Alerts.queuedAlerts()), 'alerts');
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
      ..._alertClockPayload(Object.keys(Store._tasksByPlant)),
      dismissed:    [...Alerts._dismissed],
      opts:         { lines: onlyLines ? [...onlyLines] : null },
    });
    if (onlyLines) {
      // Incremental merge: retain alerts on untouched lines, replace only the affected
      // ones. Callers of the scoped path never move a task across lines.
      const retained = (Store.alerts || []).filter(a => !onlyLines.has(a.line));
      Store.setAlerts(retained.concat(kept, Alerts.queuedAlerts(onlyLines)), 'alerts');
    } else {
      Store.setAlerts(kept.concat(Alerts.queuedAlerts()), 'alerts');
    }
    Alerts._lastMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - _t0;
    PerfMonitor.record('Alerts.syncFallback', Alerts._lastMs);
  },

  _dismissed: new Set<string>(),

  /** Return a detached dismissal baseline for callers such as SandboxAdapter.
   * Mutating the returned set must never mutate the live alert filter. */
  snapshotDismissed(): Set<string> {
    return new Set(Alerts._dismissed);
  },

  /** Replace the dismissal filter from a detached baseline. This deliberately
   * does not touch Store.alerts or schedule a recompute; callers restore the
   * filter first and then choose the correct recompute path. Copy the input
   * before clearing so restoring from Alerts._dismissed itself is safe. */
  restoreDismissed(ids: Iterable<string> | null | undefined): void {
    const restored = new Set(ids ?? []);
    Alerts._dismissed.clear();
    for (const id of restored) Alerts._dismissed.add(id);
  },

  dismiss(alertId: string): void {
    Alerts._dismissed.add(alertId);
    Store.dismissAlert(alertId, 'alerts');
  },
  dismissAll(ids?: Iterable<string>): void {
    if (ids === undefined) {
      for (const a of Store.alerts) Alerts._dismissed.add(a.id);
      Store.dismissAllAlerts('alerts');
      return;
    }
    const selected = new Set(ids);
    for (const id of selected) Alerts._dismissed.add(id);
    Store.setAlerts(Store.alerts.filter(a => !selected.has(a.id)), 'alerts');
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

  /**
   * One-click fix. `quiet` suppresses the per-order toasts (moved / cannot fix) and nothing else: a caller that runs
   * many fixes (the Alert Monitor's "Move N orders") reports one summary itself. The result is the alert id leaving `Store.alerts`.
   */
  applyFix(alertId: string, opts?: { quiet?: boolean }): void {
    const quiet = opts?.quiet === true;
    const a = Store.alerts.find(x => x.id === alertId);
    if (!a) return;

    if (a.type === 'overlap' || a.type === 'blackout' || a.type === 'tool-conflict') {
      const task = Store.tasks[a.taskId!];
      if (!task || !task.start_date) { if (!quiet) Toast.show(Util.t('toast.cannot_fix_task'), 'error'); return; }
      // Firmed orders are immovable. firmingStatus is the EFFECTIVE set — frozen horizon,
      // the manual flag and running (in progress), all on this parent-level task — not just
      // Store.isFirmed. SAP's firm flag is display-only and does not block a fix. Optimizer runs and autoReflow already honor the same union.
      // G-0.25: a row carrying an approved placement exception ('overtime' / 'overlong') is fixed the same way.
      if (task.placement_exception || Engine.firmingStatus(task).firmed) { if (!quiet) Toast.show(Util.t('toast.cannot_fix_firmed'), 'warn', 5000); return; }
      const line = task.MACHINE || 'Unknown';
      const splitPolicy = Engine.splitOrderPolicyFor(Store.getPlantForLine(line) ?? Store.selectedPlant);
      const dur  = (Number(task.end_date) - Number(task.start_date)) || Util.runHours(task) * Config.MS_HOUR || Config.MS_HOUR;

      // For multi-order alerts: start searching from the end of the peer (earlier) order. A count-aware tool
      // conflict has several holders: the pusher only fits once d = inUse - available of them have released
      // their copy, so search from the d-th earliest holder release (d = 1 for an overlap / a 2-order conflict).
      // Peers come from alertOrderIds; the id-parse fallback is wrong for ids containing '-'.
      let searchFrom = task.start_date;
      if (a.type === 'overlap' || a.type === 'tool-conflict') {
        let peerIds = alertOrderIds(a).slice(1);
        if (!peerIds.length && a.type === 'overlap') peerIds = [a.id.replace(/^ovl-/, '').split('-')[0]];
        const releases = peerIds.map(id => Store.tasks[id]?.end_date).filter((d): d is Date => !!d)
          .map(d => d.getTime()).sort((x, y) => x - y);
        if (a.type === 'tool-conflict' && a.available === 0) {
          // No copy exists (quantity 0 / all out of service): moving this order can never clear the conflict.
          if (!quiet) Toast.show(Util.t('toast.cannot_fix_tool_unavailable'), 'error');
          return;
        }
        const d = a.type === 'tool-conflict' && a.inUse != null && a.available != null ? Math.max(1, a.inUse - a.available) : 1;
        const release = releases.length ? releases[Math.min(d, releases.length) - 1] : null;
        searchFrom = release != null ? new Date(release) : task.start_date;
      }

      const snap = UndoStack.snapshotTasks([task.id]);
      let newStart: Date;
      let changes: Partial<NimbusTask>;
      if (splitPolicy === 'never') {
        const found = Calendar.nextAvailable(line, searchFrom, dur);
        if (!found) {
          // No slot (overlong order / closed line / nothing within 90 days): never move the order.
          if (!quiet) Toast.show(Util.t('toast.cannot_fix_task'), 'error');
          return;
        }
        newStart = found;
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
          if (!quiet) Toast.show(Util.t('toast.cannot_fix_task'), 'error');
          return;
        }
        newStart = changes.start_date;
      }
      Store.updateTask(task.id, changes, 'alerts');
      try { Engine.autoReflow(task.id); } catch {}
      UndoStack.push(`Auto-fix overlap "${task.text || task.id}"`, () => UndoStack.restoreTasks(snap), [task.id]);
      Alerts.dismiss(alertId);
      if (!quiet) Toast.show(Util.t('toast.order_moved', { name: task.text || task.id, date: Util.fmtDT(changes.end_date ?? newStart) }), 'success');

    } else if (a.type === 'overload') {
      // Scope the changeover optimizer to just this line+day so the optimize and the
      // undo snapshot cover the SAME tasks. (Passing no opts re-optimized the whole
      // plant over a 35-day horizon while the snapshot only captured one line+day,
      // so undo silently lost every cross-line / cross-day move.)
      const line = a.line, day = Util.dayKey(a.time || new Date());
      const plant = Store.getPlantForLine(line) || Store.selectedPlant;
      if (!plant || !Store.plantNow(plant)) {   // VM6 (OQ52): no clock, no placement; same refusal as the Optimize dialog
        Toast.show(Util.t('toast.optimize_plant_no_timezone', { plant: plant ?? '' }), 'error', 9000);
        return;
      }
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
      UndoStack.push(`Auto-fix overload ${line} ${day}`, () => UndoStack.restoreTasks(snap), snap.map(t => t.id));
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
/** True when `task` carries a real (non-placeholder) PRT_01/PRT_02 tool id.
 *  Used to decide whether an incremental alert recompute must escalate to a
 *  full recompute — see `scheduleAlertsForPatches`'s header comment. */
export function taskCarriesTool(task: NimbusTask | undefined | null): boolean {
  // The ONE tool-id reader (placeholder set, trim, upper-case) is the compute core's taskToolIds.
  if (!task) return false;
  return globalThis.NimbusComputeCore!.taskToolIds(task).length > 0;
}

/** True when `task` carries a `PARENT_ORDER` (i.e. is one of a group of
 *  distribution sub-orders that may live on different machines/lines).
 *  Mirrors `taskCarriesTool` for the same reason: a `distribution-separation`
 *  alert can be created/cleared on a sibling sub-order's line — a different
 *  line than the one just edited — so an incremental recompute scoped to
 *  only the touched line(s) can miss it. Used alongside `taskCarriesTool` to
 *  decide whether an incremental alert recompute must escalate to a full
 *  recompute — see `scheduleAlertsForPatches`'s header comment. */
export function taskCarriesDistribution(task: NimbusTask | undefined | null): boolean {
  return !!task?.PARENT_ORDER;
}

export function scheduleAlertsForPatches(
  patches: ReadonlyArray<{ id: string; changes: Partial<NimbusTask> }>,
  resolveLine: (id: string) => string | undefined,
  resolveTask?: (id: string) => NimbusTask | undefined,
): void {
  // No patches to scope to (e.g. an apply that changed nothing) — fall back
  // to a full recompute rather than silently skip one.
  if (!patches.length) { Alerts.scheduleRecompute(); return; }
  const lines = new Set<string>();
  for (const p of patches) {
    if ('MACHINE' in p.changes) { Alerts.scheduleRecompute(); return; }
    const line = resolveLine(p.id);
    if (!line) { Alerts.scheduleRecompute(); return; }
    // `tool-conflict` is emitted on the LATER order's line, and
    // `distribution-separation` can be emitted on any sibling sub-order's
    // line — both can differ from the line any moved task actually lives on,
    // so a scoped recompute could miss creating/clearing that alert on the
    // other line. Any moved task carrying a real PRT_01/PRT_02 tool id or a
    // PARENT_ORDER forces a full recompute instead of trusting the line scope.
    if (resolveTask) {
      const t = resolveTask(p.id);
      if (taskCarriesTool(t) || taskCarriesDistribution(t)) { Alerts.scheduleRecompute(); return; }
    }
    lines.add(line);
  }
  Alerts.scheduleRecomputeLines(lines);
}

// D26 — request-identity guard for loadDistributionSummary. A later call
// (another plant switch, or the reactive plant:selected/schedule:hydrated
// subscriber firing again) bumps this; a response captured under an older
// sequence number is dropped rather than clobbering a newer/empty summary.
let _summarySeq = 0;

/** Load the order distribution summary for the currently-selected plant.
 *  Calls GET /distribution/{plant}/summary and sets Store.distributionSummary.
 *  Exported so the Distribution tab (when it exists) can call this after a
 *  distribution write to refresh the counts. Should also be called on
 *  plant:selected and schedule:hydrated events (see the wired subscriber below).
 *  Skips loading if in What-If mode (Sandbox.active) or before any schedule
 *  has been hydrated (Store.masterData is null until Persistence.load completes).
 *  D26: drops its own response (never writes Store.distributionSummary) if the
 *  plant changed, or a newer call started, while the request was in flight —
 *  otherwise an older plant's response can land after the user has already
 *  switched, overwriting the new plant's (or the reset-to-null) summary. */
export async function loadDistributionSummary(): Promise<void> {
  const plant = Store.selectedPlant;
  // Fix round 1: bump _summarySeq BEFORE the early-return guard below, not
  // after it. An older call's in-flight request checks `stillCurrent()`
  // (seq === _summarySeq) when its response lands; this call's own
  // null-and-return (no plant / What-If / no masterData yet) must supersede
  // that older call just as surely as a full request would — otherwise an
  // in-flight request started before the user entered What-If mode (or
  // cleared the plant) could still land afterward and overwrite the
  // null this call just set.
  const seq = ++_summarySeq;
  const stillCurrent = (): boolean => seq === _summarySeq && Store.selectedPlant === plant;
  // Skip loading for: no plant selected, What-If mode active (Sandbox is
  // a real cross-file import, so this is safe to reference inside a method
  // body; see this file's header comment about the Sandbox ↔ Store ESM cycle),
  // or no schedule data loaded yet (masterData is null until Persistence.load).
  if (!plant || Sandbox.active || !Store.masterData) {
    Store.setDistributionSummary(null, 'distribution-loader');
    return;
  }
  try {
    const response = await Util.fetchTraced(
      `/distribution/${encodeURIComponent(plant)}/summary`,
      { method: 'GET' }
    );
    if (!stillCurrent()) return;
    if (!response.ok) {
      ErrorLog.error('distribution', `Failed to load distribution summary (${response.status})`,
        { plant }, { errorCode: 'distribution.summary_load' });
      Store.setDistributionSummary(null, 'distribution-loader');
      return;
    }
    const summary = await response.json();
    if (!stillCurrent()) return;
    Store.setDistributionSummary(summary, 'distribution-loader');
  } catch (err) {
    if (!stillCurrent()) return;
    ErrorLog.error('distribution', `Error loading distribution summary: ${String(err)}`,
      { plant }, { errorCode: 'distribution.summary_fetch' });
    Store.setDistributionSummary(null, 'distribution-loader');
  }
}

// scheduling/persistence.mjs's Persistence used to call `Alerts.scheduleRecompute()`
// directly after every hydration (load()'s two branches, _loadCache(), _loadDemo()) —
// a reverse dependency scheduling/persistence.mjs must never take (it may not import
// this file). Persistence now emits this Store event instead; subscribe here, the
// legitimate importer of both Store and Alerts, so the recompute still fires exactly
// the same way.
Store.subscribe(evt => {
  if (evt.type === 'schedule:hydrated') Alerts.scheduleRecompute();
  // N3: server-reported save conflicts — scoped recompute for just those lines.
  if (evt.type === 'schedule:conflicts') {
    const lines = (evt as { lines?: string[] }).lines;
    if (lines?.length) Alerts.scheduleRecomputeLines(new Set(lines)); else Alerts.scheduleRecompute();
  }
}, 'insights-services.hydrated');

// Load distribution summary reactively on plant selection and schedule hydration.
// After a plant switch, setSelectedPlant resets distributionSummary to null,
// then emits plant:selected; after a schedule load, Persistence emits
// schedule:hydrated. The Distribution tab will also call loadDistributionSummary()
// directly after a distribution write (placeholder for future task).
// Skip loading while in What-If mode (Sandbox.active) to avoid network calls
// during preview operations that may have a test/placeholder plant selected.
Store.subscribe(evt => {
  if ((evt.type === 'plant:selected' || evt.type === 'schedule:hydrated') && !Sandbox.active) {
    void loadDistributionSummary();
  }
}, 'distribution-loader');

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

/* ----- shared utilization cache (private to this module) ------------------------------------------------
   Bounded LRU of resolved (task OBJECTS in row.tasks) full-plant matrices. An entry is valid only while
   Store.dataRev() equals its dataRev (dataRev ignores alerts:change / lines:selected / ...; see store.mts),
   and a request hits when plant and dataRev match and the requested day window lies inside the cached one
   on identical day timestamps (cells are independent per line and per day; where the cached walk and a fresh
   walk would land on different instants, e.g. a DST change at midnight, the request misses instead). */
interface UtilCacheEntry { plant: string; startMs: number; days: number; dataRev: number; matrix: UtilizationMatrixResolved; }
const UTIL_CACHE_MAX = 6;
const UTIL_ASYNC_TIMEOUT_MS = 20000;   // the shared worker is serial behind ALERTS jobs; a late reply is still cached
const UTIL_QUEUE_MAX = 4;
const UTIL_MAX_REPOSTS = 1;
let _utilCache: UtilCacheEntry[] = [];   // most recently used last

/** Local-midnight Dates for `days` consecutive calendar days from `startMs` (setDate walk, the same as the core). */
function _utilWindowDates(startMs: number, days: number): Date[] {
  const start = new Date(startMs);
  const out: Date[] = [];
  for (let i = 0; i < days; i++) { const d = new Date(start); d.setDate(start.getDate() + i); out.push(d); }
  return out;
}

/** Index of the requested window's first day inside the cached window, or -1 when it does not lie inside it or when
 *  any of its day instants differs from the cached walk's (so a slice is always identical to a fresh compute). */
function _utilFirstIndex(entryStartMs: number, entryDays: number, startMs: number, days: number): number {
  if (startMs < entryStartMs || days > entryDays) return -1;
  const cached = _utilWindowDates(entryStartMs, entryDays);
  const first = cached.findIndex(d => d.getTime() === startMs);
  if (first < 0 || first + days > entryDays) return -1;
  const wanted = _utilWindowDates(startMs, days);
  for (let i = 0; i < days; i++) if (cached[first + i].getTime() !== wanted[i].getTime()) return -1;
  return first;
}

/** The requested window cut out of `entry`, or null when it cannot be served exactly. An exact window returns the
 *  cached matrix itself; a sub-window builds a new object sharing the (read-only) rows. */
function _utilSlice(entry: { startMs: number; days: number; matrix: UtilizationMatrixResolved }, startMs: number, days: number): UtilizationMatrixResolved | null {
  if (entry.startMs === startMs && entry.days === days) return entry.matrix;
  if (_utilFirstIndex(entry.startMs, entry.days, startMs, days) < 0) return null;
  const keys = _utilWindowDates(startMs, days).map(d => Util.dayKey(d));
  const out: UtilizationMatrixResolved = {};
  for (const line of Object.keys(entry.matrix)) {
    const rows = entry.matrix[line];
    const cut: Record<string, UtilizationRowResolved> = {};
    for (const k of keys) {
      if (!rows[k]) return null;   // defensive: a cached window missing a day column is never served
      cut[k] = rows[k];
    }
    out[line] = cut;
  }
  return out;
}

function _utilCacheGet(plant: string, startMs: number, days: number): UtilizationMatrixResolved | null {
  const dataRev = Store.dataRev();
  for (let i = _utilCache.length - 1; i >= 0; i--) {
    const e = _utilCache[i];
    if (e.plant !== plant || e.dataRev !== dataRev) continue;
    const m = _utilSlice(e, startMs, days);
    if (m) { _utilCache.splice(i, 1); _utilCache.push(e); return m; }
  }
  return null;
}

function _utilCachePut(plant: string, startMs: number, days: number, dataRev: number, matrix: UtilizationMatrixResolved): void {
  // Entries from an older data revision can never hit again; drop them, then the oldest beyond the bound.
  _utilCache = _utilCache.filter(e => e.dataRev === dataRev && !(e.plant === plant && e.startMs === startMs && e.days === days));
  _utilCache.push({ plant, startMs, days, dataRev, matrix });
  while (_utilCache.length > UTIL_CACHE_MAX) _utilCache.shift();
}

/** Replace worker task ids with the live task OBJECTS (the shape computeMatrix returns), in place. */
function _utilHydrate(matrix: NimbusUtilizationMatrix): UtilizationMatrixResolved {
  for (const line of Object.keys(matrix)) {
    const rows = matrix[line];
    for (const k of Object.keys(rows)) {
      const row = rows[k];
      row.tasks = row.tasks.map(id => Store.tasks[id]).filter(Boolean) as unknown as string[];
    }
  }
  return matrix as unknown as UtilizationMatrixResolved;
}

/** Async path state: at most ONE request posted to the worker and a short FIFO of queued jobs (UTIL_QUEUE_MAX). A
 *  request overlapping or adjacent to a queued job is merged into it (window = union, waiters shared); a disjoint
 *  window becomes its own job, so a far-away Labor horizon never inflates a near-term request. A queued job reads
 *  plant and dataRev when it is actually posted. A waiter either accepts a synchronous fallback (`fallback`, callers
 *  that must paint) or is rejected with a recognisable error (name UtilizationStale / UtilizationTimeout /
 *  UtilizationWorkerError / UtilizationMalformed) and just drops its work (prewarm, Confidence). */
interface UtilWaiter { startMs: number; days: number; fallback: boolean; resolve: (m: UtilizationMatrixResolved) => void; reject: (e: unknown) => void; }
interface UtilJob { startMs: number; days: number; reposts: number; waiters: UtilWaiter[]; }
let _utilInflight: { plant: string; dataRev: number; startMs: number; days: number; promise: Promise<void> } | null = null;
let _utilPending: UtilJob[] = [];

function _utilErr(name: string, message: string): Error { const e = new Error(message); e.name = name; return e; }

function _utilWindowEndMs(startMs: number, days: number): number {
  const d = new Date(startMs); d.setDate(d.getDate() + days); return d.getTime();
}

/** Days from `startMs` up to (excluding) `endMs`, counted by walking so DST cannot skew it. */
function _utilCountDays(startMs: number, endMs: number): number {
  let n = 0;
  const cur = new Date(startMs);
  while (cur.getTime() < endMs && n < 2000) { n++; cur.setDate(cur.getDate() + 1); }
  return n;
}

/** Settle one waiter that the worker could not serve: synchronous compute when it asked for that, else a named rejection. */
function _utilSettleOne(w: UtilWaiter, name: string, message: string): void {
  if (!w.fallback) { w.reject(_utilErr(name, message)); return; }
  try { w.resolve(Utilization.computeMatrix(new Date(w.startMs), w.days)); } catch (e) { w.reject(e); }
}

function _utilEnqueue(startMs: number, days: number, fallback: boolean): Promise<UtilizationMatrixResolved> {
  return new Promise((resolve, reject) => {
    const waiter: UtilWaiter = { startMs, days, fallback, resolve, reject };
    const endMs = _utilWindowEndMs(startMs, days);
    const mate = _utilPending.find(p => startMs <= _utilWindowEndMs(p.startMs, p.days) && p.startMs <= endMs);
    if (mate) {
      const newStart = Math.min(mate.startMs, startMs);
      const newEnd = Math.max(_utilWindowEndMs(mate.startMs, mate.days), endMs);
      mate.startMs = newStart;
      mate.days = _utilCountDays(newStart, newEnd);
      mate.waiters.push(waiter);
    } else if (_utilPending.length >= UTIL_QUEUE_MAX) {
      _utilSettleOne(waiter, 'UtilizationStale', 'utilization queue is full');
      return;
    } else {
      _utilPending.push({ startMs, days, reposts: 0, waiters: [waiter] });
    }
    _utilPump();
  });
}

function _utilPump(): void {
  if (_utilInflight || !_utilPending.length) return;
  const job = _utilPending.shift()!;
  const plant = Store.selectedPlant;
  // Largest window first so the rest of the fallback waiters are served by slicing the cache that compute just filled.
  const settleAll = (name: string, message: string): void => {
    for (const w of [...job.waiters].sort((a, b) => b.days - a.days)) _utilSettleOne(w, name, message);
  };
  if (!plant || !Compute.available()) { settleAll('UtilizationStale', 'no plant or no worker'); _utilPump(); return; }
  const dataRev = Store.dataRev();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let timedOut = false;
  let resolveDone!: () => void;
  const promise = new Promise<void>(r => { resolveDone = r; });
  const finish = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    _utilInflight = null;
    try { fn(); } catch (e) { for (const w of job.waiters) w.reject(e); }   // never leave a waiter or a joiner hanging
    finally { resolveDone(); _utilPump(); }
  };
  const isFresh = (): boolean => Store.dataRev() === dataRev && Store.selectedPlant === plant;
  const t0 = performance.now();
  _utilInflight = { plant, dataRev, startMs: job.startMs, days: job.days, promise };
  timer = setTimeout(() => { timedOut = true; finish(() => settleAll('UtilizationTimeout', 'utilization worker timed out')); }, UTIL_ASYNC_TIMEOUT_MS);
  let request: Promise<{ matrix: NimbusUtilizationMatrix }>;
  try { request = Compute.utilization(job.startMs, job.days); } catch (e) { request = Promise.reject(e); }
  request.then(({ matrix }) => {
    if (settled) {   // a reply after the timeout is still worth caching while the data it was computed from is current
      if (timedOut && isFresh()) { try { _utilCachePut(plant, job.startMs, job.days, dataRev, _utilHydrate(matrix)); } catch { /* malformed late reply: ignore */ } }
      return;
    }
    finish(() => {
      if (!isFresh()) {
        // The data moved while the worker ran. Same plant: re-post once (worker time only, no main-thread compute);
        // after that, or on a plant change, hand the waiters to their fallback / a stale rejection.
        if (Store.selectedPlant === plant && job.reposts < UTIL_MAX_REPOSTS) { job.reposts++; _utilPending.unshift(job); return; }
        settleAll('UtilizationStale', 'data changed while the worker ran');
        return;
      }
      let resolved: UtilizationMatrixResolved;
      try { resolved = _utilHydrate(matrix); } catch { settleAll('UtilizationMalformed', 'malformed worker reply'); return; }
      _utilCachePut(plant, job.startMs, job.days, dataRev, resolved);
      PerfMonitor.record('Utilization.computeMatrixAsync', performance.now() - t0);
      for (const w of job.waiters) {
        const cut = _utilSlice({ startMs: job.startMs, days: job.days, matrix: resolved }, w.startMs, w.days);
        if (cut) w.resolve(cut); else _utilSettleOne(w, 'UtilizationStale', 'window not sliceable');
      }
    });
  }, () => { if (!settled) finish(() => settleAll('UtilizationWorkerError', 'utilization worker failed')); });
}

/** A caller asking for a window already in flight (same plant and data revision) waits for that request; if the
 *  cache still cannot serve it afterwards (a stale or failed pass) it enqueues like any other caller. */
function _utilJoinExisting(plant: string, startMs: number, days: number, fallback: boolean): Promise<UtilizationMatrixResolved> | null {
  const inf = _utilInflight;
  if (inf && inf.plant === plant && inf.dataRev === Store.dataRev() && _utilFirstIndex(inf.startMs, inf.days, startMs, days) >= 0) {
    return inf.promise.then(() => _utilCacheGet(plant, startMs, days) ?? _utilEnqueue(startMs, days, fallback));
  }
  return null;
}

/* =============================================================================
   UTILIZATION — scheduled vs. available hours per line per day.
   ========================================================================== */
export const Utilization = {
  /** Returns { [line]: { [dayKey]: { scheduled, capacity, pct, tasks } } }.
   *  Pass `srcTasks` to scope the result to a filtered task subset.
   *  The srcTasks===null path is memoized in a small per-plant LRU keyed on Store.dataRev() (see the cache block
   *  above) and a sub-window of a cached window is served by slicing; subset calls (srcTasks provided) skip the
   *  cache. Treat the returned matrix as read-only. */
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
    if (cacheable) {
      const hit = _utilCacheGet(scope, start.getTime(), days);
      if (hit) return hit;
    }
    const dataRevAtStart = Store.dataRev();
    const _pmT0u = performance.now();
    // With a plant selected use the plant's task index, exactly the set the worker computes from, so the sync and
    // async paths (which share one cache) always agree on the line set.
    const taskList = srcTasks !== null ? srcTasks
      : (utilizationSnapshot?.tasks ?? (selectedPlant ? Store.tasksForSelectedPlant() : Store.tasksArr));
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

    // Reproduce the exact line set the inline builder used: task lines, plus either the
    // selected plant's lines or every visited calendar line. Always applied (not just for
    // srcTasks===null) so a caller-supplied task subset (e.g. Dashboard's filtered view)
    // still surfaces plant lines that have zero orders, instead of silently dropping them.
    // Safe for the detached-snapshot optimizer-preview KPI path too (optimize-ui.mts's
    // Util.scheduleKpis calls): that consumer's peak_util_pct takes a running Math.max
    // over pct, and a padded-in idle line always contributes pct===0, so it can never
    // raise the peak. Re-check this comment if that consumer ever changes to an average/sum.
    const lineSet = new Set(taskList.map(t => t.MACHINE || 'Unknown'));
    if (utilizationSnapshot && selectedPlant) {
      for (const [line, settings] of Object.entries(lineSettings)) {
        const mappedPlant = settings.plant
          ?? masterData?.lines.find(row => row.machine === line)?.plant;
        if (mappedPlant === selectedPlant) lineSet.add(line);
      }
    } else if (!utilizationSnapshot && Store.selectedPlant) Store.linesForSelectedPlant().forEach(l => lineSet.add(l));
    else if (!utilizationSnapshot) Object.keys(calendars).forEach(l => lineSet.add(l));
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

    if (cacheable) _utilCachePut(scope, start.getTime(), days, dataRevAtStart, matrix as unknown as UtilizationMatrixResolved);
    PerfMonitor.record('Utilization.computeMatrix', performance.now() - _pmT0u);
    return matrix as unknown as UtilizationMatrixResolved;
  },

  /** Same matrix as computeMatrix(start, days) (full plant, no task subset) but computed off the main thread when a
   *  plant is selected and the worker is up. Cache hits and sub-windows of cached/in-flight windows resolve without
   *  any work; identical concurrent requests share one worker call; at most one request is queued behind the one in
   *  flight (a newer one is merged into it). A stale result (data revision or plant moved), a rejection or a ~3 s
   *  timeout answers from the synchronous computeMatrix instead, so the promise always resolves with current data. */
  async computeMatrixAsync(startDate: Date, days: number = 7, opts: { syncFallback?: boolean } = {}): Promise<UtilizationMatrixResolved> {
    const start = Util.startOfDay(startDate)!;
    const startMs = start.getTime();
    const plant = Store.selectedPlant;
    if (!plant || !Compute.available()) return Utilization.computeMatrix(start, days);
    const hit = _utilCacheGet(plant, startMs, days);
    if (hit) return hit;
    // syncFallback: false = a caller that only fills/uses the cache opportunistically (prewarm, Confidence): when the
    // worker cannot answer (stale, timeout, failure) it is rejected with a named error instead of paying a main-thread compute.
    const fallback = opts.syncFallback !== false;
    const shared = _utilJoinExisting(plant, startMs, days, fallback);
    if (shared) return shared;
    return _utilEnqueue(startMs, days, fallback);
  },

  /** Test hooks: the cache is module-private; these read and reset it. */
  _cacheEntries(): ReadonlyArray<Readonly<UtilCacheEntry>> { return _utilCache.slice(); },
  _cacheClear(): void { _utilCache = []; _utilPending = []; _utilInflight = null; },

  /** Severity bucket from a utilisation ratio.
   *  overloadAt defaults to OVERLOAD_THRESHOLD but callers should pass
   *  effectiveCapacity/capacity so the buffer limit is respected. */
  sev(pct: number, overloadAt: number = Config.OVERLOAD_THRESHOLD): 'err' | 'warn' | 'ok' {
    if (pct > overloadAt)               return 'err';
    if (pct > Config.WARN_THRESHOLD)    return 'warn';
    return 'ok';
  },

  /** THE day-attribution rule for one order (OQ12/OQ41): minutes of its work per calendar day on `line`, keyed by
   *  Util.dayKey. The compute core's workingMinutesByDay with the line's working windows, so the cell briefing
   *  reads exactly what the matrix and the overload alert read. */
  minutesByDay(task: NimbusTask, line: string = task.MACHINE || 'Unknown'): Record<string, number> {
    return globalThis.NimbusComputeCore!.workingMinutesByDay(task, date => {
      const win = Calendar.workWindow(line, date);
      return win ? { open: win[0], close: win[1] } : null;
    });
  },

  // Pre-warm the shared utilization cache in the worker so the next synchronous computeMatrix
  // call returns instantly from cache. Declared as a literal method (rather than a
  // post-hoc `Utilization._prewarm = ...` assignment, as in the pre-TS version) so
  // TypeScript's object-literal type inference includes it on Utilization's own type
  // — same treatment as Alerts's debounce methods above.
  _prewarm(): void {
    // Skip when no plant is selected — _snap would otherwise post the global all-line
    // snapshot to the worker for a matrix nothing on screen consumes.
    if (!Compute.available() || !Store.selectedPlant) return;
    const start = Util.plantToday(Store.selectedPlant);   // the plant clock (I13), the same start the Dashboard matrix uses
    Utilization.computeMatrixAsync(start, 7, { syncFallback: false }).catch(() => {});   // fills the shared cache; same path as Confidence/Needs/Labor
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

