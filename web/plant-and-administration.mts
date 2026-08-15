// plant-and-administration.mjs — CQ-1 plant-and-administration module.
// Owns Plant, production lines, labor planning, Master Data, Bill of
// Materials, SAP Interface, Security, Admin Cockpit, color-wheel
// administration, and plant/line calendar management. Owns no planner
// timeline or application-wide navigation — see application-shell.mjs.
//
// CQ-1 Phase 4 Task 1 moved CalendarUI, Plant, and ProdLines here verbatim
// from app.js, plus Plant._renderSettingsPane (relocated bodily from App —
// see the comment on that method below).
// CQ-1 Phase 4 Task 2 moved MasterData and LaborPlanning here verbatim too.
// Plant's/ProdLines' `MasterData.syncLineSettings(...)` call sites are left
// going through the shared `NIMBUS` binding (`NIMBUS.MasterData.
// syncLineSettings(...)`) rather than simplified to a same-module bare
// reference now that `MasterData` lives in this same file — both forms are
// equivalent at runtime, and Task 2 doesn't require touching Plant/ProdLines'
// code, the same reasoning Phase 3 used for Timeline's/Table's/Dashboard's
// forward references once their targets landed in the same file (see
// docs/architecture/cq1-compatibility-inventory.md). `LaborPlanning`'s
// `App._laborSub`/`App._currentTab` reads became `_activeTabResolvers.
// laborSub()`/`.currentTab()` (the same injected getter seam Task 1
// established for `Plant`). `MasterData`'s one `Store._state.masterData = {
// ...}; Store.rebuildPlantIndex();` write became `Store.setMasterData(...)`
// (the existing public setter added in Phase 2 Task 4), closing `MasterData`'s
// tracked §6 exception for real rather than carrying it forward by
// relocation — see the comment at that call site and
// docs/architecture/cq1-compatibility-inventory.md §6. `LaborPlanning` itself
// still has six direct `Store._state.masterData` *reads* that this task does
// not close (not named in this task's scope; tracked as a new §6 row instead
// of silently dropped — see the inventory).
// CQ-1 Phase 4 Task 3 moved Interface, Security, and AdminCockpit here
// verbatim, no changes. Research confirmed Interface and Security are fully
// self-contained (zero cross-references to any other of the 14 modules).
// AdminCockpit's dispatch to `MasterData.render()`/`Interface.render()`/
// `Security.render()` in `_setSub` is now a same-file bare reference (no
// seam) — all three already lived behind the same __NIMBUS_PLANT_ADMIN
// bridge destructure in app.js before this task, so nothing about those
// call sites changes. AdminCockpit is by far the largest single module
// moved in this migration (~2,260 lines).
/* global NIMBUS */
import { Config, Util, ErrorLog, Toast, Modal, PerfMonitor } from './application-foundation.mjs';
import { Store, UndoStack } from './schedule-state.mjs';
import type { StoreEvent } from './schedule-state.mjs';
import { Calendar, Engine, Utilization } from './schedule-services.mjs';
import { CalendarSync, Session, Persistence } from './schedule-data.mjs';
import { AlertsUIAdapter, PriorityListViewer } from './schedule-workbench.mjs';
import type { NimbusBlock, NimbusPlantBlock, NimbusMasterPlant, NimbusMasterLine, NimbusLineSetting, ConstraintConfig, BufferUnit, TopLevelTab, PriorityFieldMeta, PriorityListFieldSummary, MissingMasterDataReport, SetupDefinition, SetupMatrixRow, SetupSnapshot, LineSetupState, SetupStateKey, PriorityRankMaps } from './types.mjs';

// Injected getter seam so Plant/LaborPlanning can ask "am I currently the
// visible tab/sub-tab?" without a bare reference to `App` (which lives in
// application-shell.mjs, not this file — see this phase's plan's Architecture
// section, seam #2). Wired once from app.js boot glue immediately after the
// Task 1 bridge destructure. Defaults are no-ops so a call before wiring
// (e.g. in a unit test that imports this module directly) never throws.
interface ActiveTabResolvers {
  currentTab(): string | null;
  currentMasterSub(): string | null;
  laborSub(): string | null;
}

let _activeTabResolvers: ActiveTabResolvers = { currentTab: () => null, currentMasterSub: () => null, laborSub: () => null };

export function setActiveTabResolvers(resolvers: Partial<ActiveTabResolvers>): void {
  _activeTabResolvers = { ..._activeTabResolvers, ...resolvers };
}

/** Shared "reject non-2xx instead of parsing the error body as data" fetch step.
 *  Without it a 403/500 JSON body (`{"detail": …}`) parses cleanly and takes the
 *  success branch, producing a false success message with blank interpolations.
 *  Used by every priority-list read/write in this file. */
const _okJson = (r: Response) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`));

/** Last-resort mirror of `master_data.RANKABLE_FIELDS` (the backend's single
 *  source of truth, surfaced live via `GET /priority-fields`). Only used when
 *  that fetch has never succeeded in this session — otherwise the Optimization
 *  tab would render completely empty on a transient failure, with no dropzones
 *  and therefore no way to upload anything. `default_label` is intentionally the
 *  backend's own English default; the cards render `Util.t('constraint.<key>')`,
 *  so these labels are never what the user actually sees. Keep the key list in
 *  sync with RANKABLE_FIELDS if a field is added there. */
const _FALLBACK_PRIORITY_FIELDS: PriorityFieldMeta[] = [
  { field_key: 'colorWheel', mp_column: 'color', orders_column: 'color', task_field: 'COLOR', default_label: 'Color Wheel' },
  { field_key: 'prt01', mp_column: 'prt_01', orders_column: 'prt_01', task_field: 'PRT_01', default_label: 'Prod. Resource Tool (01)' },
  { field_key: 'prt02', mp_column: 'prt_02', orders_column: 'prt_02', task_field: 'PRT_02', default_label: 'Prod. Resource Tool (02)' },
  { field_key: 'productionVersion', mp_column: 'default_production_version', orders_column: 'production_version', task_field: 'PRODUCTION_VERSION', default_label: 'Production Version' },
];

/** Reserved key in `PriorityListFieldSummary.coverage` holding the true
 *  plant-wide roll-up — must match `db.PLANT_TOTAL_COVERAGE_KEY`. NOT `''`:
 *  that key is the "orders with no production line" bucket, so reading it as a
 *  plant total left the ratio silently blank on every plant whose orders all
 *  carry a line. Summing the per-line buckets instead would double-count any
 *  value used on more than one line (they are per-line COUNT(DISTINCT …)). */
const PLANT_TOTAL_COVERAGE_KEY = '__plant_total__';

/** Value of the mapping modal's "— use row order —" rank-column option. Must
 *  match `brain.ROW_ORDER_SENTINEL` and the static `<option>` in
 *  `web/index.html`'s `#pl-mapping-rank-col`. An explicit sentinel (rather than
 *  `''`) is what lets the backend tell "the user chose row order" apart from
 *  "no rank_column was sent", instead of silently auto-detecting a column the
 *  user just declined. */
const ROW_ORDER_SENTINEL = '__row_order__';

type SetupPermissions = { read: boolean; copy: boolean; export: boolean; definitionWrite: boolean; matrixWrite: boolean; stateWrite: boolean };
type EffectiveSetupRow = SetupMatrixRow & { inherited: boolean; inheritedFromPlant: boolean };
type MissingSetupReviewPair = { line: string; predecessorOrderId?: string | null; successorOrderId?: string | null; fromState?: string | null; toState?: string | null; reason: string };
type SetupWriteKind = 'definition' | 'matrix' | 'state' | 'override';
type SetupReviewNavigation = { selectPlant: boolean; openMasterData: boolean; masterSub: 'plant'; plantTab: 'settings'; renderAfterNavigation: boolean };

/** One cell of the from-state x to-state grid's header axis. `sig` is an
 *  order-independent signature (`fieldKey=value` parts, sorted) so it matches
 *  a stored row's `from_key`/`to_key` regardless of the property/array order
 *  the server happened to return — safer than comparing `JSON.stringify`
 *  output directly, which is order-sensitive. */
type SetupGridState = { key: SetupStateKey; sig: string; parts: string[] };
/** One pending, unsaved edit to a grid cell — `setup_min: null` means "clear
 *  this cell" (delete the row if one exists). `line` is the scope the edit
 *  was staged under (captured at edit time, not read from current state at
 *  save time — a mid-edit scope switch must not silently retag it). */
type SetupGridEdit = { row: SetupGridState; col: SetupGridState; setup_min: number | null; line: string };
type SetupGridModel = { fields: string[]; rowStates: SetupGridState[]; colStates: SetupGridState[]; cellLookup: Map<string, Map<string, EffectiveSetupRow>> };

/**
 * Plant-scoped administration for Stage 0 setup truth. It deliberately does
 * not start the optimizer or alter task placement: this surface is a
 * versioned observation and maintenance console only.
 */
export const SetupAdmin = (() => {
  const API = Config.API_BASE;
  const FALLBACK_REGISTERED_FIELDS = ['colorWheel', 'prt01', 'prt02', 'productionVersion'];
  let _registeredFields = FALLBACK_REGISTERED_FIELDS.slice();
  let _linesByPlant: Record<string, string[]> = {};
  let _compatibilityByLine: Record<string, { setup_compatible: boolean; setup_compatibility_reason: string | null }> = {};
  let _coverageByPlant: Record<string, { observed?: { total_pairs: number; missing_pairs: number }; reachable?: { total_pairs: number; missing_pairs: number } }> = {};
  let _lineScope = '';
  let _missingReview: { plant: string; pairs: MissingSetupReviewPair[] } | null = null;
  let _lastTarget: HTMLElement | null = null;
  // Grid state (Setup Standard's from-state x to-state editor). Rebuilt every
  // renderSnapshot() call, same full-repaint model as the rest of this module.
  let _gridModel: SetupGridModel | null = null;
  // Split From/To (docs/Setup_matrix_redesign.md §6) — a single shared filter
  // applied to both axes made directional inspection (e.g. BLUE→RED) impossible:
  // filtering "BLUE" collapsed the grid to the BLUE→BLUE block only.
  let _gridFilterFrom = '';
  let _gridFilterTo = '';
  let _scopeSeededPlant = '';
  let _gridDirty: Map<string, SetupGridEdit> = new Map(); // key: `${row.sig} ${col.sig}`
  let _gridCellGrid: Array<Array<HTMLTableCellElement | null>> = []; // [rowIdx][colIdx] -> <td>, built per paint
  let _gridSelRange: { r0: number; c0: number; r1: number; c1: number } | null = null;
  let _gridDragging = false;
  let _gridDragAnchor: { row: number; col: number } | null = null;
  let _gridSelTds: Set<HTMLTableCellElement> = new Set();
  // Four-band layout (docs/Setup_matrix_redesign.md §9): the signature editor
  // moved from an always-open panel into a popover behind the band-B chip.
  let _signaturePopoverOpen = false;
  let _setupMenuOpen = false;
  // Single floating editor that repositions over whichever cell is focused,
  // replacing one live <input> per cell (§7/§9-C.3) — the read-only <td>s
  // this replaces are far cheaper to paint at MAX_AXIS² scale than an <input>
  // per cell was before the axis cap existed.
  let _gridEditor: { row: SetupGridState; col: SetupGridState } | null = null;
  // Context for whichever cell _gridEditor currently points at — refreshed on
  // every openGridEditor() call so the floating editor's keydown/blur
  // listeners (wired once, globally, in ensureGridEditorEl — never per-render)
  // always act on the latest render instead of a stale closure.
  let _gridEditorCtx: { target: HTMLElement; snapshot: SetupSnapshot; definition: SetupDefinition | null; rows: EffectiveSetupRow[]; permissions: SetupPermissions } | null = null;

  const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
  const keyText = (key: SetupStateKey): string => key.map(part => `${part.fieldKey}=${part.value}`).join(' | ');
  const keyId = (row: Pick<SetupMatrixRow, 'from_key' | 'to_key'>): string => `${JSON.stringify(row.from_key)}→${JSON.stringify(row.to_key)}`;
  const headers = (): HeadersInit => ({ 'content-type': 'application/json', 'x-user-email': Session.actor() });
  const setupText = (key: string, fallback: string, vars?: Record<string, string | number>): string => {
    try {
      return typeof window === 'undefined' ? fallback : Util.t(key, vars);
    } catch {
      return fallback;
    }
  };
  /** Same `constraint.<key>` vocabulary Scheduling Rules already uses for
   *  these four fields, so the signature reads "Color Wheel" instead of the
   *  raw `colorWheel` field key — one term for the same underlying registry
   *  instead of two (docs/Setup_matrix_redesign.md §3). Falls back to the
   *  raw key if a field has no translated label. */
  function fieldLabel(fieldKey: string): string {
    const translated = setupText(`constraint.${fieldKey}`, '');
    return translated || fieldKey;
  }
  /** `.empty-state`-styled markup for the grid/pane's empty conditions,
   *  reusing the app's existing empty-state visual language (application-
   *  shell.mts's EmptyState) instead of ad hoc `.setup-help`/`.setup-empty`
   *  text scattered across multiple styles (docs/Setup_matrix_redesign.md
   *  §4-5). Inline markup, not the EmptyState module itself, so this has no
   *  dependency on that module's mount/action wiring. */
  function emptyState(message: string, hint?: string): string {
    return `<div class="empty-state setup-empty-state"><p>${esc(message)}</p>${hint ? `<p class="setup-empty-state-hint">${esc(hint)}</p>` : ''}</div>`;
  }

  function permissionsFor({ isAdmin, setupScheduler, plantAllowed }: { isAdmin: boolean; setupScheduler: boolean; plantAllowed: boolean }): SetupPermissions {
    return { read: true, copy: true, export: true, definitionWrite: isAdmin, matrixWrite: isAdmin,
      stateWrite: isAdmin || (setupScheduler && plantAllowed) };
  }

  function canWriteVersion(candidate: number | null | undefined, current: number | null | undefined): boolean {
    return Number.isInteger(candidate) && candidate === current;
  }

  function activationStatus(definition: SetupDefinition | null, checks: { matrixVersion?: number | null; coveragePass?: boolean }): { active: boolean; reason: string } {
    if (!definition) return { active: false, reason: setupText('ui.setup_status_no_definition', 'Create an ordered setup signature before setup-aware optimization can be reviewed.') };
    if (checks.matrixVersion !== definition.signature_version) {
      return { active: false, reason: setupText('ui.setup_status_version_mismatch', 'Activation is disabled: a version-matched matrix is required after a definition change.') };
    }
    if (checks.coveragePass === undefined) return { active: false, reason: setupText('ui.setup_status_coverage_pending', 'Activation is pending: coverage has not been measured yet (Stage 0 observation-only).') };
    if (!checks.coveragePass) return { active: false, reason: setupText('ui.setup_status_coverage_fail', 'Activation is disabled: the reachable coverage pass is required.') };
    return definition.active
      ? { active: true, reason: setupText('ui.setup_status_active_reason', 'Active for approved setup-aware optimization.') }
      : { active: false, reason: setupText('ui.setup_status_ready_review', 'Ready for activation review; Stage 0 remains observation-only.') };
  }

  function effectiveRows({ plantRows, lineRows, line, version }: { plantRows: SetupMatrixRow[]; lineRows: SetupMatrixRow[]; line: string; version: number }): EffectiveSetupRow[] {
    const plant = plantRows.filter(row => row.signature_version === version);
    if (!line) return plant.map(row => ({ ...row, inherited: false, inheritedFromPlant: false }));
    const overrides = lineRows.filter(row => row.line === line && row.signature_version === version);
    const byPair = new Map(overrides.map(row => [keyId(row), row]));
    const result = plant.map(row => {
      const override = byPair.get(keyId(row));
      return override
        ? { ...override, inherited: false, inheritedFromPlant: false }
        : { ...row, line, inherited: true, inheritedFromPlant: true };
    });
    overrides.filter(row => !plant.some(base => keyId(base) === keyId(row))).forEach(row =>
      result.push({ ...row, inherited: false, inheritedFromPlant: false }));
    return result;
  }

  function deleteRequest(row: SetupMatrixRow): { line: string; signature_version: number; rows: SetupMatrixRow[] } {
    return { line: row.line, signature_version: row.signature_version, rows: [row] };
  }

  // ── Setup Standard grid: from-state x to-state editor ─────────────────────
  // Replaces the old flat from/to edge-list table. Header axes are the
  // cross-product of each active signature field's known priority-list
  // values (Store.priorityRankMaps) — not bounded to states that already have
  // a matrix row — so a value that exists in a priority list but has never
  // been scheduled yet already has a header and an editable cell. See
  // docs/setup_matrix_ui_redesign.md §3.2 Group 1.

  /** Order-independent signature for a state key, so a row's stored
   *  `from_key`/`to_key` matches a candidate cross-product state regardless
   *  of property/array order — safer than comparing JSON.stringify output. */
  function stateSig(key: SetupStateKey): string {
    return key.map(part => `${part.fieldKey}=${part.value}`).slice().sort().join('|');
  }

  /** Converts an optimizer-preview pair's pre-formatted `"fieldKey=value | ..."`
   *  text (schedule-workbench.mts's `describeMissingPairs`) into the same
   *  order-independent signature `stateSig` produces, so a missing-pairs
   *  review filter (§9 "what moves off the page") can match grid states by
   *  sig instead of needing its own comparison format. Returns `null` for the
   *  unresolvable placeholder text ('—' or empty). */
  function reviewStateSigFromText(text: string | null | undefined): string | null {
    if (!text) return null;
    const parts = text.split('|').map(part => part.trim()).filter(Boolean);
    return parts.length ? parts.slice().sort().join('|') : null;
  }

  function gridEditKey(row: SetupGridState, col: SetupGridState): string {
    return `${row.sig} ${col.sig}`;
  }

  /** Union of every value with a rank in the plant-default map or (if a line
   *  is scoped) that line's override map — a state is definable if it has a
   *  rank anywhere, not only in whichever map is currently in view. */
  function fieldValueSet(rankMaps: PriorityRankMaps, fieldKey: string, lineScope: string): string[] {
    const plantMap = rankMaps['']?.[fieldKey] || {};
    const lineMap = lineScope ? (rankMaps[lineScope]?.[fieldKey] || {}) : {};
    return [...new Set([...Object.keys(plantMap), ...Object.keys(lineMap)])]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  function cartesianStates(fields: ReadonlyArray<string>, valuesByField: Record<string, string[]>): SetupGridState[] {
    let acc: Array<Array<{ fieldKey: string; value: string }>> = [[]];
    for (const field of fields) {
      const values = valuesByField[field] || [];
      const next: Array<Array<{ fieldKey: string; value: string }>> = [];
      for (const partial of acc) for (const value of values) next.push([...partial, { fieldKey: field, value }]);
      acc = next;
    }
    return acc.map(key => ({ key, sig: stateSig(key), parts: key.map(part => part.value) }));
  }

  function buildCellLookup(rows: ReadonlyArray<EffectiveSetupRow>): Map<string, Map<string, EffectiveSetupRow>> {
    const lookup = new Map<string, Map<string, EffectiveSetupRow>>();
    rows.forEach(row => {
      const fromSig = stateSig(row.from_key), toSig = stateSig(row.to_key);
      if (!lookup.has(fromSig)) lookup.set(fromSig, new Map());
      lookup.get(fromSig)!.set(toSig, row);
    });
    return lookup;
  }

  function buildGridModel(fields: ReadonlyArray<string>, valuesByField: Record<string, string[]>, rows: ReadonlyArray<EffectiveSetupRow>): SetupGridModel {
    const states = cartesianStates(fields, valuesByField);
    return { fields: [...fields], rowStates: states, colStates: states, cellLookup: buildCellLookup(rows) };
  }

  function filterStates(states: ReadonlyArray<SetupGridState>, query: string): SetupGridState[] {
    const q = query.trim().toLowerCase();
    if (!q) return states.slice();
    return states.filter(s => s.parts.some(part => part.toLowerCase().includes(q)));
  }

  /** Colspan/rowspan run-length encoding for one header tier: groups
   *  consecutive states that share the same value through this tier's prefix,
   *  so two non-adjacent groups that happen to share a later-tier value are
   *  never merged into one run. `states` must already be in cartesian-product
   *  order (cartesianStates/filterStates preserve it). */
  function tierRuns(states: ReadonlyArray<SetupGridState>, tier: number): Array<{ value: string; start: number; span: number }> {
    const runs: Array<{ value: string; start: number; span: number }> = [];
    const prefix = (s: SetupGridState) => s.parts.slice(0, tier + 1).join(' ');
    states.forEach((s, i) => {
      if (i > 0 && prefix(s) === prefix(states[i - 1])) runs[runs.length - 1].span++;
      else runs.push({ value: s.parts[tier] ?? '', start: i, span: 1 });
    });
    return runs;
  }

  /** A diagonal cell (identical from/to state) with no explicit row and no
   *  pending edit resolves to 0 per docs/changeover_matrix.md's resolution
   *  rule ("identical states" is the only missing-row case that may resolve
   *  to zero) — every other missing non-diagonal cell resolves to `null`
   *  ("unknown"), never a fabricated zero. */
  function gridCellValue(row: SetupGridState, col: SetupGridState, existing: EffectiveSetupRow | undefined, dirty: SetupGridEdit | undefined): number | null {
    if (dirty) return dirty.setup_min;
    if (existing) return existing.setup_min;
    return row.sig === col.sig ? 0 : null;
  }

  /** The six states a cell must render distinctly (docs/Setup_matrix_redesign.md
   *  §7) — a bare numeric value can only ever say "0 or not 0", which
   *  collapses an explicit diagonal row, a structurally-free implicit zero, a
   *  line override, and a plant-default value into the same look. `lineScope`
   *  is threaded explicitly (not read from module state) so this stays a pure,
   *  directly-testable function like its sibling `fieldValueSet`. */
  type SetupGridCellState = 'dirty' | 'uncovered' | 'diagonal-explicit' | 'implicit-zero' | 'line-override' | 'plant-default';
  function gridCellState(row: SetupGridState, col: SetupGridState, existing: EffectiveSetupRow | undefined, dirty: SetupGridEdit | undefined, lineScope: string): SetupGridCellState {
    if (dirty) return 'dirty';
    const diagonal = row.sig === col.sig;
    if (!existing) return diagonal ? 'implicit-zero' : 'uncovered';
    if (diagonal) return 'diagonal-explicit';
    return lineScope && !existing.inherited ? 'line-override' : 'plant-default';
  }

  /** Bounds the rendered universe per axis (docs/Setup_matrix_redesign.md §6
   *  — an unbounded cross-product renders one `<input>` DOM node per cell, and
   *  a two-field, 20-30-value-per-field signature already produces hundreds of
   *  thousands of cells). Reports `total`/`truncated` so the caller can tell
   *  the user how much was hidden rather than silently dropping states. */
  function capAxis(states: ReadonlyArray<SetupGridState>, maxAxis: number): { states: SetupGridState[]; total: number; truncated: boolean } {
    const total = states.length;
    return { states: states.length > maxAxis ? states.slice(0, maxAxis) : states.slice(), total, truncated: total > maxAxis };
  }
  const MAX_AXIS = 60;

  /** Parses one grid cell's typed or pasted text. `null` = clear the cell;
   *  `'invalid'` = reject without changing anything (schema bound is 0-10080
   *  minutes, `schema.sql`'s `setup_matrix.setup_min` check). */
  function parseGridMinutes(raw: string): number | null | 'invalid' {
    const trimmed = raw.trim().replace(/,/g, '');
    if (trimmed === '') return null;
    const num = Math.round(Number(trimmed));
    if (!Number.isFinite(num) || num < 0 || num > 10080) return 'invalid';
    return num;
  }

  /** Splits pending grid edits into the request bodies the EXISTING endpoints
   *  already accept — no new backend endpoint. Line-scoped edits are a safe
   *  sparse upsert as-is (setup_data.upsert_line_matrix_rows). Plant-default
   *  (line==='') edits must resend the FULL current plant-default row set
   *  merged with the edits, because that scope's import path is a
   *  delete-then-insert replace (setup_data.replace_plant_matrix), not an
   *  upsert — sending only the edited cells there would silently wipe every
   *  other plant-default row. See docs/setup_matrix_ui_redesign.md §7. */
  function buildSaveRequests(edits: ReadonlyArray<SetupGridEdit>, signatureVersion: number, existingPlantRows: ReadonlyArray<SetupMatrixRow>): {
    upsert: Array<{ line: string; signature_version: number; rows: Array<{ from: SetupStateKey; to: SetupStateKey; setup_min: number }> }>;
    deletes: Array<{ line: string; signature_version: number; rows: Array<{ from_key: SetupStateKey; to_key: SetupStateKey }> }>;
  } {
    const byLine = new Map<string, SetupGridEdit[]>();
    edits.forEach(e => { if (!byLine.has(e.line)) byLine.set(e.line, []); byLine.get(e.line)!.push(e); });
    const upsert: Array<{ line: string; signature_version: number; rows: Array<{ from: SetupStateKey; to: SetupStateKey; setup_min: number }> }> = [];
    const deletes: Array<{ line: string; signature_version: number; rows: Array<{ from_key: SetupStateKey; to_key: SetupStateKey }> }> = [];
    byLine.forEach((lineEdits, line) => {
      const sets = lineEdits.filter((e): e is SetupGridEdit & { setup_min: number } => e.setup_min !== null);
      const clears = lineEdits.filter(e => e.setup_min === null);
      if (line) {
        if (sets.length) upsert.push({ line, signature_version: signatureVersion, rows: sets.map(e => ({ from: e.row.key, to: e.col.key, setup_min: e.setup_min })) });
        if (clears.length) deletes.push({ line, signature_version: signatureVersion, rows: clears.map(e => ({ from_key: e.row.key, to_key: e.col.key })) });
        return;
      }
      const merged = new Map<string, SetupMatrixRow>();
      existingPlantRows.forEach(row => merged.set(`${stateSig(row.from_key)} ${stateSig(row.to_key)}`, row));
      sets.forEach(e => merged.set(gridEditKey(e.row, e.col), { line: '', signature_version: signatureVersion, from_key: e.row.key, to_key: e.col.key, setup_min: e.setup_min, source: 'manual' }));
      clears.forEach(e => merged.delete(gridEditKey(e.row, e.col)));
      if (sets.length || clears.length) upsert.push({ line: '', signature_version: signatureVersion, rows: [...merged.values()].map(r => ({ from: r.from_key, to: r.to_key, setup_min: r.setup_min })) });
    });
    return { upsert, deletes };
  }

  function csvColumns(): string[] {
    return ['Plant', 'Line', 'Signature version', 'From setup state', 'To setup state', 'Setup minutes'];
  }

  function missingPairsCsv(plant: string, pairs: ReadonlyArray<MissingSetupReviewPair>): string {
    const quote = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = pairs.slice(0, 12).map(pair => [plant, pair.line, pair.predecessorOrderId, pair.successorOrderId,
      pair.fromState, pair.toState, pair.reason].map(quote).join(','));
    return ['Plant,Line,Predecessor order,Successor order,From setup state,To setup state,Reason', ...rows].join('\n');
  }

  function reviewAction(permissions: Pick<SetupPermissions, 'matrixWrite'>): 'editor' | 'copy-export' {
    return permissions.matrixWrite ? 'editor' : 'copy-export';
  }

  function canReviewMissingPairs(plant: string): boolean {
    const session = Session.currentUser();
    const settings = session?.role_settings?.permissions as Record<string, unknown> | undefined;
    const plantAllowed = Session.isAdmin() || session?.allowed_plants?.includes(plant) === true;
    return permissionsFor({ isAdmin: Session.isAdmin(), setupScheduler: settings?.setup_scheduler === true, plantAllowed }).matrixWrite;
  }

  function reviewNavigation(plant: string, selectedPlant: string | null, paneVisible: boolean): SetupReviewNavigation {
    return {
      selectPlant: selectedPlant !== plant,
      openMasterData: true,
      masterSub: 'plant',
      plantTab: 'settings',
      renderAfterNavigation: !paneVisible || selectedPlant !== plant,
    };
  }

  function setupWriteKind(url: string): SetupWriteKind {
    if (/\/active(?:$|\?)/.test(url)) return 'definition';
    if (/\/definition(?:$|\?)/.test(url)) return 'definition';
    if (/\/matrix(?:\/|$)/.test(url)) return 'matrix';
    if (/\/state(?:$|\?)/.test(url)) return 'state';
    return 'override';
  }

  /** Receives only the compact preview edge list. It never stores candidate
   * schedules and it never triggers an optimization run. */
  function reviewMissingPairs(plant: string | null, pairs: ReadonlyArray<MissingSetupReviewPair>): boolean {
    if (!plant || !canReviewMissingPairs(plant)) return false;
    _missingReview = { plant, pairs: pairs.slice(0, 12).map(pair => ({ ...pair })) };
    const lines = [...new Set(_missingReview.pairs.map(pair => pair.line).filter(Boolean))];
    if (lines.length === 1) _lineScope = lines[0];
    const existingPane = _lastTarget ?? document.getElementById('setup-admin-pane');
    const navigation = reviewNavigation(plant, Store.selectedPlant, !!existingPane && !existingPane.closest('[hidden]'));
    if (navigation.selectPlant) Store.setSelectedPlant(plant, 'setup-preview-review');
    const app = (globalThis as unknown as { NIMBUS?: { App?: { goto?: (tab: string) => void; gotoMasterSub?: (sub: 'plant') => void } } }).NIMBUS?.App;
    app?.goto?.('masterdata');
    app?.gotoMasterSub?.(navigation.masterSub);
    Plant.gotoTab(navigation.plantTab);
    const target = document.getElementById('setup-admin-pane') ?? existingPane;
    if (target) render(target, plant);
    return true;
  }

  function csvFor(plant: string, rows: EffectiveSetupRow[]): string {
    const quote = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`;
    return [csvColumns(), ...rows.map(row => [plant, row.line || '', row.signature_version, JSON.stringify(row.from_key), JSON.stringify(row.to_key), row.setup_min])]
      .map(row => row.map(quote).join(',')).join('\r\n');
  }

  function registeredFields(fields: Array<{ field_key: string }> | null | undefined): string[] {
    return (fields || []).map(field => field.field_key).filter(Boolean);
  }

  function parseCsv(text: string): string[][] {
    const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted && char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = !quoted;
      else if (!quoted && char === ',') { row.push(cell); cell = ''; }
      else if (!quoted && (char === '\n' || char === '\r')) { if (char === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(value => value !== '')) rows.push(row); row = []; cell = ''; }
      else cell += char;
    }
    if (quoted) throw new Error('CSV contains an unclosed quote');
    row.push(cell); if (row.some(value => value !== '')) rows.push(row);
    return rows;
  }

  function parseLongFormCsv(text: string): { plant: string; line: string; signature_version: number; rows: Array<{ from: SetupStateKey; to: SetupStateKey; setup_min: number }> } {
    const csv = parseCsv(text); const expected = csvColumns();
    if (!csv.length || expected.some((name, index) => csv[0][index] !== name)) throw new Error('CSV must use the canonical setup-matrix columns');
    if (csv.length < 2) throw new Error('CSV has no matrix rows');
    const first = csv[1]; const plant = first[0]; const line = first[1]; const signature_version = Number(first[2]);
    if (!plant || !Number.isInteger(signature_version)) throw new Error('CSV requires Plant and integer Signature version');
    const rows = csv.slice(1).map(values => {
      if (values.length !== expected.length || values[0] !== plant || values[1] !== line || Number(values[2]) !== signature_version) throw new Error('CSV rows must use one plant, line scope, and signature version');
      const from = JSON.parse(values[3]); const to = JSON.parse(values[4]); const setup_min = Number(values[5]);
      if (!Array.isArray(from) || !Array.isArray(to) || !Number.isInteger(setup_min) || setup_min < 0) throw new Error('CSV has invalid setup-state JSON or minutes');
      return { from, to, setup_min };
    });
    return { plant, line, signature_version, rows };
  }

  async function loadRegisteredFields(): Promise<void> {
    try { const response = await Util.fetchTraced(`${API}/priority-fields`); if (!response.ok) throw new Error(`HTTP ${response.status}`); const data = await response.json() as { fields?: Array<{ field_key: string }> }; const fields = registeredFields(data.fields); if (fields.length) _registeredFields = fields; }
    catch (error) { ErrorLog.warn('setup-admin', `Priority-field registry unavailable: ${(error as Error).message}`); }
  }

  async function collectPagedLines(loadPage: (offset: number, limit: number) => Promise<{ rows?: Array<{ production_line: string }>; meta?: { total?: number } }>, pageSize = 100): Promise<string[]> {
    const lines: string[] = []; let offset = 0; let total = Number.POSITIVE_INFINITY;
    // Each request stays bounded. The server's filtered total controls
    // continuation; an empty page is a defensive escape from a stale total.
    while (offset < total) {
      const page = await loadPage(offset, pageSize);
      const rows = page.rows || [];
      lines.push(...rows.map(row => row.production_line).filter(Boolean));
      total = Number.isFinite(page.meta?.total) ? Math.max(0, Number(page.meta?.total)) : offset + rows.length;
      offset += rows.length;
      if (!rows.length) break;
    }
    return [...new Set(lines)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  async function loadScopeLines(plant: string): Promise<void> {
    if (_linesByPlant[plant]) return;
    try { _linesByPlant[plant] = await collectPagedLines(async (offset, limit) => { const response = await Util.fetchTraced(`${API}/master-data/production_lines?plant=${encodeURIComponent(plant)}&limit=${limit}&offset=${offset}`); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<{ rows?: Array<{ production_line: string }>; meta?: { total?: number } }>; }); }
    catch (error) { ErrorLog.warn('setup-admin', `Plant line scope unavailable: ${(error as Error).message}`); _linesByPlant[plant] = []; }
  }

  async function loadCompatibility(plant: string, line: string): Promise<void> {
    const cacheKey = `${plant}\u0000${line}`; if (_compatibilityByLine[cacheKey]) return;
    try { const response = await Util.fetchTraced(`${API}/setup/${encodeURIComponent(plant)}/lines/${encodeURIComponent(line)}/compatibility`); if (!response.ok) throw new Error(`HTTP ${response.status}`); _compatibilityByLine[cacheKey] = await response.json(); }
    catch (error) { ErrorLog.warn('setup-admin', `Line compatibility unavailable: ${(error as Error).message}`); }
  }

  async function loadCoverage(plant: string): Promise<void> {
    if (_coverageByPlant[plant]) return;
    const started = performance.now();
    try {
      const response = await Util.fetchTraced(`${API}/setup/${encodeURIComponent(plant)}/coverage?limit=100`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      _coverageByPlant[plant] = await response.json();
    } catch (error) { ErrorLog.warn('setup-admin', `Setup coverage unavailable: ${(error as Error).message}`); }
    finally { PerfMonitor.record('setup.coverage.fetch', performance.now() - started); }
  }

  function render(target: HTMLElement | null, plant: string | null = Store.selectedPlant): void {
    if (!target) return;
    _lastTarget = target;
    if (!plant) { target.innerHTML = `<div class="setup-empty">${esc(Util.t('toast.no_plant_selected'))}</div>`; return; }
    const snapshot = Store.setupSnapshot;
    if (!snapshot || snapshot.plant !== plant) {
      target.innerHTML = `<div class="setup-empty">${esc(Util.t('ui.loading'))}</div>`;
      Persistence.loadSetupSnapshot(plant).then(() => {
        if (Store.selectedPlant === plant) render(target, plant);
      });
      return;
    }
    // Await every load once and paint a single time — each of these is a
    // cheap no-op when already cached, so this doesn't add a real delay on
    // the common case, but it stops the panel from repainting (and blowing
    // away the combobox + every listener) up to three times per open.
    const loaders: Array<Promise<unknown>> = [
      loadRegisteredFields(), loadScopeLines(plant), loadCoverage(plant),
    ];
    // The grid's header axes read Store.priorityRankMaps directly — load it
    // here rather than relying on the Scheduling Rules tab's constraint-panel
    // side effect (Plant._renderSettingsPane's initConstraints IIFE), since
    // the two are now separate inner tabs and a visitor may open Setup Matrix
    // without ever visiting Scheduling Rules first.
    if (Persistence._rankMapsPlant !== plant) loaders.push(Persistence.loadPriorityRankMaps(plant));
    if (_lineScope) loaders.push(loadCompatibility(plant, _lineScope));
    Promise.all(loaders).then(() => {
      if (Store.selectedPlant === plant) renderSnapshot(target, snapshot);
    });
  }

  function renderSnapshot(target: HTMLElement, snapshot: SetupSnapshot): void {
    const definition = snapshot.definition;
    const version = definition?.signature_version ?? null;
    const session = Session.currentUser();
    const settings = session?.role_settings?.permissions as Record<string, unknown> | undefined;
    const plantAllowed = Session.isAdmin() || session?.allowed_plants?.includes(snapshot.plant) === true;
    const permissions = permissionsFor({ isAdmin: Session.isAdmin(), setupScheduler: settings?.setup_scheduler === true, plantAllowed });
    const lines = _linesByPlant[snapshot.plant] || [];
    // Seed the scope from the global line filter (Store.selectedLines) once
    // per plant, on open only — deliberately NOT a live bind. Live-binding
    // would silently re-scope the matrix an admin is mid-edit on whenever the
    // Gantt/Orders line filter changes elsewhere (docs/Setup_matrix_redesign.md
    // §16 Q2). Only seeds when exactly one of this plant's lines is selected;
    // an empty or multi-line filter has no single unambiguous scope to seed.
    if (_scopeSeededPlant !== snapshot.plant) {
      _scopeSeededPlant = snapshot.plant;
      if (!_lineScope) {
        const candidates = lines.filter(line => Store.selectedLines.has(line));
        if (candidates.length === 1) _lineScope = candidates[0];
      }
    }
    if (_lineScope && !lines.includes(_lineScope)) _lineScope = '';
    const rows = version === null ? [] : effectiveRows({ plantRows: snapshot.plant_rows, lineRows: snapshot.line_rows, line: _lineScope, version });
    const definitionFields = definition?.fields?.length ? definition.fields : [_registeredFields[0]].filter(Boolean);
    const matrixVersion = rows.length ? version : null;
    const coverage = _coverageByPlant[snapshot.plant];
    const coveragePass = coverage ? coverage.reachable?.missing_pairs === 0 : undefined;
    const status = activationStatus(definition, { matrixVersion, coveragePass });
    const sourceLabel = _lineScope ? _lineScope : Util.t('ui.setup_plant_default');
    const state = _lineScope ? snapshot.line_states.find(row => row.line === _lineScope) : null;
    const overrides = _lineScope ? snapshot.overrides.filter(row => row.line === _lineScope) : snapshot.overrides;
    const review = _missingReview?.plant === snapshot.plant ? _missingReview : null;
    // §9 "what moves off the page": the tab's own missing-pairs mini-table
    // collapses to a filter chip on the grid — not the OptimizerPreview
    // modal's own copy of this table (schedule-workbench.mts), which is a
    // separate surface (the run-time comparison dialog) left untouched.
    const missingChipHtml = review ? `<span class="setup-review-chip">${esc(Util.t('ui.setup_review_chip', { count: review.pairs.length }))}<button type="button" class="setup-review-chip-clear" data-setup-review-clear aria-label="${esc(Util.t('btn.setup_review_clear'))}">&times;</button></span>` : '';
    const totalPairs = coverage?.reachable?.total_pairs ?? 0;
    const missingPairs = coverage?.reachable?.missing_pairs ?? 0;
    const coverageInlineHtml = coverage
      ? `<button type="button" class="setup-coverage-inline${missingPairs > 0 ? ' warn' : ''}" data-setup-missing-filter>${esc(Util.t('ui.setup_coverage_inline', { covered: Math.max(0, totalPairs - missingPairs), total: totalPairs }))} · ${esc(Util.t('ui.setup_kpi_missing_count', { missing: missingPairs }))} &#9656;</button>`
      : '';
    const signatureChipHtml = definitionFields.length
      ? definitionFields.map(field => esc(fieldLabel(field))).join(' &rsaquo; ')
      : esc(Util.t('ui.setup_no_definition_short'));
    target.innerHTML = `
      <section class="setup-admin" aria-labelledby="setup-admin-title">
        <header class="setup-band setup-context-bar">
          <div class="setup-context-main">
            <h3 id="setup-admin-title">${esc(Util.t('ui.setup_matrix_title'))}</h3>
            <p>${esc(Util.t('ui.setup_matrix_sub', { plant: snapshot.plant }))}</p>
          </div>
          <div class="setup-context-controls">
            ${permissions.definitionWrite ? `<label class="setup-check" data-setup-active-toggle-wrap><input type="checkbox" data-setup-active-toggle ${definition?.active ? 'checked' : ''} ${definition ? '' : 'disabled'}>${esc(Util.t('ui.setup_include_setup_times'))}</label>` : ''}
            <span class="setup-status-chip ${status.active ? 'ok' : 'warn'}" title="${esc(status.reason)}"><span class="dot"></span>${status.active ? esc(Util.t('ui.setup_activation_active')) : esc(Util.t('ui.setup_activation_inactive'))}</span>
            <button type="button" class="setup-version-chip" data-setup-signature-edit aria-expanded="${_signaturePopoverOpen}" aria-haspopup="true">v${version ?? '—'} &#9998;</button>
          </div>
        </header>

        <div class="setup-band setup-standard-rail">
          <div class="setup-signature-wrap">
            <span class="mono-eyebrow">${esc(Util.t('ui.setup_band_signature_label'))}</span>
            <span class="setup-signature-chip">${signatureChipHtml}</span>
          </div>
          <div class="setup-scope-wrap">
            <label class="mono-eyebrow" for="setup-line-combobox">${esc(Util.t('ui.setup_scope_label'))}</label>
            <span id="setup-line-combobox"></span>
            ${_lineScope ? renderLineState(state ?? undefined, definition, permissions) : ''}
          </div>
          <div class="setup-coverage-wrap">
            ${coverageInlineHtml}
            ${missingChipHtml}
          </div>
        </div>

        <div class="setup-popover" data-setup-signature-popover ${_signaturePopoverOpen ? '' : 'hidden'}>
          <p class="setup-popover-hint">${esc(Util.t('ui.setup_signature_popover_hint'))}</p>
          <div class="panel-head"><span class="label">${esc(Util.t('ui.setup_step1_definition'))}</span>${permissions.definitionWrite ? `<button class="btn btn-ghost sm" data-setup-save-definition>${esc(Util.t('btn.save'))}</button>` : `<span class="panel-hint">${esc(Util.t('ui.setup_read_only'))}</span>`}</div>
          <div class="setup-field-order" data-setup-field-order>${definitionFields.map((field, index) => `<div class="setup-field-row"><span>${index + 1}</span><select data-setup-field="${index}" ${permissions.definitionWrite ? '' : 'disabled'}>${_registeredFields.map(option => `<option value="${option}"${option === field ? ' selected' : ''}>${esc(fieldLabel(option))}</option>`).join('')}</select>${permissions.definitionWrite ? `<button type="button" class="btn btn-ghost sm" data-setup-field-up="${index}" ${index === 0 ? 'disabled' : ''} aria-label="${esc(Util.t('btn.setup_field_up'))}">&uarr;</button><button type="button" class="btn btn-ghost sm" data-setup-field-down="${index}" ${index === definitionFields.length - 1 ? 'disabled' : ''} aria-label="${esc(Util.t('btn.setup_field_down'))}">&darr;</button>` : ''}</div>`).join('')}</div>
          <label class="setup-check"><input type="checkbox" data-setup-strict ${definition?.strict_blanks !== false ? 'checked' : ''} ${permissions.definitionWrite ? '' : 'disabled'}>${esc(Util.t('ui.setup_strict_blanks'))}</label>
          ${permissions.definitionWrite ? `<button class="btn btn-ghost sm" data-setup-add-field>${esc(Util.t('btn.setup_add_field'))}</button>` : ''}
        </div>

        <div class="setup-band setup-grid-band">
          <div class="setup-grid-toolbar">
            <input type="text" class="input setup-grid-filter" data-setup-grid-filter-from placeholder="${esc(Util.t('ui.setup_grid_filter_from_placeholder'))}" value="${esc(_gridFilterFrom)}">
            <input type="text" class="input setup-grid-filter" data-setup-grid-filter-to placeholder="${esc(Util.t('ui.setup_grid_filter_to_placeholder'))}" value="${esc(_gridFilterTo)}">
          </div>
          <div id="setup-grid-table-mount"></div>
        </div>

        <div class="setup-band setup-action-bar">
          <span data-setup-grid-dirty-count>${esc(Util.t('ui.setup_grid_dirty_count', { count: _gridDirty.size }))}</span>
          <div class="setup-action-buttons">
            <button class="btn btn-ghost sm" data-setup-grid-discard ${_gridDirty.size ? '' : 'disabled'}>${esc(Util.t('btn.discard'))}</button>
            <button class="btn btn-primary sm" data-setup-grid-save ${_gridDirty.size ? '' : 'disabled'}>${esc(Util.t('btn.save'))}</button>
          </div>
          <div class="setup-menu">
            <button type="button" class="btn btn-ghost sm" data-setup-menu-toggle aria-haspopup="true" aria-expanded="${_setupMenuOpen}">&#8943;</button>
            <div class="setup-menu-list" data-setup-menu-list role="menu" ${_setupMenuOpen ? '' : 'hidden'}>
              <button type="button" role="menuitem" data-setup-copy-matrix ${permissions.copy ? '' : 'disabled'}>${esc(Util.t('btn.setup_copy_matrix'))}</button>
              <button type="button" role="menuitem" data-setup-export-matrix ${permissions.export ? '' : 'disabled'}>${esc(Util.t('btn.setup_export_matrix'))}</button>
              ${permissions.matrixWrite && definition ? `<label class="setup-menu-item" role="menuitem">${esc(Util.t('ui.setup_import_csv'))}<input type="file" accept=".csv,text/csv" data-setup-import hidden></label>` : ''}
              <button type="button" role="menuitem" data-setup-history-open>${esc(Util.t('btn.setup_audit_toggle', { count: overrides.length }))}</button>
            </div>
          </div>
        </div>

      </section>`;
    _mkCombobox(target.querySelector('#setup-line-combobox'), ['', ...lines], { value: _lineScope, placeholder: Util.t('ph.search_lines'), onSelect: value => {
      _lineScope = value;
      if (value) loadCompatibility(snapshot.plant, value).then(() => renderSnapshot(target, snapshot));
      else renderSnapshot(target, snapshot);
    } });
    wire(target, snapshot, permissions, rows, definition);
    paintGrid(target, snapshot, definition, rows, permissions);
  }

  /** Compact "you are here" readout inline under the Scope selector — replaces
   *  the old standalone "Line Status" group/panel (docs/Setup_matrix_redesign.md
   *  §9 "what moves off the page"). The grid itself marks the matching row;
   *  this is only the state text + the write affordance (`editState`/
   *  `wireCompatibility` still need a mount point in the DOM). */
  function renderLineState(state: LineSetupState | undefined, definition: SetupDefinition | null, permissions: SetupPermissions): string {
    const values = state ? keyText(state.state_key) : Util.t('ui.setup_state_unknown');
    return `<div class="setup-state-inline" data-setup-state-inline><div class="setup-state-readout"><span>${esc(values)}</span><span>${esc(Util.t('ui.setup_state_source'))}: ${esc(state?.source || '—')}</span><span>${esc(Util.t('ui.setup_observed_at'))}: ${esc(state?.observed_at || '—')}</span></div>${permissions.stateWrite && definition ? `<button class="btn btn-ghost sm" data-setup-edit-state>${esc(Util.t('btn.setup_update_state'))}</button>` : ''}</div>`;
  }

  function overridesFor(snapshot: SetupSnapshot): SetupSnapshot['overrides'] {
    return _lineScope ? snapshot.overrides.filter(row => row.line === _lineScope) : snapshot.overrides;
  }

  /** §9 "what moves off the page": the override-audit panel becomes a modal
   *  behind the action bar's `⋯ → History` menu item instead of an inline
   *  collapsed panel. Built on demand (not a static index.html modal, since
   *  its content is per-plant/per-scope) and removed from the DOM on close
   *  rather than merely hidden, matching the one-shot nature of every other
   *  dynamically-built dialog in this module (e.g. `editState`'s inline editor). */
  function openHistoryModal(snapshot: SetupSnapshot): void {
    const overrides = overridesFor(snapshot);
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="setup-history-title">
      <header class="modal-head"><h3 id="setup-history-title">${esc(Util.t('ui.setup_override_audit'))}</h3><button type="button" class="btn btn-ghost sm" data-setup-history-close aria-label="${esc(Util.t('btn.close'))}">&times;</button></header>
      <div class="modal-body">${overrides.length ? overrides.map(override => `<div class="setup-audit-row"><strong>${esc(override.status.toUpperCase())}</strong><span>${esc(override.line)} &middot; ${esc(keyText(override.predecessor_state_key))} &rarr; ${esc(keyText(override.successor_state_key))}</span><span class="setup-num">${override.remaining_min}/${override.standard_min} min</span><span>${esc(override.reason)}</span></div>`).join('') : emptyState(Util.t('ui.setup_no_overrides'))}</div>
      <footer class="modal-foot"><button type="button" class="btn btn-ghost sm" data-setup-history-close>${esc(Util.t('btn.close'))}</button></footer>
    </div>`;
    const close = (): void => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(); };
    backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
    backdrop.querySelectorAll<HTMLButtonElement>('[data-setup-history-close]').forEach(button => button.addEventListener('click', close));
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
  }

  function wire(target: HTMLElement, snapshot: SetupSnapshot, permissions: SetupPermissions, rows: EffectiveSetupRow[], definition: SetupDefinition | null): void {
    target.querySelector<HTMLButtonElement>('[data-setup-copy-matrix]')?.addEventListener('click', () => navigator.clipboard?.writeText(csvFor(snapshot.plant, rows)).then(() => Toast.show(Util.t('toast.setup_copied'), 'success')).catch(() => Toast.show(Util.t('toast.clipboard_denied'), 'error')));
    target.querySelector<HTMLButtonElement>('[data-setup-export-matrix]')?.addEventListener('click', () => {
      const blob = new Blob([csvFor(snapshot.plant, rows)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `setup-matrix-${snapshot.plant}-${_lineScope || 'plant'}-v${snapshot.definition?.signature_version ?? 0}.csv`; link.click(); URL.revokeObjectURL(url);
    });
    target.querySelector<HTMLButtonElement>('[data-setup-review-clear]')?.addEventListener('click', () => {
      _missingReview = null;
      renderSnapshot(target, snapshot);
    });
    target.querySelector<HTMLButtonElement>('[data-setup-signature-edit]')?.addEventListener('click', () => {
      _signaturePopoverOpen = !_signaturePopoverOpen;
      renderSnapshot(target, snapshot);
    });
    target.querySelector<HTMLButtonElement>('[data-setup-menu-toggle]')?.addEventListener('click', () => {
      _setupMenuOpen = !_setupMenuOpen;
      renderSnapshot(target, snapshot);
    });
    target.querySelector<HTMLButtonElement>('[data-setup-history-open]')?.addEventListener('click', () => {
      _setupMenuOpen = false;
      renderSnapshot(target, snapshot);
      openHistoryModal(snapshot);
    });
    if (_signaturePopoverOpen || _setupMenuOpen) {
      const dismiss = (event: MouseEvent): void => {
        const withinPopover = (event.target as HTMLElement).closest('[data-setup-signature-popover], [data-setup-signature-edit]');
        const withinMenu = (event.target as HTMLElement).closest('[data-setup-menu-list], [data-setup-menu-toggle]');
        let changed = false;
        if (_signaturePopoverOpen && !withinPopover) { _signaturePopoverOpen = false; changed = true; }
        if (_setupMenuOpen && !withinMenu) { _setupMenuOpen = false; changed = true; }
        if (changed) { document.removeEventListener('mousedown', dismiss); renderSnapshot(target, snapshot); }
      };
      // Deferred one tick so the click that just opened the popover/menu
      // (still bubbling) doesn't immediately re-close it.
      window.setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
    }
    target.querySelector<HTMLButtonElement>('[data-setup-save-definition]')?.addEventListener('click', () => saveDefinition(target, snapshot));
    target.querySelector<HTMLButtonElement>('[data-setup-add-field]')?.addEventListener('click', () => {
      const holder = target.querySelector('[data-setup-field-order]'); if (!holder || holder.querySelectorAll('select').length >= _registeredFields.length) return;
      const index = holder.querySelectorAll('select').length;
      holder.insertAdjacentHTML('beforeend', `<div class="setup-field-row"><span>${index + 1}</span><select data-setup-field="${index}">${_registeredFields.map(option => `<option value="${option}">${option}</option>`).join('')}</select><button type="button" class="btn btn-ghost sm" data-setup-field-up="${index}" aria-label="${esc(Util.t('btn.setup_field_up'))}">&uarr;</button><button type="button" class="btn btn-ghost sm" data-setup-field-down="${index}" disabled aria-label="${esc(Util.t('btn.setup_field_down'))}">&darr;</button></div>`);
    });
    // Reorder-by-value-swap: the field-row DOM nodes never move (so their
    // up/down disabled state stays tied to fixed position), only the
    // selected value swaps with the adjacent row.
    target.querySelector<HTMLElement>('[data-setup-field-order]')?.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-setup-field-up], [data-setup-field-down]');
      if (!button) return;
      const holder = button.closest<HTMLElement>('[data-setup-field-order]')!;
      const fieldRows = Array.from(holder.querySelectorAll<HTMLElement>('.setup-field-row'));
      const currentIndex = fieldRows.indexOf(button.closest('.setup-field-row')!);
      const swapIndex = currentIndex + (button.hasAttribute('data-setup-field-up') ? -1 : 1);
      if (currentIndex < 0 || swapIndex < 0 || swapIndex >= fieldRows.length) return;
      const a = fieldRows[currentIndex].querySelector<HTMLSelectElement>('select')!;
      const b = fieldRows[swapIndex].querySelector<HTMLSelectElement>('select')!;
      const temp = a.value; a.value = b.value; b.value = temp;
    });
    target.querySelector<HTMLButtonElement>('[data-setup-missing-filter]')?.addEventListener('click', () => {
      // No endpoint enumerates which specific pairs are "reachable but
      // missing" (loadCoverage returns counts only) — this highlights the
      // grid's broader "missing in the definable standard" cells as the
      // closest available approximation, not a precise reachable-only set.
      const mount = target.querySelector<HTMLElement>('#setup-grid-table-mount'); if (!mount) return;
      mount.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const missingCells = mount.querySelectorAll<HTMLElement>('.setup-grid-td[data-missing="true"]');
      missingCells.forEach(td => td.classList.add('setup-grid-highlight'));
      window.setTimeout(() => missingCells.forEach(td => td.classList.remove('setup-grid-highlight')), 2000);
    });
    target.querySelector<HTMLInputElement>('[data-setup-grid-filter-from]')?.addEventListener('input', event => {
      _gridFilterFrom = (event.target as HTMLInputElement).value;
      paintGrid(target, snapshot, definition, rows, permissions);
    });
    target.querySelector<HTMLInputElement>('[data-setup-grid-filter-to]')?.addEventListener('input', event => {
      _gridFilterTo = (event.target as HTMLInputElement).value;
      paintGrid(target, snapshot, definition, rows, permissions);
    });
    target.querySelector<HTMLButtonElement>('[data-setup-grid-save]')?.addEventListener('click', () => saveGridEdits(target, snapshot, definition, rows, permissions));
    target.querySelector<HTMLButtonElement>('[data-setup-grid-discard]')?.addEventListener('click', () => {
      _gridDirty.clear();
      paintGrid(target, snapshot, definition, rows, permissions);
    });
    wireGridInteractions(target, snapshot, definition, rows, permissions);
    target.querySelector<HTMLInputElement>('[data-setup-import]')?.addEventListener('change', event => importMatrix(target, snapshot, event.target as HTMLInputElement));
    target.querySelector<HTMLButtonElement>('[data-setup-edit-state]')?.addEventListener('click', () => editState(target, snapshot));
    target.querySelector<HTMLInputElement>('[data-setup-active-toggle]')?.addEventListener('change', event => {
      setSetupActive(target, snapshot.plant, definition, (event.target as HTMLInputElement).checked);
    });
    if (_lineScope && permissions.definitionWrite) wireCompatibility(target, snapshot);
    wireGridEditor(target, snapshot, definition, rows, permissions);
  }

  /** (Re)paints only the grid's table mount — never the whole panel — so the
   *  filter input and save/discard bar (in the static shell `renderSnapshot`
   *  already rendered) never lose focus or get re-wired. Called after every
   *  cell edit, paste, filter keystroke, save, and discard. */
  function paintGrid(target: HTMLElement, snapshot: SetupSnapshot, definition: SetupDefinition | null, rows: EffectiveSetupRow[], permissions: SetupPermissions): void {
    const mount = target.querySelector<HTMLElement>('#setup-grid-table-mount');
    if (!mount) return;
    // §9-D: the action bar is always present now (not hidden until dirty), so
    // Import/Export/History always have a stable home — only the dirty count
    // text and the Save/Discard buttons' enabled state react to _gridDirty.
    const dirtyCount = target.querySelector<HTMLElement>('[data-setup-grid-dirty-count]');
    if (dirtyCount) dirtyCount.textContent = Util.t('ui.setup_grid_dirty_count', { count: _gridDirty.size });
    target.querySelector<HTMLButtonElement>('[data-setup-grid-discard]')?.toggleAttribute('disabled', _gridDirty.size === 0);
    target.querySelector<HTMLButtonElement>('[data-setup-grid-save]')?.toggleAttribute('disabled', _gridDirty.size === 0);
    const fields = definition?.fields?.length ? [...definition.fields] : [];
    if (!fields.length) {
      mount.innerHTML = emptyState(Util.t('ui.setup_no_definition'));
      _gridCellGrid = []; _gridModel = null;
      return;
    }
    const valuesByField: Record<string, string[]> = {};
    fields.forEach(field => { valuesByField[field] = fieldValueSet(Store.priorityRankMaps, field, _lineScope); });
    _gridModel = buildGridModel(fields, valuesByField, rows);
    if (!_gridModel.rowStates.length) {
      mount.innerHTML = emptyState(Util.t('ui.setup_grid_no_values'));
      _gridCellGrid = [];
      return;
    }
    // Missing-pairs review filter chip (§9 "what moves off the page"): when a
    // review is active, narrow both axes to only the states its pairs touch,
    // instead of rendering the review's own separate 4-column table.
    const review = _missingReview?.plant === snapshot.plant ? _missingReview : null;
    const reviewSigs = review
      ? new Set(review.pairs.flatMap(pair => [reviewStateSigFromText(pair.fromState), reviewStateSigFromText(pair.toState)]).filter((sig): sig is string => sig !== null))
      : null;
    const preFilterRowStates = reviewSigs ? _gridModel.rowStates.filter(s => reviewSigs.has(s.sig)) : _gridModel.rowStates;
    const preFilterColStates = reviewSigs ? _gridModel.colStates.filter(s => reviewSigs.has(s.sig)) : _gridModel.colStates;
    const rowAxis = capAxis(filterStates(preFilterRowStates, _gridFilterFrom), MAX_AXIS);
    const colAxis = capAxis(filterStates(preFilterColStates, _gridFilterTo), MAX_AXIS);
    const rowStates = rowAxis.states, colStates = colAxis.states;
    if (!rowStates.length || !colStates.length) {
      mount.innerHTML = emptyState(Util.t('ui.no_matches'));
      _gridCellGrid = [];
      return;
    }
    const axisCapNote = (rowAxis.truncated || colAxis.truncated)
      ? `<p class="setup-grid-cap-note">${esc(Util.t('ui.setup_grid_axis_capped', { shown: Math.max(rowStates.length, colStates.length), total: Math.max(rowAxis.total, colAxis.total) }))}</p>`
      : '';
    // "You are here" (§9-C.5): mark the row matching the scoped line's known
    // current state, making the old standalone Line Status panel unnecessary.
    const currentState = _lineScope && definition
      ? snapshot.line_states.find(s => s.line === _lineScope && s.signature_version === definition.signature_version)
      : undefined;
    const currentStateSig = currentState ? stateSig(currentState.state_key) : null;
    const tierCount = fields.length;
    const theadRows: string[] = [];
    for (let tier = 0; tier < tierCount; tier++) {
      const runs = tierRuns(colStates, tier);
      const corner = tier === 0 ? `<th rowspan="${tierCount}" colspan="${tierCount}" class="setup-grid-corner"></th>` : '';
      theadRows.push(`<tr>${corner}${runs.map(run => `<th colspan="${run.span}" class="setup-grid-col-head">${esc(run.value)}</th>`).join('')}</tr>`);
    }
    const rowSpanMaps = Array.from({ length: tierCount }, (_, tier) => {
      const map = new Map<number, number>();
      tierRuns(rowStates, tier).forEach(run => map.set(run.start, run.span));
      return map;
    });
    const bodyRows = rowStates.map((rowState, r) => {
      const youAreHere = currentStateSig !== null && rowState.sig === currentStateSig;
      const headerCells = Array.from({ length: tierCount }, (_, tier) => {
        const span = rowSpanMaps[tier].get(r);
        if (span === undefined) return '';
        const mark = youAreHere && tier === tierCount - 1 ? `<span class="setup-grid-here-badge" title="${esc(Util.t('ui.setup_you_are_here_hint', { line: _lineScope }))}">${esc(Util.t('ui.setup_you_are_here'))}</span>` : '';
        return `<th rowspan="${span}" scope="row" class="setup-grid-row-head">${esc(rowState.parts[tier] ?? '')}${mark}</th>`;
      }).join('');
      const dataCells = colStates.map((colState, c) => {
        const existing = _gridModel!.cellLookup.get(rowState.sig)?.get(colState.sig);
        const dirty = _gridDirty.get(gridEditKey(rowState, colState));
        const value = gridCellValue(rowState, colState, existing, dirty);
        const missing = value === null;
        const cellState = gridCellState(rowState, colState, existing, dirty, _lineScope);
        const cellClass = ['setup-grid-td', `setup-grid-${cellState}`, permissions.matrixWrite ? 'setup-grid-editable' : ''].filter(Boolean).join(' ');
        const display = cellState === 'uncovered' ? '&middot;' : (value !== null ? esc(String(value)) : '');
        const title = cellState === 'uncovered' ? Util.t('ui.setup_grid_uncovered_hint')
          : cellState === 'implicit-zero' ? Util.t('ui.setup_grid_implicit_zero_hint')
          : cellState === 'line-override' ? Util.t('ui.setup_grid_line_override_hint') : '';
        return `<td class="${cellClass}" data-setup-grid-row="${r}" data-setup-grid-col="${c}" data-missing="${missing}" ${permissions.matrixWrite ? 'tabindex="0"' : ''}${title ? ` title="${esc(title)}"` : ''}>${display}</td>`;
      }).join('');
      return `<tr${youAreHere ? ' class="setup-grid-here-row"' : ''}>${headerCells}${dataCells}</tr>`;
    }).join('');
    mount.innerHTML = `${axisCapNote}<div class="setup-grid-scroll"><table class="setup-table setup-grid"><thead>${theadRows.join('')}</thead><tbody>${bodyRows}</tbody></table></div>`;
    _gridCellGrid = rowStates.map((_row, r) => colStates.map((_col, c) => mount.querySelector<HTMLTableCellElement>(`td[data-setup-grid-row="${r}"][data-setup-grid-col="${c}"]`)));
    const mountData = mount as unknown as { _gridRowStates?: SetupGridState[]; _gridColStates?: SetupGridState[] };
    mountData._gridRowStates = rowStates;
    mountData._gridColStates = colStates;
    // Re-anchor the floating editor if it's still open on a cell that
    // survived this repaint (e.g. a filter keystroke); otherwise close it.
    if (_gridEditor) {
      const stillThere = rowStates.some(s => s.sig === _gridEditor!.row.sig) && colStates.some(s => s.sig === _gridEditor!.col.sig);
      if (stillThere) positionGridEditor(); else closeGridEditor(false);
    }
  }

  /** Lasso range-select, copy, delete, and Excel-paste on the grid — the same
   *  interaction model as LaborPlanning's Aggregate grid (see
   *  docs/setup_matrix_ui_redesign.md §5), adapted for the grid's row/col
   *  state axes instead of group/week axes. Wired once per `target` (the
   *  panel host persists across renderSnapshot() repaints; only its
   *  innerHTML is replaced), guarded by a dataset flag exactly like
   *  LaborPlanning's `grid._lpDragWired`. Edits are staged into `_gridDirty`,
   *  never written until an explicit Save. */
  function wireGridInteractions(target: HTMLElement, snapshot: SetupSnapshot, definition: SetupDefinition | null, rows: EffectiveSetupRow[], permissions: SetupPermissions): void {
    const flagged = target as unknown as { _setupGridWired?: boolean };
    if (flagged._setupGridWired) return;
    flagged._setupGridWired = true;

    const mount = (): HTMLElement | null => target.querySelector<HTMLElement>('#setup-grid-table-mount');
    const axesOf = (): { rowStates: SetupGridState[]; colStates: SetupGridState[] } => {
      const el = mount() as unknown as { _gridRowStates?: SetupGridState[]; _gridColStates?: SetupGridState[] } | null;
      return { rowStates: el?._gridRowStates || [], colStates: el?._gridColStates || [] };
    };

    function clearSelection(): void {
      _gridSelRange = null; _gridDragging = false; _gridDragAnchor = null;
      _gridSelTds.forEach(td => td.classList.remove('setup-grid-selected'));
      _gridSelTds.clear();
    }
    function paintSelection(): void {
      const next = new Set<HTMLTableCellElement>();
      if (_gridSelRange) {
        const { r0, c0, r1, c1 } = _gridSelRange;
        for (let r = r0; r <= r1; r++) { const row = _gridCellGrid[r]; if (!row) continue; for (let c = c0; c <= c1; c++) { const td = row[c]; if (td) next.add(td); } }
      }
      _gridSelTds.forEach(td => { if (!next.has(td)) td.classList.remove('setup-grid-selected'); });
      next.forEach(td => { if (!_gridSelTds.has(td)) td.classList.add('setup-grid-selected'); });
      _gridSelTds = next;
    }
    function cellAt(rowState: SetupGridState, colState: SetupGridState): { existing: EffectiveSetupRow | undefined; dirty: SetupGridEdit | undefined; baseline: number | null } {
      const existing = _gridModel?.cellLookup.get(rowState.sig)?.get(colState.sig);
      const dirty = _gridDirty.get(gridEditKey(rowState, colState));
      const baseline = existing ? existing.setup_min : (rowState.sig === colState.sig ? 0 : null);
      return { existing, dirty, baseline };
    }
    function stageEdit(rowState: SetupGridState, colState: SetupGridState, value: number | null): void {
      const { baseline } = cellAt(rowState, colState);
      const editKey = gridEditKey(rowState, colState);
      if (value === baseline) _gridDirty.delete(editKey);
      else _gridDirty.set(editKey, { row: rowState, col: colState, setup_min: value, line: _lineScope });
    }

    target.addEventListener('mousedown', event => {
      const mountEl = mount(); if (!mountEl || !mountEl.contains(event.target as Node)) return;
      if (!event.ctrlKey && !event.metaKey) { if (!(event.target as HTMLElement).closest('.setup-grid-selected')) clearSelection(); return; }
      const td = (event.target as HTMLElement).closest<HTMLTableCellElement>('td[data-setup-grid-row]'); if (!td) return;
      event.preventDefault();
      const r = Number(td.dataset.setupGridRow), c = Number(td.dataset.setupGridCol);
      _gridDragging = true; _gridDragAnchor = { row: r, col: c };
      _gridSelRange = { r0: r, c0: c, r1: r, c1: c }; paintSelection();
    });
    target.addEventListener('mousemove', event => {
      if (!_gridDragging || !_gridDragAnchor) return;
      const td = (event.target as HTMLElement).closest<HTMLTableCellElement>('td[data-setup-grid-row]'); if (!td) return;
      const r = Number(td.dataset.setupGridRow), c = Number(td.dataset.setupGridCol);
      _gridSelRange = { r0: Math.min(_gridDragAnchor.row, r), c0: Math.min(_gridDragAnchor.col, c), r1: Math.max(_gridDragAnchor.row, r), c1: Math.max(_gridDragAnchor.col, c) };
      paintSelection();
    });
    document.addEventListener('mouseup', () => { _gridDragging = false; });

    target.addEventListener('keydown', event => {
      const mountEl = mount(); if (!mountEl || !_gridSelRange) return;
      if (!mountEl.contains(document.activeElement) && !mountEl.contains(event.target as Node)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        const { rowStates, colStates } = axesOf();
        const { r0, c0, r1, c1 } = _gridSelRange;
        const lines: string[] = [];
        for (let r = r0; r <= r1; r++) {
          const cols: string[] = [];
          for (let c = c0; c <= c1; c++) {
            const rowState = rowStates[r], colState = colStates[c];
            const value = rowState && colState ? gridCellValue(rowState, colState, cellAt(rowState, colState).existing, cellAt(rowState, colState).dirty) : null;
            cols.push(value !== null ? String(value) : '');
          }
          lines.push(cols.join('\t'));
        }
        navigator.clipboard?.writeText(lines.join('\n')).then(() => Toast.show(Util.t('toast.setup_copied'), 'success')).catch(() => Toast.show(Util.t('toast.clipboard_denied'), 'error'));
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && permissions.matrixWrite) {
        const { rowStates, colStates } = axesOf();
        const { r0, c0, r1, c1 } = _gridSelRange;
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          const rowState = rowStates[r], colState = colStates[c]; if (!rowState || !colState) continue;
          stageEdit(rowState, colState, null);
        }
        paintGrid(target, snapshot, definition, rows, permissions);
      }
    });

    target.addEventListener('paste', event => {
      if (!permissions.matrixWrite) return;
      const anchorTd = (document.activeElement as HTMLElement | null)?.closest<HTMLTableCellElement>('td[data-setup-grid-row]');
      if (!anchorTd) return;
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain'); if (!text) return;
      const clipRows = text.replace(/\r/g, '').split('\n').filter(r => r !== '').map(r => r.split('\t'));
      const { rowStates, colStates } = axesOf();
      const anchorRow = Number(anchorTd.dataset.setupGridRow), anchorCol = Number(anchorTd.dataset.setupGridCol);
      let changed = 0, rejected = 0;
      clipRows.forEach((cols, r) => cols.forEach((raw, c) => {
        const rowState = rowStates[anchorRow + r], colState = colStates[anchorCol + c]; if (!rowState || !colState) return;
        const parsed = parseGridMinutes(raw);
        if (parsed === 'invalid') { rejected++; return; }
        stageEdit(rowState, colState, parsed);
        changed++;
      }));
      if (changed) { Toast.show(Util.t('ui.setup_grid_pasted', { count: changed }), 'success'); paintGrid(target, snapshot, definition, rows, permissions); }
      if (rejected) Toast.show(Util.t('ui.setup_grid_paste_rejected', { count: rejected }), 'warn');
    });
  }

  /** Single floating `<input>` shared across every SetupAdmin render, created
   *  once and repositioned over whichever cell is being edited (§7/§9-C.3) —
   *  replaces the old one-`<input>`-per-cell rendering. Its keydown/blur
   *  listeners are wired exactly once here (never per-render, unlike
   *  `wireGridInteractions`/`wireGridEditor` below) so they always act on
   *  `_gridEditorCtx`, refreshed on every `openGridEditor` call, rather than a
   *  stale closure from whichever render first wired them. */
  function ensureGridEditorEl(): HTMLInputElement {
    let el = document.getElementById('setup-grid-editor-input') as (HTMLInputElement & { _setupWired?: boolean }) | null;
    if (!el) {
      el = document.createElement('input') as HTMLInputElement & { _setupWired?: boolean };
      el.type = 'number'; el.id = 'setup-grid-editor-input'; el.className = 'setup-grid-editor-input';
      el.min = '0'; el.max = '10080'; el.step = '1'; el.inputMode = 'numeric';
      el.hidden = true;
      document.body.appendChild(el);
    }
    if (!el._setupWired) {
      el._setupWired = true;
      el.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); closeGridEditor(true, true); }
        else if (event.key === 'Escape') { event.preventDefault(); closeGridEditor(false); }
      });
      el.addEventListener('blur', () => { if (_gridEditor) closeGridEditor(true); });
    }
    return el;
  }

  /** Resolves `_gridEditor`'s row/col back to the live `<td>` via the grid
   *  mount's current axis arrays (not `_gridCellGrid` directly, since a
   *  row/col's index can shift between repaints — e.g. a filter keystroke). */
  function gridEditorTd(): HTMLTableCellElement | null {
    if (!_gridEditor || !_gridEditorCtx) return null;
    const mount = _gridEditorCtx.target.querySelector<HTMLElement>('#setup-grid-table-mount');
    const data = mount as unknown as { _gridRowStates?: SetupGridState[]; _gridColStates?: SetupGridState[] } | null;
    const r = data?._gridRowStates?.findIndex(s => s.sig === _gridEditor!.row.sig) ?? -1;
    const c = data?._gridColStates?.findIndex(s => s.sig === _gridEditor!.col.sig) ?? -1;
    if (r < 0 || c < 0 || !mount) return null;
    return mount.querySelector<HTMLTableCellElement>(`td[data-setup-grid-row="${r}"][data-setup-grid-col="${c}"]`);
  }

  function positionGridEditor(): void {
    const el = ensureGridEditorEl();
    const td = gridEditorTd();
    if (!td) { el.hidden = true; return; }
    const rect = td.getBoundingClientRect();
    el.style.position = 'fixed';
    el.style.left = `${rect.left}px`; el.style.top = `${rect.top}px`;
    el.style.width = `${rect.width}px`; el.style.height = `${rect.height}px`;
    el.hidden = false;
  }

  function openGridEditor(target: HTMLElement, snapshot: SetupSnapshot, definition: SetupDefinition | null, rows: EffectiveSetupRow[], permissions: SetupPermissions, row: SetupGridState, col: SetupGridState): void {
    if (!permissions.matrixWrite) return;
    if (_gridEditor && (_gridEditor.row.sig !== row.sig || _gridEditor.col.sig !== col.sig)) closeGridEditor(true);
    _gridEditorCtx = { target, snapshot, definition, rows, permissions };
    _gridEditor = { row, col };
    const existing = _gridModel?.cellLookup.get(row.sig)?.get(col.sig);
    const dirty = _gridDirty.get(gridEditKey(row, col));
    const value = gridCellValue(row, col, existing, dirty);
    const el = ensureGridEditorEl();
    el.value = value !== null ? String(value) : '';
    positionGridEditor();
    el.focus(); el.select();
  }

  /** `commit`: stage the typed value into `_gridDirty` and repaint (Enter/blur).
   *  `advanceRow`: after committing, open the editor on the next row in the
   *  same column — the closest analog to spreadsheet Enter-to-advance, since
   *  cells no longer have their own persistent `<input>` to Tab between. */
  function closeGridEditor(commit: boolean, advanceRow = false): void {
    if (!_gridEditor || !_gridEditorCtx) return;
    const { row, col } = _gridEditor;
    const { target, snapshot, definition, rows, permissions } = _gridEditorCtx;
    const el = ensureGridEditorEl();
    _gridEditor = null;
    el.hidden = true;
    if (!commit) return;
    const parsed = parseGridMinutes(el.value);
    if (parsed === 'invalid') { Toast.show(Util.t('ui.setup_grid_invalid_minutes'), 'error'); return; }
    const existing = _gridModel?.cellLookup.get(row.sig)?.get(col.sig);
    const baseline = existing ? existing.setup_min : (row.sig === col.sig ? 0 : null);
    const editKey = gridEditKey(row, col);
    if (parsed === baseline) _gridDirty.delete(editKey);
    else _gridDirty.set(editKey, { row, col, setup_min: parsed, line: _lineScope });
    paintGrid(target, snapshot, definition, rows, permissions);
    if (advanceRow) {
      const mount = target.querySelector<HTMLElement>('#setup-grid-table-mount');
      const data = mount as unknown as { _gridRowStates?: SetupGridState[] } | null;
      const rowStates = data?._gridRowStates || [];
      const nextRow = rowStates[rowStates.findIndex(s => s.sig === row.sig) + 1];
      if (nextRow) openGridEditor(target, snapshot, definition, rows, permissions, nextRow, col);
    }
  }

  /** Click-to-open wiring for the floating editor — guarded per-`target` like
   *  `wireGridInteractions`, since (unlike the editor element's own listeners
   *  above) this needs the current render's `snapshot`/`rows`/`permissions`. */
  function wireGridEditor(target: HTMLElement, snapshot: SetupSnapshot, definition: SetupDefinition | null, rows: EffectiveSetupRow[], permissions: SetupPermissions): void {
    const flagged = target as unknown as { _setupGridEditorWired?: boolean };
    if (flagged._setupGridEditorWired) return;
    flagged._setupGridEditorWired = true;
    target.addEventListener('click', event => {
      if (!permissions.matrixWrite || event.ctrlKey || event.metaKey) return; // ctrl/cmd-click is lasso mode
      const mountEl = target.querySelector<HTMLElement>('#setup-grid-table-mount');
      if (!mountEl || !mountEl.contains(event.target as Node)) return;
      const td = (event.target as HTMLElement).closest<HTMLTableCellElement>('td.setup-grid-editable[data-setup-grid-row]');
      if (!td) return;
      const data = mountEl as unknown as { _gridRowStates?: SetupGridState[]; _gridColStates?: SetupGridState[] };
      const r = Number(td.dataset.setupGridRow), c = Number(td.dataset.setupGridCol);
      const row = data._gridRowStates?.[r], col = data._gridColStates?.[c];
      if (row && col) openGridEditor(target, snapshot, definition, rows, permissions, row, col);
    });
  }

  async function saveGridEdits(target: HTMLElement, snapshot: SetupSnapshot, definition: SetupDefinition | null, rows: EffectiveSetupRow[], permissions: SetupPermissions): Promise<void> {
    if (!definition || !_gridDirty.size) return;
    const edits = [..._gridDirty.values()];
    const existingPlantRows = snapshot.plant_rows.filter(row => row.signature_version === definition.signature_version);
    const { upsert, deletes } = buildSaveRequests(edits, definition.signature_version, existingPlantRows);
    try {
      for (const body of upsert) {
        const response = await Util.fetchTraced(`${API}/setup/${encodeURIComponent(snapshot.plant)}/matrix/import`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
        if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(err.detail || `HTTP ${response.status}`); }
      }
      for (const body of deletes) {
        const response = await Util.fetchTraced(`${API}/setup/${encodeURIComponent(snapshot.plant)}/matrix`, { method: 'DELETE', headers: headers(), body: JSON.stringify(body) });
        if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(err.detail || `HTTP ${response.status}`); }
      }
      Persistence.noteSetupWrite(snapshot.plant, 'matrix');
      _gridDirty.clear();
      await Persistence.loadSetupSnapshot(snapshot.plant);
      render(target, snapshot.plant);
      Toast.show(Util.t('toast.setup_saved'), 'success');
    } catch (error) {
      Toast.show(Util.t('toast.save_failed', { msg: (error as Error).message }), 'error');
    }
  }

  async function setSetupActive(target: HTMLElement, plant: string, definition: SetupDefinition | null, active: boolean): Promise<void> {
    if (!definition) return;
    await writeAndRefresh(target, plant, `${API}/setup/${encodeURIComponent(plant)}/active`, 'PUT', {
      active, expected_signature_version: definition.signature_version,
    });
  }

  async function saveDefinition(target: HTMLElement, snapshot: SetupSnapshot): Promise<void> {
    const fields = Array.from(target.querySelectorAll<HTMLSelectElement>('[data-setup-field]')).map(select => select.value);
    const strict = target.querySelector<HTMLInputElement>('[data-setup-strict]')?.checked ?? true;
    if (!fields.length || new Set(fields).size !== fields.length) { Toast.show(Util.t('ui.setup_fields_unique'), 'error'); return; }
    _signaturePopoverOpen = false;
    await writeAndRefresh(target, snapshot.plant, `${API}/setup/${encodeURIComponent(snapshot.plant)}/definition`, 'PUT', { fields, strict_blanks: strict, expected_signature_version: snapshot.definition?.signature_version ?? null });
  }

  async function importMatrix(target: HTMLElement, snapshot: SetupSnapshot, input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0]; if (!file) return;
    try {
      const parsed = parseLongFormCsv(await file.text());
      if (parsed.plant !== snapshot.plant || !canWriteVersion(parsed.signature_version, snapshot.definition?.signature_version)) throw new Error(Util.t('ui.setup_version_mismatch'));
      if (parsed.line !== _lineScope) throw new Error('CSV line scope must match the selected setup scope');
      // Plant-default scope is a destructive delete-then-insert replace
      // (setup_data.replace_plant_matrix) — unlike a line-scoped import, which
      // is a safe sparse upsert — so confirm before an admin silently wipes
      // every other plant-default row for this signature version.
      if (!parsed.line) {
        const existingCount = snapshot.plant_rows.filter(row => row.signature_version === parsed.signature_version).length;
        const confirmed = await Modal.confirm({
          title: Util.t('ui.setup_replace_confirm_title'),
          message: Util.t('ui.setup_replace_confirm_msg', { existing: existingCount, incoming: parsed.rows.length }),
          confirmLabel: Util.t('btn.setup_replace_confirm'),
          tone: 'warn',
        });
        if (!confirmed) return;
      }
      await writeAndRefresh(target, snapshot.plant, `${API}/setup/${encodeURIComponent(snapshot.plant)}/matrix/import`, 'POST', {
        line: parsed.line, signature_version: parsed.signature_version, rows: parsed.rows,
      });
    } catch (error) { Toast.show(Util.t('toast.save_failed', { msg: (error as Error).message }), 'error'); }
    finally { input.value = ''; }
  }

  async function editState(target: HTMLElement, snapshot: SetupSnapshot): Promise<void> {
    const definition = snapshot.definition; if (!_lineScope || !definition) return;
    const current = snapshot.line_states.find(state => state.line === _lineScope);
    const panel = target.querySelector('.setup-state .panel-body'); if (!panel || panel.querySelector('[data-setup-state-editor]')) return;
    const initial = new Map((current?.state_key || []).map(pair => [pair.fieldKey, pair.value]));
    const editor = document.createElement('div'); editor.className = 'setup-state-editor'; editor.dataset.setupStateEditor = 'true';
    editor.innerHTML = `${definition.fields.map(field => `<label>${esc(field)}<input class="input" data-setup-state-field="${esc(field)}" value="${esc(initial.get(field) || '')}"></label>`).join('')}<label>${esc(Util.t('ui.setup_observed_at'))}<input class="input" data-setup-observed-at></label><button class="btn btn-primary sm" data-setup-save-state>${esc(Util.t('btn.save'))}</button>`;
    panel.appendChild(editor);
    const observed = editor.querySelector<HTMLInputElement>('[data-setup-observed-at]')!;
    const fp = Util.fpDatetime(observed); fp.setDate(new Date(), false);
    editor.querySelector<HTMLButtonElement>('[data-setup-save-state]')!.addEventListener('click', async () => {
      const values = definition.fields.map(field => ({ fieldKey: field, value: editor.querySelector<HTMLInputElement>(`[data-setup-state-field="${CSS.escape(field)}"]`)?.value.trim() || '' }));
      if (values.some(pair => !pair.value)) { Toast.show(Util.t('ui.setup_state_fields_required'), 'error'); return; }
      fp.destroy();
      await writeAndRefresh(target, snapshot.plant, `${API}/setup/${encodeURIComponent(snapshot.plant)}/lines/${encodeURIComponent(_lineScope)}/state`, 'PUT', { values, signature_version: definition.signature_version, observed_at: observed.value, source: 'manual', reason: Util.t('ui.setup_state_manual_reason') });
    });
  }

  async function wireCompatibility(target: HTMLElement, snapshot: SetupSnapshot): Promise<void> {
    const cacheKey = `${snapshot.plant}\u0000${_lineScope}`;
    const saved = _compatibilityByLine[cacheKey];
    const compatible = saved?.setup_compatible !== false;
    const statePanel = target.querySelector('.setup-state .panel-body');
    if (!statePanel) return;
    const compat = document.createElement('div'); compat.className = 'setup-compatibility';
    compat.innerHTML = `<label class="setup-check"><input type="checkbox" data-setup-compatible ${compatible ? 'checked' : ''}>${esc(Util.t('ui.setup_compatibility'))}</label><input class="input" data-setup-compatibility-reason placeholder="${esc(Util.t('ui.setup_compatibility_reason'))}" value="${esc(saved?.setup_compatibility_reason || '')}" ${compatible ? 'disabled' : ''}><button class="btn btn-ghost sm" data-setup-save-compatibility ${compatible ? 'disabled' : ''}>${esc(Util.t('btn.save'))}</button><p>${esc(Util.t('ui.setup_not_global_exclusion'))}</p>`;
    statePanel.appendChild(compat);
    const checkbox = compat.querySelector<HTMLInputElement>('[data-setup-compatible]')!;
    const reason = compat.querySelector<HTMLInputElement>('[data-setup-compatibility-reason]')!;
    const save = compat.querySelector<HTMLButtonElement>('[data-setup-save-compatibility]')!;
    const persist = async () => {
      if (!checkbox.checked && !reason.value.trim()) { reason.disabled = false; reason.focus(); Toast.show(Util.t('ui.setup_reason_required'), 'error'); return; }
      reason.disabled = checkbox.checked;
      try {
        const response = await Util.fetchTraced(`${API}/setup/${encodeURIComponent(snapshot.plant)}/lines/${encodeURIComponent(_lineScope)}/compatibility`, { method: 'PUT', headers: headers(), body: JSON.stringify({ setup_compatible: checkbox.checked, reason: reason.value.trim() }) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        Persistence.noteSetupWrite(snapshot.plant, 'override');
        _compatibilityByLine[cacheKey] = { setup_compatible: checkbox.checked, setup_compatibility_reason: checkbox.checked ? null : reason.value.trim() }; Toast.show(Util.t('toast.line_settings_updated'), 'success');
      } catch (error) { checkbox.checked = compatible; reason.disabled = compatible; Toast.show(Util.t('toast.save_failed', { msg: (error as Error).message }), 'error'); }
    };
    checkbox.addEventListener('change', () => { reason.disabled = checkbox.checked; save.disabled = checkbox.checked; if (!checkbox.checked) reason.focus(); });
    save.addEventListener('click', persist);
  }

  async function writeAndRefresh(target: HTMLElement, plant: string, url: string, method: string, body: unknown): Promise<void> {
    try {
      const response = await Util.fetchTraced(url, { method, headers: headers(), body: JSON.stringify(body) });
      if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(err.detail || `HTTP ${response.status}`); }
      Persistence.noteSetupWrite(plant, setupWriteKind(url));
      await Persistence.loadSetupSnapshot(plant); render(target, plant); Toast.show(Util.t('toast.setup_saved'), 'success');
    } catch (error) { Toast.show(Util.t('toast.save_failed', { msg: (error as Error).message }), 'error'); }
  }

  return { permissionsFor, canWriteVersion, activationStatus, effectiveRows, deleteRequest, csvColumns, missingPairsCsv, reviewAction, canReviewMissingPairs, reviewNavigation, reviewMissingPairs, registeredFields, parseLongFormCsv, collectPagedLines, render,
    // Grid helpers — exported for direct unit testing, matching this file's
    // existing pattern of testing pure logic without a DOM harness.
    stateSig, fieldValueSet, cartesianStates, buildGridModel, filterStates, tierRuns, gridCellValue, gridCellState, capAxis, parseGridMinutes, buildSaveRequests, fieldLabel, reviewStateSigFromText };
})();

/* =============================================================================
   CALENDAR UI — blackout-block-tab UI remnant.
   CQ-1 Phase 2 Task 1 moved the capacity-math half of the old `Calendar`
   object (workWindow, dailyCapacityHours, effectiveFromCapacity,
   effectiveCapacityHours, isAvailable, nextAvailable, and the private
   _beginRun/_endRun/_indexBlocks/_dayWindow/_indexCapacityBlocks/
   _overlapsBlock helpers) into schedule-services.mjs, where it is imported
   below as `Calendar` (see the bridge destructure at the top of this IIFE).
   Only the calendar tab's render/blackout-block UI stayed here, renamed
   from `Calendar` to `CalendarUI` (verbatim bodies) so the bare name
   `Calendar` is free for the imported capacity-math module.
   ========================================================================== */
export const CalendarUI = {
  _lineFilter: 'all',
  _blockFilter: 'all',
  _fpBlkStart: null as NimbusVendor.FlatpickrInstance | null,
  _fpBlkEnd: null as NimbusVendor.FlatpickrInstance | null,

  render(): void {
    const body = document.getElementById('cal-hours-body');
    if (!body) return;
    const lines = CalendarUI._getLines();
    lines.forEach(l => Store.ensureCalendar(l));

    const sel = CalendarUI._lineFilter || 'all';
    const shownLines = sel === 'all' ? lines : lines.filter(l => l === sel);

    const dayLabels = ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => Util.t(k));

    let html = `<div class="cal-filter-bar">
      <label class="cal-filter-label">${Util.t('ui.cal_filter_line')}</label>
      <select class="cal-filter-select" id="cal-line-select">
        <option value="all"${sel === 'all' ? ' selected' : ''}>${Util.t('ui.all_lines_count', {count: lines.length})}</option>
        ${lines.map(l => `<option value="${l}"${sel === l ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
      ${sel !== 'all' ? `<button class="cal-filter-clear" onclick="NIMBUS.CalendarUI._clearLineFilter()">${Util.t('btn.show_all')}</button>` : ''}
    </div>`;

    html += `<div class="hours-tbl-wrap"><table class="hours-tbl">
      <thead><tr>
        <th class="col-head">${Util.t('ui.line_label')}</th>
        ${dayLabels.map(d => `<th class="col-head">${d}</th>`).join('')}
      </tr></thead>
      <tbody>`;

    shownLines.forEach((line) => {
      const li = lines.indexOf(line);
      const color = Config.COLORS[li % Config.COLORS.length];
      const cal = Store.calendars[line].workHours;
      html += `<tr>
        <td><div class="line-label"><span class="line-dot" style="background:${color}"></span>${line}</div></td>`;
      for (let d = 0; d < 7; d++) {
        const wh = cal[d];
        const off = !wh;
        html += `<td><div class="hours-cell ${off ? 'off':''}" data-line="${line}" data-day="${d}">
          <input type="text" class="hours-start" value="${off ? '' : Util.hoursToTimeString(wh![0])}">
          <span class="dash">–</span>
          <input type="text" class="hours-end" value="${off ? '' : Util.hoursToTimeString(wh![1])}">
        </div></td>`;
      }
      html += `</tr>`;
    });
    html += `</tbody></table></div>`;

    body.innerHTML = html;

    // Wire line selector
    const lineSelectEl = document.getElementById('cal-line-select') as HTMLSelectElement;
    lineSelectEl.onchange = () => {
      CalendarUI._lineFilter = lineSelectEl.value;
      CalendarUI.render();
    };

    // Wire up inputs
    body.querySelectorAll<HTMLElement>('.hours-cell').forEach(cell => {
      const line = cell.dataset.line!;
      const day  = +cell.dataset.day!;
      const inS  = cell.querySelector<HTMLInputElement>('.hours-start')!;
      const inE  = cell.querySelector<HTMLInputElement>('.hours-end')!;
      const upd = () => {
        const vs = inS.value, ve = inE.value;
        const cal = Store.calendars[line].workHours;
        if (!vs || !ve) { cal[day] = null; cell.classList.add('off'); }
        else {
          cal[day] = [Util.timeStringToHours(vs), Util.timeStringToHours(ve)];
          cell.classList.remove('off');
        }
        Store.emit({ type: 'calendar:change', line, source: 'calendar' });
        Toast.show(Util.t('toast.calendar_updated'), 'success');
      };
      flatpickr(inS, { enableTime: true, noCalendar: true, dateFormat: 'H:i', altInput: true, altFormat: 'h:i K', onChange: upd });
      flatpickr(inE, { enableTime: true, noCalendar: true, dateFormat: 'H:i', altInput: true, altFormat: 'h:i K', onChange: upd });
    });

    CalendarUI._renderBlocks();
  },

  _clearLineFilter(): void {
    CalendarUI._lineFilter = 'all';
    CalendarUI.render();
  },

  _renderBlocks(): void {
    const list = document.getElementById('cal-blocks-list');
    if (!list) return;
    const lines     = CalendarUI._getLines();
    const bFilter   = CalendarUI._blockFilter || 'all';
    const allBlocks = Store.blocks.slice().sort((a,b) => (Util.parseDate(a.start)?.getTime() || 0) - (Util.parseDate(b.start)?.getTime() || 0));
    const blocks    = bFilter === 'all' ? allBlocks : allBlocks.filter(b => !b.line || b.line === bFilter);

    let html = `<div class="cal-filter-bar">
      <label class="cal-filter-label">${Util.t('ui.filter_label')}</label>
      <select class="cal-filter-select" id="cal-block-filter">
        <option value="all"${bFilter === 'all' ? ' selected' : ''}>${Util.t('ui.all_lines_filter')}</option>
        ${lines.map(l => `<option value="${l}"${bFilter === l ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
      <span class="cal-block-count">${Util.t('ui.blocks_count', {count: blocks.length, plural: blocks.length !== 1 ? 's' : ''})}</span>
    </div>`;

    if (!blocks.length) {
      html += `<div class="empty-state">${bFilter !== 'all' ? Util.t('empty.no_blocks_for_line') : Util.t('empty.no_blackouts_line')}</div>`;
    } else {
      html += blocks.map(b => `
        <div class="block-row" style="padding-left:6px;padding-right:6px;">
          <span class="ico">■</span>
          <span class="reason">${b.reason || Util.t('ui.blackouts_label', {plural: ''})}</span>
          <span class="line-tag">${b.line || Util.t('ui.all_lines_filter')}</span>
          <span class="range" title="${Util.fmtDTReadable(b.start)} → ${Util.fmtDTReadable(b.end)}">${Util.fmtBlockRange(b.start, b.end)}</span>
          <button class="btn btn-ghost sm" style="padding:2px 7px;font-size:14px;" title="${Util.t('tip.remove_block')}" onclick="NIMBUS.CalendarUI.removeBlock('${b.id}')">×</button>
        </div>
      `).join('');
    }

    list.innerHTML = html;

    const blockSelect = document.getElementById('cal-block-filter') as HTMLSelectElement | null;
    if (blockSelect) blockSelect.onchange = () => {
      CalendarUI._blockFilter = blockSelect.value;
      CalendarUI._renderBlocks();
    };
  },

  removeBlock(id: string): void {
    const blk = Store.blocks.find(b => b.id === id);
    const plant = blk?.plant || Store.selectedPlant;
    Store.removeBlock(id, 'calendar');
    if (plant) CalendarSync.saveLineBlackoutDelete(plant, id);
    Toast.show(Util.t('toast.block_removed'), 'success');
  },

  openBlockModal(): void {
    const lineSel = document.getElementById('blk-line') as HTMLSelectElement | null;
    if (!lineSel) { ErrorLog.error('ui', 'required DOM element missing: blk-line'); return; }
    const reasonEl = document.getElementById('blk-reason') as HTMLInputElement | null;
    if (!reasonEl) { ErrorLog.error('ui', 'required DOM element missing: blk-reason'); return; }

    lineSel.innerHTML = `<option value="">${Util.t('ui.all_lines_filter')}</option>` +
      CalendarUI._getLines().map(l => `<option value="${l}">${l}</option>`).join('');

    const now = new Date(); now.setMinutes(0, 0, 0);
    const plus1 = new Date(now.getTime() + Config.MS_HOUR);
    if (!CalendarUI._fpBlkStart) {
      CalendarUI._fpBlkStart = Util.fpDatetime('#blk-start');
      CalendarUI._fpBlkEnd   = Util.fpDatetime('#blk-end');
    }
    CalendarUI._fpBlkStart!.setDate(now, false);
    CalendarUI._fpBlkEnd!.setDate(plus1, false);
    reasonEl.value = '';
    Modal.open('modal-block');
  },

  saveBlockFromModal(): void {
    const line   = (document.getElementById('blk-line') as HTMLSelectElement).value || null;
    const start  = Util.parseDate((document.getElementById('blk-start') as HTMLInputElement).value);
    const end    = Util.parseDate((document.getElementById('blk-end') as HTMLInputElement).value);
    const reason = (document.getElementById('blk-reason') as HTMLInputElement).value.trim() || Util.t('ui.blackouts_label', {plural: ''});
    if (!start || !end) { Toast.show(Util.t('toast.please_set_start_end'), 'error'); return; }
    if (end <= start)   { Toast.show(Util.t('toast.end_must_be_after_start'), 'error'); return; }
    // Stamp the block's plant so it persists/scopes per-plant (line:null = all
    // lines in this plant). Requires a plant context.
    const plant = (line ? Store.getPlantForLine(line) : null) || Store.selectedPlant;
    if (!plant) { Toast.show(Util.t('toast.select_plant_first'), 'warn'); return; }
    const before = Store.blocks.length;
    Store.addBlock({ line, plant, start, end, reason } as NimbusBlock, 'calendar');
    if (Store.blocks.length > before) CalendarSync.saveLineBlackoutUpsert(Store.blocks[Store.blocks.length - 1]);
    Modal.close('modal-block');
    Toast.show(Util.t('toast.block_added'), 'success');
  },

  _getLines(): string[] {
    if (Store.selectedPlant) return Store.linesForSelectedPlant();
    // No plant selected yet (e.g. blackout modal opened before plant pick) —
    // fall back to the unscoped view rather than showing nothing.
    const set = new Set<string>();
    Store.tasksArr.forEach(t => set.add(t.PRODUCTION_LINE || 'Unknown'));
    Object.keys(Store.calendars).forEach(l => set.add(l));
    return [...set].sort();
  },
};

/* =============================================================================
   PLANT — plant-level calendar UI (working hours, blackouts, lines roster).
   ========================================================================== */
/** One `Plant._pillFps` entry — the two Flatpickr instances backing a single
 *  day's start/end time inputs in the plant working-hours pill row. */
interface PillFpPair {
  start: NimbusVendor.FlatpickrInstance | null;
  end: NimbusVendor.FlatpickrInstance | null;
}

// `interface ConstraintState` lived here until Stage 3 (docs/scheduling_priority.md)
// rebuilt `Plant._renderSettingsPane`'s flat constraint list into a nested
// priority tree. Its working copy is now a `ConstraintConfig[]` (web/types.mts)
// straight through — the shape that carries `children` — so a save can no
// longer flatten a stored tree on its way back to the backend.

export const Plant = {
  _blocksCollapsed: true,
  _rosterCollapsed: true,
  _priorityFields: [] as PriorityFieldMeta[],
  _priorityLists: {} as Record<string, PriorityListFieldSummary>,
  _missingMasterData: null as MissingMasterDataReport | null,
  // Tracked SEPARATELY from _missingMasterData's content, because
  // `_missingMasterData === null` alone cannot distinguish "the exception
  // report failed to load" from "the report loaded and there are zero
  // exceptions" — and the panel renders nothing at all in the zero case, so a
  // silently-failed fetch would read to an admin as a clean bill of health.
  _missingDataOk: false,
  // Non-null when the last Optimization-tab load failed — surfaced as an
  // inline banner so a 403/timeout/500 can't present as an empty tab with no
  // dropzones and no explanation.
  _priorityLoadError: null as string | null,
  _currentPlantTab: 'general',
  // System Settings' inner tab strip (docs/setup_matrix_ui_redesign.md §3.1)
  // — separate from _currentPlantTab, which is the outer General/Optimization/
  // System Settings strip. Defaults to 'rules' so the four simple numeric/
  // dropdown settings are what a visitor sees first, not the Setup Matrix
  // console.
  _currentSettingsSubTab: 'rules' as 'rules' | 'setup',
  _pillFps: null as PillFpPair[] | null,
  _fpBlkStart: null as NimbusVendor.FlatpickrInstance | null,
  _fpBlkEnd: null as NimbusVendor.FlatpickrInstance | null,

  _settingsSubTabVisibility(subTab: 'rules' | 'setup'): { rules: boolean; setup: boolean } {
    return { rules: subTab === 'rules', setup: subTab === 'setup' };
  },

  init(): void {
    Store.subscribe(evt => {
      if (evt.type === 'plant:selected') {
        const onPlantSub = _activeTabResolvers.currentTab() === 'masterdata'
          && _activeTabResolvers.currentMasterSub() === 'plant';
        if (onPlantSub) {
          Plant.render();
        }
        // Update plant badge in header whenever selection changes
        const badge = document.querySelector('#md-master-plant-pane .plant-badge');
        if (badge) badge.textContent = Store.selectedPlant || '—';
      }
    }, 'Plant');
    Plant._wireStaticHandlers();
  },

  // Converts the static index.html onclick= attributes owned by CalendarUI/
  // Plant/ProdLines to real listeners (CQ-1 Phase 4 Task 1, following the
  // Phase 3 `Interaction._showMultiInspector` precedent). Called once from
  // init() — these are all always-present static elements (tab strip, "+ Add"
  // buttons, modal Save buttons), not re-rendered via innerHTML, so a single
  // boot-time wiring is sufficient. CalendarUI and ProdLines have no init()
  // of their own (ProdLines renders on-demand; CalendarUI's Interfaces list
  // has no init at all), so Plant's is the single boot-time entry point for
  // this whole family's static markup. The modals' "Cancel" buttons
  // (`NIMBUS.Modal.close(...)`) are out of this task's scope — `Modal` is not
  // a module this task moves — and stay as inline onclick attributes.
  _wireStaticHandlers(): void {
    document.querySelectorAll<HTMLElement>('.plant-inner-tabs .sub-subtab[data-plant-tab]').forEach(btn => {
      btn.addEventListener('click', () => Plant.gotoTab(btn.dataset.plantTab));
    });
    document.getElementById('plant-add-block-btn')?.addEventListener('click', () => Plant.openBlockModal());
    document.getElementById('plant-roster-toggle')?.addEventListener('click', () => Plant.toggleRosterList());
    document.getElementById('modal-block-save-btn')?.addEventListener('click', () => CalendarUI.saveBlockFromModal());
    document.getElementById('modal-plant-block-save-btn')?.addEventListener('click', () => Plant.savePlantBlockFromModal());
    document.getElementById('modal-lines-block-save-btn')?.addEventListener('click', () => ProdLines.saveBlockFromModal());

    // Stage 2's two new modals (#modal-priority-mapping, #modal-priority-viewer)
    // were added with inline onclick=/oninput= attributes copied from an older
    // modal's style, which moved CLAUDE.md's tracked static-inline-handler count
    // (the precisely-quantified blocker to switching index.html's CSP meta tag
    // from Report-Only to enforcing) the wrong way, and broke the
    // cq1-legacy-surface contract snapshot. Wired here instead, same pattern as
    // everything above. Both modals are always-present static markup, so a
    // single boot-time wiring is sufficient. `PriorityListViewer` lives in
    // schedule-workbench.mjs and is already imported at the top of this file;
    // `PriorityListMapping` is defined below in this same module.
    const mapModal = document.getElementById('modal-priority-mapping');
    // Backdrop click, target-guarded exactly as the inline handler was — only a
    // click on the backdrop itself dismisses, never one that bubbled up from the
    // dialog's own content.
    mapModal?.addEventListener('click', e => {
      if (e.target === mapModal) PriorityListMapping.close();
    });
    document.getElementById('pl-mapping-close-btn')?.addEventListener('click', () => PriorityListMapping.close());
    document.getElementById('pl-mapping-cancel-btn')?.addEventListener('click', () => PriorityListMapping.close());
    document.getElementById('pl-mapping-confirm-btn')?.addEventListener('click', () => PriorityListMapping.confirm());

    const viewModal = document.getElementById('modal-priority-viewer');
    viewModal?.addEventListener('click', e => {
      if (e.target === viewModal) PriorityListViewer.close();
    });
    document.getElementById('pl-viewer-close-x')?.addEventListener('click', () => PriorityListViewer.close());
    document.getElementById('pl-viewer-close-btn')?.addEventListener('click', () => PriorityListViewer.close());
    document.getElementById('pl-viewer-search')?.addEventListener('input', e => {
      PriorityListViewer.search((e.target as HTMLInputElement).value);
    });
  },

  render(): void {
    const plantName = Store.selectedPlant;
    const badge = document.querySelector('#md-master-plant-pane .plant-badge');
    if (badge) badge.textContent = plantName || '—';
    Plant.gotoTab(Plant._currentPlantTab || 'general');
    Plant._renderHours();
    Plant._renderBlocks();
    Plant._renderRoster();
  },

  /** Called by App once `GET /priority-fields` resolves (application-shell.mts),
   *  so a late-arriving registry un-sticks a Scheduling Constraints pane that
   *  rendered against the one-entry `Engine.CONSTRAINT_CATALOG` fallback.
   *
   *  This is not cosmetic. `_renderSettingsPane` is synchronous (R8) and
   *  `renderConstraints`' add-picker gate is
   *  `countConfiguredKeys(consTree) < Engine.CONSTRAINT_CATALOG.length` — with a
   *  1-entry catalog that is false for any plant carrying even its default
   *  `[colorWheel]` seed, so every "+ Add priority" / "+ Add sub-priority"
   *  control renders DISABLED with Color Wheel as its only option. Nothing else
   *  re-rendered the pane, so a slow or failed boot fetch left the tree
   *  permanently unusable for the session with no recovery short of a page
   *  reload. (A comment in App claimed this re-render already happened; it did
   *  not.)
   *
   *  A direct method call rather than a Store event on purpose: `Store.emit`
   *  reaches `Persistence.autosave`'s unfiltered subscriber, and this pane is the
   *  only thing that needs waking — CLAUDE.md's "small public method" resolution
   *  for a reverse-direction need. Guarded so it is a no-op unless that pane is
   *  the one on screen; re-rendering it is otherwise identical to the user
   *  clicking the sub-tab. */
  onPriorityFieldsLoaded(): void {
    const onSettingsPane = _activeTabResolvers.currentTab() === 'masterdata'
      && _activeTabResolvers.currentMasterSub() === 'plant'
      && Plant._currentPlantTab === 'settings';
    if (onSettingsPane) Plant._renderSettingsPane();
  },

  gotoTab(tab: string | undefined): void {
    if (!['general', 'optimization', 'settings'].includes(tab!)) return;
    const t = tab!;
    Plant._currentPlantTab = t;
    document.querySelectorAll<HTMLElement>('.plant-inner-tabs .sub-subtab').forEach(b => {
      b.classList.toggle('active', b.dataset.plantTab === t);
    });
    ['general', 'optimization', 'settings'].forEach(tt => {
      const el = document.getElementById(`plant-tab-${tt}`);
      if (el) el.hidden = (tt !== t);
    });
    if (t === 'settings') Plant._renderSettingsPane();
    else if (t === 'optimization') Plant._fetchAndRenderOptimization(Store.selectedPlant);
  },

  toggleBlocksList(): void {
    Plant._blocksCollapsed = !Plant._blocksCollapsed;
    const list = document.getElementById('plant-blocks-list');
    const btn  = document.getElementById('plant-blk-toggle');
    if (list) list.style.display = Plant._blocksCollapsed ? 'none' : '';
    if (btn)  btn.textContent = Plant._blocksCollapsed ? '▼' : '▲';
  },

  toggleRosterList(): void {
    Plant._rosterCollapsed = !Plant._rosterCollapsed;
    const wrap = document.getElementById('plant-roster-wrap');
    const btn  = document.getElementById('plant-roster-toggle');
    if (wrap) wrap.style.display = Plant._rosterCollapsed ? 'none' : '';
    if (btn)  btn.textContent = Plant._rosterCollapsed ? '▼' : '▲';
  },

  _renderHours(): void {
    const body = document.getElementById('plant-hours-body');
    if (!body) return;
    const plantName = Store.selectedPlant;
    if (!plantName) { body.innerHTML = `<p class="plant-no-sel">${Util.t('ui.select_plant_hours')}</p>`; return; }
    Store.ensurePlant(plantName);
    const plant = Store.plants[plantName];

    if (Plant._pillFps) {
      Plant._pillFps.forEach(p => { p.start?.destroy(); p.end?.destroy(); });
    }
    Plant._pillFps = Array(7).fill(null).map(() => ({ start: null, end: null })) as PillFpPair[];
    const dayLabels = ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => Util.t(k));

    const pillsHtml = [0,1,2,3,4,5,6].map(d => {
      const wh = plant.workHours[d];
      const time = wh ? `${ProdLines._fmtHour(wh[0])}–${ProdLines._fmtHour(wh[1])}` : Util.t('ui.off');
      const hrs = wh ? (() => { const h = wh[1] - wh[0]; return h % 1 === 0 ? `${h}h` : `${h.toFixed(1)}h`; })() : '—';
      return `<div class="line-hours-pill ${wh ? 'on' : 'off'}" data-day="${d}"
        onclick="NIMBUS.Plant._pillClick(${d})"
        oncontextmenu="NIMBUS.Plant._pillRightClick(${d}, event)">
        <span class="lhp-day">${dayLabels[d]}</span>
        <span class="lhp-time">${time}</span>
        <span class="lhp-hrs">${hrs}</span>
        <input id="plant-pill-start-${d}" class="phwi-anchor" readonly>
        <input id="plant-pill-end-${d}"   class="phwi-anchor" readonly>
      </div>`;
    }).join('');

    body.innerHTML = `<div class="line-hours-pills">${pillsHtml}</div>`;

    requestAnimationFrame(() => {
      const p = Store.plants[Store.selectedPlant!];
      for (let d = 0; d < 7; d++) {
        const wh = p.workHours[d];
        const onClose = () => Plant._pillSave(d);
        Plant._pillFps![d].start = flatpickr(`#plant-pill-start-${d}`, {
          enableTime: true, noCalendar: true, dateFormat: 'H:i',
          minuteIncrement: 30,
          defaultDate: wh ? Util.hoursToTimeString(wh[0]) : '08:00',
          onClose,
        });
        Plant._pillFps![d].end = flatpickr(`#plant-pill-end-${d}`, {
          enableTime: true, noCalendar: true, dateFormat: 'H:i',
          minuteIncrement: 30,
          defaultDate: wh ? Util.hoursToTimeString(wh[1]) : '17:00',
          onClose,
        });
      }
    });
  },

  _pillClick(d: number): void {
    const pName = Store.selectedPlant;
    if (!pName) return;
    const plant = Store.plants[pName];
    const wh = plant.workHours[d];
    if (!wh) {
      Store.setPlantWorkHours(pName, d, [8, 17], 'pill');
      const changed = new Set<string>();
      for (let i = 0; i < 7; i++) for (const l of Store.clampLinesToPlant(pName, i)) changed.add(l);
      Plant._persistPlantHours(pName, changed);
      Plant._renderHours();
      Toast.show(Util.t('day.sun_enabled', { day: ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => Util.t(k))[d] }), 'success');
      return;
    }
    const pill = document.querySelector(`.line-hours-pill[data-day="${d}"]`);
    if (pill) pill.classList.add('editing');
    Plant._pillFps?.[d]?.start?.open();
  },

  _pillSave(d: number): void {
    const pName = Store.selectedPlant;
    if (!pName) return;
    const pair = Plant._pillFps?.[d];
    if (!pair?.start || !pair?.end) return;
    const sv = pair.start.element.value;
    const ev = pair.end.element.value;
    if (!sv || !ev) {
      Store.setPlantWorkHours(pName, d, null, 'pill');
    } else {
      const sh = Util.timeStringToHours(sv), eh = Util.timeStringToHours(ev);
      if (eh <= sh) { Toast.show(Util.t('toast.end_must_be_after_start'), 'error'); return; }
      Store.setPlantWorkHours(pName, d, [sh, eh], 'pill');
    }
    const changed = new Set<string>();
    for (let i = 0; i < 7; i++) for (const l of Store.clampLinesToPlant(pName, i)) changed.add(l);
    Plant._persistPlantHours(pName, changed);
    Plant._renderHours();
    Toast.show(Util.t('toast.plant_hours_updated'), 'success');
  },

  /** Persist a plant's working hours + only the line hours the clamp actually rewrote
   *  (changedLines, a Set/array). Narrowing to changed lines means a concurrent
   *  single-line edit that still fits the new plant window is NOT re-POSTed and so not
   *  clobbered by the plant-hours batch. (F9) Per-line saves are batched into one
   *  /line-hours POST by CalendarSync. Falls back to all in-plant lines if no set given. */
  _persistPlantHours(pName: string | null, changedLines?: Set<string> | string[]): void {
    if (!pName) return;
    CalendarSync.savePlantHours(pName, Store.plants[pName]?.workHours);
    const lines = changedLines
      ? [...changedLines].filter(l => Store.calendars[l] && Store.getPlantForLine(l) === pName)
      : Object.keys(Store.calendars).filter(l => Store.getPlantForLine(l) === pName);
    for (const line of lines) {
      CalendarSync.saveLineHours(pName, line, Store.calendars[line].workHours);
    }
  },

  _pillRightClick(d: number, e: MouseEvent): void {
    e.preventDefault();
    document.querySelector('.pill-ctx-menu')?.remove();

    const pName = Store.selectedPlant;
    if (!pName) return;
    const plant = Store.plants[pName];
    const wh = plant?.workHours[d];
    const dayName = ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => Util.t(k))[d];

    const menu = document.createElement('div');
    menu.className = 'pill-ctx-menu';
    menu.innerHTML = wh
      ? `<button data-action="off">${Util.t('day.set_off', { day: dayName })}</button>`
      : `<button data-action="on">${Util.t('day.reset_on', { day: dayName })}</button>`;

    menu.querySelector('button')!.onclick = () => {
      const _pName = Store.selectedPlant!;
      menu.remove();
      if (wh) {
        Store.setPlantWorkHours(_pName, d, null, 'pill');
        Toast.show(Util.t('day.set_to_off', { day: dayName }), 'success');
      } else {
        Store.setPlantWorkHours(_pName, d, [8, 17], 'pill');
        Toast.show(Util.t('day.sun_enabled', { day: dayName }), 'success');
      }
      const changed = new Set<string>();
      for (let i = 0; i < 7; i++) for (const l of Store.clampLinesToPlant(_pName, i)) changed.add(l);
      Plant._persistPlantHours(_pName, changed);
      Plant._renderHours();
    };

    menu.style.left = e.clientX + 'px';
    menu.style.top  = e.clientY + 'px';
    document.body.appendChild(menu);

    requestAnimationFrame(() => {
      const r = menu.getBoundingClientRect();
      if (r.right  > window.innerWidth)  menu.style.left = (window.innerWidth  - r.width  - 6) + 'px';
      if (r.bottom > window.innerHeight) menu.style.top  = (window.innerHeight - r.height - 6) + 'px';
    });

    const dismiss = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener('mousedown', dismiss); }
    };
    const dismissKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { menu.remove(); document.removeEventListener('keydown', dismissKey); }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', dismiss);
      document.addEventListener('keydown', dismissKey);
    }, 0);
  },

  _renderBlocks(): void {
    const list    = document.getElementById('plant-blocks-list');
    const statsEl = document.getElementById('plant-blocks-stats');
    if (!list) return;

    const blocks = (Store.plantBlocks || []).slice()
      .sort((a, b) => (Util.parseDate(a.start)?.getTime() || 0) - (Util.parseDate(b.start)?.getTime() || 0));

    if (statsEl) {
      if (blocks.length) {
        const totalDays = blocks.reduce((acc, b) =>
          acc + Math.ceil(((Util.parseDate(b.end)?.getTime() || 0) - (Util.parseDate(b.start)?.getTime() || 0)) / Config.MS_DAY), 0);
        const chevron = Plant._blocksCollapsed ? '▼' : '▲';
        statsEl.innerHTML = `<div class="plant-blk-stats" style="display:flex;align-items:center;justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:16px;">
            <div class="plant-blk-stat" style="padding:0 4px;">
              <span class="pbs-val">${blocks.length}</span>
              <span class="pbs-lbl">${Util.t('ui.blackouts_label', {plural: blocks.length !== 1 ? 's' : ''})}</span>
            </div>
            <div class="plant-blk-stats-sep"></div>
            <div class="plant-blk-stat" style="padding:0 4px;">
              <span class="pbs-val">${totalDays}</span>
              <span class="pbs-lbl">${Util.t('ui.days_blocked', {plural: totalDays !== 1 ? 's' : ''})}</span>
            </div>
          </div>
          <button id="plant-blk-toggle" class="btn btn-ghost sm" onclick="NIMBUS.Plant.toggleBlocksList()" title="${Util.t('ui.toggle_list')}" style="font-size:11px;padding:2px 8px;min-width:28px;">${chevron}</button>
        </div>`;
      } else {
        statsEl.innerHTML = '';
      }
    }

    if (!blocks.length) {
      list.innerHTML = `<div class="empty-state">${Util.t('empty.no_plant_blackouts')}</div>`;
      return;
    }

    list.innerHTML = blocks.map(b => `
      <div class="block-row" style="padding-left:6px;padding-right:6px;">
        <span class="ico">■</span>
        <span class="reason">${b.reason || Util.t('ui.blackouts_label', {plural: ''})}</span>
        <span class="range" title="${Util.fmtDTReadable(b.start)} → ${Util.fmtDTReadable(b.end)}">${Util.fmtBlockRange(b.start, b.end)}</span>
        <button class="btn btn-ghost sm" style="padding:2px 7px;font-size:14px;" title="${Util.t('tip.remove_block')}" onclick="NIMBUS.Plant.removePlantBlock('${b.id}')">×</button>
      </div>
    `).join('');
    list.style.display = Plant._blocksCollapsed ? 'none' : '';
  },

  _renderRoster(): void {
    const roster = document.getElementById('plant-lines-roster');
    if (!roster) return;
    const lines = Store.linesForSelectedPlant();
    const countEl = document.getElementById('plant-lines-count');
    if (countEl) countEl.textContent = Util.t('ui.lines_count', {count: lines.length, plural: lines.length !== 1 ? 's' : ''});

    if (!lines.length) {
      roster.innerHTML = `<div class="empty-state">${Util.t('empty.no_production_lines')}</div>`;
      return;
    }

    const thStyle = 'padding:8px 12px;font-size:12px;font-weight:600;position:sticky;top:0;z-index:2;background:var(--surface,#fff);border-bottom:1px solid var(--border,#e2e8f0);';
    const thStyleBlank = 'padding:8px 12px;position:sticky;top:0;z-index:2;background:var(--surface,#fff);border-bottom:1px solid var(--border,#e2e8f0);';
    const dayLabels = ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => Util.t(k));

    roster.innerHTML = `<table style="width:100%;border-collapse:collapse;">
      <thead><tr style="text-align:left;">
        <th style="${thStyle}">${Util.t('ui.line_label')}</th>
        <th style="${thStyle}">${Util.t('ui.roster_important_flags')}</th>
        <th style="${thStyle}">${Util.t('ui.roster_schedule')}</th>
        <th style="${thStyle}">Production Line Group</th>
        <th style="${thStyleBlank}"></th>
      </tr></thead>
      <tbody>
        ${lines.map((line, li) => {
          const color = Config.COLORS[li % Config.COLORS.length];
          const ls = Store.lineSettings[line] || {};
          const botBadge = ls.bottleneck
            ? `<span style="background:var(--warn,#93610a);color:#fff;font-size:11px;padding:2px 6px;border-radius:4px;">${Util.t('ui.bottleneck')}</span>`
            : '';
          const exclBadge = ls.excludeFromOpt
            ? `<span style="background:#6366f1;color:#fff;font-size:11px;padding:2px 6px;border-radius:4px;">${Util.t('ui.excl_optimizer')}</span>`
            : '';
          const cal = Store.calendars[line]?.workHours || {};
          const schedCells = [0,1,2,3,4,5,6].map(d => {
            const wh = cal[d];
            const timeStr = wh ? `${ProdLines._fmtHour(wh[0])}–${ProdLines._fmtHour(wh[1])}` : Util.t('ui.off');
            const timeColor = wh ? '#1e293b' : '#ef4444';
            return `<div style="text-align:center;font-size:11px;line-height:1.4;min-width:56px;">
              <div style="font-weight:600;color:#64748b;">${dayLabels[d]}</div>
              <div style="color:${timeColor};">${timeStr}</div>
            </div>`;
          }).join('');
          const safeId = line.replace(/'/g, "\\'");
          const plgVal = (ls.plGroup || '').replace(/"/g, '&quot;');
          return `<tr style="border-bottom:1px solid var(--border,#f1f5f9);">
            <td style="padding:8px 12px;"><div class="line-label"><span class="line-dot" style="background:${color}"></span>${line}</div></td>
            <td style="padding:8px 12px;">${botBadge}${exclBadge ? ' ' + exclBadge : ''}</td>
            <td style="padding:8px 12px;">
              <div style="display:flex;gap:6px;align-items:flex-start;">${schedCells}</div>
            </td>
            <td style="padding:8px 12px;">
              <input type="text" class="input roster-plgroup-input" style="width:120px;font-size:12px;" value="${plgVal}" data-line="${line}" placeholder="—">
            </td>
            <td style="padding:8px 12px;text-align:right;">
              <button class="btn btn-ghost sm" onclick="NIMBUS.App.goto('masterdata'); NIMBUS.App.gotoMasterSub('lines'); setTimeout(()=>{const el=document.getElementById('line-row-${safeId}');if(el)el.scrollIntoView({behavior:'smooth',block:'center'});},80);">Edit →</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;

    roster.querySelectorAll<HTMLInputElement>('.roster-plgroup-input').forEach(inp => {
      inp.onchange = () => {
        const val = inp.value.trim();
        const line = inp.dataset.line!;
        Store.setLineSetting(line, { plGroup: val }, 'plant-roster');
        NIMBUS!.MasterData!.syncLineSettings!(line, { plGroup: val });
        Toast.show(Util.t('toast.line_settings_updated'), 'success');
      };
    });

    const wrap = document.getElementById('plant-roster-wrap');
    const btn  = document.getElementById('plant-roster-toggle');
    if (wrap) wrap.style.display = Plant._rosterCollapsed ? 'none' : '';
    if (btn)  btn.textContent = Plant._rosterCollapsed ? '▼' : '▲';
  },

  openBlockModal(): void {
    const reasonEl = document.getElementById('plant-blk-reason') as HTMLInputElement | null;
    if (!reasonEl) { ErrorLog.error('ui', 'required DOM element missing: plant-blk-reason'); return; }

    const now = new Date(); now.setMinutes(0, 0, 0);
    const plus1 = new Date(now.getTime() + Config.MS_HOUR);
    if (!Plant._fpBlkStart) {
      Plant._fpBlkStart = Util.fpDatetime('#plant-blk-start');
      Plant._fpBlkEnd   = Util.fpDatetime('#plant-blk-end');
    }
    Plant._fpBlkStart!.setDate(now, false);
    Plant._fpBlkEnd!.setDate(plus1, false);
    reasonEl.value = '';
    Modal.open('modal-plant-block');
  },

  savePlantBlockFromModal(): void {
    const startEl = document.getElementById('plant-blk-start') as HTMLInputElement | null;
    const endEl = document.getElementById('plant-blk-end') as HTMLInputElement | null;
    const reasonEl = document.getElementById('plant-blk-reason') as HTMLInputElement | null;
    if (!startEl || !endEl || !reasonEl) { ErrorLog.error('ui', 'required DOM elements missing for plant blackout modal'); return; }

    const start  = Util.parseDate(startEl.value);
    const end    = Util.parseDate(endEl.value);
    const reason = reasonEl.value.trim() || Util.t('ui.plant_blackout_default');
    if (!start || !end) { Toast.show(Util.t('toast.please_set_start_end'), 'error'); return; }
    if (end <= start)   { Toast.show(Util.t('toast.end_must_be_after_start'), 'error'); return; }
    if (!Store.selectedPlant) { Toast.show(Util.t('toast.select_plant_first'), 'warn'); return; }
    const before = Store.plantBlocks.length;
    Store.addPlantBlock({ plant: Store.selectedPlant, start, end, reason } as NimbusPlantBlock, 'plant');
    if (Store.plantBlocks.length > before) CalendarSync.savePlantBlackoutUpsert(Store.plantBlocks[Store.plantBlocks.length - 1]);
    Modal.close('modal-plant-block');
    Toast.show(Util.t('toast.plant_blackout_added'), 'success');
  },

  removePlantBlock(id: string): void {
    const blk = Store.plantBlocks.find(b => b.id === id);
    const plant = blk?.plant || Store.selectedPlant;
    Store.removePlantBlock(id, 'plant');
    if (plant) CalendarSync.savePlantBlackoutDelete(plant, id);
    Toast.show(Util.t('toast.plant_blackout_removed'), 'success');
  },

  /* ── Optimization Options section ── */

  _fetchAndRenderOptimization(plantName: string | null): void {
    const panel = document.getElementById('plant-opt-panel');
    if (!panel) return;
    const body = panel.querySelector('.panel-body');
    if (!plantName) {
      if (body) body.innerHTML = `<div class="cw-empty-hint">${Util.t('ui.select_plant_for_priority_lists')}</div>`;
      return;
    }
    if (body) body.innerHTML = `<div class="cw-loading"><span class="cw-spin"></span>${Util.t('ui.loading')}</div>`;

    // Util.fetchTraced (not bare fetch) — it auto-injects x-user-email/X-User,
    // which these three reads need for two reasons: GET /priority-lists and
    // GET /master-data/{plant}/missing-master-data resolve the caller's
    // role-scoped allowed-plants list from that header (auth.
    // get_allowed_plants_for_request) — an anonymous request resolves to
    // None/unrestricted, silently bypassing a plant-restricted user's own
    // role_plants scoping — and an r.ok check below needs a real response to
    // check, not a 403 body that parses as if it were valid data.
    // The missing-master-data read is the only optional one of the three (the
    // panel it feeds is supplementary), but its failure must still be
    // DISTINGUISHABLE from a successful empty report — hence the {ok, data}
    // envelope rather than the old `.catch(() => null)`, which collapsed both
    // into the same `null`.
    Promise.all([
      Util.fetchTraced(`${Config.API_BASE}/priority-fields`, { signal: AbortSignal.timeout(6000) }).then(_okJson),
      Util.fetchTraced(`${Config.API_BASE}/priority-lists?plant=${encodeURIComponent(plantName)}`, { signal: AbortSignal.timeout(6000) }).then(_okJson),
      Util.fetchTraced(`${Config.API_BASE}/master-data/${encodeURIComponent(plantName)}/missing-master-data`, { signal: AbortSignal.timeout(6000) })
        .then(_okJson)
        .then((data: MissingMasterDataReport) => ({ ok: true, data }),
              () => ({ ok: false, data: null as MissingMasterDataReport | null })),
    ])
      .then(([fieldsBody, listsBody, missing]) => {
        // Staleness guard. `plantName` is the plant THIS call was issued for;
        // Store.selectedPlant is the live selection. Switching plant A -> B -> A
        // fans out three overlapping Promise.all flights against unkeyed module
        // state, and a late A-response landing after B's render would leave the
        // tab showing A's cards while every wired action closes over the plant
        // the stale render painted — including Delete and Resync Now, the
        // latter running a real UPDATE orders (xmin bump, planner data loss) on
        // the wrong plant, and the line-override combobox offering the CURRENT
        // plant's lines for an upload targeting the stale one. Bail before
        // touching state or the DOM.
        if (plantName !== Store.selectedPlant) return;
        Plant._priorityFields = fieldsBody.fields || [];
        Plant._priorityLists = listsBody.fields || {};
        Plant._missingMasterData = missing.ok ? missing.data : null;
        Plant._missingDataOk = missing.ok;
        Plant._priorityLoadError = null;
        Plant._renderOptimization(plantName);
      })
      .catch((e: Error) => {
        if (plantName !== Store.selectedPlant) return;
        // Do NOT blank the tab. Emptying _priorityFields on any failure left a
        // completely inert panel — no dropzones, no cards, no error, no way to
        // upload anything — a regression from the pre-Stage-2 empty state. The
        // field registry is plant-independent (GET /priority-fields returns the
        // same rows for every plant), so a previously-loaded copy is still
        // valid; only fall back to the static registry when we've never had one.
        if (!Plant._priorityFields.length) Plant._priorityFields = _FALLBACK_PRIORITY_FIELDS.map(f => ({ ...f }));
        Plant._priorityLists = {};
        Plant._missingMasterData = null;
        Plant._missingDataOk = false;
        Plant._priorityLoadError = e?.message || 'unknown';
        ErrorLog.error('plant', `Priority-list load failed for ${plantName}: ${Plant._priorityLoadError}`);
        Plant._renderOptimization(plantName);
      });
  },

  _renderOptimization(plantName: string | null): void {
    const body = document.getElementById('plant-opt-body');
    if (!body) return;
    const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]);
    const relTime = (ts: string | null | undefined): string => {
      if (!ts) return Util.t('ui.unknown_time');
      const diff = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
      if (diff < 120)   return Util.t('ui.just_now');
      if (diff < 3600)  return Util.t('ui.mins_ago', { n: Math.floor(diff / 60) });
      if (diff < 86400) return Util.t('ui.hours_ago', { n: Math.floor(diff / 3600) });
      return Util.t('ui.days_ago', { n: Math.floor(diff / 86400) });
    };

    const fields = Plant._priorityFields || [];
    const lists  = Plant._priorityLists  || {};

    const fieldCardHtml = (f: { field_key: string; default_label: string }): string => {
      const summary = lists[f.field_key] || { plant_wide: null, line_overrides: [], coverage: {} };
      // Util.t(key, vars?) — no fallback-string param (confirmed at
      // web/application-foundation.mts:556-562): it already falls back
      // en -> raw key on a missing translation, which is why Task 14 must
      // land the constraint.* keys in en.js at minimum. f.default_label is
      // the backend's own default (surfaced via GET /priority-fields) and is
      // NOT threaded through Util.t — it exists for API consumers that don't
      // have the locale bundle at all, not as an in-app i18n fallback.
      const label = Util.t(`constraint.${f.field_key}`);
      // The "not yet used in sequencing" badge that used to render here for every
      // non-colorWheel field was removed once Stage 3 wired ALL FOUR registered
      // fields into Engine._sortTerms (docs/scheduling_priority.md Stage 3) — it had
      // become a false statement on the very screen where an admin configures the
      // field. Deliberately removed rather than reworded: whether this card should
      // instead carry a "verify your coverage" caution is a separate copy decision.
      // PLANT_TOTAL_COVERAGE_KEY, not '' — see that constant's comment. The
      // ungrouped backend branch always returns a row for every field (0/0 for
      // a plant with no orders), so gate on distinct_values rather than key
      // presence to avoid rendering a meaningless "0/0 values ranked".
      const cov = summary.coverage[PLANT_TOTAL_COVERAGE_KEY] || null;
      const covHtml = cov && cov.distinct_values > 0
        ? `<div class="pl-coverage"><span class="pl-coverage-num">${cov.ranked_values}/${cov.distinct_values}</span> ${Util.t('ui.values_ranked')}</div>`
        : '';

      let activeOrDrop: string;
      if (summary.plant_wide) {
        const w = summary.plant_wide;
        activeOrDrop = `
          <div class="cw-active-card">
            <div class="cw-active-icon">${f.field_key === 'colorWheel' ? '🎨' : '🔧'}</div>
            <div class="cw-active-info">
              <div class="cw-active-name">${esc(w.filename || '—')}</div>
              <div class="cw-active-meta">${w.row_count ?? '?'} ${Util.t('ui.values')} &middot; ${relTime(w.uploaded_at)} &middot; ${esc(w.uploaded_by || 'system')}</div>
              ${covHtml}
            </div>
            <div class="cw-active-actions">
              <button class="btn btn-ghost sm" data-action="preview" data-field="${f.field_key}" data-line="">👁 ${Util.t('btn.preview')}</button>
              <button class="btn btn-ghost sm cw-delete-btn" data-action="delete" data-field="${f.field_key}" data-line="">⌫ ${Util.t('btn.remove')}</button>
            </div>
          </div>
          <div class="cw-dropzone cw-replace-zone" id="plant-pl-dropzone-${f.field_key}" data-field="${f.field_key}" title="${Util.t('ui.drop_to_replace')}">
            <div class="cw-drop-inner">
              <span class="cw-drop-icon">↻</span>
              <span class="cw-drop-text">${Util.t('ui.drop_replace_text')}</span>
              <input type="file" id="plant-pl-file-${f.field_key}" accept=".xlsx,.xls" style="display:none">
            </div>
          </div>`;
      } else {
        activeOrDrop = `
          <div class="cw-dropzone" id="plant-pl-dropzone-${f.field_key}" data-field="${f.field_key}">
            <div class="cw-drop-inner">
              <span class="cw-drop-icon">📂</span>
              <span class="cw-drop-text">${Util.t('ui.drop_list_text', { field: label })}</span>
              <div class="cw-drop-hint">${Util.t('ui.drop_list_hint')}</div>
              <input type="file" id="plant-pl-file-${f.field_key}" accept=".xlsx,.xls" style="display:none">
            </div>
          </div>`;
      }

      const overridesHtml = summary.line_overrides.map(o => {
        // priority_list_coverage (db.py:2056) computes coverage PER LINE, not
        // just plant-wide — an override row that only ever showed row_count/
        // upload time would silently drop the one number `covHtml` above proves
        // is available and useful (the whole point of N3's per-line breakdown).
        const lineCov = summary.coverage[o.line] || null;
        const lineCovHtml = lineCov
          ? `<span class="pl-coverage pl-override-coverage">${lineCov.ranked_values}/${lineCov.distinct_values} ${Util.t('ui.values_ranked')}</span>`
          : '';
        return `
        <div class="pl-override-row">
          <span class="pl-override-line">${esc(o.line)}</span>
          <span class="pl-override-meta">${o.row_count} ${Util.t('ui.values')} &middot; ${relTime(o.uploaded_at)}</span>
          ${lineCovHtml}
          <button class="btn btn-ghost sm" data-action="preview" data-field="${f.field_key}" data-line="${esc(o.line)}">👁</button>
          <button class="btn btn-ghost sm cw-delete-btn" data-action="delete" data-field="${f.field_key}" data-line="${esc(o.line)}">⌫</button>
        </div>`;
      }).join('');

      return `
        <div class="pl-field-card" data-field="${f.field_key}">
          <div class="pl-field-card-head">
            <h4>${esc(label)}</h4>
          </div>
          ${activeOrDrop}
          <div class="pl-overrides">${overridesHtml}</div>
          <div class="pl-add-override" id="pl-add-override-${f.field_key}"></div>
          <div id="plant-pl-status-${f.field_key}" class="admin-status" style="margin-top:8px;"></div>
        </div>`;
    };

    // Visible, persistent inline banner (not a toast that vanishes) — an admin
    // must be able to tell "this plant genuinely has no lists uploaded" from
    // "we couldn't reach the server". `admin-status error` is this file's
    // established error-surfacing class (see _uploadPriorityList's status line).
    const loadErrHtml = Plant._priorityLoadError
      ? `<div class="admin-status error" style="margin-bottom:12px">${esc(Util.t('ui.priority_lists_load_error', { msg: Plant._priorityLoadError }))}</div>`
      : '';
    // Only claim to know the exception count when the report actually loaded.
    // On failure say so, rather than letting the panel's absence read as "no
    // gaps" (which is exactly what a zero-exception success looks like). Skipped
    // when loadErrHtml is already up — that banner covers the whole-tab failure,
    // so a second one about the sub-report would just be noise.
    const missingErrHtml = (Plant._missingDataOk || Plant._priorityLoadError) ? '' :
      `<div class="admin-status warn" style="margin-top:12px">${esc(Util.t('ui.mmd_load_error'))}</div>`;

    const missingHtml = Plant._missingDataOk && Plant._missingMasterData && Plant._missingMasterData.unmatched_pairs > 0 ? `
      <div class="pl-mmd-panel">
        <div class="pl-mmd-head">
          <h4>${Util.t('ui.missing_master_data_title')}</h4>
          <button class="btn btn-ghost sm" id="pl-mmd-export">${Util.t('btn.export_csv')}</button>
          <button class="btn btn-primary sm" id="pl-mmd-resync">${Util.t('btn.resync_now')}</button>
        </div>
        <p class="pl-mmd-sub">${Util.t('ui.missing_master_data_sub', { pairs: Plant._missingMasterData.unmatched_pairs, orders: Plant._missingMasterData.unmatched_orders })}</p>
        <div class="pl-mmd-list">
          ${Plant._missingMasterData.exceptions.slice(0, 20).map((e: { material_number: string; order_count: number; reason: string }) => `
            <div class="pl-mmd-row">
              <span class="pl-mmd-material">${esc(e.material_number)}</span>
              <span class="pl-mmd-count">${e.order_count} ${Util.t('ui.orders')}</span>
              <span class="pl-mmd-reason">${Util.t(`ui.mmd_reason_${e.reason}`)}</span>
            </div>`).join('')}
          ${Plant._missingMasterData.exceptions.length > 20 ? `
            <div class="pl-mmd-more">${Util.t('ui.mmd_more_rows', { n: Plant._missingMasterData.exceptions.length - 20 })}</div>` : ''}
        </div>
      </div>` : '';

    body.innerHTML = loadErrHtml + fields.map(fieldCardHtml).join('') + missingHtml + missingErrHtml;

    // Wire dropzones (one per field) — see Task pattern at the old single-wheel wiring.
    fields.forEach(f => {
      const zone = document.getElementById(`plant-pl-dropzone-${f.field_key}`);
      const fileInput = document.getElementById(`plant-pl-file-${f.field_key}`) as HTMLInputElement | null;
      if (!zone || !fileInput) return;
      zone.onclick = e => { if (e.target !== fileInput) fileInput.click(); };
      fileInput.onchange = () => { if (fileInput.files![0]) Plant._uploadPriorityList(plantName, f.field_key, fileInput.files![0]); };
      zone.ondragover  = e => { e.preventDefault(); zone.classList.add('drag-over'); };
      zone.ondragleave = () => zone.classList.remove('drag-over');
      zone.ondrop = e => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        if (e.dataTransfer!.files.length > 1) {
          Toast.show(Util.t('toast.one_file_at_a_time'), 'warn');
          return;
        }
        const f0 = e.dataTransfer!.files[0];
        if (f0) Plant._uploadPriorityList(plantName, f.field_key, f0);
      };
    });

    // Wire preview/delete buttons.
    body.querySelectorAll<HTMLElement>('[data-action="preview"]').forEach(btn => {
      btn.addEventListener('click', () => PriorityListViewer.open(plantName!, btn.dataset.field!, btn.dataset.line || ''));
    });
    body.querySelectorAll<HTMLElement>('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', () => Plant._confirmDeletePriorityList(plantName!, btn.dataset.field!, btn.dataset.line || ''));
    });

    // Wire "+ add line override" combobox per field (Store.masterData lines for this plant).
    fields.forEach(f => {
      const host = document.getElementById(`pl-add-override-${f.field_key}`);
      if (!host) return;
      host.innerHTML = `<button class="btn btn-ghost sm" data-add-override="${f.field_key}">+ ${Util.t('ui.add_line_override')}</button>`;
      host.querySelector('button')!.addEventListener('click', () => {
        // Store.masterLinesForPlant(), NOT Store.linesForSelectedPlant(): this
        // dropdown feeds a VALIDATED upload. The backend checks the chosen line
        // against master_data.known_line_codes_for_plant(plant), which queries
        // `production_lines` only — while linesForSelectedPlant() also includes
        // line codes discovered on ORDER rows and in calendars/lineSettings, so
        // it could offer a line that 400s the moment the user picks it. Same
        // master-data-only source the Master Data grids use (see :2461, :2741).
        const lineNames = Store.masterLinesForPlant(plantName)
          .map(l => l.production_line)
          .filter((l): l is string => !!l)
          .sort();
        host.innerHTML = `<div class="pl-override-combo"></div><input type="file" id="pl-override-file-${f.field_key}" accept=".xlsx,.xls" style="display:none">`;
        const comboHost = host.querySelector('.pl-override-combo') as HTMLElement;
        _mkCombobox(comboHost, lineNames, {
          placeholder: Util.t('ph.pick_a_line'),
          onSelect: (line: string) => {
            // The combobox's own clear (×) button calls onSelect(''); since
            // _uploadPriorityList only appends the `line` form field when
            // truthy, an empty line here would silently persist PLANT-WIDE
            // (overwriting the existing plant-wide list) while still
            // reporting "uploaded" success — bail instead of opening the
            // file dialog for a cleared/empty selection.
            if (!line) return;
            (document.getElementById(`pl-override-file-${f.field_key}`) as HTMLInputElement).onchange = (e) => {
              const file = (e.target as HTMLInputElement).files![0];
              if (file) Plant._uploadPriorityList(plantName, f.field_key, file, line);
            };
            (document.getElementById(`pl-override-file-${f.field_key}`) as HTMLInputElement).click();
          },
        });
      });
    });

    // Wire missing-master-data panel actions.
    document.getElementById('pl-mmd-export')?.addEventListener('click', () => {
      // GET /master-data/{plant}/missing-master-data is `Depends(require_admin)` —
      // window.open(url) sends no identity header, so the endpoint 403s and
      // the "download" is really a raw JSON error body landing in a new tab.
      // Route through Util.fetchTraced (identity header included) and turn
      // the response into a real file download via a temporary <a>, matching
      // the blob-download pattern already used by Printer.exportCsv /
      // AdminCockpit's diagnostics-bundle export elsewhere in this codebase.
      Util.fetchTraced(`${Config.API_BASE}/master-data/${encodeURIComponent(plantName!)}/missing-master-data?format=csv`)
        .then(r => r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then(blob => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `missing-master-data-${plantName}.csv`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        })
        .catch(e => Toast.show(Util.t('toast.export_failed', { msg: e.message }), 'error'));
    });
    document.getElementById('pl-mmd-resync')?.addEventListener('click', () => Plant._resyncOrderAttributes(plantName!));
  },

  _uploadPriorityList(plantName: string | null, fieldKey: string, file: File, line?: string): void {
    const status = document.getElementById(`plant-pl-status-${fieldKey}`);
    if (status) { status.textContent = Util.t('toast.uploading_file', { name: file.name }); status.className = 'admin-status info'; }

    const post = (extra: Record<string, string> = {}) => {
      const fd = new FormData();
      fd.append('file', file);
      if (line) fd.append('line', line);
      Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
      return fetch(`${Config.API_BASE}/priority-list/${encodeURIComponent(plantName!)}/${encodeURIComponent(fieldKey)}`, {
        method: 'POST', body: fd, headers: { 'X-User': Session.actor() },
      }).then(r => r.json());
    };

    const onNetworkError = (e: Error) => {
      if (status) { status.textContent = Util.t('toast.upload_failed', { msg: e.message }); status.className = 'admin-status error'; }
    };

    post().then(body => {
      if (body.status === 'needs_mapping') {
        PriorityListMapping.open(body.headers, body.sample,
          (valueCol: string, rankCol: string) => {
            post({ value_column: valueCol, rank_column: rankCol })
              .then(body2 => Plant._handleUploadResult(plantName, fieldKey, status, body2))
              .catch(onNetworkError);
          },
          // Cancelling the mapping modal ends the upload — clear the
          // "Uploading <file>…" line this function set before the
          // needs_mapping round-trip, which otherwise stayed on the card
          // forever, falsely implying an in-flight upload.
          () => { if (status) { status.textContent = ''; status.className = 'admin-status'; } });
        return;
      }
      Plant._handleUploadResult(plantName, fieldKey, status, body);
    }).catch(onNetworkError);
  },

  _handleUploadResult(plantName: string | null, fieldKey: string, status: HTMLElement | null, body: { status: string; message?: string; detail?: string; row_count?: number; replaced?: boolean }): void {
    // Every field card header resolves its label via Util.t('constraint.' + fieldKey)
    // (see fieldCardHtml above) — toasts/modals must do the same, or a raw
    // camelCase key ("prt01 list uploaded for 5512") leaks through next to
    // polished card copy ("Prod. Resource Tool (01)").
    const label = Util.t(`constraint.${fieldKey}`);
    if (body.status !== 'ok') {
      // Every rejection from this endpoint is a FastAPI HTTPException, whose
      // JSON body is {"detail": "..."}, not {"message": "..."} — reading
      // body.message alone showed "upload failed: unknown" for every real
      // failure (bad file format, unknown field key, empty file).
      const errMsg = body.detail || body.message || 'unknown';
      if (status) { status.textContent = Util.t('toast.upload_failed', { msg: errMsg }); status.className = 'admin-status error'; }
      ErrorLog.error('plant', `Priority list upload failed for ${plantName}/${fieldKey}: ${errMsg}`, body);
      return;
    }
    // Two whole keys, not one key with a {{verb}} placeholder: interpolating the
    // English literal 'uploaded'/'replaced' into a translated sentence produced
    // a mixed-language toast in every non-en locale (de: "…-Liste uploaded für
    // 5512"), and no language can be relied on to keep the verb in the same
    // slot anyway. The ErrorLog line below stays English — it's a developer log,
    // not user-visible copy.
    const key = body.replaced ? 'toast.priority_list_replaced' : 'toast.priority_list_uploaded';
    Toast.show(Util.t(key, { field: label, plant: plantName! }), 'success');
    ErrorLog.info('plant', `Priority list ${body.replaced ? 'replaced' : 'uploaded'} for ${plantName}/${fieldKey}: ${body.row_count} values`);
    Plant._fetchAndRenderOptimization(plantName);
    Persistence.loadPriorityRankMaps(plantName);  // keep Store in sync with what just changed
  },

  async _confirmDeletePriorityList(plantName: string, fieldKey: string, line: string): Promise<void> {
    const label = Util.t(`constraint.${fieldKey}`); // same-resolution rule as _handleUploadResult above
    const ok = await Modal.confirm({ title: Util.t('modal.remove_priority_list', { plant: plantName, field: label }), confirmLabel: Util.t('btn.yes_delete') });
    if (!ok) return;
    const qs = line ? `?line=${encodeURIComponent(line)}` : '';
    fetch(`${Config.API_BASE}/priority-list/${encodeURIComponent(plantName)}/${encodeURIComponent(fieldKey)}${qs}`, {
      method: 'DELETE', headers: { 'X-User': Session.actor() },
    })
      .then(r => r.json())
      .then(body => {
        if (body.status !== 'ok' && body.status !== 'not_found') {
          Toast.show(Util.t('toast.delete_failed'), 'error'); return;
        }
        Toast.show(Util.t('toast.priority_list_deleted', { plant: plantName, field: label }), 'success');
        Plant._fetchAndRenderOptimization(plantName);
        Persistence.loadPriorityRankMaps(plantName);  // keep Store in sync with what just changed
      })
      .catch(e => Toast.show(Util.t('toast.delete_failed_msg', { msg: e.message }), 'error'));
  },

  async _resyncOrderAttributes(plantName: string): Promise<void> {
    // Modal.confirm's real opts are {title, message, detail, confirmLabel, tone}
    // (web/application-foundation.mts:1289-1291) — its own header comment is
    // stale (documents an old callback-style signature); 'body' is not a field.
    const ok = await Modal.confirm({
      title: Util.t('modal.resync_title', { plant: plantName }),
      message: Util.t('modal.resync_warning'),
      confirmLabel: Util.t('btn.resync_now'),
      tone: 'warn',
    });
    if (!ok) return;
    fetch(`${Config.API_BASE}/master-data/resync-order-attributes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
      body: JSON.stringify({ plant: plantName }),
    })
      // _okJson, not a bare r.json(): a 403 (not an admin / plant outside the
      // caller's role_plants) or a 500 still returns parseable JSON, which took
      // the success branch and showed "Resync complete — undefined materials
      // (undefined orders)…" as a green toast. Route it to the existing
      // toast.resync_failed path in .catch instead.
      .then(_okJson)
      .then(body => {
        Toast.show(Util.t('toast.resync_done', { pairs: body.unmatched_pairs, orders: body.unmatched_orders }), 'success');
        Plant._fetchAndRenderOptimization(plantName);
      })
      .catch(e => Toast.show(Util.t('toast.resync_failed', { msg: e.message }), 'error'));
  },

  // Relocated bodily from app.js's `App._renderSettingsPane` (CQ-1 Phase 4
  // Task 1 — see this phase's plan's Architecture section, seam #1). This is
  // per-plant scheduling-constraint UI that only ever renders into Plant's
  // own #plant-tab-settings DOM and is only ever triggered from
  // Plant.gotoTab('settings') above — moving it here eliminates a Plant →
  // App → back-into-Plant's-own-DOM seam rather than carrying it forward.
  // Its one `Store._state.masterData` direct touch is untouched, verbatim —
  // closing that §6 exception is not this task's job (see the compatibility
  // inventory).
  _renderSettingsPane(): void {
    const pane = document.getElementById('plant-tab-settings');
    if (!pane) return;
    const plantName = Store.selectedPlant;
    const plantRow: NimbusMasterPlant | null = Store._state.masterData?.plants?.find(p => p.plant === plantName) ?? null;
    // Values stored as total minutes in DB
    const alertHz = plantRow?.alt_flag_horizon   ?? Store.userSettings.alertHorizonMinutes   ?? 43200;
    const confHz  = plantRow?.conf_score_horizon ?? Store.userSettings.confidenceHorizonMinutes ?? 20160;

    const subTab = Plant._currentSettingsSubTab;
    const subTabVisibility = Plant._settingsSubTabVisibility(subTab);
    pane.innerHTML = `
      <div class="cal-scroll"><div class="cal-container">
        <header class="cal-head">
          <div>
            <h2>${Util.t('ui.system_settings_title')}</h2>
            <p class="sub">${Util.t('ui.system_settings_sub', { plant: plantName || 'the selected plant' })}</p>
          </div>
        </header>

        <nav class="admin-subtabs" role="tablist" style="padding:0 24px;">
          <button id="settings-subtab-rules-tab" class="sub-subtab${subTab === 'rules' ? ' active' : ''}" data-settings-subtab="rules" role="tab" aria-selected="${subTab === 'rules'}" aria-controls="settings-subtab-rules">${Util.t('ui.settings_subtab_rules')}</button>
          <button id="settings-subtab-setup-tab" class="sub-subtab${subTab === 'setup' ? ' active' : ''}" data-settings-subtab="setup" role="tab" aria-selected="${subTab === 'setup'}" aria-controls="settings-subtab-setup">${Util.t('ui.settings_subtab_setup')}</button>
        </nav>

        <div id="settings-subtab-rules" role="tabpanel" aria-labelledby="settings-subtab-rules-tab" style="display:${subTabVisibility.rules ? 'flex' : 'none'};flex-direction:column;gap:24px;padding:8px 0 32px" ${subTabVisibility.rules ? '' : 'hidden'}>

          <div class="panel">
            <header class="panel-head"><h3>${Util.t('ui.alert_horizon_title')}</h3></header>
            <div class="panel-body">
              <p class="panel-help-text">${Util.t('ui.alert_horizon_help')}</p>
              <div style="display:flex;align-items:center;gap:8px;font-size:13px">
                <span style="min-width:160px">${Util.t('ui.show_alerts_within')}</span>
                <input type="number" id="sys-alert-horizon-days" class="form-input" min="1" max="60" step="1"
                       style="width:64px;text-align:right" placeholder="0">
                <span>${Util.t('ui.days')}</span>
              </div>
            </div>
          </div>

          <div class="panel">
            <header class="panel-head"><h3>${Util.t('ui.conf_horizon_title')}</h3></header>
            <div class="panel-body">
              <p class="panel-help-text">${Util.t('ui.conf_horizon_help')}</p>
              <div style="display:flex;align-items:center;gap:8px;font-size:13px">
                <span style="min-width:160px">${Util.t('ui.score_covers')}</span>
                <input type="number" id="sys-conf-horizon-days" class="form-input" min="1" step="1"
                       style="width:64px;text-align:right" placeholder="0">
                <span>${Util.t('ui.days')}</span>
              </div>
            </div>
          </div>

          <div class="panel">
            <header class="panel-head"><h3>${Util.t('ui.split_order_title')}</h3></header>
            <div class="panel-body split-policy-body">
              <p class="panel-help-text split-policy-copy">${Util.t('ui.split_order_help')}</p>
              <label class="split-policy-control" for="sys-split-order-policy">
                <span>${Util.t('ui.split_order_policy_label')}</span>
                <select id="sys-split-order-policy" class="form-input" aria-describedby="sys-split-order-policy-help">
                  <option value="never">${Util.t('ui.split_order_opt_never')}</option>
                  <option value="overlong_only">${Util.t('ui.split_order_opt_overlong')}</option>
                  <option value="partial_allowed">${Util.t('ui.split_order_opt_partial')}</option>
                </select>
              </label>
              <p id="sys-split-order-policy-help" class="split-policy-help">${Util.t('ui.split_order_policy_help')}</p>
            </div>
          </div>

          <div class="panel">
            <header class="panel-head"><h3>${Util.t('ui.constraints_title')}</h3></header>
            <div class="panel-body">
              <p class="panel-help-text">${Util.t('ui.constraints_sub')}</p>
              <div id="sys-constraints-list" class="constraint-list"></div>
              <!-- Stage 3: the readout that keeps the presentational tree honest.
                   The tree above is nested; the optimizer runs a FLAT ordered key
                   list (Engine.flattenConstraints), so this shows exactly what
                   that collapse produces — including which nodes contribute
                   nothing. See docs/scheduling_priority.md, "Sub-sort model". -->
              <div class="pl-seq-block">
                <div class="pl-seq-title">${Util.t('ui.effective_sequence')}</div>
                <div id="sys-effective-sequence"></div>
              </div>
            </div>
          </div>

        </div>

        <!-- Stage 0 setup truth is maintained beside the plant's scheduling
             policy, never inside a timeline/optimizer flow. It remains
             observation-only until a later stage explicitly enables use. -->
        <div id="settings-subtab-setup" role="tabpanel" aria-labelledby="settings-subtab-setup-tab" style="display:${subTabVisibility.setup ? 'block' : 'none'};padding:8px 0 32px" ${subTabVisibility.setup ? '' : 'hidden'}>
          <div id="setup-admin-pane"></div>
        </div>

      </div></div>`;

    pane.querySelectorAll<HTMLButtonElement>('[data-settings-subtab]').forEach(button => button.addEventListener('click', () => {
      const next = button.dataset.settingsSubtab as 'rules' | 'setup';
      if (next === Plant._currentSettingsSubTab) return;
      Plant._currentSettingsSubTab = next;
      Plant._renderSettingsPane();
    }));

    const alertDaysInp = pane.querySelector('#sys-alert-horizon-days') as HTMLInputElement;
    const confDaysInp  = pane.querySelector('#sys-conf-horizon-days') as HTMLInputElement;
    const splitPolicySelect = pane.querySelector('#sys-split-order-policy') as HTMLSelectElement;

    alertDaysInp.value = String(Math.max(1, Math.round(alertHz / 1440)));
    confDaysInp.value  = String(Math.max(1, Math.round(confHz  / 1440)));
    const savedSplitPolicy = plantRow?.split_order_policy;
    splitPolicySelect.value = savedSplitPolicy === 'overlong_only' || savedSplitPolicy === 'partial_allowed'
      ? savedSplitPolicy : 'never';

    async function _savePlantHorizon(patch: Record<string, number>): Promise<boolean> {
      if (!plantRow) { Toast.show(Util.t('toast.no_plant_selected'), 'warn'); return false; }
      try {
        const r = await fetch(`${Config.API_BASE}/master-data/plants/bulk`, {
          method:  'POST',
          headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
          body:    JSON.stringify({ upserts: [{ subnetwork: plantRow.subnetwork, plant: plantRow.plant, ...patch }], deletes: [] }),
        });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || `HTTP ${r.status}`); }
        Object.assign(plantRow, patch); // commit to Store only once the write is confirmed
        return true;
      } catch (e) {
        Toast.show(Util.t('toast.horizon_save_failed', { msg: (e as Error).message }), 'error');
        return false;
      }
    }

    function readAlertMinutes(): number {
      const days = Math.max(1, parseInt(alertDaysInp.value, 10) || 1);
      return days * 1440;
    }

    function readConfMinutes(): number {
      const days = Math.max(1, parseInt(confDaysInp.value, 10) || 1);
      return days * 1440;
    }

    async function saveAlert(): Promise<void> {
      const prevMin = plantRow?.alt_flag_horizon ?? Store.userSettings.alertHorizonMinutes ?? 43200;
      const totalMin = readAlertMinutes();
      Store.setUserSettings({ alertHorizonMinutes: totalMin }, 'system-settings');
      const ok = await _savePlantHorizon({ alt_flag_horizon: totalMin });
      if (!ok) {
        Store.setUserSettings({ alertHorizonMinutes: prevMin }, 'system-settings');
        alertDaysInp.value = String(Math.max(1, Math.round(prevMin / 1440)));
      }
      AlertsUIAdapter.renderBell();
      if (document.getElementById('alert-drawer')?.classList.contains('open')) AlertsUIAdapter.renderDrawer();
    }

    async function saveConf(): Promise<void> {
      const prevMin = plantRow?.conf_score_horizon ?? Store.userSettings.confidenceHorizonMinutes ?? 20160;
      const totalMin = readConfMinutes();
      Store.setUserSettings({ confidenceHorizonMinutes: totalMin }, 'system-settings');
      const ok = await _savePlantHorizon({ conf_score_horizon: totalMin });
      if (!ok) {
        Store.setUserSettings({ confidenceHorizonMinutes: prevMin }, 'system-settings');
        confDaysInp.value = String(Math.max(1, Math.round(prevMin / 1440)));
      }
      if (typeof NIMBUS !== 'undefined' && NIMBUS.Confidence?._recomputeDebounced)
        NIMBUS.Confidence._recomputeDebounced();
    }

    alertDaysInp.addEventListener('change', saveAlert);
    confDaysInp.addEventListener('change', saveConf);

    splitPolicySelect.addEventListener('change', async () => {
      if (!plantRow) { Toast.show(Util.t('toast.no_plant_selected'), 'warn'); return; }
      const previous = plantRow.split_order_policy === 'overlong_only' || plantRow.split_order_policy === 'partial_allowed'
        ? plantRow.split_order_policy : 'never';
      const next = splitPolicySelect.value;
      if (!['never', 'overlong_only', 'partial_allowed'].includes(next)) {
        splitPolicySelect.value = previous;
        return;
      }
      splitPolicySelect.disabled = true;
      try {
        const response = await Util.fetchTraced(
          `${Config.API_BASE}/master-data/plants/${encodeURIComponent(plantRow.plant)}/split-order-policy`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
            body: JSON.stringify({ subnetwork: plantRow.subnetwork, split_order_policy: next }),
          },
        );
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.detail || `HTTP ${response.status}`);
        }
        plantRow.split_order_policy = next as 'never' | 'overlong_only' | 'partial_allowed';
        Toast.show('Split-order policy saved for this plant.', 'success');
      } catch (error) {
        splitPolicySelect.value = previous;
        Toast.show(`Could not save split-order policy: ${(error as Error).message}`, 'error');
      } finally {
        splitPolicySelect.disabled = false;
      }
    });

    // --- Scheduling constraints (per-plant PRIORITY TREE) -------------------
    // Stage 3 of docs/scheduling_priority.md rebuilt this from a flat on/off
    // list into an indented tree: a field can be nested under another field to
    // sub-sort within it. Per that doc's "Sub-sort model" decision the tree is
    // presentational — a field nested under a field is mathematically
    // identical to the next key in a lexicographic sort — so
    // Engine.flattenConstraints is the SINGLE source of truth for the collapse
    // (pre-order DFS, disabled subtrees skipped, duplicate keys dropped) and
    // is deliberately NOT reimplemented here. The "Effective sequence" panel
    // below the tree is what keeps the nesting honest rather than a fiction.
    //
    // DATA-LOSS FIX — the reason this block is a rewrite rather than an
    // extension. The flat version rebuilt its in-memory state by mapping over
    // Engine.CONSTRAINT_CATALOG and serialized each node as
    // `{key, enabled, order}` with no `children`. So ANY save from this panel
    // (even an unrelated toggle) silently (a) flattened a stored nested tree
    // and (b) dropped every stored key the local catalog didn't happen to
    // list. Both directions are now tree-shaped end to end: `_cloneTree`
    // preserves whatever shape the backend returned, including unknown keys,
    // and `_serializeTree` emits `children` recursively.
    const consListEl = pane.querySelector('#sys-constraints-list') as HTMLElement | null;
    const seqPanelEl = pane.querySelector('#sys-effective-sequence') as HTMLElement | null;
    // Mirrors master_data._normalize_constraint_tree's own cap: a deeper tree
    // is rejected server-side, so the UI must never offer to build one.
    const MAX_DEPTH = 3;
    let consTree: ConstraintConfig[] = [];
    // null = unknown (the rank-map probe has not succeeded for this plant yet).
    // Only `true` licenses the per-node "no list uploaded" hints below — see
    // applyRankHints; asserting "no list" off a failed probe is exactly what the
    // old `.catch(() => {})` avoided.
    let _ranksLoaded: boolean | null = null;

    // Same escape used elsewhere in this file. Constraint keys are normally
    // backend-registry values, but plants.constraints JSONB stores whatever
    // `key` a POST supplied (master_data._normalize_constraint_tree only
    // `str()`s it), and Util.t echoes an unknown key back verbatim — so a
    // stored key reaches innerHTML as text and must be escaped.
    const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]);

    /** Display label for a constraint key. Locale first (Stage 2 registered
     *  `constraint.<field_key>` for all five locales); Util.t echoes the key
     *  back when there's no entry, in which case the backend registry's own
     *  `default_label` reads far better than a raw `constraint.prtXX`. */
    function _label(key: string): string {
      const s = Util.t(`constraint.${key}`);
      if (s !== `constraint.${key}`) return s;
      return Engine.CONSTRAINT_CATALOG.find(c => c.key === key)?.label || key;
    }

    /** Deep clone of a persisted tree, dropping NOTHING — nested `children`
     *  and keys absent from the local catalog both survive verbatim (see the
     *  DATA-LOSS FIX note above). Each sibling group is sorted by `order` with
     *  the same `?? 99` fallback and stable tie-break Engine.flattenConstraints
     *  uses, so the on-screen order can never disagree with the order the
     *  optimizer walks. */
    function _cloneTree(nodes: ConstraintConfig[]): ConstraintConfig[] {
      return [...nodes]
        .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
        .map(n => {
          const out: ConstraintConfig = {
            key:     String(n.key),
            enabled: !!n.enabled,
            order:   Number.isFinite(n.order) ? n.order! : 99,
          };
          if (Array.isArray(n.children) && n.children.length) out.children = _cloneTree(n.children);
          return out;
        });
    }

    /** Renumber every sibling group's `order` to 1..n in place — the tree
     *  counterpart of the flat version's
     *  `consState.forEach((c, idx) => { c.order = idx + 1; })`. */
    function _renumberTree(nodes: ConstraintConfig[]): void {
      nodes.forEach((n, i) => { n.order = i + 1; if (n.children) _renumberTree(n.children); });
    }

    /** Wire payload for the whole tree: `{key, enabled, order}` PLUS a
     *  recursive `children` array wherever one exists. This is the half the
     *  flat version was missing, and the reason a save used to flatten a
     *  stored tree. Empty `children` arrays (left behind by removing a node's
     *  last child) are omitted rather than persisted as `[]`. */
    function _serializeTree(nodes: ConstraintConfig[]): ConstraintConfig[] {
      return nodes.map(n => {
        const out: ConstraintConfig = { key: n.key, enabled: !!n.enabled, order: n.order ?? 0 };
        if (n.children && n.children.length) out.children = _serializeTree(n.children);
        return out;
      });
    }

    /** Resolve a row's `data-path` ("0.2.1" => consTree[0].children[2].children[1])
     *  to its node, the sibling array holding it, and its index there.
     *  Handlers address nodes by PATH, not by key: the same key may legally
     *  appear more than once in the tree (that's how `PRT01 -> Color` is
     *  expressed, with the repeat marked "(no effect)"), so `data-key` would
     *  be ambiguous and would toggle/move the wrong node. */
    function _resolvePath(path: string): { node: ConstraintConfig; siblings: ConstraintConfig[]; index: number } | null {
      const parts = path.split('.').map(Number);
      let siblings: ConstraintConfig[] = consTree;
      for (let d = 0; d < parts.length; d++) {
        const node = siblings[parts[d]];
        if (!node) return null;
        if (d === parts.length - 1) return { node, siblings, index: parts[d] };
        if (!node.children) return null;
        siblings = node.children;
      }
      return null;
    }

    /** Distinct keys anywhere in the tree — the bound on how large the tree
     *  may grow (one node per registered field, plus any duplicates added
     *  before that bound was reached). */
    function countConfiguredKeys(nodes: ConstraintConfig[]): number {
      const keys = new Set<string>();
      const walk = (ns: ConstraintConfig[]): void => { for (const n of ns) { keys.add(n.key); if (n.children) walk(n.children); } };
      walk(nodes);
      return keys.size;
    }

    function renderEffectiveSequence(): void {
      if (!seqPanelEl) return;
      // flattenConstraints reads the plant's PERSISTED tree
      // (Store.masterData.plants[*].constraints) — the very same source
      // Engine._sortTerms ranks from. That is deliberate: this panel states
      // what the optimizer would do right now, not what an unsaved edit hopes
      // for. saveConstraints() re-renders it the moment a write is confirmed
      // (and reverts the whole tree if the write fails), so it converges
      // within one round trip and can never assert an edit that didn't land.
      const flat = Engine.flattenConstraints(plantName);
      // Which NODES of the tree on screen are the occurrences that actually take
      // effect — computed by Engine's own single tree walk (the very one
      // flattenConstraints runs), keyed by positional path.
      //
      // This replaces a `flat.includes(key) && !seen.has(key)` test that could
      // not distinguish two occurrences of the same key and so credited whichever
      // came FIRST in tree order. With a disabled duplicate ahead of an enabled
      // one — e.g. [prt01(on), colorWheel(OFF), prt02(on), colorWheel(on)],
      // whose real optimizer order is prt01 -> prt02 -> colorWheel — it labelled
      // the switched-OFF row "effective" (right beside its own Off toggle) and
      // the switched-ON row "(no effect)": exactly backwards, in the one panel
      // whose whole job is to tell the truth about the collapse.
      const effectivePaths = Engine.effectiveConstraintPaths(consTree);
      const arrow = ` <span class="pl-seq-arrow">&rarr;</span> `;
      const nodesInTreeOrder: Array<{ key: string; path: string }> = [];
      const collect = (nodes: ConstraintConfig[], prefix: string): void => {
        nodes.forEach((n, i) => {
          const path = prefix ? `${prefix}.${i}` : String(i);
          nodesInTreeOrder.push({ key: n.key, path });
          if (n.children) collect(n.children, path);
        });
      };
      collect(consTree, '');

      if (!nodesInTreeOrder.length) {
        // An empty tree is not necessarily "no constraints": for a plant with
        // nothing stored, flattenConstraints falls back to the catalog default
        // (colorWheel on) and the optimizer really does apply it. Show that
        // fallback rather than claiming nothing is in effect.
        seqPanelEl.innerHTML = flat.length
          ? flat.map(k => `<span class="pl-seq-chip">${esc(_label(k))}</span>`).join(arrow)
          : `<span class="pl-seq-empty">${esc(Util.t('ui.no_constraints_configured'))}</span>`;
        return;
      }

      seqPanelEl.innerHTML = nodesInTreeOrder.map(({ key, path }) => {
        // Not effective => this node (or an ancestor) is switched off, or another
        // reachable occurrence of the same key already claimed the slot, or the
        // key is not in the PERSISTED tree yet (an unsaved add — `flat` is the
        // persisted collapse, so a pending edit can never claim to be in force).
        const isEffective = effectivePaths.has(path) && flat.includes(key);
        return `<span class="pl-seq-chip${isEffective ? '' : ' pl-seq-chip-noeffect'}">${esc(_label(key))}`
             + `${isEffective ? '' : ` <em>(${esc(Util.t('ui.no_effect'))})</em>`}</span>`;
      }).join(arrow);
    }

    /** The field picker behind "+ Add sub-priority" / "+ Add priority" — a
     *  native <select>, not a button, for two reasons:
     *    1. The user must be able to CHOOSE the field, including one already
     *       used elsewhere in the tree (that's the only way to express
     *       `PRT01 -> Color`); a button auto-picking "the first unused field"
     *       could not build that tree at all.
     *    2. CLAUDE.md's production-scale rule: a plant/line/field list must
     *       never become a bubble/chip selector. A <select> is the shape that
     *       upgrades cleanly to a searchable combobox if the registry grows.
     *  Disabled once every registered field already appears somewhere in the
     *  tree — the tree's own size bound. */
    function _addPicker(cls: string, enabled: boolean, placeholder: string): string {
      const opts = Engine.CONSTRAINT_CATALOG
        .map(c => `<option value="${esc(c.key)}">${esc(_label(c.key))}</option>`).join('');
      return `<select class="cons-add ${cls}" ${enabled ? '' : 'disabled'}`
           + ` title="${esc(enabled ? placeholder : Util.t('ui.all_fields_used'))}">`
           + `<option value="" selected>+ ${esc(placeholder)}</option>${opts}</select>`;
    }

    function renderConstraints(): void {
      if (!consListEl) return;
      // One node per registered field is the ceiling: past that, every
      // additional node is a guaranteed duplicate, which flattenConstraints
      // drops anyway.
      const canAddAnywhere = countConfiguredKeys(consTree) < Engine.CONSTRAINT_CATALOG.length;

      const renderNode = (node: ConstraintConfig, siblings: ConstraintConfig[], depth: number, path: string): string => {
        const cat = Engine.CONSTRAINT_CATALOG.find(x => x.key === node.key);
        // "Enabled but no list uploaded", for EVERY rankable field, not just
        // colorWheel (N11, docs/scheduling_priority.md). Since Stage 3 every
        // enabled node contributes a real sort term, so any of them can be
        // silently inert. Gated on `_ranksLoaded === true` so a failed probe
        // shows nothing rather than asserting "no list", and on node.enabled
        // because a switched-off row's missing list is not a problem to flag.
        const noList = (_ranksLoaded === true && node.enabled && !Engine.hasPriorityRanks(node.key));
        const idx = siblings.indexOf(node);
        // At the deepest allowed level the add-child control is omitted
        // outright rather than rendered disabled — there is no honest tooltip
        // for "this is as deep as the data model goes" that isn't noise on
        // every leaf, and the server would reject the write regardless.
        const canNest = depth + 1 < MAX_DEPTH;
        // Children are rendered as DOM siblings with a left margin, not nested
        // inside the parent row: .constraint-list is a flex column, and a flat
        // row list keeps the per-row querySelector wiring below unambiguous.
        const childrenHtml = (node.children || [])
          .map((c, ci) => renderNode(c, node.children!, depth + 1, `${path}.${ci}`)).join('');
        return `
          <div class="constraint-row" data-path="${path}" data-depth="${depth}" style="margin-left:${depth * 24}px">
            <div class="cons-reorder">
              <button class="cons-up" ${idx === 0 ? 'disabled' : ''} title="${esc(Util.t('ui.move_up'))}">&#9650;</button>
              <button class="cons-dn" ${idx === siblings.length - 1 ? 'disabled' : ''} title="${esc(Util.t('ui.move_down'))}">&#9660;</button>
            </div>
            <div class="cons-meta">
              <div class="cons-label">${esc(_label(node.key))}</div>
              <div class="cons-desc">${cat?.desc || ''}${noList ? ` <span class="cons-warn">${esc(Util.t('ui.constraint_no_list'))}</span>` : ''}</div>
            </div>
            <label class="cons-toggle">
              <input type="checkbox" ${node.enabled ? 'checked' : ''}>
              <span>${esc(Util.t(node.enabled ? 'ui.constraint_on' : 'ui.constraint_off'))}</span>
            </label>
            ${canNest ? _addPicker('cons-add-child', canAddAnywhere, Util.t('ui.add_sub_priority')) : ''}
            <button class="btn btn-ghost sm cons-remove" title="${esc(Util.t('btn.remove'))}">${esc(Util.t('btn.remove'))}</button>
          </div>
          ${childrenHtml}`;
      };

      // The root-level picker is not optional garnish: without it, removing
      // every row (or opening a plant whose stored tree omits a field) would
      // leave no way to put a field back.
      consListEl.innerHTML = consTree.map((n, i) => renderNode(n, consTree, 0, String(i))).join('')
        + `<div class="constraint-add-row">${_addPicker('cons-add-root', canAddAnywhere, Util.t('ui.add_priority'))}</div>`;

      consListEl.querySelectorAll<HTMLElement>('.constraint-row').forEach(rowEl => {
        const path = rowEl.dataset.path!;
        rowEl.querySelector<HTMLInputElement>('.cons-toggle input')!.addEventListener('change', e => {
          const hit = _resolvePath(path);
          if (hit) hit.node.enabled = (e.target as HTMLInputElement).checked;
          renderConstraints();
          saveConstraints();
        });
        rowEl.querySelector('.cons-up')!.addEventListener('click', () => moveConstraint(path, -1));
        rowEl.querySelector('.cons-dn')!.addEventListener('click', () => moveConstraint(path, +1));
        rowEl.querySelector('.cons-remove')!.addEventListener('click', () => removeConstraint(path));
        rowEl.querySelector<HTMLSelectElement>('.cons-add-child')?.addEventListener('change', e => {
          const sel = e.target as HTMLSelectElement;
          const key = sel.value;
          sel.value = '';  // the picker is a control, not a state holder
          if (key) addConstraint(path, key);
        });
      });
      consListEl.querySelector<HTMLSelectElement>('.cons-add-root')?.addEventListener('change', e => {
        const sel = e.target as HTMLSelectElement;
        const key = sel.value;
        sel.value = '';
        if (key) addConstraint(null, key);
      });

      renderEffectiveSequence();
    }

    /** Reorder within the sibling group only — moving a node between levels is
     *  what the remove/add pair is for. */
    function moveConstraint(path: string, dir: number): void {
      const hit = _resolvePath(path);
      if (!hit) return;
      const j = hit.index + dir;
      if (j < 0 || j >= hit.siblings.length) return;
      [hit.siblings[hit.index], hit.siblings[j]] = [hit.siblings[j], hit.siblings[hit.index]];
      renderConstraints();
      saveConstraints();
    }

    /** Removes the node AND its subtree: those children were sub-sorts *of*
     *  this node, so re-parenting them to the grandparent would silently
     *  rewrite the effective sequence into something the user never asked
     *  for. */
    function removeConstraint(path: string): void {
      const hit = _resolvePath(path);
      if (!hit) return;
      hit.siblings.splice(hit.index, 1);
      renderConstraints();
      saveConstraints();
    }

    /** Append a node — at the root when `parentPath` is null, otherwise as the
     *  last child of that node. Enabled on creation (you added it because you
     *  want it); a child added under a switched-off parent is born inert,
     *  which the parent's own "Ignored" label and the child's "(no effect)"
     *  chip both state plainly, so the parent's state is left alone rather
     *  than silently flipped on. */
    function addConstraint(parentPath: string | null, key: string): void {
      const node: ConstraintConfig = { key, enabled: true, order: 99 };
      if (parentPath === null) {
        consTree.push(node);
      } else {
        const hit = _resolvePath(parentPath);
        if (!hit) return;
        if (!hit.node.children) hit.node.children = [];
        hit.node.children.push(node);
      }
      renderConstraints();
      saveConstraints();
    }

    /** Rebuild the working tree from the last-known-persisted
     *  plantRow.constraints, PRESERVING its shape verbatim — nesting and
     *  unknown keys both survive (the flat version mapped over
     *  Engine.CONSTRAINT_CATALOG instead, which is exactly what destroyed
     *  both). Only a plant that has never been configured falls back to the
     *  catalog, and then seeded with its ENABLED defaults only — the exact
     *  mirror of Engine.flattenConstraints' own never-configured fallback
     *  (`CONSTRAINT_CATALOG.filter(constraintEnabled).map(key)`), so the tree
     *  on screen and the sequence the optimizer runs agree from the very first
     *  render.
     *
     *  The flat version instead seeded ALL catalog keys (with the unused ones
     *  rendered as inert "Ignored" rows). That cannot carry over: with every
     *  registered field already in the tree, `countConfiguredKeys(consTree) <
     *  CONSTRAINT_CATALOG.length` is false on the very first render, so every
     *  "+ Add sub-priority" picker would be born disabled and NO plant could
     *  ever be nested. Seeding only the enabled defaults leaves the unused
     *  fields one pick away in the root "+ Add priority" control instead of
     *  occupying a slot to say they're off.
     *
     *  Shared by init and by saveConstraints' failure path, since
     *  plantRow.constraints is only mutated once a write is confirmed — it is
     *  always the truth to revert to. */
    function rebuildConsTreeFromPersisted(): void {
      const stored: ConstraintConfig[] | null = Array.isArray(plantRow?.constraints) ? plantRow!.constraints! : null;
      consTree = (stored && stored.length)
        ? _cloneTree(stored)
        : Engine.CONSTRAINT_CATALOG
            .filter(cat => Engine.constraintEnabled(plantName, cat.key))
            .map((cat, i) => ({ key: cat.key, enabled: true, order: i + 1 }));
    }

    async function saveConstraints(): Promise<void> {
      if (!plantRow) { Toast.show(Util.t('toast.no_plant_selected'), 'warn'); return; }
      _renumberTree(consTree);
      const payload = _serializeTree(consTree);  // full tree, `children` included
      try {
        const r = await fetch(`${Config.API_BASE}/master-data/plants/${encodeURIComponent(plantRow.plant)}/constraints`, {
          method:  'POST',
          headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
          body:    JSON.stringify({ subnetwork: plantRow.subnetwork, constraints: payload }),
        });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || `HTTP ${r.status}`); }
        plantRow.constraints = payload;  // commit to Store only once the write is confirmed
        renderEffectiveSequence();       // the persisted tree just changed — re-read it
      } catch (e) {
        Toast.show(Util.t('toast.constraints_save_failed', { msg: (e as Error).message }), 'error');
        rebuildConsTreeFromPersisted();
        renderConstraints();
      }
    }

    (function initConstraints() {
      rebuildConsTreeFromPersisted();
      renderConstraints();
      // Whether each enabled field actually has a list uploaded (hint only — the
      // toggles work regardless, since enabling a field with no list is a
      // harmless no-op: every rank lookup just returns 999999).
      //
      // Stage 3: reads the same Store.priorityRankMaps that Engine._sortTerms
      // ranks from, via the shared Engine.hasPriorityRanks, instead of the old
      // plant-wide-only `GET /color-wheel/{plant}` probe. Two reasons: this hint
      // and OptimizeDialog's badge / pre-Run confirm were two independent
      // readings of "does this plant have a list" that could disagree, and the
      // narrow probe mis-reported a plant configured purely with per-line
      // overrides as having none. `plantName` is Store.selectedPlant (see above),
      // so the shared non-plant-keyed cache is always the right one to read here.
      //
      // One flag for the whole tree, not one per field: `_ranksLoaded` records
      // only whether the CACHE is trustworthy; renderNode then asks
      // Engine.hasPriorityRanks per node, so a field added to the tree later in
      // this same session picks its hint up on the next render with no refetch.
      if (plantName) {
        const applyRankHints = () => {
          if (Persistence._rankMapsPlant !== plantName) return;
          _ranksLoaded = true;
          renderConstraints();
        };
        if (Persistence._rankMapsPlant === plantName) applyRankHints();
        else Persistence.loadPriorityRankMaps(plantName).then(applyRankHints);
      }
    })();
    SetupAdmin.render(pane.querySelector<HTMLElement>('#setup-admin-pane'), plantName);
  },
};

/** Minimal modal-DOM adapter for the Task 10 `#modal-priority-mapping` markup
 *  (`web/index.html`) — shown when a priority-list upload's headers don't
 *  match the expected value/rank column names and the backend responds
 *  `{status:'needs_mapping', headers, sample}` (see `Plant._uploadPriorityList`
 *  above). Deliberately tiny: it only shuttles the user's column picks back
 *  to whichever `onConfirm` callback the caller supplied. */
export const PriorityListMapping = (() => {
  let _onConfirm: ((valueCol: string, rankCol: string) => void) | null = null;
  // Fired only when the modal is DISMISSED (backdrop / × / Cancel), never when
  // confirm() closes it — confirm() clears this first. Lets the caller undo the
  // "Uploading <file>…" status line it set before the needs_mapping round-trip.
  let _onCancel: (() => void) | null = null;

  // headers/sample come straight from the uploaded spreadsheet's own column
  // names and cell values — genuinely untrusted content (e.g. a header of
  // `<img src=x onerror=...>` would otherwise execute in an admin's
  // browser). Same escape regex this file uses everywhere else (see
  // `_renderOptimization`'s local `esc`).
  const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]);

  function open(headers: string[], sample: Record<string, unknown>[],
                onConfirm: (v: string, r: string) => void, onCancel?: () => void): void {
    _onConfirm = onConfirm;
    _onCancel = onCancel || null;
    const valSel = document.getElementById('pl-mapping-value-col') as HTMLSelectElement;
    const rankSel = document.getElementById('pl-mapping-rank-col') as HTMLSelectElement;
    valSel.innerHTML = headers.map(h => `<option value="${esc(h)}">${esc(h)}</option>`).join('');
    // ROW_ORDER_SENTINEL, not '' — an empty value is indistinguishable server-side
    // from "the client sent no rank_column at all", so brain.py's
    // _resolve_priority_list_columns fell through to auto-detection and could rank
    // by a column (e.g. ORDER) the user had just explicitly declined. Must stay in
    // sync with brain.ROW_ORDER_SENTINEL and index.html's static <option>.
    rankSel.innerHTML = `<option value="${ROW_ORDER_SENTINEL}">${Util.t('ui.mapping_rank_none')}</option>` +
      headers.map(h => `<option value="${esc(h)}">${esc(h)}</option>`).join('');
    const sampleEl = document.getElementById('pl-mapping-sample');
    if (sampleEl) {
      sampleEl.innerHTML = `<table class="pl-sample-table"><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
        sample.slice(0, 5).map(row => `<tr>${headers.map(h => `<td>${esc(row[h])}</td>`).join('')}</tr>`).join('')
      }</tbody></table>`;
    }
    const el = document.getElementById('modal-priority-mapping');
    if (el) el.hidden = false;
  }

  function close(): void {
    const el = document.getElementById('modal-priority-mapping');
    if (el) el.hidden = true;
    const cancelled = _onCancel;
    _onConfirm = null;
    _onCancel = null;
    // confirm() nulls _onCancel before calling close(), so this only fires for a
    // genuine dismissal.
    if (cancelled) cancelled();
  }

  function confirm(): void {
    const valSel = document.getElementById('pl-mapping-value-col') as HTMLSelectElement;
    const rankSel = document.getElementById('pl-mapping-rank-col') as HTMLSelectElement;
    const cb = _onConfirm;
    _onCancel = null;
    close();
    if (cb) cb(valSel.value, rankSel.value);
  }

  return { open, close, confirm };
})();

/** `ProdLines._wireNav`'s search input carries a one-time-wiring flag, the same
 *  DOM-custom-property pattern as `Util.wirePasteToCheckboxes`'s `PasteWiredInput`
 *  (application-foundation.mts). */
type LinesNavInput = HTMLInputElement & { _wired?: boolean };

/* =============================================================================
   PRODLINES — per-line settings: capacity buffer, bottleneck, working hours,
   and line-scoped blackout blocks.
   ========================================================================== */
export const ProdLines = {
  _lineSearch: '', // search text for the cross-screen line-filter dropdown (not the selection itself)
  _activeNavLine: null as string | null,
  _delegated: false,
  _fpBlkStart: null as NimbusVendor.FlatpickrInstance | null,
  _fpBlkEnd: null as NimbusVendor.FlatpickrInstance | null,

  render(): void {
    const body = document.getElementById('lines-body');
    if (!body) return;
    const allLines = Store.selectedPlant ? Store.linesForSelectedPlant() : CalendarUI._getLines();

    allLines.forEach(l => {
      Store.ensureCalendar(l);
      Store.ensureLineSettings(l);
    });

    const filterBar = document.getElementById('lines-filter-bar');
    if (filterBar) {
      filterBar.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px;font-size:13px;">
          <span style="color:var(--text-muted,#64748b);">Plant</span>
          <span class="plant-badge">${Store.selectedPlant || '—'}</span>
        </div>`;
    }

    // Cross-screen production-line filter (Store.selectedLines) — same
    // selection as the Scheduling Board / Dashboard / Labor Plan pickers.
    // Type-to-filter within the dropdown itself (ProdLines._lineSearch)
    // narrows the checklist, not this nav list directly.
    const lineSel = Store.selectedLines;
    const shownLines = lineSel.size === 0 ? allLines : allLines.filter(l => lineSel.has(l));

    // Default or reset active line if stale
    if (!ProdLines._activeNavLine || !allLines.includes(ProdLines._activeNavLine)) {
      ProdLines._activeNavLine = allLines[0] || null;
    }

    ProdLines._renderNav(allLines, shownLines);
    ProdLines._wireNav();

    if (!allLines.length) {
      body.innerHTML = `<div class="lines-detail-empty">${Util.t('empty.no_lines_loaded')}</div>`;
      return;
    }

    ProdLines._renderDetail(ProdLines._activeNavLine);
  },

  _renderDetail(line: string | null): void {
    const body = document.getElementById('lines-body');
    if (!body || !line) {
      if (body) body.innerHTML = `<div class="lines-detail-empty">${Util.t('empty.select_line_configure')}</div>`;
      return;
    }

    const allLines = Store.selectedPlant ? Store.linesForSelectedPlant() : CalendarUI._getLines();
    const gi = allLines.indexOf(line);
    const color = Config.COLORS[gi % Config.COLORS.length];
    const ls = Store.lineSettings[line] || {};
    const cal = Store.calendars[line]?.workHours || {};
    const dayLabels = ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => Util.t(k));

    const hoursPills = [0,1,2,3,4,5,6].map(d => {
      const wh = cal[d];
      const label = dayLabels[d];
      const time = wh ? `${ProdLines._fmtHour(wh[0])}–${ProdLines._fmtHour(wh[1])}` : Util.t('ui.off');
      return `<div class="line-hours-pill ${wh ? 'on' : 'off'}">
        <span class="lhp-day">${label}</span>
        <span class="lhp-time">${time}</span>
      </div>`;
    }).join('');

    body.innerHTML = `<div class="lines-detail">
      <div class="ld-header">
        <span class="line-dot" style="background:${color};width:14px;height:14px;border-radius:50%;display:inline-block;flex-shrink:0;"></span>
        <span class="ld-name">${line}</span>
        <span class="plant-badge" style="margin-left:auto;">${Store.selectedPlant || '—'}</span>
      </div>
      <div class="ld-settings-row">
        <label class="ld-ctrl-label">
          <input type="checkbox" class="line-bottleneck-chk" ${ls.bottleneck ? 'checked' : ''} data-line="${line}">
          ${Util.t('ui.bottleneck')}
        </label>
        <label class="ld-ctrl-label">
          <input type="checkbox" class="line-excl-opt-chk" ${ls.excludeFromOpt ? 'checked' : ''} data-line="${line}">
          ${Util.t('ui.excl_optimizer_full')}
        </label>
        <span class="ld-buffer">
          <span class="ld-buffer-label">${Util.t('ui.buffer_label')}</span>
          <span class="buf-seg">
            <button class="seg-btn buf-unit-btn ${ls.bufferUnit === 'pct' ? 'active' : ''}" data-line="${line}" data-unit="pct">%</button>
            <button class="seg-btn buf-unit-btn ${ls.bufferUnit === 'hours' ? 'active' : ''}" data-line="${line}" data-unit="hours">hrs</button>
          </span>
          <input type="number" class="input buf-pct-input" ${ls.bufferUnit !== 'pct' ? 'style="display:none"' : ''} min="0" max="100" step="1" value="${ls.bufferPct || 0}" data-line="${line}">
          <input type="number" class="input buf-hrs-input" ${ls.bufferUnit !== 'hours' ? 'style="display:none"' : ''} min="0" step="0.25" value="${ls.bufferHours || 0}" data-line="${line}">
        </span>
        <span class="ld-buffer">
          <span class="ld-buffer-label">Production Line Group</span>
          <input type="text" class="input plgroup-input" style="width:140px;" value="${(ls.plGroup||'').replace(/"/g,'&quot;')}" data-line="${line}" placeholder="e.g. PREMIUM">
        </span>
      </div>
      <div class="ld-section">
        <div class="ld-section-head">
          <span class="ld-section-title">${Util.t('ui.working_hours_section')}</span>
          <button class="btn btn-ghost sm" onclick="NIMBUS.EditCalendar.open('${line}')">${Util.t('btn.edit_calendar')}</button>
        </div>
        <div class="ld-section-body">
          <div class="line-hours-pills">${hoursPills}</div>
        </div>
      </div>
      <div class="ld-section">
        <div class="ld-section-head">
          <span class="ld-section-title">${Util.t('ui.line_blackouts_section')}</span>
          <button class="btn btn-ghost sm" onclick="NIMBUS.ProdLines.openBlockModal('${line}')">+ Add</button>
        </div>
        <div class="ld-section-body">
          <div class="line-blocks-list" id="line-blocks-${line}">${ProdLines._renderLineBlocks(line)}</div>
        </div>
      </div>
    </div>`;

    ProdLines._ensureDelegated();
  },

  _renderNav(allLines: string[], shownLines: string[]): void {
    const nav = document.getElementById('lines-nav');
    if (!nav) return;
    const items = shownLines.map((line) => {
      const gi = allLines.indexOf(line);
      const color = Config.COLORS[gi % Config.COLORS.length];
      const ls = Store.lineSettings[line] || {};
      const isActive = ProdLines._activeNavLine === line;
      return `<div class="lines-nav-item${isActive ? ' active' : ''}" data-line="${line}">
        <span class="line-dot" style="background:${color};display:inline-block;width:7px;height:7px;border-radius:50%;flex-shrink:0;"></span>
        <span class="lines-nav-label">${line}</span>
        ${ls.bottleneck ? '<span class="lines-nav-bottleneck" title="Bottleneck">🚧</span>' : ''}
        ${ls.excludeFromOpt ? '<span class="lines-nav-excl-opt" title="Excluded from optimization">🚫</span>' : ''}
      </div>`;
    }).join('');
    // Cross-screen multi-select filter (Store.selectedLines) replaces the old
    // single free-text substring box — scale mandate (CLAUDE.md Production
    // Scale Roadmap): every plant/line picker must stay filterable via a
    // searchable multi-select, not a bare text box, once plants carry 70+ lines.
    if (!document.getElementById('lines-nav-filter-btn')) {
      nav.innerHTML = `
        <div class="lines-nav-header">
          <div class="lines-nav-title" id="lines-nav-title">Lines &middot; ${allLines.length}</div>
          <div class="lines-nav-filter" id="lines-nav-filter" style="position:relative;">
            <button class="seg-btn lp-group-btn" id="lines-nav-filter-btn" type="button" style="width:100%;">
              <span id="lines-nav-filter-label">All Lines</span><span style="margin-left:4px;font-size:10px;opacity:.7;">▾</span>
            </button>
            <div class="dash-filter-dropdown" id="lines-nav-filter-dropdown" hidden>
              <div class="dash-filter-paste-row">
                <input id="lines-nav-search" class="dash-filter-paste-input" type="text"
                       placeholder="${Util.t('ph.search_lines')}" autocomplete="off" spellcheck="false">
              </div>
              <div class="dash-filter-checklist" id="lines-nav-checklist"></div>
            </div>
          </div>
        </div>
        <div class="lines-nav-list" id="lines-nav-list"></div>`;
    } else {
      const t = document.getElementById('lines-nav-title');
      if (t) t.textContent = `Lines · ${allLines.length}`;
    }
    Util.refreshMultiSelectLabel(
      document.getElementById('lines-nav-filter-label'), document.getElementById('lines-nav-filter-btn'), Store.selectedLines);
    ProdLines._rebuildLineFilterChecklist(allLines);
    const listEl = document.getElementById('lines-nav-list');
    if (listEl) listEl.innerHTML = items || `<div class="lines-nav-empty">${Util.t('ui.no_lines_match')}</div>`;
  },

  // Shared by _renderNav (every render) and the filter dropdown's own search
  // input (live type-to-filter) — same split as GanttFilter's _buildLineDropdown
  // vs. _filterLineSearch.
  _rebuildLineFilterChecklist(allLines: string[]): void {
    const sorted = [...allLines].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    Util.renderLineChecklist(
      document.getElementById('lines-nav-checklist'), sorted, Store.selectedLines, ProdLines._lineSearch,
      (line, checked) => {
        const next = new Set(Store.selectedLines);
        if (checked) next.add(line); else next.delete(line);
        Store.setSelectedLines(next, 'masterdata');
      });
  },

  _wireNav(): void {
    const btn  = document.getElementById('lines-nav-filter-btn') as (HTMLButtonElement & { _wired?: boolean }) | null;
    const drop = document.getElementById('lines-nav-filter-dropdown');
    if (btn && drop && !btn._wired) {
      btn._wired = true;
      // `.lines-nav`/`.lines-nav-header` are `overflow:hidden` (so the line list
      // below scrolls correctly inside this fixed-width sidebar), which clips
      // this dropdown regardless of z-index. Move it to <body> and position it
      // from the button's own rect so it floats above the page like every
      // other line-filter dropdown instead of getting cut off.
      document.body.appendChild(drop);
      drop.classList.add('dash-filter-dropdown-portal');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const opening = drop.hidden;
        drop.hidden = !drop.hidden;
        if (opening) {
          const r = btn.getBoundingClientRect();
          drop.style.top = `${r.bottom + 4}px`;
          drop.style.left = `${r.left}px`;
        }
      });
      document.addEventListener('click', (e: MouseEvent) => {
        if (!drop.hidden && !drop.contains(e.target as Node) && e.target !== btn) drop.hidden = true;
      });
    }
    const search = document.getElementById('lines-nav-search') as LinesNavInput | null;
    if (search && !search._wired) {
      search._wired = true;
      // Reference the captured `search` rather than a `this` parameter — `.oninput`'s
      // lib.dom type is `(this: GlobalEventHandlers, ev: Event) => any`, and
      // GlobalEventHandlers has no `.value`, so a `this: HTMLInputElement` signature
      // isn't assignable to it even though the runtime `this` is always the element.
      search.oninput = function() {
        ProdLines._lineSearch = search.value;
        const allLines = Store.selectedPlant ? Store.linesForSelectedPlant() : CalendarUI._getLines();
        ProdLines._rebuildLineFilterChecklist(allLines);
      };
      Util.wirePasteToCheckboxes(search,
        () => Array.from(document.getElementById('lines-nav-checklist')?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') ?? []));
    }
    const list = document.getElementById('lines-nav-list');
    if (list) {
      list.onclick = (e: MouseEvent) => {
        const item = (e.target as HTMLElement).closest<HTMLElement>('.lines-nav-item');
        if (!item) return;
        const line = item.dataset.line;
        if (!line) return;
        ProdLines._activeNavLine = line;
        list.querySelectorAll<HTMLElement>('.lines-nav-item').forEach((i) =>
          i.classList.toggle('active', i.dataset.line === line));
        ProdLines._renderDetail(line);
      };
    }
  },

  _renderLineBlocks(line: string): string {
    const plant = Store.getPlantForLine(line);
    const lineBlocks = (Store.blocks || [])
      .filter(b => b.line === line && (!b.plant || b.plant === plant))
      .slice().sort((a, b) => (Util.parseDate(a.start)?.getTime() || 0) - (Util.parseDate(b.start)?.getTime() || 0));

    const plantBlocks = (Store.plantBlocks || [])
      .filter(b => !b.plant || b.plant === plant)
      .slice().sort((a, b) => (Util.parseDate(a.start)?.getTime() || 0) - (Util.parseDate(b.start)?.getTime() || 0));

    if (!lineBlocks.length && !plantBlocks.length) {
      return `<div style="font-size:12px;color:var(--text-muted,#888);padding:4px 0;">${Util.t('empty.no_blackouts_this_line')}</div>`;
    }

    const lineRows = lineBlocks.map(b => `
      <div class="block-row">
        <span class="ico">■</span>
        <span class="reason">${b.reason || Util.t('ui.blackouts_label', {plural: ''})}</span>
        <span class="range" title="${Util.fmtDTReadable(b.start)} → ${Util.fmtDTReadable(b.end)}">${Util.fmtBlockRange(b.start, b.end)}</span>
        <button class="btn btn-ghost sm" style="padding:2px 7px;font-size:14px;" title="${Util.t('tip.remove_block')}" onclick="NIMBUS.CalendarUI.removeBlock('${b.id}'); NIMBUS.ProdLines._renderDetail(NIMBUS.ProdLines._activeNavLine);">×</button>
      </div>`).join('');

    const plantRows = plantBlocks.map(b => `
      <div class="block-row" style="opacity:0.75;padding-left:6px;padding-right:6px;">
        <span class="ico" style="color:var(--warn,#93610a);">■</span>
        <span class="reason">${b.reason || Util.t('ui.plant_blackout_default')}</span>
        <span class="line-tag" style="background:var(--warn-soft,#f8ecd0);color:var(--warn,#93610a);">Plant</span>
        <span class="range" title="${Util.fmtDTReadable(b.start)} → ${Util.fmtDTReadable(b.end)}">${Util.fmtBlockRange(b.start, b.end)}</span>
      </div>`).join('');

    return lineRows + plantRows;
  },

  // Delegated ONCE on the persistent #lines-body container (survives the
  // innerHTML re-renders in _renderDetail), replacing the old per-render
  // _wireInputs that re-bound 6 querySelectorAll loops every edit. Every
  // control carries data-line; .buf-unit-btn also carries data-unit.
  _ensureDelegated(): void {
    if (ProdLines._delegated) return;
    const body = document.getElementById('lines-body');
    if (!body) return;
    ProdLines._delegated = true;

    body.addEventListener('change', (e: Event) => {
      const el = e.target as HTMLInputElement;
      const line = el.dataset && el.dataset.line;
      if (!line) return;
      if (el.classList.contains('line-bottleneck-chk')) {
        Store.setLineSetting(line, { bottleneck: el.checked }, 'prodlines');
        NIMBUS!.MasterData!.syncLineSettings!(line, { bottleneck: el.checked });
        Toast.show(Util.t('toast.line_settings_updated'), 'success');
      } else if (el.classList.contains('line-excl-opt-chk')) {
        Store.setLineSetting(line, { excludeFromOpt: el.checked }, 'prodlines');
        NIMBUS!.MasterData!.syncLineSettings!(line, { excludeFromOpt: el.checked });
        Toast.show(Util.t('toast.line_settings_updated'), 'success');
      } else if (el.classList.contains('buf-pct-input')) {
        const val = Math.max(0, Math.min(100, +el.value || 0));
        Store.setLineSetting(line, { bufferPct: val }, 'prodlines');
        NIMBUS!.MasterData!.syncLineSettings!(line, { bufferPct: val });
        Toast.show(Util.t('toast.buffer_updated'), 'success');
      } else if (el.classList.contains('buf-hrs-input')) {
        const val = Math.max(0, +el.value || 0);
        Store.setLineSetting(line, { bufferHours: val }, 'prodlines');
        NIMBUS!.MasterData!.syncLineSettings!(line, { bufferHours: val });
        Toast.show(Util.t('toast.buffer_updated'), 'success');
      } else if (el.classList.contains('plgroup-input')) {
        const val = el.value.trim();
        Store.setLineSetting(line, { plGroup: val }, 'prodlines');
        NIMBUS!.MasterData!.syncLineSettings!(line, { plGroup: val });
        Toast.show(Util.t('toast.line_settings_updated'), 'success');
      }
    });

    body.addEventListener('click', (e: Event) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.buf-unit-btn');
      if (!btn) return;
      const line = btn.dataset.line;
      if (!line) return;
      const unit = btn.dataset.unit as BufferUnit;
      Store.setLineSetting(line, { bufferUnit: unit }, 'prodlines');
      NIMBUS!.MasterData!.syncLineSettings!(line, { bufferUnit: unit });
      ProdLines._renderDetail(ProdLines._activeNavLine);
    });
  },

  _fmtHour(h: number): string {
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    const ampm = hh < 12 ? 'am' : 'pm';
    const h12  = hh % 12 || 12;
    return mm === 0 ? `${h12}${ampm}` : `${h12}:${String(mm).padStart(2, '0')}${ampm}`;
  },

  openBlockModal(line: string | null): void {
    const lineSel = document.getElementById('lines-blk-line') as HTMLSelectElement | null;
    if (!lineSel) { ErrorLog.error('ui', 'required DOM element missing: lines-blk-line'); return; }
    const reasonEl = document.getElementById('lines-blk-reason') as HTMLInputElement | null;
    if (!reasonEl) { ErrorLog.error('ui', 'required DOM element missing: lines-blk-reason'); return; }

    lineSel.innerHTML = CalendarUI._getLines()
      .map(l => `<option value="${l}"${l === line ? ' selected' : ''}>${l}</option>`).join('');
    if (line) lineSel.value = line;

    const now = new Date(); now.setMinutes(0, 0, 0);
    const plus1 = new Date(now.getTime() + Config.MS_HOUR);
    if (!ProdLines._fpBlkStart) {
      ProdLines._fpBlkStart = Util.fpDatetime('#lines-blk-start');
      ProdLines._fpBlkEnd   = Util.fpDatetime('#lines-blk-end');
    }
    ProdLines._fpBlkStart!.setDate(now, false);
    ProdLines._fpBlkEnd!.setDate(plus1, false);
    reasonEl.value = '';
    Modal.open('modal-lines-block');
  },

  saveBlockFromModal(): void {
    const lineEl = document.getElementById('lines-blk-line') as HTMLSelectElement | null;
    const startEl = document.getElementById('lines-blk-start') as HTMLInputElement | null;
    const endEl = document.getElementById('lines-blk-end') as HTMLInputElement | null;
    const reasonEl = document.getElementById('lines-blk-reason') as HTMLInputElement | null;
    if (!lineEl || !startEl || !endEl || !reasonEl) { ErrorLog.error('ui', 'required DOM elements missing for production lines blackout modal'); return; }

    const line   = lineEl.value;
    const start  = Util.parseDate(startEl.value);
    const end    = Util.parseDate(endEl.value);
    const reason = reasonEl.value.trim() || Util.t('ui.blackouts_label', {plural: ''});
    if (!line)          { Toast.show(Util.t('toast.select_a_line'), 'error'); return; }
    if (!start || !end) { Toast.show(Util.t('toast.please_set_start_end'), 'error'); return; }
    if (end <= start)   { Toast.show(Util.t('toast.end_must_be_after_start'), 'error'); return; }
    const plant = Store.getPlantForLine(line) || Store.selectedPlant;
    if (!plant) { Toast.show(Util.t('toast.select_plant_first'), 'warn'); return; }
    const before = Store.blocks.length;
    Store.addBlock({ line, plant, start, end, reason } as NimbusBlock, 'prodlines');
    if (Store.blocks.length > before) CalendarSync.saveLineBlackoutUpsert(Store.blocks[Store.blocks.length - 1]);
    Modal.close('modal-lines-block');
    Toast.show(Util.t('toast.blackout_added'), 'success');
    ProdLines._renderDetail(ProdLines._activeNavLine);
  },

  // Static onclick= handlers converted to real listeners (CQ-1 Phase 4 Task 1,
  // following the Phase 3 `Interaction._showMultiInspector` precedent) are
  // wired from Plant.init() below via `_wireStaticHandlers()`, since
  // CalendarUI and ProdLines have no boot-time init() of their own — Plant's
  // is the single boot-time entry point for this whole family's static
  // index.html markup (the plant-inner-tabs strip, the plant blackout "+ Add"
  // button, and the three modal Save buttons). See Plant.init() and
  // Plant._wireStaticHandlers().
};

// -- Local type declarations (this task's LaborPlanning conversion; scoped to
//    this closure-returning IIFE) ---------------------------------------------

/** `LaborPlanning`'s Aggregate-sub-tab week-columns model — one column per
 *  ISO week in the current horizon. */
interface LaborWeek {
  key: string;
  label: string;
  monday: Date;
}

/** Lasso-selection rectangle over the Aggregate grid's [group-row, week-col] cells. */
interface LaborSelRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

interface LaborDragAnchor {
  row: number;
  col: number;
}

/** `_aggrData[plant][group][periodKey] -> avail_hours`. */
type LaborAggrData = Record<string, Record<string, Record<string, number>>>;

/** A single line·day cell's stored labor-plan value + provenance — 'auto_split'
 *  (even-split disaggregation from the aggregate) or 'override' (a pinned
 *  manual edit that survives re-disaggregation until reset). */
type LaborCellSource = 'auto_split' | 'override';

interface LaborLineDayCell {
  avail_hours: number;
  source: LaborCellSource;
}

/** `_lineData[plant][line][dayKey] -> {avail_hours, source}`. */
type LaborLineData = Record<string, Record<string, Record<string, LaborLineDayCell>>>;

/** `POST /labor-plan` cell payload (aggregate group/week hours). */
interface LaborAggrCellPayload {
  pl_group: string;
  period: string;
  avail_hours: number | null;
}

/** `POST /labor-plan/line` cell payload (line/day hours + provenance). */
interface LaborLineCellPayload {
  production_line: string;
  day: string;
  avail_hours: number | null;
  source: LaborCellSource;
}

/** `_disaggregate`'s return shape — same wire shape as `LaborLineCellPayload`
 *  but `avail_hours` is always concrete (an even split always produces a
 *  number, unlike a user-initiated clear-to-null edit). */
interface LaborDisaggregatedCell {
  production_line: string;
  day: string;
  avail_hours: number;
  source: 'auto_split';
}

/** DOM-custom-property pattern (same as `LinesNavInput`/`PasteWiredInput`) —
 *  the Aggregate grid's lasso-drag listeners are wired once to the persistent
 *  container, since innerHTML is replaced on every render but the container isn't. */
type LaborGridElement = HTMLElement & { _lpDragWired?: boolean };

/** Utilization.computeMatrix's return shape, named locally since the real
 *  interface (schedule-services.mts's UtilizationMatrixResolved) is module-
 *  private to that file — same pattern as Hierarchy's/Dashboard's
 *  HierarchyUtilMatrix/DashboardUtilMatrix (schedule-workbench.mts). */
type LaborUtilMatrix = ReturnType<typeof Utilization.computeMatrix>;

/** One exceptions-sub-tab row (`_renderExceptions`). */
interface LaborException {
  sev: 'err' | 'warn';
  line: string;
  day: string;
  msg: string;
}

/** `_cellGrid`'s [row][col] -> <td> cache for the Aggregate grid's lasso paint. */
type LaborCellGrid = Array<Array<HTMLTableCellElement | null>>;

/* =============================================================================
   LABOR PLANNING — aggregate-to-line available labor hours planning
   Sub-tabs: Aggregate · Line Plan · Capacity · Exceptions · Inputs
   ========================================================================== */
export const LaborPlanning = (() => {
  // ── State ────────────────────────────────────────────────────────────────
  let _horizonOffset  = 0;         // weeks offset from today's Monday
  let _horizonSpan    = 12;        // number of weeks in view
  let _selectedGroups: Set<string> = new Set(); // empty = all groups; used to scope all sub-tabs
  let _lineSearch = ''; // current search text for the cross-screen line-filter dropdown
  let _aggrData: LaborAggrData = {};        // { [plant]: { [grp]: { [period]: avail_hours } } }
  let _lineData: LaborLineData = {};        // { [plant]: { [line]: { [day]: { avail_hours, source } } } }
  let _groups: string[]       = [];        // sorted unique pl_group values for current plant
  let _displayGroups: string[] = [];        // currently rendered subset (respects _selectedGroups filter)
  let _weeks: LaborWeek[]        = [];   // [{ key:'YYYY-Www', label:'MM/DD/YY', monday:Date }]
  let _selRange: LaborSelRange | null       = null; // { r0,c0,r1,c1 } lasso rectangle, or null
  let _dragging      = false;
  let _dragAnchor: LaborDragAnchor | null     = null;
  let _fpHorizon: NimbusVendor.FlatpickrInstance | null      = null; // Flatpickr instance for the date-jump input
  let _cellGrid: LaborCellGrid | null       = null; // [r][c] -> <td> cache for the Aggregate grid (built per render)
  let _selTds: Set<HTMLTableCellElement>        = new Set(); // currently-highlighted <td>s, for incremental lasso diffing

  // ── Date helpers ─────────────────────────────────────────────────────────
  function _isoWeek(date: Date): string {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / Config.MS_DAY + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }

  function _weekLabel(monday: Date): string {
    const m = String(monday.getMonth() + 1).padStart(2, '0');
    const d = String(monday.getDate()).padStart(2, '0');
    const y = String(monday.getFullYear()).slice(-2);
    return `${m}/${d}/${y}`;
  }

  function _computeWeeks(): LaborWeek[] {
    const now    = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7) + _horizonOffset * 7);
    const weeks: LaborWeek[] = [];
    for (let i = 0; i < _horizonSpan; i++) {
      const d = new Date(monday); d.setDate(monday.getDate() + i * 7);
      weeks.push({ key: _isoWeek(d), label: _weekLabel(new Date(d)), monday: new Date(d) });
    }
    return weeks;
  }

  function _isoWeekToMonday(isoKey: string): Date {
    const [year, week] = isoKey.split('-W');
    const y = parseInt(year, 10), w = parseInt(week, 10);
    const jan4 = new Date(y, 0, 4);
    const dow  = jan4.getDay() || 7;
    const week1Mon = new Date(jan4); week1Mon.setDate(jan4.getDate() - (dow - 1));
    const monday   = new Date(week1Mon); monday.setDate(week1Mon.getDate() + (w - 1) * 7);
    return monday;
  }

  // ── Backend helpers ───────────────────────────────────────────────────────
  function _subnetwork(plant: string | null): string {
    return (Store._state.masterData?.plants || []).find((p) => p.plant === plant)?.subnetwork || '';
  }

  async function _saveAggregate(subnetwork: string, plant: string, cells: LaborAggrCellPayload[]): Promise<void> {
    try {
      const r = await fetch(`${Config.API_BASE}/labor-plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
        body: JSON.stringify({ subnetwork, plant, cells }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.detail || `HTTP ${r.status}`); }
    } catch (e) {
      Toast.show(`Labor plan save failed: ${(e as Error).message}`, 'error');
      ErrorLog.error('labor', `Save aggregate failed: ${(e as Error).message}`);
    }
  }

  async function _saveLines(subnetwork: string, plant: string, cells: LaborLineCellPayload[]): Promise<void> {
    if (!cells.length) return;
    try {
      const r = await fetch(`${Config.API_BASE}/labor-plan/line`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
        body: JSON.stringify({ subnetwork, plant, cells }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.detail || `HTTP ${r.status}`); }
    } catch (e) {
      Toast.show(`Line plan save failed: ${(e as Error).message}`, 'error');
      ErrorLog.error('labor', `Save lines failed: ${(e as Error).message}`);
    }
  }

  async function _fetchAggregate(plant: string): Promise<Record<string, Record<string, number>>> {
    if (_aggrData[plant]) return _aggrData[plant];
    try {
      const res = await fetch(`${Config.API_BASE}/labor-plan?plant=${encodeURIComponent(plant)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const map: Record<string, Record<string, number>> = {};
      (json.rows || []).forEach((r: { pl_group: string; period: string; avail_hours: number }) => {
        if (!map[r.pl_group]) map[r.pl_group] = {};
        map[r.pl_group][r.period] = r.avail_hours;
      });
      _aggrData[plant] = map;
      return map;
    } catch (e) {
      ErrorLog.warn('labor', `Fetch aggregate failed for ${plant}: ${(e as Error).message}`);
      return {};
    }
  }

  async function _fetchLines(plant: string, group: string | null): Promise<void> {
    const w0 = _weeks[0], wN = _weeks[_weeks.length - 1];
    const from_date = Util.dayKey(w0.monday);
    const toDate    = new Date(wN.monday); toDate.setDate(wN.monday.getDate() + 6);
    const to_date   = Util.dayKey(toDate);
    try {
      let url = `${Config.API_BASE}/labor-plan/line?plant=${encodeURIComponent(plant)}&from_date=${from_date}&to_date=${to_date}`;
      if (group) url += `&group=${encodeURIComponent(group)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!_lineData[plant]) _lineData[plant] = {};
      (json.rows || []).forEach((r: { production_line: string; day: string; avail_hours: number; source: LaborCellSource }) => {
        if (!_lineData[plant][r.production_line]) _lineData[plant][r.production_line] = {};
        _lineData[plant][r.production_line][r.day] = { avail_hours: r.avail_hours, source: r.source };
      });
    } catch (e) {
      ErrorLog.warn('labor', `Fetch lines failed: ${(e as Error).message}`);
    }
  }

  // ── Disaggregation ───────────────────────────────────────────────────────
  function _disaggregate(plant: string, group: string, periodKey: string, groupHours: number): LaborDisaggregatedCell[] {
    const lines = (Store._state.masterData?.lines || [])
      .filter((l) => l.plant === plant && l.pl_group === group)
      .map((l) => l.production_line);
    if (!lines.length) return [];

    const monday = _isoWeekToMonday(periodKey);
    const openSlots: Array<{ line: string; date: Date; dayKey: string }> = [];
    lines.forEach((line) => {
      for (let d = 0; d < 7; d++) {
        const date = new Date(monday); date.setDate(monday.getDate() + d);
        if (Calendar.effectiveCapacityHours(line, date) > 0)
          openSlots.push({ line, date, dayKey: Util.dayKey(date) });
      }
    });
    if (!openSlots.length) return [];

    const perSlot = Math.max(0, (groupHours || 0)) / openSlots.length;
    const rounded = Math.round(perSlot * 10) / 10;
    return openSlots.map(s => ({ production_line: s.line, day: s.dayKey, avail_hours: rounded, source: 'auto_split' as const }));
  }

  // ── KPI strip ────────────────────────────────────────────────────────────
  function _renderKPIs(plant: string | null): void {
    const strip = document.getElementById('labor-kpi-strip');
    if (!strip || !plant) { if (strip) strip.innerHTML = ''; return; }

    const planMap = _aggrData[plant] || {};
    let totalAvail = 0;
    _groups.forEach((g) => _weeks.forEach((w) => {
      const v = planMap[g]?.[w.key]; if (v != null) totalAvail += v;
    }));

    const horizonStart = _weeks[0]?.monday || new Date();
    const horizonDays  = Math.min(_horizonSpan * 7, 90);
    const matrix: LaborUtilMatrix = Utilization.computeMatrix(horizonStart, horizonDays);
    const plantLines = (Store._state.masterData?.lines || []).filter((r) => r.plant === plant).map((r) => r.production_line);
    let totalRequired = 0;
    plantLines.forEach((line) => {
      const lm = matrix[line]; if (!lm) return;
      Object.values(lm).forEach((cell) => { totalRequired += cell.scheduled || 0; });
    });

    const diff     = totalAvail - totalRequired;
    const headroom = totalAvail > 0 ? Math.round((diff / totalAvail) * 100) : 0;
    const hSev     = headroom < 0 ? 'err' : headroom < 15 ? 'warn' : '';

    let shortfalls = 0;
    plantLines.forEach((line) => {
      const lm = matrix[line]; if (!lm) return;
      Object.entries(lm).forEach(([dayKey, cell]) => {
        if (!cell.scheduled) return;
        const ld   = _lineData[plant]?.[line]?.[dayKey];
        const avail = ld?.avail_hours != null ? ld.avail_hours : (cell.effectiveCapacity || 0);
        if (cell.scheduled > avail + 0.05) shortfalls++;
      });
    });

    const fmtH = (h: number) => h >= 1000 ? `${(h / 1000).toFixed(1)}k` : h.toFixed(0);
    strip.innerHTML = `
      <div class="lp-kpi-tile">
        <span class="lp-kpi-label">Available</span>
        <span class="lp-kpi-val">${fmtH(totalAvail)}h</span>
        <span class="lp-kpi-sub">${_horizonSpan} wk horizon</span>
      </div>
      <div class="lp-kpi-tile">
        <span class="lp-kpi-label">Required</span>
        <span class="lp-kpi-val">${fmtH(totalRequired)}h</span>
        <span class="lp-kpi-sub">from scheduled orders</span>
      </div>
      <div class="lp-kpi-tile${hSev ? ' lp-kpi-' + hSev : ''}">
        <span class="lp-kpi-label">Headroom</span>
        <span class="lp-kpi-val">${headroom}%</span>
        <span class="lp-kpi-sub">${fmtH(Math.abs(diff))}h ${diff >= 0 ? 'surplus' : 'deficit'}</span>
      </div>
      <div class="lp-kpi-tile${shortfalls > 0 ? ' lp-kpi-err' : ''}">
        <span class="lp-kpi-label">Shortfalls</span>
        <span class="lp-kpi-val">${shortfalls}</span>
        <span class="lp-kpi-sub">line·day cells</span>
      </div>`;
  }

  // Per-edit/paste KPI refresh is debounced (R12): the strip rebuilds an
  // O(lines × days) matrix walk, and labor editing fires per keystroke/cell —
  // coalesce rapid edits into one recompute instead of one-per-keystroke.
  const _renderKPIsDebounced = Util.debounce(_renderKPIs, 350);

  // ── Aggregate sub-tab ────────────────────────────────────────────────────
  function _clearSelection(): void {
    _selRange = null; _dragging = false; _dragAnchor = null;
    _selTds.forEach((td) => td.classList.remove('lp-selected-td'));
    _selTds.clear();
  }

  // Incremental lasso paint: diff the new rectangle against the previously
  // highlighted set so each mousemove only touches cells whose membership
  // changed (O(changed)), instead of clearing + re-querying the whole grid.
  function _renderSelection(): void {
    const next: Set<HTMLTableCellElement> = new Set();
    if (_selRange && _cellGrid) {
      const { r0, c0, r1, c1 } = _selRange;
      for (let r = r0; r <= r1; r++) {
        const row = _cellGrid[r]; if (!row) continue;
        for (let c = c0; c <= c1; c++) { const td = row[c]; if (td) next.add(td); }
      }
    }
    _selTds.forEach((td) => { if (!next.has(td)) td.classList.remove('lp-selected-td'); });
    next.forEach((td) => { if (!_selTds.has(td)) td.classList.add('lp-selected-td'); });
    _selTds = next;
  }

  function _updateAggrTotals(grid: HTMLElement): void {
    const plant = Store.selectedPlant; if (!plant || !_aggrData[plant]) return;
    const tds = grid.querySelectorAll('tbody tr:last-child td');
    _weeks.forEach((w, i) => {
      const total = Object.values(_aggrData[plant]).reduce((sum, p) => sum + (p[w.key] ?? 0), 0);
      if (tds[i + 1]) tds[i + 1].textContent = total > 0 ? total.toFixed(1) : '—';
    });
  }

  function _deleteSelected(): void {
    if (!_selRange) return;
    const plant = Store.selectedPlant; if (!plant) return;
    if (!_aggrData[plant]) _aggrData[plant] = {};
    const { r0, c0, r1, c1 } = _selRange;
    const cleared: LaborAggrCellPayload[] = [], prev: LaborAggrCellPayload[] = [];
    const g = document.getElementById('labor-grid');
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const grp = _displayGroups[r]; const period = _weeks[c]?.key; if (!grp || !period) continue;
      prev.push({ pl_group: grp, period, avail_hours: _aggrData[plant]?.[grp]?.[period] ?? null });
      if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
      delete _aggrData[plant][grp][period];
      cleared.push({ pl_group: grp, period, avail_hours: null });
      const inp = g?.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`) as HTMLInputElement | null;
      if (inp) inp.value = '';
    }
    if (!cleared.length) return;
    if (g) _updateAggrTotals(g);
    _clearSelection();
    const sn = _subnetwork(plant);
    UndoStack.push(`Delete ${cleared.length} labor cell${cleared.length !== 1 ? 's' : ''}`, () => {
      if (!_aggrData[plant]) _aggrData[plant] = {};
      prev.forEach(({ pl_group: grp, period, avail_hours: old }) => {
        if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
        if (old == null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = old;
      });
      const g2 = document.getElementById('labor-grid');
      if (g2) {
        prev.forEach(({ pl_group: grp, period, avail_hours: old }) => {
          const el = g2.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`) as HTMLInputElement | null;
          if (el) el.value = old != null ? String(old) : '';
        });
        _updateAggrTotals(g2);
      }
      _saveAggregate(sn, plant, prev);
    });
    _saveAggregate(sn, plant, cleared);
  }

  function _copySelected(): void {
    if (!_selRange) return;
    const plant = Store.selectedPlant;
    const { r0, c0, r1, c1 } = _selRange;
    const rows: string[] = [];
    for (let r = r0; r <= r1; r++) {
      const cols: string[] = [];
      for (let c = c0; c <= c1; c++) {
        const grp = _displayGroups[r]; const period = _weeks[c]?.key;
        const ah = grp && period && plant ? (_aggrData[plant]?.[grp]?.[period] ?? null) : null;
        cols.push(ah != null ? String(ah) : '');
      }
      rows.push(cols.join('\t'));
    }
    const count = (r1 - r0 + 1) * (c1 - c0 + 1);
    navigator.clipboard.writeText(rows.join('\n'))
      .then(() => Toast.show(`Copied ${count} cell${count !== 1 ? 's' : ''}`, 'success'))
      .catch(() => Toast.show('Copy failed — check clipboard permissions', 'error'));
  }

  async function _renderAggregate(plant: string): Promise<void> {
    const grid = document.getElementById('labor-grid') as LaborGridElement | null; if (!grid) return;
    const planMap = await _fetchAggregate(plant);
    _displayGroups = _selectedGroups.size ? _groups.filter((g) => _selectedGroups.has(g)) : _groups;
    const totals: Record<string, number> = {}; _weeks.forEach((w) => { totals[w.key] = 0; });
    const groupRows = _displayGroups.map((grp) => {
      const cells = _weeks.map((w) => {
        const ah = planMap[grp]?.[w.key]; if (ah != null) totals[w.key] += ah;
        return `<td>
          <input type="number" class="lp-cell" data-group="${grp.replace(/"/g,'&quot;')}" data-period="${w.key}" min="0" step="0.5" value="${ah != null ? ah : ''}" placeholder="—">
        </td>`;
      }).join('');
      return `<tr><td>${grp}</td>${cells}</tr>`;
    }).join('');
    const totalCells = _weeks.map((w) => {
      const v = totals[w.key];
      return `<td>${v > 0 ? v.toFixed(1) : '—'}</td>`;
    }).join('');
    grid.innerHTML = `
      <div class="lp-card lp-card-scroll">
        <table class="lp-table">
          <thead><tr>
            <th>Group</th>
            ${_weeks.map((w) => `<th>${w.label}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${groupRows}
            <tr class="lp-total-row">
              <td>TOTAL</td>${totalCells}
            </tr>
          </tbody>
        </table>
      </div>
      <p class="lp-hint">Ctrl+drag to select · Delete to clear · Ctrl+C to copy · Paste from Excel · Values in hours</p>`;

    // Build [row][col] -> <td> cache so the lasso paint never queries the DOM.
    _cellGrid = _displayGroups.map((grp) =>
      _weeks.map((w) => grid.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${w.key}"]`)?.closest<HTMLTableCellElement>('td') || null));
    _selTds = new Set();

    const sn = _subnetwork(plant);

    // Lasso drag listeners attach once to the persistent #labor-grid element
    // (innerHTML is replaced on every render but the container is not).
    if (!grid._lpDragWired) {
      grid._lpDragWired = true;
      grid.addEventListener('mousedown', (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (!e.ctrlKey && !e.metaKey) { if (!target.closest('.lp-selected-td')) _clearSelection(); return; }
        const inp = target.closest<HTMLElement>('.lp-cell'); if (!inp) return;
        e.preventDefault();
        const ri = _displayGroups.indexOf(inp.dataset.group || ''), ci = _weeks.findIndex((w) => w.key === inp.dataset.period);
        if (ri < 0 || ci < 0) return;
        _dragging = true; _dragAnchor = { row: ri, col: ci };
        _selRange = { r0: ri, c0: ci, r1: ri, c1: ci }; _renderSelection();
      });
      grid.addEventListener('mousemove', (e: MouseEvent) => {
        if (!_dragging || !_dragAnchor) return;
        const td = (e.target as HTMLElement).closest('td'); if (!td) return;
        const inp = td.querySelector<HTMLElement>('.lp-cell'); if (!inp) return;
        const ri = _displayGroups.indexOf(inp.dataset.group || ''), ci = _weeks.findIndex((w) => w.key === inp.dataset.period);
        if (ri < 0 || ci < 0) return;
        _selRange = { r0: Math.min(_dragAnchor.row, ri), c0: Math.min(_dragAnchor.col, ci), r1: Math.max(_dragAnchor.row, ri), c1: Math.max(_dragAnchor.col, ci) };
        _renderSelection();
      });
    }

    grid.querySelectorAll<HTMLInputElement>('.lp-cell').forEach((inp) => {
      // Reference the captured `inp` rather than a `this` parameter — see the
      // identical `.oninput` note in ProdLines._wireNav above.
      inp.onchange = async function() {
        const grp = inp.dataset.group!, period = inp.dataset.period!;
        const raw = inp.value.trim();
        const ah  = raw === '' ? null : Math.max(0, parseFloat(raw) || 0);
        if (ah !== null) inp.value = String(ah);
        const oldAh = _aggrData[plant]?.[grp]?.[period] ?? null;
        if (!_aggrData[plant]) _aggrData[plant] = {};
        if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
        if (ah === null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = ah;
        _updateAggrTotals(grid);
        _renderKPIsDebounced(plant);
        if (ah !== null) {
          const splits = _disaggregate(plant, grp, period, ah);
          if (splits.length) {
            if (!_lineData[plant]) _lineData[plant] = {};
            splits.forEach((c) => {
              if (!_lineData[plant][c.production_line]) _lineData[plant][c.production_line] = {};
              _lineData[plant][c.production_line][c.day] = { avail_hours: c.avail_hours, source: c.source };
            });
            _saveLines(sn, plant, splits);
          }
        }
        UndoStack.push(`Labor: ${grp} / ${period}`, () => {
          if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
          if (oldAh == null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = oldAh;
          const el = document.getElementById('labor-grid')?.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`) as HTMLInputElement | null;
          if (el) el.value = oldAh != null ? String(oldAh) : '';
          const gridEl = document.getElementById('labor-grid');
          if (gridEl) _updateAggrTotals(gridEl);
          _saveAggregate(sn, plant, [{ pl_group: grp, period, avail_hours: oldAh }]);
        });
        await _saveAggregate(sn, plant, [{ pl_group: grp, period, avail_hours: ah }]);
      };
    });

    const table = grid.querySelector('table');
    if (table) table.addEventListener('paste', async (e: ClipboardEvent) => {
      const activeEl = document.activeElement as HTMLInputElement | null;
      const anchor = activeEl?.classList.contains('lp-cell') ? activeEl : null;
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain'); if (!text) return;
      const clipRows = text.replace(/\r/g, '').split('\n').filter((r) => r !== '').map((r) => r.split('\t'));
      const cellMatrix = _displayGroups.map((grp) => _weeks.map((w) => grid.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${w.key}"]`) as HTMLInputElement | null));
      let anchorRow = 0, anchorCol = 0;
      if (anchor) {
        anchorRow = Math.max(0, _displayGroups.indexOf(anchor.dataset.group || ''));
        anchorCol = Math.max(0, _weeks.findIndex((w) => w.key === anchor.dataset.period));
      }
      if (!_aggrData[plant]) _aggrData[plant] = {};
      const changed: LaborAggrCellPayload[] = [], prev: LaborAggrCellPayload[] = [], allSplits: LaborDisaggregatedCell[] = [];
      clipRows.forEach((clipCols, r) => {
        clipCols.forEach((val, c) => {
          const ri = anchorRow + r, ci = anchorCol + c;
          if (ri >= _displayGroups.length || ci >= _weeks.length) return;
          const inp = cellMatrix[ri]?.[ci]; if (!inp) return;
          const raw = val.trim().replace(/,/g, '');
          const ah  = raw === '' ? null : parseFloat(raw);
          if (ah !== null && (isNaN(ah) || ah < 0)) return;
          const grp = inp.dataset.group!, period = inp.dataset.period!;
          prev.push({ pl_group: grp, period, avail_hours: _aggrData[plant]?.[grp]?.[period] ?? null });
          inp.value = ah !== null ? String(ah) : '';
          if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
          if (ah === null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = ah;
          changed.push({ pl_group: grp, period, avail_hours: ah });
          if (ah !== null) allSplits.push(..._disaggregate(plant, grp, period, ah));
        });
      });
      if (!changed.length) return;
      _updateAggrTotals(grid); _renderKPIsDebounced(plant);
      if (allSplits.length) {
        if (!_lineData[plant]) _lineData[plant] = {};
        allSplits.forEach((c) => {
          if (!_lineData[plant][c.production_line]) _lineData[plant][c.production_line] = {};
          _lineData[plant][c.production_line][c.day] = { avail_hours: c.avail_hours, source: c.source };
        });
        _saveLines(sn, plant, allSplits);
      }
      UndoStack.push(`Undo paste (${changed.length} labor value${changed.length !== 1 ? 's' : ''})`, () => {
        if (!_aggrData[plant]) _aggrData[plant] = {};
        prev.forEach(({ pl_group: grp, period, avail_hours: old }) => {
          if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
          if (old == null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = old;
        });
        const g = document.getElementById('labor-grid');
        if (g) {
          prev.forEach(({ pl_group: grp, period, avail_hours: old }) => {
            const el = g.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`) as HTMLInputElement | null;
            if (el) el.value = old != null ? String(old) : '';
          });
          _updateAggrTotals(g);
        }
        _saveAggregate(sn, plant, prev);
      });
      Toast.show(`Pasted ${changed.length} value${changed.length !== 1 ? 's' : ''}`, 'success');
      await _saveAggregate(sn, plant, changed);
    });
  }

  // ── Line Plan sub-tab ────────────────────────────────────────────────────
  async function _renderLinePlan(plant: string): Promise<void> {
    const grid = document.getElementById('labor-line-grid') as HTMLElement | null; if (!grid) return;
    // Show all groups unless user has filtered to specific ones
    const visibleGroups = _displayGroups.length ? _displayGroups : _groups;
    const fetchGroup = _selectedGroups.size === 1 ? [..._selectedGroups][0] : null;
    // Cross-screen production-line filter (Store.selectedLines) ANDs with the
    // group filter above — same combination GanttFilter's line/color/form
    // filters already use. Can legitimately yield zero rows (line selected
    // from a different group than the active group filter); the existing
    // empty-state below already covers that, same as a group-only miss.
    const lineSel = Store.selectedLines;
    const allLinesMeta = Store.masterLinesForPlant(plant)
      .filter((l) => visibleGroups.includes(l.pl_group ?? '') && (lineSel.size === 0 || lineSel.has(l.production_line)))
      .sort((a, b) => visibleGroups.indexOf(a.pl_group ?? '') - visibleGroups.indexOf(b.pl_group ?? '') || a.production_line.localeCompare(b.production_line));
    if (!allLinesMeta.length) {
      grid.innerHTML = `<div class="empty-state" style="padding:40px 0;">${Util.t('empty.no_production_lines_plant')}</div>`; return;
    }
    await _fetchLines(plant, fetchGroup);

    // Build day columns
    const days: Array<{ date: Date; dayKey: string; weekKey: string }> = [];
    _weeks.forEach((w) => {
      for (let d = 0; d < 7; d++) {
        const date = new Date(w.monday); date.setDate(w.monday.getDate() + d);
        days.push({ date, dayKey: Util.dayKey(date), weekKey: w.key });
      }
    });

    const horizonStart = _weeks[0].monday;
    const utilMatrix: LaborUtilMatrix = Utilization.computeMatrix(horizonStart, Math.min(_horizonSpan * 7, 84));
    const sn = _subnetwork(plant);

    const isDark = document.body.classList.contains('dark');
    function lerpRGB(a: string, b: string, t: number): string {
      const p = (h: string) => [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
      const ca = p(a), cb = p(b);
      return `rgb(${Math.round(ca[0]+(cb[0]-ca[0])*t)},${Math.round(ca[1]+(cb[1]-ca[1])*t)},${Math.round(ca[2]+(cb[2]-ca[2])*t)})`;
    }
    // Command Band re-skin (Task 6): idle -> --bg-subtle neutral, low -> info-blue,
    // mid -> --warn, hot -> --err (dark branch uses deeper variants, kept dark
    // enough for the white overlay text used above ratio 0 in dark mode).
    const idle = isDark ? '#252730' : '#f4f7fa', low = isDark ? '#1d4a80' : '#1a4fa0',
          mid  = isDark ? '#8a5a0d' : '#93610a', hot = isDark ? '#8f241c' : '#b02a20';
    function heatBg(ratio: number): string {
      if (ratio <= 0)   return idle;
      if (ratio <= 0.5) return lerpRGB(idle, low, ratio / 0.5);
      if (ratio <= 1.0) return lerpRGB(low, mid, (ratio - 0.5) / 0.5);
      return lerpRGB(mid, hot, Math.min((ratio - 1.0) / 0.25, 1));
    }

    const weekStarts = new Set(_weeks.map((w) => Util.dayKey(w.monday)));

    const dayHeaders = days.map((d) => {
      const wb = weekStarts.has(d.dayKey) ? 'border-left:2px solid var(--accent-soft);' : '';
      return `<th style="width:52px;min-width:52px;${wb}">${d.date.getMonth()+1}/${d.date.getDate()}</th>`;
    }).join('');

    const showGroupHeaders = visibleGroups.length > 1;
    let lastGroup: string | undefined;
    // Memoize calendar capacity per (line|dayKey) for this render pass — the same
    // line/date pair is otherwise recomputed across every row build.
    const _capMemo: Map<string, number> = new Map();
    const _capFor = (line: string, date: Date, dayKey: string): number => {
      const k = line + '|' + dayKey;
      let v = _capMemo.get(k);
      if (v === undefined) { v = Calendar.effectiveCapacityHours(line, date); _capMemo.set(k, v); }
      return v;
    };
    const lineRows = allLinesMeta.map((lm) => {
      const line = lm.production_line;
      let groupRow = '';
      if (showGroupHeaders && lm.pl_group !== lastGroup) {
        lastGroup = lm.pl_group;
        groupRow = `<tr><td class="lp-group-hdr" colspan="${days.length + 1}">${lm.pl_group}</td></tr>`;
      }
      const cells = days.map((d) => {
        const wb   = weekStarts.has(d.dayKey) ? 'border-left:2px solid var(--accent-soft);' : '';
        const ld   = _lineData[plant]?.[line]?.[d.dayKey];
        const calCap = _capFor(line, d.date, d.dayKey);
        const avail  = ld?.avail_hours != null ? ld.avail_hours : calCap;
        const req    = utilMatrix[line]?.[d.dayKey]?.scheduled || 0;
        const ratio  = avail > 0 ? req / avail : (req > 0 ? 2 : 0);
        const bg     = avail === 0 ? 'var(--bg-subtle)' : heatBg(ratio);
        const isOvr  = ld?.source === 'override';
        const title  = `${line} · ${d.dayKey} | Available: ${avail.toFixed(1)}h | Required: ${req.toFixed(1)}h | Cal cap: ${calCap.toFixed(1)}h${isOvr ? ' | Pinned' : ''}`;
        return `<td class="${isOvr ? 'lp-ovr' : ''}" style="${wb}background:${bg};padding:3px 4px;" title="${title}">
          <input type="number" class="lp-line-cell" data-line="${line.replace(/"/g,'&quot;')}" data-day="${d.dayKey}" min="0" step="0.5"
            value="${avail > 0 ? avail : ''}"></td>`;
      }).join('');
      return groupRow + `<tr><td>${line}</td>${cells}</tr>`;
    }).join('');

    grid.innerHTML = `
      <div class="lp-card lp-card-scroll">
        <table class="lp-table">
          <thead><tr><th>Line</th>${dayHeaders}</tr></thead>
          <tbody>${lineRows}</tbody>
        </table>
      </div>`;

    // Sticky group headers: offset by actual thead height so they dock below column headers
    const theadH = (grid.querySelector('thead tr') as HTMLElement | null)?.offsetHeight || 27;
    grid.querySelectorAll<HTMLElement>('.lp-group-hdr').forEach((td) => { td.style.top = theadH + 'px'; });

    // Delegated handlers on the grid container — one 'change' + one 'contextmenu'
    // listener instead of two per cell (scales to thousands of line-day cells).
    grid.onchange = async function(e: Event) {
      const inp = (e.target as HTMLElement).closest<HTMLInputElement>('.lp-line-cell'); if (!inp) return;
      const line = inp.dataset.line!, day = inp.dataset.day!;
      const raw  = inp.value.trim();
      const ah   = raw === '' ? null : Math.max(0, parseFloat(raw) || 0);
      if (ah !== null) inp.value = String(ah);
      if (!_lineData[plant]) _lineData[plant] = {};
      if (!_lineData[plant][line]) _lineData[plant][line] = {};
      const old    = _lineData[plant][line][day];
      const oldAh  = old?.avail_hours ?? null, oldSrc = old?.source ?? 'auto_split';
      const newSrc = ah !== null ? 'override' : 'auto_split';
      if (ah === null) delete _lineData[plant][line][day]; else _lineData[plant][line][day] = { avail_hours: ah, source: 'override' };
      const td = inp.closest('td');
      if (td) td.classList.toggle('lp-ovr', ah !== null);
      UndoStack.push(`Line plan: ${line} / ${day}`, () => {
        if (!_lineData[plant][line]) _lineData[plant][line] = {};
        if (oldAh == null) delete _lineData[plant][line][day]; else _lineData[plant][line][day] = { avail_hours: oldAh, source: oldSrc };
        const el = grid.querySelector(`.lp-line-cell[data-line="${line.replace(/"/g,'&quot;')}"][data-day="${day}"]`) as HTMLInputElement | null;
        if (el) el.value = oldAh != null ? String(oldAh) : '';
        _saveLines(sn, plant, [{ production_line: line, day, avail_hours: oldAh, source: oldSrc }]);
      });
      await _saveLines(sn, plant, [{ production_line: line, day, avail_hours: ah, source: newSrc }]);
    };

    grid.oncontextmenu = function(e: MouseEvent) {
      const inp = (e.target as HTMLElement).closest<HTMLInputElement>('.lp-line-cell'); if (!inp) return;
      e.preventDefault();
      const line = inp.dataset.line!, day = inp.dataset.day!;
      if (_lineData[plant]?.[line]?.[day]?.source !== 'override') return;
      const grp = (Store._state.masterData?.lines || []).find((l) => l.production_line === line && l.plant === plant)?.pl_group;
      if (!grp) return;
      const periodKey = _weeks.find((w) => {
        for (let d = 0; d < 7; d++) { const dd = new Date(w.monday); dd.setDate(w.monday.getDate() + d); if (Util.dayKey(dd) === day) return true; }
      })?.key;
      if (!periodKey) return;
      const groupHours = _aggrData[plant]?.[grp]?.[periodKey]; if (groupHours == null) return;
      const splits = _disaggregate(plant, grp, periodKey, groupHours);
      const resetCell = splits.find((c) => c.production_line === line && c.day === day); if (!resetCell) return;
      _lineData[plant][line][day] = { avail_hours: resetCell.avail_hours, source: 'auto_split' };
      inp.value = resetCell.avail_hours ? String(resetCell.avail_hours) : '';
      inp.closest('td')?.classList.remove('lp-ovr');
      _saveLines(sn, plant, [{ production_line: line, day, avail_hours: resetCell.avail_hours, source: 'auto_split' }]);
      Toast.show(`Reset ${line} · ${day} to even-split`, 'success');
    };
  }

  // ── Capacity sub-tab ─────────────────────────────────────────────────────
  async function _renderCapacity(plant: string): Promise<void> {
    const container = document.getElementById('labor-capacity-grid'); if (!container) return;
    const scopeGroup = _selectedGroups.size === 1 ? [..._selectedGroups][0] : null;
    await _fetchLines(plant, scopeGroup);
    const lineSel = Store.selectedLines;
    const lines = Store.masterLinesForPlant(plant)
      .filter((l) => (!scopeGroup || l.pl_group === scopeGroup) && (lineSel.size === 0 || lineSel.has(l.production_line)))
      .map((l) => l.production_line).sort();
    if (!lines.length) { container.innerHTML = `<div class="empty-state" style="padding:40px 0;">${Util.t('empty.no_production_lines_plant')}</div>`; return; }

    const horizonStart = _weeks[0].monday;
    const utilMatrix: LaborUtilMatrix = Utilization.computeMatrix(horizonStart, Math.min(_horizonSpan * 7, 84));
    const displayDays  = Math.min(14, _horizonSpan * 7);
    const days: Array<{ date: Date; dayKey: string }> = [];
    for (let i = 0; i < displayDays; i++) {
      const d = new Date(horizonStart); d.setDate(horizonStart.getDate() + i);
      days.push({ date: d, dayKey: Util.dayKey(d) });
    }

    const isDark = document.body.classList.contains('dark');
    function lerpRGB(a: string, b: string, t: number): string {
      const p = (h: string) => [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
      const ca = p(a), cb = p(b);
      return `rgb(${Math.round(ca[0]+(cb[0]-ca[0])*t)},${Math.round(ca[1]+(cb[1]-ca[1])*t)},${Math.round(ca[2]+(cb[2]-ca[2])*t)})`;
    }
    // Command Band re-skin (Task 6): same repointed ramp as _renderLinePlan above
    // (idle -> --bg-subtle, low -> info-blue, mid -> --warn, hot -> --err).
    const idle = isDark ? '#252730' : '#f4f7fa', low = isDark ? '#1d4a80' : '#1a4fa0',
          mid  = isDark ? '#8a5a0d' : '#93610a', hot = isDark ? '#8f241c' : '#b02a20';
    function heatBg(ratio: number): string {
      if (ratio <= 0)   return idle;
      if (ratio <= 0.5) return lerpRGB(idle, low, ratio / 0.5);
      if (ratio <= 1.0) return lerpRGB(low, mid, (ratio - 0.5) / 0.5);
      return lerpRGB(mid, hot, Math.min((ratio - 1.0) / 0.25, 1));
    }
    function heatText(ratio: number): string { return isDark ? (ratio <= 0 ? '#8f909d' : '#fff') : (ratio < 0.45 ? '#1c2b3a' : '#fff'); }

    const cols = `100px repeat(${days.length}, 1fr)`;
    let html = `<div class="lp-card" style="padding:14px 16px;">
      <p class="lp-cap-note">Req/Avail hours · first ${displayDays} days${scopeGroup ? ' · Group: ' + scopeGroup : ''}</p>
      <div class="lp-hm-wrap"><div class="lp-hm-grid" style="grid-template-columns:${cols}">`;
    html += `<div class="lp-hm-corner"></div>`;
    days.forEach((d) => {
      const dow = d.date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
      html += `<div class="lp-hm-head"><span class="lp-hm-dow">${dow}</span><span class="lp-hm-date">${d.date.getMonth()+1}/${d.date.getDate()}</span></div>`;
    });
    lines.forEach((line, li) => {
      const dot = Config.COLORS[li % Config.COLORS.length];
      html += `<div class="lp-hm-label"><span class="lp-hm-dot" style="background:${dot}"></span>${line}</div>`;
      days.forEach((d) => {
        const req    = utilMatrix[line]?.[d.dayKey]?.scheduled || 0;
        const ld     = _lineData[plant]?.[line]?.[d.dayKey];
        const calCap = utilMatrix[line]?.[d.dayKey]?.effectiveCapacity || 0;
        const avail  = ld?.avail_hours != null ? ld.avail_hours : calCap;
        const ratio  = avail > 0 ? req / avail : (req > 0 ? 2 : 0);
        const bg     = heatBg(ratio), tc = heatText(ratio);
        const lbl    = avail > 0 ? `${req.toFixed(0)}/${avail.toFixed(0)}` : '—';
        html += `<div class="lp-hm-cell" style="background:${bg};color:${tc};" title="${line} · ${d.dayKey} | Req: ${req.toFixed(1)}h | Avail: ${avail.toFixed(1)}h | ${Math.round(ratio*100)}%">${lbl}</div>`;
      });
    });
    html += `</div></div><div class="lp-hm-legend"><span>idle</span><div class="lp-hm-grad"></div><span>overload</span></div></div>`;
    container.innerHTML = html;
  }

  // ── Exceptions sub-tab ───────────────────────────────────────────────────
  async function _renderExceptions(plant: string): Promise<void> {
    const container = document.getElementById('labor-exceptions-list'); if (!container) return;
    await _fetchLines(plant, null);
    const lineSel = Store.selectedLines;
    const lines = (Store._state.masterData?.lines || [])
      .filter((l) => l.plant === plant && (lineSel.size === 0 || lineSel.has(l.production_line)))
      .map((l) => l.production_line);
    const horizonStart = _weeks[0].monday;
    const utilMatrix: LaborUtilMatrix = Utilization.computeMatrix(horizonStart, Math.min(_horizonSpan * 7, 84));
    const exceptions: LaborException[] = [];
    lines.forEach((line) => {
      const lm = utilMatrix[line]; if (!lm) return;
      Object.entries(lm).forEach(([dayKey, cell]) => {
        if (!cell.scheduled && !cell.capacity) return;
        const ld    = _lineData[plant]?.[line]?.[dayKey];
        const avail = ld?.avail_hours != null ? ld.avail_hours : (cell.effectiveCapacity || 0);
        const req   = cell.scheduled || 0, calCap = cell.capacity || 0;
        if (req > avail + 0.05 && req > 0)
          exceptions.push({ sev: 'err',  line, day: dayKey, msg: `${req.toFixed(1)}h required, ${avail.toFixed(1)}h available — ${(req - avail).toFixed(1)}h short` });
        else if (avail > calCap + 0.05 && calCap > 0)
          exceptions.push({ sev: 'warn', line, day: dayKey, msg: `${avail.toFixed(1)}h planned exceeds ${calCap.toFixed(1)}h calendar capacity` });
      });
    });
    exceptions.sort((a, b) => (a.sev === 'err' ? -1 : 1) - (b.sev === 'err' ? -1 : 1) || a.day.localeCompare(b.day));

    const badge = document.getElementById('labor-exc-badge') as HTMLElement | null;
    if (badge) { badge.textContent = String(exceptions.length); badge.hidden = exceptions.length === 0; }

    if (!exceptions.length) {
      container.innerHTML = `<div class="empty-state" style="padding:40px 0;">✓ No exceptions in the current horizon.</div>`; return;
    }
    const rows = exceptions.map((ex) => `
      <div class="lp-exc-row lp-exc-${ex.sev}">
        <span class="lp-exc-sev">${ex.sev === 'err' ? '▲' : '⚠'}</span>
        <span class="lp-exc-line">${ex.line}</span>
        <span class="lp-exc-day">${ex.day}</span>
        <span class="lp-exc-msg">${ex.msg}</span>
        <button class="btn btn-sm lp-exc-fix" onclick="NIMBUS.App.gotoLaborSub('line-plan')">Line Plan →</button>
      </div>`).join('');
    container.innerHTML = `<div class="lp-exc-summary">${exceptions.length} exception${exceptions.length !== 1 ? 's' : ''}</div><div class="lp-exc-list">${rows}</div>`;
  }

  // ── Inputs sub-tab ───────────────────────────────────────────────────────
  function _renderInputs(): void {
    const container = document.getElementById('labor-inputs-pane'); if (!container) return;
    container.innerHTML = `
      <div class="lp-inputs-section">
        <h3 class="lp-inputs-title">Disaggregation</h3>
        <div class="lp-input-row">
          <label class="lp-input-label">Default split mode</label>
          <select class="lp-input-sel"><option selected>Even split (equal hours per open day)</option></select>
          <span class="lp-input-hint">Aggregate group/week hours divide evenly across each line's open working days. Right-click any Line Plan cell to reset an override to even-split.</span>
        </div>
      </div>
      <div class="lp-inputs-section">
        <h3 class="lp-inputs-title">Horizon</h3>
        <div class="lp-input-row">
          <label class="lp-input-label">Week span</label>
          <select class="lp-input-sel" onchange="NIMBUS.LaborPlanning.setSpan(+this.value)">
            <option value="4" ${_horizonSpan===4?'selected':''}>4 weeks</option>
            <option value="8" ${_horizonSpan===8?'selected':''}>8 weeks</option>
            <option value="12" ${_horizonSpan===12?'selected':''}>12 weeks</option>
            <option value="16" ${_horizonSpan===16?'selected':''}>16 weeks</option>
          </select>
        </div>
      </div>
      <div class="lp-inputs-section">
        <h3 class="lp-inputs-title">Aggregate ↔ Line reconciliation</h3>
        <p style="font-size:12px;color:var(--fg-mute);margin:0;">When aggregate hours are saved, the system auto-splits to lines via even split across open working days. Overridden line·day cells are pinned (●) and do not re-split until manually reset.</p>
      </div>`;
  }

  // ── Toolbar update ───────────────────────────────────────────────────────
  function _renderToolbar(plant: string | null): void {
    // Group multi-select button label
    const lbl = document.getElementById('lp-group-label');
    if (lbl) {
      if (_selectedGroups.size === 0)           lbl.textContent = 'All Groups';
      else if (_selectedGroups.size === 1)      lbl.textContent = [..._selectedGroups][0];
      else                                      lbl.textContent = `${_selectedGroups.size} groups`;
    }
    // Rebuild dropdown checkboxes (keeps checked state in sync)
    const drop = document.getElementById('lp-group-dropdown');
    if (drop) {
      drop.innerHTML =
        `<div class="lp-group-scroll">` +
        _groups.map((g) => `
          <label class="lp-group-chk-row">
            <input type="checkbox" value="${g.replace(/"/g,'&quot;')}"${_selectedGroups.has(g) ? ' checked' : ''}
              onchange="NIMBUS.LaborPlanning.onGroupToggle(this.value,this.checked)">
            ${g}
          </label>`).join('') +
        `</div>
        <div class="lp-group-chk-footer">
          <button class="btn btn-sm" onclick="NIMBUS.LaborPlanning.clearGroupFilter()">Clear</button>
        </div>`;
    }
    // Cross-screen production-line filter (Store.selectedLines) — same
    // selection as Gantt/Orders/Dashboard/Master Data's line pickers.
    // Rebuild only the checklist body; the search <input> is static markup
    // wired once in init(), so its value/focus survive this rebuild.
    Util.refreshMultiSelectLabel(
      document.getElementById('lp-line-label'), document.getElementById('lp-line-btn'), Store.selectedLines);
    if (plant) {
      const lineCandidates = Store.masterLinesForPlant(plant)
        .map((l) => l.production_line)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      Util.renderLineChecklist(
        document.getElementById('lp-line-checklist'), lineCandidates, Store.selectedLines, _lineSearch,
        (line, checked) => {
          const next = new Set(Store.selectedLines);
          if (checked) next.add(line); else next.delete(line);
          Store.setSelectedLines(next, 'labor');
        });
    }
    // Flatpickr date-jump: lazily init, then sync to current horizon start
    if (_weeks.length) {
      if (!_fpHorizon) {
        _fpHorizon = flatpickr('#labor-horizon-input', {
          dateFormat: 'M j, Y',
          onChange(dates: Date[]) {
            if (!dates[0]) return;
            const now = new Date();
            const todayMon = new Date(now);
            todayMon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
            _horizonOffset = Math.round((dates[0].getTime() - todayMon.getTime()) / (7 * Config.MS_DAY));
            render();
          },
        });
      }
      _fpHorizon!.setDate(_weeks[0].monday, false);
    }
    const badge = document.getElementById('labor-plant-badge');
    if (badge) badge.textContent = plant || '—';
  }

  // ── Main render ──────────────────────────────────────────────────────────
  async function render(): Promise<void> {
    _weeks = _computeWeeks();
    const plant = Store.selectedPlant;
    if (!plant) {
      ['labor-grid','labor-line-grid','labor-capacity-grid','labor-exceptions-list','labor-inputs-pane'].forEach(id => {
        const el = document.getElementById(id); if (el) el.innerHTML = '';
      });
      const grid = document.getElementById('labor-grid');
      if (grid) grid.innerHTML = `<div class="empty-state" style="padding:40px 0;">${Util.t('ui.select_plant_labor')}</div>`;
      const plantBadge = document.getElementById('labor-plant-badge');
      if (plantBadge) plantBadge.textContent = '—';
      const kpiStrip = document.getElementById('labor-kpi-strip');
      if (kpiStrip) kpiStrip.innerHTML = '';
      return;
    }
    const mdLines = (Store._state.masterData?.lines || []).filter((r) => r.plant === plant);
    _groups = [...new Set(mdLines.map((r) => r.pl_group).filter((g): g is string => Boolean(g)))].sort();
    if (!_groups.length) {
      const grid = document.getElementById('labor-grid');
      if (grid) grid.innerHTML = `<div class="empty-state" style="padding:40px 0;">${Util.t('empty.no_line_groups_plant')}</div>`;
      return;
    }
    _renderToolbar(plant);
    _renderKPIs(plant);
    const sub = _activeTabResolvers.laborSub() || 'aggregate';
    if (sub === 'aggregate')   await _renderAggregate(plant);
    else if (sub === 'line-plan')  await _renderLinePlan(plant);
    else if (sub === 'capacity')   await _renderCapacity(plant);
    else if (sub === 'exceptions') await _renderExceptions(plant);
    else if (sub === 'inputs')     _renderInputs();
  }

  // Re-renders whichever Labor Plan sub-tab is currently active — shared by
  // the group-filter and cross-screen line-filter change handlers, neither
  // of which needs a full render() (KPI strip / horizon / groups unchanged).
  function _rerenderActiveSub(): void {
    const plant = Store.selectedPlant; if (!plant) return;
    const sub = _activeTabResolvers.laborSub();
    if (sub === 'aggregate')       _renderAggregate(plant);
    else if (sub === 'line-plan')  _renderLinePlan(plant);
    else if (sub === 'capacity')   _renderCapacity(plant);
    else if (sub === 'exceptions') _renderExceptions(plant);
  }

  function _onLPKeyDown(e: KeyboardEvent): void {
    if (!_selRange || _activeTabResolvers.currentTab() !== 'labor') return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); _clearSelection(); return; }
    if (e.key === 'Delete' || (e.key === 'Backspace' && !(e.target as HTMLElement | null)?.classList.contains('lp-cell'))) {
      e.preventDefault(); e.stopImmediatePropagation(); _deleteSelected(); return;
    }
    if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); e.stopImmediatePropagation(); _copySelected(); return; }
  }

  function init(): void {
    document.addEventListener('keydown', _onLPKeyDown, { capture: true });
    document.addEventListener('mouseup', () => { _dragging = false; });
    Store.subscribe((evt) => {
      if ((evt.type === 'plant:selected' || evt.type === 'master-data-changed') && _activeTabResolvers.currentTab() === 'labor') {
        // Store._state.masterData direct touch aside, `evt.plant` on a generic
        // StoreEvent is `unknown` (StoreEventInput's index signature) since
        // per-event-type extra fields aren't discriminated — cast at this
        // boundary, same pattern as schedule-services.mts's `opts.plant as
        // string | null | undefined`.
        if (evt.type === 'plant:selected') {
          const p = evt.plant as string;
          delete _aggrData[p]; delete _lineData[p];
        }
        render();
      }
      if (evt.type === 'lines:selected' && _activeTabResolvers.currentTab() === 'labor') {
        // Cross-screen change (Gantt/Table/Dashboard/Master Data) — only the
        // line-checklist/label + active sub-tab need refreshing, not a full render().
        _renderToolbar(Store.selectedPlant || '');
        _rerenderActiveSub();
      }
    }, 'Labor');
    const lineSearchIn = document.getElementById('lp-line-search') as HTMLInputElement | null;
    if (lineSearchIn) {
      lineSearchIn.oninput = () => {
        _lineSearch = lineSearchIn.value || '';
        Util.renderLineChecklist(
          document.getElementById('lp-line-checklist'),
          Store.selectedPlant ? Store.masterLinesForPlant(Store.selectedPlant).map((l) => l.production_line).sort() : [],
          Store.selectedLines, _lineSearch,
          (line, checked) => {
            const next = new Set(Store.selectedLines);
            if (checked) next.add(line); else next.delete(line);
            Store.setSelectedLines(next, 'labor');
          });
      };
      Util.wirePasteToCheckboxes(lineSearchIn,
        () => Array.from(document.getElementById('lp-line-checklist')?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') ?? []));
    }
  }

  return {
    init, render,
    onGroupToggle(group: string, checked: boolean): void {
      if (checked) _selectedGroups.add(group); else _selectedGroups.delete(group);
      _renderToolbar(Store.selectedPlant || '');
      _rerenderActiveSub();
    },
    clearGroupFilter(): void {
      _selectedGroups.clear();
      _renderToolbar(Store.selectedPlant || '');
      _rerenderActiveSub();
    },
    toggleLineDropdown(e?: Event): void {
      e?.stopPropagation();
      const drop = document.getElementById('lp-line-dropdown');
      if (!drop) return;
      drop.hidden = !drop.hidden;
      if (!drop.hidden) {
        const close = (ev: MouseEvent) => {
          const target = ev.target as Node | null;
          if (!drop.contains(target) && (target as HTMLElement | null)?.id !== 'lp-line-btn') { drop.hidden = true; document.removeEventListener('click', close); }
        };
        setTimeout(() => document.addEventListener('click', close), 0);
      }
    },
    toggleGroupDropdown(e?: Event): void {
      e?.stopPropagation();
      const drop = document.getElementById('lp-group-dropdown');
      if (!drop) return;
      drop.hidden = !drop.hidden;
      if (!drop.hidden) {
        const close = (ev: MouseEvent) => {
          const target = ev.target as Node | null;
          if (!drop.contains(target) && (target as HTMLElement | null)?.id !== 'lp-group-btn') { drop.hidden = true; document.removeEventListener('click', close); }
        };
        setTimeout(() => document.addEventListener('click', close), 0);
      }
    },
    prevHorizon(): void { _horizonOffset -= _horizonSpan; render(); },
    nextHorizon(): void { _horizonOffset += _horizonSpan; render(); },
    setSpan(n: number): void {
      _horizonSpan = n;
      const sel = document.getElementById('labor-span-sel') as HTMLSelectElement | null; if (sel) sel.value = String(n);
      render();
    },
  };
})();

// -- Local type declarations (this task's MasterData conversion; scoped to
//    this closure-returning IIFE) -------------------------------------------

/** The six tables MasterData's "Manage Data Tables" grid actually renders.
 *  `roles`/`role_plants` are two of `master_data.py`'s eight ALLOWED_TABLES
 *  but are owned by the `Security` module's dedicated roles UI instead (its
 *  own `/master-data/roles`(+`/role_plants`) fetches, not this generic grid
 *  engine) — `Security` stays container-`any`-typed until its own task. */
type MasterDataTable =
  | 'subnetworks' | 'plants' | 'production_lines'
  | 'materials' | 'material_plants' | 'bom_items';

/** `column_metadata` row shape returned alongside every `GET
 *  /master-data/{table}` (master_data.py `_column_meta`/get_table_data). */
interface MasterDataColumn {
  column_name: string;
  display_label: string;
  is_locked: boolean;
  column_order?: number;
}

/** A row in any Manage Data Tables grid. The DDL wizard (`_openAddColumn`)
 *  can add an arbitrary new column to any of the six tables at runtime, and
 *  every table also carries `created_at`/`updated_at` the grid never reads
 *  by name — hence the open index signature, same convention as `NimbusTask`
 *  in types.mts. The generic grid-engine functions below (`_rowKey`,
 *  `_parsePaste`, `_appendRow`, `_markDirty`, …) operate on this base shape
 *  since they read/write columns purely by the dynamic `column_name` string
 *  the table's own `columns` metadata supplies, never by a table-specific
 *  field name. */
interface MasterDataRow {
  [key: string]: unknown;
}

/** `GET /master-data/{table}` response envelope (master_data.py
 *  get_table_data) — not part of the backend's `response_model=` scope (only
 *  the task-date-update endpoint family is, per Phase 4's landed note), so
 *  hand-written locally following that phase's precedent. Not constrained to
 *  `T extends MasterDataRow`: `_save`'s post-write Store refresh reuses this
 *  same envelope typed over `NimbusMasterPlant`/`NimbusMasterLine`
 *  (types.mts) instead of the local `PlantRow`/`ProductionLineRow`, since
 *  that fetch feeds `Store.setMasterData` directly and those domain
 *  interfaces carry no index signature. */
interface MasterDataResponse<T = MasterDataRow> {
  columns: MasterDataColumn[];
  rows: T[];
  meta?: { total: number };
}

/** Per-table client-side edit buffer (`_cache[table]`): the last-loaded
 *  baseline rows plus in-progress edits not yet POSTed to `/bulk`. */
interface MasterDataTableState<T extends MasterDataRow = MasterDataRow> {
  columns: MasterDataColumn[];
  rows: T[];
  /** rowKey -> patch (a shallow-copied-and-mutated row carrying only the edited baseline + changed fields). */
  dirty: Map<string, T>;
  deleted: Set<string>;
  added: T[];
}

/** `production_lines` row — the one table `MasterData.syncLineSettings`
 *  reads/writes specific named fields on (the rest of the grid engine never
 *  needs more than the base `MasterDataRow` bag). Column names/types per
 *  schema.sql; `bottleneck`/`excl_optimizer` are DB `TEXT` flag columns
 *  ('X' or null), not real booleans. */
interface ProductionLineRow extends MasterDataRow {
  subnetwork: string;
  plant: string;
  production_line: string;
  line_key?: string;
  pl_group?: string | null;
  bottleneck?: string | null;
  excl_optimizer?: string | null;
  buffer_type?: string | null;
  buffer_percent?: number | null;
  buffer_hours?: number | null;
}

// Per-table row shapes for the other five tables MasterData's grid renders,
// per schema.sql (not part of the backend's `response_model=` scope — only
// the task-date-update endpoint family is, per Phase 4's landed note — so
// hand-written locally, same as ProductionLineRow above). Not every field
// below is read by name anywhere in this generic grid engine (which mostly
// operates on the base `MasterDataRow` bag via each table's own dynamic
// `columns` metadata) — these exist so a future consumer that DOES need a
// specific table's shape (the way `syncLineSettings` needs
// `ProductionLineRow`, or the BOM component picker below needs
// `MaterialPlantRow`) has one ready instead of re-deriving it from schema.sql.

interface SubnetworkRow extends MasterDataRow {
  code: string;
  name: string;
}

interface PlantRow extends MasterDataRow {
  subnetwork: string;
  plant: string;
  alt_flag_horizon?: number;
  conf_score_horizon?: number;
  split_order_policy?: 'never' | 'overlong_only' | 'partial_allowed' | null;
  /** Attached by master_data.py's get_table_data for the 'plants' table only. */
  constraints?: ConstraintConfig[] | null;
}

interface MaterialRow extends MasterDataRow {
  material_id: string;
  material_description?: string;
  material_type?: string;
  base_uom?: string;
}

/** Also the shape of the BOM component-picker's `material_plants` fetches
 *  (`_loadBomMaterialsForPlant`, `_bomComponentSelect`) — both only read
 *  `material_id`, but the row carries the rest of the columns below too. */
interface MaterialPlantRow extends MasterDataRow {
  material_id: string;
  plant: string;
  subnetwork?: string;
  status_pl?: string;
  default_production_version?: string;
  min_lot_size?: number;
  incremental_lot_size?: number;
}

interface BomItemRow extends MasterDataRow {
  material_id: string;
  plant: string;
  alternative_bom: string;
  level: number;
  item_number: string;
  component_id: string;
  base_quantity?: number | null;
  item_category?: string;
  assembly?: string;
  component_quantity?: number | null;
  base_unit_of_measure?: string;
  valid_from?: string | null;
  valid_to?: string | null;
  changed_on?: string | null;
  change_number?: string;
}

/** `POST /master-data/{table}/cascade-preview` response (master_data.py) —
 *  counts of dependent rows a delete would also remove (or, for
 *  `material_plants`, rows that block the delete). */
interface MasterDataCascadePreview {
  plants?: number;
  production_lines?: number;
  bom_items?: number;
}

/** `POST /master-data/{table}/bulk` response (master_data.py bulk_apply). */
interface MasterDataBulkResult {
  inserted: number;
  updated: number;
  deleted: number;
}

/** bom_items' plant+material scope gate (`_renderBomGate`). */
interface BomFilter {
  plant: string | null;
  material_id: string | null;
}

/** Shape `_loadAndRender` stamps onto a plain `Error` after
 *  `Util.parseBackendError` parses a non-OK response — mirrors
 *  schedule-data.mts's `SaveError` idiom. */
interface MasterDataFetchError extends Error {
  errorCode?: string;
  httpStatus?: number;
}

interface ComboboxOpts {
  value?: string;
  placeholder?: string;
  onSelect?: (value: string) => void;
}

// Minimal self-contained searchable combobox — reuses the topbar
// PlantSelector's markup/CSS classes (hps-*) for visual consistency and
// the same type-to-filter/keyboard-nav interaction, but works off a plain
// options array with no Store dependency, so it fits BOM's plant AND
// material pickers (PlantSelector itself is wired one-to-one to
// Store.selectedPlant and the global topbar DOM), as well as Plant's
// priority-list line-override picker (`_renderOptimization` above) — moved
// to true module top-level (out of MasterData's IIFE, where it previously
// lived) so both call sites can reach it as a bare identifier.
function _mkCombobox(containerEl: HTMLElement | null, options: string[], { value = '', placeholder = '', onSelect }: ComboboxOpts = {}): void {
  if (!containerEl) return;
  // Options were previously always DB-backed plant/material names (BOM's two
  // pickers); Task 12 added a third call site whose options list is line
  // names, and the dropdown's own option-row rendering below never escaped
  // `o` in the first place — cheap to close now rather than carry forward.
  const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]);
  containerEl.innerHTML = `
    <div class="hps-combobox md-bom-combobox">
      <input type="text" class="hps-input" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false"
             aria-haspopup="listbox" aria-expanded="false">
      <button type="button" class="hps-clear" hidden>&times;</button>
      <div class="hps-dropdown" role="listbox" hidden></div>
    </div>`;
  const root      = containerEl.querySelector('.hps-combobox') as HTMLElement;
  const input     = root.querySelector('.hps-input') as HTMLInputElement;
  const clearBtn  = root.querySelector('.hps-clear') as HTMLButtonElement;
  const dropdown  = root.querySelector('.hps-dropdown') as HTMLElement;
  let filtered: string[]  = [];
  let activeIdx = -1;
  let open      = false;
  let selected  = value;

  function reflect(): void {
    input.value = selected || '';
    root.classList.toggle('has-value', !!selected);
    clearBtn.hidden = !selected;
  }
  function renderDropdown(query: string): void {
    const q = (query || '').trim().toLowerCase();
    const looksLikeLabel = selected && String(query).trim().toLowerCase() === String(selected).toLowerCase();
    const filterQ = looksLikeLabel ? '' : q;
    filtered = filterQ ? options.filter((o) => String(o).toLowerCase().includes(filterQ)) : options.slice();
    if (!filtered.length) {
      dropdown.innerHTML = `<div class="hps-empty">${options.length ? Util.t('ui.no_matches') : Util.t('ui.no_options')}</div>`;
      activeIdx = -1;
      return;
    }
    dropdown.innerHTML = filtered.map((o, i) =>
      `<div class="hps-option${o === selected ? ' selected' : ''}" role="option" data-idx="${i}">${esc(o)}</div>`
    ).join('');
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
  function openDd()  { dropdown.hidden = false; open = true;  input.setAttribute('aria-expanded', 'true'); }
  function closeDd() { dropdown.hidden = true;  open = false; activeIdx = -1; input.setAttribute('aria-expanded', 'false'); }
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

/* =============================================================================
   MASTER DATA — Manage Data Tables admin sub-tab UI (Subnetwork / Plant / Production Line)
   ========================================================================== */
export const MasterData = (() => {
  const API = Config.API_BASE;
  let _activeTable: MasterDataTable = 'subnetworks';
  // Per-table state: { columns, rows, dirty: Map(rowKey→patch), deleted: Set(rowKey), added: [] }
  const _cache: Partial<Record<MasterDataTable, MasterDataTableState>> = {};

  const TABLE_LABELS: Record<MasterDataTable, string> = {
    subnetworks:      'Subnetworks',
    plants:           'Plants',
    production_lines: 'Production Lines',
    materials:        'Material',
    material_plants:  'Material Plant',
    bom_items:        'Bill of Materials',
  };

  // KEY_COLS drives primary-key identification per table.
  const KEY_COLS: Record<MasterDataTable, string[]> = {
    subnetworks:      ['code'],
    plants:           ['subnetwork', 'plant'],
    production_lines: ['subnetwork', 'plant', 'production_line'],
    materials:        ['material_id'],
    material_plants:  ['material_id', 'plant'],
    bom_items:        ['material_id', 'plant', 'alternative_bom', 'level', 'item_number', 'component_id'],
  };

  // Tables that need a parent-dropdown for FK columns.
  const FK_SOURCE: Partial<Record<MasterDataTable, Record<string, MasterDataTable>>> = {
    plants:           { subnetwork: 'subnetworks' },
    production_lines: { subnetwork: 'subnetworks', plant: 'plants' },
    material_plants:  { material_id: 'materials' },
    // bom_items.component_id is deliberately NOT registered here: it needs a
    // plant-scoped option list (material_plants filtered to the row's plant),
    // which the generic _fkSelect (whole-source-table, single-key convention)
    // can't express. See the bom_items special case in _appendRow instead.
  };

  // bom_items requires a plant + material pick before the grid loads (its
  // table is expected to be huge — one row per component per level per
  // material — unlike every other MasterData table, which loads in full).
  let _bomFilter: BomFilter = { plant: null, material_id: null };

  function _rowKey(table: MasterDataTable, row: MasterDataRow): string {
    return KEY_COLS[table].map((k) => String(row[k] ?? '')).join('|');
  }

  function _parsePaste(rawText: string, columns: MasterDataColumn[]): { rows: MasterDataRow[] } {
    const lines = rawText.replace(/\r/g, '').split('\n').filter((l) => l.trim());
    if (!lines.length) return { rows: [] };
    const colNames  = columns.map((c) => c.column_name.toLowerCase());
    const colLabels = columns.map((c) => (c.display_label || c.column_name).toLowerCase());
    const first     = lines[0].split('\t').map((h) => h.trim().toLowerCase());
    const hasHeader = first.some((h) => colNames.includes(h) || colLabels.includes(h));
    let headers: string[], dataLines: string[];
    if (hasHeader) {
      headers   = first.map((h) => {
        const ni = colNames.indexOf(h);
        if (ni >= 0) return columns[ni].column_name;
        const li = colLabels.indexOf(h);
        return li >= 0 ? columns[li].column_name : h;
      });
      dataLines = lines.slice(1);
    } else {
      headers   = columns.map((c) => c.column_name);
      dataLines = lines;
    }
    const rows = dataLines.map((line) => {
      const vals = line.split('\t');
      const row: MasterDataRow = {};
      headers.forEach((h, i) => { row[h] = (vals[i] ?? '').trim(); });
      return row;
    });
    return { rows };
  }

  // -----------------------------------------------------------------------
  // Public entry point
  // -----------------------------------------------------------------------
  function render(): void {
    // Wire inner tabs on first call.
    document.querySelectorAll<HTMLElement>('.md-tab').forEach((b) => {
      b.onclick = () => _setTab(b.dataset.mdTab as MasterDataTable);
    });
    const exportBtn = document.getElementById('md-export-schema-btn');
    if (exportBtn) exportBtn.onclick = _exportSchema;
    _syncTabUI();
    _renderActiveTable();
  }

  function _setTab(table: MasterDataTable): void {
    _activeTable = table;
    _syncTabUI();
    _renderActiveTable();
  }

  function _syncTabUI(): void {
    document.querySelectorAll<HTMLElement>('.md-tab').forEach((b) =>
      b.classList.toggle('active', b.dataset.mdTab === _activeTable));
  }

  // bom_items never loads unscoped (its table is expected to be huge) — show
  // the plant+material picker gate until both are chosen, same as every
  // other tab shows its grid immediately.
  function _renderActiveTable(): void {
    if (_activeTable === 'bom_items' && !(_bomFilter.plant && _bomFilter.material_id)) {
      _renderBomGate();
    } else {
      _loadAndRender(_activeTable);
    }
  }

  // -----------------------------------------------------------------------
  // BOM plant + material scope gate
  // -----------------------------------------------------------------------
  function _renderBomGate(): void {
    const host = document.getElementById('md-host');
    if (!host) return;
    host.innerHTML = `
      <div class="md-bom-gate">
        <p class="md-bom-gate-hint">${Util.t('hint.bom_pick_scope')}</p>
        <div class="md-bom-gate-row">
          <label>${Util.t('ui.plant_label')}</label>
          <div id="md-bom-plant-picker"></div>
        </div>
        <div class="md-bom-gate-row">
          <label>${Util.t('col.material')}</label>
          <div id="md-bom-material-picker"></div>
        </div>
      </div>`;
    const plants = Store.knownPlants ? Store.knownPlants() : [];
    _mkCombobox(document.getElementById('md-bom-plant-picker'), plants, {
      value: _bomFilter.plant || '',
      placeholder: Util.t('ph.select_plant'),
      onSelect: (p) => {
        _bomFilter = { plant: p || null, material_id: null };
        _renderBomGate();
      },
    });
    if (_bomFilter.plant) _loadBomMaterialsForPlant(_bomFilter.plant);
  }

  async function _loadBomMaterialsForPlant(plant: string): Promise<void> {
    const matHost = document.getElementById('md-bom-material-picker');
    if (matHost) matHost.innerHTML = `<div class="md-loading-inline">${Util.t('ui.loading')}</div>`;
    try {
      const data = await Util.fetchTraced(`${API}/master-data/material_plants?${new URLSearchParams({ plant }).toString()}`)
        .then((r) => r.json()) as MasterDataResponse<MaterialPlantRow>;
      const materials = (data.rows || []).map((r) => r.material_id).sort();
      const host2 = document.getElementById('md-bom-material-picker');
      if (!host2) return; // tab/plant changed again while this was in flight
      _mkCombobox(host2, materials, {
        value: _bomFilter.material_id || '',
        placeholder: Util.t('ph.select_material'),
        onSelect: (m) => {
          _bomFilter.material_id = m || null;
          if (m) _loadAndRender('bom_items');
        },
      });
    } catch (e) {
      if (matHost) matHost.innerHTML = `<div class="md-empty">${Util.t('err.load_materials_failed')}</div>`;
      ErrorLog.error('master-data', `Failed to load materials for plant ${plant}: ${(e as Error).message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------
  async function _loadAndRender(table: MasterDataTable): Promise<void> {
    const host = document.getElementById('md-host');
    if (!host) return;
    host.innerHTML = `<div class="md-loading">${Util.t('ui.loading')}</div>`;
    const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    // bom_items is the one table that must never load in full — always scope
    // the request to the plant + material the user picked via the gate.
    // Non-null assertions: only reached via _renderActiveTable, which already
    // gated on both being set before calling _loadAndRender('bom_items').
    const qs = table === 'bom_items'
      ? `?${new URLSearchParams({ plant: _bomFilter.plant!, material_id: _bomFilter.material_id! }).toString()}`
      : '';
    try {
      const data = await Util.fetchTraced(`${API}/master-data/${table}${qs}`, { headers: { 'x-request-id': reqId } }).then(async (r) => {
        if (!r.ok) {
          // Surface the backend body instead of discarding it.
          const parsed = await Util.parseBackendError(r);
          const err = new Error(parsed.message) as MasterDataFetchError;
          err.errorCode = parsed.errorCode; err.httpStatus = r.status;
          throw err;
        }
        return r.json() as Promise<MasterDataResponse>;
      });
      _cache[table] = {
        columns: data.columns,
        rows:    data.rows,
        dirty:   new Map(),
        deleted: new Set(),
        added:   [],
      };
      _renderTable(table);
    } catch (e) {
      const err = e as MasterDataFetchError;
      host.innerHTML = `<div class="md-empty">Failed to load ${TABLE_LABELS[table]}: ${err.message}</div>`;
      ErrorLog.error('master-data', `Load failed for ${table}: ${err.message}`,
        { reqId, table, status: err.httpStatus }, { reqId, errorCode: err.errorCode || 'http.network' });
    }
  }

  // -----------------------------------------------------------------------
  // Table rendering
  // -----------------------------------------------------------------------
  function _renderTable(table: MasterDataTable): void {
    const host = document.getElementById('md-host');
    if (!host) return;
    const state = _cache[table];
    if (!state) return;

    const { columns, rows, dirty, deleted, added } = state;
    const allRows = [...rows, ...added];
    const isDirty = dirty.size > 0 || deleted.size > 0 || added.length > 0;

    host.innerHTML = '';

    if (table === 'bom_items') {
      const scopeBar = document.createElement('div');
      scopeBar.className = 'md-bom-scope-bar';
      scopeBar.innerHTML = `<span>${Util.t('ui.plant_label')}: <strong>${_bomFilter.plant}</strong> &middot; ${Util.t('col.material')}: <strong>${_bomFilter.material_id}</strong></span>`;
      const changeBtn = document.createElement('button');
      changeBtn.className = 'btn btn-ghost sm';
      changeBtn.textContent = Util.t('btn.change_scope');
      changeBtn.onclick = () => {
        _bomFilter = { plant: null, material_id: null };
        delete _cache.bom_items;
        _renderActiveTable();
      };
      scopeBar.appendChild(changeBtn);
      host.appendChild(scopeBar);
    }

    // -- Toolbar --
    const toolbar = document.createElement('div');
    toolbar.className = 'md-toolbar';

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'input md-search';
    searchInput.placeholder = Util.t('ph.search_table', { table: TABLE_LABELS[table] });
    searchInput.oninput = () => _applyFilter(table, searchInput.value.toLowerCase());
    toolbar.appendChild(searchInput);

    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    toolbar.appendChild(spacer);

    if (isDirty) {
      const badge = document.createElement('span');
      badge.className = 'md-dirty-badge';
      const n = dirty.size + deleted.size + added.length;
      badge.textContent = Util.t('ui.unsaved_badge', { count: n });
      toolbar.appendChild(badge);
    }

    const addRowBtn = document.createElement('button');
    addRowBtn.className = 'btn btn-ghost sm';
    addRowBtn.textContent = Util.t('btn.add_row');
    addRowBtn.onclick = () => _addRow(table);
    toolbar.appendChild(addRowBtn);

    const pasteBtn = document.createElement('button');
    pasteBtn.className = 'btn btn-ghost sm';
    pasteBtn.textContent = Util.t('btn.paste_rows');
    pasteBtn.title = Util.t('tip.paste_rows');
    pasteBtn.onclick = () => _pasteRows(table);
    toolbar.appendChild(pasteBtn);

    if (table === 'bom_items') {
      const uploadBtn = document.createElement('button');
      uploadBtn.className = 'btn btn-ghost sm';
      uploadBtn.textContent = Util.t('btn.upload_bom');
      uploadBtn.title = Util.t('tip.upload_bom');
      uploadBtn.onclick = () => _uploadBom();
      toolbar.appendChild(uploadBtn);
    }

    const addColBtn = document.createElement('button');
    addColBtn.className = 'btn btn-ghost sm';
    addColBtn.textContent = Util.t('btn.add_column');
    addColBtn.onclick = () => _openAddColumn(table);
    toolbar.appendChild(addColBtn);

    const discardBtn = document.createElement('button');
    discardBtn.className = 'btn btn-ghost sm';
    discardBtn.textContent = Util.t('btn.discard');
    discardBtn.disabled = !isDirty;
    discardBtn.onclick = () => { delete _cache[table]; _loadAndRender(table); };
    toolbar.appendChild(discardBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = `btn btn-primary sm${isDirty ? '' : ' md-save-idle'}`;
    saveBtn.textContent = Util.t('btn.save');
    saveBtn.disabled = !isDirty;
    saveBtn.onclick = () => _save(table);
    toolbar.appendChild(saveBtn);

    host.appendChild(toolbar);

    // -- Table --
    const wrap = document.createElement('div');
    wrap.className = 'md-table-wrap';

    const tbl = document.createElement('table');
    tbl.className = 'md-table';
    tbl.id = `md-tbl-${table}`;

    // Header
    const thead = document.createElement('thead');
    const hRow = document.createElement('tr');
    columns.forEach((col) => {
      const th = document.createElement('th');
      th.className = 'md-th';
      const lbl = document.createElement('span');
      lbl.textContent = col.display_label;
      th.appendChild(lbl);

      // Column action menu (⋮)
      const menuBtn = document.createElement('button');
      menuBtn.className = 'md-col-menu-btn';
      menuBtn.textContent = '⋮';
      menuBtn.title = Util.t('tip.col_options');
      menuBtn.onclick = e => { e.stopPropagation(); _openColMenu(table, col, menuBtn); };
      th.appendChild(menuBtn);

      hRow.appendChild(th);
    });
    // Blank header for delete button column
    hRow.appendChild(document.createElement('th'));
    thead.appendChild(hRow);
    tbl.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    tbody.id = `md-tbody-${table}`;

    if (!allRows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = columns.length + 1;
      td.className = 'md-empty';
      td.textContent = Util.t('empty.table_no_rows', { table: TABLE_LABELS[table] });
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      allRows.forEach((row) => _appendRow(tbody, table, columns, row));
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    host.appendChild(wrap);
  }

  function _appendRow(tbody: HTMLTableSectionElement, table: MasterDataTable, columns: MasterDataColumn[], row: MasterDataRow): void {
    const state = _cache[table]!;
    const key = _rowKey(table, row);
    const isNew = state.added.some((r) => _rowKey(table, r) === key);
    const isDeleted = state.deleted.has(key);
    const isDirty = state.dirty.has(key);
    // Render pending (dirty) values over the saved baseline so an in-progress edit
    // survives a re-render (add/paste/delete all call _renderTable). For added rows
    // the dirty entry IS the added row object, so rowView resolves to the same values.
    const _dirtyPatch = state.dirty.get(key);
    const rowView: MasterDataRow = _dirtyPatch ? { ...row, ..._dirtyPatch } : row;

    const tr = document.createElement('tr');
    tr.dataset.rowKey = key;
    tr.className = [
      isNew     ? 'md-row-new'     : '',
      isDeleted ? 'md-row-deleted' : '',
      isDirty   ? 'md-row-dirty'   : '',
    ].filter(Boolean).join(' ');

    columns.forEach((col) => {
      const td = document.createElement('td');
      td.className = 'md-td';

      // bom_items.component_id: plant-scoped dropdown (material_plants rows
      // for this row's plant), not the generic FK_SOURCE/_fkSelect path —
      // that assumes the source table's LAST key column is the value column
      // (true for material_plants -> 'plant', wrong for what we need: 'material_id').
      if (table === 'bom_items' && col.column_name === 'component_id' && isNew) {
        const rowPlant = rowView.plant != null ? String(rowView.plant) : '';
        td.appendChild(_bomComponentSelect(rowPlant || _bomFilter.plant, rowView.component_id, key));
        tr.appendChild(td);
        return;
      }

      // FK columns get a <select> populated from parent table.
      const fkSources = FK_SOURCE[table] || {};
      const srcTable = fkSources[col.column_name];
      if (srcTable && !isNew) {
        // For existing rows, key columns are read-only.
        if (col.is_locked) {
          td.textContent = String(rowView[col.column_name] ?? '');
        } else {
          td.appendChild(_fkSelect(table, col.column_name, rowView[col.column_name], srcTable, key));
        }
      } else if (srcTable && isNew) {
        td.appendChild(_fkSelect(table, col.column_name, rowView[col.column_name], srcTable, key));
      } else if (col.is_locked && !isNew) {
        // Key columns on saved rows are read-only.
        td.textContent = String(rowView[col.column_name] ?? '');
      } else {
        const cell = document.createElement('div');
        cell.contentEditable = isDeleted ? 'false' : 'true';
        cell.className = 'md-cell';
        cell.textContent = String(rowView[col.column_name] ?? '');
        cell.dataset.col = col.column_name;
        cell.dataset.rowKey = key;
        cell.oninput = () => _markDirty(table, key, col.column_name, cell.textContent);
        td.appendChild(cell);
      }
      tr.appendChild(td);
    });

    // Delete button
    const delTd = document.createElement('td');
    delTd.className = 'md-td md-td-action';
    if (!isDeleted) {
      const delBtn = document.createElement('button');
      delBtn.className = 'icon-btn md-del-btn';
      delBtn.title = Util.t('tip.delete_row');
      delBtn.textContent = '🗑';
      delBtn.onclick = () => _deleteRow(table, key, tr);
      delTd.appendChild(delBtn);
    } else {
      const undoBtn = document.createElement('button');
      undoBtn.className = 'btn btn-ghost sm';
      undoBtn.textContent = Util.t('btn.undo');
      undoBtn.onclick = () => { state.deleted.delete(key); _renderTable(table); };
      delTd.appendChild(undoBtn);
    }
    tr.appendChild(delTd);
    tbody.appendChild(tr);
  }

  function _fkSelect(table: MasterDataTable, colName: string, value: unknown, sourceTable: MasterDataTable, rowKey: string): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.className = 'input md-fk-select';
    // Populate from cache or fetch.
    const sourceState = _cache[sourceTable];
    const sourceRows = sourceState?.rows ?? [];
    const srcKeys = KEY_COLS[sourceTable];
    // For subnetworks: use 'code'. For plants when in production_lines: use 'plant'.
    const valCol = srcKeys[srcKeys.length - 1];
    const labelCol = sourceTable === 'subnetworks' ? 'name' : valCol;

    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = Util.t('ui.select_placeholder');
    sel.appendChild(blank);
    const _optLabel = (r: MasterDataRow): string =>
      (r[labelCol] && labelCol !== valCol) ? `${String(r[valCol])} — ${String(r[labelCol])}` : String(r[valCol] ?? '');
    sourceRows.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = String(r[valCol] ?? '');
      opt.textContent = _optLabel(r);
      if (r[valCol] === value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.onchange = () => _markDirty(table, rowKey, colName, sel.value);

    // If source not loaded yet, fetch it.
    if (!sourceState) {
      fetch(`${API}/master-data/${sourceTable}`).then((r) => r.json()).then((data: MasterDataResponse) => {
        _cache[sourceTable] = { columns: data.columns, rows: data.rows, dirty: new Map(), deleted: new Set(), added: [] };
        // Rebuild select options.
        while (sel.options.length > 1) sel.remove(1);
        data.rows.forEach((r) => {
          const opt = document.createElement('option');
          opt.value = String(r[valCol] ?? '');
          opt.textContent = _optLabel(r);
          if (r[valCol] === value) opt.selected = true;
          sel.appendChild(opt);
        });
      }).catch(() => {});
    }
    return sel;
  }

  // Per-plant memoized list of material_ids valid at that plant, used only
  // by the bom_items component_id dropdown. Deliberately separate from
  // _cache['material_plants'] (which may be absent, or scoped to a
  // different plant if that tab was visited) rather than risking either
  // table's cached view corrupting the other's.
  const _bomComponentOptionsCache: Record<string, string[]> = {};

  function _bomComponentSelect(plant: string | null, value: unknown, rowKey: string): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.className = 'input md-fk-select';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = Util.t('ui.select_placeholder');
    sel.appendChild(blank);

    const fill = (materials: string[]): void => {
      while (sel.options.length > 1) sel.remove(1);
      materials.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === value) opt.selected = true;
        sel.appendChild(opt);
      });
    };
    sel.onchange = () => _markDirty('bom_items', rowKey, 'component_id', sel.value);

    if (plant && _bomComponentOptionsCache[plant]) {
      fill(_bomComponentOptionsCache[plant]);
    } else if (plant) {
      fetch(`${API}/master-data/material_plants?${new URLSearchParams({ plant }).toString()}`)
        .then((r) => r.json())
        .then((data: MasterDataResponse<MaterialPlantRow>) => {
          const materials = (data.rows || []).map((r) => r.material_id).sort();
          _bomComponentOptionsCache[plant] = materials;
          fill(materials);
        }).catch(() => {});
    }
    return sel;
  }

  function _markDirty(table: MasterDataTable, rowKey: string, colName: string, value: unknown): void {
    const state = _cache[table];
    if (!state) return;
    // An existing dirty entry accumulates further edits. For a row's FIRST edit start
    // the patch from a SHALLOW COPY of the live baseline, so the baseline in
    // state.rows is never mutated in place — EXCEPT for newly-added rows, which ARE
    // their own working copy in state.added and are intentionally edited in place
    // (_save reads them from there; copying one would leave the added entry blank and
    // trip the "missing key columns" guard in _save).
    let patch = state.dirty.get(rowKey);
    if (!patch) {
      const addedRow = (state.added || []).find((r) => _rowKey(table, r) === rowKey);
      patch = addedRow ? addedRow : { ..._getRowByKey(table, rowKey) };
    }
    patch[colName] = value;
    state.dirty.set(rowKey, patch);
    // Update the tr class to show dirty highlight.
    const tr = document.querySelector(`#md-tbody-${table} tr[data-row-key="${CSS.escape(rowKey)}"]`);
    if (tr) tr.classList.add('md-row-dirty');
    _updateSaveBtn(table);
  }

  function _getRowByKey(table: MasterDataTable, key: string): MasterDataRow {
    const state = _cache[table];
    const all = [...(state?.rows ?? []), ...(state?.added ?? [])];
    return all.find((r) => _rowKey(table, r) === key) ?? {};
  }

  function _updateSaveBtn(table: MasterDataTable): void {
    const state = _cache[table];
    if (!state) return;
    const isDirty = state.dirty.size > 0 || state.deleted.size > 0 || state.added.length > 0;
    const saveBtn = document.querySelector('#md-host .btn-primary.sm') as HTMLButtonElement | null;
    if (saveBtn) {
      saveBtn.disabled = !isDirty;
      saveBtn.classList.toggle('md-save-idle', !isDirty);
    }
    // Update dirty badge.
    const badge = document.querySelector('#md-host .md-dirty-badge') as HTMLElement | null;
    if (badge) {
      const n = state.dirty.size + state.deleted.size + state.added.length;
      badge.textContent = `${n} unsaved`;
      badge.hidden = !isDirty;
    }
  }

  function _addRow(table: MasterDataTable): void {
    const state = _cache[table];
    if (!state) return;
    const newRow: MasterDataRow = {};
    state.columns.forEach((c) => { newRow[c.column_name] = ''; });
    if (table === 'bom_items') {
      // A new row is always within the currently scoped material+plant —
      // pre-fill so the user isn't retyping the scope on every row.
      newRow.material_id = _bomFilter.material_id || '';
      newRow.plant = _bomFilter.plant || '';
    }
    state.added.push(newRow);
    // Re-render to show the new row (simpler than appending).
    _renderTable(table);
    // Focus first editable cell of the new row.
    setTimeout(() => {
      const tbody = document.getElementById(`md-tbody-${table}`);
      const lastRow = tbody?.lastElementChild;
      const firstCell = lastRow?.querySelector('.md-cell') as HTMLElement | null;
      if (firstCell) firstCell.focus();
    }, 50);
  }

  async function _uploadBom(): Promise<void> {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      try {
        const resp = await Util.fetchTraced(`${API}/bom/upload`, { method: 'POST', body: fd });
        const result = await resp.json();
        if (!resp.ok) throw new Error(result.detail || result.message || Util.t('toast.bom_upload_failed'));
        Toast.show(
          Util.t('toast.bom_upload_done', {
            inserted: result.inserted || 0, updated: result.updated || 0, rejected: result.rejected || 0,
          }),
          result.rejected ? 'warn' : 'success',
        );
        if (result.warnings && result.warnings.length) {
          result.warnings.slice(0, 10).forEach((w: { msg: string }) => ErrorLog.warn('master-data', w.msg));
        }
        // Refresh the currently-scoped view so newly uploaded rows for this
        // material+plant show up immediately.
        delete _cache.bom_items;
        if (_activeTable === 'bom_items') _renderActiveTable();
      } catch (e) {
        Toast.show(`${Util.t('toast.bom_upload_failed')}: ${(e as Error).message}`, 'error');
        ErrorLog.error('master-data', `BOM upload failed: ${(e as Error).message}`);
      }
    };
    input.click();
  }

  async function _pasteRows(table: MasterDataTable): Promise<void> {
    let raw: string;
    try {
      raw = await navigator.clipboard.readText();
    } catch {
      Toast.show(Util.t('toast.clipboard_denied'), 'error');
      return;
    }
    if (!raw.trim()) { Toast.show(Util.t('toast.clipboard_empty'), 'error'); return; }

    const state = _cache[table];
    if (!state) return;

    const { rows } = _parsePaste(raw, state.columns);
    if (!rows.length) { Toast.show(Util.t('toast.no_rows_paste'), 'error'); return; }

    const keys    = KEY_COLS[table];
    const toAdd: MasterDataRow[]    = [];
    const toUpdate: MasterDataRow[] = [];
    const invalid: MasterDataRow[]  = [];

    rows.forEach((row) => {
      if (keys.find((k) => !row[k])) { invalid.push(row); return; }
      const key = _rowKey(table, row);
      const inSaved    = state.rows.some((r) => _rowKey(table, r) === key);
      const inAdded    = state.added.some((r) => _rowKey(table, r) === key);
      const batchAddIdx = toAdd.findIndex((r) => _rowKey(table, r) === key);
      const batchUpdIdx = toUpdate.findIndex((r) => _rowKey(table, r) === key);
      if      (batchAddIdx >= 0)  toAdd[batchAddIdx]    = row; // last write wins within batch
      else if (batchUpdIdx >= 0)  toUpdate[batchUpdIdx] = row;
      else if (inSaved || inAdded) toUpdate.push(row);
      else                         toAdd.push(row);
    });

    if (!toAdd.length && !toUpdate.length) {
      Toast.show(invalid.length
        ? Util.t('toast.missing_key_rows', { count: invalid.length, keys: keys.join(', ') })
        : Util.t('toast.no_valid_rows'), 'error');
      return;
    }

    const parts: string[] = [];
    if (toAdd.length)    parts.push(`add ${toAdd.length} new`);
    if (toUpdate.length) parts.push(`update ${toUpdate.length} existing`);
    if (invalid.length)  parts.push(`skip ${invalid.length} invalid`);

    // NOTE: the original call passed `tone: 'info' as any` — ModalConfirmOpts.tone
    // (application-foundation.mts) only ever accepted 'danger'|'warn', so 'info' was
    // never a real option; Modal.confirm's own tone check (`tone === 'warn' ? warn :
    // danger`) already fell through to the same 'danger' button styling for any other
    // value including 'info', so omitting it here changes no runtime behavior.
    const ok = await Modal.confirm({
      title:   'Paste Rows',
      message: `This will ${parts.join(', ')} row(s).`,
      detail:  `Changes appear in the table but won't be saved until you click Save.` +
               (invalid.length ? ` Skipped rows are missing key column(s): ${keys.join(', ')}.` : ''),
    });
    if (!ok) return;

    toAdd.forEach((row) => {
      const full: MasterDataRow = {};
      state.columns.forEach((c) => { full[c.column_name] = row[c.column_name] ?? ''; });
      state.added.push(full);
    });

    toUpdate.forEach((row) => {
      const key = _rowKey(table, row);
      const idx = state.rows.findIndex((r) => _rowKey(table, r) === key);
      if (idx >= 0) {
        Object.assign(state.rows[idx], row);
        state.dirty.set(key, { ...state.rows[idx] });
      } else {
        const ai = state.added.findIndex((r) => _rowKey(table, r) === key);
        if (ai >= 0) Object.assign(state.added[ai], row);
      }
    });

    _renderTable(table);
    Toast.show(invalid.length
      ? Util.t('toast.paste_result_skip', { added: toAdd.length, updated: toUpdate.length, skipped: invalid.length })
      : Util.t('toast.paste_result', { added: toAdd.length, updated: toUpdate.length }), 'success');
  }

  async function _deleteRow(table: MasterDataTable, rowKey: string, tr: HTMLTableRowElement): Promise<void> {
    const state = _cache[table];
    if (!state) return;

    // Build delete payload from the key.
    const keys = KEY_COLS[table];
    const row = _getRowByKey(table, rowKey);
    const deletePayload: MasterDataRow = {};
    keys.forEach((k) => { deletePayload[k] = row[k]; });

    // Get cascade preview for saved rows (not for newly-added rows).
    const isNew = state.added.some((r) => _rowKey(table, r) === rowKey);
    let cascadeDetail = '';

    if (!isNew && (table === 'subnetworks' || table === 'plants' || table === 'material_plants')) {
      try {
        const preview = await fetch(`${API}/master-data/${table}/cascade-preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deletes: [deletePayload] }),
        }).then((r) => r.json()) as MasterDataCascadePreview;

        const parts: string[] = [];
        const nPlants = preview.plants ?? 0, nLines = preview.production_lines ?? 0, nBom = preview.bom_items ?? 0;
        if (nPlants > 0)  parts.push(`<strong>${nPlants}</strong> plant${nPlants !== 1 ? 's' : ''}`);
        if (nLines > 0)   parts.push(`<strong>${nLines}</strong> production line${nLines !== 1 ? 's' : ''}`);
        if (nBom > 0)     parts.push(`<strong>${nBom}</strong> BOM item${nBom !== 1 ? 's' : ''}`);
        if (parts.length) {
          cascadeDetail = table === 'material_plants'
            ? `<div class="md-cascade-warn">This is referenced by ${parts.join(' and ')} — delete those first.</div>`
            : `<div class="md-cascade-warn">This will also permanently delete ${parts.join(' and ')}.</div>`;
        }
      } catch {}
    }

    const keyDisplay = keys.map((k) => row[k]).join(' / ');
    const confirmed = await Modal.confirm({
      title:         `Delete "${keyDisplay}"?`,
      message:       `Are you sure you want to delete this ${TABLE_LABELS[table].replace(/s$/, '').toLowerCase()} from the database?`,
      detail:        cascadeDetail || undefined,
      confirmLabel:  'Yes, delete',
      tone:          'danger',
    });
    if (!confirmed) return;

    if (isNew) {
      // Just remove from added array.
      const idx = state.added.findIndex((r) => _rowKey(table, r) === rowKey);
      if (idx >= 0) state.added.splice(idx, 1);
      _renderTable(table);
    } else {
      state.deleted.add(rowKey);
      tr.className = 'md-row-deleted';
      _updateSaveBtn(table);
      _renderTable(table);
    }
  }

  // -----------------------------------------------------------------------
  // Save
  // -----------------------------------------------------------------------
  async function _save(table: MasterDataTable): Promise<void> {
    const state = _cache[table];
    if (!state) return;
    const keys = KEY_COLS[table];

    // Build upserts from dirty + added.
    const upserts: MasterDataRow[] = [];
    state.dirty.forEach((patch, _key) => { if (!state.deleted.has(_key)) upserts.push(patch); });
    state.added.forEach((row) => {
      // Validate that key columns are filled.
      const missing = keys.filter((k) => !row[k]);
      if (missing.length) {
        Toast.show(Util.t('toast.no_plant_selected') + ': ' + missing.join(', '), 'error');
        return;
      }
      upserts.push(row);
    });

    // Build deletes.
    const deletes: MasterDataRow[] = [];
    state.deleted.forEach((rowKey) => {
      const row = _getRowByKey(table, rowKey);
      const d: MasterDataRow = {};
      keys.forEach((k) => { d[k] = row[k]; });
      deletes.push(d);
    });

    if (!upserts.length && !deletes.length) return;

    // Cascade confirmation for deletes that weren't already confirmed.
    if (deletes.length && (table === 'subnetworks' || table === 'plants' || table === 'material_plants')) {
      try {
        const preview = await fetch(`${API}/master-data/${table}/cascade-preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deletes }),
        }).then((r) => r.json()) as MasterDataCascadePreview;
        const nPlants = preview.plants ?? 0, nLines = preview.production_lines ?? 0, nBom = preview.bom_items ?? 0;
        const total = nPlants + nLines + nBom;
        if (total > 0) {
          const parts: string[] = [];
          if (nPlants > 0) parts.push(`${nPlants} plant${nPlants !== 1 ? 's' : ''}`);
          if (nLines > 0)  parts.push(`${nLines} production line${nLines !== 1 ? 's' : ''}`);
          if (nBom > 0)    parts.push(`${nBom} BOM item${nBom !== 1 ? 's' : ''}`);
          const ok = table === 'material_plants'
            ? await Modal.confirm({
                title:         `Cannot delete ${deletes.length} row${deletes.length !== 1 ? 's' : ''}`,
                message:       `This is referenced by ${parts.join(' and ')} — delete those first.`,
                confirmLabel:  `OK`,
                tone:          'danger',
              }).then(() => false)
            : await Modal.confirm({
                title:         `Delete ${deletes.length} row${deletes.length !== 1 ? 's' : ''}?`,
                message:       `This will also permanently delete ${parts.join(' and ')}.`,
                detail:        '<strong>This cannot be undone.</strong>',
                confirmLabel:  `Yes, delete all`,
                tone:          'danger',
              });
          if (!ok) return;
        }
      } catch {}
    }

    try {
      const res = await fetch(`${API}/master-data/${table}/bulk`, {
        method:  'POST',
        headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
        body:    JSON.stringify({ upserts, deletes }),
      }).then((r) => {
        if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); });
        return r.json() as Promise<MasterDataBulkResult>;
      });

      Toast.show(
        Util.t('toast.paste_result', { added: res.inserted, updated: res.updated }) + `, ${res.deleted} deleted`,
        'success'
      );
      delete _cache[table];
      await _loadAndRender(table);

      // Refresh master-data in Store so Hierarchy/ProdLines stay in sync.
      Promise.all([
        fetch(`${API}/master-data/plants`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok ? r.json() : null) as Promise<MasterDataResponse<NimbusMasterPlant> | null>,
        fetch(`${API}/master-data/production_lines`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok ? r.json() : null) as Promise<MasterDataResponse<NimbusMasterLine> | null>,
      ]).then(([pData, lData]) => {
        if (pData || lData) {
          // Public Store.setMasterData(...) equivalent of the former direct
          // `Store._state.masterData = {...}; Store.rebuildPlantIndex();` write
          // (CQ-1 Phase 4 Task 2 — closes MasterData's tracked §6 exception).
          // It fires its own 'master-data-changed' emit (without the `table`
          // field the old manual emit below carried — unused by any
          // subscriber, confirmed by inspection), so the `table`-carrying
          // emit only needs to fire on the no-op (neither fetch returned
          // rows) branch to preserve the original single-emit-per-call shape.
          Store.setMasterData({
            plants: pData?.rows ?? [],
            lines:  lData?.rows ?? [],
          }, 'master-data-save');
        } else {
          Store.emit({ type: 'master-data-changed', table, source: 'master-data-save' });
        }
      }).catch(() => {
        Store.emit({ type: 'master-data-changed', table, source: 'master-data-save' });
      });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('master-data', `Save failed for ${table}: ${(e as Error).message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Filter / search
  // -----------------------------------------------------------------------
  function _applyFilter(table: MasterDataTable, query: string): void {
    const tbody = document.getElementById(`md-tbody-${table}`);
    if (!tbody) return;
    tbody.querySelectorAll('tr').forEach((tr) => {
      const text = (tr.textContent || '').toLowerCase();
      tr.hidden = query ? !text.includes(query) : false;
    });
  }

  // -----------------------------------------------------------------------
  // Column management
  // -----------------------------------------------------------------------
  function _openColMenu(table: MasterDataTable, col: MasterDataColumn, anchor: HTMLElement): void {
    // Close any existing menu.
    document.querySelectorAll('.md-col-menu').forEach(m => m.remove());

    const menu = document.createElement('div');
    menu.className = 'md-col-menu';

    const rename = document.createElement('button');
    rename.className = 'md-col-menu-item';
    rename.textContent = Util.t('btn.rename_label');
    rename.onclick = () => { menu.remove(); _openRenameLabel(table, col); };
    menu.appendChild(rename);

    const drop = document.createElement('button');
    drop.className = 'md-col-menu-item md-col-menu-danger';
    drop.textContent = Util.t('btn.delete_column');
    drop.disabled = col.is_locked;
    drop.title = col.is_locked ? Util.t('tip.key_cols_no_delete') : '';
    drop.onclick = () => { menu.remove(); _dropColumn(table, col); };
    menu.appendChild(drop);

    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.top  = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.left}px`;

    const close = (e: MouseEvent): void => { if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  function _openAddColumn(table: MasterDataTable): void {
    (document.getElementById('md-col-name') as HTMLInputElement).value  = '';
    (document.getElementById('md-col-label') as HTMLInputElement).value = '';
    (document.getElementById('md-col-type') as HTMLSelectElement).value  = 'TEXT';
    (document.getElementById('md-col-length') as HTMLInputElement).value = '';
    (document.getElementById('md-col-default') as HTMLInputElement).value = '';
    (document.getElementById('md-col-nullable') as HTMLInputElement).checked = true;
    (document.getElementById('md-addcol-error') as HTMLElement).textContent = '';
    (document.getElementById('md-col-length-row') as HTMLElement).hidden = true;

    const typeSelect = document.getElementById('md-col-type') as HTMLSelectElement;
    typeSelect.onchange = () => {
      (document.getElementById('md-col-length-row') as HTMLElement).hidden = typeSelect.value !== 'NUMERIC';
    };

    (document.getElementById('md-addcol-confirm-btn') as HTMLButtonElement).onclick = async () => {
      const colName  = (document.getElementById('md-col-name') as HTMLInputElement).value.trim();
      const label    = (document.getElementById('md-col-label') as HTMLInputElement).value.trim() || colName;
      const sqlType  = (document.getElementById('md-col-type') as HTMLSelectElement).value;
      const length   = (document.getElementById('md-col-length') as HTMLInputElement).value.trim() || null;
      const nullable = (document.getElementById('md-col-nullable') as HTMLInputElement).checked;
      const def      = (document.getElementById('md-col-default') as HTMLInputElement).value.trim() || null;
      const errEl    = document.getElementById('md-addcol-error') as HTMLElement;

      if (!colName) { errEl.textContent = Util.t('ui.column_id_required'); return; }
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(colName)) {
        errEl.textContent = Util.t('ui.column_id_format');
        return;
      }
      if (!nullable && !def) {
        errEl.textContent = Util.t('ui.not_null_requires_default');
        return;
      }

      Modal.close('md-addcol-modal');

      try {
        await fetch(`${API}/master-data/${table}/columns`, {
          method:  'POST',
          headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
          body:    JSON.stringify({ column_name: colName, sql_type: sqlType, length, nullable, default: def, display_label: label }),
        }).then((r) => {
          if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); });
          return r.json();
        });
        Toast.show(Util.t('toast.col_added', { label }), 'success');
        delete _cache[table];
        _loadAndRender(table);
      } catch (e) {
        Toast.show(Util.t('toast.failed_add_col', { msg: (e as Error).message }), 'error');
      }
    };

    Modal.open('md-addcol-modal');
  }

  async function _dropColumn(table: MasterDataTable, col: MasterDataColumn): Promise<void> {
    const confirmed = await Modal.confirm({
      title:         Util.t('modal.drop_column_title', { label: col.display_label }),
      message:       Util.t('modal.drop_column_msg', { name: col.column_name, table: TABLE_LABELS[table] }),
      detail:        `<strong>${Util.t('modal.delete_cannot_undo')}</strong>`,
      confirmLabel:  Util.t('modal.drop_column_confirm'),
      tone:          'danger',
    });
    if (!confirmed) return;

    try {
      await fetch(`${API}/master-data/${table}/columns/${col.column_name}`, {
        method:  'DELETE',
        headers: { 'x-user-email': Session.actor() },
      }).then((r) => {
        if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); });
        return r.json();
      });
      Toast.show(Util.t('toast.column_dropped', { col: col.column_name }), 'success');
      delete _cache[table];
      _loadAndRender(table);
    } catch (e) {
      Toast.show(Util.t('toast.failed_drop_column', { msg: (e as Error).message }), 'error');
    }
  }

  function _openRenameLabel(table: MasterDataTable, col: MasterDataColumn): void {
    const noteEl  = document.getElementById('md-rename-note');
    const inputEl = document.getElementById('md-rename-label-input') as HTMLInputElement;
    if (noteEl)  noteEl.textContent = `Column ID: "${col.column_name}" (unchanged) · Table: ${TABLE_LABELS[table]}`;
    if (inputEl) inputEl.value = col.display_label;

    (document.getElementById('md-rename-confirm-btn') as HTMLButtonElement).onclick = async () => {
      const newLabel = inputEl.value.trim();
      if (!newLabel) return;
      Modal.close('md-renamelabel-modal');
      try {
        await fetch(`${API}/master-data/${table}/columns/${col.column_name}`, {
          method:  'PATCH',
          headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
          body:    JSON.stringify({ display_label: newLabel }),
        }).then((r) => {
          if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); });
          return r.json();
        });
        Toast.show(Util.t('toast.column_label_updated', { label: newLabel }), 'success');
        delete _cache[table];
        _loadAndRender(table);
      } catch (e) {
        Toast.show(Util.t('toast.failed_rename_label', { msg: (e as Error).message }), 'error');
      }
    };
    Modal.open('md-renamelabel-modal');
  }

  // Pulls the current column state (whichever DB this app is pointed at —
  // local or Azure) back out as idempotent SQL, so drift from the Add/Drop
  // Column wizard (which mutates the live DB directly, with no git record)
  // can be folded back into schema.sql after the fact.
  async function _exportSchema(): Promise<void> {
    const textEl  = document.getElementById('md-schema-export-text') as HTMLTextAreaElement;
    const copyBtn = document.getElementById('md-schema-export-copy-btn') as HTMLButtonElement;
    textEl.value = '…';
    Modal.open('md-schema-export-modal');
    try {
      const data = await fetch(`${API}/master-data/_schema-export`).then((r) => {
        if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); });
        return r.json() as Promise<{ sql?: string }>;
      });
      textEl.value = data.sql || '';
    } catch (e) {
      textEl.value = '';
      Toast.show(Util.t('toast.failed_schema_export', { msg: (e as Error).message }), 'error');
    }
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(textEl.value)
        .then(() => Toast.show(Util.t('toast.schema_copied'), 'success'))
        .catch(() => Toast.show(Util.t('toast.clipboard_denied'), 'error'));
    };
  }

  async function syncLineSettings(line: string, patch: Partial<NimbusLineSetting>): Promise<void> {
    if (!_cache['production_lines']) {
      try {
        const data = await fetch(`${API}/master-data/production_lines`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<MasterDataResponse<ProductionLineRow>>;
        });
        _cache['production_lines'] = {
          columns: data.columns, rows: data.rows,
          dirty: new Map(), deleted: new Set(), added: [],
        };
      } catch { return; }
    }

    const state = _cache['production_lines']! as MasterDataTableState<ProductionLineRow>;
    const rowIdx = state.rows.findIndex((r) => r.production_line === line);
    if (rowIdx < 0) return;

    const updatedRow = { ...state.rows[rowIdx] };
    if ('excludeFromOpt' in patch) updatedRow.excl_optimizer  = patch.excludeFromOpt ? 'X' : null;
    if ('bottleneck'     in patch) updatedRow.bottleneck      = patch.bottleneck     ? 'X' : null;
    if ('bufferUnit'     in patch) updatedRow.buffer_type     = patch.bufferUnit === 'pct' ? '%' : 'hrs';
    if ('bufferPct'      in patch) updatedRow.buffer_percent  = patch.bufferPct;
    if ('bufferHours'    in patch) updatedRow.buffer_hours    = patch.bufferHours;
    if ('plGroup'        in patch) updatedRow.pl_group        = patch.plGroup || null;

    // Update cache row and clear any stale dirty flag so MasterData table stays consistent.
    state.rows[rowIdx] = updatedRow;
    state.dirty.delete(_rowKey('production_lines', updatedRow));

    try {
      await fetch(`${API}/master-data/production_lines/bulk`, {
        method:  'POST',
        headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
        body:    JSON.stringify({ upserts: [updatedRow], deletes: [] }),
      }).then((r) => {
        if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); });
        return r.json();
      });
      if (_activeTable === 'production_lines') _renderTable('production_lines');
    } catch (e) {
      ErrorLog.error('prod-lines', `Failed to save line setting: ${(e as Error).message}`);
    }
  }

  return { render, syncLineSettings };
})();

/* =============================================================================
   AdminCockpit backend response shapes — local interfaces for endpoints
   outside the backend's response_model= scope (GET /health, /diagnostics*,
   /logs/backend, POST /maintenance/*, /upload, /purge, /upload/audit,
   /audit/log), following schedule-data.mts's precedent for hand-written
   response interfaces (Phase 4). Fields are typed to what this module reads
   (cross-checked against brain.py/db.py), not the full backend shape.
   ========================================================================== */

/** DIAGNOSTICS.warnings entries (brain.py) — read by the pipeline "Emitted"
 *  step and rendered by _renderBackendWarnings / _warningList. */
interface AdminPipelineWarning {
  level?: 'info' | 'warn' | 'error';
  msg?: string;
  ts?: string;
  context?: Record<string, unknown>;
}

/** db.get_pool_stats() — shared by GET /health and GET /diagnostics/db. */
interface AdminPoolStats {
  pool_min?: number;
  pool_max?: number;
  pool_size?: number;
  pool_available?: number;
  requests_waiting?: number;
  requests_completed?: number;
  requests_errors?: number;
  returns_bad?: number;
  error?: string;
}

/** GET /health (brain.py get_health) — polled every 30s by the health bar. */
interface AdminHealthResponse {
  db: {
    connected: boolean;
    ping_ms: number;
    total_orders?: number;
    user_overrides?: number;
    last_upload_file?: string | null;
    last_upload_at?: string | null;
    error?: string;
  };
  pool: AdminPoolStats;
  memory: {
    stateless: boolean;
    loaded: boolean;
    task_count: number;
    loaded_at: string | null;
    load_ms?: number | null;
  };
  color_wheel: {
    path: string;
    reachable: boolean;
    misses: number;
    missed_colors: string[];
  };
}

/** brain.py's module-level DIAGNOSTICS dict, as returned by the `pipeline`
 *  key of GET /diagnostics/deep. */
interface AdminPipelineSnapshot {
  loaded_at: string | null;
  load_ms: number | null;
  source_file: string | null;
  raw_row_count: number;
  dropped_no_start_date: number;
  dropped_no_finish_date_filled: number;
  duplicate_ids_suffixed: number;
  color_merge_misses: number;
  color_merge_ms: number | null;
  missed_colors: string[];
  emitted_task_count: number;
  unique_id_count: number;
  lines: Record<string, number>;
  warnings: AdminPipelineWarning[];
  color_merge_is_per_request?: boolean;
}

/** db.get_db_deep_stats() — the `db_stats` key of GET /diagnostics/deep
 *  (distinct from GET /diagnostics/db's per-table `tables`/AdminTableStat). */
interface AdminDbStatsDeep {
  total: number;
  null_start: number;
  null_end: number;
  null_color: number;
  null_line: number;
  null_desc: number;
  null_runtime: number;
  date_range: { min: string | null; max: string | null };
  by_line: Record<string, number>;
  error?: string;
}

interface AdminColorWheelStats {
  error: string | null;
  total_in_orders: number;
  matched: number;
  missed: number;
  missed_colors: string[];
  wheel_total?: number;
  missed_order_count?: number;
  missed_behavior?: string;
}

/** GET /diagnostics/deep. */
interface AdminDiagnosticsDeepResponse {
  pipeline: AdminPipelineSnapshot;
  db_stats: AdminDbStatsDeep;
  color_wheel: AdminColorWheelStats;
}

interface AdminServerInfo {
  version?: string | null;
  started_at?: string | null;
  database?: string | null;
  db_size?: string | null;
  max_connections?: string | number | null;
  error?: string;
}

interface AdminTableStatData {
  table: string;
  live_rows: number;
  dead_rows: number;
  dead_pct: number;
  last_vacuum: string | null;
  last_autovacuum: string | null;
  last_analyze: string | null;
  last_autoanalyze: string | null;
  total_size: string;
  mods_since_analyze: number;
  needs_vacuum: boolean;
  needs_analyze: boolean;
}

/** db.get_db_table_stats() returns either N real rows or a single-element
 *  `[{error}]` sentinel list on failure — never a mix, and never a real row
 *  carrying an `error` field alongside its domain data. A discriminated
 *  union (rather than an optional `error?` bolted onto the domain shape)
 *  models that honestly and lets callers narrow with `'error' in x`. */
type AdminTableStat = AdminTableStatData | { error: string };

interface AdminLongRunningQuery {
  pid: number;
  state: string | null;
  duration_s: number | null;
  query: string | null;
  wait_event_type?: string | null;
  wait_event?: string | null;
  application?: string | null;
}

interface AdminConnectionActivity {
  total: number;
  by_state: Record<string, number>;
  long_running: AdminLongRunningQuery[];
  error?: string;
}

interface AdminLockWaitData {
  blocked_pid: number;
  blocked_query: string | null;
  blocking_pid: number;
  blocking_query: string | null;
  lock_type: string | null;
  blocked_for_s: number | null;
}

/** db.get_db_lock_waits() — same `[{error}]`-sentinel-on-failure shape as
 *  AdminTableStat; see that type's comment. */
type AdminLockWait = AdminLockWaitData | { error: string };

interface AdminIndexUsageData {
  table: string;
  index: string;
  scans: number;
  tuples_read: number;
  tuples_fetched: number;
  index_size: string;
  unused: boolean;
}

/** db.get_db_index_usage() — same `[{error}]`-sentinel-on-failure shape as
 *  AdminTableStat; see that type's comment. */
type AdminIndexUsage = AdminIndexUsageData | { error: string };

interface AdminSlowQuery {
  query: string;
  calls: number;
  total_ms: number;
  mean_ms: number;
  stddev_ms: number;
  rows: number;
}

interface AdminSlowQueriesResult {
  available: boolean;
  queries: AdminSlowQuery[];
  error?: string;
}

interface AdminSequenceHealthData {
  schema: string;
  name: string;
  data_type: string;
  last_value: number;
  max_value: number | null;
  used_pct: number;
  cycles: boolean;
  status: 'ok' | 'warn' | 'err';
}

/** db.get_db_sequence_health() — same `[{error}]`-sentinel-on-failure shape
 *  as AdminTableStat; see that type's comment. */
type AdminSequenceHealth = AdminSequenceHealthData | { error: string };

/** Postgres ops console list endpoints (db.get_db_table_stats /
 *  get_db_lock_waits / get_db_index_usage / get_db_sequence_health) return
 *  either N real rows or a single-element `[{error}]` sentinel on failure —
 *  never a mix. Narrows a raw union-typed list down to that error message
 *  (or null when the list holds real rows), so call sites can branch on a
 *  real discriminated-union check instead of an unenforced optional-chain
 *  probe like `list[0]?.error`. */
function _adminListError<T extends object>(list: ReadonlyArray<T | { error: string }>): string | null {
  const first = list[0];
  return first && 'error' in first ? first.error : null;
}

/** Companion to _adminListError: the same list narrowed to its real-data
 *  rows (empty array when the list is the `[{error}]` sentinel). */
function _adminListRows<T extends object>(list: ReadonlyArray<T | { error: string }>): T[] {
  return _adminListError(list) ? [] : (list as T[]);
}

/** GET /diagnostics/db — the Admin Cockpit DB Deep Dive panel. */
interface AdminDbDeepResponse {
  pool: AdminPoolStats;
  server: AdminServerInfo;
  tables: AdminTableStat[];
  connections: AdminConnectionActivity;
  locks: AdminLockWait[];
  indexes: AdminIndexUsage[];
  slow_queries: AdminSlowQueriesResult;
  sequences: AdminSequenceHealth[];
  fetched_at: string;
}

/** One row of the in-memory backend event ring buffer (brain.py _log_event /
 *  ingest_frontend_logs) — GET /logs/backend returns these, newest first. */
/** rid/error_code are always snake_case here — brain.py's _log_event and
 *  ingest_frontend_logs (the only two writers of the ring buffer this
 *  endpoint reads) never write camelCase reqId/errorCode, so those aliases
 *  were dropped rather than kept as permanently-undefined dead fields. */
interface BackendLogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  category: string;
  msg: string;
  rid?: string;
  event?: string;
  outcome?: string;
  error_code?: string;
  error_type?: string;
  exc?: string;
  ctx?: Record<string, unknown>;
  source?: 'frontend';
}

/** GET /logs/backend. `dropped` is read by _renderBackendLog but the backend
 *  does not actually return it — always undefined; kept optional so the type
 *  matches that pre-existing (unchanged) runtime behavior exactly. */
interface BackendLogResponse {
  entries: BackendLogEntry[];
  total: number;
  dropped?: number;
}

/** POST /maintenance/vacuum-analyze | /maintenance/analyze. */
interface AdminMaintenanceResult {
  ok: boolean;
  status?: string;
  error?: string;
  error_code?: string;
  table?: string;
  results?: Record<string, string>;
}

interface AdminUploadWarning {
  level?: 'info' | 'warn' | 'error';
  msg?: string;
  status?: string;
}

/** POST /upload response (db.ingest_orders_from_excel). */
interface AdminUploadResult {
  status: 'ok' | 'error';
  message?: string;
  detail?: string;
  batch_id: string;
  raw_row_count: number;
  inserted: number;
  updated: number;
  warnings: AdminUploadWarning[];
  lines?: string[];
  error_code?: string;
}

/** POST /purge response (db.purge_orders_by_date). */
interface AdminPurgeResult {
  status: string;
  deleted: number;
  message?: string;
  detail?: string;
  error_code?: string;
}

/** One row of GET /upload/audit (db.upload_audit_log). */
interface AdminUploadAuditItem {
  batch_id: string;
  filename: string | null;
  row_count: number;
  inserted: number;
  updated: number;
  uploaded_at: string | null;
  warnings: AdminUploadWarning[];
}

interface AdminUploadAuditResponse {
  audit: AdminUploadAuditItem[];
}

/** One row of GET /audit/log (JSONL-backed color-wheel/optimizer audit trail). */
interface AdminAuditLogItem {
  ts: string;
  user?: string;
  action?: string;
  plant?: string;
  details?: Record<string, unknown>;
}

interface AdminAuditLogResponse {
  entries: AdminAuditLogItem[];
}

/** Frontend ErrorLog entry, named via the ReturnType<typeof ...> precedent
 *  (see e.g. schedule-workbench.mts's OptimizerKpis) rather than duplicating
 *  application-foundation.mts's unexported LogEntry shape. */
type AdminFrontendLogEntry = ReturnType<typeof ErrorLog.entries>[number];

/** Persistence._lastLoad snapshot (schedule-data.mts's unexported LoadStats),
 *  named the same ReturnType<typeof ...> way. */
type AdminPersistenceStats = ReturnType<typeof Persistence.stats>;

/** Persistence.storageInventory()'s unexported inline return shape, named the
 *  same ReturnType<typeof ...> way. */
type AdminStorageInventory = ReturnType<typeof Persistence.storageInventory>;

/** Chrome/V8-only `performance.memory` — not part of the standard DOM lib
 *  typings, so there is no ambient declaration to reuse; scoped locally since
 *  no other module in this migration reads it. */
interface ChromePerformanceMemory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
  totalJSHeapSize?: number;
}

/** A [label, value] pair rendered by _kvTable. */
type AdminKvRow = [string, string | number | null | undefined];

/** One row rendered by _dbTable (generic ad-hoc table builder — currently
 *  only fed the "non-idle queries" list under Active Connections). */
interface AdminDbTableRow {
  cells: Array<string | number | null>;
  rowWarn?: boolean;
  rowErr?: boolean;
  cellWarn: number[];
}

/** One box in the DB→Plant filter→Color merge→Emitted→Rendered pipeline strip
 *  built by _renderPipeline. */
interface AdminPipelineStep {
  key: string;
  label: string;
  count: number;
  delta: string | null;
  status: 'ok' | 'warn' | 'err';
  detail: () => DocumentFragment;
}

/* =============================================================================
   ADMIN COCKPIT — health bar, pipeline inspector, backend warnings,
   filterable logs, upload, purge, and upload history.
   ========================================================================== */
export const AdminCockpit = {
  _initialized: false,
  _pendingFile: null as File | null,
  _logFilter: { level: 'all', scope: 'all', search: '', errorCode: 'all', reqId: '' },
  _backendLogFilter: { level: 'all', category: 'all', since: '', q: '', reqId: '' },
  _healthData: null as AdminHealthResponse | null,
  _deepData: null as AdminDiagnosticsDeepResponse | null,
  _healthTimer: null as ReturnType<typeof setInterval> | null,
  _pipelineOpen: null as string | null,
  _activeSub: 'overview',
  _activeOvTab: 'diagnostics' as 'diagnostics' | 'data-ops' | 'logs' | 'thread',
  _dbDeepAbort: null as AbortController | null,
  _backendLogAbort: null as AbortController | null,
  _healthAbort: null as AbortController | null,
  _pipelineAbort: null as AbortController | null,
  _auditAbort: null as AbortController | null,
  _auditLogAbort: null as AbortController | null,
  _fpPurgeStart: null as NimbusVendor.FlatpickrInstance | null,
  _fpPurgeEnd: null as NimbusVendor.FlatpickrInstance | null,

  gotoOvTab(tab: 'diagnostics' | 'data-ops' | 'logs' | 'thread'): void {
    AdminCockpit._activeOvTab = tab;
    document.querySelectorAll<HTMLElement>('.admin-ov-tabs .sub-subtab').forEach((b) =>
      b.classList.toggle('active', b.dataset.ovTab === tab));
    (['diagnostics', 'data-ops', 'logs', 'thread'] as const).forEach(t => {
      const el = document.getElementById(`admin-ov-${t}`);
      if (el) el.hidden = (t !== tab);
    });
    if (tab === 'thread') AdminCockpit._refreshThreadPane();
  },

  _setSub(sub: string | undefined): void {
    AdminCockpit._activeSub = sub ?? 'overview';
    document.querySelectorAll<HTMLElement>('.admin-subtab').forEach((b) =>
      b.classList.toggle('active', b.dataset.sub === sub));
    const ov = document.getElementById('admin-overview-pane');
    const mg = document.getElementById('admin-manage-pane');
    const ifc = document.getElementById('admin-interface-pane');
    const sec = document.getElementById('admin-security-pane');
    if (ov) ov.hidden = (sub !== 'overview');
    if (mg) mg.hidden = (sub !== 'manage');
    if (ifc) ifc.hidden = (sub !== 'interface');
    if (sec) sec.hidden = (sub !== 'security');
    if (sub === 'manage') MasterData.render();
    else if (sub === 'interface') Interface.render();
    else if (sub === 'security') Security.render();
    else AdminCockpit._renderOverview();
  },

  init(): void {
    if (AdminCockpit._initialized) return;
    AdminCockpit._initialized = true;

    document.querySelectorAll<HTMLElement>('.admin-subtab').forEach((b) =>
      b.addEventListener('click', () => AdminCockpit._setSub(b.dataset.sub)));

    // Upload zone — drag-drop + click-browse
    const _uploadZone = document.getElementById('admin-upload-zone');
    const _uploadFile = document.getElementById('admin-upload-file') as HTMLInputElement | null;
    if (_uploadZone && _uploadFile) {
      _uploadZone.onclick    = (e: MouseEvent) => { if (e.target !== _uploadFile) _uploadFile.click(); };
      _uploadZone.onkeydown  = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _uploadFile.click(); } };
      _uploadFile.onchange   = () => { if (_uploadFile.files?.[0]) AdminCockpit._pickFile(_uploadFile.files[0]); };
      _uploadZone.ondragover = (e: DragEvent) => { e.preventDefault(); _uploadZone.classList.add('drag-over'); };
      _uploadZone.ondragleave= () => _uploadZone.classList.remove('drag-over');
      _uploadZone.ondrop     = (e: DragEvent) => {
        e.preventDefault();
        _uploadZone.classList.remove('drag-over');
        const f = e.dataTransfer?.files[0];
        if (f) AdminCockpit._pickFile(f);
      };
    }
    document.getElementById('admin-upload-clear')?.addEventListener('click', AdminCockpit._clearUpload);
    document.getElementById('admin-upload-btn')?.addEventListener('click', AdminCockpit._upload);
    document.getElementById('admin-purge-btn')?.addEventListener('click', AdminCockpit._purge);

    document.getElementById('admin-log-reload')?.addEventListener('click', () => Persistence.reload());
    document.getElementById('admin-log-cache')?.addEventListener('click', () => Persistence.clearCache());
    document.getElementById('admin-log-copy')?.addEventListener('click', () => ErrorLog.copy());
    document.getElementById('admin-log-copy-filtered')?.addEventListener('click', () => AdminCockpit._copyFiltered());
    document.getElementById('admin-log-clear')?.addEventListener('click', () => {
      ErrorLog.clear();
      AdminCockpit._renderLogs();
    });

    document.getElementById('admin-audit-reload')?.addEventListener('click', AdminCockpit._renderAudit);
    document.getElementById('admin-audit-clear')?.addEventListener('click', AdminCockpit._clearAudit);
    document.getElementById('admin-audit-log-reload')?.addEventListener('click', AdminCockpit._renderAuditLog);
    document.getElementById('admin-audit-log-clear')?.addEventListener('click', AdminCockpit._clearAuditLog);
    document.getElementById('admin-health-refresh')?.addEventListener('click', AdminCockpit._renderHealth);
    document.getElementById('admin-pipeline-refresh')?.addEventListener('click', AdminCockpit._renderPipeline);
    document.getElementById('admin-db-deep-refresh')?.addEventListener('click', AdminCockpit._renderDbDeep);
    document.getElementById('admin-db-deep')?.addEventListener('click', async (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('[data-maint-action]') as HTMLButtonElement | null;
      if (!btn) return;
      const action = btn.dataset.maintAction as 'vacuum-analyze' | 'analyze';
      const table  = btn.dataset.maintTable || null;
      if (action === 'vacuum-analyze' && !table) {
        const ok = await Modal.confirm({ title: Util.t('ui.maint_vacuum_all_confirm'), confirmLabel: Util.t('btn.run') });
        if (!ok) return;
      }
      AdminCockpit._runMaintenance(action, table, btn);
    });
    document.getElementById('admin-backend-log-refresh')?.addEventListener('click', AdminCockpit._renderBackendLog);
    document.getElementById('admin-backend-log-clear')?.addEventListener('click', AdminCockpit._clearBackendLog);
    document.getElementById('admin-backend-log-filter-level')?.addEventListener('change', (e: Event) => {
      AdminCockpit._backendLogFilter.level = (e.target as HTMLSelectElement).value;
      AdminCockpit._renderBackendLog();
    });

    // Filter controls
    document.getElementById('admin-log-filter-level')?.addEventListener('change', (e: Event) => {
      AdminCockpit._logFilter.level = (e.target as HTMLSelectElement).value;
      AdminCockpit._renderLogs();
    });
    document.getElementById('admin-log-filter-scope')?.addEventListener('change', (e: Event) => {
      AdminCockpit._logFilter.scope = (e.target as HTMLSelectElement).value;
      AdminCockpit._renderLogs();
    });
    document.getElementById('admin-log-search')?.addEventListener('input', (e: Event) => {
      AdminCockpit._logFilter.search = (e.target as HTMLInputElement).value.toLowerCase();
      AdminCockpit._renderLogs();
    });

    ErrorLog.subscribe(() => {
      const panel = document.getElementById('admin-tab');
      if (panel?.classList.contains('active')) {
        AdminCockpit._renderLogs();
      }
    });

    document.getElementById('admin-thread-clear')?.addEventListener('click', () => {
      PerfMonitor.clear();
      AdminCockpit._refreshThreadPane();
    });

    PerfMonitor.subscribe(() => {
      if (AdminCockpit._activeOvTab === 'thread') AdminCockpit._refreshThreadPane();
    });

    Store.subscribe((evt: StoreEvent) => {
      if (evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate') {
        const panel = document.getElementById('admin-tab');
        if (panel?.classList.contains('active')) {
          // Defer so Persistence._lastLoad stats are fully written before rendering.
          setTimeout(() => AdminCockpit._renderPipeline(), 50);
        }
      }
    }, 'AdminCockpit');

    document.addEventListener('mouseover', (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest?.('.adm-help') as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--tip-x', `${r.left + r.width / 2}px`);
      el.style.setProperty('--tip-y', `${r.top}px`);
    });
  },

  render(): void {
    AdminCockpit._setSub('overview');
    AdminCockpit._renderOverview();
  },

  _renderOverview(): void {
    AdminCockpit._renderPurgeMeta();
    AdminCockpit._renderHealth();
    AdminCockpit._renderDiagnostics();
    AdminCockpit._renderPipeline();
    AdminCockpit._renderDbDeep();
    AdminCockpit._renderBackendLog();
    AdminCockpit._renderLogs();
    AdminCockpit._renderAudit();
    AdminCockpit._renderAuditLog();
    AdminCockpit._startHealthPolling();
  },

  /** Started by _renderOverview; called from application-shell.mjs's
   *  visibility-change handler once that file is converted (Phase 5) so this
   *  public start/stop pair's signature is load-bearing beyond this module. */
  _startHealthPolling(): void {
    if (AdminCockpit._healthTimer) return;
    AdminCockpit._healthTimer = setInterval(() => {
      if (document.getElementById('admin-tab')?.classList.contains('active')) {
        AdminCockpit._renderHealth();
      }
    }, 30_000);
  },

  _stopHealthPolling(): void {
    if (AdminCockpit._healthTimer) {
      clearInterval(AdminCockpit._healthTimer);
      AdminCockpit._healthTimer = null;
    }
  },

  _renderHealth(): void {
    AdminCockpit._healthAbort?.abort();
    AdminCockpit._healthAbort = new AbortController();
    const sig = AbortSignal.any
      ? AbortSignal.any([AdminCockpit._healthAbort.signal, AbortSignal.timeout(6000)])
      : AdminCockpit._healthAbort.signal;
    Util.fetchTraced(`${Config.API_BASE}/health`, { signal: sig })
      .then((r) => r.json() as Promise<AdminHealthResponse>)
      .then((data) => {
        AdminCockpit._healthData = data;
        const db = data.db || {};
        const mem = data.memory || {};
        const cw = data.color_wheel || {};

        const dbEl = document.getElementById('admin-health-db');
        if (dbEl) {
          const dot = dbEl.querySelector<HTMLElement>('.admin-health-dot')!;
          const lbl = dbEl.querySelector<HTMLElement>('.admin-health-label')!;
          const cls = !db.connected ? 'err' : (db.ping_ms ?? 0) > 500 ? 'warn' : 'ok';
          dot.className = `admin-health-dot ${cls}`;
          lbl.textContent = db.connected
            ? `DB ${db.ping_ms}ms`
            : `DB offline${db.error ? ': ' + db.error.slice(0, 60) : ''}`;
        }

        const ordEl = document.getElementById('admin-health-orders');
        if (ordEl) {
          ordEl.querySelector<HTMLElement>('.admin-health-label')!.textContent =
            `${(db.total_orders ?? 0).toLocaleString()} orders`;
        }

        const ovEl = document.getElementById('admin-health-overrides');
        if (ovEl) {
          ovEl.querySelector<HTMLElement>('.admin-health-label')!.textContent =
            `${(db.user_overrides ?? 0).toLocaleString()} user overrides`;
        }

        const cwEl = document.getElementById('admin-health-color');
        if (cwEl) {
          const dot = cwEl.querySelector<HTMLElement>('.admin-health-dot')!;
          const lbl = cwEl.querySelector<HTMLElement>('.admin-health-label')!;
          const misses = cw.misses ?? 0;
          dot.className = `admin-health-dot ${misses > 0 ? 'warn' : 'ok'}`;
          lbl.textContent = misses > 0
            ? Util.t('ui.color_wheel_miss', { count: misses, plural: misses === 1 ? '' : 'es' })
            : Util.t('ui.color_wheel_all_matched');
        }

        const poolChip = document.getElementById('admin-health-pool');
        if (poolChip) {
          const pPool = data.pool || {};
          const dot  = poolChip.querySelector<HTMLElement>('.admin-health-dot');
          const plbl = poolChip.querySelector<HTMLElement>('.admin-health-label');
          if (pPool.error) {
            if (dot) dot.className = 'admin-health-dot warn';
            if (plbl) plbl.textContent = Util.t('ui.pool_unavailable');
          } else {
            const used = (pPool.pool_size ?? 0) - (pPool.pool_available ?? 0);
            const max  = pPool.pool_max || 1;
            const pct  = Math.round(100 * used / max);
            const cls  = pct >= 85 ? 'err' : (pct >= 60 ? 'warn' : 'ok');
            if (dot) dot.className = `admin-health-dot ${cls}`;
            if (plbl) plbl.textContent = `Pool ${used}/${max}`;
          }
        }

        const ldEl = document.getElementById('admin-health-loaded');
        if (ldEl) {
          const lbl = ldEl.querySelector<HTMLElement>('.admin-health-label')!;
          const loadedAt = mem.loaded_at ? new Date(mem.loaded_at) : null;
          lbl.textContent = loadedAt
            ? `Loaded ${AdminCockpit._relTime(loadedAt)}${mem.load_ms != null ? ' · ' + mem.load_ms + 'ms' : ''}`
            : Util.t('ui.not_loaded');
        }
      })
      .catch((e: Error) => {
        const dbEl = document.getElementById('admin-health-db');
        if (dbEl) {
          const dot = dbEl.querySelector<HTMLElement>('.admin-health-dot')!;
          const lbl = dbEl.querySelector<HTMLElement>('.admin-health-label')!;
          dot.className = 'admin-health-dot err';
          lbl.textContent = Util.t('ui.backend_unreachable');
        }
        if (e.name !== 'AbortError') ErrorLog.warn('admin', `Health check failed: ${e.message}`);
      });
  },

  _renderPipeline(): void {
    const wrap = document.getElementById('admin-pipeline');
    if (!wrap) return;

    AdminCockpit._pipelineAbort?.abort();
    AdminCockpit._pipelineAbort = new AbortController();
    const sig = AbortSignal.any
      ? AbortSignal.any([AdminCockpit._pipelineAbort.signal, AbortSignal.timeout(8000)])
      : AdminCockpit._pipelineAbort.signal;
    Util.fetchTraced(`${Config.API_BASE}/diagnostics/deep`, { signal: sig })
      .then((r) => r.json() as Promise<AdminDiagnosticsDeepResponse>)
      .then((data) => {
        AdminCockpit._deepData = data;
        const p = (data.pipeline || {}) as AdminPipelineSnapshot;
        const dbSt = (data.db_stats || {}) as AdminDbStatsDeep;
        const cw = (data.color_wheel || {}) as AdminColorWheelStats;
        const st: AdminPersistenceStats = Persistence.stats ? Persistence.stats() : ({} as AdminPersistenceStats);

        const rendered   = st.rendered ?? 0;
        const rawDb      = p.raw_row_count ?? dbSt.total ?? 0;
        const activePlant = st.plant ?? null;
        // Color-merge stats come from the last /tasks response (per-request,
        // plant-scoped) — not /diagnostics/deep, which holds load-time defaults.
        const colorMiss  = st.color_merge_misses ?? 0;
        // received = rows after both plant filter + color merge (what UI got)
        const received   = st.raw_received ?? 0;
        // Rows entering color merge = post-plant-filter count (= received + misses)
        const preMerge   = st.pre_color_merge_count ?? (received + colorMiss);
        // Rows removed by plant filter = raw - what entered color merge
        const plantFiltered = activePlant ? Math.max(0, rawDb - preMerge) : 0;
        const gap = received - rendered;

        // Pipeline order: DB → [Plant filter if active] → Color Merge → Emitted → Rendered.
        // Reordered (May 2026) so color-miss counts are plant-scoped — the merge
        // now runs *after* the plant filter, against only the rows the user will see.
        const steps: AdminPipelineStep[] = [
          {
            key: 'db',
            label: 'DB Load',
            count: rawDb,
            delta: null,
            status: p.dropped_no_start_date > 0 ? 'warn' : 'ok',
            detail: () => AdminCockpit._pipelineDetailDB(p, dbSt),
          },
          ...(activePlant ? [{
            key: 'plant-filter',
            label: `Plant ${activePlant}`,
            count: preMerge,
            delta: plantFiltered > 0 ? `-${plantFiltered} (other plants)` : null,
            status: 'ok' as const,
            detail: () => AdminCockpit._pipelineDetailPlantFilter(st, plantFiltered, rawDb),
          }] : []),
          {
            key: 'color',
            label: 'Color Merge',
            count: received,
            delta: colorMiss > 0 ? `-${colorMiss} miss${colorMiss === 1 ? '' : 'es'}` : null,
            status: colorMiss > 0 ? 'warn' : 'ok',
            detail: () => AdminCockpit._pipelineDetailColor(p, cw, st),
          },
          {
            key: 'emitted',
            label: 'Emitted',
            count: received,
            delta: null,
            status: (p.warnings?.length ?? 0) > 0 ? 'warn' : 'ok',
            detail: () => AdminCockpit._pipelineDetailEmitted(p, st),
          },
          {
            key: 'rendered',
            label: 'Rendered',
            count: rendered,
            delta: gap > 0 ? `-${gap} gap` : null,
            status: gap > 0 ? 'err' : 'ok',
            detail: () => AdminCockpit._pipelineDetailRendered(st, p),
          },
        ];

        wrap.textContent = '';
        steps.forEach((s, i) => {
          if (i > 0) {
            const arrow = document.createElement('span');
            arrow.className = 'admin-pipeline-arrow';
            arrow.textContent = '→';
            wrap.appendChild(arrow);
          }
          const box = document.createElement('div');
          box.className = `admin-pipeline-step ${s.status}`;
          box.dataset.key = s.key;

          const cnt = document.createElement('div');
          cnt.className = 'admin-pipeline-step-count';
          cnt.textContent = s.count.toLocaleString();
          box.appendChild(cnt);

          const lbl = document.createElement('div');
          lbl.className = 'admin-pipeline-step-label';
          lbl.textContent = s.label;
          box.appendChild(lbl);

          if (s.delta) {
            const delta = document.createElement('div');
            delta.className = 'admin-pipeline-delta';
            delta.textContent = s.delta;
            box.appendChild(delta);
          }

          box.addEventListener('click', () => {
            const detail = document.getElementById('admin-pipeline-detail');
            if (!detail) return;
            if (AdminCockpit._pipelineOpen === s.key) {
              AdminCockpit._pipelineOpen = null;
              detail.classList.remove('open');
              detail.textContent = '';
            } else {
              AdminCockpit._pipelineOpen = s.key;
              detail.classList.add('open');
              detail.textContent = '';
              detail.appendChild(s.detail());
            }
          });

          wrap.appendChild(box);
        });

        // Backend warnings
        AdminCockpit._renderBackendWarnings(p.warnings || []);
      })
      .catch((e: Error) => {
        if (e.name === 'AbortError') return;
        wrap.innerHTML = `<div class="admin-log-empty">Could not load pipeline: ${e.message}</div>`;
        ErrorLog.warn('admin', `Pipeline fetch failed: ${e.message}`);
      });
  },

  _pipelineDetailDB(p: AdminPipelineSnapshot, dbSt: AdminDbStatsDeep): DocumentFragment {
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'admin-pdtl-head';
    head.textContent = Util.t('ui.db_load_details');
    frag.appendChild(head);

    const rows: AdminKvRow[] = [
      [Util.t('ui.diag_total_in_db'), (dbSt.total ?? '—').toLocaleString()],
      [Util.t('ui.diag_null_start_date'), dbSt.null_start ?? '—'],
      [Util.t('ui.diag_null_end_date'), dbSt.null_end ?? '—'],
      [Util.t('ui.diag_null_color'), dbSt.null_color ?? '—'],
      [Util.t('ui.diag_null_line'), dbSt.null_line ?? '—'],
      [Util.t('ui.diag_null_desc'), dbSt.null_desc ?? '—'],
      [Util.t('ui.diag_null_runtime'), dbSt.null_runtime ?? '—'],
      [Util.t('ui.diag_date_range_min'), dbSt.date_range?.min?.slice(0, 10) ?? '—'],
      [Util.t('ui.diag_date_range_max'), dbSt.date_range?.max?.slice(0, 10) ?? '—'],
      [Util.t('ui.diag_dropped_no_start'), p.dropped_no_start_date ?? 0],
      [Util.t('ui.diag_load_time'), p.load_ms != null ? p.load_ms + ' ms' : '—'],
    ];

    if (dbSt.by_line && Object.keys(dbSt.by_line).length) {
      const lbl = document.createElement('div');
      lbl.className = 'admin-pdtl-sub';
      lbl.textContent = Util.t('ui.orders_by_line');
      frag.appendChild(AdminCockpit._kvTable(rows));
      frag.appendChild(lbl);
      frag.appendChild(AdminCockpit._lineBar(dbSt.by_line));
      return frag;
    }

    frag.appendChild(AdminCockpit._kvTable(rows));
    return frag;
  },

  _pipelineDetailColor(p: AdminPipelineSnapshot, cw: AdminColorWheelStats, st: AdminPersistenceStats): DocumentFragment {
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'admin-pdtl-head';
    const scope = st?.plant ? ` (${Util.t('ui.plant_prefix')} ${st.plant})` : '';
    head.textContent = Util.t('ui.color_wheel_details') + scope;
    frag.appendChild(head);

    // Misses are now plant-scoped — pulled from the last /tasks meta via Persistence stats.
    const requestMiss = st?.color_merge_misses ?? 0;
    const requestMissed = st?.missed_colors ?? [];
    const requestMs = st?.backend_meta?.color_merge_ms as number | undefined;

    const rows: AdminKvRow[] = [
      [Util.t('ui.diag_scope'), st?.plant ? `${Util.t('ui.plant_prefix')} ${st.plant} only` : Util.t('ui.all_plants')],
      [Util.t('ui.diag_rows_entering_merge'), st?.pre_color_merge_count ?? '—'],
      [Util.t('ui.diag_global_wheel_colors'), cw.wheel_total ?? '—'],
      [Util.t('ui.diag_matched_rows'), (st?.pre_color_merge_count ?? 0) - requestMiss],
      [Util.t('ui.diag_missed_rows'), requestMiss],
      [Util.t('ui.diag_merge_time'), requestMs != null ? requestMs + ' ms' : '—'],
    ];
    frag.appendChild(AdminCockpit._kvTable(rows));

    if (requestMissed.length) {
      const sub = document.createElement('div');
      sub.className = 'admin-pdtl-sub';
      sub.textContent = Util.t('ui.unmatched_colors', { count: requestMissed.length });
      frag.appendChild(sub);
      const chips = document.createElement('div');
      chips.className = 'admin-pdtl-chips';
      for (const c of requestMissed) {
        const chip = document.createElement('span');
        chip.className = 'admin-pdtl-chip warn';
        chip.textContent = c;
        chips.appendChild(chip);
      }
      frag.appendChild(chips);
    } else {
      const ok = document.createElement('div');
      ok.className = 'admin-pdtl-ok';
      ok.textContent = Util.t('empty.no_colors_matched');
      frag.appendChild(ok);
    }
    return frag;
  },

  _pipelineDetailEmitted(p: AdminPipelineSnapshot, st: AdminPersistenceStats): DocumentFragment {
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'admin-pdtl-head';
    head.textContent = Util.t('ui.emitted_details');
    frag.appendChild(head);

    const scopeLbl = st?.plant ? `${Util.t('ui.plant_prefix')} ${st.plant}` : Util.t('ui.all_plants');
    const rows: AdminKvRow[] = [
      [Util.t('ui.diag_raw_from_db'), p.raw_row_count ?? '—'],
      [Util.t('ui.diag_dropped_no_start'), p.dropped_no_start_date ?? 0],
      [Util.t('ui.diag_active_scope'), scopeLbl],
      [Util.t('ui.diag_rows_entering_cmerge'), st?.pre_color_merge_count ?? '—'],
      [Util.t('ui.diag_color_merge_misses'), st?.color_merge_misses ?? 0],
      [Util.t('ui.diag_emitted'), st?.raw_received ?? '—'],
      [Util.t('ui.diag_unique_ids'), p.unique_id_count ?? '—'],
      [Util.t('ui.diag_loaded_at'), p.loaded_at ? p.loaded_at.replace('T', ' ').slice(0, 19) + ' UTC' : '—'],
    ];
    frag.appendChild(AdminCockpit._kvTable(rows));

    const warnings = p.warnings || [];
    if (warnings.length) {
      const sub = document.createElement('div');
      sub.className = 'admin-pdtl-sub';
      sub.textContent = Util.t('ui.diag_backend_load_warnings', { count: warnings.length });
      frag.appendChild(sub);
      frag.appendChild(AdminCockpit._warningList(warnings));
    }
    return frag;
  },

  _pipelineDetailPlantFilter(st: AdminPersistenceStats, plantFiltered: number, rawDb: number): DocumentFragment {
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'admin-pdtl-head';
    head.textContent = Util.t('ui.plant_filter_details');
    frag.appendChild(head);

    // Pipeline order is now: DB → Plant filter → Color merge → Emitted.
    // The pre-merge count here is what reaches the color merge stage.
    const preMerge = st?.pre_color_merge_count ?? 0;
    const rows: AdminKvRow[] = [
      [Util.t('ui.diag_active_plant'), st.plant ?? '—'],
      [Util.t('ui.diag_raw_rows_from_db'), rawDb ?? '—'],
      [Util.t('ui.diag_rows_this_plant'), preMerge],
      [Util.t('ui.diag_other_plant_excluded'), plantFiltered],
      [Util.t('ui.diag_final_emitted'), st.raw_received ?? '—'],
    ];
    frag.appendChild(AdminCockpit._kvTable(rows));
    return frag;
  },

  _pipelineDetailRendered(st: AdminPersistenceStats, p: AdminPipelineSnapshot): DocumentFragment {
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'admin-pdtl-head';
    head.textContent = Util.t('ui.rendering_details');
    frag.appendChild(head);

    // Gap is measured from received (post-plant-filter) so plant filtering does not
    // look like data loss here.
    const received = st.raw_received ?? 0;
    const rendered = st.rendered ?? 0;
    const gap = received - rendered;
    const rows: AdminKvRow[] = [
      [Util.t('ui.diag_received_by_ui'), received],
      [Util.t('ui.diag_pl_filtered'), st.filtered_pl ?? 0],
      [Util.t('ui.diag_null_id_dropped'), st.filtered_null_id ?? 0],
      [Util.t('ui.diag_store_collisions'), st.dedup_collisions ?? 0],
      [Util.t('ui.diag_rendered'), rendered],
      [Util.t('ui.diag_gap'), gap],
      [Util.t('ui.diag_source'), st.source ?? '—'],
    ];
    frag.appendChild(AdminCockpit._kvTable(rows));

    if (gap > 0) {
      const warn = document.createElement('div');
      warn.className = 'admin-pdtl-warn';
      warn.textContent = Util.t('ui.data_gap_warn', { count: gap });
      frag.appendChild(warn);
    }
    return frag;
  },

  _kvTable(rows: AdminKvRow[]): HTMLTableElement {
    const tbl = document.createElement('table');
    tbl.className = 'admin-pdtl-tbl';
    for (const [k, v] of rows) {
      const tr = document.createElement('tr');
      const tdK = document.createElement('td');
      tdK.className = 'admin-pdtl-key';
      tdK.textContent = k;
      const tdV = document.createElement('td');
      tdV.className = 'admin-pdtl-val';
      tdV.textContent = String(v ?? '—');
      tr.appendChild(tdK);
      tr.appendChild(tdV);
      tbl.appendChild(tr);
    }
    return tbl;
  },

  _lineBar(byLine: Record<string, number>): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'admin-pdtl-linebars';
    const max = Math.max(...Object.values(byLine));
    for (const [line, cnt] of Object.entries(byLine)) {
      const row = document.createElement('div');
      row.className = 'admin-pdtl-linebar-row';
      const lbl = document.createElement('span');
      lbl.className = 'admin-pdtl-linebar-lbl';
      lbl.textContent = line;
      const bar = document.createElement('div');
      bar.className = 'admin-pdtl-linebar-track';
      const fill = document.createElement('div');
      fill.className = 'admin-pdtl-linebar-fill';
      fill.style.width = `${Math.round((cnt / max) * 100)}%`;
      const num = document.createElement('span');
      num.className = 'admin-pdtl-linebar-num';
      num.textContent = String(cnt);
      bar.appendChild(fill);
      row.appendChild(lbl);
      row.appendChild(bar);
      row.appendChild(num);
      wrap.appendChild(row);
    }
    return wrap;
  },

  _warningList(warnings: AdminPipelineWarning[]): HTMLDivElement {
    const ul = document.createElement('div');
    ul.className = 'admin-bwarn-list';
    for (const w of warnings) {
      const row = document.createElement('div');
      row.className = `admin-bwarn-row admin-bwarn-${w.level || 'warn'}`;
      const lvl = document.createElement('span');
      lvl.className = 'admin-bwarn-lvl';
      lvl.textContent = (w.level || 'warn').toUpperCase();
      const msg = document.createElement('span');
      msg.className = 'admin-bwarn-msg';
      msg.textContent = w.msg || '';
      row.appendChild(lvl);
      row.appendChild(msg);
      ul.appendChild(row);
    }
    return ul;
  },

  _renderBackendWarnings(warnings: AdminPipelineWarning[]): void {
    const host = document.getElementById('admin-backend-warnings');
    const countEl = document.getElementById('admin-bwarn-count');
    if (!host) return;
    host.textContent = '';
    if (countEl) countEl.textContent = Util.t('ui.bwarn_count', { count: warnings.length });

    if (!warnings.length) {
      const ok = document.createElement('div');
      ok.className = 'admin-bwarn-empty';
      ok.textContent = Util.t('empty.no_backend_warnings');
      host.appendChild(ok);
      return;
    }

    for (const w of warnings) {
      const row = document.createElement('div');
      row.className = `admin-bwarn-row admin-bwarn-${w.level || 'warn'}`;
      row.style.cursor = w.context && Object.keys(w.context).length ? 'pointer' : '';

      const meta = document.createElement('div');
      meta.className = 'admin-bwarn-meta';
      const lvl = document.createElement('span');
      lvl.className = 'admin-bwarn-lvl';
      lvl.textContent = (w.level || 'warn').toUpperCase();
      const ts = document.createElement('span');
      ts.className = 'admin-bwarn-ts';
      ts.textContent = w.ts ? w.ts.replace('T', ' ').slice(0, 19) + ' UTC' : '';
      meta.appendChild(lvl);
      meta.appendChild(ts);

      const msg = document.createElement('div');
      msg.className = 'admin-bwarn-msg';
      msg.textContent = w.msg || '';

      row.appendChild(meta);
      row.appendChild(msg);

      if (w.context && Object.keys(w.context).length) {
        const pre = document.createElement('pre');
        pre.className = 'admin-bwarn-ctx';
        pre.style.display = 'none';
        pre.textContent = JSON.stringify(w.context, null, 2);
        row.appendChild(pre);
        row.addEventListener('click', () => {
          pre.style.display = pre.style.display === 'none' ? '' : 'none';
        });
      }

      host.appendChild(row);
    }
  },

  _updatePurgeCount(): void {
    const start = AdminCockpit._fpPurgeStart?.selectedDates[0];
    const end   = AdminCockpit._fpPurgeEnd?.selectedDates[0];
    const el    = document.getElementById('admin-past-count');
    if (!el) return;
    if (!start || !end) { el.textContent = ''; return; }
    const endOfDay = new Date(end); endOfDay.setHours(23, 59, 59, 999);
    const count = (Store.tasksArr || []).filter(t => t.end_date && t.end_date >= start && t.end_date <= endOfDay).length;
    el.innerHTML = count > 0
      ? `<strong style="color:var(--err,#c0392b)">${Util.t('ui.orders_in_range', {count, plural: count === 1 ? '' : 's'})}</strong>`
      : `<span style="color:var(--text-muted,#888)">${Util.t('ui.orders_in_range', {count: 0, plural: 's'})}</span>`;
  },

  _renderPurgeMeta(): void {
    const yesterday   = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const twoWeeksAgo = new Date(); twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    if (!AdminCockpit._fpPurgeStart) {
      AdminCockpit._fpPurgeStart = flatpickr('#admin-purge-start', {
        dateFormat: 'Y-m-d', altInput: true, altFormat: 'M j, Y',
        onChange: () => AdminCockpit._updatePurgeCount(),
      });
      AdminCockpit._fpPurgeEnd = flatpickr('#admin-purge-end', {
        dateFormat: 'Y-m-d', altInput: true, altFormat: 'M j, Y',
        onChange: () => AdminCockpit._updatePurgeCount(),
      });
    }
    AdminCockpit._fpPurgeStart!.setDate(twoWeeksAgo, false);
    AdminCockpit._fpPurgeEnd!.setDate(yesterday, false);
    AdminCockpit._updatePurgeCount();
  },

  _setStatus(el: HTMLElement | null, text: string, kind?: string): void {
    if (!el) return;
    el.textContent = text;
    el.className = 'admin-status' + (kind ? ' ' + kind : '');
  },

  _pickFile(file: File | null): void {
    if (!file) return;
    AdminCockpit._pendingFile = file;
    document.getElementById('admin-upload-info')!.hidden = false;
    document.getElementById('admin-upload-actions')!.hidden = false;
    document.getElementById('admin-upload-fname')!.textContent = file.name;
    document.getElementById('admin-upload-fsize')!.textContent =
      file.size < 1_048_576
        ? `${(file.size / 1024).toFixed(1)} KB`
        : `${(file.size / 1_048_576).toFixed(1)} MB`;
    const status = document.getElementById('admin-upload-status');
    if (status) { status.textContent = ''; status.className = 'admin-status'; }
  },

  _clearUpload(): void {
    AdminCockpit._pendingFile = null;
    const fi = document.getElementById('admin-upload-file') as HTMLInputElement | null;
    if (fi) fi.value = '';
    const info    = document.getElementById('admin-upload-info');
    const actions = document.getElementById('admin-upload-actions');
    const status  = document.getElementById('admin-upload-status');
    if (info)    info.hidden = true;
    if (actions) actions.hidden = true;
    if (status)  { status.textContent = ''; status.className = 'admin-status'; }
  },

  _upload(): void {
    const f      = AdminCockpit._pendingFile;
    const status = document.getElementById('admin-upload-status');
    const zone   = document.getElementById('admin-upload-zone');
    const btn    = document.getElementById('admin-upload-btn') as HTMLButtonElement | null;
    if (!f) {
      AdminCockpit._setStatus(status, Util.t('toast.pick_xlsx_first'), 'warn');
      return;
    }
    if (zone) zone.classList.add('uploading');
    if (btn)  btn.disabled = true;
    AdminCockpit._setStatus(status, Util.t('toast.uploading_file', { name: f.name }), 'info');
    const fd = new FormData();
    fd.append('file', f);
    const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    Util.fetchTraced(`${Config.API_BASE}/upload`, { method: 'POST', body: fd, headers: { 'x-request-id': reqId } })
      .then((r) => r.json().catch(() => ({})).then((j) => ({ ok: r.ok, body: j as AdminUploadResult })))
      .then(({ ok, body }) => {
        if (zone) zone.classList.remove('uploading');
        if (btn)  btn.disabled = false;
        if (!ok || body.status !== 'ok') {
          const msg = body?.message || body?.detail || 'HTTP error';
          AdminCockpit._setStatus(status, Util.t('toast.upload_failed', { msg }), 'error');
          ErrorLog.error('admin', `Upload failed: ${msg}`, body,
            { reqId, errorCode: body?.error_code || 'http.status' });
          return;
        }
        const warnCount = body.warnings?.length ?? 0;
        const w = warnCount ? ` (${warnCount} warning${warnCount === 1 ? '' : 's'})` : '';
        AdminCockpit._setStatus(
          status,
          `✓ Inserted ${body.inserted}, updated ${body.updated} of ${body.raw_row_count} rows${w}`,
          'success'
        );
        ErrorLog.info('admin',
          `Upload OK: inserted=${body.inserted} updated=${body.updated} batch=${body.batch_id}`, body);
        if (warnCount) {
          ErrorLog.warn('admin', `Upload had ${warnCount} warning(s)`, body.warnings);
        }
        Toast.show(Util.t('toast.upload_ok', { count: body.inserted + body.updated }), 'success');
        setTimeout(() => AdminCockpit._clearUpload(), 2000);
        Persistence.reload().then(() => {
          AdminCockpit._renderHealth();
          AdminCockpit._renderPipeline();
        });
        AdminCockpit._renderAudit();
      })
      .catch((e: Error) => {
        if (zone) zone.classList.remove('uploading');
        if (btn)  btn.disabled = false;
        AdminCockpit._setStatus(status, Util.t('toast.upload_failed', { msg: e.message }), 'error');
        ErrorLog.error('admin', `Upload network error: ${e.message}`,
          { reqId }, { reqId, errorCode: 'http.network' });
      });
  },

  async _purge(): Promise<void> {
    const startEl = document.getElementById('admin-purge-start') as HTMLInputElement | null;
    const endEl   = document.getElementById('admin-purge-end') as HTMLInputElement | null;
    const status  = document.getElementById('admin-purge-status');
    const start = startEl?.value;
    const end   = endEl?.value;
    if (!start || !end) {
      AdminCockpit._setStatus(status, Util.t('toast.pick_purge_dates'), 'warn');
      return;
    }
    if (start > end) {
      AdminCockpit._setStatus(status, Util.t('toast.purge_start_before_end'), 'warn');
      return;
    }
    const ok = await Modal.confirm({ title: Util.t('modal.purge_confirm', { start, end }), confirmLabel: Util.t('btn.yes_delete') });
    if (!ok) return;

    AdminCockpit._setStatus(status, Util.t('toast.purging', { start, end }), 'info');
    const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    Util.fetchTraced(`${Config.API_BASE}/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-request-id': reqId },
      body: JSON.stringify({ start_date: start + 'T00:00:00', end_date: end + 'T23:59:59' })
    })
      .then((r) => r.json().catch(() => ({})) as Promise<AdminPurgeResult>)
      .then((body) => {
        if (body.status !== 'ok') {
          AdminCockpit._setStatus(status, Util.t('toast.purge_failed', { msg: body.message || body.detail || 'unknown' }), 'error');
          ErrorLog.error('admin', `Purge failed: ${body.message || body.detail || 'unknown'}`, body,
            { reqId, errorCode: body?.error_code || 'http.status' });
          return;
        }
        AdminCockpit._setStatus(status, `✓ Deleted ${body.deleted} order${body.deleted === 1 ? '' : 's'}`, 'success');
        ErrorLog.info('admin', `Purge: deleted ${body.deleted} (${start} → ${end})`);
        Toast.show(Util.t('toast.purge_ok', { count: body.deleted }), 'success');
        Persistence.reload().then(() => {
          AdminCockpit._renderHealth();
          AdminCockpit._renderPipeline();
        });
      })
      .catch((e: Error) => {
        AdminCockpit._setStatus(status, Util.t('toast.purge_failed', { msg: e.message }), 'error');
        ErrorLog.error('admin', `Purge network error: ${e.message}`,
          { reqId }, { reqId, errorCode: 'http.network' });
      });
  },

  async _runMaintenance(action: 'vacuum-analyze' | 'analyze', table: string | null, triggerBtn: HTMLButtonElement | null): Promise<void> {
    const label = triggerBtn ? triggerBtn.textContent : action;
    if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = Util.t('ui.maint_running'); }
    const body = table ? { table } : {};
    try {
      const r = await fetch(`${Config.API_BASE}/maintenance/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-email': Session.actor() },
        body: JSON.stringify(body),
      }).then((res) => res.json() as Promise<AdminMaintenanceResult>);
      if (!r.ok) throw new Error(r.error || 'maintenance failed');
      Toast.show(Util.t('ui.maint_done', { label }), 'success');
      ErrorLog.info('admin', `Maintenance: ${action} ${table || '(all)'} ok`);
      AdminCockpit._renderDbDeep();
    } catch (e) {
      const err = e as Error;
      Toast.show(Util.t('ui.maint_failed', { label, msg: err.message }), 'error');
      ErrorLog.error('admin', `Maintenance: ${action} ${table || '(all)'} failed: ${err.message}`);
      if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = label; }
    }
  },

  /* FE↔BE correlation: clicking a reqId pins it as a filter on BOTH panes and
     refreshes them so the operator sees the matching frontend + backend events. */
  _correlateReqId(reqId: string | undefined): void {
    if (!reqId) return;
    AdminCockpit._logFilter.reqId        = reqId;
    AdminCockpit._backendLogFilter.reqId = reqId;
    AdminCockpit._renderLogs();
    AdminCockpit._renderBackendLog();
  },

  /* Render (or clear) a small "filtering by request <id>" chip at the top of a
     log list. `onClear` removes the filter. Self-contained: builds the chip if
     a reqId is set, removes any prior chip otherwise. */
  _renderReqIdChip(listId: string, reqId: string, onClear: () => void): void {
    const list = document.getElementById(listId);
    if (!list || !list.parentElement) return;
    const chipId = `${listId}-reqid-chip`;
    let chip = document.getElementById(chipId);
    if (!reqId) { if (chip) chip.remove(); return; }
    if (!chip) {
      chip = document.createElement('div');
      chip.id = chipId;
      chip.className = 'admin-log-reqid-chip';
      list.parentElement.insertBefore(chip, list);
    }
    chip.textContent = '';
    const label = document.createElement('span');
    label.textContent = `req ${String(reqId).slice(0, 8)}…`;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'admin-log-reqid-chip-x';
    x.textContent = '✕';
    x.title = 'Clear request filter';
    x.addEventListener('click', () => { onClear(); });
    chip.appendChild(document.createTextNode('Filtering: '));
    chip.appendChild(label);
    chip.appendChild(x);
  },

  _getFilteredEntries(): AdminFrontendLogEntry[] {
    const { level, scope, search, errorCode, reqId } = AdminCockpit._logFilter;
    return ErrorLog.entries().filter(e => {
      if (level !== 'all' && e.level !== level) return false;
      if (scope !== 'all' && e.scope !== scope) return false;
      if (errorCode && errorCode !== 'all' && e.errorCode !== errorCode) return false;
      if (reqId && e.reqId !== reqId) return false;
      if (search) {
        const haystack = `${e.scope} ${e.msg} ${e.ts} ${e.errorCode || ''} ${e.reqId || ''}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  },

  /* -----------------------------------------------------------------------
     DB DEEP DIVE — fetches /diagnostics/db on demand, renders sections
     ----------------------------------------------------------------------- */
  _renderDbDeep(): void {
    const wrap = document.getElementById('admin-db-deep');
    if (!wrap) return;
    wrap.innerHTML = `<div class="admin-db-loading">${Util.t('ui.diag_loading')}</div>`;

    AdminCockpit._dbDeepAbort?.abort();
    AdminCockpit._dbDeepAbort = new AbortController();
    const sig = AbortSignal.any
      ? AbortSignal.any([AdminCockpit._dbDeepAbort.signal, AbortSignal.timeout(12000)])
      : AdminCockpit._dbDeepAbort.signal;

    Util.fetchTraced(`${Config.API_BASE}/diagnostics/db`, { signal: sig })
      .then(r => r.json() as Promise<AdminDbDeepResponse>)
      .then(d => {
        wrap.textContent = '';

        // ── Top: summary tiles strip ──────────────────────────────────────────────
        AdminCockpit._dbSummaryStrip(d, wrap);

        if (d.fetched_at) {
          const tsEl = document.createElement('div');
          tsEl.className = 'admin-db-fetched';
          tsEl.textContent = Util.t('ui.diag_last_refreshed', { time: AdminCockpit._relTime(new Date(d.fetched_at)) });
          wrap.appendChild(tsEl);
        }

        const mkSection = (title: string, statusCls: string, buildFn: (body: HTMLDivElement) => void, openByDefault: boolean, helpText?: string): void => {
          const det = document.createElement('details');
          det.className = 'admin-db-section';
          if (openByDefault) det.open = true;
          const sum = document.createElement('summary');
          sum.className = 'admin-db-section-sum';
          const dot = document.createElement('span');
          dot.className = `admin-health-dot ${statusCls}`;
          const ttl = document.createElement('span');
          ttl.className = 'admin-db-section-title';
          ttl.textContent = title;
          sum.appendChild(dot);
          sum.appendChild(ttl);
          if (helpText) {
            const hEl = document.createElement('span');
            hEl.className = 'adm-help';
            hEl.tabIndex = 0;
            hEl.setAttribute('aria-label', Util.t('aria.help'));
            hEl.addEventListener('click', (e: Event) => e.stopPropagation());
            const hDot = document.createElement('span');
            hDot.className = 'adm-help-dot';
            hDot.textContent = '?';
            const hTip = document.createElement('span');
            hTip.className = 'adm-help-tip';
            hTip.textContent = helpText;
            hEl.appendChild(hDot);
            hEl.appendChild(hTip);
            sum.appendChild(hEl);
          }
          det.appendChild(sum);
          const body = document.createElement('div');
          body.className = 'admin-db-section-body';
          buildFn(body);
          det.appendChild(body);
          wrap.appendChild(det);
        };

        // ── 1. Connection Pool
        const pool = d.pool || ({} as AdminPoolStats);
        const poolUsed = (pool.pool_size ?? 0) - (pool.pool_available ?? 0);
        const poolMax  = pool.pool_max || 1;
        const poolSt   = pool.error ? 'err' : ((pool.requests_waiting ?? 0) > 0 || (pool.requests_errors ?? 0) > 0 ? 'warn' : 'ok');
        mkSection(Util.t('ui.diag_section_pool'), poolSt, (body) => {
          if (pool.error) { body.textContent = pool.error; return; }
          body.appendChild(AdminCockpit._dbFillBar(poolUsed, poolMax, Util.t('ui.diag_pool_utilization')));
          body.appendChild(AdminCockpit._kvTable([
            [Util.t('ui.diag_pool_min_max'),         `${pool.pool_min ?? '—'} / ${pool.pool_max ?? '—'}`],
            [Util.t('ui.diag_pool_in_use'),           `${poolUsed} / ${pool.pool_available ?? '—'}`],
            [Util.t('ui.diag_requests_waiting'),      pool.requests_waiting ?? 0],
            [Util.t('ui.diag_requests_completed'),    (pool.requests_completed ?? 0).toLocaleString()],
            [Util.t('ui.diag_request_errors'),        pool.requests_errors ?? 0],
            [Util.t('ui.diag_bad_returns'),           pool.returns_bad ?? 0],
          ]));
          if ((pool.requests_waiting ?? 0) > 0)
            AdminCockpit._dbWarnBanner(body, Util.t('ui.diag_pool_queued', { count: pool.requests_waiting ?? 0 }));
          if ((pool.requests_errors ?? 0) > 0)
            AdminCockpit._dbWarnBanner(body, Util.t('ui.diag_pool_errors', { count: pool.requests_errors ?? 0 }), true);
        }, true, Util.t('ui.diag_desc_pool'));

        // ── 2. Server Info
        const srv = d.server || ({} as AdminServerInfo);
        mkSection(Util.t('ui.diag_section_server'), srv.error ? 'err' : 'ok', (body) => {
          if (srv.error) { body.textContent = srv.error; return; }
          body.appendChild(AdminCockpit._kvTable([
            [Util.t('ui.diag_database'),        srv.database ?? '—'],
            [Util.t('ui.diag_database_size'),   srv.db_size   ?? '—'],
            [Util.t('ui.diag_max_connections'), srv.max_connections ?? '—'],
            [Util.t('ui.diag_up_since'),        srv.started_at ? AdminCockpit._relTime(new Date(srv.started_at)) : '—'],
            [Util.t('ui.diag_version'),         (srv.version || '').split(' (')[0]],
          ]));
        }, true, Util.t('ui.diag_desc_server'));

        // ── 3. Table Health
        const tablesRaw: AdminTableStat[] = Array.isArray(d.tables) ? d.tables : [];
        const tableErr = _adminListError(tablesRaw);
        const tables = _adminListRows(tablesRaw);
        const tablesNeedWork = !tableErr && tables.some((t) => t.needs_vacuum || t.needs_analyze);
        mkSection(Util.t('ui.diag_section_table_health', { count: tableErr ? '?' : tables.length }),
            tableErr ? 'err' : (tablesNeedWork ? 'warn' : 'ok'), (body) => {
          if (tableErr) { body.textContent = tableErr; return; }
          if (!tables.length) { body.textContent = Util.t('empty.no_user_tables'); return; }
          const strip = document.createElement('div');
          strip.className = 'db-maint-strip';
          const vacAllBtn = document.createElement('button');
          vacAllBtn.className = 'db-maint-global-btn';
          vacAllBtn.dataset.maintAction = 'vacuum-analyze';
          vacAllBtn.dataset.maintTable = '';
          vacAllBtn.textContent = Util.t('ui.maint_vacuum_all');
          strip.appendChild(vacAllBtn);
          body.appendChild(strip);
          body.appendChild(AdminCockpit._dbTableCards(tables));
        }, false, Util.t('ui.diag_desc_table_health'));

        // ── 4. Active Connections
        const conn = d.connections || ({} as AdminConnectionActivity);
        const hasLong = (conn.long_running || []).length > 0;
        mkSection(Util.t('ui.diag_section_connections', { count: conn.total ?? '?' }),
            conn.error ? 'err' : (hasLong ? 'warn' : 'ok'), (body) => {
          if (conn.error) { body.textContent = conn.error; return; }
          body.appendChild(AdminCockpit._dbStackBar(conn.by_state || {}));
          if (hasLong) {
            const sub = document.createElement('div');
            sub.className = 'admin-pdtl-sub';
            sub.textContent = Util.t('ui.non_idle_queries');
            body.appendChild(sub);
            body.appendChild(AdminCockpit._dbTable(
              ['PID', 'State', 'Dur (s)', 'Wait event', 'Query'],
              (conn.long_running || []).map((q): AdminDbTableRow => ({
                cells: [q.pid, q.state || '—', q.duration_s ?? '—', q.wait_event || '—', (q.query || '').slice(0, 120)],
                rowWarn: (q.duration_s || 0) > 30,
                cellWarn: [],
              }))
            ));
          }
        }, false, Util.t('ui.diag_desc_connections'));

        // ── 5. Lock Waits
        const locksRaw: AdminLockWait[] = Array.isArray(d.locks) ? d.locks : [];
        const lockErr = _adminListError(locksRaw);
        const locks = _adminListRows(locksRaw);
        const activeLocks = !lockErr && locks.length > 0;
        mkSection(Util.t('ui.diag_section_lock_waits', { count: lockErr ? '?' : locks.length }),
            lockErr ? 'err' : (activeLocks ? 'err' : 'ok'), (body) => {
          if (lockErr) { body.textContent = lockErr; return; }
          if (!activeLocks) {
            const ok = document.createElement('div');
            ok.className = 'admin-db-ok-msg';
            ok.textContent = Util.t('empty.no_lock_contention');
            body.appendChild(ok);
            return;
          }
          AdminCockpit._dbWarnBanner(body, Util.t('ui.diag_blocking_locks', { count: locks.length }), true);
          body.appendChild(AdminCockpit._dbLockChain(locks));
        }, false, Util.t('ui.diag_desc_lock_waits'));

        // ── 6. Index Usage
        const indexesRaw: AdminIndexUsage[] = Array.isArray(d.indexes) ? d.indexes : [];
        const idxErr = _adminListError(indexesRaw);
        const indexes = _adminListRows(indexesRaw);
        const unusedCount = !idxErr ? indexes.filter((ix) => ix.unused).length : 0;
        mkSection(unusedCount
            ? Util.t('ui.diag_section_index_unused', { count: idxErr ? '?' : indexes.length, unused: unusedCount })
            : Util.t('ui.diag_section_index_usage', { count: idxErr ? '?' : indexes.length }),
            idxErr ? 'err' : (unusedCount > 0 ? 'warn' : 'ok'), (body) => {
          if (idxErr) { body.textContent = idxErr; return; }
          if (!indexes.length) { body.textContent = Util.t('empty.no_indexes'); return; }
          if (unusedCount > 0)
            AdminCockpit._dbWarnBanner(body, Util.t('ui.diag_unused_indexes_warn', { count: unusedCount }));
          body.appendChild(AdminCockpit._dbHBarChart(indexes));
        }, false, Util.t('ui.diag_desc_index_usage'));

        // ── 7. Slow Queries
        const sq = d.slow_queries || ({} as AdminSlowQueriesResult);
        mkSection(Util.t('ui.diag_section_slow_queries'),
            !sq.available ? 'warn' : ((sq.queries || []).length ? 'warn' : 'ok'), (body) => {
          if (!sq.available) {
            const msg = document.createElement('div');
            msg.className = 'admin-db-na-msg';
            msg.textContent = sq.error
              ? `Error: ${sq.error}`
              : Util.t('ui.diag_pg_stat_missing');
            body.appendChild(msg);
            return;
          }
          if (!(sq.queries || []).length) {
            const ok = document.createElement('div');
            ok.className = 'admin-db-ok-msg';
            ok.textContent = Util.t('empty.no_queries_yet');
            body.appendChild(ok);
            return;
          }
          body.appendChild(AdminCockpit._dbSlowQueryBars(sq.queries));
        }, false, Util.t('ui.diag_desc_slow_queries'));

        // ── 8. Sequences
        const seqsRaw: AdminSequenceHealth[] = Array.isArray(d.sequences) ? d.sequences : [];
        const seqErr = _adminListError(seqsRaw);
        const seqs = _adminListRows(seqsRaw);
        const seqIssues = !seqErr ? seqs.filter((s) => s.status !== 'ok').length : 0;
        mkSection(Util.t('ui.diag_section_sequences', { count: seqErr ? '?' : seqs.length }),
            seqErr ? 'err' : (seqIssues > 0 ? 'warn' : 'ok'), (body) => {
          if (seqErr) { body.textContent = seqErr; return; }
          if (!seqs.length) { body.textContent = Util.t('empty.no_sequences'); return; }
          body.appendChild(AdminCockpit._dbProgressBars(seqs));
        }, false, Util.t('ui.diag_desc_sequences'));
      })
      .catch((e: Error) => {
        if (e.name === 'AbortError') return;
        wrap.textContent = '';
        const err = document.createElement('div');
        err.className = 'admin-db-error';
        err.textContent = Util.t('ui.failed_load_db_diag', { error: e.message });
        wrap.appendChild(err);
        ErrorLog.warn('admin', `DB deep dive failed: ${e.message}`);
      });
  },

  /* -----------------------------------------------------------------------
     DB visual helpers
     ----------------------------------------------------------------------- */

  _dbSummaryStrip(d: AdminDbDeepResponse, wrap: HTMLElement): void {
    const strip = document.createElement('div');
    strip.className = 'admin-db-summary';
    const mkTile = (label: string, num: string, sub: string, status: string, extra: HTMLElement | null): HTMLDivElement => {
      const tile = document.createElement('div');
      tile.className = `admin-db-stat-tile ${status}`;
      const top = document.createElement('div');
      top.className = 'admin-db-stat-tile-top';
      const dot = document.createElement('span');
      dot.className = `admin-health-dot ${status}`;
      const lbl = document.createElement('span');
      lbl.className = 'admin-db-stat-tile-lbl';
      lbl.textContent = label;
      top.appendChild(dot); top.appendChild(lbl);
      tile.appendChild(top);
      const numEl = document.createElement('div');
      numEl.className = 'admin-db-stat-tile-num';
      numEl.innerHTML = num;
      tile.appendChild(numEl);
      if (extra) tile.appendChild(extra);
      if (sub) {
        const subEl = document.createElement('div');
        subEl.className = 'admin-db-stat-tile-sub';
        subEl.textContent = sub;
        tile.appendChild(subEl);
      }
      return tile;
    };
    const pool = d.pool || ({} as AdminPoolStats);
    const poolUsed = (pool.pool_size ?? 0) - (pool.pool_available ?? 0);
    const poolMax  = pool.pool_max || 1;
    const poolPct  = Math.round(100 * poolUsed / poolMax);
    const poolSt   = pool.error ? 'err' : (poolPct >= 85 || (pool.requests_waiting ?? 0) > 0 ? 'warn' : 'ok');
    strip.appendChild(mkTile(Util.t('ui.diag_tile_pool'),
      `${poolUsed}<span style="font-size:14px;font-weight:400;color:var(--fg-mute)">/${poolMax}</span>`,
      Util.t('ui.diag_tile_pct_utilized', {pct: poolPct}), poolSt,
      pool.error ? null : AdminCockpit._dbFillBar(poolUsed, poolMax, null)));
    const conn = d.connections || ({} as AdminConnectionActivity);
    const activeConn = (conn.by_state || {})['active'] ?? 0;
    strip.appendChild(mkTile(Util.t('ui.diag_tile_sessions'), String(conn.total ?? '—'), Util.t('ui.diag_tile_active', {count: activeConn}),
      conn.error ? 'err' : ((conn.long_running || []).length > 0 ? 'warn' : 'ok'), null));
    const locks = _adminListRows<AdminLockWaitData>(Array.isArray(d.locks) ? d.locks : []);
    strip.appendChild(mkTile(Util.t('ui.diag_tile_lock_waits'),
      locks.length > 0 ? `<span style="color:var(--err)">${locks.length}</span>` : '0',
      locks.length > 0 ? Util.t('ui.diag_tile_contention') : Util.t('ui.diag_tile_clear'),
      locks.length > 0 ? 'err' : 'ok', null));
    const tables = _adminListRows<AdminTableStatData>(Array.isArray(d.tables) ? d.tables : []);
    const tblIssues = tables.filter((t) => t.needs_vacuum || t.needs_analyze).length;
    strip.appendChild(mkTile(Util.t('ui.diag_tile_table_issues'),
      tblIssues > 0 ? `<span style="color:var(--warn)">${tblIssues}</span>` : '0',
      tblIssues > 0 ? Util.t('ui.diag_tables_need_work', {total: tables.length, issues: tblIssues}) : Util.t('ui.diag_tables_healthy', {count: tables.length}),
      tblIssues > 0 ? 'warn' : 'ok', null));
    const sq = d.slow_queries || ({} as AdminSlowQueriesResult);
    let sqNum = '—', sqSub = Util.t('ui.diag_not_tracked'), sqSt = 'warn';
    if (sq.available && (sq.queries || []).length) {
      const top = sq.queries[0];
      sqNum = `${top.mean_ms}<span style="font-size:12px;font-weight:400;color:var(--fg-mute)">ms</span>`;
      sqSub = Util.t('ui.diag_avg_calls', {calls: top.calls.toLocaleString()});
      sqSt  = top.mean_ms > 500 ? 'err' : (top.mean_ms > 100 ? 'warn' : 'ok');
    } else if (sq.available) {
      sqNum = '0'; sqSub = Util.t('ui.diag_no_queries'); sqSt = 'ok';
    }
    strip.appendChild(mkTile(Util.t('ui.diag_tile_slowest_query'), sqNum, sqSub, sqSt, null));
    wrap.appendChild(strip);
  },

  _dbFillBar(used: number, max: number, label: string | null): HTMLDivElement {
    const pct = max > 0 ? Math.min(100, Math.round(100 * used / max)) : 0;
    const cls = pct >= 85 ? 'err' : (pct >= 60 ? 'warn' : 'ok');
    const wrap = document.createElement('div');
    wrap.className = 'admin-db-fillbar';
    const track = document.createElement('div');
    track.className = 'admin-db-fillbar-track';
    const fill = document.createElement('div');
    fill.className = `admin-db-fillbar-fill ${cls}`;
    fill.style.width = `${pct}%`;
    fill.title = `${pct}%`;
    track.appendChild(fill);
    wrap.appendChild(track);
    if (label) {
      const lbl = document.createElement('span');
      lbl.className = 'admin-db-fillbar-lbl';
      lbl.textContent = `${used} / ${max} (${pct}%)`;
      wrap.appendChild(lbl);
    }
    return wrap;
  },

  _dbStackBar(byState: Record<string, number>): HTMLDivElement {
    const STATE_CLS: Record<string, string> = { 'active': 'state-active', 'idle in transaction': 'state-xit',
      'idle in transaction (aborted)': 'state-xit', 'idle': 'state-idle' };
    const total = Math.max(Object.values(byState).reduce((a, b) => a + b, 0), 1);
    const wrap = document.createElement('div');
    wrap.className = 'admin-db-stackbar-wrap';
    const bar = document.createElement('div');
    bar.className = 'admin-db-stackbar';
    for (const [state, count] of Object.entries(byState)) {
      if (!count) continue;
      const pct = Math.max(1, Math.round(100 * count / total));
      const seg = document.createElement('div');
      seg.className = `admin-db-stackbar-seg ${STATE_CLS[state] || 'state-other'}`;
      seg.style.width = `${pct}%`;
      seg.title = `${state}: ${count}`;
      bar.appendChild(seg);
    }
    wrap.appendChild(bar);
    const legend = document.createElement('div');
    legend.className = 'admin-db-stackbar-legend';
    for (const [state, count] of Object.entries(byState)) {
      if (!count) continue;
      const chip = document.createElement('span');
      chip.className = `admin-db-stackbar-chip ${STATE_CLS[state] || 'state-other'}`;
      chip.textContent = `${state}: ${count}`;
      legend.appendChild(chip);
    }
    wrap.appendChild(legend);
    return wrap;
  },

  _dbTableCards(tables: AdminTableStatData[]): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'admin-db-tbl-cards';
    for (const tbl of tables) {
      const card = document.createElement('div');
      card.className = 'admin-db-tbl-card';
      const issues: string[] = [];
      if (tbl.needs_vacuum)  issues.push(Util.t('ui.diag_vacuum'));
      if (tbl.needs_analyze) issues.push(Util.t('ui.diag_analyze'));
      if (issues.length) card.classList.add('has-issues');
      const row1 = document.createElement('div');
      row1.className = 'admin-db-tbl-card-row1';
      const name = document.createElement('span');
      name.className = 'admin-db-tbl-card-name';
      name.textContent = tbl.table;
      const size = document.createElement('span');
      size.className = 'admin-db-tbl-card-size';
      size.textContent = tbl.total_size || '';
      const badge = document.createElement('span');
      badge.className = `admin-db-tbl-card-badge ${issues.length ? 'warn' : 'ok'}`;
      badge.textContent = issues.length ? issues.join(' + ') + ' ' + Util.t('ui.diag_needed') : Util.t('ui.diag_healthy');
      row1.appendChild(name); row1.appendChild(size); row1.appendChild(badge);
      card.appendChild(row1);
      const total = Math.max((tbl.live_rows ?? 0) + (tbl.dead_rows ?? 0), 1);
      const deadPct = Math.min(100, Math.round(100 * (tbl.dead_rows ?? 0) / total));
      const barWrap = document.createElement('div');
      barWrap.className = 'admin-db-tbl-card-barwrap';
      const barLive = document.createElement('div');
      barLive.className = 'admin-db-tbl-card-live';
      barLive.style.width = `${100 - deadPct}%`;
      barLive.title = `${Util.t('ui.diag_table_live')}: ${(tbl.live_rows ?? 0).toLocaleString()}`;
      const barDead = document.createElement('div');
      barDead.className = 'admin-db-tbl-card-dead';
      barDead.style.width = `${deadPct}%`;
      barDead.title = `${Util.t('ui.diag_table_dead')}: ${(tbl.dead_rows ?? 0).toLocaleString()} (${tbl.dead_pct}%)`;
      barWrap.appendChild(barLive); barWrap.appendChild(barDead);
      card.appendChild(barWrap);
      const row2 = document.createElement('div');
      row2.className = 'admin-db-tbl-card-row2';
      const vacAt = tbl.last_autovacuum || tbl.last_vacuum;
      row2.textContent = Util.t('ui.diag_table_row2', {
        live: (tbl.live_rows ?? 0).toLocaleString(),
        dead: (tbl.dead_rows ?? 0).toLocaleString(),
        deadPct: tbl.dead_pct,
        vacAt: vacAt ? AdminCockpit._relTime(new Date(vacAt)) : Util.t('ui.diag_vacuum_never'),
      });
      card.appendChild(row2);

      const actions = document.createElement('div');
      actions.className = 'db-maint-actions';
      const urgentVA = tbl.needs_vacuum || tbl.needs_analyze;
      const urgentA  = tbl.needs_analyze;
      const vaBtn = document.createElement('button');
      vaBtn.className = `db-maint-btn${urgentVA ? ' db-maint-btn--urgent' : ''}`;
      vaBtn.dataset.maintAction = 'vacuum-analyze';
      vaBtn.dataset.maintTable = tbl.table;
      vaBtn.textContent = 'VACUUM ANALYZE';
      const aBtn = document.createElement('button');
      aBtn.className = `db-maint-btn${urgentA ? ' db-maint-btn--urgent' : ''}`;
      aBtn.dataset.maintAction = 'analyze';
      aBtn.dataset.maintTable = tbl.table;
      aBtn.textContent = 'ANALYZE';
      actions.appendChild(vaBtn);
      actions.appendChild(aBtn);
      card.appendChild(actions);

      wrap.appendChild(card);
    }
    return wrap;
  },

  _dbHBarChart(indexes: AdminIndexUsageData[]): HTMLDivElement {
    const maxScans = Math.max(...indexes.map((ix) => ix.scans ?? 0), 1);
    const wrap = document.createElement('div');
    wrap.className = 'admin-db-hbar-chart';
    for (const ix of indexes) {
      const pct = Math.max(ix.unused ? 0 : 1, Math.round(100 * (ix.scans ?? 0) / maxScans));
      const row = document.createElement('div');
      row.className = 'admin-db-hbar-row';
      const names = document.createElement('div');
      names.className = 'admin-db-hbar-names';
      const tblN = document.createElement('span');
      tblN.className = 'admin-db-hbar-tbl';
      tblN.textContent = ix.table || '';
      const idxN = document.createElement('span');
      idxN.className = `admin-db-hbar-idx${ix.unused ? ' unused' : ''}`;
      idxN.textContent = ix.index || '';
      names.appendChild(tblN); names.appendChild(idxN);
      const track = document.createElement('div');
      track.className = 'admin-db-hbar-track';
      const fill = document.createElement('div');
      fill.className = `admin-db-hbar-fill${ix.unused ? ' unused' : ''}`;
      fill.style.width = `${pct}%`;
      track.appendChild(fill);
      const val = document.createElement('span');
      val.className = 'admin-db-hbar-val';
      val.textContent = (ix.scans ?? 0).toLocaleString();
      const sizeChip = document.createElement('span');
      sizeChip.className = 'admin-db-hbar-size';
      sizeChip.textContent = ix.index_size || '';
      row.appendChild(names); row.appendChild(track); row.appendChild(val); row.appendChild(sizeChip);
      wrap.appendChild(row);
    }
    return wrap;
  },

  _dbSlowQueryBars(queries: AdminSlowQuery[]): HTMLDivElement {
    const maxMs = Math.max(...queries.map((q) => q.mean_ms ?? 0), 1);
    const wrap = document.createElement('div');
    wrap.className = 'admin-db-hbar-chart';
    for (const q of queries) {
      const pct = Math.max(1, Math.round(100 * (q.mean_ms ?? 0) / maxMs));
      const cls = (q.mean_ms ?? 0) > 500 ? 'err' : ((q.mean_ms ?? 0) > 100 ? 'warn' : '');
      const row = document.createElement('div');
      row.className = 'admin-db-hbar-row';
      const names = document.createElement('div');
      names.className = 'admin-db-hbar-names';
      const qText = document.createElement('span');
      qText.className = 'admin-db-hbar-idx';
      qText.textContent = (q.query || '').slice(0, 90);
      qText.title = q.query || '';
      names.appendChild(qText);
      const track = document.createElement('div');
      track.className = 'admin-db-hbar-track';
      const fill = document.createElement('div');
      fill.className = `admin-db-hbar-fill${cls ? ' ' + cls : ''}`;
      fill.style.width = `${pct}%`;
      track.appendChild(fill);
      const val = document.createElement('span');
      val.className = 'admin-db-hbar-val';
      val.textContent = `${q.mean_ms}ms`;
      if (cls) val.style.color = `var(--${cls})`;
      const callChip = document.createElement('span');
      callChip.className = 'admin-db-hbar-size';
      callChip.textContent = `${q.calls.toLocaleString()} calls`;
      row.appendChild(names); row.appendChild(track); row.appendChild(val); row.appendChild(callChip);
      wrap.appendChild(row);
    }
    return wrap;
  },

  _dbProgressBars(seqs: AdminSequenceHealthData[]): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'admin-db-progress-list';
    for (const s of seqs) {
      const row = document.createElement('div');
      row.className = 'admin-db-progress-row';
      const name = document.createElement('span');
      name.className = 'admin-db-progress-name';
      name.textContent = `${s.schema}.${s.name}`;
      const track = document.createElement('div');
      track.className = 'admin-db-fillbar-track';
      const fill = document.createElement('div');
      fill.className = `admin-db-fillbar-fill ${s.status || 'ok'}`;
      fill.style.width = `${Math.max(0.5, s.used_pct ?? 0)}%`;
      fill.title = `${s.used_pct}%`;
      track.appendChild(fill);
      const lbl = document.createElement('span');
      lbl.className = 'admin-db-fillbar-lbl';
      lbl.textContent = `${s.used_pct}%${s.cycles ? ' ↻' : ''}  (${(s.last_value ?? 0).toLocaleString()} / ${(s.max_value ?? 0).toLocaleString()})`;
      row.appendChild(name); row.appendChild(track); row.appendChild(lbl);
      wrap.appendChild(row);
    }
    return wrap;
  },

  _dbLockChain(locks: AdminLockWaitData[]): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'admin-db-lock-chains';
    for (const lk of locks) {
      const chain = document.createElement('div');
      chain.className = 'admin-db-lock-chain';
      // pid is non-nullable on AdminLockWaitData — both real call sites below
      // pass lk.blocking_pid/lk.blocked_pid, never a null.
      const mkNode = (pid: number, role: string, query: string | null, cls: string): HTMLDivElement => {
        const node = document.createElement('div');
        node.className = `admin-db-lock-node ${cls}`;
        node.innerHTML = `<span class="admin-db-lock-pid">PID ${pid}</span>`
          + `<span class="admin-db-lock-role">${role}</span>`
          + `<div class="admin-db-lock-query">${(query || '—').slice(0, 90)}</div>`;
        return node;
      };
      chain.appendChild(mkNode(lk.blocking_pid, 'BLOCKING', lk.blocking_query, 'blocking'));
      const arrow = document.createElement('div');
      arrow.className = 'admin-db-lock-arrow';
      arrow.innerHTML = `<span class="admin-db-lock-type">${lk.lock_type || ''}</span> ▼`;
      chain.appendChild(arrow);
      chain.appendChild(mkNode(lk.blocked_pid, `BLOCKED ${lk.blocked_for_s}s`, lk.blocked_query, 'blocked'));
      wrap.appendChild(chain);
    }
    return wrap;
  },

  _dbWarnBanner(parent: HTMLElement, text: string, isError?: boolean): void {
    const d = document.createElement('div');
    d.className = `admin-db-banner ${isError ? 'admin-db-banner-err' : 'admin-db-banner-warn'}`;
    d.textContent = text;
    parent.appendChild(d);
  },

  _dbTable(headers: string[], rowDefs: AdminDbTableRow[]): HTMLTableElement {
    const tbl = document.createElement('table');
    tbl.className = 'admin-db-tbl';
    const thead = tbl.createTHead();
    const hrow = thead.insertRow();
    headers.forEach((h) => {
      const th = document.createElement('th');
      th.textContent = h;
      hrow.appendChild(th);
    });
    const tbody = tbl.createTBody();
    for (const { cells, rowWarn, rowErr, cellWarn } of rowDefs) {
      const tr = tbody.insertRow();
      if (rowErr)  tr.style.background = 'rgba(192,57,43,0.07)';
      else if (rowWarn) tr.style.background = 'rgba(243,156,18,0.06)';
      cells.forEach((c, i) => {
        const td = tr.insertCell();
        td.textContent = (c === null || c === undefined) ? '—' : String(c);
        if (cellWarn.includes(i)) td.style.color = 'var(--warn)';
      });
    }
    return tbl;
  },

  /* -----------------------------------------------------------------------
     BACKEND EVENT LOG — fetches /logs/backend, renders like the front-end log
     ----------------------------------------------------------------------- */
  _renderBackendLog(): void {
    const host = document.getElementById('admin-backend-log-list');
    const countEl = document.getElementById('admin-backend-log-count');
    if (!host) return;
    host.innerHTML = `<div class="admin-log-empty">${Util.t('ui.loading')}</div>`;

    AdminCockpit._backendLogAbort?.abort();
    AdminCockpit._backendLogAbort = new AbortController();
    const sig = AbortSignal.any
      ? AbortSignal.any([AdminCockpit._backendLogAbort.signal, AbortSignal.timeout(8000)])
      : AdminCockpit._backendLogAbort.signal;

    const bf = AdminCockpit._backendLogFilter || {};
    // Lazily inject a free-text query input beside the level select (markup is in
    // index.html which we don't own). Drives the server-side ?q= filter.
    const lvlSel = document.getElementById('admin-backend-log-filter-level');
    if (lvlSel && lvlSel.parentElement && !document.getElementById('admin-backend-log-q')) {
      const qIn = document.createElement('input');
      qIn.id = 'admin-backend-log-q';
      qIn.type = 'search';
      qIn.className = 'input';
      qIn.placeholder = 'Filter backend (msg / code / category)';
      qIn.title = 'Server-side free-text filter';
      qIn.addEventListener('input', Util.debounce((ev: Event) => {
        AdminCockpit._backendLogFilter.q = (ev.target as HTMLInputElement).value.trim();
        AdminCockpit._renderBackendLog();
      }, 350));
      lvlSel.insertAdjacentElement('afterend', qIn);
    }
    const lvl = bf.level || 'all';
    const qp = [`limit=200`];
    if (lvl !== 'all')                  qp.push('level='    + encodeURIComponent(lvl));
    if (bf.category && bf.category !== 'all') qp.push('category=' + encodeURIComponent(bf.category));
    if (bf.since)                       qp.push('since='    + encodeURIComponent(bf.since));
    if (bf.q)                           qp.push('q='        + encodeURIComponent(bf.q));
    const params = `?${qp.join('&')}`;
    const reqIdFilter = bf.reqId || '';

    // Reqid-correlation chip on the backend pane.
    AdminCockpit._renderReqIdChip('admin-backend-log-list', reqIdFilter, () => {
      AdminCockpit._backendLogFilter.reqId = '';
      AdminCockpit._renderBackendLog();
    });

    Util.fetchTraced(`${Config.API_BASE}/logs/backend${params}`, { signal: sig })
      .then((r) => r.json() as Promise<BackendLogResponse>)
      .then(({ entries: rawEntries, total, dropped }) => {
        host.textContent = '';
        // Client-side reqId correlation filter (server filters category/since/q/level).
        let entries = rawEntries || [];
        if (reqIdFilter) entries = entries.filter((e) => e.rid === reqIdFilter);
        if (countEl) countEl.textContent = Util.t('ui.backend_log_count', { total, shown: entries.length });

        // Overflow marker if the backend reports a dropped count.
        if (dropped && dropped > 0) {
          const ov = document.createElement('div');
          ov.className = 'admin-log-older';
          ov.textContent = `${dropped} older backend entr${dropped === 1 ? 'y' : 'ies'} dropped`;
          host.appendChild(ov);
        }

        if (!entries.length) {
          const empty = document.createElement('div');
          empty.className = 'admin-log-empty';
          empty.textContent = lvl !== 'all' ? Util.t('ui.diag_no_level_events', {level: lvl}) : Util.t('empty.no_backend_events');
          host.appendChild(empty);
          return;
        }

        for (const e of entries) {
          const row = document.createElement('div');
          row.className = `admin-log-row admin-log-${e.level || 'info'}`;

          const head = document.createElement('div');
          head.className = 'admin-log-head';

          const lvlEl = document.createElement('span');
          lvlEl.className = 'admin-log-lvl';
          lvlEl.textContent = (e.level || 'info').toUpperCase();

          const tsEl = document.createElement('span');
          tsEl.className = 'admin-log-ts';
          const d = e.ts ? new Date(e.ts) : null;
          tsEl.textContent = d ? AdminCockpit._relTime(d) : '';
          tsEl.title = e.ts || '';

          const scopeEl = document.createElement('span');
          scopeEl.className = 'admin-log-scope';
          scopeEl.textContent = e.category || '';

          head.appendChild(lvlEl);
          head.appendChild(tsEl);
          head.appendChild(scopeEl);
          if (e.source === 'frontend') {
            const src = document.createElement('span');
            src.className = 'admin-log-src';
            src.textContent = 'FE';
            src.title = 'Forwarded from a frontend client';
            head.appendChild(src);
          }
          const code = e.error_code;
          if (code) {
            const codeEl = document.createElement('span');
            codeEl.className = 'admin-log-code';
            codeEl.textContent = code;
            codeEl.title = 'Filter by this error code';
            codeEl.addEventListener('click', ev => {
              ev.stopPropagation();
              AdminCockpit._backendLogFilter.q = code;
              AdminCockpit._renderBackendLog();
            });
            head.appendChild(codeEl);
          }
          const rid = e.rid;
          if (rid) {
            const ridEl = document.createElement('span');
            ridEl.className = 'admin-log-reqid';
            ridEl.textContent = `req ${String(rid).slice(0, 8)}`;
            ridEl.title = `Correlate request ${rid} across the frontend log`;
            ridEl.addEventListener('click', ev => {
              ev.stopPropagation();
              AdminCockpit._correlateReqId(rid);
            });
            head.appendChild(ridEl);
          }
          row.appendChild(head);

          const msg = document.createElement('div');
          msg.className = 'admin-log-msg';
          msg.textContent = e.msg || '';
          row.appendChild(msg);

          if (e.ctx && Object.keys(e.ctx).length) {
            const pre = document.createElement('pre');
            pre.className = 'admin-log-ctx';
            pre.textContent = JSON.stringify(e.ctx, null, 2);
            row.appendChild(pre);
            row.style.cursor = 'pointer';
            row.addEventListener('click', () => row.classList.toggle('expanded'));
          }

          host.appendChild(row);
        }
      })
      .catch((e: Error) => {
        host.textContent = '';
        const err = document.createElement('div');
        err.className = 'admin-log-empty';
        err.textContent = Util.t('ui.failed_load_backend_log', { error: e.message });
        host.appendChild(err);
      });
  },

  _clearBackendLog(): void {
    Util.fetchTraced(`${Config.API_BASE}/logs/backend/clear`, { method: 'POST' })
      .then(() => AdminCockpit._renderBackendLog())
      .catch(() => {});
  },

  _copyFiltered(): void {
    const entries = AdminCockpit._getFilteredEntries();
    const txt = entries.map((e) =>
      `${e.ts} [${e.level.toUpperCase()}] ${e.scope}: ${e.msg}${e.ctx ? ' :: ' + JSON.stringify(e.ctx) : ''}`
    ).join('\n');
    navigator.clipboard?.writeText(txt).then(
      () => Toast.show(Util.t('toast.copied_filtered', { count: entries.length }), 'success'),
      () => Toast.show(Util.t('toast.copy_failed'), 'error')
    );
  },

  _renderLogs(): void {
    const list = document.getElementById('admin-log-list');
    if (!list) return;

    // Rebuild scope filter options
    const allEntries = ErrorLog.entries();
    const scopeEl = document.getElementById('admin-log-filter-scope') as HTMLSelectElement | null;
    if (scopeEl) {
      const currentScope = AdminCockpit._logFilter.scope;
      const scopes = [...new Set(allEntries.map(e => e.scope).filter(Boolean))].sort();
      scopeEl.textContent = '';
      const allOpt = document.createElement('option');
      allOpt.value = 'all';
      allOpt.textContent = Util.t('ui.all_scopes');
      scopeEl.appendChild(allOpt);
      for (const s of scopes) {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        if (s === currentScope) opt.selected = true;
        scopeEl.appendChild(opt);
      }
      // Lazily inject an errorCode filter select beside the scope select (the
      // markup lives in index.html which we don't own — build it on demand).
      let codeEl = document.getElementById('admin-log-filter-code') as HTMLSelectElement | null;
      if (!codeEl && scopeEl.parentElement) {
        codeEl = document.createElement('select');
        codeEl.id = 'admin-log-filter-code';
        codeEl.className = scopeEl.className || '';
        codeEl.title = 'Filter by error code';
        codeEl.addEventListener('change', (ev: Event) => {
          AdminCockpit._logFilter.errorCode = (ev.target as HTMLSelectElement).value;
          AdminCockpit._renderLogs();
        });
        scopeEl.insertAdjacentElement('afterend', codeEl);
      }
      if (codeEl) {
        const curCode = AdminCockpit._logFilter.errorCode;
        const codes = [...new Set(allEntries.map(e => e.errorCode).filter((c): c is string => Boolean(c)))].sort();
        codeEl.textContent = '';
        const cAll = document.createElement('option');
        cAll.value = 'all'; cAll.textContent = 'All codes';
        codeEl.appendChild(cAll);
        for (const c of codes) {
          const opt = document.createElement('option');
          opt.value = c; opt.textContent = c;
          if (c === curCode) opt.selected = true;
          codeEl.appendChild(opt);
        }
      }
    }

    // Active reqId-correlation chip (set by clicking a reqId in either pane).
    AdminCockpit._renderReqIdChip('admin-log-list', AdminCockpit._logFilter.reqId, () => {
      AdminCockpit._logFilter.reqId = '';
      AdminCockpit._renderLogs();
    });

    const filtered = AdminCockpit._getFilteredEntries();
    const visible = filtered.slice().reverse();

    list.textContent = '';

    // Overflow marker — N entries evicted past MAX since last clear.
    const dropped = ErrorLog.droppedCount();
    if (dropped > 0) {
      const ov = document.createElement('div');
      ov.className = 'admin-log-older';
      ov.textContent = `${dropped} older entr${dropped === 1 ? 'y' : 'ies'} dropped (ring at ${ErrorLog.MAX})`;
      list.appendChild(ov);
    }

    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'admin-log-empty';
      empty.textContent = filtered.length === 0 && allEntries.length > 0
        ? Util.t('empty.no_entries_filter')
        : Util.t('empty.no_log_entries');
      list.appendChild(empty);
    }

    const SCOPE_COLORS: Record<string, string> = {
      persistence: 'var(--info,#3498db)',
      engine:      '#9b59b6',
      admin:       'var(--accent,#b8791a)',
      alerts:      'var(--err,#c0392b)',
      store:       '#16a085',
      calendar:    '#2ecc71',
      interaction: '#e67e22',
    };

    for (const e of visible) {
      const row = document.createElement('div');
      row.className = `admin-log-row admin-log-${e.level}`;
      row.style.cursor = e.ctx != null ? 'pointer' : '';

      const head = document.createElement('div');
      head.className = 'admin-log-head';

      const lvl = document.createElement('span');
      lvl.className = 'admin-log-lvl';
      lvl.textContent = e.level;

      const ts = document.createElement('span');
      ts.className = 'admin-log-ts';
      const d = e.ts ? new Date(e.ts) : null;
      ts.textContent = d ? AdminCockpit._relTime(d) : '';
      ts.title = e.ts || '';

      const scope = document.createElement('span');
      scope.className = 'admin-log-scope';
      scope.textContent = e.scope || '';
      if (SCOPE_COLORS[e.scope]) scope.style.color = SCOPE_COLORS[e.scope];

      head.appendChild(lvl);
      head.appendChild(ts);
      head.appendChild(scope);
      const errorCode = e.errorCode;
      if (errorCode) {
        const code = document.createElement('span');
        code.className = 'admin-log-code';
        code.textContent = errorCode;
        code.title = 'Filter by this error code';
        code.addEventListener('click', ev => {
          ev.stopPropagation();
          AdminCockpit._logFilter.errorCode = errorCode;
          AdminCockpit._renderLogs();
        });
        head.appendChild(code);
      }
      const reqId = e.reqId;
      if (reqId) {
        const rid = document.createElement('span');
        rid.className = 'admin-log-reqid';
        rid.textContent = `req ${String(reqId).slice(0, 8)}`;
        rid.title = `Correlate request ${reqId} across the backend log`;
        rid.addEventListener('click', ev => {
          ev.stopPropagation();
          AdminCockpit._correlateReqId(reqId);
        });
        head.appendChild(rid);
      }
      row.appendChild(head);

      const msg = document.createElement('div');
      msg.className = 'admin-log-msg';
      msg.textContent = e.msg || '';
      row.appendChild(msg);

      if (e.ctx != null) {
        const pre = document.createElement('pre');
        pre.className = 'admin-log-ctx';
        pre.textContent = typeof e.ctx === 'string' ? e.ctx : JSON.stringify(e.ctx, null, 2);
        row.appendChild(pre);
        row.addEventListener('click', () => row.classList.toggle('expanded'));
      }

      list.appendChild(row);
    }

    const counts = document.getElementById('admin-log-counts');
    if (counts) {
      const errs  = ErrorLog.countBy('error');
      const warns = ErrorLog.countBy('warn');
      const show  = filtered.length !== allEntries.length ? Util.t('ui.log_shown', { count: filtered.length }) : '';
      counts.textContent = Util.t('ui.log_count_summary', {
        total: allEntries.length,
        errs, errp: errs === 1 ? '' : 's',
        warns, warnp: warns === 1 ? '' : 's',
        shown: show,
      });
    }
  },

  _relTime(d: Date | string | number): string {
    const diffMs = Date.now() - (d instanceof Date ? d : new Date(d)).getTime();
    const s = Math.round(diffMs / 1000);
    if (s < 60)    return Util.t('ui.time_s_ago', { n: s });
    if (s < 3600)  return Util.t('ui.time_m_ago', { n: Math.floor(s / 60) });
    if (s < 86400) return Util.t('ui.time_h_ago', { n: Math.floor(s / 3600) });
    return Util.t('ui.time_d_ago', { n: Math.floor(s / 86400) });
  },

  async _clearAudit(): Promise<void> {
    const ok = await Modal.confirm({ title: Util.t('modal.delete_upload_history'), confirmLabel: Util.t('btn.yes_delete_all') });
    if (!ok) return;
    fetch(`${Config.API_BASE}/upload/audit/clear`, { method: 'POST' })
      .then(r => r.json())
      .then((body: { status: string; deleted: number }) => {
        if (body.status !== 'ok') { Toast.show(Util.t('toast.clear_history_failed'), 'error'); return; }
        Toast.show(Util.t('toast.history_cleared', { count: body.deleted }), 'success');
        AdminCockpit._renderAudit();
      })
      .catch((e: Error) => Toast.show(Util.t('toast.clear_history_failed') + ': ' + e.message, 'error'));
  },

  _renderAudit(): void {
    const host = document.getElementById('admin-audit-list');
    if (!host) return;
    host.textContent = Util.t('ui.loading');
    AdminCockpit._auditAbort?.abort();
    AdminCockpit._auditAbort = new AbortController();
    const sig = AbortSignal.any
      ? AbortSignal.any([AdminCockpit._auditAbort.signal, AbortSignal.timeout(8000)])
      : AdminCockpit._auditAbort.signal;
    Util.fetchTraced(`${Config.API_BASE}/upload/audit`, { signal: sig })
      .then(r => r.json() as Promise<AdminUploadAuditResponse>)
      .then(body => {
        host.textContent = '';
        const items = body?.audit || [];
        if (items.length === 0) {
          const e = document.createElement('div');
          e.className = 'admin-log-empty';
          e.textContent = Util.t('empty.no_uploads');
          host.appendChild(e);
          return;
        }
        const tbl = document.createElement('table');
        tbl.className = 'admin-audit-tbl';
        const thead = document.createElement('thead');
        const htr = document.createElement('tr');
        for (const h of [Util.t('ui.audit_col_when'), Util.t('ui.audit_col_file'), Util.t('ui.audit_col_rows'), Util.t('ui.audit_col_inserted'), Util.t('ui.audit_col_updated'), Util.t('ui.audit_col_batch'), Util.t('ui.audit_col_warnings')]) {
          const th = document.createElement('th');
          th.textContent = h;
          htr.appendChild(th);
        }
        thead.appendChild(htr);
        tbl.appendChild(thead);

        const tb = document.createElement('tbody');
        for (const it of items) {
          const hasWarnings = it.warnings && it.warnings.length > 0;

          const tr = document.createElement('tr');
          if (hasWarnings) tr.classList.add('admin-audit-has-warn');
          tr.style.cursor = hasWarnings ? 'pointer' : '';

          const batchShort = it.batch_id ? it.batch_id.slice(0, 8) + '…' : '—';
          const cells = [
            (it.uploaded_at || '').replace('T', ' ').slice(0, 19),
            it.filename || '—',
            String(it.row_count ?? '—'),
            String(it.inserted ?? '—'),
            String(it.updated ?? '—'),
            batchShort,
            hasWarnings ? `⚠ ${it.warnings.length}` : '✓',
          ];
          cells.forEach((c, i) => {
            const td = document.createElement('td');
            td.textContent = c;
            if (i === 6 && hasWarnings) td.style.color = 'var(--warn,#b57a0a)';
            if (i === 5 && it.batch_id) td.title = it.batch_id;
            tr.appendChild(td);
          });

          if (hasWarnings) {
            const warnRow = document.createElement('tr');
            warnRow.className = 'admin-audit-warn-detail';
            warnRow.style.display = 'none';
            const td = document.createElement('td');
            td.colSpan = 7;
            td.style.padding = '0';
            td.appendChild(AdminCockpit._warningList(it.warnings));
            warnRow.appendChild(td);
            tb.appendChild(tr);
            tb.appendChild(warnRow);
            tr.addEventListener('click', () => {
              warnRow.style.display = warnRow.style.display === 'none' ? '' : 'none';
            });
          } else {
            tb.appendChild(tr);
          }
        }
        tbl.appendChild(tb);
        host.appendChild(tbl);
      })
      .catch((e: Error) => {
        if (e?.name === 'AbortError') return;
        host.textContent = '';
        const err = document.createElement('div');
        err.className = 'admin-status error';
        err.textContent = Util.t('ui.failed_load_upload_history', { error: e.message });
        host.appendChild(err);
      });
  },

  async _clearAuditLog(): Promise<void> {
    const ok = await Modal.confirm({ title: Util.t('modal.clear_audit_log'), confirmLabel: Util.t('btn.yes_delete') });
    if (!ok) return;
    fetch(`${Config.API_BASE}/audit/log/clear`, { method: 'POST' })
      .then(r => r.json())
      .then((body: { status: string }) => {
        if (body.status !== 'ok') { Toast.show(Util.t('toast.clear_failed'), 'error'); return; }
        Toast.show(Util.t('toast.audit_log_cleared'), 'success');
        AdminCockpit._renderAuditLog();
      })
      .catch((e: Error) => Toast.show(Util.t('toast.clear_failed') + ': ' + e.message, 'error'));
  },

  _renderAuditLog(): void {
    const host = document.getElementById('admin-audit-log-list');
    if (!host) return;
    host.textContent = Util.t('ui.loading');
    AdminCockpit._auditLogAbort?.abort();
    AdminCockpit._auditLogAbort = new AbortController();
    const sig = AbortSignal.any
      ? AbortSignal.any([AdminCockpit._auditLogAbort.signal, AbortSignal.timeout(8000)])
      : AdminCockpit._auditLogAbort.signal;
    Util.fetchTraced(`${Config.API_BASE}/audit/log?limit=200`, { signal: sig })
      .then(r => r.json() as Promise<AdminAuditLogResponse>)
      .then(body => {
        host.textContent = '';
        const items = body?.entries || [];
        if (!items.length) {
          const e = document.createElement('div');
          e.className = 'admin-log-empty';
          e.textContent = Util.t('empty.no_audit_events');
          host.appendChild(e);
          return;
        }
        const tbl = document.createElement('table');
        tbl.className = 'admin-audit-tbl';
        const thead = document.createElement('thead');
        const htr   = document.createElement('tr');
        for (const h of [Util.t('ui.audit_log_col_when'), Util.t('ui.audit_log_col_user'), Util.t('ui.audit_log_col_action'), Util.t('ui.audit_log_col_plant'), Util.t('ui.audit_log_col_details')]) {
          const th = document.createElement('th');
          th.textContent = h;
          htr.appendChild(th);
        }
        thead.appendChild(htr);
        tbl.appendChild(thead);

        const ACTION_ICONS: Record<string, string> = {
          color_wheel_upload:  '⬆',
          color_wheel_replace: '↻',
          color_wheel_delete:  '⌫',
          optimization_run:    '📈',
        };
        const ACTION_COLORS: Record<string, string> = {
          color_wheel_upload:  'var(--ok,#2f7a4d)',
          color_wheel_replace: 'var(--info,#2d5f8c)',
          color_wheel_delete:  'var(--err,#c0392b)',
          optimization_run:    'var(--accent,#b8791a)',
        };

        const tb = document.createElement('tbody');
        for (const it of items) {
          const tr = document.createElement('tr');
          const action = it.action || '—';
          const icon   = ACTION_ICONS[action] || '•';
          const color  = ACTION_COLORS[action] || 'inherit';
          const details = it.details
            ? Object.entries(it.details).map(([k, v]) => `${k}: ${v}`).join(' · ')
            : '—';
          const cells = [
            (it.ts || '').replace('T', ' ').slice(0, 19),
            it.user || '—',
            '',
            it.plant || '—',
            details,
          ];
          cells.forEach((c, i) => {
            const td = document.createElement('td');
            if (i === 2) {
              // `action` is server-stored and not whitelisted, so render it as inert
              // text — never innerHTML — to avoid a stored-XSS sink (R1). icon is from
              // the fixed ACTION_ICONS map; color is a CSS var, set via style only.
              const span = document.createElement('span');
              span.style.color = color;
              span.style.fontWeight = '600';
              span.textContent = `${icon} ${action}`;
              td.appendChild(span);
            } else {
              td.textContent = c;
            }
            if (i === 3 && it.plant) td.style.fontWeight = '600';
            tr.appendChild(td);
          });
          tb.appendChild(tr);
        }
        tbl.appendChild(tb);
        host.appendChild(tbl);
      })
      .catch((e: Error) => {
        if (e?.name === 'AbortError') return;
        host.textContent = '';
        const err = document.createElement('div');
        err.className = 'admin-status error';
        err.textContent = Util.t('ui.failed_load_audit_log', { error: e.message });
        host.appendChild(err);
      });
  },

  /* ---------------------------------------------------------------------
     THREAD PROFILER PANEL — PerfMonitor ring-buffer stats table.
     Rendered into #admin-ov-thread on tab activation and on each
     PerfMonitor notification (debounced 250 ms by PerfMonitor itself).
     --------------------------------------------------------------------- */
  _refreshThreadPane(): void {
    const tbody = document.getElementById('admin-perf-tbody');
    if (!tbody) return;
    const rows = PerfMonitor.all();
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="admin-perf-empty">No data yet — interact with the app to record operations.</td></tr>`;
      return;
    }
    rows.sort((a, b) => b.last - a.last);
    const fmt = (ms: number): string => ms < 1 ? `${ms.toFixed(2)}` : ms < 100 ? `${ms.toFixed(1)}` : `${Math.round(ms)}`;
    const cls = (ms: number): string => ms >= 50 ? 'perf-hot' : ms >= 16 ? 'perf-warn' : 'perf-ok';
    const ago = (ts: number): string => {
      if (!ts) return '—';
      const s = Math.round((Date.now() - ts) / 1000);
      if (s < 2)  return 'just now';
      if (s < 60) return `${s}s ago`;
      return `${Math.round(s / 60)}m ago`;
    };
    tbody.innerHTML = rows.map(r => {
      const c = cls(r.last);
      return `<tr>
        <td class="perf-name">${r.name}</td>
        <td class="${c}">${fmt(r.last)} ms</td>
        <td class="${cls(r.p50)}">${fmt(r.p50)} ms</td>
        <td class="${cls(r.p95)}">${fmt(r.p95)} ms</td>
        <td class="${cls(r.max)}">${fmt(r.max)} ms</td>
        <td>${r.count}</td>
        <td class="perf-ago">${ago(r.lastTs)}</td>
      </tr>`;
    }).join('');
  },

  /* ---------------------------------------------------------------------
     DIAGNOSTICS PANEL — client-side health summary, "Reset client state",
     diagnostics bundle export. Renders into #admin-diagnostics-pane.
     --------------------------------------------------------------------- */
  _renderDiagnostics(): void {
    const host = document.getElementById('admin-diagnostics-pane');
    if (!host) return;

    const inv  = Persistence.storageInventory();
    const totK = (inv.totalBytes / 1024).toFixed(1);
    const lastK = (inv.lastBytes / 1024).toFixed(1);
    const lastWhen = inv.lastSavedAt ? new Date(inv.lastSavedAt).toLocaleTimeString() : '—';
    const errCount  = ErrorLog.countBy('error');
    const warnCount = ErrorLog.countBy('warn');
    const errRate   = ErrorLog.errorRatePerMin();
    const warnRate  = ErrorLog.warnRatePerMin();
    const mem = (performance as Performance & { memory?: ChromePerformanceMemory }).memory;
    const heap = mem
      ? `${(mem.usedJSHeapSize / 1048576).toFixed(0)} / ${(mem.jsHeapSizeLimit / 1048576).toFixed(0)} MB`
      : 'n/a';
    const stats: AdminPersistenceStats | Record<string, never> = (Persistence.stats && Persistence.stats()) || {};

    const autosaveTxt = inv.autosaveDisabled
      ? `<span class="admin-bad">${Util.t('ui.ls_quota_disabled')}</span>`
      : inv.degraded
        ? `<span class="admin-warn">${Util.t('ui.ls_degraded')}</span>`
        : `<span class="admin-good">${Util.t('ui.ls_healthy')}</span>`;
    const errTxt = errRate > 10
      ? `<span class="admin-bad">${Util.t('ui.diag_err_rate_spike', { count: errCount, rate: errRate })}</span>`
      : errRate > 0
        ? `<span class="admin-warn">${Util.t('ui.diag_err_rate_warn', { count: errCount, rate: errRate })}</span>`
        : `${errCount}`;

    host.innerHTML = `
      <div class="admin-card">
        <div class="admin-card-hd">
          <h3>${Util.t('ui.diag_client_title')}<span class="adm-help" tabindex="0" aria-label="Help"><span class="adm-help-dot">?</span><span class="adm-help-tip">${Util.t('ui.diag_client_help')}</span></span></h3>
          <div class="admin-card-actions">
            <button class="btn btn-ghost sm" id="admin-diag-refresh" title="${Util.t('tip.refresh')}">${Util.t('btn.refresh')}</button>
            <button class="btn btn-ghost sm" id="admin-diag-storage" title="${Util.t('tip.inspect_storage')}">${Util.t('btn.inspect_storage')}</button>
            <button class="btn btn-ghost sm" id="admin-diag-export" title="${Util.t('tip.diag_export_bundle')}">${Util.t('btn.export_bundle')}</button>
            <button class="btn btn-warn  sm" id="admin-diag-reset"   title="${Util.t('tip.diag_clear_cache')}">${Util.t('btn.reset_client')}</button>
          </div>
        </div>
        <div class="admin-kv">
          <span>${Util.t('ui.diag_kv_build')}</span><span>${Config.BUILD_ID}</span>
          <span>${Util.t('ui.diag_kv_schema')}</span><span>${Config.SCHEMA_VERSION}</span>
          <span>${Util.t('ui.diag_kv_cache')}</span><span>${Util.t('ui.diag_cache_val', { size: lastK, when: lastWhen })}</span>
          <span>${Util.t('ui.diag_kv_storage')}</span><span>${Util.t('ui.diag_storage_val', { size: totK, count: inv.count })}</span>
          <span>${Util.t('ui.diag_kv_autosave')}</span><span>${autosaveTxt}</span>
          <span>${Util.t('ui.diag_kv_heap')}</span><span>${heap}</span>
          <span>${Util.t('ui.diag_kv_errors')}</span><span>${errTxt}</span>
          <span>${Util.t('ui.diag_kv_warnings')}</span><span>${warnCount} (${warnRate}/min)</span>
          <span>${Util.t('ui.diag_kv_tasks')}</span><span>${Store.tasksArr.length}</span>
          <span>${Util.t('ui.diag_kv_source')}</span><span>${stats.source || '—'}</span>
          <span>${Util.t('ui.diag_kv_plant')}</span><span>${Store.selectedPlant || '<em>none</em>'}</span>
        </div>
      </div>`;

    document.getElementById('admin-diag-refresh')!.addEventListener('click', () => AdminCockpit._renderDiagnostics());
    document.getElementById('admin-diag-storage')!.addEventListener('click', () => AdminCockpit._showStorageInventory(inv));
    document.getElementById('admin-diag-export' )!.addEventListener('click', () => AdminCockpit._exportDiagnostics());
    document.getElementById('admin-diag-reset'  )!.addEventListener('click', () => AdminCockpit._resetClientState());
  },

  async _resetClientState(): Promise<void> {
    const ok = await Modal.confirm({
      title:        Util.t('modal.reset_client_title'),
      message:      Util.t('modal.reset_client_msg'),
      detail:       Util.t('modal.reset_client_detail'),
      confirmLabel: Util.t('modal.reset_client_confirm'),
      tone:         'warn',
    });
    if (!ok) return;
    try { localStorage.removeItem(Config.LS_KEY); } catch {}
    try { sessionStorage.clear(); } catch {}
    try {
      const prefix = `${Config.LS_KEY}.quarantine.`;
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) toRemove.push(k);
      }
      toRemove.forEach(k => { try { localStorage.removeItem(k); } catch {} });
    } catch {}
    ErrorLog.info('admin', 'Client state reset by user — reloading');
    // Give the log a frame to render in case of debounce, then hard-reload bypassing HTTP cache.
    setTimeout(() => location.reload(), 50);
  },

  _showStorageInventory(inv?: AdminStorageInventory): void {
    if (!inv) inv = Persistence.storageInventory();
    const top = inv.items.slice(0, 12)
      .map((i) => `${(i.bytes / 1024).toFixed(1).padStart(7)} KB  ${i.key}`)
      .join('\n') || Util.t('ui.ls_empty');
    const lsStatus = inv.degraded ? Util.t('ui.ls_evicted_tier') : inv.autosaveDisabled ? Util.t('ui.ls_autosave_disabled') : Util.t('ui.ls_healthy');
    const detail =
      `<pre style="margin:0;font:11px ui-monospace,monospace;white-space:pre;">` +
      Util.t('modal.ls_inv_total', { size: (inv.totalBytes / 1024).toFixed(1), count: inv.count }) + '\n' +
      Util.t('modal.ls_inv_snapshot', { size: (inv.lastBytes / 1024).toFixed(1), status: lsStatus }) + '\n\n' +
      Util.t('modal.ls_inventory_top_keys') + `\n${top}` +
      `</pre>`;
    Modal.confirm({
      title:        Util.t('modal.ls_inventory_title'),
      message:      Util.t('modal.ls_inventory_msg'),
      detail,
      confirmLabel: Util.t('btn.close'),
      tone:         'warn',
    });
  },

  _exportDiagnostics(): void {
    const mem = (performance as Performance & { memory?: ChromePerformanceMemory }).memory;
    const bundle = {
      generatedAt: new Date().toISOString(),
      build:       Config.BUILD_ID,
      schema:      Config.SCHEMA_VERSION,
      userAgent:   navigator.userAgent,
      location:    location.href,
      storage:     Persistence.storageInventory(),
      heap: mem ? {
        usedMB:  +(mem.usedJSHeapSize / 1048576).toFixed(1),
        limitMB: +(mem.jsHeapSizeLimit / 1048576).toFixed(1),
      } : null,
      persistence: (Persistence.stats && Persistence.stats()) || null,
      health:      AdminCockpit._healthData || null,
      deep:        AdminCockpit._deepData   || null,
      storeCounts: {
        tasks:        Store.tasksArr.length,
        blocks:       (Store.blocks || []).length,
        plantBlocks:  (Store.plantBlocks || []).length,
        lines:        Object.keys(Store.lineSettings || {}).length,
        plants:       Object.keys(Store.plants || {}).length,
        fixed:        Store.fixedIds ? Store.fixedIds.size : 0,
        alerts:       (Store.alerts || []).length,
      },
      selectedPlant: Store.selectedPlant,
      errorRates: {
        errorPerMin: ErrorLog.errorRatePerMin(),
        warnPerMin:  ErrorLog.warnRatePerMin(),
        totalErrors: ErrorLog.countBy('error'),
        totalWarns:  ErrorLog.countBy('warn'),
      },
      errors: ErrorLog.entries().slice(-500),
      droppedErrors: ErrorLog.droppedCount(),
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nimbus-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    Toast.show(Util.t('toast.diag_bundle_downloaded'), 'success');
  }
};

// SAP transport kinds — must mirror sap_sync._CONNECTORS' keys in the backend contract.
type SapTransport = 'file_drop' | 'odata' | 'rfc';

// SAP value-transform names — must mirror sap_sync.TRANSFORMS' keys.
type SapTransformName = 'none' | 'alpha' | 'strip_zeros' | 'dats' | 'tims' | 'decimal' | 'uom' | 'bool_x';

/** One `sap_sync_run` row — shared shape returned both embedded as
 *  `SapObject.last_run` (`GET /sap/interface/objects`, latest run only) and
 *  in bulk by `GET /sap/interface/runs` (`sap_sync.list_runs`). Not part of
 *  the backend's `response_model=` scope (only the task-date-update endpoint
 *  family is — see Phase 4's landed note), so hand-written locally. */
interface SapRun {
  id: number;
  object_key: string;
  started_at: string | null;
  ended_at: string | null;
  status: string;
  rows_read: number;
  rows_inserted: number;
  rows_updated: number;
  rows_failed: number;
  error: string | null;
  watermark_before: string | null;
  watermark_after: string | null;
  triggered_by: string | null;
}

/** One entry of `GET /sap/interface/objects` (`sap_sync.SAP_OBJECTS` catalog
 *  + live config/last-run/next-run overlay — `brain.py`'s `sap_objects`). */
interface SapObject {
  object_key: string;
  label?: string;
  kind?: 'master' | 'orders';
  enabled: boolean;
  transport?: SapTransport;
  schedule_cron?: string | null;
  last_run: SapRun | null;
  next_run: string | null;
}

interface SapObjectsResponse {
  objects: SapObject[];
}

/** `GET /sap/interface/config/{object}` / `POST` response (`sap_get_config`/
 *  `sap_set_config`) — secret `source_params` keys are stripped server-side,
 *  replaced by the `has_secret` flag. `object_key`/`enabled` are optional here
 *  because `_renderOverview`'s catch-fallback constructs a partial literal
 *  missing them (network/parse failure path, not a real endpoint response).
 *  `last_watermark` is READ by `_renderOverview` but neither `sap_get_config`
 *  nor the fallback literal ever supplies it — a pre-existing latent gap in
 *  the frontend (the field never actually appears at runtime); kept optional
 *  so the existing read type-checks without changing behavior. */
interface SapObjectConfig {
  object_key?: string;
  enabled?: boolean;
  transport: SapTransport;
  schedule_cron: string | null;
  source_params: Record<string, string>;
  has_secret: boolean;
  last_watermark?: string | null;
}

/** Payload accepted by `POST /sap/interface/config/{object}` — every field optional
 *  (only supplied fields are merged server-side; `source_params` itself is a
 *  merge, not a replace — see `sap_set_config`). */
interface SapConfigPatch {
  enabled?: boolean;
  transport?: SapTransport;
  schedule_cron?: string | null;
  source_params?: Record<string, string>;
}

/** One row of the Mapping tab's client-side editor buffer (`_mapState[key].rows`) —
 *  mirrors `GET /sap/interface/mappings/{object}`'s `mappings[]` shape minus
 *  `field_order` (assigned from array position only when saving). */
interface SapMapRow {
  sap_field: string;
  nimbus_column: string;
  transform: SapTransformName | string;
  active: boolean;
}

interface SapMapState {
  rows: SapMapRow[];
  dirty: boolean;
}

interface SapMappingsResponse {
  object_key: string;
  mappings: SapMapRow[];
}

/** `POST /sap/interface/mappings/{object}` response (`sap_sync.replace_field_map`). */
interface SapMappingsSaveResult {
  status: string;
  object_key: string;
  count: number;
}

interface SapRunsResponse {
  runs: SapRun[];
}

/** `POST /sap/interface/test-connection` response (`sap_sync.test_connection`
 *  / `SapConnector.test_connection` — always a stub `{ok:false,...}` today). */
interface SapTestConnectionResult {
  ok: boolean;
  detail?: string;
}

/** `_testResult` UI state — a locally-synthesized status strip, not a raw
 *  backend shape (built in `_testConnection` from `SapTestConnectionResult`). */
interface SapTestResultUI {
  cls: string;
  dot: string;
  msg: string;
}

/** `POST /sap/interface/sync/{object}` response (`sap_sync.sync_object`). */
interface SapSyncResult {
  object_key: string;
  status: 'ok' | 'error';
  rows_read: number;
  rows_inserted: number;
  rows_updated: number;
  rows_failed: number;
  error: string | null;
  run_id: number | null;
}

/* =============================================================================
   INTERFACE — SAP integration console (Admin → Interface sub-tab)
   A master-detail console rendered into #sap-interface-host, driven by the
   /sap/interface/* endpoints:
     • status ribbon  — aggregate health (connection, enabled, last activity, errors)
     • object rail    — the 6 sync objects (status dot, kind, enable toggle); selects detail
     • detail pane    — Overview (transport/secret/schedule/checklist + Test connection),
                        Mapping (SAP→transform→NIMBUS flow + key-column guardrail),
                        History (run timeline with counts/duration/watermark/error drill-down)
   Dirty-tracking/save is local to this module; it does not touch MasterData.
   Reads use Util.fetchTraced; writes use fetch with x-user-email. Reuses NIMBUS
   component classes (.kpi-tile, .panel, .admin-health-dot, .cal-toggle-*) + a .sap-* block.
   ========================================================================== */
export const Interface = (() => {
  const API = Config.API_BASE;
  // Transform names — must mirror sap_sync.TRANSFORMS in the backend contract.
  const TRANSFORMS = ['none', 'alpha', 'strip_zeros', 'dats', 'tims', 'decimal', 'uom', 'bool_x'];
  const TRANSPORTS = ['file_drop', 'odata', 'rfc'];

  let _objects: SapObject[] = [];         // last GET /objects payload — drives ribbon + rail
  let _selected: string | null = null;    // selected object_key (master selection)
  let _tab: 'overview' | 'mapping' | 'history' = 'overview'; // active detail tab
  let _testResult: SapTestResultUI | null = null; // last {cls,dot,msg} from a Test-connection click
  let _lastNewestKey: string | null = null; // object_key of the most-recent run (ribbon deep-link)
  const _config: Record<string, SapObjectConfig> = {}; // object_key -> GET /config payload (transport/params/has_secret)
  // Per-object mapping editor state: { rows:[{sap_field,nimbus_column,transform,active}], dirty:bool }
  const _mapState: Record<string, SapMapState> = {};

  // Master upsert keys — MUST mirror sap_sync._MASTER_KEY_COLUMNS. A master object whose
  // active mapping omits any of these hits a NOT-NULL on upsert, so the editor blocks Save.
  const MASTER_KEYS: Record<string, string[]> = {
    subnetworks:      ['code'],
    plants:           ['subnetwork', 'plant'],
    production_lines: ['subnetwork', 'plant', 'production_line'],
    materials:        ['material_id'],
    material_plants:  ['material_id', 'plant'],
  };
  // One-line transform descriptions (keys mirror sap_sync.TRANSFORMS).
  const XHINT: Record<string, string> = {
    none: 'pass through unchanged',    alpha: 'ALPHA-pad — e.g. MATNR',
    strip_zeros: 'drop leading zeros', dats: 'SAP YYYYMMDD → ISO date',
    tims: 'SAP HHMMSS → time',         decimal: 'packed decimal, trailing sign',
    uom: 'unit of measure → ISO',      bool_x: "SAP 'X' flag → boolean",
  };
  // Transport-specific connection fields (label + example only — scaffolds the params editor).
  const TRANSPORT_FIELDS: Record<SapTransport, [string, string, string][]> = {
    file_drop: [['path', 'Share / Blob path', '/data/sap_drop'], ['glob', 'File glob', 'plants_*.xlsx']],
    odata:     [['base_url', 'Service base URL', 'https://sap-gw/odata/ZNIMBUS_SRV'], ['entity_set', 'Entity set', 'PlantSet'], ['filter', '$filter (delta)', 'LAEDA gt {watermark}'], ['page_size', 'Page size', '1000']],
    rfc:       [['dest', 'RFC destination', 'SAP_PRD'], ['function', 'Function module', 'Z_NIMBUS_GET_PLANTS'], ['batch', 'Batch size', '2000']],
  };

  const _esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c: string) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

  function _writeHeaders(json = true): Record<string, string> {
    const h: Record<string, string> = { 'x-user-email': Session.actor() };
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  // -----------------------------------------------------------------------
  // Public entry point
  // -----------------------------------------------------------------------
  async function render(): Promise<void> {
    const host = document.getElementById('sap-interface-host');
    if (!host) return;
    await _reload();
  }

  // Fetch /objects, then paint the console. Used on first load + after every write.
  async function _reload(): Promise<void> {
    const host = document.getElementById('sap-interface-host');
    if (!host) return;
    try {
      const data: SapObjectsResponse = await Util.fetchTraced(`${API}/sap/interface/objects`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
      _objects = data.objects || [];
      if (!_selected || !_objects.some((o) => o.object_key === _selected)) {
        _selected = _objects.length ? _objects[0].object_key : null;
      }
      _paint();
    } catch (e) {
      host.innerHTML = `<div class="sap-empty"><div class="sap-empty-ico">⚠</div>`
        + `<div class="sap-empty-t">${_esc(Util.t('ui.sap_load_failed'))}</div>`
        + `<div class="sap-empty-d">${_esc((e as Error).message)}</div></div>`;
      ErrorLog.error('sap-interface', `Load objects failed: ${(e as Error).message}`);
    }
  }

  // Rebuild the whole console from cached _objects (no fetch).
  function _paint(): void {
    const host = document.getElementById('sap-interface-host');
    if (!host) return;
    host.innerHTML = `
      <div class="sap-pagehead">
        <div>
          <div class="sap-pagehead-title"><h2>${_esc(Util.t('tab.interface'))}</h2>
            <span class="sap-flow">SAP ECC <b>━▶</b> NIMBUS</span></div>
          <div class="sap-pagehead-sub">${_esc(Util.t('ui.sap_subtitle'))}</div>
        </div>
        <span class="sap-mode-chip"><span class="admin-health-dot"></span> ${_esc(Util.t('ui.sap_stub_mode'))}</span>
      </div>
      ${_renderRibbon()}
      <div class="sap-console">
        <div id="sap-rail"></div>
        <div id="sap-detail"></div>
      </div>`;
    host.querySelectorAll<HTMLElement>('[data-jump]').forEach((tile) => tile.addEventListener('click', () => {
      const j = tile.dataset.jump;
      if (j === 'errors') { const eo = _objects.find((o) => o.last_run && o.last_run.status === 'error'); if (eo) _selected = eo.object_key; }
      else if (j === 'last' && _lastNewestKey) { _selected = _lastNewestKey; }
      _tab = 'history'; _renderRail(); _renderDetail();
    }));
    _renderRail();
    _renderDetail();
  }

  function _renderRibbon(): string {
    const enabled = _objects.filter((o) => o.enabled).length;
    // A plain for-of (not .forEach) so TS's flow analysis actually widens
    // `newest`/`newestObj` back to their declared nullable type after the
    // loop — a `let x: T | null = null` reassigned only inside a callback
    // stays narrowed to `null` at every read after a `.forEach`, a known TS
    // control-flow limitation across function boundaries.
    let newest: SapRun | null = null;
    let newestObj: SapObject | null = null;
    for (const o of _objects) {
      const lr = o.last_run;
      if (lr && lr.started_at && (!newest || new Date(lr.started_at) > new Date(newest.started_at as string))) { newest = lr; newestObj = o; }
    }
    _lastNewestKey = newestObj ? newestObj.object_key : null;
    const errs = _objects.filter((o) => o.last_run && o.last_run.status === 'error').length;
    const tile = (k: string, v: string, d: string, cls: string, act: string) =>
      `<div class="kpi-tile${cls ? ' ' + cls : ''}${act ? ' is-actionable' : ''}"${act ? ` data-jump="${act}"` : ''}>`
      + `<div class="k">${_esc(k)}</div><div class="v">${v}</div><div class="d">${_esc(d)}</div></div>`;
    const lastV = newest ? `<span class="sap-v-sm">${_esc(_relTime(newest.started_at))}</span>` : '—';
    const lastD = newest ? `${newestObj?.label} · ${newest.triggered_by || 'manual'}` : 'no runs yet';
    const rowsV = newest ? Number(newest.rows_read || 0).toLocaleString() : '0';
    const rowsD = newest ? `+${newest.rows_inserted ?? 0} ins / ~${newest.rows_updated ?? 0} upd` : '—';
    return `<div class="sap-ribbon">
      ${tile(Util.t('ui.sap_kpi_connection'), 'Stub', 'connectors not live', 'warn', '')}
      ${tile(Util.t('ui.sap_kpi_objects'), `${enabled} <span class="sap-frac">/ ${_objects.length}</span>`, enabled ? `${_objects.length - enabled} awaiting setup` : 'none enabled', enabled ? '' : 'warn', '')}
      ${tile(Util.t('ui.sap_kpi_last_activity'), lastV, lastD, '', newest ? 'last' : '')}
      ${tile(Util.t('ui.sap_kpi_rows'), rowsV, rowsD, '', '')}
      ${tile(Util.t('ui.sap_kpi_errors'), String(errs), errs ? 'most recent run failed' : 'no failures', errs ? 'err' : '', errs ? 'errors' : '')}
    </div>`;
  }

  // -----------------------------------------------------------------------
  // Object rail (master) + detail shell (Overview / Mapping / History tabs)
  // -----------------------------------------------------------------------
  function _renderRail(): void {
    const el = document.getElementById('sap-rail');
    if (!el) return;
    const rows = _objects.map((o) => {
      const sel = o.object_key === _selected ? ' sap-rail-row-sel' : '';
      const lr = o.last_run;
      const dotCls = !lr ? '' : (lr.status === 'ok' ? 'ok' : (lr.status === 'error' ? 'err' : (lr.status === 'running' ? 'warn' : '')));
      const statusTxt = !lr ? Util.t('ui.sap_never_run')
        : (lr.status === 'ok' ? `ok · ${_relTime(lr.started_at)}`
        : (lr.status === 'error' ? `failed · ${_relTime(lr.started_at)}` : lr.status));
      const kind = o.kind || 'master';
      return `<div class="sap-rail-row${sel}" data-obj="${_esc(o.object_key)}">
        <span class="admin-health-dot ${dotCls}"></span>
        <div class="sap-rail-main">
          <div class="sap-rail-name">${_esc(o.label || o.object_key)} <span class="sap-kind sap-kind-${_esc(kind)}">${_esc(kind)}</span></div>
          <div class="sap-rail-meta">${_esc(o.object_key)} · ${_esc(o.transport || 'file_drop')}</div>
          <div class="sap-rail-status">${_esc(statusTxt)}</div>
        </div>
        <label class="cal-day-toggle-wrap sap-railsw" title="${_esc(Util.t('ui.sap_enabled'))}">
          <input type="checkbox" data-enable="${_esc(o.object_key)}" ${o.enabled ? 'checked' : ''}>
          <span class="cal-toggle-track"></span><span class="cal-toggle-thumb"></span>
        </label>
      </div>`;
    }).join('');
    el.innerHTML = `<div class="panel">
      <div class="panel-head"><span class="sap-section-label">${_esc(Util.t('ui.sap_objects'))}</span>
        <span class="sap-hint">${_objects.filter((o) => o.enabled).length} / ${_objects.length}</span></div>
      <div class="sap-rail">${rows}</div></div>`;
    el.querySelectorAll<HTMLElement>('[data-obj]').forEach((r) =>
      r.addEventListener('click', () => { _selected = r.dataset.obj ?? null; _testResult = null; _renderRail(); _renderDetail(); }));
    el.querySelectorAll<HTMLInputElement>('[data-enable]').forEach((cb) => {
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => _saveConfig(cb.dataset.enable as string, { enabled: cb.checked }, cb.checked ? Util.t('toast.sap_enable_note') : null));
    });
  }

  function _renderDetail(): void {
    const el = document.getElementById('sap-detail');
    if (!el) return;
    const o = _objects.find((x) => x.object_key === _selected);
    if (!o) { el.innerHTML = ''; return; }
    const kind = o.kind || 'master';
    const tabBtn = (id: string, label: string) => `<button class="sap-tab${_tab === id ? ' sap-tab-active' : ''}" data-tab="${id}">${_esc(label)}</button>`;
    el.innerHTML = `<div class="panel">
      <div class="sap-detail-head">
        <span class="sap-detail-name">${_esc(o.label || o.object_key)}</span>
        <span class="sap-kind sap-kind-${_esc(kind)}">${_esc(kind)}</span>
        <span class="sap-detail-key">${_esc(o.object_key)}</span>
        <div class="sap-detail-actions">
          <button class="btn btn-sm" data-act="dry">${_esc(Util.t('ui.sap_dry_run'))}</button>
          <button class="btn btn-sm btn-primary" data-act="run">${_esc(Util.t('ui.sap_run_now'))} ▸</button>
        </div>
      </div>
      <div class="sap-tabs">${tabBtn('overview', Util.t('ui.sap_overview'))}${tabBtn('mapping', Util.t('ui.sap_mapping'))}${tabBtn('history', Util.t('ui.sap_history'))}</div>
      <div class="sap-tabbody" id="sap-tabbody"><div class="md-loading">${_esc(Util.t('ui.loading'))}</div></div>
    </div>`;
    el.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => { _tab = b.dataset.tab as 'overview' | 'mapping' | 'history'; _renderDetail(); }));
    el.querySelectorAll<HTMLElement>('[data-act]').forEach((b) =>
      b.addEventListener('click', () => _runNow(o.object_key, b.dataset.act === 'dry', b as HTMLButtonElement)));
    if (_tab === 'overview') _renderOverview(o);
    else if (_tab === 'mapping') _renderMapping(o);
    else _renderHistory(o);
  }

  function _relTime(ts: string | null | undefined): string {
    if (!ts) return '—';
    const d = new Date(ts); if (isNaN(d.getTime())) return String(ts);
    let s = Math.floor((Date.now() - d.getTime()) / 1000); if (s < 0) s = 0;
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function _cronProse(c: string | null | undefined): string | null {
    if (!c) return null;
    const p = c.trim().split(/\s+/); if (p.length !== 5) return null;
    const mi = p[0], ho = p[1], dom = p[2], mon = p[3];
    const pad = (x: string) => (x === '*' ? '00' : (x.length < 2 ? '0' + x : x));
    if (dom === '*' && mon === '*' && p[4] === '*' && ho !== '*' && mi !== '*') return `Every day at ${pad(ho)}:${pad(mi)}`;
    if (mi.indexOf('*/') === 0) return `Every ${mi.slice(2)} minutes`;
    if (ho.indexOf('*/') === 0 && dom === '*') return `Every ${ho.slice(2)} hours`;
    return null;
  }

  // -----------------------------------------------------------------------
  // Overview tab — transport config, secret indicator, schedule, checklist
  // -----------------------------------------------------------------------
  async function _renderOverview(o: SapObject): Promise<void> {
    const body = document.getElementById('sap-tabbody');
    if (!body) return;
    let cfg: SapObjectConfig | undefined = _config[o.object_key];
    if (!cfg) {
      try {
        cfg = await Util.fetchTraced(`${API}/sap/interface/config/${encodeURIComponent(o.object_key)}`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
        _config[o.object_key] = cfg as SapObjectConfig;
      } catch {
        cfg = { transport: (o.transport || 'file_drop'), source_params: {}, has_secret: false, schedule_cron: o.schedule_cron ?? null };
      }
    }
    // bail if the user switched object/tab while awaiting
    if (document.getElementById('sap-tabbody') !== body || _tab !== 'overview' || _selected !== o.object_key) return;
    // cfg is always assigned by this point (fetch-success or catch-fallback
    // above) — TS's flow analysis can't track the reassignment through the
    // async .then()-with-throw chain inside the try, a known CFA limitation
    // across function boundaries (same family of gap as `_renderRibbon`'s
    // for-of note above), so it's asserted here rather than left as a
    // scattered `cfg!` at every read site below.
    cfg = cfg as SapObjectConfig;

    const transport: SapTransport = cfg.transport || o.transport || 'file_drop';
    const cron = cfg.schedule_cron != null ? cfg.schedule_cron : (o.schedule_cron || '');
    const prose = _cronProse(cron);
    const lr = o.last_run;
    const errBanner = (lr && lr.status === 'error')
      ? `<div class="sap-banner sap-banner-err"><span class="sap-banner-ico">⚠</span><div><b>${_esc(Util.t('ui.sap_last_failed'))} ${_esc(_relTime(lr.started_at))}</b><div class="sap-mono">${_esc(lr.error || '')}</div></div></div>`
      : '';
    const secret = cfg.has_secret
      ? `<div class="sap-chipline"><span class="admin-health-dot ok"></span> ${_esc(Util.t('ui.sap_credential_present'))}</div>`
      : `<div class="sap-chipline"><span class="admin-health-dot warn"></span> ${_esc(Util.t('ui.sap_no_credential'))}</div>`;
    const activeMaps = (_mapState[o.object_key]?.rows || []).filter((m) => m.active && m.sap_field && m.nimbus_column).length;
    const steps: [string, string, boolean][] = [
      ['01', Util.t('ui.sap_step_transport'), true],
      ['02', Util.t('ui.sap_step_map'), activeMaps > 0],
      ['03', Util.t('ui.sap_step_enable'), o.enabled && !!cron],
      ['04', Util.t('ui.sap_step_test'), false],
      ['05', Util.t('ui.sap_step_dryrun'), !!(lr && lr.triggered_by === 'dry-run')],
      ['06', Util.t('ui.sap_step_first'), !!(lr && lr.status === 'ok' && (lr.rows_inserted || 0) > 0)],
    ];
    const checklist = steps.map((s) =>
      `<div class="sap-check-step${s[2] ? ' done' : ''}"><span class="sap-check-n">${s[0]}</span><span class="sap-check-mark">${s[2] ? '✓' : ''}</span><span class="sap-check-t">${_esc(s[1])}</span></div>`).join('');
    const tr = _testResult;
    const testStrip = tr
      ? `<div class="sap-test-strip ${tr.cls}"><span class="admin-health-dot ${tr.dot || ''}"></span> ${_esc(tr.msg)}</div>`
      : `<div class="sap-test-strip"><span class="admin-health-dot"></span> ${_esc(Util.t('ui.sap_not_tested'))}</div>`;

    body.innerHTML = `${errBanner}
      <div class="sap-ov-grid">
        <div>
          <div class="sap-section-label">${_esc(Util.t('ui.sap_connection_section'))}</div>
          <div class="sap-field"><label>${_esc(Util.t('ui.sap_transport'))}</label>
            <select id="sap-transport-sel">${TRANSPORTS.map(tp => `<option${tp === transport ? ' selected' : ''}>${tp}</option>`).join('')}</select></div>
          <div id="sap-transport-fields">${_transportFieldsHTML(transport, cfg.source_params || {})}</div>
          <div class="sap-secretbox">${secret}<div class="sap-secret-note">${_esc(Util.t('ui.sap_secret_note'))}</div></div>
          <div class="sap-test-row"><button class="btn" id="sap-test-btn">${_esc(Util.t('ui.sap_test_connection'))}</button></div>
          ${testStrip}
        </div>
        <div>
          <div class="sap-section-label">${_esc(Util.t('ui.sap_schedule_section'))}</div>
          <div class="sap-field"><label>${_esc(Util.t('ui.sap_cron'))}</label>
            <input class="sap-mono" id="sap-cron-input" value="${_esc(cron)}" placeholder="— — — — —">
            ${prose ? `<div class="sap-cron-prose">${_esc(prose)}<span class="sap-cron-raw">${_esc(cron)}</span></div>` : `<div class="sap-help">${_esc(Util.t('ui.sap_not_scheduled'))}</div>`}</div>
          <div class="sap-banner sap-banner-info"><span class="sap-banner-ico">ℹ</span><div>${_esc(Util.t('ui.sap_scheduler_note_a'))} <span class="sap-mono">NIMBUS_SAP_SYNC_ENABLED=1</span> ${_esc(Util.t('ui.sap_scheduler_note_b'))}</div></div>
          <div class="sap-section-label">${_esc(Util.t('ui.sap_delta_section'))}</div>
          <div class="sap-kv"><span>${_esc(Util.t('ui.sap_last_watermark'))}</span><span class="sap-mono">${_esc(cfg.last_watermark || '— (full load)')}</span></div>
        </div>
        <div class="sap-ov-full">
          <div class="sap-section-label">${_esc(Util.t('ui.sap_checklist'))}</div>
          <div class="sap-check">${checklist}</div>
        </div>
      </div>`;

    document.getElementById('sap-transport-sel')?.addEventListener('change', (e: Event) => {
      const value = (e.target as HTMLSelectElement).value as SapTransport;
      _config[o.object_key] = { ...(_config[o.object_key] || cfg as SapObjectConfig), transport: value };
      _testResult = null;
      _saveConfig(o.object_key, { transport: value }, null);
    });
    document.getElementById('sap-cron-input')?.addEventListener('change', (e: Event) =>
      _saveConfig(o.object_key, { schedule_cron: (e.target as HTMLInputElement).value.trim() || null }, null));
    document.getElementById('sap-test-btn')?.addEventListener('click', () => _testConnection(o.object_key, transport));
  }

  function _transportFieldsHTML(transport: SapTransport, params: Record<string, string>): string {
    const fields = TRANSPORT_FIELDS[transport] || [];
    if (!fields.length) return '';
    return fields.map((f) =>
      `<div class="sap-field"><label>${_esc(f[1])}</label><input class="sap-mono" data-param="${_esc(f[0])}" value="${_esc(params[f[0]] != null ? params[f[0]] : '')}" placeholder="${_esc(f[2])}" spellcheck="false"></div>`).join('');
  }

  async function _testConnection(object: string, transport: SapTransport): Promise<void> {
    const params: Record<string, string> = {};
    document.querySelectorAll<HTMLInputElement>('#sap-transport-fields [data-param]').forEach((inp) => {
      if (inp.value.trim() && inp.dataset.param) params[inp.dataset.param] = inp.value.trim();
    });
    _testResult = { cls: 'info', dot: '', msg: Util.t('ui.sap_testing') };
    _renderDetail();
    try {
      const res: SapTestConnectionResult = await fetch(`${API}/sap/interface/test-connection`, {
        method: 'POST', headers: _writeHeaders(),
        body: JSON.stringify({ transport, source_params: params }),
      }).then((r) => { if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); }); return r.json(); });
      _testResult = res.ok
        ? { cls: 'ok', dot: 'ok', msg: `${Util.t('toast.sap_conn_ok')} — ${res.detail || ''}`.trim() }
        : { cls: 'info', dot: '', msg: res.detail || Util.t('toast.sap_conn_fail') };
    } catch (e) {
      _testResult = { cls: 'err', dot: 'err', msg: `${Util.t('toast.sap_conn_fail')} — ${(e as Error).message}` };
      ErrorLog.error('sap-interface', `Test connection failed: ${(e as Error).message}`);
    }
    if (_tab === 'overview' && _selected === object) _renderDetail();
  }

  async function _saveConfig(object: string, patch: SapConfigPatch, confirmMsg: string | null): Promise<void> {
    try {
      await fetch(`${API}/sap/interface/config/${encodeURIComponent(object)}`, {
        method: 'POST', headers: _writeHeaders(), body: JSON.stringify(patch),
      }).then((r) => { if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); }); return r.json(); });
      if (_config[object]) _config[object] = { ...(_config[object]), ...patch };
      if (confirmMsg) Toast.show(confirmMsg, 'info');
      await _reload();
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('sap-interface', `Config save failed for ${object}: ${(e as Error).message}`);
      await _reload();
    }
  }

  async function _runNow(object: string, dryRun: boolean, btn: HTMLButtonElement | null): Promise<void> {
    if (btn) btn.disabled = true;
    try {
      const res: SapSyncResult = await fetch(`${API}/sap/interface/sync/${encodeURIComponent(object)}`, {
        method: 'POST', headers: _writeHeaders(), body: JSON.stringify({ dry_run: !!dryRun }),
      }).then((r) => { if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); }); return r.json(); });
      if (res.status === 'ok') {
        Toast.show(`${dryRun ? Util.t('toast.sap_dryrun_done') : Util.t('toast.sap_sync_done')} (read ${res.rows_read ?? 0} · +${res.rows_inserted ?? 0} / ~${res.rows_updated ?? 0})`, 'success');
      } else {
        Toast.show(`${Util.t('toast.sap_sync_failed')}: ${res.error || ''}`.trim(), 'error', 6000);
      }
      await _reload();
    } catch (e) {
      Toast.show(`${Util.t('toast.sap_sync_failed')}: ${(e as Error).message}`, 'error');
      ErrorLog.error('sap-interface', `Sync failed for ${object}: ${(e as Error).message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // -----------------------------------------------------------------------
  // Mapping tab — SAP field ━▶ transform ━▶ NIMBUS column flow editor
  // -----------------------------------------------------------------------
  async function _renderMapping(o: SapObject): Promise<void> {
    const body = document.getElementById('sap-tabbody');
    if (!body) return;
    if (!_mapState[o.object_key]) {
      body.innerHTML = `<div class="md-loading">${_esc(Util.t('ui.loading'))}</div>`;
      try {
        const data: SapMappingsResponse = await Util.fetchTraced(`${API}/sap/interface/mappings/${encodeURIComponent(o.object_key)}`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
        _mapState[o.object_key] = {
          rows: (data.mappings || []).map((m) => ({
            sap_field: m.sap_field || '', nimbus_column: m.nimbus_column || '',
            transform: m.transform || 'none', active: m.active !== false,
          })),
          dirty: false,
        };
      } catch (e) {
        body.innerHTML = `<div class="sap-empty"><div class="sap-empty-t">${_esc(Util.t('ui.sap_map_load_failed'))}</div><div class="sap-empty-d">${_esc((e as Error).message)}</div></div>`;
        ErrorLog.error('sap-interface', `Load mappings failed for ${o.object_key}: ${(e as Error).message}`);
        return;
      }
    }
    if (document.getElementById('sap-tabbody') !== body || _tab !== 'mapping' || _selected !== o.object_key) return;
    _drawMapping(o);
  }

  function _drawMapping(o: SapObject): void {
    const body = document.getElementById('sap-tabbody');
    const st = _mapState[o.object_key];
    if (!body || !st) return;
    const isMaster = (o.kind || 'master') === 'master';
    const keys = MASTER_KEYS[o.object_key] || [];
    const rails = `<div class="sap-flow-rails"><span class="sap-fr">▤ ${_esc(Util.t('ui.sap_field'))}</span><span class="sap-fr c">${_esc(Util.t('ui.sap_transform'))}</span><span class="sap-fr r">${_esc(Util.t('ui.sap_nimbus_column'))} ◆</span></div>`;

    if (!st.rows.length) {
      body.innerHTML = `${isMaster ? _keystrip(o, st) : ''}
        <div class="sap-banner sap-banner-info"><span class="sap-banner-ico">→</span><div>${isMaster ? _esc(Util.t('ui.sap_map_primer_master')) : _esc(Util.t('ui.sap_map_primer_orders'))}</div></div>
        ${rails}
        <div class="sap-ghost-row"><div class="sap-ghost-node">SAP field</div><div class="sap-ghost-mid">transform</div><div class="sap-ghost-node">nimbus_column</div></div>
        <div class="sap-map-actions"><button class="btn btn-sm" id="sap-add-map">+ ${_esc(Util.t('ui.sap_add_first'))}</button></div>`;
      document.getElementById('sap-add-map')?.addEventListener('click', () => { st.rows.push({ sap_field: '', nimbus_column: '', transform: 'none', active: true }); st.dirty = true; _drawMapping(o); });
      return;
    }

    const rows = st.rows.map((m, i) => {
      const isKey = isMaster && keys.indexOf(m.nimbus_column) > -1;
      const opts = TRANSFORMS.map((tr) => `<option${tr === m.transform ? ' selected' : ''}>${tr}</option>`).join('');
      return `<div class="sap-map-row${m.active ? '' : ' inactive'}" style="animation-delay:${i * 55}ms">
        <input class="sap-node sap-node-sap" data-idx="${i}" data-f="sap_field" value="${_esc(m.sap_field)}" placeholder="SAP field" spellcheck="false">
        <span class="sap-wire"><span class="sap-wire-fill" style="animation-delay:${i * 55}ms"></span></span>
        <span class="sap-xform-wrap${m.transform === 'none' ? ' none' : ''}"><select class="sap-xform${m.transform === 'none' ? ' none' : ''}" data-idx="${i}" data-f="transform">${opts}</select><span class="sap-xform-hint">${_esc(XHINT[m.transform] || '')}</span></span>
        <span class="sap-node-wrap"><input class="sap-node sap-node-nimbus${isKey ? ' key' : ''}" data-idx="${i}" data-f="nimbus_column" value="${_esc(m.nimbus_column)}" placeholder="nimbus_column" spellcheck="false">${isKey ? '<span class="sap-keytag" title="Key column">🔑</span>' : ''}</span>
        <span class="sap-row-tools"><label class="cal-day-toggle-wrap sap-rowsw" title="${_esc(Util.t('ui.sap_active'))}"><input type="checkbox" data-idx="${i}" data-f="active" ${m.active ? 'checked' : ''}><span class="cal-toggle-track"></span><span class="cal-toggle-thumb"></span></label><button class="sap-icon-btn danger" data-del="${i}" title="Remove">🗑</button></span>
      </div>`;
    }).join('');

    let guard = '', blocked = false;
    if (isMaster && keys.length) {
      const missing = keys.filter((k) => !st.rows.some((m) => m.nimbus_column === k && m.active));
      blocked = missing.length > 0;
      guard = _keystrip(o, st);
      if (blocked) {
        guard += `<div class="sap-banner sap-banner-err"><span class="sap-banner-ico">⚠</span><div><b>${_esc(o.label || o.object_key)} ${_esc(Util.t('ui.sap_upsert_fail'))}</b> ${_esc(Util.t('ui.sap_key_missing'))} <span class="sap-mono">${missing.map(_esc).join(', ')}</span>.</div></div>`;
      }
    } else if (!isMaster) {
      guard = `<div class="sap-help" style="margin-bottom:12px"><span class="sap-mono">production_order</span> ${_esc(Util.t('ui.sap_orders_identity'))}</div>`;
    }

    body.innerHTML = `${guard}${rails}<div class="sap-flow">${rows}</div>
      <div class="sap-map-actions">
        <button class="btn btn-sm" id="sap-add-map">+ ${_esc(Util.t('ui.sap_add_mapping'))}</button>
        <span class="sap-spacer"></span>
        ${st.dirty ? `<span class="sap-dirty">${_esc(Util.t('ui.sap_unsaved'))}</span>` : ''}
        <button class="btn btn-sm btn-primary" id="sap-save-map"${blocked ? ` disabled title="${_esc(Util.t('ui.sap_resolve_keys'))}"` : ''}>${_esc(Util.t('ui.sap_save_mappings'))}</button>
      </div>`;

    body.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-f]').forEach((inp) => {
      const isText = inp.tagName === 'INPUT' && (inp as HTMLInputElement).type === 'text';
      const update = () => {
        const idx = Number(inp.dataset.idx);
        const field = inp.dataset.f as keyof SapMapRow;
        const row = st.rows[idx]; if (!row || !field) return;
        const checked = (inp as HTMLInputElement).type === 'checkbox' ? (inp as HTMLInputElement).checked : undefined;
        if (field === 'active') row.active = !!checked;
        else if (field === 'sap_field') row.sap_field = inp.value;
        else if (field === 'nimbus_column') row.nimbus_column = inp.value;
        else if (field === 'transform') row.transform = inp.value;
        st.dirty = true;
      };
      if (isText) { inp.addEventListener('input', update); inp.addEventListener('change', () => { update(); _drawMapping(o); }); }
      else { inp.addEventListener('change', () => { update(); _drawMapping(o); }); }
    });
    body.querySelectorAll<HTMLElement>('[data-del]').forEach((b) =>
      b.addEventListener('click', () => { st.rows.splice(Number(b.dataset.del), 1); st.dirty = true; _drawMapping(o); }));
    document.getElementById('sap-add-map')?.addEventListener('click', () => { st.rows.push({ sap_field: '', nimbus_column: '', transform: 'none', active: true }); st.dirty = true; _drawMapping(o); });
    document.getElementById('sap-save-map')?.addEventListener('click', () => _saveMappings(o.object_key));
  }

  function _keystrip(o: SapObject, st: SapMapState): string {
    const keys = MASTER_KEYS[o.object_key] || [];
    if (!keys.length) return '';
    const chips = keys.map((k) => {
      const ok = st.rows.some((m) => m.nimbus_column === k && m.active);
      return `<span class="sap-keychip${ok ? '' : ' miss'}"><span class="admin-health-dot ${ok ? 'ok' : 'err'}"></span>${_esc(k)}${ok ? '' : ` <span class="sap-req">${_esc(Util.t('ui.sap_required'))}</span>`}</span>`;
    }).join('');
    return `<div class="sap-keystrip"><span class="sap-ks-label">${_esc(Util.t('ui.sap_key_columns'))}</span>${chips}</div>`;
  }

  async function _saveMappings(object: string): Promise<void> {
    const st = _mapState[object];
    if (!st) return;
    const mappings = st.rows
      .filter((m) => m.sap_field.trim() && m.nimbus_column.trim())
      .map((m, i) => ({ sap_field: m.sap_field.trim(), nimbus_column: m.nimbus_column.trim(), transform: m.transform || 'none', active: m.active !== false, field_order: i }));
    try {
      await fetch(`${API}/sap/interface/mappings/${encodeURIComponent(object)}`, {
        method: 'POST', headers: _writeHeaders(), body: JSON.stringify({ mappings }),
      }).then((r) => { if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); }); return r.json() as Promise<SapMappingsSaveResult>; });
      delete _mapState[object];
      Toast.show(Util.t('toast.sap_mappings_saved'), 'success');
      await _reload();
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('sap-interface', `Save mappings failed for ${object}: ${(e as Error).message}`);
    }
  }

  // -----------------------------------------------------------------------
  // History tab — run timeline (status, counts, duration, watermark, errors)
  // -----------------------------------------------------------------------
  async function _renderHistory(o: SapObject): Promise<void> {
    const body = document.getElementById('sap-tabbody');
    if (!body) return;
    body.innerHTML = `<div class="md-loading">${_esc(Util.t('ui.loading'))}</div>`;
    try {
      const params = new URLSearchParams({ limit: '50', object: o.object_key });
      const data: SapRunsResponse = await Util.fetchTraced(`${API}/sap/interface/runs?${params.toString()}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
      if (document.getElementById('sap-tabbody') !== body || _tab !== 'history' || _selected !== o.object_key) return;
      const runs = data.runs || [];
      if (!runs.length) {
        body.innerHTML = `<div class="sap-empty"><div class="sap-empty-ico">◍</div><div class="sap-empty-t">${_esc(Util.t('ui.sap_no_runs'))}</div><div class="sap-empty-d">${_esc(Util.t('ui.sap_no_runs_hint'))}</div><button class="btn btn-sm" data-act-empty="dry">${_esc(Util.t('ui.sap_dry_run'))}</button></div>`;
        body.querySelector('[data-act-empty]')?.addEventListener('click', () => _runNow(o.object_key, true, null));
        return;
      }
      body.innerHTML = `<div class="sap-feed">${runs.map((rn, i) => _runRow(rn, i)).join('')}</div>`;
      body.querySelectorAll<HTMLElement>('[data-exp]').forEach((b) =>
        b.addEventListener('click', () => b.closest('.sap-run')?.classList.toggle('open')));
    } catch (e) {
      body.innerHTML = `<div class="sap-empty"><div class="sap-empty-t">${_esc(Util.t('ui.sap_runs_load_failed'))}</div><div class="sap-empty-d">${_esc((e as Error).message)}</div></div>`;
      ErrorLog.error('sap-interface', `Load runs failed: ${(e as Error).message}`);
    }
  }

  function _runRow(rn: SapRun, i: number): string {
    const status = rn.status || 'unknown';
    const cls = status === 'ok' ? 'ok' : (status === 'error' ? 'err' : 'info');
    const pill = status === 'ok' ? '<span class="sap-pill ok">ok</span>'
      : (status === 'error' ? '<span class="sap-pill err">error</span>' : `<span class="sap-pill info">${_esc(status)}</span>`);
    const dur = _dur(rn.started_at, rn.ended_at);
    const counts = `read ${rn.rows_read ?? 0} · <span class="ins">+${rn.rows_inserted ?? 0} ins</span> / <span class="upd">~${rn.rows_updated ?? 0} upd</span> / <span class="fail">!${rn.rows_failed ?? 0} fail</span>`;
    const wm = (rn.watermark_before || rn.watermark_after)
      ? `<div class="sap-run-wm">watermark ${_esc(rn.watermark_before || '∅')} → ${_esc(rn.watermark_after || '∅')}</div>` : '';
    const err = rn.error
      ? `<div class="sap-run-err"><button class="sap-exp" data-exp="${i}">view error ▾</button><pre>${_esc(rn.error)}</pre></div>` : '';
    return `<div class="sap-run ${cls}"><div class="sap-run-head">${pill}<span class="sap-run-t">${_esc(_fmtTs(rn.started_at))}</span><span class="sap-run-by">${_esc(rn.triggered_by || 'manual')}</span>${dur ? `<span class="sap-run-dur">${_esc(dur)}</span>` : ''}</div><div class="sap-run-counts">${counts}</div>${wm}${err}</div>`;
  }

  function _dur(a: string | null | undefined, b: string | null | undefined): string {
    if (!a || !b) return '';
    const d = (new Date(b).getTime() - new Date(a).getTime()) / 1000;
    if (isNaN(d) || d < 0) return '';
    if (d < 1) return `${Math.round(d * 1000)}ms`;
    if (d < 60) return `${d.toFixed(1)}s`;
    return `${Math.floor(d / 60)}m ${Math.round(d % 60)}s`;
  }

  function _fmtTs(ts: string | null | undefined): string {
    if (!ts) return '—';
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return String(ts);
      return Util.fmtDTReadable ? Util.fmtDTReadable(d) : d.toLocaleString();
    } catch { return String(ts); }
  }

  return { render };
})();

/** One `GET /security/users` row (`auth.list_users`) — username, role, and
 *  whether a password is set; NEVER carries the hash itself. Not part of the
 *  backend's `response_model=` scope (only the task-date-update endpoint
 *  family is), so hand-written locally, matching Interface's precedent. */
interface SecurityUser {
  username: string;
  role: string | null;
  has_password: boolean;
  first_name?: string | null;
  last_name?: string | null;
  // ISO timestamp string (or null = never logged in since this column
  // existed) from auth.list_users; server-side audit only, unrelated to the
  // frontend's own 12h local session-cache expiry.
  last_login?: string | null;
}

interface SecurityUsersResponse {
  users: SecurityUser[];
  meta?: { total: number };
}

/** A row staged client-side via "Paste rows" (`_pasteUsers`), not yet POSTed
 *  to `/security/users/bulk` — distinct from `SecurityUser` (no
 *  `has_password`; that only exists once the backend has a real row). All
 *  four fields are genuinely guaranteed present here because `_pasteUsers`
 *  always normalizes a `SecurityPastedRow` (below) through `|| ''` before
 *  pushing onto `_staged` — this interface describes that post-normalization
 *  invariant, not the raw parse output. */
interface SecurityStagedUser {
  username: string;
  role: string;
  first_name: string;
  last_name: string;
}

/** The RAW shape of one `_parseUserPaste` row, before `_pasteUsers`
 *  normalizes it into a `SecurityStagedUser` — built dynamically from
 *  whatever header columns actually appeared in the pasted clipboard text
 *  (`headers.forEach((h, i) => { row[h] = ...; })`), so only the fields
 *  matching a detected header column exist. `username` is intentionally
 *  optional here too (a plain `Record<string, string>`'s index signature
 *  cannot prove any specific key is present) — `_parseUserPaste`'s trailing
 *  `.filter((r): r is SecurityPastedRow & { username: string } => ...)` is
 *  what actually narrows it to guaranteed-present before returning. */
interface SecurityPastedRow {
  username?: string;
  role?: string;
  first_name?: string;
  last_name?: string;
}

/** `POST /security/users/bulk` payload (`auth.bulk_upsert_users`) — role-only
 *  upserts never send passwords (`set_user_password` owns those separately). */
interface SecurityUserUpsert {
  username: string;
  role?: string | null;
  first_name?: string;
  last_name?: string;
}

/** Shared bulk-write result shape — `auth.bulk_upsert_users` and
 *  `master_data.bulk_apply` (used generically here for `roles`/`role_plants`,
 *  per the correction that those two tables belong to Security's domain, not
 *  MasterData's — kept as Security's own local type rather than reused from
 *  MasterData's `MasterDataBulkResult`, same self-contained spirit as the
 *  module's own `_esc`/`_writeHeaders` copies). */
interface SecurityBulkResult {
  inserted: number;
  updated: number;
  deleted: number;
}

/** One `roles` table row (`GET /master-data/roles`, generic master_data.py
 *  read path — `roles`/`role_plants` are registered in `ALLOWED_TABLES` but
 *  belong to Security's domain, not MasterData's UI). */
interface SecurityRoleRow {
  role: string;
  description?: string | null;
  /** roles.settings.pages — per-role top-level page-access toggles, attached
   *  by master_data.py's list_rows() for the 'roles' table only (not a real
   *  registered column_metadata column, so it never shows in a plain grid). */
  pages?: Partial<Record<TopLevelTab, boolean>> | null;
}

/** One `role_plants` table row (`GET /master-data/role_plants`). */
interface SecurityRolePlantRow {
  role: string;
  plant: string;
}

/** Generic `GET /master-data/{table}` envelope, narrowed to the two rows
 *  shapes Security reads (`roles`, `role_plants`) — mirrors
 *  `MasterDataResponse` structurally but kept local/self-contained. */
interface SecurityMasterDataResponse<T> {
  rows: T[];
  meta?: { total: number };
}

/* =============================================================================
   SECURITY — admin sub-tab: user accounts (username / role / password) and
   role-based plant assignment (roles + role_plants). Same self-contained,
   paint-into-one-host-div idiom as Interface: private state, a public
   render() entry point, an internal 'users' | 'roles' tab, full re-render on
   every tab switch and on every write (mirrors Interface's _saveConfig: try
   the write, Toast+log on failure, then unconditionally reload+repaint from
   the server either way). Backend: /security/users(+/bulk, +/{username}/
   reset-password) for accounts (auth.py); the generic /master-data/roles
   and /master-data/role_plants (+/bulk) for roles and their plant scoping
   (master_data.py) — this module only renders and posts, never touches
   password hashes beyond the single write they're submitted in.
   ========================================================================== */
export const Security = (() => {
  const API = Config.API_BASE;

  let _tab: 'users' | 'roles' = 'users'; // active top-level tab

  // ---- Users tab state ----
  let _users: SecurityUser[] = [];        // last GET /security/users .users: [{username,role,has_password}]
  let _usersSearch = '';           // current server-side search query
  let _roleOptions: string[] = [];        // role names for the Role <select> (from GET /master-data/roles)
  let _staged: SecurityStagedUser[] = []; // rows staged via "Paste rows", not yet saved: [{username, role}]
  const _pwOpen: Set<string> = new Set();       // usernames with an open inline password-reveal row
  const _nameSaveTimers: Map<string, ReturnType<typeof setTimeout>> = new Map(); // username -> pending debounce timeout id

  // ---- Roles tab state ----
  let _roles: SecurityRoleRow[] = [];         // GET /master-data/roles rows: [{role, description}]
  let _rolePlants: SecurityRolePlantRow[] = []; // GET /master-data/role_plants rows: [{role, plant}]
  let _rolesInUse: Set<string> = new Set();     // role names currently assigned to >=1 user (best-effort; disables delete)
  let _selectedRole: string | null = null;

  const _esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c: string) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

  function _writeHeaders(json = true): Record<string, string> {
    const h: Record<string, string> = { 'x-user-email': Session.actor() };
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  function _postJSON(url: string, body: unknown): Promise<unknown> {
    return fetch(url, { method: 'POST', headers: _writeHeaders(), body: JSON.stringify(body) })
      .then((r) => {
        if (!r.ok) {
          // A 403 here means the backend admin gate rejected us though the UI
          // believed we were admin (stale cached role). Reconcile + prompt
          // re-auth instead of only bubbling a raw error to the caller.
          if (r.status === 403) { try { Session.onAuthDenied(); } catch {} }
          return r.json().catch(() => ({})).then((e) => {
            const err: Error & { status?: number } = new Error(e.detail || `HTTP ${r.status}`);
            err.status = r.status;
            throw err;
          });
        }
        return r.json();
      });
  }

  const _debouncedUserSearch = Util.debounce(() => _reloadUsers(), 300);

  // -----------------------------------------------------------------------
  // Public entry point
  // -----------------------------------------------------------------------
  async function render(): Promise<void> {
    const host = document.getElementById('security-host');
    if (!host) return;
    _paintShell();
    await _loadActiveTab();
  }

  function _paintShell(): void {
    const host = document.getElementById('security-host');
    if (!host) return;
    const tabBtn = (id: string, label: string) => `<button class="sap-tab${_tab === id ? ' sap-tab-active' : ''}" data-tab="${id}">${_esc(label)}</button>`;
    host.innerHTML = `
      <div class="sap-pagehead">
        <div><div class="sap-pagehead-title"><h2>${_esc(Util.t('tab.security'))}</h2></div></div>
      </div>
      <div class="sap-tabs">${tabBtn('users', Util.t('tab.security_users'))}${tabBtn('roles', Util.t('tab.security_roles'))}</div>
      <div id="security-tabbody"><div class="md-loading">${_esc(Util.t('ui.loading'))}</div></div>`;
    host.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => { _tab = b.dataset.tab as 'users' | 'roles'; _paintShell(); _loadActiveTab(); }));
  }

  function _loadActiveTab(): Promise<void> {
    return _tab === 'users' ? _reloadUsers() : _reloadRoles();
  }

  // -----------------------------------------------------------------------
  // USERS tab
  // -----------------------------------------------------------------------
  async function _reloadUsers(): Promise<void> {
    const body = document.getElementById('security-tabbody');
    try {
      const q = _usersSearch.trim();
      const usersUrl = `${API}/security/users` + (q ? `?search=${encodeURIComponent(q)}` : '');
      const [usersData, rolesData]: [SecurityUsersResponse, SecurityMasterDataResponse<SecurityRoleRow>] = await Promise.all([
        Util.fetchTraced(usersUrl).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
        Util.fetchTraced(`${API}/master-data/roles`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
      ]);
      _users = usersData.users || [];
      _roleOptions = [...new Set((rolesData.rows || []).map((r) => r.role).filter(Boolean))].sort();
      if (_tab !== 'users') return; // bail if the admin switched tabs while awaiting
      _renderUsersTab();
    } catch (e) {
      const is403 = (e as Error & { status?: number }).status === 403 || /\b403\b/.test((e as Error).message || '');
      // Stale-admin 403 (the /master-data/roles half of the Promise.all is
      // ungated, so a 403 here is from /security/users): reconcile + re-auth.
      if (is403) { try { Session.onAuthDenied(); } catch {} }
      if (body) body.innerHTML = `<div class="md-empty">${_esc(is403 ? Util.t('sec.access_revoked') : Util.t('sec.load_users_failed', { msg: (e as Error).message }))}</div>`;
      ErrorLog.error('security', `Load users failed: ${(e as Error).message}`);
    }
  }

  function _renderUsersTab(): void {
    const body = document.getElementById('security-tabbody');
    if (!body) return;
    // Preserve the search box's focus/caret across the re-render a debounced
    // keystroke-driven reload causes (captured synchronously, not via
    // focus/blur listeners, since replacing innerHTML can race those).
    const hadFocus = document.activeElement && document.activeElement.id === 'sec-user-search';
    const caret = hadFocus ? (document.activeElement as HTMLInputElement).selectionStart : null;
    body.innerHTML = _usersShellHtml();
    _wireUsersShell();
    _renderUsersRows();
    _renderUsersActions();
    if (hadFocus) {
      const search = document.getElementById('sec-user-search') as HTMLInputElement | null;
      if (search) {
        search.focus();
        const pos = caret ?? search.value.length;
        search.setSelectionRange(pos, pos);
      }
    }
  }

  function _usersShellHtml(): string {
    return `
      <div class="panel">
        <div class="md-toolbar">
          <input type="search" class="input md-search" id="sec-user-search" placeholder="${_esc(Util.t('sec.search_users_ph'))}" value="${_esc(_usersSearch)}">
          <span class="spacer"></span>
          <button class="btn btn-ghost sm" id="sec-paste-users" title="${_esc(Util.t('tip.paste_rows'))}">${_esc(Util.t('btn.paste_rows'))}</button>
          <span id="sec-users-actions" style="display:inline-flex;gap:8px;align-items:center"></span>
        </div>
        <div style="display:flex;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);align-items:center;flex-wrap:wrap">
          <input type="text" class="input" id="sec-new-username" placeholder="${_esc(Util.t('sec.username_ph'))}" style="flex:1;min-width:120px">
          <input type="text" class="input" id="sec-new-firstname" placeholder="${_esc(Util.t('sec.first_name_ph'))}" maxlength="100" style="flex:1;min-width:100px">
          <input type="text" class="input" id="sec-new-lastname" placeholder="${_esc(Util.t('sec.last_name_ph'))}" maxlength="100" style="flex:1;min-width:100px">
          ${_roleSelectHtml('', 'id="sec-new-role-select"')}
          <input type="password" class="input" id="sec-new-password" placeholder="${_esc(Util.t('sec.new_password_ph'))}" autocomplete="new-password" style="flex:1;min-width:120px">
          <button class="btn btn-primary sm" id="sec-add-user-btn">${_esc(Util.t('sec.add_user'))}</button>
        </div>
        <div class="md-table-wrap">
          <table class="md-table">
            <thead><tr>
              <th class="md-th">${_esc(Util.t('sec.username'))}</th>
              <th class="md-th">${_esc(Util.t('sec.first_name'))}</th>
              <th class="md-th">${_esc(Util.t('sec.last_name'))}</th>
              <th class="md-th">${_esc(Util.t('sec.role'))}</th>
              <th class="md-th">${_esc(Util.t('sec.password'))}</th>
              <th class="md-th">${_esc(Util.t('sec.last_login'))}</th>
              <th class="md-th"></th>
            </tr></thead>
            <tbody id="sec-users-tbody"></tbody>
          </table>
        </div>
      </div>`;
  }

  function _wireUsersShell(): void {
    const search = document.getElementById('sec-user-search') as HTMLInputElement | null;
    if (search) {
      search.addEventListener('input', () => { _usersSearch = search.value; _debouncedUserSearch(); });
    }
    document.getElementById('sec-paste-users')?.addEventListener('click', _pasteUsers);
    document.getElementById('sec-add-user-btn')?.addEventListener('click', _addUser);
  }

  function _renderUsersActions(): void {
    const el = document.getElementById('sec-users-actions');
    if (!el) return;
    el.innerHTML = _staged.length
      ? `<span class="md-dirty-badge">${_esc(Util.t('ui.unsaved_badge', { count: _staged.length }))}</span>
         <button class="btn btn-primary sm" id="sec-save-staged">${_esc(Util.t('sec.save_changes'))}</button>`
      : '';
    document.getElementById('sec-save-staged')?.addEventListener('click', _saveStaged);
  }

  // extraAttrs is a caller-built, already-escaped attribute string (id="..." or data-x="...").
  function _roleSelectHtml(value: string, extraAttrs: string): string {
    const opts = [`<option value=""${!value ? ' selected' : ''}>${_esc(Util.t('ui.select_placeholder'))}</option>`]
      .concat(_roleOptions.map((r) => `<option value="${_esc(r)}"${r === value ? ' selected' : ''}>${_esc(r)}</option>`))
      .join('');
    return `<select class="input" ${extraAttrs}>${opts}</select>`;
  }

  function _userRowHtml(u: SecurityUser): string {
    const pwOpen = _pwOpen.has(u.username);
    const pwCell = pwOpen
      ? `<div style="display:flex;gap:6px;align-items:center">
           <input type="password" class="input" data-pw-input="${_esc(u.username)}" placeholder="${_esc(Util.t('sec.new_password_ph'))}" autocomplete="new-password" style="width:140px">
           <button class="btn btn-primary sm" data-pw-save="${_esc(u.username)}">${_esc(Util.t('sec.save_password'))}</button>
           <button class="btn btn-ghost sm" data-pw-cancel="${_esc(u.username)}">${_esc(Util.t('btn.cancel'))}</button>
         </div>`
      : `<div style="display:flex;gap:8px;align-items:center">
           <span class="admin-health-dot ${u.has_password ? 'ok' : 'warn'}"></span>
           <span>${_esc(u.has_password ? Util.t('sec.password_set') : Util.t('sec.password_not_set'))}</span>
           <button class="btn btn-ghost sm" data-pw-toggle="${_esc(u.username)}">${_esc(u.has_password ? Util.t('sec.reset_password') : Util.t('sec.set_password'))}</button>
         </div>`;
    return `<tr data-username="${_esc(u.username)}">
      <td class="md-td">${_esc(u.username)}</td>
      <td class="md-td"><input type="text" class="input" data-first-name-user="${_esc(u.username)}" value="${_esc(u.first_name || '')}" maxlength="100"></td>
      <td class="md-td"><input type="text" class="input" data-last-name-user="${_esc(u.username)}" value="${_esc(u.last_name || '')}" maxlength="100"></td>
      <td class="md-td">${_roleSelectHtml(u.role || '', `data-role-select-user="${_esc(u.username)}"`)}</td>
      <td class="md-td">${pwCell}</td>
      <td class="md-td">${_esc(u.last_login ? new Date(u.last_login).toLocaleString() : Util.t('sec.never'))}</td>
      <td class="md-td md-td-action"><button class="icon-btn md-del-btn" data-del-user="${_esc(u.username)}" title="${_esc(Util.t('tip.delete_row'))}">🗑</button></td>
    </tr>`;
  }

  function _stagedRowHtml(r: SecurityStagedUser, i: number): string {
    return `<tr class="md-row-new">
      <td class="md-td">${_esc(r.username)}</td>
      <td class="md-td"><input type="text" class="input" data-first-name-staged="${i}" value="${_esc(r.first_name || '')}" maxlength="100"></td>
      <td class="md-td"><input type="text" class="input" data-last-name-staged="${i}" value="${_esc(r.last_name || '')}" maxlength="100"></td>
      <td class="md-td">${_roleSelectHtml(r.role, `data-role-select-staged="${i}"`)}</td>
      <td class="md-td">${_esc(Util.t('sec.password_not_set'))}</td>
      <td class="md-td">—</td>
      <td class="md-td md-td-action"><button class="icon-btn md-del-btn" data-del-staged="${i}" title="${_esc(Util.t('tip.delete_row'))}">🗑</button></td>
    </tr>`;
  }

  function _renderUsersRows(): void {
    const tbody = document.getElementById('sec-users-tbody');
    if (!tbody) return;
    if (!_users.length && !_staged.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="md-empty">${_esc(Util.t('sec.no_users_yet'))}</td></tr>`;
    } else {
      tbody.innerHTML = _users.map(_userRowHtml).join('') + _staged.map(_stagedRowHtml).join('');
    }
    tbody.querySelectorAll<HTMLSelectElement>('[data-role-select-user]').forEach((sel) =>
      sel.addEventListener('change', () => _setUserRole(sel.dataset.roleSelectUser as string, sel.value)));
    tbody.querySelectorAll<HTMLSelectElement>('[data-role-select-staged]').forEach((sel) =>
      sel.addEventListener('change', () => { _staged[Number(sel.dataset.roleSelectStaged)].role = sel.value; }));
    tbody.querySelectorAll<HTMLInputElement>('[data-first-name-user]').forEach((inp) =>
      inp.addEventListener('blur', () => _scheduleSetUserName(inp.dataset.firstNameUser as string)));
    tbody.querySelectorAll<HTMLInputElement>('[data-last-name-user]').forEach((inp) =>
      inp.addEventListener('blur', () => _scheduleSetUserName(inp.dataset.lastNameUser as string)));
    tbody.querySelectorAll<HTMLInputElement>('[data-first-name-staged]').forEach((inp) =>
      inp.addEventListener('blur', () => { _staged[Number(inp.dataset.firstNameStaged)].first_name = inp.value; }));
    tbody.querySelectorAll<HTMLInputElement>('[data-last-name-staged]').forEach((inp) =>
      inp.addEventListener('blur', () => { _staged[Number(inp.dataset.lastNameStaged)].last_name = inp.value; }));
    tbody.querySelectorAll<HTMLElement>('[data-pw-toggle]').forEach((b) =>
      b.addEventListener('click', () => { _pwOpen.add(b.dataset.pwToggle as string); _renderUsersRows(); }));
    tbody.querySelectorAll<HTMLElement>('[data-pw-cancel]').forEach((b) =>
      b.addEventListener('click', () => { _pwOpen.delete(b.dataset.pwCancel as string); _renderUsersRows(); }));
    tbody.querySelectorAll<HTMLElement>('[data-pw-save]').forEach((b) =>
      b.addEventListener('click', () => _savePassword(b.dataset.pwSave as string)));
    tbody.querySelectorAll<HTMLElement>('[data-del-user]').forEach((b) =>
      b.addEventListener('click', () => _deleteUser(b.dataset.delUser as string)));
    tbody.querySelectorAll<HTMLElement>('[data-del-staged]').forEach((b) =>
      b.addEventListener('click', () => { _staged.splice(Number(b.dataset.delStaged), 1); _renderUsersRows(); _renderUsersActions(); }));
  }

  async function _setUserRole(username: string, role: string): Promise<void> {
    try {
      await _postJSON(`${API}/security/users/bulk`, { upserts: [{ username, role: role || null }] });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Set role failed for ${username}: ${(e as Error).message}`);
    }
    await _reloadUsers();
  }

  // Debounced by username so tabbing from First Name straight into Last Name
  // in the same row coalesces into one save (reading both fields' live
  // values) instead of firing mid-edit and losing the second field's
  // keystrokes to the unconditional reload/re-render below.
  function _scheduleSetUserName(username: string): void {
    clearTimeout(_nameSaveTimers.get(username));
    _nameSaveTimers.set(username, setTimeout(() => {
      _nameSaveTimers.delete(username);
      _setUserName(username);
    }, 200));
  }

  async function _setUserName(username: string): Promise<void> {
    const row = document.querySelector(`tr[data-username="${CSS.escape(username)}"]`);
    if (!row) return;
    const roleSelect = row.querySelector('[data-role-select-user]') as HTMLSelectElement | null;
    const firstInput = row.querySelector('[data-first-name-user]') as HTMLInputElement | null;
    const lastInput = row.querySelector('[data-last-name-user]') as HTMLInputElement | null;
    try {
      await _postJSON(`${API}/security/users/bulk`, {
        upserts: [{
          username,
          role: roleSelect ? (roleSelect.value || null) : null,
          first_name: firstInput ? firstInput.value.trim() : '',
          last_name: lastInput ? lastInput.value.trim() : '',
        }],
      });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Set name failed for ${username}: ${(e as Error).message}`);
    }
    await _reloadUsers();
  }

  async function _savePassword(username: string): Promise<void> {
    const input = document.querySelector(`[data-pw-input="${CSS.escape(username)}"]`) as HTMLInputElement | null;
    const pw = input ? input.value : '';
    if (!pw || pw.length < 4) { Toast.show(Util.t('sec.password_too_short'), 'error'); return; }
    try {
      await _postJSON(`${API}/security/users/${encodeURIComponent(username)}/reset-password`, { password: pw });
      _pwOpen.delete(username);
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Set password failed for ${username}: ${(e as Error).message}`);
    }
    await _reloadUsers();
  }

  async function _deleteUser(username: string): Promise<void> {
    const ok = await Modal.confirm({
      title: Util.t('sec.confirm_delete_user_title'),
      message: Util.t('sec.confirm_delete_user_msg', { username }),
      confirmLabel: Util.t('btn.yes_delete'),
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await _postJSON(`${API}/security/users/bulk`, { deletes: [{ username }] });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Delete user failed for ${username}: ${(e as Error).message}`);
    }
    await _reloadUsers();
  }

  async function _addUser(): Promise<void> {
    const uInput = document.getElementById('sec-new-username') as HTMLInputElement | null;
    const fInput = document.getElementById('sec-new-firstname') as HTMLInputElement | null;
    const lInput = document.getElementById('sec-new-lastname') as HTMLInputElement | null;
    const rSelect = document.getElementById('sec-new-role-select') as HTMLSelectElement | null;
    const pInput = document.getElementById('sec-new-password') as HTMLInputElement | null;
    const username = (uInput?.value || '').trim();
    if (!username) { Toast.show(Util.t('sec.username_required'), 'error'); return; }
    const password = pInput?.value || '';
    if (password && password.length < 4) { Toast.show(Util.t('sec.password_too_short'), 'error'); return; }
    const role = rSelect?.value || null;
    const first_name = (fInput?.value || '').trim();
    const last_name = (lInput?.value || '').trim();
    try {
      await _postJSON(`${API}/security/users/bulk`, { upserts: [{ username, role, first_name, last_name }] });
      if (password) await _postJSON(`${API}/security/users/${encodeURIComponent(username)}/reset-password`, { password });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Add user failed: ${(e as Error).message}`);
    }
    await _reloadUsers();
  }

  // Mirrors MasterData._parsePaste's header-detection idiom, scoped to a fixed
  // username/role 2-column shape (no password column — passwords are never pasted).
  function _parseUserPaste(rawText: string): (SecurityPastedRow & { username: string })[] {
    const lines = rawText.replace(/\r/g, '').split('\n').filter((l) => l.trim());
    if (!lines.length) return [];
    const first = lines[0].split('\t').map((h) => h.trim().toLowerCase());
    const nameHdrs = ['username', Util.t('sec.username').toLowerCase()];
    const roleHdrs = ['role', Util.t('sec.role').toLowerCase()];
    const firstNameHdrs = ['first name', 'firstname', Util.t('sec.first_name').toLowerCase()];
    const lastNameHdrs = ['last name', 'lastname', Util.t('sec.last_name').toLowerCase()];
    const hasHeader = first.some((h) =>
      nameHdrs.includes(h) || roleHdrs.includes(h) || firstNameHdrs.includes(h) || lastNameHdrs.includes(h));
    let headers: string[], dataLines: string[];
    if (hasHeader) {
      headers = first.map((h) => {
        if (nameHdrs.includes(h)) return 'username';
        if (roleHdrs.includes(h)) return 'role';
        if (firstNameHdrs.includes(h)) return 'first_name';
        if (lastNameHdrs.includes(h)) return 'last_name';
        return h;
      });
      dataLines = lines.slice(1);
    } else {
      headers = ['username', 'role'];
      dataLines = lines;
    }
    return dataLines.map((line) => {
      const vals = line.split('\t');
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = (vals[i] ?? '').trim(); });
      return row as SecurityPastedRow;
      // Single cast (not the prior `as unknown as`): every field on
      // SecurityPastedRow is optional, so a plain Record<string,string>'s
      // index signature genuinely does overlap it — no bridge through
      // `unknown` needed. `username`'s presence is proven below, not here.
    }).filter((r): r is SecurityPastedRow & { username: string } => Boolean(r.username));
  }

  async function _pasteUsers(): Promise<void> {
    let raw: string;
    try { raw = await navigator.clipboard.readText(); }
    catch { Toast.show(Util.t('toast.clipboard_denied'), 'error'); return; }
    if (!raw.trim()) { Toast.show(Util.t('toast.clipboard_empty'), 'error'); return; }
    const rows = _parseUserPaste(raw);
    if (!rows.length) { Toast.show(Util.t('toast.no_rows_paste'), 'error'); return; }
    rows.forEach((r) => _staged.push({
      username: r.username, role: r.role || '',
      first_name: r.first_name || '', last_name: r.last_name || '',
    }));
    _renderUsersRows();
    _renderUsersActions();
  }

  async function _saveStaged(): Promise<void> {
    if (!_staged.length) return;
    const upserts: SecurityUserUpsert[] = _staged.map((r) => ({
      username: r.username, role: r.role || null,
      first_name: r.first_name || '', last_name: r.last_name || '',
    }));
    try {
      await _postJSON(`${API}/security/users/bulk`, { upserts });
      _staged = [];
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Save staged users failed: ${(e as Error).message}`);
    }
    await _reloadUsers();
  }

  // -----------------------------------------------------------------------
  // ROLES tab — master-detail: role list (left) + its plant assignments (right)
  // -----------------------------------------------------------------------
  async function _reloadRoles(): Promise<void> {
    const body = document.getElementById('security-tabbody');
    try {
      const [rolesData, rpData]: [SecurityMasterDataResponse<SecurityRoleRow>, SecurityMasterDataResponse<SecurityRolePlantRow>] = await Promise.all([
        Util.fetchTraced(`${API}/master-data/roles`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
        Util.fetchTraced(`${API}/master-data/role_plants`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
      ]);
      _roles = rolesData.rows || [];
      _rolePlants = rpData.rows || [];
      if (_selectedRole && !_roles.some((r) => r.role === _selectedRole)) _selectedRole = null;
      // Best-effort: knowing which roles have >=1 user lets the delete button be
      // disabled pre-emptively. Non-fatal if this fetch fails — bulk_apply's FK
      // hardening (ForeignKeyViolation -> clean 400) remains the authoritative guard.
      try {
        const usersData: SecurityUsersResponse = await Util.fetchTraced(`${API}/security/users`).then((r) => { if (!r.ok) throw new Error(); return r.json(); });
        _rolesInUse = new Set((usersData.users || []).map((u) => u.role).filter((r): r is string => Boolean(r)));
      } catch { _rolesInUse = new Set(); }
      if (_tab !== 'roles') return; // bail if the admin switched tabs while awaiting
      _renderRolesTab();
    } catch (e) {
      if (body) body.innerHTML = `<div class="md-empty">Failed to load roles: ${_esc((e as Error).message)}</div>`;
      ErrorLog.error('security', `Load roles failed: ${(e as Error).message}`);
    }
  }

  function _renderRolesTab(): void {
    const body = document.getElementById('security-tabbody');
    if (!body) return;
    body.innerHTML = `<div class="sap-console"><div id="sec-roles-rail"></div><div id="sec-roles-detail"></div></div>`;
    _renderRolesRail();
    _renderRolesDetail();
  }

  function _roleRowHtml(r: SecurityRoleRow): string {
    const sel = r.role === _selectedRole ? ' sap-rail-row-sel' : '';
    const inUse = _rolesInUse.has(r.role);
    const delAttrs = inUse
      ? `disabled title="${_esc(Util.t('sec.role_in_use'))}"`
      : `title="${_esc(Util.t('tip.delete_row'))}"`;
    return `<div class="sap-rail-row${sel}" style="display:flex;align-items:center;gap:8px" data-role="${_esc(r.role)}">
      <div style="flex:1;min-width:0">
        <div class="sap-rail-name" style="cursor:pointer" data-role-select="${_esc(r.role)}">${_esc(r.role)}</div>
        <input type="text" class="input" data-role-desc="${_esc(r.role)}" value="${_esc(r.description || '')}"
          title="${_esc(Util.t('sec.description'))}" placeholder="${_esc(Util.t('sec.description_ph'))}"
          style="margin-top:4px;width:100%;font-size:11.5px;padding:3px 6px">
      </div>
      <button class="btn btn-ghost sm" data-role-desc-save="${_esc(r.role)}">${_esc(Util.t('btn.save'))}</button>
      <button class="sap-icon-btn danger" data-role-del="${_esc(r.role)}" ${delAttrs}>🗑</button>
    </div>`;
  }

  function _renderRolesRail(): void {
    const el = document.getElementById('sec-roles-rail');
    if (!el) return;
    const rows = !_roles.length
      ? `<div class="md-empty">${_esc(Util.t('sec.no_roles_yet'))}</div>`
      : _roles.map(_roleRowHtml).join('');
    el.innerHTML = `<div class="panel">
      <div class="panel-head"><span class="sap-section-label">${_esc(Util.t('tab.security_roles'))}</span></div>
      <div style="display:flex;gap:8px;padding:12px;border-bottom:1px solid var(--line);flex-wrap:wrap">
        <input type="text" class="input" id="sec-new-role" placeholder="${_esc(Util.t('sec.role'))}" style="flex:1;min-width:90px">
        <input type="text" class="input" id="sec-new-role-desc" placeholder="${_esc(Util.t('sec.description_ph'))}" style="flex:1.6;min-width:110px">
        <button class="btn btn-primary sm" id="sec-add-role-btn">${_esc(Util.t('sec.add_role'))}</button>
      </div>
      <div class="sap-rail" id="sec-roles-list">${rows}</div>
    </div>`;
    document.getElementById('sec-add-role-btn')?.addEventListener('click', _addRole);
    el.querySelectorAll<HTMLElement>('[data-role-select]').forEach((nameEl) =>
      nameEl.addEventListener('click', () => _selectRole(nameEl.dataset.roleSelect as string)));
    el.querySelectorAll<HTMLElement>('[data-role-desc-save]').forEach((b) =>
      b.addEventListener('click', () => _saveRoleDescription(b.dataset.roleDescSave as string)));
    el.querySelectorAll<HTMLElement>('[data-role-del]').forEach((b) =>
      b.addEventListener('click', () => _deleteRole(b.dataset.roleDel as string)));
  }

  function _selectRole(role: string): void {
    _selectedRole = role;
    // Local-only: toggle the selected highlight instead of rebuilding the rail,
    // so an in-progress "add role" draft elsewhere in the rail isn't wiped.
    document.querySelectorAll<HTMLElement>('#sec-roles-list .sap-rail-row').forEach((el) =>
      el.classList.toggle('sap-rail-row-sel', el.dataset.role === role));
    _renderRolesDetail();
  }

  // Nav order + labels for the Page Access toggles — mirrors App._firstAccessibleTab's
  // order (application-shell.mts) and Session.DEFAULT_PAGE_ACCESS's key set
  // (schedule-data.mts); keep all three, plus master_data.py's PAGE_ACCESS_KEYS, in sync.
  function _pageAccessDefs(): Array<[TopLevelTab, string]> {
    return [
      ['home',       Util.t('tab.home')],
      ['gantt',      Util.t('tab.gantt')],
      ['labor',      Util.t('us.tab_labor')],
      ['masterdata', Util.t('tab.masterdata')],
      ['admin',      Util.t('tab.admin')],
    ];
  }

  // Default when a role hasn't customized a given page yet: everything on
  // except Admin Cockpit — except for the 'admin' role itself, which defaults
  // to Admin Cockpit on too (Session.canAccessTab never even reaches this
  // default for real admin users, since it short-circuits on isAdmin(), but
  // the Roles tab shows explicit per-role state so 'admin' needs it directly).
  function _defaultPageAccess(role: string): Record<TopLevelTab, boolean> {
    return { home: true, gantt: true, labor: true, masterdata: true, admin: role === 'admin' };
  }

  function _pageAccessRowHtml(role: string, tab: TopLevelTab, label: string, roleRow: SecurityRoleRow | undefined): string {
    const defaults = _defaultPageAccess(role);
    const checked = roleRow?.pages?.[tab] ?? defaults[tab];
    const locked = role === 'admin' && tab === 'admin';
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
      <span style="font-size:13px">${_esc(label)}</span>
      <label class="cal-day-toggle-wrap" style="${locked ? 'cursor:default' : ''}"
          title="${locked ? _esc(Util.t('sec.admin_page_locked')) : ''}">
        <input type="checkbox" data-page-toggle="${_esc(tab)}" ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''}>
        <span class="cal-toggle-track"></span><span class="cal-toggle-thumb"></span>
      </label>
    </div>`;
  }

  function _renderRolesDetail(): void {
    const el = document.getElementById('sec-roles-detail');
    if (!el) return;
    const role = _selectedRole;
    const roleRow = role ? _roles.find((r) => r.role === role) : undefined;
    const header = role ? Util.t('sec.plants_for_role', { role }) : Util.t('sec.no_role_selected');
    const plants = role ? _rolePlants.filter((rp) => rp.role === role).map((rp) => rp.plant).sort() : [];
    const addHtml = !role ? '' : `
      <div class="sap-section-label">${_esc(Util.t('sec.add_plant'))}</div>
      <div class="hps-combobox" id="sec-plant-combobox" style="max-width:280px">
        <input type="text" class="input" id="sec-plant-search" placeholder="${_esc(Util.t('sec.search_plants_ph'))}" autocomplete="off">
        <div class="hps-dropdown" id="sec-plant-dropdown" hidden></div>
      </div>`;
    const listHtml = !role ? '' : !plants.length
      ? `<div class="sap-help" style="margin-top:12px">${_esc(Util.t('sec.no_plants_yet'))}</div>`
      : `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:12px">${plants.map((p) =>
          `<span class="sap-keychip">${_esc(p)}<button data-remove-plant="${_esc(p)}" title="${_esc(Util.t('tip.delete_row'))}"
             style="border:none;background:transparent;cursor:pointer;color:var(--fg-mute);font-size:12px;line-height:1;padding:0;margin-left:2px">✕</button></span>`
        ).join('')}</div>`;
    const pageAccessHtml = !role ? '' : `
      <div class="sap-section-label" style="margin-top:20px">${_esc(Util.t('sec.page_access'))}</div>
      <div class="sap-help" style="margin:2px 0 8px">${_esc(Util.t('sec.page_access_sub'))}</div>
      <div id="sec-role-pages" style="display:flex;flex-direction:column;gap:8px">
        ${_pageAccessDefs().map(([tab, label]) => _pageAccessRowHtml(role, tab, label, roleRow)).join('')}
      </div>`;
    el.innerHTML = `<div class="panel">
      <div class="sap-detail-head"><span class="sap-detail-name">${_esc(header)}</span></div>
      <div class="panel-body">${addHtml}${listHtml}${pageAccessHtml}</div>
    </div>`;
    if (role) {
      const srch = document.getElementById('sec-plant-search') as HTMLInputElement | null;
      srch?.addEventListener('focus', () => { _renderPlantDropdown(srch.value); (document.getElementById('sec-plant-dropdown') as HTMLElement).hidden = false; });
      srch?.addEventListener('input', () => { _renderPlantDropdown(srch.value); (document.getElementById('sec-plant-dropdown') as HTMLElement).hidden = false; });
      srch?.addEventListener('blur', () => { setTimeout(() => { const dd = document.getElementById('sec-plant-dropdown'); if (dd) dd.hidden = true; }, 150); });
    }
    el.querySelectorAll<HTMLElement>('[data-remove-plant]').forEach((b) =>
      b.addEventListener('click', () => _removePlantFromRole(b.dataset.removePlant as string)));
    el.querySelectorAll<HTMLInputElement>('[data-page-toggle]').forEach((cb) =>
      cb.addEventListener('change', () => _setRolePageAccess(cb.dataset.pageToggle as TopLevelTab, cb.checked)));
  }

  // Type-to-filter Store.knownPlants() down to matches, click one to add it —
  // NIMBUS's plant lists must never be a plain <select> at 50+ plant scale (see
  // CLAUDE.md); mirrors the PlantSelector/OptimizeDialog filterPlants pattern.
  function _renderPlantDropdown(query: string): void {
    const dd = document.getElementById('sec-plant-dropdown');
    if (!dd || !_selectedRole) return;
    const assigned = new Set(_rolePlants.filter((rp) => rp.role === _selectedRole).map((rp) => rp.plant));
    const all = Store.knownPlants().filter((p) => !assigned.has(p));
    const q = (query || '').trim().toLowerCase();
    const filtered = q ? all.filter((p) => p.toLowerCase().includes(q)) : all;
    if (!filtered.length) {
      dd.innerHTML = `<div class="hps-empty">${all.length ? 'No matches' : 'No plants available'}</div>`;
      return;
    }
    dd.innerHTML = filtered.map((p) => `<div class="hps-option" data-plant="${_esc(p)}">${_esc(p)}</div>`).join('');
    dd.querySelectorAll<HTMLElement>('[data-plant]').forEach((optEl) =>
      optEl.addEventListener('mousedown', (e) => { e.preventDefault(); _addPlantToRole(optEl.dataset.plant as string); }));
  }

  async function _addPlantToRole(plant: string): Promise<void> {
    if (!_selectedRole) return;
    try {
      await _postJSON(`${API}/master-data/role_plants/bulk`, { upserts: [{ role: _selectedRole, plant }] });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Add plant to role failed: ${(e as Error).message}`);
    }
    await _reloadRoles();
  }

  async function _removePlantFromRole(plant: string): Promise<void> {
    if (!_selectedRole) return;
    try {
      await _postJSON(`${API}/master-data/role_plants/bulk`, { deletes: [{ role: _selectedRole, plant }] });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Remove plant from role failed: ${(e as Error).message}`);
    }
    await _reloadRoles();
  }

  // Backend rejects role:'admin' + admin:false outright (server-side backstop
  // for the checkbox's own disabled state), so this can only ever persist a
  // legal combination. Full-page reload isn't needed — patch the in-memory
  // role row on success (same "commit only once confirmed" posture as
  // Plant's constraint toggles) and repaint either way, so a failure visibly
  // reverts the checkbox to the last-confirmed state.
  async function _setRolePageAccess(tab: TopLevelTab, checked: boolean): Promise<void> {
    const role = _selectedRole;
    if (!role) return;
    const roleRow = _roles.find((r) => r.role === role);
    const pages: Partial<Record<TopLevelTab, boolean>> = { ..._defaultPageAccess(role), ...(roleRow?.pages || {}), [tab]: checked };
    try {
      const r = await fetch(`${API}/master-data/roles/${encodeURIComponent(role)}/page-access`, {
        method:  'POST',
        headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
        body:    JSON.stringify({ pages }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || `HTTP ${r.status}`); }
      const result: { pages?: Partial<Record<TopLevelTab, boolean>> } = await r.json();
      if (roleRow) roleRow.pages = result.pages ?? pages;
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Save role page access failed: ${(e as Error).message}`);
    }
    _renderRolesDetail();
  }

  async function _addRole(): Promise<void> {
    const nameInput = document.getElementById('sec-new-role') as HTMLInputElement | null;
    const descInput = document.getElementById('sec-new-role-desc') as HTMLInputElement | null;
    const role = (nameInput?.value || '').trim();
    if (!role) return;
    try {
      await _postJSON(`${API}/master-data/roles/bulk`, { upserts: [{ role, description: (descInput?.value || '').trim() }] });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Add role failed: ${(e as Error).message}`);
    }
    await _reloadRoles();
  }

  async function _saveRoleDescription(role: string): Promise<void> {
    const input = document.querySelector(`[data-role-desc="${CSS.escape(role)}"]`) as HTMLInputElement | null;
    if (!input) return;
    try {
      await _postJSON(`${API}/master-data/roles/bulk`, { upserts: [{ role, description: input.value }] });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Save role description failed: ${(e as Error).message}`);
    }
    await _reloadRoles();
  }

  async function _deleteRole(role: string): Promise<void> {
    const ok = await Modal.confirm({
      title: Util.t('sec.confirm_delete_role_title'),
      message: Util.t('sec.confirm_delete_role_msg', { role }),
      confirmLabel: Util.t('btn.yes_delete'),
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await _postJSON(`${API}/master-data/roles/bulk`, { deletes: [{ role }] });
      if (_selectedRole === role) _selectedRole = null;
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Delete role failed: ${(e as Error).message}`);
    }
    await _reloadRoles();
  }

  return { render };
})();
