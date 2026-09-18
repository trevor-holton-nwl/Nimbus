// distribution/distribution-pane.mjs — Scheduling Board › Order Distribution
// tab (P2-15). New frontend domain — see aggregate_to_detail.md §6 for the
// full design and `frontend/distribution/CLAUDE.md` for the domain summary.
//
// SCOPE (P2-15): the pane shell, shell/nav registration, the paged list with
// filters, and the detail panel's STATIC header display. Explicitly OUT of
// scope, left as documented stubs for a later task (P2-16):
//   - The shares editor body (`#dist-shares-editor-placeholder` below).
//   - Dry-run preview, Save/Reviewed*/Reset/Undo actions on the editor.
//     (*The list's own "Mark reviewed" / "re-stamp reviewed_quantity" one-
//     click actions on `needs_review`/`qty_changed` badges ARE wired here —
//     they're simple single-call actions, not the editor.)
//   - The reconcile banner (`Engine.reconcileRuntimeSchedules` follow-up).
//   - The What-If (Sandbox.active) guard on write actions.
//   - Deep-link routing (`#gantt/distribution?parent=&material=`,
//     `?bucket=`, `?batch=`) — not part of this task's enumerated scope;
//     `_batch` state exists and is filter-plumbed so a later task can drive
//     it from a parsed hash without touching this file's fetch/render path.
//
// Structural shape mirrors frontend/setup/setup-admin.mts /
// frontend/labor/labor-planning.mts: a plain object literal
// (`DistributionPane`) with `init()` (wire DOM listeners + Store
// subscriptions once) and `render()` (fetch + redraw), built over small pure
// functions kept outside the closure so they're independently testable
// (tests/modules/distribution/distribution-pane.test.mjs) without any DOM.
//
// Cross-domain reach: this module is imported directly by
// frontend/shell/application-shell.mts (the same way that file already
// imports Table/Timeline/WorkCenters — see its own header comment), NOT via
// the ambient `NIMBUS` global — a real static import is safe here because
// shell imports downward into every domain pane already; nothing in this
// domain imports shell back. The one place this module DOES reach upward
// into shell chrome (the "Open Work Centers" empty-state button) goes
// through the ambient `NIMBUS` global instead (`NIMBUS.App?.goto`/
// `.gotoMasterSub`), the established idiom for a leaf pane reaching into
// shell navigation without adding a real import cycle (see
// frontend/master-data/material-grids.mts's identical `NIMBUS.EmptyState`
// pattern) — `frontend/types/nimbus-global.d.mts` was extended with
// `App.gotoMasterSub` and `EmptyState.render`'s `action` param for this.
//
// KEY BACKEND-SHAPE NOTE (verified against backend/distribution/routes.py +
// data.py, not assumed from aggregate_to_detail.md's draft prose): the
// design doc's §6 says the machine→work-center map comes from
// "Store.masterData.workcenters"/NimbusMasterLine gaining sap_workcenter —
// that is NOT what shipped. Only `NimbusLineSetting` (Store.lineSettings)
// gained `sapWorkcenter`/`distributionWeight`, and there is no
// `Store.masterData.workcenters` cache anywhere in the app; the one existing
// consumer (`WorkCenters` in master-data/admin-ui.mts) keeps its own
// module-local `_rows` fetched straight from `GET /master-data/sap_workcenter`.
// This module follows that SAME real pattern (its own local `_workcenters`
// cache, re-fetched per plant) rather than a Store field that doesn't exist.
/* global NIMBUS */
// NIMBUS is app.js's classic-script IIFE global — a bare reference resolves
// correctly from a real ES module sharing the page realm, the same idiom
// documented in frontend/shell/application-shell.mts's own `/* global
// NIMBUS */` note. Used here only for the empty-state "Open Work Centers"
// button's cross-tab navigation (App.goto/gotoMasterSub) — see the module
// header comment for why that one reach goes through the ambient global
// rather than a real import of shell.
import { Config, Util, ErrorLog, Toast } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import { Session } from '../security/session.mjs';
import { loadDistributionSummary } from '../insights/services.mjs';

/* ============================================================================
   WIRE TYPES — hand-typed from backend/distribution/routes.py + data.py
   (read in full for this task; NOT guessed from the design doc). Same
   "hand-written row shape" convention as master-data/admin-ui.mts's
   WorkCenterRow/ProductionLineRow.
   ========================================================================== */

/** `order_distribution_share` row as returned inline on every list/detail
 *  response (`data._attach_shares`/`get_header_detail`'s enrichment). */
interface DistShare {
  machine: string;
  letter: string | null;
  weight: number | null;
  child_id: string | null;
  purged_at?: string | null;
  // get_header_detail only:
  quantity?: number | null;
  hours?: number | null;
  start?: string | null;
  purged?: boolean;
  stale?: boolean;
  below_min_lot?: boolean;
}

/** `order_distribution` header wire shape (`data._header_wire_shape`) —
 *  every `_row_to_header` column except the internal working keys
 *  (shares/children/workcenter/machines/statuses), which the list/detail
 *  routes surface as siblings instead. */
interface DistHeader {
  plant: string;
  production_order: string;
  material_number: string;
  sap_workcenter: string | null;
  order_quantity: number | null;
  run_time: number | null;
  basic_start_date: string | null;
  basic_finish_date: string | null;
  firming_indicator?: unknown;
  sap_facts: Record<string, unknown> | null;
  source: 'default' | 'manual' | string;
  default_basis: string;
  reviewed: boolean;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reviewed_quantity: number | null;
  updated_by: string | null;
  last_batch_id: string | null;
  updated_at: string | null;
  base_version: number;
}

interface DistChildrenSummary {
  count: number;
  total_quantity: number;
  earliest_start: string | null;
}

/** One row of `GET /distribution/{plant}`'s `data[]` (`list_headers_for_plant`). */
interface DistListRow {
  header: DistHeader;
  shares: DistShare[];
  statuses: string[];
  children_summary: DistChildrenSummary;
}

interface DistListResponse {
  data: DistListRow[];
  meta: { total: number; scheduled_children: number };
}

/** `GET /distribution/{plant}/{order}/{material}` (`get_header_detail`). */
interface DistDetailResponse {
  header: DistHeader;
  shares: DistShare[];
  statuses: string[];
  base_version: number;
}

/** `GET /master-data/sap_workcenter` row — only the fields this pane needs
 *  (full shape is master-data/admin-ui.mts's WorkCenterRow). */
interface WorkCenterOption {
  sap_workcenter: string;
  description?: string | null;
  distribution_mode: 'single' | 'distribute';
}

/* ============================================================================
   PURE LOGIC — no DOM, no Store, no network. Exported for
   tests/modules/distribution/distribution-pane.test.mjs.
   ========================================================================== */

/** §6's badge severity order, most severe first. `separation_violated` is
 *  listed (it's a real status code and must sort correctly) even though the
 *  backend can never emit it yet (P3a, client-computed-only) and this pane
 *  never computes it itself in P2-15 — see the module header. */
export const STATUS_SEVERITY: readonly string[] = [
  'incomplete', 'runtime_mismatch', 'separation_violated',
  'wc_changed', 'membership_changed', 'mode_mismatch', 'qty_changed',
  'below_min_lot', 'zero_quantity_children',
  'needs_review',
  'purged',
];

/** Visual tier per status — drives the `.sap-pill` modifier class. */
export const STATUS_TIER: Readonly<Record<string, 'err' | 'warn' | 'info' | 'neutral'>> = {
  incomplete: 'err', runtime_mismatch: 'err', separation_violated: 'err',
  wc_changed: 'warn', membership_changed: 'warn', mode_mismatch: 'warn',
  qty_changed: 'warn', below_min_lot: 'warn', zero_quantity_children: 'warn',
  needs_review: 'info',
  purged: 'neutral',
};

export interface PrimaryBadge {
  /** null only when `statuses` is empty, or contains only codes this pane
   *  doesn't recognize (still surfaced via `extra`, never dropped silently). */
  code: string | null;
  tier: 'err' | 'warn' | 'info' | 'neutral';
  /** Every other status on the header, in no particular order — the row
   *  renders these as a `+{{n}}` tooltip per §6. */
  extra: string[];
}

/** One primary badge per row, chosen by §6's severity order; every other
 *  status the header carries is returned as `extra` for the `+{{n}}`
 *  tooltip. A status code this table doesn't know about is never dropped —
 *  it just can't win the primary slot, so it always ends up in `extra`. */
export function pickPrimaryBadge(statuses: readonly string[] | null | undefined): PrimaryBadge {
  const set = new Set(statuses || []);
  if (!set.size) return { code: null, tier: 'neutral', extra: [] };
  for (const code of STATUS_SEVERITY) {
    if (set.has(code)) {
      const extra = [...set].filter(c => c !== code);
      return { code, tier: STATUS_TIER[code] || 'neutral', extra };
    }
  }
  // Every member is an unrecognized code (future status not yet in
  // STATUS_SEVERITY) — surface the first one as primary rather than showing
  // nothing, and the rest as extra.
  const [first, ...rest] = [...set];
  return { code: first, tier: 'neutral', extra: rest };
}

/** Nav sub-button count badge text: `null` means "hide the badge" (zero),
 *  otherwise the count capped at "99+" — the alert-bell `#alert-badge`
 *  convention (index.html:1197 / aggregate_to_detail.md §6). */
export function formatBadgeCount(n: number | null | undefined): string | null {
  const v = Math.trunc(Number(n) || 0);
  if (v <= 0) return null;
  return v > 99 ? '99+' : String(v);
}

export type DistBucket = 'needs_review' | 'changed' | 'problems' | 'all';

export interface DistributionFilters {
  search: string;
  workcenter: string | null;
  bucket: DistBucket | string;
  /** ISO date (`Y-m-d`), or null to mean "use today"/"use the plant's
   *  visibility horizon end" — resolved at fetch time, never persisted as a
   *  frozen literal date (so "today" keeps meaning today across sessions). */
  from: string | null;
  to: string | null;
}

export const DEFAULT_DISTRIBUTION_FILTERS: Readonly<DistributionFilters> = Object.freeze({
  search: '', workcenter: null, bucket: 'needs_review', from: null, to: null,
});

/** Strip the `batch` chip out before persisting — §6: "the `batch` chip is
 *  never persisted." `machines` is deliberately not part of this shape at
 *  all: §6 calls it "an alias of Store.selectedLines", i.e. this pane reads
 *  the existing shared global line filter rather than owning a second copy
 *  of it. Accepts a superset object (e.g. one that still carries a `batch`
 *  key from in-memory pane state) and returns only the persisted subset. */
export function toPersistedFilters(filters: DistributionFilters): DistributionFilters {
  const { search, workcenter, bucket, from, to } = filters;
  return { search, workcenter, bucket, from, to };
}

/** Reconstruct a full filter state from whatever `Store.pref('distributionFilters')`
 *  returns (`null` before any save, or a persisted object potentially missing
 *  newer keys) — always merges over `DEFAULT_DISTRIBUTION_FILTERS` so a
 *  partial/stale blob never produces an undefined field. */
export function fromPersistedFilters(saved: unknown): DistributionFilters {
  const base = { ...DEFAULT_DISTRIBUTION_FILTERS };
  if (saved && typeof saved === 'object') {
    const s = saved as Partial<DistributionFilters>;
    if (typeof s.search === 'string') base.search = s.search;
    if (typeof s.workcenter === 'string' || s.workcenter === null) base.workcenter = s.workcenter ?? null;
    if (typeof s.bucket === 'string') base.bucket = s.bucket;
    if (typeof s.from === 'string' || s.from === null) base.from = s.from ?? null;
    if (typeof s.to === 'string' || s.to === null) base.to = s.to ?? null;
  }
  return base;
}

export type DistEmptyState = 'no_workcenters' | 'no_orders' | 'no_match' | null;

export interface EmptyStateContext {
  /** Does the plant have at least one `sap_workcenter` row with
   *  `distribution_mode === 'distribute'`? */
  hasDistributeWorkcenter: boolean;
  /** Total matching headers for the CURRENT filters (server `meta.total`). */
  total: number;
  /** True when any filter differs from the "wide open" defaults (used to
   *  distinguish "no orders at all" from "this filter matches nothing"). */
  filtersActive: boolean;
}

/** §6's three empty states, in priority order: a plant with no
 *  distribute-mode work center at all always wins (it's a setup problem, not
 *  a filter problem) before checking whether the filtered list is merely
 *  empty vs. genuinely has zero headers. */
export function selectEmptyState(ctx: EmptyStateContext): DistEmptyState {
  if (!ctx.hasDistributeWorkcenter) return 'no_workcenters';
  if (ctx.total > 0) return null;
  return ctx.filtersActive ? 'no_match' : 'no_orders';
}

/** True when any user-adjustable filter differs from a "wide open" read
 *  (default bucket 'needs_review' still counts as narrowed for this
 *  purpose — §6's empty-state copy is about "this filter matches nothing",
 *  and the default bucket is itself a filter). */
export function filtersAreActive(filters: DistributionFilters, batch: string | null): boolean {
  return !!(filters.search || filters.workcenter || filters.from || filters.to || batch)
    || filters.bucket !== 'all';
}

/** List column "sub-orders" cell (§6): `"3 · A B C"` for a distributed
 *  header, or the bare count (`"1"`) when there's a single, letterless
 *  bare-100% child (single-mode work centers assign no letters). Zero-weight
 *  / purged shares never count. */
export function formatSubOrders(shares: readonly DistShare[] | null | undefined): string {
  const living = (shares || []).filter(s => Number(s.weight) > 0 && !s.purged_at);
  const letters = living.map(s => s.letter).filter((l): l is string => !!l);
  if (letters.length > 1) return `${living.length} · ${letters.join(' ')}`;
  return String(living.length || 1);
}

export interface DefaultBasisText {
  key: string;
  vars: Record<string, string>;
}

/** The detail panel's "why these defaults" sentence (§6). Maps the header's
 *  real `default_basis` code (`material_default` | `tooled_single` |
 *  `workcenter_weights` — verified in backend/distribution/service.py's
 *  `compute_default_shares`, NOT the design doc's placeholder prose) to a
 *  translated sentence. `workcenter_weights` covers BOTH the "even split,
 *  no weights set" case and the "real weights" case server-side (same basis
 *  code); this function tells them apart the only way available from the
 *  wire data — whether the living shares' weights are all equal. `source
 *  === 'manual'` always wins (a re-weight overwrites the basis narrative). */
export function describeDefaultBasis(
  header: Pick<DistHeader, 'source' | 'default_basis' | 'material_number' | 'updated_by' | 'updated_at'>,
  shares: readonly DistShare[] | null | undefined,
): DefaultBasisText {
  const list = shares || [];
  if (header.source === 'manual') {
    return { key: 'ui.dist_basis_manual', vars: { who: header.updated_by || 'upload', when: Util.fmtDTReadable(header.updated_at) } };
  }
  const basis = header.default_basis;
  if (basis === 'material_default') {
    const winner = list.find(s => Number(s.weight) === 100) || list.find(s => Number(s.weight) > 0);
    return { key: 'ui.dist_basis_material_default', vars: { machine: winner?.machine || '', material: header.material_number || '' } };
  }
  if (basis === 'tooled_single') {
    return { key: 'ui.dist_basis_tooled_single', vars: {} };
  }
  if (basis === 'workcenter_weights') {
    const positive = list.filter(s => Number(s.weight) > 0);
    const allEqual = positive.length > 0 && positive.every(s => Number(s.weight) === Number(positive[0].weight));
    if (positive.length === 0 || allEqual) return { key: 'ui.dist_basis_even', vars: {} };
    const listStr = positive.map(s => `${s.machine} ${s.weight}%`).join(', ');
    return { key: 'ui.dist_basis_weights', vars: { list: listStr } };
  }
  return { key: 'ui.dist_basis_unknown', vars: {} };
}

/** Reviewed-checkbox tri-state (§6): unreviewed → unchecked, reviewed with a
 *  live quantity match → checked, reviewed but the quantity moved since
 *  (`qty_changed`) → indeterminate. */
export function reviewedCheckboxState(header: Pick<DistHeader, 'reviewed'>, statuses: readonly string[]): 'checked' | 'unchecked' | 'indeterminate' {
  if (statuses.includes('qty_changed')) return 'indeterminate';
  return header.reviewed ? 'checked' : 'unchecked';
}

function _rowKey(header: Pick<DistHeader, 'production_order' | 'material_number'>): string {
  return `${header.production_order}|${header.material_number}`;
}

/* ============================================================================
   DistributionPane — DOM/Store-facing shell around the pure logic above.
   ========================================================================== */

const PAGE_SIZE = 50;

export const DistributionPane = (() => {
  const API = Config.API_BASE;

  let _wired = false;
  let _active = false;
  let _plant: string | null = null;
  let _filters: DistributionFilters = { ...DEFAULT_DISTRIBUTION_FILTERS };
  let _batch: { id: string; label: string } | null = null;
  let _page = 0;
  let _rows: DistListRow[] = [];
  let _total = 0;
  let _loading = false;

  let _workcentersPlant: string | null = null;
  let _workcenters: WorkCenterOption[] = [];

  let _selectedKey: string | null = null;
  let _detail: DistDetailResponse | null = null;
  let _detailLoading = false;

  const _checkedKeys = new Set<string>(); // bulk-select column; inert (P2-16 wires bulk actions)

  function _todayIso(): string { return Util.dayKey(new Date()); }
  function _horizonEndIso(): string { return Store.visibilityHorizonEnd ? Util.dayKey(Store.visibilityHorizonEnd) : ''; }
  function _effectiveFrom(): string { return _filters.from || _todayIso(); }
  function _effectiveTo(): string { return _filters.to || _horizonEndIso(); }

  /* ---------------------------------------------------------------------
     Boot — wire the static shell + Store subscriptions exactly once.
     Rendering only actually fetches while `_active` (the sub-tab is the
     current Gantt sub-view) — every Store subscriber below checks that
     before doing any network work.
     ------------------------------------------------------------------- */
  function init(): void {
    if (_wired) return;
    _wired = true;
    _ensureShell();
    _renderCountBadge();

    Store.subscribe((evt) => {
      if (evt.type === 'distribution:summary') {
        _renderCountBadge();
        return;
      }
      if (evt.type === 'plant:selected') {
        _selectedKey = null; _detail = null; _batch = null;
        _workcentersPlant = null; // force a re-fetch for the new plant
        if (_active) render();
        return;
      }
      if (evt.type === 'lines:selected') {
        if (_active) { _page = 0; void _fetchAndRenderList(); }
        return;
      }
      if (evt.type.startsWith('task:') || evt.type.startsWith('tasks:')) {
        _debouncedRefresh();
      }
    }, 'distribution-pane');
  }

  const _debouncedRefresh = Util.debounce(() => {
    if (_active) void _fetchAndRenderList();
  }, 400);

  /** Called by App.gotoGanttSub when the Gantt sub switches TO 'distribution'.
   *  Idempotent — safe to call repeatedly (e.g. a stray re-render). */
  function render(): void {
    _active = true;
    _ensureShell();
    _plant = Store.selectedPlant;
    if (!_plant) { _renderList(); _renderDetail(); return; }
    _loadFilterState();
    void _loadWorkcentersIfNeeded(_plant).then(() => {
      _renderWorkcenterCombobox();
      _page = 0;
      void _fetchAndRenderList();
    });
  }

  /** Called by App.gotoGanttSub when leaving this sub-tab for another —
   *  stops the debounced Store-event refresh from doing background network
   *  work for a pane the user can no longer see. */
  function setActive(active: boolean): void { _active = active; }

  function _loadFilterState(): void {
    _filters = fromPersistedFilters(Store.pref('distributionFilters'));
  }

  function _persistFilterState(): void {
    Session.setPref('distributionFilters', toPersistedFilters(_filters));
  }

  async function _loadWorkcentersIfNeeded(plant: string): Promise<void> {
    if (_workcentersPlant === plant) return;
    try {
      const resp = await Util.fetchTraced(`${API}/master-data/sap_workcenter?${new URLSearchParams({ plant, limit: '500' }).toString()}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as { rows: WorkCenterOption[] };
      _workcenters = data.rows || [];
      _workcentersPlant = plant;
    } catch (e) {
      ErrorLog.error('distribution', `Failed to load work centers: ${(e as Error).message}`, { plant }, { errorCode: 'distribution.workcenters_load' });
      _workcenters = [];
      _workcentersPlant = plant;
    }
  }

  function _hasDistributeWorkcenter(): boolean {
    return _workcenters.some(w => w.distribution_mode === 'distribute');
  }

  async function _fetchAndRenderList(): Promise<void> {
    const plant = Store.selectedPlant;
    if (!plant) return;
    _loading = true;
    _renderList();
    try {
      const params = new URLSearchParams();
      if (_filters.search) params.set('search', _filters.search);
      if (_filters.workcenter) params.set('workcenter', _filters.workcenter);
      const machines = [...Store.selectedLines];
      if (machines.length) params.set('machines', machines.join(','));
      params.set('bucket', _filters.bucket);
      const from = _effectiveFrom(); if (from) params.set('from', from);
      const to = _effectiveTo(); if (to) params.set('to', to);
      if (_batch) params.set('batch', _batch.id);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(_page * PAGE_SIZE));
      const resp = await Util.fetchTraced(`${API}/distribution/${encodeURIComponent(plant)}?${params.toString()}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as DistListResponse;
      _rows = data.data || [];
      _total = data.meta?.total ?? _rows.length;
    } catch (e) {
      ErrorLog.error('distribution', `Failed to load distribution list: ${(e as Error).message}`, { plant }, { errorCode: 'distribution.list_load' });
      Toast.show(Util.t('toast.dist_load_failed'), 'error');
      _rows = []; _total = 0;
    }
    _loading = false;
    _renderList();
  }

  async function _openDetail(key: string): Promise<void> {
    _selectedKey = key;
    const row = _rows.find(r => _rowKey(r.header) === key);
    _renderList(); // reflect the new selection highlight without a full refetch
    if (!row) { _detail = null; _renderDetail(); return; }
    _detailLoading = true;
    _renderDetail();
    try {
      const plant = Store.selectedPlant;
      const resp = await Util.fetchTraced(`${API}/distribution/${encodeURIComponent(String(plant))}/${encodeURIComponent(row.header.production_order)}/${encodeURIComponent(row.header.material_number)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      _detail = await resp.json() as DistDetailResponse;
    } catch (e) {
      ErrorLog.error('distribution', `Failed to load distribution detail: ${(e as Error).message}`, {}, { errorCode: 'distribution.detail_load' });
      Toast.show(Util.t('toast.dist_detail_load_failed'), 'error');
      _detail = null;
    }
    _detailLoading = false;
    _renderDetail();
  }

  /** Wired for `needs_review` (checkbox → review true) and the indeterminate
   *  `qty_changed` re-stamp (same call — the backend sets `reviewed_quantity`
   *  from the header's current `order_quantity` on every `review` call). Every
   *  OTHER status's one-click action (`incomplete`→Repair, `mode_mismatch`→
   *  Reset, `wc_changed`→Adjust/Reset/Review, `membership_changed`→Adjust/
   *  Reset, `below_min_lot`/`zero_quantity_children`→Adjust,
   *  `separation_violated`→Show on Gantt, `runtime_mismatch`→Save schedule)
   *  is INERT in P2-15 — those all open the shares editor or act on live
   *  schedule state, which is P2-16's job (see module header). */
  async function _markReviewed(header: DistHeader): Promise<void> {
    const plant = Store.selectedPlant;
    if (!plant) return;
    try {
      const resp = await Util.fetchTraced(`${API}/distribution/${encodeURIComponent(plant)}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orders: [{ production_order: header.production_order, material_number: header.material_number, base_version: header.base_version }],
          reviewed: true,
        }),
      });
      if (!resp.ok) {
        const err = await Util.parseBackendError(resp);
        Toast.show(err.message || Util.t('toast.dist_review_failed'), 'error');
        return;
      }
      Toast.show(Util.t('toast.dist_reviewed'), 'success');
      await _fetchAndRenderList();
      if (_selectedKey === _rowKey(header)) void _openDetail(_selectedKey);
      void loadDistributionSummary();
    } catch (e) {
      ErrorLog.error('distribution', `Review call failed: ${(e as Error).message}`, {}, { errorCode: 'distribution.review_failed' });
      Toast.show(Util.t('toast.dist_review_failed'), 'error');
    }
  }

  /* ---------------------------------------------------------------------
     Rendering
     ------------------------------------------------------------------- */

  function _pane(): HTMLElement | null { return document.getElementById('gantt-sub-distribution'); }

  // Static shell HTML is built exactly once (guarded above) — well after
  // App.init()'s one-shot `[data-i18n]`/`[data-i18n-placeholder]` sweep has
  // already run, so relying on those attributes alone would leave this pane
  // permanently untranslated. Every label/placeholder below is set via an
  // inline `Util.t()` call instead (the `data-i18n*` attributes are kept
  // alongside, for documentation/tooling only — same belt-and-suspenders
  // convention `application-shell.mts`'s User Settings modal uses).
  function _ensureShell(): void {
    const pane = _pane();
    if (!pane || document.getElementById('dist-toolbar')) return;
    const t = Util.t;
    const e = Util.escapeHtml;
    pane.innerHTML = `
      <div class="dist-toolbar" id="dist-toolbar">
        <input id="dist-search" class="input" type="search" autocomplete="off"
               data-i18n-placeholder="ph.dist_search" placeholder="${e(t('ph.dist_search'))}">
        <div id="dist-wc-combobox" class="dist-wc-combobox"></div>
        <select id="dist-bucket-select" class="select" aria-label="${e(t('ui.dist_col_status'))}">
          <option value="needs_review" data-i18n="ui.dist_bucket_needs_review">${e(t('ui.dist_bucket_needs_review'))}</option>
          <option value="changed" data-i18n="ui.dist_bucket_changed">${e(t('ui.dist_bucket_changed'))}</option>
          <option value="problems" data-i18n="ui.dist_bucket_problems">${e(t('ui.dist_bucket_problems'))}</option>
          <option value="all" data-i18n="ui.dist_bucket_all">${e(t('ui.dist_bucket_all'))}</option>
        </select>
        <input id="dist-date-from" class="input dist-date-input" type="text" placeholder="${e(t('ui.dist_filter_from'))}">
        <input id="dist-date-to" class="input dist-date-input" type="text" placeholder="${e(t('ui.dist_filter_to'))}">
        <span class="dist-batch-chip" id="dist-batch-chip" hidden></span>
        <button type="button" class="btn btn-ghost sm" id="dist-clear-filters" data-i18n="btn.clear_filters" hidden>${e(t('btn.clear_filters'))}</button>
      </div>
      <div class="dist-body" id="dist-body">
        <div class="dist-list-pane" id="dist-list-pane">
          <div class="dist-list-scroll" id="dist-list-scroll" tabindex="0">
            <table class="dist-list-table" id="dist-list-table">
              <thead>
                <tr>
                  <th class="dist-col-check"></th>
                  <th data-i18n="ui.dist_col_order">${e(t('ui.dist_col_order'))}</th>
                  <th data-i18n="ui.dist_col_material">${e(t('ui.dist_col_material'))}</th>
                  <th data-i18n="ui.dist_col_workcenter">${e(t('ui.dist_col_workcenter'))}</th>
                  <th data-i18n="ui.dist_col_qty">${e(t('ui.dist_col_qty'))}</th>
                  <th data-i18n="ui.dist_col_start">${e(t('ui.dist_col_start'))}</th>
                  <th data-i18n="ui.dist_col_suborders">${e(t('ui.dist_col_suborders'))}</th>
                  <th data-i18n="ui.dist_col_status">${e(t('ui.dist_col_status'))}</th>
                  <th data-i18n="ui.dist_col_reviewed">${e(t('ui.dist_col_reviewed'))}</th>
                </tr>
              </thead>
              <tbody id="dist-list-tbody"></tbody>
            </table>
          </div>
          <div class="dist-list-footer" id="dist-list-footer"></div>
        </div>
        <div class="dist-detail-pane" id="dist-detail-pane"></div>
      </div>`;
    _wireShellEvents();
  }

  function _wireShellEvents(): void {
    const search = document.getElementById('dist-search') as HTMLInputElement | null;
    const debouncedSearch = Util.debounce(() => {
      _filters = { ..._filters, search: search?.value.trim() || '' };
      _persistFilterState();
      _page = 0;
      void _fetchAndRenderList();
    }, 300);
    search?.addEventListener('input', debouncedSearch);

    const bucketSel = document.getElementById('dist-bucket-select') as HTMLSelectElement | null;
    if (bucketSel) {
      bucketSel.value = _filters.bucket;
      bucketSel.addEventListener('change', () => {
        _filters = { ..._filters, bucket: bucketSel.value };
        _persistFilterState();
        _page = 0;
        void _fetchAndRenderList();
      });
    }

    _wireDatePicker('dist-date-from', (iso) => {
      _filters = { ..._filters, from: iso };
      _persistFilterState();
      _page = 0;
      void _fetchAndRenderList();
    });
    _wireDatePicker('dist-date-to', (iso) => {
      _filters = { ..._filters, to: iso };
      _persistFilterState();
      _page = 0;
      void _fetchAndRenderList();
    });

    document.getElementById('dist-clear-filters')?.addEventListener('click', () => {
      _filters = { ...DEFAULT_DISTRIBUTION_FILTERS };
      _batch = null;
      _persistFilterState();
      if (search) search.value = '';
      if (bucketSel) bucketSel.value = _filters.bucket;
      _setDatePickerValue('dist-date-from', null);
      _setDatePickerValue('dist-date-to', null);
      _renderWorkcenterCombobox();
      _page = 0;
      void _fetchAndRenderList();
    });

    document.getElementById('dist-batch-chip')?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.dist-batch-chip-x')) return;
      _batch = null;
      _page = 0;
      void _fetchAndRenderList();
    });

    const scroll = document.getElementById('dist-list-scroll');
    scroll?.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== 'ArrowDown' && ke.key !== 'ArrowUp') return;
      ke.preventDefault();
      if (!_rows.length) return;
      const idx = _rows.findIndex(r => _rowKey(r.header) === _selectedKey);
      const nextIdx = ke.key === 'ArrowDown'
        ? Math.min((idx < 0 ? -1 : idx) + 1, _rows.length - 1)
        : Math.max((idx < 0 ? _rows.length : idx) - 1, 0);
      void _openDetail(_rowKey(_rows[nextIdx].header));
    });

    document.getElementById('dist-list-tbody')?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const row = target.closest('tr[data-key]') as HTMLElement | null;
      if (!row) return;
      const key = row.dataset.key as string;

      const bulkBox = target.closest('.dist-bulk-check') as HTMLInputElement | null;
      if (bulkBox) {
        if (bulkBox.checked) _checkedKeys.add(key); else _checkedKeys.delete(key);
        return; // inert beyond local bookkeeping — P2-16 wires bulk actions
      }

      const reviewedBox = target.closest('.dist-reviewed-check') as HTMLInputElement | null;
      if (reviewedBox) {
        const found = _rows.find(r => _rowKey(r.header) === key);
        if (found) void _markReviewed(found.header);
        return;
      }

      const badge = target.closest('.dist-badge-action') as HTMLElement | null;
      if (badge) {
        const found = _rows.find(r => _rowKey(r.header) === key);
        if (found) {
          const { code } = pickPrimaryBadge(found.statuses);
          if (code === 'needs_review' || code === 'qty_changed') void _markReviewed(found.header);
          // Every other status's badge click is a documented no-op in P2-15
          // (see _markReviewed's doc comment) — P2-16 wires Repair/Reset/
          // Adjust shares/Show on Gantt/Save schedule per §6's action table.
        }
        return;
      }

      void _openDetail(key);
    });
  }

  /** Lazily-initialized module-level Flatpickr instance per input id, the
   *  established `_fp*` convention (frontend/shell/CLAUDE.md) — date-only
   *  row from that file's table (`dateFormat:"Y-m-d"`, `altInput`,
   *  `altFormat:"M j, Y"`). Falls back to a plain text input (no picker)
   *  when Flatpickr hasn't loaded, same guarded pattern `Util._fmtDatePref`
   *  uses. */
  const _fpInstances: Record<string, unknown> = {};
  function _wireDatePicker(id: string, onChange: (iso: string | null) => void): void {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    try {
      if (typeof flatpickr !== 'undefined') {
        _fpInstances[id] = flatpickr(el, {
          dateFormat: 'Y-m-d', altInput: true, altFormat: 'M j, Y',
          onChange: (selected: Date[]) => onChange(selected[0] ? Util.dayKey(selected[0]) : null),
        });
        return;
      }
    } catch { /* fall through to plain input */ }
    el.addEventListener('change', () => onChange(el.value.trim() || null));
  }
  function _setDatePickerValue(id: string, iso: string | null): void {
    const fp = _fpInstances[id] as { setDate?: (d: string | null, fire?: boolean) => void } | undefined;
    if (fp?.setDate) { fp.setDate(iso, false); return; }
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = iso || '';
  }

  /** Minimal self-contained searchable combobox for the work-center filter —
   *  duplicated (not imported) from frontend/setup/setup-admin.mts's own copy
   *  of the same helper, the established pattern for a small, self-contained
   *  UI helper two-plus domains need rather than adding a new shared-module
   *  edge for it (frontend/platform/CLAUDE.md's "deliberately duplicated"
   *  note — this domain is now a third copy). Required per the Production
   *  Scale Roadmap: never a bare `<select>`/chip row for a per-plant list
   *  that can grow past a handful of entries. Keep any future change to this
   *  helper mirrored in the setup-admin.mts / master-data/admin-ui.mts copies. */
  function _mkCombobox(containerEl: HTMLElement | null, options: string[], opts: { value?: string; placeholder?: string; onSelect?: (value: string) => void } = {}): void {
    if (!containerEl) return;
    const { value = '', placeholder = '', onSelect } = opts;
    containerEl.innerHTML = `
      <div class="hps-combobox md-bom-combobox">
        <input type="text" class="hps-input" placeholder="${Util.escapeHtml(placeholder)}" autocomplete="off" spellcheck="false"
               aria-haspopup="listbox" aria-expanded="false">
        <button type="button" class="hps-clear" hidden>&times;</button>
        <div class="hps-dropdown" role="listbox" hidden></div>
      </div>`;
    const root = containerEl.querySelector('.hps-combobox') as HTMLElement;
    const input = root.querySelector('.hps-input') as HTMLInputElement;
    const clearBtn = root.querySelector('.hps-clear') as HTMLButtonElement;
    const dropdown = root.querySelector('.hps-dropdown') as HTMLElement;
    let filtered: string[] = [];
    let activeIdx = -1;
    let open = false;
    let selected = value;

    function reflect(): void {
      input.value = selected || '';
      root.classList.toggle('has-value', !!selected);
      clearBtn.hidden = !selected;
    }
    function renderDropdown(query: string): void {
      const q = (query || '').trim().toLowerCase();
      const looksLikeLabel = selected && String(query).trim().toLowerCase() === String(selected).toLowerCase();
      const filterQ = looksLikeLabel ? '' : q;
      filtered = filterQ ? options.filter(o => String(o).toLowerCase().includes(filterQ)) : options.slice();
      if (!filtered.length) {
        dropdown.innerHTML = `<div class="hps-empty">${options.length ? Util.t('ui.no_matches') : Util.t('ui.no_options')}</div>`;
        activeIdx = -1;
        return;
      }
      dropdown.innerHTML = filtered.map((o, i) => `<div class="hps-option${o === selected ? ' selected' : ''}" role="option" data-idx="${i}">${Util.escapeHtml(o)}</div>`).join('');
      activeIdx = Math.max(0, filtered.indexOf(selected));
      highlight();
      dropdown.querySelectorAll('.hps-option').forEach((el, i) => {
        el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(filtered[i]); });
      });
    }
    function highlight(): void {
      const items = dropdown.querySelectorAll('.hps-option');
      items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
      if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: 'nearest' });
    }
    function openDd(): void { dropdown.hidden = false; open = true; input.setAttribute('aria-expanded', 'true'); }
    function closeDd(): void { dropdown.hidden = true; open = false; activeIdx = -1; input.setAttribute('aria-expanded', 'false'); }
    function pick(o: string): void {
      selected = o;
      reflect();
      closeDd();
      input.blur();
      if (onSelect) onSelect(o);
    }

    input.addEventListener('focus', () => { renderDropdown(input.value); openDd(); });
    input.addEventListener('input', () => { renderDropdown(input.value); openDd(); });
    input.addEventListener('keydown', (e) => {
      if (!open) {
        if (e.key === 'ArrowDown' || e.key === 'Enter') { renderDropdown(input.value); openDd(); e.preventDefault(); }
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, filtered.length - 1); highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); highlight(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (filtered[activeIdx]) pick(filtered[activeIdx]); }
      else if (e.key === 'Escape') { closeDd(); reflect(); input.blur(); }
    });
    input.addEventListener('blur', () => { setTimeout(() => { closeDd(); reflect(); }, 120); });
    clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
    clearBtn.addEventListener('click', () => { selected = ''; reflect(); if (onSelect) onSelect(''); input.focus(); });
    document.addEventListener('click', (e) => { if (!root.contains(e.target as Node)) closeDd(); });

    reflect();
  }

  function _renderWorkcenterCombobox(): void {
    const container = document.getElementById('dist-wc-combobox');
    if (!container) return;
    const codes = _workcenters.map(w => w.sap_workcenter).sort();
    _mkCombobox(container, codes, {
      value: _filters.workcenter || '',
      placeholder: Util.t('ui.dist_col_workcenter'),
      onSelect: (v) => {
        _filters = { ..._filters, workcenter: v || null };
        _persistFilterState();
        _page = 0;
        void _fetchAndRenderList();
      },
    });
  }

  function _renderCountBadge(): void {
    const btn = document.querySelector<HTMLElement>('.nav-sub-btn[data-gantt-sub="distribution"]');
    if (!btn) return;
    let badge = btn.querySelector<HTMLElement>('.nav-sub-badge');
    const count = formatBadgeCount(Store.distributionSummary?.needs_review);
    if (count === null) { badge?.remove(); return; }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-sub-badge';
      btn.appendChild(badge);
    }
    badge.textContent = count;
  }

  function _renderList(): void {
    const tbody = document.getElementById('dist-list-tbody');
    const footer = document.getElementById('dist-list-footer');
    const chip = document.getElementById('dist-batch-chip');
    if (chip) {
      if (_batch) {
        chip.hidden = false;
        chip.innerHTML = `${Util.escapeHtml(Util.t('ui.dist_batch_chip', { when: _batch.label }))} <span class="dist-batch-chip-x" role="button" aria-label="Remove">&times;</span>`;
      } else {
        chip.hidden = true;
        chip.innerHTML = '';
      }
    }
    const clearBtn = document.getElementById('dist-clear-filters') as HTMLButtonElement | null;
    const active = filtersAreActive(_filters, _batch?.id || null);
    if (clearBtn) clearBtn.hidden = !active;

    if (!tbody) return;

    if (!Store.selectedPlant) {
      tbody.innerHTML = '';
      _renderEmptyOverlay('select_plant');
      if (footer) footer.innerHTML = '';
      return;
    }

    const emptyState = selectEmptyState({ hasDistributeWorkcenter: _hasDistributeWorkcenter(), total: _total, filtersActive: active });
    if (!_loading && emptyState) {
      tbody.innerHTML = '';
      _renderEmptyOverlay(emptyState);
      if (footer) footer.innerHTML = '';
      return;
    }
    _clearEmptyOverlay();

    if (_loading && !_rows.length) {
      tbody.innerHTML = `<tr class="dist-loading-row"><td colspan="9">${Util.escapeHtml(Util.t('ui.loading'))}</td></tr>`;
      if (footer) footer.innerHTML = '';
      return;
    }

    tbody.innerHTML = _rows.map(row => _renderRow(row)).join('');
    // HTML has no declarative "indeterminate" attribute — it's a DOM-property-
    // only checkbox state, so it must be set imperatively after the markup
    // lands (data-indeterminate is just the carrier attribute _renderRow emits).
    tbody.querySelectorAll<HTMLInputElement>('.dist-reviewed-check[data-indeterminate="1"]').forEach(cb => { cb.indeterminate = true; });

    if (footer) {
      const shown = _rows.length;
      const hasMore = (_page + 1) * PAGE_SIZE < _total;
      footer.innerHTML = `
        <span class="dist-list-count">${Util.escapeHtml(Util.t('ui.dist_showing_count', { shown: String(shown), total: String(_total) }))}</span>
        ${hasMore ? `<button type="button" class="btn btn-ghost sm" id="dist-load-more">${Util.escapeHtml(Util.t('btn.load_more'))}</button>` : ''}`;
      document.getElementById('dist-load-more')?.addEventListener('click', () => {
        _page += 1;
        void _fetchMoreAndAppend();
      });
    }
  }

  async function _fetchMoreAndAppend(): Promise<void> {
    // Same query as _fetchAndRenderList but appends rather than replaces —
    // "Load more" paging convention (WorkCenters._loadAll in
    // master-data/admin-ui.mts is the precedent this mirrors).
    const plant = Store.selectedPlant;
    if (!plant) return;
    try {
      const params = new URLSearchParams();
      if (_filters.search) params.set('search', _filters.search);
      if (_filters.workcenter) params.set('workcenter', _filters.workcenter);
      const machines = [...Store.selectedLines];
      if (machines.length) params.set('machines', machines.join(','));
      params.set('bucket', _filters.bucket);
      const from = _effectiveFrom(); if (from) params.set('from', from);
      const to = _effectiveTo(); if (to) params.set('to', to);
      if (_batch) params.set('batch', _batch.id);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(_page * PAGE_SIZE));
      const resp = await Util.fetchTraced(`${API}/distribution/${encodeURIComponent(plant)}?${params.toString()}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as DistListResponse;
      _rows = _rows.concat(data.data || []);
      _total = data.meta?.total ?? _rows.length;
    } catch (e) {
      ErrorLog.error('distribution', `Failed to load more: ${(e as Error).message}`);
      Toast.show(Util.t('toast.dist_load_failed'), 'error');
    }
    _renderList();
  }

  function _renderRow(row: DistListRow): string {
    const key = _rowKey(row.header);
    const active = key === _selectedKey;
    const primary = pickPrimaryBadge(row.statuses);
    const revState = reviewedCheckboxState(row.header, row.statuses);
    const badgeText = primary.code ? Util.t(`ui.dist_status_${primary.code}`) : '';
    const extraBadge = primary.extra.length ? `<span class="sap-pill neutral dist-badge-extra" title="${Util.escapeHtml(primary.extra.join(', '))}">+${primary.extra.length}</span>` : '';
    return `
      <tr data-key="${Util.escapeHtml(key)}" class="dist-row${active ? ' active' : ''}">
        <td class="dist-col-check"><input type="checkbox" class="dist-bulk-check" ${_checkedKeys.has(key) ? 'checked' : ''}></td>
        <td title="${Util.escapeHtml(String(row.header.sap_facts?.order_category ?? ''))}">${Util.escapeHtml(row.header.production_order)}</td>
        <td>${Util.escapeHtml(row.header.material_number)}</td>
        <td>${Util.escapeHtml(row.header.sap_workcenter || '')}</td>
        <td>${row.header.order_quantity ?? ''}</td>
        <td>${Util.escapeHtml(Util.fmtDT(row.header.basic_start_date))}</td>
        <td>${Util.escapeHtml(formatSubOrders(row.shares))}</td>
        <td>
          ${primary.code ? `<span class="sap-pill ${primary.tier} dist-badge-action" title="${Util.escapeHtml(Util.t(`ui.dist_status_${primary.code}_tip`))}">${Util.escapeHtml(badgeText)}</span>` : ''}
          ${extraBadge}
        </td>
        <td><input type="checkbox" class="dist-reviewed-check"
              ${revState === 'checked' ? 'checked' : ''}
              data-indeterminate="${revState === 'indeterminate' ? '1' : '0'}"></td>
      </tr>`;
  }

  function _renderEmptyOverlay(kind: 'select_plant' | DistEmptyState): void {
    const pane = document.getElementById('dist-list-pane');
    if (!pane) return;
    let overlay = document.getElementById('dist-list-empty');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'dist-list-empty';
      overlay.className = 'dist-list-empty';
      pane.appendChild(overlay);
    }
    const nimbus = typeof NIMBUS !== 'undefined' ? NIMBUS : undefined;
    if (kind === 'select_plant') {
      nimbus?.EmptyState?.render?.(overlay, { title: Util.t('empty.select_plant_title'), msg: Util.t('empty.select_plant_msg') });
    } else if (kind === 'no_workcenters') {
      nimbus?.EmptyState?.render?.(overlay, {
        title: Util.t('empty.dist_no_workcenters_title'),
        msg: Util.t('empty.dist_no_workcenters_msg'),
        action: Session.isAdmin() ? {
          label: Util.t('btn.dist_open_workcenters'),
          onClick: () => { nimbus?.App?.goto?.('masterdata'); nimbus?.App?.gotoMasterSub?.('work-centers'); },
        } : undefined,
      });
    } else if (kind === 'no_match') {
      nimbus?.EmptyState?.render?.(overlay, {
        title: Util.t('empty.dist_no_match_title'),
        msg: Util.t('empty.dist_no_match_msg'),
        action: { label: Util.t('btn.clear_filters'), onClick: () => document.getElementById('dist-clear-filters')?.dispatchEvent(new Event('click')) },
      });
    } else {
      nimbus?.EmptyState?.render?.(overlay, { title: Util.t('empty.dist_no_orders_title'), msg: Util.t('empty.dist_no_orders_msg') });
    }
  }

  function _clearEmptyOverlay(): void {
    document.getElementById('dist-list-empty')?.remove();
  }

  function _renderDetail(): void {
    const el = document.getElementById('dist-detail-pane');
    if (!el) return;
    if (!_selectedKey) {
      el.innerHTML = `<div class="dist-detail-empty">${Util.escapeHtml(Util.t('ui.dist_detail_empty'))}</div>`;
      return;
    }
    if (_detailLoading || !_detail) {
      el.innerHTML = `<div class="dist-detail-empty">${Util.escapeHtml(Util.t('ui.loading'))}</div>`;
      return;
    }
    const h = _detail.header;
    const basis = describeDefaultBasis(h, _detail.shares);
    const sumHours = (_detail.shares || []).reduce((s, sh) => s + (Number(sh.hours) || 0), 0);
    const updatedBy = h.updated_by || Util.t('ui.dist_upload');
    el.innerHTML = `
      <div class="dist-detail-header">
        <div class="dist-detail-title">${Util.escapeHtml(h.production_order)}</div>
        <div class="dist-detail-sub">${Util.escapeHtml(h.material_number)}</div>
      </div>
      <dl class="dist-detail-facts">
        <dt>${Util.escapeHtml(Util.t('ui.dist_col_workcenter'))}</dt><dd>${Util.escapeHtml(h.sap_workcenter || '')}</dd>
        <dt>${Util.escapeHtml(Util.t('ui.dist_col_qty'))}</dt><dd>${h.order_quantity ?? ''}</dd>
        <dt>${Util.escapeHtml(Util.t('ui.dist_detail_window'))}</dt>
        <dd>${Util.escapeHtml(Util.fmtDT(h.basic_start_date))} → ${Util.escapeHtml(Util.fmtDT(h.basic_finish_date))}</dd>
        <dt>${Util.escapeHtml(Util.t('ui.dist_detail_hours'))}</dt>
        <dd>${Util.escapeHtml(Util.t('ui.dist_detail_hours_vs', { sum: sumHours.toFixed(1), parent: String(h.run_time ?? '') }))}</dd>
      </dl>
      <div class="dist-detail-basis">${Util.escapeHtml(Util.t(basis.key, basis.vars))}</div>
      <div class="dist-detail-meta">
        ${Util.escapeHtml(Util.t('ui.dist_detail_updated', { when: Util.fmtDTReadable(h.updated_at), who: updatedBy }))}
        ${h.reviewed ? `<br>${Util.escapeHtml(Util.t('ui.dist_detail_reviewed', { when: Util.fmtDTReadable(h.reviewed_at), who: h.reviewed_by || '' }))}` : ''}
      </div>
      <div id="dist-shares-editor-placeholder">${Util.escapeHtml(Util.t('ui.dist_shares_editor_placeholder'))}</div>`;
  }

  return { init, render, setActive };
})();
