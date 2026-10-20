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
import { Config, Util, ErrorLog, Toast, Modal } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';

// -- Local type declarations -------------------------------------------------

type GridId = 'material' | 'material-plant' | 'routing-pv';
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
  cellEditorPopup?: boolean;
  cellEditorParams?: () => Record<string, unknown>;
  headerTooltip?: string;
  cellRenderer?: unknown;
  valueFormatter?: (p: { value: unknown }) => string;
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

interface PendingWrite {
  updates: MatPlantPatch[];
  succeeded: boolean;
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
  drafts: Map<string, MatPlantPatch[]>;
  baseline: Map<string, { prt_01: string; prt_02: string; color: string; default_machine: string }>;
  readOnly: boolean;
  writes: Map<string, PendingWrite>;
  edited: Map<string, Set<string>>;
  loaded: boolean;
  generation: number;
}

// -- Cell editors / renderers -------------------------------------------------

// Searchable default-machine editor (D61): same type-to-filter / arrow-key / Enter
// interaction and hps-* markup as admin-ui's _mkCombobox, as an AG Grid popup editor,
// replacing agSelectCellEditor, which is an unsearchable <select> over 70+ machines.
// Free text is never committed: only an option (or the cleared '') becomes the value.
function _mkMachineComboEditor() {
  return class {
    _eGui!: HTMLDivElement;
    _input!: HTMLInputElement;
    _value = '';
    _options: string[] = [];
    _filtered: string[] = [];
    _active = 0;
    _params!: { value: unknown; values?: string[]; stopEditing: (cancel?: boolean) => void };
    init(params: { value: unknown; values?: string[]; stopEditing: (cancel?: boolean) => void }): void {
      this._params = params;
      this._value = params.value == null ? '' : String(params.value);
      this._options = (params.values || []).filter(Boolean);
      this._eGui = document.createElement('div');
      this._eGui.className = 'hps-combobox md-bom-combobox has-value';
      this._eGui.innerHTML = `<input type="text" class="hps-input" autocomplete="off" spellcheck="false" aria-haspopup="listbox" aria-expanded="true" placeholder="${Util.escapeHtml(Util.t('ph.default_machine_search'))}"><div class="hps-dropdown" role="listbox"></div>`;
      this._input = this._eGui.querySelector('.hps-input') as HTMLInputElement;
      this._input.value = this._value;
      const dropdown = this._eGui.querySelector('.hps-dropdown') as HTMLElement;
      const render = (query: string): void => {
        const q = query.trim().toLowerCase();
        const unchanged = q === this._value.toLowerCase();
        this._filtered = q && !unchanged ? this._options.filter(o => o.toLowerCase().includes(q)) : this._options.slice();
        if (!this._filtered.length) { dropdown.innerHTML = `<div class="hps-empty">${Util.escapeHtml(Util.t('ui.no_matches'))}</div>`; this._active = -1; return; }
        dropdown.innerHTML = this._filtered.map((o, i) => `<div class="hps-option${o === this._value ? ' selected' : ''}${i === this._active ? ' active' : ''}" role="option" data-idx="${i}">${Util.escapeHtml(o)}</div>`).join('');
        dropdown.querySelectorAll('.hps-option').forEach((el, i) => el.addEventListener('mousedown', e => { e.preventDefault(); this._pick(this._filtered[i]); }));
      };
      render(this._value);
      this._active = Math.max(0, this._filtered.indexOf(this._value));
      render(this._value);
      this._input.addEventListener('input', () => { this._active = 0; render(this._input.value); });
      this._input.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); this._active = Math.min(this._active + 1, this._filtered.length - 1); render(this._input.value); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this._active = Math.max(this._active - 1, 0); render(this._input.value); }
        else if (e.key === 'Enter') { e.preventDefault(); if (this._filtered[this._active]) this._pick(this._filtered[this._active]); else if (!this._input.value.trim()) this._pick(''); }
        else if (e.key === 'Escape') { e.preventDefault(); this._params.stopEditing(true); }
      });
    }
    _pick(value: string): void { this._value = value; this._params.stopEditing(); }
    getGui(): HTMLDivElement { return this._eGui; }
    afterGuiAttached(): void { this._input.focus(); this._input.select(); }
    getValue(): string { return this._value; }
    isPopup(): boolean { return true; }
  };
}

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

// Formats the `machines` array (machines mapped to this row's operation
// work center) as a comma-joined list — the plain default rendering already
// comma-joins via Array.prototype.toString, but this reads better with a space.
function _fmtMachinesList(p: { value: unknown }): string {
  return Array.isArray(p.value) ? p.value.join(', ') : '';
}

// Formats a boolean as translated Yes/No text (routing_pv's
// counts_toward_runtime badge column, ROUTING_RUNTIME_DESIGN.md §7.3).
function _fmtYesNo(p: { value: unknown }): string {
  return p.value ? Util.t('ui.yes') : Util.t('ui.no');
}

// -- Grid definitions ---------------------------------------------------------

const CHECKLIST_CAP = 500;
const BIGSET_CAP = 300;

// DOM id prefix for each grid's toolbar buttons (e.g. `md-${abbr}-export`) —
// index.html's element ids abbreviate routing-pv as "rpv", not the full id.
const GRID_ABBR: Record<GridId, string> = { material: 'mat', 'material-plant': 'mp', 'routing-pv': 'rpv' };

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
        cellEditor: _mkMachineComboEditor(),
        cellEditorPopup: true,
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
  'routing-pv': {
    id: 'routing-pv',
    paneId: 'md-master-routing-pv-pane',
    barId: 'md-rpv-filterbar',
    gridId: 'md-rpv-grid',
    quickId: 'md-rpv-quick',
    endpoint: '_routing-pv-grid',
    // Unique per production-version × operation row (ROUTING_RUNTIME_DESIGN.md
    // §7.3: "rowKey = material|pv|group|counter|seq|activity"). A production
    // version with no operations yields sequence_no/activity both NULL — still
    // unique per (material, pv, group, counter) in that case.
    rowKey: r => `${r.material_id}|${r.production_version}|${r.routing_group}|${r.group_counter}|${r.sequence_no ?? ''}|${r.activity ?? ''}`,
    cols: [
      { field: 'material_id',           i18n: 'col.material_id' },
      { field: 'production_version',    i18n: 'col.routing_pv_production_version' },
      { field: 'valid_from',            i18n: 'col.routing_pv_valid_from' },
      { field: 'valid_to',              i18n: 'col.routing_pv_valid_to' },
      { field: 'task_list_type',        i18n: 'col.routing_pv_task_list_type' },
      { field: 'routing_group',         i18n: 'col.routing_pv_group' },
      { field: 'group_counter',         i18n: 'col.routing_pv_group_counter' },
      { field: 'op_sap_workcenter',     i18n: 'col.routing_pv_sap_workcenter', width: 140 },
      { field: 'sequence_no',           i18n: 'col.routing_pv_sequence_no', numeric: true, width: 100 },
      { field: 'activity',              i18n: 'col.routing_pv_activity', width: 140 },
      { field: 'workcenter_category',   i18n: 'col.routing_pv_workcenter_category', width: 150 },
      { field: 'base_quantity',         i18n: 'col.routing_pv_base_quantity', numeric: true, width: 120 },
      { field: 'std_value_machine',      i18n: 'col.routing_pv_std_value_machine', numeric: true, width: 130 },
      { field: 'std_value_unit_machine', i18n: 'col.routing_pv_std_value_unit_machine', width: 110 },
      { field: 'std_value_labor',        i18n: 'col.routing_pv_std_value_labor', numeric: true, width: 120 },
      { field: 'std_value_unit_labor',   i18n: 'col.routing_pv_std_value_unit_labor', width: 110 },
      { field: 'machines',              i18n: 'col.routing_pv_machines', width: 170, valueFormatter: _fmtMachinesList },
      { field: 'counts_toward_runtime', i18n: 'col.routing_pv_counts_toward_runtime', width: 150, valueFormatter: _fmtYesNo },
    ],
    // §7.3's filter list (Material, Task List Type, Group, Group Counter,
    // SAP Work Center) minus Plant, which is handled by the existing
    // plant-scope picker, not a filters entry — same as material-plant's own
    // plant scoping. SAP Work Center filters on the OPERATION's work center
    // (op_sap_workcenter), the field that drives `machines`/`counts_toward_runtime`
    // — not the production version header's own pv_sap_workcenter, which this
    // grid doesn't render as a column.
    filters: [
      { field: 'material_id',         i18n: 'col.material_id',                   mode: 'bigset' },
      { field: 'task_list_type',      i18n: 'col.routing_pv_task_list_type',     mode: 'checklist' },
      { field: 'routing_group',       i18n: 'col.routing_pv_group',              mode: 'checklist' },
      { field: 'group_counter',       i18n: 'col.routing_pv_group_counter',      mode: 'checklist' },
      { field: 'op_sap_workcenter',   i18n: 'col.routing_pv_sap_workcenter',     mode: 'bigset' },
    ],
    editableFields: [],
    // No saveUrl — read-only per design D12/§7.3.
  },
};

const MP_EDITABLE: readonly ('prt_01' | 'prt_02' | 'color' | 'default_machine')[] =
  ['prt_01', 'prt_02', 'color', 'default_machine'];

function _mkState(): GridState {
  return {
    api: null, rows: [], plant: null, inflight: null,
    selected: new Map(), distinct: new Map(), distinctSet: new Map(), search: new Map(),
    dirty: new Map(), drafts: new Map(), baseline: new Map(), readOnly: false, writes: new Map(), edited: new Map(),
    loaded: false, generation: 0,
  };
}

/** Quick-filter text requested through MaterialGrids.setQuickFilter before the grid was ready (applied in onGridReady). */
const _pendingQuick: Partial<Record<GridId, string>> = {};

const _state: Record<GridId, GridState> = {
  material: _mkState(),
  'material-plant': _mkState(),
  'routing-pv': _mkState(),
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
  st.generation++;
  // Keep unsaved scalar edits by plant; fresh reads establish the baseline on return.
  if (st.plant && (st.dirty.size || st.writes.has(st.plant))) {
    const patches = st.rows.flatMap(row => {
      const key = spec.rowKey(row);
      const fields = new Set(Object.keys(st.dirty.get(key) || {}));
      // A pending write can make a return to the old baseline dirty later.
      // Keep only those pending fields, never the historical edit set.
      const submitted = st.writes.get(st.plant!)?.updates.find(update => update.material_id === row.material_id);
      for (const field of MP_EDITABLE) {
        if (submitted && field in submitted && String(row[field] ?? '') !== String(submitted[field] ?? '')) fields.add(field);
      }
      const patch: MatPlantPatch = { material_id: row.material_id };
      for (const field of MP_EDITABLE) if (fields.has(field)) patch[field] = String(row[field] ?? '');
      return MP_EDITABLE.some(field => field in patch) ? [patch] : [];
    });
    if (patches.length) st.drafts.set(st.plant, patches);
  }
  st.inflight?.abort();
  st.inflight = null;
  st.rows = [];
  st.plant = null;
  st.loaded = false;
  st.dirty.clear();
  st.edited.clear();
  st.baseline.clear();
  for (const s of st.selected.values()) s.clear();
  st.distinct.clear();
  st.distinctSet.clear();
  if (st.api) {
    try { st.api.setGridOption('rowData', []); } catch {}
  }
  _updateSaveBar(spec);
}

async function _load(spec: GridSpec, plant: string): Promise<void> {
  const st = _state[spec.id];
  if (st.inflight) st.inflight.abort();
  const generation = ++st.generation;
  // Keep the write object even if it settles before this GET's response. The
  // response may have read the database before that write committed.
  const pendingWrite = st.writes.get(plant);
  const controller = new AbortController();
  st.inflight = controller;
  st.loaded = false;
  const url = `${Config.API_BASE}/master-data/${spec.endpoint}?plant=${encodeURIComponent(plant)}`;
  const t0 = performance.now();
  try {
    const res = await Util.fetchTraced(url, { signal: controller.signal });
    if (st.generation !== generation || Store.selectedPlant !== plant) return;
    if (!res.ok) {
      const err = await Util.parseBackendError(res);
      throw new Error(err.message || `HTTP ${res.status}`);
    }
    const body = await res.json() as MasterDataGridResponse;
    if (st.generation !== generation || Store.selectedPlant !== plant) return;
    st.rows = body.rows || [];
    // A patch made while this fetch was in flight targets rows that are being
    // replaced; it must not outlive them.
    st.dirty.clear();
    st.edited.clear();
    if (pendingWrite?.succeeded) {
      for (const u of pendingWrite.updates) {
        const row = st.rows.find(r => spec.rowKey(r) === `${u.material_id}|${plant}`);
        if (row) for (const f of MP_EDITABLE) if (f in u) row[f] = u[f];
      }
    }
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
    for (const patch of st.drafts.get(plant) || []) {
      const key = `${patch.material_id}|${plant}`;
      const row = st.rows.find(r => spec.rowKey(r) === key);
      const baseline = st.baseline.get(key);
      if (!row || !baseline) continue;
      const remaining: MatPlantPatch = { material_id: patch.material_id };
      for (const field of MP_EDITABLE) if (field in patch) {
        row[field] = patch[field];
        if (String(patch[field] ?? '') !== baseline[field]) remaining[field] = patch[field];
      }
      st.edited.set(key, new Set(MP_EDITABLE.filter(field => field in patch)));
      if (MP_EDITABLE.some(field => field in remaining)) st.dirty.set(key, remaining);
    }
    st.drafts.delete(plant);
    _indexRows(spec, st.rows);
    st.plant = plant;
    st.loaded = true;
    st.readOnly = false;
    _updateSaveBar(spec);
    if (st.api) {
      st.api.setGridOption('rowData', st.rows);
      _rebuildAllFilterBars(spec);
    }
    ErrorLog.info('material-grids', `${spec.id} grid loaded ${st.rows.length} row(s) for plant ${plant} in ${Math.round(performance.now() - t0)}ms`);
  } catch (e: unknown) {
    if (st.generation !== generation) return;
    if ((e as { name?: string })?.name === 'AbortError') return;
    const msg = e instanceof Error ? e.message : String(e);
    ErrorLog.error('material-grids', `${spec.id} grid load failed: ${msg}`);
    Toast.show(msg, 'error');
  } finally {
    if (st.inflight === controller) st.inflight = null;
  }
}

// Re-pull the SAME plant from the database. Unlike _resetGridForPlant (a plant
// change, which also clears the filter bar), this keeps st.selected / st.search
// so the user's filters survive; _load aborts any in-flight request, bumps the
// generation, re-indexes the rows and rebuilds the filter bars.
async function _reload(spec: GridSpec, plant: string): Promise<void> {
  // Revert any dirty cells to their baseline first (clears st.dirty), so a failed
  // or superseded fetch cannot leave discarded edits on screen. st.plant and
  // st.baseline stay intact until fresh rows land, keeping Save/dirty-detection
  // coherent with the rows still shown; _load replaces them on success.
  _discard(spec.id);
  _state[spec.id].edited.clear();
  return _load(spec, plant);
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
      if (c.cellEditorPopup) colDef.cellEditorPopup = true;
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

    // Add value formatter if specified (e.g. routing-pv's machines join, Yes/No badge)
    if (c.valueFormatter) {
      colDef.valueFormatter = c.valueFormatter;
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
          const empty: Record<GridId, { title: string; msg: string }> = {
            material: { title: Util.t('empty.no_materials_title'), msg: Util.t('empty.no_materials_msg') },
            'material-plant': { title: Util.t('empty.no_material_plants_title'), msg: Util.t('empty.no_materials_plant_msg') },
            'routing-pv': { title: Util.t('empty.no_routing_pv_title'), msg: Util.t('empty.no_routing_pv_msg') },
          };
          NIMBUS.EmptyState.render?.(this._eGui, empty[spec.id]);
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
      const pendingQuick = _pendingQuick[spec.id];
      if (pendingQuick != null) {
        delete _pendingQuick[spec.id];
        if (quick) quick.value = pendingQuick;
        try { st.api.setGridOption('quickFilterText', pendingQuick); } catch {}
      }
      _rebuildAllFilterBars(spec);
    },
  };

  agGrid.createGrid(el, gridOptions as unknown as NimbusVendor.AgGridOptions);

  document.getElementById(`md-${GRID_ABBR[spec.id]}-export`)?.addEventListener('click', () => {
    try { st.api?.exportDataAsCsv({ fileName: `nimbus-${spec.id}.csv`, processCellCallback: Util.csvProcessCell }); } catch {}
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
  let edited = st.edited.get(key);
  if (!edited) { edited = new Set(); st.edited.set(key, edited); }
  edited.add(field);
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
  if (saveBtn) saveBtn.disabled = n === 0 || (st.plant !== null && st.writes.has(st.plant));
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
  if (!spec.saveUrl || !st.dirty.size || !st.plant || st.writes.has(st.plant)) return;
  const plant = st.plant;
  const generation = st.generation;
  // Patches contain scalar values; copy each one before serializing so an
  // edit made during this request cannot change what its response acknowledges.
  const updates = [...st.dirty.values()].map(patch => ({ ...patch }));
  const pendingWrite: PendingWrite = { updates, succeeded: false };
  st.writes.set(plant, pendingWrite);
  _updateSaveBar(spec);
  try {
    const res = await Util.fetchTraced(`${Config.API_BASE}${spec.saveUrl}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plant, updates }),
    });
    if (!res.ok) {
      const err = await Util.parseBackendError(res);
      const e = new Error(err.message || `HTTP ${res.status}`) as Error & { status?: number };
      e.status = res.status;
      throw e;
    }
    const body = await res.json() as { updated?: number; columns?: string[] };
    pendingWrite.succeeded = true;
    const retained = st.drafts.get(plant);
    if (retained) {
      for (const patch of retained) {
        const submitted = updates.find(update => update.material_id === patch.material_id);
        if (!submitted) continue;
        for (const field of MP_EDITABLE) {
          if (field in submitted && patch[field] === submitted[field]) delete patch[field];
        }
      }
      const remaining = retained.filter(patch => MP_EDITABLE.some(field => field in patch));
      if (remaining.length) st.drafts.set(plant, remaining);
      else st.drafts.delete(plant);
    }
    if (st.plant !== plant) return;
    for (const u of updates) {
      const key = `${u.material_id}|${plant}`;
      const row = st.rows.find(r => spec.rowKey(r) === key);
      const previous = st.baseline.get(key);
      if (!row || !previous) continue;
      const baseline = { ...previous };
      for (const f of MP_EDITABLE) if (f in u) {
        baseline[f] = String(u[f] ?? '');
        // A returned view may have loaded before this commit. Refresh untouched
        // cells, but keep explicit edits, including a return to the old value.
        if (st.generation !== generation && !st.edited.get(key)?.has(f)) row[f] = baseline[f];
      }
      st.baseline.set(key, baseline);
      // Re-diff the current cells, including edits that returned to the OLD
      // baseline while saving and therefore disappeared from the dirty map.
      const remaining: MatPlantPatch = { material_id: row.material_id };
      for (const f of MP_EDITABLE) {
        const value = String(row[f] ?? '').trim();
        if (value !== baseline[f]) remaining[f] = value;
      }
      if (MP_EDITABLE.some(f => f in remaining)) st.dirty.set(key, remaining);
      else st.dirty.delete(key);
    }
    try {
      if (st.api) {
        const nodes = updates.map(u => st.api!.getRowNode(`${u.material_id}|${plant}`)).filter(Boolean);
        st.api.applyTransaction({ update: nodes.map((n: unknown) => (n as { data: MaterialGridRow }).data) });
      }
    } catch {}
    _indexRows(spec, st.rows); // prt_01/prt_02/color distinct sets may have changed
    if (st.generation === generation) {
      Toast.show(Util.t('toast.material_plant_saved', { count: body.updated ?? updates.length }), 'success');
    }
  } catch (e: unknown) {
    if (st.generation !== generation) return;
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
    st.writes.delete(plant);
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
          Toast.show(Util.t('ui.material_draft_retained', { plant: _state[spec.id].plant || '' }), 'warn');
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

  /**
   * Set a grid's quick-filter text from code (the Alert Monitor's routing-gap deep link, after
   * `App.gotoMasterSub('routing-pv')`). The box listener attaches only in onGridReady, so a grid that is not
   * built yet keeps the text and applies it there; a ready grid takes it at once. The box shows the text either way.
   */
  setQuickFilter(which: GridId, text: string): void {
    const spec = SPECS[which];
    if (!spec) return;
    const quick = document.getElementById(spec.quickId) as HTMLInputElement | null;
    if (quick) quick.value = text;
    const api = _state[which].api;
    if (!api) { _pendingQuick[which] = text; return; }
    delete _pendingQuick[which];
    try { api.setGridOption('quickFilterText', text); } catch {}
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

  // Master Data "Refresh": re-pull this grid for the selected plant. Resolves
  // true once the grid shows freshly fetched rows; false if the user cancelled
  // the discard prompt, no plant is selected, or the reload failed/was superseded.
  async refresh(which: GridId): Promise<boolean> {
    const spec = SPECS[which];
    if (!spec) return false;
    const plant = Store.selectedPlant;
    if (!plant) return false;
    const st = _state[which];
    if (st.dirty.size > 0) {
      const ok = await Modal.confirm({
        title: Util.t('ui.n_unsaved', { count: st.dirty.size }),
        message: Util.t('confirm.md_refresh_discard'),
        confirmLabel: Util.t('btn.discard'),
      });
      if (!ok) return false;
    }
    if (!st.api) _createGrid(spec);
    await _reload(spec, plant);
    // True only if the grid now shows freshly fetched rows for this plant; a
    // failed fetch or a superseded load leaves st.loaded false.
    return st.loaded && st.plant === plant;
  },

  _save(id: GridId): void { void _save(id); },
  _discard(id: GridId): void { _discard(id); },
  _clearFilters(id: GridId): void { _clearFilters(id); },
};
