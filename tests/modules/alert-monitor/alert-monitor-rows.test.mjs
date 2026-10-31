// Tests for the pure row action helpers in frontend/alert-monitor/alert-monitor-model.mts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rowPrimaryActions, groupCounts,
  ROW_H, MOVABLE_ALERT_TYPES,
} from '../../../frontend/alert-monitor/alert-monitor-model.mjs';

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
