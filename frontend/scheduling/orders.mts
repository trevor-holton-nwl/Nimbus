// scheduling/orders.mjs — Table (AG Grid orders grid), Inspector (right-side
// detail panel), ContextMenu (Gantt right-click menu), and Printer (order
// list export modal). Extracted verbatim from schedule-workbench.mts (Phase
// P3 of docs/architecture/domain-refactor-plan.md, which split that
// 10,391-line mega-module into 6 domain files) — two non-contiguous source
// ranges combined into this one file per that phase's per-domain grouping.
//
// `notifyResidualFirming` (defined here, used by Inspector/ContextMenu in
// this file) is exported for gantt.mjs's Interaction (F-key unfirm) and
// insights-ui.mjs's Dashboard (dashboard-row unfirm) to import — both of
// those files already need a real import edge to/from this one for other
// reasons (see below), so importing this small helper reuses an existing
// edge rather than adding a new one; it was never meant to be duplicated
// (the original file's own doc comment calls out all four call sites as one
// shared helper).
// `Timeline`/`TimelineNav` and `setupDiagnosticLabel`/`setupSourceLabel`/
// `SetupPresentationDetail` (type) are imported from scheduling/gantt.mjs —
// Table/Inspector's setup-observation reads, Table's line-color lookups, and
// Table's post-drag redraw/minimap-refresh calls. gantt.mjs's Interaction
// imports Table/Inspector/ContextMenu back from this file (ContextMenu.open,
// Inspector.clear/.show, and Table._api range-select/selection-sync) — an
// intrinsic mutual reference carried over unchanged from the original
// single-file module (see gantt.mts's own header comment for why this "lazy"
// ESM cycle is safe).
/* global NIMBUS */
import { Config, Util, ErrorLog, Toast, Modal } from '../platform/foundation.mjs';
import type { PasteMatcher } from '../platform/foundation.mjs';
import { Store, UndoStack } from '../platform/store.mjs';
import type { StoreEvent } from '../platform/store.mjs';
import { Alerts } from '../insights/services.mjs';
import { AlertProfileMatches } from '../insights/alert-profile-matches.mjs';
import { ALL_ALERTS_PROFILE_ID } from '../insights/alert-profiles.mjs';
import { Engine, predecessorOnMachine, deriveSetupObservation } from '../optimization/engine.mjs';
import type { SetupObservation, ManualPlacementOptions } from '../optimization/engine.mjs';
import { resolveSetup, stateForOrder } from '../setup/setup-domain.mjs';
import { Session } from '../security/session.mjs';
import { Runtime } from '../routing/runtime-client.mjs';
import { Persistence } from './persistence.mjs';
import { SetupAdmin } from '../setup/setup-admin.mjs';
import { ORDER_FIELD_CATALOG } from './order-field-catalog.mjs';
import { planningReasonText } from './planning-reason.mjs';
import { toolingRowHtml, warnUnknownToolId } from './order-tooling.mjs';
import { raiseToolInventory } from '../optimization/tool-queue-confirm.mjs';
import { Timeline, TimelineNav, setupDiagnosticLabel, setupSourceLabel } from './gantt.mjs';
import type { SetupPresentationDetail } from './gantt.mjs';
import type { NimbusTask, SetupStateKey, SetupOccurrenceOverride } from '../platform/types.mjs';

// -- Local type declarations (CQ-1 Phase 6 Task 3 conversion; scoped to
//    Table/Inspector/ContextMenu — later tasks add their own module-scoped
//    types further down this same file as they convert
//    Hierarchy/GanttFilter/Dashboard/etc.) -----------------------------------

/** Table._chipFilters's status radio value — 'late' reads Util.latenessHours,
 *  'conflict'/'atrisk' read Store.alertsByTask() severities, 'firmed' reads
 *  the union via Engine.firmingStatus. Also the shape Table._applyChipFilter's `patch.status` and
 *  the Dashboard KPI-tile-click callers (still stopgap-typed, reached only via
 *  the loose NIMBUS.Table ambient shim) pass in. */
type TableStatusFilter = 'late' | 'conflict' | 'atrisk' | 'firmed' | 'needs_planning' | 'profile';

/** Table._chipFilters — the Orders-tab filter-chip bar's live selection state. */
interface TableChipFilters {
  lines: Set<string>;
  colors: Set<string>;
  status: TableStatusFilter | null;
  dateKey: string | null;
  poMat: Set<string>;
  // Compiled from poMat on Apply (exact ids + `*` wildcard patterns); only
  // consulted while poMat is non-empty, so the plain clear() paths stay valid.
  poMatMatcher: PasteMatcher | null;
}

/** Table._currentLayout()/_applySavedLayout()/_setLayoutEnabled() — the saved
 *  grid-layout contract shape (Store.pref('gridLayout'), user tier). sortModel
 *  is derived from columnState and stored only to honor the contract shape —
 *  AG Grid v31 folds sort into columnState, so applyColumnState() alone
 *  restores sorting. */
interface TableGridLayout {
  columnState: NimbusVendor.AgGridColumnState[] | null;
  sortModel: Array<{ colId: string; sort: 'asc' | 'desc' | null }> | null;
  filterModel: Record<string, unknown> | null;
}

/** Table's Ctrl+Y range-select mode — a {row, column} anchor/active corner pair. */
interface TableRangeCell {
  rowIndex: number | null;
  colId: string;
}

/** Minimal AG Grid Column instance surface Table/ContextMenu code calls
 *  (getAllDisplayedColumns()'s elements, and the column param threaded through
 *  onCellMouseDown/onCellMouseOver/onCellKeyDown). */
interface AgGridColumn {
  getColId(): string;
  getColDef(): TableColDef;
}

/** Minimal AG Grid RowNode surface Table's range-copy/cell-mouse/cell-key-down
 *  code reads. `setSelected` added by CQ-1 Phase 6 Task 6 (Interaction.
 *  _wireTableSync's Selection→Table mirroring, via Table._api.forEachNode) —
 *  a real AG Grid RowNode method, not a Table-specific invention. */
export interface AgGridRowNode {
  data: NimbusTask;
  rowIndex: number | null;
  setSelected(selected: boolean, clearSelection?: boolean): void;
}

/** Table's own column-def shape — a precise subset of AG Grid's ColDef, scoped
 *  to the fields Table's columnDefs array actually sets. NimbusVendor.
 *  AgGridOptions itself stays structurally loose ([key: string]: unknown) per
 *  vendor.d.ts's own comment — this is Table's own precise shape assigned INTO
 *  that loose contract, not a tightening of the vendor ambient type. */
interface TableColDef {
  headerName?: string;
  field?: string;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  flex?: number;
  hide?: boolean;
  pinned?: 'left' | 'right';
  lockPosition?: boolean;
  suppressHeaderMenuButton?: boolean;
  sortable?: boolean;
  filter?: boolean;
  resizable?: boolean;
  editable?: boolean | ((p: { data: NimbusTask }) => boolean);
  checkboxSelection?: boolean;
  headerCheckboxSelection?: boolean;
  tooltipField?: string;
  headerTooltip?: string;
  cellClass?: (p: { data: NimbusTask | null }) => string;
  cellRenderer?: (p: { value: unknown; data?: NimbusTask }) => string;
  cellEditor?: unknown;
  cellEditorPopup?: boolean;
  cellEditorParams?: ((p: { data: NimbusTask }) => Record<string, unknown>) | Record<string, unknown>;
  valueGetter?: (p: { data: NimbusTask }) => unknown;
  valueFormatter?: (p: TableValueFormatterParams) => string;
  valueParser?: (p: { newValue: string }) => unknown;
  comparator?: (valueA: unknown, valueB: unknown, nodeA: AgGridRowNode, nodeB: AgGridRowNode) => number;
}

/** Shared by AG Grid's own valueFormatter invocation ({value}, from the column
 *  render pipeline) and Table's manual re-invocations from the Ctrl+C single-
 *  cell/range-copy paths (the richer object built by hand at those call sites). */
interface TableValueFormatterParams {
  value: unknown;
  data?: NimbusTask;
  node?: AgGridRowNode;
  column?: AgGridColumn;
  api?: NimbusVendor.AgGridApi;
  colDef?: TableColDef;
}

/** Table._onCellChanged — AG Grid's onCellValueChanged event, scoped to the
 *  fields that handler reads. */
interface TableCellValueChangedEvent {
  colDef: TableColDef;
  data: NimbusTask;
  newValue: unknown;
  oldValue?: unknown;
  node: AgGridRowNode;
}

/** Shared by Table's onCellMouseDown/onCellMouseOver grid options. */
interface TableCellMouseEvent {
  event: MouseEvent;
  node: AgGridRowNode;
  column: AgGridColumn;
}

/** Table's onCellKeyDown grid option — Ctrl+Y range toggle / Ctrl+C copy / Esc. */
interface TableCellKeyDownEvent {
  event: KeyboardEvent;
  api: NimbusVendor.AgGridApi;
  column: AgGridColumn;
  node: AgGridRowNode;
  data: NimbusTask;
}

/** Table.init()'s onGridReady grid option. `columnApi` is AG Grid's pre-v31
 *  column-API object — merged into the main Grid API in v31, so this field is
 *  dead (assigned, never read: Table._colApi) but kept for parity with the
 *  pre-existing runtime behavior (Global Constraints: no logic changes). */
interface TableGridReadyEvent {
  api: NimbusVendor.AgGridApi;
  columnApi?: unknown;
}

/** Table._SearchableLineEditor's AG Grid CellEditorParams — the MACHINE
 *  column's cellEditorParams() factory returns { values: () => string[] } (see
 *  columnDefs above), and AG Grid merges in `value`/`api` itself at cell-edit-
 *  start time. */
interface TableLineEditorParams {
  value: string | null;
  values: Array<string | TableLineOption> | (() => Array<string | TableLineOption>);
  api: NimbusVendor.AgGridApi;
  data?: NimbusTask;
}

/** One MACHINE-editor choice: `value` is what the editor returns, `label` is what the planner reads and filters on.
 *  Plain machine lists use value === label; a routing plant's "PV - Machine" list uses value `pv|machine`. */
interface TableLineOption { value: string; label: string }

/* =============================================================================
   TABLE — AG Grid integration with rich inline editing, filtering, and full
   two-way sync. Uses the transaction API for fast incremental updates.
   ========================================================================== */
export const Table = {
  _planningWindowLabel(task: NimbusTask): string {
    if (!task) return '';
    const plant = task.PLANT || Store.getPlantForLine(task.MACHINE);
    const rules = Store.masterData?.plants.find(row => row.plant === plant);
    const bounded = rules?.max_pull_forward_days != null || rules?.max_push_forward_days != null;
    const due = Util.sapDueDate(task);
    if (bounded && (!due || !Number.isFinite(due.getTime()))) return 'SAP due date required';
    const floor = Engine.earliestAllowedStart(task, plant);   // pull-forward start floor only
    const ceiling = Engine.latestAllowedEnd(task, plant);
    if (floor && ceiling && floor >= ceiling) {
      return `No valid window: earliest start ${Util.fmtDTReadable(floor)}; complete by ${Util.fmtDTReadable(ceiling)}`;
    }
    // The frozen horizon is a FINISH floor (2026-10-27): an unprotected order may not finish before the window edge,
    // so a completion limit before the edge leaves no valid window (equality is valid).
    const frozenEnd = Store.frozenHorizonEndFor(plant);
    if (frozenEnd && ceiling && frozenEnd > ceiling) {
      return `No valid window: finish on/after ${Util.fmtDTReadable(frozenEnd)}; complete by ${Util.fmtDTReadable(ceiling)}`;
    }
    return `${floor ? Util.fmtDTReadable(floor) : 'No start limit'} — ${ceiling ? Util.fmtDTReadable(ceiling) : 'No completion limit'}`;
  },
  _api:    null as NimbusVendor.AgGridApi | null,
  _colApi: null as unknown,
  _selectedId: null as string | null,  // for the override modal
  _noteOutsideHandler: null as ((ev: MouseEvent) => void) | null,
  _noteKeyHandler: null as ((ev: KeyboardEvent) => void) | null,
  // lines aliases the shared Store.selectedLines Set (same object, not a copy) —
  // the cross-screen production-line filter. See GanttFilter._selectedLines
  // for the identical convention and why it must never be reassigned.
  _chipFilters: { lines: Store.selectedLines, colors: new Set<string>(), status: null, dateKey: null, poMat: new Set<string>(), poMatMatcher: null } as TableChipFilters,
  _lineSearch:       '',
  _colorSearch:      '',
  _rangeMode:        false,
  _rangeAnchor:      null as TableRangeCell | null,
  _rangeActive:      null as TableRangeCell | null,
  _rangeDragOn:      false,
  _rangeHighlighted: new Set<string>(),
  _applyingLayout:   false,   // true while restoring saved layout — suppresses capture echo
  _captureTimer:     null as ReturnType<typeof setTimeout> | null,
  _fpOvrFinish:      null as NimbusVendor.FlatpickrInstance | null,  // Flatpickr instance for the override modal's finish date/time input
  _suppressSelectionEcho: false,

  /* ── Saved grid layout (pref('gridLayout'), user tier) ────────────────────
     gridLayout === null  → feature OFF: never applied on load, never captured.
     gridLayout === {...}  → feature ON: applied on grid-ready, re-captured (debounced)
                             on every column/sort/filter change. The on/off toggle in
                             User Settings derives its state from this null-ness, so
                             enabling captures the current live layout (→ non-null) and
                             disabling nulls it. Shape: { columnState, sortModel, filterModel }
                             per the settings contract; AG Grid v31 folds sort into
                             columnState, so applyColumnState() alone restores sorting —
                             sortModel is derived and stored only to honor the contract shape. */
  _layoutEnabled(): boolean { try { return Store.pref('gridLayout') != null; } catch { return false; } },

  _currentLayout(): TableGridLayout {
    if (!Table._api) return { columnState: null, sortModel: null, filterModel: null };
    let columnState: NimbusVendor.AgGridColumnState[] | null = null;
    let filterModel: Record<string, unknown> | null = null;
    let sortModel: Array<{ colId: string; sort: 'asc' | 'desc' | null }> | null = null;
    try { columnState = Table._api.getColumnState(); } catch {}
    try { filterModel = Table._api.getFilterModel(); } catch {}
    if (columnState) {
      sortModel = columnState
        .filter(c => c.sort)
        .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
        .map(c => ({ colId: c.colId, sort: c.sort ?? null }));
    }
    return { columnState, sortModel, filterModel };
  },

  // Debounced capture — guarded so programmatic restores don't echo back, and
  // a no-op while the feature is disabled.
  _captureLayout(): void {
    if (Table._applyingLayout || !Table._layoutEnabled()) return;
    clearTimeout(Table._captureTimer ?? undefined);
    Table._captureTimer = setTimeout(() => {
      if (!Table._layoutEnabled()) return;
      try { Session.setPref('gridLayout', Table._currentLayout()); } catch {}
    }, 400);
  },

  _applySavedLayout(): void {
    const layout = (() => { try { return Store.pref('gridLayout') as TableGridLayout | null; } catch { return null; } })();
    if (!layout || !Table._api) return;
    Table._applyingLayout = true;
    try {
      // A layout saved before a column was retired (Original Start, backward scheduling OQ16) still names it:
      // unknown column ids are dropped rather than handed to the grid.
      const known = (id: unknown): boolean => {
        const api = Table._api as { getColumn?: (id: string) => unknown } | null;
        return typeof api?.getColumn !== 'function' || !!api.getColumn(String(id));
      };
      if (Array.isArray(layout.columnState)) {
        const state = layout.columnState.filter(c => known(c.colId));
        // A layout saved before SAP Start existed lacks it: slot it directly before Due Date rather than letting
        // AG Grid append it at the end.
        if (known('original_start_date') && !state.some(c => c.colId === 'original_start_date')) {
          const at = state.findIndex(c => c.colId === 'original_end_date');
          if (at >= 0) state.splice(at, 0, { colId: 'original_start_date' } as (typeof state)[number]);
        }
        Table._api.applyColumnState({ state, applyOrder: true });
      }
      if (layout.filterModel && typeof layout.filterModel === 'object') {
        const filterModel = Object.fromEntries(Object.entries(layout.filterModel).filter(([id]) => known(id)));
        Table._api.setFilterModel(filterModel);
      }
    } catch (e: unknown) {
      ErrorLog.warn('table', `Apply saved grid layout failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Release the guard on the next macrotask so any events the restore fired
    // (sync or queued) are all ignored, but genuine later user edits are not.
    setTimeout(() => { Table._applyingLayout = false; }, 0);
  },

  // Turn the feature on (capture current live layout) or off (null it + reset
  // the grid to defaults). Called by the User Settings toggle.
  _setLayoutEnabled(on: boolean): void {
    if (on) {
      try { Session.setPref('gridLayout', Table._currentLayout()); } catch {}
    } else {
      try { Session.setPref('gridLayout', null); } catch {}
      Table._resetGridState();
    }
  },

  // Reset the live grid to its default column arrangement + clear column filters.
  _resetGridState(): void {
    if (!Table._api) return;
    Table._applyingLayout = true;
    try {
      Table._api.resetColumnState();
      Table._api.setFilterModel(null);
    } catch (e: unknown) {
      ErrorLog.warn('table', `Reset grid layout failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // resetColumnState() reverts `hide` to whatever was baked into columnDefs
    // at grid-creation time — which can itself be stale (built before the
    // /system-settings boot fetch resolved). Force-reapply the CURRENT admin
    // default so _resetGridLayout()'s re-capture below persists the right
    // baseline, not a stale one. Same guard, so this doesn't echo back into
    // the user's personal gridLayout either.
    Table._applyFieldVisibility();
    setTimeout(() => { Table._applyingLayout = false; }, 0);
  },

  /* ── Admin-configured Orders field visibility (system_settings.orderFields,
     frontend/order-field-catalog.mjs) — a global default, not per-user. See the
     design note above _resetGridState: this must win over gridLayout's own
     `hide` state at both initial load (onGridReady, after _applySavedLayout)
     and after a manual reset, or a stale per-user layout silently overrides
     the admin default. ───────────────────────────────────────────────────── */
  _fieldHidden(key: string): boolean {
    const f = ORDER_FIELD_CATALOG.find(c => c.key === key);
    if (!f) return false;
    const cfg = Store.orderFieldVisibility[key];
    return !(cfg?.grid ?? f.gridDefault);
  },

  // Force-applies current catalog+config visibility for every catalog-driven
  // field via two batched setColumnsVisible calls (not a per-key loop). Uses
  // the same _applyingLayout guard as _applySavedLayout/_resetGridState so
  // this doesn't get captured back into the user's personal gridLayout.
  _applyFieldVisibility(): void {
    if (!Table._api) return;
    const visible: string[] = [];
    const hidden: string[] = [];
    for (const f of ORDER_FIELD_CATALOG) {
      (Table._fieldHidden(f.key) ? hidden : visible).push(f.key);
    }
    Table._applyingLayout = true;
    try {
      if (visible.length) Table._api.setColumnsVisible(visible, true);
      if (hidden.length) Table._api.setColumnsVisible(hidden, false);
    } catch (e: unknown) {
      ErrorLog.warn('table', `Apply field visibility failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    setTimeout(() => { Table._applyingLayout = false; }, 0);
  },

  // "Reset grid layout" action: reset the live grid, then — if the feature is
  // on — re-capture the now-default state so it persists (staying non-null keeps
  // the toggle on). Returns true if the grid was available to reset.
  _resetGridLayout(): boolean {
    if (!Table._api) return false;
    Table._resetGridState();
    if (Table._layoutEnabled()) {
      try { Session.setPref('gridLayout', Table._currentLayout()); } catch {}
    }
    return true;
  },

  /** The Planning reason cell's text. A planner Delete carries a fixed code; resolve it through the locale so the
   *  label follows the user's language. The run-time-over-cap reason does the same, filling in the hours the server
   *  stored beside the message. Other codes keep their stored message. An `overlong_never` row the calendar change
   *  has since made fit (a `queued_now_fits` alert exists for it) reads "Now fits the calendar" instead; display
   *  only, nothing is persisted and Optimize or a placement still clears the real reason. */
  _planningReasonText(task: NimbusTask | undefined): string {
    if (!task?.planning_reason) return '';
    // The alert lookup is only needed for an overlong_never reason (it is the one text that reads it).
    const nowFits = task.planning_reason.code === 'overlong_never'
      && (Store.alertsByTask().get(String(task.id)) || []).some(a => a.type === 'queued_now_fits');
    return planningReasonText(task.planning_reason, (k, v) => Util.t(k, v), { nowFits });
  },

  /** SAP Start text: the raw SAP start as received, date only (a date-only SAP start must not read "12:00 AM");
   *  the time is appended only when the value carries a non-midnight time. Display only, never fed to the scheduler. */
  _fmtSapStart(v: unknown): string {
    const d = Util.parseDate(v);
    if (!d) return '';
    const timed = d.getHours() !== 0 || d.getMinutes() !== 0 || d.getSeconds() !== 0;
    return timed ? Util.fmtDTReadable(d) : Util._fmtDatePref(d);
  },

  /** Due Date / Planned Start / Planned Finish columns (backward scheduling OQ1, OQ16). The FINISH is the input
   *  and the start is derived from it, so Planned Start and Due Date are read-only and Planned Finish takes the
   *  typed value. Due Date shows the due instant (a date-only SAP finish reads as the close of that day), not the
   *  raw midnight. `field` stays alongside `valueGetter` so AG Grid's date inference still drives the column's sort
   *  and agDateColumnFilter. Extracted (like `_runTimeEditable`) so it is testable without a live AG Grid. */
  _scheduleDateColumns(): TableColDef[] {
    return [
      // SAP Start (2026-10-28, owner request): the RAW SAP start as received, read-only. The derived Original Start
      // (OQ16) stays retired; the schedule is anchored on the finish, so this will differ from Planned Start.
      { headerName: Util.t('col.sap_start'), field: 'original_start_date', minWidth: 170,
        editable: false, hide: Table._fieldHidden('original_start_date'),
        headerTooltip: Util.t('ui.sap_start_hint'),
        valueFormatter: (p: TableValueFormatterParams) => Table._fmtSapStart(p.value),
        cellClass: 'cell-date cell-date-original' },
      { headerName: Util.t('col.due_date'), field: 'original_end_date', minWidth: 160,
        editable: false, hide: Table._fieldHidden('original_end_date'),
        valueGetter: (p: { data: NimbusTask }) => Util.dueInstant(p.data),
        // The value stays the exact instant (sort/filter); the text shows the due DAY (a 24:00 close reads as 23:59).
        valueFormatter: (p: TableValueFormatterParams) => Util.fmtDTReadable(p.data ? Util.dueDisplayDate(p.data) : p.value),
        cellClass: 'cell-date cell-date-original' },
      { headerName: Util.t('col.planned_start'), field: 'start_date', minWidth: 160,
        editable: false,
        valueFormatter: (p: TableValueFormatterParams) => Util.fmtDTReadable(p.value),
        cellClass: 'cell-date' },
      { headerName: Util.t('col.planned_finish'), field: 'end_date', minWidth: 160,
        editable: true,
        valueFormatter: (p: TableValueFormatterParams) => Util.fmtDTReadable(p.value),
        cellEditor: Table._DateTimeEditor,
        cellClass: 'cell-date' },
    ] as unknown as TableColDef[];
  },

  /** RUN_TIME column's row-dependent `editable` (ROUTING_RUNTIME_DESIGN.md
   *  §8.2) — extracted (rather than inlined in Table.init()'s columnDefs, the
   *  way most cellRenderer/valueGetter callbacks here are) so it's directly
   *  testable without a live AG Grid instance. */
  _runTimeEditable(p: { data: NimbusTask }): boolean {
    return p.data?.planning_reason?.code === 'runtime_unknown';
  },

  /** Columns for the order attributes that schedulers may edit inline. */
  _priorityColumns(): TableColDef[] {
    return [
      { headerName: Util.t('col.prt_01'), field: 'PRT_01', width: 130, flex: 0, editable: true,
        hide: Table._fieldHidden('PRT_01') },
      { headerName: Util.t('col.prt_02'), field: 'PRT_02', width: 130, flex: 0, editable: true,
        hide: Table._fieldHidden('PRT_02') },
      { headerName: Util.t('col.prod_version'), field: 'PRODUCTION_VERSION', width: 140, flex: 0,
        // D11: on a routing plant the production version is chosen only together with the machine (PV - Machine).
        editable: (p: { data: NimbusTask }) => !Table._routingEnabledForTask(p.data),
        hide: Table._fieldHidden('PRODUCTION_VERSION') },
    ];
  },

  /** New columnDefs for catalog fields that have no hand-written column
   *  today (MATERIAL_NUMBER, FORM_SIZE, PLANT, FIRMING_INDICATOR) — generated
   *  generically from frontend/order-field-catalog.mjs so adding a future
   *  no-column catalog entry doesn't need a matching hand-written columnDef. */
  _catalogOnlyColumns(): TableColDef[] {
    const handwritten = new Set(['MATERIAL_DESCRIPTION', 'ORDER_QUANTITY_(GMEIN)', 'COLOR', 'RUN_TIME',
      'original_start_date', 'original_end_date', 'PRT_01', 'PRT_02', 'PRODUCTION_VERSION', 'run_time_basis']);
    return ORDER_FIELD_CATALOG.filter(f => !handwritten.has(f.key)).map(f => ({
      headerName: Util.t(f.i18nGridKey),
      field: f.key,
      // SAP Firmed (D5): the raw FIRMING_INDICATOR never reaches the browser (/tasks sends
      // only the normalised `ecc_firmed`), so the cell reads that flag: a capital X or blank.
      ...(f.key === 'FIRMING_INDICATOR'
        ? { valueGetter: (p: { data: NimbusTask }) => (p.data && Engine.isSapFirmed(p.data) ? 'X' : '') }
        : {}),
      width: f.gridWidth ?? 110,
      flex: 0,
      editable: false,
      hide: Table._fieldHidden(f.key),
      cellClass: f.type !== 'text' ? (() => 'cell-num') : undefined,
    }));
  },

  /** Sort key for the pinned PRODUCTION_ORDER column (aggregate_to_detail.md
   *  §8 "Grid"): group by PARENT_ORDER (falling back to the row's own order
   *  when it isn't a sub-order) then by DISTRIBUTION_LETTER, so siblings of a
   *  distributed SAP order stay adjacent instead of scattering — there is no
   *  default sort today. */
  _orderColumnSortKey(task: NimbusTask): string {
    const primary = String(task.PARENT_ORDER ?? task.PRODUCTION_ORDER ?? task.ORDER ?? '');
    const letter = String(task.DISTRIBUTION_LETTER ?? '');
    return `${primary}\u0000${letter}`;
  },
  _orderColumnComparator(taskA: NimbusTask, taskB: NimbusTask): number {
    const a = Table._orderColumnSortKey(taskA);
    const b = Table._orderColumnSortKey(taskB);
    return a < b ? -1 : a > b ? 1 : 0;
  },
  /** Appends the same letter·count pill the Gantt bar renders
   *  (Timeline._itemForTask) after a lettered sub-order's order text — the
   *  firmed-glyph cellRenderer above is the precedent pattern for this column. */
  _orderColumnRenderer(p: { value: unknown; data?: NimbusTask }): string {
    const text = Util.escapeHtml(p.value ?? '');
    const task = p.data;
    if (!task?.PARENT_ORDER || !task.DISTRIBUTION_LETTER) return text;
    const count = (Store.siblingsByParent().get(task.PARENT_ORDER) || []).length;
    return `${text}<span class="split-order-part dist-part">${Util.escapeHtml(task.DISTRIBUTION_LETTER)}·${count}</span>`;
  },

  init(): void {
    const el = document.getElementById('ag-grid');
    if (!el || typeof agGrid === 'undefined') return;
    const gridOptions = {
      rowData: Store.tasksForSelectedPlant(),
      getRowId: (p: { data: NimbusTask }) => String(p.data.id),
      rowSelection: 'multiple',
      rowMultiSelectWithClick: true,
      animateRows: false,
      suppressRowClickSelection: false,
      defaultColDef: {
        sortable: true,
        filter:   true,
        resizable: true,
        flex: 1,
        minWidth: 100
      },
      // Alert tint is a ROW class, not a cell class: a column that declares its
      // own `cellClass` overwrites `defaultColDef.cellClass` outright, which used
      // to leave the numeric/date columns untinted on alert rows.
      rowClassRules: {
        'row-alert': (p: { data: NimbusTask | null }) => Table._alertSeverity(p.data) === 'err',
        'row-warn':  (p: { data: NimbusTask | null }) => Table._alertSeverity(p.data) === 'warn',
      },
      columnDefs: [
        {
          headerName: '',
          checkboxSelection: true,
          headerCheckboxSelection: true,
          width: 50,
          minWidth: 50,
          maxWidth: 50,
          flex: 0,
          pinned: 'left',
          lockPosition: true,
          suppressHeaderMenuButton: true,
          sortable: false,
          filter: false,
          resizable: false
        },
        {
          headerName: Util.t('col.firmed'), colId: 'firmed',
          // Union value (frozen-horizon OR running OR manual), not the raw manual
          // `fixed` field — see Engine.firmingStatus.
          valueGetter: (p: { data: NimbusTask }) => Engine.firmingStatus(p.data).firmed,
          width: 60, minWidth: 60, maxWidth: 60, flex: 0,
          pinned: 'left',
          editable: false,
          cellRenderer: (p: { value: unknown }) => p.value ? '<span style="color:var(--accent);font-size:13px;">🔒</span>' : '',
          // Lazy: the reasons text is computed only for rows the grid actually hovers.
          tooltipValueGetter: (p: { data?: NimbusTask }) => (p.data ? Engine.firmStatusText(p.data) : ''),
          headerTooltip: Util.t('tip.firmed_column')
        },
        { headerName: Util.t('col.id'),   field: 'id',   width: 80, minWidth: 80, flex: 0, hide: true,
          editable: false, cellClass: 'cell-num' },
        { headerName: Util.t('col.order'), field: 'PRODUCTION_ORDER', width: 160, minWidth: 160, flex: 0,
          pinned: 'left', editable: false,
          valueGetter: (p: { data: NimbusTask }) => p.data.PRODUCTION_ORDER || p.data.ORDER || '',
          comparator: (_a: unknown, _b: unknown, nodeA: AgGridRowNode, nodeB: AgGridRowNode) => Table._orderColumnComparator(nodeA.data, nodeB.data),
          cellRenderer: (p: { value: unknown; data?: NimbusTask }) => Table._orderColumnRenderer(p) },
        { headerName: Util.t('col.material'), field: 'MATERIAL_DESCRIPTION', minWidth: 180, editable: false,
          tooltipField: 'MATERIAL_DESCRIPTION', hide: Table._fieldHidden('MATERIAL_DESCRIPTION') },
        { headerName: Util.t('col.qty'), field: 'ORDER_QUANTITY_(GMEIN)', width: 100, flex: 0,
          editable: false, cellClass: 'cell-num', hide: Table._fieldHidden('ORDER_QUANTITY_(GMEIN)'),
          valueParser: (p: { newValue: string }) => parseFloat(p.newValue) || 0 },
        { headerName: Util.t('col.line'), field: 'MACHINE', minWidth: 130, editable: true,
          cellEditor: Table._SearchableLineEditor,
          cellEditorPopup: true,
          cellEditorParams: (p: { data: NimbusTask }) => ({ values: Table._getPairOptions(p.data), data: p.data }),
          cellRenderer: (p: { value: unknown }) => {
            if (!p.value) return '';
            const ci = Timeline._colorIndex(String(p.value));
            const color = Config.COLORS[ci % Config.COLORS.length];
            return `<span class="cell-line-tag"><span class="dot" style="background:${color}"></span>${Util.escapeHtml(String(p.value))}</span>`;
          }
        },
        { headerName: Util.t('col.color'), field: 'COLOR', width: 110, flex: 0, editable: false,
          hide: Table._fieldHidden('COLOR') },
        ...Table._priorityColumns(),
        { headerName: Util.t('col.planning_status'), field: 'planning_status', minWidth: 150, editable: false,
          valueGetter: (p: { data: NimbusTask }) => p.data?.planning_status === 'needs_planning'
            ? Util.t('ui.needs_planning') : Util.t('ui.planning_status_scheduled') },
        { headerName: Util.t('col.planning_reason'), colId: 'planning_reason', minWidth: 240, editable: false,
          valueGetter: (p: { data: NimbusTask }) => Table._planningReasonText(p.data) },
        { headerName: Util.t('col.planning_window'), colId: 'planning_window', minWidth: 260, editable: false,
          valueGetter: (p: { data: NimbusTask }) => Table._planningWindowLabel(p.data),
          tooltipValueGetter: (p: { data: NimbusTask }) => Table._planningWindowLabel(p.data) },
        ...Table._catalogOnlyColumns(),
        { headerName: Util.t('col.run_h'), field: 'RUN_TIME', width: 90, flex: 0,
          // Editable only while the order is held for an unresolved routing
          // runtime (ROUTING_RUNTIME_DESIGN.md §8.2) — otherwise the value is
          // server-computed (routing/order-file/legacy) and read-only.
          editable: Table._runTimeEditable,
          cellClass: 'cell-num', hide: Table._fieldHidden('RUN_TIME'),
          valueParser: (p: { newValue: string }) => parseFloat(p.newValue) || 0 },
        { headerName: Util.t('col.run_time_basis'), field: 'run_time_basis', width: 120, flex: 0,
          editable: false, hide: Table._fieldHidden('run_time_basis'),
          cellRenderer: (p: { data?: NimbusTask }) => {
            if (!p.data) return '';
            return Util.escapeHtml(Inspector._formatRuntimeBasis(p.data));
          } },
        ...Table._scheduleDateColumns(),
        { headerName: Util.t('col.alerts'), field: 'id', width: 90, flex: 0, sortable: false, filter: false, editable: false,
          cellRenderer: (p: { value: unknown }) => {
            const rel = Store.alertsByTask().get(String(p.value)) || [];
            if (!rel.length) return '';
            const err = rel.some(a => a.sev === 'err');
            const color = err ? 'var(--err)' : 'var(--warn)';
            // DOM node (not an HTML string) so the task id never reaches an inline handler.
            const taskId = String(p.value);
            const btn = document.createElement('button');
            btn.title = Util.t('tip.click_view_alerts');
            btn.style.cssText = `background:none;border:none;padding:0;cursor:pointer;color:${color};font-weight:600;font-size:inherit;font-family:inherit`;
            btn.textContent = `⚐ ${rel.length}`;
            btn.addEventListener('click', () => Table._showAlertPopup(taskId));
            return btn;
          }
        },
        { headerName: '📝', field: 'notes', width: 180, minWidth: 80,
          sortable: false, filter: false, editable: true, suppressHeaderMenuButton: true,
          cellEditor: 'agLargeTextCellEditor', cellEditorPopup: true,
          cellEditorParams: { maxLength: 500, rows: 5, cols: 50 },
          cellRenderer: (p: { value: unknown }) => {
            const note = p.value != null ? String(p.value).trim() : '';
            if (!note) return `<span class="nb-note-empty">✎ <em>${Util.t('ui.add_note')}</em></span>`;
            const preview = note.length > 40 ? note.slice(0, 37) + '…' : note;
            return `<span class="nb-note-preview" title="${Util.escapeHtml(note)}">✎ ${Util.escapeHtml(preview)}</span>`;
          }
        }
      ] as TableColDef[],
      onCellValueChanged: Table._onCellChanged,
      onSelectionChanged: Table._onSelectionChanged,
      isExternalFilterPresent: () => Table._isExternalFilterActive(),
      doesExternalFilterPass: (node: { data: NimbusTask }) => Table._taskPassesChipFilters(node.data),
      noRowsOverlayComponent: Table._NoRowsOverlay,
      onCellMouseDown: (p: TableCellMouseEvent) => {
        if (!Table._rangeMode) return;
        p.event.preventDefault();
        Table._rangeAnchor  = { rowIndex: p.node.rowIndex, colId: p.column.getColId() };
        Table._rangeActive  = { rowIndex: p.node.rowIndex, colId: p.column.getColId() };
        Table._rangeDragOn  = true;
        Table._applyRangeHighlight();
        document.addEventListener('mouseup', () => { Table._rangeDragOn = false; }, { once: true });
      },
      onCellMouseOver: (p: TableCellMouseEvent) => {
        if (!Table._rangeMode || !Table._rangeDragOn) return;
        Table._rangeActive = { rowIndex: p.node.rowIndex, colId: p.column.getColId() };
        Table._applyRangeHighlight();
      },
      onCellKeyDown: (p: TableCellKeyDownEvent) => {
        const ctrl = p.event.ctrlKey || p.event.metaKey;
        const key  = p.event.key;
        if (key === 'ContextMenu' || (key === 'F10' && p.event.shiftKey)) {
          p.event.preventDefault();
          p.event.stopPropagation();
          if (p.data?.id != null) ContextMenu.openFromKeyboard(String(p.data.id), p.event.target as HTMLElement | null);
          return;
        }
        if (ctrl && key === 'y') {
          p.event.preventDefault();
          Table._toggleRangeMode();
          return;
        }
        if (ctrl && key === 'c') {
          if (Table._rangeMode && Table._rangeHighlighted.size > 0) {
            Table._copyRange();
          } else {
            const raw = p.api.getValue(p.column.getColId(), p.node);
            const colDef = p.column.getColDef();
            let text: unknown = raw;
            if (colDef.valueFormatter) {
              const fmt = colDef.valueFormatter({ value: raw, data: p.data, node: p.node, column: p.column, api: p.api, colDef });
              if (fmt != null) text = fmt;
            }
            navigator.clipboard?.writeText(text == null ? '' : String(text)).catch(() => {});
            const cell = (p.event.target as Element | null)?.closest('.ag-cell');
            if (cell) {
              cell.classList.add('ag-cell-copy-flash');
              setTimeout(() => cell.classList.remove('ag-cell-copy-flash'), 380);
            }
          }
          return;
        }
        if (key === 'Escape' && Table._rangeMode) {
          Table._clearRange();
        }
      },
      // Saved grid layout — capture column order/width/visibility/pinning, sort,
      // and built-in column filters whenever the user changes them (debounced, and
      // only while the feature is enabled). See Table._captureLayout.
      onSortChanged:    () => Table._captureLayout(),
      onColumnMoved:    () => Table._captureLayout(),
      onColumnResized:  () => Table._captureLayout(),
      onColumnVisible:  () => Table._captureLayout(),
      onColumnPinned:   () => Table._captureLayout(),
      onFilterChanged:  () => { Table._captureLayout(); Table._refreshChipButtons(); },
      onGridReady: (params: TableGridReadyEvent) => {
        Table._api = params.api;
        Table._colApi = params.columnApi;
        Table._wireQuickFilter();
        Table._initChipFilters();
        // Restore the user's saved grid layout (if the feature is on) before
        // first paint so the table opens in their remembered arrangement.
        Table._applySavedLayout();
        // Must run AFTER _applySavedLayout — the admin's field-visibility
        // default has to win over any stale per-user saved `hide` state for
        // the same columns (see the design note above _resetGridState).
        Table._applyFieldVisibility();
        ErrorLog.info('table', `AG Grid ready with ${Store.tasksArr.length} rows`);
      },
    };

    agGrid.createGrid(el, gridOptions);

    // Re-render rows whenever relevant store slices change.
    Store.subscribe(evt => Table._onStore(evt), 'Table');
    Table._wireProfileMatches();

    // Live-apply an admin's System Configuration field-visibility change with
    // no page reload. Also covers the boot-time race where this grid paints
    // before the /system-settings fetch resolves — _applyFieldVisibility()
    // guards on Table._api itself, but the fetch can equally resolve BEFORE
    // onGridReady fires, so this subscription is the other half of that race.
    Store.subscribe(evt => { if (evt.type === 'order-field-visibility:changed') Table._applyFieldVisibility(); }, 'Table');

    // Outside-click closes any open chip dropdown. Capture phase so AG Grid
    // (which can stopPropagation on some interactions) doesn't swallow the event.
    const closeAllChipDropdowns = () => {
      ['line', 'color', 'status', 'date', 'pomat'].forEach(k => {
        const d = document.getElementById(`tbl-flt-${k}-dropdown`);
        if (d) d.hidden = true;
      });
    };
    document.addEventListener('mousedown', (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest || !target.closest('#table-filterbar')) {
        closeAllChipDropdowns();
      }
    }, true);
    // Closing on Escape is also expected for menu-like UI.
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeAllChipDropdowns();
    });
  },

  // ── Filter chip bar ──────────────────────────────────────────────────
  _initChipFilters(): void {
    Table._refreshChipDropdowns();
    Table._refreshChipButtons();

    const lineIn  = document.getElementById('tbl-flt-line-paste-input') as HTMLInputElement | null;
    const colorIn = document.getElementById('tbl-flt-color-paste-input') as HTMLInputElement | null;
    if (lineIn) {
      Util.wirePasteToCheckboxes(lineIn,
        () => Array.from(document.getElementById('tbl-flt-line-checklist')?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') ?? []),
        // One Store update for the whole paste: per-box change events rebuild the checklist
        // and detach the later boxes (pasting N lines selected 1).
        boxes => Store.setSelectedLines(new Set([...Store.selectedLines, ...boxes.map(cb => cb.value)]), 'table'));
    }
    if (colorIn) {
      Util.wirePasteToCheckboxes(colorIn,
        () => Array.from(document.getElementById('tbl-flt-color-checklist')?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') ?? []));
    }
    // Scale mandate (CLAUDE.md Production Scale Roadmap): line/color pickers must
    // stay filterable, not a bare scrollable checkbox list — matches the Gantt tab's
    // identical filter bar. Paste-to-select (above) and type-to-filter (below) share
    // the same input without conflict — wirePasteToCheckboxes only listens for 'paste'.
    if (lineIn)  lineIn.oninput  = () => Table._filterLineSearch(lineIn.value);
    if (colorIn) colorIn.oninput = () => Table._filterColorSearch(colorIn.value);

    const poTa = document.getElementById('tbl-flt-pomat-textarea');
    if (poTa) {
      poTa.addEventListener('paste', Table._onPoMatPaste);
      poTa.addEventListener('input', Util.debounce(Table._onPoMatApply, 150));
    }
    document.getElementById('tbl-flt-pomat-clear')?.addEventListener('click', Table._clearPoMat);
  },

  _hasChipFilters(): boolean {
    const f = Table._chipFilters;
    return f.lines.size > 0 || f.colors.size > 0 || f.status !== null || f.dateKey !== null || f.poMat.size > 0;
  },

  // C1 (2026-08-20): whether AG Grid's external-filter machinery needs to run
  // at all — user-chosen chip filters OR a configured visibility horizon.
  // Deliberately separate from _hasChipFilters(), which also drives the
  // "Clear filters" button/hint (a plant horizon isn't a user-clearable chip,
  // so it must not make that button appear with nothing to clear) — but
  // without this OR, isExternalFilterPresent returning false when no CHIP is
  // active would mean doesExternalFilterPass (the thing that actually hides
  // beyond-horizon rows) never runs at all.
  _isExternalFilterActive(): boolean {
    return Table._hasChipFilters() || Store.visibilityHorizonEnd !== null;
  },

  _taskPassesChipFilters(data: NimbusTask | null): boolean {
    if (!data) return false;
    const f = Table._chipFilters;
    if (f.lines.size > 0 && !f.lines.has(data.MACHINE)) return false;
    if (f.colors.size > 0 && !f.colors.has(String(data.COLOR || '').toUpperCase())) return false;
    if (!Util.taskMatchesPasteSet(data, f.poMat.size > 0 ? (f.poMatMatcher ?? f.poMat) : null)) return false;
    // OQ42: a day chip keeps every order whose bar overlaps that day (a bar crossing midnight shows on both days).
    if (f.dateKey && !Util.overlapsDay(data, f.dateKey)) return false;
    // C1 (2026-08-20), OD-C1d/e: gate on start only, hide (not merely block
    // scrolling to) rows beyond the plant's visibility horizon. Belt-and-
    // suspenders — db.query_orders already excludes these rows from the
    // /tasks payload server-side, so this only matters if a cached/stale
    // payload briefly disagrees; it must never be the ONLY thing hiding them.
    // Backward scheduling (OQ27): the key is the SAP start as first received (the locked
    // wire `original_start_date`, kept un-snapped in BASIC_START_DATE), never where a planner
    // placed the order, so it matches the server's key exactly.
    const horizonEnd = Store.visibilityHorizonEnd;
    const sapStart = data.BASIC_START_DATE ?? data.original_start_date;
    if (horizonEnd && sapStart && sapStart.getTime() > horizonEnd.getTime()) return false;
    if (f.status) {
      if (f.status === 'needs_planning' && data.planning_status !== 'needs_planning') return false;
      if (f.status === 'late' && !(Util.latenessHours(data) > 0)) return false;
      if (f.status === 'profile' && !AlertProfileMatches.current().taskIds.has(String(data.id))) return false;
      if (f.status === 'firmed' && !Engine.firmingStatus(data).firmed) return false;
      if (f.status === 'atrisk' || f.status === 'conflict') {
        const rel = Store.alertsByTask().get(String(data.id)) || [];
        if (f.status === 'atrisk'  && !rel.some(a => a.sev === 'warn')) return false;
        if (f.status === 'conflict' && !rel.some(a => a.sev === 'err'))  return false;
      }
    }
    return true;
  },

  _toggleChipDropdown(kind: string): void {
    const d = document.getElementById(`tbl-flt-${kind}-dropdown`);
    if (!d) return;
    // Close peers
    ['line','color','status','date','pomat'].forEach(k => {
      if (k !== kind) {
        const other = document.getElementById(`tbl-flt-${k}-dropdown`);
        if (other) other.hidden = true;
      }
    });
    d.hidden = !d.hidden;
  },

  _refreshChipDropdowns(): void {
    Table._buildLineChipDropdown();
    Table._buildColorChipDropdown();
    Table._buildStatusChipDropdown();
    Table._buildDateChipDropdown();
  },

  // Scale mandate (CLAUDE.md Production Scale Roadmap): every plant/line picker
  // must stay filterable — this is the Orders tab's share of that, matching the
  // Gantt tab's identical filter bar.
  _filterLineSearch(q: string): void {
    Table._lineSearch = q || '';
    Table._buildLineChipDropdown();
  },
  _filterColorSearch(q: string): void {
    Table._colorSearch = q || '';
    Table._buildColorChipDropdown();
  },

  // Clears the line/color live-search text and its <input> values without
  // touching selections — shared by the plant-change handler and clear filters.
  _resetChipSearch(): void {
    Table._lineSearch = Table._colorSearch = '';
    const lineIn  = document.getElementById('tbl-flt-line-paste-input') as HTMLInputElement | null;
    const colorIn = document.getElementById('tbl-flt-color-paste-input') as HTMLInputElement | null;
    if (lineIn)  lineIn.value  = '';
    if (colorIn) colorIn.value = '';
  },

  _buildLineChipDropdown(): void {
    const drop = document.getElementById('tbl-flt-line-checklist');
    if (!drop) return;
    const lineSet = new Set<string>();
    for (const t of (Store.selectedPlant ? Store.tasksForSelectedPlant() : [])) {
      if (t.MACHINE) lineSet.add(t.MACHINE);
    }
    const sorted = [...lineSet].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    // No pruning here anymore: _chipFilters.lines is the shared cross-screen Set —
    // see Store.selectedLines and GanttFilter._buildLineDropdown's identical note.
    Util.renderLineChecklist(drop, sorted, Table._chipFilters.lines, Table._lineSearch,
      (line, checked) => {
        const next = new Set(Table._chipFilters.lines);
        if (checked) next.add(line); else next.delete(line);
        Store.setSelectedLines(next, 'table');
        Table._refreshChipButtons();
        if (Table._api) Table._api.onFilterChanged();
      });
  },

  _buildColorChipDropdown(): void {
    const drop = document.getElementById('tbl-flt-color-checklist');
    if (!drop) return;
    const colorSet = new Set<string>();
    for (const t of (Store.selectedPlant ? Store.tasksForSelectedPlant() : [])) {
      if (t.COLOR) colorSet.add(String(t.COLOR).toUpperCase());
    }
    const sorted = [...colorSet].sort();
    for (const c of [...Table._chipFilters.colors]) {
      if (!colorSet.has(c)) Table._chipFilters.colors.delete(c);
    }
    const q = Table._colorSearch.toLowerCase().trim();
    const visible = q ? sorted.filter(c => c.toLowerCase().includes(q)) : sorted;
    drop.innerHTML = visible.length
      ? visible.map(c => `<label><input type="checkbox" value="${Util.escapeHtml(c)}"${Table._chipFilters.colors.has(c) ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('color', this)"> ${Util.escapeHtml(c)}</label>`).join('')
      : `<div style="padding:8px 14px;font-size:12px;color:var(--fg-mute)">${sorted.length ? Util.t('ui.no_matches') : 'No colors'}</div>`;
  },

  _buildStatusChipDropdown(): void {
    if (typeof document === 'undefined') return;
    const drop = document.getElementById('tbl-flt-status-dropdown');
    if (!drop) return;
    const cur = Table._chipFilters.status;
    const items: Array<{ v: TableStatusFilter; k: string; d: string; off?: boolean }> = [
      { v: 'needs_planning', k: Util.t('ui.needs_planning'), d: Util.t('ui.status_desc_needs_planning') },
      { v: 'late',     k: Util.t('ui.late'),        d: Util.t('ui.status_desc_late') },
      { v: 'conflict', k: Util.t('ui.conflicting'),  d: Util.t('ui.status_desc_conflict') },
      { v: 'atrisk',   k: Util.t('ui.at_risk'),      d: Util.t('ui.status_desc_atrisk') },
      { v: 'firmed',   k: Util.t('ui.firmed'),       d: Util.t('ui.status_desc_firmed') },
      { v: 'profile',  k: Util.t('tbl.status_profile'), d: Util.t('tbl.status_profile_desc'), off: Table._profileFilterOff() },
    ];
    drop.innerHTML = items.map(i =>
      `<label style="display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:6px 14px;${i.off ? 'opacity:.55;' : ''}">
         <span style="display:flex;align-items:center;gap:8px;">
           <input type="radio" name="tbl-flt-status" value="${i.v}"${cur === i.v ? ' checked' : ''}${i.off ? ' disabled' : ''} onchange="NIMBUS.Table._onChipChange('status', this)" style="accent-color:var(--accent);width:13px;height:13px;cursor:pointer;">
           <strong>${i.k}</strong>
         </span>
         <span style="font-size:10.5px;color:var(--fg-mute);margin-left:21px;">${i.d}</span>
       </label>`).join('')
      + `<div style="border-top:1px solid var(--line);margin:4px 0;"></div>
         <label style="display:flex;align-items:center;justify-content:flex-start;gap:8px;padding:6px 14px;">
           <input type="radio" name="tbl-flt-status" value=""${cur === null ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('status', this)" style="accent-color:var(--accent);width:13px;height:13px;cursor:pointer;">
           <span>${Util.t('ui.any_status')}</span>
         </label>`;
  },

  _buildDateChipDropdown(): void {
    const drop = document.getElementById('tbl-flt-date-dropdown');
    if (!drop) return;
    const today = Util.plantToday(Store.selectedPlant);   // OQ42: the plant's day, not the viewer's
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const cur = Table._chipFilters.dateKey;
    // Quick presets + clear. Underlying filter stores YYYY-MM-DD (single day) only;
    // longer ranges set status='atrisk-or-window' via dedicated keys.
    const presets = [
      { v: Util.dayKey(today),    k: Util.t('ui.today'),    d: Util.fmtDayLabelPref(today) },
      { v: Util.dayKey(tomorrow), k: Util.t('ui.tomorrow'), d: Util.fmtDayLabelPref(tomorrow) },
    ];
    drop.innerHTML = presets.map(p =>
      `<label style="display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:6px 14px;">
         <span style="display:flex;align-items:center;gap:8px;">
           <input type="radio" name="tbl-flt-date" value="${p.v}"${cur === p.v ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('date', this)" style="accent-color:var(--accent);width:13px;height:13px;cursor:pointer;">
           <strong>${p.k}</strong>
         </span>
         <span style="font-size:10.5px;color:var(--fg-mute);margin-left:21px;">${p.d}</span>
       </label>`).join('')
      + `<div style="border-top:1px solid var(--line);margin:4px 0;"></div>
         <label style="display:flex;align-items:center;justify-content:flex-start;gap:8px;padding:6px 14px;">
           <input type="radio" name="tbl-flt-date" value=""${cur === null ? ' checked' : ''} onchange="NIMBUS.Table._onChipChange('date', this)" style="accent-color:var(--accent);width:13px;height:13px;cursor:pointer;">
           <span>${Util.t('ui.any_date')}</span>
         </label>`;
  },

  // 'line' is handled by _buildLineChipDropdown's own onToggle callback (routes
  // through Store.setSelectedLines) — never generated as an onchange="..." kind here.
  _onChipChange(kind: string, input: HTMLInputElement): void {
    const f = Table._chipFilters;
    if (kind === 'color') {
      if (input.checked) f.colors.add(input.value.toUpperCase());
      else               f.colors.delete(input.value.toUpperCase());
    } else if (kind === 'status') {
      f.status = (input.value || null) as TableStatusFilter | null;
    } else if (kind === 'date') {
      f.dateKey = input.value || null;
    }
    Table._refreshChipButtons();
    if (Table._api) Table._api.onFilterChanged();
    // Single-select chips close after a pick; multi-select stay open for more choices.
    if (kind === 'status' || kind === 'date') {
      const d = document.getElementById(`tbl-flt-${kind}-dropdown`);
      if (d) d.hidden = true;
    }
  },

  _clearChipFilters(): void {
    const quickFilter = document.getElementById('quick-filter') as HTMLInputElement | null;
    if (quickFilter) quickFilter.value = '';
    Table._api?.setGridOption('quickFilterText', '');
    // Routes through Store so the clear propagates to every other line-
    // filterable screen too (self-sourced, so Table's own _onStore guard
    // skips reprocessing — the calls below already do the local refresh).
    Store.setSelectedLines([], 'table');
    Table._chipFilters.colors.clear();
    Table._chipFilters.status = null;
    Table._chipFilters.dateKey = null;
    Table._chipFilters.poMat.clear();
    const ta = document.getElementById('tbl-flt-pomat-textarea') as HTMLTextAreaElement | null;
    if (ta) ta.value = '';
    const cnt = document.getElementById('tbl-flt-pomat-count');
    if (cnt) cnt.textContent = '';
    Table._resetChipSearch();
    // Fold native AG column filters into the same Clear action — otherwise a
    // restored saved layout's column filter survives this click invisibly.
    if (Table._api && Table._api.isAnyFilterPresent()) Table._api.setFilterModel(null);
    Table._refreshChipDropdowns();
    Table._refreshChipButtons();
    if (Table._api) Table._api.onFilterChanged();
  },

  _onPoMatApply(): void {
    const ta = document.getElementById('tbl-flt-pomat-textarea') as HTMLTextAreaElement | null;
    if (!ta) return;
    const tokens = Util.parsePasteList(ta.value).map(Util.norm).filter(t => !/^\*+$/.test(t));   // a lone `*` filters nothing
    Table._chipFilters.poMat = new Set(tokens);
    Table._chipFilters.poMatMatcher = Util.compilePasteMatcher(tokens);
    const cnt = document.getElementById('tbl-flt-pomat-count');
    if (cnt) {
      const n = Table._chipFilters.poMat.size;
      cnt.textContent = n ? Util.t('ui.pomat_count', { count: n }) : '';
    }
    Table._refreshChipButtons();
    if (Table._api) Table._api.onFilterChanged();
  },

  _onPoMatPaste(e: ClipboardEvent): void {
    const text = (e.clipboardData || (window as unknown as { clipboardData?: DataTransfer }).clipboardData)?.getData('text/plain');
    if (!text || !text.trim()) return;
    const known = new Set<string>();
    (Store.selectedPlant ? Store.tasksForSelectedPlant() : []).forEach(task => {
      const po = Util.norm(task.ORDER ?? task.PRODUCTION_ORDER); if (po) known.add(po);
      const mat = Util.norm(task.MATERIAL_NUMBER); if (mat) known.add(mat);
      const parent = Util.norm(task.PARENT_ORDER); if (parent) known.add(parent);
    });
    const { matched, total } = Util.countPasteMatches(text, known);
    if (total) Toast.show(Util.t('toast.paste_pomat_match', { matched, total }), matched > 0 ? 'success' : 'warn');
  },

  _clearPoMat(): void {
    Table._chipFilters.poMat.clear();
    const ta = document.getElementById('tbl-flt-pomat-textarea') as HTMLTextAreaElement | null;
    if (ta) ta.value = '';
    const cnt = document.getElementById('tbl-flt-pomat-count');
    if (cnt) cnt.textContent = '';
    Table._refreshChipButtons();
    if (Table._api) Table._api.onFilterChanged();
  },

  /** Driven from KPI tile clicks on the dashboard. Sets state, refreshes UI, re-filters grid. */
  _applyChipFilter(patch: { status?: TableStatusFilter | null; dateKey?: string | null; lines?: string[]; colors?: string[] }): void {
    const f = Table._chipFilters;
    if ('status' in patch)  f.status  = patch.status  || null;
    if ('dateKey' in patch) f.dateKey = patch.dateKey || null;
    if (patch.lines)  Store.setSelectedLines(patch.lines, 'table');
    if (patch.colors) { f.colors.clear(); for (const c of patch.colors) f.colors.add(String(c).toUpperCase()); }
    Table._refreshChipDropdowns();
    Table._refreshChipButtons();
    if (Table._api) Table._api.onFilterChanged();
  },

  _refreshChipButtons(): void {
    const plant = !!Store.selectedPlant;
    const f = Table._chipFilters;

    const set = (btnId: string, lblId: string, txt: string, active: boolean) => {
      const b = document.getElementById(btnId) as HTMLButtonElement | null;
      const l = document.getElementById(lblId);
      if (b) { b.disabled = !plant; b.classList.toggle('active', !!active); }
      if (l) l.textContent = txt;
    };

    set('tbl-flt-line-btn',  'tbl-flt-line-label',
      f.lines.size === 0 ? Util.t('ui.all_lines')
        : f.lines.size === 1 ? [...f.lines][0]
        : Util.t('ui.n_lines_filter', { count: f.lines.size }),
      f.lines.size > 0);

    set('tbl-flt-color-btn', 'tbl-flt-color-label',
      f.colors.size === 0 ? Util.t('ui.all_colors')
        : f.colors.size === 1 ? [...f.colors][0]
        : Util.t('ui.n_colors_filter', { count: f.colors.size }),
      f.colors.size > 0);

    const STATUS_LABEL: Record<TableStatusFilter, string> = { needs_planning: Util.t('ui.needs_planning'), late: Util.t('ui.late'), conflict: Util.t('ui.conflicting'), atrisk: Util.t('ui.at_risk'), firmed: Util.t('ui.firmed'), profile: Util.t('tbl.status_profile') };
    set('tbl-flt-status-btn', 'tbl-flt-status-label',
      f.status ? STATUS_LABEL[f.status] || f.status : Util.t('ui.all_statuses'),
      !!f.status);

    let dateLabel = Util.t('ui.any_date');
    if (f.dateKey) {
      const todayKey = Util.dayKey(Util.plantToday(Store.selectedPlant));
      const tomorrow = Util.plantToday(Store.selectedPlant);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowKey = Util.dayKey(tomorrow);
      if (f.dateKey === todayKey) dateLabel = Util.t('ui.today');
      else if (f.dateKey === tomorrowKey) dateLabel = Util.t('ui.tomorrow');
      else dateLabel = f.dateKey;
    }
    set('tbl-flt-date-btn', 'tbl-flt-date-label', dateLabel, !!f.dateKey);

    set('tbl-flt-pomat-btn', 'tbl-flt-pomat-label',
      f.poMat.size === 0 ? Util.t('ui.all_pomat') : Util.t('ui.n_pomat_filter', { count: f.poMat.size }),
      f.poMat.size > 0);

    // Native AG Grid per-column filters (from a saved layout, or set directly
    // via a column header menu) can suppress rows with zero acknowledgment in
    // this bar otherwise — surface + fold them into the same Clear action.
    const hasNative = Object.keys(Table._api?.getFilterModel?.() || {}).length > 0;
    const hasQuick = !!(document.getElementById('quick-filter') as HTMLInputElement | null)?.value;
    const hasAny = Table._hasChipFilters() || hasNative || hasQuick;
    const clear = document.getElementById('tbl-flt-clear');
    if (clear) clear.hidden = !hasAny;

    const hint = document.getElementById('tbl-flt-hint');
    if (hint && Table._api) {
      const n = Table._api.getDisplayedRowCount();
      let txt = plant ? Util.t('ui.orders_visible', { count: n, plural: n !== 1 ? Util.t('ui.orders_visible_plural') : '' }) : '';
      if (plant && hasNative) txt += ' ' + Util.t('ui.column_filters_active');
      hint.textContent = txt;
    }
  },

  // The 'profile' status filter reads AlertProfileMatches (own fanout, never a Store event),
  // so the grid re-filters from this subscription — once, and only while that status is active.
  _profileUnsub: null as (() => void) | null,
  /** Last `_profileFilterOff()` the status dropdown was (re)built for; only a flip changes what it shows. */
  _profileOffSeen: null as boolean | null,
  _wireProfileMatches(): void {
    if (Table._profileUnsub) return;
    Table._profileUnsub = AlertProfileMatches.subscribe(() => {
      if (!Table._api) return;
      const off = Table._profileFilterOff();
      const flipped = off !== Table._profileOffSeen;
      Table._profileOffSeen = off;
      // Under All alerts the filter could only ever show an empty grid: fall back to no status filter.
      if (Table._chipFilters.status === 'profile' && off) Table._chipFilters.status = null;
      else if (Table._chipFilters.status !== 'profile') { if (flipped) Table._buildStatusChipDropdown(); return; }
      Table._buildStatusChipDropdown();
      Table._api.onFilterChanged();
      Table._refreshChipButtons();
    });
  },
  _unwireProfileMatches(): void { Table._profileUnsub?.(); Table._profileUnsub = null; },
  /** True when the active profile is All alerts: the profile filter would match nothing, so it is offered disabled. */
  _profileFilterOff(): boolean { return AlertProfileMatches.current().profileId === ALL_ALERTS_PROFILE_ID; },

  /** One plant-membership test for every _onStore branch: the task's own PLANT, else the plant its line maps to. */
  _inSelectedPlant(t: NimbusTask): boolean {
    return inSelectedPlantFor(t, Store.selectedPlant, m => Store.getPlantForLine(m));
  },

  _onStore(evt: StoreEvent): void {
    if (evt.source === 'table' && evt.type !== 'firmed:change') return;
    if (!Table._api) return;
    if (evt.type === 'tasks:bulk' || evt.type === 'plant:selected'
        || evt.type === 'lineSettings:change') {
      const rows = Store.tasksForSelectedPlant();
      Table._api.setGridOption('rowData', rows);
      Table._renderEmptyState();
      if (evt.type === 'plant:selected') {
        // Clear chip filters on plant change — stale line/color sets don't apply.
        // (selectedLines itself is cleared centrally by Store.setSelectedPlant.)
        Table._chipFilters.colors.clear();
        Table._chipFilters.status = null;
        Table._chipFilters.dateKey = null;
        Table._chipFilters.poMat.clear();
        const ta = document.getElementById('tbl-flt-pomat-textarea') as HTMLTextAreaElement | null;
        if (ta) ta.value = '';
        const cnt = document.getElementById('tbl-flt-pomat-count');
        if (cnt) cnt.textContent = '';
        Table._resetChipSearch();
      }
      Table._refreshChipDropdowns();
      Table._refreshChipButtons();
      if (evt.type === 'tasks:bulk') {
        ErrorLog.info('table', `Rebuilt grid with ${rows.length} rows`);
      }
    } else if (evt.type === 'lines:selected') {
      // Cross-screen change (Gantt/Dashboard/Labor Plan/Master Data) — a
      // self-sourced 'table' event never reaches here (top-of-function guard);
      // _buildLineChipDropdown's own onToggle callback already did this locally.
      Table._buildLineChipDropdown();
      Table._api.onFilterChanged();
    } else if (evt.type === 'task:remove') {
      if (evt.prev) Table._api.applyTransaction({ remove: [evt.prev] });
      Table._renderEmptyState();
    } else if (evt.type === 'tasks:bulkUpdate') {
      const ids = (evt.ids as Array<string | number> | undefined) ?? [];
      const inPlant = ids
        .map(id => Store.tasks[id])
        .filter((t): t is NimbusTask => !!t && Table._inSelectedPlant(t));
      const add: NimbusTask[] = [];
      const update: NimbusTask[] = [];
      for (const t of inPlant) {
        (Table._api.getRowNode(String(t.id)) ? update : add).push(t);
      }
      Table._api.applyTransaction({ add, update });
      if (add.length) Table._refreshChipDropdowns();
      if (Table._hasChipFilters()) Table._api.onFilterChanged();
    } else if (evt.type === 'task:update') {
      const t = Store.tasks[String(evt.id)];
      if (t && Store.selectedPlant && Table._inSelectedPlant(t)) {
        Table._api.applyTransaction({ update: [t] });
      }
      if (Table._hasChipFilters()) Table._api.onFilterChanged();
    } else if (evt.type === 'firmed:change') {
      const ids = (evt.ids as Array<string | number> | undefined) ?? [];
      const updated = ids
        .map(id => Store.tasks[id])
        .filter((t): t is NimbusTask => !!t && Table._inSelectedPlant(t));
      Table._api.applyTransaction({ update: updated });
      if (Table._chipFilters.status === 'firmed') Table._api.onFilterChanged();
    } else if (evt.type === 'alerts:change') {
      // Incremental update: only touch rows whose alert membership changed; fall
      // back to the whole plant if changedIds is absent (unscoped recompute).
      // applyTransaction rather than refreshCells because a row-data change is
      // what makes AG Grid re-evaluate rowClassRules (where the alert tint lives),
      // and it also re-renders the Alerts flag cellRenderer. The old code passed
      // `columns: ['id']`, which resolves to the HIDDEN id column — two columns
      // declare field 'id', so the Alerts column's colId is actually 'id_1' — so
      // nothing visible was ever recomputed. No redrawRows: that would re-enter
      // AG Grid's render cycle.
      const changedIds = evt.changedIds as Array<string | number> | undefined;
      const updated = changedIds && changedIds.length
        ? changedIds
            .map(id => Store.tasks[id])
            .filter((t): t is NimbusTask => !!t && Table._inSelectedPlant(t))
        : Store.tasksForSelectedPlant();
      if (updated.length) Table._api.applyTransaction({ update: updated });
      if (Table._chipFilters.status === 'conflict' || Table._chipFilters.status === 'atrisk') {
        Table._api.onFilterChanged();
      }
    }
    Table._refreshChipButtons();
  },

  _renderEmptyState(): void {
    const grid = document.getElementById('ag-grid') as HTMLElement | null;
    let overlay = document.getElementById('table-empty-overlay');
    if (!Store.selectedPlant) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'table-empty-overlay';
        overlay.className = 'table-empty-overlay';
        grid?.parentElement?.appendChild(overlay);
      }
      // NIMBUS/EmptyState is a forward reference (EmptyState lives in
      // application-shell.mjs, loaded after this module) — safe once boot
      // has finished, but this can also be reached synchronously from
      // Table.init()'s own AG Grid construction before that. Skip the
      // render rather than throw; the next tasks:bulk/plant:selected event
      // calls this again once NIMBUS/EmptyState are real.
      if (typeof NIMBUS !== 'undefined' && NIMBUS.EmptyState) {
        NIMBUS.EmptyState.render?.(overlay, {
          title: Util.t('empty.no_plant_selected'),
          msg:   Util.t('empty.no_plant_table')
        });
      }
      if (grid) grid.style.visibility = 'hidden';
    } else {
      if (overlay) overlay.remove();
      if (grid) grid.style.visibility = '';
    }
  },

  // AG Grid's built-in no-rows overlay (shown automatically once a plant is
  // selected but the grid displays zero rows — either the plant genuinely has
  // no orders, or the chip/quick/native filters excluded everything). Reuses
  // the app's own EmptyState component instead of AG Grid's raw default text,
  // and offers a one-click way out when filters are the cause.
  _NoRowsOverlay: class {
    _eGui!: HTMLDivElement;
    init(): void {
      const filtered = Table._hasChipFilters()
        || (Table._api && Table._api.isAnyFilterPresent())
        || !!(document.getElementById('quick-filter') as HTMLInputElement | null)?.value;
      this._eGui = document.createElement('div');
      // AG Grid calls init() synchronously as part of agGrid.createGrid()
      // (Table.init()'s initial rowData is always [] at boot, before the
      // async task fetch resolves) — at that exact moment NIMBUS/EmptyState
      // (a forward reference; EmptyState lives in application-shell.mjs,
      // loaded after this module) doesn't exist yet. Skip the render rather
      // than throw; AG Grid re-invokes init() itself once row count changes.
      if (typeof NIMBUS !== 'undefined' && NIMBUS.EmptyState) {
        NIMBUS.EmptyState.render?.(this._eGui, filtered
          ? { title: Util.t('empty.no_orders_filtered_title'), msg: Util.t('empty.no_orders_filtered_msg'), icon: '⌕' }
          : { title: Util.t('empty.no_orders_plant_title'),    msg: Util.t('empty.no_orders_plant_msg') });
      }
      if (filtered) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-ghost sm';
        btn.style.marginTop = '6px';
        btn.textContent = Util.t('btn.clear_filters');
        btn.onclick = () => {
          Table._clearChipFilters();
        };
        this._eGui.querySelector('.nimbus-empty-state')?.appendChild(btn);
      }
    }
    getGui(): HTMLDivElement { return this._eGui; }
  },

  /** Machine lock (decision C, aggregate_to_detail.md §8): a sub-order
   *  (PARENT_ORDER set) may not change machine from the grid, the Inspector
   *  select or a Gantt drag — only adjusting its distribution shares can move
   *  it. Shows the lock toast with an action to open the Order Distribution
   *  pane. Intentionally duplicated (not imported) from gantt.mts's
   *  Interaction._rejectDistMachineMove — kept in sync manually since
   *  Interaction isn't exported/shared with this module. */
  _rejectDistMachineMove(task: NimbusTask): void {
    Toast.show(
      Util.t('toast.dist_machine_locked', { order: Util.orderNumber(task), machine: task.MACHINE || 'Unknown' }),
      'warn', 4000,
      {
        label: Util.t('btn.insp_dist_open'),
        run: () => {
          const app = (globalThis as unknown as { NIMBUS?: { App?: { gotoGanttSub?: (sub: string) => void } } }).NIMBUS?.App;
          app?.gotoGanttSub?.('distribution');
        },
      }
    );
  },

  /** Routing-ineligible machine edit (§8.2/§8.3, ROUTING_RUNTIME_DESIGN.md):
   *  shared toast for the grid, Inspector and Override dialog when
   *  `Runtime.eligible` rejects a manual machine move — toast-only, kept
   *  separate from `_rejectDistMachineMove`'s revert side effects, which
   *  differ per call site (grid reverts a cell, Inspector re-renders, the
   *  Override dialog simply doesn't apply). */
  _toastMachineIneligible(task: NimbusTask, machine: string): void {
    Toast.show(Util.t('toast.no_routing_at_workcenter', { order: Util.orderNumber(task), machine }), 'warn', 4000);
  },

  /** Whether the routing-runtime feature (ROUTING_RUNTIME_DESIGN.md §3.6/§8.1)
   *  is switched on for this task's plant. `Runtime.load` only fetches/caches
   *  a rate map for a plant whose `routing_runtime_enabled` switch is on —
   *  for every other plant `Runtime`'s cache stays empty, so
   *  `Runtime.eligible`/`resolve` would fail closed (`pv_missing`/
   *  `pv_not_found`) for every order regardless of its actual eligibility.
   *  The manual MACHINE/PRODUCTION_VERSION edit guards below must only run
   *  while this is true, or ordinary editing would break on every plant
   *  that hasn't opted in — the default (decision 16, §12 P3). */
  _routingEnabledForTask(task: NimbusTask): boolean {
    const plant = task.PLANT || Store.getPlantForLine(task.MACHINE) || Store.selectedPlant || '';
    if (!plant) return false;
    return !!Store.masterData?.plants?.find(p => p.plant === plant)?.routing_runtime_enabled;
  },

  /** Queue reasons a planner action releases (OQ7, OQ50): an unresolved run time, or an order queued as overlong
   *  or over the run-time cap. Any other reason stays queued until the optimizer or a planner resolves it. */
  _RELEASABLE_HOLDS: new Set(['runtime_unknown', 'overlong_never', 'run_time_over_cap']),

  /** The FINISH a placement edit holds (backward scheduling OQ7): the placed finish; for a releasable held order
   *  (no placed finish) its due instant. Never invent a placement for any other undated order. */
  _runtimeEditAnchor(task: NimbusTask): Date | null {
    const placed = Util.parseDate(task.end_date);
    if (placed) return placed;
    return task.planning_status === 'needs_planning' && Table._RELEASABLE_HOLDS.has(task.planning_reason?.code ?? '')
      ? Util.dueInstant(task) : null;
  },

  /** A manual placement returned null. A firmed order dropped outside working hours asks the planner to confirm
   *  overtime (OQ63) and `retry` runs again with the approval; everything else is explained here, except the
   *  refusal the engine already toasted (`finish_cannot_hold`). */
  _explainManualRefusal(task: NimbusTask, retry: () => void): void {
    const reason = Engine.lastManualRefusal;
    if (reason === 'needs_overtime_confirm') {
      void Engine.confirmOvertimePlacement(task).then(ok => { if (ok) retry(); });
      return;
    }
    if (reason === 'running_finish_locked') {
      Toast.show(Util.t('toast.running_finish_locked', { order: Util.orderNumber(task) }), 'warn', 6000);
      return;
    }
    if (reason !== 'finish_cannot_hold') {
      Toast.show(Util.t('toast.manual_refusal_generic'), 'error');
    }
  },

  /** A (production version, machine) pair that does not resolve on a routing plant (`pv` null = a bare machine
   *  edit, which keeps the older machine-only wording). Shared by the grid, Inspector and Override dialog. */
  _toastPairIneligible(task: NimbusTask, pv: string | null, machine: string): void {
    if (pv == null) { Table._toastMachineIneligible(task, machine); return; }
    Toast.show(Util.t('toast.pv_machine_ineligible', { order: Util.orderNumber(task), pv: pv || '—', machine }), 'warn', 4000);
  },

  /** Run time (and, for a pair, the production version) for an UNPLACED order's machine / pair edit: a held order
   *  has no bar to derive, so the routing value is written straight onto the row. A move always resets the run
   *  time from routing (D9); an unchanged pair writes nothing. */
  _unplacedMachineRuntime(task: NimbusTask, machine: string, pv?: string): Partial<NimbusTask> {
    const currentPv = Runtime.normPv(task.PRODUCTION_VERSION) ?? '';
    const targetPv = pv ?? currentPv;
    if (!Table._routingEnabledForTask(task) || (machine === task.MACHINE && targetPv === currentPv)) return {};
    const result = Runtime.resolve({ ...task, PRODUCTION_VERSION: targetPv }, machine);
    return result.ok ? {
      PRODUCTION_VERSION: targetPv,
      RUN_TIME: result.hours,
      run_time_source: result.basis.source,
      run_time_basis: result.basis as unknown as Record<string, unknown>,
    } : {};
  },

  /** Called when a grid cell is edited. Push the change through the store. */
  _onCellChanged(p: TableCellValueChangedEvent, opts: ManualPlacementOptions = {}): void {
    const field = p.colDef.field;
    const id = String(p.data.id);
    const changes: Partial<NimbusTask> = {};
    let requestedFinish: Date | null = null;
    let requestedLine: string | null = null;
    let scheduleTask = p.data;
    let pairPv: string | null = null;   // set when a routing-plant (PV, machine) pair is being written

    if (field === 'end_date') {
      // The typed End is the finish the planner wants; the start is derived from it (OQ1).
      const d = Util.parseDate(p.newValue);
      if (!d) {
        // AG Grid has already written the unparsable value (null) onto the live Store task; put the finish back.
        p.data.end_date = p.oldValue as Date | null;
        Toast.show(Util.t('toast.invalid_date'), 'error');
        Table._api!.refreshCells({ rowNodes: [p.node] });
        return;
      }
      requestedFinish = d;
      // AG Grid has already written the typed value onto the row; placement must see the end the order had
      // (a marked bar is translated by the delta from it, not stretched).
      scheduleTask = { ...p.data, end_date: p.oldValue as Date | null };
    } else if (field === 'start_date') {
      // The start is derived from the finish; its column is read-only. Put the value back if a stale caller gets here.
      p.data.start_date = p.oldValue as Date | null;
      Table._api!.refreshCells({ rowNodes: [p.node] });
      return;
    } else if (field === 'RUN_TIME') {
      const h = parseFloat(String(p.newValue)) || 0;
      changes.RUN_TIME = h;
      // Release the runtime hold only after constructing a valid placement.
      changes.run_time_source = 'manual';
      scheduleTask = { ...p.data, RUN_TIME: h };
      requestedFinish = Table._runtimeEditAnchor(p.data);
    } else if (field === 'MACHINE') {
      // AG Grid's default valueSetter already wrote the raw editor value onto p.data.MACHINE before this handler
      // runs; on a routing plant that is the pair string 'pv|machine'. Put the parsed machine back first so no
      // path below can leave a pair string in the row.
      const parsed = Table._parsePairValue(String(p.newValue || 'Unknown'));
      const newMachine = parsed.machine || 'Unknown';
      // The pre-edit machine for the lock comparison (decision C, aggregate_to_detail.md §8) has to come from
      // p.oldValue, captured BEFORE the row is overwritten (a null oldValue falls back to the row's machine).
      const priorMachine = String(p.oldValue ?? p.data.MACHINE ?? 'Unknown');
      p.data.MACHINE = newMachine;
      const routing = Table._routingEnabledForTask(p.data);
      const priorPv = Runtime.normPv(p.data.PRODUCTION_VERSION) ?? '';
      const newPv = parsed.pv ?? priorPv;
      const pairChanged = newMachine !== priorMachine || newPv !== priorPv;
      if (p.data.PARENT_ORDER && newMachine !== priorMachine) {
        p.data.MACHINE = priorMachine;
        Table._api!.refreshCells({ rowNodes: [p.node], force: true });
        Table._rejectDistMachineMove(p.data);
        return;
      }
      // Re-picking the pair the order already has changes nothing.
      if (routing && parsed.pv !== null && !pairChanged) {
        p.data.MACHINE = priorMachine;
        Table._api!.refreshCells({ rowNodes: [p.node], force: true });
        return;
      }
      // Routing eligibility guard (§8.2): a (PV, machine) pair the PV's routing does not cover is rejected
      // outright, but only on a plant that has opted into the feature (see _routingEnabledForTask).
      if (routing && pairChanged && !Runtime.eligible({ ...p.data, PRODUCTION_VERSION: newPv }, newMachine)) {
        p.data.MACHINE = priorMachine;
        Table._api!.refreshCells({ rowNodes: [p.node], force: true });
        Table._toastPairIneligible(p.data, parsed.pv, newMachine);
        return;
      }
      // The row object IS the Store task, so AG Grid's write is already visible to the undo snapshot and the
      // line index: put the pre-edit machine back; the single Store.updateTask below applies the new one.
      p.data.MACHINE = priorMachine;
      changes.MACHINE = newMachine;
      if (routing && newPv !== priorPv) changes.PRODUCTION_VERSION = newPv;
      if (routing && pairChanged) pairPv = newPv;
      scheduleTask = { ...p.data, MACHINE: priorMachine };
      requestedLine = changes.MACHINE;
      requestedFinish = Table._runtimeEditAnchor(p.data);
      if (!requestedFinish) Object.assign(changes, Table._unplacedMachineRuntime(scheduleTask, newMachine, newPv));
    } else if (field === 'ORDER_QUANTITY_(GMEIN)') {
      // Unreachable today — this column is editable:false, and ORDER_QUANTITY
      // isn't in Persistence._taskEditSnapshot's payload either (§13.1: no
      // quantity-edit feature exists yet). Sub-orders (PARENT_ORDER set) must
      // reject this edit with toast.dist_quantity_locked once quantity
      // becomes editable — see aggregate_to_detail.md §5.8/§8.
      changes[field] = parseFloat(String(p.newValue)) || 0;
    } else if (field === 'notes') {
      const trimmed = String(p.newValue ?? '').trim();
      Inspector._updateNote(id, trimmed);
      Table._api!.applyTransaction({ update: [Store.tasks[id]] });
      Toast.show(Util.t('toast.row_updated'), 'success', 1200);
      return;
    } else if (field === 'PRT_01' || field === 'PRT_02') {
      // Trim on commit; an id with no inventory row only draws a soft warning (never blocks the edit). A per-order PRT edit
      // is overwritten by the next material-plant stamp.
      const typed = String(p.newValue ?? '').trim();
      // A cleared cell stays NULL (the material-plant stamp only fills NULL, never ''); the task type says string | undefined.
      changes[field] = (typed || null) as unknown as string;
      warnUnknownToolId(p.data, typed);
    } else {
      changes[field!] = p.newValue;
    }

    if (requestedFinish) {
      const targetLine = requestedLine || p.data.MACHINE || 'Unknown';
      // A run-time, machine or version edit holds the finish — except on a RUNNING order, which holds its start
      // (OQ3); a typed End is a placement, not a run-time edit.
      const placeOpts = { ...opts, holdStartIfRunning: field !== 'end_date' };
      const schedule = pairPv !== null
        ? Engine.pairSchedulePatchFor(scheduleTask, pairPv, targetLine, requestedFinish, placeOpts)
        : Engine.manualRoutingSchedulePatchFor(scheduleTask, targetLine, requestedFinish, placeOpts);
      if (!schedule?.start_date || !schedule.end_date) {
        // AG Grid has already applied the edited cell to the Store object.
        // Restore it when allocating the candidate duration fails.
        if (field) Object.assign(p.data, { [field]: p.oldValue });
        Table._api!.refreshCells({ rowNodes: [p.node] });
        Table._explainManualRefusal(p.data, () => {
          if (field) Object.assign(p.data, { [field]: p.newValue });
          Table._onCellChanged(p, { confirmedOvertime: true });
        });
        return;
      }
      Object.assign(changes, schedule);
      if (changes.RUN_TIME != null && p.data.planning_status === 'needs_planning' &&
          p.data.planning_reason?.code === 'runtime_unknown') {
        changes.planning_status = 'scheduled';
        changes.planning_reason = null;
      }
    }

    // A (PV, machine) pair write is one undo step (snapshot before the single Store write, push after).
    const undoSnap = pairPv !== null ? UndoStack.snapshotTasks([id]) : null;
    Store.updateTask(id, changes, 'table');
    if (undoSnap) Table._pushPairUndo(id, undoSnap);
    Table._api!.applyTransaction({ update: [Store.tasks[id]] });
    Alerts.scheduleRecompute();
    Toast.show(Util.t('toast.row_updated'), 'success', 1200);
  },

  /** One undo entry for a (PV, machine) pair write, mirroring the Gantt drop's "Move ..." entry. */
  _pushPairUndo(id: string, snap: NimbusTask[]): void {
    const task = Store.tasks[id];
    UndoStack.push(`Change production version / machine "${(task && (task.text || task.ORDER)) || id}"`,
                   () => UndoStack.restoreTasks(snap), [id]);
  },

  _onSelectionChanged(): void {
    if (!Table._api) return;
    const sel = Table._api.getSelectedRows() as NimbusTask[];
    Table._selectedId = sel.length === 1 ? String(sel[0].id) : null;
  },

  _onRowClicked(event: { data?: NimbusTask }): void {
    if (!event.data) return;
    const task = Store.tasks[event.data.id];
    if (task) {
      const rightSidebar = document.getElementById('right-sidebar');
      if (rightSidebar) {
        rightSidebar.classList.remove('collapsed');
        setTimeout(() => { Timeline.redraw(); TimelineNav.render(); }, Config.ANIM_MS);
      }
      Inspector.show(task);
    }
  },
  _alertSeverity(data: NimbusTask | null): 'err' | 'warn' | null {
    if (!data) return null;
    const ids = Store.alertsByTask().get(String(data.id)) || [];
    if (ids.some(a => a.sev === 'err')) return 'err';
    if (ids.some(a => a.sev === 'warn')) return 'warn';
    return null;
  },

  /** Machine lock (decision C, aggregate_to_detail.md §8): a sub-order
   *  (PARENT_ORDER set) passed as `forTask` gets its current machine as the
   *  sole option, so the MACHINE cell editor structurally cannot offer a
   *  different line — same "no other valid choice" shape used elsewhere for
   *  a locked field. */
  _getLineOptions(forTask?: NimbusTask | null): string[] {
    if (forTask?.PARENT_ORDER) return [forTask.MACHINE || 'Unknown'];
    if (Store.selectedPlant) return Store.linesForSelectedPlant();
    // No plant selected — fall back to the unscoped view rather than showing nothing.
    const set = new Set(Store.tasksArr.map(t => t.MACHINE || 'Unknown'));
    Object.keys(Store.calendars).forEach(l => set.add(l));
    return [...set].sort();
  },

  /** The "PV - Machine" choices shared by the grid editor, the Inspector and the Override dialog. On a routing
   *  plant (and never for a distribution sub-order, which keeps its locked machine) every eligible pair of the
   *  order's material is offered as `{value: 'pv|machine', label}`; a current pair that is not in the set is
   *  prepended with the "not eligible" label so the select still shows the truth. Anywhere else this is today's
   *  line list mapped to `{value: line, label: line}`. */
  _getPairOptions(task: NimbusTask): TableLineOption[] {
    if (task.PARENT_ORDER || !Table._routingEnabledForTask(task)) {
      return Table._getLineOptions(task).map(l => ({ value: l, label: l }));
    }
    const options: TableLineOption[] = Runtime.eligiblePairs(task, { requireOps: true }).map(pair => ({
      value: `${pair.pv}|${pair.machine}`,
      label: Util.t('ui.pv_machine_option', { pv: pair.pv, machine: pair.machine }),
    }));
    const pv = Runtime.normPv(task.PRODUCTION_VERSION) ?? '';
    const machine = task.MACHINE || 'Unknown';
    const current = `${pv}|${machine}`;
    if (!options.some(o => o.value === current)) {
      // Say WHY the current pair is out: the step the real gate fails on (zero_runtime, pv_expired, ...).
      const verdict = Runtime.resolve({ ...task, PRODUCTION_VERSION: pv }, task.MACHINE || undefined);
      const step = verdict.ok ? '' : `: ${verdict.step}`;
      options.unshift({ value: current, label: Util.t('ui.pv_machine_current_ineligible', { pv: pv || '—', machine, step }) });
    }
    return options;
  },

  /** Split an option value at the FIRST `|`: `pv|machine` gives both, a bare machine (non-routing plants, or an
   *  older caller) gives `pv: null` meaning "keep the order's own production version". */
  _parsePairValue(value: string): { pv: string | null; machine: string } {
    const i = value.indexOf('|');
    // The PV half always comes back in the padded form (an empty half stays '').
    return i < 0 ? { pv: null, machine: value } : { pv: Runtime.normPv(value.slice(0, i)) ?? '', machine: value.slice(i + 1) };
  },

  _wireQuickFilter(): void {
    const inp = document.getElementById('quick-filter') as HTMLInputElement | null;
    if (!inp || !Table._api) return;
    inp.addEventListener('input', () => {
      Table._api!.setGridOption('quickFilterText', inp.value);
    });
  },

  /* ---- public actions: firming, override modal, export ------------------ */
  firmSelected(firmed: boolean): void {
    if (!Table._api) return;
    const sel = Table._api.getSelectedRows() as NimbusTask[];
    if (!sel.length) { Toast.show(Util.t('toast.select_rows_first'), 'warn'); return; }
    const ids = sel.map(r => String(r.id));
    const { changed, skipped } = Engine.applyFirm(ids, firmed, 'table');
    if (skipped.length) Toast.show(Util.t('toast.firm_skipped_locked', { n: skipped.length }), 'warn');
    if (!changed.length) {
      if (!skipped.length) Toast.show(Util.t(firmed ? 'toast.firm_none_to_firm' : 'toast.unfirm_none_selected'), 'info');
      return;
    }
    Alerts.scheduleRecompute();
  },

  openOverrideModal(): void {
    const sel = (Table._api ? Table._api.getSelectedRows() : []) as NimbusTask[];
    if (sel.length !== 1) { Toast.show(Util.t('toast.select_one_row'), 'warn'); return; }
    Table._openOverrideModalForId(String(sel[0].id));
  },

  _openOverrideModalForId(id: string): void {
    const t = Store.tasks[id];
    if (!t) return;
    const orderEl = document.getElementById('ovr-order');
    const lineEl = document.getElementById('ovr-line') as HTMLSelectElement | null;
    const firmEl = document.getElementById('ovr-firm') as HTMLInputElement | null;
    if (!orderEl || !lineEl || !firmEl) { ErrorLog.error('ui', 'required DOM elements missing for override modal'); return; }

    Table._selectedId = id;
    orderEl.textContent = `${t.text || t.ORDER || t.id}  ·  ${Util.t('ui.insp_line')}: ${t.MACHINE || '—'}`;
    // The dialog takes the FINISH (backward scheduling OQ1): the start is worked out from it.
    if (!Table._fpOvrFinish) {
      Table._fpOvrFinish = Util.fpDatetime('#ovr-finish');
    }
    Table._fpOvrFinish.setDate(t.end_date!, false);
    const routingPairs = Table._routingEnabledForTask(t) && !t.PARENT_ORDER;
    const selectedValue = routingPairs ? `${Runtime.normPv(t.PRODUCTION_VERSION) ?? ''}|${t.MACHINE || 'Unknown'}` : t.MACHINE;
    lineEl.innerHTML = Table._getPairOptions(t).map(o =>
      `<option value="${Util.escapeHtml(o.value)}" ${o.value === selectedValue ? 'selected' : ''}>${Util.escapeHtml(o.label)}</option>`).join('');
    // D4: the "Also firm" row is hidden while the frozen horizon or a running state locks the order (`.checked`
    // is still set first so a bare test mock works). applyOverride re-checks at apply time.
    firmEl.checked = !!t.firmed;
    const firmRow = (firmEl as { closest?: (s: string) => HTMLElement | null }).closest?.('.chk-row');
    if (firmRow) firmRow.hidden = Engine.firmActionFor(t) === null;
    Modal.open('modal-override');
  },

  applyOverride(opts: ManualPlacementOptions = {}): void {
    const id = Table._selectedId;
    if (!id) return;
    const t = Store.tasks[id];
    if (!t) return;
    const finishEl = document.getElementById('ovr-finish') as HTMLInputElement | null;
    const lineEl = document.getElementById('ovr-line') as HTMLSelectElement | null;
    const firmEl = document.getElementById('ovr-firm') as HTMLInputElement | null;
    if (!finishEl || !lineEl || !firmEl) { ErrorLog.error('ui', 'required DOM elements missing for override modal'); return; }

    const newFinish = Util.parseDate(finishEl.value);
    const parsedLine = Table._parsePairValue(lineEl.value);
    const newLine  = parsedLine.machine;
    const alsoFirm = firmEl.checked;
    if (!newFinish) { Toast.show(Util.t('toast.invalid_date'), 'error'); return; }

    // Machine lock (decision C, aggregate_to_detail.md §8): a sub-order
    // (PARENT_ORDER set) may not change machine via the Override dialog
    // either — same guard as the grid-edit path in _onCellChanged.
    if (t.PARENT_ORDER && newLine !== (t.MACHINE || 'Unknown')) {
      Table._rejectDistMachineMove(t);
      return;
    }

    // Routing eligibility guard (§8.3): the Override dialog can move an
    // order to a different machine or production version, so the PAIR is judged (not the machine alone) the same
    // as the grid/Inspector edit paths before re-placing (only on a plant that has opted into the feature, see
    // _routingEnabledForTask). A finish-only override of an ineligible current pair is blocked as before.
    const routing = Table._routingEnabledForTask(t);
    const currentPv = Runtime.normPv(t.PRODUCTION_VERSION) ?? '';
    const newPv = parsedLine.pv ?? currentPv;
    if (routing && !Runtime.eligible({ ...t, PRODUCTION_VERSION: newPv }, newLine)) {
      Table._toastPairIneligible(t, parsedLine.pv, newLine);
      return;
    }
    const pairChanged = routing && (newLine !== (t.MACHINE || 'Unknown') || newPv !== currentPv);

    const schedule = pairChanged
      ? Engine.pairSchedulePatchFor(t, newPv, newLine, newFinish, opts)
      : Engine.manualRoutingSchedulePatchFor(t, newLine, newFinish, opts);
    if (!schedule?.start_date || !schedule.end_date) {
      Table._explainManualRefusal(t, () => Table.applyOverride({ confirmedOvertime: true }));
      return;
    }

    const undoSnap = pairChanged ? UndoStack.snapshotTasks([id]) : null;
    Store.updateTask(id, schedule, 'table');
    if (undoSnap) Table._pushPairUndo(id, undoSnap);
    if (Table._api) Table._api.applyTransaction({ update: [Store.tasks[id]] });
    // Re-check at apply time: the window may have rolled while the modal was open, and applyFirm
    // refuses a now-locked order.
    if (alsoFirm !== Store.isFirmed(id)) Engine.applyFirm([id], alsoFirm, 'table');

    // Override explicitly does NOT auto-reflow (user's manual choice),
    // but we DO recompute alerts so conflicts become visible.
    Alerts.scheduleRecompute();
    Modal.close('modal-override');
    Toast.show(alsoFirm ? Util.t('toast.order_overridden_firmed') : Util.t('toast.order_overridden'), 'success');
  },

  exportCsv(): void {
    if (!Table._api) return;
    Table._api.exportDataAsCsv({ fileName: 'nimbus-orders.csv', processCellCallback: Util.csvProcessCell });
  },

  _toggleRangeMode(): void {
    const badge  = document.getElementById('orders-copy-badge');
    const gridEl = document.getElementById('ag-grid');
    if (Table._rangeMode) {
      Table._clearRange();
    } else {
      Table._rangeMode = true;
      badge?.classList.add('active');
      gridEl?.classList.add('nimbus-range-mode');
    }
  },

  _applyRangeHighlight(): void {
    if (!Table._rangeAnchor || !Table._rangeActive || !Table._api) return;
    const gridEl = document.getElementById('ag-grid');
    if (!gridEl) return;
    const cols   = Table._api.getAllDisplayedColumns() as AgGridColumn[];
    const colIds = cols.map(c => c.getColId());
    const aIdx   = colIds.indexOf(Table._rangeAnchor.colId);
    const bIdx   = colIds.indexOf(Table._rangeActive.colId);
    if (aIdx === -1 || bIdx === -1) return;
    const minCol = Math.min(aIdx, bIdx);
    const maxCol = Math.max(aIdx, bIdx);
    const minRow = Math.min(Table._rangeAnchor.rowIndex ?? 0, Table._rangeActive.rowIndex ?? 0);
    const maxRow = Math.max(Table._rangeAnchor.rowIndex ?? 0, Table._rangeActive.rowIndex ?? 0);
    const newSet = new Set<string>();
    for (let ri = minRow; ri <= maxRow; ri++) {
      for (let ci = minCol; ci <= maxCol; ci++) {
        newSet.add(`${ri}|${colIds[ci]}`);
      }
    }
    Table._rangeHighlighted.forEach(key => {
      if (!newSet.has(key)) {
        const sep = key.indexOf('|');
        gridEl.querySelector(`.ag-row[row-index="${key.slice(0, sep)}"] .ag-cell[col-id="${key.slice(sep + 1)}"]`)
          ?.classList.remove('nimbus-range-sel');
      }
    });
    newSet.forEach(key => {
      if (!Table._rangeHighlighted.has(key)) {
        const sep = key.indexOf('|');
        gridEl.querySelector(`.ag-row[row-index="${key.slice(0, sep)}"] .ag-cell[col-id="${key.slice(sep + 1)}"]`)
          ?.classList.add('nimbus-range-sel');
      }
    });
    Table._rangeHighlighted = newSet;
  },

  _clearRange(): void {
    const gridEl = document.getElementById('ag-grid');
    Table._rangeHighlighted.forEach(key => {
      const sep = key.indexOf('|');
      gridEl?.querySelector(`.ag-row[row-index="${key.slice(0, sep)}"] .ag-cell[col-id="${key.slice(sep + 1)}"]`)
        ?.classList.remove('nimbus-range-sel');
    });
    Table._rangeHighlighted.clear();
    Table._rangeAnchor  = null;
    Table._rangeActive  = null;
    Table._rangeDragOn  = false;
    Table._rangeMode    = false;
    document.getElementById('orders-copy-badge')?.classList.remove('active');
    gridEl?.classList.remove('nimbus-range-mode');
  },

  _copyRange(): void {
    if (!Table._rangeAnchor || !Table._rangeActive || !Table._api) return;
    const cols   = Table._api.getAllDisplayedColumns() as AgGridColumn[];
    const colIds = cols.map(c => c.getColId());
    const aIdx   = colIds.indexOf(Table._rangeAnchor.colId);
    const bIdx   = colIds.indexOf(Table._rangeActive.colId);
    if (aIdx === -1 || bIdx === -1) return;
    const minCol = Math.min(aIdx, bIdx);
    const maxCol = Math.max(aIdx, bIdx);
    const minRow = Math.min(Table._rangeAnchor.rowIndex ?? 0, Table._rangeActive.rowIndex ?? 0);
    const maxRow = Math.max(Table._rangeAnchor.rowIndex ?? 0, Table._rangeActive.rowIndex ?? 0);
    const rowStrs: string[] = [];
    for (let ri = minRow; ri <= maxRow; ri++) {
      const node = Table._api.getDisplayedRowAtIndex(ri) as AgGridRowNode | undefined;
      if (!node) continue;
      const cells: string[] = [];
      for (let ci = minCol; ci <= maxCol; ci++) {
        const colId  = colIds[ci];
        const col    = cols[ci];
        const raw    = Table._api.getValue(colId, node);
        const colDef = col.getColDef();
        let text: unknown = raw;
        if (colDef.valueFormatter) {
          const fmt = colDef.valueFormatter({ value: raw, data: node.data, node, column: col, api: Table._api, colDef });
          if (fmt != null) text = fmt;
        }
        cells.push(text == null ? '' : String(text));
      }
      rowStrs.push(cells.join('\t'));
    }
    const nRows = maxRow - minRow + 1;
    const nCols = maxCol - minCol + 1;
    // Flash + "Copied" only once the clipboard write actually succeeded; a denied or
    // missing clipboard reports that instead of claiming the copy happened.
    const written = navigator.clipboard
      ? navigator.clipboard.writeText(rowStrs.join('\n'))
      : Promise.reject(new Error('clipboard unavailable'));
    written.then(() => {
      const gridEl = document.getElementById('ag-grid');
      if (gridEl) {
        Table._rangeHighlighted.forEach(key => {
          const sep  = key.indexOf('|');
          const cell = gridEl.querySelector(`.ag-row[row-index="${key.slice(0, sep)}"] .ag-cell[col-id="${key.slice(sep + 1)}"]`);
          if (cell) { cell.classList.add('ag-cell-copy-flash'); setTimeout(() => cell.classList.remove('ag-cell-copy-flash'), 380); }
        });
      }
      Toast.show(Util.t('toast.copied_range').replace('{r}', String(nRows)).replace('{c}', String(nCols)), 'success');
      Table._clearRange();
    }, () => {
      Toast.show(Util.t('toast.clipboard_denied'), 'error');
    });
  },

  _showAlertPopup(taskId: string): void {
    const rel = Store.alertsByTask().get(String(taskId)) || [];
    if (!rel.length) return;
    const t = Store.tasks[taskId];
    const po = Util.orderNumber(t);

    const rows = rel.map(a => {
      const icon  = a.sev === 'err' ? '🔴' : '🟡';
      const date  = a.time ? Util.fmtDTReadable(a.time) : '';
      return `
        <div style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:6px;background:var(--bg-subtle);margin-bottom:6px">
          <span style="flex-shrink:0;font-size:13px;margin-top:1px">${icon}</span>
          <span style="flex:1;font-size:12.5px;color:var(--fg);line-height:1.45">${Util.escapeHtml(Util.alertMessage(a))}</span>
          ${date ? `<span style="flex-shrink:0;font-size:10.5px;color:var(--fg-mute);white-space:nowrap;margin-top:2px">${date}</span>` : ''}
          <button data-alert-id="${Util.escapeHtml(a.id)}"
            style="flex-shrink:0;padding:2px 10px;font-size:11px;border-radius:5px;border:1px solid var(--line);background:none;cursor:pointer;color:var(--fg-mute);white-space:nowrap;margin-top:1px">
            Go to
          </button>
        </div>`;
    }).join('');

    const dlg = document.createElement('dialog');
    dlg.className = 'ni-breakdown-dlg';
    dlg.innerHTML = `
      <div style="padding:20px;min-width:320px;max-width:440px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <h3 style="margin:0;font-size:14px;font-weight:700">⚐ Alerts — Order <span style="color:var(--accent)">${Util.escapeHtml(po)}</span></h3>
          <button data-alert-close style="background:none;border:none;cursor:pointer;font-size:16px;color:var(--fg-mute)">✕</button>
        </div>
        <div>${rows}</div>
      </div>`;
    document.body.appendChild(dlg);
    try { dlg.showModal(); } catch { dlg.open = true; }
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target === dlg || target?.closest('[data-alert-close]')) { dlg.close(); return; }
      const btn = target?.closest('[data-alert-id]') as HTMLElement | null;
      if (btn) { dlg.close(); NIMBUS!.AlertsUIAdapter!.focus!(btn.dataset.alertId ?? ''); }
    });
  },

  _showNotePopover(e: MouseEvent, id: string): void {
    Table._closeNotePopover();
    const task = Store.tasks[id];
    if (!task) return;

    const pop = document.createElement('div');
    pop.id = 'nb-note-popover';
    const cur = task.notes || '';
    pop.innerHTML = `
      <div class="nb-note-pop-header">
        <span>Order Note</span>
        <button class="nb-note-pop-close" onclick="NIMBUS.Table._closeNotePopover()">✕</button>
      </div>
      <textarea id="nb-note-ta" maxlength="500" placeholder="Add a note…">${Util.escapeHtml(cur)}</textarea>
      <div class="nb-note-pop-footer">
        <span id="nb-note-cnt">${cur.length}/500</span>
        <div class="nb-note-pop-btns">
          <button class="nb-note-cancel" onclick="NIMBUS.Table._closeNotePopover()">Cancel</button>
          <button class="nb-note-save" data-note-id="${Util.escapeHtml(id)}">Save</button>
        </div>
      </div>`;
    document.body.appendChild(pop);

    const btn = (e.target as Element | null)?.closest('button') as HTMLElement ?? (e.target as HTMLElement);
    const rect = btn.getBoundingClientRect();
    const popW = 284;
    let left = Math.max(4, Math.min(rect.left, window.innerWidth - popW - 4));
    pop.style.left = left + 'px';
    pop.style.top = '0px'; // temp placement so offsetHeight is measurable
    requestAnimationFrame(() => {
      const h = pop.offsetHeight;
      const spaceAbove = rect.top - 8;
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      let top = spaceAbove >= h || spaceAbove >= spaceBelow
        ? Math.max(4, rect.top - h - 4)
        : rect.bottom + 4;
      pop.style.top = top + 'px';
    });

    const ta = document.getElementById('nb-note-ta') as HTMLTextAreaElement | null;
    const cnt = document.getElementById('nb-note-cnt');
    if (!ta || !cnt) { ErrorLog.error('ui', 'required DOM elements missing for note popover'); return; }
    ta.addEventListener('input', () => {
      cnt.textContent = ta.value.length + '/500';
    });
    pop.querySelector<HTMLElement>('.nb-note-save')?.addEventListener('click', (ev) => {
      Table._saveNotePopover((ev.currentTarget as HTMLElement).dataset.noteId ?? '');
    });
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    setTimeout(() => {
      Table._noteOutsideHandler = (ev: MouseEvent) => { if (!pop.contains(ev.target as Node)) Table._closeNotePopover(); };
      document.addEventListener('mousedown', Table._noteOutsideHandler);
    }, 0);
    Table._noteKeyHandler = (ev: KeyboardEvent) => { if (ev.key === 'Escape') Table._closeNotePopover(); };
    document.addEventListener('keydown', Table._noteKeyHandler);
  },

  _saveNotePopover(id: string): void {
    const ta = document.getElementById('nb-note-ta') as HTMLTextAreaElement | null;
    if (!ta) { ErrorLog.error('ui', 'required DOM element missing: nb-note-ta'); return; }
    if (!Table._api) { ErrorLog.error('ui', 'Table._api not initialized'); return; }
    const val = ta.value.trim().slice(0, 500) || null;
    Inspector._updateNote(id, val);
    Table._closeNotePopover();
    Table._api.applyTransaction({ update: [Store.tasks[id]] });
  },

  _closeNotePopover(): void {
    const pop = document.getElementById('nb-note-popover');
    if (pop) pop.remove();
    if (Table._noteOutsideHandler) {
      document.removeEventListener('mousedown', Table._noteOutsideHandler);
      Table._noteOutsideHandler = null;
    }
    if (Table._noteKeyHandler) {
      document.removeEventListener('keydown', Table._noteKeyHandler);
      Table._noteKeyHandler = null;
    }
  },

  /** A minimal inline date-time text editor for AG Grid. Typed as MM/DD/YYYY HH:mm (24h) so it
   *  never follows the browser locale (a native datetime-local input does). */
  _DateTimeEditor: class {
    _input!: HTMLInputElement;
    init(params: { value: unknown }): void {
      this._input = document.createElement('input');
      this._input.type = 'text';
      this._input.placeholder = 'MM/DD/YYYY HH:mm';
      this._input.style.width = '100%';
      this._input.style.height = '30px';
      this._input.style.border = '1px solid var(--accent)';
      this._input.style.padding = '0 6px';
      this._input.style.fontSize = '12px';
      this._input.value = Util.fmtDT(params.value);
    }
    getGui(): HTMLInputElement { return this._input; }
    afterGuiAttached(): void { this._input.focus(); this._input.select(); }
    getValue(): Date | null {
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T]+(\d{1,2}):(\d{2}))?$/.exec(this._input.value.trim());
      if (!m) return null;
      const [mo, da, yr, hh, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)];
      const d = new Date(yr, mo - 1, da, hh, mi);
      return d.getMonth() === mo - 1 && d.getDate() === da && hh < 24 && mi < 60 ? d : null;
    }
    destroy(): void {}
  },

  // Scale mandate (CLAUDE.md Production Scale Roadmap): the line-reassignment
  // editor is the actual scheduling control (not just a filter), so it needs
  // type-to-filter even more than the chip picker does — AG Grid Community has
  // no searchable select (that's Enterprise's agRichSelectCellEditor), so this
  // is a small hand-rolled popup editor: text input + filtered option list.
  _SearchableLineEditor: class {
    _params!: TableLineEditorParams;
    _values!: TableLineOption[];
    _pairMode = false;
    _chosen: string | null = null;
    _activeIdx = 0;
    _untouched = true;   // no keystroke or arrow yet: Enter keeps the current value
    _eGui!: HTMLDivElement;
    _input!: HTMLInputElement;
    _list!: HTMLDivElement;
    _filtered!: TableLineOption[];

    init(params: TableLineEditorParams): void {
      this._params = params;
      const raw = (typeof params.values === 'function' ? params.values() : params.values) || [];
      // Plain strings (non-routing plants) and {value,label} options (a routing plant's "PV - Machine" pairs).
      this._values = raw.map(v => typeof v === 'string' ? { value: v, label: v } : v);
      this._pairMode = this._values.some(o => o.value.includes('|'));
      this._chosen = null;
      this._activeIdx = 0;
      this._untouched = true;

      this._eGui = document.createElement('div');
      this._eGui.className = 'nse-editor';
      this._eGui.innerHTML = `<input type="text" class="nse-input" autocomplete="off"><div class="nse-list"></div>`;
      this._input = this._eGui.querySelector('.nse-input')!;
      this._list  = this._eGui.querySelector('.nse-list')!;
      this._input.value = params.value || '';
      this._input.addEventListener('input', () => { this._untouched = false; this._renderList(this._input.value); });
      this._input.addEventListener('keydown', (e: KeyboardEvent) => this._onKeyDown(e));
      this._list.setAttribute('role', 'listbox');
      this._input.setAttribute('role', 'combobox');
      this._input.setAttribute('aria-expanded', 'true');
      // The row's current value (a pair's value on a routing plant, else the machine) starts highlighted.
      const currentValue = this._pairMode && params.data
        ? `${Runtime.normPv(params.data.PRODUCTION_VERSION) ?? ''}|${params.data.MACHINE ?? params.value ?? ''}`
        : String(params.value ?? '');
      this._renderList('', initialActiveIndex(this._values, currentValue));
    }
    _renderList(q: string, activeIdx = 0): void {
      const query = q.toLowerCase().trim();
      this._filtered = query ? this._values.filter(o => o.label.toLowerCase().includes(query)) : this._values;
      this._activeIdx = activeIdx;
      this._list.innerHTML = this._filtered.length
        ? this._filtered.map((o, i) => `<div class="nse-opt${i === activeIdx ? ' active' : ''}" id="nse-opt-${i}" role="option" aria-selected="${i === activeIdx}" data-i="${i}">${Util.escapeHtml(o.label)}</div>`).join('')
        : `<div class="nse-empty">${Util.t('ui.no_matches')}</div>`;
      this._syncActive(false);
      this._list.querySelectorAll('.nse-opt').forEach((el) => {
        el.addEventListener('mousedown', (e: Event) => { e.preventDefault(); this._choose(Number((el as HTMLElement).dataset.i)); });
      });
    }
    _choose(i: number): void {
      const o = this._filtered[i];
      if (o == null) return;
      this._chosen = o.value;
      this._input.value = o.label;
      this._params.api.stopEditing();
    }
    _onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'ArrowDown') { e.preventDefault(); this._move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this._move(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        // Enter on an untouched editor keeps the current value instead of reassigning to the highlighted row.
        if (this._untouched) this._params.api.stopEditing(true);
        else this._choose(this._activeIdx);
      }
      else if (e.key === 'Escape') { this._params.api.stopEditing(true); }
    }
    _move(delta: number): void {
      if (!this._filtered.length) return;
      this._untouched = false;
      this._activeIdx = (this._activeIdx + delta + this._filtered.length) % this._filtered.length;
      this._syncActive(true);
    }
    /** Marks the active option (class, aria-selected, aria-activedescendant) and keeps it in view. */
    _syncActive(scroll: boolean): void {
      this._list.querySelectorAll('.nse-opt').forEach((el, i) => {
        const on = i === this._activeIdx;
        el.classList.toggle('active', on);
        el.setAttribute('aria-selected', String(on));
        if (on) {
          this._input.setAttribute('aria-activedescendant', (el as HTMLElement).id);
          if (scroll) (el as HTMLElement).scrollIntoView?.({ block: 'nearest' });
        }
      });
    }
    getGui(): HTMLDivElement { return this._eGui; }
    afterGuiAttached(): void { this._input.focus(); this._input.select(); this._syncActive(true); }
    getValue(): string | null {
      if (this._chosen != null) return this._chosen;
      const typed = this._input.value.trim().toLowerCase();
      const exact = this._values.find(o => o.label.toLowerCase() === typed || o.value.toLowerCase() === typed);
      if (exact != null) return exact.value;
      if (this._pairMode) {
        // Nothing chosen from a pair list: answer with the row's own pair, never a bare machine (the cell handler
        // treats an unchanged pair as a no-op).
        const data = this._params.data;
        return `${Runtime.normPv(data?.PRODUCTION_VERSION) ?? ''}|${data?.MACHINE ?? this._params.value ?? ''}`;
      }
      return this._params.value;
    }
    isPopup(): boolean { return true; }
    destroy(): void {}
  }
};

// -- Local type declarations (CQ-1 Phase 6 Task 3 conversion; scoped to
//    Inspector) ---------------------------------------------------------------

/** Inspector._onFieldChange's `[data-field]` inputs — Inspector._render() only
 *  ever wires MACHINE (<select>), notes (<textarea>), start_date
 *  (<input>, upgraded to Flatpickr), RUN_TIME (<input type=number>), the
 *  priority attributes (PRT_01/PRT_02/PRODUCTION_VERSION), plus the open
 *  SAP-column bag via ORDER_QUANTITY_(GMEIN) — but the field name arrives as
 *  a plain string read off the DOM, not a compile-time literal. */
type InspectorFieldEl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** P2: after clearing the MANUAL firm layer, tell the planner if the order is
 *  still firmed via the union (frozen horizon or running; SAP's flag never locks) — otherwise
 *  "Unfirm" silently no-ops from the planner's point of view. Called from
 *  every unfirm entry point: context-menu, Inspector, F-key, Dashboard. */
/** Click-time mismatch message: still locked (frozen/running) vs. already changed elsewhere (another tab). */
/** Index of the option whose value equals `current` (0 when none does or nothing is current). */
export function initialActiveIndex(options: ReadonlyArray<{ value: string }>, current: string | null | undefined): number {
  if (current == null || current === '') return 0;
  const i = options.findIndex(o => o.value === current);
  return i >= 0 ? i : 0;
}

/** A FastAPI error body's `detail` as one readable string: a string as-is, a 422 array as its messages joined. */
export function formatApiDetail(detail: unknown, fallback: string): string {
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail.map(d => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : String(d))).join('; ');
  }
  return fallback;
}

/** True when the task belongs to `plant`: its own PLANT, else the plant its line maps to. */
export function inSelectedPlantFor(t: { PLANT?: string | null; MACHINE?: string | null }, plant: string | null | undefined,
  plantForLine: (machine: string) => string | null | undefined): boolean {
  if (!plant) return false;
  return (t.PLANT || plantForLine(t.MACHINE as string)) === plant;
}

/** Whether the open Inspector must re-render for a Store event. Pure: the subscriber supplies the open id and
 *  whether the notes textarea holds focus. A re-render replaces the panel's innerHTML, so it is skipped for note
 *  saves (they would swallow the next click), for events that do not name the open order, and while typing a note. */
export function inspectorShouldRerender(evt: { type?: string; source?: string; id?: unknown; ids?: unknown },
  currentId: string | null, notesFocused: boolean): boolean {
  if (!currentId) return false;
  if (notesFocused) return false;
  if (evt.source === 'note') return false;
  if (evt.type === 'task:update') return String(evt.id) === currentId;
  if (evt.type === 'tasks:bulkUpdate' || evt.type === 'firmed:change') {
    return Array.isArray(evt.ids) && (evt.ids as unknown[]).some(i => String(i) === currentId);
  }
  return evt.type === 'tasks:bulk' || evt.type === 'setup-snapshot:replace';
}

export function firmMismatchMessage(task: NimbusTask | undefined): string {
  return Util.t(task && Engine.firmActionFor(task) === null ? 'toast.still_firmed' : 'toast.firm_state_changed');
}

export function notifyResidualFirming(ids: string[]): void {
  const still = ids.some(id => { const t = Store.tasks[id]; return !!t && Engine.firmingStatus(t).firmed; });
  if (still) Toast.show(Util.t('toast.still_firmed'));
}

/* =============================================================================
   ORDER HISTORY — pure view-model for the Inspector History card (schedule_event rows from
   GET /schedule-events/{plant}/order/{order_id}). DOM-free so tests can pin the formatting.
   ========================================================================== */
export interface HistoryEvent {
  id: number;
  at: string;
  actor: string | null;
  actor_name?: string | null;
  source: string;
  op: string;
  action_id: string;
  client_id?: string | null;
  changes: Record<string, [unknown, unknown] | unknown[]>;
}
export interface HistoryLine { field: string; before: string; after: string; text: string }
export interface HistoryRowView { when: string; who: string; source: string; op: string; lines: HistoryLine[] }
type HistoryT = (key: string, vars?: Record<string, string | number>) => string;

const HISTORY_DATE_FIELDS = new Set(['scheduled_start', 'scheduled_end', 'basic_finish_date']);
const HISTORY_PSEUDO_FIELDS = new Set(['carried_from', 'superseded_by']);

/** A translation, or the English fallback when the key is not in the catalog (Util.t echoes the key). */
function historyLabel(t: HistoryT, key: string, fallback: string, vars?: Record<string, string | number>): string {
  const out = t(key, vars);
  return !out || out === key ? fallback : out;
}

function historyValue(field: string, v: unknown, t: HistoryT, fmt: (d: unknown) => string): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? historyLabel(t, 'ui.history_yes', 'Yes') : historyLabel(t, 'ui.history_no', 'No');
  if (field === 'planning_status' && typeof v === 'string') {
    const [status, code] = v.split(':', 2);
    const label = status === 'needs_planning' ? historyLabel(t, 'ui.needs_planning', 'Needs Planning')
      : status === 'scheduled' ? historyLabel(t, 'ui.planning_status_scheduled', 'Scheduled') : status;
    return code ? `${label} (${code})` : label;
  }
  if (HISTORY_DATE_FIELDS.has(field) && typeof v === 'string') return fmt(v) || v;
  return String(v);
}

/** One event as display strings: `modify` -> "field: before -> after" per changed field; `create` / `remove`
 *  -> a Created / Removed line then the snapshot; carried_from / superseded_by -> one short line each. */
export function historyRowView(event: HistoryEvent, t: HistoryT, fmt: (d: unknown) => string): HistoryRowView {
  const lines: HistoryLine[] = [];
  const op = event.op;
  if (op === 'create' || op === 'remove') {
    const head = op === 'create' ? historyLabel(t, 'ui.history_op_create', 'Created') : historyLabel(t, 'ui.history_op_remove', 'Removed');
    lines.push({ field: '', before: '', after: '', text: head });
  }
  for (const [field, pair] of Object.entries(event.changes || {})) {
    const before = Array.isArray(pair) ? pair[0] : undefined;
    const after = Array.isArray(pair) ? pair[1] : undefined;
    if (HISTORY_PSEUDO_FIELDS.has(field)) {
      const other = String(field === 'carried_from' ? before ?? after ?? '' : after ?? before ?? '');
      const key = field === 'carried_from' ? 'ui.history_carried_from' : 'ui.history_superseded_by';
      const fallback = field === 'carried_from' ? `Carried from ${other}` : `Superseded by ${other}`;
      lines.push({ field, before: '', after: other, text: historyLabel(t, key, fallback, { id: other }) });
      continue;
    }
    const label = historyLabel(t, `ui.history_field_${field}`, field);
    const b = historyValue(field, before, t, fmt);
    const a = historyValue(field, after, t, fmt);
    if (op === 'create') lines.push({ field: label, before: '', after: a, text: `${label}: ${a}` });
    else if (op === 'remove') lines.push({ field: label, before: b, after: '', text: `${label}: ${b}` });
    else lines.push({ field: label, before: b, after: a, text: `${label}: ${b} → ${a}` });
  }
  return {
    when: fmt(event.at) || String(event.at ?? ''),
    who: event.actor_name || event.actor || historyLabel(t, 'ui.history_actor_system', 'System'),
    source: historyLabel(t, `ui.history_source_${event.source}`, String(event.source ?? '')),
    op,
    lines,
  };
}

/** Consecutive events sharing an action_id (events arrive newest-first) -> one group each. */
export function groupHistoryEvents(events: HistoryEvent[]): HistoryEvent[][] {
  const groups: HistoryEvent[][] = [];
  for (const e of events) {
    const last = groups[groups.length - 1];
    if (last && last[0].action_id === e.action_id) last.push(e); else groups.push([e]);
  }
  return groups;
}

const HISTORY_CACHE_CAP = 200;
/** A cached History entry older than this is refetched on the next show: another user or SAP may have written since. */
const HISTORY_MAX_AGE_MS = 60_000;

/* =============================================================================
   INSPECTOR — right-side detail panel shown on the Timeline tab.
   Edits here write through the Store (source: 'inspector').
   ========================================================================== */
export const Inspector = {
  _currentId: null as string | null,
  _unsubStore: null as (() => void) | null,
  // Order history (schedule_event) per order id, newest first. FIFO-capped; dropped by invalidateHistory().
  _history: new Map<string, { events: HistoryEvent[]; more: boolean; at: number }>(),
  _historyInflight: new Set<string>(),
  _historyError: new Set<string>(),
  // Bumped by invalidateHistory(); a fetch that started under an older value is discarded and re-run.
  _historyGen: new Map<string, number>(),
  // Bumped by resetHistory() (plant load / plant switch): invalidates every in-flight fetch at once.
  _historyEpoch: 0,
  // The Planned Finish Flatpickr is built on an <input> that every _render() replaces, so the
  // previous instance (and its calendar popup appended to <body>) must be destroyed first —
  // otherwise one picker + one popup DOM tree leaks per render.
  _fpEnd: null as NimbusVendor.FlatpickrInstance | null,
  _destroyEndPicker(): void {
    const fp = Inspector._fpEnd;
    Inspector._fpEnd = null;
    try { fp?.destroy(); } catch { /* already torn down with its DOM */ }
  },

  // Admin-configured Orders field visibility (system_settings.orderFields,
  // frontend/order-field-catalog.mjs) for the Inspector surface. No live-refresh
  // subscription needed — _render() already runs fresh on every task
  // selection, so a later System Configuration change is picked up the next
  // time this panel opens.
  _fieldVisible(key: string): boolean {
    const f = ORDER_FIELD_CATALOG.find(c => c.key === key);
    if (!f) return true;
    const cfg = Store.orderFieldVisibility[key];
    return cfg?.inspector ?? f.inspectorDefault;
  },

  init(): void {
    Inspector._unsubStore = Store.subscribe(evt => {
    // A plant load/reload or a plant switch replaces the rows wholesale: another user's or SAP's edits may sit
    // behind any cached history, so drop all of it (the card refetches when it is next painted).
    if (evt.type === 'tasks:bulk' || evt.type === 'plant:selected') Inspector.resetHistory();
    if (evt.type === 'tasks:saved') { Inspector.invalidateHistory((evt.ids ?? []) as Array<string | number>); return; }
    // Allow firmed:change through even from 'inspector' so the Firm/Unfirm
    // button re-renders after toggleFirm() — otherwise it never flips.
    if (evt.source === 'inspector' && evt.type !== 'firmed:change') return;
      if (evt.type === 'plant:selected') {
        const t = Inspector._currentId ? Store.tasks[Inspector._currentId] : null;
        if (!t || !Store.selectedPlant
            || Store.getPlantForLine(t.MACHINE) !== Store.selectedPlant) {
          Inspector.clear();
        }
        return;
      }
      const notesFocused = typeof document !== 'undefined'
        && !!(document.activeElement as HTMLElement | null)?.matches?.('[data-field="notes"]');
      if (!inspectorShouldRerender(evt, Inspector._currentId, notesFocused)) return;
      const t = Store.tasks[Inspector._currentId!];
      if (t) Inspector._render(t);
      else if (evt.type !== 'task:update') Inspector.clear();
    }, 'Inspector');
  },

  show(task: NimbusTask): void {
    // Refuse to inspect tasks that don't belong to the current plant scope.
    // Only block when the task's plant is positively known and wrong — if
    // getPlantForLine returns null (line unmapped), allow inspection rather
    // than silently failing.
    const taskPlant = Store.getPlantForLine(task.MACHINE) || task.PLANT || null;
    if (Store.selectedPlant && taskPlant && taskPlant !== Store.selectedPlant) {
      Toast.show(Util.t('toast.order_belongs_other_plant'), 'warn');
      return;
    }
    Inspector._currentId = String(task.id);
    // An explicit selection retries a history load that failed earlier (re-renders do not).
    Inspector._historyError.delete(String(task.id));
    Inspector._render(task);
  },

  /** Drop every cached history (and error) and invalidate all in-flight fetches. */
  resetHistory(): void {
    Inspector._history.clear();
    Inspector._historyError.clear();
    Inspector._historyGen.clear();
    Inspector._historyEpoch++;
  },

  /** Drop cached history for these orders (their events changed server-side); refetch if one is on screen. */
  invalidateHistory(ids: Array<string | number>): void {
    let touchesCurrent = false;
    for (const raw of ids) {
      const id = String(raw);
      Inspector._history.delete(id);
      Inspector._historyError.delete(id);
      Inspector._historyGen.set(id, (Inspector._historyGen.get(id) ?? 0) + 1);
      if (id === Inspector._currentId) touchesCurrent = true;
    }
    if (touchesCurrent && Inspector._currentId) Inspector._fillHistory(Inspector._currentId);
  },

  /** The History card body for this order, or null when the panel shows another order (or nothing). */
  _historyBodyFor(id: string): HTMLElement | null {
    const card = document.getElementById('inspector-body')?.querySelector<HTMLElement>('.insp-history');
    if (!card || card.getAttribute('data-history-for') !== id) return null;
    return card.querySelector<HTMLElement>('.insp-history-body');
  },

  _historyNote(body: HTMLElement, text: string): void {
    body.replaceChildren();
    const note = document.createElement('div');
    note.className = 'insp-history-note';
    note.textContent = text;
    body.appendChild(note);
  },

  /** Cached -> render now; otherwise show a loading line and fetch (deduplicated). */
  _fillHistory(id: string): void {
    const body = Inspector._historyBodyFor(id);
    if (!body) return;
    let cached = Inspector._history.get(id);
    if (cached && Date.now() - cached.at > HISTORY_MAX_AGE_MS) { Inspector._history.delete(id); cached = undefined; }
    if (cached) { Inspector._renderHistory(body, cached.events, cached.more); return; }
    if (Inspector._historyError.has(id)) { Inspector._historyNote(body, Util.t('ui.insp_history_error')); return; }
    Inspector._historyNote(body, Util.t('ui.insp_history_loading'));
    void Inspector._loadHistory(id);
  },

  async _loadHistory(id: string): Promise<void> {
    if (Inspector._historyInflight.has(id)) return;
    Inspector._historyInflight.add(id);
    const gen = Inspector._historyGen.get(id) ?? 0;
    const epoch = Inspector._historyEpoch;
    let events: HistoryEvent[] | null = null;
    let more = false;
    try {
      const task = Store.tasks[id];
      const plant = (task && (Store.getPlantForLine(task.MACHINE) || task.PLANT)) || Store.selectedPlant || '';
      if (!plant) throw new Error('no plant for order');
      const r = await Util.fetchTraced(
        `${Config.API_BASE}/schedule-events/${encodeURIComponent(plant)}/order/${encodeURIComponent(id)}?limit=20`,
        { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { events?: HistoryEvent[]; next_before_id?: number | null };
      events = Array.isArray(data.events) ? data.events : [];
      more = data.next_before_id != null;
    } catch (e) {
      ErrorLog.warn('inspector', `Order history load failed: ${(e as Error).message}`, { id });
    } finally {
      Inspector._historyInflight.delete(id);
    }
    if ((Inspector._historyGen.get(id) ?? 0) !== gen || Inspector._historyEpoch !== epoch) {
      // The order was saved while this request was in flight: the answer may predate the save.
      if (id === Inspector._currentId) Inspector._fillHistory(id);
      return;
    }
    if (events) {
      Inspector._history.set(id, { events, more, at: Date.now() });
      while (Inspector._history.size > HISTORY_CACHE_CAP) {
        const oldest = Inspector._history.keys().next().value;
        if (oldest === undefined) break;
        Inspector._history.delete(oldest);
      }
    } else {
      Inspector._historyError.add(id);
    }
    if (id === Inspector._currentId) Inspector._fillHistory(id);
  },

  _renderHistory(body: HTMLElement, events: HistoryEvent[], more = false): void {
    if (!events.length) {
      Inspector._historyNote(body, Util.t('ui.insp_history_empty', { days: Persistence.scheduleEventRetentionDays }));
      return;
    }
    body.replaceChildren();
    for (const group of groupHistoryEvents(events)) {
      const views = group.map(e => historyRowView(e, (k, v) => Util.t(k, v), d => Util.fmtDTReadable(d)));
      const wrap = document.createElement('div');
      wrap.className = 'insp-history-group';
      const head = document.createElement('div');
      head.className = 'insp-history-head';
      head.textContent = `${views[0].when} · ${views[0].who} · ${views[0].source}`;
      wrap.appendChild(head);
      for (const view of views) {
        for (const line of view.lines) {
          const row = document.createElement('div');
          row.className = 'insp-history-line';
          row.textContent = line.text;
          wrap.appendChild(row);
        }
      }
      body.appendChild(wrap);
    }
    if (more) {
      const tail = document.createElement('div');
      tail.className = 'insp-history-note insp-history-more';
      tail.textContent = Util.t('ui.insp_history_more');
      body.appendChild(tail);
    }
  },
  clear(): void {
    Inspector._currentId = null;
    Inspector._destroyEndPicker();
    const body = document.getElementById('inspector-body');
    if (body) body.innerHTML = `<div class="empty-state">${Util.t('empty.select_order')}</div>`;
  },

  _formatSetupState(state: SetupStateKey | null, definition: { fields: ReadonlyArray<string> } | null | undefined): string | null {
    if (!state || !definition) return null;
    const values = new Map(state.map(part => [part.fieldKey, part.value]));
    const labels: Record<string, string> = { colorWheel: 'Color', prt01: 'PRT01', prt02: 'PRT02', productionVersion: 'Production version' };
    return definition.fields.map(field => `${labels[field] || field}: ${values.get(field) || '—'}`).join(' · ');
  },

  _isSetupActionTask(task: NimbusTask, now: Date = new Date()): boolean {
    const lineTasks = Store.tasksArr.filter(candidate => candidate.MACHINE === task.MACHINE)
      .map(candidate => ({ task: candidate, start: Util.parseDate(candidate.start_date), end: Util.parseDate(candidate.end_date) }))
      .filter((candidate): candidate is { task: NimbusTask; start: Date; end: Date } => !!candidate.start && !!candidate.end)
      .sort((left, right) => left.start.getTime() - right.start.getTime() || String(left.task.id).localeCompare(String(right.task.id)));
    const active = lineTasks.find(candidate => candidate.start <= now && candidate.end > now);
    const current = active || lineTasks.find(candidate => candidate.start >= now);
    return String(current?.task.id || '') === String(task.id);
  },

  _setupOverrideValues(baseline: number | null, adjustmentText: string, totalText: string): { standardMin: number; remainingMin: number } | null {
    if (baseline != null) {
      if (!adjustmentText.trim()) return null;
      const adjustment = Number(adjustmentText);
      if (!Number.isInteger(adjustment)) return null;
      const remainingMin = baseline + adjustment;
      return remainingMin >= 0 ? { standardMin: baseline, remainingMin } : null;
    }
    if (!totalText.trim()) return null;
    const total = Number(totalText);
    return Number.isInteger(total) && total >= 0 ? { standardMin: total, remainingMin: total } : null;
  },

  _canWriteSetup(plant: string): boolean {
    const permissions = Session.currentUser()?.role_settings?.permissions as Record<string, unknown> | undefined;
    const allowed = Session.allowedPlants();
    return Session.isAdmin() || (permissions?.setup_scheduler === true && (allowed === null || allowed?.includes(plant)));
  },

  _setupOverrideFor(task: NimbusTask): { predecessorOrderId: string | null; predecessorState: SetupStateKey; successorState: SetupStateKey; baseline: number | null; existing: SetupOccurrenceOverride | undefined } | null {
    const snapshot = Store.setupSnapshot;
    const definition = snapshot?.definition;
    if (!snapshot || !definition) return null;
    // Deliberately ungated (not Timeline._setupObservation): overrides must resolve the real predecessor on a
    // setup-off plant too, while the display paths stay empty there.
    const observation = deriveSetupObservation(snapshot, Store.tasksForSelectedPlant(), undefined, {
      calendars: Store.calendars, plants: Store.plants, lineSettings: Store.lineSettings,
      masterData: Store.masterData, blocks: Store.blocks, plantBlocks: Store.plantBlocks,
    });
    const interval = observation.intervals.find(entry => String(entry.successorOrderId) === String(task.id));
    const diagnostic = observation.diagnostics.find(entry => String(entry.successorOrderId || '') === String(task.id));
    const predecessorOrderId = interval?.predecessorOrderId ?? diagnostic?.predecessorOrderId ?? null;
    const predecessor = predecessorOrderId ? Store.tasks[String(predecessorOrderId)] : null;
    const predecessorState = predecessor ? stateForOrder(predecessor, definition)
      : snapshot.machine_states.find(state => state.machine === task.MACHINE && state.signature_version === definition.signature_version)?.state_key || null;
    const successorState = stateForOrder(task, definition);
    if (!predecessorState || !successorState) return null;
    const resolved = resolveSetup({ definition, machine: task.MACHINE, predecessorState, successorState,
      predecessorOrderId, successorOrderId: String(task.id), plantRows: snapshot.plant_rows, machineRows: snapshot.machine_rows, overrides: snapshot.overrides, valueDefaults: snapshot.value_defaults ?? [] });
    const existing = snapshot.overrides.find(override => override.status === 'active' && override.machine === task.MACHINE
      && override.signature_version === definition.signature_version && override.predecessor_order_id === predecessorOrderId
      && override.successor_order_id === String(task.id));
    return { predecessorOrderId, predecessorState, successorState,
      baseline: resolved.covered && resolved.standardMin != null ? resolved.standardMin : null, existing };
  },

  /** Keyboard/screen-reader equivalent of a setup bar: detail belongs to the
   * successor order, never to a selectable synthetic timeline item. */
  _setupDetailForTask(task: NimbusTask, observation: SetupObservation = Timeline._setupObservation(Store.tasksForSelectedPlant())): SetupPresentationDetail {
    const id = String(task.id);
    const interval = observation.intervals.find(entry => String(entry.successorOrderId) === id);
    const diagnostic = observation.diagnostics.find(entry => String(entry.successorOrderId || '') === id);
    const hasObservedEntry = !!interval || !!diagnostic;
    // Keep a stable detail surface for every order. Positive setup intervals
    // and diagnostics supply their existing facts; an order with neither still
    // gets an honest, placeholder-only panel instead of losing the section.
    const entry: any = interval || diagnostic || { successorOrderId: id };
    const snapshot = Store.setupSnapshot;
    const definition = snapshot?.definition;
    const predecessor = hasObservedEntry && entry.predecessorOrderId ? Store.tasks[String(entry.predecessorOrderId)] : null;
    const predecessorState = hasObservedEntry && definition
      ? (predecessor ? stateForOrder(predecessor, definition)
        : snapshot?.machine_states.find(state => state.machine === task.MACHINE && state.signature_version === definition.signature_version)?.state_key)
      : null;
    const successorState = hasObservedEntry && definition ? stateForOrder(task, definition) : null;
    const resolved = hasObservedEntry && definition && predecessorState && successorState && snapshot
      ? resolveSetup({ definition, machine: task.MACHINE, predecessorState, successorState,
        predecessorOrderId: entry.predecessorOrderId ?? null, successorOrderId: id,
        plantRows: snapshot.plant_rows, machineRows: snapshot.machine_rows, overrides: snapshot.overrides, valueDefaults: snapshot.value_defaults ?? [] }) : null;
    const scheduledPredecessor = predecessorOnMachine(task, Store.tasksByPlant(String(task.PLANT ?? task.plant ?? '') || null));
    const predecessorStateText = hasObservedEntry
      ? (Inspector._formatSetupState(predecessorState ?? null, definition) || entry.predecessorState || null)
      : null;
    return {
      // Naming the predecessor needs no setup definition, so it comes from the
      // schedule rather than the observation entry (which still drives state/resolve above).
      // undefined = unknown (unscheduled / no machine); null = first on machine.
      predecessorOrderId: scheduledPredecessor === undefined ? undefined : (scheduledPredecessor ? String(scheduledPredecessor.id) : null),
      predecessorState: predecessorStateText,
      successorOrderId: id,
      requiredMinutes: Number.isFinite(entry.requiredMinutes) ? entry.requiredMinutes : null,
      effectiveMinutes: resolved?.effectiveMin ?? (Number.isFinite(entry.effectiveMinutes) ? entry.effectiveMinutes : (Number.isFinite(entry.requiredMinutes) ? entry.requiredMinutes : null)),
      standardMinutes: resolved?.standardMin ?? (Number.isFinite(entry.standardMinutes) ? entry.standardMinutes : (Number.isFinite(entry.requiredMinutes) ? entry.requiredMinutes : null)),
      source: resolved?.source ?? (entry.source || (hasObservedEntry ? 'resolved' : null)),
      // D4: 'none' is an explicit fact ("this no-change transition has no
      // override to speak of") — distinguishable in the UI from the '—'
      // placeholder used when the transition itself is unknown/unobserved.
      overrideStatus: entry.overrideStatus || (resolved?.source === 'occurrence' ? 'active' : (resolved?.source === 'implicit-zero' ? 'none' : null)),
      availableMinutes: Number.isFinite(entry.availableMinutes) ? entry.availableMinutes : null,
      shortMinutes: Number.isFinite(entry.availableMinutes) && Number.isFinite(entry.requiredMinutes) && entry.availableMinutes < entry.requiredMinutes
        ? entry.requiredMinutes - entry.availableMinutes : null,
      missingDetail: diagnostic && diagnostic.type !== 'setup-no-change' ? (diagnostic.message || setupDiagnosticLabel(diagnostic.type)) : null,
    };
  },

  _setupCapacityConflictText(detail: SetupPresentationDetail): string | null {
    if (detail.shortMinutes == null || detail.availableMinutes == null || detail.requiredMinutes == null) return null;
    const fallback = `Capacity shortfall: ${detail.availableMinutes} min available; ${detail.requiredMinutes} min required; ${detail.shortMinutes} min short.`;
    const translated = Util.t('ui.setup_capacity_shortfall', {
      available: detail.availableMinutes, required: detail.requiredMinutes, short: detail.shortMinutes,
    });
    return translated === 'ui.setup_capacity_shortfall' ? fallback : translated;
  },

  // Pure formatter for the read-only "Runtime basis" Inspector row (§8.2,
  // ROUTING_RUNTIME_DESIGN.md). `run_time_basis`'s exact shape isn't finalized
  // server-side yet, so every field read is defensive — a missing field omits
  // its clause rather than printing "undefined".
  _formatRuntimeBasis(task: NimbusTask): string {
    const source = task.run_time_source;
    if (source === 'sap_order') return Util.t('ui.insp_runtime_basis_sap_order');
    if (source === 'legacy') return Util.t('ui.insp_runtime_basis_legacy');
    if (source === 'manual') return Util.t('ui.insp_runtime_basis_manual');
    if (source === 'distributed') return Util.t('ui.insp_runtime_basis_distributed');
    if (source !== 'routing') return '';
    const basis = task.run_time_basis || {};
    const parts: string[] = ['Routing'];
    const pv = basis?.production_version;
    if (pv != null && pv !== '') parts.push(`PV ${pv}`);
    const group = basis?.routing_group;
    const counter = basis?.group_counter;
    if (group != null && group !== '') {
      parts.push(counter != null && counter !== '' ? `Group ${group}/${counter}` : `Group ${group}`);
    }
    const wc = basis?.sap_workcenter;
    if (wc != null && wc !== '') parts.push(`WC ${wc}`);
    const opCount = basis?.operation_count;
    if (typeof opCount === 'number' && Number.isFinite(opCount)) parts.push(`${opCount} ops`);
    const hours = basis?.hours;
    if (typeof hours === 'number' && Number.isFinite(hours)) parts.push(`${hours.toFixed(1)} h`);
    return parts.join(' · ');
  },

  _render(task: NimbusTask): void {
    const body = document.getElementById('inspector-body');
    if (!body) return;
    if (!task) { Inspector.clear(); return; }

    // Order fields originate from uploaded Excel — escape before innerHTML.
    const lineOptions = Table._getLineOptions();
    // Routing plants pick the production version and machine together ("PV - Machine"); a distribution sub-order
    // keeps its locked machine select.
    const pairSelect = Table._routingEnabledForTask(task) && !task.PARENT_ORDER;
    const pairOptions = pairSelect ? Table._getPairOptions(task) : [];
    const pairCurrent = `${Runtime.normPv(task.PRODUCTION_VERSION) ?? ''}|${task.MACHINE || 'Unknown'}`;
    const relAlerts = Store.alertsByTask().get(String(task.id)) || [];
    const scheduleSegments = Array.isArray(task.scheduleSegments) && task.scheduleSegments.length >= 2
      ? task.scheduleSegments : [];
    // Due Date shows the due instant (Util.dueInstant), never the raw midnight SAP date.
    const dueInstant = Util.dueDisplayDate(task);
    const systemMoveLine = Inspector._systemMoveLine(task);
    // Distribution card (aggregate_to_detail.md §8): only rendered for a
    // sub-order (PARENT_ORDER set). Share % is this child's quantity over
    // the sum of all living siblings' quantities (siblings = other tasks
    // currently in Store sharing the same PARENT_ORDER — deleted/completed
    // orders are never in Store, so this is "living" by construction).
    const distSiblings = task.PARENT_ORDER
      ? (Store.siblingsByParent().get(task.PARENT_ORDER) || [])
      : [];
    const distTotalQty = distSiblings.reduce((sum, s) => sum + (Number(s['ORDER_QUANTITY_(GMEIN)']) || 0), 0);
    const distThisQty = Number(task['ORDER_QUANTITY_(GMEIN)']) || 0;
    const distPct = distTotalQty > 0 ? Math.round(distThisQty / distTotalQty * 100) : 0;
    const distOtherSiblings = distSiblings.filter(s => String(s.id) !== String(task.id));

    Inspector._destroyEndPicker();
    body.innerHTML = `
      <div class="insp-flags" data-insp-lock>${Inspector._lockBlockHtml(task)}</div>
      ${relAlerts.length ? `<div class="insp-card" style="border-color:var(--err);background:var(--err-soft);">
        <h4 style="color:var(--err);">⚐ ${Util.t('ui.insp_alerts_title', { count: relAlerts.length })}</h4>
        ${relAlerts.map(a => `<div style="font-size:12px;margin-bottom:4px;">${Util.escapeHtml(Util.alertMessage(a))}</div>`).join('')}
      </div>` : ''}

      <div class="insp-card">
        <h4>${Util.t('ui.insp_order_section')}</h4>
        <div class="insp-row"><label>${Util.t('ui.insp_id')}</label>
          <div class="insp-val">${Util.escapeHtml(task.id)}</div></div>
          <div class="insp-row"><label>${Util.t('ui.insp_order')}</label>
          <div class="insp-val">${Util.escapeHtml(task.ORDER || task.id)}</div></div>
        ${Inspector._fieldVisible('MATERIAL_NUMBER') ? `
        <div class="insp-row"><label>${Util.t('ui.insp_material_no')}</label>
          <div class="insp-val">${Util.escapeHtml(task.MATERIAL_NUMBER || '—')}</div></div>` : ''}
        ${Inspector._fieldVisible('MATERIAL_DESCRIPTION') ? `
        <div class="insp-row"><label>${Util.t('ui.insp_material_desc')}</label>
          <div class="insp-val">${Util.escapeHtml(task.MATERIAL_DESCRIPTION || '—')}</div></div>` : ''}
        ${Inspector._fieldVisible('ORDER_QUANTITY_(GMEIN)') ? `
        <div class="insp-row"><label>${Util.t('ui.insp_qty')}</label>
          <div class="insp-val">${Util.escapeHtml(task['ORDER_QUANTITY_(GMEIN)'] || 0)}</div></div>` : ''}
        ${Inspector._fieldVisible('COLOR') ? `
        <div class="insp-row"><label>${Util.t('ui.insp_color')}</label>
          <div class="insp-val">${Util.escapeHtml(task.COLOR || '—')}</div></div>` : ''}
        ${Inspector._fieldVisible('FORM_SIZE') ? `
        <div class="insp-row"><label>${Util.t('ui.insp_form')}</label>
          <div class="insp-val">${Util.escapeHtml(task.FORM_SIZE || '—')}</div></div>` : ''}
        ${['PRT_01', 'PRT_02', 'PRODUCTION_VERSION'].map(key => {
          if (!Inspector._fieldVisible(key)) return '';
          const field = ORDER_FIELD_CATALOG.find(c => c.key === key);
          if (!field) return '';
          const value = (task as unknown as Record<string, unknown>)[key] ?? '';
          // D11: on a routing plant the production version is read-only; it changes only through PV - Machine.
          if (key === 'PRODUCTION_VERSION' && pairSelect) {
            return `<div class="insp-row"><label>${Util.t(field.i18nInspectorKey)}</label>
            <div class="insp-val">${Util.escapeHtml(String(value) || '—')}</div></div>`;
          }
          return `<div class="insp-row"><label>${Util.t(field.i18nInspectorKey)}</label>
            <div class="insp-val"><input type="text" data-field="${key}" value="${Util.escapeHtml(value)}"></div></div>`;
        }).join('')}
        ${toolingRowHtml(task)}
        ${pairSelect ? `<div class="insp-row"><label>${Util.t('ui.insp_pv_machine')}</label>
          <div class="insp-val"><select data-field="PV_MACHINE">
            ${pairOptions.map(o => `<option value="${Util.escapeHtml(o.value)}" ${o.value === pairCurrent ? 'selected' : ''}>${Util.escapeHtml(o.label)}</option>`).join('')}
          </select></div></div>` : `<div class="insp-row"><label>${Util.t('ui.insp_line')}</label>
          <div class="insp-val"><select data-field="MACHINE" ${task.PARENT_ORDER ? `disabled title="${Util.escapeHtml(Util.t('ui.insp_machine_locked_title'))}"` : ''}>
            ${lineOptions.map(l => `<option value="${Util.escapeHtml(l)}" ${l === task.MACHINE ? 'selected' : ''}>${Util.escapeHtml(l)}</option>`).join('')}
          </select></div></div>`}
      </div>

      ${task.PARENT_ORDER ? `<div class="insp-card">
        <h4>${Util.t('ui.insp_dist_title')}</h4>
        <div class="insp-row"><label>${Util.t('ui.insp_order')}</label>
          <div class="insp-val">${Util.escapeHtml(task.PARENT_ORDER)}${task.DISTRIBUTION_LETTER ? ' · ' + Util.escapeHtml(task.DISTRIBUTION_LETTER) : ''}</div></div>
        <div style="font-size:12px;margin:4px 0 8px;">${Util.t('ui.insp_dist_share', { pct: distPct })}</div>
        ${distOtherSiblings.length ? `
        <div style="font-size:11px;font-weight:500;color:var(--fg-mute);margin-bottom:4px;">${Util.t('ui.insp_dist_siblings')}</div>
        <div class="insp-split-segments">
          ${distOtherSiblings.map(s => `
          <div class="insp-split-segment">
            <span>${Util.escapeHtml(s.DISTRIBUTION_LETTER || '—')}</span>
            <span>${Util.escapeHtml(s.MACHINE || '—')} · ${Util.escapeHtml(String(s['ORDER_QUANTITY_(GMEIN)'] ?? 0))} · ${s.start_date ? Util.fmtDTReadable(s.start_date) : '—'}</span>
            <button class="btn btn-ghost sm" data-act="focus-sibling" data-id="${Util.escapeHtml(String(s.id))}">${Util.t('btn.focus')}</button>
          </div>`).join('')}
        </div>` : ''}
        <div class="insp-actions" style="margin-top:8px;">
          <button class="btn btn-ghost sm" data-act="open-distribution">${Util.t('btn.insp_dist_open')}</button>
        </div>
        <div class="insp-split-summary-note">${task.DISTRIBUTION_LETTER
          ? Util.t('ui.insp_dist_note_child', { parent: Util.escapeHtml(task.PARENT_ORDER) })
          : Util.t('ui.insp_dist_note_bare', { machine: Util.escapeHtml(task.MACHINE || '—') })}</div>
      </div>` : ''}

      <div class="insp-card">
        <h4>${Util.t('ui.insp_schedule_section')}</h4>
        ${Inspector._fieldVisible('original_start_date') ? `
        <div class="insp-row"><label>${Util.t('ui.insp_sap_start')}</label>
          <div class="insp-val" title="${Util.escapeHtml(Util.t('ui.sap_start_hint'))}">${task.original_start_date ? Util.escapeHtml(Table._fmtSapStart(task.original_start_date)) : '—'}</div></div>` : ''}
        ${Inspector._fieldVisible('original_end_date') ? `
        <div class="insp-row"><label>${Util.t('ui.insp_due_date')}</label>
          <div class="insp-val">${dueInstant ? Util.fmtDTReadable(dueInstant) : '—'}</div></div>` : ''}
        <div class="insp-row"><label>${Util.t('ui.insp_planned_start')}</label>
          <div class="insp-val" data-insp-start>${task.start_date ? Util.fmtDTReadable(task.start_date) : '—'}</div></div>
        <div class="insp-row"><label>${Util.t('ui.insp_planned_finish')}</label>
          <div class="insp-val"><input type="text" data-field="end_date" value="${Util.toLocalInput(task.end_date)}">
            <span data-insp-variance>${Inspector._varianceBadge(task)}</span></div></div>
        ${systemMoveLine ? `<div class="insp-split-summary-note">${Util.escapeHtml(systemMoveLine)}</div>` : ''}
        <div class="insp-row"><label>${Util.t('ui.insp_run_time')}</label>
          <div class="insp-val"><input type="number" step="0.25" data-field="RUN_TIME" value="${task.RUN_TIME || 0}" ${task.planning_reason?.code === 'runtime_unknown' ? '' : `disabled title="${Util.escapeHtml(Util.t('ui.insp_run_time_locked_title'))}"`}></div></div>
        ${task.run_time_source && Inspector._fieldVisible('run_time_basis') ? `
        <div class="insp-row"><label>${Util.t('ui.insp_runtime_basis')}</label>
          <div class="insp-val" data-insp-basis>${Util.escapeHtml(Inspector._formatRuntimeBasis(task))}</div></div>` : ''}
      </div>

      ${(() => {
        const moreKeys = ['PLANT', 'FIRMING_INDICATOR',
          'PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)', 'REDUCED_QUANTITY_(GMEIN)',
          'ORDER_CATEGORY', 'ORDER_TYPE', 'BOM_ALTERNATIVE', 'BOM_USAGE',
          'LABOR_HOURS_(MEINH)', 'MACHINE_HOURS_(MEINH)', 'NO_OF_FTE_(MEINH)'];
        const rows = moreKeys.map(key => {
          if (!Inspector._fieldVisible(key)) return '';
          const f = ORDER_FIELD_CATALOG.find(c => c.key === key);
          if (!f) return '';
          // SAP firm flag: the raw key never reaches the browser, only `ecc_firmed` (X or —).
          const val = key === 'FIRMING_INDICATOR'
            ? (Engine.isSapFirmed(task) ? 'X' : '—')
            : (task as unknown as Record<string, unknown>)[key];
          return `<div class="insp-row"><label>${Util.t(f.i18nInspectorKey)}</label>
            <div class="insp-val">${Util.escapeHtml(val ?? '—')}</div></div>`;
        }).join('');
        return rows ? `<div class="insp-card">
          <h4>${Util.t('ui.insp_more_section')}</h4>
          ${rows}
        </div>` : '';
      })()}

      ${scheduleSegments.length ? `<div class="insp-card insp-split-summary">
        <h4>Productive schedule</h4>
        <div class="insp-split-summary-note">${scheduleSegments.length} calendar-valid pieces; parent timing remains authoritative.</div>
        <div class="insp-split-segments">
          ${scheduleSegments.map((segment, index) => {
            const hours = (segment.endDate.getTime() - segment.startDate.getTime()) / Config.MS_HOUR;
            return `<div class="insp-split-segment">
              <span>Part ${index + 1}</span>
              <span>${Util.fmtDTReadable(segment.startDate)} → ${Util.fmtDTReadable(segment.endDate)}</span>
              <span>${hours.toFixed(2)}h</span>
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}

      ${Inspector._setupCardHtml(task)}

      <div class="insp-card">
        <h4>${Util.t('ui.insp_notes_section')}</h4>
        <div class="insp-notes-wrap">
          <textarea data-field="notes" maxlength="500" placeholder="${Util.t('ph.add_note')}" rows="3">${Util.escapeHtml(task.notes || '')}</textarea>
          <div class="insp-notes-counter"><span id="insp-notes-rem">${500 - (task.notes || '').length}</span> ${Util.t('ui.remaining')}</div>
        </div>
      </div>

      <div class="insp-card insp-history" data-history-for="${Util.escapeHtml(String(task.id))}">
        <h4 data-i18n="ui.insp_history_title">${Util.t('ui.insp_history_title')}</h4>
        <div class="insp-history-body"></div>
      </div>

      <div class="insp-actions">
        <span class="insp-firm-slot" data-insp-firm>${Inspector._firmButtonHtml(task)}</span>
        <button class="btn" data-act="override">${Util.t('btn.override_date')}</button>
        <button class="btn btn-ghost" data-act="focus">${Util.t('btn.focus')}</button>
      </div>
    `;

    // Wire inputs
    body.querySelectorAll('[data-field]').forEach((el) => {
      const fieldEl = el as InspectorFieldEl;
      fieldEl.onchange = () => Inspector._onFieldChange(fieldEl.dataset.field!, fieldEl.value);
    });
    // Action buttons via listeners (id is never concatenated into an HTML attribute).
    const _id = String(task.id);
    Inspector._wireFirmButton(body, _id);
    body.querySelector('[data-act="override"]')?.addEventListener('click', () => NIMBUS!.Table!._openOverrideModalForId!(_id));
    body.querySelector('[data-act="focus"]')?.addEventListener('click', () => NIMBUS!.Timeline!.focus!(_id));
    // Distribution card: per-sibling jump links + "Open in Order Distribution".
    body.querySelectorAll<HTMLButtonElement>('[data-act="focus-sibling"]').forEach((el) => {
      const sid = el.dataset.id;
      if (sid) el.addEventListener('click', () => NIMBUS!.Timeline!.focus!(sid));
    });
    body.querySelectorAll<HTMLButtonElement>('[data-act="open-tool-inventory"]').forEach((el) => {
      el.addEventListener('click', () => raiseToolInventory(el.dataset.plant, el.dataset.tool ?? ''));
    });
    body.querySelector('[data-act="open-distribution"]')?.addEventListener('click', () => {
      const app = (globalThis as unknown as { NIMBUS?: { App?: { gotoGanttSub?: (sub: string) => void } } }).NIMBUS?.App;
      app?.gotoGanttSub?.('distribution');
    });
    Inspector._wireSetupCard(body, task);
    // Notes char counter (oninput fires on every keystroke)
    const notesEl = body.querySelector('[data-field="notes"]') as HTMLTextAreaElement | null;
    const notesRemEl = body.querySelector('#insp-notes-rem');
    if (notesEl && notesRemEl) {
      notesEl.oninput = () => { notesRemEl.textContent = String(500 - notesEl.value.length); };
      const _noteId = Inspector._currentId!;
      notesEl.onblur = () => {
        const trimmed = notesEl.value.trim() || null;
        Inspector._updateNote(_noteId, trimmed);
      };
    }
    // Upgrade end_date (the finish a planner types; the start is derived) to Flatpickr datetime picker
    const _dtEl = body.querySelector('[data-field="end_date"]') as HTMLInputElement | null;
    if (_dtEl) {
      Inspector._fpEnd = Util.fpDatetime(_dtEl, {
        onChange() { Inspector._onFieldChange('end_date', _dtEl.value); }
      });
    }
    Inspector._fillHistory(_id);
  },

  _setupPlantFor(task: NimbusTask): string {
    return Store.getPlantForLine(task.MACHINE) || task.PLANT || Store.selectedPlant || '';
  },

  /** The Setup detail card for an order (the full card markup; `_render` and `refreshDerived` both place it). */
  _setupCardHtml(task: NimbusTask): string {
    const setupDetail = Inspector._setupDetailForTask(task);
    const setupCapacityConflict = setupDetail ? Inspector._setupCapacityConflictText(setupDetail) : null;
    const missingSetupPlaceholder = '—';
    const firstOnMachine = Util.t('ui.setup_first_on_machine');
    const setupPredecessorText = setupDetail.predecessorOrderId === undefined
      ? missingSetupPlaceholder
      : setupDetail.predecessorOrderId
        ? Util.orderNumber(Store.tasks[setupDetail.predecessorOrderId], setupDetail.predecessorOrderId)
        : (firstOnMachine === 'ui.setup_first_on_machine' ? 'First on machine' : firstOnMachine);
    const setupPlant = Inspector._setupPlantFor(task);
    const canWriteSetup = !!setupPlant && Inspector._canWriteSetup(setupPlant);
    return `
      <div class="insp-card insp-setup-detail" aria-label="${Util.escapeHtml(Util.t('ui.setup_detail_title'))}">
        <h4>${Util.escapeHtml(Util.t('ui.setup_detail_title'))}</h4>
        <div class="insp-row"><label>${Util.escapeHtml(Util.t('ui.setup_predecessor'))}</label><div class="insp-val">${Util.escapeHtml(setupPredecessorText)}</div></div>
        <div class="insp-row"><label>${Util.escapeHtml(Util.t('ui.setup_predecessor_state'))}</label><div class="insp-val">${Util.escapeHtml(setupDetail.predecessorState || missingSetupPlaceholder)}</div></div>
        <div class="insp-row"><label>${Util.escapeHtml(Util.t('ui.setup_required'))}</label><div class="insp-val">${setupDetail.requiredMinutes == null ? missingSetupPlaceholder : `${setupDetail.requiredMinutes} min`}</div></div>
        <div class="insp-row"><label>${Util.escapeHtml(Util.t('ui.setup_effective'))}</label><div class="insp-val">${setupDetail.effectiveMinutes == null ? missingSetupPlaceholder : `${setupDetail.effectiveMinutes} min`}</div></div>
        <div class="insp-row"><label>${Util.escapeHtml(Util.t('ui.setup_standard'))}</label><div class="insp-val">${setupDetail.standardMinutes == null ? missingSetupPlaceholder : `${setupDetail.standardMinutes} min`}</div></div>
        <div class="insp-row"><label>${Util.escapeHtml(Util.t('ui.setup_source'))}</label><div class="insp-val">${Util.escapeHtml(setupSourceLabel(setupDetail.source) || missingSetupPlaceholder)}</div></div>
        <div class="insp-row"><label>${Util.escapeHtml(Util.t('ui.setup_override'))}</label><div class="insp-val">${Util.escapeHtml(setupDetail.overrideStatus === 'none' ? Util.t('ui.setup_override_none') : (setupDetail.overrideStatus || missingSetupPlaceholder))}</div></div>
        ${setupCapacityConflict ? `<p class="insp-setup-warning">${Util.escapeHtml(setupCapacityConflict)}</p>` : ''}
        ${setupDetail.missingDetail ? `<p class="insp-setup-warning">${Util.escapeHtml(Util.t('ui.setup_missing'))}: ${Util.escapeHtml(setupDetail.missingDetail)}</p>` : ''}
        ${canWriteSetup ? `<div class="insp-setup-actions"><button class="btn btn-ghost sm" data-setup-correct-state>Correct actual setup state</button><button class="btn btn-ghost sm" data-setup-adjust-time>Adjust setup time</button><div data-setup-editor-host></div></div>` : ''}
      </div>`;
  },

  /** Wires the card's Correct state / Adjust time buttons (after `_render` or after the card is replaced). */
  _wireSetupCard(body: HTMLElement, task: NimbusTask): void {
    const setupPlant = Inspector._setupPlantFor(task);
    body.querySelector<HTMLButtonElement>('[data-setup-correct-state]')?.addEventListener('click', () => {
      const snapshot = Store.setupSnapshot;
      const host = body.querySelector<HTMLElement>('[data-setup-editor-host]');
      if (snapshot && host && setupPlant) SetupAdmin.mountStateEditor(host, snapshot, task.MACHINE, () => Inspector._refreshSetupTruth(setupPlant));
    });
    body.querySelector<HTMLButtonElement>('[data-setup-adjust-time]')?.addEventListener('click', () => Inspector._showSetupOverrideEditor(task, setupPlant));
  },

  async _refreshSetupTruth(plant: string): Promise<void> {
    await Persistence.loadSetupSnapshot(plant);
    Timeline.rebuild();
    Alerts.scheduleRecompute();
    const current = Inspector._currentId ? Store.tasks[Inspector._currentId] : null;
    if (current) Inspector._render(current);
  },

  _showSetupOverrideEditor(task: NimbusTask, plant: string): void {
    const context = Inspector._setupOverrideFor(task);
    const definition = Store.setupSnapshot?.definition;
    const host = document.getElementById('inspector-body')?.querySelector<HTMLElement>('[data-setup-editor-host]');
    if (!context || !definition) {
      Toast.show(Util.t('toast.setup_record_line_state_first'), 'warn');
      const snapshot = Store.setupSnapshot;
      if (host && snapshot && plant && Inspector._canWriteSetup(plant)) {
        SetupAdmin.mountStateEditor(host, snapshot, task.MACHINE, () => Inspector._refreshSetupTruth(plant));
      }
      return;
    }
    if (!host || host.querySelector('[data-setup-override-editor]')) return;
    const existing = context.existing;
    const baseline = existing?.standard_min ?? context.baseline;
    const initialAdjustment = existing && baseline != null ? existing.remaining_min - baseline : 0;
    host.innerHTML = `<div class="setup-state-editor" data-setup-override-editor><label>Reason<input class="input" data-setup-override-reason></label>${baseline != null ? `<label>Adjustment (minutes)<input class="input" type="number" step="1" data-setup-override-adjustment value="${initialAdjustment}"></label><p class="setup-editor-note">Matrix baseline: ${baseline} min. Remaining work is baseline plus adjustment.</p>` : `<label>Total setup duration (minutes)<input class="input" type="number" min="0" step="1" data-setup-override-total></label><p class="setup-editor-note">No matrix baseline exists; this total applies only to this exact order pair.</p>`}<div class="insp-actions"><button class="btn btn-primary sm" data-setup-save-override>Save setup time</button>${existing ? '<button class="btn btn-ghost sm" data-setup-reset-override>Reset to matrix</button>' : ''}</div></div>`;
    const reason = host.querySelector<HTMLInputElement>('[data-setup-override-reason]')!;
    reason.value = existing?.reason || '';
    // Both buttons stay disabled while a request is in flight (no double save / save-then-reset race).
    const setBusy = (busy: boolean): void => {
      host.querySelectorAll<HTMLButtonElement>('[data-setup-save-override], [data-setup-reset-override]')
        .forEach(b => { b.disabled = busy; });
    };
    host.querySelector<HTMLButtonElement>('[data-setup-save-override]')!.addEventListener('click', async () => {
      const values = Inspector._setupOverrideValues(baseline, host.querySelector<HTMLInputElement>('[data-setup-override-adjustment]')?.value || '', host.querySelector<HTMLInputElement>('[data-setup-override-total]')?.value || '');
      if (!reason.value.trim()) { Toast.show('A shop-floor reason is required.', 'error'); reason.focus(); return; }
      if (!values) { Toast.show(baseline != null ? 'The remaining setup time cannot be below zero.' : 'Enter a whole-number total setup duration.', 'error'); return; }
      const payload = { machine: task.MACHINE, standard_min: values.standardMin, remaining_min: values.remainingMin, signature_version: definition.signature_version, reason: reason.value.trim() };
      const url = existing ? `${Config.API_BASE}/setup/${encodeURIComponent(plant)}/overrides/${encodeURIComponent(String(existing.id))}` : `${Config.API_BASE}/setup/${encodeURIComponent(plant)}/overrides`;
      const body = existing ? payload : { ...payload, predecessor_order_id: context.predecessorOrderId, successor_order_id: String(task.id), predecessor_values: Object.fromEntries(context.predecessorState.map(part => [part.fieldKey, part.value])), successor_values: Object.fromEntries(context.successorState.map(part => [part.fieldKey, part.value])) };
      setBusy(true);
      try {
        const response = await Util.fetchTraced(url, { method: existing ? 'PUT' : 'POST', headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() }, body: JSON.stringify(body) });
        if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(formatApiDetail(error.detail, `HTTP ${response.status}`)); }
        Persistence.noteSetupWrite(plant, 'override'); await Inspector._refreshSetupTruth(plant); Toast.show('Setup time saved.', 'success');
      } catch (error) { Toast.show(`Could not save setup time: ${(error as Error).message}`, 'error'); }
      finally { setBusy(false); }
    });
    host.querySelector<HTMLButtonElement>('[data-setup-reset-override]')?.addEventListener('click', async () => {
      if (!existing) return;
      if (!reason.value.trim()) { Toast.show('A shop-floor reason is required.', 'error'); reason.focus(); return; }
      setBusy(true);
      try {
        const response = await Util.fetchTraced(`${Config.API_BASE}/setup/${encodeURIComponent(plant)}/overrides/${encodeURIComponent(String(existing.id))}`, { method: 'DELETE', headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() }, body: JSON.stringify({ machine: task.MACHINE, signature_version: definition.signature_version, reason: reason.value.trim() }) });
        if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(formatApiDetail(error.detail, `HTTP ${response.status}`)); }
        Persistence.noteSetupWrite(plant, 'override'); await Inspector._refreshSetupTruth(plant); Toast.show('Setup override reset to matrix.', 'success');
      } catch (error) { Toast.show(`Could not reset setup time: ${(error as Error).message}`, 'error'); }
      finally { setBusy(false); }
    });
  },

  /** Planned finish minus the due instant, in hours with one decimal (positive = late). Empty when either is unknown. */
  _varianceBadge(t: NimbusTask): string {
    const due = Util.dueInstant(t);
    if (!due || !t.end_date) return '';
    const fin = t.end_date instanceof Date ? t.end_date : Util.parseDate(t.end_date);
    if (!fin) return '';
    const hours = (fin.getTime() - due.getTime()) / Config.MS_HOUR;
    const rounded = Math.round(hours * 10) / 10;
    const txt = `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}h`.replace('-0.0h', '0.0h');
    const cls = rounded > 0 ? 'insp-var-late' : 'insp-var-early';
    return `<span class="insp-var ${cls}" title="${Util.escapeHtml(Util.t('ui.insp_variance_shifted'))}">${txt}</span>`;
  },

  /** The "explain the move" line: from the engine's session-only notes, derivationIssue first, then systemMove.
   *  Empty when neither describes a move (a note such as a missing time zone is not a move). */
  _systemMoveLine(t: NimbusTask): string {
    const MOVE_REASONS = ['finish_moved_earlier', 'reversal_forward', 'pull_floor_crossed',
      'run_time_changed', 'due_date_derivation', 'cutover'];
    const reasonKey = (code: string | undefined): string | null =>
      code && MOVE_REASONS.includes(code) ? `ui.insp_move_reason_${code}` : null;
    const issue = t.derivationIssue ?? null;
    const move = t.systemMove ?? null;
    const key = reasonKey(issue?.code) ?? reasonKey(move?.reason);
    const from = issue?.from ?? move?.from;
    const to = issue?.to ?? move?.to;
    if (!key || !from || !to) return '';
    return Util.t('ui.insp_system_move', { from: Util.fmtDTReadable(from), to: Util.fmtDTReadable(to), reason: Util.t(key) });
  },

  _onFieldChange(field: string, value: string, opts: ManualPlacementOptions = {}): void {
    if (!Inspector._currentId) return;
    const id = Inspector._currentId;
    const t  = Store.tasks[id];
    if (!t) return;
    const changes: Partial<NimbusTask> = {};
    let requestedFinish: Date | null = null;
    let requestedLine: string | null = null;
    let scheduleTask = t;
    let pairPv: string | null = null;   // set when a (PV, machine) pair is being written
    if (field === 'end_date') {
      // The typed End is the finish the planner wants; the start is derived from it (OQ1).
      const d = Util.parseDate(value);
      if (!d) { Toast.show(Util.t('toast.invalid_date'), 'error'); return; }
      requestedFinish = d;
    } else if (field === 'start_date') {
      // The start is derived from the finish and is no longer an input; nothing to apply.
      Inspector._render(t);
      return;
    } else if (field === 'RUN_TIME') {
      const h = parseFloat(value) || 0;
      changes.RUN_TIME = h;
      // Release the runtime hold only after constructing a valid placement.
      changes.run_time_source = 'manual';
      scheduleTask = { ...t, RUN_TIME: h };
      requestedFinish = Table._runtimeEditAnchor(t);
    } else if (field === 'PV_MACHINE') {
      // The routing plant's one writer of the production version: the pair is written together.
      const parsed = Table._parsePairValue(value);
      const newMachine = parsed.machine || 'Unknown';
      const currentPv = Runtime.normPv(t.PRODUCTION_VERSION) ?? '';
      const newPv = parsed.pv ?? currentPv;
      if (newMachine === (t.MACHINE || 'Unknown') && newPv === currentPv) { Inspector._render(t); return; }
      if (!Runtime.eligible({ ...t, PRODUCTION_VERSION: newPv }, newMachine)) {
        Table._toastPairIneligible(t, newPv, newMachine);
        Inspector._render(t);
        return;
      }
      changes.MACHINE = newMachine;
      changes.PRODUCTION_VERSION = newPv;
      pairPv = newPv;
      requestedLine = newMachine;
      requestedFinish = Table._runtimeEditAnchor(t);
      if (!requestedFinish) Object.assign(changes, Table._unplacedMachineRuntime(t, newMachine, newPv));
    } else if (field === 'ORDER_QUANTITY_(GMEIN)') {
      changes[field] = parseFloat(value) || 0;
    } else if (field === 'notes') {
      changes.notes = value.trim() || null;
      Inspector._updateNote(id, changes.notes ?? null);
      return;
    } else if (field === 'PRT_01' || field === 'PRT_02') {
      const typed = value.trim();
      changes[field] = (typed || null) as unknown as string;
      warnUnknownToolId(t, typed);
    } else {
      if (field === 'MACHINE') {
        const newMachine = value || 'Unknown';
        // Routing eligibility guard (§8.2): a move to a machine with no
        // routing operation for this order is rejected outright, but only
        // on a plant that has opted into the feature (see
        // _routingEnabledForTask).
        if (newMachine !== (t.MACHINE || 'Unknown') && Table._routingEnabledForTask(t) && !Runtime.eligible(t, newMachine)) {
          Table._toastMachineIneligible(t, newMachine);
          Inspector._render(t);
          return;
        }
        requestedLine = newMachine;
        requestedFinish = Table._runtimeEditAnchor(t);
        if (!requestedFinish) Object.assign(changes, Table._unplacedMachineRuntime(t, newMachine));
      }
      changes[field] = value;
    }
    if (requestedFinish) {
      const targetLine = requestedLine || t.MACHINE || 'Unknown';
      // Same rule as the grid: run-time, machine and version edits hold the finish (a RUNNING order holds its
      // start instead, OQ3); a typed End is a placement.
      const placeOpts = { ...opts, holdStartIfRunning: field !== 'end_date' };
      const schedule = pairPv !== null
        ? Engine.pairSchedulePatchFor(scheduleTask, pairPv, targetLine, requestedFinish, placeOpts)
        : Engine.manualRoutingSchedulePatchFor(scheduleTask, targetLine, requestedFinish, placeOpts);
      if (!schedule?.start_date || !schedule.end_date) {
        Inspector._render(t);
        Table._explainManualRefusal(t, () => Inspector._onFieldChange(field, value, { confirmedOvertime: true }));
        return;
      }
      Object.assign(changes, schedule);
      if (changes.RUN_TIME != null && t.planning_status === 'needs_planning' &&
          t.planning_reason?.code === 'runtime_unknown') {
        changes.planning_status = 'scheduled';
        changes.planning_reason = null;
      }
    }
    const undoSnap = pairPv !== null ? UndoStack.snapshotTasks([id]) : null;
    Store.updateTask(id, changes, 'inspector');
    if (undoSnap) Table._pushPairUndo(id, undoSnap);
    Alerts.scheduleRecompute();
    Inspector.refreshDerived(id);
  },

  // Per-id debounce timers. A single shared debounce timer (the old design) meant a
  // note on order B within 800ms cancelled order A's pending POST — silent data loss
  // (R5). Keying the timer by task id isolates each order's save.
  _noteTimers: {} as Record<string, ReturnType<typeof setTimeout>>,
  _updateNote(id: string, notes: string | null): void {
    const task = Store.tasks[id];
    if (!task || (task.notes || null) === (notes || null)) return;
    Store.updateTask(id, { notes }, 'note');
    Inspector._persistNote(id, notes);
  },
  _persistNote(id: string, notes: string | null): void {
    clearTimeout(Inspector._noteTimers[id]);
    Inspector._noteTimers[id] = setTimeout(() => {
      delete Inspector._noteTimers[id];
      const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      Util.fetchTraced(`${Config.API_BASE}/task/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-request-id': reqId },
        body: JSON.stringify({ id, notes })
      })
        .then(async r => {
          if (!r.ok) {
            const parsed = await Util.parseBackendError(r);
            ErrorLog.warn('inspector', `Note rejected (${r.status}): ${parsed.message}`,
              { reqId, status: r.status, id }, { reqId, errorCode: parsed.errorCode });
          } else {
            const result = await r.json() as { versions?: Record<string, number> };
            const version = result.versions?.[id];
            if (version && (Store.tasks[id]?.notes || null) === (notes || null)) {
              Store.tasks[id].row_version = version;
            }
            Inspector.invalidateHistory([id]);
          }
        })
        .catch(e => ErrorLog.warn('inspector', `Note persist failed: ${e.message}`,
          { reqId, id }, { reqId, errorCode: 'http.network' }));
    }, 800);
  },

  /** The lock block (C-3): the Firmed card (only while NIMBUS locks the order: manual, frozen or
   *  running) and, outside it, the neutral SAP tag (SAP's flag locks nothing). '' when neither applies. */
  _lockBlockHtml(task: NimbusTask): string {
    const firmed = Engine.firmingStatus(task).firmed;
    const sap = Engine.isSapFirmed(task);
    if (!firmed && !sap) return '';
    const card = firmed
      ? `<div class="insp-status">
          <div class="insp-status-head"><span aria-hidden="true">🔒</span> <strong>${Util.t('ui.firmed')}</strong></div>
          <div class="insp-status-reasons">${Util.escapeHtml(Engine.firmReasonsText(task))}</div>
        </div>`
      : '';
    const tag = sap
      ? `<span class="sap-pill neutral insp-sap-tag" title="${Util.escapeHtml(Util.t('ui.sap_firm_marker'))}">${Util.t('ui.sap_firmed')}</span>`
      : '';
    return card + tag;
  },

  /** The Firm / Unfirm button for the order's current lock state ('' when frozen or running: no action). */
  _firmButtonHtml(task: NimbusTask): string {
    const action = Engine.firmActionFor(task);
    if (action === 'unfirm') return `<button class="btn" data-act="unfirm">${Util.t('btn.unfirm')}</button>`;
    if (action === 'firm') return `<button class="btn btn-primary" data-act="firm">${Util.t('btn.firm_order')}</button>`;
    return '';
  },

  _wireFirmButton(root: ParentNode, id: string): void {
    root.querySelector('[data-act="firm"]')?.addEventListener('click', () => Inspector.toggleFirm(true));
    root.querySelector('[data-act="unfirm"]')?.addEventListener('click', () => Inspector.toggleFirm(false));
    void id;
  },

  /** Patches only the DERIVED rows of the open order after an Inspector write (Planned start, variance badge,
   *  Run time, runtime basis, Setup card). A full `_render` would replace the field being edited (focus), the
   *  Notes textarea, Flatpickr and the History card, which is why the subscriber ignores source 'inspector'. */
  refreshDerived(id: string | null | undefined): void {
    if (!id || id !== Inspector._currentId) return;
    const task = Store.tasks[id];
    const body = document.getElementById('inspector-body');
    if (!task || !body) return;
    const start = body.querySelector('[data-insp-start]');
    if (start) start.textContent = task.start_date ? Util.fmtDTReadable(task.start_date) : '—';
    const variance = body.querySelector('[data-insp-variance]');
    if (variance) variance.innerHTML = Inspector._varianceBadge(task);
    const run = body.querySelector<HTMLInputElement>('[data-field="RUN_TIME"]');
    if (run && document.activeElement !== run) run.value = String(task.RUN_TIME || 0);
    const basis = body.querySelector('[data-insp-basis]');
    if (basis) basis.textContent = Inspector._formatRuntimeBasis(task);
    const card = body.querySelector<HTMLElement>('.insp-setup-detail');
    // Leave an open setup editor alone: replacing the card would discard what the planner is typing.
    if (card && !card.querySelector('[data-setup-override-editor]')
        && !card.querySelector('[data-setup-editor-host]')?.hasChildNodes()) {
      const holder = document.createElement('div');
      holder.innerHTML = Inspector._setupCardHtml(task);
      const fresh = holder.firstElementChild as HTMLElement | null;
      if (fresh) { card.replaceWith(fresh); Inspector._wireSetupCard(body, task); }
    }
  },

  /** Partial patch of the lock block and the firm button for the open order (C-3). Called by the Gantt's
   *  30 s lock-band scan on EVERY scan, because the reasons change as the window rolls (frozen <-> running)
   *  without any Store event. Deliberately not a full `_render`: that would replace the Notes textarea,
   *  the Flatpickr and the History card. */
  refreshLock(id: string | null | undefined): void {
    if (!id || id !== Inspector._currentId) return;
    const task = Store.tasks[id];
    const body = document.getElementById('inspector-body');
    if (!task || !body) return;
    const lock = body.querySelector('[data-insp-lock]');
    if (lock) {
      const html = Inspector._lockBlockHtml(task);
      if (lock.innerHTML !== html) lock.innerHTML = html;
    }
    const slot = body.querySelector('[data-insp-firm]');
    if (slot) {
      const html = Inspector._firmButtonHtml(task);
      if (slot.innerHTML !== html) { slot.innerHTML = html; Inspector._wireFirmButton(slot, id); }
    }
  },

  toggleFirm(firmed: boolean): void {
    const id = Inspector._currentId;
    if (!id) return;
    // Click-time re-check: the frozen window rolls, so the offered action may have changed.
    const task = Store.tasks[id];
    if (task && Engine.firmActionFor(task) !== (firmed ? 'firm' : 'unfirm')) {
      Toast.show(firmMismatchMessage(task));
      Inspector.refreshLock(id);
      return;
    }
    Engine.applyFirm([id], firmed, 'inspector');
    if (!firmed) notifyResidualFirming([id]);
    Alerts.scheduleRecompute();
  }
};

/* =============================================================================
   CONTEXT MENU — right-click on a timeline item.
   ========================================================================== */
export const ContextMenu = {
  _targetId: null as string | null,
  _returnFocus: null as HTMLElement | null,

  init(): void {
    const menu = document.getElementById('ctx-menu');
    if (!menu) return;
    menu.setAttribute('role', 'menu');
    menu.querySelectorAll('button').forEach(btn => {
      btn.setAttribute('role', 'menuitem');
      btn.tabIndex = -1;
      btn.onclick = () => {
        const action = btn.dataset.action;
        const id = ContextMenu._targetId;
        ContextMenu.close(true);
        if (!id) return;
        if (action === 'firm' || action === 'unfirm') {
          const want = action === 'firm';
          // Click-time re-check: the window rolls while the menu is open.
          const t = Store.tasks[id];
          if (t && Engine.firmActionFor(t) !== action) { Toast.show(firmMismatchMessage(t)); return; }
          Engine.applyFirm([id], want, 'ctx');
          Alerts.scheduleRecompute();
          if (!want) notifyResidualFirming([id]);
        }
        else if (action === 'override') { Table._openOverrideModalForId(id); }
        else if (action === 'inspect')  { const t = Store.tasks[id]; if (t) Inspector.show(t); }
      };
    });
    document.addEventListener('click', () => ContextMenu.close());
    document.addEventListener('scroll', e => { if (!menu.contains(e.target as Node)) ContextMenu.close(); }, true);
    menu.addEventListener('keydown', e => ContextMenu._onKeyDown(e));
  },

  _buttons(): HTMLButtonElement[] {
    return Array.from(document.getElementById('ctx-menu')?.querySelectorAll<HTMLButtonElement>('button') || [])
      .filter(button => !button.disabled && !button.hidden && button.style.display !== 'none');
  },

  _onKeyDown(e: KeyboardEvent): void {
    const buttons = ContextMenu._buttons();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); ContextMenu.close(true); return;
    }
    if (e.key === 'Tab') { ContextMenu.close(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !buttons.length) return;
    e.preventDefault(); e.stopPropagation();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
      : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  },

  openFromKeyboard(targetId: string, target: HTMLElement | null): void {
    const anchor = target?.closest<HTMLElement>('.ag-cell') || target;
    const rect = anchor?.getBoundingClientRect();
    ContextMenu.open(rect?.left ?? 6, rect?.bottom ?? 6, targetId);
  },

  open(x: number, y: number, targetId: string): void {
    const menu = document.getElementById('ctx-menu') as HTMLElement | null;
    if (!menu) return;
    ContextMenu._targetId = targetId;
    ContextMenu._returnFocus = document.activeElement as HTMLElement | null;
    // Three states (D4): not firmed -> Firm; manual only -> Unfirm; frozen/running -> neither, a note with the reason.
    const task = Store.tasks[targetId];
    const action = task ? Engine.firmActionFor(task) : 'firm';
    const firmBtn = menu.querySelector('[data-action="firm"]') as HTMLElement | null;
    const unfirmBtn = menu.querySelector('[data-action="unfirm"]') as HTMLElement | null;
    const note = menu.querySelector('.ctx-note') as HTMLElement | null;
    const sep = menu.querySelector('#ctx-sep-firm') as HTMLElement | null;
    if (firmBtn) firmBtn.style.display = action === 'firm' ? '' : 'none';
    if (unfirmBtn) unfirmBtn.style.display = action === 'unfirm' ? '' : 'none';
    if (note) {
      const lockedText = action === null && task ? Engine.firmStatusText(task) : '';
      note.textContent = lockedText;
      note.hidden = !lockedText;
    }
    if (sep) sep.style.display = action === null ? 'none' : '';
    menu.hidden = false;
    menu.style.maxHeight = Math.max(0, window.innerHeight - 12) + 'px';
    menu.style.maxWidth = Math.max(0, window.innerWidth - 12) + 'px';
    menu.style.left = Math.max(6, x) + 'px';
    menu.style.top = Math.max(6, y) + 'px';
    requestAnimationFrame(() => {
      if (menu.hidden) return;
      const rect = menu.getBoundingClientRect();
      menu.style.left = Math.max(6, Math.min(x, window.innerWidth - rect.width - 6)) + 'px';
      menu.style.top = Math.max(6, Math.min(y, window.innerHeight - rect.height - 6)) + 'px';
      ContextMenu._buttons()[0]?.focus();
    });
  },
  close(restoreFocus = false): void {
    ContextMenu._targetId = null;
    const menu = document.getElementById('ctx-menu');
    if (menu) menu.hidden = true;
    if (restoreFocus && ContextMenu._returnFocus?.isConnected) ContextMenu._returnFocus.focus();
    ContextMenu._returnFocus = null;
  }
};

/* =============================================================================
   PRINTER — Order list export modal with date range selector.
   Opens a modal with From/To date pickers, renders a filterable table of
   orders sorted by production line then start date, and supports CSV export
   and browser print.
   ========================================================================== */
export const Printer = {
  _rows: [] as NimbusTask[], // last previewed rows, used by exportCsv()
  _fpStart: null as NimbusVendor.FlatpickrInstance | null,
  _fpEnd: null as NimbusVendor.FlatpickrInstance | null,

  open() {
    const scope = document.getElementById('print-scope') as HTMLSelectElement | null;
    if (scope) { scope.value = 'all'; scope.onchange = () => Printer.preview(); }
    const scheduled = Printer._scopeRows('all').filter(t => t.start_date && t.end_date);
    const today = new Date();
    let defStart = today;
    let defEnd   = new Date(today); defEnd.setDate(today.getDate() + 7);
    if (scheduled.length) {
      defStart = new Date(Math.min(...scheduled.map(t => t.start_date!.getTime())));
      defEnd   = new Date(Math.max(...scheduled.map(t => t.end_date!.getTime())));
    }
    if (!Printer._fpStart) {
      Printer._fpStart = flatpickr('#print-start', {
        dateFormat: 'Y-m-d', altInput: true, altFormat: Util._dateFormatPref(),
        altInputClass: 'input', onChange() { Printer.preview(); }
      });
      Printer._fpEnd = flatpickr('#print-end', {
        dateFormat: 'Y-m-d', altInput: true, altFormat: Util._dateFormatPref(),
        altInputClass: 'input', onChange() { Printer.preview(); }
      });
    }
    Printer._fpStart?.setDate(defStart, false);
    Printer._fpEnd?.setDate(defEnd, false);
    Modal.open('modal-print');
    Printer.preview();
  },

  /** Use the grid's displayed row model so quick, chip and native column filters agree. */
  _scopeRows(scope: string): NimbusTask[] {
    if (scope === 'filtered') {
      if (!Table._api) return [];
      const rows: NimbusTask[] = [];
      for (let index = 0; index < Table._api.getDisplayedRowCount(); index++) {
        const node = Table._api.getDisplayedRowAtIndex(index) as AgGridRowNode | undefined;
        if (node?.data) rows.push(node.data);
      }
      return rows;
    }
    if (scope === 'plant') return Store.selectedPlant
      ? Store.tasksArr.filter(task => (task.PLANT || Store.getPlantForLine(task.MACHINE)) === Store.selectedPlant) : [];
    return Store.tasksArr;
  },

  /** OQ43 a: an order is in the print range when its bar overlaps it (a split order is tested piece by piece). */
  _rowsInRange(tasks: NimbusTask[], rangeStart: Date, rangeEnd: Date): NimbusTask[] {
    return tasks.filter(t => {
      const pieces = Util.scheduleIntervals(t);
      if (pieces.length) return pieces.some(i => i.start <= rangeEnd && i.end >= rangeStart);
      return !!t.start_date && t.start_date <= rangeEnd && !!t.end_date && t.end_date >= rangeStart;
    });
  },

  preview() {
    const startVal = (document.getElementById('print-start') as HTMLInputElement | null)?.value;
    const endVal   = (document.getElementById('print-end') as HTMLInputElement | null)?.value;
    const host     = document.getElementById('print-results');
    if (!host) return;

    if (!startVal || !endVal) {
      Printer._rows = [];
      host.innerHTML = `<p style="color:var(--text-muted);font-size:13px;">${Util.t('empty.pick_date_range')}</p>`;
      return;
    }

    const rangeStart = new Date(startVal + 'T00:00:00');
    const rangeEnd   = new Date(endVal   + 'T23:59:59');

    const scope = (document.getElementById('print-scope') as HTMLSelectElement | null)?.value || 'all';
    const rows = Printer._rowsInRange(Printer._scopeRows(scope), rangeStart, rangeEnd)
      .sort((a, b) => {
        const la = (a.MACHINE || 'Unknown'), lb = (b.MACHINE || 'Unknown');
        if (la !== lb) return la.localeCompare(lb);
        return (a.start_date?.getTime() || 0) - (b.start_date?.getTime() || 0);
      });

    Printer._rows = rows;

    if (!rows.length) {
      host.innerHTML = `<p style="color:var(--text-muted);font-size:13px;">${Util.t('empty.printer_no_orders')}</p>`;
      return;
    }

    const fmtDt = (d: Date | null) => (d ? Util.fmtDTReadable(d) : '—');

    const MAX_PRINT_ROWS = 500;
    const printRows = rows.length > MAX_PRINT_ROWS ? rows.slice(0, MAX_PRINT_ROWS) : rows;

    const tbl  = document.createElement('table');
    tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed;';

    const colgroup = document.createElement('colgroup');
    const widths = ['8%', '10%', '10%', '30%', '17%', '17%', '8%'];
    for (const w of widths) {
      const col = document.createElement('col');
      col.style.width = w;
      colgroup.appendChild(col);
    }
    tbl.appendChild(colgroup);

    const thead = document.createElement('thead');
    const htr   = document.createElement('tr');
    for (const h of ['Line', 'Prod. Order', 'Material', 'Description', 'Start', 'End', 'Hours']) {
      const th = document.createElement('th');
      th.textContent = h;
      th.style.cssText = 'text-align:left;padding:6px 8px;border-bottom:2px solid var(--line);font-size:11px;';
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    tbl.appendChild(thead);

    const tb = document.createElement('tbody');
    printRows.forEach((t, i) => {
      const tr = document.createElement('tr');
      tr.style.background = i % 2 === 0 ? '' : 'var(--surface-2, #f8f7f2)';
      const cells = [
        t.MACHINE || '—',
        t.ORDER || t.PRODUCTION_ORDER || '—',
        t.MATERIAL_NUMBER  || '—',
        t.MATERIAL_DESCRIPTION || t.text || '—',
        fmtDt(t.start_date),
        fmtDt(t.end_date),
        Util.runHours(t).toFixed(1)
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        td.style.cssText = 'padding:5px 8px;border-bottom:1px solid var(--line);word-break:break-word;overflow-wrap:anywhere;vertical-align:top;';
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);

    host.textContent = '';
    const countEl = document.createElement('p');
    countEl.style.cssText = 'font-size:12px;color:var(--text-muted);margin:0 0 8px;';
    countEl.textContent = rows.length > MAX_PRINT_ROWS
      ? Util.t('empty.no_orders_printer', { max: MAX_PRINT_ROWS, total: rows.length })
      : Util.t('ui.orders_in_range', { count: rows.length, plural: rows.length === 1 ? '' : 's' });
    host.appendChild(countEl);
    host.appendChild(tbl);
  },

  exportCsv() {
    if (!Printer._rows.length) { Toast.show(Util.t('toast.nothing_to_export'), 'warn'); return; }
    // Plant-local wall clock (same as every on-screen time) — toISOString() exported UTC,
    // shifting each time by the viewer's UTC offset.
    const fmtDt = (d: Date | null) => d ? Util.fmtDT(d) : '';
    const headers = ['Line', 'Production Order', 'Material Number', 'Description', 'Start', 'End', 'Hours'];
    // RFC-4180 quoting + formula guard on every text field (Util.csvCell); BOM so Excel
    // reads the file as UTF-8.
    const lines = [
      headers.map(Util.csvCell).join(','),
      ...Printer._rows.map(t => [
        t.MACHINE || '',
        t.ORDER || t.PRODUCTION_ORDER || '',
        t.MATERIAL_NUMBER  || '',
        t.MATERIAL_DESCRIPTION || t.text || '',
        fmtDt(t.start_date),
        fmtDt(t.end_date),
        Util.runHours(t).toFixed(1)
      ].map(Util.csvCell).join(','))
    ];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.download = `nimbus-orders-${Util.dayKey(new Date())}.csv`;
    a.href = URL.createObjectURL(blob);
    a.click();
    URL.revokeObjectURL(a.href);
  },

  print() {
    window.print();
  }
};
