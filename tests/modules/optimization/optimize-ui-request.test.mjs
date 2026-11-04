// P3-5b: every key the engine's evaluation request accepts is either forwarded by the Optimize preview's request
// builder (previewEvaluationRequest) and the worker's evalRequestOf, or sits in an explicit "intentionally not read
// from the run options" allowlist. Adding a key to EngineEvaluationRequest fails typecheck until it is listed in
// ENGINE_EVALUATION_REQUEST_KEYS, and then fails this test until a forward-or-drop decision is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || {
  getElementById() { return null; }, addEventListener() {}, removeEventListener() {},
  createElement() { return { style: {}, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {}, setAttribute() {} }; },
  querySelector() { return null; }, querySelectorAll() { return []; }, body: { appendChild() {}, classList: { add() {}, remove() {} } },
};
const { previewEvaluationRequest } = await import('../../../frontend/optimization/optimize-ui.mjs');
const { ENGINE_EVALUATION_REQUEST_KEYS } = await import('../../../frontend/optimization/scheduler-contract.mjs');
const { evalRequestOf } = await import('../../../frontend/optimization/optimizer-worker-contract.mjs');

/** Keys previewEvaluationRequest takes from its ARGUMENTS, never from the run options. */
const FROM_ARGUMENTS = new Set(['mode', 'deadlineAt']);
/** Keys deliberately not forwarded by previewEvaluationRequest (none today). A new key must be forwarded or listed here WITH a reason. */
const INTENTIONALLY_DROPPED = new Map();

const sentinel = (key) => {
  if (key === 'lines') return ['L-SENTINEL'];
  if (key === 'now' || key === 'startDate' || key === 'endDate') return new Date('2026-01-02T03:04:05');
  if (key === 'respectFirmed' || key === 'respectCalendar' || key === 'exhaustive' || key === 'holdRunning') return true;
  if (key === 'plant') return 'P-SENTINEL';
  if (key === 'iterationCap' || key === 'searchBudgetMs') return 4321;
  return '2026-01-02T03:04:05';   // runNow / runAt / planningStart / placementStart
};

test('previewEvaluationRequest forwards every request key or lists it as intentionally dropped', () => {
  for (const key of ENGINE_EVALUATION_REQUEST_KEYS) {
    if (FROM_ARGUMENTS.has(key)) continue;
    const value = sentinel(key);
    const request = previewEvaluationRequest('changeover', { [key]: value }, 'P-ARG', 999);
    const forwarded = JSON.stringify(request[key]) === JSON.stringify(value);
    if (INTENTIONALLY_DROPPED.has(key)) assert.equal(forwarded, false, `${key} is allowlisted as dropped but is forwarded: remove it from the allowlist`);
    else assert.ok(forwarded, `request key "${key}" is not forwarded by previewEvaluationRequest: forward it or add it to INTENTIONALLY_DROPPED with a reason`);
  }
  const request = previewEvaluationRequest('duedate', {}, 'P-ARG', 999);
  assert.equal(request.mode, 'duedate');
  assert.equal(request.deadlineAt, 999);
  assert.equal(request.plant, 'P-ARG', 'the plant argument is the fallback');
});

test('the allowlists only name real request keys', () => {
  for (const key of [...FROM_ARGUMENTS, ...INTENTIONALLY_DROPPED.keys()]) assert.ok(ENGINE_EVALUATION_REQUEST_KEYS.includes(key), key);
});

test('evalRequestOf carries every request key to the evaluator, the worker mode winning', () => {
  const request = {};
  for (const key of ENGINE_EVALUATION_REQUEST_KEYS) request[key] = sentinel(key);
  const out = evalRequestOf({ runId: 'r', mode: 'spt', snapshot: {}, request });
  for (const key of ENGINE_EVALUATION_REQUEST_KEYS) {
    if (key === 'mode') { assert.equal(out.mode, 'spt'); continue; }
    assert.deepEqual(out[key], request[key], key);
  }
});

// ---- P3-5g: toolRuleOfFingerprint reads the rule back out of toolFingerprint's string ----
test('toolRuleOfFingerprint returns the rule a fingerprint was built under; absent reads as off', async () => {
  const { toolFingerprint, toolRuleOfFingerprint } = await import('../../../frontend/optimization/optimize-ui.mjs');
  const md = (rule) => ({ plants: [{ plant: 'P', setup_policy_config: rule ? { toolingRule: rule } : {} }], lines: [], tool_inventory: [{ plant: 'P', tool_id: 'T1', total_qty: 2, out_of_service_qty: 0 }] });
  assert.equal(toolRuleOfFingerprint(toolFingerprint(md('hard'), 'P')), 'hard');
  assert.equal(toolRuleOfFingerprint(toolFingerprint(md('off'), 'P')), 'off');
  assert.equal(toolRuleOfFingerprint(toolFingerprint(md(null), 'P')), 'off');
  assert.equal(toolRuleOfFingerprint(toolFingerprint(null, 'P')), 'off');
  assert.equal(toolRuleOfFingerprint(null), 'off');
  assert.equal(toolRuleOfFingerprint(undefined), 'off');
  assert.equal(toolRuleOfFingerprint(''), 'off');
});
