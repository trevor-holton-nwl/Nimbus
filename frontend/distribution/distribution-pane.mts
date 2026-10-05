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
// gained `sapWorkcenter`/`distributionWeight`. `Store.masterData.workcenters`
// DOES exist now (D38, master-data/admin-ui.mts — the Alerts/optimizer-facing
// copy, each row carrying its own `plant`, so the cache is per-plant data
// even though `Store.masterData` itself is one flat array), but this module
// still keeps its own local `_workcenters` cache, fetched straight from
// `GET /master-data/sap_workcenter` per plant (`_loadWorkcentersIfNeeded`) --
// the same real pattern `WorkCenters` in master-data/admin-ui.mts uses for
// its own module-local `_rows` -- rather than reading the Store field.
/* global NIMBUS */
// NIMBUS is app.js's classic-script IIFE global — a bare reference resolves
// correctly from a real ES module sharing the page realm, the same idiom
// documented in frontend/shell/application-shell.mts's own `/* global
// NIMBUS */` note. Used here only for the empty-state "Open Work Centers"
// button's cross-tab navigation (App.goto/gotoMasterSub) — see the module
// header comment for why that one reach goes through the ambient global
// rather than a real import of shell.
import { Config, Util, ErrorLog, Toast, Modal } from '../platform/foundation.mjs';
import { Store, UndoStack } from '../platform/store.mjs';
import { Session } from '../security/session.mjs';
import { loadDistributionSummary } from '../insights/services.mjs';
// P2-16 additions. These are real cross-domain imports (distribution ->
// optimization / scheduling) rather than the ambient-NIMBUS-global idiom the
// rest of this file uses for reaching UPWARD into shell chrome — safe here
// because nothing in optimization/scheduling imports distribution back (grep-
// verified), so this is a plain one-directional edge, not a new cycle.
import { Sandbox } from '../optimization/sandbox.mjs';
import { Engine } from '../optimization/engine.mjs';
import { Persistence } from '../scheduling/persistence.mjs';
import type { NimbusTask } from '../platform/types.mjs';
import {
  onlyThisMachine, evenWeights, quantityToWeight, resolvedWeight, buildSharesPayload,
  dryRunSignature, mergeRowsWithDryRun, computeTotals, computeSaveButtonState, needsRemovalConfirm,
  sortRemovedFrozenFirst, isUndoDisabled, undoWeightMap, distErrorLocaleKey,
} from './shares-editor.mjs';
import type {
  WeightMap, DryRunResult, DryRunStatus, EditorRowBase, EditorRowView, RemovedScheduledEntry,
  WriteResult, WriteResultChild,
} from './shares-editor.mjs';

/** D31: drop Ctrl+Z entries that would restore older values of any sub-order a
 *  distribution write just rewrote server-side. */
export function invalidateUndoForWrite(ids: Iterable<string | number>): void {
  UndoStack.invalidate(ids);
}

/** Decode the authoritative child aggregate through the same segment/date
 *  decoder as /tasks. Nulls replace stale values on kept children too. */
export function hydrateDistributionChild(child: WriteResultChild, existing?: NimbusTask): NimbusTask {
  return Persistence._prepTask({
    ...existing,
    id: child.id,
    text: child.material_description || child.production_order,
    ORDER: child.production_order,
    PRODUCTION_ORDER: child.production_order,
    MATERIAL_NUMBER: child.material_number,
    MATERIAL_DESCRIPTION: child.material_description,
    MACHINE: child.machine,
    plant: child.plant,
    PLANT: child.plant,
    RUN_TIME: child.run_time,
    notes: child.notes,
    PARENT_ORDER: child.parent_production_order,
    DISTRIBUTION_LETTER: child.distribution_letter,
    row_version: child.base_version,
    start_date: child.start_date,
    end_date: child.end_date,
    BASIC_START_DATE: child.basic_start_date,
    BASIC_FINISH_DATE: child.basic_finish_date,
    original_start_date: child.basic_start_date,
    original_end_date: child.basic_finish_date,
    user_scheduled: child.scheduled_start !== null,
    planning_status: child.planning_status,
    planning_reason: child.planning_reason,
    schedule_segments: child.schedule_segments,
    runtime_schedule_mismatch: child.runtime_schedule_mismatch,
    run_time_source: child.run_time_source,
    run_time_basis: child.run_time_basis,
    PRT_01: child.prt_01,
    PRT_02: child.prt_02,
    PRODUCTION_VERSION: child.production_version,
    COLOR: child.color,
    FORM_SIZE: child.form_size,
    ecc_firmed: child.firming_indicator === 'X',
    firmed: existing?.firmed ?? false,
    'ORDER_QUANTITY_(GMEIN)': child.order_quantity,
    'LABOR_HOURS_(MEINH)': child.labor_hours,
    'MACHINE_HOURS_(MEINH)': child.machine_hours,
  });
}

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
  // D13: present (true) when the backend's result set itself was capped —
  // the list is showing only the oldest N matching headers, not all of them.
  // Absent (or false) means not truncated.
  meta: { total: number; scheduled_children: number; truncated?: boolean };
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

/** D37 - the date window the list fetch uses. The nav badge counts the plant's whole
 *  "needs review" backlog (the summary endpoint has no window), so with no explicit
 *  dates that bucket must not be windowed either, or the badge says 37 and the list
 *  shows 12. Other buckets keep the default window (today .. visibility horizon end).
 *  Explicit From/To always win. Empty string = no bound. */
export function effectiveDateWindow(filters: DistributionFilters, todayIso: string, horizonEndIso: string): { from: string; to: string } {
  const unwindowed = filters.bucket === 'needs_review';
  return {
    from: filters.from || (unwindowed ? '' : todayIso),
    to: filters.to || (unwindowed ? '' : horizonEndIso),
  };
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
// D32 — the backend caps `limit` at 200 (backend/distribution/routes.py); a
// re-fetch-from-the-top never asks for more than that, regardless of how
// many pages "Load more" had accumulated client-side.
const DIST_LIST_MAX_LIMIT = 200;

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
  let _truncated = false; // D13 — the server's own result set was capped
  let _loading = false;
  // D26 — request-identity guard: bumped by every `_fetchAndRenderList` call
  // (a filter/plant/page-reset fetch), and captured (not bumped) by
  // `_fetchMoreAndAppend` so a "Load more" response also drops itself if a
  // newer list fetch or a plant switch landed while it was in flight.
  let _listSeq = 0;

  let _workcentersPlant: string | null = null;
  let _workcenters: WorkCenterOption[] = [];

  let _selectedKey: string | null = null;
  let _detail: DistDetailResponse | null = null;
  let _detailLoading = false;

  const _checkedKeys = new Set<string>(); // bulk-select column, wired below (P2-16)
  let _bulkBusy = false;
  // D44: single write-busy latch shared by Save/Reset/Undo/Repair (the bulk
  // handlers have their own _bulkBusy above, but also check this one) — a
  // double-click, or any overlapping write trigger, must produce exactly ONE
  // request rather than two in flight.
  let _writeBusy = false;

  // --- P2-16 shares-editor state, scoped to whichever header is currently
  // open in the detail panel; reset on a genuine selection change, but
  // deliberately partly preserved (see _resyncEditorWeightsFromDetail) across
  // a same-header refresh after a write. ---------------------------------
  let _editorWeights: WeightMap = {};
  let _editorByQty = new Set<string>();
  let _editorQtyDraft: Record<string, string> = {};
  let _dryRun: DryRunResult | null = null;
  let _dryRunStatus: DryRunStatus = 'idle';
  let _dryRunSignature: string | null = null;
  let _dryRunSeq = 0; // guards a stale async dry-run response from clobbering a newer one
  let _detailSeq = 0;
  // D47 — set by the qty-input blur handler (via relatedTarget) right before
  // it calls _renderDetail(); consumed (and cleared back to `undefined`) by
  // the very next _renderDetail() call. Tri-state: `undefined` means "not in
  // that call path, fall back to reading document.activeElement"; `null` or
  // an element means the blur handler's relatedTarget is authoritative (even
  // `null`, meaning focus is leaving the pane entirely — don't restore).
  let _pendingDetailFocusTarget: HTMLElement | null | undefined;
  let _lastWrite: {
    previousShares: Array<{ machine: string; letter: string | null; weight: number | null }>;
    baseVersionAfterWrite: number;
  } | null = null;
  let _banner: { count: number; firmedIds: string[]; undo: () => void } | null = null;
  type DistWriteKind = 'shares' | 'reset';

  /** D09 — invalidate the editor's current dry-run result (and the
   *  signature it was computed for), and bump `_dryRunSeq` so a dry-run
   *  request already in flight for a now-stale header/inputs combination
   *  cannot land and mark Save ready once it eventually resolves (see
   *  `_runDryRun`'s own `stillCurrent()` check). Centralizes what used to be
   *  six separate inline `_dryRunStatus = 'idle'; _dryRun = null;
   *  _dryRunSignature = null;` resets scattered across every place that
   *  changes the editor's inputs or the selected header. */
  function _invalidateDryRun(): void {
    _dryRunSeq++;
    _dryRunStatus = 'idle';
    _dryRun = null;
    _dryRunSignature = null;
  }

  /** D44 — runs `fn` under the single write-busy latch: sets `_writeBusy`
   *  (and synchronously disables the Save/Reset/Undo buttons, so a second
   *  click arriving before the first microtask even runs still sees them
   *  disabled) BEFORE `fn` starts, and always clears the latch + re-renders
   *  the detail panel in `finally`, regardless of how `fn` finishes. A
   *  second call while one is already in flight is a silent no-op. */
  async function _latched(fn: () => Promise<void>): Promise<void> {
    if (_writeBusy) return;
    _writeBusy = true;
    try {
      _setWriteButtonsDisabled(true);
      await fn();
    } finally {
      _writeBusy = false;
      _renderDetail();
    }
  }

  function _setWriteButtonsDisabled(disabled: boolean): void {
    if (typeof document === 'undefined') return;
    for (const id of ['dist-save-btn', 'dist-reset-btn', 'dist-undo-btn']) {
      const btn = document.getElementById(id) as HTMLButtonElement | null;
      if (btn) btn.disabled = disabled;
    }
  }

  function _todayIso(): string { return Util.dayKey(new Date()); }
  function _horizonEndIso(): string { return Store.visibilityHorizonEnd ? Util.dayKey(Store.visibilityHorizonEnd) : ''; }
  function _effectiveFrom(): string { return effectiveDateWindow(_filters, _todayIso(), _horizonEndIso()).from; }
  function _effectiveTo(): string { return effectiveDateWindow(_filters, _todayIso(), _horizonEndIso()).to; }

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
        _detailSeq++;
        _invalidateDryRun();
        _detailLoading = false;
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
      if (evt.type === 'sandbox:entered' || evt.type === 'sandbox:exited') {
        // What-If guard (§6): Save/Reviewed/Reset/Undo must flip disabled the
        // instant the sandbox toggles, not just on the next unrelated render —
        // the list's own Reviewed checkbox/badge actions need the same
        // immediate refresh, not just the detail panel.
        if (_active) _renderList();
        if (_active && _selectedKey) _renderDetail();
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
    _syncControlsFromFilters();
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

  /** D36 — push the just-loaded `_filters` (persisted per-user state) into the
   *  toolbar controls `_ensureShell` built. Without this, a saved filter is
   *  silently applied to the fetch but the toolbar keeps showing its
   *  hardcoded defaults ("Needs review" / empty search), misleading the user
   *  about what's actually filtering the list. `_ensureShell` always runs
   *  (from `init()`) before `render()`'s first `_loadFilterState()` call, so
   *  the controls already exist by the time this runs. `fire: false` on the
   *  date pickers avoids re-triggering their own onChange -> re-fetch loop. */
  function _syncControlsFromFilters(): void {
    const search = document.getElementById('dist-search') as HTMLInputElement | null;
    if (search) search.value = _filters.search || '';
    const bucketSel = document.getElementById('dist-bucket-select') as HTMLSelectElement | null;
    if (bucketSel) bucketSel.value = _filters.bucket;
    _setDatePickerValue('dist-date-from', _filters.from);
    _setDatePickerValue('dist-date-to', _filters.to);
  }

  async function _loadWorkcentersIfNeeded(plant: string): Promise<void> {
    if (_workcentersPlant === plant) return;
    try {
      const resp = await Util.fetchTraced(`${API}/master-data/sap_workcenter?${new URLSearchParams({ plant, limit: '500' }).toString()}`);
      // D26: a plant switch while this request was in flight means this
      // response belongs to a plant the user already left — never commit it
      // (not even to mark the OLD plant as loaded), so the new plant's own
      // _loadWorkcentersIfNeeded call still fetches fresh instead of finding
      // _workcentersPlant already (wrongly) settled.
      if (Store.selectedPlant !== plant) return;
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as { rows: WorkCenterOption[] };
      _workcenters = data.rows || [];
      _workcentersPlant = plant;
    } catch (e) {
      if (Store.selectedPlant !== plant) return;
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
    // D32: re-fetch from the top, covering every page already loaded, rather
    // than just the current page — so a refresh (filter/plant change, write
    // completion, debounced Store-event refresh) never drops rows 1..N that
    // "Load more" had already appended. _page resets to match what was
    // actually fetched, so a later "Load more" click continues from there.
    const pagesLoaded = _page + 1;
    const limit = Math.min(pagesLoaded * PAGE_SIZE, DIST_LIST_MAX_LIMIT);
    _page = (limit / PAGE_SIZE) - 1;
    const seq = ++_listSeq;
    const stillCurrent = (): boolean => seq === _listSeq && Store.selectedPlant === plant;
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
      params.set('limit', String(limit));
      params.set('offset', '0');
      const resp = await Util.fetchTraced(`${API}/distribution/${encodeURIComponent(plant)}?${params.toString()}`);
      // D26: drop this response if a newer list fetch started, or the
      // selected plant changed, while it was in flight — never let an older
      // plant's/filter's rows or count land over a newer selection.
      if (!stillCurrent()) return;
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as DistListResponse;
      if (!stillCurrent()) return;
      _rows = data.data || [];
      _total = data.meta?.total ?? _rows.length;
      _truncated = data.meta?.truncated === true;
      _pruneCheckedKeys();
    } catch (e) {
      if (!stillCurrent()) return;
      ErrorLog.error('distribution', `Failed to load distribution list: ${(e as Error).message}`, { plant }, { errorCode: 'distribution.list_load' });
      Toast.show(Util.t('toast.dist_load_failed'), 'error');
      _rows = []; _total = 0;
      _truncated = false; // fix round 1: a failed fetch must not leave a stale truncated-notice showing
    }
    _loading = false;
    _renderList();
  }

  /** D26 — drop any checked (bulk-select) key whose row is no longer present
   *  in `_rows` after an accepted list fetch (a replace OR an append): a
   *  filter/page change can drop rows the user had checked, and leaving them
   *  in `_checkedKeys` would silently include them in the next bulk action. */
  function _pruneCheckedKeys(): void {
    if (!_checkedKeys.size) return;
    const present = new Set(_rows.map(r => _rowKey(r.header)));
    for (const key of _checkedKeys) {
      if (!present.has(key)) _checkedKeys.delete(key);
    }
  }

  async function _openDetail(key: string): Promise<void> {
    _invalidateDryRun();
    const seq = ++_detailSeq;
    const plant = Store.selectedPlant;
    const tasks = Store.tasks;
    const current = (): boolean => seq === _detailSeq && _selectedKey === key
      && Store.selectedPlant === plant && Store.tasks === tasks;
    const isNewSelection = key !== _selectedKey;
    _selectedKey = key;
    const row = _rows.find(r => _rowKey(r.header) === key);
    _renderList(); // reflect the new selection highlight without a full refetch
    if (!row) { _detail = null; _renderDetail(); return; }
    _detailLoading = true;
    _renderDetail();
    try {
      const resp = await Util.fetchTraced(`${API}/distribution/${encodeURIComponent(String(plant))}/${encodeURIComponent(row.header.production_order)}/${encodeURIComponent(row.header.material_number)}`);
      if (!current()) return;
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const detail = await resp.json() as DistDetailResponse;
      if (!current()) return;
      _detail = detail;
      if (isNewSelection) _resetEditorForNewHeader(); else _resyncEditorWeightsFromDetail();
      _invalidateDryRun();
      _scheduleDryRun();
    } catch (e) {
      if (!current()) return;
      ErrorLog.error('distribution', `Failed to load distribution detail: ${(e as Error).message}`, {}, { errorCode: 'distribution.detail_load' });
      Toast.show(Util.t('toast.dist_detail_load_failed'), 'error');
      _detail = null;
    } finally {
      if (seq === _detailSeq) {
        _detailLoading = false;
        _renderDetail();
      }
    }
  }

  /** A genuinely new header was selected — every editor/undo/dry-run state
   *  field is scoped to ONE header, so switching resets all of it. Seeds
   *  `_editorWeights` from the detail's shares (including 0-weight/purged
   *  ones — every current share is an editable row per §6). */
  function _resetEditorForNewHeader(): void {
    _editorWeights = {};
    for (const s of (_detail?.shares || [])) _editorWeights[s.machine] = s.weight;
    _editorByQty = new Set();
    _editorQtyDraft = {};
    _lastWrite = null;
    _banner = null;
  }

  /** A refresh of the SAME header (after our own write, a stale-refetch, or
   *  the periodic tasks:* debounce) — re-seeds the weight inputs from the
   *  server's confirmed values (so the editor reflects what is actually
   *  saved, not stale local typing) but deliberately keeps `_lastWrite`/
   *  `_banner`, which are compared against the header's new `base_version`
   *  elsewhere rather than being reset here. */
  function _resyncEditorWeightsFromDetail(): void {
    _editorWeights = {};
    for (const s of (_detail?.shares || [])) _editorWeights[s.machine] = s.weight;
    _editorByQty = new Set();
    _editorQtyDraft = {};
  }

  /** The editor's current row set — one row per share the detail route
   *  returned (every current work-center member the header already knows
   *  about, including 0-weight/purged ones; see this file's CLAUDE.md for
   *  the documented scope note on a work-center member with literally no
   *  share row yet). `weight` prefers the planner's in-progress edit over the
   *  server value. */
  function _editorRows(): EditorRowBase[] {
    return (_detail?.shares || []).map(s => ({
      machine: s.machine,
      letter: s.letter,
      weight: Object.prototype.hasOwnProperty.call(_editorWeights, s.machine) ? _editorWeights[s.machine] : (s.weight ?? null),
      purged: !!s.purged || !!s.purged_at,
      stale: !!s.stale,
      currentStart: s.start || null,
    }));
  }

  /** Shared review POST behind both the list's one-click `_markReviewed` and
   *  the detail panel's own `_onReviewedToggle` (D45) — a single place that
   *  owns the What-If gate (D05) and the backend's per-item status vocabulary
   *  (`reset_orders`/`review_orders` share the same `{results: [{status}]}`
   *  shape, data.py), so neither caller can independently forget to check
   *  `results[0].status` the way `_markReviewed` used to (it only checked
   *  `resp.ok`, so a 200 response carrying `status: 'stale'` was reported as
   *  a success). Callers own all UI side effects (toasts, refetch, re-open);
   *  this function is a pure network call returning an outcome code.
   *  `'blocked'` (the What-If gate — distinct from `'error'`, a real
   *  server-side failure) lets callers show the neutral `ui.dist_whatif_blocked`
   *  hint instead of the "could not mark as reviewed" failure toast. */
  async function _postReview(plant: string, header: DistHeader, reviewed: boolean): Promise<'ok' | 'stale' | 'not_found' | 'error' | 'blocked'> {
    if (Sandbox.active) return 'blocked';
    try {
      const resp = await Util.fetchTraced(`${API}/distribution/${encodeURIComponent(plant)}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orders: [{ production_order: header.production_order, material_number: header.material_number, base_version: header.base_version }],
          reviewed,
        }),
      });
      if (!resp.ok) return 'error';
      const body = await resp.json() as { results: Array<{ status: string }> };
      const status = body.results?.[0]?.status;
      if (status === 'stale') return 'stale';
      if (status === 'not_found') return 'not_found';
      if (status === 'error') return 'error';
      return 'ok';
    } catch (e) {
      ErrorLog.error('distribution', `Review call failed: ${(e as Error).message}`, {}, { errorCode: 'distribution.review_failed' });
      return 'error';
    }
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
    const status = await _postReview(plant, header, true);
    if (status === 'blocked') {
      Toast.show(Util.t('ui.dist_whatif_blocked'), 'info');
      return;
    }
    if (status === 'stale') {
      await _fetchAndRenderList();
      Toast.show(Util.t('toast.dist_stale_refetched'), 'warn');
      return;
    }
    if (status === 'not_found' || status === 'error') {
      Toast.show(Util.t('toast.dist_review_failed'), 'error');
      return;
    }
    Toast.show(Util.t('toast.dist_reviewed'), 'success');
    await _fetchAndRenderList();
    if (_selectedKey === _rowKey(header)) void _openDetail(_selectedKey);
    void loadDistributionSummary();
  }

  /* ---------------------------------------------------------------------
     P2-16 — dry-run preview, error mapping.
     ------------------------------------------------------------------- */

  interface ParsedDistError {
    code: string | null;
    message: string;
    children?: RemovedScheduledEntry[];
  }

  /** Every 4xx from the distribution write routes carries `detail: {code,
   *  message, children?}` (§6 "Errors") inside brain.py's `{status, message,
   *  detail}` envelope (see this file's own header note on the real
   *  `_http_exception_handler` reshape) — `Util.parseBackendError` alone
   *  doesn't surface `detail.code` (it only reads a top-level `error_code`,
   *  which these routes never set), so this reads the body directly and
   *  falls back to `Util.parseBackendError`'s generic shape for a non-object
   *  `detail` (a plain string, e.g. "plant is required"). */
  async function _parseDistError(resp: Response): Promise<ParsedDistError> {
    let body: { message?: string; detail?: unknown } | null = null;
    try { body = await resp.clone().json(); } catch { body = null; }
    const detail = body?.detail;
    if (detail && typeof detail === 'object') {
      const d = detail as { code?: string; message?: string; children?: RemovedScheduledEntry[] };
      return { code: d.code || null, message: d.message || body?.message || `HTTP ${resp.status}`, children: d.children };
    }
    const parsed = await Util.parseBackendError(resp);
    return { code: null, message: parsed.message };
  }

  /** code -> `err.dist_<code>` translated text, falling back to the server's
   *  own `message` when no such key is translated (§6 "Errors"). `Util.t`
   *  never throws for a missing key — it returns the key itself — so "no
   *  translation" is detected by that echo rather than a lookup exception. */
  function _distErrorMessage(code: string | null, message: string, vars?: Record<string, string>): string {
    const key = distErrorLocaleKey(code);
    if (!key) return message;
    const translated = Util.t(key, vars);
    return translated === key ? message : translated;
  }

  /** A bulk per-item result's own `code` (reset/review/reapply-defaults —
   *  data.py's `reset_orders` et al. now add it using the SAME `<code>:
   *  <detail>` partition rule as `routes._distribution_error`), falling
   *  back to parsing that prefix straight off `item.message` for a
   *  response that hasn't been migrated to carry a structured `code`. */
  function _bulkItemCode(item: { code?: string; message?: string }): string | null {
    if (item.code) return item.code;
    const match = /^([a-z_]+):\s*/.exec(item.message || '');
    return match ? match[1]! : null;
  }

  async function _handleStaleHeader(): Promise<void> {
    Toast.show(Util.t('toast.dist_stale_refetched'), 'warn');
    if (_selectedKey) await _openDetail(_selectedKey);
  }

  const _scheduleDryRun = Util.debounce(() => { void _runDryRun(); }, 300);

  /** The editor's own debounced preview (§6 "the shares editor... requested
   *  300ms after the last keystroke"). Always a `shares` dry run against the
   *  CURRENT `_editorWeights` — Undo/Reset run their OWN one-off preview
   *  through `_postDistWrite` (see below) rather than this debounced path,
   *  since their weights differ from whatever is currently typed into the
   *  editor. */
  async function _runDryRun(): Promise<void> {
    const plant = Store.selectedPlant;
    if (!plant || !_detail) return;
    const header = _detail.header;
    const rows = _editorRows();
    if (!rows.length) return;
    const payload = buildSharesPayload(rows);
    const signature = dryRunSignature(header, rows);
    const seq = ++_dryRunSeq;
    // D09: a dry run is priced for a specific header OBJECT as well as a
    // specific `_dryRunSeq` — `_invalidateDryRun()` bumps the seq on every
    // selection change, but comparing `_detail?.header` too is a second,
    // independent guard against a late response landing for whatever header
    // happens to be open once it resolves (every detail refresh assigns a
    // brand-new header object, even a same-order refresh).
    const stillCurrent = (): boolean => seq === _dryRunSeq && _detail?.header === header;
    _dryRunStatus = 'pending';
    _renderSaveState();
    try {
      const resp = await Util.fetchTraced(
        `${API}/distribution/${encodeURIComponent(plant)}/${encodeURIComponent(header.production_order)}/${encodeURIComponent(header.material_number)}/shares`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shares: payload, base_version: header.base_version, dry_run: true }),
        },
      );
      if (!stillCurrent()) return; // superseded by a later keystroke's dry run, or the detail changed under us
      if (!resp.ok) {
        const err = await _parseDistError(resp);
        if (err.code === 'stale') { await _handleStaleHeader(); return; }
        _dryRunStatus = 'error'; _dryRun = null; _dryRunSignature = null;
        Toast.show(_distErrorMessage(err.code, err.message), 'error');
        _renderDetail();
        return;
      }
      const body = await resp.json() as DryRunResult;
      if (!stillCurrent()) return; // the detail/selection could have changed during this second await too
      _dryRun = body;
      _dryRunStatus = 'ready';
      _dryRunSignature = signature;
    } catch (e) {
      if (!stillCurrent()) return;
      _dryRunStatus = 'error';
      ErrorLog.error('distribution', `Dry run failed: ${(e as Error).message}`, {}, { errorCode: 'distribution.dry_run_failed' });
    }
    _renderDetail();
  }

  /* ---------------------------------------------------------------------
     P2-16 — the shared dry-run/confirm/write pipeline behind Save, Undo and
     Reset (§6: "reusing the shared dry-run/confirm machinery"). `_postDistWrite`
     normalizes the two very differently-shaped backend responses (a single-
     header `.../shares` call vs. the bulk-shaped `.../reset`, called here
     with a one-item `orders` array) into one common outcome envelope so the
     confirm/retry logic above it never needs to know which endpoint it's
     driving.
     ------------------------------------------------------------------- */

  interface DistWriteOutcome {
    kind: 'ok' | 'stale' | 'children_scheduled' | 'not_found' | 'error';
    dryRun: DryRunResult | null;
    write: WriteResult | null;
    children?: RemovedScheduledEntry[];
    message?: string;
    code?: string | null;
    guard?: DistWriteGuard;
  }

  interface DistWriteGuard {
    plant: string;
    tasks: typeof Store.tasks;
    orders: Array<Pick<DistHeader, 'production_order' | 'material_number'>>;
    baselines: Map<string, string>;
  }

  function _affectedTasks(plant: string, orders: DistWriteGuard['orders']): NimbusTask[] {
    return Store.tasksByPlant(plant).filter(task => orders.some(order =>
      String(task.PARENT_ORDER || task.ORDER) === order.production_order
      && String(task.MATERIAL_NUMBER) === order.material_number));
  }

  /** Distribution never submits planner edits. Resolve them before a write,
   *  then compare the same persistence baseline before installing any tokens. */
  function _captureWriteGuard(plant: string, orders: DistWriteGuard['orders']): DistWriteGuard | null {
    const tasks = _affectedTasks(plant, orders);
    if (tasks.some(task => Persistence._dirtyIds.has(String(task.id))
      || Persistence._conflictedIds.has(String(task.id)))) {
      Toast.show(Util.t('ui.dist_guard_unsaved'), 'warn', 8000);
      return null;
    }
    return { plant, orders, tasks: Store.tasks,
      baselines: new Map(tasks.map(task => [String(task.id), JSON.stringify(Persistence._refreshBaseline(task))])) };
  }

  function _writeViewIsCurrent(guard: DistWriteGuard): boolean {
    return Store.selectedPlant === guard.plant && Store.tasks === guard.tasks;
  }

  async function _postDistWrite(kind: DistWriteKind, dryRun: boolean, confirmRemoveScheduled: boolean): Promise<DistWriteOutcome> {
    const plant = Store.selectedPlant;
    if (!plant || !_detail) return { kind: 'error', dryRun: null, write: null, message: Util.t('ui.dist_no_selection') };
    const header = _detail.header;
    const guard = _captureWriteGuard(plant, [header]);
    if (!guard) return { kind: 'error', dryRun: null, write: null,
      message: Util.t('ui.dist_guard_unsaved') };

    if (kind === 'shares') {
      const payload = buildSharesPayload(_editorRows());
      const resp = await Util.fetchTraced(
        `${API}/distribution/${encodeURIComponent(plant)}/${encodeURIComponent(header.production_order)}/${encodeURIComponent(header.material_number)}/shares`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shares: payload, base_version: header.base_version,
            dry_run: dryRun, confirm_remove_scheduled: confirmRemoveScheduled,
          }),
        },
      );
      if (resp.ok) {
        const body = await resp.json();
        return dryRun ? { kind: 'ok', dryRun: body as DryRunResult, write: null, guard }
                       : { kind: 'ok', dryRun: null, write: body as WriteResult, guard };
      }
      const err = await _parseDistError(resp);
      if (err.code === 'stale') return { kind: 'stale', dryRun: null, write: null };
      if (resp.status === 409 && err.children) return { kind: 'children_scheduled', dryRun: null, write: null, children: err.children };
      return { kind: 'error', dryRun: null, write: null, message: err.message, code: err.code };
    }

    // 'reset' — the bulk route, called here with a single-item `orders`
    // array; the response is `{results: [...]}` with the SAME per-item
    // status vocabulary (`ok`/`stale`/`children_scheduled`/`not_found`/
    // `error`) `reset_orders`/`review_orders` share (data.py).
    const resp = await Util.fetchTraced(`${API}/distribution/${encodeURIComponent(plant)}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orders: [{ production_order: header.production_order, material_number: header.material_number, base_version: header.base_version }],
        dry_run: dryRun, confirm_remove_scheduled: confirmRemoveScheduled,
      }),
    });
    if (!resp.ok) {
      const err = await _parseDistError(resp);
      return { kind: 'error', dryRun: null, write: null, message: err.message, code: err.code };
    }
    const body = await resp.json() as { results: Array<Record<string, unknown>> };
    const item = body.results?.[0] || {};
    const status = item.status as string | undefined;
    if (status === 'stale') return { kind: 'stale', dryRun: null, write: null };
    if (status === 'children_scheduled') return { kind: 'children_scheduled', dryRun: null, write: null, children: (item.children as RemovedScheduledEntry[]) || [] };
    if (status === 'not_found') return { kind: 'not_found', dryRun: null, write: null };
    if (status === 'error') {
      const message = item.message ? String(item.message) : undefined;
      return { kind: 'error', dryRun: null, write: null, message,
        code: _bulkItemCode(item as { code?: string; message?: string }) };
    }
    return dryRun ? { kind: 'ok', dryRun: item as unknown as DryRunResult, write: null, guard }
                   : { kind: 'ok', dryRun: null, write: item as unknown as WriteResult, guard };
  }

  /** §6 "Save flow": lists removals frozen-first, in a `Modal.confirm({tone:
   *  'danger'})`. Shared verbatim by Save, the 409 `children_scheduled` race
   *  retry, Undo and Reset. */
  async function _confirmRemoval(removed: readonly RemovedScheduledEntry[]): Promise<boolean> {
    const sorted = sortRemovedFrozenFirst(removed);
    const detail = '<ul>' + sorted.map(r => (
      `<li>${Util.escapeHtml(r.production_order)} — ${Util.escapeHtml(r.machine)}`
      + (r.frozen ? ` (${Util.escapeHtml(Util.t('ui.dist_marker_frozen'))})` : '')
      + '</li>'
    )).join('') + '</ul>';
    return Modal.confirm({
      tone: 'danger',
      title: Util.t('ui.dist_confirm_remove_title'),
      message: Util.t('ui.dist_confirm_remove_msg', { n: String(sorted.length) }),
      detail,
      confirmLabel: Util.t('btn.dist_confirm_remove'),
    });
  }

  /** Shared success path for a real (non-dry-run) write, regardless of which
   *  endpoint produced it: patch the Store (no full reload — §6 "Save flow"),
   *  remember `previous_shares`/the resulting `base_version` for Undo, run
   *  the reconcile pass, then refresh the detail/list/badge from the server. */
  async function _finishWrite(result: WriteResult, guard: DistWriteGuard): Promise<void> {
    if (!_applyWriteResult(result, guard)) return;
    const plant = guard.plant;
    const key = _rowKey(guard.orders[0]!);
    const selected = _selectedKey === key && !!_detail && _rowKey(_detail.header) === key;
    if (selected) _lastWrite = { previousShares: result.previous_shares, baseVersionAfterWrite: result.base_version };
    Toast.show(Util.t('toast.dist_shares_saved'), 'success');
    _reconcileAfterSave(plant, result.children.map(c => c.id), selected);
    if (selected) await _openDetail(key);
    if (!_writeViewIsCurrent(guard)) return;
    await _fetchAndRenderList();
    void loadDistributionSummary();
  }

  /** Preview -> (confirm if the preview shows removals) -> real write,
   *  including the 409 `children_scheduled` race retry (a further removal
   *  appeared between this pane's dry run and the real call — re-shown with
   *  FRESH data, per §6). Used by Undo and Reset; Save (below) skips the
   *  redundant first preview fetch since its own debounced `_dryRun` is
   *  already fresh for the current inputs. D46: returns whether a real write
   *  actually landed (`_finishWrite` ran) so Undo can tell "nothing happened"
   *  (cancelled confirm, stale header, a real error) apart from success and
   *  restore its pre-undo editor state in the former case; `_onResetClick`
   *  and the test harness ignore the return value, which is safe — neither
   *  needs to roll anything back on a no-op. */
  async function _runWritePipeline(kind: DistWriteKind): Promise<boolean> {
    if (!_detail || Sandbox.active) return false;
    const detail = _detail;
    const preview = await _postDistWrite(kind, true, false);
    if (preview.kind === 'stale') { await _handleStaleHeader(); return false; }
    if (preview.kind === 'not_found') { Toast.show(Util.t('toast.dist_reset_failed'), 'error'); return false; }
    if (preview.kind === 'error') {
      Toast.show(_distErrorMessage(preview.code ?? null, preview.message || Util.t('toast.dist_shares_save_failed')), 'error');
      return false;
    }
    const removed = preview.dryRun?.removed_scheduled || [];
    let confirmRemoveScheduled = false;
    if (needsRemovalConfirm(removed)) {
      const ok = await _confirmRemoval(removed);
      if (!ok) return false;
      confirmRemoveScheduled = true;
    }
    // Re-check Sandbox.active here too (D05) — What-If can flip on while this
    // preview request is in flight, between the entry guard above and this
    // point; without this, a sandbox entered mid-preview would let the real
    // (non-dry-run) write through.
    if (_detail !== detail || !preview.guard || !_writeViewIsCurrent(preview.guard) || Sandbox.active) return false;
    let real = await _postDistWrite(kind, false, confirmRemoveScheduled);
    if (real.kind === 'stale') { await _handleStaleHeader(); return false; }
    if (real.kind === 'children_scheduled') {
      const ok = await _confirmRemoval(real.children || []);
      if (!ok) return false;
      if (_detail !== detail || !_writeViewIsCurrent(preview.guard) || Sandbox.active) return false;
      real = await _postDistWrite(kind, false, true);
    }
    if (real.kind === 'not_found') { Toast.show(Util.t('toast.dist_reset_failed'), 'error'); return false; }
    if (real.kind === 'error' || real.kind === 'children_scheduled') {
      Toast.show(_distErrorMessage(real.code ?? null, real.message || Util.t('toast.dist_shares_save_failed')), 'error');
      return false;
    }
    if (real.write && real.guard) { await _finishWrite(real.write, real.guard); return true; }
    return false;
  }

  /** Save (§6 "Save flow"). Reuses the CURRENT settled `_dryRun` (the button
   *  is disabled until one matches the current inputs, so there is always a
   *  fresh one here) rather than re-fetching a redundant preview. D44:
   *  wrapped in `_latched` so a second click arriving before this one
   *  finishes produces no second request. */
  async function _onSaveClick(): Promise<void> {
    await _latched(async () => {
      if (!_detail || Sandbox.active) return;
      const detail = _detail;
      const plant = Store.selectedPlant;
      if (!plant) return;
      const initialGuard = _captureWriteGuard(plant, [detail.header]);
      if (!initialGuard) return;
      const rows = _editorRows();
      const sig = dryRunSignature(detail.header, rows);
      const state = computeSaveButtonState({
        dryRunStatus: _dryRunStatus, dryRunSignature: _dryRunSignature, currentSignature: sig,
        removedScheduledCount: _dryRun?.removed_scheduled?.length || 0, whatIfBlocked: Sandbox.active,
      });
      if (state.disabled) return;
      const removed = _dryRun?.removed_scheduled || [];
      let confirmRemoveScheduled = false;
      if (needsRemovalConfirm(removed)) {
        const ok = await _confirmRemoval(removed);
        if (!ok) return;
        confirmRemoveScheduled = true;
      }
      // Same mid-flight re-check as _runWritePipeline (D05): What-If can flip on
      // during the Modal.confirm await above (or even synchronously between the
      // entry check and here), and Save must not proceed once it has.
      if (_detail !== detail || !_writeViewIsCurrent(initialGuard) || Sandbox.active) return;
      let real = await _postDistWrite('shares', false, confirmRemoveScheduled);
      if (real.kind === 'stale') { await _handleStaleHeader(); return; }
      if (real.kind === 'children_scheduled') {
        const ok = await _confirmRemoval(real.children || []);
        if (!ok) return;
        if (_detail !== detail || !_writeViewIsCurrent(initialGuard) || Sandbox.active) return;
        real = await _postDistWrite('shares', false, true);
      }
      if (real.kind === 'error' || real.kind === 'not_found' || real.kind === 'children_scheduled') {
        Toast.show(_distErrorMessage(real.code ?? null, real.message || Util.t('toast.dist_shares_save_failed')), 'error');
        return;
      }
      if (real.write && real.guard) await _finishWrite(real.write, real.guard);
    });
  }

  /** Reset to work-center defaults (§6) — same dry-run-preview-then-confirm
   *  pattern as Save, driven through the SAME `_runWritePipeline`. D44:
   *  wrapped in `_latched`. */
  async function _onResetClick(): Promise<void> {
    await _latched(async () => { await _runWritePipeline('reset'); });
  }

  /** Undo last change (§6) — re-posts a weight map derived from
   *  `_lastWrite.previousShares` as a new `shares` write, through the SAME
   *  dry-run/confirm pipeline ("same guards as a normal save"). Disabled
   *  state itself is computed by `isUndoDisabled` at render time; this is
   *  the defensive re-check for a stale click. D44: wrapped in `_latched`
   *  BEFORE this function touches any editor state, so an overlapping
   *  click can't race the snapshot/mutation below. D46: snapshots the
   *  editor's current state before speculatively applying the undo weights,
   *  so a pipeline that never actually writes (a cancelled removal
   *  confirm, a stale header, a real error, or even a THROWN error —
   *  `_runWritePipeline` returning `false`, or rejecting) restores exactly
   *  what the planner had typed rather than leaving the undo's speculative
   *  weights stuck in the editor. The restore is additionally gated on
   *  `_detail === detail` (the object captured BEFORE the pipeline ran): a
   *  `stale` outcome inside the pipeline already drove `_handleStaleHeader`
   *  -> `_openDetail`, which re-syncs `_detail`/the editor weights/the
   *  dry-run state from the server's fresh values and reassigns `_detail`
   *  to a brand-new object — restoring the pre-undo snapshot ON TOP of that
   *  fresh resync would silently resurrect stale weights and price them
   *  against the NEW `base_version` next preview (a lost-update bug). Same
   *  reasoning covers a plain order switch mid-Undo (also reassigns
   *  `_detail`). */
  async function _onUndoClick(): Promise<void> {
    await _latched(async () => {
      if (!_detail || !_lastWrite || Sandbox.active) return;
      if (isUndoDisabled(_lastWrite.baseVersionAfterWrite, _detail.header.base_version)) return;
      const detail = _detail;
      const snapshot = {
        editorWeights: { ..._editorWeights },
        editorByQty: new Set(_editorByQty),
        editorQtyDraft: { ..._editorQtyDraft },
        dryRun: _dryRun,
        dryRunStatus: _dryRunStatus,
        dryRunSignature: _dryRunSignature,
      };
      const rows = _editorRows();
      _editorWeights = undoWeightMap(_lastWrite.previousShares, rows.map(r => r.machine));
      _editorByQty = new Set();
      _editorQtyDraft = {};
      _invalidateDryRun();
      let applied = false;
      try {
        applied = await _runWritePipeline('shares');
      } catch (e) {
        ErrorLog.error('distribution', `Undo failed: ${(e as Error).message}`, {}, { errorCode: 'distribution.undo_failed' });
        applied = false;
      }
      if (!applied && _detail === detail) {
        _editorWeights = snapshot.editorWeights;
        _editorByQty = snapshot.editorByQty;
        _editorQtyDraft = snapshot.editorQtyDraft;
        _dryRun = snapshot.dryRun;
        _dryRunStatus = snapshot.dryRunStatus;
        _dryRunSignature = snapshot.dryRunSignature;
        _scheduleDryRun();
      }
    });
  }

  /** Detail panel's own Reviewed checkbox/indeterminate re-stamp (§6) — same
   *  call `_markReviewed` uses for the list's checkbox, just addressed at
   *  whichever header the detail panel currently has open. */
  async function _onReviewedToggle(checked: boolean): Promise<void> {
    if (!_detail || Sandbox.active) return;
    const header = _detail.header;
    const plant = Store.selectedPlant;
    if (!plant) return;
    const status = await _postReview(plant, header, checked);
    if (status === 'blocked') {
      Toast.show(Util.t('ui.dist_whatif_blocked'), 'info');
      _renderDetail();
      return;
    }
    if (status === 'stale') { await _handleStaleHeader(); return; }
    if (status === 'not_found' || status === 'error') {
      Toast.show(Util.t('toast.dist_review_failed'), 'error');
      _renderDetail();
      return;
    }
    try {
      Toast.show(Util.t('toast.dist_reviewed'), 'success');
      if (_selectedKey) await _openDetail(_selectedKey);
      await _fetchAndRenderList();
      void loadDistributionSummary();
    } catch (e) {
      ErrorLog.error('distribution', `Review call failed: ${(e as Error).message}`, {}, { errorCode: 'distribution.review_failed' });
      Toast.show(Util.t('toast.dist_review_failed'), 'error');
      _renderDetail();
    }
  }

  /* ---------------------------------------------------------------------
     P2-16 — patch the returned children/removed into Store (no full reload).
     ------------------------------------------------------------------- */

  function _applyWriteResult(result: WriteResult, guard: DistWriteGuard): boolean {
    if (Store.selectedPlant !== guard.plant) return false;
    // Include the original group, deleted ids, and newly appeared/colliding ids.
    // One unresolved child retains the entire group so replacements and removals
    // cannot leave a mixture of old local edits and fresh server row versions.
    const ids = new Set([...guard.baselines.keys(), ...result.children.map(child => String(child.id)),
      ...result.removed.map(String), ..._affectedTasks(guard.plant, guard.orders).map(task => String(task.id))]);
    const changed = Store.tasks !== guard.tasks || [...ids].some(id => {
      const task = Store.tasks[id], baseline = guard.baselines.get(id);
      if (!task) return baseline !== undefined;
      return baseline !== JSON.stringify(Persistence._refreshBaseline(task))
        || Persistence._dirtyIds.has(id) || Persistence._conflictedIds.has(id);
    });
    if (changed) {
      for (const id of ids) if (Store.tasks[id]) {
        Persistence._dirtyIds.add(id);
        Persistence._conflictedIds.add(id);
      }
      Persistence._syncUnsaved();
      Persistence._saveCache();
      Persistence._warnUnresolvedConflict();
      return false;
    }
    // D31: the write rewrote these sub-orders server-side; any Ctrl+Z entry that
    // would restore their older values must go (it would resurrect pre-write data).
    invalidateUndoForWrite(ids);
    if (!result.children.length && !result.removed.length) return true;
    for (const child of result.children) _upsertChildTask(child);
    for (const id of result.removed) Store.removeTask(id, 'distribution');
    Store.rebuildPlantIndex();
    Store.emit({ type: 'tasks:bulkUpdate', ids: result.children.map(c => c.id), source: 'distribution' });
    return true;
  }

  /** Patch an existing child in place (mutate, don't replace the reference —
   *  same convention `Store.updateMany` uses), or insert a brand-new one.
   *  NOTE: `child` here is `data.py`'s hand-built lowercase write-response
   *  shape (see shares-editor.mts's header note), NOT the `/tasks` TaskDTO —
   *  the uppercase/parenthesized quantity-and-hours keys below
   *  (`ORDER_QUANTITY_(GMEIN)` etc., verified against
   *  backend/scheduling/routes.py's `get_tasks`) are the real NimbusTask
   *  field names for those two values, confirmed rather than guessed. */
  function _upsertChildTask(child: WriteResultChild): void {
    const existing = Store.tasks[child.id];
    const task = hydrateDistributionChild(child, existing);
    if (existing) {
      Object.assign(existing, task);
      Store._normalizeDates(existing);
      return;
    }
    Store._normalizeDates(task);
    Store.tasks[child.id] = task;
  }

  /* ---------------------------------------------------------------------
     P2-16 — reconcile banner (Engine.reconcileRuntimeSchedules follow-up).

     `Engine.reconcileRuntimeSchedules(plant)` (frontend/optimization/engine.mts)
     was verified safe to call directly here: it takes a bare plant string,
     brackets its own `Calendar._beginRun`/`_endRun`, reads only
     `Store.tasksByPlant(plant)`, and its own doc comment states current
     behavior plainly — "Firmed is parent-level only and does not suppress
     this required runtime correction." That is a real, live-code
     contradiction of aggregate_to_detail.md §6's premise ("reconcileRuntimeSchedules
     skips firmed tasks... the pane says so") — the CURRENT implementation has
     no firmed check at all, so a firmed child's mismatch is corrected exactly
     like any other, not left in place pending a manual unfirm. This function
     still surfaces firmed status on any RESIZED child (matching the design's
     "left for you to unfirm" copy), since a planner may still want to review/
     re-firm a bar whose dates just moved even though nothing here is
     actually blocked on unfirming it — but the underlying premise that firmed
     children are excluded from this pass is doc drift, not current behavior;
     see this feature's report for the flagged gap. */
  function _reconcileAfterSave(plant: string, childIds: string[], showBanner = true): void {
    if (!childIds.length) return;
    const snapshot = UndoStack.snapshotTasks(childIds);
    Engine.reconcileRuntimeSchedules(plant);
    if (!showBanner) return;
    const resizedIds = childIds.filter(id => {
      const before = snapshot.find(t => String(t.id) === id);
      const after = Store.tasks[id];
      if (!before || !after) return false;
      return before.start_date?.getTime() !== after.start_date?.getTime()
        || before.end_date?.getTime() !== after.end_date?.getTime();
    });
    if (!resizedIds.length) return;
    const firmedIds = resizedIds.filter(id => Store.isFirmed(id) || !!Store.tasks[id]?.ecc_firmed);
    const undo = (): void => {
      UndoStack.restoreTasks(snapshot);
      _banner = null;
      _renderDetail();
    };
    UndoStack.push(Util.t('ui.dist_saved_reconcile', { n: String(resizedIds.length) }), undo, resizedIds);
    _banner = { count: resizedIds.length, firmedIds, undo };
    _renderDetail();
  }

  /** Banner "Save schedule" (§6) AND the list's `runtime_mismatch` badge
   *  one-click action (same destination — see the `dist-list-tbody` click
   *  delegate's badge dispatch below) — gated (D05): `Persistence.saveAll()`
   *  itself treats an active What-If sandbox as "promote and save"
   *  (`Sandbox.exit(true)`, which then recurses into `saveAll()` —
   *  persistence.mts), so calling it unguarded here would silently promote
   *  the sandbox to the live schedule instead of leaving the planner in
   *  What-If mode. */
  function _onSaveScheduleClick(): void {
    if (Sandbox.active) return;
    // A user click: never silent (an in-flight save must still say so). `silent` stays
    // reserved for programmatic promote paths.
    Persistence.saveAll();
  }

  /* ---------------------------------------------------------------------
     P2-16 — Show on Gantt / Open in Inspector (per-row and header-level).
     ------------------------------------------------------------------- */

  function _liveChildIds(): string[] {
    return (_detail?.shares || [])
      .filter(s => s.child_id && !s.purged)
      .map(s => s.child_id as string);
  }

  function _earliestChildId(ids: string[]): string | null {
    let best: { id: string; start: number } | null = null;
    for (const id of ids) {
      const startMs = Store.tasks[id]?.start_date?.getTime();
      if (startMs == null) continue;
      if (!best || startMs < best.start) best = { id, start: startMs };
    }
    return best?.id ?? (ids[0] ?? null);
  }

  /** §6: "selects the header's children through Selection and scrolls to the
   *  earliest." Goes through the ambient `NIMBUS` global for `Selection`/
   *  `Timeline` (added to `frontend/types/nimbus-global.d.mts` for this task)
   *  — the same "leaf pane reaching upward" idiom this file already uses for
   *  `App`/`EmptyState`, per the module header comment. */
  function _onShowOnGantt(): void {
    const ids = _liveChildIds();
    if (!ids.length) return;
    const nimbus = typeof NIMBUS !== 'undefined' ? NIMBUS : undefined;
    nimbus?.App?.gotoGanttTimeline?.();
    nimbus?.Selection?.set?.(ids);
    const earliest = _earliestChildId(ids);
    if (earliest) setTimeout(() => nimbus?.Timeline?.focus?.(earliest), 250);
  }

  /** §6: "Open in Inspector." `Timeline.focus` itself opens the Inspector for
   *  the focused task (gantt.mts), so this is Show-on-Gantt's single-id
   *  sibling rather than a separate mechanism. */
  function _onOpenInInspector(): void {
    const earliest = _earliestChildId(_liveChildIds());
    if (!earliest) return;
    const nimbus = typeof NIMBUS !== 'undefined' ? NIMBUS : undefined;
    nimbus?.App?.gotoGanttTimeline?.();
    setTimeout(() => nimbus?.Timeline?.focus?.(earliest), 250);
  }

  /* ---------------------------------------------------------------------
     P2-16 — bulk actions on the list's checked rows.
     ------------------------------------------------------------------- */

  function _checkedOrders(): Array<{ production_order: string; material_number: string; base_version: number }> {
    const out: Array<{ production_order: string; material_number: string; base_version: number }> = [];
    for (const key of _checkedKeys) {
      const row = _rows.find(r => _rowKey(r.header) === key);
      if (row) out.push({ production_order: row.header.production_order, material_number: row.header.material_number, base_version: row.header.base_version });
    }
    return out;
  }

  /** `ok`/`stale`/`not_found`/`children_scheduled`/`error` -> translated label
   *  (`ui.dist_bulk_status_<code>`), so the bulk-result dialog never shows a
   *  raw backend status word. Falls back to the raw code if a status this
   *  endpoint hasn't shipped yet shows up untranslated. */
  function _bulkStatusLabel(status: string): string {
    const key = `ui.dist_bulk_status_${status}`;
    const translated = Util.t(key);
    return translated === key ? status : translated;
  }

  async function _reportBulkResults(
    results: Array<{ production_order: string; material_number: string; status: string; message?: string; code?: string }>,
    title: string,
  ): Promise<void> {
    const problems = results.filter(r => r.status !== 'ok');
    if (!problems.length) {
      Toast.show(Util.t('toast.dist_bulk_done', { n: String(results.length) }), 'success');
      return;
    }
    const detail = '<ul>' + problems.map(r => (
      `<li>${Util.escapeHtml(r.production_order)} — ${Util.escapeHtml(_bulkStatusLabel(r.status))}`
      + (r.message ? `: ${Util.escapeHtml(_distErrorMessage(_bulkItemCode(r), r.message))}` : '') + '</li>'
    )).join('') + '</ul>';
    await Modal.confirm({
      title, detail,
      message: Util.t('ui.dist_bulk_partial_msg', { n: String(problems.length) }),
      confirmLabel: Util.t('btn.close'),
    });
  }

  async function _onBulkReview(): Promise<void> {
    if (_bulkBusy || _writeBusy || Sandbox.active) return;
    const orders = _checkedOrders();
    if (!orders.length) return;
    const plant = Store.selectedPlant;
    if (!plant) return;
    _bulkBusy = true;
    try {
      const resp = await Util.fetchTraced(`${API}/distribution/${encodeURIComponent(plant)}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orders, reviewed: true }),
      });
      if (!resp.ok) {
        const err = await _parseDistError(resp);
        Toast.show(_distErrorMessage(err.code, err.message), 'error');
        return;
      }
      const body = await resp.json() as { results: Array<{ production_order: string; material_number: string; status: string }> };
      await _reportBulkResults(body.results, Util.t('ui.dist_bulk_review_result_title'));
      _checkedKeys.clear();
      await _fetchAndRenderList();
      void loadDistributionSummary();
    } catch (e) {
      ErrorLog.error('distribution', `Bulk review failed: ${(e as Error).message}`, {}, { errorCode: 'distribution.bulk_review_failed' });
      Toast.show(Util.t('toast.dist_review_failed'), 'error');
    } finally {
      _bulkBusy = false;
      _renderList();
    }
  }

  async function _onBulkReset(): Promise<void> {
    if (_bulkBusy || _writeBusy || Sandbox.active) return;
    const orders = _checkedOrders();
    if (!orders.length) return;
    const plant = Store.selectedPlant;
    if (!plant) return;
    const initialGuard = _captureWriteGuard(plant, orders);
    if (!initialGuard) return;
    _bulkBusy = true;
    try {
      const previewResp = await Util.fetchTraced(`${API}/distribution/${encodeURIComponent(plant)}/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orders, dry_run: true }),
      });
      if (!previewResp.ok) { Toast.show(Util.t('toast.dist_reset_failed'), 'error'); return; }
      const previewBody = await previewResp.json() as { results: Array<Record<string, unknown>> };
      const allRemoved = previewBody.results.flatMap(r => (Array.isArray(r.removed_scheduled) ? r.removed_scheduled as RemovedScheduledEntry[] : []));
      let confirmRemoveScheduled = false;
      if (needsRemovalConfirm(allRemoved)) {
        const ok = await _confirmRemoval(allRemoved);
        if (!ok) return;
        confirmRemoveScheduled = true;
      }
      if (!_writeViewIsCurrent(initialGuard)) return;
      const guards = new Map(orders.map(order => [_rowKey(order), _captureWriteGuard(plant, [order])]));
      if ([...guards.values()].some(guard => !guard)) return;
      const resp = await Util.fetchTraced(`${API}/distribution/${encodeURIComponent(plant)}/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orders, confirm_remove_scheduled: confirmRemoveScheduled }),
      });
      if (!resp.ok) { Toast.show(Util.t('toast.dist_reset_failed'), 'error'); return; }
      const body = await resp.json() as {
        results: Array<{ production_order: string; material_number: string; status: string; message?: string; code?: string; children?: WriteResultChild[]; removed?: string[] }>;
      };
      if (Store.selectedPlant !== plant) return;
      for (const item of body.results) {
        const guard = guards.get(_rowKey(item));
        if (item.status === 'ok' && item.children && guard) {
          _applyWriteResult({ status: 'ok', children: item.children, removed: item.removed || [], previous_shares: [], versions: {}, base_version: 0 }, guard);
        }
      }
      await _reportBulkResults(body.results, Util.t('ui.dist_bulk_reset_result_title'));
      _checkedKeys.clear();
      await _fetchAndRenderList();
      void loadDistributionSummary();
    } catch (e) {
      ErrorLog.error('distribution', `Bulk reset failed: ${(e as Error).message}`, {}, { errorCode: 'distribution.bulk_reset_failed' });
      Toast.show(Util.t('toast.dist_reset_failed'), 'error');
    } finally {
      _bulkBusy = false;
      _renderList();
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
          <div id="dist-bulk-bar-slot"></div>
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
        _renderBulkBar();
        return;
      }

      const reviewedBox = target.closest('.dist-reviewed-check') as HTMLInputElement | null;
      if (reviewedBox) {
        const found = _rows.find(r => _rowKey(r.header) === key);
        if (found) void _markReviewed(found.header);
        return;
      }

      // §6's action table: a badge's one-click action when it has exactly
      // ONE deterministic action. Every status offering a CHOICE of actions
      // (mode_mismatch/wc_changed/membership_changed/below_min_lot/
      // zero_quantity_children — "Adjust shares, Reset, or Mark reviewed",
      // etc.) falls through to the same _openDetail(key) every other click
      // on the row already does, since the editor is where that choice is
      // made; `purged` has no action at all.
      const badge = target.closest('.dist-badge-action') as HTMLElement | null;
      // What-If guard (D05): CSS (`.dist-badge-action.disabled`) already
      // turns off pointer-events, but a JS-level guard on the same class
      // covers browsers/overlays where that doesn't apply — a disabled
      // badge dispatches no action at all, including the separation_violated
      // Show-on-Gantt jump below.
      const badgeEnabled = !!badge && !badge.classList.contains('disabled');
      if (badgeEnabled) {
        const found = _rows.find(r => _rowKey(r.header) === key);
        if (found) {
          const { code } = pickPrimaryBadge(found.statuses);
          if (code === 'needs_review' || code === 'qty_changed') { void _markReviewed(found.header); return; }
          if (code === 'incomplete') { void _repairRow(found); return; }
          // Same gated handler the reconcile banner's "Save schedule" button
          // uses (D05) — never call Persistence.saveAll() directly here.
          if (code === 'runtime_mismatch') { _onSaveScheduleClick(); return; }
          if (code === 'purged') return;
          // separation_violated ("Show on Gantt") and every multi-choice
          // status open the detail panel below.
        }
      }

      void _openDetail(key).then(() => {
        const found = _rows.find(r => _rowKey(r.header) === key);
        if (badgeEnabled && found && pickPrimaryBadge(found.statuses).code === 'separation_violated') _onShowOnGantt();
      });
    });

    document.getElementById('dist-bulk-bar-slot')?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('#dist-bulk-review-btn')) { void _onBulkReview(); return; }
      if (target.closest('#dist-bulk-reset-btn')) { void _onBulkReset(); }
    });

    _wireEditorEvents();
  }

  /* ---------------------------------------------------------------------
     P2-16 — shares editor event delegation. Bound ONCE on `#dist-detail-pane`
     (a stable container `_ensureShell` creates and never destroys) rather
     than re-attached on every `_renderDetail()` call, since that function
     replaces the pane's `innerHTML` wholesale on every render (including
     mid-typing, on a 300ms-debounced dry run) — delegation is required here,
     not just convenient.
     ------------------------------------------------------------------- */
  function _wireEditorEvents(): void {
    const pane = document.getElementById('dist-detail-pane');
    if (!pane) return;

    // Weight/quantity typing — deliberately does NOT call _renderDetail()
    // synchronously (that would steal focus mid-keystroke); it only updates
    // state, kicks the debounced dry run, and does a lightweight in-place
    // Save-button update. The next full render happens when the debounced
    // dry run actually resolves (by definition, after the planner has paused
    // typing for 300ms+ the request's latency).
    pane.addEventListener('input', (e) => {
      const target = e.target as HTMLElement;
      const row = target.closest('tr[data-machine]') as HTMLElement | null;
      if (!row) return;
      const machine = row.dataset.machine as string;
      if (target.matches('.dist-weight-input')) {
        const raw = (target as HTMLInputElement).value.trim();
        _editorWeights[machine] = raw === '' ? null : Number(raw);
        _invalidateDryRun();
        _scheduleDryRun();
        _renderSaveState();
      } else if (target.matches('.dist-qty-input')) {
        _editorQtyDraft[machine] = (target as HTMLInputElement).value;
      }
    });

    // blur doesn't bubble — capture phase is required for delegation.
    pane.addEventListener('blur', (e) => {
      const target = e.target as HTMLElement;
      if (!(target instanceof HTMLElement) || !target.matches('.dist-qty-input')) return;
      const row = target.closest('tr[data-machine]') as HTMLElement | null;
      if (!row) return;
      // D47: this handler ends by calling _renderDetail() below, which
      // replaces the whole panel's innerHTML and would otherwise drop focus
      // on whatever the blur was moving it TO (e.g. Tab to the next row's
      // weight input) — relatedTarget names that element while the browser
      // may have already updated document.activeElement to it.
      _pendingDetailFocusTarget = (e as FocusEvent).relatedTarget as HTMLElement | null;
      const machine = row.dataset.machine as string;
      const raw = _editorQtyDraft[machine];
      delete _editorQtyDraft[machine];
      const qty = raw === undefined ? NaN : Number(raw);
      // D35: a typed target quantity converts to a RELATIVE weight against
      // the OTHER rows' current (already-resolved) weight total, scaled by
      // the header's total order quantity — see quantityToWeight's own doc
      // comment. `'all'` (q >= Q, or every other row already zeroed) maps to
      // the same "only this machine" weight map the dedicated button uses,
      // rather than a weight this function has no finite value for. A
      // header with no (or a non-positive) `order_quantity` has no usable
      // Q to divide by at all — `?? 0` used to make every typed quantity
      // look like `q >= Q` and silently collapse to "only this machine";
      // skip the conversion entirely instead, leaving the weight unchanged.
      const totalQty = _detail?.header.order_quantity;
      if (raw !== undefined && raw.trim() !== '' && Number.isFinite(qty) && qty >= 0 && _detail && totalQty != null && totalQty > 0) {
        const rows = _editorRows();
        const othersWeightSum = rows
          .filter(r => r.machine !== machine)
          .reduce((sum, r) => sum + resolvedWeight(r.weight, r.purged), 0);
        const result = quantityToWeight(qty, totalQty, othersWeightSum);
        _editorWeights = result === 'all'
          ? onlyThisMachine(rows.map(r => r.machine), machine)
          : { ..._editorWeights, [machine]: result };
      }
      _invalidateDryRun();
      _scheduleDryRun();
      _renderDetail();
    }, true);

    pane.addEventListener('change', (e) => {
      const target = e.target as HTMLElement;
      if (target.matches('#dist-reviewed-toggle')) void _onReviewedToggle((target as HTMLInputElement).checked);
    });

    pane.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      if (target.closest('#dist-save-btn')) { void _onSaveClick(); return; }
      if (target.closest('#dist-reset-btn')) { void _onResetClick(); return; }
      if (target.closest('#dist-undo-btn')) { void _onUndoClick(); return; }
      if (target.closest('#dist-show-gantt-btn')) { _onShowOnGantt(); return; }
      if (target.closest('#dist-open-inspector-btn')) { _onOpenInInspector(); return; }
      if (target.closest('#dist-banner-save-schedule')) { _onSaveScheduleClick(); return; }
      if (target.closest('#dist-banner-undo')) { if (!Sandbox.active) _banner?.undo(); return; }

      if (target.closest('#dist-editor-even-btn')) {
        const rows = _editorRows();
        _editorWeights = evenWeights(rows.map(r => r.machine));
        _editorByQty.clear();
        _invalidateDryRun();
        _scheduleDryRun();
        _renderDetail();
        return;
      }

      const onlyBtn = target.closest('.dist-row-only') as HTMLElement | null;
      if (onlyBtn) {
        const row = onlyBtn.closest('tr[data-machine]') as HTMLElement;
        const machine = row.dataset.machine as string;
        const rows = _editorRows();
        _editorWeights = onlyThisMachine(rows.map(r => r.machine), machine);
        _editorByQty.clear();
        _invalidateDryRun();
        _scheduleDryRun();
        _renderDetail();
        return;
      }

      const byQtyBtn = target.closest('.dist-row-byqty-toggle') as HTMLElement | null;
      if (byQtyBtn) {
        const row = byQtyBtn.closest('tr[data-machine]') as HTMLElement;
        const machine = row.dataset.machine as string;
        if (_editorByQty.has(machine)) _editorByQty.delete(machine); else _editorByQty.add(machine);
        _renderDetail();
      }
    });
  }

  /** Show/hide + repopulate the bulk-action bar above the list — called
   *  whenever `_checkedKeys` changes (checkbox toggle) or the list re-renders
   *  wholesale. */
  function _renderBulkBar(): void {
    const slot = document.getElementById('dist-bulk-bar-slot');
    if (!slot) return;
    if (!_checkedKeys.size) { slot.innerHTML = ''; return; }
    const n = String(_checkedKeys.size);
    const disabled = Sandbox.active || _bulkBusy;
    slot.innerHTML = `
      <div class="dist-bulk-bar" id="dist-bulk-bar">
        <span class="dist-bulk-count">${Util.escapeHtml(Util.t('ui.dist_bulk_selected', { n }))}</span>
        <button type="button" class="btn btn-ghost sm" id="dist-bulk-review-btn" ${disabled ? 'disabled' : ''}>${Util.escapeHtml(Util.t('btn.dist_bulk_mark_reviewed', { n }))}</button>
        <button type="button" class="btn btn-ghost sm" id="dist-bulk-reset-btn" ${disabled ? 'disabled' : ''}>${Util.escapeHtml(Util.t('btn.dist_bulk_reset'))}</button>
        ${Sandbox.active ? `<span class="dist-whatif-hint">${Util.escapeHtml(Util.t('ui.dist_whatif_blocked'))}</span>` : ''}
      </div>`;
  }

  /** `incomplete`'s one-click action (§6): re-post the header's CURRENT
   *  stored shares unchanged, letting the shared materialization engine
   *  reconcile children to match (backend/distribution/CLAUDE.md's "resolve
   *  scope repair" precedent, run here per-row from the list instead). D44:
   *  wrapped in `_latched`. */
  async function _repairRow(row: DistListRow): Promise<void> {
    await _latched(async () => {
      const plant = Store.selectedPlant;
      if (!plant || Sandbox.active) return;
      const guard = _captureWriteGuard(plant, [row.header]);
      if (!guard) return;
      // D-fix (audit item 2): a purged share's weight (B6 keeps its weight,
      // greyed-out and inert, for display) must still go out as 0 on the
      // wire -- the backend refuses a positive weight on a purged share
      // (400 `share_purged`), the same `resolvedWeight`/`buildSharesPayload`
      // rule the editor's own Save path already follows.
      const shares = (row.shares || []).map(s => ({
        machine: s.machine, weight: (s.purged || s.purged_at) ? 0 : (s.weight ?? 0),
      }));
      try {
        const resp = await Util.fetchTraced(
          `${API}/distribution/${encodeURIComponent(plant)}/${encodeURIComponent(row.header.production_order)}/${encodeURIComponent(row.header.material_number)}/shares`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ shares, base_version: row.header.base_version }),
          },
        );
        if (!resp.ok) {
          const err = await _parseDistError(resp);
          if (err.code === 'stale') { await _fetchAndRenderList(); Toast.show(Util.t('toast.dist_stale_refetched'), 'warn'); return; }
          Toast.show(_distErrorMessage(err.code, err.message), 'error');
          return;
        }
        const result = await resp.json() as WriteResult;
        if (!_applyWriteResult(result, guard)) return;
        Toast.show(Util.t('toast.dist_repaired'), 'success');
        await _fetchAndRenderList();
        if (_selectedKey === _rowKey(row.header)) void _openDetail(_selectedKey);
        void loadDistributionSummary();
      } catch (e) {
        ErrorLog.error('distribution', `Repair failed: ${(e as Error).message}`, {}, { errorCode: 'distribution.repair_failed' });
        Toast.show(Util.t('toast.dist_repair_failed'), 'error');
      }
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

  // D48 (part 2) — one AbortController per LIVE container for _mkCombobox's
  // document-level click listener, keyed by the container element rather
  // than a single module-level slot: this pane currently mounts only one
  // combobox at a time, but a single shared controller is still wrong in
  // general — it would abort a SIBLING combobox's still-mounted listener the
  // moment a second one renders on the same gate (the fix-round-1 defect
  // found in master-data/admin-ui.mts's BOM plant/material pickers and
  // plant-settings line-override pickers, which really do render two at
  // once). Re-rendering into the SAME container still aborts that
  // container's own previous listener, via the WeakMap lookup. Keep this
  // mirrored in setup-admin.mts / master-data/admin-ui.mts's copies.
  const _comboAborts = new WeakMap<HTMLElement, AbortController>();

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
    _comboAborts.get(containerEl)?.abort();
    const _comboAbort = new AbortController();
    _comboAborts.set(containerEl, _comboAbort);
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
    document.addEventListener('click', (e) => { if (!root.contains(e.target as Node)) closeDd(); }, { signal: _comboAbort.signal });

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
    _renderBulkBar();
    if (chip) {
      if (_batch) {
        chip.hidden = false;
        chip.innerHTML = `${Util.escapeHtml(Util.t('ui.dist_batch_chip', { when: _batch.label }))} <span class="dist-batch-chip-x" role="button" aria-label="${Util.escapeHtml(Util.t('aria.dist_remove'))}">&times;</span>`;
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
      // D13 — one line surfacing a server-side truncated result set (the
      // list is only showing the oldest N matching headers).
      const truncatedNotice = _truncated
        ? `<div class="dist-list-truncated-notice">${Util.escapeHtml(Util.t('ui.dist_list_truncated'))}</div>` : '';
      footer.innerHTML = `
        ${truncatedNotice}
        <span class="dist-list-count">${Util.escapeHtml(Util.t('ui.dist_showing_count', { shown: String(shown), total: String(_total) }))}</span>
        ${hasMore ? `<button type="button" class="btn btn-ghost sm" id="dist-load-more">${Util.escapeHtml(Util.t('btn.load_more'))}</button>` : ''}`;
      document.getElementById('dist-load-more')?.addEventListener('click', () => {
        // Fix round 1: a refresh (_fetchAndRenderList) already in flight has
        // its own, up-to-date idea of how many pages are loaded and will
        // re-render the footer (and this button) itself when it completes —
        // racing a "Load more" against it would increment _page on top of
        // whatever the in-flight refresh is about to resolve to, and append
        // onto rows the refresh may be about to replace outright.
        if (_loading) return;
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
    // D26 — captured (not bumped): a newer _fetchAndRenderList (or another
    // plant switch) mid-flight must still drop this "Load more" response.
    const seq = _listSeq;
    const stillCurrent = (): boolean => seq === _listSeq && Store.selectedPlant === plant;
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
      if (!stillCurrent()) return;
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as DistListResponse;
      if (!stillCurrent()) return;
      _rows = _rows.concat(data.data || []);
      _total = data.meta?.total ?? _rows.length;
      _truncated = data.meta?.truncated === true;
      _pruneCheckedKeys();
    } catch (e) {
      if (!stillCurrent()) return;
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
    // What-If guard (D05): the badge's one-click action and the Reviewed
    // checkbox both resolve to a gated handler (_markReviewed/_repairRow/
    // _onSaveScheduleClick all check Sandbox.active themselves), but the row
    // also needs to LOOK blocked — a `disabled` modifier class (badges are
    // `<span>`s, which have no native `disabled` attribute) plus the same
    // `ui.dist_whatif_blocked` hint text used elsewhere in this pane,
    // surfaced here as the badge's tooltip rather than a per-row span (one
    // per data row would be noisy at the 50+ rows this list can hold).
    const whatIf = Sandbox.active;
    const badgeTitle = whatIf ? Util.t('ui.dist_whatif_blocked') : Util.t(`ui.dist_status_${primary.code}_tip`);
    return `
      <tr data-key="${Util.escapeHtml(key)}" class="dist-row${active ? ' active' : ''}">
        <td class="dist-col-check"><input type="checkbox" class="dist-bulk-check" aria-label="${Util.escapeHtml(Util.t('aria.dist_select_row', { order: row.header.production_order }))}" ${_checkedKeys.has(key) ? 'checked' : ''}></td>
        <td title="${Util.escapeHtml(String(row.header.sap_facts?.order_category ?? ''))}">${Util.escapeHtml(row.header.production_order)}</td>
        <td>${Util.escapeHtml(row.header.material_number)}</td>
        <td>${Util.escapeHtml(row.header.sap_workcenter || '')}</td>
        <td>${row.header.order_quantity ?? ''}</td>
        <td>${Util.escapeHtml(Util.fmtDT(row.header.basic_start_date))}</td>
        <td>${Util.escapeHtml(formatSubOrders(row.shares))}</td>
        <td>
          ${primary.code ? `<span class="sap-pill ${primary.tier} dist-badge-action${whatIf ? ' disabled' : ''}" title="${Util.escapeHtml(badgeTitle)}">${Util.escapeHtml(badgeText)}</span>` : ''}
          ${extraBadge}
        </td>
        <td><input type="checkbox" class="dist-reviewed-check"
              ${revState === 'checked' ? 'checked' : ''}
              data-indeterminate="${revState === 'indeterminate' ? '1' : '0'}"
              ${whatIf ? 'disabled' : ''}></td>
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

  /** D47 — identify the currently-focused editor input (if any) inside the
   *  detail pane, as a {machine, cls} pair `_renderDetail` can re-find after
   *  it replaces the whole panel's innerHTML (which otherwise unconditionally
   *  drops focus, even mid-keystroke on a debounced dry-run settle). Prefers
   *  `_pendingDetailFocusTarget` when the qty-blur handler set it (its value
   *  there is authoritative, including an explicit `null` meaning "blurring
   *  to outside the pane — don't restore"); otherwise falls back to reading
   *  `document.activeElement` directly, covering every other call site
   *  (`_runDryRun`'s settle, the write-busy latch, sandbox toggle, etc.). */
  function _consumeFocusRestoreTarget(pane: HTMLElement): { machine: string; cls: string } | null {
    const hintProvided = _pendingDetailFocusTarget !== undefined;
    const candidate = hintProvided ? _pendingDetailFocusTarget : (document.activeElement as HTMLElement | null);
    _pendingDetailFocusTarget = undefined;
    if (!candidate || !pane.contains(candidate)) return null;
    const row = candidate.closest('tr[data-machine]') as HTMLElement | null;
    const machine = row?.dataset.machine;
    if (!machine) return null;
    if (candidate.matches('.dist-weight-input')) return { machine, cls: 'dist-weight-input' };
    if (candidate.matches('.dist-qty-input')) return { machine, cls: 'dist-qty-input' };
    return null;
  }

  function _renderDetail(): void {
    const el = document.getElementById('dist-detail-pane');
    if (!el) return;
    const focusTarget = _consumeFocusRestoreTarget(el);
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
      ${_renderSharesEditor()}`;
    // Checkbox `indeterminate` is a DOM property, not a declarative HTML
    // attribute — same two-step convention _renderList() uses.
    const reviewedToggle = document.getElementById('dist-reviewed-toggle') as HTMLInputElement | null;
    if (reviewedToggle) reviewedToggle.indeterminate = reviewedToggle.dataset.indeterminate === '1';
    // D47 — restore focus (not caret: these are type="number" inputs) onto
    // the equivalent freshly-rendered input, if the row/column it belonged to
    // still exists in the new markup.
    if (focusTarget) {
      const row = el.querySelector(`tr[data-machine="${CSS.escape(focusTarget.machine)}"]`);
      const input = row?.querySelector<HTMLElement>(`.${focusTarget.cls}`);
      input?.focus();
    }
  }

  /** P2-16 — the shares editor body (`#dist-shares-editor-placeholder`'s
   *  replacement), aggregate_to_detail.md §6 "The shares editor (decision K)".
   *  Built over the pure functions in `shares-editor.mts`; this function and
   *  `_renderEditorRow` are the only DOM-facing glue around them. */
  function _renderSharesEditor(): string {
    if (!_detail) return '';
    const h = _detail.header;
    const rows = _editorRows();
    const view = mergeRowsWithDryRun(rows, _dryRun);
    const totals = computeTotals(view, h.order_quantity);
    const whatIf = Sandbox.active;
    const sig = dryRunSignature(h, rows);
    const saveState = computeSaveButtonState({
      dryRunStatus: _dryRunStatus, dryRunSignature: _dryRunSignature, currentSignature: sig,
      removedScheduledCount: _dryRun?.removed_scheduled?.length || 0, whatIfBlocked: whatIf,
    });
    const undoDisabled = whatIf || isUndoDisabled(_lastWrite?.baseVersionAfterWrite ?? null, h.base_version);
    const revState = reviewedCheckboxState(h, _detail.statuses);
    const saveLabel = Util.t(saveState.labelKey, { n: String(saveState.removedCount) });
    // Decision H: quantity shares round UP, so the settled total can run over
    // SAP's order_quantity by under one piece per extra sub-order. Flag it
    // next to the TOTAL qty cell; it never blocks Save.
    const qtyDelta = totals.qtyDeltaVsSap;
    const qtyDeltaHtml = (qtyDelta != null && qtyDelta !== 0)
      ? ` <span class="dist-editor-total-qty-delta" title="${Util.escapeHtml(Util.t('ui.dist_editor_total_qty_vs_sap', { delta: (qtyDelta > 0 ? '+' : '') + String(qtyDelta), sap: String(h.order_quantity ?? '') }))}">(${qtyDelta > 0 ? '+' : ''}${qtyDelta})</span>`
      : '';

    return `
      <div class="dist-editor" id="dist-editor">
        <table class="dist-editor-table" id="dist-editor-table">
          <thead>
            <tr>
              <th>${Util.escapeHtml(Util.t('ui.dist_editor_col_letter'))}</th>
              <th>${Util.escapeHtml(Util.t('ui.dist_editor_col_machine'))}</th>
              <th>${Util.escapeHtml(Util.t('ui.dist_editor_col_weight'))}</th>
              <th>${Util.escapeHtml(Util.t('ui.dist_editor_col_effective'))}</th>
              <th>${Util.escapeHtml(Util.t('ui.dist_editor_col_qty_after'))}</th>
              <th>${Util.escapeHtml(Util.t('ui.dist_editor_col_hours_after'))}</th>
              <th>${Util.escapeHtml(Util.t('ui.dist_editor_col_start'))}</th>
              <th>${Util.escapeHtml(Util.t('ui.dist_editor_col_outcome'))}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${view.map(r => _renderEditorRow(r)).join('')}</tbody>
          <tfoot>
            <tr class="dist-editor-total-row">
              <td colspan="2">${Util.escapeHtml(Util.t('ui.dist_editor_total'))}</td>
              <td>${new Intl.NumberFormat(Util.locale(), { maximumFractionDigits: 3 }).format(totals.weight)}</td>
              <td>${totals.effectivePct.toFixed(1)}%</td>
              <td>${totals.qtyAfter}${qtyDeltaHtml}</td>
              <td>${totals.hoursAfter.toFixed(2)}</td>
              <td colspan="3"></td>
            </tr>
          </tfoot>
        </table>
        <div class="dist-editor-actions">
          <button type="button" class="btn btn-ghost sm" id="dist-editor-even-btn" ${whatIf ? 'disabled' : ''}>${Util.escapeHtml(Util.t('btn.dist_even'))}</button>
          <button type="button" class="btn btn-primary" id="dist-save-btn" ${saveState.disabled || _writeBusy ? 'disabled' : ''}>${Util.escapeHtml(saveLabel)}</button>
          <label class="dist-reviewed-toggle-label">
            <input type="checkbox" id="dist-reviewed-toggle"
                   ${revState === 'checked' ? 'checked' : ''}
                   data-indeterminate="${revState === 'indeterminate' ? '1' : '0'}"
                   ${whatIf ? 'disabled' : ''}>
            ${Util.escapeHtml(Util.t('ui.dist_col_reviewed'))}
          </label>
          <button type="button" class="btn btn-ghost sm" id="dist-reset-btn" ${whatIf || _writeBusy ? 'disabled' : ''}>${Util.escapeHtml(Util.t('btn.dist_reset_defaults'))}</button>
          <button type="button" class="btn btn-ghost sm" id="dist-undo-btn" ${undoDisabled || _writeBusy ? 'disabled' : ''}>${Util.escapeHtml(Util.t('btn.dist_undo'))}</button>
          <button type="button" class="btn btn-ghost sm" id="dist-show-gantt-btn">${Util.escapeHtml(Util.t('btn.dist_show_on_gantt'))}</button>
          <button type="button" class="btn btn-ghost sm" id="dist-open-inspector-btn">${Util.escapeHtml(Util.t('btn.dist_open_inspector'))}</button>
          ${whatIf ? `<span class="dist-whatif-hint">${Util.escapeHtml(Util.t('ui.dist_whatif_blocked'))}</span>` : ''}
        </div>
        ${_banner ? _renderReconcileBanner() : ''}
      </div>`;
  }

  function _renderEditorRow(r: EditorRowView): string {
    const byQty = _editorByQty.has(r.machine);
    const outcomeLabel = r.outcome ? Util.t(`ui.dist_outcome_${r.outcome}`) : '';
    const markers: string[] = [];
    if (r.frozen) markers.push(Util.t('ui.dist_marker_frozen'));
    if (r.stale) markers.push(Util.t('ui.dist_marker_stale'));
    if (r.purged) markers.push(Util.t('ui.dist_marker_purged'));
    if (r.belowMinLot) markers.push(Util.t('ui.dist_marker_below_min_lot'));
    const qtyDraft = _editorQtyDraft[r.machine];
    const weightVal = r.weight == null ? '' : String(r.weight);
    const qtyVal = qtyDraft !== undefined ? qtyDraft : (r.qtyAfter != null ? String(r.qtyAfter) : '');
    const whatIf = Sandbox.active;
    const disabled = r.purged || whatIf;
    return `
      <tr class="dist-editor-row${r.purged ? ' dist-row-purged' : ''}" data-machine="${Util.escapeHtml(r.machine)}">
        <td>${r.letter ? Util.escapeHtml(r.letter) : ''}</td>
        <td>${Util.escapeHtml(r.machine)}${r.purged ? ` <span class="dist-row-no-suborder">${Util.escapeHtml(Util.t('ui.dist_no_suborder'))}</span>` : ''}</td>
        <td>${byQty
          ? `<input type="number" class="input dist-qty-input" aria-label="${Util.escapeHtml(Util.t('aria.dist_qty_input', { machine: r.machine }))}" min="0" step="any" value="${Util.escapeHtml(qtyVal)}" ${disabled ? 'disabled' : ''}>`
          : `<input type="number" class="input dist-weight-input" aria-label="${Util.escapeHtml(Util.t('aria.dist_weight_input', { machine: r.machine }))}" min="0" step="any" placeholder="1" value="${Util.escapeHtml(weightVal)}" ${disabled ? 'disabled' : ''}>`}
        </td>
        <td>${r.effectivePct != null ? r.effectivePct.toFixed(1) + '%' : ''}</td>
        <td>${r.qtyAfter != null ? r.qtyAfter : ''}</td>
        <td>${r.hoursAfter != null ? r.hoursAfter.toFixed(2) : ''}</td>
        <td>${Util.escapeHtml(Util.fmtDT(r.currentStart))}</td>
        <td>${Util.escapeHtml(outcomeLabel)}${markers.length ? ' · ' + markers.map(m => Util.escapeHtml(m)).join(', ') : ''}</td>
        <td>
          <button type="button" class="btn btn-ghost sm dist-row-only" ${disabled ? 'disabled' : ''}>${Util.escapeHtml(Util.t('btn.dist_only_this_machine'))}</button>
          <button type="button" class="btn btn-ghost sm dist-row-byqty-toggle" ${disabled ? 'disabled' : ''}>${Util.escapeHtml(byQty ? Util.t('btn.dist_by_weight') : Util.t('btn.dist_by_quantity'))}</button>
        </td>
      </tr>`;
  }

  /** §6 "Save flow" reconcile banner — `.dist-banner`, deliberately NOT a
   *  toast (it stays visible with two actions until dismissed by one of
   *  them). */
  function _renderReconcileBanner(): string {
    if (!_banner) return '';
    const whatIf = Sandbox.active;
    const firmedList = _banner.firmedIds.length
      ? `<div class="dist-banner-firmed">${Util.escapeHtml(Util.t('ui.dist_banner_firmed_left', { n: String(_banner.firmedIds.length) }))}</div>`
      : '';
    return `
      <div class="dist-banner" id="dist-reconcile-banner">
        <div class="dist-banner-text">${Util.escapeHtml(Util.t('ui.dist_saved_reconcile', { n: String(_banner.count) }))}</div>
        ${firmedList}
        <div class="dist-banner-actions">
          <button type="button" class="btn btn-primary sm" id="dist-banner-save-schedule" ${whatIf ? 'disabled' : ''}>${Util.escapeHtml(Util.t('btn.dist_save_schedule'))}</button>
          <button type="button" class="btn btn-ghost sm" id="dist-banner-undo" ${whatIf ? 'disabled' : ''}>${Util.escapeHtml(Util.t('btn.undo'))}</button>
          ${whatIf ? `<span class="dist-whatif-hint">${Util.escapeHtml(Util.t('ui.dist_whatif_blocked'))}</span>` : ''}
        </div>
      </div>`;
  }

  /** Lightweight in-place Save-button refresh, used after every keystroke so
   *  Save disables immediately without waiting for the debounced dry run and
   *  without re-rendering (and stealing focus from) the row the planner is
   *  typing into. */
  function _renderSaveState(): void {
    if (typeof document === 'undefined') return;
    const btn = document.getElementById('dist-save-btn') as HTMLButtonElement | null;
    if (!btn || !_detail) return;
    const rows = _editorRows();
    const sig = dryRunSignature(_detail.header, rows);
    const state = computeSaveButtonState({
      dryRunStatus: _dryRunStatus, dryRunSignature: _dryRunSignature, currentSignature: sig,
      removedScheduledCount: _dryRun?.removed_scheduled?.length || 0, whatIfBlocked: Sandbox.active,
    });
    btn.disabled = state.disabled || _writeBusy;
    btn.textContent = Util.t(state.labelKey, { n: String(state.removedCount) });
  }

  return { init, render, setActive };
})();
