// insights/insights-ui.mjs — Dashboard (home-tab KPIs, heatmaps, alert
// summary) and AlertsUIAdapter (alert drawer, bell badge, cell-briefing
// modal). Extracted verbatim from schedule-workbench.mts (Phase P3 of
// docs/architecture/domain-refactor-plan.md, which split that 10,391-line
// mega-module into 6 domain files) — two non-contiguous source ranges
// combined into this one file per that phase's per-domain grouping.
//
// `Timeline` (scheduling/gantt.mjs) and `Table`/`Inspector`/
// `notifyResidualFirming` (scheduling/orders.mjs) are real cross-file
// imports, not new couplings — Dashboard._gotoLine/_jumpToOrder and
// AlertsUIAdapter.focus/showForCell already called Timeline bare in the
// single-file module (this file's own line+day navigation), and
// AlertsUIAdapter._handleAction's override action already called
// Table._openOverrideModalForId/Inspector.show bare. Every OTHER existing
// cross-reference into this file's own AlertsUIAdapter (from Table's
// `_showAlertPopup` and gantt.mjs's Interaction `_onAlertCellClick`) was
// already routed through the shared `NIMBUS` global binding in the original
// file, not a bare identifier, so those call sites are left untouched here —
// no import edge is needed in the other direction.
/* global NIMBUS */
import { Config, Util, VirtualList } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import { Calendar } from '../calendar/calendar-engine.mjs';
import { Utilization, Alerts } from './services.mjs';
import { Engine } from '../optimization/engine.mjs';
import { Timeline } from '../scheduling/gantt.mjs';
import { Table, Inspector, notifyResidualFirming } from '../scheduling/orders.mjs';
import { Selection } from '../scheduling/selection.mjs';
import { categoryOf, ackLabel, ALL_ALERTS_PROFILE_ID, FIXABLE_ALERT_TYPES, OVERRIDE_ALERT_TYPES, CALENDAR_ALERT_TYPES } from './alert-profiles.mjs';
import { AlertProfileMatches } from './alert-profile-matches.mjs';
import type { NimbusTask, UtilSevBucket } from '../platform/types.mjs';

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
type DashboardTileAction = 'orders-today' | 'alerts-today' | 'late' | 'headroom' | 'needs-planning';
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
  // Day the Machine Status card shows (a dayKey, not an index, so midnight can't
  // silently shift it). null = plant-today; clamped to the 7-day matrix's keys.
  _lsDayKey:     null as string | null,
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
        Dashboard._lsDayKey = null;
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
          || evt.type === 'firmed:change' || evt.type === 'distribution:summary') {
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
    // Machine Status day stepper (‹ label ›): delegated click, re-renders only the card.
    document.getElementById('ls-day-group')?.addEventListener('click', (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('button[data-ls-step]') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      Dashboard._lsStep(parseInt(btn.dataset.lsStep || '0', 10));
    });
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

    // Build the 7-day utilization matrix ONCE and hand it to _renderKPIs, _renderHeatmap and
    // _renderLineStatus (the card's day reads the same matrix as the heatmap column).
    const _now7    = Util.plantClock(Store.selectedPlant);   // the plant clock (OQ52), not the viewer's
    const _filtered = Dashboard._filteredTasks();
    // Compute once, filter after: the FULL-plant 7-day matrix (no task subset) is served by the shared
    // Utilization cache (keyed on plant + Store.dataRev(), so a line-filter toggle, an alert refresh or a
    // line checkbox never recomputes it); _visibleLines re-narrows the rows to the Dashboard's line filter
    // and every consumer below iterates only those lines. _matrix7Cache just remembers the last matrix for
    // the day-stepper (_lsStep), keyed by its start day.
    const _matrix7: DashboardUtilMatrix = Utilization.computeMatrix(_now7, 7);
    Dashboard._matrix7Cache = { key: `${Util.startOfDay(_now7)!.getTime()}|7|${Store.dataRev()}|${Store.selectedPlant || ''}`, matrix: _matrix7 };

    Dashboard._renderKPIs(_matrix7, _filtered);
    Dashboard._renderHeatmap(_matrix7);
    Dashboard._renderLineStatus(_matrix7);
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

  // Orders-today tile subtitle: "{n} total" plus the sub-orders note, but only
  // when the current plant actually has sub-orders — `Store.distributionSummary`
  // (needs_review/changed/problems/truncated, D52) carries no such field, so this
  // checks Store.siblingsByParent() (D40's PARENT_ORDER map, already plant-scoped)
  // instead of the summary's mere presence.
  _ordersTileSubtitle(tasks: NimbusTask[]): string {
    const base = Util.t('kpi.orders_total', { n: tasks.length });
    return Store.siblingsByParent().size > 0
      ? base + ' · ' + Util.t('kpi.orders_sub_counted')
      : base;
  },

  _renderKPIs(matrix7?: DashboardUtilMatrix, tasksArg?: NimbusTask[]): void {
    const tasks = tasksArg !== undefined ? tasksArg : Dashboard._filteredTasks();
    const today = Util.plantToday(Store.selectedPlant);

    // OQ42: "today" = the order overlaps today on the plant clock, so a bar that crosses midnight counts on both days.
    const todayKey = Util.dayKey(today);
    const todayOrders = tasks.filter(t => Util.overlapsDay(t, todayKey));

    // Overdue backlog: every order whose scheduled finish has slipped past its SAP due date.
    const lateCount = tasks.filter(t => Util.latenessHours(t) > 0).length;
    const queued = tasks.filter(task => task.planning_status === 'needs_planning');
    const queuedHours = queued.reduce((hours, task) => hours + Math.max(0, Util.runHours(task)), 0);

    // Alerts Today tile (kpi.conflicts_pending, action:'alerts-today') must count exactly
    // what its click-through shows -- Table._applyChipFilter({status:'conflict', dateKey:today})
    // -- i.e. today's orders carrying >=1 err alert.
    const alertsByTask = Store.alertsByTask();
    const conflictsToday = todayOrders.filter(t =>
      (alertsByTask.get(String(t.id)) || []).some(a => a.sev === 'err')).length;
    const conflictCls = conflictsToday > 0 ? 'err' : '';

    // Capacity Headroom Next 7D: 1 - average utilization across all line-day cells with capacity.
    // Reuse the matrix built once in render() when provided; recompute standalone otherwise.
    if (matrix7 === undefined) matrix7 = Utilization.computeMatrix(today, 7);
    let pctSum = 0, pctN = 0;
    for (const ln of Dashboard._visibleLines(matrix7)) {
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
        d: Dashboard._ordersTileSubtitle(tasks),
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
      // Fifth tile only while the queue is non-empty: the row stays at four calm
      // tiles in steady state and gains a red action tile exactly when a
      // scheduler has unplaced demand to deal with.
      ...(queued.length ? [{
        k: Util.t('kpi.needs_planning'), v: String(queued.length),
        d: Util.t('kpi.needs_planning_demand', { h: queuedHours.toFixed(1) }),
        cls: 'err', action: 'needs-planning' as DashboardTileAction,
      }] : []),
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
      case 'needs-planning': return Util.t('tip.tile_needs_planning');
      default: return '';
    }
  },

  _tileClick(action: DashboardTileAction): void {
    switch (action) {
      case 'orders-today': {
        NIMBUS!.App!.goto!('table');
        const ymd = Util.dayKey(Util.plantToday(Store.selectedPlant));
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
        const ymd = Util.dayKey(Util.plantToday(Store.selectedPlant));
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
      case 'needs-planning': {
        NIMBUS!.App!.goto!('table');
        setTimeout(() => {
          if (NIMBUS!.Table && NIMBUS!.Table!._applyChipFilter) {
            NIMBUS!.Table!._applyChipFilter!({ status: 'needs_planning' });
          }
        }, 120);
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
    let situation = '';
    if (attention > 0) {
      situation = Util.t('ui.work_status_attention', {
        count: attention, plural: attention === 1 ? '' : 's',
        total: todayCount, totalPlural,
      });
    } else {
      situation = Util.t('ui.work_status_clear', { total: todayCount, totalPlural });
    }
    if (Store.distributionSummary && Store.distributionSummary.needs_review > 0) {
      situation += ' · ' + Util.t('ui.work_status_distribution', {
        count: Store.distributionSummary.needs_review,
        plural: Store.distributionSummary.needs_review === 1 ? '' : 's',
      });
    }
    el.textContent = situation;
    el.classList.toggle('warn', attention > 0 || (Store.distributionSummary?.needs_review ?? 0) > 0);
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
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
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
    return Util.relativeLuminance(hex);
  },

  _heatForeground(bg: string, ink: string, onColor: string): string {
    // In dark mode both content foregrounds are light. Include the permanent
    // chrome ink, then use black/white only if no palette candidate meets AA.
    return Util.contrastText(bg, [ink, onColor, '#0c1c30']);
  },

  // A companion computeMatrix fix now always pads the matrix with every plant line
  // (including zero-order ones), so the Dashboard's own line-filter chips must be
  // re-applied here to narrow the display back down when the user has one active.
  _visibleLines(matrix: DashboardUtilMatrix): string[] {
    const keys = Object.keys(matrix);
    return Dashboard._filterLines.size === 0 ? keys : keys.filter(l => Dashboard._filterLines.has(l));
  },

  // Plant line list narrowed to the global header line filter (empty filter = all lines).
  _selectedPlantLines(): string[] {
    const all = Store.linesForSelectedPlant();
    return Dashboard._filterLines.size === 0 ? all : all.filter(l => Dashboard._filterLines.has(l));
  },

  _renderHeatmap(matrix?: DashboardUtilMatrix): void {
    const container = document.getElementById('util-heatmap-panel');
    if (!container) return;

    // Reuse the 7-day matrix built once in render() when provided; recompute standalone otherwise.
    if (matrix === undefined) matrix = Utilization.computeMatrix(Util.plantClock(Store.selectedPlant), 7);
    const lines = Dashboard._visibleLines(matrix).sort();

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
      return Dashboard._heatForeground(bg, inkTxt, onTxt);
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
      html += `<div class="hm-line-label"><span class="hm-dot" style="background:${dot}"></span>${Util.escapeHtml(line)}</div>`;
      days.forEach(d => {
        const pct = matrix[line][d]?.pct || 0;
        const bg  = heatBg(pct);
        const tc  = heatText(pct, bg);
        const lbl = Math.round(pct * 100) + '%';
        const cap     = (matrix[line][d]?.capacity || 0).toFixed(2);
        const effCap  = (matrix[line][d]?.effectiveCapacity ?? (matrix[line][d]?.capacity || 0)).toFixed(2);
        const sched   = (matrix[line][d]?.scheduled || 0).toFixed(2);
        const effNote = effCap !== cap ? ` · limit ${effCap}h` : '';
        html += `<button type="button" class="hm-cell" data-line="${Util.escapeHtml(line)}" data-date="${Util.escapeHtml(d)}" style="background:${bg};color:${tc}" title="Click to view ${Util.escapeHtml(line)} on ${Util.escapeHtml(d)} · ${lbl} (${sched}h / ${cap}h${effNote})">${lbl}</button>`;
      });
    });

    html += `</div></div>
      <div class="hm-legend">
        <span>idle</span>
        <div class="hm-grad"></div>
        <span>overload</span>
      </div>`;

    container.innerHTML = html;
    container.querySelectorAll<HTMLElement>('.hm-cell').forEach(cell =>
      cell.addEventListener('click', () => Dashboard._gotoLine(cell.dataset.line || '', cell.dataset.date || '')));
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

  /** The 7 day keys the dashboard matrix covers, starting at plant-today (mirrors computeMatrix's key build). */
  _lsDayKeys(now: Date): string[] {
    const start = Util.startOfDay(now)!;
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start); d.setDate(start.getDate() + i);
      return Util.dayKey(d);
    });
  },

  /** The day the card shows: the stored key clamped into [today, today+6]; null -> today. */
  _lsActiveKey(keys: string[]): string {
    const k = Dashboard._lsDayKey;
    if (!k || k < keys[0]) return keys[0];
    if (k > keys[keys.length - 1]) return keys[keys.length - 1];
    return k;
  },

  /** Step the card by +/-1 day (clamped) and re-render only the card. */
  _lsStep(dir: number): void {
    const keys = Dashboard._lsDayKeys(Util.plantClock(Store.selectedPlant));
    const idx = Math.max(0, Math.min(keys.length - 1, keys.indexOf(Dashboard._lsActiveKey(keys)) + (dir < 0 ? -1 : 1)));
    Dashboard._lsDayKey = keys[idx];
    // The cached matrix is only valid while its day 0 is still plant-today (its key leads
    // with that day's start); after midnight rolls over, rebuild via a full render.
    const cache = Dashboard._matrix7Cache;
    const cacheFresh = !!cache && cache.key.split('|')[0] === String(Util.startOfDay(Util.plantClock(Store.selectedPlant))!.getTime());
    if (cache && cacheFresh) Dashboard._renderLineStatus(cache.matrix);
    else Dashboard.render();
    Dashboard._syncLineStatusHeight();
  },

  _lsDayLabel(key: string, keys: string[]): string {
    if (key === keys[0]) return Util.t('ui.today');
    if (key === keys[1]) return Util.t('ui.tomorrow');
    const dt = new Date(key + 'T12:00:00');
    try {
      const loc = Util.locale();
      return `${new Intl.DateTimeFormat(loc, { weekday: 'short' }).format(dt)} ${new Intl.DateTimeFormat(loc, { month: 'numeric', day: 'numeric' }).format(dt)}`;
    } catch {
      return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
    }
  },

  _renderLsDayControl(keys: string[], active: string): void {
    const label = document.getElementById('ls-day-label');
    const prev  = document.getElementById('ls-day-prev') as HTMLButtonElement | null;
    const next  = document.getElementById('ls-day-next') as HTMLButtonElement | null;
    // No aria sweep mechanism exists, so the group's accessible name is localized here.
    document.getElementById('ls-day-group')?.setAttribute('aria-label', Util.t('ui.line_status_title'));
    if (label) {
      label.textContent = Dashboard._lsDayLabel(active, keys);
      label.title = label.textContent;
    }
    const idx = keys.indexOf(active);
    if (prev) {
      prev.disabled = idx <= 0;
      prev.title = Util.t('ui.ls_day_prev'); prev.setAttribute('aria-label', prev.title);
    }
    if (next) {
      next.disabled = idx >= keys.length - 1;
      next.title = Util.t('ui.ls_day_next'); next.setAttribute('aria-label', next.title);
    }
  },

  /** Pure row builder: the chosen day's cell from the 7-day matrix (the heatmap's own column). */
  _lsRowData(lines: string[], byLine: Record<string, NimbusTask[]>, matrix: DashboardUtilMatrix,
             dayKey: string, isToday: boolean, now: Date): DashboardLineStatusRow[] {
    return lines.map((line): DashboardLineStatusRow => {
      const ci    = Timeline._colorIndex(line);
      const color = Config.COLORS[ci % Config.COLORS.length];
      const u = matrix[line]?.[dayKey];
      const sched   = u ? u.scheduled.toFixed(2)                         : '0.00';
      const cap     = u ? u.capacity.toFixed(2)                          : '0.00';
      const effCap  = u ? (u.effectiveCapacity ?? u.capacity).toFixed(2) : cap;
      const pct     = u ? Math.round((u.pct ?? 0) * 100)                 : 0;
      const overloadAt = u && u.capacity > 0 ? u.effectiveCapacity / u.capacity : Config.OVERLOAD_THRESHOLD;
      const sev     = u ? Utilization.sev(u.pct ?? 0, overloadAt) : 'ok';
      const barW    = Math.min(pct, 100);
      const isOver  = u ? u.scheduled > (u.effectiveCapacity ?? u.capacity) : false;
      const sorted  = (byLine[line] || []).slice().sort((a, b) => (a.start_date?.getTime() || 0) - (b.start_date?.getTime() || 0));
      // Next changeover is "from now" — meaningless for a future day, so show a dash.
      const nxtCO   = isToday ? Dashboard._fmtNextCO(Dashboard._nextChangeover(sorted, now), now) : '—';
      return { line, color, sched, cap, effCap, pct, sev, barW, isOver, nxtCO };
    });
  },

  _renderLineStatus(matrix7?: DashboardUtilMatrix): void {
    const el = document.getElementById('line-status-panel');
    if (!el) return;
    const tasks = Dashboard._filteredTasks();
    const now   = Util.plantClock(Store.selectedPlant);
    const dayKeys = Dashboard._lsDayKeys(now);
    const activeKey = Dashboard._lsActiveKey(dayKeys);
    Dashboard._renderLsDayControl(dayKeys, activeKey);

    const byLine: Record<string, NimbusTask[]> = {};
    for (const l of Dashboard._selectedPlantLines()) byLine[l] = [];  // idle lines show up with zero rows
    for (const tk of tasks) { const l = tk.MACHINE || 'Unknown'; (byLine[l] ||= []).push(tk); }
    const lines = Object.keys(byLine).sort();

    if (!lines.length) {
      if (Dashboard._lsVL) { Dashboard._lsVL.destroy(); Dashboard._lsVL = null; }
      el.innerHTML = `<div class="empty-state" style="padding:24px;text-align:center;">${Util.t('empty.no_data_loaded')}</div>`;
      return;
    }

    // Same cached 7-day matrix the heatmap reads (built in render()), so the card's
    // day matches the heatmap column exactly; standalone callers get a fresh one.
    const matrix = matrix7 ?? Utilization.computeMatrix(now, 7);

    // Pre-compute row data so renderFn is a pure template with no heavy closures.
    const rowData = Dashboard._lsRowData(lines, byLine, matrix, activeKey, activeKey === dayKeys[0], now);

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
          `<div class="ls-code">${Util.escapeHtml(d.line)}</div>` +
          `<div class="ls-hours" title="${d.cap}h total capacity">${d.sched}/${d.effCap}h</div>` +
          `<div class="ls-bar-wrap"><div class="ls-bar${d.isOver ? ' over' : ''}" style="width:${d.barW}%;background:${d.color}"></div></div>` +
          `<div class="ls-pct${d.sev !== 'ok' ? ' ' + d.sev : ''}">${d.pct}%</div>` +
          `<div class="ls-co">${Util.escapeHtml(d.nxtCO)}</div></div>`,
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

    const alerts = AlertsUIAdapter._visibleAlerts().alerts.filter(a => {
      if (Dashboard._filterLines.size > 0 && a.line && !Dashboard._filterLines.has(a.line)) return false;
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
      ? Util.t('alert.summary_counts', { errors: errN, warnings: warnN, count: alerts.length })
      : Util.t('alert.summary_open', { count: alerts.length });

    if (!alerts.length) { list.innerHTML = `<div class="empty-state">${Util.t('empty.no_alerts')}</div>`; return; }
    list.innerHTML = alerts.slice(0, 8).map(a => `
      <div class="alert-row sev-${a.sev}" data-alert-action="focus" data-alert-id="${Util.escapeHtml(a.id)}">
        <span class="sev" data-sev="${a.sev}" aria-label="${a.sev === 'err' ? 'Error' : a.sev === 'warn' ? 'Warning' : 'Info'}"></span>
        <button type="button" class="msg alert-summary-focus" data-alert-action="focus" data-alert-id="${Util.escapeHtml(a.id)}">${Util.escapeHtml(Util.alertMessage(a))}</button>
        <span class="meta">${a.time ? Util.fmtDTShort(a.time) : ''}</span>
        <button type="button" class="dismiss" aria-label="${Util.t('btn.dismiss')}" data-alert-action="dismiss" data-alert-id="${Util.escapeHtml(a.id)}">×</button>
      </div>
    `).join('');
    if (alerts.length > 8) {
      list.insertAdjacentHTML('beforeend',
        `<button type="button" class="alert-summary-more" data-alert-action="show-all">${Util.t('btn.see_all_alerts', { count: alerts.length })}</button>`);
    }
  },

  _renderFirmedList(): void {
    const list = document.getElementById('firmed-list');
    if (!list) return;
    // Union count/list (frozen-horizon OR running OR manual; SAP firm is display-only) — see Engine.firmingStatus.
    const firmed = Dashboard._filteredTasks().filter(t => Engine.firmingStatus(t).firmed);
    if (!firmed.length) { list.innerHTML = `<div class="empty-state">${Util.t('empty.no_firmed_orders')}</div>`; return; }
    list.innerHTML = firmed.slice(0, 12).map(t => `
      <div class="firmed-row">
        <span class="pin">🔒</span>
        <span class="id">${Util.escapeHtml(t.MACHINE || '')}</span>
        <span class="name">${Util.escapeHtml(t.text || t.ORDER || t.id)}</span>
        <span class="when">${Util.fmtDTShort(t.start_date)}</span>
        <button class="btn btn-ghost sm" data-order-id="${Util.escapeHtml(String(t.id))}">${Util.t('btn.unfirm_dashboard')}</button>
      </div>
    `).join('');
    list.querySelectorAll<HTMLButtonElement>('[data-order-id]').forEach(button =>
      button.addEventListener('click', () => Dashboard._unfirm(button.dataset.orderId || '')));
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
    const plantNow = Util.plantClock(Store.selectedPlant);
    const startKey = Util.dayKey(Util.plantToday(Store.selectedPlant));
    const endDate  = new Date(plantNow); endDate.setDate(endDate.getDate() + horizonDays - 1);
    const endKey   = Util.dayKey(Util.startOfDay(endDate));

    // Build line × day map: line → dayKey → { lateHours, lateCount, lineLabel }
    const allLines = [...new Set([...Dashboard._selectedPlantLines(), ...tasks.map(t => t.MACHINE || 'Unknown')])].sort();
    const days: string[]  = [];
    {
      const d = Util.plantToday(Store.selectedPlant);
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
      const end = t.planning_status === 'needs_planning' ? plantNow : Util.scheduledEnd(t);
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
      return Dashboard._heatForeground(bg, inkTxt, onTxt);
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
    lines.forEach((line, li) => {
      const dot = Config.COLORS[li % Config.COLORS.length];
      html += `<div class="lh-line-label" title="${Util.escapeHtml(line)}"><span class="lh-dot" style="background:${dot}"></span><span class="lh-line-name">${Util.escapeHtml(line)}</span></div>`;
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
        const data = h > 0 ? ` data-line="${Util.escapeHtml(line)}" data-date="${Util.escapeHtml(dk)}"` : '';
        html += `<${tag}${typeAttr} class="lh-cell" style="background:${bg};color:${tc}" title="${Util.escapeHtml(title)}"${data}>${lbl}</${tag}>`;
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
    container.querySelectorAll<HTMLButtonElement>('button.lh-cell').forEach(cell =>
      cell.addEventListener('click', () => Dashboard._latenessDrill(cell.dataset.line || '', cell.dataset.date || '')));

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
    const rows = cell.tasks
      .slice()
      .sort((a, b) => Util.latenessHours(b) - Util.latenessHours(a))
      .slice(0, 12)
      .map(t => {
        const lh = Util.latenessHours(t);
        const days = lh / 24;
        const lateLbl = days >= 1 ? `+${days.toFixed(1)}d` : `+${lh.toFixed(1)}h`;
        const due = Util.dueDisplayDate(t);   // the due DAY, not the exclusive next-day 00:00 of a 24:00 close
        const sched = Util.scheduledEnd(t);
        return `<div class="lh-drill-row" role="button" tabindex="0" data-order-id="${Util.escapeHtml(String(t.id))}">
          <span class="lh-drill-id">${Util.escapeHtml(t.id).slice(0, 10)}</span>
          <span class="lh-drill-name">${Util.escapeHtml(t.text || t.ORDER || t.MATERIAL_DESCRIPTION || t.id)}</span>
          <span class="lh-drill-due">due ${due ? Util.fmtDTShort(due) : '—'}</span>
          <span class="lh-drill-sched">→ ${sched ? Util.fmtDTShort(sched) : '—'}</span>
          <span class="lh-drill-late">${lateLbl}</span>
        </div>`;
      }).join('');
    const more = cell.tasks.length > 12 ? `<div class="lh-drill-more">+${cell.tasks.length - 12} more</div>` : '';
    drill.innerHTML = `
      <div class="lh-drill-head">
        <strong>${Util.escapeHtml(line)}</strong> · ${Util.escapeHtml(dateStr)} ·
        <span>${cell.lateCount} late order${cell.lateCount === 1 ? '' : 's'} · ${cell.lateHours.toFixed(1)}h cumulative</span>
        <button class="lh-drill-close" onclick="NIMBUS.Dashboard._latenessDrillClear()" title="Close">×</button>
      </div>
      ${rows}${more}`;
    drill.querySelectorAll<HTMLElement>('.lh-drill-row').forEach(row => {
      row.addEventListener('click', () => Dashboard._jumpToOrder(row.dataset.orderId || ''));
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          Dashboard._jumpToOrder(row.dataset.orderId || '');
        }
      });
    });
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
  /** The alert-card headline for an alert type: the localized `alert.type.<type>` row, falling back to the
   *  title-cased type only when a locale has no row (U28). Plain text; callers escape it. */
  headlineFor(type: string): string {
    const key = `alert.type.${type}`;
    const row = Util.t(key);
    if (row && row !== key) return row;
    return String(type).replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  },
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
    if (action === 'show-all') { AlertsUIAdapter.toggleDrawer(); return; }
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
    // The anchor (the order, plus the pairwise peer when it exists in the store) centers the view on the
    // order(s) rather than the alert's day; a task-less alert passes none and the alert's day is centered.
    const anchorTaskId = a.taskId && Store.tasks[String(a.taskId)] ? String(a.taskId) : '';
    const anchorPeerId = anchorTaskId && a.peerId && Store.tasks[String(a.peerId)] ? String(a.peerId) : '';
    const anchor = anchorTaskId ? { taskId: anchorTaskId, ...(anchorPeerId ? { peerId: anchorPeerId } : {}) } : undefined;
    Timeline.gotoLineDay(a.line, Util.dayKey(a.time), () => {
      const taskId = a.taskId ? String(a.taskId) : '';
      const t = taskId ? Store.tasks[taskId] : undefined;
      // Line/day alerts (no order) and orders with no dates (not drawn) ring the alert's day cell.
      if (!t || !t.start_date || !t.end_date || !Timeline._tl) {
        Timeline.markGotoCell(a.line, Util.dayKey(a.time));
        return;
      }
      // Select through Selection (not vis directly) so every segment of a split order is
      // selected and the choice survives the next rebuild; its listener (Interaction.install,
      // wired at boot) shows the Inspector. Selection.set no-ops when the order is already the
      // sole selection, so show the Inspector ourselves in that one case. Select BEFORE marking:
      // the listener clears a marker whose order is not selected and must only see the old one.
      // A pairwise alert (overlap, tool-conflict) selects both orders when the peer exists in the store.
      const peerId = a.peerId && Store.tasks[String(a.peerId)] ? String(a.peerId) : '';
      const cur = Selection.ids();
      if (!peerId && cur.length === 1 && cur[0] === taskId) Inspector.show(t);
      else Selection.set(peerId ? [taskId, peerId] : [taskId]);
      Timeline.markGotoTask(taskId);
    }, anchor);
    // Close the alert drawer if it is open (the drawer would otherwise cover the Gantt).
    if (document.getElementById('alert-drawer')?.classList.contains('open')) AlertsUIAdapter.toggleDrawer();
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

    // -------- Cell context: scheduled hours, capacity, orders, changeovers
    const dayStart = Util.startOfDay(day)!;
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const cellEntries: Array<{ task: NimbusTask; scheduledHours: number; sortAt: Date }> = [];
    for (const task of Store.tasksArr) {
      if ((task.MACHINE || 'Unknown') !== line) continue;
      // The one day-attribution rule (OQ41): the same hours the utilization matrix and the overload alert put on this day.
      const minutes = Utilization.minutesByDay(task, line)[dayKey] || 0;
      if (minutes <= 0) continue;
      const onDay = Util.scheduleIntervals(task).filter(interval => interval.start < dayEnd && interval.end > dayStart);
      const sortAt = onDay[0]?.start ?? task.start_date
        ?? (task.end_date ? new Date(task.end_date.getTime() - Util.runHours(task) * Config.MS_HOUR) : null);   // VM12: finish-only row
      if (!sortAt) continue;
      cellEntries.push({ task, scheduledHours: minutes / 60, sortAt });
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
    const byCat: Record<string, NimbusAlert[]> = { capacity: [], conflicts: [], calendar: [], exceptions: [] };
    // The shared ALERT_CATEGORIES (./alert-profiles) carries a fifth 'setup' group, but this briefing renders
    // four fixed sections: setup diagnostics keep filing under 'exceptions' ("Other"), exactly as before.
    for (const a of matches) {
      const cat = categoryOf(a.type);
      byCat[cat === 'setup' ? 'exceptions' : cat].push(a);
    }

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
    // Union (frozen-horizon OR running OR manual; SAP firm is display-only) — see Engine.firmingStatus.
    const taskFirmed = (id: string) => { const t = Store.tasks?.[id]; return !!t && Engine.firmingStatus(t).firmed; };

    const renderChip = (id: string) => `
      <span class="ac-chip ${taskFirmed(id) ? 'firmed' : ''}" title="${Util.escapeHtml(taskPO(id))}">${Util.escapeHtml(taskPO(id))}</span>`;

    const renderCard = (a: NimbusAlert) => {
      // Headline + right-side numeric.
      let headline = Util.escapeHtml(AlertsUIAdapter.headlineFor(a.type));   // U28: localized per alert type
      let num = '';
      let chipsHtml = '';

      if (a.type === 'overload') {
        headline = AlertsUIAdapter.headlineFor('overload');
        num = `<span class="ac-card-num over">${(utilPct * 100).toFixed(0)}%</span>`;
        // Show the top contributing orders by run hours.
        const top = cellEntries.slice().sort((x, y) => y.scheduledHours - x.scheduledHours)
          .slice(0, 4).map(entry => entry.task);
        if (top.length) chipsHtml = `<div class="ac-chips">${top.map(t => renderChip(t.id)).join('')}</div>`;
      } else if (a.type === 'overlap' || a.type === 'tool-conflict') {
        headline = a.type === 'overlap' ? AlertsUIAdapter.headlineFor('overlap') : Util.t('ui.alert_headline_tool_conflict');
        const m = a.id.match(/^ovl-(.+)-(.+)$/);
        const peer = a.peerId ?? (m ? m[1] : null);
        const later = a.taskId ?? (m ? m[2] : null);
        if (peer && later) {
          chipsHtml = `<div class="ac-chips">${renderChip(peer)}<span class="ac-chip-sep">⇄</span>${renderChip(later)}</div>`;
        } else if (a.taskId) {
          chipsHtml = `<div class="ac-chips">${renderChip(a.taskId)}</div>`;
        }
      } else if (a.type === 'blackout') {
        headline = AlertsUIAdapter.headlineFor('blackout');
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
        headline = AlertsUIAdapter.headlineFor('closed');
      } else if (a.type === 'near-capacity') {
        headline = AlertsUIAdapter.headlineFor('near-capacity');
        num = `<span class="ac-card-num">${(utilPct * 100).toFixed(0)}%</span>`;
      }

      const gotoBtn = (a.taskId || (a.line && a.time))
        ? `<button class="btn sm" data-act="goto" data-id="${Util.escapeHtml(a.id)}">Go to</button>` : '';

      return `
        <div class="ac-card ${CALENDAR_ALERT_TYPES.has(a.type) ? 'ac-card-calendar' : `ac-card-${a.sev}`}">
          <div class="ac-card-headline">
            <span class="ac-card-sev">${sevIcon[a.sev] || '•'}</span>
            <span>${headline}</span>
            ${num}
          </div>
          <div class="ac-card-msg">${Util.escapeHtml(Util.alertMessage(a))}</div>
          ${chipsHtml}
          <div class="ac-card-actions">
            ${gotoBtn}
            <button class="btn sm" data-act="dismiss" data-id="${Util.escapeHtml(a.id)}">Dismiss</button>
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
            <span class="ac-title">${Util.escapeHtml(line)}</span>
            <span class="ac-date">${dateLabel}</span>
            <button class="ac-x" data-act="close" aria-label="${Util.t('btn.close')}">×</button>
          </div>
          <div class="ac-verdict ac-verdict-${verdictSev}">
            ${errCt ? '🔴' : '🟡'} ${Util.escapeHtml(verdict)}
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
    if (isOpen) {
      AlertsUIAdapter.renderDrawer();
      d.querySelector<HTMLElement>('.drawer-head button')?.focus();
      d.onkeydown = e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); AlertsUIAdapter.toggleDrawer(); }
      };
    } else document.getElementById('alert-bell')?.focus();
  },

  _renderAlertRow(a: NimbusAlert): string {
    const sevIcon: Record<string, string> = { err: '✖', warn: '⚠', info: 'ℹ' };
    const isCalendar = CALENDAR_ALERT_TYPES.has(a.type);
    const ico        = isCalendar ? '⊘' : (sevIcon[a.sev] || '•');
    const fixable  = FIXABLE_ALERT_TYPES.has(a.type);
    const override = OVERRIDE_ALERT_TYPES.has(a.type) && a.taskId != null;
    const msg = a.msgKey ? Util.t(a.msgKey, a.msgVars ?? {}) : a.msg;
    // An acknowledged alert is only listed when "Show acknowledged" is on; it says who hid it and until when.
    const ack = ackLabel(AlertProfileMatches.current().acked.get(a.id), (k, v) => Util.t(k, v));
    return `<div class="alert-row alert-${a.sev}${isCalendar ? ' alert-calendar' : ''}" data-id="${Util.escapeHtml(a.id)}">` +
      `<span class="alert-ico">${ico}</span>` +
      `<span class="alert-msg">${Util.escapeHtml(msg)}` +
        (ack ? ` <span class="badge badge-info am-ack-badge" title="${Util.escapeHtml(ack)}">${Util.escapeHtml(ack)}</span>` : '') +
      `</span>` +
      `<div class="alert-actions">` +
        ((a.taskId != null || (a.line && a.time)) ? `<button class="btn btn-ghost sm" data-alert-action="focus" data-alert-id="${Util.escapeHtml(a.id)}">${Util.t('btn.go_to')}</button>` : '') +
        (fixable  ? `<button class="btn-fix" title="${Util.t('tip.fix_alert')}" data-alert-action="fix" data-alert-id="${Util.escapeHtml(a.id)}">${Util.t('btn.fix_it')}</button>` : '') +
        (override ? `<button class="btn btn-ghost sm" data-alert-action="override" data-task-id="${Util.escapeHtml(a.taskId)}">${Util.t('btn.override')}</button>` : '') +
        `<button class="btn btn-ghost sm" data-alert-action="dismiss" data-alert-id="${Util.escapeHtml(a.id)}">${Util.t('btn.dismiss')}</button>` +
      `</div></div>`;
  },

  /** Session-only "Show all" from the drawer footer: lists the alerts the active profile hides. Cleared on a plant change. */
  _profileOverride: false,

  /**
   * What the bell, the drawer and the Dashboard summary list: the plant's alerts inside the alert horizon, minus
   * acknowledged ones (unless "Show acknowledged" is on), narrowed to the active profile's matches (unless the
   * profile is All alerts or the override is on). `hiddenCount` is the horizon's share of what is left out,
   * `profileHidden` the profile's. Gantt outlines, day cells, `Store.alertsByTask()` consumers, the command
   * palette and the confidence score deliberately do NOT go through here: they stay plant-wide.
   */
  _visibleAlerts(): { alerts: NimbusAlert[]; hiddenCount: number; hz: number | null; profileHidden: number; profileName: string } {
    const plantRow = Store.masterData?.plants?.find(p => p.plant === Store.selectedPlant);
    const hz = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? null;
    const cutoff = typeof hz === 'number'
      ? new Date(Util.plantClock(Store.selectedPlant).getTime() + hz * Config.MS_MIN) : null;
    const plantLines = new Set(Store.linesForSelectedPlant());
    const scoped = Store.alerts.filter(a => !a.line || plantLines.has(a.line));
    const inHorizon = cutoff ? scoped.filter(a => !a.time || a.time <= cutoff) : scoped;
    const m = AlertProfileMatches.current();
    const unacked = Store.pref('alertsShowAcknowledged') === true ? inHorizon : inHorizon.filter(a => !m.acked.has(a.id));
    const filtering = m.profileId !== ALL_ALERTS_PROFILE_ID && !AlertsUIAdapter._profileOverride;
    const alerts = filtering ? unacked.filter(a => m.alertIds.has(a.id)) : unacked;
    return {
      alerts, hiddenCount: scoped.length - inHorizon.length, hz,
      profileHidden: unacked.length - alerts.length, profileName: m.profile.name,
    };
  },

  /** Drawer footer links ("Show all" / "Back to profile"): flip the session override and repaint bell, drawer and summary. */
  _handleFooterAction(e: { target: unknown }): void {
    const target = e.target as Element | null;
    const action = target?.closest?.<HTMLElement>('[data-alert-action]')?.dataset.alertAction;
    if (action !== 'profile-show-all' && action !== 'profile-back') return;
    AlertsUIAdapter._profileOverride = action === 'profile-show-all';
    AlertsUIAdapter._renderFollowers();
  },

  /** Repaint everything that follows the profile and acknowledgements. */
  _renderFollowers(): void {
    AlertsUIAdapter.renderBell();
    // Same guard as the shell's own repaint: a closed drawer is rebuilt when it opens, not on every producer fanout.
    if (document.getElementById('alert-drawer')?.classList.contains('open')) AlertsUIAdapter.renderDrawer();
    Dashboard._renderAlertSummary();
  },

  dismissVisible(): void {
    Alerts.dismissAll(AlertsUIAdapter._visibleAlerts().alerts.map(a => a.id));
  },

  renderDrawer() {
    const body = document.getElementById('alert-drawer-body');
    if (!body) return;
    body.onclick = AlertsUIAdapter._handleAction;
    const { alerts, hiddenCount, hz, profileHidden, profileName } = AlertsUIAdapter._visibleAlerts();
    const footer = document.getElementById('alert-drawer-footer');
    if (footer) {
      const horizonNote = hiddenCount ? Util.t('alert.horizon_hidden_duration', {
        count: hiddenCount, duration: Util.fmtHours((hz as number) / 60),
      }) : '';
      const override = AlertsUIAdapter._profileOverride && AlertProfileMatches.current().profileId !== ALL_ALERTS_PROFILE_ID;
      footer.hidden = !horizonNote && !profileHidden && !override;
      footer.onclick = AlertsUIAdapter._handleFooterAction;
      if (!profileHidden && !override) {
        footer.textContent = horizonNote;
      } else {
        const esc = Util.escapeHtml;
        const link = (action: string, label: string) =>
          ` <button type="button" class="btn btn-ghost sm" data-alert-action="${action}">${esc(label)}</button>`;
        footer.innerHTML = (horizonNote ? `<div>${esc(horizonNote)}</div>` : '')
          + (override
            ? `<div>${esc(Util.t('alert.profile_override_on'))}${link('profile-back', Util.t('alert.profile_back'))}</div>`
            : `<div>${esc(Util.t('alert.profile_hidden', { n: profileHidden, name: profileName }))}${link('profile-show-all', Util.t('alert.profile_show_all'))}</div>`);
      }
    }

    if (!alerts.length) {
      if (AlertsUIAdapter._drawerVL) { AlertsUIAdapter._drawerVL.destroy(); AlertsUIAdapter._drawerVL = null; }
      body.innerHTML = `<div class="empty-state" style="padding:24px;color:var(--fg-mute);">${Util.t('empty.no_active_alerts')}</div>`;
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

  },
/* ----- BELL BADGE ------------------------------------------------------ */
  renderBell() {
    const badge = document.getElementById('alert-badge');
    const bell  = document.getElementById('alert-bell');
    if (!badge || !bell) return;
    const visible = AlertsUIAdapter._visibleAlerts().alerts;
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

/* The bell, drawer and Dashboard summary follow the active profile and the acknowledgements. The producer fans out
   on a profile, "view as", acknowledgement or alert change (never a Store event); `alerts:change` already repaints
   the same three through the shell. A plant change drops the session-only "Show all" override. */
AlertProfileMatches.subscribe(() => { AlertsUIAdapter._renderFollowers(); });
Store.subscribe(evt => {
  if (evt.type !== 'plant:selected' || !AlertsUIAdapter._profileOverride) return;
  AlertsUIAdapter._profileOverride = false;
  AlertsUIAdapter._renderFollowers();
}, 'AlertsUIAdapter.profileOverrideReset');
