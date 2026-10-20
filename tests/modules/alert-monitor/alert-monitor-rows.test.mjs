// Tests for the pure row / group-head / diagnose builders in frontend/alert-monitor/alert-monitor-model.mts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rowActionsFor, rowHtml, groupHeadHtml, groupTotals, groupLabel, colsHtml, diagnoseHtml,
  relativeDaysText, formatPairKey, fmtNum, GROUP_ROW_CAP,
} from '../../../frontend/alert-monitor/alert-monitor-model.mjs';

const t = (k, v) => `${k}${v ? '|' + Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',') : ''}`;

const view = (o = {}) => ({
  id: 'a1', type: 'overlap', sev: 'err', taskId: '10', line: 'L1', time: new Date('2026-10-21T08:00:00'),
  headline: 'Order overlap', message: 'two orders overlap', help: 'help text', orderNo: '4711', dateText: '2026-10-21 08:00',
  relText: 'in 1 days', anchorTip: 'am.anchor_time', points: 7.5, orders: 2, lateH: 3.25, whatIf: false, ackLabel: null,
  diagOpen: false, diagHtml: '', ...o,
});

test('row builder escapes every dynamic string', () => {
  const html = rowHtml(view({
    id: 'x"><img src=x onerror=alert(1)>', headline: '<img onerror=alert(1)>', message: '<script>x</script>',
    orderNo: '<b>1</b>', line: '"><i>', taskId: '1"><u>', type: 'closed', help: '<svg onload=1>',
  }), t);
  assert.doesNotMatch(html, /<img|<script|<svg|<b>|<u>|<i>/);
  assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
});

test('Fix only appears on fixable types; Override only on the closed family with a taskId', () => {
  for (const type of ['overlap', 'blackout', 'overload', 'tool-conflict']) {
    assert.equal(rowActionsFor({ type, taskId: '1' }).fix, true, type);
    assert.match(rowHtml(view({ type }), t), /data-alert-action="fix"/);
  }
  for (const type of ['closed', 'late', 'setup-violated', 'firmed-closed']) {
    assert.equal(rowActionsFor({ type, taskId: '1' }).fix, type === 'blackout', type);
  }
  assert.doesNotMatch(rowHtml(view({ type: 'late' }), t), /data-alert-action="fix"/);
  for (const type of ['closed', 'firmed-closed', 'firmed-out-of-hours']) {
    assert.match(rowHtml(view({ type }), t), /data-alert-action="override"[^>]*data-task-id="10"/);
    assert.equal(rowActionsFor({ type }).override, false, 'no taskId, no override');
  }
  assert.doesNotMatch(rowHtml(view({ type: 'overlap' }), t), /data-alert-action="override"/);
  assert.doesNotMatch(rowHtml(view({ type: 'closed', taskId: undefined }), t), /data-alert-action="override"/);
});

test('Dismiss is an icon button, Acknowledge renders disabled, Go To and Diagnose are present', () => {
  const html = rowHtml(view(), t);
  assert.match(html, /<button[^>]*class="icon-btn sm"[^>]*data-alert-action="dismiss"/);
  assert.match(html, /<button[^>]*data-alert-action="ack"[^>]*disabled/);
  assert.match(html, /data-alert-action="focus"/);
  assert.match(html, /data-alert-action="diagnose"[^>]*aria-expanded="false"/);
});

test('diagnose: order alerts expand inline, line/day alerts open the cell briefing', () => {
  assert.equal(rowActionsFor({ type: 'overload', line: 'L1', time: new Date() }).diagnose, 'cell');
  assert.equal(rowActionsFor({ type: 'late', taskId: '1', line: 'L1', time: new Date() }).diagnose, 'order');
  const open = rowHtml(view({ type: 'late', diagOpen: true, diagHtml: diagnoseHtml([{ label: 'Due', value: '2026-10-20' }]) }), t);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /class="am-diag"/);
  assert.match(open, /<dt>Due<\/dt><dd title="2026-10-20">2026-10-20<\/dd>/);
  const cell = rowHtml(view({ type: 'overload', taskId: undefined, diagOpen: true, diagHtml: 'X' }), t);
  assert.doesNotMatch(cell, /class="am-diag"/, 'a cell diagnose never expands inline');
  assert.doesNotMatch(cell, /aria-expanded/);
});

test('impact columns: 0 points reads "outside", otherwise points / orders / late hours', () => {
  const inside = rowHtml(view(), t);
  assert.match(inside, /<span class="am-num">7\.5<\/span><span class="am-num">2<\/span><span class="am-num">3\.3<\/span>|<span class="am-num">7\.5<\/span><span class="am-num">2<\/span><span class="am-num">3\.2<\/span>/);
  const out = rowHtml(view({ points: 0, lateH: 0 }), t);
  assert.match(out, /am-num-out[^>]*title="am\.points_outside_tip">am\.points_outside</);
  assert.match(out, /<span class="am-num">—<\/span>/);
});

test('What-If disables Fix and Override with the explanatory title', () => {
  const fix = rowHtml(view({ whatIf: true }), t);
  assert.match(fix, /<button[^>]*data-alert-action="fix"[^>]*disabled[^>]*am\.whatif_blocked/);
  const ov = rowHtml(view({ type: 'closed', whatIf: true }), t);
  assert.match(ov, /<button[^>]*data-alert-action="override"[^>]*disabled[^>]*am\.whatif_blocked/);
  assert.match(ov, /data-alert-action="focus"/, 'Go To stays live');
});

test('calendar-family rows use the circled-slash glyph, others the severity glyph; acked rows carry the badge', () => {
  assert.match(rowHtml(view({ type: 'closed' }), t), /am-sev am-sev-err" aria-hidden="true">⊘/);
  assert.match(rowHtml(view({ type: 'overlap', sev: 'warn' }), t), /am-sev-warn" aria-hidden="true">⚠/);
  assert.match(rowHtml(view({ ackLabel: 'Acknowledged by Ana' }), t), /am-ack-badge[^>]*>Acknowledged by Ana</);
  assert.doesNotMatch(rowHtml(view(), t), /am-ack-badge/);
});

test('group totals: orders are distinct taskId ∪ peerId, late hours once per order', () => {
  const alerts = [
    { id: 'a', sev: 'err', type: 'overlap', taskId: '1', peerId: '2' },
    { id: 'b', sev: 'warn', type: 'overlap', taskId: '2', peerId: '3' },
    { id: 'c', sev: 'warn', type: 'late', taskId: '1' },
    { id: 'd', sev: 'warn', type: 'overload' },
  ];
  const late = { 1: 4, 2: 1.5, 3: 0 };
  const tot = groupTotals(alerts, a => (a.sev === 'err' ? 5 : 2), id => late[id] ?? 0);
  assert.deepEqual(tot, { count: 4, errors: 1, warnings: 3, points: 11, orders: 3, lateH: 5.5 });
});

test('group head: toggle carries aria-expanded, counts, totals and the three actions', () => {
  const totals = { count: 7, errors: 2, warnings: 5, points: 12.5, orders: 4, lateH: 0 };
  const html = groupHeadHtml({ key: 'capacity', label: 'Capacity', expanded: true, totals, firstAlertId: 'a1', firstGoto: true }, t);
  assert.match(html, /<button[^>]*aria-expanded="true"[^>]*data-am-action="toggle-group"[^>]*data-group-key="capacity"/);
  assert.match(html, /badge badge-err">2<[\s\S]*badge badge-warn">5</);
  assert.match(html, /am-tot-v">12\.5<[\s\S]*am-tot-v">4<[\s\S]*am-tot-v">—</);
  assert.match(html, /data-alert-action="focus" data-alert-id="a1"/);
  assert.match(html, /group-dismiss[^>]*>am\.group_dismiss_n\|n=7</);
  assert.match(html, /group-open-table[^>]*>am\.open_in_table\|n=4</);
  const collapsed = groupHeadHtml({ key: 'k<', label: '<b>x', expanded: false, totals: { ...totals, orders: 0 }, firstAlertId: null, firstGoto: false }, t);
  assert.match(collapsed, /aria-expanded="false"/);
  assert.doesNotMatch(collapsed, /<b>|group-open-table|data-alert-action="focus"/);
});

test('group labels per mode and the helpers behind the rows', () => {
  const d = { headlineFor: x => `H:${x}`, orderLabel: id => (id === '9' ? '4711 · Mat' : ''), dayOffset: () => 9, fmtDay: k => `D(${k})` };
  assert.equal(groupLabel('category', 'setup', d, t), 'ape.cat_setup');
  assert.equal(groupLabel('type', 'overlap', d, t), 'H:overlap');
  assert.equal(groupLabel('line', 'none', d, t), 'am.group_unassigned');
  assert.equal(groupLabel('order', '9', d, t), '4711 · Mat');
  assert.equal(groupLabel('day', '2026-10-23', d, t), 'D(2026-10-23) · am.rel_in_days|n=9');
  assert.equal(relativeDaysText(0, t), 'am.rel_today');
  assert.equal(relativeDaysText(-3, t), 'am.rel_overdue_days|n=3');
  assert.equal(formatPairKey('[["colorWheel","RED"]]->[["colorWheel","BLUE"]]'), 'colorWheel RED → colorWheel BLUE');
  assert.equal(formatPairKey('unknown->[["f","x"]]'), '? → f x');
  assert.equal(formatPairKey(null), '');
  assert.equal(fmtNum(7), '7');
  assert.equal(fmtNum(7.46), '7.5');
  assert.equal(GROUP_ROW_CAP, 40);
  assert.match(colsHtml(t), /am\.col_points[\s\S]*am\.col_orders[\s\S]*am\.col_late/);
});
