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
 * Calendar.workWindow / dailyCapacityHours / effectiveCapacityHours (post-refactor:
 * frontend/calendar/calendar-engine.mts, not app.js) all delegate to this module's copies
 * (_dayWindow / dailyCapacityHours / effectiveFromCapacity respectively) rather than
 * duplicating the math — the last of the three (dailyCapacityHours, and the
 * _indexCapacityBlocks bucketing it consumes) was migrated to delegation in the 2026-09
 * capacity-math-triplication cleanup. calendar-engine.mts still owns the Engine-per-run-cache
 * / Store-O(1)-index coupling around these calls; only the underlying interval math lives here.
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

  // Next local calendar midnight via setDate, never `+ MS_DAY`: across a DST change a
  // local day is 23 or 25 hours, so +24h lands on the same date twice (fall back).
  function nextCalendarDay(d) {
    // Constructed from local Y/M/D (not setHours(0)): zones whose DST jump skips local
    // midnight have no 00:00 on that date, and the constructor resolves it forward safely.
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }

  // Previous local calendar midnight, the backward twin of nextCalendarDay: calendar-date
  // arithmetic, never `- MS_DAY` (a local day is 23 or 25 hours across a DST change).
  function prevCalendarDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  }

  // One Intl.DateTimeFormat per zone: constructing it dominates the cost of a conversion and a
  // backward walk converts every free interval it touches.
  const _tzFormatters = new Map();
  function _tzFormatter(timezone) {
    let fmt = _tzFormatters.get(timezone);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
        second: 'numeric', hourCycle: 'h23',
      });
      _tzFormatters.set(timezone, fmt);
    }
    return fmt;
  }

  // The plant-zone wall-clock components of an instant, as a UTC-epoch number
  // (Date.UTC of y/m/d/h/mi/s). Null when the zone is invalid or a part is missing.
  function _wallAsUtcMs(timezone, instantMs) {
    try {
      const values = {};
      for (const part of _tzFormatter(timezone).formatToParts(new Date(instantMs))) {
        if (part.type !== 'literal') values[part.type] = Number(part.value);
      }
      if (![values.year, values.month, values.day, values.hour, values.minute, values.second].every(Number.isFinite)) return null;
      return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
    } catch {
      return null;
    }
  }

  // Project an absolute instant into the naive wall-clock Date convention used by Calendar and
  // the persisted schedule (the plant zone's y/m/d/h/mi/s read through the local constructor).
  // No timezone: the instant is returned as-is. Invalid zone: null.
  function plantWallClockFromInstant(timezone, instant) {
    if (!timezone) return new Date(instant);
    try {
      const parts = _tzFormatter(timezone).formatToParts(instant);
      const values = {};
      for (const part of parts) if (part.type !== 'literal') values[part.type] = Number(part.value);
      if (![values.year, values.month, values.day, values.hour, values.minute, values.second].every(Number.isFinite)) return null;
      return new Date(values.year, values.month - 1, values.day, values.hour, values.minute, values.second, instant.getMilliseconds());
    } catch {
      return null;
    }
  }

  // The inverse of plantWallClockFromInstant: read a naive wall-clock Date's local y/m/d/h/mi/s
  // as plant-zone wall time and return the absolute instant. Disambiguation follows the usual
  // "compatible" rule: a wall time that does not exist (spring-forward gap) resolves to the
  // instant after the gap; an ambiguous one (fall-back hour) to the earlier occurrence.
  // No timezone: the Date itself. Invalid zone: null.
  function plantInstantFromWallClock(timezone, wall) {
    if (!timezone) return new Date(wall);
    const asUtc = Date.UTC(wall.getFullYear(), wall.getMonth(), wall.getDate(), wall.getHours(),
      wall.getMinutes(), wall.getSeconds(), wall.getMilliseconds());
    if (!Number.isFinite(asUtc)) return null;
    // Zone offset (ms) in force at an instant; the wall reading drops sub-second precision.
    const offsetAt = ms => {
      const w = _wallAsUtcMs(timezone, ms);
      return w === null ? null : w - Math.floor(ms / 1000) * 1000;
    };
    const before = offsetAt(asUtc - MS_DAY);
    const after = offsetAt(asUtc + MS_DAY);
    if (before === null || after === null) return null;
    if (before === after) return new Date(asUtc - before);   // no transition within a day either side
    const candBefore = asUtc - before, candAfter = asUtc - after;
    const okBefore = offsetAt(candBefore) === before;
    const okAfter = offsetAt(candAfter) === after;
    if (okBefore && okAfter) return new Date(Math.min(candBefore, candAfter));   // fall-back: earlier
    if (okBefore) return new Date(candBefore);
    if (okAfter) return new Date(candAfter);
    return new Date(Math.max(candBefore, candAfter));                            // spring-forward gap: after it
  }

  // Buckets a date into a separation-window key at the given granularity
  // ('hour' | 'day' | 'week'); 'none' (or anything unrecognized) returns null,
  // meaning no bucket constraint applies. Local wall-clock components throughout —
  // no timezone conversion.
  function separationBucketKey(d, scope) {
    if (scope === 'none') return null;
    if (scope === 'day') return dayKey(d);
    const date = parseDate(d);
    if (!date) return null;
    if (scope === 'hour') {
      const p = n => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}`;
    }
    if (scope === 'week') {
      const wd = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
      const dayNum = wd.getUTCDay() || 7;
      wd.setUTCDate(wd.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(wd.getUTCFullYear(), 0, 1));
      const weekNo = Math.ceil(((wd.getTime() - yearStart.getTime()) / MS_DAY + 1) / 7);
      return `${wd.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
    }
    return null;
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

  /* ── Tool inventory (shared pure API) ──────────────────────────────────────────────────────────────
     ONE implementation of "which orders hold a copy of a tool, and when are there more holders than
     copies". The Gantt alert (rule 1b) and the optimizer's overflow pass both read these functions, so
     they can never disagree. A tool id is a TYPE: a plant owns several interchangeable copies
     (Master Data > Tool Inventory); capacity is the number of DISTINCT MACHINES using the tool at the
     same instant, half-open [start, end). The placeholder set below is mirrored by
     backend/distribution/service.py TOOL_PLACEHOLDERS (parity-tested). */
  const TOOL_PLACEHOLDERS = new Set(['', '-', '0', 'N/A', 'NONE', 'NULL', 'NAN', 'TBD']);

  // Trimmed, upper-cased tool id; null for blank / placeholder values.
  function normalizeToolId(v) {
    if (v == null) return null;
    const s = String(v).trim().toUpperCase();
    return TOOL_PLACEHOLDERS.has(s) ? null : s;
  }

  // The distinct tool ids an order carries. PRT_01 and PRT_02 share one id pool per plant, so the same id
  // in both columns is ONE copy.
  function taskToolIds(task) {
    const out = [];
    for (const key of ['PRT_01', 'PRT_02']) {
      const id = normalizeToolId(task?.[key]);
      if (id && !out.includes(id)) out.push(id);
    }
    return out;
  }

  // Alert and optimizer resolve an order's plant the same way: the order's own PLANT first, else its line's.
  function taskToolPlant(task, plantOf) {
    return task?.PLANT || (plantOf ? plantOf(task?.MACHINE || 'Unknown') : null) || null;
  }

  // When an order occupies its tool: the ENVELOPE from the first segment's start to the last segment's end
  // (a split order keeps its tool mounted across the weekend/blackout gap), run time only (setup is not
  // counted). A finish-only row (start null, end set: a freshly distributed child before the reconcile
  // derives its start) is the U29 bar [end - run_time, end]. Anything else -> null.
  function toolOccupancyInterval(task) {
    const intervals = scheduleIntervals(task);
    if (intervals.length) {
      let start = intervals[0].start, end = intervals[0].end;
      for (const iv of intervals) {
        if (iv.start < start) start = iv.start;
        if (iv.end > end) end = iv.end;
      }
      return { start: new Date(+start), end: new Date(+end) };
    }
    if (parseDate(task?.start_date)) return null;
    const end = parseDate(task?.end_date);
    const runMin = runHours(task) * 60;
    if (!end || runMin <= 0) return null;
    return { start: new Date(+end - runMin * 60000), end: new Date(+end) };
  }

  const _toolKey = (plant, tool) => `${plant == null ? '' : plant}\u0000${tool}`;
  const _num = v => (v instanceof Date ? v.getTime() : +v);
  const _cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  // Capacity map {plant\0tool -> {available, hasRow:true}} from masterData.tool_inventory. Tolerates an
  // undefined/non-array table (every tool is then one copy) and two row shapes: the full rows
  // {plant, tool_id, total_qty, out_of_service_qty} and the compact projection {plant, tool_id, available}.
  function buildToolCapacity(masterData) {
    const map = new Map();
    const rows = masterData?.tool_inventory;
    if (!Array.isArray(rows)) return map;
    for (const row of rows) {
      const tool = normalizeToolId(row?.tool_id);
      if (!tool) continue;
      let available;
      if (row.available != null && row.total_qty == null) available = Number(row.available);
      else available = Number(row.total_qty ?? 1) - Number(row.out_of_service_qty ?? 0);
      if (!Number.isFinite(available)) continue;
      map.set(_toolKey(row.plant, tool), { available: Math.max(0, Math.floor(available)), hasRow: row.hasRow !== false });
    }
    return map;
  }

  // Copies of `tool` the plant can use. A missing row is ONE copy (hasRow:false) so a plant that has not
  // registered a tool behaves like the old "one physical tool" rule.
  function availableCopies(capacity, plant, tool) {
    const hit = capacity?.get(_toolKey(plant, normalizeToolId(tool) ?? tool));
    return hit ? { available: hit.available, hasRow: true } : { available: 1, hasRow: false };
  }

  // Group items by (plant, tool) with the envelope in ms. `item` = {id, line, plant, tools:[...] | tool, start, end}.
  // `now` (Date|ms) drops intervals that ended and clips starts (the optimizer's "past never blocks" rule).
  function _toolGroups(items, now) {
    const nowMs = now == null ? null : _num(now);
    const groups = new Map();
    for (const it of items || []) {
      let s = _num(it?.start), e = _num(it?.end);
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      if (nowMs != null) { if (e <= nowMs) continue; if (s < nowMs) s = nowMs; }
      if (e <= s) continue;
      const ids = new Set();
      for (const raw of Array.isArray(it.tools) ? it.tools : [it.tool]) {
        const id = normalizeToolId(raw);
        if (id) ids.add(id);
      }
      const line = it.line || 'Unknown', id = String(it.id);
      for (const tool of ids) {
        const key = _toolKey(it.plant, tool);
        let g = groups.get(key);
        if (!g) groups.set(key, g = { plant: it.plant == null ? '' : it.plant, tool, rows: [] });
        g.rows.push({ id, line, s, e });
      }
    }
    return groups;
  }

  const _distinctLines = rows => { const set = new Set(); for (const r of rows) set.add(r.line); return set.size; };

  // Every point where MORE distinct machines use a tool than it has copies. Per (plant, tool) sweep, events
  // sorted (time, end-before-start, start, end, id, line): touching intervals never overlap and the result is identical
  // for any input order. One cluster per PUSHER (the start that takes the machine count over the limit):
  //   {plant, tool, at, available, hasRow, inUse, pusher, pusherLine, holders:[{id,line,start,end}]}
  // `holders` are the OTHER orders in use at that instant, sorted (start, end, id); the same machine twice,
  // and the same order twice, count once. Tools whose copies cover every machine that ever uses them are
  // pruned without a sweep.
  function findToolOverages({ items, capacityFor, now } = {}) {
    const groups = _toolGroups(items, now);
    const keys = Array.from(groups.keys()).sort();
    const clusters = [];
    for (const key of keys) {
      const g = groups.get(key);
      const cap = capacityFor ? capacityFor(g.plant, g.tool) : null;
      const available = cap && Number.isFinite(cap.available) ? Math.max(0, cap.available) : 1;
      const hasRow = !!(cap && cap.hasRow);
      if (available >= _distinctLines(g.rows)) continue;
      const events = [];
      for (const r of g.rows) {
        events.push({ t: r.s, type: 1, r });
        events.push({ t: r.e, type: 0, r });
      }
      events.sort((a, b) => a.t - b.t || a.type - b.type || a.r.s - b.r.s || a.r.e - b.r.e
        || _cmp(a.r.id, b.r.id) || _cmp(a.r.line, b.r.line));
      const active = new Set();
      const lineCount = new Map();
      for (const ev of events) {
        const r = ev.r;
        if (ev.type === 0) {
          if (!active.delete(r)) continue;
          const n = (lineCount.get(r.line) || 0) - 1;
          if (n <= 0) lineCount.delete(r.line); else lineCount.set(r.line, n);
          continue;
        }
        const had = lineCount.get(r.line) || 0;
        active.add(r);
        lineCount.set(r.line, had + 1);
        if (had > 0 || lineCount.size <= available) continue;
        const seen = new Set([r.id]);
        const holders = [];
        for (const h of Array.from(active).sort((a, b) => a.s - b.s || a.e - b.e || _cmp(a.id, b.id))) {
          if (seen.has(h.id)) continue;
          seen.add(h.id);
          holders.push({ id: h.id, line: h.line, start: new Date(h.s), end: new Date(h.e) });
        }
        clusters.push({
          plant: g.plant, tool: g.tool, at: new Date(r.s), available, hasRow, inUse: lineCount.size,
          pusher: r.id, pusherLine: r.line, holders,
        });
      }
    }
    return clusters;
  }

  // Alert id for one cluster. EXACTLY two orders (pusher + one holder): the legacy 'toolc-<prev>|<cur>' so
  // existing acknowledgements keep matching. Otherwise 'toolc-<pusher>|<tool>' with / % # replaced (they
  // break the ack DELETE route). `used` (a Set the caller keeps) resolves collisions - e.g. two tools
  // conflicting on the same pair - by falling through to the tool form and then a numeric suffix.
  function toolConflictAlertId(cluster, used) {
    const safe = String(cluster.tool).replace(/[\/%#]/g, '_');
    const candidates = [];
    if (cluster.holders?.length === 1) candidates.push(`toolc-${cluster.holders[0].id}|${cluster.pusher}`);
    candidates.push(`toolc-${cluster.pusher}|${safe}`);
    let id = candidates.find(c => !used || !used.has(c));
    if (!id) {
      const base = candidates[candidates.length - 1];
      let n = 2;
      while (used.has(`${base}~${n}`)) n++;
      id = `${base}~${n}`;
    }
    if (used) used.add(id);
    return id;
  }

  // Reusable per-(plant, tool) index for the optimizer's headroom queries: {groups, capacityFor}.
  function buildToolIndex({ items, capacityFor, now } = {}) {
    return { groups: _toolGroups(items, now), capacityFor };
  }

  // Mutate an index in place when ONE order's interval changes: drop `oldInterval` and add `newInterval`
  // ({plant, line, tools:[...]|tool, start, end}; null = only remove / only insert). Rows are matched by order
  // id + line + start + end within each (plant, tool) group, so the optimizer pass never rebuilds the index.
  // The index keeps no `now` clip: pass the same clipped values buildToolIndex would have used. Returns the index.
  function toolIndexUpdate(index, id, oldInterval, newInterval) {
    if (!index || !index.groups) return index;
    const sid = String(id);
    if (oldInterval) {
      const ids = new Set();
      for (const raw of Array.isArray(oldInterval.tools) ? oldInterval.tools : [oldInterval.tool]) {
        const t = normalizeToolId(raw); if (t) ids.add(t);
      }
      const line = oldInterval.line || 'Unknown', s = _num(oldInterval.start), e = _num(oldInterval.end);
      for (const tool of ids) {
        const key = _toolKey(oldInterval.plant, tool);
        const g = index.groups.get(key);
        if (!g) continue;
        const at = g.rows.findIndex(r => r.id === sid && r.line === line && r.s === s && r.e === e);
        if (at >= 0) g.rows.splice(at, 1);
        if (!g.rows.length) index.groups.delete(key);
      }
    }
    if (newInterval) {
      for (const [key, ng] of _toolGroups([{ ...newInterval, id: sid }], null)) {
        const g = index.groups.get(key);
        if (g) g.rows.push(...ng.rows); else index.groups.set(key, ng);
      }
    }
    return index;
  }

  // Tool-free windows inside [from, to] for placing ONE more order on `excludeLine` that needs every tool in
  // `tools`: a window is free while, for each tool, the distinct machines OTHER than excludeLine are fewer
  // than the available copies. Returns [{start: Date, end: Date}] ascending, merged, non-empty.
  function toolHeadroom(index, plant, tools, from, to, excludeLine) {
    const lo = _num(from), hi = _num(to);
    if (!(hi > lo)) return [];
    const blocked = [];
    const ids = new Set();
    for (const raw of tools || []) { const id = normalizeToolId(raw); if (id) ids.add(id); }
    for (const tool of Array.from(ids).sort()) {
      const cap = index?.capacityFor ? index.capacityFor(plant, tool) : null;
      const available = cap && Number.isFinite(cap.available) ? Math.max(0, cap.available) : 1;
      if (available <= 0) return [];
      const g = index?.groups?.get(_toolKey(plant, tool));
      if (!g) continue;
      const events = [];
      for (const r of g.rows) {
        if (excludeLine != null && r.line === excludeLine) continue;
        if (r.e <= lo || r.s >= hi) continue;
        events.push({ t: r.s, type: 1, r }, { t: r.e, type: 0, r });
      }
      events.sort((a, b) => a.t - b.t || a.type - b.type);
      const lineCount = new Map();
      let from0 = null;
      for (const ev of events) {
        const n = (lineCount.get(ev.r.line) || 0) + (ev.type ? 1 : -1);
        if (n <= 0) lineCount.delete(ev.r.line); else lineCount.set(ev.r.line, n);
        const full = lineCount.size >= available;
        if (full && from0 == null) from0 = ev.t;
        else if (!full && from0 != null) { if (ev.t > from0) blocked.push([from0, ev.t]); from0 = null; }
      }
      if (from0 != null) blocked.push([from0, hi]);
    }
    blocked.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const free = [];
    let cursor = lo;
    for (const [bs, be] of blocked) {
      if (bs > cursor) free.push({ start: new Date(cursor), end: new Date(Math.min(bs, hi)) });
      if (be > cursor) cursor = be;
      if (cursor >= hi) break;
    }
    if (cursor < hi) free.push({ start: new Date(cursor), end: new Date(hi) });
    return free.filter(w => w.end > w.start);
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
    return `${p(date.getMonth()+1)}/${p(date.getDate())}/${date.getFullYear()} · ${p(h12)}:${p(min)} ${ampm}`;
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
  // line → the PLANT carried by the line's tasks (first explicit owner, same rule as
  // Store.getPlantForLine's last-resort fallback) so the worker path resolves a line the
  // same way the sync path does when master data / lineSettings lack it. Set per top-level call.
  let _taskPlantFallback = null;
  function _buildTaskPlantFallback(tasks) {
    const m = new Map();
    for (const t of tasks || []) {
      if (t && t.MACHINE && t.PLANT && !m.has(t.MACHINE)) m.set(t.MACHINE, t.PLANT);
    }
    return m;
  }

  function getPlantForLine(line, lineSettings, masterData) {
    if (_plantMemo && _plantMemo.has(line)) return _plantMemo.get(line);
    // lineSettings override wins (matches Store.getPlantForLine); else the FIRST masterData
    // row for this line code (same result the O(1) index caches).
    const fromSettings = (lineSettings[line] || {}).plant;
    let result;
    if (fromSettings) {
      result = fromSettings;
    } else {
      const mdLine = (masterData?.lines ?? []).find(r => r.machine === line);
      result = mdLine?.plant ?? _taskPlantFallback?.get(line) ?? null;
    }
    if (_plantMemo) _plantMemo.set(line, result);
    return result;
  }

  // A missing line calendar is an INHERITED one (no machine row = follows the plant). With `allDay` (the line's
  // plant resolves) it is open all day, so workWindow's per-date plant intersection yields exactly the plant's
  // hours; without it the DEFAULT_SHIFT seed keeps the line bounded, since no plant intersection will happen.
  function ensureCalendar(line, calendars, allDay) {
    if (calendars[line]) return;
    const defaults = {};
    for (let d = 0; d < 7; d++) {
      defaults[d] = allDay ? [0, 24] : ((WEEKEND_OFF && (d === 0 || d === 6)) ? null : [...DEFAULT_SHIFT]);
    }
    calendars[line] = { workHours: defaults, inherited: true };
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

  // ---- Effective-dated plant calendar periods (twin of the Python helper; pinned by
  // tests/fixtures/plant_period_vectors.json). A period overrides the plant's default weekly hours for an
  // inclusive date range; validTo == null is open-ended. YYYY-MM-DD keys compare lexicographically.
  function activeWorkHours(defaultWorkHours, periods, dateKey) {
    if (!periods || !periods.length) return defaultWorkHours;   // same reference: the no-periods path is unchanged
    let best = null;
    for (const p of periods) {
      if (p.validFrom <= dateKey && (p.validTo == null || dateKey <= p.validTo) && (!best || p.validFrom < best.validFrom)) best = p;
    }
    return best ? best.workHours : defaultWorkHours;
  }

  function plantWorkHoursOn(plantEntry, date) {
    if (!plantEntry) return undefined;
    if (!plantEntry.periods || !plantEntry.periods.length) return plantEntry.workHours;
    return activeWorkHours(plantEntry.workHours, plantEntry.periods, dayKey(date));
  }

  // Day keys D with fromKey < D <= toKey on which the active pattern can change: each validFrom and the day
  // after each non-null validTo. Calendar-day increment (never +86_400_000).
  function periodBoundaryKeys(periods, fromKey, toKey) {
    const out = new Set();
    for (const p of periods || []) {
      const cands = [p.validFrom];
      if (p.validTo != null) {
        const [y, m, d] = p.validTo.split('-').map(Number);
        cands.push(dayKey(new Date(y, m - 1, d + 1)));
      }
      for (const k of cands) if (k > fromKey && k <= toKey) out.add(k);
    }
    return [...out].sort();
  }

  // Server rule: inclusive overlap (a shared day overlaps, adjacent is fine), null validTo = +infinity.
  function validatePlantPeriods(periods) {
    const list = periods || [];
    const invalidIds = [];
    const seen = new Set();
    for (const p of list) {
      if (!p || !p.id || seen.has(p.id)) { invalidIds.push(p && p.id ? p.id : ''); continue; }
      seen.add(p.id);
    }
    if (invalidIds.length) return { ok: false, code: 'period_invalid', ids: invalidIds };
    const badDates = list.filter(p => !p.validFrom || (p.validTo != null && p.validTo < p.validFrom)).map(p => p.id);
    if (badDates.length) return { ok: false, code: 'period_dates_invalid', ids: badDates };
    const sorted = [...list].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
    const overlapIds = new Set();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        // sorted by validFrom, so j starts no earlier than i: they overlap iff i is open-ended or reaches j's start
        if (sorted[i].validTo == null || sorted[j].validFrom <= sorted[i].validTo) {
          overlapIds.add(sorted[i].id); overlapIds.add(sorted[j].id);
        } else break;
      }
    }
    if (overlapIds.size) return { ok: false, code: 'period_overlap', ids: [...overlapIds] };
    return { ok: true };
  }

  function unionWeeklyHours(defaultWorkHours, periods) {
    const out = {};
    const patterns = [defaultWorkHours, ...(periods || []).map(p => p.workHours)];
    for (let d = 0; d < 7; d++) {
      let lo = null, hi = null;
      for (const wh of patterns) {
        const r = wh && wh[d];
        if (!r) continue;
        if (lo === null || r[0] < lo) lo = r[0];
        if (hi === null || r[1] > hi) hi = r[1];
      }
      out[d] = lo === null ? null : [lo, hi];
    }
    return out;
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

    const plant = getPlantForLine(line, lineSettings, masterData);
    ensureCalendar(line, calendars, !!plant);
    const lineWin = _dayWindow(calendars[line].workHours, date);
    if (!lineWin) {
      if (_wwCache) _wwCache.set(key, null);
      return null;
    }

    let result;
    if (plant) {
      ensurePlant(plant, plants);
      const plantWin = _dayWindow(plantWorkHoursOn(plants[plant], date), date);
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

  // THE day-attribution rule (OQ12/OQ41): which calendar days an order's work lands on, in minutes. The
  // utilization matrix, the overload alert and the cell briefing all read this one function, so they can never
  // disagree about the same order. `dayWindowFor(date)` -> {open, close} | null is the working window of that
  // calendar date (null when closed).
  //  - A split order (two or more explicit pieces) is attributed exactly: each piece's wall-clock overlap per day.
  //  - A single bar spreads its run time across the days it spans in proportion to each day's WORKING-time overlap
  //    with [start, end], so a bar that starts after one day's close puts nothing on that day and a closed day takes
  //    no share. A bar with no working overlap at all (an order sitting wholly in closed time) falls back to
  //    wall-clock overlap, so its hours stay visible and the closed-day alert can fire.
  //  - A start with no finish puts the whole run time on the start day.
  // Returns { [dayKey]: minutes }; days with no work are absent.
  function workingMinutesByDay(task, dayWindowFor) {
    const out = {};
    const add = (key, minutes) => { if (minutes > 0) out[key] = (out[key] || 0) + minutes; };
    const intervals = scheduleIntervals(task);
    if (intervals.length >= 2) {
      for (const interval of intervals) {
        let cursor = startOfDay(new Date(+interval.start));   // startOfDay mutates a Date argument
        while (cursor < interval.end) {
          const next = nextCalendarDay(cursor);
          add(dayKey(cursor), (Math.min(+interval.end, +next) - Math.max(+interval.start, +cursor)) / 60000);
          cursor = next;
        }
      }
      return out;
    }
    let start = parseDate(task?.start_date);
    const runMin = runHours(task) * 60;
    const end = parseDate(task?.end_date);
    // A finish-only row (end set, start null: a freshly distributed child before the reconcile derives its start)
    // is the bar [end - run_time, end] (U29), so it is visible to the matrix and the briefing before the derive.
    if (!start) {
      if (!end || runMin <= 0) return out;
      start = new Date(+end - runMin * 60000);
    }
    if (!end) { add(dayKey(start), runMin); return out; }
    if (end <= start || runMin <= 0) return out;
    const days = [];
    let working = 0, wall = 0;
    for (let cursor = startOfDay(new Date(+start)); cursor <= end; cursor = nextCalendarDay(cursor)) {
      const next = nextCalendarDay(cursor);
      const wallMin = Math.max(0, (Math.min(+end, +next) - Math.max(+start, +cursor)) / 60000);
      const win = dayWindowFor ? dayWindowFor(cursor) : null;
      const workMin = win && win.open && win.close
        ? Math.max(0, (Math.min(+end, +win.close) - Math.max(+start, +win.open)) / 60000) : 0;
      days.push({ key: dayKey(cursor), wallMin, workMin });
      working += workMin; wall += wallMin;
    }
    const weight = working > 0 ? d => d.workMin / working : (wall > 0 ? d => d.wallMin / wall : () => 0);
    for (const d of days) add(d.key, runMin * weight(d));
    return out;
  }

  // A date-only SAP finish reaches the browser as an exact-midnight timestamp (the server no
  // longer rewrites it). Read such a value as the end of that date's working window (OQ23).
  // `raw`: Date (naive plant wall-clock). `dayWindowFor(date)` -> {open, close} | null for that
  // calendar date. A timed raw is returned unchanged. For exact midnight: the close of that
  // date's window; a date with no window (closed day) resolves to the close of the latest open
  // date before it (looking back at most 30 days); no window at all -> raw + 23:59:59. A window
  // that closes at/after the next midnight (a 24:00 close, a 24/7 line) resolves to that exclusive
  // next-day 00:00 instant, i.e. the close of the day itself (R-I6): a bar ending exactly at the
  // close is on time (`end > due` is the lateness rule) and the backward anchor is the close.
  function dueDateInstant(raw, dayWindowFor) {
    if (!(raw instanceof Date) || isNaN(raw)) return raw;
    if (raw.getHours() !== 0 || raw.getMinutes() !== 0 || raw.getSeconds() !== 0 || raw.getMilliseconds() !== 0) return raw;
    const endOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 0);
    for (let back = 0; back <= 30; back++) {
      const day = new Date(raw.getFullYear(), raw.getMonth(), raw.getDate() - back);
      const win = dayWindowFor(day);
      if (!win || !win.close) continue;
      const cap = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 0, 0, 0);
      return win.close > cap ? cap : new Date(+win.close);
    }
    return endOfDay(raw);
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

  function computeAlerts({ tasks, blocks, plantBlocks, calendars, plants, lineSettings, masterData, dismissed, opts, setup, now, blockedPlants }) {
    const t0 = performance.now();

    const onlyLines = Array.isArray(opts?.lines) && opts.lines.length
      ? new Set(opts.lines) : null;

    // machine -> sap_workcenter, and sap_workcenter -> its policy row (distribution
    // separation rule 1c below). masterData is a plain SAP-shaped bag here, no
    // compile-time guarantee it actually carries `workcenters` — both loops no-op
    // harmlessly on older/incomplete snapshots.
    const machineToWorkcenter = new Map();
    for (const l of masterData?.lines ?? []) {
      if (l?.sap_workcenter) machineToWorkcenter.set(l.machine, l.sap_workcenter);
    }
    const workcenterPolicy = new Map();
    for (const wc of masterData?.workcenters ?? []) {
      if (wc?.sap_workcenter) workcenterPolicy.set(wc.sap_workcenter, wc);
    }

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
    _taskPlantFallback = _buildTaskPlantFallback(tasks);
    const plantOf = line => getPlantForLine(line, lineSettings, masterData);
    // The line's working window on a calendar date as {open, close} (the shape dueDateInstant and
    // workingMinutesByDay read), or null when closed. A line with NO calendar row sent in the payload has no
    // window at all (Util.dueInstant reads it the same way), so the late rule agrees with the Store-side KPIs.
    const inScopeLine = line => !onlyLines || onlyLines.has(line || 'Unknown');
    const calendarLines = new Set(Object.keys(calendars || {}));
    const dayWindowForLine = (line, requireRow = false) => date => {
      if (requireRow && !calendarLines.has(line)) return null;
      const win = workWindow(line, date, calendars, plants, lineSettings, masterData);
      return win ? { open: win[0], close: win[1] } : null;
    };
    const setupActiveForLine = line => masterData?.plants?.find(p => p.plant === plantOf(line))?.setup_active !== false;

    const alerts = [];
    const taskById = new Map(tasks.map(task => [String(task.id), task]));
    const orderNumber = task => {
      const order = String(task?.ORDER ?? '').trim() || String(task?.PRODUCTION_ORDER ?? '').trim();
      return order || 'order number unavailable';
    };
    const orderNumberForId = id => orderNumber(id == null ? undefined : taskById.get(String(id)));
    // One clock (OQ52): "today" is the start of the day in the ORDER'S plant, read from the per-plant
    // wall-clock `now` the caller supplies (the server instant in the plant zone), not this thread's
    // Date.now(). A plant with no entry (no valid timezone, or a caller that sends none) keeps the
    // thread's clock, as before.
    const fallbackToday = startOfDay(new Date());
    const todayByPlant = new Map();
    const todayStartFor = task => {
      const plant = task?.PLANT || plantOf(task?.MACHINE || 'Unknown');
      const at = plant != null && now ? now[plant] : null;
      if (!at) return fallbackToday;
      let day = todayByPlant.get(plant);
      if (!day) todayByPlant.set(plant, day = startOfDay(at instanceof Date ? new Date(+at) : at) || fallbackToday);
      return day;
    };
    // task.start_date / end_date are proper Dates (structured-clone preserves them).
    let activeTasks = tasks.filter(t => !t.end_date || t.end_date >= todayStartFor(t));
    if (onlyLines) activeTasks = activeTasks.filter(t => onlyLines.has(t.MACHINE || 'Unknown'));

    /* 1. OVERLAPS */
    const byLine = {};
    for (const t of activeTasks) {
      const line = t.MACHINE || 'Unknown';
      for (const interval of scheduleIntervals(t)) {
        (byLine[line] ||= []).push({ task: t, start: interval.start, end: interval.end });
      }
    }
    for (const line of Object.keys(byLine)) {
      const arr = byLine[line].slice().sort((a, b) => a.start - b.start);
      // Keep the two longest-ending distinct orders. An interval can be
      // nested inside an earlier one, and multiple segments can share an id.
      let longest = null;
      let secondLongest = null;
      for (const cur of arr) {
        const prev = longest?.task.id === cur.task.id ? secondLongest : longest;
        if (prev && cur.start < prev.end) {
          alerts.push({
            id:  `ovl-${prev.task.id}-${cur.task.id}`,
            sev: 'err', type: 'overlap',
            msg: `Orders "${orderNumber(prev.task)}" and "${orderNumber(cur.task)}" overlap on ${line}.`,
            taskId: cur.task.id, peerId: prev.task.id, line, time: cur.start
          });
        }
        if (longest?.task.id === cur.task.id) {
          if (cur.end > longest.end) longest = cur;
        } else if (secondLongest?.task.id === cur.task.id) {
          if (cur.end > secondLongest.end) secondLongest = cur;
          if (secondLongest.end > longest.end) [longest, secondLongest] = [secondLongest, longest];
        } else if (!longest || cur.end > longest.end) {
          secondLongest = longest;
          longest = cur;
        } else if (!secondLongest || cur.end > secondLongest.end) {
          secondLongest = cur;
        }
      }
    }

    /* 1b. TOOL CONFLICT - count-aware. A tool id is a TYPE and the plant owns several copies
       (masterData.tool_inventory; a missing row = 1 copy). The alert fires on the order whose start
       takes the number of DISTINCT MACHINES using the tool above the available copies (the "pusher"),
       one alert per pusher, so a 3-way overlap on a 1-copy tool is now 2 alerts (one per pusher), not 3
       pair alerts. Occupancy = first segment start to last segment end (a split order keeps its tool
       across the gap), run time only; PRT_01 and PRT_02 share one id pool. Same-line adjacency is a
       changeover (rule 1), not a conflict. Ids: exactly two orders keeps the legacy 'toolc-<prev>|<cur>'
       (acks survive); a third holder flips it to 'toolc-<pusher>|<tool>' (ack lost), and acks orphan
       when capacity rises. The peer pool is horizon-filtered but NOT line-filtered: an incremental
       recompute for L1 must still see the peer on L2. The alert is emitted only when the pusher's line
       is in scope. All the logic is the shared pure API above (also read by the optimizer). */
    const toolCapacity = buildToolCapacity(masterData);
    const toolItems = [];
    for (const t of tasks) {
      if (t.end_date && t.end_date < todayStartFor(t)) continue;
      const tools = taskToolIds(t);
      if (!tools.length) continue;
      const occ = toolOccupancyInterval(t);
      if (!occ) continue;
      toolItems.push({ id: t.id, line: t.MACHINE || 'Unknown', plant: taskToolPlant(t, plantOf), tools, start: occ.start, end: occ.end });
    }
    const toolAlertIds = new Set();
    const MAX_HOLDERS_SHOWN = 3;
    for (const c of findToolOverages({ items: toolItems, capacityFor: (plant, tool) => availableCopies(toolCapacity, plant, tool) })) {
      if (onlyLines && !onlyLines.has(c.pusherLine)) continue;
      const holderIds = [];
      for (const h of c.holders) if (!holderIds.includes(h.id)) holderIds.push(h.id);
      const shown = c.holders.slice(0, MAX_HOLDERS_SHOWN).map(h => `${orderNumberForId(h.id)} (${h.line})`);
      const holdersText = shown.join(', ') + (c.holders.length > MAX_HOLDERS_SHOWN ? ` +${c.holders.length - MAX_HOLDERS_SHOWN}` : '');
      const vars = { tool: c.tool, available: c.available, inUse: c.inUse, holders: holdersText };
      const pusherNo = orderNumberForId(c.pusher);
      let msgKey, msg;
      if (c.available === 0) {
        msgKey = 'alert.tool_conflict_zero';
        msg = `Tool "${c.tool}" has no copies available but "${pusherNo}" on ${c.pusherLine} needs it${holdersText ? ` (also needed by ${holdersText})` : ''}.`;
      } else if (!c.hasRow) {
        msgKey = 'alert.tool_conflict_no_row';
        msg = `Tool "${c.tool}" has no inventory row (treated as 1 copy) but ${c.inUse} machines need it at the same time: "${pusherNo}" on ${c.pusherLine} and ${holdersText}.`;
      } else {
        msgKey = 'alert.tool_conflict';
        msg = `Tool "${c.tool}" has ${c.available} available but ${c.inUse} are in use at the same time: "${pusherNo}" on ${c.pusherLine} and ${holdersText}.`;
      }
      alerts.push({
        id: toolConflictAlertId(c, toolAlertIds), sev: 'err', type: 'tool-conflict',
        msg, msgKey, msgVars: vars,
        taskId: c.pusher, peerId: holderIds[0], peerIds: holderIds, line: c.pusherLine, time: c.at,
        tool: c.tool, available: c.available, inUse: c.inUse, hasRow: c.hasRow,
      });
    }

    /* D50 severity note: this ALERT is sev 'err' (it is a red, planner-must-fix item).
       The optimizer's matching `distribution_separation` validation finding
       (setup-scheduler.mts checkDistributionSeparation) is deliberately 'warning': a
       validation 'error' blocks Apply, and the optimizer cannot always repair a
       separation it did not create. Same condition, two severity scales - keep both.
    1c. DISTRIBUTION SEPARATION — siblings of a SAP-distributed order share a
       PARENT_ORDER; a per-work-center policy (max_separation: 'hour'|'day'|'week')
       caps how far apart their scheduled FINISHES may drift (backward scheduling OQ38: the siblings share
       the finish, so a 70/30 family that finishes together raises nothing even though the long child starts
       earlier). Hand-mirrored by setup-scheduler.mts checkDistributionSeparation - keep the two in step. Grouped by
       (plant, PARENT_ORDER, MATERIAL_NUMBER) so an unlikely parent-order-number
       collision across two different materials never conflates two distinct
       distributions. Queued (needs_planning) siblings have no dates yet and are
       excluded from both the group's policy resolution and its date comparison. */
    const distGroups = new Map();
    for (const t of tasks) {
      if (!t.PARENT_ORDER) continue;
      if (t.planning_status === 'needs_planning') continue;
      const plant = plantOf(t.MACHINE || 'Unknown');
      const material = t.MATERIAL_NUMBER ?? '';
      const key = JSON.stringify([plant, t.PARENT_ORDER, material]);
      let g = distGroups.get(key);
      if (!g) distGroups.set(key, g = { plant, parent: t.PARENT_ORDER, material, tasks: [] });
      g.tasks.push(t);
    }
    for (const g of distGroups.values()) {
      if (g.tasks.length < 2) continue;
      let maxSeparation = null;
      for (const t of g.tasks) {
        const wc = machineToWorkcenter.get(t.MACHINE || 'Unknown');
        const policy = wc ? workcenterPolicy.get(wc) : null;
        if (policy?.max_separation) { maxSeparation = policy.max_separation; break; }
      }
      if (!maxSeparation || maxSeparation === 'none') continue;
      const dated = g.tasks.filter(t => t.end_date);
      if (dated.length < 2) continue;
      const buckets = new Set(dated.map(t => separationBucketKey(t.end_date, maxSeparation)));
      if (buckets.size <= 1) continue;
      const sortedDated = dated.slice().sort((a, b) => a.end_date.getTime() - b.end_date.getTime());
      const earliest = sortedDated[0];
      const earliestLine = earliest.MACHINE || 'Unknown';
      // Mirrors the tool-conflict rule's own onlyLines gate above: the peer pool
      // is horizon/plant-wide, but an incremental recompute only emits the alert
      // when the line it attaches to (the earliest sibling's) is in scope.
      if (onlyLines && !onlyLines.has(earliestLine)) continue;
      const vars = { parent: g.parent, scope: maxSeparation };
      alerts.push({
        id: `dist-sep:${g.plant ?? ''}:${g.parent}:${g.material}`,
        sev: 'err', type: 'distribution-separation',
        msg: `Sub-orders of "${g.parent}" finish in different ${maxSeparation}s.`,
        msgKey: 'alert.distribution_separation', msgVars: vars,
        taskId: earliest.id, line: earliestLine, time: earliest.start_date || earliest.end_date,
      });
    }

    /* 2. OVERLOAD / CLOSED */
    const byLineDay = {};
    // One attribution rule (workingMinutesByDay): the same days and hours the utilization matrix and the cell
    // briefing use, so the overload alert can never contradict the heatmap for one order.
    for (const t of activeTasks) {
      const line = t.MACHINE || 'Unknown';
      const windowFor = dayWindowForLine(line);
      for (const [day, minutes] of Object.entries(workingMinutesByDay(t, windowFor))) {
        const row = (byLineDay[`${line}|${day}`] ||= { line, day, hours: 0, tasks: [] });
        row.hours += minutes / 60;
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
    // Bucket parsedBlocks by line (with globalLine fallback) and parsedPlantBlocks by plant
    // (with globalPlant fallback) once, up front, so lookups are O(1) per task instead of O(all blocks).
    const _blackoutLineBlocks = new Map(), _blackoutGlobalLine = [];
    for (const b of parsedBlocks) {
      const rec = { s: b.s, e: b.e, plant: b.plant || null };
      if (b.line) { let a = _blackoutLineBlocks.get(b.line); if (!a) _blackoutLineBlocks.set(b.line, a = []); a.push(rec); }
      else _blackoutGlobalLine.push(rec);
    }
    const _blackoutPlantBlocks = new Map(), _blackoutGlobalPlant = [];
    for (const b of parsedPlantBlocks) {
      if (b.plant) { let a = _blackoutPlantBlocks.get(b.plant); if (!a) _blackoutPlantBlocks.set(b.plant, a = []); a.push({ s: b.s, e: b.e }); }
      else _blackoutGlobalPlant.push({ s: b.s, e: b.e });
    }
    for (const t of activeTasks) {
      const line  = t.MACHINE || 'Unknown';
      const plant = plantOf(line);
      let conflict = false;
      let conflictTime = t.start_date;
      for (const interval of scheduleIntervals(t)) {
        // Check line-specific blocks for this line, scoped by plant
        const lineBlocksForLine = _blackoutLineBlocks.get(line);
        if (lineBlocksForLine) {
          for (const b of lineBlocksForLine) {
            if (b.plant && b.plant !== plant) continue;
            if (interval.start < b.e && interval.end > b.s) {
              conflict = true; conflictTime = interval.start; break;
            }
          }
        }
        if (!conflict) {
          // Check global line blocks, scoped by plant
          for (const b of _blackoutGlobalLine) {
            if (b.plant && b.plant !== plant) continue;
            if (interval.start < b.e && interval.end > b.s) {
              conflict = true; conflictTime = interval.start; break;
            }
          }
        }
        if (!conflict) {
          // Check plant blocks for this plant
          const plantBlocksForPlant = _blackoutPlantBlocks.get(plant);
          if (plantBlocksForPlant) {
            for (const b of plantBlocksForPlant) {
              if (interval.start < b.e && interval.end > b.s) {
                conflict = true; conflictTime = interval.start; break;
              }
            }
          }
        }
        if (!conflict) {
          // Check global plant blocks
          for (const b of _blackoutGlobalPlant) {
            if (interval.start < b.e && interval.end > b.s) {
              conflict = true; conflictTime = interval.start; break;
            }
          }
        }
        if (conflict) break;
      }
      if (conflict) {
        alerts.push({
          id:  `blk-${t.id}`, sev: 'err', type: 'blackout',
          msg: `Order "${orderNumber(t)}" overlaps a blackout block on ${line}.`,
          taskId: t.id, line, time: conflictTime
        });
      }
    }

    /* 4. FIRMED-BUT-ON-CLOSED-DAY */
    for (const t of activeTasks) {
      const line = t.MACHINE || 'Unknown';
      const badInterval = scheduleIntervals(t).find(interval =>
        !workWindow(line, interval.start, calendars, plants, lineSettings, masterData));
      if (badInterval) {
        alerts.push({
          id:  `firmclosed-${t.id}`, sev: 'warn', type: 'firmed-closed',
          msg: `${t.firmed ? 'Firmed order' : 'Order'} "${orderNumber(t)}" is on a day the ${line} calendar is closed.`,
          taskId: t.id, line, time: badInterval.start
        });
      }
    }

    /* 5. FIRMED-OUT-OF-HOURS */
    for (const t of activeTasks) {
      const line = t.MACHINE || 'Unknown';
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
          id:  `firmhours-${t.id}`, sev: 'warn', type: 'firmed-out-of-hours',
          msg: `${t.firmed ? 'Firmed order' : 'Order'} "${orderNumber(t)}" ${parts.join(' and ')}.`,
          taskId: t.id, line, time: alertTime
        });
      }
    }

    // A runtime/schedule mismatch is an authoritative schedule-integrity
    // exception, not a horizon-only capacity signal. It must remain visible
    // after its prior envelope moves into the past, until an aggregate repair
    // succeeds (while respecting an incremental line scope when supplied).
    const mismatchTasks = onlyLines
      ? tasks.filter(t => onlyLines.has(t.MACHINE || 'Unknown'))
      : tasks;
    for (const t of mismatchTasks) {
      if (!t.runtime_schedule_mismatch) continue;
      const line = t.MACHINE || 'Unknown';
      alerts.push({
        id: `runtime-mismatch-${t.id}`, sev: 'err', type: 'runtime-schedule-mismatch',
        msg: `The start of order "${orderNumber(t)}" may be out of date: its run time changed after the schedule was saved.`,
        msgKey: 'alert.start_may_be_stale', msgVars: { order: orderNumber(t) },
        taskId: t.id, line, time: t.start_date || new Date(),
      });
    }

    /* LATE (OQ6) - the placed finish is after the due instant. Data-only: it needs no clock, so it is fresh on
       every store event. Warning for any positive lateness; error when the finish is also beyond the plant's
       push-forward ceiling (the due date's local midnight + N + 1 days, the same ceiling the optimizer honours).
       A queued order has no placed finish and gets none (its lateness shows through Util.latenessHours). The due
       instant is the SAP finish as received, a date-only one read as the close of that day's window. */
    const pushCapDays = plant => {
      const value = masterData?.plants?.find(row => row.plant === plant)?.max_push_forward_days;
      return Number.isInteger(value) && value >= 0 ? value : null;
    };
    // Is a placed finish beyond the plant's push-forward ceiling? A due on a 24:00 close is the exclusive next-day
    // 00:00: the due DAY is the one before it (R-I6). Shared by the late alert and the reversal_forward severity (D9b).
    const beyondPushCap = (t, end, due) => {
      const cap = pushCapDays(t.PLANT || plantOf(t.MACHINE || 'Unknown'));
      if (cap === null || !end || !due) return false;
      const ceiling = new Date(+due - 1); ceiling.setHours(0, 0, 0, 0); ceiling.setDate(ceiling.getDate() + cap + 1);
      return end > ceiling;
    };
    for (const t of activeTasks) {
      if (t.planning_status === 'needs_planning') continue;
      const end = parseDate(t.end_date), rawDue = parseDate(t.original_end_date);
      if (!end || !rawDue) continue;
      const line = t.MACHINE || 'Unknown';
      // D14: a line with no row of its own reads the default window, so a date-only due resolves instead of staying silent.
      const due = dueDateInstant(rawDue, dayWindowForLine(line, false));
      if (!(end > due)) continue;
      const hours = (end - due) / MS_HOUR;
      const cap = pushCapDays(t.PLANT || plantOf(line));
      const beyondCap = beyondPushCap(t, end, due);
      const vars = { order: orderNumber(t), hours: hours.toFixed(1), days: cap ?? '' };
      alerts.push({
        id: `late-${t.id}`, sev: beyondCap ? 'err' : 'warn', type: 'late',
        msg: beyondCap
          ? `Order "${vars.order}" finishes ${vars.hours} h after its due date, beyond the plant limit of ${cap} day(s) late.`
          : `Order "${vars.order}" finishes ${vars.hours} h after its due date.`,
        msgKey: beyondCap ? 'alert.late_beyond_cap' : 'alert.late', msgVars: vars,
        taskId: t.id, line, time: end,
      });
    }

    /* PLACEMENT EXCEPTION - the marker the server stores when an order was placed outside the normal rules
       (overtime or overlong). One alert per marked order. */
    const PLACEMENT_KEYS = { overtime: 'alert.placement_exception_overtime', overlong: 'alert.placement_exception_overlong' };
    for (const t of activeTasks) {
      const marker = t.placement_exception;
      if (marker !== 'overtime' && marker !== 'overlong') continue;
      const line = t.MACHINE || 'Unknown';
      const vars = { order: orderNumber(t), line };
      alerts.push({
        id: `placement-exception-${t.id}`, sev: 'warn',   // D20 (VM14): approved by the planner; visible, not blocking
        type: 'placement_exception',
        msg: marker === 'overtime'
          ? `Order "${vars.order}" is placed outside working hours on ${line}.`
          : `Order "${vars.order}" is longer than any working window on ${line} and is placed as one long bar.`,
        msgKey: PLACEMENT_KEYS[marker], msgVars: vars,
        taskId: t.id, line, time: parseDate(t.start_date) || parseDate(t.end_date) || new Date(),
      });
    }

    /* ENGINE FINDINGS - every note the schedule engine leaves on a task (task.derivationIssue, session-only) is
       rendered here, in the same pass as every other alert, so nothing is computed on the main thread. Keyed by
       task id + code so a re-render replaces rather than accumulates. Plant-level findings (no time zone) and
       line-level ones (no server calendar) are de-duplicated to ONE alert per plant / per line; a plant alert sits
       on the plant's first affected line (stable across incremental runs) and is emitted when that line is in
       scope. An unknown code still renders a generic alert. */
    const ISSUE_SEV_ERR = new Set(['plant_no_timezone', 'line_no_calendar', 'no_anchor']);   // D9b: reversal_forward is 'err' only beyond the push cap (below)
    const readable = d => { const v = parseDate(d); return v ? fmtDTReadable(v) : ''; };
    const plantFirstLine = new Map();   // plant -> smallest affected line (all tasks, scope-independent)
    const noteFirstLine = (plant, line) => {
      if (plant == null) return;
      const cur = plantFirstLine.get(plant);
      if (cur === undefined || line < cur) plantFirstLine.set(plant, line);
    };
    for (const t of tasks) {
      if (t.derivationIssue?.code === 'plant_no_timezone') noteFirstLine(t.PLANT || plantOf(t.MACHINE || 'Unknown'), t.MACHINE || 'Unknown');
    }
    const blockedSet = new Set(Array.isArray(blockedPlants) ? blockedPlants : []);
    for (const plant of blockedSet) {
      let first;
      for (const l of masterData?.lines ?? []) if (l?.plant === plant && l.machine && (first === undefined || l.machine < first)) first = l.machine;
      if (first !== undefined) noteFirstLine(plant, first);
    }
    const emittedPlants = new Set();
    const emitPlantNoTimezone = plant => {
      const line = plantFirstLine.get(plant);
      if (plant == null || line === undefined || emittedPlants.has(plant) || !inScopeLine(line)) return;
      emittedPlants.add(plant);
      alerts.push({
        id: `plant-no-timezone-${plant}`, sev: 'err', type: 'plant_no_timezone',
        msg: `Plant ${plant} has no valid time zone, so NIMBUS cannot derive start times for its orders.`,
        msgKey: 'alert.plant_no_timezone', msgVars: { plant },
        line, time: now?.[plant] || new Date(),
      });
    };
    for (const t of tasks) {
      const issue = t.derivationIssue;
      if (!issue || !issue.code) continue;
      const line = t.MACHINE || 'Unknown';
      const plant = t.PLANT || plantOf(line);
      const code = issue.code;
      if (code === 'plant_no_timezone') { emitPlantNoTimezone(plant); continue; }
      if (!inScopeLine(line)) continue;
      // D14: line_no_calendar is no longer emitted (a line without its own row reads the default window).
      const order = orderNumber(t);
      const vars = { order, line, from: readable(issue.from), to: readable(issue.to) };
      let key = `alert.${code}`, type = code, msg;
      let sev = ISSUE_SEV_ERR.has(code) ? 'err' : 'warn';
      switch (code) {
        case 'finish_moved_earlier':
          msg = `Order "${order}" could not hold its finish and now ends earlier, at ${vars.to} (was ${vars.from}).`; break;
        case 'reversal_forward': {
          const detail = issue.detail;
          if (beyondPushCap(t, parseDate(t.end_date), dueDateInstant(parseDate(t.original_end_date), dayWindowForLine(line, false)))) sev = 'err';
          if (detail === 'run_time_grew' || detail === 'due_date_past' || detail === 'cutover') key = `alert.reversal_forward_${detail}`;
          msg = detail === 'run_time_grew'
            ? `Order "${order}" was placed forward from now because its run time grew and its start would fall in the past.`
            : detail === 'cutover'
              ? `Order "${order}" was placed forward from now when scheduling switched to the finish date, because its start would fall in the past.`
              : detail === 'due_date_past'
                ? `Order "${order}" was placed forward from now because its due date has already passed; it will finish late.`
                : `Order "${order}" was placed forward from now because its start would fall in the past; it will finish after its held finish.`;
          break;
        }
        case 'no_anchor': msg = `Order "${order}" has no finish date to schedule from.`; break;
        case 'no_operating_window': msg = `Order "${order}" could not be placed: no working window was found for ${line} in the next 90 days.`; break;
        case 'run_time_zero': msg = `Order "${order}" has no run time, so it has no bar to place.`; break;
        case 'setup_override_orphaned': msg = `A manual changeover override for order "${order}" on ${line} no longer matches the order before it.`; break;
        case 'pull_floor_crossed': msg = `Order "${order}" now starts ${vars.from}, before the earliest start the plant allows (${vars.to}).`; break;
        case 'frozen_window_crossed': msg = `Order "${order}" now starts inside the frozen window.`; break;
        default:
          type = 'derivation_issue'; key = 'alert.derivation_issue'; vars.code = String(code);
          msg = `Order "${order}" has a scheduling note (${code}).`;
      }
      alerts.push({
        id: `derivation-${t.id}-${code}`, sev, type, msg, msgKey: key, msgVars: vars,
        taskId: t.id, line, time: parseDate(t.start_date) || parseDate(t.end_date) || now?.[plant] || new Date(),
      });
    }
    // A plant announced as blocked by the clock (Store.plantNow) alerts even when none of its orders carry a note.
    for (const plant of blockedSet) emitPlantNoTimezone(plant);

    // RUNTIME-UNKNOWN (ROUTING_RUNTIME_DESIGN.md §8.6) — a task held in Needs
    // Planning specifically because the routing resolver (backend/routing/resolver.py
    // §5.2) couldn't determine a run time, distinguished from any OTHER
    // needs_planning reason by planning_reason.code. One alert per affected
    // task; the message is the resolver's own already-i18n'd text
    // (planning_reason.message) — never re-translated or re-worded here.
    const runtimeUnknownTasks = onlyLines
      ? tasks.filter(t => onlyLines.has(t.MACHINE || 'Unknown'))
      : tasks;
    for (const t of runtimeUnknownTasks) {
      const reason = t.planning_reason;
      if (t.planning_status !== 'needs_planning' || !reason || reason.code !== 'runtime_unknown') continue;
      const line = t.MACHINE || 'Unknown';
      alerts.push({
        id: `runtime-unknown-${t.id}`, sev: 'err', type: 'runtime-unknown',
        msg: reason.message || `Order "${orderNumber(t)}" runtime could not be resolved (step: ${reason.step}).`,
        taskId: t.id, line, time: t.start_date || new Date(),
      });
    }

    // PV-LOT-SIZE (ROUTING_RUNTIME_DESIGN.md §5.2 "Lot size" / §8.6) — a
    // resolved order whose order_quantity fell outside the resolved production
    // version's lot-size range. Warning only: resolver.py still resolves and
    // schedules the order normally (run_time_basis.lot_size_warning), it's
    // never a hold and never affects placement.
    const lotSizeTasks = onlyLines
      ? tasks.filter(t => onlyLines.has(t.MACHINE || 'Unknown'))
      : tasks;
    for (const t of lotSizeTasks) {
      if (!t.run_time_basis || !t.run_time_basis.lot_size_warning) continue;
      const line = t.MACHINE || 'Unknown';
      alerts.push({
        id: `pv-lot-size-${t.id}`, sev: 'warn', type: 'pv-lot-size',
        msg: `Order "${orderNumber(t)}" quantity is outside the resolved production version's lot-size range.`,
        taskId: t.id, line, time: t.start_date || new Date(),
      });
    }

    // Setup observations are intentionally supplied by the caller after its
    // one plant-scoped resolution pass.  Alerting validates/reporting only;
    // it does not read a matrix, change Store, or start an optimizer run.
    const SETUP_FIELD_LABELS = { colorWheel: 'Color', prt01: 'PRT01', prt02: 'PRT02', productionVersion: 'Production Version' };
    const formatSetupState = raw => {
      if (raw === 'unknown') return 'an unrecorded state';
      try {
        const pairs = JSON.parse(raw);
        if (!Array.isArray(pairs) || !pairs.length) return 'an unrecorded state';
        return pairs.map(([k, v]) => `${SETUP_FIELD_LABELS[k] || k} ${v}`).join(', ');
      } catch { return 'an unrecorded state'; }
    };
    const formatSetupPairKey = pairKey => {
      // The left half is either 'unknown' or a JSON array (e.g. [["colorWheel","X"]]).
      // For JSON arrays, the split delimiter is ']->': the outer closing bracket
      // immediately followed by '->'. Using indexOf(']') alone finds the inner ']'
      // first and misses the boundary for nested arrays.
      if (pairKey.startsWith('unknown->')) {
        return `${formatSetupState('unknown')} → ${formatSetupState(pairKey.slice(9))}`;
      }
      const splitIdx = pairKey.indexOf(']->')
      if (splitIdx < 0) return pairKey;
      return `${formatSetupState(pairKey.slice(0, splitIdx + 1))} → ${formatSetupState(pairKey.slice(splitIdx + 3))}`;
    };
    const setupSeen = new Set();
    const inScope = line => !onlyLines || onlyLines.has(line || 'Unknown');
    const setupKey = (type, entry, pairKey = '') => [
      type, entry.scope || entry.line || 'Unknown', pairKey || entry.pairKey || '',
      entry.predecessorOrderId ?? 'initial', entry.successorOrderId ?? '',
    ].join('|');
    for (const interval of setupIntervals(setup)) {
      // Setup is off for the plant: the observation still computes, but no setup alert is raised.
      if (!inScope(interval.line) || !setupActiveForLine(interval.line)) continue;
      const requiredMinutes = Number(interval.requiredMinutes);
      const availableMinutes = Number(interval.availableMinutes);
      if (!Number.isFinite(requiredMinutes) || !Number.isFinite(availableMinutes) || requiredMinutes <= availableMinutes) continue;
      const key = setupKey('setup-violated', interval);
      if (setupSeen.has(key)) continue;
      setupSeen.add(key);
      const shortMinutes = requiredMinutes - availableMinutes;
      alerts.push({
        id: `setup-violated-${key}`, sev: 'err', type: 'setup-violated',
        msg: `Not enough changeover time before order "${orderNumberForId(interval.successorOrderId)}" on ${interval.line}: needs ${requiredMinutes} min, only ${availableMinutes} min available (${shortMinutes} min short).`,
        msgKey: 'alert.setup_violated',
        msgVars: { order: orderNumberForId(interval.successorOrderId), line: interval.line, required: requiredMinutes, available: availableMinutes, short: shortMinutes },
        taskId: interval.successorOrderId, line: interval.line, time: interval.start,
        requiredMinutes, availableMinutes, shortMinutes,
      });
    }
    const diagnosticTypes = new Set([
      'setup-uncovered', 'initial-state-unknown', 'current-state-diverged', 'override-inactive',
      'predecessor-state-unknown', 'successor-state-unknown',
    ]);
    const SETUP_DIAGNOSTIC_SEVERITY = {
      'initial-state-unknown': 'warn', 'override-inactive': 'warn', 'current-state-diverged': 'warn',
      'setup-uncovered': 'err', 'predecessor-state-unknown': 'err', 'successor-state-unknown': 'err',
    };
    const SETUP_DIAGNOSTIC_DEFAULT_MSG = {
      'initial-state-unknown': d => `Can't determine what needs to be set up before order ${orderNumberForId(d.successorOrderId)} on ${d.line}.`,
      'override-inactive': d => `A manual changeover override on ${d.line} no longer matches the current schedule.`,
      'current-state-diverged': d => `The recorded changeover state on ${d.line} doesn't match what order ${orderNumberForId(d.successorOrderId)} expected.`,
      'setup-uncovered': (d, pair) => `No changeover time defined${pair} on ${d.line}. Add a setup rule or a default by value.`,
      'predecessor-state-unknown': d => `Order ${orderNumberForId(d.predecessorOrderId)} on ${d.line} is missing attributes needed to calculate the changeover before ${orderNumberForId(d.successorOrderId)}.`,
      'successor-state-unknown': d => `Order ${orderNumberForId(d.successorOrderId)} on ${d.line} is missing attributes needed to calculate its changeover.`,
    };
    const setupDiagnostics = Array.isArray(setup?.diagnostics) ? setup.diagnostics : [];
    for (const diagnostic of setupDiagnostics) {
      if (!diagnosticTypes.has(diagnostic?.type) || !inScope(diagnostic.line) || !setupActiveForLine(diagnostic.line)) continue;
      // A missing matrix transition is a pair/scope problem, not one alert per
      // order occurrence. Other diagnostics remain occurrence-specific.
      const key = diagnostic.type === 'setup-uncovered'
        ? [diagnostic.type, diagnostic.scope || diagnostic.line || 'Unknown', diagnostic.pairKey || 'unknown'].join('|')
        : setupKey(diagnostic.type, diagnostic);
      if (setupSeen.has(key)) continue;
      setupSeen.add(key);
      const time = parseDate(diagnostic.time) || new Date();
      const pair = diagnostic.pairKey ? ` for ${formatSetupPairKey(diagnostic.pairKey)}` : '';
      const defaultMsg = SETUP_DIAGNOSTIC_DEFAULT_MSG[diagnostic.type];
      const sev = SETUP_DIAGNOSTIC_SEVERITY[diagnostic.type] || 'err';
      alerts.push({
        id: `${diagnostic.type}-${key}`, sev, type: diagnostic.type,
        msg: diagnostic.message || (defaultMsg ? defaultMsg(diagnostic, pair) : `Setup ${diagnostic.type.replaceAll('-', ' ')}${pair} on ${diagnostic.line}.`),
        taskId: diagnostic.successorOrderId, line: diagnostic.line, time,
        pairKey: diagnostic.pairKey ?? null, scope: diagnostic.scope ?? null,
      });
    }

    _wwCache = null;
    _plantMemo = null;
    _taskPlantFallback = null;

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
    _taskPlantFallback = _buildTaskPlantFallback(tasks);

    let lines;
    if (Array.isArray(explicitLines)) {
      lines = new Set(explicitLines);
    } else {
      lines = new Set(tasks.map(t => t.MACHINE || 'Unknown'));
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

    // One attribution rule (workingMinutesByDay), shared with the overload alert and the cell briefing.
    for (const t of tasks) {
      if (!t.start_date && !t.end_date) continue;   // VM12: a finish-only row is the bar [end - run time, end]
      const line = t.MACHINE || 'Unknown';
      const lineRows = matrix[line];
      if (!lineRows) continue;
      const windowFor = date => {
        const win = workWindow(line, date, calendars, plants, lineSettings, masterData);
        return win ? { open: win[0], close: win[1] } : null;
      };
      for (const [key, minutes] of Object.entries(workingMinutesByDay(t, windowFor))) {
        const row = lineRows[key];
        if (!row) continue;
        row.scheduled += minutes / 60;
        if (!row.tasks.includes(t.id)) row.tasks.push(t.id);
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
      // Optimize: only iterate days this interval actually spans, not all days in the horizon.
      const dayStart = startOfDay(new Date(intervalStartMs));
      const dayEnd = startOfDay(new Date(intervalEndMs));
      let currentDay = new Date(dayStart);
      while (currentDay <= dayEnd) {
        const key = dayKey(currentDay);
        const row = lineRows[key];
        if (row) {
          const dayStartMs = row.date.getTime();
          const dayEndMs = nextCalendarDay(row.date).getTime();
          const contribution = (Math.min(intervalEndMs, dayEndMs) - Math.max(intervalStartMs, dayStartMs)) / MS_HOUR;
          if (contribution > 0) {
            row.scheduled += contribution;
            if (interval.successorOrderId && !row.tasks.includes(interval.successorOrderId)) row.tasks.push(interval.successorOrderId);
          }
        }
        currentDay = nextCalendarDay(currentDay);
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
    _taskPlantFallback = null;
    return { matrix };
  }

  // ── Schedule Confidence formula (single source for the badge and the Alert Monitor) ──
  const CONFIDENCE_WEIGHTS = Object.freeze({ err: 5, warn: 2, tw3: 1.5, tw7: 1.25, alertCap: 50, utilCap: 20, perOverload: 1.5 });

  // Days-out from the horizon start -> multiplier (imminent = more costly).
  function timeWeight(time, horizonStart) {
    if (!time) return 1.0;
    const d = (time - horizonStart) / 86400000;
    return d <= 3 ? CONFIDENCE_WEIGHTS.tw3 : d <= 7 ? CONFIDENCE_WEIGHTS.tw7 : 1.0;
  }

  // Uncapped impact points of one alert (0 outside [horizonStart, horizonEnd)).
  function alertPoints(alert, horizonStart, horizonEnd) {
    if (!alert.time || alert.time < horizonStart || alert.time >= horizonEnd) return 0;
    const base = alert.sev === 'err' ? CONFIDENCE_WEIGHTS.err : alert.sev === 'warn' ? CONFIDENCE_WEIGHTS.warn : 0;
    return base * timeWeight(alert.time, horizonStart);
  }

  function countOverloadedLineDays(matrix) {
    let n = 0;
    Object.values(matrix || {}).forEach(lineData => {
      Object.values(lineData).forEach(row => {
        if (row.effectiveCapacity > 0 && row.scheduled > row.effectiveCapacity) n++;
      });
    });
    return n;
  }

  function scoreConfidence({ alerts, matrix, overloadedLineDays, horizonStart, horizonMinutes }) {
    const horizonEnd = new Date(horizonStart.getTime() + horizonMinutes * 60000);
    let rawAlertPoints = 0;
    (alerts || []).forEach(a => { rawAlertPoints += alertPoints(a, horizonStart, horizonEnd); });
    const alertPenalty = Math.min(CONFIDENCE_WEIGHTS.alertCap, Math.round(rawAlertPoints));
    const lineDays = overloadedLineDays != null ? overloadedLineDays : countOverloadedLineDays(matrix);
    const utilPenalty = Math.min(CONFIDENCE_WEIGHTS.utilCap, Math.round(CONFIDENCE_WEIGHTS.perOverload * lineDays));
    const score = Math.max(0, Math.min(100, 100 - alertPenalty - utilPenalty));
    return { score, alertPenalty, utilPenalty, rawAlertPoints, overloadedLineDays: lineDays };
  }

  return {
    // constants
    CONFIDENCE_WEIGHTS,
    MS_DAY, MS_HOUR, OVERLOAD_THRESHOLD, WARN_THRESHOLD, SHOW_NEAR_CAPACITY_ALERTS, DEFAULT_SHIFT, WEEKEND_OFF,
    // date/time helpers
    parseDate, dayKey, startOfDay, separationBucketKey, runHours, scheduleIntervals, setupIntervals, mergedOverlapHours, fmtDTReadable, toLocalSeconds, toLocalInput,
    // tool inventory (shared by the alert rule and the optimizer)
    TOOL_PLACEHOLDERS, normalizeToolId, taskToolIds, taskToolPlant, toolOccupancyInterval, buildToolCapacity, availableCopies,
    findToolOverages, toolConflictAlertId, buildToolIndex, toolIndexUpdate, toolHeadroom,
    // calendar engine
    activeWorkHours, plantWorkHoursOn, periodBoundaryKeys, validatePlantPeriods, unionWeeklyHours,
    getPlantForLine, ensureCalendar, ensurePlant, _dayWindow, _nextCalendarDay: nextCalendarDay, prevCalendarDay, plantWallClockFromInstant, plantInstantFromWallClock, workWindow, dueDateInstant, workingMinutesByDay,
    _indexCapacityBlocks, dailyCapacityHours, effectiveFromCapacity,
    // top-level compute
    computeAlerts, computeUtilization,
    // confidence scoring
    timeWeight, alertPoints, countOverloadedLineDays, scoreConfidence,
  };
});
