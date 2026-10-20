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
import { Util, Config } from '../platform/foundation.mjs';
import { Session } from '../security/session.mjs';
import type { AlertProfile } from '../platform/types.mjs';
import { AlertProfileMatches } from '../insights/alert-profile-matches.mjs';
import type { AlertProfileMatchSet } from '../insights/alert-profile-matches.mjs';
import { AlertProfileClient } from '../insights/alert-profile-client.mjs';
import { ALL_ALERTS_PROFILE_ID, resolveActiveProfileId } from '../insights/alert-profiles.mjs';
import {
  MONITOR_GROUP_BYS, MONITOR_SORTS, MONITOR_CATEGORIES,
  kpiSummary, windowSummary, viewFor, visibleAlertsFor, horizonAlerts, emptyStateFor,
} from './alert-monitor-model.mjs';
import type { MonitorView, EmptyKind, KpiSummary } from './alert-monitor-model.mjs';

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
  visible: NimbusAlert[];
  kpi: KpiSummary;
  empty: EmptyKind;
  scopedCount: number;
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

/* ---------------------------------------------------------------------------
   DOM helpers
   ------------------------------------------------------------------------- */
function _el<E extends HTMLElement = HTMLElement>(id: string): E | null {
  return document.getElementById(id) as E | null;
}

/** innerHTML only when it changed — avoids re-parsing identical markup on every producer tick. */
function _setHtml(id: string, html: string): void {
  const el = _el(id);
  if (!el || _lastHtml.get(id) === html) return;
  _lastHtml.set(id, html);
  el.innerHTML = html;
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
    default: break;
  }
}

function _onChange(e: Event): void {
  const target = e.target as HTMLInputElement | null;
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

  const confMin = plantRow?.conf_score_horizon ?? (Store.userSettings?.confidenceHorizonMinutes as number | undefined) ?? 20160;
  const confCutoff = new Date(clock.getTime() + confMin * Config.MS_MIN);
  const inConfWindow = scoped.filter(a => !a.time || a.time <= confCutoff).length;
  const score = (globalThis as unknown as { NIMBUS?: { Confidence?: { _score?: number } } }).NIMBUS?.Confidence?._score;

  const matchedCount = scoped.filter(a => m.alertIds.has(a.id)).length;
  return {
    plant, m, profiles, profilesLoaded: profilesRaw != null, view,
    defaultId: plant ? _defaultProfileId(plant, profiles) : ALL_ALERTS_PROFILE_ID,
    showAcked, visible, scopedCount: scoped.length,
    kpi: kpiSummary(visible, inHorizon, hz, score, inConfWindow),
    empty: emptyStateFor({
      plant, scopedCount: scoped.length, matchedCount, visibleCount: visible.length,
      isAllAlerts: m.profileId === ALL_ALERTS_PROFILE_ID,
    }),
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
    case 'no-match':
      return `<div class="empty-state am-empty-match"><div class="am-empty-title">${esc(t('am.empty_no_match_title'))}</div>`
        + `<div>${esc(t('am.empty_no_match_msg', { total: s.scopedCount, name: s.m.profile.name }))}</div>`
        + `<button type="button" class="btn sm" data-am-action="switch-all">${esc(t('am.empty_switch_all'))}</button></div>`;
    default:
      return '';
  }
}

// TODO(Task 13): paint the high-leverage fixes panel into #am-leverage.
function _renderLeverage(_s: PaintState): void { /* filled by Task 13 */ }

// TODO(Task 12): paint the grouped alert cards into #am-groups when `s.empty === null`.
function _renderGroups(s: PaintState): void {
  if (s.empty !== null) _setHtml('am-groups', _emptyHtml(s));
}

function _paint(): void {
  if (!_active) return;
  _ensureShell();
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
        case 'alerts:change': _debouncedPaint(); break;
        case 'plant:selected':
        case 'settings:change': _paint(); break;
        case 'sandbox:entered':
        case 'sandbox:exited':
        case 'sandbox:reverted': _paint(); break;   // row actions flip disabled with What-If (Task 12)
        default: break;
      }
    }, 'alert-monitor-pane');
    AlertProfileMatches.subscribe(() => { if (_active) _paint(); });
    AlertProfileClient.subscribe(() => { if (_active) _paint(); });
  },
  /** Called by the shell on every entry to the tab. */
  render(): void {
    _active = true;
    _paint();
  },
  setActive(active: boolean): void { _active = active; },
  isActive(): boolean { return _active; },
};
