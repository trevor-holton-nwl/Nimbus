// Jobs W4b: the headless Remove Backlog step (mode 'backlog'): parity with the browser path, the serialized validation
// bounds (ignorePlantWindow / ignoreToolRule survive the round trip), and the running-order policy (include_running).
import '../helpers/force-chicago.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireWithUnplaced, taskRow, PLANT, SERVER_NOW } from '../helpers/headless-wire-fixture.mjs';

const { hydrateStoreLikeBrowser } = await import('../helpers/browser-store-hydrate.mjs');
const { Engine, snapshotSchedule, evaluateSchedule, rehydrateOptimizerCandidate } = await import('../../../frontend/optimization/engine.mjs');
const { runOptimizer, planApplyFromState } = await import('../../../frontend/optimization/headless-cli.mjs');
const { patchesToUpdateItems } = await import('../../../frontend/optimization/headless-writer.mjs');
const { serializeOptimizerValidation } = await import('../../../frontend/optimization/optimizer-worker-contract.mjs');
const { decodeTagged } = await import('../../../frontend/optimization/headless-codec.mjs');

// The run clock is Monday 2035-08-06 08:00 plant time. L1 holds: a finished-late order (past), one RUNNING now
// (06:00-10:00), one that should start later today (09:00-11:00) and the fixture's own 08-07 order.
const wire = () => {
  const w = wireWithUnplaced();
  // The fixture's split order is a split-policy defect the validator flags on any board; it is not part of this scenario.
  Object.assign(w.tasks.data.find(r => r.id === '1003'), { schedule_segments: [], start_date: '2035-08-08T08:00:00', end_date: '2035-08-08T12:00:00' });
  w.tasks.data.push(
    taskRow('B1', { start_date: '2035-08-03T08:00:00', end_date: '2035-08-03T10:00:00', row_version: 11 }),
    taskRow('B2', { RUN_TIME: 4, start_date: '2035-08-06T06:00:00', end_date: '2035-08-06T10:00:00', row_version: 12 }),
    taskRow('B3', { start_date: '2035-08-06T09:00:00', end_date: '2035-08-06T11:00:00', row_version: 13 }),
  );
  return w;
};
const params = (extra = {}) => ({ mode: 'backlog', search: 'normal', serverNow: SERVER_NOW.toISOString(), fakeClock: true, ...extra });
const input = (extra = {}, w = wire()) => ({ plant: PLANT, wire: w, params: params(extra) });
const ids = patches => patches.map(p => p.id).sort();

test('backlog run: patches, diagnostics and a state that carries the backlog bounds', async () => {
  const run = await runOptimizer(input());
  assert.equal(run.status, 'completed');
  assert.equal(run.summary.mode, 'backlog');
  assert.ok(run.summary.backlog, 'the summary carries the backlog diagnostics');
  assert.ok(run.summary.backlog.found >= 2 && run.summary.backlog.moved >= 1, JSON.stringify(run.summary.backlog));
  assert.equal(run.summary.tool_blocked, 0);
  const state = decodeTagged(run.state);
  assert.equal(state.validation.ignorePlantWindow, true);
  assert.equal(state.validation.ignoreToolRule, true);
  assert.equal(state.includeRunning, true);
  for (const item of run.patches) assert.equal(item.source, 'optimizer');
});

test('parity: the headless backlog patches equal the browser path (hydrated Store, same request, same engine)', async () => {
  const headless = await runOptimizer(input());
  const w = wire();
  hydrateStoreLikeBrowser(w, PLANT);
  Engine.reconcileRuntimeSchedules(PLANT);
  const snapshot = snapshotSchedule(PLANT);
  const plantNow = globalThis.NimbusComputeCore.plantWallClockFromInstant('America/Chicago', SERVER_NOW);
  // The dialog's defaults: earliest past start .. latest end capped four calendar months out.
  const past = snapshot.tasks.map(t => t.start_date).filter(d => d && d < plantNow);
  const start = new Date(Math.min(...past.map(d => d.getTime())));
  const cap = new Date(plantNow); cap.setMonth(cap.getMonth() + 4);
  const ends = snapshot.tasks.map(t => t.end_date).filter(Boolean);
  const end = new Date(Math.min(Math.max(...ends.map(d => d.getTime())), cap.getTime()));
  const candidate = evaluateSchedule(snapshot, {
    mode: 'backlog', plant: PLANT, lines: null, startDate: start, endDate: end, runAt: SERVER_NOW,
    respectFirmed: true, respectCalendar: true, searchBudgetMs: 8000, exhaustive: false, deadlineAt: performance.now() + 8000,
  });
  assert.ok(candidate.patches.length > 0);
  assert.deepEqual(headless.patches, patchesToUpdateItems(snapshot.tasks, candidate.patches));
});

test('bounds round trip: ignorePlantWindow and ignoreToolRule are serialized and restored; other modes do not carry them', async () => {
  const w = wire();
  hydrateStoreLikeBrowser(w, PLANT);
  Engine.reconcileRuntimeSchedules(PLANT);
  const snapshot = snapshotSchedule(PLANT);
  const plantNow = globalThis.NimbusComputeCore.plantWallClockFromInstant('America/Chicago', SERVER_NOW);
  const req = { plant: PLANT, lines: null, startDate: new Date(plantNow.getTime() - 3 * 86_400_000), endDate: new Date(plantNow.getTime() + 28 * 86_400_000),
    runAt: SERVER_NOW, respectFirmed: true, respectCalendar: true, searchBudgetMs: 8000, exhaustive: false, deadlineAt: performance.now() + 8000, iterationCap: 400 };
  const backlog = evaluateSchedule(snapshot, { ...req, mode: 'backlog' });
  assert.equal(backlog.validationContext.bounds.ignorePlantWindow, true);
  const serialized = serializeOptimizerValidation(backlog);
  assert.equal(serialized.ignorePlantWindow, true);
  assert.equal(serialized.ignoreToolRule, true);
  const back = rehydrateOptimizerCandidate(structuredClone({ ...backlog, validationContext: undefined }), snapshot, structuredClone(serialized));
  assert.equal(back.validationContext.bounds.ignorePlantWindow, true);
  assert.equal(back.validationContext.bounds.ignoreToolRule, true);
  const other = evaluateSchedule(snapshot, { ...req, mode: 'duedate' });
  const plain = serializeOptimizerValidation(other);
  assert.ok(!('ignorePlantWindow' in plain) && !('ignoreToolRule' in plain));
  assert.ok(!rehydrateOptimizerCandidate(structuredClone({ ...other, validationContext: undefined }), snapshot, structuredClone(plain)).validationContext.bounds.ignorePlantWindow);
});

test('apply with include_running true (default) writes the running order, like the browser Backlog', async () => {
  const run = await runOptimizer(input());
  const plan = await planApplyFromState({ plant: PLANT, runWire: wire(), liveWire: wire(), state: run.state, params: params(), jobId: 3 });
  assert.equal(plan.ok, true, JSON.stringify(plan.refusal ?? plan.findings));
  assert.deepEqual(plan.dropped, []);
  assert.deepEqual(ids(plan.apply), ids(run.patches));
  assert.ok(plan.apply.some(item => item.id === 'B2'), 'the running order is among the writes');
  assert.equal(plan.body.client_id, 'job:3');
  assert.equal(plan.body.atomic_optimizer, true);
});

const at = (items, id) => items.find(item => item.id === id);
const win = item => [item.start_date, item.end_date];
const planFor = (run, mk, extra = {}) => planApplyFromState({
  plant: PLANT, runWire: mk(), liveWire: mk(), state: run.state, params: params({ include_running: false, ...extra }), jobId: 3 });

test('include_running false is a true plan-around: B2 holds its slot, B1 and B3 are placed after it, offered == applied', async () => {
  const withRunning = await runOptimizer(input());
  const run = await runOptimizer(input({ include_running: false }));
  assert.ok(withRunning.patches.some(p => p.id === 'B2'), 'precondition: B2 is a backlog move when running orders are included');
  assert.equal(run.status, 'completed');
  assert.equal(run.ok, true, JSON.stringify(run.blockers));
  assert.deepEqual(run.blockers, []);
  assert.ok(!run.patches.some(p => p.id === 'B2'), 'the running order is not patched');
  assert.equal(run.summary.backlog.running_skipped, 1);
  assert.equal(run.summary.backlog.running_moved, 0);
  assert.equal(withRunning.summary.backlog.running_moved, 1);
  // B2 runs 06:00-10:00; B1 (2 h) and B3 (2 h) queue behind it in line order.
  const b1 = at(run.patches, 'B1'); const b3 = at(run.patches, 'B3');
  assert.ok(b1 && b3, ids(run.patches).join());
  assert.ok(b1.start_date >= '2035-08-06T10:00:00', JSON.stringify(win(b1)));
  assert.ok(b3.start_date >= b1.end_date, JSON.stringify([win(b1), win(b3)]));
  assert.equal(run.summary.patched, run.patches.length);
  const plan = await planFor(run, wire);
  assert.equal(plan.ok, true, JSON.stringify(plan.refusal ?? plan.findings));
  assert.deepEqual(plan.dropped, [], 'no validation (or any other) drops');
  assert.deepEqual(ids(plan.apply), ids(run.patches), 'offered == applied');
  assert.ok(!plan.apply.some(item => item.id === 'B2'));
});

test('include_running true: summary, patches and applied agree too (nothing dropped for validation)', async () => {
  const run = await runOptimizer(input());
  assert.equal(run.ok, true, JSON.stringify(run.blockers));
  assert.equal(run.summary.patched, run.patches.length);
  const plan = await planApplyFromState({ plant: PLANT, runWire: wire(), liveWire: wire(), state: run.state, params: params(), jobId: 3 });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.dropped.filter(d => d.reason === 'validation'), []);
  assert.deepEqual(ids(plan.apply), ids(run.patches));
});

test('only backlog writes includeRunning / runningIds into the run state', async () => {
  const run = await runOptimizer({ plant: PLANT, wire: wire(), params: { mode: 'duedate', search: 'normal', serverNow: SERVER_NOW.toISOString(), fakeClock: true } });
  const state = decodeTagged(run.state);
  assert.ok(!('includeRunning' in state) && !('runningIds' in state));
  assert.deepEqual(decodeTagged((await runOptimizer(input())).state).runningIds, ['B2']);
});

test('apply (include_running true): an order that was not running at the run but started since is dropped, not moved', async () => {
  const run = await runOptimizer(input());
  // B3 (09:00-11:00 at the run) is in progress by apply time: the live board is read at 09:30 plant time.
  const later = { ...params(), liveServerNow: '2035-08-06T14:30:00.000Z' };
  const plan = await planApplyFromState({ plant: PLANT, runWire: wire(), liveWire: wire(), state: run.state, params: later, jobId: 3 });
  const reasons = Object.fromEntries(plan.dropped.map(d => [d.id, d.reason]));
  assert.equal(reasons.B3, 'running_changed', JSON.stringify(plan.dropped));
  assert.ok(!plan.apply.some(item => item.id === 'B3'));
});

test('apply: a patched start earlier than the apply clock for a still-future order is rejected', async () => {
  const run = await runOptimizer(input());
  const lateApply = { ...params(), liveServerNow: '2035-08-06T13:20:00.000Z' };   // 08:20, twenty minutes after the run
  const plan = await planApplyFromState({ plant: PLANT, runWire: wire(), liveWire: wire(), state: run.state, params: lateApply, jobId: 3 });
  const stale = plan.dropped.filter(d => d.reason === 'start_in_past').map(d => d.id);
  assert.ok(stale.includes('B1'), JSON.stringify(plan.dropped));
});

test('apply within a minute of the run keeps the compressed placements (latency slack)', async () => {
  const run = await runOptimizer(input());
  const near = { ...params(), liveServerNow: '2035-08-06T13:00:40.000Z' };
  const plan = await planApplyFromState({ plant: PLANT, runWire: wire(), liveWire: wire(), state: run.state, params: near, jobId: 3 });
  assert.deepEqual(plan.dropped, []);
});

test('Hard tooling rule plant: backlog is exempt, runs ok and applies in full', async () => {
  const mk = () => {
    const w = wire();
    w.masterData.plants.rows.find(r => r.plant === PLANT).setup_policy_config = { toolingRule: 'hard', version: 1 };
    for (const id of ['B1', 'B2', 'B3']) Object.assign(w.tasks.data.find(r => r.id === id), { PRT_01: 'T1' });
    return w;
  };
  const run = await runOptimizer(input({ include_running: false }, mk()));
  assert.equal(run.ok, true, JSON.stringify(run.blockers));
  assert.equal(run.summary.tool_blocked, 0);
  const plan = await planFor(run, mk);
  assert.equal(plan.ok, true, JSON.stringify(plan.refusal ?? plan.findings));
  assert.deepEqual(plan.dropped, []);
  assert.deepEqual(ids(plan.apply), ids(run.patches));
});

test('setup-inactive and setup-active plants both plan around the running order consistently', async () => {
  for (const active of [true, false]) {
    const mk = () => {
      const w = wire();
      w.masterData.plants.rows.find(r => r.plant === PLANT).setup_active = active;
      w.setup.plant_active = active;
      return w;
    };
    const run = await runOptimizer(input({ include_running: false }, mk()));
    assert.equal(run.ok, true, `active=${active} ${JSON.stringify(run.blockers)}`);
    const plan = await planFor(run, mk);
    assert.equal(plan.ok, true, JSON.stringify(plan.refusal));
    assert.deepEqual(plan.dropped, []);
    assert.deepEqual(ids(plan.apply), ids(run.patches));
  }
});

test('a firmed backlog order is moved like the browser Backlog and counted', async () => {
  const mk = () => {
    const w = wire();
    w.tasks.data.find(r => r.id === 'B1').firmed = true;
    return w;
  };
  const run = await runOptimizer(input({ include_running: false }, mk()));
  assert.equal(run.ok, true, JSON.stringify(run.blockers));
  assert.ok(run.patches.some(p => p.id === 'B1'));
  assert.ok(run.summary.backlog.firmed_moved >= 1, JSON.stringify(run.summary.backlog));
  const plan = await planFor(run, mk);
  assert.equal(plan.ok, true, JSON.stringify([plan.refusal, plan.dropped, plan.findings.map(f => [f.code, f.severity, f.taskId, f.message])]));
  assert.deepEqual(ids(plan.apply), ids(run.patches));
});

test('a split backlog order is moved and still applies in full around the running order', async () => {
  const mk = () => {
    const w = wire();
    Object.assign(w.tasks.data.find(r => r.id === 'B1'), {
      RUN_TIME: 4, start_date: '2035-08-03T08:00:00', end_date: '2035-08-03T16:00:00',
      schedule_segments: [
        { sequence: 1, start_date: '2035-08-03T08:00:00', end_date: '2035-08-03T10:00:00' },
        { sequence: 2, start_date: '2035-08-03T14:00:00', end_date: '2035-08-03T16:00:00' },
      ],
    });
    return w;
  };
  const run = await runOptimizer(input({ include_running: false }, mk()));
  assert.equal(run.ok, true, JSON.stringify(run.blockers));
  assert.ok(run.patches.some(p => p.id === 'B1'));
  const plan = await planFor(run, mk);
  assert.equal(plan.ok, true, JSON.stringify(plan.refusal ?? plan.findings));
  assert.deepEqual(plan.dropped, []);
  assert.deepEqual(ids(plan.apply), ids(run.patches));
});

test('a changed row and its distribution family are dropped, the rest applies (backlog)', async () => {
  const mk = () => {
    const w = wire();
    for (const id of ['B1', 'B3']) Object.assign(w.tasks.data.find(r => r.id === id), { PARENT_ORDER: 'P-9', MATERIAL_NUMBER: 'M-9' });
    return w;
  };
  const run = await runOptimizer(input({}, mk()));
  const moved = ids(run.patches);
  assert.ok(moved.includes('B1') && moved.includes('B3'), `precondition: ${moved}`);
  const live = mk();
  live.tasks.data.find(r => r.id === 'B1').row_version += 1;
  const plan = await planApplyFromState({ plant: PLANT, runWire: mk(), liveWire: live, state: run.state, params: params(), jobId: 3 });
  const reasons = Object.fromEntries(plan.dropped.map(d => [d.id, d.reason]));
  assert.equal(reasons.B1, 'row_version_changed');
  assert.equal(reasons.B3, 'family');
});

test('nothing to move: an on-time board answers no patches', async () => {
  const w = wireWithUnplaced();
  const run = await runOptimizer(input({}, w));
  assert.equal(run.status, 'completed');
  assert.equal(run.patches.length, 0);
});
