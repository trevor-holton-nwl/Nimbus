import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSetup, buildSetupResolutionIndex } from '../../web/setup-domain.mjs';

// ---------------------------------------------------------------------------
// Seeded deterministic PRNG (mulberry32) — no Math.random flakiness.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

function intBetween(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

const FIELD_POOL = ['prt01', 'colorWheel', 'prt02', 'productionVersion'];
// Deliberately short + overlapping value tokens (some concatenation-ambiguous,
// e.g. 'A'+'BC' vs 'AB'+'C') to stress stateSignature's '' join under the same
// conditions the unindexed scan already tolerates via full statesEqual checks.
const VALUE_POOL = ['A', 'B', 'AB', 'BC', 'ABC', 'RED', 'RE', 'D', 'TOOL A', 'X', ''];
const MACHINE_POOL = ['LINE-1', 'LINE-2', '', 'LINE 3'];
const ORDER_ID_POOL = ['ORD-1', 'ORD-2', 'ORD-3', null];
const STATUS_POOL = ['active', 'inactive', 'cleared', 'replaced'];

function randomDefinition(rng) {
  const fieldCount = intBetween(rng, 1, 3);
  const fields = [];
  const pool = [...FIELD_POOL];
  for (let i = 0; i < fieldCount && pool.length; i += 1) {
    const idx = Math.floor(rng() * pool.length) % pool.length;
    fields.push(pool.splice(idx, 1)[0]);
  }
  return {
    plant: '5512',
    fields,
    signature_version: intBetween(rng, 1, 3),
    strict_blanks: rng() < 0.5,
    active: rng() < 0.5,
  };
}

function randomState(rng, definition, opts = {}) {
  if (rng() < (opts.malformedShapeChance ?? 0.15)) {
    // Deliberately malformed: wrong length, wrong fieldKey order, or wrong type.
    const kind = intBetween(rng, 0, 2);
    if (kind === 0) return definition.fields.slice(0, -1).map(fieldKey => ({ fieldKey, value: pick(rng, VALUE_POOL) }));
    if (kind === 1) return [...definition.fields].reverse().map(fieldKey => ({ fieldKey, value: pick(rng, VALUE_POOL) }));
    return definition.fields.map(fieldKey => ({ fieldKey, value: 123 }));
  }
  return definition.fields.map(fieldKey => ({ fieldKey, value: pick(rng, VALUE_POOL) }));
}

function randomMatrixRow(rng, definition, machinePool) {
  const versionSkew = rng() < 0.2 ? intBetween(rng, 1, 3) : definition.signature_version;
  return {
    machine: pick(rng, machinePool),
    signature_version: versionSkew,
    from_key: randomState(rng, definition, { malformedShapeChance: 0.2 }),
    to_key: randomState(rng, definition, { malformedShapeChance: 0.2 }),
    setup_min: rng() < 0.15 ? intBetween(rng, -5, -1) : (rng() < 0.15 ? 3.5 : intBetween(rng, 0, 60)),
  };
}

function randomOverride(rng, definition, id) {
  const versionSkew = rng() < 0.2 ? intBetween(rng, 1, 3) : definition.signature_version;
  const predecessorOrderId = pick(rng, ORDER_ID_POOL);
  return {
    id,
    machine: pick(rng, MACHINE_POOL),
    signature_version: versionSkew,
    predecessor_order_id: predecessorOrderId,
    successor_order_id: pick(rng, ORDER_ID_POOL) ?? 'ORD-SUCC',
    predecessor_state_key: randomState(rng, definition, { malformedShapeChance: 0.2 }),
    successor_state_key: randomState(rng, definition, { malformedShapeChance: 0.2 }),
    standard_min: rng() < 0.15 ? -3 : intBetween(rng, 0, 60),
    remaining_min: rng() < 0.15 ? 4.25 : intBetween(rng, 0, 60),
    status: pick(rng, STATUS_POOL),
    reason: 'randomized fixture',
  };
}

function buildRandomCase(rng, caseIndex) {
  const definition = randomDefinition(rng);
  const machineRowCount = intBetween(rng, 0, 6);
  const plantRowCount = intBetween(rng, 0, 6);
  const overrideCount = intBetween(rng, 0, 6);

  const machineRows = Array.from({ length: machineRowCount }, () => randomMatrixRow(rng, definition, MACHINE_POOL));
  const plantRows = Array.from({ length: plantRowCount }, () => randomMatrixRow(rng, definition, ['', '', 'LINE-1']));
  const overrides = Array.from({ length: overrideCount }, (_, i) => randomOverride(rng, definition, `${caseIndex}-${i}`));

  const machine = pick(rng, MACHINE_POOL);
  const predecessorState = rng() < 0.1 ? null : randomState(rng, definition);
  const successorState = rng() < 0.1 ? null : randomState(rng, definition);
  const predecessorOrderId = pick(rng, ORDER_ID_POOL);
  const successorOrderId = pick(rng, ORDER_ID_POOL) ?? 'ORD-SUCC';

  return {
    definition,
    machine,
    predecessorState,
    successorState,
    predecessorOrderId,
    successorOrderId,
    plantRows,
    machineRows,
    overrides,
  };
}

test('resolveSetup with a prebuilt index is byte-identical to the unindexed scan across randomized cases', () => {
  const rng = mulberry32(0xC0FFEE);
  const CASES = 400;
  for (let i = 0; i < CASES; i += 1) {
    const input = buildRandomCase(rng, i);
    const index = buildSetupResolutionIndex({
      definition: input.definition,
      machineRows: input.machineRows,
      plantRows: input.plantRows,
      overrides: input.overrides,
    });

    const unindexed = resolveSetup(input);
    const indexed = resolveSetup({ ...input, index });

    assert.deepEqual(
      indexed,
      unindexed,
      `case ${i} diverged\ninput: ${JSON.stringify(input)}\nunindexed: ${JSON.stringify(unindexed)}\nindexed: ${JSON.stringify(indexed)}`,
    );
  }
});

test('resolveSetup with a stale (mismatched) index signatureVersion falls back to the unindexed scan', () => {
  const rng = mulberry32(0xBADD00D);
  const CASES = 50;
  for (let i = 0; i < CASES; i += 1) {
    const input = buildRandomCase(rng, i);
    const index = buildSetupResolutionIndex({
      definition: { ...input.definition, signature_version: input.definition.signature_version + 1 },
      machineRows: input.machineRows,
      plantRows: input.plantRows,
      overrides: input.overrides,
    });

    const unindexed = resolveSetup(input);
    const withStaleIndex = resolveSetup({ ...input, index });

    assert.deepEqual(withStaleIndex, unindexed, `case ${i} used a stale index instead of falling back`);
  }
});

test('duplicate-key matrix rows: first-row-wins is identical between the scan and the index', () => {
  const definition = { plant: '5512', fields: ['prt01'], signature_version: 5, strict_blanks: true, active: true };
  const stateA = [{ fieldKey: 'prt01', value: 'A' }];
  const stateB = [{ fieldKey: 'prt01', value: 'B' }];

  const machineRows = [
    { machine: 'LINE-1', signature_version: 5, from_key: stateA, to_key: stateB, setup_min: 11 },
    { machine: 'LINE-1', signature_version: 5, from_key: stateA, to_key: stateB, setup_min: 99 },
  ];
  const plantRows = [
    { machine: '', signature_version: 5, from_key: stateA, to_key: stateB, setup_min: 22 },
    { machine: '', signature_version: 5, from_key: stateA, to_key: stateB, setup_min: 77 },
  ];

  const input = {
    definition, machine: 'LINE-1', predecessorState: stateA, successorState: stateB,
    predecessorOrderId: 'P', successorOrderId: 'S', machineRows, plantRows, overrides: [],
  };
  const index = buildSetupResolutionIndex({ definition, machineRows, plantRows, overrides: [] });

  const unindexed = resolveSetup(input);
  const indexed = resolveSetup({ ...input, index });

  assert.equal(unindexed.effectiveMin, 11);
  assert.deepEqual(indexed, unindexed);
});

test('duplicate-key overrides: first-row-wins is identical between the scan and the index', () => {
  const definition = { plant: '5512', fields: ['prt01'], signature_version: 5, strict_blanks: true, active: true };
  const stateA = [{ fieldKey: 'prt01', value: 'A' }];
  const stateB = [{ fieldKey: 'prt01', value: 'B' }];

  const overrides = [
    {
      id: 1, machine: 'LINE-1', signature_version: 5,
      predecessor_order_id: 'P', successor_order_id: 'S',
      predecessor_state_key: stateA, successor_state_key: stateB,
      standard_min: 10, remaining_min: 3, status: 'active', reason: 'first',
    },
    {
      id: 2, machine: 'LINE-1', signature_version: 5,
      predecessor_order_id: 'P', successor_order_id: 'S',
      predecessor_state_key: stateA, successor_state_key: stateB,
      standard_min: 10, remaining_min: 9, status: 'active', reason: 'second (should be shadowed)',
    },
  ];

  const input = {
    definition, machine: 'LINE-1', predecessorState: stateA, successorState: stateB,
    predecessorOrderId: 'P', successorOrderId: 'S', machineRows: [], plantRows: [], overrides,
  };
  const index = buildSetupResolutionIndex({ definition, machineRows: [], plantRows: [], overrides });

  const unindexed = resolveSetup(input);
  const indexed = resolveSetup({ ...input, index });

  assert.equal(unindexed.overrideId, '1');
  assert.equal(unindexed.effectiveMin, 3);
  assert.deepEqual(indexed, unindexed);
});

test('a null predecessorOrderId is distinguishable from any real order id in the override index', () => {
  const definition = { plant: '5512', fields: ['prt01'], signature_version: 5, strict_blanks: true, active: true };
  const stateA = [{ fieldKey: 'prt01', value: 'A' }];
  const stateB = [{ fieldKey: 'prt01', value: 'B' }];

  const overrides = [
    {
      id: 1, machine: 'LINE-1', signature_version: 5,
      predecessor_order_id: null, successor_order_id: 'S',
      predecessor_state_key: stateA, successor_state_key: stateB,
      standard_min: 10, remaining_min: 3, status: 'active', reason: 'null predecessor',
    },
  ];

  const nullCaseInput = {
    definition, machine: 'LINE-1', predecessorState: stateA, successorState: stateB,
    predecessorOrderId: null, successorOrderId: 'S', machineRows: [], plantRows: [], overrides,
  };
  const realIdCaseInput = { ...nullCaseInput, predecessorOrderId: '__ABSENT_ORDER_ID__' };
  const index = buildSetupResolutionIndex({ definition, machineRows: [], plantRows: [], overrides });

  assert.deepEqual(resolveSetup({ ...nullCaseInput, index }), resolveSetup(nullCaseInput));
  assert.equal(resolveSetup(nullCaseInput).source, 'occurrence');

  // A real predecessorOrderId that happens to equal the module's internal
  // sentinel string must NOT be confused with the null case.
  assert.deepEqual(resolveSetup({ ...realIdCaseInput, index }), resolveSetup(realIdCaseInput));
  assert.equal(resolveSetup(realIdCaseInput).source, 'uncovered');
});
