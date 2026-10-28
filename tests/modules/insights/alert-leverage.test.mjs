// Task 8: the leverage engine. groupLeverage (sync, removal deltas) and analyzeLeverage (setup-pair replay).
// Synthetic alerts + a fake runner cover grouping/points/sort/cap; the replay sign tests drive the real
// alert engine through runLeverageBatchSync so "after" is a genuine recomputation, not a formula.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Store } from '../../../frontend/platform/store.mjs';
import { buildPlantSnapshot, runLeverageBatchSync } from '../../../frontend/insights/services.mjs';
import { deriveSetupObservation } from '../../../frontend/optimization/engine.mjs';
import { resolveSetup } from '../../../frontend/setup/setup-domain.mjs';
import {
  groupLeverage, analyzeLeverage, replayWithMinutes, parsePairKey, hypotheticalSetupSnapshot,
} from '../../../frontend/insights/alert-leverage.mjs';

const Core = createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
globalThis.NimbusComputeCore = Core;
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

const PLANT = 'LP';
const LINE = 'L1';
const HM = 20160;
const plantNow = new Date(2026, 9, 20, 7, 0, 0);
const atDay = (n, h = 12) => new Date(2026, 9, 20 + n, h, 0, 0);
const dk = n => Core.dayKey(atDay(n));
const EMPTY = { intervals: [], diagnostics: [] };
const PAIR_AB = '[["colorWheel","A"]]->[["colorWheel","B"]]';

function al(id, type, sev, day, extra = {}) {
  return { id, sev, type, msg: id, line: LINE, time: atDay(day), ...extra };
}
function score(alerts, machines) {
  return Core.scoreConfidence({ alerts, horizonStart: plantNow, horizonMinutes: HM, machines }).score;
}
function baseSnap(over = {}) {
  return {
    tasks: [], blocks: [], plantBlocks: [], calendars: {}, plants: {}, lineSettings: {}, masterData: null,
    setup: EMPTY, lines: [LINE], now: {}, blockedPlants: [], ...over,
  };
}
function mkInput(over = {}) {
  return {
    plant: PLANT, plantNow, horizonMinutes: HM, alerts: [], tasksById: {}, lines: new Set([LINE]),
    setupSnapshot: null, masterPlant: null, snapshotBase: baseSnap(), baselineMatrix: {}, ...over,
  };
}
const fakeRunner = (results = []) => {
  const calls = [];
  const fn = async (base, variants) => { calls.push({ base, variants }); return results.length ? results : variants.map(v => ({ key: v.key, alerts: [], matrix: {} })); };
  fn.calls = calls;
  return fn;
};
const byFamily = (items, family) => items.filter(i => i.family === family);

// ---- real-engine fixture (setup pairs) ---------------------------------------------------------

function setupSnapshot(plantRows = []) {
  return {
    plant: PLANT,
    definition: { plant: PLANT, fields: ['colorWheel'], signature_version: 1, strict_blanks: false, active: true },
    plant_rows: plantRows, machine_rows: [], machine_states: [], overrides: [], plant_active: true,
  };
}
function orderTask(id, color, startH, endH, day = 1) {
  return {
    id, MACHINE: LINE, PLANT, plant: PLANT, COLOR: color, ORDER: `O${id}`, RUN_TIME: endH - startH,
    planning_status: 'scheduled', start_date: atDay(day, startH), end_date: atDay(day, endH),
  };
}
/** Seeds the Store, derives the real baseline setup observation and baseline alerts/matrix. */
function fixture({ tasks, masterPlant = { plant: PLANT }, plantRows = [], replayCap }) {
  Store.setMasterData({ plants: [{ plant: PLANT }], lines: [{ plant: PLANT, line: LINE }] }, 'test');
  Store.setTasks(tasks, 'test');
  Store.replaceBlocks([], 'test'); Store.replacePlantBlocks([], 'test');
  Store.replaceCalendars({}, 'test'); Store.replacePlants({}, 'test');
  Store.setSelectedPlant(PLANT, 'test');
  const snap0 = buildPlantSnapshot(PLANT, { setupObservation: EMPTY });
  const ss = setupSnapshot(plantRows);
  const tasksById = Object.fromEntries(tasks.map(t => [t.id, t]));
  const ctx = {
    calendars: snap0.calendars, plants: snap0.plants, lineSettings: snap0.lineSettings, masterData: snap0.masterData,
    blocks: snap0.blocks, plantBlocks: snap0.plantBlocks,
  };
  const setup = deriveSetupObservation(ss, tasks, new Set([LINE]), ctx);
  const snapshotBase = { ...snap0, setup, now: { [PLANT]: plantNow } };
  const startMs = new Date(2026, 9, 20).getTime();
  const base = { ...snapshotBase, dismissed: [], opts: { lines: null }, startMs, days: 14, lines: snapshotBase.lines ?? undefined };
  const [baseline] = runLeverageBatchSync(base, [{ key: 'baseline', setup }]);
  return {
    input: {
      plant: PLANT, plantNow, horizonMinutes: HM, alerts: baseline.alerts, tasksById, lines: new Set([LINE]),
      setupSnapshot: ss, masterPlant, snapshotBase, baselineMatrix: baseline.matrix, replayCap,
    },
    runner: async (b, v) => runLeverageBatchSync(b, v),
    baseline,
  };
}
const policy = minutes => ({ plant: PLANT, setup_policy_config: { unknownSetupPolicy: 'plantDefaultMinutes', unknownSetupDefaultMinutes: minutes } });

// ---- confidence + points -------------------------------------------------------------------------

test('points sum core alertPoints; outsideConfidenceWindowCount counts zero-point alerts', () => {
  const alerts = [
    al('t1', 'tool-conflict', 'err', 1, { msgVars: { tool: 'T9' }, taskId: 'a', peerId: 'b' }),
    al('t2', 'tool-conflict', 'warn', 2, { msgVars: { tool: 'T9' }, taskId: 'c', peerId: 'd' }),
    al('t3', 'tool-conflict', 'err', 30, { msgVars: { tool: 'T9' }, taskId: 'e', peerId: 'f' }),
  ];
  const [item] = byFamily(groupLeverage(mkInput({ alerts })), 'tool');
  const end = new Date(plantNow.getTime() + HM * 60000);
  const expected = alerts.reduce((s, a) => s + Core.alertPoints(a, plantNow, end), 0);
  assert.equal(item.points, expected);
  assert.ok(item.points > 0);
  assert.equal(item.outsideConfidenceWindowCount, 1);
  assert.deepEqual(item.alertIds, ['t1', 't2', 't3']);
  assert.deepEqual(item.orderIds.sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(item.family, 'tool');
  assert.deepEqual(item.action, { kind: 'tool', tool: 'T9', alertIds: ['t1', 't2', 't3'] });
});

test('confidenceBefore is the plant-wide score; removal delta equals scoreConfidence on the reduced set', () => {
  const matrix = { L1: { [dk(1)]: { scheduled: 20, effectiveCapacity: 12 }, [dk(2)]: { scheduled: 4, effectiveCapacity: 12 } } };
  const other = Array.from({ length: 4 }, (_, i) => al(`o${i}`, 'late', 'warn', 2 + i, { taskId: `x${i}` }));
  const tool = [
    al('t1', 'tool-conflict', 'err', 1, { msgVars: { tool: 'T9' }, taskId: 'a', peerId: 'b' }),
    al('t2', 'tool-conflict', 'err', 2, { msgVars: { tool: 'T9' }, taskId: 'c', peerId: 'd' }),
  ];
  const alerts = [...other, ...tool];
  const items = groupLeverage(mkInput({ alerts, baselineMatrix: matrix }));
  const item = byFamily(items, 'tool')[0];
  assert.equal(item.confidenceBefore, score(alerts));
  assert.equal(item.confidenceAfter, score(other));
  assert.equal(item.method, 'removal');
  assert.ok(item.confidenceAfter > item.confidenceBefore);
});

test('parity: score-without equals scoreConfidence on the reduced set for every machine count, with a pre-dismiss scoring list', () => {
  const other = Array.from({ length: 6 }, (_, i) => al(`o${i}`, 'late', 'warn', 2 + i, { taskId: `x${i}` }));
  const tool = [
    al('t1', 'tool-conflict', 'err', 1, { msgVars: { tool: 'T9' }, taskId: 'a', peerId: 'b' }),
    al('t2', 'tool-conflict', 'err', 2, { msgVars: { tool: 'T9' }, taskId: 'c', peerId: 'd' }),
  ];
  const dismissedAlert = al('dis1', 'overlap', 'err', 1, { taskId: 'z', peerId: 'y' });
  for (const machines of [undefined, 1, 5, 70]) {
    const shown = [...other, ...tool];                       // what the cards are built from (dismissed excluded)
    const scoring = [...shown, dismissedAlert];              // what the badge scores (dismissed still counts)
    const [item] = byFamily(groupLeverage(mkInput({ alerts: shown, scoringAlerts: scoring, machines })), 'tool');
    assert.equal(item.confidenceBefore, score(scoring, machines), `before equals the badge (machines=${machines})`);
    assert.equal(item.confidenceAfter, score([...other, dismissedAlert], machines), `after (machines=${machines})`);
  }
});

// ---- setup pairs ---------------------------------------------------------------------------------

test('parsePairKey splits on ]-> and rejects unknown halves', () => {
  const p = parsePairKey(PAIR_AB);
  assert.deepEqual(p.from, [{ fieldKey: 'colorWheel', value: 'A' }]);
  assert.deepEqual(p.to, [{ fieldKey: 'colorWheel', value: 'B' }]);
  assert.equal(parsePairKey('unknown->[["colorWheel","B"]]'), null);
  assert.equal(parsePairKey('[["colorWheel","A"]]->unknown'), null);
  assert.equal(parsePairKey('garbage'), null);
  const two = parsePairKey('[["colorWheel","A"],["prt01","X"]]->[["colorWheel","B"],["prt01","Y"]]');
  assert.equal(two.from.length, 2);
  assert.equal(two.to[1].value, 'Y');
});

test('setup-pair grouping: by pairKey plant-wide, unknown keys skipped, orders/lines from diagnostics', () => {
  const diag = (line, succ, pairKey, pred = 'p') => ({ type: 'setup-uncovered', line, scope: `${PLANT}/${line}`, pairKey, predecessorOrderId: pred, successorOrderId: succ, time: atDay(1) });
  const snapshotBase = baseSnap({
    lines: ['L1', 'L2'],
    setup: { intervals: [], diagnostics: [diag('L1', 's1', PAIR_AB), diag('L1', 's2', PAIR_AB), diag('L2', 's3', PAIR_AB), diag('L1', 's4', 'unknown->[["colorWheel","B"]]')] },
  });
  const alerts = [
    al('su-L1', 'setup-uncovered', 'err', 1, { pairKey: PAIR_AB, scope: `${PLANT}/L1`, taskId: 's1' }),
    al('su-L2', 'setup-uncovered', 'err', 1, { line: 'L2', pairKey: PAIR_AB, scope: `${PLANT}/L2`, taskId: 's3' }),
    al('su-unk', 'setup-uncovered', 'err', 1, { pairKey: 'unknown->[["colorWheel","B"]]', taskId: 's4' }),
  ];
  const items = byFamily(groupLeverage(mkInput({ alerts, snapshotBase, lines: new Set(['L1', 'L2']) })), 'setup-pair');
  assert.equal(items.length, 1);
  const [item] = items;
  assert.deepEqual(item.alertIds.sort(), ['su-L1', 'su-L2']);
  assert.deepEqual(item.orderIds.sort(), ['s1', 's2', 's3']);
  assert.deepEqual(item.lines.sort(), ['L1', 'L2']);
  assert.equal(item.titleVars.from, 'Color A');
  assert.equal(item.titleVars.to, 'Color B');
  assert.equal(item.titleVars.lines, 2);
  assert.equal(item.titleVars.orders, 3);
  assert.equal(item.action.kind, 'open-setup-matrix');
  assert.equal(item.action.plant, PLANT);
  assert.equal(item.action.pairs.length, 3);
  assert.deepEqual(item.action.pairs[0], {
    line: 'L1', predecessorOrderId: 'p', successorOrderId: 's1',
    fromState: [{ fieldKey: 'colorWheel', value: 'A' }], toState: [{ fieldKey: 'colorWheel', value: 'B' }], reason: 'setup-uncovered',
  });
});

test('setup-pair action.pairs is capped at 12', () => {
  const diags = Array.from({ length: 15 }, (_, i) => ({ type: 'setup-uncovered', line: LINE, scope: `${PLANT}/${LINE}`, pairKey: PAIR_AB, predecessorOrderId: `p${i}`, successorOrderId: `s${i}`, time: atDay(1) }));
  const alerts = [al('su', 'setup-uncovered', 'err', 1, { pairKey: PAIR_AB, taskId: 's0' })];
  const [item] = byFamily(groupLeverage(mkInput({ alerts, snapshotBase: baseSnap({ setup: { intervals: [], diagnostics: diags } }) })), 'setup-pair');
  assert.equal(item.action.pairs.length, 12);
  assert.equal(item.orderIds.length, 15);
});

test('minutes: plant default policy gives assumedMinutes; otherwise requiresMinutes with no replay', async () => {
  const f = fixture({ tasks: [orderTask('t1', 'A', 8, 9), orderTask('t2', 'B', 10, 11)], masterPlant: policy(25) });
  const withDefault = byFamily(groupLeverage(f.input), 'setup-pair')[0];
  assert.equal(withDefault.assumedMinutes, 25);
  assert.equal(withDefault.minutesSource, 'plantDefault');
  assert.ok(!withDefault.requiresMinutes);

  for (const mp of [null, { plant: PLANT }, { plant: PLANT, setup_policy_config: { unknownSetupPolicy: 'zero', unknownSetupDefaultMinutes: 25 } },
    { plant: PLANT, setup_policy_config: { unknownSetupPolicy: 'plantDefaultMinutes', unknownSetupDefaultMinutes: 0 } }]) {
    const input = { ...f.input, masterPlant: mp };
    const [item] = byFamily(groupLeverage(input), 'setup-pair');
    assert.equal(item.requiresMinutes, true);
    assert.equal(item.method, 'removal');
    assert.equal(item.assumedMinutes ?? null, null);
    assert.equal(typeof item.confidenceAfter, 'number');
    const runner = fakeRunner();
    const out = await analyzeLeverage(input, runner);
    assert.equal(runner.calls.length, 0, 'nothing to replay without minutes');
    assert.equal(byFamily(out, 'setup-pair')[0].method, 'removal');
  }
});

test('hypotheticalSetupSnapshot carries value_defaults through and the added row wins over the default', () => {
  const ss = { ...setupSnapshot(), value_defaults: [{ field_key: 'colorWheel', value: 'B', setup_min: 40, signature_version: 1 }] };
  const pair = parsePairKey(PAIR_AB);
  const hypo = hypotheticalSetupSnapshot(ss, pair, 15);
  assert.equal(hypo.value_defaults, ss.value_defaults, 'value_defaults must survive the shallow copy');
  const input = (snap) => ({
    definition: snap.definition, machine: LINE, predecessorState: pair.from, successorState: pair.to,
    predecessorOrderId: 'a', successorOrderId: 'b', plantRows: snap.plant_rows, machineRows: [], overrides: [],
    valueDefaults: snap.value_defaults,
  });
  const base = resolveSetup(input(ss));
  assert.equal(base.source, 'value-default');
  assert.equal(base.effectiveMin, 40);
  const withRow = resolveSetup(input(hypo));
  assert.equal(withRow.source, 'plant');
  assert.equal(withRow.effectiveMin, 15);
});

test('hypotheticalSetupSnapshot adds a plant row that resolves covered and does not mutate the source', () => {
  const ss = setupSnapshot();
  const pair = parsePairKey(PAIR_AB);
  const hypo = hypotheticalSetupSnapshot(ss, pair, 15);
  assert.equal(ss.plant_rows.length, 0);
  assert.equal(hypo.plant_rows.length, 1);
  assert.equal(hypo.plant_rows[0].machine, '');
  assert.equal(hypo.plant_rows[0].signature_version, 1);
  const input = (rows) => ({
    definition: ss.definition, machine: LINE, predecessorState: pair.from, successorState: pair.to,
    predecessorOrderId: 'a', successorOrderId: 'b', plantRows: rows, machineRows: [], overrides: [],
  });
  assert.equal(resolveSetup(input(ss.plant_rows)).covered, false);
  const r = resolveSetup(input(hypo.plant_rows));
  assert.equal(r.covered, true);
  assert.equal(r.effectiveMin, 15);
});

test('replay sign A: free minutes clear the pair, after > before and method is replay', async () => {
  const f = fixture({ tasks: [orderTask('t1', 'A', 8, 9), orderTask('t2', 'B', 10, 11)], masterPlant: policy(15) });
  assert.ok(f.baseline.alerts.some(a => a.type === 'setup-uncovered' && a.pairKey === PAIR_AB), 'fixture raises the uncovered pair');
  const [item] = byFamily(await analyzeLeverage(f.input, f.runner), 'setup-pair');
  assert.equal(item.method, 'replay');
  assert.equal(item.confidenceBefore, score(f.baseline.alerts, f.baseline.matrix));
  assert.ok(item.confidenceAfter > item.confidenceBefore, `after ${item.confidenceAfter} > before ${item.confidenceBefore}`);
  assert.ok(item.points > 0);
});

test('replay sign B: oversized minutes create setup-violated; after is no better than before and the card is still reported', async () => {
  // 15 h of changeover into a 7 h gap: setup-violated replaces the uncovered-pair error. (The old utilisation penalty
  // for the setup hours pushing Wednesday over capacity is gone: the overload alert counts run time only.)
  const f = fixture({ tasks: [orderTask('t1', 'A', 8, 9), orderTask('t2', 'B', 16, 17)], masterPlant: policy(900) });
  let replayAlerts = [];
  const spy = async (b, v) => { const r = runLeverageBatchSync(b, v); replayAlerts = r[0].alerts; return r; };
  const [item] = byFamily(await analyzeLeverage(f.input, spy), 'setup-pair');
  assert.ok(replayAlerts.some(a => a.type === 'setup-violated'), 'the oversized row creates a setup-violated alert');
  assert.ok(!replayAlerts.some(a => a.type === 'setup-uncovered' && a.pairKey === PAIR_AB));
  assert.equal(item.method, 'replay');
  assert.equal(item.assumedMinutes, 900);
  assert.ok(item.confidenceAfter <= item.confidenceBefore, `after ${item.confidenceAfter} <= before ${item.confidenceBefore}`);
  assert.ok(item.points > 0, 'the item is reported with its points even when the replay is worse');
});

test('the replay variant carries a setup observation without the covered pair', async () => {
  const f = fixture({ tasks: [orderTask('t1', 'A', 8, 9), orderTask('t2', 'B', 10, 11)], masterPlant: policy(15) });
  const runner = fakeRunner();
  await analyzeLeverage(f.input, runner);
  assert.equal(runner.calls.length, 1);
  const [{ base, variants }] = runner.calls;
  assert.equal(variants.length, 1);
  assert.ok(!variants[0].setup.diagnostics.some(d => d.type === 'setup-uncovered'));
  assert.equal(base.days, 14);
  assert.equal(base.startMs, new Date(2026, 9, 20).getTime());
  assert.deepEqual(base.dismissed, []);
});

test('replayCap replays the biggest pairs first and flags the rest capped', async () => {
  const tasks = [orderTask('t1', 'A', 8, 9), orderTask('t2', 'B', 10, 11), orderTask('t3', 'C', 12, 13), orderTask('t4', 'D', 14, 15)];
  const f = fixture({ tasks, masterPlant: policy(10), replayCap: 2 });
  const grouped = byFamily(groupLeverage(f.input), 'setup-pair');
  assert.equal(grouped.length, 3);
  const runner = fakeRunner();
  const out = byFamily(await analyzeLeverage(f.input, runner), 'setup-pair');
  assert.equal(runner.calls[0].variants.length, 2);
  assert.equal(out.filter(i => i.method === 'replay').length, 2);
  const capped = out.filter(i => i.capped);
  assert.equal(capped.length, 1);
  assert.equal(capped[0].method, 'removal');
  assert.ok(!out.filter(i => i.method === 'replay').some(i => i.capped));
});

test('the abort signal is passed through analyzeLeverage and replayWithMinutes (and omitted when absent)', async () => {
  const f = fixture({ tasks: [orderTask('t1', 'A', 8, 9), orderTask('t2', 'B', 10, 11)], masterPlant: policy(15) });
  const seen = [];
  const runner = async (b, v, o) => { seen.push(o); return v.map(x => ({ key: x.key, alerts: [], matrix: {} })); };
  const ctl = new AbortController();
  await analyzeLeverage(f.input, runner, undefined, { signal: ctl.signal });
  assert.equal(seen[0].signal, ctl.signal);
  await analyzeLeverage(f.input, runner);
  assert.equal(seen[1], undefined);
  const g = fixture({ tasks: [orderTask('t1', 'A', 8, 9), orderTask('t2', 'B', 10, 11)], masterPlant: null });
  const [item] = byFamily(groupLeverage(g.input), 'setup-pair');
  await replayWithMinutes(g.input, item, 20, runner, { signal: ctl.signal });
  assert.equal(seen[2].signal, ctl.signal);
  await replayWithMinutes(g.input, item, 20, runner);
  assert.equal(seen[3], undefined);
});

test('replayWithMinutes replays one pair with user minutes', async () => {
  const f = fixture({ tasks: [orderTask('t1', 'A', 8, 9), orderTask('t2', 'B', 10, 11)], masterPlant: null });
  const [item] = byFamily(groupLeverage(f.input), 'setup-pair');
  assert.equal(item.requiresMinutes, true);
  const up = await replayWithMinutes(f.input, item, 20, f.runner);
  assert.equal(up.method, 'replay');
  assert.equal(up.minutesSource, 'user');
  assert.equal(up.assumedMinutes, 20);
  assert.ok(!up.requiresMinutes);
  assert.ok(up.confidenceAfter > up.confidenceBefore);
});

test('fractional minutes are rounded up: plant default 7.5 places an 8 min row that resolves covered', async () => {
  const f = fixture({ tasks: [orderTask('t1', 'A', 8, 9), orderTask('t2', 'B', 10, 11)], masterPlant: policy(7.5) });
  const [grouped] = byFamily(groupLeverage(f.input), 'setup-pair');
  assert.equal(grouped.assumedMinutes, 8);
  const runner = fakeRunner();
  const [item] = byFamily(await analyzeLeverage(f.input, runner), 'setup-pair');
  assert.equal(item.assumedMinutes, 8);
  assert.ok(!runner.calls[0].variants[0].setup.diagnostics.some(d => d.type === 'setup-uncovered'), 'the pair resolved covered');
  const real = byFamily(await analyzeLeverage(f.input, f.runner), 'setup-pair')[0];
  assert.ok(real.confidenceAfter > real.confidenceBefore, 'replay is not a no-op');
});

test('replayWithMinutes rounds up and rejects non-positive / non-finite minutes', async () => {
  const f = fixture({ tasks: [orderTask('t1', 'A', 8, 9), orderTask('t2', 'B', 10, 11)], masterPlant: null });
  const [item] = byFamily(groupLeverage(f.input), 'setup-pair');
  const up = await replayWithMinutes(f.input, item, 7.5, f.runner);
  assert.equal(up.assumedMinutes, 8);
  assert.equal(up.method, 'replay');
  assert.ok(up.confidenceAfter > up.confidenceBefore);
  for (const bad of [0, -3, NaN, Infinity]) {
    const runner = fakeRunner();
    const out = await replayWithMinutes(f.input, item, bad, runner);
    assert.equal(out.requiresMinutes, true);
    assert.equal(out.method, 'removal');
    assert.equal(runner.calls.length, 0);
  }
});

test('parsePairKey survives a value containing "]->" and skips malformed keys', () => {
  const key = '[["colorWheel","A]->X"]]->[["colorWheel","B"]]';
  const p = parsePairKey(key);
  assert.deepEqual(p.from, [{ fieldKey: 'colorWheel', value: 'A]->X' }]);
  assert.deepEqual(p.to, [{ fieldKey: 'colorWheel', value: 'B' }]);
  assert.equal(parsePairKey('[["colorWheel","A"]]->[["colorWheel","B]->'), null);
  assert.equal(parsePairKey(']->]->'), null);
});

// ---- calendar days -------------------------------------------------------------------------------

test('calendar-day groups closed/blackout/firmed-closed by line+day; orders come from the matrix for closed', () => {
  const matrix = { L1: { [dk(2)]: { scheduled: 3, effectiveCapacity: 12, tasks: ['t3', { id: 't4' }] } } };
  const alerts = [
    al('c1', 'closed', 'err', 2, { time: atDay(2, 12) }),
    al('b1', 'blackout', 'err', 2, { taskId: 't1', time: atDay(2, 9) }),
    al('f1', 'firmed-closed', 'warn', 2, { taskId: 't2', time: atDay(2, 15) }),
    al('c2', 'closed', 'err', 2, { line: 'L2' }),
    al('c3', 'closed', 'err', 3),
  ];
  const items = byFamily(groupLeverage(mkInput({ alerts, baselineMatrix: matrix })), 'calendar-day');
  assert.equal(items.length, 3);
  const main = items.find(i => i.key.includes('L1') && i.key.includes(dk(2)));
  assert.deepEqual(main.alertIds.sort(), ['b1', 'c1', 'f1']);
  assert.deepEqual(main.orderIds.sort(), ['t1', 't2', 't3', 't4']);
  assert.deepEqual(main.action, { kind: 'calendar-day', line: 'L1', dayKey: dk(2), fixableAlertIds: ['b1'] });
  assert.equal(main.titleVars.line, 'L1');
  assert.equal(main.method, 'removal');
});

// ---- routing gaps --------------------------------------------------------------------------------

test('routing-gap groups by planning_reason.step: machine, material, material|pv, single, unknown', () => {
  const task = (id, step, material, pv, line = 'L1') => ({
    id, MACHINE: line, MATERIAL_NUMBER: material, PRODUCTION_VERSION: pv, planning_status: 'needs_planning',
    planning_reason: step === undefined ? null : { code: 'runtime_unknown', step, message: 'm' },
  });
  const tasksById = Object.fromEntries([
    task('w1', 'workcenter_unmapped', 'M1', '0001', 'L1'), task('w2', 'workcenter_unmapped', 'M2', '0002', 'L1'), task('w3', 'workcenter_unmapped', 'M3', '0003', 'L2'),
    task('p1', 'pv_missing', 'M5', ''), task('p2', 'pv_missing', 'M5', ''), task('p3', 'pv_missing', 'M6', ''),
    task('r1', 'no_routing', 'M7', '0001'), task('r2', 'no_routing', 'M7', '0001'), task('r3', 'pv_expired', 'M7', '0001'), task('r4', 'no_routing', 'M7', '0002'),
    task('m1', 'pv_workcenter_mismatch', 'M11', '0001'), task('m2', 'pv_workcenter_mismatch', 'M11', '0001'),
    task('n1', 'no_machine', 'M8', '0001'), task('n2', 'no_machine', 'M9', '0001'),
    task('u1', undefined, 'M10', '0001'), task('u2', 'something_new', 'M10', '0002'),
  ].map(t => [t.id, t]));
  const alerts = Object.keys(tasksById).map(id => al(`ru-${id}`, 'runtime-unknown', 'err', 0, { taskId: id, line: tasksById[id].MACHINE }));
  const items = byFamily(groupLeverage(mkInput({ alerts, tasksById })), 'routing-gap');
  const find = pred => items.find(pred);
  const wcL1 = find(i => i.action.step === 'workcenter_unmapped' && i.action.machine === 'L1');
  assert.deepEqual(wcL1.orderIds.sort(), ['w1', 'w2']);
  assert.equal(wcL1.adminOnly, true, 'Work Centers writes are require_admin');
  assert.ok(find(i => i.action.step === 'workcenter_unmapped' && i.action.machine === 'L2'));
  assert.deepEqual(find(i => i.action.step === 'pv_missing' && i.action.material === 'M5').orderIds.sort(), ['p1', 'p2']);
  assert.equal(items.filter(i => i.action.step === 'pv_missing').length, 2);
  const noRoutingPv1 = find(i => i.action.step === 'no_routing' && i.action.pv === '0001');
  assert.deepEqual(noRoutingPv1.orderIds.sort(), ['r1', 'r2']);
  assert.equal(noRoutingPv1.action.material, 'M7');
  assert.equal(items.filter(i => i.action.material === 'M7').length, 3, 'step is part of the key: no_routing 0001, pv_expired 0001, no_routing 0002');
  assert.deepEqual(find(i => i.action.step === 'pv_workcenter_mismatch' && i.action.material === 'M11').orderIds.sort(), ['m1', 'm2'], 'a PV work-center mismatch groups like a routing upload gap');
  const noMachine = items.filter(i => i.action.step === 'no_machine');
  assert.equal(noMachine.length, 1);
  assert.deepEqual(noMachine[0].orderIds.sort(), ['n1', 'n2']);
  assert.equal(noMachine[0].adminOnly, false, 'picking a machine is an order edit, not admin');
  const unknown = items.filter(i => i.titleKey.endsWith('.unknown'));
  assert.equal(unknown.length, 1, 'missing/unrecognised step groups by material');
  assert.deepEqual(unknown[0].orderIds.sort(), ['u1', 'u2']);
  assert.ok(unknown.every(i => i.action.kind === 'routing-gap' && i.adminOnly === true));
  assert.ok(items.every(i => i.method === 'removal'));
});

test('routing-gap with a task missing from tasksById falls into the unknown-step group', () => {
  const alerts = [al('ru-x', 'runtime-unknown', 'err', 0, { taskId: 'ghost' })];
  const items = byFamily(groupLeverage(mkInput({ alerts })), 'routing-gap');
  assert.equal(items.length, 1, 'still grouped (missing task => unknown step, empty material)');
  assert.deepEqual(items[0].orderIds, ['ghost']);
});

// ---- machine state -------------------------------------------------------------------------------

test('machine-state groups initial-state-unknown + current-state-diverged by line', () => {
  const alerts = [
    al('i1', 'initial-state-unknown', 'warn', 1, { taskId: 'a' }),
    al('d1', 'current-state-diverged', 'warn', 1, { taskId: 'b' }),
    al('i2', 'initial-state-unknown', 'warn', 1, { line: 'L2', taskId: 'c' }),
  ];
  const items = byFamily(groupLeverage(mkInput({ alerts, lines: new Set(['L1', 'L2']) })), 'machine-state');
  assert.equal(items.length, 2);
  const l1 = items.find(i => i.action.line === 'L1');
  assert.deepEqual(l1.alertIds.sort(), ['d1', 'i1']);
  assert.deepEqual(l1.action, { kind: 'machine-state', line: 'L1' });
  assert.deepEqual(l1.lines, ['L1']);
});

// ---- optimize windows ----------------------------------------------------------------------------

test('optimize-window merges adjacent conflict days per line; method none; headroom from the matrix', () => {
  const matrix = { L1: {
    [dk(1)]: { scheduled: 8, effectiveCapacity: 12 }, [dk(2)]: { scheduled: 14, effectiveCapacity: 12 },
    [dk(3)]: { scheduled: 6, effectiveCapacity: 12 }, [dk(5)]: { scheduled: 2, effectiveCapacity: 12 },
    [dk(4)]: { scheduled: 0, effectiveCapacity: 12 },
  } };
  const alerts = [
    al('ov1', 'overload', 'err', 1), al('o2', 'overlap', 'err', 2, { taskId: 'a', peerId: 'b' }), al('l3', 'late', 'warn', 3, { taskId: 'c' }),
    al('sv5', 'setup-violated', 'err', 5, { taskId: 'd' }),
    al('ov-L2', 'overload', 'err', 2, { line: 'L2' }),
  ];
  const items = byFamily(groupLeverage(mkInput({ alerts, baselineMatrix: matrix, lines: new Set(['L1', 'L2']) })), 'optimize-window');
  assert.equal(items.length, 3);
  const w1 = items.find(i => i.action.line === 'L1' && i.action.startDate === dk(1));
  assert.equal(w1.action.endDate, dk(3));
  assert.deepEqual(w1.alertIds.sort(), ['l3', 'o2', 'ov1']);
  assert.equal(w1.method, 'none');
  assert.equal(w1.confidenceAfter, null);
  assert.equal(w1.headroomHours, (12 - 8) + (12 - 14) + (12 - 6));
  assert.ok(w1.headroomHours > 0);
  assert.deepEqual(w1.titleVars, { line: 'L1', from: dk(1), to: dk(3), n: 3 });
  const w2 = items.find(i => i.action.line === 'L1' && i.action.startDate === dk(5));
  assert.equal(w2.action.endDate, dk(5));
  assert.equal(w2.headroomHours, 10);
  assert.equal(items.filter(i => i.action.line === 'L2').length, 1);
});

test('optimize-window headroom goes negative on a saturated window', () => {
  const matrix = { L1: { [dk(1)]: { scheduled: 20, effectiveCapacity: 12 }, [dk(2)]: { scheduled: 15, effectiveCapacity: 12 } } };
  const alerts = [al('a', 'overload', 'err', 1), al('b', 'overload', 'err', 2)];
  const [w] = byFamily(groupLeverage(mkInput({ alerts, baselineMatrix: matrix })), 'optimize-window');
  assert.equal(w.headroomHours, -11);
});

test('optimize-window caps a window at 14 days', () => {
  const alerts = Array.from({ length: 16 }, (_, i) => al(`ov${i}`, 'overload', 'err', 1 + i));
  const items = byFamily(groupLeverage(mkInput({ alerts })), 'optimize-window')
    .sort((a, b) => a.action.startDate.localeCompare(b.action.startDate));
  assert.equal(items.length, 2);
  assert.equal(items[0].action.startDate, dk(1));
  assert.equal(items[0].action.endDate, dk(14));
  assert.equal(items[1].action.startDate, dk(15));
  assert.equal(items[1].action.endDate, dk(16));
});

test('optimize-window orders for an overload come from the matrix row', () => {
  const matrix = { L1: { [dk(1)]: { scheduled: 20, effectiveCapacity: 12, tasks: ['m1', 'm2'] } } };
  const [w] = byFamily(groupLeverage(mkInput({ alerts: [al('ov', 'overload', 'err', 1)], baselineMatrix: matrix })), 'optimize-window');
  assert.deepEqual(w.orderIds.sort(), ['m1', 'm2']);
});

// ---- sort + purity -------------------------------------------------------------------------------

test('items sort by points desc, then orders desc', () => {
  const alerts = [
    al('big', 'tool-conflict', 'err', 1, { msgVars: { tool: 'BIG' }, taskId: 'a', peerId: 'b' }),
    al('big2', 'tool-conflict', 'err', 1, { msgVars: { tool: 'BIG' }, taskId: 'a2', peerId: 'b2' }),
    al('few', 'tool-conflict', 'err', 1, { msgVars: { tool: 'FEW' }, taskId: 'c', peerId: 'd' }),
    al('tie-many', 'initial-state-unknown', 'err', 1, { taskId: 'e' }),
    al('tie-two', 'tool-conflict', 'err', 1, { msgVars: { tool: 'TWO' }, taskId: 'g' }),
    al('np1', 'needs_planning', 'warn', 1, { taskId: 'q1' }),
    al('np2', 'needs_planning', 'warn', 2, { taskId: 'q2' }),
  ];
  const items = groupLeverage(mkInput({ alerts }));
  for (let i = 1; i < items.length; i++) {
    const p = items[i - 1], c = items[i];
    assert.ok(p.points > c.points || (p.points === c.points && p.orderIds.length >= c.orderIds.length), `${p.key} before ${c.key}`);
  }
  assert.equal(items[0].action.tool, 'BIG');
  const equalPoints = items.filter(i => i.points === items[1].points);
  assert.ok(equalPoints.length >= 2);
  assert.equal(byFamily(items, 'needs-planning').length, 1, 'the needs-planning card is ranked among the others');
});

// ---- needs-planning family ------------------------------------------------------------------------

const npTasks = {
  q1: { id: 'q1', RUN_TIME: 1.04 }, q2: { id: 'q2', RUN_TIME: '2.3' }, q3: { id: 'q3', RUN_TIME: 'abc' },
  q4: { id: 'q4', RUN_TIME: -5 }, q5: { id: 'q5' },
};

test('needs-planning: one plant-wide item; hours sum RUN_TIME, unknown counts 0, one decimal', () => {
  const alerts = [
    al('n1', 'needs_planning', 'warn', 1, { taskId: 'q1', line: 'L1' }),
    al('n2', 'needs_planning', 'warn', 2, { taskId: 'q2', line: 'L2' }),
    al('n3', 'needs_planning', 'warn', 3, { taskId: 'q3', line: '' }),
    al('n4', 'needs_planning', 'warn', 3, { taskId: 'q4' }),
    al('n5', 'needs_planning', 'warn', 3, { taskId: 'q5' }),
    al('n6', 'needs_planning', 'warn', 3, { taskId: 'gone' }),
  ];
  const items = byFamily(groupLeverage(mkInput({ alerts, tasksById: npTasks })), 'needs-planning');
  assert.equal(items.length, 1, 'one bucket across lines');
  const [it] = items;
  assert.equal(it.key, 'needs-planning');
  assert.equal(it.titleKey, 'leverage.title.needs-planning');
  assert.deepEqual(it.titleVars, { n: 6, h: 3.3 }, '1.04 + 2.3 + 0 for unknown, negative and missing, to one decimal');
  assert.deepEqual(it.alertIds, ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
  assert.deepEqual(it.orderIds.sort(), ['gone', 'q1', 'q2', 'q3', 'q4', 'q5']);
  assert.deepEqual(it.action, { kind: 'needs-planning', alertIds: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'] });
  assert.equal(it.unplacedHours, 3.3);
});

test('needs-planning: method none, confidenceAfter null, never replayed', async () => {
  const alerts = [al('n1', 'needs_planning', 'warn', 1, { taskId: 'q1' })];
  const input = mkInput({ alerts, tasksById: npTasks });
  const [it] = byFamily(groupLeverage(input), 'needs-planning');
  assert.equal(it.method, 'none');
  assert.equal(it.confidenceAfter, null);
  assert.equal(it.confidenceBefore, score(alerts, {}));
  const runner = fakeRunner();
  const out = await analyzeLeverage(input, runner);
  assert.equal(runner.calls.length, 0, 'no replay batch when the only card is needs-planning');
  const [after] = byFamily(out, 'needs-planning');
  assert.equal(after.method, 'none');
  assert.equal(after.confidenceAfter, null);
  assert.equal(after.capped, undefined);
  // Alongside a replayable setup pair, the batch carries only the pair.
  const ss = setupSnapshot();
  const withPair = mkInput({
    alerts: [...alerts, al('s1', 'setup-uncovered', 'warn', 1, { pairKey: PAIR_AB, taskId: 'x' })], tasksById: npTasks,
    setupSnapshot: ss, masterPlant: policy(10),
  });
  const runner2 = fakeRunner();
  await analyzeLeverage(withPair, runner2);
  for (const c of runner2.calls) for (const v of c.variants) assert.ok(v.key.startsWith('setup-pair:'), v.key);
});

test('needs-planning: an overdue queued order scores as due now through its due; beyond-window scores 0', () => {
  const overdue = al('o1', 'needs_planning', 'err', -2, { taskId: 'q1', due: atDay(-2) });
  const beyond = al('b1', 'needs_planning', 'err', 30, { taskId: 'q2', due: atDay(30) });
  const soon = al('s1', 'needs_planning', 'warn', 1, { taskId: 'q3', due: atDay(1) });
  const end = new Date(plantNow.getTime() + HM * 60000);
  const asNow = Core.alertPoints(overdue, plantNow, end);
  assert.equal(asNow, 7.5, 'the core scores a past-due alert as due now (5 x 1.5)');

  const [only] = byFamily(groupLeverage(mkInput({ alerts: [overdue], tasksById: npTasks })), 'needs-planning');
  assert.equal(only.points, asNow);
  assert.equal(only.outsideConfidenceWindowCount, 0, 'an overdue alert is inside the window');

  const [far] = byFamily(groupLeverage(mkInput({ alerts: [beyond], tasksById: npTasks })), 'needs-planning');
  assert.equal(far.points, 0);
  assert.equal(far.outsideConfidenceWindowCount, 1);

  const [mix] = byFamily(groupLeverage(mkInput({ alerts: [overdue, beyond, soon], tasksById: npTasks })), 'needs-planning');
  assert.equal(mix.points, asNow + Core.alertPoints(soon, plantNow, end));
  assert.equal(mix.outsideConfidenceWindowCount, 1);
  assert.ok(overdue.time < plantNow, 'the input alert is not mutated');
});

test('needs-planning: absent when no needs_planning alert', () => {
  const alerts = [al('t1', 'tool-conflict', 'err', 1, { msgVars: { tool: 'T9' }, taskId: 'a', peerId: 'b' })];
  assert.equal(byFamily(groupLeverage(mkInput({ alerts, tasksById: npTasks })), 'needs-planning').length, 0);
  assert.equal(groupLeverage(mkInput({ alerts: [], tasksById: npTasks })).length, 0);
});

test('groupLeverage does not mutate its input and is fast on a large plant', () => {
  const alerts = [];
  const matrix = {};
  for (let l = 0; l < 70; l++) {
    const line = `L${l}`;
    matrix[line] = {};
    for (let d = 0; d < 14; d++) matrix[line][dk(d)] = { scheduled: 14, effectiveCapacity: 12, tasks: [`t${l}-${d}`] };
    for (let d = 0; d < 14; d += 2) alerts.push(al(`ov-${line}-${d}`, 'overload', 'err', d, { line }));
    for (let d = 0; d < 14; d += 3) alerts.push(al(`cl-${line}-${d}`, 'closed', 'err', d, { line }));
    alerts.push(al(`tc-${line}`, 'tool-conflict', 'err', 2, { line, msgVars: { tool: `T${l % 9}` }, taskId: `a${l}`, peerId: `b${l}` }));
  }
  const input = mkInput({ alerts, baselineMatrix: matrix, lines: new Set(Object.keys(matrix)) });
  const frozen = JSON.stringify(alerts.length);
  /* Warm once, then take the best of 3: a single cold run under the parallel suite flakes past 50 ms on load alone. */
  let items = groupLeverage(input);
  let ms = Infinity;
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    items = groupLeverage(input);
    ms = Math.min(ms, performance.now() - t0);
  }
  assert.ok(items.length > 100);
  assert.ok(ms < 50, `groupLeverage took ${ms.toFixed(1)} ms`);
  for (const item of items.filter(i => i.method === 'removal').slice(0, 40)) {
    const gone = new Set(item.alertIds);
    assert.equal(item.confidenceAfter, score(alerts.filter(a => !gone.has(a.id)), matrix), item.key);
  }
  assert.equal(JSON.stringify(input.alerts.length), frozen);
});

test('analyzeLeverage with caller-supplied groups equals the default path and leaves those groups unmutated', async () => {
  const tasks = [orderTask('t1', 'A', 8, 9), orderTask('t2', 'B', 10, 11)];
  const f = fixture({ tasks, masterPlant: policy(15) });
  const groups = groupLeverage(f.input);
  const frozen = JSON.stringify(groups);
  const viaGroups = await analyzeLeverage(f.input, f.runner, groups);
  const plain = await analyzeLeverage(f.input, f.runner);
  assert.equal(JSON.stringify(viaGroups), JSON.stringify(plain));
  assert.equal(byFamily(viaGroups, 'setup-pair')[0].method, 'replay');
  assert.equal(JSON.stringify(groups), frozen, 'the painted removal-phase items are not mutated by the replay');
});

test('setupTasks (the plant rows) replays identically to the all-tasks fallback', async () => {
  const tasks = [orderTask('t1', 'A', 8, 9), orderTask('t2', 'B', 10, 11)];
  const other = { ...orderTask('x1', 'A', 8, 9), PLANT: 'OTHER', plant: 'OTHER', MACHINE: 'L-OTHER' };
  const f = fixture({ tasks, masterPlant: policy(15) });
  const withOther = { ...f.input, tasksById: { ...f.input.tasksById, x1: other } };
  const fallback = await analyzeLeverage(withOther, f.runner);
  const scoped = await analyzeLeverage({ ...withOther, setupTasks: tasks }, f.runner);
  assert.equal(JSON.stringify(scoped), JSON.stringify(fallback));
});

// ---- Tool Inventory (Wave 2): a count-aware conflict names many orders ------------------------------------

test('tool card: n counts ORDERS, the order set is the pusher plus every holder, lines come from the holders', () => {
  const alerts = [
    al('x1', 'tool-conflict', 'err', 1, { tool: 'T1', msgVars: { tool: 'T1' }, taskId: 'd', peerId: 'a', peerIds: ['a', 'b', 'c'], line: 'L4' }),
    al('x2', 'tool-conflict', 'err', 2, { tool: 'T1', msgVars: { tool: 'T1' }, taskId: 'e', peerId: 'a', peerIds: ['a', 'b', 'c', 'd'], line: 'L5' }),
  ];
  const tasksById = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((id, i) => [id, { id, MACHINE: `M${i + 1}` }]));
  const [item] = byFamily(groupLeverage(mkInput({ alerts, tasksById })), 'tool');
  assert.deepEqual(item.orderIds.slice().sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(item.titleVars.n, 5, 'n is the number of orders, not the number of alerts (2)');
  assert.deepEqual(item.lines.slice().sort(), ['L4', 'L5', 'M1', 'M2', 'M3', 'M4', 'M5']);
  assert.equal(item.action.kind, 'tool');
});
