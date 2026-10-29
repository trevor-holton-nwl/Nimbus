import '../helpers/force-chicago.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { wireWithUnplaced, PLANT, SERVER_NOW } from '../helpers/headless-wire-fixture.mjs';

const { hydrateStoreLikeBrowser } = await import('../helpers/browser-store-hydrate.mjs');
const { Engine, snapshotSchedule, evaluateSchedule } = await import('../../../frontend/optimization/engine.mjs');
const { runOptimizer, planApplyFromState } = await import('../../../frontend/optimization/headless-cli.mjs');
const { patchesToUpdateItems } = await import('../../../frontend/optimization/headless-writer.mjs');
const { decodeTagged } = await import('../../../frontend/optimization/headless-codec.mjs');

const params = {
  mode: 'duedate', search: 'normal', serverNow: SERVER_NOW.toISOString(),
  fakeClock: true, iterationCap: 400, horizonDays: 28,
};
const input = () => ({ plant: PLANT, wire: wireWithUnplaced(), params });
const stable = result => ({ ...result, log: undefined, state: undefined, summary: { ...result.summary, runtime_ms: 0 } });

test('a run answers with TaskDateUpdate items, a summary and a log; the same input gives the same answer', async () => {
  const first = await runOptimizer(input());
  assert.equal(first.status, 'completed');
  assert.ok(first.summary.patched > 0 && first.patches.length === first.summary.patched);
  for (const item of first.patches) {
    assert.equal(item.source, 'optimizer');
    assert.equal(item.force, false);
    assert.equal(typeof item.base_version, 'number');
    assert.ok(!('RUN_TIME' in item) && !('MACHINE' in item) && !('PRT_01' in item) && !('PRODUCTION_VERSION' in item));
    if (item.planning_status !== 'needs_planning') assert.match(item.start_date, /^2035-08-\d\dT\d\d:\d\d:\d\d$/);
  }
  assert.ok(first.log.some(entry => entry.step === 'derive'));
  const second = await runOptimizer(input());
  assert.deepEqual(stable(second), stable(first));
});

test('the headless result equals the browser path: hydrated Store, same request, same engine', async () => {
  const headless = await runOptimizer(input());
  const wire = wireWithUnplaced();
  hydrateStoreLikeBrowser(wire, PLANT);
  // The run quiesced the Store (no subscribers), so the engine's own calendar-landed reconcile is called explicitly.
  Engine.reconcileRuntimeSchedules(PLANT);
  const snapshot = snapshotSchedule(PLANT);
  const plantNow = globalThis.NimbusComputeCore.plantWallClockFromInstant('America/Chicago', SERVER_NOW);
  const startDate = new Date(plantNow); startDate.setSeconds(0, 0);
  const candidate = evaluateSchedule(snapshot, {
    mode: 'duedate', plant: PLANT, lines: null, startDate, endDate: new Date(plantNow.getTime() + 28 * 86_400_000),
    runAt: SERVER_NOW, respectFirmed: true, respectCalendar: true, searchBudgetMs: 8000, exhaustive: false,
    deadlineAt: performance.now() + 8000, iterationCap: 400,
  });
  assert.deepEqual(headless.patches, patchesToUpdateItems(snapshot.tasks, candidate.patches));
});

test('apply phase: unchanged live data applies everything, as one atomic non-forced batch', async () => {
  const run = await runOptimizer(input());
  const plan = await planApplyFromState({ plant: PLANT, runWire: wireWithUnplaced(), liveWire: wireWithUnplaced(), state: run.state, params, jobId: 12 });
  assert.equal(plan.ok, true, JSON.stringify(plan.refusal ?? plan.findings));
  assert.deepEqual(plan.dropped, []);
  assert.deepEqual(plan.apply, run.patches);
  assert.equal(plan.body.client_id, 'job:12');
  assert.equal(plan.body.atomic_optimizer, true);
  assert.equal(plan.body.strict_conflicts, true);
  assert.ok(plan.body.tasks.every(task => task.force === false && task.source === 'optimizer'));
  assert.ok(decodeTagged(run.state).candidate.patches.length > 0, 'the state carries the candidate with real Dates');
});

test('apply phase: a row saved by a planner meanwhile is dropped, the rest still applies', async () => {
  const run = await runOptimizer(input());
  const victim = run.patches[0].id;
  const live = wireWithUnplaced();
  live.tasks.data.find(row => row.id === victim).row_version += 1;
  const plan = await planApplyFromState({ plant: PLANT, runWire: wireWithUnplaced(), liveWire: live, state: run.state, params, jobId: 1 });
  assert.equal(plan.ok, true, JSON.stringify(plan.refusal ?? plan.findings));
  assert.deepEqual(plan.dropped.filter(d => d.id === victim), [{ id: victim, reason: 'row_version_changed' }]);
  assert.ok(!plan.apply.some(item => item.id === victim));
  assert.ok(plan.apply.every(item => item.id === victim ? false : true));
  assert.ok(plan.apply.length >= run.patches.length - plan.dropped.length);
  const liveVersion = live.tasks.data.find(row => row.id === plan.apply[0]?.id)?.row_version;
  if (plan.apply.length) assert.equal(plan.apply[0].base_version, liveVersion, 'items carry the live row version');
});

test('apply phase: a calendar or tool inventory edit since the run refuses the whole apply', async () => {
  const run = await runOptimizer(input());
  const calendar = wireWithUnplaced();
  calendar.calendar.calendar_version = 'cal-2'; calendar.horizons.calendar_version = 'cal-2';
  const a = await planApplyFromState({ plant: PLANT, runWire: wireWithUnplaced(), liveWire: calendar, state: run.state, params, jobId: 1 });
  assert.deepEqual([a.ok, a.refusal, a.versions.calendar_changed], [false, 'calendar_changed', true]);
  const tools = wireWithUnplaced();
  tools.horizons.tool_inventory_version = '3|later';
  const b = await planApplyFromState({ plant: PLANT, runWire: wireWithUnplaced(), liveWire: tools, state: run.state, params, jobId: 1 });
  assert.deepEqual([b.ok, b.refusal], [false, 'tool_inventory_changed']);
});

test('an unusable request is answered, not thrown', async () => {
  const bad = await runOptimizer({ plant: PLANT, wire: wireWithUnplaced(), params: { ...params, serverNow: 'nope' } });
  assert.deepEqual([bad.ok, bad.status], [false, 'invalid_server_now']);
  const mode = await runOptimizer({ plant: PLANT, wire: wireWithUnplaced(), params: { ...params, mode: 'backlog' } });
  assert.deepEqual([mode.ok, mode.status], [false, 'invalid_mode']);
});

test('the Node entry reads stdin, sets TZ from the plant when unset and prints one JSON result', () => {
  const script = fileURLToPath(new URL('../../../frontend/optimization/headless-cli.mjs', import.meta.url));
  const env = { ...process.env }; delete env.TZ;
  const out = spawnSync(process.execPath, [script, '--phase', 'run', '--input', '-'], { input: JSON.stringify(input()), env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const result = JSON.parse(out.stdout);
  assert.equal(result.status, 'completed');
  assert.ok(result.patches.length > 0);
  assert.match(out.stderr.split('\n')[0], /"step":"snapshot"/, 'log lines stream to stderr as JSON');
});
