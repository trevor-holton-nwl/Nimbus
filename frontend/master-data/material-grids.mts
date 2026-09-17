// master-data-grids.mts — Master Data tab's Material / Material Plant grids.
//
// Two AG Grid sub-tabs, plant-scoped server-side: only materials that have a
// material_plants row for the selected plant appear (a plant with zero
// material_plants rows renders an empty grid even if the global materials
// catalog is non-empty — see brain.py GET /master-data/_material-grid).
// Material is fully read-only; Material Plant is read-only except prt_01,
// prt_02, color, default_machine (POST /master-data/material-plants/attributes).
//
// New, standalone module (not folded into plant-and-administration.mts,
// which is already 8000+ lines carrying 8 other modules) — bridged as an 8th
// __NIMBUS_* bridge in app-entry.mjs/app.js. It is *push*-activated by
// App.gotoMasterSub (application-shell.mts), so unlike Plant/LaborPlanning it
// needs no _activeTabResolvers DI seam: visibility is read straight off the
// DOM ([hidden] on its own pane).
//
// The two grids are ~85% identical, modeled as two GridSpecs over one engine
// rather than two near-duplicate modules.
/* global agGrid, NIMBUS */
import { Config, Util, ErrorLog, Toast } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';

// -- Local type declarations -------------------------------------------------

type GridId = 'material' | 'material-plant';
type FilterMode = 'checklist' | 'bigset';

interface MaterialGridRow {
  material_id: string;
  plant?: string;
  material_type?: string;
  material_description?: string;
  base_uom?: string;
  subnetwork?: string;
  status_pl?: string;
  default_production_version?: string;
  min_lot_size?: number;
  incremental_lot_size?: number;
  prt_01?: string | null;
  prt_02?: string | null;
  color?: string | null;
  default_machine?: string | null;
  [key: string]: unknown;
}

interface MasterDataGridColumn {
  column_name: string;
  display_label: string;
  is_locked: boolean;
  column_order?: number;
  source_table?: string;
  editable?: boolean;
}

interface MasterDataGridResponse {
  columns: MasterDataGridColumn[];
  rows: MaterialGridRow[];
  meta?: { total: number; plant?: string };
}

interface ColSpec {
  field: string;
  i18n: string;
  width?: number;
  numeric?: boolean;
  editable?: boolean;
  cellEditor?: unknown;
  cellEditorParams?: () => Record<string, unknown>;
  headerTooltip?: string;
  cellRenderer?: unknown;
}

interface FilterSpec {
  field: string;
  i18n: string;
  mode: FilterMode;
}

interface GridSpec {
  id: GridId;
  paneId: string;
  barId: string;
  gridId: string;
  quickId: string;
  endpoint: string;
  rowKey(row: MaterialGridRow): string;
  cols: ColSpec[];
  filters: FilterSpec[];
  editableFields: readonly string[];
  saveUrl?: string;
}

interface MatPlantPatch {
  material_id: string;
  prt_01?: string;
  prt_02?: string;
  color?: string;
  default_machine?: string;
}

interface GridState {
  api: NimbusVendor.AgGridApi | null;
  rows: MaterialGridRow[];
  plant: string | null;
  inflight: AbortController | null;
  selected: Map<string, Set<string>>;
  distinct: Map<string, string[]>;
  distinctSet: Map<string, Set<string>>;
  search: Map<string, string>;
  dirty: Map<string, MatPlantPatch>;
  baseline: Map<string, { prt_01: string; prt_02: string; color: string; default_machine: string }>;
  readOnly: boolean;
  saving: boolean;
  loaded: boolean;
}

// -- Cell renderers ---------------------------------------------------------

// Renderer for default_machine column that adds a tooltip for unknown machines.
function _mkDefaultMachineRenderer() {
  return class {
    _eGui!: HTMLDivElement;
    init(params: { value: unknown }): void {
      this._eGui = document.createElement('div');
      const value = params.value;
      if (value && typeof value === 'string' && value.trim()) {
        const machines = Store.linesForSelectedPlant();
        if (!machines.includes(value.trim())) {
          this._eGui.textContent = String(value);
          this._eGui.title = Util.t('ui.unknown_machine_tooltip');
          return;
        }
      }
      this._eGui.textContent = String(value || '');
    }
    getGui(): HTMLDivElement { return this._eGui; }
    refresh(): boolean { return false; }
  };
}

// -- Grid definitions ---------------------------------------------------------

const CHECKLIST_CAP = 500;
const BIGSET_CAP = 300;

const SPECS: Record<GridId, GridSpec> = {
  material: {
    id: 'material',
    paneId: 'md-master-material-pane',
    barId: 'md-mat-filterbar',
    gridId: 'md-mat-grid',
    quickId: 'md-mat-quick',
    endpoint: '_material-grid',
    rowKey: r => String(r.material_id),
    cols: [
      { field: 'material_id',          i18n: 'col.material_id' },
      { field: 'material_description', i18n: 'col.material_desc' },
      { field: 'material_type',        i18n: 'col.material_type' },
      { field: 'base_uom',             i18n: 'col.base_uom' },
    ],
    filters: [
      { field: 'material_id',          i18n: 'col.material_id',   mode: 'bigset' },
      { field: 'material_type',        i18n: 'col.material_type', mode: 'checklist' },
      { field: 'material_description', i18n: 'col.material_desc', mode: 'bigset' },
    ],
    editableFields: [],
  },
  'material-plant': {
    id: 'material-plant',
    paneId: 'md-master-material-plant-pane',
    barId: 'md-mp-filterbar',
    gridId: 'md-mp-grid',
    quickId: 'md-mp-quick',
    endpoint: '_material-plant-grid',
    rowKey: r => `${r.material_id}|${r.plant}`,
    cols: [
      { field: 'material_id',                i18n: 'col.material_id' },
      { field: 'material_description',       i18n: 'col.material_desc' },
      { field: 'material_type',               i18n: 'col.material_type' },
      { field: 'subnetwork',                  i18n: 'col.subnetwork' },
      { field: 'status_pl',                   i18n: 'col.status_pl' },
      { field: 'default_production_version',  i18n: 'col.default_production_version' },
      { field: 'min_lot_size',                i18n: 'col.min_lot_size', numeric: true },
      { field: 'incremental_lot_size',        i18n: 'col.incremental_lot_size', numeric: true },
      { field: 'prt_01',                      i18n: 'col.prt_01', width: 170, editable: true },
      { field: 'prt_02',                      i18n: 'col.prt_02', width: 170, editable: true },
      { field: 'color',                       i18n: 'col.color',  width: 130, editable: true },
      { field: 'default_machine',          i18n: 'col.default_machine', width: 170, editable: true,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: () => ({
          values: ['', ...Store.linesForSelectedPlant()],
        }),
        cellRenderer: _mkDefaultMachineRenderer(),
        headerTooltip: 'col.default_machine_hint',  // Locale key, resolved in _buildColumnDefs
      },
    ],
    filters: [
      { field: 'material_id',                i18n: 'col.material_id',   mode: 'bigset' },
      { field: 'status_pl',                  i18n: 'col.status_pl',     mode: 'checklist' },
      { field: 'prt_01',                     i18n: 'col.prt_01',        mode: 'checklist' },
      { field: 'prt_02',                     i18n: 'col.prt_02',        mode: 'checklist' },
      { field: 'color',                      i18n: 'col.color',         mode: 'checklist' },
    ],
    editableFields: ['prt_01', 'prt_02', 'color', 'default_machine'] as const,
    saveUrl: '/master-data/material-plants/attributes',
  },
};

const MP_EDITABLE: readonly ('prt_01' | 'prt_02' | 'color' | 'default_machine')[] =
  ['prt_01', 'prt_02', 'color', 'default_machine'];

function _mkState(): GridState {
  return {
    api: null, rows: [], plant: null, inflight: null,
    selected: new Map(), distinct: new Map(), distinctSet: new Map(), search: new Map(),
    dirty: new Map(), baseline: new Map(), readOnly: false, saving: false, loaded: false,
  };
}

const _state: Record<GridId, GridState> = {
  material: _mkState(),
  'material-plant': _mkState(),
};

for (const spec of Object.values(SPECS)) {
  for (const f of spec.filters) _state[spec.id].selected.set(f.field, new Set());
}

// -- Filter predicate ---------------------------------------------------------

function _hasFilters(id: GridId): boolean {
  for (const s of _state[id].selected.values()) if (s.size) return true;
  return false;
}

function _rowPasses(spec: GridSpec, d: MaterialGridRow | null): boolean {
  if (!d) return false;
  const sel = _state[spec.id].selected;
  for (const f of spec.filters) {
    const s = sel.get(f.field);
    if (s && s.size && !s.has(String(d[f.field] ?? ''))) return false;
  }
  return true;
}

// Canonicalizes filterable fields to trimmed strings IN PLACE (so
// doesExternalFilterPass stays a bare Set.has with zero per-row work) and
// derives each filter's distinct-value universe in the same pass.
function _indexRows(spec: GridSpec, rows: MaterialGridRow[]): void {
  const st = _state[spec.id];
  const sets = new Map<string, Set<string>>(spec.filters.map(f => [f.field, new Set<string>()]));
  for (const r of rows) {
    for (const f of spec.filters) {
      const v = r[f.field] == null ? '' : String(r[f.field]).trim();
      (r as Record<string, unknown>)[f.field] = v;
      if (v) sets.get(f.field)!.add(v);
    }
  }
  st.distinctSet = sets;
  st.distinct = new Map([...sets].map(([k, s]) =>
    [k, [...s].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))]));
}

// -- Data loading --------------------------------------------------------------

function _resetGridForPlant(spec: GridSpec): void {
  const st = _state[spec.id];
  st.rows = [];
  st.plant = null;
  st.loaded = false;
  st.dirty.clear();
  st.baseline.clear();
  for (const s of st.selected.values()) s.clear();
  st.distinct.clear();
  st.distinctSet.clear();
  if (st.api) {
    try { st.api.setGridOption('rowData', []); } catch {}
  }
}

async function _load(spec: GridSpec, plant: string): Promise<void> {
  const st = _state[spec.id];
  if (st.inflight) st.inflight.abort();
  const controller = new AbortController();
  st.inflight = controller;
  st.loaded = false;
  const url = `${Config.API_BASE}/master-data/${spec.endpoint}?plant=${encodeURIComponent(plant)}`;
  const t0 = performance.now();
  try {
    const res = await Util.fetchTraced(url, { signal: controller.signal });
    if (Store.selectedPlant !== plant) return; // stale response — plant changed mid-flight
    if (!res.ok) {
      const err = await Util.parseBackendError(res);
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    const body = await res.json() as MasterDataGridResponse;
    if (Store.selectedPlant !== plant) return;
    st.rows = body.rows || [];
    _indexRows(spec, st.rows);
    if (spec.editableFields.length) {
      st.baseline.clear();
      for (const r of st.rows) {
        st.baseline.set(spec.rowKey(r), {
          prt_01: String(r.prt_01 ?? ''), prt_02: String(r.prt_02 ?? ''), color: String(r.color ?? ''),
          default_machine: String(r.default_machine ?? ''),
        });
      }
    }
    st.plant = plant;
    st.loaded = true;
    st.readOnly = false;
    if (st.api) {
      st.api.setGridOption('rowData', st.rows);
      _rebuildAllFilterBars(spec);
    }
    ErrorLog.info('material-grids', `${spec.id} grid loaded ${st.rows.length} row(s) for plant ${plant} in ${Math.round(performance.now() - t0)}ms`);
  } catch (e: unknown) {
    if ((e as { name?: string })?.name === 'AbortError') return;
    const msg = e instanceof Error ? e.message : String(e);
    ErrorLog.error('material-grids', `${spec.id} grid load failed: ${msg}`);
    Toast.show(msg, 'error');
  } finally {
    if (st.inflight === controller) st.inflight = null;
  }
}

// -- Filter bar (generic, config-driven) --------------------------------------

function _renderFilterBar(spec: GridSpec): void {
  const bar = document.getElementById(spec.barId);
  if (!bar) return;
  bar.innerHTML =
    `<span class="dash-filter-label">${Util.escapeHtml(Util.t('ui.filter_label'))}</span>` +
    spec.filters.map(f => `
      <div class="dash-filter-group">
        <button class="dash-filter-btn" data-mdf="${Util.escapeHtml(f.field)}">
          <span class="mdf-label" id="${spec.barId}-${f.field}-label"></span>
          <span class="dash-filter-arrow">▾</span>
        </button>
        <div class="dash-filter-dropdown" id="${spec.barId}-${f.field}-dropdown" hidden>
          <div class="dash-filter-paste-row">
            <input type="text" class="dash-filter-paste-input" id="${spec.barId}-${f.field}-search"
                   placeholder="${Util.escapeHtml(Util.t('ph.search_or_paste'))}"
                   title="${Util.escapeHtml(Util.t('tip.search_or_paste'))}" autocomplete="off">
          </div>
          <div class="dash-filter-checklist" id="${spec.barId}-${f.field}-checklist"></div>
          <div class="dash-filter-hint" id="${spec.barId}-${f.field}-cap" hidden></div>
        </div>
      </div>`).join('') +
    `<button class="dash-filter-clear" id="${spec.barId}-clear" hidden>${Util.escapeHtml(Util.t('btn.clear_filters'))}</button>` +
    `<span class="dash-filter-hint" id="${spec.barId}-hint"></span>`;
  _wireFilterBar(spec);
}

function _wireFilterBar(spec: GridSpec): void {
  const bar = document.getElementById(spec.barId);
  if (!bar) return;

  bar.querySelectorAll<HTMLButtonElement>('.dash-filter-btn[data-mdf]').forEach(btn => {
    const field = btn.dataset.mdf!;
    btn.onclick = () => {
      const dd = document.getElementById(`${spec.barId}-${field}-dropdown`);
      const willOpen = !!dd?.hidden;
      bar.querySelectorAll<HTMLElement>('.dash-filter-dropdown').forEach(d => { d.hidden = true; });
      if (dd && willOpen) {
        dd.hidden = false;
        _rebuildFilterChecklist(spec, field);
        const input = document.getElementById(`${spec.barId}-${field}-search`) as HTMLInputElement | null;
        input?.focus();
      }
    };
  });

  document.addEventListener('click', e => {
    if (!bar.contains(e.target as Node)) {
      bar.querySelectorAll<HTMLElement>('.dash-filter-dropdown').forEach(d => { d.hidden = true; });
    }
  }, true);

  document.getElementById(`${spec.barId}-clear`)?.addEventListener('click', () => MaterialGrids._clearFilters(spec.id));

  for (const f of spec.filters) {
    const input = document.getElementById(`${spec.barId}-${f.field}-search`) as HTMLInputElement | null;
    if (!input) continue;
    input.addEventListener('input', () => {
      _state[spec.id].search.set(f.field, input.value);
      _rebuildFilterChecklist(spec, f.field);
    });
    if (f.mode === 'checklist') {
      Util.wirePasteToCheckboxes(input, () =>
        Array.from(document.querySelectorAll<HTMLInputElement>(`#${CSS.escape(spec.barId)}-${f.field}-checklist input[type=checkbox]`)));
    } else {
      // bigset: paste must match the FULL distinct universe, not just the
      // rendered/capped rows — Util.matchPasteToCheckboxes only sees DOM
      // checkboxes, which under BIGSET_CAP would silently under-match.
      input.addEventListener('paste', e => {
        e.preventDefault();
        const text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
        input.value = '';
        if (!text.trim()) return;
        const pasted = [...new Set(Util.parsePasteList(text).map(v => v.toLowerCase()))];
        const known = _state[spec.id].distinctSet.get(f.field) ?? new Set<string>();
        const sel = _state[spec.id].selected.get(f.field)!;
        let matched = 0;
        for (const known_v of known) {
          if (pasted.includes(known_v.toLowerCase())) { sel.add(known_v); matched++; }
        }
        Toast.show(Util.t('toast.paste_checkbox_match', { matched, total: pasted.length }),
          matched > 0 ? 'success' : 'warn');
        _rebuildFilterChecklist(spec, f.field);
        _onFilterChanged(spec, f.field);
      });
    }
  }
}

function _rebuildFilterChecklist(spec: GridSpec, field: string): void {
  const st = _state[spec.id];
  const fspec = spec.filters.find(f => f.field === field);
  if (!fspec) return;
  const checklistEl = document.getElementById(`${spec.barId}-${field}-checklist`);
  const capEl = document.getElementById(`${spec.barId}-${field}-cap`);
  const candidates = st.distinct.get(field) ?? [];
  const cap = fspec.mode === 'bigset' ? BIGSET_CAP : CHECKLIST_CAP;
  Util.renderLineChecklist(
    checklistEl, candidates, st.selected.get(field)!, st.search.get(field) ?? '',
    (value, checked) => {
      const sel = st.selected.get(field)!;
      if (checked) sel.add(value); else sel.delete(value);
      _onFilterChanged(spec, field);
    },
    {
      cap,
      onCapped: (shown, total) => {
        if (capEl) { capEl.hidden = false; capEl.textContent = Util.t('ui.filter_capped', { shown, total }); }
      },
    },
  );
  if (capEl && candidates.length <= cap) capEl.hidden = true;
}

function _rebuildAllFilterBars(spec: GridSpec): void {
  for (const f of spec.filters) {
    _refreshFilterLabel(spec, f);
    // Checklist DOM is rebuilt lazily on dropdown open (_rebuildFilterChecklist)
    // to avoid rendering candidate lists for closed dropdowns.
  }
  _refreshHint(spec);
}

function _refreshFilterLabel(spec: GridSpec, f: FilterSpec): void {
  const label = document.getElementById(`${spec.barId}-${f.field}-label`);
  const btn = label?.closest('.dash-filter-btn') as HTMLElement | null;
  const sel = _state[spec.id].selected.get(f.field)!;
  Util.refreshMultiSelectLabel(label, btn, sel, {
    allKey: 'ui.filter_all', allVars: { label: Util.t(f.i18n) },
    nKey: 'ui.filter_n_selected',
  });
  if (btn) btn.toggleAttribute('disabled', _state[spec.id].rows.length === 0);
}

function _refreshHint(spec: GridSpec): void {
  const st = _state[spec.id];
  const clearBtn = document.getElementById(`${spec.barId}-clear`);
  const hint = document.getElementById(`${spec.barId}-hint`);
  const active = _hasFilters(spec.id);
  if (clearBtn) clearBtn.hidden = !active;
  if (hint && st.api) {
    try { hint.textContent = `${st.api.getDisplayedRowCount()} / ${st.rows.length}`; } catch {}
  }
}

function _onFilterChanged(spec: GridSpec, field: string): void {
  _refreshFilterLabel(spec, spec.filters.find(f => f.field === field)!);
  _refreshHint(spec);
  try { _state[spec.id].api?.onFilterChanged(); } catch {}
}

// -- Grid lifecycle ------------------------------------------------------------

function _buildColumnDefs(spec: GridSpec): unknown[] {
  const st = _state[spec.id];
  return spec.cols.map(c => {
    const colDef: Record<string, unknown> = {
      headerName: Util.t(c.i18n),
      field: c.field,
      width: c.width,
      minWidth: 100,
      flex: c.width ? 0 : 1,
      editable: !!c.editable && !st.readOnly,
      cellClass: c.numeric ? 'cell-num' : undefined,
    };

    // Build cellClassRules for editable fields
    if (c.editable) {
      const cellClassRules: Record<string, (p: { data: MaterialGridRow }) => boolean> = {
        'md-cell-dirty': (p: { data: MaterialGridRow }) => {
          const patch = st.dirty.get(spec.rowKey(p.data));
          return !!patch && c.field in patch;
        },
      };

      // Add mp-unknown-machine rule for default_machine column
      if (c.field === 'default_machine') {
        cellClassRules['mp-unknown-machine'] = (p: { data: MaterialGridRow }) => {
          const value = p.data.default_machine;
          if (!value || typeof value !== 'string' || !value.trim()) return false;
          const machines = Store.linesForSelectedPlant();
          return !machines.includes(value.trim());
        };
      }

      colDef.cellClassRules = cellClassRules;
    } else {
      colDef.cellClassRules = undefined;
    }

    // Add cell editor if specified
    if (c.cellEditor) {
      colDef.cellEditor = c.cellEditor;
    }

    // Add cell editor params if specified
    if (c.cellEditorParams) {
      colDef.cellEditorParams = c.cellEditorParams;
    }

    // Add cell renderer if specified
    if (c.cellRenderer) {
      colDef.cellRenderer = c.cellRenderer;
    }

    // Add header tooltip if specified (may be a locale key)
    if (c.headerTooltip) {
      colDef.headerTooltip = Util.t(c.headerTooltip);
    }

    // Add field tooltip for material_description
    if (c.field === 'material_description') {
      colDef.tooltipField = c.field;
    }

    return colDef;
  });
}

function _sizeSoon(spec: GridSpec): void {
  requestAnimationFrame(() => {
    const el = document.getElementById(spec.gridId);
    const st = _state[spec.id];
    if (!el || !st.api || el.clientWidth < 50) return;
    try { st.api.sizeColumnsToFit(); } catch {}
  });
}

function _mkNoRowsOverlay(spec: GridSpec) {
  return class {
    _eGui!: HTMLDivElement;
    init(): void {
      const quick = document.getElementById(spec.quickId) as HTMLInputElement | null;
      const filtered = _hasFilters(spec.id) || !!quick?.value;
      this._eGui = document.createElement('div');
      this._eGui.className = 'table-empty-overlay';
      if (typeof NIMBUS !== 'undefined' && NIMBUS.EmptyState) {
        if (filtered) {
          NIMBUS.EmptyState.render?.(this._eGui, {
            title: Util.t('empty.no_materials_filtered_title'),
            msg: Util.t('empty.no_materials_filtered_msg'),
            icon: '⌕',
          });
        } else {
          NIMBUS.EmptyState.render?.(this._eGui, spec.id === 'material'
            ? { title: Util.t('empty.no_materials_title'), msg: Util.t('empty.no_materials_msg') }
            : { title: Util.t('empty.no_material_plants_title'), msg: Util.t('empty.no_materials_plant_msg') });
        }
      }
    }
    getGui(): HTMLDivElement { return this._eGui; }
  };
}

function _createGrid(spec: GridSpec): void {
  const el = document.getElementById(spec.gridId);
  if (!el || typeof agGrid === 'undefined') return;
  const st = _state[spec.id];
  _renderFilterBar(spec);

  const gridOptions = {
    rowData: [] as MaterialGridRow[],
    getRowId: (p: { data: MaterialGridRow }) => spec.rowKey(p.data),
    rowSelection: 'multiple',
    animateRows: false,
    stopEditingWhenCellsLoseFocus: true,
    cacheQuickFilter: true,
    defaultColDef: { sortable: true, filter: true, resizable: true, editable: false, minWidth: 100 },
    columnDefs: _buildColumnDefs(spec),
    noRowsOverlayComponent: _mkNoRowsOverlay(spec),
    isExternalFilterPresent: () => _hasFilters(spec.id),
    doesExternalFilterPass: (node: { data: MaterialGridRow }) => _rowPasses(spec, node.data),
    onFilterChanged: () => _refreshHint(spec),
    onCellValueChanged: spec.editableFields.length ? (p: unknown) => _onCellChanged(spec, p) : undefined,
    onGridReady: (params: { api: NimbusVendor.AgGridApi }) => {
      st.api = params.api;
      const quick = document.getElementById(spec.quickId) as HTMLInputElement | null;
      if (quick) {
        let t: ReturnType<typeof setTimeout> | undefined;
        quick.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(() => { try { st.api!.setGridOption('quickFilterText', quick.value); } catch {} }, 250);
        });
      }
      if (st.rows.length) st.api.setGridOption('rowData', st.rows);
      _rebuildAllFilterBars(spec);
    },
  };

  agGrid.createGrid(el, gridOptions as unknown as NimbusVendor.AgGridOptions);

  document.getElementById(`md-${spec.id === 'material' ? 'mat' : 'mp'}-export`)?.addEventListener('click', () => {
    try { st.api?.exportDataAsCsv({ fileName: `nimbus-${spec.id}.csv` }); } catch {}
  });

  if (spec.saveUrl) {
    document.getElementById('md-mp-save')?.addEventListener('click', () => MaterialGrids._save(spec.id));
    document.getElementById('md-mp-discard')?.addEventListener('click', () => MaterialGrids._discard(spec.id));
  }
}

function _onCellChanged(spec: GridSpec, p: unknown): void {
  const params = p as { colDef: { field: string }; data: MaterialGridRow; newValue: unknown; api: NimbusVendor.AgGridApi; node: unknown };
  const field = params.colDef.field as 'prt_01' | 'prt_02' | 'color' | 'default_machine';
  if (!spec.editableFields.includes(field)) return;
  const st = _state[spec.id];
  const key = spec.rowKey(params.data);
  const baseline = st.baseline.get(key);
  const next = params.newValue == null ? '' : String(params.newValue).trim();

  let patch = st.dirty.get(key);
  if (!patch) patch = { material_id: params.data.material_id };
  if (baseline && baseline[field] === next) delete patch[field];
  else patch[field] = next;

  const hasAny = MP_EDITABLE.some(f => f in patch!);
  if (hasAny) st.dirty.set(key, patch); else st.dirty.delete(key);

  try { params.api.refreshCells({ rowNodes: [params.node], columns: [field], force: true }); } catch {}
  _updateSaveBar(spec);
}

function _updateSaveBar(spec: GridSpec): void {
  if (!spec.saveUrl) return;
  const st = _state[spec.id];
  const n = st.dirty.size;
  const saveBtn = document.getElementById('md-mp-save') as HTMLButtonElement | null;
  const discardBtn = document.getElementById('md-mp-discard');
  const dirtyBadge = document.getElementById('md-mp-dirty');
  if (saveBtn) saveBtn.disabled = n === 0 || st.saving;
  if (discardBtn) discardBtn.hidden = n === 0;
  if (dirtyBadge) {
    dirtyBadge.hidden = n === 0;
    dirtyBadge.textContent = Util.t('ui.n_unsaved', { count: n });
  }
}

// -- Save / discard -------------------------------------------------------------

async function _save(id: GridId): Promise<void> {
  const spec = SPECS[id];
  const st = _state[id];
  if (!spec.saveUrl || !st.dirty.size || st.saving || !st.plant) return;
  st.saving = true;
  _updateSaveBar(spec);
  const updates = [...st.dirty.values()];
  try {
    const res = await Util.fetchTraced(`${Config.API_BASE}${spec.saveUrl}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plant: st.plant, updates }),
    });
    if (!res.ok) {
      const err = await Util.parseBackendError(res);
      const e = new Error(err.message || `HTTP ${res.status}`) as Error & { status?: number };
      e.status = res.status;
      throw e;
    }
    const body = await res.json() as { updated?: number; columns?: string[] };
    for (const u of updates) {
      const key = `${u.material_id}|${st.plant}`;
      const row = st.rows.find(r => spec.rowKey(r) === key);
      if (!row) continue;
      for (const f of MP_EDITABLE) if (f in u) (row as Record<string, unknown>)[f] = (u as unknown as Record<string, unknown>)[f] ?? '';
      st.baseline.set(key, {
        prt_01: String(row.prt_01 ?? ''), prt_02: String(row.prt_02 ?? ''), color: String(row.color ?? ''),
        default_machine: String(row.default_machine ?? ''),
      });
    }
    try {
      if (st.api) {
        const nodes = updates.map(u => st.api!.getRowNode(`${u.material_id}|${st.plant}`)).filter(Boolean);
        st.api.applyTransaction({ update: nodes.map((n: unknown) => (n as { data: MaterialGridRow }).data) });
      }
    } catch {}
    st.dirty.clear();
    _indexRows(spec, st.rows); // prt_01/prt_02/color distinct sets may have changed
    Toast.show(Util.t('toast.material_plant_saved', { count: body.updated ?? updates.length }), 'success');
  } catch (e: unknown) {
    const status = (e as { status?: number })?.status;
    const msg = e instanceof Error ? e.message : String(e);
    if (status === 403) {
      st.readOnly = true;
      try { st.api?.setColumnDefs(_buildColumnDefs(spec)); } catch {}
      Toast.show(Util.t('toast.no_write_permission'), 'error');
    } else {
      Toast.show(Util.t('toast.material_plant_save_failed', { msg }), 'error');
    }
    ErrorLog.error('material-grids', `save failed: ${msg}`);
    // Dirty map deliberately NOT cleared on failure — the user keeps their
    // edits (and the cell values) so they can retry or copy them out.
  } finally {
    st.saving = false;
    _updateSaveBar(spec);
  }
}

function _discard(id: GridId): void {
  const spec = SPECS[id];
  const st = _state[id];
  if (!st.dirty.size) return;
  for (const key of st.dirty.keys()) {
    const row = st.rows.find(r => spec.rowKey(r) === key);
    const base = st.baseline.get(key);
    if (!row || !base) continue;
    row.prt_01 = base.prt_01; row.prt_02 = base.prt_02; row.color = base.color;
    row.default_machine = base.default_machine;
  }
  st.dirty.clear();
  try {
    if (st.api) st.api.applyTransaction({ update: st.rows });
  } catch {}
  _updateSaveBar(spec);
}

function _clearFilters(id: GridId): void {
  const spec = SPECS[id];
  const st = _state[id];
  for (const s of st.selected.values()) s.clear();
  for (const f of spec.filters) {
    st.search.set(f.field, '');
    const input = document.getElementById(`${spec.barId}-${f.field}-search`) as HTMLInputElement | null;
    if (input) input.value = '';
  }
  _rebuildAllFilterBars(spec);
  try { st.api?.onFilterChanged(); } catch {}
}

// -- Empty-plant / no-plant states ----------------------------------------------

function _showNoPlant(spec: GridSpec): void {
  const pane = document.getElementById(spec.paneId);
  const gridEl = document.getElementById(spec.gridId);
  if (gridEl) gridEl.style.display = 'none';
  if (!pane) return;
  let holder = pane.querySelector<HTMLDivElement>('.md-no-plant');
  if (!holder) {
    holder = document.createElement('div');
    holder.className = 'md-no-plant';
    holder.style.flex = '1';
    pane.appendChild(holder);
  }
  holder.hidden = false;
  if (typeof NIMBUS !== 'undefined' && NIMBUS.EmptyState) {
    NIMBUS.EmptyState.render?.(holder, { title: Util.t('ui.select_plant_materials'), msg: '' });
  }
}

function _hideNoPlant(spec: GridSpec): void {
  const pane = document.getElementById(spec.paneId);
  const gridEl = document.getElementById(spec.gridId);
  if (gridEl) gridEl.style.display = '';
  const holder = pane?.querySelector<HTMLDivElement>('.md-no-plant');
  if (holder) holder.hidden = true;
}

// -- Public surface --------------------------------------------------------------

export const MaterialGrids = {
  init(): void {
    Store.subscribe(evt => {
      if (evt.type !== 'plant:selected') return;
      // Plant changed — both grids' cached rows are for the OLD plant.
      // Evict both; only the currently-visible one re-fetches (render() is
      // re-invoked by gotoMasterSub for the active sub-tab).
      for (const spec of Object.values(SPECS)) {
        if (_state[spec.id].dirty.size) {
          Toast.show(Util.t('ui.n_unsaved', { count: _state[spec.id].dirty.size }), 'warn');
        }
        _resetGridForPlant(spec);
      }
      const activePane = Object.values(SPECS).find(s => {
        const el = document.getElementById(s.paneId);
        return el && !el.hidden;
      });
      if (activePane) MaterialGrids.render(activePane.id);
    }, 'MaterialGrids');
  },

  render(which: GridId): void {
    const spec = SPECS[which];
    if (!spec) return;
    const plant = Store.selectedPlant;
    if (!plant) { _showNoPlant(spec); return; }
    _hideNoPlant(spec);
    const st = _state[which];
    if (!st.api) _createGrid(spec);
    if (st.plant !== plant) _load(spec, plant);
    _sizeSoon(spec);
  },

  _save(id: GridId): void { void _save(id); },
  _discard(id: GridId): void { _discard(id); },
  _clearFilters(id: GridId): void { _clearFilters(id); },
};
