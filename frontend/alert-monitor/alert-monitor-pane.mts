/* =============================================================================
   ALERT MONITOR PANE — the "Alert Monitor" top-level tab (#alerts-tab).

   Lifecycle (the DistributionPane shape): the shell calls init() once on first entry,
   render() on every entry and setActive(false) on leave. `_active` gates every Store /
   producer subscriber so a hidden pane does no work.

   Task 11 scope: toolbar, KPI strip, pinned banner and the empty states. The leverage
   panel (#am-leverage, Task 13) and the alert groups (#am-groups, Task 12) are filled by
   later tasks through the two hook functions at the bottom of the paint path.

   Reads the always-on producer (AlertProfileMatches.current()); never emits a Store
   event. "View as" is session-only (setSessionProfile); "Make my default" is the one
   control that writes the persisted pref.
   ========================================================================== */

import { Store } from '../platform/store.mjs';
import type { StoreEvent } from '../platform/store.mjs';
import { Util, Config, Modal, Toast, VirtualList, ErrorLog } from '../platform/foundation.mjs';
import { Session } from '../security/session.mjs';
import type { AlertAck, AlertProfile, NimbusTask } from '../platform/types.mjs';
import { AlertProfileMatches } from '../insights/alert-profile-matches.mjs';
import type { AlertProfileMatchSet } from '../insights/alert-profile-matches.mjs';
import { AlertProfileClient } from '../insights/alert-profile-client.mjs';
import {
  ALL_ALERTS_PROFILE_ID, resolveActiveProfileId, impactPoints, compareAlerts, groupAlerts, anchorTime, alertDayOffset,
} from '../insights/alert-profiles.mjs';
import type { AlertGroup, GroupContext } from '../insights/alert-profiles.mjs';
import { Alerts, Compute, Utilization, buildPlantSnapshot } from '../insights/services.mjs';
import { groupLeverage, analyzeLeverage, replayWithMinutes } from '../insights/alert-leverage.mjs';
import type { LeverageItem, LeverageInput, LeverageRunner } from '../insights/alert-leverage.mjs';
import { Sandbox } from '../optimization/sandbox.mjs';
import {
  MONITOR_GROUP_BYS, MONITOR_SORTS, MONITOR_CATEGORIES, GROUP_ROW_CAP, ROW_H, DIAG_H,
  kpiSummary, windowSummary, viewFor, visibleAlertsFor, horizonAlerts, emptyStateFor,
  rowActionsFor, rowHtml, colsHtml, diagnoseHtml, groupHeadHtml, groupTotals, groupLabel,
  relativeDaysText, formatPairKey, fmtNum,
  levSectionHtml, levTitle, levSummaryText, levPairsForReview,
} from './alert-monitor-model.mjs';
import type { MonitorView, EmptyKind, KpiSummary, RowView, LevCtx } from './alert-monitor-model.mjs';

const t = (key: string, vars?: Record<string, string | number>): string => Util.t(key, vars);
const esc = (s: unknown): string => Util.escapeHtml(String(s ?? ''));

interface PaintState {
  plant: string | null;
  m: AlertProfileMatchSet;
  profiles: AlertProfile[];
  profilesLoaded: boolean;
  view: MonitorView;
  defaultId: string;
  showAcked: boolean;
  /** Every alert of the plant's lines (profile and acknowledgement ignored) — what the leverage panel works on (D10). */
  scoped: NimbusAlert[];
  /** What the profile matched (acknowledged hidden unless asked) — the KPI strip counts these. */
  visible: NimbusAlert[];
  /** What the groups list: `visible`, or the focus set (which bypasses the profile). */
  listed: NimbusAlert[];
  /** Focused alerts the profile did not match (the focus chip says so). */
  focusOutside: number;
  kpi: KpiSummary;
  empty: EmptyKind;
  scopedCount: number;
  /** The plant clock now — the start of the impact horizon. */
  horizonStart: Date;
  horizonMinutes: number;
  plantToday: Date;
}

/** The ambient `NIMBUS` members this pane reaches (the classic-script bridge; never a real import). */
interface AmNimbus {
  AlertsUIAdapter?: { focus?(id: string): void; showForCell?(line: string, dayKey: string): void; headlineFor?(type: string): string };
  Table?: { _openOverrideModalForId?(id: string): void; _onPoMatApply?(): void };
  App?: { gotoGanttSub?(sub: string): void; goto?(tab: string): void; gotoMasterSub?(sub: string): void };
  Timeline?: { gotoLineDay?(line: string, dateStr: string): void };
  OptimizerPreview?: { active?: boolean };
  Inspector?: { _formatRuntimeBasis?(task: NimbusTask): string };
}
const _nim = (): AmNimbus => (globalThis as unknown as { NIMBUS?: AmNimbus }).NIMBUS ?? {};

/** Everything a row / group card needs that is derived once per paint. */
interface RowCtx {
  s: PaintState;
  ctx: GroupContext;
  pointsOf: (a: NimbusAlert) => number;
  lateOf: (taskId: string) => number;
}

const GROUP_LABEL_KEY: Record<string, string> = {
  category: 'am.group_category', type: 'am.group_type', line: 'am.group_line',
  day: 'am.group_day', order: 'am.group_order', none: 'am.group_none',
};
const SORT_LABEL_KEY: Record<string, string> = {
  impact: 'am.sort_impact', time: 'am.sort_time', severity: 'am.sort_severity', orders: 'am.sort_orders',
};

let _wired = false;
let _active = false;
let _shellRoot: HTMLElement | null = null;
const _lastHtml = new Map<string, string>();
let _comboFiltered: Array<{ id: string; label: string }> = [];
let _comboActive = -1;

// Transient view state — reset on plant change (and by resetView()).
const _collapsed = new Set<string>();     // group keys the user folded
const _showAll = new Set<string>();       // group keys expanded past the row cap
const _diagOpen = new Set<string>();      // alert ids whose inline diagnose panel is open
let _focusIds: Set<string> | null = null; // "Show alerts" focus: list only these, bypassing the profile
let _focusTitle = '';
let _lastPlant: string | null | undefined;
let _groupsByKey = new Map<string, AlertGroup>();
let _vl: VirtualList<NimbusAlert> | null = null;   // group-by none only
let _vlEl: HTMLElement | null = null;
let _rowCtx: RowCtx | null = null;

/* ---------------------------------------------------------------------------
   DOM helpers
   ------------------------------------------------------------------------- */
function _el<E extends HTMLElement = HTMLElement>(id: string): E | null {
  return document.getElementById(id) as E | null;
}

/** innerHTML only when it changed — avoids re-parsing identical markup on every producer tick. */
function _setHtml(id: string, html: string): boolean {
  const el = _el(id);
  if (!el || _lastHtml.get(id) === html) return false;
  _lastHtml.set(id, html);
  el.innerHTML = html;
  return true;
}

function _setText(id: string, text: string): void {
  const el = _el(id);
  if (el && el.textContent !== text) el.textContent = text;
}


/* ---------------------------------------------------------------------------
   Shell — built once into #alerts-tab
   ------------------------------------------------------------------------- */
function _shellHtml(): string {
  const groupBtns = MONITOR_GROUP_BYS.map(g =>
    `<button type="button" class="seg-btn" data-am-group="${g}" aria-pressed="false">${esc(t(GROUP_LABEL_KEY[g]))}</button>`).join('');
  const sortOpts = MONITOR_SORTS.map(s => `<option value="${s}">${esc(t(SORT_LABEL_KEY[s]))}</option>`).join('');
  const legend = MONITOR_CATEGORIES.map(c =>
    `<span class="am-cat-item"><span class="am-cat-swatch am-cat-${c}" aria-hidden="true"></span>${esc(t(`ape.cat_${c}`))}</span>`).join('');
  return `
<div class="am-toolbar" id="am-toolbar">
  <span class="am-eyebrow">${esc(t('am.profile_label'))}</span>
  <div class="am-profile-wrap">
    <div class="us-combo" id="am-profile-combo">
      <input type="text" id="am-profile-input" class="us-combo-input" role="combobox" autocomplete="off"
             aria-autocomplete="list" aria-expanded="false" aria-controls="am-profile-dropdown"
             aria-label="${esc(t('am.view_as'))}" title="${esc(t('am.view_as'))}" placeholder="${esc(t('am.profile_ph'))}">
      <div class="us-combo-dropdown" id="am-profile-dropdown" role="listbox" hidden></div>
    </div>
  </div>
  <button type="button" class="btn sm" id="am-make-default" data-am-action="make-default" hidden>${esc(t('am.make_default'))}</button>
  <span class="badge badge-info" id="am-is-default" hidden>${esc(t('am.is_default'))}</span>
  <span class="am-window" id="am-window"></span>
  <button type="button" class="btn sm btn-ghost" id="am-manage" data-am-action="manage">${esc(t('am.manage_profiles'))}</button>
  <label class="am-toggle"><input type="checkbox" id="am-t-highlight" data-am-toggle="highlight"><span>${esc(t('am.gantt_highlight'))}</span></label>
  <label class="am-toggle"><input type="checkbox" id="am-t-ack" data-am-toggle="ack"><span>${esc(t('am.ack_show'))}</span></label>
  <span class="spacer"></span>
  <span class="plant-badge" id="am-plant-badge" hidden></span>
  <div class="am-toolbar-row">
    <span class="am-eyebrow">${esc(t('am.group_by'))}</span>
    <div class="am-seg" id="am-seg" role="group" aria-label="${esc(t('am.group_by'))}">${groupBtns}</div>
    <span class="am-eyebrow">${esc(t('am.sort'))}</span>
    <select class="am-sort" id="am-sort" data-am-sort aria-label="${esc(t('am.sort'))}">${sortOpts}</select>
    <span class="spacer"></span>
    <div class="am-cat-legend" id="am-cat-legend" role="group" aria-label="${esc(t('legend.pm_capacity_t'))}">${legend}</div>
  </div>
</div>
<div class="am-kpi-strip" id="am-kpis"></div>
<div class="am-scroll" id="am-scroll">
  <div id="am-banner"></div>
  <div id="am-prompt"></div>
  <div id="am-leverage"></div>
  <div class="am-focus-chip" id="am-focus-chip" hidden></div>
  <div id="am-groups"></div>
</div>`;
}

function _ensureShell(): void {
  const root = document.getElementById('alerts-tab') as HTMLElement | null;
  if (!root || root === _shellRoot) return;
  _shellRoot = root;
  _lastHtml.clear();
  root.innerHTML = _shellHtml();
  root.addEventListener('click', _onClick);
  root.addEventListener('change', _onChange);
  _wireCombo();
}

/* ---------------------------------------------------------------------------
   Combobox ("View as") — copied from SessionUIAdapter._initDefaultPlantCombo; the shell's
   copy is private to that adapter. Searchable single-select, never chips.
   ------------------------------------------------------------------------- */
function _comboOptions(): Array<{ id: string; label: string }> {
  const plant = Store.selectedPlant;
  const profiles = (plant ? AlertProfileClient.cached(plant) : null) ?? [];
  return [{ id: ALL_ALERTS_PROFILE_ID, label: t('am.profile_all') }, ...profiles.map(p => ({ id: p.id, label: p.name }))];
}

function _viewedLabel(): string {
  const m = AlertProfileMatches.current();
  return m.profileId === ALL_ALERTS_PROFILE_ID ? t('am.profile_all') : m.profile.name;
}

function _defaultProfileId(plant: string, profiles: AlertProfile[]): string {
  type Arg = Parameters<typeof resolveActiveProfileId>[1];
  return resolveActiveProfileId(plant, Store.userSettings as Arg, Store.roleDefaults as Arg, profiles);
}

/** "View as": session-only. Choosing the user's own default just clears the override. */
function _chooseProfile(id: string): void {
  const plant = Store.selectedPlant;
  if (!plant) return;
  const profiles = AlertProfileClient.cached(plant) ?? [];
  AlertProfileMatches.setSessionProfile(id === _defaultProfileId(plant, profiles) ? null : id);
}

function _wireCombo(): void {
  const input = _el<HTMLInputElement>('am-profile-input');
  const dropdown = _el('am-profile-dropdown');
  if (!input || !dropdown) return;

  const open = () => { dropdown.hidden = false; input.setAttribute('aria-expanded', 'true'); };
  const close = () => { dropdown.hidden = true; _comboActive = -1; input.setAttribute('aria-expanded', 'false'); };
  const reflect = () => { input.value = _viewedLabel(); };
  const highlight = () => {
    const items = dropdown.querySelectorAll('.us-combo-option');
    items.forEach((el, i) => el.classList.toggle('active', i === _comboActive));
    const a = items[_comboActive] as HTMLElement | undefined;
    if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
  };
  const choose = (id: string) => { _chooseProfile(id); reflect(); close(); input.blur(); };

  const renderList = (query: string) => {
    const all = _comboOptions();
    const q = (query || '').trim().toLowerCase();
    const fq = q === _viewedLabel().toLowerCase() ? '' : q;
    _comboFiltered = fq ? all.filter(o => o.label.toLowerCase().includes(fq)) : all.slice();
    const plant = Store.selectedPlant;
    const defId = plant ? _defaultProfileId(plant, (AlertProfileClient.cached(plant) ?? [])) : ALL_ALERTS_PROFILE_ID;
    const viewed = AlertProfileMatches.current().profileId;
    if (!_comboFiltered.length) {
      dropdown.innerHTML = `<div class="us-combo-empty">${esc(t('us.no_matches'))}</div>`;
      _comboActive = -1;
      return;
    }
    const hint = all.length === 1 && !fq ? `<div class="us-combo-empty">${esc(t('am.profile_none'))}</div>` : '';
    dropdown.innerHTML = _comboFiltered.map((o, i) =>
      `<div class="us-combo-option${o.id === viewed ? ' selected' : ''}" role="option" aria-selected="${o.id === viewed}" data-profile="${esc(o.id)}" data-idx="${i}">`
      + `<span>${esc(o.label)}</span>${o.id === defId ? `<span class="us-combo-option-prefix">${esc(t('am.is_default'))}</span>` : ''}</div>`).join('') + hint;
    _comboActive = Math.max(0, _comboFiltered.findIndex(o => o.id === viewed));
    highlight();
  };

  dropdown.addEventListener('mousedown', (e: Event) => {
    e.preventDefault();
    const opt = (e.target as HTMLElement | null)?.closest?.('[data-profile]') as HTMLElement | null;
    if (opt?.dataset.profile) choose(opt.dataset.profile);
  });
  input.addEventListener('focus', () => { renderList(input.value); open(); });
  input.addEventListener('input', () => { renderList(input.value); open(); });
  input.addEventListener('keydown', (e: Event) => {
    const k = (e as KeyboardEvent).key;
    if (dropdown.hidden) {
      if (k === 'ArrowDown' || k === 'Enter') { renderList(input.value); open(); e.preventDefault(); }
      return;
    }
    if (k === 'ArrowDown')    { e.preventDefault(); _comboActive = Math.min(_comboActive + 1, _comboFiltered.length - 1); highlight(); }
    else if (k === 'ArrowUp') { e.preventDefault(); _comboActive = Math.max(_comboActive - 1, 0); highlight(); }
    else if (k === 'Enter')   { e.preventDefault(); const o = _comboFiltered[_comboActive]; if (o) choose(o.id); }
    else if (k === 'Escape')  { close(); reflect(); input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { close(); reflect(); }, 120));
}

/* ---------------------------------------------------------------------------
   Actions
   ------------------------------------------------------------------------- */
function _persistView(patch: Partial<MonitorView>): void {
  const m = AlertProfileMatches.current();
  const stored = (Store.pref('alertMonitorView') as Record<string, unknown> | null | undefined) ?? {};
  const cur = viewFor(m.profileId, stored as Parameters<typeof viewFor>[1], m.profile);
  Session.setPref('alertMonitorView', { ...stored, [m.profileId]: { ...cur, ...patch } });
  _paint();
}

function _makeDefault(): void {
  const plant = Store.selectedPlant;
  if (!plant) return;
  const m = AlertProfileMatches.current();
  const existing = (Store.pref('alertProfileByPlant') as Record<string, string> | null | undefined) ?? {};
  Session.setPref('alertProfileByPlant', { ...existing, [plant]: m.profileId });
  AlertProfileMatches.setSessionProfile(null);   // the pref now says the same thing
}

function _onClick(e: Event): void {
  const target = e.target as HTMLElement | null;
  const seg = target?.closest?.('[data-am-group]') as HTMLElement | null;
  if (seg?.dataset.amGroup) { _persistView({ groupBy: seg.dataset.amGroup as MonitorView['groupBy'] }); return; }
  const lev = target?.closest?.('[data-lev-action]') as HTMLElement | null;
  if (lev?.dataset.levAction) { _onLevAction(lev.dataset.levAction, lev.dataset.levKey ?? ''); return; }
  const btn = target?.closest?.('[data-am-action]') as HTMLElement | null;
  switch (btn?.dataset.amAction) {
    case 'make-default': _makeDefault(); break;
    case 'switch-all':   AlertProfileMatches.setSessionProfile(ALL_ALERTS_PROFILE_ID); break;
    case 'manage':
    case 'create-profile':
      // TODO(Task 14): open the alert-profile editor modal.
      break;
    case 'kpi-confidence': {
      const conf = (globalThis as unknown as { NIMBUS?: { Confidence?: { showBreakdown?: () => void } } }).NIMBUS?.Confidence;
      conf?.showBreakdown?.();
      break;
    }
    case 'toggle-group': _toggleGroup(btn!.dataset.groupKey ?? ''); break;
    case 'show-all':
      if (btn!.dataset.groupKey) { _showAll.add(btn!.dataset.groupKey); _paint(); }
      break;
    case 'group-dismiss': _dismissGroup(btn!.dataset.groupKey ?? ''); break;
    case 'group-open-table': _openGroupInTable(btn!.dataset.groupKey ?? ''); break;
    case 'clear-focus': AlertMonitorPane.clearFocus(); break;
    case 'lev-show-more': _levShowAll = true; _paint(); break;
    default: {
      const act = target?.closest?.('[data-alert-action]') as HTMLElement | null;
      if (act?.dataset.alertAction) _onAlertAction(act);
      break;
    }
  }
}

function _toggleGroup(key: string): void {
  if (!key) return;
  if (_collapsed.has(key)) _collapsed.delete(key); else _collapsed.add(key);
  _paint();
}

/** Dismiss every alert of one group (confirm above 5, the way the drawer protects "dismiss all"). */
function _dismissGroup(key: string): void {
  const g = _groupsByKey.get(key);
  if (!g || !g.alerts.length) return;
  const ids = g.alerts.map(a => a.id);
  const n = ids.length;
  if (n <= 5) { Alerts.dismissAll(ids); return; }
  void Modal.confirm({ title: t('am.group_dismiss_n', { n }), message: t('am.group_dismiss_confirm', { n }), tone: 'danger' })
    .then(ok => { if (ok) Alerts.dismissAll(ids); });
}

/**
 * "Open these N orders in the table": there is no scroll-to-row API, so the PO/Material paste
 * filter stands in — fill it with the order numbers, apply it, then show the Orders sub-tab.
 */
function _openGroupInTable(key: string): void {
  const g = _groupsByKey.get(key);
  if (g) _openOrdersInTable(g.orderIds);
}

/** Shared by the group heads and the leverage cards: filter the Orders table to these order ids. */
function _openOrdersInTable(orderIds: Iterable<string>): void {
  const nums: string[] = [];
  for (const id of orderIds) {
    const task = Store.tasks[id];
    const no = task ? String(task.ORDER ?? task.PRODUCTION_ORDER ?? '').trim() : '';
    if (no && !nums.includes(no)) nums.push(no);
  }
  const nim = _nim();
  const ta = document.getElementById('tbl-flt-pomat-textarea') as HTMLTextAreaElement | null;
  if (!nums.length || !ta || typeof nim.Table?._onPoMatApply !== 'function') {
    Toast.show(t('am.table_unavailable'), 'warn');
    return;
  }
  ta.value = nums.join('\n');
  nim.Table._onPoMatApply();
  nim.App?.gotoGanttSub?.('orders');
}

/** Row / group-head actions — the same vocabulary and calls as AlertsUIAdapter._handleAction (the drawer). */
function _onAlertAction(trigger: HTMLElement): void {
  const action = trigger.dataset.alertAction;
  const alertId = trigger.dataset.alertId;
  if (!alertId) return;
  const nim = _nim();
  switch (action) {
    case 'focus': nim.AlertsUIAdapter?.focus?.(alertId); break;
    case 'fix':
      if (Sandbox.active) return;
      Alerts.applyFix(alertId);
      break;
    case 'override': {
      if (Sandbox.active) return;
      const taskId = trigger.dataset.taskId;
      if (taskId) nim.Table?._openOverrideModalForId?.(taskId);
      break;
    }
    case 'dismiss': Alerts.dismiss(alertId); break;
    case 'diagnose': {
      const a = Store.alerts.find(x => x.id === alertId);
      if (!a) return;
      const kind = rowActionsFor(a).diagnose;
      if (kind === 'cell' && a.line && a.time) {
        nim.AlertsUIAdapter?.showForCell?.(a.line, Util.dayKey(a.time));
      } else if (kind === 'order') {
        if (_diagOpen.has(alertId)) _diagOpen.delete(alertId); else _diagOpen.add(alertId);
        _paint();
      }
      break;
    }
    default: break;   // 'ack' opens its modal in Task 15; the button renders disabled until then
  }
}

function _onChange(e: Event): void {
  const target = e.target as HTMLInputElement | null;
  const mins = target?.closest?.('[data-lev-minutes]') as HTMLInputElement | null;
  if (mins?.dataset.levMinutes) { void _levMinutesEntered(mins.dataset.levMinutes, String(mins.value ?? '')); return; }
  const tog = target?.closest?.('[data-am-toggle]') as HTMLInputElement | null;
  if (tog) {
    if (tog.dataset.amToggle === 'highlight') Session.setPref('alertProfileGanttHighlight', !!tog.checked);
    else if (tog.dataset.amToggle === 'ack') Session.setPref('alertsShowAcknowledged', !!tog.checked);
    return;
  }
  const sort = target?.closest?.('[data-am-sort]') as HTMLSelectElement | null;
  if (sort && MONITOR_SORTS.includes(sort.value as MonitorView['sort'])) _persistView({ sort: sort.value as MonitorView['sort'] });
}

/* ---------------------------------------------------------------------------
   Paint
   ------------------------------------------------------------------------- */
function _gatherState(): PaintState {
  const plant = Store.selectedPlant ?? null;
  const m = AlertProfileMatches.current();
  const profilesRaw = plant ? AlertProfileClient.cached(plant) : null;
  const profiles = profilesRaw ?? [];
  const stored = Store.pref('alertMonitorView') as Parameters<typeof viewFor>[1];
  const view = viewFor(m.profileId, stored, m.profile);
  const showAcked = Store.pref('alertsShowAcknowledged') === true;

  const plantRow = plant ? Store.masterPlant(plant) : null;
  const clock = plant ? Util.plantClock(plant) : new Date();
  const hz = plantRow?.alt_flag_horizon ?? (Store.userSettings?.alertHorizonMinutes as number | undefined) ?? null;
  const cutoff = typeof hz === 'number' ? new Date(clock.getTime() + hz * Config.MS_MIN) : null;
  const lines = new Set(plant ? Store.linesForSelectedPlant() : []);
  const scoped = horizonAlerts(Store.alerts, lines, null);
  const inHorizon = horizonAlerts(Store.alerts, lines, cutoff);
  const visible = visibleAlertsFor(scoped, m.alertIds, m.acked, showAcked);
  const focus = _focusIds;
  const listed = focus ? scoped.filter(a => focus.has(a.id) && (showAcked || !m.acked.has(a.id))) : visible;
  const focusOutside = focus ? listed.filter(a => !m.alertIds.has(a.id)).length : 0;

  const confMin = plantRow?.conf_score_horizon ?? (Store.userSettings?.confidenceHorizonMinutes as number | undefined) ?? 20160;
  const confCutoff = new Date(clock.getTime() + confMin * Config.MS_MIN);
  const inConfWindow = scoped.filter(a => !a.time || a.time <= confCutoff).length;
  const score = (globalThis as unknown as { NIMBUS?: { Confidence?: { _score?: number } } }).NIMBUS?.Confidence?._score;

  const matchedCount = scoped.filter(a => m.alertIds.has(a.id)).length;
  return {
    plant, m, profiles, profilesLoaded: profilesRaw != null, view,
    defaultId: plant ? _defaultProfileId(plant, profiles) : ALL_ALERTS_PROFILE_ID,
    showAcked, scoped, visible, listed, focusOutside, scopedCount: scoped.length,
    kpi: kpiSummary(visible, inHorizon, hz, score, inConfWindow),
    // A focus set always lists something or says nothing is left; the profile empty states don't apply to it.
    empty: focus
      ? (listed.length ? null : 'no-alerts')
      : emptyStateFor({
        plant, scopedCount: scoped.length, matchedCount, visibleCount: visible.length,
        isAllAlerts: m.profileId === ALL_ALERTS_PROFILE_ID,
      }),
    horizonStart: clock, horizonMinutes: confMin,
    plantToday: plant ? Util.plantToday(plant) : (Util.startOfDay(clock) as Date),
  };
}

function _syncToolbar(s: PaintState): void {
  const input = _el<HTMLInputElement>('am-profile-input');
  if (input) {
    input.disabled = !s.plant;
    if (document.activeElement !== input) input.value = s.plant ? _viewedLabel() : '';
  }
  const isDefault = !!s.plant && s.m.profileId === s.defaultId;
  const mk = _el('am-make-default');
  if (mk) mk.hidden = !s.plant || isDefault;
  const badge = _el('am-is-default');
  if (badge) badge.hidden = !isDefault;

  const summary = s.plant ? windowSummary(s.m.profile, t) : '';
  _setText('am-window', summary);
  const win = _el('am-window');
  if (win) win.title = summary;

  const hi = _el<HTMLInputElement>('am-t-highlight');
  if (hi) hi.checked = Store.pref('alertProfileGanttHighlight') !== false;
  const ak = _el<HTMLInputElement>('am-t-ack');
  if (ak) ak.checked = s.showAcked;

  const pb = _el('am-plant-badge');
  if (pb) { pb.hidden = !s.plant; pb.textContent = s.plant ?? ''; }

  document.querySelectorAll<HTMLElement>('[data-am-group]').forEach(b => {
    const on = b.dataset.amGroup === s.view.groupBy;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const sort = _el<HTMLSelectElement>('am-sort');
  if (sort) sort.value = s.view.sort;
}

function _kpiHtml(s: PaintState): string {
  const k = s.kpi;
  const dash = !s.plant;
  const num = (n: number) => dash ? '—' : String(n);
  const conf = k.confidence == null || dash ? '—' : String(Math.round(k.confidence));
  const of = dash ? '' : t('am.kpi_matched_of', { total: k.total, days: k.days ?? '∞' });
  const tile = (cls: string, label: string, value: string, sub: string, attrs = '') =>
    `<button type="button" class="kpi-tile ${cls}"${attrs}><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div><div class="d">${esc(sub)}</div></button>`;
  return [
    tile('', t('am.kpi_matched'), num(k.matched), of, ' disabled'),
    tile(!dash && k.errors > 0 ? 'err' : '', t('am.kpi_errors'), num(k.errors), '', ' disabled'),
    tile(!dash && k.warnings > 0 ? 'warn' : '', t('am.kpi_warnings'), num(k.warnings), '', ' disabled'),
    tile('', t('am.kpi_orders'), num(k.orders), '', ' disabled'),
    tile('is-actionable', t('am.kpi_confidence'), conf,
      dash ? '' : t('am.kpi_confidence_sub', { n: k.confidenceWindowAlerts }), ' data-am-action="kpi-confidence"'),
  ].join('');
}

function _bannerHtml(s: PaintState): string {
  if (!s.plant || !Store.alerts.some(a => a.type === 'plant_no_timezone')) return '';
  return `<div class="am-banner" role="alert">${esc(t('am.banner_no_timezone', { plant: s.plant }))}</div>`;
}

function _promptHtml(s: PaintState): string {
  if (!s.plant || !s.profilesLoaded || s.profiles.length) return '';
  return `<div class="am-create-prompt"><span>${esc(t('am.create_profile_prompt'))}</span>`
    + `<button type="button" class="btn sm" data-am-action="create-profile">${esc(t('ape.new_profile'))}</button></div>`;
}

function _emptyHtml(s: PaintState): string {
  switch (s.empty) {
    case 'no-plant':
      return `<div class="empty-state">${esc(t('am.empty_no_plant'))}</div>`;
    case 'no-alerts':
      return `<div class="empty-state">${esc(t('empty.no_active_alerts'))}</div>`;
    case 'all-acked':
      return `<div class="empty-state">${esc(t('am.empty_all_acked'))}</div>`;
    case 'no-match':
      return `<div class="empty-state am-empty-match"><div class="am-empty-title">${esc(t('am.empty_no_match_title'))}</div>`
        + `<div>${esc(t('am.empty_no_match_msg', { total: s.scopedCount, name: s.m.profile.name }))}</div>`
        + `<button type="button" class="btn sm" data-am-action="switch-all">${esc(t('am.empty_switch_all'))}</button></div>`;
    default:
      return '';
  }
}

/* ---------------------------------------------------------------------------
   High-leverage fixes (#am-leverage) — two phases, one in flight, stale results dropped.

   Phase 1: `group` (sync) paints every card with its removal number at once. Phase 2: `analyze` replays the
   setup-pair cards through the worker and the cards update in place. A result is kept only when the Store
   revision it was computed against is still current; the replay is skipped while What-If or an optimizer
   preview is open (their Store state is not the plan). Runs only while the tab is active.
   ------------------------------------------------------------------------- */
const _LEV_DEBOUNCE_MS = 400;
const _LEV_MAX_STALE_RETRIES = 3;

interface LevDeps {
  buildInput(s: PaintState): LeverageInput;
  group: typeof groupLeverage;
  analyze: typeof analyzeLeverage;
  replay: typeof replayWithMinutes;
  /** True when the plant's alert penalty is at its cap (removing alerts then cannot move the score). */
  capped(input: LeverageInput): boolean;
}

/** One place the engine's inputs are assembled. Tests replace these members; production never does. */
function _levBuildInput(s: PaintState): LeverageInput {
  const plant = s.plant as string;
  const days = Math.max(1, Math.ceil(s.horizonMinutes / 1440));
  return {
    plant,
    plantNow: s.horizonStart,
    horizonMinutes: s.horizonMinutes,
    alerts: s.scoped,
    tasksById: Store.tasks,
    lines: new Set(Store.linesForSelectedPlant()),
    setupSnapshot: Store.setupSnapshot,
    masterPlant: Store.masterPlant(plant),
    snapshotBase: buildPlantSnapshot(plant),
    // The replay scores over exactly this window: [start of the plant's day, +ceil(horizon/1440) days).
    baselineMatrix: Utilization.computeMatrix(s.plantToday, days) as unknown as NimbusUtilizationMatrix,
    dismissed: [...Alerts._dismissed],
  };
}

function _levIsCapped(input: LeverageInput): boolean {
  const core = globalThis.NimbusComputeCore;
  if (!core) return false;
  const r = core.scoreConfidence({
    alerts: input.alerts as NimbusAlert[], matrix: input.baselineMatrix, horizonStart: input.plantNow, horizonMinutes: input.horizonMinutes,
  });
  return r.alertPenalty >= core.CONFIDENCE_WEIGHTS.alertCap;
}

const _levDeps: LevDeps = {
  buildInput: _levBuildInput, group: groupLeverage, analyze: analyzeLeverage, replay: replayWithMinutes, capped: _levIsCapped,
};

const _levRunner: LeverageRunner = (base, variants) => Compute.leverageBatch(base, variants);

let _levItems: LeverageItem[] = [];
let _levInput: LeverageInput | null = null;
let _levPlant: string | null = null;      // the plant the items belong to
let _levHave = false;                     // a first pass has produced results for _levPlant
let _levStale = false;                    // the tab was re-entered: refresh once
let _levCapped = false;
let _levShowAll = false;
let _levInFlight = false;
let _levRerun = false;
let _levStaleDrops = 0;
let _levFirstTimer: ReturnType<typeof setTimeout> | null = null;
const _levTyped = new Map<string, number>();     // card key -> setup minutes the user entered
const _levAttempted = new Set<string>();         // alert ids of cards whose fix was started from this page
type SetupAdminLite = {
  canReviewMissingPairs(plant: string): boolean;
  missingPairsCsv(plant: string, pairs: ReturnType<typeof levPairsForReview>): string;
  reviewMissingPairs(plant: string | null, pairs: ReturnType<typeof levPairsForReview>): Promise<boolean>;
};
let _setupAdmin: SetupAdminLite | null = null;
let _setupAdminP: Promise<void> | null = null;

function _levReset(plant: string | null): void {
  _levItems = []; _levInput = null; _levPlant = plant; _levHave = false; _levShowAll = false;
  _levCapped = false; _levStaleDrops = 0;
  _levTyped.clear(); _levAttempted.clear();
}

/** SetupAdmin is imported lazily (no reverse edge exists, but it is a heavy module the pane rarely needs). */
function _ensureSetupAdmin(): void {
  if (_setupAdminP) return;
  _setupAdminP = import('../setup/setup-admin.mjs').then(m => {
    _setupAdmin = m.SetupAdmin as unknown as SetupAdminLite;
    if (_active) _paint();
  }, () => { /* the card falls back to "copy for the setup owner" */ });
}

function _levFieldLabel(fieldKey: string): string {
  const key = `constraint.${fieldKey}`;
  const v = t(key);
  return v === key ? fieldKey : v;
}

function _levCtxFor(item: LeverageItem, plant: string): LevCtx {
  const remaining = _levAttempted.size ? item.alertIds.filter(id => _levAttempted.has(id)).length : 0;
  return {
    capped: _levCapped, remaining,
    canReviewPairs: _setupAdmin?.canReviewMissingPairs(plant) === true,
    isAdmin: Session.isAdmin(),
    whatIf: Sandbox.active === true,
    fieldLabel: _levFieldLabel,
  };
}

function _renderLeverage(s: PaintState): void {
  if (!s.plant || s.scopedCount === 0) {
    _levReset(null);
    _setHtml('am-leverage', '');
    return;
  }
  if (_levPlant !== s.plant) _levReset(s.plant);
  if (!_levHave || _levStale) { _levStale = false; _levScheduleFirst(); }
  // A half-typed minutes box must survive an unrelated repaint.
  if ((document.activeElement as HTMLElement | null)?.classList?.contains('am-lev-min-input')) return;
  const plant = s.plant;
  if (_levItems.some(i => i.family === 'setup-pair')) _ensureSetupAdmin();
  _setHtml('am-leverage', levSectionHtml(_levItems, {
    showAll: _levShowAll, computing: !_levHave, ctxFor: it => _levCtxFor(it, plant),
  }, t));
}

function _levScheduleFirst(): void {
  if (_levFirstTimer) return;
  // Let the alert list paint first; grouping and the baseline matrix are the heavy part of this panel.
  _levFirstTimer = setTimeout(() => { _levFirstTimer = null; void _levRun(); }, 0);
}

const _levDebounced = Util.debounce(() => { if (_active && _levHave) void _levRun(); }, _LEV_DEBOUNCE_MS);

const _levSkipAnalysis = (): boolean => Sandbox.active === true || _nim().OptimizerPreview?.active === true;

async function _levRun(): Promise<void> {
  if (!_active) return;
  if (_levInFlight) { _levRerun = true; return; }
  const s = _gatherState();
  if (!s.plant || s.scopedCount === 0 || s.m.plant !== s.plant) return;
  const plant = s.plant;
  const rev0 = Store.rev();
  let input: LeverageInput | null = null;
  let items: LeverageItem[] = [];
  try {
    input = _levDeps.buildInput(s);
    items = _levDeps.group(input);
    _levCapped = _levDeps.capped(input);
  } catch (e) {
    ErrorLog.warn('alert-monitor', 'leverage grouping failed', { error: String((e as Error)?.message || e) });
    input = null; items = [];
  }
  if (!_active || Store.selectedPlant !== plant) return;
  _levPlant = plant; _levInput = input; _levItems = items; _levHave = true;
  const present = new Set(s.scoped.map(a => a.id));
  for (const id of _levAttempted) if (!present.has(id)) _levAttempted.delete(id);
  _paint();                                    // phase 1: removal numbers, at once
  if (!input || _levSkipAnalysis()) return;
  _levInFlight = true;
  try {
    let next = await _levDeps.analyze(input, _levRunner);
    for (const [key, minutes] of _levTyped) {
      const it = next.find(i => i.key === key);
      if (it?.requiresMinutes) {
        const done = await _levDeps.replay(input, it, minutes, _levRunner);
        next = next.map(i => (i.key === key ? done : i));
      }
    }
    if (!_active || Store.selectedPlant !== plant) return;
    if (Store.rev() !== rev0) {                // the plan moved while this computed: drop it, look again
      if (++_levStaleDrops <= _LEV_MAX_STALE_RETRIES) _levDebounced();
      return;
    }
    _levStaleDrops = 0;
    _levItems = next;
    _paint();                                  // phase 2: setup-pair cards carry the replayed numbers
  } catch (e) {
    ErrorLog.warn('alert-monitor', 'leverage analysis failed', { error: String((e as Error)?.message || e) });
  } finally {
    _levInFlight = false;
    if (_levRerun) { _levRerun = false; _levDebounced(); }
  }
}

/** The minutes box of a `requiresMinutes` card: one replay for that card, shown as the exact score once it returns. */
async function _levMinutesEntered(key: string, raw: string): Promise<void> {
  const minutes = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(minutes) || minutes <= 0) return;
  const item = _levItems.find(i => i.key === key);
  const input = _levInput;
  if (!item || !input) return;
  _levTyped.set(key, minutes);
  const rev0 = Store.rev();
  try {
    const next = await _levDeps.replay(input, item, minutes, _levRunner);
    if (!_active || Store.rev() !== rev0) return;   // a newer analysis re-applies the typed minutes
    _levItems = _levItems.map(i => (i.key === key ? next : i));
    _paint();
  } catch (e) {
    ErrorLog.warn('alert-monitor', 'leverage replay failed', { error: String((e as Error)?.message || e) });
  }
}

function _levShowAlerts(item: LeverageItem): void {
  const plant = Store.selectedPlant ?? '';
  const title = levTitle(item, _levCtxFor(item, plant), t);
  const byId = new Map(Store.alerts.map(a => [a.id, a]));
  const taskIds = new Set<string>();
  for (const id of item.alertIds) {
    const a = byId.get(id);
    if (a?.taskId) taskIds.add(String(a.taskId));
    if (a?.peerId) taskIds.add(String(a.peerId));
  }
  AlertMonitorPane.setFocus(item.alertIds, title);
  AlertProfileMatches.setFocusTaskIds(taskIds);   // the Gantt follows the focused card, not the profile
  _el('am-groups')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
}

async function _copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    Toast.show(t('am.lev_copied'), 'success');
  } catch {
    Toast.show(t('toast.clipboard_denied'), 'error');
  }
}

/** The alert of a calendar / optimize card to show a day for: the heaviest overload, else the heaviest alert. */
function _levWorstAlert(item: LeverageItem, s: PaintState): NimbusAlert | null {
  const byId = new Map(Store.alerts.map(a => [a.id, a]));
  let best: NimbusAlert | null = null;
  let bestKey = -1;
  for (const id of item.alertIds) {
    const a = byId.get(id);
    if (!a?.line || !a.time) continue;
    const key = impactPoints(a, s.horizonStart, s.horizonMinutes) + (a.type === 'overload' ? 1000 : 0);
    if (key > bestKey) { best = a; bestKey = key; }
  }
  return best;
}

/** Card actions. Cross-domain modules are imported inside the handlers (the engine <-> services loop, and these are rare paths). */
function _onLevAction(act: string, key: string): void {
  const item = _levItems.find(i => i.key === key);
  const plant = Store.selectedPlant;
  if (!item || !plant) return;
  const nim = _nim();
  const action = item.action;
  switch (act) {
    case 'show-alerts': _levShowAlerts(item); break;
    case 'open-table': _openOrdersInTable(item.orderIds); break;
    case 'copy-summary':
      void _copyText(levSummaryText(item, levTitle(item, _levCtxFor(item, plant), t), t));
      break;
    case 'focus-first':
    case 'goto': {
      // AlertsUIAdapter.focus needs the alert's line and time; it reveals a filtered-out line, selects both orders of a pair
      // and goes through Timeline.gotoLineDay, so every Go To here is the same call the drawer's row makes.
      const first = item.alertIds.map(id => Store.alerts.find(a => a.id === id)).find(a => a && a.line && a.time);
      if (first) nim.AlertsUIAdapter?.focus?.(first.id);
      else if (action.kind === 'calendar-day') nim.Timeline?.gotoLineDay?.(action.line, action.dayKey);
      break;
    }
    case 'diagnose-cell':
      if (action.kind === 'calendar-day') nim.AlertsUIAdapter?.showForCell?.(action.line, action.dayKey);
      break;
    case 'diagnose-worst': {
      const w = _levWorstAlert(item, _gatherState());
      if (w?.line && w.time) nim.AlertsUIAdapter?.showForCell?.(w.line, Util.dayKey(w.time));
      break;
    }
    case 'cal-fix':
      if (Sandbox.active || action.kind !== 'calendar-day') return;
      item.alertIds.forEach(id => _levAttempted.add(id));
      for (const id of action.fixableAlertIds) Alerts.applyFix(id);
      break;
    case 'edit-calendar':
      if (action.kind === 'calendar-day') {
        void import('../calendar/edit-calendar.mjs').then(m => m.EditCalendar.open(action.line));
      }
      break;
    case 'rg-workcenters':
      nim.App?.goto?.('masterdata');
      nim.App?.gotoMasterSub?.('work-centers');
      break;
    case 'rg-routing':
      if (action.kind === 'routing-gap') {
        nim.App?.goto?.('masterdata');
        nim.App?.gotoMasterSub?.('routing-pv');
        void import('../master-data/material-grids.mjs').then(m => m.MaterialGrids.setQuickFilter('routing-pv', action.material));
      }
      break;
    case 'setup-review':
    case 'setup-copy':
      if (action.kind === 'open-setup-matrix') void _levSetupAction(act, action.plant, action.pairs);
      break;
    case 'optimize':
      if (action.kind === 'optimize-window') _levOptimize(item, action.line, action.startDate, action.endDate, plant);
      break;
    default: break;
  }
}

async function _levSetupAction(act: string, plant: string, pairs: Parameters<typeof levPairsForReview>[0]): Promise<void> {
  const { SetupAdmin } = await import('../setup/setup-admin.mjs');
  const rows = levPairsForReview(pairs, t('ui.setup_missing_remedy_row'));
  if (act === 'setup-review' && SetupAdmin.canReviewMissingPairs(plant)) { await SetupAdmin.reviewMissingPairs(plant, rows); return; }
  await _copyText(SetupAdmin.missingPairsCsv(plant, rows));
}

/** "Optimize this window": the dialog opens on this card's machine and its conflict days (never before the plant's now). */
function _levOptimize(item: LeverageItem, line: string, startDay: string, endDay: string, plant: string): void {
  const now = new Date(Util.plantClock(plant));
  now.setSeconds(0, 0);
  let start = new Date(`${startDay}T00:00:00`);
  if (start < now) start = now;
  let end = new Date(`${endDay}T00:00:00`);
  end = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);   // through the end of the last conflict day
  if (end <= start) end = new Date(start.getTime() + Config.MS_DAY);
  item.alertIds.forEach(id => _levAttempted.add(id));
  void import('../optimization/optimize-ui.mjs').then(m => { m.OptimizeDialog.open({ lines: [line], startDate: start, endDate: end }); });
}

/* ---------------------------------------------------------------------------
   Groups, rows, diagnose
   ------------------------------------------------------------------------- */
function _teardownVl(): void {
  if (_vl) { _vl.destroy(); _vl = null; }
  _vlEl = null;
}

function _makeRowCtx(s: PaintState): RowCtx {
  const ctx: GroupContext = {
    tasksById: Store.tasks, horizonStart: s.horizonStart, horizonMinutes: s.horizonMinutes, plantToday: s.plantToday,
  };
  return {
    s, ctx,
    pointsOf: a => impactPoints(a, s.horizonStart, s.horizonMinutes),
    lateOf: id => { const task = Store.tasks[id]; return task ? Util.latenessHours(task) : 0; },
  };
}

function _headline(type: string): string {
  return _nim().AlertsUIAdapter?.headlineFor?.(type) ?? t(`alert.type.${type}`);
}

function _ackLabel(ack: AlertAck | undefined): string | null {
  if (!ack) return null;
  const who = ack.acknowledged_by ?? '—';
  return ack.until ? t('am.ack_by', { who, until: String(ack.until).slice(0, 10) }) : t('am.ack_by_noend', { who });
}

/** The inline "why is this late / blocked" panel of an order alert: facts about the order, nothing computed anew. */
function _diagnoseFor(a: NimbusAlert, task: NimbusTask | undefined): string {
  const fields: Array<{ label: string; value: string }> = [];
  if (task) {
    const due = Util.dueInstant(task);
    if (due) fields.push({ label: t('ui.insp_due_date'), value: Util.fmtDT(due) });
    const end = Util.scheduledEnd(task);
    if (end) fields.push({ label: t('ui.insp_planned_finish'), value: Util.fmtDT(end) });
    const late = Util.latenessHours(task);
    fields.push({ label: t('ui.late'), value: late > 0 ? `${fmtNum(late)} h` : '—' });
    const run = Number(task.RUN_TIME);
    if (task.RUN_TIME != null && task.RUN_TIME !== '' && isFinite(run)) {
      const basis = _nim().Inspector?._formatRuntimeBasis?.(task) ?? '';
      fields.push({ label: t('ui.insp_run_time'), value: `${fmtNum(run)} h${basis ? ` · ${basis}` : ''}` });
    }
    fields.push({ label: t('ui.insp_firming'), value: task.firmed || task.ecc_firmed ? t('ui.firmed') : t('am.diag_not_firmed') });
  }
  const pair = formatPairKey(a.pairKey);
  if (pair) fields.push({ label: t('am.diag_setup'), value: pair });
  const reason = task?.planning_reason;
  if (reason) {
    fields.push({ label: t('am.diag_reason'), value: [reason.code, reason.message, reason.step].filter(Boolean).join(' · ') });
  }
  return diagnoseHtml(fields);
}

function _rowView(a: NimbusAlert, rc: RowCtx): RowView {
  const task = a.taskId ? Store.tasks[a.taskId] : undefined;
  const anchor = anchorTime(a, task);
  // anchorTime hands back the alert's own time object when the order has no usable due date.
  const fromDue = !!anchor && anchor !== a.time;
  const open = _diagOpen.has(a.id);
  const helpKey = `alert.help.${a.type}`;
  const help = t(helpKey);
  const no = task ? String(task.ORDER ?? task.PRODUCTION_ORDER ?? '') : String(a.msgVars?.order ?? '');
  return {
    id: a.id, type: a.type, sev: a.sev, taskId: a.taskId, line: a.line, time: a.time,
    headline: _headline(a.type),
    message: Util.alertMessage(a),
    help: help === helpKey ? '' : help,
    orderNo: no,
    dateText: anchor ? Util.fmtDT(anchor) : '',
    relText: anchor ? relativeDaysText(alertDayOffset(anchor, rc.s.plantToday), t) : '',
    anchorTip: t(fromDue ? 'am.anchor_due' : 'am.anchor_time'),
    points: rc.pointsOf(a),
    orders: 1 + (a.peerId ? 1 : 0),
    lateH: a.taskId ? rc.lateOf(a.taskId) : 0,
    whatIf: Sandbox.active === true,
    ackLabel: _ackLabel(rc.s.m.acked.get(a.id)),
    diagOpen: open,
    diagHtml: open ? _diagnoseFor(a, task) : '',
  };
}

function _groupLabel(by: MonitorView['groupBy'], key: string, rc: RowCtx): string {
  return groupLabel(by, key, {
    headlineFor: _headline,
    orderLabel: id => {
      const task = Store.tasks[id];
      return task ? [task.ORDER ?? task.PRODUCTION_ORDER, task.MATERIAL_NUMBER].filter(Boolean).join(' · ') : '';
    },
    dayOffset: k => alertDayOffset(new Date(`${k}T12:00:00`), rc.s.plantToday),
    fmtDay: k => new Date(`${k}T12:00:00`).toLocaleDateString(document.documentElement?.lang || 'en-US',
      { weekday: 'short', day: 'numeric', month: 'short' }),
  }, t);
}

function _headView(g: AlertGroup, rc: RowCtx, expanded: boolean) {
  const first = g.alerts.find(a => rowActionsFor(a).goto) ?? null;
  return {
    key: g.key, expanded,
    label: _groupLabel(rc.s.view.groupBy, g.key, rc),
    totals: groupTotals(g.alerts, rc.pointsOf, rc.lateOf),
    firstAlertId: first?.id ?? null, firstGoto: !!first,
  };
}

function _groupCardHtml(g: AlertGroup, rc: RowCtx): string {
  const open = !_collapsed.has(g.key);
  let body = '';
  if (open) {
    const capped = !_showAll.has(g.key) && g.alerts.length > GROUP_ROW_CAP;
    const shown = capped ? g.alerts.slice(0, GROUP_ROW_CAP) : g.alerts;
    body = `<div class="am-gbody" role="list">${colsHtml(t)}${shown.map(a => rowHtml(_rowView(a, rc), t)).join('')}</div>`
      + (capped
        ? `<div class="am-more"><button type="button" class="btn sm btn-ghost" data-am-action="show-all" data-group-key="${esc(g.key)}">${esc(t('am.show_all_n', { n: g.alerts.length }))}</button></div>`
        : '');
  }
  return `<section class="am-group panel" data-group-key="${esc(g.key)}">${groupHeadHtml(_headView(g, rc, open), t)}${body}</section>`;
}

/** Group-by none: one card whose rows live in a single VirtualList (fixed 56 px, taller under an open diagnose). */
function _renderNone(g: AlertGroup | undefined, rc: RowCtx): void {
  if (!g) { _teardownVl(); _setHtml('am-groups', ''); return; }
  const shell = `<section class="am-group panel" data-group-key="${esc(g.key)}"><div id="am-none-head"></div>`
    + `<div id="am-none-body">${colsHtml(t)}<div class="am-vl-scroll" id="am-vl" role="list"></div></div></section>`;
  if (_setHtml('am-groups', shell)) { _teardownVl(); _lastHtml.delete('am-none-head'); }
  _setHtml('am-none-head', groupHeadHtml(_headView(g, rc, !_collapsed.has(g.key)), t));
  const body = _el('am-none-body');
  if (body) body.hidden = _collapsed.has(g.key);
  const mount = _el('am-vl');
  if (!mount) return;
  if (!_vl || _vlEl !== mount) {
    _teardownVl();
    _vlEl = mount;
    _vl = new VirtualList<NimbusAlert>(mount, {
      getRowH: a => ROW_H + (_diagOpen.has(a.id) && rowActionsFor(a).diagnose === 'order' ? DIAG_H : 0),
      renderFn: a => rowHtml(_rowView(a, _rowCtx!), t),
      mountEl: mount,
    });
  }
  _vl.update(g.alerts);
}

function _renderFocusChip(s: PaintState): void {
  const el = _el('am-focus-chip');
  if (!el) return;
  if (!_focusIds) { _setHtml('am-focus-chip', ''); el.hidden = true; return; }
  const n = s.listed.length;
  const text = s.focusOutside > 0
    ? t('am.focus_chip_outside', { n, title: _focusTitle, k: s.focusOutside })
    : t('am.focus_chip', { n, title: _focusTitle });
  _setHtml('am-focus-chip', `<span>${esc(text)}</span>`
    + `<button type="button" class="btn sm btn-ghost" data-am-action="clear-focus">${esc(t('am.focus_clear'))}</button>`);
  el.hidden = false;
}

function _renderGroups(s: PaintState): void {
  _renderFocusChip(s);
  if (s.empty !== null || !s.plant) {
    _teardownVl();
    _groupsByKey = new Map();
    _rowCtx = null;
    _setHtml('am-groups', _emptyHtml(s));
    return;
  }
  const rc = _makeRowCtx(s);
  _rowCtx = rc;
  const sorted = [...s.listed].sort(compareAlerts(s.view.sort, rc.ctx));
  const groups = groupAlerts(sorted, s.view.groupBy, rc.ctx);
  _groupsByKey = new Map(groups.map(g => [g.key, g]));
  if (s.view.groupBy === 'none') { _renderNone(groups[0], rc); return; }
  _teardownVl();
  _setHtml('am-groups', groups.map(g => _groupCardHtml(g, rc)).join(''));
}

function _paint(): void {
  if (!_active) return;
  _ensureShell();
  if ((Store.selectedPlant ?? null) !== _lastPlant) { _lastPlant = Store.selectedPlant ?? null; AlertMonitorPane.resetView(); }
  const s = _gatherState();
  _syncToolbar(s);
  _setHtml('am-kpis', _kpiHtml(s));
  // The producer follows plant:selected itself; until it has caught up, leave the body alone.
  if (s.plant && s.m.plant !== s.plant) return;
  _setHtml('am-banner', _bannerHtml(s));
  _setHtml('am-prompt', _promptHtml(s));
  _renderLeverage(s);
  _renderGroups(s);
}

const _debouncedPaint = Util.debounce(() => { if (_active) _paint(); }, 150);

/* ---------------------------------------------------------------------------
   Public API
   ------------------------------------------------------------------------- */
export const AlertMonitorPane = {
  /** Idempotent; wires the subscriptions once. Nothing here paints. */
  init(): void {
    if (_wired) return;
    _wired = true;
    Store.subscribe((evt: StoreEvent) => {
      if (!_active) return;
      switch (evt.type) {
        case 'alerts:change': _debouncedPaint(); _levDebounced(); break;
        case 'plant:selected':
        case 'settings:change': _paint(); break;
        case 'sandbox:entered':
        case 'sandbox:exited':
        case 'sandbox:reverted': _paint(); break;   // row actions flip disabled with What-If (Task 12)
        default:
          // Anything the leverage replay is computed from: orders, the setup snapshot, calendars and blackouts.
          if (evt.type.startsWith('tasks:bulk') || evt.type === 'setup-snapshot:replace' || evt.type === 'calendar:change'
            || evt.type === 'blocks:change' || evt.type === 'plantBlocks:change') _levDebounced();
          break;
      }
    }, 'alert-monitor-pane');
    AlertProfileMatches.subscribe(() => { if (_active) _paint(); });
    AlertProfileClient.subscribe(() => { if (_active) _paint(); });
  },
  /** Called by the shell on every entry to the tab. */
  render(): void {
    _active = true;
    _levStale = true;   // events were ignored while the tab was hidden: refresh the leverage cards once
    _paint();
  },
  /**
   * List only these alerts (they bypass the profile) under a "Showing N alerts for: title" chip —
   * the entry point for the leverage cards' "Show alerts" (Task 13).
   */
  setFocus(alertIds: Iterable<string>, title: string): void {
    _focusIds = new Set(alertIds);
    _focusTitle = title;
    _paint();
  },
  clearFocus(): void {
    _focusIds = null;
    _focusTitle = '';
    AlertProfileMatches.setFocusTaskIds(null);   // the Gantt goes back to the profile
    _paint();
  },
  /** Forget folded groups, open diagnose panels, "Show all" and the focus set (plant change). Does not paint. */
  resetView(): void {
    _collapsed.clear(); _showAll.clear(); _diagOpen.clear();
    _focusIds = null; _focusTitle = '';
    _levReset(null);
  },
  /** The engine / input seams of the leverage panel; tests replace members, production never does. */
  _levDeps,
  setActive(active: boolean): void { _active = active; },
  isActive(): boolean { return _active; },
};
