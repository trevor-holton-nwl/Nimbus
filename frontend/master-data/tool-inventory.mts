// tool-inventory.mts — Master Data > Tool Inventory sub-tab (plant-scoped, planner-editable).
//
// A tool id is a TYPE: the plant owns `total_qty` interchangeable copies and `out_of_service_qty` of them
// cannot be used (available = max(0, total - out of service)); a tool with no row counts as 1 copy. This
// grid edits ONE plant's rows and saves them with ONE POST /tool-inventory/{plant}/bulk (upserts + deletes
// in a single transaction, last write wins).
//
// Unlike MaterialGrids (update-only, rows fetched by the grid itself) this module ADDS and DELETES rows and
// reads its saved rows from `Store.masterData.tool_inventory` (Persistence owns the fetch, the freshness
// probe and the keep-on-failure rule; `undefined` there means "not loaded", never "empty"). Edits are held
// as a per-plant draft (rows + staged deletes) so a plant switch never loses them. The grid uses a client
// row id (`_cid`) as getRowId, never the typed Tool ID, so renaming a not-yet-saved row is cheap; once a row
// is saved its Tool ID is locked (no rename: remove it and add the new id in the same save).
//
// The pane's DOM is built here (index.html only carries the empty pane and its sub-tab button), mirroring
// the on-demand-innerHTML convention of the Work Centers pane. No inline handlers: every listener is bound
// with addEventListener.
/* global agGrid */
import { Config, Util, ErrorLog, Toast, Modal } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import { Persistence } from '../scheduling/persistence.mjs';
import { Sandbox } from '../optimization/sandbox.mjs';
import { refreshStoreMasterData, TOOLING_RULE_CONTROL_READY, Plant } from './admin-ui.mjs';
import type { NimbusToolInventoryRow } from '../platform/types.mjs';

// -- Local contract -----------------------------------------------------------

const PANE_ID = 'md-master-tool-inventory-pane';
const TOOL_ID_MAX_LEN = 100;           // master_data.TOOL_ID_MAX_LEN
const NOTE_MAX_LEN = 500;              // master_data.TOOL_NOTE_MAX_LEN
const QTY_MAX = 1_000_000;             // master_data.TOOL_QTY_MAX
const QUICK_DEBOUNCE_MS = 250;
const ALERT_WATCH_MS = 3000;

/** Mirror of NimbusComputeCore.TOOL_PLACEHOLDERS / backend TOOL_PLACEHOLDERS (a test pins this copy to the core's). */
export const TOOL_PLACEHOLDERS: ReadonlySet<string> = new Set(['', '-', '0', 'N/A', 'NONE', 'NULL', 'NAN', 'TBD']);

/** Trimmed, upper-cased tool id; null for blank / placeholder (same rule as NimbusComputeCore.normalizeToolId). */
export function normalizeToolId(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  return TOOL_PLACEHOLDERS.has(s) ? null : s;
}

type FilterMode = 'all' | 'oos' | 'available_zero' | 'total_not_one' | 'unused' | 'used_no_row' | 'in_use_now';
type ViewState = 'noplant' | 'loading' | 'failed' | 'ready';

interface SavedValues { total_qty: number; out_of_service_qty: number; note: string }

interface TiRow {
  _cid: string;
  tool_id: string;
  total_qty: unknown;            // raw cell value: an int once parsed, the typed text while invalid
  out_of_service_qty: unknown;
  note: string;
  _isNew: boolean;
  _orig: SavedValues | null;     // the saved values this row was loaded from (null while new)
}

interface TiDelete { tool_id: string; orig: SavedValues }

interface TiDraft { rows: TiRow[]; deletes: TiDelete[] }

interface FieldErrors { tool_id?: string; total_qty?: string; out_of_service_qty?: string; note?: string }

interface UsageEntry { count: number; orders: string[] }

interface TiState {
  plant: string | null;
  view: ViewState;
  rows: TiRow[];
  deletes: TiDelete[];
  ref: NimbusToolInventoryRow[] | undefined;   // the Store array last adopted (identity = "unchanged")
  readOnly: boolean;
  writing: boolean;
  serverProblems: string[];
  filter: FilterMode;
  quick: string;
  usedBy: Map<string, number>;
  inUseNow: Set<string>;                       // ids carried by an order whose tool occupancy covers the current time
  errors: Map<string, FieldErrors> | null;
}

// -- Module state --------------------------------------------------------------

let _cidSeq = 0;
const _drafts = new Map<string, TiDraft>();
let _pendingQuick: string | null = null;
let _subscribed = false;
let _quickTimer: ReturnType<typeof setTimeout> | undefined;

/** ONE AG Grid for the module lifetime (like MaterialGrids): a plant switch only replaces its rowData, so the
 *  grid can never be stacked on #ti-grid and its callbacks always read the CURRENT `_st`. */
let _gridApi: NimbusVendor.AgGridApi | null = null;
let _gridCreated = false;
let _recheckTimer: ReturnType<typeof setTimeout> | undefined;
let _recheckCount = 0;
const RECHECK_MS = 400;
const RECHECK_MAX = 150;

/** A fresh per-plant state. The filter select + quick filter are view preferences of the (single) grid and carry over. */
function _blank(prev?: TiState): TiState {
  return {
    plant: null, view: 'noplant', rows: [], deletes: [], ref: undefined, readOnly: false, writing: false,
    serverProblems: [], filter: prev?.filter ?? 'all', quick: prev?.quick ?? '', usedBy: new Map(), inUseNow: new Set(), errors: null,
  };
}
let _st: TiState = _blank();

/** Test seams: the Store refresh and the usage/bulk transport are the only things tests need to swap. */
export const _seams = {
  refreshStoreMasterData: (source: string, table?: string): Promise<boolean> => refreshStoreMasterData(source, table),
  /** Blob + temporary anchor download (the missing-master-data CSV precedent in admin-ui.mts). */
  saveBlob: (blob: Blob, name: string): void => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
};

/** A template/export/upload request is in flight (module-wide: one Excel round trip at a time). */
let _busy = false;
const REVIEW_ID = 'modal-tool-inventory-review';
const REVIEW_CAP = 200;
const WARNINGS_CAP = 10;

// -- Pure helpers ---------------------------------------------------------------

function _el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** Trim + upper-case a typed id (placeholders are NOT blanked here: the validator reports them). */
const _INVISIBLES = /[\u200b\u200c\u200d\u2060\ufeff\u00a0]/g;
function _typedId(v: unknown): string {
  if (v == null) return '';
  let s = String(v).replace(_INVISIBLES, '').trim();      // zero-width / nbsp would create phantom ids (the server strips them too)
  if (s.endsWith('.0') && /^-?\d+$/.test(s.slice(0, -2))) s = s.slice(0, -2);   // numeric float suffix, like the server
  return s.toUpperCase();
}

/** A whole number 0..QTY_MAX from a cell value, or null when it is not one (blank is null too). */
function _parseQty(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= QTY_MAX ? v : null;
  if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) {
    const n = Number(v.trim());
    return n <= QTY_MAX ? n : null;
  }
  return null;
}

function _oosOf(r: TiRow): number | null {
  const v = r.out_of_service_qty;
  if (v == null || (typeof v === 'string' && !v.trim())) return 0;   // blank = 0 (server rule)
  return _parseQty(v);
}

function _availableOf(r: TiRow): number | null {
  const total = _parseQty(r.total_qty);
  const oos = _oosOf(r);
  return total == null || oos == null ? null : Math.max(0, total - oos);
}

function _origOf(s: NimbusToolInventoryRow): SavedValues {
  return { total_qty: Number(s.total_qty), out_of_service_qty: Number(s.out_of_service_qty), note: String(s.note ?? '') };
}

function _rowFromSaved(s: NimbusToolInventoryRow): TiRow {
  const o = _origOf(s);
  return { _cid: `ti-${++_cidSeq}`, tool_id: String(s.tool_id), total_qty: o.total_qty, out_of_service_qty: o.out_of_service_qty,
    note: o.note, _isNew: false, _orig: o };
}

function _newRow(): TiRow {
  // NEW_ROW_DEFAULTS: one copy, none out of service.
  return { _cid: `ti-${++_cidSeq}`, tool_id: '', total_qty: 1, out_of_service_qty: 0, note: '', _isNew: true, _orig: null };
}

function _rowChanged(r: TiRow): boolean {
  if (r._isNew || !r._orig) return true;
  return _parseQty(r.total_qty) !== r._orig.total_qty
    || _oosOf(r) !== r._orig.out_of_service_qty
    || String(r.note ?? '').trim() !== r._orig.note;
}

/** A saved id that was staged for delete and re-added with exactly its saved values: a no-op (untouched). */
function _isIdenticalReAdd(r: TiRow, st: TiState): boolean {
  if (!r._isNew) return false;
  const id = _typedId(r.tool_id);
  const d = st.deletes.find(x => x.tool_id === id);
  if (!d) return false;
  return _parseQty(r.total_qty) === d.orig.total_qty && _oosOf(r) === d.orig.out_of_service_qty && String(r.note ?? '').trim() === d.orig.note;
}

function _dirtyCount(st: TiState = _st): number {
  const ids = new Set(st.rows.map(r => _typedId(r.tool_id)));
  // A staged delete whose id is back as a row is one edit (counted on the row), or none when the values are identical.
  return st.rows.filter(r => _rowChanged(r) && !_isIdenticalReAdd(r, st)).length + st.deletes.filter(d => !ids.has(d.tool_id)).length;
}

function _isDirty(st: TiState = _st): boolean { return _dirtyCount(st) > 0; }

/** Per-field validation of every row, cached until the next edit. Duplicates are case-insensitive across saved + new rows
 *  (a staged delete is not a row, so a re-added id never collides with its own old row). */
function _validate(): Map<string, FieldErrors> {
  if (_st.errors) return _st.errors;
  const counts = new Map<string, number>();
  for (const r of _st.rows) {
    const id = _typedId(r.tool_id);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const out = new Map<string, FieldErrors>();
  for (const r of _st.rows) {
    const e: FieldErrors = {};
    const id = _typedId(r.tool_id);
    if (!id) e.tool_id = Util.t('ui.tool_inventory_invalid_id_required');
    else if (TOOL_PLACEHOLDERS.has(id)) e.tool_id = Util.t('ui.tool_inventory_invalid_id_placeholder', { id });
    else if (id.length > TOOL_ID_MAX_LEN) e.tool_id = Util.t('ui.tool_inventory_invalid_id_length', { max: TOOL_ID_MAX_LEN });
    else if ((counts.get(id) ?? 0) > 1) e.tool_id = Util.t('ui.tool_inventory_duplicate', { id });
    const total = _parseQty(r.total_qty);
    const oos = _oosOf(r);
    const qtyMsg = Util.t('ui.tool_inventory_invalid_qty', { max: QTY_MAX.toLocaleString('en-US') });
    if (total == null) e.total_qty = qtyMsg;
    if (oos == null) e.out_of_service_qty = qtyMsg;
    else if (total != null && oos > total) e.out_of_service_qty = Util.t('ui.tool_inventory_oos_exceeds_total', { oos, total });
    if (String(r.note ?? '').trim().length > NOTE_MAX_LEN) e.note = Util.t('ui.tool_inventory_invalid_note', { max: NOTE_MAX_LEN });
    if (e.tool_id || e.total_qty || e.out_of_service_qty || e.note) out.set(r._cid, e);
  }
  _st.errors = out;
  return out;
}

function _hasInvalid(): boolean { return _validate().size > 0; }

function _canEdit(): boolean {
  return _st.view === 'ready' && !!_st.plant && !_st.readOnly && !Sandbox.active;
}

function _canSave(): boolean {
  return _canEdit() && !_st.writing && _isDirty() && !_hasInvalid();
}

/** Orders of the loaded window per tool id (either PRT column, one count per order), built once per render. */
function _buildUsedBy(plant: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of Store.tasksByPlant(plant)) {
    const seen = new Set<string>();
    for (const raw of [t.PRT_01, t.PRT_02]) {
      const id = normalizeToolId(raw);
      if (id && !seen.has(id)) { seen.add(id); m.set(id, (m.get(id) ?? 0) + 1); }
    }
  }
  return m;
}

/** Ids carried by an order whose tool occupancy covers `now` (run-time envelope via the compute core when reachable,
 *  else the order's own start/end). Rebuilt on render, on tasks:bulk and when the filter is chosen. */
function _buildInUseNow(plant: string, now: number = Date.now()): Set<string> {
  const out = new Set<string>();
  const core = (globalThis as { NimbusComputeCore?: { toolOccupancyInterval?: (t: unknown) => { start: Date; end: Date } | null } }).NimbusComputeCore;
  for (const t of Store.tasksByPlant(plant)) {
    const ids: string[] = [];
    for (const raw of [t.PRT_01, t.PRT_02]) { const id = normalizeToolId(raw); if (id && !ids.includes(id)) ids.push(id); }
    if (!ids.length) continue;
    let s: number, e: number;
    const iv = core?.toolOccupancyInterval?.(t);
    if (iv) { s = +iv.start; e = +iv.end; } else { s = Date.parse(String(t.start_date ?? '')); e = Date.parse(String(t.end_date ?? '')); }
    if (Number.isFinite(s) && Number.isFinite(e) && s <= now && now < e) for (const id of ids) out.add(id);
  }
  return out;
}

/** Tools carried by the loaded orders that have no row and no draft (a staged delete is a deliberate removal: skipped). */
function _missingInUse(): string[] {
  const have = new Set(_st.rows.map(r => _typedId(r.tool_id)));
  for (const d of _st.deletes) have.add(d.tool_id);
  return [..._st.usedBy.keys()].filter(id => !have.has(id)).sort();
}

function _toolAlertCount(plant: string | null = null): number {
  return Store.alerts.filter(a => {
    if (a.type !== 'tool-conflict') return false;
    const ap = (a as { plant?: string }).plant;
    return !plant || !ap || ap === plant;
  }).length;
}

function _savedRows(): NimbusToolInventoryRow[] | undefined {
  return Store.masterData?.tool_inventory;
}

function _toolingRule(): 'off' | 'hard' {
  const row = Store.masterData?.plants?.find(p => p.plant === _st.plant);
  return row?.setup_policy_config?.toolingRule === 'hard' ? 'hard' : 'off';
}

function _call(api: NimbusVendor.AgGridApi | null, name: string, ...args: unknown[]): unknown {
  try { return (api as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined> | null)?.[name]?.(...args); } catch { return undefined; }
}

// -- State load / rebase --------------------------------------------------------

/** Re-anchor rows + staged deletes on a fresh saved list (last write wins). A field the user did not touch follows the
 *  server; a field they edited keeps their value; a row the server no longer has is dropped when untouched and kept as a new row when edited;
 *  a staged delete of a vanished row is dropped; server rows the draft has never seen are appended clean. */
function _rebase(rows: TiRow[], deletes: TiDelete[], saved: NimbusToolInventoryRow[]): { rows: TiRow[]; deletes: TiDelete[] } {
  const byId = new Map(saved.map(s => [String(s.tool_id), s]));
  const used = new Set<string>();
  const nextRows: TiRow[] = [];
  let keptRemoved = 0;
  for (const r of rows) {
    const s = r._isNew ? undefined : byId.get(r.tool_id);
    if (r._isNew) { nextRows.push(r); continue; }
    if (!s || !r._orig) {
      // A saved row another session removed: untouched -> drop it (never resurrect it as a dirty row); edited -> keep as new.
      if (r._orig && !_rowChanged(r)) continue;
      r._isNew = true; r._orig = null; nextRows.push(r); keptRemoved++;
      continue;
    }
    const o = _origOf(s);
    const old = r._orig;
    if (_parseQty(r.total_qty) === old.total_qty) r.total_qty = o.total_qty;
    if (_oosOf(r) === old.out_of_service_qty) r.out_of_service_qty = o.out_of_service_qty;
    if (String(r.note ?? '').trim() === old.note) r.note = o.note;
    r._orig = o;
    used.add(r.tool_id);
    nextRows.push(r);
  }
  const nextDeletes: TiDelete[] = [];
  for (const d of deletes) {
    const s = byId.get(d.tool_id);
    if (!s) continue;
    nextDeletes.push({ tool_id: d.tool_id, orig: _origOf(s) });
    used.add(d.tool_id);
  }
  for (const s of saved) if (!used.has(String(s.tool_id))) nextRows.push(_rowFromSaved(s));
  if (keptRemoved) Toast.show(Util.t('toast.tool_inventory_remote_deleted_kept'), 'warn');
  return { rows: nextRows, deletes: nextDeletes };
}

/** Start a fresh state for `plant`, adopting the Store's rows (and this plant's retained draft) when they are loaded. */
function _adoptPlant(plant: string): void {
  _st = _blank(_st);
  _st.plant = plant;
  _st.usedBy = _buildUsedBy(plant);
  _st.inUseNow = _buildInUseNow(plant);
  _loadFromStore();
}

/** Read Store.masterData.tool_inventory into the state. A fresh plant state (`ref` undefined) also restores the plant's retained draft. */
function _loadFromStore(): void {
  const plant = _st.plant;
  if (!plant) { _st.view = 'noplant'; return; }
  const inv = _savedRows();
  // Rows tagged for another plant are a stale object from before the plant switch finished loading.
  const foreign = !!inv && inv.length > 0 && inv.some(r => r.plant !== plant);
  if (inv === undefined || foreign) {
    if (_st.ref === undefined) {
      // 'failed' only when nothing is loading: during a plant switch / first load Store.masterData exists while the
      // inventory has not arrived yet (undefined = not loaded, never empty).
      const inFlight = Persistence.isLoading() || Persistence._toolInventoryRefreshing.has(plant);
      _st.view = Store.masterData && !foreign && !inFlight ? 'failed' : 'loading';
      if (_st.view === 'loading' && inFlight) _armRecheck(plant);
    }
    return;
  }
  if (inv === _st.ref && _st.view === 'ready') return;
  const draft = _drafts.get(plant);
  if (_st.ref === undefined) {
    if (draft) {
      const r = _rebase(draft.rows, draft.deletes, inv);
      _st.rows = r.rows; _st.deletes = r.deletes;
      _drafts.delete(plant);
      Toast.show(Util.t('toast.tool_inventory_draft_restored', { plant }), 'info');
    } else {
      _st.rows = inv.map(_rowFromSaved);
      _st.deletes = [];
    }
  } else {
    const r = _rebase(_st.rows, _st.deletes, inv);
    _st.rows = r.rows; _st.deletes = r.deletes;
  }
  _st.ref = inv;
  _st.view = 'ready';
  _st.errors = null;
}

/** A load that ends WITHOUT rows emits nothing, so poll (bounded) until the in-flight load finishes and re-decide loading vs failed. */
function _armRecheck(plant: string): void {
  if (_recheckTimer) return;
  _recheckTimer = setTimeout(() => {
    _recheckTimer = undefined;
    if (_st.plant !== plant || _st.view !== 'loading') { _recheckCount = 0; return; }
    if (++_recheckCount > RECHECK_MAX) { _recheckCount = 0; _st.view = 'failed'; _showState(); _updateChrome(); return; }
    if (_paneVisible()) ToolInventory.render(); else _loadFromStore();
  }, RECHECK_MS);
  (_recheckTimer as unknown as { unref?: () => void }).unref?.();
}

/** Keep the plant's unsaved edits across a plant switch (rows are ready only once loaded; a draft on a never-loaded state is empty). */
function _retainDraft(): void {
  if (_st.plant && _st.view === 'ready' && _isDirty()) _drafts.set(_st.plant, { rows: _st.rows, deletes: _st.deletes });
}

// -- DOM ---------------------------------------------------------------------

function _paneHtml(): string {
  const t = (k: string): string => Util.escapeHtml(Util.t(k));
  const opt = (v: FilterMode, k: string): string => `<option value="${v}">${t(k)}</option>`;
  return `
    <div class="table-toolbar ti-toolbar">
      <input id="ti-quick" class="input" type="search" autocomplete="off"
             placeholder="${t('ph.quick_filter_tools')}" aria-label="${t('ph.quick_filter_tools')}">
      <select id="ti-filter" class="input ti-filter" aria-label="${t('ui.tool_inventory_filter_label')}">
        ${opt('all', 'filter.tool_all')}${opt('oos', 'filter.tool_oos')}${opt('available_zero', 'filter.tool_available_zero')}
        ${opt('total_not_one', 'filter.tool_total_not_one')}${opt('unused', 'filter.tool_unused')}
        ${opt('used_no_row', 'filter.tool_used_no_row')}${opt('in_use_now', 'filter.tool_in_use_now')}
      </select>
      <div class="spacer"></div>
      <span class="md-dirty-badge" id="ti-dirty" hidden></span>
      <button type="button" class="btn btn-ghost" id="ti-add">${t('btn.add_row')}</button>
      <button type="button" class="btn btn-ghost" id="ti-add-in-use" title="${t('tip.add_tools_in_use')}">${t('btn.add_tools_in_use')}</button>
      <button type="button" class="btn btn-ghost" id="ti-delete" disabled>${t('btn.delete_selected')}</button>
      <button type="button" class="btn btn-ghost" id="ti-export">${t('btn.export_csv')}</button>
      <button type="button" class="btn btn-ghost" id="ti-template" title="${t('tip.tool_inventory_template')}">${t('btn.download_template')}</button>
      <button type="button" class="btn btn-ghost" id="ti-export-xlsx" title="${t('tip.tool_inventory_export_xlsx')}">${t('btn.download_data')}</button>
      <button type="button" class="btn btn-ghost" id="ti-upload" title="${t('tip.upload_tool_inventory')}">${t('btn.upload_tool_inventory')}</button>
      <input type="file" id="ti-upload-input" accept=".xlsx" hidden tabindex="-1" aria-hidden="true">
      <button type="button" class="btn btn-ghost" id="ti-discard" hidden>${t('btn.discard')}</button>
      <button type="button" class="btn btn-primary" id="ti-save" disabled>${t('btn.save')}</button>
    </div>
    <div class="ti-status" id="ti-status" role="status"></div>
    <div class="ti-hint" id="ti-hint" hidden></div>
    <div class="ti-hint" id="ti-filter-hint" hidden></div>
    <div class="ti-errors" id="ti-errors" role="alert" hidden></div>
    <div class="ti-result" id="ti-upload-result" role="status" aria-live="polite" hidden></div>
    <div class="ti-state" id="ti-state" hidden></div>
    <div id="ti-grid" class="ag-theme-quartz" role="region" aria-label="${t('ui.tool_inventory_grid_label')}"></div>`;
}

function _ensureDom(): boolean {
  const pane = _el(PANE_ID);
  if (!pane) return false;
  if (pane.dataset && pane.dataset.tiReady === '1') return true;
  pane.innerHTML = _paneHtml();
  if (pane.dataset) pane.dataset.tiReady = '1';
  _el('ti-add')?.addEventListener('click', () => ToolInventory._addRow());
  _el('ti-delete')?.addEventListener('click', () => ToolInventory._deleteSelected());
  _el('ti-add-in-use')?.addEventListener('click', () => ToolInventory._addInUse());
  _el('ti-save')?.addEventListener('click', () => { void ToolInventory._save(); });
  _el('ti-discard')?.addEventListener('click', () => { void ToolInventory._discard(); });
  _el('ti-export')?.addEventListener('click', () => {
    try { _gridApi?.exportDataAsCsv({ fileName: `nimbus-tool-inventory-${_st.plant ?? 'plant'}.csv`, processCellCallback: Util.csvProcessCell }); } catch {}
  });
  _el('ti-template')?.addEventListener('click', () => { void _download('template'); });
  _el('ti-export-xlsx')?.addEventListener('click', () => { void _download('export'); });
  _el('ti-upload')?.addEventListener('click', () => { void _pickUpload(); });
  _el<HTMLInputElement>('ti-upload-input')?.addEventListener('change', e => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    try { input.value = ''; } catch {}
    const plant = _st.plant;
    if (file && plant) void _onFilePicked(plant, file);   // a picker cancel never fires 'change': nothing happens
  });
  const quick = _el<HTMLInputElement>('ti-quick');
  quick?.addEventListener('input', () => {
    clearTimeout(_quickTimer);
    _quickTimer = setTimeout(() => ToolInventory.setQuickFilter(quick.value), QUICK_DEBOUNCE_MS);
  });
  _el<HTMLSelectElement>('ti-filter')?.addEventListener('change', e => {
    _st.filter = ((e.target as HTMLSelectElement).value || 'all') as FilterMode;
    if (_st.plant) _st.inUseNow = _buildInUseNow(_st.plant);   // "now" moves on: recompute when the filter is chosen
    _call(_gridApi, 'onFilterChanged');
    _updateChrome();
  });
  return true;
}

/** An empty-state block built here (NIMBUS.EmptyState falls back to its select-a-plant text for an empty message). */
function _stateHtml(title: string, msg?: string, action?: { id: string; label: string }): string {
  return `<div class="nimbus-empty-state"><div class="nes-icon">◨</div><div class="nes-title">${Util.escapeHtml(title)}</div>`
    + (msg ? `<div class="nes-msg">${Util.escapeHtml(msg)}</div>` : '')
    + (action ? `<div class="nes-action"><button type="button" class="btn btn-primary sm" id="${action.id}">${Util.escapeHtml(action.label)}</button></div>` : '')
    + '</div>';
}

function _showState(): void {
  const holder = _el('ti-state');
  const grid = _el('ti-grid');
  if (!holder || !grid) return;
  let html = '';
  let wire: (() => void) | null = null;
  const v = _st.view;
  if (v === 'noplant') html = _stateHtml(Util.t('empty.no_tool_inventory_plant'));
  else if (v === 'loading') html = _stateHtml(Util.t('ui.tool_inventory_loading'));
  else if (v === 'failed') {
    html = _stateHtml(Util.t('ui.tool_inventory_load_failed'), undefined, { id: 'ti-retry', label: Util.t('btn.retry') });
    wire = () => _el('ti-retry')?.addEventListener('click', () => { void ToolInventory._retry(); });
  } else if (!_st.rows.length && !_st.deletes.length) {
    html = _stateHtml(Util.t('empty.no_tool_inventory_rows'), Util.t('empty.no_tool_inventory_rows_msg'),
      _canEdit() ? { id: 'ti-empty-add', label: Util.t('btn.add_row') } : undefined);
    wire = () => _el('ti-empty-add')?.addEventListener('click', () => ToolInventory._addRow());
  }
  holder.hidden = !html;
  holder.innerHTML = html;
  grid.style.display = html ? 'none' : '';
  wire?.();
}

function _updateChrome(): void {
  const ready = _st.view === 'ready';
  const dirty = _dirtyCount();
  const editable = _canEdit();
  const set = (id: string, fn: (el: HTMLElement) => void): void => { const e = _el(id); if (e) fn(e); };
  set('ti-quick', e => { (e as HTMLInputElement).disabled = !ready; });
  set('ti-filter', e => { (e as HTMLSelectElement).disabled = !ready; });
  set('ti-add', e => { (e as HTMLButtonElement).disabled = !editable; });
  set('ti-add-in-use', e => { (e as HTMLButtonElement).disabled = !editable; });
  set('ti-export', e => { (e as HTMLButtonElement).disabled = !ready || !_st.rows.length; });
  set('ti-save', e => { (e as HTMLButtonElement).disabled = !_canSave(); });
  set('ti-template', e => { (e as HTMLButtonElement).disabled = _busy || !_st.plant; });
  set('ti-export-xlsx', e => { (e as HTMLButtonElement).disabled = _busy || !_st.plant; });
  set('ti-upload', e => { (e as HTMLButtonElement).disabled = _busy || _st.writing || !editable; });
  set('ti-discard', e => { e.hidden = dirty === 0; (e as HTMLButtonElement).disabled = _st.writing; });
  set('ti-dirty', e => { e.hidden = dirty === 0; e.textContent = Util.t('ui.n_unsaved', { count: dirty }); });
  set('ti-delete', e => {
    const n = ((_call(_gridApi, 'getSelectedRows') as unknown[] | undefined) ?? []).length;
    (e as HTMLButtonElement).disabled = !editable || n === 0;
  });
  // Status: the tooling rule is shown only once Wave 5's control exists; the alerts sentence is always true.
  const parts: string[] = [];
  if (TOOLING_RULE_CONTROL_READY && _st.plant) parts.push(Util.t(_toolingRule() === 'hard' ? 'ui.tool_inventory_status_hard' : 'ui.tool_inventory_status_off'));
  parts.push(Util.t('ui.tool_inventory_alerts'));
  set('ti-status', e => {
    e.textContent = parts.join(' · ');
    // Same gate as the rule text: the control lives in plant settings, so the link exists only when the control does.
    if (TOOLING_RULE_CONTROL_READY && _st.plant) {
      const link = document.createElement('button');
      link.type = 'button'; link.className = 'btn btn-ghost sm'; link.id = 'ti-rule-link';
      link.textContent = Util.t('ui.tool_inventory_rule_link');
      link.addEventListener('click', () => {
        NIMBUS?.App?.goto?.('masterdata');
        NIMBUS?.App?.gotoMasterSub?.('plant');
        Plant.gotoTab('settings');
      });
      e.append(' ', link);
    }
  });
  // Hint line: one reason at a time, most blocking first.
  let hint = '';
  if (_st.view === 'ready') {
    if (Sandbox.active) hint = Util.t('ui.tool_inventory_sandbox_hint');
    else if (_st.readOnly) hint = Util.t('ui.tool_inventory_readonly');
    else if (_st.deletes.length) {
      const ids = _st.deletes.slice(0, 5).map(d => d.tool_id).join(', ') + (_st.deletes.length > 5 ? ', …' : '');
      hint = Util.t('ui.tool_inventory_staged_deletes', { count: _st.deletes.length, tools: ids });
    }
  }
  set('ti-hint', e => { e.hidden = !hint; e.textContent = hint; });
  // "Used but no row" is select-and-add (no read-only ghost rows): the filter shows the new/draft rows of used tools and this
  // line states how many used tools still have no row, with the Add tools in use action right there.
  set('ti-filter-hint', e => {
    const show = ready && _st.filter === 'used_no_row';
    e.hidden = !show;
    if (!show) { e.textContent = ''; return; }
    const n = _missingInUse().length;
    e.textContent = n ? Util.t('ui.tool_inventory_used_no_row_hint', { count: n }) : Util.t('ui.tool_inventory_used_no_row_none');
    if (n && editable) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn btn-ghost sm'; b.textContent = Util.t('btn.add_tools_in_use');
      b.addEventListener?.('click', () => ToolInventory._addInUse());
      e.appendChild?.(b);
    }
  });
  set('ti-errors', e => {
    e.hidden = !_st.serverProblems.length;
    e.innerHTML = _st.serverProblems.length
      ? `<strong>${Util.escapeHtml(Util.t('ui.tool_inventory_save_problems'))}</strong><ul>${_st.serverProblems.map(p => `<li>${Util.escapeHtml(p)}</li>`).join('')}</ul>`
      : '';
  });
}

// -- Grid ------------------------------------------------------------------------

function _cellMsg(p: { data?: TiRow; colDef?: { field?: string } }): string | undefined {
  const d = p.data;
  const f = p.colDef?.field as keyof FieldErrors | undefined;
  return d && f ? _validate().get(d._cid)?.[f] : undefined;
}

function _mkCellRenderer(field: keyof FieldErrors) {
  return class {
    _gui!: HTMLSpanElement;
    init(p: { data?: TiRow; value: unknown }): void {
      this._gui = document.createElement('span');
      const msg = p.data ? _validate().get(p.data._cid)?.[field] : undefined;
      const text = p.value == null ? '' : String(p.value);
      // Not colour-only: a warning glyph, aria-invalid and the message as the cell's title.
      if (msg) { this._gui.setAttribute('aria-invalid', 'true'); this._gui.title = msg; this._gui.textContent = `⚠ ${text}`; }
      else this._gui.textContent = text;
    }
    getGui(): HTMLSpanElement { return this._gui; }
    refresh(): boolean { return false; }
  };
}

function _columnDefs(): unknown[] {
  const rules = (field: keyof FieldErrors, dirtyOf: (r: TiRow) => boolean): Record<string, (p: { data?: TiRow }) => boolean> => ({
    'md-cell-dirty': p => !!p.data && dirtyOf(p.data),
    'md-cell-invalid': p => !!p.data && !!_validate().get(p.data._cid)?.[field],
  });
  const qtyDirty = (field: 'total_qty' | 'out_of_service_qty') => (r: TiRow): boolean => {
    if (r._isNew || !r._orig) return true;
    const cur = field === 'total_qty' ? _parseQty(r.total_qty) : _oosOf(r);
    return cur !== r._orig[field];
  };
  const qtyCol = (field: 'total_qty' | 'out_of_service_qty', key: string): Record<string, unknown> => ({
    field, headerName: Util.t(key), width: 150, minWidth: 140, type: 'numericColumn',
    editable: (p: { data?: TiRow }) => _canEdit() && !!p.data,
    valueSetter: (p: { data: TiRow; newValue: unknown }) => {
      const raw = typeof p.newValue === 'string' ? p.newValue.trim() : p.newValue;
      const parsed = typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw) : raw;
      if (p.data[field] === parsed) return false;
      p.data[field] = parsed;
      return true;
    },
    cellRenderer: _mkCellRenderer(field),
    cellClassRules: rules(field, qtyDirty(field)),
    tooltipValueGetter: _cellMsg,
  });
  return [
    {
      field: 'tool_id', headerName: Util.t('col.tool_id'), minWidth: 170, flex: 1,
      checkboxSelection: true, sort: 'asc',
      editable: (p: { data?: TiRow }) => _canEdit() && !!p.data?._isNew,
      valueSetter: (p: { data: TiRow; newValue: unknown }) => {
        const next = _typedId(p.newValue);
        if (p.data.tool_id === next) return false;
        p.data.tool_id = next;
        return true;
      },
      cellRenderer: _mkCellRenderer('tool_id'),
      cellClassRules: {
        ...rules('tool_id', r => r._isNew),
        'ti-cell-locked': (p: { data?: TiRow }) => !!p.data && !p.data._isNew,
      },
      tooltipValueGetter: (p: { data?: TiRow; colDef?: { field?: string } }) => _cellMsg(p) ?? (p.data && !p.data._isNew ? Util.t('ui.tool_id_locked_hint') : undefined),
    },
    qtyCol('total_qty', 'col.total_qty'),
    qtyCol('out_of_service_qty', 'col.out_of_service_qty'),
    {
      colId: 'available_qty', headerName: Util.t('col.available_qty'), width: 130, minWidth: 120, type: 'numericColumn',
      valueGetter: (p: { data?: TiRow }) => (p.data ? _availableOf(p.data) : null),
    },
    {
      field: 'note', headerName: Util.t('col.note'), minWidth: 200, flex: 2,
      editable: (p: { data?: TiRow }) => _canEdit() && !!p.data,
      valueSetter: (p: { data: TiRow; newValue: unknown }) => {
        const next = p.newValue == null ? '' : String(p.newValue);
        if (p.data.note === next) return false;
        p.data.note = next;
        return true;
      },
      cellRenderer: _mkCellRenderer('note'),
      cellClassRules: rules('note', r => r._isNew || String(r.note ?? '').trim() !== (r._orig?.note ?? '')),
      tooltipValueGetter: _cellMsg,
    },
    {
      colId: 'used_by', headerName: Util.t('col.used_by'), width: 130, minWidth: 120, type: 'numericColumn',
      headerTooltip: Util.t('ui.tool_inventory_used_by_hint'),
      valueGetter: (p: { data?: TiRow }) => (p.data ? (_st.usedBy.get(_typedId(p.data.tool_id)) ?? 0) : 0),
    },
  ];
}

function _passesFilter(r: TiRow): boolean {
  switch (_st.filter) {
    case 'oos': return (_oosOf(r) ?? 0) > 0;
    case 'available_zero': return _availableOf(r) === 0;
    case 'total_not_one': return _parseQty(r.total_qty) !== 1;
    case 'unused': return (_st.usedBy.get(_typedId(r.tool_id)) ?? 0) === 0;
    case 'used_no_row': return r._isNew && (_st.usedBy.get(_typedId(r.tool_id)) ?? 0) > 0;
    case 'in_use_now': return !r._isNew && _st.inUseNow.has(_typedId(r.tool_id));
    default: return true;
  }
}

function _mkNoRowsOverlay() {
  return class {
    _gui!: HTMLDivElement;
    init(): void {
      this._gui = document.createElement('div');
      this._gui.className = 'table-empty-overlay';
      this._gui.innerHTML = _stateHtml(Util.t('empty.no_tool_inventory_filtered'));
    }
    getGui(): HTMLDivElement { return this._gui; }
  };
}

function _createGrid(): void {
  const el = _el('ti-grid');
  if (!el || _gridApi || _gridCreated || typeof agGrid === 'undefined') return;
  _gridCreated = true;
  const options = {
    rowData: _st.rows,
    getRowId: (p: { data: TiRow }) => p.data._cid,
    rowSelection: 'multiple',
    suppressRowClickSelection: true,
    animateRows: false,
    stopEditingWhenCellsLoseFocus: true,
    tooltipShowDelay: 400,
    cacheQuickFilter: false,
    defaultColDef: { sortable: true, resizable: true, editable: false, wrapHeaderText: true, autoHeaderHeight: true },
    columnDefs: _columnDefs(),
    noRowsOverlayComponent: _mkNoRowsOverlay(),
    isExternalFilterPresent: () => _st.filter !== 'all',
    doesExternalFilterPass: (node: { data?: TiRow }) => !!node.data && _passesFilter(node.data),
    onCellValueChanged: () => _onEdited(),
    onSelectionChanged: () => _updateChrome(),
    onGridReady: (params: { api: NimbusVendor.AgGridApi }) => {
      _gridApi = params.api;
      const pending = _pendingQuick;
      if (pending != null) { _pendingQuick = null; ToolInventory.setQuickFilter(pending); }
    },
  };
  const created = agGrid.createGrid(el, options as unknown as NimbusVendor.AgGridOptions) as NimbusVendor.AgGridApi | undefined;
  if (!_gridApi && created) _gridApi = created;
  if (_pendingQuick != null && _gridApi) { const q = _pendingQuick; _pendingQuick = null; ToolInventory.setQuickFilter(q); }
}

/** Push the current rows into the grid (immutable rowData diffed by `_cid`) and repaint every cell: a duplicate or
 *  Out-of-Service-vs-Total error can sit on a row other than the one just edited. */
function _pushRows(): void {
  _st.errors = null;
  const api = _gridApi;
  if (api) {
    try { api.setGridOption('rowData', [..._st.rows]); } catch {}
    try { api.refreshCells({ force: true }); } catch {}
  }
}

function _onEdited(): void {
  _st.errors = null;
  _st.serverProblems = [];
  try { _gridApi?.refreshCells({ force: true }); } catch {}
  _updateChrome();
}

// -- Actions ----------------------------------------------------------------------

function _addRow(): void {
  if (!_canEdit()) return;
  // A new row must be visible: drop any filter that would hide it.
  if (_st.filter !== 'all' || _st.quick) {
    _st.filter = 'all'; _st.quick = '';
    const f = _el<HTMLSelectElement>('ti-filter'); if (f) f.value = 'all';
    const q = _el<HTMLInputElement>('ti-quick'); if (q) q.value = '';
    try { _gridApi?.setGridOption('quickFilterText', ''); } catch {}
  }
  const row = _newRow();
  _st.rows = [..._st.rows, row];
  _st.serverProblems = [];
  const wasEmpty = _st.rows.length === 1;
  if (wasEmpty) { _showState(); _createGrid(); }
  _pushRows();
  _updateChrome();
  // Put the cursor in the Tool ID cell of the new row.
  const idx = (_call(_gridApi, 'getRowNode', row._cid) as { rowIndex?: number | null } | undefined)?.rowIndex;
  if (idx != null) {
    _call(_gridApi, 'ensureIndexVisible', idx);
    _call(_gridApi, 'startEditingCell', { rowIndex: idx, colKey: 'tool_id' });
  }
}

const ADD_IN_USE_CAP = 500;

/** Draft NEW rows (1 copy, none out of service) for every tool carried by the loaded orders that has no row and no draft. */
function _addInUse(): void {
  if (!_canEdit()) return;
  const missing = _missingInUse();
  if (!missing.length) { Toast.show(Util.t('toast.tool_inventory_none_in_use'), 'info'); return; }
  const take = missing.slice(0, ADD_IN_USE_CAP);
  if (_st.filter !== 'all' || _st.quick) {
    _st.filter = 'all'; _st.quick = '';
    const f = _el<HTMLSelectElement>('ti-filter'); if (f) f.value = 'all';
    const q = _el<HTMLInputElement>('ti-quick'); if (q) q.value = '';
    try { _gridApi?.setGridOption('quickFilterText', ''); } catch {}
  }
  const wasEmpty = !_st.rows.length;
  _st.rows = [..._st.rows, ...take.map(id => { const r = _newRow(); r.tool_id = id; return r; })];
  _st.serverProblems = [];
  if (wasEmpty) { _showState(); _createGrid(); }
  _pushRows();
  _updateChrome();
  Toast.show(Util.t('toast.tool_inventory_added_in_use', { n: take.length }), 'success');
  if (missing.length > take.length) Toast.show(Util.t('toast.tool_inventory_added_in_use_capped', { n: ADD_IN_USE_CAP }), 'info');
}

function _removeRows(cids: string[]): void {
  if (!_canEdit() || !cids.length) return;
  const gone = new Set(cids);
  for (const r of _st.rows) {
    // A saved row is STAGED (kept in `_st.deletes`), a never-saved row just disappears.
    if (gone.has(r._cid) && !r._isNew && r._orig) _st.deletes.push({ tool_id: r.tool_id, orig: r._orig });
  }
  _st.rows = _st.rows.filter(r => !gone.has(r._cid));
  _st.serverProblems = [];
  _call(_gridApi, 'deselectAll');
  if (!_st.rows.length) _showState();
  _pushRows();
  _updateChrome();
}

function _deleteSelected(): void {
  const sel = ((_call(_gridApi, 'getSelectedRows') as TiRow[] | undefined) ?? []).map(r => r._cid);
  _removeRows(sel);
}

async function _confirmDiscard(count: number): Promise<boolean> {
  return Modal.confirm({
    title: Util.t('ui.n_unsaved', { count }),
    message: Util.t('confirm.md_refresh_discard'),
    confirmLabel: Util.t('btn.discard'),
  });
}

function _resetEdits(): void {
  const inv = _savedRows();
  _drafts.delete(_st.plant ?? '');
  _st.serverProblems = [];
  if (inv) {
    _st.rows = inv.map(_rowFromSaved);
    _st.deletes = [];
    _st.ref = inv;
  }
  _st.errors = null;
  _showState();
  _pushRows();
  _updateChrome();
}

async function _discard(): Promise<boolean> {
  const n = _dirtyCount();
  if (!n || _st.writing) return false;
  if (!await _confirmDiscard(n)) return false;
  _resetEdits();
  Toast.show(Util.t('toast.tool_inventory_discarded'), 'info');
  return true;
}

function _fmtOrders(e: UsageEntry): string {
  return e.orders.join(', ') + (e.count > e.orders.length ? ', …' : '');
}

/** Ask the server which orders use each removed tool. Resolves null when the usage cannot be read. */
async function _readUsage(plant: string, ids: string[]): Promise<Record<string, UsageEntry> | null> {
  try {
    const res = await Util.fetchTraced(`${Config.API_BASE}/tool-inventory/${encodeURIComponent(plant)}/usage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool_ids: ids }),
    });
    if (!res.ok) return null;
    return await res.json() as Record<string, UsageEntry>;
  } catch { return null; }
}

/** The removal confirm(s): true = go ahead. In-use ids get the counted warning; an unreadable usage gets the error confirm. */
async function _confirmRemovals(plant: string, ids: string[]): Promise<boolean> {
  if (!ids.length) return true;
  const usage = await _readUsage(plant, ids);
  if (!usage) {
    return Modal.confirm({
      title: Util.t('modal.tool_inventory_delete_title'),
      message: Util.t('modal.tool_inventory_check_failed'),
      confirmLabel: Util.t('btn.tool_inventory_remove_save'),
      tone: 'warn',
    });
  }
  const used = ids.filter(id => (usage[id]?.count ?? 0) > 0);
  if (!used.length) return true;
  const items = used.map(id => `<li>${Util.escapeHtml(Util.t('modal.tool_inventory_delete_item', {
    tool: id, count: usage[id].count, orders: _fmtOrders(usage[id]),
  }))}</li>`).join('');
  return Modal.confirm({
    title: Util.t('modal.tool_inventory_delete_title'),
    message: Util.t('modal.tool_inventory_delete_body'),
    detail: `<ul class="ti-confirm-list">${items}</ul>`,
    confirmLabel: Util.t('btn.tool_inventory_remove_save'),
    tone: 'warn',
  });
}

/** After a save: say how many tool conflicts the alert recompute cleared. Subscribe BEFORE the Store refetch, but only
 *  react to an `alerts:change` that arrives AFTER the tool_inventory `master-data-changed` (an earlier or unrelated alerts
 *  change is ignored). The 3 s guard starts once the refetch resolved; counts are compared for the SAME plant. */
function _watchToolAlerts(plant: string, before: number): { start: () => void; cancel: () => void; started: boolean } {
  let done = false;
  let armed = false;
  let off: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (fired: boolean): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { off?.(); } catch {}
    if (!fired || Store.selectedPlant !== plant) return;
    const after = _toolAlertCount(plant);
    if (after < before) Toast.show(Util.t('toast.tool_alerts_cleared', { n: before - after }), 'success');
  };
  off = Store.subscribe(evt => {
    if (evt.type === 'master-data-changed' && (evt.table === 'tool_inventory' || evt.table === undefined)) armed = true;
    else if (evt.type === 'alerts:change' && armed) finish(true);
  }, 'ToolInventoryAlerts');
  const handle = {
    started: false,
    start: () => {
      handle.started = true;
      if (done) return;
      timer = setTimeout(() => finish(false), ALERT_WATCH_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    cancel: () => finish(false),
  };
  return handle;
}

function _bulkBody(): { upserts: Array<{ tool_id: string; total_qty: number; out_of_service_qty: number; note: string | null }>; deletes: Array<{ tool_id: string }>; source: { kind: 'grid' } } {
  const ids = new Set(_st.rows.map(r => _typedId(r.tool_id)));
  const upserts = _st.rows.filter(r => _rowChanged(r) && !_isIdenticalReAdd(r, _st)).map(r => ({
    tool_id: _typedId(r.tool_id), total_qty: _parseQty(r.total_qty) as number, out_of_service_qty: _oosOf(r) as number,
    note: String(r.note ?? '').trim() || null,
  }));
  // A staged delete whose id is back as a row in this save is an edit (upsert only): no delete, no usage confirm.
  // (An identical re-add is untouched: neither a delete nor an upsert.)
  const deletes = _st.deletes.filter(d => !ids.has(d.tool_id)).map(d => ({ tool_id: d.tool_id }));
  return { upserts, deletes, source: { kind: 'grid' } };
}

async function _save(): Promise<void> {
  const plant = _st.plant;
  if (!plant || !_canSave()) return;
  const body = _bulkBody();
  _st.writing = true;
  _st.serverProblems = [];
  _updateChrome();
  const stateAtStart = _st;
  let watch: { start: () => void; cancel: () => void; started: boolean } | null = null;
  try {
    if (!await _confirmRemovals(plant, body.deletes.map(d => d.tool_id))) return;   // Cancel: keep every staged edit
    const alertWatch = _watchToolAlerts(plant, _toolAlertCount(plant));
    watch = alertWatch;
    const res = await Util.fetchTraced(`${Config.API_BASE}/tool-inventory/${encodeURIComponent(plant)}/bulk`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await Util.parseBackendError(res);
      const e = new Error(err.message || `HTTP ${res.status}`) as Error & { status?: number };
      e.status = res.status;
      throw e;
    }
    ErrorLog.info('tool-inventory', `saved ${body.upserts.length} upsert(s), ${body.deletes.length} delete(s) for plant ${plant}`);
    _drafts.delete(plant);
    if (_st === stateAtStart && _st.plant === plant) {
      // Commit locally first so the screen is coherent even if the Store refetch fails; the refetch then rebases.
      for (const r of _st.rows) { r._isNew = false; r._orig = { total_qty: _parseQty(r.total_qty) as number, out_of_service_qty: _oosOf(r) as number, note: String(r.note ?? '').trim() }; r.tool_id = _typedId(r.tool_id); }
      _st.deletes = [];
      _st.errors = null;
    }
    Toast.show(Util.t('toast.tool_inventory_saved', { count: body.upserts.length + body.deletes.length }), 'success');
    await _seams.refreshStoreMasterData('tool-inventory-save', 'tool_inventory');
    watch.start();
    if (_st.plant === plant) { _loadFromStore(); _showState(); _pushRows(); }
  } catch (e: unknown) {
    const status = (e as { status?: number })?.status;
    const msg = e instanceof Error ? e.message : String(e);
    ErrorLog.error('tool-inventory', `save failed: ${msg}`);
    if (_st === stateAtStart) {
      if (status === 403) {
        _st.readOnly = true;
        Toast.show(Util.t('toast.no_write_permission'), 'error');
      } else {
        // Edits stay as they are so the planner can fix and retry. Only a 400 carries the server's problem list; a network or
        // other failure just toasts the message.
        if (status === 400) _st.serverProblems = msg.replace(/^Cannot save tool inventory:\s*/i, '').split(/;\s+/).map(s => s.trim()).filter(Boolean);
        Toast.show(Util.t('toast.tool_inventory_save_failed', { msg }), 'error');
      }
    }
  } finally {
    if (watch && !watch.started) watch.cancel();
    stateAtStart.writing = false;
    if (_st === stateAtStart) { _pushRows(); _updateChrome(); }
  }
}

// -- Excel: Template / Export / Upload with a review step ------------------------------

function _setBusy(on: boolean): void {
  _busy = on;
  _updateChrome();
}

/** `filename*=UTF-8''x.xlsx` or `filename="x.xlsx"` from a Content-Disposition header, sanitised; the fallback when absent. */
export function filenameFromDisposition(header: string | null | undefined, fallback: string): string {
  let name = '';
  const star = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(header ?? '');
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header ?? '');
  const raw = star?.[1] ?? plain?.[1] ?? '';
  try { name = decodeURIComponent(raw); } catch { name = raw; }
  name = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '');
  return name || fallback.replace(/[^A-Za-z0-9._-]+/g, '_');
}

async function _download(kind: 'template' | 'export'): Promise<void> {
  const plant = _st.plant;
  if (!plant || _busy) return;
  _setBusy(true);
  try {
    const res = await Util.fetchTraced(`${Config.API_BASE}/tool-inventory/${encodeURIComponent(plant)}/${kind === 'template' ? 'template.xlsx' : 'export.xlsx'}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const fallback = kind === 'template' ? `tool-inventory-template-${plant}.xlsx` : `tool-inventory-${plant}.xlsx`;
    _seams.saveBlob(blob, filenameFromDisposition(res.headers?.get?.('content-disposition'), fallback));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    ErrorLog.error('tool-inventory', `${kind} download failed: ${msg}`);
    Toast.show(Util.t('toast.export_failed', { msg }), 'error');
  } finally {
    _setBusy(false);
  }
}

/** The Upload button: open the picker straight away (the click keeps its user gesture, and cancelling the picker changes nothing). */
async function _pickUpload(): Promise<void> {
  if (_busy || !_canEdit()) return;
  _el<HTMLInputElement>('ti-upload-input')?.click?.();
}

/** A file was chosen: unsaved grid edits go through the discard confirm NOW (declined -> toast, nothing sent), then the review flow. */
async function _onFilePicked(plant: string, file: File): Promise<void> {
  if (_busy) return;
  const n = _st.plant === plant ? _dirtyCount() : 0;
  if (n > 0) {
    if (!await _confirmDiscard(n)) { Toast.show(Util.t('toast.tool_inventory_upload_dirty'), 'warn'); return; }
    if (_st.plant === plant) _resetEdits();
  }
  await _uploadFile(plant, file);
}

interface UploadEditable { total_qty?: unknown; out_of_service_qty?: unknown; note?: unknown }
interface UploadDry {
  counts: { new: number; changed: number; unchanged: number; rejected: number };
  new?: Array<UploadEditable & { tool_id?: unknown }>;
  changed?: Array<{ tool_id?: unknown; before?: UploadEditable; after?: UploadEditable }>;
  rejected?: Array<{ row?: unknown; tool_id?: unknown; error?: unknown }>;
  warnings?: unknown[];
}
interface UploadApplied { inserted?: number; updated?: number; rejected?: number; warnings?: unknown[] }

function _warnText(w: unknown): string {
  if (typeof w === 'string') return w;
  const o = w as { msg?: unknown; message?: unknown } | null;
  return String(o?.msg ?? o?.message ?? JSON.stringify(w));
}

function _cellDiff(before: unknown, after: unknown): string {
  const b = before == null || before === '' ? '' : String(before);
  const a = after == null || after === '' ? '' : String(after);
  const arrow = Util.t('ui.tool_inventory_review_arrow_sr');
  return b === a ? Util.escapeHtml(a || '—') : `${Util.escapeHtml(b || '—')} <span class="ti-review-arrow" aria-hidden="true">→</span><span class="ti-sr-only">${Util.escapeHtml(arrow)}</span> <strong>${Util.escapeHtml(a || '—')}</strong>`;
}

function _more(total: number, shown: number): string {
  return total > shown ? `<p class="ti-review-more">${Util.escapeHtml(Util.t('modal.tool_inventory_review_more', { n: total - shown }))}</p>` : '';
}

/** The review modal body: counts, changes, new tools, rejected rows, warnings and the two standing sentences. */
export function reviewHtml(fileName: string, dry: UploadDry): string {
  const c = dry.counts;
  const esc = Util.escapeHtml;
  const t = (k: string, v?: Record<string, string | number>): string => esc(Util.t(k, v));
  let h = `<p class="ti-review-file"><strong>${esc(fileName)}</strong></p>`;
  h += `<p class="ti-review-summary" role="status">${t('modal.tool_inventory_review_summary', { new: c.new, changed: c.changed, unchanged: c.unchanged, rejected: c.rejected })}</p>`;
  if (c.rejected > 0) h += `<p class="ti-review-warn" role="alert">⚠ ${t('modal.tool_inventory_review_rejected_warn')}</p>`;
  const changed = (dry.changed ?? []).slice(0, REVIEW_CAP);
  if (c.changed > 0) {
    h += `<h4>${t('modal.tool_inventory_review_changes')}</h4><table class="ti-review-table"><thead><tr>`
      + `<th scope="col">${t('col.tool_id')}</th><th scope="col">${t('col.total_qty')}</th><th scope="col">${t('col.out_of_service_qty')}</th><th scope="col">${t('col.note')}</th></tr></thead><tbody>`;
    for (const r of changed) {
      h += `<tr><th scope="row">${esc(String(r.tool_id ?? ''))}</th><td>${_cellDiff(r.before?.total_qty, r.after?.total_qty)}</td>`
        + `<td>${_cellDiff(r.before?.out_of_service_qty, r.after?.out_of_service_qty)}</td><td>${_cellDiff(r.before?.note, r.after?.note)}</td></tr>`;
    }
    h += `</tbody></table>${_more(c.changed, changed.length)}`;
  }
  const added = (dry.new ?? []).slice(0, REVIEW_CAP);
  if (c.new > 0) {
    h += `<h4>${t('modal.tool_inventory_review_new')}</h4><ul class="ti-review-list">`
      + added.map(r => `<li>${t('modal.tool_inventory_review_new_item', { tool: String(r.tool_id ?? ''), total: String(r.total_qty ?? ''), oos: String(r.out_of_service_qty ?? 0) })}</li>`).join('')
      + `</ul>${_more(c.new, added.length)}`;
  }
  const rejected = (dry.rejected ?? []).slice(0, REVIEW_CAP);
  if (c.rejected > 0) {
    h += `<h4>${t('modal.tool_inventory_review_rejected')}</h4><ul class="ti-review-list">`
      + rejected.map(r => `<li>${t('modal.tool_inventory_review_rejected_item', { row: String(r.row ?? ''), error: String(r.error ?? '') })}${r.tool_id ? ` (${esc(String(r.tool_id))})` : ''}</li>`).join('')
      + `</ul>${_more(c.rejected, rejected.length)}`;
  }
  const warnings = dry.warnings ?? [];
  if (warnings.length) {
    h += `<h4>${t('modal.tool_inventory_review_warnings')}</h4><ul class="ti-review-list">`
      + warnings.slice(0, WARNINGS_CAP).map(w => `<li>${esc(_warnText(w))}</li>`).join('') + `</ul>${_more(warnings.length, WARNINGS_CAP)}`;
  }
  h += `<p class="ti-review-untouched">${t('modal.tool_inventory_review_untouched')}</p>`;
  return h;
}

let _reviewDone: ((ok: boolean) => void) | null = null;
let _reviewWired = false;

function _finishReview(ok: boolean): void {
  const done = _reviewDone;
  if (!done) return;
  _reviewDone = null;
  Modal.close(REVIEW_ID);
  done(ok);
}

function _wireReview(): void {
  if (_reviewWired) return;
  _reviewWired = true;
  _el('ti-review-apply')?.addEventListener('click', () => {
    if ((_el<HTMLButtonElement>('ti-review-apply')?.disabled)) return;
    _finishReview(true);
  });
  _el('ti-review-cancel')?.addEventListener('click', () => _finishReview(false));
  _el('ti-review-close')?.addEventListener('click', () => _finishReview(false));
  // The backdrop never closes this modal (data-no-backdrop-close); Escape cancels, wherever the focus is.
  document.addEventListener?.('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape' && _reviewDone) { e.preventDefault?.(); _finishReview(false); } });
}

/** Open the review modal; resolves true on "Apply N changes", false on Cancel / close / Escape. Cancel is the default focus. */
function _showReview(fileName: string, dry: UploadDry): Promise<boolean> {
  _wireReview();
  const body = _el('ti-review-body');
  if (body) body.innerHTML = reviewHtml(fileName, dry);
  const n = (dry.counts.new ?? 0) + (dry.counts.changed ?? 0);
  const apply = _el<HTMLButtonElement>('ti-review-apply');
  if (apply) { apply.textContent = Util.t('modal.tool_inventory_review_apply', { n }); apply.disabled = n === 0; }
  const cancel = _el<HTMLButtonElement>('ti-review-cancel');
  if (cancel) cancel.textContent = Util.t('btn.cancel');
  return new Promise(resolve => {
    _finishReview(false);        // a stale pending review (should not happen) never leaks
    _reviewDone = resolve;
    Modal.open(REVIEW_ID);
  });
}

function _postUpload(plant: string, file: File, dry: boolean): Promise<Response> {
  const fd = new FormData();
  fd.append('file', file);
  return Util.fetchTraced(`${Config.API_BASE}/tool-inventory/${encodeURIComponent(plant)}/upload?dry_run=${dry ? 1 : 0}`, { method: 'POST', body: fd });
}

/** A failed upload response -> one readable toast (413 too large, 403 read-only, 400 the server's reason). */
async function _uploadFailed(plant: string, res: Response): Promise<void> {
  if (res.status === 413) { Toast.show(Util.t('toast.tool_inventory_upload_too_large'), 'error'); return; }
  if (res.status === 403) {
    if (_st.plant === plant) { _st.readOnly = true; _updateChrome(); }
    Toast.show(Util.t('toast.no_write_permission'), 'error');
    return;
  }
  const err = await Util.parseBackendError(res);
  ErrorLog.error('tool-inventory', `upload failed (${res.status}): ${err.message}`);
  Toast.show(Util.t('toast.tool_inventory_upload_failed', { msg: err.message || `HTTP ${res.status}` }), 'error');
}

function _showUploadResult(summary: string, warnings: string[]): void {
  const e = _el('ti-upload-result');
  if (!e) return;
  e.hidden = false;
  e.innerHTML = `<strong>${Util.escapeHtml(summary)}</strong>`
    + (warnings.length ? `<ul>${warnings.slice(0, WARNINGS_CAP).map(w => `<li>${Util.escapeHtml(w)}</li>`).join('')}</ul>`
      + (warnings.length > WARNINGS_CAP ? `<p>${Util.escapeHtml(Util.t('modal.tool_inventory_review_more', { n: warnings.length - WARNINGS_CAP }))}</p>` : '') : '');
}

function _clearUploadResult(): void {
  const e = _el('ti-upload-result');
  if (e) { e.hidden = true; e.innerHTML = ''; }
}

/** Review-then-apply an Excel file for `plant`. POST ?dry_run=1 first (writes nothing), the review modal, and on Apply the SAME File
 *  is re-posted with ?dry_run=0 (the server re-parses and re-diffs, so the result can differ if someone saved in between).
 *  Resolves true when rows were applied. Shared by the planner toolbar and the Manage Data grid. */
async function _uploadFile(plant: string, file: File): Promise<boolean> {
  if (_busy) return false;
  if (Sandbox.active) { Toast.show(Util.t('ui.tool_inventory_sandbox_hint'), 'warn'); return false; }
  if (_st.plant === plant && _st.readOnly) { Toast.show(Util.t('toast.no_write_permission'), 'error'); return false; }
  _setBusy(true);
  try {
    // Branch on what was SENT: a dry run returns a plan, an apply returns counts.
    const dryRes = await _postUpload(plant, file, true);
    if (!dryRes.ok) { await _uploadFailed(plant, dryRes); return false; }
    const dry = await dryRes.json() as UploadDry;
    _setBusy(false);                       // the buttons are usable while the planner reads the review
    if (!await _showReview(file.name, dry)) return false;
    _setBusy(true);
    const alertWatch = _watchToolAlerts(plant, _toolAlertCount(plant));
    let watchStarted = false;
    try {
      const res = await _postUpload(plant, file, false);
      if (!res.ok) { await _uploadFailed(plant, res); return false; }
      const out = await res.json() as UploadApplied;
      const warnings = (out.warnings ?? []).map(_warnText);
      warnings.slice(0, WARNINGS_CAP).forEach(w => ErrorLog.warn('tool-inventory', w));
      ErrorLog.info('tool-inventory', `upload applied for plant ${plant}: ${out.inserted ?? 0} inserted, ${out.updated ?? 0} updated, ${out.rejected ?? 0} rejected`);
      const summary = Util.t('toast.tool_inventory_upload_done', { inserted: out.inserted ?? 0, updated: out.updated ?? 0, rejected: out.rejected ?? 0 });
      Toast.show(summary, out.rejected ? 'warn' : 'success', 6000);
      _showUploadResult(summary, warnings);
      await _seams.refreshStoreMasterData('tool-inventory-save', 'tool_inventory');
      alertWatch.start(); watchStarted = true;
      // Re-sync the grid only for the reviewed plant AND when it holds no unsaved edits (never clobber the planner's work;
      // the next Refresh / save rebases through _rebase).
      if (_st.plant === plant && _dirtyCount() === 0) { _loadFromStore(); _showState(); _pushRows(); }
      return true;
    } finally {
      if (!watchStarted) alertWatch.cancel();
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    ErrorLog.error('tool-inventory', `upload failed: ${msg}`);
    Toast.show(Util.t('toast.tool_inventory_upload_failed', { msg }), 'error');
    return false;
  } finally {
    _setBusy(false);
  }
}

async function _retry(): Promise<void> {
  const plant = _st.plant;
  if (!plant) return;
  _st.view = 'loading';
  _showState(); _updateChrome();
  await Persistence.refreshToolInventory(plant);
  if (_st.plant !== plant) return;
  ToolInventory.render();
}

// -- Public surface ----------------------------------------------------------------

/** The pane is on screen: not hidden itself and its Master Data top tab is the active one (render() never runs against a hidden container). */
function _paneVisible(): boolean {
  const pane = _el(PANE_ID);
  if (!pane || pane.hidden) return false;
  const tab = _el('masterdata-tab');
  if (tab) {
    if (tab.hidden) return false;
    if (tab.classList && typeof tab.classList.contains === 'function' && !tab.classList.contains('active')) return false;
  }
  return true;
}

export const ToolInventory = {
  /** Wire the plant switch (retain the old plant's draft) and the Store sync. Safe to call more than once. */
  init(): void {
    if (_subscribed) return;
    _subscribed = true;
    Store.subscribe(evt => {
      if (evt.type === 'plant:selected') {
        _retainDraft();
        _clearUploadResult();
        _st = _blank(_st);   // an in-flight save finishes against its own (detached) state
        if (_paneVisible()) ToolInventory.render();
        return;
      }
      if (evt.type === 'master-data-changed' && _st.plant && _st.plant === Store.selectedPlant
          && (evt.table === 'tool_inventory' || evt.table === undefined)) {
        if (_paneVisible()) ToolInventory.render();
        else _loadFromStore();
        return;
      }
      if (evt.type === 'sandbox:entered' || evt.type === 'sandbox:exited') { if (_paneVisible()) _updateChrome(); return; }
      if (evt.type === 'tasks:bulk' && _st.plant && _paneVisible()) {
        _st.usedBy = _buildUsedBy(_st.plant);
        _st.inUseNow = _buildInUseNow(_st.plant);
        try { _gridApi?.refreshCells({ force: true }); } catch {}
      }
    }, 'ToolInventory');
  },

  render(): void {
    if (!_ensureDom()) return;
    const plant = Store.selectedPlant;
    if (!plant) {
      _retainDraft();
      _st = _blank(_st);
    } else if (_st.plant !== plant) {
      _retainDraft();
      _adoptPlant(plant);
    } else {
      _st.usedBy = _buildUsedBy(plant);
      _st.inUseNow = _buildInUseNow(plant);
      _loadFromStore();
    }
    _showState();
    if (_st.view === 'ready' && (_st.rows.length || _st.deletes.length)) {
      _createGrid();
      _pushRows();
      requestAnimationFrame(() => { try { if ((_el('ti-grid')?.clientWidth ?? 0) > 50) _gridApi?.sizeColumnsToFit(); } catch {} });
    }
    else _pushRows();   // not ready / no rows: the single grid must not keep showing another plant's rows
    _updateChrome();
  },

  /** Master Data "Refresh": reload the plant's rows from the server (confirm first if there are unsaved edits). */
  async refresh(): Promise<boolean> {
    const plant = Store.selectedPlant;
    if (!plant) return false;
    const n = _st.plant === plant ? _dirtyCount() : 0;
    if (n > 0 && !await _confirmDiscard(n)) return false;
    const ok = await Persistence.refreshToolInventory(plant);
    if (!ok || Store.selectedPlant !== plant) return false;
    if (_st.plant === plant) _resetEdits();
    ToolInventory.render();
    return _st.view === 'ready';
  },

  /** Set the quick-filter text from code (kept until the grid exists). */
  setQuickFilter(text: string): void {
    _st.quick = text;
    const q = _el<HTMLInputElement>('ti-quick');
    if (q) q.value = text;
    if (!_gridApi) { _pendingQuick = text; return; }
    _pendingQuick = null;
    try { _gridApi.setGridOption('quickFilterText', text); } catch {}
  },

  /** Excel upload with the review step (the planner toolbar and the Manage Data grid both call this). Resolves true when rows were applied. */
  uploadFile(plant: string, file: File): Promise<boolean> { return _uploadFile(plant, file); },

  /** The removal confirm (in-use warning / could-not-check) shared with the Manage Data grid's delete path: true = go ahead. */
  confirmRemovals(plant: string, ids: string[]): Promise<boolean> { return _confirmRemovals(plant, ids); },

  /** Deep link: show `plant`'s inventory filtered to one tool id. */
  openForTool(plant: string, toolId: string): void | Promise<void> {
    const show = (): void => {
      // A stale "Out of service" filter must not hide the tool the alert points at.
      _st.filter = 'all';
      const sel = _el<HTMLSelectElement>('ti-filter');
      if (sel) sel.value = 'all';
      _call(_gridApi, 'onFilterChanged');
      _updateChrome();
      ToolInventory.setQuickFilter(String(toolId ?? ''));
    };
    if (plant && Store.selectedPlant !== plant) {
      // Switching plant drops the outgoing plant's unsaved edits: ask first (no prompt when nothing is unsaved).
      return Persistence.confirmPlantSwitch(plant).then(ok => {
        if (!ok) return;
        Store.setSelectedPlant(plant, 'tool-inventory-link');
        show();
      });
    }
    show();
  },

  // -- test / wiring hooks (not part of the documented surface) --
  _addRow: (): void => _addRow(),
  _addInUse: (): void => _addInUse(),
  _deleteSelected: (): void => _deleteSelected(),
  _removeRows: (cids: string[]): void => _removeRows(cids),
  _save: (): Promise<void> => _save(),
  _discard: (): Promise<boolean> => _discard(),
  _retry: (): Promise<void> => _retry(),
  _pickUpload: (): Promise<void> => _pickUpload(),
  _download: (kind: 'template' | 'export'): Promise<void> => _download(kind),
  /** Plain snapshot for tests: rows, staged deletes, per-field errors, view, flags. */
  _snapshot() {
    return { plant: _st.plant, view: _st.view, rows: _st.rows, deletes: _st.deletes, errors: _validate(), readOnly: _st.readOnly,
      writing: _st.writing, canSave: _canSave(), dirty: _dirtyCount(), draftPlants: [..._drafts.keys()], serverProblems: _st.serverProblems,
      filter: _st.filter, passesFilter: _passesFilter };
  },
  _setFilter(mode: FilterMode): void { _st.filter = mode; },
};
