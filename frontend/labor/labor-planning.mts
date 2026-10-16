// labor/labor-planning.mjs — aggregate-to-line available labor hours
// planning. Extracted verbatim from plant-and-administration.mts (Phase P2
// of docs/architecture/domain-refactor-plan.md, which split that
// 11,308-line mega-module into 9 domain files).
import { Config, Util, ErrorLog, Toast } from '../platform/foundation.mjs';
import { Store, UndoStack } from '../platform/store.mjs';
import { Calendar } from '../calendar/calendar-engine.mjs';
import { Utilization } from '../insights/services.mjs';
import { Session } from '../security/session.mjs';
// Injected getter seam so LaborPlanning can ask "am I currently the
// visible tab/sub-tab?" without a bare reference to `App` — see
// shell/tab-resolvers.mts.
import { getActiveTabResolvers } from '../shell/tab-resolvers.mjs';

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
  wc_group: string;
  period: string;
  avail_hours: number | null;
}

/** `POST /labor-plan/line` cell payload (line/day hours + provenance). */
interface LaborLineCellPayload {
  machine: string;
  day: string;
  avail_hours: number | null;
  source: LaborCellSource;
}

type LaborWriteIntent = 'reconcile' | 'explicit' | 'undo';
interface LaborBatchResult {
  lines: {
    rows: LaborLineCellPayload[];
    applied: Array<{ machine: string; day: string }>;
    skipped: LaborLineCellPayload[];
  };
}

interface LaborInputSubmission {
  input: HTMLInputElement;
  value: string;
  revision: number;
}

/** `_disaggregate`'s return shape — same wire shape as `LaborLineCellPayload`
 *  but `avail_hours` is always concrete (an even split always produces a
 *  number, unlike a user-initiated clear-to-null edit). */
interface LaborDisaggregatedCell {
  machine: string;
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
  let _groupSearch = '';
  let _lineSearch = ''; // current search text for the cross-screen line-filter dropdown
  let _aggrData: LaborAggrData = {};        // { [plant]: { [grp]: { [period]: avail_hours } } }
  let _lineData: LaborLineData = {};        // { [plant]: { [line]: { [day]: { avail_hours, source } } } }
  let _groups: string[]       = [];        // sorted unique wc_group values for current plant
  let _displayGroups: string[] = [];        // currently rendered subset (respects _selectedGroups filter)
  let _weeks: LaborWeek[]        = [];   // [{ key:'YYYY-Www', label:'MM/DD/YY', monday:Date }]
  let _selRange: LaborSelRange | null       = null; // { r0,c0,r1,c1 } lasso rectangle, or null
  let _dragging      = false;
  let _dragAnchor: LaborDragAnchor | null     = null;
  let _fpHorizon: NimbusVendor.FlatpickrInstance | null      = null; // Flatpickr instance for the date-jump input
  let _cellGrid: LaborCellGrid | null       = null; // [r][c] -> <td> cache for the Aggregate grid (built per render)
  let _selTds: Set<HTMLTableCellElement>        = new Set(); // currently-highlighted <td>s, for incremental lasso diffing
  // Generation counter to suppress stale responses on rapid plant switching: capture
  // the current generation before any async fetch, then after the response resolves,
  // check whether a newer render has since started for a different plant; if so,
  // discard the stale response instead of applying it. Mirrors persistence.mts's
  // pattern for setup snapshots (see that module's _setupSnapshotGeneration).
  let _plantSwitchGeneration = 0;
  let _lastPlant: string | null = null;

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
    monday.setHours(0, 0, 0, 0);
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
  function _lineCellTitle(line: string, day: string, avail: number, req: number, cap: number, pinned: boolean): string {
    return Util.t('labor.line_cell_title', { line, day, available: avail.toFixed(1), required: req.toFixed(1), capacity: cap.toFixed(1) })
      + (pinned ? ` | ${Util.t('labor.pinned')}` : '');
  }

  function _subnetwork(plant: string | null): string {
    return (Store._state.masterData?.plants || []).find((p) => p.plant === plant)?.subnetwork || '';
  }

  async function _saveAggregate(subnetwork: string, plant: string, cells: LaborAggrCellPayload[], line_cells: LaborLineCellPayload[], intent: LaborWriteIntent): Promise<LaborBatchResult | null> {
    try {
      const r = await Util.fetchTraced(`${Config.API_BASE}/labor-plan/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
        body: JSON.stringify({ subnetwork, plant, cells, line_cells, intent }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(Util.errorDetailText(e.detail) || `HTTP ${r.status}`); }
      const result = await r.json() as LaborBatchResult;
      if (!Array.isArray(result.lines?.rows) || !Array.isArray(result.lines?.applied) || !Array.isArray(result.lines?.skipped))
        throw new Error(Util.t('labor.invalid_save_response'));
      return result;
    } catch (e) {
      Toast.show(Util.t('labor.save_failed', { error: (e as Error).message }), 'error');
      ErrorLog.error('labor', `Save aggregate failed: ${(e as Error).message}`);
      return null;
    }
  }

  let _writeQueue: Promise<unknown> = Promise.resolve();
  let _dataRevision = 0;
  const _refreshPlants = new Set<string>();
  const _inputRevisions = new WeakMap<HTMLInputElement, number>();
  let _patchLineGrid: ((plant: string, cells?: LaborLineCellPayload[], submission?: LaborInputSubmission) => void) | null = null;

  function _submission(input: HTMLInputElement): LaborInputSubmission {
    const revision = (_inputRevisions.get(input) || 0) + 1;
    _inputRevisions.set(input, revision);
    return { input, value: input.value, revision };
  }
  let _focusCell: { line: string; day: string } | null = null;

  function _enqueue(write: () => Promise<boolean>): Promise<boolean> {
    const result = _writeQueue.then(write);
    _writeQueue = result.catch(() => false);
    return result;
  }

  function _applySaved(plant: string, cells: LaborAggrCellPayload[], lines: LaborLineCellPayload[]): void {
    _dataRevision++;
    _aggrData[plant] ||= {};
    _lineData[plant] ||= {};
    cells.forEach(c => {
      const group = _aggrData[plant][c.wc_group] ||= {};
      if (c.avail_hours == null) delete group[c.period]; else group[c.period] = c.avail_hours;
    });
    lines.forEach(c => {
      const line = _lineData[plant][c.machine] ||= {};
      if (c.avail_hours == null) delete line[c.day]; else line[c.day] = { avail_hours: c.avail_hours, source: c.source };
    });
  }

  function _refreshSavedCells(plant: string, changed?: LaborAggrCellPayload[], submission?: LaborInputSubmission): void {
    if (Store.selectedPlant !== plant) return;
    const grid = document.getElementById('labor-grid');
    grid?.querySelectorAll<HTMLInputElement>('.lp-cell').forEach(inp => {
      if (changed && !changed.some(c => c.wc_group === inp.dataset.group && c.period === inp.dataset.period)) return;
      const value = _aggrData[plant]?.[inp.dataset.group!]?.[inp.dataset.period!];
      const savedValue = value == null ? '' : String(value);
      const ownSubmission = !!submission && submission.input === inp && submission.revision === _inputRevisions.get(inp)
        && inp.value === submission.value;
      const newerDraft = !!submission && submission.input === inp && submission.revision !== _inputRevisions.get(inp);
      // Acknowledgements and Undo may update clean inputs, but must retain drafts
      // typed after submission, including drafts in unrelated aggregate cells.
      if ((!newerDraft && inp.value === inp.dataset.savedValue) || ownSubmission) inp.value = savedValue;
      inp.dataset.savedValue = savedValue;
    });
    if (grid) _updateAggrTotals(grid);
    _renderKPIs(plant);
  }

  function _edit(plant: string, cells: LaborAggrCellPayload[], lineCells: LaborLineCellPayload[], label: string, submission?: LaborInputSubmission): Promise<boolean> {
    return _enqueue(async () => {
      const derived = cells.flatMap(c => {
        // Clear obsolete automatic days too, while preserving pinned overrides.
        const proposed = c.avail_hours == null ? [] : _disaggregate(plant, c.wc_group, c.period, c.avail_hours);
        const byKey = new Map<string, LaborLineCellPayload>(proposed.map(v => [`${v.machine}|${v.day}`, v]));
        Store.masterLinesForPlant(plant).filter(l => l.wc_group === c.wc_group).forEach(l => {
          Object.entries(_lineData[plant]?.[l.machine] || {}).forEach(([day, old]) => {
            if (_isoWeek(new Date(`${day}T12:00:00`)) !== c.period || old.source === 'override') return;
            const key = `${l.machine}|${day}`;
            if (!byKey.has(key)) byKey.set(key, { machine: l.machine, day, avail_hours: null, source: 'auto_split' });
          });
        });
        return [...byKey.values()].filter(v => _lineData[plant]?.[v.machine]?.[v.day]?.source !== 'override');
      });
      const changes = [...derived, ...lineCells];
      const prior = cells.map(c => ({ ...c, avail_hours: _aggrData[plant]?.[c.wc_group]?.[c.period] ?? null }));
      const priorLines = changes.map(c => ({ ...c, avail_hours: _lineData[plant]?.[c.machine]?.[c.day]?.avail_hours ?? null,
        source: _lineData[plant]?.[c.machine]?.[c.day]?.source ?? 'auto_split' as LaborCellSource }));
      const sn = _subnetwork(plant);
      const ok = await _saveAggregate(sn, plant, cells, changes, cells.length ? 'reconcile' : 'explicit');
      if (ok) {
        _applySaved(plant, cells, ok.lines.rows);
        if (ok.lines.skipped.length) Toast.show(Util.t('labor.pins_preserved', { count: ok.lines.skipped.length }), 'info');
      }
      // A concurrent pin skipped by the server was never changed by this edit;
      // exclude it from Undo rather than restoring the stale browser snapshot.
      const undoLines = ok ? priorLines.filter(c => ok.lines.applied.some(a => a.machine === c.machine && a.day === c.day)) : [];
      _refreshSavedCells(plant, cells, submission);
      _patchLineGrid?.(plant, changes, submission);
      if (ok) UndoStack.push(label, () => _enqueue(async () => {
        const restored = await _saveAggregate(sn, plant, prior, undoLines, 'undo');
        if (restored) _applySaved(plant, prior, restored.lines.rows);
        _refreshSavedCells(plant, prior);
        if (restored && Store.selectedPlant === plant) _refreshActiveCached(plant);
        return !!restored;
      }));
      return !!ok;
    });
  }

  async function _fetchAggregate(plant: string): Promise<Record<string, Record<string, number>>> {
    if (_aggrData[plant]) return _aggrData[plant];
    const generation = _plantSwitchGeneration, revision = _dataRevision;
    try {
      const res = await Util.fetchTraced(`${Config.API_BASE}/labor-plan?plant=${encodeURIComponent(plant)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const map: Record<string, Record<string, number>> = {};
      (json.rows || []).forEach((r: { wc_group: string; period: string; avail_hours: number }) => {
        if (!map[r.wc_group]) map[r.wc_group] = {};
        map[r.wc_group][r.period] = r.avail_hours;
      });
      if (generation === _plantSwitchGeneration && revision === _dataRevision) _aggrData[plant] = map;
      return map;
    } catch (e) {
      ErrorLog.warn('labor', `Fetch aggregate failed for ${plant}: ${(e as Error).message}`);
      throw e;
    }
  }

  async function _fetchLines(plant: string, group: string | null): Promise<void> {
    const generation = _plantSwitchGeneration, revision = _dataRevision;
    const w0 = _weeks[0], wN = _weeks[_weeks.length - 1];
    const from_date = Util.dayKey(w0.monday);
    const toDate    = new Date(wN.monday); toDate.setDate(wN.monday.getDate() + 6);
    const to_date   = Util.dayKey(toDate);
    try {
      let url = `${Config.API_BASE}/labor-plan/line?plant=${encodeURIComponent(plant)}&from_date=${from_date}&to_date=${to_date}`;
      if (group) url += `&group=${encodeURIComponent(group)}`;
      const res = await Util.fetchTraced(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (generation !== _plantSwitchGeneration || revision !== _dataRevision) return;
      if (!_lineData[plant]) _lineData[plant] = {};
      Store.masterLinesForPlant(plant).filter(l => !group || l.wc_group === group).forEach(l => {
        Object.keys(_lineData[plant][l.machine] || {}).forEach(day => {
          if (day >= from_date && day <= to_date) delete _lineData[plant][l.machine][day];
        });
      });
      (json.rows || []).forEach((r: { machine: string; day: string; avail_hours: number; source: LaborCellSource }) => {
        if (!_lineData[plant][r.machine]) _lineData[plant][r.machine] = {};
        _lineData[plant][r.machine][r.day] = { avail_hours: r.avail_hours, source: r.source };
      });
    } catch (e) {
      ErrorLog.warn('labor', `Fetch lines failed: ${(e as Error).message}`);
      throw e;
    }
  }

  // ── Disaggregation ───────────────────────────────────────────────────────
  function _disaggregate(plant: string, group: string, periodKey: string, groupHours: number): LaborDisaggregatedCell[] {
    const lines = (Store._state.masterData?.lines || [])
      .filter((l) => l.plant === plant && l.wc_group === group)
      .map((l) => l.machine);
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
    return openSlots.map(s => ({ machine: s.line, day: s.dayKey, avail_hours: rounded, source: 'auto_split' as const }));
  }

  // ── KPI strip ────────────────────────────────────────────────────────────
  function _visibleGroups(): string[] {
    const groups = _selectedGroups.size ? _groups.filter(g => _selectedGroups.has(g)) : _groups;
    if (!Store.selectedLines.size || !Store.selectedPlant) return groups;
    const lineGroups = new Set(_visibleLines(Store.selectedPlant).map(l => l.wc_group));
    return groups.filter(g => lineGroups.has(g));
  }

  function _visibleLines(plant: string) {
    return Store.masterLinesForPlant(plant).filter(l =>
      (!_selectedGroups.size || _selectedGroups.has(l.wc_group || '')) &&
      (!Store.selectedLines.size || Store.selectedLines.has(l.machine)));
  }

  function _renderKPIs(plant: string | null): void {
    const strip = document.getElementById('labor-kpi-strip');
    if (!strip || !plant) { if (strip) strip.innerHTML = ''; return; }

    let totalAvail = 0;
    const horizonStart = _weeks[0]?.monday || new Date();
    const horizonDays  = _horizonSpan * 7;
    const matrix: LaborUtilMatrix = Utilization.computeMatrix(horizonStart, horizonDays);
    const plantLines = _visibleLines(plant).map(r => r.machine);
    let totalRequired = 0;
    plantLines.forEach((line) => {
      const lm = matrix[line]; if (!lm) return;
      Object.entries(lm).forEach(([day, cell]) => {
        totalRequired += cell.scheduled || 0;
        totalAvail += _lineData[plant]?.[line]?.[day]?.avail_hours ?? cell.effectiveCapacity ?? 0;
      });
    });

    const diff     = totalAvail - totalRequired;
    const headroom = totalAvail > 0 ? Math.round((diff / totalAvail) * 100) : (totalRequired > 0 ? -100 : 0);
    const hSev     = headroom < 0 ? 'err' : headroom < 15 ? 'warn' : '';

    let shortfalls = 0, exceptionCount = 0;
    plantLines.forEach((line) => {
      const lm = matrix[line]; if (!lm) return;
      Object.entries(lm).forEach(([dayKey, cell]) => {
        const ld   = _lineData[plant]?.[line]?.[dayKey];
        const avail = ld?.avail_hours != null ? ld.avail_hours : (cell.effectiveCapacity || 0);
        if (cell.scheduled > avail + 0.05) { shortfalls++; exceptionCount++; }
        else if (avail > (cell.effectiveCapacity || 0) + 0.05) exceptionCount++;
      });
    });

    const badge = document.getElementById('labor-exc-badge');
    if (badge) { badge.textContent = String(exceptionCount); badge.hidden = exceptionCount === 0; }
    const fmtH = (h: number) => h >= 1000 ? `${(h / 1000).toFixed(1)}k` : h.toFixed(0);
    strip.innerHTML = `
      <div class="lp-kpi-tile">
        <span class="lp-kpi-label">Available</span>
        <span class="lp-kpi-val">${fmtH(totalAvail)}h</span>
        <span class="lp-kpi-sub">${Util.escapeHtml(Util.t('labor.horizon_filtered', { weeks: _horizonSpan }))}</span>
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
      const total = _visibleGroups().reduce((sum, group) => sum + (_aggrData[plant][group]?.[w.key] ?? 0), 0);
      if (tds[i + 1]) tds[i + 1].textContent = total > 0 ? total.toFixed(1) : '—';
    });
  }

  function _deleteSelected(): void {
    if (!_selRange || !Store.selectedPlant) return;
    const { r0, c0, r1, c1 } = _selRange;
    const cells: LaborAggrCellPayload[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const group = _displayGroups[r], period = _weeks[c]?.key;
      if (group && period) cells.push({ wc_group: group, period, avail_hours: null });
    }
    _clearSelection();
    if (cells.length) void _edit(Store.selectedPlant, cells, [], Util.t('labor.undo_delete', { count: cells.length }));
  }

  /** Escapes a value for use inside a quoted CSS attribute selector. A bare `"` or `\`
   *  in a group/line name used to produce a selector that matched nothing (or threw). */
  function _cssEsc(value: string): string {
    const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
    if (css?.escape) return css.escape(String(value));
    return String(value).split('\\').join('\\\\').split('"').join('\\"');
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

  async function _renderAggregate(plant: string, renderGen: number): Promise<void> {
    const grid = document.getElementById('labor-grid') as LaborGridElement | null; if (!grid) return;
    const planMap = await _fetchAggregate(plant);
    // Stale-response guard: if a newer render (plant switch) has started since
    // this async fetch was initiated, discard this response and return early.
    if (renderGen !== _plantSwitchGeneration) return;
    _displayGroups = _visibleGroups();
    if (!_displayGroups.length) {
      grid.innerHTML = `<div class="empty-state">${Util.escapeHtml(Util.t('labor.empty_groups'))}</div>`;
      return;
    }
    const totals: Record<string, number> = {}; _weeks.forEach((w) => { totals[w.key] = 0; });
    const groupRows = _displayGroups.map((grp) => {
      const cells = _weeks.map((w) => {
        const ah = planMap[grp]?.[w.key]; if (ah != null) totals[w.key] += ah;
        return `<td>
          <input type="number" class="lp-cell" data-group="${Util.escapeHtml(grp)}" data-period="${Util.escapeHtml(w.key)}" aria-label="${Util.escapeHtml(Util.t('labor.group_hours_label', { group: grp, period: w.key }))}" min="0" step="0.5" value="${ah != null ? ah : ''}" data-saved-value="${ah != null ? ah : ''}" placeholder="—">
        </td>`;
      }).join('');
      return `<tr><td>${Util.escapeHtml(grp)}</td>${cells}</tr>`;
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
      <p class="lp-hint">${Util.escapeHtml(Util.t('labor.aggregate_hint'))}</p>`;

    // Build [row][col] -> <td> cache so the lasso paint never queries the DOM.
    _cellGrid = _displayGroups.map((grp) =>
      _weeks.map((w) => grid.querySelector(`.lp-cell[data-group="${_cssEsc(grp)}"][data-period="${_cssEsc(w.key)}"]`)?.closest<HTMLTableCellElement>('td') || null));
    _selTds = new Set();


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
      inp.oninput = () => { _inputRevisions.set(inp, (_inputRevisions.get(inp) || 0) + 1); };
      inp.onchange = async function() {
        const grp = inp.dataset.group!, period = inp.dataset.period!;
        const raw = inp.value.trim();
        const ah  = raw === '' ? null : Number(raw);
        if (ah != null && (!Number.isFinite(ah) || ah < 0)) { _refreshSavedCells(plant, undefined, _submission(inp)); return; }
        if (ah !== null) inp.value = String(ah);
        await _edit(plant, [{ wc_group: grp, period, avail_hours: ah }], [], Util.t('labor.undo_group', { group: grp, period }), _submission(inp));
      };
    });

    const table = grid.querySelector('table');
    if (table) table.addEventListener('paste', async (e: ClipboardEvent) => {
      const activeEl = document.activeElement as HTMLInputElement | null;
      const anchor = activeEl?.classList.contains('lp-cell') ? activeEl : null;
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain'); if (!text) return;
      const clipRows = text.replace(/\r/g, '').split('\n').filter((r) => r !== '').map((r) => r.split('\t'));
      const cellMatrix = _displayGroups.map((grp) => _weeks.map((w) => grid.querySelector(`.lp-cell[data-group="${_cssEsc(grp)}"][data-period="${_cssEsc(w.key)}"]`) as HTMLInputElement | null));
      let anchorRow = 0, anchorCol = 0;
      if (anchor) {
        anchorRow = Math.max(0, _displayGroups.indexOf(anchor.dataset.group || ''));
        anchorCol = Math.max(0, _weeks.findIndex((w) => w.key === anchor.dataset.period));
      }
      if (!_aggrData[plant]) _aggrData[plant] = {};
      const changed: LaborAggrCellPayload[] = [];
      clipRows.forEach((clipCols, r) => {
        clipCols.forEach((val, c) => {
          const ri = anchorRow + r, ci = anchorCol + c;
          if (ri >= _displayGroups.length || ci >= _weeks.length) return;
          const inp = cellMatrix[ri]?.[ci]; if (!inp) return;
          const raw = val.trim().replace(/,/g, '');
          const ah  = raw === '' ? null : Number(raw);
          if (ah !== null && (!Number.isFinite(ah) || ah < 0)) return;
          const grp = inp.dataset.group!, period = inp.dataset.period!;
          changed.push({ wc_group: grp, period, avail_hours: ah });
        });
      });
      if (!changed.length) return;
      if (await _edit(plant, changed, [], Util.t('labor.undo_paste', { count: changed.length })))
        Toast.show(Util.t('labor.pasted', { count: changed.length }), 'success');
    });
  }

  // ── Line Plan sub-tab ────────────────────────────────────────────────────
  async function _renderLinePlan(plant: string, renderGen: number): Promise<void> {
    const grid = document.getElementById('labor-line-grid') as HTMLElement | null; if (!grid) return;
    // Show all groups unless user has filtered to specific ones
    const visibleGroups = _visibleGroups();
    // Cross-screen production-line filter (Store.selectedLines) ANDs with the
    // group filter above — same combination GanttFilter's line/color/form
    // filters already use. Can legitimately yield zero rows (line selected
    // from a different group than the active group filter); the existing
    // empty-state below already covers that, same as a group-only miss.
    const allLinesMeta = _visibleLines(plant)
      .sort((a, b) => visibleGroups.indexOf(a.wc_group ?? '') - visibleGroups.indexOf(b.wc_group ?? '') || a.machine.localeCompare(b.machine));
    if (!allLinesMeta.length) {
      grid.innerHTML = `<div class="empty-state" style="padding:40px 0;">${Util.t('empty.no_machine_plant')}</div>`; return;
    }

    // Stale-response guard: if a newer render (plant switch) has started since
    // this async fetch was initiated, discard this response and return early.
    if (renderGen !== _plantSwitchGeneration) return;

    // Build day columns
    const days: Array<{ date: Date; dayKey: string; weekKey: string }> = [];
    _weeks.forEach((w) => {
      for (let d = 0; d < 7; d++) {
        const date = new Date(w.monday); date.setDate(w.monday.getDate() + d);
        days.push({ date, dayKey: Util.dayKey(date), weekKey: w.key });
      }
    });

    const horizonStart = _weeks[0].monday;
    const utilMatrix: LaborUtilMatrix = Utilization.computeMatrix(horizonStart, _horizonSpan * 7);
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
      const line = lm.machine;
      let groupRow = '';
      if (showGroupHeaders && lm.wc_group !== lastGroup) {
        lastGroup = lm.wc_group;
        groupRow = `<tr><td class="lp-group-hdr" colspan="${days.length + 1}">${Util.escapeHtml(lm.wc_group || '')}</td></tr>`;
      }
      const cells = days.map((d) => {
        const wb   = weekStarts.has(d.dayKey) ? 'border-left:2px solid var(--accent-soft);' : '';
        const ld   = _lineData[plant]?.[line]?.[d.dayKey];
        const calCap = _capFor(line, d.date, d.dayKey);
        const avail  = ld?.avail_hours != null ? ld.avail_hours : calCap;
        const req    = utilMatrix[line]?.[d.dayKey]?.scheduled || 0;
        const ratio  = avail > 0 ? req / avail : (req > 0 ? 2 : 0);
        const bg     = heatBg(ratio);
        const isOvr  = ld?.source === 'override';
        const title  = _lineCellTitle(line, d.dayKey, avail, req, calCap, isOvr);
        return `<td class="${isOvr ? 'lp-ovr' : ''}" style="${wb}background:${bg};padding:3px 4px;" title="${Util.escapeHtml(title)}">
          <input type="number" class="lp-line-cell" style="color:${Util.contrastText(bg)}" data-line="${Util.escapeHtml(line)}" data-day="${d.dayKey}" min="0" step="0.5"
            value="${avail}" data-saved-value="${avail}" aria-label="${Util.escapeHtml(Util.t('labor.line_hours_label', { line, day: d.dayKey }))}"></td>`;
      }).join('');
      return groupRow + `<tr><td>${Util.escapeHtml(line)}</td>${cells}</tr>`;
    }).join('');

    grid.innerHTML = `
      <div class="lp-card lp-card-scroll">
        <table class="lp-table">
          <thead><tr><th>Line</th>${dayHeaders}</tr></thead>
          <tbody>${lineRows}</tbody>
        </table>
      </div>`;

    if (_focusCell) {
      const cell = grid.querySelector<HTMLInputElement>(`.lp-line-cell[data-line="${_cssEsc(_focusCell.line)}"][data-day="${_focusCell.day}"]`);
      cell?.scrollIntoView({ block: 'center', inline: 'center' });
      cell?.focus({ preventScroll: true });
      _focusCell = null;
    }

    // Patch acknowledgements in place. The next focused input may contain a draft
    // that has not emitted change yet; replacing the grid would silently lose it.
    _patchLineGrid = (savedPlant, changed, submission) => {
      if (savedPlant !== plant || Store.selectedPlant !== plant || renderGen !== _plantSwitchGeneration) return;
      const inputs = changed
        ? changed.map(c => grid.querySelector<HTMLInputElement>(`.lp-line-cell[data-line="${_cssEsc(c.machine)}"][data-day="${c.day}"]`)).filter((inp): inp is HTMLInputElement => !!inp)
        : Array.from(grid.querySelectorAll<HTMLInputElement>('.lp-line-cell'));
      inputs.forEach(inp => {
        const line = inp.dataset.line!, day = inp.dataset.day!;
        const stored = _lineData[plant]?.[line]?.[day];
        const calCap = _capFor(line, new Date(`${day}T00:00:00`), day);
        const avail = stored?.avail_hours ?? calCap;
        const req = utilMatrix[line]?.[day]?.scheduled || 0;
        const ownSubmission = !!submission && submission.input === inp && submission.revision === _inputRevisions.get(inp)
          && inp.value === submission.value;
        if (inp.value === inp.dataset.savedValue || ownSubmission) inp.value = String(avail);
        inp.dataset.savedValue = String(avail);
        const bg = heatBg(avail > 0 ? req / avail : (req > 0 ? 2 : 0));
        inp.style.color = Util.contrastText(bg);
        const td = inp.closest('td');
        if (td) {
          td.classList.toggle('lp-ovr', stored?.source === 'override');
          td.style.background = bg;
          td.title = _lineCellTitle(line, day, avail, req, calCap, stored?.source === 'override');
        }
      });
    };
    grid.oninput = (event: Event) => {
      const inp = (event.target as HTMLElement).closest<HTMLInputElement>('.lp-line-cell');
      if (inp) _inputRevisions.set(inp, (_inputRevisions.get(inp) || 0) + 1);
    };

    // Sticky group headers: offset by actual thead height so they dock below column headers
    const theadH = (grid.querySelector('thead tr') as HTMLElement | null)?.offsetHeight || 27;
    grid.querySelectorAll<HTMLElement>('.lp-group-hdr').forEach((td) => { td.style.top = theadH + 'px'; });

    // Delegated handlers on the grid container — one 'change' + one 'contextmenu'
    // listener instead of two per cell (scales to thousands of line-day cells).
    grid.onchange = async function(e: Event) {
      const inp = (e.target as HTMLElement).closest<HTMLInputElement>('.lp-line-cell'); if (!inp) return;
      const line = inp.dataset.line!, day = inp.dataset.day!;
      const raw  = inp.value.trim();
      const ah   = raw === '' ? null : Number(raw);
      if (ah != null && (!Number.isFinite(ah) || ah < 0)) { await render(); return; }
      if (ah !== null) inp.value = String(ah);
      await _edit(plant, [], [{ machine: line, day, avail_hours: ah, source: ah == null ? 'auto_split' : 'override' }], Util.t('labor.undo_line', { line, day }), _submission(inp));
    };

    const resetOverride = async (e: Event): Promise<void> => {
      const inp = (e.target as HTMLElement).closest<HTMLInputElement>('.lp-line-cell'); if (!inp) return;
      e.preventDefault();
      const line = inp.dataset.line!, day = inp.dataset.day!;
      if (_lineData[plant]?.[line]?.[day]?.source !== 'override') return;
      const grp = (Store._state.masterData?.lines || []).find((l) => l.machine === line && l.plant === plant)?.wc_group;
      const periodKey = _isoWeek(new Date(`${day}T12:00:00`));
      const groupHours = grp ? _aggrData[plant]?.[grp]?.[periodKey] : null;
      const splits = grp && groupHours != null ? _disaggregate(plant, grp, periodKey, groupHours) : [];
      const resetCell: LaborLineCellPayload = splits.find(c => c.machine === line && c.day === day)
        || { machine: line, day, avail_hours: null, source: 'auto_split' };
      if (await _edit(plant, [], [resetCell], Util.t('labor.undo_reset', { line, day }), _submission(inp)))
        Toast.show(Util.t(resetCell.avail_hours == null ? 'labor.reset_calendar' : 'labor.reset_split', { line, day }), 'success');
    };
    grid.oncontextmenu = resetOverride;
    grid.onkeydown = (event: KeyboardEvent) => {
      if (event.shiftKey && event.key === 'Delete') void resetOverride(event);
    };
  }

  // ── Capacity sub-tab ─────────────────────────────────────────────────────
  async function _renderCapacity(plant: string, renderGen: number): Promise<void> {
    const container = document.getElementById('labor-capacity-grid'); if (!container) return;
    const scopeGroup = _selectedGroups.size === 1 ? [..._selectedGroups][0] : null;

    // Stale-response guard: if a newer render (plant switch) has started since
    // this async fetch was initiated, discard this response and return early.
    if (renderGen !== _plantSwitchGeneration) return;
    const lines = _visibleLines(plant)
      .map((l) => l.machine).sort();
    if (!lines.length) { container.innerHTML = `<div class="empty-state" style="padding:40px 0;">${Util.t('empty.no_machine_plant')}</div>`; return; }

    const horizonStart = _weeks[0].monday;
    const utilMatrix: LaborUtilMatrix = Utilization.computeMatrix(horizonStart, _horizonSpan * 7);
    const displayDays  = _horizonSpan * 7;
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


    const cols = `100px repeat(${days.length}, minmax(56px, 1fr))`;
    let html = `<div class="lp-card" style="padding:14px 16px;">
      <p class="lp-cap-note">${Util.escapeHtml(Util.t('labor.capacity_note', { days: displayDays }))}${scopeGroup ? ' / ' + Util.escapeHtml(Util.t('labor.group_note', { group: scopeGroup })) : ''}</p>
      <div class="lp-hm-wrap"><div class="lp-hm-grid" style="grid-template-columns:${cols}">`;
    html += `<div class="lp-hm-corner"></div>`;
    days.forEach((d) => {
      const dow = d.date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
      html += `<div class="lp-hm-head"><span class="lp-hm-dow">${dow}</span><span class="lp-hm-date">${d.date.getMonth()+1}/${d.date.getDate()}</span></div>`;
    });
    lines.forEach((line, li) => {
      const dot = Config.COLORS[li % Config.COLORS.length];
      html += `<div class="lp-hm-label"><span class="lp-hm-dot" style="background:${dot}"></span>${Util.escapeHtml(line)}</div>`;
      days.forEach((d) => {
        const req    = utilMatrix[line]?.[d.dayKey]?.scheduled || 0;
        const ld     = _lineData[plant]?.[line]?.[d.dayKey];
        const calCap = utilMatrix[line]?.[d.dayKey]?.effectiveCapacity || 0;
        const avail  = ld?.avail_hours != null ? ld.avail_hours : calCap;
        const ratio  = avail > 0 ? req / avail : (req > 0 ? 2 : 0);
        const bg     = heatBg(ratio), tc = Util.contrastText(bg);
        const lbl    = avail > 0 || req > 0 ? `${req.toFixed(0)}/${avail.toFixed(0)}` : '—';
        html += `<div class="lp-hm-cell" style="background:${bg};color:${tc};" title="${Util.escapeHtml(line)} · ${d.dayKey} | Req: ${req.toFixed(1)}h | Avail: ${avail.toFixed(1)}h | ${Math.round(ratio*100)}%">${lbl}</div>`;
      });
    });
    html += `</div></div><div class="lp-hm-legend"><span>idle</span><div class="lp-hm-grad"></div><span>overload</span></div></div>`;
    container.innerHTML = html;
  }

  // ── Exceptions sub-tab ───────────────────────────────────────────────────
  async function _renderExceptions(plant: string, renderGen: number): Promise<void> {
    const container = document.getElementById('labor-exceptions-list'); if (!container) return;

    // Stale-response guard: if a newer render (plant switch) has started since
    // this async fetch was initiated, discard this response and return early.
    if (renderGen !== _plantSwitchGeneration) return;
    const lines = _visibleLines(plant)
      .map((l) => l.machine);
    const horizonStart = _weeks[0].monday;
    const utilMatrix: LaborUtilMatrix = Utilization.computeMatrix(horizonStart, _horizonSpan * 7);
    const exceptions: LaborException[] = [];
    lines.forEach((line) => {
      const lm = utilMatrix[line]; if (!lm) return;
      Object.entries(lm).forEach(([dayKey, cell]) => {
        const ld    = _lineData[plant]?.[line]?.[dayKey];
        const avail = ld?.avail_hours != null ? ld.avail_hours : (cell.effectiveCapacity || 0);
        const req   = cell.scheduled || 0, calCap = cell.effectiveCapacity || 0;
        if (req > avail + 0.05 && req > 0)
          exceptions.push({ sev: 'err',  line, day: dayKey, msg: `${req.toFixed(1)}h required, ${avail.toFixed(1)}h available — ${(req - avail).toFixed(1)}h short` });
        else if (avail > calCap + 0.05)
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
        <span class="lp-exc-line">${Util.escapeHtml(ex.line)}</span>
        <span class="lp-exc-day">${ex.day}</span>
        <span class="lp-exc-msg">${Util.escapeHtml(ex.msg)}</span>
        <button class="btn btn-sm lp-exc-fix" data-line="${Util.escapeHtml(ex.line)}" data-day="${ex.day}">Line Plan →</button>
      </div>`).join('');
    container.innerHTML = `<div class="lp-exc-summary">${exceptions.length} exception${exceptions.length !== 1 ? 's' : ''}</div><div class="lp-exc-list">${rows}</div>`;
    container.querySelectorAll<HTMLButtonElement>('.lp-exc-fix').forEach(button => {
      button.onclick = () => {
        _focusCell = { line: button.dataset.line!, day: button.dataset.day! };
        document.querySelector<HTMLButtonElement>('[data-labor-sub="line-plan"]')?.click();
      };
    });
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
          <span class="lp-input-hint">${Util.escapeHtml(Util.t('labor.split_hint'))}</span>
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
        <p style="font-size:12px;color:var(--fg-mute);margin:0;">${Util.escapeHtml(Util.t('labor.reconciliation_help'))}</p>
      </div>`;
  }

  // ── Toolbar update ───────────────────────────────────────────────────────
  function _renderGroupList(drop: HTMLElement): void {
    const list = drop.querySelector<HTMLElement>('[data-group-list]'); if (!list) return;
    const query = _groupSearch.trim().toLocaleLowerCase();
    const groups = _groups.filter(group => group.toLocaleLowerCase().includes(query));
    list.innerHTML = groups.length ? groups.map(group => `<label class="lp-group-chk-row">
      <input type="checkbox" value="${Util.escapeHtml(group)}"${_selectedGroups.has(group) ? ' checked' : ''}>
      ${Util.escapeHtml(group)}</label>`).join('') : `<div class="empty-state">${Util.escapeHtml(Util.t('labor.no_matching_groups'))}</div>`;
    list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input => {
      input.onchange = () => LaborPlanning.onGroupToggle(input.value, input.checked);
    });
  }

  function _renderToolbar(plant: string | null): void {
    // Group multi-select button label
    const lbl = document.getElementById('lp-group-label');
    if (lbl) {
      if (_selectedGroups.size === 0)           lbl.textContent = Util.t('labor.all_groups');
      else if (_selectedGroups.size === 1)      lbl.textContent = [..._selectedGroups][0];
      else                                      lbl.textContent = Util.t('labor.selected_groups', { count: _selectedGroups.size });
    }
    const drop = document.getElementById('lp-group-dropdown');
    if (drop) {
      if (!drop.querySelector('[data-group-search]')) {
        drop.innerHTML = `<input class="input" type="search" data-group-search
          aria-label="${Util.escapeHtml(Util.t('labor.search_groups'))}" placeholder="${Util.escapeHtml(Util.t('labor.search_groups'))}">
          <div class="lp-group-scroll" data-group-list></div>
          <div class="lp-group-chk-footer"><button class="btn btn-sm" data-group-clear>${Util.escapeHtml(Util.t('labor.clear_groups'))}</button></div>`;
        const search = drop.querySelector<HTMLInputElement>('[data-group-search]')!;
        search.oninput = () => { _groupSearch = search.value; _renderGroupList(drop); };
        drop.querySelector<HTMLButtonElement>('[data-group-clear]')!.onclick = () => LaborPlanning.clearGroupFilter();
        drop.onkeydown = (event: KeyboardEvent) => {
          if (event.key !== 'Escape') return;
          event.preventDefault(); event.stopPropagation();
          drop.hidden = true;
          const trigger = document.getElementById('lp-group-btn');
          trigger?.setAttribute('aria-expanded', 'false'); trigger?.focus();
        };
      }
      const search = drop.querySelector<HTMLInputElement>('[data-group-search]')!;
      if (search.value !== _groupSearch) search.value = _groupSearch;
      _renderGroupList(drop);
    }
    // Cross-screen production-line filter (Store.selectedLines) — same
    // selection as Gantt/Orders/Dashboard/Master Data's line pickers.
    // Rebuild only the checklist body; the search <input> is static markup
    // wired once in init(), so its value/focus survive this rebuild.
    Util.refreshMultiSelectLabel(
      document.getElementById('lp-line-label'), document.getElementById('lp-line-btn'), Store.selectedLines);
    if (plant) {
      const lineCandidates = Store.masterLinesForPlant(plant)
        .map((l) => l.machine)
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
            const target = new Date(dates[0]);
            target.setDate(target.getDate() - ((target.getDay() + 6) % 7));
            _horizonOffset = Math.round((Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) - Date.UTC(todayMon.getFullYear(), todayMon.getMonth(), todayMon.getDate())) / (7 * Config.MS_DAY));
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
    // Increment generation counter on each render (plant switch) so stale async
    // responses from the previous plant can be detected and discarded.
    _plantSwitchGeneration++;
    const renderGen = _plantSwitchGeneration;

    _weeks = _computeWeeks();
    const plant = Store.selectedPlant;
    _clearSelection();
    if (plant !== _lastPlant) { _selectedGroups.clear(); _groupSearch = ''; _focusCell = null; _lastPlant = plant; }
    if (!plant) {
      ['labor-grid','labor-line-grid','labor-capacity-grid','labor-exceptions-list','labor-inputs-pane'].forEach(id => {
        const el = document.getElementById(id); if (el) el.innerHTML = `<div class="empty-state">${Util.t('ui.select_plant_labor')}</div>`;
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
    _groups = [...new Set(mdLines.map((r) => r.wc_group).filter((g): g is string => Boolean(g)))].sort();
    _renderToolbar(plant);
    const sub = getActiveTabResolvers().laborSub() || 'aggregate';
    const paneIds: Record<string, string> = { aggregate: 'labor-grid', 'line-plan': 'labor-line-grid', capacity: 'labor-capacity-grid', exceptions: 'labor-exceptions-list', inputs: 'labor-inputs-pane' };
    const activePane = document.getElementById(paneIds[sub]);
    if (activePane) activePane.innerHTML = `<div class="empty-state" role="status">${Util.escapeHtml(Util.t('labor.loading'))}</div>`;
    try {
      // A switch may request a reload, but queued edits still need committed state
      // to derive their changes and Undo snapshots. Drain the latest queue first.
      let pending: Promise<unknown>;
      do { pending = _writeQueue; await pending; } while (pending !== _writeQueue);
      if (renderGen !== _plantSwitchGeneration) return;
      if (_refreshPlants.delete(plant)) delete _aggrData[plant];
      await Promise.all([_fetchAggregate(plant), _fetchLines(plant, null)]);
      if (renderGen !== _plantSwitchGeneration) return;
      _renderKPIs(plant);
      if (sub === 'aggregate') await _renderAggregate(plant, renderGen);
      else if (sub === 'line-plan') await _renderLinePlan(plant, renderGen);
      else if (sub === 'capacity') await _renderCapacity(plant, renderGen);
      else if (sub === 'exceptions') await _renderExceptions(plant, renderGen);
      else if (sub === 'inputs') _renderInputs();
    } catch (e) {
      if (renderGen !== _plantSwitchGeneration) return;
      const id = ({ aggregate: 'labor-grid', 'line-plan': 'labor-line-grid', capacity: 'labor-capacity-grid', exceptions: 'labor-exceptions-list', inputs: 'labor-inputs-pane' } as Record<string, string>)[sub];
      const pane = document.getElementById(id);
      if (pane) pane.innerHTML = `<div class="empty-state" role="alert">${Util.escapeHtml(Util.t('labor.load_failed'))} <button class="btn" data-labor-retry>${Util.escapeHtml(Util.t('labor.retry'))}</button></div>`;
      const retry = pane?.querySelector<HTMLButtonElement>('[data-labor-retry]');
      if (retry) retry.onclick = () => { void render(); };
      const strip = document.getElementById('labor-kpi-strip'); if (strip) strip.innerHTML = '';
      ErrorLog.warn('labor', `Render failed: ${(e as Error).message}`);
    }
  }

  function _refreshActiveCached(plant: string): void {
    const sub = getActiveTabResolvers().laborSub();
    if (sub === 'line-plan') _patchLineGrid?.(plant);
    else if (sub === 'capacity') void _renderCapacity(plant, _plantSwitchGeneration);
    else if (sub === 'exceptions') void _renderExceptions(plant, _plantSwitchGeneration);
  }

  function _rerenderActiveSub(): void {
    void render();
  }

  function _onLPKeyDown(e: KeyboardEvent): void {
    if (!_selRange || getActiveTabResolvers().currentTab() !== 'labor' || getActiveTabResolvers().laborSub() !== 'aggregate') return;
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
      if ((evt.type === 'plant:selected' || evt.type === 'master-data-changed') && getActiveTabResolvers().currentTab() === 'labor') {
        // Store._state.masterData direct touch aside, `evt.plant` on a generic
        // StoreEvent is `unknown` (StoreEventInput's index signature) since
        // per-event-type extra fields aren't discriminated — cast at this
        // boundary, same pattern as schedule-services.mts's `opts.plant as
        // string | null | undefined`.
        if (evt.type === 'plant:selected') {
          const p = evt.plant as string;
          _refreshPlants.add(p);
        }
        render();
      }
      if (evt.type === 'lines:selected' && getActiveTabResolvers().currentTab() === 'labor') {
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
          Store.selectedPlant ? Store.masterLinesForPlant(Store.selectedPlant).map((l) => l.machine).sort() : [],
          Store.selectedLines, _lineSearch,
          (line, checked) => {
            const next = new Set(Store.selectedLines);
            if (checked) next.add(line); else next.delete(line);
            Store.setSelectedLines(next, 'labor');
          });
      };
      Util.wirePasteToCheckboxes(lineSearchIn,
        () => Array.from(document.getElementById('lp-line-checklist')?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') ?? []),
        boxes => Store.setSelectedLines(new Set([...Store.selectedLines, ...boxes.map(cb => cb.value)]), 'labor'));
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
      document.getElementById('lp-group-btn')?.setAttribute('aria-expanded', String(!drop.hidden));
      if (!drop.hidden) {
        drop.querySelector<HTMLInputElement>('[data-group-search]')?.focus();
        const close = (ev: MouseEvent) => {
          const target = ev.target as Node | null;
          if (!drop.contains(target) && (target as HTMLElement | null)?.id !== 'lp-group-btn') { drop.hidden = true; document.getElementById('lp-group-btn')?.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', close); }
        };
        setTimeout(() => document.addEventListener('click', close), 0);
      }
    },
    prevHorizon(): void { _horizonOffset -= _horizonSpan; render(); },
    nextHorizon(): void { _horizonOffset += _horizonSpan; render(); },
    setSpan(n: number): void {
      if (![4, 8, 12, 16].includes(n)) return;
      _horizonSpan = n;
      const sel = document.getElementById('labor-span-sel') as HTMLSelectElement | null; if (sel) sel.value = String(n);
      render();
    },
  };
})();
