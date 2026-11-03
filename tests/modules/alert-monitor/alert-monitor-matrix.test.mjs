// Tests for the pure Matrix model and markup in frontend/alert-monitor/alert-monitor-matrix.mts (W6a).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matrixModel, matrixHtml, cellFilter, rowFilter, colFilter, filterMatches, GROUP_ROW_PREFIX, MAX_CELL_DOTS,
} from '../../../frontend/alert-monitor/alert-monitor-matrix.mjs';
import { emptyFilter, UNGROUPED_KEY, makeBucketer } from '../../../frontend/alert-monitor/alert-monitor-model.mjs';
import { horizonDayKeys, OVERDUE_KEY, LATER_KEY, NONE_KEY } from '../../../frontend/alert-monitor/alert-monitor-overview.mjs';

const t = (k, v) => `${k}${v ? '|' + Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',') : ''}`;
const today = new Date(2026, 9, 30);
const D0 = '2026-10-30', D1 = '2026-10-31', D2 = '2026-11-01';
const labels = {
  day: k => `d:${k}`, category: c => `cat:${c}`, ungrouped: 'Ungrouped', noMachine: 'No machine', machinesCount: n => `${n} machines`,
};
const machines = [
  { id: 'M1', name: 'Press 1', wc_group: 'A' }, { id: 'M2', name: 'M2', wc_group: 'A' }, { id: 'M3', wc_group: 'A' },
  { id: 'M4', wc_group: 'B' }, { id: 'M5', wc_group: '' },
];
const ctx = (o = {}) => ({ plantToday: today, horizonDays: 3, machines, labels, ...o });
let n = 0;
const al = (line, sev, type, when, o = {}) => ({ id: `a${++n}`, sev, type, line, time: when, ...o });
const at = (dayOffset) => new Date(2026, 9, 30 + dayOffset, 9);

const alerts = () => [
  al('M1', 'err', 'overlap', at(0)),
  al('M1', 'warn', 'late', at(0)),
  al('M1', 'warn', 'late', at(1)),
  al('M2', 'warn', 'late', at(1)),
  al('M4', 'err', 'overload', at(-2)),
  al('M5', 'warn', 'setup-uncovered', at(5)),
  al('M9', 'warn', 'late', null),           // a machine the master lacks, no anchor
  al(undefined, 'err', 'plant_no_timezone', at(2)),
];

test('machine lens: columns are overdue, the horizon days, later and none', () => {
  const m = matrixModel(alerts(), 'machine', ctx());
  assert.deepEqual(m.columns.map(c => c.key), ['overdue', D0, D1, D2, 'later', 'none']);
  assert.equal(m.columns[1].label, `d:${D0}`);
  assert.equal(m.total, 8);
});

test('machine lens groups by wc_group; blank and unknown machines fall in Ungrouped; no-machine alerts get their own row', () => {
  const m = matrixModel(alerts(), 'machine', ctx());
  const keys = m.groups.map(g => g.key);
  assert.deepEqual([...keys].sort(), ['A', 'B', UNGROUPED_KEY].sort());
  const ung = m.groups.find(g => g.key === UNGROUPED_KEY);
  assert.equal(ung.label, 'Ungrouped');
  assert.deepEqual(ung.rows.map(r => r.head.key).sort(), ['M5', 'M9', 'none']);
  assert.equal(ung.rows.find(r => r.head.key === 'none').head.label, 'No machine');
  assert.equal(m.groups.reduce((s, g) => s + g.head.total, 0), 8, 'group roll-ups add up to every alert');
});

test('groups sort worst severity then count, Ungrouped last on ties; machines pinned first, then worst, then count', () => {
  const m = matrixModel(alerts(), 'machine', ctx());
  assert.equal(m.groups[0].key, 'A', 'A has an error and the most alerts');
  const a = m.groups.find(g => g.key === 'A');
  assert.deepEqual(a.rows.map(r => r.head.key), ['M1', 'M2'], 'M1: error + 3; M2: warn only');
  const pinned = matrixModel(alerts(), 'machine', ctx({ pinned: new Set(['M2']) })).groups.find(g => g.key === 'A');
  assert.deepEqual(pinned.rows.map(r => r.head.key), ['M2', 'M1'], 'a pinned machine sorts first');
  const warnHeavy = [al('M1', 'warn', 'late', at(0)), al('M1', 'warn', 'late', at(0)), al('M2', 'err', 'overlap', at(0))];
  assert.deepEqual(matrixModel(warnHeavy, 'machine', ctx()).groups.find(g => g.key === 'A').rows.map(r => r.head.key), ['M2', 'M1'], 'an error beats a bigger warning count');
});

test('quiet machines are separated into group.quiet; the fold state comes from the ctx', () => {
  const m = matrixModel(alerts(), 'machine', ctx({ collapsed: new Set(['B']), quietOpen: new Set(['A']) }));
  const a = m.groups.find(g => g.key === 'A');
  assert.deepEqual(a.quiet.map(r => r.head.key), ['M3']);
  assert.equal(a.machineCount, 3);
  assert.equal(a.quietOpen, true);
  assert.equal(m.groups.find(g => g.key === 'B').collapsed, true);
  assert.equal(m.groups.find(g => g.key === 'B').quiet.length, 0);
});

test('a cell is a count tinted by worst severity with up to four group colors in category order', () => {
  const m = matrixModel(alerts(), 'machine', ctx());
  const m1 = m.groups.find(g => g.key === 'A').rows.find(r => r.head.key === 'M1');
  const c0 = m1.cells[m1.cells.findIndex(c => c.colKey === D0)];
  assert.equal(c0.count, 2);
  assert.equal(c0.worst, 'err');
  assert.deepEqual(c0.cats, ['conflicts', 'late'], 'conflicts precedes late in the category order');
  assert.equal(c0.rowKey, 'M1');
  assert.equal(c0.colKey, D0);
  const c1 = m1.cells.find(c => c.colKey === D1);
  assert.equal(c1.worst, 'warn');
  const empty = m1.cells.find(c => c.colKey === 'later');
  assert.deepEqual([empty.count, empty.worst, empty.cats], [0, null, []]);
  const many = ['overload', 'overlap', 'blackout', 'setup-uncovered', 'needs_planning', 'late', 'run_time_zero']
    .map(type => al('M1', 'warn', type, at(0)));
  const cell = matrixModel(many, 'machine', ctx()).groups[0].rows[0].cells.find(c => c.colKey === D0);
  assert.equal(cell.cats.length, MAX_CELL_DOTS);
  assert.deepEqual(cell.cats, ['capacity', 'conflicts', 'calendar', 'setup']);
});

test('row headers carry total, worst and barPct relative to the largest row', () => {
  const m = matrixModel(alerts(), 'machine', ctx());
  const rows = m.groups.flatMap(g => g.rows);
  const m1 = rows.find(r => r.head.key === 'M1').head;
  assert.deepEqual([m1.total, m1.worst, m1.barPct, m1.sub, m1.label], [3, 'err', 100, 'Press 1', 'M1']);
  assert.equal(rows.find(r => r.head.key === 'M2').head.barPct, 33);
  assert.equal(rows.find(r => r.head.key === 'M2').head.sub, '', 'a name equal to the id is not repeated');
  const g = m.groups.find(x => x.key === 'A');
  assert.equal(g.head.key, GROUP_ROW_PREFIX + 'A');
  assert.equal(g.head.sub, '3 machines');
});

test('day lens: rows are the day buckets, columns the work-center groups (Ungrouped last)', () => {
  const m = matrixModel(alerts(), 'day', ctx());
  assert.deepEqual(m.rows.map(r => r.head.key), ['overdue', D0, D1, D2, 'later', 'none']);
  assert.deepEqual(m.columns.map(c => c.key), ['A', 'B', UNGROUPED_KEY]);
  assert.equal(m.columns[2].label, 'Ungrouped');
  const d0 = m.rows.find(r => r.head.key === D0);
  assert.equal(d0.cells.find(c => c.colKey === 'A').count, 2);
  assert.equal(m.rows.find(r => r.head.key === 'overdue').cells.find(c => c.colKey === 'B').worst, 'err');
  assert.equal(m.rows.find(r => r.head.key === 'none').head.total, 1);
});

test('group lens: rows are the categories in the given order, columns the day buckets', () => {
  const full = matrixModel(alerts(), 'group', ctx());
  assert.deepEqual(full.rows.map(r => r.head.key), ['capacity', 'conflicts', 'calendar', 'setup', 'planning', 'late', 'exceptions']);
  assert.deepEqual(full.columns.map(c => c.key), ['overdue', D0, D1, D2, 'later', 'none']);
  const on = matrixModel(alerts(), 'group', ctx({ categoryOrder: ['late', 'conflicts'] }));
  assert.deepEqual(on.rows.map(r => r.head.key), ['late', 'conflicts'], 'only the ON categories under a custom profile');
  assert.equal(on.rows[0].head.label, 'cat:late');
  assert.equal(on.rows[0].head.total, 4);
});

test('the matrix buckets agree with makeBucketer on every day (same rule, same horizon)', () => {
  const a = alerts();
  const m = matrixModel(a, 'machine', ctx());
  const colTotal = key => m.groups.reduce((s, g) => s + g.cells.find(c => c.colKey === key).count, 0);
  const bucket = makeBucketer(ctx());
  const count = {};
  for (const x of a) count[bucket(x)] = (count[bucket(x)] ?? 0) + 1;
  assert.equal(colTotal(OVERDUE_KEY), 1);
  assert.equal(colTotal(LATER_KEY), 1);
  assert.equal(colTotal(NONE_KEY), 1);
  for (const key of [OVERDUE_KEY, ...horizonDayKeys(today, 3), LATER_KEY, NONE_KEY]) assert.equal(colTotal(key), count[key] ?? 0, key);
});

test('cellFilter / rowFilter / colFilter per lens', () => {
  assert.deepEqual(cellFilter('machine', 'M1', D0), { machines: new Set(['M1']), days: new Set([D0]) });
  assert.deepEqual(rowFilter('machine', GROUP_ROW_PREFIX + 'A'), { wcGroups: new Set(['A']) });
  assert.deepEqual(cellFilter('machine', GROUP_ROW_PREFIX + 'A', 'later'), { wcGroups: new Set(['A']), days: new Set(['later']) });
  assert.deepEqual(cellFilter('day', D1, 'B'), { days: new Set([D1]), wcGroups: new Set(['B']) });
  assert.deepEqual(colFilter('day', 'B'), { wcGroups: new Set(['B']) });
  assert.deepEqual(rowFilter('group', 'late'), { categories: new Set(['late']) });
  assert.deepEqual(cellFilter('group', 'late', 'overdue'), { categories: new Set(['late']), days: new Set(['overdue']) });
  assert.deepEqual(colFilter('group', D2), { days: new Set([D2]) });
});

test('filterMatches is exact per dimension', () => {
  const f = emptyFilter();
  f.machines.add('M1'); f.days.add(D0);
  assert.equal(filterMatches(f, cellFilter('machine', 'M1', D0)), true);
  assert.equal(filterMatches(f, cellFilter('machine', 'M1', D1)), false);
  f.days.add(D1);
  assert.equal(filterMatches(f, cellFilter('machine', 'M1', D0)), false, 'a wider set is not the single cell');
  assert.equal(filterMatches(emptyFilter(), rowFilter('machine', 'M1')), false);
});

test('matrixHtml: sticky header and first column, rollups with caret, inert empty cells, quiet fold, legend', () => {
  const m = matrixModel(alerts(), 'machine', ctx());
  const html = matrixHtml(m, emptyFilter(), t);
  assert.match(html, /class="am-mx-head am-mx-rh">am\.mx_corner_machine</);
  assert.match(html, /<th class="am-mx-head"><button[^>]*data-am-col="overdue"/);
  assert.match(html, /<th scope="row" class="am-mx-rh">/);
  assert.match(html, /<tr class="am-mx-ghead">/);
  assert.match(html, /<tr class="am-mx-ghead"><th scope="row" class="am-mx-rh am-mx-ghead-rh"><div class="am-mx-rhc am-mx-rhc2"><div class="am-mx-rhl1"><button[^>]*class="am-mx-caret"/);
  assert.match(html, /<div class="am-mx-rhl2"><span class="am-mx-sub">\d+ machines/);
  const mrow = html.slice(html.indexOf('data-am-row="M1"') - 200, html.indexOf('data-am-row="M1"') + 200);
  assert.doesNotMatch(mrow, /am-mx-rhl1/, 'a machine row keeps the single-line head');
  assert.match(html, /data-am-group="A" aria-expanded="true"/);
  assert.match(html, /data-am-cell="M1\|2026-10-30"[^>]*aria-label="am\.mx_cell_aria\|row=M1,col=d:2026-10-30,n=2"/);
  assert.match(html, /<div class="am-mx-cell am-mx-zero" aria-hidden="true">·<\/div>/);
  assert.match(html, /am-mx-cell am-mx-err/);
  assert.match(html, /am-mx-cell am-mx-warn/);
  assert.match(html, /data-am-quiet="A"[^>]*>am\.quiet_show_one\|n=1</);
  assert.doesNotMatch(html, /data-am-quiet-row/, 'quiet rows stay folded until opened');
  assert.match(html, /am\.mx_legend_err/);
  assert.match(html, /am\.mx_legend_hint/);
  assert.match(html, /style="--c:var\(--bar-pm-late\)"/);
});

test('matrixHtml: the open quiet fold lists the quiet machines and offers Hide; a collapsed group lists no machines', () => {
  const open = matrixHtml(matrixModel(alerts(), 'machine', ctx({ quietOpen: new Set(['A']), collapsed: new Set(['B']) })), emptyFilter(), t);
  assert.match(open, /data-am-quiet-row="1"/);
  assert.match(open, /am\.quiet_hide_one\|n=1/);
  assert.match(open, /data-am-group="B" aria-expanded="false"/);
  assert.doesNotMatch(open, /data-am-row="M4"/, 'collapsed group hides its machine rows');
});

test('matrixHtml: aria-pressed follows the current filter on the cell, the row header and the column header', () => {
  const m = matrixModel(alerts(), 'machine', ctx());
  const f = emptyFilter();
  f.machines.add('M1'); f.days.add(D0);
  const html = matrixHtml(m, f, t);
  assert.match(html, /data-am-cell="M1\|2026-10-30"[^>]*aria-pressed="true"/);
  assert.match(html, /data-am-cell="M1\|2026-10-31"[^>]*aria-pressed="false"/);
  assert.match(html, /class="am-mx-rowh" data-am-row="M1" aria-pressed="true"/);
  assert.match(html, /data-am-col="2026-10-30" aria-pressed="true"/);
  assert.match(html, /data-am-col="2026-10-31" aria-pressed="false"/);
  assert.match(matrixHtml(m, emptyFilter(), t), /aria-pressed="false"/);
  assert.doesNotMatch(matrixHtml(m, emptyFilter(), t), /aria-pressed="true"/);
});

test('matrixHtml: day and group lenses render rows without roll-ups; every dynamic string is escaped', () => {
  const day = matrixHtml(matrixModel(alerts(), 'day', ctx()), emptyFilter(), t);
  assert.doesNotMatch(day, /am-mx-ghead/);
  assert.match(day, /data-am-lens="day"/);
  assert.match(day, /am\.mx_corner_day/);
  const evil = { ...labels, category: () => '<img src=x onerror=1>' };
  const html = matrixHtml(matrixModel(alerts(), 'group', ctx({ labels: evil })), emptyFilter(), t);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=1&gt;/);
});

test('machine lens: a machine id shaped like a group row key files under no-machine', () => {
  const m = matrixModel([al('wc:A', 'warn', 'late', at(0)), al('M1', 'warn', 'late', at(0))], 'machine', ctx());
  const rowKeys = m.groups.flatMap(g => [...g.rows, ...g.quiet]).map(r => r.head.key);
  assert.ok(!rowKeys.some(k => k.startsWith(GROUP_ROW_PREFIX)), 'no machine row carries the group prefix');
  assert.ok(rowKeys.includes('none'), 'the stray id lands on the no-machine row');
  assert.equal(m.total, 2);
});

test('empty input still builds a model and HTML', () => {
  const m = matrixModel([], 'machine', ctx());
  assert.equal(m.total, 0);
  assert.ok(m.groups.every(g => g.rows.length === 0 && g.quiet.length === g.machineCount));
  assert.ok(matrixHtml(m, emptyFilter(), t).includes('am-mx-table'));
});

test('machine rows and groups sort by natural name order (L1, L2, L10), case-insensitively, and the day lens does too', () => {
  const ms = ['L10', 'L2', 'L1', 'l3'].map(id => ({ id, wc_group: 'G10' })).concat(['G2', 'G1'].map(g => ({ id: 'X' + g, wc_group: g })));
  const c = ctx({ machines: ms });
  const m = matrixModel([], 'machine', c);
  assert.deepEqual(m.groups.map(g => g.key), ['G1', 'G2', 'G10'], 'groups with nothing to say sort by natural name');
  assert.deepEqual(m.groups.find(g => g.key === 'G10').quiet.map(r => r.head.key), ['L1', 'L2', 'l3', 'L10']);
  const noisy = ['L10', 'L2', 'L1'].map(l => al(l, 'warn', 'late', at(0)));
  assert.deepEqual(matrixModel(noisy, 'machine', c).groups.find(g => g.key === 'G10').rows.map(r => r.head.key), ['L1', 'L2', 'L10'], 'equal severity and count: natural name order');
  assert.deepEqual(matrixModel([], 'day', c).columns.map(col => col.key), ['G1', 'G2', 'G10']);
});
