// Tool Inventory Wave 5: Alerts.applyFix for an `overload` alert now judges a DETACHED candidate first
// (Engine.evaluateSchedule on a snapshot) instead of the live Engine.runAndApply. An error finding means nothing is applied,
// no Undo entry is pushed and the alert stays; a candidate that queues orders for tooling needs the shared confirm
// (Cancel applies nothing, keeps the alert). applyFix is async and resolves true only when something was applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Alerts } from '../../../frontend/insights/services.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Store, UndoStack } from '../../../frontend/platform/store.mjs';
import { Toast, Modal } from '../../../frontend/platform/foundation.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

const alertFor = () => ({ id: 'ov-1', sev: 'warn', type: 'overload', line: 'FX-L1', time: new Date('2035-08-10T10:00:00'), msg: 'overloaded' });

function harness({ candidate, confirm = async () => true }) {
  const calls = { evaluate: [], runAndApply: 0, applied: [], undo: [], dismissed: [], toasts: [], confirms: [] };
  const prior = {
    evaluate: Engine.evaluateSchedule, run: Engine.runAndApply, apply: Engine.applySchedulePatches, push: UndoStack.push,
    dismiss: Alerts.dismiss, clear: Alerts.clearDismissed, recompute: Alerts.scheduleRecompute, show: Toast.show, confirm: Modal.confirm,
    plantNow: Store.plantNow, plantForLine: Store.getPlantForLine, alerts: Store.alerts, sel: Store.selectedPlant,
  };
  Engine.evaluateSchedule = (mode, opts, snapshot) => { calls.evaluate.push({ mode, opts, snapshot }); return candidate; };
  Engine.runAndApply = () => { calls.runAndApply++; };
  Engine.applySchedulePatches = patches => { calls.applied.push(patches); };
  UndoStack.push = (label, fn, ids) => { calls.undo.push({ label, ids }); };
  Alerts.dismiss = id => { calls.dismissed.push(id); };
  Alerts.clearDismissed = () => false;
  Alerts.scheduleRecompute = () => {};
  Toast.show = (m, k) => { calls.toasts.push([String(m), k]); };
  Modal.confirm = async o => { calls.confirms.push(o); return confirm(o); };
  Store.plantNow = () => new Date('2035-08-10T08:00:00');
  Store.getPlantForLine = () => 'FX';
  Store.setTasks([], 'unit-test');
  Store.setAlerts([alertFor()], 'unit-test');
  return {
    calls,
    restore() {
      Engine.evaluateSchedule = prior.evaluate; Engine.runAndApply = prior.run; Engine.applySchedulePatches = prior.apply; UndoStack.push = prior.push;
      Alerts.dismiss = prior.dismiss; Alerts.clearDismissed = prior.clear; Alerts.scheduleRecompute = prior.recompute;
      Toast.show = prior.show; Modal.confirm = prior.confirm; Store.plantNow = prior.plantNow; Store.getPlantForLine = prior.plantForLine;
      Store.setAlerts(prior.alerts, 'unit-test');
    },
  };
}

const patchFor = id => ({ id, changes: { start_date: new Date('2035-08-10T09:00:00'), end_date: new Date('2035-08-10T10:00:00') } });
const okCandidate = (extra = {}) => ({ patches: [patchFor('o1'), patchFor('o2')], validationFindings: [], ...extra });

test('Fix overload evaluates a detached candidate (never the live runAndApply), then applies, pushes one Undo and dismisses', async () => {
  const h = harness({ candidate: okCandidate() });
  try {
    const applied = await Alerts.applyFix('ov-1');
    assert.equal(applied, true);
    assert.equal(h.calls.runAndApply, 0, 'the live runAndApply is no longer used');
    assert.equal(h.calls.evaluate.length, 1);
    const { mode, opts, snapshot } = h.calls.evaluate[0];
    assert.equal(mode, 'changeover');
    assert.deepEqual(opts.lines, ['FX-L1']);
    assert.ok(opts.startDate instanceof Date && opts.endDate - opts.startDate === 24 * 3600 * 1000, 'the same one-day window as before');
    assert.ok(snapshot && Array.isArray(snapshot.tasks), 'a detached snapshot is passed');
    assert.equal(h.calls.applied[0].length, 2);
    assert.equal(h.calls.undo.length, 1);
    assert.deepEqual(h.calls.dismissed, ['ov-1']);
    assert.equal(h.calls.confirms.length, 0, 'no tool-blocked order: no confirm');
  } finally { h.restore(); }
});

test('Fix overload with an error finding: toast, nothing applied, no Undo entry, the alert is NOT dismissed, resolves false', async () => {
  const h = harness({ candidate: okCandidate({ validationFindings: [{ severity: 'error', code: 'overlap', message: 'x' }] }) });
  try {
    assert.equal(await Alerts.applyFix('ov-1'), false);
    assert.equal(h.calls.applied.length, 0);
    assert.equal(h.calls.undo.length, 0);
    assert.deepEqual(h.calls.dismissed, []);
    assert.ok(h.calls.toasts.some(([m, k]) => /fix_overload_blocked/.test(m) && k === 'error'));
    // A warning-only candidate is fine.
  } finally { h.restore(); }
  const w = harness({ candidate: okCandidate({ validationFindings: [{ severity: 'warning', code: 'missing_setup', message: 'w' }] }) });
  try { assert.equal(await Alerts.applyFix('ov-1'), true); } finally { w.restore(); }
});

test('Fix overload: orders queued for tooling need the confirm; Cancel applies nothing and keeps the alert, Confirm applies', async () => {
  const toolBlocked = [{ orderId: 'o1', tool: 'T100', available: 1, inUse: 2, holderIds: ['x'] }, { orderId: 'elsewhere', tool: 'T100', available: 1, inUse: 2, holderIds: ['x'] }];
  let answer = false;
  const h = harness({ candidate: okCandidate({ toolBlocked, toolMoved: [{ orderId: 'o2' }] }), confirm: async () => answer });
  try {
    assert.equal(await Alerts.applyFix('ov-1'), false, 'Cancel');
    assert.equal(h.calls.confirms.length, 1);
    assert.match(h.calls.confirms[0].detail, /o1/);
    assert.doesNotMatch(h.calls.confirms[0].detail, /elsewhere/, 'only orders in the kept patches are listed');
    assert.equal(h.calls.applied.length + h.calls.undo.length + h.calls.dismissed.length, 0, 'Cancel changed nothing');
    answer = true;
    assert.equal(await Alerts.applyFix('ov-1'), true, 'Confirm');
    assert.equal(h.calls.applied.length, 1);
    assert.deepEqual(h.calls.dismissed, ['ov-1']);
  } finally { h.restore(); }
});

test('Fix overload with no plant clock still refuses without evaluating', async () => {
  const h = harness({ candidate: okCandidate() });
  Store.plantNow = () => null;
  try {
    assert.equal(await Alerts.applyFix('ov-1'), false);
    assert.equal(h.calls.evaluate.length, 0);
  } finally { h.restore(); }
});

test('applyFix on an unknown alert resolves false', async () => {
  const h = harness({ candidate: okCandidate() });
  try { assert.equal(await Alerts.applyFix('nope'), false); } finally { h.restore(); }
});
