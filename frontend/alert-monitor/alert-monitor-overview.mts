/* =============================================================================
   ALERT MONITOR OVERVIEW — pure data, narrowing, SVG math and HTML builders for
   the three-panel Overview band (When / Where / What).

   No Store, no DOM, no globals: every input is passed in, every string comes
   through an injected `t`, and every interpolated value goes through the injected
   `esc` exactly once (callers must not escape again). The model never imports
   this module; the pane does the wiring.

   A "narrow" is a view-only AND-filter (day, line, category) over the alerts the
   list shows. Nothing here touches a persisted pref or emits an event.
   ========================================================================== */

import type { AlertCategory, NimbusTask } from '../platform/types.mjs';
import { anchorTime, alertDayOffset, categoryOf, dayKeyOf, ALERT_CATEGORY_ORDER, NONE_KEY } from '../insights/alert-profiles.mjs';
import type { ProfileDeps } from '../insights/alert-profiles.mjs';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

// ---- Types ----------------------------------------------------------------------------------

export type NarrowDim = 'day' | 'line' | 'category';
/** day: 'overdue' | 'later' | 'YYYY-MM-DD'; line: the line name or 'none'; category: an AlertCategory. */
export interface Narrow { day?: string; line?: string; category?: string }

export interface OverviewDeps {
  tasksById: Record<string, NimbusTask | undefined>;
  /** Start of the plant-local day. */
  plantToday: Date;
  horizonMinutes: number;
  window: { from: number; to: number } | null;
  deps?: ProfileDeps;
}

export interface DayBar {
  key: string;
  offset: number;
  err: number;
  warn: number;
  inWindow: boolean;
  isToday: boolean;
}

export interface OverviewData {
  total: number;
  undated: number;
  overdue: { err: number; warn: number; inWindow: boolean };
  days: DayBar[];
  later: { err: number; warn: number };
  /** The tallest day bar (err + warn); buckets are clamped to it. */
  maxDay: number;
  lines: Array<{ line: string; err: number; warn: number; overload: boolean }>;
  categories: Array<{ cat: AlertCategory; count: number }>;
}

const MAX_DAYS = 60;

/**
 * `anchorTime` with the order's due instant memoised per task for one call: about five alerts share an order, and the
 * production due path (date-only due -> calendar window walk) costs microseconds per call. Same result as `anchorTime`:
 * the due when the order carries one and it resolves, else the alert's own time.
 */
export function _memoAnchor(d: OverviewDeps): (a: NimbusAlert, task: NimbusTask | undefined) => Date | null {
  const dueBy = new Map<NimbusTask, Date | null>();
  const valid = (x: unknown): x is Date => x instanceof Date && !isNaN(x.getTime());
  return (a, task) => {
    if (a.taskId && task && task.original_end_date) {
      let due = dueBy.get(task);
      if (due === undefined) {
        due = anchorTime({ id: '', taskId: a.taskId, time: null } as unknown as NimbusAlert, task, d.deps);   // an invalid own time: only the due can answer
        dueBy.set(task, due);
      }
      if (due) return due;
    }
    return valid(a.time) ? a.time : null;
  };
}

// ---- Day buckets (shared with the Matrix and the Inbox facets) --------------------------------

/**
 * The bucket of one anchor instant: `'none'` (no anchor), `'overdue'` (before today), `'later'` (past the `n`-day horizon),
 * else the `YYYY-MM-DD` key of its day. The same rule `overviewData` applies, so a Matrix column and a facet never disagree.
 */
export function dayBucketKey(anchor: Date | null, plantToday: Date, n: number): string {
  if (!anchor) return NONE_KEY;
  const off = alertDayOffset(anchor, plantToday);
  if (off < 0) return 'overdue';
  if (off >= n) return 'later';
  return dayKeyOf(new Date(plantToday.getFullYear(), plantToday.getMonth(), plantToday.getDate() + off));
}

/** The horizon's day keys, today first (the same keys `overviewData` builds). */
export function horizonDayKeys(plantToday: Date, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(dayKeyOf(new Date(plantToday.getFullYear(), plantToday.getMonth(), plantToday.getDate() + i)));
  return out;
}

// ---- Data -----------------------------------------------------------------------------------

/** Columns shown: the alert horizon in days, widened to cover the profile window, clamped 1..60. */
export function horizonDays(horizonMinutes: number, win: { from: number; to: number } | null): number {
  const fromHorizon = Math.ceil((Number(horizonMinutes) || 0) / 1440);
  const fromWindow = win ? win.to + 1 : 0;
  return Math.min(MAX_DAYS, Math.max(1, Math.max(fromHorizon, fromWindow)));
}

/** One pass over the listed alerts: day buckets, per-line and per-category counts. */
export function overviewData(listed: ReadonlyArray<NimbusAlert>, d: OverviewDeps): OverviewData {
  const win = d.window;
  const n = horizonDays(d.horizonMinutes, win);
  const y = d.plantToday.getFullYear(), m = d.plantToday.getMonth(), day = d.plantToday.getDate();
  const days: DayBar[] = [];
  for (let i = 0; i < n; i++) {
    days.push({
      key: dayKeyOf(new Date(y, m, day + i)),   // local-date construction: DST-safe, never derived from alerts
      offset: i, err: 0, warn: 0,
      inWindow: !!win && i >= win.from && i <= win.to,
      isToday: i === 0,
    });
  }
  const overdue = { err: 0, warn: 0, inWindow: !!win && win.from < 0 };
  const later = { err: 0, warn: 0 };
  const lineMap = new Map<string, { line: string; err: number; warn: number; overload: boolean }>();
  const catCount = new Map<AlertCategory, number>();
  let undated = 0;
  const anchorOf = _memoAnchor(d);

  for (const a of listed) {
    const isErr = a.sev === 'err';
    const task = a.taskId ? d.tasksById?.[a.taskId] : undefined;
    const anchor = anchorOf(a, task);
    if (!anchor) undated++;
    else {
      const off = alertDayOffset(anchor, d.plantToday);
      const bucket = off < 0 ? overdue : off >= n ? later : days[off];
      if (isErr) bucket.err++; else bucket.warn++;
    }
    const lineKey = a.line || NONE_KEY;
    let row = lineMap.get(lineKey);
    if (!row) { row = { line: lineKey, err: 0, warn: 0, overload: false }; lineMap.set(lineKey, row); }
    if (isErr) row.err++; else row.warn++;
    if (a.type === 'overload') row.overload = true;
    const cat = categoryOf(a.type);
    catCount.set(cat, (catCount.get(cat) ?? 0) + 1);
  }

  let maxDay = 0;
  for (const b of days) maxDay = Math.max(maxDay, b.err + b.warn);
  const lines = [...lineMap.values()].sort((p, q) =>
    (q.err + q.warn) - (p.err + p.warn) || (p.line < q.line ? -1 : p.line > q.line ? 1 : 0));
  return {
    total: listed.length, undated, overdue, days, later, maxDay, lines,
    categories: ALERT_CATEGORY_ORDER.map(cat => ({ cat, count: catCount.get(cat) ?? 0 })),
  };
}

// ---- Narrowing ------------------------------------------------------------------------------

export function narrowActive(n: Narrow | null | undefined): boolean {
  return !!(n && (n.day || n.line || n.category));
}

/** The alerts matching every active dimension (AND). `{}` returns the same array. */
export function applyNarrow<A extends NimbusAlert>(listed: ReadonlyArray<A>, n: Narrow, d: OverviewDeps): A[] {
  if (!narrowActive(n)) return listed as A[];
  const horizon = n.day ? horizonDays(d.horizonMinutes, d.window) : 0;
  const anchorOf = _memoAnchor(d);
  return listed.filter(a => {
    if (n.line && (a.line || NONE_KEY) !== n.line) return false;
    if (n.category && categoryOf(a.type) !== n.category) return false;
    if (n.day) {
      const task = a.taskId ? d.tasksById?.[a.taskId] : undefined;
      const anchor = anchorOf(a, task);
      if (!anchor) return false;   // undated alerts never match a day
      if (n.day === 'overdue') return alertDayOffset(anchor, d.plantToday) < 0;
      if (n.day === 'later') return alertDayOffset(anchor, d.plantToday) >= horizon;
      return dayKeyOf(anchor) === n.day;
    }
    return true;
  });
}

/** Click on the selected value clears it, else sets it. Always a new object. */
export function toggleNarrow(n: Narrow, dim: NarrowDim, value: string): Narrow {
  const next: Narrow = { ...n };
  if (next[dim] === value) delete next[dim]; else next[dim] = value;
  return next;
}

/** Drop any dimension whose value has no alerts in the unnarrowed set (returns `n` itself when nothing drops). */
export function pruneNarrow(n: Narrow, data: OverviewData): Narrow {
  const next: Narrow = { ...n };
  if (next.day) {
    const v = next.day;
    const count = v === 'overdue' ? data.overdue.err + data.overdue.warn
      : v === 'later' ? data.later.err + data.later.warn
        : (() => { const b = data.days.find(x => x.key === v); return b ? b.err + b.warn : 0; })();
    if (count === 0) delete next.day;
  }
  if (next.line) {
    const row = data.lines.find(l => l.line === next.line);
    if (!row || row.err + row.warn === 0) delete next.line;
  }
  if (next.category) {
    const c = data.categories.find(x => x.cat === next.category);
    if (!c || c.count === 0) delete next.category;
  }
  const same = next.day === n.day && next.line === n.line && next.category === n.category;
  return same ? n : next;
}

/** `data-am-narrow="dim:value"` → `{dim, value}`; the split is at the FIRST colon (a line name may hold more). */
export function parseNarrowAttr(attr: string | null | undefined): { dim: NarrowDim; value: string } | null {
  if (!attr) return null;
  const i = attr.indexOf(':');
  if (i < 0) return null;
  const dim = attr.slice(0, i), value = attr.slice(i + 1);
  if ((dim !== 'day' && dim !== 'line' && dim !== 'category') || !value) return null;
  return { dim, value };
}

// ---- HTML builders --------------------------------------------------------------------------

/** The three stacked pieces of a day tick; the pane fills them from one per-language Intl formatter each. */
export interface TickParts { wd: string; day: string; mo: string }

/**
 * Tick thinning. A label needs about 15 px of slot (a two-digit day measures 12.8 px at 10 px mono) and the narrowest
 * When card the band ever has beside the other panels is about 436 px of chart width, so stride = ceil(15 x columns / 436):
 * 1 up to 29 columns (27 days), 2 up to 58, 3 beyond. Measured in the Overview task (see the spec's rev-3 follow-up).
 */
export const TICK_SLOT_PX = 15;
export const TICK_MIN_CHART_PX = 436;
export function tickStride(cols: number): number {
  return Math.max(1, Math.ceil(TICK_SLOT_PX * cols / TICK_MIN_CHART_PX));
}

/** The injected view dependencies of every HTML builder (except `narrowChipHtml`, which takes `t` alone). */
export interface OverviewViewDeps {
  t: Translate;
  /** HTML-escape (text and attribute safe); the builders call it exactly once per interpolated value. */
  esc: (s: unknown) => string;
  /** "Thu 23 Oct" for a `YYYY-MM-DD` key. */
  fmtDay: (dayKey: string) => string;
  /** The day-axis parts of a tick column: short weekday ("Mon"), day of month ("27") and short month ("Oct"). */
  fmtTick: (dayKey: string) => TickParts;
  /** The "Unassigned" label for the `none` line. */
  unassigned: string;
}

/** Same escaping as the model's private `_esc`; used by `narrowChipHtml`, which has no `esc` injected. */
const _escHtml = (s: unknown): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Lines shown before "+N more", and the cap of the expanded list. */
export const OV_LINES_TOP = 8;
export const OV_LINES_MAX = 24;

/** Every narrow control is a toggle button, so aria-pressed is always present ("true" / "false"). */
const _pressed = (sel: boolean): string => ` aria-pressed="${sel ? 'true' : 'false'}"`;

function _barHtml(
  key: string, count: { err: number; warn: number }, label: string, selected: boolean, maxDay: number,
  extraClass: string, v: OverviewViewDeps,
): string {
  const total = count.err + count.warn;
  const aria = v.esc(v.t('am.ov_day_aria', { day: label, e: count.err, w: count.warn }));
  if (total === 0) {
    return `<button type="button" class="am-ov-bar am-ov-stub${extraClass}" disabled tabindex="-1" aria-label="${aria}"></button>`;
  }
  const h = Math.min(100, Math.round(total / Math.max(1, maxDay) * 100));
  const err = count.err ? `<span class="am-ov-seg am-ov-seg-err" style="--g:${count.err}"></span>` : '';
  const warn = count.warn ? `<span class="am-ov-seg am-ov-seg-warn" style="--g:${count.warn}"></span>` : '';
  return `<button type="button" class="am-ov-bar${selected ? ' is-sel' : ''}${extraClass}" data-am-narrow="day:${v.esc(key)}"${_pressed(selected)}`
    + ` aria-label="${aria}" title="${aria}" style="--h:${h}">${warn}${err}</button>`;
}

/** The When panel: Overdue bucket, one bar per day (zero days are disabled stubs), Later bucket, window band, ticks, legend. */
export function whenHtml(data: OverviewData, narrow: Narrow, v: OverviewViewDeps): string {
  const { t, esc } = v;
  const cols: string[] = [];
  const ticks: string[] = [];
  const stride = tickStride(data.days.length + 2);
  let prevMonth = '';
  const overdueLabel = t('am.ov_overdue');
  cols.push(`<div class="am-ov-col am-ov-col-overdue">${_barHtml('overdue', data.overdue, overdueLabel, narrow.day === 'overdue', data.maxDay, ' am-ov-bucket', v)}</div>`);
  ticks.push(`<span class="am-ov-tick am-ov-tick-bucket"><span class="am-ov-bl">${esc(overdueLabel)}</span></span>`);
  for (const b of data.days) {
    const sel = narrow.day === b.key;
    const today = b.isToday ? `<span class="am-ov-today" aria-hidden="true"><span class="am-ov-today-lbl">${esc(t('am.ov_today'))}</span></span>` : '';
    cols.push(`<div class="am-ov-col${b.isToday ? ' is-today' : ''}">${today}${_barHtml(b.key, b, v.fmtDay(b.key), sel, data.maxDay, '', v)}</div>`);
    if (b.offset % stride !== 0) { ticks.push('<span class="am-ov-tick"></span>'); continue; }
    const p = v.fmtTick(b.key);
    const month = b.key.slice(5, 7);
    // The month shows on the first label and where it changes. A first-column month is dropped when the next label is itself a
    // month change, so two month names never touch.
    const nextShown = data.days[b.offset + stride];
    const showMo = b.offset === 0 ? !(nextShown && nextShown.key.slice(5, 7) !== month) : month !== prevMonth;
    prevMonth = month;
    ticks.push(`<span class="am-ov-tick am-ov-tick-day${b.isToday ? ' is-today' : ''}">`
      + `<span class="am-ov-wd">${esc(p.wd)}</span><span class="am-ov-dn">${esc(p.day)}</span>`
      + `<span class="am-ov-mo">${showMo ? esc(p.mo) : ''}</span></span>`);
  }
  const laterLabel = t('am.ov_later');
  cols.push(`<div class="am-ov-col am-ov-col-later">${_barHtml('later', data.later, laterLabel, narrow.day === 'later', data.maxDay, ' am-ov-bucket', v)}</div>`);
  ticks.push(`<span class="am-ov-tick am-ov-tick-bucket"><span class="am-ov-bl">${esc(laterLabel)}</span></span>`);

  // Window band: the contiguous grid columns whose bars are inside the profile window (col 1 = Overdue, offset o = col o + 2).
  let first = -1, last = -1;
  if (data.overdue.inWindow) { first = 1; last = 1; }
  for (const b of data.days) if (b.inWindow) { if (first < 0) first = b.offset + 2; last = b.offset + 2; }
  const hasWin = first > 0;
  const band = hasWin ? `<div class="am-ov-win" aria-hidden="true" style="--c1:${first};--c2:${last + 1}"></div>` : '';

  const legend = `<div class="am-ov-legend">`
    + `<span class="am-ov-lg"><i class="am-ov-sw am-ov-sw-err" aria-hidden="true"></i>${esc(t('am.ov_err'))}</span>`
    + `<span class="am-ov-lg"><i class="am-ov-sw am-ov-sw-warn" aria-hidden="true"></i>${esc(t('am.ov_warn'))}</span>`
    + (hasWin ? `<span class="am-ov-lg"><i class="am-ov-sw am-ov-sw-win" aria-hidden="true"></i>${esc(t('am.ov_window'))}</span>` : '')
    + `</div>`;
  const nCols = data.days.length + 2;
  return `<div class="am-ov-panel am-ov-when${narrow.day ? ' has-sel' : ''}">`
    + `<div class="am-ov-eyebrow">${esc(t('am.ov_when'))}</div>`
    + `<div class="am-ov-chart" style="--cols:${nCols}">${band}${cols.join('')}</div>`
    + `<div class="am-ov-ticks" style="--cols:${nCols};--s:${stride}">${ticks.join('')}</div>`
    + legend + `</div>`;
}

/** The Where panel: one row per line (top 8, the selected line pinned, `+N more` ↔ Show fewer; the expanded list caps at 24). */
export function whereHtml(data: OverviewData, narrow: Narrow, showAll: boolean, v: OverviewViewDeps): string {
  const { t, esc } = v;
  const all = data.lines;
  const limit = showAll ? OV_LINES_MAX : OV_LINES_TOP;
  const shown = all.slice(0, limit);
  if (narrow.line && !shown.some(l => l.line === narrow.line)) {
    const pinned = all.find(l => l.line === narrow.line);
    if (pinned) shown.push(pinned);
  }
  let busiest = 1;
  for (const l of all) busiest = Math.max(busiest, l.err + l.warn);
  const rows = shown.map(l => {
    const sel = narrow.line === l.line;
    const label = l.line === NONE_KEY ? v.unassigned : l.line;
    const aria = esc(t('am.ov_line_aria', { line: label, e: l.err, w: l.warn }));
    const pct = (x: number): number => Math.round(x / busiest * 1000) / 10;
    const dot = l.overload
      ? `<span class="am-ov-dot" role="img" aria-label="${esc(t('am.ov_overload'))}" title="${esc(t('am.ov_overload'))}"></span>` : '';
    return `<button type="button" class="am-ov-row${sel ? ' is-sel' : ''}" data-am-narrow="line:${esc(l.line)}"${_pressed(sel)} aria-label="${aria}" title="${aria}">`
      + `<span class="am-ov-name">${esc(label)}</span>`
      + `<span class="am-ov-track" aria-hidden="true"><span class="am-ov-trk am-ov-trk-err" style="--w:${pct(l.err)}"></span><span class="am-ov-trk am-ov-trk-warn" style="--w:${pct(l.warn)}"></span></span>`
      + `<span class="am-ov-count">${l.err + l.warn}</span>${dot}</button>`;
  }).join('');
  let more = '';
  if (all.length > OV_LINES_TOP) {
    const hidden = Math.max(0, Math.min(all.length, OV_LINES_MAX) - OV_LINES_TOP);
    more = `<button type="button" class="am-ov-more" data-am-action="ov-lines-more" aria-expanded="${showAll}">`
      + `${esc(showAll ? t('am.ov_fewer') : t('am.ov_more', { n: hidden }))}</button>`;
  }
  return `<div class="am-ov-panel am-ov-where${narrow.line ? ' has-sel' : ''}${showAll ? ' is-all' : ''}">`
    + `<div class="am-ov-eyebrow">${esc(t('am.ov_where'))}</div>`
    + `<div class="am-ov-rows">${rows}</div>${more}</div>`;
}

/** The What panel: a proportional category strip (zero categories omitted) over a six-row legend (zeros last, disabled). */
export function whatHtml(data: OverviewData, narrow: Narrow, v: OverviewViewDeps): string {
  const { t, esc } = v;
  const live = data.categories.filter(c => c.count > 0);
  const dead = data.categories.filter(c => c.count === 0);
  const name = (cat: string): string => t(`ape.cat_${cat}`);
  const strip = live.map(c => {
    const sel = narrow.category === c.cat;
    const aria = esc(t('am.ov_cat_aria', { name: name(c.cat), n: c.count }));
    return `<button type="button" class="am-ov-cat am-ov-cat-${c.cat}${sel ? ' is-sel' : ''}" data-am-narrow="category:${c.cat}"${_pressed(sel)}`
      + ` aria-label="${aria}" title="${aria}" style="--g:${c.count}"><span class="am-ov-cat-n">${c.count}</span></button>`;
  }).join('');
  const row = (c: { cat: AlertCategory; count: number }): string => {
    const sel = narrow.category === c.cat;
    const nm = esc(name(c.cat));
    const aria = esc(t('am.ov_cat_aria', { name: name(c.cat), n: c.count }));
    const inner = `<span class="am-ov-sw am-ov-sw-${c.cat}" aria-hidden="true"></span><span class="am-ov-name" title="${nm}">${nm}</span><span class="am-ov-count">${c.count}</span>`;
    return c.count === 0
      ? `<button type="button" class="am-ov-catrow is-zero" disabled aria-label="${aria}">${inner}</button>`
      : `<button type="button" class="am-ov-catrow${sel ? ' is-sel' : ''}" data-am-narrow="category:${c.cat}"${_pressed(sel)} aria-label="${aria}" title="${aria}">${inner}</button>`;
  };
  return `<div class="am-ov-panel am-ov-what${narrow.category ? ' has-sel' : ''}">`
    + `<div class="am-ov-eyebrow">${esc(t('am.ov_what'))}</div>`
    + `<div class="am-ov-strip" role="group" aria-label="${esc(t('am.ov_what'))}">${strip}</div>`
    + `<div class="am-ov-catlist">${[...live, ...dead].map(row).join('')}</div></div>`;
}

export interface OverviewInput {
  data: OverviewData;
  narrow: Narrow;
  /** The Where panel is expanded past the top 8. */
  showAll: boolean;
  collapsed: boolean;
}

/** The whole `section.am-overview`: a head with the collapse toggle (and the strip text when collapsed) over the three panels. */
export function overviewHtml(i: OverviewInput, v: OverviewViewDeps): string {
  const { t, esc } = v;
  const toggleLabel = esc(t(i.collapsed ? 'am.ov_expand' : 'am.ov_collapse'));
  const overdue = i.data.overdue.err + i.data.overdue.warn;
  const hint = i.collapsed
    ? `<span class="panel-hint">${esc(t('am.ov_strip', { n: i.data.total, o: overdue }))}</span>` : '';
  return `<section class="am-overview${i.collapsed ? ' is-collapsed' : ''}">`
    + `<header class="panel-head">`
    + `<button type="button" class="am-ov-toggle" data-am-action="ov-toggle" aria-expanded="${!i.collapsed}" aria-controls="am-ov-body" aria-label="${toggleLabel}" title="${toggleLabel}">`
    + `<span class="am-caret" aria-hidden="true">${i.collapsed ? '▸' : '▾'}</span></button>`
    + `<h3>${esc(t('am.ov_title'))}</h3>${hint}</header>`
    + `<div id="am-ov-body" class="am-ov-body"${i.collapsed ? ' hidden' : ''}>`
    + whenHtml(i.data, i.narrow, v) + whereHtml(i.data, i.narrow, i.showAll, v) + whatHtml(i.data, i.narrow, v)
    + `</div></section>`;
}

export interface NarrowChipInput {
  /** Alerts the narrowed list shows / the unnarrowed total. */
  shown: number;
  total: number;
  narrow: Narrow;
  /** The display label of an active value (a day label, a line name, a category name; raw text, escaped here). */
  labelOf: (dim: NarrowDim, value: string) => string;
}

/** The "Showing N of M" chip row with one remove button per active dimension; '' when nothing is narrowed. */
export function narrowChipHtml(i: NarrowChipInput, t: Translate): string {
  if (!narrowActive(i.narrow)) return '';
  const dims: NarrowDim[] = ['day', 'line', 'category'];
  const buttons = dims.filter(d => i.narrow[d]).map(d => {
    const label = _escHtml(i.labelOf(d, i.narrow[d]!));
    const aria = _escHtml(t('am.ov_remove', { name: i.labelOf(d, i.narrow[d]!) }));
    return `<button type="button" class="am-narrow-x" data-am-narrow-clear="${d}" aria-label="${aria}" title="${aria}">`
      + `<span class="am-narrow-lbl">${label}</span><span class="am-narrow-glyph" aria-hidden="true">×</span></button>`;
  }).join('');
  return `<div class="am-narrow">`
    + `<span class="am-narrow-n">${_escHtml(t('am.ov_showing', { n: i.shown, total: i.total }))}</span>${buttons}`
    + `<button type="button" class="btn sm btn-ghost" data-am-action="clear-narrow">${_escHtml(t('am.ov_clear'))}</button></div>`;
}
