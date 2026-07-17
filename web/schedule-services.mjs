// schedule-services.mjs — CQ-1 schedule-services module.
//
// Owns calendar capacity math and the Compute worker client today (Alerts
// computation, Utilization, and Engine join in later Phase 2 tasks). Delegates
// algorithmic truth to nimbus-compute-core.js and preserves the existing
// worker protocol byte-for-byte. May import from schedule-data.mjs; must
// never be imported by it. DOM/UI code that was co-located with Calendar in
// app.js (the calendar blackout-block tab) stays in app.js as a thin adapter
// (`CalendarUI`) — see docs/architecture/cq1-compatibility-inventory.md.
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
import { Config, Util, ErrorLog, PerfMonitor } from './application-foundation.mjs';
import { Store } from './schedule-state.mjs';

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
