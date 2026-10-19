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
import { Config, Util, PerfMonitor, ErrorLog, Toast, VirtualList } from '../platform/foundation.mjs';
import type { PasteMatcher } from '../platform/foundation.mjs';
import { Store, UndoStack } from '../platform/store.mjs';
import { Selection } from './selection.mjs';
import type { StoreEvent } from '../platform/store.mjs';
import { Utilization, Alerts } from '../insights/services.mjs';
import { Engine, deriveSetupObservation } from '../optimization/engine.mjs';
import type { SetupObservation, ManualPlacementOptions } from '../optimization/engine.mjs';
import { Persistence } from './persistence.mjs';
import { Table, Inspector, ContextMenu, notifyResidualFirming } from './orders.mjs';
import type { AgGridRowNode } from './orders.mjs';
import type { NimbusTask, NimbusBlock, NimbusPlantBlock, AlertSev, UtilSevBucket, TimelineItemKind } from '../platform/types.mjs';
import { Calendar } from '../calendar/calendar-engine.mjs';
import { Runtime } from '../routing/runtime-client.mjs';
import { buildNonWorkingSpans } from './nonworking-spans.mjs';

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
  predecessorOrderId: string | null | undefined;
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
const _ZONE_MIN_PX = 0.5;
export const Timeline = {
  _tl: null as NimbusVendor.VisTimelineInstance | null,
  _items:     null as NimbusVendor.VisDataSet<TimelineVisItem> | null,
  _visItems:  null as NimbusVendor.VisDataView<TimelineVisItem> | null,             // DataView filter layer — vis-timeline sees only items near the viewport
  _groups:    null as NimbusVendor.VisDataSet<TimelineGroupData> | null,
  _viewWindow: null as TimelineWindowMs | null,            // { start: ms, end: ms } — current viewport, kept in sync via rangechanged
  _pastZoneIds:     [] as string[],         // cached IDs for ticker updates (avoids getIds() scan every second)
  _alertHorizonIds: [] as string[],
  // Non-working-time shading (W5): the ONE range the 'nonworking-*' background items currently cover.
  // Set only by _syncNonWorking (and seeded by init/_rebuildPass when null); _rebuildPass reads it so its
  // full diff never deletes items the pan path added. _nwIds tracks the ids we own for the pan re-diff.
  _nwRange: null as { fromMs: number; toMs: number } | null,
  _nwIds: new Set<string>(),
  _nwTruncWarned: false,
  _frozenHorizonIds: [] as string[],        // C2 (2026-08-20): frozen-horizon zone ids, re-advanced by the same ticker below
  _rebuildNow: null as Date | null,         // the viewer's clock at the start of the last rebuild() pass (timeline min bound); firming/lock styling reads the plant clock via _nowFor
  _frozenBandIds: null as Set<string> | null, // P2: task ids currently inside the frozen horizon band, for live repaint diffing
  _zonePushedMs: 0,                         // epoch ms of the "now" last written into the zone bands; 0 = unknown, next tick pushes
  _zoneEdgeKey: '',                         // `${hzMinutes}|${frozenEndMs}` the bands were last written with; a change forces a push
  _lastFirmScanTs: 0,                     // P2: throttle for the coarse 30s frozen-band rescan in the 1s ticker
  _visibilityHorizonMarker: false,          // C1: tracks whether the 'visibility-horizon' custom time bar has been added to _tl (addCustomTime/removeCustomTime throw on a duplicate/missing id)
  _lineColorIdx: {} as Record<string, number>,            // stable line → colour index mapping
  _nextColorIdx: 0,
  _unsubStore:   null as (() => void) | null,
  _suppressEvents: false,       // guard to prevent self-triggered loops
  _gotoFlash: null as { taskId: string; until: number } | null,   // "Go To" pulse target; _itemForTask re-applies .goto-target while unexpired so a rebuild can't drop it
  _gotoFlashTimer: null as ReturnType<typeof setTimeout> | null,
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
  // Set whenever _vScrollTop has been pinned to a value that the NEXT visible
  // rebuild must re-apply verbatim, rather than overwriting it by capturing
  // vis's current (possibly hidden-clamped) scroll position first. Set by
  // saveVScroll() (pane about to be hidden) and resetVScroll() (plant change);
  // cleared once the rAF at the end of rebuild() has actually re-applied it.
  _vScrollRestorePending: false,
  _itemIdsByTask: {} as Record<string, string[]>,

  // True only once the Gantt pane has real layout (clientHeight > 0). A hidden
  // tab (display:none) or a not-yet-attached container reports 0 and would
  // make any scroll read/write meaningless (vis clamps to a 0-height range).
  _vScrollLaidOut(): boolean {
    return (Timeline._visEl?.clientHeight ?? 0) > 0;
  },

  // Called by the shell (App._saveScroll) right before the timeline pane is
  // hidden — capture the real position now, while still laid out, and mark it
  // for verbatim restoration on the next visible rebuild instead of letting
  // that rebuild's own capture read vis's hidden-clamped value.
  saveVScroll(): void {
    if (Timeline._tl && Timeline._vScrollLaidOut()) Timeline._vScrollTop = Timeline._getVScroll();
    Timeline._vScrollRestorePending = true;
  },

  // Plant change: start the Gantt at the top, same as every other pane.
  resetVScroll(): void {
    Timeline._vScrollTop = 0;
    Timeline._vScrollRestorePending = true;
  },

  _loadingMaskTimer: null as ReturnType<typeof setTimeout> | null,
  _loadingMaskHideTimer: null as ReturnType<typeof setTimeout> | null,

  // Shown by the shell (App.gotoGanttSub) synchronously on every Timeline-pane
  // entry, so the first paint after the pane flips is the mask rather than a
  // half-laid-out Gantt, and by _onStore's plant:selected branch when the
  // Gantt is active, so the mask stays up through the new plant's /tasks
  // load. Hidden by rebuild()'s rAF once the scroll restore has been applied
  // and Persistence.isLoading() is false. Always self-clears after 8s —
  // matching Persistence.load's own fetch timeout — so a load that never
  // calls back (network drop, etc.) can't leave the mask stuck over the
  // whole Gantt indefinitely.
  showLoadingMask(): void {
    const el = document.getElementById('timeline-loading-overlay');
    if (!el) return;
    if (Timeline._loadingMaskHideTimer) { clearTimeout(Timeline._loadingMaskHideTimer); Timeline._loadingMaskHideTimer = null; }
    el.hidden = false;
    el.classList.remove('is-hiding');
    if (Timeline._loadingMaskTimer) clearTimeout(Timeline._loadingMaskTimer);
    Timeline._loadingMaskTimer = setTimeout(() => Timeline.hideLoadingMask(), 8000);
  },

  hideLoadingMask(): void {
    const el = document.getElementById('timeline-loading-overlay');
    if (!el) return;
    if (Timeline._loadingMaskTimer) { clearTimeout(Timeline._loadingMaskTimer); Timeline._loadingMaskTimer = null; }
    if (el.hidden) return;
    el.classList.add('is-hiding');
    Timeline._loadingMaskHideTimer = setTimeout(() => {
      el.hidden = true;
      el.classList.remove('is-hiding');
      Timeline._loadingMaskHideTimer = null;
    }, 180);
  },

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
      // OQ1: the start is derived from the finish, so the left edge is not an input. vis-timeline has no per-handle
      // switch for it; this veto snaps a drag that changes the start but not the end back to the stored start, so the
      // left handle moves nothing (a left-edge change that still reaches the commit is reverted with a toast).
      onMoving: (item: TimelineVisItem, callback: (item: TimelineVisItem | null) => void) => {
        callback(lockLeftEdge(item, (Timeline._items?.get(String(item.id)) as TimelineVisItem | null) ?? null));
      },
      groupOrder: (a: TimelineGroupData, b: TimelineGroupData) => (a.order ?? 0) - (b.order ?? 0),
      // item:'top' too — Core._updateScrollTop bottom-anchors scrollTop whenever
      // orientation.item != 'top' (shifts it by the change in scroll range on every
      // redraw), which is what threw the Gantt to the bottom on tab re-entry and on
      // first load. item:'top' makes scrollTop a stable "px from top of content".
      orientation: { axis: 'top', item: 'top' },
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
    Timeline._nwRange ??= Timeline._nwRangeAround(_initW.start.getTime(), _initW.end.getTime());

    // Refresh the DataView after the user finishes panning/zooming. Debounced so it
    // never fires per-frame during active drag — items already in the window stay
    // rendered; fringe items outside the buffer are evicted/loaded once pan settles.
    // The non-working shading re-diffs first (hysteresis: usually a no-op) so the
    // refresh below sees the final item set.
    const _refreshView = Util.debounce(() => { Timeline._syncNonWorking(false); Timeline._refreshViewNow(); }, 120);
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
     * frozen-horizon-zone (one interval, shared — never add a second one for
     * a new band). The bands are pushed only when "now" has moved >= 0.5 px
     * at the current zoom or an edge input changed, and only while the Gantt
     * pane is visible: every DataSet update costs a full vis redraw. -- */
    setInterval(() => {
      if (document.hidden) return; // skip ticker work while the tab is backgrounded
      if (!Timeline._items || !Timeline._pastZoneIds.length) return;
      const _pmT0 = performance.now();
      const now  = Timeline._plantNow(Store.selectedPlant);
      let hz: number | null = null;
      if (Timeline._alertHorizonIds.length) {
        const plantRow = Store.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null;
        const hzRaw = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? null;
        hz = typeof hzRaw === 'number' ? hzRaw : null;
      }
      const frozenEnd = (Timeline._frozenHorizonIds.length && Store.frozenHorizonEnd) ? Store.frozenHorizonEnd : null;
      const edgeKey = `${typeof hz === 'number' ? hz : ''}|${frozenEnd ? frozenEnd.getTime() : ''}`;
      const zonesVisible = Timeline._ganttActive() && Timeline._vScrollLaidOut();
      if (zonesVisible && (edgeKey !== Timeline._zoneEdgeKey || tickerShouldPush({
        nowMs: now.getTime(), lastPushedMs: Timeline._zonePushedMs,
        windowMs: Timeline._windowSpanMs(), centerPx: Timeline._centerWidthPx(),
      }))) {
        const updates: Array<{ id: string; start?: Date; end?: Date }> = Timeline._pastZoneIds
          .filter(id => Timeline._items!.get(id))
          .map(id => ({ id, end: now }));
        if (typeof hz === 'number') {
          const hzEnd = new Date(now.getTime() + hz * Config.MS_MIN);
          for (const id of Timeline._alertHorizonIds) {
            if (Timeline._items!.get(id)) updates.push({ id, start: now, end: hzEnd });
          }
        }
        // C2: only the near edge tracks "now" — the far edge (Store.frozenHorizonEnd)
        // is a fixed absolute instant recomputed server-side on the next /tasks
        // load, not a rolling duration, so it is deliberately left alone here.
        if (frozenEnd) {
          for (const id of Timeline._frozenHorizonIds) {
            if (Timeline._items!.get(id)) updates.push({ id, start: now, end: frozenEnd });
          }
        }
        if (updates.length) {
          Timeline._items!.update(updates);
          Timeline._zonePushedMs = now.getTime();
          Timeline._zoneEdgeKey = edgeKey;
        }
      }

      // P2: coarse 30s scan for orders crossing the frozen-horizon band —
      // symmetric diff against the last-known membership set. Orders leave
      // the band as "now" advances past them; new members appear when the
      // server recomputes frozen_horizon_end on the next /tasks refetch.
      // Also self-heals if the horizon changes mid-session. Cache-only boots
      // have frozenHorizonEnd null until the first /tasks fetch, matching
      // the band's own absence in that state.
      if (Date.now() - Timeline._lastFirmScanTs > 30_000) {
        Timeline._lastFirmScanTs = Date.now();
        const next = new Set<string>();
        Timeline._clockMemo = new Map();   // U26: one plant clock per plant for the whole scan
        try {
          for (const t of Store.tasksByPlant(Store.selectedPlant)) if (Timeline._inLockBand(t)) next.add(String(t.id));
          const prev = Timeline._frozenBandIds;
          if (prev) {
            for (const id of prev) if (!next.has(id)) Timeline._applyTaskPatch(id);
            for (const id of next) if (!prev.has(id)) Timeline._applyTaskPatch(id);
          }
        } finally { Timeline._clockMemo = null; }
        Timeline._frozenBandIds = next;
      }
      PerfMonitor.record('Timeline.ticker', performance.now() - _pmT0);
    }, 1000);

    /* ----- subscribe to store changes ----------------------------------- */
    Timeline._unsubStore = Store.subscribe(evt => Timeline._onStore(evt), 'Timeline');
  },

  /** Membership of the live lock band the 30s scan diffs: inside the frozen horizon OR running now.
   *  Running is included so an order that starts while the page is open gets its running lock
   *  styling without a reload (C5). */
  _inLockBand(t: NimbusTask, now: Date = Timeline._nowFor(t)): boolean {
    return Engine.isFrozenHorizon(t, now) || Engine.isInProgress(t, now);
  },

  /** "Now" at a plant: the server instant in the plant's zone, as the naive wall-clock Date the bars use (the
   *  one clock, OQ52). The viewer's own clock only when the plant has no valid zone (it is then blocked and
   *  announced elsewhere; the styling still needs some instant). */
  _plantNow(plant: string | null | undefined): Date {
    const memo = Timeline._clockMemo;
    const key = plant ?? '';
    const hit = memo?.get(key);
    if (hit) return new Date(hit.getTime());   // a copy: callers may mutate the instant they were handed
    const now = Store.plantNow(plant) ?? new Date();
    memo?.set(key, new Date(now.getTime()));
    return now;
  },
  /** Per-plant "now", valid for one rebuild or one band scan (U26); null outside a pass. */
  _clockMemo: null as Map<string, Date> | null,

  /** The instant an order is judged against for firming/lock styling: its own plant's clock. */
  _nowFor(t: NimbusTask): Date {
    return Timeline._plantNow(t.PLANT || (t.MACHINE ? Store.getPlantForLine(t.MACHINE) : null) || Store.selectedPlant);
  },

  // Cached lookup for the (static) #gantt-tab; lazily caches on first call so
  // init order can't leave it null. Replaces 4 inline getElementById checks.
  _ganttActive(): boolean {
    if (!Timeline._ganttTab) Timeline._ganttTab = document.getElementById('gantt-tab');
    return Timeline._ganttTab ? Timeline._ganttTab.classList.contains('active') : false;
  },

  _windowSpanMs(): number { if (!Timeline._tl) return 0; const w = Timeline._tl.getWindow(); return w.end.getTime() - w.start.getTime(); },
  _centerWidthPx(): number {
    const w = (Timeline._tl as unknown as VisInternalTimeline | null)?.body?.domProps?.center?.width;
    if (typeof w === 'number' && w > 0) return w;
    return Timeline._visEl?.querySelector<HTMLElement>('.vis-panel.vis-center')?.clientWidth ?? 0;
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
      // Mirrors App._scrollMemory.clear() on plant change — start the new
      // plant's Gantt at the top rather than wherever the old plant left off.
      Timeline.resetVScroll();
      if (Timeline._ganttActive()) {
        // The mask stays up through the plant's /tasks load — hide is gated
        // on Persistence.isLoading() in rebuild's rAF, which runs after the
        // shell's Persistence.loadForPlant subscriber has already started
        // the load for this same event.
        Timeline.showLoadingMask();
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
        // Keep the past-edge bound fresh: a drag/optimize patch here (no full
        // rebuild) can move the earliest order earlier, and _applyTimeBounds()
        // is one O(n) pass over the plant's tasks — cheap enough to run
        // unconditionally rather than diffing whether this batch touched the
        // current oldest order.
        Timeline._applyTimeBounds();
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
    const patch = Timeline._itemsForTask(t)[0] || null;
    // _itemForTask (via _itemsForTask) builds className fresh, with no
    // knowledge of the sibling highlight (D51) — restore it here so a
    // single-item patch (e.g. a drag commit) doesn't silently drop
    // .dist-sibling off an item that was highlighted before the patch.
    if (patch && Interaction._distSiblingItemIds.has(String(patch.id))) {
      const cls = patch.className || '';
      if (!cls.split(' ').includes('dist-sibling')) {
        patch.className = cls ? `${cls} dist-sibling` : 'dist-sibling';
      }
    }
    return patch;
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

  /** Add/strip `.goto-target` on every live item of one order (all split segments)
   *  through the suppressed-update pattern of `_applyDistSiblingHighlight`. */
  _setGotoClass(taskId: string, on: boolean): void {
    if (!Timeline._items) return;
    const updates: Array<{ id: string; className: string }> = [];
    for (const itemId of Timeline.itemIdsForTask(taskId)) {
      const item = Timeline._items.get(itemId) as TimelineVisItem | null;
      if (!item) continue;
      const parts = (item.className || '').split(' ').filter(Boolean);
      const has = parts.includes('goto-target');
      if (on === has) continue;
      updates.push({ id: itemId, className: (on ? [...parts, 'goto-target'] : parts.filter(c => c !== 'goto-target')).join(' ') });
    }
    if (!updates.length) return;
    Timeline._suppressEvents = true;
    try { Timeline._items.update(updates); } finally { Timeline._suppressEvents = false; }
  },

  /** "Go To" pulse: ring the order (every segment) for GOTO_FLASH_MS, then drop back to the
   *  plain selection look. State lives in `_gotoFlash` so rebuilds re-apply it. */
  flashTarget(taskId: string | number): void {
    const id = String(taskId);
    const prev = Timeline._gotoFlash;
    if (Timeline._gotoFlashTimer) clearTimeout(Timeline._gotoFlashTimer);
    Timeline._gotoFlash = { taskId: id, until: Date.now() + Timeline.GOTO_FLASH_MS };
    if (prev && prev.taskId !== id) Timeline._setGotoClass(prev.taskId, false);
    Timeline._setGotoClass(id, true);
    Timeline._gotoFlashTimer = setTimeout(() => {
      Timeline._gotoFlashTimer = null;
      const cur = Timeline._gotoFlash;
      Timeline._gotoFlash = null;
      if (cur) Timeline._setGotoClass(cur.taskId, false);
    }, Timeline.GOTO_FLASH_MS + 100);   // +100ms so the last pulse completes before the class is stripped
  },
  GOTO_FLASH_MS: 2500,

  /** Build an item object for a task. */
  _itemForTask(t: NimbusTask): TimelineVisItem {
    const line = t.MACHINE || 'Unknown';
    const firmed = Engine.firmingStatus(t, Timeline._nowFor(t)).firmed;
    const conflict = Timeline._conflictIds().has(String(t.id));
    const label = t.text || t.ORDER || String(t.id);
    const cls = [firmed ? 'order-firmed' : 'order-standard'];
    if (conflict) cls.push('conflict-order');
    // "Go To" pulse (flashTarget): lives in className like the dimming below, so a rebuild
    // or single-item patch that rebuilds the item keeps it until the flash expires.
    const flash = Timeline._gotoFlash;
    if (flash && flash.taskId === String(t.id) && Date.now() < flash.until) cls.push('goto-target');
    // Filter dimming lives in className, which this builder recomputes on every rebuild —
    // without re-applying it here a rebuild (plant/line change, bulk edit) silently un-dimmed
    // every bar until the next filter tweak.
    if (GanttFilter.isActive() && !GanttFilter.matches(t)) cls.push('dimmed');
    // Distribution marker (decision M, aggregate_to_detail.md §8): every child
    // of a distributed SAP order (bare 100% child included) gets the inset
    // keyline via dist-child; a lettered child additionally gets the
    // letter·count pill, count = currently-living siblings sharing PARENT_ORDER.
    if (t.PARENT_ORDER) cls.push('dist-child');
    const prefix = firmed ? '🔒 ' : '';
    let distPart = '';
    if (t.PARENT_ORDER && t.DISTRIBUTION_LETTER) {
      const count = (Store.siblingsByParent().get(t.PARENT_ORDER) || []).length;
      distPart = `<span class="split-order-part dist-part">${Util.escapeHtml(t.DISTRIBUTION_LETTER)}·${count}</span>`;
    }
    return {
      id:      String(t.id),
      group:   line,
      kind:    'order',
      content: `<span style="padding:0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;">${prefix}${label}${distPart}</span>`,
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
    // U26: every order of this pass reads its plant's clock; resolve each plant once, not once per order.
    Timeline._clockMemo = new Map();
    try { Timeline._rebuildPass(); } finally { Timeline._clockMemo = null; }
  },

  _rebuildPass(): void {
    if (!Timeline._items || !Timeline._groups) return;
    const _pmT0t = performance.now();
    Timeline._renderEmptyOverlay();
    // Save the current viewport so groups.clear() + re-add doesn't auto-fit.
    const savedWindow = Timeline._tl ? Timeline._tl.getWindow() : null;
    // Capture whatever vertical position the user is actually at right now
    // (before the group/item diff below can shrink content and clamp it) —
    // this is what _vScrollTop gets re-applied to at the end of rebuild(),
    // so a plain re-render preserves position same as before. Only capture
    // when the Gantt is actually laid out: a hidden rebuild (e.g. App's
    // _repaintDisplayFormat running from another tab, or Inspector's
    // _refreshSetupTruth) would otherwise read vis's hidden-clamped 0 and
    // clobber a good remembered value. And skip it entirely when a
    // save-on-leave/reset has already pinned _vScrollTop to the value the
    // next visible rebuild must restore — an explicit navigation between now
    // and the restore below (scrollToLine et al.) still overwrites _vScrollTop
    // directly and wins, since it runs later.
    if (Timeline._tl && !Timeline._vScrollRestorePending && Timeline._vScrollLaidOut()) {
      Timeline._vScrollTop = Timeline._getVScroll();
    }
    const all = Store.tasksForSelectedPlant();
    const tasks = all.filter(t => t.start_date && t.end_date);
    // Queued (needs_planning) rows with no dates are intentionally absent from
    // the Gantt; only warn for scheduled or one-sided-dated rows.
    const dropped = all.filter(t => !(t.start_date && t.end_date)
      && !(t.planning_status === 'needs_planning' && !t.start_date && !t.end_date)).length;
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
    // The viewer's clock for this pass (the timeline's min bound reads it). Firming/lock styling and the
    // zone bands read the PLANT's clock instead (_nowFor / _plantNow: the one clock, OQ52).
    Timeline._rebuildNow = new Date();
    const desired = new Map<string, TimelineVisItem>();
    // Non-working-time shading goes in FIRST: this pass's full diff must keep exactly what the pan path
    // (_syncNonWorking) maintains, from the same single range state. Ungrouped background items.
    {
      const _pmT0nw = performance.now();
      if (!Timeline._nwRange) {
        const w = Timeline._tl ? Timeline._tl.getWindow() : null;
        Timeline._nwRange = w
          ? Timeline._nwRangeAround(w.start.getTime(), w.end.getTime())
          : Timeline._nwRangeAround(Date.now() - 45 * Config.MS_DAY, Date.now() + 45 * Config.MS_DAY);
      }
      for (const item of Timeline._nonWorkingDesired(Timeline._nwRange)) desired.set(item.id, item);
      PerfMonitor.record('Timeline.rebuild.nonworking', performance.now() - _pmT0nw);
    }
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
    const pastEnd = Timeline._plantNow(plant);
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
        const hzNow = Timeline._plantNow(plant);
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
        const frozenNow = Timeline._plantNow(plant);
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
    // Every zone was just rewritten with a fresh "now": the first ticker tick re-establishes the push baseline.
    Timeline._zonePushedMs = 0; Timeline._zoneEdgeKey = '';

    // P2: snapshot which tasks are currently inside the frozen-horizon band so
    // the 1s ticker's coarse 30s scan (below) can diff against a known-good
    // baseline instead of recomputing membership from scratch every tick.
    {
      const bandIds = new Set<string>();
      for (const t of scopedTasks) if (Timeline._inLockBand(t)) bandIds.add(String(t.id));
      Timeline._frozenBandIds = bandIds;
    }

    // C1 (2026-08-20): plant visibility horizon — clamp the vis-timeline `max`
    // option to the far edge the backend already computed and sent down in
    // GET /tasks' meta (Store.visibilityHorizonEnd; see schedule-data.mts and
    // db.compute_visibility_horizon_end). This is an ADDITIONAL bound on top
    // of the zoomMin/zoomMax options set at init() — those cap how far the
    // user can zoom OUT, this caps the latest instant they can pan/zoom TO.
    // C1 follow-up (2026-09-09): the past edge is now bounded too, via the
    // same setOptions() call — see _applyTimeBounds(). `min` clamps at local
    // midnight of the oldest order on the plant (or today, whichever is
    // earlier), so today's midnight stays reachable even with no orders or
    // an all-future plant. Both bounds are applied together so they can
    // never end up inverted (computeTimelineMinBound() itself guards that).
    if (Timeline._tl) {
      Timeline._applyTimeBounds();

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
    Timeline._nwIds = new Set([...desired.keys()].filter(id => id.startsWith('nonworking-')));
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
      // D51: the items just written above came from _itemForTask, which builds
      // className fresh with no knowledge of the sibling highlight — any item
      // that had .dist-sibling lost it. Reset the tracked set and recompute
      // from the just-resynced selection so the highlight survives a rebuild.
      Interaction._distSiblingItemIds = new Set();
      Interaction._applyDistSiblingHighlight(keep);
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
    // filter may hold a stale window (setOptions({max, min}) via _applyTimeBounds()
    // above can clamp the range without firing rangechanged — both bounds clamp
    // silently the same way — and the setWindow restore is a same-range no-op
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
    // honoured on every rebuild instead of only the first. Always scheduled
    // (not gated on visibleLines.length) because the mask-hide/pending-clear
    // below must run on every rebuild, hidden or not — a hidden rebuild bails
    // inside the rAF itself instead.
    requestAnimationFrame(() => {
      if (!Timeline._tl || !Timeline._vScrollLaidOut()) return; // hidden rebuild: don't apply, don't clear the flag, don't touch the mask
      if (visibleLines.length) Timeline._setVScroll(Timeline._vScrollTop);
      Timeline._vScrollRestorePending = false;
      if (!Persistence.isLoading()) Timeline.hideLoadingMask(); // a rebuild during an in-flight /tasks load leaves the mask up until the tasks:bulk rebuild that follows
    });
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

  // C1 follow-up (2026-09-09): recompute and apply both vis-timeline time
  // bounds together — `max` at the plant's visibility horizon (unchanged
  // since 2026-08-20) and `min` at local midnight of the oldest order on the
  // plant, or today, whichever is earlier (computeTimelineMinBound(),
  // ~line 1527). Scoped to ALL orders on the selected plant (not
  // line-filtered), so the bound stays stable when the Gantt line filter
  // changes. Plain for-loop, not Math.min(...spread) — same call-stack/scale
  // hazard called out at gantt.mts:1350-1352 for large task arrays. Called
  // from rebuild() and again after tasks:bulkUpdate patches (_onStore) so a
  // drag/optimize that moves the earliest order earlier keeps the bound
  // fresh without a full rebuild.
  _applyTimeBounds(): void {
    if (!Timeline._tl) return;
    let dataMinMs: number | null = null;
    for (const t of Store.tasksForSelectedPlant()) {
      if (!t.start_date) continue;
      const s = new Date(t.start_date).getTime();
      if (dataMinMs === null || s < dataMinMs) dataMinMs = s;
    }
    const nowMs = (Timeline._rebuildNow || new Date()).getTime();
    const maxMs = Store.visibilityHorizonEnd ? Store.visibilityHorizonEnd.getTime() : null;
    Timeline._tl.setOptions({
      max: Store.visibilityHorizonEnd,
      min: computeTimelineMinBound({ dataMinMs, nowMs, maxMs }),
    });
  },

  // Non-working-time shading (W5). The visible range plus a margin of max(window, 7 days) each side.
  _nwRangeAround(windowStartMs: number, windowEndMs: number): { fromMs: number; toMs: number } {
    const margin = Math.max(windowEndMs - windowStartMs, 7 * Config.MS_DAY);
    return { fromMs: windowStartMs - margin, toMs: windowEndMs + margin };
  },

  // PURE: the 'nonworking-*' items for a range, from the selected plant's PLANT pattern only (not the
  // per-line hours). Ungrouped background items (vis's reserved BackgroundGroup spans every row and
  // _healBackgroundBands skips ungrouped items, like day-gridline-*); kind:'zone' keeps the minimap's
  // _items subscriber out. A span starting at local midnight is 'nonworking-<dayKey>'; the one that starts
  // at an off-shift tail (window end) is 'nonworking-<dayKey>-t', so a day's head and tail never collide.
  _nonWorkingDesired(range: { fromMs: number; toMs: number }): TimelineVisItem[] {
    const plant = Store.selectedPlant;
    if (!plant) return [];
    Store.ensurePlant(plant);
    // Unreachable at the current zoomMax (30 d): the covered range is window + 2 * max(window, 7 d) <= 90 d. Kept
    // deliberately as a guard for a future larger zoomMax.
    const coarse = range.toMs - range.fromMs > 90 * Config.MS_DAY;
    const { spans, truncated } = buildNonWorkingSpans(
      range.fromMs, range.toMs,
      (day: Date) => Calendar.plantWorkWindow(plant, day),
      { closedDaysOnly: coarse, cap: 600 });
    if (truncated) {
      if (!Timeline._nwTruncWarned) {
        Timeline._nwTruncWarned = true;
        ErrorLog.warn('timeline', 'Non-working shading truncated at 600 spans; the far end of the range is not shaded');
      }
    } else Timeline._nwTruncWarned = false;
    return spans.map(span => {
      const s = span.start;
      const atMidnight = s.getHours() === 0 && s.getMinutes() === 0 && s.getSeconds() === 0 && s.getMilliseconds() === 0;
      return {
        id:        `nonworking-${Util.dayKey(s)}${atMidnight ? '' : '-t'}`,
        kind:      'zone' as const,
        start:     span.start,
        end:       span.end,
        type:      'background' as const,
        className: 'nonworking',
        editable:  false,
      };
    });
  },

  // Pan path: re-diff only the 'nonworking-*' ids when the window nears the edge of the covered range
  // (hysteresis: a window still inside [from + margin/2, to - margin/2] changes nothing). One batched
  // remove/update/add inside _suppressEvents; only changed/new/stale ids are written.
  _syncNonWorking(force = false): void {
    if (!Timeline._tl || !Timeline._items) return;
    const _pmT0 = performance.now();
    const w = Timeline._tl.getWindow();
    const ws = w.start.getTime(), we = w.end.getTime();
    const margin = Math.max(we - ws, 7 * Config.MS_DAY);
    const cur = Timeline._nwRange;
    // Granularity of the built range vs the one this window would produce (same >90-day rule as
    // _nonWorkingDesired): a zoom across the threshold must rebuild even while the window sits inside the band.
    const granularityFlipped = !!cur && ((cur.toMs - cur.fromMs) > 90 * Config.MS_DAY) !== ((we - ws + 2 * margin) > 90 * Config.MS_DAY);
    if (!force && cur && !granularityFlipped && ws >= cur.fromMs + margin / 2 && we <= cur.toMs - margin / 2) return;
    Timeline._nwRange = { fromMs: ws - margin, toMs: we + margin };
    const desired = new Map<string, TimelineVisItem>();
    for (const item of Timeline._nonWorkingDesired(Timeline._nwRange)) desired.set(item.id, item);
    const toRemove: string[] = [], toUpdate: TimelineVisItem[] = [], toAdd: TimelineVisItem[] = [];
    for (const id of Timeline._nwIds) if (!desired.has(id)) toRemove.push(id);
    for (const [id, item] of desired) {
      if (!Timeline._nwIds.has(id)) { toAdd.push(item); continue; }
      const old = Timeline._items.get(id) as TimelineVisItem | null;
      if (!old) toAdd.push(item);
      else if (+old.start !== +item.start || +old.end !== +item.end) toUpdate.push(item);
    }
    Timeline._suppressEvents = true;
    try {
      if (toRemove.length) Timeline._items.remove(toRemove);
      if (toUpdate.length) Timeline._items.update(toUpdate);
      if (toAdd.length)    Timeline._items.add(toAdd);
    } finally {
      Timeline._suppressEvents = false;
    }
    Timeline._nwIds = new Set(desired.keys());
    PerfMonitor.record('Timeline.nonworking.sync', performance.now() - _pmT0);
  },

  // Undebounced core of the rangechanged refresh: resync the DataView culling
  // window to the timeline's actual range, fully re-evaluate the filter (an item
  // excluded while _viewWindow was stale stays excluded until a refresh — vis-data
  // DataViews filter incrementally at add/update time), and force a relayout.
  _refreshViewNow(): void {
    if (!Timeline._tl || !Timeline._visItems) return;
    const _pmT0 = performance.now();
    const w = Timeline._tl.getWindow();
    Timeline._viewWindow = { start: w.start.getTime(), end: w.end.getTime() };
    Timeline._visItems.refresh();
    Timeline._tl.redraw();
    PerfMonitor.record('Timeline.refreshView', performance.now() - _pmT0);
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
    document.querySelectorAll<HTMLElement>('#gantt-zoom-controls .seg-btn[data-view]').forEach(b => {
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
    // vis's _setScrollTop convention is NEGATIVE (0 = top; any positive value
    // is clamped straight to the top), so targetY — a positive "px down from
    // top" — must be negated, or this always lands on the top row regardless
    // of lineIdx.
    Timeline._vScrollTop = -targetY;
    Timeline._setVScroll(-targetY);
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
        document.querySelectorAll<HTMLElement>('#gantt-zoom-controls .seg-btn[data-view]').forEach(b => {
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
   TIMELINE NAV — pure geometry helpers (exported for tests; no DOM, no Store)
   ========================================================================== */
export const NAV_MIN_H = 42;          // strip height floor (px) — matches #timeline-nav CSS min-height
export const NAV_MAX_H = 72;          // strip height ceiling (px) — matches #timeline-nav CSS max-height
export const NAV_LABEL_H = 12;        // bottom day-label scrim height (px)
export const NAV_MIN_ROW_PX = 2;      // smallest legible per-line row; below this the strip switches to histogram mode
export const NAV_ROW_TARGET_PX = 3;   // preferred per-line row height when the strip can grow

export interface NavRange { startMs: number; endMs: number; dayStarts: number[] }
export interface NavRangeInput {
  dataMinMs: number | null; dataMaxMs: number | null;
  windowStartMs: number; windowEndMs: number;
  nowMs: number; horizonEndMs: number | null;
}
export type NavBarStyle = 'standard' | 'firmed' | 'conflict' | 'dimmed';
export interface NavLayout { mode: 'rows' | 'histogram'; stripH: number; bodyH: number; rowH: number }

function _navLocalMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function _navAddDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function navComputeRange(i: NavRangeInput): NavRange {
  const today = _navLocalMidnight(i.nowMs);
  let lo = Math.min(i.dataMinMs ?? i.nowMs, today, i.windowStartMs);
  lo = _navAddDays(_navLocalMidnight(lo), -1);

  let hi = Math.max(i.dataMaxMs ?? i.nowMs, _navAddDays(today, 14), i.windowEndMs);
  if (i.horizonEndMs != null) {
    hi = Math.min(hi, i.horizonEndMs);
    hi = Math.max(hi, i.windowEndMs);
  }

  let m = _navLocalMidnight(hi);
  if (m < hi) m = _navAddDays(m, 1);
  hi = m;

  if (hi <= lo) hi = _navAddDays(lo, 1);

  const dayStarts: number[] = [];
  let d = lo;
  while (d < hi && dayStarts.length < 800) {
    dayStarts.push(d);
    d = _navAddDays(d, 1);
  }

  return { startMs: lo, endMs: hi, dayStarts };
}

export interface TimelineMinBoundInput { dataMinMs: number | null; nowMs: number; maxMs?: number | null }

// C1 follow-up (2026-09-09): the earliest instant the Gantt should let a
// planner pan/zoom to — local midnight of whichever is earlier, the oldest
// order on the plant or "today" (so today's midnight is always reachable
// even when every order is in the future or the plant has no orders at all —
// setView()/gotoNow() all anchor there, gantt.mts:1310-1328). Never returns
// an instant that would invert min/max: if the caller's `maxMs` is at or
// before the computed bound, return null and leave the past unbounded in
// that degenerate case.
export function computeTimelineMinBound(i: TimelineMinBoundInput): number | null {
  const bound = _navLocalMidnight(Math.min(i.dataMinMs ?? i.nowMs, i.nowMs));
  if (i.maxMs != null && bound >= i.maxMs) return null;
  return bound;
}

/** OQ1 live veto for the Gantt's left resize handle: a drag that changes an item's start but not its end puts
 *  the stored start back (the start is derived from the finish, so the left edge is not an input). Any other
 *  drag (right edge, whole bar, vertical move) is accepted untouched. Returns the item vis should keep. */
export function lockLeftEdge(item: TimelineVisItem, stored: TimelineVisItem | null): TimelineVisItem {
  if (!stored || !item.start || !item.end || !stored.start || !stored.end) return item;
  const sameEnd = new Date(item.end).getTime() === new Date(stored.end).getTime();
  const movedStart = new Date(item.start).getTime() !== new Date(stored.start).getTime();
  return sameEnd && movedStart ? { ...item, start: stored.start } : item;
}

export interface TickerPushInput { nowMs: number; lastPushedMs: number; windowMs: number; centerPx: number; minPx?: number }
/** True when the zone bands should be rewritten this tick: never pushed yet, clock stepped back,
 *  unusable scale (push, i.e. legacy behavior), or "now" has moved >= minPx at the current scale. */
export function tickerShouldPush(i: TickerPushInput): boolean {
  if (!(i.lastPushedMs > 0) || i.nowMs < i.lastPushedMs) return true;
  if (!(i.windowMs > 0) || !(i.centerPx > 0)) return true;
  return (i.nowMs - i.lastPushedMs) * i.centerPx / i.windowMs >= (i.minPx ?? _ZONE_MIN_PX);
}

export function navLayout(lineCount: number): NavLayout {
  const n = Math.max(0, Math.floor(lineCount));
  const bodyAvail = NAV_MAX_H - NAV_LABEL_H;

  if (n > 0 && n * NAV_MIN_ROW_PX > bodyAvail) {
    return { mode: 'histogram', stripH: NAV_MIN_H, bodyH: NAV_MIN_H - NAV_LABEL_H, rowH: 0 };
  }

  const stripH = Math.min(NAV_MAX_H, Math.max(NAV_MIN_H, NAV_LABEL_H + n * NAV_ROW_TARGET_PX));
  const bodyH = stripH - NAV_LABEL_H;
  const rowH = n > 0 ? Math.floor(bodyH / n) : 0;
  return { mode: 'rows', stripH, bodyH, rowH };
}

export function navBarStyle(className: string | undefined): NavBarStyle {
  const cls = (className || '').split(/\s+/);
  if (cls.includes('dimmed')) return 'dimmed';
  if (cls.includes('conflict-order')) return 'conflict';
  if (cls.includes('order-firmed')) return 'firmed';
  return 'standard';
}

export function navClampRect(x1: number, x2: number, cssW: number): { x1: number; x2: number } {
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (x2 <= 0) return { x1: 0, x2: 0 };
  if (x1 >= cssW) return { x1: cssW, x2: cssW };
  return { x1: Math.max(0, x1), x2: Math.min(cssW, x2) };
}

/* =============================================================================
   TIMELINE NAV — minimap strip above the Gantt. A faithful *projection* of
   Timeline._items + Timeline._visibleLines(): same bars (order/order-segment,
   including split-order segments), same row order, same firmed/conflict/
   dimmed className state the Gantt renders — this module never re-derives
   the task/line filter chain itself, it only reads what Timeline already
   built. Repaints are rAF-coalesced through a single _frame() (same
   precedent as Timeline._scheduleRebuild) so a pan or a burst of Store
   events produces at most one repaint per animation frame instead of one
   per event/frame.

   Two rules on the `Timeline._items.on('*')` subscriber, both load-bearing:
     - skip an event when every changed id resolves to kind:'zone' — the 1s
       live ticker (Timeline.init's setInterval, ~line 291) advances the
       past-zone/alert-horizon-zone/frozen-horizon-zone bands every second,
       none of which this minimap ever draws, so reacting to it would
       repaint the strip once a second for no visible reason;
     - never gate on Timeline._suppressEvents — GanttFilter._doApply sets
       that flag around exactly the className dim/undim batch update this
       subscriber exists to catch (a pure className patch fires no Store
       event at all), so skipping while it's set would make the nav miss
       every color/form/PO-MAT filter toggle.

   The viewport rect is painted as a scrim *outside* the window (not a rect
   drawn on top of it) with a plain --fg stroke — deliberately not --accent,
   which is the same hex as --bar-standard in light mode and would visually
   merge with a standard order bar sitting under the window's edge.

   Pure geometry (navComputeRange/navLayout/navBarStyle/navClampRect) lives
   just above this block and is exported for tests; everything below is the
   stateful controller that calls those helpers once per frame.
   ========================================================================== */
interface _NavBarModel {
  rowIdx: number;
  startMs: number;
  endMs: number;
  style: NavBarStyle;
  firmed: boolean;   // independent of `style` — a conflict bar still needs to know its base color
}
interface _NavBlackoutModel {
  rowIdx: number | 'all';
  startMs: number;
  endMs: number;
}
interface _NavTheme {
  bg: string; closedFill: string; warnFill: string; errFill: string;
  barStandard: string; barFirmed: string; dimFill: string; dividerColor: string;
  labelScrim: string; labelText: string; fontMono: string; accent: string; fg: string;
}
interface _NavModel {
  range: NavRange;
  layout: NavLayout;
  bars: _NavBarModel[];
  blackouts: _NavBlackoutModel[];
  alertByDay: Map<number, 'warn' | 'err'>;   // key = index into range.dayStarts
  closedDay: boolean[];                       // parallel to range.dayStarts
  histAll: Float64Array | null;               // histogram mode only — share of rows busy per day
  histActive: Float64Array | null;            // same, excluding dimmed bars
  nowMs: number;
  theme: _NavTheme;
}
interface _NavGesture {
  pointerId: number;
  startX: number;
  startWin: TimelineWindowMs;
  moved: boolean;
}

export const TimelineNav = {
  _canvas:    null as HTMLCanvasElement | null,
  _ctx:       null as CanvasRenderingContext2D | null,
  _container: null as HTMLElement | null,
  _dirty:     true,
  _rafId:     null as number | null,
  _model:     null as _NavModel | null,
  _lastCssW:  0,
  _lastCssH:  0,
  _lastDpr:   0,
  _itemsSubAttached: false,
  _tlHooked:  false,
  _unsubStore: null as (() => void) | null,
  _resizeObserver: null as ResizeObserver | null,
  _tickInterval: null as ReturnType<typeof setInterval> | null,
  _gesture:     null as _NavGesture | null,
  _frozenRange: null as NavRange | null,

  init(): void {
    if (TimelineNav._canvas) return; // idempotent — never double-wire listeners/intervals
    const el = document.getElementById('timeline-nav');
    if (!el) return;
    TimelineNav._container = el;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', Util.t('ui.nav_aria_label'));
    el.appendChild(canvas);
    TimelineNav._canvas = canvas;
    TimelineNav._ctx    = canvas.getContext('2d');

    TimelineNav._wirePointerEvents(canvas);
    TimelineNav._wireTimelineHooks();

    TimelineNav._unsubStore = Store.subscribe(evt => {
      switch (evt.type) {
        case 'lines:selected':
        case 'plant:selected':
        case 'alerts:change':
        case 'blocks:change':
        case 'plantBlocks:change':
        case 'calendar:change':
        case 'settings:change':
        case 'tasks:bulk':
          TimelineNav._dirty = true;
          TimelineNav._scheduleFrame();
          break;
        default: break;
      }
    }, 'TimelineNav');

    if (typeof ResizeObserver !== 'undefined') {
      TimelineNav._resizeObserver = new ResizeObserver(() => TimelineNav._scheduleFrame());
      TimelineNav._resizeObserver.observe(el);
    } else {
      window.addEventListener('resize', Util.debounce(() => TimelineNav.render(), 100));
    }

    // Now-marker advance — skip while the tab is backgrounded (mirrors the
    // live ticker's own document.hidden guard at ~line 292).
    TimelineNav._tickInterval = setInterval(() => {
      if (document.hidden) return;
      TimelineNav._scheduleFrame();
    }, 60_000);

    TimelineNav._dirty = true;
    TimelineNav._scheduleFrame();
  },

  render(): void {
    TimelineNav._dirty = true;
    TimelineNav._scheduleFrame();
  },

  _scheduleFrame(): void {
    if (TimelineNav._rafId != null) return;
    TimelineNav._rafId = requestAnimationFrame(() => {
      TimelineNav._rafId = null;
      TimelineNav._frame();
    });
  },

  // Timeline.init() runs before TimelineNav.init() (app.js boot order), but
  // retry across a handful of frames anyway rather than assume it — same
  // bounded-retry precedent as Timeline.gotoLineDay's scrollToLine loop
  // (~line 1460).
  _wireTimelineHooks(): void {
    if (TimelineNav._tlHooked) return;
    if (!Timeline._tl) {
      let attempts = 0;
      const MAX_ATTEMPTS = 20;
      const tryHook = (): void => {
        if (Timeline._tl) { TimelineNav._wireTimelineHooks(); return; }
        if (++attempts < MAX_ATTEMPTS) requestAnimationFrame(tryHook);
      };
      requestAnimationFrame(tryHook);
      return;
    }
    TimelineNav._tlHooked = true;
    Timeline._tl.on('rangechange',  () => TimelineNav._scheduleFrame());
    Timeline._tl.on('rangechanged', () => TimelineNav._scheduleFrame());
  },

  // Attached lazily the first time _frame() sees Timeline._items non-null —
  // Timeline._items is created inside Timeline.init(), so this can't be
  // wired eagerly at TimelineNav.init() time with certainty either.
  _wireItemsSubscription(): void {
    if (TimelineNav._itemsSubAttached || !Timeline._items) return;
    TimelineNav._itemsSubAttached = true;
    Timeline._items.on('*', (ev, props) => {
      if (ev !== 'remove') {
        const ids = props?.items ?? [];
        const allZone = ids.length > 0 && ids.every(id => {
          const item = Timeline._items!.get(id) as TimelineVisItem | null;
          return item != null && item.kind === 'zone';
        });
        if (allZone) return;
      } else {
        // A remove event's items are already gone from the set, so the lookup above cannot classify them;
        // vis-data's remove payload carries the removed records as `oldData` (verified in the 7.7.3
        // bundle). The non-working shading's pan re-diff removes zone-only batches — skip those; when
        // oldData is absent, fall through to the repaint.
        const old = (props as { oldData?: Array<TimelineVisItem | null | undefined> } | null)?.oldData;
        if (Array.isArray(old) && old.length > 0 && old.every(item => item != null && item.kind === 'zone')) return;
      }
      TimelineNav._dirty = true;
      TimelineNav._scheduleFrame();
    });
  },

  _wirePointerEvents(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0 || !Timeline._tl) return;
      const w = Timeline._tl.getWindow();
      TimelineNav._frozenRange = TimelineNav._model?.range ?? null;
      TimelineNav._gesture = {
        pointerId: e.pointerId,
        startX: e.offsetX,
        startWin: { start: w.start.getTime(), end: w.end.getTime() },
        moved: false,
      };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
      canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', (e: PointerEvent) => {
      const g = TimelineNav._gesture;
      if (g && g.pointerId === e.pointerId) {
        const dx = e.offsetX - g.startX;
        if (!g.moved && Math.abs(dx) < 3) return;
        g.moved = true;
        if (!Timeline._tl) return;
        const range = TimelineNav._frozenRange ?? TimelineNav._model?.range ?? null;
        if (!range) return;
        const cssW = canvas.offsetWidth || 1;
        const msPerPx = (range.endMs - range.startMs) / cssW;
        Timeline._tl.setWindow(new Date(g.startWin.start + dx * msPerPx), new Date(g.startWin.end + dx * msPerPx));
        return;
      }
      // Hover (no active gesture): native-tooltip date + grab/pointer cursor.
      const range = TimelineNav._model?.range ?? null;
      if (!range) return;
      const cssW = canvas.offsetWidth || 1;
      const ms = range.startMs + (e.offsetX / cssW) * (range.endMs - range.startMs);
      try { canvas.title = Util._fmtDatePref(new Date(ms)); } catch { canvas.title = new Date(ms).toLocaleDateString(); }
      if (Timeline._tl) {
        const win = Timeline._tl.getWindow();
        const totalMs = (range.endMs - range.startMs) || 1;
        const x1raw = ((win.start.getTime() - range.startMs) / totalMs) * cssW;
        const x2raw = ((win.end.getTime()   - range.startMs) / totalMs) * cssW;
        const { x1, x2 } = navClampRect(x1raw, x2raw, cssW);
        canvas.style.cursor = (e.offsetX >= x1 && e.offsetX <= x2) ? 'grab' : 'pointer';
      }
    });

    // Structurally removes the old "drag ends with a recenter jump" bug and
    // the stuck-_dragging hazard: a gesture that never crossed the 3px
    // threshold recenters on release; one that did just... stops, wherever
    // the drag left the window.
    const endGesture = (e: PointerEvent): void => {
      const g = TimelineNav._gesture;
      if (!g || g.pointerId !== e.pointerId) return;
      if (!g.moved && Timeline._tl) {
        const range = TimelineNav._frozenRange ?? TimelineNav._model?.range ?? null;
        if (range) {
          const cssW = canvas.offsetWidth || 1;
          const c = range.startMs + (e.offsetX / cssW) * (range.endMs - range.startMs);
          const win = Timeline._tl.getWindow();
          const half = (win.end.getTime() - win.start.getTime()) / 2;
          Timeline._tl.setWindow(new Date(c - half), new Date(c + half), { animation: { duration: 150 } });
        }
      }
      TimelineNav._gesture = null;
      TimelineNav._frozenRange = null;
      TimelineNav._dirty = true;
      TimelineNav._scheduleFrame();
      canvas.style.cursor = 'pointer';
    };
    canvas.addEventListener('pointerup', endGesture);
    canvas.addEventListener('pointercancel', endGesture);
    canvas.addEventListener('lostpointercapture', endGesture);
    canvas.addEventListener('pointerleave', () => { canvas.title = ''; });
  },

  _frame(): void {
    const canvas = TimelineNav._canvas;
    if (!canvas || !TimelineNav._ctx || canvas.offsetWidth === 0) return; // tab hidden — _dirty stays set for the next wake
    TimelineNav._wireItemsSubscription();

    const win = Timeline._tl ? Timeline._tl.getWindow() : null;
    const leftRange = !!(win && TimelineNav._model && !TimelineNav._gesture &&
      (win.start.getTime() < TimelineNav._model.range.startMs || win.end.getTime() > TimelineNav._model.range.endMs));

    if (TimelineNav._dirty || !TimelineNav._model || leftRange) {
      TimelineNav._dirty = false;
      TimelineNav._model = TimelineNav._collect();
    }

    const model = TimelineNav._model!;
    const container = TimelineNav._container;
    if (container && Math.round(container.getBoundingClientRect().height) !== model.layout.stripH) {
      container.style.height = model.layout.stripH + 'px';
      Timeline.redraw();
    }

    TimelineNav._ensureSize();
    TimelineNav._paint(model);
  },

  _ensureSize(): void {
    const canvas = TimelineNav._canvas!;
    const ctx    = TimelineNav._ctx!;
    const dpr  = window.devicePixelRatio || 1;
    const cssW = canvas.offsetWidth  || 1;
    const cssH = canvas.offsetHeight || NAV_MIN_H;
    if (cssW !== TimelineNav._lastCssW || cssH !== TimelineNav._lastCssH || dpr !== TimelineNav._lastDpr) {
      canvas.width  = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      TimelineNav._lastCssW = cssW;
      TimelineNav._lastCssH = cssH;
      TimelineNav._lastDpr  = dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },

  _dayIndexFor(ms: number, dayStarts: number[]): number {
    let lo = 0, hi = dayStarts.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dayStarts[mid] <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  },

  _dayMonthOrder(): 'D/M' | 'M/D' {
    try {
      const tok = Util._dateFormatPref();
      const firstOf = (chars: string): number => {
        for (let i = 0; i < tok.length; i++) if (chars.includes(tok[i])) return i;
        return -1;
      };
      const dIdx = firstOf('dj');
      const mIdx = firstOf('mnMF');
      if (dIdx >= 0 && (mIdx < 0 || dIdx < mIdx)) return 'D/M';
      return 'M/D';
    } catch { return 'M/D'; }
  },

  _collect(): _NavModel {
    const lines = Timeline._visibleLines();
    const rowOf = new Map<string, number>();
    lines.forEach((l, i) => rowOf.set(l, i));
    const rowCount = lines.length;

    const raw = Timeline._items ? Timeline._items.get() : null;
    const items: TimelineVisItem[] = Array.isArray(raw) ? raw : [];

    const bars: _NavBarModel[] = [];
    const blackouts: _NavBlackoutModel[] = [];
    let dataMinMs: number | null = null, dataMaxMs: number | null = null;

    for (const item of items) {
      if (item.kind === 'order' || item.kind === 'order-segment') {
        const g = item.group;
        if (g == null || !rowOf.has(g)) continue;
        const startMs = item.start.getTime(), endMs = item.end.getTime();
        const cls = (item.className || '').split(/\s+/);
        bars.push({
          rowIdx: rowOf.get(g)!,
          startMs, endMs,
          style: navBarStyle(item.className),
          firmed: cls.includes('order-firmed'),
        });
        if (dataMinMs == null || startMs < dataMinMs) dataMinMs = startMs;
        if (dataMaxMs == null || endMs   > dataMaxMs) dataMaxMs = endMs;
      } else if (item.kind === 'blackout') {
        const g = item.group;
        const rowIdx: number | 'all' = (g != null && rowOf.has(g)) ? rowOf.get(g)! : 'all';
        blackouts.push({ rowIdx, startMs: item.start.getTime(), endMs: item.end.getTime() });
      }
      // 'zone' and 'setup' items are never projected onto the minimap.
    }

    const nowMs = Date.now();
    const win = Timeline._tl ? Timeline._tl.getWindow() : null;
    const windowStartMs = win ? win.start.getTime() : nowMs;
    const windowEndMs   = win ? win.end.getTime()   : nowMs;
    const horizonEndMs  = Store.visibilityHorizonEnd?.getTime() ?? null;

    // While a drag gesture is active, reuse the range frozen at pointerdown
    // instead of recomputing — an unrelated Store event landing mid-drag
    // (e.g. a background alerts recompute) must not shift the range under
    // the user's hand.
    const range = (TimelineNav._gesture && TimelineNav._frozenRange)
      ? TimelineNav._frozenRange
      : navComputeRange({ dataMinMs, dataMaxMs, windowStartMs, windowEndMs, nowMs, horizonEndMs });

    const layout = navLayout(rowCount);

    const alertByDay = new Map<number, 'warn' | 'err'>();
    for (const a of Store.alerts) {
      if (!a.line || !rowOf.has(a.line)) continue;
      const t = a.time.getTime();
      if (t < range.startMs || t >= range.endMs) continue;
      const day = TimelineNav._dayIndexFor(t, range.dayStarts);
      if (day < 0) continue;
      if (a.sev === 'err' || !alertByDay.has(day)) alertByDay.set(day, a.sev);
    }

    // A day is closed only when NO visible line has a work window — early
    // exit on the first open line, so the typical cost is one call per day.
    const closedDay: boolean[] = new Array(range.dayStarts.length).fill(true);
    for (let i = 0; i < range.dayStarts.length; i++) {
      for (const line of lines) {
        try {
          if (Calendar.workWindow(line, new Date(range.dayStarts[i])) !== null) { closedDay[i] = false; break; }
        } catch { closedDay[i] = false; break; } // treat as open on error
      }
    }

    let histAll: Float64Array | null = null;
    let histActive: Float64Array | null = null;
    if (layout.mode === 'histogram' && rowCount > 0 && range.dayStarts.length > 0) {
      const dayCount = range.dayStarts.length;
      const bmpAll    = new Uint8Array(dayCount * rowCount);
      const bmpActive = new Uint8Array(dayCount * rowCount);
      for (const bar of bars) {
        let day = TimelineNav._dayIndexFor(Math.max(bar.startMs, range.startMs), range.dayStarts);
        if (day < 0) day = 0;
        while (day < dayCount && range.dayStarts[day] < bar.endMs) {
          const idx = day * rowCount + bar.rowIdx;
          bmpAll[idx] = 1;
          if (bar.style !== 'dimmed') bmpActive[idx] = 1;
          day++;
        }
      }
      histAll = new Float64Array(dayCount);
      histActive = new Float64Array(dayCount);
      for (let d = 0; d < dayCount; d++) {
        let sa = 0, sc = 0;
        const base = d * rowCount;
        for (let r = 0; r < rowCount; r++) { sa += bmpAll[base + r]; sc += bmpActive[base + r]; }
        histAll[d]    = sa / rowCount;
        histActive[d] = sc / rowCount;
      }
    }

    return { range, layout, bars, blackouts, alertByDay, closedDay, histAll, histActive, nowMs, theme: TimelineNav._readTheme() };
  },

  // Copy of Dashboard._cssVar (insights-ui.mts) — not imported, to avoid a
  // cross-domain edge for a 3-line helper; canvas can't use CSS var() so
  // colors are read from the real custom properties once per paint.
  _cssVar(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  },

  _readTheme(): _NavTheme {
    // Read once per data repaint (when _dirty) and cached on the model — never per frame; render() marks dirty so DarkMode's repaint hook still re-reads.
    return {
      bg: TimelineNav._cssVar('--bg-subtle', '#f4f7fa'),
      closedFill: TimelineNav._cssVar('--fg-faint', '#7d8da0'),
      warnFill: TimelineNav._cssVar('--warn', '#93610a'),
      errFill: TimelineNav._cssVar('--err', '#b02a20'),
      barStandard: TimelineNav._cssVar('--bar-standard', '#1f5fbf'),
      barFirmed: TimelineNav._cssVar('--bar-firmed', '#b02a20'),
      dimFill: TimelineNav._cssVar('--fg-faint', '#7d8da0'),
      dividerColor: TimelineNav._cssVar('--line', '#d5dce4'),
      labelScrim: TimelineNav._cssVar('--bg-subtle', '#f4f7fa'),
      labelText: TimelineNav._cssVar('--fg-mute', '#5b6b7c'),
      fontMono: TimelineNav._cssVar('--font-mono', '"JetBrains Mono", monospace'),
      accent: TimelineNav._cssVar('--accent', '#1f5fbf'),
      fg: TimelineNav._cssVar('--fg', '#1c2b3a'),
    };
  },

  _paint(model: _NavModel): void {
    const canvas = TimelineNav._canvas!;
    const ctx    = TimelineNav._ctx!;
    const cssW = canvas.offsetWidth  || 1;
    const cssH = canvas.offsetHeight || NAV_MIN_H;
    const { range, layout } = model;
    const totalMs = (range.endMs - range.startMs) || 1;
    const msToX = (ms: number): number => ((ms - range.startMs) / totalMs) * cssW;
    const bodyH = layout.bodyH;

    const theme = model.theme;

    ctx.clearRect(0, 0, cssW, cssH);

    // 1. background
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    // 2. closed days
    ctx.fillStyle = theme.closedFill;
    ctx.globalAlpha = 0.12;
    for (let i = 0; i < range.dayStarts.length; i++) {
      if (!model.closedDay[i]) continue;
      const d0 = range.dayStarts[i];
      const d1 = i + 1 < range.dayStarts.length ? range.dayStarts[i + 1] : range.endMs;
      const x1 = msToX(d0), x2 = msToX(d1);
      if (x2 > x1) ctx.fillRect(x1, 0, x2 - x1, bodyH);
    }
    ctx.globalAlpha = 1;

    // 3. alert day bands
    for (const [day, sev] of model.alertByDay) {
      const d0 = range.dayStarts[day];
      const d1 = day + 1 < range.dayStarts.length ? range.dayStarts[day + 1] : range.endMs;
      const x1 = msToX(d0), x2 = msToX(d1);
      if (x2 <= x1) continue;
      ctx.globalAlpha = sev === 'err' ? 0.38 : 0.28;
      ctx.fillStyle   = sev === 'err' ? theme.errFill : theme.warnFill;
      ctx.fillRect(x1, 0, x2 - x1, bodyH);
    }
    ctx.globalAlpha = 1;

    // 4. blackouts
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = theme.errFill;
    for (const b of model.blackouts) {
      const x1 = msToX(Math.max(b.startMs, range.startMs));
      const x2 = msToX(Math.min(b.endMs, range.endMs));
      if (x2 <= x1) continue;
      if (layout.mode === 'histogram' || b.rowIdx === 'all') {
        ctx.fillRect(x1, 0, x2 - x1, bodyH);
      } else {
        const y = b.rowIdx * layout.rowH;
        ctx.fillRect(x1, y, x2 - x1, Math.max(1, layout.rowH));
      }
    }
    ctx.globalAlpha = 1;

    // 5. bars
    if (layout.mode === 'rows') {
      for (const bar of model.bars) {
        const x1 = msToX(bar.startMs), x2 = msToX(bar.endMs);
        const w = Math.max(1, x2 - x1);
        const y = bar.rowIdx * layout.rowH;
        const h = Math.max(1, layout.rowH);
        const baseColor = bar.firmed ? theme.barFirmed : theme.barStandard;
        if (bar.style === 'dimmed') {
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = theme.dimFill;
          ctx.fillRect(x1, y, w, h);
        } else if (bar.style === 'conflict') {
          if (layout.rowH >= 4) {
            ctx.globalAlpha = 0.9;
            ctx.fillStyle = baseColor;
            ctx.fillRect(x1, y, w, h);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = theme.errFill;
            ctx.lineWidth = 1;
            ctx.strokeRect(x1 + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
          } else {
            ctx.globalAlpha = 1;
            ctx.fillStyle = theme.errFill;
            ctx.fillRect(x1, y, w, h);
          }
        } else {
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = baseColor;
          ctx.fillRect(x1, y, w, h);
        }
        ctx.globalAlpha = 1;
      }
    } else if (model.histAll && model.histActive) {
      for (let d = 0; d < range.dayStarts.length; d++) {
        const d0 = range.dayStarts[d];
        const d1 = d + 1 < range.dayStarts.length ? range.dayStarts[d + 1] : range.endMs;
        const x1 = msToX(d0), x2 = Math.max(x1 + 1, msToX(d1));
        const allH    = model.histAll[d]    * bodyH;
        const activeH = model.histActive[d] * bodyH;
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = theme.dimFill;
        ctx.fillRect(x1, bodyH - allH, x2 - x1, allH);
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = theme.accent;
        ctx.fillRect(x1, bodyH - activeH, x2 - x1, activeH);
      }
      ctx.globalAlpha = 1;
    }

    // 6. day dividers
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = theme.dividerColor;
    ctx.lineWidth = 0.5;
    for (const d of range.dayStarts) {
      const x = msToX(d);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssH); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 7. label scrim + day labels
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = theme.labelScrim;
    ctx.fillRect(0, cssH - NAV_LABEL_H, cssW, NAV_LABEL_H);
    ctx.globalAlpha = 1;

    const dayCount = range.dayStarts.length;
    const dayPx = dayCount > 0 ? cssW / dayCount : cssW;
    const STEPS = [1, 2, 3, 7, 14, 28];
    const step = STEPS.find(s => s * dayPx >= 34) ?? STEPS[STEPS.length - 1];
    const order = TimelineNav._dayMonthOrder();

    ctx.fillStyle = theme.labelText;
    ctx.font = `9px ${theme.fontMono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (let i = 0; i < dayCount; i += step) {
      const d0 = range.dayStarts[i];
      const nextIdx = i + step;
      const d1 = nextIdx < dayCount ? range.dayStarts[nextIdx] : range.endMs;
      const labelX = msToX((d0 + d1) / 2);
      if (labelX < 4 || labelX > cssW - 4) continue;
      const dt = new Date(d0);
      const mm = dt.getMonth() + 1, dd = dt.getDate();
      ctx.fillText(order === 'D/M' ? `${dd}/${mm}` : `${mm}/${dd}`, labelX, cssH - 2);
    }

    // 8. now marker
    const nowMs = Date.now();
    if (nowMs >= range.startMs && nowMs <= range.endMs) {
      ctx.fillStyle = theme.accent;
      ctx.fillRect(msToX(nowMs), 0, 1, cssH);
    }

    // 9. viewport — scrim outside the window + a plain --fg outline on it
    if (Timeline._tl) {
      const win = Timeline._tl.getWindow();
      const { x1, x2 } = navClampRect(msToX(win.start.getTime()), msToX(win.end.getTime()), cssW);
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = theme.fg;
      if (x1 > 0) ctx.fillRect(0, 0, x1, cssH);
      if (x2 < cssW) ctx.fillRect(x2, 0, cssW - x2, cssH);
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = theme.fg;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x1, 0.75, Math.max(0, x2 - x1), cssH - 1.5);
      ctx.globalAlpha = 1;
    }
    // 10. empty state (no bars) falls through to here naturally — every
    // step above runs unconditionally on the model, so background/dividers/
    // labels/now-marker/viewport still paint instead of leaving a blank canvas.
  },
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
    const visiting = new Set<string>();
    const getLen = (id: string): number => {
      if (chainLen[id] !== undefined) return chainLen[id];
      if (visiting.has(id)) return 0; // cycle detected in current DFS path
      visiting.add(id);
      const sources = deps[id] || [];
      if (!sources.length) { chainLen[id] = 0; visiting.delete(id); return 0; }
      chainLen[id] = 1 + Math.max(...sources.map(getLen));
      visiting.delete(id);
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
    return `<details class="line-group" data-line="${Util.escapeHtml(item.name)}"${open ? ' open' : ''}>` +
      `<summary>` +
      `<span class="line-expand">${open ? '−' : '+'}</span>` +
      `<span class="line-dot" style="background:${item.color}"></span>` +
      (item.pinned ? '<span class="line-pin-ico" aria-hidden="true">📌</span>' : '') +
      `<span>${Util.escapeHtml(item.name)}</span>` +
      `<span style="color:var(--fg-faint);font-weight:500;">(${item.tasks.length})</span>` +
      `${chip}</summary>` +
      (open ? item.tasks.map((tk, i) => {
        const firmed = Engine.firmingStatus(tk).firmed;
        return `<div class="hier-item${firmed ? ' firmed' : ''}" data-id="${Util.escapeHtml(String(tk.id))}">` +
          (firmed ? '<span class="lock-ico">🔒</span>' : '') +
          `<span>[${i + 1}] ${Util.escapeHtml(String(tk.ORDER || tk.id))}</span></div>`;
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

    const todayStart = Util.plantToday(Store.selectedPlant);
    const _todayDayKey = Util.dayKey(todayStart);

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
        .filter(tk => Util.overlapsDay(tk, _todayDayKey))   // OQ42: overlaps today on the plant clock
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
  // Compiled from _pastedIds on Apply (exact + `*` wildcard patterns).
  _pastedMatcher:  null as PasteMatcher | null,
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
      // One Store update for the whole paste: each per-box change event rebuilds the
      // checklist (via 'lines:selected'), detaching every later matched box.
      Util.wirePasteToCheckboxes(lineIn,
        () => Array.from(document.getElementById('gantt-line-checklist')?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') ?? []),
        boxes => Store.setSelectedLines(new Set([...GanttFilter._selectedLines, ...boxes.map(cb => cb.value)]), 'gantt'));
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
    if (!Util.taskMatchesPasteSet(task, GanttFilter._pastedIds.size > 0 ? (GanttFilter._pastedMatcher ?? GanttFilter._pastedIds) : null)) return false;
    if (text) {
      const haystack = [task.text, task.id, task.ORDER, task.PRODUCTION_ORDER, task.PARENT_ORDER, task.MATERIAL_NUMBER, task.MATERIAL_DESCRIPTION].join(' ').toLowerCase();
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
    drop.innerHTML = visible.length
      ? visible.map(c =>
          `<label><input type="checkbox" value="${Util.escapeHtml(c)}"${GanttFilter._selectedColors.has(c) ? ' checked' : ''}
           onchange="NIMBUS.GanttFilter._onColorChange(this)"> ${Util.escapeHtml(c)}</label>`
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
    drop.innerHTML = visible.length
      ? visible.map(f =>
          `<label><input type="checkbox" value="${Util.escapeHtml(f)}"${GanttFilter._selectedForms.has(f) ? ' checked' : ''}
           onchange="NIMBUS.GanttFilter._onFormChange(this)"> ${Util.escapeHtml(f)}</label>`
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
    const tokens = Util.parsePasteList(ta.value).map(Util.norm);
    GanttFilter._pastedIds = new Set(tokens);
    GanttFilter._pastedMatcher = Util.compilePasteMatcher(tokens);
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
      const parent = Util.norm(task.PARENT_ORDER); if (parent) known.add(parent);
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
  body?: { domProps?: { center?: { width?: number } } };
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

/* =============================================================================
   INTERACTION — unified input pipeline for the Timeline.

   Owns ALL vis-timeline input events (click, doubleClick, contextmenu,
   DataSet 'update' / drag-commits) and the document-level keyboard shortcuts.
   Input flows:

        vis-timeline  ─click/dblclick/ctxmenu─►  Interaction  ─►  Selection
                                                             └─►  Inspector
        vis-timeline  ─DataSet 'update'──────►  Interaction  ─►  Store.updateTask
                                                             └─►  Engine.manualSchedulePatchFor (finish-anchored; a drop runs no autoReflow cascade)
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
      container.tabIndex = 0;
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

      Interaction._applyDistSiblingHighlight(evt.ids);

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
        ? `<div class="hov-alerts">${Util.escapeHtml(Util.t('ui.insp_alerts_title', { count: rel.length }))}: ${
            rel.slice(0, 3).map(a => (a.type || a.sev || '')).filter(Boolean).join(', ')
          }${rel.length > 3 ? '…' : ''}</div>`
        : '';
      const firmStatus = Engine.firmingStatus(t);
      const firmedBadge = (firmStatus.firmed
        ? `<span class="hov-firmed">🔒 ${Util.t('ui.hov_firmed_badge')}</span>` : '')
        + (firmStatus.reasons.includes('running') ? `<span class="hov-firmed">${Util.t('ui.firm_reason_running')}</span>` : '')
        + (Engine.isSapFirmed(t) ? `<span class="hov-sap-firm">${Util.t('ui.sap_firm_marker')}</span>` : '');
      const suborderHtml = t.PARENT_ORDER ? (() => {
        const siblings = Store.siblingsByParent().get(t.PARENT_ORDER) || [];
        const getQty = (task: any) => {
          const q = task['ORDER_QUANTITY_(GMEIN)'];
          return (typeof q === 'number' ? q : typeof q === 'string' ? parseFloat(q) : 0) || 0;
        };
        const thisQty = getQty(t);
        const totalQty = siblings.reduce((sum, s) => sum + getQty(s), 0);
        const pct = totalQty > 0 ? Math.round((thisQty / totalQty) * 100) : 0;
        return `<div class="hov-suborder">${Util.escapeHtml(Util.t('ui.hov_suborder', {letter: t.DISTRIBUTION_LETTER || '', parent: t.PARENT_ORDER, pct, count: siblings.length}))}</div>`;
      })() : '';

      return `
        <div class="hov-title">${Util.escapeHtml(orderNo)} ${firmedBadge}</div>
        <div class="hov-mat">${Util.escapeHtml(matDesc)}</div>
        <div class="hov-grid">
          <span>${Util.t('col.qty')}</span><span>${Util.escapeHtml(qty)}</span>
          <span>${Util.t('ui.hov_run')}</span><span>${run.toFixed(2)} h</span>
          <span>${Util.t('ui.insp_line')}</span><span>${Util.escapeHtml(line)}</span>
          <span>${Util.t('col.color')}</span><span>${Util.escapeHtml(color)}</span>
          <span>${Util.t('col.form')}</span><span>${Util.escapeHtml(form)}</span>
        </div>
        <div class="hov-dates">${startStr} → ${endStr}</div>
        ${suborderHtml}
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
    // Double-click action: focus-zoom.
    if (typeof Timeline.focus === 'function') Timeline.focus(id);
  },

  /** Machine lock (decision C, aggregate_to_detail.md §8): a sub-order
   *  (PARENT_ORDER set) may not change machine by drag, grid edit or
   *  Inspector — only adjusting its distribution shares can move it. Shows
   *  the lock toast with an action to open the Order Distribution pane. */
  _rejectDistMachineMove(task: NimbusTask): void {
    Toast.show(
      Util.t('toast.dist_machine_locked', { order: Util.orderNumber(task), machine: task.MACHINE || 'Unknown' }),
      'warn', 4000,
      {
        label: Util.t('btn.insp_dist_open'),
        run: () => {
          const app = (globalThis as unknown as { NIMBUS?: { App?: { gotoGanttSub?: (sub: string) => void } } }).NIMBUS?.App;
          app?.gotoGanttSub?.('distribution');
        },
      }
    );
  },

  /** A manual placement returned null for the dragged item. A firmed order dropped outside working hours asks
   *  the planner to confirm overtime first (OQ63) and re-runs the drop with the approval; anything else is
   *  explained (the engine already toasted `finish_cannot_hold`) and the bar is put back. */
  _rejectManualPlacement(t: NimbusTask, itemId: string): void {
    if (Engine.lastManualRefusal === 'needs_overtime_confirm') {
      void Engine.confirmOvertimePlacement(t).then(ok => {
        if (ok) Interaction._onDataSetUpdate({ items: [itemId] }, { confirmedOvertime: true });
        else Timeline._scheduleRebuild();
      });
      return;
    }
    if (Engine.lastManualRefusal === 'running_finish_locked') {
      Toast.show(Util.t('toast.running_finish_locked', { order: Util.orderNumber(t) }), 'warn', 6000);
    } else if (Engine.lastManualRefusal !== 'finish_cannot_hold') Toast.show(Util.t('toast.commit_failed'), 'error');
    Timeline._scheduleRebuild();
  },

  /** Routing-runtime eligibility (ROUTING_RUNTIME_DESIGN.md §8.3): a drag
   *  to a machine with no resolvable routing operation for this task is
   *  rejected before it ever reaches `Engine.manualSchedulePatchFor`. Shows
   *  a plain toast — unlike `_rejectDistMachineMove` there is no follow-up
   *  action, since fixing this is a master-data/routing question, not a
   *  distribution-share edit. */
  _rejectRuntimeMove(task: NimbusTask, machine: string): void {
    Toast.show(
      Util.t('toast.no_routing_at_workcenter', { order: Util.orderNumber(task), machine: machine || 'Unknown' }),
      'warn', 4000
    );
  },

  /** Whether `plant` has the routing-runtime switch on (`Store.masterData
   *  .plants[].routing_runtime_enabled` — ROUTING_RUNTIME_DESIGN.md §3.6),
   *  the same lookup `Runtime.load` itself gates on. `Runtime.eligible` is
   *  unconditionally false when no rate map is cached (§8.1's `_EMPTY_MAP`
   *  behavior: a disabled/not-yet-loaded plant "falls through the same step
   *  sequence a real map with nothing in it would produce") — so calling it
   *  for a plant that hasn't opted in would block every drag on that plant,
   *  contradicting "the switch defaults off, so nothing schedules
   *  differently yet" (§12 P1). This gate keeps the eligibility guard a
   *  no-op outside a plant that has actually turned routing runtime on. */
  _routingRuntimeEnabled(plant: string | null | undefined): boolean {
    if (!plant) return false;
    return !!Store.masterData?.plants?.find(p => p.plant === plant)?.routing_runtime_enabled;
  },

  /** Sibling highlight (aggregate_to_detail.md §8): items sharing the
   *  PARENT_ORDER of any currently-selected task get `.dist-sibling` — the
   *  only visual link between siblings, since finish-to-start links are
   *  per-machine. Diffs against the previously-highlighted item set (same
   *  suppressed-update pattern as GanttFilter._doApply's dim/undim) so a
   *  selection change only touches items whose highlight actually flips. */
  _distSiblingItemIds: new Set<string>(),
  _applyDistSiblingHighlight(selectedIds: string[]): void {
    if (!Timeline._items) return;
    const parents = new Set<string>();
    for (const id of selectedIds) {
      const t = Store.tasks[id];
      if (t?.PARENT_ORDER) parents.add(t.PARENT_ORDER);
    }
    const nextIds = new Set<string>();
    if (parents.size) {
      const siblingsByParent = Store.siblingsByParent();
      for (const parent of parents) {
        for (const task of siblingsByParent.get(parent) || []) {
          if (selectedIds.includes(String(task.id))) continue;
          for (const itemId of Timeline.itemIdsForTask(task.id)) nextIds.add(itemId);
        }
      }
    }
    const updates: Array<{ id: string; className: string }> = [];
    for (const itemId of Interaction._distSiblingItemIds) {
      if (nextIds.has(itemId)) continue;
      const item = Timeline._items.get(itemId) as TimelineVisItem | null;
      if (!item) continue;
      const cls = (item.className || '').split(' ').filter(c => c !== 'dist-sibling').join(' ');
      if (cls !== item.className) updates.push({ id: itemId, className: cls });
    }
    for (const itemId of nextIds) {
      const item = Timeline._items.get(itemId) as TimelineVisItem | null;
      if (!item) continue;
      if ((item.className || '').split(' ').includes('dist-sibling')) continue;
      updates.push({ id: itemId, className: (item.className ? item.className + ' ' : '') + 'dist-sibling' });
    }
    if (updates.length) {
      Timeline._suppressEvents = true;
      try { Timeline._items.update(updates); } finally { Timeline._suppressEvents = false; }
    }
    Interaction._distSiblingItemIds = nextIds;
  },

  /** Drag commit: update the store (finish-anchored, through `Engine.manualSchedulePatchFor`) ONLY if times/line actually changed.
   *  Firmed orders: only a spurious no-op echo (`noActualChange`) is dropped —
   *  a genuine drag on a firmed order still commits (see the corrected header
   *  comment above; CQ-1 Phase 3 Task 5). */
  _onDataSetUpdate(props: InteractionDataSetUpdateProps, opts: ManualPlacementOptions = {}): void {
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
        const currentEnd = Util.snap(new Date(v.end));
        const currentGroup = v.group || t.MACHINE;
        // Derived edges are often off the 15-minute grid: compare on the grid on both sides.
        const noActualChange = t.start_date &&
          currentStart.getTime() === Util.snap(expectedItem.start).getTime() &&
          currentEnd.getTime() === Util.snap(expectedItem.end).getTime() &&
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

      // Backward scheduling (OQ1): a drop anchors on the FINISH. The right edge (or the whole bar) moving changes
      // the finish; the start is always re-derived from the run time. A change of the left edge alone is not a move.
      // Compare on the grid on both sides: a derived edge off the 15-minute grid must not read as "moved".
      const expectedEnd = Util.snap(expectedItem.end);
      const startMoved = newStart.getTime() !== Util.snap(expectedItem.start).getTime();
      const endMoved   = newEnd.getTime()   !== expectedEnd.getTime();
      const lineMoved  = newLine !== t.MACHINE;
      const moved = startMoved || endMoved || lineMoved;

      if (!moved) {
        // vis emitted an update for non-temporal reasons (e.g. zoom relayout).
        // Do NOTHING — this is the fix for the click-cascades-into-rebuild bug.
        this._log('update:ignored', { id, reason: 'no temporal change' });
        continue;
      }
      // Task was unscheduled (null dates) — skip drag processing to avoid TypeError.
      if (!t.start_date || !t.end_date) continue;
      if (!endMoved && !lineMoved) {
        // Only the left edge moved. The start is derived from the finish, so there is nothing to commit:
        // put the bar back and say why (the onMoving veto below stops most of these before they land).
        this._log('update:left-edge-locked', { id });
        Toast.show(Util.t('toast.left_edge_locked'), 'warn', 4000);
        Timeline._scheduleRebuild();
        continue;
      }

      this._log('update:commit', { id, newLine });

      // Stamp drag-recency so a trailing vis 'click' at drag-end can't trigger the
      // CENTER_ON_CLICK focus() pan that would revert this commit (see _onClick).
      this._lastDragEndTs = Date.now();

      // Multi-order drag: if the dragged item is part of a multi-selection,
      // move all non-firmed selected items by the same time + line delta.
      // The dragged piece's same-edge delta (OQ17 b): for a one-piece order this is the order's own finish delta.
      const deltaMs  = newEnd.getTime() - expectedEnd.getTime();
      // D1: a horizontal drag lands the finish on the 15-minute grid; a line-only drag (endMoved false) holds
      // the finish exactly, so an off-grid SAP finish survives a vertical move.
      const requestedFinish = endMoved ? Util.snap(new Date(t.end_date.getTime() + deltaMs)) : new Date(t.end_date.getTime());

      // Machine lock (decision C, aggregate_to_detail.md §8): reject a
      // cross-machine drag of a sub-order before either the multi-drag or
      // single-drag commit path below runs — a time-only drag (lineMoved
      // false) is unrestricted. This guard sits above both former
      // manualSchedulePatchFor(t, newLine, newStart) call sites for the
      // dragged item, so a locked task can never reach either one on a
      // rejected drag.
      if (t.PARENT_ORDER && lineMoved) {
        Interaction._rejectDistMachineMove(t);
        Timeline._scheduleRebuild();
        continue;
      }

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
        //
        // Routing-runtime eligibility (ROUTING_RUNTIME_DESIGN.md §8.3): checked
        // ahead of manualSchedulePatchFor, before anything else in this branch
        // has run — an ineligible dragged item aborts the whole multi-drag with
        // one toast, same revert mechanism as every other failure below. Gated
        // by _routingRuntimeEnabled so a plant that hasn't turned the feature
        // on sees no behavior change (see that helper's own comment).
        if (Interaction._routingRuntimeEnabled(t.PLANT) && !Runtime.eligible(t, newLine)) {
          Interaction._rejectRuntimeMove(t, newLine);
          Timeline._scheduleRebuild();
          continue;
        }
        // Whole-batch placement is derived on one run cache: each walk reads ~90 days of working windows.
        const batchPlant = t.PLANT || Store.getPlantForLine(t.MACHINE || 'Unknown') || Store.selectedPlant;
        Calendar._beginRun(batchPlant);
        try {
          const draggedPatch = Engine.manualRoutingSchedulePatchFor(t, newLine, requestedFinish, opts);
          if (!draggedPatch?.start_date || !draggedPatch.end_date) {
            Interaction._rejectManualPlacement(t, itemId);
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
          let companionLockedTask: NimbusTask | null = null;
          let companionRuntimeIneligible: { task: NimbusTask; line: string } | null = null;
          for (const sid of selIds) {
            const st = Store.tasks[sid];
            if (!st || !st.start_date) continue;
            const sNewLine  = lineMoved ? newLine : (st.MACHINE || 'Unknown');
            // Machine lock (decision C): a locked companion fails the whole
            // multi-drag atomically — nothing has been committed to Store or
            // Timeline for this drag yet, so breaking here reverts cleanly.
            if (st.PARENT_ORDER && sNewLine !== st.MACHINE) {
              companionFailed = true;
              companionLockedTask = st;
              break;
            }
            // Routing-runtime eligibility (ROUTING_RUNTIME_DESIGN.md §8.3): same
            // atomic-abort treatment as the machine lock above — the first
            // ineligible companion fails the whole drag before any patch is
            // computed for it. Gated by _routingRuntimeEnabled (see its comment).
            if (Interaction._routingRuntimeEnabled(st.PLANT) && !Runtime.eligible(st, sNewLine)) {
              companionFailed = true;
              companionRuntimeIneligible = { task: st, line: sNewLine };
              break;
            }
            const sRequestedFinish = new Date((st.end_date || st.start_date).getTime() + deltaMs);
            const changes = Engine.manualRoutingSchedulePatchFor(st, sNewLine, sRequestedFinish);
            if (!changes?.start_date || !changes.end_date) {
              companionFailed = true;
              break;
            }
            companionPatches.push({ id: sid, changes });
            companionItemUpdates.push({ id: sid, start: changes.start_date, end: changes.end_date, group: sNewLine });
          }
          if (companionFailed) {
            if (companionLockedTask) Interaction._rejectDistMachineMove(companionLockedTask);
            else if (companionRuntimeIneligible) Interaction._rejectRuntimeMove(companionRuntimeIneligible.task, companionRuntimeIneligible.line);
            else if (Engine.lastManualRefusal !== 'finish_cannot_hold') Toast.show(Util.t('toast.commit_failed'), 'error');
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
            () => { UndoStack.restoreTasks(snap); Alerts.scheduleRecompute(); }, allIds);
          this._clearGhosts();
          return;
        } finally { Calendar._endRun(); }
      }

      // Single-item drag (original behaviour) — routed through
      // manualSchedulePatchFor so an already-split order (>=2
      // scheduleSegments) is shifted by the drag delta rather than
      // collapsed or re-derived (OD-B1a).
      const snap = UndoStack.snapshotTasks([id]);

      // Routing-runtime eligibility (ROUTING_RUNTIME_DESIGN.md §8.3): checked
      // ahead of manualSchedulePatchFor, same revert mechanism (Timeline.
      // _scheduleRebuild + continue) as every other rejected drag above.
      // Gated by _routingRuntimeEnabled (see its comment).
      if (Interaction._routingRuntimeEnabled(t.PLANT) && !Runtime.eligible(t, newLine)) {
        Interaction._rejectRuntimeMove(t, newLine);
        Timeline._scheduleRebuild();
        continue;
      }
      const patch = Engine.manualRoutingSchedulePatchFor(t, newLine, requestedFinish, opts);
      if (!patch?.start_date || !patch.end_date) {
        Interaction._rejectManualPlacement(t, itemId);
        continue;
      }
      // A resize or drop that resolves back onto the bar the order already is changes nothing: no Store write
      // (so nothing is dirtied), no undo entry. The bar springs back to its stored place.
      if (patch.start_date.getTime() === t.start_date.getTime() && patch.end_date.getTime() === t.end_date.getTime()
        && (patch.MACHINE ?? t.MACHINE) === t.MACHINE
        && (patch.placement_exception ?? null) === (t.placement_exception ?? null)
        && (patch.planning_status ?? t.planning_status) === t.planning_status) {
        this._log('update:ignored', { id, reason: 'derived bar unchanged' });
        Timeline._scheduleRebuild();
        continue;
      }
      Store.updateTask(id, patch, 'timeline');
      Timeline.finishSetupDrag(new Set([t.MACHINE || 'Unknown', newLine]));

      UndoStack.push(`Move "${(Store.tasks[id] && Store.tasks[id].text) || id}"`,
                     () => UndoStack.restoreTasks(snap), [id]);
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
    // The commit translates companions by the dragged piece's FINISH delta (OQ1/OQ17 b), so the preview takes
    // the same basis: vis keeps the live edges of the item being dragged on its internal item data (a body drag
    // moves both edges, a right-edge resize moves only the end). `props.time` is the item's start, so without
    // the live end it can only describe a body drag: start plus the stored width.
    const dragMs = (props.time instanceof Date ? props.time : new Date(props.time)).getTime();
    const liveEnd = (Timeline._tl as unknown as VisInternalTimeline | null)?.itemSet?.items?.[dragItemId]?.data?.end;
    const liveEndMs = liveEnd instanceof Date ? liveEnd.getTime() : Number(liveEnd);
    const dragEndMs = Number.isFinite(liveEndMs)
      ? liveEndMs
      : dragMs + (t.end_date ? t.end_date.getTime() - t.start_date.getTime() : 0);
    const deltaMs = dragEndMs - (t.end_date ? t.end_date.getTime() : t.start_date.getTime());

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

    const ghostPlant = t.PLANT || Store.getPlantForLine(t.MACHINE || 'Unknown') || Store.selectedPlant;
    const ghostLineMoved = props.group != null && String(props.group) !== (t.MACHINE || 'Unknown');
    Calendar._beginRun(ghostPlant);   // one calendar cache for every companion's derivation this frame
    try {
    for (const sid of selIds) {
      const st = Store.tasks[sid];
      if (!st || !st.start_date) continue;
      // U27: the drop derives each companion's start by the backward walk from its translated finish, so the
      // ghost does too (its width then matches the dropped bar across a closed day or a shift boundary). The
      // translated stored edges stay as the fallback when no placement derives.
      let ghostStart = new Date(st.start_date.getTime() + deltaMs);
      let ghostEnd   = st.end_date ? new Date(st.end_date.getTime() + deltaMs) : ghostStart;
      if (st.end_date) {
        const derived = Engine.manualRoutingSchedulePatchFor(st, ghostLineMoved ? String(props.group) : (st.MACHINE || 'Unknown'),
          new Date(st.end_date.getTime() + deltaMs), { quiet: true });
        if (derived?.start_date && derived.end_date) { ghostStart = derived.start_date; ghostEnd = derived.end_date; }
      }
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
    } finally { Calendar._endRun(); }

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
    if (e.defaultPrevented || (e.target as HTMLElement | null)?.closest?.('#ctx-menu')) return;
    if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))
        && (e.target as HTMLElement | null)?.closest?.('#vis-timeline') && Selection.size()) {
      e.preventDefault();
      ContextMenu.openFromKeyboard(Selection._anchor || Selection.ids()[0], e.target as HTMLElement);
      return;
    }
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

  _unscheduleSelected(): void { Interaction.unscheduleIds(Selection.ids()); },

  /** The single Delete / Unschedule implementation (Delete key and command palette). */
  unscheduleIds(requestedIds: string[]): void {
    // Manual-firmed, frozen-horizon and running orders are locked (Engine.firmingStatus union).
    const ids = requestedIds.filter(id => { const t = Store.tasks[id]; return !!t && !Engine.firmingStatus(t).firmed; });
    if (!ids.length) { Toast.show(Util.t('toast.unschedule_all_firmed'), 'warn'); return; }
    // An explicit segment aggregate is atomic. Do not clear just its parent
    // envelope, which Store would correctly reconstruct from its children.
    const eligibleIds = ids.filter(id => (Store.tasks[id]?.scheduleSegments?.length ?? 0) < 2);
    if (!eligibleIds.length) {
      Toast.show('Split orders must be rescheduled as a whole.', 'warn');
      return;
    }
    const snap = UndoStack.snapshotTasks(eligibleIds);
    const patches = eligibleIds.map(id => ({ id, changes: Engine.plannerUnscheduleChanges() }));
    Store.updateMany(patches, 'interaction');
    Alerts.scheduleRecompute();
    UndoStack.push(`Unschedule ${eligibleIds.length} order(s)`,
                   () => UndoStack.restoreTasks(snap), eligibleIds);
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
