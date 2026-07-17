// schedule-services.mjs — CQ-1 schedule-services module.
//
// Owns calendar capacity math, the Compute worker client, Alerts computation,
// and Utilization today (Engine joins in the next Phase 2 task). Delegates
// algorithmic truth to nimbus-compute-core.js and preserves the existing
// worker protocol byte-for-byte. May import from schedule-data.mjs; must
// never be imported by it. DOM/UI code that was co-located with these
// modules in app.js (the calendar blackout-block tab; the alerts drawer,
// bell badge, and cell-briefing modal) stays in app.js as thin adapters
// (`CalendarUI`, `AlertsUIAdapter`) — see
// docs/architecture/cq1-compatibility-inventory.md.
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
  _runCache: null,
  // Pre-parsed blackout blocks scoped to the plant being optimized.
  // { byLine: Map<line|'__any__', BlockRec[]>, byPlant: Map<plant|'__any__', BlockRec[]> }
  // where BlockRec = { s: ms, e: ms, startDate: Date, endDate: Date }.
  _runBlocks: null,

  /** Install per-run caches. Called once at the top of Engine.runAndApply. */
  _beginRun(plant) {
    Calendar._runCache  = { ww: new Map() };
    Calendar._runBlocks = Calendar._indexBlocks(plant);
  },
  /** Tear down per-run caches. Called in a finally{} so it always runs. */
  _endRun() {
    Calendar._runCache  = null;
    Calendar._runBlocks = null;
  },
  /** Parse every blackout block once and bucket by line / plant for O(1) lookup. */
  _indexBlocks(plant) {
    const byLine = new Map();
    for (const b of Store.blocks) {
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
    const byPlant = new Map();
    for (const b of Store.plantBlocks) {
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
  _dayWindow(workHours, date) {
    return globalThis.NimbusComputeCore._dayWindow(workHours, date);
  },

  /** Returns [startDate, endDate] for a line+day, intersected with plant hours.
   *  Returns null if either the line or plant is closed that day, or the
   *  intersection is empty. */
  workWindow(line, date) {
    const rc = Calendar._runCache;
    let key;
    if (rc) {
      const d = new Date(date); d.setHours(0, 0, 0, 0);
      key = line + '|' + d.getTime();
      if (rc.ww.has(key)) return rc.ww.get(key);
    }

    Store.ensureCalendar(line);
    const lineWin = Calendar._dayWindow(Store.calendars[line].workHours, date);
    if (!lineWin) {
      if (rc) rc.ww.set(key, null);
      return null;
    }

    const plant = Store.getPlantForLine(line);
    let result;
    if (plant) {
      Store.ensurePlant(plant);
      const plantWin = Calendar._dayWindow(Store.plants[plant].workHours, date);
      if (!plantWin) {
        if (rc) rc.ww.set(key, null);
        return null;
      }
      const s = new Date(Math.max(lineWin[0], plantWin[0]));
      const e = new Date(Math.min(lineWin[1], plantWin[1]));
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
  _indexCapacityBlocks() {
    const lineBlocks = new Map(), globalLine = [], plantBlocks = new Map(), globalPlant = [];
    for (const b of Store.blocks) {
      const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
      if (!s || !e) continue;
      // Carry the block's plant so dailyCapacityHours can scope line:null blocks
      // (globalLine) to their own plant; line-code reuse across plants is likewise
      // resolved by plant, not just the line string.
      const rec = { s, e, plant: b.plant || null };
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

  dailyCapacityHours(line, date, idx) {
    const win = Calendar.workWindow(line, date);
    if (!win) return 0;
    const winHours = (win[1] - win[0]) / Config.MS_HOUR;

    const plant = Store.getPlantForLine(line);
    let intervals;
    if (idx) {
      // Reuse pre-parsed, bucketed intervals (no parseDate per cell). line:null
      // blocks (globalLine) apply only within their own plant.
      intervals = [];
      const lb = idx.lineBlocks.get(line); if (lb) for (const x of lb) if (!x.plant || x.plant === plant) intervals.push(x);
      for (const x of idx.globalLine) if (!x.plant || x.plant === plant) intervals.push(x);
      const pb = idx.plantBlocks.get(plant); if (pb) for (const x of pb) intervals.push(x);
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
  effectiveFromCapacity(line, full) {
    return globalThis.NimbusComputeCore.effectiveFromCapacity(line, full, Store.lineSettings);
  },

  effectiveCapacityHours(line, date) {
    return Calendar.effectiveFromCapacity(line, Calendar.dailyCapacityHours(line, date));
  },

  /** True if `date` is inside the working window and not inside any blackout. */
  isAvailable(line, date) {
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
  nextAvailable(line, from, durationMs) {
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
    const plant = Store.getPlantForLine(line);
    ErrorLog.error('calendar', `nextAvailable exhausted iteration limit (${MAX_ITERS}) for line ${line} (plant ${plant}) seeking ${durationMs}ms slot from ${Util.fmtDTReadable(from)}`);
    // fallback: return the original from; caller must handle
    return Util.snap(new Date(from));
  },

  /** Find the first blackout block overlapping [start,end) on `line`, else null. */
  _overlapsBlock(line, start, end) {
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
      const plant = Store.getPlantForLine(line);
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

    const plant = Store.getPlantForLine(line);
    for (const b of Store.blocks) {
      if (b.plant && b.plant !== plant) continue;
      if (b.line && b.line !== line) continue;
      const bs = Util.parseDate(b.start), be = Util.parseDate(b.end);
      if (!bs || !be) continue;
      if (start < be && end > bs) return { start: bs, end: be };
    }
    for (const b of Store.plantBlocks) {
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
  let _worker = null;
  let _dead   = false;
  let _crashCount = 0;
  let _seq    = 0;
  const _pending = new Map(); // id → { resolve, reject }

  function _init() {
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

  function _post(type, payload) {
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

  function _snap() {
    const plant = Store.selectedPlant;
    if (!plant) {
      // No plant selected — nothing is rendered; fall back to the global snapshot.
      return {
        tasks:        Store.tasksArr,
        blocks:       Store._state.blocks,
        plantBlocks:  Store._state.plantBlocks,
        calendars:    Store._state.calendars,
        plants:       Store._state.plants,
        lineSettings: Store._state.lineSettings,
        masterData:   Store._state.masterData,
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
    const pick = obj => {
      const out = {};
      for (const l of lines) if (obj[l] !== undefined) out[l] = obj[l];
      return out;
    };
    return {
      tasks:        Store.tasksByPlant(plant),
      blocks:       Store._state.blocks.filter(b => (!b.plant || b.plant === plant) && (!b.line || lines.has(b.line))),
      plantBlocks:  Store._state.plantBlocks.filter(b => !b.plant || b.plant === plant),
      calendars:    pick(Store._state.calendars),
      plants:       Store._state.plants[plant] ? { [plant]: Store._state.plants[plant] } : {},
      lineSettings: pick(Store._state.lineSettings),
      masterData:   Store._state.masterData,
    };
  }

  return {
    available() { return !_dead && typeof Worker !== 'undefined'; },

    alerts(opts, dismissed) {
      const _t0 = performance.now();
      return _post('ALERTS', {
        ..._snap(),
        dismissed: [...(dismissed || [])],
        opts: { lines: opts?.lines instanceof Set ? [...opts.lines] : null },
      }).then(r => { PerfMonitor.record('Worker.alerts', performance.now() - _t0); return r; });
    },

    utilization(startMs, days) {
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
export const Alerts = {
  recompute(opts = {}) {
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

  _recomputeSync(opts = {}) {
    // Synchronous fallback (worker unavailable / no plant selected). Delegates to
    // nimbus-compute-core — the SAME implementation the worker runs — so a worker-dead
    // session and a healthy one produce identical alerts (no "two brains" divergence).
    // Reads the same GLOBAL Store data the previous inline rule engine did (all tasks/
    // blocks/plant-blocks/calendars/…). The core writes calendar defaults into
    // Store.calendars/plants exactly as Store.ensure* did (same in-place side effect).
    const _t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const onlyLines = (opts.lines instanceof Set && opts.lines.size) ? opts.lines : null;
    const { alerts: kept } = globalThis.NimbusComputeCore.computeAlerts({
      tasks:        Store.tasksArr,
      blocks:       Store.blocks,
      plantBlocks:  Store.plantBlocks,
      calendars:    Store.calendars,
      plants:       Store.plants,
      lineSettings: Store.lineSettings,
      masterData:   Store.masterData,
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

  _dismissed: new Set(),

  dismiss(alertId) {
    Alerts._dismissed.add(alertId);
    Store.dismissAlert(alertId, 'alerts');
  },
  dismissAll() {
    for (const a of Store.alerts) Alerts._dismissed.add(a.id);
    Store.dismissAllAlerts('alerts');
  },
  // Clear dismissals (so new runs of recompute() can re-surface the same issue).
  clearDismissed() { Alerts._dismissed.clear(); },

  applyFix(alertId) {
    const a = Store.alerts.find(x => x.id === alertId);
    if (!a) return;

    if (a.type === 'overlap' || a.type === 'blackout') {
      const task = Store.tasks[a.taskId];
      if (!task || !task.start_date) { Toast.show(Util.t('toast.cannot_fix_task'), 'error'); return; }
      const line = task.PRODUCTION_LINE || 'Unknown';
      const dur  = (task.end_date - task.start_date) || Util.runHours(task) * Config.MS_HOUR || Config.MS_HOUR;

      // For overlap: start searching from end of the overlapping peer
      let searchFrom = task.start_date;
      if (a.type === 'overlap') {
        const peerId = a.id.replace(/^ovl-/, '').split('-')[0];
        const peer = peerId ? Store.tasks[peerId] : null;
        if (peer && peer.end_date) searchFrom = peer.end_date;
        else searchFrom = task.start_date;
      }

      const snap = UndoStack.snapshotTasks([task.id]);
      const newStart = Calendar.nextAvailable(line, searchFrom, dur);
      const newEnd   = new Date(newStart.getTime() + dur);
      Store.updateTask(task.id, { start_date: newStart, end_date: newEnd }, 'alerts');
      try { Alerts._engine?.autoReflow(task.id); } catch {}
      UndoStack.push(`Auto-fix overlap "${task.text || task.id}"`, () => UndoStack.restoreTasks(snap));
      Alerts.dismiss(alertId);
      Toast.show(Util.t('toast.order_moved', { name: task.text || task.id, date: Util.fmtDT(newStart) }), 'success');

    } else if (a.type === 'overload') {
      // Scope the combined optimizer to just this line+day so the optimize and the
      // undo snapshot cover the SAME tasks. (Passing no opts re-optimized the whole
      // plant over a 35-day horizon while the snapshot only captured one line+day,
      // so undo silently lost every cross-line / cross-day move.)
      const line = a.line, day = Util.dayKey(a.time || new Date());
      const dayStart = Util.startOfDay(a.time || new Date());
      const dayEnd   = new Date(dayStart.getTime() + 24 * Config.MS_HOUR);
      // Snapshot a SUPERSET of what the optimizer can move: every task on this line
      // that runAndApply would NOT treat as aged/out-of-window — i.e. its free-set
      // predicate (!isAged && !isOutOfWin), null-dated tasks included. Keying on
      // dayKey(start) missed cross-midnight orders and lost them on undo.
      const snap = UndoStack.snapshotTasks(Store.tasksArr.filter(t =>
        (t.PRODUCTION_LINE || 'Unknown') === line &&
        (!t.end_date   || t.end_date   >= dayStart) &&
        (!t.start_date || t.start_date <= dayEnd)
      ).map(t => t.id));
      Alerts._engine?.runAndApply('combined', { lines: [line], startDate: dayStart, endDate: dayEnd });
      UndoStack.push(`Auto-fix overload ${line} ${day}`, () => UndoStack.restoreTasks(snap));
      Alerts.dismiss(alertId);
    }
  },

  // TEMPORARY seam (removed by CQ-1 Phase 2 Task 3, which moves Engine into this
  // same module as a sibling top-level export): applyFix's optimizer/auto-reflow
  // calls can't reference a bare `Engine` yet — it still lives in app.js as of
  // this task, so a static reference here would be an undeclared identifier
  // (this file is a real ES module; no ambient `Engine` global exists). Wired
  // once from app.js boot glue right after the bridge destructure that
  // introduces `Alerts` — see app.js. Task 3 deletes this seam and calls the
  // (by-then sibling) `Engine` object directly instead.
  _engine: null,
  setEngineService(svc) { Alerts._engine = svc; },
};
// Adaptive debounced dispatcher — all callers funnel through this so rapid successive
// mutations (drag → autoReflow → explicit call) collapse into one recompute. The delay
// scales with the last recompute's measured cost (×1.5, clamped) so small/incremental
// updates stay snappy while a heavy full recompute on a large board doesn't thrash the
// main thread — replacing the old fixed 80 ms window that was too short at scale.
const _ALERTS_MIN_DEBOUNCE_MS = 90;
const _ALERTS_MAX_DEBOUNCE_MS = 500;
Alerts._lastMs = 0;
Alerts._timer = null;
Alerts._pendingFull = false;
Alerts._pendingLines = new Set();
Alerts._fire = function () {
  const full  = Alerts._pendingFull;
  const lines = Alerts._pendingLines;
  Alerts._pendingFull = false;
  Alerts._pendingLines = new Set();
  Alerts._timer = null;
  Alerts.recompute(full ? {} : { lines });
};
Alerts._armTimer = function () {
  const delay = Math.min(_ALERTS_MAX_DEBOUNCE_MS,
                         Math.max(_ALERTS_MIN_DEBOUNCE_MS, Math.round(Alerts._lastMs * 1.5)));
  if (Alerts._timer) clearTimeout(Alerts._timer);
  Alerts._timer = setTimeout(Alerts._fire, delay);
};
// Full recompute — the default for block / calendar / plant / line-membership changes.
Alerts.scheduleRecompute = function () {
  Alerts._pendingFull = true;
  Alerts._armTimer();
};
// Incremental recompute scoped to specific lines. Only safe for callers that never move a
// task across lines (optimize / auto-reflow only shift dates within a line); anything that
// could change line membership or global state must use scheduleRecompute() instead. If a
// full recompute is also pending in the same window, the full one wins (always correct).
Alerts.scheduleRecomputeLines = function (lines) {
  if (lines) for (const l of lines) Alerts._pendingLines.add(l);
  Alerts._armTimer();
};

/* =============================================================================
   UTILIZATION — scheduled vs. available hours per line per day.
   ========================================================================== */
export const Utilization = {
  _cache: null,  // { key, matrix } — memoized result of the Store-backed compute path
  /** Returns { [line]: { [dayKey]: { scheduled, capacity, pct, tasks } } }.
   *  Pass `srcTasks` to scope the result to a filtered task subset.
   *  The srcTasks===null path is memoized on (startMs, days, Store.rev()); rev() bumps on
   *  every Store mutation, so a cache hit always reflects current data. Subset calls
   *  (srcTasks provided) skip the cache. Treat the returned matrix as read-only. */
  computeMatrix(startDate, days = 7, srcTasks = null) {
    const start = Util.startOfDay(startDate);
    const cacheable = srcTasks === null;
    // Scope the memo key by selected plant. The worker prewarm (_prewarm) writes a
    // PLANT-SCOPED matrix; this sync path is otherwise GLOBAL. Without a plant
    // discriminator (and a matching line set) the two collide under one key and a
    // consumer can receive the wrong plant's matrix. 'all' = no plant selected.
    const scope = Store.selectedPlant || 'all';
    const cacheKey = `${start.getTime()}|${days}|${Store.rev()}|${scope}`;
    if (cacheable && Utilization._cache && Utilization._cache.key === cacheKey) {
      return Utilization._cache.matrix;
    }
    const _pmT0u = performance.now();
    const taskList = srcTasks !== null ? srcTasks : Store.tasksArr;

    // Reproduce the exact line set the inline builder used: task lines, plus (when this
    // is NOT a filtered subset) either the selected plant's lines or every visited
    // calendar line. Passed explicitly so the core pins the same set.
    const lineSet = new Set(taskList.map(t => t.PRODUCTION_LINE || 'Unknown'));
    if (srcTasks === null) {
      if (Store.selectedPlant) Store.linesForSelectedPlant().forEach(l => lineSet.add(l));
      else Object.keys(Store.calendars).forEach(l => lineSet.add(l));
    }

    // Delegate the matrix build to nimbus-compute-core — the single source of truth,
    // shared with the worker's UTILIZATION path. The core returns row.tasks as task IDs
    // (its worker contract); resolve them back to task OBJECTS here, which is what
    // computeMatrix's callers expect (they read task fields off the rows).
    const { matrix } = globalThis.NimbusComputeCore.computeUtilization({
      tasks:        taskList,
      lineSettings: Store.lineSettings,
      calendars:    Store.calendars,
      plants:       Store.plants,
      blocks:       Store.blocks,
      plantBlocks:  Store.plantBlocks,
      masterData:   Store.masterData,
      startMs:      start.getTime(),
      days,
      lines:        [...lineSet],
    });
    const byId = new Map(taskList.map(t => [t.id, t]));
    for (const line of Object.keys(matrix)) {
      const rows = matrix[line];
      for (const k of Object.keys(rows)) {
        rows[k].tasks = rows[k].tasks.map(id => byId.get(id)).filter(Boolean);
      }
    }

    if (cacheable) Utilization._cache = { key: cacheKey, matrix };
    PerfMonitor.record('Utilization.computeMatrix', performance.now() - _pmT0u);
    return matrix;
  },

  /** Severity bucket from a utilisation ratio.
   *  overloadAt defaults to OVERLOAD_THRESHOLD but callers should pass
   *  effectiveCapacity/capacity so the buffer limit is respected. */
  sev(pct, overloadAt = Config.OVERLOAD_THRESHOLD) {
    if (pct > overloadAt)               return 'err';
    if (pct > Config.WARN_THRESHOLD)    return 'warn';
    return 'ok';
  },

  /** Today's utilisation summary keyed by line. */
  todayByLine() {
    return Utilization.dayByLine(new Date());
  },

  /** Utilisation summary for any given day, keyed by line.
   *  Pass `srcTasks` to scope the result to a filtered task subset. */
  dayByLine(date, srcTasks = null) {
    const taskList = srcTasks !== null ? srcTasks : Store.tasksArr;
    const d = Util.startOfDay(date) || Util.startOfDay(new Date());
    const dEndMs = (() => { const x = new Date(d); x.setDate(x.getDate() + 1); return x.getTime(); })();
    const out = {};
    const lines = new Set(taskList.map(t => t.PRODUCTION_LINE || 'Unknown'));
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
        const blackouts = [];
        // line:null blocks (globalLine) apply only within their own plant; concrete
        // blocks under a reused line code are likewise resolved by plant.
        const _lb = blockIdx.lineBlocks.get(line); if (_lb) for (const x of _lb) if (!x.plant || x.plant === plant) blackouts.push(x);
        for (const x of blockIdx.globalLine) if (!x.plant || x.plant === plant) blackouts.push(x);
        const _pb = blockIdx.plantBlocks.get(plant); if (_pb) for (const x of _pb) blackouts.push(x);
        for (const x of blockIdx.globalPlant) blackouts.push(x);
        for (const t of taskList) {
          if ((t.PRODUCTION_LINE || 'Unknown') !== line) continue;
          if (!t.start_date) continue;
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
  }
};

// Pre-warm Utilization._cache in the worker so the next synchronous computeMatrix
// call returns instantly from cache.
Utilization._prewarm = function () {
  // Skip when no plant is selected — _snap would otherwise post the global all-line
  // snapshot to the worker for a matrix nothing on screen consumes.
  if (!Compute.available() || !Store.selectedPlant) return;
  const plant   = Store.selectedPlant; // scope key so a global / other-plant consumer never reads this entry
  const startMs = Util.startOfDay(new Date()).getTime();
  const rev     = Store.rev();
  Compute.utilization(startMs, 7)
    .then(({ matrix }) => {
      if (Store.rev() !== rev) return; // stale — a newer mutation arrived
      for (const line of Object.keys(matrix)) {
        for (const k of Object.keys(matrix[line])) {
          const row = matrix[line][k];
          row.tasks = row.tasks.map(id => Store.tasks[id]).filter(Boolean);
        }
      }
      Utilization._cache = { key: `${startMs}|7|${rev}|${plant}`, matrix };
    })
    .catch(() => {});
};
// Debounced so a drag-storm / autoReflow burst (many task:update/bulkUpdate events in
// quick succession) collapses into ONE worker round-trip — i.e. one synchronous
// structured-clone of the snapshot — instead of one per mutation.
let _prewarmTimer = null;
Store.subscribe(evt => {
  if (evt.type !== 'tasks:bulk' && evt.type !== 'tasks:bulkUpdate' && evt.type !== 'task:update') return;
  if (_prewarmTimer) clearTimeout(_prewarmTimer);
  _prewarmTimer = setTimeout(() => { _prewarmTimer = null; Utilization._prewarm(); }, 200);
}, 'Utilization.prewarm');
