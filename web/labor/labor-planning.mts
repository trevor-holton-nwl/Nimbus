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
      (json.rows || []).forEach((r: { wc_group: string; period: string; avail_hours: number }) => {
        if (!map[r.wc_group]) map[r.wc_group] = {};
        map[r.wc_group][r.period] = r.avail_hours;
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
      (json.rows || []).forEach((r: { machine: string; day: string; avail_hours: number; source: LaborCellSource }) => {
        if (!_lineData[plant][r.machine]) _lineData[plant][r.machine] = {};
        _lineData[plant][r.machine][r.day] = { avail_hours: r.avail_hours, source: r.source };
      });
    } catch (e) {
      ErrorLog.warn('labor', `Fetch lines failed: ${(e as Error).message}`);
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
    const plantLines = (Store._state.masterData?.lines || []).filter((r) => r.plant === plant).map((r) => r.machine);
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
      prev.push({ wc_group: grp, period, avail_hours: _aggrData[plant]?.[grp]?.[period] ?? null });
      if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
      delete _aggrData[plant][grp][period];
      cleared.push({ wc_group: grp, period, avail_hours: null });
      const inp = g?.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`) as HTMLInputElement | null;
      if (inp) inp.value = '';
    }
    if (!cleared.length) return;
    if (g) _updateAggrTotals(g);
    _clearSelection();
    const sn = _subnetwork(plant);
    UndoStack.push(`Delete ${cleared.length} labor cell${cleared.length !== 1 ? 's' : ''}`, () => {
      if (!_aggrData[plant]) _aggrData[plant] = {};
      prev.forEach(({ wc_group: grp, period, avail_hours: old }) => {
        if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
        if (old == null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = old;
      });
      const g2 = document.getElementById('labor-grid');
      if (g2) {
        prev.forEach(({ wc_group: grp, period, avail_hours: old }) => {
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
              if (!_lineData[plant][c.machine]) _lineData[plant][c.machine] = {};
              _lineData[plant][c.machine][c.day] = { avail_hours: c.avail_hours, source: c.source };
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
          _saveAggregate(sn, plant, [{ wc_group: grp, period, avail_hours: oldAh }]);
        });
        await _saveAggregate(sn, plant, [{ wc_group: grp, period, avail_hours: ah }]);
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
          prev.push({ wc_group: grp, period, avail_hours: _aggrData[plant]?.[grp]?.[period] ?? null });
          inp.value = ah !== null ? String(ah) : '';
          if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
          if (ah === null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = ah;
          changed.push({ wc_group: grp, period, avail_hours: ah });
          if (ah !== null) allSplits.push(..._disaggregate(plant, grp, period, ah));
        });
      });
      if (!changed.length) return;
      _updateAggrTotals(grid); _renderKPIsDebounced(plant);
      if (allSplits.length) {
        if (!_lineData[plant]) _lineData[plant] = {};
        allSplits.forEach((c) => {
          if (!_lineData[plant][c.machine]) _lineData[plant][c.machine] = {};
          _lineData[plant][c.machine][c.day] = { avail_hours: c.avail_hours, source: c.source };
        });
        _saveLines(sn, plant, allSplits);
      }
      UndoStack.push(`Undo paste (${changed.length} labor value${changed.length !== 1 ? 's' : ''})`, () => {
        if (!_aggrData[plant]) _aggrData[plant] = {};
        prev.forEach(({ wc_group: grp, period, avail_hours: old }) => {
          if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
          if (old == null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = old;
        });
        const g = document.getElementById('labor-grid');
        if (g) {
          prev.forEach(({ wc_group: grp, period, avail_hours: old }) => {
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
      .filter((l) => visibleGroups.includes(l.wc_group ?? '') && (lineSel.size === 0 || lineSel.has(l.machine)))
      .sort((a, b) => visibleGroups.indexOf(a.wc_group ?? '') - visibleGroups.indexOf(b.wc_group ?? '') || a.machine.localeCompare(b.machine));
    if (!allLinesMeta.length) {
      grid.innerHTML = `<div class="empty-state" style="padding:40px 0;">${Util.t('empty.no_machine_plant')}</div>`; return;
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
      const line = lm.machine;
      let groupRow = '';
      if (showGroupHeaders && lm.wc_group !== lastGroup) {
        lastGroup = lm.wc_group;
        groupRow = `<tr><td class="lp-group-hdr" colspan="${days.length + 1}">${lm.wc_group}</td></tr>`;
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
        _saveLines(sn, plant, [{ machine: line, day, avail_hours: oldAh, source: oldSrc }]);
      });
      await _saveLines(sn, plant, [{ machine: line, day, avail_hours: ah, source: newSrc }]);
    };

    grid.oncontextmenu = function(e: MouseEvent) {
      const inp = (e.target as HTMLElement).closest<HTMLInputElement>('.lp-line-cell'); if (!inp) return;
      e.preventDefault();
      const line = inp.dataset.line!, day = inp.dataset.day!;
      if (_lineData[plant]?.[line]?.[day]?.source !== 'override') return;
      const grp = (Store._state.masterData?.lines || []).find((l) => l.machine === line && l.plant === plant)?.wc_group;
      if (!grp) return;
      const periodKey = _weeks.find((w) => {
        for (let d = 0; d < 7; d++) { const dd = new Date(w.monday); dd.setDate(w.monday.getDate() + d); if (Util.dayKey(dd) === day) return true; }
      })?.key;
      if (!periodKey) return;
      const groupHours = _aggrData[plant]?.[grp]?.[periodKey]; if (groupHours == null) return;
      const splits = _disaggregate(plant, grp, periodKey, groupHours);
      const resetCell = splits.find((c) => c.machine === line && c.day === day); if (!resetCell) return;
      _lineData[plant][line][day] = { avail_hours: resetCell.avail_hours, source: 'auto_split' };
      inp.value = resetCell.avail_hours ? String(resetCell.avail_hours) : '';
      inp.closest('td')?.classList.remove('lp-ovr');
      _saveLines(sn, plant, [{ machine: line, day, avail_hours: resetCell.avail_hours, source: 'auto_split' }]);
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
      .filter((l) => (!scopeGroup || l.wc_group === scopeGroup) && (lineSel.size === 0 || lineSel.has(l.machine)))
      .map((l) => l.machine).sort();
    if (!lines.length) { container.innerHTML = `<div class="empty-state" style="padding:40px 0;">${Util.t('empty.no_machine_plant')}</div>`; return; }

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
      .filter((l) => l.plant === plant && (lineSel.size === 0 || lineSel.has(l.machine)))
      .map((l) => l.machine);
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
    _groups = [...new Set(mdLines.map((r) => r.wc_group).filter((g): g is string => Boolean(g)))].sort();
    if (!_groups.length) {
      const grid = document.getElementById('labor-grid');
      if (grid) grid.innerHTML = `<div class="empty-state" style="padding:40px 0;">${Util.t('empty.no_line_groups_plant')}</div>`;
      return;
    }
    _renderToolbar(plant);
    _renderKPIs(plant);
    const sub = getActiveTabResolvers().laborSub() || 'aggregate';
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
    const sub = getActiveTabResolvers().laborSub();
    if (sub === 'aggregate')       _renderAggregate(plant);
    else if (sub === 'line-plan')  _renderLinePlan(plant);
    else if (sub === 'capacity')   _renderCapacity(plant);
    else if (sub === 'exceptions') _renderExceptions(plant);
  }

  function _onLPKeyDown(e: KeyboardEvent): void {
    if (!_selRange || getActiveTabResolvers().currentTab() !== 'labor') return;
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
          delete _aggrData[p]; delete _lineData[p];
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
