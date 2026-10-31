/* =============================================================================
   ALERT MONITOR MATRIX — the pure model and markup behind the Matrix view.

   No Store, no DOM, no globals: the page builds a `MatrixCtx` from the Store and hands it in; every string comes
   through the ctx labels or an injected `t`, and every interpolated value goes through `_esc` once. Event wiring
   (cell / row / column / caret / quiet-fold clicks) is the pane's job; the markup carries stable data attributes:
   `data-am-cell="<rowKey>|<colKey>"`, `data-am-row`, `data-am-col`, `data-am-group`, `data-am-quiet`.

   The cell is a COUNT tinted by its worst severity (never a point ramp); dots say which alert groups are present.
   Day buckets come from the Overview module's rule, so a column here and a facet there agree on what a day is.
   ========================================================================== */

import type { AlertCategory } from '../platform/types.mjs';
import { ALERT_CATEGORY_ORDER, NONE_KEY, categoryOf } from '../insights/alert-profiles.mjs';
import { horizonDayKeys } from './alert-monitor-overview.mjs';
import { UNGROUPED_KEY, makeBucketer } from './alert-monitor-model.mjs';
import type { MonitorCtx, MonitorFilter, MonitorLens } from './alert-monitor-model.mjs';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const _esc = (s: unknown): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A group roll-up row's key in the machine lens: `wc:<group>` (a machine id is the bare id). */
export const GROUP_ROW_PREFIX = 'wc:';
/** Most group-color dots a cell shows. */
export const MAX_CELL_DOTS = 4;

export interface MatrixLabels {
  /** 'overdue' | 'later' | 'none' | a day key. */
  day: (key: string) => string;
  /** Muted sub-line of a day row ("before today"); optional. */
  daySub?: (key: string) => string;
  category: (cat: AlertCategory) => string;
  /** The "Ungrouped" bucket name. */
  ungrouped: string;
  /** The row for alerts that name no machine. */
  noMachine: string;
  /** "12 machines". */
  machinesCount: (n: number) => string;
}

export interface MatrixCtx extends MonitorCtx {
  /** Pinned machine ids (sorted first). */
  pinned?: ReadonlySet<string>;
  /** Group-lens rows: the ON categories in order (all seven when no custom profile is active). */
  categoryOrder?: readonly AlertCategory[];
  /** Work-center group keys whose machine rows are collapsed. */
  collapsed?: ReadonlySet<string>;
  /** Work-center group keys whose quiet machines are shown. */
  quietOpen?: ReadonlySet<string>;
  labels: MatrixLabels;
}

export type Worst = 'err' | 'warn' | null;

export interface Cell {
  count: number;
  worst: Worst;
  /** Groups present, in category order, at most `MAX_CELL_DOTS`. */
  cats: AlertCategory[];
  rowKey: string;
  colKey: string;
}
export interface RowHeader { key: string; label: string; sub: string; total: number; worst: Worst; barPct: number }
export interface MatrixRow { head: RowHeader; cells: Cell[] }
export interface MatrixGroup {
  key: string;
  label: string;
  machineCount: number;
  /** Roll-up row (key `wc:<group>`) and its cells. */
  head: RowHeader;
  cells: Cell[];
  collapsed: boolean;
  quietOpen: boolean;
  /** Machines with alerts: pinned first, then worst severity, then count. */
  rows: MatrixRow[];
  /** Machines with no alert, folded behind "Show N quiet machines". */
  quiet: MatrixRow[];
}
export interface MatrixModel {
  lens: MonitorLens;
  columns: Array<{ key: string; label: string }>;
  /** Day and Group lenses. */
  rows: MatrixRow[];
  /** Machine lens. */
  groups: MatrixGroup[];
  total: number;
}

// ---- Model ----------------------------------------------------------------------------------

interface Acc { count: number; err: number; mask: number }
interface RowAcc { cells: Array<Acc | undefined>; count: number; err: number }

const _worstOf = (count: number, err: number): Worst => (err > 0 ? 'err' : count > 0 ? 'warn' : null);

export function matrixModel(alerts: ReadonlyArray<NimbusAlert>, lens: MonitorLens, ctx: MatrixCtx): MatrixModel {
  const order = ctx.categoryOrder ?? ALERT_CATEGORY_ORDER;
  const catIdx = new Map<AlertCategory, number>();
  ALERT_CATEGORY_ORDER.forEach((c, i) => catIdx.set(c, i));
  const bucket = makeBucketer(ctx);
  const dayKeys = horizonDayKeys(ctx.plantToday, ctx.horizonDays);
  const bucketCols = ['overdue', ...dayKeys, 'later', NONE_KEY];

  const wcByLine = new Map<string, string>();
  for (const m of ctx.machines) wcByLine.set(m.id, m.wc_group ? String(m.wc_group) : UNGROUPED_KEY);
  const wcOf = (line: string | undefined): string => (line ? (wcByLine.get(line) ?? UNGROUPED_KEY) : UNGROUPED_KEY);

  // Columns and per-lens keys.
  let colKeys: string[];
  let rowKeyOf: (a: NimbusAlert) => string;
  let colKeyOf: (a: NimbusAlert) => string;
  const wcKeysPresent = new Set<string>();
  if (lens === 'day') {
    for (const g of wcByLine.values()) wcKeysPresent.add(g);
    for (const a of alerts) wcKeysPresent.add(wcOf(a.line));
    colKeys = [...wcKeysPresent].filter(k => k !== UNGROUPED_KEY).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (wcKeysPresent.has(UNGROUPED_KEY)) colKeys.push(UNGROUPED_KEY);
    rowKeyOf = bucket;
    colKeyOf = a => wcOf(a.line);
  } else {
    colKeys = bucketCols;
    colKeyOf = bucket;
    rowKeyOf = lens === 'group' ? (a => categoryOf(a.type)) : (a => a.line || NONE_KEY);
  }
  const colIdx = new Map<string, number>();
  colKeys.forEach((k, i) => colIdx.set(k, i));
  const nCols = colKeys.length;

  const rows = new Map<string, RowAcc>();
  const groupsAcc = new Map<string, RowAcc>();
  const add = (map: Map<string, RowAcc>, key: string, ci: number, isErr: boolean, mask: number) => {
    let r = map.get(key);
    if (!r) { r = { cells: new Array(nCols), count: 0, err: 0 }; map.set(key, r); }
    r.count++; if (isErr) r.err++;
    const c = r.cells[ci] ?? (r.cells[ci] = { count: 0, err: 0, mask: 0 });
    c.count++; if (isErr) c.err++;
    c.mask |= mask;
  };
  for (const a of alerts) {
    const ci = colIdx.get(colKeyOf(a));
    if (ci === undefined) continue;   // a bucket outside the column set cannot happen; guard only
    const isErr = a.sev === 'err';
    const mask = 1 << (catIdx.get(categoryOf(a.type)) ?? 0);
    add(rows, rowKeyOf(a), ci, isErr, mask);
    if (lens === 'machine') add(groupsAcc, wcOf(a.line), ci, isErr, mask);
  }

  const cellsOf = (rowKey: string, acc: RowAcc | undefined): Cell[] => colKeys.map((colKey, i) => {
    const c = acc?.cells[i];
    if (!c) return { count: 0, worst: null, cats: [], rowKey, colKey };
    const cats: AlertCategory[] = [];
    for (let k = 0; k < ALERT_CATEGORY_ORDER.length && cats.length < MAX_CELL_DOTS; k++) if (c.mask & (1 << k)) cats.push(ALERT_CATEGORY_ORDER[k]!);
    return { count: c.count, worst: _worstOf(c.count, c.err), cats, rowKey, colKey };
  });
  const head = (key: string, label: string, sub: string, acc: RowAcc | undefined, max: number): RowHeader => {
    const total = acc?.count ?? 0;
    return { key, label, sub, total, worst: _worstOf(total, acc?.err ?? 0), barPct: max > 0 ? Math.round((100 * total) / max) : 0 };
  };
  const L = ctx.labels;
  const total = alerts.length;

  if (lens === 'day') {
    const max = Math.max(0, ...[...rows.values()].map(r => r.count));
    const out: MatrixRow[] = bucketCols.map(k => ({
      head: head(k, L.day(k), L.daySub?.(k) ?? '', rows.get(k), max),
      cells: cellsOf(k, rows.get(k)),
    }));
    return { lens, columns: colKeys.map(k => ({ key: k, label: k === UNGROUPED_KEY ? L.ungrouped : k })), rows: out, groups: [], total };
  }
  const columns = colKeys.map(k => ({ key: k, label: L.day(k) }));
  if (lens === 'group') {
    const max = Math.max(0, ...[...rows.values()].map(r => r.count));
    const out: MatrixRow[] = order.map(c => ({
      head: head(c, L.category(c), '', rows.get(c), max),
      cells: cellsOf(c, rows.get(c)),
    }));
    return { lens, columns, rows: out, groups: [], total };
  }

  // Machine lens: every master machine, plus any machine (or the no-machine bucket) an alert names that the master lacks.
  const machines = new Map<string, { id: string; name: string; wc: string }>();
  for (const m of ctx.machines) machines.set(m.id, { id: m.id, name: m.name ?? '', wc: wcByLine.get(m.id)! });
  for (const key of rows.keys()) if (!machines.has(key)) machines.set(key, { id: key, name: key === NONE_KEY ? L.noMachine : '', wc: UNGROUPED_KEY });
  const pinned = ctx.pinned ?? new Set<string>();
  const maxMachine = Math.max(0, ...[...rows.values()].map(r => r.count));
  const maxGroup = Math.max(0, ...[...groupsAcc.values()].map(r => r.count));
  const byGroup = new Map<string, MatrixRow[]>();
  for (const m of machines.values()) {
    const acc = rows.get(m.id);
    const label = m.id === NONE_KEY && !ctx.machines.some(x => x.id === NONE_KEY) ? L.noMachine : m.id;
    const row: MatrixRow = { head: head(m.id, label, m.name && m.name !== m.id && m.id !== NONE_KEY ? m.name : '', acc, maxMachine), cells: cellsOf(m.id, acc) };
    const list = byGroup.get(m.wc);
    if (list) list.push(row); else byGroup.set(m.wc, [row]);
  }
  const sevRank = (w: Worst) => (w === 'err' ? 2 : w === 'warn' ? 1 : 0);
  const cmpName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const groups: MatrixGroup[] = [];
  for (const [gKey, list] of byGroup) {
    // A pinned machine is never folded away: it stays a row (first, per the pinned-first sort) even with no alerts.
    const noisy = list.filter(r => r.head.total > 0 || pinned.has(r.head.key)).sort((a, b) =>
      (pinned.has(b.head.key) ? 1 : 0) - (pinned.has(a.head.key) ? 1 : 0)
      || sevRank(b.head.worst) - sevRank(a.head.worst) || b.head.total - a.head.total || cmpName(a.head.label, b.head.label));
    const quiet = list.filter(r => r.head.total === 0 && !pinned.has(r.head.key)).sort((a, b) =>
      (pinned.has(b.head.key) ? 1 : 0) - (pinned.has(a.head.key) ? 1 : 0) || cmpName(a.head.label, b.head.label));
    const gAcc = groupsAcc.get(gKey);
    const label = gKey === UNGROUPED_KEY ? L.ungrouped : gKey;
    const rk = GROUP_ROW_PREFIX + gKey;
    groups.push({
      key: gKey, label, machineCount: list.length,
      head: head(rk, label, L.machinesCount(list.length), gAcc, maxGroup),
      cells: cellsOf(rk, gAcc),
      collapsed: !!ctx.collapsed?.has(gKey), quietOpen: !!ctx.quietOpen?.has(gKey),
      rows: noisy, quiet,
    });
  }
  groups.sort((a, b) =>
    sevRank(b.head.worst) - sevRank(a.head.worst) || b.head.total - a.head.total
    || (a.key === UNGROUPED_KEY ? 1 : 0) - (b.key === UNGROUPED_KEY ? 1 : 0) || cmpName(a.label, b.label));
  return { lens, columns, rows: [], groups, total };
}

// ---- Filters a click sets -------------------------------------------------------------------

const _one = <T,>(v: T): Set<T> => new Set([v]);

/** What clicking a row header sets. */
export function rowFilter(lens: MonitorLens, rowKey: string): Partial<MonitorFilter> {
  if (lens === 'machine') {
    return rowKey.startsWith(GROUP_ROW_PREFIX) ? { wcGroups: _one(rowKey.slice(GROUP_ROW_PREFIX.length)) } : { machines: _one(rowKey) };
  }
  if (lens === 'day') return { days: _one(rowKey) };
  return { categories: _one(rowKey as AlertCategory) };
}
/** What clicking a column header sets. */
export function colFilter(lens: MonitorLens, colKey: string): Partial<MonitorFilter> {
  return lens === 'day' ? { wcGroups: _one(colKey) } : { days: _one(colKey) };
}
/** What clicking a cell sets: its row and its column. */
export function cellFilter(lens: MonitorLens, rowKey: string, colKey: string): Partial<MonitorFilter> {
  return { ...rowFilter(lens, rowKey), ...colFilter(lens, colKey) };
}

/** The filter with the dimensions `part` names emptied (toggle-off: clicking the current cell/row/column clears exactly those). */
export function clearDims(filter: MonitorFilter, part: Partial<MonitorFilter>): MonitorFilter {
  const next: MonitorFilter = { ...filter, machines: new Set(filter.machines), wcGroups: new Set(filter.wcGroups), days: new Set(filter.days), categories: new Set(filter.categories) };
  for (const dim of ['machines', 'wcGroups', 'days', 'categories'] as const) if (part[dim]) (next[dim] as Set<string>).clear();
  return next;
}

/** True when every dimension of `part` is exactly the filter's own set (the aria-pressed rule). */
export function filterMatches(filter: MonitorFilter, part: Partial<MonitorFilter>): boolean {
  let any = false;
  for (const dim of ['machines', 'wcGroups', 'days', 'categories'] as const) {
    const want = part[dim] as Set<string> | undefined;
    if (!want) continue;
    any = true;
    const have = filter[dim] as Set<string>;
    if (have.size !== want.size) return false;
    for (const k of want) if (!have.has(k)) return false;
  }
  return any;
}

// ---- HTML -----------------------------------------------------------------------------------

function _cellHtml(c: Cell, rowLabel: string, colLabel: string, lens: MonitorLens, f: MonitorFilter, t: Translate): string {
  if (c.count === 0) return `<td><div class="am-mx-cell am-mx-zero" aria-hidden="true">·</div></td>`;
  const pressed = filterMatches(f, cellFilter(lens, c.rowKey, c.colKey));
  const aria = t(c.count === 1 ? 'am.mx_cell_aria_one' : 'am.mx_cell_aria', { row: rowLabel, col: colLabel, n: c.count });
  const dots = c.cats.length
    ? `<span class="am-mx-dots" aria-hidden="true">${c.cats.map(k => `<i style="--c:var(--bar-pm-${k})"></i>`).join('')}</span>` : '';
  return `<td><button type="button" class="am-mx-cell am-mx-${c.worst}" data-am-cell="${_esc(c.rowKey)}|${_esc(c.colKey)}"`
    + ` data-am-row="${_esc(c.rowKey)}" data-am-col="${_esc(c.colKey)}" aria-pressed="${pressed}" aria-label="${_esc(aria)}">${c.count}${dots}</button></td>`;
}

function _rowHeadHtml(h: RowHeader, lens: MonitorLens, f: MonitorFilter, lead = '', cls = ''): string {
  const pressed = filterMatches(f, rowFilter(lens, h.key));
  const bar = h.total > 0
    ? `<span class="am-mx-bar" aria-hidden="true"><i class="am-mx-bar-${h.worst === 'err' ? 'err' : 'warn'}" style="--w:${h.barPct}%"></i></span>` : '';
  return `<th scope="row" class="am-mx-rh${cls}"><div class="am-mx-rhc">${lead}`
    + `<button type="button" class="am-mx-rowh" data-am-row="${_esc(h.key)}" aria-pressed="${pressed}">${_esc(h.label)}</button>`
    + (h.sub ? `<span class="am-mx-sub">${_esc(h.sub)}</span>` : '')
    + `${bar}<span class="am-mx-tot">${h.total}</span></div></th>`;
}

function _rowHtml(r: MatrixRow, m: MatrixModel, f: MonitorFilter, t: Translate, extraCls = '', attrs = ''): string {
  const labels = m.columns.map(c => c.label);
  return `<tr class="am-mx-row${extraCls}"${attrs}>${_rowHeadHtml(r.head, m.lens, f)}`
    + r.cells.map((c, i) => _cellHtml(c, r.head.label, labels[i]!, m.lens, f, t)).join('') + `</tr>`;
}

/** The Matrix table: sticky header + sticky first column, group roll-ups with a caret, a quiet fold per group, a footer legend. */
export function matrixHtml(m: MatrixModel, f: MonitorFilter, t: Translate): string {
  const corner = t(m.lens === 'machine' ? 'am.mx_corner_machine' : m.lens === 'day' ? 'am.mx_corner_day' : 'am.mx_corner_group');
  const thead = `<thead><tr><th class="am-mx-head am-mx-rh">${_esc(corner)}</th>`
    + m.columns.map(c => `<th class="am-mx-head"><button type="button" class="am-mx-colh" data-am-col="${_esc(c.key)}" aria-pressed="${filterMatches(f, colFilter(m.lens, c.key))}">${_esc(c.label)}</button></th>`).join('')
    + `</tr></thead>`;
  let body = '';
  if (m.lens === 'machine') {
    const labels = m.columns.map(c => c.label);
    for (const g of m.groups) {
      const caret = `<button type="button" class="am-mx-caret" data-am-group="${_esc(g.key)}" aria-expanded="${!g.collapsed}" aria-label="${_esc(g.label)}">${g.collapsed ? '▸' : '▾'}</button>`;
      body += `<tr class="am-mx-ghead">${_rowHeadHtml(g.head, 'machine', f, caret, ' am-mx-ghead-rh')}`
        + g.cells.map((c, i) => _cellHtml(c, g.label, labels[i]!, 'machine', f, t)).join('') + `</tr>`;
      if (g.collapsed) continue;
      for (const r of g.rows) body += _rowHtml(r, m, f, t);
      if (g.quiet.length) {
        if (g.quietOpen) for (const r of g.quiet) body += _rowHtml(r, m, f, t, ' am-mx-quiet', ' data-am-quiet-row="1"');
        const n = g.quiet.length;
        const text = t(g.quietOpen ? (n === 1 ? 'am.quiet_hide_one' : 'am.quiet_hide') : (n === 1 ? 'am.quiet_show_one' : 'am.quiet_show'), { n });
        body += `<tr class="am-mx-quiet am-mx-quiet-fold"><th scope="row" class="am-mx-rh"><button type="button" class="am-mx-quiet-btn" data-am-quiet="${_esc(g.key)}" aria-expanded="${g.quietOpen}">${_esc(text)}</button></th>`
          + `<td colspan="${m.columns.length}"></td></tr>`;
      }
    }
  } else {
    for (const r of m.rows) body += _rowHtml(r, m, f, t);
  }
  const foot = `<div class="am-mx-foot"><span class="am-mx-lg"><i class="am-mx-lg-err"></i>${_esc(t('am.mx_legend_err'))}</span>`
    + `<span class="am-mx-lg"><i class="am-mx-lg-warn"></i>${_esc(t('am.mx_legend_warn'))}</span>`
    + `<span class="am-mx-lg"><i class="am-mx-lg-dots"></i>${_esc(t('am.mx_legend_dots'))}</span>`
    + `<span>${_esc(t('am.mx_legend_hint'))}</span></div>`;
  return `<div class="am-mx-scroll"><table class="am-mx-table" data-am-lens="${m.lens}">${thead}<tbody>${body}</tbody></table></div>${foot}`;
}
