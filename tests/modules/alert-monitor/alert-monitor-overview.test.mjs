// Tests for frontend/alert-monitor/alert-monitor-overview.mts — the pure data / narrow / HTML half of the Overview band.
// A DST zone, so the spring-forward / fall-back cases below really cross a DST change (Node reads TZ lazily).
process.env.TZ = 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  horizonDays, overviewData, applyNarrow, narrowActive, toggleNarrow, pruneNarrow, parseNarrowAttr,
  tickStride, whenHtml, whereHtml, whatHtml, overviewHtml, narrowChipHtml,
} from '../../../frontend/alert-monitor/alert-monitor-overview.mjs';
import { groupAlerts, dayKeyOf } from '../../../frontend/insights/alert-profiles.mjs';

const TODAY = new Date(2026, 9, 20);   // 2026-10-20 local
const at = (off, h = 9) => new Date(2026, 9, 20 + off, h);
const keyFor = (off) => new Date(Date.UTC(2026, 9, 20 + off)).toISOString().slice(0, 10);
let seq = 0;
const alert = (o = {}) => ({ id: `a${++seq}`, sev: 'warn', type: 'overlap', line: 'L1', time: at(0), ...o });
const dueDeps = { dueInstant: (task) => new Date(task.original_end_date), latenessHours: () => 0 };
const base = (o = {}) => ({ tasksById: {}, plantToday: TODAY, horizonMinutes: 14 * 1440, window: null, deps: dueDeps, ...o });

// ---- horizonDays ----------------------------------------------------------------------------

test('horizonDays: window widens, clamps at 60, null window with 1440 minutes gives 1', () => {
  assert.equal(horizonDays(20160, { from: 0, to: 20 }), 21);
  assert.equal(horizonDays(20160, { from: 0, to: 80 }), 60);
  assert.equal(horizonDays(20160, null), 14);
  assert.equal(horizonDays(1440, null), 1);
  assert.equal(horizonDays(0, null), 1);
});

// ---- overviewData ---------------------------------------------------------------------------

test('overviewData: offsets -1/0/13/14/59 land in Overdue / day0 / day13 / Later / Later at N=14', () => {
  const alerts = [-1, 0, 13, 14, 59].map(o => alert({ time: at(o), sev: o === 0 ? 'err' : 'warn' }));
  const d = overviewData(alerts, base());
  assert.equal(d.days.length, 14);
  assert.equal(d.overdue.warn, 1);
  assert.equal(d.days[0].err, 1);
  assert.equal(d.days[13].warn, 1);
  assert.equal(d.later.warn, 2);
  assert.equal(d.total, 5);
  assert.equal(d.undated, 0);
});

test('overviewData: every column has a key from plantToday, zero-count columns included, consecutive across a DST change', () => {
  const d = overviewData([], base());
  assert.deepEqual(d.days.map(x => x.key), Array.from({ length: 14 }, (_, i) => keyFor(i)));
  assert.deepEqual(d.days.map(x => x.offset), Array.from({ length: 14 }, (_, i) => i));
  const dst = overviewData([], base({ plantToday: new Date(2026, 2, 5), horizonMinutes: 20 * 1440 }));
  assert.deepEqual(dst.days.map(x => x.key), Array.from({ length: 20 }, (_, i) => new Date(Date.UTC(2026, 2, 5 + i)).toISOString().slice(0, 10)));
  const fall = overviewData([], base({ plantToday: new Date(2026, 9, 29), horizonMinutes: 10 * 1440 }));
  assert.deepEqual(fall.days.map(x => x.key), Array.from({ length: 10 }, (_, i) => new Date(Date.UTC(2026, 9, 29 + i)).toISOString().slice(0, 10)));
});

test('overviewData: a line-less alert lands on key none and applyNarrow({line:none}) finds it', () => {
  const a = alert({ line: undefined });
  const b = alert({ line: 'L2' });
  const d = overviewData([a, b], base());
  assert.ok(d.lines.some(l => l.line === 'none'));
  assert.deepEqual(applyNarrow([a, b], { line: 'none' }, base()), [a]);
});

test('overviewData: an undated alert counts toward total and undated only (no day bar, overdue or later)', () => {
  const a = alert({ time: null });
  const d = overviewData([a], base());
  assert.equal(d.total, 1);
  assert.equal(d.undated, 1);
  assert.equal(d.overdue.err + d.overdue.warn, 0);
  assert.equal(d.later.err + d.later.warn, 0);
  assert.ok(d.days.every(x => x.err + x.warn === 0));
});

test('overviewData: inWindow for {0,7} and {-2,3}; today', () => {
  const w1 = overviewData([], base({ window: { from: 0, to: 7 } }));
  assert.deepEqual(w1.days.map(x => x.inWindow).slice(0, 10), [true, true, true, true, true, true, true, true, false, false]);
  assert.equal(w1.overdue.inWindow, false);
  const w2 = overviewData([], base({ window: { from: -2, to: 3 } }));
  assert.equal(w2.overdue.inWindow, true);
  assert.equal(w2.days[3].inWindow, true);
  assert.equal(w2.days[4].inWindow, false);
  assert.equal(w2.days[0].isToday, true);
  assert.equal(w2.days[1].isToday, false);
});

test('overviewData: err/warn split, overload flag, line sort, category order with zeros', () => {
  const alerts = [
    alert({ line: 'B', sev: 'err', type: 'overload' }),
    alert({ line: 'B', sev: 'warn' }),
    alert({ line: 'A', sev: 'warn' }),
    alert({ line: 'C', sev: 'warn' }),
    alert({ line: 'C', sev: 'err', type: 'blackout' }),
    alert({ line: 'D', sev: 'warn', type: 'setup-violated' }),
  ];
  const d = overviewData(alerts, base());
  assert.deepEqual(d.lines.map(l => l.line), ['B', 'C', 'A', 'D']);
  assert.equal(d.lines[0].err, 1);
  assert.equal(d.lines[0].warn, 1);
  assert.equal(d.lines[0].overload, true);
  assert.equal(d.lines[1].overload, false);
  assert.deepEqual(d.days[0], { ...d.days[0], err: 2, warn: 4 });
  assert.deepEqual(d.categories.map(c => c.cat), ['capacity', 'conflicts', 'calendar', 'setup', 'planning', 'exceptions']);
  assert.deepEqual(d.categories.map(c => c.count), [1, 3, 1, 1, 0, 0]);
  assert.equal(d.maxDay, 6);
});

test('overviewData: the D15 anchor (task due in 5 days, alert time today) puts the alert on day 5', () => {
  const a = alert({ taskId: 'T1', time: at(0) });
  const tasksById = { T1: { original_end_date: at(5, 12).toISOString() } };
  const d = overviewData([a], base({ tasksById }));
  assert.equal(d.days[5].warn, 1);
  assert.equal(d.days[0].warn, 0);
});

test('overviewData: a day key equals the groupAlerts day key', () => {
  const a = alert({ taskId: 'T1', time: at(0) });
  const tasksById = { T1: { original_end_date: at(3, 23).toISOString() } };
  const d = overviewData([a], base({ tasksById }));
  const g = groupAlerts([a], 'day', { tasksById, horizonStart: TODAY, horizonMinutes: 14 * 1440, plantToday: TODAY, deps: dueDeps });
  const bar = d.days.find(x => x.warn === 1);
  assert.equal(bar.key, g[0].key);
  assert.equal(dayKeyOf(at(3, 23)), bar.key);
});

// ---- narrow ---------------------------------------------------------------------------------

test('applyNarrow: AND semantics, overdue / later, undated exclusion, {} identity', () => {
  const a1 = alert({ line: 'L1', time: at(2), type: 'overlap' });
  const a2 = alert({ line: 'L1', time: at(2), type: 'blackout' });
  const a3 = alert({ line: 'L2', time: at(2), type: 'overlap' });
  const od = alert({ time: at(-3) });
  const lt = alert({ time: at(20) });
  const un = alert({ time: null });
  const all = [a1, a2, a3, od, lt, un];
  const d = base();
  assert.equal(applyNarrow(all, {}, d), all);
  assert.deepEqual(applyNarrow(all, { day: keyFor(2), line: 'L1' }, d), [a1, a2]);
  assert.deepEqual(applyNarrow(all, { day: keyFor(2), line: 'L1', category: 'calendar' }, d), [a2]);
  assert.deepEqual(applyNarrow(all, { day: 'overdue' }, d), [od]);
  assert.deepEqual(applyNarrow(all, { day: 'later' }, d), [lt]);
  assert.ok(!applyNarrow(all, { day: keyFor(2) }, d).includes(un));
  assert.deepEqual(applyNarrow(all, { category: 'conflicts', line: 'L2' }, d), [a3]);
});

test('toggleNarrow clears on repeat and returns a new object; narrowActive', () => {
  const n0 = {};
  const n1 = toggleNarrow(n0, 'line', 'L1');
  assert.deepEqual(n1, { line: 'L1' });
  assert.notEqual(n1, n0);
  const n2 = toggleNarrow(n1, 'line', 'L1');
  assert.deepEqual(n2, {});
  assert.notEqual(n2, n1);
  assert.deepEqual(toggleNarrow(n1, 'line', 'L2'), { line: 'L2' });
  assert.equal(narrowActive({}), false);
  assert.equal(narrowActive(n1), true);
});

test('pruneNarrow drops a dimension whose value has no alerts in the unnarrowed set', () => {
  const d = overviewData([alert({ line: 'L1', time: at(2) })], base());
  assert.deepEqual(pruneNarrow({ line: 'L1', day: keyFor(2), category: 'conflicts' }, d), { line: 'L1', day: keyFor(2), category: 'conflicts' });
  assert.deepEqual(pruneNarrow({ line: 'ZZ', day: keyFor(3), category: 'setup' }, d), {});
  assert.deepEqual(pruneNarrow({ day: 'overdue' }, d), {});
  assert.deepEqual(pruneNarrow({ day: 'later' }, d), {});
});

test('parseNarrowAttr splits at the first colon; an unknown dimension is null', () => {
  assert.deepEqual(parseNarrowAttr('day:2026-10-23'), { dim: 'day', value: '2026-10-23' });
  assert.deepEqual(parseNarrowAttr('line:A:B'), { dim: 'line', value: 'A:B' });
  assert.deepEqual(parseNarrowAttr('category:setup'), { dim: 'category', value: 'setup' });
  assert.equal(parseNarrowAttr('bogus:x'), null);
  assert.equal(parseNarrowAttr('nocolon'), null);
  assert.equal(parseNarrowAttr(null), null);
});

// ---- HTML -----------------------------------------------------------------------------------

const EN = {
  'am.ov_title': 'Overview', 'am.ov_expand': 'Show overview', 'am.ov_collapse': 'Hide overview',
  'am.ov_strip': 'Alerts {{n}} · Overdue {{o}}', 'am.ov_when': 'When', 'am.ov_where': 'Where', 'am.ov_what': 'What',
  'am.ov_conf': 'Confidence', 'am.ov_overdue': 'Overdue', 'am.ov_today': 'Today', 'am.ov_later': 'Later',
  'am.ov_err': 'Errors', 'am.ov_warn': 'Warnings', 'am.ov_window': 'Profile window',
  'am.ov_day_aria': '{{day}}: errors {{e}}, warnings {{w}}', 'am.ov_line_aria': '{{line}}: errors {{e}}, warnings {{w}}',
  'am.ov_overload': 'Has an overload alert', 'am.ov_more': '+{{n}} more', 'am.ov_fewer': 'Show fewer',
  'am.ov_cat_aria': '{{name}}: {{n}}', 'am.ov_conf_aria': 'Plant confidence {{score}}. Open the breakdown.',
  'am.ov_conf_after': '→ {{n}}', 'am.ov_conf_after_aria': 'After the top fix: {{n}}',
  'am.ov_showing': 'Showing {{n}} of {{total}}', 'am.ov_clear': 'Clear', 'am.ov_remove': 'Remove filter: {{name}}',
  'ape.cat_capacity': 'Capacity', 'ape.cat_conflicts': 'Scheduling conflicts', 'ape.cat_calendar': 'Calendar',
  'ape.cat_setup': 'Setup', 'ape.cat_planning': 'Planning', 'ape.cat_exceptions': 'Other',
};
const t = (k, v) => (EN[k] ?? k).replace(/\{\{(\w+)\}\}/g, (_, n) => String(v?.[n] ?? ''));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const v = { t, esc, fmtDay: (k) => `D ${k}`, fmtTick: (k) => ({ wd: `W${k.slice(8)}`, day: String(Number(k.slice(8))), mo: `M${k.slice(5, 7)}` }), unassigned: 'Unassigned' };
const BANNED = /points|pts|exact|estimate/i;

function sample() {
  const alerts = [
    alert({ line: 'L1', sev: 'err', time: at(0) }), alert({ line: 'L1', time: at(2) }), alert({ line: 'L2', time: at(2), type: 'setup-violated' }),
    alert({ line: 'L3', time: at(-2), type: 'overload' }), alert({ line: 'L4', time: at(30) }), alert({ line: '<b>x</b>', time: at(3) }),
  ];
  return overviewData(alerts, base({ window: { from: 0, to: 7 } }));
}

test('whenHtml: every bar has data-am-narrow except zero stubs; aria-pressed always present (false/true), .has-sel only with a selection', () => {
  const d = sample();
  const none = whenHtml(d, {}, v);
  assert.doesNotMatch(none, /aria-pressed="true"/);
  for (const b of none.match(/<button[^>]*data-am-narrow="[^"]*"[^>]*>/g) || []) assert.match(b, /aria-pressed="false"/);
  for (const b of none.match(/<button[^>]*am-ov-stub[^>]*>/g) || []) assert.doesNotMatch(b, /aria-pressed/, 'zero stubs are not toggles');
  assert.doesNotMatch(none, /has-sel/);
  assert.doesNotMatch(none, /is-sel/);
  const bars = none.match(/<button[^>]*class="am-ov-bar[^"]*"[^>]*>/g) || [];
  assert.equal(bars.length, 16);
  for (const b of bars) {
    if (/am-ov-stub/.test(b)) assert.doesNotMatch(b, /data-am-narrow/), assert.match(b, /disabled/);
    else assert.match(b, /data-am-narrow="(day:[^"]+)"/);
  }
  assert.match(none, /data-am-narrow="day:overdue"/);
  assert.match(none, /data-am-narrow="day:later"/);
  assert.match(none, new RegExp(`data-am-narrow="day:${keyFor(2)}"`));
  assert.match(none, /class="am-ov-win"/);
  assert.match(none, /Profile window/);
  const sel = whenHtml(d, { day: keyFor(2) }, v);
  assert.match(sel, /has-sel/);
  assert.equal((sel.match(/aria-pressed="true"/g) || []).length, 1);
  assert.equal((sel.match(/is-sel/g) || []).length, 1);
  assert.equal((sel.match(/aria-pressed="false"/g) || []).length, (none.match(/aria-pressed="false"/g) || []).length - 1);
  assert.match(none, /--h:100/);
  assert.match(none, /Today/);
  assert.doesNotMatch(none, BANNED);
});

test('whenHtml: the window item and band are omitted when no window exists', () => {
  const d = overviewData([alert()], base());
  const h = whenHtml(d, {}, v);
  assert.doesNotMatch(h, /am-ov-win"/);
  assert.doesNotMatch(h, /Profile window/);
});

test('whereHtml: escapes line names, pins the selected line beyond the top 8, +N more and Show fewer', () => {
  const alerts = [];
  for (let i = 0; i < 12; i++) for (let k = 0; k <= 12 - i; k++) alerts.push(alert({ line: `Line${String(i).padStart(2, '0')}`, time: at(1) }));
  alerts.push(alert({ line: '<b>', time: at(1) }));
  const d = overviewData(alerts, base());
  const h = whereHtml(d, {}, false, v);
  assert.equal((h.match(/class="am-ov-row[ "]/g) || []).length, 8);
  assert.match(h, /\+5 more/);
  assert.match(h, /data-am-action="ov-lines-more"/);
  assert.doesNotMatch(h, /<b>/);
  const pinned = whereHtml(d, { line: '<b>' }, false, v);
  assert.equal((pinned.match(/class="am-ov-row[ "]/g) || []).length, 9);
  assert.match(pinned, /&lt;b&gt;/);
  assert.match(pinned, /aria-pressed="true"/);
  assert.match(pinned, /has-sel/);
  const all = whereHtml(d, {}, true, v);
  assert.equal((all.match(/class="am-ov-row[ "]/g) || []).length, 13);
  assert.match(all, /Show fewer/);
  assert.doesNotMatch(h, BANNED);
});

test('whereHtml: unassigned label, overload dot, every row carries data-am-narrow', () => {
  const d = overviewData([alert({ line: undefined, type: 'overload' })], base());
  const h = whereHtml(d, {}, false, v);
  assert.match(h, /data-am-narrow="line:none"/);
  assert.match(h, /Unassigned/);
  assert.match(h, /class="am-ov-dot"[^>]*role="img"/);
  assert.doesNotMatch(h, /\+\d+ more/);
});

test('whatHtml: strip omits zero categories, legend lists all six with zeros disabled at the foot', () => {
  const d = sample();
  const h = whatHtml(d, {}, v);
  assert.match(h, /class="am-ov-strip" role="group"/);
  assert.doesNotMatch(h, /class="am-ov-strip"[^>]*aria-hidden/);
  assert.match(h, /data-am-narrow="category:capacity"/);
  const strip = h.slice(h.indexOf('am-ov-strip'), h.indexOf('am-ov-catlist'));
  assert.doesNotMatch(strip, /category:exceptions/);
  assert.doesNotMatch(strip, /tabindex="-1"/);
  assert.match(strip, /<button type="button" class="am-ov-cat am-ov-cat-capacity"[^>]*data-am-narrow="category:capacity" aria-pressed="false" aria-label=/);
  assert.equal((h.match(/class="am-ov-catrow/g) || []).length, 6);
  assert.match(h, /class="am-ov-catrow[^"]*"[^>]*disabled/);
  const sel = whatHtml(d, { category: 'setup' }, v);
  assert.match(sel, /has-sel/);
  assert.match(sel, /aria-pressed="true"/);
  assert.doesNotMatch(h, BANNED);
});

test('overviewHtml: expanded and collapsed variants', () => {
  const d = sample();
  const open = overviewHtml({ data: d, narrow: {}, showAll: false, collapsed: false }, v);
  assert.match(open, /^<section class="am-overview/);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /aria-controls="am-ov-body"/);
  assert.match(open, /id="am-ov-body"(?![^>]*hidden)/);
  assert.match(open, /data-am-action="ov-toggle"/);
  assert.doesNotMatch(open, /Alerts \d+ · Overdue/);
  const shut = overviewHtml({ data: d, narrow: {}, showAll: false, collapsed: true }, v);
  assert.match(shut, /aria-expanded="false"/);
  assert.match(shut, /id="am-ov-body"[^>]*hidden/);
  assert.match(shut, /Alerts 6 · Overdue 1/);
  assert.match(shut, /class="panel-hint"/);
  assert.doesNotMatch(open + shut, BANNED);
  // The Confidence card is gone: three panels, no confidence control, no gauge.
  assert.equal((open.match(/class="am-ov-panel /g) || []).length, 3);
  assert.doesNotMatch(open, /am-ov-conf|ov-conf|am-ov-gauge|am-ov-spark/);
});

test('narrowChipHtml: empty when inactive; one remove button per dimension in order day, line, category', () => {
  const labelOf = (dim, val) => `${dim}=${val}`;
  assert.equal(narrowChipHtml({ shown: 3, total: 9, narrow: {}, labelOf }, t), '');
  const h = narrowChipHtml({ shown: 3, total: 9, narrow: { category: 'setup', day: '2026-10-23', line: '<i>' }, labelOf }, t);
  assert.match(h, /Showing 3 of 9/);
  assert.doesNotMatch(h, /aria-live/, 'the live region is the pane\'s persistent #am-narrow-status, not this row');
  assert.ok(h.indexOf('data-am-narrow-clear="day"') < h.indexOf('data-am-narrow-clear="line"'));
  assert.ok(h.indexOf('data-am-narrow-clear="line"') < h.indexOf('data-am-narrow-clear="category"'));
  assert.match(h, /Remove filter: line=&lt;i&gt;/);
  assert.match(h, /data-am-action="clear-narrow"/);
  assert.doesNotMatch(h, /<i>/);
});

test('fix round 1: err/warn stacking order, custom-property-only inline styles, 24-row cap, +N more, maxDay 0', () => {
  const d = sample();
  const when = whenHtml(d, {}, v);
  // One day holding BOTH severities: compare the segments inside that one bar's own <button>.
  const mixed = whenHtml(overviewData([
    alert({ sev: 'err', time: at(1) }), alert({ sev: 'warn', time: at(1) }),
  ], base({ window: { from: 0, to: 7 } })), {}, v);
  const barBtn = new RegExp(`<button[^>]*data-am-narrow="day:${keyFor(1)}"[^>]*>[\\s\\S]*?</button>`).exec(mixed)?.[0];
  assert.ok(barBtn, 'the mixed day bar exists');
  const wi = barBtn.indexOf('am-ov-seg-warn'), ei = barBtn.indexOf('am-ov-seg-err');
  assert.ok(wi >= 0 && ei >= 0, 'both segments sit in that one bar');
  assert.ok(wi < ei, 'DOM order warn then err (CSS column puts err at the base)');
  const win = when.match(/class="am-ov-win"[^>]*style="([^"]*)"/)[1];
  assert.match(win, /^--c1:\d+;--c2:\d+$/);
  for (const html of [when, whereHtml(d, {}, false, v), whatHtml(d, {}, v)]) {
    for (const m of html.matchAll(/style="([^"]*)"/g)) {
      for (const decl of m[1].split(';')) assert.match(decl, /^--[a-z0-9]+:[-\d.]+$/, 'inline style is a custom property: ' + decl);
    }
  }
  const alerts = [];
  for (let i = 0; i < 40; i++) alerts.push(alert({ line: 'Line' + String(i).padStart(2, '0'), time: at(1) }));
  const big = overviewData(alerts, base());
  const expanded = whereHtml(big, {}, true, v);
  assert.equal((expanded.match(/class="am-ov-row[ "]/g) || []).length, 24);
  assert.match(whereHtml(big, {}, false, v), /\+16 more/);
  const empty = overviewData([], base());
  const wh = whenHtml(empty, {}, v);
  assert.doesNotMatch(wh, /data-am-narrow/);
  assert.doesNotMatch(wh, /NaN|Infinity/);
  assert.equal(empty.maxDay, 0);
});

test('fix round 1: pruneNarrow keeps object identity when nothing drops', () => {
  const d = overviewData([alert({ line: 'L1', time: at(2) })], base());
  const n = { line: 'L1' };
  assert.equal(pruneNarrow(n, d), n);
  assert.notEqual(pruneNarrow({ line: 'ZZ' }, d), { line: 'ZZ' });
});

// ---- day labels under the bars ----------------------------------------------------------------

const tickRow = (html) => html.slice(html.indexOf('class="am-ov-ticks"'), html.indexOf('class="am-ov-legend"'));
const dayTicks = (html) => tickRow(html).match(/<span class="am-ov-tick am-ov-tick-day[^"]*">.*?<\/span><\/span>/g) || [];

test('tickStride: 1 up to 29 columns, 2 up to 58, 3 beyond (15 px slot over a 436 px chart)', () => {
  assert.equal(tickStride(18), 1);
  assert.equal(tickStride(23), 1);
  assert.equal(tickStride(29), 1);
  assert.equal(tickStride(30), 2);
  assert.equal(tickStride(58), 2);
  assert.equal(tickStride(59), 3);
  assert.equal(tickStride(62), 3);
  assert.equal(tickStride(0), 1);
});

test('whenHtml ticks: every day column is labelled (weekday over day number), Overdue and Later keep bucket labels only', () => {
  const h = whenHtml(overviewData([alert()], base()), {}, v);   // 14 days = 16 columns
  const row = tickRow(h);
  assert.equal((row.match(/class="am-ov-tick[ "]/g) || []).length, 16, 'one tick per column');
  assert.equal(dayTicks(h).length, 14, 'every day column has a day label');
  assert.match(row, /<span class="am-ov-tick am-ov-tick-bucket"><span class="am-ov-bl">Overdue<\/span><\/span>/);
  assert.match(row, /<span class="am-ov-tick am-ov-tick-bucket"><span class="am-ov-bl">Later<\/span><\/span>/);
  assert.doesNotMatch(row, /am-ov-tick-day[^>]*>(?:(?!<\/span><\/span>).)*Later/, 'Later has no day label');
  const first = dayTicks(h)[0];
  assert.match(first, /class="am-ov-tick am-ov-tick-day is-today"/);
  assert.match(first, /<span class="am-ov-wd">W20<\/span><span class="am-ov-dn">20<\/span>/);
  assert.equal((row.match(/is-today/g) || []).length, 1, 'only today is emphasised');
  assert.match(row, /--cols:16;--s:1/);
});

test('whenHtml ticks: the month shows on the first column and where it changes, never on two adjacent labels', () => {
  // Today is 2026-10-20: day 12 is 2026-11-01 (a change); the first column carries Oct.
  const h = whenHtml(overviewData([alert()], base({ horizonMinutes: 16 * 1440 })), {}, v);
  const months = dayTicks(h).map(x => /<span class="am-ov-mo">([^<]*)<\/span>/.exec(x)[1]);
  assert.equal(months[0], 'M10');
  assert.equal(months[12], 'M11');
  assert.equal(months.filter(Boolean).length, 2);
  // Today is the 31st: the next column is a month change, so the first column drops its month (no 'Oct' next to 'Nov').
  const edge = whenHtml(overviewData([alert({ time: new Date(2026, 9, 31, 9) })], base({ plantToday: new Date(2026, 9, 31), horizonMinutes: 10 * 1440 })), {}, v);
  const em = dayTicks(edge).map(x => /<span class="am-ov-mo">([^<]*)<\/span>/.exec(x)[1]);
  assert.deepEqual(em.slice(0, 2), ['', 'M11']);
  assert.ok(em.slice(1).filter(Boolean).length === 1);
});

test('whenHtml ticks: a long horizon thins the labels by the stride and keeps one tick per column', () => {
  const h = whenHtml(overviewData([alert()], base({ horizonMinutes: 60 * 1440 })), {}, v);   // 62 columns, stride 3
  const row = tickRow(h);
  assert.match(row, /--cols:62;--s:3/);
  assert.equal((row.match(/class="am-ov-tick[ "]/g) || []).length, 62);
  assert.equal(dayTicks(h).length, 20, 'days 0, 3, 6 ... 57');
  const days = dayTicks(h).map(x => /am-ov-dn">(\d+)</.exec(x)[1]);
  assert.equal(days[0], '20');
  assert.equal(days[1], '23');
});

test('whenHtml ticks: tick parts are escaped once', () => {
  const evil = { ...v, fmtTick: () => ({ wd: '<b>', day: '1', mo: '&' }) };
  const h = whenHtml(overviewData([alert()], base()), {}, evil);
  assert.doesNotMatch(tickRow(h), /<b>/);
  assert.match(tickRow(h), /&lt;b&gt;/);
});

// ---- rev-3 fix wave ---------------------------------------------------------------------------

test('parity: for every day bar, applyNarrow({day}).length equals err + warn (DST fall-back inside the 40-day span, hours 0 and 23)', () => {
  const alerts = [];
  const tasksById = {};
  for (let i = 0; i < 160; i++) {
    const off = (i * 7) % 40 - 2;
    const hasTask = i % 3 === 0;
    const id = `t${i}`;
    if (hasTask) tasksById[id] = { id, original_end_date: at(off + (i % 5 - 2), i % 2 ? 0 : 23) };
    alerts.push(alert({ sev: i % 4 === 0 ? 'err' : 'warn', line: `L${i % 5}`, time: at(off, i % 2 ? 0 : 23), taskId: hasTask ? id : undefined }));
  }
  const d = base({ tasksById, horizonMinutes: 40 * 1440 });
  const data = overviewData(alerts, d);
  assert.equal(data.days.length, 40);
  for (const b of data.days) assert.equal(applyNarrow(alerts, { day: b.key }, d).length, b.err + b.warn, b.key);
  assert.equal(applyNarrow(alerts, { day: 'overdue' }, d).length, data.overdue.err + data.overdue.warn);
  assert.equal(applyNarrow(alerts, { day: 'later' }, d).length, data.later.err + data.later.warn);
});

test('the per-call due memo: one dueInstant call per task, same bins as the unmemoised anchor, an unresolvable due falls back to the alert time', () => {
  const calls = new Map();
  const deps = { dueInstant: task => { calls.set(task.id, (calls.get(task.id) ?? 0) + 1); return task.id === 'bad' ? null : new Date(task.original_end_date); }, latenessHours: () => 0 };
  const tasksById = { t1: { id: 't1', original_end_date: at(3) }, bad: { id: 'bad', original_end_date: at(9) } };
  const alerts = [
    alert({ taskId: 't1', time: at(0) }), alert({ taskId: 't1', time: at(1) }), alert({ taskId: 't1', time: at(2) }),
    alert({ taskId: 'bad', time: at(1) }), alert({ taskId: 'bad', time: at(5) }),
  ];
  const d = base({ tasksById, deps });
  const data = overviewData(alerts, d);
  assert.equal(calls.get('t1'), 1);
  assert.equal(calls.get('bad'), 1);
  assert.equal(data.days[3].warn, 3, 'the three t1 alerts sit on their due day');
  assert.equal(data.days[1].warn, 1);
  assert.equal(data.days[5].warn, 1, 'a due that does not resolve anchors on the alert time');
  calls.clear();
  assert.equal(applyNarrow(alerts, { day: data.days[3].key }, d).length, 3);
  assert.equal(calls.get('t1'), 1, 'applyNarrow memoises per call too');
});
