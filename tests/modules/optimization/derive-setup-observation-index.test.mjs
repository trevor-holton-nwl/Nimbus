// deriveSetupObservation resolves through a memoised buildSetupResolutionIndex.
// Every case below must produce exactly what the linear (unindexed) reference
// path produces, and the indexed path must not rescan the row arrays per order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  deriveSetupObservation, deriveSetupObservationUnindexed, setupResolutionIndexFor,
} from '../../../frontend/optimization/engine.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');

const PLANT = 'P-IDX';
const LINE = 'L-IDX';
const state = (color, tool) => (tool === undefined
  ? [{ fieldKey: 'colorWheel', value: color }]
  : [{ fieldKey: 'colorWheel', value: color }, { fieldKey: 'prt01', value: tool }]);
const at = (h, m = 0) => new Date(2026, 7, 3, h, m, 0);

function definition(extra = {}) {
  return { plant: PLANT, fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true, ...extra };
}
function snapshot({ def = definition(), plantRows = [], machineRows = [], overrides = [], machineStates = [] } = {}) {
  return {
    plant: PLANT, definition: def, plant_active: true,
    plant_rows: plantRows, machine_rows: machineRows, machine_states: machineStates, overrides,
  };
}
const row = (from, to, min, extra = {}) => ({
  machine: '', signature_version: 1, from_key: state(from), to_key: state(to), setup_min: min, ...extra,
});
function order(id, color, h, extra = {}) {
  return {
    id, PLANT, MACHINE: LINE, COLOR: color, RUN_TIME: 1,
    start_date: at(h), end_date: at(h + 1), ...extra,
  };
}
const chain = (...colors) => colors.map((color, i) => order(`o${i}`, color, 8 + i * 2));

function assertParity(setup, tasks, lines = new Set([LINE])) {
  const indexed = deriveSetupObservation(setup, tasks, lines);
  const reference = deriveSetupObservationUnindexed(setup, tasks, lines);
  assert.equal(JSON.stringify(indexed), JSON.stringify(reference));
  return indexed;
}

test('line row beats a plant row; both resolve like the linear scan', () => {
  const observation = assertParity(snapshot({
    plantRows: [row('RED', 'BLUE', 30)],
    machineRows: [row('RED', 'BLUE', 45, { machine: LINE })],
    machineStates: [{ machine: LINE, state_key: state('RED'), signature_version: 1, source: 'manual', reason: 't' }],
  }), chain('RED', 'BLUE'));
  assert.equal(observation.intervals.find(i => i.successorOrderId === 'o1').requiredMinutes, 45);
});

test('plant row, implicit zero and uncovered', () => {
  const observation = assertParity(snapshot({
    plantRows: [row('RED', 'BLUE', 30)],
    machineStates: [{ machine: LINE, state_key: state('RED'), signature_version: 1, source: 'manual', reason: 't' }],
  }), chain('RED', 'BLUE', 'BLUE', 'GREEN'));
  assert.equal(observation.intervals.find(i => i.successorOrderId === 'o1').requiredMinutes, 30);
  assert.ok(observation.diagnostics.some(d => d.type === 'setup-no-change'));
  assert.ok(observation.diagnostics.some(d => d.type === 'setup-uncovered'));
});

test('occurrence override wins and an orphaned override is reported identically', () => {
  const overrides = [
    {
      id: 'ov1', machine: LINE, signature_version: 1, predecessor_order_id: 'o0', successor_order_id: 'o1',
      predecessor_state_key: state('RED'), successor_state_key: state('BLUE'), standard_min: 30, remaining_min: 10,
      status: 'active', reason: 'r',
    },
    {
      id: 'ov2', machine: LINE, signature_version: 1, predecessor_order_id: 'gone', successor_order_id: 'o2',
      predecessor_state_key: state('BLUE'), successor_state_key: state('GREEN'), standard_min: 30, remaining_min: 5,
      status: 'active', reason: 'r',
    },
  ];
  const observation = assertParity(snapshot({
    plantRows: [row('RED', 'BLUE', 30), row('BLUE', 'GREEN', 20)],
    machineStates: [{ machine: LINE, state_key: state('RED'), signature_version: 1, source: 'manual', reason: 't' }],
    overrides,
  }), chain('RED', 'BLUE', 'GREEN'));
  assert.equal(observation.intervals.find(i => i.successorOrderId === 'o1').requiredMinutes, 10);
  assert.ok(observation.diagnostics.some(d => d.type === 'override-inactive'));
});

test('rows with a mismatched signature version or invalid minutes are ignored', () => {
  for (const bad of [{ signature_version: 2 }, { setup_min: -5 }, { setup_min: 1.5 }, { setup_min: Number.NaN }]) {
    const observation = assertParity(snapshot({
      plantRows: [row('RED', 'BLUE', 30, bad)],
      machineStates: [{ machine: LINE, state_key: state('RED'), signature_version: 1, source: 'manual', reason: 't' }],
    }), chain('RED', 'BLUE'));
    assert.ok(observation.diagnostics.some(d => d.type === 'setup-uncovered'), JSON.stringify(bad));
  }
});

test('duplicate rows: the first matching row wins on both paths', () => {
  const observation = assertParity(snapshot({
    plantRows: [row('RED', 'BLUE', 11), row('RED', 'BLUE', 99)],
    machineRows: [row('RED', 'GREEN', 7, { machine: LINE }), row('RED', 'GREEN', 70, { machine: LINE })],
    machineStates: [{ machine: LINE, state_key: state('RED'), signature_version: 1, source: 'manual', reason: 't' }],
  }), chain('RED', 'BLUE', 'RED', 'GREEN'));
  assert.equal(observation.intervals.find(i => i.successorOrderId === 'o1').requiredMinutes, 11);
  assert.equal(observation.intervals.find(i => i.successorOrderId === 'o3').requiredMinutes, 7);
});

test('strict_blanks and non-strict definitions agree with the linear path', () => {
  const tasks = [order('o0', 'RED', 8), order('o1', '', 10), order('o2', 'BLUE', 12)];
  for (const strict of [true, false]) {
    assertParity(snapshot({
      def: definition({ strict_blanks: strict }),
      plantRows: [row('RED', '', 5), row('', 'BLUE', 6), row('RED', 'BLUE', 9)],
      machineStates: [{ machine: LINE, state_key: state('RED'), signature_version: 1, source: 'manual', reason: 't' }],
    }), tasks);
  }
});

test('split orders (scheduleSegments) agree with the linear path', () => {
  const split = order('o1', 'BLUE', 10, {
    start_date: at(10), end_date: at(15),
    scheduleSegments: [{ start: at(10), end: at(11) }, { start: at(13), end: at(15) }],
  });
  assertParity(snapshot({
    plantRows: [row('RED', 'BLUE', 30), row('BLUE', 'GREEN', 20)],
    machineStates: [{ machine: LINE, state_key: state('RED'), signature_version: 1, source: 'manual', reason: 't' }],
  }), [order('o0', 'RED', 8), split, order('o2', 'GREEN', 16)]);
});

test('multi-field signature with several lines agrees with the linear path', () => {
  const def = definition({ fields: ['colorWheel', 'prt01'] });
  const tasks = [];
  for (const line of ['L-A', 'L-B']) {
    ['RED', 'BLUE', 'RED', 'GREEN'].forEach((color, i) => tasks.push({
      ...order(`${line}-${i}`, color, 8 + i * 2), MACHINE: line, PRT_01: i % 2 ? 'T1' : 'T2',
    }));
  }
  assertParity(snapshot({
    def,
    plantRows: [{ machine: '', signature_version: 1, from_key: state('RED', 'T2'), to_key: state('BLUE', 'T1'), setup_min: 25 }],
    machineRows: [{ machine: 'L-B', signature_version: 1, from_key: state('RED', 'T2'), to_key: state('BLUE', 'T1'), setup_min: 35 }],
  }), tasks, new Set(['L-A', 'L-B']));
});

test('the index is memoised per snapshot object and rebuilt when its rows change', () => {
  const setup = snapshot({ plantRows: [row('RED', 'BLUE', 30)] });
  const first = setupResolutionIndexFor(setup);
  assert.equal(setupResolutionIndexFor(setup), first);
  setup.plant_rows = [...setup.plant_rows, row('BLUE', 'RED', 5)];
  const second = setupResolutionIndexFor(setup);
  assert.notEqual(second, first);
  assert.equal(second.plantRows.size, 2);
  setup.overrides.push({
    id: 'x', machine: LINE, signature_version: 1, predecessor_order_id: null, successor_order_id: 'o0',
    predecessor_state_key: state('RED'), successor_state_key: state('RED'), standard_min: 1, remaining_min: 1,
    status: 'active', reason: '',
  });
  assert.notEqual(setupResolutionIndexFor(setup), second, 'an in-place length change must not reuse a stale index');
});

test('counted: derivation reads each row array a bounded number of times, not once per order', () => {
  const states = Array.from({ length: 60 }, (_, i) => `C${i}`);
  const plantRows = [];
  for (const from of states) for (const to of states) if (from !== to) plantRows.push(row(from, to, 1 + (from.length + to.length) % 7));
  const reads = { plant: 0 };
  const watched = new Proxy(plantRows, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads.plant++;
      return Reflect.get(target, key, receiver);
    },
  });
  const tasks = [];
  for (let i = 0; i < 600; i++) tasks.push({ ...order(`t${i}`, states[(i * 7) % 60], 0), start_date: new Date(2026, 7, 3, 0, i * 10), end_date: new Date(2026, 7, 3, 0, i * 10 + 5) });
  const setup = snapshot({ plantRows: watched });
  const observation = deriveSetupObservation(setup, tasks, new Set([LINE]));
  assert.ok(observation.intervals.length > 100);
  // One build pass (each row once) plus the staleness guard's length reads; the old path read ~rows per order.
  assert.ok(reads.plant <= plantRows.length * 2, `plant row reads ${reads.plant} must stay O(rows), not O(rows x orders)`);
});

test('override build-time filters (status, signature version, minutes, initial state, bucket order) match the linear path', () => {
  const ov = (id, extra = {}) => ({
    id, machine: LINE, signature_version: 1, predecessor_order_id: 'o0', successor_order_id: 'o1',
    predecessor_state_key: state('RED'), successor_state_key: state('BLUE'), standard_min: 30, remaining_min: 10,
    status: 'active', reason: 'r', ...extra,
  });
  const base = {
    plantRows: [row('RED', 'BLUE', 30)],
    machineStates: [{ machine: LINE, state_key: state('RED'), signature_version: 1, source: 'manual', reason: 't' }],
  };
  const minutesOf = observation => observation.intervals.find(i => i.successorOrderId === 'o1')?.requiredMinutes;
  // Each invalid override is ignored, so the plant row (30) resolves.
  for (const bad of [{ status: 'inactive' }, { status: 'cancelled' }, { signature_version: 2 }, { standard_min: -1 },
    { remaining_min: 2.5 }, { remaining_min: Number.NaN }]) {
    const observation = assertParity(snapshot({ ...base, overrides: [ov('bad', bad)] }), chain('RED', 'BLUE'));
    assert.equal(minutesOf(observation), 30, JSON.stringify(bad));
  }
  // Initial-state override: predecessor_order_id null, successor is the line's first order.
  const initial = ov('init', { predecessor_order_id: null, successor_order_id: 'o0', predecessor_state_key: state('RED'), successor_state_key: state('RED'), remaining_min: 7 });
  const initialObs = assertParity(snapshot({ ...base, overrides: [initial] }), chain('RED', 'BLUE'));
  assert.equal(initialObs.intervals.find(i => i.successorOrderId === 'o0')?.requiredMinutes, 7);
  // Two overrides in one bucket: the first valid one wins, on both paths.
  const first = assertParity(snapshot({ ...base, overrides: [ov('first', { remaining_min: 11 }), ov('second', { remaining_min: 22 })] }), chain('RED', 'BLUE'));
  assert.equal(minutesOf(first), 11);
  const skipped = assertParity(snapshot({ ...base, overrides: [ov('bad-first', { status: 'inactive' }), ov('good', { remaining_min: 22 })] }), chain('RED', 'BLUE'));
  assert.equal(minutesOf(skipped), 22, 'an invalid first override is skipped, the next one in the bucket wins');
});
