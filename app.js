/* =============================================================================
   N.I.M.B.U.S. 2.0 — Application
   Organised as modules inside a single `NIMBUS` namespace.

   Module map (load order):
     Config            — constants + default calendars
     Util              — date / duration helpers
     Store             — reactive pub/sub state (single source of truth)
     Calendar          — working-hours + blackout-block availability
     Alerts            — overload / conflict / fixed-violation detection
     Utilization       — scheduled vs. available hours
     Engine            — optimisation (SPT / changeover / combined) + auto-scheduler
     ErrorLog          — error/info log with header badge + panel
     Toast             — transient notification toasts
     Modal             — generic modal show/hide
     Timeline          — vis-timeline integration (groups/items + diff rebuild)
     Table             — AG Grid integration (inline edit, filter, bulk ops)
     Inspector         — right-side detail panel
     Hierarchy         — left sidebar (lines + orders + utilisation)
     Dashboard         — home KPIs + Chart.js charts
     TimelineNav       — canvas minimap for timeline navigation
     GanttFilter       — filter bar above the Gantt
     DependencyOverlay — finish-to-start dependency arrows overlay
     ContextMenu       — right-click context menu
     Selection         — multi-select with Shift/Ctrl/Cmd + keyboard nav
     UndoStack         — 10-level undo for destructive ops
     Sandbox           — sandboxed simulation / what-if preview
     Interaction       — unified click / dblclick / keyboard / drag pipeline
                         (owns all vis-timeline input events; app.js registers none)
     Persistence       — backend fetch + localStorage cache (nimbus.state.v3)
     AdminCockpit      — upload, data management, integrity check panel
     Printer           — print / export
     App               — bootstrap + tab switching
   ========================================================================== */

/* =============================================================================
   CACHE-BUST GUARD
   Stores a version token in sessionStorage. If the token changes (new deploy),
   appends ?v=<token> to the URL so the browser fetches fresh assets.
   Change APP_VERSION any time you deploy a new build.
   ========================================================================== */
(function () {
  const APP_VERSION = '2026-05-20-a'; // ← bump this string on every deploy (keep in sync with NIMBUS_BUILD_ID in index.html)
  const KEY = 'nimbus.app.ver';
  const stored = sessionStorage.getItem(KEY);
  if (stored !== APP_VERSION) {
    sessionStorage.setItem(KEY, APP_VERSION);
    const base = window.location.pathname + window.location.search.replace(/[?&]_v=[^&]*/g, '');
    const sep  = base.includes('?') ? '&' : '?';
    window.location.replace(base + sep + '_v=' + APP_VERSION);
  }
})();


const NIMBUS = (function () {
  'use strict';

  /* =============================================================================
     CONFIG — global constants; never mutated at runtime.
       STEP_MS          15-minute snap granularity for all drag/edit ops
       DEFAULT_SHIFT    [startHour, endHour] used when no plant calendar exists
       COLORS           10-color palette for production lines
       OVERLOAD/WARN    thresholds for the utilisation alert system
       LS_KEY           localStorage key for the v3 state cache
       SCHEMA_VERSION   bump this when the cached snapshot shape changes
       KNOWN_PLANTS     plant codes the app is aware of (for plant selector)
     ========================================================================== */
  const Config = {
    API_BASE:         'http://localhost:8000',
    STEP_MS:          15 * 60 * 1000,          // 15-minute snap
    DEFAULT_SHIFT:    [7, 19],                  // 7:00 → 19:00 (12h shift)
    WEEKEND_OFF:      true,                     // Sat/Sun closed by default
    TZ:               'America/New_York',
    COLORS: [                                   // production-line palette (10)
      '#b8791a', '#2d5f8c', '#4f7a3c', '#8b4c7e', '#b14a3e',
      '#3c6e7a', '#7a5a2a', '#5e498b', '#a8493a', '#4a7a5e'
    ],
    OVERLOAD_THRESHOLD: 1.0,                    // >100% → error, >80% → warn
    WARN_THRESHOLD:     0.8,
    SHOW_NEAR_CAPACITY_ALERTS: false,           // set true to re-enable near-capacity warnings
    LS_KEY:             'nimbus.state.v3',          // do NOT bump for shape changes — use SCHEMA_VERSION
    SCHEMA_VERSION:     4,                          // bump whenever _saveCache snapshot fields change
    BUILD_ID:           (typeof window !== 'undefined' && window.NIMBUS_BUILD_ID) || 'dev',
    DEFAULT_PLANT:      null,
    KNOWN_PLANTS:       ['5512', '1006'],
    CENTER_ON_CLICK:    true,                       // set false to disable click-to-center in Gantt
    DEBUG_BLOCKS:       true                        // when true, Store.addBlock/addPlantBlock console.trace every push (for diagnosing duplicate-add bugs)
  };

  /* =============================================================================
     UTIL — small pure helpers (no state, no DOM)
     ========================================================================== */
  const Util = {
    // Safe Date parser. Accepts Date | ISO | null. Returns Date or null.
    parseDate(v) {
      if (!v) return null;
      if (v instanceof Date) return isNaN(v) ? null : v;
      const d = new Date(v);
      return isNaN(d) ? null : d;
    },

    // Snap a Date to the nearest STEP_MS boundary.
    snap(date) {
      const t = date instanceof Date ? date.getTime() : new Date(date).getTime();
      return new Date(Math.round(t / Config.STEP_MS) * Config.STEP_MS);
    },

    // YYYY-MM-DD key (local time) for bucketing by day.
    dayKey(d) {
      const date = Util.parseDate(d);
      if (!date) return '';
      const p = n => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
    },

    // Pretty date for display (e.g. "2026-04-22 09:15").
    fmtDT(d) {
      const date = Util.parseDate(d);
      if (!date) return '';
      const p = n => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} `
           + `${p(date.getHours())}:${p(date.getMinutes())}`;
    },

    // Human-readable datetime (e.g. "05/15/2026 · 6 PM").
    fmtDTReadable(d) {
      const date = Util.parseDate(d);
      if (!date) return '';
      const p = n => String(n).padStart(2, '0');
      const h24 = date.getHours(), min = date.getMinutes();
      const ampm = h24 < 12 ? 'AM' : 'PM';
      const h12 = h24 % 12 || 12;
      const minStr = min === 0 ? '' : `:${String(min).padStart(2,'0')}`;
      return `${p(date.getMonth()+1)}/${p(date.getDate())}/${String(date.getFullYear()).slice(-2)} · ${h12}${minStr} ${ampm}`;
    },

    // Compact range for blackout rows. Same day: "05/15/26 · 6–7 PM". Multi-day: "05/15/26 → 05/17/26".
    fmtBlockRange(s, e) {
      const ds = Util.parseDate(s), de = Util.parseDate(e);
      if (!ds || !de) return '';
      const p = n => String(n).padStart(2, '0');
      const dateStr = d => `${p(d.getMonth()+1)}/${p(d.getDate())}/${String(d.getFullYear()).slice(-2)}`;
      const sameDay = ds.getFullYear() === de.getFullYear()
                   && ds.getMonth()    === de.getMonth()
                   && ds.getDate()     === de.getDate();
      const fmtTime = (h24, min) => {
        const ampm = h24 < 12 ? 'AM' : 'PM';
        const h12  = h24 % 12 || 12;
        const m    = min === 0 ? '' : `:${String(min).padStart(2,'0')}`;
        return `${h12}${m}${ampm}`;
      };
      if (sameDay) {
        const sAmpm = ds.getHours() < 12 ? 'AM' : 'PM';
        const eAmpm = de.getHours() < 12 ? 'AM' : 'PM';
        const sH    = ds.getHours() % 12 || 12;
        const eH    = de.getHours() % 12 || 12;
        const sM    = ds.getMinutes() === 0 ? '' : `:${String(ds.getMinutes()).padStart(2,'0')}`;
        const eM    = de.getMinutes() === 0 ? '' : `:${String(de.getMinutes()).padStart(2,'0')}`;
        const suffix = sAmpm === eAmpm ? `${sH}${sM}–${eH}${eM} ${eAmpm}` : `${sH}${sM}${sAmpm}–${eH}${eM}${eAmpm}`;
        return `${dateStr(ds)} · ${suffix}`;
      }
      return `${dateStr(ds)} ${fmtTime(ds.getHours(), ds.getMinutes())} → ${dateStr(de)} ${fmtTime(de.getHours(), de.getMinutes())}`;
    },

    /** Sum the hours of `intervals` ([{s:Date, e:Date}, …]) intersected with `win`
     *  ([Date, Date]), correctly unioning overlapping intervals so the same
     *  minutes are never counted twice. Returns hours. */
    mergedOverlapHours(win, intervals) {
      if (!win || !intervals?.length) return 0;
      const w0 = win[0].getTime ? win[0].getTime() : +win[0];
      const w1 = win[1].getTime ? win[1].getTime() : +win[1];
      if (w1 <= w0) return 0;
      const clipped = [];
      for (const it of intervals) {
        if (!it?.s || !it?.e) continue;
        const s = Math.max(w0, it.s.getTime ? it.s.getTime() : +it.s);
        const e = Math.min(w1, it.e.getTime ? it.e.getTime() : +it.e);
        if (e > s) clipped.push([s, e]);
      }
      if (!clipped.length) return 0;
      clipped.sort((a, b) => a[0] - b[0]);
      let total = 0;
      let curS = clipped[0][0], curE = clipped[0][1];
      for (let i = 1; i < clipped.length; i++) {
        const [s, e] = clipped[i];
        if (s <= curE) curE = Math.max(curE, e);
        else { total += curE - curS; curS = s; curE = e; }
      }
      total += curE - curS;
      return total / 3600000;
    },

    // "2h 30m"
    fmtHours(hours) {
      if (hours == null || isNaN(hours)) return '—';
      const h = Math.floor(hours);
      const m = Math.round((hours - h) * 60);
      if (h === 0) return `${m}m`;
      if (m === 0) return `${h}h`;
      return `${h}h ${m}m`;
    },

    // Convert a Date to <input type="datetime-local"> value.
    toLocalInput(d) {
      const date = Util.parseDate(d);
      if (!date) return '';
      const p = n => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
           + `T${p(date.getHours())}:${p(date.getMinutes())}`;
    },

    // Clamp a Date to a [min,max] window.
    clamp(d, min, max) {
      const t = d.getTime();
      if (min && t < min.getTime()) return new Date(min);
      if (max && t > max.getTime()) return new Date(max);
      return d;
    },

    // Normalise a string for case-insensitive compares.
    norm(s) { return (s ?? '').toString().trim().toUpperCase(); },

    // Get run-time (hours) from a task; 0 if missing.
    runHours(task) {
      const v = parseFloat(task?.RUN_TIME);
      return isNaN(v) ? 0 : v;
    },

    // Start of local day.
    startOfDay(d) { const x = Util.parseDate(d); if (!x) return null; x.setHours(0,0,0,0); return x; },

    // Add minutes.
    addMin(d, min) { return new Date(d.getTime() + min * 60000); },

    // Short, stable id (used for blocks / alerts).
    uid(prefix) {
      return `${prefix || 'x'}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36).slice(-4)}`;
    },

    // Simple debounce.
    debounce(fn, wait) {
      let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); };
    },

    // Deep-ish clone for plain objects + Dates.
    clone(obj) {
      if (obj == null || typeof obj !== 'object') return obj;
      if (obj instanceof Date) return new Date(obj);
      if (Array.isArray(obj)) return obj.map(Util.clone);
      const out = {};
      for (const k of Object.keys(obj)) out[k] = Util.clone(obj[k]);
      return out;
    },

    // Traced fetch — attaches an x-request-id and logs slow/failed responses through ErrorLog.
    // Drop-in replacement for fetch() everywhere in the app.
    fetchTraced(input, init = {}) {
      const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      const headers = new Headers(init.headers || {});
      if (!headers.has('x-request-id')) headers.set('x-request-id', reqId);
      const method = init.method || 'GET';
      const url    = typeof input === 'string' ? input : input.url;
      const t0     = performance.now();
      return fetch(input, { ...init, headers }).then(r => {
        const ms = Math.round(performance.now() - t0);
        if (!r.ok)        ErrorLog.warn('http', `${method} ${url} → ${r.status} (${ms}ms, ${reqId})`);
        else if (ms > 2000) ErrorLog.info('http', `slow: ${method} ${url} ${ms}ms (${reqId})`);
        return r;
      }).catch(e => {
        if (e?.name === 'AbortError') throw e;
        ErrorLog.error('http', `${method} ${url} failed: ${e.message} (${reqId})`);
        throw e;
      });
    },

    // SAP planning baseline finish. NIMBUS keeps this in `original_end_date`
    // (set once from ORIGINAL_END_DATE; what the variance badge compares against).
    sapDueDate(t) {
      return t?.original_end_date || null;
    },

    // Scheduled finish for a task — user override `end_date` if present, otherwise the SAP baseline.
    scheduledEnd(t) {
      return t?.end_date || Util.sapDueDate(t);
    },

    // Hours that scheduled finish slips past the SAP planning date (clamped at 0).
    latenessHours(t) {
      const end = Util.scheduledEnd(t);
      const due = Util.sapDueDate(t);
      if (!end || !due) return 0;
      const diff = (end.getTime() - due.getTime()) / 3600000;
      return diff > 0 ? diff : 0;
    },

    // Adjacent-order changeover count across the schedule, grouped by line.
    // A "changeover" = neighbours differ in COLOR or FORM_SIZE.
    countChangeovers(tasks) {
      const byLine = {};
      for (const t of tasks) {
        if (!t.start_date) continue;
        const l = t.PRODUCTION_LINE || 'Unknown';
        (byLine[l] ||= []).push(t);
      }
      let n = 0;
      for (const l of Object.keys(byLine)) {
        const sorted = byLine[l].sort((a, b) => a.start_date - b.start_date);
        for (let i = 1; i < sorted.length; i++) {
          const a = sorted[i - 1], b = sorted[i];
          if ((a.COLOR || '') !== (b.COLOR || '') || (a.FORM_SIZE || '') !== (b.FORM_SIZE || '')) n++;
        }
      }
      return n;
    },

    // Composite KPIs for the optimizer preview. Pure: takes a task array, no Store access.
    // Returns { changeovers, span_h, late_count, late_h, peak_util_pct }.
    scheduleKpis(tasks, horizonDays = 14) {
      const changeovers = Util.countChangeovers(tasks);
      let minStart = Infinity, maxEnd = -Infinity;
      let lateCount = 0, lateH = 0;
      for (const t of tasks) {
        if (t.start_date) minStart = Math.min(minStart, t.start_date.getTime());
        const e = Util.scheduledEnd(t);
        if (e) maxEnd = Math.max(maxEnd, e.getTime());
        const lh = Util.latenessHours(t);
        if (lh > 0) { lateCount++; lateH += lh; }
      }
      const span_h = (minStart === Infinity || maxEnd === -Infinity) ? 0 : (maxEnd - minStart) / 3600000;
      // Peak utilization from the existing Utilization matrix (uses Calendar capacities).
      let peak = 0;
      try {
        const m = Utilization.computeMatrix(new Date(), horizonDays, tasks);
        for (const ln of Object.keys(m)) {
          for (const d of Object.keys(m[ln])) {
            const p = m[ln][d]?.pct || 0;
            if (p > peak) peak = p;
          }
        }
      } catch (_) { /* matrix unavailable — leave peak at 0 */ }
      return {
        changeovers,
        span_h: Math.round(span_h * 10) / 10,
        late_count: lateCount,
        late_h:    Math.round(lateH * 10) / 10,
        peak_util_pct: Math.round(peak * 100),
      };
    },

    _locale: localStorage.getItem('nimbus.locale') || 'en',

    t(key, vars) {
      const dict = window.__NIMBUS_LOCALES?.[Util._locale] || {};
      const en   = window.__NIMBUS_LOCALES?.en || {};
      let str = dict[key] ?? en[key] ?? key;
      if (vars) str = str.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
      return str;
    },
  };

  window.t = (key, vars) => Util.t(key, vars);

  /* =============================================================================
     STORE — single reactive source of truth.
     Every mutation goes through here and fans out to subscribers.
     Subscribers tag their own mutations with `source` so they can skip echoes.
     ========================================================================== */
  const Store = {
    _tasksByPlant: {},   // plant → [task refs] — derived index rebuilt on setTasks
    _state: {
      tasks:        {},           // id → task object
      dependencies: {},           // targetId → [sourceIds]
      calendars:    {},           // line → { workHours: {0..6: [h1,h2]|null} }
      blocks:       [],           // [{id, line, start, end, reason}]
      alerts:       [],           // [{id, sev, type, msg, taskId?, line?, time?}]
      fixedIds:     new Set(),    // ids of tasks locked from optimiser
      meta:         { lastOptimize: null },
      plants:       {},           // plantName → { workHours: {0..6: [h1,h2]|null} }
      plantBlocks:  [],           // [{id, plant, start, end, reason}]
      lineSettings: {},           // line → { plant, bufferUnit, bufferPct, bufferHours, bottleneck, excludeFromOpt }
      selectedPlant: null,        // single plant selected from Dashboard filter; drives Plant tab + optimization
      masterData: null,           // { plants: [...], lines: [...] } from /master-data/* endpoints
      userSettings: { alertHorizonMinutes: null, confidenceHorizonMinutes: 20160 } // null = no cap; values in minutes
    },
    _listeners: new Set(),

    /* ----- basic access ---------------------------------------------------- */
    get state()     { return this._state; },
    get tasks()     { return this._state.tasks; },
    get blocks()    { return this._state.blocks; },
    get alerts()    { return this._state.alerts; },
    get calendars() { return this._state.calendars; },
    get fixedIds()  { return this._state.fixedIds; },
    get tasksArr()      { return Object.values(this._state.tasks); },
    get plants()        { return this._state.plants; },
    get plantBlocks()   { return this._state.plantBlocks; },
    get lineSettings()  { return this._state.lineSettings; },
    get selectedPlant() { return this._state.selectedPlant; },
    get userSettings()  { return this._state.userSettings; },

    isFixed(id)     { return this._state.fixedIds.has(String(id)); },

    /* ----- subscription ---------------------------------------------------- */
    subscribe(fn) {
      this._listeners.add(fn);
      return () => this._listeners.delete(fn);
    },
    emit(event) {
      // event: { type, source?, id?, changes?, ... }
      // Monotonic revision — any state change bumps it. Used as a cheap, always-correct
      // cache key by memoized read-models (e.g. Utilization.computeMatrix).
      this._rev = (this._rev || 0) + 1;
      for (const l of this._listeners) {
        try { l(event); } catch (e) { console.error('[Store] listener error:', e); }
      }
    },

    /* ----- mutations ------------------------------------------------------- */
    // Replace all tasks (e.g. after backend load or optimiser run).
    setTasks(tasks, source) {
      this._state.tasks = {};
      let collisions = 0;
      const collisionSamples = [];
      for (const t of tasks) {
        Store._normalizeDates(t);
        if (t.id == null || String(t.id).trim() === '') {
          if (typeof ErrorLog !== 'undefined') {
            ErrorLog.error('store', 'setTasks: task with null/empty id — skipped', t);
          }
          continue;
        }
        const key = String(t.id);
        if (Object.prototype.hasOwnProperty.call(this._state.tasks, key)) {
          collisions++;
          if (collisionSamples.length < 5) collisionSamples.push({ id: key, text: t.text, line: t.PRODUCTION_LINE });
        }
        this._state.tasks[key] = t;
      }
      if (collisions && typeof ErrorLog !== 'undefined') {
        ErrorLog.error('store',
          `setTasks silently overwrote ${collisions} duplicate id(s) — rows were LOST`,
          collisionSamples);
      }
      this._rebuildPlantIndex();
      this.emit({ type: 'tasks:bulk', source });
      return { inserted: Object.keys(this._state.tasks).length, collisions };
    },

    // Update one task with a partial change-set.
    // NOTE: we replace the task *reference* (prev → next) rather than mutating
    // in place, so subscribers (e.g. AG Grid, diff-rebuild) can diff by identity.
    // Backwards-compatible: the emitted event still carries {id, changes, source};
    // {prev, next} are additive fields for consumers that want them.
    updateTask(id, changes, source) {
      const prev = this._state.tasks[id];
      if (!prev) return;
      const next = { ...prev, ...changes };
      Store._normalizeDates(next);
      this._state.tasks[id] = next;
      this.emit({ type: 'task:update', id, prev, next, changes, source });
    },

    // Remove a task, cleaning up dependencies, fixedIds, and (if present)
    // the Selection set. Emits 'task:remove'.
    removeTask(id, source) {
      const key = String(id);
      const prev = this._state.tasks[key];
      if (!prev) return null;
      delete this._state.tasks[key];

      // Clean up dependency graph both ways.
      const deps = this._state.dependencies;
      if (deps[key]) delete deps[key];
      for (const target of Object.keys(deps)) {
        const arr = deps[target];
        const i = arr.indexOf(key);
        if (i >= 0) arr.splice(i, 1);
        if (!arr.length) delete deps[target];
      }

      this._state.fixedIds.delete(key);
      // Selection is defined later in this IIFE; guard for load order.
      if (typeof Selection !== 'undefined') Selection.remove(key);
      this.emit({ type: 'task:remove', id: key, prev, source });
      return prev;
    },

    // Update several tasks at once (used by the optimiser).
    updateMany(patches, source) {
      // patches: [{id, changes}]
      for (const p of patches) {
        const task = this._state.tasks[p.id];
        if (!task) continue;
        Object.assign(task, p.changes);
        Store._normalizeDates(task);
      }
      this.emit({ type: 'tasks:bulkUpdate', ids: patches.map(p => p.id), source });
    },

    // Toggle fixed flag on a task (or group of tasks).
    setFixed(ids, fixed, source) {
      const arr = Array.isArray(ids) ? ids : [ids];
      for (const id of arr) {
        const key = String(id);
        if (fixed) this._state.fixedIds.add(key);
        else       this._state.fixedIds.delete(key);
        const t = this._state.tasks[id];
        if (t) t.fixed = !!fixed;
      }
      this.emit({ type: 'fixed:change', ids: arr, fixed, source });
    },

    /* ----- calendar & blocks ---------------------------------------------- */
    setCalendar(line, workHours, source) {
      if (!this._state.calendars[line]) this._state.calendars[line] = { workHours: {} };
      this._state.calendars[line].workHours = workHours;
      this.emit({ type: 'calendar:change', line, source });
    },
    ensureCalendar(line) {
      if (this._state.calendars[line]) return;
      const defaults = {};
      for (let d = 0; d < 7; d++) {
        if (Config.WEEKEND_OFF && (d === 0 || d === 6)) defaults[d] = null;
        else defaults[d] = [...Config.DEFAULT_SHIFT];
      }
      this._state.calendars[line] = { workHours: defaults };
    },
    addBlock(block, source) {
      if (Config.DEBUG_BLOCKS) console.trace('[addBlock]', { source, block });
      const newS = Util.parseDate(block.start)?.getTime();
      const newE = Util.parseDate(block.end)?.getTime();
      const dup = this._state.blocks.find(b =>
        (b.line || '') === (block.line || '') &&
        Util.parseDate(b.start)?.getTime() === newS &&
        Util.parseDate(b.end)?.getTime()   === newE &&
        (b.reason || '') === (block.reason || '')
      );
      if (dup) {
        ErrorLog.warn?.('store', `Refused duplicate line blackout (line=${block.line||'*'}, ${block.start}→${block.end}, reason="${block.reason||''}") from source="${source}"`);
        return;
      }
      if (!block.id) block.id = Util.uid('blk');
      this._state.blocks.push(block);
      this.emit({ type: 'blocks:change', source });
    },
    removeBlock(blockId, source) {
      const i = this._state.blocks.findIndex(b => b.id === blockId);
      if (i >= 0) {
        this._state.blocks.splice(i, 1);
        this.emit({ type: 'blocks:change', source });
      }
    },

    /* ----- plants & plant-blocks ------------------------------------------ */
    ensurePlant(name) {
      if (!name) return;
      if (this._state.plants[name]) return;
      const defaults = {};
      for (let d = 0; d < 7; d++) {
        if (Config.WEEKEND_OFF && (d === 0 || d === 6)) defaults[d] = null;
        else defaults[d] = [...Config.DEFAULT_SHIFT];
      }
      this._state.plants[name] = { workHours: defaults };
    },
    setPlantWorkHours(plant, dow, range, source) {
      this.ensurePlant(plant);
      this._state.plants[plant].workHours[dow] = range;
      this.emit({ type: 'calendar:change', source });
    },
    clampLinesToPlant(plant, dow) {
      const plantHours = this._state.plants[plant]?.workHours[dow];
      for (const line of Object.keys(this._state.calendars)) {
        const lsettings = this._state.lineSettings[line];
        const linePlant = (lsettings || {}).plant || null;
        if (linePlant !== plant) continue;
        const lineHours = this._state.calendars[line].workHours[dow];
        if (!lineHours) continue;
        if (!plantHours) {
          this._state.calendars[line].workHours[dow] = null;
        } else {
          const ns = Math.max(lineHours[0], plantHours[0]);
          const ne = Math.min(lineHours[1], plantHours[1]);
          this._state.calendars[line].workHours[dow] = ns >= ne ? null : [ns, ne];
        }
      }
      this.emit({ type: 'calendar:change', source: 'plant-clamp' });
    },
    addPlantBlock(block, source) {
      if (Config.DEBUG_BLOCKS) console.trace('[addPlantBlock]', { source, block });
      const newS = Util.parseDate(block.start)?.getTime();
      const newE = Util.parseDate(block.end)?.getTime();
      const dup = this._state.plantBlocks.find(b =>
        (b.plant || '') === (block.plant || '') &&
        Util.parseDate(b.start)?.getTime() === newS &&
        Util.parseDate(b.end)?.getTime()   === newE &&
        (b.reason || '') === (block.reason || '')
      );
      if (dup) {
        ErrorLog.warn?.('store', `Refused duplicate plant blackout (plant=${block.plant||'*'}, ${block.start}→${block.end}, reason="${block.reason||''}") from source="${source}"`);
        return;
      }
      if (!block.id) block.id = Util.uid('pblk');
      this._state.plantBlocks.push(block);
      this.emit({ type: 'plantBlocks:change', source });
    },
    removePlantBlock(id, source) {
      const i = this._state.plantBlocks.findIndex(b => b.id === id);
      if (i >= 0) {
        this._state.plantBlocks.splice(i, 1);
        this.emit({ type: 'plantBlocks:change', source });
      }
    },

    /* ----- line settings -------------------------------------------------- */
    ensureLineSettings(line) {
      if (this._state.lineSettings[line]) return;
      this._state.lineSettings[line] = {
        plant: null,
        bufferUnit: 'pct',
        bufferPct: 0,
        bufferHours: 0,
        bottleneck: false,
        excludeFromOpt: false,
        plGroup: '',
      };
    },
    setLineSetting(line, patch, source) {
      this.ensureLineSettings(line);
      Object.assign(this._state.lineSettings[line], patch);
      this.emit({ type: 'lineSettings:change', line, source });
    },
    getPlantForLine(line) {
      return (this._state.lineSettings[line] || {}).plant || null;
    },
    setSelectedPlant(plant, source) {
      const next = plant || null;
      if (next === this._state.selectedPlant) return; // no-op: don't re-emit
      this._state.selectedPlant = next;
      this.emit({ type: 'plant:selected', plant: this._state.selectedPlant, source });
    },

    /* ----- plant-scoped accessors ----------------------------------------- */
    // The selected plant is a true global filter. When null, callers see an
    // empty world and render an EmptyState prompt instead of their usual view.
    tasksByPlant(plant) {
      return plant ? (Store._tasksByPlant[plant] || []) : Store.tasksArr;
    },
    _rebuildPlantIndex() {
      const idx = {};
      for (const t of Store.tasksArr) {
        const p = t.PLANT || Store.getPlantForLine(t.PRODUCTION_LINE);
        if (!p) continue;
        (idx[p] ||= []).push(t);
      }
      Store._tasksByPlant = idx;
    },
    allLines() {
      const set = new Set();
      for (const t of Store.tasksArr) {
        if (t.PRODUCTION_LINE) set.add(t.PRODUCTION_LINE);
      }
      Object.keys(this._state.calendars).forEach(l => set.add(l));
      Object.keys(this._state.lineSettings).forEach(l => set.add(l));
      return [...set];
    },
    tasksForSelectedPlant() {
      const plant = this._state.selectedPlant;
      if (!plant) return [];
      return Store.tasksArr.filter(t => Store.getPlantForLine(t.PRODUCTION_LINE) === plant);
    },
    linesForSelectedPlant() {
      const plant = this._state.selectedPlant;
      if (!plant) return [];
      return Store.allLines().filter(line => Store.getPlantForLine(line) === plant);
    },
    knownPlants() {
      // Prefer master-data plants when available (authoritative source).
      const masterPlants = Store._state.masterData?.plants?.map(p => p.plant) ?? [];
      if (masterPlants.length) return [...new Set(masterPlants)].sort();
      // Fall back to dynamically discovered plants from order data.
      const dynamic = [];
      for (const line of Store.allLines()) {
        const p = Store.getPlantForLine(line);
        if (p) dynamic.push(p);
      }
      return [...new Set([...Config.KNOWN_PLANTS, ...dynamic])].sort();
    },

    /* ----- alerts ---------------------------------------------------------- */
    setAlerts(alerts, source) {
      this._state.alerts = alerts;
      this.emit({ type: 'alerts:change', source });
    },
    dismissAlert(alertId, source) {
      const i = this._state.alerts.findIndex(a => a.id === alertId);
      if (i >= 0) {
        this._state.alerts.splice(i, 1);
        this.emit({ type: 'alerts:change', source });
      }
    },
    dismissAllAlerts(source) {
      this._state.alerts = [];
      this.emit({ type: 'alerts:change', source });
    },
    setUserSettings(patch, source) {
      Object.assign(this._state.userSettings, patch);
      this.emit({ type: 'settings:change', source });
    },

    /* ----- internals ------------------------------------------------------- */
    _normalizeDates(task) {
      for (const k of ['start_date','end_date','BASIC_START_DATE','BASIC_FINISH_DATE','original_start_date','original_end_date']) {
        const v = task[k];
        if (v && !(v instanceof Date)) task[k] = Util.parseDate(v);
      }
      if (task.start_date) task.start_date = Util.snap(task.start_date);
      if (task.end_date)   task.end_date   = Util.snap(task.end_date);
      // To re-enable SAP firmed→fixed mapping: change the line below back to:
      //   task.fixed = !!task.fixed || !!task.firmed;
      task.fixed = !!task.fixed;
      if (task.fixed) Store._state.fixedIds.add(String(task.id));
      if (task.id != null) task.id = String(task.id);
    }
  };

  /* =============================================================================
     CALENDAR — working hours, blackout blocks, availability calculations.
     All functions operate on a `line` (string) + Date objects.
     ========================================================================== */
  const Calendar = {
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

    /** Returns [startDate, endDate] for a workHours map + date, or null if closed. */
    _dayWindow(workHours, date) {
      const d = new Date(date);
      const wh = workHours[d.getDay()];
      if (!wh) return null;
      const [h1, h2] = wh;
      const start = new Date(d); start.setHours(h1, 0, 0, 0);
      const end   = new Date(d); end.setHours(h2, 0, 0, 0);
      return [start, end];
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
    dailyCapacityHours(line, date) {
      const win = Calendar.workWindow(line, date);
      if (!win) return 0;
      const winHours = (win[1] - win[0]) / 3600000;

      const plant = Store.getPlantForLine(line);
      const intervals = [];
      for (const b of Store.blocks) {
        if (b.line && b.line !== line) continue;
        const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
        if (s && e) intervals.push({ s, e });
      }
      for (const b of Store.plantBlocks) {
        if (b.plant && b.plant !== plant) continue;
        const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
        if (s && e) intervals.push({ s, e });
      }

      const consumed = Util.mergedOverlapHours(win, intervals);
      return Math.max(0, winHours - consumed);
    },

    /** Maximum schedulable hours after deducting the capacity buffer.
     *  Nothing should be scheduled past this value (= total − buffer). */
    effectiveCapacityHours(line, date) {
      const full = Calendar.dailyCapacityHours(line, date);
      const ls = Store.lineSettings[line];
      if (!ls) return full;
      if (ls.bufferUnit === 'pct' && ls.bufferPct > 0) return full * (1 - ls.bufferPct / 100);
      if (ls.bufferUnit === 'hours' && ls.bufferHours > 0) return Math.max(0, full - ls.bufferHours);
      return full;
    },

    /** True if `date` is inside the working window and not inside any blackout. */
    isAvailable(line, date) {
      const win = Calendar.workWindow(line, date);
      if (!win) return false;
      if (date < win[0] || date >= win[1]) return false;

      for (const b of Store.blocks) {
        if (b.line && b.line !== line) continue;
        const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
        if (!s || !e) continue;
        if (date >= s && date < e) return false;
      }

      const plant = Store.getPlantForLine(line);
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
      const STEP = Config.STEP_MS;
      const MAX_ITERS = 24 * 60 * 30 * 4;  // 30 days of 15-min steps — safety cap
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

      for (const b of Store.blocks) {
        if (b.line && b.line !== line) continue;
        const bs = Util.parseDate(b.start), be = Util.parseDate(b.end);
        if (!bs || !be) continue;
        if (start < be && end > bs) return { start: bs, end: be };
      }
      const plant = Store.getPlantForLine(line);
      for (const b of Store.plantBlocks) {
        if (b.plant && b.plant !== plant) continue;
        const bs = Util.parseDate(b.start), be = Util.parseDate(b.end);
        if (!bs || !be) continue;
        if (start < be && end > bs) return { start: bs, end: be };
      }
      return null;
    },

    /* ---------- UI: render calendar tab ----------------------------------- */
    _lineFilter: 'all',
    _blockFilter: 'all',

    render() {
      const body = document.getElementById('cal-hours-body');
      if (!body) return;
      const lines = Calendar._getLines();
      lines.forEach(l => Store.ensureCalendar(l));

      const sel = Calendar._lineFilter || 'all';
      const shownLines = sel === 'all' ? lines : lines.filter(l => l === sel);

      const dayLabels = ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => t(k));

      let html = `<div class="cal-filter-bar">
        <label class="cal-filter-label">${t('ui.cal_filter_line')}</label>
        <select class="cal-filter-select" id="cal-line-select">
          <option value="all"${sel === 'all' ? ' selected' : ''}>${t('ui.all_lines_count', {count: lines.length})}</option>
          ${lines.map(l => `<option value="${l}"${sel === l ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
        ${sel !== 'all' ? `<button class="cal-filter-clear" onclick="NIMBUS.Calendar._clearLineFilter()">${t('btn.show_all')}</button>` : ''}
      </div>`;

      html += `<div class="hours-tbl-wrap"><table class="hours-tbl">
        <thead><tr>
          <th class="col-head">${t('ui.line_label')}</th>
          ${dayLabels.map(d => `<th class="col-head">${d}</th>`).join('')}
        </tr></thead>
        <tbody>`;

      shownLines.forEach((line) => {
        const li = lines.indexOf(line);
        const color = Config.COLORS[li % Config.COLORS.length];
        const cal = Store.calendars[line].workHours;
        html += `<tr>
          <td><div class="line-label"><span class="line-dot" style="background:${color}"></span>${line}</div></td>`;
        for (let d = 0; d < 7; d++) {
          const wh = cal[d];
          const off = !wh;
          html += `<td><div class="hours-cell ${off ? 'off':''}" data-line="${line}" data-day="${d}">
            <input type="time" class="hours-start" value="${off ? '' : Calendar._hToT(wh[0])}">
            <span class="dash">–</span>
            <input type="time" class="hours-end" value="${off ? '' : Calendar._hToT(wh[1])}">
          </div></td>`;
        }
        html += `</tr>`;
      });
      html += `</tbody></table></div>`;

      body.innerHTML = html;

      // Wire line selector
      document.getElementById('cal-line-select').onchange = function() {
        Calendar._lineFilter = this.value;
        Calendar.render();
      };

      // Wire up inputs
      body.querySelectorAll('.hours-cell').forEach(cell => {
        const line = cell.dataset.line;
        const day  = +cell.dataset.day;
        const inS  = cell.querySelector('.hours-start');
        const inE  = cell.querySelector('.hours-end');
        const upd = () => {
          const vs = inS.value, ve = inE.value;
          const cal = Store.calendars[line].workHours;
          if (!vs || !ve) { cal[day] = null; cell.classList.add('off'); }
          else {
            cal[day] = [Calendar._tToH(vs), Calendar._tToH(ve)];
            cell.classList.remove('off');
          }
          Store.emit({ type: 'calendar:change', line, source: 'calendar' });
          Toast.show(t('toast.calendar_updated'), 'success');
        };
        flatpickr(inS, { enableTime: true, noCalendar: true, dateFormat: 'H:i', altInput: true, altFormat: 'h:i K', onChange: upd });
        flatpickr(inE, { enableTime: true, noCalendar: true, dateFormat: 'H:i', altInput: true, altFormat: 'h:i K', onChange: upd });
      });

      Calendar._renderBlocks();
    },

    _clearLineFilter() {
      Calendar._lineFilter = 'all';
      Calendar.render();
    },

    _renderBlocks() {
      const list = document.getElementById('cal-blocks-list');
      if (!list) return;
      const lines     = Calendar._getLines();
      const bFilter   = Calendar._blockFilter || 'all';
      const allBlocks = Store.blocks.slice().sort((a,b) => Util.parseDate(a.start) - Util.parseDate(b.start));
      const blocks    = bFilter === 'all' ? allBlocks : allBlocks.filter(b => !b.line || b.line === bFilter);

      let html = `<div class="cal-filter-bar">
        <label class="cal-filter-label">${t('ui.filter_label')}</label>
        <select class="cal-filter-select" id="cal-block-filter">
          <option value="all"${bFilter === 'all' ? ' selected' : ''}>${t('ui.all_lines_filter')}</option>
          ${lines.map(l => `<option value="${l}"${bFilter === l ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
        <span class="cal-block-count">${t('ui.blocks_count', {count: blocks.length, plural: blocks.length !== 1 ? 's' : ''})}</span>
      </div>`;

      if (!blocks.length) {
        html += `<div class="empty-state">${bFilter !== 'all' ? t('empty.no_blocks_for_line') : t('empty.no_blackouts_line')}</div>`;
      } else {
        html += blocks.map(b => `
          <div class="block-row" style="padding-left:6px;padding-right:6px;">
            <span class="ico">■</span>
            <span class="reason">${b.reason || t('ui.blackouts_label', {plural: ''})}</span>
            <span class="line-tag">${b.line || t('ui.all_lines_filter')}</span>
            <span class="range" title="${Util.fmtDTReadable(b.start)} → ${Util.fmtDTReadable(b.end)}">${Util.fmtBlockRange(b.start, b.end)}</span>
            <button class="btn btn-ghost sm" style="padding:2px 7px;font-size:14px;" title="${t('tip.remove_block')}" onclick="NIMBUS.Calendar.removeBlock('${b.id}')">×</button>
          </div>
        `).join('');
      }

      list.innerHTML = html;

      const blockSelect = document.getElementById('cal-block-filter');
      if (blockSelect) blockSelect.onchange = function() {
        Calendar._blockFilter = this.value;
        Calendar._renderBlocks();
      };
    },

    removeBlock(id) {
      Store.removeBlock(id, 'calendar');
      Toast.show(t('toast.block_removed'), 'success');
    },

    openBlockModal() {
      const lineSel = document.getElementById('blk-line');
      lineSel.innerHTML = `<option value="">${t('ui.all_lines_filter')}</option>` +
        Calendar._getLines().map(l => `<option value="${l}">${l}</option>`).join('');

      const now = new Date(); now.setMinutes(0, 0, 0);
      const plus1 = new Date(now.getTime() + 3600000);
      if (!Calendar._fpBlkStart) {
        Calendar._fpBlkStart = flatpickr('#blk-start', {
          enableTime: true, dateFormat: 'Y-m-d\\TH:i',
          altInput: true, altFormat: 'M j, Y · h:i K', minuteIncrement: 30,
        });
        Calendar._fpBlkEnd = flatpickr('#blk-end', {
          enableTime: true, dateFormat: 'Y-m-d\\TH:i',
          altInput: true, altFormat: 'M j, Y · h:i K', minuteIncrement: 30,
        });
      }
      Calendar._fpBlkStart.setDate(now, false);
      Calendar._fpBlkEnd.setDate(plus1, false);
      document.getElementById('blk-reason').value = '';
      Modal.open('modal-block');
    },

    saveBlockFromModal() {
      const line   = document.getElementById('blk-line').value || null;
      const start  = Util.parseDate(document.getElementById('blk-start').value);
      const end    = Util.parseDate(document.getElementById('blk-end').value);
      const reason = document.getElementById('blk-reason').value.trim() || t('ui.blackouts_label', {plural: ''});
      if (!start || !end) { Toast.show(t('toast.please_set_start_end'), 'error'); return; }
      if (end <= start)   { Toast.show(t('toast.end_must_be_after_start'), 'error'); return; }
      Store.addBlock({ line, start, end, reason }, 'calendar');
      Modal.close('modal-block');
      Toast.show(t('toast.block_added'), 'success');
    },

    _getLines() {
      const set = new Set();
      Store.tasksArr.forEach(t => set.add(t.PRODUCTION_LINE || 'Unknown'));
      Object.keys(Store.calendars).forEach(l => set.add(l));
      return [...set].sort();
    },
    _hToT(h) {
      const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
      return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
    },
    _tToH(t) {
      const [h, m] = t.split(':').map(Number);
      return h + (m / 60);
    }
  };

  /* =============================================================================
     PLANT — plant-level calendar UI (working hours, blackouts, lines roster).
     ========================================================================== */
  const Plant = {
    _blocksCollapsed: true,
    _rosterCollapsed: true,
    _cwMeta: {},           // cached color wheel metadata: { [plant]: {filename, row_count, uploaded_at} }
    _cwLoading: false,     // prevent concurrent fetches
    _currentPlantTab: 'general',

    init() {
      Store.subscribe(evt => {
        if (evt.type === 'plant:selected') {
          const onPlantSub = (typeof App !== 'undefined')
            && App._currentTab === 'masterdata'
            && App._currentMasterSub === 'plant';
          if (onPlantSub) {
            Plant.render();
          }
          // Update plant badge in header whenever selection changes
          const badge = document.querySelector('#md-master-plant-pane .plant-badge');
          if (badge) badge.textContent = Store.selectedPlant || '—';
        }
      });
    },

    render() {
      const plantName = Store.selectedPlant;
      const badge = document.querySelector('#md-master-plant-pane .plant-badge');
      if (badge) badge.textContent = plantName || '—';
      Plant.gotoTab(Plant._currentPlantTab || 'general');
      Plant._renderHours();
      Plant._renderBlocks();
      Plant._renderRoster();
    },

    gotoTab(tab) {
      if (!['general', 'optimization', 'settings'].includes(tab)) return;
      Plant._currentPlantTab = tab;
      document.querySelectorAll('.plant-inner-tabs .sub-subtab').forEach(b => {
        b.classList.toggle('active', b.dataset.plantTab === tab);
      });
      ['general', 'optimization', 'settings'].forEach(t => {
        const el = document.getElementById(`plant-tab-${t}`);
        if (el) el.hidden = (t !== tab);
      });
      if (tab === 'settings') App._renderSettingsPane();
      else if (tab === 'optimization') Plant._fetchAndRenderOptimization(Store.selectedPlant);
    },

    toggleBlocksList() {
      Plant._blocksCollapsed = !Plant._blocksCollapsed;
      const list = document.getElementById('plant-blocks-list');
      const btn  = document.getElementById('plant-blk-toggle');
      if (list) list.style.display = Plant._blocksCollapsed ? 'none' : '';
      if (btn)  btn.textContent = Plant._blocksCollapsed ? '▼' : '▲';
    },

    toggleRosterList() {
      Plant._rosterCollapsed = !Plant._rosterCollapsed;
      const wrap = document.getElementById('plant-roster-wrap');
      const btn  = document.getElementById('plant-roster-toggle');
      if (wrap) wrap.style.display = Plant._rosterCollapsed ? 'none' : '';
      if (btn)  btn.textContent = Plant._rosterCollapsed ? '▼' : '▲';
    },

    _renderHours() {
      const body = document.getElementById('plant-hours-body');
      if (!body) return;
      const plantName = Store.selectedPlant;
      if (!plantName) { body.innerHTML = '<p class="plant-no-sel">Select a plant in the top bar to manage its hours.</p>'; return; }
      Store.ensurePlant(plantName);
      const plant = Store.plants[plantName];

      if (Plant._pillFps) {
        Plant._pillFps.forEach(p => { p.start?.destroy(); p.end?.destroy(); });
      }
      Plant._pillFps = Array(7).fill(null).map(() => ({ start: null, end: null }));
      const dayLabels = ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => t(k));

      const pillsHtml = [0,1,2,3,4,5,6].map(d => {
        const wh = plant.workHours[d];
        const time = wh ? `${ProdLines._fmtHour(wh[0])}–${ProdLines._fmtHour(wh[1])}` : t('ui.off');
        const hrs = wh ? (() => { const h = wh[1] - wh[0]; return h % 1 === 0 ? `${h}h` : `${h.toFixed(1)}h`; })() : '—';
        return `<div class="line-hours-pill ${wh ? 'on' : 'off'}" data-day="${d}"
          onclick="NIMBUS.Plant._pillClick(${d})"
          oncontextmenu="NIMBUS.Plant._pillRightClick(${d}, event)">
          <span class="lhp-day">${dayLabels[d]}</span>
          <span class="lhp-time">${time}</span>
          <span class="lhp-hrs">${hrs}</span>
          <input id="plant-pill-start-${d}" class="phwi-anchor" readonly>
          <input id="plant-pill-end-${d}"   class="phwi-anchor" readonly>
        </div>`;
      }).join('');

      body.innerHTML = `<div class="line-hours-pills">${pillsHtml}</div>`;

      requestAnimationFrame(() => {
        const p = Store.plants[Store.selectedPlant];
        for (let d = 0; d < 7; d++) {
          const wh = p.workHours[d];
          const onClose = () => Plant._pillSave(d);
          Plant._pillFps[d].start = flatpickr(`#plant-pill-start-${d}`, {
            enableTime: true, noCalendar: true, dateFormat: 'H:i',
            minuteIncrement: 30,
            defaultDate: wh ? Calendar._hToT(wh[0]) : '08:00',
            onClose,
          });
          Plant._pillFps[d].end = flatpickr(`#plant-pill-end-${d}`, {
            enableTime: true, noCalendar: true, dateFormat: 'H:i',
            minuteIncrement: 30,
            defaultDate: wh ? Calendar._hToT(wh[1]) : '17:00',
            onClose,
          });
        }
      });
    },

    _pillClick(d) {
      const pName = Store.selectedPlant;
      if (!pName) return;
      const plant = Store.plants[pName];
      const wh = plant.workHours[d];
      if (!wh) {
        Store.setPlantWorkHours(pName, d, [8, 17], 'pill');
        for (let i = 0; i < 7; i++) Store.clampLinesToPlant(pName, i);
        Plant._renderHours();
        Toast.show(t('day.sun_enabled', { day: ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => t(k))[d] }), 'success');
        return;
      }
      const pill = document.querySelector(`.line-hours-pill[data-day="${d}"]`);
      if (pill) pill.classList.add('editing');
      Plant._pillFps[d]?.start?.open();
    },

    _pillSave(d) {
      const pName = Store.selectedPlant;
      if (!pName) return;
      const pair = Plant._pillFps[d];
      if (!pair?.start || !pair?.end) return;
      const sv = pair.start.element.value;
      const ev = pair.end.element.value;
      if (!sv || !ev) {
        Store.setPlantWorkHours(pName, d, null, 'pill');
      } else {
        const sh = Calendar._tToH(sv), eh = Calendar._tToH(ev);
        if (eh <= sh) { Toast.show(t('toast.end_must_be_after_start'), 'error'); return; }
        Store.setPlantWorkHours(pName, d, [sh, eh], 'pill');
      }
      for (let i = 0; i < 7; i++) Store.clampLinesToPlant(pName, i);
      Plant._renderHours();
      Toast.show(t('toast.plant_hours_updated'), 'success');
    },

    _pillRightClick(d, e) {
      e.preventDefault();
      document.querySelector('.pill-ctx-menu')?.remove();

      const pName = Store.selectedPlant;
      if (!pName) return;
      const plant = Store.plants[pName];
      const wh = plant?.workHours[d];
      const dayName = ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => t(k))[d];

      const menu = document.createElement('div');
      menu.className = 'pill-ctx-menu';
      menu.innerHTML = wh
        ? `<button data-action="off">${t('day.set_off', { day: dayName })}</button>`
        : `<button data-action="on">${t('day.reset_on', { day: dayName })}</button>`;

      menu.querySelector('button').onclick = () => {
        const _pName = Store.selectedPlant;
        menu.remove();
        if (wh) {
          Store.setPlantWorkHours(_pName, d, null, 'pill');
          Toast.show(t('day.set_to_off', { day: dayName }), 'success');
        } else {
          Store.setPlantWorkHours(_pName, d, [8, 17], 'pill');
          Toast.show(t('day.sun_enabled', { day: dayName }), 'success');
        }
        for (let i = 0; i < 7; i++) Store.clampLinesToPlant(_pName, i);
        Plant._renderHours();
      };

      menu.style.left = e.clientX + 'px';
      menu.style.top  = e.clientY + 'px';
      document.body.appendChild(menu);

      requestAnimationFrame(() => {
        const r = menu.getBoundingClientRect();
        if (r.right  > window.innerWidth)  menu.style.left = (window.innerWidth  - r.width  - 6) + 'px';
        if (r.bottom > window.innerHeight) menu.style.top  = (window.innerHeight - r.height - 6) + 'px';
      });

      const dismiss = ev => {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', dismiss); }
      };
      const dismissKey = ev => {
        if (ev.key === 'Escape') { menu.remove(); document.removeEventListener('keydown', dismissKey); }
      };
      setTimeout(() => {
        document.addEventListener('mousedown', dismiss);
        document.addEventListener('keydown', dismissKey);
      }, 0);
    },

    _renderBlocks() {
      const list    = document.getElementById('plant-blocks-list');
      const statsEl = document.getElementById('plant-blocks-stats');
      if (!list) return;

      const blocks = (Store.plantBlocks || []).slice()
        .sort((a, b) => Util.parseDate(a.start) - Util.parseDate(b.start));

      if (statsEl) {
        if (blocks.length) {
          const totalDays = blocks.reduce((acc, b) =>
            acc + Math.ceil((Util.parseDate(b.end) - Util.parseDate(b.start)) / 86400000), 0);
          const chevron = Plant._blocksCollapsed ? '▼' : '▲';
          statsEl.innerHTML = `<div class="plant-blk-stats" style="display:flex;align-items:center;justify-content:space-between;">
            <div style="display:flex;align-items:center;gap:16px;">
              <div class="plant-blk-stat" style="padding:0 4px;">
                <span class="pbs-val">${blocks.length}</span>
                <span class="pbs-lbl">${t('ui.blackouts_label', {plural: blocks.length !== 1 ? 's' : ''})}</span>
              </div>
              <div class="plant-blk-stats-sep"></div>
              <div class="plant-blk-stat" style="padding:0 4px;">
                <span class="pbs-val">${totalDays}</span>
                <span class="pbs-lbl">${t('ui.days_blocked', {plural: totalDays !== 1 ? 's' : ''})}</span>
              </div>
            </div>
            <button id="plant-blk-toggle" class="btn btn-ghost sm" onclick="NIMBUS.Plant.toggleBlocksList()" title="${t('ui.toggle_list')}" style="font-size:11px;padding:2px 8px;min-width:28px;">${chevron}</button>
          </div>`;
        } else {
          statsEl.innerHTML = '';
        }
      }

      if (!blocks.length) {
        list.innerHTML = `<div class="empty-state">${t('empty.no_plant_blackouts')}</div>`;
        return;
      }

      list.innerHTML = blocks.map(b => `
        <div class="block-row" style="padding-left:6px;padding-right:6px;">
          <span class="ico">■</span>
          <span class="reason">${b.reason || t('ui.blackouts_label', {plural: ''})}</span>
          <span class="range" title="${Util.fmtDTReadable(b.start)} → ${Util.fmtDTReadable(b.end)}">${Util.fmtBlockRange(b.start, b.end)}</span>
          <button class="btn btn-ghost sm" style="padding:2px 7px;font-size:14px;" title="${t('tip.remove_block')}" onclick="NIMBUS.Plant.removePlantBlock('${b.id}')">×</button>
        </div>
      `).join('');
      list.style.display = Plant._blocksCollapsed ? 'none' : '';
    },

    _renderRoster() {
      const roster = document.getElementById('plant-lines-roster');
      if (!roster) return;
      const lines = Store.linesForSelectedPlant();
      const countEl = document.getElementById('plant-lines-count');
      if (countEl) countEl.textContent = t('ui.lines_count', {count: lines.length, plural: lines.length !== 1 ? 's' : ''});

      if (!lines.length) {
        roster.innerHTML = `<div class="empty-state">${t('empty.no_production_lines')}</div>`;
        return;
      }

      const thStyle = 'padding:8px 12px;font-size:12px;font-weight:600;position:sticky;top:0;z-index:2;background:var(--surface,#fff);border-bottom:1px solid var(--border,#e2e8f0);';
      const thStyleBlank = 'padding:8px 12px;position:sticky;top:0;z-index:2;background:var(--surface,#fff);border-bottom:1px solid var(--border,#e2e8f0);';
      const dayLabels = ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => t(k));

      roster.innerHTML = `<table style="width:100%;border-collapse:collapse;">
        <thead><tr style="text-align:left;">
          <th style="${thStyle}">${t('ui.line_label')}</th>
          <th style="${thStyle}">${t('ui.roster_important_flags')}</th>
          <th style="${thStyle}">${t('ui.roster_schedule')}</th>
          <th style="${thStyle}">Production Line Group</th>
          <th style="${thStyleBlank}"></th>
        </tr></thead>
        <tbody>
          ${lines.map((line, li) => {
            const color = Config.COLORS[li % Config.COLORS.length];
            const ls = Store.lineSettings[line] || {};
            const botBadge = ls.bottleneck
              ? `<span style="background:#f59e0b;color:#fff;font-size:11px;padding:2px 6px;border-radius:4px;">${t('ui.bottleneck')}</span>`
              : '';
            const exclBadge = ls.excludeFromOpt
              ? `<span style="background:#6366f1;color:#fff;font-size:11px;padding:2px 6px;border-radius:4px;">${t('ui.excl_optimizer')}</span>`
              : '';
            const cal = Store.calendars[line]?.workHours || {};
            const schedCells = [0,1,2,3,4,5,6].map(d => {
              const wh = cal[d];
              const timeStr = wh ? `${ProdLines._fmtHour(wh[0])}–${ProdLines._fmtHour(wh[1])}` : t('ui.off');
              const timeColor = wh ? '#1e293b' : '#ef4444';
              return `<div style="text-align:center;font-size:11px;line-height:1.4;min-width:56px;">
                <div style="font-weight:600;color:#64748b;">${dayLabels[d]}</div>
                <div style="color:${timeColor};">${timeStr}</div>
              </div>`;
            }).join('');
            const safeId = line.replace(/'/g, "\\'");
            const plgVal = (ls.plGroup || '').replace(/"/g, '&quot;');
            return `<tr style="border-bottom:1px solid var(--border,#f1f5f9);">
              <td style="padding:8px 12px;"><div class="line-label"><span class="line-dot" style="background:${color}"></span>${line}</div></td>
              <td style="padding:8px 12px;">${botBadge}${exclBadge ? ' ' + exclBadge : ''}</td>
              <td style="padding:8px 12px;">
                <div style="display:flex;gap:6px;align-items:flex-start;">${schedCells}</div>
              </td>
              <td style="padding:8px 12px;">
                <input type="text" class="input roster-plgroup-input" style="width:120px;font-size:12px;" value="${plgVal}" data-line="${line}" placeholder="—">
              </td>
              <td style="padding:8px 12px;text-align:right;">
                <button class="btn btn-ghost sm" onclick="NIMBUS.App.goto('masterdata'); NIMBUS.App.gotoMasterSub('lines'); setTimeout(()=>{const el=document.getElementById('line-row-${safeId}');if(el)el.scrollIntoView({behavior:'smooth',block:'center'});},80);">Edit →</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;

      roster.querySelectorAll('.roster-plgroup-input').forEach(inp => {
        inp.onchange = function() {
          const val = this.value.trim();
          Store.setLineSetting(this.dataset.line, { plGroup: val }, 'plant-roster');
          MasterData.syncLineSettings(this.dataset.line, { plGroup: val });
          Toast.show(t('toast.line_settings_updated'), 'success');
        };
      });

      const wrap = document.getElementById('plant-roster-wrap');
      const btn  = document.getElementById('plant-roster-toggle');
      if (wrap) wrap.style.display = Plant._rosterCollapsed ? 'none' : '';
      if (btn)  btn.textContent = Plant._rosterCollapsed ? '▼' : '▲';
    },

    openBlockModal() {
      const now = new Date(); now.setMinutes(0, 0, 0);
      const plus1 = new Date(now.getTime() + 3600000);
      if (!Plant._fpBlkStart) {
        Plant._fpBlkStart = flatpickr('#plant-blk-start', {
          enableTime: true, dateFormat: 'Y-m-d\\TH:i',
          altInput: true, altFormat: 'M j, Y · h:i K', minuteIncrement: 30,
        });
        Plant._fpBlkEnd = flatpickr('#plant-blk-end', {
          enableTime: true, dateFormat: 'Y-m-d\\TH:i',
          altInput: true, altFormat: 'M j, Y · h:i K', minuteIncrement: 30,
        });
      }
      Plant._fpBlkStart.setDate(now, false);
      Plant._fpBlkEnd.setDate(plus1, false);
      document.getElementById('plant-blk-reason').value = '';
      Modal.open('modal-plant-block');
    },

    savePlantBlockFromModal() {
      const start  = Util.parseDate(document.getElementById('plant-blk-start').value);
      const end    = Util.parseDate(document.getElementById('plant-blk-end').value);
      const reason = document.getElementById('plant-blk-reason').value.trim() || t('ui.plant_blackout_default');
      if (!start || !end) { Toast.show(t('toast.please_set_start_end'), 'error'); return; }
      if (end <= start)   { Toast.show(t('toast.end_must_be_after_start'), 'error'); return; }
      if (!Store.selectedPlant) { Toast.show(t('toast.select_plant_first'), 'warn'); return; }
      Store.addPlantBlock({ plant: Store.selectedPlant, start, end, reason }, 'plant');
      Modal.close('modal-plant-block');
      Toast.show(t('toast.plant_blackout_added'), 'success');
    },

    removePlantBlock(id) {
      Store.removePlantBlock(id, 'plant');
      Toast.show(t('toast.plant_blackout_removed'), 'success');
    },

    /* ── Optimization Options section ── */

    _fetchAndRenderOptimization(plantName) {
      const panel = document.getElementById('plant-opt-panel');
      if (!panel) return;
      // Show spinner while fetching metadata
      const body = panel.querySelector('.panel-body');
      if (body) body.innerHTML = '<div class="cw-loading"><span class="cw-spin"></span>Loading…</div>';

      fetch(`${Config.API_BASE}/color-wheels`, { signal: AbortSignal.timeout(6000) })
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(data => {
          Plant._cwMeta = data.plants || {};
          Plant._renderOptimization(plantName);
        })
        .catch(() => {
          Plant._cwMeta = {};
          Plant._renderOptimization(plantName);
        });
    },

    _renderOptimization(plantName) {
      const body = document.getElementById('plant-opt-body');
      if (!body) return;
      const wheelInfo = Plant._cwMeta[plantName];
      const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

      const _relTime = ts => {
        if (!ts) return 'unknown';
        const diff = Math.round((Date.now() - new Date(ts)) / 1000);
        if (diff < 120)   return 'just now';
        if (diff < 3600)  return `${Math.floor(diff/60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
        return `${Math.floor(diff/86400)}d ago`;
      };

      let html;
      if (wheelInfo) {
        html = `
          <div class="cw-active-card">
            <div class="cw-active-icon">🎨</div>
            <div class="cw-active-info">
              <div class="cw-active-name">${esc(wheelInfo.filename || '—')}</div>
              <div class="cw-active-meta">${wheelInfo.row_count ?? '?'} colors &middot; uploaded ${_relTime(wheelInfo.uploaded_at)} by ${esc(wheelInfo.uploaded_by || 'system')}</div>
            </div>
            <div class="cw-active-actions">
              <button class="btn btn-ghost sm" onclick="NIMBUS.ColorWheelViewer.open('${esc(plantName)}')">👁 Preview</button>
              <button class="btn btn-ghost sm cw-delete-btn" onclick="NIMBUS.Plant._confirmDeleteWheel('${esc(plantName)}')">⌫ Remove</button>
            </div>
          </div>
          <div class="cw-dropzone cw-replace-zone" id="plant-cw-dropzone" title="Drop to replace or click to browse">
            <div class="cw-drop-inner">
              <span class="cw-drop-icon">↻</span>
              <span class="cw-drop-text">Drop new file to replace, or click to browse</span>
              <input type="file" id="plant-cw-file" accept=".xlsx,.xls" style="display:none">
            </div>
          </div>`;
      } else {
        html = `
          <div class="cw-empty-hint">
            No color wheel uploaded yet. Optimization will still run using the global fallback wheel, skipping color-priority ordering if that is also absent.
          </div>
          <div class="cw-dropzone" id="plant-cw-dropzone">
            <div class="cw-drop-inner">
              <span class="cw-drop-icon">📂</span>
              <span class="cw-drop-text">Drag a color wheel here, or click to browse</span>
              <div class="cw-drop-hint">.xlsx · must contain COLOR and ORDER_Y columns</div>
              <input type="file" id="plant-cw-file" accept=".xlsx,.xls" style="display:none">
            </div>
          </div>`;
      }

      html += `<div id="plant-cw-status" class="admin-status" style="margin-top:10px;"></div>`;
      body.innerHTML = html;

      // Wire drag-drop + click
      const zone = document.getElementById('plant-cw-dropzone');
      const fileInput = document.getElementById('plant-cw-file');
      if (zone && fileInput) {
        zone.onclick = e => { if (e.target !== fileInput) fileInput.click(); };
        fileInput.onchange = () => { if (fileInput.files[0]) Plant._uploadWheel(plantName, fileInput.files[0]); };
        zone.ondragover  = e => { e.preventDefault(); zone.classList.add('drag-over'); };
        zone.ondragleave = () => zone.classList.remove('drag-over');
        zone.ondrop = e => {
          e.preventDefault();
          zone.classList.remove('drag-over');
          const f = e.dataTransfer.files[0];
          if (f) Plant._uploadWheel(plantName, f);
        };
      }
    },

    _uploadWheel(plantName, file) {
      const status = document.getElementById('plant-cw-status');
      const zone   = document.getElementById('plant-cw-dropzone');
      if (status) { status.textContent = t('toast.uploading_file', { name: file.name }); status.className = 'admin-status info'; }
      if (zone)   zone.classList.add('uploading');

      const fd = new FormData();
      fd.append('file', file);
      fetch(`${Config.API_BASE}/color-wheel/${encodeURIComponent(plantName)}`, {
        method: 'POST', body: fd,
        headers: { 'X-User': 'trevor.holton@newellco.com' },
      })
        .then(r => r.json())
        .then(body => {
          if (zone) zone.classList.remove('uploading');
          if (body.status !== 'ok') {
            if (status) { status.textContent = t('toast.upload_failed', { msg: body.message || 'unknown' });  status.className = 'admin-status error'; }
            ErrorLog.error('plant', `Color wheel upload failed for ${plantName}: ${body.message}`, body);
            return;
          }
          const verb = body.replaced ? 'replaced' : 'uploaded';
          if (status) { status.textContent = t('ui.color_wheel_status', { verb, count: body.row_count }); status.className = 'admin-status success'; }
          Toast.show(t('toast.color_wheel_verb', { verb, plant: plantName }), 'success');
          ErrorLog.info('plant', `Color wheel ${verb} for ${plantName}: ${body.row_count} colors`);
          Plant._fetchAndRenderOptimization(plantName);
        })
        .catch(e => {
          if (zone) zone.classList.remove('uploading');
          if (status) { status.textContent = t('toast.upload_failed', { msg: e.message }); status.className = 'admin-status error'; }
          ErrorLog.error('plant', `Color wheel upload network error: ${e.message}`);
        });
    },

    async _confirmDeleteWheel(plantName) {
      const ok = await Modal.confirm({ title: t('modal.remove_color_wheel', { plant: plantName }), confirmLabel: t('btn.yes_delete') });
      if (!ok) return;
      fetch(`${Config.API_BASE}/color-wheel/${encodeURIComponent(plantName)}`, {
        method: 'DELETE',
        headers: { 'X-User': 'trevor.holton@newellco.com' },
      })
        .then(r => r.json())
        .then(body => {
          if (body.status !== 'ok' && body.status !== 'not_found') {
            Toast.show(t('toast.delete_failed'), 'error'); return;
          }
          Toast.show(t('toast.color_wheel_deleted', { plant: plantName }), 'success');
          ErrorLog.info('plant', `Color wheel deleted for ${plantName}`);
          Plant._fetchAndRenderOptimization(plantName);
        })
        .catch(e => Toast.show(t('toast.delete_failed_msg', { msg: e.message }), 'error'));
    }
  };

  /* =============================================================================
     PRODLINES — per-line settings: capacity buffer, bottleneck, working hours,
     and line-scoped blackout blocks.
     ========================================================================== */
  const ProdLines = {
    _lineFilter: '',
    _activeNavLine: null,

    render() {
      const body = document.getElementById('lines-body');
      if (!body) return;
      const allLines = Store.selectedPlant ? Store.linesForSelectedPlant() : Calendar._getLines();

      allLines.forEach(l => {
        Store.ensureCalendar(l);
        Store.ensureLineSettings(l);
      });

      const filterBar = document.getElementById('lines-filter-bar');
      if (filterBar) {
        filterBar.innerHTML = `
          <div style="display:flex;align-items:center;gap:6px;font-size:13px;">
            <span style="color:var(--text-muted,#64748b);">Plant</span>
            <span class="plant-badge">${Store.selectedPlant || '—'}</span>
          </div>`;
      }

      const shownLines = !ProdLines._lineFilter
        ? allLines
        : allLines.filter(l => l.toLowerCase().includes(ProdLines._lineFilter.toLowerCase()));

      // Default or reset active line if stale
      if (!ProdLines._activeNavLine || !allLines.includes(ProdLines._activeNavLine)) {
        ProdLines._activeNavLine = allLines[0] || null;
      }

      ProdLines._renderNav(allLines, shownLines);
      ProdLines._wireNav();

      if (!allLines.length) {
        body.innerHTML = `<div class="lines-detail-empty">${t('empty.no_lines_loaded')}</div>`;
        return;
      }

      ProdLines._renderDetail(ProdLines._activeNavLine);
    },

    _renderDetail(line) {
      const body = document.getElementById('lines-body');
      if (!body || !line) {
        if (body) body.innerHTML = `<div class="lines-detail-empty">${t('empty.select_line_configure')}</div>`;
        return;
      }

      const allLines = Store.selectedPlant ? Store.linesForSelectedPlant() : Calendar._getLines();
      const gi = allLines.indexOf(line);
      const color = Config.COLORS[gi % Config.COLORS.length];
      const ls = Store.lineSettings[line] || {};
      const cal = Store.calendars[line]?.workHours || {};
      const dayLabels = ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => t(k));

      const hoursPills = [0,1,2,3,4,5,6].map(d => {
        const wh = cal[d];
        const label = dayLabels[d];
        const time = wh ? `${ProdLines._fmtHour(wh[0])}–${ProdLines._fmtHour(wh[1])}` : t('ui.off');
        return `<div class="line-hours-pill ${wh ? 'on' : 'off'}">
          <span class="lhp-day">${label}</span>
          <span class="lhp-time">${time}</span>
        </div>`;
      }).join('');

      body.innerHTML = `<div class="lines-detail">
        <div class="ld-header">
          <span class="line-dot" style="background:${color};width:14px;height:14px;border-radius:50%;display:inline-block;flex-shrink:0;"></span>
          <span class="ld-name">${line}</span>
          <span class="plant-badge" style="margin-left:auto;">${Store.selectedPlant || '—'}</span>
        </div>
        <div class="ld-settings-row">
          <label class="ld-ctrl-label">
            <input type="checkbox" class="line-bottleneck-chk" ${ls.bottleneck ? 'checked' : ''} data-line="${line}">
            ${t('ui.bottleneck')}
          </label>
          <label class="ld-ctrl-label">
            <input type="checkbox" class="line-excl-opt-chk" ${ls.excludeFromOpt ? 'checked' : ''} data-line="${line}">
            ${t('ui.excl_optimizer_full')}
          </label>
          <span class="ld-buffer">
            <span class="ld-buffer-label">${t('ui.buffer_label')}</span>
            <span class="buf-seg">
              <button class="seg-btn buf-unit-btn ${ls.bufferUnit === 'pct' ? 'active' : ''}" data-line="${line}" data-unit="pct">%</button>
              <button class="seg-btn buf-unit-btn ${ls.bufferUnit === 'hours' ? 'active' : ''}" data-line="${line}" data-unit="hours">hrs</button>
            </span>
            <input type="number" class="input buf-pct-input" ${ls.bufferUnit !== 'pct' ? 'style="display:none"' : ''} min="0" max="100" step="1" value="${ls.bufferPct || 0}" data-line="${line}">
            <input type="number" class="input buf-hrs-input" ${ls.bufferUnit !== 'hours' ? 'style="display:none"' : ''} min="0" step="0.25" value="${ls.bufferHours || 0}" data-line="${line}">
          </span>
          <span class="ld-buffer">
            <span class="ld-buffer-label">Production Line Group</span>
            <input type="text" class="input plgroup-input" style="width:140px;" value="${(ls.plGroup||'').replace(/"/g,'&quot;')}" data-line="${line}" placeholder="e.g. PREMIUM">
          </span>
        </div>
        <div class="ld-section">
          <div class="ld-section-head">
            <span class="ld-section-title">${t('ui.working_hours_section')}</span>
            <button class="btn btn-ghost sm" onclick="NIMBUS.EditCalendar.open('${line}')">${t('btn.edit_calendar')}</button>
          </div>
          <div class="ld-section-body">
            <div class="line-hours-pills">${hoursPills}</div>
          </div>
        </div>
        <div class="ld-section">
          <div class="ld-section-head">
            <span class="ld-section-title">${t('ui.line_blackouts_section')}</span>
            <button class="btn btn-ghost sm" onclick="NIMBUS.ProdLines.openBlockModal('${line}')">+ Add</button>
          </div>
          <div class="ld-section-body">
            <div class="line-blocks-list" id="line-blocks-${line}">${ProdLines._renderLineBlocks(line)}</div>
          </div>
        </div>
      </div>`;

      ProdLines._wireInputs(body);
    },

    _renderNav(allLines, shownLines) {
      const nav = document.getElementById('lines-nav');
      if (!nav) return;
      const items = shownLines.map(line => {
        const gi = allLines.indexOf(line);
        const color = Config.COLORS[gi % Config.COLORS.length];
        const ls = Store.lineSettings[line] || {};
        const isActive = ProdLines._activeNavLine === line;
        return `<div class="lines-nav-item${isActive ? ' active' : ''}" data-line="${line}">
          <span class="line-dot" style="background:${color};display:inline-block;width:7px;height:7px;border-radius:50%;flex-shrink:0;"></span>
          <span class="lines-nav-label">${line}</span>
          ${ls.bottleneck ? '<span class="lines-nav-bottleneck" title="Bottleneck">🚧</span>' : ''}
          ${ls.excludeFromOpt ? '<span class="lines-nav-excl-opt" title="Excluded from optimization">🚫</span>' : ''}
        </div>`;
      }).join('');
      if (!document.getElementById('lines-nav-input')) {
        nav.innerHTML = `
          <div class="lines-nav-header">
            <div class="lines-nav-title" id="lines-nav-title">Lines &middot; ${allLines.length}</div>
            <input id="lines-nav-input" class="lines-nav-input" type="text" placeholder="${t('ph.search_lines')}" autocomplete="off" spellcheck="false">
          </div>
          <div class="lines-nav-list" id="lines-nav-list"></div>`;
      } else {
        const t = document.getElementById('lines-nav-title');
        if (t) t.textContent = `Lines · ${allLines.length}`;
        const inp = document.getElementById('lines-nav-input');
        if (inp) inp.value = ProdLines._lineFilter;
      }
      const listEl = document.getElementById('lines-nav-list');
      if (listEl) listEl.innerHTML = items || `<div class="lines-nav-empty">${t('ui.no_lines_match')}</div>`;
    },

    _wireNav() {
      const input = document.getElementById('lines-nav-input');
      if (input && !input._wired) {
        input._wired = true;
        input.oninput = function() {
          ProdLines._lineFilter = this.value;
          ProdLines.render();
        };
      }
      const list = document.getElementById('lines-nav-list');
      if (list) {
        list.onclick = function(e) {
          const item = e.target.closest('.lines-nav-item');
          if (!item) return;
          const line = item.dataset.line;
          ProdLines._activeNavLine = line;
          list.querySelectorAll('.lines-nav-item').forEach(i =>
            i.classList.toggle('active', i.dataset.line === line));
          ProdLines._renderDetail(line);
        };
      }
    },

    _renderLineBlocks(line) {
      const lineBlocks = (Store.blocks || [])
        .filter(b => b.line === line)
        .slice().sort((a, b) => Util.parseDate(a.start) - Util.parseDate(b.start));

      const plant = Store.getPlantForLine(line);
      const plantBlocks = (Store.plantBlocks || [])
        .filter(b => !b.plant || b.plant === plant)
        .slice().sort((a, b) => Util.parseDate(a.start) - Util.parseDate(b.start));

      if (!lineBlocks.length && !plantBlocks.length) {
        return `<div style="font-size:12px;color:var(--text-muted,#888);padding:4px 0;">${t('empty.no_blackouts_this_line')}</div>`;
      }

      const lineRows = lineBlocks.map(b => `
        <div class="block-row">
          <span class="ico">■</span>
          <span class="reason">${b.reason || t('ui.blackouts_label', {plural: ''})}</span>
          <span class="range" title="${Util.fmtDTReadable(b.start)} → ${Util.fmtDTReadable(b.end)}">${Util.fmtBlockRange(b.start, b.end)}</span>
          <button class="btn btn-ghost sm" style="padding:2px 7px;font-size:14px;" title="${t('tip.remove_block')}" onclick="NIMBUS.Calendar.removeBlock('${b.id}'); NIMBUS.ProdLines._renderDetail(NIMBUS.ProdLines._activeNavLine);">×</button>
        </div>`).join('');

      const plantRows = plantBlocks.map(b => `
        <div class="block-row" style="opacity:0.75;padding-left:6px;padding-right:6px;">
          <span class="ico" style="color:#d97706;">■</span>
          <span class="reason">${b.reason || t('ui.plant_blackout_default')}</span>
          <span class="line-tag" style="background:#fef3c7;color:#d97706;">Plant</span>
          <span class="range" title="${Util.fmtDTReadable(b.start)} → ${Util.fmtDTReadable(b.end)}">${Util.fmtBlockRange(b.start, b.end)}</span>
        </div>`).join('');

      return lineRows + plantRows;
    },

    _wireInputs(body) {
      body.querySelectorAll('.line-bottleneck-chk').forEach(chk => {
        chk.onchange = function() {
          Store.setLineSetting(this.dataset.line, { bottleneck: this.checked }, 'prodlines');
          MasterData.syncLineSettings(this.dataset.line, { bottleneck: this.checked });
          Toast.show(t('toast.line_settings_updated'), 'success');
        };
      });

      body.querySelectorAll('.line-excl-opt-chk').forEach(chk => {
        chk.onchange = function() {
          Store.setLineSetting(this.dataset.line, { excludeFromOpt: this.checked }, 'prodlines');
          MasterData.syncLineSettings(this.dataset.line, { excludeFromOpt: this.checked });
          Toast.show(t('toast.line_settings_updated'), 'success');
        };
      });

      body.querySelectorAll('.buf-unit-btn').forEach(btn => {
        btn.onclick = function() {
          Store.setLineSetting(this.dataset.line, { bufferUnit: this.dataset.unit }, 'prodlines');
          MasterData.syncLineSettings(this.dataset.line, { bufferUnit: this.dataset.unit });
          ProdLines._renderDetail(ProdLines._activeNavLine);
        };
      });

      body.querySelectorAll('.buf-pct-input').forEach(inp => {
        inp.onchange = function() {
          const val = Math.max(0, Math.min(100, +this.value || 0));
          Store.setLineSetting(this.dataset.line, { bufferPct: val }, 'prodlines');
          MasterData.syncLineSettings(this.dataset.line, { bufferPct: val });
          Toast.show(t('toast.buffer_updated'), 'success');
        };
      });

      body.querySelectorAll('.buf-hrs-input').forEach(inp => {
        inp.onchange = function() {
          const val = Math.max(0, +this.value || 0);
          Store.setLineSetting(this.dataset.line, { bufferHours: val }, 'prodlines');
          MasterData.syncLineSettings(this.dataset.line, { bufferHours: val });
          Toast.show(t('toast.buffer_updated'), 'success');
        };
      });

      body.querySelectorAll('.plgroup-input').forEach(inp => {
        inp.onchange = function() {
          const val = this.value.trim();
          Store.setLineSetting(this.dataset.line, { plGroup: val }, 'prodlines');
          MasterData.syncLineSettings(this.dataset.line, { plGroup: val });
          Toast.show(t('toast.line_settings_updated'), 'success');
        };
      });
    },

    _fmtHour(h) {
      const hh = Math.floor(h);
      const mm = Math.round((h - hh) * 60);
      const ampm = hh < 12 ? 'am' : 'pm';
      const h12  = hh % 12 || 12;
      return mm === 0 ? `${h12}${ampm}` : `${h12}:${String(mm).padStart(2, '0')}${ampm}`;
    },

    openBlockModal(line) {
      const lineSel = document.getElementById('lines-blk-line');
      lineSel.innerHTML = Calendar._getLines()
        .map(l => `<option value="${l}"${l === line ? ' selected' : ''}>${l}</option>`).join('');
      if (line) lineSel.value = line;

      const now = new Date(); now.setMinutes(0, 0, 0);
      const plus1 = new Date(now.getTime() + 3600000);
      if (!ProdLines._fpBlkStart) {
        ProdLines._fpBlkStart = flatpickr('#lines-blk-start', {
          enableTime: true, dateFormat: 'Y-m-d\\TH:i',
          altInput: true, altFormat: 'M j, Y · h:i K', minuteIncrement: 30,
        });
        ProdLines._fpBlkEnd = flatpickr('#lines-blk-end', {
          enableTime: true, dateFormat: 'Y-m-d\\TH:i',
          altInput: true, altFormat: 'M j, Y · h:i K', minuteIncrement: 30,
        });
      }
      ProdLines._fpBlkStart.setDate(now, false);
      ProdLines._fpBlkEnd.setDate(plus1, false);
      document.getElementById('lines-blk-reason').value = '';
      Modal.open('modal-lines-block');
    },

    saveBlockFromModal() {
      const line   = document.getElementById('lines-blk-line').value;
      const start  = Util.parseDate(document.getElementById('lines-blk-start').value);
      const end    = Util.parseDate(document.getElementById('lines-blk-end').value);
      const reason = document.getElementById('lines-blk-reason').value.trim() || t('ui.blackouts_label', {plural: ''});
      if (!line)          { Toast.show(t('toast.select_a_line'), 'error'); return; }
      if (!start || !end) { Toast.show(t('toast.please_set_start_end'), 'error'); return; }
      if (end <= start)   { Toast.show(t('toast.end_must_be_after_start'), 'error'); return; }
      Store.addBlock({ line, start, end, reason }, 'prodlines');
      Modal.close('modal-lines-block');
      Toast.show(t('toast.blackout_added'), 'success');
      ProdLines._renderDetail(ProdLines._activeNavLine);
    }
  };

  /* =============================================================================
     LABOR PLANNING — aggregate-to-line available labor hours planning
     Sub-tabs: Aggregate · Line Plan · Capacity · Exceptions · Inputs
     ========================================================================== */
  const LaborPlanning = (() => {
    // ── State ────────────────────────────────────────────────────────────────
    let _horizonOffset = 0;    // weeks offset from today's Monday
    let _horizonSpan   = 12;   // number of weeks in view
    let _selectedGroup = '';   // '' = all groups; used to scope Line Plan / Capacity
    let _aggrData      = {};   // { [plant]: { [grp]: { [period]: avail_hours } } }
    let _lineData      = {};   // { [plant]: { [line]: { [day]: { avail_hours, source } } } }
    let _groups        = [];   // sorted unique pl_group values for current plant
    let _weeks         = [];   // [{ key:'YYYY-Www', label:'MM/DD/YY', monday:Date }]
    let _selRange      = null; // { r0,c0,r1,c1 } lasso rectangle, or null
    let _dragging      = false;
    let _dragAnchor    = null;

    // ── Date helpers ─────────────────────────────────────────────────────────
    function _isoWeek(date) {
      const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
      const dayNum = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
      return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
    }

    function _weekLabel(monday) {
      const m = String(monday.getMonth() + 1).padStart(2, '0');
      const d = String(monday.getDate()).padStart(2, '0');
      const y = String(monday.getFullYear()).slice(-2);
      return `${m}/${d}/${y}`;
    }

    function _computeWeeks() {
      const now    = new Date();
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((now.getDay() + 6) % 7) + _horizonOffset * 7);
      const weeks = [];
      for (let i = 0; i < _horizonSpan; i++) {
        const d = new Date(monday); d.setDate(monday.getDate() + i * 7);
        weeks.push({ key: _isoWeek(d), label: _weekLabel(new Date(d)), monday: new Date(d) });
      }
      return weeks;
    }

    function _isoWeekToMonday(isoKey) {
      const [year, week] = isoKey.split('-W');
      const y = parseInt(year, 10), w = parseInt(week, 10);
      const jan4 = new Date(y, 0, 4);
      const dow  = jan4.getDay() || 7;
      const week1Mon = new Date(jan4); week1Mon.setDate(jan4.getDate() - (dow - 1));
      const monday   = new Date(week1Mon); monday.setDate(week1Mon.getDate() + (w - 1) * 7);
      return monday;
    }

    // ── Backend helpers ───────────────────────────────────────────────────────
    function _subnetwork(plant) {
      return (Store._state.masterData?.plants || []).find(p => p.plant === plant)?.subnetwork || '';
    }

    async function _saveAggregate(subnetwork, plant, cells) {
      try {
        const r = await fetch(`${Config.API_BASE}/labor-plan`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-user-email': 'trevor.holton@newellco.com' },
          body: JSON.stringify({ subnetwork, plant, cells }),
        });
        if (!r.ok) { const e = await r.json(); throw new Error(e.detail || `HTTP ${r.status}`); }
      } catch (e) {
        Toast.show(`Labor plan save failed: ${e.message}`, 'error');
        ErrorLog.error('labor', `Save aggregate failed: ${e.message}`);
      }
    }

    async function _saveLines(subnetwork, plant, cells) {
      if (!cells.length) return;
      try {
        const r = await fetch(`${Config.API_BASE}/labor-plan/line`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-user-email': 'trevor.holton@newellco.com' },
          body: JSON.stringify({ subnetwork, plant, cells }),
        });
        if (!r.ok) { const e = await r.json(); throw new Error(e.detail || `HTTP ${r.status}`); }
      } catch (e) {
        Toast.show(`Line plan save failed: ${e.message}`, 'error');
        ErrorLog.error('labor', `Save lines failed: ${e.message}`);
      }
    }

    async function _fetchAggregate(plant) {
      if (_aggrData[plant]) return _aggrData[plant];
      try {
        const res = await fetch(`${Config.API_BASE}/labor-plan?plant=${encodeURIComponent(plant)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const map = {};
        (json.rows || []).forEach(r => {
          if (!map[r.pl_group]) map[r.pl_group] = {};
          map[r.pl_group][r.period] = r.avail_hours;
        });
        _aggrData[plant] = map;
        return map;
      } catch (e) {
        ErrorLog.warn('labor', `Fetch aggregate failed for ${plant}: ${e.message}`);
        return {};
      }
    }

    async function _fetchLines(plant, group) {
      const w0 = _weeks[0], wN = _weeks[_weeks.length - 1];
      const from_date = Util.dayKey(w0.monday);
      const toDate    = new Date(wN.monday); toDate.setDate(wN.monday.getDate() + 6);
      const to_date   = Util.dayKey(toDate);
      try {
        let url = `${Config.API_BASE}/labor-plan/line?plant=${encodeURIComponent(plant)}&from_date=${from_date}&to_date=${to_date}`;
        if (group) url += `&group=${encodeURIComponent(group)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!_lineData[plant]) _lineData[plant] = {};
        (json.rows || []).forEach(r => {
          if (!_lineData[plant][r.production_line]) _lineData[plant][r.production_line] = {};
          _lineData[plant][r.production_line][r.day] = { avail_hours: r.avail_hours, source: r.source };
        });
      } catch (e) {
        ErrorLog.warn('labor', `Fetch lines failed: ${e.message}`);
      }
    }

    // ── Disaggregation ───────────────────────────────────────────────────────
    function _disaggregate(plant, group, periodKey, groupHours) {
      const lines = (Store._state.masterData?.lines || [])
        .filter(l => l.plant === plant && l.pl_group === group)
        .map(l => l.production_line);
      if (!lines.length) return [];

      const monday = _isoWeekToMonday(periodKey);
      const openSlots = [];
      lines.forEach(line => {
        for (let d = 0; d < 7; d++) {
          const date = new Date(monday); date.setDate(monday.getDate() + d);
          if (Calendar.effectiveCapacityHours(line, date) > 0)
            openSlots.push({ line, date, dayKey: Util.dayKey(date) });
        }
      });
      if (!openSlots.length) return [];

      const pinnedHours = openSlots.reduce((sum, s) => {
        const d = _lineData[plant]?.[s.line]?.[s.dayKey];
        return (d && d.source === 'override') ? sum + (d.avail_hours || 0) : sum;
      }, 0);
      const free = openSlots.filter(s => {
        const d = _lineData[plant]?.[s.line]?.[s.dayKey];
        return !d || d.source !== 'override';
      });
      if (!free.length) return [];
      const perSlot = Math.max(0, (groupHours || 0) - pinnedHours) / free.length;
      const rounded = Math.round(perSlot * 10) / 10;
      return free.map(s => ({ production_line: s.line, day: s.dayKey, avail_hours: rounded, source: 'auto_split' }));
    }

    // ── KPI strip ────────────────────────────────────────────────────────────
    function _renderKPIs(plant) {
      const strip = document.getElementById('labor-kpi-strip');
      if (!strip || !plant) { if (strip) strip.innerHTML = ''; return; }

      const planMap = _aggrData[plant] || {};
      let totalAvail = 0;
      _groups.forEach(g => _weeks.forEach(w => {
        const v = planMap[g]?.[w.key]; if (v != null) totalAvail += v;
      }));

      const horizonStart = _weeks[0]?.monday || new Date();
      const horizonDays  = Math.min(_horizonSpan * 7, 90);
      const matrix = Utilization.computeMatrix(horizonStart, horizonDays);
      const plantLines = (Store._state.masterData?.lines || []).filter(r => r.plant === plant).map(r => r.production_line);
      let totalRequired = 0;
      plantLines.forEach(line => {
        const lm = matrix[line]; if (!lm) return;
        Object.values(lm).forEach(cell => { totalRequired += cell.scheduled || 0; });
      });

      const diff     = totalAvail - totalRequired;
      const headroom = totalAvail > 0 ? Math.round((diff / totalAvail) * 100) : 0;
      const hSev     = headroom < 0 ? 'err' : headroom < 15 ? 'warn' : '';

      let shortfalls = 0;
      plantLines.forEach(line => {
        const lm = matrix[line]; if (!lm) return;
        Object.entries(lm).forEach(([dayKey, cell]) => {
          if (!cell.scheduled) return;
          const ld   = _lineData[plant]?.[line]?.[dayKey];
          const avail = ld?.avail_hours != null ? ld.avail_hours : (cell.effectiveCapacity || 0);
          if (cell.scheduled > avail + 0.05) shortfalls++;
        });
      });

      const fmtH = h => h >= 1000 ? `${(h / 1000).toFixed(1)}k` : h.toFixed(0);
      strip.innerHTML = `
        <div class="lp-kpi-tile">
          <span class="lp-kpi-label">Available</span>
          <span class="lp-kpi-val">${fmtH(totalAvail)}h</span>
          <span class="lp-kpi-sub">${_horizonSpan} wk horizon</span>
        </div>
        <div class="lp-kpi-tile">
          <span class="lp-kpi-label">Required</span>
          <span class="lp-kpi-val">${fmtH(totalRequired)}h</span>
          <span class="lp-kpi-sub">from scheduled orders</span>
        </div>
        <div class="lp-kpi-tile${hSev ? ' lp-kpi-' + hSev : ''}">
          <span class="lp-kpi-label">Headroom</span>
          <span class="lp-kpi-val">${headroom}%</span>
          <span class="lp-kpi-sub">${fmtH(Math.abs(diff))}h ${diff >= 0 ? 'surplus' : 'deficit'}</span>
        </div>
        <div class="lp-kpi-tile${shortfalls > 0 ? ' lp-kpi-err' : ''}">
          <span class="lp-kpi-label">Shortfalls</span>
          <span class="lp-kpi-val">${shortfalls}</span>
          <span class="lp-kpi-sub">line·day cells</span>
        </div>`;
    }

    // ── Aggregate sub-tab ────────────────────────────────────────────────────
    function _clearSelection() {
      _selRange = null; _dragging = false; _dragAnchor = null;
      document.querySelectorAll('.lp-selected-td').forEach(el => el.classList.remove('lp-selected-td'));
    }

    function _renderSelection() {
      document.querySelectorAll('.lp-selected-td').forEach(el => el.classList.remove('lp-selected-td'));
      if (!_selRange) return;
      const { r0, c0, r1, c1 } = _selRange;
      const g = document.getElementById('labor-grid'); if (!g) return;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const grp = _groups[r]; const period = _weeks[c]?.key; if (!grp || !period) continue;
        const inp = g.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`);
        inp?.closest('td')?.classList.add('lp-selected-td');
      }
    }

    function _updateAggrTotals(grid) {
      const plant = Store.selectedPlant; if (!plant || !_aggrData[plant]) return;
      const tds = grid.querySelectorAll('tbody tr:last-child td');
      _weeks.forEach((w, i) => {
        const total = Object.values(_aggrData[plant]).reduce((sum, p) => sum + (p[w.key] ?? 0), 0);
        if (tds[i + 1]) tds[i + 1].textContent = total > 0 ? total.toFixed(1) : '—';
      });
    }

    function _deleteSelected() {
      if (!_selRange) return;
      const plant = Store.selectedPlant; if (!plant) return;
      if (!_aggrData[plant]) _aggrData[plant] = {};
      const { r0, c0, r1, c1 } = _selRange;
      const cleared = [], prev = [];
      const g = document.getElementById('labor-grid');
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const grp = _groups[r]; const period = _weeks[c]?.key; if (!grp || !period) continue;
        prev.push({ pl_group: grp, period, avail_hours: _aggrData[plant]?.[grp]?.[period] ?? null });
        if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
        delete _aggrData[plant][grp][period];
        cleared.push({ pl_group: grp, period, avail_hours: null });
        const inp = g?.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`);
        if (inp) inp.value = '';
      }
      if (!cleared.length) return;
      if (g) _updateAggrTotals(g);
      _clearSelection();
      const sn = _subnetwork(plant);
      UndoStack.push(`Delete ${cleared.length} labor cell${cleared.length !== 1 ? 's' : ''}`, () => {
        if (!_aggrData[plant]) _aggrData[plant] = {};
        prev.forEach(({ pl_group: grp, period, avail_hours: old }) => {
          if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
          if (old == null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = old;
        });
        const g2 = document.getElementById('labor-grid');
        if (g2) {
          prev.forEach(({ pl_group: grp, period, avail_hours: old }) => {
            const el = g2.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`);
            if (el) el.value = old != null ? old : '';
          });
          _updateAggrTotals(g2);
        }
        _saveAggregate(sn, plant, prev);
      });
      _saveAggregate(sn, plant, cleared);
    }

    function _copySelected() {
      if (!_selRange) return;
      const plant = Store.selectedPlant;
      const { r0, c0, r1, c1 } = _selRange;
      const rows = [];
      for (let r = r0; r <= r1; r++) {
        const cols = [];
        for (let c = c0; c <= c1; c++) {
          const grp = _groups[r]; const period = _weeks[c]?.key;
          const ah = grp && period ? (_aggrData[plant]?.[grp]?.[period] ?? null) : null;
          cols.push(ah != null ? String(ah) : '');
        }
        rows.push(cols.join('\t'));
      }
      const count = (r1 - r0 + 1) * (c1 - c0 + 1);
      navigator.clipboard.writeText(rows.join('\n'))
        .then(() => Toast.show(`Copied ${count} cell${count !== 1 ? 's' : ''}`, 'success'))
        .catch(() => Toast.show('Copy failed — check clipboard permissions', 'error'));
    }

    async function _renderAggregate(plant) {
      const grid = document.getElementById('labor-grid'); if (!grid) return;
      const planMap = await _fetchAggregate(plant);
      const thS = 'padding:8px 10px;font-size:12px;font-weight:600;background:var(--bg-elev);border-bottom:2px solid var(--line);white-space:nowrap;position:sticky;top:0;z-index:1;';
      const tdS = 'padding:6px 8px;border-bottom:1px solid var(--line);';
      const inS = 'width:72px;text-align:center;padding:3px 6px;font-size:13px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg);font-family:inherit;';
      const totals = {}; _weeks.forEach(w => { totals[w.key] = 0; });
      const groupRows = _groups.map(grp => {
        const cells = _weeks.map(w => {
          const ah = planMap[grp]?.[w.key]; if (ah != null) totals[w.key] += ah;
          return `<td style="${tdS};text-align:center;">
            <input type="number" class="lp-cell" data-group="${grp.replace(/"/g,'&quot;')}" data-period="${w.key}" min="0" step="0.5" style="${inS}" value="${ah != null ? ah : ''}" placeholder="—">
          </td>`;
        }).join('');
        return `<tr><td style="${tdS};font-weight:600;white-space:nowrap;min-width:140px;">${grp}</td>${cells}</tr>`;
      }).join('');
      const totalCells = _weeks.map(w => {
        const v = totals[w.key];
        return `<td style="${tdS};text-align:center;font-weight:700;font-family:'JetBrains Mono',monospace;">${v > 0 ? v.toFixed(1) : '—'}</td>`;
      }).join('');
      grid.innerHTML = `
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead><tr>
              <th style="${thS};min-width:140px;">Group</th>
              ${_weeks.map(w => `<th style="${thS}">${w.label}</th>`).join('')}
            </tr></thead>
            <tbody>
              ${groupRows}
              <tr style="border-top:2px solid var(--line);">
                <td style="${tdS};font-weight:700;">TOTAL</td>${totalCells}
              </tr>
            </tbody>
          </table>
        </div>
        <p style="margin-top:8px;font-size:11px;color:var(--fg-faint);">Ctrl+drag to select · Delete to clear · Ctrl+C to copy · Paste from Excel · Values in hours</p>`;

      const sn = _subnetwork(plant);

      grid.addEventListener('mousedown', e => {
        if (!e.ctrlKey && !e.metaKey) { if (!e.target.closest('.lp-selected-td')) _clearSelection(); return; }
        const inp = e.target.closest('.lp-cell'); if (!inp) return;
        e.preventDefault();
        const ri = _groups.indexOf(inp.dataset.group), ci = _weeks.findIndex(w => w.key === inp.dataset.period);
        if (ri < 0 || ci < 0) return;
        _dragging = true; _dragAnchor = { row: ri, col: ci };
        _selRange = { r0: ri, c0: ci, r1: ri, c1: ci }; _renderSelection();
      });
      grid.addEventListener('mousemove', e => {
        if (!_dragging) return;
        const td = e.target.closest('td'); if (!td) return;
        const inp = td.querySelector('.lp-cell'); if (!inp) return;
        const ri = _groups.indexOf(inp.dataset.group), ci = _weeks.findIndex(w => w.key === inp.dataset.period);
        if (ri < 0 || ci < 0) return;
        _selRange = { r0: Math.min(_dragAnchor.row, ri), c0: Math.min(_dragAnchor.col, ci), r1: Math.max(_dragAnchor.row, ri), c1: Math.max(_dragAnchor.col, ci) };
        _renderSelection();
      });

      grid.querySelectorAll('.lp-cell').forEach(inp => {
        inp.onchange = async function() {
          const grp = this.dataset.group, period = this.dataset.period;
          const raw = this.value.trim();
          const ah  = raw === '' ? null : Math.max(0, parseFloat(raw) || 0);
          if (ah !== null) this.value = ah;
          const oldAh = _aggrData[plant]?.[grp]?.[period] ?? null;
          if (!_aggrData[plant]) _aggrData[plant] = {};
          if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
          if (ah === null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = ah;
          _updateAggrTotals(grid);
          _renderKPIs(plant);
          if (ah !== null) {
            const splits = _disaggregate(plant, grp, period, ah);
            if (splits.length) {
              if (!_lineData[plant]) _lineData[plant] = {};
              splits.forEach(c => {
                if (!_lineData[plant][c.production_line]) _lineData[plant][c.production_line] = {};
                _lineData[plant][c.production_line][c.day] = { avail_hours: c.avail_hours, source: c.source };
              });
              _saveLines(sn, plant, splits);
            }
          }
          UndoStack.push(`Labor: ${grp} / ${period}`, () => {
            if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
            if (oldAh == null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = oldAh;
            const el = document.getElementById('labor-grid')?.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`);
            if (el) el.value = oldAh != null ? oldAh : '';
            _updateAggrTotals(document.getElementById('labor-grid'));
            _saveAggregate(sn, plant, [{ pl_group: grp, period, avail_hours: oldAh }]);
          });
          await _saveAggregate(sn, plant, [{ pl_group: grp, period, avail_hours: ah }]);
        };
      });

      const table = grid.querySelector('table');
      if (table) table.addEventListener('paste', async e => {
        const anchor = document.activeElement?.classList.contains('lp-cell') ? document.activeElement : null;
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain'); if (!text) return;
        const clipRows = text.replace(/\r/g, '').split('\n').filter(r => r !== '').map(r => r.split('\t'));
        const cellMatrix = _groups.map(grp => _weeks.map(w => grid.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${w.key}"]`)));
        let anchorRow = 0, anchorCol = 0;
        if (anchor) {
          anchorRow = Math.max(0, _groups.indexOf(anchor.dataset.group));
          anchorCol = Math.max(0, _weeks.findIndex(w => w.key === anchor.dataset.period));
        }
        if (!_aggrData[plant]) _aggrData[plant] = {};
        const changed = [], prev = [], allSplits = [];
        clipRows.forEach((clipCols, r) => {
          clipCols.forEach((val, c) => {
            const ri = anchorRow + r, ci = anchorCol + c;
            if (ri >= _groups.length || ci >= _weeks.length) return;
            const inp = cellMatrix[ri]?.[ci]; if (!inp) return;
            const raw = val.trim().replace(/,/g, '');
            const ah  = raw === '' ? null : parseFloat(raw);
            if (ah !== null && (isNaN(ah) || ah < 0)) return;
            const grp = inp.dataset.group, period = inp.dataset.period;
            prev.push({ pl_group: grp, period, avail_hours: _aggrData[plant]?.[grp]?.[period] ?? null });
            inp.value = ah !== null ? ah : '';
            if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
            if (ah === null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = ah;
            changed.push({ pl_group: grp, period, avail_hours: ah });
            if (ah !== null) allSplits.push(..._disaggregate(plant, grp, period, ah));
          });
        });
        if (!changed.length) return;
        _updateAggrTotals(grid); _renderKPIs(plant);
        if (allSplits.length) {
          if (!_lineData[plant]) _lineData[plant] = {};
          allSplits.forEach(c => {
            if (!_lineData[plant][c.production_line]) _lineData[plant][c.production_line] = {};
            _lineData[plant][c.production_line][c.day] = { avail_hours: c.avail_hours, source: c.source };
          });
          _saveLines(sn, plant, allSplits);
        }
        UndoStack.push(`Undo paste (${changed.length} labor value${changed.length !== 1 ? 's' : ''})`, () => {
          if (!_aggrData[plant]) _aggrData[plant] = {};
          prev.forEach(({ pl_group: grp, period, avail_hours: old }) => {
            if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
            if (old == null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = old;
          });
          const g = document.getElementById('labor-grid');
          if (g) {
            prev.forEach(({ pl_group: grp, period, avail_hours: old }) => {
              const el = g.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`);
              if (el) el.value = old != null ? old : '';
            });
            _updateAggrTotals(g);
          }
          _saveAggregate(sn, plant, prev);
        });
        Toast.show(`Pasted ${changed.length} value${changed.length !== 1 ? 's' : ''}`, 'success');
        await _saveAggregate(sn, plant, changed);
      });
    }

    // ── Line Plan sub-tab ────────────────────────────────────────────────────
    async function _renderLinePlan(plant) {
      const grid = document.getElementById('labor-line-grid'); if (!grid) return;
      const group = _selectedGroup || _groups[0] || '';
      if (!group) {
        grid.innerHTML = `<div class="empty-state" style="padding:40px 0;">Select a group from the toolbar to view the line plan.</div>`; return;
      }
      const lines = (Store._state.masterData?.lines || [])
        .filter(l => l.plant === plant && l.pl_group === group).map(l => l.production_line).sort();
      if (!lines.length) {
        grid.innerHTML = `<div class="empty-state" style="padding:40px 0;">No production lines in group <strong>${group}</strong>.</div>`; return;
      }
      await _fetchLines(plant, group);

      // Build day columns
      const days = [];
      _weeks.forEach(w => {
        for (let d = 0; d < 7; d++) {
          const date = new Date(w.monday); date.setDate(w.monday.getDate() + d);
          days.push({ date, dayKey: Util.dayKey(date), weekKey: w.key });
        }
      });

      const horizonStart = _weeks[0].monday;
      const utilMatrix   = Utilization.computeMatrix(horizonStart, Math.min(_horizonSpan * 7, 84));
      const sn = _subnetwork(plant);

      const isDark = document.body.classList.contains('dark');
      function lerpRGB(a, b, t) {
        const p = h => [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
        const ca = p(a), cb = p(b);
        return `rgb(${Math.round(ca[0]+(cb[0]-ca[0])*t)},${Math.round(ca[1]+(cb[1]-ca[1])*t)},${Math.round(ca[2]+(cb[2]-ca[2])*t)})`;
      }
      const idle = isDark ? '#252730' : '#ede8de', low = isDark ? '#7a5a18' : '#c8a95a',
            mid  = isDark ? '#a8520f' : '#c96a1a', hot = isDark ? '#b32a1f' : '#991b1b';
      function heatBg(ratio) {
        if (ratio <= 0)   return idle;
        if (ratio <= 0.5) return lerpRGB(idle, low, ratio / 0.5);
        if (ratio <= 1.0) return lerpRGB(low, mid, (ratio - 0.5) / 0.5);
        return lerpRGB(mid, hot, Math.min((ratio - 1.0) / 0.25, 1));
      }

      const thS = 'padding:5px 6px;font-size:11px;font-weight:600;background:var(--bg-elev);border-bottom:2px solid var(--line);white-space:nowrap;text-align:center;position:sticky;top:0;z-index:1;min-width:52px;';
      const tdL = 'padding:6px 8px;border-bottom:1px solid var(--line);font-weight:600;white-space:nowrap;min-width:120px;font-size:12px;';
      const tdC = 'padding:4px 5px;border-bottom:1px solid var(--line);text-align:center;';
      const weekStarts = new Set(_weeks.map(w => Util.dayKey(w.monday)));

      const dayHeaders = days.map(d => {
        const wb = weekStarts.has(d.dayKey) ? 'border-left:2px solid var(--accent-soft);' : '';
        return `<th style="${thS}${wb}">${d.date.getMonth()+1}/${d.date.getDate()}</th>`;
      }).join('');

      const lineRows = lines.map(line => {
        const cells = days.map(d => {
          const wb   = weekStarts.has(d.dayKey) ? 'border-left:2px solid var(--accent-soft);' : '';
          const ld   = _lineData[plant]?.[line]?.[d.dayKey];
          const calCap = Calendar.effectiveCapacityHours(line, d.date);
          const avail  = ld?.avail_hours != null ? ld.avail_hours : calCap;
          const req    = utilMatrix[line]?.[d.dayKey]?.scheduled || 0;
          const ratio  = avail > 0 ? req / avail : (req > 0 ? 2 : 0);
          const bg     = avail === 0 ? 'var(--bg-subtle)' : heatBg(ratio);
          const isOvr  = ld?.source === 'override';
          const title  = `${line} · ${d.dayKey} | Available: ${avail.toFixed(1)}h | Required: ${req.toFixed(1)}h | Cal cap: ${calCap.toFixed(1)}h${isOvr ? ' | Pinned' : ''}`;
          return `<td style="${tdC}${wb}background:${bg};" title="${title}">
            <input type="number" class="lp-line-cell" data-line="${line.replace(/"/g,'&quot;')}" data-day="${d.dayKey}" min="0" step="0.5"
              style="width:46px;text-align:center;padding:2px 4px;font-size:11px;font-family:'JetBrains Mono',monospace;border:none;background:transparent;color:var(--fg);"
              value="${avail > 0 ? avail : ''}">${isOvr ? '<span class="lp-pin" title="Overridden">●</span>' : ''}</td>`;
        }).join('');
        return `<tr><td style="${tdL}">${line}</td>${cells}</tr>`;
      }).join('');

      grid.innerHTML = `
        <div style="margin-bottom:8px;font-size:12px;color:var(--fg-mute);">Group: <strong>${group}</strong> · ${lines.length} lines · Hover for detail · ● = overridden (right-click to reset)</div>
        <div style="overflow:auto;max-height:calc(100vh - 260px);">
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead><tr><th style="${thS};min-width:120px;text-align:left;">Line</th>${dayHeaders}</tr></thead>
            <tbody>${lineRows}</tbody>
          </table>
        </div>`;

      grid.querySelectorAll('.lp-line-cell').forEach(inp => {
        inp.onchange = async function() {
          const line = this.dataset.line, day = this.dataset.day;
          const raw  = this.value.trim();
          const ah   = raw === '' ? null : Math.max(0, parseFloat(raw) || 0);
          if (ah !== null) this.value = ah;
          if (!_lineData[plant]) _lineData[plant] = {};
          if (!_lineData[plant][line]) _lineData[plant][line] = {};
          const old    = _lineData[plant][line][day];
          const oldAh  = old?.avail_hours ?? null, oldSrc = old?.source ?? 'auto_split';
          const newSrc = ah !== null ? 'override' : 'auto_split';
          if (ah === null) delete _lineData[plant][line][day]; else _lineData[plant][line][day] = { avail_hours: ah, source: 'override' };
          const td = this.closest('td');
          if (td) {
            let pin = td.querySelector('.lp-pin');
            if (ah !== null) { if (!pin) { pin = document.createElement('span'); pin.className = 'lp-pin'; pin.title = 'Overridden'; pin.textContent = '●'; td.appendChild(pin); } }
            else if (pin) pin.remove();
          }
          UndoStack.push(`Line plan: ${line} / ${day}`, () => {
            if (!_lineData[plant][line]) _lineData[plant][line] = {};
            if (oldAh == null) delete _lineData[plant][line][day]; else _lineData[plant][line][day] = { avail_hours: oldAh, source: oldSrc };
            const el = grid.querySelector(`.lp-line-cell[data-line="${line.replace(/"/g,'&quot;')}"][data-day="${day}"]`);
            if (el) el.value = oldAh != null ? oldAh : '';
            _saveLines(sn, plant, [{ production_line: line, day, avail_hours: oldAh, source: oldSrc }]);
          });
          await _saveLines(sn, plant, [{ production_line: line, day, avail_hours: ah, source: newSrc }]);
        };

        inp.addEventListener('contextmenu', e => {
          e.preventDefault();
          const line = inp.dataset.line, day = inp.dataset.day;
          if (_lineData[plant]?.[line]?.[day]?.source !== 'override') return;
          const grp = (Store._state.masterData?.lines || []).find(l => l.production_line === line && l.plant === plant)?.pl_group;
          if (!grp) return;
          const periodKey = _weeks.find(w => {
            for (let d = 0; d < 7; d++) { const dd = new Date(w.monday); dd.setDate(w.monday.getDate() + d); if (Util.dayKey(dd) === day) return true; }
          })?.key;
          if (!periodKey) return;
          const groupHours = _aggrData[plant]?.[grp]?.[periodKey]; if (groupHours == null) return;
          const splits = _disaggregate(plant, grp, periodKey, groupHours);
          const resetCell = splits.find(c => c.production_line === line && c.day === day); if (!resetCell) return;
          _lineData[plant][line][day] = { avail_hours: resetCell.avail_hours, source: 'auto_split' };
          inp.value = resetCell.avail_hours || '';
          inp.closest('td')?.querySelector('.lp-pin')?.remove();
          _saveLines(sn, plant, [{ production_line: line, day, avail_hours: resetCell.avail_hours, source: 'auto_split' }]);
          Toast.show(`Reset ${line} · ${day} to even-split`, 'success');
        });
      });
    }

    // ── Capacity sub-tab ─────────────────────────────────────────────────────
    async function _renderCapacity(plant) {
      const container = document.getElementById('labor-capacity-grid'); if (!container) return;
      const scopeGroup = _selectedGroup || null;
      await _fetchLines(plant, scopeGroup);
      const lines = (Store._state.masterData?.lines || [])
        .filter(l => l.plant === plant && (!scopeGroup || l.pl_group === scopeGroup))
        .map(l => l.production_line).sort();
      if (!lines.length) { container.innerHTML = `<div class="empty-state" style="padding:40px 0;">No production lines for this plant.</div>`; return; }

      const horizonStart = _weeks[0].monday;
      const utilMatrix   = Utilization.computeMatrix(horizonStart, Math.min(_horizonSpan * 7, 84));
      const displayDays  = Math.min(14, _horizonSpan * 7);
      const days = [];
      for (let i = 0; i < displayDays; i++) {
        const d = new Date(horizonStart); d.setDate(horizonStart.getDate() + i);
        days.push({ date: d, dayKey: Util.dayKey(d) });
      }

      const isDark = document.body.classList.contains('dark');
      function lerpRGB(a, b, t) {
        const p = h => [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
        const ca = p(a), cb = p(b);
        return `rgb(${Math.round(ca[0]+(cb[0]-ca[0])*t)},${Math.round(ca[1]+(cb[1]-ca[1])*t)},${Math.round(ca[2]+(cb[2]-ca[2])*t)})`;
      }
      const idle = isDark ? '#252730' : '#ede8de', low = isDark ? '#7a5a18' : '#c8a95a',
            mid  = isDark ? '#a8520f' : '#c96a1a', hot = isDark ? '#b32a1f' : '#991b1b';
      function heatBg(ratio) {
        if (ratio <= 0)   return idle;
        if (ratio <= 0.5) return lerpRGB(idle, low, ratio / 0.5);
        if (ratio <= 1.0) return lerpRGB(low, mid, (ratio - 0.5) / 0.5);
        return lerpRGB(mid, hot, Math.min((ratio - 1.0) / 0.25, 1));
      }
      function heatText(ratio) { return isDark ? (ratio <= 0 ? '#8f909d' : '#fff') : (ratio < 0.45 ? '#3d3628' : '#fff'); }

      const cols = `100px repeat(${days.length}, 1fr)`;
      let html = `<p class="lp-cap-note">Req/Avail hours · first ${displayDays} days${scopeGroup ? ' · Group: ' + scopeGroup : ''}</p>
        <div class="lp-hm-wrap"><div class="lp-hm-grid" style="grid-template-columns:${cols}">`;
      html += `<div class="lp-hm-corner"></div>`;
      days.forEach(d => {
        const dow = d.date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
        html += `<div class="lp-hm-head"><span class="lp-hm-dow">${dow}</span><span class="lp-hm-date">${d.date.getMonth()+1}/${d.date.getDate()}</span></div>`;
      });
      lines.forEach((line, li) => {
        const dot = Config.COLORS[li % Config.COLORS.length];
        html += `<div class="lp-hm-label"><span class="lp-hm-dot" style="background:${dot}"></span>${line}</div>`;
        days.forEach(d => {
          const req    = utilMatrix[line]?.[d.dayKey]?.scheduled || 0;
          const ld     = _lineData[plant]?.[line]?.[d.dayKey];
          const calCap = utilMatrix[line]?.[d.dayKey]?.effectiveCapacity || 0;
          const avail  = ld?.avail_hours != null ? ld.avail_hours : calCap;
          const ratio  = avail > 0 ? req / avail : (req > 0 ? 2 : 0);
          const bg     = heatBg(ratio), tc = heatText(ratio);
          const lbl    = avail > 0 ? `${req.toFixed(0)}/${avail.toFixed(0)}` : '—';
          html += `<div class="lp-hm-cell" style="background:${bg};color:${tc};" title="${line} · ${d.dayKey} | Req: ${req.toFixed(1)}h | Avail: ${avail.toFixed(1)}h | ${Math.round(ratio*100)}%">${lbl}</div>`;
        });
      });
      html += `</div></div><div class="lp-hm-legend"><span>idle</span><div class="lp-hm-grad"></div><span>overload</span></div>`;
      container.innerHTML = html;
    }

    // ── Exceptions sub-tab ───────────────────────────────────────────────────
    async function _renderExceptions(plant) {
      const container = document.getElementById('labor-exceptions-list'); if (!container) return;
      await _fetchLines(plant, null);
      const lines = (Store._state.masterData?.lines || []).filter(l => l.plant === plant).map(l => l.production_line);
      const horizonStart = _weeks[0].monday;
      const utilMatrix   = Utilization.computeMatrix(horizonStart, Math.min(_horizonSpan * 7, 84));
      const exceptions = [];
      lines.forEach(line => {
        const lm = utilMatrix[line]; if (!lm) return;
        Object.entries(lm).forEach(([dayKey, cell]) => {
          if (!cell.scheduled && !cell.capacity) return;
          const ld    = _lineData[plant]?.[line]?.[dayKey];
          const avail = ld?.avail_hours != null ? ld.avail_hours : (cell.effectiveCapacity || 0);
          const req   = cell.scheduled || 0, calCap = cell.capacity || 0;
          if (req > avail + 0.05 && req > 0)
            exceptions.push({ sev: 'err',  line, day: dayKey, msg: `${req.toFixed(1)}h required, ${avail.toFixed(1)}h available — ${(req - avail).toFixed(1)}h short` });
          else if (avail > calCap + 0.05 && calCap > 0)
            exceptions.push({ sev: 'warn', line, day: dayKey, msg: `${avail.toFixed(1)}h planned exceeds ${calCap.toFixed(1)}h calendar capacity` });
        });
      });
      exceptions.sort((a, b) => (a.sev === 'err' ? -1 : 1) - (b.sev === 'err' ? -1 : 1) || a.day.localeCompare(b.day));

      const badge = document.getElementById('labor-exc-badge');
      if (badge) { badge.textContent = exceptions.length; badge.hidden = exceptions.length === 0; }

      if (!exceptions.length) {
        container.innerHTML = `<div class="empty-state" style="padding:40px 0;">✓ No exceptions in the current horizon.</div>`; return;
      }
      const rows = exceptions.map(ex => `
        <div class="lp-exc-row lp-exc-${ex.sev}">
          <span class="lp-exc-sev">${ex.sev === 'err' ? '▲' : '⚠'}</span>
          <span class="lp-exc-line">${ex.line}</span>
          <span class="lp-exc-day">${ex.day}</span>
          <span class="lp-exc-msg">${ex.msg}</span>
          <button class="btn btn-sm lp-exc-fix" onclick="NIMBUS.App.gotoLaborSub('line-plan')">Line Plan →</button>
        </div>`).join('');
      container.innerHTML = `<div class="lp-exc-summary">${exceptions.length} exception${exceptions.length !== 1 ? 's' : ''}</div><div class="lp-exc-list">${rows}</div>`;
    }

    // ── Inputs sub-tab ───────────────────────────────────────────────────────
    function _renderInputs() {
      const container = document.getElementById('labor-inputs-pane'); if (!container) return;
      container.innerHTML = `
        <div class="lp-inputs-section">
          <h3 style="font-size:14px;font-weight:700;margin:0 0 12px;">Disaggregation</h3>
          <div class="lp-input-row">
            <label class="lp-input-label">Default split mode</label>
            <select class="lp-input-sel"><option selected>Even split (equal hours per open day)</option></select>
            <span class="lp-input-hint">Aggregate group/week hours divide evenly across each line's open working days. Right-click any Line Plan cell to reset an override to even-split.</span>
          </div>
        </div>
        <div class="lp-inputs-section">
          <h3 style="font-size:14px;font-weight:700;margin:0 0 12px;">Horizon</h3>
          <div class="lp-input-row">
            <label class="lp-input-label">Week span</label>
            <select class="lp-input-sel" onchange="NIMBUS.LaborPlanning.setSpan(+this.value)">
              <option value="4" ${_horizonSpan===4?'selected':''}>4 weeks</option>
              <option value="8" ${_horizonSpan===8?'selected':''}>8 weeks</option>
              <option value="12" ${_horizonSpan===12?'selected':''}>12 weeks</option>
              <option value="16" ${_horizonSpan===16?'selected':''}>16 weeks</option>
            </select>
          </div>
        </div>
        <div class="lp-inputs-section">
          <h3 style="font-size:14px;font-weight:700;margin:0 0 4px;">Aggregate ↔ Line reconciliation</h3>
          <p style="font-size:12px;color:var(--fg-mute);margin:0;">When aggregate hours are saved, the system auto-splits to lines via even split across open working days. Overridden line·day cells are pinned (●) and do not re-split until manually reset.</p>
        </div>`;
    }

    // ── Toolbar update ───────────────────────────────────────────────────────
    function _renderToolbar(plant) {
      const groupSel = document.getElementById('labor-group-select');
      if (groupSel) {
        const prev = groupSel.value;
        groupSel.innerHTML = `<option value="">All</option>` +
          _groups.map(g => `<option value="${g.replace(/"/g,'&quot;')}"${g===prev?' selected':''}>${g}</option>`).join('');
        if (!_selectedGroup && _groups.includes(prev)) _selectedGroup = prev;
      }
      const label = document.getElementById('labor-horizon-label');
      if (label && _weeks.length) label.textContent = `${_weeks[0].label} — ${_weeks[_weeks.length-1].label}`;
      const badge = document.getElementById('labor-plant-badge');
      if (badge) badge.textContent = plant || '—';
    }

    // ── Main render ──────────────────────────────────────────────────────────
    async function render() {
      _weeks = _computeWeeks();
      const plant = Store.selectedPlant;
      if (!plant) {
        ['labor-grid','labor-line-grid','labor-capacity-grid','labor-exceptions-list','labor-inputs-pane'].forEach(id => {
          const el = document.getElementById(id); if (el) el.innerHTML = '';
        });
        const grid = document.getElementById('labor-grid');
        if (grid) grid.innerHTML = `<div class="empty-state" style="padding:40px 0;">Select a plant in the top bar to view labor planning.</div>`;
        document.getElementById('labor-plant-badge')?.setAttribute && (document.getElementById('labor-plant-badge').textContent = '—');
        document.getElementById('labor-kpi-strip') && (document.getElementById('labor-kpi-strip').innerHTML = '');
        return;
      }
      const mdLines = (Store._state.masterData?.lines || []).filter(r => r.plant === plant);
      _groups = [...new Set(mdLines.map(r => r.pl_group).filter(Boolean))].sort();
      if (!_groups.length) {
        const grid = document.getElementById('labor-grid');
        if (grid) grid.innerHTML = `<div class="empty-state" style="padding:40px 0;">No production line groups defined for this plant. Assign groups in <strong>Master Data → Production Lines</strong>.</div>`;
        return;
      }
      _renderToolbar(plant);
      _renderKPIs(plant);
      const sub = App._laborSub || 'aggregate';
      if (sub === 'aggregate')   await _renderAggregate(plant);
      else if (sub === 'line-plan')  await _renderLinePlan(plant);
      else if (sub === 'capacity')   await _renderCapacity(plant);
      else if (sub === 'exceptions') await _renderExceptions(plant);
      else if (sub === 'inputs')     _renderInputs();
    }

    function _onLPKeyDown(e) {
      if (!_selRange || App._currentTab !== 'labor') return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); _clearSelection(); return; }
      if (e.key === 'Delete' || (e.key === 'Backspace' && !e.target?.classList.contains('lp-cell'))) {
        e.preventDefault(); e.stopImmediatePropagation(); _deleteSelected(); return;
      }
      if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); e.stopImmediatePropagation(); _copySelected(); return; }
    }

    function init() {
      document.addEventListener('keydown', _onLPKeyDown, { capture: true });
      document.addEventListener('mouseup', () => { _dragging = false; });
      Store.subscribe(evt => {
        if ((evt.type === 'plant:selected' || evt.type === 'master-data-changed') && App._currentTab === 'labor') {
          if (evt.type === 'plant:selected') { delete _aggrData[evt.plant]; delete _lineData[evt.plant]; }
          render();
        }
      });
    }

    return {
      init, render,
      onGroupChange(group) {
        _selectedGroup = group;
        const plant = Store.selectedPlant; if (!plant) return;
        const sub = App._laborSub;
        if (sub === 'line-plan')  _renderLinePlan(plant);
        else if (sub === 'capacity') _renderCapacity(plant);
      },
      prevHorizon() { _horizonOffset--; render(); },
      nextHorizon() { _horizonOffset++; render(); },
      setSpan(n) {
        _horizonSpan = n;
        const sel = document.getElementById('labor-span-sel'); if (sel) sel.value = n;
        render();
      },
    };
  })();

  /* =============================================================================
     EDIT CALENDAR — per-line working hours modal.
     Opens from the "Edit Calendar" button in each ProdLines accordion.
     Writes to Store.setCalendar() and triggers ProdLines.render() on save.
     DB-ready: Store.calendars[line].workHours = { 0: [h1,h2]|null, ...6 }
     maps to: line_calendar(line_code, day_of_week, is_open, start_hour, end_hour)
     ========================================================================== */
  const EditCalendar = (() => {
    let _line = null;
    let _fp   = []; // 14 flatpickr instances: [start0, end0, start1, end1, ..., start6, end6]
    let _plantMode = false;
    let _plantName = null;

    function open(line) {
      _plantMode = false;
      _plantName = null;
      _line = line;
      Store.ensureCalendar(line);
      _renderHeader();
      _initPickers();
      _populate();
      const el = document.getElementById('modal-edit-calendar');
      if (!el) return;
      const copyBtn = el.querySelector('.cal-copy-plant-btn');
      if (copyBtn) copyBtn.style.display = '';
      el.hidden = false;
      requestAnimationFrame(() => el.querySelector('.cal-edit-modal')?.classList.add('visible'));
    }

    function openPlant(name) {
      _plantMode = true;
      _plantName = name;
      _line = null;
      Store.ensurePlant(name);
      _renderHeader();
      _initPickers();
      _populate();
      const el = document.getElementById('modal-edit-calendar');
      if (!el) return;
      const copyBtn = el.querySelector('.cal-copy-plant-btn');
      if (copyBtn) copyBtn.style.display = 'none';
      el.hidden = false;
      requestAnimationFrame(() => el.querySelector('.cal-edit-modal')?.classList.add('visible'));
    }

    function close() {
      const el = document.getElementById('modal-edit-calendar');
      el?.querySelector('.cal-edit-modal')?.classList.remove('visible');
      setTimeout(() => { if (el) el.hidden = true; }, 230);
    }

    function _renderHeader() {
      const nameEl = document.getElementById('cal-edit-line-name');
      const plantEl = document.getElementById('cal-edit-plant-name');
      if (_plantMode) {
        if (nameEl)  nameEl.textContent  = `Plant ${_plantName}`;
        if (plantEl) plantEl.textContent = '';
      } else {
        const plant = Store.getPlantForLine(_line);
        if (nameEl)  nameEl.textContent  = _line;
        if (plantEl) plantEl.textContent = `Plant ${plant}`;
      }
    }

    function _populate() {
      const wh = _plantMode
        ? Store.plants[_plantName].workHours
        : Store.calendars[_line].workHours;
      document.querySelectorAll('.cal-preset-chip').forEach(c => c.classList.remove('active'));
      for (let d = 0; d < 7; d++) {
        const enabled = !!wh[d];
        const tog = document.getElementById(`cal-edit-toggle-${d}`);
        if (tog) tog.checked = enabled;
        _setRowEnabled(d, enabled);
        if (enabled && _fp.length === 14) {
          _fp[d * 2]?.setDate(Calendar._hToT(wh[d][0]), false);
          _fp[d * 2 + 1]?.setDate(Calendar._hToT(wh[d][1]), false);
        }
        _refreshBadge(d);
      }
    }

    function _initPickers() {
      if (_fp.length === 14) return;
      _fp = [];
      for (let d = 0; d < 7; d++) {
        const mkCfg = () => ({
          enableTime: true, noCalendar: true,
          dateFormat: 'H:i', altInput: true, altFormat: 'h:i K',
          minuteIncrement: 30,
          onChange: () => _refreshBadge(d),
        });
        _fp.push(
          flatpickr(`#cal-edit-start-${d}`, mkCfg()),
          flatpickr(`#cal-edit-end-${d}`,   mkCfg())
        );
      }
    }

    function _setRowEnabled(d, enabled) {
      const row = document.getElementById(`cal-edit-row-${d}`);
      row?.classList.toggle('cal-day-off', !enabled);
      // Disable the altInput flatpickr renders (the visible element)
      const startAlt = document.querySelector(`#cal-edit-start-${d} ~ input.flatpickr-input`);
      const endAlt   = document.querySelector(`#cal-edit-end-${d} ~ input.flatpickr-input`);
      [startAlt, endAlt].forEach(inp => { if (inp) inp.disabled = !enabled; });
    }

    function _refreshBadge(d) {
      const badge = document.getElementById(`cal-edit-badge-${d}`);
      if (!badge) return;
      const tog = document.getElementById(`cal-edit-toggle-${d}`);
      if (!tog?.checked) { badge.textContent = '—'; return; }
      const s = _fp[d * 2]?.element?.value;
      const e = _fp[d * 2 + 1]?.element?.value;
      if (s && e) {
        const hrs = Calendar._tToH(e) - Calendar._tToH(s);
        badge.textContent = hrs > 0
          ? `${hrs % 1 === 0 ? hrs : hrs.toFixed(1)}h`
          : '—';
      } else {
        badge.textContent = '—';
      }
    }

    function onToggle(d, checked) {
      _setRowEnabled(d, checked);
      if (checked && _fp.length === 14) {
        if (!_fp[d * 2]?.element?.value)     _fp[d * 2]?.setDate('08:00', false);
        if (!_fp[d * 2 + 1]?.element?.value) _fp[d * 2 + 1]?.setDate('17:00', false);
      }
      _refreshBadge(d);
    }

    function applyPreset(preset) {
      const PRESETS = {
        mf:  { days: [1,2,3,4,5],     s: '08:00', e: '17:00' },
        ms:  { days: [1,2,3,4,5,6],   s: '08:00', e: '17:00' },
        all: { days: [0,1,2,3,4,5,6], s: '08:00', e: '17:00' },
      };
      const p = PRESETS[preset];
      if (!p) return;
      document.querySelectorAll('.cal-preset-chip')
        .forEach(c => c.classList.toggle('active', c.dataset.preset === preset));
      for (let d = 0; d < 7; d++) {
        const enabled = p.days.includes(d);
        const tog = document.getElementById(`cal-edit-toggle-${d}`);
        if (tog) tog.checked = enabled;
        if (enabled && _fp.length === 14) {
          _fp[d * 2]?.setDate(p.s, false);
          _fp[d * 2 + 1]?.setDate(p.e, false);
        }
        _setRowEnabled(d, enabled);
        _refreshBadge(d);
      }
    }

    function copyFromPlant() {
      const plant = Store.getPlantForLine(_line);
      if (!plant) { Toast.show(t('toast.no_plant_assigned_line'), 'warn'); return; }
      Store.ensurePlant(plant);
      const ph = Store.plants[plant].workHours;
      for (let d = 0; d < 7; d++) {
        const enabled = !!ph[d];
        const tog = document.getElementById(`cal-edit-toggle-${d}`);
        if (tog) tog.checked = enabled;
        if (enabled && _fp.length === 14) {
          _fp[d * 2]?.setDate(Calendar._hToT(ph[d][0]), false);
          _fp[d * 2 + 1]?.setDate(Calendar._hToT(ph[d][1]), false);
        }
        _setRowEnabled(d, enabled);
        _refreshBadge(d);
      }
      document.querySelectorAll('.cal-preset-chip').forEach(c => c.classList.remove('active'));
      Toast.show(t('toast.copied_from_plant'), 'success');
    }

    function save() {
      if (!_plantMode && !_line) return;
      const newWh = {};
      for (let d = 0; d < 7; d++) {
        const tog = document.getElementById(`cal-edit-toggle-${d}`);
        if (!tog?.checked) { newWh[d] = null; continue; }
        const s = _fp[d * 2]?.element?.value;
        const e = _fp[d * 2 + 1]?.element?.value;
        newWh[d] = (s && e) ? [Calendar._tToH(s), Calendar._tToH(e)] : null;
      }
      if (_plantMode) {
        Store.plants[_plantName].workHours = newWh;
        for (let d = 0; d < 7; d++) Store.clampLinesToPlant(_plantName, d);
        Plant.render();
        close();
        Toast.show(t('toast.plant_calendar_clamped'), 'success');
      } else {
        Store.setCalendar(_line, newWh, 'edit-calendar');
        ProdLines.render();
        close();
        Toast.show(t('toast.line_calendar_updated', { line: _line }), 'success');
      }
    }

    return { open, openPlant, close, save, onToggle, applyPreset, copyFromPlant };
  })();

  /* =============================================================================
     COLOR WHEEL VIEWER — modal preview of a plant's uploaded color wheel.
     Supports search, sort, expandable rows with task counts per color.
     ========================================================================== */
  const ColorWheelViewer = (() => {
    let _plant   = null;
    let _entries = [];
    let _search  = '';
    let _sort    = 'priority'; // 'priority' | 'name'

    const _esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

    // Map common color name fragments → hex for the swatch tiles
    const COLOR_MAP = {
      RED:'#e74c3c', BLUE:'#3498db', GREEN:'#2ecc71', YELLOW:'#f1c40f',
      ORANGE:'#e67e22', PURPLE:'#9b59b6', PINK:'#e91e8c', WHITE:'#f0ede8',
      BLACK:'#2c3e50', BROWN:'#7a5a2a', GREY:'#95a5a6', GRAY:'#95a5a6',
      SILVER:'#bdc3c7', GOLD:'#b8791a', AMBER:'#b8791a', NAVY:'#1f2d6d',
      TEAL:'#1abc9c', AQUA:'#00bcd4', MAROON:'#8b1a1a', OLIVE:'#6b7a2a',
      BEIGE:'#e8dcc8', TAN:'#d4a96a', CORAL:'#ff6b6b', LIME:'#a8e063',
      SAGE:'#87a96b', SLATE:'#708090', IVORY:'#fffff0', CREAM:'#fffdd0',
    };

    function _resolveColor(name) {
      const u = String(name).toUpperCase().trim();
      if (COLOR_MAP[u]) return COLOR_MAP[u];
      for (const [k, v] of Object.entries(COLOR_MAP)) {
        if (u.includes(k)) return v;
      }
      return null;
    }

    function open(plant) {
      _plant  = plant;
      _search = '';
      _sort   = 'priority';
      const el = document.getElementById('modal-cw-viewer');
      if (!el) return;
      el.hidden = false;
      // Reset search UI
      const srch = document.getElementById('cw-viewer-search');
      if (srch) srch.value = '';
      const sortBtns = document.querySelectorAll('.cw-sort-btn');
      sortBtns.forEach(b => b.classList.toggle('active', b.dataset.sort === 'priority'));
      requestAnimationFrame(() => el.querySelector('.cw-viewer-modal')?.classList.add('visible'));
      _load();
    }

    function close() {
      const el = document.getElementById('modal-cw-viewer');
      if (!el) return;
      el.querySelector('.cw-viewer-modal')?.classList.remove('visible');
      setTimeout(() => { el.hidden = true; }, 240);
    }

    function _load() {
      const titleEl   = document.getElementById('cw-viewer-plant-name');
      const countEl   = document.getElementById('cw-viewer-count');
      const listEl    = document.getElementById('cw-viewer-list');
      if (titleEl) titleEl.textContent = _plant || '—';
      if (countEl) countEl.textContent = '';
      if (listEl)  listEl.innerHTML    = `<div class="cw-loading"><span class="cw-spin"></span>${t('ui.loading_wheel')}</div>`;

      fetch(`${Config.API_BASE}/color-wheel/${encodeURIComponent(_plant)}`, { signal: AbortSignal.timeout(8000) })
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then(body => {
          _entries = body.entries || [];
          // Populate file meta below title
          const metaEl = document.getElementById('cw-viewer-meta');
          const m = body.meta || {};
          if (metaEl) metaEl.textContent = m.filename
            ? `${m.filename} · ${m.row_count ?? _entries.length} colors`
            : `${_entries.length} colors`;
          _render();
        })
        .catch(err => {
          _entries = [];
          if (listEl) listEl.innerHTML = `<div class="cw-viewer-empty">No color wheel uploaded for plant <strong>${_esc(_plant)}</strong>.<br><span style="color:var(--fg-mute);font-size:12px;">Upload one in the Plant tab → Optimization Options.</span></div>`;
          const metaEl = document.getElementById('cw-viewer-meta');
          if (metaEl) metaEl.textContent = err.message.includes('404') ? 'No file uploaded' : err.message;
        });
    }

    function _render() {
      const listEl  = document.getElementById('cw-viewer-list');
      const countEl = document.getElementById('cw-viewer-count');
      if (!listEl) return;

      // Task counts per color for this plant
      const taskCounts = {};
      for (const t of Store.tasksArr) {
        if (_plant && Store.getPlantForLine(t.PRODUCTION_LINE) !== _plant) continue;
        const c = Util.norm(t.COLOR);
        if (c && c !== 'NAN') taskCounts[c] = (taskCounts[c] || 0) + 1;
      }

      let data = _entries.slice();
      if (_search) {
        const s = _search.toLowerCase();
        data = data.filter(e => String(e.color || '').toLowerCase().includes(s));
      }
      if (_sort === 'name') {
        data.sort((a, b) => String(a.color || '').localeCompare(String(b.color || '')));
      } else {
        data.sort((a, b) => (a.order_y ?? 999999) - (b.order_y ?? 999999));
      }

      if (countEl) countEl.textContent = `${data.length} color${data.length !== 1 ? 's' : ''}`;

      if (!data.length) {
        listEl.innerHTML = `<div class="cw-viewer-empty">${_search ? 'No colors match your search.' : 'No entries in this wheel.'}</div>`;
        return;
      }

      listEl.innerHTML = data.map((e, i) => {
        const hex    = _resolveColor(e.color || '');
        const letter = (String(e.color || '?')[0]).toUpperCase();
        const tc     = taskCounts[Util.norm(e.color || '')] || 0;
        const pri    = e.order_y != null && e.order_y < 999999 ? e.order_y : '—';
        return `<div class="cw-viewer-row">
          <div class="cw-swatch" style="${hex ? `background:${hex}` : 'background:var(--bg-strong)'}" title="${_esc(e.color)}">
            ${!hex ? `<span class="cw-swatch-letter">${_esc(letter)}</span>` : ''}
          </div>
          <div class="cw-row-body">
            <div class="cw-row-name">${_esc(e.color)}</div>
            <div class="cw-row-sub">
              ${t('ui.priority_label')} <strong>${pri}</strong>
              ${tc ? `<span class="cw-row-dot">·</span><span class="cw-row-tasks">${t('ui.active_orders', { count: tc, plural: tc !== 1 ? 's' : '' })}</span>` : ''}
            </div>
          </div>
          <div class="cw-row-rank">#${i + 1}</div>
          <button class="cw-row-expand" onclick="NIMBUS.ColorWheelViewer._toggleExpand(this)">▾</button>
          <div class="cw-row-detail">
            ${tc
              ? `<span class="cw-detail-stat ok">${t('ui.active_orders', { count: tc, plural: tc !== 1 ? 's' : '' })} ${t('ui.on_plant_label')} <strong>${_esc(_plant)}</strong></span>`
              : `<span class="cw-detail-stat mute">${t('ui.no_active_for_color')}</span>`}
          </div>
        </div>`;
      }).join('');
    }

    function _toggleExpand(btn) {
      const row    = btn.closest('.cw-viewer-row');
      const detail = row?.querySelector('.cw-row-detail');
      if (!detail) return;
      const open = detail.classList.toggle('open');
      btn.textContent = open ? '▴' : '▾';
    }

    function search(val) {
      _search = String(val || '').toLowerCase();
      _render();
    }

    function sort(mode) {
      _sort = mode;
      document.querySelectorAll('.cw-sort-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.sort === mode)
      );
      _render();
    }

    return { open, close, search, sort, _toggleExpand };
  })();

  /* =============================================================================
     ALERTS — detect and maintain the active alert list.
     Re-runs on any task/block/calendar change. Alerts are de-duplicated by id.
     ========================================================================== */
  const Alerts = {
    recompute(opts = {}) {
      const _t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      // Incremental scope: when opts.lines is a non-empty Set, recompute alerts only for
      // those lines and splice them into the existing list (merge at the end). Callers that
      // use this path must never move a task across lines.
      const onlyLines = (opts.lines instanceof Set && opts.lines.size) ? opts.lines : null;
      const alerts = [];
      const tasks = Store.tasksArr;
      const todayStart = Util.startOfDay(new Date());
      let activeTasks = tasks.filter(t => !t.end_date || t.end_date >= todayStart);
      if (onlyLines) activeTasks = activeTasks.filter(t => onlyLines.has(t.PRODUCTION_LINE || 'Unknown'));

      // Pre-parse block dates once rather than re-parsing on every per-task and
      // per-(line,day) call below.
      const parsedBlocks = [];
      for (const b of Store.blocks) {
        const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
        if (s && e) parsedBlocks.push({ line: b.line, s, e });
      }
      const parsedPlantBlocks = [];
      for (const b of Store.plantBlocks) {
        const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
        if (s && e) parsedPlantBlocks.push({ plant: b.plant, s, e });
      }

      // Cache line→plant lookups; the same handful of lines repeat across many tasks.
      const _plantCache = {};
      const plantOf = line => {
        if (!(line in _plantCache)) _plantCache[line] = Store.getPlantForLine(line);
        return _plantCache[line];
      };

      /* 1. OVERLAPS on the same line — two or more orders sharing a timespan. */
      const byLine = {};
      activeTasks.forEach(t => {
        if (!t.start_date || !t.end_date) return;
        const line = t.PRODUCTION_LINE || 'Unknown';
        (byLine[line] ||= []).push(t);
      });
      for (const line of Object.keys(byLine)) {
        const arr = byLine[line].slice().sort((a,b) => a.start_date - b.start_date);
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

      /* 2. OVERLOAD — a line's scheduled hours exceed its daily capacity. */
      const byLineDay = {};
      activeTasks.forEach(t => {
        if (!t.start_date) return;
        const line = t.PRODUCTION_LINE || 'Unknown';
        const day  = Util.dayKey(t.start_date);
        (byLineDay[`${line}|${day}`] ||= { line, day, hours: 0, tasks: [] });
        byLineDay[`${line}|${day}`].hours += Util.runHours(t);
        byLineDay[`${line}|${day}`].tasks.push(t);
      });
      for (const k of Object.keys(byLineDay)) {
        const { line, day, hours } = byLineDay[k];
        const dateObj = new Date(day + 'T12:00:00');
        const cap = Calendar.dailyCapacityHours(line, dateObj);
        // Inline effectiveCapacityHours to avoid a second dailyCapacityHours call
        // (which would re-run workWindow + block iteration for the same line/day).
        const ls = Store.lineSettings[line];
        let effCap = cap;
        if (ls?.bufferUnit === 'pct' && ls.bufferPct > 0) effCap = cap * (1 - ls.bufferPct / 100);
        else if (ls?.bufferUnit === 'hours' && ls.bufferHours > 0) effCap = Math.max(0, cap - ls.bufferHours);
        if (effCap > 0 && hours > effCap * Config.OVERLOAD_THRESHOLD) {
          alerts.push({
            id:  `ovl-day-${line}-${day}`,
            sev: 'err', type: 'overload',
            msg: `${line} is overloaded on ${day}: ${hours.toFixed(1)}h scheduled vs ${effCap.toFixed(1)}h effective capacity (${cap.toFixed(1)}h total).`,
            line, time: dateObj
          });
        } else if (effCap > 0 && hours > effCap * Config.WARN_THRESHOLD) {
          // Near-capacity alerts suppressed (set SHOW_NEAR_CAPACITY_ALERTS = true to re-enable)
          if (Config.SHOW_NEAR_CAPACITY_ALERTS) alerts.push({
            id:  `warn-day-${line}-${day}`,
            sev: 'warn', type: 'near-capacity',
            msg: `${line} is near capacity on ${day}: ${hours.toFixed(1)} / ${effCap.toFixed(1)}h effective capacity (${Math.round(100*hours/effCap)}%).`,
            line, time: dateObj
          });
        } else if (cap === 0 && hours > 0) {
          // Build a diagnostic explaining *why* cap is 0 — either the day-of-week
          // is configured closed, or one or more blackouts consume the entire
          // working window. Per-block contributions use interval-union math
          // (Util.mergedOverlapHours) so overlapping blocks aren't double-counted.
          const win = Calendar.workWindow(line, dateObj);
          let reason;
          if (!win) {
            reason = `the ${line} or plant calendar is closed that day-of-week`;
          } else {
            const winHrs = (win[1] - win[0]) / 3600000;
            const plant = Store.getPlantForLine(line);
            const dayStart = new Date(dateObj); dayStart.setHours(0,0,0,0);
            const dayEnd   = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
            const intervals = [];
            const labels = [];
            for (const b of Store.blocks) {
              if (b.line && b.line !== line) continue;
              const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
              if (!s || !e) continue;
              if (s >= dayEnd || e <= dayStart) continue;
              const ov = (Math.min(win[1], e) - Math.max(win[0], s)) / 3600000;
              if (ov > 0) {
                intervals.push({ s, e });
                labels.push(`${b.line ? 'line' : 'global line'}${b.reason ? ` "${b.reason}"` : ''} ${ov.toFixed(1)}h`);
              }
            }
            for (const b of Store.plantBlocks) {
              if (b.plant && b.plant !== plant) continue;
              const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
              if (!s || !e) continue;
              if (s >= dayEnd || e <= dayStart) continue;
              const ov = (Math.min(win[1], e) - Math.max(win[0], s)) / 3600000;
              if (ov > 0) {
                intervals.push({ s, e });
                labels.push(`${b.plant ? 'plant' : 'global plant'}${b.reason ? ` "${b.reason}"` : ''} ${ov.toFixed(1)}h`);
              }
            }
            const consumed = Util.mergedOverlapHours(win, intervals);
            reason = `working window is ${winHrs.toFixed(1)}h, blackouts union to ${consumed.toFixed(1)}h (${labels.join(', ') || 'no blocks found — bug?'})`;
          }
          alerts.push({
            id:  `closed-${line}-${day}`,
            sev: 'err', type: 'closed',
            msg: `${line} is scheduled on ${day} but has 0h capacity — ${reason}.`,
            line, time: dateObj
          });
        }
      }

      /* 3. BLACKOUT VIOLATION — a task overlaps an active blackout block. */
      for (const t of activeTasks) {
        if (!t.start_date || !t.end_date) continue;
        const line = t.PRODUCTION_LINE || 'Unknown';
        const plant = plantOf(line);
        let conflict = false;
        try {
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
        } catch (e) {
          ErrorLog.error('alerts', `Blackout check failed for id=${t.id}: ${e.message}`);
        }
        if (conflict) {
          alerts.push({
            id:  `blk-${t.id}`,
            sev: 'err', type: 'blackout',
            msg: `Order "${t.text || t.id}" overlaps a blackout block on ${line}.`,
            taskId: t.id, line, time: t.start_date
          });
        }
      }

      /* 4. FIXED-BUT-ON-CLOSED-DAY — fixed order on a day the line calendar is closed. */
      for (const t of activeTasks) {
        if (!t.fixed || !t.start_date) continue;
        const line = t.PRODUCTION_LINE || 'Unknown';
        const win = Calendar.workWindow(line, t.start_date);
        if (!win) {
          alerts.push({
            id: `fixclosed-${t.id}`,
            sev: 'warn', type: 'fixed-closed',
            msg: `Fixed order "${t.text || t.id}" is on a day the ${line} calendar is closed.`,
            taskId: t.id, line, time: t.start_date
          });
        }
      }

      /* 5. FIXED-OUT-OF-HOURS — fixed order start or end falls outside the
            permitted working-hour window on an otherwise-open day. Does not
            fire when check 4 already covers the same day (win null). */
      for (const t of activeTasks) {
        if (!t.fixed || !t.start_date || !t.end_date) continue;
        const line = t.PRODUCTION_LINE || 'Unknown';
        const winS = Calendar.workWindow(line, t.start_date);
        const winE = Calendar.workWindow(line, t.end_date);
        const parts = [];
        if (winS && t.start_date < winS[0]) {
          parts.push(`starts before ${line} opens (${Util.fmtDTReadable(winS[0])})`);
        }
        if (winE && t.end_date > winE[1]) {
          parts.push(`ends after ${line} closes (${Util.fmtDTReadable(winE[1])})`);
        }
        if (parts.length) {
          alerts.push({
            id:  `fixhours-${t.id}`,
            sev: 'warn', type: 'fixed-out-of-hours',
            msg: `Fixed order "${t.text || t.id}" ${parts.join(' and ')}.`,
            taskId: t.id, line, time: t.start_date
          });
        }
      }

      /* Preserve dismissals — a previously-dismissed alert whose condition is
         still active is not re-surfaced this cycle. We track dismissed IDs in
         `Alerts._dismissed`. */
      const kept = alerts.filter(a => !Alerts._dismissed.has(a.id));
      if (onlyLines) {
        // Incremental merge: retain alerts on untouched lines (their inputs didn't change)
        // and replace only the affected lines. Correct because callers of the scoped path
        // never move a task to a different line, and every alert carries a `line` field.
        const retained = (Store.alerts || []).filter(a => !onlyLines.has(a.line));
        Store.setAlerts(retained.concat(kept), 'alerts');
      } else {
        Store.setAlerts(kept, 'alerts');
      }
      Alerts._lastMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - _t0;
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

    // Jump to the task related to an alert (navigates to Gantt tab and focuses it
    // at day-level zoom so the alert context — surrounding orders, blackouts — is visible).
    focus(alertId) {
      const a = Store.alerts.find(x => x.id === alertId);
      if (!a) return;
      if (!a.taskId) return;
      App.goto('gantt');
      setTimeout(() => {
        const t = Store.tasks[a.taskId];
        if (!t || !Timeline._tl) return;
        // 3-day window centered on the task's start — matches the Hour/Day/Week
        // toolbar's "day" mode (3 × 24h) so the segmented control stays honest.
        if (t.start_date) {
          const center = t.start_date.getTime();
          const start = new Date(center - 1.5 * 24 * 3600000);
          const end   = new Date(center + 1.5 * 24 * 3600000);
          Timeline._tl.setWindow(start, end, { animation: { duration: 300 } });
        }
        Timeline._tl.setSelection([String(a.taskId)]);
        Inspector.show(t);
        document.querySelectorAll('.gantt-toolbar .seg-btn[data-view]').forEach(b => {
          b.classList.toggle('active', b.dataset.view === 'day');
        });
      }, 250);
    },

    // Open a categorized, scrollable cell-briefing modal listing the alerts for
    // a single (line, day) cell. Triggered by clicking a red/amber alert-cell
    // highlight on the Gantt.
    showForCell(line, dayKey) {
      const matches = Store.alerts.filter(a =>
        a.line === line && a.time && Util.dayKey(a.time) === dayKey);
      if (!matches.length) return;

      const day = new Date(dayKey + 'T12:00:00');
      const dateLabel = day.toLocaleDateString('en-US',
        { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();

      const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

      // -------- Cell context: scheduled hours, capacity, orders, changeovers
      const cellTasks = Store.tasksArr
        .filter(t => (t.PRODUCTION_LINE || 'Unknown') === line
                  && t.start_date && Util.dayKey(t.start_date) === dayKey)
        .sort((a, b) => a.start_date - b.start_date);
      const scheduledH = cellTasks.reduce((s, t) => s + Util.runHours(t), 0);
      const effCap   = Calendar.effectiveCapacityHours(line, day) || 0;
      const utilPct  = effCap > 0 ? scheduledH / effCap : 0;
      let changeovers = 0;
      for (let i = 1; i < cellTasks.length; i++) {
        const a = cellTasks[i-1], b = cellTasks[i];
        const ka = a.COLOR || a.FORM_SIZE || a.MATERIAL_NUMBER || '';
        const kb = b.COLOR || b.FORM_SIZE || b.MATERIAL_NUMBER || '';
        if (ka !== kb) changeovers++;
      }

      // -------- Categorize alerts
      const CAT_MAP = {
        overload:             'capacity',
        closed:               'capacity',
        'near-capacity':      'capacity',
        overlap:              'conflicts',
        blackout:             'conflicts',
        'fixed-closed':       'exceptions',
        'fixed-out-of-hours': 'exceptions',
      };
      const byCat = { capacity: [], conflicts: [], exceptions: [] };
      for (const a of matches) (byCat[CAT_MAP[a.type] || 'exceptions']).push(a);

      const errCt  = matches.filter(a => a.sev === 'err').length;
      const warnCt = matches.filter(a => a.sev === 'warn').length;
      const verdict = errCt > 0
        ? `${errCt} critical${warnCt ? ` · ${warnCt} warning${warnCt > 1 ? 's' : ''}` : ''}`
        : `${warnCt} warning${warnCt > 1 ? 's' : ''}`;
      const verdictSev = errCt > 0 ? 'err' : 'warn';

      // -------- Per-card renderers
      const sevIcon = { err: '✖', warn: '⚠', info: 'ℹ' };
      const taskPO = id => {
        const t = Store.tasks?.[id];
        return t ? (t.PRODUCTION_ORDER || t.text || String(id).slice(0, 8)) : String(id).slice(0, 8);
      };
      const taskFixed = id => !!Store.tasks?.[id]?.fixed;

      const renderChip = (id) => `
        <span class="ac-chip ${taskFixed(id) ? 'fixed' : ''}" title="${esc(id)}">${esc(taskPO(id))}</span>`;

      const renderCard = (a) => {
        // Headline + right-side numeric.
        let headline = esc(a.type.replace(/-/g,' ')).replace(/\b\w/g, c => c.toUpperCase());
        let num = '';
        let chipsHtml = '';

        if (a.type === 'overload') {
          headline = 'Overloaded';
          num = `<span class="ac-card-num over">${(utilPct * 100).toFixed(0)}%</span>`;
          // Show the top contributing orders by run hours.
          const top = cellTasks.slice().sort((x,y) => Util.runHours(y) - Util.runHours(x)).slice(0, 4);
          if (top.length) chipsHtml = `<div class="ac-chips">${top.map(t => renderChip(t.id)).join('')}</div>`;
        } else if (a.type === 'overlap') {
          headline = 'Order overlap';
          const m = a.id.match(/^ovl-(.+)-(.+)$/);
          if (m) {
            chipsHtml = `<div class="ac-chips">${renderChip(m[1])}<span class="ac-chip-sep">⇄</span>${renderChip(m[2])}</div>`;
          } else if (a.taskId) {
            chipsHtml = `<div class="ac-chips">${renderChip(a.taskId)}</div>`;
          }
        } else if (a.type === 'blackout') {
          headline = 'Blackout violation';
          if (a.taskId) chipsHtml = `<div class="ac-chips">${renderChip(a.taskId)}</div>`;
        } else if (a.type === 'fixed-closed') {
          headline = 'Fixed order on closed day';
          if (a.taskId) chipsHtml = `<div class="ac-chips">${renderChip(a.taskId)}</div>`;
        } else if (a.type === 'fixed-out-of-hours') {
          headline = 'Fixed order outside work hours';
          if (a.taskId) chipsHtml = `<div class="ac-chips">${renderChip(a.taskId)}</div>`;
        } else if (a.type === 'closed') {
          headline = 'Line closed';
        } else if (a.type === 'near-capacity') {
          headline = 'Near capacity';
          num = `<span class="ac-card-num">${(utilPct * 100).toFixed(0)}%</span>`;
        }

        const gotoBtn = a.taskId
          ? `<button class="btn sm" data-act="goto" data-id="${esc(a.id)}">Go to</button>` : '';

        return `
          <div class="ac-card ac-card-${a.sev}">
            <div class="ac-card-headline">
              <span class="ac-card-sev">${sevIcon[a.sev] || '•'}</span>
              <span>${headline}</span>
              ${num}
            </div>
            <div class="ac-card-msg">${esc(a.msg)}</div>
            ${chipsHtml}
            <div class="ac-card-actions">
              ${gotoBtn}
              <button class="btn sm" data-act="dismiss" data-id="${esc(a.id)}">Dismiss</button>
            </div>
          </div>`;
      };

      const renderCategory = (key, label, alerts) => {
        if (!alerts.length) return '';
        return `
          <section class="ac-cat" data-cat="${key}">
            <h4 class="ac-cat-head">${label} <span class="ac-count">(${alerts.length})</span></h4>
            ${alerts.map(renderCard).join('')}
          </section>`;
      };

      // -------- Capacity bar values
      const fillPct = Math.min(100, utilPct * 100);
      const overPct = utilPct > 1 ? Math.min(100, (utilPct - 1) * 100) : 0;

      const dlg = document.createElement('dialog');
      dlg.className = 'ni-briefing-dlg alertcell-dlg-v2';
      dlg.innerHTML = `
        <div class="ac-wrap">
          <header class="ac-head">
            <div class="ac-head-row">
              <span class="ac-title">${esc(line)}</span>
              <span class="ac-date">${dateLabel}</span>
              <button class="ac-x" data-act="close" aria-label="Close">×</button>
            </div>
            <div class="ac-verdict ac-verdict-${verdictSev}">
              ${errCt ? '🔴' : '🟡'} ${esc(verdict)}
            </div>
            <div class="ac-stats">
              <div class="ac-stat">
                <div class="ac-stat-num ${utilPct > 1 ? 'over' : ''}">
                  ${scheduledH.toFixed(1)}h / ${effCap.toFixed(1)}h
                </div>
                <div class="ac-cap-bar">
                  <div class="ac-cap-fill" style="width:${fillPct.toFixed(0)}%"></div>
                  ${overPct > 0 ? `<div class="ac-cap-over" style="width:${overPct.toFixed(0)}%"></div>` : ''}
                </div>
                <div class="ac-stat-sub">${(utilPct * 100).toFixed(0)}% utilization</div>
              </div>
              <div class="ac-stat-pair">
                <div><span class="ac-stat-num">${cellTasks.length}</span><span class="ac-stat-lbl">orders</span></div>
                <div><span class="ac-stat-num">${changeovers}</span><span class="ac-stat-lbl">changeovers</span></div>
              </div>
            </div>
          </header>

          <div class="ac-body">
            ${renderCategory('capacity',   'Capacity',   byCat.capacity)}
            ${renderCategory('conflicts',  'Conflicts',  byCat.conflicts)}
            ${renderCategory('exceptions', 'Exceptions', byCat.exceptions)}
          </div>

          <footer class="ac-foot">
            <button class="ac-dismiss-all" data-act="dismiss-all">Dismiss all on this cell</button>
            <button class="btn btn-primary sm" data-act="close">Close</button>
          </footer>
        </div>`;
      document.body.appendChild(dlg);
      try { dlg.showModal(); } catch { dlg.open = true; }

      const pruneEmptyCats = () => {
        dlg.querySelectorAll('.ac-cat').forEach(s => {
          if (!s.querySelector('.ac-card')) s.remove();
        });
      };

      dlg.addEventListener('click', e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) { if (e.target === dlg) dlg.close(); return; }
        const act = btn.dataset.act, aid = btn.dataset.id;
        if (act === 'close')   { dlg.close(); return; }
        if (act === 'goto')    { dlg.close(); Alerts.focus(aid); return; }
        if (act === 'dismiss') {
          Alerts.dismiss(aid);
          btn.closest('.ac-card')?.remove();
          pruneEmptyCats();
          if (!dlg.querySelector('.ac-card')) dlg.close();
          return;
        }
        if (act === 'dismiss-all') {
          matches.forEach(a => Alerts.dismiss(a.id));
          dlg.close();
        }
      });
      dlg.addEventListener('close', () => dlg.remove());
    },
/* ----- DRAWER ---------------------------------------------------------- */
    toggleDrawer() {
      const d = document.getElementById('alert-drawer');
      if (!d) return;
      const isOpen = d.classList.toggle('open');
      if (isOpen) Alerts._renderDrawer();
    },

    _renderDrawer() {
      const body = document.getElementById('alert-drawer-body');
      if (!body) return;
      const plantRow = Store._state.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null;
      const hz = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? null;
      const cutoff = typeof hz === 'number' ? new Date(Date.now() + hz * 60000) : null;
      const alerts = cutoff ? Store.alerts.filter(a => !a.time || a.time <= cutoff) : Store.alerts;
      const hiddenCount = Store.alerts.length - alerts.length;
      if (!alerts.length) {
        body.innerHTML = `<div class="empty-state" style="padding:24px;color:#888;">${t('empty.no_active_alerts')}</div>`;
        return;
      }
      const sevIcon = { err: '✖', warn: '⚠', info: 'ℹ' };
      body.innerHTML = '';
      alerts.forEach(a => {
        const row = document.createElement('div');
        row.className = `alert-row alert-${a.sev}`;
        row.dataset.id = a.id;

        const ico = document.createElement('span');
        ico.className = 'alert-ico';
        ico.textContent = sevIcon[a.sev] || '•';

        const msg = document.createElement('span');
        msg.className = 'alert-msg';
        msg.textContent = a.msg;

        const actions = document.createElement('div');
        actions.className = 'alert-actions';

        if (a.taskId != null) {
          const gotoBtn = document.createElement('button');
          gotoBtn.className = 'btn btn-ghost sm';
          gotoBtn.textContent = t('btn.go_to');
          gotoBtn.onclick = () => NIMBUS.Alerts.focus(a.id);
          actions.appendChild(gotoBtn);
        }

        // Fix-it button for actionable alert types
        const fixable = ['overlap', 'blackout', 'overload'].includes(a.type);
        if (fixable) {
          const fixBtn = document.createElement('button');
          fixBtn.className = 'btn-fix';
          fixBtn.textContent = t('btn.fix_it');
          fixBtn.title = t('tip.fix_alert');
          fixBtn.onclick = () => NIMBUS.Alerts.applyFix(a.id);
          actions.appendChild(fixBtn);
        } else if (a.type === 'closed' || a.type === 'fixed-closed' || a.type === 'fixed-out-of-hours') {
          if (a.taskId != null) {
            const ovrBtn = document.createElement('button');
            ovrBtn.className = 'btn btn-ghost sm';
            ovrBtn.textContent = t('btn.override');
            ovrBtn.onclick = () => { NIMBUS.Alerts.toggleDrawer(); NIMBUS.Table._openOverrideModalForId(a.taskId); };
            actions.appendChild(ovrBtn);
          }
        }

        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'btn btn-ghost sm';
        dismissBtn.textContent = t('btn.dismiss');
        dismissBtn.onclick = () => NIMBUS.Alerts.dismiss(a.id);
        actions.appendChild(dismissBtn);

        row.appendChild(ico);
        row.appendChild(msg);
        row.appendChild(actions);
        body.appendChild(row);
      });
      if (hiddenCount > 0) {
        const note = document.createElement('div');
        note.style.cssText = 'padding:10px 16px;font-size:11.5px;color:var(--fg-mute);border-top:1px solid var(--border);';
        const hzDays = Math.max(1, Math.round(hz / 1440));
        note.textContent = `${hiddenCount} alert${hiddenCount > 1 ? 's' : ''} beyond the ${hzDays}-day window hidden — adjust in System Settings.`;
        body.appendChild(note);
      }
    },

    applyFix(alertId) {
      const a = Store.alerts.find(x => x.id === alertId);
      if (!a) return;

      if (a.type === 'overlap' || a.type === 'blackout') {
        const task = Store.tasks[a.taskId];
        if (!task || !task.start_date) { Toast.show(t('toast.cannot_fix_task'), 'error'); return; }
        const line = task.PRODUCTION_LINE || 'Unknown';
        const dur  = (task.end_date - task.start_date) || Util.runHours(task) * 3600000 || 3600000;

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
        try { Engine.autoReflow(task.id); } catch (e) {}
        UndoStack.push(`Auto-fix overlap "${task.text || task.id}"`, () => UndoStack.restoreTasks(snap));
        Alerts.dismiss(alertId);
        Toast.show(t('toast.order_moved', { name: task.text || task.id, date: Util.fmtDT(newStart) }), 'success');

      } else if (a.type === 'overload') {
        // Scope the combined optimizer to just this line+day
        const line = a.line, day = Util.dayKey(a.time || new Date());
        const snap = UndoStack.snapshotTasks(Store.tasksArr.filter(t =>
          (t.PRODUCTION_LINE || 'Unknown') === line && t.start_date && Util.dayKey(t.start_date) === day
        ).map(t => t.id));
        Engine.runAndApply('combined');
        UndoStack.push(`Auto-fix overload ${line} ${day}`, () => UndoStack.restoreTasks(snap));
        Alerts.dismiss(alertId);
      }
    },
/* ----- BELL BADGE ------------------------------------------------------ */
    _renderBell() {
      const badge = document.getElementById('alert-badge');
      const bell  = document.getElementById('alert-bell');
      const plantRow = Store._state.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null;
      const hz = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? null;
      const cutoff = typeof hz === 'number' ? new Date(Date.now() + hz * 60000) : null;
      const visible = cutoff ? Store.alerts.filter(a => !a.time || a.time <= cutoff) : Store.alerts;
      const n = visible.length;
      if (n > 0) {
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.style.display = '';
        bell.style.color = visible.some(a => a.sev === 'err') ? 'var(--err)' : 'var(--warn)';
      } else {
        badge.style.display = 'none';
        bell.style.color = '';
      }
    }
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
  const Utilization = {
    _cache: null,  // { key, matrix } — memoized result of the Store-backed compute path
    /** Returns { [line]: { [dayKey]: { scheduled, capacity, pct, tasks } } }.
     *  Pass `srcTasks` to scope the result to a filtered task subset.
     *  The srcTasks===null path is memoized on (startMs, days, Store._rev); _rev bumps on
     *  every Store mutation, so a cache hit always reflects current data. Subset calls
     *  (srcTasks provided) skip the cache. Treat the returned matrix as read-only. */
    computeMatrix(startDate, days = 7, srcTasks = null) {
      const start = Util.startOfDay(startDate);
      const cacheable = srcTasks === null;
      const cacheKey = `${start.getTime()}|${days}|${Store._rev || 0}`;
      if (cacheable && Utilization._cache && Utilization._cache.key === cacheKey) {
        return Utilization._cache.matrix;
      }
      const taskList = srcTasks !== null ? srcTasks : Store.tasksArr;
      const matrix = {};
      const lines = new Set(taskList.map(t => t.PRODUCTION_LINE || 'Unknown'));
      if (srcTasks === null) Object.keys(Store.calendars).forEach(l => lines.add(l));

      for (const line of lines) {
        matrix[line] = {};
        for (let i = 0; i < days; i++) {
          const d = new Date(start); d.setDate(start.getDate() + i);
          const key = Util.dayKey(d);
          matrix[line][key] = {
            date: d,
            scheduled:         0,
            capacity:          Calendar.dailyCapacityHours(line, d),
            effectiveCapacity: Calendar.effectiveCapacityHours(line, d),
            tasks:             []
          };
        }
      }

      for (const t of taskList) {
        if (!t.start_date) continue;
        const line = t.PRODUCTION_LINE || 'Unknown';
        if (!matrix[line]) continue;

        // Defensive: ingest edge cases may leave end_date null. Fall back to
        // legacy single-day attribution so the row still appears.
        if (!t.end_date) {
          const key = Util.dayKey(t.start_date);
          if (matrix[line][key]) {
            matrix[line][key].scheduled += Util.runHours(t);
            matrix[line][key].tasks.push(t);
          }
          continue;
        }

        const tStartMs = t.start_date.getTime();
        const tEndMs   = t.end_date.getTime();
        if (tEndMs <= tStartMs) continue;
        const taskRunHrs = Util.runHours(t);
        if (taskRunHrs <= 0) continue;
        // Distribute RUN_TIME proportionally by calendar-day overlap so that
        // orders scheduled outside or across working hours still count toward
        // the day's load. The denominator (dailyCapacityHours) already deducts
        // blackouts, giving the correct scheduled/available ratio.
        const totalTaskMs = tEndMs - tStartMs;

        // Iterate the matrix's pre-built day rows (bounded to `days` ≤ 14)
        // rather than walking [start_date, end_date]. SAP-bloated end_dates
        // can sit months past start_date; the old open-ended walk was burning
        // 30-42 s on the main thread re-walking days that have no matrix row.
        const lineRows = matrix[line];
        for (const key of Object.keys(lineRows)) {
          const row = lineRows[key];
          const dayStartMs = row.date.getTime();
          const dayEndMs   = dayStartMs + 86400000;
          if (tEndMs <= dayStartMs || tStartMs >= dayEndMs) continue;
          if (!Calendar.workWindow(line, row.date)) continue;
          const overlapMs = Math.min(tEndMs, dayEndMs) - Math.max(tStartMs, dayStartMs);
          const contribution = taskRunHrs * (overlapMs / totalTaskMs);
          if (contribution > 0) {
            row.scheduled += contribution;
            row.tasks.push(t);
          }
        }
      }
      for (const line of Object.keys(matrix)) {
        for (const k of Object.keys(matrix[line])) {
          const row = matrix[line][k];
          row.pct = row.capacity > 0 ? row.scheduled / row.capacity : (row.scheduled > 0 ? 1 : 0);
        }
      }
      if (cacheable) Utilization._cache = { key: cacheKey, matrix };
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
      for (const line of lines) {
        const cap = Calendar.dailyCapacityHours(line, d);
        const effectiveCap = Calendar.effectiveCapacityHours(line, d);
        const workWin = Calendar.workWindow(line, d);
        let sched = 0;
        if (workWin) {
          const plant = Store.getPlantForLine(line);
          const blackouts = [];
          for (const b of Store.blocks) {
            if (b.line && b.line !== line) continue;
            const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
            if (s && e) blackouts.push({ s, e });
          }
          for (const b of Store.plantBlocks) {
            if (b.plant && b.plant !== plant) continue;
            const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
            if (s && e) blackouts.push({ s, e });
          }
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

  /* =============================================================================
     ENGINE — scheduling + optimisation.
     Two run modes:
       • runAndApply(mode): full global re-optimise, respecting fixed + calendars.
       • autoReflow(changedId): after a manual edit, re-flow downstream orders on
         the same (line, day) around the change.
     ========================================================================== */
  const Engine = {
    /** Pick a sort comparator for the given optimisation mode.
     *  colorMap (optional): COLOR→order_y overrides from a plant-specific wheel. */
    _comparator(mode, colorMap) {
      if (mode === 'spt') {
        return (a, b) => Util.runHours(a) - Util.runHours(b);
      }
      if (mode === 'changeover' || mode === 'combined') {
        // 'changeover' minimizes setups by grouping identical attributes adjacently
        // (color → form → material); run time only breaks final ties.
        // 'combined' keeps the color+form changeover grouping but runs the SHORTEST job
        // first within each group (SPT), trading a little grouping for better flow time.
        // The two modes now produce genuinely different sequences (previously identical).
        const sptWithinGroup = (mode === 'combined');
        return (a, b) => {
          const oa = colorMap
            ? (colorMap[Util.norm(a.COLOR)] ?? 999999)
            : (a.ORDER_Y ?? 999999);
          const ob = colorMap
            ? (colorMap[Util.norm(b.COLOR)] ?? 999999)
            : (b.ORDER_Y ?? 999999);
          if (oa !== ob) return oa - ob;
          const fa = Util.norm(a.FORM_SIZE), fb = Util.norm(b.FORM_SIZE);
          if (fa !== fb) return fa.localeCompare(fb);
          if (sptWithinGroup) {
            const ha = Util.runHours(a), hb = Util.runHours(b);
            if (ha !== hb) return ha - hb;
            return Util.norm(a.MATERIAL_NUMBER).localeCompare(Util.norm(b.MATERIAL_NUMBER));
          }
          const ma = Util.norm(a.MATERIAL_NUMBER), mb = Util.norm(b.MATERIAL_NUMBER);
          if (ma !== mb) return ma.localeCompare(mb);
          return Util.runHours(a) - Util.runHours(b);
        };
      }
      // Default: preserve input order
      return () => 0;
    },

    /** Main optimiser. Groups by line, optionally respects fixed + calendar.
     *  Writes results through Store.
     *  opts.plant restricts to lines belonging to that plant.
     *  opts.colorMap pre-fetched color→order_y priority map from plant wheel. */
    runAndApply(mode = 'combined', opts = {}) {
      if (!Store.tasksArr.length) { Toast.show(t('toast.no_tasks_to_optimise'), 'error'); return; }
      const plant           = opts.plant           ?? Store.selectedPlant;
      if (!plant) {
        Toast.show(t('toast.select_plant_before_opt'), 'warn');
        return;
      }
      const colorMap        = opts.colorMap        ?? null;
      const respectFixed    = opts.respectFixed    ?? (document.getElementById('chk-respect-fixed')?.checked    ?? true);
      const respectCalendar = opts.respectCalendar ?? (document.getElementById('chk-respect-calendar')?.checked ?? true);
      const comparator = Engine._comparator(mode, colorMap);

      const horizonStart = opts.startDate
        ? new Date(opts.startDate)
        : (() => { const d = new Date(); d.setSeconds(0, 0); return d; })();
      const horizonEnd   = opts.endDate   ? new Date(opts.endDate)          : new Date(horizonStart.getTime() + 35 * 24 * 3600000);
      const isAged       = t => t.end_date   && t.end_date   < horizonStart;
      const isOutOfWin   = t => t.start_date && t.start_date > horizonEnd;

      // Optional caller-supplied line filter — when present, only these lines are optimized.
      const allowed = Array.isArray(opts.lines) && opts.lines.length
        ? new Set(opts.lines)
        : null;

      // Group tasks by line using the pre-built plant index (avoids a full tasksArr scan).
      // Skip non-allowed lines at insertion when a line filter is supplied so we don't
      // pay for grouping work that will just be discarded.
      const groups = {};
      for (const t of Store.tasksByPlant(plant)) {
        const line = t.PRODUCTION_LINE || 'Unknown';
        if (allowed && !allowed.has(line)) continue;
        (groups[line] ||= { line, tasks: [] }).tasks.push(t);
      }

      const patches = [];

      // Install per-run Calendar caches (workWindow memo + pre-indexed blocks) for the
      // duration of the scheduling pass. Torn down in finally{} so an exception
      // mid-loop can't leak the cache into UI/Alerts callers.
      Calendar._beginRun(plant);
      try {

      for (const line of Object.keys(groups)) {
        if ((Store.lineSettings[line] || {}).excludeFromOpt) continue;
        const { tasks } = groups[line];

        const fixedTasks = tasks.filter(t =>
          (respectFixed && Store.isFixed(t.id)) || isAged(t) || isOutOfWin(t)
        );
        let freeTasks = tasks.filter(t =>
          !(respectFixed && Store.isFixed(t.id)) && !isAged(t) && !isOutOfWin(t)
        );

        // Schwartzian transform for changeover/combined: pre-compute normalized
        // sort keys once per task instead of recomputing on every comparison.
        // Sort order mirrors `_comparator` exactly (V8 Array.sort is stable since ES2019):
        //   changeover → color → form → material → hours (pure setup grouping)
        //   combined   → color → form → hours → material (SPT within each group)
        if (mode === 'changeover' || mode === 'combined') {
          const decorated = freeTasks.map(t => ({
            t,
            o: colorMap ? (colorMap[Util.norm(t.COLOR)] ?? 999999) : (t.ORDER_Y ?? 999999),
            f: Util.norm(t.FORM_SIZE),
            m: Util.norm(t.MATERIAL_NUMBER),
            h: Util.runHours(t),
          }));
          if (mode === 'combined') {
            decorated.sort((a, b) =>
              (a.o - b.o) ||
              a.f.localeCompare(b.f) ||
              (a.h - b.h) ||
              a.m.localeCompare(b.m)
            );
          } else {
            decorated.sort((a, b) =>
              (a.o - b.o) ||
              a.f.localeCompare(b.f) ||
              a.m.localeCompare(b.m) ||
              (a.h - b.h)
            );
          }
          freeTasks = decorated.map(d => d.t);
        } else {
          freeTasks.sort(comparator);
        }
        fixedTasks.sort((a,b) => (a.start_date?.getTime()||0) - (b.start_date?.getTime()||0));

        // Cursor floor is max(horizonStart, now): extending "From" backwards
        // widens eligibility (older orders become free to move) but never
        // schedules anything in the literal past.
        const now = new Date();
        now.setSeconds(0, 0);
        const cursorFloor = horizonStart.getTime() > now.getTime() ? horizonStart : now;

        let cursor;
        if (respectCalendar) {
          const win = Calendar.workWindow(line, cursorFloor);
          cursor = (win && win[0].getTime() > cursorFloor.getTime())
            ? new Date(win[0])
            : new Date(cursorFloor);
        } else {
          cursor = new Date(cursorFloor);
        }

        // Walk through free tasks, jumping past each fixed task we encounter.
        let fixIdx = 0;
        for (const t of freeTasks) {
          const durMs = Util.runHours(t) * 3600000;
          if (durMs <= 0) continue;

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
              cursor = Calendar.nextAvailable(line, cursor, durMs);
            }

            // If cursor didn't move, both constraints are satisfied — done.
            if (cursor.getTime() === prevMs) break;
          }
          // Guard exhausted without converging: the fixed-task + calendar constraints never
          // settled on a stable slot. Placement still proceeds at `cursor`, but surface it
          // so the condition isn't silently swallowed (previously a hard-to-diagnose "why
          // didn't this order move?" at scale).
          if (guard >= 200) {
            ErrorLog.warn('engine',
              `Placement guard hit 200 iterations on "${line}" for order "${t.text || t.id}" — ` +
              `schedule may be suboptimal; check fixed orders / blackouts on this line.`,
              { line, taskId: t.id });
          }

          const start = new Date(Math.round(cursor.getTime() / 60000) * 60000);
          const end   = new Date(start.getTime() + durMs);
          patches.push({ id: t.id, changes: { start_date: start, end_date: end } });
          cursor = new Date(end);
        }
      }

      } finally {
        Calendar._endRun();
      }

      if (patches.length) Store.updateMany(patches, 'engine');
      Store._state.meta.lastOptimize = new Date();
      Alerts.clearDismissed();
      Alerts.recompute();
    },

    /** After a manual edit to one task, re-flow subsequent unfixed orders on the
     *  same line to eliminate overlap. Spans day boundaries so Day-1 overflow
     *  cascades correctly into Day-2 tasks. Does NOT move fixed orders. */
    autoReflow(changedId) {
      const changed = Store.tasks[changedId];
      if (!changed || !changed.start_date || !changed.end_date) return;
      const _horizonStart = Util.startOfDay(new Date());
      if (changed.end_date < _horizonStart) return; // aged task — don't reflow
      const line = changed.PRODUCTION_LINE || 'Unknown';

      const peers = Store.tasksByPlant(Store.selectedPlant)
        .filter(t => (t.PRODUCTION_LINE || 'Unknown') === line
                  && t.start_date && t.end_date
                  && t.id !== changedId)
        .sort((a,b) => a.start_date - b.start_date);

      // Walk forward from the changed task's end, pushing any overlapping unfixed
      // peer that starts before cursor to cursor (preserving duration).
      let cursor = new Date(changed.end_date);
      const patches = [];
      for (const p of peers) {
        // Peer ends before the changed task starts — entirely prior, cannot overlap; skip.
        if (p.end_date <= changed.start_date) continue;
        if (p.start_date >= cursor) { cursor = new Date(p.end_date); continue; }
        if (Store.isFixed(p.id) || p.end_date < _horizonStart) {
          // Fixed or aged orders don't move — if there's a conflict, an alert will fire.
          cursor = new Date(Math.max(cursor.getTime(), p.end_date.getTime()));
          continue;
        }
        const dur = p.end_date - p.start_date;
        const newStart = Calendar.nextAvailable(line, cursor, dur);
        const newEnd   = new Date(newStart.getTime() + dur);
        patches.push({ id: p.id, changes: { start_date: newStart, end_date: newEnd } });
        cursor = new Date(newEnd);
      }
      if (patches.length) Store.updateMany(patches, 'engine');
      // Reflow only ever shifts dates within `line`, so scope the alert recompute to it.
      Alerts.scheduleRecomputeLines(new Set([line]));
    }
  };

/* =============================================================================
     OPTIMIZE DIALOG — time-window & strategy picker for Engine.runAndApply
     ========================================================================== */
  const OptimizeDialog = (() => {
    let _mode    = 'changeover';
    let _preset  = '2w';
    let _start   = null;
    let _end     = null;
    let _fpStart = null;
    let _fpEnd   = null;
    let _plant   = null;
    let _allPlants = [];
    let _dropdownListenerSet = false;
    let _scope   = 'plant';            // 'plant' | 'lines'
    let _selectedLines = new Set();    // line names when _scope === 'lines'
    let _lineSearch = '';              // current line-list filter text
    let _wheelCache = null;            // { plant, colorMap, wheelUsed } — populated by _updatePlantBadge
    let _wheelFetchToken = 0;          // monotonic token to ignore stale responses

    const PRESET_DAYS = { '2w': 14 }; // UI only exposes '2w' and 'custom'

    function _initPickers() {
      if (_fpStart) return;
      _fpStart = flatpickr('#opt-from-cal', {
        inline: true, enableTime: true, minuteIncrement: 1,
        dateFormat: 'Y-m-d\\TH:i',
      });
      _fpEnd = flatpickr('#opt-to-cal', {
        inline: true, enableTime: true, minuteIncrement: 1,
        dateFormat: 'Y-m-d\\TH:i',
      });
    }

    function _buildPlantSelect() {
      const dynamic = Store.tasksArr.map(t => Store.getPlantForLine(t.PRODUCTION_LINE)).filter(Boolean);
      _allPlants = [...new Set([...Config.KNOWN_PLANTS, ...dynamic])].sort();
      const list = document.getElementById('opt-plant-list');
      if (!list) return;
      if (!_allPlants.length) {
        list.innerHTML = `<li class="opt-plant-empty">${t('ui.no_plant_data')}</li>`;
        _plant = null;
        _updateTriggerLabel();
        return;
      }
      _plant = (Store.selectedPlant && _allPlants.includes(Store.selectedPlant))
        ? Store.selectedPlant
        : (_plant && _allPlants.includes(_plant) ? _plant : null);
      if (_plant) Store.setSelectedPlant(_plant, 'optimize-dialog');
      _renderPlantList(_allPlants);
      _updateTriggerLabel();
      _initDropdownListener();
    }

    function _renderPlantList(plants) {
      const list = document.getElementById('opt-plant-list');
      if (!list) return;
      if (!plants.length) {
        list.innerHTML = `<li class="opt-plant-empty">${t('ui.no_matches')}</li>`;
        return;
      }
      list.innerHTML = plants.map(p => {
        const safe = p.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `<li class="opt-plant-item${_plant === p ? ' selected' : ''}" role="option"
             aria-selected="${_plant === p}"
             onclick="NIMBUS.OptimizeDialog.selectPlant('${safe}')">${p}</li>`;
      }).join('');
    }

    function _updateTriggerLabel() {
      const lbl = document.getElementById('opt-plant-trigger-label');
      if (lbl) lbl.textContent = _plant || t('ui.select_plant_label');
    }

    function _initDropdownListener() {
      if (_dropdownListenerSet) return;
      _dropdownListenerSet = true;
      document.addEventListener('click', e => {
        const sel = document.getElementById('opt-plant-select');
        if (sel && !sel.contains(e.target)) _closeDropdown();
      }, true);
    }

    function toggleDropdown() {
      const dd      = document.getElementById('opt-plant-dropdown');
      const trigger = document.getElementById('opt-plant-trigger');
      const sel     = document.getElementById('opt-plant-select');
      if (!dd) return;
      const opening = dd.hidden;
      if (opening && trigger) {
        const rect = trigger.getBoundingClientRect();
        dd.style.top   = (rect.bottom + 4) + 'px';
        dd.style.left  = rect.left + 'px';
        dd.style.width = rect.width + 'px';
      }
      dd.hidden = !opening;
      sel?.classList.toggle('open', opening);
      if (opening) {
        const srch = document.getElementById('opt-plant-search');
        if (srch) { srch.value = ''; srch.focus(); }
        _renderPlantList(_allPlants);
      }
    }

    function _closeDropdown() {
      const dd = document.getElementById('opt-plant-dropdown');
      const sel = document.getElementById('opt-plant-select');
      if (dd) dd.hidden = true;
      sel?.classList.remove('open');
    }

    function filterPlants(query) {
      const q = query.toLowerCase().trim();
      _renderPlantList(q ? _allPlants.filter(p => p.toLowerCase().includes(q)) : _allPlants);
    }

    function selectPlant(plant) {
      _plant = plant;
      Store.setSelectedPlant(plant, 'optimize-dialog');
      _renderPlantList(_allPlants);
      _updateTriggerLabel();
      _closeDropdown();
      _updatePlantBadge();
      _selectedLines.clear();
      _lineSearch = '';
      const srch = document.getElementById('opt-line-search');
      if (srch) srch.value = '';
      if (_scope === 'lines') _renderLines();
      if (_preset === 'horizon') applyPreset('horizon');
    }

    function setScope(scope) {
      _scope = scope === 'lines' ? 'lines' : 'plant';
      document.querySelectorAll('.opt-scope-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.scope === _scope)
      );
      const panel = document.getElementById('opt-lines-panel');
      if (panel) panel.hidden = _scope !== 'lines';
      if (_scope === 'lines') _renderLines();
    }

    function _linesForPlant() {
      if (!_plant) return [];
      const set = new Set(Store.linesForSelectedPlant());
      for (const t of Store.tasksByPlant(_plant)) {
        const l = t.PRODUCTION_LINE || 'Unknown';
        set.add(l);
      }
      return [...set].sort((a, b) => a.localeCompare(b));
    }

    function _renderLines() {
      const list = document.getElementById('opt-lines-list');
      const count = document.getElementById('opt-lines-count');
      if (!list) return;

      const allLines = _linesForPlant();
      if (!allLines.length) {
        list.innerHTML = `<li class="opt-lines-empty">${t('ui.no_lines_plant')}</li>`;
        if (count) count.textContent = t('ui.lines_selected', { sel: 0, total: 0 });
        return;
      }

      // Count orders per line (scoped to selected plant)
      const orderCounts = {};
      for (const t of Store.tasksByPlant(_plant)) {
        const l = t.PRODUCTION_LINE || 'Unknown';
        orderCounts[l] = (orderCounts[l] || 0) + 1;
      }

      const q = _lineSearch.toLowerCase().trim();
      const visible = q ? allLines.filter(l => l.toLowerCase().includes(q)) : allLines;

      if (!visible.length) {
        list.innerHTML = `<li class="opt-lines-empty">${t('ui.no_matches')}</li>`;
      } else {
        list.innerHTML = visible.map(line => {
          const safe = line.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          const checked = _selectedLines.has(line) ? 'checked' : '';
          const oc = orderCounts[line] || 0;
          const excluded = (Store.lineSettings[line] || {}).excludeFromOpt;
          const exTag = excluded ? '<span class="opt-line-excluded" title="Globally excluded from optimization">excluded</span>' : '';
          return `<li class="opt-line-row${excluded ? ' is-excluded' : ''}" role="option" aria-selected="${!!checked}">
              <label class="opt-line-label">
                <input type="checkbox" ${checked} onchange="NIMBUS.OptimizeDialog._onLineToggle('${safe}', this.checked)">
                <span class="opt-line-name">${line}</span>
                ${exTag}
                <span class="opt-line-orders">${oc} order${oc === 1 ? '' : 's'}</span>
              </label>
            </li>`;
        }).join('');
      }

      if (count) count.textContent = `${_selectedLines.size} of ${allLines.length} selected`;
    }

    function filterLines(q) {
      _lineSearch = q || '';
      _renderLines();
    }

    function selectAllLines(checked) {
      const allLines = _linesForPlant();
      const q = _lineSearch.toLowerCase().trim();
      const visible = q ? allLines.filter(l => l.toLowerCase().includes(q)) : allLines;
      for (const l of visible) {
        if (checked) _selectedLines.add(l);
        else _selectedLines.delete(l);
      }
      _renderLines();
    }

    function _onLineToggle(line, checked) {
      if (checked) _selectedLines.add(line);
      else _selectedLines.delete(line);
      const count = document.getElementById('opt-lines-count');
      const total = _linesForPlant().length;
      if (count) count.textContent = `${_selectedLines.size} of ${total} selected`;
    }

    function _displayDate(d) {
      return d.toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit'
      });
    }

    function _updateSummary() {
      const el = document.getElementById('opt-date-summary');
      if (!el || !_start || !_end) return;
      const days = Math.round((_end - _start) / 86400000);
      el.innerHTML =
        `<span class="opt-date-summary-range">${_displayDate(_start)} → ${_displayDate(_end)}</span>` +
        `<span class="opt-date-summary-days">&nbsp;· ${days} days</span>`;
    }

    function applyPreset(key) {
      _preset = key;
      document.querySelectorAll('.opt-preset-chip').forEach(c =>
        c.classList.toggle('active', c.dataset.preset === key)
      );
      const row = document.getElementById('opt-date-row');
      if (row) row.classList.toggle('visible', key === 'custom');

      if (key !== 'custom') {
        let days;
        if (key === 'horizon') {
          const plantRow = Store._state.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null;
          const horizonMinutes = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? 20160;
          days = Math.max(1, Math.ceil(horizonMinutes / 1440));
        } else {
          days = PRESET_DAYS[key];
        }
        const now = new Date();
        now.setSeconds(0, 0);
        _start = new Date(now);
        _end   = new Date(now.getTime() + days * 86400000);
        _fpStart?.setDate(_start, false);
        _fpEnd?.setDate(_end, false);
        const sb = document.getElementById('opt-start-btn');
        const eb = document.getElementById('opt-end-btn');
        if (sb) sb.textContent = _displayDate(_start);
        if (eb) eb.textContent = _displayDate(_end);
      }
      _updateSummary();
    }

    function selectMode(mode) {
      _mode = mode;
      document.querySelectorAll('.opt-strategy-pill').forEach(c =>
        c.classList.toggle('active', c.dataset.mode === mode)
      );
    }

    function _updatePlantBadge() {
      const plant   = _plant;
      const badgeEl = document.getElementById('opt-wheel-badge');
      const runBtn  = document.getElementById('opt-run-btn');

      if (runBtn) runBtn.disabled = !plant;

      if (!badgeEl) return;
      const setBadge = (state, icon, tip) => {
        badgeEl.className = `opt-wheel-badge compact ${state}`;
        badgeEl.title = tip;
        badgeEl.innerHTML = `<span class="owb-icon${state === 'loading' ? ' cw-spin' : ''}">${icon}</span>`;
      };

      if (!plant) {
        _wheelCache = null;
        setBadge('none', '⚠', 'No plant selected');
        return;
      }

      setBadge('loading', '', 'Checking color wheel…');
      const token = ++_wheelFetchToken;

      // Fetch the per-plant wheel directly so we can cache the colorMap and
      // skip a second round-trip when the user clicks Run.
      fetch(`${Config.API_BASE}/color-wheel/${encodeURIComponent(plant)}`, { signal: AbortSignal.timeout(5000) })
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(body => {
          if (token !== _wheelFetchToken) return; // stale response — ignore
          const entries = (body && body.entries) || [];
          if (entries.length) {
            const colorMap = {};
            for (const e of entries) colorMap[Util.norm(e.color)] = e.order_y ?? 999999;
            _wheelCache = { plant, colorMap, wheelUsed: true };
            setBadge('active', '✓', 'Color wheel is loaded');
          } else {
            _wheelCache = { plant, colorMap: null, wheelUsed: false };
            setBadge('warn', '○', 'No color wheel — will optimize without color priority');
          }
        })
        .catch(() => {
          if (token !== _wheelFetchToken) return;
          _wheelCache = { plant, colorMap: null, wheelUsed: false };
          setBadge('warn', '○', 'Could not check wheel — optimizing without color priority');
        });
    }

    function open() {
      // Plant scope is owned by the header selector. The dialog will not open
      // without a plant set there, because the optimizer needs a concrete scope.
      if (!Store.selectedPlant) {
        Toast.show(t('toast.select_plant_before_opt'), 'warn');
        return;
      }
      const el = document.getElementById('modal-optimize');
      if (!el) return;
      el.hidden = false;
      // Sync option checkboxes from the Gantt toolbar's existing chk- elements
      const rfEl = document.getElementById('chk-respect-fixed');
      const rcEl = document.getElementById('chk-respect-calendar');
      const ofEl = document.getElementById('opt-chk-fixed');
      const ocEl = document.getElementById('opt-chk-calendar');
      if (rfEl && ofEl) ofEl.checked = rfEl.checked;
      if (rcEl && ocEl) ocEl.checked = rcEl.checked;
      _initPickers();
      _buildPlantSelect();
      applyPreset('horizon');
      selectMode('changeover');
      // Reset the Run button HTML in case a previous session left it in the
      // "Optimizing…" state (e.g., Cancel mid-fetch).
      const runBtn = document.getElementById('opt-run-btn');
      if (runBtn) runBtn.innerHTML = `<span class="opt-run-icon">📈</span>${t('btn.run_optimization')}`;
      _updatePlantBadge();
      // Default scope to whole-plant on each open; clear stale line selection.
      _selectedLines.clear();
      _lineSearch = '';
      const lineSrch = document.getElementById('opt-line-search');
      if (lineSrch) lineSrch.value = '';
      setScope('plant');
      requestAnimationFrame(() => el.querySelector('.opt-modal')?.classList.add('visible'));
    }

    function close(immediate = false) {
      const el = document.getElementById('modal-optimize');
      if (!el) return;
      const inner = el.querySelector('.opt-modal');
      inner?.classList.remove('visible');
      if (immediate) {
        // Hide the backdrop element NOW (no 230ms fade). Used when another
        // modal is replacing this one — the heavy blur(12px) backdrop sits at
        // z=3000 and would cover the replacement until the fade completed.
        el.hidden = true;
        return;
      }
      setTimeout(() => { el.hidden = true; }, 230);
    }

    async function run() {
      const plant = _plant;
      if (!plant) {
        Toast.show(t('toast.select_plant_to_opt'), 'warn');
        return;
      }
      if (_scope === 'lines' && _selectedLines.size === 0) {
        Toast.show(t('toast.select_lines_to_opt'), 'warn');
        return;
      }
      const sfEl = document.getElementById('opt-chk-fixed');
      const scEl = document.getElementById('opt-chk-calendar');

      // Immediate visual feedback so the click feels responsive.
      const runBtn = document.getElementById('opt-run-btn');
      const origRunHTML = runBtn ? runBtn.innerHTML : null;
      const restoreRunBtn = () => {
        if (!runBtn) return;
        runBtn.disabled = !_plant;
        if (origRunHTML !== null) runBtn.innerHTML = origRunHTML;
      };
      if (runBtn) {
        runBtn.disabled = true;
        runBtn.innerHTML = `<span class="opt-run-icon">⏳</span>${t('btn.optimizing')}`;
      }

      // Open the preview dialog with a spinner IMMEDIATELY — before the wheel
      // fetch (which can take up to 1.5s on cold cache) and the config-modal
      // close transition. Otherwise the user stares at a blurry frozen page
      // for ~1–2s with no visible response to their click.
      OptimizerPreview.showLoading(_mode, plant);
      // Hide the config modal RIGHT NOW (no 230ms fade). Its backdrop sits at
      // z-index 3000 with blur(12px) and would cover the preview spinner
      // (z=2000) for the entire await fetch(wheel) + fade duration. Hiding
      // immediately is what makes the spinner actually visible on click.
      close(true);

      // Use the cached per-plant wheel populated by _updatePlantBadge.
      // Fall back to a quick fetch only if the cache hasn't filled yet (race
      // on first open) — tighter timeout so a slow backend can't dominate UX.
      let colorMap = null;
      let wheelUsed = false;
      if (_wheelCache && _wheelCache.plant === plant) {
        colorMap  = _wheelCache.colorMap;
        wheelUsed = _wheelCache.wheelUsed;
      } else {
        try {
          const resp = await fetch(`${Config.API_BASE}/color-wheel/${encodeURIComponent(plant)}`, { signal: AbortSignal.timeout(1500) });
          if (resp.ok) {
            const body = await resp.json();
            const entries = body.entries || [];
            if (entries.length) {
              colorMap = {};
              for (const e of entries) colorMap[Util.norm(e.color)] = e.order_y ?? 999999;
              wheelUsed = true;
            }
          }
        } catch (_) {
          // No wheel reachable — continue without
        }
      }

      // Confirm if no wheel and using changeover/combined mode
      if (!wheelUsed && (_mode === 'changeover' || _mode === 'combined')) {
        const ok = await Modal.confirm({ title: t('modal.no_color_wheel_confirm_msg', { plant }) });
        if (!ok) { OptimizerPreview.hideLoading(); restoreRunBtn(); return; }
      }

      const linesScope = (_scope === 'lines' && _selectedLines.size) ? Array.from(_selectedLines) : null;
      const optsForEngine = {
        plant,
        colorMap,
        lines:           linesScope,
        startDate:       _start ?? (() => { const d = new Date(); d.setSeconds(0, 0); return d; })(),
        endDate:         _end   ?? new Date(Date.now() + 28 * 86400000),
        respectFixed:    sfEl?.checked ?? true,
        respectCalendar: scEl?.checked ?? true,
      };

      // Config modal was already hidden (close(true) above) before the wheel
      // fetch — no second close() needed here.

      // Defer the optimizer run by one frame so the modal-close paint and the
      // heavy subscriber fanout don't fight for the same main-thread tick.
      // Route through OptimizerPreview (C4) — wraps Engine.runAndApply with
      // a pre/post KPI comparison and an apply/discard step.
      requestAnimationFrame(() => setTimeout(() => {
        OptimizerPreview.runWithPreview(_mode, optsForEngine);
      }, 0));

      // Persist audit log entry
      fetch(`${Config.API_BASE}/audit/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User': 'trevor.holton@newellco.com' },
        body: JSON.stringify({
          action: 'optimization_run', plant,
          details: {
            mode: _mode, wheel_used: wheelUsed, task_count: Store.tasksArr.length,
            scope: _scope, lines: linesScope || null,
          },
        }),
      }).catch(() => {});
    }

    function openFromPicker() {
      _initPickers();
      if (_start) _fpStart.setDate(_start, false);
      Modal.open('modal-opt-from');
    }
    function cancelFromPicker() {
      if (_start) _fpStart?.setDate(_start, false);
      Modal.close('modal-opt-from');
    }
    function commitFrom() {
      const d = _fpStart && _fpStart.selectedDates[0];
      if (d) {
        _start = new Date(d);
        if (_fpEnd && _start) _fpEnd.set('minDate', _start);
        const sb = document.getElementById('opt-start-btn');
        if (sb) sb.textContent = _displayDate(_start);
        _updateSummary();
      }
      Modal.close('modal-opt-from');
    }
    function openToPicker() {
      _initPickers();
      if (_end) _fpEnd.setDate(_end, false);
      Modal.open('modal-opt-to');
    }
    function cancelToPicker() {
      if (_end) _fpEnd?.setDate(_end, false);
      Modal.close('modal-opt-to');
    }
    function commitTo() {
      const d = _fpEnd && _fpEnd.selectedDates[0];
      if (d) {
        _end = new Date(d);
        const eb = document.getElementById('opt-end-btn');
        if (eb) eb.textContent = _displayDate(_end);
        _updateSummary();
      }
      Modal.close('modal-opt-to');
    }

    return { open, close, run, applyPreset, selectMode, selectPlant, toggleDropdown, filterPlants, _updatePlantBadge, setScope, filterLines, selectAllLines, _onLineToggle, openFromPicker, cancelFromPicker, commitFrom, openToPicker, cancelToPicker, commitTo };
  })();

/* =============================================================================
     ERROR LOG — structured in-memory log for the whole app.
     Levels: info | warn | error.  Caps at MAX entries.
     Exposed UI: badge in header + drawer. Keyboard: Ctrl+Alt+L.
     ========================================================================== */
  const ErrorLog = {
    MAX: 500,
    _entries: [],
    _listeners: new Set(),
    _recent: [],            // rolling 60s window of {ts, level} for rate alarms
    _globalsInstalled: false,

    _push(level, scope, msg, ctx) {
      const e = {
        ts: new Date().toISOString(),
        level, scope, msg,
        ctx: ctx === undefined ? null : ErrorLog._safeCtx(ctx)
      };
      ErrorLog._entries.push(e);
      if (ErrorLog._entries.length > ErrorLog.MAX) ErrorLog._entries.splice(0, ErrorLog._entries.length - ErrorLog.MAX);
      ErrorLog._pushRecent(level);
      // mirror to console so power users see it
      const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      console[fn](`[${scope}]`, msg, ctx ?? '');
      for (const l of ErrorLog._listeners) { try { l(e); } catch {} }
      ErrorLog._renderBadge();
    },
    info (scope, msg, ctx) { ErrorLog._push('info',  scope, msg, ctx); },
    warn (scope, msg, ctx) { ErrorLog._push('warn',  scope, msg, ctx); },
    error(scope, msg, ctx) { ErrorLog._push('error', scope, msg, ctx); },

    _pushRecent(level) {
      const now = Date.now();
      ErrorLog._recent.push({ ts: now, level });
      while (ErrorLog._recent.length && ErrorLog._recent[0].ts < now - 60_000) ErrorLog._recent.shift();
    },
    errorRatePerMin() { return ErrorLog._recent.filter(e => e.level === 'error').length; },
    warnRatePerMin()  { return ErrorLog._recent.filter(e => e.level === 'warn').length; },

    installGlobalHandlers() {
      if (ErrorLog._globalsInstalled) return;
      ErrorLog._globalsInstalled = true;
      window.addEventListener('error', e => {
        const loc = e.filename ? `${e.filename}:${e.lineno || '?'}:${e.colno || '?'}` : '';
        ErrorLog.error('uncaught', `${e.message || 'Unknown error'}${loc ? ' @ ' + loc : ''}`, e.error?.stack);
      });
      window.addEventListener('unhandledrejection', e => {
        const reason = e.reason instanceof Error
          ? `${e.reason.message}\n${e.reason.stack || ''}`
          : String(e.reason);
        ErrorLog.error('promise', reason);
      });
    },

    entries() { return ErrorLog._entries.slice(); },
    countBy(level) { return ErrorLog._entries.filter(e => e.level === level).length; },
    clear() {
      ErrorLog._entries = [];
      ErrorLog._renderBadge();
      for (const l of ErrorLog._listeners) { try { l({ cleared: true }); } catch {} }
    },
    subscribe(fn) { ErrorLog._listeners.add(fn); return () => ErrorLog._listeners.delete(fn); },

    _safeCtx(v) {
      try { JSON.stringify(v); return v; }
      catch { try { return String(v); } catch { return '[unserialisable]'; } }
    },

   // Debounced so rapid bursts of log pushes don't thrash the DOM.
    _renderBadge: Util.debounce(function () {
      let btn = document.getElementById('err-log-btn');
      if (!btn) {
        const host = document.getElementById('alert-bell')?.parentElement
                  || document.querySelector('.topbar-actions')
                  || document.body;
        btn = document.createElement('button');
        btn.id = 'err-log-btn';
        btn.title = 'Open Admin Cockpit log (Ctrl+Alt+L)';
        btn.onclick = () => { try { App.goto('admin'); } catch {} };
        host.appendChild(btn);
      }
      const errs  = ErrorLog.countBy('error');
      const warns = ErrorLog.countBy('warn');
      const total = ErrorLog._entries.length;
      const dot   = errs ? '🔴' : warns ? '🟡' : '🟢';
      btn.textContent = '';   // clear before rebuild
      const dotSpan = document.createElement('span');
      dotSpan.textContent = dot;
      const label = document.createTextNode(` Log `);
      const count = document.createElement('span');
      count.style.cssText = 'opacity:.65;font-family:ui-monospace,monospace;font-size:11px;';
      count.textContent = total;
      btn.appendChild(dotSpan);
      btn.appendChild(label);
      btn.appendChild(count);
    }, 80),

    copy() {      const txt = ErrorLog._entries.map(e =>
        `${e.ts} [${e.level.toUpperCase()}] ${e.scope}: ${e.msg}${e.ctx ? ' :: ' + JSON.stringify(e.ctx) : ''}`
      ).join('\n');
      navigator.clipboard?.writeText(txt).then(
        () => Toast.show(t('toast.log_copied'), 'success'),
        () => Toast.show(t('toast.copy_failed'), 'error')
      );
    }
  };

  /* =============================================================================
     TOAST — transient notification banners (top-right stack).
       Toast.show(msg, type?, ms?)  — show a message; type: 'info'|'warn'|'error'|'success'
       Cap of 3 visible at once: drops oldest non-error first when exceeded.
       Dedupes by (msg, type) — repeats refresh the existing toast's timer.
       Default duration 1500ms; callers may override.
     ========================================================================== */
  const Toast = (function() {
    const MAX_VISIBLE = 3;
    const _visible = [];

    function _scheduleRemoval(entry, ms) {
      entry.timerId = setTimeout(() => _remove(entry), ms);
    }

    function _remove(entry) {
      if (entry._removing) return;
      entry._removing = true;
      if (entry.timerId) { clearTimeout(entry.timerId); entry.timerId = null; }
      const idx = _visible.indexOf(entry);
      if (idx !== -1) _visible.splice(idx, 1);
      entry.el.classList.add('leaving');
      setTimeout(() => entry.el.remove(), 220);
    }

    function _evictOne() {
      let victim = _visible.find(e => e.type !== 'error');
      if (!victim) victim = _visible[0];
      if (victim) _remove(victim);
    }

    return {
      show(msg, type = 'info', ms = 1500) {
        const stack = document.getElementById('toast-stack');
        if (!stack) return;

        const dup = _visible.find(e => !e._removing && e.msg === msg && e.type === type);
        if (dup) {
          if (dup.timerId) clearTimeout(dup.timerId);
          _scheduleRemoval(dup, ms);
          return;
        }

        while (_visible.length >= MAX_VISIBLE) _evictOne();

        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = msg;
        stack.appendChild(el);

        const entry = { el, msg, type, timerId: null, _removing: false };
        _visible.push(entry);
        _scheduleRemoval(entry, ms);
      }
    };
  })();

  /* =============================================================================
     MODAL — show/hide helpers for all modals (driven by hidden attribute).
       Modal.open(id)                  — unhide modal with the given element ID
       Modal.close(id)                 — hide modal with the given element ID
       Modal.confirm(msg, onOk, onCancel?) — two-button confirmation dialog
     ========================================================================== */
  const Modal = {
    open(id)  { const el = document.getElementById(id); if (el) el.hidden = false; },
    close(id) { const el = document.getElementById(id); if (el) el.hidden = true;  },

    // Promise-based confirmation dialog.
    // opts: { title, message, detail (HTML string), confirmLabel, tone: 'danger'|'warn' }
    confirm(opts = {}) {
      return new Promise(resolve => {
        document.getElementById('confirm-title').textContent   = opts.title   || 'Confirm';
        document.getElementById('confirm-message').textContent = opts.message || '';
        const det = document.getElementById('confirm-detail');
        if (opts.detail) { det.innerHTML = opts.detail; det.hidden = false; }
        else             { det.textContent = ''; det.hidden = true; }
        const okBtn = document.getElementById('confirm-ok-btn');
        okBtn.textContent  = opts.confirmLabel || 'Confirm';
        okBtn.className    = `btn btn-${opts.tone === 'warn' ? 'warn' : 'danger'}`;
        const done = ok => { cleanup(); resolve(ok); };
        const cleanup = () => {
          okBtn.removeEventListener('click', onOk);
          document.getElementById('confirm-cancel-btn').removeEventListener('click', onCancel);
          Modal.close('confirm-modal');
        };
        const onOk     = () => done(true);
        const onCancel = () => done(false);
        okBtn.addEventListener('click', onOk);
        document.getElementById('confirm-cancel-btn').addEventListener('click', onCancel);
        Modal.open('confirm-modal');
      });
    }
  };

  /* =============================================================================
     TIMELINE — vis-timeline integration.
       • builds groups (production lines) and items (orders + blackout blocks)
       • two-way sync: user drags → Store.updateTask({ source:'timeline' })
                       Store changes → refresh items, skipping own-source events
       • right-click → ContextMenu
       • double-click → open in Inspector
     ========================================================================== */
  const Timeline = {
    _tl: null,
    _items:     null,
    _visItems:  null,             // DataView filter layer — vis-timeline sees only items near the viewport
    _groups:    null,
    _viewWindow: null,            // { start: ms, end: ms } — current viewport, kept in sync via rangechanged
    _pastZoneIds:     [],         // cached IDs for ticker updates (avoids getIds() scan every second)
    _alertHorizonIds: [],
    _lineColorIdx: {},            // stable line → colour index mapping
    _nextColorIdx: 0,
    _unsubStore:   null,
    _suppressEvents: false,       // guard to prevent self-triggered loops

    init() {
      const container = document.getElementById('vis-timeline');
      if (!container) return;

      Timeline._items  = new vis.DataSet([]);
      Timeline._groups = new vis.DataSet([]);

      // Sliding-window DataView: vis-timeline only processes items within ±90 days of
      // the current viewport, regardless of how far the full schedule extends.
      // Internal code continues to read/write Timeline._items unchanged.
      const _WIN_BUF_MS = 90 * 24 * 3600 * 1000;
      Timeline._visItems = new vis.DataView(Timeline._items, {
        filter: item => {
          const w = Timeline._viewWindow;
          if (!w) return true;
          const s = item.start instanceof Date ? item.start.getTime() : +item.start;
          const e = item.end   instanceof Date ? item.end.getTime()   : +item.end;
          return s < w.end + _WIN_BUF_MS && e > w.start - _WIN_BUF_MS;
        }
      });

      const options = {
        stack: false,
        editable: { updateTime: true, updateGroup: true, remove: false, add: false },
        snap: d => Util.snap(d),
        groupOrder: (a, b) => (a.order ?? 0) - (b.order ?? 0),
        orientation: { axis: 'top' },
        zoomMin: 15 * 60 * 1000,           // 15 min
        zoomMax: 30 * 24 * 3600 * 1000,    // 30 days
        zoomKey: 'ctrlKey',
        margin: { item: { horizontal: 2, vertical: 4 } },
        height: '100%',
        verticalScroll: true,
        tooltip: false,
        showCurrentTime: true
      };

      Timeline._tl = new vis.Timeline(container, Timeline._visItems, Timeline._groups, options);

      // Prime the viewport window immediately so the DataView filter is ready.
      const _initW = Timeline._tl.getWindow();
      Timeline._viewWindow = { start: _initW.start.getTime(), end: _initW.end.getTime() };

      // Refresh the DataView after the user finishes panning/zooming. Debounced so it
      // never fires per-frame during active drag — items already in the window stay
      // rendered; fringe items outside the buffer are evicted/loaded once pan settles.
      const _refreshView = Util.debounce(() => {
        const w = Timeline._tl.getWindow();
        Timeline._viewWindow = { start: w.start.getTime(), end: w.end.getTime() };
        Timeline._visItems.refresh();
      }, 120);
      Timeline._tl.on('rangechanged', _refreshView);

      // One-shot screen calibration: measure real row + axis after first render
      // with content so _fitHeight uses screen-specific values from then on.
      // Selectors are scoped to specific panels because vis-timeline reuses
      // .vis-time-axis for both the label row (top panel, ~30px) AND a
      // full-height grid overlay inside .vis-content. Matching the wrong one
      // would inflate axisH to container height and poison the cache.
      const _calibrate = () => {
        const c = document.getElementById('vis-timeline');
        if (!c) return;
        const sampleItem = c.querySelector('.vis-panel.vis-center .vis-foreground .vis-item');
        const axisEl = c.querySelector('.vis-panel.vis-top .vis-time-axis')
                    || c.querySelector('.vis-time-axis.vis-foreground');
        if (!sampleItem || !axisEl) return;
        const itemH = sampleItem.getBoundingClientRect().height;
        const axisH = axisEl.getBoundingClientRect().height;
        // Sanity bounds — reject obviously bogus measurements (stretched grid,
        // detached layout, etc.) and wait for the next 'changed' event.
        if (itemH <= 4 || itemH > 60) return;
        if (axisH <= 8 || axisH > 120) return;
        const MARGIN_V = 4; // matches options.margin.item.vertical
        Timeline._cachedRowH = itemH + MARGIN_V * 2;
        Timeline._cachedAxisH = axisH;
        Timeline._tl.off('changed', _calibrate);
      };
      Timeline._tl.on('changed', _calibrate);

      /* -----------------------------------------------------------------
       * NOTE: Input events (select/click, doubleClick, contextmenu, and
       * DataSet drag commits) are ALL owned by the Interaction module.
       * This module only owns the view, the store subscription, and the
       * redraw/rebuild plumbing. Keeping input-handling in one place is
       * what eliminates the select↔setSelection echo loop that made fixed
       * orders look like they were being re-scheduled on every click.
       * ----------------------------------------------------------------- */

      /* ----- live ticker: advance past-zone and alert-horizon-zone every second -- */
      setInterval(() => {
        if (!Timeline._items || !Timeline._pastZoneIds.length) return;
        const now  = new Date();
        const updates = Timeline._pastZoneIds
          .filter(id => Timeline._items.get(id))
          .map(id => ({ id, end: now }));
        if (Timeline._alertHorizonIds.length) {
          const plantRow = Store._state.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null;
          const hz = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? null;
          if (typeof hz === 'number') {
            const hzEnd = new Date(now.getTime() + hz * 60000);
            for (const id of Timeline._alertHorizonIds) {
              if (Timeline._items.get(id)) updates.push({ id, start: now, end: hzEnd });
            }
          }
        }
        if (updates.length) Timeline._items.update(updates);
      }, 1000);

      /* ----- subscribe to store changes ----------------------------------- */
      Timeline._unsubStore = Store.subscribe(evt => Timeline._onStore(evt));
    },

    /** Handle store updates: refresh vis-timeline WITHOUT echoing back. */
    _onStore(evt) {
      // Ignore our own mutations — we already applied them visually.
      if (evt.source === 'timeline') return;

      if (evt.type === 'plant:selected') {
        if (document.getElementById('gantt-tab')?.classList.contains('active')) {
          Timeline.rebuild();
        } else {
          Timeline._renderEmptyOverlay();
        }
        return;
      }

      if (evt.type === 'tasks:bulk' || evt.type === 'blocks:change'
          || evt.type === 'calendar:change' || evt.type === 'plantBlocks:change') {
        // Only do a full rebuild when the gantt tab is active; otherwise
        // the next goto('gantt') will call rebuild() anyway.
        if (document.getElementById('gantt-tab')?.classList.contains('active')) {
          Timeline.rebuild();
        }
      } else if (evt.type === 'tasks:bulkUpdate') {
        // Patch individual items — avoids groups.clear() which resets vertical scroll.
        // Skip tasks on lines hidden by the Gantt line filter, otherwise their items
        // get added to the DataSet and the filter visually "leaks" on optimize runs.
        if (document.getElementById('gantt-tab')?.classList.contains('active')) {
          const sel = (typeof GanttFilter !== 'undefined') ? GanttFilter._selectedLines : null;
          const filtered = sel && sel.size > 0;
          for (const id of (evt.ids || [])) {
            if (filtered) {
              const t = Store.tasks[id];
              if (!t || !sel.has(t.PRODUCTION_LINE || 'Unknown')) continue;
            }
            Timeline._applyTaskPatch(String(id));
          }
        }
      } else if (evt.type === 'task:update' && evt.id != null) {
        Timeline._applyTaskPatch(String(evt.id));
      } else if (evt.type === 'fixed:change') {
        // just re-render those items' className
        for (const id of evt.ids) Timeline._applyTaskPatch(String(id));
      } else if (evt.type === 'alerts:change') {
        if (document.getElementById('gantt-tab')?.classList.contains('active')) {
          // Patch plant tasks to refresh conflict-order className — avoids
          // groups.clear() in rebuild() which resets vertical scroll. Honor the
          // line filter so hidden lines don't briefly flash in before rebuild().
          const sel = (typeof GanttFilter !== 'undefined') ? GanttFilter._selectedLines : null;
          const filtered = sel && sel.size > 0;
          for (const t of Store.tasksForSelectedPlant()) {
            if (!t.start_date || !t.end_date) continue;
            if (filtered && !sel.has(t.PRODUCTION_LINE || 'Unknown')) continue;
            Timeline._applyTaskPatch(String(t.id));
          }
          // Reconcile alert-cell background items via the diff-based rebuild.
          // rebuild() is cheap (only changed items add/update/remove) and is the
          // established pattern for blackout blocks.
          Timeline.rebuild();
        }
      }
    },

    _applyTaskPatch(id) {
      const t = Store.tasks[id];
      if (!t || !t.start_date || !t.end_date) return;
      const patch = Timeline._itemForTask(t);
      Timeline._suppressEvents = true;
      try {
        if (Timeline._items.get(id)) Timeline._items.update(patch);
        else                         Timeline._items.add(patch);
      } finally { Timeline._suppressEvents = false; }
    },

    /** Build an item object for a task. */
    _itemForTask(t) {
      const line = t.PRODUCTION_LINE || 'Unknown';
      const ci = Timeline._colorIndex(line);
      const fixed = Store.isFixed(t.id);
      const conflict = Store.alerts.some(a => String(a.taskId) === String(t.id));
      const label = t.text || t.ORDER || String(t.id);
      const cls = ['lc-' + ci];
      if (fixed) cls.push('fixed-order');
      if (conflict) cls.push('conflict-order');
      const prefix = fixed ? '🔒 ' : '';
      return {
        id:      String(t.id),
        group:   line,
        content: `<span style="padding:0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;">${prefix}${label}</span>`,
        start:   t.start_date,
        end:     t.end_date,
        className: cls.join(' ')
      };
    },

    /** Build an item object for a blackout block (non-editable, greyed out). */
    _itemForBlock(b, overrideLine) {
      // b.id already carries a 'blk-' prefix from Store.addBlock — don't double it.
      // When cloning for a specific line, append the line so IDs stay unique.
      const line = overrideLine || b.line || '__all__';
      const id   = overrideLine ? `${b.id}-${overrideLine}` : b.id;
      return {
        id,
        group:   line,
        content: `<span style="font-style:italic;">✕ ${b.reason || t('ui.blackouts_label', {plural: ''})}</span>`,
        title:   `${t('ui.blackouts_label', {plural: ''})}: ${b.reason || '—'}<br>${Util.fmtDT(b.start)} → ${Util.fmtDT(b.end)}`,
        start:   b.start, end: b.end,
        editable: false,
        className: 'blackout',
        type: 'background'
      };
    },
    /** Diff-based rebuild: compare desired item set to current DataSet contents
     *  and emit minimal add/update/remove operations. Preserves selection and
     *  avoids the clear/add flicker of a wholesale replacement.               */
    rebuild() {
      if (!Timeline._items || !Timeline._groups) return;
      Timeline._renderEmptyOverlay();
      // Save the current viewport so groups.clear() + re-add doesn't auto-fit.
      const savedWindow = Timeline._tl ? Timeline._tl.getWindow() : null;
      const all = Store.tasksForSelectedPlant();
      const tasks = all.filter(t => t.start_date && t.end_date);
      const dropped = all.length - tasks.length;
      if (dropped > 0) {
        ErrorLog.warn('timeline',
          `Rebuild: ${dropped} task(s) hidden (missing start/end)`,
          all.filter(t => !(t.start_date && t.end_date))
             .slice(0, 10)
             .map(t => ({ id: t.id, line: t.PRODUCTION_LINE, text: t.text })));
      }

      const plant = Store.selectedPlant;
      const plantLines = new Set(Store.linesForSelectedPlant());
      const lineSet = new Set(tasks.map(t => t.PRODUCTION_LINE || 'Unknown'));
      if (plant) {
        for (const l of plantLines) lineSet.add(l);
      }
      const sortedLines = [...lineSet].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      // Scope to GanttFilter line multi-select — without this, vis-timeline reserves
      // row height for every plant line and leaves ghost rows above the visible ones.
      const lineFilterActive = (typeof GanttFilter !== 'undefined')
        && GanttFilter._selectedLines
        && GanttFilter._selectedLines.size > 0;
      const visibleLines = lineFilterActive
        ? sortedLines.filter(l => GanttFilter._selectedLines.has(l))
        : sortedLines;
      const visibleSet = new Set(visibleLines);
      const scopedTasks = lineFilterActive
        ? tasks.filter(t => visibleSet.has(t.PRODUCTION_LINE || 'Unknown'))
        : tasks;
      // Compute alert-per-task set ONCE (fixes snapshot inconsistency during rebuild).
      const conflictIds = new Set();
      for (const a of Store.alerts) if (a.taskId != null) conflictIds.add(String(a.taskId));

      /* ---- groups ------------------------------------------------------------ */
      const groupData = visibleLines.map((line, idx) => {
        const ci = Timeline._colorIndex(line);
        return {
          id: line,
          order: idx,
          content: `<div style="display:flex;align-items:center;gap:6px;">
             <span style="width:8px;height:8px;border-radius:2px;background:${Config.COLORS[ci % Config.COLORS.length]};display:inline-block;"></span>
             <span style="font-size:12px;font-weight:600;">${line}</span>
           </div>`
        };
      });

      /* ---- desired items ---------------------------------------------------- */
      const desired = new Map();
      for (const t of scopedTasks) {
        const item = Timeline._itemForTask(t);
        // Apply the pre-computed conflict flag without walking alerts again.
        if (conflictIds.has(String(t.id))) {
          const cls = (item.className || '').split(' ').filter(Boolean);
          if (!cls.includes('conflict-order')) cls.push('conflict-order');
          item.className = cls.join(' ');
        }
        desired.set(String(item.id), item);
      }
      // Line blackout blocks — one per line for global blocks, one per assigned line otherwise.
      for (const b of Store.blocks) {
        if (b.line) {
          if (lineFilterActive && !visibleSet.has(b.line)) continue;
          const item = Timeline._itemForBlock(b);
          desired.set(String(item.id), item);
        } else {
          for (const line of visibleLines) {
            const item = { ...Timeline._itemForBlock(b), id: `${b.id}__${line}`, group: line };
            desired.set(String(item.id), item);
          }
        }
      }
      // Plant blackout blocks — rendered on every line belonging to that plant.
      for (const b of Store.plantBlocks) {
        const plant = b.plant;
        if (!plant) continue;
        for (const line of visibleLines) {
          if (Store.getPlantForLine(line) !== plant) continue;
          const item = { ...Timeline._itemForBlock(b, line), id: `${b.id}__plant__${line}` };
          desired.set(String(item.id), item);
        }
      }

      // Past-zone shading — one background item per visible line covering [epoch → now].
      // vis-timeline clips the rendered span to the visible window, so the far-past
      // start date is harmless. The item updates each rebuild so the boundary tracks time.
      const pastEnd = new Date();
      const pastStart = new Date('2000-01-01T00:00:00');
      for (const line of visibleLines) {
        const item = {
          id:       `past-zone-${line}`,
          group:    line,
          start:    pastStart,
          end:      pastEnd,
          type:     'background',
          className: 'past-zone',
          editable: false,
        };
        desired.set(item.id, item);
      }
      Timeline._pastZoneIds = visibleLines.map(l => `past-zone-${l}`);

      // Alert-horizon zone — light green band from now to now+alertHorizon, one per line.
      // Respects per-plant alt_flag_horizon override; absent when no horizon is configured.
      {
        const plantRow = Store._state.masterData?.plants?.find(p => p.plant === plant) ?? null;
        const hz = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? null;
        if (typeof hz === 'number') {
          const hzNow = new Date();
          const hzEnd = new Date(hzNow.getTime() + hz * 60000);
          for (const line of visibleLines) {
            desired.set(`alert-horizon-zone-${line}`, {
              id:        `alert-horizon-zone-${line}`,
              group:     line,
              start:     hzNow,
              end:       hzEnd,
              type:      'background',
              className: 'alert-horizon-zone',
              editable:  false,
            });
          }
          Timeline._alertHorizonIds = visibleLines.map(l => `alert-horizon-zone-${l}`);
        } else {
          Timeline._alertHorizonIds = [];
        }
      }

      // Alert-cell background items — inserted last so they sit on top of the horizon
      // and past-zone shading within .vis-background (DOM order = paint order).
      // Err severity wins over warn on the same cell.
      const alertCellMap = {};
      for (const a of Store.alerts) {
        if (!a.line || !a.time) continue;
        if (lineFilterActive && !visibleSet.has(a.line)) continue;
        const dk  = Util.dayKey(a.time);
        const key = `${a.line}|${dk}`;
        if (!alertCellMap[key]) alertCellMap[key] = { line: a.line, dayKey: dk, sev: a.sev };
        if (a.sev === 'err') alertCellMap[key].sev = 'err';
      }
      for (const key of Object.keys(alertCellMap)) {
        const cell = alertCellMap[key];
        const item = {
          id:    `alertcell-${cell.line}-${cell.dayKey}`,
          group: cell.line,
          start: new Date(cell.dayKey + 'T00:00:00'),
          end:   new Date(cell.dayKey + 'T23:59:59'),
          type:  'background',
          className: cell.sev === 'err' ? 'alertcell-err' : 'alertcell-warn',
          editable: false,
        };
        desired.set(String(item.id), item);
      }

      const existingIds = new Set(Timeline._items.getIds().map(String));
      const toAdd = [], toUpdate = [], toRemove = [];
      for (const [id, data] of desired) {
        if (existingIds.has(id)) toUpdate.push(data);
        else                     toAdd.push(data);
      }
      for (const id of existingIds) {
        if (!desired.has(id)) toRemove.push(id);
      }

      // Diff groups incrementally — never call groups.clear() because that drops
      // all rows from the DOM momentarily, which causes the browser to clamp
      // scrollTop to 0 and reset the vertical scroll position.
      const existingGroupIds = new Set(Timeline._groups.getIds().map(String));
      const newGroupIds      = new Set(groupData.map(g => String(g.id)));
      const groupsToRemove   = [...existingGroupIds].filter(id => !newGroupIds.has(id));
      const groupsToAdd      = groupData.filter(g => !existingGroupIds.has(String(g.id)));
      const groupsToUpdate   = groupData.filter(g =>  existingGroupIds.has(String(g.id)));

      Timeline._suppressEvents = true;
      try {
        if (groupsToRemove.length) Timeline._groups.remove(groupsToRemove);
        if (groupsToUpdate.length) Timeline._groups.update(groupsToUpdate);
        if (groupsToAdd.length)    Timeline._groups.add(groupsToAdd);
        if (toRemove.length) Timeline._items.remove(toRemove);
        if (toUpdate.length) Timeline._items.update(toUpdate);
        if (toAdd.length)    Timeline._items.add(toAdd);
      } finally {
        Timeline._suppressEvents = false;
      }

      // Re-sync selection with what still exists. Guard for pre-install rebuilds.
      if (typeof Selection !== 'undefined') {
        const keep = Selection.ids().filter(id => desired.has(id));
        if (keep.length !== Selection.size()) Selection.set(keep);
        Timeline._tl.setSelection(keep);
        if (Interaction.DEBUG) {
          ErrorLog.info('timeline',
            `diff-rebuild: +${toAdd.length} ~${toUpdate.length} -${toRemove.length} (kept sel: ${keep.length})`);
        }
      }
      // Fit the vis-timeline height to its visible groups — fixes the giant
      // empty area that `height: '100%'` reserves when 1-2 lines are filtered.
      // Uses explicit pixels (not 'auto') so the timeline doesn't collapse
      // inside its flex parent. Falls back to '100%' for many-group cases so
      // verticalScroll still works as before.
      Timeline._fitHeight(visibleLines.length);
      // Restore horizontal viewport in case group or item changes caused vis-timeline
      // to auto-fit.
      if (savedWindow && Timeline._tl) {
        Timeline._tl.setWindow(savedWindow.start, savedWindow.end, { animation: false });
      }
    },

    _fitHeight(groupCount) {
      if (!Timeline._tl) return;
      const container = document.getElementById('vis-timeline');
      if (!container) return;
      const containerH = container.clientHeight;
      if (containerH <= 0 || groupCount <= 0) {
        Timeline._tl.setOptions({ height: '100%' });
        return;
      }
      // Calibrated values come from the one-shot 'changed' listener at init;
      // 31/40 fallback applies on the very first rebuild before calibration fires.
      const ROW_H = Timeline._cachedRowH || 31;
      const AXIS_H = Timeline._cachedAxisH || 40;
      const needed = Math.ceil(groupCount * ROW_H + AXIS_H);
      Timeline._tl.setOptions({
        height: needed < containerH ? needed + 'px' : '100%'
      });
    },

    focus(id) {
      const t = Store.tasks[id];
      if (!t || !t.start_date || !t.end_date || !Timeline._tl) return;
      // vis-timeline's focus() scrolls both horizontally (time) and vertically (line row).
      Timeline._tl.focus(String(id), { animation: { duration: 300 } });
      Timeline._tl.setSelection([String(id)]);
      Inspector.show(t);
    },

    setView(mode) {
      if (!Timeline._tl) return;
      const now = new Date();
      let start, end;
      if (mode === 'hour') {
        start = Util.startOfDay(now);
        end   = new Date(start.getTime() + 24 * 3600000);
      } else if (mode === 'day') {
        start = Util.startOfDay(now);
        end   = new Date(start.getTime() + 3 * 24 * 3600000);
      } else {
        start = Util.startOfDay(now);
        end   = new Date(start.getTime() + 7 * 24 * 3600000);
      }
      Timeline._tl.setWindow(start, end, { animation: { duration: 300 } });
      document.querySelectorAll('.gantt-toolbar .seg-btn[data-view]').forEach(b => {
        b.classList.toggle('active', b.dataset.view === mode);
      });
    },

    redraw() { if (Timeline._tl) Timeline._tl.redraw(); },

    /** Show or hide the "select a plant" overlay above the vis-timeline. */
    _renderEmptyOverlay() {
      const overlay = document.getElementById('timeline-empty-overlay');
      if (!overlay) return;
      if (!Store.selectedPlant) {
        EmptyState.render(overlay, {
          title: t('empty.select_plant_timeline'),
          msg:   t('ui.select_plant_orders_msg')
        });
        overlay.hidden = false;
      } else {
        overlay.hidden = true;
        overlay.innerHTML = '';
      }
    },

    zoomToFit() {
      if (!Timeline._tl) return;
      const tasks = Store.tasksArr.filter(t => t.start_date && t.end_date);
      if (!tasks.length) return;
      const minT = Math.min(...tasks.map(t => t.start_date.getTime()));
      const maxT = Math.max(...tasks.map(t => t.end_date.getTime()));
      const span = maxT - minT;
      const pad  = span * 0.05 || 3600000;
      Timeline._tl.setWindow(new Date(minT - pad), new Date(maxT + pad), { animation: { duration: 400 } });
    },

    gotoNow() {
      if (!Timeline._tl) return;
      const now = new Date();
      Timeline._tl.setWindow(
        new Date(now.getTime() - 4 * 3600000),
        new Date(now.getTime() + 4 * 3600000),
        { animation: { duration: 300 } }
      );
    },

    _colorIndex(line) {
      if (Timeline._lineColorIdx[line] === undefined) {
        Timeline._lineColorIdx[line] = Timeline._nextColorIdx++ % Config.COLORS.length;
      }
      return Timeline._lineColorIdx[line];
    }
  };

  /* =============================================================================
     TABLE — AG Grid integration with rich inline editing, filtering, and full
     two-way sync. Uses the transaction API for fast incremental updates.
     ========================================================================== */
  const Table = {
    _api:    null,
    _colApi: null,
    _selectedId: null,  // for the override modal
    _noteOutsideHandler: null,
    _noteKeyHandler: null,
    _chipFilters: { lines: new Set(), colors: new Set(), status: null, dateKey: null },

    init() {
      const el = document.getElementById('ag-grid');
      if (!el || typeof agGrid === 'undefined') return;
      const lines = Table._getLineOptions();
      const gridOptions = {
        rowData: Store.tasksForSelectedPlant(),
        getRowId: p => String(p.data.id),
        rowSelection: 'multiple',
        rowMultiSelectWithClick: true,
        animateRows: false,
        suppressRowClickSelection: false,
        defaultColDef: {
          sortable: true,
          filter:   true,
          resizable: true,
          flex: 1,
          minWidth: 100,
          cellClass: p => Table._rowClass(p.data)
        },
        columnDefs: [
          {
            headerName: '',
            checkboxSelection: true,
            headerCheckboxSelection: true,
            width: 50,
            minWidth: 50,
            maxWidth: 50,
            flex: 0,
            pinned: 'left',
            lockPosition: true,
            suppressMenu: true,
            sortable: false,
            filter: false,
            resizable: false
          },
          {
            headerName: '', field: 'fixed',
            width: 42, minWidth: 42, maxWidth: 42, flex: 0,
            pinned: 'left',
            editable: false,
            cellRenderer: p => p.value ? '<span title="Fixed" style="color:var(--accent);font-size:13px;">🔒</span>' : '',
            headerTooltip: 'Fixed orders are locked from the optimiser'
          },
          { headerName: t('col.id'),   field: 'id',   width: 80, minWidth: 80, flex: 0, pinned: 'left',
            editable: false, cellClass: 'cell-num' },
          { headerName: t('col.order'), field: 'PRODUCTION_ORDER', minWidth: 160, editable: false,
            valueGetter: p => p.data.PRODUCTION_ORDER || p.data.ORDER || '' },
          { headerName: t('col.material'), field: 'MATERIAL_DESCRIPTION', minWidth: 180, editable: false },
          { headerName: t('col.qty'), field: 'ORDER_QUANTITY_(GMEIN)', width: 100, flex: 0,
            editable: false, cellClass: 'cell-num',
            valueParser: p => parseFloat(p.newValue) || 0 },
          { headerName: t('col.line'), field: 'PRODUCTION_LINE', minWidth: 130, editable: true,
            cellEditor: 'agSelectCellEditor',
            cellEditorParams: () => ({ values: Table._getLineOptions() }),
            cellRenderer: p => {
              if (!p.value) return '';
              const ci = Timeline._colorIndex(p.value);
              const color = Config.COLORS[ci % Config.COLORS.length];
              return `<span class="cell-line-tag"><span class="dot" style="background:${color}"></span>${p.value}</span>`;
            }
          },
          { headerName: t('col.color'), field: 'COLOR', width: 110, flex: 0, editable: false },
          { headerName: t('col.form'),  field: 'FORM_SIZE', width: 90, flex: 0, editable: false },
          { headerName: t('col.run_h'), field: 'RUN_TIME', width: 90, flex: 0, editable: true,
            cellClass: 'cell-num',
            valueParser: p => parseFloat(p.newValue) || 0 },
          { headerName: t('col.orig_start'), field: 'original_start_date', minWidth: 160,
            editable: false,
            valueFormatter: p => Util.fmtDT(p.value),
            cellClass: 'cell-date cell-date-original' },
          { headerName: t('col.orig_end'), field: 'original_end_date', minWidth: 160,
            editable: false,
            valueFormatter: p => Util.fmtDT(p.value),
            cellClass: 'cell-date cell-date-original' },
          { headerName: t('col.updated_start'), field: 'start_date', minWidth: 160,
            editable: true,
            valueFormatter: p => Util.fmtDT(p.value),
            cellEditor: Table._DateTimeEditor,
            cellClass: 'cell-date' },
          { headerName: t('col.updated_end'), field: 'end_date', minWidth: 160,
            editable: false,
            valueFormatter: p => Util.fmtDT(p.value),
            cellClass: 'cell-date' },
          { headerName: t('col.alerts'), field: 'id', width: 90, flex: 0, sortable: false, filter: false, editable: false,
            cellRenderer: p => {
              const rel = Store.alerts.filter(a => String(a.taskId) === String(p.value));
              if (!rel.length) return '';
              const err = rel.some(a => a.sev === 'err');
              const color = err ? 'var(--err)' : 'var(--warn)';
              return `<button onclick="NIMBUS.Table._showAlertPopup('${p.value}')"
                title="Click to view alerts"
                style="background:none;border:none;padding:0;cursor:pointer;color:${color};font-weight:600;font-size:inherit;font-family:inherit">
                ⚐ ${rel.length}</button>`;
            }
          },
          { headerName: '📝', field: 'notes', width: 54, minWidth: 54, maxWidth: 54, flex: 0,
            sortable: false, filter: false, editable: false, suppressMenu: true,
            cellRenderer: p => {
              const has = p.value != null && String(p.value).trim().length > 0;
              return `<button class="nb-note-btn${has ? ' nb-note-has' : ''}"
                title="${has ? 'Edit note' : 'Add note'}"
                onclick="NIMBUS.Table._showNotePopover(event,'${p.data.id}')">✎</button>`;
            }
          }
        ],
        onCellValueChanged: Table._onCellChanged,
        onSelectionChanged: Table._onSelectionChanged,
        isExternalFilterPresent: () => Table._hasChipFilters(),
        doesExternalFilterPass: node => Table._taskPassesChipFilters(node.data),
        onCellKeyDown: p => {
          if ((p.event.ctrlKey || p.event.metaKey) && p.event.key === 'c') {
            const raw = p.api.getValue(p.column.getColId(), p.node);
            const colDef = p.column.getColDef();
            let text = raw;
            if (colDef.valueFormatter) {
              const fmt = colDef.valueFormatter({ value: raw, data: p.data, node: p.node, column: p.column, api: p.api, colDef });
              if (fmt != null) text = fmt;
            }
            navigator.clipboard?.writeText(text == null ? '' : String(text)).catch(() => {});
            const cell = p.event.target?.closest?.('.ag-cell');
            if (cell) {
              cell.classList.add('ag-cell-copy-flash');
              setTimeout(() => cell.classList.remove('ag-cell-copy-flash'), 380);
            }
          }
        },
        onGridReady: params => {
          Table._api = params.api;
          Table._colApi = params.columnApi;
          Table._wireQuickFilter();
          Table._initChipFilters();
          ErrorLog.info('table', `AG Grid ready with ${Store.tasksArr.length} rows`);
        },
      };

      agGrid.createGrid(el, gridOptions);

      // Re-render rows whenever relevant store slices change.
      Store.subscribe(evt => Table._onStore(evt));

      // Outside-click closes any open chip dropdown. Capture phase so AG Grid
      // (which can stopPropagation on some interactions) doesn't swallow the event.
      const closeAllChipDropdowns = () => {
        ['line', 'color', 'status', 'date'].forEach(k => {
          const d = document.getElementById(`tbl-flt-${k}-dropdown`);
          if (d) d.hidden = true;
        });
      };
      document.addEventListener('mousedown', e => {
        if (!e.target.closest || !e.target.closest('#table-filterbar')) {
          closeAllChipDropdowns();
        }
      }, true);
      // Closing on Escape is also expected for menu-like UI.
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeAllChipDropdowns();
      });
    },

    // ── Filter chip bar ──────────────────────────────────────────────────
    _initChipFilters() {
      Table._refreshChipDropdowns();
      Table._refreshChipButtons();
    },

    _hasChipFilters() {
      const f = Table._chipFilters;
      return f.lines.size > 0 || f.colors.size > 0 || f.status !== null || f.dateKey !== null;
    },

    _taskPassesChipFilters(data) {
      if (!data) return false;
      const f = Table._chipFilters;
      if (f.lines.size > 0 && !f.lines.has(data.PRODUCTION_LINE)) return false;
      if (f.colors.size > 0 && !f.colors.has(String(data.COLOR || '').toUpperCase())) return false;
      if (f.dateKey) {
        const dk = data.start_date ? Util.dayKey(data.start_date) : '';
        if (dk !== f.dateKey) return false;
      }
      if (f.status) {
        const nowDt = new Date();
        if (f.status === 'late' && !(data.end_date && data.end_date < nowDt)) return false;
        if (f.status === 'fixed' && !Store.isFixed(data.id)) return false;
        if (f.status === 'atrisk' || f.status === 'conflict') {
          const rel = Store.alerts.filter(a => String(a.taskId) === String(data.id));
          if (f.status === 'atrisk'  && !rel.some(a => a.sev === 'warn')) return false;
          if (f.status === 'conflict' && !rel.some(a => a.sev === 'err'))  return false;
        }
      }
      return true;
    },

    _toggleChipDropdown(kind) {
      const d = document.getElementById(`tbl-flt-${kind}-dropdown`);
      if (!d) return;
      // Close peers
      ['line','color','status','date'].forEach(k => {
        if (k !== kind) {
          const other = document.getElementById(`tbl-flt-${k}-dropdown`);
          if (other) other.hidden = true;
        }
      });
      d.hidden = !d.hidden;
    },

    _refreshChipDropdowns() {
      Table._buildLineChipDropdown();
      Table._buildColorChipDropdown();
      Table._buildStatusChipDropdown();
      Table._buildDateChipDropdown();
    },

    _buildLineChipDropdown() {
      const drop = document.getElementById('tbl-flt-line-dropdown');
      if (!drop) return;
      const lineSet = new Set();
      for (const t of (Store.selectedPlant ? Store.tasksForSelectedPlant() : [])) {
        if (t.PRODUCTION_LINE) lineSet.add(t.PRODUCTION_LINE);
      }
      const sorted = [...lineSet].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      // Drop stale
      for (const l of [...Table._chipFilters.lines]) {
        if (!lineSet.has(l)) Table._chipFilters.lines.delete(l);
      }
      const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      drop.innerHTML = sorted.length
        ? sorted.map(l => `<label><input type="checkbox" value="${esc(l)}"${Table._chipFilters.lines.has(l) ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('line', this)"> ${esc(l)}</label>`).join('')
        : `<div style="padding:8px 14px;font-size:12px;color:#9a9285">No lines</div>`;
    },

    _buildColorChipDropdown() {
      const drop = document.getElementById('tbl-flt-color-dropdown');
      if (!drop) return;
      const colorSet = new Set();
      for (const t of (Store.selectedPlant ? Store.tasksForSelectedPlant() : [])) {
        if (t.COLOR) colorSet.add(String(t.COLOR).toUpperCase());
      }
      const sorted = [...colorSet].sort();
      for (const c of [...Table._chipFilters.colors]) {
        if (!colorSet.has(c)) Table._chipFilters.colors.delete(c);
      }
      const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      drop.innerHTML = sorted.length
        ? sorted.map(c => `<label><input type="checkbox" value="${esc(c)}"${Table._chipFilters.colors.has(c) ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('color', this)"> ${esc(c)}</label>`).join('')
        : `<div style="padding:8px 14px;font-size:12px;color:#9a9285">No colors</div>`;
    },

    _buildStatusChipDropdown() {
      const drop = document.getElementById('tbl-flt-status-dropdown');
      if (!drop) return;
      const cur = Table._chipFilters.status;
      const items = [
        { v: 'late',     k: 'Late',         d: 'end_date in the past' },
        { v: 'conflict', k: 'Conflicting',  d: 'has error alert' },
        { v: 'atrisk',   k: 'At risk',      d: 'has warning alert' },
        { v: 'fixed',    k: 'Fixed',        d: 'locked from optimiser' },
      ];
      drop.innerHTML = items.map(i =>
        `<label style="display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:6px 14px;">
           <span style="display:flex;align-items:center;gap:8px;">
             <input type="radio" name="tbl-flt-status" value="${i.v}"${cur === i.v ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('status', this)" style="accent-color:#b8791a;width:13px;height:13px;cursor:pointer;">
             <strong>${i.k}</strong>
           </span>
           <span style="font-size:10.5px;color:#9a9285;margin-left:21px;">${i.d}</span>
         </label>`).join('')
        + `<div style="border-top:1px solid #ece8e0;margin:4px 0;"></div>
           <label style="display:flex;align-items:center;justify-content:flex-start;gap:8px;padding:6px 14px;">
             <input type="radio" name="tbl-flt-status" value=""${cur === null ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('status', this)" style="accent-color:#b8791a;width:13px;height:13px;cursor:pointer;">
             <span>Any status</span>
           </label>`;
    },

    _buildDateChipDropdown() {
      const drop = document.getElementById('tbl-flt-date-dropdown');
      if (!drop) return;
      const today = Util.startOfDay(new Date());
      const tomorrow = new Date(today.getTime() + 86400000);
      const next7 = new Date(today.getTime() + 7 * 86400000);
      const cur = Table._chipFilters.dateKey;
      // Quick presets + clear. Underlying filter stores YYYY-MM-DD (single day) only;
      // longer ranges set status='atrisk-or-window' via dedicated keys.
      const presets = [
        { v: Util.dayKey(today),    k: t('ui.today'),    d: today.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) },
        { v: Util.dayKey(tomorrow), k: t('ui.tomorrow'), d: tomorrow.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) },
      ];
      drop.innerHTML = presets.map(p =>
        `<label style="display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:6px 14px;">
           <span style="display:flex;align-items:center;gap:8px;">
             <input type="radio" name="tbl-flt-date" value="${p.v}"${cur === p.v ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('date', this)" style="accent-color:#b8791a;width:13px;height:13px;cursor:pointer;">
             <strong>${p.k}</strong>
           </span>
           <span style="font-size:10.5px;color:#9a9285;margin-left:21px;">${p.d}</span>
         </label>`).join('')
        + `<div style="border-top:1px solid #ece8e0;margin:4px 0;"></div>
           <label style="display:flex;align-items:center;justify-content:flex-start;gap:8px;padding:6px 14px;">
             <input type="radio" name="tbl-flt-date" value=""${cur === null ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('date', this)" style="accent-color:#b8791a;width:13px;height:13px;cursor:pointer;">
             <span>${t('ui.any_date')}</span>
           </label>`;
    },

    _onChipChange(kind, input) {
      const f = Table._chipFilters;
      if (kind === 'line') {
        if (input.checked) f.lines.add(input.value);
        else               f.lines.delete(input.value);
      } else if (kind === 'color') {
        if (input.checked) f.colors.add(input.value.toUpperCase());
        else               f.colors.delete(input.value.toUpperCase());
      } else if (kind === 'status') {
        f.status = input.value || null;
      } else if (kind === 'date') {
        f.dateKey = input.value || null;
      }
      Table._refreshChipButtons();
      if (Table._api) Table._api.onFilterChanged();
      // Single-select chips close after a pick; multi-select stay open for more choices.
      if (kind === 'status' || kind === 'date') {
        const d = document.getElementById(`tbl-flt-${kind}-dropdown`);
        if (d) d.hidden = true;
      }
    },

    _clearChipFilters() {
      Table._chipFilters.lines.clear();
      Table._chipFilters.colors.clear();
      Table._chipFilters.status = null;
      Table._chipFilters.dateKey = null;
      Table._refreshChipDropdowns();
      Table._refreshChipButtons();
      if (Table._api) Table._api.onFilterChanged();
    },

    /** Driven from KPI tile clicks on the dashboard. Sets state, refreshes UI, re-filters grid. */
    _applyChipFilter(patch) {
      const f = Table._chipFilters;
      if ('status' in patch)  f.status  = patch.status  || null;
      if ('dateKey' in patch) f.dateKey = patch.dateKey || null;
      if (patch.lines)  { f.lines.clear();  for (const l of patch.lines)  f.lines.add(l); }
      if (patch.colors) { f.colors.clear(); for (const c of patch.colors) f.colors.add(String(c).toUpperCase()); }
      Table._refreshChipDropdowns();
      Table._refreshChipButtons();
      if (Table._api) Table._api.onFilterChanged();
    },

    _refreshChipButtons() {
      const plant = !!Store.selectedPlant;
      const f = Table._chipFilters;

      const set = (btnId, lblId, txt, active) => {
        const b = document.getElementById(btnId);
        const l = document.getElementById(lblId);
        if (b) { b.disabled = !plant; b.classList.toggle('active', !!active); }
        if (l) l.textContent = txt;
      };

      set('tbl-flt-line-btn',  'tbl-flt-line-label',
        f.lines.size === 0 ? t('ui.all_lines')
          : f.lines.size === 1 ? [...f.lines][0]
          : t('ui.n_lines_filter', { count: f.lines.size }),
        f.lines.size > 0);

      set('tbl-flt-color-btn', 'tbl-flt-color-label',
        f.colors.size === 0 ? t('ui.all_colors')
          : f.colors.size === 1 ? [...f.colors][0]
          : t('ui.n_colors_filter', { count: f.colors.size }),
        f.colors.size > 0);

      const STATUS_LABEL = { late: t('ui.late'), conflict: t('ui.conflicting'), atrisk: t('ui.at_risk'), fixed: t('ui.fixed') };
      set('tbl-flt-status-btn', 'tbl-flt-status-label',
        f.status ? STATUS_LABEL[f.status] || f.status : t('ui.all_statuses'),
        !!f.status);

      let dateLabel = t('ui.any_date');
      if (f.dateKey) {
        const todayKey = Util.dayKey(Util.startOfDay(new Date()));
        const tomorrowKey = Util.dayKey(new Date(Util.startOfDay(new Date()).getTime() + 86400000));
        if (f.dateKey === todayKey) dateLabel = t('ui.today');
        else if (f.dateKey === tomorrowKey) dateLabel = t('ui.tomorrow');
        else dateLabel = f.dateKey;
      }
      set('tbl-flt-date-btn', 'tbl-flt-date-label', dateLabel, !!f.dateKey);

      const hasAny = Table._hasChipFilters();
      const clear = document.getElementById('tbl-flt-clear');
      if (clear) clear.hidden = !hasAny;

      const hint = document.getElementById('tbl-flt-hint');
      if (hint && Table._api) {
        const n = Table._api.getDisplayedRowCount();
        hint.textContent = plant ? t('ui.orders_visible', { count: n, plural: n !== 1 ? t('ui.orders_visible_plural') : '' }) : '';
      }
    },

    _onStore(evt) {
      if (evt.source === 'table') return;
      if (!Table._api) return;
      if (evt.type === 'tasks:bulk' || evt.type === 'plant:selected'
          || evt.type === 'lineSettings:change') {
        const rows = Store.tasksForSelectedPlant();
        Table._api.setGridOption('rowData', rows);
        Table._renderEmptyState();
        if (evt.type === 'plant:selected') {
          // Clear chip filters on plant change — stale line/color sets don't apply.
          Table._chipFilters.lines.clear();
          Table._chipFilters.colors.clear();
          Table._chipFilters.status = null;
          Table._chipFilters.dateKey = null;
        }
        Table._refreshChipDropdowns();
        Table._refreshChipButtons();
        if (evt.type === 'tasks:bulk') {
          ErrorLog.info('table', `Rebuilt grid with ${rows.length} rows`);
        }
      } else if (evt.type === 'tasks:bulkUpdate') {
        const updated = evt.ids
          .map(id => Store.tasks[id])
          .filter(t => t && Store.getPlantForLine(t.PRODUCTION_LINE) === Store.selectedPlant);
        Table._api.applyTransaction({ update: updated });
        if (Table._hasChipFilters()) Table._api.onFilterChanged();
      } else if (evt.type === 'task:update') {
        const t = Store.tasks[evt.id];
        if (t && Store.selectedPlant
            && Store.getPlantForLine(t.PRODUCTION_LINE) === Store.selectedPlant) {
          Table._api.applyTransaction({ update: [t] });
        }
        if (Table._hasChipFilters()) Table._api.onFilterChanged();
      } else if (evt.type === 'fixed:change') {
        const updated = evt.ids
          .map(id => Store.tasks[id])
          .filter(t => t && Store.getPlantForLine(t.PRODUCTION_LINE) === Store.selectedPlant);
        Table._api.applyTransaction({ update: updated });
        if (Table._chipFilters.status === 'fixed') Table._api.onFilterChanged();
      } else if (evt.type === 'alerts:change') {
        Table._api.refreshCells({ columns: ['id'], force: true });
        Table._api.redrawRows();
        if (Table._chipFilters.status === 'conflict' || Table._chipFilters.status === 'atrisk') {
          Table._api.onFilterChanged();
        }
      }
      Table._refreshChipButtons();
    },

    _renderEmptyState() {
      const grid = document.getElementById('ag-grid');
      let overlay = document.getElementById('table-empty-overlay');
      if (!Store.selectedPlant) {
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.id = 'table-empty-overlay';
          overlay.className = 'table-empty-overlay';
          grid?.parentElement?.appendChild(overlay);
        }
        EmptyState.render(overlay, {
          title: t('empty.no_plant_selected'),
          msg:   t('empty.no_plant_table')
        });
        if (grid) grid.style.visibility = 'hidden';
      } else {
        if (overlay) overlay.remove();
        if (grid) grid.style.visibility = '';
      }
    },

    /** Called when a grid cell is edited. Push the change through the store. */
    _onCellChanged(p) {
      const field = p.colDef.field;
      const id = String(p.data.id);
      const changes = {};

      if (field === 'start_date') {
        const d = Util.parseDate(p.newValue);
        if (!d) { Toast.show(t('toast.invalid_date'), 'error'); Table._api.refreshCells({ rowNodes: [p.node] }); return; }
        changes.start_date = Util.snap(d);
        // recompute end based on RUN_TIME
        const dur = Util.runHours(p.data) * 3600000;
        if (dur > 0) changes.end_date = new Date(changes.start_date.getTime() + dur);
      } else if (field === 'RUN_TIME') {
        const h = parseFloat(p.newValue) || 0;
        changes.RUN_TIME = h;
        if (p.data.start_date) {
          changes.end_date = new Date(p.data.start_date.getTime() + h * 3600000);
        }
      } else if (field === 'ORDER_QUANTITY_(GMEIN)') {
        changes[field] = parseFloat(p.newValue) || 0;
      } else {
        changes[field] = p.newValue;
      }

      Store.updateTask(id, changes, 'table');
      Table._api.applyTransaction({ update: [Store.tasks[id]] });
      Engine.autoReflow(id);
      Alerts.scheduleRecompute();
      Toast.show(t('toast.row_updated'), 'success', 1200);
    },

    _onSelectionChanged() {
      if (!Table._api) return;
      const sel = Table._api.getSelectedRows();
      Table._selectedId = sel.length === 1 ? String(sel[0].id) : null;
    },

    _onRowClicked(event) {
      if (!event.data) return;
      const task = Store.tasks[event.data.id];
      if (task) {
        const rightSidebar = document.getElementById('right-sidebar');
        if (rightSidebar) {
          rightSidebar.classList.remove('collapsed');
          setTimeout(() => { Timeline.redraw(); TimelineNav.render(); }, 220);
        }
        Inspector.show(task);
      }
    },
   _rowClass(data) {      if (!data) return '';
      const ids = Store.alerts.filter(a => String(a.taskId) === String(data.id));
      if (ids.some(a => a.sev === 'err')) return 'row-alert';
      if (ids.some(a => a.sev === 'warn')) return 'row-warn';
      return '';
    },

    _getLineOptions() {
      const set = new Set(Store.tasksArr.map(t => t.PRODUCTION_LINE || 'Unknown'));
      Object.keys(Store.calendars).forEach(l => set.add(l));
      return [...set].sort();
    },

    _wireQuickFilter() {
      const inp = document.getElementById('quick-filter');
      if (!inp || !Table._api) return;
      inp.addEventListener('input', () => {
        Table._api.setGridOption('quickFilterText', inp.value);
      });
    },

    /* ---- public actions: fixing, override modal, export ------------------ */
    fixSelected(fixed) {
      if (!Table._api) return;
      const sel = Table._api.getSelectedRows();
      if (!sel.length) { Toast.show(t('toast.select_rows_first'), 'warn'); return; }
      const ids = sel.map(r => String(r.id));
      Store.setFixed(ids, fixed, 'table');
      Alerts.scheduleRecompute();
    },

    openOverrideModal() {
      const sel = Table._api ? Table._api.getSelectedRows() : [];
      if (sel.length !== 1) { Toast.show(t('toast.select_one_row'), 'warn'); return; }
      Table._openOverrideModalForId(String(sel[0].id));
    },

    _openOverrideModalForId(id) {
      const t = Store.tasks[id];
      if (!t) return;
      Table._selectedId = id;
      document.getElementById('ovr-order').textContent = `${t.text || t.ORDER || t.id}  ·  Line: ${t.PRODUCTION_LINE || '—'}`;
      if (!Table._fpOvrStart) {
        Table._fpOvrStart = flatpickr('#ovr-start', {
          enableTime: true, dateFormat: 'Y-m-d\\TH:i',
          altInput: true, altFormat: 'M j, Y · h:i K', minuteIncrement: 30,
        });
      }
      Table._fpOvrStart.setDate(t.start_date, false);
      const sel = document.getElementById('ovr-line');
      const lines = Table._getLineOptions();
      sel.innerHTML = lines.map(l => `<option value="${l}" ${l === t.PRODUCTION_LINE ? 'selected' : ''}>${l}</option>`).join('');
      document.getElementById('ovr-fix').checked = !!t.fixed;
      Modal.open('modal-override');
    },

    applyOverride() {
      const id = Table._selectedId;
      if (!id) return;
      const t = Store.tasks[id];
      if (!t) return;
      const newStart = Util.parseDate(document.getElementById('ovr-start').value);
      const newLine  = document.getElementById('ovr-line').value;
      const alsoFix  = document.getElementById('ovr-fix').checked;
      if (!newStart) { Toast.show(t('toast.invalid_date'), 'error'); return; }

      const dur = Util.runHours(t) * 3600000;
      const snapped = Util.snap(newStart);
      const newEnd = new Date(snapped.getTime() + dur);

      Store.updateTask(id, {
        start_date: snapped,
        end_date: newEnd,
        PRODUCTION_LINE: newLine
      }, 'table');
      Table._api.applyTransaction({ update: [Store.tasks[id]] });
      if (alsoFix !== Store.isFixed(id)) Store.setFixed([id], alsoFix, 'table');

      // Override explicitly does NOT auto-reflow (user's manual choice),
      // but we DO recompute alerts so conflicts become visible.
      Alerts.scheduleRecompute();
      Modal.close('modal-override');
      Toast.show(alsoFix ? t('toast.order_overridden_fixed') : t('toast.order_overridden'), 'success');
    },

    exportCsv() {
      if (!Table._api) return;
      Table._api.exportDataAsCsv({ fileName: 'nimbus-orders.csv' });
    },

    _showAlertPopup(taskId) {
      const rel = Store.alerts.filter(a => String(a.taskId) === String(taskId));
      if (!rel.length) return;
      const t = Store.tasks[taskId];
      const po = t?.PRODUCTION_ORDER || t?.ORDER || String(taskId).slice(0, 8);
      const _esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

      const rows = rel.map(a => {
        const icon  = a.sev === 'err' ? '🔴' : '🟡';
        const color = a.sev === 'err' ? 'var(--err)' : 'var(--warn)';
        const date  = a.time ? a.time.toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '';
        return `
          <div style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:6px;background:var(--bg-subtle);margin-bottom:6px">
            <span style="flex-shrink:0;font-size:13px;margin-top:1px">${icon}</span>
            <span style="flex:1;font-size:12.5px;color:var(--fg);line-height:1.45">${_esc(a.msg)}</span>
            ${date ? `<span style="flex-shrink:0;font-size:10.5px;color:var(--fg-mute);white-space:nowrap;margin-top:2px">${date}</span>` : ''}
            <button data-alert-id="${_esc(a.id)}"
              style="flex-shrink:0;padding:2px 10px;font-size:11px;border-radius:5px;border:1px solid var(--line);background:none;cursor:pointer;color:var(--fg-mute);white-space:nowrap;margin-top:1px">
              Go to
            </button>
          </div>`;
      }).join('');

      const dlg = document.createElement('dialog');
      dlg.className = 'ni-breakdown-dlg';
      dlg.innerHTML = `
        <div style="padding:20px;min-width:320px;max-width:440px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
            <h3 style="margin:0;font-size:14px;font-weight:700">⚐ Alerts — Order <span style="color:var(--accent)">${_esc(po)}</span></h3>
            <button data-alert-close style="background:none;border:none;cursor:pointer;font-size:16px;color:var(--fg-mute)">✕</button>
          </div>
          <div>${rows}</div>
        </div>`;
      document.body.appendChild(dlg);
      try { dlg.showModal(); } catch { dlg.open = true; }
      dlg.addEventListener('close', () => dlg.remove());
      dlg.addEventListener('click', e => {
        if (e.target === dlg || e.target.closest('[data-alert-close]')) { dlg.close(); return; }
        const btn = e.target.closest('[data-alert-id]');
        if (btn) { dlg.close(); Alerts.focus(btn.dataset.alertId); }
      });
    },

    _showNotePopover(e, id) {
      Table._closeNotePopover();
      const task = Store.tasks[id];
      if (!task) return;
      const _esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

      const pop = document.createElement('div');
      pop.id = 'nb-note-popover';
      const cur = task.notes || '';
      pop.innerHTML = `
        <div class="nb-note-pop-header">
          <span>Order Note</span>
          <button class="nb-note-pop-close" onclick="NIMBUS.Table._closeNotePopover()">✕</button>
        </div>
        <textarea id="nb-note-ta" maxlength="500" placeholder="Add a note…">${_esc(cur)}</textarea>
        <div class="nb-note-pop-footer">
          <span id="nb-note-cnt">${cur.length}/500</span>
          <div class="nb-note-pop-btns">
            <button class="nb-note-cancel" onclick="NIMBUS.Table._closeNotePopover()">Cancel</button>
            <button class="nb-note-save" onclick="NIMBUS.Table._saveNotePopover('${id}')">Save</button>
          </div>
        </div>`;
      document.body.appendChild(pop);

      const btn = e.target.closest('button') || e.target;
      const rect = btn.getBoundingClientRect();
      const popW = 284;
      let left = Math.max(4, Math.min(rect.left, window.innerWidth - popW - 4));
      pop.style.left = left + 'px';
      pop.style.top = '0px'; // temp placement so offsetHeight is measurable
      requestAnimationFrame(() => {
        const h = pop.offsetHeight;
        const spaceAbove = rect.top - 8;
        const spaceBelow = window.innerHeight - rect.bottom - 8;
        let top = spaceAbove >= h || spaceAbove >= spaceBelow
          ? Math.max(4, rect.top - h - 4)
          : rect.bottom + 4;
        pop.style.top = top + 'px';
      });

      const ta = document.getElementById('nb-note-ta');
      ta.addEventListener('input', () => {
        document.getElementById('nb-note-cnt').textContent = ta.value.length + '/500';
      });
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);

      setTimeout(() => {
        Table._noteOutsideHandler = ev => { if (!pop.contains(ev.target)) Table._closeNotePopover(); };
        document.addEventListener('mousedown', Table._noteOutsideHandler);
      }, 0);
      Table._noteKeyHandler = ev => { if (ev.key === 'Escape') Table._closeNotePopover(); };
      document.addEventListener('keydown', Table._noteKeyHandler);
    },

    _saveNotePopover(id) {
      const ta = document.getElementById('nb-note-ta');
      if (!ta) return;
      const val = ta.value.trim().slice(0, 500) || null;
      Store.updateTask(id, { notes: val }, 'table');
      Inspector._persistNote(id, val);
      Table._closeNotePopover();
      Table._api.applyTransaction({ update: [Store.tasks[id]] });
    },

    _closeNotePopover() {
      const pop = document.getElementById('nb-note-popover');
      if (pop) pop.remove();
      if (Table._noteOutsideHandler) {
        document.removeEventListener('mousedown', Table._noteOutsideHandler);
        Table._noteOutsideHandler = null;
      }
      if (Table._noteKeyHandler) {
        document.removeEventListener('keydown', Table._noteKeyHandler);
        Table._noteKeyHandler = null;
      }
    },

    /** A minimal inline datetime-local editor for AG Grid. */
    _DateTimeEditor: class {
      init(params) {
        this._input = document.createElement('input');
        this._input.type = 'datetime-local';
        this._input.style.width = '100%';
        this._input.style.height = '30px';
        this._input.style.border = '1px solid var(--accent)';
        this._input.style.padding = '0 6px';
        this._input.style.fontSize = '12px';
        this._input.value = Util.toLocalInput(params.value);
      }
      getGui() { return this._input; }
      afterGuiAttached() { this._input.focus(); this._input.select(); }
      getValue() { return Util.parseDate(this._input.value); }
      destroy() {}
    }
  };

  /* =============================================================================
     INSPECTOR — right-side detail panel shown on the Timeline tab.
     Edits here write through the Store (source: 'inspector').
     ========================================================================== */
  const Inspector = {
    _currentId: null,
    _unsubStore: null,

    init() {
      Inspector._unsubStore = Store.subscribe(evt => {
      // Allow fixed:change through even from 'inspector' so the Fix/Unfix
      // button re-renders after toggleFix() — otherwise it never flips.
      if (evt.source === 'inspector' && evt.type !== 'fixed:change') return;
        if (evt.type === 'plant:selected') {
          const t = Inspector._currentId ? Store.tasks[Inspector._currentId] : null;
          if (!t || !Store.selectedPlant
              || Store.getPlantForLine(t.PRODUCTION_LINE) !== Store.selectedPlant) {
            Inspector.clear();
          }
          return;
        }
        if (!Inspector._currentId) return;
        if (evt.type === 'task:update' && String(evt.id) === Inspector._currentId) {
          Inspector._render(Store.tasks[Inspector._currentId]);
        } else if (evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate' || evt.type === 'fixed:change') {
          const t = Store.tasks[Inspector._currentId];
          if (t) Inspector._render(t);
          else Inspector.clear();
        }
      });
    },

    show(task) {
      // Refuse to inspect tasks that don't belong to the current plant scope.
      if (Store.selectedPlant
          && Store.getPlantForLine(task.PRODUCTION_LINE) !== Store.selectedPlant) {
        Toast.show(t('toast.order_belongs_other_plant'), 'warn');
        return;
      }
      Inspector._currentId = String(task.id);
      Inspector._render(task);
    },
    clear() {
      Inspector._currentId = null;
      const body = document.getElementById('inspector-body');
      if (body) body.innerHTML = `<div class="empty-state">${t('empty.select_order')}</div>`;
    },

    _render(task) {
      const body = document.getElementById('inspector-body');
      if (!body) return;
      if (!task) { Inspector.clear(); return; }

      const fixed = Store.isFixed(task.id);
      const lineOptions = Table._getLineOptions();
      const relAlerts = Store.alerts.filter(a => String(a.taskId) === String(task.id));

      body.innerHTML = `
        ${fixed ? `<div class="insp-fix-banner">${t('ui.insp_fixed_banner')}</div>` : ''}
        ${relAlerts.length ? `<div class="insp-card" style="border-color:var(--err);background:var(--err-soft);">
          <h4 style="color:var(--err);">⚐ ${t('ui.insp_alerts_title', { count: relAlerts.length })}</h4>
          ${relAlerts.map(a => `<div style="font-size:12px;margin-bottom:4px;">${a.msg}</div>`).join('')}
        </div>` : ''}

        <div class="insp-card">
          <h4>${t('ui.insp_order_section')}</h4>
          <div class="insp-row"><label>${t('ui.insp_id')}</label>
            <div class="insp-val">${task.id}</div></div>
            <div class="insp-row"><label>${t('ui.insp_order')}</label>
            <div class="insp-val">${task.ORDER || task.id}</div></div>
          <div class="insp-row"><label>${t('ui.insp_material_no')}</label>
            <div class="insp-val">${task.MATERIAL_NUMBER || '—'}</div></div>
          <div class="insp-row"><label>${t('ui.insp_material_desc')}</label>
            <div class="insp-val">${task.MATERIAL_DESCRIPTION || '—'}</div></div>
          <div class="insp-row"><label>${t('ui.insp_qty')}</label>
            <div class="insp-val">${task['ORDER_QUANTITY_(GMEIN)'] || 0}</div></div>
          <div class="insp-row"><label>${t('ui.insp_color')}</label>
            <div class="insp-val">${task.COLOR || '—'}</div></div>
          <div class="insp-row"><label>${t('ui.insp_form')}</label>
            <div class="insp-val">${task.FORM_SIZE || '—'}</div></div>
          <div class="insp-row"><label>${t('ui.insp_line')}</label>
            <div class="insp-val"><select data-field="PRODUCTION_LINE">
              ${lineOptions.map(l => `<option value="${l}" ${l === task.PRODUCTION_LINE ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div></div>
        </div>

        <div class="insp-card">
          <h4>${t('ui.insp_notes_section')}</h4>
          <div class="insp-notes-wrap">
            <textarea data-field="notes" maxlength="500" placeholder="${t('ph.add_note')}" rows="3">${(task.notes || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
            <div class="insp-notes-counter"><span id="insp-notes-rem">${500 - (task.notes || '').length}</span> ${t('ui.remaining')}</div>
          </div>
        </div>

        <div class="insp-card">
          <h4>${t('ui.insp_schedule_section')}</h4>
          <div class="insp-row"><label>${t('ui.insp_orig_start')}</label>
            <div class="insp-val">${task.original_start_date ? Util.fmtDT(task.original_start_date) : '—'}</div></div>
          <div class="insp-row"><label>${t('ui.insp_orig_end')}</label>
            <div class="insp-val">${task.original_end_date ? Util.fmtDT(task.original_end_date) : '—'}</div></div>
          <div class="insp-row"><label>${t('ui.insp_updated_start')}</label>
            <div class="insp-val">
              <input type="datetime-local" data-field="start_date" value="${Util.toLocalInput(task.start_date)}">
              ${Inspector._varianceBadge(task)}
            </div></div>
          <div class="insp-row"><label>${t('ui.insp_updated_end')}</label>
            <div class="insp-val">${Util.fmtDT(task.end_date)}</div></div>
          <div class="insp-row"><label>${t('ui.insp_run_time')}</label>
            <div class="insp-val"><input type="number" step="0.25" data-field="RUN_TIME" value="${task.RUN_TIME || 0}"></div></div>
        </div>

        <div class="insp-actions">
          ${fixed
            ? `<button class="btn" onclick="NIMBUS.Inspector.toggleFix(false)">${t('btn.unfix')}</button>`
            : `<button class="btn btn-primary" onclick="NIMBUS.Inspector.toggleFix(true)">${t('btn.fix_order')}</button>`}
          <button class="btn" onclick="NIMBUS.Table._openOverrideModalForId('${task.id}')">${t('btn.override_date')}</button>
          <button class="btn btn-ghost" onclick="NIMBUS.Timeline.focus('${task.id}')">${t('btn.focus')}</button>
        </div>
      `;

      // Wire inputs
      body.querySelectorAll('[data-field]').forEach(el => {
        el.onchange = () => Inspector._onFieldChange(el.dataset.field, el.value);
      });
      // Notes char counter (oninput fires on every keystroke)
      const notesEl = body.querySelector('[data-field="notes"]');
      const notesRemEl = body.querySelector('#insp-notes-rem');
      if (notesEl && notesRemEl) {
        notesEl.oninput = () => { notesRemEl.textContent = 500 - notesEl.value.length; };
        const _noteId = Inspector._currentId;
        notesEl.onblur = () => {
          const trimmed = notesEl.value.trim() || null;
          Store.updateTask(_noteId, { notes: trimmed }, 'inspector');
          Inspector._persistNote(_noteId, trimmed);
        };
      }
      // Upgrade start_date to Flatpickr datetime picker
      const _dtEl = body.querySelector('[data-field="start_date"]');
      if (_dtEl) {
        flatpickr(_dtEl, {
          enableTime: true, dateFormat: 'Y-m-d\\TH:i',
          altInput: true, altFormat: 'M j, Y · h:i K', minuteIncrement: 30,
          onChange() { Inspector._onFieldChange('start_date', _dtEl.value); }
        });
      }
    },

    _varianceBadge(t) {
      if (!t.original_start_date || !t.start_date) return '';
      const orig = t.original_start_date instanceof Date ? t.original_start_date : Util.parseDate(t.original_start_date);
      const curr = t.start_date instanceof Date ? t.start_date : Util.parseDate(t.start_date);
      if (!orig || !curr) return '';
      const deltaMs = curr.getTime() - orig.getTime();
      if (Math.abs(deltaMs) < 60 * 1000) return '';
      const days = deltaMs / (24 * 3600 * 1000);
      const txt = Math.abs(days) >= 1
        ? `${days >= 0 ? '+' : ''}${days.toFixed(1)}d`
        : `${days >= 0 ? '+' : ''}${(deltaMs / 3600000).toFixed(1)}h`;
      const cls = deltaMs > 0 ? 'insp-var-late' : 'insp-var-early';
      return `<span class="insp-var ${cls}" title="${t('ui.insp_variance_shifted')}">${txt}</span>`;
    },

    _onFieldChange(field, value) {
      if (!Inspector._currentId) return;
      const id = Inspector._currentId;
      const t  = Store.tasks[id];
      if (!t) return;
      const changes = {};
      if (field === 'start_date') {
        const d = Util.parseDate(value);
        if (!d) { Toast.show(t('toast.invalid_date'), 'error'); return; }
        changes.start_date = Util.snap(d);
        const dur = Util.runHours(t) * 3600000;
        if (dur > 0) changes.end_date = new Date(changes.start_date.getTime() + dur);
      } else if (field === 'RUN_TIME') {
        const h = parseFloat(value) || 0;
        changes.RUN_TIME = h;
        if (t.start_date) changes.end_date = new Date(t.start_date.getTime() + h * 3600000);
      } else if (field === 'ORDER_QUANTITY_(GMEIN)') {
        changes[field] = parseFloat(value) || 0;
      } else if (field === 'notes') {
        changes.notes = value.trim() || null;
        Store.updateTask(id, changes, 'inspector');
        Inspector._persistNote(id, changes.notes);
        return;
      } else {
        changes[field] = value;
      }
      Store.updateTask(id, changes, 'inspector');
      if (field === 'start_date' || field === 'RUN_TIME' || field === 'PRODUCTION_LINE') {
        Engine.autoReflow(id);
      }
      Alerts.scheduleRecompute();
    },

    _persistNote: Util.debounce(function(id, notes) {
      fetch(`${Config.API_BASE}/task/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, notes })
      })
        .then(async r => {
          if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            ErrorLog.warn('inspector', `Note rejected (${r.status}): ${body.message || body.detail || ''}`);
          }
        })
        .catch(e => ErrorLog.warn('inspector', `Note persist failed: ${e.message}`));
    }, 800),

    toggleFix(fixed) {
      if (!Inspector._currentId) return;
      Store.setFixed([Inspector._currentId], fixed, 'inspector');
      Alerts.scheduleRecompute();
    }
  };

  /* =============================================================================
     HIERARCHY — left sidebar with per-line order lists + utilisation chip.
     ========================================================================== */
  const Hierarchy = {
    init() {
      Store.subscribe(evt => {
        if (evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate'
            || evt.type === 'task:update' || evt.type === 'calendar:change'
            || evt.type === 'blocks:change' || evt.type === 'fixed:change'
            || evt.type === 'plant:selected' || evt.type === 'lineSettings:change') {
          Hierarchy.render();
        }
      });
    },

    render() {
      const el = document.getElementById('hierarchy');
      if (!el) return;
      if (!Store.selectedPlant) {
        EmptyState.render(el, {
          title: t('empty.no_plant_selected'),
          msg:   t('empty.no_plant_hierarchy')
        });
        return;
      }
      const lines = {};
      for (const t of Store.tasksForSelectedPlant()) {
        const k = t.PRODUCTION_LINE || 'Unknown';
        (lines[k] ||= []).push(t);
      }
      // Include plant-assigned lines that currently have no orders.
      for (const l of Store.linesForSelectedPlant()) {
        if (!lines[l]) lines[l] = [];
      }
      const lineNames = Object.keys(lines).sort();
      const visibleLineNames = (GanttFilter?._selectedLines?.size > 0)
        ? lineNames.filter(l => GanttFilter._selectedLines.has(l))
        : lineNames;
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);

      el.innerHTML = visibleLineNames.map(line => {
        const ci = Timeline._colorIndex(line);
        const color = Config.COLORS[ci % Config.COLORS.length];
        const arr = lines[line]
          .filter(t => t.start_date >= todayStart && t.start_date <= todayEnd)
          .sort((a,b) => (a.start_date?.getTime()||0) - (b.start_date?.getTime()||0));
        const endingToday = lines[line].filter(
          t => t.end_date && t.end_date >= todayStart && t.end_date <= todayEnd
        );
        const runH      = endingToday.reduce((s, t) => s + Util.runHours(t), 0);
        const cap       = Calendar.dailyCapacityHours(line, todayStart);
        const utilRatio = cap > 0 ? runH / cap : (runH > 0 ? 1 : 0);
        const pct       = runH > 0 ? Math.round(utilRatio * 100) : null;
        const sev       = Utilization.sev(utilRatio);
        const chip = pct != null ? `<span class="line-util ${sev}">${pct}%</span>` : `<span class="line-util">—</span>`;
        return `<details class="line-group">
          <summary>
            <span class="line-expand">+</span>
            <span class="line-dot" style="background:${color}"></span>
            <span>${line}</span>
            <span style="color:var(--fg-faint);font-weight:500;">(${arr.length})</span>
            ${chip}
          </summary>
          ${arr.map((t, i) => {
            const fixed = Store.isFixed(t.id);
            const label = `[${i + 1}] ${t.ORDER || t.id}`;
            return `<div class="hier-item ${fixed ? 'fixed' : ''}" data-id="${t.id}">
              ${fixed ? '<span class="lock-ico">🔒</span>' : ''}
              <span>${label}</span>
            </div>`;
          }).join('')}
        </details>`;
      }).join('');

      el.querySelectorAll('details.line-group').forEach(det => {
        det.addEventListener('toggle', () => {
          det.querySelector('.line-expand').textContent = det.open ? '−' : '+';
        });
      });

      el.querySelectorAll('.hier-item').forEach(row => {
        row.onclick = () => {
          const id = row.dataset.id;
          Timeline.focus(id);
        };
      });
    }
  };

  /* =============================================================================
     DASHBOARD — KPIs, today-by-line chart, alert summary.
     ========================================================================== */
  const Dashboard = {
    _prevKpi:    {},

    _filterLines:  new Set(),
    _plantLines:   {},   // plant → Set<line>, built from task data

    _latenessHorizon: 14,                  // days; toggled by 7/14/28 segment buttons
    _latenessDrillKey: null,               // 'LINE|YYYY-MM-DD' for the currently-drilled cell

    _renderDebounced: null,
    init() {
      Store.subscribe(evt => {
        if (evt.type === 'plant:selected') {
          Dashboard._refreshLineDropdown();
          Dashboard._refreshFilterBtns();
          Dashboard.render();
          return;
        }
        if (evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate'
            || evt.type === 'task:update' || evt.type === 'alerts:change'
            || evt.type === 'calendar:change' || evt.type === 'blocks:change'
            || evt.type === 'fixed:change') {
          if (evt.type === 'tasks:bulk') {
            Dashboard._prevKpi = {};
            Dashboard._latenessDrillKey = null;
            // Rebuild filter options after data reloads, then re-render
            setTimeout(() => { Dashboard._buildFilterOptions(); Dashboard.render(); }, 350);
            return;
          }
          clearTimeout(Dashboard._renderDebounced);
          Dashboard._renderDebounced = setTimeout(() => Dashboard.render(), 300);
        }
      });
      // Close line-filter dropdown on outside click
      document.addEventListener('click', e => {
        if (!e.target.closest('#line-filter-group')) {
          const d = document.getElementById('line-filter-dropdown');
          if (d) d.hidden = true;
        }
      });
      // Wire lateness-horizon segment buttons.
      const horizonGroup = document.getElementById('lateness-horizon-group');
      if (horizonGroup) {
        horizonGroup.addEventListener('click', e => {
          const btn = e.target.closest('button[data-h]');
          if (!btn) return;
          const h = parseInt(btn.dataset.h, 10);
          if (!Number.isFinite(h) || h === Dashboard._latenessHorizon) return;
          Dashboard._latenessHorizon = h;
          horizonGroup.querySelectorAll('button').forEach(b =>
            b.classList.toggle('active', parseInt(b.dataset.h, 10) === h)
          );
          Dashboard._latenessDrillKey = null;
          Dashboard._renderLatenessHeatmap();
        });
      }
      setTimeout(() => Dashboard._buildFilterOptions(), 0);
    },

    _filteredTasks() {
      let tasks = Store.tasksForSelectedPlant();
      if (Dashboard._filterLines.size > 0) {
        tasks = tasks.filter(t => Dashboard._filterLines.has(t.PRODUCTION_LINE));
      }
      return tasks;
    },

    _buildFilterOptions() {
      const plantLines = {};
      for (const t of Store.tasksArr) {
        const p = Store.getPlantForLine(t.PRODUCTION_LINE);
        const l = t.PRODUCTION_LINE;
        if (!l) continue;
        if (!plantLines[p]) plantLines[p] = new Set();
        plantLines[p].add(l);
      }
      Dashboard._plantLines = plantLines;
      Dashboard._refreshLineDropdown();
      Dashboard._refreshFilterBtns();
    },

    _refreshLineDropdown() {
      const btn  = document.getElementById('line-filter-btn');
      const drop = document.getElementById('line-filter-dropdown');
      if (!btn || !drop) return;

      if (!Store.selectedPlant) {
        btn.disabled = true;
        drop.innerHTML = '';
        return;
      }
      btn.disabled = false;

      const lines = new Set(Dashboard._plantLines[Store.selectedPlant] || []);
      // Drop stale line selections
      for (const l of [...Dashboard._filterLines]) {
        if (!lines.has(l)) Dashboard._filterLines.delete(l);
      }

      const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      const sorted = [...lines].sort();
      drop.innerHTML = sorted.length
        ? sorted.map(l => `<label><input type="checkbox" value="${esc(l)}"${Dashboard._filterLines.has(l) ? ' checked' : ''} onchange="NIMBUS.Dashboard._onLineChange(this)"> ${esc(l)}</label>`).join('')
        : `<div style="padding:8px 14px;font-size:12px;color:#9a9285">No lines</div>`;
    },

    _refreshFilterBtns() {
      const lineBtn   = document.getElementById('line-filter-btn');
      const lineLbl   = document.getElementById('line-filter-label');
      const clearBtn  = document.getElementById('dash-filter-clear');
      const hint      = document.getElementById('dash-filter-hint');

      if (lineBtn)  lineBtn.classList.toggle('active',  Dashboard._filterLines.size > 0);

      if (lineLbl) {
        const ls = Dashboard._filterLines.size;
        lineLbl.textContent = ls === 0 ? t('ui.all_lines') : ls === 1 ? [...Dashboard._filterLines][0] : t('ui.n_lines_filter', { count: ls });
      }

      const hasFilter = Dashboard._filterLines.size > 0;
      if (clearBtn) clearBtn.hidden = !hasFilter;
      if (hint) {
        if (Store.selectedPlant) {
          const n = Dashboard._filteredTasks().length;
          hint.textContent = t('ui.orders_visible', { count: n, plural: n !== 1 ? t('ui.orders_visible_plural') : '' });
        } else {
          hint.textContent = '';
        }
      }
    },

    _toggleDropdown(id) {
      const drop = document.getElementById(id);
      if (!drop) return;
      drop.hidden = !drop.hidden;
    },

    _onLineChange(cb) {
      if (cb.checked) Dashboard._filterLines.add(cb.value);
      else Dashboard._filterLines.delete(cb.value);
      Dashboard._refreshFilterBtns();
      Dashboard.render();
    },

    _clearFilters() {
      Dashboard._filterLines.clear();
      Dashboard._refreshLineDropdown();
      Dashboard._refreshFilterBtns();
      Dashboard.render();
    },
    _syncLineStatusHeight() {
      requestAnimationFrame(() => {
        const heatmapPanel = document.getElementById('util-heatmap-panel')?.closest('.panel');
        const lineStatusCard = document.getElementById('line-status-card');
        if (!heatmapPanel || !lineStatusCard) return;
        const head = heatmapPanel.querySelector('.panel-head');
        const body = heatmapPanel.querySelector('.panel-body');
        if (!head || !body) return;
        lineStatusCard.style.maxHeight = (head.offsetHeight + body.offsetHeight) + 'px';
      });
    },

    render() {
      // Only render heavy bits if the home tab is currently active — but still
      // update the alert bell badge on every change.
      Alerts._renderBell();

      if (!document.getElementById('home-tab').classList.contains('active')) return;

      Dashboard._renderEmptyState();
      if (!Store.selectedPlant) return;

      Dashboard._renderKPIs();
      Dashboard._renderHeatmap();
      Dashboard._renderLineStatus();
      Dashboard._renderAlertSummary();
      Dashboard._renderFixedList();
      Dashboard._renderLatenessHeatmap();
      Dashboard._syncLineStatusHeight();
    },

    _renderEmptyState() {
      const homeContainer = document.querySelector('#home-tab .home-container');
      let overlay = document.getElementById('dashboard-empty-overlay');
      const heroAside = document.querySelector('#home-tab .hero-aside');
      const dataPanels = document.querySelectorAll('#home-tab .home-container > .grid-2, #home-tab .home-container > .panel');
      if (!Store.selectedPlant) {
        if (!overlay && homeContainer) {
          overlay = document.createElement('div');
          overlay.id = 'dashboard-empty-overlay';
          overlay.className = 'dashboard-empty-overlay';
          // Insert after the hero row so the welcome banner still leads.
          const hero = homeContainer.querySelector('.hero-row');
          if (hero && hero.nextSibling) homeContainer.insertBefore(overlay, hero.nextSibling);
          else homeContainer.appendChild(overlay);
        }
        if (overlay) {
          EmptyState.render(overlay, {
            title: t('empty.pick_plant_dashboard'),
            msg:   t('ui.select_plant_dashboard_msg')
          });
        }
        if (heroAside) heroAside.style.visibility = 'hidden';
        dataPanels.forEach(el => el.style.display = 'none');
      } else {
        if (overlay) overlay.remove();
        if (heroAside) heroAside.style.visibility = '';
        dataPanels.forEach(el => el.style.display = '');
      }
    },

    _renderKPIs() {
      const tasks = Dashboard._filteredTasks();
      const today = Util.startOfDay(new Date());
      const nowDt = new Date();

      const todayOrders = tasks.filter(t => t.start_date && Util.dayKey(t.start_date) === Util.dayKey(today));
      const ordersLabel = 'Orders today';

      // Overdue backlog: every order whose end_date is in the past and isn't marked complete.
      // No status enum exists today, so end_date<now is the strongest proxy for "overdue".
      const lateCount = tasks.filter(t => t.end_date && t.end_date < nowDt).length;
      const lateSev = lateCount > 0 ? 'err' : 'ok';

      const plantLines = new Set(Store.linesForSelectedPlant());
      const plantRow = Store._state.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null;
      const alertHz = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? null;
      const alertCutoff = typeof alertHz === 'number' ? new Date(Date.now() + alertHz * 60000) : null;
      const visibleAlerts = Store.alerts.filter(a => {
        if (a.line && !plantLines.has(a.line)) return false;
        if (alertCutoff && a.time && a.time > alertCutoff) return false;
        return true;
      });
      const openAlerts = visibleAlerts.length;
      const errAlerts  = visibleAlerts.filter(a => a.sev === 'err').length;
      const warnAlerts = visibleAlerts.filter(a => a.sev === 'warn').length;
      const alertSev = errAlerts > 0 ? 'err' : openAlerts > 0 ? 'warn' : 'ok';
      const alertCls = alertSev === 'err' ? 'err' : alertSev === 'warn' ? 'warn' : '';
      const conflictCls = errAlerts > 0 ? 'err' : '';

      // Capacity Headroom Next 7D: 1 - average utilization across all line-day cells with capacity.
      const matrix7 = Utilization.computeMatrix(new Date(), 7, tasks);
      let pctSum = 0, pctN = 0;
      for (const ln of Object.keys(matrix7)) {
        for (const d of Object.keys(matrix7[ln])) {
          const cell = matrix7[ln][d];
          if (cell && cell.capacity > 0) { pctSum += cell.pct; pctN++; }
        }
      }
      const avgUtil = pctN > 0 ? pctSum / pctN : 0;
      const headroom = Math.max(0, Math.round((1 - avgUtil) * 100));
      const headroomSev = avgUtil >= 0.95 ? 'err' : avgUtil >= 0.80 ? 'warn' : 'ok';

      const fixedCount = tasks.filter(t => Store.isFixed(t.id)).length;

      const tiles = [
        { k: ordersLabel,             v: String(todayOrders.length),
          d: `${tasks.length} total`,
          action: 'orders-today' },
        { k: 'Overdue backlog',       v: String(lateCount),
          d: lateCount === 0 ? 'no backlog' : 'all open orders past finish',
          cls: lateSev === 'err' ? 'err' : '',
          action: 'late' },
        { k: 'Conflicts pending',     v: String(errAlerts),
          d: errAlerts === 0 ? 'none blocking' : 'blocking — fix now',
          cls: conflictCls,
          action: 'conflicts' },
        { k: 'Open alerts',           v: String(openAlerts),
          d: `${warnAlerts} warn · ${errAlerts} err`,
          cls: alertCls,
          action: 'alerts' },
        { k: 'Capacity Headroom Next 7D',  v: `${headroom}%`,
          d: pctN > 0 ? `${Math.round(avgUtil * 100)}% avg used` : 'no data',
          cls: headroomSev === 'err' ? 'err' : headroomSev === 'warn' ? 'warn' : '',
          action: 'headroom' },
        { k: 'Fixed orders',          v: String(fixedCount),
          d: 'locked from optimiser',
          action: 'fixed' },
      ];

      const stack = document.getElementById('kpi-stack');
      if (!stack) return;

      // Build tiles, animating numeric values that changed since last render.
      tiles.forEach((tile, idx) => {
        let el = stack.children[idx];
        if (!el) {
          el = document.createElement('div');
          stack.appendChild(el);
        }
        el.className = 'kpi-tile ' + (tile.cls || '') + (tile.action ? ' is-actionable' : '');
        el.onclick = tile.action ? () => Dashboard._tileClick(tile.action) : null;
        if (tile.action) {
          el.setAttribute('role', 'button');
          el.setAttribute('tabindex', '0');
          el.setAttribute('title', Dashboard._tileTooltip(tile.action));
        } else {
          el.removeAttribute('role'); el.removeAttribute('tabindex'); el.removeAttribute('title');
        }
        const kEl = el.querySelector('.k') || document.createElement('div');
        const vEl = el.querySelector('.v') || document.createElement('div');
        const dEl = el.querySelector('.d') || document.createElement('div');
        kEl.className = 'k'; dEl.className = 'd';
        vEl.className = 'v';
        kEl.textContent = tile.k;
        dEl.textContent = tile.d;
        if (!el.querySelector('.k')) { el.appendChild(kEl); el.appendChild(vEl); el.appendChild(dEl); }

        const prevVal = Dashboard._prevKpi[tile.k];
        const rawNum = parseFloat(tile.v);
        const isNum = !isNaN(rawNum) && tile.v === String(rawNum) + (tile.v.includes('h') ? 'h' : tile.v.includes('%') ? '%' : '');
        const prevNum = parseFloat(prevVal);
        if (isNum && prevVal !== undefined && !isNaN(prevNum) && prevNum !== rawNum) {
          Dashboard._animateTicker(vEl, prevNum, rawNum, tile.v, 400);
        } else {
          vEl.textContent = tile.v;
        }
        Dashboard._prevKpi[tile.k] = tile.v;
      });
      // Remove extra tiles if lines reduced
      while (stack.children.length > tiles.length) stack.removeChild(stack.lastChild);
    },

    _tileTooltip(action) {
      switch (action) {
        case 'orders-today': return 'Open Orders table filtered to today';
        case 'late':         return 'Open Orders table filtered to overdue orders';
        case 'conflicts':    return 'Jump to Active alerts, error severity highlighted';
        case 'alerts':       return 'Jump to Active alerts list';
        case 'headroom':     return 'Jump to utilization heatmap';
        case 'fixed':        return 'Jump to fixed orders list';
        default: return '';
      }
    },

    _tileClick(action) {
      switch (action) {
        case 'orders-today': {
          App.goto('table');
          const todayDt = Util.startOfDay(new Date());
          const ymd = Util.dayKey(todayDt);
          setTimeout(() => {
            if (NIMBUS.Table && NIMBUS.Table._applyChipFilter) {
              NIMBUS.Table._applyChipFilter({ dateKey: ymd });
            }
          }, 120);
          break;
        }
        case 'late': {
          App.goto('table');
          setTimeout(() => {
            if (NIMBUS.Table && NIMBUS.Table._applyChipFilter) {
              NIMBUS.Table._applyChipFilter({ status: 'late' });
            }
          }, 120);
          break;
        }
        case 'conflicts':
          Dashboard._scrollToAlerts('err');
          break;
        case 'alerts':
          Dashboard._scrollToAlerts();
          break;
        case 'headroom': {
          const hm = document.getElementById('util-heatmap-panel');
          if (hm) hm.closest('.panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          break;
        }
        case 'fixed': {
          const fl = document.getElementById('fixed-list');
          if (fl) fl.closest('.panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          break;
        }
      }
    },

    _scrollToAlerts(highlight) {
      const panel = document.getElementById('alert-summary-list')?.closest('.panel');
      if (!panel) return;
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (highlight === 'err') {
        const list = panel.querySelector('#alert-summary-list');
        if (!list) return;
        list.querySelectorAll('.alert-row').forEach(r => {
          if (!r.classList.contains('sev-err')) r.classList.add('flash-dim');
        });
        setTimeout(() => list.querySelectorAll('.flash-dim').forEach(r => r.classList.remove('flash-dim')), 2400);
      }
    },

    _animateTicker(el, from, to, toStr, dur) {
      const suffix = toStr.replace(/[\d.]/g, '');
      const start = performance.now();
      const step = ts => {
        const p = Math.min((ts - start) / dur, 1);
        const eased = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
        const cur = from + (to - from) * eased;
        el.textContent = (Number.isInteger(to) ? Math.round(cur) : cur.toFixed(1)) + suffix;
        if (p < 1) requestAnimationFrame(step);
        else el.textContent = toStr;
      };
      requestAnimationFrame(step);
    },

    _renderHeatmap() {
      const container = document.getElementById('util-heatmap-panel');
      if (!container) return;

      const matrix = Utilization.computeMatrix(new Date(), 7, Dashboard._filteredTasks());
      const lines = Object.keys(matrix).sort();

      if (!lines.length) {
        container.innerHTML = `<div class="empty-state">${t('empty.no_util_data')}</div>`;
        return;
      }

      const days = Object.keys(matrix[lines[0]]);

      const isDark = document.body.classList.contains('dark');
      function lerpRGB(a, b, t) {
        const p = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
        const ca = p(a), cb = p(b);
        return `rgb(${Math.round(ca[0]+(cb[0]-ca[0])*t)},${Math.round(ca[1]+(cb[1]-ca[1])*t)},${Math.round(ca[2]+(cb[2]-ca[2])*t)})`;
      }
      const idleBg = isDark ? '#252730' : '#ede8de';
      const lowMid = isDark ? '#7a5a18' : '#c8a95a';
      const midHi  = isDark ? '#a8520f' : '#c96a1a';
      const hot    = isDark ? '#b32a1f' : '#991b1b';
      function heatBg(pct) {
        if (pct <= 0)    return idleBg;
        if (pct <= 0.5)  return lerpRGB(idleBg, lowMid, pct / 0.5);
        if (pct <= 1.0)  return lerpRGB(lowMid, midHi, (pct - 0.5) / 0.5);
        return lerpRGB(midHi, hot, Math.min((pct - 1.0) / 0.25, 1));
      }
      function heatText(pct) {
        if (isDark) return pct <= 0 ? '#8f909d' : '#ffffff';
        return pct < 0.45 ? '#3d3628' : '#ffffff';
      }

      const cols = `74px repeat(${days.length}, 1fr)`;
      let html = `<div class="hm-scroll-wrap"><div class="hm-grid" style="grid-template-columns:${cols}">`;

      // Header row
      html += `<div class="hm-corner hm-sticky"></div>`;
      days.forEach(d => {
        const dt = new Date(d + 'T12:00:00');
        const dow  = dt.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
        const date = dt.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
        html += `<div class="hm-day-head hm-sticky"><span class="hm-dow">${dow}</span><span class="hm-date">${date}</span></div>`;
      });

      // Data rows
      lines.forEach((line, li) => {
        const dot = Config.COLORS[li % Config.COLORS.length];
        html += `<div class="hm-line-label"><span class="hm-dot" style="background:${dot}"></span>${line}</div>`;
        days.forEach(d => {
          const pct = matrix[line][d]?.pct || 0;
          const bg  = heatBg(pct);
          const tc  = heatText(pct);
          const lbl = Math.round(pct * 100) + '%';
          const cap     = (matrix[line][d]?.capacity || 0).toFixed(1);
          const effCap  = (matrix[line][d]?.effectiveCapacity ?? (matrix[line][d]?.capacity || 0)).toFixed(1);
          const sched   = (matrix[line][d]?.scheduled || 0).toFixed(1);
          const effNote = effCap !== cap ? ` · limit ${effCap}h` : '';
          html += `<div class="hm-cell" data-line="${line}" data-date="${d}" style="background:${bg};color:${tc};cursor:pointer" title="Click to view ${line} on ${d} · ${lbl} (${sched}h / ${cap}h${effNote})" onclick="NIMBUS.Dashboard._gotoLine('${line}','${d}')">${lbl}</div>`;
        });
      });

      html += `</div></div>
        <div class="hm-legend">
          <span>idle</span>
          <div class="hm-grad"></div>
          <span>overload</span>
        </div>`;

      container.innerHTML = html;
    },


    _nextChangeover(lineTasks, now) {
      const activeIdx = lineTasks.findIndex(t => t.start_date && t.end_date && t.start_date <= now && t.end_date > now);
      const startIdx  = activeIdx >= 0 ? activeIdx : lineTasks.findIndex(t => t.start_date && t.start_date > now);
      if (startIdx < 0) return null;
      const ref = lineTasks[startIdx];
      for (let i = startIdx + 1; i < lineTasks.length; i++) {
        const t = lineTasks[i];
        if ((t.COLOR || '') !== (ref.COLOR || '') || (t.FORM_SIZE || '') !== (ref.FORM_SIZE || '')) {
          return t.start_date;
        }
      }
      return null;
    },

    _fmtNextCO(dt, now) {
      if (!dt) return '—';
      const ms = dt - now;
      if (ms <= 0) return 'now';
      const mins = Math.round(ms / 60000);
      if (mins < 60) return `+${mins}m`;
      const hrs = Math.round(mins / 60);
      if (hrs < 24) return `+${hrs}h`;
      return `+${Math.round(hrs / 24)}d`;
    },

    _renderLineStatus() {
      const el = document.getElementById('line-status-panel');
      if (!el) return;
      const tasks = Dashboard._filteredTasks();
      const now   = new Date();
      const esc   = s => String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

      const byLine = {};
      for (const t of tasks) { const l = t.PRODUCTION_LINE || 'Unknown'; (byLine[l] ||= []).push(t); }
      const lines = Object.keys(byLine).sort();

      if (!lines.length) {
        el.innerHTML = `<div class="empty-state" style="padding:24px;text-align:center;">${t('empty.no_data_loaded')}</div>`;
        return;
      }

      const matrix   = Utilization.computeMatrix(now, 1, tasks);
      const todayKey = Util.dayKey(Util.startOfDay(now));

      const header = `<div class="ls-row ls-header">
        <div class="ls-dot" style="visibility:hidden"></div>
        <div class="ls-code">Line</div>
        <div class="ls-hours">Hours</div>
        <div class="ls-bar-wrap" style="background:none">Utilization</div>
        <div class="ls-pct">%</div>
        <div class="ls-co">Next CO</div>
      </div>`;

      el.innerHTML = header + lines.map(line => {
        const ci    = Timeline._colorIndex(line);
        const color = Config.COLORS[ci % Config.COLORS.length];
        const u     = matrix[line]?.[todayKey];
        const sched   = u ? +u.scheduled.toFixed(1)          : 0;
        const cap     = u ? +u.capacity.toFixed(1)           : 0;
        const effCap  = u ? +(u.effectiveCapacity ?? u.capacity).toFixed(1) : cap;
        const pct     = cap > 0 ? Math.round((sched / cap) * 100) : 0;
        const overloadAt = u && u.capacity > 0 ? u.effectiveCapacity / u.capacity : Config.OVERLOAD_THRESHOLD;
        const sev     = u ? Utilization.sev(u.pct, overloadAt) : 'ok';
        const barW    = Math.min(pct, 100);
        const isOver  = u ? u.scheduled > (u.effectiveCapacity ?? u.capacity) : false;

        const sorted = byLine[line].slice().sort((a, b) => (a.start_date?.getTime() || 0) - (b.start_date?.getTime() || 0));
        const nxtCO  = Dashboard._fmtNextCO(Dashboard._nextChangeover(sorted, now), now);

        return `<div class="ls-row">
          <div class="ls-dot" style="background:${color}"></div>
          <div class="ls-code">${esc(line)}</div>
          <div class="ls-hours" title="${cap}h total capacity">${sched}/${effCap}h</div>
          <div class="ls-bar-wrap"><div class="ls-bar${isOver ? ' over' : ''}" style="width:${barW}%;background:${color}"></div></div>
          <div class="ls-pct${sev !== 'ok' ? ' ' + sev : ''}">${pct}%</div>
          <div class="ls-co">${esc(nxtCO)}</div>
        </div>`;
      }).join('');
    },

    _renderAlertSummary() {
      const list = document.getElementById('alert-summary-list');
      const count = document.getElementById('alert-summary-count');
      if (!list || !count) return;

      const plantLines = new Set(Store.linesForSelectedPlant());
      const plantRow = Store._state.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null;
      const hz = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? null;
      const cutoff = typeof hz === 'number' ? new Date(Date.now() + hz * 60000) : null;
      const alerts = Store.alerts.filter(a => {
        if (a.line && !plantLines.has(a.line)) return false;
        if (Dashboard._filterLines.size > 0 && a.line && !Dashboard._filterLines.has(a.line)) return false;
        if (cutoff && a.time && a.time > cutoff) return false;
        return true;
      });

      // Sort errors first, then warnings, then info — newest within each severity.
      const SEV_RANK = { err: 0, warn: 1, info: 2 };
      alerts.sort((a, b) => {
        const sa = SEV_RANK[a.sev] ?? 9, sb = SEV_RANK[b.sev] ?? 9;
        if (sa !== sb) return sa - sb;
        const ta = a.time ? a.time.getTime() : 0;
        const tb = b.time ? b.time.getTime() : 0;
        return tb - ta;
      });

      const errN  = alerts.filter(a => a.sev === 'err').length;
      const warnN = alerts.filter(a => a.sev === 'warn').length;
      count.textContent = errN > 0 || warnN > 0
        ? `${errN} err · ${warnN} warn · ${alerts.length} open`
        : `${alerts.length} open`;

      if (!alerts.length) { list.innerHTML = `<div class="empty-state">${t('empty.no_alerts')}</div>`; return; }
      const _esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      list.innerHTML = alerts.slice(0, 8).map(a => `
        <div class="alert-row sev-${a.sev}" onclick="if(NIMBUS.Alerts.focus){NIMBUS.Alerts.focus('${a.id}');}else if(a&&a.taskId){NIMBUS.App.goto('gantt');setTimeout(()=>NIMBUS.Timeline.focus('${a.taskId||''}'),200);}">          <span class="sev" data-sev="${a.sev}" aria-label="${a.sev === 'err' ? 'Error' : a.sev === 'warn' ? 'Warning' : 'Info'}"></span>
          <div class="msg">${_esc(a.msg)}</div>
          <span class="meta">${a.time ? Util.fmtDT(a.time).slice(5, 16) : ''}</span>
          <button class="dismiss" onclick="event.stopPropagation(); NIMBUS.Alerts.dismiss('${a.id}')">×</button>
        </div>
      `).join('');
      if (alerts.length > 8) {
        list.insertAdjacentHTML('beforeend',
          `<div class="alert-summary-more" onclick="NIMBUS.Alerts.toggleDrawer()">See all ${alerts.length} alerts →</div>`);
      }
    },

    _renderFixedList() {
      const list = document.getElementById('fixed-list');
      if (!list) return;
      const fixed = Dashboard._filteredTasks().filter(t => Store.isFixed(t.id));
      if (!fixed.length) { list.innerHTML = `<div class="empty-state">${t('empty.no_fixed_orders')}</div>`; return; }
      list.innerHTML = fixed.slice(0, 12).map(t => `
        <div class="fixed-row">
          <span class="pin">🔒</span>
          <span class="id">${t.PRODUCTION_LINE || ''}</span>
          <span class="name">${t.text || t.ORDER || t.id}</span>
          <span class="when">${Util.fmtDT(t.start_date).slice(5, 16)}</span>
          <button class="btn btn-ghost sm" onclick="NIMBUS.Dashboard._unfix('${t.id}')">Unfix</button>
        </div>
      `).join('');
    },
    _unfix(id) {
      Store.setFixed([id], false, 'dashboard');
      Alerts.scheduleRecompute();
    },
    _gotoLine(line, dateStr) {
      App.goto('gantt');
      setTimeout(() => {
        if (Timeline._tl) {
          const dayStart    = new Date(dateStr + 'T00:00:00');
          const dayLevelEnd = new Date(dayStart.getTime() + 3 * 24 * 3600000);
          Timeline._tl.setWindow(dayStart, dayLevelEnd, { animation: { duration: 300 } });
          document.querySelectorAll('.gantt-toolbar .seg-btn[data-view]').forEach(b => {
            b.classList.toggle('active', b.dataset.view === 'day');
          });
        }
        setTimeout(() => {
          const allLines = [...new Set(Store.tasksArr.map(t => t.PRODUCTION_LINE || 'Unknown'))].sort();
          const lineIdx  = allLines.indexOf(line);
          if (lineIdx < 0) return;
          const groups = document.querySelectorAll('.vis-foreground .vis-group');
          if (!groups.length) return;
          let targetY = 0;
          for (let i = 0; i < lineIdx && i < groups.length; i++) {
            targetY += groups[i].getBoundingClientRect().height;
          }
          const scrollEl = document.querySelector('.vis-vertical-scroll') ||
                           document.querySelector('.vis-panel.vis-center .vis-content');
          if (scrollEl) scrollEl.scrollTop = targetY;
        }, 100);
      }, 250);
    },

    /* ---------------------------------------------------------------------
       A1 — Projected-Lateness Risk Heatmap.
       Grid: rows = lines, cols = days. Cell = cumulative hours late vs SAP plan
       for orders finishing in that line × day cell. Cells are clickable and
       reveal a drill-down list of the contributing late orders.
       --------------------------------------------------------------------- */
    _renderLatenessHeatmap() {
      const container = document.getElementById('lateness-heatmap-panel');
      if (!container) return;

      const horizonDays = Dashboard._latenessHorizon || 14;
      const tasks = Dashboard._filteredTasks();
      const startKey = Util.dayKey(Util.startOfDay(new Date()));
      const endDate  = new Date(); endDate.setDate(endDate.getDate() + horizonDays - 1);
      const endKey   = Util.dayKey(Util.startOfDay(endDate));

      // Build line × day map: line → dayKey → { lateHours, lateCount, lineLabel }
      const allLines = [...new Set(tasks.map(t => t.PRODUCTION_LINE || 'Unknown'))].sort();
      const days  = [];
      {
        const d = Util.startOfDay(new Date());
        for (let i = 0; i < horizonDays; i++) {
          days.push(Util.dayKey(d));
          d.setDate(d.getDate() + 1);
        }
      }
      const cells = {};
      for (const ln of allLines) {
        cells[ln] = {};
        for (const dk of days) cells[ln][dk] = { lateHours: 0, lateCount: 0, tasks: [] };
      }
      for (const t of tasks) {
        const end = Util.scheduledEnd(t);
        if (!end) continue;
        const dk = Util.dayKey(end);
        if (dk < startKey || dk > endKey) continue;
        const ln = t.PRODUCTION_LINE || 'Unknown';
        if (!cells[ln] || !cells[ln][dk]) continue;
        const lh = Util.latenessHours(t);
        if (lh > 0) {
          cells[ln][dk].lateHours += lh;
          cells[ln][dk].lateCount += 1;
          cells[ln][dk].tasks.push(t);
        }
      }

      if (!allLines.length) {
        container.innerHTML = `<div class="empty-state">${t('empty.no_orders_scope')}</div>`;
        return;
      }

      // Sort lines by cumulative late hours in horizon (desc), tiebreak alphabetical.
      // All lines are rendered; the scroll-wrap viewport shows ~9 at a time.
      const lineTotals = allLines.map(ln => {
        let total = 0;
        for (const dk of days) total += cells[ln][dk].lateHours;
        return { ln, total };
      });
      lineTotals.sort((a, b) => b.total - a.total || a.ln.localeCompare(b.ln));
      const lines = lineTotals.map(x => x.ln);

      const isDark = document.body.classList.contains('dark');
      const idleBg = isDark ? '#21232c' : '#ede8de';
      const amber  = isDark ? '#c2861d' : '#f59e0b';
      const orange = isDark ? '#d8651b' : '#d97706';
      const red    = isDark ? '#dc2626' : '#dc2626';
      function cellBg(h) {
        if (h <= 0)  return idleBg;
        if (h <= 8)  return amber;
        if (h <= 24) return orange;
        return red;
      }
      function cellText(h) {
        if (h <= 0) return isDark ? '#9fa0ad' : '#7a6e55';
        return '#ffffff';
      }

      const cols = `120px repeat(${days.length}, 1fr)`;
      let html = `<div class="lh-scroll-wrap"><div class="lh-grid" style="grid-template-columns:${cols}">`;

      // Header row
      html += `<div class="lh-corner lh-sticky"></div>`;
      for (const dk of days) {
        const dt = new Date(dk + 'T12:00:00');
        const dow  = dt.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
        const date = dt.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
        html += `<div class="lh-day-head lh-sticky"><span class="lh-dow">${dow}</span><span class="lh-date">${date}</span></div>`;
      }

      // Data rows
      const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      lines.forEach((line, li) => {
        const dot = Config.COLORS[li % Config.COLORS.length];
        html += `<div class="lh-line-label" title="${esc(line)}"><span class="lh-dot" style="background:${dot}"></span><span class="lh-line-name">${esc(line)}</span></div>`;
        for (const dk of days) {
          const cell = cells[line][dk];
          const h = cell.lateHours;
          const bg = cellBg(h);
          const tc = cellText(h);
          const lbl = h <= 0 ? '·' : (h < 10 ? h.toFixed(1) + 'h' : Math.round(h) + 'h');
          const title = h <= 0
            ? `${line} · ${dk} · on plan`
            : `${line} · ${dk} · ${cell.lateCount} late order${cell.lateCount === 1 ? '' : 's'} · ${h.toFixed(1)}h cumulative late`;
          const click = h > 0
            ? `onclick="NIMBUS.Dashboard._latenessDrill('${esc(line)}','${dk}')"`
            : '';
          const cursor = h > 0 ? 'cursor:pointer;' : '';
          html += `<div class="lh-cell" style="background:${bg};color:${tc};${cursor}" title="${esc(title)}" ${click}>${lbl}</div>`;
        }
      });

      const lineCountNote = allLines.length > 1
        ? `<span class="lh-legend-more">${lines.length} line${lines.length !== 1 ? 's' : ''} · sorted by risk</span>`
        : '';
      html += `</div></div>
        <div class="lh-legend">
          <span class="lh-leg-sw" style="background:${idleBg}"></span><span>on plan</span>
          <span class="lh-leg-sw" style="background:${amber}"></span><span>≤ 8h late</span>
          <span class="lh-leg-sw" style="background:${orange}"></span><span>8–24h</span>
          <span class="lh-leg-sw" style="background:${red}"></span><span>&gt; 24h</span>
          ${lineCountNote}
        </div>`;

      container.innerHTML = html;

      // Re-render drill panel if a cell is still selected
      Dashboard._renderLatenessDrill(cells);
    },

    _latenessDrill(line, dateStr) {
      Dashboard._latenessDrillKey = `${line}|${dateStr}`;
      Dashboard._renderLatenessHeatmap();   // re-render so drill stays in sync
    },

    _renderLatenessDrill(cells) {
      const drill = document.getElementById('lateness-drill');
      if (!drill) return;
      const key = Dashboard._latenessDrillKey;
      if (!key) { drill.hidden = true; drill.innerHTML = ''; return; }
      const [line, dateStr] = key.split('|');
      const cell = cells?.[line]?.[dateStr];
      if (!cell || !cell.tasks.length) {
        drill.hidden = true; drill.innerHTML = '';
        return;
      }
      const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      const rows = cell.tasks
        .slice()
        .sort((a, b) => Util.latenessHours(b) - Util.latenessHours(a))
        .slice(0, 12)
        .map(t => {
          const lh = Util.latenessHours(t);
          const days = lh / 24;
          const lateLbl = days >= 1 ? `+${days.toFixed(1)}d` : `+${lh.toFixed(1)}h`;
          const due = Util.sapDueDate(t);
          const sched = Util.scheduledEnd(t);
          return `<div class="lh-drill-row" onclick="NIMBUS.Dashboard._jumpToOrder('${esc(t.id)}')">
            <span class="lh-drill-id">${esc(t.id).slice(0, 10)}</span>
            <span class="lh-drill-name">${esc(t.text || t.ORDER || t.MATERIAL_DESCRIPTION || t.id)}</span>
            <span class="lh-drill-due">due ${due ? Util.fmtDT(due).slice(5, 16) : '—'}</span>
            <span class="lh-drill-sched">→ ${sched ? Util.fmtDT(sched).slice(5, 16) : '—'}</span>
            <span class="lh-drill-late">${lateLbl}</span>
          </div>`;
        }).join('');
      const more = cell.tasks.length > 12 ? `<div class="lh-drill-more">+${cell.tasks.length - 12} more</div>` : '';
      drill.innerHTML = `
        <div class="lh-drill-head">
          <strong>${esc(line)}</strong> · ${esc(dateStr)} ·
          <span>${cell.lateCount} late order${cell.lateCount === 1 ? '' : 's'} · ${cell.lateHours.toFixed(1)}h cumulative</span>
          <button class="lh-drill-close" onclick="NIMBUS.Dashboard._latenessDrillClear()" title="Close">×</button>
        </div>
        ${rows}${more}`;
      drill.hidden = false;
    },

    _latenessDrillClear() {
      Dashboard._latenessDrillKey = null;
      const drill = document.getElementById('lateness-drill');
      if (drill) { drill.hidden = true; drill.innerHTML = ''; }
    },

    _jumpToOrder(id) {
      App.goto('gantt');
      setTimeout(() => { if (Timeline && Timeline.focus) Timeline.focus(id); }, 250);
    }
  };

  /* =============================================================================
     TIMELINE NAV — minimap strip above the Gantt showing schedule range with
     utilization heat bands. Draggable viewport rect pans the main timeline.
     ========================================================================== */
  const TimelineNav = {
    _canvas: null,
    _ctx:    null,
    _dragging: false,
    _dragStartX: 0,
    _dragStartRange: null,
    _unsubStore: null,

    init() {
      const el = document.getElementById('timeline-nav');
      if (!el) return;
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:pointer;';
      el.appendChild(canvas);
      TimelineNav._canvas = canvas;
      TimelineNav._ctx    = canvas.getContext('2d');

      // Pan by dragging the viewport rect
      canvas.addEventListener('mousedown', e => {
        if (!Timeline._tl) return;
        TimelineNav._dragging = true;
        TimelineNav._dragStartX = e.offsetX;
        const w = Timeline._tl.getWindow();
        TimelineNav._dragStartRange = { start: w.start.getTime(), end: w.end.getTime() };
        e.preventDefault();
      });
      window.addEventListener('mousemove', e => {
        if (!TimelineNav._dragging || !Timeline._tl) return;
        const { scheduleMin, scheduleMax, pixelW } = TimelineNav._scheduleRange();
        if (!scheduleMin) return;
        const totalMs = scheduleMax - scheduleMin;
        const msPerPx = totalMs / pixelW;
        const dx = e.clientX - canvas.getBoundingClientRect().left - TimelineNav._dragStartX;
        const shift = dx * msPerPx;
        const r = TimelineNav._dragStartRange;
        Timeline._tl.setWindow(new Date(r.start + shift), new Date(r.end + shift));
      });
      window.addEventListener('mouseup', () => { TimelineNav._dragging = false; });

      // Click to center on click position
      canvas.addEventListener('click', e => {
        if (!Timeline._tl) return;
        const { scheduleMin, scheduleMax, pixelW } = TimelineNav._scheduleRange();
        if (!scheduleMin) return;
        const totalMs = scheduleMax - scheduleMin;
        const clickMs = scheduleMin + (e.offsetX / pixelW) * totalMs;
        const w = Timeline._tl.getWindow();
        const halfSpan = (w.end - w.start) / 2;
        Timeline._tl.setWindow(new Date(clickMs - halfSpan), new Date(clickMs + halfSpan),
          { animation: { duration: 200 } });
      });

      // Re-render on timeline range changes
      if (Timeline._tl) {
        Timeline._tl.on('rangechanged', () => TimelineNav.render());
        Timeline._tl.on('rangechange',  () => TimelineNav.render());
      }

      // Re-render when store changes
      TimelineNav._unsubStore = Store.subscribe(evt => {
        if (evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate'
            || evt.type === 'task:update' || evt.type === 'calendar:change'
            || evt.type === 'blocks:change') {
          setTimeout(() => TimelineNav.render(), 50);
        }
      });

      window.addEventListener('resize', Util.debounce(() => TimelineNav.render(), 100));
      setTimeout(() => TimelineNav.render(), 200);
    },

    _scheduleRange() {
      const el = TimelineNav._canvas;
      if (!el) return {};
      const rect = el.getBoundingClientRect();
      const pixelW = rect.width || el.offsetWidth || 800;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const scheduleMin = today.getTime();
      const scheduleMax = scheduleMin + 42 * 86400000;
      return { scheduleMin, scheduleMax, pixelW };
    },

    render() {
      const canvas = TimelineNav._canvas;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.offsetWidth  || 800;
      const cssH = canvas.offsetHeight || 42;
      canvas.width  = cssW * dpr;
      canvas.height = cssH * dpr;
      const ctx = TimelineNav._ctx;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, cssW, cssH);

      const tasks = Store.tasksArr.filter(t => t.start_date && t.end_date);
      if (!tasks.length || !Timeline._tl) return;

      const _today = new Date(); _today.setHours(0, 0, 0, 0);
      const scheduleMin = _today.getTime();
      const scheduleMax = scheduleMin + 42 * 86400000;
      const totalMs = scheduleMax - scheduleMin;

      const toX = ms => ((ms - scheduleMin) / totalMs) * cssW;

      const isDark = document.body.classList.contains('dark');
      const navBg        = isDark ? '#1c1d26' : '#ecebe4';
      const navDivider   = isDark ? 'rgba(140,142,160,0.30)' : 'rgba(217,216,207,0.6)';
      const navLabelScrim = isDark ? 'rgba(25,26,34,0.85)'  : 'rgba(236,235,228,0.82)';
      const navLabelText = isDark ? 'rgba(237,235,227,0.88)' : 'rgba(60,55,45,0.88)';
      const navWindow    = isDark ? '#ffb84d' : '#ff0033';

      // Background
      ctx.fillStyle = navBg;
      ctx.fillRect(0, 0, cssW, cssH);

      // Draw per-day utilization heat bands
      const matrix = Utilization.computeMatrix(new Date(scheduleMin), Math.ceil(totalMs / 86400000) + 2);
      const SEV_COLORS = { ok: 'rgba(47,122,77,0.25)', warn: 'rgba(230,180,0,0.40)', err: 'rgba(210,150,0,0.55)' };
      for (const line of Object.keys(matrix)) {
        for (const [dayKey, row] of Object.entries(matrix[line])) {
          if (!row.pct) continue;
          const sev = Utilization.sev(row.pct);
          if (sev === 'ok') continue;
          const dayStart = new Date(dayKey + 'T00:00:00').getTime();
          const dayEnd   = dayStart + 86400000;
          const x1 = Math.max(0, toX(dayStart));
          const x2 = Math.min(cssW, toX(dayEnd));
          ctx.fillStyle = SEV_COLORS[sev];
          ctx.fillRect(x1, 0, x2 - x1, cssH);
        }
      }

      // Day dividers — snap to local midnight so labels match vis-timeline's local-time headers
      const dayMs = 86400000;
      const _firstDayLocal = new Date(scheduleMin);
      _firstDayLocal.setHours(0, 0, 0, 0);
      const firstDay = _firstDayLocal.getTime();
      ctx.strokeStyle = navDivider;
      ctx.lineWidth = 0.5;
      for (let d = firstDay; d < scheduleMax; d += dayMs) {
        const x = toX(d);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssH); ctx.stroke();
      }

      // Order blocks (tiny)
      const lineColors = {};
      tasks.forEach(t => {
        const line = t.PRODUCTION_LINE || 'Unknown';
        if (!lineColors[line]) {
          const ci = Timeline._colorIndex(line);
          lineColors[line] = Config.COLORS[ci % Config.COLORS.length];
        }
      });
      const lineArr = [...new Set(tasks.map(t => t.PRODUCTION_LINE || 'Unknown'))].sort();
      const lineH = Math.max(2, Math.floor(cssH / (lineArr.length || 1)));
      tasks.forEach(t => {
        const li = lineArr.indexOf(t.PRODUCTION_LINE || 'Unknown');
        const x1 = toX(t.start_date.getTime());
        const x2 = toX(t.end_date.getTime());
        const y  = li * lineH;
        ctx.fillStyle = lineColors[t.PRODUCTION_LINE || 'Unknown'] + 'cc';
        ctx.fillRect(x1, y, Math.max(1, x2 - x1), lineH);
      });

      // Day labels — bottom 12px strip with a light scrim for readability
      const LABEL_H = 12;
      ctx.fillStyle = navLabelScrim;
      ctx.fillRect(0, cssH - LABEL_H, cssW, LABEL_H);
      const dayPxW = (dayMs / totalMs) * cssW;
      const labelStep = Math.max(1, Math.ceil(30 / Math.max(1, dayPxW)));
      ctx.fillStyle = navLabelText;
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      for (let d = firstDay; d < scheduleMax; d += dayMs * labelStep) {
        const labelX = toX(d + (dayMs * labelStep) / 2);
        if (labelX < 4 || labelX > cssW - 4) continue;
        const dt = new Date(d);
        ctx.fillText(`${dt.getMonth() + 1}/${dt.getDate()}`, labelX, cssH - 2);
      }

      // Viewport window rect
      const win = Timeline._tl.getWindow();
      const vx1 = Math.max(0, toX(win.start.getTime()));
      const vx2 = Math.min(cssW, toX(win.end.getTime()));
      ctx.strokeStyle = navWindow;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(vx1, 0, vx2 - vx1, cssH);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  };

  /* =============================================================================
     GANTT FILTER — visual filter bar for the Gantt. Dims non-matching items.
     Does NOT affect optimiser; purely presentational.
     ========================================================================== */
  const GanttFilter = {
    _active:         { text: '' },
    _selectedLines:  new Set(),
    _selectedColors: new Set(),
    _selectedForms:  new Set(),
    _bar:            null,

    init() {
      const bar = document.getElementById('gantt-filterbar');
      if (!bar) return;
      GanttFilter._bar = bar;
      GanttFilter.populate();

      const textIn   = document.getElementById('flt-text');
      const clearBtn = document.getElementById('flt-clear');

      if (textIn)   textIn.oninput   = Util.debounce(() => { GanttFilter._active.text = textIn.value.trim().toLowerCase(); GanttFilter._apply(); }, 120);
      if (clearBtn) clearBtn.onclick = () => GanttFilter.clear();

      Store.subscribe(evt => {
        if (evt.type === 'tasks:bulk') {
          GanttFilter.populate();
          GanttFilter._buildLineDropdown();
          GanttFilter._refreshLineBtn();
          setTimeout(() => GanttFilter._apply(), 80);
        }
        if (evt.type === 'tasks:bulkUpdate') { setTimeout(() => GanttFilter._apply(), 80); }
        if (evt.type === 'plant:selected') {
          GanttFilter._selectedLines.clear();
          GanttFilter._selectedColors.clear();
          GanttFilter._selectedForms.clear();
          GanttFilter.populate();
          GanttFilter._buildLineDropdown();
          GanttFilter._refreshLineBtn();
          setTimeout(() => GanttFilter._apply(), 80);
        }
      });

      document.addEventListener('click', e => {
        for (const [btnId, dropId] of [
          ['gantt-flt-line-btn',  'gantt-line-dropdown'],
          ['gantt-flt-color-btn', 'gantt-color-dropdown'],
          ['gantt-flt-form-btn',  'gantt-form-dropdown'],
        ]) {
          const btn  = document.getElementById(btnId);
          const drop = document.getElementById(dropId);
          if (drop && !drop.hidden && btn && !btn.contains(e.target) && !drop.contains(e.target)) {
            drop.hidden = true;
          }
        }
      });

      GanttFilter._buildLineDropdown();
    },

    populate() {
      GanttFilter._buildColorDropdown();
      GanttFilter._buildFormDropdown();
    },

    matches(task) {
      const { text } = GanttFilter._active;
      if (GanttFilter._selectedColors.size > 0 && !GanttFilter._selectedColors.has((task.COLOR || '').toUpperCase())) return false;
      if (GanttFilter._selectedForms.size  > 0 && !GanttFilter._selectedForms.has((task.FORM_SIZE || '').toUpperCase())) return false;
      if (text) {
        const haystack = [(task.text || ''), (task.ORDER || ''), (task.MATERIAL_DESCRIPTION || '')].join(' ').toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    },

    isActive() {
      return !!(GanttFilter._selectedColors.size || GanttFilter._selectedForms.size || GanttFilter._active.text);
    },

    clear() {
      GanttFilter._active = { text: '' };
      const textIn = document.getElementById('flt-text');
      if (textIn) textIn.value = '';
      GanttFilter._selectedLines.clear();
      GanttFilter._selectedColors.clear();
      GanttFilter._selectedForms.clear();
      GanttFilter._buildLineDropdown();
      GanttFilter._refreshLineBtn();
      GanttFilter._buildColorDropdown();
      GanttFilter._refreshColorBtn();
      GanttFilter._buildFormDropdown();
      GanttFilter._refreshFormBtn();
      Timeline.rebuild();
      Hierarchy.render();
      GanttFilter._apply();
    },

    _toggleLineDropdown() {
      const drop = document.getElementById('gantt-line-dropdown');
      if (drop) drop.hidden = !drop.hidden;
    },

    _buildLineDropdown() {
      const drop = document.getElementById('gantt-line-dropdown');
      if (!drop) return;
      const lineSet = new Set(Store.linesForSelectedPlant());
      for (const t of Store.tasksForSelectedPlant()) {
        if (t.PRODUCTION_LINE) lineSet.add(t.PRODUCTION_LINE);
      }
      const sorted = [...lineSet].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      for (const l of [...GanttFilter._selectedLines]) {
        if (!lineSet.has(l)) GanttFilter._selectedLines.delete(l);
      }
      const esc = s => String(s).replace(/[&<>"]/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      drop.innerHTML = sorted.length
        ? sorted.map(l =>
            `<label><input type="checkbox" value="${esc(l)}"${GanttFilter._selectedLines.has(l) ? ' checked' : ''}
             onchange="NIMBUS.GanttFilter._onLineChange(this)"> ${esc(l)}</label>`
          ).join('')
        : `<div style="padding:8px 14px;font-size:12px;color:#9a9285">No lines</div>`;
    },

    _refreshLineBtn() {
      const btn = document.getElementById('gantt-flt-line-btn');
      const lbl = document.getElementById('gantt-flt-line-label');
      if (!lbl) return;
      const n = GanttFilter._selectedLines.size;
      lbl.textContent = n === 0 ? t('ui.all_lines')
        : n === 1 ? [...GanttFilter._selectedLines][0]
        : t('ui.n_lines_filter', { count: n });
      if (btn) btn.classList.toggle('active', n > 0);
    },

    _onLineChange(cb) {
      if (cb.checked) GanttFilter._selectedLines.add(cb.value);
      else            GanttFilter._selectedLines.delete(cb.value);
      GanttFilter._refreshLineBtn();
      Timeline.rebuild();
      Hierarchy.render();
    },

    _clearLines() {
      GanttFilter._selectedLines.clear();
      GanttFilter._buildLineDropdown();
      GanttFilter._refreshLineBtn();
      Timeline.rebuild();
      Hierarchy.render();
    },

    _toggleColorDropdown() {
      const drop = document.getElementById('gantt-color-dropdown');
      if (drop) drop.hidden = !drop.hidden;
    },

    _buildColorDropdown() {
      const drop = document.getElementById('gantt-color-dropdown');
      if (!drop) return;
      const scoped = Store.selectedPlant ? Store.tasksForSelectedPlant() : [];
      const colorSet = new Set(scoped.map(t => (t.COLOR || '').toUpperCase()).filter(Boolean));
      const sorted = [...colorSet].sort();
      for (const c of [...GanttFilter._selectedColors]) {
        if (!colorSet.has(c)) GanttFilter._selectedColors.delete(c);
      }
      const esc = s => String(s).replace(/[&<>"]/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      drop.innerHTML = sorted.length
        ? sorted.map(c =>
            `<label><input type="checkbox" value="${esc(c)}"${GanttFilter._selectedColors.has(c) ? ' checked' : ''}
             onchange="NIMBUS.GanttFilter._onColorChange(this)"> ${esc(c)}</label>`
          ).join('')
        : `<div style="padding:8px 14px;font-size:12px;color:#9a9285">No colors</div>`;
      GanttFilter._refreshColorBtn();
    },

    _refreshColorBtn() {
      const btn = document.getElementById('gantt-flt-color-btn');
      const lbl = document.getElementById('gantt-flt-color-label');
      if (!lbl) return;
      const n = GanttFilter._selectedColors.size;
      lbl.textContent = n === 0 ? t('ui.all_colors')
        : n === 1 ? [...GanttFilter._selectedColors][0]
        : t('ui.n_colors_filter', { count: n });
      if (btn) btn.classList.toggle('active', n > 0);
    },

    _onColorChange(cb) {
      if (cb.checked) GanttFilter._selectedColors.add(cb.value.toUpperCase());
      else            GanttFilter._selectedColors.delete(cb.value.toUpperCase());
      GanttFilter._refreshColorBtn();
      GanttFilter._apply();
    },

    _toggleFormDropdown() {
      const drop = document.getElementById('gantt-form-dropdown');
      if (drop) drop.hidden = !drop.hidden;
    },

    _buildFormDropdown() {
      const drop = document.getElementById('gantt-form-dropdown');
      if (!drop) return;
      const scoped = Store.selectedPlant ? Store.tasksForSelectedPlant() : [];
      const formSet = new Set(scoped.map(t => (t.FORM_SIZE || '').toUpperCase()).filter(Boolean));
      const sorted = [...formSet].sort();
      for (const f of [...GanttFilter._selectedForms]) {
        if (!formSet.has(f)) GanttFilter._selectedForms.delete(f);
      }
      const esc = s => String(s).replace(/[&<>"]/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      drop.innerHTML = sorted.length
        ? sorted.map(f =>
            `<label><input type="checkbox" value="${esc(f)}"${GanttFilter._selectedForms.has(f) ? ' checked' : ''}
             onchange="NIMBUS.GanttFilter._onFormChange(this)"> ${esc(f)}</label>`
          ).join('')
        : `<div style="padding:8px 14px;font-size:12px;color:#9a9285">No forms</div>`;
      GanttFilter._refreshFormBtn();
    },

    _refreshFormBtn() {
      const btn = document.getElementById('gantt-flt-form-btn');
      const lbl = document.getElementById('gantt-flt-form-label');
      if (!lbl) return;
      const n = GanttFilter._selectedForms.size;
      lbl.textContent = n === 0 ? t('ui.all_forms')
        : n === 1 ? [...GanttFilter._selectedForms][0]
        : t('ui.n_forms_filter', { count: n });
      if (btn) btn.classList.toggle('active', n > 0);
    },

    _onFormChange(cb) {
      if (cb.checked) GanttFilter._selectedForms.add(cb.value.toUpperCase());
      else            GanttFilter._selectedForms.delete(cb.value.toUpperCase());
      GanttFilter._refreshFormBtn();
      GanttFilter._apply();
    },

    _apply: null,  // assigned below after Util is in scope

    _doApply() {
      if (!Timeline._items) return;
      const active = GanttFilter.isActive();
      const badge = document.getElementById('flt-badge');
      const bar   = document.getElementById('gantt-filterbar');

      let dimCount = 0;
      const updates = [];
      const scoped = Store.selectedPlant ? Store.tasksForSelectedPlant() : [];
      for (const task of scoped) {
        if (!task.start_date || !task.end_date) continue;
        const id = String(task.id);
        const item = Timeline._items.get(id);
        if (!item) continue;
        const shouldDim = active && !GanttFilter.matches(task);
        if (shouldDim) dimCount++;
        const baseClass = (item.className || '').split(' ').filter(c => c !== 'dimmed').join(' ');
        const newClass  = shouldDim ? baseClass + ' dimmed' : baseClass;
        if (newClass !== item.className) updates.push({ id, className: newClass });
      }
      if (updates.length) {
        Timeline._suppressEvents = true;
        try { Timeline._items.update(updates); }
        finally { Timeline._suppressEvents = false; }
      }

      const n = (GanttFilter._selectedColors.size > 0 ? 1 : 0)
              + (GanttFilter._selectedForms.size  > 0 ? 1 : 0)
              + (GanttFilter._active.text ? 1 : 0);
      if (badge) badge.textContent = n + ' filter' + (n !== 1 ? 's' : '');
      const wrap = document.getElementById('flt-badge-wrap');
      if (wrap) wrap.hidden = (n === 0);
      if (bar) bar.classList.toggle('filter-active', active);
    }
  };

  GanttFilter._apply = Util.debounce(() => GanttFilter._doApply(), 60);

  /* =============================================================================
     DEPENDENCY OVERLAY — SVG arrow layer over the Gantt visualising finish-to-
     start chains from Store._state.dependencies. Toggle via #chk-show-deps.
     Critical path gets a thicker stroke.
     ========================================================================== */
  const DependencyOverlay = {
    _svg:      null,
    _enabled:  false,
    _highlighted: null,   // id of chain to highlight
    _unsubStore: null,
    _unsubRange: null,

    init() {
      const svg = document.getElementById('dep-overlay');
      if (!svg) return;
      DependencyOverlay._svg = svg;

      const chk = document.getElementById('chk-show-deps');
      if (chk) {
        chk.onchange = () => {
          DependencyOverlay._enabled = chk.checked;
          if (!DependencyOverlay._enabled) {
            svg.innerHTML = '';
          } else {
            DependencyOverlay.render();
          }
        };
      }

      // Re-render on timeline pan/zoom
      if (Timeline._tl) {
        const doRender = () => { if (DependencyOverlay._enabled) DependencyOverlay.render(); };
        Timeline._tl.on('rangechanged', doRender);
        Timeline._tl.on('rangechange',  doRender);
      }

      DependencyOverlay._unsubStore = Store.subscribe(evt => {
        if (!DependencyOverlay._enabled) return;
        if (evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate'
            || evt.type === 'task:update') {
          setTimeout(() => DependencyOverlay.render(), 60);
        }
      });
    },

    highlightChain(taskId) {
      DependencyOverlay._highlighted = String(taskId);
      if (DependencyOverlay._enabled) DependencyOverlay.render();
    },

    render() {
      const svg = DependencyOverlay._svg;
      if (!svg || !Timeline._tl || !Timeline._items) return;
      svg.innerHTML = '';

      const deps = Store._state.dependencies;
      if (!deps || !Object.keys(deps).length) return;

      const tl  = Timeline._tl;
      const dom = document.getElementById('vis-timeline');
      if (!dom) return;
      const rect = dom.getBoundingClientRect();

      // Compute critical path lengths for each task (longest chain to it)
      const chainLen = {};
      const allIds = Object.keys(Store.tasks);
      const getLen = (id) => {
        if (chainLen[id] !== undefined) return chainLen[id];
        const sources = deps[id] || [];
        if (!sources.length) { chainLen[id] = 0; return 0; }
        chainLen[id] = 1 + Math.max(...sources.map(getLen));
        return chainLen[id];
      };
      const maxLen = Math.max(0, ...allIds.map(id => { try { return getLen(id); } catch { return 0; } }));

      // Arrow head marker
      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      ['ok','tight','gap','critical','highlight'].forEach(cls => {
        const color = { ok: '#2f7a4d', tight: '#b57a0a', gap: '#b1362a', critical: '#b1362a', highlight: '#b8791a' }[cls];
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
        marker.setAttribute('id', `arr-${cls}`);
        marker.setAttribute('markerWidth', '8');
        marker.setAttribute('markerHeight', '8');
        marker.setAttribute('refX', '6');
        marker.setAttribute('refY', '3');
        marker.setAttribute('orient', 'auto');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M0,0 L0,6 L8,3 z');
        path.setAttribute('fill', color);
        marker.appendChild(path);
        defs.appendChild(marker);
      });
      svg.appendChild(defs);

      const highlighted = DependencyOverlay._highlighted;

      // Compute coordinate transform: SVG origin = top-left of .timeline-wrap
      const wrapEl = document.querySelector('.timeline-wrap');
      const foreEl = dom.querySelector('.vis-foreground');
      if (!wrapEl || !foreEl) return;
      const wrapRect = wrapEl.getBoundingClientRect();
      const foreRect = foreEl.getBoundingClientRect();
      // Offset of vis-foreground top-left inside the SVG coordinate space
      const foreOffX = foreRect.left - wrapRect.left;
      const foreOffY = foreRect.top  - wrapRect.top;

      // Group row heights from DOM
      const groupEls = dom.querySelectorAll('.vis-foreground .vis-group');
      const lineToY = {};
      const lines = [...new Set(Store.tasksArr.map(t => t.PRODUCTION_LINE || 'Unknown'))].sort();
      if (groupEls.length) {
        lines.forEach((line, i) => {
          const groupEl = groupEls[i];
          if (groupEl) {
            const gRect = groupEl.getBoundingClientRect();
            lineToY[line] = (gRect.top - wrapRect.top) + gRect.height / 2;
          } else {
            lineToY[line] = foreOffY + (i + 0.5) * (foreRect.height / (lines.length || 1));
          }
        });
      } else {
        lines.forEach((line, i) => {
          lineToY[line] = foreOffY + (i + 0.5) * (foreRect.height / (lines.length || 1));
        });
      }

      const sw     = tl.getWindow();
      const totalMs = sw.end.getTime() - sw.start.getTime();
      const timeToX = (ms) => foreOffX + ((ms - sw.start.getTime()) / totalMs) * foreRect.width;

      for (const [targetId, sourceIds] of Object.entries(deps)) {
        const tTask = Store.tasks[targetId];
        if (!tTask || !tTask.start_date || !tTask.end_date) continue;

        for (const sourceId of sourceIds) {
          const sTask = Store.tasks[sourceId];
          if (!sTask || !sTask.start_date || !sTask.end_date) continue;

          let sx, sy, tx, ty;
          try {
            sx = timeToX(sTask.end_date.getTime());
            tx = timeToX(tTask.start_date.getTime());
            sy = lineToY[sTask.PRODUCTION_LINE || 'Unknown'] ?? (foreOffY + foreRect.height / 2);
            ty = lineToY[tTask.PRODUCTION_LINE || 'Unknown'] ?? (foreOffY + foreRect.height / 2);

            // Don't draw fully off-screen arrows
            if (tx < -50 || sx > foreOffX + foreRect.width + 50) continue;
          } catch { continue; }

          const gapMs = tTask.start_date - sTask.end_date;
          const isHighlighted = (String(sourceId) === highlighted || String(targetId) === highlighted);
          const isCritical = maxLen > 0 && (getLen(targetId) || 0) >= maxLen - 1;

          let cls = 'ok';
          if (gapMs > 15 * 60000) cls = 'gap';
          else if (Math.abs(gapMs) <= 15 * 60000) cls = 'tight';
          if (isHighlighted) cls = 'highlight';
          else if (isCritical) cls = 'critical';

          const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          const midX = (sx + tx) / 2;
          const cp1x = Math.max(sx, midX - 10);
          const cp2x = Math.min(tx, midX + 10);
          const d = `M ${sx} ${sy} C ${cp1x + 20} ${sy}, ${cp2x - 20} ${ty}, ${tx} ${ty}`;
          line.setAttribute('d', d);
          line.setAttribute('class', `dep-arrow ${cls}`);
          line.setAttribute('marker-end', `url(#arr-${cls})`);
          svg.appendChild(line);
        }
      }
    }
  };

  /* =============================================================================
     CONTEXT MENU — right-click on a timeline item.
     ========================================================================== */
  const ContextMenu = {
    _targetId: null,

    init() {
      const menu = document.getElementById('ctx-menu');
      if (!menu) return;
      menu.querySelectorAll('button').forEach(btn => {
        btn.onclick = () => {
          const action = btn.dataset.action;
          const id = ContextMenu._targetId;
          ContextMenu.close();
          if (!id) return;
          if (action === 'fix')       { Store.setFixed([id], true, 'ctx');  Alerts.scheduleRecompute(); }
          else if (action === 'unfix'){ Store.setFixed([id], false, 'ctx'); Alerts.scheduleRecompute(); }
          else if (action === 'override') { Table._openOverrideModalForId(id); }
          else if (action === 'inspect')  { const t = Store.tasks[id]; if (t) Inspector.show(t); }
        };
      });
      document.addEventListener('click', () => ContextMenu.close());
      document.addEventListener('scroll', () => ContextMenu.close(), true);
      document.addEventListener('keydown', e => { if (e.key === 'Escape') ContextMenu.close(); });
    },

    open(x, y, targetId) {
      ContextMenu._targetId = targetId;
      const menu = document.getElementById('ctx-menu');
      menu.hidden = false;
      menu.style.left = x + 'px';
      menu.style.top  = y + 'px';
      // Position correctness (don't overflow viewport)
      requestAnimationFrame(() => {
        const r = menu.getBoundingClientRect();
        if (r.right > window.innerWidth)  menu.style.left = (window.innerWidth  - r.width  - 6) + 'px';
        if (r.bottom > window.innerHeight) menu.style.top  = (window.innerHeight - r.height - 6) + 'px';
      });
      // Toggle fix/unfix visibility based on state
      const fixed = Store.isFixed(targetId);
      menu.querySelector('[data-action="fix"]').style.display   = fixed ? 'none' : '';
      menu.querySelector('[data-action="unfix"]').style.display = fixed ? '' : 'none';
    },
    close() {
      ContextMenu._targetId = null;
      const menu = document.getElementById('ctx-menu');
      if (menu) menu.hidden = true;
    }
  };

  /* =============================================================================
     SELECTION — multi-select store, independent of vis-timeline internals.
     Single source of truth for "which orders are selected". All UIs (Timeline,
     Table, Inspector, ContextMenu) subscribe to this. Never persisted, never
     autosaved.
     ========================================================================== */
  const Selection = {
    _ids: new Set(),           // Set<string>
    _anchor: null,              // id of last-single-clicked item (for Shift range)
    _listeners: new Set(),

    /** @returns {string[]} currently selected ids */
    ids() { return [...this._ids]; },
    has(id) { return this._ids.has(String(id)); },
    size() { return this._ids.size; },
    clear() {
      if (!this._ids.size) return;
      this._ids.clear();
      this._anchor = null;
      this._emit('clear');
    },
    set(ids) {
      const next = new Set(ids.map(String));
      if (_setsEqual(next, this._ids)) return;
      this._ids = next;
      this._anchor = ids.length ? String(ids[ids.length - 1]) : null;
      this._emit('set');
    },
    add(ids) {
      const arr = Array.isArray(ids) ? ids : [ids];
      let changed = false;
      for (const id of arr) {
        const s = String(id);
        if (!this._ids.has(s)) { this._ids.add(s); changed = true; }
      }
      if (changed) {
        this._anchor = String(arr[arr.length - 1]);
        this._emit('add');
      }
    },
    remove(ids) {
      const arr = Array.isArray(ids) ? ids : [ids];
      let changed = false;
      for (const id of arr) {
        if (this._ids.delete(String(id))) changed = true;
      }
      if (changed) this._emit('remove');
    },
    toggle(id) {
      const s = String(id);
      if (this._ids.has(s)) this._ids.delete(s);
      else { this._ids.add(s); this._anchor = s; }
      this._emit('toggle');
    },

    /** Select every id from anchor to target on the same line (inclusive). */
    selectRange(targetId) {
      const target = String(targetId);
      const anchor = this._anchor;
      if (!anchor || anchor === target) { this.set([target]); return; }

      const ta = Store.tasks[anchor];
      const tt = Store.tasks[target];
      if (!ta || !tt || ta.PRODUCTION_LINE !== tt.PRODUCTION_LINE) {
        this.set([target]);
        return;
      }
      const line = ta.PRODUCTION_LINE;
      const peers = Store.tasksArr
        .filter(t => t.PRODUCTION_LINE === line && t.start_date)
        .sort((a, b) => a.start_date - b.start_date);
      const ia = peers.findIndex(t => String(t.id) === anchor);
      const it = peers.findIndex(t => String(t.id) === target);
      if (ia < 0 || it < 0) { this.set([target]); return; }
      const [lo, hi] = ia < it ? [ia, it] : [it, ia];
      const range = peers.slice(lo, hi + 1).map(t => String(t.id));
      const keep = this._anchor;
      this.set(range);
      this._anchor = keep; // preserve anchor for further Shift-clicks
    },

    /** Summary for the Inspector multi-selection view. */
    stats() {
      const ids = [...this._ids];
      let totalHours = 0;
      const lines = new Set();
      let fixedCount = 0;
      for (const id of ids) {
        const t = Store.tasks[id];
        if (!t) continue;
        totalHours += Util.runHours(t);
        if (t.PRODUCTION_LINE) lines.add(t.PRODUCTION_LINE);
        if (Store.isFixed(id)) fixedCount++;
      }
      return { count: ids.length, totalHours, lines: [...lines], fixedCount };
    },

    on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); },
    _emit(kind) {
      const payload = { kind, ids: [...this._ids], anchor: this._anchor };
      for (const l of this._listeners) {
        try { l(payload); } catch (e) { ErrorLog.error('selection', `listener: ${e.message}`); }
      }
    }
  };

  function _setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }

  /* =============================================================================
     UNDO STACK — minimal, in-memory, destructive ops only (10 levels).
     Used by drag-commits and unschedule actions in the Interaction module.
     ========================================================================== */
  const UndoStack = {
    MAX: 10,
    _entries: [],

    push(label, undoFn) {
      this._entries.push({ label, undoFn, at: Date.now() });
      if (this._entries.length > this.MAX) this._entries.shift();
    },
    pop() {
      const e = this._entries.pop();
      if (!e) return null;
      try { e.undoFn(); Toast.show(t('toast.undone', { label: e.label }), 'success'); }
      catch (err) { ErrorLog.error('undo', `${e.label}: ${err.message}`); }
      return e;
    },
    /** Take a snapshot of the given task ids so they can be restored. */
    snapshotTasks(ids) {
      return ids.map(id => {
        const t = Store.tasks[id];
        return t ? Util.clone(t) : null;
      }).filter(Boolean);
    },
    restoreTasks(snapshot) {
      const patches = snapshot.map(s => ({ id: s.id, changes: s }));
      Store.updateMany(patches, 'undo');
    }
  };

  /* =============================================================================
     OPTIMIZER PREVIEW (C4) — wraps Engine.runAndApply so the planner sees a
     pre/post KPI comparison before committing. Discard reverts to the snapshot;
     Apply pushes an UndoStack entry so Ctrl+Z still works after the fact.
     ========================================================================== */
  const OptimizerPreview = {
    _snapshot: null,   // [ deep-cloned task ] taken before the run
    _preKpis:  null,
    _postKpis: null,
    _mode:     null,
    _plant:    null,

    /** Open the preview modal with a loading skeleton. Safe to call as soon as
     *  the user clicks Run, before any await/fetch — gives instant feedback so
     *  the user doesn't stare at a blurry frozen page during the wheel fetch
     *  + config-close transition + engine run. */
    showLoading(mode, plant) {
      const body = document.getElementById('opt-preview-body');
      if (body) {
        body.innerHTML =
          '<div class="cw-loading" style="justify-content:center;flex-direction:column;gap:10px;padding:40px 20px;">'
        + '  <div style="display:flex;align-items:center;gap:8px;">'
        + '    <span class="cw-spin"></span>'
        + '    <span style="font-size:14px;color:var(--fg);">Calculating optimization impact…</span>'
        + '  </div>'
        + `  <div style="font-size:12px;color:var(--fg-mute);">Running ${mode} on ${plant}</div>`
        + '</div>';
      }
      const root = document.getElementById('modal-opt-preview');
      if (root) root.querySelectorAll('.modal-foot button').forEach(b => { b.disabled = true; });
      Modal.open('modal-opt-preview');
    },

    /** Close the loading dialog without doing any work. For aborts (e.g. user
     *  cancels the no-color-wheel confirm) so the spinner doesn't linger. */
    hideLoading() {
      Modal.close('modal-opt-preview');
      const root = document.getElementById('modal-opt-preview');
      if (root) root.querySelectorAll('.modal-foot button').forEach(b => { b.disabled = false; });
    },

    /** Entry point — call this instead of Engine.runAndApply when you want
     *  the preview UI. Mirrors Engine.runAndApply's signature. */
    runWithPreview(mode = 'combined', opts = {}) {
      if (!Store.tasksArr.length) { Toast.show(t('toast.no_tasks_to_optimise'), 'error'); return; }
      const plant = opts.plant ?? Store.selectedPlant;
      if (!plant) { Toast.show(t('toast.select_plant_before_opt'), 'warn'); return; }

      // Show the preview dialog with a loading state. If `showLoading()` already
      // ran from OptimizeDialog.run() the dialog is already up — calling it
      // again is a no-op cheap refresh, fine.
      OptimizerPreview.showLoading(mode, plant);
      const previewRoot = document.getElementById('modal-opt-preview');
      const footBtns = previewRoot ? previewRoot.querySelectorAll('.modal-foot button') : [];
      const body = document.getElementById('opt-preview-body');

      // Double rAF to ensure the loading skeleton actually paints before we
      // block the main thread with the optimizer. Single rAF schedules a frame
      // but synchronous work afterward can still preempt the paint.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        try {
          // Snapshot every task in the plant — the optimizer may touch any of
          // them transitively (auto-reflow can ripple beyond the chosen window
          // / lines), so the undo snapshot must stay unfiltered.
          const scopedTasks = Store.tasksByPlant(plant);
          const ids = scopedTasks.map(t => t.id);
          const snapshot = UndoStack.snapshotTasks(ids);

          // KPI inputs are scoped to what the user actually selected on screen 1 —
          // time window and (optionally) a subset of lines. Otherwise the before/after
          // comparison drowns the user's slice in out-of-scope tasks.
          const winStart = opts.startDate ? opts.startDate.getTime() : -Infinity;
          const winEnd   = opts.endDate   ? opts.endDate.getTime()   :  Infinity;
          const lineSet  = (Array.isArray(opts.lines) && opts.lines.length) ? new Set(opts.lines) : null;
          const inScope = t => {
            if (lineSet && !lineSet.has(t.PRODUCTION_LINE)) return false;
            const s = t.start_date ? t.start_date.getTime() : null;
            const e = Util.scheduledEnd(t);
            const eMs = e ? e.getTime() : s;
            if (s == null) return false;
            return eMs >= winStart && s <= winEnd;
          };

          // Pre-KPIs from the (filtered) snapshot — it IS the current state right now.
          const preKpis = Util.scheduleKpis(snapshot.filter(inScope), 14);

          // Run the optimizer in place.
          Engine.runAndApply(mode, opts);

          // Post-KPIs from the now-mutated Store, filtered to the same scope.
          const postTasks = Store.tasksByPlant(plant).filter(inScope);
          const postKpis  = Util.scheduleKpis(postTasks, 14);

          OptimizerPreview._snapshot = snapshot;
          OptimizerPreview._preKpis  = preKpis;
          OptimizerPreview._postKpis = postKpis;
          OptimizerPreview._mode     = mode;
          OptimizerPreview._plant    = plant;

          footBtns.forEach(b => { b.disabled = false; });
          OptimizerPreview._render();
        } catch (err) {
          ErrorLog.error('optimize-preview', err?.message || String(err));
          if (body) {
            body.innerHTML =
              '<div style="padding:24px;text-align:center;color:var(--danger,#c0392b);">'
            + '  <div style="font-size:14px;margin-bottom:8px;">Optimization failed</div>'
            + `  <div style="font-size:12px;color:var(--fg-mute);">${(err?.message || 'Unknown error').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</div>`
            + '</div>';
          }
          footBtns.forEach(b => { b.disabled = false; });
        }
      }));
    },

    _render() {
      const body = document.getElementById('opt-preview-body');
      if (!body) return;
      const pre  = OptimizerPreview._preKpis  || {};
      const post = OptimizerPreview._postKpis || {};

      // Each card: { label, k, ico, fmt, lowerIsBetter, tip }.
      // lowerIsBetter: true → decrease=better (green), increase=worse (red).
      //                false → increase=better (green), decrease=worse (red).
      //                'soft' → decrease=better (green, counts as KPI win),
      //                         increase=warn (amber, no verdict penalty). Used for
      //                         span and peak utilization where shrinking is desirable
      //                         but growing shouldn't be flagged as a regression.
      //                null → neutral in both directions.
      const cards = [
        {
          label: 'Changeovers', k: 'changeovers', ico: '🔁',
          fmt: v => String(v), unit: '', lowerIsBetter: true,
          tip: 'Adjacent orders on the same line that differ in COLOR or FORM_SIZE. Each one costs cleanout/setup time, so fewer is better.',
        },
        {
          label: 'Schedule span', k: 'span_h', ico: '↔',
          fmt: v => v.toFixed(1), unit: 'h', lowerIsBetter: 'soft',
          tip: 'Total clock time from the earliest order start to the latest order finish, across the selected window and lines.',
        },
        {
          label: 'Late orders', k: 'late_count', ico: '⏰',
          fmt: v => String(v), unit: '', lowerIsBetter: true,
          tip: 'Count of orders whose scheduled finish lands AFTER the SAP planning date. Equal-weight headcount — a 1-hour slip and a 40-hour slip each count as one.',
        },
        {
          label: 'Cumulative lateness', k: 'late_h', ico: '⛌',
          fmt: v => v.toFixed(1), unit: 'h', lowerIsBetter: true,
          tip: 'Sum of due-date slip across every late order, in hours. Captures severity, not just count: ten orders slipping 1 h = 10 h; one order slipping 40 h = 40 h. Lower is better.',
        },
        {
          label: 'Peak line utilization', k: 'peak_util_pct', ico: '▲',
          fmt: v => String(v), unit: '%', lowerIsBetter: 'soft',
          tip: 'Highest single-line single-day utilization in the 14-day horizon. High is good for throughput; over 100% means overbooked vs Calendar capacity.',
        },
      ];

      // Verdict: count how many directional KPIs moved the right way. 'soft'
      // cards (span, peak utilization) count decreases as wins but treat
      // increases as neutral — they shouldn't trigger a regression verdict.
      const directional = cards.filter(c => c.lowerIsBetter === true || c.lowerIsBetter === 'soft');
      let better = 0, worse = 0, neutral = 0;
      for (const c of directional) {
        const d = (post[c.k] ?? 0) - (pre[c.k] ?? 0);
        if (Math.abs(d) < 0.05) { neutral++; continue; }
        if (c.lowerIsBetter === 'soft') {
          if (d < 0) better++; else neutral++;
        } else if (d < 0) better++;
        else worse++;
      }
      let verdictTone, verdictTitle, verdictSub;
      if (better === 0 && worse === 0) {
        verdictTone = 'neutral';
        verdictTitle = 'No measurable change';
        verdictSub = 'The optimizer ran but the KPIs are unchanged within tolerance.';
      } else if (worse === 0) {
        verdictTone = 'better';
        verdictTitle = better === directional.length ? 'Big win — every KPI improved' : 'Schedule improved';
        verdictSub = `${better} of ${directional.length} optimization KPIs moved in your favor with no regressions.`;
      } else if (better === 0) {
        verdictTone = 'worse';
        verdictTitle = 'Schedule regressed';
        verdictSub = `${worse} of ${directional.length} optimization KPIs got worse. Discard is probably the call.`;
      } else if (better >= worse) {
        verdictTone = 'better';
        verdictTitle = 'Net improvement, with trade-offs';
        verdictSub = `${better} KPI${better===1?'':'s'} improved, ${worse} regressed. Review before applying.`;
      } else {
        verdictTone = 'worse';
        verdictTitle = 'Net regression';
        verdictSub = `${worse} KPI${worse===1?'':'s'} got worse, ${better} improved. Discard recommended.`;
      }

      const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);

      const modeLabel = (OptimizerPreview._mode || '').toUpperCase();
      const plant = OptimizerPreview._plant || '';
      const stamp = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

      // Per-card markup
      const cardsHtml = cards.map(c => {
        const preV  = pre[c.k]  ?? 0;
        const postV = post[c.k] ?? 0;
        const d = postV - preV;
        const isInt = Number.isInteger(preV) && Number.isInteger(postV);
        const absD = Math.abs(d);
        const zero = absD < 0.05;

        // Direction class
        let dirCls = 'neutral';
        if (!zero && c.lowerIsBetter !== null) {
          if (c.lowerIsBetter === 'soft') {
            dirCls = d < 0 ? 'better' : 'warn';
          } else {
            const improved = c.lowerIsBetter ? d < 0 : d > 0;
            dirCls = improved ? 'better' : 'worse';
          }
        }

        // Delta number + percent
        const sign = d > 0 ? '+' : (d < 0 ? '−' : '');
        const dNum = isInt ? `${Math.abs(d)}` : absD.toFixed(1);
        const pct = (preV !== 0) ? Math.round((d / preV) * 100) : null;
        const pctStr = (pct !== null && !zero)
          ? ` <span class="opt-pv-pct">(${pct > 0 ? '+' : '−'}${Math.abs(pct)}%)</span>`
          : '';
        const deltaText = zero
          ? '<span class="opt-pv-pill-icon">●</span> No change'
          : `<span class="opt-pv-pill-icon">${dirCls === 'better' ? '▼' : (dirCls === 'worse' || dirCls === 'warn') ? '▲' : '◆'}</span> ${sign}${dNum}${c.unit}${pctStr}`;

        // Bar — visual scale of post vs pre. For neutral/no scale, hide.
        const maxV = Math.max(preV, postV, 0.0001);
        const preW  = Math.max(2, Math.round((preV / maxV) * 100));
        const postW = Math.max(2, Math.round((postV / maxV) * 100));

        return `
          <div class="opt-pv-card opt-pv-card-${dirCls}" data-key="${c.k}">
            <div class="opt-pv-card-head">
              <span class="opt-pv-card-ico">${c.ico}</span>
              <span class="opt-pv-card-label">${esc(c.label)}</span>
              <span class="opt-pv-card-help" tabindex="0" aria-label="What is this?">
                <span class="opt-pv-help-dot">?</span>
                <span class="opt-pv-tip">${esc(c.tip)}</span>
              </span>
            </div>
            <div class="opt-pv-card-body">
              <div class="opt-pv-num opt-pv-num-pre">
                <div class="opt-pv-num-lbl">Before</div>
                <div class="opt-pv-num-val">${c.fmt(preV)}<span class="opt-pv-num-unit">${c.unit}</span></div>
              </div>
              <div class="opt-pv-arrow">→</div>
              <div class="opt-pv-num opt-pv-num-post" data-target="${postV}" data-fmt="${isInt ? 'int' : 'dec'}" data-unit="${c.unit}">
                <div class="opt-pv-num-lbl">After</div>
                <div class="opt-pv-num-val">${c.fmt(postV)}<span class="opt-pv-num-unit">${c.unit}</span></div>
              </div>
            </div>
            <div class="opt-pv-bars">
              <div class="opt-pv-bar-row"><span class="opt-pv-bar-tag">pre</span><div class="opt-pv-bar"><i class="opt-pv-bar-fill pre" style="width:${preW}%"></i></div></div>
              <div class="opt-pv-bar-row"><span class="opt-pv-bar-tag">post</span><div class="opt-pv-bar"><i class="opt-pv-bar-fill post ${dirCls}" style="width:${postW}%"></i></div></div>
            </div>
            <div class="opt-pv-delta-pill ${dirCls}">${deltaText}</div>
          </div>`;
      }).join('');

      body.innerHTML = `
        <div class="opt-pv-shell">
          <div class="opt-pv-header">
            <div class="opt-pv-chip opt-pv-chip-mode">${esc(modeLabel)}</div>
            <div class="opt-pv-chip opt-pv-chip-plant" title="Plant scope">📍 ${esc(plant)}</div>
            <div class="opt-pv-chip opt-pv-chip-time">⏱ ${esc(stamp)}</div>
          </div>

          <div class="opt-pv-verdict opt-pv-verdict-${verdictTone}">
            <div class="opt-pv-verdict-icon">${verdictTone === 'better' ? '✓' : verdictTone === 'worse' ? '!' : '◐'}</div>
            <div class="opt-pv-verdict-text">
              <div class="opt-pv-verdict-title">${esc(verdictTitle)}</div>
              <div class="opt-pv-verdict-sub">${esc(verdictSub)}</div>
            </div>
            <div class="opt-pv-verdict-score">
              <div class="opt-pv-score-num">${better}<span class="opt-pv-score-of">/${directional.length}</span></div>
              <div class="opt-pv-score-lbl">KPIs improved</div>
            </div>
          </div>

          <div class="opt-pv-grid">${cardsHtml}</div>

          <div class="opt-pv-footer-note">
            <strong>Apply</strong> keeps the new schedule (still undoable via Ctrl+Z). <strong>Discard</strong> reverts every order to its pre-optimization position.
          </div>
        </div>`;

      // Counter animation on the "After" numbers — runs once on mount.
      requestAnimationFrame(() => {
        body.querySelectorAll('.opt-pv-num-post').forEach(el => {
          const target = parseFloat(el.dataset.target);
          if (!Number.isFinite(target)) return;
          const fmt   = el.dataset.fmt;
          const unit  = el.dataset.unit || '';
          const valEl = el.querySelector('.opt-pv-num-val');
          const dur   = 520;
          const t0    = performance.now();
          const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
          const tick = (now) => {
            const t = Math.min(1, (now - t0) / dur);
            const v = target * easeOutCubic(t);
            const disp = fmt === 'int' ? String(Math.round(v)) : v.toFixed(1);
            valEl.innerHTML = `${disp}<span class="opt-pv-num-unit">${unit}</span>`;
            if (t < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      });
    },

    apply() {
      const snap = OptimizerPreview._snapshot;
      const mode = OptimizerPreview._mode;
      const plant = OptimizerPreview._plant;
      if (!snap) { Modal.close('modal-opt-preview'); return; }
      // Push an undo entry so Ctrl+Z restores the pre-optimization state later.
      UndoStack.push(`Optimization (${mode})${plant ? ' · ' + plant : ''}`,
        () => UndoStack.restoreTasks(snap));
      Toast.show(t('toast.opt_applied'), 'success');
      OptimizerPreview._clear();
      Modal.close('modal-opt-preview');
      Alerts.scheduleRecompute();
    },

    discard() {
      const snap = OptimizerPreview._snapshot;
      if (snap) {
        UndoStack.restoreTasks(snap);
        Alerts.scheduleRecompute();
        Toast.show(t('toast.opt_discarded'), 'info');
      }
      OptimizerPreview._clear();
      Modal.close('modal-opt-preview');
    },

    _clear() {
      OptimizerPreview._snapshot = null;
      OptimizerPreview._preKpis  = null;
      OptimizerPreview._postKpis = null;
      OptimizerPreview._mode     = null;
      OptimizerPreview._plant    = null;
    },
  };

  /* =============================================================================
     SANDBOX — "What-If" mode. Deep-clones Store state so planners can try
     changes freely without affecting the live schedule.
     ========================================================================== */
  const Sandbox = {
    active: false,
    _snapshot: null,

    init() {
      // Inject sandbox banner into the DOM (hidden by default)
      const banner = document.getElementById('sandbox-banner');
      if (!banner) return;
      banner.innerHTML = `
        <span style="font-size:14px;">🔮</span>
        <strong>${t('ui.what_if_title')}</strong> ${t('ui.what_if_sub')}
        <input class="sb-name" id="sb-scenario-name" placeholder="${t('ph.name_scenario')}" value="${t('ui.what_if_default_name')}">
        <div style="display:flex;gap:6px;margin-left:auto;">
          <button class="btn btn-ghost sm" id="sb-discard-btn">${t('ui.discard_btn')}</button>
          <button class="btn btn-primary sm" id="sb-apply-btn">${t('ui.promote_btn')}</button>
        </div>`;
      document.getElementById('sb-discard-btn')?.addEventListener('click', () => Sandbox.exit(false));
      document.getElementById('sb-apply-btn')?.addEventListener('click',  () => Sandbox.exit(true));
    },

    enter() {
      if (Sandbox.active) { Toast.show(t('toast.already_in_sandbox'), 'warn'); return; }

      // Deep-clone current Store state
      Sandbox._snapshot = {
        tasks:     Store.tasksArr.map(t => Util.clone(t)),
        blocks:    Store.blocks.map(b => Util.clone(b)),
        calendars: Util.clone(Store.calendars),
        fixedIds:  new Set([...Store.fixedIds])
      };
      Sandbox.active = true;

      // Visual indicator
      document.body.classList.add('sandbox-mode');
      const banner = document.getElementById('sandbox-banner');
      if (banner) banner.hidden = false;

      document.querySelectorAll('.sandbox-btn').forEach(btn => {
        btn.textContent = t('ui.sandbox_on');
        btn.style.color = 'var(--warn)';
        btn.onclick = null;
      });

      Toast.show(t('toast.what_if_mode'), 'info', 1500);
    },

    exit(apply) {
      if (!Sandbox.active) return;

      if (apply) {
        // Promote sandbox state to real state with a single undoable entry
        const snap = Sandbox._snapshot;
        UndoStack.push('Discard What-If scenario', () => {
          Store.setTasks(snap.tasks, 'undo');
          Store._state.fixedIds = new Set([...snap.fixedIds]);
          for (const id of Store._state.fixedIds) { const t = Store.tasks[id]; if (t) t.fixed = true; }
          Alerts.scheduleRecompute();
          Toast.show(t('toast.scenario_discarded'), 'info');
        });
        const scenarioName = document.getElementById('sb-scenario-name')?.value || 'What-If';
        Toast.show(t('toast.scenario_applied', { name: scenarioName }), 'success');
      } else {
        // Discard: restore snapshot
        const snap = Sandbox._snapshot;
        Store.setTasks(snap.tasks, 'sandbox');
        Store._state.blocks    = snap.blocks;
        Store._state.calendars = snap.calendars;
        Store._state.fixedIds  = new Set([...snap.fixedIds]);
        for (const id of Store._state.fixedIds) { const t = Store.tasks[id]; if (t) t.fixed = true; }
        Alerts.scheduleRecompute();
        Toast.show(t('toast.scenario_discarded'), 'info');
      }

      Sandbox.active    = false;
      Sandbox._snapshot = null;

      document.body.classList.remove('sandbox-mode');
      const banner = document.getElementById('sandbox-banner');
      if (banner) banner.hidden = true;

      document.querySelectorAll('.sandbox-btn').forEach(btn => {
        btn.textContent = t('ui.sandbox_off');
        btn.style.color = '';
        btn.onclick = () => NIMBUS.Sandbox.enter();
      });
    }
  };

  /* =============================================================================
     INTERACTION — unified input pipeline for the Timeline.

     Owns ALL vis-timeline input events (click, doubleClick, contextmenu,
     DataSet 'update' / drag-commits) and the document-level keyboard shortcuts.
     Input flows:

          vis-timeline  ─click/dblclick/ctxmenu─►  Interaction  ─►  Selection
                                                               └─►  Inspector
          vis-timeline  ─DataSet 'update'──────►  Interaction  ─►  Store.updateTask
                                                               └─►  Engine.autoReflow
          keyboard      ─F / Del / Esc / Z / ←→─►  Interaction  ─►  Store / UndoStack

     CRITICAL: fixed-order protection lives in `_onDataSetUpdate`. A user-drag on
     a fixed task is REVERTED in the vis DataSet before it can reach the Store,
     with a `noActualChange` guard that distinguishes real drags from programmatic
     echoes (Timeline.rebuild, _applyTaskPatch) so we don't snap fixed items on
     every redraw.
     ========================================================================== */
  const Interaction = {
    DEBUG: false,
    DBLCLICK_SUPPRESS_MS: 300,

    _justDoubleClicked: false,
    _dblTimer: null,
    _trace: [],
    _installed: false,
    _marquee: null,
    _marqueeRAF: null,

    trace() { return this._trace.slice(-50); },
    _log(type, data) {
      const entry = { t: Date.now(), type, ...data };
      this._trace.push(entry);
      if (this._trace.length > 200) this._trace.shift();
      if (this.DEBUG) ErrorLog.info('interaction', type, data);
    },

    install() {
      if (this._installed) return;
      if (!Timeline._tl) {
        // Timeline not ready yet — retry shortly. Bootstrap calls us after
        // Timeline.init() so this path is only hit in edge cases.
        setTimeout(() => Interaction.install(), 50);
        return;
      }
      this._installed = true;

      /* ----- click: modifier keys, background clear, multi-select ---------- */
      Timeline._tl.on('click', props => Interaction._onClick(props));

      /* ----- alert-cell click: use vis-timeline's coordinate-mapping API
         (getEventProperties) instead of DOM-target matching. Background items
         render in .vis-background, but .vis-foreground .vis-group z-stacks
         above and intercepts e.target — so closest('.vis-item.alertcell-*')
         never matches. getEventProperties maps any DOM click to {group, time}
         regardless of which DIV was hit; we then look up the alertcell- item
         in the DataSet. */
      const _tlContainer = document.getElementById('vis-timeline');
      if (_tlContainer && !Interaction._alertcellDelegated) {
        Interaction._alertcellDelegated = true;
        let _downX = null, _downY = null;
        _tlContainer.addEventListener('mousedown', e => {
          _downX = e.clientX; _downY = e.clientY;
        });
        _tlContainer.addEventListener('click', e => {
          if (!Timeline._tl) return;
          // Suppress when the user was panning: a click that traveled more
          // than ~5px from its mousedown is a drag-pan, not an intent click.
          if (_downX !== null) {
            const dx = e.clientX - _downX, dy = e.clientY - _downY;
            _downX = _downY = null;
            if ((dx * dx + dy * dy) > 25) return;
          }
          const p = Timeline._tl.getEventProperties(e);
          if (!p || !p.group || !p.time) return;
          // If the click is on a real foreground item (an order), let normal
          // selection handle it — don't hijack order clicks because the cell
          // happens to be tinted.
          if (p.item && !String(p.item).startsWith('alertcell-')) return;
          const dayKey = Util.dayKey(p.time);
          const cellId = `alertcell-${p.group}-${dayKey}`;
          if (!Timeline._items.get(cellId)) return; // no alert highlight here
          Alerts.showForCell(p.group, dayKey);
        });
      }

      /* ----- doubleClick: focus + edit ------------------------------------- */
      Timeline._tl.on('doubleClick', props => Interaction._onDoubleClick(props));

      /* ----- context menu -------------------------------------------------- */
      const container = document.getElementById('vis-timeline');
      if (container) {
        container.addEventListener('contextmenu', e => {
          const p = Timeline._tl.getEventProperties(e);
          e.preventDefault();
          if (p.what === 'item' && p.item != null) {
            const id = String(p.item);
            // If right-click target is not currently selected, replace selection with it.
            if (!Selection.has(id)) Selection.set([id]);
            if (ContextMenu && typeof ContextMenu.open === 'function') {
              ContextMenu.open(e.clientX, e.clientY, id);
            }
          } else if (ContextMenu && typeof ContextMenu.openCanvas === 'function') {
            // Canvas context menu — optional extension point.
            ContextMenu.openCanvas(e.clientX, e.clientY);
          }
        });
      }

      /* ----- DataSet 'update' — drag commit only, no cascade on zoom ------ */
      Timeline._items.on('*', (event, props) => {
        if (Timeline._suppressEvents) return;
        if (event !== 'update' || !props || !props.items) return;
        Interaction._onDataSetUpdate(props);
      });

      /* ----- Multi-drag ghost preview via timechange ----------------------- */
      Timeline._tl.on('timechange', props => Interaction._onTimeChange(props));
      Timeline._tl.on('timechanged', ()   => Interaction._clearGhosts());

      /* ----- Track mouse X for edge-scroll during order drag --------------- */
      document.addEventListener('mousemove', e => {
        if (Interaction._isDragging) Interaction._dragMouseX = e.clientX;
      });

      /* ----- Hide tooltip when mouse leaves the browser window ------------- */
      document.addEventListener('mouseleave', () => {
        const t = document.querySelector('.vis-tooltip');
        if (t) t.style.display = 'none';
      });

      /* ----- keyboard ------------------------------------------------------ */
      document.addEventListener('keydown', e => Interaction._onKeyDown(e));

      /* ----- Selection → vis-timeline + Inspector sync (one-way, write) --- */
      Selection.on(evt => {
        Timeline._suppressEvents = true;
        try { Timeline._tl.setSelection(evt.ids); }
        finally { Timeline._suppressEvents = false; }

        // Preserve the original UX: opening the right sidebar when a single
        // order is selected. (This used to live in Timeline.init's select
        // handler; we moved it here so it fires off Selection, not off vis.)
        if (evt.ids.length >= 1) {
          const rs = document.getElementById('right-sidebar');
          if (rs && rs.classList.contains('collapsed')) {
            rs.classList.remove('collapsed');
            setTimeout(() => { Timeline.redraw(); TimelineNav.render(); }, 220);
          }
        }

        // Drive the Inspector from selection count.
        if (evt.ids.length === 0) {
          Inspector.clear();
          const rs = document.getElementById('right-sidebar');
          if (rs && !rs.classList.contains('collapsed')) {
            rs.classList.add('collapsed');
            setTimeout(() => { Timeline.redraw(); TimelineNav.render(); }, 220);
          }
        } else if (evt.ids.length === 1) {
          const t = Store.tasks[evt.ids[0]];
          if (t) Inspector.show(t);
        } else {
          Interaction._showMultiInspector();
        }
      });

      /* ----- AG Grid ↔ Selection sync (if Table is present) --------------- */
      Interaction._wireTableSync();

      /* ----- Ctrl+drag marquee multi-select on the Gantt canvas ------------ */
      Interaction._installMarquee();

      /* ----- Double-click a group label to isolate that line --------------- */
      Interaction._installLabelDblclick();

      /* ----- 500ms hover-preview popover on Gantt items -------------------- */
      Interaction._installHoverPreview();

      ErrorLog.info('interaction', 'Installed');
    },

    /**
     * Double-clicking a group (line) label isolates the Gantt to just that
     * line via the existing GanttFilter._selectedLines set. Re-doing the
     * gesture on the same label restores all lines.
     *
     * Uses vis-timeline's getEventProperties() (what === 'group-label') so
     * we don't have to walk internal DOM. Capture-phase listener so we beat
     * vis's own dblclick handler, which would otherwise try to treat the
     * event as an item double-click.
     */
    _installLabelDblclick() {
      const container = document.getElementById('vis-timeline');
      if (!container) return;

      container.addEventListener('dblclick', (e) => {
        if (!Timeline._tl) return;
        const p = Timeline._tl.getEventProperties(e);
        if (!p || p.what !== 'group-label' || p.group == null) return;

        e.stopPropagation();
        e.preventDefault();

        const groupId = String(p.group);
        const sel = GanttFilter._selectedLines;
        const isAlreadyIsolated = sel.size === 1 && sel.has(groupId);

        sel.clear();
        if (!isAlreadyIsolated) sel.add(groupId);

        GanttFilter._buildLineDropdown();
        GanttFilter._refreshLineBtn();
        Timeline.rebuild();
        Hierarchy.render();

        if (!isAlreadyIsolated && !Interaction._isolateToastShown) {
          Toast.show(t('toast.isolated_line', { line: groupId }), 'info');
          Interaction._isolateToastShown = true;
        }
      }, true);
    },

    /**
     * Replaces vis-timeline's plain-text tooltip with a richer card that
     * shows order #, material, qty, run hours, line, start/end, and any
     * alerts. Card appears 500 ms after the cursor lands on an item; it
     * follows the cursor and disappears on itemout, drag start, or marquee
     * start.
     */
    _installHoverPreview() {
      const container = document.getElementById('vis-timeline');
      if (!container) return;

      const SKIP_PREFIXES = ['blk-', 'past-zone-', 'alert-horizon-zone-', 'alertcell-'];
      const isOrderId = (id) => !SKIP_PREFIXES.some(p => String(id).startsWith(p));

      let card = document.getElementById('nimbus-hover-card');
      if (!card) {
        card = document.createElement('div');
        card.id = 'nimbus-hover-card';
        card.hidden = true;
        document.body.appendChild(card);
      }

      let showTimer = null;
      let activeId  = null;
      let lastX = 0, lastY = 0;

      const HOVER_DELAY_MS = 500;
      const OFFSET_X = 16, OFFSET_Y = 18;

      const reposition = () => {
        if (card.hidden) return;
        const cw = card.offsetWidth, ch = card.offsetHeight;
        const vw = window.innerWidth, vh = window.innerHeight;
        let x = lastX + OFFSET_X;
        let y = lastY + OFFSET_Y;
        if (x + cw + 8 > vw) x = lastX - OFFSET_X - cw;
        if (y + ch + 8 > vh) y = lastY - OFFSET_Y - ch;
        if (x < 4) x = 4;
        if (y < 4) y = 4;
        card.style.left = x + 'px';
        card.style.top  = y + 'px';
      };

      const renderCard = (id) => {
        const t = Store.tasks[id];
        if (!t) return '';
        const qty = t['ORDER_QUANTITY_(GMEIN)'] ?? '—';
        const run = Util.runHours(t);
        const line = t.PRODUCTION_LINE || '—';
        const color = t.COLOR || '—';
        const form  = t.FORM_SIZE || '—';
        const startStr = t.start_date ? Util.fmtDT(t.start_date) : '—';
        const endStr   = t.end_date   ? Util.fmtDT(t.end_date)   : '—';
        const orderNo  = t.ORDER || t.PRODUCTION_ORDER || t.text || t.id;
        const matDesc  = t.MATERIAL_DESCRIPTION || t.text || '';
        const rel = Store.alerts.filter(a => String(a.taskId) === String(id));
        const alertsHtml = rel.length
          ? `<div class="hov-alerts">⚐ ${rel.length} alert${rel.length === 1 ? '' : 's'}: ${
              rel.slice(0, 3).map(a => (a.type || a.sev || '')).filter(Boolean).join(', ')
            }${rel.length > 3 ? '…' : ''}</div>`
          : '';
        const fixedBadge = Store.isFixed(id)
          ? `<span class="hov-fixed">🔒 fixed</span>` : '';

        return `
          <div class="hov-title">${orderNo} ${fixedBadge}</div>
          <div class="hov-mat">${matDesc}</div>
          <div class="hov-grid">
            <span>Qty</span><span>${qty}</span>
            <span>Run</span><span>${run.toFixed(2)} h</span>
            <span>Line</span><span>${line}</span>
            <span>Color</span><span>${color}</span>
            <span>Form</span><span>${form}</span>
          </div>
          <div class="hov-dates">${startStr} → ${endStr}</div>
          ${alertsHtml}
        `;
      };

      const hide = () => {
        clearTimeout(showTimer);
        showTimer = null;
        activeId  = null;
        card.hidden = true;
      };

      Timeline._tl.on('itemover', (props) => {
        if (!props || props.item == null) return;
        const id = String(props.item);
        if (!isOrderId(id)) return;
        // Suppress during active drag or marquee — the user is doing something.
        if (Interaction._isDragging || Interaction._marquee) return;

        clearTimeout(showTimer);
        activeId = id;
        showTimer = setTimeout(() => {
          if (activeId !== id) return;
          if (Interaction._isDragging || Interaction._marquee) return;
          card.innerHTML = renderCard(id);
          card.hidden = false;
          reposition();
        }, HOVER_DELAY_MS);
      });

      Timeline._tl.on('itemout', (props) => {
        if (!props || props.item == null) return;
        if (String(props.item) === activeId) hide();
      });

      container.addEventListener('mousemove', (e) => {
        lastX = e.clientX; lastY = e.clientY;
        if (!card.hidden) reposition();
      });

      // Any of these gestures means the user moved on — drop the card.
      container.addEventListener('mousedown', hide);
      container.addEventListener('wheel', hide, { passive: true });
      document.addEventListener('keydown', hide);
    },

    /**
     * Ctrl/Cmd + drag on empty Gantt canvas draws a rubber-band rectangle and
     * additively adds every intersecting order to the current Selection.
     *
     * - Plain drag still pans the timeline (vis default) — we only hijack
     *   pointerdown when Ctrl/Cmd is held AND the press lands on background
     *   (not on a .vis-item, group label, or other timeline chrome).
     * - Existing Selection is preserved; the marquee is purely additive,
     *   matching the semantics of Ctrl+click toggle.
     * - Hit-testing uses vis-timeline's internal `itemSet.items[id].dom.box`,
     *   the same access pattern other vis integrations rely on.
     */
    _installMarquee() {
      const container = document.getElementById('vis-timeline');
      if (!container) return;

      const SKIP_PREFIXES = ['blk-', 'past-zone-', 'alert-horizon-zone-', 'alertcell-'];
      const isOrderId = (id) => !SKIP_PREFIXES.some(p => id.startsWith(p));

      const _rectsIntersect = (a, b) =>
        !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);

      const centerOf = () => container.querySelector('.vis-panel.vis-center');

      // Returns the anchor's current screen Y by accumulating the actual
      // scroll delta from each _setScrollTop call. Avoids getBCR() entirely
      // because dom.center.style.transform is set in _redraw() which fires
      // asynchronously — reading BCR right after _setScrollTop always sees
      // the stale pre-scroll position.
      const getAnchorScreenY = () => {
        const s = Interaction._marquee;
        if (!s) return 0;
        return s.anchorY + (s.scrollDelta || 0);
      };

      // Returns the anchor's current screen X by projecting anchorTime through
      // the live timeline window — so the selection box left edge stays pinned
      // to the same calendar moment even as the view pans during edge-scroll.
      const getAnchorScreenX = (cr) => {
        const s = Interaction._marquee;
        const tl = Timeline._tl;
        if (!s || !tl || !s.anchorTime) return s ? s.anchorX : 0;
        const w = tl.getWindow();
        const spanMs = w.end.getTime() - w.start.getTime();
        if (spanMs <= 0) return s.anchorX;
        const frac = (s.anchorTime.getTime() - w.start.getTime()) / spanMs;
        return cr.left + frac * (cr.right - cr.left);
      };

      // Shared overlay + hit-test update — called from both pointermove and the
      // edge-scroll RAF so selection expands as the view pans.
      const updateOverlay = (mx, my) => {
        const s = Interaction._marquee;
        if (!s) return;
        const cr = s.centerRect;
        const ax = Math.max(cr.left, Math.min(cr.right, getAnchorScreenX(cr)));
        const ay = Math.max(cr.top,  Math.min(cr.bottom, getAnchorScreenY()));
        const cx = Math.max(cr.left, Math.min(cr.right, mx));
        const cy = Math.max(cr.top,  Math.min(cr.bottom, my));
        const left = Math.min(ax, cx), right  = Math.max(ax, cx);
        const top  = Math.min(ay, cy), bottom = Math.max(ay, cy);

        s.overlay.style.left   = (left - cr.left) + 'px';
        s.overlay.style.top    = (top  - cr.top)  + 'px';
        s.overlay.style.width  = (right - left)   + 'px';
        s.overlay.style.height = (bottom - top)   + 'px';

        const rect = { left, right, top, bottom };
        const itemSet = Timeline._tl && Timeline._tl.itemSet && Timeline._tl.itemSet.items;
        if (!itemSet) return;

        const hits = new Set();
        for (const id of Object.keys(itemSet)) {
          if (!isOrderId(id)) continue;
          const box = itemSet[id]?.dom?.box;
          if (!box) continue;
          if (_rectsIntersect(rect, box.getBoundingClientRect())) hits.add(id);
        }

        if (hits.size === s.lastHits.size) {
          let same = true;
          for (const h of hits) if (!s.lastHits.has(h)) { same = false; break; }
          if (same) return;
        }
        s.lastHits = hits;
        const next = new Set(s.baseIds);
        for (const h of hits) next.add(h);
        Selection.set([...next]);
      };

      // RAF loop: pans the timeline while the cursor is within ZONE px of either
      // edge, then calls updateOverlay so newly exposed items enter the selection.
      const startMarqueeScroll = () => {
        if (Interaction._marqueeRAF) return;
        const ZONE = 80, MAX_SPEED = 0.003;
        const MAX_VPXL = MAX_SPEED * (Interaction._marquee?.centerRect?.width || 1200);
        const tick = () => {
          const s = Interaction._marquee;
          if (!s) { Interaction._marqueeRAF = null; return; }
          const tl = Timeline._tl;
          const cr = s.centerRect;
          const mx = s.curMouseX;
          const my = s.curMouseY;
          let scrolled = false;

          // Horizontal pan
          let fraction = 0;
          if (mx < cr.left + ZONE)       fraction = -((cr.left + ZONE - mx) / ZONE);
          else if (mx > cr.right - ZONE) fraction =  (mx - (cr.right - ZONE)) / ZONE;
          if (fraction !== 0 && tl) {
            const w = tl.getWindow();
            const spanMs = w.end.getTime() - w.start.getTime();
            tl.setWindow(
              new Date(w.start.getTime() + fraction * MAX_SPEED * spanMs),
              new Date(w.end.getTime()   + fraction * MAX_SPEED * spanMs),
              { animation: false }
            );
            scrolled = true;
          }

          // Vertical scroll — read props.scrollTop before AND after the call so
          // we accumulate the actual clamped delta without any DOM/BCR timing issues.
          let vfraction = 0;
          if (my < cr.top + ZONE)         vfraction = -((cr.top + ZONE - my) / ZONE);
          else if (my > cr.bottom - ZONE) vfraction =  (my - (cr.bottom - ZONE)) / ZONE;
          if (vfraction !== 0 && tl && tl._setScrollTop) {
            const before = tl._getScrollTop ? tl._getScrollTop() : 0;
            tl._setScrollTop(before - vfraction * MAX_VPXL);
            const after = tl._getScrollTop ? tl._getScrollTop() : before;
            s.scrollDelta += (after - before);
            scrolled = true;
          }

          if (scrolled) updateOverlay(s.curMouseX, s.curMouseY);
          Interaction._marqueeRAF = requestAnimationFrame(tick);
        };
        Interaction._marqueeRAF = requestAnimationFrame(tick);
      };

      const onPointerDown = (e) => {
        if (e.button !== 0) return;
        if (!(e.ctrlKey || e.metaKey)) return;
        const center = centerOf();
        if (!center || !center.contains(e.target)) return;
        // Don't hijack presses that land on a foreground item or label — those
        // are handled by vis (drag-item) and our click handler (Ctrl+click).
        // Background items (past-zone, alert-horizon-zone, alertcell) also
        // carry .vis-item but live in .vis-background; they must not block.
        if (e.target.closest('.vis-foreground .vis-item')) return;
        if (e.target.closest('.vis-labelset')) return;

        e.stopPropagation();
        e.preventDefault();
        try { container.setPointerCapture(e.pointerId); } catch (_) {}

        const overlay = document.createElement('div');
        overlay.className = 'nimbus-marquee';
        center.appendChild(overlay);

        const cr = center.getBoundingClientRect();
        Interaction._marquee = {
          pointerId: e.pointerId,
          anchorX: e.clientX,
          anchorY: e.clientY,
          centerRect: cr,
          overlay,
          baseIds: new Set(Selection.ids()),
          lastHits: new Set(),
          curMouseX: e.clientX,
          curMouseY: e.clientY,
        };

        // Pin the anchor in timeline-time (X) and scroll-space (Y) so the box
        // expands correctly in both directions during edge-scroll.
        const tl = Timeline._tl;
        if (tl) {
          const w = tl.getWindow();
          const spanMs = w.end.getTime() - w.start.getTime();
          const crWidth = cr.right - cr.left;
          const frac = crWidth > 0 ? (e.clientX - cr.left) / crWidth : 0;
          Interaction._marquee.anchorTime = new Date(w.start.getTime() + frac * spanMs);
          Interaction._marquee.scrollDelta = 0;
        }

        startMarqueeScroll();
      };

      const onPointerMove = (e) => {
        const s = Interaction._marquee;
        if (!s || e.pointerId !== s.pointerId) return;
        s.curMouseX = e.clientX;
        s.curMouseY = e.clientY;
        updateOverlay(e.clientX, e.clientY);
      };

      const onPointerUp = (e) => {
        const s = Interaction._marquee;
        if (!s || e.pointerId !== s.pointerId) return;
        try { container.releasePointerCapture(s.pointerId); } catch (_) {}
        s.overlay.remove();
        Interaction._marquee = null;
        cancelAnimationFrame(Interaction._marqueeRAF);
        Interaction._marqueeRAF = null;
      };

      container.addEventListener('pointerdown',  onPointerDown, true);
      container.addEventListener('pointermove',  onPointerMove, true);
      container.addEventListener('pointerup',    onPointerUp,   true);
      container.addEventListener('pointercancel', onPointerUp,  true);
    },

    _onClick(props) {
      this._log('click', { what: props.what, item: props.item });

      // If a double-click just fired, swallow this follow-up select.
      if (this._justDoubleClicked) return;

      const ev = props.event || {};
      const shift = !!(ev.shiftKey || ev.srcEvent?.shiftKey);
      const meta  = !!(ev.metaKey  || ev.ctrlKey || ev.srcEvent?.metaKey || ev.srcEvent?.ctrlKey);

      // Alert-cell clicks are handled by a separate coordinate-mapped listener
      // installed in Interaction.install — see the getEventProperties-based
      // handler near the Timeline._tl.on('click', ...) subscription.

      if (props.what !== 'item' || props.item == null) {
        // Click on empty canvas — clear unless modifier held.
        if (!shift && !meta) Selection.clear();
        return;
      }

      const id = String(props.item);

      // Refuse to "select" a blackout block — they're decorative.
      if (id.startsWith('blk-')) { Selection.clear(); return; }

      if (shift)     Selection.selectRange(id);
      else if (meta) Selection.toggle(id);
      else           Selection.set([id]);

      // --- BEGIN center-on-click (remove this block to revert) ---
      if (Config.CENTER_ON_CLICK && !shift && !meta && Timeline._tl) {
        // zoom:false → pan only; preserves the current time window width.
        Timeline._tl.focus(String(id), { animation: { duration: 300 }, zoom: false });
      }
      // --- END center-on-click ---

      // Highlight the dependency chain for this task
      if (typeof DependencyOverlay !== 'undefined') DependencyOverlay.highlightChain(id);
    },

    _onDoubleClick(props) {
      this._log('doubleClick', { what: props.what, item: props.item });
      if (props.what !== 'item' || props.item == null) return;

      this._justDoubleClicked = true;
      clearTimeout(this._dblTimer);
      this._dblTimer = setTimeout(() => { this._justDoubleClicked = false; },
                                  this.DBLCLICK_SUPPRESS_MS);

      const id = String(props.item);
      if (id.startsWith('blk-')) return;
      const t = Store.tasks[id];
      if (!t) return;

      Selection.set([id]);
      // Double-click action: focus-zoom AND open the full edit modal (if present).
      if (typeof Timeline.focus === 'function') Timeline.focus(id);
      if (Modal && typeof Modal.openEdit === 'function') Modal.openEdit(t);
    },

    /** Drag commit: update the store and reflow ONLY if times/line actually changed.
     *  Fixed orders are reverted in the DataSet and never reach the Store. */
    _onDataSetUpdate(props) {
      for (const id of props.items) {
        const v = Timeline._items.get(id);
        if (!v) continue;
        const t = Store.tasks[id];
        if (!t) continue;

        /* ----- Fixed-order protection ------------------------------------
         * If the task is fixed, revert any real drag before it hits the Store.
         * But first distinguish a *real drag* from a *programmatic echo*:
         * Timeline.rebuild and _applyTaskPatch both call _items.update() inside
         * _suppressEvents, so they won't reach here — but if a redraw races
         * with a drag-commit (or a third-party integration calls update()
         * without suppression), we'd see a bogus "change" of zero magnitude.
         * The noActualChange guard catches that case and drops the event.
         * ---------------------------------------------------------------- */
        if (Store.isFixed(id)) {
          const currentStart = Util.snap(new Date(v.start));
          const currentGroup = v.group || t.PRODUCTION_LINE;
          const noActualChange = t.start_date &&
            currentStart.getTime() === t.start_date.getTime() &&
            currentGroup === t.PRODUCTION_LINE;

          if (noActualChange) {
            this._log('update:ignored', { id, reason: 'fixed task, no change' });
            continue;
          }
          // Fixed items are user-draggable — fall through to normal update path
        }

        const newStart = Util.snap(new Date(v.start));
        const newEnd   = Util.snap(new Date(v.end));
        const newLine  = v.group || t.PRODUCTION_LINE;

        const moved = (!t.start_date || newStart.getTime() !== t.start_date.getTime())
                   || (!t.end_date   || newEnd.getTime()   !== t.end_date.getTime())
                   || newLine !== t.PRODUCTION_LINE;

        if (!moved) {
          // vis emitted an update for non-temporal reasons (e.g. zoom relayout).
          // Do NOTHING — this is the fix for the click-cascades-into-rebuild bug.
          this._log('update:ignored', { id, reason: 'no temporal change' });
          continue;
        }
        // Task was unscheduled (null dates) — skip drag processing to avoid TypeError.
        if (!t.start_date || !t.end_date) continue;

        this._log('update:commit', { id, newLine });

        // Multi-order drag: if the dragged item is part of a multi-selection,
        // move all non-fixed selected items by the same time + line delta.
        const deltaMs  = newStart.getTime() - t.start_date.getTime();
        const lineMoved = newLine !== t.PRODUCTION_LINE;
        const selIds = Selection.ids().filter(sid => sid !== id && !Store.isFixed(sid));

        if (selIds.length > 0 && (Math.abs(deltaMs) > 0 || lineMoved)) {
          // Snapshot all affected tasks for undo
          const allIds = [id, ...selIds];
          const snap = UndoStack.snapshotTasks(allIds);

          // Apply the dragged item
          Store.updateTask(id, { start_date: newStart, end_date: newEnd, PRODUCTION_LINE: newLine }, 'timeline');

          // Apply the same delta to each companion
          const skippedFixed = [];
          const companionPatches = [];
          for (const sid of selIds) {
            const st = Store.tasks[sid];
            if (!st || !st.start_date) continue;
            const sNewStart = new Date(st.start_date.getTime() + deltaMs);
            const sNewEnd   = new Date(st.end_date  ? st.end_date.getTime() + deltaMs : sNewStart.getTime() + Util.runHours(st) * 3600000);
            const sNewLine  = lineMoved ? newLine : (st.PRODUCTION_LINE || 'Unknown');
            companionPatches.push({ id: sid, changes: { start_date: sNewStart, end_date: sNewEnd, PRODUCTION_LINE: sNewLine } });

            // Update the vis item too
            Timeline._suppressEvents = true;
            try {
              Timeline._items.update({ id: sid, start: sNewStart, end: sNewEnd, group: sNewLine });
            } finally { Timeline._suppressEvents = false; }
          }
          if (companionPatches.length) Store.updateMany(companionPatches, 'timeline');

          if (skippedFixed.length) Toast.show(t('toast.fixed_count_not_moved', { count: skippedFixed.length }), 'warn');

          UndoStack.push(`Move ${allIds.length} orders`,
            () => { UndoStack.restoreTasks(snap); Alerts.scheduleRecompute(); });
          this._clearGhosts();
          return;
        }

        // Single-item drag (original behaviour)
        const snap = UndoStack.snapshotTasks([id]);

        Store.updateTask(id, {
          start_date:      newStart,
          end_date:        newEnd,
          PRODUCTION_LINE: newLine
        }, 'timeline');

        UndoStack.push(`Move "${(Store.tasks[id] && Store.tasks[id].text) || id}"`,
                       () => UndoStack.restoreTasks(snap));
      }
    },

    _ghostDragId: null,
    _edgeScrollRAF: null,
    _isDragging: false,
    _dragMouseX: null,

    _startEdgeScroll() {
      if (this._edgeScrollRAF) return;
      const tick = () => {
        if (!Interaction._isDragging) { Interaction._edgeScrollRAF = null; return; }
        const tl   = Timeline._tl;
        const rect = document.querySelector('#vis-timeline').getBoundingClientRect();
        const ZONE = 100;
        const MAX_SPEED = 0.004;
        let fraction = 0;
        if (Interaction._dragMouseX != null) {
          if (Interaction._dragMouseX < rect.left + ZONE) {
            fraction = -((rect.left + ZONE - Interaction._dragMouseX) / ZONE);
          } else if (Interaction._dragMouseX > rect.right - ZONE) {
            fraction =  (Interaction._dragMouseX - (rect.right - ZONE)) / ZONE;
          }
        }
        if (fraction !== 0) {
          const w = tl.getWindow();
          const spanMs = w.end.getTime() - w.start.getTime();
          const shiftMs = fraction * MAX_SPEED * spanMs;
          tl.setWindow(
            new Date(w.start.getTime() + shiftMs),
            new Date(w.end.getTime()  + shiftMs),
            { animation: false }
          );
        }
        Interaction._edgeScrollRAF = requestAnimationFrame(tick);
      };
      this._edgeScrollRAF = requestAnimationFrame(tick);
    },

    /** Fires at 60fps during drag — show ghost positions for companion items. */
    _onTimeChange(props) {
      if (!props || !props.id || Timeline._suppressEvents) return;
      const dragId = String(props.id);
      if (dragId.startsWith('blk-')) return;

      this._isDragging = true;
      this._startEdgeScroll();

      const _tip = document.querySelector('.vis-tooltip');
      if (_tip) _tip.style.display = 'none';

      const selIds = Selection.ids().filter(sid => sid !== dragId);
      if (!selIds.length) return;

      const t = Store.tasks[dragId];
      if (!t || !t.start_date) return;
      const dragMs = (props.time instanceof Date ? props.time : new Date(props.time)).getTime();
      const deltaMs = dragMs - t.start_date.getTime();

      this._ghostDragId = dragId;
      const updates = [];

      for (const sid of selIds) {
        const st = Store.tasks[sid];
        if (!st || !st.start_date) continue;
        const ghostStart = new Date(st.start_date.getTime() + deltaMs);
        const ghostEnd   = st.end_date ? new Date(st.end_date.getTime() + deltaMs) : ghostStart;
        const item = Timeline._items.get(sid);
        if (!item) continue;

        // Check for ghost collisions with non-selected tasks on same line
        const line = st.PRODUCTION_LINE || 'Unknown';
        const hasConflict = Store.tasksArr.some(peer => {
          if (peer.id === sid || Selection.has(String(peer.id))) return false;
          if ((peer.PRODUCTION_LINE || 'Unknown') !== line) return false;
          if (!peer.start_date || !peer.end_date) return false;
          return ghostStart < peer.end_date && ghostEnd > peer.start_date;
        });

        const baseCls = (item.className || '').replace(/\s*(ghost|ghost-conflict)\s*/g, '').trim();
        updates.push({
          id: sid,
          start: ghostStart,
          end: ghostEnd,
          className: baseCls + (hasConflict ? ' ghost ghost-conflict' : ' ghost')
        });
      }

      if (updates.length) {
        Timeline._suppressEvents = true;
        try { Timeline._items.update(updates); }
        finally { Timeline._suppressEvents = false; }
      }
    },

    /** Clear ghost states from all companion items after drag ends. */
    _clearGhosts() {
      this._isDragging = false;
      if (this._edgeScrollRAF) { cancelAnimationFrame(this._edgeScrollRAF); this._edgeScrollRAF = null; }

      const _tip = document.querySelector('.vis-tooltip');
      if (_tip) _tip.style.display = '';

      const updates = [];
      for (const sid of Selection.ids()) {
        const item = Timeline._items.get(sid);
        if (!item) continue;
        const newCls = (item.className || '').replace(/\s*(ghost|ghost-conflict)\s*/g, '').trim();
        if (newCls !== item.className) {
          const t = Store.tasks[sid];
          updates.push({
            id: sid,
            start: t?.start_date || item.start,
            end:   t?.end_date   || item.end,
            className: newCls
          });
        }
      }
      if (updates.length) {
        Timeline._suppressEvents = true;
        try { Timeline._items.update(updates); }
        finally { Timeline._suppressEvents = false; }
      }
      this._ghostDragId = null;
    },

    _onKeyDown(e) {
      // Ignore when typing in inputs.
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;

      const mod = e.metaKey || e.ctrlKey;

      // Undo
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
        if (UndoStack._entries.length) { e.preventDefault(); UndoStack.pop(); }
        return;
      }

      // Save
      if (mod && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        Persistence.saveAll();
        return;
      }

      // Escape → clear
      if (e.key === 'Escape') {
        if (Selection.size()) { e.preventDefault(); Selection.clear(); }
        return;
      }

      // Enter → edit (if single selection)
      if (e.key === 'Enter' && Selection.size() === 1) {
        const id = Selection.ids()[0];
        const t = Store.tasks[id];
        if (t && Modal && typeof Modal.openEdit === 'function') {
          e.preventDefault();
          Modal.openEdit(t);
        }
        return;
      }

      // Delete / Backspace → unschedule (NOT delete the order)
      if ((e.key === 'Delete' || e.key === 'Backspace') && Selection.size()) {
        e.preventDefault();
        Interaction._unscheduleSelected();
        return;
      }

      // F → toggle Fixed
      if (e.key.toLowerCase() === 'f' && !mod && Selection.size()) {
        e.preventDefault();
        const ids = Selection.ids();
        const allFixed = ids.every(id => Store.isFixed(id));
        Store.setFixed(ids, !allFixed, 'interaction');
        return;
      }

      // Arrow navigation — single selection only
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight'
        || e.key === 'ArrowUp'   || e.key === 'ArrowDown')
        && Selection.size() === 1) {
        e.preventDefault();
        Interaction._navigateSelection(e.key);
      }
    },

    _unscheduleSelected() {
      const ids = Selection.ids().filter(id => !Store.isFixed(id));
      if (!ids.length) { Toast.show(t('toast.unschedule_all_fixed'), 'warn'); return; }
      const snap = UndoStack.snapshotTasks(ids);
      const patches = ids.map(id => ({ id, changes: { start_date: null, end_date: null } }));
      Store.updateMany(patches, 'interaction');
      UndoStack.push(`Unschedule ${ids.length} order(s)`,
                     () => UndoStack.restoreTasks(snap));
      Toast.show(t('toast.unscheduled_orders', { count: ids.length }), 'success');
    },

    _navigateSelection(key) {
      const currentId = Selection.ids()[0];
      const cur = Store.tasks[currentId];
      if (!cur || !cur.start_date) return;

      const allLines = [...new Set(Store.tasksArr
        .filter(t => t.PRODUCTION_LINE)
        .map(t => t.PRODUCTION_LINE))].sort();

      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const peers = Store.tasksArr
          .filter(t => t.PRODUCTION_LINE === cur.PRODUCTION_LINE && t.start_date)
          .sort((a, b) => a.start_date - b.start_date);
        const i = peers.findIndex(t => String(t.id) === currentId);
        const j = key === 'ArrowLeft' ? i - 1 : i + 1;
        if (j >= 0 && j < peers.length) Selection.set([String(peers[j].id)]);
      } else {
        const li = allLines.indexOf(cur.PRODUCTION_LINE);
        const lj = key === 'ArrowUp' ? li - 1 : li + 1;
        if (lj < 0 || lj >= allLines.length) return;
        const targetLine = allLines[lj];
        // Pick the task on the new line that's temporally closest to current.
        const candidates = Store.tasksArr
          .filter(t => t.PRODUCTION_LINE === targetLine && t.start_date);
        if (!candidates.length) return;
        candidates.sort((a, b) => Math.abs(a.start_date - cur.start_date)
                                - Math.abs(b.start_date - cur.start_date));
        Selection.set([String(candidates[0].id)]);
      }
    },

    /** Replaces the single-task Inspector with a multi-selection summary view. */
    _showMultiInspector() {
      const panel = document.querySelector('#right-sidebar .inspector-body, #inspector-body');
      if (!panel) return;
      const s = Selection.stats();
      panel.innerHTML = `
        <div class="multi-select-panel" style="padding:12px;">
          <div style="font-size:20px;font-weight:700;margin-bottom:8px;">
            ${t('ui.orders_selected', { count: s.count })}
          </div>
          <div style="font-size:13px;color:#666;margin-bottom:12px;">
            ${Util.fmtHours(s.totalHours)} total run-time · ${s.lines.length} line${s.lines.length === 1 ? '' : 's'}
            ${s.fixedCount ? ` · ${s.fixedCount} fixed` : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            <button class="btn btn-ghost" onclick="NIMBUS.Interaction._bulkFix(true)">${t('btn.fix_all')}</button>
            <button class="btn btn-ghost" onclick="NIMBUS.Interaction._bulkFix(false)">${t('btn.unfix_all')}</button>
            <button class="btn btn-ghost" onclick="NIMBUS.Interaction._unscheduleSelected()">${t('btn.unschedule_all')}</button>
            <button class="btn btn-ghost" onclick="NIMBUS.Selection.clear()">${t('btn.clear_selection')}</button>
          </div>
        </div>`;
    },

    _bulkFix(fixed) {
      const ids = Selection.ids();
      if (!ids.length) return;
      Store.setFixed(ids, fixed, 'interaction');
      this._showMultiInspector();
    },

    _wireTableSync() {
      // Selection → Table: when selection changes, highlight rows in AG Grid.
      Selection.on(evt => {
        if (!Table || !Table._api) return;
        try {
          Table._suppressSelectionEcho = true;
          Table._api.deselectAll();
          Table._api.forEachNode(node => {
            if (node.data && evt.ids.includes(String(node.data.id))) {
              node.setSelected(true, false);
            }
          });
        } catch (e) {
          ErrorLog.warn('interaction', `Table sync failed: ${e.message}`);
        } finally {
          Table._suppressSelectionEcho = false;
        }
      });

      // Table → Selection: if AG Grid's selection changes from user action, mirror it.
      if (Table && Table._api && typeof Table._api.addEventListener === 'function') {
        Table._api.addEventListener('selectionChanged', () => {
          if (Table._suppressSelectionEcho) return;
          const rows = Table._api.getSelectedRows ? Table._api.getSelectedRows() : [];
          const ids = rows.map(r => String(r.id));
          if (!_setsEqual(new Set(ids), Selection._ids)) Selection.set(ids);
        });
      }
    }
  };

  /* =============================================================================
     PERSISTENCE — backend fetch, demo fallback, save + local cache.
     ========================================================================== */
  const Persistence = {
    _currentLoadedPlant: null,  // plant whose tasks are currently in Store (null = all plants)
    _dirtyIds: new Set(),       // task ids mutated since last successful backend save

    // Stats captured on every load, exposed via NIMBUS.Persistence.stats()
    _lastLoad: {
      source: null,          // 'backend' | 'cache' | 'demo'
      ts: null,
      plant: null,           // plant filter applied to this load (null = all plants)
      raw_received: 0,       // rows as received from /tasks (after plant filter + color merge)
      backend_meta: null,    // payload.meta from brain.py
      // Color-merge now runs per-request on the backend, so misses are scoped to
      // the active plant filter. The pipeline panel reads these instead of
      // the load-time values in /diagnostics/deep.
      color_merge_misses: 0,
      missed_colors: [],
      pre_color_merge_count: 0,   // rows entering color merge (post plant filter)
      filtered_pl: 0,        // rows removed because id startsWith 'PL_'
      filtered_null_id: 0,   // rows removed because id was null/empty
      dedup_collisions: 0,   // ids that collided during Store.setTasks
      rendered: 0,           // Store.tasksArr.length after load
      errors: 0
    },

    stats() { return { ...Persistence._lastLoad }; },

    load({ force = false, plant = null } = {}) {
      const stats = Persistence._lastLoad = {
        source: null, ts: new Date().toISOString(), plant: plant ?? null,
        raw_received: 0, backend_meta: null,
        color_merge_misses: 0, missed_colors: [], pre_color_merge_count: 0,
        filtered_pl: 0, filtered_null_id: 0,
        dedup_collisions: 0, rendered: 0, errors: 0
      };
      ErrorLog.info('persistence', `Load requested (force=${force}, plant=${plant ?? 'all'})`);

      const tasksUrl = plant
        ? `${Config.API_BASE}/tasks?plant=${encodeURIComponent(plant)}`
        : `${Config.API_BASE}/tasks`;
      return fetch(tasksUrl, { signal: AbortSignal.timeout(8000) })
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status} from /tasks`);
          return r.json();
        })
        .then(payload => {
          // A successful HTTP 200 is authoritative — after this point we
          // refuse to silently fall back to cache even if downstream throws.
          stats.source = 'backend';
          stats.raw_received = payload?.data?.length ?? 0;
          stats.backend_meta = payload?.meta ?? null;
          // Lift per-request color stats out of meta so the pipeline panel
          // can read them without digging into backend_meta.
          stats.color_merge_misses = payload?.meta?.color_merge_misses ?? 0;
          stats.missed_colors = payload?.meta?.missed_colors ?? [];
          stats.pre_color_merge_count = payload?.meta?.pre_color_merge_count ?? 0;
          ErrorLog.info('persistence',
            `Backend returned ${stats.raw_received} rows`,
            { meta: stats.backend_meta });

          if (!stats.raw_received) {
            ErrorLog.warn('persistence', 'Backend returned zero rows — nothing to render');
            Toast.show(t('toast.backend_zero_orders'), 'warn');
            Store.setTasks([], 'persistence');
            return;
          }

          // Step 1: drop PL_ pseudo-rows (line-group leftovers)
          const afterPL = payload.data.filter(t => {
            if (String(t.id || '').startsWith('PL_')) {
              stats.filtered_pl++;
              ErrorLog.warn('persistence', `Dropped line-group row id=${t.id}`, t);
              return false;
            }
            return true;
          });

          // Step 2: drop rows with no id at all
          const afterId = afterPL.filter(t => {
            if (t.id == null || String(t.id).trim() === '') {
              stats.filtered_null_id++;
              ErrorLog.error('persistence', 'Dropped row with null/empty id', t);
              return false;
            }
            return true;
          });

          // Step 3: prep + push to Store (Store will report collisions)
          const tasks = afterId.map(raw => {
            try { return Persistence._prepTask(raw); }
            catch (e) {
              stats.errors++;
              ErrorLog.error('persistence', `Row prep failed for id=${raw.id}: ${e.message}`, raw);
              return null;
            }
          }).filter(Boolean);

          // Restore user state (blocks, calendars, fixedIds, lineSettings) from localStorage
          // before setTasks so alerts compute with the correct context. The backend is
          // authoritative for task schema; the cache owns blocks/calendars/fixedIds AND
          // any manually-positioned task dates the user has placed beyond the auto-snap baseline.
          let cacheData = null;
          try {
            const rawCache = localStorage.getItem(Config.LS_KEY);
            if (rawCache) {
              cacheData = JSON.parse(rawCache);
              Persistence._restoreNonTaskState(cacheData);
            }
          } catch(_) {}

          // Sync plant from backend task data BEFORE setTasks so Timeline.rebuild()
          // called synchronously by the tasks:bulk subscriber sees correct plant assignments
          for (const t of tasks) {
            const line = t.PRODUCTION_LINE;
            if (!line || !t.PLANT) continue;
            Store.ensureLineSettings(line);
            Store._state.lineSettings[line].plant = t.PLANT;
          }

          // Overlay user-explicitly-moved positions from localStorage before snapping so that
          // _snapToWorkingHours detects them via startMoved and skips re-snap. Only tasks
          // where the cached start differs from the cached original baseline are overlaid.
          if (cacheData?.tasks?.length) {
            Persistence._overlayUserMoves(tasks, cacheData.tasks);
          }

          // SAP ships date-only starts (00:00) — snap each order to the first
          // feasible working slot on its line so ingest doesn't fire false
          // out-of-hours alerts and the variance baseline reflects reality.
          Persistence._snapToWorkingHours(tasks);

          const setResult = Store.setTasks(tasks, 'persistence');
          stats.dedup_collisions = setResult.collisions;
          stats.rendered = Store.tasksArr.length;
          Persistence._currentLoadedPlant = plant;

          // Apply fixed flag to tasks restored from cache
          for (const id of Store._state.fixedIds) {
            const t = Store.tasks[id]; if (t) t.fixed = true;
          }

          (payload.links || []).forEach(link => {
            (Store._state.dependencies[link.target] ||= []).push(link.source);
          });
          for (const t of Store.tasksArr) Store.ensureCalendar(t.PRODUCTION_LINE || 'Unknown');
          Alerts.scheduleRecompute();

          // Integrity reconciliation — compare received vs rendered, not total-emitted vs rendered,
          // so an active plant filter doesn't produce a false "data lost" warning.
          const lost = stats.raw_received - stats.rendered;
          if (lost > 0) {
            ErrorLog.error('persistence',
              `Data-integrity gap: received ${stats.raw_received}, UI rendered ${stats.rendered} (delta=${lost})`,
              stats);
            Toast.show(t('toast.data_integrity_gap', { count: lost }), 'warn', 5000);
          } else {
            if (plant) {
              Toast.show(t('toast.loaded_orders_plant', { count: stats.rendered, plant }), 'success');
            } else {
              Toast.show(t('toast.loaded_orders', { count: stats.rendered }), 'success');
            }
          }

          Persistence._saveCache();

          // Load master-data plants and lines in parallel (non-blocking).
          Promise.all([
            fetch(`${Config.API_BASE}/master-data/plants`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
            fetch(`${Config.API_BASE}/master-data/production_lines`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
          ]).then(([pData, lData]) => {
            if (pData || lData) {
              Store._state.masterData = {
                plants: pData?.rows ?? [],
                lines:  lData?.rows ?? [],
              };
              Store.emit({ type: 'master-data-changed', source: 'persistence' });
            }
          }).catch(e => {
            ErrorLog.warn('persistence', `Master-data fetch failed: ${e.message}`);
            Toast.show(t('toast.master_data_unavail'), 'warn', 5000);
          });
        })
        .catch(err => {
          stats.errors++;
          ErrorLog.error('persistence', `Backend fetch failed: ${err.message}`);
          // Only fall back to cache / demo if we never got a successful response.
          if (stats.source !== 'backend') {
            if (Persistence._loadCache()) {
              stats.source = 'cache';
              Toast.show(t('toast.backend_unreachable_cache'), 'warn', 5000);
            } else {
              Persistence._loadDemo();
              stats.source = 'demo';
            }
            stats.rendered = Store.tasksArr.length;
            // Start polling /health with exponential backoff so the UI recovers
            // automatically once the server comes back up.
            try { Persistence._reconnect.start(); } catch (e) {
              ErrorLog.warn('persistence', `Reconnect watcher failed to start: ${e.message}`);
            }
          }
        });
    },

    // Reconnect watcher: polls /health with exponential backoff (1s, 2s, 4s, ..., capped 30s)
    // until the backend responds, then triggers a force-reload of /tasks.
    _reconnect: {
      attempts: 0,
      timer:    null,
      running:  false,
      start() {
        if (this.running) return;
        this.running = true;
        this.attempts = 0;
        const tick = () => {
          this.attempts++;
          Util.fetchTraced(`${Config.API_BASE}/health`, { signal: AbortSignal.timeout(4000) })
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then(() => {
              this.running = false;
              this.attempts = 0;
              this.timer = null;
              ErrorLog.info('persistence', 'Backend recovered — reloading');
              Toast.show(t('toast.backend_recovered'), 'success', 3000);
              try { Persistence.load({ force: true }); } catch (e) {
                ErrorLog.error('persistence', `Reload after reconnect failed: ${e.message}`);
              }
            })
            .catch(() => {
              const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts - 1, 5));
              this.timer = setTimeout(tick, delay);
            });
        };
        this.timer = setTimeout(tick, 1000);
      },
      stop() {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        this.running = false;
        this.attempts = 0;
      },
    },

    _prepTask(raw) {
      // Coerce date-like string fields to Date.
      for (const k of Object.keys(raw)) {
        if (k.toLowerCase().includes('date') && typeof raw[k] === 'string') {
          raw[k] = Util.parseDate(raw[k]);
        }
      }
      return raw;
    },

    // Apply user-explicitly-moved positions from the localStorage cache back onto
    // freshly-fetched backend tasks. Only tasks where the cached start_date differs
    // from the cached original_start_date are overlaid — those are the ones the user
    // has consciously dragged beyond the auto-snap baseline. This prevents
    // _snapToWorkingHours from re-snapping user placements over blackout blocks.
    _overlayUserMoves(backendTasks, cachedTasks) {
      const byId = new Map(cachedTasks.map(t => [t.id, t]));
      for (const t of backendTasks) {
        const cached = byId.get(t.id);
        if (!cached) continue;
        const cs  = Util.parseDate(cached.start_date);
        const ce  = Util.parseDate(cached.end_date);
        const cos = Util.parseDate(cached.original_start_date);
        if (!(cs instanceof Date) || !(ce instanceof Date)) continue;
        if (!(cos instanceof Date) || cs.getTime() === cos.getTime()) continue;
        t.start_date = cs;
        t.end_date   = ce;
        t.original_start_date = cos;
        const coe = Util.parseDate(cached.original_end_date);
        if (coe instanceof Date) t.original_end_date = coe;
      }
    },

    // SAP gives us date-only `BASIC_START_DATE`s, which parse to 00:00:00. On lines
    // that don't run nights, every freshly ingested order would trip an
    // out-of-hours alert and show a misleading "shifted from SAP" variance once
    // a user (or autoReflow) moved it to a feasible slot. Walk each line in SAP
    // order and snap each unfixed task to the first feasible working window via
    // `Calendar.nextAvailable`, chaining with a per-line cursor so same-day
    // orders sequence after each other instead of all stacking at 07:00. Reset
    // `original_*_date` to the snapped instant so the variance badge baseline
    // reflects the feasible plan, not the midnight artifact.
    _snapToWorkingHours(tasks) {
      const byLine = new Map();
      for (const t of tasks) {
        const line = t.PRODUCTION_LINE;
        if (!line) continue;
        if (!byLine.has(line)) byLine.set(line, []);
        byLine.get(line).push(t);
      }

      let snappedCount = 0;
      for (const [line, group] of byLine) {
        group.sort((a, b) => {
          const ad = a.BASIC_START_DATE instanceof Date ? a.BASIC_START_DATE : a.start_date;
          const bd = b.BASIC_START_DATE instanceof Date ? b.BASIC_START_DATE : b.start_date;
          const at = ad?.getTime ? ad.getTime() : 0;
          const bt = bd?.getTime ? bd.getTime() : 0;
          return at - bt;
        });

        let cursor = null;
        for (const t of group) {
          if (!(t.start_date instanceof Date) || !(t.end_date instanceof Date)) continue;
          const durationMs = t.end_date.getTime() - t.start_date.getTime();
          if (durationMs <= 0) continue;

          if (t.fixed) {
            if (!cursor || t.end_date > cursor) cursor = new Date(t.end_date);
            continue;
          }

          // Backend has a scheduled_start/end persisted for this task — the user
          // owns its position. Never re-snap on load; alerts will flag any
          // blackout overlap so the user can resolve it deliberately.
          if (t.user_scheduled) {
            if (!cursor || t.end_date > cursor) cursor = new Date(t.end_date);
            continue;
          }

          // User has moved or resized this task since ingest — preserve the deliberate
          // placement (including intentional overlaps and duration changes) and just
          // advance the cursor so SAP-raw neighbors still sequence after it.
          const oStart = t.original_start_date instanceof Date ? t.original_start_date : null;
          const oEnd   = t.original_end_date   instanceof Date ? t.original_end_date   : null;
          const startMoved = oStart && t.start_date.getTime() !== oStart.getTime();
          const endMoved   = oEnd   && t.end_date.getTime()   !== oEnd.getTime();
          if (startMoved || endMoved) {
            if (!cursor || t.end_date > cursor) cursor = new Date(t.end_date);
            continue;
          }

          // No original baseline on record AND start is already non-midnight → task was
          // previously snapped or user-placed (e.g. backend returned a user-saved time
          // but doesn't persist original_start_date). Preserve it; Alerts will flag overlaps.
          const isMidnight = t.start_date.getHours() === 0 &&
                             t.start_date.getMinutes() === 0 &&
                             t.start_date.getSeconds() === 0;
          if (!oStart && !isMidnight) {
            if (!cursor || t.end_date > cursor) cursor = new Date(t.end_date);
            continue;
          }

          const from = (cursor && cursor > t.start_date) ? cursor : t.start_date;
          const snappedStart = Calendar.nextAvailable(line, from, durationMs);
          if (!(snappedStart instanceof Date)) continue;
          const snappedEnd = new Date(snappedStart.getTime() + durationMs);

          if (snappedStart.getTime() !== t.start_date.getTime()) snappedCount++;
          t.start_date = snappedStart;
          t.end_date   = snappedEnd;
          t.original_start_date = new Date(snappedStart);
          t.original_end_date   = new Date(snappedEnd);
          cursor = new Date(snappedEnd);
        }
      }

      if (snappedCount) {
        ErrorLog.info('persistence',
          `Snapped ${snappedCount} ingested order(s) to first available working slot per line`);
      }
    },

    _loadCache() {
      let raw;
      try { raw = localStorage.getItem(Config.LS_KEY); }
      catch (e) { ErrorLog.error('persistence', `localStorage unavailable: ${e.message}`); return false; }
      if (!raw) return false;

      let data;
      try { data = JSON.parse(raw); }
      catch (e) {
        ErrorLog.error('persistence', `Cache JSON parse failed (${raw.length} bytes) — quarantining and clearing`);
        Persistence._quarantineCache(raw);
        try { localStorage.removeItem(Config.LS_KEY); } catch {}
        return false;
      }

      if (data?._schemaVersion !== undefined && data._schemaVersion !== Config.SCHEMA_VERSION) {
        ErrorLog.warn('persistence',
          `Cache schema mismatch (cached=${data._schemaVersion}, expected=${Config.SCHEMA_VERSION}) — discarding`);
        try { localStorage.removeItem(Config.LS_KEY); } catch {}
        return false;
      }

      if (data?._buildId && Config.BUILD_ID && data._buildId !== Config.BUILD_ID) {
        ErrorLog.info('persistence',
          `Cache from prior build ${data._buildId} → current ${Config.BUILD_ID} (kept; schema match)`);
      }

      if (!data || !Array.isArray(data.tasks)) {
        ErrorLog.warn('persistence', 'Cache shape invalid — discarding');
        try { localStorage.removeItem(Config.LS_KEY); } catch {}
        return false;
      }

      try {
        const tasks = data.tasks.map(Persistence._prepTask);
        // Restore all non-task state first so alerts compute with correct context
        Persistence._restoreNonTaskState(data);
        // Sync plant from task data for any lines not yet in lineSettings
        for (const t of tasks) {
          const line = t.PRODUCTION_LINE;
          if (!line || !t.PLANT) continue;
          Store.ensureLineSettings(line);
          if (!Store._state.lineSettings[line].plant) {
            Store._state.lineSettings[line].plant = t.PLANT;
          }
        }
        Store.setTasks(tasks, 'persistence');
        for (const id of Store._state.fixedIds) {
          const t = Store.tasks[id]; if (t) t.fixed = true;
        }
        for (const t of tasks) {
          Store.ensureCalendar(t.PRODUCTION_LINE || 'Unknown');
          Store.ensureLineSettings(t.PRODUCTION_LINE || 'Unknown');
        }
        Alerts.scheduleRecompute();
        Toast.show(t('toast.loaded_cache', { count: tasks.length }), 'info');
        return true;
      } catch (e) { ErrorLog.error('persistence', `Cache load failed: ${e.message}`); return false; }
    },

    // Restore non-task user state from a cache snapshot. Called both from _loadCache()
    // and from the backend load path (where the backend owns task dates but localStorage
    // owns everything else: blocks, calendars, fixedIds, lineSettings, plants).
    _restoreNonTaskState(data) {
      if (data.lineSettings && Object.keys(data.lineSettings).length)
        Store._state.lineSettings = data.lineSettings;
      // Track add-vs-skip so we can surface a single user-facing summary if the
      // saved cache contained duplicate blocks (Store.addBlock will silently
      // refuse dups now — count them so the user knows the heal happened).
      const before = { line: Store._state.blocks.length, plant: Store._state.plantBlocks.length };
      let lineAttempts = 0, plantAttempts = 0;
      if (Array.isArray(data.blocks))
        for (const b of data.blocks) {
          lineAttempts++;
          Store.addBlock({ ...b, start: Util.parseDate(b.start), end: Util.parseDate(b.end) }, 'persistence');
        }
      if (data.calendars) Store._state.calendars = data.calendars;
      if (Array.isArray(data.fixedIds))
        Store._state.fixedIds = new Set(data.fixedIds.map(String));
      if (data.plants && Object.keys(data.plants).length) {
        Store._state.plants = data.plants;
        Config.KNOWN_PLANTS.forEach(p => Store.ensurePlant(p));
      } else {
        Config.KNOWN_PLANTS.forEach(p => Store.ensurePlant(p));
      }
      if (Array.isArray(data.plantBlocks))
        for (const b of data.plantBlocks) {
          plantAttempts++;
          Store.addPlantBlock({ ...b, start: Util.parseDate(b.start), end: Util.parseDate(b.end) }, 'persistence');
        }
      if (data.userSettings) Object.assign(Store._state.userSettings, data.userSettings);

      const lineDups  = lineAttempts  - (Store._state.blocks.length      - before.line);
      const plantDups = plantAttempts - (Store._state.plantBlocks.length - before.plant);
      const totalDups = lineDups + plantDups;
      if (totalDups > 0) {
        ErrorLog.warn?.('persistence', `Pruned ${totalDups} duplicate blackout block(s) from cache on load (line=${lineDups}, plant=${plantDups})`);
      }
    },

    _loadDemo() {
      const lines = ['Line 1', 'Line 2', 'Line 3', 'Line 4'];
      const colors = ['WHITE', 'IVORY', 'TAN', 'BROWN', 'CHARCOAL', 'BLACK'];
      const forms  = ['SM', 'MD', 'LG', 'XL'];
      const today = Util.startOfDay(new Date());
      const tasks = [];
      let id = 1;
      for (let day = 0; day < 5; day++) {
        const dayDate = new Date(today); dayDate.setDate(today.getDate() + day);
        for (const line of lines) {
          let cursor = new Date(dayDate); cursor.setHours(7, 0, 0, 0);
          const count = 4 + Math.floor(Math.random() * 4);
          for (let i = 0; i < count; i++) {
            const run = +(0.5 + Math.random() * 2.5).toFixed(2);
            const start = new Date(cursor);
            const end   = new Date(cursor.getTime() + run * 3600000);
            tasks.push({
              id: String(id),
              text: `ORD-${String(id).padStart(4, '0')}`,
              ORDER: `ORD-${id}`,
              PRODUCTION_LINE: line,
              COLOR: colors[(id + day) % colors.length],
              FORM_SIZE: forms[(id + day) % forms.length],
              MATERIAL_DESCRIPTION: `Product ${String.fromCharCode(65 + (id % 8))}-${100 + id}`,
              MATERIAL_NUMBER: `MAT-${1000 + id}`,
              'ORDER_QUANTITY_(GMEIN)': 500 + Math.round(Math.random() * 4000),
              RUN_TIME: run,
              BASIC_START_DATE: new Date(dayDate),
              BASIC_FINISH_DATE: new Date(dayDate.getTime() + 12 * 3600000),
              start_date: start,
              end_date:   end
            });
            cursor = end;
            id++;
          }
        }
      }
      // Fix a couple of example orders to showcase the feature.
      if (tasks.length > 6) {
        tasks[2].fixed = true;
        tasks[10].fixed = true;
      }
      Store.setTasks(tasks, 'persistence');
      // Calendars, plant, and line settings
      for (const line of lines) {
        Store.ensureCalendar(line);
        Store.ensureLineSettings(line);
      }
      Config.KNOWN_PLANTS.forEach(p => Store.ensurePlant(p));
      // Example blackout block (maintenance on Line 2 from 12:00-13:00 tomorrow)
      const tomNoon = new Date(today); tomNoon.setDate(today.getDate() + 1); tomNoon.setHours(12, 0, 0, 0);
      const tomOne  = new Date(tomNoon); tomOne.setHours(13, 0, 0, 0);
      Store.addBlock({ line: 'Line 2', start: tomNoon, end: tomOne, reason: 'Maintenance' }, 'persistence');
      Alerts.scheduleRecompute();
      Toast.show(t('toast.demo_mode', { count: tasks.length }), 'info');
    },

saveAll() {
      if (Sandbox.active) Sandbox.exit(true);
      Persistence._saveCache();

      // Only send tasks that changed since the last successful save. The backend
      // only persists start_date/end_date so fixed/line changes don't need to be
      // in this payload. tasks:bulk (reload/undo) clears _dirtyIds because Store
      // state came from a known-good source that doesn't need to be written back.
      const dirtyTasks = Persistence._dirtyIds.size > 0
        ? Store.tasksArr.filter(t => Persistence._dirtyIds.has(String(t.id)))
        : [];
      const body = JSON.stringify({ tasks: dirtyTasks, blocks: Store.blocks, calendars: Store.calendars });

      // Retry up to 3 times on network failures; don't retry 4xx (server rejections).
      const _post = (attempt) => fetch(`${Config.API_BASE}/tasks/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).then(async r => {
        if (!r.ok) {
          const bod = await r.json().catch(() => ({}));
          const msg = bod.message || bod.detail || `HTTP ${r.status}`;
          const err = new Error(msg); err.httpStatus = r.status; throw err;
        }
        return r.json();
      }).catch(e => {
        if (e.httpStatus || attempt >= 3) throw e;
        return new Promise(res => setTimeout(res, 2000)).then(() => _post(attempt + 1));
      });

      _post(1)
        .then(result => {
          Persistence._dirtyIds.clear();
          const persisted = result.persisted ?? 0;
          const total     = result.updated   ?? 0;
          if (persisted < total) {
            ErrorLog.warn('persistence', `Partial DB save: ${persisted}/${total} persisted`, result);
            Toast.show(t('toast.partial_db_save', { persisted, total }), 'warn', 6000);
          } else {
            ErrorLog.info('persistence', `Saved to backend (${persisted} tasks)`);
            Toast.show(t('toast.saved_to_backend'), 'success');
          }
        })
        .catch(e => {
          if (e.httpStatus) {
            ErrorLog.error('persistence', `Backend rejected save (${e.httpStatus}): ${e.message}`);
            Toast.show(t('toast.save_rejected', { msg: e.message }), 'error', 6000);
          } else {
            ErrorLog.warn('persistence', `Backend save failed: ${e.message}`);
            Toast.show(t('toast.saved_locally'), 'info');
          }
        });
    },

    /** Force a full reload from backend, bypassing cache. Returns the load Promise. */
    reload() {
      ErrorLog.info('persistence', 'Manual reload triggered — clearing dependencies');
      Store._state.dependencies = {};
      return Persistence.load({ force: true });
    },

    /** Fetch tasks for a specific plant, replacing whatever is currently in Store.
     *  Skips the fetch if that plant is already loaded. */
    loadForPlant(plant) {
      if (!plant || plant === Persistence._currentLoadedPlant) return Promise.resolve();
      Store._state.dependencies = {};
      return Persistence.load({ plant });
    },

    /** The plant the user last had selected, read straight from the cache so the
     *  boot load can scope to it (the backend is stateless — unscoped means
     *  fetching every plant's orders, which doesn't scale). null = none remembered. */
    _rememberedPlant() {
      try {
        const raw = localStorage.getItem(Config.LS_KEY);
        if (!raw) return null;
        return JSON.parse(raw)?.selectedPlant || null;
      } catch (_) { return null; }
    },

    /** Wipe the localStorage cache (user-initiated from the Log drawer). */
    clearCache() {
      try { localStorage.removeItem(Config.LS_KEY); ErrorLog.info('persistence', 'Cache cleared'); Toast.show(t('toast.cache_cleared'), 'success'); }
      catch (e) { ErrorLog.error('persistence', `Cache clear failed: ${e.message}`); }
    },

    _saveCache() {
      try {
        const snapshot = {
          _schemaVersion: Config.SCHEMA_VERSION,
          _buildId:       Config.BUILD_ID,
          _savedAt:       new Date().toISOString(),
          tasks:          Store.tasksArr,
          blocks:         Store.blocks,
          calendars:      Store.calendars,
          fixedIds:       [...Store.fixedIds],
          plants:         Store.plants,
          plantBlocks:    Store.plantBlocks,
          lineSettings:   Store.lineSettings,
          selectedPlant:  Store.selectedPlant,
          userSettings:   Store.userSettings
        };
        Persistence._writeCacheWithQuotaGuard(snapshot);
      } catch (e) {
        ErrorLog.warn('persistence', `Cache save failed: ${e.message}`);
      }
    },

    _writeCacheWithQuotaGuard(snapshot) {
      const baseMeta = {
        _schemaVersion: snapshot._schemaVersion,
        _buildId:       snapshot._buildId,
        _savedAt:       snapshot._savedAt,
      };
      const tiers = [
        snapshot,
        { ...snapshot, tasks: snapshot.tasks.slice(-2000) },
        { ...snapshot, tasks: snapshot.tasks.slice(-500) },
        { ...baseMeta,
          selectedPlant: snapshot.selectedPlant,
          lineSettings:  snapshot.lineSettings,
          fixedIds:      snapshot.fixedIds,
          tasks:         [] },
      ];
      for (let i = 0; i < tiers.length; i++) {
        try {
          const payload = JSON.stringify(tiers[i]);
          localStorage.setItem(Config.LS_KEY, payload);
          Persistence._lastCacheBytes = payload.length;
          Persistence._lastCacheAt    = Date.now();
          if (i > 0) {
            ErrorLog.warn('persistence',
              `Cache evicted to tier ${i} (${(payload.length / 1024).toFixed(1)} KB) due to quota pressure`);
            Persistence._cacheDegraded = true;
          } else {
            Persistence._cacheDegraded = false;
          }
          return true;
        } catch (e) {
          // Try next tier on QuotaExceededError; bail on anything else from tier 0
          if (i === 0 && e?.name !== 'QuotaExceededError' && e?.code !== 22) {
            ErrorLog.warn('persistence', `Cache write failed (${e.name}): ${e.message}`);
            return false;
          }
        }
      }
      ErrorLog.error('persistence', 'Cache write failed at all eviction tiers — autosave disabled this session');
      Persistence._autosaveDisabled = true;
      return false;
    },

    _quarantineCache(raw) {
      try {
        const key = `${Config.LS_KEY}.quarantine.${Date.now()}`;
        localStorage.setItem(key, raw.slice(0, 200_000));
        Persistence._lastQuarantineKey = key;
      } catch {}
    },

    storageInventory() {
      let total = 0, count = 0;
      const items = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const v = localStorage.getItem(k) || '';
          const bytes = (k.length + v.length) * 2;   // UTF-16 estimate
          total += bytes;
          count++;
          items.push({ key: k, bytes });
        }
      } catch (e) { ErrorLog.warn('persistence', `Inventory failed: ${e.message}`); }
      items.sort((a, b) => b.bytes - a.bytes);
      return {
        totalBytes:       total,
        count,
        items,
        degraded:         !!Persistence._cacheDegraded,
        lastBytes:        Persistence._lastCacheBytes || 0,
        lastSavedAt:      Persistence._lastCacheAt || 0,
        autosaveDisabled: !!Persistence._autosaveDisabled,
      };
    },

    /** Restore the persisted plant selection (if any). Called at boot once Store
     *  is populated enough to know what plants exist. Falls back to null when
     *  the persisted plant no longer matches a known plant. */
    restoreSelectedPlant() {
      try {
        const raw = localStorage.getItem(Config.LS_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        const saved = data?.selectedPlant;
        if (!saved) return;
        const known = Store.knownPlants();
        Store.setSelectedPlant(known.includes(saved) ? saved : null, 'restore');
      } catch (_) {
        // ignore — selectedPlant restore is best-effort
      }
    },

    _autosave: Util.debounce(() => {
      if (typeof Sandbox !== 'undefined' && Sandbox.active) return;
      if (Persistence._autosaveDisabled) return;
      Persistence._saveCache();
    }, 1200)
  };

  /* =============================================================================
     ADMIN COCKPIT — health bar, pipeline inspector, backend warnings,
     filterable logs, upload, purge, and upload history.
     ========================================================================== */
  const AdminCockpit = {
    _initialized: false,
    _pendingFile: null,
    _logFilter: { level: 'all', scope: 'all', search: '' },
    _backendLogFilter: { level: 'all' },
    _healthData: null,
    _deepData: null,
    _healthTimer: null,
    _pipelineOpen: null,
    _activeSub: 'overview',
    _activeOvTab: 'diagnostics',
    _dbDeepAbort: null,
    _backendLogAbort: null,

    gotoOvTab(tab) {
      AdminCockpit._activeOvTab = tab;
      document.querySelectorAll('.admin-ov-tabs .sub-subtab').forEach(b =>
        b.classList.toggle('active', b.dataset.ovTab === tab));
      ['diagnostics', 'data-ops', 'logs'].forEach(t => {
        const el = document.getElementById(`admin-ov-${t}`);
        if (el) el.hidden = (t !== tab);
      });
    },

    _setSub(sub) {
      AdminCockpit._activeSub = sub;
      document.querySelectorAll('.admin-subtab').forEach(b =>
        b.classList.toggle('active', b.dataset.sub === sub));
      const ov = document.getElementById('admin-overview-pane');
      const mg = document.getElementById('admin-manage-pane');
      if (ov) ov.hidden = (sub !== 'overview');
      if (mg) mg.hidden = (sub !== 'manage');
      if (sub === 'manage') MasterData.render();
      else AdminCockpit._renderOverview();
    },

    init() {
      if (AdminCockpit._initialized) return;
      AdminCockpit._initialized = true;

      document.querySelectorAll('.admin-subtab').forEach(b =>
        b.addEventListener('click', () => AdminCockpit._setSub(b.dataset.sub)));

      // Upload zone — drag-drop + click-browse
      const _uploadZone = document.getElementById('admin-upload-zone');
      const _uploadFile = document.getElementById('admin-upload-file');
      if (_uploadZone && _uploadFile) {
        _uploadZone.onclick    = e => { if (e.target !== _uploadFile) _uploadFile.click(); };
        _uploadZone.onkeydown  = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _uploadFile.click(); } };
        _uploadFile.onchange   = () => { if (_uploadFile.files[0]) AdminCockpit._pickFile(_uploadFile.files[0]); };
        _uploadZone.ondragover = e => { e.preventDefault(); _uploadZone.classList.add('drag-over'); };
        _uploadZone.ondragleave= () => _uploadZone.classList.remove('drag-over');
        _uploadZone.ondrop     = e => {
          e.preventDefault();
          _uploadZone.classList.remove('drag-over');
          const f = e.dataTransfer.files[0];
          if (f) AdminCockpit._pickFile(f);
        };
      }
      document.getElementById('admin-upload-clear')?.addEventListener('click', AdminCockpit._clearUpload);
      document.getElementById('admin-upload-btn')?.addEventListener('click', AdminCockpit._upload);
      document.getElementById('admin-purge-btn')?.addEventListener('click', AdminCockpit._purge);

      document.getElementById('admin-log-reload')?.addEventListener('click', () => Persistence.reload());
      document.getElementById('admin-log-cache')?.addEventListener('click', () => Persistence.clearCache());
      document.getElementById('admin-log-copy')?.addEventListener('click', () => ErrorLog.copy());
      document.getElementById('admin-log-copy-filtered')?.addEventListener('click', () => AdminCockpit._copyFiltered());
      document.getElementById('admin-log-clear')?.addEventListener('click', () => {
        ErrorLog.clear();
        AdminCockpit._renderLogs();
      });

      document.getElementById('admin-audit-reload')?.addEventListener('click', AdminCockpit._renderAudit);
      document.getElementById('admin-audit-clear')?.addEventListener('click', AdminCockpit._clearAudit);
      document.getElementById('admin-audit-log-reload')?.addEventListener('click', AdminCockpit._renderAuditLog);
      document.getElementById('admin-audit-log-clear')?.addEventListener('click', AdminCockpit._clearAuditLog);
      document.getElementById('admin-health-refresh')?.addEventListener('click', AdminCockpit._renderHealth);
      document.getElementById('admin-pipeline-refresh')?.addEventListener('click', AdminCockpit._renderPipeline);
      document.getElementById('admin-db-deep-refresh')?.addEventListener('click', AdminCockpit._renderDbDeep);
      document.getElementById('admin-backend-log-refresh')?.addEventListener('click', AdminCockpit._renderBackendLog);
      document.getElementById('admin-backend-log-clear')?.addEventListener('click', AdminCockpit._clearBackendLog);
      document.getElementById('admin-backend-log-filter-level')?.addEventListener('change', e => {
        AdminCockpit._backendLogFilter.level = e.target.value;
        AdminCockpit._renderBackendLog();
      });

      // Filter controls
      document.getElementById('admin-log-filter-level')?.addEventListener('change', e => {
        AdminCockpit._logFilter.level = e.target.value;
        AdminCockpit._renderLogs();
      });
      document.getElementById('admin-log-filter-scope')?.addEventListener('change', e => {
        AdminCockpit._logFilter.scope = e.target.value;
        AdminCockpit._renderLogs();
      });
      document.getElementById('admin-log-search')?.addEventListener('input', e => {
        AdminCockpit._logFilter.search = e.target.value.toLowerCase();
        AdminCockpit._renderLogs();
      });

      ErrorLog.subscribe(() => {
        const panel = document.getElementById('admin-tab');
        if (panel?.classList.contains('active')) {
          AdminCockpit._renderLogs();
        }
      });

      Store.subscribe(evt => {
        if (evt.type === 'tasks:bulk') {
          const panel = document.getElementById('admin-tab');
          if (panel?.classList.contains('active')) {
            // Defer so Persistence._lastLoad stats are fully written before rendering.
            setTimeout(() => AdminCockpit._renderPipeline(), 50);
          }
        }
      });

      document.addEventListener('mouseover', e => {
        const el = e.target.closest?.('.adm-help');
        if (!el) return;
        const r = el.getBoundingClientRect();
        el.style.setProperty('--tip-x', `${r.left + r.width / 2}px`);
        el.style.setProperty('--tip-y', `${r.top}px`);
      });
    },

    render() {
      AdminCockpit._setSub('overview');
      AdminCockpit._renderOverview();
    },

    _renderOverview() {
      AdminCockpit._renderPurgeMeta();
      AdminCockpit._renderHealth();
      AdminCockpit._renderDiagnostics();
      AdminCockpit._renderPipeline();
      AdminCockpit._renderDbDeep();
      AdminCockpit._renderBackendLog();
      AdminCockpit._renderLogs();
      AdminCockpit._renderAudit();
      AdminCockpit._renderAuditLog();
      AdminCockpit._startHealthPolling();
    },

    _startHealthPolling() {
      if (AdminCockpit._healthTimer) return;
      AdminCockpit._healthTimer = setInterval(() => {
        if (document.getElementById('admin-tab')?.classList.contains('active')) {
          AdminCockpit._renderHealth();
        }
      }, 30_000);
    },

    _stopHealthPolling() {
      if (AdminCockpit._healthTimer) {
        clearInterval(AdminCockpit._healthTimer);
        AdminCockpit._healthTimer = null;
      }
    },

    _renderHealth() {
      AdminCockpit._healthAbort?.abort();
      AdminCockpit._healthAbort = new AbortController();
      const sig = AbortSignal.any
        ? AbortSignal.any([AdminCockpit._healthAbort.signal, AbortSignal.timeout(6000)])
        : AdminCockpit._healthAbort.signal;
      Util.fetchTraced(`${Config.API_BASE}/health`, { signal: sig })
        .then(r => r.json())
        .then(data => {
          AdminCockpit._healthData = data;
          const db = data.db || {};
          const mem = data.memory || {};
          const cw = data.color_wheel || {};

          const dbEl = document.getElementById('admin-health-db');
          if (dbEl) {
            const dot = dbEl.querySelector('.admin-health-dot');
            const lbl = dbEl.querySelector('.admin-health-label');
            const cls = !db.connected ? 'err' : db.ping_ms > 500 ? 'warn' : 'ok';
            dot.className = `admin-health-dot ${cls}`;
            lbl.textContent = db.connected
              ? `DB ${db.ping_ms}ms`
              : `DB offline${db.error ? ': ' + db.error.slice(0, 60) : ''}`;
          }

          const ordEl = document.getElementById('admin-health-orders');
          if (ordEl) {
            ordEl.querySelector('.admin-health-label').textContent =
              `${(db.total_orders ?? 0).toLocaleString()} orders`;
          }

          const ovEl = document.getElementById('admin-health-overrides');
          if (ovEl) {
            ovEl.querySelector('.admin-health-label').textContent =
              `${(db.user_overrides ?? 0).toLocaleString()} user overrides`;
          }

          const cwEl = document.getElementById('admin-health-color');
          if (cwEl) {
            const dot = cwEl.querySelector('.admin-health-dot');
            const lbl = cwEl.querySelector('.admin-health-label');
            const misses = cw.misses ?? 0;
            dot.className = `admin-health-dot ${misses > 0 ? 'warn' : 'ok'}`;
            lbl.textContent = misses > 0
              ? t('ui.color_wheel_miss', { count: misses, plural: misses === 1 ? '' : 'es' })
              : t('ui.color_wheel_all_matched');
          }

          const poolChip = document.getElementById('admin-health-pool');
          if (poolChip) {
            const pPool = data.pool || {};
            const dot  = poolChip.querySelector('.admin-health-dot');
            const plbl = poolChip.querySelector('.admin-health-label');
            if (pPool.error) {
              if (dot) dot.className = 'admin-health-dot warn';
              if (plbl) plbl.textContent = t('ui.pool_unavailable');
            } else {
              const used = (pPool.pool_size ?? 0) - (pPool.pool_available ?? 0);
              const max  = pPool.pool_max || 1;
              const pct  = Math.round(100 * used / max);
              const cls  = pct >= 85 ? 'err' : (pct >= 60 ? 'warn' : 'ok');
              if (dot) dot.className = `admin-health-dot ${cls}`;
              if (plbl) plbl.textContent = `Pool ${used}/${max}`;
            }
          }

          const ldEl = document.getElementById('admin-health-loaded');
          if (ldEl) {
            const lbl = ldEl.querySelector('.admin-health-label');
            const loadedAt = mem.loaded_at ? new Date(mem.loaded_at) : null;
            lbl.textContent = loadedAt
              ? `Loaded ${AdminCockpit._relTime(loadedAt)}${mem.load_ms != null ? ' · ' + mem.load_ms + 'ms' : ''}`
              : t('ui.not_loaded');
          }
        })
        .catch(e => {
          const dbEl = document.getElementById('admin-health-db');
          if (dbEl) {
            const dot = dbEl.querySelector('.admin-health-dot');
            const lbl = dbEl.querySelector('.admin-health-label');
            dot.className = 'admin-health-dot err';
            lbl.textContent = t('ui.backend_unreachable');
          }
          if (e.name !== 'AbortError') ErrorLog.warn('admin', `Health check failed: ${e.message}`);
        });
    },

    _renderPipeline() {
      const wrap = document.getElementById('admin-pipeline');
      if (!wrap) return;

      AdminCockpit._pipelineAbort?.abort();
      AdminCockpit._pipelineAbort = new AbortController();
      const sig = AbortSignal.any
        ? AbortSignal.any([AdminCockpit._pipelineAbort.signal, AbortSignal.timeout(8000)])
        : AdminCockpit._pipelineAbort.signal;
      Util.fetchTraced(`${Config.API_BASE}/diagnostics/deep`, { signal: sig })
        .then(r => r.json())
        .then(data => {
          AdminCockpit._deepData = data;
          const p = data.pipeline || {};
          const dbSt = data.db_stats || {};
          const cw = data.color_wheel || {};
          const st = Persistence.stats ? Persistence.stats() : {};

          const rendered   = st.rendered ?? 0;
          const rawDb      = p.raw_row_count ?? dbSt.total ?? 0;
          const activePlant = st.plant ?? null;
          // Color-merge stats come from the last /tasks response (per-request,
          // plant-scoped) — not /diagnostics/deep, which holds load-time defaults.
          const colorMiss  = st.color_merge_misses ?? 0;
          // received = rows after both plant filter + color merge (what UI got)
          const received   = st.raw_received ?? 0;
          // Rows entering color merge = post-plant-filter count (= received + misses)
          const preMerge   = st.pre_color_merge_count ?? (received + colorMiss);
          // Rows removed by plant filter = raw - what entered color merge
          const plantFiltered = activePlant ? Math.max(0, rawDb - preMerge) : 0;
          const gap = received - rendered;

          // Pipeline order: DB → [Plant filter if active] → Color Merge → Emitted → Rendered.
          // Reordered (May 2026) so color-miss counts are plant-scoped — the merge
          // now runs *after* the plant filter, against only the rows the user will see.
          const steps = [
            {
              key: 'db',
              label: 'DB Load',
              count: rawDb,
              delta: null,
              status: p.dropped_no_start_date > 0 ? 'warn' : 'ok',
              detail: () => AdminCockpit._pipelineDetailDB(p, dbSt),
            },
            ...(activePlant ? [{
              key: 'plant-filter',
              label: `Plant ${activePlant}`,
              count: preMerge,
              delta: plantFiltered > 0 ? `-${plantFiltered} (other plants)` : null,
              status: 'ok',
              detail: () => AdminCockpit._pipelineDetailPlantFilter(st, plantFiltered, rawDb),
            }] : []),
            {
              key: 'color',
              label: 'Color Merge',
              count: received,
              delta: colorMiss > 0 ? `-${colorMiss} miss${colorMiss === 1 ? '' : 'es'}` : null,
              status: colorMiss > 0 ? 'warn' : 'ok',
              detail: () => AdminCockpit._pipelineDetailColor(p, cw, st),
            },
            {
              key: 'emitted',
              label: 'Emitted',
              count: received,
              delta: null,
              status: p.warnings?.length > 0 ? 'warn' : 'ok',
              detail: () => AdminCockpit._pipelineDetailEmitted(p, st),
            },
            {
              key: 'rendered',
              label: 'Rendered',
              count: rendered,
              delta: gap > 0 ? `-${gap} gap` : null,
              status: gap > 0 ? 'err' : 'ok',
              detail: () => AdminCockpit._pipelineDetailRendered(st, p),
            },
          ];

          wrap.textContent = '';
          steps.forEach((s, i) => {
            if (i > 0) {
              const arrow = document.createElement('span');
              arrow.className = 'admin-pipeline-arrow';
              arrow.textContent = '→';
              wrap.appendChild(arrow);
            }
            const box = document.createElement('div');
            box.className = `admin-pipeline-step ${s.status}`;
            box.dataset.key = s.key;

            const cnt = document.createElement('div');
            cnt.className = 'admin-pipeline-step-count';
            cnt.textContent = s.count.toLocaleString();
            box.appendChild(cnt);

            const lbl = document.createElement('div');
            lbl.className = 'admin-pipeline-step-label';
            lbl.textContent = s.label;
            box.appendChild(lbl);

            if (s.delta) {
              const delta = document.createElement('div');
              delta.className = 'admin-pipeline-delta';
              delta.textContent = s.delta;
              box.appendChild(delta);
            }

            box.addEventListener('click', () => {
              const detail = document.getElementById('admin-pipeline-detail');
              if (!detail) return;
              if (AdminCockpit._pipelineOpen === s.key) {
                AdminCockpit._pipelineOpen = null;
                detail.classList.remove('open');
                detail.textContent = '';
              } else {
                AdminCockpit._pipelineOpen = s.key;
                detail.classList.add('open');
                detail.textContent = '';
                detail.appendChild(s.detail());
              }
            });

            wrap.appendChild(box);
          });

          // Backend warnings
          AdminCockpit._renderBackendWarnings(p.warnings || []);
        })
        .catch(e => {
          if (e.name === 'AbortError') return;
          wrap.innerHTML = `<div class="admin-log-empty">Could not load pipeline: ${e.message}</div>`;
          ErrorLog.warn('admin', `Pipeline fetch failed: ${e.message}`);
        });
    },

    _pipelineDetailDB(p, dbSt) {
      const frag = document.createDocumentFragment();
      const head = document.createElement('div');
      head.className = 'admin-pdtl-head';
      head.textContent = t('ui.db_load_details');
      frag.appendChild(head);

      const rows = [
        [t('ui.diag_total_in_db'), (dbSt.total ?? '—').toLocaleString()],
        [t('ui.diag_null_start_date'), dbSt.null_start ?? '—'],
        [t('ui.diag_null_end_date'), dbSt.null_end ?? '—'],
        [t('ui.diag_null_color'), dbSt.null_color ?? '—'],
        [t('ui.diag_null_line'), dbSt.null_line ?? '—'],
        [t('ui.diag_null_desc'), dbSt.null_desc ?? '—'],
        [t('ui.diag_null_runtime'), dbSt.null_runtime ?? '—'],
        [t('ui.diag_date_range_min'), dbSt.date_range?.min?.slice(0, 10) ?? '—'],
        [t('ui.diag_date_range_max'), dbSt.date_range?.max?.slice(0, 10) ?? '—'],
        [t('ui.diag_dropped_no_start'), p.dropped_no_start_date ?? 0],
        [t('ui.diag_load_time'), p.load_ms != null ? p.load_ms + ' ms' : '—'],
      ];

      if (dbSt.by_line && Object.keys(dbSt.by_line).length) {
        const lbl = document.createElement('div');
        lbl.className = 'admin-pdtl-sub';
        lbl.textContent = t('ui.orders_by_line');
        frag.appendChild(AdminCockpit._kvTable(rows));
        frag.appendChild(lbl);
        frag.appendChild(AdminCockpit._lineBar(dbSt.by_line));
        return frag;
      }

      frag.appendChild(AdminCockpit._kvTable(rows));
      return frag;
    },

    _pipelineDetailColor(p, cw, st) {
      const frag = document.createDocumentFragment();
      const head = document.createElement('div');
      head.className = 'admin-pdtl-head';
      const scope = st?.plant ? ` (${t('ui.plant_prefix')} ${st.plant})` : '';
      head.textContent = t('ui.color_wheel_details') + scope;
      frag.appendChild(head);

      // Misses are now plant-scoped — pulled from the last /tasks meta via Persistence stats.
      const requestMiss = st?.color_merge_misses ?? 0;
      const requestMissed = st?.missed_colors ?? [];
      const requestMs = st?.backend_meta?.color_merge_ms;

      const rows = [
        [t('ui.diag_scope'), st?.plant ? `${t('ui.plant_prefix')} ${st.plant} only` : t('ui.all_plants')],
        [t('ui.diag_rows_entering_merge'), st?.pre_color_merge_count ?? '—'],
        [t('ui.diag_global_wheel_colors'), cw.wheel_total ?? '—'],
        [t('ui.diag_matched_rows'), (st?.pre_color_merge_count ?? 0) - requestMiss],
        [t('ui.diag_missed_rows'), requestMiss],
        [t('ui.diag_merge_time'), requestMs != null ? requestMs + ' ms' : '—'],
      ];
      frag.appendChild(AdminCockpit._kvTable(rows));

      if (requestMissed.length) {
        const sub = document.createElement('div');
        sub.className = 'admin-pdtl-sub';
        sub.textContent = t('ui.unmatched_colors', { count: requestMissed.length });
        frag.appendChild(sub);
        const chips = document.createElement('div');
        chips.className = 'admin-pdtl-chips';
        for (const c of requestMissed) {
          const chip = document.createElement('span');
          chip.className = 'admin-pdtl-chip warn';
          chip.textContent = c;
          chips.appendChild(chip);
        }
        frag.appendChild(chips);
      } else {
        const ok = document.createElement('div');
        ok.className = 'admin-pdtl-ok';
        ok.textContent = t('empty.no_colors_matched');
        frag.appendChild(ok);
      }
      return frag;
    },

    _pipelineDetailEmitted(p, st) {
      const frag = document.createDocumentFragment();
      const head = document.createElement('div');
      head.className = 'admin-pdtl-head';
      head.textContent = t('ui.emitted_details');
      frag.appendChild(head);

      const scopeLbl = st?.plant ? `${t('ui.plant_prefix')} ${st.plant}` : t('ui.all_plants');
      const rows = [
        [t('ui.diag_raw_from_db'), p.raw_row_count ?? '—'],
        [t('ui.diag_dropped_no_start'), p.dropped_no_start_date ?? 0],
        [t('ui.diag_active_scope'), scopeLbl],
        [t('ui.diag_rows_entering_cmerge'), st?.pre_color_merge_count ?? '—'],
        [t('ui.diag_color_merge_misses'), st?.color_merge_misses ?? 0],
        [t('ui.diag_emitted'), st?.raw_received ?? '—'],
        [t('ui.diag_unique_ids'), p.unique_id_count ?? '—'],
        [t('ui.diag_loaded_at'), p.loaded_at ? p.loaded_at.replace('T', ' ').slice(0, 19) + ' UTC' : '—'],
      ];
      frag.appendChild(AdminCockpit._kvTable(rows));

      const warnings = p.warnings || [];
      if (warnings.length) {
        const sub = document.createElement('div');
        sub.className = 'admin-pdtl-sub';
        sub.textContent = t('ui.diag_backend_load_warnings', { count: warnings.length });
        frag.appendChild(sub);
        frag.appendChild(AdminCockpit._warningList(warnings));
      }
      return frag;
    },

    _pipelineDetailPlantFilter(st, plantFiltered, rawDb) {
      const frag = document.createDocumentFragment();
      const head = document.createElement('div');
      head.className = 'admin-pdtl-head';
      head.textContent = t('ui.plant_filter_details');
      frag.appendChild(head);

      // Pipeline order is now: DB → Plant filter → Color merge → Emitted.
      // The pre-merge count here is what reaches the color merge stage.
      const preMerge = st?.pre_color_merge_count ?? 0;
      const rows = [
        [t('ui.diag_active_plant'), st.plant ?? '—'],
        [t('ui.diag_raw_rows_from_db'), rawDb ?? '—'],
        [t('ui.diag_rows_this_plant'), preMerge],
        [t('ui.diag_other_plant_excluded'), plantFiltered],
        [t('ui.diag_final_emitted'), st.raw_received ?? '—'],
      ];
      frag.appendChild(AdminCockpit._kvTable(rows));
      return frag;
    },

    _pipelineDetailRendered(st, p) {
      const frag = document.createDocumentFragment();
      const head = document.createElement('div');
      head.className = 'admin-pdtl-head';
      head.textContent = t('ui.rendering_details');
      frag.appendChild(head);

      // Gap is measured from received (post-plant-filter) so plant filtering does not
      // look like data loss here.
      const received = st.raw_received ?? 0;
      const rendered = st.rendered ?? 0;
      const gap = received - rendered;
      const rows = [
        [t('ui.diag_received_by_ui'), received],
        [t('ui.diag_pl_filtered'), st.filtered_pl ?? 0],
        [t('ui.diag_null_id_dropped'), st.filtered_null_id ?? 0],
        [t('ui.diag_store_collisions'), st.dedup_collisions ?? 0],
        [t('ui.diag_rendered'), rendered],
        [t('ui.diag_gap'), gap],
        [t('ui.diag_source'), st.source ?? '—'],
      ];
      frag.appendChild(AdminCockpit._kvTable(rows));

      if (gap > 0) {
        const warn = document.createElement('div');
        warn.className = 'admin-pdtl-warn';
        warn.textContent = t('ui.data_gap_warn', { count: gap });
        frag.appendChild(warn);
      }
      return frag;
    },

    _kvTable(rows) {
      const tbl = document.createElement('table');
      tbl.className = 'admin-pdtl-tbl';
      for (const [k, v] of rows) {
        const tr = document.createElement('tr');
        const tdK = document.createElement('td');
        tdK.className = 'admin-pdtl-key';
        tdK.textContent = k;
        const tdV = document.createElement('td');
        tdV.className = 'admin-pdtl-val';
        tdV.textContent = String(v ?? '—');
        tr.appendChild(tdK);
        tr.appendChild(tdV);
        tbl.appendChild(tr);
      }
      return tbl;
    },

    _lineBar(byLine) {
      const wrap = document.createElement('div');
      wrap.className = 'admin-pdtl-linebars';
      const max = Math.max(...Object.values(byLine));
      for (const [line, cnt] of Object.entries(byLine)) {
        const row = document.createElement('div');
        row.className = 'admin-pdtl-linebar-row';
        const lbl = document.createElement('span');
        lbl.className = 'admin-pdtl-linebar-lbl';
        lbl.textContent = line;
        const bar = document.createElement('div');
        bar.className = 'admin-pdtl-linebar-track';
        const fill = document.createElement('div');
        fill.className = 'admin-pdtl-linebar-fill';
        fill.style.width = `${Math.round((cnt / max) * 100)}%`;
        const num = document.createElement('span');
        num.className = 'admin-pdtl-linebar-num';
        num.textContent = cnt;
        bar.appendChild(fill);
        row.appendChild(lbl);
        row.appendChild(bar);
        row.appendChild(num);
        wrap.appendChild(row);
      }
      return wrap;
    },

    _warningList(warnings) {
      const ul = document.createElement('div');
      ul.className = 'admin-bwarn-list';
      for (const w of warnings) {
        const row = document.createElement('div');
        row.className = `admin-bwarn-row admin-bwarn-${w.level || 'warn'}`;
        const lvl = document.createElement('span');
        lvl.className = 'admin-bwarn-lvl';
        lvl.textContent = (w.level || 'warn').toUpperCase();
        const msg = document.createElement('span');
        msg.className = 'admin-bwarn-msg';
        msg.textContent = w.msg || '';
        row.appendChild(lvl);
        row.appendChild(msg);
        ul.appendChild(row);
      }
      return ul;
    },

    _renderBackendWarnings(warnings) {
      const host = document.getElementById('admin-backend-warnings');
      const countEl = document.getElementById('admin-bwarn-count');
      if (!host) return;
      host.textContent = '';
      if (countEl) countEl.textContent = t('ui.bwarn_count', { count: warnings.length });

      if (!warnings.length) {
        const ok = document.createElement('div');
        ok.className = 'admin-bwarn-empty';
        ok.textContent = t('empty.no_backend_warnings');
        host.appendChild(ok);
        return;
      }

      for (const w of warnings) {
        const row = document.createElement('div');
        row.className = `admin-bwarn-row admin-bwarn-${w.level || 'warn'}`;
        row.style.cursor = w.context && Object.keys(w.context).length ? 'pointer' : '';

        const meta = document.createElement('div');
        meta.className = 'admin-bwarn-meta';
        const lvl = document.createElement('span');
        lvl.className = 'admin-bwarn-lvl';
        lvl.textContent = (w.level || 'warn').toUpperCase();
        const ts = document.createElement('span');
        ts.className = 'admin-bwarn-ts';
        ts.textContent = w.ts ? w.ts.replace('T', ' ').slice(0, 19) + ' UTC' : '';
        meta.appendChild(lvl);
        meta.appendChild(ts);

        const msg = document.createElement('div');
        msg.className = 'admin-bwarn-msg';
        msg.textContent = w.msg || '';

        row.appendChild(meta);
        row.appendChild(msg);

        if (w.context && Object.keys(w.context).length) {
          const pre = document.createElement('pre');
          pre.className = 'admin-bwarn-ctx';
          pre.style.display = 'none';
          pre.textContent = JSON.stringify(w.context, null, 2);
          row.appendChild(pre);
          row.addEventListener('click', () => {
            pre.style.display = pre.style.display === 'none' ? '' : 'none';
          });
        }

        host.appendChild(row);
      }
    },

    _updatePurgeCount() {
      const start = AdminCockpit._fpPurgeStart?.selectedDates[0];
      const end   = AdminCockpit._fpPurgeEnd?.selectedDates[0];
      const el    = document.getElementById('admin-past-count');
      if (!el) return;
      if (!start || !end) { el.textContent = ''; return; }
      const endOfDay = new Date(end); endOfDay.setHours(23, 59, 59, 999);
      const count = (Store.tasksArr || []).filter(t => t.end_date && t.end_date >= start && t.end_date <= endOfDay).length;
      el.innerHTML = count > 0
        ? `<strong style="color:var(--err,#c0392b)">${t('ui.orders_in_range', {count, plural: count === 1 ? '' : 's'})}</strong>`
        : `<span style="color:var(--text-muted,#888)">${t('ui.orders_in_range', {count: 0, plural: 's'})}</span>`;
    },

    _renderPurgeMeta() {
      const yesterday   = new Date(); yesterday.setDate(yesterday.getDate() - 1);
      const twoWeeksAgo = new Date(); twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
      if (!AdminCockpit._fpPurgeStart) {
        AdminCockpit._fpPurgeStart = flatpickr('#admin-purge-start', {
          dateFormat: 'Y-m-d', altInput: true, altFormat: 'M j, Y',
          onChange: () => AdminCockpit._updatePurgeCount(),
        });
        AdminCockpit._fpPurgeEnd = flatpickr('#admin-purge-end', {
          dateFormat: 'Y-m-d', altInput: true, altFormat: 'M j, Y',
          onChange: () => AdminCockpit._updatePurgeCount(),
        });
      }
      AdminCockpit._fpPurgeStart.setDate(twoWeeksAgo, false);
      AdminCockpit._fpPurgeEnd.setDate(yesterday, false);
      AdminCockpit._updatePurgeCount();
    },

    _setStatus(el, text, kind) {
      if (!el) return;
      el.textContent = text;
      el.className = 'admin-status' + (kind ? ' ' + kind : '');
    },

    _pickFile(file) {
      if (!file) return;
      AdminCockpit._pendingFile = file;
      document.getElementById('admin-upload-info').hidden = false;
      document.getElementById('admin-upload-actions').hidden = false;
      document.getElementById('admin-upload-fname').textContent = file.name;
      document.getElementById('admin-upload-fsize').textContent =
        file.size < 1_048_576
          ? `${(file.size / 1024).toFixed(1)} KB`
          : `${(file.size / 1_048_576).toFixed(1)} MB`;
      const status = document.getElementById('admin-upload-status');
      if (status) { status.textContent = ''; status.className = 'admin-status'; }
    },

    _clearUpload() {
      AdminCockpit._pendingFile = null;
      const fi = document.getElementById('admin-upload-file');
      if (fi) fi.value = '';
      const info    = document.getElementById('admin-upload-info');
      const actions = document.getElementById('admin-upload-actions');
      const status  = document.getElementById('admin-upload-status');
      if (info)    info.hidden = true;
      if (actions) actions.hidden = true;
      if (status)  { status.textContent = ''; status.className = 'admin-status'; }
    },

    _upload() {
      const f      = AdminCockpit._pendingFile;
      const status = document.getElementById('admin-upload-status');
      const zone   = document.getElementById('admin-upload-zone');
      const btn    = document.getElementById('admin-upload-btn');
      if (!f) {
        AdminCockpit._setStatus(status, t('toast.pick_xlsx_first'), 'warn');
        return;
      }
      if (zone) zone.classList.add('uploading');
      if (btn)  btn.disabled = true;
      AdminCockpit._setStatus(status, t('toast.uploading_file', { name: f.name }), 'info');
      const fd = new FormData();
      fd.append('file', f);
      fetch(`${Config.API_BASE}/upload`, { method: 'POST', body: fd })
        .then(r => r.json().then(j => ({ ok: r.ok, body: j })))
        .then(({ ok, body }) => {
          if (zone) zone.classList.remove('uploading');
          if (btn)  btn.disabled = false;
          if (!ok || body.status !== 'ok') {
            const msg = body?.message || 'HTTP error';
            AdminCockpit._setStatus(status, t('toast.upload_failed', { msg }), 'error');
            ErrorLog.error('admin', `Upload failed: ${msg}`, body);
            return;
          }
          const warnCount = body.warnings?.length ?? 0;
          const w = warnCount ? ` (${warnCount} warning${warnCount === 1 ? '' : 's'})` : '';
          AdminCockpit._setStatus(
            status,
            `✓ Inserted ${body.inserted}, updated ${body.updated} of ${body.raw_row_count} rows${w}`,
            'success'
          );
          ErrorLog.info('admin',
            `Upload OK: inserted=${body.inserted} updated=${body.updated} batch=${body.batch_id}`, body);
          if (warnCount) {
            ErrorLog.warn('admin', `Upload had ${warnCount} warning(s)`, body.warnings);
          }
          Toast.show(t('toast.upload_ok', { count: body.inserted + body.updated }), 'success');
          setTimeout(() => AdminCockpit._clearUpload(), 2000);
          Persistence.reload().then(() => {
            AdminCockpit._renderHealth();
            AdminCockpit._renderPipeline();
          });
          AdminCockpit._renderAudit();
        })
        .catch(e => {
          if (zone) zone.classList.remove('uploading');
          if (btn)  btn.disabled = false;
          AdminCockpit._setStatus(status, t('toast.upload_failed', { msg: e.message }), 'error');
          ErrorLog.error('admin', `Upload network error: ${e.message}`);
        });
    },

    async _purge() {
      const startEl = document.getElementById('admin-purge-start');
      const endEl   = document.getElementById('admin-purge-end');
      const status  = document.getElementById('admin-purge-status');
      const start = startEl?.value;
      const end   = endEl?.value;
      if (!start || !end) {
        AdminCockpit._setStatus(status, t('toast.pick_purge_dates'), 'warn');
        return;
      }
      if (start > end) {
        AdminCockpit._setStatus(status, t('toast.purge_start_before_end'), 'warn');
        return;
      }
      const ok = await Modal.confirm({ title: t('modal.purge_confirm', { start, end }), confirmLabel: t('btn.yes_delete') });
      if (!ok) return;

      AdminCockpit._setStatus(status, t('toast.purging', { start, end }), 'info');
      fetch(`${Config.API_BASE}/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_date: start + 'T00:00:00', end_date: end + 'T23:59:59' })
      })
        .then(r => r.json())
        .then(body => {
          if (body.status !== 'ok') {
            AdminCockpit._setStatus(status, t('toast.purge_failed', { msg: body.message || 'unknown' }), 'error');
            ErrorLog.error('admin', `Purge failed: ${body.message || 'unknown'}`, body);
            return;
          }
          AdminCockpit._setStatus(status, `✓ Deleted ${body.deleted} order${body.deleted === 1 ? '' : 's'}`, 'success');
          ErrorLog.info('admin', `Purge: deleted ${body.deleted} (${start} → ${end})`);
          Toast.show(t('toast.purge_ok', { count: body.deleted }), 'success');
          Persistence.reload().then(() => {
            AdminCockpit._renderHealth();
            AdminCockpit._renderPipeline();
          });
        })
        .catch(e => {
          AdminCockpit._setStatus(status, t('toast.purge_failed', { msg: e.message }), 'error');
          ErrorLog.error('admin', `Purge network error: ${e.message}`);
        });
    },

    _getFilteredEntries() {
      const { level, scope, search } = AdminCockpit._logFilter;
      return ErrorLog.entries().filter(e => {
        if (level !== 'all' && e.level !== level) return false;
        if (scope !== 'all' && e.scope !== scope) return false;
        if (search) {
          const haystack = `${e.scope} ${e.msg} ${e.ts}`.toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        return true;
      });
    },

    /* -----------------------------------------------------------------------
       DB DEEP DIVE — fetches /diagnostics/db on demand, renders sections
       ----------------------------------------------------------------------- */
    _renderDbDeep() {
      const wrap = document.getElementById('admin-db-deep');
      if (!wrap) return;
      wrap.innerHTML = `<div class="admin-db-loading">${t('ui.diag_loading')}</div>`;

      AdminCockpit._dbDeepAbort?.abort();
      AdminCockpit._dbDeepAbort = new AbortController();
      const sig = AbortSignal.any
        ? AbortSignal.any([AdminCockpit._dbDeepAbort.signal, AbortSignal.timeout(12000)])
        : AdminCockpit._dbDeepAbort.signal;

      Util.fetchTraced(`${Config.API_BASE}/diagnostics/db`, { signal: sig })
        .then(r => r.json())
        .then(d => {
          wrap.textContent = '';

          // ── Top: summary tiles strip ──────────────────────────────────────────────
          AdminCockpit._dbSummaryStrip(d, wrap);

          if (d.fetched_at) {
            const tsEl = document.createElement('div');
            tsEl.className = 'admin-db-fetched';
            tsEl.textContent = t('ui.diag_last_refreshed', { time: AdminCockpit._relTime(new Date(d.fetched_at)) });
            wrap.appendChild(tsEl);
          }

          const mkSection = (title, statusCls, buildFn, openByDefault, helpText) => {
            const det = document.createElement('details');
            det.className = 'admin-db-section';
            if (openByDefault) det.open = true;
            const sum = document.createElement('summary');
            sum.className = 'admin-db-section-sum';
            const dot = document.createElement('span');
            dot.className = `admin-health-dot ${statusCls}`;
            const ttl = document.createElement('span');
            ttl.className = 'admin-db-section-title';
            ttl.textContent = title;
            sum.appendChild(dot);
            sum.appendChild(ttl);
            if (helpText) {
              const hEl = document.createElement('span');
              hEl.className = 'adm-help';
              hEl.tabIndex = 0;
              hEl.setAttribute('aria-label', 'Help');
              hEl.addEventListener('click', e => e.stopPropagation());
              const hDot = document.createElement('span');
              hDot.className = 'adm-help-dot';
              hDot.textContent = '?';
              const hTip = document.createElement('span');
              hTip.className = 'adm-help-tip';
              hTip.textContent = helpText;
              hEl.appendChild(hDot);
              hEl.appendChild(hTip);
              sum.appendChild(hEl);
            }
            det.appendChild(sum);
            const body = document.createElement('div');
            body.className = 'admin-db-section-body';
            buildFn(body);
            det.appendChild(body);
            wrap.appendChild(det);
          };

          // ── 1. Connection Pool
          const pool = d.pool || {};
          const poolUsed = (pool.pool_size ?? 0) - (pool.pool_available ?? 0);
          const poolMax  = pool.pool_max || 1;
          const poolSt   = pool.error ? 'err' : (pool.requests_waiting > 0 || pool.requests_errors > 0 ? 'warn' : 'ok');
          mkSection(t('ui.diag_section_pool'), poolSt, body => {
            if (pool.error) { body.textContent = pool.error; return; }
            body.appendChild(AdminCockpit._dbFillBar(poolUsed, poolMax, t('ui.diag_pool_utilization')));
            body.appendChild(AdminCockpit._kvTable([
              [t('ui.diag_pool_min_max'),         `${pool.pool_min ?? '—'} / ${pool.pool_max ?? '—'}`],
              [t('ui.diag_pool_in_use'),           `${poolUsed} / ${pool.pool_available ?? '—'}`],
              [t('ui.diag_requests_waiting'),      pool.requests_waiting ?? 0],
              [t('ui.diag_requests_completed'),    (pool.requests_completed ?? 0).toLocaleString()],
              [t('ui.diag_request_errors'),        pool.requests_errors ?? 0],
              [t('ui.diag_bad_returns'),           pool.returns_bad ?? 0],
            ]));
            if (pool.requests_waiting > 0)
              AdminCockpit._dbWarnBanner(body, t('ui.diag_pool_queued', { count: pool.requests_waiting }));
            if (pool.requests_errors > 0)
              AdminCockpit._dbWarnBanner(body, t('ui.diag_pool_errors', { count: pool.requests_errors }), true);
          }, true, t('ui.diag_desc_pool'));

          // ── 2. Server Info
          const srv = d.server || {};
          mkSection(t('ui.diag_section_server'), srv.error ? 'err' : 'ok', body => {
            if (srv.error) { body.textContent = srv.error; return; }
            body.appendChild(AdminCockpit._kvTable([
              [t('ui.diag_database'),        srv.database ?? '—'],
              [t('ui.diag_database_size'),   srv.db_size   ?? '—'],
              [t('ui.diag_max_connections'), srv.max_connections ?? '—'],
              [t('ui.diag_up_since'),        srv.started_at ? AdminCockpit._relTime(new Date(srv.started_at)) : '—'],
              [t('ui.diag_version'),         (srv.version || '').split(' (')[0]],
            ]));
          }, true, t('ui.diag_desc_server'));

          // ── 3. Table Health
          const tables = Array.isArray(d.tables) ? d.tables : [];
          const hasTableErr = tables[0]?.error;
          const tablesNeedWork = !hasTableErr && tables.some(t => t.needs_vacuum || t.needs_analyze);
          mkSection(t('ui.diag_section_table_health', { count: hasTableErr ? '?' : tables.length }),
              hasTableErr ? 'err' : (tablesNeedWork ? 'warn' : 'ok'), body => {
            if (hasTableErr) { body.textContent = tables[0].error; return; }
            if (!tables.length) { body.textContent = t('empty.no_user_tables'); return; }
            body.appendChild(AdminCockpit._dbTableCards(tables));
          }, false, t('ui.diag_desc_table_health'));

          // ── 4. Active Connections
          const conn = d.connections || {};
          const hasLong = (conn.long_running || []).length > 0;
          mkSection(t('ui.diag_section_connections', { count: conn.total ?? '?' }),
              conn.error ? 'err' : (hasLong ? 'warn' : 'ok'), body => {
            if (conn.error) { body.textContent = conn.error; return; }
            body.appendChild(AdminCockpit._dbStackBar(conn.by_state || {}));
            if (hasLong) {
              const sub = document.createElement('div');
              sub.className = 'admin-pdtl-sub';
              sub.textContent = t('ui.non_idle_queries');
              body.appendChild(sub);
              body.appendChild(AdminCockpit._dbTable(
                ['PID', 'State', 'Dur (s)', 'Wait event', 'Query'],
                (conn.long_running || []).map(q => ({
                  cells: [q.pid, q.state || '—', q.duration_s ?? '—', q.wait_event || '—', (q.query || '').slice(0, 120)],
                  rowWarn: (q.duration_s || 0) > 30,
                  cellWarn: [],
                }))
              ));
            }
          }, false, t('ui.diag_desc_connections'));

          // ── 5. Lock Waits
          const locks = Array.isArray(d.locks) ? d.locks : [];
          const hasLockErr = locks[0]?.error;
          const activeLocks = !hasLockErr && locks.length > 0;
          mkSection(t('ui.diag_section_lock_waits', { count: hasLockErr ? '?' : locks.length }),
              hasLockErr ? 'err' : (activeLocks ? 'err' : 'ok'), body => {
            if (hasLockErr) { body.textContent = locks[0].error; return; }
            if (!activeLocks) {
              const ok = document.createElement('div');
              ok.className = 'admin-db-ok-msg';
              ok.textContent = t('empty.no_lock_contention');
              body.appendChild(ok);
              return;
            }
            AdminCockpit._dbWarnBanner(body, t('ui.diag_blocking_locks', { count: locks.length }), true);
            body.appendChild(AdminCockpit._dbLockChain(locks));
          }, false, t('ui.diag_desc_lock_waits'));

          // ── 6. Index Usage
          const indexes = Array.isArray(d.indexes) ? d.indexes : [];
          const hasIdxErr = indexes[0]?.error;
          const unusedCount = !hasIdxErr ? indexes.filter(ix => ix.unused).length : 0;
          mkSection(unusedCount
              ? t('ui.diag_section_index_unused', { count: hasIdxErr ? '?' : indexes.length, unused: unusedCount })
              : t('ui.diag_section_index_usage', { count: hasIdxErr ? '?' : indexes.length }),
              hasIdxErr ? 'err' : (unusedCount > 0 ? 'warn' : 'ok'), body => {
            if (hasIdxErr) { body.textContent = indexes[0].error; return; }
            if (!indexes.length) { body.textContent = t('empty.no_indexes'); return; }
            if (unusedCount > 0)
              AdminCockpit._dbWarnBanner(body, t('ui.diag_unused_indexes_warn', { count: unusedCount }));
            body.appendChild(AdminCockpit._dbHBarChart(indexes));
          }, false, t('ui.diag_desc_index_usage'));

          // ── 7. Slow Queries
          const sq = d.slow_queries || {};
          mkSection(t('ui.diag_section_slow_queries'),
              !sq.available ? 'warn' : ((sq.queries || []).length ? 'warn' : 'ok'), body => {
            if (!sq.available) {
              const msg = document.createElement('div');
              msg.className = 'admin-db-na-msg';
              msg.textContent = sq.error
                ? `Error: ${sq.error}`
                : t('ui.diag_pg_stat_missing');
              body.appendChild(msg);
              return;
            }
            if (!(sq.queries || []).length) {
              const ok = document.createElement('div');
              ok.className = 'admin-db-ok-msg';
              ok.textContent = t('empty.no_queries_yet');
              body.appendChild(ok);
              return;
            }
            body.appendChild(AdminCockpit._dbSlowQueryBars(sq.queries));
          }, false, t('ui.diag_desc_slow_queries'));

          // ── 8. Sequences
          const seqs = Array.isArray(d.sequences) ? d.sequences : [];
          const hasSeqErr = seqs[0]?.error;
          const seqIssues = !hasSeqErr ? seqs.filter(s => s.status !== 'ok').length : 0;
          mkSection(t('ui.diag_section_sequences', { count: hasSeqErr ? '?' : seqs.length }),
              hasSeqErr ? 'err' : (seqIssues > 0 ? 'warn' : 'ok'), body => {
            if (hasSeqErr) { body.textContent = seqs[0].error; return; }
            if (!seqs.length) { body.textContent = t('empty.no_sequences'); return; }
            body.appendChild(AdminCockpit._dbProgressBars(seqs));
          }, false, t('ui.diag_desc_sequences'));
        })
        .catch(e => {
          if (e.name === 'AbortError') return;
          wrap.textContent = '';
          const err = document.createElement('div');
          err.className = 'admin-db-error';
          err.textContent = t('ui.failed_load_db_diag', { error: e.message });
          wrap.appendChild(err);
          ErrorLog.warn('admin', `DB deep dive failed: ${e.message}`);
        });
    },

    /* -----------------------------------------------------------------------
       DB visual helpers
       ----------------------------------------------------------------------- */

    _dbSummaryStrip(d, wrap) {
      const strip = document.createElement('div');
      strip.className = 'admin-db-summary';
      const mkTile = (label, num, sub, status, extra) => {
        const tile = document.createElement('div');
        tile.className = `admin-db-stat-tile ${status}`;
        const top = document.createElement('div');
        top.className = 'admin-db-stat-tile-top';
        const dot = document.createElement('span');
        dot.className = `admin-health-dot ${status}`;
        const lbl = document.createElement('span');
        lbl.className = 'admin-db-stat-tile-lbl';
        lbl.textContent = label;
        top.appendChild(dot); top.appendChild(lbl);
        tile.appendChild(top);
        const numEl = document.createElement('div');
        numEl.className = 'admin-db-stat-tile-num';
        numEl.innerHTML = num;
        tile.appendChild(numEl);
        if (extra) tile.appendChild(extra);
        if (sub) {
          const subEl = document.createElement('div');
          subEl.className = 'admin-db-stat-tile-sub';
          subEl.textContent = sub;
          tile.appendChild(subEl);
        }
        return tile;
      };
      const pool = d.pool || {};
      const poolUsed = (pool.pool_size ?? 0) - (pool.pool_available ?? 0);
      const poolMax  = pool.pool_max || 1;
      const poolPct  = Math.round(100 * poolUsed / poolMax);
      const poolSt   = pool.error ? 'err' : (poolPct >= 85 || (pool.requests_waiting ?? 0) > 0 ? 'warn' : 'ok');
      strip.appendChild(mkTile(t('ui.diag_tile_pool'),
        `${poolUsed}<span style="font-size:14px;font-weight:400;color:var(--fg-mute)">/${poolMax}</span>`,
        t('ui.diag_tile_pct_utilized', {pct: poolPct}), poolSt,
        pool.error ? null : AdminCockpit._dbFillBar(poolUsed, poolMax, null)));
      const conn = d.connections || {};
      const activeConn = (conn.by_state || {})['active'] ?? 0;
      strip.appendChild(mkTile(t('ui.diag_tile_sessions'), String(conn.total ?? '—'), t('ui.diag_tile_active', {count: activeConn}),
        conn.error ? 'err' : ((conn.long_running || []).length > 0 ? 'warn' : 'ok'), null));
      const locks = Array.isArray(d.locks) && !d.locks[0]?.error ? d.locks : [];
      strip.appendChild(mkTile(t('ui.diag_tile_lock_waits'),
        locks.length > 0 ? `<span style="color:var(--err)">${locks.length}</span>` : '0',
        locks.length > 0 ? t('ui.diag_tile_contention') : t('ui.diag_tile_clear'),
        locks.length > 0 ? 'err' : 'ok', null));
      const tables = Array.isArray(d.tables) && !d.tables[0]?.error ? d.tables : [];
      const tblIssues = tables.filter(t => t.needs_vacuum || t.needs_analyze).length;
      strip.appendChild(mkTile(t('ui.diag_tile_table_issues'),
        tblIssues > 0 ? `<span style="color:var(--warn)">${tblIssues}</span>` : '0',
        tblIssues > 0 ? t('ui.diag_tables_need_work', {total: tables.length, issues: tblIssues}) : t('ui.diag_tables_healthy', {count: tables.length}),
        tblIssues > 0 ? 'warn' : 'ok', null));
      const sq = d.slow_queries || {};
      let sqNum = '—', sqSub = t('ui.diag_not_tracked'), sqSt = 'warn';
      if (sq.available && (sq.queries || []).length) {
        const top = sq.queries[0];
        sqNum = `${top.mean_ms}<span style="font-size:12px;font-weight:400;color:var(--fg-mute)">ms</span>`;
        sqSub = t('ui.diag_avg_calls', {calls: top.calls.toLocaleString()});
        sqSt  = top.mean_ms > 500 ? 'err' : (top.mean_ms > 100 ? 'warn' : 'ok');
      } else if (sq.available) {
        sqNum = '0'; sqSub = t('ui.diag_no_queries'); sqSt = 'ok';
      }
      strip.appendChild(mkTile(t('ui.diag_tile_slowest_query'), sqNum, sqSub, sqSt, null));
      wrap.appendChild(strip);
    },

    _dbFillBar(used, max, label) {
      const pct = max > 0 ? Math.min(100, Math.round(100 * used / max)) : 0;
      const cls = pct >= 85 ? 'err' : (pct >= 60 ? 'warn' : 'ok');
      const wrap = document.createElement('div');
      wrap.className = 'admin-db-fillbar';
      const track = document.createElement('div');
      track.className = 'admin-db-fillbar-track';
      const fill = document.createElement('div');
      fill.className = `admin-db-fillbar-fill ${cls}`;
      fill.style.width = `${pct}%`;
      fill.title = `${pct}%`;
      track.appendChild(fill);
      wrap.appendChild(track);
      if (label) {
        const lbl = document.createElement('span');
        lbl.className = 'admin-db-fillbar-lbl';
        lbl.textContent = `${used} / ${max} (${pct}%)`;
        wrap.appendChild(lbl);
      }
      return wrap;
    },

    _dbStackBar(byState) {
      const STATE_CLS = { 'active': 'state-active', 'idle in transaction': 'state-xit',
        'idle in transaction (aborted)': 'state-xit', 'idle': 'state-idle' };
      const total = Math.max(Object.values(byState).reduce((a, b) => a + b, 0), 1);
      const wrap = document.createElement('div');
      wrap.className = 'admin-db-stackbar-wrap';
      const bar = document.createElement('div');
      bar.className = 'admin-db-stackbar';
      for (const [state, count] of Object.entries(byState)) {
        if (!count) continue;
        const pct = Math.max(1, Math.round(100 * count / total));
        const seg = document.createElement('div');
        seg.className = `admin-db-stackbar-seg ${STATE_CLS[state] || 'state-other'}`;
        seg.style.width = `${pct}%`;
        seg.title = `${state}: ${count}`;
        bar.appendChild(seg);
      }
      wrap.appendChild(bar);
      const legend = document.createElement('div');
      legend.className = 'admin-db-stackbar-legend';
      for (const [state, count] of Object.entries(byState)) {
        if (!count) continue;
        const chip = document.createElement('span');
        chip.className = `admin-db-stackbar-chip ${STATE_CLS[state] || 'state-other'}`;
        chip.textContent = `${state}: ${count}`;
        legend.appendChild(chip);
      }
      wrap.appendChild(legend);
      return wrap;
    },

    _dbTableCards(tables) {
      const wrap = document.createElement('div');
      wrap.className = 'admin-db-tbl-cards';
      for (const tbl of tables) {
        const card = document.createElement('div');
        card.className = 'admin-db-tbl-card';
        const issues = [];
        if (tbl.needs_vacuum)  issues.push(t('ui.diag_vacuum'));
        if (tbl.needs_analyze) issues.push(t('ui.diag_analyze'));
        if (issues.length) card.classList.add('has-issues');
        const row1 = document.createElement('div');
        row1.className = 'admin-db-tbl-card-row1';
        const name = document.createElement('span');
        name.className = 'admin-db-tbl-card-name';
        name.textContent = tbl.table;
        const size = document.createElement('span');
        size.className = 'admin-db-tbl-card-size';
        size.textContent = tbl.total_size || '';
        const badge = document.createElement('span');
        badge.className = `admin-db-tbl-card-badge ${issues.length ? 'warn' : 'ok'}`;
        badge.textContent = issues.length ? issues.join(' + ') + ' ' + t('ui.diag_needed') : t('ui.diag_healthy');
        row1.appendChild(name); row1.appendChild(size); row1.appendChild(badge);
        card.appendChild(row1);
        const total = Math.max((tbl.live_rows ?? 0) + (tbl.dead_rows ?? 0), 1);
        const deadPct = Math.min(100, Math.round(100 * (tbl.dead_rows ?? 0) / total));
        const barWrap = document.createElement('div');
        barWrap.className = 'admin-db-tbl-card-barwrap';
        const barLive = document.createElement('div');
        barLive.className = 'admin-db-tbl-card-live';
        barLive.style.width = `${100 - deadPct}%`;
        barLive.title = `${t('ui.diag_table_live')}: ${(tbl.live_rows ?? 0).toLocaleString()}`;
        const barDead = document.createElement('div');
        barDead.className = 'admin-db-tbl-card-dead';
        barDead.style.width = `${deadPct}%`;
        barDead.title = `${t('ui.diag_table_dead')}: ${(tbl.dead_rows ?? 0).toLocaleString()} (${tbl.dead_pct}%)`;
        barWrap.appendChild(barLive); barWrap.appendChild(barDead);
        card.appendChild(barWrap);
        const row2 = document.createElement('div');
        row2.className = 'admin-db-tbl-card-row2';
        const vacAt = tbl.last_autovacuum || tbl.last_vacuum;
        row2.textContent = t('ui.diag_table_row2', {
          live: (tbl.live_rows ?? 0).toLocaleString(),
          dead: (tbl.dead_rows ?? 0).toLocaleString(),
          deadPct: tbl.dead_pct,
          vacAt: vacAt ? AdminCockpit._relTime(new Date(vacAt)) : t('ui.diag_vacuum_never'),
        });
        card.appendChild(row2);
        wrap.appendChild(card);
      }
      return wrap;
    },

    _dbHBarChart(indexes) {
      const maxScans = Math.max(...indexes.map(ix => ix.scans ?? 0), 1);
      const wrap = document.createElement('div');
      wrap.className = 'admin-db-hbar-chart';
      for (const ix of indexes) {
        const pct = Math.max(ix.unused ? 0 : 1, Math.round(100 * (ix.scans ?? 0) / maxScans));
        const row = document.createElement('div');
        row.className = 'admin-db-hbar-row';
        const names = document.createElement('div');
        names.className = 'admin-db-hbar-names';
        const tblN = document.createElement('span');
        tblN.className = 'admin-db-hbar-tbl';
        tblN.textContent = ix.table || '';
        const idxN = document.createElement('span');
        idxN.className = `admin-db-hbar-idx${ix.unused ? ' unused' : ''}`;
        idxN.textContent = ix.index || '';
        names.appendChild(tblN); names.appendChild(idxN);
        const track = document.createElement('div');
        track.className = 'admin-db-hbar-track';
        const fill = document.createElement('div');
        fill.className = `admin-db-hbar-fill${ix.unused ? ' unused' : ''}`;
        fill.style.width = `${pct}%`;
        track.appendChild(fill);
        const val = document.createElement('span');
        val.className = 'admin-db-hbar-val';
        val.textContent = (ix.scans ?? 0).toLocaleString();
        const sizeChip = document.createElement('span');
        sizeChip.className = 'admin-db-hbar-size';
        sizeChip.textContent = ix.index_size || '';
        row.appendChild(names); row.appendChild(track); row.appendChild(val); row.appendChild(sizeChip);
        wrap.appendChild(row);
      }
      return wrap;
    },

    _dbSlowQueryBars(queries) {
      const maxMs = Math.max(...queries.map(q => q.mean_ms ?? 0), 1);
      const wrap = document.createElement('div');
      wrap.className = 'admin-db-hbar-chart';
      for (const q of queries) {
        const pct = Math.max(1, Math.round(100 * (q.mean_ms ?? 0) / maxMs));
        const cls = (q.mean_ms ?? 0) > 500 ? 'err' : ((q.mean_ms ?? 0) > 100 ? 'warn' : '');
        const row = document.createElement('div');
        row.className = 'admin-db-hbar-row';
        const names = document.createElement('div');
        names.className = 'admin-db-hbar-names';
        const qText = document.createElement('span');
        qText.className = 'admin-db-hbar-idx';
        qText.textContent = (q.query || '').slice(0, 90);
        qText.title = q.query || '';
        names.appendChild(qText);
        const track = document.createElement('div');
        track.className = 'admin-db-hbar-track';
        const fill = document.createElement('div');
        fill.className = `admin-db-hbar-fill${cls ? ' ' + cls : ''}`;
        fill.style.width = `${pct}%`;
        track.appendChild(fill);
        const val = document.createElement('span');
        val.className = 'admin-db-hbar-val';
        val.textContent = `${q.mean_ms}ms`;
        if (cls) val.style.color = `var(--${cls})`;
        const callChip = document.createElement('span');
        callChip.className = 'admin-db-hbar-size';
        callChip.textContent = `${q.calls.toLocaleString()} calls`;
        row.appendChild(names); row.appendChild(track); row.appendChild(val); row.appendChild(callChip);
        wrap.appendChild(row);
      }
      return wrap;
    },

    _dbProgressBars(seqs) {
      const wrap = document.createElement('div');
      wrap.className = 'admin-db-progress-list';
      for (const s of seqs) {
        const row = document.createElement('div');
        row.className = 'admin-db-progress-row';
        const name = document.createElement('span');
        name.className = 'admin-db-progress-name';
        name.textContent = `${s.schema}.${s.name}`;
        const track = document.createElement('div');
        track.className = 'admin-db-fillbar-track';
        const fill = document.createElement('div');
        fill.className = `admin-db-fillbar-fill ${s.status || 'ok'}`;
        fill.style.width = `${Math.max(0.5, s.used_pct ?? 0)}%`;
        fill.title = `${s.used_pct}%`;
        track.appendChild(fill);
        const lbl = document.createElement('span');
        lbl.className = 'admin-db-fillbar-lbl';
        lbl.textContent = `${s.used_pct}%${s.cycles ? ' ↻' : ''}  (${(s.last_value ?? 0).toLocaleString()} / ${(s.max_value ?? 0).toLocaleString()})`;
        row.appendChild(name); row.appendChild(track); row.appendChild(lbl);
        wrap.appendChild(row);
      }
      return wrap;
    },

    _dbLockChain(locks) {
      const wrap = document.createElement('div');
      wrap.className = 'admin-db-lock-chains';
      for (const lk of locks) {
        const chain = document.createElement('div');
        chain.className = 'admin-db-lock-chain';
        const mkNode = (pid, role, query, cls) => {
          const node = document.createElement('div');
          node.className = `admin-db-lock-node ${cls}`;
          node.innerHTML = `<span class="admin-db-lock-pid">PID ${pid}</span>`
            + `<span class="admin-db-lock-role">${role}</span>`
            + `<div class="admin-db-lock-query">${(query || '—').slice(0, 90)}</div>`;
          return node;
        };
        chain.appendChild(mkNode(lk.blocking_pid, 'BLOCKING', lk.blocking_query, 'blocking'));
        const arrow = document.createElement('div');
        arrow.className = 'admin-db-lock-arrow';
        arrow.innerHTML = `<span class="admin-db-lock-type">${lk.lock_type || ''}</span> ▼`;
        chain.appendChild(arrow);
        chain.appendChild(mkNode(lk.blocked_pid, `BLOCKED ${lk.blocked_for_s}s`, lk.blocked_query, 'blocked'));
        wrap.appendChild(chain);
      }
      return wrap;
    },

    _dbWarnBanner(parent, text, isError) {
      const d = document.createElement('div');
      d.className = `admin-db-banner ${isError ? 'admin-db-banner-err' : 'admin-db-banner-warn'}`;
      d.textContent = text;
      parent.appendChild(d);
    },

    _dbTable(headers, rowDefs) {
      const tbl = document.createElement('table');
      tbl.className = 'admin-db-tbl';
      const thead = tbl.createTHead();
      const hrow = thead.insertRow();
      headers.forEach(h => {
        const th = document.createElement('th');
        th.textContent = h;
        hrow.appendChild(th);
      });
      const tbody = tbl.createTBody();
      for (const { cells, rowWarn, rowErr, cellWarn } of rowDefs) {
        const tr = tbody.insertRow();
        if (rowErr)  tr.style.background = 'rgba(192,57,43,0.07)';
        else if (rowWarn) tr.style.background = 'rgba(243,156,18,0.06)';
        cells.forEach((c, i) => {
          const td = tr.insertCell();
          td.textContent = (c === null || c === undefined) ? '—' : c;
          if (cellWarn.includes(i)) td.style.color = 'var(--warn)';
        });
      }
      return tbl;
    },

    /* -----------------------------------------------------------------------
       BACKEND EVENT LOG — fetches /logs/backend, renders like the front-end log
       ----------------------------------------------------------------------- */
    _renderBackendLog() {
      const host = document.getElementById('admin-backend-log-list');
      const countEl = document.getElementById('admin-backend-log-count');
      if (!host) return;
      host.innerHTML = '<div class="admin-log-empty">Loading…</div>';

      AdminCockpit._backendLogAbort?.abort();
      AdminCockpit._backendLogAbort = new AbortController();
      const sig = AbortSignal.any
        ? AbortSignal.any([AdminCockpit._backendLogAbort.signal, AbortSignal.timeout(8000)])
        : AdminCockpit._backendLogAbort.signal;

      const lvl = AdminCockpit._backendLogFilter?.level || 'all';
      const params = `?limit=200${lvl !== 'all' ? '&level=' + encodeURIComponent(lvl) : ''}`;

      Util.fetchTraced(`${Config.API_BASE}/logs/backend${params}`, { signal: sig })
        .then(r => r.json())
        .then(({ entries, total }) => {
          host.textContent = '';
          if (countEl) countEl.textContent = t('ui.backend_log_count', { total, shown: entries.length });

          if (!entries.length) {
            const empty = document.createElement('div');
            empty.className = 'admin-log-empty';
            empty.textContent = lvl !== 'all' ? t('ui.diag_no_level_events', {level: lvl}) : t('empty.no_backend_events');
            host.appendChild(empty);
            return;
          }

          for (const e of entries) {
            const row = document.createElement('div');
            row.className = `admin-log-row admin-log-${e.level || 'info'}`;

            const head = document.createElement('div');
            head.className = 'admin-log-head';

            const lvlEl = document.createElement('span');
            lvlEl.className = 'admin-log-lvl';
            lvlEl.textContent = (e.level || 'info').toUpperCase();

            const tsEl = document.createElement('span');
            tsEl.className = 'admin-log-ts';
            const d = e.ts ? new Date(e.ts) : null;
            tsEl.textContent = d ? AdminCockpit._relTime(d) : '';
            tsEl.title = e.ts || '';

            const scopeEl = document.createElement('span');
            scopeEl.className = 'admin-log-scope';
            scopeEl.textContent = e.category || '';

            head.appendChild(lvlEl);
            head.appendChild(tsEl);
            head.appendChild(scopeEl);
            row.appendChild(head);

            const msg = document.createElement('div');
            msg.className = 'admin-log-msg';
            msg.textContent = e.msg || '';
            row.appendChild(msg);

            if (e.ctx && Object.keys(e.ctx).length) {
              const pre = document.createElement('pre');
              pre.className = 'admin-log-ctx';
              pre.textContent = JSON.stringify(e.ctx, null, 2);
              row.appendChild(pre);
              row.style.cursor = 'pointer';
              row.addEventListener('click', () => row.classList.toggle('expanded'));
            }

            host.appendChild(row);
          }
        })
        .catch(e => {
          host.textContent = '';
          const err = document.createElement('div');
          err.className = 'admin-log-empty';
          err.textContent = t('ui.failed_load_backend_log', { error: e.message });
          host.appendChild(err);
        });
    },

    _clearBackendLog() {
      Util.fetchTraced(`${Config.API_BASE}/logs/backend/clear`, { method: 'POST' })
        .then(() => AdminCockpit._renderBackendLog())
        .catch(() => {});
    },

    _copyFiltered() {
      const entries = AdminCockpit._getFilteredEntries();
      const txt = entries.map(e =>
        `${e.ts} [${e.level.toUpperCase()}] ${e.scope}: ${e.msg}${e.ctx ? ' :: ' + JSON.stringify(e.ctx) : ''}`
      ).join('\n');
      navigator.clipboard?.writeText(txt).then(
        () => Toast.show(t('toast.copied_filtered', { count: entries.length }), 'success'),
        () => Toast.show(t('toast.copy_failed'), 'error')
      );
    },

    _renderLogs() {
      const list = document.getElementById('admin-log-list');
      if (!list) return;

      // Rebuild scope filter options
      const allEntries = ErrorLog.entries();
      const scopeEl = document.getElementById('admin-log-filter-scope');
      if (scopeEl) {
        const currentScope = AdminCockpit._logFilter.scope;
        const scopes = [...new Set(allEntries.map(e => e.scope).filter(Boolean))].sort();
        scopeEl.textContent = '';
        const allOpt = document.createElement('option');
        allOpt.value = 'all';
        allOpt.textContent = t('ui.all_scopes');
        scopeEl.appendChild(allOpt);
        for (const s of scopes) {
          const opt = document.createElement('option');
          opt.value = s;
          opt.textContent = s;
          if (s === currentScope) opt.selected = true;
          scopeEl.appendChild(opt);
        }
      }

      const filtered = AdminCockpit._getFilteredEntries();
      const visible = filtered.slice().reverse();

      list.textContent = '';

      if (visible.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'admin-log-empty';
        empty.textContent = filtered.length === 0 && allEntries.length > 0
          ? t('empty.no_entries_filter')
          : t('empty.no_log_entries');
        list.appendChild(empty);
      }

      const SCOPE_COLORS = {
        persistence: 'var(--info,#3498db)',
        engine:      '#9b59b6',
        admin:       'var(--accent,#b8791a)',
        alerts:      'var(--err,#c0392b)',
        store:       '#16a085',
        calendar:    '#2ecc71',
        interaction: '#e67e22',
      };

      for (const e of visible) {
        const row = document.createElement('div');
        row.className = `admin-log-row admin-log-${e.level}`;
        row.style.cursor = e.ctx != null ? 'pointer' : '';

        const head = document.createElement('div');
        head.className = 'admin-log-head';

        const lvl = document.createElement('span');
        lvl.className = 'admin-log-lvl';
        lvl.textContent = e.level;

        const ts = document.createElement('span');
        ts.className = 'admin-log-ts';
        const d = e.ts ? new Date(e.ts) : null;
        ts.textContent = d ? AdminCockpit._relTime(d) : '';
        ts.title = e.ts || '';

        const scope = document.createElement('span');
        scope.className = 'admin-log-scope';
        scope.textContent = e.scope || '';
        if (SCOPE_COLORS[e.scope]) scope.style.color = SCOPE_COLORS[e.scope];

        head.appendChild(lvl);
        head.appendChild(ts);
        head.appendChild(scope);
        row.appendChild(head);

        const msg = document.createElement('div');
        msg.className = 'admin-log-msg';
        msg.textContent = e.msg || '';
        row.appendChild(msg);

        if (e.ctx != null) {
          const pre = document.createElement('pre');
          pre.className = 'admin-log-ctx';
          pre.textContent = typeof e.ctx === 'string' ? e.ctx : JSON.stringify(e.ctx, null, 2);
          row.appendChild(pre);
          row.addEventListener('click', () => row.classList.toggle('expanded'));
        }

        list.appendChild(row);
      }

      const counts = document.getElementById('admin-log-counts');
      if (counts) {
        const errs  = ErrorLog.countBy('error');
        const warns = ErrorLog.countBy('warn');
        const show  = filtered.length !== allEntries.length ? t('ui.log_shown', { count: filtered.length }) : '';
        counts.textContent = t('ui.log_count_summary', {
          total: allEntries.length,
          errs, errp: errs === 1 ? '' : 's',
          warns, warnp: warns === 1 ? '' : 's',
          shown: show,
        });
      }
    },

    _relTime(d) {
      const diffMs = Date.now() - (d instanceof Date ? d : new Date(d)).getTime();
      const s = Math.round(diffMs / 1000);
      if (s < 60)    return t('ui.time_s_ago', { n: s });
      if (s < 3600)  return t('ui.time_m_ago', { n: Math.floor(s / 60) });
      if (s < 86400) return t('ui.time_h_ago', { n: Math.floor(s / 3600) });
      return t('ui.time_d_ago', { n: Math.floor(s / 86400) });
    },

    async _clearAudit() {
      const ok = await Modal.confirm({ title: t('modal.delete_upload_history'), confirmLabel: t('btn.yes_delete_all') });
      if (!ok) return;
      fetch(`${Config.API_BASE}/upload/audit/clear`, { method: 'POST' })
        .then(r => r.json())
        .then(body => {
          if (body.status !== 'ok') { Toast.show(t('toast.clear_history_failed'), 'error'); return; }
          Toast.show(t('toast.history_cleared', { count: body.deleted }), 'success');
          AdminCockpit._renderAudit();
        })
        .catch(e => Toast.show(t('toast.clear_history_failed') + ': ' + e.message, 'error'));
    },

    _renderAudit() {
      const host = document.getElementById('admin-audit-list');
      if (!host) return;
      host.textContent = t('ui.loading');
      AdminCockpit._auditAbort?.abort();
      AdminCockpit._auditAbort = new AbortController();
      const sig = AbortSignal.any
        ? AbortSignal.any([AdminCockpit._auditAbort.signal, AbortSignal.timeout(8000)])
        : AdminCockpit._auditAbort.signal;
      Util.fetchTraced(`${Config.API_BASE}/upload/audit`, { signal: sig })
        .then(r => r.json())
        .then(body => {
          host.textContent = '';
          const items = body?.audit || [];
          if (items.length === 0) {
            const e = document.createElement('div');
            e.className = 'admin-log-empty';
            e.textContent = t('empty.no_uploads');
            host.appendChild(e);
            return;
          }
          const tbl = document.createElement('table');
          tbl.className = 'admin-audit-tbl';
          const thead = document.createElement('thead');
          const htr = document.createElement('tr');
          for (const h of [t('ui.audit_col_when'), t('ui.audit_col_file'), t('ui.audit_col_rows'), t('ui.audit_col_inserted'), t('ui.audit_col_updated'), t('ui.audit_col_batch'), t('ui.audit_col_warnings')]) {
            const th = document.createElement('th');
            th.textContent = h;
            htr.appendChild(th);
          }
          thead.appendChild(htr);
          tbl.appendChild(thead);

          const tb = document.createElement('tbody');
          for (const it of items) {
            const hasWarnings = it.warnings && it.warnings.length > 0;

            const tr = document.createElement('tr');
            if (hasWarnings) tr.classList.add('admin-audit-has-warn');
            tr.style.cursor = hasWarnings ? 'pointer' : '';

            const batchShort = it.batch_id ? it.batch_id.slice(0, 8) + '…' : '—';
            const cells = [
              (it.uploaded_at || '').replace('T', ' ').slice(0, 19),
              it.filename || '—',
              String(it.row_count ?? '—'),
              String(it.inserted ?? '—'),
              String(it.updated ?? '—'),
              batchShort,
              hasWarnings ? `⚠ ${it.warnings.length}` : '✓',
            ];
            cells.forEach((c, i) => {
              const td = document.createElement('td');
              td.textContent = c;
              if (i === 6 && hasWarnings) td.style.color = 'var(--warn,#b57a0a)';
              if (i === 5 && it.batch_id) td.title = it.batch_id;
              tr.appendChild(td);
            });

            if (hasWarnings) {
              const warnRow = document.createElement('tr');
              warnRow.className = 'admin-audit-warn-detail';
              warnRow.style.display = 'none';
              const td = document.createElement('td');
              td.colSpan = 7;
              td.style.padding = '0';
              td.appendChild(AdminCockpit._warningList(it.warnings));
              warnRow.appendChild(td);
              tb.appendChild(tr);
              tb.appendChild(warnRow);
              tr.addEventListener('click', () => {
                warnRow.style.display = warnRow.style.display === 'none' ? '' : 'none';
              });
            } else {
              tb.appendChild(tr);
            }
          }
          tbl.appendChild(tb);
          host.appendChild(tbl);
        })
        .catch(e => {
          if (e?.name === 'AbortError') return;
          host.textContent = '';
          const err = document.createElement('div');
          err.className = 'admin-status error';
          err.textContent = t('ui.failed_load_upload_history', { error: e.message });
          host.appendChild(err);
        });
    },

    async _clearAuditLog() {
      const ok = await Modal.confirm({ title: t('modal.clear_audit_log'), confirmLabel: t('btn.yes_delete') });
      if (!ok) return;
      fetch(`${Config.API_BASE}/audit/log/clear`, { method: 'POST' })
        .then(r => r.json())
        .then(body => {
          if (body.status !== 'ok') { Toast.show(t('toast.clear_failed'), 'error'); return; }
          Toast.show(t('toast.audit_log_cleared'), 'success');
          AdminCockpit._renderAuditLog();
        })
        .catch(e => Toast.show(t('toast.clear_failed') + ': ' + e.message, 'error'));
    },

    _renderAuditLog() {
      const host = document.getElementById('admin-audit-log-list');
      if (!host) return;
      host.textContent = t('ui.loading');
      AdminCockpit._auditLogAbort?.abort();
      AdminCockpit._auditLogAbort = new AbortController();
      const sig = AbortSignal.any
        ? AbortSignal.any([AdminCockpit._auditLogAbort.signal, AbortSignal.timeout(8000)])
        : AdminCockpit._auditLogAbort.signal;
      Util.fetchTraced(`${Config.API_BASE}/audit/log?limit=200`, { signal: sig })
        .then(r => r.json())
        .then(body => {
          host.textContent = '';
          const items = body?.entries || [];
          if (!items.length) {
            const e = document.createElement('div');
            e.className = 'admin-log-empty';
            e.textContent = t('empty.no_audit_events');
            host.appendChild(e);
            return;
          }
          const tbl = document.createElement('table');
          tbl.className = 'admin-audit-tbl';
          const thead = document.createElement('thead');
          const htr   = document.createElement('tr');
          for (const h of [t('ui.audit_log_col_when'), t('ui.audit_log_col_user'), t('ui.audit_log_col_action'), t('ui.audit_log_col_plant'), t('ui.audit_log_col_details')]) {
            const th = document.createElement('th');
            th.textContent = h;
            htr.appendChild(th);
          }
          thead.appendChild(htr);
          tbl.appendChild(thead);

          const ACTION_ICONS = {
            color_wheel_upload:  '⬆',
            color_wheel_replace: '↻',
            color_wheel_delete:  '⌫',
            optimization_run:    '📈',
          };
          const ACTION_COLORS = {
            color_wheel_upload:  'var(--ok,#2f7a4d)',
            color_wheel_replace: 'var(--info,#2d5f8c)',
            color_wheel_delete:  'var(--err,#c0392b)',
            optimization_run:    'var(--accent,#b8791a)',
          };

          const tb = document.createElement('tbody');
          for (const it of items) {
            const tr = document.createElement('tr');
            const action = it.action || '—';
            const icon   = ACTION_ICONS[action] || '•';
            const color  = ACTION_COLORS[action] || 'inherit';
            const details = it.details
              ? Object.entries(it.details).map(([k, v]) => `${k}: ${v}`).join(' · ')
              : '—';
            const cells = [
              (it.ts || '').replace('T', ' ').slice(0, 19),
              it.user || '—',
              '',
              it.plant || '—',
              details,
            ];
            cells.forEach((c, i) => {
              const td = document.createElement('td');
              if (i === 2) {
                td.innerHTML = `<span style="color:${color};font-weight:600;">${icon} ${action}</span>`;
              } else {
                td.textContent = c;
              }
              if (i === 3 && it.plant) td.style.fontWeight = '600';
              tr.appendChild(td);
            });
            tb.appendChild(tr);
          }
          tbl.appendChild(tb);
          host.appendChild(tbl);
        })
        .catch(e => {
          if (e?.name === 'AbortError') return;
          host.textContent = '';
          const err = document.createElement('div');
          err.className = 'admin-status error';
          err.textContent = t('ui.failed_load_audit_log', { error: e.message });
          host.appendChild(err);
        });
    },

    /* ---------------------------------------------------------------------
       DIAGNOSTICS PANEL — client-side health summary, "Reset client state",
       diagnostics bundle export. Renders into #admin-diagnostics-pane.
       --------------------------------------------------------------------- */
    _renderDiagnostics() {
      const host = document.getElementById('admin-diagnostics-pane');
      if (!host) return;

      const inv  = Persistence.storageInventory();
      const totK = (inv.totalBytes / 1024).toFixed(1);
      const lastK = (inv.lastBytes / 1024).toFixed(1);
      const lastWhen = inv.lastSavedAt ? new Date(inv.lastSavedAt).toLocaleTimeString() : '—';
      const errCount  = ErrorLog.countBy('error');
      const warnCount = ErrorLog.countBy('warn');
      const errRate   = ErrorLog.errorRatePerMin();
      const warnRate  = ErrorLog.warnRatePerMin();
      const heap = (performance && performance.memory)
        ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)} / ${(performance.memory.jsHeapSizeLimit / 1048576).toFixed(0)} MB`
        : 'n/a';
      const stats = (Persistence.stats && Persistence.stats()) || {};

      const autosaveTxt = inv.autosaveDisabled
        ? `<span class="admin-bad">${t('ui.ls_quota_disabled')}</span>`
        : inv.degraded
          ? `<span class="admin-warn">${t('ui.ls_degraded')}</span>`
          : `<span class="admin-good">${t('ui.ls_healthy')}</span>`;
      const errTxt = errRate > 10
        ? `<span class="admin-bad">${t('ui.diag_err_rate_spike', { count: errCount, rate: errRate })}</span>`
        : errRate > 0
          ? `<span class="admin-warn">${t('ui.diag_err_rate_warn', { count: errCount, rate: errRate })}</span>`
          : `${errCount}`;

      host.innerHTML = `
        <div class="admin-card">
          <div class="admin-card-hd">
            <h3>${t('ui.diag_client_title')}<span class="adm-help" tabindex="0" aria-label="Help"><span class="adm-help-dot">?</span><span class="adm-help-tip">${t('ui.diag_client_help')}</span></span></h3>
            <div class="admin-card-actions">
              <button class="btn btn-ghost sm" id="admin-diag-refresh" title="${t('tip.refresh')}">${t('btn.refresh')}</button>
              <button class="btn btn-ghost sm" id="admin-diag-storage" title="${t('tip.inspect_storage')}">${t('btn.inspect_storage')}</button>
              <button class="btn btn-ghost sm" id="admin-diag-export" title="${t('tip.diag_export_bundle')}">${t('btn.export_bundle')}</button>
              <button class="btn btn-warn  sm" id="admin-diag-reset"   title="${t('tip.diag_clear_cache')}">${t('btn.reset_client')}</button>
            </div>
          </div>
          <div class="admin-kv">
            <span>${t('ui.diag_kv_build')}</span><span>${Config.BUILD_ID}</span>
            <span>${t('ui.diag_kv_schema')}</span><span>${Config.SCHEMA_VERSION}</span>
            <span>${t('ui.diag_kv_cache')}</span><span>${t('ui.diag_cache_val', { size: lastK, when: lastWhen })}</span>
            <span>${t('ui.diag_kv_storage')}</span><span>${t('ui.diag_storage_val', { size: totK, count: inv.count })}</span>
            <span>${t('ui.diag_kv_autosave')}</span><span>${autosaveTxt}</span>
            <span>${t('ui.diag_kv_heap')}</span><span>${heap}</span>
            <span>${t('ui.diag_kv_errors')}</span><span>${errTxt}</span>
            <span>${t('ui.diag_kv_warnings')}</span><span>${warnCount} (${warnRate}/min)</span>
            <span>${t('ui.diag_kv_tasks')}</span><span>${Store.tasksArr.length}</span>
            <span>${t('ui.diag_kv_source')}</span><span>${stats.source || '—'}</span>
            <span>${t('ui.diag_kv_plant')}</span><span>${Store.selectedPlant || '<em>none</em>'}</span>
          </div>
        </div>`;

      document.getElementById('admin-diag-refresh').onclick = () => AdminCockpit._renderDiagnostics();
      document.getElementById('admin-diag-storage').onclick = () => AdminCockpit._showStorageInventory(inv);
      document.getElementById('admin-diag-export' ).onclick = () => AdminCockpit._exportDiagnostics();
      document.getElementById('admin-diag-reset'  ).onclick = () => AdminCockpit._resetClientState();
    },

    async _resetClientState() {
      const ok = await Modal.confirm({
        title:        t('modal.reset_client_title'),
        message:      t('modal.reset_client_msg'),
        detail:       t('modal.reset_client_detail'),
        confirmLabel: t('modal.reset_client_confirm'),
        tone:         'warn',
      });
      if (!ok) return;
      try { localStorage.removeItem(Config.LS_KEY); } catch {}
      try { sessionStorage.clear(); } catch {}
      try {
        const prefix = `${Config.LS_KEY}.quarantine.`;
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(prefix)) toRemove.push(k);
        }
        toRemove.forEach(k => { try { localStorage.removeItem(k); } catch {} });
      } catch {}
      ErrorLog.info('admin', 'Client state reset by user — reloading');
      // Give the log a frame to render in case of debounce, then hard-reload bypassing HTTP cache.
      setTimeout(() => location.reload(), 50);
    },

    _showStorageInventory(inv) {
      if (!inv) inv = Persistence.storageInventory();
      const top = inv.items.slice(0, 12)
        .map(i => `${(i.bytes / 1024).toFixed(1).padStart(7)} KB  ${i.key}`)
        .join('\n') || t('ui.ls_empty');
      const lsStatus = inv.degraded ? t('ui.ls_evicted_tier') : inv.autosaveDisabled ? t('ui.ls_autosave_disabled') : t('ui.ls_healthy');
      const detail =
        `<pre style="margin:0;font:11px ui-monospace,monospace;white-space:pre;">` +
        t('modal.ls_inv_total', { size: (inv.totalBytes / 1024).toFixed(1), count: inv.count }) + '\n' +
        t('modal.ls_inv_snapshot', { size: (inv.lastBytes / 1024).toFixed(1), status: lsStatus }) + '\n\n' +
        t('modal.ls_inventory_top_keys') + `\n${top}` +
        `</pre>`;
      Modal.confirm({
        title:        t('modal.ls_inventory_title'),
        message:      t('modal.ls_inventory_msg'),
        detail,
        confirmLabel: t('btn.close'),
        tone:         'warn',
      });
    },

    _exportDiagnostics() {
      const bundle = {
        generatedAt: new Date().toISOString(),
        build:       Config.BUILD_ID,
        schema:      Config.SCHEMA_VERSION,
        userAgent:   navigator.userAgent,
        location:    location.href,
        storage:     Persistence.storageInventory(),
        heap: (performance && performance.memory) ? {
          usedMB:  +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
          limitMB: +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(1),
        } : null,
        persistence: (Persistence.stats && Persistence.stats()) || null,
        health:      AdminCockpit._healthData || null,
        deep:        AdminCockpit._deepData   || null,
        storeCounts: {
          tasks:        Store.tasksArr.length,
          blocks:       (Store.blocks || []).length,
          plantBlocks:  (Store.plantBlocks || []).length,
          lines:        Object.keys(Store.lineSettings || {}).length,
          plants:       Object.keys(Store.plants || {}).length,
          fixed:        Store.fixedIds ? Store.fixedIds.size : 0,
          alerts:       (Store.alerts || []).length,
        },
        selectedPlant: Store.selectedPlant,
        errorRates: {
          errorPerMin: ErrorLog.errorRatePerMin(),
          warnPerMin:  ErrorLog.warnRatePerMin(),
          totalErrors: ErrorLog.countBy('error'),
          totalWarns:  ErrorLog.countBy('warn'),
        },
        errors: ErrorLog.entries().slice(-200),
      };
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `nimbus-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      Toast.show(t('toast.diag_bundle_downloaded'), 'success');
    }
  };

  /* =============================================================================
     PRINTER — Order list export modal with date range selector.
     Opens a modal with From/To date pickers, renders a filterable table of
     orders sorted by production line then start date, and supports CSV export
     and browser print.
     ========================================================================== */
  const Printer = {
    _rows: [], // last previewed rows, used by exportCsv()

    open() {
      const scheduled = Store.tasksArr.filter(t => t.start_date && t.end_date);
      const today = new Date();
      let defStart = today;
      let defEnd   = new Date(today); defEnd.setDate(today.getDate() + 7);
      if (scheduled.length) {
        defStart = new Date(Math.min(...scheduled.map(t => t.start_date.getTime())));
        defEnd   = new Date(Math.max(...scheduled.map(t => t.end_date.getTime())));
      }
      if (!Printer._fpStart) {
        Printer._fpStart = flatpickr('#print-start', {
          dateFormat: 'Y-m-d', altInput: true, altFormat: 'M j, Y',
          altInputClass: 'input', onChange() { Printer.preview(); }
        });
        Printer._fpEnd = flatpickr('#print-end', {
          dateFormat: 'Y-m-d', altInput: true, altFormat: 'M j, Y',
          altInputClass: 'input', onChange() { Printer.preview(); }
        });
      }
      Printer._fpStart.setDate(defStart, false);
      Printer._fpEnd.setDate(defEnd, false);
      Modal.open('modal-print');
      Printer.preview();
    },

    preview() {
      const startVal = document.getElementById('print-start')?.value;
      const endVal   = document.getElementById('print-end')?.value;
      const host     = document.getElementById('print-results');
      if (!host) return;

      if (!startVal || !endVal) {
        host.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">Pick a date range above.</p>';
        return;
      }

      const rangeStart = new Date(startVal + 'T00:00:00');
      const rangeEnd   = new Date(endVal   + 'T23:59:59');

      const rows = Store.tasksArr
        .filter(t => t.start_date && t.start_date >= rangeStart && t.start_date <= rangeEnd)
        .sort((a, b) => {
          const la = (a.PRODUCTION_LINE || 'Unknown'), lb = (b.PRODUCTION_LINE || 'Unknown');
          if (la !== lb) return la.localeCompare(lb);
          return (a.start_date?.getTime() || 0) - (b.start_date?.getTime() || 0);
        });

      Printer._rows = rows;

      if (!rows.length) {
        host.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">No orders in this range.</p>';
        return;
      }

      const pad2 = n => String(n).padStart(2, '0');
      const fmtDt = d => {
        if (!d) return '—';
        return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      };

      const MAX_PRINT_ROWS = 500;
      const printRows = rows.length > MAX_PRINT_ROWS ? rows.slice(0, MAX_PRINT_ROWS) : rows;

      const tbl  = document.createElement('table');
      tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed;';

      const colgroup = document.createElement('colgroup');
      const widths = ['8%', '10%', '10%', '30%', '17%', '17%', '8%'];
      for (const w of widths) {
        const col = document.createElement('col');
        col.style.width = w;
        colgroup.appendChild(col);
      }
      tbl.appendChild(colgroup);

      const thead = document.createElement('thead');
      const htr   = document.createElement('tr');
      for (const h of ['Line', 'Prod. Order', 'Material', 'Description', 'Start', 'End', 'Hours']) {
        const th = document.createElement('th');
        th.textContent = h;
        th.style.cssText = 'text-align:left;padding:6px 8px;border-bottom:2px solid var(--line);font-size:11px;';
        htr.appendChild(th);
      }
      thead.appendChild(htr);
      tbl.appendChild(thead);

      const tb = document.createElement('tbody');
      printRows.forEach((t, i) => {
        const tr = document.createElement('tr');
        tr.style.background = i % 2 === 0 ? '' : 'var(--surface-2, #f8f7f2)';
        const cells = [
          t.PRODUCTION_LINE || '—',
          t.ORDER || t.PRODUCTION_ORDER || '—',
          t.MATERIAL_NUMBER  || '—',
          t.MATERIAL_DESCRIPTION || t.text || '—',
          fmtDt(t.start_date),
          fmtDt(t.end_date),
          Util.runHours(t).toFixed(1)
        ];
        for (const c of cells) {
          const td = document.createElement('td');
          td.textContent = c;
          td.style.cssText = 'padding:5px 8px;border-bottom:1px solid var(--line);word-break:break-word;overflow-wrap:anywhere;vertical-align:top;';
          tr.appendChild(td);
        }
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);

      host.textContent = '';
      const countEl = document.createElement('p');
      countEl.style.cssText = 'font-size:12px;color:var(--text-muted);margin:0 0 8px;';
      countEl.textContent = rows.length > MAX_PRINT_ROWS
        ? `Showing first ${MAX_PRINT_ROWS} of ${rows.length} orders — narrow the date range for a complete export (CSV exports all rows).`
        : `${rows.length} order${rows.length === 1 ? '' : 's'} in range`;
      host.appendChild(countEl);
      host.appendChild(tbl);
    },

    exportCsv() {
      if (!Printer._rows.length) { Toast.show(t('toast.nothing_to_export'), 'warn'); return; }
      const fmtDt = d => d ? d.toISOString().slice(0, 16).replace('T', ' ') : '';
      const headers = ['Line', 'Production Order', 'Material Number', 'Description', 'Start', 'End', 'Hours'];
      const lines = [
        headers.join(','),
        ...Printer._rows.map(t => [
          t.PRODUCTION_LINE || '',
          t.ORDER || t.PRODUCTION_ORDER || '',
          t.MATERIAL_NUMBER  || '',
          (t.MATERIAL_DESCRIPTION || t.text || '').replace(/,/g, ';'),
          fmtDt(t.start_date),
          fmtDt(t.end_date),
          Util.runHours(t).toFixed(1)
        ].join(','))
      ];
      const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.download = `nimbus-orders-${Util.dayKey(new Date())}.csv`;
      a.href = URL.createObjectURL(blob);
      a.click();
      URL.revokeObjectURL(a.href);
    },

    print() {
      window.print();
    }
  };

  /* =============================================================================
     EMPTY STATE — reusable "select a plant" prompt rendered into a container
     whenever Store.selectedPlant is null. Each module that scopes by plant
     calls EmptyState.render(el, opts) instead of its normal render path.
     ========================================================================== */
  const EmptyState = {
    render(container, opts = {}) {
      if (!container) return;
      const title = opts.title || 'Select a plant to begin';
      const msg = opts.msg ||
        'Use the <strong>Plant</strong> selector in the top bar to choose which plant to view across NIMBUS.';
      const icon = opts.icon || '◨';
      container.innerHTML =
        `<div class="nimbus-empty-state">
           <div class="nes-icon">${icon}</div>
           <div class="nes-title">${title}</div>
           <div class="nes-msg">${msg}</div>
         </div>`;
    }
  };

  /* =============================================================================
     PLANT SELECTOR — global, searchable combobox in the topbar.
     Owns the selected-plant UI; writes to Store.selectedPlant; subscribes to
     'plant:selected' so external mutations (e.g. OptimizeDialog) stay in sync.
     ========================================================================== */
  const PlantSelector = {
    _root:     null,
    _input:    null,
    _dropdown: null,
    _clearBtn: null,
    _combobox: null,
    _options:  [],
    _filtered: [],
    _activeIdx: -1,
    _open:     false,

    init() {
      PlantSelector._root     = document.getElementById('header-plant-selector');
      PlantSelector._input    = document.getElementById('hps-input');
      PlantSelector._dropdown = document.getElementById('hps-dropdown');
      PlantSelector._clearBtn = document.getElementById('hps-clear');
      PlantSelector._combobox = document.getElementById('hps-combobox');
      if (!PlantSelector._root) return;

      PlantSelector._input.addEventListener('focus', () => {
        PlantSelector._refreshOptions();
        PlantSelector._renderDropdown(PlantSelector._input.value);
        PlantSelector._openDropdown();
      });
      PlantSelector._input.addEventListener('input', () => {
        PlantSelector._renderDropdown(PlantSelector._input.value);
        PlantSelector._openDropdown();
      });
      PlantSelector._input.addEventListener('keydown', PlantSelector._onKeydown);
      PlantSelector._input.addEventListener('blur', () => {
        // Defer close so clicks on dropdown items can fire first.
        setTimeout(() => {
          PlantSelector._closeDropdown();
          PlantSelector._restoreLabel();
        }, 120);
      });
      PlantSelector._clearBtn.addEventListener('mousedown', e => e.preventDefault());
      PlantSelector._clearBtn.addEventListener('click', () => {
        Store.setSelectedPlant(null, 'header');
        PlantSelector._input.value = '';
        PlantSelector._reflectSelection();
        PlantSelector._input.focus();
      });

      document.addEventListener('click', e => {
        if (!PlantSelector._root.contains(e.target)) PlantSelector._closeDropdown();
      });

      Store.subscribe(evt => {
        if (evt.type === 'plant:selected') {
          if (evt.source !== 'header') PlantSelector._reflectSelection();
        }
        if (evt.type === 'tasks:bulk' || evt.type === 'lineSettings:change') {
          PlantSelector._refreshOptions();
        }
      });

      PlantSelector._refreshOptions();
      PlantSelector._reflectSelection();
    },

    _refreshOptions() {
      PlantSelector._options = Store.knownPlants();
    },

    _reflectSelection() {
      const plant = Store.selectedPlant;
      const isSet = !!plant;
      PlantSelector._input.value = isSet ? `${plant}` : '';
      PlantSelector._combobox.classList.toggle('has-value', isSet);
      PlantSelector._clearBtn.hidden = !isSet;
    },

    _restoreLabel() {
      // After blur, reset the typed query back to the canonical "Plant <id>" label.
      PlantSelector._reflectSelection();
    },

    _openDropdown() {
      PlantSelector._dropdown.hidden = false;
      PlantSelector._open = true;
      PlantSelector._input.setAttribute('aria-expanded', 'true');
    },
    _closeDropdown() {
      PlantSelector._dropdown.hidden = true;
      PlantSelector._open = false;
      PlantSelector._activeIdx = -1;
      PlantSelector._input.setAttribute('aria-expanded', 'false');
    },

    _renderDropdown(query) {
      const q = (query || '').trim().toLowerCase();
      // If the input still holds the canonical plant label, do not use
      // it as a filter — show the full list.
      const looksLikeLabel = Store.selectedPlant
        && query.trim().toLowerCase() === `${Store.selectedPlant}`.toLowerCase();
      const filterQ = looksLikeLabel ? '' : q;
      PlantSelector._filtered = filterQ
        ? PlantSelector._options.filter(p => p.toLowerCase().includes(filterQ))
        : PlantSelector._options.slice();

      if (!PlantSelector._filtered.length) {
        PlantSelector._dropdown.innerHTML =
          `<div class="hps-empty">${PlantSelector._options.length ? 'No matches' : 'No plant data loaded'}</div>`;
        PlantSelector._activeIdx = -1;
        return;
      }
      const sel = Store.selectedPlant;
      PlantSelector._dropdown.innerHTML = PlantSelector._filtered.map((p, i) => {
        const isSel = p === sel;
        return `<div class="hps-option${isSel ? ' selected' : ''}" role="option" data-plant="${p}" data-idx="${i}">
          <span class="hps-option-prefix">Plant</span><span>${p}</span>
        </div>`;
      }).join('');
      PlantSelector._activeIdx = Math.max(0, PlantSelector._filtered.indexOf(sel));
      PlantSelector._highlightActive();
      PlantSelector._dropdown.querySelectorAll('.hps-option').forEach(el => {
        el.addEventListener('mousedown', e => {
          e.preventDefault();
          PlantSelector._select(el.dataset.plant);
        });
      });
    },

    _highlightActive() {
      const items = PlantSelector._dropdown.querySelectorAll('.hps-option');
      items.forEach((el, i) => el.classList.toggle('active', i === PlantSelector._activeIdx));
      const active = items[PlantSelector._activeIdx];
      if (active) active.scrollIntoView({ block: 'nearest' });
    },

    _onKeydown(e) {
      if (!PlantSelector._open) {
        if (e.key === 'ArrowDown' || e.key === 'Enter') {
          PlantSelector._renderDropdown(PlantSelector._input.value);
          PlantSelector._openDropdown();
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        PlantSelector._activeIdx = Math.min(PlantSelector._activeIdx + 1, PlantSelector._filtered.length - 1);
        PlantSelector._highlightActive();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        PlantSelector._activeIdx = Math.max(PlantSelector._activeIdx - 1, 0);
        PlantSelector._highlightActive();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = PlantSelector._filtered[PlantSelector._activeIdx];
        if (pick) PlantSelector._select(pick);
      } else if (e.key === 'Escape') {
        PlantSelector._closeDropdown();
        PlantSelector._restoreLabel();
        PlantSelector._input.blur();
      }
    },

    _select(plant) {
      Store.setSelectedPlant(plant, 'header');
      PlantSelector._reflectSelection();
      PlantSelector._closeDropdown();
      PlantSelector._input.blur();
    }
  };

  /* =============================================================================
     WELCOME SPLASH — one-time page-load overlay directing the user to pick a plant.
     Shows on boot (only when selectedPlant is null) and self-dismisses on
     plant:selected. Never re-shows mid-session even if the plant is cleared.
     ========================================================================== */
  const WelcomeSplash = (() => {
    let _el    = null;   // root overlay element
    let _svg   = null;   // arrow SVG element
    let _rafId = null;   // rAF loop id for live arrow positioning
    let _shown = false;  // one-shot guard

    function _buildDOM() {
      const root = document.createElement('div');
      root.className = 'welcome-splash';
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-label', 'Welcome to NIMBUS — select a plant to begin');

      const card = document.createElement('div');
      card.className = 'welcome-splash-card';

      card.innerHTML = `
        <div class="ws-orb">🧹</div>
        <div class="ws-title">${t('ui.welcome_title')}</div>
        <p class="ws-subtitle">${t('ui.welcome_subtitle')}</p>`;

      root.appendChild(card);
      return root;
    }

    function _buildArrowSVG() {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'ws-arrow-svg');
      svg.setAttribute('aria-hidden', 'true');

      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      defs.innerHTML = `
        <filter id="ws-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.5" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>`;
      svg.appendChild(defs);

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'rgba(184,121,26,0.70)');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-dasharray', '5 4');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('filter', 'url(#ws-glow)');
      svg.appendChild(path);

      const arrowHead = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      arrowHead.setAttribute('class', 'ws-arrow-tip');
      arrowHead.setAttribute('fill', 'rgba(184,121,26,0.90)');
      arrowHead.setAttribute('filter', 'url(#ws-glow)');
      svg.appendChild(arrowHead);

      svg._path      = path;
      svg._arrowHead = arrowHead;
      return svg;
    }

    function _positionArrow() {
      if (!_el || !_svg) return;
      const plantEl = document.getElementById('header-plant-selector');
      const card    = _el.querySelector('.welcome-splash-card');
      if (!plantEl || !card) return;

      const pr = plantEl.getBoundingClientRect();
      const cr = card.getBoundingClientRect();

      // Arrow base: left-center of card
      const x0 = cr.left - 10;
      const y0 = cr.top + cr.height / 2;

      // Arrow tip: bottom-middle of plant selector
      const x1 = pr.left + pr.width * 0.25;
      const y1 = pr.bottom + 6;

      // L-shaped path: go left to plant selector's X, then straight up to its bottom
      const cornerX = x1;
      const cornerY = y0;
      _svg._path.setAttribute('d', `M ${x0} ${y0} L ${cornerX} ${cornerY} L ${x1} ${y1}`);

      // Arrowhead: pointing along the final vertical segment (upward)
      const angle = Math.atan2(y1 - cornerY, x1 - cornerX);
      const hs = 8; // half-spread of arrowhead base
      const al = 14; // length of arrowhead
      const bx = x1 - Math.cos(angle) * al;
      const by = y1 - Math.sin(angle) * al;
      const lx = bx + Math.cos(angle + Math.PI / 2) * hs;
      const ly = by + Math.sin(angle + Math.PI / 2) * hs;
      const rx = bx - Math.cos(angle + Math.PI / 2) * hs;
      const ry = by - Math.sin(angle + Math.PI / 2) * hs;
      _svg._arrowHead.setAttribute('points', `${x1},${y1} ${lx},${ly} ${rx},${ry}`);
    }

    function _startArrowLoop() {
      function tick() {
        _positionArrow();
        _rafId = requestAnimationFrame(tick);
      }
      _rafId = requestAnimationFrame(tick);
    }

    function _stopArrowLoop() {
      if (_rafId != null) { cancelAnimationFrame(_rafId); _rafId = null; }
    }

    return {
      init() {
        if (_shown) return;
        _shown = true;

        _el  = _buildDOM();
        _svg = _buildArrowSVG();
        document.body.appendChild(_el);
        document.body.appendChild(_svg);
        document.body.classList.add('welcome-active');

        // Position arrow immediately, then keep it live as viewport changes.
        requestAnimationFrame(() => { _positionArrow(); _startArrowLoop(); });

        Store.subscribe(evt => {
          if (evt.type === 'plant:selected' && evt.plant) WelcomeSplash.dismiss();
        });

        // Pause the rAF loop when the tab is hidden so we're not burning CPU
        // doing layout thrash for a viewport nobody is looking at.
        if (typeof App !== 'undefined' && App.registerPausable) {
          App.registerPausable(WelcomeSplash);
        }
      },

      pause() { _stopArrowLoop(); },
      resume() { if (_el && _rafId == null) _startArrowLoop(); },

      dismiss() {
        if (!_el) return;
        _stopArrowLoop();
        document.body.classList.remove('welcome-active');
        _el.classList.add('ws-dismissing');
        if (_svg) _svg.style.opacity = '0';
        if (_svg) _svg.style.transition = 'opacity 0.35s ease-in';
        setTimeout(() => {
          _el?.remove();  _el  = null;
          _svg?.remove(); _svg = null;
        }, 460);
      },
    };
  })();

  /* =============================================================================
     APP — bootstrap, tab switching, side-panel + resize handles.
     ========================================================================== */
  const App = {
    _currentTab: 'home',
    _currentMasterSub: 'lines',
    _ganttSub: 'timeline',
    _laborSub: 'aggregate',
    _pausables: new Set(),

    // Register any object with pause()/resume() to be auto-paused on tab hide.
    registerPausable(obj) {
      if (obj && (typeof obj.pause === 'function' || typeof obj.resume === 'function')) {
        App._pausables.add(obj);
      }
    },

    init() {
      /* Apply locale translations to static HTML elements */
      document.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = t(el.dataset.i18n);
      });
      document.querySelectorAll('[data-i18n-title]').forEach(el => {
        el.title = t(el.dataset.i18nTitle);
      });
      document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = t(el.dataset.i18nPlaceholder);
      });

      /* Tab buttons */
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.onclick = () => App.goto(btn.dataset.tab);
      });

      /* Manage Master Data sub-tabs (Production Lines / Plant) */
      document.querySelectorAll('.md-master-subtabs .admin-subtab').forEach(btn => {
        btn.onclick = () => App.gotoMasterSub(btn.dataset.mdMaster);
      });

      /* Timeline toolbar view buttons */
      document.querySelectorAll('.gantt-toolbar .seg-btn[data-view]').forEach(btn => {
        btn.onclick = () => Timeline.setView(btn.dataset.view);
      });

      /* Alert bell */
      document.getElementById('alert-bell').onclick = () => Alerts.toggleDrawer();

      /* Resize handles for side panels */
      App._wireResize('left',  document.getElementById('left-sidebar'));
      App._wireResize('right', document.getElementById('right-sidebar'));

      /* Right inspector collapsed on load — reopens automatically when an order is clicked */
      document.getElementById('right-sidebar').classList.add('collapsed');

      /* Modal backdrop click = close */
      document.querySelectorAll('.modal-backdrop').forEach(b => {
        b.addEventListener('click', e => { if (e.target === b) Modal.close(b.id); });
      });

      /* Autosave on store mutations */
      Store.subscribe(() => Persistence._autosave());

      /* Track which tasks need to be written to the backend on next saveAll() */
      Store.subscribe(evt => {
        if (evt.type === 'task:update')      Persistence._dirtyIds.add(String(evt.id));
        if (evt.type === 'tasks:bulkUpdate') evt.ids.forEach(id => Persistence._dirtyIds.add(String(id)));
        if (evt.type === 'tasks:bulk')       Persistence._dirtyIds.clear();
      });

      /* Reload tasks when the user switches to a different plant */
      Store.subscribe(evt => {
        if (evt.type === 'plant:selected' && evt.plant && evt.source !== 'restore') {
          Persistence.loadForPlant(evt.plant);
        }
      });

      /* Keep alerts + dashboard in sync */
      Store.subscribe(evt => {
        // Any change touching schedule/fixed/calendar → recompute alerts.
        if (evt.type === 'task:update' || evt.type === 'tasks:bulk'
            || evt.type === 'tasks:bulkUpdate' || evt.type === 'fixed:change'
            || evt.type === 'calendar:change' || evt.type === 'blocks:change'
            || evt.type === 'plantBlocks:change') {
            Alerts.scheduleRecompute();
        }
        // Alert drawer always reflects current state if open
        if (evt.type === 'alerts:change') {
          const d = document.getElementById('alert-drawer');
          if (d && d.classList.contains('open') && typeof Alerts._renderDrawer === 'function') Alerts._renderDrawer();
          Alerts._renderBell();
        }
        // Blocks / calendar changes → re-render whichever sub-tab is active
        const onMaster = (sub) => App._currentTab === 'masterdata' && App._currentMasterSub === sub;
        if (evt.type === 'blocks:change' || evt.type === 'calendar:change') {
          if (onMaster('plant')) Plant.render();
          if (onMaster('lines')) ProdLines.render();
        }
        if (evt.type === 'plantBlocks:change') {
          if (onMaster('plant')) Plant.render();
          if (onMaster('lines')) ProdLines.render();
        }
        if (evt.type === 'lineSettings:change') {
          if (onMaster('plant')) Plant.render();
          if (onMaster('lines')) ProdLines.render();
        }
        if (evt.type === 'plant:selected') {
          ProdLines._lineFilter = '';
          if (onMaster('lines')) ProdLines.render();
        }
      });

      /* Redraw on window resize */
      window.addEventListener('resize', Util.debounce(() => {
        if (App._currentTab === 'gantt') Timeline.redraw();
        if (App._currentTab === 'home') {
          if (Dashboard._chartToday) Dashboard._chartToday.resize();
        }
      }, 120));

      /* Pause rAF loops and admin polling when the tab is hidden — saves CPU
         when the user has the app open but is in a different tab. */
      document.addEventListener('visibilitychange', () => {
        const hidden = document.hidden;
        App._pausables.forEach(p => {
          try { hidden ? p.pause?.() : p.resume?.(); }
          catch (e) { ErrorLog.warn('visibility', `Pausable threw: ${e.message}`); }
        });
        if (hidden) {
          try { AdminCockpit._stopHealthPolling?.(); } catch {}
        } else if (App._currentTab === 'admin') {
          try { AdminCockpit._startHealthPolling?.(); } catch {}
        }
      });
    },

    goto(tab) {
      // Redirect legacy 'table' references to the Orders sub-tab inside Scheduling Board
      if (tab === 'table') { App.goto('gantt'); App.gotoGanttSub('orders'); return; }

      // Collapse line accordions when leaving the masterdata tab entirely
      if (App._currentTab === 'masterdata' && tab !== 'masterdata') {
        document.querySelectorAll('details.line-accordion[open]').forEach(d => d.removeAttribute('open'));
      }
      if (App._currentTab === 'admin' && tab !== 'admin') {
        try { AdminCockpit._stopHealthPolling(); } catch {}
      }
      if (App._currentTab && App._currentTab !== tab) App._prevTab = App._currentTab;
      App._currentTab = tab;
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(tab + '-tab').classList.add('active');
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
      });
      if (tab === 'gantt') {
        App.gotoGanttSub(App._ganttSub || 'timeline');
      } else if (tab === 'home') {
        setTimeout(() => Dashboard.render(), 30);
      } else if (tab === 'masterdata') {
        setTimeout(() => {
          if (App._currentMasterSub === 'plant') Plant.render();
          else ProdLines.render();
        }, 30);
      } else if (tab === 'admin') {
        setTimeout(() => AdminCockpit.render(), 30);
      } else if (tab === 'labor') {
        setTimeout(() => App.gotoLaborSub(App._laborSub || 'aggregate'), 30);
      }
    },

    gotoGanttSub(sub) {
      if (!['timeline', 'orders'].includes(sub)) return;
      App._ganttSub = sub;
      document.querySelectorAll('.gantt-toolbar .seg-btn[data-gantt-sub]').forEach(b => {
        b.classList.toggle('active', b.dataset.ganttSub === sub);
      });
      const timelinePane = document.getElementById('gantt-sub-timeline');
      const ordersPane   = document.getElementById('gantt-sub-orders');
      if (timelinePane) timelinePane.style.display = sub === 'timeline' ? 'flex' : 'none';
      if (ordersPane)   ordersPane.style.display   = sub === 'orders'   ? 'flex' : 'none';
      const show = sub === 'timeline';
      ['gantt-zoom-controls', 'gantt-zoom-sep', 'gantt-fit-controls'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = show ? '' : 'none';
      });
      if (sub === 'orders') {
        setTimeout(() => Table._api && Table._api.sizeColumnsToFit(), 30);
      } else {
        setTimeout(() => {
          Timeline.redraw(); Timeline.rebuild(); Hierarchy.render();
          GanttFilter._apply();
          TimelineNav.render();
          if (DependencyOverlay._enabled) DependencyOverlay.render();
        }, 30);
      }
    },

    gotoLaborSub(sub) {
      const valid = ['aggregate','line-plan','capacity','exceptions','inputs'];
      if (!valid.includes(sub)) return;
      App._laborSub = sub;
      document.querySelectorAll('.labor-toolbar .seg-btn[data-labor-sub]').forEach(b => {
        b.classList.toggle('active', b.dataset.laborSub === sub);
      });
      valid.forEach(s => {
        const el = document.getElementById(`labor-sub-${s}`);
        if (el) el.style.display = s === sub ? 'flex' : 'none';
      });
      if (App._currentTab === 'labor') {
        const plant = Store.selectedPlant;
        if (plant) setTimeout(() => LaborPlanning.render(), 30);
      }
    },

    gotoMasterSub(sub) {
      if (!['lines', 'plant'].includes(sub)) return;
      // Collapse line accordions when switching away from the lines sub-tab
      if (App._currentMasterSub === 'lines' && sub !== 'lines') {
        document.querySelectorAll('details.line-accordion[open]').forEach(d => d.removeAttribute('open'));
      }
      App._currentMasterSub = sub;
      document.querySelectorAll('.md-master-subtabs .admin-subtab').forEach(b => {
        b.classList.toggle('active', b.dataset.mdMaster === sub);
      });
      const linesPane = document.getElementById('md-master-lines-pane');
      const plantPane = document.getElementById('md-master-plant-pane');
      if (linesPane) linesPane.hidden = (sub !== 'lines');
      if (plantPane) {
        if (sub === 'plant') { plantPane.style.display = 'flex'; plantPane.removeAttribute('hidden'); }
        else { plantPane.style.display = ''; plantPane.setAttribute('hidden', ''); }
      }
      // Only trigger render when the masterdata tab is currently visible
      if (App._currentTab === 'masterdata') {
        setTimeout(() => {
          if (sub === 'plant') Plant.render();
          else ProdLines.render();
        }, 30);
      }
    },

    _renderSettingsPane() {
      const pane = document.getElementById('plant-tab-settings');
      if (!pane) return;
      const plantName = Store.selectedPlant;
      const plantRow  = Store._state.masterData?.plants?.find(p => p.plant === plantName) ?? null;
      // Values stored as total minutes in DB
      const alertHz = plantRow?.alt_flag_horizon   ?? Store.userSettings.alertHorizonMinutes   ?? 43200;
      const confHz  = plantRow?.conf_score_horizon ?? Store.userSettings.confidenceHorizonMinutes ?? 20160;

      pane.innerHTML = `
        <div class="cal-scroll"><div class="cal-container">
          <header class="cal-head">
            <div>
              <h2>${t('ui.system_settings_title')}</h2>
              <p class="sub">${t('ui.system_settings_sub', { plant: plantName || 'the selected plant' })}</p>
            </div>
          </header>
          <div style="display:flex;flex-direction:column;gap:24px;padding:8px 0 32px">

            <div class="panel">
              <header class="panel-head"><h3>Alert Horizon</h3></header>
              <div class="panel-body">
                <p style="margin:0 0 12px;font-size:13px;color:var(--fg-mute)">Controls which alerts appear in the header badge and alert drawer. Orders beyond the selected window are hidden to reduce noise. The window rolls with the current clock continuously.</p>
                <div style="display:flex;align-items:center;gap:8px;font-size:13px">
                  <span style="min-width:160px">Show alerts within the next</span>
                  <input type="number" id="sys-alert-horizon-days" class="form-input" min="1" max="60" step="1"
                         style="width:64px;text-align:right" placeholder="0">
                  <span>days</span>
                </div>
              </div>
            </div>

            <div class="panel">
              <header class="panel-head"><h3>Confidence Score Horizon</h3></header>
              <div class="panel-body">
                <p style="margin:0 0 12px;font-size:13px;color:var(--fg-mute)">The rolling window used to compute the schedule confidence score. Shorter windows surface near-term risk more sharply; longer windows give a broader health picture. The window rolls with the current clock continuously.</p>
                <div style="display:flex;align-items:center;gap:8px;font-size:13px">
                  <span style="min-width:160px">Score covers the next</span>
                  <input type="number" id="sys-conf-horizon-days" class="form-input" min="1" step="1"
                         style="width:64px;text-align:right" placeholder="0">
                  <span>days</span>
                </div>
              </div>
            </div>

          </div>
        </div></div>`;

      const alertDaysInp = pane.querySelector('#sys-alert-horizon-days');
      const confDaysInp  = pane.querySelector('#sys-conf-horizon-days');

      alertDaysInp.value = Math.max(1, Math.round(alertHz / 1440));
      confDaysInp.value  = Math.max(1, Math.round(confHz  / 1440));

      async function _savePlantHorizon(patch) {
        if (!plantRow) { Toast.show(t('toast.no_plant_selected'), 'warn'); return; }
        Object.assign(plantRow, patch);
        try {
          await fetch(`${Config.API_BASE}/master-data/plants/bulk`, {
            method:  'POST',
            headers: { 'content-type': 'application/json', 'x-user-email': 'trevor.holton@newellco.com' },
            body:    JSON.stringify({ upserts: [{ subnetwork: plantRow.subnetwork, plant: plantRow.plant, ...patch }], deletes: [] }),
          });
        } catch (e) {
          Toast.show(t('toast.horizon_save_failed', { msg: e.message }), 'error');
        }
      }

      function readAlertMinutes() {
        const days = Math.max(1, parseInt(alertDaysInp.value, 10) || 1);
        return days * 1440;
      }

      function readConfMinutes() {
        const days = Math.max(1, parseInt(confDaysInp.value, 10) || 1);
        return days * 1440;
      }

      async function saveAlert() {
        const totalMin = readAlertMinutes();
        Store.setUserSettings({ alertHorizonMinutes: totalMin }, 'system-settings');
        await _savePlantHorizon({ alt_flag_horizon: totalMin });
        Alerts._renderBell();
        if (document.getElementById('alert-drawer')?.classList.contains('open')) Alerts._renderDrawer();
      }

      async function saveConf() {
        const totalMin = readConfMinutes();
        Store.setUserSettings({ confidenceHorizonMinutes: totalMin }, 'system-settings');
        await _savePlantHorizon({ conf_score_horizon: totalMin });
        if (typeof NIMBUS !== 'undefined' && NIMBUS.Confidence?._recomputeDebounced)
          NIMBUS.Confidence._recomputeDebounced();
      }

      alertDaysInp.addEventListener('change', saveAlert);
      confDaysInp.addEventListener('change', saveConf);
    },

    toggleSide(which) {
      const el = document.getElementById(which === 'left' ? 'left-sidebar' : 'right-sidebar');
      if (el) {
        el.classList.toggle('collapsed');
        if (which === 'left') {
          const btn = el.querySelector('.side-head .icon-btn');
          if (btn) btn.textContent = el.classList.contains('collapsed') ? '▶' : '◀';
        }
      }
      setTimeout(() => { Timeline.redraw(); TimelineNav.render(); }, 220);
    },

    _wireResize(side, el) {
      const handle = el.querySelector('.resize-handle');
      if (!handle) return;
      let dragging = false;
      handle.addEventListener('mousedown', e => {
        dragging = true; document.body.style.cursor = 'ew-resize'; e.preventDefault();
      });
      window.addEventListener('mousemove', e => {
        if (!dragging) return;
        const w = side === 'left' ? e.clientX : window.innerWidth - e.clientX;
        if (w > 60 && w < 600) el.style.width = w + 'px';
      });
      window.addEventListener('mouseup', () => {
        if (dragging) { dragging = false; document.body.style.cursor = ''; Timeline.redraw(); }
      });
    }
  };

  /* =============================================================================
     MASTER DATA — Manage Data Tables admin sub-tab UI (Subnetwork / Plant / Production Line)
     ========================================================================== */
  const MasterData = (() => {
    const API = Config.API_BASE;
    let _activeTable = 'subnetworks';
    // Per-table state: { columns, rows, dirty: Map(rowKey→patch), deleted: Set(rowKey), added: [] }
    const _cache = {};

    const TABLE_LABELS = {
      subnetworks:      'Subnetworks',
      plants:           'Plants',
      production_lines: 'Production Lines',
      materials:        'Material',
      material_plants:  'Material Plant',
    };

    // KEY_COLS drives primary-key identification per table.
    const KEY_COLS = {
      subnetworks:      ['code'],
      plants:           ['subnetwork', 'plant'],
      production_lines: ['subnetwork', 'plant', 'production_line'],
      materials:        ['material_id'],
      material_plants:  ['material_id', 'plant'],
    };

    // Tables that need a parent-dropdown for FK columns.
    const FK_SOURCE = {
      plants:           { subnetwork: 'subnetworks' },
      production_lines: { subnetwork: 'subnetworks', plant: 'plants' },
      material_plants:  { material_id: 'materials' },
    };

    function _rowKey(table, row) {
      return KEY_COLS[table].map(k => String(row[k] ?? '')).join('|');
    }

    function _parsePaste(rawText, columns) {
      const lines = rawText.replace(/\r/g, '').split('\n').filter(l => l.trim());
      if (!lines.length) return { rows: [] };
      const colNames  = columns.map(c => c.column_name.toLowerCase());
      const colLabels = columns.map(c => (c.display_label || c.column_name).toLowerCase());
      const first     = lines[0].split('\t').map(h => h.trim().toLowerCase());
      const hasHeader = first.some(h => colNames.includes(h) || colLabels.includes(h));
      let headers, dataLines;
      if (hasHeader) {
        headers   = first.map(h => {
          const ni = colNames.indexOf(h);
          if (ni >= 0) return columns[ni].column_name;
          const li = colLabels.indexOf(h);
          return li >= 0 ? columns[li].column_name : h;
        });
        dataLines = lines.slice(1);
      } else {
        headers   = columns.map(c => c.column_name);
        dataLines = lines;
      }
      const rows = dataLines.map(line => {
        const vals = line.split('\t');
        const row  = {};
        headers.forEach((h, i) => { row[h] = (vals[i] ?? '').trim(); });
        return row;
      });
      return { rows };
    }

    // -----------------------------------------------------------------------
    // Public entry point
    // -----------------------------------------------------------------------
    function render() {
      // Wire inner tabs on first call.
      document.querySelectorAll('.md-tab').forEach(b => {
        b.onclick = () => _setTab(b.dataset.mdTab);
      });
      _syncTabUI();
      _loadAndRender(_activeTable);
    }

    function _setTab(table) {
      _activeTable = table;
      _syncTabUI();
      _loadAndRender(table);
    }

    function _syncTabUI() {
      document.querySelectorAll('.md-tab').forEach(b =>
        b.classList.toggle('active', b.dataset.mdTab === _activeTable));
    }

    // -----------------------------------------------------------------------
    // Data loading
    // -----------------------------------------------------------------------
    async function _loadAndRender(table) {
      const host = document.getElementById('md-host');
      if (!host) return;
      host.innerHTML = `<div class="md-loading">${t('ui.loading')}</div>`;
      try {
        const data = await fetch(`${API}/master-data/${table}`).then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
        _cache[table] = {
          columns: data.columns,
          rows:    data.rows,
          dirty:   new Map(),
          deleted: new Set(),
          added:   [],
        };
        _renderTable(table);
      } catch (e) {
        host.innerHTML = `<div class="md-empty">Failed to load ${TABLE_LABELS[table]}: ${e.message}</div>`;
        ErrorLog.error('master-data', `Load failed for ${table}: ${e.message}`);
      }
    }

    // -----------------------------------------------------------------------
    // Table rendering
    // -----------------------------------------------------------------------
    function _renderTable(table) {
      const host = document.getElementById('md-host');
      if (!host) return;
      const state = _cache[table];
      if (!state) return;

      const { columns, rows, dirty, deleted, added } = state;
      const allRows = [...rows, ...added];
      const isDirty = dirty.size > 0 || deleted.size > 0 || added.length > 0;

      host.innerHTML = '';

      // -- Toolbar --
      const toolbar = document.createElement('div');
      toolbar.className = 'md-toolbar';

      const searchInput = document.createElement('input');
      searchInput.type = 'search';
      searchInput.className = 'input md-search';
      searchInput.placeholder = t('ph.search_table', { table: TABLE_LABELS[table] });
      searchInput.oninput = () => _applyFilter(table, searchInput.value.toLowerCase());
      toolbar.appendChild(searchInput);

      const spacer = document.createElement('span');
      spacer.className = 'spacer';
      toolbar.appendChild(spacer);

      if (isDirty) {
        const badge = document.createElement('span');
        badge.className = 'md-dirty-badge';
        const n = dirty.size + deleted.size + added.length;
        badge.textContent = t('ui.unsaved_badge', { count: n });
        toolbar.appendChild(badge);
      }

      const addRowBtn = document.createElement('button');
      addRowBtn.className = 'btn btn-ghost sm';
      addRowBtn.textContent = t('btn.add_row');
      addRowBtn.onclick = () => _addRow(table);
      toolbar.appendChild(addRowBtn);

      const pasteBtn = document.createElement('button');
      pasteBtn.className = 'btn btn-ghost sm';
      pasteBtn.textContent = t('btn.paste_rows');
      pasteBtn.title = t('tip.paste_rows');
      pasteBtn.onclick = () => _pasteRows(table);
      toolbar.appendChild(pasteBtn);

      const addColBtn = document.createElement('button');
      addColBtn.className = 'btn btn-ghost sm';
      addColBtn.textContent = t('btn.add_column');
      addColBtn.onclick = () => _openAddColumn(table);
      toolbar.appendChild(addColBtn);

      const discardBtn = document.createElement('button');
      discardBtn.className = 'btn btn-ghost sm';
      discardBtn.textContent = t('btn.discard');
      discardBtn.disabled = !isDirty;
      discardBtn.onclick = () => { delete _cache[table]; _loadAndRender(table); };
      toolbar.appendChild(discardBtn);

      const saveBtn = document.createElement('button');
      saveBtn.className = `btn btn-primary sm${isDirty ? '' : ' md-save-idle'}`;
      saveBtn.textContent = t('btn.save');
      saveBtn.disabled = !isDirty;
      saveBtn.onclick = () => _save(table);
      toolbar.appendChild(saveBtn);

      host.appendChild(toolbar);

      // -- Table --
      const wrap = document.createElement('div');
      wrap.className = 'md-table-wrap';

      const tbl = document.createElement('table');
      tbl.className = 'md-table';
      tbl.id = `md-tbl-${table}`;

      // Header
      const thead = document.createElement('thead');
      const hRow = document.createElement('tr');
      columns.forEach(col => {
        const th = document.createElement('th');
        th.className = 'md-th';
        const lbl = document.createElement('span');
        lbl.textContent = col.display_label;
        th.appendChild(lbl);

        // Column action menu (⋮)
        const menuBtn = document.createElement('button');
        menuBtn.className = 'md-col-menu-btn';
        menuBtn.textContent = '⋮';
        menuBtn.title = t('tip.col_options');
        menuBtn.onclick = e => { e.stopPropagation(); _openColMenu(table, col, menuBtn); };
        th.appendChild(menuBtn);

        hRow.appendChild(th);
      });
      // Blank header for delete button column
      hRow.appendChild(document.createElement('th'));
      thead.appendChild(hRow);
      tbl.appendChild(thead);

      // Body
      const tbody = document.createElement('tbody');
      tbody.id = `md-tbody-${table}`;

      if (!allRows.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = columns.length + 1;
        td.className = 'md-empty';
        td.textContent = t('empty.table_no_rows', { table: TABLE_LABELS[table] });
        tr.appendChild(td);
        tbody.appendChild(tr);
      } else {
        allRows.forEach(row => _appendRow(tbody, table, columns, row));
      }
      tbl.appendChild(tbody);
      wrap.appendChild(tbl);
      host.appendChild(wrap);
    }

    function _appendRow(tbody, table, columns, row) {
      const state = _cache[table];
      const key = _rowKey(table, row);
      const isNew = state.added.some(r => _rowKey(table, r) === key);
      const isDeleted = state.deleted.has(key);
      const isDirty = state.dirty.has(key);

      const tr = document.createElement('tr');
      tr.dataset.rowKey = key;
      tr.className = [
        isNew     ? 'md-row-new'     : '',
        isDeleted ? 'md-row-deleted' : '',
        isDirty   ? 'md-row-dirty'   : '',
      ].filter(Boolean).join(' ');

      columns.forEach(col => {
        const td = document.createElement('td');
        td.className = 'md-td';

        // FK columns get a <select> populated from parent table.
        const fkSources = FK_SOURCE[table] || {};
        if (fkSources[col.column_name] && !isNew) {
          // For existing rows, key columns are read-only.
          if (col.is_locked) {
            td.textContent = row[col.column_name] ?? '';
          } else {
            td.appendChild(_fkSelect(table, col.column_name, row[col.column_name], fkSources[col.column_name], key));
          }
        } else if (fkSources[col.column_name] && isNew) {
          td.appendChild(_fkSelect(table, col.column_name, row[col.column_name], fkSources[col.column_name], key));
        } else if (col.is_locked && !isNew) {
          // Key columns on saved rows are read-only.
          td.textContent = row[col.column_name] ?? '';
        } else {
          const cell = document.createElement('div');
          cell.contentEditable = isDeleted ? 'false' : 'true';
          cell.className = 'md-cell';
          cell.textContent = row[col.column_name] ?? '';
          cell.dataset.col = col.column_name;
          cell.dataset.rowKey = key;
          cell.oninput = () => _markDirty(table, key, col.column_name, cell.textContent);
          td.appendChild(cell);
        }
        tr.appendChild(td);
      });

      // Delete button
      const delTd = document.createElement('td');
      delTd.className = 'md-td md-td-action';
      if (!isDeleted) {
        const delBtn = document.createElement('button');
        delBtn.className = 'icon-btn md-del-btn';
        delBtn.title = t('tip.delete_row');
        delBtn.textContent = '🗑';
        delBtn.onclick = () => _deleteRow(table, key, tr);
        delTd.appendChild(delBtn);
      } else {
        const undoBtn = document.createElement('button');
        undoBtn.className = 'btn btn-ghost sm';
        undoBtn.textContent = t('btn.undo');
        undoBtn.onclick = () => { state.deleted.delete(key); _renderTable(table); };
        delTd.appendChild(undoBtn);
      }
      tr.appendChild(delTd);
      tbody.appendChild(tr);
    }

    function _fkSelect(table, colName, value, sourceTable, rowKey) {
      const sel = document.createElement('select');
      sel.className = 'input md-fk-select';
      // Populate from cache or fetch.
      const sourceState = _cache[sourceTable];
      const sourceRows = sourceState?.rows ?? [];
      const srcKeys = KEY_COLS[sourceTable];
      // For subnetworks: use 'code'. For plants when in production_lines: use 'plant'.
      const valCol = srcKeys[srcKeys.length - 1];
      const labelCol = sourceTable === 'subnetworks' ? 'name' : valCol;

      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = t('ui.select_placeholder');
      sel.appendChild(blank);
      const _optLabel = r => (r[labelCol] && labelCol !== valCol) ? `${r[valCol]} — ${r[labelCol]}` : r[valCol];
      sourceRows.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r[valCol];
        opt.textContent = _optLabel(r);
        if (r[valCol] === value) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.onchange = () => _markDirty(table, rowKey, colName, sel.value);

      // If source not loaded yet, fetch it.
      if (!sourceState) {
        fetch(`${API}/master-data/${sourceTable}`).then(r => r.json()).then(data => {
          _cache[sourceTable] = { columns: data.columns, rows: data.rows, dirty: new Map(), deleted: new Set(), added: [] };
          // Rebuild select options.
          while (sel.options.length > 1) sel.remove(1);
          data.rows.forEach(r => {
            const opt = document.createElement('option');
            opt.value = r[valCol];
            opt.textContent = _optLabel(r);
            if (r[valCol] === value) opt.selected = true;
            sel.appendChild(opt);
          });
        }).catch(() => {});
      }
      return sel;
    }

    function _markDirty(table, rowKey, colName, value) {
      const state = _cache[table];
      if (!state) return;
      const patch = state.dirty.get(rowKey) || _getRowByKey(table, rowKey) || {};
      patch[colName] = value;
      state.dirty.set(rowKey, patch);
      // Update the tr class to show dirty highlight.
      const tr = document.querySelector(`#md-tbody-${table} tr[data-row-key="${CSS.escape(rowKey)}"]`);
      if (tr) tr.classList.add('md-row-dirty');
      _updateSaveBtn(table);
    }

    function _getRowByKey(table, key) {
      const state = _cache[table];
      const all = [...(state?.rows ?? []), ...(state?.added ?? [])];
      return all.find(r => _rowKey(table, r) === key) ?? {};
    }

    function _updateSaveBtn(table) {
      const state = _cache[table];
      if (!state) return;
      const isDirty = state.dirty.size > 0 || state.deleted.size > 0 || state.added.length > 0;
      const saveBtn = document.querySelector('#md-host .btn-primary.sm');
      if (saveBtn) {
        saveBtn.disabled = !isDirty;
        saveBtn.classList.toggle('md-save-idle', !isDirty);
      }
      // Update dirty badge.
      const badge = document.querySelector('#md-host .md-dirty-badge');
      if (badge) {
        const n = state.dirty.size + state.deleted.size + state.added.length;
        badge.textContent = `${n} unsaved`;
        badge.hidden = !isDirty;
      }
    }

    function _addRow(table) {
      const state = _cache[table];
      if (!state) return;
      const newRow = {};
      state.columns.forEach(c => { newRow[c.column_name] = ''; });
      state.added.push(newRow);
      // Re-render to show the new row (simpler than appending).
      _renderTable(table);
      // Focus first editable cell of the new row.
      setTimeout(() => {
        const tbody = document.getElementById(`md-tbody-${table}`);
        const lastRow = tbody?.lastElementChild;
        const firstCell = lastRow?.querySelector('.md-cell');
        if (firstCell) firstCell.focus();
      }, 50);
    }

    async function _pasteRows(table) {
      let raw;
      try {
        raw = await navigator.clipboard.readText();
      } catch {
        Toast.show(t('toast.clipboard_denied'), 'error');
        return;
      }
      if (!raw.trim()) { Toast.show(t('toast.clipboard_empty'), 'error'); return; }

      const state = _cache[table];
      if (!state) return;

      const { rows } = _parsePaste(raw, state.columns);
      if (!rows.length) { Toast.show(t('toast.no_rows_paste'), 'error'); return; }

      const keys    = KEY_COLS[table];
      const toAdd   = [];
      const toUpdate = [];
      const invalid  = [];

      rows.forEach(row => {
        if (keys.find(k => !row[k])) { invalid.push(row); return; }
        const key = _rowKey(table, row);
        const inSaved    = state.rows.some(r => _rowKey(table, r) === key);
        const inAdded    = state.added.some(r => _rowKey(table, r) === key);
        const batchAddIdx = toAdd.findIndex(r => _rowKey(table, r) === key);
        const batchUpdIdx = toUpdate.findIndex(r => _rowKey(table, r) === key);
        if      (batchAddIdx >= 0)  toAdd[batchAddIdx]    = row; // last write wins within batch
        else if (batchUpdIdx >= 0)  toUpdate[batchUpdIdx] = row;
        else if (inSaved || inAdded) toUpdate.push(row);
        else                         toAdd.push(row);
      });

      if (!toAdd.length && !toUpdate.length) {
        Toast.show(invalid.length
          ? t('toast.missing_key_rows', { count: invalid.length, keys: keys.join(', ') })
          : t('toast.no_valid_rows'), 'error');
        return;
      }

      const parts = [];
      if (toAdd.length)    parts.push(`add ${toAdd.length} new`);
      if (toUpdate.length) parts.push(`update ${toUpdate.length} existing`);
      if (invalid.length)  parts.push(`skip ${invalid.length} invalid`);

      const ok = await Modal.confirm({
        title:   'Paste Rows',
        message: `This will ${parts.join(', ')} row(s).`,
        detail:  `Changes appear in the table but won't be saved until you click Save.` +
                 (invalid.length ? ` Skipped rows are missing key column(s): ${keys.join(', ')}.` : ''),
        tone:    'info',
      });
      if (!ok) return;

      toAdd.forEach(row => {
        const full = {};
        state.columns.forEach(c => { full[c.column_name] = row[c.column_name] ?? ''; });
        state.added.push(full);
      });

      toUpdate.forEach(row => {
        const key = _rowKey(table, row);
        const idx = state.rows.findIndex(r => _rowKey(table, r) === key);
        if (idx >= 0) {
          Object.assign(state.rows[idx], row);
          state.dirty.set(key, { ...state.rows[idx] });
        } else {
          const ai = state.added.findIndex(r => _rowKey(table, r) === key);
          if (ai >= 0) Object.assign(state.added[ai], row);
        }
      });

      _renderTable(table);
      Toast.show(invalid.length
        ? t('toast.paste_result_skip', { added: toAdd.length, updated: toUpdate.length, skipped: invalid.length })
        : t('toast.paste_result', { added: toAdd.length, updated: toUpdate.length }), 'success');
    }

    async function _deleteRow(table, rowKey, tr) {
      const state = _cache[table];
      if (!state) return;

      // Build delete payload from the key.
      const keys = KEY_COLS[table];
      const row = _getRowByKey(table, rowKey);
      const deletePayload = {};
      keys.forEach(k => { deletePayload[k] = row[k]; });

      // Get cascade preview for saved rows (not for newly-added rows).
      const isNew = state.added.some(r => _rowKey(table, r) === rowKey);
      let cascadeDetail = '';

      if (!isNew && (table === 'subnetworks' || table === 'plants')) {
        try {
          const preview = await fetch(`${API}/master-data/${table}/cascade-preview`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deletes: [deletePayload] }),
          }).then(r => r.json());

          const parts = [];
          if (preview.plants > 0)           parts.push(`<strong>${preview.plants}</strong> plant${preview.plants !== 1 ? 's' : ''}`);
          if (preview.production_lines > 0)  parts.push(`<strong>${preview.production_lines}</strong> production line${preview.production_lines !== 1 ? 's' : ''}`);
          if (parts.length) {
            cascadeDetail = `<div class="md-cascade-warn">This will also permanently delete ${parts.join(' and ')}.</div>`;
          }
        } catch {}
      }

      const keyDisplay = keys.map(k => row[k]).join(' / ');
      const confirmed = await Modal.confirm({
        title:         `Delete "${keyDisplay}"?`,
        message:       `Are you sure you want to delete this ${TABLE_LABELS[table].replace(/s$/, '').toLowerCase()} from the database?`,
        detail:        cascadeDetail || undefined,
        confirmLabel:  'Yes, delete',
        tone:          'danger',
      });
      if (!confirmed) return;

      if (isNew) {
        // Just remove from added array.
        const idx = state.added.findIndex(r => _rowKey(table, r) === rowKey);
        if (idx >= 0) state.added.splice(idx, 1);
        _renderTable(table);
      } else {
        state.deleted.add(rowKey);
        tr.className = 'md-row-deleted';
        _updateSaveBtn(table);
        _renderTable(table);
      }
    }

    // -----------------------------------------------------------------------
    // Save
    // -----------------------------------------------------------------------
    async function _save(table) {
      const state = _cache[table];
      if (!state) return;
      const keys = KEY_COLS[table];

      // Build upserts from dirty + added.
      const upserts = [];
      state.dirty.forEach((patch, _key) => { if (!state.deleted.has(_key)) upserts.push(patch); });
      state.added.forEach(row => {
        // Validate that key columns are filled.
        const missing = keys.filter(k => !row[k]);
        if (missing.length) {
          Toast.show(t('toast.no_plant_selected') + ': ' + missing.join(', '), 'error');
          return;
        }
        upserts.push(row);
      });

      // Build deletes.
      const deletes = [];
      state.deleted.forEach(rowKey => {
        const row = _getRowByKey(table, rowKey);
        const d = {};
        keys.forEach(k => { d[k] = row[k]; });
        deletes.push(d);
      });

      if (!upserts.length && !deletes.length) return;

      // Cascade confirmation for deletes that weren't already confirmed.
      if (deletes.length && (table === 'subnetworks' || table === 'plants')) {
        try {
          const preview = await fetch(`${API}/master-data/${table}/cascade-preview`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deletes }),
          }).then(r => r.json());
          const total = (preview.plants || 0) + (preview.production_lines || 0);
          if (total > 0) {
            const parts = [];
            if (preview.plants > 0)          parts.push(`${preview.plants} plant${preview.plants !== 1 ? 's' : ''}`);
            if (preview.production_lines > 0) parts.push(`${preview.production_lines} production line${preview.production_lines !== 1 ? 's' : ''}`);
            const ok = await Modal.confirm({
              title:         `Delete ${deletes.length} row${deletes.length !== 1 ? 's' : ''}?`,
              message:       `This will also permanently delete ${parts.join(' and ')}.`,
              detail:        '<strong>This cannot be undone.</strong>',
              confirmLabel:  `Yes, delete all`,
              tone:          'danger',
            });
            if (!ok) return;
          }
        } catch {}
      }

      try {
        const res = await fetch(`${API}/master-data/${table}/bulk`, {
          method:  'POST',
          headers: { 'content-type': 'application/json', 'x-user-email': 'trevor.holton@newellco.com' },
          body:    JSON.stringify({ upserts, deletes }),
        }).then(r => {
          if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); });
          return r.json();
        });

        Toast.show(
          t('toast.paste_result', { added: res.inserted, updated: res.updated }) + `, ${res.deleted} deleted`,
          'success'
        );
        delete _cache[table];
        await _loadAndRender(table);

        // Refresh master-data in Store so Hierarchy/ProdLines stay in sync.
        Promise.all([
          fetch(`${API}/master-data/plants`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
          fetch(`${API}/master-data/production_lines`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
        ]).then(([pData, lData]) => {
          if (pData || lData) {
            Store._state.masterData = {
              plants: pData?.rows ?? [],
              lines:  lData?.rows ?? [],
            };
          }
          Store.emit({ type: 'master-data-changed', table, source: 'master-data-save' });
        }).catch(() => {
          Store.emit({ type: 'master-data-changed', table, source: 'master-data-save' });
        });
      } catch (e) {
        Toast.show(t('toast.save_failed', { msg: e.message }), 'error');
        ErrorLog.error('master-data', `Save failed for ${table}: ${e.message}`);
      }
    }

    // -----------------------------------------------------------------------
    // Filter / search
    // -----------------------------------------------------------------------
    function _applyFilter(table, query) {
      const tbody = document.getElementById(`md-tbody-${table}`);
      if (!tbody) return;
      tbody.querySelectorAll('tr').forEach(tr => {
        const text = tr.textContent.toLowerCase();
        tr.hidden = query ? !text.includes(query) : false;
      });
    }

    // -----------------------------------------------------------------------
    // Column management
    // -----------------------------------------------------------------------
    function _openColMenu(table, col, anchor) {
      // Close any existing menu.
      document.querySelectorAll('.md-col-menu').forEach(m => m.remove());

      const menu = document.createElement('div');
      menu.className = 'md-col-menu';

      const rename = document.createElement('button');
      rename.className = 'md-col-menu-item';
      rename.textContent = t('btn.rename_label');
      rename.onclick = () => { menu.remove(); _openRenameLabel(table, col); };
      menu.appendChild(rename);

      const drop = document.createElement('button');
      drop.className = 'md-col-menu-item md-col-menu-danger';
      drop.textContent = t('btn.delete_column');
      drop.disabled = col.is_locked;
      drop.title = col.is_locked ? t('tip.key_cols_no_delete') : '';
      drop.onclick = () => { menu.remove(); _dropColumn(table, col); };
      menu.appendChild(drop);

      document.body.appendChild(menu);
      const rect = anchor.getBoundingClientRect();
      menu.style.top  = `${rect.bottom + 4}px`;
      menu.style.left = `${rect.left}px`;

      const close = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 0);
    }

    function _openAddColumn(table) {
      document.getElementById('md-col-name').value  = '';
      document.getElementById('md-col-label').value = '';
      document.getElementById('md-col-type').value  = 'TEXT';
      document.getElementById('md-col-length').value = '';
      document.getElementById('md-col-default').value = '';
      document.getElementById('md-col-nullable').checked = true;
      document.getElementById('md-addcol-error').textContent = '';
      document.getElementById('md-col-length-row').hidden = true;

      const typeSelect = document.getElementById('md-col-type');
      typeSelect.onchange = () => {
        document.getElementById('md-col-length-row').hidden = typeSelect.value !== 'NUMERIC';
      };

      document.getElementById('md-addcol-confirm-btn').onclick = async () => {
        const colName  = document.getElementById('md-col-name').value.trim();
        const label    = document.getElementById('md-col-label').value.trim() || colName;
        const sqlType  = document.getElementById('md-col-type').value;
        const length   = document.getElementById('md-col-length').value.trim() || null;
        const nullable = document.getElementById('md-col-nullable').checked;
        const def      = document.getElementById('md-col-default').value.trim() || null;
        const errEl    = document.getElementById('md-addcol-error');

        if (!colName) { errEl.textContent = t('ui.column_id_required'); return; }
        if (!/^[a-z][a-z0-9_]{0,62}$/.test(colName)) {
          errEl.textContent = t('ui.column_id_format');
          return;
        }
        if (!nullable && !def) {
          errEl.textContent = t('ui.not_null_requires_default');
          return;
        }

        Modal.close('md-addcol-modal');

        try {
          await fetch(`${API}/master-data/${table}/columns`, {
            method:  'POST',
            headers: { 'content-type': 'application/json', 'x-user-email': 'trevor.holton@newellco.com' },
            body:    JSON.stringify({ column_name: colName, sql_type: sqlType, length, nullable, default: def, display_label: label }),
          }).then(r => {
            if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); });
            return r.json();
          });
          Toast.show(t('toast.col_added', { label }), 'success');
          delete _cache[table];
          _loadAndRender(table);
        } catch (e) {
          Toast.show(t('toast.failed_add_col', { msg: e.message }), 'error');
        }
      };

      Modal.open('md-addcol-modal');
    }

    async function _dropColumn(table, col) {
      const confirmed = await Modal.confirm({
        title:         t('modal.drop_column_title', { label: col.display_label }),
        message:       t('modal.drop_column_msg', { name: col.column_name, table: TABLE_LABELS[table] }),
        detail:        `<strong>${t('modal.delete_cannot_undo')}</strong>`,
        confirmLabel:  t('modal.drop_column_confirm'),
        tone:          'danger',
      });
      if (!confirmed) return;

      try {
        await fetch(`${API}/master-data/${table}/columns/${col.column_name}`, {
          method:  'DELETE',
          headers: { 'x-user-email': 'trevor.holton@newellco.com' },
        }).then(r => {
          if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); });
          return r.json();
        });
        Toast.show(t('toast.column_dropped', { col: col.column_name }), 'success');
        delete _cache[table];
        _loadAndRender(table);
      } catch (e) {
        Toast.show(t('toast.failed_drop_column', { msg: e.message }), 'error');
      }
    }

    function _openRenameLabel(table, col) {
      const noteEl  = document.getElementById('md-rename-note');
      const inputEl = document.getElementById('md-rename-label-input');
      if (noteEl)  noteEl.textContent = `Column ID: "${col.column_name}" (unchanged) · Table: ${TABLE_LABELS[table]}`;
      if (inputEl) inputEl.value = col.display_label;

      document.getElementById('md-rename-confirm-btn').onclick = async () => {
        const newLabel = inputEl.value.trim();
        if (!newLabel) return;
        Modal.close('md-renamelabel-modal');
        try {
          await fetch(`${API}/master-data/${table}/columns/${col.column_name}`, {
            method:  'PATCH',
            headers: { 'content-type': 'application/json', 'x-user-email': 'trevor.holton@newellco.com' },
            body:    JSON.stringify({ display_label: newLabel }),
          }).then(r => {
            if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); });
            return r.json();
          });
          Toast.show(t('toast.column_label_updated', { label: newLabel }), 'success');
          delete _cache[table];
          _loadAndRender(table);
        } catch (e) {
          Toast.show(t('toast.failed_rename_label', { msg: e.message }), 'error');
        }
      };
      Modal.open('md-renamelabel-modal');
    }

    async function syncLineSettings(line, patch) {
      if (!_cache['production_lines']) {
        try {
          const data = await fetch(`${API}/master-data/production_lines`).then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          });
          _cache['production_lines'] = {
            columns: data.columns, rows: data.rows,
            dirty: new Map(), deleted: new Set(), added: [],
          };
        } catch { return; }
      }

      const state = _cache['production_lines'];
      const rowIdx = state.rows.findIndex(r => r.production_line === line);
      if (rowIdx < 0) return;

      const updatedRow = { ...state.rows[rowIdx] };
      if ('excludeFromOpt' in patch) updatedRow.excl_optimizer  = patch.excludeFromOpt ? 'X' : null;
      if ('bottleneck'     in patch) updatedRow.bottleneck      = patch.bottleneck     ? 'X' : null;
      if ('bufferUnit'     in patch) updatedRow.buffer_type     = patch.bufferUnit === 'pct' ? '%' : 'hrs';
      if ('bufferPct'      in patch) updatedRow.buffer_percent  = patch.bufferPct;
      if ('bufferHours'    in patch) updatedRow.buffer_hours    = patch.bufferHours;
      if ('plGroup'        in patch) updatedRow.pl_group        = patch.plGroup || null;

      // Update cache row and clear any stale dirty flag so MasterData table stays consistent.
      state.rows[rowIdx] = updatedRow;
      state.dirty.delete(_rowKey('production_lines', updatedRow));

      try {
        await fetch(`${API}/master-data/production_lines/bulk`, {
          method:  'POST',
          headers: { 'content-type': 'application/json', 'x-user-email': 'trevor.holton@newellco.com' },
          body:    JSON.stringify({ upserts: [updatedRow], deletes: [] }),
        }).then(r => {
          if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); });
          return r.json();
        });
        if (_activeTable === 'production_lines') _renderTable('production_lines');
      } catch (e) {
        ErrorLog.error('prod-lines', `Failed to save line setting: ${e.message}`);
      }
    }

    return { render, syncLineSettings };
  })();

  /* =============================================================================
     BOOTSTRAP
     ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
    // Global hard-error net (captures stack traces, normalized through ErrorLog).
    ErrorLog.installGlobalHandlers();
    // Defensively unregister any legacy service workers — none should be installed
    // but a prior experiment could leave one resident.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(rs => {
        if (rs.length) {
          ErrorLog.warn('boot', `Unregistering ${rs.length} legacy service worker(s)`);
          rs.forEach(r => r.unregister());
        }
      }).catch(() => {});
    }

    /* ---- Performance watchdogs (long-task, JS heap, main-thread freeze) ---- */
    try {
      if ('PerformanceObserver' in window &&
          PerformanceObserver.supportedEntryTypes &&
          PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            if (entry.duration > 250) {
              const attr = entry.attribution?.[0]?.name || 'n/a';
              ErrorLog.warn('perf', `longtask ${Math.round(entry.duration)}ms (attribution: ${attr})`);
            }
          }
        }).observe({ entryTypes: ['longtask'] });
      }
    } catch (e) { /* longtask API not supported */ }

    setInterval(() => {
      const m = performance && performance.memory;
      if (!m) return;
      const usedMB  = m.usedJSHeapSize  / 1048576;
      const limitMB = m.jsHeapSizeLimit / 1048576;
      const ratio   = usedMB / limitMB;
      if (ratio > 0.85) {
        ErrorLog.warn('memory',
          `JS heap ${usedMB.toFixed(0)}/${limitMB.toFixed(0)} MB (${Math.round(ratio * 100)}%)`);
      }
    }, 30_000);

    // Freeze watchdog: a setInterval that records actual elapsed time. If the
    // gap is much larger than the schedule, the main thread was blocked.
    let _lastTick = Date.now();
    setInterval(() => {
      const now   = Date.now();
      const drift = now - _lastTick;
      _lastTick = now;
      if (drift > 2000) {
        ErrorLog.warn('freeze', `Main thread blocked ~${drift - 1000}ms`);
      }
    }, 1000);

    // Ctrl+Alt+L → open Admin Cockpit log tab
    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'l') {
        e.preventDefault(); App.goto('admin');
      }
    });

    // ` (backtick) → go back to previous tab  |  Alt+H → Dashboard
    document.addEventListener('keydown', e => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (document.activeElement?.isContentEditable) return;
      if (e.key === '`' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (App._prevTab) App.goto(App._prevTab);
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        App.goto('home');
      }
    });

    try { Timeline.init();    } catch (e) { ErrorLog.error('boot', `Timeline.init: ${e.message}`); }
    try { Table.init();       } catch (e) { ErrorLog.error('boot', `Table.init: ${e.message}`); }
    try { Inspector.init();   } catch (e) { ErrorLog.error('boot', `Inspector.init: ${e.message}`); }
    try { Hierarchy.init();   } catch (e) { ErrorLog.error('boot', `Hierarchy.init: ${e.message}`); }
    try { Dashboard.init();   } catch (e) { ErrorLog.error('boot', `Dashboard.init: ${e.message}`); }
    try { ContextMenu.init(); } catch (e) { ErrorLog.error('boot', `ContextMenu.init: ${e.message}`); }
    try { GanttFilter.init();     } catch (e) { ErrorLog.error('boot', `GanttFilter.init: ${e.message}`); }
    try { AdminCockpit.init();    } catch (e) { ErrorLog.error('boot', `AdminCockpit.init: ${e.message}`); }
    try { LaborPlanning.init();   } catch (e) { ErrorLog.error('boot', `LaborPlanning.init: ${e.message}`); }

    // Refresh plant-aware modules when master data changes.
    // Writes lineSettings directly (no per-line emit) and fires a single coalesced
    // 'lineSettings:change' at the end to avoid an O(N*M) fan-out at boot.
    Store.subscribe(evt => {
      if (evt.type === 'master-data-changed') {
        let touched = 0;
        try {
          const mdLines = Store._state.masterData?.lines;
          if (mdLines?.length) {
            mdLines.forEach(row => {
              const line = row.production_line;
              if (!line) return;
              Store.ensureLineSettings(line);
              const ls = Store._state.lineSettings[line];
              const before = JSON.stringify(ls);
              ls.excludeFromOpt = row.excl_optimizer === 'X';
              ls.bottleneck     = row.bottleneck === 'X';
              if (row.buffer_type === '%')        ls.bufferUnit = 'pct';
              else if (row.buffer_type === 'hrs') ls.bufferUnit = 'hours';
              if (row.buffer_percent != null && row.buffer_percent !== '')
                ls.bufferPct = parseFloat(row.buffer_percent) || 0;
              if (row.buffer_hours != null && row.buffer_hours !== '')
                ls.bufferHours = parseFloat(row.buffer_hours) || 0;
              ls.plGroup = row.pl_group || '';
              if (JSON.stringify(ls) !== before) touched++;
            });
          }
        } catch (e) { ErrorLog.error('boot', `master-data lineSettings sync: ${e.message}`); }
        if (touched) Store.emit({ type: 'lineSettings:change', line: null, source: 'master-data-bulk' });
        try { if (typeof Hierarchy !== 'undefined') Hierarchy.render(); } catch {}
        try { if (typeof ProdLines !== 'undefined' && App._currentTab === 'masterdata' && App._currentMasterSub === 'lines') ProdLines.render(); } catch {}
      }
    });
    try { Plant.init();       } catch (e) { ErrorLog.error('boot', `Plant.init: ${e.message}`); }
    try { PlantSelector.init();  } catch (e) { ErrorLog.error('boot', `PlantSelector.init: ${e.message}`); }
    try { WelcomeSplash.init();  } catch (e) { ErrorLog.error('boot', `WelcomeSplash.init: ${e.message}`); }
    try { App.init();            } catch (e) { ErrorLog.error('boot', `App.init: ${e.message}`); }
    // ProdLines has no async init — it renders on-demand when its tab is activated.
    // TimelineNav init deferred until after first Timeline render
    setTimeout(() => { try { TimelineNav.init(); } catch (e) { ErrorLog.error('boot', `TimelineNav.init: ${e.message}`); } }, 150);
    // DependencyOverlay init deferred similarly
    setTimeout(() => { try { DependencyOverlay.init(); } catch (e) { ErrorLog.error('boot', `DependencyOverlay.init: ${e.message}`); } }, 160);
    // Sandbox init
    try { Sandbox.init(); } catch (e) { ErrorLog.error('boot', `Sandbox.init: ${e.message}`); }

    // Install the unified input pipeline AFTER Timeline + Table are up so
    // their internal DataSet / grid API exist when we wire the listeners.
    // Brief delay lets vis-timeline finish its first layout.
    setTimeout(() => {
      try { Interaction.install(); }
      catch (e) { ErrorLog.error('boot', `Interaction.install: ${e.message}`); }
    }, 80);

    ErrorLog._renderBadge();

    // Navigate to home only after the first task payload arrives so charts
    // have data on their first render (Persistence.load is async).
    const _firstLoad = Store.subscribe(evt => {
      if (evt.type === 'tasks:bulk') {
        _firstLoad();
        App.goto('home');
        // Anchor Gantt to today as the leftmost column on first visit (3-day Day view).
        setTimeout(() => Timeline.setView('day'), 200);
      }
    });
    // Stateless backend: scope the first load to the remembered plant so boot
    // doesn't pull every plant's order book. We intentionally do NOT set
    // Store.selectedPlant here — that keeps selectedPlant null so WelcomeSplash
    // still shows and the user still makes the explicit selection. When they pick
    // the same plant as last time, loadForPlant() no-ops (data already loaded);
    // if they pick a different one, it re-scopes. No remembered plant → unscoped.
    const _bootPlant = Persistence._rememberedPlant();
    Persistence.load(_bootPlant ? { plant: _bootPlant } : {});
  });

  /* Public namespace for inline onclick handlers in index.html */
  return {
    App, Engine, Alerts, Timeline, Table, Inspector,
    Dashboard, Calendar, Plant, ProdLines, Persistence, Modal, Toast, Store, Util, Config,
    Utilization, ContextMenu, Hierarchy,
    Selection, UndoStack, Interaction,
    ErrorLog, AdminCockpit,
    TimelineNav, GanttFilter, DependencyOverlay, Sandbox, Printer,
    OptimizeDialog, OptimizerPreview, EditCalendar, ColorWheelViewer,
    PlantSelector, EmptyState, MasterData, WelcomeSplash
  };
})();
