/* =============================================================================
   ALERT MONITOR PANE — the "Alert Monitor" top-level tab (#alerts-tab).

   Lifecycle (the DistributionPane shape): the shell calls init() once on first entry,
   render() on every entry and setActive(false) on leave. `_active` gates every Store /
   producer subscriber so a hidden pane does no work.

   Header (rev 2): title row (profile combobox, Edit / View rules, default, ⋯ page menu), a one-sentence
   summary line and a controls row (Group by, Sort by); then the pinned banner and the empty states. The leverage
   panel (#am-leverage, Task 13) and the alert groups (#am-groups, Task 12) are filled by
   later tasks through the two hook functions at the bottom of the paint path.

   Reads the always-on producer through AlertProfileMatches.view() (the session "View as"
   override applied; the rest of the app follows current(), the saved default); never emits a
   Store event. "View as" is session-only (setSessionProfile); "Make my default" is the one
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
import { AlertProfileEditor, canDeleteProfile } from './alert-profile-editor.mjs';
import { OverflowMenu } from '../platform/overflow-menu.mjs';
import type { MenuItem } from '../platform/overflow-menu.mjs';
import { AlertAckModal } from './alert-ack-modal.mjs';
import { AlertAcksClient } from '../insights/alert-acks-client.mjs';
import {
  ALL_ALERTS_PROFILE_ID, resolveActiveProfileId, ackLabel, impactPoints, compareAlerts, groupAlerts, anchorTime, alertDayOffset,
} from '../insights/alert-profiles.mjs';
import type { AlertGroup, GroupContext } from '../insights/alert-profiles.mjs';
import { Alerts, Compute, Utilization, buildPlantSnapshot } from '../insights/services.mjs';
import { groupLeverage, analyzeLeverage, replayWithMinutes } from '../insights/alert-leverage.mjs';
import type { LeverageItem, LeverageInput, LeverageRunner } from '../insights/alert-leverage.mjs';
import { Sandbox } from '../optimization/sandbox.mjs';
import {
  MONITOR_GROUP_BYS, MONITOR_SORTS, GROUP_ROW_CAP, ROW_H, DIAG_H, GROUP_MOVE_CONFIRM_ABOVE,
  summaryLine, windowSummary, viewFor, visibleAlertsFor, horizonAlerts, emptyStateFor,
  rowActionsFor, rowHtml, rowPrimaryActions, diagnoseHtml, groupHeadHtml, groupMenuItems, groupCounts, groupLabel,
  relativeDaysText, formatPairKey, fmtNum,
  fixesSectionHtml, levActions, levTitle, levSummaryText, levPairsForReview, LEV_TOP_N, LEV_STEP, LEV_MAX_RENDER,
} from './alert-monitor-model.mjs';
import type { MonitorView, EmptyKind, RowView, LevCtx, GroupHeadView, GroupCounts } from './alert-monitor-model.mjs';

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
  /** What the profile matched (acknowledged hidden unless asked). */
  visible: NimbusAlert[];
  /** What the groups list: `visible`, or the focus set (which bypasses the profile). */
  listed: NimbusAlert[];
  /** Focused alerts the profile did not match (the focus chip says so). */
  focusOutside: number;
  /** The plant confidence score now (null until computed). */
  confidence: number | null;
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
}

const GROUP_LABEL_KEY: Record<string, string> = {
  category: 'am.group_category', type: 'am.group_type', line: 'am.group_line',
  day: 'am.group_day', order: 'am.group_order', none: 'am.group_none',
};
const SORT_LABEL_KEY: Record<string, string> = { impact: 'am.sort_impact', time: 'am.sort_time' };

/** Sentinel option id of the picker's "+ New profile…" row; it never reaches setSessionProfile. */
const NEW_PROFILE_ID = '__new__';

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
  const groupOpts = MONITOR_GROUP_BYS.map(g => `<option value="${g}">${esc(t(GROUP_LABEL_KEY[g]))}</option>`).join('');
  const sortBtns = MONITOR_SORTS.map(s =>
    `<button type="button" class="seg-btn" data-am-sort="${s}" aria-pressed="false">${esc(t(SORT_LABEL_KEY[s]))}</button>`).join('');
  return `
<div class="am-head" id="am-head">
  <div class="am-head-row">
    <h2 class="am-title">${esc(t('tab.alerts'))}</h2>
    <span class="plant-badge" id="am-plant-badge" hidden></span>
    <span class="spacer"></span>
    <div class="am-profile-wrap">
      <div class="us-combo" id="am-profile-combo">
        <input type="text" id="am-profile-input" class="us-combo-input" role="combobox" autocomplete="off"
               aria-autocomplete="list" aria-expanded="false" aria-controls="am-profile-dropdown"
               aria-label="${esc(t('am.view_as'))}" title="${esc(t('am.view_as'))}" placeholder="${esc(t('am.profile_ph'))}">
        <div class="us-combo-dropdown" id="am-profile-dropdown" role="listbox" hidden></div>
      </div>
    </div>
    <button type="button" class="btn btn-ghost" id="am-edit" data-am-action="edit-profile" hidden>${esc(t('am.edit_profile'))}</button>
    <span class="am-default-note" id="am-is-default" hidden>${esc(t('am.is_default'))}</span>
    <button type="button" class="btn btn-ghost" id="am-make-default" data-am-action="make-default" hidden>${esc(t('am.set_default'))}</button>
    <button type="button" class="icon-btn" id="am-page-menu" data-am-action="page-menu" data-ovf-key="page"
            aria-label="${esc(t('am.page_menu'))}" title="${esc(t('am.page_menu'))}" aria-haspopup="menu" aria-expanded="false">⋯</button>
  </div>
  <div class="am-summary" id="am-summary"></div>
  <div class="am-head-row am-controls">
    <label class="am-ctl-label" for="am-group-sel">${esc(t('am.group_by'))}</label>
    <select class="input am-group-sel" id="am-group-sel" data-am-group-sel>${groupOpts}</select>
    <span class="am-ctl-label" id="am-sort-label">${esc(t('am.sort_by'))}</span>
    <div class="am-seg" id="am-seg" role="group" aria-labelledby="am-sort-label">${sortBtns}</div>
  </div>
</div>
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
  const m = AlertProfileMatches.view();
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
  if (!_comboOptions().some(o => o.id === id)) return;   // the "+ New profile…" sentinel and stale ids never become the view
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
  const choose = (id: string) => {
    if (id === NEW_PROFILE_ID) {
      // The sentinel never reaches _chooseProfile: it opens the editor on a blank draft, and a successful save hands back the view.
      const plant = Store.selectedPlant;
      if (plant) AlertProfileEditor.open({ plant, fromPicker: true });
    } else {
      _chooseProfile(id);
    }
    reflect(); close(); input.blur();
  };

  const renderList = (query: string) => {
    const all = _comboOptions();
    const q = (query || '').trim().toLowerCase();
    const fq = q === _viewedLabel().toLowerCase() ? '' : q;
    // "+ New profile…" is appended after filtering, always, so it is also what a search with no matches offers.
    _comboFiltered = [...(fq ? all.filter(o => o.label.toLowerCase().includes(fq)) : all), { id: NEW_PROFILE_ID, label: t('ape.new_profile') }];
    const plant = Store.selectedPlant;
    const defId = plant ? _defaultProfileId(plant, (AlertProfileClient.cached(plant) ?? [])) : ALL_ALERTS_PROFILE_ID;
    const vm = AlertProfileMatches.view();
    const viewed = vm.profileId;
    const viewedSub = windowSummary(vm.profile, t);
    const newHtml = (i: number) =>
      `<div class="us-combo-option am-opt-new" role="option" aria-selected="false" data-profile="${NEW_PROFILE_ID}" data-idx="${i}">`
      + `<span>+ ${esc(t('ape.new_profile'))}…</span></div>`;
    if (_comboFiltered.length === 1) {
      dropdown.innerHTML = `<div class="us-combo-empty">${esc(t('us.no_matches'))}</div>${newHtml(0)}`;
      _comboActive = -1;
      return;
    }
    const hint = all.length === 1 && !fq ? `<div class="us-combo-empty">${esc(t('am.profile_none'))}</div>` : '';
    const rows = _comboFiltered.slice(0, -1).map((o, i) => {
      const sub = o.id === viewed && viewedSub ? `<span class="am-opt-sub">${esc(viewedSub)}</span>` : '';
      return `<div class="us-combo-option${o.id === viewed ? ' selected' : ''}" role="option" aria-selected="${o.id === viewed}" data-profile="${esc(o.id)}" data-idx="${i}">`
        + `<span class="am-opt-text"><span class="am-opt-name">${esc(o.label)}</span>${sub}</span>`
        + `${o.id === defId ? `<span class="us-combo-option-prefix">${esc(t('am.is_default'))}</span>` : ''}</div>`;
    }).join('');
    dropdown.innerHTML = rows + hint + newHtml(_comboFiltered.length - 1);
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
/** Writes only the changed key: the other one keeps following its default (Machine / the profile's ranking) until the user sets it. */
function _persistView(patch: Partial<MonitorView>): void {
  const m = AlertProfileMatches.view();
  const stored = (Store.pref('alertMonitorView') as Record<string, Record<string, unknown> | undefined> | null | undefined) ?? {};
  Session.setPref('alertMonitorView', { ...stored, [m.profileId]: { ...(stored[m.profileId] ?? {}), ...patch } });
  _paint();
}

function _openProfileEditor(): void {
  const plant = Store.selectedPlant;
  const id = AlertProfileMatches.view().profileId;
  if (plant && id !== ALL_ALERTS_PROFILE_ID) AlertProfileEditor.open({ plant, profileId: id });
}

/** ⋯ page menu: the two page-level toggles, both persisted prefs. */
function _openPageMenu(anchor: HTMLElement): void {
  const items: MenuItem[] = [
    {
      id: 'highlight', label: t('am.gantt_highlight'), checked: Store.pref('alertProfileGanttHighlight') !== false,
      onSelect: (next: boolean) => { Session.setPref('alertProfileGanttHighlight', next); },
    },
    {
      id: 'ack', label: t('am.ack_show'), checked: Store.pref('alertsShowAcknowledged') === true,
      onSelect: (next: boolean) => { Session.setPref('alertsShowAcknowledged', next); },
    },
  ];
  OverflowMenu.open(anchor, items, { align: 'end', key: 'page' });
}

function _makeDefault(): void {
  const plant = Store.selectedPlant;
  if (!plant) return;
  const m = AlertProfileMatches.view();
  const existing = (Store.pref('alertProfileByPlant') as Record<string, string> | null | undefined) ?? {};
  Session.setPref('alertProfileByPlant', { ...existing, [plant]: m.profileId });
  AlertProfileMatches.setSessionProfile(null);   // the pref now says the same thing
}

function _onClick(e: Event): void {
  const target = e.target as HTMLElement | null;
  const seg = target?.closest?.('[data-am-sort]') as HTMLElement | null;
  const sortId = seg?.dataset.amSort as MonitorView['sort'] | undefined;
  if (sortId && MONITOR_SORTS.includes(sortId)) { _persistView({ sort: sortId }); return; }
  const lev = target?.closest?.('[data-lev-action]') as HTMLElement | null;
  if (lev?.dataset.levAction) { _onLevAction(lev.dataset.levAction, lev.dataset.levKey ?? ''); return; }
  const levMenu = target?.closest?.('[data-lev-menu]') as HTMLElement | null;
  if (levMenu?.dataset.levMenu) { _openFixMenu(levMenu, levMenu.dataset.levMenu); return; }
  const rowMenu = target?.closest?.('.am-row-menu') as HTMLElement | null;
  if (rowMenu?.dataset.alertId) { _openRowMenu(rowMenu, rowMenu.dataset.alertId); return; }
  const groupMenu = target?.closest?.('.am-group-menu') as HTMLElement | null;
  if (groupMenu?.dataset.groupKey) { _openGroupMenu(groupMenu, groupMenu.dataset.groupKey); return; }
  const btn = target?.closest?.('[data-am-action]') as HTMLElement | null;
  switch (btn?.dataset.amAction) {
    case 'make-default': _makeDefault(); break;
    case 'switch-all':   AlertProfileMatches.setSessionProfile(ALL_ALERTS_PROFILE_ID); break;
    case 'edit-profile': _openProfileEditor(); break;
    case 'create-profile': {
      const plant = Store.selectedPlant;
      if (plant) AlertProfileEditor.open({ plant });   // the prompt always starts a new draft
      break;
    }
    case 'page-menu': if (btn) _openPageMenu(btn); break;
    case 'summary-conf': {
      const conf = (globalThis as unknown as { NIMBUS?: { Confidence?: { showBreakdown?: () => void } } }).NIMBUS?.Confidence;
      conf?.showBreakdown?.();
      break;
    }
    case 'toggle-group': _toggleGroup(btn!.dataset.groupKey ?? ''); break;
    case 'show-all':
      if (btn!.dataset.groupKey) { _showAll.add(btn!.dataset.groupKey); _paint(); }
      break;
    case 'group-move': _moveGroup(btn!.dataset.groupKey ?? ''); break;
    case 'clear-focus': AlertMonitorPane.clearFocus(); break;
    case 'fixes-show-more': _showMoreFixes(); break;
    case 'fixes-admin-toggle':
      _levAdminOpen = !_levAdminOpen; _paint();
      document.querySelector?.<HTMLElement>('[data-am-action="fixes-admin-toggle"]')?.focus?.();   // the repaint replaced the button
      break;
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

const _isAcked = (id: string): boolean => AlertProfileMatches.view().acked.has(id);

/** Put keyboard focus back on a ⋯ trigger a repaint replaced: the new trigger carries the same data-ovf-key. */
function _refocusKey(key: string): boolean {
  const next = Array.from(document.querySelectorAll?.<HTMLElement>('[data-ovf-key]') ?? []).find(el => el.getAttribute('data-ovf-key') === key);
  if (!next) return false;
  next.focus?.();
  return true;
}

/** Where focus goes when a row's own trigger is gone after an action: the next (else previous) row of its group, else the group head. */
function _rowNeighbours(alertId: string): { groupKey: string | null; near: string[] } {
  for (const g of _groupsByKey.values()) {
    const i = g.alerts.findIndex(a => a.id === alertId);
    if (i < 0) continue;
    return { groupKey: g.key, near: [g.alerts[i + 1]?.id, g.alerts[i - 1]?.id].filter((x): x is string => !!x) };
  }
  return { groupKey: null, near: [] };
}

function _restoreRowFocus(alertId: string, nav: { groupKey: string | null; near: string[] }): void {
  if (_refocusKey(alertId)) return;
  for (const id of nav.near) if (_refocusKey(id)) return;
  if (nav.groupKey) _focusGroupHead(nav.groupKey);
}

function _focusGroupHead(key: string): void {
  const heads = Array.from(document.querySelectorAll?.<HTMLElement>('[data-am-action="toggle-group"]') ?? []);
  heads.find(el => el.dataset.groupKey === key)?.focus?.();
}

/** The ⋯ menu of a row: its items carry the same data-alert-action / data-alert-id as the buttons and run through the same dispatcher. */
function _openRowMenu(anchor: HTMLElement, alertId: string): void {
  const a = Store.alerts.find(x => x.id === alertId);
  if (!a) return;
  const taskId = a.taskId ? String(a.taskId) : undefined;
  const p = rowPrimaryActions(a, taskId ? Store.tasks[taskId] : undefined, { whatIf: Sandbox.active === true, acked: _isAcked(alertId) });
  const items: MenuItem[] = p.menu.map(m => ({
    id: m.action,
    label: t(m.labelKey),
    disabled: m.disabled === true,
    hint: m.hintKey ? t(m.hintKey) : undefined,
    data: { alertAction: m.action, alertId, ...(taskId ? { taskId } : {}) },
    onSelect: () => {
      if (m.action === 'focus') { _runAlertAction(m.action, alertId, taskId); return; }
      if (m.action === 'ack' || m.action === 'override') {
        // These open a modal that takes focus and hands it back to the opener: make the live trigger the opener first.
        _refocusKey(alertId);
        _runAlertAction(m.action, alertId, taskId);
        return;
      }
      // fix / diagnose / unack change what the list shows: repaint now, then put focus on this row's new trigger (or its neighbour).
      const nav = _rowNeighbours(alertId);
      const done = (): void => { if (_active) _paint(); _restoreRowFocus(alertId, nav); };
      const pending = _runAlertAction(m.action, alertId, taskId);
      if (pending) void pending.then(done); else done();
    },
  }));
  OverflowMenu.open(anchor, items, { align: 'end', key: alertId });
}

/** The ⋯ menu of a group head: Go to (first alert), Move N orders, Open these N orders in the table, Acknowledge N…. */
function _openGroupMenu(anchor: HTMLElement, key: string): void {
  const g = _groupsByKey.get(key);
  if (!g || !_rowCtx) return;
  const head = _headView(g, _rowCtx, !_collapsed.has(key));
  const items: MenuItem[] = groupMenuItems(head).map(m => ({
    id: m.id,
    label: t(m.labelKey, m.vars),
    disabled: m.disabled === true,
    hint: m.hintKey ? t(m.hintKey) : undefined,
    data: (m.id === 'goto' ? { alertAction: 'focus', alertId: head.firstAlertId ?? '' } : { amAction: `group-${m.id}`, groupKey: key }) as Record<string, string>,
    onSelect: () => {
      switch (m.id) {
        case 'goto': if (head.firstAlertId) _runAlertAction('focus', head.firstAlertId); break;
        case 'move': _moveGroup(key); break;
        case 'open-table': _openGroupInTable(key); break;
        case 'ack': _ackGroup(key); break;
      }
    },
  }));
  OverflowMenu.open(anchor, items, { align: 'end', key });
}

/** "Acknowledge N…": one reason / end date for every not-yet-acknowledged alert of the whole group (not just the rendered rows). */
function _ackGroup(key: string): void {
  const g = _groupsByKey.get(key);
  const plant = Store.selectedPlant;
  if (!g || !plant) return;
  const ids = groupCounts(g.alerts, _isAcked).unackedIds;
  if (ids.length) AlertAckModal.open({ plant, alertIds: ids });
}

/**
 * "Move N orders": confirms above GROUP_MOVE_CONFIRM_ABOVE, then runs the one-click fix on each movable alert of the
 * whole group in turn. Not available in What-If (the plan is a sandbox there).
 */
function _moveGroup(key: string): void {
  if (Sandbox.active) return;
  const g = _groupsByKey.get(key);
  if (!g) return;
  const counts = groupCounts(g.alerts, () => false);
  const ids = counts.movableIds;
  const n = counts.movableOrders;   // distinct orders, as the button says
  if (n === 0) return;
  if (n <= GROUP_MOVE_CONFIRM_ABOVE) { _runBatchMove(key, ids); return; }
  void Modal.confirm({ title: t('am.group_fix_n', { n }), message: t('am.group_fix_confirm', { n }) })
    .then(ok => { if (ok) _runBatchMove(key, ids); });
}

/**
 * Sequential batch: `Alerts.applyFix(id, { quiet: true })` is synchronous and dismisses the alert on success, so an id that
 * has left Store.alerts afterwards means that order moved. The moved order's other alerts (and its peers' alerts) stay in
 * Store.alerts until the debounced recompute, so any alert naming an already-moved order is skipped: it describes a
 * position that no longer exists. One summary toast; focus returns to the group head.
 */
function _runBatchMove(key: string, ids: string[]): void {
  if (Sandbox.active) return;
  const movedOrders = new Set<string>();
  try {
    for (const id of ids) {
      const a = Store.alerts.find(x => x.id === id);
      if (!a) continue;                                    // already gone (cleared by an earlier move or a recompute)
      if ((a.taskId && movedOrders.has(String(a.taskId))) || (a.peerId && movedOrders.has(String(a.peerId)))) continue;
      Alerts.applyFix(id, { quiet: true });
      if (!Store.alerts.some(x => x.id === id)) movedOrders.add(String(a.taskId ?? id));
    }
  } catch (e) {
    Toast.show((e as Error)?.message || String(e), 'error');   // reported once; what moved before the throw is still summarised below
  } finally {
    const moved = movedOrders.size;
    Toast.show(t(moved === 1 ? 'am.group_fix_done_one' : 'am.group_fix_done', { n: moved }), moved > 0 ? 'success' : 'warn');
    if (_active) _paint();
    _focusGroupHead(key);
  }
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
  nim.App?.goto?.('gantt');
  nim.App?.gotoGanttSub?.('orders');
}

/** A row button was clicked: hand its data-* to the one dispatcher (the ⋯ menu items call `_runAlertAction` with the same values). */
function _onAlertAction(trigger: HTMLElement): void {
  const alertId = trigger.dataset.alertId;
  if (alertId) _runAlertAction(trigger.dataset.alertAction, alertId, trigger.dataset.taskId);
}

/** Row actions — the same vocabulary and calls as AlertsUIAdapter._handleAction (the drawer), minus Dismiss (not on this page). */
function _runAlertAction(action: string | undefined, alertId: string, taskId?: string): Promise<void> | void {
  const nim = _nim();
  switch (action) {
    case 'focus': nim.AlertsUIAdapter?.focus?.(alertId); break;
    case 'fix':
      if (Sandbox.active) return;
      Alerts.applyFix(alertId);
      break;
    case 'override': {
      if (Sandbox.active) return;
      if (taskId) nim.Table?._openOverrideModalForId?.(taskId);
      break;
    }
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
    case 'ack': {
      const plant = Store.selectedPlant;
      if (plant) AlertAckModal.open({ plant, alertId });
      break;
    }
    case 'unack': {
      const plant = Store.selectedPlant;
      if (!plant) break;
      // The client refetches and fans out on success, so the lists repaint themselves.
      return AlertAcksClient.unacknowledge(plant, alertId).catch(e => { Toast.show((e as Error)?.message || String(e), 'error'); });
    }
    default: break;
  }
}

function _onChange(e: Event): void {
  const target = e.target as HTMLInputElement | null;
  const mins = target?.closest?.('[data-lev-minutes]') as HTMLInputElement | null;
  if (mins?.dataset.levMinutes) { void _levMinutesEntered(mins.dataset.levMinutes, String(mins.value ?? '')); return; }
  const group = target?.closest?.('[data-am-group-sel]') as HTMLSelectElement | null;
  if (group && MONITOR_GROUP_BYS.includes(group.value as MonitorView['groupBy'])) _persistView({ groupBy: group.value as MonitorView['groupBy'] });
}

/* ---------------------------------------------------------------------------
   Paint
   ------------------------------------------------------------------------- */
function _gatherState(): PaintState {
  const plant = Store.selectedPlant ?? null;
  const m = AlertProfileMatches.view();
  const profilesRaw = plant ? AlertProfileClient.cached(plant) : null;
  const profiles = profilesRaw ?? [];
  const stored = Store.pref('alertMonitorView') as Parameters<typeof viewFor>[1];
  const view = viewFor(m.profileId, stored, m.profile);
  const showAcked = Store.pref('alertsShowAcknowledged') === true;

  const plantRow = plant ? Store.masterPlant(plant) : null;
  const clock = plant ? Util.plantClock(plant) : new Date();
  const lines = new Set(plant ? Store.linesForSelectedPlant() : []);
  const scoped = horizonAlerts(Store.alerts, lines, null);
  const visible = visibleAlertsFor(scoped, m.alertIds, m.acked, showAcked);
  const focus = _focusIds;
  const listed = focus ? scoped.filter(a => focus.has(a.id) && (showAcked || !m.acked.has(a.id))) : visible;
  const focusOutside = focus ? listed.filter(a => !m.alertIds.has(a.id)).length : 0;

  const confMin = plantRow?.conf_score_horizon ?? (Store.userSettings?.confidenceHorizonMinutes as number | undefined) ?? 20160;
  const score = (globalThis as unknown as { NIMBUS?: { Confidence?: { _score?: number } } }).NIMBUS?.Confidence?._score;

  const matchedCount = scoped.filter(a => m.alertIds.has(a.id)).length;
  return {
    plant, m, profiles, profilesLoaded: profilesRaw != null, view,
    defaultId: plant ? _defaultProfileId(plant, profiles) : ALL_ALERTS_PROFILE_ID,
    showAcked, scoped, visible, listed, focusOutside, scopedCount: scoped.length,
    confidence: typeof score === 'number' && isFinite(score) ? score : null,
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

/** Header rows 1 and 3: the combobox, Edit / View rules, the default control, the plant badge and the two view controls. */
function _syncHeader(s: PaintState): void {
  const input = _el<HTMLInputElement>('am-profile-input');
  if (input) {
    input.disabled = !s.plant;
    if (document.activeElement !== input) input.value = s.plant ? _viewedLabel() : '';
    const win = s.plant ? windowSummary(s.m.profile, t) : '';
    if (win) input.setAttribute('aria-description', win); else input.removeAttribute('aria-description');
  }
  const stored = s.plant && s.m.profileId !== ALL_ALERTS_PROFILE_ID;
  const edit = _el('am-edit');
  if (edit) {
    edit.hidden = !stored;
    // Same rule the editor applies: an admin or the creator edits, anyone else reads the rules.
    const canEdit = !!stored && canDeleteProfile(s.m.profile, Session.currentUser(), Session.isAdmin());
    _setText('am-edit', t(canEdit ? 'am.edit_profile' : 'am.view_profile'));
  }
  const isDefault = !!s.plant && s.m.profileId === s.defaultId;
  const mk = _el('am-make-default');
  if (mk) mk.hidden = !s.plant || isDefault;
  const note = _el('am-is-default');
  if (note) note.hidden = !isDefault;

  const pb = _el('am-plant-badge');
  if (pb) { pb.hidden = !s.plant; pb.textContent = s.plant ?? ''; }

  const grp = _el<HTMLSelectElement>('am-group-sel');
  if (grp) { grp.value = s.view.groupBy; grp.disabled = !s.plant; }
  document.querySelectorAll<HTMLElement>('[data-am-sort]').forEach(b => {
    const on = b.dataset.amSort === s.view.sort;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
    (b as HTMLButtonElement).disabled = !s.plant;
  });
}

/** Header row 2: one sentence over the alerts the list shows, ending in the plant-confidence link. */
function _summaryHtml(s: PaintState): string {
  const line = summaryLine({
    hasPlant: !!s.plant, alerts: s.listed, profileId: s.m.profileId, profileName: s.m.profile.name, profile: s.m.profile,
    focus: _focusIds ? { title: _focusTitle, outside: s.focusOutside } : null, confidence: s.confidence,
  }, t);
  let html = `<span>${esc(line.text)}</span>`;
  if (line.conf) {
    const { prefix, score, suffix } = line.conf;
    html += ` · <button type="button" class="am-summary-conf" data-am-action="summary-conf">${esc(prefix)}`
      + (score ? `<span class="am-summary-num">${esc(score)}</span>` : '') + `${esc(suffix)}</button>`;
  }
  return html;
}

function _bannerHtml(s: PaintState): string {
  if (!s.plant || !s.scoped.some(a => a.type === 'plant_no_timezone')) return '';
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

const _levDeps: LevDeps = {
  buildInput: _levBuildInput, group: groupLeverage, analyze: analyzeLeverage, replay: replayWithMinutes,
};

const _levRunner: LeverageRunner = (base, variants) => Compute.leverageBatch(base, variants);

let _levItems: LeverageItem[] = [];
let _levInput: LeverageInput | null = null;
let _levPlant: string | null = null;      // the plant the items belong to
let _levHave = false;                     // a first pass has produced results for _levPlant
let _levStale = false;                    // the tab was re-entered: refresh once
let _levShown = LEV_TOP_N;
let _levAdminOpen = false;                // the "Needs an admin" disclosure; resets with the plant
const _levReplaying = new Set<string>();  // fix keys with a minutes replay in flight (Enter + Replay must not double-run)
let _levForcePaint = false;               // bypass the "half-typed minutes box" guard for one repaint
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
  _levItems = []; _levInput = null; _levPlant = plant; _levHave = false; _levShown = LEV_TOP_N; _levAdminOpen = false;
  _levStaleDrops = 0;
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
    remaining,
    canReviewPairs: _setupAdmin?.canReviewMissingPairs(plant) === true,
    isAdmin: Session.isAdmin(),
    setupActive: Store.masterPlant(plant)?.setup_active !== false,
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
  // (Except for the repaint that shows that very box's replay result: Enter leaves focus in the box.)
  if (!_levForcePaint && (document.activeElement as HTMLElement | null)?.classList?.contains('am-fix-min-input')) return;
  const plant = s.plant;
  if (_levItems.some(i => i.family === 'setup-pair')) _ensureSetupAdmin();
  _setHtml('am-leverage', fixesSectionHtml(_levItems, {
    isAdmin: Session.isAdmin(), adminOpen: _levAdminOpen, limit: _levShown, computing: !_levHave, ctxFor: it => _levCtxFor(it, plant),
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
  if (_levReplaying.has(key)) return;   // a replay for this row is in flight: ignore (and do not record) this entry
  _levTyped.set(key, minutes);   // kept even when skipped below: the next analysis applies it
  if (_levSkipAnalysis()) return;   // no replay during What-If or an optimizer preview
  _levReplaying.add(key);
  const rev0 = Store.rev();
  try {
    const next = await _levDeps.replay(input, item, minutes, _levRunner);
    if (!_active || Store.rev() !== rev0) return;   // a newer analysis re-applies the typed minutes
    _levItems = _levItems.map(i => (i.key === key ? next : i));
    _levForcePaint = true;
    try { _paint(); } finally { _levForcePaint = false; }
  } catch (e) {
    ErrorLog.warn('alert-monitor', 'leverage replay failed', { error: String((e as Error)?.message || e) });
  } finally {
    _levReplaying.delete(key);
  }
}

/**
 * "Show 10 more": the repaint replaces the button, so put keyboard focus back — on the re-rendered button, or, when it
 * is gone (the cap or the end of the list), on the primary button of the first newly revealed row.
 */
function _showMoreFixes(): void {
  const main = Session.isAdmin() ? _levItems : _levItems.filter(i => !i.adminOnly);
  const firstNew = main[Math.min(Math.max(_levShown, LEV_TOP_N), LEV_MAX_RENDER)];
  _levShown = Math.min(_levShown + LEV_STEP, LEV_MAX_RENDER);
  _paint();
  const more = document.querySelector?.<HTMLElement>('[data-am-action="fixes-show-more"]');
  if (more) { more.focus?.(); return; }
  if (!firstNew) return;
  const hits = Array.from(document.querySelectorAll?.<HTMLElement>('[data-lev-action]') ?? []).filter(b => b.dataset.levKey === firstNew.key);
  (hits.find(b => b.classList?.contains('btn-primary')) ?? hits[0])?.focus?.();
}

/** The inline "Replay" button: read that row's minutes box and run the same replay the box's own change event runs. */
function _levReplayClicked(key: string): void {
  const boxes = Array.from(document.querySelectorAll?.('[data-lev-minutes]') ?? []) as HTMLInputElement[];
  const box = boxes.find(b => b.dataset.levMinutes === key);
  if (box) void _levMinutesEntered(key, String(box.value ?? ''));
}

/** The ⋯ menu of a fix row: every action except the row's primary, dispatched through the same handler as the buttons. */
function _openFixMenu(anchor: HTMLElement, key: string): void {
  const item = _levItems.find(i => i.key === key);
  const plant = Store.selectedPlant;
  if (!item || !plant) return;
  const items: MenuItem[] = levActions(item, _levCtxFor(item, plant)).menu.map(a => ({
    id: a.act,
    label: t(a.labelKey, a.labelVars) + (a.admin ? ` (${t('am.lev_admin_fix')})` : ''),
    disabled: a.disabled === true,
    hint: a.disabled ? t('am.whatif_blocked') : undefined,
    data: { levAction: a.act, levKey: key },
    onSelect: () => { _onLevAction(a.act, key); },
  }));
  OverflowMenu.open(anchor, items, { align: 'end', key });
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
    case 'replay-minutes': _levReplayClicked(key); break;
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
  return { s, ctx };
}

function _headline(type: string): string {
  return _nim().AlertsUIAdapter?.headlineFor?.(type) ?? t(`alert.type.${type}`);
}

function _ackLabel(ack: AlertAck | undefined): string | null {
  return ackLabel(ack, t);
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
  const helpKey = `alert.help.${a.type}`;
  const help = t(helpKey);
  return diagnoseHtml(fields, help === helpKey ? '' : help);
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
  const offset = anchor ? alertDayOffset(anchor, rc.s.plantToday) : 0;
  const msgLine = a.msgVars?.line;
  return {
    id: a.id, type: a.type, sev: a.sev, taskId: a.taskId, line: a.line, time: a.time,
    headline: _headline(a.type),
    message: Util.alertMessage(a),
    help: help === helpKey ? '' : help,
    orderNo: no,
    msgLine: msgLine != null && msgLine !== '' ? String(msgLine) : undefined,
    groupBy: rc.s.view.groupBy,
    // The short day label fits the 240 px column; the exact date and time are in the tooltip next to the anchor's name.
    dateText: anchor ? _fmtDay(anchor) : '',
    relText: anchor ? relativeDaysText(offset, t) : '',
    overdue: !!anchor && offset < 0,
    anchorTip: anchor ? `${t(fromDue ? 'am.anchor_due' : 'am.anchor_time')}: ${Util.fmtDT(anchor)}` : t(fromDue ? 'am.anchor_due' : 'am.anchor_time'),
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
    fmtDay: k => _fmtDay(new Date(`${k}T12:00:00`)),
  }, t);
}

/** "Thu 23 Oct" in the page language: the day label of group heads and of a row's when column. */
function _fmtDay(d: Date): string {
  return d.toLocaleDateString(document.documentElement?.lang || 'en-US', { weekday: 'short', day: 'numeric', month: 'short' });
}

function _headView(g: AlertGroup, rc: RowCtx, expanded: boolean): GroupHeadView {
  const first = g.alerts.find(a => rowActionsFor(a).goto) ?? null;
  const counts: GroupCounts = groupCounts(g.alerts, _isAcked);
  return {
    key: g.key, expanded,
    label: _groupLabel(rc.s.view.groupBy, g.key, rc),
    errors: counts.errors, warnings: counts.warnings, orders: counts.orders,
    movable: counts.movableOrders, unacked: counts.unackedIds.length,
    firstAlertId: first?.id ?? null, firstGoto: !!first,
    whatIf: Sandbox.active === true,
  };
}

function _groupCardHtml(g: AlertGroup, rc: RowCtx): string {
  const open = !_collapsed.has(g.key);
  let body = '';
  if (open) {
    const capped = !_showAll.has(g.key) && g.alerts.length > GROUP_ROW_CAP;
    const shown = capped ? g.alerts.slice(0, GROUP_ROW_CAP) : g.alerts;
    body = `<div class="am-gbody" role="list">${shown.map(a => rowHtml(_rowView(a, rc), t)).join('')}</div>`
      + (capped
        ? `<div class="am-more"><button type="button" class="btn sm btn-ghost" data-am-action="show-all" data-group-key="${esc(g.key)}">${esc(t('am.show_all_n', { n: g.alerts.length }))}</button></div>`
        : '');
  }
  return `<section class="am-group panel" data-group-key="${esc(g.key)}">${groupHeadHtml(_headView(g, rc, open), t)}${body}</section>`;
}

/** Group-by none: one card whose rows live in a single VirtualList (fixed ROW_H = 44 px, DIAG_H taller under an open diagnose). */
function _renderNone(g: AlertGroup | undefined, rc: RowCtx): void {
  if (!g) { _teardownVl(); _setHtml('am-groups', ''); return; }
  const shell = `<section class="am-group panel" data-group-key="${esc(g.key)}"><div id="am-none-head"></div>`
    + `<div id="am-none-body"><div class="am-vl-scroll" id="am-vl" role="list"></div></div></section>`;
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
  _syncHeader(s);
  _setHtml('am-summary', _summaryHtml(s));
  // The producer follows plant:selected itself; until it has caught up, leave the body alone.
  if (!(s.plant && s.m.plant !== s.plant)) {
    _setHtml('am-banner', _bannerHtml(s));
    _setHtml('am-prompt', _promptHtml(s));
    _renderLeverage(s);
    _renderGroups(s);
  }
  OverflowMenu.reconcile();   // an open ⋯ menu whose trigger a repaint replaced closes (or follows its data-ovf-key)
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
