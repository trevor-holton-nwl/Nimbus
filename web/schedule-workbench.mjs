// schedule-workbench.mjs — CQ-1 schedule-workbench module.
//
// Owns the planner workspace: timeline, order grid, inspector, hierarchy,
// dashboard, navigation, filters, dependency overlay, context menu,
// interaction pipeline, and planner dialogs. Third-party instances
// (vis-timeline, AG Grid) stay private to this module. Also owns the
// SandboxAdapter/AlertsUIAdapter DOM remnants from Phase 1/2, whose coupling
// profile puts them here — see docs/architecture/cq1-compatibility-inventory.md.
//
// CQ-1 Phase 3 Task 1 adds Timeline, TimelineNav, and DependencyOverlay only —
// later tasks in this same phase add Table/Inspector/ContextMenu (Task 2),
// Hierarchy/GanttFilter (Task 3), Dashboard (Task 4), Interaction (Task 5),
// OptimizeDialog/OptimizerPreview (Task 6), and EditCalendar/ColorWheelViewer/
// Printer/SandboxAdapter/AlertsUIAdapter (Task 7).
//
// Timeline still has five genuine cross-references into app.js-resident code
// that hasn't moved here yet — App.gotoGanttTimeline() (App never moves into
// this file; it targets application-shell.mjs in Phase 4), Inspector.show()
// (moves here in Task 2), Interaction.DEBUG (moves here in Task 5),
// GanttFilter._selectedLines (moves here in Task 3), and EmptyState.render()
// (stays in app.js — boot UI, not part of this phase's module list). All five
// are reached via the shared `NIMBUS` binding (the classic-script top-level
// const app.js assigns itself to) rather than as bare identifiers: unlike
// `Timeline`/`Inspector`/etc themselves (which are function-scoped inside
// app.js's IIFE and thus invisible outside it), `NIMBUS` is declared at the
// classic-script's true top level, so it is part of the realm's shared global
// declarative scope and resolvable from any module on the same page — see
// index.html/app-entry.mjs. `web/**/*.mjs` files don't have `NIMBUS` in their
// ESLint global list (only web/app.js and web/nimbus-intelligence.js do), so
// it's declared via an in-file `/* global */` comment below rather than a
// config change (Global Constraints: eslint.config.js needs zero changes).
// Bare `t(...)` calls became `Util.t(...)` instead (the established Phase 2
// convention — see schedule-services.mjs), since `Util.t` is a real export
// and `window.t` is just a thin wrapper around it.
/* global NIMBUS */
import { Config, Util, PerfMonitor, ErrorLog } from './application-foundation.mjs';
import { Store, Selection } from './schedule-state.mjs';
import { Utilization } from './schedule-services.mjs';

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
