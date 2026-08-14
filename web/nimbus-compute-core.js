/* nimbus-compute-core.js — the SINGLE source of truth for NIMBUS's compute:
 * the Calendar capacity engine, the Alerts rule set, and the Utilization matrix,
 * plus the pure date/time helpers they share.
 *
 * Loaded by BOTH the main thread and the worker so there is exactly one
 * implementation of this safety-critical logic (was previously hand-mirrored
 * between app.js and nimbus-worker.js — see CODE_REVIEW_FINDINGS.md T2):
 *   - Browser main thread : <script src="nimbus-compute-core.js?v=…">  → window.NimbusComputeCore
 *                           (app.js's Alerts._recomputeSync / Utilization.computeMatrix /
 *                            Calendar._dayWindow / effectiveFromCapacity delegate here)
 *   - Web Worker          : importScripts('nimbus-compute-core.js?v=…') → self.NimbusComputeCore
 *   - Node (tests)        : require('../nimbus-compute-core.js')         → module.exports
 *
 * ZERO DOM access, no window.NIMBUS dependency. Must never import/reference app.js.
 *
 * Behavioral contract: computeAlerts / computeUtilization / the capacity engine reproduce
 * app.js's Alerts._recomputeSync / Utilization.computeMatrix / Calendar EXACTLY — including
 * plant-scoping of line blocks (line:null blocks and reused line codes are resolved by the
 * line's plant) and the O(1) line→plant memo. tests/js/compute-core.test.js pins this.
 *
 * STILL a separate copy (reconciled + parity-pinned, not yet delegated): app.js's
 * Calendar.workWindow / dailyCapacityHours / effectiveCapacityHours remain in app.js because
 * they are coupled to the Engine's per-run cache and Store's O(1) index. They call the SAME
 * math as this module's copies; keep the two in sync until that final delegation lands.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;          // Node (tests)
  } else {
    root.NimbusComputeCore = api;  // Web Worker (self) / browser (window)
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Config constants (mirror of app.js Config) ──────────────────────────────
  const MS_DAY                     = 24 * 60 * 60 * 1000;   // 1 day in ms (was a bare 86400000 literal)
  const MS_HOUR                    = 60 * 60 * 1000;
  const OVERLOAD_THRESHOLD         = 1.0;
  const WARN_THRESHOLD             = 0.8;
  const SHOW_NEAR_CAPACITY_ALERTS  = false;
  const DEFAULT_SHIFT              = [7, 19];
  const WEEKEND_OFF                = true;

  // ── Util helpers ────────────────────────────────────────────────────────────

  function parseDate(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }

  function dayKey(d) {
    const date = parseDate(d);
    if (!date) return '';
    const p = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  }

  function startOfDay(d) {
    const x = parseDate(d);
    if (!x) return null;
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function runHours(task) {
    const v = parseFloat(task?.RUN_TIME);
    return isNaN(v) ? 0 : v;
  }

  // The explicit child collection is the productive schedule.  A parent with
  // fewer than two valid children remains a legacy continuous order, so we do
  // not accidentally turn one old bar into a persisted segment representation.
  function scheduleIntervals(task) {
    const explicit = Array.isArray(task?.scheduleSegments) ? task.scheduleSegments : [];
    const segments = explicit
      .map((segment, index) => {
        const start = parseDate(segment?.startDate ?? segment?.start_date);
        const end = parseDate(segment?.endDate ?? segment?.end_date);
        return start && end && end > start
          ? { sequence: Number(segment?.sequence) || index + 1, start: new Date(+start), end: new Date(+end) }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start || a.sequence - b.sequence);
    if (segments.length >= 2) return segments;

    const start = parseDate(task?.start_date);
    const end = parseDate(task?.end_date);
    return start && end && end > start ? [{ sequence: 1, start: new Date(+start), end: new Date(+end) }] : [];
  }

  // Setup truth is resolved before it reaches the compute core.  The core only
  // validates interval shape so its worker and synchronous callers consume the
  // identical, immutable observation data without consulting setup matrices.
  function setupIntervals(setup) {
    if (!Array.isArray(setup?.intervals)) return [];
    return setup.intervals.map(interval => {
      const start = parseDate(interval?.start), end = parseDate(interval?.end);
      return start && end && end > start && typeof interval.line === 'string'
        ? { ...interval, start, end } : null;
    }).filter(Boolean);
  }

  function mergedOverlapHours(win, intervals) {
    if (!win || !intervals?.length) return 0;
    const w0 = win[0] instanceof Date ? win[0].getTime() : +win[0];
    const w1 = win[1] instanceof Date ? win[1].getTime() : +win[1];
    if (w1 <= w0) return 0;
    const clipped = [];
    for (const it of intervals) {
      if (!it?.s || !it?.e) continue;
      const s = Math.max(w0, it.s instanceof Date ? it.s.getTime() : +it.s);
      const e = Math.min(w1, it.e instanceof Date ? it.e.getTime() : +it.e);
      if (e > s) clipped.push([s, e]);
    }
    if (!clipped.length) return 0;
    clipped.sort((a, b) => a[0] - b[0]);
    let total = 0, curS = clipped[0][0], curE = clipped[0][1];
    for (let i = 1; i < clipped.length; i++) {
      const [s, e] = clipped[i];
      if (s <= curE) curE = Math.max(curE, e);
      else { total += curE - curS; curS = s; curE = e; }
    }
    total += curE - curS;
    return total / MS_HOUR;
  }

  function fmtDTReadable(d) {
    const date = parseDate(d);
    if (!date) return '';
    const p = n => String(n).padStart(2, '0');
    const h24 = date.getHours(), min = date.getMinutes();
    const ampm = h24 < 12 ? 'AM' : 'PM';
    const h12 = h24 % 12 || 12;
    const minStr = min === 0 ? '' : `:${String(min).padStart(2, '0')}`;
    return `${p(date.getMonth()+1)}/${p(date.getDate())}/${String(date.getFullYear()).slice(-2)} · ${h12}${minStr} ${ampm}`;
  }

  // Naive local-time serializers — the backend save contract (no `Z`; see brain.py
  // _to_pydt and MIGRATION.md → "Timezone save corruption").
  function toLocalSeconds(d) {
    const date = parseDate(d);
    if (!date) return '';
    const p = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
         + `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
  }

  function toLocalInput(d) {
    const date = parseDate(d);
    if (!date) return '';
    const p = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
         + `T${p(date.getHours())}:${p(date.getMinutes())}`;
  }

  // ── Calendar helpers (data-driven, no Store/module references) ───────────────

  // Per-top-level-call line→plant memo. Mirrors Store._lineToPlant's O(1) cache so
  // getPlantForLine stays O(1) on the hot (line×day) capacity/matrix loops instead of a
  // linear masterData.lines scan per cell. Set/cleared by computeAlerts/computeUtilization.
  let _plantMemo = null;

  function getPlantForLine(line, lineSettings, masterData) {
    if (_plantMemo && _plantMemo.has(line)) return _plantMemo.get(line);
    // lineSettings override wins (matches Store.getPlantForLine); else the FIRST masterData
    // row for this line code (same result the O(1) index caches).
    const fromSettings = (lineSettings[line] || {}).plant;
    let result;
    if (fromSettings) {
      result = fromSettings;
    } else {
      const mdLine = (masterData?.lines ?? []).find(r => r.production_line === line);
      result = mdLine?.plant ?? null;
    }
    if (_plantMemo) _plantMemo.set(line, result);
    return result;
  }

  function ensureCalendar(line, calendars) {
    if (calendars[line]) return;
    const defaults = {};
    for (let d = 0; d < 7; d++) {
      defaults[d] = (WEEKEND_OFF && (d === 0 || d === 6)) ? null : [...DEFAULT_SHIFT];
    }
    calendars[line] = { workHours: defaults };
  }

  function ensurePlant(name, plants) {
    if (!name || plants[name]) return;
    const defaults = {};
    for (let d = 0; d < 7; d++) {
      defaults[d] = (WEEKEND_OFF && (d === 0 || d === 6)) ? null : [...DEFAULT_SHIFT];
    }
    plants[name] = { workHours: defaults };
  }

  function _dayWindow(workHours, date) {
    const d = new Date(date);
    const wh = workHours[d.getDay()];
    if (!wh) return null;
    const [h1, h2] = wh;
    // h1/h2 are fractional hours (8.5 = 08:30); setHours() truncates the hour arg,
    // so split the minutes out or 08:30 → 08:00.
    const hh1 = Math.floor(h1), mm1 = Math.round((h1 - hh1) * 60);
    const hh2 = Math.floor(h2), mm2 = Math.round((h2 - hh2) * 60);
    const start = new Date(d); start.setHours(hh1, mm1, 0, 0);
    const end   = new Date(d); end.setHours(hh2, mm2, 0, 0);
    return [start, end];
  }

  // Per-compute-call workWindow memoization cache (set before each top-level call).
  let _wwCache = null;

  function workWindow(line, date, calendars, plants, lineSettings, masterData) {
    let key;
    if (_wwCache) {
      const d = new Date(date); d.setHours(0, 0, 0, 0);
      key = line + '|' + d.getTime();
      if (_wwCache.has(key)) return _wwCache.get(key);
    }

    ensureCalendar(line, calendars);
    const lineWin = _dayWindow(calendars[line].workHours, date);
    if (!lineWin) {
      if (_wwCache) _wwCache.set(key, null);
      return null;
    }

    const plant = getPlantForLine(line, lineSettings, masterData);
    let result;
    if (plant) {
      ensurePlant(plant, plants);
      const plantWin = _dayWindow(plants[plant].workHours, date);
      if (!plantWin) {
        if (_wwCache) _wwCache.set(key, null);
        return null;
      }
      const s = new Date(Math.max(lineWin[0], plantWin[0]));
      const e = new Date(Math.min(lineWin[1], plantWin[1]));
      if (s >= e) {
        if (_wwCache) _wwCache.set(key, null);
        return null;
      }
      result = [s, e];
    } else {
      result = lineWin;
    }

    if (_wwCache) _wwCache.set(key, result);
    return result;
  }

  // Pre-parse + bucket blocks once so a tight (line × day) loop reuses parsed Date
  // objects instead of re-parsing each cell. Line-block recs carry `plant` so line:null
  // (globalLine) blocks and reused line codes are scoped to the line's own plant.
  function _indexCapacityBlocks(blocks, plantBlocks) {
    const lineBlocks = new Map(), globalLine = [], plantBlocksIdx = new Map(), globalPlant = [];
    for (const b of blocks) {
      const s = parseDate(b.start), e = parseDate(b.end);
      if (!s || !e) continue;
      const rec = { s, e, plant: b.plant || null };
      if (b.line) { let a = lineBlocks.get(b.line); if (!a) lineBlocks.set(b.line, a = []); a.push(rec); }
      else globalLine.push(rec);
    }
    for (const b of plantBlocks) {
      const s = parseDate(b.start), e = parseDate(b.end);
      if (!s || !e) continue;
      if (b.plant) { let a = plantBlocksIdx.get(b.plant); if (!a) plantBlocksIdx.set(b.plant, a = []); a.push({ s, e }); }
      else globalPlant.push({ s, e });
    }
    return { lineBlocks, globalLine, plantBlocks: plantBlocksIdx, globalPlant };
  }

  function dailyCapacityHours(line, date, calendars, plants, lineSettings, masterData, blocks, plantBlocks, idx) {
    const win = workWindow(line, date, calendars, plants, lineSettings, masterData);
    if (!win) return 0;
    const winHours = (win[1] - win[0]) / MS_HOUR;
    const plant = getPlantForLine(line, lineSettings, masterData);
    let intervals;
    if (idx) {
      // line:null blocks (globalLine) apply only within their own plant; concrete blocks
      // under a reused line code are likewise resolved by plant.
      intervals = [];
      const lb = idx.lineBlocks.get(line); if (lb) for (const x of lb) if (!x.plant || x.plant === plant) intervals.push(x);
      for (const x of idx.globalLine) if (!x.plant || x.plant === plant) intervals.push(x);
      const pb = idx.plantBlocks.get(plant); if (pb) for (const x of pb) intervals.push(x);
      for (const x of idx.globalPlant) intervals.push(x);
    } else {
      intervals = [];
      for (const b of blocks) {
        if (b.plant && b.plant !== plant) continue;
        if (b.line && b.line !== line) continue;
        const s = parseDate(b.start), e = parseDate(b.end);
        if (s && e) intervals.push({ s, e });
      }
      for (const b of plantBlocks) {
        if (b.plant && b.plant !== plant) continue;
        const s = parseDate(b.start), e = parseDate(b.end);
        if (s && e) intervals.push({ s, e });
      }
    }
    return Math.max(0, winHours - mergedOverlapHours(win, intervals));
  }

  // The single buffer formula.
  function effectiveFromCapacity(line, full, lineSettings) {
    const ls = lineSettings[line];
    if (!ls) return full;
    if (ls.bufferUnit === 'pct'   && ls.bufferPct   > 0) return full * (1 - ls.bufferPct / 100);
    if (ls.bufferUnit === 'hours' && ls.bufferHours > 0) return Math.max(0, full - ls.bufferHours);
    return full;
  }

  // ── computeAlerts ────────────────────────────────────────────────────────────
  // Faithful port of app.js Alerts._recomputeSync. Returns { alerts, elapsed }; alerts
  // are already filtered against `dismissed`. Merging the incremental `opts.lines` scope
  // into the retained list is the caller's responsibility.

  function computeAlerts({ tasks, blocks, plantBlocks, calendars, plants, lineSettings, masterData, dismissed, opts, setup }) {
    const t0 = performance.now();

    const onlyLines = Array.isArray(opts?.lines) && opts.lines.length
      ? new Set(opts.lines) : null;

    // Pre-parse block dates once. Line blocks carry `plant` so they can be plant-scoped.
    const parsedBlocks = [];
    for (const b of blocks) {
      const s = parseDate(b.start), e = parseDate(b.end);
      if (s && e) parsedBlocks.push({ line: b.line, plant: b.plant || null, s, e });
    }
    const parsedPlantBlocks = [];
    for (const b of plantBlocks) {
      const s = parseDate(b.start), e = parseDate(b.end);
      if (s && e) parsedPlantBlocks.push({ plant: b.plant, s, e });
    }

    _wwCache = new Map();
    _plantMemo = new Map();
    const plantOf = line => getPlantForLine(line, lineSettings, masterData);

    const alerts = [];
    const todayStart = startOfDay(new Date());
    // task.start_date / end_date are proper Dates (structured-clone preserves them).
    let activeTasks = tasks.filter(t => !t.end_date || t.end_date >= todayStart);
    if (onlyLines) activeTasks = activeTasks.filter(t => onlyLines.has(t.PRODUCTION_LINE || 'Unknown'));

    /* 1. OVERLAPS */
    const byLine = {};
    for (const t of activeTasks) {
      const line = t.PRODUCTION_LINE || 'Unknown';
      for (const interval of scheduleIntervals(t)) {
        (byLine[line] ||= []).push({ task: t, start: interval.start, end: interval.end });
      }
    }
    for (const line of Object.keys(byLine)) {
      const arr = byLine[line].slice().sort((a, b) => a.start - b.start);
      for (let i = 1; i < arr.length; i++) {
        const prev = arr[i-1], cur = arr[i];
        if (prev.task.id !== cur.task.id && cur.start < prev.end) {
          alerts.push({
            id:  `ovl-${prev.task.id}-${cur.task.id}`,
            sev: 'err', type: 'overlap',
            msg: `Orders "${prev.task.text || prev.task.id}" and "${cur.task.text || cur.task.id}" overlap on ${line}.`,
            taskId: cur.task.id, line, time: cur.start
          });
        }
      }
    }

    /* 2. OVERLOAD / CLOSED */
    const byLineDay = {};
    for (const t of activeTasks) {
      const line = t.PRODUCTION_LINE || 'Unknown';
      const intervals = scheduleIntervals(t);
      if (intervals.length >= 2) {
        for (const interval of intervals) {
          let cursor = startOfDay(interval.start);
          while (cursor && cursor < interval.end) {
            const nextDay = new Date(cursor); nextDay.setDate(nextDay.getDate() + 1);
            const overlapHours = (Math.min(+interval.end, +nextDay) - Math.max(+interval.start, +cursor)) / MS_HOUR;
            if (overlapHours > 0) {
              const day = dayKey(cursor);
              const row = (byLineDay[`${line}|${day}`] ||= { line, day, hours: 0, tasks: [] });
              row.hours += overlapHours;
              row.tasks.push(t);
            }
            cursor = nextDay;
          }
        }
      } else if (t.start_date) {
        // Preserve the legacy continuous-order accounting exactly under the
        // default policy; only explicit child schedules use productive pieces.
        const day = dayKey(t.start_date);
        const row = (byLineDay[`${line}|${day}`] ||= { line, day, hours: 0, tasks: [] });
        row.hours += runHours(t);
        row.tasks.push(t);
      }
    }
    // Bucket the already-parsed blocks (zero re-parse) for the per-(line,day) capacity calls.
    const _capIdx = { lineBlocks: new Map(), globalLine: [], plantBlocks: new Map(), globalPlant: [] };
    for (const b of parsedBlocks) {
      const rec = { s: b.s, e: b.e, plant: b.plant || null };
      if (b.line) { let a = _capIdx.lineBlocks.get(b.line); if (!a) _capIdx.lineBlocks.set(b.line, a = []); a.push(rec); }
      else _capIdx.globalLine.push(rec);
    }
    for (const b of parsedPlantBlocks) {
      if (b.plant) { let a = _capIdx.plantBlocks.get(b.plant); if (!a) _capIdx.plantBlocks.set(b.plant, a = []); a.push({ s: b.s, e: b.e }); }
      else _capIdx.globalPlant.push({ s: b.s, e: b.e });
    }
    for (const k of Object.keys(byLineDay)) {
      const { line, day, hours } = byLineDay[k];
      const dateObj = new Date(day + 'T12:00:00');
      const cap = dailyCapacityHours(line, dateObj, calendars, plants, lineSettings, masterData, blocks, plantBlocks, _capIdx);
      const effCap = effectiveFromCapacity(line, cap, lineSettings);

      if (effCap > 0 && hours > effCap * OVERLOAD_THRESHOLD) {
        alerts.push({
          id:  `ovl-day-${line}-${day}`, sev: 'err', type: 'overload',
          msg: `${line} is overloaded on ${day}: ${hours.toFixed(1)}h scheduled vs ${effCap.toFixed(1)}h effective capacity (${cap.toFixed(1)}h total).`,
          line, time: dateObj
        });
      } else if (effCap > 0 && hours > effCap * WARN_THRESHOLD) {
        // Near-capacity alerts suppressed unless SHOW_NEAR_CAPACITY_ALERTS.
        if (SHOW_NEAR_CAPACITY_ALERTS) alerts.push({
          id:  `warn-day-${line}-${day}`, sev: 'warn', type: 'near-capacity',
          msg: `${line} is near capacity on ${day}: ${hours.toFixed(1)} / ${effCap.toFixed(1)}h effective capacity (${Math.round(100*hours/effCap)}%).`,
          line, time: dateObj
        });
      } else if (cap === 0 && hours > 0) {
        const win = workWindow(line, dateObj, calendars, plants, lineSettings, masterData);
        let reason;
        if (!win) {
          reason = `the ${line} or plant calendar is closed that day-of-week`;
        } else {
          const winHrs   = (win[1] - win[0]) / MS_HOUR;
          const plant    = plantOf(line);
          const dayStart = new Date(dateObj); dayStart.setHours(0, 0, 0, 0);
          const dayEnd   = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
          const intervals = [], labels = [];
          for (const b of blocks) {
            if (b.plant && b.plant !== plant) continue;
            if (b.line && b.line !== line) continue;
            const s = parseDate(b.start), e = parseDate(b.end);
            if (!s || !e || s >= dayEnd || e <= dayStart) continue;
            const ov = (Math.min(win[1], e) - Math.max(win[0], s)) / MS_HOUR;
            if (ov > 0) {
              intervals.push({ s, e });
              labels.push(`${b.line ? 'line' : 'global line'}${b.reason ? ` "${b.reason}"` : ''} ${ov.toFixed(1)}h`);
            }
          }
          for (const b of plantBlocks) {
            if (b.plant && b.plant !== plant) continue;
            const s = parseDate(b.start), e = parseDate(b.end);
            if (!s || !e || s >= dayEnd || e <= dayStart) continue;
            const ov = (Math.min(win[1], e) - Math.max(win[0], s)) / MS_HOUR;
            if (ov > 0) {
              intervals.push({ s, e });
              labels.push(`${b.plant ? 'plant' : 'global plant'}${b.reason ? ` "${b.reason}"` : ''} ${ov.toFixed(1)}h`);
            }
          }
          const consumed = mergedOverlapHours(win, intervals);
          reason = `working window is ${winHrs.toFixed(1)}h, blackouts union to ${consumed.toFixed(1)}h (${labels.join(', ') || 'no blocks found — bug?'})`;
        }
        alerts.push({
          id:  `closed-${line}-${day}`, sev: 'err', type: 'closed',
          msg: `${line} is scheduled on ${day} but has 0h capacity — ${reason}.`,
          line, time: dateObj
        });
      }
    }

    /* 3. BLACKOUT VIOLATION */
    for (const t of activeTasks) {
      const line  = t.PRODUCTION_LINE || 'Unknown';
      const plant = plantOf(line);
      let conflict = false;
      let conflictTime = t.start_date;
      for (const interval of scheduleIntervals(t)) {
        for (const b of parsedBlocks) {
          if (b.plant && b.plant !== plant) continue;
          if (b.line && b.line !== line) continue;
          if (interval.start < b.e && interval.end > b.s) {
            conflict = true; conflictTime = interval.start; break;
          }
        }
        if (conflict) break;
        for (const b of parsedPlantBlocks) {
          if (b.plant && b.plant !== plant) continue;
          if (interval.start < b.e && interval.end > b.s) {
            conflict = true; conflictTime = interval.start; break;
          }
        }
        if (conflict) break;
      }
      if (conflict) {
        alerts.push({
          id:  `blk-${t.id}`, sev: 'err', type: 'blackout',
          msg: `Order "${t.text || t.id}" overlaps a blackout block on ${line}.`,
          taskId: t.id, line, time: conflictTime
        });
      }
    }

    /* 4. FIXED-BUT-ON-CLOSED-DAY */
    for (const t of activeTasks) {
      if (!t.fixed) continue;
      const line = t.PRODUCTION_LINE || 'Unknown';
      const badInterval = scheduleIntervals(t).find(interval =>
        !workWindow(line, interval.start, calendars, plants, lineSettings, masterData));
      if (badInterval) {
        alerts.push({
          id:  `fixclosed-${t.id}`, sev: 'warn', type: 'fixed-closed',
          msg: `Fixed order "${t.text || t.id}" is on a day the ${line} calendar is closed.`,
          taskId: t.id, line, time: badInterval.start
        });
      }
    }

    /* 5. FIXED-OUT-OF-HOURS */
    for (const t of activeTasks) {
      if (!t.fixed) continue;
      const line = t.PRODUCTION_LINE || 'Unknown';
      const parts = [];
      let alertTime = t.start_date;
      for (const interval of scheduleIntervals(t)) {
        const winS = workWindow(line, interval.start, calendars, plants, lineSettings, masterData);
        const winE = workWindow(line, interval.end,   calendars, plants, lineSettings, masterData);
        if (winS && interval.start < winS[0]) {
          parts.push(`starts before ${line} opens (${fmtDTReadable(winS[0])})`);
          alertTime = interval.start;
        }
        if (winE && interval.end > winE[1]) {
          parts.push(`ends after ${line} closes (${fmtDTReadable(winE[1])})`);
          alertTime = interval.start;
        }
      }
      if (parts.length) {
        alerts.push({
          id:  `fixhours-${t.id}`, sev: 'warn', type: 'fixed-out-of-hours',
          msg: `Fixed order "${t.text || t.id}" ${parts.join(' and ')}.`,
          taskId: t.id, line, time: alertTime
        });
      }
    }

    // A runtime/schedule mismatch is an authoritative schedule-integrity
    // exception, not a horizon-only capacity signal. It must remain visible
    // after its prior envelope moves into the past, until an aggregate repair
    // succeeds (while respecting an incremental line scope when supplied).
    const mismatchTasks = onlyLines
      ? tasks.filter(t => onlyLines.has(t.PRODUCTION_LINE || 'Unknown'))
      : tasks;
    for (const t of mismatchTasks) {
      if (!t.runtime_schedule_mismatch) continue;
      const line = t.PRODUCTION_LINE || 'Unknown';
      alerts.push({
        id: `runtime-mismatch-${t.id}`, sev: 'err', type: 'runtime-schedule-mismatch',
        msg: `Order "${t.text || t.id}" has a runtime that no longer matches its saved schedule.`,
        taskId: t.id, line, time: t.start_date || new Date(),
      });
    }

    // Setup observations are intentionally supplied by the caller after its
    // one plant-scoped resolution pass.  Alerting validates/reporting only;
    // it does not read a matrix, change Store, or start an optimizer run.
    const setupSeen = new Set();
    const inScope = line => !onlyLines || onlyLines.has(line || 'Unknown');
    const setupKey = (type, entry, pairKey = '') => [
      type, entry.scope || entry.line || 'Unknown', pairKey || entry.pairKey || '',
      entry.predecessorOrderId ?? 'initial', entry.successorOrderId ?? '',
    ].join('|');
    for (const interval of setupIntervals(setup)) {
      if (!inScope(interval.line)) continue;
      const requiredMinutes = Number(interval.requiredMinutes);
      const availableMinutes = Number(interval.availableMinutes);
      if (!Number.isFinite(requiredMinutes) || !Number.isFinite(availableMinutes) || requiredMinutes <= availableMinutes) continue;
      const key = setupKey('setup-violated', interval);
      if (setupSeen.has(key)) continue;
      setupSeen.add(key);
      const shortMinutes = requiredMinutes - availableMinutes;
      alerts.push({
        id: `setup-violated-${key}`, sev: 'err', type: 'setup-violated',
        msg: `Setup on ${interval.line} requires ${requiredMinutes}m but only ${availableMinutes}m is available (${shortMinutes}m short).`,
        taskId: interval.successorOrderId, line: interval.line, time: interval.start,
        requiredMinutes, availableMinutes, shortMinutes,
      });
    }
    const diagnosticTypes = new Set([
      'setup-uncovered', 'initial-state-unknown', 'current-state-diverged', 'override-inactive',
    ]);
    const setupDiagnostics = Array.isArray(setup?.diagnostics) ? setup.diagnostics : [];
    for (const diagnostic of setupDiagnostics) {
      if (!diagnosticTypes.has(diagnostic?.type) || !inScope(diagnostic.line)) continue;
      // A missing matrix transition is a pair/scope problem, not one alert per
      // order occurrence. Other diagnostics remain occurrence-specific.
      const key = diagnostic.type === 'setup-uncovered'
        ? [diagnostic.type, diagnostic.scope || diagnostic.line || 'Unknown', diagnostic.pairKey || 'unknown'].join('|')
        : setupKey(diagnostic.type, diagnostic);
      if (setupSeen.has(key)) continue;
      setupSeen.add(key);
      const time = parseDate(diagnostic.time) || new Date();
      const pair = diagnostic.pairKey ? ` for ${diagnostic.pairKey}` : '';
      alerts.push({
        id: `${diagnostic.type}-${key}`, sev: diagnostic.type === 'override-inactive' ? 'warn' : 'err', type: diagnostic.type,
        msg: diagnostic.message || `Setup ${diagnostic.type.replaceAll('-', ' ')}${pair} on ${diagnostic.line}.`,
        taskId: diagnostic.successorOrderId, line: diagnostic.line, time,
      });
    }

    _wwCache = null;
    _plantMemo = null;

    const dismissedSet = new Set(dismissed || []);
    const kept = alerts.filter(a => !dismissedSet.has(a.id));
    return { alerts: kept, elapsed: performance.now() - t0 };
  }

  // ── computeUtilization ─────────────────────────────────────────────────────
  // Faithful port of app.js Utilization.computeMatrix's build loop. row.tasks contains
  // task IDs (the caller resolves them to objects). Pass `lines` to pin the exact line
  // set (app.js's plant-scoped set); omit it to derive from tasks ∪ Object.keys(calendars).

  function computeUtilization({ tasks, lineSettings, calendars, plants, blocks, plantBlocks, masterData, startMs, days, lines: explicitLines, setup }) {
    const start = startOfDay(new Date(startMs));
    _wwCache = new Map();
    _plantMemo = new Map();

    let lines;
    if (Array.isArray(explicitLines)) {
      lines = new Set(explicitLines);
    } else {
      lines = new Set(tasks.map(t => t.PRODUCTION_LINE || 'Unknown'));
      Object.keys(calendars).forEach(l => lines.add(l));
    }

    const blockIdx = _indexCapacityBlocks(blocks, plantBlocks);
    const matrix = {};
    for (const line of lines) {
      matrix[line] = {};
      for (let i = 0; i < days; i++) {
        const d = new Date(start); d.setDate(start.getDate() + i);
        const key = dayKey(d);
        const cap = dailyCapacityHours(line, d, calendars, plants, lineSettings, masterData, blocks, plantBlocks, blockIdx);
        matrix[line][key] = {
          date:              d,
          scheduled:         0,
          capacity:          cap,
          effectiveCapacity: effectiveFromCapacity(line, cap, lineSettings),
          tasks:             []
        };
      }
    }

    for (const t of tasks) {
      if (!t.start_date) continue;
      const line = t.PRODUCTION_LINE || 'Unknown';
      if (!matrix[line]) continue;

      const intervals = scheduleIntervals(t);
      if (intervals.length >= 2) {
        const lineRows = matrix[line];
        for (const interval of intervals) {
          const intervalStartMs = interval.start.getTime();
          const intervalEndMs = interval.end.getTime();
          for (const key of Object.keys(lineRows)) {
            const row = lineRows[key];
            const dayStartMs = row.date.getTime();
            const dayEndMs = dayStartMs + MS_DAY;
            if (intervalEndMs <= dayStartMs || intervalStartMs >= dayEndMs) continue;
            const contribution = (Math.min(intervalEndMs, dayEndMs) - Math.max(intervalStartMs, dayStartMs)) / MS_HOUR;
            if (contribution > 0) {
              row.scheduled += contribution;
              if (!row.tasks.includes(t.id)) row.tasks.push(t.id);
            }
          }
        }
        continue;
      }

      if (!t.end_date) {
        const key = dayKey(t.start_date);
        if (matrix[line][key]) {
          matrix[line][key].scheduled += runHours(t);
          matrix[line][key].tasks.push(t.id);
        }
        continue;
      }

      const tStartMs   = t.start_date.getTime();
      const tEndMs     = t.end_date.getTime();
      if (tEndMs <= tStartMs) continue;
      const taskRunHrs = runHours(t);
      if (taskRunHrs <= 0) continue;
      const totalTaskMs = tEndMs - tStartMs;

      const lineRows = matrix[line];
      for (const key of Object.keys(lineRows)) {
        const row      = lineRows[key];
        const dayStartMs = row.date.getTime();
        const dayEndMs   = dayStartMs + MS_DAY;
        if (tEndMs <= dayStartMs || tStartMs >= dayEndMs) continue;
        if (!workWindow(line, row.date, calendars, plants, lineSettings, masterData)) continue;
        const overlapMs    = Math.min(tEndMs, dayEndMs) - Math.max(tStartMs, dayStartMs);
        const contribution = taskRunHrs * (overlapMs / totalTaskMs);
        if (contribution > 0) {
          row.scheduled += contribution;
          row.tasks.push(t.id);
        }
      }
    }

    // Derived setup occupies real capacity but is never a persisted task.  Its
    // successor task id is retained only so existing row consumers can focus
    // the owning order; a missing successor remains an interval-only charge.
    for (const interval of setupIntervals(setup)) {
      const lineRows = matrix[interval.line];
      if (!lineRows) continue;
      const intervalStartMs = interval.start.getTime();
      const intervalEndMs = interval.end.getTime();
      for (const key of Object.keys(lineRows)) {
        const row = lineRows[key];
        const dayStartMs = row.date.getTime();
        const dayEndMs = dayStartMs + MS_DAY;
        if (intervalEndMs <= dayStartMs || intervalStartMs >= dayEndMs) continue;
        const contribution = (Math.min(intervalEndMs, dayEndMs) - Math.max(intervalStartMs, dayStartMs)) / MS_HOUR;
        if (contribution > 0) {
          row.scheduled += contribution;
          if (interval.successorOrderId && !row.tasks.includes(interval.successorOrderId)) row.tasks.push(interval.successorOrderId);
        }
      }
    }

    for (const line of Object.keys(matrix)) {
      for (const k of Object.keys(matrix[line])) {
        const row = matrix[line][k];
        row.pct = row.capacity > 0 ? row.scheduled / row.capacity : (row.scheduled > 0 ? 1 : 0);
      }
    }

    _wwCache = null;
    _plantMemo = null;
    return { matrix };
  }

  return {
    // constants
    MS_DAY, MS_HOUR, OVERLOAD_THRESHOLD, WARN_THRESHOLD, SHOW_NEAR_CAPACITY_ALERTS, DEFAULT_SHIFT, WEEKEND_OFF,
    // date/time helpers
    parseDate, dayKey, startOfDay, runHours, scheduleIntervals, setupIntervals, mergedOverlapHours, fmtDTReadable, toLocalSeconds, toLocalInput,
    // calendar engine
    getPlantForLine, ensureCalendar, ensurePlant, _dayWindow, workWindow,
    _indexCapacityBlocks, dailyCapacityHours, effectiveFromCapacity,
    // top-level compute
    computeAlerts, computeUtilization,
  };
});
