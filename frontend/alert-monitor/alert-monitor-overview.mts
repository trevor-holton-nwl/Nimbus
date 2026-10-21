/* =============================================================================
   ALERT MONITOR OVERVIEW — pure data, narrowing, SVG math and HTML builders for
   the four-panel Overview band (When / Where / What / Confidence).

   No Store, no DOM, no globals: every input is passed in, every string comes
   through an injected `t`, and every interpolated value goes through the injected
   `esc` exactly once (callers must not escape again). The model never imports
   this module; the pane does the wiring.

   A "narrow" is a view-only AND-filter (day, line, category) over the alerts the
   list shows. Nothing here touches a persisted pref or emits an event.
   ========================================================================== */

import type { AlertCategory, NimbusTask } from '../platform/types.mjs';
import { MONITOR_CATEGORIES } from './alert-monitor-model.mjs';
import { anchorTime, alertDayOffset, categoryOf, dayKeyOf } from '../insights/alert-profiles.mjs';
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
  labelTick: boolean;
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

const NONE_KEY = 'none';
const MAX_DAYS = 60;

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
  const stride = n <= 28 ? 7 : 14;
  const days: DayBar[] = [];
  for (let i = 0; i < n; i++) {
    days.push({
      key: dayKeyOf(new Date(y, m, day + i)),   // local-date construction: DST-safe, never derived from alerts
      offset: i, err: 0, warn: 0,
      inWindow: !!win && i >= win.from && i <= win.to,
      isToday: i === 0,
      labelTick: i % stride === 0 && i > 0,
    });
  }
  const overdue = { err: 0, warn: 0, inWindow: !!win && win.from < 0 };
  const later = { err: 0, warn: 0 };
  const lineMap = new Map<string, { line: string; err: number; warn: number; overload: boolean }>();
  const catCount = new Map<AlertCategory, number>();
  let undated = 0;

  for (const a of listed) {
    const isErr = a.sev === 'err';
    const task = a.taskId ? d.tasksById?.[a.taskId] : undefined;
    const anchor = anchorTime(a, task, d.deps);
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
    categories: MONITOR_CATEGORIES.map(cat => ({ cat, count: catCount.get(cat) ?? 0 })),
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
  return listed.filter(a => {
    if (n.line && (a.line || NONE_KEY) !== n.line) return false;
    if (n.category && categoryOf(a.type) !== n.category) return false;
    if (n.day) {
      const task = a.taskId ? d.tasksById?.[a.taskId] : undefined;
      const anchor = anchorTime(a, task, d.deps);
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

// ---- SVG math -------------------------------------------------------------------------------

const _r2 = (x: number): number => Math.round(x * 100) / 100;
const _clampScore = (s: number): number => (typeof s === 'number' && isFinite(s) ? Math.min(100, Math.max(0, s)) : 0);
const GAUGE_START = 135;   // degrees, SVG coordinates (y down): lower-left
const GAUGE_SWEEP = 270;   // clockwise on screen, ending at 45 degrees (lower-right)

/** Point on the gauge ring for a score (0 at the lower-left, 100 at the lower-right, clockwise). */
export function arcPoint(score: number, cx: number, cy: number, r: number): { x: number; y: number } {
  const ang = (GAUGE_START + GAUGE_SWEEP * _clampScore(score) / 100) * Math.PI / 180;
  return { x: _r2(cx + r * Math.cos(ang)), y: _r2(cy + r * Math.sin(ang)) };
}

/** SVG path `d` of the value arc from 0 to `score`; '' for a score of 0 or less. */
export function arcPath(score: number, cx: number, cy: number, r: number): string {
  const s = _clampScore(score);
  if (s <= 0) return '';
  const a = arcPoint(0, cx, cy, r), b = arcPoint(s, cx, cy, r);
  const large = GAUGE_SWEEP * s / 100 > 180 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} 1 ${b.x} ${b.y}`;
}

/** SVG path `d` of a short radial tick across the ring at `score` (the ghost / after-fix marker). */
export function arcTick(score: number, cx: number, cy: number, r1: number, r2: number): string {
  const a = arcPoint(score, cx, cy, r1), b = arcPoint(score, cx, cy, r2);
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
}

export function confTier(score: number): 'ok' | 'warn' | 'err' {
  return score >= 60 ? 'ok' : score >= 40 ? 'warn' : 'err';
}

/** Sparkline path over a fixed 0..100 y range; '' under 2 points; bucket-averaged to at most `maxPts` points. */
export function sparkPath(history: ReadonlyArray<{ ts: number; score: number }>, w: number, h: number, maxPts = 40): string {
  const n = history?.length ?? 0;
  if (n < 2) return '';
  const cap = Math.max(2, Math.floor(maxPts));
  let ys: number[];
  if (n <= cap) ys = history.map(p => _clampScore(p.score));
  else {
    ys = [];
    for (let i = 0; i < cap; i++) {
      const lo = Math.floor(i * n / cap), hi = Math.max(lo + 1, Math.floor((i + 1) * n / cap));
      let sum = 0;
      for (let k = lo; k < hi; k++) sum += _clampScore(history[k].score);
      ys.push(sum / (hi - lo));
    }
  }
  const last = ys.length - 1;
  const r1 = (x: number): number => Math.round(x * 10) / 10;
  return ys.map((s, i) => `${i === 0 ? 'M' : 'L'} ${r1(i / last * w)} ${r1(h - s / 100 * h)}`).join(' ');
}

// ---- HTML builders --------------------------------------------------------------------------

/** The injected view dependencies of every HTML builder (except `narrowChipHtml`, which takes `t` alone). */
export interface OverviewViewDeps {
  t: Translate;
  /** HTML-escape (text and attribute safe); the builders call it exactly once per interpolated value. */
  esc: (s: unknown) => string;
  /** "Thu 23 Oct" for a `YYYY-MM-DD` key. */
  fmtDay: (dayKey: string) => string;
  /** The short axis label for a tick column ("Oct 27" or "+7"). */
  fmtTick: (dayKey: string) => string;
  /** The "Unassigned" label for the `none` line. */
  unassigned: string;
}

/** Same escaping as the model's private `_esc`; used by `narrowChipHtml`, which has no `esc` injected. */
const _escHtml = (s: unknown): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Lines shown before "+N more", and the cap of the expanded list. */
export const OV_LINES_TOP = 8;
export const OV_LINES_MAX = 24;

const _pressed = (sel: boolean): string => (sel ? ' aria-pressed="true"' : '');

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
  const err = count.err ? `<span class="am-ov-seg am-ov-seg-err" style="flex-grow:${count.err}"></span>` : '';
  const warn = count.warn ? `<span class="am-ov-seg am-ov-seg-warn" style="flex-grow:${count.warn}"></span>` : '';
  return `<button type="button" class="am-ov-bar${selected ? ' is-sel' : ''}${extraClass}" data-am-narrow="day:${v.esc(key)}"${_pressed(selected)}`
    + ` aria-label="${aria}" title="${aria}" style="--h:${h}">${warn}${err}</button>`;
}

/** The When panel: Overdue bucket, one bar per day (zero days are disabled stubs), Later bucket, window band, ticks, legend. */
export function whenHtml(data: OverviewData, narrow: Narrow, v: OverviewViewDeps): string {
  const { t, esc } = v;
  const cols: string[] = [];
  const ticks: string[] = [];
  const overdueLabel = t('am.ov_overdue');
  cols.push(`<div class="am-ov-col am-ov-col-overdue">${_barHtml('overdue', data.overdue, overdueLabel, narrow.day === 'overdue', data.maxDay, ' am-ov-bucket', v)}</div>`);
  ticks.push(`<span class="am-ov-tick am-ov-tick-bucket">${esc(overdueLabel)}</span>`);
  for (const b of data.days) {
    const sel = narrow.day === b.key;
    const today = b.isToday ? `<span class="am-ov-today" aria-hidden="true"><span class="am-ov-today-lbl">${esc(t('am.ov_today'))}</span></span>` : '';
    cols.push(`<div class="am-ov-col${b.isToday ? ' is-today' : ''}">${today}${_barHtml(b.key, b, v.fmtDay(b.key), sel, data.maxDay, '', v)}</div>`);
    ticks.push(`<span class="am-ov-tick">${b.labelTick ? esc(v.fmtTick(b.key)) : ''}</span>`);
  }
  const laterLabel = t('am.ov_later');
  cols.push(`<div class="am-ov-col am-ov-col-later">${_barHtml('later', data.later, laterLabel, narrow.day === 'later', data.maxDay, ' am-ov-bucket', v)}</div>`);
  ticks.push(`<span class="am-ov-tick am-ov-tick-bucket">${esc(laterLabel)}</span>`);

  // Window band: the contiguous grid columns whose bars are inside the profile window (col 1 = Overdue, offset o = col o + 2).
  let first = -1, last = -1;
  if (data.overdue.inWindow) { first = 1; last = 1; }
  for (const b of data.days) if (b.inWindow) { if (first < 0) first = b.offset + 2; last = b.offset + 2; }
  const hasWin = first > 0;
  const band = hasWin ? `<div class="am-ov-win" aria-hidden="true" style="grid-column:${first} / ${last + 1}"></div>` : '';

  const legend = `<div class="am-ov-legend">`
    + `<span class="am-ov-lg"><i class="am-ov-sw am-ov-sw-err" aria-hidden="true"></i>${esc(t('am.ov_err'))}</span>`
    + `<span class="am-ov-lg"><i class="am-ov-sw am-ov-sw-warn" aria-hidden="true"></i>${esc(t('am.ov_warn'))}</span>`
    + (hasWin ? `<span class="am-ov-lg"><i class="am-ov-sw am-ov-sw-win" aria-hidden="true"></i>${esc(t('am.ov_window'))}</span>` : '')
    + `</div>`;
  const nCols = data.days.length + 2;
  return `<div class="am-ov-panel am-ov-when${narrow.day ? ' has-sel' : ''}">`
    + `<div class="am-ov-eyebrow">${esc(t('am.ov_when'))}</div>`
    + `<div class="am-ov-chart" style="--cols:${nCols}">${band}${cols.join('')}</div>`
    + `<div class="am-ov-ticks" style="--cols:${nCols}">${ticks.join('')}</div>`
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
      + `<span class="am-ov-track" aria-hidden="true"><span class="am-ov-trk am-ov-trk-err" style="width:${pct(l.err)}%"></span><span class="am-ov-trk am-ov-trk-warn" style="width:${pct(l.warn)}%"></span></span>`
      + `<span class="am-ov-count">${l.err + l.warn}</span>${dot}</button>`;
  }).join('');
  let more = '';
  if (all.length > OV_LINES_TOP) {
    const hidden = Math.max(0, all.length - OV_LINES_TOP);
    more = `<button type="button" class="am-ov-more" data-am-action="ov-lines-more" aria-expanded="${showAll}">`
      + `${esc(showAll ? t('am.ov_fewer') : t('am.ov_more', { n: hidden }))}</button>`;
  }
  return `<div class="am-ov-panel am-ov-where${narrow.line ? ' has-sel' : ''}${showAll ? ' is-all' : ''}">`
    + `<div class="am-ov-eyebrow">${esc(t('am.ov_where'))}</div>`
    + `<div class="am-ov-rows">${rows}</div>${more}</div>`;
}

/** The What panel: a proportional category strip (zero categories omitted) over a five-row legend (zeros last, disabled). */
export function whatHtml(data: OverviewData, narrow: Narrow, v: OverviewViewDeps): string {
  const { t, esc } = v;
  const live = data.categories.filter(c => c.count > 0);
  const dead = data.categories.filter(c => c.count === 0);
  const name = (cat: string): string => t(`ape.cat_${cat}`);
  const strip = live.map(c => {
    const sel = narrow.category === c.cat;
    const aria = esc(t('am.ov_cat_aria', { name: name(c.cat), n: c.count }));
    return `<button type="button" class="am-ov-cat am-ov-cat-${c.cat}${sel ? ' is-sel' : ''}" tabindex="-1" data-am-narrow="category:${c.cat}"${_pressed(sel)}`
      + ` aria-label="${aria}" title="${aria}" style="flex-grow:${c.count}"><span class="am-ov-cat-n">${c.count}</span></button>`;
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
    + `<div class="am-ov-strip" aria-hidden="true">${strip}</div>`
    + `<div class="am-ov-catlist">${[...live, ...dead].map(row).join('')}</div></div>`;
}

export interface ConfidenceInput {
  /** The plant confidence (0-100); null omits the panel. */
  score: number | null;
  history: ReadonlyArray<{ ts: number; score: number }>;
  /** The already-rounded score after the top fix; null draws no marker. */
  ghost: number | null;
}

const _GAUGE = { w: 126, h: 92, cx: 63, cy: 50, r: 38 };
const _SPARK = { w: 126, h: 22 };

/** The Confidence panel: one button (opens the breakdown) wrapping the gauge, the optional after-fix marker and a sparkline. */
export function confidenceHtml(c: ConfidenceInput, v: OverviewViewDeps): string {
  const { t, esc } = v;
  if (c.score == null || !isFinite(c.score)) return '';
  const g = _GAUGE;
  const score = Math.round(c.score);
  const val = arcPath(c.score, g.cx, g.cy, g.r);
  let ghost = '';
  let after = '';
  if (c.ghost != null && isFinite(c.ghost)) {
    const afterAria = esc(t('am.ov_conf_after_aria', { n: c.ghost }));
    ghost = `<path class="am-ov-conf-tick" d="${arcTick(c.ghost, g.cx, g.cy, g.r - 6, g.r + 6)}"><title>${afterAria}</title></path>`;
    after = `<text class="am-ov-conf-after" x="${g.cx}" y="${g.cy + 20}" text-anchor="middle"><title>${afterAria}</title>${esc(t('am.ov_conf_after', { n: c.ghost }))}</text>`;
  }
  const svg = `<svg class="am-ov-gauge" viewBox="0 0 ${g.w} ${g.h}" width="${g.w}" height="${g.h}" role="img" aria-label="${esc(t('am.ov_conf_aria', { score }))}">`
    + `<path class="am-ov-conf-track" d="${arcPath(100, g.cx, g.cy, g.r)}" fill="none"></path>`
    + (val ? `<path class="am-ov-conf-val ${confTier(c.score)}" d="${val}" fill="none"></path>` : '')
    + ghost
    + `<text class="am-ov-conf-n" x="${g.cx}" y="${g.cy + 6}" text-anchor="middle">${score}</text>${after}</svg>`;
  const sp = sparkPath(c.history, _SPARK.w, _SPARK.h);
  const spark = sp
    ? `<svg class="am-ov-spark" viewBox="0 0 ${_SPARK.w} ${_SPARK.h}" width="${_SPARK.w}" height="${_SPARK.h}" aria-hidden="true"><path class="am-ov-spark-line" d="${sp}" fill="none"></path></svg>` : '';
  const label = esc(t('am.ov_conf_aria', { score }));
  return `<div class="am-ov-panel am-ov-conf">`
    + `<div class="am-ov-eyebrow">${esc(t('am.ov_conf'))}</div>`
    + `<button type="button" class="am-ov-confbtn" data-am-action="ov-conf" title="${label}">${svg}${spark}</button></div>`;
}

export interface OverviewInput {
  data: OverviewData;
  narrow: Narrow;
  /** The Where panel is expanded past the top 8. */
  showAll: boolean;
  conf: ConfidenceInput;
  collapsed: boolean;
}

/** The whole `section.am-overview`: a head with the collapse toggle (and the strip text when collapsed) over the four panels. */
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
    + confidenceHtml(i.conf, v) + `</div></section>`;
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
  return `<div class="am-narrow" aria-live="polite">`
    + `<span class="am-narrow-n">${_escHtml(t('am.ov_showing', { n: i.shown, total: i.total }))}</span>${buttons}`
    + `<button type="button" class="btn sm btn-ghost" data-am-action="clear-narrow">${_escHtml(t('am.ov_clear'))}</button></div>`;
}
