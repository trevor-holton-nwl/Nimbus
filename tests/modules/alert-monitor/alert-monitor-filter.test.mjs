// W6a tests for the pure Monitor model additions in alert-monitor-model.mts: view + lens, the shared filter,
// day buckets, the compact row, the short tag, material, Top-fixes scoping and the new summary clauses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  viewFor, DEFAULT_VIEW, emptyFilter, filterIsEmpty, filterChips, buildWcByLine, GROUP_ROW_PREFIX, UNGROUPED_KEY, makeBucketer, filterAlerts,
  materialOf, tagOf, rowHtml, rowDetailHtml, fixesInView, summaryLine,
} from '../../../frontend/alert-monitor/alert-monitor-model.mjs';
import { horizonDayKeys, OVERDUE_KEY, LATER_KEY, NONE_KEY } from '../../../frontend/alert-monitor/alert-monitor-overview.mjs';

const t = (k, v) => `${k}${v ? '|' + Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',') : ''}`;
const today = new Date(2026, 9, 30);
const at = (d, h = 9) => new Date(2026, 9, 30 + d, h);
let n = 0;
const al = (line, type, when, o = {}) => ({ id: `a${++n}`, sev: 'warn', type, line, time: when, ...o });
const machines = [{ id: 'M1', wc_group: 'A' }, { id: 'M2', wc_group: 'A' }, { id: 'M3', wc_group: 'B' }, { id: 'M4' }];
const tasks = { T1: { MATERIAL_DESCRIPTION: 'Widget blue 12oz', MATERIAL_NUMBER: '100' }, T2: { MATERIAL_NUMBER: '200' } };
const base = () => ({ plantToday: today, horizonDays: 7, machines });
const set = (...v) => new Set(v);
const mk = o => ({ ...emptyFilter(), ...o });

// ---- view + lens ---------------------------------------------------------------------------

test("viewFor: defaults to Matrix + Machine; '*' wins over a stored per-profile choice", () => {
  assert.deepEqual(viewFor(null, 'p1'), DEFAULT_VIEW);
  assert.deepEqual(DEFAULT_VIEW, { view: 'matrix', lens: 'machine' });
  assert.deepEqual(viewFor({ '*': { view: 'inbox', lens: 'day' }, p1: { groupBy: 'type' } }, 'p1'), { view: 'inbox', lens: 'day' });
  assert.deepEqual(viewFor({ '*': { view: 'inbox' }, p1: { groupBy: 'day' } }, 'p1'), { view: 'inbox', lens: 'day' }, 'a lens missing from * migrates from the profile');
  assert.deepEqual(viewFor({ '*': { view: 'bogus', lens: 7 } }, 'p1'), DEFAULT_VIEW, 'junk is ignored');
});

test('viewFor: a stored groupBy migrates (type/category -> group, day -> day, else machine)', () => {
  const lens = g => viewFor({ p1: { groupBy: g } }, 'p1').lens;
  assert.equal(lens('type'), 'group');
  assert.equal(lens('category'), 'group');
  assert.equal(lens('day'), 'day');
  assert.equal(lens('line'), 'machine');
  assert.equal(lens('order'), 'machine');
  assert.equal(lens('none'), 'machine');
  assert.equal(viewFor({ p2: { groupBy: 'day' } }, 'p1').lens, 'machine', 'another profile does not leak');
});

// ---- filter state --------------------------------------------------------------------------

test('emptyFilter / filterIsEmpty / filterChips', () => {
  const f = emptyFilter();
  assert.equal(filterIsEmpty(f), true);
  assert.equal(filterIsEmpty(mk({ q: '  ' })), true, 'a blank search is empty');
  assert.equal(filterIsEmpty(mk({ q: 'x' })), false);
  assert.deepEqual(filterChips(f), []);
  const chips = filterChips(mk({ machines: set('M1'), wcGroups: set('A'), days: set('overdue'), categories: set('late'), q: 'blue' }),
    { wc: k => `wc ${k}`, day: k => `day ${k}` });
  assert.deepEqual(chips.map(c => [c.dim, c.key, c.label]), [
    ['wcGroups', 'A', 'wc A'], ['machines', 'M1', 'M1'], ['days', 'overdue', 'day overdue'], ['categories', 'late', 'late'], ['q', 'blue', 'blue'],
  ]);
});

test('buildWcByLine: line id to wc_group; a blank group is the Ungrouped bucket, a missing line is absent', () => {
  const m = buildWcByLine(machines);
  assert.equal(m.get('M1'), 'A');
  assert.equal(m.get('M4'), UNGROUPED_KEY);
  assert.equal(m.has('ZZ'), false, 'the caller reads an absent line as Ungrouped');
  assert.equal(buildWcByLine([{ machine: 'M3', wc_group: 'Z' }]).get('M3'), 'Z', 'master lines name the id `machine`');
  assert.equal(buildWcByLine([{ wc_group: 'Z' }]).size, 0, 'an entry with no id is skipped');
  assert.equal(GROUP_ROW_PREFIX, 'wc:');
});

test('makeBucketer: overdue, a day key, later, none; the resolver (order due) beats the alert time', () => {
  const b = makeBucketer({ plantToday: today, horizonDays: 7 });
  assert.equal(b(al('M1', 'late', at(-1))), OVERDUE_KEY);
  assert.equal(b(al('M1', 'late', at(0, 0))), '2026-10-30');
  assert.equal(b(al('M1', 'late', at(6, 23))), '2026-11-05');
  assert.equal(b(al('M1', 'late', at(7))), LATER_KEY);
  assert.equal(b(al('M1', 'late', null)), NONE_KEY);
  assert.equal(makeBucketer({ plantToday: today, horizonDays: 7, anchorOf: () => at(-3) })(al('M1', 'late', at(2))), OVERDUE_KEY);
  const list = [-5, -1, 0, 1, 3, 6, 7, 20].map(d => al('M1', 'late', at(d)));
  list.push(al('M1', 'late', null));
  const count = {};
  for (const a of list) count[b(a)] = (count[b(a)] ?? 0) + 1;
  assert.deepEqual(count, { overdue: 2, '2026-10-30': 1, '2026-10-31': 1, '2026-11-02': 1, '2026-11-05': 1, later: 2, none: 1 });
  assert.deepEqual(horizonDayKeys(today, 7), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
});

test('filterAlerts: every dimension, AND across dimensions, empty returns the same array', () => {
  const a = [
    al('M1', 'late', at(0), { taskId: 'T1' }), al('M2', 'overlap', at(1), { taskId: 'T2' }), al('M3', 'late', at(-2)),
    al('M4', 'overload', at(0)), al(undefined, 'plant_no_timezone', at(0)), al('M1', 'late', null),
  ];
  const ctx = base();
  assert.equal(filterAlerts(a, emptyFilter(), ctx), a);
  assert.deepEqual(filterAlerts(a, mk({ machines: set('M1') }), ctx), [a[0], a[5]]);
  assert.deepEqual(filterAlerts(a, mk({ machines: set('none') }), ctx), [a[4]], 'a line-less alert is the "none" machine');
  assert.deepEqual(filterAlerts(a, mk({ wcGroups: set('A') }), ctx), [a[0], a[1], a[5]]);
  assert.deepEqual(filterAlerts(a, mk({ wcGroups: set(UNGROUPED_KEY) }), ctx), [a[3], a[4]], 'unlisted line and no line');
  assert.deepEqual(filterAlerts(a, mk({ categories: set('late') }), ctx), [a[0], a[2], a[5]]);
  assert.deepEqual(filterAlerts(a, mk({ days: set('overdue') }), ctx), [a[2]]);
  assert.deepEqual(filterAlerts(a, mk({ days: set('2026-10-30') }), ctx), [a[0], a[3], a[4]]);
  assert.deepEqual(filterAlerts(a, mk({ days: set('none') }), ctx), [a[5]]);
  assert.deepEqual(filterAlerts(a, mk({ days: set('overdue', 'none') }), ctx), [a[2], a[5]], 'values inside a dimension are OR');
  assert.deepEqual(filterAlerts(a, mk({ wcGroups: set('A'), categories: set('late'), days: set('2026-10-30') }), ctx), [a[0]]);
});

test('filterAlerts: search is case-insensitive over order id, machine, material and tag', () => {
  const a = [
    al('M1', 'late', at(0), { taskId: 'T1', msgVars: { order: '4711', hours: 3 } }),
    al('M2', 'overlap', at(0), { taskId: 'T2', msgVars: { order: '5802' } }),
  ];
  const ctx = {
    ...base(), materialOf: x => materialOf(x, tasks), tagOf: x => ({ late: 'Late 3 h', overlap: 'Overlap' })[x.type],
    orderNoOf: x => String(x.msgVars?.order ?? ''),
  };
  const q = s => filterAlerts(a, mk({ q: s }), ctx).map(x => x.line);
  assert.deepEqual(q('4711'), ['M1']);
  assert.deepEqual(q('m2'), ['M2']);
  assert.deepEqual(q('WIDGET'), ['M1']);
  assert.deepEqual(q('overlap'), ['M2']);
  assert.deepEqual(q('late 3'), ['M1']);
  assert.deepEqual(q('200'), ['M2'], 'the material number is the fallback text');
  assert.deepEqual(q('nothing'), []);
  assert.deepEqual(q('  '), ['M1', 'M2'], 'a blank search filters nothing');
});

// ---- material, tag -------------------------------------------------------------------------

test('materialOf: description, else number, else machine · day', () => {
  assert.equal(materialOf({ taskId: 'T1', line: 'M1' }, tasks), 'Widget blue 12oz');
  assert.equal(materialOf({ taskId: 'T2', line: 'M1' }, tasks), '200');
  assert.equal(materialOf({ line: 'M1', time: at(1) }, tasks), 'M1 · 2026-10-31');
  assert.equal(materialOf({ line: 'M1', time: at(1) }, tasks, () => 'Sat 31'), 'M1 · Sat 31');
  assert.equal(materialOf({ taskId: 'GONE', line: 'M2', time: null }, tasks), 'M2');
});

test('tagOf: alert.tag.<type> with the alert msgVars', () => {
  assert.equal(tagOf({ type: 'late', msgVars: { hours: '3.5' } }, t), 'alert.tag.late|hours=3.5');
  assert.equal(tagOf({ type: 'overlap' }, t), 'alert.tag.overlap');
});

// ---- compact row ---------------------------------------------------------------------------

const row = (a, o = {}) => rowHtml(a, { hideMachine: false, open: false, material: 'Widget', tag: 'Late 3 h', t, ...o });

test('rowHtml: severity glyph, group color dot, order, material, machine, tag, due, actions', () => {
  const html = row(al('M1', 'late', at(0), { id: 'x1', sev: 'err', taskId: 'T1' }), { orderNo: '4711', groupLabel: 'Late', dueText: 'Fri 30', overdue: true });
  assert.match(html, /class="am-xrow am-xrow-err" tabindex="0"/);
  assert.match(html, /class="am-sev am-sev-err" aria-hidden="true">✖/);
  assert.match(html, /<span class="am-gdot" style="--c:var\(--bar-pm-late\)" title="Late">/);
  assert.match(html, /<span class="am-oid">4711<\/span>/);
  assert.match(html, /<span class="am-mat" title="Widget">Widget<\/span>/);
  assert.match(html, /<span class="am-mc">M1<\/span>/);
  assert.match(html, /<span class="am-tag" title="Late 3 h">Late 3 h<\/span>/);
  assert.doesNotMatch(html, /<b>Late/, 'the tag no longer repeats the category name');
  assert.match(html, /<span class="am-due am-when-overdue">Fri 30<\/span>/);
  assert.match(row(al('M1', 'late', at(0), { sev: 'warn' })), /am-sev am-sev-warn" aria-hidden="true">⚠/);
  assert.doesNotMatch(row(al('M1', 'late', at(0))), /am-when-overdue/);
});

test('rowHtml: the machine column is omitted when hidden; the order falls back to msgVars then taskId', () => {
  const a = al('M1', 'late', at(0), { taskId: 'T1', msgVars: { order: '4711' } });
  const hidden = row(a, { hideMachine: true });
  assert.doesNotMatch(hidden, /am-mc/);
  assert.match(hidden, /am-xrow-nomc/);
  assert.match(row(a), /<span class="am-oid">4711<\/span>/);
  assert.match(row(al('M1', 'late', at(0), { taskId: 'T1' })), /<span class="am-oid">T1<\/span>/);
});

test('rowHtml: one action per type set (Fix / Override / Move / Diagnose), always Go to and the menu', () => {
  const act = a => (row(a).match(/data-alert-action="(\w+)"/g) ?? []).map(s => s.slice(19, -1));
  assert.deepEqual(act(al('M1', 'overlap', at(0), { taskId: 'T1' })), ['focus', 'fix']);
  assert.deepEqual(act(al('M1', 'overload', at(0))), ['focus', 'fix']);
  assert.deepEqual(act(al('M1', 'closed', at(0), { taskId: 'T1' })), ['focus', 'override']);
  assert.deepEqual(act(al('M1', 'needs_planning', at(0), { taskId: 'T1' })), ['focus', 'slot']);
  assert.deepEqual(act(al('M1', 'late', at(0), { taskId: 'T1' })), ['focus', 'diagnose']);
  assert.deepEqual(act(al('M1', 'tool-conflict', at(0), { taskId: 'T1', available: 0 })), ['focus', 'diagnose'], 'an unfixable tool conflict falls back to Diagnose');
  assert.deepEqual(act(al('M1', 'closed', at(0))), ['focus', 'diagnose'], 'no order, no Override');
  assert.deepEqual(act(al(undefined, 'plant_no_timezone', null)), [], 'nothing to go to or diagnose');
  assert.match(row(al('M1', 'needs_planning', at(0), { taskId: 'T1' })), /data-alert-action="slot"[^>]*data-task-id="T1">am\.slot</);
  assert.match(row(al('M1', 'late', at(0))), /class="icon-btn sm am-row-menu"/);
});

test('rowHtml: What-If disables Fix; open appends the detail; every dynamic string is escaped', () => {
  assert.match(row(al('M1', 'overlap', at(0), { taskId: 'T1' }), { whatIf: true }), /data-alert-action="fix"[^>]*disabled aria-disabled="true"/);
  const a = al('M1', 'late', at(0), { id: 'x"><i>', taskId: 'T1' });
  const detail = rowDetailHtml(a, { message: '<b>full</b>', material: 'Widget', due: 'Fri', plannedFinish: 'Sat', firming: 'Not firmed', t });
  const html = row(a, { open: true, detailHtml: detail, material: '<img src=x>', tag: '<s>', orderNo: '<u>', groupLabel: '<q>' });
  assert.doesNotMatch(html, /<img|<s>|<u>|<q>|<i>/);
  assert.match(html, /title="&lt;q&gt;"/, 'groupLabel is still escaped into the dot title');
  assert.doesNotMatch(html, /<b>full/, 'the message is text, not markup');
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /class="am-xdetail"/);
  assert.match(detail, /am\.detail_alert<\/b>&lt;b&gt;full&lt;\/b&gt;/);
  for (const k of ['material', 'due', 'finish', 'firming']) assert.match(detail, new RegExp(`am\\.detail_${k}`));
  assert.doesNotMatch(row(a), /am-xdetail/);
});

// ---- Top fixes -----------------------------------------------------------------------------

test('fixesInView keeps an item when any alert is in view, preserves rank order and counts the alerts in view', () => {
  const items = [{ key: 'a', alertIds: ['1', '2'] }, { key: 'b', alertIds: ['3'] }, { key: 'c', alertIds: ['2', '3', '4'] }];
  const out = fixesInView(items, new Set(['2', '4']));
  assert.deepEqual(out.map(x => [x.item.key, x.inView]), [['a', 1], ['c', 2]]);
  assert.equal(out[0].item, items[0]);
  assert.deepEqual(fixesInView(items, new Set()), []);
  assert.deepEqual(fixesInView([], new Set(['1'])), []);
});

// ---- summary line --------------------------------------------------------------------------

const sumIn = o => ({
  hasPlant: true, alerts: [al('M1', 'overlap', at(0), { sev: 'err', taskId: 'T1' })], profileId: '__all__', profileName: 'All', profile: null, ...o,
});

test("filterAlerts: a 'none' machine click keeps the alerts the matrix files under no-machine (wc:-prefixed line included)", () => {
  const ctx = { ...base(), tagOf: a => a.type };
  const a1 = al('', 'late', at(0));
  const a2 = al('wc:Z', 'late', at(0));
  const a3 = al('M1', 'late', at(0));
  assert.deepEqual(filterAlerts([a1, a2, a3], mk({ machines: set('none') }), ctx).map(a => a.id), [a1.id, a2.id]);
});

test('summaryLine: lead, errors and warnings only; no orders, machines or "showing" clause, no confidence link', () => {
  const s = summaryLine(sumIn(), t);
  assert.equal(s.text, 'am.summary_all_one|n=1 · am.summary_errors_one|e=1');
  assert.doesNotMatch(s.text, /orders|machines|showing/);
});

test('filterAlerts: the search text is built once per alert per ctx, however many passes share the ctx', () => {
  let tagCalls = 0, matCalls = 0;
  const ctx = { ...base(), tagOf: a => { tagCalls++; return a.type; }, materialOf: () => { matCalls++; return 'Widget'; } };
  const alerts = [al('M1', 'late', at(0)), al('M2', 'overlap', at(0)), al('M3', 'late', at(1))];
  const q = mk({ q: 'late' });
  assert.deepEqual(filterAlerts(alerts, q, ctx).map(a => a.id), [alerts[0].id, alerts[2].id]);
  assert.deepEqual(filterAlerts(alerts, mk({ q: 'WIDGET' }), ctx).length, 3, 'a second query reuses the cached text and still matches case-insensitively');
  assert.deepEqual(filterAlerts(alerts.slice(0, 2), q, ctx).map(a => a.id), [alerts[0].id]);
  assert.equal(tagCalls, alerts.length, 'tagOf ran once per alert');
  assert.equal(matCalls, alerts.length, 'materialOf ran once per alert');
  // A fresh ctx (the pane's next paint) rebuilds, so a changed source is seen.
  const fresh = { ...ctx, tagOf: () => 'zzz' };
  assert.deepEqual(filterAlerts(alerts, mk({ q: 'zzz' }), fresh).length, 3);
});
