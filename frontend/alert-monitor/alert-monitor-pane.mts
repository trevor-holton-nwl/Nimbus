/* =============================================================================
   ALERT MONITOR PANE — the "Alert Monitor" top-level tab (#alerts-tab).

   Lifecycle (the DistributionPane shape): the shell calls init() once on first entry,
   render() on every entry and setActive(false) on leave. `_active` gates every Store /
   producer subscriber so a hidden pane does no work.

   Header (rev 2): title row (profile combobox, Edit / View rules, default, ⋯ page menu), a one-sentence
   summary line and a controls row (Group by, Sort by); then the pinned banner and the empty states. The leverage
   panel (#am-leverage, Task 13) and the alert groups (#am-groups, Task 12) are filled by
   later tasks through the two hook functions at the bottom of the paint path.

   Reads the always-on producer through AlertProfileMatches.current(). The header pick is the active profile for
   the whole app this session (setSessionProfile: Gantt, minimap, bell, drawer, Orders follow it); never emits a
   Store event. "Set as default" is the one control that writes the persisted pref.
   ========================================================================== */

import { Store } from '../platform/store.mjs';
import type { StoreEvent } from '../platform/store.mjs';
import { Util, Config, Modal, Toast, VirtualList, ErrorLog } from '../platform/foundation.mjs';
import { Session } from '../security/session.mjs';
import type { AlertProfile, NimbusTask } from '../platform/types.mjs';
import { AlertProfileMatches } from '../insights/alert-profile-matches.mjs';
import type { AlertProfileMatchSet } from '../insights/alert-profile-matches.mjs';
import { AlertProfileClient } from '../insights/alert-profile-client.mjs';
import { AlertProfileEditor, canDeleteProfile } from './alert-profile-editor.mjs';
import { OverflowMenu } from '../platform/overflow-menu.mjs';
import type { MenuItem } from '../platform/overflow-menu.mjs';
import { AlertAckModal } from './alert-ack-modal.mjs';
import { AlertSlotModal } from './alert-slot-modal.mjs';
import { AlertAcksClient } from '../insights/alert-acks-client.mjs';
import {
  ALL_ALERTS_PROFILE_ID, alertOrderIds, resolveActiveProfileId, impactPoints, compareAlerts, anchorTime, alertDayOffset, ALERT_CATEGORY_ORDER, effectiveCategories, categoryOf,
} from '../insights/alert-profiles.mjs';
import type { GroupContext } from '../insights/alert-profiles.mjs';
import { Alerts, Compute, Utilization, buildPlantSnapshot } from '../insights/services.mjs';
import { groupLeverage, analyzeLeverage, replayWithMinutes } from '../insights/alert-leverage.mjs';
import type { LeverageItem, LeverageInput, LeverageRunner } from '../insights/alert-leverage.mjs';
import { Sandbox } from '../optimization/sandbox.mjs';
import { Engine } from '../optimization/engine.mjs';

import {
  GROUP_MOVE_CONFIRM_ABOVE, SIDE_W_DEFAULT, SIDE_W_MIN, SIDE_W_MAX, clampSideWidth, ROW_H, ROW_H_NARROW, NARROW_AT, detailHeightFor, fixPrimaryAction, summaryLine, windowSummary, viewFor, visibleAlertsFor, horizonAlerts, emptyStateFor,
  rowActionsFor, rowPrimaryActions, groupCounts, rowHtml, rowDetailHtml, materialOf, tagOf, filterAlerts, filterChips, emptyFilter,
  filterIsEmpty, makeBucketer, UNGROUPED_KEY, fixesInView, profileWindow,
  fixesSectionHtml, plantCalendarTarget, levActions, levTitle, levSummaryText, levPairsForReview, LEV_TOP_N, LEV_STEP, LEV_MAX_RENDER,
} from './alert-monitor-model.mjs';
import type { MonitorView, MonitorFilter, MonitorCtx, EmptyKind, LevCtx, FilterDim, RowDetailCtx } from './alert-monitor-model.mjs';
import { matrixModel, matrixHtml, cellFilter, rowFilter, colFilter, filterMatches, clearDims } from './alert-monitor-matrix.mjs';
import { horizonDays, horizonDayKeys, _memoAnchor } from './alert-monitor-overview.mjs';

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
  /** What the profile matched (acknowledged hidden unless asked): the set both views draw from. */
  listed: NimbusAlert[];
  empty: EmptyKind;
  scopedCount: number;
  /** The plant clock now — the start of the impact horizon. */
  horizonStart: Date;
  horizonMinutes: number;
  plantToday: Date;
}

/** What the filter produced this paint (derived, never stored). */
interface Derived {
  ctx: MonitorCtx;
  /** The filter both views read: the page's own, or the global machine filter (`Store.selectedLines`) when no machine is chosen. */
  eff: MonitorFilter;
  active: boolean;
  filtered: NimbusAlert[];
  viewIds: Set<string>;
  wcByLine: Map<string, string>;
  bucketOf: (a: NimbusAlert) => string;
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

/** Rows the matrix side list renders before "Open all N in Inbox →". */
const SIDE_CAP = 80;
/** Machine facet entries before its search box appears. */
const FACET_SEARCH_ABOVE = 10;

let _wired = false;
let _active = false;
let _shellRoot: HTMLElement | null = null;
const _lastHtml = new Map<string, string>();
let _comboFiltered: Array<{ id: string; label: string }> = [];
let _comboActive = -1;

// Transient view state — reset on plant change (and by resetView()). The filter is session-only: never persisted.
let _filter: MonitorFilter = emptyFilter();
let _openRow: string | null = null;           // the one Inbox row whose detail is open
let _sort: 'impact' | 'time' = 'impact';      // the Inbox toolbar's Priority / Date sort
let _facetQ = '';                              // the machine facet's search box
const _collapsed = new Set<string>();         // `${lens}|${group}`: machine-lens groups the user folded
const _quietOpen = new Set<string>();         // work-center groups whose quiet machines are shown
let _lastPlant: string | null | undefined;
let _vl: VirtualList<NimbusAlert> | null = null;   // the Inbox list
let _vlEl: HTMLElement | null = null;
let _scrollInboxTop = false;                  // set by a filter change: the Inbox list returns to its first row on the next paint
let _d: Derived | null = null;                // the last paint's derived set (actions read it)
let _s: PaintState | null = null;

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
   Shell — built once into #alerts-tab. Every control (search, the two segmented controls, the chips) lives here and is
   shown / hidden; only `#am-body` and the side list are re-rendered, so typing in the search box never loses focus.
   ------------------------------------------------------------------------- */
function _shellHtml(): string {
  const seg = (attr: string, id: string, labelKey: string, items: Array<[string, string]>, btnClass = ''): string =>
    `<div class="am-seg" id="${id}" role="group" aria-label="${esc(t(labelKey))}">`
    + items.map(([v, key]) => `<button type="button" class="seg-btn${btnClass ? ' ' + btnClass : ''}" data-am-${attr}="${v}" aria-pressed="false">${esc(t(key))}</button>`).join('')
    + `</div>`;
  return `
<div class="am-head" id="am-head">
  <div class="am-head-row">
    <h2 class="am-title">${esc(t('tab.alerts'))}</h2>
    <span class="spacer"></span>
    <div class="am-profile-blk">
      <span class="am-eyebrow">${esc(t('am.profile_label'))}</span>
      <div class="am-profile-wrap">
        <div class="us-combo" id="am-profile-combo">
          <input type="text" id="am-profile-input" class="us-combo-input" role="combobox" autocomplete="off"
                 aria-autocomplete="list" aria-expanded="false" aria-controls="am-profile-dropdown"
                 aria-label="${esc(t('am.view_as'))}" title="${esc(t('am.view_as'))}" placeholder="${esc(t('am.profile_ph'))}">
          <div class="us-combo-dropdown" id="am-profile-dropdown" role="listbox" hidden></div>
        </div>
      </div>
      <span class="am-badge-default" id="am-is-default" hidden>${esc(t('am.is_default'))}</span>
      <button type="button" class="btn sm btn-ghost" id="am-make-default" data-am-action="make-default" hidden>${esc(t('am.set_default'))}</button>
      <button type="button" class="btn sm btn-ghost" id="am-edit" data-am-action="edit-profile" hidden>${esc(t('am.edit_profile'))}</button>
      <button type="button" class="icon-btn" id="am-page-menu" data-am-action="page-menu" data-ovf-key="page"
              aria-label="${esc(t('am.page_menu'))}" title="${esc(t('am.page_menu'))}" aria-haspopup="menu" aria-expanded="false">⋯</button>
    </div>
  </div>
  <div class="am-head-row am-sum-row">
    <div class="am-summary" id="am-summary"></div>
    <div class="am-gantt-chip" id="am-gantt-chip" hidden></div>
  </div>
  <div class="am-head-row am-ctl-row">
    <div class="am-field">
      <span class="am-eyebrow">${esc(t('am.view_label'))}</span>
      ${seg('set-view', 'am-view-seg', 'am.view_label', [['inbox', 'am.view_inbox'], ['matrix', 'am.view_matrix']])}
    </div>
    <span class="am-vsep"></span>
    <span class="am-lens-wrap" id="am-lens-wrap">
      <div class="am-field">
        <span class="am-eyebrow">${esc(t('am.lens_label'))}</span>
        ${seg('set-lens', 'am-lens-seg', 'am.lens_label', [['machine', 'am.lens_machine'], ['day', 'am.lens_day'], ['group', 'am.lens_group']], 'am-seg-outline')}
      </div>
      <span class="am-vsep"></span>
    </span>
    <div class="am-field am-field-search">
      <span class="am-eyebrow">${esc(t('am.search_label'))}</span>
      <input type="search" class="input am-search" id="am-search" data-am-search autocomplete="off"
             placeholder="${esc(t('am.search_ph'))}" aria-label="${esc(t('am.search_ph'))}">
    </div>
  </div>
  <div class="am-filter-strip" id="am-chips" hidden></div>
</div>
<div class="am-scroll" id="am-scroll">
  <div id="am-banner"></div>
  <div id="am-prompt"></div>
  <div id="am-leverage"></div>
  <div id="am-body" class="am-body"></div>
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
  root.addEventListener('input', _onInput);
  root.addEventListener('keydown', _onKeydown);
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

/** The header pick is the active profile for the session (Gantt, bell, drawer, Orders follow it). Choosing the saved default just clears the override. */
function _chooseProfile(id: string): void {
  const plant = Store.selectedPlant;
  if (!plant) return;
  if (!_comboOptions().some(o => o.id === id)) return;   // stale ids never become the active profile
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
    _chooseProfile(id);
    reflect(); close(); input.blur();
  };

  const renderList = (query: string) => {
    const all = _comboOptions();
    const q = (query || '').trim().toLowerCase();
    const fq = q === _viewedLabel().toLowerCase() ? '' : q;
    _comboFiltered = fq ? all.filter(o => o.label.toLowerCase().includes(fq)) : all;
    const plant = Store.selectedPlant;
    const defId = plant ? _defaultProfileId(plant, (AlertProfileClient.cached(plant) ?? [])) : ALL_ALERTS_PROFILE_ID;
    const vm = AlertProfileMatches.current();
    const viewed = vm.profileId;
    const viewedSub = windowSummary(vm.profile, t);
    if (_comboFiltered.length === 0) {
      dropdown.innerHTML = `<div class="us-combo-empty">${esc(t('us.no_matches'))}</div>`;
      _comboActive = -1;
      return;
    }
    const hint = all.length === 1 && !fq ? `<div class="us-combo-empty">${esc(t('am.profile_none'))}</div>` : '';
    const rows = _comboFiltered.map((o, i) => {
      const sub = o.id === viewed && viewedSub ? `<span class="am-opt-sub">${esc(viewedSub)}</span>` : '';
      return `<div class="us-combo-option${o.id === viewed ? ' selected' : ''}" role="option" aria-selected="${o.id === viewed}" data-profile="${esc(o.id)}" data-idx="${i}">`
        + `<span class="am-opt-text"><span class="am-opt-name">${esc(o.label)}</span>${sub}</span>`
        + `${o.id === defId ? `<span class="us-combo-option-prefix">${esc(t('am.is_default'))}</span>` : ''}</div>`;
    }).join('');
    dropdown.innerHTML = rows + hint;
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
/** Read-modify-write of `alertMonitorView['*'] = {view, lens}` (one page-wide choice; earlier per-profile `groupBy` entries are ignored once it exists). */
function _persistView(patch: Partial<MonitorView>): void {
  const stored = (Store.pref('alertMonitorView') as Record<string, Record<string, unknown> | undefined> | null | undefined) ?? {};
  Session.setPref('alertMonitorView', { ...stored, '*': { ...(stored['*'] ?? {}), ...patch } });
  _paint();
}

function _openProfileEditor(): void {
  const plant = Store.selectedPlant;
  const id = AlertProfileMatches.current().profileId;
  if (plant && id !== ALL_ALERTS_PROFILE_ID) AlertProfileEditor.open({ plant, profileId: id });
}

/** ⋯ page menu: "New profile…" (opens the editor on a blank draft; a successful save hands back the view) and the
 *  persisted "Show acknowledged" toggle. */
function _openPageMenu(anchor: HTMLElement): void {
  const plant = Store.selectedPlant;
  const items: MenuItem[] = [
    {
      id: 'create-profile', label: `${t('ape.new_profile')}…`, disabled: !plant,
      onSelect: () => { if (plant) AlertProfileEditor.open({ plant, fromPicker: true }); },
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
  const m = AlertProfileMatches.current();
  const existing = (Store.pref('alertProfileByPlant') as Record<string, string> | null | undefined) ?? {};
  Session.setPref('alertProfileByPlant', { ...existing, [plant]: m.profileId });
  AlertProfileMatches.setSessionProfile(null);   // the pref now says the same thing
}

/* ---- Filter state (session-only) ---- */
const _DIMS = ['machines', 'wcGroups', 'days', 'categories'] as const;

/** A filter change: the fixes list rewinds to its first page, then one repaint and the caller's focus restore. */
function _filterChanged(refocus?: () => void): void {
  _levShown = LEV_TOP_N;
  _scrollInboxTop = true;
  _paint();
  refocus?.();
}

/** A matrix click: the filter this part names replaces those dimensions; clicking the filter that is already set clears exactly them. */
function _applyPart(part: Partial<MonitorFilter>, refocus?: () => void): void {
  if (filterMatches(_filter, part)) { _filter = clearDims(_filter, part); } else {
    const next = { ..._filter } as unknown as Record<string, unknown>;
    for (const dim of _DIMS) if (part[dim]) next[dim] = new Set(part[dim] as Set<string>);
    _filter = next as unknown as MonitorFilter;
  }
  _filterChanged(refocus);
}

/** An Inbox facet toggle (`dim:key`); the machine facet belongs to exactly one work-center group, so it clears when that stops being true. */
function _toggleFacet(dim: FilterDim, key: string): void {
  if (dim === 'q') return;
  const set = new Set(_filter[dim] as Set<string>);
  if (set.has(key)) set.delete(key); else set.add(key);
  const next = { ..._filter, [dim]: set } as MonitorFilter;
  if (dim === 'wcGroups') { _facetQ = ''; if (set.size !== 1) next.machines = new Set(); }
  _filter = next;
  _filterChanged();
}

function _removeChip(dim: FilterDim, key: string): void {
  if (dim === 'q') {
    _filter = { ..._filter, q: '' };
    const box = _el<HTMLInputElement>('am-search');
    if (box) box.value = '';
  } else {
    const set = new Set(_filter[dim] as Set<string>);
    set.delete(key);
    _filter = { ..._filter, [dim]: set } as MonitorFilter;
    if (dim === 'wcGroups' && set.size !== 1) _filter.machines = new Set();
  }
  _filterChanged();
}

function _clearFilter(): void {
  _filter = emptyFilter();
  _facetQ = '';
  const box = _el<HTMLInputElement>('am-search');
  if (box) box.value = '';
  _filterChanged();
}

function _refocusWhere(selector: string, match: (el: HTMLElement) => boolean): void {
  const els = Array.from(document.querySelectorAll?.<HTMLElement>(selector) ?? []);
  els.find(match)?.focus?.({ preventScroll: true });
}

const _isParsedDim = (d: string): d is FilterDim => d === 'machines' || d === 'wcGroups' || d === 'days' || d === 'categories' || d === 'q';

function _toggleRow(id: string): void {
  _openRow = _openRow === id ? null : id;
  _paint();
  _refocusWhere('.am-xrow', el => el.getAttribute('data-alert-id') === id);
}

function _onClick(e: Event): void {
  const target = e.target as HTMLElement | null;
  const q = (sel: string): HTMLElement | null => (target?.closest?.(sel) as HTMLElement | null) ?? null;
  const chip = q('[data-am-chip]');
  if (chip) {
    const [dim, ...rest] = (chip.getAttribute?.('data-am-chip') ?? chip.dataset?.amChip ?? '').split(':');
    if (dim && _isParsedDim(dim)) _removeChip(dim, rest.join(':'));
    return;
  }
  const viewBtn = q('[data-am-set-view]');
  const viewId = viewBtn?.dataset.amSetView;
  if (viewId === 'inbox' || viewId === 'matrix') { _persistView({ view: viewId }); return; }
  const lensBtn = q('[data-am-set-lens]');
  const lensId = lensBtn?.dataset.amSetLens;
  if (lensId === 'machine' || lensId === 'day' || lensId === 'group') { _persistView({ lens: lensId }); return; }
  const sortBtn = q('[data-am-sort]');
  const sortId = sortBtn?.dataset.amSort;
  if (sortId === 'impact' || sortId === 'time') { _sort = sortId; _paint(); return; }
  const facet = q('[data-am-facet]');
  if (facet) {
    const raw = facet.getAttribute?.('data-am-facet') ?? facet.dataset?.amFacet ?? '';
    const i = raw.indexOf(':');
    const dim = raw.slice(0, i);
    if (i > 0 && _isParsedDim(dim)) {
      _toggleFacet(dim, raw.slice(i + 1));
      _refocusWhere('[data-am-facet]', el => (el.getAttribute('data-am-facet') ?? '') === raw);
    }
    return;
  }
  const lens = _s?.view.lens ?? 'machine';
  const cell = q('[data-am-cell]');
  if (cell) {
    const row = cell.getAttribute?.('data-am-row') ?? cell.dataset?.amRow ?? '';
    const col = cell.getAttribute?.('data-am-col') ?? cell.dataset?.amCol ?? '';
    const key = cell.getAttribute?.('data-am-cell') ?? cell.dataset?.amCell ?? '';
    _applyPart(cellFilter(lens, row, col), () => _refocusWhere('[data-am-cell]', el => (el.getAttribute('data-am-cell') ?? '') === key));
    return;
  }
  const rowh = q('.am-mx-rowh');
  if (rowh) {
    const row = rowh.getAttribute?.('data-am-row') ?? rowh.dataset?.amRow ?? '';
    _applyPart(rowFilter(lens, row), () => _refocusWhere('.am-mx-rowh', el => el.getAttribute('data-am-row') === row));
    return;
  }
  const colh = q('.am-mx-colh');
  if (colh) {
    const col = colh.getAttribute?.('data-am-col') ?? colh.dataset?.amCol ?? '';
    _applyPart(colFilter(lens, col), () => _refocusWhere('.am-mx-colh', el => el.getAttribute('data-am-col') === col));
    return;
  }
  const caret = q('.am-mx-caret');
  if (caret) {
    const g = caret.getAttribute?.('data-am-group') ?? caret.dataset?.amGroup ?? '';
    const k = `${lens}|${g}`;
    if (_collapsed.has(k)) _collapsed.delete(k); else _collapsed.add(k);
    _paint();
    _refocusWhere('.am-mx-caret', el => el.getAttribute('data-am-group') === g);
    return;
  }
  const quiet = q('[data-am-quiet]');
  if (quiet) {
    const g = quiet.getAttribute?.('data-am-quiet') ?? quiet.dataset?.amQuiet ?? '';
    if (_quietOpen.has(g)) _quietOpen.delete(g); else _quietOpen.add(g);
    _paint();
    _refocusWhere('[data-am-quiet]', el => el.getAttribute('data-am-quiet') === g);
    return;
  }
  const lev = q('[data-lev-action]');
  if (lev?.dataset.levAction) { _onLevAction(lev.dataset.levAction, lev.dataset.levKey ?? ''); return; }
  const levMenu = q('[data-lev-menu]');
  if (levMenu?.dataset.levMenu) { _openFixMenu(levMenu, levMenu.dataset.levMenu); return; }
  const rowMenu = q('.am-row-menu');
  if (rowMenu?.dataset.alertId) { _openRowMenu(rowMenu, rowMenu.dataset.alertId); return; }
  const btn = q('[data-am-action]');
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
    case 'clear-filter': _clearFilter(); break;
    case 'clear-outline': AlertProfileMatches.setFocusTaskIds(null); break;   // the subscription repaints the chip
    case 'open-inbox': _persistView({ view: 'inbox' }); break;
    case 'show-gantt': if (_d) _showOnGantt(_d.filtered); break;
    case 'open-orders': if (_d) _openOrdersInTable(_viewOrderIds(_d.filtered)); break;
    case 'move-view': _moveView(); break;
    case 'ack-view': _ackView(); break;
    case 'fixes-show-more': _showMoreFixes(); break;
    case 'fixes-toggle':
      Session.setPref('alertMonitorFixes', Store.pref('alertMonitorFixes') === 'collapsed' ? 'open' : 'collapsed');
      _paint();
      document.querySelector?.<HTMLElement>('[data-am-action="fixes-toggle"]')?.focus?.();   // the repaint replaced the button
      break;
    case 'fixes-admin-toggle':
      _levAdminOpen = !_levAdminOpen; _paint();
      document.querySelector?.<HTMLElement>('[data-am-action="fixes-admin-toggle"]')?.focus?.();   // the repaint replaced the button
      break;
    default: {
      const act = q('[data-alert-action]');
      if (act?.dataset.alertAction) { _onAlertAction(act); break; }
      const row = q('.am-xrow');
      const rid = row?.getAttribute?.('data-alert-id') ?? row?.dataset?.alertId;
      if (rid) _toggleRow(rid);
      break;
    }
  }
}

/** Enter on a focused row (the row itself, not a button inside it) opens or closes its detail. */
function _onKeydown(e: Event): void {
  const ke = e as KeyboardEvent;
  if (ke.key !== 'Enter') return;
  const target = ke.target as HTMLElement | null;
  const row = target?.closest?.('.am-xrow') as HTMLElement | null;
  if (!row || target !== row) return;
  const rid = row.getAttribute?.('data-alert-id') ?? row.dataset?.alertId;
  if (!rid) return;
  ke.preventDefault?.();
  _toggleRow(rid);
}

function _onInput(e: Event): void {
  const target = e.target as HTMLInputElement | null;
  const box = target?.closest?.('[data-am-search]') as HTMLInputElement | null;
  if (box) { _filter = { ..._filter, q: String(box.value ?? '') }; _filterChanged(); return; }
  const fq = target?.closest?.('[data-am-facet-q]') as HTMLInputElement | null;
  if (fq) {
    _facetQ = String(fq.value ?? '');
    _paint();
    const next = _el<HTMLInputElement>('am-facet-q');
    next?.focus?.({ preventScroll: true });
    try { next?.setSelectionRange?.(_facetQ.length, _facetQ.length); } catch { /* not a text input in a stub */ }
  }
}

const _isAcked = (id: string): boolean => AlertProfileMatches.current().acked.has(id);

/** Put keyboard focus back on a ⋯ trigger a repaint replaced: the new trigger carries the same data-ovf-key. */
function _refocusKey(key: string): boolean {
  const next = Array.from(document.querySelectorAll?.<HTMLElement>('[data-ovf-key]') ?? []).find(el => el.getAttribute('data-ovf-key') === key);
  if (!next) return false;
  next.focus?.();
  return true;
}

/** The rows next to an alert in the current view: where focus goes when its own trigger is gone after an action. */
function _rowNear(alertId: string): string[] {
  const list = _d?.filtered ?? [];
  const i = list.findIndex(a => a.id === alertId);
  return i < 0 ? [] : [list[i + 1]?.id, list[i - 1]?.id].filter((x): x is string => !!x);
}

function _restoreRowFocus(alertId: string, near: string[]): void {
  if (_refocusKey(alertId)) return;
  for (const id of near) if (_refocusKey(id)) return;
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
      if (m.action === 'ack' || m.action === 'override' || m.action === 'slot') {
        // These open a modal that takes focus and hands it back to the opener: make the live trigger the opener first.
        _refocusKey(alertId);
        _runAlertAction(m.action, alertId, taskId);
        return;
      }
      // fix / diagnose / unack change what the view shows: repaint now, then put focus on this row's new trigger (or its neighbour).
      const near = _rowNear(alertId);
      const done = (): void => { if (_active) _paint(); _restoreRowFocus(alertId, near); };
      const pending = _runAlertAction(m.action, alertId, taskId);
      if (pending) void pending.then(done); else done();
    },
  }));
  OverflowMenu.open(anchor, items, { align: 'end', key: alertId });
}

/** "Move N…": confirms above GROUP_MOVE_CONFIRM_ABOVE, then runs the one-click fix on each movable alert in view in turn. Not available in What-If. */
function _moveView(): void {
  if (Sandbox.active || !_d) return;
  const counts = groupCounts(_d.filtered, () => false);
  const n = counts.movableOrders;   // distinct orders, as the button says
  if (n === 0) return;
  const ids = counts.movableIds;
  if (n <= GROUP_MOVE_CONFIRM_ABOVE) { void _runBatchMove(ids); return; }
  void Modal.confirm({ title: t('am.group_fix_n', { n }), message: t('am.group_fix_confirm', { n }) })
    .then(ok => { if (ok) void _runBatchMove(ids); });
}

/** "Acknowledge N…": one reason / end date for every not-yet-acknowledged alert in view (not just the rendered rows). */
function _ackView(): void {
  const plant = Store.selectedPlant;
  if (!_d || !plant) return;
  const ids = groupCounts(_d.filtered, _isAcked).unackedIds;
  if (ids.length) AlertAckModal.open({ plant, alertIds: ids });
}

/**
 * Sequential batch: `await Alerts.applyFix(id, { quiet: true })` resolves true and dismisses the alert on success (false = refused:
 * nothing changed and the alert stays, e.g. a Fix overload that would leave an error or was cancelled at the tooling confirm; the
 * batch then simply continues with the next alert), so an id that has left Store.alerts afterwards means that order moved. The moved order's other alerts (and its peers' alerts) stay in
 * Store.alerts until the debounced recompute, so any alert naming an already-moved order is skipped: it describes a
 * position that no longer exists. One summary toast.
 */
async function _runBatchMove(ids: string[]): Promise<void> {
  if (Sandbox.active) return;
  const movedOrders = new Set<string>();
  let blocked = 0;
  try {
    for (const id of ids) {
      const a = Store.alerts.find(x => x.id === id);
      if (!a) continue;                                    // already gone (cleared by an earlier move or a recompute)
      if (alertOrderIds(a).some(oid => movedOrders.has(oid))) continue;   // the order itself or ANY holder/peer already moved
      const applied = await Alerts.applyFix(id, { quiet: true, onBlocked: () => { blocked++; } });
      if (applied !== false && !Store.alerts.some(x => x.id === id)) movedOrders.add(String(a.taskId ?? id));
    }
  } catch (e) {
    Toast.show((e as Error)?.message || String(e), 'error');   // reported once; what moved before the throw is still summarised below
  } finally {
    const moved = movedOrders.size;
    Toast.show(t(moved === 1 ? 'am.group_fix_done_one' : 'am.group_fix_done', { n: moved }), moved > 0 ? 'success' : 'warn');
    // Refused fixes are quiet inside the batch; one summary here instead of one toast per refused alert.
    if (blocked > 0) Toast.show(t('toast.fix_overload_blocked_batch', { n: blocked }), 'warn', 7000);
    if (_active) _paint();
    _refocusWhere('[data-am-action]', el => el.getAttribute('data-am-action') === 'move-view');
  }
}

/**
 * "Show on Gantt": the outline request goes FIRST (the Gantt follows `focusIds`), then the Gantt jumps to the first alert that has
 * a line and a time. `AlertsUIAdapter.focus` returns early for an alert with neither, which is fine: the outline still stands.
 */
function _showOnGantt(alerts: ReadonlyArray<NimbusAlert>): void {
  const taskIds = new Set<string>();
  for (const a of alerts) for (const oid of alertOrderIds(a)) taskIds.add(oid);
  AlertProfileMatches.setFocusTaskIds(taskIds);
  const first = alerts.find(a => rowActionsFor(a).goto);
  if (first) _nim().AlertsUIAdapter?.focus?.(first.id);
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
      return Promise.resolve(Alerts.applyFix(alertId)).then(() => undefined, error => { Toast.show((error as Error)?.message || String(error), 'error'); });
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
        _openRow = _openRow === alertId ? null : alertId;   // the detail block of this row
        _paint();
      }
      break;
    }
    case 'cell': {
      const a = Store.alerts.find(x => x.id === alertId);
      if (a?.line && a.time) nim.AlertsUIAdapter?.showForCell?.(a.line, Util.dayKey(a.time));
      break;
    }
    case 'slot': {
      // Like Fix / Override this writes the plan, so it is blocked in What-If; the dialog confirms and places the order itself.
      if (Sandbox.active) return;
      const plant = Store.selectedPlant;
      if (plant && taskId) AlertSlotModal.open({ plant, taskId, alertId });
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
  if (mins?.dataset.levMinutes) void _levMinutesEntered(mins.dataset.levMinutes, String(mins.value ?? ''));
}

/* ---------------------------------------------------------------------------
   Paint
   ------------------------------------------------------------------------- */
function _gatherState(): PaintState {
  const plant = Store.selectedPlant ?? null;
  const m = AlertProfileMatches.current();
  const profilesRaw = plant ? AlertProfileClient.cached(plant) : null;
  const profiles = profilesRaw ?? [];
  const view = viewFor(Store.pref('alertMonitorView') as Parameters<typeof viewFor>[0], m.profileId);
  const showAcked = Store.pref('alertsShowAcknowledged') === true;

  const plantRow = plant ? Store.masterPlant(plant) : null;
  const clock = plant ? Util.plantClock(plant) : new Date();
  const lines = new Set(plant ? Store.linesForSelectedPlant() : []);
  const scoped = horizonAlerts(Store.alerts, lines, null);
  const listed = visibleAlertsFor(scoped, m.alertIds, m.acked, showAcked);

  const confMin = plantRow?.conf_score_horizon ?? (Store.userSettings?.confidenceHorizonMinutes as number | undefined) ?? 20160;
  const matchedCount = scoped.filter(a => m.alertIds.has(a.id)).length;
  return {
    plant, m, profiles, profilesLoaded: profilesRaw != null, view,
    defaultId: plant ? _defaultProfileId(plant, profiles) : ALL_ALERTS_PROFILE_ID,
    showAcked, scoped, listed, scopedCount: scoped.length,
    empty: emptyStateFor({
      plant, scopedCount: scoped.length, matchedCount, visibleCount: listed.length,
      isAllAlerts: m.profileId === ALL_ALERTS_PROFILE_ID,
    }),
    horizonStart: clock, horizonMinutes: confMin,
    plantToday: plant ? Util.plantToday(plant) : (Util.startOfDay(clock) as Date),
  };
}

const _orderNoOf = (a: NimbusAlert): string => {
  const task = a.taskId ? Store.tasks[a.taskId] : undefined;
  return task ? String(task.ORDER ?? task.PRODUCTION_ORDER ?? '') : String(a.msgVars?.order ?? '');
};

/** The filter's context: the day columns, the due anchor memo, the plant's machines with their work-center group, and the search text sources. */
function _ctxFor(s: PaintState): MonitorCtx {
  const anchor = _memoAnchor({ tasksById: Store.tasks, plantToday: s.plantToday, horizonMinutes: s.horizonMinutes, window: profileWindow(s.m.profile) });
  const lines = s.plant ? Store.masterLinesForPlant(s.plant) : [];
  return {
    plantToday: s.plantToday,
    horizonDays: horizonDays(s.horizonMinutes, profileWindow(s.m.profile)),
    anchorOf: a => anchor(a, a.taskId ? Store.tasks[a.taskId] : undefined),
    machines: lines.map(l => ({ id: l.machine, wc_group: l.wc_group })),
    orderNoOf: _orderNoOf,
    materialOf: a => materialOf(a, Store.tasks),
    tagOf: a => tagOf(a, t),
  };
}

function _derive(s: PaintState): Derived {
  const ctx = _ctxFor(s);
  const sel = Store.selectedLines;   // the global machine filter: read, never replaced
  const eff: MonitorFilter = _filter.machines.size || !sel.size ? _filter : { ..._filter, machines: new Set(sel) };
  const active = !filterIsEmpty(eff);
  const filtered = active ? filterAlerts(s.listed, eff, ctx) : s.listed;
  const wcByLine = new Map<string, string>();
  for (const mc of ctx.machines) wcByLine.set(mc.id, mc.wc_group ? String(mc.wc_group) : UNGROUPED_KEY);
  return { ctx, eff, active, filtered, viewIds: new Set(filtered.map(a => a.id)), wcByLine, bucketOf: makeBucketer(ctx) };
}

/** Header rows 1 and 3: the combobox, Edit / View rules, the default control, and the static view / lens / search / chip controls. */
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

  const press = (attr: 'amSetView' | 'amSetLens', now: string): void => {
    document.querySelectorAll<HTMLElement>(attr === 'amSetView' ? '[data-am-set-view]' : '[data-am-set-lens]').forEach(b => {
      const on = b.dataset[attr] === now;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
      (b as HTMLButtonElement).disabled = !s.plant;
    });
  };
  press('amSetView', s.view.view);
  press('amSetLens', s.view.lens);
  const lensWrap = _el('am-lens-wrap');
  if (lensWrap) lensWrap.hidden = s.view.view !== 'matrix';   // the lens belongs to the matrix; the Inbox facets are the three charts at once
  const box = _el<HTMLInputElement>('am-search');
  if (box) {
    box.disabled = !s.plant;
    if (document.activeElement !== box && box.value !== _filter.q) box.value = _filter.q;
  }
}

/** The active filter as removable chips (one per value) plus Clear; empty and hidden when nothing is filtered. */
function _renderChips(s: PaintState): void {
  const el = _el('am-chips');
  if (!el) return;
  const day = (k: string): string => _dayLabel(k);
  const chips = filterChips(_filter, {
    wc: k => (k === UNGROUPED_KEY ? t('am.ungrouped') : k), day, category: c => t(`ape.cat_${c}`),
  });
  if (!s.plant || !chips.length) { _setHtml('am-chips', ''); el.hidden = true; return; }
  _setHtml('am-chips', `<span class="am-eyebrow am-filt-lead">${esc(t('am.filter_lead'))}</span>` + chips.map(c => `<span class="am-chip"><span class="am-chip-lbl">${esc(c.label)}</span>`
    + `<button type="button" class="am-chip-x" data-am-chip="${esc(c.dim)}:${esc(c.key)}" aria-label="${esc(t('am.filter_remove', { name: c.label }))}">✕</button></span>`).join('')
    + `<button type="button" class="btn sm am-filt-clear" data-am-action="clear-filter">${esc(t('am.filter_clear'))}</button>`);
  el.hidden = false;
}

/** The R2 chip: "◎ N outlined · Clear", read from what the Gantt actually outlines. */
function _renderGanttChip(): void {
  const el = _el('am-gantt-chip');
  if (!el) return;
  const n = AlertProfileMatches.current().focusIds?.size ?? 0;
  if (!n) { _setHtml('am-gantt-chip', ''); el.hidden = true; return; }
  _setHtml('am-gantt-chip', `<span class="am-gantt-n">◎ ${esc(t(n === 1 ? 'am.gantt_outline_one' : 'am.gantt_outline', { n }))}</span>`
    + `<button type="button" class="btn sm btn-ghost" data-am-action="clear-outline">${esc(t('am.gantt_outline_clear'))}</button>`);
  el.hidden = false;
}

/** Header row 2: one sentence in mono counts over the profile's alerts (alerts, errors, warnings). */
function _summaryHtml(s: PaintState): string {
  const line = summaryLine({
    hasPlant: !!s.plant, alerts: s.listed, profileId: s.m.profileId, profileName: s.m.profile.name, profile: s.m.profile, focus: null,
    linesSelected: Store.selectedLines.size,
  }, t);
  return `<span>${esc(line.text)}</span>`;
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
    setupTasks: Store.tasksByPlant(plant),
    lines: new Set(Store.linesForSelectedPlant()),
    setupSnapshot: Store.setupSnapshot,
    masterPlant: Store.masterPlant(plant),
    snapshotBase: buildPlantSnapshot(plant),
    // The replay scores over exactly this window: [start of the plant's day, +ceil(horizon/1440) days).
    baselineMatrix: Utilization.computeMatrix(s.plantToday, days) as unknown as NimbusUtilizationMatrix,
    // The score counts dismissed alerts: score over the same pre-dismiss list and machine count the badge uses, so "before" equals it.
    scoringAlerts: Alerts.confidenceInput().alerts,
    machines: Alerts.confidenceInput().machines,
  };
}

const _levDeps: LevDeps = {
  buildInput: _levBuildInput, group: groupLeverage, analyze: analyzeLeverage, replay: replayWithMinutes,
};

const _levRunner: LeverageRunner = (base, variants, opts) => Compute.leverageBatch(base, variants, opts);

/** One AbortController per leverage run (and per minutes replay). Aborted on plant change, tab leave and when the
 *  plan moves, which terminates the dedicated worker instead of waiting the batch out. */
const _levControllers = new Set<AbortController>();
function _levAbortAll(): void {
  for (const c of _levControllers) c.abort();
  _levControllers.clear();
}
const _isAbortOrTimeout = (e: unknown): 'abort' | 'timeout' | null => {
  const n = (e as Error | null)?.name;
  return n === 'AbortError' ? 'abort' : n === 'TimeoutError' ? 'timeout' : null;
};
/** The plan moved: cancel what is computing against the old plan, then look again after the debounce. */
function _levPlanMoved(): void { _levAbortAll(); _levDebounced(); }

let _levItems: LeverageItem[] = [];
let _levShownItems: LeverageItem[] = [];   // what the panel lists now: _levItems, or only the fixes that touch the filtered view
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
  _levAbortAll();
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

/** A YYYY-MM-DD key in the user's date format. */
function _fmtDayKey(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return y && m && d ? Util._fmtDatePref(new Date(y, m - 1, d)) : day;
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
    alertsById: _alertsById(),
    fmtDay: _fmtDayKey,
  };
}

let _abSrc: ReadonlyArray<NimbusAlert> | null = null;
let _abMap: ReadonlyMap<string, NimbusAlert> = new Map();
/** `Store.alerts` by id, rebuilt only when the list itself was replaced (the fix rows ask once each per paint). */
function _alertsById(): ReadonlyMap<string, NimbusAlert> {
  if (_abSrc !== Store.alerts) { _abSrc = Store.alerts; _abMap = new Map(Store.alerts.map(a => [a.id, a])); }
  return _abMap;
}

function _renderLeverage(s: PaintState, d: Derived | null): void {
  if (!s.plant || s.scopedCount === 0) {
    _levReset(null);
    _levShownItems = [];
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
  // Scoring stays plant-wide (D10 reversed for DISPLAY only): while a filter is on, only the fixes that touch the view are listed.
  const scopedFixes = d && d.active ? fixesInView(_levItems, d.viewIds) : null;
  _levShownItems = scopedFixes ? scopedFixes.map(x => x.item) : _levItems;
  const inView = new Map((scopedFixes ?? []).map(x => [x.item.key, x.inView] as const));
  _setHtml('am-leverage', fixesSectionHtml(_levShownItems, {
    collapsed: Store.pref('alertMonitorFixes') === 'collapsed',
    isAdmin: Session.isAdmin(), adminOpen: _levAdminOpen, limit: _levShown, computing: !_levHave,
    noneInView: !!scopedFixes && _levItems.length > 0 && _levShownItems.length === 0,
    ctxFor: it => (scopedFixes ? { ..._levCtxFor(it, plant), inView: inView.get(it.key) } : _levCtxFor(it, plant)),
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
  const ctl = new AbortController();
  _levControllers.add(ctl);
  try {
    let next = await _levDeps.analyze(input, _levRunner, items, { signal: ctl.signal });   // reuse the grouping phase 1 already painted
    for (const [key, minutes] of _levTyped) {
      const it = next.find(i => i.key === key);
      if (it?.requiresMinutes) {
        const done = await _levDeps.replay(input, it, minutes, _levRunner, { signal: ctl.signal });
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
    const why = _isAbortOrTimeout(e);
    if (why === 'timeout') {
      // The worker was stopped: keep the phase-1 removal-only cards already painted. No UI string (quiet by design).
      ErrorLog.warn('alert-monitor', 'leverage analysis timed out; showing the quick ranking', { error: String((e as Error)?.message || e) });
    } else if (why !== 'abort') {
      ErrorLog.warn('alert-monitor', 'leverage analysis failed', { error: String((e as Error)?.message || e) });
    }
  } finally {
    _levControllers.delete(ctl);
    _levInFlight = false;
    if (_levRerun) { _levRerun = false; if (_levHave) _levDebounced(); else void _levRun(); }
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
  const ctl = new AbortController();
  _levControllers.add(ctl);
  try {
    const next = await _levDeps.replay(input, item, minutes, _levRunner, { signal: ctl.signal });
    if (!_active || Store.rev() !== rev0) return;   // a newer analysis re-applies the typed minutes
    _levItems = _levItems.map(i => (i.key === key ? next : i));
    _levForcePaint = true;
    try { _paint(); } finally { _levForcePaint = false; }
  } catch (e) {
    if (_isAbortOrTimeout(e) !== 'abort') {
      ErrorLog.warn('alert-monitor', _isAbortOrTimeout(e) === 'timeout' ? 'leverage replay timed out' : 'leverage replay failed', { error: String((e as Error)?.message || e) });
    }
  } finally {
    _levControllers.delete(ctl);
    _levReplaying.delete(key);
  }
}

/**
 * "Show 10 more": the repaint replaces the button, so put keyboard focus back — on the re-rendered button, or, when it
 * is gone (the cap or the end of the list), on the primary button of the first newly revealed row.
 */
function _showMoreFixes(): void {
  const main = Session.isAdmin() ? _levShownItems : _levShownItems.filter(i => !i.adminOnly);
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
  const byId = new Map(Store.alerts.map(a => [a.id, a]));
  _showOnGantt(item.alertIds.map(id => byId.get(id)).filter((a): a is NimbusAlert => !!a));
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
      // One at a time: a Fix overload may stop at its own confirm, and each fix reads the schedule the previous one left.
      void (async () => {
        let moved = 0, blocked = 0;
        try {
          for (const id of action.fixableAlertIds) {
            if (await Alerts.applyFix(id, { quiet: true, onBlocked: () => { blocked++; } })) moved++;
          }
        } catch (error) { Toast.show((error as Error)?.message || String(error), 'error'); }
        finally {
          Toast.show(t(moved === 1 ? 'am.group_fix_done_one' : 'am.group_fix_done', { n: moved }), moved > 0 ? 'success' : 'warn');
          if (blocked > 0) Toast.show(t('toast.fix_overload_blocked_batch', { n: blocked }), 'warn', 7000);
        }
      })();
      break;
    case 'edit-calendar':
      if (action.kind === 'calendar-day') {
        void import('../calendar/edit-calendar.mjs').then(m => m.EditCalendar.open(action.line));
      }
      break;
    case 'edit-plant-calendar':
      if (Session.isAdmin() && action.kind === 'optimize-window') {
        // The period that governs the window's first day when one exists (that is where its hours live), else the plant's base hours.
        const target = plantCalendarTarget(Store.getPlantPeriods(plant), action.startDate);
        void import('../calendar/edit-calendar.mjs').then(m => (target.kind === 'period' ? m.EditCalendar.openPeriod(plant, target.id) : m.EditCalendar.openPlant(plant)));
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
    case 'tool-inventory':
      if (action.kind === 'tool') {
        const tool = action.tool;
        nim.App?.goto?.('masterdata');
        nim.App?.gotoMasterSub?.('tool-inventory');
        void import('../master-data/tool-inventory.mjs').then(m => m.ToolInventory.openForTool(plant, tool));
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
   Views: Matrix | Inbox over one filtered set
   ------------------------------------------------------------------------- */
function _teardownVl(): void {
  if (_vl) { _vl.destroy(); _vl = null; }
  _vlEl = null;
}

/** "Thu 10/23" (weekday in the page language, date per the dateFormat pref): a day label. */
function _fmtDay(d: Date): string {
  const lang = document.documentElement?.lang || 'en-US';
  let f = _dayFmt.get(lang);
  if (!f) {
    try { f = new Intl.DateTimeFormat(lang, { weekday: 'short' }); }
    catch { f = new Intl.DateTimeFormat('en-US', { weekday: 'short' }); }
    _dayFmt.set(lang, f);
  }
  return `${f.format(d)} ${Util.fmtDateShortPref(d)}`;
}
/** One formatter per page language: constructing an Intl.DateTimeFormat per row dominated the row-building cost. */
const _dayFmt = new Map<string, Intl.DateTimeFormat>();
const _noonOf = (k: string): Date => new Date(`${k}T12:00:00`);

/** A day bucket's label: `overdue` / `later` / `none` or a day key. */
function _dayLabel(key: string): string {
  if (key === 'overdue') return t('am.bucket_overdue');
  if (key === 'later') return t('am.bucket_later');
  if (key === 'none') return t('am.bucket_none');
  return _fmtDay(_noonOf(key));
}

/** Orders whose bar touches this machine-day (the overload alert's "Orders on this day"). */
function _ordersOnDay(line: string, dayKey: string): number {
  const plant = Store.selectedPlant;
  const tasks = plant ? Store.tasksByPlant(plant) : [];
  let n = 0;
  for (const task of tasks) if (task.MACHINE === line && Util.overlapsDay(task, dayKey)) n++;
  return n;
}

/**
 * What the open row's detail block shows. An alert with an order shows its due, planned finish and firming; one without
 * (overload, closed day, plant with no time zone) shows "Machine · day" instead, and an overload adds how many orders sit on
 * that day and a Day details action. Lines that do not apply are absent, not "—".
 */
function _detailCtxFor(a: NimbusAlert): RowDetailCtx {
  const task = a.taskId ? Store.tasks[a.taskId] : undefined;
  const material = materialOf(a, Store.tasks, x => (x.time ? _fmtDay(x.time) : ''));
  const ctx: RowDetailCtx = { message: Util.alertMessage(a), material, t };
  if (task) {
    const due = Util.dueInstant(task);
    const end = Util.scheduledEnd(task);
    ctx.due = due ? Util.fmtDTPref(due) : '—';
    ctx.plannedFinish = end ? Util.fmtDTPref(end) : '—';
    ctx.firming = Engine.firmingStatus(task).firmed ? Engine.firmStatusText(task) : t('am.diag_not_firmed');
  } else {
    ctx.materialLabelKey = 'am.detail_machine_day';
    if (a.type === 'overload' && a.line && a.time) {
      ctx.ordersOnDay = _ordersOnDay(a.line, Util.dayKey(a.time));
      ctx.dayAction = true;
    }
  }
  return ctx;
}

/** One compact row (Inbox and the matrix side list); the open row carries its detail block. */
function _rowHtmlFor(a: NimbusAlert, s: PaintState, d: Derived): string {
  const task = a.taskId ? Store.tasks[a.taskId] : undefined;
  const anchor = anchorTime(a, task);
  const offset = anchor ? alertDayOffset(anchor, s.plantToday) : 0;
  const material = materialOf(a, Store.tasks, x => (x.time ? _fmtDay(x.time) : ''));
  const open = _openRow === a.id;
  const detailHtml = open ? rowDetailHtml(a, _detailCtxFor(a)) : '';
  return rowHtml(a, {
    hideMachine: d.eff.machines.size === 1, open, material, tag: tagOf(a, t), t, orderNo: _orderNoOf(a),
    groupLabel: t(`ape.cat_${categoryOf(a.type)}`), dueText: anchor ? _fmtDay(anchor) : '', overdue: !!anchor && offset < 0,
    whatIf: Sandbox.active === true, detailHtml,
  });
}

/** "Move N" and "Show on Gantt" (and "Acknowledge N…" in the Inbox) for the alerts in view. */
/** The order ids of every alert in view (a tool conflict names all its holders). */
function _viewOrderIds(alerts: ReadonlyArray<NimbusAlert>): string[] {
  const ids = new Set<string>();
  for (const a of alerts) for (const oid of alertOrderIds(a)) ids.add(oid);
  return [...ids];
}

function _viewButtons(d: Derived, withAck: boolean): string {
  const counts = groupCounts(d.filtered, _isAcked);
  // Several orders, or queued ones with no bar, are shown in the Orders table first; a lone placed order opens on the Gantt.
  const toOrders = fixPrimaryAction({ orderIds: _viewOrderIds(d.filtered), alertIds: d.filtered.map(a => a.id) }, _alertsById()) === 'orders';
  const n = counts.movableOrders;
  const lock = Sandbox.active === true ? ` disabled aria-disabled="true" title="${esc(t('am.whatif_blocked'))}"` : (n === 0 ? ' disabled' : '');
  return `<button type="button" class="btn sm" data-am-action="move-view"${lock}>${esc(t(n === 1 ? 'am.group_fix_n_one' : 'am.group_fix_n', { n }))}</button>`
    + (toOrders ? `<button type="button" class="btn sm btn-primary" data-am-action="open-orders">${esc(t('am.open_in_orders'))}</button>` : '')
    + `<button type="button" class="btn sm btn-ghost" data-am-action="show-gantt"${d.filtered.length ? '' : ' disabled'}>${esc(t('am.show_on_gantt'))}</button>`
    + (withAck && counts.unackedIds.length
      ? `<button type="button" class="btn sm btn-ghost" data-am-action="ack-view">${esc(t('am.group_ack_n', { n: counts.unackedIds.length }))}</button>` : '');
}

/** The Matrix shell: the table, the side list's resize handle (hidden with the list) and the list. */
function _matrixShellHtml(): string {
  const label = esc(t('am.side_resize'));
  return '<div class="am-mx-layout"><div class="am-mx-main" id="am-mx"></div>'
    + `<div class="am-side-rh" id="am-side-rh" role="separator" aria-orientation="vertical" tabindex="0" aria-label="${label}" title="${label}"`
    + ` aria-valuemin="${SIDE_W_MIN}" aria-valuemax="${SIDE_W_MAX}" aria-valuenow="${SIDE_W_DEFAULT}" hidden></div>`
    + '<aside class="am-side panel" id="am-side" hidden></aside></div>';
}

/** The side list width to show: the user's stored width, clamped to the room the page has. */
function _sideWidth(): number {
  return clampSideWidth(Store.pref('alertMonitorSideWidth'), _el('am-body')?.clientWidth);
}

/** Write the width as `--am-side-w` on `#am-body` (the grid inherits it) and mirror it to the handle's aria-valuenow. */
function _applySideWidth(w: number = _sideWidth()): void {
  _el('am-body')?.style?.setProperty?.('--am-side-w', `${w}px`);
  _el('am-side-rh')?.setAttribute?.('aria-valuenow', String(w));
}

/** Pointer drag, keyboard and double-click on the side list's handle. The handle is recreated with each shell rebuild, so nothing leaks. */
function _wireSideResize(): void {
  const h = _el('am-side-rh');
  if (!h) return;
  const layout = (): HTMLElement | null => (_el('am-body')?.querySelector?.('.am-mx-layout') as HTMLElement | null) ?? null;
  const layoutW = (): number | undefined => _el('am-body')?.clientWidth;
  let dragging = false;
  let startX = 0;
  let startW = 0;
  let curW = 0;
  const finish = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    const moved = curW !== startW;
    layout()?.classList?.remove('am-resizing');
    document.body?.classList?.remove('am-side-resizing');
    try { h.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    if (moved) Session.setPref('alertMonitorSideWidth', curW);
  };
  h.addEventListener('pointerdown', (e: PointerEvent) => {
    e.preventDefault();
    try { h.setPointerCapture?.(e.pointerId); } catch { /* unsupported */ }
    dragging = true;
    startX = e.clientX;
    startW = _sideWidth();
    curW = startW;
    layout()?.classList?.add('am-resizing');
    document.body?.classList?.add('am-side-resizing');
  });
  h.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    curW = clampSideWidth(startW + (startX - e.clientX), layoutW());
    _applySideWidth(curW);
  });
  h.addEventListener('pointerup', finish);
  h.addEventListener('pointercancel', finish);
  h.addEventListener('keydown', (e: KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16;
    let w: number;
    if (e.key === 'ArrowLeft') w = _sideWidth() + step;
    else if (e.key === 'ArrowRight') w = _sideWidth() - step;
    else if (e.key === 'Home') w = SIDE_W_MIN;
    else if (e.key === 'End') w = SIDE_W_MAX;
    else return;
    e.preventDefault();
    w = clampSideWidth(w, layoutW());
    _applySideWidth(w);
    Session.setPref('alertMonitorSideWidth', w);
  });
  h.addEventListener('dblclick', () => {
    Session.setPref('alertMonitorSideWidth', null);
    _applySideWidth(SIDE_W_DEFAULT);
  });
}
const INBOX_SHELL = '<div class="am-ib"><aside class="am-ib-facets" id="am-ib-facets"></aside><section class="am-ib-main">'
  + '<div class="am-ib-bar" id="am-ib-bar"></div><div class="am-ib-scroll" id="am-ib-vl" role="list"></div></section></div>';

function _renderMatrix(s: PaintState, d: Derived): void {
  if (_setHtml('am-body', _matrixShellHtml())) { _teardownVl(); _lastHtml.delete('am-mx'); _lastHtml.delete('am-side'); _wireSideResize(); }
  const lens = s.view.lens;
  const cats = s.m.profileId === ALL_ALERTS_PROFILE_ID ? undefined
    : (() => { const ec = effectiveCategories(s.m.profile); return ALERT_CATEGORY_ORDER.filter(c => ec[c]?.on === true); })();
  const model = matrixModel(s.listed, lens, {
    ...d.ctx,
    pinned: new Set((Store.pref('pinnedLines') as string[] | undefined) ?? []),
    categoryOrder: cats,
    collapsed: new Set([..._collapsed].filter(k => k.startsWith('machine|')).map(k => k.slice(8))),
    quietOpen: _quietOpen,
    labels: {
      day: _dayLabel, category: c => t(`ape.cat_${c}`), ungrouped: t('am.ungrouped'), noMachine: t('am.group_unassigned'),
      machinesCount: n => t(n === 1 ? 'am.mx_machines_one' : 'am.mx_machines', { n }),
    },
  });
  _setHtml('am-mx', matrixHtml(model, d.eff, t));
  _measureMatrixHead();
  _renderSide(s, d);
  _applySideWidth();
}

/**
 * The roll-up rows pin under the sticky header: write the header row's measured height on the scroll box as `--am-mx-head-h`
 * (the Labor grid does the same for its group rows). Skipped while the tab is hidden (a zero height would pin them at 0).
 */
function _measureMatrixHead(): void {
  const host = _el('am-mx');
  const h = (host?.querySelector?.('thead tr') as HTMLElement | null)?.offsetHeight ?? 0;
  const box = host?.querySelector?.('.am-mx-scroll') as HTMLElement | null;
  if (h > 0 && box) box.style.setProperty('--am-mx-head-h', `${h}px`);
}

/** The matrix side list: hidden until any filter is set; the first 80 alerts in view, then a way into the Inbox. */
function _renderSide(s: PaintState, d: Derived): void {
  const el = _el('am-side');
  if (!el) return;
  const rh = _el('am-side-rh');
  if (!d.active) { _setHtml('am-side', ''); el.hidden = true; if (rh) rh.hidden = true; return; }
  const n = d.filtered.length;
  const sorted = [...d.filtered].sort(compareAlerts('impact', _groupCtx(s)));
  const rows = sorted.slice(0, SIDE_CAP).map(a => _rowHtmlFor(a, s, d)).join('');
  _setHtml('am-side', `<header class="am-side-head"><h3>${esc(t('am.in_view', { n }))}</h3><div class="am-side-acts">${_viewButtons(d, false)}</div></header>`
    + (n ? `<div class="am-side-rows" role="list">${rows}</div>` : `<div class="empty-state">${esc(t('am.filter_none'))}</div>`)
    + (n > SIDE_CAP ? `<button type="button" class="btn sm btn-ghost am-side-more" data-am-action="open-inbox">${esc(t('am.open_in_inbox', { n }))}</button>` : ''));
  el.hidden = false;
  if (rh) rh.hidden = false;
}

const _groupCtx = (s: PaintState): GroupContext => ({
  tasksById: Store.tasks, horizonStart: s.horizonStart, horizonMinutes: s.horizonMinutes, plantToday: s.plantToday,
});

/** One facet item: label, count, severity bar (errors share of the count). */
function _facetItem(dim: FilterDim, key: string, label: string, count: number, err: number, max: number, on: boolean, dot?: string): string {
  const w = max > 0 ? Math.round((100 * count) / max) : 0;
  const ew = count > 0 ? Math.round((w * err) / count) : 0;
  return `<button type="button" class="am-facet-item" data-am-facet="${dim}:${esc(key)}" aria-pressed="${on}"${count === 0 && !on ? ' disabled' : ''}>`
    + (dot ? `<span class="am-gdot" style="--c:${dot}"></span>` : '')
    + `<span class="am-facet-lbl">${esc(label)}</span><span class="am-facet-n">${count}</span>`
    + `<i class="am-facet-bar" style="--w:${w}%;--ew:${ew}%"></i></button>`;
}

/** Counts for one facet over the profile's alerts, narrowed by every OTHER dimension of the filter (so choosing a day does not zero its siblings). */
function _facetCounts<K extends string>(s: PaintState, d: Derived, drop: FilterDim[], keyOf: (a: NimbusAlert) => K): Map<K, { n: number; err: number }> {
  const f = { ...d.eff } as unknown as Record<string, unknown>;
  for (const dim of drop) f[dim] = dim === 'q' ? '' : new Set();
  const base = filterAlerts(s.listed, f as unknown as MonitorFilter, d.ctx);
  const out = new Map<K, { n: number; err: number }>();
  for (const a of base) {
    const k = keyOf(a);
    const c = out.get(k) ?? { n: 0, err: 0 };
    c.n++; if (a.sev === 'err') c.err++;
    out.set(k, c);
  }
  return out;
}

function _facetsHtml(s: PaintState, d: Derived): string {
  const f = d.eff;
  const wcOf = (a: NimbusAlert): string => d.wcByLine.get(a.line || '') ?? UNGROUPED_KEY;
  const wc = _facetCounts(s, d, ['wcGroups', 'machines'], wcOf);
  const wcKeys = [...new Set([...wc.keys(), ...f.wcGroups])].sort((a, b) =>
    (wc.get(b)?.n ?? 0) - (wc.get(a)?.n ?? 0) || (a === UNGROUPED_KEY ? 1 : 0) - (b === UNGROUPED_KEY ? 1 : 0) || (a < b ? -1 : 1));
  const wcMax = Math.max(0, ...[...wc.values()].map(c => c.n));
  let where = wcKeys.map(k => _facetItem('wcGroups', k, k === UNGROUPED_KEY ? t('am.ungrouped') : k, wc.get(k)?.n ?? 0, wc.get(k)?.err ?? 0, wcMax, f.wcGroups.has(k))).join('');
  if (f.wcGroups.size === 1) {
    const g = [...f.wcGroups][0]!;
    const mc = _facetCounts(s, d, ['machines'], a => a.line || 'none');
    let keys = [...mc.keys()].filter(k => (d.wcByLine.get(k) ?? UNGROUPED_KEY) === g);
    keys = [...new Set([...keys, ...f.machines])].sort((a, b) => (mc.get(b)?.n ?? 0) - (mc.get(a)?.n ?? 0) || (a < b ? -1 : 1));
    const q = _facetQ.trim().toLowerCase();
    const shown = q ? keys.filter(k => k.toLowerCase().includes(q)) : keys;
    const mMax = Math.max(0, ...keys.map(k => mc.get(k)?.n ?? 0));
    where += `<div class="am-facet-sub">`
      + (keys.length > FACET_SEARCH_ABOVE
        ? `<input type="search" class="input am-facet-q" id="am-facet-q" data-am-facet-q autocomplete="off" value="${esc(_facetQ)}" placeholder="${esc(t('am.search_ph'))}" aria-label="${esc(t('am.search_ph'))}">` : '')
      + shown.map(k => _facetItem('machines', k, k === 'none' ? t('am.group_unassigned') : k, mc.get(k)?.n ?? 0, mc.get(k)?.err ?? 0, mMax, f.machines.has(k))).join('')
      + `</div>`;
  }
  const dayKeys = ['overdue', ...horizonDayKeys(s.plantToday, d.ctx.horizonDays), 'later', 'none'];
  const day = _facetCounts(s, d, ['days'], a => d.bucketOf(a));
  const dMax = Math.max(0, ...[...day.values()].map(c => c.n));
  const when = dayKeys.filter(k => (day.get(k)?.n ?? 0) > 0 || f.days.has(k))
    .map(k => _facetItem('days', k, _dayLabel(k), day.get(k)?.n ?? 0, day.get(k)?.err ?? 0, dMax, f.days.has(k))).join('');
  const cat = _facetCounts(s, d, ['categories'], a => categoryOf(a.type));
  const cMax = Math.max(0, ...[...cat.values()].map(c => c.n));
  const what = ALERT_CATEGORY_ORDER.filter(c => (cat.get(c)?.n ?? 0) > 0 || f.categories.has(c))
    .map(c => _facetItem('categories', c, t(`ape.cat_${c}`), cat.get(c)?.n ?? 0, cat.get(c)?.err ?? 0, cMax, f.categories.has(c), `var(--bar-pm-${c})`)).join('');
  const panel = (key: string, body: string): string => `<section class="am-facet panel"><h3 class="am-facet-h">${esc(t(key))}</h3>${body || `<div class="am-facet-empty">—</div>`}</section>`;
  return panel('am.facet_where', where) + panel('am.facet_when', when) + panel('am.facet_what', what);
}

/** 32 px (52 when narrow), plus the detail block under the one open row, sized for the lines it renders: an open row never overlaps the next. */
const _inboxRowH = (a: NimbusAlert): number => {
  // The list container's width picks the layout (the CSS @container query at NARROW_AT); an unmeasured list (tests, hidden tab) is wide.
  const w = _vlEl?.clientWidth ?? 0;
  const narrow = w > 0 && w <= NARROW_AT;
  return (narrow ? ROW_H_NARROW : ROW_H) + (_openRow === a.id ? detailHeightFor(_detailCtxFor(a), narrow) : 0);
};

function _renderInbox(s: PaintState, d: Derived): void {
  if (_setHtml('am-body', INBOX_SHELL)) { _teardownVl(); _lastHtml.delete('am-ib-facets'); _lastHtml.delete('am-ib-bar'); }
  const held = (globalThis.document?.activeElement ?? null) as HTMLElement | null;
  const heldFacetQ = held?.id === 'am-facet-q';
  _setHtml('am-ib-facets', _facetsHtml(s, d));
  if (heldFacetQ) {
    const next = _el<HTMLInputElement>('am-facet-q');
    next?.focus?.({ preventScroll: true });
  }
  const sortBtn = (id: 'impact' | 'time', key: string): string =>
    `<button type="button" class="seg-btn${_sort === id ? ' active' : ''}" data-am-sort="${id}" aria-pressed="${_sort === id}">${esc(t(key))}</button>`;
  _setHtml('am-ib-bar', `<span class="am-ib-count">${esc(t('am.in_view', { n: d.filtered.length }))}</span>`
    + `<div class="am-seg" role="group" aria-label="${esc(t('am.sort_by'))}">${sortBtn('impact', 'am.sort_impact')}${sortBtn('time', 'am.sort_time')}</div>`
    + `<span class="spacer"></span>${_viewButtons(d, true)}`);
  const mount = _el('am-ib-vl');
  if (!mount) return;
  const sorted = d.filtered.length > 1 ? [...d.filtered].sort(compareAlerts(_sort, _groupCtx(s))) : d.filtered;
  if (!sorted.length) {
    _teardownVl();
    _setHtml('am-ib-vl', `<div class="empty-state">${esc(t('am.filter_none'))}</div>`);
    return;
  }
  if (_lastHtml.get('am-ib-vl')) { _lastHtml.delete('am-ib-vl'); _teardownVl(); mount.innerHTML = ''; }
  if (!_vl || _vlEl !== mount) {
    _teardownVl();
    _vlEl = mount;
    _vl = new VirtualList<NimbusAlert>(mount, {
      getRowH: _inboxRowH,
      renderFn: a => _rowHtmlFor(a, _s!, _d!),
      mountEl: mount,
    });
  }
  if (_openRow && !d.viewIds.has(_openRow)) _openRow = null;   // the open row left the view
  _vl.update(sorted);
  if (_scrollInboxTop) { _vl.scrollToTop(); _scrollInboxTop = false; }
}

function _renderBody(s: PaintState, d: Derived | null): void {
  if (s.empty !== null || !s.plant || !d) {
    _teardownVl();
    _setHtml('am-body', _emptyHtml(s));
    return;
  }
  if (s.view.view === 'inbox') _renderInbox(s, d); else _renderMatrix(s, d);
}

function _paint(): void {
  if (!_active) return;
  _ensureShell();
  if ((Store.selectedPlant ?? null) !== _lastPlant) { _lastPlant = Store.selectedPlant ?? null; AlertMonitorPane.resetView(); }
  // A profile change keeps the filter: the same machines / days stay narrowed under the new rules.
  const s = _gatherState();
  _s = s;
  _syncHeader(s);
  _renderGanttChip();
  // The producer follows plant:selected itself; until it has caught up, leave the body alone.
  if (!(s.plant && s.m.plant !== s.plant)) {
    const d = s.plant && s.empty === null ? _derive(s) : null;
    _d = d;
    _setHtml('am-summary', _summaryHtml(s));
    _renderChips(s);
    _setHtml('am-banner', _bannerHtml(s));
    _setHtml('am-prompt', _promptHtml(s));
    _renderLeverage(s, d);
    _renderBody(s, d);
  } else {
    _setHtml('am-summary', _summaryHtml(s));
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
    // The Inbox list is as tall as the facet column and its layout follows its own width: re-measure after a window resize.
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', Util.debounce(() => { if (_active && _vl) _paint(); if (_active) _applySideWidth(); }, 150));
    }
    Store.subscribe((evt: StoreEvent) => {
      if (!_active) return;
      switch (evt.type) {
        case 'alerts:change': _debouncedPaint(); _levPlanMoved(); break;
        case 'plant:selected':
        case 'settings:change': _paint(); break;
        case 'sandbox:entered':
        case 'sandbox:exited':
        case 'sandbox:reverted': _paint(); break;   // row actions flip disabled with What-If (Task 12)
        default:
          // Anything the leverage replay is computed from: orders, the setup snapshot, calendars and blackouts.
          if (evt.type.startsWith('tasks:bulk') || evt.type === 'setup-snapshot:replace' || evt.type === 'calendar:change'
            || evt.type === 'blocks:change' || evt.type === 'plantBlocks:change') _levPlanMoved();
          break;
      }
    }, 'alert-monitor-pane');
    AlertProfileMatches.subscribe(() => { if (_active) _paint(); });
    AlertProfileClient.subscribe(() => { if (_active) _paint(); });
    globalThis.window?.addEventListener?.('resize', () => { if (_active) _measureMatrixHead(); });
  },
  /** Called by the shell on every entry to the tab. */
  render(): void {
    _active = true;
    _levStale = true;   // events were ignored while the tab was hidden: refresh the leverage cards once
    _paint();
  },
  /** Forget the filter, the open row, folds and the fixes state (plant change). Does not paint. */
  resetView(): void {
    _filter = emptyFilter(); _facetQ = ''; _openRow = null; _sort = 'impact';
    _collapsed.clear(); _quietOpen.clear();
    _levReset(null);
  },
  /** The engine / input seams of the leverage panel; tests replace members, production never does. */
  _levDeps,
  /** The Inbox's per-row height (32, or 32 + the detail block for the open row); a test seam. */
  _rowH: _inboxRowH,
  setActive(active: boolean): void { _active = active; if (!active) _levAbortAll(); },
  isActive(): boolean { return _active; },
};
