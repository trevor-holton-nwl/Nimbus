// scheduling/gantt.mjs — Timeline, TimelineNav, DependencyOverlay, Hierarchy,
// GanttFilter, and Interaction. Extracted verbatim from schedule-workbench.mts
// (Phase P3 of docs/architecture/domain-refactor-plan.md, which split that
// 10,391-line mega-module into 6 domain files) — three non-contiguous source
// ranges combined into this one file per that phase's per-domain grouping.
//
// `setupDiagnosticLabel`/`setupSourceLabel`/`SetupPresentationDetail` are
// exported (not duplicated) for scheduling/orders.mts's Inspector to import —
// the original file's own comment on this block says the diagnostic-label
// mapping is "shared ... so the mapping is never duplicated"; splitting the
// file must not undo that. `Table`/`Inspector`/`ContextMenu`/
// `notifyResidualFirming` are imported back from scheduling/orders.mjs for
// Interaction's ContextMenu.open/Inspector.clear/Inspector.show/Table._api
// table-sync calls and its unfirm-notification call — a two-way module
// dependency with orders.mjs (which itself imports Timeline/TimelineNav back
// from here for Table/Inspector's setup-observation and redraw calls), an
// intrinsic mutual reference carried over unchanged from the original
// single-file module, not a new coupling introduced by this split. It
// resolves safely at runtime: neither module touches the other's binding
// during its own top-level evaluation, only inside methods invoked later,
// after both modules have finished initializing (a "lazy" ESM cycle, same
// precedent as setup-admin.mts's Plant cycle from Phase P2).
/* global NIMBUS */
import { Config, Util, PerfMonitor, ErrorLog, Toast, Modal, VirtualList } from '../platform/foundation.mjs';
import { Store, Selection, UndoStack } from '../schedule-state.mjs';
import type { StoreEvent } from '../schedule-state.mjs';
import { Utilization, Alerts, Engine, deriveSetupObservation } from '../schedule-services.mjs';
import type { SetupObservation } from '../schedule-services.mjs';
import { Persistence } from '../schedule-data.mjs';
import { Table, Inspector, ContextMenu, notifyResidualFirming } from './orders.mjs';
import type { AgGridRowNode } from './orders.mjs';
import type { NimbusTask, NimbusBlock, NimbusPlantBlock, AlertSev, UtilSevBucket, TimelineItemKind } from '../platform/types.mjs';

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

export interface SetupPresentationDetail {
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

export function setupDiagnosticLabel(type: string | undefined | null): string {
  const entry = type ? SETUP_DIAGNOSTIC_PRESENTATION[type] : undefined;
  return Util.t(entry ? entry.i18nKey : 'ui.setup_missing');
}

/** D4: the resolveSetup() 'source' field is raw plumbing (`'line'|'plant'|
 * 'occurrence'|'implicit-zero'|'uncovered'`), displayed verbatim in the
 * Inspector's Source row for every value except 'implicit-zero' — that one
 * value gets a translated label so an identical-signature no-change
 * transition never reads as though a matrix row had been consulted. */
export function setupSourceLabel(source: string | null | undefined): string {
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
