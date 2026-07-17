// schedule-workbench.mjs — CQ-1 schedule-workbench module.
//
// Owns the planner workspace: timeline, order grid, inspector, hierarchy,
// dashboard, navigation, filters, dependency overlay, context menu,
// interaction pipeline, and planner dialogs. Third-party instances
// (vis-timeline, AG Grid) stay private to this module. Also owns the
// SandboxAdapter/AlertsUIAdapter DOM remnants from Phase 1/2, whose coupling
// profile puts them here — see docs/architecture/cq1-compatibility-inventory.md.
//
// CQ-1 Phase 3 Task 1 added Timeline, TimelineNav, and DependencyOverlay;
// Task 2 added Table, Inspector, and ContextMenu; Task 3 adds Hierarchy and
// GanttFilter and closes GanttFilter's nimbus-intelligence.js private-consumer
// debt (see the note above GanttFilter below). Later tasks in this same
// phase add Dashboard (Task 4), Interaction (Task 5), OptimizeDialog/
// OptimizerPreview (Task 6), and EditCalendar/ColorWheelViewer/Printer/
// SandboxAdapter/AlertsUIAdapter (Task 7).
//
// Timeline still has five genuine cross-references reached via the shared
// `NIMBUS` binding rather than as bare identifiers — App.gotoGanttTimeline()
// (App never moves into this file; it targets application-shell.mjs in Phase
// 4), Inspector.show() (Inspector itself moved into THIS file in Task 2, but
// the Timeline.focus() call site was left as `NIMBUS.Inspector.show(...)`
// rather than simplified to a bare same-module reference, since it works
// identically either way and touching it isn't required by Task 2's scope),
// Interaction.DEBUG (moves here in Task 5), GanttFilter._selectedLines
// (GanttFilter itself moved into THIS file in Task 3, same rationale as
// Inspector.show() above — the call site was left as
// `NIMBUS.GanttFilter._selectedLines` rather than simplified to a bare
// same-module reference, since touching it isn't required by Task 3's
// scope), and EmptyState.render() (stays in app.js — boot UI, not
// part of this phase's module list). `NIMBUS` is declared at the
// classic-script's true top level (the const app.js assigns itself to), so it
// is part of the realm's shared global declarative scope and resolvable from
// any module on the same page — see index.html/app-entry.mjs. `web/**/*.mjs`
// files don't have `NIMBUS` in their ESLint global list (only web/app.js and
// web/nimbus-intelligence.js do), so it's declared via an in-file
// `/* global */` comment below rather than a config change (Global
// Constraints: eslint.config.js needs zero changes).
// Bare `t(...)` calls became `Util.t(...)` instead (the established Phase 2
// convention — see schedule-services.mjs), since `Util.t` is a real export
// and `window.t` is just a thin wrapper around it. Task 2's Table module has
// two similar bare cross-references into app.js-resident code that hasn't
// moved yet — `EmptyState.render(...)` and `AlertsUIAdapter.focus(...)` (the
// latter inside `_showAlertPopup`, a genuine cross-file reference in the
// wrong direction until `AlertsUIAdapter` moves here in Task 7) — both
// rewritten to go through the same shared `NIMBUS` binding as Timeline's five,
// for the identical reason (the referenced module hasn't moved into this file
// yet, so a bare identifier would not resolve inside a real ES module).
/* global NIMBUS */
import { Config, Util, PerfMonitor, ErrorLog, Toast, Modal, VirtualList } from './application-foundation.mjs';
import { Store, Selection } from './schedule-state.mjs';
import { Utilization, Alerts, Engine } from './schedule-services.mjs';
import { Session } from './schedule-data.mjs';

/* =============================================================================
   TIMELINE — vis-timeline integration.
     • builds groups (production lines) and items (orders + blackout blocks)
     • two-way sync: user drags → Store.updateTask({ source:'timeline' })
                     Store changes → refresh items, skipping own-source events
     • right-click → ContextMenu
     • double-click → open in Inspector
   ========================================================================== */
export const Timeline = {
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
  _conflictSrc: null,           // alerts array reference — invalidates cache when it changes
  _conflictSet: null,           // Set<String(taskId)> built once per alerts array identity
  _visEl:       null,           // cached #vis-timeline element (set in init)
  _ganttTab:    null,           // cached #gantt-tab element (see _ganttActive)

  init() {
    const container = document.getElementById('vis-timeline');
    if (!container) return;
    Timeline._visEl = container;

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
      // Let an order be dragged directly, without first selecting it with a plain click.
      // That pre-select click is what fired CENTER_ON_CLICK → focus() → viewport pan →
      // DataView refresh, which visually reverted single drags ("spring back"). Blackout /
      // background items stay put because they are created with editable:false.
      itemsAlwaysDraggable: { item: true },
      snap: d => Util.snap(d),
      groupOrder: (a, b) => (a.order ?? 0) - (b.order ?? 0),
      orientation: { axis: 'top' },
      zoomMin: 15 * 60 * 1000,           // 15 min
      zoomMax: 30 * 24 * 3600 * 1000,    // 30 days
      zoomKey: 'ctrlKey',
      margin: { item: { horizontal: 2, vertical: 4 } },
      height: '100%',
      verticalScroll: true,
      tooltip: { delay: 400, followMouse: false },
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
      Timeline._tl.redraw();
    }, 120);
    Timeline._tl.on('rangechanged', _refreshView);

    // One-shot screen calibration: measure real row + axis after first render
    // with content so _fitHeight uses screen-specific values from then on.
    // Selectors are scoped to specific panels because vis-timeline reuses
    // .vis-time-axis for both the label row (top panel, ~30px) AND a
    // full-height grid overlay inside .vis-content. Matching the wrong one
    // would inflate axisH to container height and poison the cache.
    const _calibrate = () => {
      const c = Timeline._visEl;
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
      if (document.hidden) return; // skip ticker work while the tab is backgrounded
      if (!Timeline._items || !Timeline._pastZoneIds.length) return;
      const now  = new Date();
      const updates = Timeline._pastZoneIds
        .filter(id => Timeline._items.get(id))
        .map(id => ({ id, end: now }));
      if (Timeline._alertHorizonIds.length) {
        const plantRow = Store.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null;
        const hz = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? null;
        if (typeof hz === 'number') {
          const hzEnd = new Date(now.getTime() + hz * Config.MS_MIN);
          for (const id of Timeline._alertHorizonIds) {
            if (Timeline._items.get(id)) updates.push({ id, start: now, end: hzEnd });
          }
        }
      }
      if (updates.length) Timeline._items.update(updates);
    }, 1000);

    /* ----- subscribe to store changes ----------------------------------- */
    Timeline._unsubStore = Store.subscribe(evt => Timeline._onStore(evt), 'Timeline');
  },

  // Cached lookup for the (static) #gantt-tab; lazily caches on first call so
  // init order can't leave it null. Replaces 4 inline getElementById checks.
  _ganttActive() {
    if (!Timeline._ganttTab) Timeline._ganttTab = document.getElementById('gantt-tab');
    return Timeline._ganttTab ? Timeline._ganttTab.classList.contains('active') : false;
  },

  /** Handle store updates: refresh vis-timeline WITHOUT echoing back. */
  _onStore(evt) {
    // Ignore our own mutations — we already applied them visually.
    if (evt.source === 'timeline') return;

    if (evt.type === 'plant:selected') {
      if (Timeline._ganttActive()) {
        Timeline.rebuild();
      } else {
        Timeline._renderEmptyOverlay();
      }
      return;
    }

    if (evt.type === 'tasks:bulk' || evt.type === 'blocks:change'
        || evt.type === 'calendar:change' || evt.type === 'plantBlocks:change') {
      // Only do a full rebuild when the gantt tab is active; otherwise
      // the next goto('gantt') will call rebuild() anyway. Coalesced to one rAF so
      // back-to-back data events don't each run the full diff inside Store.emit.
      if (Timeline._ganttActive()) {
        Timeline._scheduleRebuild();
      }
    } else if (evt.type === 'tasks:bulkUpdate') {
      // Patch items — avoids groups.clear() which resets vertical scroll.
      // Skip tasks on lines hidden by the Gantt line filter, otherwise their items
      // get added to the DataSet and the filter visually "leaks" on optimize runs.
      // All patches are collected up front and flushed via a SINGLE _items.update()
      // call (vis-timeline DataSet.update() upserts by id) instead of one DataSet
      // write per task — a per-task loop here previously dominated optimize-run cost.
      if (Timeline._ganttActive()) {
        const sel = NIMBUS.GanttFilter ? NIMBUS.GanttFilter._selectedLines : null;
        const filtered = sel && sel.size > 0;
        const _pmT0patch = performance.now();
        const patches = [];
        for (const id of (evt.ids || [])) {
          const sid = String(id);
          if (filtered) {
            const t = Store.tasks[sid];
            if (!t || !sel.has(t.PRODUCTION_LINE || 'Unknown')) continue;
          }
          const patch = Timeline._itemPatchFor(sid);
          if (patch) patches.push(patch);
        }
        if (patches.length) {
          Timeline._suppressEvents = true;
          try {
            Timeline._items.update(patches);
          } finally {
            Timeline._suppressEvents = false;
          }
        }
        PerfMonitor.record('Timeline.patchLoop', performance.now() - _pmT0patch);
      }
    } else if (evt.type === 'task:update' && evt.id != null) {
      Timeline._applyTaskPatch(String(evt.id));
    } else if (evt.type === 'fixed:change') {
      // just re-render those items' className
      for (const id of evt.ids) Timeline._applyTaskPatch(String(id));
    } else if (evt.type === 'alerts:change') {
      Timeline._conflictSrc = null; // invalidate conflict-set cache; rebuild() will repopulate
      if (Timeline._ganttActive()) {
        // rebuild() already recomputes the conflict-order className for every task
        // via its desired-map diff AND reconciles the alert-cell background items, so
        // the old per-task _applyTaskPatch loop here was pure duplicate work. Just run
        // the (coalesced) diff rebuild.
        Timeline._scheduleRebuild();
      }
    }
  },

  // Builds a vis-timeline item patch for a single task id, or returns null/undefined
  // if the task is missing or undated. Pure — does not touch the DataSet. Shared by
  // _applyTaskPatch (single-id callers) and the tasks:bulkUpdate batch path above.
  _itemPatchFor(id) {
    const t = Store.tasks[id];
    if (!t || !t.start_date || !t.end_date) return null;
    return Timeline._itemForTask(t);
  },

  _applyTaskPatch(id) {
    const patch = Timeline._itemPatchFor(id);
    if (!patch) return;
    Timeline._suppressEvents = true;
    try {
      // DataSet.update() upserts by id (adds if not present) — see the batched
      // tasks:bulkUpdate path above for the multi-id equivalent.
      Timeline._items.update(patch);
    } finally { Timeline._suppressEvents = false; }
  },

  // Returns a Set of String task IDs that have an active alert. Memoized on the
  // Store.alerts array identity — rebuilt O(alerts) once, then O(1) per task lookup.
  _conflictIds() {
    const src = Store.alerts;
    if (Timeline._conflictSrc !== src) {
      const s = new Set();
      for (const a of src) if (a.taskId != null) s.add(String(a.taskId));
      Timeline._conflictSrc = src;
      Timeline._conflictSet = s;
    }
    return Timeline._conflictSet;
  },

  /** Build an item object for a task. */
  _itemForTask(t) {
    const line = t.PRODUCTION_LINE || 'Unknown';
    const ci = Timeline._colorIndex(line);
    const fixed = Store.isFixed(t.id);
    const conflict = Timeline._conflictIds().has(String(t.id));
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
      content: `<span style="font-style:italic;">✕ ${b.reason || Util.t('ui.blackouts_label', {plural: ''})}</span>`,
      title:   `${Util.t('ui.blackouts_label', {plural: ''})}: ${b.reason || '—'}<br>${Util.fmtDTReadable(b.start)} → ${Util.fmtDTReadable(b.end)}`,
      start:   b.start, end: b.end,
      editable: false,
      className: 'blackout',
      type: 'background'
    };
  },
  /** Coalesce data-event-driven rebuilds into a single requestAnimationFrame so
   *  multiple Store emits in one tick (e.g. tasks:bulkUpdate then alerts:change from
   *  the same operation) don't each run the full diff synchronously inside Store.emit.
   *  User-initiated rebuilds (goto-gantt, drag-end, plant switch) still call rebuild()
   *  directly for immediate feedback. */
  _scheduleRebuild() {
    if (Timeline._rebuildRaf) return;
    Timeline._rebuildRaf = requestAnimationFrame(() => {
      Timeline._rebuildRaf = null;
      Timeline.rebuild();
    });
  },

  /** Diff-based rebuild: compare desired item set to current DataSet contents
   *  and emit minimal add/update/remove operations. Preserves selection and
   *  avoids the clear/add flicker of a wholesale replacement.               */
  rebuild() {
    if (!Timeline._items || !Timeline._groups) return;
    const _pmT0t = performance.now();
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
    // Scope to GanttFilter line multi-select — without this, vis-timeline reserves
    // row height for every plant line and leaves ghost rows above the visible ones.
    const lineFilterActive = !!NIMBUS.GanttFilter
      && NIMBUS.GanttFilter._selectedLines
      && NIMBUS.GanttFilter._selectedLines.size > 0;
    // Single source of truth for "what lines are rendered, and in what
    // order" — see Timeline._visibleLines(). Also reused by
    // Dashboard._gotoLine and AlertsUIAdapter.focus's line+day fallback via
    // Timeline.gotoLineDay()/scrollToLine(), so any code computing a row
    // index for a line always matches this actual rendered order.
    const visibleLines = Timeline._visibleLines();
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
    const _pmT0desired = performance.now();
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
      if (b.plant && b.plant !== Store.selectedPlant) continue;
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
      const plantRow = Store.masterData?.plants?.find(p => p.plant === plant) ?? null;
      const hz = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? null;
      if (typeof hz === 'number') {
        const hzNow = new Date();
        const hzEnd = new Date(hzNow.getTime() + hz * Config.MS_MIN);
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
    const CALENDAR_ALERT_TYPES = new Set(['blackout', 'closed', 'fixed-closed', 'fixed-out-of-hours']);
    const alertCellMap = {};
    for (const a of Store.alerts) {
      if (!a.line || !a.time) continue;
      if (lineFilterActive && !visibleSet.has(a.line)) continue;
      const dk  = Util.dayKey(a.time);
      const key = `${a.line}|${dk}`;
      if (!alertCellMap[key]) alertCellMap[key] = { line: a.line, dayKey: dk, sev: a.sev, hasConflictErr: false };
      if (a.sev === 'err') {
        alertCellMap[key].sev = 'err';
        if (!CALENDAR_ALERT_TYPES.has(a.type)) alertCellMap[key].hasConflictErr = true;
      }
    }
    for (const key of Object.keys(alertCellMap)) {
      const cell = alertCellMap[key];
      const cls  = cell.sev !== 'err'  ? 'alertcell-warn'
                 : cell.hasConflictErr ? 'alertcell-err'
                 :                       'alertcell-calendar';
      const item = {
        id:    `alertcell-${cell.line}-${cell.dayKey}`,
        group: cell.line,
        start: new Date(cell.dayKey + 'T00:00:00'),
        end:   new Date(cell.dayKey + 'T23:59:59'),
        type:  'background',
        className: cls,
        editable: false,
      };
      desired.set(String(item.id), item);
    }

    PerfMonitor.record('Timeline.rebuild.desiredMap', performance.now() - _pmT0desired);

    const _pmT0diff = performance.now();
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

    PerfMonitor.record('Timeline.rebuild.diff', performance.now() - _pmT0diff);

    const _pmT0flush = performance.now();
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
    PerfMonitor.record('Timeline.rebuild.dsFlush', performance.now() - _pmT0flush);

    // Re-sync selection with what still exists. Guard for pre-install rebuilds.
    if (typeof Selection !== 'undefined') {
      const keep = Selection.ids().filter(id => desired.has(id));
      if (keep.length !== Selection.size()) Selection.set(keep);
      Timeline._tl.setSelection(keep);
      if (NIMBUS.Interaction && NIMBUS.Interaction.DEBUG) {
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
    PerfMonitor.record('Timeline.rebuild', performance.now() - _pmT0t);
  },

  _fitHeight(groupCount) {
    if (!Timeline._tl) return;
    const container = Timeline._visEl;
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
    // Force the target into the sliding DataView window first — see
    // _syncViewWindow's doc comment for why vis-timeline's own focus()/
    // setSelection() otherwise silently no-op for out-of-window items.
    Timeline._syncViewWindow(t.start_date.getTime(), t.end_date.getTime());
    // vis-timeline's focus() scrolls both horizontally (time) and vertically (line row).
    Timeline._tl.focus(String(id), { animation: { duration: 300 } });
    Timeline._tl.setSelection([String(id)]);
    NIMBUS.Inspector.show(t);
  },

  // Force Timeline._visItems (the ±90-day sliding DataView, see init()) to
  // include a specific ms range synchronously, bypassing the 120ms-debounced
  // rangechanged handler that normally keeps it in sync. vis-timeline's own
  // Timeline.focus()/setSelection() look up items via itemsData.get(ids)
  // against whatever DataSet/DataView is currently attached — if the target
  // id isn't passing the filter at call time, focus() silently no-ops (no
  // pan/zoom) and setSelection() updates internal state but the item is
  // never visually highlighted even once it later loads (ItemSet only
  // re-applies "selected" to items that already existed with a changed
  // constructor, not to items newly added by a DataView refresh).
  //
  // Unions the requested range into the current window rather than
  // replacing it — a hard cutover to the destination would evict
  // everything visible under the OLD viewport from the DataView before the
  // pan animation even starts, causing a blank flash for the duration of
  // the pan. The debounced rangechanged handler naturally narrows the
  // buffer back down once the animation settles, so this only needs to be
  // a temporary superset. Call immediately before focus()/setSelection()/
  // setWindow() whenever the target might be outside the window the
  // timeline was last showing.
  _syncViewWindow(startMs, endMs) {
    const cur = Timeline._viewWindow;
    Timeline._viewWindow = {
      start: cur ? Math.min(cur.start, startMs) : startMs,
      end:   cur ? Math.max(cur.end,   endMs)   : endMs,
    };
    if (Timeline._visItems) Timeline._visItems.refresh();
  },

  setView(mode) {
    if (!Timeline._tl) return;
    const now = new Date();
    let start, end;
    if (mode === 'hour') {
      start = Util.startOfDay(now);
      end   = new Date(start.getTime() + 24 * Config.MS_HOUR);
    } else if (mode === 'day') {
      start = Util.startOfDay(now);
      end   = new Date(start.getTime() + 3 * 24 * Config.MS_HOUR);
    } else {
      start = Util.startOfDay(now);
      end   = new Date(start.getTime() + 7 * 24 * Config.MS_HOUR);
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
      NIMBUS.EmptyState.render(overlay, {
        title: Util.t('empty.select_plant_timeline'),
        msg:   Util.t('ui.select_plant_orders_msg')
      });
      overlay.hidden = false;
    } else {
      overlay.hidden = true;
      overlay.innerHTML = '';
    }
  },

  zoomToFit() {
    if (!Timeline._tl) return;
    // Scope to the selected plant like rebuild() (R4) — otherwise the window spans
    // every plant's orders and zooms far wider than the visible rows. Also avoids the
    // Math.min/max(...spread) call-stack risk on a system-wide task array at scale.
    const tasks = (Store.selectedPlant ? Store.tasksForSelectedPlant() : [])
      .filter(t => t.start_date && t.end_date);
    if (!tasks.length) return;
    const minT = Math.min(...tasks.map(t => t.start_date.getTime()));
    const maxT = Math.max(...tasks.map(t => t.end_date.getTime()));
    const span = maxT - minT;
    const pad  = span * 0.05 || Config.MS_HOUR;
    Timeline._tl.setWindow(new Date(minT - pad), new Date(maxT + pad), { animation: { duration: 400 } });
  },

  gotoNow() {
    if (!Timeline._tl) return;
    const now = new Date();
    Timeline._tl.setWindow(
      new Date(now.getTime() - 4 * Config.MS_HOUR),
      new Date(now.getTime() + 4 * Config.MS_HOUR),
      { animation: { duration: 300 } }
    );
  },

  _colorIndex(line) {
    if (Timeline._lineColorIdx[line] === undefined) {
      Timeline._lineColorIdx[line] = Timeline._nextColorIdx++ % Config.COLORS.length;
    }
    return Timeline._lineColorIdx[line];
  },

  // Single source of truth for "what lines are rendered, and in what
  // order." Mirrors rebuild()'s plant-scoping + numeric-aware sort +
  // GanttFilter line-filter exactly, so any code computing a row index for
  // a line always matches the actual rendered .vis-group DOM order.
  _visibleLines() {
    const plant = Store.selectedPlant;
    const tasks = Store.tasksForSelectedPlant().filter(t => t.start_date && t.end_date);
    const plantLines = new Set(Store.linesForSelectedPlant());
    const lineSet = new Set(tasks.map(t => t.PRODUCTION_LINE || 'Unknown'));
    if (plant) {
      for (const l of plantLines) lineSet.add(l);
    }
    const sortedLines = [...lineSet].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const lineFilterActive = !!NIMBUS.GanttFilter
      && NIMBUS.GanttFilter._selectedLines
      && NIMBUS.GanttFilter._selectedLines.size > 0;
    return lineFilterActive
      ? sortedLines.filter(l => NIMBUS.GanttFilter._selectedLines.has(l))
      : sortedLines;
  },

  // Scroll the vis-timeline vertical scroller so the group row for `line`
  // is at the top of the visible viewport. Returns false (no-op, no crash)
  // if the line isn't currently rendered — e.g. hidden by an active
  // GanttFilter line filter, or the Gantt hasn't rendered any groups yet.
  scrollToLine(line) {
    const visibleLines = Timeline._visibleLines();
    const lineIdx = visibleLines.indexOf(line);
    if (lineIdx < 0) return false;
    const groups = document.querySelectorAll('.vis-foreground .vis-group');
    if (!groups.length) return false;
    let targetY = 0;
    for (let i = 0; i < lineIdx && i < groups.length; i++) {
      targetY += groups[i].getBoundingClientRect().height;
    }
    const scrollEl = document.querySelector('.vis-vertical-scroll') ||
                     document.querySelector('.vis-panel.vis-center .vis-content');
    if (scrollEl) scrollEl.scrollTop = targetY;
    return true;
  },

  // Shared "pan to a day + scroll to a line row" navigation, used by
  // Dashboard._gotoLine (heatmap cell clicks) and AlertsUIAdapter.focus's fallback
  // for line/day-level alerts (overload, closed) that have no taskId to
  // focus() on. Forces the Gantt to the Timeline sub-tab first — plain
  // App.goto('gantt') alone preserves whatever Gantt sub-tab was last
  // active, so without this the pan/scroll below can happen invisibly
  // behind a hidden #gantt-sub-timeline pane.
  gotoLineDay(line, dateStr) {
    NIMBUS.App.gotoGanttTimeline();
    setTimeout(() => {
      if (Timeline._tl) {
        const dayStart    = new Date(dateStr + 'T00:00:00');
        const dayLevelEnd = new Date(dayStart.getTime() + 3 * 24 * Config.MS_HOUR);
        Timeline._syncViewWindow(dayStart.getTime(), dayLevelEnd.getTime());
        Timeline._tl.setWindow(dayStart, dayLevelEnd, { animation: { duration: 300 } });
        document.querySelectorAll('.gantt-toolbar .seg-btn[data-view]').forEach(b => {
          b.classList.toggle('active', b.dataset.view === 'day');
        });
      }
      setTimeout(() => { Timeline.scrollToLine(line); }, 100);
    }, 250);
  }
};

/* =============================================================================
   TIMELINE NAV — minimap strip above the Gantt showing schedule range with
   utilization heat bands. Draggable viewport rect pans the main timeline.
   ========================================================================== */
export const TimelineNav = {
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
    }, 'TimelineNav');

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
    const scheduleMax = scheduleMin + 42 * Config.MS_DAY;
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

    // Scope to the selected plant (R17) so the nav strip draws only the current
    // plant's orders, not every plant's. The utilization heat-band below
    // (computeMatrix) stays intentionally system-wide.
    const tasks = (Store.selectedPlant ? Store.tasksForSelectedPlant() : [])
      .filter(t => t.start_date && t.end_date);
    if (!tasks.length || !Timeline._tl) return;

    const _today = new Date(); _today.setHours(0, 0, 0, 0);
    const scheduleMin = _today.getTime();
    const scheduleMax = scheduleMin + 42 * Config.MS_DAY;
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
    const matrix = Utilization.computeMatrix(new Date(scheduleMin), Math.ceil(totalMs / Config.MS_DAY) + 2);
    const SEV_COLORS = { ok: 'rgba(47,122,77,0.25)', warn: 'rgba(230,180,0,0.40)', err: 'rgba(210,150,0,0.55)' };
    for (const line of Object.keys(matrix)) {
      for (const [dayKey, row] of Object.entries(matrix[line])) {
        if (!row.pct) continue;
        const sev = Utilization.sev(row.pct);
        if (sev === 'ok') continue;
        const dayStart = new Date(dayKey + 'T00:00:00').getTime();
        const dayEnd   = dayStart + Config.MS_DAY;
        const x1 = Math.max(0, toX(dayStart));
        const x2 = Math.min(cssW, toX(dayEnd));
        ctx.fillStyle = SEV_COLORS[sev];
        ctx.fillRect(x1, 0, x2 - x1, cssH);
      }
    }

    // Day dividers — snap to local midnight so labels match vis-timeline's local-time headers
    const dayMs = Config.MS_DAY;
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
   DEPENDENCY OVERLAY — SVG arrow layer over the Gantt visualising finish-to-
   start chains from Store.dependencies. Toggle via #chk-show-deps.
   Critical path gets a thicker stroke.
   ========================================================================== */
export const DependencyOverlay = {
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
    }, 'DependencyOverlay');
  },

  highlightChain(taskId) {
    DependencyOverlay._highlighted = String(taskId);
    if (DependencyOverlay._enabled) DependencyOverlay.render();
  },

  render() {
    const svg = DependencyOverlay._svg;
    if (!svg || !Timeline._tl || !Timeline._items) return;
    svg.innerHTML = '';

    const deps = Store.dependencies;
    if (!deps || !Object.keys(deps).length) return;

    const tl  = Timeline._tl;
    const dom = document.getElementById('vis-timeline');
    if (!dom) return;

    // Compute critical path lengths for each task (longest chain to it)
    const chainLen = {};
    const allIds = Store.tasksForSelectedPlant().map(t => String(t.id));
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
    // Scope to the selected plant (mirrors the TimelineNav R17 fix) so this ordering
    // matches the visible plant-scoped group rows built by Timeline.rebuild.
    const lines = [...new Set((Store.selectedPlant ? Store.tasksForSelectedPlant() : Store.tasksArr)
      .map(t => t.PRODUCTION_LINE || 'Unknown'))].sort();
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
        if (gapMs > 15 * Config.MS_MIN) cls = 'gap';
        else if (Math.abs(gapMs) <= 15 * Config.MS_MIN) cls = 'tight';
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
   TABLE — AG Grid integration with rich inline editing, filtering, and full
   two-way sync. Uses the transaction API for fast incremental updates.
   ========================================================================== */
export const Table = {
  _api:    null,
  _colApi: null,
  _selectedId: null,  // for the override modal
  _noteOutsideHandler: null,
  _noteKeyHandler: null,
  _chipFilters: { lines: new Set(), colors: new Set(), status: null, dateKey: null, poMat: new Set() },
  _lineSearch:       '',
  _colorSearch:      '',
  _rangeMode:        false,
  _rangeAnchor:      null,
  _rangeActive:      null,
  _rangeDragOn:      false,
  _rangeHighlighted: new Set(),
  _applyingLayout:   false,   // true while restoring saved layout — suppresses capture echo
  _captureTimer:     null,

  /* ── Saved grid layout (pref('gridLayout'), user tier) ────────────────────
     gridLayout === null  → feature OFF: never applied on load, never captured.
     gridLayout === {...}  → feature ON: applied on grid-ready, re-captured (debounced)
                             on every column/sort/filter change. The on/off toggle in
                             User Settings derives its state from this null-ness, so
                             enabling captures the current live layout (→ non-null) and
                             disabling nulls it. Shape: { columnState, sortModel, filterModel }
                             per the settings contract; AG Grid v31 folds sort into
                             columnState, so applyColumnState() alone restores sorting —
                             sortModel is derived and stored only to honor the contract shape. */
  _layoutEnabled() { try { return Store.pref('gridLayout') != null; } catch { return false; } },

  _currentLayout() {
    if (!Table._api) return { columnState: null, sortModel: null, filterModel: null };
    let columnState = null, filterModel = null, sortModel = null;
    try { columnState = Table._api.getColumnState(); } catch {}
    try { filterModel = Table._api.getFilterModel(); } catch {}
    if (columnState) {
      sortModel = columnState
        .filter(c => c.sort)
        .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
        .map(c => ({ colId: c.colId, sort: c.sort }));
    }
    return { columnState, sortModel, filterModel };
  },

  // Debounced capture — guarded so programmatic restores don't echo back, and
  // a no-op while the feature is disabled.
  _captureLayout() {
    if (Table._applyingLayout || !Table._layoutEnabled()) return;
    clearTimeout(Table._captureTimer);
    Table._captureTimer = setTimeout(() => {
      if (!Table._layoutEnabled()) return;
      try { Session.setPref('gridLayout', Table._currentLayout()); } catch {}
    }, 400);
  },

  _applySavedLayout() {
    const layout = (() => { try { return Store.pref('gridLayout'); } catch { return null; } })();
    if (!layout || !Table._api) return;
    Table._applyingLayout = true;
    try {
      if (Array.isArray(layout.columnState)) {
        Table._api.applyColumnState({ state: layout.columnState, applyOrder: true });
      }
      if (layout.filterModel && typeof layout.filterModel === 'object') {
        Table._api.setFilterModel(layout.filterModel);
      }
    } catch (e) {
      ErrorLog.warn('table', `Apply saved grid layout failed: ${e.message}`);
    }
    // Release the guard on the next macrotask so any events the restore fired
    // (sync or queued) are all ignored, but genuine later user edits are not.
    setTimeout(() => { Table._applyingLayout = false; }, 0);
  },

  // Turn the feature on (capture current live layout) or off (null it + reset
  // the grid to defaults). Called by the User Settings toggle.
  _setLayoutEnabled(on) {
    if (on) {
      try { Session.setPref('gridLayout', Table._currentLayout()); } catch {}
    } else {
      try { Session.setPref('gridLayout', null); } catch {}
      Table._resetGridState();
    }
  },

  // Reset the live grid to its default column arrangement + clear column filters.
  _resetGridState() {
    if (!Table._api) return;
    Table._applyingLayout = true;
    try {
      Table._api.resetColumnState();
      Table._api.setFilterModel(null);
    } catch (e) {
      ErrorLog.warn('table', `Reset grid layout failed: ${e.message}`);
    }
    setTimeout(() => { Table._applyingLayout = false; }, 0);
  },

  // "Reset grid layout" action: reset the live grid, then — if the feature is
  // on — re-capture the now-default state so it persists (staying non-null keeps
  // the toggle on). Returns true if the grid was available to reset.
  _resetGridLayout() {
    if (!Table._api) return false;
    Table._resetGridState();
    if (Table._layoutEnabled()) {
      try { Session.setPref('gridLayout', Table._currentLayout()); } catch {}
    }
    return true;
  },

  init() {
    const el = document.getElementById('ag-grid');
    if (!el || typeof agGrid === 'undefined') return;
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
          suppressHeaderMenuButton: true,
          sortable: false,
          filter: false,
          resizable: false
        },
        {
          headerName: Util.t('col.fixed'), field: 'fixed',
          width: 42, minWidth: 42, maxWidth: 42, flex: 0,
          pinned: 'left',
          editable: false,
          cellRenderer: p => p.value ? '<span title="Fixed" style="color:var(--accent);font-size:13px;">🔒</span>' : '',
          headerTooltip: Util.t('tip.fixed_column')
        },
        { headerName: Util.t('col.id'),   field: 'id',   width: 80, minWidth: 80, flex: 0, hide: true,
          editable: false, cellClass: 'cell-num' },
        { headerName: Util.t('col.order'), field: 'PRODUCTION_ORDER', width: 160, minWidth: 160, flex: 0,
          pinned: 'left', editable: false,
          valueGetter: p => p.data.PRODUCTION_ORDER || p.data.ORDER || '' },
        { headerName: Util.t('col.material'), field: 'MATERIAL_DESCRIPTION', minWidth: 180, editable: false,
          tooltipField: 'MATERIAL_DESCRIPTION' },
        { headerName: Util.t('col.qty'), field: 'ORDER_QUANTITY_(GMEIN)', width: 100, flex: 0,
          editable: false, cellClass: 'cell-num',
          valueParser: p => parseFloat(p.newValue) || 0 },
        { headerName: Util.t('col.line'), field: 'PRODUCTION_LINE', minWidth: 130, editable: true,
          cellEditor: Table._SearchableLineEditor,
          cellEditorPopup: true,
          cellEditorParams: () => ({ values: Table._getLineOptions() }),
          cellRenderer: p => {
            if (!p.value) return '';
            const ci = Timeline._colorIndex(p.value);
            const color = Config.COLORS[ci % Config.COLORS.length];
            return `<span class="cell-line-tag"><span class="dot" style="background:${color}"></span>${p.value}</span>`;
          }
        },
        { headerName: Util.t('col.color'), field: 'COLOR', width: 110, flex: 0, editable: false },
        { headerName: Util.t('col.form'),  field: 'FORM_SIZE', width: 90, flex: 0, editable: false },
        { headerName: Util.t('col.run_h'), field: 'RUN_TIME', width: 90, flex: 0, editable: true,
          cellClass: 'cell-num',
          valueParser: p => parseFloat(p.newValue) || 0 },
        { headerName: Util.t('col.orig_start'), field: 'original_start_date', minWidth: 160,
          editable: false,
          // Display-only derived value (due date minus RUN_TIME — see
          // Util.impliedOriginalStart) instead of the raw midnight SAP
          // date. `field` is kept alongside `valueGetter` (same precedent
          // as the PRODUCTION_ORDER column above) purely so AG Grid's
          // date-type inference off the raw field still drives this
          // column's sort + agDateColumnFilter; dropping `field` entirely
          // would degrade the filter to generic/text.
          valueGetter: p => Util.impliedOriginalStart(p.data),
          valueFormatter: p => Util.fmtDTReadable(p.value),
          cellClass: 'cell-date cell-date-original' },
        { headerName: Util.t('col.orig_end'), field: 'original_end_date', minWidth: 160,
          editable: false,
          valueFormatter: p => Util.fmtDTReadable(p.value),
          cellClass: 'cell-date cell-date-original' },
        { headerName: Util.t('col.updated_start'), field: 'start_date', minWidth: 160,
          editable: true,
          valueFormatter: p => Util.fmtDTReadable(p.value),
          cellEditor: Table._DateTimeEditor,
          cellClass: 'cell-date' },
        { headerName: Util.t('col.updated_end'), field: 'end_date', minWidth: 160,
          editable: false,
          valueFormatter: p => Util.fmtDTReadable(p.value),
          cellClass: 'cell-date' },
        { headerName: Util.t('col.alerts'), field: 'id', width: 90, flex: 0, sortable: false, filter: false, editable: false,
          cellRenderer: p => {
            const rel = Store.alertsByTask().get(String(p.value)) || [];
            if (!rel.length) return '';
            const err = rel.some(a => a.sev === 'err');
            const color = err ? 'var(--err)' : 'var(--warn)';
            return `<button onclick="NIMBUS.Table._showAlertPopup('${p.value}')"
              title="Click to view alerts"
              style="background:none;border:none;padding:0;cursor:pointer;color:${color};font-weight:600;font-size:inherit;font-family:inherit">
              ⚐ ${rel.length}</button>`;
          }
        },
        { headerName: '📝', field: 'notes', width: 180, minWidth: 80,
          sortable: false, filter: false, editable: true, suppressHeaderMenuButton: true,
          cellEditor: 'agLargeTextCellEditor', cellEditorPopup: true,
          cellEditorParams: { maxLength: 500, rows: 5, cols: 50 },
          cellRenderer: p => {
            const note = p.value != null ? String(p.value).trim() : '';
            if (!note) return `<span class="nb-note-empty">✎ <em>${Util.t('ui.add_note')}</em></span>`;
            const preview = note.length > 40 ? note.slice(0, 37) + '…' : note;
            const esc = note.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
            return `<span class="nb-note-preview" title="${esc}">✎ ${preview}</span>`;
          }
        }
      ],
      onCellValueChanged: Table._onCellChanged,
      onSelectionChanged: Table._onSelectionChanged,
      isExternalFilterPresent: () => Table._hasChipFilters(),
      doesExternalFilterPass: node => Table._taskPassesChipFilters(node.data),
      noRowsOverlayComponent: Table._NoRowsOverlay,
      onCellMouseDown: p => {
        if (!Table._rangeMode) return;
        p.event.preventDefault();
        Table._rangeAnchor  = { rowIndex: p.node.rowIndex, colId: p.column.getColId() };
        Table._rangeActive  = { rowIndex: p.node.rowIndex, colId: p.column.getColId() };
        Table._rangeDragOn  = true;
        Table._applyRangeHighlight();
        document.addEventListener('mouseup', () => { Table._rangeDragOn = false; }, { once: true });
      },
      onCellMouseOver: p => {
        if (!Table._rangeMode || !Table._rangeDragOn) return;
        Table._rangeActive = { rowIndex: p.node.rowIndex, colId: p.column.getColId() };
        Table._applyRangeHighlight();
      },
      onCellKeyDown: p => {
        const ctrl = p.event.ctrlKey || p.event.metaKey;
        const key  = p.event.key;
        if (ctrl && key === 'y') {
          p.event.preventDefault();
          Table._toggleRangeMode();
          return;
        }
        if (ctrl && key === 'c') {
          if (Table._rangeMode && Table._rangeHighlighted.size > 0) {
            Table._copyRange();
          } else {
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
          return;
        }
        if (key === 'Escape' && Table._rangeMode) {
          Table._clearRange();
        }
      },
      // Saved grid layout — capture column order/width/visibility/pinning, sort,
      // and built-in column filters whenever the user changes them (debounced, and
      // only while the feature is enabled). See Table._captureLayout.
      onSortChanged:    () => Table._captureLayout(),
      onColumnMoved:    () => Table._captureLayout(),
      onColumnResized:  () => Table._captureLayout(),
      onColumnVisible:  () => Table._captureLayout(),
      onColumnPinned:   () => Table._captureLayout(),
      onFilterChanged:  () => Table._captureLayout(),
      onGridReady: params => {
        Table._api = params.api;
        Table._colApi = params.columnApi;
        Table._wireQuickFilter();
        Table._initChipFilters();
        // Restore the user's saved grid layout (if the feature is on) before
        // first paint so the table opens in their remembered arrangement.
        Table._applySavedLayout();
        ErrorLog.info('table', `AG Grid ready with ${Store.tasksArr.length} rows`);
      },
    };

    agGrid.createGrid(el, gridOptions);

    // Re-render rows whenever relevant store slices change.
    Store.subscribe(evt => Table._onStore(evt), 'Table');

    // Outside-click closes any open chip dropdown. Capture phase so AG Grid
    // (which can stopPropagation on some interactions) doesn't swallow the event.
    const closeAllChipDropdowns = () => {
      ['line', 'color', 'status', 'date', 'pomat'].forEach(k => {
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

    const lineIn  = document.getElementById('tbl-flt-line-paste-input');
    const colorIn = document.getElementById('tbl-flt-color-paste-input');
    Util.wirePasteToCheckboxes(lineIn,
      () => document.getElementById('tbl-flt-line-checklist')?.querySelectorAll('input[type=checkbox]') || []);
    Util.wirePasteToCheckboxes(colorIn,
      () => document.getElementById('tbl-flt-color-checklist')?.querySelectorAll('input[type=checkbox]') || []);
    // Scale mandate (CLAUDE.md Production Scale Roadmap): line/color pickers must
    // stay filterable, not a bare scrollable checkbox list — matches the Gantt tab's
    // identical filter bar. Paste-to-select (above) and type-to-filter (below) share
    // the same input without conflict — wirePasteToCheckboxes only listens for 'paste'.
    if (lineIn)  lineIn.oninput  = () => Table._filterLineSearch(lineIn.value);
    if (colorIn) colorIn.oninput = () => Table._filterColorSearch(colorIn.value);

    const poTa = document.getElementById('tbl-flt-pomat-textarea');
    if (poTa) {
      poTa.addEventListener('paste', Table._onPoMatPaste);
      poTa.addEventListener('input', Util.debounce(Table._onPoMatApply, 150));
    }
    document.getElementById('tbl-flt-pomat-clear')?.addEventListener('click', Table._clearPoMat);
  },

  _hasChipFilters() {
    const f = Table._chipFilters;
    return f.lines.size > 0 || f.colors.size > 0 || f.status !== null || f.dateKey !== null || f.poMat.size > 0;
  },

  _taskPassesChipFilters(data) {
    if (!data) return false;
    const f = Table._chipFilters;
    if (f.lines.size > 0 && !f.lines.has(data.PRODUCTION_LINE)) return false;
    if (f.colors.size > 0 && !f.colors.has(String(data.COLOR || '').toUpperCase())) return false;
    if (!Util.taskMatchesPasteSet(data, f.poMat)) return false;
    if (f.dateKey) {
      const dk = data.start_date ? Util.dayKey(data.start_date) : '';
      if (dk !== f.dateKey) return false;
    }
    if (f.status) {
      if (f.status === 'late' && !(Util.latenessHours(data) > 0)) return false;
      if (f.status === 'fixed' && !Store.isFixed(data.id)) return false;
      if (f.status === 'atrisk' || f.status === 'conflict') {
        const rel = Store.alertsByTask().get(String(data.id)) || [];
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
    ['line','color','status','date','pomat'].forEach(k => {
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

  // Scale mandate (CLAUDE.md Production Scale Roadmap): every plant/line picker
  // must stay filterable — this is the Orders tab's share of that, matching the
  // Gantt tab's identical filter bar.
  _filterLineSearch(q) {
    Table._lineSearch = q || '';
    Table._buildLineChipDropdown();
  },
  _filterColorSearch(q) {
    Table._colorSearch = q || '';
    Table._buildColorChipDropdown();
  },

  // Clears the line/color live-search text and its <input> values without
  // touching selections — shared by the plant-change handler and clear filters.
  _resetChipSearch() {
    Table._lineSearch = Table._colorSearch = '';
    const lineIn  = document.getElementById('tbl-flt-line-paste-input');
    const colorIn = document.getElementById('tbl-flt-color-paste-input');
    if (lineIn)  lineIn.value  = '';
    if (colorIn) colorIn.value = '';
  },

  _buildLineChipDropdown() {
    const drop = document.getElementById('tbl-flt-line-checklist');
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
    const q = Table._lineSearch.toLowerCase().trim();
    const visible = q ? sorted.filter(l => l.toLowerCase().includes(q)) : sorted;
    const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    drop.innerHTML = visible.length
      ? visible.map(l => `<label><input type="checkbox" value="${esc(l)}"${Table._chipFilters.lines.has(l) ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('line', this)"> ${esc(l)}</label>`).join('')
      : `<div style="padding:8px 14px;font-size:12px;color:var(--fg-mute)">${sorted.length ? Util.t('ui.no_matches') : 'No lines'}</div>`;
  },

  _buildColorChipDropdown() {
    const drop = document.getElementById('tbl-flt-color-checklist');
    if (!drop) return;
    const colorSet = new Set();
    for (const t of (Store.selectedPlant ? Store.tasksForSelectedPlant() : [])) {
      if (t.COLOR) colorSet.add(String(t.COLOR).toUpperCase());
    }
    const sorted = [...colorSet].sort();
    for (const c of [...Table._chipFilters.colors]) {
      if (!colorSet.has(c)) Table._chipFilters.colors.delete(c);
    }
    const q = Table._colorSearch.toLowerCase().trim();
    const visible = q ? sorted.filter(c => c.toLowerCase().includes(q)) : sorted;
    const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    drop.innerHTML = visible.length
      ? visible.map(c => `<label><input type="checkbox" value="${esc(c)}"${Table._chipFilters.colors.has(c) ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('color', this)"> ${esc(c)}</label>`).join('')
      : `<div style="padding:8px 14px;font-size:12px;color:var(--fg-mute)">${sorted.length ? Util.t('ui.no_matches') : 'No colors'}</div>`;
  },

  _buildStatusChipDropdown() {
    const drop = document.getElementById('tbl-flt-status-dropdown');
    if (!drop) return;
    const cur = Table._chipFilters.status;
    const items = [
      { v: 'late',     k: Util.t('ui.late'),        d: Util.t('ui.status_desc_late') },
      { v: 'conflict', k: Util.t('ui.conflicting'),  d: Util.t('ui.status_desc_conflict') },
      { v: 'atrisk',   k: Util.t('ui.at_risk'),      d: Util.t('ui.status_desc_atrisk') },
      { v: 'fixed',    k: Util.t('ui.fixed'),        d: Util.t('ui.status_desc_fixed') },
    ];
    drop.innerHTML = items.map(i =>
      `<label style="display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:6px 14px;">
         <span style="display:flex;align-items:center;gap:8px;">
           <input type="radio" name="tbl-flt-status" value="${i.v}"${cur === i.v ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('status', this)" style="accent-color:var(--accent);width:13px;height:13px;cursor:pointer;">
           <strong>${i.k}</strong>
         </span>
         <span style="font-size:10.5px;color:var(--fg-mute);margin-left:21px;">${i.d}</span>
       </label>`).join('')
      + `<div style="border-top:1px solid var(--line);margin:4px 0;"></div>
         <label style="display:flex;align-items:center;justify-content:flex-start;gap:8px;padding:6px 14px;">
           <input type="radio" name="tbl-flt-status" value=""${cur === null ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('status', this)" style="accent-color:var(--accent);width:13px;height:13px;cursor:pointer;">
           <span>${Util.t('ui.any_status')}</span>
         </label>`;
  },

  _buildDateChipDropdown() {
    const drop = document.getElementById('tbl-flt-date-dropdown');
    if (!drop) return;
    const today = Util.startOfDay(new Date());
    const tomorrow = new Date(today.getTime() + Config.MS_DAY);
    const cur = Table._chipFilters.dateKey;
    // Quick presets + clear. Underlying filter stores YYYY-MM-DD (single day) only;
    // longer ranges set status='atrisk-or-window' via dedicated keys.
    const presets = [
      { v: Util.dayKey(today),    k: Util.t('ui.today'),    d: today.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) },
      { v: Util.dayKey(tomorrow), k: Util.t('ui.tomorrow'), d: tomorrow.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) },
    ];
    drop.innerHTML = presets.map(p =>
      `<label style="display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:6px 14px;">
         <span style="display:flex;align-items:center;gap:8px;">
           <input type="radio" name="tbl-flt-date" value="${p.v}"${cur === p.v ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('date', this)" style="accent-color:var(--accent);width:13px;height:13px;cursor:pointer;">
           <strong>${p.k}</strong>
         </span>
         <span style="font-size:10.5px;color:var(--fg-mute);margin-left:21px;">${p.d}</span>
       </label>`).join('')
      + `<div style="border-top:1px solid var(--line);margin:4px 0;"></div>
         <label style="display:flex;align-items:center;justify-content:flex-start;gap:8px;padding:6px 14px;">
           <input type="radio" name="tbl-flt-date" value=""${cur === null ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('date', this)" style="accent-color:var(--accent);width:13px;height:13px;cursor:pointer;">
           <span>${Util.t('ui.any_date')}</span>
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
    Table._chipFilters.poMat.clear();
    const ta = document.getElementById('tbl-flt-pomat-textarea');
    if (ta) ta.value = '';
    const cnt = document.getElementById('tbl-flt-pomat-count');
    if (cnt) cnt.textContent = '';
    Table._resetChipSearch();
    // Fold native AG column filters into the same Clear action — otherwise a
    // restored saved layout's column filter survives this click invisibly.
    if (Table._api && Table._api.isAnyFilterPresent()) Table._api.setFilterModel(null);
    Table._refreshChipDropdowns();
    Table._refreshChipButtons();
    if (Table._api) Table._api.onFilterChanged();
  },

  _onPoMatApply() {
    const ta = document.getElementById('tbl-flt-pomat-textarea');
    if (!ta) return;
    Table._chipFilters.poMat = new Set(Util.parsePasteList(ta.value).map(Util.norm));
    const cnt = document.getElementById('tbl-flt-pomat-count');
    if (cnt) {
      const n = Table._chipFilters.poMat.size;
      cnt.textContent = n ? Util.t('ui.pomat_count', { count: n }) : '';
    }
    Table._refreshChipButtons();
    if (Table._api) Table._api.onFilterChanged();
  },

  _onPoMatPaste(e) {
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (!text || !text.trim()) return;
    const known = new Set();
    (Store.selectedPlant ? Store.tasksForSelectedPlant() : []).forEach(task => {
      const po = Util.norm(task.ORDER ?? task.PRODUCTION_ORDER); if (po) known.add(po);
      const mat = Util.norm(task.MATERIAL_NUMBER); if (mat) known.add(mat);
    });
    const { matched, total } = Util.countPasteMatches(text, known);
    if (total) Toast.show(Util.t('toast.paste_pomat_match', { matched, total }), matched > 0 ? 'success' : 'warn');
  },

  _clearPoMat() {
    Table._chipFilters.poMat.clear();
    const ta = document.getElementById('tbl-flt-pomat-textarea');
    if (ta) ta.value = '';
    const cnt = document.getElementById('tbl-flt-pomat-count');
    if (cnt) cnt.textContent = '';
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
      f.lines.size === 0 ? Util.t('ui.all_lines')
        : f.lines.size === 1 ? [...f.lines][0]
        : Util.t('ui.n_lines_filter', { count: f.lines.size }),
      f.lines.size > 0);

    set('tbl-flt-color-btn', 'tbl-flt-color-label',
      f.colors.size === 0 ? Util.t('ui.all_colors')
        : f.colors.size === 1 ? [...f.colors][0]
        : Util.t('ui.n_colors_filter', { count: f.colors.size }),
      f.colors.size > 0);

    const STATUS_LABEL = { late: Util.t('ui.late'), conflict: Util.t('ui.conflicting'), atrisk: Util.t('ui.at_risk'), fixed: Util.t('ui.fixed') };
    set('tbl-flt-status-btn', 'tbl-flt-status-label',
      f.status ? STATUS_LABEL[f.status] || f.status : Util.t('ui.all_statuses'),
      !!f.status);

    let dateLabel = Util.t('ui.any_date');
    if (f.dateKey) {
      const todayKey = Util.dayKey(Util.startOfDay(new Date()));
      const tomorrowKey = Util.dayKey(new Date(Util.startOfDay(new Date()).getTime() + Config.MS_DAY));
      if (f.dateKey === todayKey) dateLabel = Util.t('ui.today');
      else if (f.dateKey === tomorrowKey) dateLabel = Util.t('ui.tomorrow');
      else dateLabel = f.dateKey;
    }
    set('tbl-flt-date-btn', 'tbl-flt-date-label', dateLabel, !!f.dateKey);

    set('tbl-flt-pomat-btn', 'tbl-flt-pomat-label',
      f.poMat.size === 0 ? Util.t('ui.all_pomat') : Util.t('ui.n_pomat_filter', { count: f.poMat.size }),
      f.poMat.size > 0);

    // Native AG Grid per-column filters (from a saved layout, or set directly
    // via a column header menu) can suppress rows with zero acknowledgment in
    // this bar otherwise — surface + fold them into the same Clear action.
    const hasNative = !!(Table._api && Table._api.isAnyFilterPresent());
    const hasAny = Table._hasChipFilters() || hasNative;
    const clear = document.getElementById('tbl-flt-clear');
    if (clear) clear.hidden = !hasAny;

    const hint = document.getElementById('tbl-flt-hint');
    if (hint && Table._api) {
      const n = Table._api.getDisplayedRowCount();
      let txt = plant ? Util.t('ui.orders_visible', { count: n, plural: n !== 1 ? Util.t('ui.orders_visible_plural') : '' }) : '';
      if (plant && hasNative) txt += ' ' + Util.t('ui.column_filters_active');
      hint.textContent = txt;
    }
  },

  _onStore(evt) {
    if (evt.source === 'table' && evt.type !== 'fixed:change') return;
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
        Table._chipFilters.poMat.clear();
        const ta = document.getElementById('tbl-flt-pomat-textarea');
        if (ta) ta.value = '';
        const cnt = document.getElementById('tbl-flt-pomat-count');
        if (cnt) cnt.textContent = '';
        Table._resetChipSearch();
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
      // Incremental update: only refresh rows for task IDs that changed alert membership.
      // Fall back to full refresh if changedIds is absent (unscoped recompute).
      if (evt.changedIds && evt.changedIds.length) {
        const rowNodes = [];
        for (const taskId of evt.changedIds) {
          const rowNode = Table._api.getRowNode(String(taskId));
          if (rowNode) rowNodes.push(rowNode);
        }
        if (rowNodes.length) {
          Table._api.refreshCells({ rowNodes, columns: ['id'], force: true });
        }
      } else {
        // Unscoped recompute: refresh all visible rows (no redrawRows — would re-enter AG Grid's render cycle)
        Table._api.refreshCells({ columns: ['id'], force: true });
      }
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
      NIMBUS.EmptyState.render(overlay, {
        title: Util.t('empty.no_plant_selected'),
        msg:   Util.t('empty.no_plant_table')
      });
      if (grid) grid.style.visibility = 'hidden';
    } else {
      if (overlay) overlay.remove();
      if (grid) grid.style.visibility = '';
    }
  },

  // AG Grid's built-in no-rows overlay (shown automatically once a plant is
  // selected but the grid displays zero rows — either the plant genuinely has
  // no orders, or the chip/quick/native filters excluded everything). Reuses
  // the app's own EmptyState component instead of AG Grid's raw default text,
  // and offers a one-click way out when filters are the cause.
  _NoRowsOverlay: class {
    init() {
      const filtered = Table._hasChipFilters()
        || (Table._api && Table._api.isAnyFilterPresent())
        || !!document.getElementById('quick-filter')?.value;
      this._eGui = document.createElement('div');
      NIMBUS.EmptyState.render(this._eGui, filtered
        ? { title: Util.t('empty.no_orders_filtered_title'), msg: Util.t('empty.no_orders_filtered_msg'), icon: '⌕' }
        : { title: Util.t('empty.no_orders_plant_title'),    msg: Util.t('empty.no_orders_plant_msg') });
      if (filtered) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-ghost sm';
        btn.style.marginTop = '6px';
        btn.textContent = Util.t('btn.clear_filters');
        btn.onclick = () => {
          Table._clearChipFilters();
          const qf = document.getElementById('quick-filter');
          if (qf) { qf.value = ''; Table._api.setGridOption('quickFilterText', ''); }
        };
        this._eGui.querySelector('.nimbus-empty-state')?.appendChild(btn);
      }
    }
    getGui() { return this._eGui; }
  },

  /** Called when a grid cell is edited. Push the change through the store. */
  _onCellChanged(p) {
    const field = p.colDef.field;
    const id = String(p.data.id);
    const changes = {};

    if (field === 'start_date') {
      const d = Util.parseDate(p.newValue);
      if (!d) { Toast.show(Util.t('toast.invalid_date'), 'error'); Table._api.refreshCells({ rowNodes: [p.node] }); return; }
      changes.start_date = Util.snap(d);
      // recompute end based on RUN_TIME
      const dur = Util.runHours(p.data) * Config.MS_HOUR;
      if (dur > 0) changes.end_date = new Date(changes.start_date.getTime() + dur);
    } else if (field === 'RUN_TIME') {
      const h = parseFloat(p.newValue) || 0;
      changes.RUN_TIME = h;
      if (p.data.start_date) {
        changes.end_date = new Date(p.data.start_date.getTime() + h * Config.MS_HOUR);
      }
    } else if (field === 'ORDER_QUANTITY_(GMEIN)') {
      changes[field] = parseFloat(p.newValue) || 0;
    } else if (field === 'notes') {
      const trimmed = (p.newValue || '').trim();
      Store.updateTask(id, { notes: trimmed }, 'table');
      Table._api.applyTransaction({ update: [Store.tasks[id]] });
      Inspector._persistNote(id, trimmed);
      Toast.show(Util.t('toast.row_updated'), 'success', 1200);
      return;
    } else {
      changes[field] = p.newValue;
    }

    Store.updateTask(id, changes, 'table');
    Table._api.applyTransaction({ update: [Store.tasks[id]] });
    Engine.autoReflow(id);
    Alerts.scheduleRecompute();
    Toast.show(Util.t('toast.row_updated'), 'success', 1200);
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
        setTimeout(() => { Timeline.redraw(); TimelineNav.render(); }, Config.ANIM_MS);
      }
      Inspector.show(task);
    }
  },
 _rowClass(data) {      if (!data) return '';
    const ids = Store.alertsByTask().get(String(data.id)) || [];
    if (ids.some(a => a.sev === 'err')) return 'row-alert';
    if (ids.some(a => a.sev === 'warn')) return 'row-warn';
    return '';
  },

  _getLineOptions() {
    if (Store.selectedPlant) return Store.linesForSelectedPlant();
    // No plant selected — fall back to the unscoped view rather than showing nothing.
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
    if (!sel.length) { Toast.show(Util.t('toast.select_rows_first'), 'warn'); return; }
    const ids = sel.map(r => String(r.id));
    Store.setFixed(ids, fixed, 'table');
    Alerts.scheduleRecompute();
  },

  openOverrideModal() {
    const sel = Table._api ? Table._api.getSelectedRows() : [];
    if (sel.length !== 1) { Toast.show(Util.t('toast.select_one_row'), 'warn'); return; }
    Table._openOverrideModalForId(String(sel[0].id));
  },

  _openOverrideModalForId(id) {
    const t = Store.tasks[id];
    if (!t) return;
    const orderEl = document.getElementById('ovr-order');
    const lineEl = document.getElementById('ovr-line');
    const fixEl = document.getElementById('ovr-fix');
    if (!orderEl || !lineEl || !fixEl) { ErrorLog.error('ui', 'required DOM elements missing for override modal'); return; }

    Table._selectedId = id;
    orderEl.textContent = `${t.text || t.ORDER || t.id}  ·  Line: ${t.PRODUCTION_LINE || '—'}`;
    if (!Table._fpOvrStart) {
      Table._fpOvrStart = Util.fpDatetime('#ovr-start');
    }
    Table._fpOvrStart.setDate(t.start_date, false);
    const lines = Table._getLineOptions();
    lineEl.innerHTML = lines.map(l => `<option value="${l}" ${l === t.PRODUCTION_LINE ? 'selected' : ''}>${l}</option>`).join('');
    fixEl.checked = !!t.fixed;
    Modal.open('modal-override');
  },

  applyOverride() {
    const id = Table._selectedId;
    if (!id) return;
    const t = Store.tasks[id];
    if (!t) return;
    const startEl = document.getElementById('ovr-start');
    const lineEl = document.getElementById('ovr-line');
    const fixEl = document.getElementById('ovr-fix');
    if (!startEl || !lineEl || !fixEl) { ErrorLog.error('ui', 'required DOM elements missing for override modal'); return; }

    const newStart = Util.parseDate(startEl.value);
    const newLine  = lineEl.value;
    const alsoFix  = fixEl.checked;
    if (!newStart) { Toast.show(window.t('toast.invalid_date'), 'error'); return; }

    const dur = Util.runHours(t) * Config.MS_HOUR;
    const snapped = Util.snap(newStart);
    const newEnd = new Date(snapped.getTime() + dur);

    Store.updateTask(id, {
      start_date: snapped,
      end_date: newEnd,
      PRODUCTION_LINE: newLine
    }, 'table');
    if (Table._api) Table._api.applyTransaction({ update: [Store.tasks[id]] });
    if (alsoFix !== Store.isFixed(id)) Store.setFixed([id], alsoFix, 'table');

    // Override explicitly does NOT auto-reflow (user's manual choice),
    // but we DO recompute alerts so conflicts become visible.
    Alerts.scheduleRecompute();
    Modal.close('modal-override');
    Toast.show(alsoFix ? window.t('toast.order_overridden_fixed') : window.t('toast.order_overridden'), 'success');
  },

  exportCsv() {
    if (!Table._api) return;
    Table._api.exportDataAsCsv({ fileName: 'nimbus-orders.csv' });
  },

  _toggleRangeMode() {
    const badge  = document.getElementById('orders-copy-badge');
    const gridEl = document.getElementById('ag-grid');
    if (Table._rangeMode) {
      Table._clearRange();
    } else {
      Table._rangeMode = true;
      badge?.classList.add('active');
      gridEl?.classList.add('nimbus-range-mode');
    }
  },

  _applyRangeHighlight() {
    if (!Table._rangeAnchor || !Table._rangeActive || !Table._api) return;
    const gridEl = document.getElementById('ag-grid');
    if (!gridEl) return;
    const cols   = Table._api.getAllDisplayedColumns();
    const colIds = cols.map(c => c.getColId());
    const aIdx   = colIds.indexOf(Table._rangeAnchor.colId);
    const bIdx   = colIds.indexOf(Table._rangeActive.colId);
    if (aIdx === -1 || bIdx === -1) return;
    const minCol = Math.min(aIdx, bIdx);
    const maxCol = Math.max(aIdx, bIdx);
    const minRow = Math.min(Table._rangeAnchor.rowIndex, Table._rangeActive.rowIndex);
    const maxRow = Math.max(Table._rangeAnchor.rowIndex, Table._rangeActive.rowIndex);
    const newSet = new Set();
    for (let ri = minRow; ri <= maxRow; ri++) {
      for (let ci = minCol; ci <= maxCol; ci++) {
        newSet.add(`${ri}|${colIds[ci]}`);
      }
    }
    Table._rangeHighlighted.forEach(key => {
      if (!newSet.has(key)) {
        const sep = key.indexOf('|');
        gridEl.querySelector(`.ag-row[row-index="${key.slice(0, sep)}"] .ag-cell[col-id="${key.slice(sep + 1)}"]`)
          ?.classList.remove('nimbus-range-sel');
      }
    });
    newSet.forEach(key => {
      if (!Table._rangeHighlighted.has(key)) {
        const sep = key.indexOf('|');
        gridEl.querySelector(`.ag-row[row-index="${key.slice(0, sep)}"] .ag-cell[col-id="${key.slice(sep + 1)}"]`)
          ?.classList.add('nimbus-range-sel');
      }
    });
    Table._rangeHighlighted = newSet;
  },

  _clearRange() {
    const gridEl = document.getElementById('ag-grid');
    Table._rangeHighlighted.forEach(key => {
      const sep = key.indexOf('|');
      gridEl?.querySelector(`.ag-row[row-index="${key.slice(0, sep)}"] .ag-cell[col-id="${key.slice(sep + 1)}"]`)
        ?.classList.remove('nimbus-range-sel');
    });
    Table._rangeHighlighted.clear();
    Table._rangeAnchor  = null;
    Table._rangeActive  = null;
    Table._rangeDragOn  = false;
    Table._rangeMode    = false;
    document.getElementById('orders-copy-badge')?.classList.remove('active');
    gridEl?.classList.remove('nimbus-range-mode');
  },

  _copyRange() {
    if (!Table._rangeAnchor || !Table._rangeActive || !Table._api) return;
    const cols   = Table._api.getAllDisplayedColumns();
    const colIds = cols.map(c => c.getColId());
    const aIdx   = colIds.indexOf(Table._rangeAnchor.colId);
    const bIdx   = colIds.indexOf(Table._rangeActive.colId);
    if (aIdx === -1 || bIdx === -1) return;
    const minCol = Math.min(aIdx, bIdx);
    const maxCol = Math.max(aIdx, bIdx);
    const minRow = Math.min(Table._rangeAnchor.rowIndex, Table._rangeActive.rowIndex);
    const maxRow = Math.max(Table._rangeAnchor.rowIndex, Table._rangeActive.rowIndex);
    const rowStrs = [];
    for (let ri = minRow; ri <= maxRow; ri++) {
      const node = Table._api.getDisplayedRowAtIndex(ri);
      if (!node) continue;
      const cells = [];
      for (let ci = minCol; ci <= maxCol; ci++) {
        const colId  = colIds[ci];
        const col    = cols[ci];
        const raw    = Table._api.getValue(colId, node);
        const colDef = col.getColDef();
        let text = raw;
        if (colDef.valueFormatter) {
          const fmt = colDef.valueFormatter({ value: raw, data: node.data, node, column: col, api: Table._api, colDef });
          if (fmt != null) text = fmt;
        }
        cells.push(text == null ? '' : String(text));
      }
      rowStrs.push(cells.join('\t'));
    }
    navigator.clipboard?.writeText(rowStrs.join('\n')).catch(() => {});
    const gridEl = document.getElementById('ag-grid');
    if (gridEl) {
      Table._rangeHighlighted.forEach(key => {
        const sep  = key.indexOf('|');
        const cell = gridEl.querySelector(`.ag-row[row-index="${key.slice(0, sep)}"] .ag-cell[col-id="${key.slice(sep + 1)}"]`);
        if (cell) { cell.classList.add('ag-cell-copy-flash'); setTimeout(() => cell.classList.remove('ag-cell-copy-flash'), 380); }
      });
    }
    const nRows = maxRow - minRow + 1;
    const nCols = maxCol - minCol + 1;
    Toast.show(Util.t('toast.copied_range').replace('{r}', nRows).replace('{c}', nCols), 'success');
    Table._clearRange();
  },

  _showAlertPopup(taskId) {
    const rel = Store.alertsByTask().get(String(taskId)) || [];
    if (!rel.length) return;
    const t = Store.tasks[taskId];
    const po = t?.PRODUCTION_ORDER || t?.ORDER || String(taskId).slice(0, 8);
    const _esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

    const rows = rel.map(a => {
      const icon  = a.sev === 'err' ? '🔴' : '🟡';
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
      if (btn) { dlg.close(); NIMBUS.AlertsUIAdapter.focus(btn.dataset.alertId); }
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
    const cnt = document.getElementById('nb-note-cnt');
    if (!ta || !cnt) { ErrorLog.error('ui', 'required DOM elements missing for note popover'); return; }
    ta.addEventListener('input', () => {
      cnt.textContent = ta.value.length + '/500';
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
    if (!ta) { ErrorLog.error('ui', 'required DOM element missing: nb-note-ta'); return; }
    if (!Table._api) { ErrorLog.error('ui', 'Table._api not initialized'); return; }
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
  },

  // Scale mandate (CLAUDE.md Production Scale Roadmap): the line-reassignment
  // editor is the actual scheduling control (not just a filter), so it needs
  // type-to-filter even more than the chip picker does — AG Grid Community has
  // no searchable select (that's Enterprise's agRichSelectCellEditor), so this
  // is a small hand-rolled popup editor: text input + filtered option list.
  _SearchableLineEditor: class {
    init(params) {
      this._params = params;
      this._values = (typeof params.values === 'function' ? params.values() : params.values) || [];
      this._chosen = null;
      this._activeIdx = 0;

      this._eGui = document.createElement('div');
      this._eGui.className = 'nse-editor';
      this._eGui.innerHTML = `<input type="text" class="nse-input" autocomplete="off"><div class="nse-list"></div>`;
      this._input = this._eGui.querySelector('.nse-input');
      this._list  = this._eGui.querySelector('.nse-list');
      this._input.value = params.value || '';
      this._input.addEventListener('input', () => this._renderList(this._input.value));
      this._input.addEventListener('keydown', e => this._onKeyDown(e));
      this._renderList('');
    }
    _renderList(q) {
      const query = q.toLowerCase().trim();
      this._filtered = query ? this._values.filter(v => v.toLowerCase().includes(query)) : this._values;
      this._activeIdx = 0;
      const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      this._list.innerHTML = this._filtered.length
        ? this._filtered.map((v, i) => `<div class="nse-opt${i === 0 ? ' active' : ''}" data-i="${i}">${esc(v)}</div>`).join('')
        : `<div class="nse-empty">${Util.t('ui.no_matches')}</div>`;
      this._list.querySelectorAll('.nse-opt').forEach(el => {
        el.addEventListener('mousedown', e => { e.preventDefault(); this._choose(Number(el.dataset.i)); });
      });
    }
    _choose(i) {
      const v = this._filtered[i];
      if (v == null) return;
      this._chosen = v;
      this._input.value = v;
      this._params.api.stopEditing();
    }
    _onKeyDown(e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); this._move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this._move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); this._choose(this._activeIdx); }
      else if (e.key === 'Escape') { this._params.api.stopEditing(true); }
    }
    _move(delta) {
      if (!this._filtered.length) return;
      this._activeIdx = (this._activeIdx + delta + this._filtered.length) % this._filtered.length;
      this._list.querySelectorAll('.nse-opt').forEach((el, i) => el.classList.toggle('active', i === this._activeIdx));
    }
    getGui() { return this._eGui; }
    afterGuiAttached() { this._input.focus(); this._input.select(); }
    getValue() {
      if (this._chosen != null) return this._chosen;
      const typed = this._input.value.trim();
      const exact = this._values.find(v => v.toLowerCase() === typed.toLowerCase());
      return exact != null ? exact : this._params.value;
    }
    isPopup() { return true; }
    destroy() {}
  }
};

/* =============================================================================
   INSPECTOR — right-side detail panel shown on the Timeline tab.
   Edits here write through the Store (source: 'inspector').
   ========================================================================== */
export const Inspector = {
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
    }, 'Inspector');
  },

  show(task) {
    // Refuse to inspect tasks that don't belong to the current plant scope.
    // Only block when the task's plant is positively known and wrong — if
    // getPlantForLine returns null (line unmapped), allow inspection rather
    // than silently failing.
    const taskPlant = Store.getPlantForLine(task.PRODUCTION_LINE) || task.PLANT || null;
    if (Store.selectedPlant && taskPlant && taskPlant !== Store.selectedPlant) {
      Toast.show(Util.t('toast.order_belongs_other_plant'), 'warn');
      return;
    }
    Inspector._currentId = String(task.id);
    Inspector._render(task);
  },
  clear() {
    Inspector._currentId = null;
    const body = document.getElementById('inspector-body');
    if (body) body.innerHTML = `<div class="empty-state">${Util.t('empty.select_order')}</div>`;
  },

  _render(task) {
    const body = document.getElementById('inspector-body');
    if (!body) return;
    if (!task) { Inspector.clear(); return; }

    // Order fields originate from uploaded Excel — escape before innerHTML.
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    const fixed = Store.isFixed(task.id);
    const lineOptions = Table._getLineOptions();
    const relAlerts = Store.alertsByTask().get(String(task.id)) || [];
    // Display-only derived Orig Start (due date minus RUN_TIME) — see
    // Util.impliedOriginalStart. Never reads/writes the raw
    // original_start_date field directly for display.
    const impliedOrigStart = Util.impliedOriginalStart(task);

    body.innerHTML = `
      ${fixed ? `<div class="insp-fix-banner">${Util.t('ui.insp_fixed_banner')}</div>` : ''}
      ${relAlerts.length ? `<div class="insp-card" style="border-color:var(--err);background:var(--err-soft);">
        <h4 style="color:var(--err);">⚐ ${Util.t('ui.insp_alerts_title', { count: relAlerts.length })}</h4>
        ${relAlerts.map(a => `<div style="font-size:12px;margin-bottom:4px;">${esc(a.msg)}</div>`).join('')}
      </div>` : ''}

      <div class="insp-card">
        <h4>${Util.t('ui.insp_order_section')}</h4>
        <div class="insp-row"><label>${Util.t('ui.insp_id')}</label>
          <div class="insp-val">${esc(task.id)}</div></div>
          <div class="insp-row"><label>${Util.t('ui.insp_order')}</label>
          <div class="insp-val">${esc(task.ORDER || task.id)}</div></div>
        <div class="insp-row"><label>${Util.t('ui.insp_material_no')}</label>
          <div class="insp-val">${esc(task.MATERIAL_NUMBER || '—')}</div></div>
        <div class="insp-row"><label>${Util.t('ui.insp_material_desc')}</label>
          <div class="insp-val">${esc(task.MATERIAL_DESCRIPTION || '—')}</div></div>
        <div class="insp-row"><label>${Util.t('ui.insp_qty')}</label>
          <div class="insp-val">${esc(task['ORDER_QUANTITY_(GMEIN)'] || 0)}</div></div>
        <div class="insp-row"><label>${Util.t('ui.insp_color')}</label>
          <div class="insp-val">${esc(task.COLOR || '—')}</div></div>
        <div class="insp-row"><label>${Util.t('ui.insp_form')}</label>
          <div class="insp-val">${esc(task.FORM_SIZE || '—')}</div></div>
        <div class="insp-row"><label>${Util.t('ui.insp_line')}</label>
          <div class="insp-val"><select data-field="PRODUCTION_LINE">
            ${lineOptions.map(l => `<option value="${esc(l)}" ${l === task.PRODUCTION_LINE ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select></div></div>
      </div>

      <div class="insp-card">
        <h4>${Util.t('ui.insp_notes_section')}</h4>
        <div class="insp-notes-wrap">
          <textarea data-field="notes" maxlength="500" placeholder="${Util.t('ph.add_note')}" rows="3">${esc(task.notes || '')}</textarea>
          <div class="insp-notes-counter"><span id="insp-notes-rem">${500 - (task.notes || '').length}</span> ${Util.t('ui.remaining')}</div>
        </div>
      </div>

      <div class="insp-card">
        <h4>${Util.t('ui.insp_schedule_section')}</h4>
        <div class="insp-row"><label>${Util.t('ui.insp_orig_start')}</label>
          <div class="insp-val">${impliedOrigStart ? Util.fmtDTReadable(impliedOrigStart) : '—'}</div></div>
        <div class="insp-row"><label>${Util.t('ui.insp_orig_end')}</label>
          <div class="insp-val">${task.original_end_date ? Util.fmtDTReadable(task.original_end_date) : '—'}</div></div>
        <div class="insp-row"><label>${Util.t('ui.insp_updated_start')}</label>
          <div class="insp-val">
            <input type="text" data-field="start_date" value="${Util.toLocalInput(task.start_date)}">
            ${Inspector._varianceBadge(task)}
          </div></div>
        <div class="insp-row"><label>${Util.t('ui.insp_updated_end')}</label>
          <div class="insp-val">${Util.fmtDTReadable(task.end_date)}</div></div>
        <div class="insp-row"><label>${Util.t('ui.insp_run_time')}</label>
          <div class="insp-val"><input type="number" step="0.25" data-field="RUN_TIME" value="${task.RUN_TIME || 0}"></div></div>
      </div>

      <div class="insp-actions">
        ${fixed
          ? `<button class="btn" onclick="NIMBUS.Inspector.toggleFix(false)">${Util.t('btn.unfix')}</button>`
          : `<button class="btn btn-primary" onclick="NIMBUS.Inspector.toggleFix(true)">${Util.t('btn.fix_order')}</button>`}
        <button class="btn" data-act="override">${Util.t('btn.override_date')}</button>
        <button class="btn btn-ghost" data-act="focus">${Util.t('btn.focus')}</button>
      </div>
    `;

    // Wire inputs
    body.querySelectorAll('[data-field]').forEach(el => {
      el.onchange = () => Inspector._onFieldChange(el.dataset.field, el.value);
    });
    // Action buttons via listeners (id is never concatenated into an HTML attribute).
    const _id = String(task.id);
    body.querySelector('[data-act="override"]')?.addEventListener('click', () => NIMBUS.Table._openOverrideModalForId(_id));
    body.querySelector('[data-act="focus"]')?.addEventListener('click', () => NIMBUS.Timeline.focus(_id));
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
      Util.fpDatetime(_dtEl, {
        onChange() { Inspector._onFieldChange('start_date', _dtEl.value); }
      });
    }
  },

  _varianceBadge(t) {
    // Compares against the derived Orig Start (due date minus RUN_TIME —
    // see Util.impliedOriginalStart), not the raw original_start_date, so
    // the badge stays consistent with what the Orig Start row now shows.
    const orig = Util.impliedOriginalStart(t);
    if (!orig || !t.start_date) return '';
    const curr = t.start_date instanceof Date ? t.start_date : Util.parseDate(t.start_date);
    if (!curr) return '';
    const deltaMs = curr.getTime() - orig.getTime();
    if (Math.abs(deltaMs) < 60 * 1000) return '';
    const days = deltaMs / (24 * 3600 * 1000);
    const txt = Math.abs(days) >= 1
      ? `${days >= 0 ? '+' : ''}${days.toFixed(1)}d`
      : `${days >= 0 ? '+' : ''}${(deltaMs / Config.MS_HOUR).toFixed(1)}h`;
    const cls = deltaMs > 0 ? 'insp-var-late' : 'insp-var-early';
    return `<span class="insp-var ${cls}" title="${window.t('ui.insp_variance_shifted')}">${txt}</span>`;
  },

  _onFieldChange(field, value) {
    if (!Inspector._currentId) return;
    const id = Inspector._currentId;
    const t  = Store.tasks[id];
    if (!t) return;
    const changes = {};
    if (field === 'start_date') {
      const d = Util.parseDate(value);
      if (!d) { Toast.show(window.t('toast.invalid_date'), 'error'); return; }
      changes.start_date = Util.snap(d);
      const dur = Util.runHours(t) * Config.MS_HOUR;
      if (dur > 0) changes.end_date = new Date(changes.start_date.getTime() + dur);
    } else if (field === 'RUN_TIME') {
      const h = parseFloat(value) || 0;
      changes.RUN_TIME = h;
      if (t.start_date) changes.end_date = new Date(t.start_date.getTime() + h * Config.MS_HOUR);
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

  // Per-id debounce timers. A single shared debounce timer (the old design) meant a
  // note on order B within 800ms cancelled order A's pending POST — silent data loss
  // (R5). Keying the timer by task id isolates each order's save.
  _noteTimers: {},
  _persistNote(id, notes) {
    clearTimeout(Inspector._noteTimers[id]);
    Inspector._noteTimers[id] = setTimeout(() => {
      delete Inspector._noteTimers[id];
      const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      Util.fetchTraced(`${Config.API_BASE}/task/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-request-id': reqId },
        body: JSON.stringify({ id, notes })
      })
        .then(async r => {
          if (!r.ok) {
            const parsed = await Util.parseBackendError(r);
            ErrorLog.warn('inspector', `Note rejected (${r.status}): ${parsed.message}`,
              { reqId, status: r.status, id }, { reqId, errorCode: parsed.errorCode });
          }
        })
        .catch(e => ErrorLog.warn('inspector', `Note persist failed: ${e.message}`,
          { reqId, id }, { reqId, errorCode: 'http.network' }));
    }, 800);
  },

  toggleFix(fixed) {
    if (!Inspector._currentId) return;
    Store.setFixed([Inspector._currentId], fixed, 'inspector');
    Alerts.scheduleRecompute();
  }
};

/* =============================================================================
   CONTEXT MENU — right-click on a timeline item.
   ========================================================================== */
export const ContextMenu = {
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

// VirtualList row-height constants for Hierarchy's sidebar (moved from
// app.js's top-of-file const group alongside VL_LS_ROW_H/VL_ALERT_ROW_H —
// those two travel with Dashboard/AlertsUIAdapter in later Phase 3 tasks).
const VL_HIER_LINE_H = 38;
const VL_HIER_TASK_H = 28;

/* =============================================================================
   HIERARCHY — left sidebar with per-line order lists + utilisation chip.
   ========================================================================== */
export const Hierarchy = {
  _open:      new Set(),
  _lineItems: [],
  _vl:        null,
  _wired:     false,
  _todayCache: null,   // { key, matrix } — local memo of the 1-day plant-scoped util matrix

  _renderPending: false,

  _scheduleRender() {
    if (Hierarchy._renderPending) return;
    Hierarchy._renderPending = true;
    requestAnimationFrame(() => {
      Hierarchy._renderPending = false;
      Hierarchy.render();
    });
  },

  init() {
    Store.subscribe(evt => {
      if (evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate'
          || evt.type === 'task:update') {
        // Defer bulk/task updates to the next frame so multiple same-tick emits
        // (e.g. optimize + autoReflow) coalesce into one render.
        Hierarchy._scheduleRender();
      } else if (evt.type === 'calendar:change' || evt.type === 'blocks:change'
          || evt.type === 'fixed:change' || evt.type === 'plant:selected'
          || evt.type === 'lineSettings:change') {
        Hierarchy.render();
      }
    }, 'Hierarchy');
  },

  _itemH(item) {
    return VL_HIER_LINE_H + (Hierarchy._open.has(item.name) ? item.tasks.length * VL_HIER_TASK_H : 0);
  },

  _renderItem(item) {
    const open = Hierarchy._open.has(item.name);
    const chip = item.pct != null
      ? `<span class="line-util ${item.sev}">${item.pct}%</span>`
      : `<span class="line-util">—</span>`;
    return `<details class="line-group" data-line="${item.name}"${open ? ' open' : ''}>` +
      `<summary>` +
      `<span class="line-expand">${open ? '−' : '+'}</span>` +
      `<span class="line-dot" style="background:${item.color}"></span>` +
      (item.pinned ? '<span class="line-pin-ico" aria-hidden="true">📌</span>' : '') +
      `<span>${item.name}</span>` +
      `<span style="color:var(--fg-faint);font-weight:500;">(${item.tasks.length})</span>` +
      `${chip}</summary>` +
      (open ? item.tasks.map((tk, i) => {
        const fixed = Store.isFixed(tk.id);
        return `<div class="hier-item${fixed ? ' fixed' : ''}" data-id="${tk.id}">` +
          (fixed ? '<span class="lock-ico">🔒</span>' : '') +
          `<span>[${i + 1}] ${tk.ORDER || tk.id}</span></div>`;
      }).join('') : '') +
      `</details>`;
  },

  render() {
    const el = document.getElementById('hierarchy');
    if (!el) return;
    if (!Store.selectedPlant) {
      if (Hierarchy._vl) { Hierarchy._vl.destroy(); Hierarchy._vl = null; }
      NIMBUS.EmptyState.render(el, {
        title: Util.t('empty.no_plant_selected'),
        msg:   Util.t('empty.no_plant_hierarchy')
      });
      return;
    }

    const lines = {};
    for (const tk of Store.tasksForSelectedPlant()) {
      const k = tk.PRODUCTION_LINE || 'Unknown';
      (lines[k] ||= []).push(tk);
    }
    for (const l of Store.linesForSelectedPlant()) {
      if (!lines[l]) lines[l] = [];
    }
    const lineNames = Object.keys(lines).sort();
    let visibleNames = (GanttFilter?._selectedLines?.size > 0)
      ? lineNames.filter(l => GanttFilter._selectedLines.has(l))
      : lineNames;
    // Surface the user's pinned lines at the top (scale-safe quick access at
    // 70+ lines/plant), preserving alpha order within each group.
    let _pinnedLines;
    try { _pinnedLines = new Set(Store.pref('pinnedLines') || []); } catch { _pinnedLines = new Set(); }
    if (_pinnedLines.size) {
      visibleNames = [
        ...visibleNames.filter(l => _pinnedLines.has(l)),
        ...visibleNames.filter(l => !_pinnedLines.has(l)),
      ];
    }

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);

    // Utilization chip reads the SAME proportional daily-load matrix the Dashboard
    // heatmap + Line Status use, so all three agree for today (fixes R197). Plant-scoped
    // srcTasks matches Dashboard._filteredTasks() and is non-cacheable, so it never
    // thrashes the shared Utilization._cache (TimelineNav's multi-day entry). Memoize locally.
    const _todayKey = Util.dayKey(Util.startOfDay(todayStart));
    const _utilMKey = `${todayStart.getTime()}|1|${Store.rev()}|${Store.selectedPlant || 'all'}`;
    let _utilToday;
    if (Hierarchy._todayCache && Hierarchy._todayCache.key === _utilMKey) {
      _utilToday = Hierarchy._todayCache.matrix;
    } else {
      _utilToday = Utilization.computeMatrix(todayStart, 1, Store.tasksForSelectedPlant());
      Hierarchy._todayCache = { key: _utilMKey, matrix: _utilToday };
    }

    Hierarchy._lineItems = visibleNames.map(name => {
      const ci    = Timeline._colorIndex(name);
      const color = Config.COLORS[ci % Config.COLORS.length];
      const tasks = lines[name]
        .filter(tk => tk.start_date >= todayStart && tk.start_date <= todayEnd)
        .sort((a, b) => (a.start_date?.getTime() || 0) - (b.start_date?.getTime() || 0));
      const u   = _utilToday[name]?.[_todayKey];
      const pct = (u && u.scheduled > 0) ? Math.round(u.pct * 100) : null;
      const sev = u
        ? Utilization.sev(u.pct, u.capacity > 0 ? u.effectiveCapacity / u.capacity : Config.OVERLOAD_THRESHOLD)
        : 'ok';
      return { name, tasks, color, pct, sev, pinned: _pinnedLines.has(name) };
    });

    if (!Hierarchy._vl) {
      el.innerHTML = '';
      Hierarchy._vl = new VirtualList(el, {
        getRowH:   (item) => Hierarchy._itemH(item),
        renderFn:  (item) => Hierarchy._renderItem(item),
        mountEl:   el,
        buffer:    4,
      });
    }

    // Wire once on the persistent #hierarchy element (its innerHTML is
    // cleared on plant deselect, but the node itself is never replaced).
    // Expand/collapse is click-driven with _open as the single source of
    // truth — the native <details> toggle is suppressed because its async
    // `toggle` event (also queued when innerHTML inserts `details[open]`)
    // races the VirtualList rebuild. To open a row programmatically,
    // mutate Hierarchy._open and call render(); do not set det.open.
    if (!Hierarchy._wired) {
      Hierarchy._wired = true;
      el.addEventListener('click', e => {
        const sum = e.target.closest('details.line-group > summary');
        if (sum) {
          e.preventDefault();
          const name = sum.parentElement.dataset.line;
          if (Hierarchy._open.has(name)) Hierarchy._open.delete(name);
          else Hierarchy._open.add(name);
          if (Hierarchy._vl) Hierarchy._vl.update(Hierarchy._lineItems);
          return;
        }
        const item = e.target.closest('.hier-item');
        if (item) Timeline.focus(item.dataset.id);
      });
    }

    Hierarchy._vl.update(Hierarchy._lineItems);
  }
};

/* =============================================================================
   GANTT FILTER — visual filter bar for the Gantt. Dims non-matching items.
   Does NOT affect optimiser; purely presentational.

   CQ-1 Phase 3 Task 3: added `selectedLines()`/`activeFilter()`/
   `isolateLine(line)`/`restoreAllLines()` as public replacements for direct
   `_selectedLines`/`_active`/`_refreshLineBtn`/`_buildLineDropdown` reaches
   from nimbus-intelligence.js (see that file's CommandPalette isolate-line
   command and confidence-score anyFilterActive computation, both updated to
   call these instead). This closes 4 of the 8 `GanttFilter._*` rows tracked
   in docs/architecture/cq1-compatibility-inventory.md §4.2 — the other 4
   (`_toggleLineDropdown`/`_toggleColorDropdown`/`_toggleFormDropdown`/
   `_togglePoMatDropdown`) are reached only from index.html's inline click
   handlers targeting `NIMBUS.GanttFilter`'s toggle-dropdown methods, not from
   nimbus-intelligence.js, and this phase's Global Constraints forbid
   touching any inline-onclick string not explicitly named (only
   `Interaction._showMultiInspector`'s three onclick strings are in scope,
   in Task 5) — so those 4 stay open, tracked in the compatibility inventory
   as a deliberate scope boundary, not an oversight.
   ========================================================================== */
export const GanttFilter = {
  _active:         { text: '' },
  _selectedLines:  new Set(),
  _selectedColors: new Set(),
  _selectedForms:  new Set(),
  _pastedIds:      new Set(),
  _bar:            null,
  _lineSearch:     '',
  _colorSearch:    '',
  _formSearch:     '',

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
        GanttFilter._clearPoMat();
        GanttFilter._resetSearch();
        GanttFilter.populate();
        GanttFilter._buildLineDropdown();
        GanttFilter._refreshLineBtn();
        setTimeout(() => GanttFilter._apply(), 80);
      }
    }, 'GanttFilter');

    const _fltPairs = [
      [document.getElementById('gantt-flt-line-btn'),  document.getElementById('gantt-line-dropdown')],
      [document.getElementById('gantt-flt-color-btn'), document.getElementById('gantt-color-dropdown')],
      [document.getElementById('gantt-flt-form-btn'),  document.getElementById('gantt-form-dropdown')],
      [document.getElementById('gantt-flt-pomat-btn'), document.getElementById('gantt-pomat-dropdown')],
    ];
    document.addEventListener('click', e => {
      if (_fltPairs.every(([, d]) => !d || d.hidden)) return;
      for (const [btn, drop] of _fltPairs) {
        if (drop && !drop.hidden && btn && !btn.contains(e.target) && !drop.contains(e.target)) {
          drop.hidden = true;
        }
      }
    });

    const lineIn  = document.getElementById('gantt-line-paste-input');
    const colorIn = document.getElementById('gantt-color-paste-input');
    const formIn  = document.getElementById('gantt-form-paste-input');
    Util.wirePasteToCheckboxes(lineIn,
      () => document.getElementById('gantt-line-checklist')?.querySelectorAll('input[type=checkbox]') || []);
    Util.wirePasteToCheckboxes(colorIn,
      () => document.getElementById('gantt-color-checklist')?.querySelectorAll('input[type=checkbox]') || []);
    Util.wirePasteToCheckboxes(formIn,
      () => document.getElementById('gantt-form-checklist')?.querySelectorAll('input[type=checkbox]') || []);
    // Scale mandate (CLAUDE.md Production Scale Roadmap): line/color/form pickers
    // must stay filterable, not a bare scrollable checkbox list. Paste-to-select
    // (above) and type-to-filter (below) share the same input without conflict —
    // wirePasteToCheckboxes only listens for 'paste', this only listens for 'input'.
    if (lineIn)  lineIn.oninput  = () => GanttFilter._filterLineSearch(lineIn.value);
    if (colorIn) colorIn.oninput = () => GanttFilter._filterColorSearch(colorIn.value);
    if (formIn)  formIn.oninput  = () => GanttFilter._filterFormSearch(formIn.value);

    const poTa = document.getElementById('gantt-pomat-textarea');
    if (poTa) {
      poTa.addEventListener('paste', GanttFilter._onPoMatPaste);
      poTa.addEventListener('input', Util.debounce(GanttFilter._onPoMatApply, 150));
    }
    document.getElementById('gantt-pomat-clear')?.addEventListener('click', GanttFilter._clearPoMat);

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
    if (!Util.taskMatchesPasteSet(task, GanttFilter._pastedIds)) return false;
    if (text) {
      const haystack = [(task.text || ''), (task.ORDER || ''), (task.MATERIAL_DESCRIPTION || '')].join(' ').toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  },

  isActive() {
    return !!(GanttFilter._selectedColors.size || GanttFilter._selectedForms.size
      || GanttFilter._pastedIds.size || GanttFilter._active.text);
  },

  clear() {
    GanttFilter._active = { text: '' };
    const textIn = document.getElementById('flt-text');
    if (textIn) textIn.value = '';
    GanttFilter._selectedLines.clear();
    GanttFilter._selectedColors.clear();
    GanttFilter._selectedForms.clear();
    GanttFilter._clearPoMat();
    GanttFilter._resetSearch();
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

  // Clears the line/color/form live-search text and its <input> values without
  // touching selections — shared by the plant-change handler and clear().
  _resetSearch() {
    GanttFilter._lineSearch = GanttFilter._colorSearch = GanttFilter._formSearch = '';
    const lineIn  = document.getElementById('gantt-line-paste-input');
    const colorIn = document.getElementById('gantt-color-paste-input');
    const formIn  = document.getElementById('gantt-form-paste-input');
    if (lineIn)  lineIn.value  = '';
    if (colorIn) colorIn.value = '';
    if (formIn)  formIn.value  = '';
  },

  _toggleLineDropdown() {
    const drop = document.getElementById('gantt-line-dropdown');
    if (drop) drop.hidden = !drop.hidden;
  },

  // Scale mandate (CLAUDE.md Production Scale Roadmap): every plant/line picker
  // must stay filterable, not a bare scrollable checkbox list — this is the
  // Gantt line filter's share of that, matching the Dashboard's line filter.
  _filterLineSearch(q) {
    GanttFilter._lineSearch = q || '';
    GanttFilter._buildLineDropdown();
  },

  _buildLineDropdown() {
    const drop = document.getElementById('gantt-line-checklist');
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
    const q = GanttFilter._lineSearch.toLowerCase().trim();
    const visible = q ? sorted.filter(l => l.toLowerCase().includes(q)) : sorted;
    const esc = s => String(s).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    drop.innerHTML = visible.length
      ? visible.map(l =>
          `<label><input type="checkbox" value="${esc(l)}"${GanttFilter._selectedLines.has(l) ? ' checked' : ''}
           onchange="NIMBUS.GanttFilter._onLineChange(this)"> ${esc(l)}</label>`
        ).join('')
      : `<div style="padding:8px 14px;font-size:12px;color:#9a9285">${sorted.length ? Util.t('ui.no_matches') : 'No lines'}</div>`;
  },

  _refreshLineBtn() {
    const btn = document.getElementById('gantt-flt-line-btn');
    const lbl = document.getElementById('gantt-flt-line-label');
    if (!lbl) return;
    const n = GanttFilter._selectedLines.size;
    lbl.textContent = n === 0 ? Util.t('ui.all_lines')
      : n === 1 ? [...GanttFilter._selectedLines][0]
      : Util.t('ui.n_lines_filter', { count: n });
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

  _filterColorSearch(q) {
    GanttFilter._colorSearch = q || '';
    GanttFilter._buildColorDropdown();
  },

  _buildColorDropdown() {
    const drop = document.getElementById('gantt-color-checklist');
    if (!drop) return;
    const scoped = Store.selectedPlant ? Store.tasksForSelectedPlant() : [];
    const colorSet = new Set(scoped.map(t => (t.COLOR || '').toUpperCase()).filter(Boolean));
    const sorted = [...colorSet].sort();
    for (const c of [...GanttFilter._selectedColors]) {
      if (!colorSet.has(c)) GanttFilter._selectedColors.delete(c);
    }
    const q = GanttFilter._colorSearch.toLowerCase().trim();
    const visible = q ? sorted.filter(c => c.toLowerCase().includes(q)) : sorted;
    const esc = s => String(s).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    drop.innerHTML = visible.length
      ? visible.map(c =>
          `<label><input type="checkbox" value="${esc(c)}"${GanttFilter._selectedColors.has(c) ? ' checked' : ''}
           onchange="NIMBUS.GanttFilter._onColorChange(this)"> ${esc(c)}</label>`
        ).join('')
      : `<div style="padding:8px 14px;font-size:12px;color:#9a9285">${sorted.length ? Util.t('ui.no_matches') : 'No colors'}</div>`;
    GanttFilter._refreshColorBtn();
  },

  _refreshColorBtn() {
    const lbl = document.getElementById('gantt-flt-color-label');
    if (!lbl) return;
    const n = GanttFilter._selectedColors.size;
    lbl.textContent = n === 0 ? Util.t('ui.all_colors')
      : n === 1 ? [...GanttFilter._selectedColors][0]
      : Util.t('ui.n_colors_filter', { count: n });
    const btn = document.getElementById('gantt-flt-color-btn');
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

  _filterFormSearch(q) {
    GanttFilter._formSearch = q || '';
    GanttFilter._buildFormDropdown();
  },

  _buildFormDropdown() {
    const drop = document.getElementById('gantt-form-checklist');
    if (!drop) return;
    const scoped = Store.selectedPlant ? Store.tasksForSelectedPlant() : [];
    const formSet = new Set(scoped.map(t => (t.FORM_SIZE || '').toUpperCase()).filter(Boolean));
    const sorted = [...formSet].sort();
    for (const f of [...GanttFilter._selectedForms]) {
      if (!formSet.has(f)) GanttFilter._selectedForms.delete(f);
    }
    const q = GanttFilter._formSearch.toLowerCase().trim();
    const visible = q ? sorted.filter(f => f.toLowerCase().includes(q)) : sorted;
    const esc = s => String(s).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    drop.innerHTML = visible.length
      ? visible.map(f =>
          `<label><input type="checkbox" value="${esc(f)}"${GanttFilter._selectedForms.has(f) ? ' checked' : ''}
           onchange="NIMBUS.GanttFilter._onFormChange(this)"> ${esc(f)}</label>`
        ).join('')
      : `<div style="padding:8px 14px;font-size:12px;color:#9a9285">${sorted.length ? Util.t('ui.no_matches') : 'No forms'}</div>`;
    GanttFilter._refreshFormBtn();
  },

  _refreshFormBtn() {
    const btn = document.getElementById('gantt-flt-form-btn');
    const lbl = document.getElementById('gantt-flt-form-label');
    if (!lbl) return;
    const n = GanttFilter._selectedForms.size;
    lbl.textContent = n === 0 ? Util.t('ui.all_forms')
      : n === 1 ? [...GanttFilter._selectedForms][0]
      : Util.t('ui.n_forms_filter', { count: n });
    if (btn) btn.classList.toggle('active', n > 0);
  },

  _onFormChange(cb) {
    if (cb.checked) GanttFilter._selectedForms.add(cb.value.toUpperCase());
    else            GanttFilter._selectedForms.delete(cb.value.toUpperCase());
    GanttFilter._refreshFormBtn();
    GanttFilter._apply();
  },

  _togglePoMatDropdown() {
    const drop = document.getElementById('gantt-pomat-dropdown');
    if (drop) drop.hidden = !drop.hidden;
  },

  _refreshPoMatBtn() {
    const btn = document.getElementById('gantt-flt-pomat-btn');
    const lbl = document.getElementById('gantt-flt-pomat-label');
    if (!lbl) return;
    const n = GanttFilter._pastedIds.size;
    lbl.textContent = n === 0 ? Util.t('ui.all_pomat') : Util.t('ui.n_pomat_filter', { count: n });
    if (btn) btn.classList.toggle('active', n > 0);
  },

  _onPoMatApply() {
    const ta = document.getElementById('gantt-pomat-textarea');
    if (!ta) return;
    GanttFilter._pastedIds = new Set(Util.parsePasteList(ta.value).map(Util.norm));
    const cnt = document.getElementById('gantt-pomat-count');
    if (cnt) {
      const n = GanttFilter._pastedIds.size;
      cnt.textContent = n ? Util.t('ui.pomat_count', { count: n }) : '';
    }
    GanttFilter._refreshPoMatBtn();
    GanttFilter._apply();
  },

  _onPoMatPaste(e) {
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (!text || !text.trim()) return;
    const known = new Set();
    (Store.selectedPlant ? Store.tasksForSelectedPlant() : []).forEach(task => {
      const po = Util.norm(task.ORDER ?? task.PRODUCTION_ORDER); if (po) known.add(po);
      const mat = Util.norm(task.MATERIAL_NUMBER); if (mat) known.add(mat);
    });
    const { matched, total } = Util.countPasteMatches(text, known);
    if (total) Toast.show(Util.t('toast.paste_pomat_match', { matched, total }), matched > 0 ? 'success' : 'warn');
  },

  _clearPoMat() {
    GanttFilter._pastedIds.clear();
    const ta = document.getElementById('gantt-pomat-textarea');
    if (ta) ta.value = '';
    const cnt = document.getElementById('gantt-pomat-count');
    if (cnt) cnt.textContent = '';
    GanttFilter._refreshPoMatBtn();
    GanttFilter._apply();
  },

  _apply: null,  // assigned below after Util is in scope

  _doApply() {
    if (!Timeline._items) return;
    const active = GanttFilter.isActive();
    const badge = document.getElementById('flt-badge');
    const bar   = document.getElementById('gantt-filterbar');

    const updates = [];
    const scoped = Store.selectedPlant ? Store.tasksForSelectedPlant() : [];
    for (const task of scoped) {
      if (!task.start_date || !task.end_date) continue;
      const id = String(task.id);
      const item = Timeline._items.get(id);
      if (!item) continue;
      const shouldDim = active && !GanttFilter.matches(task);
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
            + (GanttFilter._pastedIds.size > 0 ? 1 : 0)
            + (GanttFilter._active.text ? 1 : 0);
    if (badge) badge.textContent = n + ' filter' + (n !== 1 ? 's' : '');
    const wrap = document.getElementById('flt-badge-wrap');
    if (wrap) wrap.hidden = (n === 0);
    if (bar) bar.classList.toggle('filter-active', active);
  },

  // --- Public replacements for the old private surface (closes the Task 3
  // GanttFilter._selectedLines/_active/_refreshLineBtn/_buildLineDropdown
  // private-consumer debt tracked in cq1-compatibility-inventory.md §4.2 for
  // nimbus-intelligence.js call sites). Exact same behavior as the direct
  // private-field sequences these replace.
  selectedLines() { return GanttFilter._selectedLines; },
  activeFilter()  { return GanttFilter._active; },
  isolateLine(line) {
    GanttFilter._selectedLines.clear();
    GanttFilter._selectedLines.add(line);
    GanttFilter._refreshLineBtn();
    GanttFilter._buildLineDropdown();
  },
  restoreAllLines() {
    GanttFilter._selectedLines.clear();
    GanttFilter._refreshLineBtn();
    GanttFilter._buildLineDropdown();
  },
};

GanttFilter._apply = Util.debounce(() => GanttFilter._doApply(), 60);
