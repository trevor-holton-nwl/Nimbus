/* nimbus-worker.js — off-main-thread compute for Alerts and Utilization.
 * Receives serialised Store state via postMessage, returns computed results.
 * Zero DOM access; no NIMBUS namespace dependencies.
 *
 * Message protocol
 * ----------------
 *  IN  { type:'ALERTS',      id, payload:{ tasks, blocks, plantBlocks, calendars,
 *                                          plants, lineSettings, masterData,
 *                                          dismissed, opts:{lines?} } }
 *  IN  { type:'UTILIZATION', id, payload:{ tasks, lineSettings, calendars, plants,
 *                                          blocks, plantBlocks, masterData,
 *                                          startMs, days } }
 *  OUT { type:'ALERTS_RESULT',      id, alerts, elapsed }
 *  OUT { type:'UTILIZATION_RESULT', id, matrix }
 *  OUT { type:'ERROR',              id, error }
 */
'use strict';

// ── Config constants (mirror of app.js Config) ────────────────────────────────
const OVERLOAD_THRESHOLD         = 1.0;
const WARN_THRESHOLD             = 0.8;
const SHOW_NEAR_CAPACITY_ALERTS  = false;
const DEFAULT_SHIFT              = [7, 19];
const WEEKEND_OFF                = true;

// ── Util helpers ──────────────────────────────────────────────────────────────

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
  return total / 3600000;
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

// ── Calendar helpers (data-driven, no Store/module references) ─────────────────

function getPlantForLine(line, lineSettings, masterData) {
  const fromSettings = (lineSettings[line] || {}).plant;
  if (fromSettings) return fromSettings;
  const mdLine = (masterData?.lines ?? []).find(r => r.production_line === line);
  return mdLine?.plant ?? null;
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
  // Mirror of app.js Calendar._dayWindow: h1/h2 are fractional hours (8.5 = 08:30);
  // setHours() truncates the hour arg, so split the minutes out or 08:30 → 08:00.
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

// Mirror of app.js Calendar._indexCapacityBlocks: pre-parse + bucket blocks once so a
// tight (line × day) loop reuses parsed Date objects instead of re-parsing each cell.
function _indexCapacityBlocks(blocks, plantBlocks) {
  const lineBlocks = new Map(), globalLine = [], plantBlocksIdx = new Map(), globalPlant = [];
  for (const b of blocks) {
    const s = parseDate(b.start), e = parseDate(b.end);
    if (!s || !e) continue;
    if (b.line) { let a = lineBlocks.get(b.line); if (!a) lineBlocks.set(b.line, a = []); a.push({ s, e }); }
    else globalLine.push({ s, e });
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
  const winHours = (win[1] - win[0]) / 3600000;
  const plant = getPlantForLine(line, lineSettings, masterData);
  let intervals;
  if (idx) {
    intervals = [];
    const lb = idx.lineBlocks.get(line); if (lb) for (const x of lb) intervals.push(x);
    for (const x of idx.globalLine) intervals.push(x);
    const pb = idx.plantBlocks.get(plant); if (pb) for (const x of pb) intervals.push(x);
    for (const x of idx.globalPlant) intervals.push(x);
  } else {
    intervals = [];
    for (const b of blocks) {
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

// Mirror of app.js Calendar.effectiveFromCapacity — the single buffer formula.
function effectiveFromCapacity(line, full, lineSettings) {
  const ls = lineSettings[line];
  if (!ls) return full;
  if (ls.bufferUnit === 'pct'   && ls.bufferPct   > 0) return full * (1 - ls.bufferPct / 100);
  if (ls.bufferUnit === 'hours' && ls.bufferHours > 0) return Math.max(0, full - ls.bufferHours);
  return full;
}

// ── computeAlerts ─────────────────────────────────────────────────────────────
// Port of Alerts.recompute(). Returns { alerts, elapsed }.
// alerts have already been filtered against dismissedSet; merge with retained
// lines is the caller's responsibility on the main thread.

function computeAlerts({ tasks, blocks, plantBlocks, calendars, plants, lineSettings, masterData, dismissed, opts }) {
  const t0 = performance.now();

  const onlyLines = Array.isArray(opts?.lines) && opts.lines.length
    ? new Set(opts.lines) : null;

  // Pre-parse block dates once.
  const parsedBlocks = [];
  for (const b of blocks) {
    const s = parseDate(b.start), e = parseDate(b.end);
    if (s && e) parsedBlocks.push({ line: b.line, s, e });
  }
  const parsedPlantBlocks = [];
  for (const b of plantBlocks) {
    const s = parseDate(b.start), e = parseDate(b.end);
    if (s && e) parsedPlantBlocks.push({ plant: b.plant, s, e });
  }

  _wwCache = new Map();

  const alerts = [];
  const todayStart = startOfDay(new Date());
  // task.start_date / end_date are proper Dates (structured-clone preserves them).
  let activeTasks = tasks.filter(t => !t.end_date || t.end_date >= todayStart);
  if (onlyLines) activeTasks = activeTasks.filter(t => onlyLines.has(t.PRODUCTION_LINE || 'Unknown'));

  const _plantCache = {};
  const plantOf = line => {
    if (!(line in _plantCache)) _plantCache[line] = getPlantForLine(line, lineSettings, masterData);
    return _plantCache[line];
  };

  /* 1. OVERLAPS */
  const byLine = {};
  for (const t of activeTasks) {
    if (!t.start_date || !t.end_date) continue;
    const line = t.PRODUCTION_LINE || 'Unknown';
    (byLine[line] ||= []).push(t);
  }
  for (const line of Object.keys(byLine)) {
    const arr = byLine[line].slice().sort((a, b) => a.start_date - b.start_date);
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i-1], cur = arr[i];
      if (cur.start_date < prev.end_date) {
        alerts.push({
          id:  `ovl-${prev.id}-${cur.id}`,
          sev: 'err', type: 'overlap',
          msg: `Orders "${prev.text || prev.id}" and "${cur.text || cur.id}" overlap on ${line}.`,
          taskId: cur.id, line, time: cur.start_date
        });
      }
    }
  }

  /* 2. OVERLOAD / CLOSED */
  const byLineDay = {};
  for (const t of activeTasks) {
    if (!t.start_date) continue;
    const line = t.PRODUCTION_LINE || 'Unknown';
    const day  = dayKey(t.start_date);
    (byLineDay[`${line}|${day}`] ||= { line, day, hours: 0, tasks: [] });
    byLineDay[`${line}|${day}`].hours += runHours(t);
    byLineDay[`${line}|${day}`].tasks.push(t);
  }
  // Bucket the already-parsed blocks (zero re-parse) for the per-(line,day) capacity calls.
  const _capIdx = { lineBlocks: new Map(), globalLine: [], plantBlocks: new Map(), globalPlant: [] };
  for (const b of parsedBlocks) {
    if (b.line) { let a = _capIdx.lineBlocks.get(b.line); if (!a) _capIdx.lineBlocks.set(b.line, a = []); a.push({ s: b.s, e: b.e }); }
    else _capIdx.globalLine.push({ s: b.s, e: b.e });
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
    } else if (SHOW_NEAR_CAPACITY_ALERTS && effCap > 0 && hours > effCap * WARN_THRESHOLD) {
      alerts.push({
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
        const winHrs   = (win[1] - win[0]) / 3600000;
        const plant    = plantOf(line);
        const dayStart = new Date(dateObj); dayStart.setHours(0, 0, 0, 0);
        const dayEnd   = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
        const intervals = [], labels = [];
        for (const b of blocks) {
          if (b.line && b.line !== line) continue;
          const s = parseDate(b.start), e = parseDate(b.end);
          if (!s || !e || s >= dayEnd || e <= dayStart) continue;
          const ov = (Math.min(win[1], e) - Math.max(win[0], s)) / 3600000;
          if (ov > 0) {
            intervals.push({ s, e });
            labels.push(`${b.line ? 'line' : 'global line'}${b.reason ? ` "${b.reason}"` : ''} ${ov.toFixed(1)}h`);
          }
        }
        for (const b of plantBlocks) {
          if (b.plant && b.plant !== plant) continue;
          const s = parseDate(b.start), e = parseDate(b.end);
          if (!s || !e || s >= dayEnd || e <= dayStart) continue;
          const ov = (Math.min(win[1], e) - Math.max(win[0], s)) / 3600000;
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
    if (!t.start_date || !t.end_date) continue;
    const line  = t.PRODUCTION_LINE || 'Unknown';
    const plant = plantOf(line);
    let conflict = false;
    for (const b of parsedBlocks) {
      if (b.line && b.line !== line) continue;
      if (t.start_date < b.e && t.end_date > b.s) { conflict = true; break; }
    }
    if (!conflict) {
      for (const b of parsedPlantBlocks) {
        if (b.plant && b.plant !== plant) continue;
        if (t.start_date < b.e && t.end_date > b.s) { conflict = true; break; }
      }
    }
    if (conflict) {
      alerts.push({
        id:  `blk-${t.id}`, sev: 'err', type: 'blackout',
        msg: `Order "${t.text || t.id}" overlaps a blackout block on ${line}.`,
        taskId: t.id, line, time: t.start_date
      });
    }
  }

  /* 4. FIXED-BUT-ON-CLOSED-DAY */
  for (const t of activeTasks) {
    if (!t.fixed || !t.start_date) continue;
    const line = t.PRODUCTION_LINE || 'Unknown';
    const win  = workWindow(line, t.start_date, calendars, plants, lineSettings, masterData);
    if (!win) {
      alerts.push({
        id:  `fixclosed-${t.id}`, sev: 'warn', type: 'fixed-closed',
        msg: `Fixed order "${t.text || t.id}" is on a day the ${line} calendar is closed.`,
        taskId: t.id, line, time: t.start_date
      });
    }
  }

  /* 5. FIXED-OUT-OF-HOURS */
  for (const t of activeTasks) {
    if (!t.fixed || !t.start_date || !t.end_date) continue;
    const line = t.PRODUCTION_LINE || 'Unknown';
    const winS = workWindow(line, t.start_date, calendars, plants, lineSettings, masterData);
    const winE = workWindow(line, t.end_date,   calendars, plants, lineSettings, masterData);
    const parts = [];
    if (winS && t.start_date < winS[0]) parts.push(`starts before ${line} opens (${fmtDTReadable(winS[0])})`);
    if (winE && t.end_date   > winE[1]) parts.push(`ends after ${line} closes (${fmtDTReadable(winE[1])})`);
    if (parts.length) {
      alerts.push({
        id:  `fixhours-${t.id}`, sev: 'warn', type: 'fixed-out-of-hours',
        msg: `Fixed order "${t.text || t.id}" ${parts.join(' and ')}.`,
        taskId: t.id, line, time: t.start_date
      });
    }
  }

  _wwCache = null;

  const dismissedSet = new Set(dismissed || []);
  const kept = alerts.filter(a => !dismissedSet.has(a.id));
  return { alerts: kept, elapsed: performance.now() - t0 };
}

// ── computeUtilization ────────────────────────────────────────────────────────
// Port of Utilization.computeMatrix(). row.tasks contains task IDs (not
// objects) — the main thread resolves them after receiving the result.

function computeUtilization({ tasks, lineSettings, calendars, plants, blocks, plantBlocks, masterData, startMs, days }) {
  const start = startOfDay(new Date(startMs));
  _wwCache = new Map();

  const lines = new Set(tasks.map(t => t.PRODUCTION_LINE || 'Unknown'));
  Object.keys(calendars).forEach(l => lines.add(l));

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
      const dayEndMs   = dayStartMs + 86400000;
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

  for (const line of Object.keys(matrix)) {
    for (const k of Object.keys(matrix[line])) {
      const row = matrix[line][k];
      row.pct = row.capacity > 0 ? row.scheduled / row.capacity : (row.scheduled > 0 ? 1 : 0);
    }
  }

  _wwCache = null;
  return { matrix };
}

// ── Message dispatcher ────────────────────────────────────────────────────────

self.onmessage = function ({ data }) {
  const { type, id, payload } = data;
  try {
    if (type === 'ALERTS') {
      const { alerts, elapsed } = computeAlerts(payload);
      self.postMessage({ type: 'ALERTS_RESULT', id, alerts, elapsed });
    } else if (type === 'UTILIZATION') {
      const { matrix } = computeUtilization(payload);
      self.postMessage({ type: 'UTILIZATION_RESULT', id, matrix });
    }
  } catch (err) {
    const out = { type: 'ERROR', id, error: err.message, stack: err.stack, failingType: type };
    if (id != null) out.jobId = id;
    self.postMessage(out);
  }
};
