import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSetupResolutionIndex, resolveSetup, stateForOrder } from '../../../frontend/setup/setup-domain.mjs';

function snapshot(size, plant = 'P0', offset = 0, sparse = false) {
  const definition = { plant, fields: ['prt01', 'colorWheel'], signature_version: 1, strict_blanks: true, active: true };
  const states = Array.from({ length: size }, (_, i) => stateForOrder({ PRT_01: `TOOL ${i}`, COLOR: `COLOR ${i % 10}` }, definition));
  assert.ok(states.every(Boolean), 'use real supported signature fields and complete order-derived states');
  const plantRows = [];
  for (let from = 0; from < size; from++) {
    for (let to = 0; to < size; to++) {
      if (from === to || (sparse && (from + to) % 4 !== 1)) continue;
      plantRows.push({ plant, machine: '', signature_version: 1, from_key: states[from], to_key: states[to],
        setup_min: offset + 1 + (from * 7 + to * 3) % 119 });
    }
  }
  return { definition, states, plantRows, machineRows: [], overrides: [] };
}

// Observe input array element reads without replacing the index builder or
// resolver. Repeated scans become deterministic failures independent of CPU speed.
function observeRows(rows) {
  let reads = 0;
  const array = new Proxy(rows, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { array, reads: () => reads };
}

function observeLookups(index) {
  let reads = 0, iterations = 0;
  // Count invocations, not yielded entries: even creating an iterator is
  // observable. forEach is included because it does not create an iterator.
  const iterationMethods = new Set(['entries', 'values', 'keys', 'forEach', Symbol.iterator]);
  const observed = { ...index };
  for (const field of ['machineRows', 'plantRows', 'overrides']) {
    const map = index[field];
    observed[field] = new Proxy(map, {
      get(target, key) {
        if (key === 'get') return value => { reads++; return target.get(value); };
        if (iterationMethods.has(key)) return (...args) => { iterations++; return target[key](...args); };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  return { index: observed, reads: () => reads, iterations: () => iterations };
}

function query(data, index, from, to, machine = 'LINE 0', predecessorOrderId = 'PREDECESSOR', successorOrderId = 'SUCCESSOR') {
  return { ...data, index, machine, predecessorState: data.states[from], successorState: data.states[to],
    predecessorOrderId, successorOrderId };
}

for (const size of [100, 200]) {
  test(`${size} setup states build ${size * (size - 1)} directional edges once and resolve every edge with constant indexed work`, () => {
    const data = snapshot(size);
    const observed = observeRows(data.plantRows);
    const input = { ...data, plantRows: observed.array };
    const index = buildSetupResolutionIndex(input);
    const edgeCount = size * (size - 1);
    assert.equal(index.plantRows.size, edgeCount, 'no directional pair may be lost or merged');
    assert.ok(observed.reads() <= edgeCount, 'index construction must read each edge at most once');
    const buildReads = observed.reads();
    const measured = observeLookups(index);
    let queries = 0;
    for (let from = 0; from < size; from++) {
      for (let to = 0; to < size; to++) {
        const result = resolveSetup(query(input, measured.index, from, to));
        assert.equal(result.covered, true);
        assert.equal(result.source, from === to ? 'implicit-zero' : 'plant');
        assert.equal(result.effectiveMin, from === to ? 0 : 1 + (from * 7 + to * 3) % 119);
        assert.equal(result.standardMin, result.effectiveMin);
        queries++;
      }
    }
    assert.equal(queries, size * size);
    assert.ok(measured.reads() <= 3 * queries, 'lookup work must not grow with matrix size; fewer reads are allowed');
    assert.equal(measured.iterations(), 0, 'resolutions must not invoke index iteration methods');
    assert.equal(observed.reads(), buildReads, 'resolving all pairs must never revisit the matrix array');
    assert.notEqual(resolveSetup(query(input, index, 0, 1)).effectiveMin,
      resolveSetup(query(input, index, 1, 0)).effectiveMin, 'reverse transitions retain their own duration');
  });
}

test('two 10,000-edge sparse plant indexes preserve occurrence > line > plant precedence across 70 machines', () => {
  const plants = [snapshot(200, 'P0', 0, true), snapshot(200, 'P1', 120, true)];
  for (const [p, data] of plants.entries()) {
    assert.equal(data.plantRows.length, 10000);
    for (let i = 0; i < 70; i++) {
      const from = 2 * i, to = from + 1; // included in the sparse plant matrix
      data.machineRows.push({ plant: data.definition.plant, machine: `LINE ${i}`, signature_version: 1,
        from_key: data.states[from], to_key: data.states[to], setup_min: 30 + p });
      data.overrides.push({ id: `${data.definition.plant}-${i}`, machine: `LINE ${i}`, signature_version: 1,
        predecessor_order_id: `PRED-${i}`, successor_order_id: `SUCC-${i}`,
        predecessor_state_key: data.states[from], successor_state_key: data.states[to],
        standard_min: 30 + p, remaining_min: 10 + p, status: 'active', reason: 'Setup partly complete' });
    }
    data.index = buildSetupResolutionIndex(data);
    assert.equal(data.index.plantRows.size, 10000);
    assert.equal(data.index.machineRows.size, 70);
    assert.equal(data.index.overrides.size, 70);
  }
  // Both snapshots have identical signature versions and state values. Alternate
  // caller-owned indexes to catch any accidental module-global plant cache.
  for (let i = 0; i < 70; i++) {
    for (const [p, data] of plants.entries()) {
      const from = 2 * i, to = from + 1;
      const occurrenceInput = query(data, data.index, from, to, `LINE ${i}`, `PRED-${i}`, `SUCC-${i}`);
      const occurrence = resolveSetup(occurrenceInput);
      assert.equal(occurrence.source, 'occurrence');
      assert.equal(occurrence.effectiveMin, 10 + p);
      assert.equal(occurrence.standardMin, 30 + p);
      assert.equal(occurrence.overrideId, `${data.definition.plant}-${i}`);
      const line = resolveSetup({ ...occurrenceInput, successorOrderId: 'OTHER' });
      assert.equal(line.source, 'line');
      assert.equal(line.effectiveMin, 30 + p);
      const plant = resolveSetup({ ...occurrenceInput, machine: `LINE ${(i + 1) % 70}` });
      assert.equal(plant.source, 'plant');
      assert.equal(plant.effectiveMin, 120 * p + 1 + (from * 7 + to * 3) % 119);
      // This absent edge is directional and nonidentical, so it cannot be zero.
      const missing = resolveSetup(query(data, data.index, from, from + 2));
      assert.equal(missing.source, 'uncovered');
      assert.equal(missing.covered, false);
      assert.equal(missing.effectiveMin, null);
    }
  }
});

test('value-default resolution over 200 states (39,800 directional pairs, zero rows) stays constant-time and never iterates the index', () => {
  const size = 200;
  const data = snapshot(size);
  data.plantRows = [];
  const valueDefaults = [];
  for (let i = 0; i < size; i++) valueDefaults.push({ field_key: 'prt01', value: `TOOL ${i}`, setup_min: 5 + i % 50, signature_version: 1 });
  for (let i = 0; i < 10; i++) valueDefaults.push({ field_key: 'colorWheel', value: `COLOR ${i}`, setup_min: 3 + i, signature_version: 1 });
  data.valueDefaults = valueDefaults;
  const index = buildSetupResolutionIndex(data);
  let reads = 0, innerReads = 0, iterations = 0;
  const iterating = ['entries', 'values', 'keys', 'forEach', Symbol.iterator];
  // Observe a Map: count get() reads, count iteration-method invocations, and (for the outer
  // per-field map) hand back observed INNER maps so an inner scan is detected too.
  const observeMap = (map, wrapChildren) => new Proxy(map, {
    get(target, key) {
      if (key === 'get') return v => {
        if (wrapChildren) reads++; else innerReads++;
        const found = target.get(v);
        return wrapChildren && found instanceof Map ? observeMap(found, false) : found;
      };
      if (iterating.includes(key)) return (...a) => { iterations++; return target[key](...a); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const observedDefaults = observeMap(index.valueDefaults, true);
  const observed = { ...index, valueDefaults: observedDefaults };
  let queries = 0;
  for (let from = 0; from < size; from++) {
    for (let to = 0; to < size; to++) {
      if (from === to) continue;
      const r = resolveSetup({ ...data, index: observed, machine: 'LINE 0', predecessorOrderId: 'P', successorOrderId: 'S',
        predecessorState: data.states[from], successorState: data.states[to] });
      assert.equal(r.covered, true);
      assert.equal(r.source, 'value-default');
      const colorChanged = from % 10 !== to % 10;
      assert.equal(r.effectiveMin, 5 + to % 50 + (colorChanged ? 3 + to % 10 : 0));
      queries++;
    }
  }
  assert.ok(reads <= 3 * queries, `default lookups ${reads} must stay within 3 x ${queries} queries`);
  assert.ok(innerReads <= 2 * queries, `inner lookups ${innerReads} must stay within one per field (2) x ${queries} queries`);
  assert.equal(iterations, 0, 'value-default resolution must not iterate the default maps (outer or inner)');
});

test('value-default maps are built once per index, never per indexed resolve; the linear path rebuilds per call', () => {
  const data = snapshot(20);
  data.plantRows = [];
  data.valueDefaults = [
    ...Array.from({ length: 20 }, (_, i) => ({ field_key: 'prt01', value: `TOOL ${i}`, setup_min: 5 + i, signature_version: 1 })),
    ...Array.from({ length: 10 }, (_, i) => ({ field_key: 'colorWheel', value: `COLOR ${i}`, setup_min: 3 + i, signature_version: 1 })),
  ];
  const index = buildSetupResolutionIndex(data);
  const RealMap = globalThis.Map;
  let constructed = 0;
  globalThis.Map = class CountingMap extends RealMap { constructor(...a) { super(...a); constructed++; } };
  try {
    let queries = 0;
    for (let from = 0; from < 20; from++) for (let to = 0; to < 20; to++) {
      if (from === to) continue;
      resolveSetup({ ...data, index, machine: 'LINE 0', predecessorOrderId: 'P', successorOrderId: 'S',
        predecessorState: data.states[from], successorState: data.states[to] });
      queries++;
    }
    assert.ok(queries > 0);
    assert.equal(constructed, 0, 'the indexed path must not construct any Map per resolve');
    constructed = 0;
    for (let to = 1; to < 20; to++) {
      resolveSetup({ ...data, machine: 'LINE 0', predecessorOrderId: 'P', successorOrderId: 'S',
        predecessorState: data.states[0], successorState: data.states[to] });
    }
    assert.ok(constructed >= 19, 'the linear path builds the default maps per call (callers with many pairs must pass an index)');
  } finally {
    globalThis.Map = RealMap;
  }
});
