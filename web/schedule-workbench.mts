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
// Architecture section named (`_bulkFirm(true)`, `_bulkFirm(false)`,
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
// header comment ("Firmed orders are reverted in the DataSet and never reach
// the Store") does not match the actual code — a genuine drag on a firmed
// order falls through to the same commit path as a non-firmed drag; only a
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
import { Config, Util, PerfMonitor, ErrorLog, Toast, Modal, VirtualList } from './platform/foundation.mjs';
import { Store, Selection, UndoStack, Sandbox } from './schedule-state.mjs';
import type { StoreEvent } from './schedule-state.mjs';
import { Calendar, Utilization, Alerts, Engine, snapshotSchedule, deriveSetupObservation, SETUP_AWARE_DEADLINE_MS, scheduleAlertsForPatches, effectiveFirmedIdSet } from './schedule-services.mjs';
import type { RemoveBacklogResult, SetupObservation } from './schedule-services.mjs';
import { applyPatchesToSnapshot, evaluateSchedule } from './optimization/setup-scheduler.mjs';
import type { CandidateDiagnostic, CandidateReason, CandidateResult } from './optimization/setup-scheduler.mjs';
import { resolveSetup, stateForOrder } from './setup/setup-domain.mjs';
import { Session, Persistence, CalendarSync } from './schedule-data.mjs';
import { SetupAdmin } from './setup/setup-admin.mjs';
import type { NimbusTask, NimbusBlock, NimbusPlantBlock, AlertType, AlertSev, UtilSevBucket, OptimizerMode, WorkHours, PriorityListEntry, PriorityListResponse, SplitOrderPolicy, TimelineItemKind, SetupSnapshot, SetupStateKey, SetupOccurrenceOverride } from './platform/types.mjs';
import { ORDER_FIELD_CATALOG } from './scheduling/order-field-catalog.mjs';

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
  /** Absent on the ungrouped day-boundary gridlines built inline in
   *  Timeline.rebuild() — every other item (order/blackout/zone/setup)
   *  belongs to a machine line group. */
  group?: string;
  kind: TimelineItemKind;
  /** Every displayed item resolves back to this one logical order. Segment
   * pieces use an internal item id but never become their own business IDs. */
  parentId?: string;
  segmentNumber?: number;
  segmentCount?: number;
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
  setup?: SetupPresentationDetail;
  style?: string;
}

interface SetupPresentationDetail {
  predecessorOrderId: string | null;
  predecessorState: string | null;
  successorOrderId: string;
  requiredMinutes: number | null;
  effectiveMinutes: number | null;
  standardMinutes: number | null;
  source: string | null;
  overrideStatus: string | null;
  availableMinutes: number | null;
  shortMinutes: number | null;
  missingDetail: string | null;
}

/** Setup diagnostic type → presentation label/marker class. The single source
 *  of truth for how each of the six diagnostic causes is described to the
 *  user — shared by Timeline._setupItemsForObservation's marker rendering and
 *  Inspector._setupDetailForTask's explanatory fallback text so the mapping
 *  is never duplicated. Unknown/absent types fall back to 'ui.setup_missing'. */
const SETUP_DIAGNOSTIC_PRESENTATION: Record<string, { i18nKey: string; extraClass: string }> = {
  'initial-state-unknown':     { i18nKey: 'ui.setup_state_unrecorded',     extraClass: 'setup-unrecorded' },
  'predecessor-state-unknown': { i18nKey: 'ui.setup_pred_attrs_missing',   extraClass: 'setup-unrecorded' },
  'successor-state-unknown':   { i18nKey: 'ui.setup_order_attrs_missing', extraClass: 'setup-unrecorded' },
  'setup-uncovered':           { i18nKey: 'ui.setup_missing',             extraClass: '' },
  'current-state-diverged':    { i18nKey: 'ui.setup_state_diverged',      extraClass: '' },
  'override-inactive':         { i18nKey: 'ui.setup_override_stale',      extraClass: '' },
};

function setupDiagnosticLabel(type: string | undefined | null): string {
  const entry = type ? SETUP_DIAGNOSTIC_PRESENTATION[type] : undefined;
  return Util.t(entry ? entry.i18nKey : 'ui.setup_missing');
}

/** D4: the resolveSetup() 'source' field is raw plumbing (`'line'|'plant'|
 * 'occurrence'|'implicit-zero'|'uncovered'`), displayed verbatim in the
 * Inspector's Source row for every value except 'implicit-zero' — that one
 * value gets a translated label so an identical-signature no-change
 * transition never reads as though a matrix row had been consulted. */
function setupSourceLabel(source: string | null | undefined): string {
  return source === 'implicit-zero' ? Util.t('ui.setup_source_no_change') : (source || '');
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
  _frozenHorizonIds: [] as string[],        // C2 (2026-08-20): frozen-horizon zone ids, re-advanced by the same ticker below
  _rebuildNow: null as Date | null,         // P2: hoisted clock so every item in one rebuild() pass classifies firming against the same instant
  _frozenBandIds: null as Set<string> | null, // P2: task ids currently inside the frozen horizon band, for live repaint diffing
  _lastFirmScanTs: 0,                       // P2: throttle for the coarse 30s frozen-band rescan in the 1s ticker
  _visibilityHorizonMarker: false,          // C1: tracks whether the 'visibility-horizon' custom time bar has been added to _tl (addCustomTime/removeCustomTime throw on a duplicate/missing id)
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
  _healScheduled: false,
  // Remembered vertical scroll offset (vis-timeline's internal scrollTop
  // convention — see _setVScroll/_getVScroll). Replaces the old one-shot
  // _initialVerticalScrollPending guard: "start at the top" is simply the
  // initial value 0, and — unlike the old guard, which only ever fired
  // once — it is now re-applied (clamped) on EVERY rebuild, right after
  // _fitHeight() sets the new height. An explicit navigation (scrollToLine,
  // Part B's alert focus) overwrites this directly so a subsequent rebuild
  // restores to the just-navigated position instead of fighting it.
  _vScrollTop: 0,
  _itemIdsByTask: {} as Record<string, string[]>,

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
        if (item.type === 'background') return true;
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
    const _refreshView = Util.debounce(() => Timeline._refreshViewNow(), 120);
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

    // Geometry self-heal: vis-timeline's per-group BackgroundItem.repositionY()
    // can leave a grouped background band (past-zone/alert-horizon-zone/
    // frozen-horizon-zone/alertcell-*) at 0px height or hidden when its group
    // has no visible foreground item at the current zoom (the faee810 bug
    // class). rAF-coalesced so a burst of 'changed' events in one frame only
    // runs the pass once.
    Timeline._tl.on('changed', () => {
      if (Timeline._healScheduled) return;
      Timeline._healScheduled = true;
      requestAnimationFrame(() => {
        Timeline._healScheduled = false;
        Timeline._healBackgroundBands();
      });
    });

    /* -----------------------------------------------------------------
     * NOTE: Input events (select/click, doubleClick, contextmenu, and
     * DataSet drag commits) are ALL owned by the Interaction module.
     * This module only owns the view, the store subscription, and the
     * redraw/rebuild plumbing. Keeping input-handling in one place is
     * what eliminates the select↔setSelection echo loop that made firmed
     * orders look like they were being re-scheduled on every click.
     * ----------------------------------------------------------------- */

    /* ----- live ticker: advance past-zone, alert-horizon-zone, and the C2
     * frozen-horizon-zone every second (one interval, shared — never add a
     * second one for a new band) -- */
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
      // C2: only the near edge tracks "now" — the far edge (Store.frozenHorizonEnd)
      // is a fixed absolute instant recomputed server-side on the next /tasks
      // load, not a rolling duration, so it is deliberately left alone here.
      if (Timeline._frozenHorizonIds.length && Store.frozenHorizonEnd) {
        const frozenEnd = Store.frozenHorizonEnd;
        for (const id of Timeline._frozenHorizonIds) {
          if (Timeline._items!.get(id)) updates.push({ id, start: now, end: frozenEnd });
        }
      }
      if (updates.length) Timeline._items!.update(updates);

      // P2: coarse 30s scan for orders crossing the frozen-horizon band —
      // symmetric diff against the last-known membership set. Orders leave
      // the band as "now" advances past them; new members appear when the
      // server recomputes frozen_horizon_end on the next /tasks refetch.
      // Also self-heals if the horizon changes mid-session. Cache-only boots
      // have frozenHorizonEnd null until the first /tasks fetch, matching
      // the band's own absence in that state.
      if (Date.now() - Timeline._lastFirmScanTs > 30_000) {
        Timeline._lastFirmScanTs = Date.now();
        const scanNow = new Date();
        const next = new Set<string>();
        for (const t of Store.tasksByPlant(Store.selectedPlant)) if (Engine.isFrozenHorizon(t, scanNow)) next.add(String(t.id));
        const prev = Timeline._frozenBandIds;
        if (prev) {
          for (const id of prev) if (!next.has(id)) Timeline._applyTaskPatch(id);
          for (const id of next) if (!prev.has(id)) Timeline._applyTaskPatch(id);
        }
        Timeline._frozenBandIds = next;
      }
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

  /** Self-heal grouped background-item geometry after every vis 'changed'
   *  redraw (see the init() hook). vis-timeline's own repositionY() sometimes
   *  leaves a grouped background band (past-zone/alert-horizon-zone/
   *  frozen-horizon-zone/alertcell-*) at 0px height or hidden when its group
   *  currently has no visible foreground item — the white-row regression
   *  the faee810 CSS revert deferred. This supplies the same per-row pixel
   *  geometry vis's own repositionY() would, straight from JS.
   *
   *  Ungrouped background items (the day-boundary gridlines added by
   *  rebuild()) are hard-skipped: their parent is the library's reserved
   *  BackgroundGroup, whose top/height are hardwired to 0 and already sized
   *  correctly by the library itself — healing those would 0-height them.
   *
   *  Also re-runs X-only layout for foreground order bars ('order'/
   *  'order-segment'). vis-timeline's internal redraw can leave a foreground
   *  item's horizontal position stale during continuous panning at low (Day)
   *  zoom, drifting outside the background band healed above — self-
   *  correcting only on zoom-in. Mirrors the background heal but touches only
   *  X; vertical layout is unaffected and left alone.
   *
   *  Entirely best-effort: wrapped in try/catch so any internal-API surprise
   *  degrades to a silent no-op rather than throwing into the render path. */
  _healBackgroundBands(): void {
    if (!Timeline._tl || !Timeline._ganttActive()) return;
    try {
      const tlInternal = Timeline._tl as unknown as VisInternalTimeline;
      const items = tlInternal.itemSet?.items;
      if (!items) return;
      const win = Timeline._tl.getWindow();
      const winStart = win.start.getTime();
      const winEnd = win.end.getTime();
      for (const id of Object.keys(items)) {
        const item = items[id];
        if (!item) continue;
        const data = item.data;
        if (!data) continue;
        const start = data.start instanceof Date ? data.start.getTime() : +(data.start ?? NaN);
        const end   = data.end   instanceof Date ? data.end.getTime()   : +(data.end ?? NaN);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        if (end <= winStart || start >= winEnd) continue; // no window intersection

        if (data.type !== 'background') {
          // Foreground order bar: heal X position only (see doc comment above).
          item.repositionX?.();
          continue;
        }
        if (data.group == null) continue; // reserved BackgroundGroup gridlines — never heal these
        const parent = item.parent;
        if (!parent || !Number.isFinite(parent.top) || !Number.isFinite(parent.height)) continue;
        if (parent.isVisible === false) continue; // respect vertical-scroll culling
        if (!item.displayed) {
          item.show?.();
          item.repositionX?.();
        }
        const box = item.dom?.box;
        if (box) {
          box.style.top = parent.top + 'px';
          box.style.height = parent.height + 'px';
        }
      }
    } catch {
      // Best-effort only — never let a vis-internal-API surprise reach the render path.
    }
  },

  /** Handle store updates: refresh vis-timeline WITHOUT echoing back. */
  _onStore(evt: StoreEvent): void {
    // Ignore our own mutations — we already applied them visually.
    if (evt.source === 'timeline') {
      const ids = evt.type === 'tasks:bulkUpdate'
        ? ((evt.ids as Array<string | number> | undefined) ?? []).map(String)
        : evt.type === 'task:update' && evt.id != null ? [String(evt.id)] : [];
      if (ids.some(id => Timeline.hasMultipleItemsForTask(id)) && Timeline._ganttActive()) {
        Timeline._scheduleRebuild();
      }
      return;
    }

    if (evt.type === 'plant:selected') {
      if (Timeline._ganttActive()) {
        Timeline.rebuild();
      } else {
        Timeline._renderEmptyOverlay();
      }
      return;
    }

    if (evt.type === 'tasks:bulk' || evt.type === 'blocks:change'
        || evt.type === 'calendar:change' || evt.type === 'plantBlocks:change'
        || evt.type === 'setup-snapshot:replace') {
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
        if (ids.some(id => Timeline.hasMultipleItemsForTask(id))) {
          Timeline._scheduleRebuild();
          return;
        }
        for (const id of ids) {
          const sid = String(id);
          if (filtered) {
            const t = Store.tasks[sid];
            if (!t || !sel!.has(t.MACHINE || 'Unknown')) continue;
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
    } else if (evt.type === 'firmed:change') {
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
    return Timeline._itemsForTask(t)[0] || null;
  },

  _applyTaskPatch(id: string): void {
    if (Timeline.hasMultipleItemsForTask(id)) {
      Timeline._scheduleRebuild();
      return;
    }
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

  _segmentItemId(taskId: string, sequence: number): string {
    return `order-segment:${encodeURIComponent(taskId)}:${sequence}`;
  },

  /** Resolve any internal vis item ID back to the logical parent order. */
  parentTaskIdForItem(itemId: string | number): string {
    const id = String(itemId);
    const dataSet = Timeline._items as (NimbusVendor.VisDataSet<TimelineVisItem> | { get?: (id: string) => TimelineVisItem | null | undefined } | null);
    const item = (typeof dataSet?.get === 'function' ? dataSet.get(id) : null) as TimelineVisItem | null | undefined;
    return item?.parentId || id;
  },

  /** Presentation artifacts never cross into selection, editing, dependency,
   * drag, or context-menu business paths. */
  businessOrderIdForItem(itemId: string | number): string | null {
    const id = String(itemId);
    const dataSet = Timeline._items as (NimbusVendor.VisDataSet<TimelineVisItem> | { get?: (id: string) => TimelineVisItem | null | undefined } | null);
    const item = (typeof dataSet?.get === 'function' ? dataSet.get(id) : null) as TimelineVisItem | null | undefined;
    if (item?.kind && item.kind !== 'order' && item.kind !== 'order-segment') return null;
    const orderId = item?.parentId || id;
    return Store.tasks[orderId] ? orderId : null;
  },

  /** Item IDs currently representing one logical parent. The derived fallback
   * keeps focus/selection correct before a fresh rebuild updates the cache. */
  itemIdsForTask(taskId: string | number): string[] {
    const id = String(taskId);
    const cached = Timeline._itemIdsByTask[id];
    if (cached?.length) return [...cached];
    const task = Store.tasks[id];
    if (task?.scheduleSegments && task.scheduleSegments.length >= 2) {
      return task.scheduleSegments.map(segment => Timeline._segmentItemId(id, segment.sequence));
    }
    return [id];
  },

  hasMultipleItemsForTask(taskId: string | number): boolean {
    const id = String(taskId);
    return (Timeline._itemIdsByTask[id]?.length || Store.tasks[id]?.scheduleSegments?.length || 1) >= 2;
  },

  /** Build one visual item per productive interval while retaining a parent
   * mapping on every item. Continuous legacy orders still produce one item. */
  _itemsForTask(t: NimbusTask): TimelineVisItem[] {
    const base = Timeline._itemForTask(t);
    const parentId = String(t.id);
    const segments = Array.isArray(t.scheduleSegments) && t.scheduleSegments.length >= 2
      ? t.scheduleSegments : null;
    if (!segments) {
      return [{ ...base, parentId }];
    }
    const count = segments.length;
    return segments.map((segment, index) => {
      const durationHours = (segment.endDate.getTime() - segment.startDate.getTime()) / Config.MS_HOUR;
      const classNames = [base.className || '', 'split-order-segment'];
      classNames.push(index === 0 ? 'split-order-segment-first' : 'split-order-segment-continuation');
      if (index === count - 1) classNames.push('split-order-segment-last');
      return {
        ...base,
        kind: 'order-segment',
        id: Timeline._segmentItemId(parentId, segment.sequence),
        parentId,
        segmentNumber: index + 1,
        segmentCount: count,
        start: segment.startDate,
        end: segment.endDate,
        className: classNames.filter(Boolean).join(' '),
        content: index === 0 ? base.content : `<span class="split-order-part">${index + 1}/${count}</span>`,
        title: `Segment ${index + 1} of ${count} - ${durationHours.toFixed(2)}h productive\\n${Util.fmtDTReadable(segment.startDate)} → ${Util.fmtDTReadable(segment.endDate)}`,
      };
    });
  },

  /** Build an item object for a task. */
  _itemForTask(t: NimbusTask): TimelineVisItem {
    const line = t.MACHINE || 'Unknown';
    const firmed = Engine.firmingStatus(t, Timeline._rebuildNow || undefined).firmed;
    const conflict = Timeline._conflictIds().has(String(t.id));
    const label = t.text || t.ORDER || String(t.id);
    const cls = [firmed ? 'order-firmed' : 'order-standard'];
    if (conflict) cls.push('conflict-order');
    const prefix = firmed ? '🔒 ' : '';
    return {
      id:      String(t.id),
      group:   line,
      kind:    'order',
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
      kind:    'blackout',
      content: `<span style="font-style:italic;">✕ ${b.reason || Util.t('ui.blackouts_label', {plural: ''})}</span>`,
      title:   `${Util.t('ui.blackouts_label', {plural: ''})}: ${b.reason || '—'}<br>${Util.fmtDTReadable(b.start)} → ${Util.fmtDTReadable(b.end)}`,
      start:   b.start as Date, end: b.end as Date,
      editable: false,
      className: 'blackout',
      type: 'background'
    };
  },

  // Same availability context Alerts._recomputeSync passes: without it,
  // setupAvailabilityMinutes' no-context fallback measures from the
  // predecessor's end, which is null for a line's first order and renders a
  // false "setup-conflict" on every line's first setup with no alert to match.
  _setupObservation(tasks: ReadonlyArray<NimbusTask>): SetupObservation {
    return deriveSetupObservation(Store.setupSnapshot, tasks, undefined, {
      calendars: Store.calendars, plants: Store.plants, lineSettings: Store.lineSettings,
      masterData: Store.masterData, blocks: Store.blocks, plantBlocks: Store.plantBlocks,
    });
  },

  /** Render Task 4's immutable setup facts only. This code never calls Engine
   * or Store mutators, and does not create a pseudo-order. */
  _setupItemsForObservation(tasks: ReadonlyArray<NimbusTask>, observation: SetupObservation): TimelineVisItem[] {
    const byId = new Map(tasks.map(task => [String(task.id), task]));
    const items: TimelineVisItem[] = [];
    const positiveSuccessors = new Set<string>();
    const detailFor = (entry: any, missingDetail: string | null = null): SetupPresentationDetail => ({
      predecessorOrderId: entry.predecessorOrderId ?? null,
      predecessorState: entry.predecessorState ?? null,
      successorOrderId: String(entry.successorOrderId),
      requiredMinutes: Number.isFinite(entry.requiredMinutes) ? entry.requiredMinutes : null,
      effectiveMinutes: Number.isFinite(entry.effectiveMinutes) ? entry.effectiveMinutes : (Number.isFinite(entry.requiredMinutes) ? entry.requiredMinutes : null),
      standardMinutes: Number.isFinite(entry.standardMinutes) ? entry.standardMinutes : (Number.isFinite(entry.requiredMinutes) ? entry.requiredMinutes : null),
      source: entry.source || 'resolved', overrideStatus: entry.overrideStatus || null,
      availableMinutes: Number.isFinite(entry.availableMinutes) ? entry.availableMinutes : null,
      shortMinutes: Number.isFinite(entry.availableMinutes) && Number.isFinite(entry.requiredMinutes) && entry.availableMinutes < entry.requiredMinutes
        ? entry.requiredMinutes - entry.availableMinutes : null,
      missingDetail,
    });
    for (const interval of observation.intervals || []) {
      const required = Number(interval.requiredMinutes);
      const start = new Date(interval.start), end = new Date(interval.end);
      if (!Number.isFinite(required) || required <= 0 || !(start < end)) continue;
      const successorId = String(interval.successorOrderId || '');
      if (!byId.has(successorId)) continue;
      positiveSuccessors.add(successorId);
      const conflict = Number.isFinite(interval.availableMinutes) && interval.availableMinutes < required;
      const detail = detailFor(interval);
      items.push({
        id: `setup:${encodeURIComponent(interval.line)}:${encodeURIComponent(interval.predecessorOrderId ?? 'initial')}:${encodeURIComponent(successorId)}`,
        kind: 'setup', group: interval.line, start, end, editable: false,
        className: `setup-item${conflict ? ' setup-conflict' : ''}`,
        style: '',
        content: `<span aria-hidden="true">${required}m</span>`,
        title: `${Util.t('ui.setup_detail_title')}: ${required} min`, setup: detail,
      });
    }
    const marked = new Set<string>();
    for (const diagnostic of observation.diagnostics || []) {
      // D4: 'setup-no-change' is an honest-detail-only fact (identical-
      // signature, zero-minute, covered transition) — it must never render as
      // a "!" marker bar. That marker is reserved for the genuinely different
      // case (uncovered signature, no matrix row), which is a distinct
      // diagnostic type and unaffected by this exclusion.
      if (diagnostic.type === 'setup-no-change') continue;
      const successorId = diagnostic.successorOrderId ? String(diagnostic.successorOrderId) : '';
      const successor = byId.get(successorId);
      const markKey = `${diagnostic.line}|${successorId}`;
      if (!successor || positiveSuccessors.has(successorId) || marked.has(markKey)) continue;
      const start = Array.isArray(successor.scheduleSegments) && successor.scheduleSegments.length >= 2
        ? successor.scheduleSegments[0].startDate : successor.start_date;
      if (!start) continue;
      const end = new Date(start);
      if (!Number.isFinite(end.getTime())) continue;
      marked.add(markKey);
      const label = setupDiagnosticLabel(diagnostic.type);
      const extraClass = (diagnostic.type && SETUP_DIAGNOSTIC_PRESENTATION[diagnostic.type]?.extraClass) || '';
      const detail = detailFor(diagnostic, diagnostic.message || label);
      items.push({
        id: `setup-missing:${encodeURIComponent(diagnostic.line)}:${encodeURIComponent(successorId)}`,
        kind: 'setup', group: diagnostic.line, start: new Date(end.getTime() - 10 * Config.MS_MIN), end, editable: false,
        className: `setup-item setup-missing${extraClass ? ` ${extraClass}` : ''}`, style: '',
        content: `<span class="setup-missing-marker" role="img" aria-label="${label}">!</span>`,
        title: `${label}: ${detail.missingDetail}`, setup: detail,
      });
    }
    return items;
  },

  /** A move invalidates adjacency-derived setup on only its source/target
   * lines; production patching remains owned by the Store subscriber. */
  rebuildSetupForLines(lines: ReadonlySet<string>): void {
    if (!Timeline._items || typeof Timeline._items.getIds !== 'function' || !lines.size) return;
    const _deriveT0 = performance.now();
    const tasks = Store.tasksForSelectedPlant().filter(task => (
      lines.has(task.MACHINE || 'Unknown') && task.start_date && task.end_date
    ));
    const desired = new Map(Timeline._setupItemsForObservation(tasks, Timeline._setupObservation(tasks))
      .map(item => [String(item.id), item] as const));
    PerfMonitor.record('Timeline.setup.derive', performance.now() - _deriveT0);
    const _diffT0 = performance.now();
    const current = Timeline._items.getIds().map(String).filter(id => {
      const item = Timeline._items!.get(id) as TimelineVisItem | null;
      return item?.kind === 'setup' && !!item.group && lines.has(item.group);
    });
    const currentIds = new Set(current);
    const add: TimelineVisItem[] = [], update: TimelineVisItem[] = [], remove: string[] = [];
    for (const [id, item] of desired) (currentIds.has(id) ? update : add).push(item);
    for (const id of current) if (!desired.has(id)) remove.push(id);
    PerfMonitor.record('Timeline.setup.diff', performance.now() - _diffT0);
    const _redrawT0 = performance.now();
    Timeline._suppressEvents = true;
    try {
      if (remove.length) Timeline._items.remove(remove);
      if (update.length) Timeline._items.update(update);
      if (add.length) Timeline._items.add(add);
    } finally { Timeline._suppressEvents = false; }
    Timeline._tl?.redraw();
    PerfMonitor.record('Timeline.setup.redraw', performance.now() - _redrawT0);
  },

  _dragSetupLines: new Set<string>(),
  /** Presentation-only: called from vis' per-frame drag callback. */
  dimSetupForDrag(lines: ReadonlySet<string>): void {
    if (!Timeline._items || typeof Timeline._items.getIds !== 'function') return;
    const newlyAffected = new Set([...lines].filter(line => !Timeline._dragSetupLines.has(line)));
    if (!newlyAffected.size) return;
    for (const line of newlyAffected) Timeline._dragSetupLines.add(line);
    const updates = Timeline._items.getIds().map(String).flatMap(id => {
      const item = Timeline._items!.get(id) as TimelineVisItem | null;
      return item?.kind === 'setup' && !!item.group && newlyAffected.has(item.group)
        ? [{ id, className: `${item.className || 'setup-item'} setup-drag-dim`, style: 'opacity:0.18;' }]
        : [];
    });
    if (!updates.length) return;
    Timeline._suppressEvents = true;
    try { Timeline._items.update(updates); } finally { Timeline._suppressEvents = false; }
  },

  finishSetupDrag(extraLines: ReadonlySet<string> = new Set()): void {
    const lines = new Set(Timeline._dragSetupLines);
    for (const line of extraLines) lines.add(line);
    Timeline._dragSetupLines.clear();
    Timeline.rebuildSetupForLines(lines);
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
    // Capture whatever vertical position the user is actually at right now
    // (before the group/item diff below can shrink content and clamp it) —
    // this is what _vScrollTop gets re-applied to at the end of rebuild(),
    // so a plain re-render preserves position same as before. An explicit
    // navigation between now and the restore below (scrollToLine et al.)
    // overwrites _vScrollTop directly and wins, since it runs later.
    if (Timeline._tl) Timeline._vScrollTop = Timeline._getVScroll();
    const all = Store.tasksForSelectedPlant();
    const tasks = all.filter(t => t.start_date && t.end_date);
    const dropped = all.length - tasks.length;
    if (dropped > 0) {
      ErrorLog.warn('timeline',
        `Rebuild: ${dropped} task(s) hidden (missing start/end)`,
        all.filter(t => !(t.start_date && t.end_date))
           .slice(0, 10)
           .map(t => ({ id: t.id, line: t.MACHINE, text: t.text })));
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
      ? tasks.filter(t => visibleSet.has(t.MACHINE || 'Unknown'))
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
    // Hoisted clock: every item derived in this pass classifies its firming
    // status against the same instant (see _itemForTask). _itemPatchFor /
    // _applyTaskPatch run outside a full rebuild and may see this go stale —
    // that's fine, they fall back to "live now" when it's null.
    Timeline._rebuildNow = new Date();
    const desired = new Map<string, TimelineVisItem>();
    const itemIdsByTask: Record<string, string[]> = {};
    for (const t of scopedTasks) {
      const taskId = String(t.id);
      const items = Timeline._itemsForTask(t);
      itemIdsByTask[taskId] = items.map(item => String(item.id));
      for (const item of items) {
        // Apply the pre-computed conflict flag without walking alerts again.
        if (conflictIds.has(taskId)) {
          const cls = (item.className || '').split(' ').filter(Boolean);
          if (!cls.includes('conflict-order')) cls.push('conflict-order');
          item.className = cls.join(' ');
        }
        desired.set(String(item.id), item);
      }
    }
    // Setup bars are a transient rendering of the current observation. They are
    // intentionally absent from itemIdsByTask so selection/focus stays on orders.
    for (const item of Timeline._setupItemsForObservation(scopedTasks, Timeline._setupObservation(scopedTasks))) {
      desired.set(item.id, item);
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
        kind:     'zone',
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
            kind:      'zone',
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

    // C2 (2026-08-20): frozen-horizon zone — darker green band from now through
    // the plant's frozen-horizon end (Store.frozenHorizonEnd, already computed
    // server-side by db.compute_frozen_horizon_end — see schedule-data.mts),
    // one per visible line, inserted AFTER (so painted above, DOM order = paint
    // order) the alert-horizon zone above. Unlike that band, the far edge here
    // is a fixed absolute instant, not a rolling now+duration window — only the
    // near edge tracks "now" (see the ticker below). Absent when the plant has
    // no frozen window (frozen_horizon_days NULL/0 -> Store.frozenHorizonEnd null).
    {
      const frozenEnd = Store.frozenHorizonEnd;
      if (frozenEnd) {
        const frozenNow = new Date();
        for (const line of visibleLines) {
          desired.set(`frozen-horizon-zone-${line}`, {
            id:        `frozen-horizon-zone-${line}`,
            group:     line,
            kind:      'zone',
            start:     frozenNow,
            end:       frozenEnd,
            type:      'background',
            className: 'frozen-horizon-zone',
            editable:  false,
          });
        }
        Timeline._frozenHorizonIds = visibleLines.map(l => `frozen-horizon-zone-${l}`);
      } else {
        Timeline._frozenHorizonIds = [];
      }
    }

    // P2: snapshot which tasks are currently inside the frozen-horizon band so
    // the 1s ticker's coarse 30s scan (below) can diff against a known-good
    // baseline instead of recomputing membership from scratch every tick.
    {
      const nowForBand = Timeline._rebuildNow || new Date();
      const bandIds = new Set<string>();
      for (const t of scopedTasks) if (Engine.isFrozenHorizon(t, nowForBand)) bandIds.add(String(t.id));
      Timeline._frozenBandIds = bandIds;
    }

    // C1 (2026-08-20): plant visibility horizon — clamp the vis-timeline `max`
    // option to the far edge the backend already computed and sent down in
    // GET /tasks' meta (Store.visibilityHorizonEnd; see schedule-data.mts and
    // db.compute_visibility_horizon_end). This is an ADDITIONAL bound on top
    // of the zoomMin/zoomMax options set at init() — those cap how far the
    // user can zoom OUT, this caps the latest instant they can pan/zoom TO.
    // Deliberately never touches `min` — only the future edge is bounded
    // (OD-C1d/e); the past stays exactly as unbounded as it already was.
    if (Timeline._tl) {
      Timeline._tl.setOptions({ max: Store.visibilityHorizonEnd });

      // C1: labeled vertical marker at the horizon edge itself, so a planner
      // sees WHY the timeline ends / orders vanish there instead of just
      // hitting an unexplained wall. Added once and repositioned via
      // setCustomTime on later rebuilds (addCustomTime throws on a duplicate
      // id); removed when the plant has no horizon (removeCustomTime throws
      // on a missing id, hence the _visibilityHorizonMarker existence flag).
      // Not draggable: vis-timeline custom time bars are draggable by design
      // with no options-level opt-out, so dragging is disabled via CSS
      // (`.vis-custom-time.visibility-horizon { pointer-events: none }` in
      // styles.css) rather than through the vis-timeline API.
      const tlCustomTime = Timeline._tl as unknown as VisCustomTimeApi;
      const horizonEnd = Store.visibilityHorizonEnd;
      if (horizonEnd) {
        if (Timeline._visibilityHorizonMarker) {
          tlCustomTime.setCustomTime(horizonEnd, 'visibility-horizon');
        } else {
          tlCustomTime.addCustomTime(horizonEnd, 'visibility-horizon');
          tlCustomTime.setCustomTimeMarker(Util.t('ui.visibility_horizon_title'), 'visibility-horizon', false);
          Timeline._visibilityHorizonMarker = true;
        }
      } else if (Timeline._visibilityHorizonMarker) {
        tlCustomTime.removeCustomTime('visibility-horizon');
        Timeline._visibilityHorizonMarker = false;
      }
    }

    // Alert-cell background items — inserted last so they sit on top of the horizon
    // and past-zone shading within .vis-background (DOM order = paint order).
    // Err severity wins over warn on the same cell.
    const CALENDAR_ALERT_TYPES = new Set(['blackout', 'closed', 'firmed-closed', 'firmed-out-of-hours']);
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
        kind:  'zone',
        start: new Date(cell.dayKey + 'T00:00:00'),
        end:   new Date(cell.dayKey + 'T23:59:59'),
        type:  'background',
        className: cls,
        editable: false,
      };
      desired.set(String(item.id), item);
    }

    // Day-boundary gridlines — one ungrouped background item per local midnight,
    // so bars/alert-cells read clearly against day boundaries at aggregate zoom
    // (pixel-verified: bars/alert-cells were already correctly positioned —
    // the chart body was just missing gridlines to judge them against). No
    // `group` — the library routes ungrouped type:'background' items to its
    // own reserved BackgroundGroup, which sizes/positions them full-height
    // itself; _healBackgroundBands deliberately never touches these.
    {
      const GRIDLINE_MARGIN_DAYS = 3;
      const GRIDLINE_CAP = 550;
      const now = new Date();
      let rangeStart: Date, rangeEnd: Date;
      if (scopedTasks.length) {
        let minStart = now.getTime();
        let maxEnd = now.getTime();
        for (const t of scopedTasks) {
          if (t.start_date) {
            const s = new Date(t.start_date).getTime();
            if (s < minStart) minStart = s;
          }
          if (t.end_date) {
            const e = new Date(t.end_date).getTime();
            if (e > maxEnd) maxEnd = e;
          }
        }
        if (Store.visibilityHorizonEnd) {
          const hz = Store.visibilityHorizonEnd.getTime();
          if (hz > maxEnd) maxEnd = hz;
        }
        rangeStart = new Date(minStart - GRIDLINE_MARGIN_DAYS * Config.MS_DAY);
        rangeEnd   = new Date(maxEnd + GRIDLINE_MARGIN_DAYS * Config.MS_DAY);
      } else {
        rangeStart = new Date(now.getTime() - 45 * Config.MS_DAY);
        rangeEnd   = new Date(now.getTime() + 45 * Config.MS_DAY);
      }
      // Local-midnight iteration via setDate — never add 86,400,000ms, which
      // drifts every subsequent line off midnight across a DST transition.
      const d = new Date(rangeStart);
      d.setHours(0, 0, 0, 0);
      for (let count = 0; d.getTime() <= rangeEnd.getTime() && count < GRIDLINE_CAP; count++) {
        const dk = Util.dayKey(d);
        desired.set(`day-gridline-${dk}`, {
          id:        `day-gridline-${dk}`,
          kind:      'zone',
          start:     new Date(d),
          end:       new Date(d.getTime() + 60000),
          type:      'background',
          className: d.getDate() === 1 ? 'day-gridline day-gridline-month' : 'day-gridline',
          editable:  false,
        });
        d.setDate(d.getDate() + 1);
      }
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
    Timeline._itemIdsByTask = itemIdsByTask;
    PerfMonitor.record('Timeline.rebuild.dsFlush', performance.now() - _pmT0flush);

    // Re-sync selection with what still exists. Guard for pre-install rebuilds.
    if (typeof Selection !== 'undefined') {
      const keep = Selection.ids().filter(id => Timeline.itemIdsForTask(id).some(itemId => desired.has(itemId)));
      if (keep.length !== Selection.size()) Selection.set(keep);
      Timeline._tl!.setSelection(keep.flatMap(id => Timeline.itemIdsForTask(id)).filter(itemId => desired.has(itemId)));
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
    // Rebuild writes items straight into the parent DataSet while the DataView
    // filter may hold a stale window (setOptions({max}) above can clamp the range
    // without firing rangechanged, and the setWindow restore is a same-range no-op
    // event-wise). Resync + full refresh + redraw here, or freshly-added bars stay
    // culled until the user's next zoom/pan.
    Timeline._refreshViewNow();
    // Re-apply the remembered vertical offset AFTER _fitHeight() has set the
    // new height — must be rAF-deferred because setOptions({height}) doesn't
    // take effect (and thus doesn't clamp scrollTop to the new max) until
    // vis-timeline's next internal redraw. Clamp against the now-current
    // scroll range rather than trusting _vScrollTop blindly: fewer visible
    // lines than last rebuild means a smaller max, and writing a stale
    // larger value would just get silently clamped anyway, so clamp here
    // for clarity. This replaces the old one-shot _resetInitialVerticalScroll
    // guard — "start at the top" is just the initial _vScrollTop = 0, now
    // honoured on every rebuild instead of only the first.
    if (visibleLines.length) {
      requestAnimationFrame(() => {
        if (!Timeline._tl) return;
        Timeline._setVScroll(Timeline._vScrollTop);
      });
    }
    PerfMonitor.record('Timeline.rebuild', performance.now() - _pmT0t);
  },

  // Prefer vis-timeline's internal scroll API (typed at VisInternalTimeline,
  // below — undocumented and upgrade-fragile, but the only way to read/write
  // vertical position without depending on which DOM node vis-timeline
  // currently uses for the vertical scroller). Falls back to a direct DOM
  // query for whichever wrapper element vis-timeline happens to render
  // (varies by verticalScroll mode) if the internal method isn't there.
  // scrollToLine, rebuild(), and the marquee edge-scroll all route through
  // these two so there is exactly one mechanism for "vertical position",
  // not two that can silently disagree.
  _setVScroll(px: number): void {
    const tl = Timeline._tl as unknown as VisInternalTimeline | null;
    if (tl?._setScrollTop) { tl._setScrollTop(px); return; }
    const scrollEl = document.querySelector('.vis-vertical-scroll') ||
                     document.querySelector('.vis-panel.vis-center .vis-content');
    if (scrollEl) (scrollEl as HTMLElement).scrollTop = px;
  },

  _getVScroll(): number {
    const tl = Timeline._tl as unknown as VisInternalTimeline | null;
    if (tl?._getScrollTop) return tl._getScrollTop();
    const scrollEl = document.querySelector('.vis-vertical-scroll') ||
                     document.querySelector('.vis-panel.vis-center .vis-content');
    return scrollEl ? (scrollEl as HTMLElement).scrollTop : 0;
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
    const itemIds = Timeline.itemIdsForTask(id);
    // Force the target into the sliding DataView window first — see
    // _syncViewWindow's doc comment for why vis-timeline's own focus()/
    // setSelection() otherwise silently no-op for out-of-window items.
    Timeline._syncViewWindow(t.start_date.getTime(), t.end_date.getTime());
    // vis-timeline's focus() scrolls both horizontally (time) and vertically (line row).
    Timeline._tl.focus(itemIds[0] || String(id), { animation: { duration: 300 } });
    Timeline._tl.setSelection(itemIds);
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

  // Undebounced core of the rangechanged refresh: resync the DataView culling
  // window to the timeline's actual range, fully re-evaluate the filter (an item
  // excluded while _viewWindow was stale stays excluded until a refresh — vis-data
  // DataViews filter incrementally at add/update time), and force a relayout.
  _refreshViewNow(): void {
    if (!Timeline._tl || !Timeline._visItems) return;
    const w = Timeline._tl.getWindow();
    Timeline._viewWindow = { start: w.start.getTime(), end: w.end.getTime() };
    Timeline._visItems.refresh();
    Timeline._tl.redraw();
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
    const lineSet = new Set(tasks.map(t => t.MACHINE || 'Unknown'));
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
    // Explicit navigation wins over whatever rebuild() would otherwise
    // restore — set _vScrollTop directly (not just the DOM/internal write)
    // so a rebuild triggered shortly after this (e.g. GanttFilter revealing
    // a previously-hidden line) re-applies THIS position rather than
    // whatever _getVScroll() happened to read before the reveal.
    Timeline._vScrollTop = targetY;
    Timeline._setVScroll(targetY);
    return true;
  },

  // Shared "pan to a day + scroll to a line row" navigation, used by
  // Dashboard._gotoLine (heatmap cell clicks) and AlertsUIAdapter.focus (B1 —
  // now the universal line+day path for every alert, not just the taskId-less
  // ones). Forces the Gantt to the Timeline sub-tab first — plain
  // App.goto('gantt') alone preserves whatever Gantt sub-tab was last
  // active, so without this the pan/scroll below can happen invisibly
  // behind a hidden #gantt-sub-timeline pane.
  //
  // `onWindowSet` (B1) fires once the day window is applied, before the
  // scroll-to-line retry below — AlertsUIAdapter.focus uses it to layer
  // task selection/Inspector on top without re-centering the window a
  // second time.
  gotoLineDay(line: string, dateStr: string, onWindowSet?: () => void): void {
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
      onWindowSet?.();
      // B2: scrollToLine can legitimately fail on the first frame(s) here —
      // AlertsUIAdapter.focus's reveal (Store.setSelectedLines, just before
      // this call) triggers a 'lines:selected' → Timeline.rebuild() chain
      // whose group DOM isn't necessarily painted yet by the time we get
      // here. Retry across a few animation frames rather than a single
      // fire-and-forget timeout; bounded so a persistently-missing line
      // (bad data, an unanticipated race) can't spin forever, and it stops
      // the instant scrollToLine succeeds so it never fights a user's own
      // scroll that happens afterward.
      let attempts = 0;
      const MAX_SCROLL_ATTEMPTS = 20; // a handful of rebuild/render cycles' worth
      const tryScroll = () => {
        if (Timeline.scrollToLine(line)) return;
        if (++attempts < MAX_SCROLL_ATTEMPTS) requestAnimationFrame(tryScroll);
      };
      requestAnimationFrame(tryScroll);
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
          || evt.type === 'blocks:change' || evt.type === 'alerts:change') {
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
    // C1 (2026-08-20 convention, OD-C1d/e): cap the future edge at the plant
    // visibility horizon when one is set — same bound Timeline.rebuild() applies
    // to the Gantt's `max` option, so the minimap can't imply a scrollable range
    // past the point orders actually stop appearing. scheduleMin is left alone;
    // only the future edge is ever bounded.
    const horizon = Store.visibilityHorizonEnd?.getTime();
    const scheduleMax = Math.min(scheduleMin + 42 * Config.MS_DAY, horizon ?? Infinity);
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
    // plant's orders, not every plant's. Phase 3 (Pkg E): the utilization
    // heat-band below (computeMatrix) is now scoped the same way via
    // srcTasks, instead of recomputing a global, all-plant matrix.
    const tasks = (Store.selectedPlant ? Store.tasksForSelectedPlant() : [])
      .filter(t => t.start_date && t.end_date);
    if (!tasks.length || !Timeline._tl) return;

    // Share the horizon-capped range with the drag/click math (one source of truth).
    const { scheduleMin, scheduleMax } = TimelineNav._scheduleRange();
    if (scheduleMin == null || scheduleMax == null) return;
    const totalMs = scheduleMax - scheduleMin;
    if (totalMs <= 0) return;

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

    // Alert-severity day bands — worst alert per day, same source as the Gantt's
    // alertcell background items (Store.alerts already excludes dismissed alerts),
    // replacing the old utilization heat bands (overload/near-capacity are alert
    // types themselves, so capacity trouble still surfaces here).
    const plantLines = new Set(tasks.map(t => t.MACHINE || 'Unknown'));
    const worstByDay: Record<string, 'warn' | 'err'> = {};
    for (const a of Store.alerts) {
      if (!a.line || !a.time || !plantLines.has(a.line)) continue;
      const at = a.time.getTime();
      if (at < scheduleMin || at >= scheduleMax) continue;
      const dk = Util.dayKey(a.time);
      if (a.sev === 'err' || !worstByDay[dk]) worstByDay[dk] = a.sev;
    }
    const SEV_COLORS: Record<'warn' | 'err', string> = { warn: 'rgba(147,97,10,0.40)', err: 'rgba(176,42,32,0.55)' };
    for (const [dk, sev] of Object.entries(worstByDay)) {
      const dayStart = new Date(dk + 'T00:00:00').getTime();
      const x1 = Math.max(0, toX(dayStart));
      const x2 = Math.min(cssW, toX(dayStart + Config.MS_DAY));
      ctx.fillStyle = SEV_COLORS[sev];
      ctx.fillRect(x1, 0, x2 - x1, cssH);
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
      const line = t.MACHINE || 'Unknown';
      if (!lineColors[line]) {
        const ci = Timeline._colorIndex(line);
        lineColors[line] = Config.COLORS[ci % Config.COLORS.length];
      }
    });
    const lineArr = [...new Set(tasks.map(t => t.MACHINE || 'Unknown'))].sort();
    const lineH = Math.max(2, Math.floor(cssH / (lineArr.length || 1)));
    tasks.forEach(t => {
      const li = lineArr.indexOf(t.MACHINE || 'Unknown');
      const x1 = toX(t.start_date!.getTime());
      const x2 = toX(t.end_date!.getTime());
      const y  = li * lineH;
      ctx.fillStyle = lineColors[t.MACHINE || 'Unknown'] + 'cc';
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
      .map(t => t.MACHINE || 'Unknown'))].sort();
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
          sy = lineToY[sTask.MACHINE || 'Unknown'] ?? (foreOffY + foreRect.height / 2);
          ty = lineToY[tTask.MACHINE || 'Unknown'] ?? (foreOffY + foreRect.height / 2);

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
 *  'conflict'/'atrisk' read Store.alertsByTask() severities, 'firmed' reads
 *  the union via Engine.firmingStatus. Also the shape Table._applyChipFilter's `patch.status` and
 *  the Dashboard KPI-tile-click callers (still stopgap-typed, reached only via
 *  the loose NIMBUS.Table ambient shim) pass in. */
type TableStatusFilter = 'late' | 'conflict' | 'atrisk' | 'firmed';

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

/** Table._SearchableLineEditor's AG Grid CellEditorParams — the MACHINE
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
  // lines aliases the shared Store.selectedLines Set (same object, not a copy) —
  // the cross-screen production-line filter. See GanttFilter._selectedLines
  // for the identical convention and why it must never be reassigned.
  _chipFilters: { lines: Store.selectedLines, colors: new Set<string>(), status: null, dateKey: null, poMat: new Set<string>() } as TableChipFilters,
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
    // resetColumnState() reverts `hide` to whatever was baked into columnDefs
    // at grid-creation time — which can itself be stale (built before the
    // /system-settings boot fetch resolved). Force-reapply the CURRENT admin
    // default so _resetGridLayout()'s re-capture below persists the right
    // baseline, not a stale one. Same guard, so this doesn't echo back into
    // the user's personal gridLayout either.
    Table._applyFieldVisibility();
    setTimeout(() => { Table._applyingLayout = false; }, 0);
  },

  /* ── Admin-configured Orders field visibility (system_settings.orderFields,
     web/order-field-catalog.mjs) — a global default, not per-user. See the
     design note above _resetGridState: this must win over gridLayout's own
     `hide` state at both initial load (onGridReady, after _applySavedLayout)
     and after a manual reset, or a stale per-user layout silently overrides
     the admin default. ───────────────────────────────────────────────────── */
  _fieldHidden(key: string): boolean {
    const f = ORDER_FIELD_CATALOG.find(c => c.key === key);
    if (!f) return false;
    const cfg = Store.orderFieldVisibility[key];
    return !(cfg?.grid ?? f.gridDefault);
  },

  // Force-applies current catalog+config visibility for every catalog-driven
  // field via two batched setColumnsVisible calls (not a per-key loop). Uses
  // the same _applyingLayout guard as _applySavedLayout/_resetGridState so
  // this doesn't get captured back into the user's personal gridLayout.
  _applyFieldVisibility(): void {
    if (!Table._api) return;
    const visible: string[] = [];
    const hidden: string[] = [];
    for (const f of ORDER_FIELD_CATALOG) {
      (Table._fieldHidden(f.key) ? hidden : visible).push(f.key);
    }
    Table._applyingLayout = true;
    try {
      if (visible.length) Table._api.setColumnsVisible(visible, true);
      if (hidden.length) Table._api.setColumnsVisible(hidden, false);
    } catch (e: unknown) {
      ErrorLog.warn('table', `Apply field visibility failed: ${e instanceof Error ? e.message : String(e)}`);
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

  /** Columns for the order attributes that schedulers may edit inline. */
  _priorityColumns(): TableColDef[] {
    return [
      { headerName: Util.t('col.prt_01'), field: 'PRT_01', width: 130, flex: 0, editable: true,
        hide: Table._fieldHidden('PRT_01') },
      { headerName: Util.t('col.prt_02'), field: 'PRT_02', width: 130, flex: 0, editable: true,
        hide: Table._fieldHidden('PRT_02') },
      { headerName: Util.t('col.prod_version'), field: 'PRODUCTION_VERSION', width: 140, flex: 0, editable: true,
        hide: Table._fieldHidden('PRODUCTION_VERSION') },
    ];
  },

  /** New columnDefs for catalog fields that have no hand-written column
   *  today (MATERIAL_NUMBER, FORM_SIZE, PLANT, FIRMING_INDICATOR) — generated
   *  generically from web/order-field-catalog.mjs so adding a future
   *  no-column catalog entry doesn't need a matching hand-written columnDef. */
  _catalogOnlyColumns(): TableColDef[] {
    const handwritten = new Set(['MATERIAL_DESCRIPTION', 'ORDER_QUANTITY_(GMEIN)', 'COLOR', 'RUN_TIME',
      'original_start_date', 'original_end_date', 'PRT_01', 'PRT_02', 'PRODUCTION_VERSION']);
    return ORDER_FIELD_CATALOG.filter(f => !handwritten.has(f.key)).map(f => ({
      headerName: Util.t(f.i18nGridKey),
      field: f.key,
      width: f.gridWidth ?? 110,
      flex: 0,
      editable: false,
      hide: Table._fieldHidden(f.key),
      cellClass: f.type !== 'text' ? (() => 'cell-num') : undefined,
    }));
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
          headerName: Util.t('col.firmed'), colId: 'firmed',
          // Union value (SAP OR frozen-horizon OR manual), not the raw manual
          // `fixed` field — see Engine.firmingStatus.
          valueGetter: (p: { data: NimbusTask }) => Engine.firmingStatus(p.data).firmed,
          width: 60, minWidth: 60, maxWidth: 60, flex: 0,
          pinned: 'left',
          editable: false,
          cellRenderer: (p: { value: unknown }) => p.value ? '<span title="Firmed" style="color:var(--accent);font-size:13px;">🔒</span>' : '',
          headerTooltip: Util.t('tip.firmed_column')
        },
        { headerName: Util.t('col.id'),   field: 'id',   width: 80, minWidth: 80, flex: 0, hide: true,
          editable: false, cellClass: 'cell-num' },
        { headerName: Util.t('col.order'), field: 'PRODUCTION_ORDER', width: 160, minWidth: 160, flex: 0,
          pinned: 'left', editable: false,
          valueGetter: (p: { data: NimbusTask }) => p.data.PRODUCTION_ORDER || p.data.ORDER || '' },
        { headerName: Util.t('col.material'), field: 'MATERIAL_DESCRIPTION', minWidth: 180, editable: false,
          tooltipField: 'MATERIAL_DESCRIPTION', hide: Table._fieldHidden('MATERIAL_DESCRIPTION') },
        { headerName: Util.t('col.qty'), field: 'ORDER_QUANTITY_(GMEIN)', width: 100, flex: 0,
          editable: false, cellClass: 'cell-num', hide: Table._fieldHidden('ORDER_QUANTITY_(GMEIN)'),
          valueParser: (p: { newValue: string }) => parseFloat(p.newValue) || 0 },
        { headerName: Util.t('col.line'), field: 'MACHINE', minWidth: 130, editable: true,
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
        { headerName: Util.t('col.color'), field: 'COLOR', width: 110, flex: 0, editable: false,
          hide: Table._fieldHidden('COLOR') },
        ...Table._priorityColumns(),
        ...Table._catalogOnlyColumns(),
        { headerName: Util.t('col.run_h'), field: 'RUN_TIME', width: 90, flex: 0, editable: true,
          cellClass: 'cell-num', hide: Table._fieldHidden('RUN_TIME'),
          valueParser: (p: { newValue: string }) => parseFloat(p.newValue) || 0 },
        { headerName: Util.t('col.orig_start'), field: 'original_start_date', minWidth: 160,
          editable: false, hide: Table._fieldHidden('original_start_date'),
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
          editable: false, hide: Table._fieldHidden('original_end_date'),
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
      isExternalFilterPresent: () => Table._isExternalFilterActive(),
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
        // Must run AFTER _applySavedLayout — the admin's field-visibility
        // default has to win over any stale per-user saved `hide` state for
        // the same columns (see the design note above _resetGridState).
        Table._applyFieldVisibility();
        ErrorLog.info('table', `AG Grid ready with ${Store.tasksArr.length} rows`);
      },
    };

    agGrid.createGrid(el, gridOptions);

    // Re-render rows whenever relevant store slices change.
    Store.subscribe(evt => Table._onStore(evt), 'Table');

    // Live-apply an admin's System Configuration field-visibility change with
    // no page reload. Also covers the boot-time race where this grid paints
    // before the /system-settings fetch resolves — _applyFieldVisibility()
    // guards on Table._api itself, but the fetch can equally resolve BEFORE
    // onGridReady fires, so this subscription is the other half of that race.
    Store.subscribe(evt => { if (evt.type === 'order-field-visibility:changed') Table._applyFieldVisibility(); }, 'Table');

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

  // C1 (2026-08-20): whether AG Grid's external-filter machinery needs to run
  // at all — user-chosen chip filters OR a configured visibility horizon.
  // Deliberately separate from _hasChipFilters(), which also drives the
  // "Clear filters" button/hint (a plant horizon isn't a user-clearable chip,
  // so it must not make that button appear with nothing to clear) — but
  // without this OR, isExternalFilterPresent returning false when no CHIP is
  // active would mean doesExternalFilterPass (the thing that actually hides
  // beyond-horizon rows) never runs at all.
  _isExternalFilterActive(): boolean {
    return Table._hasChipFilters() || Store.visibilityHorizonEnd !== null;
  },

  _taskPassesChipFilters(data: NimbusTask | null): boolean {
    if (!data) return false;
    const f = Table._chipFilters;
    if (f.lines.size > 0 && !f.lines.has(data.MACHINE)) return false;
    if (f.colors.size > 0 && !f.colors.has(String(data.COLOR || '').toUpperCase())) return false;
    if (!Util.taskMatchesPasteSet(data, f.poMat)) return false;
    if (f.dateKey) {
      const dk = data.start_date ? Util.dayKey(data.start_date) : '';
      if (dk !== f.dateKey) return false;
    }
    // C1 (2026-08-20), OD-C1d/e: gate on start only, hide (not merely block
    // scrolling to) rows beyond the plant's visibility horizon. Belt-and-
    // suspenders — db.query_orders already excludes these rows from the
    // /tasks payload server-side, so this only matters if a cached/stale
    // payload briefly disagrees; it must never be the ONLY thing hiding them.
    const horizonEnd = Store.visibilityHorizonEnd;
    if (horizonEnd && data.start_date && data.start_date.getTime() > horizonEnd.getTime()) return false;
    if (f.status) {
      if (f.status === 'late' && !(Util.latenessHours(data) > 0)) return false;
      if (f.status === 'firmed' && !Engine.firmingStatus(data).firmed) return false;
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
      if (t.MACHINE) lineSet.add(t.MACHINE);
    }
    const sorted = [...lineSet].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    // No pruning here anymore: _chipFilters.lines is the shared cross-screen Set —
    // see Store.selectedLines and GanttFilter._buildLineDropdown's identical note.
    Util.renderLineChecklist(drop, sorted, Table._chipFilters.lines, Table._lineSearch,
      (line, checked) => {
        const next = new Set(Table._chipFilters.lines);
        if (checked) next.add(line); else next.delete(line);
        Store.setSelectedLines(next, 'table');
        Table._refreshChipButtons();
        if (Table._api) Table._api.onFilterChanged();
      });
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
      { v: 'firmed',   k: Util.t('ui.firmed'),       d: Util.t('ui.status_desc_firmed') },
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

  // 'line' is handled by _buildLineChipDropdown's own onToggle callback (routes
  // through Store.setSelectedLines) — never generated as an onchange="..." kind here.
  _onChipChange(kind: string, input: HTMLInputElement): void {
    const f = Table._chipFilters;
    if (kind === 'color') {
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
    // Routes through Store so the clear propagates to every other line-
    // filterable screen too (self-sourced, so Table's own _onStore guard
    // skips reprocessing — the calls below already do the local refresh).
    Store.setSelectedLines([], 'table');
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
    if (patch.lines)  Store.setSelectedLines(patch.lines, 'table');
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

    const STATUS_LABEL: Record<TableStatusFilter, string> = { late: Util.t('ui.late'), conflict: Util.t('ui.conflicting'), atrisk: Util.t('ui.at_risk'), firmed: Util.t('ui.firmed') };
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
    if (evt.source === 'table' && evt.type !== 'firmed:change') return;
    if (!Table._api) return;
    if (evt.type === 'tasks:bulk' || evt.type === 'plant:selected'
        || evt.type === 'lineSettings:change') {
      const rows = Store.tasksForSelectedPlant();
      Table._api.setGridOption('rowData', rows);
      Table._renderEmptyState();
      if (evt.type === 'plant:selected') {
        // Clear chip filters on plant change — stale line/color sets don't apply.
        // (selectedLines itself is cleared centrally by Store.setSelectedPlant.)
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
    } else if (evt.type === 'lines:selected') {
      // Cross-screen change (Gantt/Dashboard/Labor Plan/Master Data) — a
      // self-sourced 'table' event never reaches here (top-of-function guard);
      // _buildLineChipDropdown's own onToggle callback already did this locally.
      Table._buildLineChipDropdown();
      Table._api.onFilterChanged();
    } else if (evt.type === 'tasks:bulkUpdate') {
      const ids = (evt.ids as Array<string | number> | undefined) ?? [];
      const updated = ids
        .map(id => Store.tasks[id])
        .filter((t): t is NimbusTask => !!t && Store.getPlantForLine(t.MACHINE) === Store.selectedPlant);
      Table._api.applyTransaction({ update: updated });
      if (Table._hasChipFilters()) Table._api.onFilterChanged();
    } else if (evt.type === 'task:update') {
      const t = Store.tasks[String(evt.id)];
      if (t && Store.selectedPlant
          && Store.getPlantForLine(t.MACHINE) === Store.selectedPlant) {
        Table._api.applyTransaction({ update: [t] });
      }
      if (Table._hasChipFilters()) Table._api.onFilterChanged();
    } else if (evt.type === 'firmed:change') {
      const ids = (evt.ids as Array<string | number> | undefined) ?? [];
      const updated = ids
        .map(id => Store.tasks[id])
        .filter((t): t is NimbusTask => !!t && Store.getPlantForLine(t.MACHINE) === Store.selectedPlant);
      Table._api.applyTransaction({ update: updated });
      if (Table._chipFilters.status === 'firmed') Table._api.onFilterChanged();
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
    let requestedStart: Date | null = null;
    let requestedLine: string | null = null;
    let scheduleTask = p.data;

    if (field === 'start_date') {
      const d = Util.parseDate(p.newValue);
      if (!d) { Toast.show(Util.t('toast.invalid_date'), 'error'); Table._api!.refreshCells({ rowNodes: [p.node] }); return; }
      changes.start_date = Util.snap(d);
      requestedStart = changes.start_date;
    } else if (field === 'RUN_TIME') {
      const h = parseFloat(String(p.newValue)) || 0;
      changes.RUN_TIME = h;
      scheduleTask = { ...p.data, RUN_TIME: h };
      requestedStart = p.data.start_date ? new Date(p.data.start_date) : null;
    } else if (field === 'MACHINE') {
      changes.MACHINE = String(p.newValue || 'Unknown');
      requestedLine = changes.MACHINE;
      requestedStart = p.data.start_date ? new Date(p.data.start_date) : null;
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

    if (requestedStart) {
      const targetLine = requestedLine || p.data.MACHINE || 'Unknown';
      const schedule = Engine.manualSchedulePatchFor(scheduleTask, targetLine, requestedStart);
      if (!schedule?.start_date || !schedule.end_date) {
        Toast.show('Could not regenerate the order in the available calendar window.', 'error');
        Table._api!.refreshCells({ rowNodes: [p.node] });
        return;
      }
      Object.assign(changes, schedule);
    }

    Store.updateTask(id, changes, 'table');
    Table._api!.applyTransaction({ update: [Store.tasks[id]] });
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
    const set = new Set(Store.tasksArr.map(t => t.MACHINE || 'Unknown'));
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

  /* ---- public actions: firming, override modal, export ------------------ */
  firmSelected(firmed: boolean): void {
    if (!Table._api) return;
    const sel = Table._api.getSelectedRows() as NimbusTask[];
    if (!sel.length) { Toast.show(Util.t('toast.select_rows_first'), 'warn'); return; }
    const ids = sel.map(r => String(r.id));
    Store.setFirmed(ids, firmed, 'table');
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
    const firmEl = document.getElementById('ovr-firm') as HTMLInputElement | null;
    if (!orderEl || !lineEl || !firmEl) { ErrorLog.error('ui', 'required DOM elements missing for override modal'); return; }

    Table._selectedId = id;
    orderEl.textContent = `${t.text || t.ORDER || t.id}  ·  Line: ${t.MACHINE || '—'}`;
    if (!Table._fpOvrStart) {
      Table._fpOvrStart = Util.fpDatetime('#ovr-start');
    }
    Table._fpOvrStart.setDate(t.start_date!, false);
    const lines = Table._getLineOptions();
    lineEl.innerHTML = lines.map(l => `<option value="${l}" ${l === t.MACHINE ? 'selected' : ''}>${l}</option>`).join('');
    firmEl.checked = !!t.firmed;
    Modal.open('modal-override');
  },

  applyOverride(): void {
    const id = Table._selectedId;
    if (!id) return;
    const t = Store.tasks[id];
    if (!t) return;
    const startEl = document.getElementById('ovr-start') as HTMLInputElement | null;
    const lineEl = document.getElementById('ovr-line') as HTMLSelectElement | null;
    const firmEl = document.getElementById('ovr-firm') as HTMLInputElement | null;
    if (!startEl || !lineEl || !firmEl) { ErrorLog.error('ui', 'required DOM elements missing for override modal'); return; }

    const newStart = Util.parseDate(startEl.value);
    const newLine  = lineEl.value;
    const alsoFirm = firmEl.checked;
    if (!newStart) { Toast.show(Util.t('toast.invalid_date'), 'error'); return; }

    const schedule = Engine.manualSchedulePatchFor(t, newLine, newStart);
    if (!schedule?.start_date || !schedule.end_date) {
      Toast.show('Could not regenerate the order in the available calendar window.', 'error');
      return;
    }

    Store.updateTask(id, schedule, 'table');
    if (Table._api) Table._api.applyTransaction({ update: [Store.tasks[id]] });
    if (alsoFirm !== Store.isFirmed(id)) Store.setFirmed([id], alsoFirm, 'table');

    // Override explicitly does NOT auto-reflow (user's manual choice),
    // but we DO recompute alerts so conflicts become visible.
    Alerts.scheduleRecompute();
    Modal.close('modal-override');
    Toast.show(alsoFirm ? Util.t('toast.order_overridden_firmed') : Util.t('toast.order_overridden'), 'success');
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
    const po = Util.orderNumber(t);
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
 *  ever wires MACHINE (<select>), notes (<textarea>), start_date
 *  (<input>, upgraded to Flatpickr), RUN_TIME (<input type=number>), the
 *  priority attributes (PRT_01/PRT_02/PRODUCTION_VERSION), plus the open
 *  SAP-column bag via ORDER_QUANTITY_(GMEIN) — but the field name arrives as
 *  a plain string read off the DOM, not a compile-time literal. */
type InspectorFieldEl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** P2: after clearing the MANUAL firm layer, tell the planner if the order is
 *  still firmed via the union (SAP flag or frozen horizon) — otherwise
 *  "Unfirm" silently no-ops from the planner's point of view. Called from
 *  every unfirm entry point: context-menu, Inspector, F-key, Dashboard. */
function notifyResidualFirming(ids: string[]): void {
  const still = ids.some(id => { const t = Store.tasks[id]; return !!t && Engine.firmingStatus(t).firmed; });
  if (still) Toast.show(Util.t('toast.still_firmed'));
}

/* =============================================================================
   INSPECTOR — right-side detail panel shown on the Timeline tab.
   Edits here write through the Store (source: 'inspector').
   ========================================================================== */
export const Inspector = {
  _currentId: null as string | null,
  _unsubStore: null as (() => void) | null,

  // Admin-configured Orders field visibility (system_settings.orderFields,
  // web/order-field-catalog.mjs) for the Inspector surface. No live-refresh
  // subscription needed — _render() already runs fresh on every task
  // selection, so a later System Configuration change is picked up the next
  // time this panel opens.
  _fieldVisible(key: string): boolean {
    const f = ORDER_FIELD_CATALOG.find(c => c.key === key);
    if (!f) return true;
    const cfg = Store.orderFieldVisibility[key];
    return cfg?.inspector ?? f.inspectorDefault;
  },

  init(): void {
    Inspector._unsubStore = Store.subscribe(evt => {
    // Allow firmed:change through even from 'inspector' so the Firm/Unfirm
    // button re-renders after toggleFirm() — otherwise it never flips.
    if (evt.source === 'inspector' && evt.type !== 'firmed:change') return;
      if (evt.type === 'plant:selected') {
        const t = Inspector._currentId ? Store.tasks[Inspector._currentId] : null;
        if (!t || !Store.selectedPlant
            || Store.getPlantForLine(t.MACHINE) !== Store.selectedPlant) {
          Inspector.clear();
        }
        return;
      }
      if (!Inspector._currentId) return;
      if (evt.type === 'task:update' && String(evt.id) === Inspector._currentId) {
        Inspector._render(Store.tasks[Inspector._currentId]);
      } else if (evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate' || evt.type === 'firmed:change'
          || evt.type === 'setup-snapshot:replace') {
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
    const taskPlant = Store.getPlantForLine(task.MACHINE) || task.PLANT || null;
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

  _formatSetupState(state: SetupStateKey | null, definition: { fields: ReadonlyArray<string> } | null | undefined): string | null {
    if (!state || !definition) return null;
    const values = new Map(state.map(part => [part.fieldKey, part.value]));
    const labels: Record<string, string> = { colorWheel: 'Color', prt01: 'PRT01', prt02: 'PRT02', productionVersion: 'Production version' };
    return definition.fields.map(field => `${labels[field] || field}: ${values.get(field) || '—'}`).join(' · ');
  },

  _isSetupActionTask(task: NimbusTask, now: Date = new Date()): boolean {
    const lineTasks = Store.tasksArr.filter(candidate => candidate.MACHINE === task.MACHINE)
      .map(candidate => ({ task: candidate, start: Util.parseDate(candidate.start_date), end: Util.parseDate(candidate.end_date) }))
      .filter((candidate): candidate is { task: NimbusTask; start: Date; end: Date } => !!candidate.start && !!candidate.end)
      .sort((left, right) => left.start.getTime() - right.start.getTime() || String(left.task.id).localeCompare(String(right.task.id)));
    const active = lineTasks.find(candidate => candidate.start <= now && candidate.end > now);
    const current = active || lineTasks.find(candidate => candidate.start >= now);
    return String(current?.task.id || '') === String(task.id);
  },

  _setupOverrideValues(baseline: number | null, adjustmentText: string, totalText: string): { standardMin: number; remainingMin: number } | null {
    if (baseline != null) {
      if (!adjustmentText.trim()) return null;
      const adjustment = Number(adjustmentText);
      if (!Number.isInteger(adjustment)) return null;
      const remainingMin = baseline + adjustment;
      return remainingMin >= 0 ? { standardMin: baseline, remainingMin } : null;
    }
    if (!totalText.trim()) return null;
    const total = Number(totalText);
    return Number.isInteger(total) && total >= 0 ? { standardMin: total, remainingMin: total } : null;
  },

  _canWriteSetup(plant: string): boolean {
    const permissions = Session.currentUser()?.role_settings?.permissions as Record<string, unknown> | undefined;
    const allowed = Session.allowedPlants();
    return Session.isAdmin() || (permissions?.setup_scheduler === true && (allowed === null || allowed?.includes(plant)));
  },

  _setupOverrideFor(task: NimbusTask): { predecessorOrderId: string | null; predecessorState: SetupStateKey; successorState: SetupStateKey; baseline: number | null; existing: SetupOccurrenceOverride | undefined } | null {
    const snapshot = Store.setupSnapshot;
    const definition = snapshot?.definition;
    if (!snapshot || !definition) return null;
    const observation = Timeline._setupObservation(Store.tasksForSelectedPlant());
    const interval = observation.intervals.find(entry => String(entry.successorOrderId) === String(task.id));
    const diagnostic = observation.diagnostics.find(entry => String(entry.successorOrderId || '') === String(task.id));
    const predecessorOrderId = interval?.predecessorOrderId ?? diagnostic?.predecessorOrderId ?? null;
    const predecessor = predecessorOrderId ? Store.tasks[String(predecessorOrderId)] : null;
    const predecessorState = predecessor ? stateForOrder(predecessor, definition)
      : snapshot.machine_states.find(state => state.machine === task.MACHINE && state.signature_version === definition.signature_version)?.state_key || null;
    const successorState = stateForOrder(task, definition);
    if (!predecessorState || !successorState) return null;
    const resolved = resolveSetup({ definition, machine: task.MACHINE, predecessorState, successorState,
      predecessorOrderId, successorOrderId: String(task.id), plantRows: snapshot.plant_rows, machineRows: snapshot.machine_rows, overrides: snapshot.overrides });
    const existing = snapshot.overrides.find(override => override.status === 'active' && override.machine === task.MACHINE
      && override.signature_version === definition.signature_version && override.predecessor_order_id === predecessorOrderId
      && override.successor_order_id === String(task.id));
    return { predecessorOrderId, predecessorState, successorState,
      baseline: resolved.covered && resolved.standardMin != null ? resolved.standardMin : null, existing };
  },

  /** Keyboard/screen-reader equivalent of a setup bar: detail belongs to the
   * successor order, never to a selectable synthetic timeline item. */
  _setupDetailForTask(task: NimbusTask, observation: SetupObservation = Timeline._setupObservation(Store.tasksForSelectedPlant())): SetupPresentationDetail {
    const id = String(task.id);
    const interval = observation.intervals.find(entry => String(entry.successorOrderId) === id);
    const diagnostic = observation.diagnostics.find(entry => String(entry.successorOrderId || '') === id);
    const hasObservedEntry = !!interval || !!diagnostic;
    // Keep a stable detail surface for every order. Positive setup intervals
    // and diagnostics supply their existing facts; an order with neither still
    // gets an honest, placeholder-only panel instead of losing the section.
    const entry: any = interval || diagnostic || { successorOrderId: id };
    const snapshot = Store.setupSnapshot;
    const definition = snapshot?.definition;
    const predecessor = hasObservedEntry && entry.predecessorOrderId ? Store.tasks[String(entry.predecessorOrderId)] : null;
    const predecessorState = hasObservedEntry && definition
      ? (predecessor ? stateForOrder(predecessor, definition)
        : snapshot?.machine_states.find(state => state.machine === task.MACHINE && state.signature_version === definition.signature_version)?.state_key)
      : null;
    const successorState = hasObservedEntry && definition ? stateForOrder(task, definition) : null;
    const resolved = hasObservedEntry && definition && predecessorState && successorState && snapshot
      ? resolveSetup({ definition, machine: task.MACHINE, predecessorState, successorState,
        predecessorOrderId: entry.predecessorOrderId ?? null, successorOrderId: id,
        plantRows: snapshot.plant_rows, machineRows: snapshot.machine_rows, overrides: snapshot.overrides }) : null;
    const predecessorStateText = hasObservedEntry
      ? (Inspector._formatSetupState(predecessorState ?? null, definition) || entry.predecessorState || null)
      : null;
    return {
      predecessorOrderId: entry.predecessorOrderId ?? null,
      predecessorState: predecessorStateText,
      successorOrderId: id,
      requiredMinutes: Number.isFinite(entry.requiredMinutes) ? entry.requiredMinutes : null,
      effectiveMinutes: resolved?.effectiveMin ?? (Number.isFinite(entry.effectiveMinutes) ? entry.effectiveMinutes : (Number.isFinite(entry.requiredMinutes) ? entry.requiredMinutes : null)),
      standardMinutes: resolved?.standardMin ?? (Number.isFinite(entry.standardMinutes) ? entry.standardMinutes : (Number.isFinite(entry.requiredMinutes) ? entry.requiredMinutes : null)),
      source: resolved?.source ?? (entry.source || (hasObservedEntry ? 'resolved' : null)),
      // D4: 'none' is an explicit fact ("this no-change transition has no
      // override to speak of") — distinguishable in the UI from the '—'
      // placeholder used when the transition itself is unknown/unobserved.
      overrideStatus: entry.overrideStatus || (resolved?.source === 'occurrence' ? 'active' : (resolved?.source === 'implicit-zero' ? 'none' : null)),
      availableMinutes: Number.isFinite(entry.availableMinutes) ? entry.availableMinutes : null,
      shortMinutes: Number.isFinite(entry.availableMinutes) && Number.isFinite(entry.requiredMinutes) && entry.availableMinutes < entry.requiredMinutes
        ? entry.requiredMinutes - entry.availableMinutes : null,
      missingDetail: diagnostic && diagnostic.type !== 'setup-no-change' ? (diagnostic.message || setupDiagnosticLabel(diagnostic.type)) : null,
    };
  },

  _setupCapacityConflictText(detail: SetupPresentationDetail): string | null {
    if (detail.shortMinutes == null || detail.availableMinutes == null || detail.requiredMinutes == null) return null;
    const fallback = `Capacity shortfall: ${detail.availableMinutes} min available; ${detail.requiredMinutes} min required; ${detail.shortMinutes} min short.`;
    const translated = Util.t('ui.setup_capacity_shortfall', {
      available: detail.availableMinutes, required: detail.requiredMinutes, short: detail.shortMinutes,
    });
    return translated === 'ui.setup_capacity_shortfall' ? fallback : translated;
  },

  _render(task: NimbusTask): void {
    const body = document.getElementById('inspector-body');
    if (!body) return;
    if (!task) { Inspector.clear(); return; }

    // Order fields originate from uploaded Excel — escape before innerHTML.
    const esc = (s: unknown) => String(s == null ? '' : s).replace(/[&<>"']/g, (c: string) => (({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' } as Record<string, string>)[c]));
    const firmed = Store.isFirmed(task.id);        // manual layer — drives the Firm/Unfirm button
    const firmedUnion = Engine.firmingStatus(task).firmed;  // SAP OR frozen-horizon OR manual — drives the one banner below
    const lineOptions = Table._getLineOptions();
    const relAlerts = Store.alertsByTask().get(String(task.id)) || [];
    const scheduleSegments = Array.isArray(task.scheduleSegments) && task.scheduleSegments.length >= 2
      ? task.scheduleSegments : [];
    // Display-only derived Orig Start (due date minus RUN_TIME) — see
    // Util.impliedOriginalStart. Never reads/writes the raw
    // original_start_date field directly for display.
    const impliedOrigStart = Util.impliedOriginalStart(task);
    const setupDetail = Inspector._setupDetailForTask(task);
    const setupCapacityConflict = setupDetail ? Inspector._setupCapacityConflictText(setupDetail) : null;
    const missingSetupPlaceholder = '—';
    const setupPlant = Store.getPlantForLine(task.MACHINE) || task.PLANT || Store.selectedPlant || '';
    const canWriteSetup = !!setupPlant && Inspector._canWriteSetup(setupPlant);

    body.innerHTML = `
      ${firmedUnion ? `<div class="insp-firmed-banner">${Util.t('ui.insp_firmed_banner')}</div>` : ''}
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
        ${Inspector._fieldVisible('MATERIAL_NUMBER') ? `
        <div class="insp-row"><label>${Util.t('ui.insp_material_no')}</label>
          <div class="insp-val">${esc(task.MATERIAL_NUMBER || '—')}</div></div>` : ''}
        ${Inspector._fieldVisible('MATERIAL_DESCRIPTION') ? `
        <div class="insp-row"><label>${Util.t('ui.insp_material_desc')}</label>
          <div class="insp-val">${esc(task.MATERIAL_DESCRIPTION || '—')}</div></div>` : ''}
        ${Inspector._fieldVisible('ORDER_QUANTITY_(GMEIN)') ? `
        <div class="insp-row"><label>${Util.t('ui.insp_qty')}</label>
          <div class="insp-val">${esc(task['ORDER_QUANTITY_(GMEIN)'] || 0)}</div></div>` : ''}
        ${Inspector._fieldVisible('COLOR') ? `
        <div class="insp-row"><label>${Util.t('ui.insp_color')}</label>
          <div class="insp-val">${esc(task.COLOR || '—')}</div></div>` : ''}
        ${Inspector._fieldVisible('FORM_SIZE') ? `
        <div class="insp-row"><label>${Util.t('ui.insp_form')}</label>
          <div class="insp-val">${esc(task.FORM_SIZE || '—')}</div></div>` : ''}
        ${['PRT_01', 'PRT_02', 'PRODUCTION_VERSION'].map(key => {
          if (!Inspector._fieldVisible(key)) return '';
          const field = ORDER_FIELD_CATALOG.find(c => c.key === key);
          if (!field) return '';
          const value = (task as unknown as Record<string, unknown>)[key] ?? '';
          return `<div class="insp-row"><label>${Util.t(field.i18nInspectorKey)}</label>
            <div class="insp-val"><input type="text" data-field="${key}" value="${esc(value)}"></div></div>`;
        }).join('')}
        <div class="insp-row"><label>${Util.t('ui.insp_line')}</label>
          <div class="insp-val"><select data-field="MACHINE">
            ${lineOptions.map(l => `<option value="${esc(l)}" ${l === task.MACHINE ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select></div></div>
      </div>

      <div class="insp-card">
        <h4>${Util.t('ui.insp_schedule_section')}</h4>
        ${Inspector._fieldVisible('original_start_date') ? `
        <div class="insp-row"><label>${Util.t('ui.insp_orig_start')}</label>
          <div class="insp-val">${impliedOrigStart ? Util.fmtDTReadable(impliedOrigStart) : '—'}</div></div>` : ''}
        ${Inspector._fieldVisible('original_end_date') ? `
        <div class="insp-row"><label>${Util.t('ui.insp_orig_end')}</label>
          <div class="insp-val">${task.original_end_date ? Util.fmtDTReadable(task.original_end_date) : '—'}</div></div>` : ''}
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

      ${(() => {
        const moreKeys = ['PLANT', 'FIRMING_INDICATOR',
          'PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)', 'REDUCED_QUANTITY_(GMEIN)',
          'ORDER_CATEGORY', 'ORDER_TYPE', 'BOM_ALTERNATIVE', 'BOM_USAGE',
          'LABOR_HOURS_(MEINH)', 'MACHINE_HOURS_(MEINH)', 'NO_OF_FTE_(MEINH)'];
        const rows = moreKeys.map(key => {
          if (!Inspector._fieldVisible(key)) return '';
          const f = ORDER_FIELD_CATALOG.find(c => c.key === key);
          if (!f) return '';
          const val = (task as unknown as Record<string, unknown>)[key];
          return `<div class="insp-row"><label>${Util.t(f.i18nInspectorKey)}</label>
            <div class="insp-val">${esc(val ?? '—')}</div></div>`;
        }).join('');
        return rows ? `<div class="insp-card">
          <h4>${Util.t('ui.insp_more_section')}</h4>
          ${rows}
        </div>` : '';
      })()}

      ${scheduleSegments.length ? `<div class="insp-card insp-split-summary">
        <h4>Productive schedule</h4>
        <div class="insp-split-summary-note">${scheduleSegments.length} calendar-valid pieces; parent timing remains authoritative.</div>
        <div class="insp-split-segments">
          ${scheduleSegments.map((segment, index) => {
            const hours = (segment.endDate.getTime() - segment.startDate.getTime()) / Config.MS_HOUR;
            return `<div class="insp-split-segment">
              <span>Part ${index + 1}</span>
              <span>${Util.fmtDTReadable(segment.startDate)} → ${Util.fmtDTReadable(segment.endDate)}</span>
              <span>${hours.toFixed(2)}h</span>
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}

      <div class="insp-card insp-setup-detail" aria-label="${esc(Util.t('ui.setup_detail_title'))}">
        <h4>${esc(Util.t('ui.setup_detail_title'))}</h4>
        <div class="insp-row"><label>${esc(Util.t('ui.setup_predecessor'))}</label><div class="insp-val">${esc(setupDetail.predecessorOrderId || missingSetupPlaceholder)}</div></div>
        <div class="insp-row"><label>${esc(Util.t('ui.setup_predecessor_state'))}</label><div class="insp-val">${esc(setupDetail.predecessorState || missingSetupPlaceholder)}</div></div>
        <div class="insp-row"><label>${esc(Util.t('ui.setup_required'))}</label><div class="insp-val">${setupDetail.requiredMinutes == null ? missingSetupPlaceholder : `${setupDetail.requiredMinutes} min`}</div></div>
        <div class="insp-row"><label>${esc(Util.t('ui.setup_effective'))}</label><div class="insp-val">${setupDetail.effectiveMinutes == null ? missingSetupPlaceholder : `${setupDetail.effectiveMinutes} min`}</div></div>
        <div class="insp-row"><label>${esc(Util.t('ui.setup_standard'))}</label><div class="insp-val">${setupDetail.standardMinutes == null ? missingSetupPlaceholder : `${setupDetail.standardMinutes} min`}</div></div>
        <div class="insp-row"><label>${esc(Util.t('ui.setup_source'))}</label><div class="insp-val">${esc(setupSourceLabel(setupDetail.source) || missingSetupPlaceholder)}</div></div>
        <div class="insp-row"><label>${esc(Util.t('ui.setup_override'))}</label><div class="insp-val">${esc(setupDetail.overrideStatus === 'none' ? Util.t('ui.setup_override_none') : (setupDetail.overrideStatus || missingSetupPlaceholder))}</div></div>
        ${setupCapacityConflict ? `<p class="insp-setup-warning">${esc(setupCapacityConflict)}</p>` : ''}
        ${setupDetail.missingDetail ? `<p class="insp-setup-warning">${esc(Util.t('ui.setup_missing'))}: ${esc(setupDetail.missingDetail)}</p>` : ''}
        ${canWriteSetup ? `<div class="insp-setup-actions"><button class="btn btn-ghost sm" data-setup-correct-state>Correct actual setup state</button><button class="btn btn-ghost sm" data-setup-adjust-time>Adjust setup time</button><div data-setup-editor-host></div></div>` : ''}
      </div>

      <div class="insp-card">
        <h4>${Util.t('ui.insp_notes_section')}</h4>
        <div class="insp-notes-wrap">
          <textarea data-field="notes" maxlength="500" placeholder="${Util.t('ph.add_note')}" rows="3">${esc(task.notes || '')}</textarea>
          <div class="insp-notes-counter"><span id="insp-notes-rem">${500 - (task.notes || '').length}</span> ${Util.t('ui.remaining')}</div>
        </div>
      </div>

      <div class="insp-actions">
        ${firmed
          ? `<button class="btn" onclick="NIMBUS.Inspector.toggleFirm(false)">${Util.t('btn.unfirm')}</button>`
          : `<button class="btn btn-primary" onclick="NIMBUS.Inspector.toggleFirm(true)">${Util.t('btn.firm_order')}</button>`}
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
    body.querySelector<HTMLButtonElement>('[data-setup-correct-state]')?.addEventListener('click', () => {
      const snapshot = Store.setupSnapshot;
      const host = body.querySelector<HTMLElement>('[data-setup-editor-host]');
      if (snapshot && host && setupPlant) SetupAdmin.mountStateEditor(host, snapshot, task.MACHINE, () => Inspector._refreshSetupTruth(setupPlant));
    });
    body.querySelector<HTMLButtonElement>('[data-setup-adjust-time]')?.addEventListener('click', () => Inspector._showSetupOverrideEditor(task, setupPlant));
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

  async _refreshSetupTruth(plant: string): Promise<void> {
    await Persistence.loadSetupSnapshot(plant);
    Timeline.rebuild();
    Alerts.scheduleRecompute();
    const current = Inspector._currentId ? Store.tasks[Inspector._currentId] : null;
    if (current) Inspector._render(current);
  },

  _showSetupOverrideEditor(task: NimbusTask, plant: string): void {
    const context = Inspector._setupOverrideFor(task);
    const definition = Store.setupSnapshot?.definition;
    const host = document.getElementById('inspector-body')?.querySelector<HTMLElement>('[data-setup-editor-host]');
    if (!context || !definition) {
      Toast.show(Util.t('toast.setup_record_line_state_first'), 'warn');
      const snapshot = Store.setupSnapshot;
      if (host && snapshot && plant && Inspector._canWriteSetup(plant)) {
        SetupAdmin.mountStateEditor(host, snapshot, task.MACHINE, () => Inspector._refreshSetupTruth(plant));
      }
      return;
    }
    if (!host || host.querySelector('[data-setup-override-editor]')) return;
    const existing = context.existing;
    const baseline = existing?.standard_min ?? context.baseline;
    const initialAdjustment = existing && baseline != null ? existing.remaining_min - baseline : 0;
    host.innerHTML = `<div class="setup-state-editor" data-setup-override-editor><label>Reason<input class="input" data-setup-override-reason></label>${baseline != null ? `<label>Adjustment (minutes)<input class="input" type="number" step="1" data-setup-override-adjustment value="${initialAdjustment}"></label><p class="setup-editor-note">Matrix baseline: ${baseline} min. Remaining work is baseline plus adjustment.</p>` : `<label>Total setup duration (minutes)<input class="input" type="number" min="0" step="1" data-setup-override-total></label><p class="setup-editor-note">No matrix baseline exists; this total applies only to this exact order pair.</p>`}<div class="insp-actions"><button class="btn btn-primary sm" data-setup-save-override>Save setup time</button>${existing ? '<button class="btn btn-ghost sm" data-setup-reset-override>Reset to matrix</button>' : ''}</div></div>`;
    const reason = host.querySelector<HTMLInputElement>('[data-setup-override-reason]')!;
    reason.value = existing?.reason || '';
    host.querySelector<HTMLButtonElement>('[data-setup-save-override]')!.addEventListener('click', async () => {
      const values = Inspector._setupOverrideValues(baseline, host.querySelector<HTMLInputElement>('[data-setup-override-adjustment]')?.value || '', host.querySelector<HTMLInputElement>('[data-setup-override-total]')?.value || '');
      if (!reason.value.trim()) { Toast.show('A shop-floor reason is required.', 'error'); reason.focus(); return; }
      if (!values) { Toast.show(baseline != null ? 'The remaining setup time cannot be below zero.' : 'Enter a whole-number total setup duration.', 'error'); return; }
      const payload = { machine: task.MACHINE, standard_min: values.standardMin, remaining_min: values.remainingMin, signature_version: definition.signature_version, reason: reason.value.trim() };
      const url = existing ? `${Config.API_BASE}/setup/${encodeURIComponent(plant)}/overrides/${encodeURIComponent(String(existing.id))}` : `${Config.API_BASE}/setup/${encodeURIComponent(plant)}/overrides`;
      const body = existing ? payload : { ...payload, predecessor_order_id: context.predecessorOrderId, successor_order_id: String(task.id), predecessor_values: Object.fromEntries(context.predecessorState.map(part => [part.fieldKey, part.value])), successor_values: Object.fromEntries(context.successorState.map(part => [part.fieldKey, part.value])) };
      try {
        const response = await Util.fetchTraced(url, { method: existing ? 'PUT' : 'POST', headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() }, body: JSON.stringify(body) });
        if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.detail || `HTTP ${response.status}`); }
        Persistence.noteSetupWrite(plant, 'override'); await Inspector._refreshSetupTruth(plant); Toast.show('Setup time saved.', 'success');
      } catch (error) { Toast.show(`Could not save setup time: ${(error as Error).message}`, 'error'); }
    });
    host.querySelector<HTMLButtonElement>('[data-setup-reset-override]')?.addEventListener('click', async () => {
      if (!existing) return;
      if (!reason.value.trim()) { Toast.show('A shop-floor reason is required.', 'error'); reason.focus(); return; }
      try {
        const response = await Util.fetchTraced(`${Config.API_BASE}/setup/${encodeURIComponent(plant)}/overrides/${encodeURIComponent(String(existing.id))}`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() }, body: JSON.stringify({ machine: task.MACHINE, signature_version: definition.signature_version, reason: reason.value.trim() }) });
        if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.detail || `HTTP ${response.status}`); }
        Persistence.noteSetupWrite(plant, 'override'); await Inspector._refreshSetupTruth(plant); Toast.show('Setup override reset to matrix.', 'success');
      } catch (error) { Toast.show(`Could not reset setup time: ${(error as Error).message}`, 'error'); }
    });
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
    let requestedStart: Date | null = null;
    let requestedLine: string | null = null;
    let scheduleTask = t;
    if (field === 'start_date') {
      const d = Util.parseDate(value);
      if (!d) { Toast.show(Util.t('toast.invalid_date'), 'error'); return; }
      changes.start_date = Util.snap(d);
      requestedStart = changes.start_date;
    } else if (field === 'RUN_TIME') {
      const h = parseFloat(value) || 0;
      changes.RUN_TIME = h;
      scheduleTask = { ...t, RUN_TIME: h };
      requestedStart = t.start_date ? new Date(t.start_date) : null;
    } else if (field === 'ORDER_QUANTITY_(GMEIN)') {
      changes[field] = parseFloat(value) || 0;
    } else if (field === 'notes') {
      changes.notes = value.trim() || null;
      Store.updateTask(id, changes, 'inspector');
      Inspector._persistNote(id, changes.notes ?? null);
      return;
    } else {
      changes[field] = value;
      if (field === 'MACHINE') {
        requestedLine = value || 'Unknown';
        requestedStart = t.start_date ? new Date(t.start_date) : null;
      }
    }
    if (requestedStart) {
      const targetLine = requestedLine || t.MACHINE || 'Unknown';
      const schedule = Engine.manualSchedulePatchFor(scheduleTask, targetLine, requestedStart);
      if (!schedule?.start_date || !schedule.end_date) {
        Toast.show('Could not regenerate the order in the available calendar window.', 'error');
        Inspector._render(t);
        return;
      }
      Object.assign(changes, schedule);
    }
    Store.updateTask(id, changes, 'inspector');
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

  toggleFirm(firmed: boolean): void {
    if (!Inspector._currentId) return;
    Store.setFirmed([Inspector._currentId], firmed, 'inspector');
    if (!firmed) notifyResidualFirming([Inspector._currentId]);
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
        if (action === 'firm')       { Store.setFirmed([id], true, 'ctx');  Alerts.scheduleRecompute(); }
        else if (action === 'unfirm'){ Store.setFirmed([id], false, 'ctx'); Alerts.scheduleRecompute(); notifyResidualFirming([id]); }
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
    // Toggle firm/unfirm visibility based on the MANUAL layer only — see
    // context-menu spec: visibility keyed off Store.isFirmed.
    const firmed = Store.isFirmed(targetId);
    (menu.querySelector('[data-action="firm"]') as HTMLElement | null)!.style.display   = firmed ? 'none' : '';
    (menu.querySelector('[data-action="unfirm"]') as HTMLElement | null)!.style.display = firmed ? '' : 'none';
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
  // Last "identity" (plant + line-filter selection) _vl was populated for
  // (Part A1/A2) — mirrors Dashboard._lsVLPlant: the instance persists
  // across a plant switch or filter change (only destroyed on plant
  // deselect), so without this the remembered scroll offset would be
  // re-applied against an entirely different set of rows.
  _vlIdentity: null as string | null,
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
          || evt.type === 'firmed:change' || evt.type === 'plant:selected'
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
        const firmed = Engine.firmingStatus(tk).firmed;
        return `<div class="hier-item${firmed ? ' firmed' : ''}" data-id="${tk.id}">` +
          (firmed ? '<span class="lock-ico">🔒</span>' : '') +
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
      const k = tk.MACHINE || 'Unknown';
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

    const identityKey = `${Store.selectedPlant}|${visibleNames.join(',')}`;
    const identityChanged = Hierarchy._vlIdentity !== identityKey;
    Hierarchy._vlIdentity = identityKey;
    Hierarchy._vl.update(Hierarchy._lineItems, identityChanged ? { anchor: 'top' } : undefined);
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
  // Aliases the shared Store.selectedLines Set (same object, not a copy) — the
  // cross-screen production-line filter. Every scattered direct read of this
  // field elsewhere in this file (Timeline's optimize-run patch skip, its
  // row-height reservation, Hierarchy's scoping) keeps working unmodified
  // because Store.setSelectedLines() always mutates that Set in place.
  _selectedLines:  Store.selectedLines,
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
        // selectedLines is cleared centrally by Store.setSelectedPlant (lines are
        // plant-scoped) — the 'lines:selected' branch below picks up the rebuild.
        GanttFilter._selectedColors.clear();
        GanttFilter._selectedForms.clear();
        GanttFilter._clearPoMat();
        GanttFilter._resetSearch();
        GanttFilter.populate();
        GanttFilter._buildLineDropdown();
        GanttFilter._refreshLineBtn();
        setTimeout(() => GanttFilter._apply!(), 80);
      }
      if (evt.type === 'lines:selected') {
        // Single code path for every line-selection change, whether it
        // originated here (checkbox/isolate/restore) or on another screen
        // (Table/Dashboard/Labor Plan/Master Data) — matches() doesn't cover
        // lines, so Timeline/Hierarchy need their own explicit rebuild.
        GanttFilter._buildLineDropdown();
        GanttFilter._refreshLineBtn();
        Timeline.rebuild();
        Hierarchy.render();
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
    // Routes through Store so the clear propagates to every other line-
    // filterable screen too; the 'lines:selected' subscriber above handles
    // the dropdown/Timeline/Hierarchy rebuild (no-ops if lines were already empty).
    Store.setSelectedLines([], 'gantt-clear');
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
      if (t.MACHINE) lineSet.add(t.MACHINE);
    }
    const sorted = [...lineSet].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    // No pruning here anymore: _selectedLines is the shared cross-screen Set,
    // and this screen's candidate list is only a subset of the lines other
    // screens (Labor Plan, Master Data) may recognize — see Store.selectedLines.
    Util.renderLineChecklist(drop, sorted, GanttFilter._selectedLines, GanttFilter._lineSearch,
      (line, checked) => {
        const next = new Set(GanttFilter._selectedLines);
        if (checked) next.add(line); else next.delete(line);
        Store.setSelectedLines(next, 'gantt');
      });
  },

  _refreshLineBtn(): void {
    const btn = document.getElementById('gantt-flt-line-btn');
    const lbl = document.getElementById('gantt-flt-line-label');
    Util.refreshMultiSelectLabel(lbl, btn, GanttFilter._selectedLines);
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
      const shouldDim = active && !GanttFilter.matches(task);
      // A split logical order has one visual item per productive interval;
      // filtering must update every piece rather than looking up only the
      // parent id (which intentionally has no visual item in that case).
      for (const itemId of Timeline.itemIdsForTask(id)) {
        const item = Timeline._items.get(itemId) as TimelineVisItem | null;
        if (!item) continue;
        const baseClass = (item.className || '').split(' ').filter(c => c !== 'dimmed').join(' ');
        const newClass  = shouldDim ? baseClass + ' dimmed' : baseClass;
        if (newClass !== item.className) updates.push({ id: itemId, className: newClass });
      }
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
  // Both delegate to Store so the change propagates everywhere; the
  // 'lines:selected' subscriber above does the dropdown/button/Timeline/
  // Hierarchy rebuild. Signatures unchanged — nimbus-intelligence.js's
  // Command Palette "go to line" action calls isolateLine() directly.
  isolateLine(line: string): void {
    Store.setSelectedLines([line], 'gantt-isolate');
  },
  restoreAllLines(): void {
    Store.setSelectedLines([], 'gantt-isolate');
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

  // Aliases the shared Store.selectedLines Set (same object, not a copy) — see
  // GanttFilter._selectedLines for the identical convention and rationale.
  _filterLines:  Store.selectedLines,
  _allLines:     null as string[] | null,
  _resizeDebounced: null as ReturnType<typeof setTimeout> | null,
  _matrix7Cache: null as { key: string; matrix: DashboardUtilMatrix } | null,
  _lsVL:         null as VirtualList<DashboardLineStatusRow> | null,
  // Last plant _lsVL was populated for (Part A1/A2) — the instance is never
  // destroyed on a plant switch (unlike AlertsUIAdapter._drawerVL, which
  // destroys on an empty list), so without this its remembered scroll
  // offset would carry over from a completely different plant's line list.
  _lsVLPlant:    null as string | null,

  _latenessHorizon: 14,                  // days; toggled by 7/14/28 segment buttons
  _latenessDrillKey: null as string | null,     // 'LINE|YYYY-MM-DD' for the currently-drilled cell

  // Set by _renderKPIs (single source, same pass that feeds _renderSituation)
  // so the greeting's flavor (ok/attn) can never disagree with the counts in
  // #wh-situation right next to it.
  _lastSituation: null as { todayCount: number; attention: number } | null,

  _renderDebounced: null as ReturnType<typeof setTimeout> | null,
  init(): void {
    Store.subscribe(evt => {
      if (evt.type === 'plant:selected') {
        Dashboard._refreshLineDropdown();
        Dashboard._refreshFilterBtns();
        Dashboard.render();
        return;
      }
      if (evt.type === 'master-data-changed') {
        // Master data (plant description/product focus/timezone) loads async
        // after plant:selected — re-render just the greeting when it lands,
        // rather than the whole KPI/heatmap render.
        Dashboard._renderGreeting();
        return;
      }
      if (evt.type === 'lines:selected') {
        // Single code path for every line-selection change, whether it
        // originated here (checkbox/clear) or on another screen (Gantt/
        // Table/Labor Plan/Master Data). Utilization.computeMatrix() with a
        // filtered task subset bypasses memoization entirely (CLAUDE.md), so
        // skip the expensive render while this tab isn't visible — App.goto
        // ('home') already calls Dashboard.render() unconditionally on
        // tab activation, so there's nothing to catch up on later.
        Dashboard._renderLineChecklist();
        Dashboard._refreshFilterBtns();
        if (document.getElementById('home-tab')?.classList.contains('active')) {
          Dashboard.render();
        }
        return;
      }
      if (evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate'
          || evt.type === 'task:update' || evt.type === 'alerts:change'
          || evt.type === 'calendar:change' || evt.type === 'blocks:change'
          || evt.type === 'firmed:change') {
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
    // Bucket rollover (morning/afternoon/evening) for the greeting — only the
    // time bucket can drift here; state/counts already re-render via the
    // tasks:bulk/alerts:change paths above. Boot-lifetime interval, no
    // cleanup needed (Dashboard is a boot-lifetime singleton).
    setInterval(() => {
      if (document.getElementById('home-tab')?.classList.contains('active')) Dashboard._renderGreeting();
    }, 60_000);
  },

  _filteredTasks(): NimbusTask[] {
    let tasks = Store.tasksForSelectedPlant();
    if (Dashboard._filterLines.size > 0) {
      tasks = tasks.filter(t => Dashboard._filterLines.has(t.MACHINE));
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

    // No pruning here anymore: _filterLines is the shared cross-screen Set —
    // see Store.selectedLines and GanttFilter._buildLineDropdown's identical note.
    Dashboard._allLines = [...new Set(Store.linesForSelectedPlant())].sort();
    Dashboard._renderLineChecklist();
  },

  // Scale mandate (CLAUDE.md Production Scale Roadmap): every plant/line picker
  // must stay filterable, not a bare scrollable checkbox list — this is the
  // dashboard's line filter's share of that, matching the Gantt/Orders dropdowns.
  _renderLineChecklist(): void {
    const list = document.getElementById('line-filter-checklist');
    Util.renderLineChecklist(list, Dashboard._allLines || [], Dashboard._filterLines, Dashboard._lineSearch,
      (line, checked) => {
        const next = new Set(Dashboard._filterLines);
        if (checked) next.add(line); else next.delete(line);
        Store.setSelectedLines(next, 'dashboard');
      });
  },

  _refreshFilterBtns(): void {
    const lineBtn   = document.getElementById('line-filter-btn');
    const lineLbl   = document.getElementById('line-filter-label');
    const clearBtn  = document.getElementById('dash-filter-clear');
    const hint      = document.getElementById('dash-filter-hint');

    Util.refreshMultiSelectLabel(lineLbl, lineBtn, Dashboard._filterLines);

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

  // Checkbox toggling now happens via _renderLineChecklist's onToggle callback
  // (routes through Store.setSelectedLines); no onchange="..." reaches this
  // method's old (cb: HTMLInputElement) shape anymore.
  _clearFilters(): void {
    // Routes through Store so the clear propagates everywhere; the
    // 'lines:selected' subscriber above does the checklist/button/render refresh.
    Store.setSelectedLines([], 'dashboard');
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
    Dashboard._renderFirmedList();
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
      Dashboard._lastSituation = null;
      Dashboard._renderGreeting();
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

    // Four action-oriented tiles, one calm row. Open Alerts and Firmed Orders were
    // trimmed off this row — both counts still surface in their own panels below
    // (alert-summary-count, the firmed-orders list) so nothing is lost, just decluttered.
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

    Dashboard._lastSituation = { todayCount: todayOrders.length, attention: conflictsToday + lateCount };
    Dashboard._renderSituation(Dashboard._lastSituation);
    Dashboard._renderGreeting();

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

  // Dashboard greeting: plant-named, time-of-day, state-aware (never
  // disagrees with #wh-situation right beside it — both read _lastSituation,
  // set in the same _renderKPIs pass). Always via inline Util.t(): the
  // #wh-greeting node carries no data-i18n, since this method owns it from
  // boot onward (see the comment on that element in index.html).
  _renderGreeting(): void {
    const el = document.getElementById('wh-greeting');
    const focusEl = document.getElementById('wh-plant-focus');
    if (!el) return;
    const plant = Store.selectedPlant;
    if (!plant) {
      el.textContent = Util.t('ui.hero_heading');
      if (focusEl) focusEl.hidden = true;
      return;
    }
    const mp = Store.masterPlant(plant);
    const name = (mp?.description ?? '').trim() || `${Util.t('ui.plant_label')} ${plant}`;
    const hour = Util.plantNowParts(mp?.timezone).hour;
    const bucket = hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 17 ? 'afternoon' : 'evening';
    const state = (Dashboard._lastSituation?.attention ?? 0) > 0 ? 'attn' : 'ok';
    const startOfYear = new Date(new Date().getFullYear(), 0, 0);
    const dayOfYear = Math.floor((Date.now() - startOfYear.getTime()) / 86_400_000);
    const variant = (dayOfYear % 2) + 1;
    el.textContent = Util.t(`ui.greet_${bucket}_${state}_${variant}`, { plant: name });
    if (focusEl) {
      const focus = (mp?.product_focus ?? '').trim();
      focusEl.textContent = focus;
      focusEl.hidden = !focus;
    }
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
    for (const tk of tasks) { const l = tk.MACHINE || 'Unknown'; (byLine[l] ||= []).push(tk); }
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
    const identityChanged = Dashboard._lsVLPlant !== Store.selectedPlant;
    Dashboard._lsVLPlant = Store.selectedPlant;
    Dashboard._lsVL.update(rowData, identityChanged ? { anchor: 'top' } : undefined);
  },

  _renderAlertSummary(): void {
    const list = document.getElementById('alert-summary-list');
    const count = document.getElementById('alert-summary-count');
    if (!list || !count) return;
    // Alert IDs are opaque data. Setup diagnostics include JSON state pairs,
    // so compiling an ID into an inline handler corrupts the HTML attribute
    // boundary and creates a DOM-injection sink.
    list.onclick = AlertsUIAdapter._handleAction;

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
    const _esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c: string) =>
      (({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'} as Record<string, string>)[c]));
    list.innerHTML = alerts.slice(0, 8).map(a => `
      <div class="alert-row sev-${a.sev}" data-alert-action="focus" data-alert-id="${_esc(a.id)}">
        <span class="sev" data-sev="${a.sev}" aria-label="${a.sev === 'err' ? 'Error' : a.sev === 'warn' ? 'Warning' : 'Info'}"></span>
        <div class="msg">${_esc(a.msg)}</div>
        <span class="meta">${a.time ? Util.fmtDT(a.time).slice(5, 16) : ''}</span>
        <button type="button" class="dismiss" data-alert-action="dismiss" data-alert-id="${_esc(a.id)}">×</button>
      </div>
    `).join('');
    if (alerts.length > 8) {
      list.insertAdjacentHTML('beforeend',
        `<div class="alert-summary-more" onclick="NIMBUS.AlertsUIAdapter.toggleDrawer()">See all ${alerts.length} alerts →</div>`);
    }
  },

  _renderFirmedList(): void {
    const list = document.getElementById('firmed-list');
    if (!list) return;
    // Union count/list (SAP OR frozen-horizon OR manual) — see Engine.firmingStatus.
    const firmed = Dashboard._filteredTasks().filter(t => Engine.firmingStatus(t).firmed);
    if (!firmed.length) { list.innerHTML = `<div class="empty-state">${Util.t('empty.no_firmed_orders')}</div>`; return; }
    list.innerHTML = firmed.slice(0, 12).map(t => `
      <div class="firmed-row">
        <span class="pin">🔒</span>
        <span class="id">${t.MACHINE || ''}</span>
        <span class="name">${t.text || t.ORDER || t.id}</span>
        <span class="when">${Util.fmtDT(t.start_date).slice(5, 16)}</span>
        <button class="btn btn-ghost sm" onclick="NIMBUS.Dashboard._unfirm('${t.id}')">${Util.t('btn.unfirm_dashboard')}</button>
      </div>
    `).join('');
  },
  _unfirm(id: string): void {
    Store.setFirmed([id], false, 'dashboard');
    notifyResidualFirming([id]);
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
    const allLines = [...new Set([...Store.linesForSelectedPlant(), ...tasks.map(t => t.MACHINE || 'Unknown')])].sort();
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
      const ln = t.MACHINE || 'Unknown';
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
  itemSet?: {
    items?: Record<string, {
      dom?: { box?: HTMLElement };
      data?: { type?: string; group?: string | null; start?: Date; end?: Date };
      displayed?: boolean;
      parent?: { top?: number; height?: number; isVisible?: boolean };
      show?: () => void;
      repositionX?: () => void;
    } | undefined>;
  };
  _setScrollTop?(top: number): void;
  _getScrollTop?(): number;
}

/** Custom time bar methods — real, stable vis-timeline v7.7.3 public API
 *  (https://visjs.github.io/vis-timeline/docs/timeline/#Custom_Time), just not
 *  yet enumerated on NimbusVendor.VisTimelineInstance in types/vendor.d.ts.
 *  Kept local since Timeline.rebuild's plant visibility-horizon marker is the
 *  only caller today. setCustomTimeMarker's `editable` only controls whether
 *  the title text becomes contenteditable — it does not affect bar dragging. */
interface VisCustomTimeApi {
  addCustomTime(time?: Date | number | string, id?: string | number): string | number;
  removeCustomTime(id: string | number): void;
  setCustomTime(time: Date | number | string, id?: string | number): void;
  setCustomTimeMarker(title: string, id?: string | number, editable?: boolean): void;
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
   firmed-order drags are "REVERTED in the vis DataSet before it can reach the
   Store"; the new characterization tests added by this task proved that is
   NOT what `_onDataSetUpdate` actually does, so this comment is corrected to
   match the real, unchanged behavior rather than the aspiration): firmed
   orders carry no per-item `editable:false` (only blackout blocks do — see
   `_itemForBlock`), so vis-timeline lets a user actually drag one. Inside
   `_onDataSetUpdate`, the `Store.isFirmed(id)` branch's `noActualChange` guard
   only distinguishes a genuine drag from a programmatic echo (Timeline.rebuild
   / _applyTaskPatch calling `_items.update()` inside `_suppressEvents`, or a
   redraw racing a drag-commit) — when the guard finds NO real change it drops
   the event, but when there IS a real change it falls through to the same
   commit path as a non-firmed drag ("Firmed items are user-draggable — fall
   through to normal update path"). In other words: today, a real drag on a
   firmed order DOES commit to the Store; only spurious no-op echoes are
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

  _businessOrderIdForItem(itemId: string | number): string | null {
    return Timeline.businessOrderIdForItem(itemId);
  },

  _isBusinessTimelineItem(itemId: string | number): boolean {
    return Interaction._businessOrderIdForItem(itemId) != null;
  },

  /** Alert-cell backgrounds are presentation zones, not business orders. A
   * real alertcell class is sufficient even on legacy items without `kind`. */
  _onAlertCellClick(props: Pick<NimbusVendor.VisEventProperties, 'item' | 'group' | 'time'>): void {
    if (!props.group || !props.time) return;
    if (props.item && Interaction._isBusinessTimelineItem(props.item)) return;
    const item = props.item != null ? Timeline._items!.get(String(props.item)) as TimelineVisItem | null : null;
    if (item && !item.className?.includes('alertcell-')) return;
    const dayKey = Util.dayKey(props.time);
    const cellId = `alertcell-${props.group}-${dayKey}`;
    if (!Timeline._items!.get(cellId)) return;
    NIMBUS!.AlertsUIAdapter!.showForCell!(String(props.group), dayKey);
  },

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
        const onBusinessItem = !!(p && p.item != null && Interaction._isBusinessTimelineItem(p.item));
        if (onBusinessItem) {
          // Mousedown started on an order item — this is an item-drag
          // gesture, not a canvas pan. Don't arm the peak tracker: order
          // drags routinely exceed 8px and must not be mistaken for a
          // canvas pan (that would wrongly suppress the trailing click's
          // Selection.set after a drag). The same semantic business-item check
          // is used by the click handler below.
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
        Interaction._onAlertCellClick(p);
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
          const id = Interaction._businessOrderIdForItem(p.item);
          if (!id) return;
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
      try { Timeline._tl!.setSelection(evt.ids.flatMap(id => Timeline.itemIdsForTask(id))); }
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

      // Routed through GanttFilter's public wrappers (→ Store.setSelectedLines)
      // instead of mutating `sel` directly — a raw Set mutation here would
      // update the data but never fire 'lines:selected', silently breaking
      // cross-screen propagation for this one gesture while everything else worked.
      if (isAlreadyIsolated) GanttFilter.restoreAllLines();
      else                   GanttFilter.isolateLine(groupId);

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

    const isOrderId = (id: string): boolean => !!Interaction._businessOrderIdForItem(id);

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
      const line = t.MACHINE || '—';
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
      const firmedBadge = Engine.firmingStatus(t).firmed
        ? `<span class="hov-firmed">🔒 ${Util.t('ui.hov_firmed_badge')}</span>` : '';

      return `
        <div class="hov-title">${esc(orderNo)} ${firmedBadge}</div>
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
        const itemId = String(props.item);
        if (!isOrderId(itemId)) return;
        const id = Interaction._businessOrderIdForItem(itemId);
        if (!id) return;
        // Suppress during active drag or marquee — the user is doing something.
        if (Interaction._isDragging || Interaction._marquee) return;

        clearTimeout(showTimer ?? undefined);
        activeId = itemId;
        showTimer = setTimeout(() => {
          if (activeId !== itemId) return;
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

    const isOrderId = (id: string): boolean => !!Interaction._businessOrderIdForItem(id);

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
      for (const h of hits) {
        const id = Interaction._businessOrderIdForItem(h);
        if (id) next.add(id);
      }
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

        // Vertical scroll — read scrollTop before AND after the call so we
        // accumulate the actual clamped delta without any DOM/BCR timing
        // issues. Routed through Timeline._setVScroll/_getVScroll (A3) —
        // same unified accessor scrollToLine and rebuild() use — instead of
        // reaching into the internal API directly.
        let vfraction = 0;
        if (my < cr.top + ZONE)         vfraction = -((cr.top + ZONE - my) / ZONE);
        else if (my > cr.bottom - ZONE) vfraction =  (my - (cr.bottom - ZONE)) / ZONE;
        if (vfraction !== 0 && tl) {
          const before = Timeline._getVScroll();
          Timeline._setVScroll(before - vfraction * MAX_VPXL);
          const after = Timeline._getVScroll();
          s.scrollDelta = (s.scrollDelta ?? 0) + (after - before);
          Timeline._vScrollTop = after;
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

    const id = Interaction._businessOrderIdForItem(props.item);
    if (!id) return;

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
      Timeline._tl.focus(Timeline.itemIdsForTask(id)[0] || String(id), { animation: { duration: 300 }, zoom: false });
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

    const id = Interaction._businessOrderIdForItem(props.item);
    if (!id) return;
    const t = Store.tasks[id];
    if (!t) return;

    Selection.set([id]);
    // Double-click action: focus-zoom AND open the full edit modal (if present).
    if (typeof Timeline.focus === 'function') Timeline.focus(id);
    if (Modal && typeof (Modal as ModalWithOpenEdit).openEdit === 'function') (Modal as ModalWithOpenEdit).openEdit!(t);
  },

  /** Drag commit: update the store and reflow ONLY if times/line actually changed.
   *  Firmed orders: only a spurious no-op echo (`noActualChange`) is dropped —
   *  a genuine drag on a firmed order still commits (see the corrected header
   *  comment above; CQ-1 Phase 3 Task 5). */
  _onDataSetUpdate(props: InteractionDataSetUpdateProps): void {
    for (const rawId of props.items) {
      const itemId = String(rawId);
      const id = Interaction._businessOrderIdForItem(itemId);
      if (!id) continue;
      const v = Timeline._items!.get(itemId) as TimelineVisItem | null;
      if (!v) continue;
      const t = Store.tasks[id];
      if (!t) continue;
      const expectedItem = Timeline._itemsForTask(t).find(item => item.id === itemId)
        || Timeline._itemForTask(t);

      /* ----- Firmed-order protection ------------------------------------
       * If the task is firmed, revert any real drag before it hits the Store.
       * But first distinguish a *real drag* from a *programmatic echo*:
       * Timeline.rebuild and _applyTaskPatch both call _items.update() inside
       * _suppressEvents, so they won't reach here — but if a redraw races
       * with a drag-commit (or a third-party integration calls update()
       * without suppression), we'd see a bogus "change" of zero magnitude.
       * The noActualChange guard catches that case and drops the event.
       * ---------------------------------------------------------------- */
      if (Store.isFirmed(id)) {
        const currentStart = Util.snap(new Date(v.start));
        const currentGroup = v.group || t.MACHINE;
        const noActualChange = t.start_date &&
          currentStart.getTime() === expectedItem.start.getTime() &&
          currentGroup === t.MACHINE;

        if (noActualChange) {
          this._log('update:ignored', { id, reason: 'firmed task, no change' });
          continue;
        }
        // Firmed items are user-draggable — fall through to normal update path
      }

      const newStart = Util.snap(new Date(v.start));
      const newEnd   = Util.snap(new Date(v.end));
      const newLine  = v.group || t.MACHINE;

      const moved = newStart.getTime() !== expectedItem.start.getTime()
                 || newEnd.getTime()   !== expectedItem.end.getTime()
                 || newLine !== t.MACHINE;

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
      // move all non-firmed selected items by the same time + line delta.
      const deltaMs  = newStart.getTime() - t.start_date.getTime();
      const lineMoved = newLine !== t.MACHINE;
      const selIds = Selection.ids().filter(sid => sid !== id && !Store.isFirmed(sid));

      if (selIds.length > 0 && (Math.abs(deltaMs) > 0 || lineMoved)) {
        // Snapshot all affected tasks for undo
        const allIds = [id, ...selIds];
        const snap = UndoStack.snapshotTasks(allIds);

        // Apply the dragged item — routed through manualSchedulePatchFor so an
        // already-split order (>=2 scheduleSegments) is shifted rather than
        // collapsed or re-derived (OD-B1a).
        // Compute and validate the dragged item's patch, but do NOT commit it
        // to Store yet — atomicity requires every companion's patch to also
        // validate successfully before ANY mutation (Store or Timeline item)
        // happens. See the (now-deleted) regeneration branch's contract: all
        // patches computed first, one atomic Store.updateMany after.
        const draggedPatch = Engine.manualSchedulePatchFor(t, newLine, newStart);
        if (!draggedPatch?.start_date || !draggedPatch.end_date) {
          Toast.show(Util.t('toast.commit_failed'), 'error');
          Timeline._scheduleRebuild();
          continue;
        }

        // Apply the same delta to each companion — routed through
        // manualSchedulePatchFor (not a hand-rolled {start_date, end_date,
        // MACHINE} object) so a companion that is itself already split
        // (>=2 scheduleSegments) has its segments shifted too, instead of
        // its parent boundaries moving while its child segments go stale at
        // their old absolute positions. Mirrors the deleted regeneration
        // branch's own contract: "Companion parents retain the user's
        // relative drag delta."
        // (skippedFirmed stays empty today — selIds above already excludes firmed
        // tasks — but is preserved as-is; not this task's scope to remove.)
        // This loop only computes and validates each companion's patch — no
        // Store or Timeline mutation happens here, since a later companion
        // failing must leave earlier companions (and the dragged item)
        // untouched too.
        const skippedFirmed: string[] = [];
        const companionPatches: Array<{ id: string; changes: Partial<NimbusTask> }> = [];
        const companionItemUpdates: Array<{ id: string; start: Date; end: Date; group: string }> = [];
        let companionFailed = false;
        for (const sid of selIds) {
          const st = Store.tasks[sid];
          if (!st || !st.start_date) continue;
          const sNewLine  = lineMoved ? newLine : (st.MACHINE || 'Unknown');
          const sRequestedStart = new Date(st.start_date.getTime() + deltaMs);
          const changes = Engine.manualSchedulePatchFor(st, sNewLine, sRequestedStart);
          if (!changes?.start_date || !changes.end_date) {
            companionFailed = true;
            break;
          }
          companionPatches.push({ id: sid, changes });
          companionItemUpdates.push({ id: sid, start: changes.start_date, end: changes.end_date, group: sNewLine });
        }
        if (companionFailed) {
          Toast.show(Util.t('toast.commit_failed'), 'error');
          Timeline._scheduleRebuild();
          continue;
        }

        // Every patch validated — commit atomically: dragged item, then
        // companions, then their Timeline item mirrors.
        Store.updateTask(id, draggedPatch, 'timeline');
        if (companionPatches.length) Store.updateMany(companionPatches, 'timeline');
        for (const upd of companionItemUpdates) {
          Timeline._suppressEvents = true;
          try {
            Timeline._items!.update({ id: upd.id, start: upd.start, end: upd.end, group: upd.group });
          } finally { Timeline._suppressEvents = false; }
        }
        Timeline.finishSetupDrag(new Set([t.MACHINE || 'Unknown', newLine]));

        if (skippedFirmed.length) Toast.show(Util.t('toast.firmed_count_not_moved', { count: skippedFirmed.length }), 'warn');

        UndoStack.push(`Move ${allIds.length} orders`,
          () => { UndoStack.restoreTasks(snap); Alerts.scheduleRecompute(); });
        this._clearGhosts();
        return;
      }

      // Single-item drag (original behaviour) — routed through
      // manualSchedulePatchFor so an already-split order (>=2
      // scheduleSegments) is shifted by the drag delta rather than
      // collapsed or re-derived (OD-B1a).
      const snap = UndoStack.snapshotTasks([id]);

      const patch = Engine.manualSchedulePatchFor(t, newLine, newStart);
      if (!patch?.start_date || !patch.end_date) {
        Toast.show(Util.t('toast.commit_failed'), 'error');
        Timeline._scheduleRebuild();
        continue;
      }
      Store.updateTask(id, patch, 'timeline');
      Timeline.finishSetupDrag(new Set([t.MACHINE || 'Unknown', newLine]));

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
    const dragItemId = String(props.id);
    const dragId = Interaction._businessOrderIdForItem(dragItemId);
    if (!dragId) return;

    this._isDragging = true;
    this._startEdgeScroll();

    const _tip = document.querySelector('.vis-tooltip') as HTMLElement | null;
    if (_tip) _tip.style.display = 'none';

    const dragTask = Store.tasks[dragId];
    if (dragTask) Timeline.dimSetupForDrag(new Set([
      dragTask.MACHINE || 'Unknown',
      props.group == null ? (dragTask.MACHINE || 'Unknown') : String(props.group),
    ]));
    const selIds = Selection.ids().filter(sid => sid !== dragId);
    if (!selIds.length) return;

    // A segmented parent regenerates its full aggregate on drop. Do not show
    // a wall-clock ghost that implies its old nonproductive gaps will move.
    if (Timeline.hasMultipleItemsForTask(dragId) || selIds.some(id => Timeline.hasMultipleItemsForTask(id))) return;

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
      const pl = peer.MACHINE || 'Unknown';
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
      const line = st.MACHINE || 'Unknown';
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
    Timeline.finishSetupDrag();
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

    // F → toggle Firmed
    if (e.key.toLowerCase() === 'f' && !mod && Selection.size()) {
      e.preventDefault();
      const ids = Selection.ids();
      const allFirmed = ids.every(id => Store.isFirmed(id));
      Store.setFirmed(ids, !allFirmed, 'interaction');
      if (allFirmed) notifyResidualFirming(ids); // was firmed, now unfirming
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
    const ids = Selection.ids().filter(id => !Store.isFirmed(id));
    if (!ids.length) { Toast.show(Util.t('toast.unschedule_all_firmed'), 'warn'); return; }
    // An explicit segment aggregate is atomic. Do not clear just its parent
    // envelope, which Store would correctly reconstruct from its children.
    const eligibleIds = ids.filter(id => (Store.tasks[id]?.scheduleSegments?.length ?? 0) < 2);
    if (!eligibleIds.length) {
      Toast.show('Split orders must be rescheduled as a whole.', 'warn');
      return;
    }
    const snap = UndoStack.snapshotTasks(eligibleIds);
    const patches = eligibleIds.map(id => ({ id, changes: { start_date: null, end_date: null } }));
    Store.updateMany(patches, 'interaction');
    UndoStack.push(`Unschedule ${eligibleIds.length} order(s)`,
                   () => UndoStack.restoreTasks(snap));
    Toast.show(
      eligibleIds.length === ids.length
        ? Util.t('toast.unscheduled_orders', { count: eligibleIds.length })
        : `${eligibleIds.length} order(s) unscheduled; split orders were left intact.`,
      eligibleIds.length === ids.length ? 'success' : 'warn');
  },

  _navigateSelection(key: ArrowKey): void {
    const currentId = Selection.ids()[0];
    const cur = Store.tasks[currentId];
    if (!cur || !cur.start_date) return;

    const allLines = [...new Set(Store.tasksArr
      .filter(t => t.MACHINE)
      .map(t => t.MACHINE))].sort();

    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const peers = Store.tasksArr
        .filter(t => t.MACHINE === cur.MACHINE && t.start_date)
        .sort((a, b) => a.start_date!.getTime() - b.start_date!.getTime());
      const i = peers.findIndex(t => String(t.id) === currentId);
      const j = key === 'ArrowLeft' ? i - 1 : i + 1;
      if (j >= 0 && j < peers.length) Selection.set([String(peers[j].id)]);
    } else {
      const li = allLines.indexOf(cur.MACHINE);
      const lj = key === 'ArrowUp' ? li - 1 : li + 1;
      if (lj < 0 || lj >= allLines.length) return;
      const targetLine = allLines[lj];
      // Pick the task on the new line that's temporally closest to current.
      const candidates = Store.tasksArr
        .filter(t => t.MACHINE === targetLine && t.start_date);
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
          ${s.firmedCount ? ` · ${s.firmedCount} firmed` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button class="btn btn-ghost" data-action="firm">${Util.t('btn.firm_all')}</button>
          <button class="btn btn-ghost" data-action="unfirm">${Util.t('btn.unfirm_all')}</button>
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
    panel.querySelector('[data-action="firm"]')?.addEventListener('click', () => Interaction._bulkFirm(true));
    panel.querySelector('[data-action="unfirm"]')?.addEventListener('click', () => Interaction._bulkFirm(false));
    panel.querySelector('[data-action="unschedule"]')?.addEventListener('click', () => Interaction._unscheduleSelected());
    panel.querySelector('[data-action="clear"]')?.addEventListener('click', () => Selection.clear());
  },

  _bulkFirm(firmed: boolean): void {
    const ids = Selection.ids();
    if (!ids.length) return;
    Store.setFirmed(ids, firmed, 'interaction');
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

/** One entry / the overall shape of the `GET /color-wheel/{plant}` response body.
 *  Read only by ColorWheelViewer's `_load()` now — Stage 3 retired
 *  OptimizeDialog's own per-plant color→rank prefetch of this endpoint in favour
 *  of Store.priorityRankMaps (the generic, all-fields rank source the
 *  optimizer's term factory actually reads). `meta` (CQ-1 Phase 6 Task 8) is the
 *  upload-metadata half of the same body. */
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
  respectFirmed?: boolean;
  /** @deprecated pre-rename key, still read as a fallback for presets saved
   *  before the fixed→firmed rename — see the `?? _od.respectFixed` read. */
  respectFixed?: boolean;
  respectCalendar?: boolean;
}

/** Mirrors Engine.runAndApply's opts contract (schedule-services.mts) — built by
 *  run() below and threaded through OptimizerPreview.runWithPreview. Engine.
 *  runAndApply itself takes `opts: Record<string, unknown>` (an open bag it
 *  reads defensively via individual `as` casts), so this needs the same index
 *  signature to stay assignable at that call site — same "known fields + open
 *  bag" shape as NimbusTask (types.mts) / InteractionTraceEntry above. */
interface OptimizationAuditDetails {
  mode: OptimizerMode;
  wheelUsed: boolean;
  taskCount: number;
  scope: 'plant' | 'lines';
  lines: string[] | null;
  activePriorityFields: string[];
  unrankedPriorityFields: string[];
  splitOrderPolicy: SplitOrderPolicy;
}

interface OptimizerRunOptions {
  plant?: string | null;
  lines?: string[] | null;
  startDate?: Date;
  endDate?: Date;
  respectFirmed?: boolean;
  respectCalendar?: boolean;
  auditDetails?: OptimizationAuditDetails;
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
  let _wheelFetchToken = 0;          // monotonic token to ignore stale responses
  let _startDirty = false;
  let _endDirty = false;

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
    const dynamic = Store.tasksArr.map(t => Store.getPlantForLine(t.MACHINE)).filter(Boolean) as string[];
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
    if (_mode === 'backlog') _applyBacklogDefaults();
    else if (_preset === 'horizon') applyPreset('horizon');
  }

  function setScope(scope: string) {
    _scope = scope === 'lines' ? 'lines' : 'plant';
    document.querySelectorAll<HTMLElement>('.opt-scope-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.scope === _scope)
    );
    const panel = document.getElementById('opt-lines-panel');
    if (panel) panel.hidden = _scope !== 'lines';
    if (_scope === 'lines') _renderLines();
    if (_mode === 'backlog') _applyBacklogDefaults();
  }

  function _linesForPlant() {
    if (!_plant) return [];
    const set = new Set(Store.linesForSelectedPlant());
    for (const t of Store.tasksByPlant(_plant)) {
      const l = t.MACHINE || 'Unknown';
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
      const l = t.MACHINE || 'Unknown';
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
    if (_mode === 'backlog') _applyBacklogDefaults();
  }

  function _onLineToggle(line: string, checked: boolean) {
    if (checked) _selectedLines.add(line);
    else _selectedLines.delete(line);
    const count = document.getElementById('opt-lines-count');
    const total = _linesForPlant().length;
    if (count) count.textContent = `${_selectedLines.size} of ${total} selected`;
    if (_mode === 'backlog') _applyBacklogDefaults();
  }

  function _backlogNow(): Date {
    const timezone = Store.masterData?.plants?.find(p => p.plant === _plant)?.timezone;
    if (typeof timezone === 'string' && timezone.trim()) {
      try { return Engine._plantWallNow(timezone, new Date()); }
      catch { /* Run surfaces the configured-timezone error with an actionable message. */ }
    }
    // The engine still blocks this configuration at Run. This local fallback
    // merely gives the planner usable editable fields while they configure the
    // required plant timezone.
    const local = new Date(); local.setSeconds(0, 0); return local;
  }

  function _addCalendarMonths(date: Date, months: number): Date {
    const result = new Date(date);
    const day = result.getDate();
    result.setDate(1);
    result.setMonth(result.getMonth() + months);
    const last = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
    result.setDate(Math.min(day, last));
    return result;
  }

  function _applyBacklogDefaults() {
    if (!_plant) return;
    const now = _backlogNow();
    const scopedLines = _scope === 'lines' && _selectedLines.size ? _selectedLines : null;
    const tasks = Store.tasksByPlant(_plant).filter(t => !scopedLines || scopedLines.has(t.MACHINE));
    const pastStarts = tasks.map(t => t.start_date).filter((d): d is Date => !!d && d < now);
    const latestEnds = tasks.map(t => t.end_date).filter((d): d is Date => !!d);
    const computedStart = pastStarts.length ? new Date(Math.min(...pastStarts.map(d => d.getTime()))) : now;
    let computedEnd = latestEnds.length
      ? new Date(Math.min(Math.max(...latestEnds.map(d => d.getTime())), _addCalendarMonths(now, 4).getTime()))
      : _addCalendarMonths(now, 4);
    if (computedEnd < computedStart) computedEnd = _addCalendarMonths(computedStart, 4);
    if (!_startDirty) _start = computedStart;
    if (!_endDirty) _end = computedEnd;
    _fpStart?.setDate(_start!, false);
    _fpEnd?.setDate(_end!, false);
    const sb = document.getElementById('opt-start-btn');
    const eb = document.getElementById('opt-end-btn');
    if (sb && _start) sb.textContent = _displayDate(_start);
    if (eb && _end) eb.textContent = _displayDate(_end);
    _updateSummary();
  }

  function _applyModeOptions() {
    const backlog = _mode === 'backlog';
    const firmed = document.getElementById('opt-chk-firmed') as HTMLInputElement | null;
    const calendar = document.getElementById('opt-chk-calendar') as HTMLInputElement | null;
    if (firmed) firmed.disabled = backlog;
    if (calendar) { calendar.checked = backlog || calendar.checked; calendar.disabled = backlog; }
    const firmedLabel = document.getElementById('opt-firmed-label');
    const calendarLabel = document.getElementById('opt-calendar-label');
    if (firmedLabel) firmedLabel.title = backlog ? 'Firmed orders move when reached and remain firmed.' : '';
    if (calendarLabel) calendarLabel.title = backlog ? 'Calendar adherence is required for Remove Backlog.' : '';
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
    if (_mode === 'backlog' && key !== 'custom') {
      _startDirty = true;
      _endDirty = true;
    }
    _updateSummary();
  }

  function selectMode(mode: OptimizerMode) {
    _mode = mode;
    document.querySelectorAll<HTMLElement>('.opt-strategy-pill').forEach((c) =>
      c.classList.toggle('active', c.dataset.mode === mode)
    );
    _applyModeOptions();
    if (mode === 'backlog') _applyBacklogDefaults();
    else _updatePlantBadge();
  }

  /** Does this plant have any colorWheel ranks the optimizer could apply?
   *  Delegates to Engine.hasPriorityRanks — the SHARED implementation, so this
   *  and Plant → System Settings' own hints can never drift apart. Reads the
   *  exact same Store.priorityRankMaps that Engine._sortTerms' term factory
   *  reads, and counts per-line overrides as well as the plant-wide list (Stage 3
   *  replaced the old `GET /color-wheel/{plant}` probe, which saw plant-wide
   *  lists only and therefore mis-reported a plant configured purely with
   *  per-line overrides). Callers must have ensured the cache is fresh for
   *  `_plant`.
   *
   *  Now colorWheel-specific for ONE remaining reason: the `wheel_used` field in
   *  the optimization_run audit payload, which existing audit rows are keyed on.
   *  The badge and the pre-Run confirm both moved to the all-fields
   *  Engine.unrankedActiveFields — do not re-point either back here. */
  function _hasColorRanks(): boolean {
    return Engine.hasPriorityRanks('colorWheel');
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
      // Deliberately does NOT clear the rank cache: `_plant` is null only when
      // the dialog found no plant data at all, which says nothing about the
      // plant Store is still loaded for.
      setBadge('none', '⚠', Util.t('ui.opt_badge_no_plant'));
      return;
    }

    if (_mode === 'backlog') {
      setBadge('none', '↪', 'Remove Backlog preserves the existing sequence and does not use priority lists.');
      return;
    }
    setBadge('loading', '', Util.t('ui.opt_badge_checking'));
    const token = ++_wheelFetchToken;

    // Prefetch this plant's priority rank maps so (a) the badge reflects what
    // the optimizer will actually rank on, and (b) run() finds
    // Persistence._rankMapsPlant already fresh and needs no second round-trip
    // on submit — the same "populated by _updatePlantBadge, consumed by run()"
    // role the retired per-plant color→rank cache played. Safe to load into the
    // shared (non-plant-keyed) Store cache from here because `_plant` is always
    // Store.selectedPlant at this point: both callers (_buildPlantSelect and
    // selectPlant) call Store.setSelectedPlant first. Never rejects.
    Persistence.loadPriorityRankMaps(plant).then(() => {
      if (token !== _wheelFetchToken) return; // stale response — ignore
      if (Persistence._rankMapsPlant !== plant) {
        // Fetch resolved non-ok, or threw — cache is empty, not authoritative.
        setBadge('warn', '○', Util.t('ui.opt_badge_check_failed'));
        return;
      }
      // Reports on ALL of the plant's active priority fields, not colorWheel
      // alone: on a plant that sequences by tooling this badge used to sit
      // permanently on the ⚠ "no color wheel" state even with every PRT list
      // loaded, and would now also contradict the (generalized) pre-Run confirm
      // right next to it.
      //
      // Every tooltip goes through Util.t (`ui.opt_badge_*`, all five locales).
      // These strings were the last hardcoded UI text on this dialog: locale
      // keys for the five pre-Stage-3 wordings had in fact been authored and
      // then left unwired, so the badge was interpolating LOCALIZED field names
      // (`constraint.<key>`, below) into an English sentence — a mixed-language
      // tooltip for every non-en user. The field-name interpolation was already
      // right and is kept as-is; only the surrounding sentence moved.
      const active   = Engine.activeConstraintKeys(plant);
      const unranked = Engine.unrankedActiveFields(plant);
      if (!active.length) {
        setBadge('warn', '○', Util.t('ui.opt_badge_none_enabled'));
      } else if (!unranked.length) {
        setBadge('active', '✓', Util.t('ui.opt_badge_lists_loaded', {
          fields: active.map(k => Util.t(`constraint.${k}`)).join(' → '),
        }));
      } else {
        setBadge('warn', '○', Util.t('ui.opt_badge_lists_missing', {
          fields: unranked.map(k => Util.t(`constraint.${k}`)).join(', '),
        }));
      }
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
    _startDirty = false;
    _endDirty = false;
    // Seed from the user's saved optimizer defaults (pref('optimizerDefaults'))
    // when present, so the dialog opens pre-filled with their preferred strategy,
    // time window, and option toggles. Falls back to the historical defaults
    // (horizon preset / changeover / toolbar checkbox state) otherwise.
    let _od: OptimizerDefaults | null = null;
    try { _od = Store.pref('optimizerDefaults') as OptimizerDefaults | null; } catch {}
    // Sync option checkboxes from the Gantt toolbar's existing chk- elements.
    // P2: dropped the dead `chk-respect-fixed` read here — no such element
    // exists in index.html (confirmed via grep), so it was always null and
    // this mirror never actually ran; the "respect firmed" checkbox is seeded
    // purely from the saved optimizer defaults below.
    const rcEl = document.getElementById('chk-respect-calendar') as HTMLInputElement | null;
    const ofEl = document.getElementById('opt-chk-firmed') as HTMLInputElement | null;
    const ocEl = document.getElementById('opt-chk-calendar') as HTMLInputElement | null;
    if (rcEl && ocEl) ocEl.checked = rcEl.checked;
    // Saved defaults override the toolbar mirror when present. Older saved
    // presets used the pre-rename `respectFixed` key — fall back to it.
    if (_od && typeof _od === 'object') {
      const _respectFirmed = (_od.respectFirmed ?? _od.respectFixed);
      if (ofEl && typeof _respectFirmed === 'boolean')      ofEl.checked = _respectFirmed;
      if (ocEl && typeof _od.respectCalendar === 'boolean') ocEl.checked = _od.respectCalendar;
    }
    _initPickers();
    _buildPlantSelect();
    // Only the "safe" no-date presets seed cleanly (custom needs explicit dates).
    const savedPreset = _od?.preset;
    const _seedPreset: string = (savedPreset && ['horizon', '2w'].includes(savedPreset)) ? savedPreset : 'horizon';
    applyPreset(_seedPreset);
    const savedMode = _od?.mode;
    // A previously saved unsupported strategy is intentionally normalized to
    // the default changeover strategy.
    const _seedMode: OptimizerMode = (savedMode && ['spt', 'changeover', 'backlog'].includes(savedMode)) ? (savedMode as OptimizerMode) : 'changeover';
    _startDirty = false;
    _endDirty = false;
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
    const sfEl = document.getElementById('opt-chk-firmed') as HTMLInputElement | null;
    const scEl = document.getElementById('opt-chk-calendar') as HTMLInputElement | null;

    // Remember the chosen strategy/window/options as this user's optimizer
    // defaults so the dialog pre-fills the same way next time (feature: optimizer
    // defaults). Self-service pref — persisted via the debounced PATCH.
    try {
      Session.setPref('optimizerDefaults', {
        mode: _mode, preset: _preset,
        respectFirmed:   sfEl?.checked ?? true,
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

    // Open the preview dialog with a spinner IMMEDIATELY — before the rank-map
    // freshness fetch below and the config-modal close transition. Otherwise
    // the user stares at a blurry frozen page for ~1–2s with no visible
    // response to their click.
    OptimizerPreview.showLoading(_mode, plant);
    // Hide the config modal RIGHT NOW (no 230ms fade). Its backdrop sits at
    // z-index 3000 with blur(12px) and would cover the preview spinner
    // (z=2000) for the entire await + fade duration. Hiding immediately is
    // what makes the spinner actually visible on click.
    close(true);

    // --- Rank-source freshness guard (Stage 3) ---------------------------
    // The Stage 3 replacement for the retired per-plant color→rank cache and
    // its pre-Run fallback fetch. Engine._sortTerms now resolves EVERY priority
    // field's rank straight out of Store.priorityRankMaps, so that cache — not
    // a single color map — is what has to be fresh for this plant before Run. It
    // normally already is (Persistence.load() fetches it on every plant
    // select, and _updatePlantBadge prefetches it on open / plant change), but
    // a Run clicked before that resolves — or after it failed — would
    // otherwise rank EVERY order 999999 on EVERY field: configured, inert and
    // silent. Awaiting here restores the guarantee the deleted fetch provided.
    // Note this replaces the old 1500 ms AbortSignal bound with a 4000 ms
    // race (Phase 2, Pkg D): back then a missing wheel still left a usable
    // ORDER_Y fallback, so cutting the fetch short was cheap; now the ranks
    // are load-bearing, so the fetch is awaited but still BOUNDED rather than
    // waited on forever. On timeout the flow proceeds regardless —
    // loadPriorityRankMaps never rejects, and either way (slow fetch or a
    // failing/non-ok response that returns promptly) the `!ranksFresh` /
    // unrankedActiveFields check and its confirm dialog right below is the
    // real safety net, so ranks are never silently skipped.
    let wheelUsed = false;
    let unrankedFields: string[] = [];
    if (_mode !== 'backlog') {
      if (Persistence._rankMapsPlant !== plant) {
        const _rankMapFetchT0 = performance.now();
        // Bound this await so a slow/hung fetch cannot stall the Run click
        // indefinitely; the timer is cleared once the real fetch settles so
        // no stray timer lingers when it wins the race.
        await new Promise<void>(resolve => {
          let done = false;
          const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
          const timer = setTimeout(finish, 4000);
          Persistence.loadPriorityRankMaps(plant).then(finish);
        });
        PerfMonitor.record('Optimize.rankMapFetch', performance.now() - _rankMapFetchT0);
      }
      const ranksFresh = Persistence._rankMapsPlant === plant;
      wheelUsed = ranksFresh && _hasColorRanks();
      unrankedFields = Engine.unrankedActiveFields(plant);
    }

    // Which of this plant's ACTIVE priority fields would rank nothing? Confirm
    // when ANY of them would, not just colorWheel (N11,
    // docs/scheduling_priority.md): since Stage 3 every field in the tree
    // contributes a real sort term, so a plant that sequences purely on
    // prt01/prt02/productionVersion can be just as silently inert as one with a
    // missing wheel — and used to get no warning at all, including when the rank
    // fetch failed outright. A field the plant has switched OFF is not active,
    // so it is not in this list: optimizing without it is intentional, don't nag.
    //
    // unrankedActiveFields reads the same (possibly empty) cache the terms read,
    // so a failed/non-ok fetch surfaces here as "every active field unranked"
    // and needs no separate !ranksFresh branch. That also closes the case where
    // a failed REFETCH wiped the cache while _rankMapsPlant still matched:
    // ranksFresh was true, the old colorWheel probe found nothing, and the run
    // went ahead unranked and unannounced.
    if (unrankedFields.length && _mode === 'changeover') {
      const names = unrankedFields.map(k => Util.t(`constraint.${k}`)).join(', ');
      const ok = await Modal.confirm({
        title: Util.t('modal.no_priority_ranks_confirm_msg', { plant, fields: names }),
      });
      if (!ok) { OptimizerPreview.hideLoading(); restoreRunBtn(); return; }
    }

    const linesScope = (_scope === 'lines' && _selectedLines.size) ? Array.from(_selectedLines) : null;
    const optsForEngine: OptimizerRunOptions = {
      plant,
      lines:           linesScope,
      startDate:       _start ?? (() => { const d = new Date(); d.setSeconds(0, 0); return d; })(),
      endDate:         _end   ?? new Date(Date.now() + 28 * Config.MS_DAY),
      respectFirmed:   sfEl?.checked ?? true,
      respectCalendar: _mode === 'backlog' ? true : (scEl?.checked ?? true),
      runAt:           new Date(),
      auditDetails: _mode === 'backlog' ? undefined : {
        mode: _mode,
        wheelUsed,
        taskCount: Store.tasksArr.length,
        scope: _scope,
        lines: linesScope || null,
        activePriorityFields: Engine.activeConstraintKeys(plant),
        unrankedPriorityFields: unrankedFields,
        splitOrderPolicy: Engine.splitOrderPolicyFor(plant),
      },
    };

    // Config modal was already hidden (close(true) above) before the rank-map
    // freshness guard — no second close() needed here.

    // Defer the optimizer run by one frame so the modal-close paint and the
    // heavy subscriber fanout don't fight for the same main-thread tick.
    // Route through OptimizerPreview (C4) — wraps Engine.runAndApply with
    // a pre/post KPI comparison and an apply/discard step.
    requestAnimationFrame(() => setTimeout(() => {
      OptimizerPreview.runWithPreview(_mode, optsForEngine);
    }, 0));

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
      _startDirty = true;
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
      _endDirty = true;
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

interface PreviewExplanation {
  impact: {
    production: { before: number; after: number };
    setup: { before: number; after: number };
    occupiedHours: { before: number; after: number };
    lateness: { beforeOrders: number; afterOrders: number; beforeHours: number; afterHours: number };
    utilization: { before: number; after: number };
    sequences: { changed: number };
  };
  reasons: Array<{ code: string; message: string; line?: string; taskId?: string; outcome: 'accepted' | 'rejected' }>;
  constraints: string[];
  missingPairs: Array<{ line: string; predecessorOrderId?: string | null; successorOrderId?: string | null; fromState?: string | null; toState?: string | null; reason: string }>;
  missingPairsTotal: number;
  unchangedLines: string[];
  /** Tally of orders actually placed in this candidate without a resolvable
   *  setup transition (no changeover bar) — the never-freeze fallback,
   *  counted from the dedicated `'scheduled-without-setup'` missingEdge
   *  reason, which `placeUnknownTail` emits for a tail-placed order and (since
   *  A1) `candidateForSequence` also emits directly for a known-but-uncovered
   *  transition admitted into the covered-core sequence. Derived from
   *  `candidate.missingEdges` restricted to ids that appear in
   *  `candidate.patches`, so a rejected/unplaced edge never inflates this
   *  count (see `missingPairs` for the full uncovered-transition list). */
  scheduledWithoutSetup: { orders: number; lines: number };
  /** B3: orders in scope for this run (plant + line filter + excludeFromOpt)
   *  that ended up with neither a patch nor a firmed/pinned exemption — i.e.
   *  "not scheduled". Derived by set difference against `candidate.patches`,
   *  never a field threaded through CandidateResult (see runAndApply's own
   *  B3 comment in schedule-services.mts for why: the worst drops produce no
   *  diagnostic object at all, so there is nothing else to collect from). */
  unplacedOrders: { orders: number; lines: number };
  search: { candidateCount: number; method: string; termination: string; runtimeMs: number; limitReached: boolean };
  /** Aggregate prune tally for the whole run (§4.3 docs/archive/OPTIMIZER-PREVIEW.md), bucketed
   *  from candidate.explanation's reason codes. Only genuinely exclusionary codes
   *  count — per-order placement/acceptance log entries (e.g. 'due-date-first-placement')
   *  are not prunes and are excluded, not rolled into 'other'. */
  prunes: { setup: number; firmed: number; capacity: number; other: number; total: number };
}

interface PreviewExplanationInput {
  productionBefore: number;
  productionAfter: number;
  preKpis: OptimizerKpis;
  postKpis: OptimizerKpis;
  /** B3: the run-scoped candidate pool (plant + opts.lines + excludeFromOpt,
   *  using the same plant resolution as B7) that `unplacedOrders` is diffed
   *  against. Omitted only by callers that don't want the tally (none today). */
  unplacedCandidates?: ReadonlyArray<{ id: string; line: string }>;
  /** Firmed/pinned ids — deliberately never moved, so never counted as unplaced. */
  firmedIds?: ReadonlySet<string> | ReadonlyArray<string>;
}

const PREVIEW_REASON_LIMIT = 8;
const PREVIEW_MISSING_PAIR_LIMIT = 12;

/** Reason codes that represent a genuine exclusion (order/line left out of the
 *  plan), keyed to the §4.3 prune buckets. Codes not listed here are placement
 *  successes or policy-chooser notes (e.g. 'due-date-first-placement',
 *  'firmed-incoming-setup', 'covered-firmed-boundary-fallback') and must never be
 *  tallied as prunes — see docs/archive/OPTIMIZER-PREVIEW.md §4.3 open question 2. There is
 *  no 'color block' or 'due date' code in this engine today; only setup,
 *  firmed-boundary and capacity-deferral exclusions are ever emitted. */
const PRUNE_BUCKET_BY_CODE: Record<string, 'setup' | 'firmed' | 'capacity' | 'other'> = {
  'rejected-uncovered-transition': 'setup',
  'setup-incompatible': 'setup',
  'setup-sequence-infeasible': 'setup',
  'setup-definition-unavailable': 'setup',
  'spt-sequence-infeasible': 'setup',
  'setup-signature-incompatible': 'setup',
  'override-inactive': 'firmed',
  'firmed-boundary-infeasible': 'firmed',
  'firmed-boundary-fallback-ambiguous': 'firmed',
  'firmed-boundary-invalid': 'firmed',
  'incoming-firmed-setup-infeasible': 'firmed',
  'protected-firmed-boundary-outside-horizon': 'firmed',
  'due-work-unadmitted': 'capacity',
  'trailing-fragment-unadmitted': 'capacity',
  'unknown-setup-tail-unplaced': 'capacity',
  'initial-state-unknown': 'other',
  'firmed-boundary-state-unknown': 'other',
};

function tallyPrunes(explanation: ReadonlyArray<CandidateReason>): PreviewExplanation['prunes'] {
  const prunes = { setup: 0, firmed: 0, capacity: 0, other: 0, total: 0 };
  for (const reason of explanation) {
    const bucket = PRUNE_BUCKET_BY_CODE[reason.code];
    if (!bucket) continue;
    prunes[bucket] += 1;
    prunes.total += 1;
  }
  return prunes;
}

/** Target KPIs a finalist's whyNot sentence is scored against — the same three
 *  targets the verdict banner scores (changeovers, late_count, late_h); span_h
 *  and peak_util_pct are context-only, never part of a finalist's rationale.
 *  `phrase` renders the quantified delta the docs/archive/OPTIMIZER-PREVIEW.md §4.2 example
 *  uses ("one more late order and 65 h more slip"), not just a KPI name. */
const FINALIST_TARGET_KEYS: ReadonlyArray<{
  key: keyof OptimizerKpis;
  phrase: (n: number, worse: boolean) => string;
}> = [
  { key: 'changeovers', phrase: (n, worse) => `${n} ${worse ? 'more' : 'fewer'} changeover${n === 1 ? '' : 's'}` },
  { key: 'late_count', phrase: (n, worse) => `${n} ${worse ? 'more' : 'fewer'} late order${n === 1 ? '' : 's'}` },
  { key: 'late_h', phrase: (n, worse) => `${n.toFixed(1)} h ${worse ? 'more' : 'less'} slip` },
];

/** One-sentence rationale for why an alternate finalist wasn't applied. Compares
 *  only the scored targets against the applied plan — never fabricates a "best
 *  balance" claim, since this is a 2-wide mode-swap comparison, not a true beam
 *  (see docs/archive/OPTIMIZER-PREVIEW.md §6 fallback-tier note). */
function describeFinalistWhyNot(applied: OptimizerKpis, alt: OptimizerKpis): string {
  const worse: string[] = [];
  const better: string[] = [];
  for (const { key, phrase } of FINALIST_TARGET_KEYS) {
    const d = (alt[key] ?? 0) - (applied[key] ?? 0);
    if (Math.abs(d) < 0.05) continue;
    (d > 0 ? worse : better).push(phrase(Math.abs(d), d > 0));
  }
  if (!worse.length && !better.length) return Util.t('ui.opt_pv_plan_pruned_tie');
  if (worse.length && !better.length) return Util.t('ui.opt_pv_plan_pruned_worse', { list: worse.join(' and ') });
  if (better.length && !worse.length) return Util.t('ui.opt_pv_plan_pruned_better', { list: better.join(' and ') });
  return Util.t('ui.opt_pv_plan_pruned_mixed', { better: better.join(' and '), worse: worse.join(' and ') });
}

/* =============================================================================
   OPTIMIZER PREVIEW (C4) — wraps Engine.runAndApply so the planner sees a
   pre/post KPI comparison before committing. Discard reverts to the snapshot;
   Apply pushes an UndoStack entry so Ctrl+Z still works after the fact.
   ========================================================================== */
/** Shared HTML-attribute/text escaper for OptimizerPreview's rendered markup
 *  (module-level so both showLoading() and _render() can use one copy). */
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g,
  (c: string) => (({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' } as Record<string, string>)[c]));

export const OptimizerPreview = {
  // A detached pre-run copy is needed only if the planner later applies the
  // candidate and wants Ctrl+Z. It is never used to roll a trial back.
  _snapshot: null as NimbusTask[] | null,
  _candidate: null as CandidateResult | null,
  _previewDiagnostics: [] as CandidateDiagnostic[],
  _preKpis:  null as OptimizerKpis | null,
  _postKpis: null as OptimizerKpis | null,
  _mode:     null as OptimizerMode | null,
  _plant:    null as string | null,
  _splitOrderPolicy: 'never' as SplitOrderPolicy,
  _backlogResult: null as RemoveBacklogResult | null,
  _backlogAudit: null as {
    plant: string; lines: string[] | null; from: Date | null; to: Date | null; runAt: Date | null; timezone: string | null;
  } | null,
  _auditDetails: null as OptimizationAuditDetails | null,
  _syntheticSetup: false,
  _explanation: null as PreviewExplanation | null,
  /** KPI vectors for the applied plan and one alternate mode — populated in
   *  runWithPreview (now via a deferred background run, see _finalistsPending),
   *  wiped in _clear. Patches are never retained. */
  _finalists: null as Array<{ label: string; mode: OptimizerMode; kpis: OptimizerKpis; whyNot: string | null }> | null,
  /** Phase 2 (Pkg D): true from the moment runWithPreview schedules the
   *  deferred Plan B comparison run until it lands (or bails/fails) and
   *  clears it. _render() shows a "Computing comparison…" placeholder while
   *  this is true. Always false when _finalists is non-null. */
  _finalistsPending: false,
  stale: false,
  _staleReason: null as string | null,
  active:    false,  // true while detached candidate details await Apply/Discard
  _abandonGuardInstalled: false,
  /** Phase 2 (Pkg D): monotonic token, incremented at the top of every
   *  runWithPreview call. The deferred Plan B callback captures it at
   *  schedule time and bails silently if it no longer matches (a newer run
   *  started) or the preview is no longer active (applied/discarded/closed). */
  _runSeq: 0,

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
      + `    <span style="font-size:14px;color:var(--fg);">${esc(Util.t('ui.opt_pv_loading_title'))}</span>`
      + '  </div>'
      + `  <div style="font-size:12px;color:var(--fg-mute);">${esc(Util.t('ui.opt_pv_loading_sub', { mode, plant }))}</div>`
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
    const root = typeof document === 'undefined' ? null : document.getElementById('modal-opt-preview');
    if (root) root.querySelectorAll<HTMLButtonElement>('.modal-foot .btn-ghost').forEach((b) => { b.disabled = false; });
    OptimizerPreview._syncApplyButton();
  },

  /** Compact presentation facts only: candidate patches never carry a full
   * schedule, and this summary never retains one. */
  summarizeCandidate(candidate: CandidateResult, input: PreviewExplanationInput): PreviewExplanation {
    const rejected = /(?:unavailable|unknown|uncovered|infeasible|missing|disabled|fail)/i;
    const reasons = candidate.explanation.slice(0, PREVIEW_REASON_LIMIT).map(reason => ({
      code: reason.code, message: reason.message, line: reason.line, taskId: reason.taskId,
      outcome: rejected.test(`${reason.code} ${reason.message}`) ? 'rejected' as const : 'accepted' as const,
    }));
    const patchedIds = new Set(candidate.patches.map(patch => String(patch.id)));
    const scheduledWithoutSetupOrders = new Set<string>();
    const scheduledWithoutSetupLines = new Set<string>();
    // 'scheduled-without-setup' (F1) is the single dedicated reason for an
    // order actually placed without a resolvable setup transition — emitted
    // both by `placeUnknownTail` (tail placement) and, since A1, by
    // `candidateForSequence`'s in-sequence admission of a known-but-uncovered
    // transition. Counting this reason instead of the raw
    // 'successor-state-unknown'/'initial-state-unknown' partition edges
    // avoids double-counting a rejected permutation's edge that happens to
    // name the same patched id.
    for (const edge of candidate.missingEdges) {
      if (edge.reason !== 'scheduled-without-setup') continue;
      if (!edge.successorOrderId || !patchedIds.has(String(edge.successorOrderId))) continue;
      scheduledWithoutSetupOrders.add(String(edge.successorOrderId));
      scheduledWithoutSetupLines.add(edge.line);
    }
    // B3: derive the unplaced set by difference from candidate.patches, not
    // from a threaded CandidateResult field — see the interface comment on
    // PreviewExplanation.unplacedOrders for why.
    const firmedIdSet = input.firmedIds instanceof Set
      ? input.firmedIds
      : new Set(Array.from(input.firmedIds ?? [], String));
    const unplacedOrderIds = new Set<string>();
    const unplacedLines = new Set<string>();
    for (const candidateTask of input.unplacedCandidates ?? []) {
      if (patchedIds.has(candidateTask.id) || firmedIdSet.has(candidateTask.id)) continue;
      unplacedOrderIds.add(candidateTask.id);
      unplacedLines.add(candidateTask.line);
    }
    return {
      impact: {
        production: { before: input.productionBefore, after: input.productionAfter },
        setup: { before: input.preKpis.changeovers, after: input.postKpis.changeovers },
        occupiedHours: { before: input.preKpis.span_h, after: input.postKpis.span_h },
        lateness: { beforeOrders: input.preKpis.late_count, afterOrders: input.postKpis.late_count, beforeHours: input.preKpis.late_h, afterHours: input.postKpis.late_h },
        utilization: { before: input.preKpis.peak_util_pct, after: input.postKpis.peak_util_pct },
        sequences: { changed: candidate.patches.length },
      },
      reasons,
      constraints: [...new Set(candidate.explanation.map(reason => reason.code))].slice(0, PREVIEW_REASON_LIMIT),
      missingPairs: [],
      missingPairsTotal: 0,
      unchangedLines: [...new Set(candidate.unchangedLines)].slice(0, PREVIEW_REASON_LIMIT),
      scheduledWithoutSetup: { orders: scheduledWithoutSetupOrders.size, lines: scheduledWithoutSetupLines.size },
      unplacedOrders: { orders: unplacedOrderIds.size, lines: unplacedLines.size },
      prunes: tallyPrunes(candidate.explanation),
      search: {
        candidateCount: candidate.diagnostics.candidateCount, method: candidate.diagnostics.method,
        termination: candidate.diagnostics.termination, runtimeMs: candidate.diagnostics.runtimeMs,
        limitReached: candidate.diagnostics.limitReached,
      },
    };
  },

  /** Derive only the state labels needed to review bounded missing edges while
   * the detached snapshot is still in scope. No task list is retained. */
  describeMissingPairs(candidate: CandidateResult, tasks: ReadonlyArray<NimbusTask>, setup: SetupSnapshot | null): { pairs: PreviewExplanation['missingPairs']; total: number } {
    const definition = setup?.definition;
    const byId = new Map(tasks.map(task => [String(task.id), task]));
    const text = (state: SetupStateKey | null | undefined) => state?.map(part => part.value).join(' · ') || null;
    const pairs = candidate.missingEdges.slice(0, PREVIEW_MISSING_PAIR_LIMIT).map(edge => {
      const predecessor = edge.predecessorOrderId ? byId.get(String(edge.predecessorOrderId)) : undefined;
      const successor = edge.successorOrderId ? byId.get(String(edge.successorOrderId)) : undefined;
      const lineState = definition
        ? setup?.machine_states.find(state => state.machine === edge.line && state.signature_version === definition.signature_version)?.state_key
        : null;
      return {
        line: edge.line,
        predecessorOrderId: edge.predecessorOrderId ?? null,
        successorOrderId: edge.successorOrderId ?? null,
        fromState: text(definition && predecessor ? stateForOrder(predecessor, definition) : lineState),
        toState: text(definition && successor ? stateForOrder(successor, definition) : null),
        reason: edge.reason,
      };
    });
    return { pairs, total: candidate.missingEdges.length };
  },

  missingPairsCsv(pairs: ReadonlyArray<PreviewExplanation['missingPairs'][number]>): string {
    const quote = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    return ['Line,Predecessor order,Successor order,From setup state,To setup state,Reason', ...pairs.map(pair =>
      [pair.line, pair.predecessorOrderId, pair.successorOrderId, pair.fromState, pair.toState, pair.reason].map(quote).join(','))].join('\n');
  },

  canApply(): boolean { return OptimizerPreview.active && !OptimizerPreview.stale && !!OptimizerPreview._candidate && !!OptimizerPreview._snapshot; },

  /** Single place that decides whether Apply is clickable — always derived
   *  from canApply(), never poked ad hoc. Replaces three separate direct-DOM
   *  writers (showLoading's blanket disable, hideLoading's blanket enable,
   *  markSetupStale's manual disable) that could disagree with each other. */
  _syncApplyButton(): void {
    const button = typeof document === 'undefined' ? null : document.getElementById('opt-preview-apply-btn') as HTMLButtonElement | null;
    if (!button) return;
    const applyable = OptimizerPreview.canApply();
    button.disabled = !applyable;
    button.title = applyable ? '' : (OptimizerPreview.stale
      ? Util.t('ui.setup_preview_apply_stale_title')
      : Util.t('ui.setup_preview_apply_not_ready_title'));
  },

  /** Setup writes make comparison facts stale; they never rerun or apply a
   * candidate. The planner must explicitly run again. */
  markSetupStale(plant: string, kind: string): void {
    if (!OptimizerPreview.active || !OptimizerPreview._candidate || OptimizerPreview._plant !== plant) return;
    OptimizerPreview.stale = true;
    OptimizerPreview._staleReason = `${kind} setup data changed`;
    OptimizerPreview._syncApplyButton();
    if (typeof document !== 'undefined') OptimizerPreview._render();
  },

  /** One-time safety net: the modal's backdrop is wired (like every other modal's)
   *  to close on an outside click, bypassing discard()/apply() entirely (app.js's
   *  boot-time '.modal-backdrop' click handler calls Modal.close() directly). Left
   *  alone, that would leave detached candidate details and `active` stuck true.
   *  Treat any non-apply/discard hide as a discard. */
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
  runWithPreview(mode: OptimizerMode = 'changeover', opts: OptimizerRunOptions = {}) {
    // Phase 2 (Pkg D): monotonic run token, captured by the deferred Plan B
    // callback below so it can detect a superseding run and bail silently.
    const runSeq = ++OptimizerPreview._runSeq;
    OptimizerPreview._previewDiagnostics = [];
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
        // / lines), so the undo snapshot must stay unfiltered. `plant` scopes
        // only calendars (Phase 2, Pkg D clone reduction) — every consumer of
        // this snapshot's `calendars` only ever looks up a line that already
        // passed this same plant's task filter (see snapshotSchedule's doc
        // comment), so no other plant's calendar entries are ever needed here.
        const candidateSnapshot = snapshotSchedule(plant);
        const scopedTasks = candidateSnapshot.tasks.filter(task => {
          const mappedPlant = candidateSnapshot.lineSettings[task.MACHINE]?.plant
            ?? candidateSnapshot.masterData?.lines.find(row => row.machine === task.MACHINE)?.plant;
          return (task.PLANT || mappedPlant) === plant;
        });
        const _snapT0 = performance.now();
        snapshot = structuredClone(scopedTasks);
        // Keep this detached copy only for the Undo entry if the planner applies.
        OptimizerPreview._snapshot = snapshot;
        OptimizerPreview.active = true;
        PerfMonitor.record('Optimize.snapshot', performance.now() - _snapT0);

        // KPI inputs are scoped to what the user actually selected on screen 1 —
        // time window and (optionally) a subset of lines. Otherwise the before/after
        // comparison drowns the user's slice in out-of-scope tasks.
        const winStart = opts.startDate ? opts.startDate.getTime() : -Infinity;
        const winEnd   = opts.endDate   ? opts.endDate.getTime()   :  Infinity;
        const lineSet  = (Array.isArray(opts.lines) && opts.lines.length) ? new Set(opts.lines) : null;
        const inScope = (t: NimbusTask): boolean => {
          if (lineSet && !lineSet.has(t.MACHINE)) return false;
          const s = t.start_date ? t.start_date.getTime() : null;
          if (s == null) return false;
          const e = Util.scheduledEnd(t);
          const eMs = e ? e.getTime() : s;
          return eMs >= winStart && s <= winEnd;
        };

        // Pre-KPIs from the (filtered) snapshot — it IS the current state right now.
        const _preKpiT0 = performance.now();
        const preKpis = Util.scheduleKpis(snapshot.filter(inScope), 14, candidateSnapshot);
        PerfMonitor.record('Optimize.preKPIs', performance.now() - _preKpiT0);

        // Evaluate the established placement algorithm against a detached read
        // model. Store changes only if the planner applies this candidate.
        // Phase 2 (Pkg D): the primary run's deadline is now an explicit,
        // once-computed `deadlineAt` rather than letting the engine derive a
        // fresh SETUP_AWARE_DEADLINE_MS window internally — same numeric
        // budget, no behavior change, but the option now exists so the
        // (deferred) alt run below no longer inherits a full fresh one.
        const _evalPrimaryT0 = performance.now();
        const candidate = evaluateSchedule(candidateSnapshot, { mode, ...opts, deadlineAt: performance.now() + SETUP_AWARE_DEADLINE_MS });
        PerfMonitor.record('Optimize.evaluate.primary', performance.now() - _evalPrimaryT0);

        // Post-KPIs are calculated from detached patched task values.
        const _applyPatchesT0a = performance.now();
        const postTasks = applyPatchesToSnapshot(candidateSnapshot.tasks, candidate.patches).filter(inScope);
        PerfMonitor.record('Optimize.applyPatches', performance.now() - _applyPatchesT0a);
        const _postKpiT0 = performance.now();
        const postKpis  = Util.scheduleKpis(postTasks, 14, candidateSnapshot);
        PerfMonitor.record('Optimize.postKPIs', performance.now() - _postKpiT0);

        OptimizerPreview._preKpis  = preKpis;
        OptimizerPreview._postKpis = postKpis;
        OptimizerPreview._candidate = candidate;
        OptimizerPreview._previewDiagnostics = [...candidate.diagnostics.events];
        OptimizerPreview._mode     = mode;
        OptimizerPreview._plant    = plant;
        OptimizerPreview._splitOrderPolicy = Engine.splitOrderPolicyFor(plant);
        OptimizerPreview._backlogResult = mode === 'backlog' ? candidate.backlogResult ?? null : null;
        OptimizerPreview._backlogAudit = mode === 'backlog' ? {
          plant,
          lines: Array.isArray(opts.lines) ? opts.lines : null,
          from: opts.startDate ?? null,
          to: opts.endDate ?? null,
          runAt: opts.runAt instanceof Date ? opts.runAt : null,
          timezone: candidateSnapshot.masterData?.plants?.find(p => p.plant === plant)?.timezone ?? null,
        } : null;
        OptimizerPreview._auditDetails = mode === 'backlog' ? null : opts.auditDetails ?? null;
        OptimizerPreview._syntheticSetup = mode === 'changeover' && !(Store.setupSnapshot && Store.setupSnapshot.plant === plant && Store.setupSnapshot.plant_active);
        // B3: the same run-scoped candidate pool used for the KPI comparison
        // (plant, via `scopedTasks` above using the B7 line→plant fallback,
        // plus opts.lines and excludeFromOpt) — NOT the time-windowed
        // `inScope`, since an order outside the KPI window can still be
        // legitimately "not scheduled" by this run.
        const unplacedCandidates = scopedTasks
          .filter(t => !lineSet || lineSet.has(t.MACHINE))
          .filter(t => !candidateSnapshot.lineSettings[t.MACHINE || '']?.excludeFromOpt)
          .map(t => ({ id: String(t.id), line: t.MACHINE || 'Unknown' }));
        const runNow = opts.startDate ? new Date(opts.startDate) : (() => { const d = new Date(); d.setSeconds(0, 0); return d; })();
        const explanation = OptimizerPreview.summarizeCandidate(candidate, {
          productionBefore: snapshot.filter(inScope).length,
          productionAfter: postTasks.length,
          preKpis,
          postKpis,
          unplacedCandidates,
          firmedIds: effectiveFirmedIdSet(candidateSnapshot.tasks, candidateSnapshot.firmedIds, runNow, opts.respectFirmed ?? true),
        });
        const described = OptimizerPreview.describeMissingPairs(
          candidate,
          candidateSnapshot.tasks,
          Store.setupSnapshot?.plant === plant ? Store.setupSnapshot : null,
        );
        explanation.missingPairs = described.pairs;
        explanation.missingPairsTotal = described.total;
        OptimizerPreview._explanation = explanation;

        // Alternate-mode KPI vectors — the only data needed for the plan
        // comparison table. Phase 2 (Pkg D): this run is now DEFERRED until
        // after the primary preview has painted (see below, after the first
        // _render() call) instead of running synchronously back-to-back with
        // the primary evaluation. Until it lands, _finalists stays null and
        // _finalistsPending tells _render() to show a placeholder.
        const altModeMap: Partial<Record<OptimizerMode, OptimizerMode>> = { changeover: 'spt', spt: 'changeover' };
        const altMode = altModeMap[mode];
        OptimizerPreview._finalists = null;
        OptimizerPreview._finalistsPending = !!altMode;

        OptimizerPreview.stale = false;
        OptimizerPreview._staleReason = null;

        footBtns.forEach((b) => { b.disabled = false; });
        OptimizerPreview._syncApplyButton();
        OptimizerPreview._render();

        if (altMode) {
          // Paint first, then compute Plan B off the critical path.
          // requestAnimationFrame alone still runs before the browser paints
          // the just-scheduled frame; the extra setTimeout(0) yields to the
          // event loop (and therefore a paint) before this runs.
          requestAnimationFrame(() => setTimeout(() => {
            // Race safety: bail silently — touching neither _finalists nor
            // _finalistsPending — unless this preview is still the one the
            // user is looking at. `active` catches apply/discard/abandon
            // (all route through _clear(), which already resets both
            // fields); `_runSeq` catches a newer runWithPreview call already
            // in flight (whose own synchronous block already reset both
            // fields for itself) so a slow, superseded run can never
            // resurrect stale finalists or issue an orphan render. Also bail
            // if `stale` went true between paint and this callback — a Store
            // setup write landing in that window (see markStale) would make
            // Plan B evaluate against setup data Plan A never saw, so the
            // comparison would no longer be apples-to-apples.
            if (!OptimizerPreview.active || OptimizerPreview._runSeq !== runSeq || OptimizerPreview.stale) return;
            let finalists: typeof OptimizerPreview['_finalists'] = null;
            try {
              const _evalAltT0 = performance.now();
              const altCandidate = evaluateSchedule(candidateSnapshot, {
                mode: altMode, plant: opts.plant, lines: opts.lines,
                startDate: opts.startDate, endDate: opts.endDate,
                respectFirmed: opts.respectFirmed, respectCalendar: opts.respectCalendar,
                // Controller ruling: Plan B is deferred off the click path,
                // so background time is acceptable — give it the SAME full
                // SETUP_AWARE_DEADLINE_MS window as the primary run rather
                // than a reduced budget (previously ALT_PLAN_BUDGET_MS,
                // removed — it silently handicapped the comparison).
                deadlineAt: performance.now() + SETUP_AWARE_DEADLINE_MS,
              });
              PerfMonitor.record('Optimize.evaluate.alt', performance.now() - _evalAltT0);
              const _applyPatchesT0b = performance.now();
              const altPostTasks = applyPatchesToSnapshot(candidateSnapshot.tasks, altCandidate.patches).filter(inScope);
              PerfMonitor.record('Optimize.applyPatches', performance.now() - _applyPatchesT0b);
              const altKpis = Util.scheduleKpis(altPostTasks, 14, candidateSnapshot);
              finalists = [
                { label: 'A', mode, kpis: postKpis, whyNot: null },
                { label: 'B', mode: altMode, kpis: altKpis, whyNot: describeFinalistWhyNot(postKpis, altKpis) },
              ];
            } catch { /* alt run failed — table stays absent */ }
            OptimizerPreview._finalists = finalists;
            OptimizerPreview._finalistsPending = false;
            OptimizerPreview._render();
          }, 0));
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : undefined;
        OptimizerPreview._previewDiagnostics = [{
          level: 'error',
          scope: 'optimize-preview',
          code: 'candidate-evaluation-failed',
          message: errMsg || String(err),
          context: { mode, plant },
        }];
        // Evaluation is detached, so failures leave Store untouched.
        OptimizerPreview._clear(true);
        if (body) {
          body.innerHTML =
            '<div style="padding:24px;text-align:center;color:var(--err);">'
          + `  <div style="font-size:14px;margin-bottom:8px;">${esc(Util.t('ui.opt_pv_failed_title'))}</div>`
          + `  <div style="font-size:12px;color:var(--fg-mute);">${esc(errMsg || 'Unknown error')}</div>`
          + '</div>';
        }
        footBtns.forEach((b) => { b.disabled = false; });
        OptimizerPreview._syncApplyButton();
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
    const backlog = OptimizerPreview._backlogResult?.diagnostics ?? null;
    const explanation = OptimizerPreview._explanation;

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
        label: Util.t('ui.opt_pv_card_changeovers'), k: 'changeovers', ico: '&#8635;',
        fmt: (v) => String(v), unit: '', lowerIsBetter: true,
        tip: Util.t('ui.opt_pv_card_changeovers_tip'),
      },
      {
        label: Util.t('ui.opt_pv_card_span'), k: 'span_h', ico: '&#8596;',
        fmt: (v) => v.toFixed(1), unit: 'h', lowerIsBetter: 'soft',
        tip: Util.t('ui.opt_pv_card_span_tip'),
      },
      {
        label: Util.t('ui.opt_pv_card_late'), k: 'late_count', ico: '&#9201;',
        fmt: (v) => String(v), unit: '', lowerIsBetter: true,
        tip: Util.t('ui.opt_pv_card_late_tip'),
      },
      {
        label: Util.t('ui.opt_pv_card_lateness'), k: 'late_h', ico: '&#8721;',
        fmt: (v) => v.toFixed(1), unit: 'h', lowerIsBetter: true,
        tip: Util.t('ui.opt_pv_card_lateness_tip'),
      },
      {
        label: Util.t('ui.opt_pv_card_util'), k: 'peak_util_pct', ico: '&#9650;',
        fmt: (v) => String(v), unit: '%', lowerIsBetter: 'soft',
        tip: Util.t('ui.opt_pv_card_util_tip'),
      },
    ];

    // Verdict: score against the three targets only (changeovers, late_count, late_h).
    // span_h and peak_util_pct are context — they affect card color but never the verdict.
    const directional = cards.filter(c => c.lowerIsBetter === true);
    let better = 0, worse = 0;
    for (const c of directional) {
      const d = (post[c.k] ?? 0) - (pre[c.k] ?? 0);
      if (Math.abs(d) < 0.05) { continue; }
      if (d < 0) better++;
      else worse++;
    }
    let verdictTone: string, verdictTitle: string, verdictSub: string;
    if (better === 0 && worse === 0) {
      verdictTone = 'neutral';
      verdictTitle = Util.t('ui.opt_pv_verdict_neutral_title');
      verdictSub = Util.t('ui.opt_pv_verdict_neutral_sub');
    } else if (worse === 0) {
      verdictTone = 'better';
      verdictTitle = better === directional.length ? Util.t('ui.opt_pv_verdict_big_win_title') : Util.t('ui.opt_pv_verdict_improved_title');
      verdictSub = Util.t('ui.opt_pv_verdict_better_sub', { better, total: directional.length, targets: directional.length });
    } else if (better === 0) {
      verdictTone = 'worse';
      verdictTitle = Util.t('ui.opt_pv_verdict_regressed_title');
      verdictSub = Util.t('ui.opt_pv_verdict_all_worse_sub', { worse, total: directional.length });
    } else if (better >= worse) {
      verdictTone = 'better';
      verdictTitle = Util.t('ui.opt_pv_verdict_tradeoffs_title');
      verdictSub = Util.t('ui.opt_pv_verdict_tradeoffs_sub', { better, betterPlural: better === 1 ? '' : 's', worse });
    } else {
      verdictTone = 'worse';
      verdictTitle = Util.t('ui.opt_pv_verdict_net_regression_title');
      verdictSub = Util.t('ui.opt_pv_verdict_net_regression_sub', { worse, worsePlural: worse === 1 ? '' : 's', better });
    }

    const backlogHtml = (() => {
      if (!backlog) return '';
      const rows: Array<[string, string]> = [
        [Util.t('ui.opt_pv_backlog_found'), String(backlog.backlogFound)],
        [Util.t('ui.opt_pv_backlog_moved'), String(backlog.moved)],
        [Util.t('ui.opt_pv_backlog_firmed_moved'), String(backlog.firmedMoved)],
        [Util.t('ui.opt_pv_backlog_frozen_moved'), String(backlog.frozenMoved)],
        [Util.t('ui.opt_pv_backlog_runtime'), `${backlog.movedRuntimeHours.toFixed(1)} h`],
        [Util.t('ui.opt_pv_backlog_largest_delay'), `${backlog.largestDelayMinutes} min`],
      ];
      if (backlog.invalidRuntimeIds.length) rows.push([Util.t('ui.opt_pv_backlog_skipped_runtime'), String(backlog.invalidRuntimeIds.length)]);
      if (backlog.missingStartIds.length) rows.push([Util.t('ui.opt_pv_backlog_skipped_start'), String(backlog.missingStartIds.length)]);
      if (backlog.overlongIds.length) rows.push([Util.t('ui.opt_pv_backlog_overlong'), String(backlog.overlongIds.length)]);
      if (backlog.calendarSearchFailures.length) rows.push([Util.t('ui.opt_pv_backlog_capacity_fail'), String(backlog.calendarSearchFailures.length)]);
      const summary = backlog.backlogFound === 0 && backlog.moved === 0 && !backlog.invalidRuntimeIds.length && !backlog.missingStartIds.length
        ? `<div class="opt-pv-backlog-empty">${esc(Util.t('ui.opt_pv_backlog_empty'))}</div>`
        : '';
      const boundary = backlog.boundaryConflicts.length
        ? `<div class="opt-pv-backlog-warning">${Util.t('ui.opt_pv_backlog_boundary', { count: backlog.boundaryConflicts.length })}</div>`
        : '';
      return `<section class="opt-pv-backlog"><div class="opt-pv-backlog-title">${esc(Util.t('ui.opt_pv_backlog_title'))}</div>${summary}<div class="opt-pv-backlog-grid">${rows.map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}</div>${boundary}</section>`;
    })();

    const modeLabel = (OptimizerPreview._mode || '').toUpperCase();
    const plant = OptimizerPreview._plant || '';
    const splitPolicyLabel: Record<SplitOrderPolicy, string> = {
      never: Util.t('ui.opt_pv_split_none'),
      overlong_only: Util.t('ui.opt_pv_split_overlong'),
      partial_allowed: Util.t('ui.opt_pv_split_partial'),
    };
    const splitPolicy = OptimizerPreview._splitOrderPolicy;
    const stamp = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const whyHtml = (() => {
      if (!explanation) return '';
      const constraints = explanation.constraints.join(', ') || Util.t('ui.setup_constraints_none');
      const unchangedCount = explanation.unchangedLines.length;
      const finalists = OptimizerPreview._finalists;

      let planTableHtml = '';
      if (finalists) {
        const fmtDelta = (d: number, lb: LowerIsBetter, fmt: (v: number) => string, unit: string): string => {
          if (Math.abs(d) < 0.05) return '';
          const sign = d < 0 ? '−' : '+';
          const cls = lb === true
            ? (d < 0 ? 'opt-pv-plan-delta-ok' : 'opt-pv-plan-delta-err')
            : lb === 'soft'
              ? (d < 0 ? 'opt-pv-plan-delta-ok' : 'opt-pv-plan-delta-warn')
              : 'opt-pv-plan-delta-mute';
          return `<span class="${cls}">${sign}${esc(fmt(Math.abs(d)))}${esc(unit)}</span>`;
        };
        const bodyRows = cards.map(c => {
          const preV = pre[c.k] ?? 0;
          const currentCell = `<td class="opt-pv-plan-current">${esc(c.fmt(preV))}${esc(c.unit)}</td>`;
          const dataCells = finalists!.map((f, i) => {
            const val = f.kpis[c.k] ?? 0;
            const delta = fmtDelta(val - preV, c.lowerIsBetter, c.fmt, c.unit);
            return i === 0
              ? `<td class="opt-pv-plan-applied-cell"><span class="opt-pv-plan-val-applied">${esc(c.fmt(val))}${esc(c.unit)}</span>${delta}</td>`
              : `<td>${esc(c.fmt(val))}${esc(c.unit)}${delta}</td>`;
          }).join('');
          return `<tr><th scope="row" title="${esc(c.tip)}">${esc(c.label)}</th>${currentCell}${dataCells}</tr>`;
        }).join('');
        const headCells = finalists.map((f, i) => i === 0
          ? `<th class="opt-pv-plan-applied-head"><div>${esc(Util.t('ui.opt_pv_plan_col_applied'))}</div><div class="opt-pv-plan-col-sub">${esc(f.mode.toUpperCase())}</div></th>`
          : `<th><div>${esc(Util.t('ui.opt_pv_plan_col_alt', { label: f.label }))}</div><div class="opt-pv-plan-col-sub">${esc(f.mode.toUpperCase())}</div></th>`
        ).join('');
        const verdictCells = finalists.map((f, i) => i === 0
          ? `<td class="opt-pv-plan-applied-cell"><strong>${esc(Util.t('ui.opt_pv_plan_chosen'))}</strong> ${esc(Util.t('ui.opt_pv_plan_chosen_reason', { mode: f.mode.toUpperCase() }))}</td>`
          : `<td><strong>${esc(Util.t('ui.opt_pv_plan_pruned'))}</strong></td>`
        ).join('');
        planTableHtml = `<div class="opt-pv-plan-wrap"><table class="opt-pv-plan-table">
          <thead><tr><th></th><th><div>${esc(Util.t('ui.opt_pv_plan_col_current'))}</div><div class="opt-pv-plan-col-sub">${esc(Util.t('ui.opt_pv_plan_col_current_sub'))}</div></th>${headCells}</tr></thead>
          <tbody>${bodyRows}</tbody>
          <tfoot class="opt-pv-plan-tfoot"><tr><th scope="row">${esc(Util.t('ui.opt_pv_plan_verdict_label'))}</th><td>${esc(Util.t('ui.opt_pv_plan_baseline'))}</td>${verdictCells}</tr></tfoot>
        </table></div>`;
      } else if (OptimizerPreview._finalistsPending) {
        // Phase 2 (Pkg D): Plan B now computes in a deferred background run
        // (after the primary preview paints) instead of blocking the initial
        // render — show a lightweight placeholder until it lands.
        planTableHtml = `<p class="opt-pv-section-intro">${esc(Util.t('ui.opt_pv_plan_computing'))}</p>`;
      }

      // §4.3 — aggregate prune tally for the whole run. Only rendered when at
      // least one genuinely exclusionary reason code fired (see tallyPrunes).
      let prunesHtml = '';
      const p = explanation.prunes;
      if (p && p.total > 0) {
        const rows: Array<{ label: string; count: number; warn?: boolean }> = [
          { label: Util.t('ui.opt_pv_prune_setup'), count: p.setup, warn: true },
          { label: Util.t('ui.opt_pv_prune_firmed'), count: p.firmed },
          { label: Util.t('ui.opt_pv_prune_capacity'), count: p.capacity },
          { label: Util.t('ui.opt_pv_prune_other'), count: p.other },
        ].filter(row => row.count > 0).sort((a, b) => b.count - a.count);
        const max = Math.max(...rows.map(row => row.count), 1);
        const barsHtml = rows.map(row => `<div class="opt-pv-prune-row">
          <span class="opt-pv-prune-label">${esc(row.label)}</span>
          <span class="opt-pv-prune-track"><span class="opt-pv-prune-fill${row.warn ? ' warn' : ''}" style="width:${Math.round((row.count / max) * 100)}%"></span></span>
          <span class="opt-pv-prune-count">${esc(String(row.count))}</span>
        </div>`).join('');
        prunesHtml = `<div class="opt-pv-prunes">
          <div class="opt-pv-prunes-head">
            <span class="opt-pv-prunes-title">${esc(Util.t('ui.opt_pv_prunes_title'))}</span>
            <span class="opt-pv-prunes-total">${esc(Util.t('ui.opt_pv_prunes_total', { count: p.total }))}</span>
          </div>
          ${barsHtml}
          ${p.setup > 0 ? `<p class="opt-pv-prune-footnote">${esc(Util.t('ui.opt_pv_prune_footnote', { count: p.setup }))}</p>` : ''}
        </div>`;
      }

      return `<details class="opt-pv-section" open>
        <summary class="opt-pv-section-head"><span class="opt-pv-section-title">${esc(Util.t('ui.opt_pv_why_title'))}</span></summary>
        <div class="opt-pv-section-body">
          ${planTableHtml}
          ${prunesHtml}
          <dl class="opt-pv-meta-list">
            <div><dt>${esc(Util.t('ui.setup_constraints_label'))}</dt><dd>${esc(constraints)}</dd></div>
            <div><dt>${esc(Util.t('ui.opt_pv_lines_changed'))}</dt><dd>${unchangedCount > 0 ? esc(Util.t('ui.opt_pv_lines_unchanged_count', { count: unchangedCount })) : esc(Util.t('ui.setup_unchanged_lines_none'))}</dd></div>
            <div><dt>${esc(Util.t('ui.opt_pv_sequences_changed_label'))}</dt><dd>${esc(String(explanation.impact.sequences.changed))}</dd></div>
          </dl>
        </div>
      </details>`;
    })();

    const gapsHtml = (() => {
      if (!explanation) return '';
      const pairCount = explanation.missingPairs.length;
      const totalPairs = explanation.missingPairsTotal;
      const isTruncated = totalPairs > pairCount;
      const truncatedNote = isTruncated
        ? `<p class="opt-pv-section-intro">${esc(Util.t('ui.opt_pv_gaps_truncated', { shown: pairCount, total: totalPairs }))}</p>`
        : '';
      const canReview = (globalThis as unknown as { NIMBUS?: { SetupAdmin?: { canReviewMissingPairs?: (plant: string) => boolean } } }).NIMBUS?.SetupAdmin?.canReviewMissingPairs?.(plant) === true;
      const body = pairCount
        ? `${truncatedNote}<div class="setup-table-wrap"><table class="setup-table"><thead><tr><th>${esc(Util.t('ui.setup_col_line'))}</th><th>${esc(Util.t('ui.setup_col_from'))}</th><th>${esc(Util.t('ui.setup_col_to'))}</th><th>${esc(Util.t('ui.setup_col_reason'))}</th></tr></thead><tbody>${explanation.missingPairs.map(pair => `<tr><td>${esc(pair.line)}</td><td>${esc(pair.fromState || '—')}</td><td>${esc(pair.toState || '—')}</td><td>${esc(pair.reason)}</td></tr>`).join('')}</tbody></table></div><div class="opt-pv-footer-note">${canReview ? `<button class="btn btn-primary sm" data-opt-review-missing>${esc(Util.t('btn.opt_fill_setup_matrix'))}</button> ` : ''}<button class="btn btn-ghost sm" data-opt-copy-missing>${esc(Util.t('btn.setup_copy_missing'))}</button> <button class="btn btn-ghost sm" data-opt-export-missing>${esc(Util.t('btn.setup_export_missing'))}</button></div>`
        : `<p class="opt-pv-section-empty">${esc(Util.t('ui.setup_missing_pairs_none'))}</p>`;
      const badge = pairCount ? `<span class="opt-pv-section-badge">${isTruncated ? Util.t('ui.opt_pv_gaps_badge', { count: totalPairs }) : pairCount}</span>` : '';
      return `<details class="opt-pv-section">
        <summary class="opt-pv-section-head"><span class="opt-pv-section-title">${esc(Util.t('ui.opt_pv_gaps_title'))}</span>${badge}</summary>
        <div class="opt-pv-section-body">
          <p class="opt-pv-section-intro">${esc(Util.t('ui.opt_pv_gaps_intro'))}</p>
          ${body}
        </div>
      </details>`;
    })();

    const diagHtml = (() => {
      if (!explanation) return '';
      // The search being truncated by a deadline / iteration cap (rather than
      // converging) is the one diagnostic that changes what the planner should
      // do about the result, so it is surfaced on the collapsed summary too.
      const diagSummary = Util.t('ui.opt_pv_diag_summary', {
        method: explanation.search.method,
        count: explanation.search.candidateCount,
        runtime: `${explanation.search.runtimeMs.toFixed(0)} ms`,
      });
      const limitBadge = explanation.search.limitReached
        ? `<span class="opt-pv-section-badge" title="${esc(Util.t('ui.opt_pv_diag_limit_reached_note'))}">${esc(Util.t('ui.opt_pv_diag_limit_reached'))}</span>`
        : '';
      const diagEvents = OptimizerPreview._previewDiagnostics.filter(e => e.level === 'error' || e.level === 'warn');
      const eventsHtml = diagEvents.length
        ? `<ul class="opt-pv-diag-events">${diagEvents.map(e => `<li class="opt-pv-diag-event opt-pv-diag-${esc(e.level)}"><strong>${esc(e.level.toUpperCase())}</strong> ${esc(e.message)}</li>`).join('')}</ul>`
        : '';
      // Derived, not stored on `search` — candidateCount / (runtimeMs / 1000),
      // rounded, guarded against divide-by-zero and non-finite candidateCount
      // so a zero/degenerate runtime omits the row rather than rendering
      // NaN/Infinity.
      const { candidateCount, runtimeMs } = explanation.search;
      const rateHtml = runtimeMs > 0 && Number.isFinite(candidateCount)
        ? `<div><dt>${esc(Util.t('ui.opt_pv_diag_rate'))}</dt><dd>${esc(String(Math.round(candidateCount / (runtimeMs / 1000))))}</dd></div>`
        : '';
      return `<details class="opt-pv-section">
        <summary class="opt-pv-section-head"><span class="opt-pv-section-title">${esc(Util.t('ui.opt_pv_diag_title'))}</span><span class="opt-pv-section-summary">${esc(diagSummary)}</span>${limitBadge}</summary>
        <div class="opt-pv-section-body">
          <dl class="opt-pv-meta-list">
            <div><dt>${esc(Util.t('ui.setup_search_label'))}</dt><dd>${esc(explanation.search.method)}</dd></div>
            <div><dt>${esc(Util.t('ui.opt_pv_diag_candidates'))}</dt><dd>${esc(String(explanation.search.candidateCount))}</dd></div>
            <div><dt>${esc(Util.t('ui.opt_pv_diag_termination'))}</dt><dd>${esc(explanation.search.termination)}</dd></div>
            <div><dt>${esc(Util.t('ui.opt_pv_diag_runtime'))}</dt><dd>${explanation.search.runtimeMs.toFixed(0)} ms</dd></div>
            <div><dt>${esc(Util.t('ui.opt_pv_diag_orders_in_scope'))}</dt><dd>${esc(String(explanation.impact.production.before))} → ${esc(String(explanation.impact.production.after))}</dd></div>
            ${rateHtml}
          </dl>
          ${explanation.search.limitReached ? `<p class="opt-pv-section-intro opt-pv-diag-limit">${esc(Util.t('ui.opt_pv_diag_limit_reached_note'))}</p>` : ''}
          ${eventsHtml}
        </div>
      </details>`;
    })();

    const staleHtml = OptimizerPreview.stale
      ? `<div class="opt-pv-stale">${esc(Util.t('ui.opt_stale_banner'))}</div>`
      : '';

    // Never-freeze fallback banner — orders this candidate actually placed
    // without a resolvable setup transition (no changeover bar). Sits beside
    // the "Why this plan" (unchanged lines) and "Setup gaps" (missingPairs)
    // sections rather than inside either, since it summarizes what got
    // scheduled anyway, not what's still missing from the matrix.
    const scheduledWithoutSetupHtml = (explanation && explanation.scheduledWithoutSetup.orders > 0)
      ? `<div class="opt-pv-backlog-warning">${esc(Util.t('ui.opt_pv_scheduled_without_setup', {
          orders: explanation.scheduledWithoutSetup.orders,
          lines: explanation.scheduledWithoutSetup.lines,
        }))}</div>`
      : '';

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
        ? `<span class="opt-pv-pill-icon">●</span> ${esc(Util.t('ui.opt_pv_no_change'))}`
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
            <span class="opt-pv-card-help" tabindex="0" aria-label="${esc(Util.t('ui.opt_pv_card_help_aria'))}">
              <span class="opt-pv-help-dot">?</span>
              <span class="opt-pv-tip">${esc(c.tip)}</span>
            </span>
          </div>
          <div class="opt-pv-card-body">
            <div class="opt-pv-num opt-pv-num-pre">
              <div class="opt-pv-num-lbl">${esc(Util.t('ui.opt_pv_before_label'))}</div>
              <div class="opt-pv-num-val">${c.fmt(preV)}<span class="opt-pv-num-unit">${c.unit}</span></div>
            </div>
            <div class="opt-pv-arrow">→</div>
            <div class="opt-pv-num opt-pv-num-post">
              <div class="opt-pv-num-lbl">${esc(Util.t('ui.opt_pv_after_label'))}</div>
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
          <div class="opt-pv-chip opt-pv-chip-plant" title="${esc(Util.t('ui.opt_pv_chip_plant_title'))}">${esc(plant)}</div>
          <div class="opt-pv-chip opt-pv-chip-policy" title="${esc(Util.t('ui.opt_pv_chip_policy_title'))}">${esc(splitPolicyLabel[splitPolicy])}</div>
          <div class="opt-pv-chip opt-pv-chip-time">${esc(stamp)}</div>
        </div>

        ${staleHtml}

        <div class="opt-pv-verdict opt-pv-verdict-${verdictTone}">
          <div class="opt-pv-verdict-icon">${verdictTone === 'better' ? '✓' : verdictTone === 'worse' ? '!' : '◐'}</div>
          <div class="opt-pv-verdict-text">
            <div class="opt-pv-verdict-title">${esc(verdictTitle)}</div>
            <div class="opt-pv-verdict-sub">${esc(verdictSub)}</div>
          </div>
          <div class="opt-pv-verdict-score">
            <div class="opt-pv-score-num">${better}<span class="opt-pv-score-of">/${directional.length}</span></div>
            <div class="opt-pv-score-lbl">${esc(Util.t('ui.opt_pv_kpis_improved_label'))}</div>
          </div>
        </div>

        <div class="opt-pv-grid">${cardsHtml}</div>

        ${backlogHtml}

        ${scheduledWithoutSetupHtml}

        <div class="opt-pv-sections">
          ${whyHtml}
          ${gapsHtml}
          ${diagHtml}
        </div>

        <div class="opt-pv-footer-note">
          ${Util.t('ui.opt_pv_footer_note')}
        </div>
      </div>`;

    const missingCsv = () => OptimizerPreview.missingPairsCsv(OptimizerPreview._explanation?.missingPairs || []);
    body.querySelector<HTMLButtonElement>('[data-opt-copy-missing]')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(missingCsv()).catch(() => Toast.show(Util.t('toast.clipboard_denied'), 'error'));
    });
    body.querySelector<HTMLButtonElement>('[data-opt-export-missing]')?.addEventListener('click', () => {
      const blob = new Blob([missingCsv()], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url;
      link.download = `missing-setups-${OptimizerPreview._plant || 'preview'}.csv`; link.click(); URL.revokeObjectURL(url);
    });
    body.querySelector<HTMLButtonElement>('[data-opt-review-missing]')?.addEventListener('click', () => {
      const setupAdmin = (globalThis as unknown as { NIMBUS?: { SetupAdmin?: { reviewMissingPairs?: (plant: string | null, pairs: PreviewExplanation['missingPairs']) => void } } }).NIMBUS?.SetupAdmin;
      if (setupAdmin?.reviewMissingPairs?.(OptimizerPreview._plant, OptimizerPreview._explanation?.missingPairs || [])) OptimizerPreview.discard();
    });
    OptimizerPreview._syncApplyButton();
  },

  apply() {
    const snap = OptimizerPreview._snapshot;
    const candidate = OptimizerPreview._candidate;
    const mode = OptimizerPreview._mode;
    const plant = OptimizerPreview._plant;
    const auditDetails = OptimizerPreview._auditDetails;
    if (!snap || !candidate) { Modal.close('modal-opt-preview'); return; }
    if (!OptimizerPreview.canApply()) {
      Toast.show(Util.t('ui.setup_preview_apply_stale_title'), 'warn');
      return;
    }
    if (auditDetails && plant) {
      fetch(`${Config.API_BASE}/audit/log`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': Session.actor() },
        body: JSON.stringify({
          action: 'optimization_run', plant,
          details: {
            mode: auditDetails.mode,
            wheel_used: auditDetails.wheelUsed,
            task_count: auditDetails.taskCount,
            scope: auditDetails.scope,
            lines: auditDetails.lines,
            active_priority_fields: auditDetails.activePriorityFields,
            unranked_priority_fields: auditDetails.unrankedPriorityFields,
            split_order_policy: auditDetails.splitOrderPolicy,
          },
        }),
      }).catch(() => {});
    }
    if (mode === 'backlog' && OptimizerPreview._backlogResult && OptimizerPreview._backlogAudit) {
      const audit = OptimizerPreview._backlogAudit;
      const diagnostics = OptimizerPreview._backlogResult.diagnostics;
      fetch(`${Config.API_BASE}/audit/log`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': Session.actor() },
        body: JSON.stringify({
          action: 'optimization_run', plant: audit.plant,
          details: {
            mode: 'backlog', scope: audit.lines ? 'lines' : 'plant', lines: audit.lines,
            from: audit.from?.toISOString() ?? null, to: audit.to?.toISOString() ?? null,
            plant_timezone: audit.timezone, captured_run_at: audit.runAt?.toISOString() ?? null,
            backlog_found: diagnostics.backlogFound, moved: diagnostics.moved, firmed_moved: diagnostics.firmedMoved,
            frozen_moved: diagnostics.frozenMoved,
            invalid_runtime: diagnostics.invalidRuntimeIds.length, missing_start: diagnostics.missingStartIds.length,
            overlong: diagnostics.overlongIds.length, largest_delay_minutes: diagnostics.largestDelayMinutes,
            boundary_conflicts: diagnostics.boundaryConflicts.length,
            applied_with_boundary_conflicts: diagnostics.boundaryConflicts.length > 0,
            split_order_policy: Engine.splitOrderPolicyFor(audit.plant),
          },
        }),
      }).catch(() => {});
    }
    // This is the sole schedule-state commit for a preview candidate.
    Engine.applySchedulePatches(candidate.patches);
    Store.setLastOptimize(new Date(), 'engine');
    const hadDismissed = Alerts.clearDismissed();
    // Push an undo entry so Ctrl+Z restores the pre-optimization state later.
    UndoStack.push(`Optimization (${mode})${plant ? ' · ' + plant : ''}`,
      () => UndoStack.restoreTasks(snap));
    Toast.show(Util.t('toast.opt_applied'), 'success');
    // Fire warning toasts — matching the live Engine.runAndApply patterns from schedule-services.mts
    if (OptimizerPreview._explanation) {
      const { scheduledWithoutSetup, unplacedOrders } = OptimizerPreview._explanation;
      if (scheduledWithoutSetup.orders && !OptimizerPreview._syntheticSetup) {
        Toast.show(Util.t('toast.optimize_missing_setup_summary', {
          orders: scheduledWithoutSetup.orders,
          lines: scheduledWithoutSetup.lines,
        }), 'warn');
      }
      if (unplacedOrders.orders) {
        Toast.show(Util.t('toast.optimize_orders_left_in_place', {
          orders: unplacedOrders.orders,
          lines: unplacedOrders.lines,
        }), 'warn');
      }
    }
    if (candidate.unchangedLines.length) {
      Toast.show(Util.t('toast.optimize_lines_guarded', { count: candidate.unchangedLines.length }), 'warn');
    }
    OptimizerPreview._clear();
    // The trial is now the committed baseline. Phase 3 (Pkg E): route through
    // Confidence's own debounced scheduler (Util.debounce-wrapped in
    // nimbus-intelligence.js) instead of forcing a synchronous recompute on
    // the click path.
    NIMBUS!.Confidence?._recomputeDebounced?.();
    Modal.close('modal-opt-preview');
    // Phase 3 (Pkg E): scope the recompute to the lines candidate.patches
    // actually touched instead of a full-plant recompute. `snap` is the
    // pre-apply snapshot (candidate patches never change MACHINE, so
    // pre/post-apply line membership match).
    // If any alert was dismissed before this apply, a scoped merge would
    // retain untouched lines' stale (dismissal-filtered) alert lists as-is —
    // those cleared dismissals would never re-surface until some later full
    // recompute. A pending full recompute already wins over a scoped one by
    // design, so force it whenever there was something to clear.
    if (hadDismissed) {
      Alerts.scheduleRecompute();
    } else {
      const byId = new Map(snap.map(t => [String(t.id), t]));
      scheduleAlertsForPatches(candidate.patches, id => byId.get(String(id))?.MACHINE || 'Unknown');
    }
  },

  discard() {
    if (OptimizerPreview._candidate) {
      Toast.show(Util.t('toast.opt_discarded'), 'info');
    }
    OptimizerPreview._clear();
    Modal.close('modal-opt-preview');
  },

  _clear(keepPreviewDiagnostics: boolean = false) {
    OptimizerPreview._snapshot = null;
    OptimizerPreview._candidate = null;
    OptimizerPreview._preKpis  = null;
    OptimizerPreview._postKpis = null;
    OptimizerPreview._mode     = null;
    OptimizerPreview._plant    = null;
    OptimizerPreview._splitOrderPolicy = 'never';
    OptimizerPreview._backlogResult = null;
    OptimizerPreview._backlogAudit = null;
    OptimizerPreview._auditDetails = null;
    OptimizerPreview._syntheticSetup = false;
    OptimizerPreview._explanation = null;
    OptimizerPreview._finalists = null;
    OptimizerPreview._finalistsPending = false;
    OptimizerPreview.stale = false;
    OptimizerPreview._staleReason = null;
    if (!keepPreviewDiagnostics) OptimizerPreview._previewDiagnostics = [];
    OptimizerPreview.active       = false;
  },
};

Persistence.setSetupWriteListener((plant, kind) => OptimizerPreview.markSetupStale(plant, kind));

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
      if (_plant && Store.getPlantForLine(t.MACHINE) !== _plant) continue;
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

/* =============================================================================
   PRIORITY LIST VIEWER — generic modal preview of a plant's uploaded
   priority list for a rankable field (prt01/prt02/productionVersion).
   Delegates to ColorWheelViewer for the colorWheel field, which keeps its
   own richer swatch/task-count rendering.
   ========================================================================== */
export const PriorityListViewer = (() => {
  let _plant: string | null = null;
  let _fieldKey: string | null = null;
  let _line = '';
  let _entries: PriorityListEntry[] = [];
  let _search = '';

  const _esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c: string) =>
    (({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]));

  // `line` (optional, defaults to '' = plant-wide) — a field card's per-line
  // override rows carry a line, and previewing one without threading it
  // through would always 404-fall-back to the plant-wide list (or "no list"
  // if there isn't one), even though the override upload itself succeeded.
  // The colorWheel delegate to ColorWheelViewer's own richer swatch renderer
  // only applies to the plant-wide case (no line) — ColorWheelViewer.open
  // takes no line param and the legacy /color-wheel/{plant} route it calls
  // only ever reads line=""; a colorWheel line override falls through to
  // this module's own generic value/rank renderer instead, the same path
  // every other field's line override already uses, so the preview actually
  // reflects the override's data instead of silently showing the plant-wide
  // wheel.
  function open(plant: string, fieldKey: string, line: string = '') {
    if (fieldKey === 'colorWheel' && !line) { ColorWheelViewer.open(plant); return; }
    _plant = plant; _fieldKey = fieldKey; _line = line; _search = '';
    const el = document.getElementById('modal-priority-viewer');
    if (!el) return;
    el.hidden = false;
    const srch = document.getElementById('pl-viewer-search') as HTMLInputElement | null;
    if (srch) srch.value = '';
    requestAnimationFrame(() => el.querySelector('.cw-viewer-modal')?.classList.add('visible'));
    _load();
  }

  function close() {
    const el = document.getElementById('modal-priority-viewer');
    if (!el) return;
    el.querySelector('.cw-viewer-modal')?.classList.remove('visible');
    setTimeout(() => { el.hidden = true; }, 240);
  }

  function _load() {
    const labelEl = document.getElementById('pl-viewer-field-label');
    const nameEl  = document.getElementById('pl-viewer-plant-name');
    const listEl  = document.getElementById('pl-viewer-list');
    if (labelEl) labelEl.textContent = _fieldKey ? Util.t(`constraint.${_fieldKey}`) : '—'; // resolved label, not the raw camelCase key — same rule as Plant's toasts/modals
    if (nameEl)  nameEl.textContent  = _plant || '—';
    if (listEl)  listEl.innerHTML    = `<div class="cw-loading"><span class="cw-spin"></span>${Util.t('ui.loading')}</div>`;

    // Util.fetchTraced (not bare fetch) — GET /priority-list/{plant}/{field_key}
    // isn't admin-gated, but it does call _assert_plant_allowed server-side
    // (brain.py:1943) to scope by the caller's role_plants; with no identity
    // header a plant-restricted user could preview ANY plant's priority
    // list, not just plants they're allowed to see (same class of bug as
    // plant-and-administration.mts's fetch trio, just in a different file).
    const qs = _line ? `?machine=${encodeURIComponent(_line)}` : '';
    Util.fetchTraced(`${Config.API_BASE}/priority-list/${encodeURIComponent(_plant!)}/${encodeURIComponent(_fieldKey!)}${qs}`,
          { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() as Promise<PriorityListResponse> : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(body => {
        _entries = body.entries || [];
        const metaEl = document.getElementById('pl-viewer-meta');
        const m = body.meta || {};
        // meta.row_count is priority_list.row_count, which brain.
        // _persist_priority_list now stores as len(entries) — the value/rank
        // pairs actually STORED — so it agrees with the list rendered below it
        // and with the field card's "N values". It used to be the uploaded
        // file's raw row count, so a 500-row file with 40 distinct values read
        // "500 values" above a 40-row list.
        if (metaEl) metaEl.textContent = m.filename
          ? `${m.filename} · ${m.row_count ?? _entries.length} values`
          : `${_entries.length} values`;
        _render();
      })
      .catch((err: Error) => {
        _entries = [];
        if (listEl) listEl.innerHTML = `<div class="cw-viewer-empty">${Util.t('empty.pl_no_list_for_plant')}</div>`;
        const metaEl = document.getElementById('pl-viewer-meta');
        if (metaEl) metaEl.textContent = err.message.includes('404') ? Util.t('empty.pl_no_file') : err.message;
      });
  }

  function _render() {
    const listEl = document.getElementById('pl-viewer-list');
    const countEl = document.getElementById('pl-viewer-count');
    if (!listEl) return;
    const q = _search.toLowerCase();
    const data = _entries.filter(e => !q || e.value.toLowerCase().includes(q));
    if (countEl) countEl.textContent = `${data.length} / ${_entries.length}`;
    if (!data.length) {
      listEl.innerHTML = `<div class="cw-viewer-empty">${Util.t('empty.pl_no_matches')}</div>`;
      return;
    }
    listEl.innerHTML = data.map(e => {
      const pri = e.rank < 999999 ? e.rank : '—';
      return `
        <div class="cw-viewer-row">
          <div class="cw-viewer-rank">${_esc(pri)}</div>
          <div class="cw-viewer-name">${_esc(e.value)}</div>
        </div>`;
    }).join('');
  }

  function search(val: string) { _search = String(val || ''); _render(); }

  return { open, close, search };
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
  // Last plant _drawerVL was populated for (Part A1/A2) — destroyed on an
  // empty alert list (see renderDrawer below), but a plant switch that
  // still leaves alerts non-empty wouldn't otherwise reset the remembered
  // scroll offset against the new plant's (differently-ordered) alert list.
  _drawerVLPlant: null as string | null,
  _handleAction(e: MouseEvent): void {
    const target = e.target as Element | null;
    const trigger = target?.closest?.<HTMLElement>('[data-alert-action]') ?? null;
    if (!trigger) return;

    const action = trigger.dataset.alertAction;
    if (action === 'override') {
      const taskId = trigger.dataset.taskId;
      if (!taskId) return;
      AlertsUIAdapter.toggleDrawer();
      Table._openOverrideModalForId(taskId);
      return;
    }

    const alertId = trigger.dataset.alertId;
    if (!alertId) return;
    if (action === 'focus') {
      AlertsUIAdapter.focus(alertId);
    } else if (action === 'fix') {
      Alerts.applyFix(alertId);
    } else if (action === 'dismiss') {
      // The Dashboard row itself is a focus target; a nested dismiss button
      // must not bubble into that second action.
      e.stopPropagation();
      Alerts.dismiss(alertId);
    }
  },
  // Jump to the task related to an alert (navigates to Gantt tab and focuses it
  // at day-level zoom so the alert context — surrounding orders, blackouts — is visible).
  //
  // B1: line+day navigation now happens UNCONDITIONALLY — every alert carries
  // required `line`/`time` fields (nimbus-compute-core.d.ts), so it's always
  // resolvable. Previously a taskId alert took a different path entirely
  // (vis-timeline's native focus(), which centers the item's own extent
  // rather than the alert's day) and produced a visibly different landing
  // spot than the taskless path. Task selection + Inspector now layer on
  // top of the same navigation instead of replacing it.
  focus(alertId: string) {
    const a = Store.alerts.find(x => x.id === alertId);
    if (!a) return;
    if (!a.line || !a.time) return; // defensive only — contract guarantees both

    // B2: reveal a line hidden by an active Gantt line filter before
    // navigating — ADD to the existing selection (never clear/replace) so
    // the rest of the planner's filter survives. Silent per approved
    // decision (no toast). Store.setSelectedLines no-ops if the line is
    // already selected, so this is safe to call unconditionally when the
    // filter is active.
    const sel = Store.selectedLines;
    if (sel.size > 0 && !sel.has(a.line)) {
      Store.setSelectedLines([...sel, a.line], 'alert-focus');
    }

    // gotoLineDay forces the Timeline sub-tab visible, sets the 3-day window
    // for the alert's day, and (bounded-retries until) scrolls to the line's
    // row — see gotoLineDay for why the reveal above needs that retry.
    // Task selection/Inspector piggyback on its "window is set" callback
    // rather than re-centering the window a second time.
    Timeline.gotoLineDay(a.line, Util.dayKey(a.time), () => {
      if (!a.taskId) return;
      const t = Store.tasks[a.taskId];
      if (!t || !Timeline._tl) return;
      Timeline._tl.setSelection([String(a.taskId)]);
      Inspector.show(t);
    });
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
    const dayStart = Util.startOfDay(day)!;
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const cellEntries: Array<{ task: NimbusTask; scheduledHours: number; sortAt: Date }> = [];
    for (const task of Store.tasksArr) {
      if ((task.MACHINE || 'Unknown') !== line) continue;
      const isSplit = (task.scheduleSegments?.length ?? 0) >= 2;
      if (!isSplit) {
        // Preserve legacy continuous-order accounting in Never mode.
        if (task.start_date && Util.dayKey(task.start_date) === dayKey) {
          cellEntries.push({ task, scheduledHours: Util.runHours(task), sortAt: task.start_date });
        }
        continue;
      }
      const intervals = Util.scheduleIntervals(task)
        .filter(interval => interval.start < dayEnd && interval.end > dayStart);
      if (!intervals.length) continue;
      const scheduledHours = intervals.reduce((sum, interval) => {
        const start = Math.max(interval.start.getTime(), dayStart.getTime());
        const end = Math.min(interval.end.getTime(), dayEnd.getTime());
        return sum + (end - start) / Config.MS_HOUR;
      }, 0);
      cellEntries.push({ task, scheduledHours, sortAt: intervals[0].start });
    }
    cellEntries.sort((a, b) => a.sortAt.getTime() - b.sortAt.getTime());
    const cellTasks = cellEntries.map(entry => entry.task);
    const scheduledH = cellEntries.reduce((sum, entry) => sum + entry.scheduledHours, 0);
    const effCap   = Calendar.effectiveCapacityHours(line, day) || 0;
    const utilPct  = effCap > 0 ? scheduledH / effCap : 0;
    // Same field set as Util.countChangeovers / Engine._sortTerms — was a second
    // hardcoded COLOR/FORM_SIZE copy, which reported 0 changeovers for a cell
    // whose orders differ only in tooling on a plant that sequences by PRT.
    const coFields = Util.changeoverFields();
    let changeovers = 0;
    for (let i = 1; i < cellTasks.length; i++) {
      const a = cellTasks[i-1] as unknown as Record<string, unknown>;
      const b = cellTasks[i]   as unknown as Record<string, unknown>;
      if (coFields.some(f => (a[f] || '') !== (b[f] || ''))) changeovers++;
    }

    // -------- Categorize alerts
    const CALENDAR_TYPES = new Set(['blackout', 'closed', 'firmed-closed', 'firmed-out-of-hours']);
    const CAT_MAP: Record<AlertType, string> = {
      overload:             'capacity',
      'near-capacity':      'capacity',
      overlap:              'conflicts',
      blackout:             'calendar',
      closed:               'calendar',
      'firmed-closed':       'calendar',
      'firmed-out-of-hours': 'calendar',
      'runtime-schedule-mismatch': 'exceptions',
    };
    const byCat: Record<string, NimbusAlert[]> = { capacity: [], conflicts: [], calendar: [], exceptions: [] };
    // Setup diagnostics are intentionally not given a UI category in this
    // Stage-1 task; they retain the existing exceptions fallback.
    for (const a of matches) byCat[CAT_MAP[a.type as AlertType] || 'exceptions'].push(a);

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
      return Util.orderNumber(t);
    };
    // Union (SAP OR frozen-horizon OR manual) — see Engine.firmingStatus.
    const taskFirmed = (id: string) => { const t = Store.tasks?.[id]; return !!t && Engine.firmingStatus(t).firmed; };

    const renderChip = (id: string) => `
      <span class="ac-chip ${taskFirmed(id) ? 'firmed' : ''}" title="${esc(taskPO(id))}">${esc(taskPO(id))}</span>`;

    const renderCard = (a: NimbusAlert) => {
      // Headline + right-side numeric.
      let headline = esc(a.type.replace(/-/g,' ')).replace(/\b\w/g, c => c.toUpperCase());
      let num = '';
      let chipsHtml = '';

      if (a.type === 'overload') {
        headline = 'Overloaded';
        num = `<span class="ac-card-num over">${(utilPct * 100).toFixed(0)}%</span>`;
        // Show the top contributing orders by run hours.
        const top = cellEntries.slice().sort((x, y) => y.scheduledHours - x.scheduledHours)
          .slice(0, 4).map(entry => entry.task);
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
      } else if (a.type === 'firmed-closed') {
        // These rules fire for ANY order on a closed day, firmed or not — the
        // headline must not claim firmness (see contract: NEW i18n keys).
        headline = Util.t('ui.alert_headline_closed_day');
        if (a.taskId) chipsHtml = `<div class="ac-chips">${renderChip(a.taskId)}</div>`;
      } else if (a.type === 'firmed-out-of-hours') {
        headline = Util.t('ui.alert_headline_out_of_hours');
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
    const CALENDAR_TYPES = new Set(['blackout', 'closed', 'firmed-closed', 'firmed-out-of-hours']);
    const sevIcon: Record<string, string> = { err: '✖', warn: '⚠', info: 'ℹ' };
    const esc = (s: unknown) => String(s == null ? '' : s).replace(/[&<>"']/g, (c: string) =>
      (({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' } as Record<string, string>)[c]));
    const isCalendar = CALENDAR_TYPES.has(a.type);
    const ico        = isCalendar ? '⊘' : (sevIcon[a.sev] || '•');
    const fixable  = ['overlap', 'blackout', 'overload'].includes(a.type);
    const override = (a.type === 'closed' || a.type === 'firmed-closed' || a.type === 'firmed-out-of-hours') && a.taskId != null;
    return `<div class="alert-row alert-${a.sev}${isCalendar ? ' alert-calendar' : ''}" data-id="${esc(a.id)}">` +
      `<span class="alert-ico">${ico}</span>` +
      `<span class="alert-msg">${esc(a.msg)}</span>` +
      `<div class="alert-actions">` +
        ((a.taskId != null || (a.line && a.time)) ? `<button class="btn btn-ghost sm" data-alert-action="focus" data-alert-id="${esc(a.id)}">${Util.t('btn.go_to')}</button>` : '') +
        (fixable  ? `<button class="btn-fix" title="${Util.t('tip.fix_alert')}" data-alert-action="fix" data-alert-id="${esc(a.id)}">${Util.t('btn.fix_it')}</button>` : '') +
        (override ? `<button class="btn btn-ghost sm" data-alert-action="override" data-task-id="${esc(a.taskId)}">${Util.t('btn.override')}</button>` : '') +
        `<button class="btn btn-ghost sm" data-alert-action="dismiss" data-alert-id="${esc(a.id)}">${Util.t('btn.dismiss')}</button>` +
      `</div></div>`;
  },

  renderDrawer() {
    const body = document.getElementById('alert-drawer-body');
    if (!body) return;
    body.onclick = AlertsUIAdapter._handleAction;
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
    const identityChanged = AlertsUIAdapter._drawerVLPlant !== Store.selectedPlant;
    AlertsUIAdapter._drawerVLPlant = Store.selectedPlant;
    AlertsUIAdapter._drawerVL.update(alerts, identityChanged ? { anchor: 'top' } : undefined);

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
  // Sandbox.exit()'s undo closure (in schedule-state.mjs) restores tasks/firmedIds
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
        const la = (a.MACHINE || 'Unknown'), lb = (b.MACHINE || 'Unknown');
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
        t.MACHINE || '—',
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
        t.MACHINE || '',
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
