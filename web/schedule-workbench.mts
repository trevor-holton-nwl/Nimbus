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
// Task 4 added Dashboard, plus the `VL_LS_ROW_H` VirtualList row-height const
// it uses (moved from app.js's top-of-file const group, same as
// VL_HIER_LINE_H/VL_HIER_TASK_H in Task 3 — VL_ALERT_ROW_H still travels with
// AlertsUIAdapter in Task 7). Dashboard's `Store._rev || 0` and
// `Store._state.masterData` direct touches became `Store.rev()` and
// `Store.masterData` (both pre-existing Phase 1 public getters — no new
// getter needed), closing Dashboard's §6 row. Dashboard also had three bare
// cross-references into app.js-resident code that hasn't moved yet —
// `AlertsUIAdapter.renderBell()`, `EmptyState.render(...)`, and
// `App.goto(...)`/`App.gotoGanttTimeline()` — all rewritten to go through the
// shared `NIMBUS` binding, same rationale as Timeline's/Table's cross-
// references above. Its Chart.js-era header comment in app.js's module map
// ("Dashboard — home KPIs + Chart.js charts") was stale — Dashboard has
// always been a hand-rolled DOM/CSS heatmap; Chart.js itself was never
// instantiated anywhere in the codebase, so Task 4 also drops the dead
// `<script>` tag from index.html.
//
// Task 5 added Interaction — the densest module in the codebase and, before
// this task, the one with zero test coverage anywhere. Its one bare
// cross-reference into app.js-resident code that hasn't moved yet —
// `AlertsUIAdapter.showForCell(...)` inside the alertcell-click delegate —
// went through the shared `NIMBUS` binding, same rationale as Table's
// `_showAlertPopup` forward reference (resolves normally once AlertsUIAdapter
// moves here in Task 7). All bare `t(...)` i18n calls became `Util.t(...)`,
// same established convention. `_showMultiInspector`'s generated panel HTML
// carried FOUR inline onclick strings, not the three this plan's own
// Architecture section named (`_bulkFix(true)`, `_bulkFix(false)`,
// `Selection.clear()`, and a fourth it missed — `_unscheduleSelected()`) — all
// four are now real `addEventListener` wiring via `data-action` attributes
// instead. `install()`'s three document-level listeners (mousemove/
// mouseleave/keydown) and `_installHoverPreview()`'s separate document
// keydown dismiss listener were mechanically refactored from inline arrows
// into named, stored bound references (`_edgeScrollTrackBound`/
// `_hideTooltipBound`/`_onKeyDownBound`/`_hoverDismissBound`) — a structural
// change with no behavior change — so the new `uninstall()` method has real
// references to remove. `uninstall()` is purely additive and intentionally
// unwired: Gantt Timeline's lifecycle stays mount-once/show-hide (§2), so
// there is no unmount trigger to call it from yet; it exists as tested,
// correct, dormant teardown machinery (see
// docs/architecture/cq1-compatibility-inventory.md for the full writeup).
// Task 5's new characterization tests also found that `_onDataSetUpdate`'s
// header comment ("Fixed orders are reverted in the DataSet and never reach
// the Store") does not match the actual code — a genuine drag on a fixed
// order falls through to the same commit path as a non-fixed drag; only a
// spurious no-op echo is suppressed. That comment is corrected in place
// (comment-only; the underlying logic is unchanged, preserving current
// behavior byte-for-byte per this phase's Global Constraints).
//
// Task 6 added OptimizeDialog and OptimizerPreview, moved verbatim (the
// closure-private flatpickr instances inside OptimizeDialog's IIFE are
// unchanged). Both modules' bare `t(...)` i18n calls became `Util.t(...)`,
// the same established convention as every other module in this file.
// OptimizeDialog.applyPreset's one `Store._state.masterData` read is left
// untouched — it is not one of this phase's 5 tracked §6 exceptions
// (Timeline/Hierarchy/Dashboard/GanttFilter/DependencyOverlay), so closing it
// is out of this task's scope. OptimizerPreview's `NIMBUS.Confidence?.
// snapshot()/.restore()`/`._recompute()` cross-file calls stay exactly as-is
// — `Confidence` lives entirely in nimbus-intelligence.js, out of scope for
// CQ-1's module bridges regardless of which file OptimizerPreview lives in.
//
// Task 7 added EditCalendar, ColorWheelViewer, Printer, SandboxAdapter, and
// AlertsUIAdapter (plus AlertsUIAdapter's `VL_ALERT_ROW_H` VirtualList
// row-height const, moved from app.js's top-of-file const group), all moved
// verbatim. `AlertsUIAdapter`'s move is a deliberate, documented scope
// decision, not the design doc's mandate (only `SandboxAdapter`'s move is
// explicitly mandated) — see docs/architecture/cq1-compatibility-inventory.md
// for the coupling evidence. Table's `_showAlertPopup` forward reference into
// `AlertsUIAdapter` (accepted as temporary in Task 2) and Interaction's
// `AlertsUIAdapter.showForCell(...)` forward reference (Task 5) now resolve
// as normal same-module references — both call sites are left exactly as
// `NIMBUS.AlertsUIAdapter...` (a bare identifier would resolve identically;
// touching call sites that already work is not required by this task). The
// shared hour-conversion helpers previously duplicated as `CalendarUI`'s
// private `_hToT`/`_tToH` moved to `Util.hoursToTimeString`/`.timeStringToHours`
// in application-foundation.mjs — `EditCalendar`'s five call sites (and
// `CalendarUI`'s own, and `Plant`'s two, both still in app.js) now call the
// shared helper instead of reaching across files. All bare `t(...)` i18n
// calls across the five modules became `Util.t(...)`, the same established
// convention as every other module in this file. `AlertsUIAdapter.focus`'s one
// `App.gotoGanttTimeline()` call and `SandboxAdapter`'s `Store._state.blocks`/
// `.plantBlocks` reads and `AlertsUIAdapter.renderDrawer`/`.renderBell`'s
// `Store._state.masterData` reads are left untouched — `App.gotoGanttTimeline`
// becomes `NIMBUS.App.gotoGanttTimeline()` (permanent indirection, same as
// Dashboard's, since `App` never moves into this file — Phase 4,
// `application-shell.mjs`), and none of the `Store._state` touches are among
// this phase's 5 tracked §6 exceptions, so closing them is out of scope here.
// `CalendarSync`/`Sandbox`/`Calendar` are new imports this task needs
// (`SandboxAdapter` calls `Sandbox.active`/`.enter`/`CalendarSync.flushPlant`/
// `.fetchPlantConfig`/`._deferredHydrationPlant`; `AlertsUIAdapter.showForCell`
// calls `Calendar.effectiveCapacityHours`). `CalendarUI` and `SessionUIAdapter`
// stay in app.js, deliberately, targeting `plant-and-administration.mjs`/
// `application-shell.mjs` respectively in Phase 4 (see this plan's Architecture
// section and the compatibility inventory).
/* global NIMBUS */
import { Config, Util, PerfMonitor, ErrorLog, Toast, Modal, VirtualList } from './application-foundation.mjs';
import { Store, Selection, UndoStack, Sandbox } from './schedule-state.mjs';
import type { StoreEvent } from './schedule-state.mjs';
import { Calendar, Utilization, Alerts, Engine } from './schedule-services.mjs';
import { Session, Persistence, CalendarSync } from './schedule-data.mjs';
import type { NimbusTask, NimbusBlock, NimbusPlantBlock, AlertType, AlertSev, UtilSevBucket, OptimizerMode, WorkHours } from './types.mjs';

// -- Local type declarations (CQ-1 Phase 6 Task 1 conversion; scoped to
//    Timeline/TimelineNav/DependencyOverlay — later tasks add their own
//    module-scoped types further down this same file as they convert
//    Table/Inspector/ContextMenu/Hierarchy/GanttFilter/etc.) ---------------

/** A vis-timeline item — an order (Timeline._itemForTask) or a blackout/
 *  past-zone/alert-horizon/alert-cell background band (Timeline._itemForBlock
 *  and the synthetic literals built inline in Timeline.rebuild()). Not every
 *  field applies to every kind of item — see the two builder methods and the
 *  synthetic-item call sites for which subset each produces. */
interface TimelineVisItem {
  id: string;
  group: string;
  /** Absent on the synthetic background bands (past-zone, alert-horizon-zone,
   *  alertcell) built inline in Timeline.rebuild() — only order/blackout items
   *  (built by _itemForTask/_itemForBlock) set this. */
  content?: string;
  start: Date;
  end: Date;
  className?: string;
  editable?: boolean;
  type?: 'background';
  title?: string;
}

/** A vis-timeline group — one row per production line. */
interface TimelineGroupData {
  id: string;
  order: number;
  content: string;
}

/** Timeline._viewWindow / TimelineNav's drag-start range — epoch-ms bounds of
 *  the currently-visible (or drag-anchored) viewport. */
interface TimelineWindowMs {
  start: number;
  end: number;
}

/** Timeline.rebuild()'s per-{line, day} alert-cell aggregation (built once from
 *  Store.alerts, then rendered as one background item per cell). */
interface TimelineAlertCellInfo {
  line: string;
  dayKey: string;
  sev: AlertSev;
  hasConflictErr: boolean;
}

/* =============================================================================
   TIMELINE — vis-timeline integration.
     • builds groups (production lines) and items (orders + blackout blocks)
     • two-way sync: user drags → Store.updateTask({ source:'timeline' })
                     Store changes → refresh items, skipping own-source events
     • right-click → ContextMenu
     • double-click → open in Inspector
   ========================================================================== */
export const Timeline = {
  _tl: null as NimbusVendor.VisTimelineInstance | null,
  _items:     null as NimbusVendor.VisDataSet<TimelineVisItem> | null,
  _visItems:  null as NimbusVendor.VisDataView<TimelineVisItem> | null,             // DataView filter layer — vis-timeline sees only items near the viewport
  _groups:    null as NimbusVendor.VisDataSet<TimelineGroupData> | null,
  _viewWindow: null as TimelineWindowMs | null,            // { start: ms, end: ms } — current viewport, kept in sync via rangechanged
  _pastZoneIds:     [] as string[],         // cached IDs for ticker updates (avoids getIds() scan every second)
  _alertHorizonIds: [] as string[],
  _lineColorIdx: {} as Record<string, number>,            // stable line → colour index mapping
  _nextColorIdx: 0,
  _unsubStore:   null as (() => void) | null,
  _suppressEvents: false,       // guard to prevent self-triggered loops
  _conflictSrc: null as NimbusAlert[] | null,           // alerts array reference — invalidates cache when it changes
  _conflictSet: null as Set<string> | null,           // Set<String(taskId)> built once per alerts array identity
  _visEl:       null as HTMLElement | null,           // cached #vis-timeline element (set in init)
  _ganttTab:    null as HTMLElement | null,           // cached #gantt-tab element (see _ganttActive)
  _cachedRowH:  null as number | null,
  _cachedAxisH: null as number | null,
  _rebuildRaf:  null as number | null,

  init(): void {
    const container = document.getElementById('vis-timeline');
    if (!container) return;
    Timeline._visEl = container;

    Timeline._items  = new vis.DataSet<TimelineVisItem>([]);
    Timeline._groups = new vis.DataSet<TimelineGroupData>([]);

    // Sliding-window DataView: vis-timeline only processes items within ±90 days of
    // the current viewport, regardless of how far the full schedule extends.
    // Internal code continues to read/write Timeline._items unchanged.
    const _WIN_BUF_MS = 90 * 24 * 3600 * 1000;
    Timeline._visItems = new vis.DataView<TimelineVisItem>(Timeline._items, {
      filter: (item: TimelineVisItem) => {
        const w = Timeline._viewWindow;
        if (!w) return true;
        const s = item.start instanceof Date ? item.start.getTime() : +item.start;
        const e = item.end   instanceof Date ? item.end.getTime()   : +item.end;
        return s < w.end + _WIN_BUF_MS && e > w.start - _WIN_BUF_MS;
      }
    });

    const options: NimbusVendor.VisTimelineOptions = {
      stack: false,
      editable: { updateTime: true, updateGroup: true, remove: false, add: false },
      // Let an order be dragged directly, without first selecting it with a plain click.
      // That pre-select click is what fired CENTER_ON_CLICK → focus() → viewport pan →
      // DataView refresh, which visually reverted single drags ("spring back"). Blackout /
      // background items stay put because they are created with editable:false.
      itemsAlwaysDraggable: { item: true },
      snap: (d: Date) => Util.snap(d),
      groupOrder: (a: TimelineGroupData, b: TimelineGroupData) => (a.order ?? 0) - (b.order ?? 0),
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
      const w = Timeline._tl!.getWindow();
      Timeline._viewWindow = { start: w.start.getTime(), end: w.end.getTime() };
      Timeline._visItems!.refresh();
      Timeline._tl!.redraw();
    }, 120);
    Timeline._tl.on('rangechanged', _refreshView);

    // One-shot screen calibration: measure real row + axis after first render
    // with content so _fitHeight uses screen-specific values from then on.
    // Selectors are scoped to specific panels because vis-timeline reuses
    // .vis-time-axis for both the label row (top panel, ~30px) AND a
    // full-height grid overlay inside .vis-content. Matching the wrong one
    // would inflate axisH to container height and poison the cache.
    const _calibrate = (): void => {
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
      Timeline._tl!.off('changed', _calibrate);
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
      const updates: Array<{ id: string; start?: Date; end?: Date }> = Timeline._pastZoneIds
        .filter(id => Timeline._items!.get(id))
        .map(id => ({ id, end: now }));
      if (Timeline._alertHorizonIds.length) {
        const plantRow = Store.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null;
        const hz = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? null;
        if (typeof hz === 'number') {
          const hzEnd = new Date(now.getTime() + hz * Config.MS_MIN);
          for (const id of Timeline._alertHorizonIds) {
            if (Timeline._items!.get(id)) updates.push({ id, start: now, end: hzEnd });
          }
        }
      }
      if (updates.length) Timeline._items!.update(updates);
    }, 1000);

    /* ----- subscribe to store changes ----------------------------------- */
    Timeline._unsubStore = Store.subscribe(evt => Timeline._onStore(evt), 'Timeline');
  },

  // Cached lookup for the (static) #gantt-tab; lazily caches on first call so
  // init order can't leave it null. Replaces 4 inline getElementById checks.
  _ganttActive(): boolean {
    if (!Timeline._ganttTab) Timeline._ganttTab = document.getElementById('gantt-tab');
    return Timeline._ganttTab ? Timeline._ganttTab.classList.contains('active') : false;
  },

  /** Handle store updates: refresh vis-timeline WITHOUT echoing back. */
  _onStore(evt: StoreEvent): void {
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
        const sel = NIMBUS!.GanttFilter ? NIMBUS!.GanttFilter!._selectedLines : null;
        const filtered = sel && sel.size > 0;
        const _pmT0patch = performance.now();
        const patches: TimelineVisItem[] = [];
        const ids = (evt.ids as Array<string | number> | undefined) ?? [];
        for (const id of ids) {
          const sid = String(id);
          if (filtered) {
            const t = Store.tasks[sid];
            if (!t || !sel!.has(t.PRODUCTION_LINE || 'Unknown')) continue;
          }
          const patch = Timeline._itemPatchFor(sid);
          if (patch) patches.push(patch);
        }
        if (patches.length) {
          Timeline._suppressEvents = true;
          try {
            Timeline._items!.update(patches);
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
      for (const id of (evt.ids as Array<string | number>)) Timeline._applyTaskPatch(String(id));
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
  _itemPatchFor(id: string): TimelineVisItem | null {
    const t = Store.tasks[id];
    if (!t || !t.start_date || !t.end_date) return null;
    return Timeline._itemForTask(t);
  },

  _applyTaskPatch(id: string): void {
    const patch = Timeline._itemPatchFor(id);
    if (!patch) return;
    Timeline._suppressEvents = true;
    try {
      // DataSet.update() upserts by id (adds if not present) — see the batched
      // tasks:bulkUpdate path above for the multi-id equivalent.
      Timeline._items!.update(patch);
    } finally { Timeline._suppressEvents = false; }
  },

  // Returns a Set of String task IDs that have an active alert. Memoized on the
  // Store.alerts array identity — rebuilt O(alerts) once, then O(1) per task lookup.
  _conflictIds(): Set<string> {
    const src = Store.alerts;
    if (Timeline._conflictSrc !== src) {
      const s = new Set<string>();
      for (const a of src) if (a.taskId != null) s.add(String(a.taskId));
      Timeline._conflictSrc = src;
      Timeline._conflictSet = s;
    }
    return Timeline._conflictSet!;
  },

  /** Build an item object for a task. */
  _itemForTask(t: NimbusTask): TimelineVisItem {
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
      start:   t.start_date!,
      end:     t.end_date!,
      className: cls.join(' ')
    };
  },

  /** Build an item object for a blackout block (non-editable, greyed out). Also called
   *  (with a NimbusPlantBlock — no `line` field) from rebuild()'s plant-blackout loop,
   *  which always passes overrideLine, so the missing `line` field is never actually
   *  reached at runtime — see the `'line' in b` guard below. */
  _itemForBlock(b: NimbusBlock | NimbusPlantBlock, overrideLine?: string): TimelineVisItem {
    // b.id already carries a 'blk-' prefix from Store.addBlock — don't double it.
    // When cloning for a specific line, append the line so IDs stay unique.
    const bLine = 'line' in b ? b.line : null;
    const line = overrideLine || bLine || '__all__';
    const id   = overrideLine ? `${b.id}-${overrideLine}` : b.id;
    return {
      id,
      group:   line,
      content: `<span style="font-style:italic;">✕ ${b.reason || Util.t('ui.blackouts_label', {plural: ''})}</span>`,
      title:   `${Util.t('ui.blackouts_label', {plural: ''})}: ${b.reason || '—'}<br>${Util.fmtDTReadable(b.start)} → ${Util.fmtDTReadable(b.end)}`,
      start:   b.start as Date, end: b.end as Date,
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
  _scheduleRebuild(): void {
    if (Timeline._rebuildRaf) return;
    Timeline._rebuildRaf = requestAnimationFrame(() => {
      Timeline._rebuildRaf = null;
      Timeline.rebuild();
    });
  },

  /** Diff-based rebuild: compare desired item set to current DataSet contents
   *  and emit minimal add/update/remove operations. Preserves selection and
   *  avoids the clear/add flicker of a wholesale replacement.               */
  rebuild(): void {
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
    const lineFilterActive = !!NIMBUS!.GanttFilter
      && NIMBUS!.GanttFilter!._selectedLines
      && NIMBUS!.GanttFilter!._selectedLines!.size > 0;
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
    const conflictIds = new Set<string>();
    for (const a of Store.alerts) if (a.taskId != null) conflictIds.add(String(a.taskId));

    /* ---- groups ------------------------------------------------------------ */
    const groupData: TimelineGroupData[] = visibleLines.map((line, idx) => {
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
    const desired = new Map<string, TimelineVisItem>();
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
          const item: TimelineVisItem = { ...Timeline._itemForBlock(b), id: `${b.id}__${line}`, group: line };
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
        const item: TimelineVisItem = { ...Timeline._itemForBlock(b, line), id: `${b.id}__plant__${line}` };
        desired.set(String(item.id), item);
      }
    }

    // Past-zone shading — one background item per visible line covering [epoch → now].
    // vis-timeline clips the rendered span to the visible window, so the far-past
    // start date is harmless. The item updates each rebuild so the boundary tracks time.
    const pastEnd = new Date();
    const pastStart = new Date('2000-01-01T00:00:00');
    for (const line of visibleLines) {
      const item: TimelineVisItem = {
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
    const alertCellMap: Record<string, TimelineAlertCellInfo> = {};
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
      const item: TimelineVisItem = {
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
    const existingIds = new Set<string>(Timeline._items.getIds().map(String));
    const toAdd: TimelineVisItem[] = [], toUpdate: TimelineVisItem[] = [], toRemove: string[] = [];
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
    const existingGroupIds = new Set<string>(Timeline._groups.getIds().map(String));
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
      Timeline._tl!.setSelection(keep);
      if (NIMBUS!.Interaction && NIMBUS!.Interaction!.DEBUG) {
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

  _fitHeight(groupCount: number): void {
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

  focus(id: string): void {
    const t = Store.tasks[id];
    if (!t || !t.start_date || !t.end_date || !Timeline._tl) return;
    // Force the target into the sliding DataView window first — see
    // _syncViewWindow's doc comment for why vis-timeline's own focus()/
    // setSelection() otherwise silently no-op for out-of-window items.
    Timeline._syncViewWindow(t.start_date.getTime(), t.end_date.getTime());
    // vis-timeline's focus() scrolls both horizontally (time) and vertically (line row).
    Timeline._tl.focus(String(id), { animation: { duration: 300 } });
    Timeline._tl.setSelection([String(id)]);
    NIMBUS!.Inspector!.show!(t);
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
  _syncViewWindow(startMs: number, endMs: number): void {
    const cur = Timeline._viewWindow;
    Timeline._viewWindow = {
      start: cur ? Math.min(cur.start, startMs) : startMs,
      end:   cur ? Math.max(cur.end,   endMs)   : endMs,
    };
    if (Timeline._visItems) Timeline._visItems.refresh();
  },

  setView(mode: string): void {
    if (!Timeline._tl) return;
    const now = new Date();
    let start: Date, end: Date;
    if (mode === 'hour') {
      start = Util.startOfDay(now)!;
      end   = new Date(start.getTime() + 24 * Config.MS_HOUR);
    } else if (mode === 'day') {
      start = Util.startOfDay(now)!;
      end   = new Date(start.getTime() + 3 * 24 * Config.MS_HOUR);
    } else {
      start = Util.startOfDay(now)!;
      end   = new Date(start.getTime() + 7 * 24 * Config.MS_HOUR);
    }
    Timeline._tl.setWindow(start, end, { animation: { duration: 300 } });
    document.querySelectorAll<HTMLElement>('.gantt-toolbar .seg-btn[data-view]').forEach(b => {
      b.classList.toggle('active', b.dataset.view === mode);
    });
  },

  redraw(): void { if (Timeline._tl) Timeline._tl.redraw(); },

  /** Show or hide the "select a plant" overlay above the vis-timeline. */
  _renderEmptyOverlay(): void {
    const overlay = document.getElementById('timeline-empty-overlay');
    if (!overlay) return;
    if (!Store.selectedPlant) {
      NIMBUS!.EmptyState!.render!(overlay, {
        title: Util.t('empty.select_plant_timeline'),
        msg:   Util.t('ui.select_plant_orders_msg')
      });
      overlay.hidden = false;
    } else {
      overlay.hidden = true;
      overlay.innerHTML = '';
    }
  },

  zoomToFit(): void {
    if (!Timeline._tl) return;
    // Scope to the selected plant like rebuild() (R4) — otherwise the window spans
    // every plant's orders and zooms far wider than the visible rows. Also avoids the
    // Math.min/max(...spread) call-stack risk on a system-wide task array at scale.
    const tasks = (Store.selectedPlant ? Store.tasksForSelectedPlant() : [])
      .filter(t => t.start_date && t.end_date);
    if (!tasks.length) return;
    const minT = Math.min(...tasks.map(t => t.start_date!.getTime()));
    const maxT = Math.max(...tasks.map(t => t.end_date!.getTime()));
    const span = maxT - minT;
    const pad  = span * 0.05 || Config.MS_HOUR;
    Timeline._tl.setWindow(new Date(minT - pad), new Date(maxT + pad), { animation: { duration: 400 } });
  },

  gotoNow(): void {
    if (!Timeline._tl) return;
    const now = new Date();
    Timeline._tl.setWindow(
      new Date(now.getTime() - 4 * Config.MS_HOUR),
      new Date(now.getTime() + 4 * Config.MS_HOUR),
      { animation: { duration: 300 } }
    );
  },

  _colorIndex(line: string): number {
    if (Timeline._lineColorIdx[line] === undefined) {
      Timeline._lineColorIdx[line] = Timeline._nextColorIdx++ % Config.COLORS.length;
    }
    return Timeline._lineColorIdx[line];
  },

  // Single source of truth for "what lines are rendered, and in what
  // order." Mirrors rebuild()'s plant-scoping + numeric-aware sort +
  // GanttFilter line-filter exactly, so any code computing a row index for
  // a line always matches the actual rendered .vis-group DOM order.
  _visibleLines(): string[] {
    const plant = Store.selectedPlant;
    const tasks = Store.tasksForSelectedPlant().filter(t => t.start_date && t.end_date);
    const plantLines = new Set(Store.linesForSelectedPlant());
    const lineSet = new Set(tasks.map(t => t.PRODUCTION_LINE || 'Unknown'));
    if (plant) {
      for (const l of plantLines) lineSet.add(l);
    }
    const sortedLines = [...lineSet].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const lineFilterActive = !!NIMBUS!.GanttFilter
      && NIMBUS!.GanttFilter!._selectedLines
      && NIMBUS!.GanttFilter!._selectedLines!.size > 0;
    return lineFilterActive
      ? sortedLines.filter(l => NIMBUS!.GanttFilter!._selectedLines!.has(l))
      : sortedLines;
  },

  // Scroll the vis-timeline vertical scroller so the group row for `line`
  // is at the top of the visible viewport. Returns false (no-op, no crash)
  // if the line isn't currently rendered — e.g. hidden by an active
  // GanttFilter line filter, or the Gantt hasn't rendered any groups yet.
  scrollToLine(line: string): boolean {
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
  gotoLineDay(line: string, dateStr: string): void {
    NIMBUS!.App!.gotoGanttTimeline!();
    setTimeout(() => {
      if (Timeline._tl) {
        const dayStart    = new Date(dateStr + 'T00:00:00');
        const dayLevelEnd = new Date(dayStart.getTime() + 3 * 24 * Config.MS_HOUR);
        Timeline._syncViewWindow(dayStart.getTime(), dayLevelEnd.getTime());
        Timeline._tl.setWindow(dayStart, dayLevelEnd, { animation: { duration: 300 } });
        document.querySelectorAll<HTMLElement>('.gantt-toolbar .seg-btn[data-view]').forEach(b => {
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
  _canvas: null as HTMLCanvasElement | null,
  _ctx:    null as CanvasRenderingContext2D | null,
  _dragging: false,
  _dragStartX: 0,
  _dragStartRange: null as TimelineWindowMs | null,
  _unsubStore: null as (() => void) | null,

  init(): void {
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
      const totalMs = scheduleMax! - scheduleMin;
      const msPerPx = totalMs / pixelW!;
      const dx = e.clientX - canvas.getBoundingClientRect().left - TimelineNav._dragStartX;
      const shift = dx * msPerPx;
      const r = TimelineNav._dragStartRange!;
      Timeline._tl.setWindow(new Date(r.start + shift), new Date(r.end + shift));
    });
    window.addEventListener('mouseup', () => { TimelineNav._dragging = false; });

    // Click to center on click position
    canvas.addEventListener('click', e => {
      if (!Timeline._tl) return;
      const { scheduleMin, scheduleMax, pixelW } = TimelineNav._scheduleRange();
      if (!scheduleMin) return;
      const totalMs = scheduleMax! - scheduleMin;
      const clickMs = scheduleMin + (e.offsetX / pixelW!) * totalMs;
      const w = Timeline._tl.getWindow();
      const halfSpan = (w.end.getTime() - w.start.getTime()) / 2;
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

  _scheduleRange(): { scheduleMin?: number; scheduleMax?: number; pixelW?: number } {
    const el = TimelineNav._canvas;
    if (!el) return {};
    const rect = el.getBoundingClientRect();
    const pixelW = rect.width || el.offsetWidth || 800;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const scheduleMin = today.getTime();
    const scheduleMax = scheduleMin + 42 * Config.MS_DAY;
    return { scheduleMin, scheduleMax, pixelW };
  },

  render(): void {
    const canvas = TimelineNav._canvas;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.offsetWidth  || 800;
    const cssH = canvas.offsetHeight || 42;
    canvas.width  = cssW * dpr;
    canvas.height = cssH * dpr;
    const ctx = TimelineNav._ctx!;
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

    const toX = (ms: number): number => ((ms - scheduleMin) / totalMs) * cssW;

    const isDark = document.body.classList.contains('dark');
    // Command Band re-skin (Task 6): this minimap renders in the content area
    // (isDark tracks the user's own Dark Mode toggle, not the always-dark chrome
    // band), so backgrounds/dividers repoint toward the light/dark *content*
    // neutrals (--bg-subtle/--line/--fg), not --chrome-*. Dark-branch literals
    // that already matched a neutral (cool, non-amber) dark token are left as-is.
    const navBg        = isDark ? '#1c1d26' : '#f4f7fa';
    const navDivider   = isDark ? 'rgba(140,142,160,0.30)' : 'rgba(213,220,228,0.6)';
    const navLabelScrim = isDark ? 'rgba(25,26,34,0.85)'  : 'rgba(244,247,250,0.82)';
    const navLabelText = isDark ? 'rgba(237,235,227,0.88)' : 'rgba(28,43,58,0.88)';
    const navWindow    = isDark ? '#4d9fff' : '#ff0033';

    // Background
    ctx.fillStyle = navBg;
    ctx.fillRect(0, 0, cssW, cssH);

    // Draw per-day utilization heat bands
    const matrix = Utilization.computeMatrix(new Date(scheduleMin), Math.ceil(totalMs / Config.MS_DAY) + 2);
    const SEV_COLORS: Record<'ok' | 'warn' | 'err', string> = { ok: 'rgba(30,122,74,0.25)', warn: 'rgba(147,97,10,0.40)', err: 'rgba(176,42,32,0.55)' };
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
    const lineColors: Record<string, string> = {};
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
      const x1 = toX(t.start_date!.getTime());
      const x2 = toX(t.end_date!.getTime());
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
  _svg:      null as HTMLElement | null,
  _enabled:  false,
  _highlighted: null as string | null,   // id of chain to highlight
  _unsubStore: null as (() => void) | null,
  _unsubRange: null as (() => void) | null,

  init(): void {
    const svg = document.getElementById('dep-overlay');
    if (!svg) return;
    DependencyOverlay._svg = svg;

    const chk = document.getElementById('chk-show-deps') as HTMLInputElement | null;
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

  highlightChain(taskId: string | number): void {
    DependencyOverlay._highlighted = String(taskId);
    if (DependencyOverlay._enabled) DependencyOverlay.render();
  },

  render(): void {
    const svg = DependencyOverlay._svg;
    if (!svg || !Timeline._tl || !Timeline._items) return;
    svg.innerHTML = '';

    const deps = Store.dependencies;
    if (!deps || !Object.keys(deps).length) return;

    const tl  = Timeline._tl!;
    const dom = document.getElementById('vis-timeline');
    if (!dom) return;

    // Compute critical path lengths for each task (longest chain to it)
    const chainLen: Record<string, number> = {};
    const allIds = Store.tasksForSelectedPlant().map(t => String(t.id));
    const getLen = (id: string): number => {
      if (chainLen[id] !== undefined) return chainLen[id];
      const sources = deps[id] || [];
      if (!sources.length) { chainLen[id] = 0; return 0; }
      chainLen[id] = 1 + Math.max(...sources.map(getLen));
      return chainLen[id];
    };
    const maxLen = Math.max(0, ...allIds.map(id => { try { return getLen(id); } catch { return 0; } }));

    // Arrow head marker
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    (['ok', 'tight', 'gap', 'critical', 'highlight'] as const).forEach(cls => {
      // Command Band re-skin (Task 6): 'tight' (getting-tight warning) -> --warn,
      // 'highlight' (active/selected chain) -> --accent. ok/gap/critical verified
      // NOT amber (green/red already) — left unchanged per guardrails.
      const color = { ok: '#2f7a4d', tight: '#93610a', gap: '#b1362a', critical: '#b1362a', highlight: '#1f5fbf' }[cls];
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
    const lineToY: Record<string, number> = {};
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
    const timeToX = (ms: number): number => foreOffX + ((ms - sw.start.getTime()) / totalMs) * foreRect.width;

    for (const [targetId, sourceIds] of Object.entries(deps)) {
      const tTask = Store.tasks[targetId];
      if (!tTask || !tTask.start_date || !tTask.end_date) continue;

      for (const sourceId of sourceIds) {
        const sTask = Store.tasks[sourceId];
        if (!sTask || !sTask.start_date || !sTask.end_date) continue;

        let sx: number, sy: number, tx: number, ty: number;
        try {
          sx = timeToX(sTask.end_date.getTime());
          tx = timeToX(tTask.start_date.getTime());
          sy = lineToY[sTask.PRODUCTION_LINE || 'Unknown'] ?? (foreOffY + foreRect.height / 2);
          ty = lineToY[tTask.PRODUCTION_LINE || 'Unknown'] ?? (foreOffY + foreRect.height / 2);

          // Don't draw fully off-screen arrows
          if (tx < -50 || sx > foreOffX + foreRect.width + 50) continue;
        } catch { continue; }

        const gapMs = tTask.start_date!.getTime() - sTask.end_date!.getTime();
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

// -- Local type declarations (CQ-1 Phase 6 Task 3 conversion; scoped to
//    Table/Inspector/ContextMenu — later tasks add their own module-scoped
//    types further down this same file as they convert
//    Hierarchy/GanttFilter/Dashboard/etc.) -----------------------------------

/** Table._chipFilters's status radio value — 'late' reads Util.latenessHours,
 *  'conflict'/'atrisk' read Store.alertsByTask() severities, 'fixed' reads
 *  Store.isFixed. Also the shape Table._applyChipFilter's `patch.status` and
 *  the Dashboard KPI-tile-click callers (still stopgap-typed, reached only via
 *  the loose NIMBUS.Table ambient shim) pass in. */
type TableStatusFilter = 'late' | 'conflict' | 'atrisk' | 'fixed';

/** Table._chipFilters — the Orders-tab filter-chip bar's live selection state. */
interface TableChipFilters {
  lines: Set<string>;
  colors: Set<string>;
  status: TableStatusFilter | null;
  dateKey: string | null;
  poMat: Set<string>;
}

/** Table._currentLayout()/_applySavedLayout()/_setLayoutEnabled() — the saved
 *  grid-layout contract shape (Store.pref('gridLayout'), user tier). sortModel
 *  is derived from columnState and stored only to honor the contract shape —
 *  AG Grid v31 folds sort into columnState, so applyColumnState() alone
 *  restores sorting. */
interface TableGridLayout {
  columnState: NimbusVendor.AgGridColumnState[] | null;
  sortModel: Array<{ colId: string; sort: 'asc' | 'desc' | null }> | null;
  filterModel: Record<string, unknown> | null;
}

/** Table's Ctrl+Y range-select mode — a {row, column} anchor/active corner pair. */
interface TableRangeCell {
  rowIndex: number | null;
  colId: string;
}

/** Minimal AG Grid Column instance surface Table/ContextMenu code calls
 *  (getAllDisplayedColumns()'s elements, and the column param threaded through
 *  onCellMouseDown/onCellMouseOver/onCellKeyDown). */
interface AgGridColumn {
  getColId(): string;
  getColDef(): TableColDef;
}

/** Minimal AG Grid RowNode surface Table's range-copy/cell-mouse/cell-key-down
 *  code reads. `setSelected` added by CQ-1 Phase 6 Task 6 (Interaction.
 *  _wireTableSync's Selection→Table mirroring, via Table._api.forEachNode) —
 *  a real AG Grid RowNode method, not a Table-specific invention. */
interface AgGridRowNode {
  data: NimbusTask;
  rowIndex: number | null;
  setSelected(selected: boolean, clearSelection?: boolean): void;
}

/** Table's own column-def shape — a precise subset of AG Grid's ColDef, scoped
 *  to the fields Table's columnDefs array actually sets. NimbusVendor.
 *  AgGridOptions itself stays structurally loose ([key: string]: unknown) per
 *  vendor.d.ts's own comment — this is Table's own precise shape assigned INTO
 *  that loose contract, not a tightening of the vendor ambient type. */
interface TableColDef {
  headerName?: string;
  field?: string;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  flex?: number;
  hide?: boolean;
  pinned?: 'left' | 'right';
  lockPosition?: boolean;
  suppressHeaderMenuButton?: boolean;
  sortable?: boolean;
  filter?: boolean;
  resizable?: boolean;
  editable?: boolean;
  checkboxSelection?: boolean;
  headerCheckboxSelection?: boolean;
  tooltipField?: string;
  headerTooltip?: string;
  cellClass?: (p: { data: NimbusTask | null }) => string;
  cellRenderer?: (p: { value: unknown }) => string;
  cellEditor?: unknown;
  cellEditorPopup?: boolean;
  cellEditorParams?: () => Record<string, unknown>;
  valueGetter?: (p: { data: NimbusTask }) => unknown;
  valueFormatter?: (p: TableValueFormatterParams) => string;
  valueParser?: (p: { newValue: string }) => unknown;
}

/** Shared by AG Grid's own valueFormatter invocation ({value}, from the column
 *  render pipeline) and Table's manual re-invocations from the Ctrl+C single-
 *  cell/range-copy paths (the richer object built by hand at those call sites). */
interface TableValueFormatterParams {
  value: unknown;
  data?: NimbusTask;
  node?: AgGridRowNode;
  column?: AgGridColumn;
  api?: NimbusVendor.AgGridApi;
  colDef?: TableColDef;
}

/** Table._onCellChanged — AG Grid's onCellValueChanged event, scoped to the
 *  fields that handler reads. */
interface TableCellValueChangedEvent {
  colDef: TableColDef;
  data: NimbusTask;
  newValue: unknown;
  node: AgGridRowNode;
}

/** Shared by Table's onCellMouseDown/onCellMouseOver grid options. */
interface TableCellMouseEvent {
  event: MouseEvent;
  node: AgGridRowNode;
  column: AgGridColumn;
}

/** Table's onCellKeyDown grid option — Ctrl+Y range toggle / Ctrl+C copy / Esc. */
interface TableCellKeyDownEvent {
  event: KeyboardEvent;
  api: NimbusVendor.AgGridApi;
  column: AgGridColumn;
  node: AgGridRowNode;
  data: NimbusTask;
}

/** Table.init()'s onGridReady grid option. `columnApi` is AG Grid's pre-v31
 *  column-API object — merged into the main Grid API in v31, so this field is
 *  dead (assigned, never read: Table._colApi) but kept for parity with the
 *  pre-existing runtime behavior (Global Constraints: no logic changes). */
interface TableGridReadyEvent {
  api: NimbusVendor.AgGridApi;
  columnApi?: unknown;
}

/** Table._SearchableLineEditor's AG Grid CellEditorParams — the PRODUCTION_LINE
 *  column's cellEditorParams() factory returns { values: () => string[] } (see
 *  columnDefs above), and AG Grid merges in `value`/`api` itself at cell-edit-
 *  start time. */
interface TableLineEditorParams {
  value: string | null;
  values: string[] | (() => string[]);
  api: NimbusVendor.AgGridApi;
}

/* =============================================================================
   TABLE — AG Grid integration with rich inline editing, filtering, and full
   two-way sync. Uses the transaction API for fast incremental updates.
   ========================================================================== */
export const Table = {
  _api:    null as NimbusVendor.AgGridApi | null,
  _colApi: null as unknown,
  _selectedId: null as string | null,  // for the override modal
  _noteOutsideHandler: null as ((ev: MouseEvent) => void) | null,
  _noteKeyHandler: null as ((ev: KeyboardEvent) => void) | null,
  _chipFilters: { lines: new Set<string>(), colors: new Set<string>(), status: null, dateKey: null, poMat: new Set<string>() } as TableChipFilters,
  _lineSearch:       '',
  _colorSearch:      '',
  _rangeMode:        false,
  _rangeAnchor:      null as TableRangeCell | null,
  _rangeActive:      null as TableRangeCell | null,
  _rangeDragOn:      false,
  _rangeHighlighted: new Set<string>(),
  _applyingLayout:   false,   // true while restoring saved layout — suppresses capture echo
  _captureTimer:     null as ReturnType<typeof setTimeout> | null,
  _fpOvrStart:       null as NimbusVendor.FlatpickrInstance | null,  // Flatpickr instance for the override modal's start-date input
  _suppressSelectionEcho: false,

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
  _layoutEnabled(): boolean { try { return Store.pref('gridLayout') != null; } catch { return false; } },

  _currentLayout(): TableGridLayout {
    if (!Table._api) return { columnState: null, sortModel: null, filterModel: null };
    let columnState: NimbusVendor.AgGridColumnState[] | null = null;
    let filterModel: Record<string, unknown> | null = null;
    let sortModel: Array<{ colId: string; sort: 'asc' | 'desc' | null }> | null = null;
    try { columnState = Table._api.getColumnState(); } catch {}
    try { filterModel = Table._api.getFilterModel(); } catch {}
    if (columnState) {
      sortModel = columnState
        .filter(c => c.sort)
        .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
        .map(c => ({ colId: c.colId, sort: c.sort ?? null }));
    }
    return { columnState, sortModel, filterModel };
  },

  // Debounced capture — guarded so programmatic restores don't echo back, and
  // a no-op while the feature is disabled.
  _captureLayout(): void {
    if (Table._applyingLayout || !Table._layoutEnabled()) return;
    clearTimeout(Table._captureTimer ?? undefined);
    Table._captureTimer = setTimeout(() => {
      if (!Table._layoutEnabled()) return;
      try { Session.setPref('gridLayout', Table._currentLayout()); } catch {}
    }, 400);
  },

  _applySavedLayout(): void {
    const layout = (() => { try { return Store.pref('gridLayout') as TableGridLayout | null; } catch { return null; } })();
    if (!layout || !Table._api) return;
    Table._applyingLayout = true;
    try {
      if (Array.isArray(layout.columnState)) {
        Table._api.applyColumnState({ state: layout.columnState, applyOrder: true });
      }
      if (layout.filterModel && typeof layout.filterModel === 'object') {
        Table._api.setFilterModel(layout.filterModel);
      }
    } catch (e: unknown) {
      ErrorLog.warn('table', `Apply saved grid layout failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Release the guard on the next macrotask so any events the restore fired
    // (sync or queued) are all ignored, but genuine later user edits are not.
    setTimeout(() => { Table._applyingLayout = false; }, 0);
  },

  // Turn the feature on (capture current live layout) or off (null it + reset
  // the grid to defaults). Called by the User Settings toggle.
  _setLayoutEnabled(on: boolean): void {
    if (on) {
      try { Session.setPref('gridLayout', Table._currentLayout()); } catch {}
    } else {
      try { Session.setPref('gridLayout', null); } catch {}
      Table._resetGridState();
    }
  },

  // Reset the live grid to its default column arrangement + clear column filters.
  _resetGridState(): void {
    if (!Table._api) return;
    Table._applyingLayout = true;
    try {
      Table._api.resetColumnState();
      Table._api.setFilterModel(null);
    } catch (e: unknown) {
      ErrorLog.warn('table', `Reset grid layout failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    setTimeout(() => { Table._applyingLayout = false; }, 0);
  },

  // "Reset grid layout" action: reset the live grid, then — if the feature is
  // on — re-capture the now-default state so it persists (staying non-null keeps
  // the toggle on). Returns true if the grid was available to reset.
  _resetGridLayout(): boolean {
    if (!Table._api) return false;
    Table._resetGridState();
    if (Table._layoutEnabled()) {
      try { Session.setPref('gridLayout', Table._currentLayout()); } catch {}
    }
    return true;
  },

  init(): void {
    const el = document.getElementById('ag-grid');
    if (!el || typeof agGrid === 'undefined') return;
    const gridOptions = {
      rowData: Store.tasksForSelectedPlant(),
      getRowId: (p: { data: NimbusTask }) => String(p.data.id),
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
        cellClass: (p: { data: NimbusTask | null }) => Table._rowClass(p.data)
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
          cellRenderer: (p: { value: unknown }) => p.value ? '<span title="Fixed" style="color:var(--accent);font-size:13px;">🔒</span>' : '',
          headerTooltip: Util.t('tip.fixed_column')
        },
        { headerName: Util.t('col.id'),   field: 'id',   width: 80, minWidth: 80, flex: 0, hide: true,
          editable: false, cellClass: 'cell-num' },
        { headerName: Util.t('col.order'), field: 'PRODUCTION_ORDER', width: 160, minWidth: 160, flex: 0,
          pinned: 'left', editable: false,
          valueGetter: (p: { data: NimbusTask }) => p.data.PRODUCTION_ORDER || p.data.ORDER || '' },
        { headerName: Util.t('col.material'), field: 'MATERIAL_DESCRIPTION', minWidth: 180, editable: false,
          tooltipField: 'MATERIAL_DESCRIPTION' },
        { headerName: Util.t('col.qty'), field: 'ORDER_QUANTITY_(GMEIN)', width: 100, flex: 0,
          editable: false, cellClass: 'cell-num',
          valueParser: (p: { newValue: string }) => parseFloat(p.newValue) || 0 },
        { headerName: Util.t('col.line'), field: 'PRODUCTION_LINE', minWidth: 130, editable: true,
          cellEditor: Table._SearchableLineEditor,
          cellEditorPopup: true,
          cellEditorParams: () => ({ values: Table._getLineOptions() }),
          cellRenderer: (p: { value: unknown }) => {
            if (!p.value) return '';
            const ci = Timeline._colorIndex(String(p.value));
            const color = Config.COLORS[ci % Config.COLORS.length];
            return `<span class="cell-line-tag"><span class="dot" style="background:${color}"></span>${p.value}</span>`;
          }
        },
        { headerName: Util.t('col.color'), field: 'COLOR', width: 110, flex: 0, editable: false },
        { headerName: Util.t('col.form'),  field: 'FORM_SIZE', width: 90, flex: 0, editable: false },
        { headerName: Util.t('col.run_h'), field: 'RUN_TIME', width: 90, flex: 0, editable: true,
          cellClass: 'cell-num',
          valueParser: (p: { newValue: string }) => parseFloat(p.newValue) || 0 },
        { headerName: Util.t('col.orig_start'), field: 'original_start_date', minWidth: 160,
          editable: false,
          // Display-only derived value (due date minus RUN_TIME — see
          // Util.impliedOriginalStart) instead of the raw midnight SAP
          // date. `field` is kept alongside `valueGetter` (same precedent
          // as the PRODUCTION_ORDER column above) purely so AG Grid's
          // date-type inference off the raw field still drives this
          // column's sort + agDateColumnFilter; dropping `field` entirely
          // would degrade the filter to generic/text.
          valueGetter: (p: { data: NimbusTask }) => Util.impliedOriginalStart(p.data),
          valueFormatter: (p: TableValueFormatterParams) => Util.fmtDTReadable(p.value),
          cellClass: 'cell-date cell-date-original' },
        { headerName: Util.t('col.orig_end'), field: 'original_end_date', minWidth: 160,
          editable: false,
          valueFormatter: (p: TableValueFormatterParams) => Util.fmtDTReadable(p.value),
          cellClass: 'cell-date cell-date-original' },
        { headerName: Util.t('col.updated_start'), field: 'start_date', minWidth: 160,
          editable: true,
          valueFormatter: (p: TableValueFormatterParams) => Util.fmtDTReadable(p.value),
          cellEditor: Table._DateTimeEditor,
          cellClass: 'cell-date' },
        { headerName: Util.t('col.updated_end'), field: 'end_date', minWidth: 160,
          editable: false,
          valueFormatter: (p: TableValueFormatterParams) => Util.fmtDTReadable(p.value),
          cellClass: 'cell-date' },
        { headerName: Util.t('col.alerts'), field: 'id', width: 90, flex: 0, sortable: false, filter: false, editable: false,
          cellRenderer: (p: { value: unknown }) => {
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
          cellRenderer: (p: { value: unknown }) => {
            const note = p.value != null ? String(p.value).trim() : '';
            if (!note) return `<span class="nb-note-empty">✎ <em>${Util.t('ui.add_note')}</em></span>`;
            const preview = note.length > 40 ? note.slice(0, 37) + '…' : note;
            const esc = note.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
            return `<span class="nb-note-preview" title="${esc}">✎ ${preview}</span>`;
          }
        }
      ] as TableColDef[],
      onCellValueChanged: Table._onCellChanged,
      onSelectionChanged: Table._onSelectionChanged,
      isExternalFilterPresent: () => Table._hasChipFilters(),
      doesExternalFilterPass: (node: { data: NimbusTask }) => Table._taskPassesChipFilters(node.data),
      noRowsOverlayComponent: Table._NoRowsOverlay,
      onCellMouseDown: (p: TableCellMouseEvent) => {
        if (!Table._rangeMode) return;
        p.event.preventDefault();
        Table._rangeAnchor  = { rowIndex: p.node.rowIndex, colId: p.column.getColId() };
        Table._rangeActive  = { rowIndex: p.node.rowIndex, colId: p.column.getColId() };
        Table._rangeDragOn  = true;
        Table._applyRangeHighlight();
        document.addEventListener('mouseup', () => { Table._rangeDragOn = false; }, { once: true });
      },
      onCellMouseOver: (p: TableCellMouseEvent) => {
        if (!Table._rangeMode || !Table._rangeDragOn) return;
        Table._rangeActive = { rowIndex: p.node.rowIndex, colId: p.column.getColId() };
        Table._applyRangeHighlight();
      },
      onCellKeyDown: (p: TableCellKeyDownEvent) => {
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
            let text: unknown = raw;
            if (colDef.valueFormatter) {
              const fmt = colDef.valueFormatter({ value: raw, data: p.data, node: p.node, column: p.column, api: p.api, colDef });
              if (fmt != null) text = fmt;
            }
            navigator.clipboard?.writeText(text == null ? '' : String(text)).catch(() => {});
            const cell = (p.event.target as Element | null)?.closest('.ag-cell');
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
      onGridReady: (params: TableGridReadyEvent) => {
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
    document.addEventListener('mousedown', (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest || !target.closest('#table-filterbar')) {
        closeAllChipDropdowns();
      }
    }, true);
    // Closing on Escape is also expected for menu-like UI.
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeAllChipDropdowns();
    });
  },

  // ── Filter chip bar ──────────────────────────────────────────────────
  _initChipFilters(): void {
    Table._refreshChipDropdowns();
    Table._refreshChipButtons();

    const lineIn  = document.getElementById('tbl-flt-line-paste-input') as HTMLInputElement | null;
    const colorIn = document.getElementById('tbl-flt-color-paste-input') as HTMLInputElement | null;
    if (lineIn) {
      Util.wirePasteToCheckboxes(lineIn,
        () => Array.from(document.getElementById('tbl-flt-line-checklist')?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') ?? []));
    }
    if (colorIn) {
      Util.wirePasteToCheckboxes(colorIn,
        () => Array.from(document.getElementById('tbl-flt-color-checklist')?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') ?? []));
    }
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

  _hasChipFilters(): boolean {
    const f = Table._chipFilters;
    return f.lines.size > 0 || f.colors.size > 0 || f.status !== null || f.dateKey !== null || f.poMat.size > 0;
  },

  _taskPassesChipFilters(data: NimbusTask | null): boolean {
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

  _toggleChipDropdown(kind: string): void {
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

  _refreshChipDropdowns(): void {
    Table._buildLineChipDropdown();
    Table._buildColorChipDropdown();
    Table._buildStatusChipDropdown();
    Table._buildDateChipDropdown();
  },

  // Scale mandate (CLAUDE.md Production Scale Roadmap): every plant/line picker
  // must stay filterable — this is the Orders tab's share of that, matching the
  // Gantt tab's identical filter bar.
  _filterLineSearch(q: string): void {
    Table._lineSearch = q || '';
    Table._buildLineChipDropdown();
  },
  _filterColorSearch(q: string): void {
    Table._colorSearch = q || '';
    Table._buildColorChipDropdown();
  },

  // Clears the line/color live-search text and its <input> values without
  // touching selections — shared by the plant-change handler and clear filters.
  _resetChipSearch(): void {
    Table._lineSearch = Table._colorSearch = '';
    const lineIn  = document.getElementById('tbl-flt-line-paste-input') as HTMLInputElement | null;
    const colorIn = document.getElementById('tbl-flt-color-paste-input') as HTMLInputElement | null;
    if (lineIn)  lineIn.value  = '';
    if (colorIn) colorIn.value = '';
  },

  _buildLineChipDropdown(): void {
    const drop = document.getElementById('tbl-flt-line-checklist');
    if (!drop) return;
    const lineSet = new Set<string>();
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
    const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c: string) => (({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]));
    drop.innerHTML = visible.length
      ? visible.map(l => `<label><input type="checkbox" value="${esc(l)}"${Table._chipFilters.lines.has(l) ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('line', this)"> ${esc(l)}</label>`).join('')
      : `<div style="padding:8px 14px;font-size:12px;color:var(--fg-mute)">${sorted.length ? Util.t('ui.no_matches') : 'No lines'}</div>`;
  },

  _buildColorChipDropdown(): void {
    const drop = document.getElementById('tbl-flt-color-checklist');
    if (!drop) return;
    const colorSet = new Set<string>();
    for (const t of (Store.selectedPlant ? Store.tasksForSelectedPlant() : [])) {
      if (t.COLOR) colorSet.add(String(t.COLOR).toUpperCase());
    }
    const sorted = [...colorSet].sort();
    for (const c of [...Table._chipFilters.colors]) {
      if (!colorSet.has(c)) Table._chipFilters.colors.delete(c);
    }
    const q = Table._colorSearch.toLowerCase().trim();
    const visible = q ? sorted.filter(c => c.toLowerCase().includes(q)) : sorted;
    const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c: string) => (({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]));
    drop.innerHTML = visible.length
      ? visible.map(c => `<label><input type="checkbox" value="${esc(c)}"${Table._chipFilters.colors.has(c) ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('color', this)"> ${esc(c)}</label>`).join('')
      : `<div style="padding:8px 14px;font-size:12px;color:var(--fg-mute)">${sorted.length ? Util.t('ui.no_matches') : 'No colors'}</div>`;
  },

  _buildStatusChipDropdown(): void {
    const drop = document.getElementById('tbl-flt-status-dropdown');
    if (!drop) return;
    const cur = Table._chipFilters.status;
    const items: Array<{ v: TableStatusFilter; k: string; d: string }> = [
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

  _buildDateChipDropdown(): void {
    const drop = document.getElementById('tbl-flt-date-dropdown');
    if (!drop) return;
    const today = Util.startOfDay(new Date())!;
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

  _onChipChange(kind: string, input: HTMLInputElement): void {
    const f = Table._chipFilters;
    if (kind === 'line') {
      if (input.checked) f.lines.add(input.value);
      else               f.lines.delete(input.value);
    } else if (kind === 'color') {
      if (input.checked) f.colors.add(input.value.toUpperCase());
      else               f.colors.delete(input.value.toUpperCase());
    } else if (kind === 'status') {
      f.status = (input.value || null) as TableStatusFilter | null;
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

  _clearChipFilters(): void {
    Table._chipFilters.lines.clear();
    Table._chipFilters.colors.clear();
    Table._chipFilters.status = null;
    Table._chipFilters.dateKey = null;
    Table._chipFilters.poMat.clear();
    const ta = document.getElementById('tbl-flt-pomat-textarea') as HTMLTextAreaElement | null;
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

  _onPoMatApply(): void {
    const ta = document.getElementById('tbl-flt-pomat-textarea') as HTMLTextAreaElement | null;
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

  _onPoMatPaste(e: ClipboardEvent): void {
    const text = (e.clipboardData || (window as unknown as { clipboardData?: DataTransfer }).clipboardData)?.getData('text/plain');
    if (!text || !text.trim()) return;
    const known = new Set<string>();
    (Store.selectedPlant ? Store.tasksForSelectedPlant() : []).forEach(task => {
      const po = Util.norm(task.ORDER ?? task.PRODUCTION_ORDER); if (po) known.add(po);
      const mat = Util.norm(task.MATERIAL_NUMBER); if (mat) known.add(mat);
    });
    const { matched, total } = Util.countPasteMatches(text, known);
    if (total) Toast.show(Util.t('toast.paste_pomat_match', { matched, total }), matched > 0 ? 'success' : 'warn');
  },

  _clearPoMat(): void {
    Table._chipFilters.poMat.clear();
    const ta = document.getElementById('tbl-flt-pomat-textarea') as HTMLTextAreaElement | null;
    if (ta) ta.value = '';
    const cnt = document.getElementById('tbl-flt-pomat-count');
    if (cnt) cnt.textContent = '';
    Table._refreshChipButtons();
    if (Table._api) Table._api.onFilterChanged();
  },

  /** Driven from KPI tile clicks on the dashboard. Sets state, refreshes UI, re-filters grid. */
  _applyChipFilter(patch: { status?: TableStatusFilter | null; dateKey?: string | null; lines?: string[]; colors?: string[] }): void {
    const f = Table._chipFilters;
    if ('status' in patch)  f.status  = patch.status  || null;
    if ('dateKey' in patch) f.dateKey = patch.dateKey || null;
    if (patch.lines)  { f.lines.clear();  for (const l of patch.lines)  f.lines.add(l); }
    if (patch.colors) { f.colors.clear(); for (const c of patch.colors) f.colors.add(String(c).toUpperCase()); }
    Table._refreshChipDropdowns();
    Table._refreshChipButtons();
    if (Table._api) Table._api.onFilterChanged();
  },

  _refreshChipButtons(): void {
    const plant = !!Store.selectedPlant;
    const f = Table._chipFilters;

    const set = (btnId: string, lblId: string, txt: string, active: boolean) => {
      const b = document.getElementById(btnId) as HTMLButtonElement | null;
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

    const STATUS_LABEL: Record<TableStatusFilter, string> = { late: Util.t('ui.late'), conflict: Util.t('ui.conflicting'), atrisk: Util.t('ui.at_risk'), fixed: Util.t('ui.fixed') };
    set('tbl-flt-status-btn', 'tbl-flt-status-label',
      f.status ? STATUS_LABEL[f.status] || f.status : Util.t('ui.all_statuses'),
      !!f.status);

    let dateLabel = Util.t('ui.any_date');
    if (f.dateKey) {
      const todayKey = Util.dayKey(Util.startOfDay(new Date())!);
      const tomorrowKey = Util.dayKey(new Date(Util.startOfDay(new Date())!.getTime() + Config.MS_DAY));
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

  _onStore(evt: StoreEvent): void {
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
        const ta = document.getElementById('tbl-flt-pomat-textarea') as HTMLTextAreaElement | null;
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
      const ids = (evt.ids as Array<string | number> | undefined) ?? [];
      const updated = ids
        .map(id => Store.tasks[id])
        .filter((t): t is NimbusTask => !!t && Store.getPlantForLine(t.PRODUCTION_LINE) === Store.selectedPlant);
      Table._api.applyTransaction({ update: updated });
      if (Table._hasChipFilters()) Table._api.onFilterChanged();
    } else if (evt.type === 'task:update') {
      const t = Store.tasks[String(evt.id)];
      if (t && Store.selectedPlant
          && Store.getPlantForLine(t.PRODUCTION_LINE) === Store.selectedPlant) {
        Table._api.applyTransaction({ update: [t] });
      }
      if (Table._hasChipFilters()) Table._api.onFilterChanged();
    } else if (evt.type === 'fixed:change') {
      const ids = (evt.ids as Array<string | number> | undefined) ?? [];
      const updated = ids
        .map(id => Store.tasks[id])
        .filter((t): t is NimbusTask => !!t && Store.getPlantForLine(t.PRODUCTION_LINE) === Store.selectedPlant);
      Table._api.applyTransaction({ update: updated });
      if (Table._chipFilters.status === 'fixed') Table._api.onFilterChanged();
    } else if (evt.type === 'alerts:change') {
      // Incremental update: only refresh rows for task IDs that changed alert membership.
      // Fall back to full refresh if changedIds is absent (unscoped recompute).
      const changedIds = evt.changedIds as Array<string | number> | undefined;
      if (changedIds && changedIds.length) {
        const rowNodes = [];
        for (const taskId of changedIds) {
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

  _renderEmptyState(): void {
    const grid = document.getElementById('ag-grid') as HTMLElement | null;
    let overlay = document.getElementById('table-empty-overlay');
    if (!Store.selectedPlant) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'table-empty-overlay';
        overlay.className = 'table-empty-overlay';
        grid?.parentElement?.appendChild(overlay);
      }
      // NIMBUS/EmptyState is a forward reference (EmptyState lives in
      // application-shell.mjs, loaded after this module) — safe once boot
      // has finished, but this can also be reached synchronously from
      // Table.init()'s own AG Grid construction before that. Skip the
      // render rather than throw; the next tasks:bulk/plant:selected event
      // calls this again once NIMBUS/EmptyState are real.
      if (typeof NIMBUS !== 'undefined' && NIMBUS.EmptyState) {
        NIMBUS.EmptyState.render?.(overlay, {
          title: Util.t('empty.no_plant_selected'),
          msg:   Util.t('empty.no_plant_table')
        });
      }
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
    _eGui!: HTMLDivElement;
    init(): void {
      const filtered = Table._hasChipFilters()
        || (Table._api && Table._api.isAnyFilterPresent())
        || !!(document.getElementById('quick-filter') as HTMLInputElement | null)?.value;
      this._eGui = document.createElement('div');
      // AG Grid calls init() synchronously as part of agGrid.createGrid()
      // (Table.init()'s initial rowData is always [] at boot, before the
      // async task fetch resolves) — at that exact moment NIMBUS/EmptyState
      // (a forward reference; EmptyState lives in application-shell.mjs,
      // loaded after this module) doesn't exist yet. Skip the render rather
      // than throw; AG Grid re-invokes init() itself once row count changes.
      if (typeof NIMBUS !== 'undefined' && NIMBUS.EmptyState) {
        NIMBUS.EmptyState.render?.(this._eGui, filtered
          ? { title: Util.t('empty.no_orders_filtered_title'), msg: Util.t('empty.no_orders_filtered_msg'), icon: '⌕' }
          : { title: Util.t('empty.no_orders_plant_title'),    msg: Util.t('empty.no_orders_plant_msg') });
      }
      if (filtered) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-ghost sm';
        btn.style.marginTop = '6px';
        btn.textContent = Util.t('btn.clear_filters');
        btn.onclick = () => {
          Table._clearChipFilters();
          const qf = document.getElementById('quick-filter') as HTMLInputElement | null;
          if (qf) { qf.value = ''; Table._api!.setGridOption('quickFilterText', ''); }
        };
        this._eGui.querySelector('.nimbus-empty-state')?.appendChild(btn);
      }
    }
    getGui(): HTMLDivElement { return this._eGui; }
  },

  /** Called when a grid cell is edited. Push the change through the store. */
  _onCellChanged(p: TableCellValueChangedEvent): void {
    const field = p.colDef.field;
    const id = String(p.data.id);
    const changes: Partial<NimbusTask> = {};

    if (field === 'start_date') {
      const d = Util.parseDate(p.newValue);
      if (!d) { Toast.show(Util.t('toast.invalid_date'), 'error'); Table._api!.refreshCells({ rowNodes: [p.node] }); return; }
      changes.start_date = Util.snap(d);
      // recompute end based on RUN_TIME
      const dur = Util.runHours(p.data) * Config.MS_HOUR;
      if (dur > 0) changes.end_date = new Date(changes.start_date.getTime() + dur);
    } else if (field === 'RUN_TIME') {
      const h = parseFloat(String(p.newValue)) || 0;
      changes.RUN_TIME = h;
      if (p.data.start_date) {
        changes.end_date = new Date(p.data.start_date.getTime() + h * Config.MS_HOUR);
      }
    } else if (field === 'ORDER_QUANTITY_(GMEIN)') {
      changes[field] = parseFloat(String(p.newValue)) || 0;
    } else if (field === 'notes') {
      const trimmed = String(p.newValue ?? '').trim();
      Store.updateTask(id, { notes: trimmed }, 'table');
      Table._api!.applyTransaction({ update: [Store.tasks[id]] });
      Inspector._persistNote(id, trimmed);
      Toast.show(Util.t('toast.row_updated'), 'success', 1200);
      return;
    } else {
      changes[field!] = p.newValue;
    }

    Store.updateTask(id, changes, 'table');
    Table._api!.applyTransaction({ update: [Store.tasks[id]] });
    Engine.autoReflow(id);
    Alerts.scheduleRecompute();
    Toast.show(Util.t('toast.row_updated'), 'success', 1200);
  },

  _onSelectionChanged(): void {
    if (!Table._api) return;
    const sel = Table._api.getSelectedRows() as NimbusTask[];
    Table._selectedId = sel.length === 1 ? String(sel[0].id) : null;
  },

  _onRowClicked(event: { data?: NimbusTask }): void {
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
  _rowClass(data: NimbusTask | null): string {
    if (!data) return '';
    const ids = Store.alertsByTask().get(String(data.id)) || [];
    if (ids.some(a => a.sev === 'err')) return 'row-alert';
    if (ids.some(a => a.sev === 'warn')) return 'row-warn';
    return '';
  },

  _getLineOptions(): string[] {
    if (Store.selectedPlant) return Store.linesForSelectedPlant();
    // No plant selected — fall back to the unscoped view rather than showing nothing.
    const set = new Set(Store.tasksArr.map(t => t.PRODUCTION_LINE || 'Unknown'));
    Object.keys(Store.calendars).forEach(l => set.add(l));
    return [...set].sort();
  },

  _wireQuickFilter(): void {
    const inp = document.getElementById('quick-filter') as HTMLInputElement | null;
    if (!inp || !Table._api) return;
    inp.addEventListener('input', () => {
      Table._api!.setGridOption('quickFilterText', inp.value);
    });
  },

  /* ---- public actions: fixing, override modal, export ------------------ */
  fixSelected(fixed: boolean): void {
    if (!Table._api) return;
    const sel = Table._api.getSelectedRows() as NimbusTask[];
    if (!sel.length) { Toast.show(Util.t('toast.select_rows_first'), 'warn'); return; }
    const ids = sel.map(r => String(r.id));
    Store.setFixed(ids, fixed, 'table');
    Alerts.scheduleRecompute();
  },

  openOverrideModal(): void {
    const sel = (Table._api ? Table._api.getSelectedRows() : []) as NimbusTask[];
    if (sel.length !== 1) { Toast.show(Util.t('toast.select_one_row'), 'warn'); return; }
    Table._openOverrideModalForId(String(sel[0].id));
  },

  _openOverrideModalForId(id: string): void {
    const t = Store.tasks[id];
    if (!t) return;
    const orderEl = document.getElementById('ovr-order');
    const lineEl = document.getElementById('ovr-line') as HTMLSelectElement | null;
    const fixEl = document.getElementById('ovr-fix') as HTMLInputElement | null;
    if (!orderEl || !lineEl || !fixEl) { ErrorLog.error('ui', 'required DOM elements missing for override modal'); return; }

    Table._selectedId = id;
    orderEl.textContent = `${t.text || t.ORDER || t.id}  ·  Line: ${t.PRODUCTION_LINE || '—'}`;
    if (!Table._fpOvrStart) {
      Table._fpOvrStart = Util.fpDatetime('#ovr-start');
    }
    Table._fpOvrStart.setDate(t.start_date!, false);
    const lines = Table._getLineOptions();
    lineEl.innerHTML = lines.map(l => `<option value="${l}" ${l === t.PRODUCTION_LINE ? 'selected' : ''}>${l}</option>`).join('');
    fixEl.checked = !!t.fixed;
    Modal.open('modal-override');
  },

  applyOverride(): void {
    const id = Table._selectedId;
    if (!id) return;
    const t = Store.tasks[id];
    if (!t) return;
    const startEl = document.getElementById('ovr-start') as HTMLInputElement | null;
    const lineEl = document.getElementById('ovr-line') as HTMLSelectElement | null;
    const fixEl = document.getElementById('ovr-fix') as HTMLInputElement | null;
    if (!startEl || !lineEl || !fixEl) { ErrorLog.error('ui', 'required DOM elements missing for override modal'); return; }

    const newStart = Util.parseDate(startEl.value);
    const newLine  = lineEl.value;
    const alsoFix  = fixEl.checked;
    if (!newStart) { Toast.show(Util.t('toast.invalid_date'), 'error'); return; }

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
    Toast.show(alsoFix ? Util.t('toast.order_overridden_fixed') : Util.t('toast.order_overridden'), 'success');
  },

  exportCsv(): void {
    if (!Table._api) return;
    Table._api.exportDataAsCsv({ fileName: 'nimbus-orders.csv' });
  },

  _toggleRangeMode(): void {
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

  _applyRangeHighlight(): void {
    if (!Table._rangeAnchor || !Table._rangeActive || !Table._api) return;
    const gridEl = document.getElementById('ag-grid');
    if (!gridEl) return;
    const cols   = Table._api.getAllDisplayedColumns() as AgGridColumn[];
    const colIds = cols.map(c => c.getColId());
    const aIdx   = colIds.indexOf(Table._rangeAnchor.colId);
    const bIdx   = colIds.indexOf(Table._rangeActive.colId);
    if (aIdx === -1 || bIdx === -1) return;
    const minCol = Math.min(aIdx, bIdx);
    const maxCol = Math.max(aIdx, bIdx);
    const minRow = Math.min(Table._rangeAnchor.rowIndex ?? 0, Table._rangeActive.rowIndex ?? 0);
    const maxRow = Math.max(Table._rangeAnchor.rowIndex ?? 0, Table._rangeActive.rowIndex ?? 0);
    const newSet = new Set<string>();
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

  _clearRange(): void {
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

  _copyRange(): void {
    if (!Table._rangeAnchor || !Table._rangeActive || !Table._api) return;
    const cols   = Table._api.getAllDisplayedColumns() as AgGridColumn[];
    const colIds = cols.map(c => c.getColId());
    const aIdx   = colIds.indexOf(Table._rangeAnchor.colId);
    const bIdx   = colIds.indexOf(Table._rangeActive.colId);
    if (aIdx === -1 || bIdx === -1) return;
    const minCol = Math.min(aIdx, bIdx);
    const maxCol = Math.max(aIdx, bIdx);
    const minRow = Math.min(Table._rangeAnchor.rowIndex ?? 0, Table._rangeActive.rowIndex ?? 0);
    const maxRow = Math.max(Table._rangeAnchor.rowIndex ?? 0, Table._rangeActive.rowIndex ?? 0);
    const rowStrs: string[] = [];
    for (let ri = minRow; ri <= maxRow; ri++) {
      const node = Table._api.getDisplayedRowAtIndex(ri) as AgGridRowNode | undefined;
      if (!node) continue;
      const cells: string[] = [];
      for (let ci = minCol; ci <= maxCol; ci++) {
        const colId  = colIds[ci];
        const col    = cols[ci];
        const raw    = Table._api.getValue(colId, node);
        const colDef = col.getColDef();
        let text: unknown = raw;
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
    Toast.show(Util.t('toast.copied_range').replace('{r}', String(nRows)).replace('{c}', String(nCols)), 'success');
    Table._clearRange();
  },

  _showAlertPopup(taskId: string): void {
    const rel = Store.alertsByTask().get(String(taskId)) || [];
    if (!rel.length) return;
    const t = Store.tasks[taskId];
    const po = t?.PRODUCTION_ORDER || t?.ORDER || String(taskId).slice(0, 8);
    const _esc = (s: unknown) => String(s == null ? '' : s).replace(/[&<>"']/g, (c: string) =>
      (({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' } as Record<string, string>)[c]));

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
    dlg.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target === dlg || target?.closest('[data-alert-close]')) { dlg.close(); return; }
      const btn = target?.closest('[data-alert-id]') as HTMLElement | null;
      if (btn) { dlg.close(); NIMBUS!.AlertsUIAdapter!.focus!(btn.dataset.alertId ?? ''); }
    });
  },

  _showNotePopover(e: MouseEvent, id: string): void {
    Table._closeNotePopover();
    const task = Store.tasks[id];
    if (!task) return;
    const _esc = (s: unknown) => String(s == null ? '' : s).replace(/[&<>"']/g, (c: string) =>
      (({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' } as Record<string, string>)[c]));

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

    const btn = (e.target as Element | null)?.closest('button') as HTMLElement ?? (e.target as HTMLElement);
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

    const ta = document.getElementById('nb-note-ta') as HTMLTextAreaElement | null;
    const cnt = document.getElementById('nb-note-cnt');
    if (!ta || !cnt) { ErrorLog.error('ui', 'required DOM elements missing for note popover'); return; }
    ta.addEventListener('input', () => {
      cnt.textContent = ta.value.length + '/500';
    });
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    setTimeout(() => {
      Table._noteOutsideHandler = (ev: MouseEvent) => { if (!pop.contains(ev.target as Node)) Table._closeNotePopover(); };
      document.addEventListener('mousedown', Table._noteOutsideHandler);
    }, 0);
    Table._noteKeyHandler = (ev: KeyboardEvent) => { if (ev.key === 'Escape') Table._closeNotePopover(); };
    document.addEventListener('keydown', Table._noteKeyHandler);
  },

  _saveNotePopover(id: string): void {
    const ta = document.getElementById('nb-note-ta') as HTMLTextAreaElement | null;
    if (!ta) { ErrorLog.error('ui', 'required DOM element missing: nb-note-ta'); return; }
    if (!Table._api) { ErrorLog.error('ui', 'Table._api not initialized'); return; }
    const val = ta.value.trim().slice(0, 500) || null;
    Store.updateTask(id, { notes: val }, 'table');
    Inspector._persistNote(id, val);
    Table._closeNotePopover();
    Table._api.applyTransaction({ update: [Store.tasks[id]] });
  },

  _closeNotePopover(): void {
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
    _input!: HTMLInputElement;
    init(params: { value: unknown }): void {
      this._input = document.createElement('input');
      this._input.type = 'datetime-local';
      this._input.style.width = '100%';
      this._input.style.height = '30px';
      this._input.style.border = '1px solid var(--accent)';
      this._input.style.padding = '0 6px';
      this._input.style.fontSize = '12px';
      this._input.value = Util.toLocalInput(params.value);
    }
    getGui(): HTMLInputElement { return this._input; }
    afterGuiAttached(): void { this._input.focus(); this._input.select(); }
    getValue(): Date | null { return Util.parseDate(this._input.value); }
    destroy(): void {}
  },

  // Scale mandate (CLAUDE.md Production Scale Roadmap): the line-reassignment
  // editor is the actual scheduling control (not just a filter), so it needs
  // type-to-filter even more than the chip picker does — AG Grid Community has
  // no searchable select (that's Enterprise's agRichSelectCellEditor), so this
  // is a small hand-rolled popup editor: text input + filtered option list.
  _SearchableLineEditor: class {
    _params!: TableLineEditorParams;
    _values!: string[];
    _chosen: string | null = null;
    _activeIdx = 0;
    _eGui!: HTMLDivElement;
    _input!: HTMLInputElement;
    _list!: HTMLDivElement;
    _filtered!: string[];

    init(params: TableLineEditorParams): void {
      this._params = params;
      this._values = (typeof params.values === 'function' ? params.values() : params.values) || [];
      this._chosen = null;
      this._activeIdx = 0;

      this._eGui = document.createElement('div');
      this._eGui.className = 'nse-editor';
      this._eGui.innerHTML = `<input type="text" class="nse-input" autocomplete="off"><div class="nse-list"></div>`;
      this._input = this._eGui.querySelector('.nse-input')!;
      this._list  = this._eGui.querySelector('.nse-list')!;
      this._input.value = params.value || '';
      this._input.addEventListener('input', () => this._renderList(this._input.value));
      this._input.addEventListener('keydown', (e: KeyboardEvent) => this._onKeyDown(e));
      this._renderList('');
    }
    _renderList(q: string): void {
      const query = q.toLowerCase().trim();
      this._filtered = query ? this._values.filter(v => v.toLowerCase().includes(query)) : this._values;
      this._activeIdx = 0;
      const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c: string) => (({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]));
      this._list.innerHTML = this._filtered.length
        ? this._filtered.map((v, i) => `<div class="nse-opt${i === 0 ? ' active' : ''}" data-i="${i}">${esc(v)}</div>`).join('')
        : `<div class="nse-empty">${Util.t('ui.no_matches')}</div>`;
      this._list.querySelectorAll('.nse-opt').forEach((el) => {
        el.addEventListener('mousedown', (e: Event) => { e.preventDefault(); this._choose(Number((el as HTMLElement).dataset.i)); });
      });
    }
    _choose(i: number): void {
      const v = this._filtered[i];
      if (v == null) return;
      this._chosen = v;
      this._input.value = v;
      this._params.api.stopEditing();
    }
    _onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'ArrowDown') { e.preventDefault(); this._move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this._move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); this._choose(this._activeIdx); }
      else if (e.key === 'Escape') { this._params.api.stopEditing(true); }
    }
    _move(delta: number): void {
      if (!this._filtered.length) return;
      this._activeIdx = (this._activeIdx + delta + this._filtered.length) % this._filtered.length;
      this._list.querySelectorAll('.nse-opt').forEach((el, i) => el.classList.toggle('active', i === this._activeIdx));
    }
    getGui(): HTMLDivElement { return this._eGui; }
    afterGuiAttached(): void { this._input.focus(); this._input.select(); }
    getValue(): string | null {
      if (this._chosen != null) return this._chosen;
      const typed = this._input.value.trim();
      const exact = this._values.find(v => v.toLowerCase() === typed.toLowerCase());
      return exact != null ? exact : this._params.value;
    }
    isPopup(): boolean { return true; }
    destroy(): void {}
  }
};

// -- Local type declarations (CQ-1 Phase 6 Task 3 conversion; scoped to
//    Inspector) ---------------------------------------------------------------

/** Inspector._onFieldChange's `[data-field]` inputs — Inspector._render() only
 *  ever wires PRODUCTION_LINE (<select>), notes (<textarea>), start_date
 *  (<input>, upgraded to Flatpickr) and RUN_TIME (<input type=number>), plus
 *  the open SAP-column bag via ORDER_QUANTITY_(GMEIN) — but the field name
 *  arrives as a plain string read off the DOM, not a compile-time literal. */
type InspectorFieldEl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/* =============================================================================
   INSPECTOR — right-side detail panel shown on the Timeline tab.
   Edits here write through the Store (source: 'inspector').
   ========================================================================== */
export const Inspector = {
  _currentId: null as string | null,
  _unsubStore: null as (() => void) | null,

  init(): void {
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

  show(task: NimbusTask): void {
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
  clear(): void {
    Inspector._currentId = null;
    const body = document.getElementById('inspector-body');
    if (body) body.innerHTML = `<div class="empty-state">${Util.t('empty.select_order')}</div>`;
  },

  _render(task: NimbusTask): void {
    const body = document.getElementById('inspector-body');
    if (!body) return;
    if (!task) { Inspector.clear(); return; }

    // Order fields originate from uploaded Excel — escape before innerHTML.
    const esc = (s: unknown) => String(s == null ? '' : s).replace(/[&<>"']/g, (c: string) => (({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' } as Record<string, string>)[c]));
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
    body.querySelectorAll('[data-field]').forEach((el) => {
      const fieldEl = el as InspectorFieldEl;
      fieldEl.onchange = () => Inspector._onFieldChange(fieldEl.dataset.field!, fieldEl.value);
    });
    // Action buttons via listeners (id is never concatenated into an HTML attribute).
    const _id = String(task.id);
    body.querySelector('[data-act="override"]')?.addEventListener('click', () => NIMBUS!.Table!._openOverrideModalForId!(_id));
    body.querySelector('[data-act="focus"]')?.addEventListener('click', () => NIMBUS!.Timeline!.focus!(_id));
    // Notes char counter (oninput fires on every keystroke)
    const notesEl = body.querySelector('[data-field="notes"]') as HTMLTextAreaElement | null;
    const notesRemEl = body.querySelector('#insp-notes-rem');
    if (notesEl && notesRemEl) {
      notesEl.oninput = () => { notesRemEl.textContent = String(500 - notesEl.value.length); };
      const _noteId = Inspector._currentId!;
      notesEl.onblur = () => {
        const trimmed = notesEl.value.trim() || null;
        Store.updateTask(_noteId, { notes: trimmed }, 'inspector');
        Inspector._persistNote(_noteId, trimmed);
      };
    }
    // Upgrade start_date to Flatpickr datetime picker
    const _dtEl = body.querySelector('[data-field="start_date"]') as HTMLInputElement | null;
    if (_dtEl) {
      Util.fpDatetime(_dtEl, {
        onChange() { Inspector._onFieldChange('start_date', _dtEl.value); }
      });
    }
  },

  _varianceBadge(t: NimbusTask): string {
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
    return `<span class="insp-var ${cls}" title="${Util.t('ui.insp_variance_shifted')}">${txt}</span>`;
  },

  _onFieldChange(field: string, value: string): void {
    if (!Inspector._currentId) return;
    const id = Inspector._currentId;
    const t  = Store.tasks[id];
    if (!t) return;
    const changes: Partial<NimbusTask> = {};
    if (field === 'start_date') {
      const d = Util.parseDate(value);
      if (!d) { Toast.show(Util.t('toast.invalid_date'), 'error'); return; }
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
      Inspector._persistNote(id, changes.notes ?? null);
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
  _noteTimers: {} as Record<string, ReturnType<typeof setTimeout>>,
  _persistNote(id: string, notes: string | null): void {
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

  toggleFix(fixed: boolean): void {
    if (!Inspector._currentId) return;
    Store.setFixed([Inspector._currentId], fixed, 'inspector');
    Alerts.scheduleRecompute();
  }
};

/* =============================================================================
   CONTEXT MENU — right-click on a timeline item.
   ========================================================================== */
export const ContextMenu = {
  _targetId: null as string | null,

  init(): void {
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

  open(x: number, y: number, targetId: string): void {
    ContextMenu._targetId = targetId;
    const menu = document.getElementById('ctx-menu') as HTMLElement | null;
    if (!menu) return;
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
    (menu.querySelector('[data-action="fix"]') as HTMLElement | null)!.style.display   = fixed ? 'none' : '';
    (menu.querySelector('[data-action="unfix"]') as HTMLElement | null)!.style.display = fixed ? '' : 'none';
  },
  close(): void {
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

// -- Local type declarations (CQ-1 Phase 6 Task 4 conversion; scoped to
//    Hierarchy/GanttFilter) --------------------------------------------------

/** Utilization.computeMatrix's return shape, named locally since the real
 *  interface (schedule-services.mts's UtilizationMatrixResolved) is module-
 *  private to that file — see its own header comment on why it isn't exported. */
type HierarchyUtilMatrix = ReturnType<typeof Utilization.computeMatrix>;

/** Hierarchy._lineItems — one VirtualList row per production line, rebuilt
 *  fresh on every render() from Store.tasksForSelectedPlant() plus the
 *  today-scoped utilization matrix (memoized on Hierarchy._todayCache). */
interface HierarchyLineItem {
  name: string;
  tasks: NimbusTask[];
  color: string;
  pct: number | null;
  sev: UtilSevBucket;
  pinned: boolean;
}

/* =============================================================================
   HIERARCHY — left sidebar with per-line order lists + utilisation chip.
   ========================================================================== */
export const Hierarchy = {
  _open:      new Set<string>(),
  _lineItems: [] as HierarchyLineItem[],
  _vl:        null as VirtualList<HierarchyLineItem> | null,
  _wired:     false,
  _todayCache: null as { key: string; matrix: HierarchyUtilMatrix } | null,   // { key, matrix } — local memo of the 1-day plant-scoped util matrix

  _renderPending: false,

  _scheduleRender(): void {
    if (Hierarchy._renderPending) return;
    Hierarchy._renderPending = true;
    requestAnimationFrame(() => {
      Hierarchy._renderPending = false;
      Hierarchy.render();
    });
  },

  init(): void {
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

  _itemH(item: HierarchyLineItem): number {
    return VL_HIER_LINE_H + (Hierarchy._open.has(item.name) ? item.tasks.length * VL_HIER_TASK_H : 0);
  },

  _renderItem(item: HierarchyLineItem): string {
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

  render(): void {
    const el = document.getElementById('hierarchy');
    if (!el) return;
    if (!Store.selectedPlant) {
      if (Hierarchy._vl) { Hierarchy._vl.destroy(); Hierarchy._vl = null; }
      NIMBUS!.EmptyState!.render!(el, {
        title: Util.t('empty.no_plant_selected'),
        msg:   Util.t('empty.no_plant_hierarchy')
      });
      return;
    }

    const lines: Record<string, NimbusTask[]> = {};
    for (const tk of Store.tasksForSelectedPlant()) {
      const k = tk.PRODUCTION_LINE || 'Unknown';
      (lines[k] ||= []).push(tk);
    }
    for (const l of Store.linesForSelectedPlant()) {
      if (!lines[l]) lines[l] = [];
    }
    const lineNames = Object.keys(lines).sort();
    let visibleNames = (GanttFilter._selectedLines.size > 0)
      ? lineNames.filter(l => GanttFilter._selectedLines.has(l))
      : lineNames;
    // Surface the user's pinned lines at the top (scale-safe quick access at
    // 70+ lines/plant), preserving alpha order within each group.
    let _pinnedLines: Set<string>;
    try { _pinnedLines = new Set((Store.pref('pinnedLines') as string[] | undefined) ?? []); } catch { _pinnedLines = new Set(); }
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
    let _utilToday: HierarchyUtilMatrix;
    if (Hierarchy._todayCache && Hierarchy._todayCache.key === _utilMKey) {
      _utilToday = Hierarchy._todayCache.matrix;
    } else {
      _utilToday = Utilization.computeMatrix(todayStart, 1, Store.tasksForSelectedPlant());
      Hierarchy._todayCache = { key: _utilMKey, matrix: _utilToday };
    }

    Hierarchy._lineItems = visibleNames.map((name): HierarchyLineItem => {
      const ci    = Timeline._colorIndex(name);
      const color = Config.COLORS[ci % Config.COLORS.length];
      const tasks = lines[name]
        .filter(tk => !!tk.start_date && tk.start_date.getTime() >= todayStart.getTime() && tk.start_date.getTime() <= todayEnd.getTime())
        .sort((a, b) => (a.start_date?.getTime() || 0) - (b.start_date?.getTime() || 0));
      const u   = _utilToday[name]?.[_todayKey];
      const pct = (u && u.scheduled > 0) ? Math.round(u.pct! * 100) : null;
      const sev: UtilSevBucket = u
        ? Utilization.sev(u.pct!, u.capacity > 0 ? u.effectiveCapacity / u.capacity : Config.OVERLOAD_THRESHOLD)
        : 'ok';
      return { name, tasks, color, pct, sev, pinned: _pinnedLines.has(name) };
    });

    if (!Hierarchy._vl) {
      el.innerHTML = '';
      Hierarchy._vl = new VirtualList<HierarchyLineItem>(el, {
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
      el.addEventListener('click', (e: MouseEvent) => {
        const target = e.target as Element | null;
        const sum = target?.closest('details.line-group > summary') as HTMLElement | null;
        if (sum) {
          e.preventDefault();
          const name = sum.parentElement!.dataset.line!;
          if (Hierarchy._open.has(name)) Hierarchy._open.delete(name);
          else Hierarchy._open.add(name);
          if (Hierarchy._vl) Hierarchy._vl.update(Hierarchy._lineItems);
          return;
        }
        const item = target?.closest('.hier-item') as HTMLElement | null;
        if (item) Timeline.focus(item.dataset.id!);
      });
    }

    Hierarchy._vl.update(Hierarchy._lineItems);
  }
};

/** GanttFilter._active — the free-text filter box's live state (kept as an
 *  object, not a bare string, so activeFilter() can hand callers a live
 *  reference rather than a stale snapshot). */
interface GanttFilterActiveState {
  text: string;
}

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
  _active:         { text: '' } as GanttFilterActiveState,
  _selectedLines:  new Set<string>(),
  _selectedColors: new Set<string>(),
  _selectedForms:  new Set<string>(),
  _pastedIds:      new Set<string>(),
  _bar:            null as HTMLElement | null,
  _lineSearch:     '',
  _colorSearch:    '',
  _formSearch:     '',

  init(): void {
    const bar = document.getElementById('gantt-filterbar');
    if (!bar) return;
    GanttFilter._bar = bar;
    GanttFilter.populate();

    const textIn = document.getElementById('flt-text') as HTMLInputElement | null;
    const clearBtn = document.getElementById('flt-clear');

    if (textIn)   textIn.oninput   = Util.debounce(() => { GanttFilter._active.text = textIn.value.trim().toLowerCase(); GanttFilter._apply!(); }, 120);
    if (clearBtn) clearBtn.onclick = () => GanttFilter.clear();

    Store.subscribe(evt => {
      if (evt.type === 'tasks:bulk') {
        GanttFilter.populate();
        GanttFilter._buildLineDropdown();
        GanttFilter._refreshLineBtn();
        setTimeout(() => GanttFilter._apply!(), 80);
      }
      if (evt.type === 'tasks:bulkUpdate') { setTimeout(() => GanttFilter._apply!(), 80); }
      if (evt.type === 'plant:selected') {
        GanttFilter._selectedLines.clear();
        GanttFilter._selectedColors.clear();
        GanttFilter._selectedForms.clear();
        GanttFilter._clearPoMat();
        GanttFilter._resetSearch();
        GanttFilter.populate();
        GanttFilter._buildLineDropdown();
        GanttFilter._refreshLineBtn();
        setTimeout(() => GanttFilter._apply!(), 80);
      }
    }, 'GanttFilter');

    const _fltPairs: Array<[HTMLElement | null, HTMLElement | null]> = [
      [document.getElementById('gantt-flt-line-btn'),  document.getElementById('gantt-line-dropdown')],
      [document.getElementById('gantt-flt-color-btn'), document.getElementById('gantt-color-dropdown')],
      [document.getElementById('gantt-flt-form-btn'),  document.getElementById('gantt-form-dropdown')],
      [document.getElementById('gantt-flt-pomat-btn'), document.getElementById('gantt-pomat-dropdown')],
    ];
    document.addEventListener('click', (e: MouseEvent) => {
      if (_fltPairs.every(([, d]) => !d || d.hidden)) return;
      const target = e.target as Node;
      for (const [btn, drop] of _fltPairs) {
        if (drop && !drop.hidden && btn && !btn.contains(target) && !drop.contains(target)) {
          drop.hidden = true;
        }
      }
    });

    const lineIn  = document.getElementById('gantt-line-paste-input') as HTMLInputElement | null;
    const colorIn = document.getElementById('gantt-color-paste-input') as HTMLInputElement | null;
    const formIn  = document.getElementById('gantt-form-paste-input') as HTMLInputElement | null;
    if (lineIn) {
      Util.wirePasteToCheckboxes(lineIn,
        () => Array.from(document.getElementById('gantt-line-checklist')?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') ?? []));
    }
    if (colorIn) {
      Util.wirePasteToCheckboxes(colorIn,
        () => Array.from(document.getElementById('gantt-color-checklist')?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') ?? []));
    }
    if (formIn) {
      Util.wirePasteToCheckboxes(formIn,
        () => Array.from(document.getElementById('gantt-form-checklist')?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') ?? []));
    }
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

  populate(): void {
    GanttFilter._buildColorDropdown();
    GanttFilter._buildFormDropdown();
  },

  matches(task: NimbusTask): boolean {
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

  isActive(): boolean {
    return !!(GanttFilter._selectedColors.size || GanttFilter._selectedForms.size
      || GanttFilter._pastedIds.size || GanttFilter._active.text);
  },

  clear(): void {
    GanttFilter._active = { text: '' };
    const textIn = document.getElementById('flt-text') as HTMLInputElement | null;
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
    GanttFilter._apply!();
  },

  // Clears the line/color/form live-search text and its <input> values without
  // touching selections — shared by the plant-change handler and clear().
  _resetSearch(): void {
    GanttFilter._lineSearch = GanttFilter._colorSearch = GanttFilter._formSearch = '';
    const lineIn  = document.getElementById('gantt-line-paste-input') as HTMLInputElement | null;
    const colorIn = document.getElementById('gantt-color-paste-input') as HTMLInputElement | null;
    const formIn  = document.getElementById('gantt-form-paste-input') as HTMLInputElement | null;
    if (lineIn)  lineIn.value  = '';
    if (colorIn) colorIn.value = '';
    if (formIn)  formIn.value  = '';
  },

  _toggleLineDropdown(): void {
    const drop = document.getElementById('gantt-line-dropdown');
    if (drop) drop.hidden = !drop.hidden;
  },

  // Scale mandate (CLAUDE.md Production Scale Roadmap): every plant/line picker
  // must stay filterable, not a bare scrollable checkbox list — this is the
  // Gantt line filter's share of that, matching the Dashboard's line filter.
  _filterLineSearch(q: string): void {
    GanttFilter._lineSearch = q || '';
    GanttFilter._buildLineDropdown();
  },

  _buildLineDropdown(): void {
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
    const esc = (s: unknown) => String(s).replace(/[&<>"]/g,
      (c: string) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]));
    drop.innerHTML = visible.length
      ? visible.map(l =>
          `<label><input type="checkbox" value="${esc(l)}"${GanttFilter._selectedLines.has(l) ? ' checked' : ''}
           onchange="NIMBUS.GanttFilter._onLineChange(this)"> ${esc(l)}</label>`
        ).join('')
      : `<div style="padding:8px 14px;font-size:12px;color:#9a9285">${sorted.length ? Util.t('ui.no_matches') : 'No lines'}</div>`;
  },

  _refreshLineBtn(): void {
    const btn = document.getElementById('gantt-flt-line-btn');
    const lbl = document.getElementById('gantt-flt-line-label');
    if (!lbl) return;
    const n = GanttFilter._selectedLines.size;
    lbl.textContent = n === 0 ? Util.t('ui.all_lines')
      : n === 1 ? [...GanttFilter._selectedLines][0]
      : Util.t('ui.n_lines_filter', { count: n });
    if (btn) btn.classList.toggle('active', n > 0);
  },

  _onLineChange(cb: HTMLInputElement): void {
    if (cb.checked) GanttFilter._selectedLines.add(cb.value);
    else            GanttFilter._selectedLines.delete(cb.value);
    GanttFilter._refreshLineBtn();
    Timeline.rebuild();
    Hierarchy.render();
  },

  _clearLines(): void {
    GanttFilter._selectedLines.clear();
    GanttFilter._buildLineDropdown();
    GanttFilter._refreshLineBtn();
    Timeline.rebuild();
    Hierarchy.render();
  },

  _toggleColorDropdown(): void {
    const drop = document.getElementById('gantt-color-dropdown');
    if (drop) drop.hidden = !drop.hidden;
  },

  _filterColorSearch(q: string): void {
    GanttFilter._colorSearch = q || '';
    GanttFilter._buildColorDropdown();
  },

  _buildColorDropdown(): void {
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
    const esc = (s: unknown) => String(s).replace(/[&<>"]/g,
      (c: string) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]));
    drop.innerHTML = visible.length
      ? visible.map(c =>
          `<label><input type="checkbox" value="${esc(c)}"${GanttFilter._selectedColors.has(c) ? ' checked' : ''}
           onchange="NIMBUS.GanttFilter._onColorChange(this)"> ${esc(c)}</label>`
        ).join('')
      : `<div style="padding:8px 14px;font-size:12px;color:#9a9285">${sorted.length ? Util.t('ui.no_matches') : 'No colors'}</div>`;
    GanttFilter._refreshColorBtn();
  },

  _refreshColorBtn(): void {
    const lbl = document.getElementById('gantt-flt-color-label');
    if (!lbl) return;
    const n = GanttFilter._selectedColors.size;
    lbl.textContent = n === 0 ? Util.t('ui.all_colors')
      : n === 1 ? [...GanttFilter._selectedColors][0]
      : Util.t('ui.n_colors_filter', { count: n });
    const btn = document.getElementById('gantt-flt-color-btn');
    if (btn) btn.classList.toggle('active', n > 0);
  },

  _onColorChange(cb: HTMLInputElement): void {
    if (cb.checked) GanttFilter._selectedColors.add(cb.value.toUpperCase());
    else            GanttFilter._selectedColors.delete(cb.value.toUpperCase());
    GanttFilter._refreshColorBtn();
    GanttFilter._apply!();
  },

  _toggleFormDropdown(): void {
    const drop = document.getElementById('gantt-form-dropdown');
    if (drop) drop.hidden = !drop.hidden;
  },

  _filterFormSearch(q: string): void {
    GanttFilter._formSearch = q || '';
    GanttFilter._buildFormDropdown();
  },

  _buildFormDropdown(): void {
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
    const esc = (s: unknown) => String(s).replace(/[&<>"]/g,
      (c: string) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]));
    drop.innerHTML = visible.length
      ? visible.map(f =>
          `<label><input type="checkbox" value="${esc(f)}"${GanttFilter._selectedForms.has(f) ? ' checked' : ''}
           onchange="NIMBUS.GanttFilter._onFormChange(this)"> ${esc(f)}</label>`
        ).join('')
      : `<div style="padding:8px 14px;font-size:12px;color:#9a9285">${sorted.length ? Util.t('ui.no_matches') : 'No forms'}</div>`;
    GanttFilter._refreshFormBtn();
  },

  _refreshFormBtn(): void {
    const btn = document.getElementById('gantt-flt-form-btn');
    const lbl = document.getElementById('gantt-flt-form-label');
    if (!lbl) return;
    const n = GanttFilter._selectedForms.size;
    lbl.textContent = n === 0 ? Util.t('ui.all_forms')
      : n === 1 ? [...GanttFilter._selectedForms][0]
      : Util.t('ui.n_forms_filter', { count: n });
    if (btn) btn.classList.toggle('active', n > 0);
  },

  _onFormChange(cb: HTMLInputElement): void {
    if (cb.checked) GanttFilter._selectedForms.add(cb.value.toUpperCase());
    else            GanttFilter._selectedForms.delete(cb.value.toUpperCase());
    GanttFilter._refreshFormBtn();
    GanttFilter._apply!();
  },

  _togglePoMatDropdown(): void {
    const drop = document.getElementById('gantt-pomat-dropdown');
    if (drop) drop.hidden = !drop.hidden;
  },

  _refreshPoMatBtn(): void {
    const btn = document.getElementById('gantt-flt-pomat-btn');
    const lbl = document.getElementById('gantt-flt-pomat-label');
    if (!lbl) return;
    const n = GanttFilter._pastedIds.size;
    lbl.textContent = n === 0 ? Util.t('ui.all_pomat') : Util.t('ui.n_pomat_filter', { count: n });
    if (btn) btn.classList.toggle('active', n > 0);
  },

  _onPoMatApply(): void {
    const ta = document.getElementById('gantt-pomat-textarea') as HTMLTextAreaElement | null;
    if (!ta) return;
    GanttFilter._pastedIds = new Set(Util.parsePasteList(ta.value).map(Util.norm));
    const cnt = document.getElementById('gantt-pomat-count');
    if (cnt) {
      const n = GanttFilter._pastedIds.size;
      cnt.textContent = n ? Util.t('ui.pomat_count', { count: n }) : '';
    }
    GanttFilter._refreshPoMatBtn();
    GanttFilter._apply!();
  },

  _onPoMatPaste(e: ClipboardEvent): void {
    const text = (e.clipboardData || (window as unknown as { clipboardData?: DataTransfer }).clipboardData)?.getData('text/plain');
    if (!text || !text.trim()) return;
    const known = new Set<string>();
    (Store.selectedPlant ? Store.tasksForSelectedPlant() : []).forEach(task => {
      const po = Util.norm(task.ORDER ?? task.PRODUCTION_ORDER); if (po) known.add(po);
      const mat = Util.norm(task.MATERIAL_NUMBER); if (mat) known.add(mat);
    });
    const { matched, total } = Util.countPasteMatches(text, known);
    if (total) Toast.show(Util.t('toast.paste_pomat_match', { matched, total }), matched > 0 ? 'success' : 'warn');
  },

  _clearPoMat(): void {
    GanttFilter._pastedIds.clear();
    const ta = document.getElementById('gantt-pomat-textarea') as HTMLTextAreaElement | null;
    if (ta) ta.value = '';
    const cnt = document.getElementById('gantt-pomat-count');
    if (cnt) cnt.textContent = '';
    GanttFilter._refreshPoMatBtn();
    GanttFilter._apply!();
  },

  _apply: null as (() => void) | null,  // assigned below after Util is in scope

  _doApply(): void {
    if (!Timeline._items) return;
    const active = GanttFilter.isActive();
    const badge = document.getElementById('flt-badge');
    const bar   = document.getElementById('gantt-filterbar');

    const updates: Array<{ id: string; className: string }> = [];
    const scoped = Store.selectedPlant ? Store.tasksForSelectedPlant() : [];
    for (const task of scoped) {
      if (!task.start_date || !task.end_date) continue;
      const id = String(task.id);
      const item = Timeline._items.get(id) as TimelineVisItem | null;
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
  selectedLines(): Set<string> { return GanttFilter._selectedLines; },
  activeFilter(): GanttFilterActiveState { return GanttFilter._active; },
  isolateLine(line: string): void {
    GanttFilter._selectedLines.clear();
    GanttFilter._selectedLines.add(line);
    GanttFilter._refreshLineBtn();
    GanttFilter._buildLineDropdown();
  },
  restoreAllLines(): void {
    GanttFilter._selectedLines.clear();
    GanttFilter._refreshLineBtn();
    GanttFilter._buildLineDropdown();
  },
};

GanttFilter._apply = Util.debounce(() => GanttFilter._doApply(), 60);

// VirtualList row-height constant for Dashboard's Line Status list (moved
// from app.js's top-of-file const group alongside VL_HIER_LINE_H/
// VL_HIER_TASK_H, moved in Task 3, and VL_ALERT_ROW_H, which travels with
// AlertsUIAdapter in Task 7).
const VL_LS_ROW_H = 36;

// -- Local type declarations (CQ-1 Phase 6 Task 5 conversion; scoped to
//    Dashboard) --------------------------------------------------------------

/** Utilization.computeMatrix's return shape, named locally since the real
 *  interface (schedule-services.mts's UtilizationMatrixResolved) is module-
 *  private to that file — see its own header comment on why it isn't exported.
 *  Same pattern as Hierarchy's HierarchyUtilMatrix (Task 4). */
type DashboardUtilMatrix = ReturnType<typeof Utilization.computeMatrix>;

/** _renderKPIs' `tiles` array — one action-oriented KPI strip tile. */
type DashboardTileAction = 'orders-today' | 'alerts-today' | 'late' | 'headroom';
interface DashboardKpiTile {
  k: string;
  v: string;
  d: string;
  cls?: string;
  action?: DashboardTileAction;
}

/** _renderLineStatus's precomputed-then-virtualized row data. */
interface DashboardLineStatusRow {
  line: string;
  color: string;
  sched: string;
  cap: string;
  effCap: string;
  pct: number;
  sev: UtilSevBucket;
  barW: number;
  isOver: boolean;
  nxtCO: string;
}

/** One line×day cell of the Projected-Lateness Risk Heatmap
 *  (_renderLatenessHeatmap builds this, _renderLatenessDrill reads it). */
interface DashboardLatenessCell {
  lateHours: number;
  lateCount: number;
  tasks: NimbusTask[];
}
type DashboardLatenessMatrix = Record<string, Record<string, DashboardLatenessCell>>;

/* =============================================================================
   DASHBOARD — KPIs, today-by-line chart, alert summary.
   ========================================================================== */
export const Dashboard = {
  _prevKpi:    {} as Record<string, string>,

  _filterLines:  new Set<string>(),
  _allLines:     null as string[] | null,
  _resizeDebounced: null as ReturnType<typeof setTimeout> | null,
  _matrix7Cache: null as { key: string; matrix: DashboardUtilMatrix } | null,
  _lsVL:         null as VirtualList<DashboardLineStatusRow> | null,

  _latenessHorizon: 14,                  // days; toggled by 7/14/28 segment buttons
  _latenessDrillKey: null as string | null,     // 'LINE|YYYY-MM-DD' for the currently-drilled cell

  _renderDebounced: null as ReturnType<typeof setTimeout> | null,
  init(): void {
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
        clearTimeout(Dashboard._renderDebounced ?? undefined);
        Dashboard._renderDebounced = setTimeout(() => Dashboard.render(), 300);
      }
    }, 'Dashboard');
    // Close line-filter dropdown on outside click or Escape
    const closeLineFilterDropdown = () => {
      const d = document.getElementById('line-filter-dropdown');
      const btn = document.getElementById('line-filter-btn');
      if (d) d.hidden = true;
      if (btn) btn.setAttribute('aria-expanded', 'false');
    };
    document.addEventListener('click', (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest('#line-filter-group')) closeLineFilterDropdown();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeLineFilterDropdown();
    });
    // Wire lateness-horizon segment buttons.
    const horizonGroup = document.getElementById('lateness-horizon-group');
    if (horizonGroup) {
      horizonGroup.addEventListener('click', (e: MouseEvent) => {
        const btn = (e.target as HTMLElement).closest('button[data-h]') as HTMLButtonElement | null;
        if (!btn) return;
        const h = parseInt(btn.dataset.h || '', 10);
        if (!Number.isFinite(h) || h === Dashboard._latenessHorizon) return;
        Dashboard._latenessHorizon = h;
        horizonGroup.querySelectorAll('button').forEach(b =>
          b.classList.toggle('active', parseInt(b.dataset.h || '', 10) === h)
        );
        Dashboard._latenessDrillKey = null;
        Dashboard._renderLatenessHeatmap();
      });
    }
    // Line Status card height is copied from the heatmap panel's rendered size
    // (_syncLineStatusHeight) — without a resize listener the two panels drift
    // out of sync until the next data-driven re-render.
    window.addEventListener('resize', () => {
      clearTimeout(Dashboard._resizeDebounced ?? undefined);
      Dashboard._resizeDebounced = setTimeout(() => Dashboard._syncLineStatusHeight(), 150);
    });
    setTimeout(() => Dashboard._buildFilterOptions(), 0);
  },

  _filteredTasks(): NimbusTask[] {
    let tasks = Store.tasksForSelectedPlant();
    if (Dashboard._filterLines.size > 0) {
      tasks = tasks.filter(t => Dashboard._filterLines.has(t.PRODUCTION_LINE));
    }
    return tasks;
  },

  _buildFilterOptions(): void {
    // Store.linesForSelectedPlant() is now an O(1) indexed read (Store._linesByPlant,
    // rebuilt in rebuildPlantIndex) — no need to hand-build a plant→lines map here.
    Dashboard._refreshLineDropdown();
    Dashboard._refreshFilterBtns();
  },

  _lineSearch: '',

  _filterLineSearch(q: string): void {
    Dashboard._lineSearch = q || '';
    Dashboard._renderLineChecklist();
  },

  _refreshLineDropdown(): void {
    const btn  = document.getElementById('line-filter-btn') as HTMLButtonElement | null;
    const drop = document.getElementById('line-filter-dropdown');
    if (!btn || !drop) return;

    Dashboard._lineSearch = '';
    const srch = document.getElementById('line-filter-search') as HTMLInputElement | null;
    if (srch) srch.value = '';

    if (!Store.selectedPlant) {
      btn.disabled = true;
      Dashboard._allLines = [];
      Dashboard._renderLineChecklist();
      return;
    }
    btn.disabled = false;

    const lines = new Set(Store.linesForSelectedPlant());
    // Drop stale line selections
    for (const l of [...Dashboard._filterLines]) {
      if (!lines.has(l)) Dashboard._filterLines.delete(l);
    }

    Dashboard._allLines = [...lines].sort();
    Dashboard._renderLineChecklist();
  },

  // Scale mandate (CLAUDE.md Production Scale Roadmap): every plant/line picker
  // must stay filterable, not a bare scrollable checkbox list — this is the
  // dashboard's line filter's share of that, matching the Gantt/Orders dropdowns.
  _renderLineChecklist(): void {
    const list = document.getElementById('line-filter-checklist');
    if (!list) return;
    const all = Dashboard._allLines || [];
    const q = Dashboard._lineSearch.toLowerCase().trim();
    const visible = q ? all.filter(l => l.toLowerCase().includes(q)) : all;
    const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c: string) => (({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]));
    list.innerHTML = visible.length
      ? visible.map(l => `<label><input type="checkbox" value="${esc(l)}"${Dashboard._filterLines.has(l) ? ' checked' : ''} onchange="NIMBUS.Dashboard._onLineChange(this)"> ${esc(l)}</label>`).join('')
      : `<div style="padding:8px 14px;font-size:12px;color:var(--fg-mute)">${all.length ? Util.t('ui.no_matches') : 'No lines'}</div>`;
  },

  _refreshFilterBtns(): void {
    const lineBtn   = document.getElementById('line-filter-btn');
    const lineLbl   = document.getElementById('line-filter-label');
    const clearBtn  = document.getElementById('dash-filter-clear');
    const hint      = document.getElementById('dash-filter-hint');

    if (lineBtn)  lineBtn.classList.toggle('active',  Dashboard._filterLines.size > 0);

    if (lineLbl) {
      const ls = Dashboard._filterLines.size;
      lineLbl.textContent = ls === 0 ? Util.t('ui.all_lines') : ls === 1 ? [...Dashboard._filterLines][0] : Util.t('ui.n_lines_filter', { count: ls });
    }

    const hasFilter = Dashboard._filterLines.size > 0;
    if (clearBtn) clearBtn.hidden = !hasFilter;
    if (hint) {
      if (Store.selectedPlant) {
        const n = Dashboard._filteredTasks().length;
        hint.textContent = Util.t('ui.orders_visible', { count: n, plural: n !== 1 ? Util.t('ui.orders_visible_plural') : '' });
      } else {
        hint.textContent = '';
      }
    }
  },

  _toggleDropdown(id: string, btnId?: string): void {
    const drop = document.getElementById(id);
    if (!drop) return;
    drop.hidden = !drop.hidden;
    const btn = btnId ? document.getElementById(btnId) : null;
    if (btn) btn.setAttribute('aria-expanded', String(!drop.hidden));
  },

  _onLineChange(cb: HTMLInputElement): void {
    if (cb.checked) Dashboard._filterLines.add(cb.value);
    else Dashboard._filterLines.delete(cb.value);
    Dashboard._refreshFilterBtns();
    Dashboard.render();
  },

  _clearFilters(): void {
    Dashboard._filterLines.clear();
    Dashboard._refreshLineDropdown();
    Dashboard._refreshFilterBtns();
    Dashboard.render();
  },
  _syncLineStatusHeight(): void {
    requestAnimationFrame(() => {
      const heatmapPanel = document.getElementById('util-heatmap-panel')?.closest('.panel');
      const lineStatusCard = document.getElementById('line-status-card');
      if (!heatmapPanel || !lineStatusCard) return;
      const head = heatmapPanel.querySelector('.panel-head') as HTMLElement | null;
      const body = heatmapPanel.querySelector('.panel-body') as HTMLElement | null;
      if (!head || !body) return;
      lineStatusCard.style.maxHeight = (head.offsetHeight + body.offsetHeight) + 'px';
    });
  },

  render(): void {
    // Only render heavy bits if the home tab is currently active — but still
    // update the alert bell badge on every change.
    NIMBUS!.AlertsUIAdapter!.renderBell!();

    if (!document.getElementById('home-tab')!.classList.contains('active')) return;

    Dashboard._renderEmptyState();
    if (!Store.selectedPlant) return;

    // Build the shared filtered task set + 7-day utilization matrix ONCE and hand it
    // to both _renderKPIs and _renderHeatmap (each otherwise rebuilds an identical
    // filtered-subset matrix — three full computeMatrix passes per render, two of them
    // duplicate 7-day work). The 1-day line-status matrix stays its own call.
    const _now7    = new Date();
    const _filtered = Dashboard._filteredTasks();
    // Memoize the 7-day matrix across renders (R14). _filteredTasks scopes by selected
    // plant + line filter, so the matrix is a pure function of (plant, filterLines,
    // _rev, today). computeMatrix bypasses its own memo for filtered subsets, so without
    // this every render (plant change, filter toggle, 300ms-debounced Store events)
    // rebuilt the whole O(lines×days) matrix from scratch.
    const _scope = (Store.selectedPlant || '') + '|' + [...Dashboard._filterLines].sort().join(',');
    const _mkey  = `${Util.startOfDay(_now7)!.getTime()}|7|${Store.rev()}|${_scope}`;
    let _matrix7: DashboardUtilMatrix;
    if (Dashboard._matrix7Cache && Dashboard._matrix7Cache.key === _mkey) {
      _matrix7 = Dashboard._matrix7Cache.matrix;
    } else {
      _matrix7 = Utilization.computeMatrix(_now7, 7, _filtered);
      Dashboard._matrix7Cache = { key: _mkey, matrix: _matrix7 };
    }

    Dashboard._renderKPIs(_matrix7, _filtered);
    Dashboard._renderHeatmap(_matrix7);
    Dashboard._renderLineStatus();
    Dashboard._renderAlertSummary();
    Dashboard._renderFixedList();
    Dashboard._renderLatenessHeatmap();
    Dashboard._syncLineStatusHeight();
  },

  _renderEmptyState(): void {
    const homeContainer = document.querySelector('#home-tab .home-container');
    let overlay = document.getElementById('dashboard-empty-overlay');
    const situationEl = document.getElementById('wh-situation');
    const dataPanels = document.querySelectorAll<HTMLElement>('#home-tab .home-container > .kpi-stack, #home-tab .home-container > .grid-2, #home-tab .home-container > .panel');
    if (!Store.selectedPlant) {
      if (!overlay && homeContainer) {
        overlay = document.createElement('div');
        overlay.id = 'dashboard-empty-overlay';
        overlay.className = 'dashboard-empty-overlay';
        // Insert after the work header so the greeting still leads.
        const header = homeContainer.querySelector('.work-header');
        if (header && header.nextSibling) homeContainer.insertBefore(overlay, header.nextSibling);
        else homeContainer.appendChild(overlay);
      }
      if (overlay) {
        NIMBUS!.EmptyState!.render!(overlay, {
          title: Util.t('empty.pick_plant_dashboard'),
          msg:   Util.t('ui.select_plant_dashboard_msg')
        });
      }
      if (situationEl) { situationEl.textContent = ''; situationEl.classList.remove('warn'); }
      dataPanels.forEach(el => el.style.display = 'none');
    } else {
      if (overlay) overlay.remove();
      dataPanels.forEach(el => el.style.display = '');
    }
  },

  _renderKPIs(matrix7?: DashboardUtilMatrix, tasksArg?: NimbusTask[]): void {
    const tasks = tasksArg !== undefined ? tasksArg : Dashboard._filteredTasks();
    const today = Util.startOfDay(new Date());

    const todayOrders = tasks.filter(t => t.start_date && Util.dayKey(t.start_date) === Util.dayKey(today));

    // Overdue backlog: every order whose scheduled finish has slipped past its SAP due date.
    const lateCount = tasks.filter(t => Util.latenessHours(t) > 0).length;

    // Alerts Today tile (kpi.conflicts_pending, action:'alerts-today') must count exactly
    // what its click-through shows -- Table._applyChipFilter({status:'conflict', dateKey:today})
    // -- i.e. today's orders carrying >=1 err alert.
    const alertsByTask = Store.alertsByTask();
    const conflictsToday = todayOrders.filter(t =>
      (alertsByTask.get(String(t.id)) || []).some(a => a.sev === 'err')).length;
    const conflictCls = conflictsToday > 0 ? 'err' : '';

    // Capacity Headroom Next 7D: 1 - average utilization across all line-day cells with capacity.
    // Reuse the matrix built once in render() when provided; recompute standalone otherwise.
    if (matrix7 === undefined) matrix7 = Utilization.computeMatrix(new Date(), 7, tasks);
    let pctSum = 0, pctN = 0;
    for (const ln of Object.keys(matrix7)) {
      for (const d of Object.keys(matrix7[ln])) {
        const cell = matrix7[ln][d];
        if (cell && cell.capacity > 0) { pctSum += cell.pct ?? 0; pctN++; }
      }
    }
    const avgUtil = pctN > 0 ? pctSum / pctN : 0;
    const headroom = Math.max(0, Math.round((1 - avgUtil) * 100));
    const headroomSev = avgUtil >= 0.95 ? 'err' : avgUtil >= 0.80 ? 'warn' : 'ok';

    // Four action-oriented tiles, one calm row. Open Alerts and Fixed Orders were
    // trimmed off this row — both counts still surface in their own panels below
    // (alert-summary-count, the fixed-orders list) so nothing is lost, just decluttered.
    const tiles: DashboardKpiTile[] = [
      { k: Util.t('kpi.orders_today'),             v: String(todayOrders.length),
        d: Util.t('kpi.orders_total', { n: tasks.length }),
        action: 'orders-today' },
      { k: Util.t('kpi.conflicts_pending'),         v: String(conflictsToday),
        d: conflictsToday === 0 ? Util.t('kpi.none_blocking') : Util.t('kpi.blocking_fix_now'),
        cls: conflictCls,
        action: 'alerts-today' },
      { k: Util.t('kpi.overdue_backlog'),           v: String(lateCount),
        d: lateCount === 0 ? Util.t('kpi.no_backlog') : Util.t('kpi.all_open_past_finish'),
        // Historical/running-total metric, not a today-action item — kept neutral
        // so red is reserved for the one tile that's actually blocking right now.
        cls: '',
        action: 'late' },
      { k: Util.t('kpi.capacity_headroom_7d'),      v: `${headroom}%`,
        d: pctN > 0 ? Util.t('kpi.avg_used', { p: Math.round(avgUtil * 100) }) : Util.t('kpi.no_data'),
        cls: headroomSev === 'err' ? 'err' : headroomSev === 'warn' ? 'warn' : '',
        action: 'headroom' },
    ];

    Dashboard._renderSituation({ todayCount: todayOrders.length, attention: conflictsToday + lateCount });

    const stack = document.getElementById('kpi-stack');
    if (!stack) return;

    // Build tiles, animating numeric values that changed since last render.
    tiles.forEach((tile, idx) => {
      let el = stack.children[idx] as HTMLButtonElement | undefined;
      if (!el) {
        // Real <button> so keyboard/screen-reader users get focus + Enter/Space
        // activation natively — a div with a hand-rolled role/tabindex promised
        // the same and never wired a keydown handler to deliver on it.
        el = document.createElement('button');
        el.type = 'button';
        stack.appendChild(el);
      }
      el.className = 'kpi-tile ' + (tile.cls || '') + (tile.action ? ' is-actionable' : '');
      el.disabled = !tile.action;
      el.onclick = tile.action ? () => Dashboard._tileClick(tile.action!) : null;
      if (tile.action) el.setAttribute('title', Dashboard._tileTooltip(tile.action));
      else el.removeAttribute('title');
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
      const prevNum = parseFloat(String(prevVal));
      if (isNum && prevVal !== undefined && !isNaN(prevNum) && prevNum !== rawNum) {
        Dashboard._animateTicker(vEl, prevNum, rawNum, tile.v, 400);
      } else {
        vEl.textContent = tile.v;
      }
      Dashboard._prevKpi[tile.k] = tile.v;
    });
    // Remove extra tiles if lines reduced
    while (stack.children.length > tiles.length) stack.removeChild(stack.lastChild!);
  },

  _tileTooltip(action: DashboardTileAction): string {
    switch (action) {
      case 'orders-today': return 'Open Orders table filtered to today';
      case 'late':         return 'Open Orders table filtered to orders past their SAP due date';
      case 'alerts-today': return 'Open Orders table filtered to conflicting orders due today';
      case 'headroom':     return 'Jump to utilization heatmap';
      default: return '';
    }
  },

  _tileClick(action: DashboardTileAction): void {
    switch (action) {
      case 'orders-today': {
        NIMBUS!.App!.goto!('table');
        const todayDt = Util.startOfDay(new Date());
        const ymd = Util.dayKey(todayDt);
        setTimeout(() => {
          if (NIMBUS!.Table && NIMBUS!.Table!._applyChipFilter) {
            NIMBUS!.Table!._applyChipFilter!({ dateKey: ymd });
          }
        }, 120);
        break;
      }
      case 'late': {
        NIMBUS!.App!.goto!('table');
        setTimeout(() => {
          if (NIMBUS!.Table && NIMBUS!.Table!._applyChipFilter) {
            NIMBUS!.Table!._applyChipFilter!({ status: 'late' });
          }
        }, 120);
        break;
      }
      case 'alerts-today': {
        NIMBUS!.App!.goto!('table');
        const ymd = Util.dayKey(Util.startOfDay(new Date()));
        setTimeout(() => {
          if (NIMBUS!.Table && NIMBUS!.Table!._applyChipFilter) {
            NIMBUS!.Table!._applyChipFilter!({ status: 'conflict', dateKey: ymd });
          }
        }, 120);
        break;
      }
      case 'headroom': {
        const hm = document.getElementById('util-heatmap-panel');
        if (hm) hm.closest('.panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        break;
      }
    }
  },

  // Work-header situation line: "3 need attention · 42 orders scheduled today" (or the
  // all-clear phrasing). Fed directly from _renderKPIs' own todayOrders/conflictsToday/
  // lateCount so the header always agrees with the tiles below it — no separate recompute.
  _renderSituation({ todayCount, attention }: { todayCount: number; attention: number }): void {
    const el = document.getElementById('wh-situation');
    if (!el) return;
    const totalPlural = todayCount === 1 ? '' : 's';
    if (attention > 0) {
      el.textContent = Util.t('ui.work_status_attention', {
        count: attention, plural: attention === 1 ? '' : 's',
        total: todayCount, totalPlural,
      });
    } else {
      el.textContent = Util.t('ui.work_status_clear', { total: todayCount, totalPlural });
    }
    el.classList.toggle('warn', attention > 0);
  },

  _animateTicker(el: Element, from: number, to: number, toStr: string, dur: number): void {
    const suffix = toStr.replace(/[\d.]/g, '');
    const start = performance.now();
    const step = (ts: number) => {
      const p = Math.min((ts - start) / dur, 1);
      const eased = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
      const cur = from + (to - from) * eased;
      el.textContent = (Number.isInteger(to) ? Math.round(cur) : cur.toFixed(1)) + suffix;
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = toStr;
    };
    requestAnimationFrame(step);
  },

  // Read a real CSS custom property so heatmap colors stay theme-correct and
  // in sync with DESIGN.md's tokens instead of hand-duplicated light/dark hex pairs.
  _cssVar(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  },
  _lerpHex(a: string, b: string, frac: number): string {
    const p = (h: string): number[] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const ca = p(a), cb = p(b);
    const rgb = [0, 1, 2].map(i => Math.round(ca[i] + (cb[i] - ca[i]) * frac));
    return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
  },
  // WCAG relative luminance — picks readable text color from the actual resolved
  // background instead of a hand-tuned per-theme pct threshold.
  _relLuminance(hex: string): number {
    const c = [1, 3, 5].map(i => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  },

  _renderHeatmap(matrix?: DashboardUtilMatrix): void {
    const container = document.getElementById('util-heatmap-panel');
    if (!container) return;

    // Reuse the 7-day matrix built once in render() when provided; recompute standalone otherwise.
    if (matrix === undefined) matrix = Utilization.computeMatrix(new Date(), 7, Dashboard._filteredTasks());
    const lines = Object.keys(matrix).sort();

    if (!lines.length) {
      container.innerHTML = `<div class="empty-state">${Util.t('empty.no_util_data')}</div>`;
      return;
    }

    const days = Object.keys(matrix[lines[0]]);

    const idleBg  = Dashboard._cssVar('--bg-subtle', '#ecebe4');
    const warnBg  = Dashboard._cssVar('--warn', '#b57a0a');
    const vividBg = Dashboard._cssVar('--warn-vivid', '#f39c12');
    const errBg   = Dashboard._cssVar('--err', '#b1362a');
    const muteTxt = Dashboard._cssVar('--fg-mute', '#6b6c73');
    const inkTxt  = Dashboard._cssVar('--fg', '#1a1b1f');
    const onTxt   = Dashboard._cssVar('--primary-fg', '#fcfbf6');
    function heatBg(pct: number): string {
      if (pct <= 0)    return idleBg;
      if (pct <= 0.5)  return Dashboard._lerpHex(idleBg, warnBg, pct / 0.5);
      if (pct <= 1.0)  return Dashboard._lerpHex(warnBg, vividBg, (pct - 0.5) / 0.5);
      return Dashboard._lerpHex(vividBg, errBg, Math.min((pct - 1.0) / 0.25, 1));
    }
    function heatText(pct: number, bg: string): string {
      if (pct <= 0) return muteTxt;
      return Dashboard._relLuminance(bg) > 0.45 ? inkTxt : onTxt;
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
        const tc  = heatText(pct, bg);
        const lbl = Math.round(pct * 100) + '%';
        const cap     = (matrix[line][d]?.capacity || 0).toFixed(2);
        const effCap  = (matrix[line][d]?.effectiveCapacity ?? (matrix[line][d]?.capacity || 0)).toFixed(2);
        const sched   = (matrix[line][d]?.scheduled || 0).toFixed(2);
        const effNote = effCap !== cap ? ` · limit ${effCap}h` : '';
        html += `<button type="button" class="hm-cell" data-line="${line}" data-date="${d}" style="background:${bg};color:${tc}" title="Click to view ${line} on ${d} · ${lbl} (${sched}h / ${cap}h${effNote})" onclick="NIMBUS.Dashboard._gotoLine('${line}','${d}')">${lbl}</button>`;
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


  _nextChangeover(lineTasks: NimbusTask[], now: Date): Date | null {
    const activeIdx = lineTasks.findIndex(t => t.start_date && t.end_date && t.start_date <= now && t.end_date > now);

    let refIdx, scanFrom;
    if (activeIdx >= 0) {
      refIdx   = activeIdx;
      scanFrom = activeIdx + 1;
    } else {
      const futureIdx = lineTasks.findIndex(t => t.start_date && t.start_date > now);
      if (futureIdx < 0) return null;

      // Idle: reference is whatever the line most recently finished running
      // (max end_date <= now), not the next future order itself — using the
      // future order as its own baseline would hide a changeover into it.
      let lastDoneIdx = -1, lastDoneEnd: Date | null = null;
      for (let i = 0; i < futureIdx; i++) {
        const t = lineTasks[i];
        if (t.start_date && t.end_date && t.end_date <= now && (!lastDoneEnd || t.end_date > lastDoneEnd)) {
          lastDoneEnd = t.end_date;
          lastDoneIdx = i;
        }
      }

      if (lastDoneIdx >= 0) {
        refIdx   = lastDoneIdx;
        scanFrom = futureIdx; // compare the next order itself against last-run product
      } else {
        refIdx   = futureIdx; // no run history — can't tell if the first order is a changeover
        scanFrom = futureIdx + 1;
      }
    }

    const ref = lineTasks[refIdx];
    for (let i = scanFrom; i < lineTasks.length; i++) {
      const t = lineTasks[i];
      if (!t.start_date) continue;
      if ((t.COLOR || '') !== (ref.COLOR || '') || (t.FORM_SIZE || '') !== (ref.FORM_SIZE || '')) {
        return t.start_date;
      }
    }
    return null;
  },

  _fmtNextCO(dt: Date | null, now: Date): string {
    if (!dt) return '—';
    const ms = dt.getTime() - now.getTime();
    if (ms <= 0) return 'now';
    const mins = Math.round(ms / Config.MS_MIN);
    if (mins < 60) return `+${mins}m`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `+${hrs}h`;
    return `+${Math.round(hrs / 24)}d`;
  },

  _renderLineStatus(): void {
    const el = document.getElementById('line-status-panel');
    if (!el) return;
    const tasks = Dashboard._filteredTasks();
    const now   = new Date();
    const esc   = (s: unknown) => String(s || '').replace(/[&<>"]/g, (c: string) => (({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]));

    const byLine: Record<string, NimbusTask[]> = {};
    for (const l of Store.linesForSelectedPlant()) byLine[l] = [];  // idle lines show up with zero rows
    for (const tk of tasks) { const l = tk.PRODUCTION_LINE || 'Unknown'; (byLine[l] ||= []).push(tk); }
    const lines = Object.keys(byLine).sort();

    if (!lines.length) {
      if (Dashboard._lsVL) { Dashboard._lsVL.destroy(); Dashboard._lsVL = null; }
      el.innerHTML = `<div class="empty-state" style="padding:24px;text-align:center;">${Util.t('empty.no_data_loaded')}</div>`;
      return;
    }

    const matrix   = Utilization.computeMatrix(now, 1, tasks);
    const todayKey = Util.dayKey(Util.startOfDay(now));

    // Pre-compute row data so renderFn is a pure template with no heavy closures.
    const rowData: DashboardLineStatusRow[] = lines.map((line): DashboardLineStatusRow => {
      const ci    = Timeline._colorIndex(line);
      const color = Config.COLORS[ci % Config.COLORS.length];
      const u = matrix[line]?.[todayKey];
      const sched   = u ? u.scheduled.toFixed(2)                         : '0.00';
      const cap     = u ? u.capacity.toFixed(2)                          : '0.00';
      const effCap  = u ? (u.effectiveCapacity ?? u.capacity).toFixed(2) : cap;
      const pct     = u ? Math.round((u.pct ?? 0) * 100)                 : 0;
      const overloadAt = u && u.capacity > 0 ? u.effectiveCapacity / u.capacity : Config.OVERLOAD_THRESHOLD;
      const sev     = u ? Utilization.sev(u.pct ?? 0, overloadAt) : 'ok';
      const barW    = Math.min(pct, 100);
      const isOver  = u ? u.scheduled > (u.effectiveCapacity ?? u.capacity) : false;
      const sorted  = byLine[line].slice().sort((a, b) => (a.start_date?.getTime() || 0) - (b.start_date?.getTime() || 0));
      const nxtCO   = Dashboard._fmtNextCO(Dashboard._nextChangeover(sorted, now), now);
      return { line, color, sched, cap, effCap, pct, sev, barW, isOver, nxtCO };
    });

    if (!Dashboard._lsVL) {
      el.innerHTML = '';
      const hdr = document.createElement('div');
      hdr.innerHTML = `<div class="ls-dot" style="visibility:hidden"></div>` +
        `<div class="ls-code">Line</div><div class="ls-hours">Hours</div>` +
        `<div class="ls-bar-wrap" style="background:none">Utilization</div>` +
        `<div class="ls-pct">%</div><div class="ls-co">Next CO</div>`;
      hdr.className = 'ls-row ls-header';
      el.appendChild(hdr);
      Dashboard._lsVL = new VirtualList<DashboardLineStatusRow>(el, {
        rowH: VL_LS_ROW_H,
        renderFn: (d: DashboardLineStatusRow) =>
          `<div class="ls-row">` +
          `<div class="ls-dot" style="background:${d.color}"></div>` +
          `<div class="ls-code">${esc(d.line)}</div>` +
          `<div class="ls-hours" title="${d.cap}h total capacity">${d.sched}/${d.effCap}h</div>` +
          `<div class="ls-bar-wrap"><div class="ls-bar${d.isOver ? ' over' : ''}" style="width:${d.barW}%;background:${d.color}"></div></div>` +
          `<div class="ls-pct${d.sev !== 'ok' ? ' ' + d.sev : ''}">${d.pct}%</div>` +
          `<div class="ls-co">${esc(d.nxtCO)}</div></div>`,
        mountEl: el,
      });
    }
    Dashboard._lsVL.update(rowData);
  },

  _renderAlertSummary(): void {
    const list = document.getElementById('alert-summary-list');
    const count = document.getElementById('alert-summary-count');
    if (!list || !count) return;

    const plantLines = new Set(Store.linesForSelectedPlant());
    const plantRow = Store.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null;
    const hz = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? null;
    const cutoff = typeof hz === 'number' ? new Date(Date.now() + hz * Config.MS_MIN) : null;
    const alerts = Store.alerts.filter(a => {
      if (a.line && !plantLines.has(a.line)) return false;
      if (Dashboard._filterLines.size > 0 && a.line && !Dashboard._filterLines.has(a.line)) return false;
      if (cutoff && a.time && a.time > cutoff) return false;
      return true;
    });

    // Sort errors first, then warnings, then info — soonest within each severity.
    const SEV_RANK: Record<string, number> = { err: 0, warn: 1, info: 2 };
    alerts.sort((a, b) => {
      const sa = SEV_RANK[a.sev] ?? 9, sb = SEV_RANK[b.sev] ?? 9;
      if (sa !== sb) return sa - sb;
      const ta = a.time ? a.time.getTime() : 0;
      const tb = b.time ? b.time.getTime() : 0;
      return ta - tb;
    });

    const errN  = alerts.filter(a => a.sev === 'err').length;
    const warnN = alerts.filter(a => a.sev === 'warn').length;
    count.textContent = errN > 0 || warnN > 0
      ? `${errN} err · ${warnN} warn · ${alerts.length} open`
      : `${alerts.length} open`;

    if (!alerts.length) { list.innerHTML = `<div class="empty-state">${Util.t('empty.no_alerts')}</div>`; return; }
    const _esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c: string) => (({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]));
    list.innerHTML = alerts.slice(0, 8).map(a => `
      <div class="alert-row sev-${a.sev}" onclick="if(NIMBUS.AlertsUIAdapter.focus){NIMBUS.AlertsUIAdapter.focus('${a.id}');}else if(a&&a.taskId){NIMBUS.App.goto('gantt');setTimeout(()=>NIMBUS.Timeline.focus('${a.taskId||''}'),200);}">          <span class="sev" data-sev="${a.sev}" aria-label="${a.sev === 'err' ? 'Error' : a.sev === 'warn' ? 'Warning' : 'Info'}"></span>
        <div class="msg">${_esc(a.msg)}</div>
        <span class="meta">${a.time ? Util.fmtDT(a.time).slice(5, 16) : ''}</span>
        <button class="dismiss" onclick="event.stopPropagation(); NIMBUS.Alerts.dismiss('${a.id}')">×</button>
      </div>
    `).join('');
    if (alerts.length > 8) {
      list.insertAdjacentHTML('beforeend',
        `<div class="alert-summary-more" onclick="NIMBUS.AlertsUIAdapter.toggleDrawer()">See all ${alerts.length} alerts →</div>`);
    }
  },

  _renderFixedList(): void {
    const list = document.getElementById('fixed-list');
    if (!list) return;
    const fixed = Dashboard._filteredTasks().filter(t => Store.isFixed(t.id));
    if (!fixed.length) { list.innerHTML = `<div class="empty-state">${Util.t('empty.no_fixed_orders')}</div>`; return; }
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
  _unfix(id: string): void {
    Store.setFixed([id], false, 'dashboard');
    Alerts.scheduleRecompute();
  },
  _gotoLine(line: string, dateStr: string): void {
    Timeline.gotoLineDay(line, dateStr);
  },

  /* ---------------------------------------------------------------------
     A1 — Projected-Lateness Risk Heatmap.
     Grid: rows = lines, cols = days. Cell = cumulative hours late vs SAP plan
     for orders finishing in that line × day cell. Cells are clickable and
     reveal a drill-down list of the contributing late orders.
     --------------------------------------------------------------------- */
  _renderLatenessHeatmap(): void {
    const container = document.getElementById('lateness-heatmap-panel');
    if (!container) return;

    const horizonDays = Dashboard._latenessHorizon || 14;
    const tasks = Dashboard._filteredTasks();
    const startKey = Util.dayKey(Util.startOfDay(new Date()));
    const endDate  = new Date(); endDate.setDate(endDate.getDate() + horizonDays - 1);
    const endKey   = Util.dayKey(Util.startOfDay(endDate));

    // Build line × day map: line → dayKey → { lateHours, lateCount, lineLabel }
    const allLines = [...new Set([...Store.linesForSelectedPlant(), ...tasks.map(t => t.PRODUCTION_LINE || 'Unknown')])].sort();
    const days: string[]  = [];
    {
      const d = Util.startOfDay(new Date())!;
      for (let i = 0; i < horizonDays; i++) {
        days.push(Util.dayKey(d));
        d.setDate(d.getDate() + 1);
      }
    }
    const cells: DashboardLatenessMatrix = {};
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
      container.innerHTML = `<div class="empty-state">${Util.t('empty.no_orders_scope')}</div>`;
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

    const idleBg  = Dashboard._cssVar('--bg-subtle', '#ecebe4');
    const amber   = Dashboard._cssVar('--warn', '#b57a0a');
    const orange  = Dashboard._cssVar('--warn-vivid', '#f39c12');
    const red     = Dashboard._cssVar('--err', '#b1362a');
    const muteTxt = Dashboard._cssVar('--fg-mute', '#6b6c73');
    const inkTxt  = Dashboard._cssVar('--fg', '#1a1b1f');
    const onTxt   = Dashboard._cssVar('--primary-fg', '#fcfbf6');
    function cellBg(h: number): string {
      if (h <= 0)  return idleBg;
      if (h <= 8)  return amber;
      if (h <= 24) return orange;
      return red;
    }
    function cellText(h: number, bg: string): string {
      if (h <= 0) return muteTxt;
      return Dashboard._relLuminance(bg) > 0.45 ? inkTxt : onTxt;
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
    const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c: string) => (({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]));
    lines.forEach((line, li) => {
      const dot = Config.COLORS[li % Config.COLORS.length];
      html += `<div class="lh-line-label" title="${esc(line)}"><span class="lh-dot" style="background:${dot}"></span><span class="lh-line-name">${esc(line)}</span></div>`;
      for (const dk of days) {
        const cell = cells[line][dk];
        const h = cell.lateHours;
        const bg = cellBg(h);
        const tc = cellText(h, bg);
        const lbl = h <= 0 ? '·' : (h < 10 ? h.toFixed(1) + 'h' : Math.round(h) + 'h');
        const title = h <= 0
          ? `${line} · ${dk} · on plan`
          : `${line} · ${dk} · ${cell.lateCount} late order${cell.lateCount === 1 ? '' : 's'} · ${h.toFixed(1)}h cumulative late`;
        // Only late cells are interactive — render those as real buttons for free
        // keyboard access; on-plan cells stay inert divs (nothing to activate).
        const tag = h > 0 ? 'button' : 'div';
        const typeAttr = h > 0 ? ' type="button"' : '';
        const click = h > 0 ? ` onclick="NIMBUS.Dashboard._latenessDrill('${esc(line)}','${dk}')"` : '';
        html += `<${tag}${typeAttr} class="lh-cell" style="background:${bg};color:${tc}" title="${esc(title)}"${click}>${lbl}</${tag}>`;
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

  _latenessDrill(line: string, dateStr: string): void {
    Dashboard._latenessDrillKey = `${line}|${dateStr}`;
    Dashboard._renderLatenessHeatmap();   // re-render so drill stays in sync
  },

  _renderLatenessDrill(cells: DashboardLatenessMatrix): void {
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
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c: string) => (({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]));
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

  _latenessDrillClear(): void {
    Dashboard._latenessDrillKey = null;
    const drill = document.getElementById('lateness-drill');
    if (drill) { drill.hidden = true; drill.innerHTML = ''; }
  },

  _jumpToOrder(id: string): void {
    NIMBUS!.App!.gotoGanttTimeline!();
    setTimeout(() => { if (Timeline && Timeline.focus) Timeline.focus(id); }, 250);
  }
};

// -- Local type declarations (CQ-1 Phase 6 Task 6 conversion; scoped to
//    Interaction) ------------------------------------------------------------

/** Interaction._trace's ring-buffer entry shape (Interaction.trace()/._log()) —
 *  a free-form debug breadcrumb, hence the index signature for whatever `data`
 *  bag a given call site passes (see _log's own {what,item}/{id,reason}/
 *  {id,newLine} shapes below). */
interface InteractionTraceEntry {
  t: number;
  type: string;
  [key: string]: unknown;
}

/** vis-timeline's 'timechange' event payload (fires at up to 60fps *during* an
 *  item drag, before the drag commits as a DataSet 'update') — distinct from
 *  NimbusVendor.VisEventProperties (the getEventProperties/'click' shape):
 *  'timechange' carries `id`/`time`/`group` directly, not `item`/`what`. See
 *  Interaction._onTimeChange. `time` is defensively typed as Date|string|number
 *  because the handler itself normalizes it (`instanceof Date` check) rather
 *  than trusting a single shape. */
interface VisTimeChangeProps {
  id: string | number;
  time: Date | string | number;
  group?: string | number | null;
}

/** vis-data DataSet 'update' event payload, narrowed to the non-null shape
 *  Interaction._onDataSetUpdate actually receives (its caller in install()
 *  already guards `!props || !props.items`) — see NimbusVendor.VisDataSet.on
 *  in types/vendor.d.ts for the raw (nullable) contract this narrows. */
type InteractionDataSetUpdateProps = { items: Array<string | number>; data?: TimelineVisItem[] };

/** vis-timeline's Timeline instance also exposes internal, UNDOCUMENTED
 *  members Interaction's marquee reaches for (on-screen item DOM boxes for
 *  hit-testing, and the scrollable-content vertical-scroll accessors) — kept
 *  separate from NimbusVendor.VisTimelineInstance in types/vendor.d.ts (which
 *  documents only the real, STABLE public API) since these are internals that
 *  could change on any vis-timeline upgrade without a version bump signal. */
interface VisInternalTimeline {
  itemSet?: { items?: Record<string, { dom?: { box?: HTMLElement } } | undefined> };
  _setScrollTop?(top: number): void;
  _getScrollTop?(): number;
}

/** One order item's on-screen rect, snapshotted once per marquee gesture (or
 *  edge-scroll tick) for cheap repeated hit-testing — see
 *  Interaction._installMarquee's refreshItemRects/_rectsIntersect. Distinct
 *  from DOMRect (MarqueeState.centerRect): this is a plain 4-number literal,
 *  not a real getBoundingClientRect() result. */
interface MarqueeRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Ctrl/Cmd+drag rubber-band selection state — one live instance while a
 *  marquee gesture is in progress (Interaction._marquee), built in
 *  _installMarquee's onPointerDown and consumed by updateOverlay/
 *  startMarqueeScroll/onPointerMove/onPointerUp. `anchorTime`/`scrollDelta`
 *  are only populated when Timeline._tl is truthy at gesture start (see
 *  onPointerDown); `itemRects` is populated lazily by refreshItemRects. */
interface MarqueeState {
  pointerId: number;
  anchorX: number;
  anchorY: number;
  centerRect: DOMRect;
  overlay: HTMLDivElement;
  baseIds: Set<string>;
  lastHits: Set<string>;
  curMouseX: number;
  curMouseY: number;
  anchorTime?: Date;
  scrollDelta?: number;
  itemRects?: Map<string, MarqueeRect>;
}

/** _onKeyDown's arrow-navigation keys (Interaction._navigateSelection). */
type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

/** `Modal.openEdit` is guarded (`typeof ... === 'function'`) at both
 *  _onDoubleClick and _onKeyDown's Enter-to-edit branch, but does not exist
 *  anywhere in the real Modal export (application-foundation.mts's Modal has
 *  only open/close/confirm) or anywhere else in the codebase — genuinely
 *  dead/vestigial code, always false at runtime today. Typed as an optional
 *  extension (not `any`) so the existing defensive guard keeps its exact
 *  behavior under strict typing. */
type ModalWithOpenEdit = typeof Modal & { openEdit?: (task: NimbusTask) => void };

/** `ContextMenu.openCanvas` — same situation as ModalWithOpenEdit above: the
 *  real ContextMenu export (this file, Task 3) has no such method; the
 *  install() contextmenu handler's own comment calls it out as "an optional
 *  extension point" that nothing implements yet. */
type ContextMenuWithOpenCanvas = typeof ContextMenu & { openCanvas?: (x: number, y: number) => void };

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

   CRITICAL / CORRECTED (CQ-1 Phase 3 Task 5 — the previous wording here claimed
   fixed-order drags are "REVERTED in the vis DataSet before it can reach the
   Store"; the new characterization tests added by this task proved that is
   NOT what `_onDataSetUpdate` actually does, so this comment is corrected to
   match the real, unchanged behavior rather than the aspiration): fixed
   orders carry no per-item `editable:false` (only blackout blocks do — see
   `_itemForBlock`), so vis-timeline lets a user actually drag one. Inside
   `_onDataSetUpdate`, the `Store.isFixed(id)` branch's `noActualChange` guard
   only distinguishes a genuine drag from a programmatic echo (Timeline.rebuild
   / _applyTaskPatch calling `_items.update()` inside `_suppressEvents`, or a
   redraw racing a drag-commit) — when the guard finds NO real change it drops
   the event, but when there IS a real change it falls through to the same
   commit path as a non-fixed drag ("Fixed items are user-draggable — fall
   through to normal update path"). In other words: today, a real drag on a
   fixed order DOES commit to the Store; only spurious no-op echoes are
   suppressed. See `tests/modules/schedule-workbench.test.mjs` and
   `docs/architecture/cq1-compatibility-inventory.md` for the tests that
   uncovered this and the full writeup. This phase preserves the behavior
   byte-for-byte (Global Constraints — no logic changes); only this stale
   comment changed.
   ========================================================================== */
export const Interaction = {
  DEBUG: false,
  DBLCLICK_SUPPRESS_MS: 300,

  _justDoubleClicked: false,
  _alertcellDelegated: false,
  _edgeScrollTrackBound: null as ((e: MouseEvent) => void) | null,
  _hideTooltipBound: null as (() => void) | null,
  _onKeyDownBound: null as ((e: KeyboardEvent) => void) | null,
  _hoverDismissBound: null as (() => void) | null,
  _labelDblclickDelegated: false,
  _isolateToastShown: false,
  _hoverPreviewDelegated: false,
  _marqueeDelegated: false,
  _dblTimer: null as ReturnType<typeof setTimeout> | null,
  _trace: [] as InteractionTraceEntry[],
  _installed: false,
  _marquee: null as MarqueeState | null,
  _marqueeRAF: null as number | null,

  // True iff the pointer strayed >~8px from its mousedown point (PEAK
  // displacement, not net endpoint displacement — see install() for why)
  // at any point since the most recent mousedown on #vis-timeline.
  // Consulted by BOTH click paths — _onClick() below, and the
  // alertcell-popup listener installed in install() — so a pan-release is
  // never treated as a real click by either. Reset only on the *next*
  // mousedown (see install()); never reset inside a click handler, so both
  // consumers see the identical verdict for one gesture. Distinct from
  // _isDragging/_lastDragEndTs (item-drag state, further down): those track
  // dragging an order block itself; mousedown on a real item never arms
  // this flag's tracker at all (see install()), so there's no overlap.
  _panDuringGesture: false,

  trace(): InteractionTraceEntry[] { return this._trace.slice(-50); },
  _log(type: string, data: Record<string, unknown>): void {
    const entry: InteractionTraceEntry = { t: Date.now(), type, ...data };
    this._trace.push(entry);
    if (this._trace.length > 200) this._trace.shift();
    // Always feed the lightweight breadcrumb ring (attached to error-level entries
    // for postmortem context) — independent of the verbose DEBUG console log.
    ErrorLog.breadcrumb(type, data);
    if (this.DEBUG) ErrorLog.info('interaction', type, data);
  },

  install(): void {
    if (this._installed) return;
    if (!Timeline._tl) {
      // Timeline not ready yet — retry shortly. Bootstrap calls us after
      // Timeline.init() so this path is only hit in edge cases.
      setTimeout(() => Interaction.install(), 50);
      return;
    }
    this._installed = true;

    /* ----- click: modifier keys, background clear, multi-select ---------- */
    Timeline._tl.on('click', props => Interaction._onClick(props as NimbusVendor.VisEventProperties));

    /* ----- alert-cell click: use vis-timeline's coordinate-mapping API
       (getEventProperties) instead of DOM-target matching. Background items
       render in .vis-background, but .vis-foreground .vis-group z-stacks
       above and intercepts e.target — so closest('.vis-item.alertcell-*')
       never matches. getEventProperties maps any DOM click to {group, time}
       regardless of which DIV was hit; we then look up the alertcell- item
       in the DataSet. */
    // Pan-vs-click disambiguation, shared by this listener AND _onClick():
    // canvas panning is 100% native vis-timeline (Hammer.js `moveable`) — no
    // custom pan code exists — so we can't tell "a pan that ended here" apart
    // from a real click using the click event alone.
    //
    // Interaction._panDuringGesture is set from PEAK pointer displacement:
    // the largest distance the pointer strays from its mousedown point at
    // ANY point during the gesture, not the net mousedown->mouseup endpoint
    // distance. Net-endpoint tracking (the first cut of this fix, shipped
    // in nimbus:v22) missed "pan right, then drift back near the start
    // before releasing" — a normal settle-the-view gesture — because the
    // net displacement lands back under threshold even though a real pan
    // happened. Peak displacement catches that directly: a pan-and-return
    // still peaks at the full pan distance.
    //
    // v22 also tried to backstop that gap with a second signal — a
    // vis-timeline `rangechange` listener gated on `byUser:true` — which
    // had to be reverted: vis-timeline's Hammer pan recognizer is
    // configured `{threshold: 5, direction: DIRECTION_ALL}` (any-direction,
    // 5px) and `Range._onDrag` emits `rangechange{byUser:true}` on every
    // recognized panmove with no magnitude check of its own, so a click
    // with a few px of incidental hand jitter — routine on touchpads, not
    // rare with a mouse — nudged the view a hair and got flagged as a pan,
    // silently swallowing real clicks almost entirely. Wheel/pinch zoom
    // also emit `rangechange{byUser:true}` (confirmed in vis-timeline's
    // Range.js `zoom()`), and touchpad inertial scrolling streams wheel
    // events for up to ~1s after fingers lift — long enough to land
    // between an unrelated click's mousedown and its click, wrongly
    // suppressing it. Peak-displacement alone covers the case rangechange
    // was added for, so rangechange was removed rather than tuned.
    //
    // Threshold is 8px (peak, any direction) — comfortably above sloppy-
    // click jitter, far below any real pan (which peaks in the tens to
    // hundreds of px).
    const _tlContainer = document.getElementById('vis-timeline');
    if (_tlContainer && !Interaction._alertcellDelegated) {
      Interaction._alertcellDelegated = true;
      let _downX: number | null = null, _downY: number | null = null;

      _tlContainer.addEventListener('mousedown', e => {
        // New gesture starting: clear the previous gesture's verdict. Must
        // happen here (not in a click handler) so both click consumers of
        // this flag see an unconsumed verdict for the CURRENT gesture.
        Interaction._panDuringGesture = false;
        const p = Timeline._tl && Timeline._tl.getEventProperties(e);
        const onRealItem = p && p.item != null && !String(p.item).startsWith('alertcell-');
        if (onRealItem) {
          // Mousedown started on an order item — this is an item-drag
          // gesture, not a canvas pan. Don't arm the peak tracker: order
          // drags routinely exceed 8px and must not be mistaken for a
          // canvas pan (that would wrongly suppress the trailing click's
          // Selection.set after a drag). Mirrors the alertcell-id-prefix
          // check in the click handler below.
          _downX = _downY = null;
        } else {
          _downX = e.clientX; _downY = e.clientY;
        }
      });

      // Peak-displacement check: fires on every mousemove while armed
      // (_downX !== null), settles the verdict the moment the pointer
      // strays past threshold, then disarms itself so the rest of the
      // gesture's mousemoves are a single cheap null-check.
      _tlContainer.addEventListener('mousemove', e => {
        if (_downX === null || _downY === null) return; // not armed — no mousedown captured, or started on an item
        const dx = e.clientX - _downX, dy = e.clientY - _downY;
        if ((dx * dx + dy * dy) > 64) {
          Interaction._panDuringGesture = true;
          _downX = _downY = null; // verdict settled — stop tracking for this gesture
        }
      });

      // mouseup just disarms — the verdict (if any) was already settled by
      // mousemove. Keeps the "armed == button currently held" invariant so
      // a stray mousemove after release can't retroactively set the flag.
      _tlContainer.addEventListener('mouseup', () => {
        _downX = _downY = null;
      });

      _tlContainer.addEventListener('click', e => {
        if (!Timeline._tl) return;
        if (Interaction._panDuringGesture) return; // panned during this gesture — not a real click
        const p = Timeline._tl.getEventProperties(e);
        if (!p || !p.group || !p.time) return;
        // If the click is on a real foreground item (an order), let normal
        // selection handle it — don't hijack order clicks because the cell
        // happens to be tinted.
        if (p.item && !String(p.item).startsWith('alertcell-')) return;
        const dayKey = Util.dayKey(p.time);
        const cellId = `alertcell-${p.group}-${dayKey}`;
        if (!Timeline._items!.get(cellId)) return; // no alert highlight here
        NIMBUS!.AlertsUIAdapter!.showForCell!(String(p.group), dayKey);
      });
    }

    /* ----- doubleClick: focus + edit ------------------------------------- */
    Timeline._tl.on('doubleClick', props => Interaction._onDoubleClick(props as NimbusVendor.VisEventProperties));

    /* ----- context menu -------------------------------------------------- */
    const container = document.getElementById('vis-timeline');
    if (container) {
      container.addEventListener('contextmenu', e => {
        const p = Timeline._tl!.getEventProperties(e);
        e.preventDefault();
        if (p.what === 'item' && p.item != null) {
          const id = String(p.item);
          // If right-click target is not currently selected, replace selection with it.
          if (!Selection.has(id)) Selection.set([id]);
          if (ContextMenu && typeof ContextMenu.open === 'function') {
            ContextMenu.open(e.clientX, e.clientY, id);
          }
        } else if (ContextMenu && typeof (ContextMenu as ContextMenuWithOpenCanvas).openCanvas === 'function') {
          // Canvas context menu — optional extension point.
          (ContextMenu as ContextMenuWithOpenCanvas).openCanvas!(e.clientX, e.clientY);
        }
      });
    }

    /* ----- DataSet 'update' — drag commit only, no cascade on zoom ------ */
    Timeline._items!.on('*', (event, props) => {
      if (Timeline._suppressEvents) return;
      if (event !== 'update' || !props || !props.items) return;
      Interaction._onDataSetUpdate(props);
    });

    /* ----- Multi-drag ghost preview via timechange ----------------------- */
    Timeline._tl.on('timechange', props => Interaction._onTimeChange(props as VisTimeChangeProps));
    Timeline._tl.on('timechanged', ()   => Interaction._clearGhosts());

    /* ----- Track mouse X for edge-scroll during order drag --------------- */
    // Named + stored (not an inline arrow) so uninstall() can remove it.
    this._edgeScrollTrackBound = (e: MouseEvent) => {
      if (Interaction._isDragging) Interaction._dragMouseX = e.clientX;
    };
    document.addEventListener('mousemove', this._edgeScrollTrackBound);

    /* ----- Hide tooltip when mouse leaves the browser window ------------- */
    // Named + stored (not an inline arrow) so uninstall() can remove it.
    this._hideTooltipBound = () => {
      const tip = document.querySelector('.vis-tooltip') as HTMLElement | null;
      if (tip) tip.style.display = 'none';
    };
    document.addEventListener('mouseleave', this._hideTooltipBound);

    /* ----- keyboard ------------------------------------------------------ */
    // Named + stored (not an inline arrow) so uninstall() can remove it.
    this._onKeyDownBound = (e: KeyboardEvent) => Interaction._onKeyDown(e);
    document.addEventListener('keydown', this._onKeyDownBound);

    /* ----- Selection → vis-timeline + Inspector sync (one-way, write) --- */
    Selection.on(evt => {
      Timeline._suppressEvents = true;
      try { Timeline._tl!.setSelection(evt.ids); }
      finally { Timeline._suppressEvents = false; }

      // Preserve the original UX: opening the right sidebar when a single
      // order is selected. (This used to live in Timeline.init's select
      // handler; we moved it here so it fires off Selection, not off vis.)
      if (evt.ids.length >= 1) {
        const rs = document.getElementById('right-sidebar');
        if (rs && rs.classList.contains('collapsed')) {
          rs.classList.remove('collapsed');
          setTimeout(() => { Timeline.redraw(); TimelineNav.render(); }, Config.ANIM_MS);
        }
      }

      // Drive the Inspector from selection count.
      if (evt.ids.length === 0) {
        Inspector.clear();
        const rs = document.getElementById('right-sidebar');
        if (rs && !rs.classList.contains('collapsed')) {
          rs.classList.add('collapsed');
          setTimeout(() => { Timeline.redraw(); TimelineNav.render(); }, Config.ANIM_MS);
        }
      } else if (evt.ids.length === 1) {
        const id = evt.ids[0];
        const t = Store.tasks[id] ?? Store.tasksArr.find(task => String(task.id) === id);
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
   * Reverses everything install() attaches: the 4 document-level listeners
   * (2 distinct 'keydown' listeners — _onKeyDownBound for keyboard shortcuts,
   * _hoverDismissBound for the hover-preview card — plus 'mousemove' for
   * edge-scroll tracking and 'mouseleave' for tooltip hiding) and cancels any
   * live RAF loop (_marqueeRAF, _edgeScrollRAF).
   *
   * New in CQ-1 Phase 3 Task 5 — purely additive, unwired-but-real teardown
   * machinery. Nothing calls this yet: Gantt Timeline's lifecycle stays
   * mount-once/show-hide (see docs/architecture/cq1-compatibility-inventory.md
   * §2), which never unmounts, so there is no real trigger to wire it to
   * today. It exists so a future unmount path (or a test) has a correct,
   * tested teardown to call rather than inventing one from scratch.
   *
   * Deliberately NOT reversed here: the container-scoped listeners bound to
   * #vis-timeline (click/contextmenu/pointerdown &c. in install(),
   * _installMarquee(), _installLabelDblclick(), _installHoverPreview()) and
   * the vis-timeline/DataSet subscriptions (Timeline._tl.on/_items.on) — vis-
   * timeline itself is never torn down under the mount-once/show-hide
   * lifecycle, so removing listeners bound to a container that outlives every
   * install()/uninstall() cycle isn't part of this phase's scope (see Task 5's
   * plan step 3). Each of those three installers (plus the alertcell-
   * delegation block above) now guards itself with its own `_*Delegated`
   * flag — none reset by uninstall() — so a future install()/uninstall()/
   * install() cycle attaches each container-scoped listener at most once
   * instead of double-attaching it on reinstall.
   */
  uninstall(): void {
    if (!this._installed) return;
    // Non-null: install() always sets all four together before _installed
    // flips true, and nothing else clears them individually.
    document.removeEventListener('keydown', this._onKeyDownBound!);
    document.removeEventListener('keydown', this._hoverDismissBound!);
    document.removeEventListener('mousemove', this._edgeScrollTrackBound!);
    document.removeEventListener('mouseleave', this._hideTooltipBound!);
    if (this._marqueeRAF) { cancelAnimationFrame(this._marqueeRAF); this._marqueeRAF = null; }
    if (this._edgeScrollRAF) { cancelAnimationFrame(this._edgeScrollRAF); this._edgeScrollRAF = null; }
    this._installed = false;
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
  _installLabelDblclick(): void {
    const container = document.getElementById('vis-timeline');
    if (!container || Interaction._labelDblclickDelegated) return;
    Interaction._labelDblclickDelegated = true;

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
        Toast.show(Util.t('toast.isolated_line', { line: groupId }), 'info');
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
  _installHoverPreview(): void {
    const container = document.getElementById('vis-timeline');
    if (!container) return;

    const SKIP_PREFIXES = ['blk-', 'past-zone-', 'alert-horizon-zone-', 'alertcell-'];
    const isOrderId = (id: string): boolean => !SKIP_PREFIXES.some(p => String(id).startsWith(p));

    let _cardEl = document.getElementById('nimbus-hover-card') as HTMLDivElement | null;
    if (!_cardEl) {
      _cardEl = document.createElement('div');
      _cardEl.id = 'nimbus-hover-card';
      _cardEl.hidden = true;
      document.body.appendChild(_cardEl);
    }
    const card: HTMLDivElement = _cardEl;

    let showTimer: ReturnType<typeof setTimeout> | null = null;
    let activeId: string | null = null;
    let lastX = 0, lastY = 0;

    const HOVER_DELAY_MS = 500;
    const OFFSET_X = 16, OFFSET_Y = 18;

    const reposition = (): void => {
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

    const renderCard = (id: string): string => {
      const t = Store.tasks[id];
      if (!t) return '';
      const esc = (s: unknown) => String(s == null ? '' : s).replace(/[&<>"']/g, (c: string) => (({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' } as Record<string, string>)[c]));
      const qty = t['ORDER_QUANTITY_(GMEIN)'] ?? '—';
      const run = Util.runHours(t);
      const line = t.PRODUCTION_LINE || '—';
      const color = t.COLOR || '—';
      const form  = t.FORM_SIZE || '—';
      const startStr = t.start_date ? Util.fmtDTReadable(t.start_date) : '—';
      const endStr   = t.end_date   ? Util.fmtDTReadable(t.end_date)   : '—';
      const orderNo  = t.ORDER || t.PRODUCTION_ORDER || t.text || t.id;
      const matDesc  = t.MATERIAL_DESCRIPTION || t.text || '';
      const rel = Store.alertsByTask().get(String(id)) || [];
      const alertsHtml = rel.length
        ? `<div class="hov-alerts">⚐ ${rel.length} alert${rel.length === 1 ? '' : 's'}: ${
            rel.slice(0, 3).map(a => (a.type || a.sev || '')).filter(Boolean).join(', ')
          }${rel.length > 3 ? '…' : ''}</div>`
        : '';
      const fixedBadge = Store.isFixed(id)
        ? `<span class="hov-fixed">🔒 fixed</span>` : '';

      return `
        <div class="hov-title">${esc(orderNo)} ${fixedBadge}</div>
        <div class="hov-mat">${esc(matDesc)}</div>
        <div class="hov-grid">
          <span>Qty</span><span>${esc(qty)}</span>
          <span>Run</span><span>${run.toFixed(2)} h</span>
          <span>Line</span><span>${esc(line)}</span>
          <span>Color</span><span>${esc(color)}</span>
          <span>Form</span><span>${esc(form)}</span>
        </div>
        <div class="hov-dates">${startStr} → ${endStr}</div>
        ${alertsHtml}
      `;
    };

    const hide = (): void => {
      clearTimeout(showTimer ?? undefined);
      showTimer = null;
      activeId  = null;
      card.hidden = true;
    };

    // Container-scoped listeners (the vis-timeline itemover/itemout subscriptions
    // and the container's own mousemove/mousedown/wheel) must only ever be wired
    // once — install()/uninstall()/install() must not double-attach these (they
    // are never torn down by uninstall(), unlike the document-level keydown
    // dismiss listener below).
    if (!Interaction._hoverPreviewDelegated) {
      Interaction._hoverPreviewDelegated = true;

      Timeline._tl!.on('itemover', (rawProps: unknown) => {
        const props = rawProps as NimbusVendor.VisEventProperties | null;
        if (!props || props.item == null) return;
        const id = String(props.item);
        if (!isOrderId(id)) return;
        // Suppress during active drag or marquee — the user is doing something.
        if (Interaction._isDragging || Interaction._marquee) return;

        clearTimeout(showTimer ?? undefined);
        activeId = id;
        showTimer = setTimeout(() => {
          if (activeId !== id) return;
          if (Interaction._isDragging || Interaction._marquee) return;
          card.innerHTML = renderCard(id);
          card.hidden = false;
          reposition();
        }, HOVER_DELAY_MS);
      });

      Timeline._tl!.on('itemout', (rawProps: unknown) => {
        const props = rawProps as NimbusVendor.VisEventProperties | null;
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
    }

    // Stored (not passed inline) so uninstall() can remove it — this is a
    // SEPARATE document-level 'keydown' listener from install()'s own
    // _onKeyDownBound above; both must be individually removed.
    Interaction._hoverDismissBound = hide;
    document.addEventListener('keydown', Interaction._hoverDismissBound);
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
  _installMarquee(): void {
    const container = document.getElementById('vis-timeline');
    if (!container || Interaction._marqueeDelegated) return;
    Interaction._marqueeDelegated = true;

    const SKIP_PREFIXES = ['blk-', 'past-zone-', 'alert-horizon-zone-', 'alertcell-'];
    const isOrderId = (id: string): boolean => !SKIP_PREFIXES.some(p => id.startsWith(p));

    const _rectsIntersect = (a: MarqueeRect, b: MarqueeRect): boolean =>
      !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);

    const centerOf = (): Element | null => container.querySelector('.vis-panel.vis-center');

    // Returns the anchor's current screen Y by accumulating the actual
    // scroll delta from each _setScrollTop call. Avoids getBCR() entirely
    // because dom.center.style.transform is set in _redraw() which fires
    // asynchronously — reading BCR right after _setScrollTop always sees
    // the stale pre-scroll position.
    const getAnchorScreenY = (): number => {
      const s = Interaction._marquee;
      if (!s) return 0;
      return s.anchorY + (s.scrollDelta || 0);
    };

    // Returns the anchor's current screen X by projecting anchorTime through
    // the live timeline window — so the selection box left edge stays pinned
    // to the same calendar moment even as the view pans during edge-scroll.
    const getAnchorScreenX = (cr: DOMRect): number => {
      const s = Interaction._marquee;
      const tl = Timeline._tl;
      if (!s || !tl || !s.anchorTime) return s ? s.anchorX : 0;
      const w = tl.getWindow();
      const spanMs = w.end.getTime() - w.start.getTime();
      if (spanMs <= 0) return s.anchorX;
      const frac = (s.anchorTime.getTime() - w.start.getTime()) / spanMs;
      return cr.left + frac * (cr.right - cr.left);
    };

    // Snapshot every order item's on-screen rect once. Re-taken on edge-scroll
    // (items move) but reused across plain pointermove frames, so the hit-test no
    // longer calls getBoundingClientRect() per item per frame (R18 — layout thrash).
    const refreshItemRects = (s: MarqueeState): void => {
      const tlInternal = Timeline._tl as unknown as VisInternalTimeline | null;
      const itemSet = tlInternal?.itemSet?.items;
      const m = new Map<string, MarqueeRect>();
      if (itemSet) {
        for (const id of Object.keys(itemSet)) {
          if (!isOrderId(id)) continue;
          const box = itemSet[id]?.dom?.box;
          if (!box) continue;
          const b = box.getBoundingClientRect();
          m.set(id, { left: b.left, right: b.right, top: b.top, bottom: b.bottom });
        }
      }
      s.itemRects = m;
    };

    // Shared overlay + hit-test update — called from both pointermove and the
    // edge-scroll RAF so selection expands as the view pans.
    const updateOverlay = (mx: number, my: number): void => {
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

      const rect: MarqueeRect = { left, right, top, bottom };
      if (!s.itemRects) refreshItemRects(s);

      const hits = new Set<string>();
      for (const [id, r] of s.itemRects!) {
        if (_rectsIntersect(rect, r)) hits.add(id);
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
    const startMarqueeScroll = (): void => {
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
        const tlInternal = tl as unknown as VisInternalTimeline | null;
        let vfraction = 0;
        if (my < cr.top + ZONE)         vfraction = -((cr.top + ZONE - my) / ZONE);
        else if (my > cr.bottom - ZONE) vfraction =  (my - (cr.bottom - ZONE)) / ZONE;
        if (vfraction !== 0 && tlInternal?._setScrollTop) {
          const before = tlInternal._getScrollTop ? tlInternal._getScrollTop() : 0;
          tlInternal._setScrollTop(before - vfraction * MAX_VPXL);
          const after = tlInternal._getScrollTop ? tlInternal._getScrollTop() : before;
          s.scrollDelta = (s.scrollDelta ?? 0) + (after - before);
          scrolled = true;
        }

        if (scrolled) { refreshItemRects(s); updateOverlay(s.curMouseX, s.curMouseY); }
        Interaction._marqueeRAF = requestAnimationFrame(tick);
      };
      Interaction._marqueeRAF = requestAnimationFrame(tick);
    };

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const center = centerOf();
      if (!center || !center.contains(e.target as Node | null)) return;
      // Don't hijack presses that land on a foreground item or label — those
      // are handled by vis (drag-item) and our click handler (Ctrl+click).
      // Background items (past-zone, alert-horizon-zone, alertcell) also
      // carry .vis-item but live in .vis-background; they must not block.
      const target = e.target as Element | null;
      if (target?.closest('.vis-foreground .vis-item')) return;
      if (target?.closest('.vis-labelset')) return;

      e.stopPropagation();
      e.preventDefault();
      try { container.setPointerCapture(e.pointerId); } catch {}

      const overlay = document.createElement('div');
      overlay.className = 'nimbus-marquee';
      center.appendChild(overlay);

      const cr = center.getBoundingClientRect();
      const marquee: MarqueeState = {
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
      Interaction._marquee = marquee;

      // Pin the anchor in timeline-time (X) and scroll-space (Y) so the box
      // expands correctly in both directions during edge-scroll.
      const tl = Timeline._tl;
      if (tl) {
        const w = tl.getWindow();
        const spanMs = w.end.getTime() - w.start.getTime();
        const crWidth = cr.right - cr.left;
        const frac = crWidth > 0 ? (e.clientX - cr.left) / crWidth : 0;
        marquee.anchorTime = new Date(w.start.getTime() + frac * spanMs);
        marquee.scrollDelta = 0;
      }

      refreshItemRects(marquee);
      startMarqueeScroll();
    };

    const onPointerMove = (e: PointerEvent): void => {
      const s = Interaction._marquee;
      if (!s || e.pointerId !== s.pointerId) return;
      s.curMouseX = e.clientX;
      s.curMouseY = e.clientY;
      updateOverlay(e.clientX, e.clientY);
    };

    const onPointerUp = (e: PointerEvent): void => {
      const s = Interaction._marquee;
      if (!s || e.pointerId !== s.pointerId) return;
      try { container.releasePointerCapture(s.pointerId); } catch {}
      s.overlay.remove();
      Interaction._marquee = null;
      cancelAnimationFrame(Interaction._marqueeRAF!);
      Interaction._marqueeRAF = null;
    };

    container.addEventListener('pointerdown',  onPointerDown, true);
    container.addEventListener('pointermove',  onPointerMove, true);
    container.addEventListener('pointerup',    onPointerUp,   true);
    container.addEventListener('pointercancel', onPointerUp,  true);
  },

  _onClick(props: NimbusVendor.VisEventProperties): void {
    this._log('click', { what: props.what, item: props.item });

    // If a double-click just fired, swallow this follow-up select.
    if (this._justDoubleClicked) return;

    // If the user panned/zoomed the canvas at any point since the mousedown
    // behind this click, this isn't a real click on whatever it landed on —
    // it's just the release-point of a pan gesture. Swallow it entirely
    // (same signal the alertcell-popup listener in install() consults) so
    // panning never re-selects an order, clears the current selection, or
    // re-centers via CENTER_ON_CLICK below. See _panDuringGesture's
    // declaration for how the flag is set/reset.
    if (this._panDuringGesture) return;

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
    // Skip the auto-center pan during / right after a drag. focus() pans the viewport,
    // which fires rangechanged → _visItems.refresh() (a DataView re-filter) and visually
    // reverts a just-dropped order. A genuine standalone click (no recent drag) still centers.
    if (Config.CENTER_ON_CLICK && !shift && !meta && Timeline._tl
        && !Interaction._isDragging
        && (Date.now() - (Interaction._lastDragEndTs || 0)) > 400) {
      // zoom:false → pan only; preserves the current time window width.
      Timeline._tl.focus(String(id), { animation: { duration: 300 }, zoom: false });
    }
    // --- END center-on-click ---

    // Highlight the dependency chain for this task
    if (typeof DependencyOverlay !== 'undefined') DependencyOverlay.highlightChain(id);
  },

  _onDoubleClick(props: NimbusVendor.VisEventProperties): void {
    this._log('doubleClick', { what: props.what, item: props.item });
    if (props.what !== 'item' || props.item == null) return;

    this._justDoubleClicked = true;
    clearTimeout(this._dblTimer ?? undefined);
    this._dblTimer = setTimeout(() => { this._justDoubleClicked = false; },
                                this.DBLCLICK_SUPPRESS_MS);

    const id = String(props.item);
    if (id.startsWith('blk-')) return;
    const t = Store.tasks[id];
    if (!t) return;

    Selection.set([id]);
    // Double-click action: focus-zoom AND open the full edit modal (if present).
    if (typeof Timeline.focus === 'function') Timeline.focus(id);
    if (Modal && typeof (Modal as ModalWithOpenEdit).openEdit === 'function') (Modal as ModalWithOpenEdit).openEdit!(t);
  },

  /** Drag commit: update the store and reflow ONLY if times/line actually changed.
   *  Fixed orders: only a spurious no-op echo (`noActualChange`) is dropped —
   *  a genuine drag on a fixed order still commits (see the corrected header
   *  comment above; CQ-1 Phase 3 Task 5). */
  _onDataSetUpdate(props: InteractionDataSetUpdateProps): void {
    for (const rawId of props.items) {
      const id = String(rawId);
      const v = Timeline._items!.get(id) as TimelineVisItem | null;
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

      // Stamp drag-recency so a trailing vis 'click' at drag-end can't trigger the
      // CENTER_ON_CLICK focus() pan that would revert this commit (see _onClick).
      this._lastDragEndTs = Date.now();

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
        // (skippedFixed stays empty today — selIds above already excludes fixed
        // tasks — but is preserved as-is; not this task's scope to remove.)
        const skippedFixed: string[] = [];
        const companionPatches: Array<{ id: string; changes: Partial<NimbusTask> }> = [];
        for (const sid of selIds) {
          const st = Store.tasks[sid];
          if (!st || !st.start_date) continue;
          const sNewStart = new Date(st.start_date.getTime() + deltaMs);
          const sNewEnd   = new Date(st.end_date  ? st.end_date.getTime() + deltaMs : sNewStart.getTime() + Util.runHours(st) * Config.MS_HOUR);
          const sNewLine  = lineMoved ? newLine : (st.PRODUCTION_LINE || 'Unknown');
          companionPatches.push({ id: sid, changes: { start_date: sNewStart, end_date: sNewEnd, PRODUCTION_LINE: sNewLine } });

          // Update the vis item too
          Timeline._suppressEvents = true;
          try {
            Timeline._items!.update({ id: sid, start: sNewStart, end: sNewEnd, group: sNewLine });
          } finally { Timeline._suppressEvents = false; }
        }
        if (companionPatches.length) Store.updateMany(companionPatches, 'timeline');

        if (skippedFixed.length) Toast.show(Util.t('toast.fixed_count_not_moved', { count: skippedFixed.length }), 'warn');

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

  _ghostDragId: null as string | null,
  _edgeScrollRAF: null as number | null,
  _isDragging: false,
  _lastDragEndTs: 0,          // ms of the last committed drag; gates CENTER_ON_CLICK auto-center
  _dragMouseX: null as number | null,

  _startEdgeScroll(): void {
    if (this._edgeScrollRAF) return;
    const tick = () => {
      if (!Interaction._isDragging) { Interaction._edgeScrollRAF = null; return; }
      const tl   = Timeline._tl;
      const rect = document.querySelector('#vis-timeline')!.getBoundingClientRect();
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
        const w = tl!.getWindow();
        const spanMs = w.end.getTime() - w.start.getTime();
        const shiftMs = fraction * MAX_SPEED * spanMs;
        tl!.setWindow(
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
  _onTimeChange(props: VisTimeChangeProps): void {
    if (!props || !props.id || Timeline._suppressEvents) return;
    const dragId = String(props.id);
    if (dragId.startsWith('blk-')) return;

    this._isDragging = true;
    this._startEdgeScroll();

    const _tip = document.querySelector('.vis-tooltip') as HTMLElement | null;
    if (_tip) _tip.style.display = 'none';

    const selIds = Selection.ids().filter(sid => sid !== dragId);
    if (!selIds.length) return;

    const t = Store.tasks[dragId];
    if (!t || !t.start_date) return;
    const dragMs = (props.time instanceof Date ? props.time : new Date(props.time)).getTime();
    const deltaMs = dragMs - t.start_date.getTime();

    this._ghostDragId = dragId;
    const updates: Array<Partial<TimelineVisItem> & { id: string }> = [];

    // Pre-bucket non-selected, datable tasks by line ONCE per frame (R19) — the old
    // code re-scanned all of Store.tasksArr for every selected companion, i.e.
    // O(selected × allTasks) per 60fps frame. Selection (drag id + companions) is
    // excluded up front so the per-companion check is just an overlap test.
    const selSet = new Set(Selection.ids().map(String));
    const peersByLine = new Map<string, NimbusTask[]>();
    for (const peer of Store.tasksArr) {
      if (selSet.has(String(peer.id))) continue;
      if (!peer.start_date || !peer.end_date) continue;
      const pl = peer.PRODUCTION_LINE || 'Unknown';
      let arr = peersByLine.get(pl);
      if (!arr) peersByLine.set(pl, arr = []);
      arr.push(peer);
    }

    for (const sid of selIds) {
      const st = Store.tasks[sid];
      if (!st || !st.start_date) continue;
      const ghostStart = new Date(st.start_date.getTime() + deltaMs);
      const ghostEnd   = st.end_date ? new Date(st.end_date.getTime() + deltaMs) : ghostStart;
      const item = Timeline._items!.get(sid) as TimelineVisItem | null;
      if (!item) continue;

      // Check for ghost collisions with non-selected tasks on same line.
      const line = st.PRODUCTION_LINE || 'Unknown';
      const peers = peersByLine.get(line) || [];
      const hasConflict = peers.some((peer) =>
        ghostStart < peer.end_date! && ghostEnd > peer.start_date!
      );

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
      try { Timeline._items!.update(updates); }
      finally { Timeline._suppressEvents = false; }
    }
  },

  /** Clear ghost states from all companion items after drag ends. */
  _clearGhosts(): void {
    this._isDragging = false;
    if (this._edgeScrollRAF) { cancelAnimationFrame(this._edgeScrollRAF); this._edgeScrollRAF = null; }

    const _tip = document.querySelector('.vis-tooltip') as HTMLElement | null;
    if (_tip) _tip.style.display = '';

    const updates: Array<Partial<TimelineVisItem> & { id: string }> = [];
    for (const sid of Selection.ids()) {
      const item = Timeline._items!.get(sid) as TimelineVisItem | null;
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
      try { Timeline._items!.update(updates); }
      finally { Timeline._suppressEvents = false; }
    }
    this._ghostDragId = null;
  },

  _onKeyDown(e: KeyboardEvent): void {
    // Ignore when typing in inputs.
    const target = e.target as HTMLElement | null;
    const tag = (target && target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

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
      if (t && Modal && typeof (Modal as ModalWithOpenEdit).openEdit === 'function') {
        e.preventDefault();
        (Modal as ModalWithOpenEdit).openEdit!(t);
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

  _unscheduleSelected(): void {
    const ids = Selection.ids().filter(id => !Store.isFixed(id));
    if (!ids.length) { Toast.show(Util.t('toast.unschedule_all_fixed'), 'warn'); return; }
    const snap = UndoStack.snapshotTasks(ids);
    const patches = ids.map(id => ({ id, changes: { start_date: null, end_date: null } }));
    Store.updateMany(patches, 'interaction');
    UndoStack.push(`Unschedule ${ids.length} order(s)`,
                   () => UndoStack.restoreTasks(snap));
    Toast.show(Util.t('toast.unscheduled_orders', { count: ids.length }), 'success');
  },

  _navigateSelection(key: ArrowKey): void {
    const currentId = Selection.ids()[0];
    const cur = Store.tasks[currentId];
    if (!cur || !cur.start_date) return;

    const allLines = [...new Set(Store.tasksArr
      .filter(t => t.PRODUCTION_LINE)
      .map(t => t.PRODUCTION_LINE))].sort();

    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const peers = Store.tasksArr
        .filter(t => t.PRODUCTION_LINE === cur.PRODUCTION_LINE && t.start_date)
        .sort((a, b) => a.start_date!.getTime() - b.start_date!.getTime());
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
      candidates.sort((a, b) => Math.abs(a.start_date!.getTime() - cur.start_date!.getTime())
                              - Math.abs(b.start_date!.getTime() - cur.start_date!.getTime()));
      Selection.set([String(candidates[0].id)]);
    }
  },

  /** Replaces the single-task Inspector with a multi-selection summary view. */
  _showMultiInspector(): void {
    const panel = document.querySelector('#right-sidebar .inspector-body, #inspector-body');
    if (!panel) return;
    const s = Selection.stats();
    panel.innerHTML = `
      <div class="multi-select-panel" style="padding:12px;">
        <div style="font-size:20px;font-weight:700;margin-bottom:8px;">
          ${Util.t('ui.orders_selected', { count: s.count })}
        </div>
        <div style="font-size:13px;color:#666;margin-bottom:12px;">
          ${Util.fmtHours(s.totalHours)} total run-time · ${s.lines.length} line${s.lines.length === 1 ? '' : 's'}
          ${s.fixedCount ? ` · ${s.fixedCount} fixed` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button class="btn btn-ghost" data-action="fix">${Util.t('btn.fix_all')}</button>
          <button class="btn btn-ghost" data-action="unfix">${Util.t('btn.unfix_all')}</button>
          <button class="btn btn-ghost" data-action="unschedule">${Util.t('btn.unschedule_all')}</button>
          <button class="btn btn-ghost" data-action="clear">${Util.t('btn.clear_selection')}</button>
        </div>
      </div>`;
    // Real listeners, not inline onclick strings (CQ-1 Phase 3 Task 5 — this
    // panel's three inline handlers were the one concrete instance of the
    // phase's "migrate inline handlers to owned listeners" mandate; a fourth,
    // `_unscheduleSelected()`'s clear-selection sibling, was found alongside
    // them during Task 5's own re-verification of the plan against the real
    // code and converted the same way).
    panel.querySelector('[data-action="fix"]')?.addEventListener('click', () => Interaction._bulkFix(true));
    panel.querySelector('[data-action="unfix"]')?.addEventListener('click', () => Interaction._bulkFix(false));
    panel.querySelector('[data-action="unschedule"]')?.addEventListener('click', () => Interaction._unscheduleSelected());
    panel.querySelector('[data-action="clear"]')?.addEventListener('click', () => Selection.clear());
  },

  _bulkFix(fixed: boolean): void {
    const ids = Selection.ids();
    if (!ids.length) return;
    Store.setFixed(ids, fixed, 'interaction');
    this._showMultiInspector();
  },

  _wireTableSync(): void {
    // Selection → Table: when selection changes, highlight rows in AG Grid.
    Selection.on(evt => {
      if (!Table || !Table._api) return;
      try {
        Table._suppressSelectionEcho = true;
        Table._api.deselectAll();
        Table._api.forEachNode((rawNode) => {
          const node = rawNode as AgGridRowNode;
          if (node.data && evt.ids.includes(String(node.data.id))) {
            node.setSelected(true, false);
          }
        });
      } catch (e: unknown) {
        ErrorLog.warn('interaction', `Table sync failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        Table._suppressSelectionEcho = false;
      }
    });

    // Table → Selection: if AG Grid's selection changes from user action, mirror it.
    if (Table && Table._api && typeof Table._api.addEventListener === 'function') {
      Table._api.addEventListener('selectionChanged', () => {
        if (Table._suppressSelectionEcho) return;
        const rows = Table._api!.getSelectedRows() as NimbusTask[];
        const ids = rows.map((r) => String(r.id));
        const current = new Set(Selection.ids());
        const same = ids.length === current.size && ids.every((id) => current.has(id));
        if (!same) Selection.set(ids);
      });
    }
  }
};

/* =============================================================================
   OPTIMIZE DIALOG — time-window & strategy picker for Engine.runAndApply
   ========================================================================== */
// -- Local type declarations (CQ-1 Phase 6 Task 7 conversion; scoped to
//    OptimizeDialog/OptimizerPreview) ----------------------------------------

/** OptimizeDialog's per-plant color-wheel cache — populated by _updatePlantBadge,
 *  consumed by run() to skip a second round-trip fetch on submit. */
interface OptimizeWheelCache {
  plant: string;
  colorMap: Record<string, number> | null;
  wheelUsed: boolean;
}

/** One entry / the overall shape of the `GET /color-wheel/{plant}` response body.
 *  `meta` (CQ-1 Phase 6 Task 8) is read by ColorWheelViewer's `_load()` — the only
 *  caller that reads the upload-metadata half of this same response body. */
interface ColorWheelEntry {
  color: string;
  order_y?: number;
}
interface ColorWheelResponse {
  entries?: ColorWheelEntry[];
  meta?: { filename?: string; row_count?: number };
}

/** Store.pref('optimizerDefaults') shape — the user's last-used optimizer
 *  settings, seeded back into the dialog on open(). Store.pref() itself
 *  returns `unknown` (an open per-user prefs bag), so this is read via an `as`
 *  cast and defensively validated at each call site (typeof / array-includes
 *  checks) — same precedent as Table's TableGridLayout / _pinnedLines casts
 *  elsewhere in this file. */
interface OptimizerDefaults {
  mode?: string;
  preset?: string;
  respectFixed?: boolean;
  respectCalendar?: boolean;
}

/** Mirrors Engine.runAndApply's opts contract (schedule-services.mts) — built by
 *  run() below and threaded through OptimizerPreview.runWithPreview. Engine.
 *  runAndApply itself takes `opts: Record<string, unknown>` (an open bag it
 *  reads defensively via individual `as` casts), so this needs the same index
 *  signature to stay assignable at that call site — same "known fields + open
 *  bag" shape as NimbusTask (types.mts) / InteractionTraceEntry above. */
interface OptimizerRunOptions {
  plant?: string | null;
  colorMap?: Record<string, number> | null;
  lines?: string[] | null;
  startDate?: Date;
  endDate?: Date;
  respectFixed?: boolean;
  respectCalendar?: boolean;
  [key: string]: unknown;
}

export const OptimizeDialog = (() => {
  let _mode: OptimizerMode = 'changeover';
  let _preset  = '2w';
  let _start: Date | null   = null;
  let _end: Date | null     = null;
  let _fpStart: NimbusVendor.FlatpickrInstance | null = null;
  let _fpEnd: NimbusVendor.FlatpickrInstance | null   = null;
  let _plant: string | null   = null;
  let _allPlants: string[] = [];
  let _dropdownListenerSet = false;
  let _scope: 'plant' | 'lines' = 'plant';
  let _selectedLines = new Set<string>();    // line names when _scope === 'lines'
  let _lineSearch = '';              // current line-list filter text
  let _wheelCache: OptimizeWheelCache | null = null; // populated by _updatePlantBadge
  let _wheelFetchToken = 0;          // monotonic token to ignore stale responses

  const PRESET_DAYS: Record<string, number> = { '2w': 14 }; // UI only exposes '2w' and 'custom'

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
    const dynamic = Store.tasksArr.map(t => Store.getPlantForLine(t.PRODUCTION_LINE)).filter(Boolean) as string[];
    _allPlants = [...new Set([...Config.KNOWN_PLANTS, ...dynamic])].sort();
    const list = document.getElementById('opt-plant-list');
    if (!list) return;
    if (!_allPlants.length) {
      list.innerHTML = `<li class="opt-plant-empty">${Util.t('ui.no_plant_data')}</li>`;
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

  function _renderPlantList(plants: string[]) {
    const list = document.getElementById('opt-plant-list');
    if (!list) return;
    if (!plants.length) {
      list.innerHTML = `<li class="opt-plant-empty">${Util.t('ui.no_matches')}</li>`;
      return;
    }
    list.innerHTML = plants.map((p) => {
      const safe = p.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return `<li class="opt-plant-item${_plant === p ? ' selected' : ''}" role="option"
           aria-selected="${_plant === p}"
           onclick="NIMBUS.OptimizeDialog.selectPlant('${safe}')">${p}</li>`;
    }).join('');
  }

  function _updateTriggerLabel() {
    const lbl = document.getElementById('opt-plant-trigger-label');
    if (lbl) lbl.textContent = _plant || Util.t('ui.select_plant_label');
  }

  function _initDropdownListener() {
    if (_dropdownListenerSet) return;
    _dropdownListenerSet = true;
    document.addEventListener('click', (e: MouseEvent) => {
      const sel = document.getElementById('opt-plant-select');
      if (sel && !sel.contains(e.target as Node | null)) _closeDropdown();
    }, true);
  }

  function toggleDropdown() {
    const dd      = document.getElementById('opt-plant-dropdown');
    const trigger = document.getElementById('opt-plant-trigger');
    const sel     = document.getElementById('opt-plant-select');
    if (!dd) return;
    const opening = !!dd.hidden;
    if (opening && trigger) {
      const rect = trigger.getBoundingClientRect();
      dd.style.top   = (rect.bottom + 4) + 'px';
      dd.style.left  = rect.left + 'px';
      dd.style.width = rect.width + 'px';
    }
    dd.hidden = !opening;
    sel?.classList.toggle('open', opening);
    if (opening) {
      const srch = document.getElementById('opt-plant-search') as HTMLInputElement | null;
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

  function filterPlants(query: string) {
    const q = query.toLowerCase().trim();
    _renderPlantList(q ? _allPlants.filter((p) => p.toLowerCase().includes(q)) : _allPlants);
  }

  function selectPlant(plant: string) {
    _plant = plant;
    Store.setSelectedPlant(plant, 'optimize-dialog');
    _renderPlantList(_allPlants);
    _updateTriggerLabel();
    _closeDropdown();
    _updatePlantBadge();
    _selectedLines.clear();
    _lineSearch = '';
    const srch = document.getElementById('opt-line-search') as HTMLInputElement | null;
    if (srch) srch.value = '';
    if (_scope === 'lines') _renderLines();
    if (_preset === 'horizon') applyPreset('horizon');
  }

  function setScope(scope: string) {
    _scope = scope === 'lines' ? 'lines' : 'plant';
    document.querySelectorAll<HTMLElement>('.opt-scope-btn').forEach((b) =>
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
      list.innerHTML = `<li class="opt-lines-empty">${Util.t('ui.no_lines_plant')}</li>`;
      if (count) count.textContent = Util.t('ui.lines_selected', { sel: 0, total: 0 });
      return;
    }

    // Count orders per line (scoped to selected plant)
    const orderCounts: Record<string, number> = {};
    for (const t of Store.tasksByPlant(_plant)) {
      const l = t.PRODUCTION_LINE || 'Unknown';
      orderCounts[l] = (orderCounts[l] || 0) + 1;
    }

    const q = _lineSearch.toLowerCase().trim();
    const visible = q ? allLines.filter(l => l.toLowerCase().includes(q)) : allLines;

    if (!visible.length) {
      list.innerHTML = `<li class="opt-lines-empty">${Util.t('ui.no_matches')}</li>`;
    } else {
      list.innerHTML = visible.map((line) => {
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

  function filterLines(q: string) {
    _lineSearch = q || '';
    _renderLines();
  }

  function selectAllLines(checked: boolean) {
    const allLines = _linesForPlant();
    const q = _lineSearch.toLowerCase().trim();
    const visible = q ? allLines.filter(l => l.toLowerCase().includes(q)) : allLines;
    for (const l of visible) {
      if (checked) _selectedLines.add(l);
      else _selectedLines.delete(l);
    }
    _renderLines();
  }

  function _onLineToggle(line: string, checked: boolean) {
    if (checked) _selectedLines.add(line);
    else _selectedLines.delete(line);
    const count = document.getElementById('opt-lines-count');
    const total = _linesForPlant().length;
    if (count) count.textContent = `${_selectedLines.size} of ${total} selected`;
  }

  function _displayDate(d: Date) {
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  }

  function _updateSummary() {
    const el = document.getElementById('opt-date-summary');
    if (!el || !_start || !_end) return;
    const days = Math.round((_end.getTime() - _start.getTime()) / Config.MS_DAY);
    el.innerHTML =
      `<span class="opt-date-summary-range">${_displayDate(_start)} → ${_displayDate(_end)}</span>` +
      `<span class="opt-date-summary-days">&nbsp;· ${days} days</span>`;
  }

  function applyPreset(key: string) {
    _preset = key;
    document.querySelectorAll<HTMLElement>('.opt-preset-chip').forEach((c) =>
      c.classList.toggle('active', c.dataset.preset === key)
    );
    const row = document.getElementById('opt-date-row');
    if (row) row.classList.toggle('visible', key === 'custom');

    if (key !== 'custom') {
      let days: number;
      if (key === 'horizon') {
        // Store._state.masterData direct touch — deliberate, out of scope for this
        // task (see the file header comment above OptimizeDialog).
        const plantRow = Store._state.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null;
        const horizonMinutes = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? 20160;
        days = Math.max(1, Math.ceil(horizonMinutes / 1440));
      } else {
        days = PRESET_DAYS[key];
      }
      const now = new Date();
      now.setSeconds(0, 0);
      _start = new Date(now);
      _end   = new Date(now.getTime() + days * Config.MS_DAY);
      _fpStart?.setDate(_start, false);
      _fpEnd?.setDate(_end, false);
      const sb = document.getElementById('opt-start-btn');
      const eb = document.getElementById('opt-end-btn');
      if (sb) sb.textContent = _displayDate(_start);
      if (eb) eb.textContent = _displayDate(_end);
    }
    _updateSummary();
  }

  function selectMode(mode: OptimizerMode) {
    _mode = mode;
    document.querySelectorAll<HTMLElement>('.opt-strategy-pill').forEach((c) =>
      c.classList.toggle('active', c.dataset.mode === mode)
    );
  }

  function _updatePlantBadge() {
    const plant   = _plant;
    const badgeEl = document.getElementById('opt-wheel-badge');
    const runBtn = document.getElementById('opt-run-btn') as HTMLButtonElement | null;

    if (runBtn) runBtn.disabled = !plant;

    if (!badgeEl) return;
    const setBadge = (state: 'none' | 'loading' | 'active' | 'warn', icon: string, tip: string) => {
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
      .then(r => r.ok ? r.json() as Promise<ColorWheelResponse> : Promise.reject())
      .then(body => {
        if (token !== _wheelFetchToken) return; // stale response — ignore
        const entries = (body && body.entries) || [];
        if (entries.length) {
          const colorMap: Record<string, number> = {};
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
      Toast.show(Util.t('toast.select_plant_before_opt'), 'warn');
      return;
    }
    const el = document.getElementById('modal-optimize');
    if (!el) return;
    el.hidden = false;
    // Seed from the user's saved optimizer defaults (pref('optimizerDefaults'))
    // when present, so the dialog opens pre-filled with their preferred strategy,
    // time window, and option toggles. Falls back to the historical defaults
    // (horizon preset / changeover / toolbar checkbox state) otherwise.
    let _od: OptimizerDefaults | null = null;
    try { _od = Store.pref('optimizerDefaults') as OptimizerDefaults | null; } catch {}
    // Sync option checkboxes from the Gantt toolbar's existing chk- elements
    const rfEl = document.getElementById('chk-respect-fixed') as HTMLInputElement | null;
    const rcEl = document.getElementById('chk-respect-calendar') as HTMLInputElement | null;
    const ofEl = document.getElementById('opt-chk-fixed') as HTMLInputElement | null;
    const ocEl = document.getElementById('opt-chk-calendar') as HTMLInputElement | null;
    if (rfEl && ofEl) ofEl.checked = rfEl.checked;
    if (rcEl && ocEl) ocEl.checked = rcEl.checked;
    // Saved defaults override the toolbar mirror when present.
    if (_od && typeof _od === 'object') {
      if (ofEl && typeof _od.respectFixed === 'boolean')    ofEl.checked = _od.respectFixed;
      if (ocEl && typeof _od.respectCalendar === 'boolean') ocEl.checked = _od.respectCalendar;
    }
    _initPickers();
    _buildPlantSelect();
    // Only the "safe" no-date presets seed cleanly (custom needs explicit dates).
    const savedPreset = _od?.preset;
    const _seedPreset: string = (savedPreset && ['horizon', '2w'].includes(savedPreset)) ? savedPreset : 'horizon';
    applyPreset(_seedPreset);
    const savedMode = _od?.mode;
    const _seedMode: OptimizerMode = (savedMode && ['spt', 'changeover', 'combined'].includes(savedMode)) ? (savedMode as OptimizerMode) : 'changeover';
    selectMode(_seedMode);
    // Reset the Run button HTML in case a previous session left it in the
    // "Optimizing…" state (e.g., Cancel mid-fetch).
    const runBtn = document.getElementById('opt-run-btn');
    if (runBtn) runBtn.innerHTML = `<span class="opt-run-icon">📈</span>${Util.t('btn.run_optimization')}`;
    _updatePlantBadge();
    // Default scope to whole-plant on each open; clear stale line selection.
    _selectedLines.clear();
    _lineSearch = '';
    const lineSrch = document.getElementById('opt-line-search') as HTMLInputElement | null;
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
      Toast.show(Util.t('toast.select_plant_to_opt'), 'warn');
      return;
    }
    if (_scope === 'lines' && _selectedLines.size === 0) {
      Toast.show(Util.t('toast.select_lines_to_opt'), 'warn');
      return;
    }
    const sfEl = document.getElementById('opt-chk-fixed') as HTMLInputElement | null;
    const scEl = document.getElementById('opt-chk-calendar') as HTMLInputElement | null;

    // Remember the chosen strategy/window/options as this user's optimizer
    // defaults so the dialog pre-fills the same way next time (feature: optimizer
    // defaults). Self-service pref — persisted via the debounced PATCH.
    try {
      Session.setPref('optimizerDefaults', {
        mode: _mode, preset: _preset,
        respectFixed:    sfEl?.checked ?? true,
        respectCalendar: scEl?.checked ?? true,
      });
    } catch {}

    // Immediate visual feedback so the click feels responsive.
    const runBtn = document.getElementById('opt-run-btn') as HTMLButtonElement | null;
    const origRunHTML = runBtn ? runBtn.innerHTML : null;
    const restoreRunBtn = () => {
      if (!runBtn) return;
      runBtn.disabled = !_plant;
      if (origRunHTML !== null) runBtn.innerHTML = origRunHTML;
    };
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.innerHTML = `<span class="opt-run-icon">⏳</span>${Util.t('btn.optimizing')}`;
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
    let colorMap: Record<string, number> | null = null;
    let wheelUsed = false;
    if (_wheelCache && _wheelCache.plant === plant) {
      colorMap  = _wheelCache.colorMap;
      wheelUsed = _wheelCache.wheelUsed;
    } else {
      try {
        const resp = await fetch(`${Config.API_BASE}/color-wheel/${encodeURIComponent(plant)}`, { signal: AbortSignal.timeout(1500) });
        if (resp.ok) {
          const body = await resp.json() as ColorWheelResponse;
          const entries = body.entries || [];
          if (entries.length) {
            colorMap = {};
            for (const e of entries) colorMap[Util.norm(e.color)] = e.order_y ?? 999999;
            wheelUsed = true;
          }
        }
      } catch {
        // No wheel reachable — continue without
      }
    }

    // Confirm only when the plant WANTS color (colorWheel constraint enabled)
    // but no wheel is loaded. If the plant has switched color off, optimizing
    // without it is intentional — don't nag.
    const colorWheelOn = Engine.constraintEnabled(plant, 'colorWheel');
    if (colorWheelOn && !wheelUsed && (_mode === 'changeover' || _mode === 'combined')) {
      const ok = await Modal.confirm({ title: Util.t('modal.no_color_wheel_confirm_msg', { plant }) });
      if (!ok) { OptimizerPreview.hideLoading(); restoreRunBtn(); return; }
    }

    const linesScope = (_scope === 'lines' && _selectedLines.size) ? Array.from(_selectedLines) : null;
    const optsForEngine: OptimizerRunOptions = {
      plant,
      colorMap,
      lines:           linesScope,
      startDate:       _start ?? (() => { const d = new Date(); d.setSeconds(0, 0); return d; })(),
      endDate:         _end   ?? new Date(Date.now() + 28 * Config.MS_DAY),
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
      headers: { 'Content-Type': 'application/json', 'X-User': Session.actor() },
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
    if (_start) _fpStart!.setDate(_start, false);
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
    if (_end) _fpEnd!.setDate(_end, false);
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

/** Return shape of Util.scheduleKpis — same ReturnType<typeof ...> precedent as
 *  Hierarchy's HierarchyUtilMatrix / Dashboard's DashboardUtilMatrix (Task 4). */
type OptimizerKpis = ReturnType<typeof Util.scheduleKpis>;

/** Zero-filled fallback so pre/post KPI reads never need an intermediate
 *  `{}` — every OptimizerKpis field is a required number. */
const EMPTY_OPTIMIZER_KPIS: OptimizerKpis = { changeovers: 0, span_h: 0, late_count: 0, late_h: 0, peak_util_pct: 0 };

/** lowerIsBetter's four states — see the comment inside _render() for the full
 *  semantics of each (true/false/'soft'/null). */
type LowerIsBetter = boolean | 'soft' | null;

/** One KPI comparison card in the preview grid. */
interface OptimizerPreviewCard {
  label: string;
  k: keyof OptimizerKpis;
  ico: string;
  fmt: (v: number) => string;
  unit: string;
  lowerIsBetter: LowerIsBetter;
  tip: string;
}

/* =============================================================================
   OPTIMIZER PREVIEW (C4) — wraps Engine.runAndApply so the planner sees a
   pre/post KPI comparison before committing. Discard reverts to the snapshot;
   Apply pushes an UndoStack entry so Ctrl+Z still works after the fact.
   ========================================================================== */
export const OptimizerPreview = {
  _snapshot: null as NimbusTask[] | null,   // deep-cloned tasks taken before the run
  _preKpis:  null as OptimizerKpis | null,
  _postKpis: null as OptimizerKpis | null,
  _mode:     null as OptimizerMode | null,
  _plant:    null as string | null,
  active:    false,  // true from the moment the trial mutates the Store until Apply/Discard
  _confSnapshot: null as unknown,   // Confidence.snapshot() taken just before the trial mutation
  _abandonGuardInstalled: false,

  /** Open the preview modal with a loading skeleton. Safe to call as soon as
   *  the user clicks Run, before any await/fetch — gives instant feedback so
   *  the user doesn't stare at a blurry frozen page during the wheel fetch
   *  + config-close transition + engine run. */
  showLoading(mode: OptimizerMode, plant: string) {
    OptimizerPreview._installAbandonGuard();
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
    if (root) root.querySelectorAll<HTMLButtonElement>('.modal-foot button').forEach((b) => { b.disabled = true; });
    Modal.open('modal-opt-preview');
  },

  /** Close the loading dialog without doing any work. For aborts (e.g. user
   *  cancels the no-color-wheel confirm) so the spinner doesn't linger. */
  hideLoading() {
    Modal.close('modal-opt-preview');
    const root = document.getElementById('modal-opt-preview');
    if (root) root.querySelectorAll<HTMLButtonElement>('.modal-foot button').forEach((b) => { b.disabled = false; });
  },

  /** One-time safety net: the modal's backdrop is wired (like every other modal's)
   *  to close on an outside click, bypassing discard()/apply() entirely (app.js's
   *  boot-time '.modal-backdrop' click handler calls Modal.close() directly). Left
   *  alone, that would abandon a live trial with no revert AND leave `active` stuck
   *  true, freezing Confidence forever. Treat any non-apply/discard hide as a discard. */
  _installAbandonGuard() {
    if (OptimizerPreview._abandonGuardInstalled) return;
    OptimizerPreview._abandonGuardInstalled = true;
    const el = document.getElementById('modal-opt-preview');
    if (!el) return;
    new MutationObserver(() => {
      if (el.hidden && OptimizerPreview.active) OptimizerPreview.discard();
    }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
  },

  /** Entry point — call this instead of Engine.runAndApply when you want
   *  the preview UI. Mirrors Engine.runAndApply's signature. */
  runWithPreview(mode: OptimizerMode = 'combined', opts: OptimizerRunOptions = {}) {
    if (!Store.tasksArr.length) { Toast.show(Util.t('toast.no_tasks_to_optimise'), 'error'); return; }
    const plant = opts.plant ?? Store.selectedPlant;
    if (!plant) { Toast.show(Util.t('toast.select_plant_before_opt'), 'warn'); return; }

    // Show the preview dialog with a loading state. If `showLoading()` already
    // ran from OptimizeDialog.run() the dialog is already up — calling it
    // again is a no-op cheap refresh, fine.
    OptimizerPreview.showLoading(mode, plant);
    const previewRoot = document.getElementById('modal-opt-preview');
    const footBtns: HTMLButtonElement[] = previewRoot
      ? Array.from(previewRoot.querySelectorAll<HTMLButtonElement>('.modal-foot button'))
      : [];
    const body = document.getElementById('opt-preview-body');

    // Double rAF to ensure the loading skeleton actually paints before we
    // block the main thread with the optimizer. Single rAF schedules a frame
    // but synchronous work afterward can still preempt the paint.
    let snapshot: NimbusTask[] | null = null;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const _optTotalT0 = performance.now();
      try {
        // Snapshot every task in the plant — the optimizer may touch any of
        // them transitively (auto-reflow can ripple beyond the chosen window
        // / lines), so the undo snapshot must stay unfiltered.
        const scopedTasks = Store.tasksByPlant(plant);
        const ids = scopedTasks.map(t => t.id);
        const _snapT0 = performance.now();
        snapshot = UndoStack.snapshotTasks(ids);
        // Publish the snapshot BEFORE mutating the Store (R6) so a mid-run throw can
        // be rolled back in the catch — Engine.runAndApply mutates in place.
        OptimizerPreview._snapshot = snapshot;
        // Freeze Confidence for the whole trial window (through Apply/Discard) and
        // snapshot it so a Discard can roll back without leaving any trace.
        OptimizerPreview.active = true;
        OptimizerPreview._confSnapshot = NIMBUS!.Confidence?.snapshot?.() ?? null;
        PerfMonitor.record('Optimize.snapshot', performance.now() - _snapT0);

        // KPI inputs are scoped to what the user actually selected on screen 1 —
        // time window and (optionally) a subset of lines. Otherwise the before/after
        // comparison drowns the user's slice in out-of-scope tasks.
        const winStart = opts.startDate ? opts.startDate.getTime() : -Infinity;
        const winEnd   = opts.endDate   ? opts.endDate.getTime()   :  Infinity;
        const lineSet  = (Array.isArray(opts.lines) && opts.lines.length) ? new Set(opts.lines) : null;
        const inScope = (t: NimbusTask): boolean => {
          if (lineSet && !lineSet.has(t.PRODUCTION_LINE)) return false;
          const s = t.start_date ? t.start_date.getTime() : null;
          if (s == null) return false;
          const e = Util.scheduledEnd(t);
          const eMs = e ? e.getTime() : s;
          return eMs >= winStart && s <= winEnd;
        };

        // Pre-KPIs from the (filtered) snapshot — it IS the current state right now.
        const _preKpiT0 = performance.now();
        const preKpis = Util.scheduleKpis(snapshot.filter(inScope), 14);
        PerfMonitor.record('Optimize.preKPIs', performance.now() - _preKpiT0);

        // Run the optimizer in place.
        Engine.runAndApply(mode, opts);

        // Post-KPIs from the now-mutated Store, filtered to the same scope.
        const postTasks = Store.tasksByPlant(plant).filter(inScope);
        const _postKpiT0 = performance.now();
        const postKpis  = Util.scheduleKpis(postTasks, 14);
        PerfMonitor.record('Optimize.postKPIs', performance.now() - _postKpiT0);

        OptimizerPreview._preKpis  = preKpis;
        OptimizerPreview._postKpis = postKpis;
        OptimizerPreview._mode     = mode;
        OptimizerPreview._plant    = plant;

        footBtns.forEach((b) => { b.disabled = false; });
        OptimizerPreview._render();
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : undefined;
        ErrorLog.error('optimize-preview', errMsg || String(err));
        // Roll the Store back to the pre-run snapshot (R6) — a mid-run throw leaves
        // the schedule partially mutated otherwise, with no undo path.
        if (snapshot) {
          try {
            UndoStack.restoreTasks(snapshot);
            if (NIMBUS!.Confidence && OptimizerPreview._confSnapshot) NIMBUS!.Confidence!.restore!(OptimizerPreview._confSnapshot);
            Alerts.scheduleRecompute();
          }
          catch { ErrorLog.error('optimize-preview', `revert failed`); }
        }
        OptimizerPreview._clear();
        if (body) {
          body.innerHTML =
            '<div style="padding:24px;text-align:center;color:var(--danger,#c0392b);">'
          + '  <div style="font-size:14px;margin-bottom:8px;">Optimization failed</div>'
          + `  <div style="font-size:12px;color:var(--fg-mute);">${(errMsg || 'Unknown error').replace(/[<>&]/g, (c: string) => (({'<':'&lt;','>':'&gt;','&':'&amp;'} as Record<string, string>)[c]))}</div>`
          + '</div>';
        }
        footBtns.forEach((b) => { b.disabled = false; });
      } finally {
        PerfMonitor.record('Optimize.total', performance.now() - _optTotalT0);
      }
    }));
  },

  _render() {
    const body = document.getElementById('opt-preview-body');
    if (!body) return;
    const pre  = OptimizerPreview._preKpis  || EMPTY_OPTIMIZER_KPIS;
    const post = OptimizerPreview._postKpis || EMPTY_OPTIMIZER_KPIS;

    // Each card: { label, k, ico, fmt, lowerIsBetter, tip }.
    // lowerIsBetter: true → decrease=better (green), increase=worse (red).
    //                false → increase=better (green), decrease=worse (red).
    //                'soft' → decrease=better (green, counts as KPI win),
    //                         increase=warn (amber, no verdict penalty). Used for
    //                         span and peak utilization where shrinking is desirable
    //                         but growing shouldn't be flagged as a regression.
    //                null → neutral in both directions.
    const cards: OptimizerPreviewCard[] = [
      {
        label: 'Changeovers', k: 'changeovers', ico: '🔁',
        fmt: (v) => String(v), unit: '', lowerIsBetter: true,
        tip: 'Adjacent orders on the same line that differ in COLOR or FORM_SIZE. Each one costs cleanout/setup time, so fewer is better.',
      },
      {
        label: 'Schedule span', k: 'span_h', ico: '↔',
        fmt: (v) => v.toFixed(1), unit: 'h', lowerIsBetter: 'soft',
        tip: 'Total clock time from the earliest order start to the latest order finish, across the selected window and lines.',
      },
      {
        label: 'Late orders', k: 'late_count', ico: '⏰',
        fmt: (v) => String(v), unit: '', lowerIsBetter: true,
        tip: 'Count of orders whose scheduled finish lands AFTER the SAP planning date. Equal-weight headcount — a 1-hour slip and a 40-hour slip each count as one.',
      },
      {
        label: 'Cumulative lateness', k: 'late_h', ico: '⛌',
        fmt: (v) => v.toFixed(1), unit: 'h', lowerIsBetter: true,
        tip: 'Sum of due-date slip across every late order, in hours. Captures severity, not just count: ten orders slipping 1 h = 10 h; one order slipping 40 h = 40 h. Lower is better.',
      },
      {
        label: 'Peak line utilization', k: 'peak_util_pct', ico: '▲',
        fmt: (v) => String(v), unit: '%', lowerIsBetter: 'soft',
        tip: 'Highest single-line single-day utilization in the 14-day horizon. High is good for throughput; over 100% means overbooked vs Calendar capacity.',
      },
    ];

    // Verdict: count how many directional KPIs moved the right way. 'soft'
    // cards (span, peak utilization) count decreases as wins but treat
    // increases as neutral — they shouldn't trigger a regression verdict.
    const directional = cards.filter(c => c.lowerIsBetter === true || c.lowerIsBetter === 'soft');
    let better = 0, worse = 0;
    for (const c of directional) {
      const d = (post[c.k] ?? 0) - (pre[c.k] ?? 0);
      if (Math.abs(d) < 0.05) { continue; }
      if (c.lowerIsBetter === 'soft') {
        if (d < 0) better++;
      } else if (d < 0) better++;
      else worse++;
    }
    let verdictTone: string, verdictTitle: string, verdictSub: string;
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

    const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c: string) =>
      (({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' } as Record<string, string>)[c]));

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
      body.querySelectorAll<HTMLElement>('.opt-pv-num-post').forEach((el) => {
        const target = parseFloat(el.dataset.target || '');
        if (!Number.isFinite(target)) return;
        const fmt   = el.dataset.fmt;
        const unit  = el.dataset.unit || '';
        const valEl = el.querySelector<HTMLElement>('.opt-pv-num-val')!;
        const dur   = 520;
        const t0    = performance.now();
        const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
        const tick = (now: number) => {
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
    Toast.show(Util.t('toast.opt_applied'), 'success');
    OptimizerPreview._clear();
    // The trial is now the committed baseline — recompute right away instead of
    // waiting on the debounce so the badge reflects it immediately.
    NIMBUS!.Confidence?._recompute?.();
    Modal.close('modal-opt-preview');
    Alerts.scheduleRecompute();
  },

  discard() {
    const snap = OptimizerPreview._snapshot;
    const confSnap = OptimizerPreview._confSnapshot;
    if (snap) {
      UndoStack.restoreTasks(snap);
      if (NIMBUS!.Confidence && confSnap) NIMBUS!.Confidence!.restore!(confSnap);
      Alerts.scheduleRecompute();
      Toast.show(Util.t('toast.opt_discarded'), 'info');
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
    OptimizerPreview.active       = false;
    OptimizerPreview._confSnapshot = null;
  },
};

// -- Local type declarations (CQ-1 Phase 6 Task 8 conversion; scoped to
//    EditCalendar/ColorWheelViewer/AlertsUIAdapter/SandboxAdapter/Printer —
//    the last region of this file's stopgap-`any` cleanup) ------------------

/** EditCalendar.applyPreset's three named quick-pick presets (Weekdays,
 *  Mon-Sat, All 7 Days). */
interface CalendarPreset {
  days: number[];
  s: string;
  e: string;
}

/** The `sandbox:exited` event's `snapshot` payload (schedule-state.mts's
 *  `Sandbox.exit()` return value) — that module keeps `SandboxSnapshot`
 *  un-exported, so this derives the same shape via `ReturnType` instead of
 *  redeclaring a shadow copy, per this phase's own "no un-exported interface,
 *  use ReturnType<typeof …>" precedent. */
type SandboxExitSnapshot = NonNullable<ReturnType<typeof Sandbox.exit>>;

/* =============================================================================
   EDIT CALENDAR — per-line working hours modal.
   Opens from the "Edit Calendar" button in each ProdLines accordion.
   Writes to Store.setCalendar() and triggers ProdLines.render() on save.
   DB-ready: Store.calendars[line].workHours = { 0: [h1,h2]|null, ...6 }
   maps to: line_calendar(line_code, day_of_week, is_open, start_hour, end_hour)
   ========================================================================== */
export const EditCalendar = (() => {
  let _line: string | null = null;
  let _fp: NimbusVendor.FlatpickrInstance[] = []; // 14 flatpickr instances: [start0, end0, start1, end1, ..., start6, end6]
  let _plantMode = false;
  let _plantName: string | null = null;

  function open(line: string) {
    _plantMode = false;
    _plantName = null;
    _line = line;
    Store.ensureCalendar(line);
    _renderHeader();
    _initPickers();
    _populate();
    const el = document.getElementById('modal-edit-calendar');
    if (!el) return;
    const copyBtn = el.querySelector<HTMLElement>('.cal-copy-plant-btn');
    if (copyBtn) copyBtn.style.display = '';
    el.hidden = false;
    requestAnimationFrame(() => el.querySelector('.cal-edit-modal')?.classList.add('visible'));
  }

  function openPlant(name: string) {
    _plantMode = true;
    _plantName = name;
    _line = null;
    Store.ensurePlant(name);
    _renderHeader();
    _initPickers();
    _populate();
    const el = document.getElementById('modal-edit-calendar');
    if (!el) return;
    const copyBtn = el.querySelector<HTMLElement>('.cal-copy-plant-btn');
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
      const plant = Store.getPlantForLine(_line!);
      if (nameEl)  nameEl.textContent  = _line;
      if (plantEl) plantEl.textContent = `Plant ${plant}`;
    }
  }

  function _populate() {
    const wh = _plantMode
      ? Store.plants[_plantName!].workHours
      : Store.calendars[_line!].workHours;
    document.querySelectorAll('.cal-preset-chip').forEach(c => c.classList.remove('active'));
    for (let d = 0; d < 7; d++) {
      const enabled = !!wh[d];
      const tog = document.getElementById(`cal-edit-toggle-${d}`) as HTMLInputElement | null;
      if (tog) tog.checked = enabled;
      _setRowEnabled(d, enabled);
      if (enabled && _fp.length === 14) {
        _fp[d * 2]?.setDate(Util.hoursToTimeString(wh[d]![0]), false);
        _fp[d * 2 + 1]?.setDate(Util.hoursToTimeString(wh[d]![1]), false);
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

  function _setRowEnabled(d: number, enabled: boolean) {
    const row = document.getElementById(`cal-edit-row-${d}`);
    row?.classList.toggle('cal-day-off', !enabled);
    // Disable the altInput flatpickr renders (the visible element)
    const startAlt = document.querySelector(`#cal-edit-start-${d} ~ input.flatpickr-input`) as HTMLInputElement | null;
    const endAlt   = document.querySelector(`#cal-edit-end-${d} ~ input.flatpickr-input`) as HTMLInputElement | null;
    [startAlt, endAlt].forEach((inp) => { if (inp) inp.disabled = !enabled; });
  }

  function _refreshBadge(d: number) {
    const badge = document.getElementById(`cal-edit-badge-${d}`);
    if (!badge) return;
    const tog = document.getElementById(`cal-edit-toggle-${d}`) as HTMLInputElement | null;
    if (!tog?.checked) { badge.textContent = '—'; return; }
    const s = _fp[d * 2]?.element?.value;
    const e = _fp[d * 2 + 1]?.element?.value;
    if (s && e) {
      const hrs = Util.timeStringToHours(e) - Util.timeStringToHours(s);
      badge.textContent = hrs > 0
        ? `${hrs % 1 === 0 ? hrs : hrs.toFixed(1)}h`
        : '—';
    } else {
      badge.textContent = '—';
    }
  }

  function onToggle(d: number, checked: boolean) {
    _setRowEnabled(d, checked);
    if (checked && _fp.length === 14) {
      if (!_fp[d * 2]?.element?.value)     _fp[d * 2]?.setDate('08:00', false);
      if (!_fp[d * 2 + 1]?.element?.value) _fp[d * 2 + 1]?.setDate('17:00', false);
    }
    _refreshBadge(d);
  }

  function applyPreset(preset: string) {
    const PRESETS: Record<string, CalendarPreset> = {
      mf:  { days: [1,2,3,4,5],     s: '08:00', e: '17:00' },
      ms:  { days: [1,2,3,4,5,6],   s: '08:00', e: '17:00' },
      all: { days: [0,1,2,3,4,5,6], s: '08:00', e: '17:00' },
    };
    const p = PRESETS[preset];
    if (!p) return;
    document.querySelectorAll<HTMLElement>('.cal-preset-chip')
      .forEach((c) => c.classList.toggle('active', c.dataset.preset === preset));
    for (let d = 0; d < 7; d++) {
      const enabled = p.days.includes(d);
      const tog = document.getElementById(`cal-edit-toggle-${d}`) as HTMLInputElement | null;
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
    const plant = Store.getPlantForLine(_line!);
    if (!plant) { Toast.show(Util.t('toast.no_plant_assigned_line'), 'warn'); return; }
    Store.ensurePlant(plant);
    const ph = Store.plants[plant].workHours;
    for (let d = 0; d < 7; d++) {
      const enabled = !!ph[d];
      const tog = document.getElementById(`cal-edit-toggle-${d}`) as HTMLInputElement | null;
      if (tog) tog.checked = enabled;
      if (enabled && _fp.length === 14) {
        _fp[d * 2]?.setDate(Util.hoursToTimeString(ph[d]![0]), false);
        _fp[d * 2 + 1]?.setDate(Util.hoursToTimeString(ph[d]![1]), false);
      }
      _setRowEnabled(d, enabled);
      _refreshBadge(d);
    }
    document.querySelectorAll('.cal-preset-chip').forEach(c => c.classList.remove('active'));
    Toast.show(Util.t('toast.copied_from_plant'), 'success');
  }

  function save() {
    if (!_plantMode && !_line) return;
    const newWh: WorkHours = {};
    for (let d = 0; d < 7; d++) {
      const tog = document.getElementById(`cal-edit-toggle-${d}`) as HTMLInputElement | null;
      if (!tog?.checked) { newWh[d] = null; continue; }
      const s = _fp[d * 2]?.element?.value;
      const e = _fp[d * 2 + 1]?.element?.value;
      if (s && e) {
        const sh = Util.timeStringToHours(s), eh = Util.timeStringToHours(e);
        // Reject degenerate/inverted days client-side so we never diverge from the
        // backend (_clean_work_hours rejects end <= start with a 400).
        if (eh <= sh) { Toast.show(Util.t('toast.end_must_be_after_start'), 'error'); return; }
        newWh[d] = [sh, eh];
      } else {
        newWh[d] = null;
      }
    }
    if (_plantMode) {
      Store.plants[_plantName!].workHours = newWh;
      const changed = new Set<string>();
      for (let d = 0; d < 7; d++) for (const l of Store.clampLinesToPlant(_plantName!, d)) changed.add(l);
      NIMBUS!.Plant!._persistPlantHours!(_plantName, changed);
      NIMBUS!.Plant!.render!();
      close();
      Toast.show(Util.t('toast.plant_calendar_clamped'), 'success');
    } else {
      Store.setCalendar(_line!, newWh, 'edit-calendar');
      const plant = Store.getPlantForLine(_line!) || Store.selectedPlant;
      if (plant) CalendarSync.saveLineHours(plant, _line!, newWh);
      NIMBUS!.ProdLines!.render!();
      close();
      Toast.show(Util.t('toast.line_calendar_updated', { line: _line! }), 'success');
    }
  }

  return { open, openPlant, close, save, onToggle, applyPreset, copyFromPlant };
})();

/* =============================================================================
   COLOR WHEEL VIEWER — modal preview of a plant's uploaded color wheel.
   Supports search, sort, expandable rows with task counts per color.
   ========================================================================== */
export const ColorWheelViewer = (() => {
  let _plant: string | null = null;
  let _entries: ColorWheelEntry[] = [];
  let _search  = '';
  let _sort: 'priority' | 'name' = 'priority';

  const _esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c: string) =>
    (({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]));

  // Map common color name fragments → hex for the swatch tiles
  const COLOR_MAP: Record<string, string> = {
    RED:'#e74c3c', BLUE:'#3498db', GREEN:'#2ecc71', YELLOW:'#f1c40f',
    ORANGE:'#e67e22', PURPLE:'#9b59b6', PINK:'#e91e8c', WHITE:'#f0ede8',
    BLACK:'#2c3e50', BROWN:'#7a5a2a', GREY:'#95a5a6', GRAY:'#95a5a6',
    SILVER:'#bdc3c7', GOLD:'#b8791a', AMBER:'#b8791a', NAVY:'#1f2d6d',
    TEAL:'#1abc9c', AQUA:'#00bcd4', MAROON:'#8b1a1a', OLIVE:'#6b7a2a',
    BEIGE:'#e8dcc8', TAN:'#d4a96a', CORAL:'#ff6b6b', LIME:'#a8e063',
    SAGE:'#87a96b', SLATE:'#708090', IVORY:'#fffff0', CREAM:'#fffdd0',
  };

  function _resolveColor(name: string): string | null {
    const u = String(name).toUpperCase().trim();
    if (COLOR_MAP[u]) return COLOR_MAP[u];
    for (const [k, v] of Object.entries(COLOR_MAP)) {
      if (u.includes(k)) return v;
    }
    return null;
  }

  function open(plant: string) {
    _plant  = plant;
    _search = '';
    _sort   = 'priority';
    const el = document.getElementById('modal-cw-viewer');
    if (!el) return;
    el.hidden = false;
    // Reset search UI
    const srch = document.getElementById('cw-viewer-search') as HTMLInputElement | null;
    if (srch) srch.value = '';
    const sortBtns = document.querySelectorAll<HTMLElement>('.cw-sort-btn');
    sortBtns.forEach((b) => b.classList.toggle('active', b.dataset.sort === 'priority'));
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
    if (listEl)  listEl.innerHTML    = `<div class="cw-loading"><span class="cw-spin"></span>${Util.t('ui.loading_wheel')}</div>`;

    fetch(`${Config.API_BASE}/color-wheel/${encodeURIComponent(_plant!)}`, { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() as Promise<ColorWheelResponse> : Promise.reject(new Error(`HTTP ${r.status}`)))
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
      .catch((err: Error) => {
        _entries = [];
        if (listEl) listEl.innerHTML = `<div class="cw-viewer-empty">${Util.t('empty.cw_no_wheel_for_plant', { plant: _esc(_plant) })}</div>`;
        const metaEl = document.getElementById('cw-viewer-meta');
        if (metaEl) metaEl.textContent = err.message.includes('404') ? Util.t('empty.cw_no_file') : err.message;
      });
  }

  function _render() {
    const listEl  = document.getElementById('cw-viewer-list');
    const countEl = document.getElementById('cw-viewer-count');
    if (!listEl) return;

    // Task counts per color for this plant
    const taskCounts: Record<string, number> = {};
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
      listEl.innerHTML = `<div class="cw-viewer-empty">${_search ? Util.t('empty.cw_no_search_match') : Util.t('empty.cw_no_entries')}</div>`;
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
            ${Util.t('ui.priority_label')} <strong>${pri}</strong>
            ${tc ? `<span class="cw-row-dot">·</span><span class="cw-row-tasks">${Util.t('ui.active_orders', { count: tc, plural: tc !== 1 ? 's' : '' })}</span>` : ''}
          </div>
        </div>
        <div class="cw-row-rank">#${i + 1}</div>
        <button class="cw-row-expand" onclick="NIMBUS.ColorWheelViewer._toggleExpand(this)">▾</button>
        <div class="cw-row-detail">
          ${tc
            ? `<span class="cw-detail-stat ok">${Util.t('ui.active_orders', { count: tc, plural: tc !== 1 ? 's' : '' })} ${Util.t('ui.on_plant_label')} <strong>${_esc(_plant)}</strong></span>`
            : `<span class="cw-detail-stat mute">${Util.t('ui.no_active_for_color')}</span>`}
        </div>
      </div>`;
    }).join('');
  }

  function _toggleExpand(btn: HTMLElement) {
    const row    = btn.closest('.cw-viewer-row');
    const detail = row?.querySelector('.cw-row-detail');
    if (!detail) return;
    const open = detail.classList.toggle('open');
    btn.textContent = open ? '▴' : '▾';
  }

  function search(val: string) {
    _search = String(val || '').toLowerCase();
    _render();
  }

  function sort(mode: 'priority' | 'name') {
    _sort = mode;
    document.querySelectorAll<HTMLElement>('.cw-sort-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.sort === mode)
    );
    _render();
  }

  return { open, close, search, sort, _toggleExpand };
})();

// VirtualList row-height const for AlertsUIAdapter's drawer (moved from
// app.js's top-of-file const group alongside VL_HIER_LINE_H/VL_HIER_TASK_H
// and VL_LS_ROW_H, moved in Tasks 3/4 respectively).
const VL_ALERT_ROW_H = 72;

/* =============================================================================
   ALERTS UI ADAPTER — drawer, bell badge, cell-briefing modal remnant.
   CQ-1 Phase 2 Task 2 moved Alerts' computation half (recompute,
   _recomputeSync, dismiss/dismissAll/clearDismissed, applyFix, and the
   debounced scheduleRecompute/scheduleRecomputeLines dispatcher) into
   schedule-services.mjs, where it is imported below as `Alerts` (see the
   bridge destructure at the top of this IIFE). Only the DOM half — the
   alert drawer, bell badge, and cell-briefing modal — stayed here, renamed
   from `Alerts` to `AlertsUIAdapter` (verbatim bodies) so the bare name
   `Alerts` is free for the imported computation module. `focus`/
   `_renderDrawer`/`_renderBell` are renamed/promoted here to `focus`/
   `renderDrawer`/`renderBell` (now public — called from Dashboard,
   App._renderSettingsPane, and App's `alerts:change` subscriber).
   ========================================================================== */
export const AlertsUIAdapter = {
  _drawerVL: null as VirtualList<NimbusAlert> | null,
  // Jump to the task related to an alert (navigates to Gantt tab and focuses it
  // at day-level zoom so the alert context — surrounding orders, blackouts — is visible).
  focus(alertId: string) {
    const a = Store.alerts.find(x => x.id === alertId);
    if (!a) return;

    if (!a.taskId) {
      // Line/day-level alerts (overload, closed) carry no taskId — reuse the
      // dashboard heatmap's line+day navigation instead of silently no-oping.
      // Timeline.gotoLineDay already forces the Timeline sub-tab visible.
      if (a.line && a.time) Timeline.gotoLineDay(a.line, Util.dayKey(a.time));
      return;
    }

    NIMBUS!.App!.gotoGanttTimeline!();
    setTimeout(() => {
      const t = Store.tasks[a.taskId!];
      if (!t || !Timeline._tl) return;
      // 3-day window centered on the task's start — matches the Hour/Day/Week
      // toolbar's "day" mode (3 × 24h) so the segmented control stays honest.
      if (t.start_date) {
        const center = t.start_date.getTime();
        const start = new Date(center - 1.5 * 24 * Config.MS_HOUR);
        const end   = new Date(center + 1.5 * 24 * Config.MS_HOUR);
        Timeline._syncViewWindow(start.getTime(), end.getTime());
        Timeline._tl.setWindow(start, end, { animation: { duration: 300 } });
      }
      Timeline._tl.setSelection([String(a.taskId)]);
      Inspector.show(t);
      document.querySelectorAll<HTMLElement>('.gantt-toolbar .seg-btn[data-view]').forEach((b) => {
        b.classList.toggle('active', b.dataset.view === 'day');
      });
    }, 250);
  },

  // Open a categorized, scrollable cell-briefing modal listing the alerts for
  // a single (line, day) cell. Triggered by clicking a red/amber alert-cell
  // highlight on the Gantt.
  showForCell(line: string, dayKey: string) {
    const matches = Store.alerts.filter(a =>
      a.line === line && a.time && Util.dayKey(a.time) === dayKey);
    if (!matches.length) return;

    const day = new Date(dayKey + 'T12:00:00');
    const dateLabel = day.toLocaleDateString('en-US',
      { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();

    const esc = (s: unknown) => String(s == null ? '' : s).replace(/[&<>"']/g, (c: string) =>
      (({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' } as Record<string, string>)[c]));

    // -------- Cell context: scheduled hours, capacity, orders, changeovers
    const cellTasks = Store.tasksArr
      .filter(t => (t.PRODUCTION_LINE || 'Unknown') === line
                && t.start_date && Util.dayKey(t.start_date) === dayKey)
      .sort((a, b) => (a.start_date?.getTime() || 0) - (b.start_date?.getTime() || 0));
    const scheduledH = cellTasks.reduce((s, t) => s + Util.runHours(t), 0);
    const effCap   = Calendar.effectiveCapacityHours(line, day) || 0;
    const utilPct  = effCap > 0 ? scheduledH / effCap : 0;
    let changeovers = 0;
    for (let i = 1; i < cellTasks.length; i++) {
      const a = cellTasks[i-1], b = cellTasks[i];
      if ((a.COLOR || '') !== (b.COLOR || '') || (a.FORM_SIZE || '') !== (b.FORM_SIZE || '')) changeovers++;
    }

    // -------- Categorize alerts
    const CALENDAR_TYPES = new Set(['blackout', 'closed', 'fixed-closed', 'fixed-out-of-hours']);
    const CAT_MAP: Record<AlertType, string> = {
      overload:             'capacity',
      'near-capacity':      'capacity',
      overlap:              'conflicts',
      blackout:             'calendar',
      closed:               'calendar',
      'fixed-closed':       'calendar',
      'fixed-out-of-hours': 'calendar',
    };
    const byCat: Record<string, NimbusAlert[]> = { capacity: [], conflicts: [], calendar: [], exceptions: [] };
    for (const a of matches) byCat[CAT_MAP[a.type] || 'exceptions'].push(a);

    const errCt  = matches.filter(a => a.sev === 'err').length;
    const warnCt = matches.filter(a => a.sev === 'warn').length;
    const verdict = errCt > 0
      ? `${errCt} critical${warnCt ? ` · ${warnCt} warning${warnCt > 1 ? 's' : ''}` : ''}`
      : `${warnCt} warning${warnCt > 1 ? 's' : ''}`;
    const verdictSev = errCt > 0 ? 'err' : 'warn';

    // -------- Per-card renderers
    const sevIcon: Record<string, string> = { err: '✖', warn: '⚠', info: 'ℹ' };
    const taskPO = (id: string) => {
      const t = Store.tasks?.[id];
      return t ? (t.PRODUCTION_ORDER || t.text || String(id).slice(0, 8)) : String(id).slice(0, 8);
    };
    const taskFixed = (id: string) => !!Store.tasks?.[id]?.fixed;

    const renderChip = (id: string) => `
      <span class="ac-chip ${taskFixed(id) ? 'fixed' : ''}" title="${esc(id)}">${esc(taskPO(id))}</span>`;

    const renderCard = (a: NimbusAlert) => {
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

      const gotoBtn = (a.taskId || (a.line && a.time))
        ? `<button class="btn sm" data-act="goto" data-id="${esc(a.id)}">Go to</button>` : '';

      return `
        <div class="ac-card ${CALENDAR_TYPES.has(a.type) ? 'ac-card-calendar' : `ac-card-${a.sev}`}">
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

    const renderCategory = (key: string, label: string, alerts: NimbusAlert[]) => {
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
            <button class="ac-x" data-act="close" aria-label="${Util.t('btn.close')}">×</button>
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
          ${renderCategory('capacity',   'Capacity',              byCat.capacity)}
          ${renderCategory('conflicts',  'Scheduling Conflicts',  byCat.conflicts)}
          ${renderCategory('calendar',   'Calendar Restrictions', byCat.calendar)}
          ${renderCategory('exceptions', 'Other',                 byCat.exceptions)}
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

    dlg.addEventListener('click', (e: MouseEvent) => {
      const btn = (e.target as Element | null)?.closest('[data-act]') as HTMLElement | null;
      if (!btn) { if (e.target === dlg) dlg.close(); return; }
      const act = btn.dataset.act, aid = btn.dataset.id ?? '';
      if (act === 'close')   { dlg.close(); return; }
      if (act === 'goto')    { dlg.close(); AlertsUIAdapter.focus(aid); return; }
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
    if (isOpen) AlertsUIAdapter.renderDrawer();
  },

  _renderAlertRow(a: NimbusAlert): string {
    const CALENDAR_TYPES = new Set(['blackout', 'closed', 'fixed-closed', 'fixed-out-of-hours']);
    const sevIcon: Record<string, string> = { err: '✖', warn: '⚠', info: 'ℹ' };
    const esc = (s: unknown) => String(s == null ? '' : s).replace(/[&<>"']/g, (c: string) =>
      (({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' } as Record<string, string>)[c]));
    const isCalendar = CALENDAR_TYPES.has(a.type);
    const ico        = isCalendar ? '⊘' : (sevIcon[a.sev] || '•');
    const fixable  = ['overlap', 'blackout', 'overload'].includes(a.type);
    const override = (a.type === 'closed' || a.type === 'fixed-closed' || a.type === 'fixed-out-of-hours') && a.taskId != null;
    return `<div class="alert-row alert-${a.sev}${isCalendar ? ' alert-calendar' : ''}" data-id="${esc(a.id)}">` +
      `<span class="alert-ico">${ico}</span>` +
      `<span class="alert-msg">${esc(a.msg)}</span>` +
      `<div class="alert-actions">` +
        ((a.taskId != null || (a.line && a.time)) ? `<button class="btn btn-ghost sm" onclick="NIMBUS.AlertsUIAdapter.focus('${esc(a.id)}')">${Util.t('btn.go_to')}</button>` : '') +
        (fixable  ? `<button class="btn-fix" title="${Util.t('tip.fix_alert')}" onclick="NIMBUS.Alerts.applyFix('${esc(a.id)}')">${Util.t('btn.fix_it')}</button>` : '') +
        (override ? `<button class="btn btn-ghost sm" onclick="NIMBUS.AlertsUIAdapter.toggleDrawer();NIMBUS.Table._openOverrideModalForId('${esc(a.taskId)}')">${Util.t('btn.override')}</button>` : '') +
        `<button class="btn btn-ghost sm" onclick="NIMBUS.Alerts.dismiss('${esc(a.id)}')">${Util.t('btn.dismiss')}</button>` +
      `</div></div>`;
  },

  renderDrawer() {
    const body = document.getElementById('alert-drawer-body');
    if (!body) return;
    // Store._state.masterData direct touch — deliberate, out of scope for this
    // task (see the file header comment above OptimizeDialog's own identical read).
    const plantRow = Store._state.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null;
    const hz = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? null;
    const cutoff = typeof hz === 'number' ? new Date(Date.now() + hz * Config.MS_MIN) : null;
    // Scope to the selected plant's lines, matching Dashboard._renderAlertSummary —
    // otherwise an alert for another plant (reachable once the compute worker has
    // permanently fallen back to an unscoped sync recompute, see CLAUDE.md) can be
    // shown and clicked here even though Timeline/scrollToLine can't navigate to it.
    const plantLines = new Set(Store.linesForSelectedPlant());
    const timeFiltered = cutoff ? Store.alerts.filter(a => !a.time || a.time <= cutoff) : Store.alerts;
    const alerts = timeFiltered.filter(a => !a.line || plantLines.has(a.line));
    const hiddenCount = Store.alerts.length - timeFiltered.length;

    if (!alerts.length) {
      if (AlertsUIAdapter._drawerVL) { AlertsUIAdapter._drawerVL.destroy(); AlertsUIAdapter._drawerVL = null; }
      body.innerHTML = `<div class="empty-state" style="padding:24px;color:#888;">${Util.t('empty.no_active_alerts')}</div>`;
      return;
    }

    if (!AlertsUIAdapter._drawerVL) {
      body.innerHTML = '';
      AlertsUIAdapter._drawerVL = new VirtualList<NimbusAlert>(body, {
        rowH: VL_ALERT_ROW_H,
        renderFn: (a) => AlertsUIAdapter._renderAlertRow(a),
        mountEl: body,
      });
    }
    AlertsUIAdapter._drawerVL.update(alerts);

    if (hiddenCount > 0) {
      const hzDays = Math.max(1, Math.round((hz as number) / 1440));
      body.insertAdjacentHTML('beforeend',
        `<div style="padding:10px 16px;font-size:11.5px;color:var(--fg-mute);border-top:1px solid var(--border);">` +
        `${hiddenCount} alert${hiddenCount > 1 ? 's' : ''} beyond the ${hzDays}-day window hidden — adjust in System Settings.</div>`);
    }
  },
/* ----- BELL BADGE ------------------------------------------------------ */
  renderBell() {
    const badge = document.getElementById('alert-badge');
    const bell  = document.getElementById('alert-bell');
    // Store._state.masterData direct touch — same deliberate out-of-scope carve-out
    // as renderDrawer() above.
    const plantRow = Store._state.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null;
    const hz = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? null;
    const cutoff = typeof hz === 'number' ? new Date(Date.now() + hz * Config.MS_MIN) : null;
    const visible = cutoff ? Store.alerts.filter(a => !a.time || a.time <= cutoff) : Store.alerts;
    const n = visible.length;
    if (n > 0) {
      badge!.textContent = n > 99 ? '99+' : String(n);
      badge!.style.display = '';
      bell!.style.color = visible.some(a => a.sev === 'err') ? 'var(--err)' : 'var(--warn-text)';
    } else {
      badge!.style.display = 'none';
      bell!.style.color = '';
    }
  }
};

/* =============================================================================
   SANDBOX ADAPTER — thin app.js UI/side-effect layer over the state-only
   `Sandbox` module (state + snapshots now live in schedule-state.mjs). Owns
   the DOM banner/buttons and performs the cross-module side effects that
   used to be inline in Sandbox.exit() (Alerts recompute, Persistence save,
   CalendarSync flush/re-hydrate, Confidence snapshot/restore, Toast
   messages) by subscribing to the `sandbox:entered`/`sandbox:exited`
   (and `sandbox:reverted`, fired by the undo-a-promoted-scenario path)
   events the state module emits. This is new code, not a move — it is the
   thin UI/cross-module layer the design's ownership map calls out as
   belonging to `schedule-workbench.mjs` eventually; for Phase 1 it stays
   here as a boot-wired adapter.
   ========================================================================== */
export const SandboxAdapter = {
  _confSnapshot: null as unknown,

  init() {
    const banner = document.getElementById('sandbox-banner');
    if (!banner) return;
    banner.innerHTML = `
      <span style="font-size:14px;">🔮</span>
      <strong>${Util.t('ui.what_if_title')}</strong> ${Util.t('ui.what_if_sub')}
      <input class="sb-name" id="sb-scenario-name" placeholder="${Util.t('ph.name_scenario')}" value="${Util.t('ui.what_if_default_name')}">
      <div style="display:flex;gap:6px;margin-left:auto;">
        <button class="btn btn-ghost sm" id="sb-discard-btn">${Util.t('ui.discard_btn')}</button>
        <button class="btn btn-primary sm" id="sb-apply-btn">${Util.t('ui.promote_btn')}</button>
      </div>`;
    document.getElementById('sb-discard-btn')?.addEventListener('click', () => Sandbox.exit(false, 'sandbox-ui'));
    document.getElementById('sb-apply-btn')?.addEventListener('click',  () => Sandbox.exit(true, 'sandbox-ui'));

    Store.subscribe(evt => {
      if (evt.type === 'sandbox:entered') SandboxAdapter._onEntered();
      else if (evt.type === 'sandbox:exited') SandboxAdapter._onExited(evt);
      else if (evt.type === 'sandbox:reverted') SandboxAdapter._onReverted();
    }, 'SandboxAdapter');
  },

  enter() {
    if (Sandbox.active) { Toast.show(Util.t('toast.already_in_sandbox'), 'warn'); return; }
    Sandbox.enter('sandbox-ui');
  },

  _onEntered() {
    // So a discarded what-if session leaves no trace in the confidence tracker,
    // same as a discarded optimizer preview (see OptimizerPreview._confSnapshot).
    // Captured here (not in Sandbox.enter()) at the same logical moment as before —
    // the state module doesn't know about the cross-file Confidence module.
    SandboxAdapter._confSnapshot = NIMBUS!.Confidence?.snapshot?.() ?? null;

    document.body.classList.add('sandbox-mode');
    const banner = document.getElementById('sandbox-banner');
    if (banner) banner.hidden = false;

    document.querySelectorAll<HTMLElement>('.sandbox-btn').forEach((btn) => {
      btn.textContent = Util.t('ui.sandbox_on');
      btn.style.color = 'var(--warn)';
      btn.onclick = null;
    });

    Toast.show(Util.t('toast.what_if_mode'), 'info', 1500);
  },

  _onExited(evt: StoreEvent) {
    const applied = !!evt.applied;
    const snap = evt.snapshot as SandboxExitSnapshot | undefined;

    if (applied) {
      const scenarioName = (document.getElementById('sb-scenario-name') as HTMLInputElement | null)?.value || 'What-If';
      Toast.show(Util.t('toast.scenario_applied', { name: scenarioName }), 'success');
    } else {
      if (NIMBUS!.Confidence && SandboxAdapter._confSnapshot) NIMBUS!.Confidence!.restore!(SandboxAdapter._confSnapshot);
      Alerts.scheduleRecompute();
      Toast.show(Util.t('toast.scenario_discarded'), 'info');
    }
    SandboxAdapter._confSnapshot = null;

    document.body.classList.remove('sandbox-mode');
    const banner = document.getElementById('sandbox-banner');
    if (banner) banner.hidden = true;

    document.querySelectorAll<HTMLElement>('.sandbox-btn').forEach((btn) => {
      btn.textContent = Util.t('ui.sandbox_off');
      btn.style.color = '';
      btn.onclick = () => SandboxAdapter.enter();
    });

    // Promote is an explicit user action, so persist it (cache + backend) the same
    // way Cmd/Ctrl+S-in-sandbox already does. Runs AFTER teardown (Sandbox.active is
    // now false) so saveAll's own Sandbox.exit(true) call no-ops — no recursion.
    // Without this, "Scenario applied" showed but a reload before a later unrelated
    // save lost the promoted edits (autosave is suppressed during sandbox).
    if (applied) {
      NIMBUS!.Persistence!.saveAll!();
      // Calendar/blackout writes were suppressed during What-If (CalendarSync._post
      // guards on Sandbox.active); push the promoted config now that active=false.
      // Diff the pre-sandbox snapshot to also propagate blackouts DELETED in-session,
      // so a delete-then-promote doesn't resurrect the block on next hydration. (F3)
      if (Store.selectedPlant) {
        const plant = Store.selectedPlant;
        // Store._state.blocks/.plantBlocks direct touch — deliberate, out of scope
        // for this task (see the file header comment above OptimizeDialog).
        const curLine  = new Set(Store._state.blocks.filter((b) => b.plant === plant).map((b) => b.id));
        const curPlant = new Set(Store._state.plantBlocks.filter((b) => b.plant === plant).map((b) => b.id));
        const removed = {
          line:  (snap?.blocks || []).filter((b) => b.plant === plant && !curLine.has(b.id)).map((b) => b.id),
          plant: (snap?.plantBlocks || []).filter((b) => b.plant === plant && !curPlant.has(b.id)).map((b) => b.id),
        };
        CalendarSync.flushPlant(plant, removed);
      }
    }

    // If a plant-config hydration was dropped because its GET resolved mid-What-If (F2),
    // re-apply it now that Sandbox is inactive. On DISCARD we pull backend truth (the
    // restored snapshot is the pre-hydration cached state); on promote the user's edits
    // were just flushed, so skip to avoid re-clobbering them.
    const deferred = CalendarSync._deferredHydrationPlant;
    CalendarSync._deferredHydrationPlant = null;
    if (deferred && !applied && deferred === Store.selectedPlant) {
      CalendarSync.fetchPlantConfig(deferred);
    }
  },

  // Fired when the user undoes a PROMOTED (applied=true) scenario via UndoStack —
  // Sandbox.exit()'s undo closure (in schedule-state.mjs) restores tasks/fixedIds
  // then emits this instead of calling Alerts/Toast directly (those are cross-module
  // concerns the state module doesn't own). Matches the pre-refactor inline behavior.
  _onReverted() {
    Alerts.scheduleRecompute();
    Toast.show(Util.t('toast.scenario_discarded'), 'info');
  },
};

/* =============================================================================
   PRINTER — Order list export modal with date range selector.
   Opens a modal with From/To date pickers, renders a filterable table of
   orders sorted by production line then start date, and supports CSV export
   and browser print.
   ========================================================================== */
export const Printer = {
  _rows: [] as NimbusTask[], // last previewed rows, used by exportCsv()
  _fpStart: null as NimbusVendor.FlatpickrInstance | null,
  _fpEnd: null as NimbusVendor.FlatpickrInstance | null,

  open() {
    const scheduled = Store.tasksArr.filter(t => t.start_date && t.end_date);
    const today = new Date();
    let defStart = today;
    let defEnd   = new Date(today); defEnd.setDate(today.getDate() + 7);
    if (scheduled.length) {
      defStart = new Date(Math.min(...scheduled.map(t => t.start_date!.getTime())));
      defEnd   = new Date(Math.max(...scheduled.map(t => t.end_date!.getTime())));
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
    Printer._fpStart?.setDate(defStart, false);
    Printer._fpEnd?.setDate(defEnd, false);
    Modal.open('modal-print');
    Printer.preview();
  },

  preview() {
    const startVal = (document.getElementById('print-start') as HTMLInputElement | null)?.value;
    const endVal   = (document.getElementById('print-end') as HTMLInputElement | null)?.value;
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
      host.innerHTML = `<p style="color:var(--text-muted);font-size:13px;">${Util.t('empty.printer_no_orders')}</p>`;
      return;
    }

    const pad2 = (n: number) => String(n).padStart(2, '0');
    const fmtDt = (d: Date | null) => {
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
    if (!Printer._rows.length) { Toast.show(Util.t('toast.nothing_to_export'), 'warn'); return; }
    const fmtDt = (d: Date | null) => d ? d.toISOString().slice(0, 16).replace('T', ' ') : '';
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
