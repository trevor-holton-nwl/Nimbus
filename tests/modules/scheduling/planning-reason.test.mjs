// Tests for frontend/scheduling/planning-reason.mts — the zero-import leaf behind the Planning reason text.
// The translator is injected, so no Store, Util or DOM is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planningReasonText } from '../../../frontend/scheduling/planning-reason.mjs';

// A stub translator that echoes the key and any variables, so both are asserted.
const t = (key, vars) => vars ? `${key}|${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')}` : key;

test('planningReasonText: fixed codes resolve through the translator', () => {
  for (const code of ['planner_unscheduled', 'segment_floor_unfittable', 'push_limit_unmet']) {
    assert.equal(planningReasonText({ code, message: 'stored' }, t), `planning_reason.${code}`);
  }
});

test('planningReasonText: overlong_never reads "now fits" only when the caller says it fits', () => {
  const reason = { code: 'overlong_never', message: 'stored' };
  assert.equal(planningReasonText(reason, t), 'planning_reason.overlong_never');
  assert.equal(planningReasonText(reason, t, {}), 'planning_reason.overlong_never');
  assert.equal(planningReasonText(reason, t, { nowFits: false }), 'planning_reason.overlong_never');
  assert.equal(planningReasonText(reason, t, { nowFits: true }), 'planning_reason.overlong_released_pending');
});

test('planningReasonText: nowFits changes only overlong_never', () => {
  assert.equal(planningReasonText({ code: 'push_limit_unmet', message: 'm' }, t, { nowFits: true }), 'planning_reason.push_limit_unmet');
  assert.equal(planningReasonText({ code: 'no_fit_found', message: 'stored' }, t, { nowFits: true }), 'stored');
});

test('planningReasonText: run_time_over_cap fills the stored hours rounded to one decimal', () => {
  const reason = { code: 'run_time_over_cap', message: 'stored', run_time: 123.456, cap_hours: 100.04 };
  assert.equal(planningReasonText(reason, t), 'planning_reason.run_time_over_cap|hours=123.5,cap=100');
});

test('planningReasonText: run_time_over_cap falls back to the stored message without both numbers', () => {
  assert.equal(planningReasonText({ code: 'run_time_over_cap', message: 'stored' }, t), 'stored');
  assert.equal(planningReasonText({ code: 'run_time_over_cap', message: 'stored', run_time: 5 }, t), 'stored');
  assert.equal(planningReasonText({ code: 'run_time_over_cap', message: 'stored', run_time: '5', cap_hours: 4 }, t), 'stored');
  assert.equal(planningReasonText({ code: 'run_time_over_cap', run_time: 5 }, t), '');
});

test('planningReasonText: an unknown code keeps its stored message, or empty text without one', () => {
  assert.equal(planningReasonText({ code: 'something_new', message: 'stored' }, t), 'stored');
  assert.equal(planningReasonText({ code: 'something_new' }, t), '');
});

test('planningReasonText: a missing reason is empty text', () => {
  assert.equal(planningReasonText(null, t), '');
  assert.equal(planningReasonText(undefined, t), '');
});

test('Tool Inventory: tool_contention fills tool, available and holders (array capped at five, or a ready string)', () => {
  const holders = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'];
  assert.equal(
    planningReasonText({ code: 'tool_contention', message: 'stored', tool_id: 'T100', available: 2, holders }, t),
    'planning_reason.tool_contention|tool=T100,available=2,holders=h1, h2, h3, h4, h5 ui.opt_bg_more|count=2');
  assert.equal(
    planningReasonText({ code: 'tool_contention', message: 'stored', tool_id: 'T100', available: 1, holders: 'A, B' }, t),
    'planning_reason.tool_contention|tool=T100,available=1,holders=A, B');
  assert.equal(
    planningReasonText({ code: 'tool_contention', message: 'stored', tool_id: 'T100', available: 1 }, t),
    'planning_reason.tool_contention|tool=T100,available=1,holders=');
});

test('Tool Inventory: tool_unavailable and tool_contention_incomplete use the tool id; an unknown shape falls back to the stored message', () => {
  assert.equal(planningReasonText({ code: 'tool_unavailable', message: 'stored', tool_id: 'T9', available: 0 }, t), 'planning_reason.tool_unavailable|tool=T9');
  assert.equal(planningReasonText({ code: 'tool_contention_incomplete', message: 'stored', tool_id: 'T9' }, t), 'planning_reason.tool_contention_incomplete|tool=T9');
  assert.equal(planningReasonText({ code: 'tool_contention', message: 'stored', tool_id: 'T9', available: 1, holders: ['A'], incomplete: true }, t), 'planning_reason.tool_contention_incomplete|tool=T9', 'the optimizer queues at budget expiry with code tool_contention + incomplete');
  assert.equal(planningReasonText({ code: 'tool_contention', message: 'stored', tool_id: 'T9', incomplete: true }, t), 'planning_reason.tool_contention_incomplete|tool=T9', 'incomplete needs only the tool id');
  assert.equal(planningReasonText({ code: 'tool_contention', message: 'stored', tool_id: 'T9', available: 1, incomplete: false }, t), 'planning_reason.tool_contention|tool=T9,available=1,holders=', 'incomplete: false is a plain contention');
  assert.equal(planningReasonText({ code: 'tool_contention', message: 'stored English' }, t), 'stored English', 'no structured fields');
  assert.equal(planningReasonText({ code: 'tool_contention', message: 'stored', tool_id: 'T1', available: 'x' }, t), 'stored', 'available must be a number');
  assert.equal(planningReasonText({ code: 'tool_unavailable', message: 'stored', tool_id: '  ' }, t), 'stored', 'blank tool id');
});

test('formatToolHolders never renders [object Object]: id, then order, then JSON', async () => {
  const { formatToolHolders } = await import('../../../frontend/scheduling/planning-reason.mjs');
  assert.equal(formatToolHolders([{ id: 'a1' }, { order: 'b2' }, { foo: 1 }, 'c3'], t), 'a1, b2, {"foo":1}, c3');
  assert.doesNotMatch(formatToolHolders([{}, { x: { y: 1 } }], t), /object Object/);
});
