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
      const mdLine = (masterData?.lines ?? []).find(r => r.machine === line);
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
    const plantOf = line => getPlantForLine(line, lineSettings, masterData);
    const setupActiveForLine = line => masterData?.plants?.find(p => p.plant === plantOf(line))?.setup_active !== false;

    const alerts = [];
    const taskById = new Map(tasks.map(task => [String(task.id), task]));
    const orderNumber = task => {
      const order = String(task?.ORDER ?? '').trim() || String(task?.PRODUCTION_ORDER ?? '').trim();
      return order || 'order number unavailable';
    };
    const orderNumberForId = id => orderNumber(id == null ? undefined : taskById.get(String(id)));
    const todayStart = startOfDay(new Date());
    // task.start_date / end_date are proper Dates (structured-clone preserves them).
    let activeTasks = tasks.filter(t => !t.end_date || t.end_date >= todayStart);
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

    /* 1b. TOOL CONFLICT — one physical tool (PRT_01 / PRT_02 identify a unique tool,
       confirmed with the pilot plant 2026-09-11) scheduled on two DIFFERENT lines at
       the same instant. Same-line adjacency is a changeover, not a conflict.
       The peer pool is horizon-filtered but NOT line-filtered: an incremental
       recompute for L1 must still see the peer on L2. The alert attaches to the
       later order, on its own line, and is emitted only when that line is in scope. */
    const TOOL_PLACEHOLDERS = new Set(['', '-', '0', 'N/A', 'NONE', 'NULL']);
    const toolIds = task => {
      const out = [];
      for (const key of ['PRT_01', 'PRT_02']) {
        const v = String(task?.[key] ?? '').trim();
        if (!TOOL_PLACEHOLDERS.has(v.toUpperCase())) out.push(v);
      }
      return out;
    };
    const byTool = {};
    for (const t of tasks) {
      if (t.end_date && t.end_date < todayStart) continue;
      for (const tool of toolIds(t)) {
        for (const interval of scheduleIntervals(t)) {
          (byTool[tool] ||= []).push({ task: t, start: interval.start, end: interval.end });
        }
      }
    }
    const toolConflictIds = new Set();
    for (const tool of Object.keys(byTool)) {
      const arr = byTool[tool].slice().sort((a, b) => a.start - b.start);
      for (let i = 1; i < arr.length; i++) {
        const cur = arr[i];
        const curLine = cur.task.MACHINE || 'Unknown';
        if (onlyLines && !onlyLines.has(curLine)) continue;
        // Ends are not monotone in start order, so every earlier interval is a candidate.
        for (let j = i - 1; j >= 0; j--) {
          const prev = arr[j];
          if (prev.task.id === cur.task.id) continue;
          if (prev.end <= cur.start) continue;                 // touching is not overlapping
          const prevLine = prev.task.MACHINE || 'Unknown';
          if (prevLine === curLine) continue;                  // rule 1's territory
          const id = `toolc-${prev.task.id}|${cur.task.id}`;
          if (toolConflictIds.has(id)) continue;               // split segments of the same pair
          toolConflictIds.add(id);
          const vars = { tool, a: orderNumber(prev.task), b: orderNumber(cur.task), lineA: prevLine, lineB: curLine };
          alerts.push({
            id, sev: 'err', type: 'tool-conflict',
            msg: `Tool "${tool}" is needed by "${vars.a}" on ${prevLine} and "${vars.b}" on ${curLine} at the same time.`,
            msgKey: 'alert.tool_conflict', msgVars: vars,
            taskId: cur.task.id, peerId: prev.task.id, line: curLine, time: cur.start,
          });
        }
      }
    }

    /* 1c. DISTRIBUTION SEPARATION — siblings of a SAP-distributed order share a
       PARENT_ORDER; a per-work-center policy (max_separation: 'hour'|'day'|'week')
       caps how far apart their scheduled starts may drift. Grouped by
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
      const dated = g.tasks.filter(t => t.start_date);
      if (dated.length < 2) continue;
      const buckets = new Set(dated.map(t => separationBucketKey(t.start_date, maxSeparation)));
      if (buckets.size <= 1) continue;
      const sortedDated = dated.slice().sort((a, b) => a.start_date.getTime() - b.start_date.getTime());
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
        msg: `Sub-orders of "${g.parent}" start in different ${maxSeparation}s.`,
        msgKey: 'alert.distribution_separation', msgVars: vars,
        taskId: earliest.id, line: earliestLine, time: earliest.start_date,
      });
    }

    /* 2. OVERLOAD / CLOSED */
    const byLineDay = {};
    for (const t of activeTasks) {
      const line = t.MACHINE || 'Unknown';
      const intervals = scheduleIntervals(t);
      if (intervals.length >= 2) {
        for (const interval of intervals) {
          let cursor = startOfDay(new Date(interval.start));
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
        msg: `Order "${orderNumber(t)}" has a runtime that no longer matches its saved schedule.`,
        taskId: t.id, line, time: t.start_date || new Date(),
      });
    }

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
      if (!inScope(interval.line)) continue;
      const requiredMinutes = Number(interval.requiredMinutes);
      const availableMinutes = Number(interval.availableMinutes);
      if (!Number.isFinite(requiredMinutes) || !Number.isFinite(availableMinutes) || requiredMinutes <= availableMinutes) continue;
      const key = setupKey('setup-violated', interval);
      if (setupSeen.has(key)) continue;
      setupSeen.add(key);
      const shortMinutes = requiredMinutes - availableMinutes;
      alerts.push({
        id: `setup-violated-${key}`, sev: setupActiveForLine(interval.line) ? 'err' : 'warn', type: 'setup-violated',
        msg: `Not enough changeover time before order "${orderNumberForId(interval.successorOrderId)}" on ${interval.line}: needs ${requiredMinutes} min, only ${availableMinutes} min available (${shortMinutes} min short).`,
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
      'setup-uncovered': (d, pair) => `No changeover time defined${pair} on ${d.line}. Add a setup rule to the matrix.`,
      'predecessor-state-unknown': d => `Order ${orderNumberForId(d.predecessorOrderId)} on ${d.line} is missing attributes needed to calculate the changeover before ${orderNumberForId(d.successorOrderId)}.`,
      'successor-state-unknown': d => `Order ${orderNumberForId(d.successorOrderId)} on ${d.line} is missing attributes needed to calculate its changeover.`,
    };
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
      const pair = diagnostic.pairKey ? ` for ${formatSetupPairKey(diagnostic.pairKey)}` : '';
      const defaultMsg = SETUP_DIAGNOSTIC_DEFAULT_MSG[diagnostic.type];
      const baseSev = SETUP_DIAGNOSTIC_SEVERITY[diagnostic.type] || 'err';
      const sev = baseSev === 'err' && !setupActiveForLine(diagnostic.line) ? 'warn' : baseSev;
      alerts.push({
        id: `${diagnostic.type}-${key}`, sev, type: diagnostic.type,
        msg: diagnostic.message || (defaultMsg ? defaultMsg(diagnostic, pair) : `Setup ${diagnostic.type.replaceAll('-', ' ')}${pair} on ${diagnostic.line}.`),
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

    for (const t of tasks) {
      if (!t.start_date) continue;
      const line = t.MACHINE || 'Unknown';
      if (!matrix[line]) continue;

      const intervals = scheduleIntervals(t);
      if (intervals.length >= 2) {
        const lineRows = matrix[line];
        for (const interval of intervals) {
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
              const dayEndMs = dayStartMs + MS_DAY;
              const contribution = (Math.min(intervalEndMs, dayEndMs) - Math.max(intervalStartMs, dayStartMs)) / MS_HOUR;
              if (contribution > 0) {
                row.scheduled += contribution;
                if (!row.tasks.includes(t.id)) row.tasks.push(t.id);
              }
            }
            currentDay = new Date(currentDay.getTime() + MS_DAY);
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
      // Optimize: only iterate days this task actually spans, not all days in the horizon.
      const dayStart = startOfDay(new Date(tStartMs));
      const dayEnd = startOfDay(new Date(tEndMs));
      let currentDay = new Date(dayStart);
      while (currentDay <= dayEnd) {
        const key = dayKey(currentDay);
        const row = lineRows[key];
        if (row) {
          if (!workWindow(line, row.date, calendars, plants, lineSettings, masterData)) {
            currentDay = new Date(currentDay.getTime() + MS_DAY);
            continue;
          }
          const dayStartMs = row.date.getTime();
          const dayEndMs   = dayStartMs + MS_DAY;
          const overlapMs    = Math.min(tEndMs, dayEndMs) - Math.max(tStartMs, dayStartMs);
          const contribution = taskRunHrs * (overlapMs / totalTaskMs);
          if (contribution > 0) {
            row.scheduled += contribution;
            row.tasks.push(t.id);
          }
        }
        currentDay = new Date(currentDay.getTime() + MS_DAY);
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
          const dayEndMs = dayStartMs + MS_DAY;
          const contribution = (Math.min(intervalEndMs, dayEndMs) - Math.max(intervalStartMs, dayStartMs)) / MS_HOUR;
          if (contribution > 0) {
            row.scheduled += contribution;
            if (interval.successorOrderId && !row.tasks.includes(interval.successorOrderId)) row.tasks.push(interval.successorOrderId);
          }
        }
        currentDay = new Date(currentDay.getTime() + MS_DAY);
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
    parseDate, dayKey, startOfDay, separationBucketKey, runHours, scheduleIntervals, setupIntervals, mergedOverlapHours, fmtDTReadable, toLocalSeconds, toLocalInput,
    // calendar engine
    getPlantForLine, ensureCalendar, ensurePlant, _dayWindow, workWindow,
    _indexCapacityBlocks, dailyCapacityHours, effectiveFromCapacity,
    // top-level compute
    computeAlerts, computeUtilization,
  };
});
