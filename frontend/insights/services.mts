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
import type { SetupObservation } from '../optimization/engine.mjs';
import type { ScheduleSnapshot } from '../optimization/setup-scheduler.mjs';
import type { NimbusTask, NimbusBlock, NimbusPlantBlock, WorkHours, NimbusLineSetting, NimbusMasterData } from '../platform/types.mjs';

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
  plants: Record<string, CalendarEntry>;
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

/** Utilization.dayByLine/todayByLine's row shape — a THIRD, distinct shape:
 *  no date/tasks at all. */
interface DayByLineRow {
  capacity: number;
  effectiveCapacity: number;
  scheduled: number;
  pct: number;
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

    if (a.type === 'overlap' || a.type === 'blackout' || a.type === 'tool-conflict') {
      const task = Store.tasks[a.taskId!];
      if (!task || !task.start_date) { Toast.show(Util.t('toast.cannot_fix_task'), 'error'); return; }
      const line = task.MACHINE || 'Unknown';
      const splitPolicy = Engine.splitOrderPolicyFor(Store.getPlantForLine(line) ?? Store.selectedPlant);
      const dur  = (Number(task.end_date) - Number(task.start_date)) || Util.runHours(task) * Config.MS_HOUR || Config.MS_HOUR;

      // For pairwise alerts: start searching from the end of the peer (earlier) order.
      // Prefer the structured peerId; the id-parse fallback is wrong for ids containing '-'.
      let searchFrom = task.start_date;
      if (a.type === 'overlap' || a.type === 'tool-conflict') {
        const peerId = a.peerId ?? (a.type === 'overlap' ? a.id.replace(/^ovl-/, '').split('-')[0] : null);
        const peer = peerId ? Store.tasks[peerId] : null;
        searchFrom = peer && peer.end_date ? peer.end_date : task.start_date;
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
// N: same placeholder set as nimbus-compute-core.js's tool-conflict rule
// (`TOOL_PLACEHOLDERS`, ~line 391) — kept in sync deliberately, not shared,
// since the core module has no import boundary into this one.
const _TOOL_PLACEHOLDERS = new Set(['', '-', '0', 'N/A', 'NONE', 'NULL']);

/** True when `task` carries a real (non-placeholder) PRT_01/PRT_02 tool id.
 *  Used to decide whether an incremental alert recompute must escalate to a
 *  full recompute — see `scheduleAlertsForPatches`'s header comment. */
export function taskCarriesTool(task: NimbusTask | undefined | null): boolean {
  if (!task) return false;
  for (const key of ['PRT_01', 'PRT_02'] as const) {
    const v = String(task[key] ?? '').trim();
    if (v && !_TOOL_PLACEHOLDERS.has(v.toUpperCase())) return true;
  }
  return false;
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

/** Load the order distribution summary for the currently-selected plant.
 *  Calls GET /distribution/{plant}/summary and sets Store.distributionSummary.
 *  Exported so the Distribution tab (when it exists) can call this after a
 *  distribution write to refresh the counts. Should also be called on
 *  plant:selected and schedule:hydrated events (see the wired subscriber below).
 *  Skips loading if in What-If mode (Sandbox.active) or before any schedule
 *  has been hydrated (Store.masterData is null until Persistence.load completes). */
export async function loadDistributionSummary(): Promise<void> {
  const plant = Store.selectedPlant;
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
    if (!response.ok) {
      ErrorLog.error('distribution', `Failed to load distribution summary (${response.status})`,
        { plant }, { errorCode: 'distribution.summary_load' });
      Store.setDistributionSummary(null, 'distribution-loader');
      return;
    }
    const summary = await response.json();
    Store.setDistributionSummary(summary, 'distribution-loader');
  } catch (err) {
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

