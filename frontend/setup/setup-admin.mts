// setup/setup-admin.mjs — Setup (changeover) matrix admin console.
// Extracted verbatim from plant-and-administration.mts (Phase P2 of
// docs/architecture/domain-refactor-plan.md, which split that 11,308-line
// mega-module into 9 domain files). Plant-scoped administration for Stage 0
// setup truth. It deliberately does not start the optimizer or alter task
// placement: this surface is a versioned observation and maintenance
// console only.
import { Config, Util, ErrorLog, Toast, Modal, PerfMonitor } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import { Session } from '../security/session.mjs';
import { Persistence } from '../scheduling/persistence.mjs';
import type { SetupDefinition, SetupMatrixRow, SetupSnapshot, LineSetupState, SetupStateKey, PriorityRankMaps } from '../platform/types.mjs';
// `Plant.gotoTab` is called from `reviewMissingPairs` below (the missing-setup
// review handoff navigates to Master Data > Plant > Settings). This creates a
// two-way module dependency with master-data/admin-ui.mjs (which itself calls
// `SetupAdmin.render` from `Plant`) — an intrinsic mutual reference carried
// over unchanged from the original single-file module, not a new coupling
// introduced by this split. It resolves safely at runtime: neither module
// touches the other's binding during its own top-level evaluation, only
// inside methods invoked later, after both modules have finished
// initializing (a "lazy" ESM cycle).
import { Plant } from '../master-data/admin-ui.mjs';

/** Minimal self-contained searchable combobox, duplicated verbatim from
 *  master-data/admin-ui.mjs's own copy of the same helper (there named
 *  `_mkCombobox`/`ComboboxOpts`) rather than imported, to avoid adding a
 *  second, purely-cosmetic edge onto the already-necessary `Plant` cycle
 *  above. Used only by the setup Scope combobox below. Keep any change to
 *  this helper mirrored in master-data/admin-ui.mjs's copy. */
interface ComboboxOpts {
  value?: string;
  placeholder?: string;
  onSelect?: (value: string) => void;
}

// D48 (part 2) — one AbortController per LIVE container for _mkCombobox's
// document-level click listener, keyed by the container element — a single
// shared module-level controller is wrong whenever two comboboxes are
// mounted at once (e.g. master-data/admin-ui.mts's BOM plant/material
// pickers and plant-settings line-override pickers): rendering the second
// would abort the first's still-live listener. Re-rendering into the SAME
// container still aborts that container's own previous listener, via the
// WeakMap lookup (mirrored from distribution/distribution-pane.mts's copy —
// keep in sync with that file and master-data/admin-ui.mts's copy).
const _comboAborts = new WeakMap<HTMLElement, AbortController>();

function _mkCombobox(containerEl: HTMLElement | null, options: string[], { value = '', placeholder = '', onSelect }: ComboboxOpts = {}): void {
  if (!containerEl) return;
  _comboAborts.get(containerEl)?.abort();
  const _comboAbort = new AbortController();
  _comboAborts.set(containerEl, _comboAbort);
  containerEl.innerHTML = `
    <div class="hps-combobox md-bom-combobox">
      <input type="text" class="hps-input" placeholder="${Util.escapeHtml(placeholder)}" autocomplete="off" spellcheck="false"
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
      `<div class="hps-option${o === selected ? ' selected' : ''}" role="option" data-idx="${i}">${Util.escapeHtml(o)}</div>`
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
  document.addEventListener('click', (e) => { if (!root.contains(e.target as Node)) closeDd(); }, { signal: _comboAbort.signal });

  reflect();
}

type SetupPermissions = { read: boolean; copy: boolean; export: boolean; definitionWrite: boolean; matrixWrite: boolean; stateWrite: boolean };
type EffectiveSetupRow = SetupMatrixRow & { inherited: boolean; inheritedFromPlant: boolean };
type MissingSetupReviewPair = { line: string; predecessorOrderId?: string | null; successorOrderId?: string | null; fromState?: string | null; toState?: string | null; reason: string; remedy?: string };
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
type SetupGridEdit = { row: SetupGridState; col: SetupGridState; setup_min: number | null; machine: string };
type SetupGridModel = { fields: string[]; rowStates: SetupGridState[]; colStates: SetupGridState[]; cellLookup: Map<string, Map<string, EffectiveSetupRow>> };

/**
 * Plant-scoped administration for Stage 0 setup truth. It deliberately does
 * not start the optimizer or alter task placement: this surface is a
 * versioned observation and maintenance console only.
 */
export const SetupAdmin = (() => {
  const API = Config.API_BASE;
  const FALLBACK_REGISTERED_FIELDS = ['colorWheel', 'prt01', 'prt02'];
  let _registeredFields = FALLBACK_REGISTERED_FIELDS.slice();
  let _linesByPlant: Record<string, string[]> = {};
  let _compatibilityByLine: Record<string, { setup_compatible: boolean; setup_compatibility_reason: string | null }> = {};
  let _coverageByPlant: Record<string, { observed?: { total_pairs: number; missing_pairs: number }; reachable?: { total_pairs: number; missing_pairs: number } }> = {};
  let _lineScope = '';
  let _missingReview: { plant: string; pairs: MissingSetupReviewPair[] } | null = null;
  // N6b: the missing-setup review chip's per-reason filter — 'all' shows
  // both admitted-at-zero reasons, 'state' narrows to unrecorded line state,
  // 'row' narrows to an absent matrix row. Reset whenever the review is
  // (re)started or cleared.
  let _missingReviewFilter: 'all' | 'state' | 'row' = 'all';
  let _lastTarget: HTMLElement | null = null;
  // Grid state (Setup Standard's from-state x to-state editor). Rebuilt every
  // renderSnapshot() call, same full-repaint model as the rest of this module.
  let _gridModel: SetupGridModel | null = null;
  // Split From/To (docs/archive/Setup_matrix_redesign.md §6) — a single shared filter
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
  // Four-band layout (docs/archive/Setup_matrix_redesign.md §9): the signature editor
  // moved from an always-open panel into a popover behind the band-B chip.
  let _signaturePopoverOpen = false;
  // List/Matrix toggle (Setup_matrix_redesign v2): List is the default because
  // a real signature is ~1,600 states per axis — the cartesian grid is a
  // secondary, opt-in view for spot-checking a narrow slice, not the primary
  // editing surface.
  let _setupView: 'list' | 'matrix' = 'list';
  let _hideEmptyStates = true;
  // `setup_min` is the row's EFFECTIVE value (its own recorded minutes, line
  // override or plant default) and is nullable independently of
  // `plant_value` — a line-scoped override on a pair with no plant default
  // has a real `setup_min` and a null `plant_value`. Anything deciding
  // "does this row have a value?" must read `setup_min`, never `plant_value`.
  let _listRows: Array<{ from_key: SetupStateKey; to_key: SetupStateKey; setup_min: number | null; source: string; inherited: boolean; plant_value: number | null }> = [];
  let _listMeta = { total: 0, offset: 0, limit: 50 };
  // `stagedKey` tracks the `_gridDirty` key this draft row is currently
  // staged under (if any), so an edit that changes which key resolves (or
  // makes the row no longer resolve to "staged") can clean up the *previous*
  // key instead of leaking it — see refreshNewRowStatus.
  let _listNewRows: Array<{ id: number; from: string; to: string; minutes: string; stagedKey: string | null }> = [];
  let _listNextRowId = 1;
  // Workstream D3 (2026-08-20): List-view multi-select for bulk delete, keyed
  // by the same `${fromSig} ${toSig}` string every other List-view map uses.
  // Cleared on every successful delete and whenever the scope (plant/line)
  // changes, so a stale key from a different scope never inflates the
  // "Delete selected (N)" count.
  let _listSelected: Set<string> = new Set();
  // The scope-level "delete all rows" typed-confirmation input's live value
  // (OD-D3a) — reset on scope change and after a successful delete-all.
  let _deleteAllConfirmText = '';
  // Single floating editor that repositions over whichever cell is focused,
  // replacing one live <input> per cell (§7/§9-C.3) — the read-only <td>s
  // this replaces are far cheaper to paint at MAX_AXIS² scale than an <input>
  // per cell was before the axis cap existed.
  let _gridEditor: { row: SetupGridState; col: SetupGridState } | null = null;
  // Context for whichever cell _gridEditor currently points at — refreshed on
  // every openGridEditor() call so the floating editor's keydown/blur
  // listeners (wired once, globally, in ensureGridEditorEl — never per-render)
  // always act on the latest render instead of a stale closure.
  type GridWireCtx = { snapshot: SetupSnapshot; definition: SetupDefinition | null; rows: EffectiveSetupRow[]; permissions: SetupPermissions };
  let _gridEditorCtx: { target: HTMLElement; snapshot: SetupSnapshot; definition: SetupDefinition | null; rows: EffectiveSetupRow[]; permissions: SetupPermissions } | null = null;

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
   *  these four fields, so the signature reads "Color" instead of the
   *  raw `colorWheel` field key — one term for the same underlying registry
   *  instead of two (docs/archive/Setup_matrix_redesign.md §3). Falls back to the
   *  raw key if a field has no translated label. */
  function fieldLabel(fieldKey: string): string {
    const translated = setupText(`constraint.${fieldKey}`, '');
    return translated || fieldKey;
  }
  /** `.empty-state`-styled markup for the grid/pane's empty conditions,
   *  reusing the app's existing empty-state visual language (application-
   *  shell.mts's EmptyState) instead of ad hoc `.setup-help`/`.setup-empty`
   *  text scattered across multiple styles (docs/archive/Setup_matrix_redesign.md
   *  §4-5). Inline markup, not the EmptyState module itself, so this has no
   *  dependency on that module's mount/action wiring. */
  function emptyState(message: string, hint?: string): string {
    return `<div class="empty-state setup-empty-state"><p>${Util.escapeHtml(message)}</p>${hint ? `<p class="setup-empty-state-hint">${Util.escapeHtml(hint)}</p>` : ''}</div>`;
  }

  function permissionsFor({ isAdmin, setupScheduler, plantAllowed }: { isAdmin: boolean; setupScheduler: boolean; plantAllowed: boolean }): SetupPermissions {
    return { read: true, copy: true, export: true, definitionWrite: isAdmin, matrixWrite: isAdmin,
      stateWrite: isAdmin || (setupScheduler && plantAllowed) };
  }

  function canWriteVersion(candidate: number | null | undefined, current: number | null | undefined): boolean {
    return Number.isInteger(candidate) && candidate === current;
  }

  /** The status chip's four-reason logic. The first three reasons
   *  (no-definition / version-mismatch / coverage-pending / coverage-fail)
   *  are about definition READINESS and are untouched by Workstream D2. The
   *  final branch used to read `definition.active`; it now takes
   *  `plantActive` (sourced from SetupSnapshot.plant_active, i.e.
   *  plants.setup_active) as an explicit parameter — the relocated
   *  checkbox's flag, independent of the definition object entirely. The
   *  default keeps every existing caller/test that only exercises the first
   *  three reasons passing unchanged. */
  function activationStatus(definition: SetupDefinition | null, checks: { matrixVersion?: number | null; coveragePass?: boolean }, plantActive: boolean = false): { active: boolean; reason: string } {
    if (!definition) return { active: false, reason: setupText('ui.setup_status_no_definition', 'Create an ordered setup signature before setup-aware optimization can be reviewed.') };
    if (checks.matrixVersion !== definition.signature_version) {
      return { active: false, reason: setupText('ui.setup_status_version_mismatch', 'Activation is disabled: a version-matched matrix is required after a definition change.') };
    }
    if (checks.coveragePass === undefined) return { active: false, reason: setupText('ui.setup_status_coverage_pending', 'Activation is pending: coverage has not been measured yet (Stage 0 observation-only).') };
    if (!checks.coveragePass) return { active: false, reason: setupText('ui.setup_status_coverage_fail', 'Activation is disabled: the reachable coverage pass is required.') };
    return plantActive
      ? { active: true, reason: setupText('ui.setup_status_active_reason', 'Active for approved setup-aware optimization.') }
      : { active: false, reason: setupText('ui.setup_status_ready_review', 'Ready for activation review; Stage 0 remains observation-only.') };
  }

  function effectiveRows({ plantRows, machineRows, machine, version }: { plantRows: SetupMatrixRow[]; machineRows: SetupMatrixRow[]; machine: string; version: number }): EffectiveSetupRow[] {
    const plant = plantRows.filter(row => row.signature_version === version);
    if (!machine) return plant.map(row => ({ ...row, inherited: false, inheritedFromPlant: false }));
    const overrides = machineRows.filter(row => row.machine === machine && row.signature_version === version);
    const byPair = new Map(overrides.map(row => [keyId(row), row]));
    const result = plant.map(row => {
      const override = byPair.get(keyId(row));
      return override
        ? { ...override, inherited: false, inheritedFromPlant: false }
        : { ...row, machine, inherited: true, inheritedFromPlant: true };
    });
    overrides.filter(row => !plant.some(base => keyId(base) === keyId(row))).forEach(row =>
      result.push({ ...row, inherited: false, inheritedFromPlant: false }));
    return result;
  }

  function deleteRequest(row: SetupMatrixRow): { machine: string; signature_version: number; rows: SetupMatrixRow[] } {
    return { machine: row.machine, signature_version: row.signature_version, rows: [row] };
  }

  /** Workstream D3 (2026-08-20) — pure gate for the scope-level "delete all
   *  rows" action (OD-D3a): the user must type the exact plant code before
   *  the button enables. Deliberately whitespace-trimmed (no other slack —
   *  a partial or case-varied match would defeat the point of a typed
   *  confirmation) and false for a blank plant so a not-yet-loaded snapshot
   *  can never accidentally satisfy the gate with an empty typed value. */
  function deleteAllConfirmationMatches(typed: string, plant: string): boolean {
    const expected = String(plant || '').trim();
    return expected.length > 0 && String(typed || '').trim() === expected;
  }

  /** Removes one field from an unsaved signature draft without allowing the
   *  backend-invalid empty signature. Persisted definitions are only changed
   *  by saveDefinition(), so this is deliberately a draft-only operation. */
  function removeSignatureField(fields: readonly string[], index: number): string[] {
    if (fields.length <= 1 || index < 0 || index >= fields.length) return [...fields];
    return fields.filter((_, fieldIndex) => fieldIndex !== index);
  }

  // ── Setup Standard grid: from-state x to-state editor ─────────────────────
  // Replaces the old flat from/to edge-list table. Header axes are the
  // cross-product of each active signature field's known priority-list
  // values (Store.priorityRankMaps) — not bounded to states that already have
  // a matrix row — so a value that exists in a priority list but has never
  // been scheduled yet already has a header and an editable cell. See
  // docs/archive/setup_matrix_ui_redesign.md §3.2 Group 1.

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

  /** The six states a cell must render distinctly (docs/archive/Setup_matrix_redesign.md
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

  /** Bounds the rendered universe per axis (docs/archive/Setup_matrix_redesign.md §6
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
   *  other plant-default row. See docs/archive/setup_matrix_ui_redesign.md §7. */
  type SetupUpsertRow = { from: SetupStateKey; to: SetupStateKey; setup_min: number; source?: string; source_metadata?: Record<string, unknown>; source_reference?: string | null };
  function buildSaveRequests(edits: ReadonlyArray<SetupGridEdit>, signatureVersion: number, existingPlantRows: ReadonlyArray<SetupMatrixRow>, plantMatrixToken?: string): {
    upsert: Array<{ machine: string; signature_version: number; plant_matrix_token?: string; rows: SetupUpsertRow[] }>;
    deletes: Array<{ machine: string; signature_version: number; rows: Array<{ from_key: SetupStateKey; to_key: SetupStateKey }> }>;
  } {
    const byLine = new Map<string, SetupGridEdit[]>();
    edits.forEach(e => { if (!byLine.has(e.machine)) byLine.set(e.machine, []); byLine.get(e.machine)!.push(e); });
    const upsert: Array<{ machine: string; signature_version: number; plant_matrix_token?: string; rows: SetupUpsertRow[] }> = [];
    const deletes: Array<{ machine: string; signature_version: number; rows: Array<{ from_key: SetupStateKey; to_key: SetupStateKey }> }> = [];
    byLine.forEach((lineEdits, machine) => {
      const sets = lineEdits.filter((e): e is SetupGridEdit & { setup_min: number } => e.setup_min !== null);
      const clears = lineEdits.filter(e => e.setup_min === null);
      if (machine) {
        if (sets.length) upsert.push({ machine, signature_version: signatureVersion, rows: sets.map(e => ({ from: e.row.key, to: e.col.key, setup_min: e.setup_min })) });
        if (clears.length) deletes.push({ machine, signature_version: signatureVersion, rows: clears.map(e => ({ from_key: e.row.key, to_key: e.col.key })) });
        return;
      }
      const merged = new Map<string, SetupMatrixRow>();
      existingPlantRows.forEach(row => merged.set(`${stateSig(row.from_key)} ${stateSig(row.to_key)}`, row));
      sets.forEach(e => merged.set(gridEditKey(e.row, e.col), { machine: '', signature_version: signatureVersion, from_key: e.row.key, to_key: e.col.key, setup_min: e.setup_min, source: 'manual' }));
      clears.forEach(e => merged.delete(gridEditKey(e.row, e.col)));
      // The replace is delete-then-insert, so every resent row must carry its
      // stored provenance (source/metadata/reference) or it is silently rewritten
      // as 'manual'; the token lets the server refuse a replace built from a stale read.
      if (sets.length || clears.length) upsert.push({ machine: '', signature_version: signatureVersion, ...(plantMatrixToken ? { plant_matrix_token: plantMatrixToken } : {}), rows: [...merged.values()].map(r => ({ from: r.from_key, to: r.to_key, setup_min: r.setup_min, ...(r.source ? { source: r.source } : {}), ...(r.source_metadata ? { source_metadata: r.source_metadata } : {}), ...(r.source_reference !== undefined ? { source_reference: r.source_reference } : {}) })) });
    });
    return { upsert, deletes };
  }

  function csvColumns(): string[] {
    return ['Plant', 'Line', 'Signature version', 'From setup state', 'To setup state', 'Setup minutes'];
  }

  function missingPairsCsv(plant: string, pairs: ReadonlyArray<MissingSetupReviewPair>): string {
    const quote = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = pairs.slice(0, 12).map(pair => [plant, pair.line, pair.predecessorOrderId, pair.successorOrderId,
      pair.fromState, pair.toState, pair.reason, pair.remedy].map(quote).join(','));
    return ['Plant,Line,Predecessor order,Successor order,From setup state,To setup state,Reason,Remedy', ...rows].join('\n');
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
  async function reviewMissingPairs(plant: string | null, pairs: ReadonlyArray<MissingSetupReviewPair>): Promise<boolean> {
    if (!plant || !canReviewMissingPairs(plant)) return false;
    _missingReview = { plant, pairs: pairs.slice(0, 12).map(pair => ({ ...pair })) };
    _missingReviewFilter = 'all';
    // The review affordance (axis narrowing + missing-cell highlight) lives
    // entirely inside paintGrid, so this flow has to land on the Matrix view
    // regardless of which view was last selected. The List view structurally
    // cannot show a missing pair at all — it renders only rows that exist in
    // setup_matrix, and a missing pair by definition has no row — so honoring
    // a 'list' selection here would show the review chip with nothing
    // filtered or highlighted.
    _setupView = 'matrix';
    const lines = [...new Set(_missingReview.pairs.map(pair => pair.line).filter(Boolean))];
    if (lines.length === 1) _lineScope = lines[0];
    const existingPane = _lastTarget ?? document.getElementById('setup-admin-pane');
    const navigation = reviewNavigation(plant, Store.selectedPlant, !!existingPane && !existingPane.closest('[hidden]'));
    if (navigation.selectPlant) {
      if (!await Persistence.confirmPlantSwitch(plant)) return false;
      Store.setSelectedPlant(plant, 'setup-preview-review');
    }
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
    return [csvColumns(), ...rows.map(row => [plant, row.machine || '', row.signature_version, JSON.stringify(row.from_key), JSON.stringify(row.to_key), row.setup_min])]
      .map(row => row.map(quote).join(',')).join('\r\n');
  }

  function registeredFields(fields: Array<{ field_key: string }> | null | undefined): string[] {
    return (fields || []).map(field => field.field_key).filter(field => field && field !== 'productionVersion');
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

  function parseLongFormCsv(text: string): { plant: string; machine: string; signature_version: number; rows: Array<{ from: SetupStateKey; to: SetupStateKey; setup_min: number }> } {
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
    return { plant, machine: line, signature_version, rows };
  }

  async function loadRegisteredFields(): Promise<void> {
    try { const response = await Util.fetchTraced(`${API}/priority-fields`); if (!response.ok) throw new Error(`HTTP ${response.status}`); const data = await response.json() as { fields?: Array<{ field_key: string }> }; const fields = registeredFields(data.fields); if (fields.length) _registeredFields = fields; }
    catch (error) { ErrorLog.warn('setup-admin', `Priority-field registry unavailable: ${(error as Error).message}`); }
  }

  async function collectPagedLines(loadPage: (offset: number, limit: number) => Promise<{ rows?: Array<{ machine: string }>; meta?: { total?: number } }>, pageSize = 100): Promise<string[]> {
    const lines: string[] = []; let offset = 0; let total = Number.POSITIVE_INFINITY;
    // Each request stays bounded. The server's filtered total controls
    // continuation; an empty page is a defensive escape from a stale total.
    while (offset < total) {
      const page = await loadPage(offset, pageSize);
      const rows = page.rows || [];
      lines.push(...rows.map(row => row.machine).filter(Boolean));
      total = Number.isFinite(page.meta?.total) ? Math.max(0, Number(page.meta?.total)) : offset + rows.length;
      offset += rows.length;
      if (!rows.length) break;
    }
    return [...new Set(lines)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  async function loadScopeLines(plant: string): Promise<void> {
    if (_linesByPlant[plant]) return;
    try { _linesByPlant[plant] = await collectPagedLines(async (offset, limit) => { const response = await Util.fetchTraced(`${API}/master-data/machine?plant=${encodeURIComponent(plant)}&limit=${limit}&offset=${offset}`); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<{ rows?: Array<{ machine: string }>; meta?: { total?: number } }>; }); }
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

  /** Fetches one page of the List view's flattened matrix rows from the
   *  Task 1 endpoint, replacing `_listRows`/`_listMeta` in place. On failure
   *  it clears both rather than leaving a stale page on screen — the caller
   *  paints the current (possibly now-empty) state either way. `machine`
   *  is passed explicitly (not read off module-private `_lineScope`
   *  directly) so this network-calling function stays unit-testable the
   *  same way `collectAllScopeRows` is. */
  async function fetchListRows(plant: string, definition: SetupDefinition, fromKey: SetupStateKey | null, machine: string): Promise<void> {
    const params = new URLSearchParams({ machine, offset: String(_listMeta.offset), limit: String(_listMeta.limit) });
    if (fromKey) params.set('from_key', JSON.stringify(fromKey));
    try {
      const response = await Util.fetchTraced(`${API}/setup/${encodeURIComponent(plant)}/matrix-rows?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { rows: typeof _listRows; meta: typeof _listMeta };
      _listRows = data.rows;
      _listMeta = data.meta;
    } catch (error) {
      ErrorLog.warn('setup-admin', `Setup matrix rows unavailable: ${(error as Error).message}`);
      _listRows = []; _listMeta = { ..._listMeta, total: 0 };
    }
  }

  /** Workstream D3 (2026-08-20). DELETE /setup/{plant}/matrix validates each
   *  row's `setup_min` exactly like an import row would (a finite integer is
   *  required even though only from_key/to_key drive the actual delete) —
   *  `?? 0` supplies a harmless filler for an inherited/gap row that has no
   *  real recorded value of its own. */
  function deleteRowPayload(row: Pick<typeof _listRows[number], 'from_key' | 'to_key' | 'setup_min'>): { from_key: SetupStateKey; to_key: SetupStateKey; setup_min: number } {
    return { from_key: row.from_key, to_key: row.to_key, setup_min: row.setup_min ?? 0 };
  }

  /** Issues one or more DELETE /setup/{plant}/matrix calls (chunked so a
   *  large "delete all" never sends an oversized body or holds one
   *  long-running transaction), then refreshes exactly like every other
   *  write in this module (writeAndRefresh's pattern, inlined here because
   *  the request itself is 1..N calls rather than writeAndRefresh's one).
   *  `auditScope` is threaded into the request body as a same-shape
   *  passenger field so the backend's admin-audit log can distinguish a
   *  single-row delete from a bulk/delete-all wipe without brittle
   *  row-count heuristics — see brain.py's delete_setup_matrix_rows. */
  async function deleteMatrixRows(
    target: HTMLElement, snapshot: SetupSnapshot, definition: SetupDefinition, permissions: SetupPermissions,
    rows: ReadonlyArray<Pick<typeof _listRows[number], 'from_key' | 'to_key' | 'setup_min'>>,
    auditScope: 'row' | 'bulk' | 'all',
  ): Promise<void> {
    if (!permissions.matrixWrite || !rows.length) return;
    const machine = _lineScope;
    const CHUNK = 500;
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK).map(deleteRowPayload);
        const response = await Util.fetchTraced(`${API}/setup/${encodeURIComponent(snapshot.plant)}/matrix`, {
          method: 'DELETE', headers: headers(),
          body: JSON.stringify({ machine, signature_version: definition.signature_version, rows: chunk, scope: auditScope }),
        });
        if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(Util.errorDetailText(err.detail) || `HTTP ${response.status}`); }
      }
      Persistence.noteSetupWrite(snapshot.plant, 'matrix');
      _listSelected.clear();
      _deleteAllConfirmText = '';
      await Persistence.loadSetupSnapshot(snapshot.plant);
      Toast.show(Util.t('toast.setup_matrix_rows_deleted', { count: rows.length }), 'success');
      render(target, snapshot.plant);
    } catch (error) {
      Toast.show(Util.t('toast.save_failed', { msg: (error as Error).message }), 'error');
    }
  }

  /** Pages through the from-state-scoped matrix-rows endpoint (never a full
   *  plant snapshot — see CLAUDE.md's O(states²) constraint) to gather every
   *  REAL row in the current scope for the "delete all" action. An
   *  inherited plant-default shown for context in a line scope has no real
   *  per-machine record, so it is filtered out here rather than sent as a
   *  (harmless but pointless) no-op delete. */
  async function collectAllScopeRows(plant: string, machine: string): Promise<Array<Pick<typeof _listRows[number], 'from_key' | 'to_key' | 'setup_min'>>> {
    const collected: Array<Pick<typeof _listRows[number], 'from_key' | 'to_key' | 'setup_min'>> = [];
    const limit = 500;
    let offset = 0; let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      const params = new URLSearchParams({ machine, offset: String(offset), limit: String(limit) });
      const response = await Util.fetchTraced(`${API}/setup/${encodeURIComponent(plant)}/matrix-rows?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { rows: typeof _listRows; meta: { total: number } };
      collected.push(...body.rows.filter(row => !(machine && row.inherited)).map(row => ({ from_key: row.from_key, to_key: row.to_key, setup_min: row.setup_min })));
      total = Number.isFinite(body.meta?.total) ? Math.max(0, Number(body.meta.total)) : offset + body.rows.length;
      offset += body.rows.length;
      if (!body.rows.length) break;
    }
    return collected;
  }

  /** Resolves the List view's free-text "From" filter to a canonical
   *  `SetupStateKey` only when it exactly matches one known cross-product
   *  state (by rendered text or by signature) — otherwise returns `null` so
   *  the caller fetches unfiltered and narrows the displayed page by
   *  substring instead, same fallback as the grid's own filters. */
  function resolveFromKey(definitionFields: ReadonlyArray<string>, filterText: string, lineScope: string = _lineScope): SetupStateKey | null {
    const q = filterText.trim();
    if (!q) return null;
    const { byText, bySig } = resolveLookupFor(definitionFields, lineScope);
    const text = byText.get(q.toLowerCase());
    const sig = bySig.get(q);
    // The old linear `find` returned the FIRST state matching either test, i.e. the smaller candidate index.
    const hit = text && sig ? (text.i <= sig.i ? text : sig) : (text ?? sig);
    return hit ? hit.key : null;
  }

  /** Single-entry cache for `resolveFromKey`'s lookup maps, keyed on the rank-maps object reference
   *  (`Store.setPriorityRankMaps` replaces it wholesale, never edits in place), the signature fields and the
   *  line scope. Both maps are built in ONE pass over the cartesian states and keep the FIRST state per key, so the
   *  result equals the old per-call `candidates.find` (first match wins, display text matched case-insensitively). */
  let _resolveLookup: {
    rankMaps: PriorityRankMaps; fieldsKey: string; lineScope: string;
    byText: Map<string, { i: number; key: SetupStateKey }>; bySig: Map<string, { i: number; key: SetupStateKey }>;
  } | null = null;
  function resolveLookupFor(definitionFields: ReadonlyArray<string>, lineScope: string): NonNullable<typeof _resolveLookup> {
    const rankMaps = Store.priorityRankMaps;
    const fieldsKey = definitionFields.join('\0');
    const cached = _resolveLookup;
    if (cached && cached.rankMaps === rankMaps && cached.fieldsKey === fieldsKey && cached.lineScope === lineScope) return cached;
    const valuesByField: Record<string, string[]> = {};
    definitionFields.forEach(field => { valuesByField[field] = fieldValueSet(rankMaps, field, lineScope); });
    const byText = new Map<string, { i: number; key: SetupStateKey }>();
    const bySig = new Map<string, { i: number; key: SetupStateKey }>();
    cartesianStates(definitionFields, valuesByField).forEach((state, i) => {
      const text = state.parts.join(' · ').toLowerCase();
      if (!byText.has(text)) byText.set(text, { i, key: state.key });
      if (!bySig.has(state.sig)) bySig.set(state.sig, { i, key: state.key });
    });
    return _resolveLookup = { rankMaps, fieldsKey, lineScope, byText, bySig };
  }

  /** Trailing debounce with an explicit flush, so an action that reads the validation result (Stage, Download
   *  rejected) can run the pending pass first. Timers are injectable for tests. */
  function createDebouncedValidator(
    run: () => void, delayMs: number,
    timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void } = {
      set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  ): { schedule(): void; flush(): void; cancel(): void } {
    let handle: unknown = null;
    let pending = false;
    const clear = (): void => { if (pending) { timers.clear(handle); handle = null; pending = false; } };
    return {
      schedule(): void { clear(); pending = true; handle = timers.set(() => { pending = false; handle = null; run(); }, delayMs); },
      flush(): void { if (!pending) return; clear(); run(); },
      cancel(): void { clear(); },
    };
  }

  interface MassUploadOutcome {
    ready: Array<{ line: number; from: SetupStateKey; to: SetupStateKey; minutes: number | null }>;
    rejected: Array<{ line: number; message: string }>;
    overwrites: number;
  }

  /** Positional pipe-joined state text ("BLUE|T1"), one value per definition
   *  field in order — same convention as the mockup's textarea. Header row is
   *  optional and detected by "doesn't parse as a valid row" on line 1. */
  function parseMassUploadText(
    text: string, definition: SetupDefinition, existing: EffectiveSetupRow[], clearOnBlank: boolean,
    lookup: Map<string, Map<string, EffectiveSetupRow>> = buildCellLookup(existing),
    lineScope: string = _lineScope,
  ): MassUploadOutcome {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const outcome: MassUploadOutcome = { ready: [], rejected: [], overwrites: 0 };
    lines.forEach((raw, index) => {
      const lineNo = index + 1;
      const cols = raw.includes('\t') ? raw.split('\t') : raw.split(',');
      if (cols.length !== 3) {
        if (lineNo === 1) return; // tolerate an optional header row
        outcome.rejected.push({ line: lineNo, message: Util.t('ui.setup_mass_upload_reject_columns', { line: lineNo, count: cols.length }) });
        return;
      }
      const [fromText, toText, minutesText] = cols.map(c => c.trim());
      const fromKey = resolveFromKey(definition.fields, fromText.replace(/\|/g, ' · '), lineScope);
      const toKey = resolveFromKey(definition.fields, toText.replace(/\|/g, ' · '), lineScope);
      if (!fromKey || !toKey) {
        outcome.rejected.push({ line: lineNo, message: Util.t('ui.setup_mass_upload_reject_bad_state', { line: lineNo, value: !fromKey ? fromText : toText }) });
        return;
      }
      const minutes = clearOnBlank && !minutesText ? null : parseGridMinutes(minutesText);
      if (minutes === 'invalid') {
        outcome.rejected.push({ line: lineNo, message: Util.t('ui.setup_mass_upload_reject_bad_minutes', { line: lineNo, value: minutesText }) });
        return;
      }
      if (lookup.get(stateSig(fromKey))?.get(stateSig(toKey))) outcome.overwrites++;
      outcome.ready.push({ line: lineNo, from: fromKey, to: toKey, minutes });
    });
    return outcome;
  }

  function openMassUploadModal(target: HTMLElement, snapshot: SetupSnapshot, definition: SetupDefinition | null, rows: EffectiveSetupRow[], permissions: SetupPermissions): void {
    if (!definition || !permissions.matrixWrite) return;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal setup-mass-upload-modal" role="dialog" aria-modal="true" aria-labelledby="setup-mass-upload-title">
      <header class="modal-head"><h3 id="setup-mass-upload-title">${Util.escapeHtml(Util.t('ui.setup_mass_upload_title'))}</h3><button type="button" class="btn btn-ghost sm" data-setup-mass-upload-close aria-label="${Util.escapeHtml(Util.t('btn.close'))}">&times;</button></header>
      <div class="modal-body setup-mass-upload-body">
        <div class="setup-mass-upload-section">
          <span class="label">${Util.escapeHtml(Util.t('ui.setup_mass_upload_step1'))}</span>
          <p class="setup-panel-hint">${Util.escapeHtml(Util.t('ui.setup_mass_upload_hint'))}</p>
          <textarea class="input setup-mass-upload-textarea" data-setup-mass-upload-text rows="6"></textarea>
        </div>
        <div class="setup-mass-upload-section">
          <span class="label">${Util.escapeHtml(Util.t('ui.setup_mass_upload_step2'))}</span>
          <div class="setup-mass-upload-kpis" data-setup-mass-upload-kpis></div>
          <div class="setup-mass-upload-rejects" data-setup-mass-upload-rejects></div>
        </div>
        <label class="setup-check"><input type="checkbox" data-setup-mass-upload-clear-blank>${Util.escapeHtml(Util.t('ui.setup_mass_upload_clear_blank'))}</label>
      </div>
      <footer class="modal-foot">
        <button type="button" class="btn btn-ghost sm" data-setup-mass-upload-download disabled>${Util.escapeHtml(Util.t('btn.setup_mass_upload_download_rejected'))}</button>
        <button type="button" class="btn btn-ghost sm" data-setup-mass-upload-close>${Util.escapeHtml(Util.t('btn.cancel'))}</button>
        <button type="button" class="btn btn-primary sm" data-setup-mass-upload-stage disabled>${Util.escapeHtml(Util.t('btn.setup_mass_upload_stage', { count: 0 }))}</button>
      </footer>
    </div>`;
    let lastOutcome: MassUploadOutcome = { ready: [], rejected: [], overwrites: 0 };
    const cellLookup = buildCellLookup(rows);   // the existing matrix does not change while the modal is open
    const revalidate = (): void => {
      const text = backdrop.querySelector<HTMLTextAreaElement>('[data-setup-mass-upload-text]')!.value;
      const clearOnBlank = backdrop.querySelector<HTMLInputElement>('[data-setup-mass-upload-clear-blank]')!.checked;
      lastOutcome = parseMassUploadText(text, definition, rows, clearOnBlank, cellLookup);
      backdrop.querySelector('[data-setup-mass-upload-kpis]')!.innerHTML = `
        <div class="setup-mass-upload-kpi ok"><span>${Util.escapeHtml(Util.t('ui.setup_mass_upload_ready'))}</span><strong>${lastOutcome.ready.length}</strong></div>
        <div class="setup-mass-upload-kpi err"><span>${Util.escapeHtml(Util.t('ui.setup_mass_upload_rejected'))}</span><strong>${lastOutcome.rejected.length}</strong></div>
        <div class="setup-mass-upload-kpi"><span>${Util.escapeHtml(Util.t('ui.setup_mass_upload_overwrites'))}</span><strong>${lastOutcome.overwrites}</strong></div>`;
      const shown = lastOutcome.rejected.slice(0, 12);
      const more = lastOutcome.rejected.length - shown.length;
      backdrop.querySelector('[data-setup-mass-upload-rejects]')!.innerHTML = shown.map(r => `<div class="setup-mass-upload-reject-row">${Util.escapeHtml(r.message)}</div>`).join('')
        + (more > 0 ? `<div class="setup-mass-upload-reject-row muted">${Util.escapeHtml(Util.t('ui.setup_mass_upload_more_rejected', { count: more }))}</div>` : '');
      backdrop.querySelector<HTMLButtonElement>('[data-setup-mass-upload-stage]')!.disabled = lastOutcome.ready.length === 0;
      backdrop.querySelector<HTMLButtonElement>('[data-setup-mass-upload-stage]')!.textContent = Util.t('btn.setup_mass_upload_stage', { count: lastOutcome.ready.length });
      backdrop.querySelector<HTMLButtonElement>('[data-setup-mass-upload-download]')!.disabled = lastOutcome.rejected.length === 0;
    };
    // Typing/pasting revalidates after a 150 ms pause; the checkbox is a discrete click and stays immediate.
    // Stage and Download-rejected flush a pending pass first so they never act on a stale outcome.
    const debounced = createDebouncedValidator(revalidate, 150);
    backdrop.querySelector<HTMLTextAreaElement>('[data-setup-mass-upload-text]')!.addEventListener('input', () => debounced.schedule());
    backdrop.querySelector<HTMLInputElement>('[data-setup-mass-upload-clear-blank]')!.addEventListener('change', () => { debounced.cancel(); revalidate(); });
    const close = (): void => { debounced.cancel(); backdrop.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(); };
    backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
    backdrop.querySelectorAll<HTMLButtonElement>('[data-setup-mass-upload-close]').forEach(button => button.addEventListener('click', close));
    backdrop.querySelector<HTMLButtonElement>('[data-setup-mass-upload-download]')!.addEventListener('click', () => {
      debounced.flush();
      // Reason text is built from user-pasted values, so a message beginning
      // `=`/`+`/`-`/`@` (or a tab/CR that Excel strips before re-reading the
      // leading character) would be evaluated as a formula on open — prefix a
      // single quote so the cell stays literal text.
      const csvCell = (value: string): string => {
        const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
        return `"${guarded.replace(/"/g, '""')}"`;
      };
      const csv = [
        [Util.t('ui.setup_mass_upload_csv_col_line'), Util.t('ui.setup_mass_upload_csv_col_reason')].map(csvCell).join(','),
        ...lastOutcome.rejected.map(r => [String(r.line), r.message].map(csvCell).join(',')),
      ].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'setup-mass-upload-rejected.csv'; link.click(); URL.revokeObjectURL(url);
    });
    backdrop.querySelector<HTMLButtonElement>('[data-setup-mass-upload-stage]')!.addEventListener('click', () => {
      debounced.flush();
      lastOutcome.ready.forEach(entry => {
        const key = `${stateSig(entry.from)} ${stateSig(entry.to)}`;
        _gridDirty.set(key, { row: { key: entry.from, sig: stateSig(entry.from), parts: entry.from.map(p => p.value) },
                              col: { key: entry.to, sig: stateSig(entry.to), parts: entry.to.map(p => p.value) },
                              setup_min: entry.minutes, machine: _lineScope });
      });
      Toast.show(Util.t('ui.setup_grid_pasted', { count: lastOutcome.ready.length }), 'success');
      close();
      if (_setupView === 'matrix') paintGrid(target, snapshot, definition, rows, permissions);
      else if (definition) paintListView(target, snapshot, definition, permissions);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    revalidate();
  }

  function render(target: HTMLElement | null, plant: string | null = Store.selectedPlant): void {
    if (!target) return;
    _lastTarget = target;
    if (!plant) { target.innerHTML = `<div class="setup-empty">${Util.escapeHtml(Util.t('toast.no_plant_selected'))}</div>`; return; }
    const snapshot = Store.setupSnapshot;
    if (!snapshot || snapshot.plant !== plant) {
      target.innerHTML = `<div class="setup-empty">${Util.escapeHtml(Util.t('ui.loading'))}</div>`;
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

  /** Drop this plant's cached line scope, coverage and per-line compatibility so the
   *  next `render` re-fetches them. `loadScopeLines`/`loadCoverage`/`loadCompatibility`
   *  early-return on a cached entry and nothing else expires them; the Master Data
   *  Refresh calls this before re-rendering the Settings pane. */
  function invalidatePlant(plant: string): void {
    delete _linesByPlant[plant];
    delete _coverageByPlant[plant];
    const prefix = `${plant}\u0000`;
    for (const key of Object.keys(_compatibilityByLine)) {
      if (key.startsWith(prefix)) delete _compatibilityByLine[key];
    }
  }

  // A machine added/removed/edited in Master Data must show up in the matrix scope without a
  // reload: the per-plant caches above never expire on their own. Cache-clear only: the Setup
  // Matrix pane is not on screen while Manage Data is, and a repaint would drop unsaved grid
  // edits, so the next render() simply refetches. Plant-scoped, matching invalidatePlant.
  Store.subscribe((evt) => {
    if (evt.type !== 'master-data-changed') return;
    const plant = Store.selectedPlant;
    if (plant) invalidatePlant(plant);
  }, 'SetupAdmin.cacheReset');

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
    // Gantt/Orders line filter changes elsewhere (docs/archive/Setup_matrix_redesign.md
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
    const rows = version === null ? [] : effectiveRows({ plantRows: snapshot.plant_rows, machineRows: snapshot.machine_rows, machine: _lineScope, version });
    const definitionFields = definition?.fields?.length ? definition.fields : [_registeredFields[0]].filter(Boolean);
    const matrixVersion = rows.length ? version : null;
    const coverage = _coverageByPlant[snapshot.plant];
    const coveragePass = coverage ? coverage.reachable?.missing_pairs === 0 : undefined;
    const status = activationStatus(definition, { matrixVersion, coveragePass }, snapshot.plant_active);
    const sourceLabel = _lineScope ? _lineScope : Util.t('ui.setup_plant_default');
    const state = _lineScope ? snapshot.machine_states.find(row => row.machine === _lineScope) : null;
    const overrides = _lineScope ? snapshot.overrides.filter(row => row.machine === _lineScope) : snapshot.overrides;
    const review = _missingReview?.plant === snapshot.plant ? _missingReview : null;
    // §9 "what moves off the page": the tab's own missing-pairs mini-table
    // collapses to a filter chip on the grid — not the OptimizerPreview
    // modal's own copy of this table (schedule-workbench.mts), which is a
    // separate surface (the run-time comparison dialog) left untouched.
    const missingReviewFilterOptions = [
      ['all', Util.t('ui.setup_review_filter_all')],
      ['state', Util.t('ui.setup_review_filter_state')],
      ['row', Util.t('ui.setup_review_filter_row')],
    ] as const;
    const missingChipHtml = review ? `<span class="setup-review-chip">${Util.escapeHtml(Util.t('ui.setup_review_chip', { count: review.pairs.length }))}<select data-setup-review-filter aria-label="${Util.escapeHtml(Util.t('ui.setup_review_missing_title'))}">${missingReviewFilterOptions.map(([value, label]) => `<option value="${value}"${_missingReviewFilter === value ? ' selected' : ''}>${Util.escapeHtml(label)}</option>`).join('')}</select><button type="button" class="setup-review-chip-clear" data-setup-review-clear aria-label="${Util.escapeHtml(Util.t('btn.setup_review_clear'))}">&times;</button></span>` : '';
    const totalPairs = coverage?.reachable?.total_pairs ?? 0;
    const missingPairs = coverage?.reachable?.missing_pairs ?? 0;
    const coverageInlineHtml = coverage
      ? `<button type="button" class="setup-coverage-inline${missingPairs > 0 ? ' warn' : ''}" data-setup-missing-filter>${Util.escapeHtml(Util.t('ui.setup_coverage_inline', { covered: Math.max(0, totalPairs - missingPairs), total: totalPairs }))} · ${Util.escapeHtml(Util.t('ui.setup_kpi_missing_count', { missing: missingPairs }))} &#9656;</button>`
      : '';
    const signatureChipHtml = definitionFields.length
      ? definitionFields.map(field => Util.escapeHtml(fieldLabel(field))).join(' &rsaquo; ')
      : Util.escapeHtml(Util.t('ui.setup_no_definition_short'));
    const scaleReadoutHtml = definitionFields.length
      ? `<p class="setup-scale-readout">${Util.escapeHtml(Util.t('ui.setup_scale_readout', {
          fields: definitionFields.map(field => `${fieldValueSet(Store.priorityRankMaps, field, _lineScope).length} ${fieldLabel(field).toLowerCase()}`).join(' × '),
          states: definitionFields.length ? Math.max(...definitionFields.map(field => fieldValueSet(Store.priorityRankMaps, field, _lineScope).length)) : 0,
        }))}</p>`
      : '';
    const coverageTilesHtml = coverage
      ? `<div class="setup-coverage-tiles">
          <div class="setup-coverage-tile"><span class="mono-eyebrow">${Util.escapeHtml(Util.t('ui.setup_coverage_recorded'))}</span><span class="setup-coverage-tile-num">${totalPairs - missingPairs}</span></div>
          <button type="button" class="setup-coverage-tile${missingPairs > 0 ? ' warn' : ''}" data-setup-missing-filter><span class="mono-eyebrow">${Util.escapeHtml(Util.t('ui.setup_coverage_gaps'))}</span><span class="setup-coverage-tile-num">${missingPairs}</span></button>
        </div>`
      : '';
    target.innerHTML = `
      <section class="setup-admin" aria-labelledby="setup-admin-title">
        <header class="setup-context-bar">
          <div class="setup-context-main">
            <h3 id="setup-admin-title">${Util.escapeHtml(Util.t('ui.setup_matrix_title'))}</h3>
            <p>${Util.escapeHtml(Util.t('ui.setup_matrix_sub', { plant: snapshot.plant }))}</p>
          </div>
          <div class="setup-context-controls">
            <!-- Workstream D2 (2026-08-20): the "Include Setup Times in Optimizer"
                 checkbox relocated to the Scheduling Rules panel (plant-level
                 setting, plants.setup_active) — see Plant._renderSettingsPane's
                 setup-active panel. This chip stays; it now reads
                 snapshot.plant_active via activationStatus's third argument. -->
            <span class="setup-status-chip ${status.active ? 'ok' : 'warn'}" title="${Util.escapeHtml(status.reason)}"><span class="dot"></span>${status.active ? Util.escapeHtml(Util.t('ui.setup_activation_active')) : Util.escapeHtml(Util.t('ui.setup_activation_inactive'))}</span>
          </div>
        </header>

        <div class="panel setup-panel">
          <div class="panel-head">
            <span class="mono-eyebrow">${Util.escapeHtml(Util.t('ui.setup_step1_definition'))}</span>
            <p class="panel-hint">${Util.escapeHtml(Util.t('ui.setup_signature_popover_hint'))}</p>
          </div>
          <div class="panel-body setup-standard-rail">
            <div class="setup-signature-wrap">
              <span class="mono-eyebrow">${Util.escapeHtml(Util.t('ui.setup_band_signature_label'))}</span>
              <div class="setup-signature-line">
                <span class="setup-signature-chip">${signatureChipHtml}</span>
                <button type="button" class="btn btn-ghost sm" data-setup-signature-edit aria-expanded="${_signaturePopoverOpen}" aria-haspopup="true">${Util.escapeHtml(Util.t('btn.setup_edit_signature'))}</button>
              </div>
              ${scaleReadoutHtml}
            </div>
            <div class="setup-scope-wrap">
              <label class="mono-eyebrow" for="setup-line-combobox">${Util.escapeHtml(Util.t('ui.setup_scope_label'))}</label>
              <span id="setup-line-combobox"></span>
              ${_lineScope ? renderLineState(state ?? undefined, definition, permissions) : ''}
            </div>
            <div class="setup-coverage-wrap">
              <span class="mono-eyebrow">${Util.escapeHtml(Util.t('ui.setup_coverage_label'))}</span>
              ${coverageTilesHtml}
              ${missingChipHtml}
            </div>
          </div>

          <div class="setup-popover" data-setup-signature-popover ${_signaturePopoverOpen ? '' : 'hidden'}>
            <div class="panel-head"><span class="label">${Util.escapeHtml(Util.t('ui.setup_step1_definition'))}</span>${permissions.definitionWrite ? `<button class="btn btn-ghost sm" data-setup-save-definition>${Util.escapeHtml(Util.t('btn.save'))}</button>` : `<span class="panel-hint">${Util.escapeHtml(Util.t('ui.setup_read_only'))}</span>`}</div>
            <div class="setup-field-order" data-setup-field-order>${definitionFields.map((field, index) => `<div class="setup-field-row"><span>${index + 1}</span><select data-setup-field="${index}" ${permissions.definitionWrite ? '' : 'disabled'}>${_registeredFields.map(option => `<option value="${option}"${option === field ? ' selected' : ''}>${Util.escapeHtml(fieldLabel(option))}</option>`).join('')}</select>${permissions.definitionWrite ? `<button type="button" class="btn btn-ghost sm" data-setup-field-up="${index}" ${index === 0 ? 'disabled' : ''} aria-label="${Util.escapeHtml(Util.t('btn.setup_field_up'))}">&uarr;</button><button type="button" class="btn btn-ghost sm" data-setup-field-down="${index}" ${index === definitionFields.length - 1 ? 'disabled' : ''} aria-label="${Util.escapeHtml(Util.t('btn.setup_field_down'))}">&darr;</button><button type="button" class="btn btn-ghost sm" data-setup-field-remove="${index}" ${definitionFields.length === 1 ? 'disabled' : ''} aria-label="${Util.escapeHtml(Util.t('btn.remove'))}">${Util.escapeHtml(Util.t('btn.remove'))}</button>` : ''}</div>`).join('')}</div>
            <label class="setup-check"><input type="checkbox" data-setup-strict ${definition?.strict_blanks !== false ? 'checked' : ''} ${permissions.definitionWrite ? '' : 'disabled'}>${Util.escapeHtml(Util.t('ui.setup_strict_blanks'))}</label>
            ${permissions.definitionWrite ? `<button class="btn btn-ghost sm" data-setup-add-field>${Util.escapeHtml(Util.t('btn.setup_add_field'))}</button>` : ''}
            <p class="setup-popover-hint">${Util.escapeHtml(Util.t('ui.setup_version_note', { version: (version ?? 0) + 1 }))}</p>
          </div>
        </div>

        <div class="panel setup-panel">
          <div class="panel-head">
            <div class="setup-view-toolbar">
              <span class="mono-eyebrow">${Util.escapeHtml(Util.t('ui.setup_section_matrix'))}</span>
              <div class="setup-view-tabs" role="tablist">
                <button type="button" role="tab" aria-selected="${_setupView === 'list'}" class="setup-view-tab${_setupView === 'list' ? ' active' : ''}" data-setup-view="list">${Util.escapeHtml(Util.t('ui.setup_view_list'))}</button>
                <button type="button" role="tab" aria-selected="${_setupView === 'matrix'}" class="setup-view-tab${_setupView === 'matrix' ? ' active' : ''}" data-setup-view="matrix">${Util.escapeHtml(Util.t('ui.setup_view_matrix'))}</button>
              </div>
            </div>
            <div class="setup-view-actions">
              <button type="button" class="btn btn-primary sm" data-setup-mass-upload-open>${Util.escapeHtml(Util.t('btn.setup_mass_upload'))}</button>
              <button type="button" class="btn btn-ghost sm" data-setup-export-matrix ${permissions.export ? '' : 'disabled'}>${Util.escapeHtml(Util.t('btn.setup_export_matrix'))}</button>
              <button type="button" class="btn btn-ghost sm" data-setup-copy-matrix ${permissions.copy ? '' : 'disabled'}>${Util.escapeHtml(Util.t('btn.setup_copy_matrix'))}</button>
              ${permissions.matrixWrite && definition ? `<label class="btn btn-ghost sm setup-import-label">${Util.escapeHtml(Util.t('ui.setup_import_csv'))}<input type="file" accept=".csv,text/csv" data-setup-import hidden></label>` : ''}
              <button type="button" class="btn btn-ghost sm" data-setup-history-open>${Util.escapeHtml(Util.t('btn.setup_audit_toggle', { count: overrides.length }))}</button>
            </div>
          </div>
          <div class="panel-body">
            <div class="setup-grid-toolbar">
              <input type="text" class="input setup-grid-filter" data-setup-grid-filter-from placeholder="${Util.escapeHtml(Util.t('ui.setup_grid_filter_from_placeholder'))}" value="${Util.escapeHtml(_gridFilterFrom)}">
              <input type="text" class="input setup-grid-filter" data-setup-grid-filter-to placeholder="${Util.escapeHtml(Util.t('ui.setup_grid_filter_to_placeholder'))}" value="${Util.escapeHtml(_gridFilterTo)}">
              ${_setupView === 'list' ? `<label class="setup-check"><input type="checkbox" data-setup-list-hide-empty ${_hideEmptyStates ? 'checked' : ''}>${Util.escapeHtml(Util.t('ui.setup_list_hide_empty'))}</label>` : ''}
            </div>
            <div id="setup-list-mount" ${_setupView === 'list' ? '' : 'hidden'}></div>
            <div id="setup-grid-table-mount" ${_setupView === 'matrix' ? '' : 'hidden'}></div>
          </div>
          <div class="setup-action-bar">
            <span data-setup-grid-dirty-count>${Util.escapeHtml(Util.t('ui.setup_grid_dirty_count', { count: _gridDirty.size }))}</span>
            <div class="setup-action-buttons">
              <button class="btn btn-ghost sm" data-setup-grid-discard ${_gridDirty.size ? '' : 'disabled'}>${Util.escapeHtml(Util.t('btn.discard'))}</button>
              <button class="btn btn-primary sm" data-setup-grid-save ${_gridDirty.size ? '' : 'disabled'}>${Util.escapeHtml(Util.t('btn.save'))}</button>
            </div>
          </div>
        </div>

      </section>`;
    _mkCombobox(target.querySelector('#setup-line-combobox'), ['', ...lines], { value: _lineScope, placeholder: Util.t('ph.search_lines'), onSelect: value => {
      _lineScope = value;
      _listMeta = { ..._listMeta, offset: 0 };
      // A stale selection/typed-confirm from the PREVIOUS scope must never
      // carry over — the row keys underneath belong to a different machine.
      _listSelected.clear();
      _deleteAllConfirmText = '';
      if (value) loadCompatibility(snapshot.plant, value).then(() => renderSnapshot(target, snapshot));
      else renderSnapshot(target, snapshot);
    } });
    wire(target, snapshot, permissions, rows, definition);
    if (_setupView === 'matrix') paintGrid(target, snapshot, definition, rows, permissions);
    else renderListView(target, snapshot, definition, permissions);
  }

  /** Compact "you are here" readout inline under the Scope selector — replaces
   *  the old standalone "Line Status" group/panel (docs/archive/Setup_matrix_redesign.md
   *  §9 "what moves off the page"). The grid itself marks the matching row;
   *  this is only the state text + the write affordance (`editState`/
   *  `wireCompatibility` still need a mount point in the DOM). */
  function renderLineState(state: LineSetupState | undefined, definition: SetupDefinition | null, permissions: SetupPermissions): string {
    const fieldLines = state
      ? state.state_key.map(part => `<span>${Util.escapeHtml(fieldLabel(part.fieldKey))}: ${Util.escapeHtml(part.value)}</span>`).join('')
      : `<span>${Util.escapeHtml(Util.t('ui.setup_state_unknown'))}</span>`;
    return `<div class="setup-state-inline" data-setup-state-inline><div class="setup-state-readout">${fieldLines}<span>${Util.escapeHtml(Util.t('ui.setup_state_source'))}: ${Util.escapeHtml(state?.source || '—')}</span><span>${Util.escapeHtml(Util.t('ui.setup_observed_at'))}: ${Util.escapeHtml(state?.observed_at || '—')}</span></div>${permissions.stateWrite && definition ? `<button class="btn btn-ghost sm" data-setup-edit-state>${Util.escapeHtml(Util.t('btn.setup_update_state'))}</button>` : ''}</div>`;
  }

  function overridesFor(snapshot: SetupSnapshot): SetupSnapshot['overrides'] {
    return _lineScope ? snapshot.overrides.filter(row => row.machine === _lineScope) : snapshot.overrides;
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
    backdrop.innerHTML = `<div class="modal setup-history-modal" role="dialog" aria-modal="true" aria-labelledby="setup-history-title">
      <header class="modal-head"><h3 id="setup-history-title">${Util.escapeHtml(Util.t('ui.setup_override_audit'))}</h3><button type="button" class="btn btn-ghost sm" data-setup-history-close aria-label="${Util.escapeHtml(Util.t('btn.close'))}">&times;</button></header>
      <div class="modal-body">${overrides.length ? overrides.map(override => `<div class="setup-audit-row"><strong>${Util.escapeHtml(override.status.toUpperCase())}</strong><span>${Util.escapeHtml(override.machine)} &middot; ${Util.escapeHtml(keyText(override.predecessor_state_key))} &rarr; ${Util.escapeHtml(keyText(override.successor_state_key))}</span><span class="setup-num">${override.remaining_min}/${override.standard_min} min</span><span>${Util.escapeHtml(override.reason)}</span></div>`).join('') : emptyState(Util.t('ui.setup_no_overrides'))}</div>
      <footer class="modal-foot"><button type="button" class="btn btn-ghost sm" data-setup-history-close>${Util.escapeHtml(Util.t('btn.close'))}</button></footer>
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
      _missingReviewFilter = 'all';
      renderSnapshot(target, snapshot);
    });
    target.querySelector<HTMLSelectElement>('[data-setup-review-filter]')?.addEventListener('change', event => {
      const value = (event.target as HTMLSelectElement).value;
      _missingReviewFilter = value === 'state' || value === 'row' ? value : 'all';
      renderSnapshot(target, snapshot);
    });
    target.querySelector<HTMLButtonElement>('[data-setup-signature-edit]')?.addEventListener('click', () => {
      _signaturePopoverOpen = !_signaturePopoverOpen;
      renderSnapshot(target, snapshot);
    });
    target.querySelector<HTMLButtonElement>('[data-setup-history-open]')?.addEventListener('click', () => {
      openHistoryModal(snapshot);
    });
    target.querySelectorAll<HTMLButtonElement>('[data-setup-view]').forEach(button => {
      button.addEventListener('click', () => {
        const next = button.dataset.setupView as 'list' | 'matrix';
        if (next === _setupView) return;
        _setupView = next;
        renderSnapshot(target, snapshot);
      });
    });
    target.querySelector<HTMLButtonElement>('[data-setup-save-definition]')?.addEventListener('click', () => saveDefinition(target, snapshot));
    const syncSignatureFieldControls = (holder: HTMLElement): void => {
      const fieldRows = Array.from(holder.querySelectorAll<HTMLElement>('.setup-field-row'));
      fieldRows.forEach((row, index) => {
        row.querySelector('span')!.textContent = String(index + 1);
        const select = row.querySelector<HTMLSelectElement>('select')!;
        select.dataset.setupField = String(index);
        const up = row.querySelector<HTMLButtonElement>('[data-setup-field-up]');
        const down = row.querySelector<HTMLButtonElement>('[data-setup-field-down]');
        const remove = row.querySelector<HTMLButtonElement>('[data-setup-field-remove]');
        if (up) { up.dataset.setupFieldUp = String(index); up.disabled = index === 0; }
        if (down) { down.dataset.setupFieldDown = String(index); down.disabled = index === fieldRows.length - 1; }
        if (remove) { remove.dataset.setupFieldRemove = String(index); remove.disabled = fieldRows.length === 1; }
      });
    };
    target.querySelector<HTMLButtonElement>('[data-setup-add-field]')?.addEventListener('click', () => {
      const holder = target.querySelector<HTMLElement>('[data-setup-field-order]'); if (!holder || holder.querySelectorAll('select').length >= _registeredFields.length) return;
      const index = holder.querySelectorAll('select').length;
      holder.insertAdjacentHTML('beforeend', `<div class="setup-field-row"><span>${index + 1}</span><select data-setup-field="${index}">${_registeredFields.map(option => `<option value="${option}">${Util.escapeHtml(fieldLabel(option))}</option>`).join('')}</select><button type="button" class="btn btn-ghost sm" data-setup-field-up="${index}" aria-label="${Util.escapeHtml(Util.t('btn.setup_field_up'))}">&uarr;</button><button type="button" class="btn btn-ghost sm" data-setup-field-down="${index}" disabled aria-label="${Util.escapeHtml(Util.t('btn.setup_field_down'))}">&darr;</button><button type="button" class="btn btn-ghost sm" data-setup-field-remove="${index}" aria-label="${Util.escapeHtml(Util.t('btn.remove'))}">${Util.escapeHtml(Util.t('btn.remove'))}</button></div>`);
      syncSignatureFieldControls(holder);
    });
    // Reorder-by-value-swap: the field-row DOM nodes never move (so their
    // up/down disabled state stays tied to fixed position), only the
    // selected value swaps with the adjacent row.
    target.querySelector<HTMLElement>('[data-setup-field-order]')?.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-setup-field-up], [data-setup-field-down], [data-setup-field-remove]');
      if (!button) return;
      const holder = button.closest<HTMLElement>('[data-setup-field-order]')!;
      const fieldRows = Array.from(holder.querySelectorAll<HTMLElement>('.setup-field-row'));
      const currentIndex = fieldRows.indexOf(button.closest<HTMLElement>('.setup-field-row')!);
      if (button.hasAttribute('data-setup-field-remove')) {
        if (removeSignatureField(fieldRows.map(row => row.querySelector<HTMLSelectElement>('select')!.value), currentIndex).length === fieldRows.length) return;
        fieldRows[currentIndex].remove();
        syncSignatureFieldControls(holder);
        return;
      }
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
      // The highlight only exists on the Matrix grid's <td>s, and the List
      // view cannot render a missing pair at all (no setup_matrix row), so
      // switch views first — otherwise this scrolls/highlights a hidden mount.
      if (_setupView !== 'matrix') { _setupView = 'matrix'; renderSnapshot(target, snapshot); }
      const mount = target.querySelector<HTMLElement>('#setup-grid-table-mount'); if (!mount) return;
      mount.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const missingCells = mount.querySelectorAll<HTMLElement>('.setup-grid-td[data-missing="true"]');
      missingCells.forEach(td => td.classList.add('setup-grid-highlight'));
      window.setTimeout(() => missingCells.forEach(td => td.classList.remove('setup-grid-highlight')), 2000);
    });
    target.querySelector<HTMLInputElement>('[data-setup-grid-filter-from]')?.addEventListener('input', event => {
      _gridFilterFrom = (event.target as HTMLInputElement).value;
      _listMeta = { ..._listMeta, offset: 0 };
      if (_setupView === 'matrix') paintGrid(target, snapshot, definition, rows, permissions);
      else renderListView(target, snapshot, definition, permissions);
    });
    target.querySelector<HTMLInputElement>('[data-setup-grid-filter-to]')?.addEventListener('input', event => {
      _gridFilterTo = (event.target as HTMLInputElement).value;
      if (_setupView === 'matrix') paintGrid(target, snapshot, definition, rows, permissions);
      else if (definition) paintListView(target, snapshot, definition, permissions);
    });
    target.querySelector<HTMLInputElement>('[data-setup-list-hide-empty]')?.addEventListener('change', event => {
      _hideEmptyStates = (event.target as HTMLInputElement).checked;
      if (definition) paintListView(target, snapshot, definition, permissions);
    });
    target.querySelector<HTMLButtonElement>('[data-setup-grid-save]')?.addEventListener('click', () => saveGridEdits(target, snapshot, definition, rows, permissions));
    target.querySelector<HTMLButtonElement>('[data-setup-grid-discard]')?.addEventListener('click', () => {
      discardStagedEdits();
      // paintGrid refreshes the dirty bar itself; the List path does not, so
      // refresh it explicitly or the count/Save state stays stale after a
      // Discard taken from the List view.
      refreshDirtyBar(target);
      if (_setupView === 'matrix') paintGrid(target, snapshot, definition, rows, permissions);
      else if (definition) paintListView(target, snapshot, definition, permissions);
    });
    wireGridInteractions(target, snapshot, definition, rows, permissions);
    target.querySelector<HTMLInputElement>('[data-setup-import]')?.addEventListener('change', event => importMatrix(target, snapshot, event.target as HTMLInputElement));
    target.querySelector<HTMLButtonElement>('[data-setup-edit-state]')?.addEventListener('click', () => editState(target, snapshot));
    // The "Include Setup Times in Optimizer" checkbox (formerly wired here as
    // data-setup-active-toggle) relocated to the Scheduling Rules panel —
    // see Plant._renderSettingsPane's setup-active panel, which now owns
    // the PUT /plant/{plant}/setup-active call directly.
    if (_lineScope && permissions.definitionWrite) wireCompatibility(target, snapshot);
    wireGridEditor(target, snapshot, definition, rows, permissions);
    target.querySelector<HTMLButtonElement>('[data-setup-mass-upload-open]')?.addEventListener('click', () => openMassUploadModal(target, snapshot, definition, rows, permissions));
  }

  /** One List-view row's derived display state — mirrors the mockup's
   *  `rowVals` helper. `isOverride` favors a pending dirty edit's own delta
   *  from the plant value over the row's already-persisted `inherited` flag,
   *  so an in-progress edit reflects immediately without waiting on a
   *  refetch. `isGap` is only true for a row with no persisted plant value and
   *  no pending edit that would give it one — i.e. truly nothing recorded
   *  anywhere (a pending clear counts as nothing). */
  interface ListRowView {
    fromText: string; toText: string; minutes: string; plantValue: string;
    sourceLabel: string; sourceClass: string; isOverride: boolean; isGap: boolean; key: string;
  }
  function listRowView(row: typeof _listRows[number], line: string): ListRowView {
    const key = `${stateSig(row.from_key)} ${stateSig(row.to_key)}`;
    const dirty = _gridDirty.get(key);
    const isOverride = dirty ? dirty.setup_min !== row.plant_value : (!!line && !row.inherited);
    // A pending *clear* (dirty.setup_min === null) on a pair with no plant
    // default leaves nothing recorded anywhere, so it reads as a gap too —
    // otherwise the row that fix #3 now correctly stages would still claim to
    // be "Inherited from plant" with no plant value to inherit.
    const gap = !isOverride && row.plant_value === null && (dirty === undefined || dirty.setup_min === null);
    const effective = dirty ? dirty.setup_min : row.setup_min;
    const minutes = effective === null ? '' : String(effective);
    return {
      fromText: keyText(row.from_key), toText: keyText(row.to_key), minutes,
      plantValue: row.plant_value === null ? '—' : String(row.plant_value),
      // In plant scope there is no line to name — reusing the line-override
      // label there rendered a dangling "Line override · " with an empty
      // interpolation, so plant-scope edits get their own label.
      sourceLabel: isOverride
        ? (line ? Util.t('ui.setup_list_source_override', { line }) : Util.t('ui.setup_list_source_plant_edit'))
        : gap ? Util.t('ui.setup_list_source_gap') : Util.t('ui.setup_list_source_inherited'),
      sourceClass: isOverride ? 'setup-list-source-override' : gap ? 'setup-list-source-gap' : 'setup-list-source-inherited',
      isOverride, isGap: gap, key,
    };
  }

  /** Fetches the current page of matrix rows from the backend and paints
   *  immediately with whatever's already cached (e.g. right after a local
   *  edit, before any network round-trip) so the table never flashes empty
   *  while the fetch is in flight — then repaints once the fetch resolves. */
  function renderListView(target: HTMLElement, snapshot: SetupSnapshot, definition: SetupDefinition | null, permissions: SetupPermissions): void {
    const mount = target.querySelector<HTMLElement>('#setup-list-mount');
    if (!mount) return;
    if (!definition) { mount.innerHTML = emptyState(Util.t('ui.setup_no_definition')); return; }
    const fromKey = resolveFromKey(definition.fields, _gridFilterFrom);
    fetchListRows(snapshot.plant, definition, fromKey, _lineScope).then(() => paintListView(target, snapshot, definition, permissions));
    // Paint immediately with whatever's cached (e.g. after an edit) so the
    // table never flashes empty while the fetch is in flight.
    paintListView(target, snapshot, definition, permissions);
  }

  function paintListView(target: HTMLElement, snapshot: SetupSnapshot, definition: SetupDefinition, permissions: SetupPermissions): void {
    const mount = target.querySelector<HTMLElement>('#setup-list-mount');
    if (!mount || _setupView !== 'list') return;
    const fromQuery = _gridFilterFrom.trim().toLowerCase();
    const toQuery = _gridFilterTo.trim().toLowerCase();
    let rows = _listRows;
    // The From box narrows the displayed page by substring exactly like the To
    // box does. resolveFromKey() only ever fires for an EXACT full-state match
    // (it is the server-side `from_key` filter's input); without this
    // client-side pass a partial query like "BLU" silently matched nothing.
    if (fromQuery) rows = rows.filter(r => keyText(r.from_key).toLowerCase().includes(fromQuery));
    if (toQuery) rows = rows.filter(r => keyText(r.to_key).toLowerCase().includes(toQuery));
    // "Hide states with no value" means no EFFECTIVE value — its own recorded
    // setup_min (which a line override has even with no plant default) or a
    // staged edit. Testing plant_value here hid every line-scoped override on
    // a pair the plant has no default for.
    if (_hideEmptyStates) rows = rows.filter(r => r.setup_min !== null || _gridDirty.has(`${stateSig(r.from_key)} ${stateSig(r.to_key)}`));
    // Workstream D3: keys for the rows actually on screen, so a stale
    // selection from a filtered-out or previous-page row never inflates the
    // header "select all" checkbox's checked state.
    const onScreenKeys = rows.map(row => `${stateSig(row.from_key)} ${stateSig(row.to_key)}`);
    const allSelected = onScreenKeys.length > 0 && onScreenKeys.every(key => _listSelected.has(key));
    const bodyRows = rows.map(row => {
      const v = listRowView(row, _lineScope);
      // Two separate data attributes, not one space-joined `${sig1} ${sig2}`
      // string — stateSig() values are `|`-joined and a priority-list value
      // containing a literal space (e.g. "Light Blue") would make a combined
      // attribute unsplittable, silently dropping the edit.
      const fromSig = stateSig(row.from_key), toSig = stateSig(row.to_key);
      const key = `${fromSig} ${toSig}`;
      return `<tr data-setup-list-row-from="${Util.escapeHtml(fromSig)}" data-setup-list-row-to="${Util.escapeHtml(toSig)}">
        <td class="setup-num">${permissions.matrixWrite ? `<input type="checkbox" data-setup-list-select value="${Util.escapeHtml(key)}" ${_listSelected.has(key) ? 'checked' : ''} aria-label="${Util.escapeHtml(Util.t('ui.setup_list_select_row'))}">` : ''}</td>
        <td class="mono">${Util.escapeHtml(v.fromText)}</td>
        <td class="mono">${Util.escapeHtml(v.toText)}</td>
        <td class="setup-num"><input type="text" class="input setup-list-minutes-input" inputmode="numeric" value="${Util.escapeHtml(v.minutes)}" data-setup-list-minutes ${permissions.matrixWrite ? '' : 'disabled'}></td>
        <td class="setup-num">${Util.escapeHtml(v.plantValue)}</td>
        <td><span class="${v.sourceClass}">${Util.escapeHtml(v.sourceLabel)}</span></td>
        <td class="setup-num">
          ${v.isOverride ? `<button type="button" class="setup-list-revert" data-setup-list-revert title="${Util.escapeHtml(Util.t('ui.setup_list_revert_title'))}">&#8630;</button>` : ''}
          ${permissions.matrixWrite ? `<button type="button" class="setup-list-delete" data-setup-list-delete title="${Util.escapeHtml(Util.t('btn.setup_list_delete_row'))}" aria-label="${Util.escapeHtml(Util.t('btn.setup_list_delete_row'))}">&times;</button>` : ''}
        </td>
      </tr>`;
    }).join('');
    const newRowsHtml = _listNewRows.map(row => {
      const status = listNewRowStatus(row, definition);
      return `<tr data-setup-list-new-row="${row.id}" class="setup-list-new-row">
        <td></td>
        <td><input type="text" class="input" placeholder="${Util.escapeHtml(Util.t('ph.setup_list_from'))}" value="${Util.escapeHtml(row.from)}" data-setup-list-new-from></td>
        <td><input type="text" class="input" placeholder="${Util.escapeHtml(Util.t('ph.setup_list_to'))}" value="${Util.escapeHtml(row.to)}" data-setup-list-new-to></td>
        <td><input type="text" class="input" placeholder="${Util.escapeHtml(Util.t('ph.setup_list_minutes'))}" value="${Util.escapeHtml(row.minutes)}" data-setup-list-new-minutes></td>
        <td class="setup-num">—</td>
        <td class="setup-list-new-status">${Util.escapeHtml(status)}</td>
        <td class="setup-num"><button type="button" class="setup-list-remove" data-setup-list-new-remove>&times;</button></td>
      </tr>`;
    }).join('');
    mount.innerHTML = `
      <table class="setup-table setup-list-table">
        <thead><tr>
          <th>${permissions.matrixWrite ? `<input type="checkbox" data-setup-list-select-all ${allSelected ? 'checked' : ''} aria-label="${Util.escapeHtml(Util.t('ui.setup_list_select_all'))}">` : ''}</th>
          <th>${Util.escapeHtml(Util.t('ui.setup_list_col_from'))}</th>
          <th>${Util.escapeHtml(Util.t('ui.setup_list_col_to'))}</th>
          <th class="setup-num">${Util.escapeHtml(Util.t('ui.setup_list_col_minutes'))}</th>
          <th class="setup-num">${Util.escapeHtml(Util.t('ui.setup_list_col_plant_value'))}</th>
          <th>${Util.escapeHtml(Util.t('ui.setup_list_col_source'))}</th>
          <th></th>
        </tr></thead>
        <tbody>${bodyRows}${newRowsHtml}</tbody>
      </table>
      <div class="setup-list-footer">
        ${permissions.matrixWrite ? `<button type="button" class="btn btn-ghost sm" data-setup-list-add-pair>${Util.escapeHtml(Util.t('ui.setup_list_add_pair'))}</button>` : '<span></span>'}
        <span class="setup-list-count">${Util.escapeHtml(Util.t('ui.setup_list_showing', { shown: rows.length, total: _listMeta.total, from: _gridFilterFrom || Util.t('ui.setup_plant_default') }))}</span>
        ${_listMeta.total > _listMeta.limit ? `<span class="setup-list-pager"><button type="button" class="btn btn-ghost sm" data-setup-list-page="prev" ${_listMeta.offset <= 0 ? 'disabled' : ''}>${Util.escapeHtml(Util.t('btn.setup_list_prev'))}</button><span>${Util.escapeHtml(Util.t('ui.setup_list_page', { from: _listMeta.offset + 1, to: Math.min(_listMeta.offset + _listMeta.limit, _listMeta.total), total: _listMeta.total }))}</span><button type="button" class="btn btn-ghost sm" data-setup-list-page="next" ${_listMeta.offset + _listMeta.limit >= _listMeta.total ? 'disabled' : ''}>${Util.escapeHtml(Util.t('btn.setup_list_next'))}</button></span>` : ''}
      </div>
      ${permissions.matrixWrite ? `
      <div class="setup-list-bulk-actions">
        <button type="button" class="btn btn-ghost sm" data-setup-list-delete-selected ${_listSelected.size ? '' : 'disabled'}>${Util.escapeHtml(Util.t('btn.setup_list_delete_selected', { count: _listSelected.size }))}</button>
        <div class="setup-list-delete-all">
          <label for="setup-list-delete-all-confirm">${Util.escapeHtml(Util.t('ui.setup_delete_all_hint', { plant: snapshot.plant }))}</label>
          <input type="text" id="setup-list-delete-all-confirm" class="input" data-setup-list-delete-all-confirm placeholder="${Util.escapeHtml(Util.t('ph.setup_delete_all_confirm', { plant: snapshot.plant }))}" value="${Util.escapeHtml(_deleteAllConfirmText)}">
          <button type="button" class="btn btn-danger sm" data-setup-list-delete-all ${deleteAllConfirmationMatches(_deleteAllConfirmText, snapshot.plant) ? '' : 'disabled'}>${Util.escapeHtml(Util.t('btn.setup_list_delete_all'))}</button>
        </div>
      </div>` : ''}`;
    wireListView(target, snapshot, definition, permissions);
  }

  function listNewRowStatus(row: { from: string; to: string; minutes: string }, definition: SetupDefinition): string {
    if (!row.from.trim() || !row.to.trim()) return Util.t('ui.setup_list_row_needs_states');
    if (!row.minutes.trim()) return Util.t('ui.setup_list_row_needs_minutes');
    const parsed = parseGridMinutes(row.minutes);
    if (parsed === 'invalid') return Util.t('ui.setup_list_row_bad_minutes');
    const fromKey = resolveFromKey(definition.fields, row.from);
    const toKey = resolveFromKey(definition.fields, row.to);
    if (!fromKey || !toKey) return Util.t('ui.setup_list_row_unknown_state');
    return Util.t('ui.setup_list_row_staged');
  }

  /** Wires the List view's minutes inputs, revert buttons, "Add pair" row,
   *  and the per-new-row inputs/remove button. Called at the end of every
   *  `paintListView` since the mount's innerHTML is fully replaced each time. */
  function wireListView(target: HTMLElement, snapshot: SetupSnapshot, definition: SetupDefinition, permissions: SetupPermissions): void {
    const mount = target.querySelector<HTMLElement>('#setup-list-mount');
    if (!mount) return;
    mount.querySelectorAll<HTMLButtonElement>('[data-setup-list-page]').forEach(button => {
      button.addEventListener('click', () => {
        const step = button.dataset.setupListPage === 'next' ? _listMeta.limit : -_listMeta.limit;
        _listMeta = { ..._listMeta, offset: Math.max(0, _listMeta.offset + step) };
        renderListView(target, snapshot, definition, permissions);
      });
    });
    mount.querySelectorAll<HTMLInputElement>('[data-setup-list-minutes]').forEach(input => {
      input.addEventListener('change', () => {
        const tr = input.closest<HTMLElement>('[data-setup-list-row-from]')!;
        const rowSig = tr.dataset.setupListRowFrom!, colSig = tr.dataset.setupListRowTo!;
        const row = _listRows.find(r => stateSig(r.from_key) === rowSig && stateSig(r.to_key) === colSig);
        if (!row) return;
        const parsed = parseGridMinutes(input.value);
        if (parsed === 'invalid') { Toast.show(Util.t('ui.setup_grid_invalid_minutes'), 'error'); input.value = row.setup_min === null ? '' : String(row.setup_min); return; }
        const key = `${rowSig} ${colSig}`;
        // A cleared input (`parsed === null`) is an explicit "remove this
        // value" and must always stage. It only collapses back to "no edit"
        // when the value it now matches genuinely exists: null === null
        // otherwise reads as "already equals the plant default" and silently
        // swallowed a clear on any override whose pair has no plant default.
        const revertsToPlantDefault = !!_lineScope && row.plant_value !== null && parsed === row.plant_value;
        const matchesPersistedValue = !_lineScope && row.setup_min !== null && parsed === row.setup_min;
        if (revertsToPlantDefault || matchesPersistedValue) _gridDirty.delete(key);
        else _gridDirty.set(key, { row: { key: row.from_key, sig: rowSig, parts: [] }, col: { key: row.to_key, sig: colSig, parts: [] }, setup_min: parsed, machine: _lineScope });
        refreshDirtyBar(target);
        paintListView(target, snapshot, definition, permissions);
      });
    });
    mount.querySelectorAll<HTMLButtonElement>('[data-setup-list-revert]').forEach(button => {
      button.addEventListener('click', () => {
        const tr = button.closest<HTMLElement>('[data-setup-list-row-from]')!;
        _gridDirty.delete(`${tr.dataset.setupListRowFrom} ${tr.dataset.setupListRowTo}`);
        refreshDirtyBar(target);
        paintListView(target, snapshot, definition, permissions);
      });
    });
    mount.querySelector<HTMLButtonElement>('[data-setup-list-add-pair]')?.addEventListener('click', () => {
      _listNewRows.push({ id: _listNextRowId++, from: '', to: '', minutes: '', stagedKey: null });
      paintListView(target, snapshot, definition, permissions);
    });
    mount.querySelectorAll<HTMLElement>('[data-setup-list-new-row]').forEach(tr => {
      const id = Number(tr.dataset.setupListNewRow);
      const row = _listNewRows.find(r => r.id === id);
      if (!row) return;
      tr.querySelector<HTMLInputElement>('[data-setup-list-new-from]')?.addEventListener('input', e => { row.from = (e.target as HTMLInputElement).value; refreshNewRowStatus(target, tr, row, definition); });
      tr.querySelector<HTMLInputElement>('[data-setup-list-new-to]')?.addEventListener('input', e => { row.to = (e.target as HTMLInputElement).value; refreshNewRowStatus(target, tr, row, definition); });
      tr.querySelector<HTMLInputElement>('[data-setup-list-new-minutes]')?.addEventListener('input', e => { row.minutes = (e.target as HTMLInputElement).value; refreshNewRowStatus(target, tr, row, definition); });
      tr.querySelector<HTMLButtonElement>('[data-setup-list-new-remove]')?.addEventListener('click', () => {
        // A removed draft row may already be staged in _gridDirty (its status
        // resolved to "staged" before removal) — drop that entry too, or an
        // orphaned edit lingers forever with nothing in the UI pointing at it.
        if (row.stagedKey) { _gridDirty.delete(row.stagedKey); refreshDirtyBar(target); }
        _listNewRows = _listNewRows.filter(r => r.id !== id);
        paintListView(target, snapshot, definition, permissions);
      });
    });

    // --- Workstream D3: per-row delete, multi-select bulk delete, and the
    // scope-level "delete all" typed confirmation ---------------------------
    mount.querySelector<HTMLInputElement>('[data-setup-list-select-all]')?.addEventListener('change', event => {
      const checked = (event.target as HTMLInputElement).checked;
      mount.querySelectorAll<HTMLInputElement>('[data-setup-list-select]').forEach(box => {
        if (checked) _listSelected.add(box.value); else _listSelected.delete(box.value);
      });
      paintListView(target, snapshot, definition, permissions);
    });
    mount.querySelectorAll<HTMLInputElement>('[data-setup-list-select]').forEach(box => {
      box.addEventListener('change', () => {
        if (box.checked) _listSelected.add(box.value); else _listSelected.delete(box.value);
        // Only the bulk-delete button and the select-all header need to
        // react — a full repaint here would drop keyboard/mouse focus mid
        // multi-select, same reasoning as refreshDirtyBar elsewhere.
        const bulkBtn = mount.querySelector<HTMLButtonElement>('[data-setup-list-delete-selected]');
        if (bulkBtn) { bulkBtn.disabled = _listSelected.size === 0; bulkBtn.textContent = Util.t('btn.setup_list_delete_selected', { count: _listSelected.size }); }
        const selectAll = mount.querySelector<HTMLInputElement>('[data-setup-list-select-all]');
        if (selectAll) {
          const onScreen = Array.from(mount.querySelectorAll<HTMLInputElement>('[data-setup-list-select]'));
          selectAll.checked = onScreen.length > 0 && onScreen.every(b => _listSelected.has(b.value));
        }
      });
    });
    mount.querySelectorAll<HTMLButtonElement>('[data-setup-list-delete]').forEach(button => {
      button.addEventListener('click', async () => {
        const tr = button.closest<HTMLElement>('[data-setup-list-row-from]')!;
        const rowSig = tr.dataset.setupListRowFrom!, colSig = tr.dataset.setupListRowTo!;
        const row = _listRows.find(r => stateSig(r.from_key) === rowSig && stateSig(r.to_key) === colSig);
        if (!row) return;
        const ok = await Modal.confirm({ title: Util.t('modal.setup_delete_row_confirm'), confirmLabel: Util.t('btn.yes_delete'), tone: 'warn' });
        if (!ok) return;
        await deleteMatrixRows(target, snapshot, definition, permissions, [row], 'row');
      });
    });
    mount.querySelector<HTMLButtonElement>('[data-setup-list-delete-selected]')?.addEventListener('click', async () => {
      const selectedRows = _listRows.filter(r => _listSelected.has(`${stateSig(r.from_key)} ${stateSig(r.to_key)}`));
      if (!selectedRows.length) return;
      const ok = await Modal.confirm({ title: Util.t('modal.setup_delete_bulk_confirm', { count: selectedRows.length }), confirmLabel: Util.t('btn.yes_delete'), tone: 'warn' });
      if (!ok) return;
      await deleteMatrixRows(target, snapshot, definition, permissions, selectedRows, 'bulk');
    });
    mount.querySelector<HTMLInputElement>('[data-setup-list-delete-all-confirm]')?.addEventListener('input', event => {
      _deleteAllConfirmText = (event.target as HTMLInputElement).value;
      const btn = mount.querySelector<HTMLButtonElement>('[data-setup-list-delete-all]');
      if (btn) btn.disabled = !deleteAllConfirmationMatches(_deleteAllConfirmText, snapshot.plant);
    });
    mount.querySelector<HTMLButtonElement>('[data-setup-list-delete-all]')?.addEventListener('click', async () => {
      // Belt-and-suspenders: the button is already disabled unless the typed
      // text matches, but never trust client-disabled state alone for a
      // destructive, scope-wide action.
      if (!deleteAllConfirmationMatches(_deleteAllConfirmText, snapshot.plant)) return;
      let allRows: Array<Pick<typeof _listRows[number], 'from_key' | 'to_key' | 'setup_min'>>;
      try { allRows = await collectAllScopeRows(snapshot.plant, _lineScope); }
      catch (error) { Toast.show(Util.t('toast.save_failed', { msg: (error as Error).message }), 'error'); return; }
      if (!allRows.length) { Toast.show(Util.t('toast.setup_no_rows_to_delete'), 'warn'); return; }
      await deleteMatrixRows(target, snapshot, definition, permissions, allRows, 'all');
    });
  }

  /** Refreshes one new-pair row's status cell live as its inputs change, and
   *  (only once the row fully resolves to "staged") writes it into
   *  `_gridDirty` under the same `${fromSig} ${toSig}` key every other List
   *  edit uses, so it rides the existing Save/Discard machinery unchanged.
   *  `row.stagedKey` tracks whichever key the row is *currently* staged
   *  under — recomputing the key fresh from the row's current from/to text
   *  every call means an edit that changes which state pair it resolves to
   *  (e.g. From: A→C, still valid) must drop the *previous* key first, or
   *  that stale entry lingers in `_gridDirty` forever with nothing in the UI
   *  pointing at it. Same when the row stops resolving to "staged" at all
   *  (e.g. minutes cleared) — the last-staged key must still be dropped. */
  function refreshNewRowStatus(target: HTMLElement, tr: HTMLElement, row: { from: string; to: string; minutes: string; stagedKey: string | null }, definition: SetupDefinition): void {
    const status = listNewRowStatus(row, definition);
    const statusCell = tr.querySelector('.setup-list-new-status');
    if (statusCell) statusCell.textContent = status;
    if (status === Util.t('ui.setup_list_row_staged')) {
      const fromKey = resolveFromKey(definition.fields, row.from)!;
      const toKey = resolveFromKey(definition.fields, row.to)!;
      const parsed = parseGridMinutes(row.minutes) as number;
      const key = `${stateSig(fromKey)} ${stateSig(toKey)}`;
      if (row.stagedKey && row.stagedKey !== key) _gridDirty.delete(row.stagedKey);
      _gridDirty.set(key, { row: { key: fromKey, sig: stateSig(fromKey), parts: fromKey.map(p => p.value) },
                            col: { key: toKey, sig: stateSig(toKey), parts: toKey.map(p => p.value) },
                            setup_min: parsed, machine: _lineScope });
      row.stagedKey = key;
      refreshDirtyBar(target);
    } else if (row.stagedKey) {
      _gridDirty.delete(row.stagedKey);
      row.stagedKey = null;
      refreshDirtyBar(target);
    }
  }

  /** Drops every staged edit — both the `_gridDirty` map and the List view's
   *  "Add pair" draft rows, which are a second, *visible* representation of
   *  the same pending state. Clearing only `_gridDirty` left drafts on screen
   *  still labelled "Staged — unsaved": after a Save they sat next to the now
   *  real, persisted row for the same pair (a duplicate), and after a Discard
   *  they claimed to be staged while the dirty count read 0 and Save was
   *  disabled. Both callers (Save success, Discard) repaint straight after. */
  function discardStagedEdits(): void {
    _gridDirty.clear();
    _listNewRows = [];
  }

  /** Refreshes only the dirty-count readout and Save/Discard button state —
   *  the same two DOM writes paintGrid() does at its top, factored out so
   *  List-view and mass-upload edits (which never touch the Matrix grid's
   *  _gridModel/rows) can react to _gridDirty changes without repainting or
   *  corrupting the Matrix mount with a stale/empty rows array. */
  function refreshDirtyBar(target: HTMLElement): void {
    const dirtyCount = target.querySelector<HTMLElement>('[data-setup-grid-dirty-count]');
    if (dirtyCount) dirtyCount.textContent = Util.t('ui.setup_grid_dirty_count', { count: _gridDirty.size });
    target.querySelector<HTMLButtonElement>('[data-setup-grid-discard]')?.toggleAttribute('disabled', _gridDirty.size === 0);
    target.querySelector<HTMLButtonElement>('[data-setup-grid-save]')?.toggleAttribute('disabled', _gridDirty.size === 0);
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
    const reviewPairs = review ? review.pairs.filter(pair => _missingReviewFilter === 'all'
      || (_missingReviewFilter === 'state' && pair.reason === 'initial-state-unknown')
      || (_missingReviewFilter === 'row' && pair.reason === 'scheduled-without-setup')) : null;
    const reviewSigs = reviewPairs
      ? new Set(reviewPairs.flatMap(pair => [reviewStateSigFromText(pair.fromState), reviewStateSigFromText(pair.toState)]).filter((sig): sig is string => sig !== null))
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
      ? `<p class="setup-grid-cap-note">${Util.escapeHtml(Util.t('ui.setup_grid_axis_capped', { shown: Math.max(rowStates.length, colStates.length), total: Math.max(rowAxis.total, colAxis.total) }))}</p>`
      : '';
    // "You are here" (§9-C.5): mark the row matching the scoped line's known
    // current state, making the old standalone Line Status panel unnecessary.
    const currentState = _lineScope && definition
      ? snapshot.machine_states.find(s => s.machine === _lineScope && s.signature_version === definition.signature_version)
      : undefined;
    const currentStateSig = currentState ? stateSig(currentState.state_key) : null;
    const tierCount = fields.length;
    const theadRows: string[] = [];
    for (let tier = 0; tier < tierCount; tier++) {
      const runs = tierRuns(colStates, tier);
      const corner = tier === 0 ? `<th rowspan="${tierCount}" colspan="${tierCount}" class="setup-grid-corner"></th>` : '';
      theadRows.push(`<tr>${corner}${runs.map(run => `<th colspan="${run.span}" class="setup-grid-col-head">${Util.escapeHtml(run.value)}</th>`).join('')}</tr>`);
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
        const mark = youAreHere && tier === tierCount - 1 ? `<span class="setup-grid-here-badge" title="${Util.escapeHtml(Util.t('ui.setup_you_are_here_hint', { line: _lineScope }))}">${Util.escapeHtml(Util.t('ui.setup_you_are_here'))}</span>` : '';
        return `<th rowspan="${span}" scope="row" class="setup-grid-row-head">${Util.escapeHtml(rowState.parts[tier] ?? '')}${mark}</th>`;
      }).join('');
      const dataCells = colStates.map((colState, c) => {
        const existing = _gridModel!.cellLookup.get(rowState.sig)?.get(colState.sig);
        const dirty = _gridDirty.get(gridEditKey(rowState, colState));
        const value = gridCellValue(rowState, colState, existing, dirty);
        const missing = value === null;
        const cellState = gridCellState(rowState, colState, existing, dirty, _lineScope);
        const cellClass = ['setup-grid-td', `setup-grid-${cellState}`, permissions.matrixWrite ? 'setup-grid-editable' : ''].filter(Boolean).join(' ');
        const display = cellState === 'uncovered' ? '&middot;' : (value !== null ? Util.escapeHtml(String(value)) : '');
        const title = cellState === 'uncovered' ? Util.t('ui.setup_grid_uncovered_hint')
          : cellState === 'implicit-zero' ? Util.t('ui.setup_grid_implicit_zero_hint')
          : cellState === 'line-override' ? Util.t('ui.setup_grid_line_override_hint') : '';
        return `<td class="${cellClass}" data-setup-grid-row="${r}" data-setup-grid-col="${c}" data-missing="${missing}" ${permissions.matrixWrite ? 'tabindex="0"' : ''}${title ? ` title="${Util.escapeHtml(title)}"` : ''}>${display}</td>`;
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
   *  docs/archive/setup_matrix_ui_redesign.md §5), adapted for the grid's row/col
   *  state axes instead of group/week axes. Wired once per `target` (the
   *  panel host persists across renderSnapshot() repaints; only its
   *  innerHTML is replaced), guarded by a dataset flag exactly like
   *  LaborPlanning's `grid._lpDragWired`. Edits are staged into `_gridDirty`,
   *  never written until an explicit Save. */
  function wireGridInteractions(target: HTMLElement, snapshot0: SetupSnapshot, definition0: SetupDefinition | null, rows0: EffectiveSetupRow[], permissions0: SetupPermissions): void {
    const flagged = target as unknown as { _setupGridWired?: boolean; _setupGridCtx?: GridWireCtx };
    // The listeners below are wired once per target but outlive many repaints; they read
    // the CURRENT render's data through this shared ctx (refreshed on every call), never
    // the first render's closure (stale rows/permissions after a reload or role change).
    flagged._setupGridCtx = { snapshot: snapshot0, definition: definition0, rows: rows0, permissions: permissions0 };
    if (flagged._setupGridWired) return;
    flagged._setupGridWired = true;
    const ctx = (): GridWireCtx => flagged._setupGridCtx!;

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
      else _gridDirty.set(editKey, { row: rowState, col: colState, setup_min: value, machine: _lineScope });
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
      const { snapshot, definition, rows, permissions } = ctx();
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
      const { snapshot, definition, rows, permissions } = ctx();
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
    else _gridDirty.set(editKey, { row, col, setup_min: parsed, machine: _lineScope });
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
  function wireGridEditor(target: HTMLElement, snapshot0: SetupSnapshot, definition0: SetupDefinition | null, rows0: EffectiveSetupRow[], permissions0: SetupPermissions): void {
    const flagged = target as unknown as { _setupGridEditorWired?: boolean; _setupGridEditorCtx?: GridWireCtx };
    flagged._setupGridEditorCtx = { snapshot: snapshot0, definition: definition0, rows: rows0, permissions: permissions0 };
    if (flagged._setupGridEditorWired) return;
    flagged._setupGridEditorWired = true;
    target.addEventListener('click', event => {
      const { snapshot, definition, rows, permissions } = flagged._setupGridEditorCtx!;
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
    const { upsert, deletes } = buildSaveRequests(edits, definition.signature_version, existingPlantRows, snapshot.plant_matrix_token);
    try {
      for (const body of upsert) {
        const response = await Util.fetchTraced(`${API}/setup/${encodeURIComponent(snapshot.plant)}/matrix/import`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
        if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(Util.errorDetailText(err.detail) || `HTTP ${response.status}`); }
      }
      for (const body of deletes) {
        const response = await Util.fetchTraced(`${API}/setup/${encodeURIComponent(snapshot.plant)}/matrix`, { method: 'DELETE', headers: headers(), body: JSON.stringify(body) });
        if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(Util.errorDetailText(err.detail) || `HTTP ${response.status}`); }
      }
      Persistence.noteSetupWrite(snapshot.plant, 'matrix');
      discardStagedEdits();
      await Persistence.loadSetupSnapshot(snapshot.plant);
      render(target, snapshot.plant);
      Toast.show(Util.t('toast.setup_saved'), 'success');
    } catch (error) {
      Toast.show(Util.t('toast.save_failed', { msg: (error as Error).message }), 'error');
    }
  }

  /** Workstream D2 (2026-08-20): re-pointed from PUT /setup/{plant}/active
   *  (the vestigial per-signature-version write) to the new plant-level
   *  PUT /plant/{plant}/setup-active — no `definition`/`expected_signature_version`
   *  needed any more since this is a durable plant setting, not a
   *  signature-scoped one. `target` stays the Setup Matrix pane's own root
   *  element so writeAndRefresh's post-write `render()` keeps that pane's
   *  status chip current even when called from elsewhere (the relocated
   *  checkbox in Plant._renderSettingsPane's Scheduling Rules panel). */
  async function setSetupActive(target: HTMLElement, plant: string, active: boolean): Promise<boolean> {
    return writeAndRefresh(target, plant, `${API}/plant/${encodeURIComponent(plant)}/setup-active`, 'PUT', { active });
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
      if (parsed.machine !== _lineScope) throw new Error('CSV line scope must match the selected setup scope');
      // Plant-default scope is a destructive delete-then-insert replace
      // (setup_data.replace_plant_matrix) — unlike a line-scoped import, which
      // is a safe sparse upsert — so confirm before an admin silently wipes
      // every other plant-default row for this signature version.
      if (!parsed.machine) {
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
        machine: parsed.machine, signature_version: parsed.signature_version, rows: parsed.rows,
        ...(parsed.machine ? {} : { plant_matrix_token: snapshot.plant_matrix_token }),
      });
    } catch (error) { Toast.show(Util.t('toast.save_failed', { msg: (error as Error).message }), 'error'); }
    finally { input.value = ''; }
  }

  function mountStateEditor(host: HTMLElement, snapshot: SetupSnapshot, line: string, onSaved?: () => void): void {
    const definition = snapshot.definition; if (!line || !definition || host.querySelector('[data-setup-state-editor]')) return;
    const current = snapshot.machine_states.find(state => state.machine === line);
    const initial = new Map((current?.state_key || []).map(pair => [pair.fieldKey, pair.value]));
    const editor = document.createElement('div'); editor.className = 'setup-state-editor'; editor.dataset.setupStateEditor = 'true';
    editor.innerHTML = `${definition.fields.map(field => `<label>${Util.escapeHtml(field)}<input class="input" data-setup-state-field="${Util.escapeHtml(field)}" value="${Util.escapeHtml(initial.get(field) || '')}"></label>`).join('')}<label>${Util.escapeHtml(Util.t('ui.setup_observed_at'))}<input class="input" data-setup-observed-at></label><label>Shop-floor reason<input class="input" data-setup-state-reason></label><button class="btn btn-primary sm" data-setup-save-state>${Util.escapeHtml(Util.t('btn.save'))}</button>`;
    host.appendChild(editor);
    const observed = editor.querySelector<HTMLInputElement>('[data-setup-observed-at]')!;
    const reason = editor.querySelector<HTMLInputElement>('[data-setup-state-reason]')!;
    const fp = Util.fpDatetime(observed); fp.setDate(new Date(), false);
    editor.querySelector<HTMLButtonElement>('[data-setup-save-state]')!.addEventListener('click', async () => {
      const values = definition.fields.map(field => ({ fieldKey: field, value: editor.querySelector<HTMLInputElement>(`[data-setup-state-field="${CSS.escape(field)}"]`)?.value.trim() || '' }));
      if (values.some(pair => !pair.value)) { Toast.show(Util.t('ui.setup_state_fields_required'), 'error'); return; }
      if (!observed.value.trim()) { Toast.show('Observed time is required.', 'error'); observed.focus(); return; }
      if (!reason.value.trim()) { Toast.show('A shop-floor reason is required.', 'error'); reason.focus(); return; }
      fp.destroy();
      saveStateAndRefresh(snapshot.plant, line, { values, signature_version: definition.signature_version, observed_at: observed.value, source: 'manual', reason: reason.value.trim() }).then(saved => { if (saved) onSaved?.(); });
    });
  }

  async function editState(target: HTMLElement, snapshot: SetupSnapshot): Promise<void> {
    if (!_lineScope) return;
    const panel = target.querySelector<HTMLElement>('[data-setup-state-inline]');
    if (panel) mountStateEditor(panel, snapshot, _lineScope, () => render(target, snapshot.plant));
  }

  async function saveStateAndRefresh(plant: string, line: string, body: unknown): Promise<boolean> {
    try {
      const response = await Util.fetchTraced(`${API}/setup/${encodeURIComponent(plant)}/lines/${encodeURIComponent(line)}/state`, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
      if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.detail || `HTTP ${response.status}`); }
      Persistence.noteSetupWrite(plant, 'state'); await Persistence.loadSetupSnapshot(plant); Toast.show(Util.t('toast.setup_saved'), 'success'); return true;
    } catch (error) { Toast.show(Util.t('toast.save_failed', { msg: (error as Error).message }), 'error'); return false; }
  }

  async function wireCompatibility(target: HTMLElement, snapshot: SetupSnapshot): Promise<void> {
    const line = _lineScope;
    const cacheKey = `${snapshot.plant}\u0000${line}`;
    const saved = _compatibilityByLine[cacheKey];
    const compatible = saved?.setup_compatible !== false;
    const statePanel = target.querySelector('[data-setup-state-inline]');
    if (!statePanel) return;
    const compat = document.createElement('div'); compat.className = 'setup-compatibility';
    compat.innerHTML = `<label class="setup-check"><input type="checkbox" data-setup-compatible ${compatible ? 'checked' : ''}>${Util.escapeHtml(Util.t('ui.setup_compatibility'))}</label><input class="input" data-setup-compatibility-reason placeholder="${Util.escapeHtml(Util.t('ui.setup_compatibility_reason'))}" value="${Util.escapeHtml(saved?.setup_compatibility_reason || '')}" ${compatible ? 'disabled' : ''}><button class="btn btn-ghost sm" data-setup-save-compatibility disabled>${Util.escapeHtml(Util.t('btn.save'))}</button><p>${Util.escapeHtml(Util.t('ui.setup_not_global_exclusion'))}</p>`;
    statePanel.appendChild(compat);
    const checkbox = compat.querySelector<HTMLInputElement>('[data-setup-compatible]')!;
    const reason = compat.querySelector<HTMLInputElement>('[data-setup-compatibility-reason]')!;
    const save = compat.querySelector<HTMLButtonElement>('[data-setup-save-compatibility]')!;
    let baseline = { compatible, reason: saved?.setup_compatibility_reason || '' };
    let saving = false;
    const sync = () => {
      reason.disabled = checkbox.checked || saving;
      checkbox.disabled = saving;
      save.disabled = saving || (checkbox.checked === baseline.compatible
        && (checkbox.checked || reason.value.trim() === baseline.reason));
    };
    const persist = async () => {
      if (saving) return;
      if (!checkbox.checked && !reason.value.trim()) { reason.focus(); Toast.show(Util.t('ui.setup_reason_required'), 'error'); return; }
      const next = { compatible: checkbox.checked, reason: checkbox.checked ? '' : reason.value.trim() };
      saving = true; sync();
      try {
        const response = await Util.fetchTraced(`${API}/setup/${encodeURIComponent(snapshot.plant)}/lines/${encodeURIComponent(line)}/compatibility`, { method: 'PUT', headers: headers(), body: JSON.stringify({ setup_compatible: next.compatible, reason: next.reason }) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        Persistence.noteSetupWrite(snapshot.plant, 'override');
        baseline = next;
        _compatibilityByLine[cacheKey] = { setup_compatible: next.compatible, setup_compatibility_reason: next.reason || null };
        Toast.show(Util.t('toast.line_settings_updated'), 'success');
      } catch (error) { Toast.show(Util.t('toast.save_failed', { msg: (error as Error).message }), 'error'); }
      finally { saving = false; sync(); }
    };
    checkbox.addEventListener('change', () => { sync(); if (!checkbox.checked) reason.focus(); });
    reason.addEventListener('input', sync);
    save.addEventListener('click', persist);
  }

  /** Returns whether the write actually succeeded (Workstream D2 added this —
   *  every prior caller just `await`s without reading it, so this stays
   *  backward compatible; the new relocated setup-active checkbox is the
   *  first caller that needs to know, to decide whether to commit or revert
   *  its own optimistic local state). */
  async function writeAndRefresh(target: HTMLElement, plant: string, url: string, method: string, body: unknown): Promise<boolean> {
    try {
      const response = await Util.fetchTraced(url, { method, headers: headers(), body: JSON.stringify(body) });
      if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(Util.errorDetailText(err.detail) || `HTTP ${response.status}`); }
      Persistence.noteSetupWrite(plant, setupWriteKind(url));
      await Persistence.loadSetupSnapshot(plant); render(target, plant); Toast.show(Util.t('toast.setup_saved'), 'success');
      return true;
    } catch (error) { Toast.show(Util.t('toast.save_failed', { msg: (error as Error).message }), 'error'); return false; }
  }

  return {
    _wireCompatibilityForTest: (target: HTMLElement, snapshot: SetupSnapshot, line: string, compatible: boolean) => {
      _lineScope = line;
      _compatibilityByLine[`${snapshot.plant}\u0000${line}`] = { setup_compatible: compatible, setup_compatibility_reason: compatible ? null : 'Blocked' };
      return wireCompatibility(target, snapshot);
    }, permissionsFor, canWriteVersion, activationStatus, effectiveRows, deleteRequest, deleteAllConfirmationMatches, removeSignatureField, csvColumns, missingPairsCsv, reviewAction, canReviewMissingPairs, reviewNavigation, reviewMissingPairs, registeredFields, parseLongFormCsv, collectPagedLines, mountStateEditor, render, invalidatePlant, setSetupActive,
    // Grid helpers — exported for direct unit testing, matching this file's
    // existing pattern of testing pure logic without a DOM harness.
    stateSig, fieldValueSet, cartesianStates, resolveFromKey, parseMassUploadText, createDebouncedValidator, buildGridModel, filterStates, tierRuns, gridCellValue, gridCellState, capAxis, parseGridMinutes, buildSaveRequests, fieldLabel, reviewStateSigFromText,
    // Exported for direct unit testing of the "delete all rows in scope"
    // and List-view-page request shapes (mock Util.fetchTraced's underlying
    // fetch and assert on the URL) — same rationale as the grid helpers
    // above, extended to these two network-calling functions because their
    // query-param name is exactly the kind of regression a DOM-level test
    // wouldn't catch here.
    collectAllScopeRows, fetchListRows };
})();
