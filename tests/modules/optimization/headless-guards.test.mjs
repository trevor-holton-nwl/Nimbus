// Fix-wave guards for the headless runner: the apply phase's own clock, the timezone refusal, a child process in
// the plant's real zone across a DST change, plant-level input drift and family handling.
import '../helpers/force-chicago.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { wireWithUnplaced, taskRow, PLANT, SERVER_NOW } from '../helpers/headless-wire-fixture.mjs';

const { runOptimizer, planApplyFromState } = await import('../../../frontend/optimization/headless-cli.mjs');

const params = { mode: 'duedate', search: 'normal', serverNow: SERVER_NOW.toISOString(), fakeClock: true, iterationCap: 400, horizonDays: 28 };
const runInput = (wire = wireWithUnplaced(), p = params) => ({ plant: PLANT, wire, params: p });
const applyInput = (run, live, extra = {}, runWire = wireWithUnplaced()) =>
  ({ plant: PLANT, runWire, liveWire: live, state: run.state, params, jobId: 9, ...extra });
const row = (wire, id) => wire.tasks.data.find(r => r.id === id);

test('apply phase reads the live board at the LIVE clock: an order that started running since the run is dropped', async () => {
  const run = await runOptimizer(runInput());
  const victim = run.patches.find(p => p.id === '3003')?.id;
  assert.ok(victim, 'the fixture run patches the placed order 3003');
  const live = wireWithUnplaced();
  // The run clock is 08:00 CDT on Aug 6; the live clock is 11:00 CDT. The order began at 10:00 (after the run clock).
  Object.assign(row(live, victim), { user_scheduled: true, start_date: '2035-08-06T10:00:00', end_date: '2035-08-06T13:00:00' });
  const liveServerNow = new Date(SERVER_NOW.getTime() + 3 * 3_600_000).toISOString();
  const withLive = await planApplyFromState(applyInput(run, live, { params: { ...params, liveServerNow } }));
  assert.ok(withLive.dropped.some(d => d.id === victim && d.reason === 'running'), JSON.stringify([withLive.dropped, withLive.refusal, victim, run.patches.map(p => p.id)]));
  assert.ok(!withLive.apply.some(item => item.id === victim));
  // Same board at the run's clock: not yet running, so the running guard does not fire.
  const atRunClock = await planApplyFromState(applyInput(run, live));
  assert.ok(!atRunClock.dropped.some(d => d.id === victim && d.reason === 'running'));
});

test('a process zone that is not the plant zone fails the run and the apply (tz_mismatch), it does not warn', async () => {
  const bad = await runOptimizer(runInput(wireWithUnplaced(), { ...params, plantTimezone: 'Europe/Berlin' }));
  assert.deepEqual([bad.ok, bad.status], [false, 'tz_mismatch']);
  assert.ok(bad.log.some(entry => entry.level === 'error' && entry.step === 'bootstrap'));
  const run = await runOptimizer(runInput());
  const plan = await planApplyFromState(applyInput(run, wireWithUnplaced(), { params: { ...params, plantTimezone: 'Europe/Berlin' } }));
  assert.deepEqual([plan.ok, plan.refusal], [false, 'tz_mismatch']);
});

test('an alias of the process zone is not a mismatch', async () => {
  const result = await runOptimizer(runInput(wireWithUnplaced(), { ...params, plantTimezone: 'US/Central' }));
  assert.equal(result.status, 'completed');
});

test('apply phase answers plant_no_timezone when the plant has no usable zone', async () => {
  const run = await runOptimizer(runInput());
  const runWire = wireWithUnplaced();
  for (const r of runWire.masterData.plants.rows) if (r.plant === PLANT) r.timezone = '';
  const plan = await planApplyFromState(applyInput(run, wireWithUnplaced(), {}, runWire));
  assert.deepEqual([plan.ok, plan.refusal], [false, 'plant_no_timezone']);
});

test('a changed plant row, machine row or blackout since the run refuses the apply; another plant\'s edit does not', async () => {
  const run = await runOptimizer(runInput());
  const plant = wireWithUnplaced();
  plant.masterData.plants.rows.find(r => r.plant === PLANT).max_pull_forward_days = 1;
  assert.equal((await planApplyFromState(applyInput(run, plant))).refusal, 'inputs_changed:master_data');
  const machine = wireWithUnplaced();
  machine.masterData.machine.rows.find(r => r.machine === 'L1').excl_optimizer = 'X';
  assert.equal((await planApplyFromState(applyInput(run, machine))).refusal, 'inputs_changed:master_data');
  const blackout = wireWithUnplaced();   // calendar_version deliberately left equal
  blackout.calendar.machine_blackouts[0].end = '2035-08-07T14:00:00';
  assert.equal((await planApplyFromState(applyInput(run, blackout))).refusal, 'inputs_changed:blackouts');
  const other = wireWithUnplaced();
  other.masterData.plants.rows.find(r => r.plant === 'P2').timezone = 'America/New_York';
  const plan = await planApplyFromState(applyInput(run, other));
  assert.equal(plan.ok, true, JSON.stringify(plan.refusal ?? plan.findings));
});

test('a family is every order sharing the parent and material, patched or not: an unpatched sibling that changed drops the patched ones', async () => {
  const withSibling = () => {
    const wire = wireWithUnplaced();
    wire.tasks.data.push(taskRow('FAM-X', { MACHINE: 'L3', start_date: '2035-08-14T08:00:00', end_date: '2035-08-14T09:00:00' }));
    return wire;
  };
  const family = wire => {
    for (const id of ['FAM-X', ...run.patches.slice(0, 2).map(p => p.id)]) Object.assign(row(wire, id), { PARENT_ORDER: 'P-9', MATERIAL_NUMBER: 'M-9' });
    return wire;
  };
  const run = await runOptimizer(runInput(withSibling()));
  const [a, b] = run.patches;
  assert.ok(a && b && a.id !== 'FAM-X' && b.id !== 'FAM-X');
  const live = family(withSibling());
  row(live, 'FAM-X').row_version += 1;
  const plan = await planApplyFromState(applyInput(run, live, {}, family(withSibling())));
  const reasons = Object.fromEntries(plan.dropped.map(d => [d.id, d.reason]));
  assert.equal(reasons[a.id], 'family');
  assert.equal(reasons[b.id], 'family');
  // The sibling vanishing counts too.
  const gone = family(withSibling());
  gone.tasks.data = gone.tasks.data.filter(r => r.id !== 'FAM-X');
  const plan2 = await planApplyFromState(applyInput(run, gone, {}, family(withSibling())));
  assert.ok(plan2.dropped.some(d => d.id === a.id) && plan2.dropped.some(d => d.id === b.id));
});

// ---- a child process in the plant's real zone, across the America/Chicago fall-back (2035-11-04) ----------------
const cliScript = fileURLToPath(new URL('../../../frontend/optimization/headless-cli.mjs', import.meta.url));
const DAY_SHIFT = 84;   // 12 weeks: Aug 6 (Mon) -> Oct 29 (Mon), weekdays kept; the horizon and the Nov 5-11 period straddle Nov 4
const toDst = wire => JSON.parse(JSON.stringify(wire).replace(/2035-08-(\d\d)/g, (_m, d) => {
  const at = new Date(Date.UTC(2035, 7, Number(d) + DAY_SHIFT));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`;
}));
const dstParams = { ...params, serverNow: '2035-10-29T13:00:00.000Z', horizonDays: 28 };

function child(phase, payload, tz) {
  const env = { ...process.env, TZ: tz };
  const out = spawnSync(process.execPath, [cliScript, '--phase', phase, '--input', '-'], { input: JSON.stringify(payload), env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

test('child process in America/Chicago across the DST change: run and apply agree, dates stay in the plant wall clock', () => {
  const wire = toDst(wireWithUnplaced());
  const run = child('run', { plant: PLANT, wire, params: dstParams }, 'America/Chicago');
  assert.equal(run.status, 'completed', JSON.stringify(run.log.filter(l => l.level === 'error')));
  assert.ok(run.patches.length > 0);
  for (const item of run.patches) if (item.start_date) assert.match(item.start_date, /^2035-1[01]-\d\dT\d\d:\d\d:\d\d$/);
  const again = child('run', { plant: PLANT, wire, params: dstParams }, 'America/Chicago');
  assert.deepEqual(again.patches, run.patches, 'the same input gives the same answer in the plant zone');
  const plan = child('apply', { plant: PLANT, runWire: wire, liveWire: toDst(wireWithUnplaced()), state: run.state,
    params: { ...dstParams, liveServerNow: '2035-10-29T13:05:00.000Z' }, jobId: 4 }, 'America/Chicago');
  assert.equal(plan.ok, true, JSON.stringify(plan.refusal ?? plan.findings));
  assert.deepEqual(plan.apply, run.patches);
  // A run started on the other side of the fall-back (Nov 5, 06:00 CST = 12:00Z) is just as stable.
  const after = child('run', { plant: PLANT, wire, params: { ...dstParams, serverNow: '2035-11-05T12:00:00.000Z' } }, 'America/Chicago');
  assert.ok(['completed', 'invalid_horizon'].includes(after.status), after.status);
});

test('child process started in the wrong zone refuses with tz_mismatch', () => {
  const run = child('run', { plant: PLANT, wire: wireWithUnplaced(), params }, 'UTC');
  assert.deepEqual([run.ok, run.status], [false, 'tz_mismatch']);
});

// ---- drift: the test helper that mirrors the browser's Store hydration must call what the real code calls --------
test('browser-store-hydrate mirrors the real Persistence / CalendarSync / shell calls (source drift check)', () => {
  const read = rel => readFileSync(fileURLToPath(new URL(`../../../frontend/${rel}`, import.meta.url)), 'utf8');
  const helper = readFileSync(fileURLToPath(new URL('../helpers/browser-store-hydrate.mjs', import.meta.url)), 'utf8');
  const persistence = read('scheduling/persistence.mts');
  const calendarSync = read('calendar/calendar-sync.mts');
  const appJs = read('app.js');
  const mirrored = [
    ['Store.setServerNow(', persistence], ['Store.setFrozenHorizonEnd(', persistence], ['Persistence._prepTask(', persistence],
    ['Store.ensureCalendar(', persistence], ['Store.replaceSetupSnapshot(', persistence], ['Store.setPriorityRankMaps(', persistence],
    ['Store.rebuildPlantIndex(', persistence], ['_applyConfig(', calendarSync], ['applyMasterLinesToSettings(', appJs],
    ['Store.setMasterData(', persistence],
  ];
  for (const [call, source] of mirrored) {
    assert.ok(helper.includes(call), `helper no longer calls ${call}`);
    assert.ok(source.includes(call), `the real code no longer calls ${call}: update the helper and headless-snapshot.mts`);
  }
});
