// admin-tables.mts — Admin > Table Browser (Workstream E).
//
// A read-only, catalog-driven browser over EVERY table in the backend's
// `public` schema (GET /admin/tables, GET /admin/tables/{table},
// GET /admin/tables/{table}/export.csv — all admin_tables.py/brain.py,
// see docs/superpowers/plans/2026-08-20-workstream-d-e-setup-hygiene-admin-
// browser.md §E). Deliberately separate from MasterData's ALLOWED_TABLES-
// backed editable grid: no create/edit/delete path exists anywhere in this
// module (OD-E3) — every request here is a GET.
//
// New, standalone module — mirrors master-data-grids.mts's own placement
// rationale (not folded into plant-and-administration.mts, which is already
// 8000+ lines carrying nine other modules). Unlike MaterialGrids, this file
// needs no window.__NIMBUS_* classic-script bridge: plant-and-
// administration.mts (AdminCockpit) is itself a real ES module, so it can
// (and does) `import { AdminTables } from './admin-tables.mjs'` directly —
// the same real-ESM-to-real-ESM pattern application-shell.mts already uses
// for `import { MaterialGrids } from './master-data-grids.mjs'`. A window
// bridge is only needed at the app-entry.mjs -> app.js classic-script
// boundary, which this module never needs to cross (AdminCockpit calls
// `AdminTables.render()` directly; nothing in index.html or
// nimbus-intelligence.js references it, and none of this module's own
// generated HTML uses inline `onclick=` — every listener is wired via
// addEventListener, matching MaterialGrids' own convention — so
// scripts/check-legacy-surface.mjs sees zero new surface).
//
// Deliberately unscoped by plant (OD-E2): every table in the catalog is
// cross-plant by nature (there is no single-plant version of "list every
// table"), and access is gated server-side by require_admin alone — see
// brain.py's comment block above the three /admin/tables* routes. This
// module must never call _assert_plant_allowed-equivalent logic or filter
// the catalog by Store.selectedPlant.
/* global agGrid, NIMBUS */
import { Config, Util, ErrorLog, Toast } from './application-foundation.mjs';

// -- Backend contract types (admin_tables.py / brain.py) ---------------------

interface AdminTableFkColumn {
  column: string;
  ref_table: string;
  ref_column: string;
}

interface AdminTableCatalogEntry {
  table: string;
  approx_row_count: number;
  internal: boolean;
  pk_columns: string[];
  fk_columns: AdminTableFkColumn[];
}

interface AdminTableColumn {
  name: string;
  sql_type: string;
  is_nullable: boolean;
  ordinal_position: number;
  is_pk: boolean;
  is_fk: boolean;
  ref_table: string | null;
  ref_column: string | null;
}

type AdminTableRow = Record<string, unknown>;

interface AdminTableRowsResponse {
  columns: AdminTableColumn[];
  rows: AdminTableRow[];
  meta: { total: number; limit: number; offset: number };
}

// -- Pure helpers (exported for tests/modules/admin-tables.test.mjs) ---------

/**
 * Splits pasted/typed filter-value text on newline, comma, AND tab (an Excel
 * column paste uses tabs; a hand-typed list more often uses commas or one
 * value per line) — a superset of Util.parsePasteList, which only splits on
 * newline/tab. Trims each candidate, strips the Excel ".0" float suffix
 * (Util._stripExcelFloatSuffix, same convention every other paste-filter in
 * this codebase uses), drops empties, and dedupes. Does NOT case-fold —
 * unlike the setup-matrix state-value fold (D1), this browser is generic
 * over arbitrary tables/columns with no single canonical case convention, so
 * values are matched exactly as typed against the backend's case-sensitive
 * `IN (...)` filter.
 */
export function parseFilterPasteText(text: string | null | undefined): string[] {
  if (!text) return [];
  const commaToNewline = text.replace(/,/g, '\n');
  return [...new Set(Util.parsePasteList(commaToNewline))];
}

/**
 * Builds the query string for GET /admin/tables/{table}[/export.csv] from
 * the current pagination + filter state. Filter transport matches brain.py's
 * `_admin_tables_query_filters`: one repeated query param per active value
 * (`?col=a&col=b`), multi-value via repetition — never a comma-joined single
 * value. `limit`/`offset` are optional (export.csv only takes `offset`, and
 * a "full export" call omits both).
 */
export function buildTableQueryParams(
  filters: Map<string, Set<string>>,
  paging?: { limit?: number; offset?: number },
): URLSearchParams {
  const params = new URLSearchParams();
  if (paging?.limit != null) params.set('limit', String(paging.limit));
  if (paging?.offset != null) params.set('offset', String(paging.offset));
  for (const [field, values] of filters) {
    for (const v of values) if (v !== '') params.append(field, v);
  }
  return params;
}

// -- Module state --------------------------------------------------------------

const HOST_ID = 'admin-table-browser-host';
const PAGE_SIZES = [50, 100, 250, 500, 1000] as const;

let _domReady = false;
let _tables: AdminTableCatalogEntry[] = [];
let _tableListAbort: AbortController | null = null;
let _tableSearch = '';

let _selectedTable: string | null = null;
let _columns: AdminTableColumn[] = [];
let _filterFields: string[] = [];
const _filterValues: Map<string, Set<string>> = new Map();

let _rows: AdminTableRow[] = [];
let _meta = { total: 0, limit: PAGE_SIZES[1] as number, offset: 0 };
let _rowsAbort: AbortController | null = null;
let _loadingRows = false;

let _api: NimbusVendor.AgGridApi | null = null;

// -- Small utils ----------------------------------------------------------------

function _esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]));
}

function _formatCell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function _hasAnyFilter(): boolean {
  for (const s of _filterValues.values()) if (s.size) return true;
  return false;
}

// -- Table catalog (rail) --------------------------------------------------------

async function _loadTables(): Promise<void> {
  const host = document.getElementById(HOST_ID);
  if (!host) return;
  _tableListAbort?.abort();
  const controller = new AbortController();
  _tableListAbort = controller;
  try {
    const res = await Util.fetchTraced(`${Config.API_BASE}/admin/tables`, { signal: controller.signal });
    if (!res.ok) {
      const err = await Util.parseBackendError(res);
      throw new Error(err.message);
    }
    const body = await res.json() as { tables: AdminTableCatalogEntry[] };
    _tables = body.tables || [];
    if (_selectedTable && !_tables.some((t) => t.table === _selectedTable)) {
      _selectedTable = null;
      _renderDetailEmpty();
    }
    _renderRail();
  } catch (e: unknown) {
    if ((e as { name?: string })?.name === 'AbortError') return;
    const msg = e instanceof Error ? e.message : String(e);
    ErrorLog.error('admin-tables', `Table catalog load failed: ${msg}`);
    Toast.show(Util.t('toast.admin_tables_catalog_failed', { msg }), 'error');
  } finally {
    if (_tableListAbort === controller) _tableListAbort = null;
  }
}

function _renderRail(): void {
  const rail = document.getElementById('atb-rail');
  if (!rail) return;
  const q = _tableSearch.trim().toLowerCase();
  const filtered = q ? _tables.filter((t) => t.table.toLowerCase().includes(q)) : _tables;
  rail.innerHTML = filtered.length
    ? filtered.map((t) => `
      <div class="atb-rail-row${t.table === _selectedTable ? ' atb-rail-row-sel' : ''}"
           data-atb-table="${_esc(t.table)}" role="button" tabindex="0">
        <div class="atb-rail-name">${_esc(t.table)}${t.internal
          ? `<span class="atb-internal-badge">${_esc(Util.t('ui.admin_tables_internal_badge'))}</span>` : ''}</div>
        <div class="atb-rail-meta">${_esc(Util.t('ui.admin_tables_approx_rows', { count: t.approx_row_count.toLocaleString() }))}</div>
      </div>`).join('')
    : `<div class="atb-rail-empty">${_esc(q ? Util.t('ui.admin_tables_no_match') : Util.t('ui.admin_tables_no_tables'))}</div>`;
}

// -- Selected table: rows + columns -----------------------------------------------

async function _loadRows(table: string, opts: { resetGrid: boolean }): Promise<void> {
  _rowsAbort?.abort();
  const controller = new AbortController();
  _rowsAbort = controller;
  _loadingRows = true;
  _renderPagination();
  const params = buildTableQueryParams(_filterValues, { limit: _meta.limit, offset: _meta.offset });
  try {
    const res = await Util.fetchTraced(
      `${Config.API_BASE}/admin/tables/${encodeURIComponent(table)}?${params.toString()}`,
      { signal: controller.signal },
    );
    if (_selectedTable !== table) return; // user switched tables mid-flight — stale response
    if (!res.ok) {
      const err = await Util.parseBackendError(res);
      throw new Error(err.message);
    }
    const body = await res.json() as AdminTableRowsResponse;
    if (_selectedTable !== table) return;
    _columns = body.columns;
    _rows = body.rows;
    _meta = body.meta;
    _filterFields = _columns.filter((c) => c.is_pk || c.is_fk).map((c) => c.name);
    for (const f of _filterFields) if (!_filterValues.has(f)) _filterValues.set(f, new Set());
    if (opts.resetGrid) {
      _createOrRebuildGrid();
      _renderFilterBar();
    } else {
      try { _api?.setGridOption('rowData', _rows); } catch { /* grid not ready yet */ }
    }
    _renderPagination();
  } catch (e: unknown) {
    if ((e as { name?: string })?.name === 'AbortError') return;
    const msg = e instanceof Error ? e.message : String(e);
    ErrorLog.error('admin-tables', `${table} rows load failed: ${msg}`);
    Toast.show(Util.t('toast.admin_tables_rows_failed', { msg }), 'error');
  } finally {
    if (_rowsAbort === controller) _rowsAbort = null;
    if (_selectedTable === table) { _loadingRows = false; _renderPagination(); }
  }
}

function _mkNoRowsOverlay() {
  return class {
    _eGui!: HTMLDivElement;
    init(): void {
      this._eGui = document.createElement('div');
      this._eGui.className = 'table-empty-overlay';
      if (typeof NIMBUS !== 'undefined' && NIMBUS.EmptyState) {
        NIMBUS.EmptyState.render?.(this._eGui, {
          title: Util.t('empty.admin_tables_no_rows_title'),
          msg: Util.t('empty.admin_tables_no_rows_msg'),
        });
      }
    }
    getGui(): HTMLDivElement { return this._eGui; }
  };
}

function _buildColumnDefs(): unknown[] {
  return _columns.map((c) => ({
    headerName: c.is_pk ? `${c.name} 🔑` : c.is_fk ? `${c.name} → ${c.ref_table}.${c.ref_column}` : c.name,
    field: c.name,
    sortable: true,
    resizable: true,
    filter: false,
    editable: false,
    minWidth: 110,
    valueFormatter: (p: { value: unknown }) => _formatCell(p.value),
  }));
}

function _createOrRebuildGrid(): void {
  const el = document.getElementById('atb-grid');
  if (!el || typeof agGrid === 'undefined') return;
  if (_api) {
    try {
      _api.setGridOption('columnDefs', _buildColumnDefs());
      _api.setGridOption('rowData', _rows);
    } catch { /* grid torn down unexpectedly — fall through to recreate below */ }
    if (_api) return;
  }
  const gridOptions = {
    rowData: _rows,
    columnDefs: _buildColumnDefs(),
    defaultColDef: { sortable: true, resizable: true, filter: false, editable: false, minWidth: 100 },
    animateRows: false,
    suppressCellFocus: true,
    noRowsOverlayComponent: _mkNoRowsOverlay(),
    onGridReady: (params: { api: NimbusVendor.AgGridApi }) => { _api = params.api; },
  };
  agGrid.createGrid(el, gridOptions as unknown as NimbusVendor.AgGridOptions);
}

// -- PK/FK filter bar (paste-aware, multi-value — mirrors the "pomat" -----------
//    Production Order / Material filter's textarea pattern used by Table/
//    GanttFilter, since there is no pre-fetched distinct-value universe to
//    render as a checklist here — any table's key columns can carry far more
//    distinct values than could ever be listed.) --------------------------------

function _renderFilterBar(): void {
  const bar = document.getElementById('atb-filterbar');
  if (!bar) return;
  if (!_filterFields.length) {
    bar.innerHTML = `<span class="dash-filter-hint">${_esc(Util.t('ui.admin_tables_no_key_columns'))}</span>`;
    return;
  }
  bar.innerHTML =
    `<span class="dash-filter-label">${_esc(Util.t('ui.filter_label'))}</span>` +
    _filterFields.map((field) => {
      const col = _columns.find((c) => c.name === field);
      const kind = col?.is_pk ? 'PK' : 'FK';
      return `
      <div class="dash-filter-group">
        <button type="button" class="dash-filter-btn" data-atb-filter-toggle="${_esc(field)}">
          <span class="atb-filter-kind">${_esc(kind)}</span>
          <span id="atb-filter-label-${_esc(field)}"></span>
          <span class="dash-filter-arrow">▾</span>
        </button>
        <div class="dash-filter-dropdown dash-filter-pomat-panel" id="atb-filter-dropdown-${_esc(field)}" hidden>
          <textarea class="dash-filter-pomat-textarea" rows="5" id="atb-filter-textarea-${_esc(field)}"
                    placeholder="${_esc(Util.t('ph.admin_tables_filter_values'))}"></textarea>
          <div class="dash-filter-pomat-actions">
            <span class="dash-filter-pomat-count" id="atb-filter-count-${_esc(field)}"></span>
            <button type="button" class="btn btn-ghost sm" data-atb-filter-clear="${_esc(field)}">${_esc(Util.t('btn.clear_pasted'))}</button>
          </div>
        </div>
      </div>`;
    }).join('') +
    `<button type="button" class="dash-filter-clear" id="atb-filter-clear-all" ${_hasAnyFilter() ? '' : 'hidden'}>${_esc(Util.t('btn.clear_filters'))}</button>` +
    `<span class="dash-filter-hint" id="atb-filter-hint"></span>`;
  _wireFilterBar();
  for (const f of _filterFields) _refreshFilterLabel(f);
  _refreshFilterHint();
}

function _wireFilterBar(): void {
  const bar = document.getElementById('atb-filterbar');
  if (!bar) return;

  bar.querySelectorAll<HTMLButtonElement>('[data-atb-filter-toggle]').forEach((btn) => {
    const field = btn.dataset.atbFilterToggle!;
    btn.onclick = () => {
      const dd = document.getElementById(`atb-filter-dropdown-${field}`);
      const willOpen = !!dd?.hidden;
      bar.querySelectorAll<HTMLElement>('.dash-filter-dropdown').forEach((d) => { d.hidden = true; });
      if (dd && willOpen) {
        dd.hidden = false;
        (document.getElementById(`atb-filter-textarea-${field}`) as HTMLTextAreaElement | null)?.focus();
      }
    };
  });

  bar.querySelectorAll<HTMLButtonElement>('[data-atb-filter-clear]').forEach((btn) => {
    const field = btn.dataset.atbFilterClear!;
    btn.onclick = () => {
      const ta = document.getElementById(`atb-filter-textarea-${field}`) as HTMLTextAreaElement | null;
      if (ta) ta.value = '';
      _applyFilterField(field, '');
    };
  });

  document.getElementById('atb-filter-clear-all')?.addEventListener('click', () => AdminTables._clearAllFilters());

  for (const field of _filterFields) {
    const ta = document.getElementById(`atb-filter-textarea-${field}`) as HTMLTextAreaElement | null;
    if (!ta) continue;
    ta.value = [..._filterValues.get(field) ?? []].join('\n');
    ta.addEventListener('input', Util.debounce(() => _applyFilterField(field, ta.value), 250));
  }
}

// Outside-click closes any open filter dropdown — wired once (skeleton build),
// not re-wired on every _renderFilterBar rebuild.
function _wireOutsideClickCloser(): void {
  document.addEventListener('click', (e) => {
    const bar = document.getElementById('atb-filterbar');
    if (!bar || bar.contains(e.target as Node)) return;
    bar.querySelectorAll<HTMLElement>('.dash-filter-dropdown').forEach((d) => { d.hidden = true; });
  }, true);
}

function _applyFilterField(field: string, text: string): void {
  const values = parseFilterPasteText(text);
  _filterValues.set(field, new Set(values));
  const cnt = document.getElementById(`atb-filter-count-${field}`);
  if (cnt) cnt.textContent = values.length ? Util.t('ui.admin_tables_filter_count', { count: values.length }) : '';
  _refreshFilterLabel(field);
  _refreshFilterHint();
  if (!_selectedTable) return;
  _meta = { ..._meta, offset: 0 };
  void _loadRows(_selectedTable, { resetGrid: false });
}

function _refreshFilterLabel(field: string): void {
  const label = document.getElementById(`atb-filter-label-${field}`);
  const btn = label?.closest('.dash-filter-btn') as HTMLElement | null;
  const sel = _filterValues.get(field) ?? new Set<string>();
  Util.refreshMultiSelectLabel(label, btn, sel, {
    allKey: 'ui.filter_all', allVars: { label: field }, nKey: 'ui.filter_n_selected',
  });
}

function _refreshFilterHint(): void {
  const clearAll = document.getElementById('atb-filter-clear-all');
  if (clearAll) clearAll.hidden = !_hasAnyFilter();
}

// -- Pagination -------------------------------------------------------------------

function _renderPagination(): void {
  const info = document.getElementById('atb-page-info');
  const prev = document.getElementById('atb-prev-btn') as HTMLButtonElement | null;
  const next = document.getElementById('atb-next-btn') as HTMLButtonElement | null;
  if (!info || !prev || !next) return;
  if (!_selectedTable) { info.textContent = ''; prev.disabled = true; next.disabled = true; return; }
  const from = _meta.total === 0 ? 0 : _meta.offset + 1;
  const to = Math.min(_meta.offset + _rows.length, _meta.total);
  info.textContent = _loadingRows
    ? Util.t('ui.admin_tables_loading')
    : Util.t('ui.admin_tables_showing', { from, to, total: _meta.total.toLocaleString() });
  prev.disabled = _loadingRows || _meta.offset <= 0;
  next.disabled = _loadingRows || (_meta.offset + _rows.length) >= _meta.total;
}

// -- CSV export -------------------------------------------------------------------

// A trailing line starting with this prefix (admin_tables.TRUNCATION_MARKER_PREFIX
// on the backend) means the export hit the ~250k soft cap — see stream_csv_rows'
// docstring. Only the last few KB of the blob are inspected so a check on a
// large export never re-parses the whole file client-side.
const _TRUNCATION_RE = /# NIMBUS_TRUNCATED,resume_offset=(\d+),rows_written=(\d+)/;

async function _exportCsv(): Promise<void> {
  const table = _selectedTable;
  if (!table) return;
  const params = buildTableQueryParams(_filterValues);
  const qs = params.toString();
  const url = `${Config.API_BASE}/admin/tables/${encodeURIComponent(table)}/export.csv${qs ? `?${qs}` : ''}`;
  try {
    const res = await Util.fetchTraced(url);
    if (!res.ok) {
      const err = await Util.parseBackendError(res);
      throw new Error(err.message);
    }
    const blob = await res.blob();
    let resumeOffset: number | null = null;
    try {
      const tailText = await blob.slice(Math.max(0, blob.size - 4096)).text();
      const m = tailText.match(_TRUNCATION_RE);
      if (m) resumeOffset = Number(m[1]);
    } catch { /* best-effort truncation check only — never blocks the download */ }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${table}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    if (resumeOffset != null) {
      Toast.show(Util.t('toast.admin_tables_export_truncated', { offset: resumeOffset }), 'warn', 6000);
    } else {
      Toast.show(Util.t('toast.admin_tables_export_done', { table }), 'success');
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    ErrorLog.error('admin-tables', `CSV export failed for ${table}: ${msg}`);
    Toast.show(Util.t('toast.export_failed', { msg }), 'error');
  }
}

// -- Detail pane show/hide + header ------------------------------------------------

function _renderDetailEmpty(): void {
  const empty = document.getElementById('atb-detail-empty');
  const content = document.getElementById('atb-detail-content');
  if (content) content.hidden = true;
  if (empty) {
    empty.hidden = false;
    if (typeof NIMBUS !== 'undefined' && NIMBUS.EmptyState) {
      NIMBUS.EmptyState.render?.(empty, {
        title: Util.t('empty.admin_tables_select_title'),
        msg: Util.t('empty.admin_tables_select_msg'),
      });
    }
  }
  _renderPagination();
}

function _showDetailContent(): void {
  const empty = document.getElementById('atb-detail-empty');
  const content = document.getElementById('atb-detail-content');
  if (empty) empty.hidden = true;
  if (content) content.hidden = false;
}

function _renderTableMeta(): void {
  if (!_selectedTable) return;
  const entry = _tables.find((t) => t.table === _selectedTable);
  const nameEl = document.getElementById('atb-detail-name');
  const metaEl = document.getElementById('atb-detail-meta');
  if (nameEl) nameEl.textContent = _selectedTable;
  if (metaEl) {
    const rowsLabel = _esc(Util.t('ui.admin_tables_approx_rows', { count: (entry?.approx_row_count ?? 0).toLocaleString() }));
    metaEl.innerHTML = entry?.internal
      ? `<span class="atb-internal-badge">${_esc(Util.t('ui.admin_tables_internal_badge'))}</span> ${rowsLabel}`
      : rowsLabel;
  }
}

// -- Skeleton (built once) ---------------------------------------------------------

function _buildSkeleton(host: HTMLElement): void {
  host.innerHTML = `
    <div class="atb-console">
      <div>
        <div class="atb-rail-head">
          <input type="text" class="dash-filter-paste-input" id="atb-search"
                 placeholder="${_esc(Util.t('ph.admin_tables_search_tables'))}" autocomplete="off">
          <button type="button" class="btn btn-ghost sm" id="atb-tables-refresh" title="${_esc(Util.t('btn.refresh'))}">↻</button>
        </div>
        <div class="atb-rail" id="atb-rail"></div>
      </div>
      <div class="atb-detail">
        <div class="atb-detail-empty" id="atb-detail-empty"></div>
        <div class="atb-detail-content" id="atb-detail-content" hidden>
          <div class="atb-detail-head">
            <span class="atb-detail-name" id="atb-detail-name"></span>
            <span class="atb-detail-meta" id="atb-detail-meta"></span>
            <div class="atb-detail-actions">
              <button type="button" class="btn btn-ghost sm" id="atb-refresh-btn">${_esc(Util.t('btn.refresh'))}</button>
              <button type="button" class="btn btn-ghost sm" id="atb-export-btn">${_esc(Util.t('btn.export_csv'))}</button>
            </div>
          </div>
          <div class="dash-filter-bar" id="atb-filterbar"></div>
          <div id="atb-grid" class="ag-theme-quartz"></div>
          <div class="atb-pagination">
            <button type="button" class="btn btn-ghost sm" id="atb-prev-btn" disabled>&lsaquo; ${_esc(Util.t('btn.admin_tables_prev'))}</button>
            <button type="button" class="btn btn-ghost sm" id="atb-next-btn" disabled>${_esc(Util.t('btn.admin_tables_next'))} &rsaquo;</button>
            <select id="atb-page-size" title="${_esc(Util.t('ui.admin_tables_page_size'))}">
              ${PAGE_SIZES.map((n) => `<option value="${n}"${n === _meta.limit ? ' selected' : ''}>${n}</option>`).join('')}
            </select>
            <span id="atb-page-info"></span>
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById('atb-search')?.addEventListener('input', (e) => {
    _tableSearch = (e.target as HTMLInputElement).value;
    _renderRail();
  });
  document.getElementById('atb-tables-refresh')?.addEventListener('click', () => void _loadTables());
  document.getElementById('atb-rail')?.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-atb-table]');
    if (row?.dataset.atbTable) void AdminTables._selectTable(row.dataset.atbTable);
  });
  document.getElementById('atb-rail')?.addEventListener('keydown', (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key !== 'Enter' && ke.key !== ' ') return;
    const row = (ke.target as HTMLElement).closest<HTMLElement>('[data-atb-table]');
    if (row?.dataset.atbTable) { ke.preventDefault(); void AdminTables._selectTable(row.dataset.atbTable); }
  });
  document.getElementById('atb-refresh-btn')?.addEventListener('click', () => {
    if (_selectedTable) void _loadRows(_selectedTable, { resetGrid: false });
  });
  document.getElementById('atb-export-btn')?.addEventListener('click', () => void _exportCsv());
  document.getElementById('atb-prev-btn')?.addEventListener('click', () => AdminTables._prevPage());
  document.getElementById('atb-next-btn')?.addEventListener('click', () => AdminTables._nextPage());
  document.getElementById('atb-page-size')?.addEventListener('change', (e) => {
    AdminTables._setPageSize(Number((e.target as HTMLSelectElement).value));
  });
  _wireOutsideClickCloser();
  _renderDetailEmpty();
}

// -- Public surface -----------------------------------------------------------------

export const AdminTables = {
  /** Push-activated by AdminCockpit._setSub, exactly like Interface/Security/
   *  SystemConfig's render() entry points — no separate init()/boot-time
   *  subscription is needed since this module has nothing to react to
   *  besides "the sub-tab was opened". */
  render(): void {
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    if (!_domReady) { _buildSkeleton(host); _domReady = true; }
    void _loadTables();
  },

  async _selectTable(table: string): Promise<void> {
    if (_selectedTable === table) return;
    _selectedTable = table;
    _meta = { total: 0, limit: _meta.limit, offset: 0 };
    _filterValues.clear();
    _renderRail();
    _showDetailContent();
    _renderTableMeta();
    await _loadRows(table, { resetGrid: true });
  },

  _clearAllFilters(): void {
    for (const f of _filterFields) _filterValues.set(f, new Set());
    _renderFilterBar();
    if (!_selectedTable) return;
    _meta = { ..._meta, offset: 0 };
    void _loadRows(_selectedTable, { resetGrid: false });
  },

  _prevPage(): void {
    if (!_selectedTable || _loadingRows || _meta.offset <= 0) return;
    _meta = { ..._meta, offset: Math.max(0, _meta.offset - _meta.limit) };
    void _loadRows(_selectedTable, { resetGrid: false });
  },

  _nextPage(): void {
    if (!_selectedTable || _loadingRows || (_meta.offset + _rows.length) >= _meta.total) return;
    _meta = { ..._meta, offset: _meta.offset + _meta.limit };
    void _loadRows(_selectedTable, { resetGrid: false });
  },

  _setPageSize(size: number): void {
    if (!_selectedTable || !PAGE_SIZES.includes(size as typeof PAGE_SIZES[number])) return;
    _meta = { ..._meta, limit: size, offset: 0 };
    void _loadRows(_selectedTable, { resetGrid: false });
  },
};
