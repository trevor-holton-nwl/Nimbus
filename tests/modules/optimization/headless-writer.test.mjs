import '../helpers/force-chicago.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireWithUnplaced, taskRow, PLANT, SERVER_NOW } from '../helpers/headless-wire-fixture.mjs';

const { runOptimizer, planApplyFromState } = await import('../../../frontend/optimization/headless-cli.mjs');

const params = { mode: 'duedate', search: 'normal', serverNow: SERVER_NOW.toISOString(), fakeClock: true, iterationCap: 400, horizonDays: 28 };
const lineOf = (wire, id) => wire.tasks.data.find(row => row.id === id)?.MACHINE;

test('a live order saved onto a kept patch interval drops that patch (collision), the rest applies', async () => {
  const run = await runOptimizer({ plant: PLANT, wire: wireWithUnplaced(), params });
  const target = run.patches.find(item => item.start_date && lineOf(wireWithUnplaced(), item.id));
  assert.ok(target, 'the fixture run places at least one order');
  const live = wireWithUnplaced();
  // A planner saved a NEW order (not in the run) straight onto the proposed interval of the same line.
  live.tasks.data.push(taskRow('NEW-1', { MACHINE: lineOf(live, target.id), start_date: target.start_date, end_date: target.end_date, row_version: 1 }));
  const plan = await planApplyFromState({ plant: PLANT, runWire: wireWithUnplaced(), liveWire: live, state: run.state, params, jobId: 5 });
  assert.ok(plan.dropped.some(d => d.id === target.id), JSON.stringify(plan));
  assert.ok(!plan.apply.some(item => item.id === target.id));
  assert.equal(plan.ok, true, JSON.stringify(plan.refusal ?? plan.findings));
});

test('a dropped patch takes its distribution family with it', async () => {
  const run = await runOptimizer({ plant: PLANT, wire: wireWithUnplaced(), params });
  const [a, b] = run.patches;
  const mk = () => {
    const wire = wireWithUnplaced();
    for (const id of [a.id, b.id]) Object.assign(wire.tasks.data.find(row => row.id === id), { PARENT_ORDER: 'P-1', MATERIAL_NUMBER: 'M-1' });
    return wire;
  };
  const live = mk();
  live.tasks.data.find(row => row.id === a.id).row_version += 1;
  const plan = await planApplyFromState({ plant: PLANT, runWire: mk(), liveWire: live, state: run.state, params, jobId: 5 });
  const reasons = Object.fromEntries(plan.dropped.map(d => [d.id, d.reason]));
  assert.equal(reasons[a.id], 'row_version_changed');
  assert.equal(reasons[b.id], 'family');
});

// P0-21: when the pass cap consumes the whole kept set, the answer is "apply nothing", not a refusal.
test('P0-21: a one-patch candidate whose only patch collides settles as ok with zero rows', async () => {
  const { encodeTagged, decodeTagged } = await import('../../../frontend/optimization/headless-codec.mjs');
  const run = await runOptimizer({ plant: PLANT, wire: wireWithUnplaced(), params });
  const target = run.patches.find(item => item.start_date && lineOf(wireWithUnplaced(), item.id));
  const state = decodeTagged(run.state);
  state.candidate.patches = state.candidate.patches.filter(patch => String(patch.id) === target.id);
  assert.equal(state.candidate.patches.length, 1);
  const live = wireWithUnplaced();
  live.tasks.data.push(taskRow('NEW-1', { MACHINE: lineOf(live, target.id), start_date: target.start_date, end_date: target.end_date, row_version: 1 }));
  const plan = await planApplyFromState({ plant: PLANT, runWire: wireWithUnplaced(), liveWire: live, state: encodeTagged(state), params, jobId: 5 });
  assert.ok(plan.dropped.some(d => d.id === target.id), JSON.stringify(plan));
  assert.equal(plan.ok, true, JSON.stringify(plan.refusal ?? plan.findings));
  assert.deepEqual(plan.apply, []);
  assert.equal(plan.body, null);
});
