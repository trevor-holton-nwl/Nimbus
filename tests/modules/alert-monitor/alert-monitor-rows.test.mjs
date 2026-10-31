// Tests for the pure row / group-head / diagnose builders in frontend/alert-monitor/alert-monitor-model.mts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  rowActionsFor, rowPrefix, rowPrimaryActions, groupHeadHtml, groupMenuItems, groupCounts, diagnoseHtml,
  relativeDaysText, ROW_H, MOVABLE_ALERT_TYPES,
} from '../../../frontend/alert-monitor/alert-monitor-model.mjs';

const t = (k, v) => `${k}${v ? '|' + Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',') : ''}`;

const view = (o = {}) => ({
  id: 'a1', type: 'overlap', sev: 'err', taskId: '10', line: 'L1', time: new Date('2026-10-21T08:00:00'),
  headline: 'Order overlap', message: 'Overlaps 4500118 by 2 h', help: 'help text', orderNo: '4711', groupBy: 'category',
  dateText: 'Wed 21 Oct', relText: 'in 1 days', overdue: false, anchorTip: 'am.anchor_time: 10/21/2026 08:00',
  whatIf: false, ackLabel: null, diagOpen: false, diagHtml: '', ...o,
});

const head = (o = {}) => ({
  key: 'capacity', label: 'Capacity', expanded: true, errors: 2, warnings: 5, firstAlertId: 'a1', firstGoto: true,
  orders: 4, movable: 3, unacked: 6, whatIf: false, ...o,
});

test('prefix: the part the active group-by already says is dropped, and the line when the message names it', () => {
  assert.equal(rowPrefix(view({ groupBy: 'line' })), '4711');
  assert.equal(rowPrefix(view({ groupBy: 'order' })), 'L1');
  assert.equal(rowPrefix(view({ groupBy: 'line', orderNo: '' })), '');
  assert.equal(rowPrefix(view({ groupBy: 'type' })), 'L1 · 4711');
  assert.equal(rowPrefix(view({ groupBy: 'day' })), 'L1 · 4711');
  assert.equal(rowPrefix(view({ groupBy: 'none' })), 'L1 · 4711');
  assert.equal(rowPrefix(view({ groupBy: 'category' })), 'L1 · 4711');
  // msgVars.line appears in the message: the line part is dropped, the order stays
  assert.equal(rowPrefix(view({ message: 'L1 is overloaded by 3 h', msgLine: 'L1' })), '4711');
  assert.equal(rowPrefix(view({ message: 'L1 is overloaded by 3 h', msgLine: 'L1', orderNo: '' })), '');
  // a msgVars.line the message does not contain changes nothing
  assert.equal(rowPrefix(view({ message: 'something else', msgLine: 'L1' })), 'L1 · 4711');
});

test('the ⋯ menu: Go to, Fix, Diagnose, Acknowledge for a fixable alert', () => {
  const a = { type: 'overlap', taskId: '10', line: 'L1', time: new Date() };
  const p = rowPrimaryActions(a, { id: '10' }, { whatIf: false, acked: false });
  assert.equal(p.goto, true);
  assert.equal(p.second, 'fix');
  assert.deepEqual(p.menu.map(m => [m.action, m.labelKey, !!m.disabled]), [
    ['focus', 'btn.go_to', false], ['fix', 'btn.fix_it', false], ['diagnose', 'am.diagnose', false], ['ack', 'am.ack', false],
  ]);
});

test('the ⋯ menu: Override for the closed family, Remove acknowledgement when acknowledged, never Dismiss', () => {
  const closed = { type: 'closed', taskId: '10', line: 'L1', time: new Date() };
  const p = rowPrimaryActions(closed, null, { whatIf: false, acked: true });
  assert.equal(p.second, 'override');
  assert.deepEqual(p.menu.map(m => m.action), ['focus', 'override', 'diagnose', 'unack']);
  for (const type of ['overlap', 'closed', 'late', 'overload', 'plant_no_timezone']) {
    const m = rowPrimaryActions({ type, taskId: '10', line: 'L1', time: new Date() }, null, { whatIf: false, acked: false }).menu;
    assert.ok(!m.some(x => /dismiss/i.test(x.action) || /dismiss/i.test(x.labelKey)), type);
  }
});

test('the ⋯ menu: an alert with no order and no line-day has no Go to or Diagnose; an order-less cell alert diagnoses the cell', () => {
  const none = rowPrimaryActions({ type: 'plant_no_timezone' }, null, { whatIf: false, acked: false });
  assert.equal(none.goto, false);
  assert.equal(none.second, undefined);
  assert.deepEqual(none.menu.map(m => m.action), ['ack']);
  const cell = rowPrimaryActions({ type: 'overload', line: 'L1', time: new Date() }, null, { whatIf: false, acked: false });
  assert.deepEqual(cell.menu.map(m => m.action), ['focus', 'fix', 'diagnose', 'ack']);
  // the order handed in stands in for a missing taskId
  assert.equal(rowPrimaryActions({ type: 'closed' }, { id: 7 }, { whatIf: false, acked: false }).second, 'override');
});

test('the ⋯ menu under What-If: Fix / Override are disabled with the hint; ack and Go to stay live', () => {
  const fix = rowPrimaryActions({ type: 'overlap', taskId: '10', line: 'L1', time: new Date() }, null, { whatIf: true, acked: false });
  const f = fix.menu.find(m => m.action === 'fix');
  assert.deepEqual([f.disabled, f.hintKey], [true, 'am.whatif_blocked']);
  assert.ok(fix.menu.filter(m => m.action !== 'fix').every(m => !m.disabled));
  const ov = rowPrimaryActions({ type: 'closed', taskId: '10' }, null, { whatIf: true, acked: false }).menu.find(m => m.action === 'override');
  assert.deepEqual([ov.disabled, ov.hintKey], [true, 'am.whatif_blocked']);
});

test('the ⋯ menu for a needs_planning row: Go to, Slot…, Diagnose, Acknowledge; Slot is locked in What-If', () => {
  const a = { type: 'needs_planning', taskId: '10', line: 'L1', time: new Date() };
  const p = rowPrimaryActions(a, null, { whatIf: false, acked: false });
  assert.deepEqual(p.menu.map(m => [m.action, m.labelKey, !!m.disabled]), [
    ['focus', 'btn.go_to', false], ['slot', 'am.slot', false], ['diagnose', 'am.diagnose', false], ['ack', 'am.ack', false],
  ]);
  const locked = rowPrimaryActions(a, null, { whatIf: true, acked: false });
  const s = locked.menu.find(m => m.action === 'slot');
  assert.deepEqual([s.disabled, s.hintKey], [true, 'am.whatif_blocked']);
  assert.ok(locked.menu.filter(m => m.action !== 'slot').every(m => !m.disabled));
  assert.deepEqual(rowPrimaryActions({ type: 'needs_planning', line: 'L1', time: new Date() }, null, { whatIf: false, acked: false }).menu.map(m => m.action), ['focus', 'diagnose', 'ack'], 'no taskId, no Slot');
});

test('groupCounts: severity counts, distinct orders (taskId ∪ peerId), the whole group\'s movable and un-acked ids', () => {
  const alerts = [
    { id: 'a', sev: 'err', type: 'overlap', taskId: '1', peerId: '2' },
    { id: 'b', sev: 'warn', type: 'tool-conflict', taskId: '2', peerId: '3' },
    { id: 'c', sev: 'warn', type: 'late', taskId: '1' },
    { id: 'd', sev: 'warn', type: 'overload' },
    { id: 'e', sev: 'err', type: 'blackout', taskId: '4' },
  ];
  const c = groupCounts(alerts, id => id === 'c' || id === 'e');
  assert.deepEqual(c, { errors: 2, warnings: 3, orders: 4, movableIds: ["a", "b", "e"], movableOrders: 3, unackedIds: ['a', 'b', 'd'] });
  assert.deepEqual([...MOVABLE_ALERT_TYPES].sort(), ['blackout', 'overlap', 'tool-conflict'], 'overload is not movable');
});

test('group head: toggle carries aria-expanded and the counts; no totals, no column captions, no Dismiss', () => {
  const html = groupHeadHtml(head(), t);
  assert.match(html, /<button[^>]*aria-expanded="true"[^>]*data-am-action="toggle-group"[^>]*data-group-key="capacity"/);
  assert.match(html, /badge badge-err">2<[\s\S]*badge badge-warn">5</);
  assert.doesNotMatch(html, /am-tot|am-gtots|am\.col_|group_dismiss|group-dismiss|data-alert-action/);
  assert.match(html, /<div class="am-ghead">/);
  const collapsed = groupHeadHtml(head({ key: 'k<', label: '<b>x', expanded: false }), t);
  assert.match(collapsed, /aria-expanded="false"/);
  assert.doesNotMatch(collapsed, /<b>/);
});

test('group head: "Move N orders" shows from two movable alerts; the ⋯ menu is always there when it has items', () => {
  assert.match(groupHeadHtml(head({ movable: 3 }), t), /<button type="button" class="btn sm am-group-move" data-am-action="group-move" data-group-key="capacity">am\.group_fix_n\|n=3<\/button>/);
  assert.match(groupHeadHtml(head({ movable: 2 }), t), /group-move/);
  assert.doesNotMatch(groupHeadHtml(head({ movable: 1 }), t), /group-move/);
  assert.doesNotMatch(groupHeadHtml(head({ movable: 0 }), t), /group-move/);
  const menu = groupHeadHtml(head(), t);
  assert.match(menu, /<button type="button" class="icon-btn sm am-group-menu" data-group-key="capacity" data-ovf-key="capacity" aria-haspopup="menu" aria-expanded="false" aria-label="am\.more_actions"/);
  assert.doesNotMatch(groupHeadHtml(head({ firstAlertId: null, firstGoto: false, movable: 0, orders: 0, unacked: 0 }), t), /am-group-menu/);
});

test('group head under What-If: Move N orders is aria-disabled with the hint', () => {
  assert.match(groupHeadHtml(head({ whatIf: true }), t), /class="btn sm am-group-move"[^>]*aria-disabled="true" title="am\.whatif_blocked"/);
  assert.doesNotMatch(groupHeadHtml(head(), t), /aria-disabled/);
});

test('group menu: Go to, Move N orders (also for one), Open these N orders, Acknowledge N… in that order', () => {
  assert.deepEqual(groupMenuItems(head()).map(m => [m.id, m.labelKey, m.vars?.n]), [
    ['goto', 'btn.go_to', undefined], ['move', 'am.group_fix_n', 3], ['open-table', 'am.open_in_table', 4], ['ack', 'am.group_ack_n', 6],
  ]);
  assert.deepEqual(groupMenuItems(head({ movable: 1, unacked: 0, firstGoto: false })).map(m => m.id), ['move', 'open-table']);
  assert.equal(groupMenuItems(head({ movable: 1 })).find(m => m.id === 'move').labelKey, 'am.group_fix_n_one', 'a single movable order says "Move 1 order"');
  assert.equal(groupMenuItems(head({ movable: 2 })).find(m => m.id === 'move').labelKey, 'am.group_fix_n');
  assert.deepEqual(groupMenuItems(head({ movable: 0, orders: 0, unacked: 2, firstAlertId: null })).map(m => m.id), ['ack']);
  const locked = groupMenuItems(head({ whatIf: true })).find(m => m.id === 'move');
  assert.deepEqual([locked.disabled, locked.hintKey], [true, 'am.whatif_blocked']);
  assert.ok(groupMenuItems(head({ whatIf: true })).filter(m => m.id !== 'move').every(m => !m.disabled), 'ack stays live under What-If');
});

test('"Move N orders" counts distinct orders, not alerts', () => {
  const alerts = [
    { id: 'a', sev: 'err', type: 'overlap', taskId: '1', peerId: '2' },
    { id: 'b', sev: 'err', type: 'tool-conflict', taskId: '1', peerId: '3' },
    { id: 'c', sev: 'warn', type: 'blackout', taskId: '5' },
  ];
  const c = groupCounts(alerts, () => false);
  assert.equal(c.movableIds.length, 3);
  assert.equal(c.movableOrders, 2);
});

test('ROW_H is the 32 px compact row', () => {
  assert.equal(ROW_H, 32);
});
