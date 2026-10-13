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
