// Tests for the pure row / group-head / diagnose builders in frontend/alert-monitor/alert-monitor-model.mts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rowActionsFor, rowHtml, rowPrefix, rowPrimaryActions, groupHeadHtml, groupMenuItems, groupCounts, groupLabel, diagnoseHtml,
  relativeDaysText, formatPairKey, fmtNum, GROUP_ROW_CAP, ROW_H, DIAG_H, MOVABLE_ALERT_TYPES,
} from '../../../frontend/alert-monitor/alert-monitor-model.mjs';

const t = (k, v) => `${k}${v ? '|' + Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',') : ''}`;

const view = (o = {}) => ({
  id: 'a1', type: 'overlap', sev: 'err', taskId: '10', line: 'L1', time: new Date('2026-10-21T08:00:00'),
  headline: 'Order overlap', message: 'Overlaps 4500118 by 2 h', help: 'help text', orderNo: '4711', groupBy: 'category',
  dateText: 'Wed 21 Oct', relText: 'in 1 days', overdue: false, anchorTip: 'am.anchor_time: 2026-10-21 08:00',
  whatIf: false, ackLabel: null, diagOpen: false, diagHtml: '', ...o,
});

const head = (o = {}) => ({
  key: 'capacity', label: 'Capacity', expanded: true, errors: 2, warnings: 5, firstAlertId: 'a1', firstGoto: true,
  orders: 4, movable: 3, unacked: 6, whatIf: false, ...o,
});

test('row builder escapes every dynamic string', () => {
  const html = rowHtml(view({
    id: 'x"><img src=x onerror=alert(1)>', headline: '<img onerror=alert(1)>', message: '<script>x</script>',
    orderNo: '<b>1</b>', line: '"><i>', taskId: '1"><u>', type: 'closed', help: '<svg onload=1>',
    dateText: '<em>d</em>', relText: '<s>r</s>', anchorTip: '<q>tip</q>', ackLabel: '<mark>ack</mark>',
  }), t);
  assert.doesNotMatch(html, /<img|<script|<svg|<b>|<u>|<i>|<em>|<s>|<q>|<mark>/);
  assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
});

test('a row is one line: a single .am-when, the prefix and message, and no number columns or meta block', () => {
  const html = rowHtml(view(), t);
  assert.equal((html.match(/class="am-when/g) ?? []).length, 1);
  assert.match(html, /<span class="am-when" title="am\.anchor_time: 2026-10-21 08:00">Wed 21 Oct · in 1 days<\/span>/);
  assert.doesNotMatch(html, /am-imp|am-num|am-meta|am-help|am-headline|am-hl\b|ⓘ/);
  assert.match(html, /<div class="am-main"><span class="am-pfx">L1 · 4711 ·<\/span><span class="am-msg">Overlaps 4500118 by 2 h<\/span><\/div>/);
  assert.equal(ROW_H, 44);
});

test('an overdue anchor carries .am-when-overdue; the row tooltip is the headline and the help sentence', () => {
  assert.match(rowHtml(view({ overdue: true, relText: '3 days overdue' }), t), /class="am-when am-when-overdue"/);
  assert.doesNotMatch(rowHtml(view(), t), /am-when-overdue/);
  assert.match(rowHtml(view(), t), /<div class="am-row am-row-err" title="Order overlap — help text">/);
  assert.match(rowHtml(view({ help: '' }), t), /title="Order overlap">/);
});

test('prefix: line + order, line only (overload), neither (no stray separator)', () => {
  assert.equal(rowPrefix(view()), 'L1 · 4711');
  assert.equal(rowPrefix(view({ orderNo: '' })), 'L1');
  assert.equal(rowPrefix(view({ line: '', orderNo: '' })), '');
  assert.equal(rowPrefix(view({ line: undefined, orderNo: '' })), '');
  const tz = rowHtml(view({ type: 'plant_no_timezone', line: '', orderNo: '', taskId: undefined, message: 'Plant has no time zone' }), t);
  assert.doesNotMatch(tz, /am-pfx/);
  assert.doesNotMatch(tz, /·\s*<\/span><span class="am-msg"/);
  assert.match(tz, /<div class="am-main"><span class="am-msg">Plant has no time zone<\/span><\/div>/);
  assert.match(rowHtml(view({ orderNo: '', taskId: undefined, type: 'overload' }), t), /<span class="am-pfx">L1 ·<\/span>/);
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

test('Fix only appears on fixable types; Override only on the closed family with a taskId', () => {
  for (const type of ['overlap', 'blackout', 'overload', 'tool-conflict']) {
    assert.equal(rowActionsFor({ type, taskId: '1' }).fix, true, type);
    assert.match(rowHtml(view({ type }), t), /data-alert-action="fix"/);
  }
  assert.doesNotMatch(rowHtml(view({ type: 'late' }), t), /data-alert-action="fix"/);
  for (const type of ['closed', 'firmed-closed', 'firmed-out-of-hours']) {
    assert.match(rowHtml(view({ type }), t), /data-alert-action="override"[^>]*data-task-id="10"/);
    assert.equal(rowActionsFor({ type }).override, false, 'no taskId, no override');
  }
  assert.doesNotMatch(rowHtml(view({ type: 'overlap' }), t), /data-alert-action="override"/);
  assert.doesNotMatch(rowHtml(view({ type: 'closed', taskId: undefined }), t), /data-alert-action="override"/);
});

test('the second button splits the glyph from its text label; aria-label and title carry the label', () => {
  const real = (k, v) => ({ 'btn.fix_it': '⚙ Fix', 'btn.override': '📅 Override', 'tip.fix_alert': 'Automatically resolve this alert' }[k] ?? t(k, v));
  const fix = rowHtml(view(), real);
  assert.match(fix, /<button[^>]*class="btn sm btn-fix am-act-2"[^>]*aria-label="Fix"[^>]*title="Fix · Automatically resolve this alert"[^>]*><span class="am-glyph" aria-hidden="true">⚙<\/span><span class="lbl">Fix<\/span><\/button>/);
  const ov = rowHtml(view({ type: 'closed' }), real);
  assert.match(ov, /<button[^>]*class="btn btn-ghost sm am-act-2"[^>]*aria-label="Override"[^>]*title="Override"[^>]*><span class="am-glyph" aria-hidden="true">📅<\/span><span class="lbl">Override<\/span><\/button>/);
  // a label with no leading glyph is all text
  assert.match(rowHtml(view(), (k, v) => (k === 'btn.fix_it' ? 'Fix' : t(k, v))), /<span class="lbl">Fix<\/span>/);
  // an alert with neither action has no second button
  assert.doesNotMatch(rowHtml(view({ type: 'late' }), real), /am-act-2/);
});

test('the actions are Go to, the second button and the ⋯ trigger; no Acknowledge, Diagnose or Dismiss buttons on the row', () => {
  const html = rowHtml(view(), t);
  assert.match(html, /data-alert-action="focus" data-alert-id="a1">btn\.go_to</);
  assert.match(html, /<button type="button" class="icon-btn sm am-row-menu" data-alert-id="a1" data-ovf-key="a1" aria-haspopup="menu" aria-expanded="false" aria-label="am\.more_actions"[^>]*>⋯<\/button>/);
  assert.doesNotMatch(html, /data-alert-action="(ack|unack|diagnose|dismiss)"|btn\.dismiss|group_dismiss/);
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  assert.equal((rowHtml(view({ type: 'late' }), t).match(/<button/g) ?? []).length, 2);
  assert.equal((rowHtml(view({ type: 'overload', taskId: undefined }), t).match(/<button/g) ?? []).length, 3, 'a line-day alert still has Go to');
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

test('What-If disables the Fix and Override buttons with the explanatory title; Go to stays live', () => {
  const fix = rowHtml(view({ whatIf: true }), t);
  assert.match(fix, /<button[^>]*data-alert-action="fix"[^>]*disabled[^>]*am\.whatif_blocked/);
  const ov = rowHtml(view({ type: 'closed', whatIf: true }), t);
  assert.match(ov, /<button[^>]*data-alert-action="override"[^>]*disabled[^>]*am\.whatif_blocked/);
  assert.match(ov, /data-alert-action="focus"/, 'Go To stays live');
});

test('diagnose: order alerts expand inline (help sentence first), line/day alerts open the cell briefing', () => {
  assert.equal(rowActionsFor({ type: 'overload', line: 'L1', time: new Date() }).diagnose, 'cell');
  assert.equal(rowActionsFor({ type: 'late', taskId: '1', line: 'L1', time: new Date() }).diagnose, 'order');
  const diag = diagnoseHtml([{ label: 'Due', value: '2026-10-20' }], 'Why this matters · what to do');
  assert.match(diag, /^<p class="am-diag-help" title="Why this matters · what to do">Why this matters · what to do<\/p><dl class="am-diag-grid">/);
  assert.match(diag, /<dt>Due<\/dt><dd title="2026-10-20">2026-10-20<\/dd>/);
  assert.doesNotMatch(diagnoseHtml([{ label: 'Due', value: 'x' }]), /am-diag-help/, 'no help sentence, no line');
  assert.match(diagnoseHtml([], '<b>x</b>'), /&lt;b&gt;x&lt;\/b&gt;/);
  const open = rowHtml(view({ type: 'late', diagOpen: true, diagHtml: diag }), t);
  assert.match(open, /<div class="am-diag"><p class="am-diag-help"/);
  const cell = rowHtml(view({ type: 'overload', taskId: undefined, diagOpen: true, diagHtml: 'X' }), t);
  assert.doesNotMatch(cell, /class="am-diag"/, 'a cell diagnose never expands inline');
  assert.ok(DIAG_H > 96, 'the panel grew by the help line');
});

test('calendar-family rows use the circled-slash glyph, others the severity glyph; acked rows carry the badge', () => {
  assert.match(rowHtml(view({ type: 'closed' }), t), /am-sev am-sev-err" aria-hidden="true">⊘/);
  assert.match(rowHtml(view({ type: 'overlap', sev: 'warn' }), t), /am-sev-warn" aria-hidden="true">⚠/);
  assert.match(rowHtml(view({ ackLabel: 'Acknowledged by Ana' }), t), /am-ack-badge[^>]*>Acknowledged by Ana</);
  assert.doesNotMatch(rowHtml(view(), t), /am-ack-badge/);
});

test('no rendered row or head mentions points, pts, exact or estimate', () => {
  const html = rowHtml(view(), t) + rowHtml(view({ type: 'closed', ackLabel: 'x', overdue: true }), t) + groupHeadHtml(head(), t);
  assert.doesNotMatch(html, /points|pts|exact|estimate|col_/i);
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
  assert.deepEqual(c, { errors: 2, warnings: 3, orders: 4, movableIds: ['a', 'b', 'e'], unackedIds: ['a', 'b', 'd'] });
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
  assert.deepEqual(groupMenuItems(head({ movable: 0, orders: 0, unacked: 2, firstAlertId: null })).map(m => m.id), ['ack']);
  const locked = groupMenuItems(head({ whatIf: true })).find(m => m.id === 'move');
  assert.deepEqual([locked.disabled, locked.hintKey], [true, 'am.whatif_blocked']);
  assert.ok(groupMenuItems(head({ whatIf: true })).filter(m => m.id !== 'move').every(m => !m.disabled), 'ack stays live under What-If');
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
});
