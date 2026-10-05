import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSetup, buildSetupResolutionIndex } from '../../frontend/setup/setup-domain.mjs';

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
// e.g. 'A'+'BC' vs 'AB'+'C') AND space-containing tokens, to stress
// stateSignature's NUL join and joinIndexKey's NUL join under realistic
// space-containing production values (e.g. a PRT/tool name like "TOOL A").
const VALUE_POOL = ['A', 'B', 'AB', 'BC', 'ABC', 'RED', 'RE', 'D', 'TOOL A', 'X', '1 A'];
const NONEMPTY_VALUE_POOL = VALUE_POOL.filter(v => v.length > 0);
// Space-containing machine codes are real (see Finding 1) — keep them in the
// default pool, not just in the dedicated adversarial tests below.
const MACHINE_POOL = ['LINE-1', 'LINE-2', '', 'LINE 3', 'LINE 1'];
const SUCCESSOR_ORDER_ID_POOL = ['ORD-1', 'ORD-2', 'ORD-3'];
const PREDECESSOR_ORDER_ID_POOL = ['ORD-1', 'ORD-2', 'ORD-3', null];

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

function buildState(definition, valuePool, rng) {
  return definition.fields.map(fieldKey => ({ fieldKey, value: pick(rng, valuePool) }));
}

function cloneState(state) {
  return state.map(entry => ({ ...entry }));
}

// ---------------------------------------------------------------------------
// Targeted generator: builds a case whose GROUND-TRUTH (unindexed) outcome is
// guaranteed to be `target`, so the property test actually exercises the
// override/line/plant hit paths where Finding 1 lived — not just
// implicit-zero/uncovered. Noise rows/overrides/use a per-case-unique token
// namespace so they can never accidentally match the guaranteed tuple.
// ---------------------------------------------------------------------------
function buildTargetedCase(rng, caseIndex, target) {
  const definition = randomDefinition(rng);
  const machine = pick(rng, MACHINE_POOL);
  const predecessorOrderId = pick(rng, PREDECESSOR_ORDER_ID_POOL);
  const successorOrderId = pick(rng, SUCCESSOR_ORDER_ID_POOL);

  const noiseTag = `NOISE_${caseIndex}`;
  const noiseState = (suffix) => definition.fields.map((fieldKey, i) => ({ fieldKey, value: `${noiseTag}_V${i}_${suffix}` }));
  const noiseMachineRows = Array.from({ length: intBetween(rng, 0, 3) }, (_, i) => ({
    machine: `${noiseTag}_M${i}`,
    signature_version: rng() < 0.3 ? definition.signature_version + 1 : definition.signature_version,
    from_key: noiseState(`from${i}`),
    to_key: noiseState(`to${i}`),
    setup_min: rng() < 0.2 ? -1 : intBetween(rng, 0, 60),
  }));
  const noisePlantRows = Array.from({ length: intBetween(rng, 0, 3) }, (_, i) => ({
    machine: '',
    signature_version: rng() < 0.3 ? definition.signature_version + 1 : definition.signature_version,
    from_key: noiseState(`pfrom${i}`),
    to_key: noiseState(`pto${i}`),
    setup_min: rng() < 0.2 ? 2.5 : intBetween(rng, 0, 60),
  }));
  const noiseOverrides = Array.from({ length: intBetween(rng, 0, 3) }, (_, i) => ({
    id: `${noiseTag}_O${i}`,
    machine: `${noiseTag}_OM${i}`,
    signature_version: definition.signature_version,
    predecessor_order_id: `${noiseTag}_OP${i}`,
    successor_order_id: `${noiseTag}_OS${i}`,
    predecessor_state_key: noiseState(`ofrom${i}`),
    successor_state_key: noiseState(`oto${i}`),
    standard_min: intBetween(rng, 0, 60),
    remaining_min: intBetween(rng, 0, 60),
    status: 'active',
    reason: 'noise',
  }));

  let predecessorState;
  let successorState;
  let machineRows = noiseMachineRows;
  let plantRows = noisePlantRows;
  let overrides = noiseOverrides;

  if (target === 'occurrence') {
    predecessorState = buildState(definition, VALUE_POOL, rng);
    successorState = buildState(definition, VALUE_POOL, rng);
    overrides = [
      {
        id: `${caseIndex}-occ`,
        machine,
        signature_version: definition.signature_version,
        predecessor_order_id: predecessorOrderId,
        successor_order_id: successorOrderId,
        predecessor_state_key: cloneState(predecessorState),
        successor_state_key: cloneState(successorState),
        standard_min: intBetween(rng, 0, 60),
        remaining_min: intBetween(rng, 0, 60),
        status: 'active',
        reason: 'targeted occurrence hit',
      },
      ...noiseOverrides,
    ];
  } else if (target === 'line') {
    predecessorState = buildState(definition, VALUE_POOL, rng);
    successorState = buildState(definition, VALUE_POOL, rng);
    machineRows = [
      {
        machine,
        signature_version: definition.signature_version,
        from_key: cloneState(predecessorState),
        to_key: cloneState(successorState),
        setup_min: intBetween(rng, 0, 60),
      },
      ...noiseMachineRows,
    ];
  } else if (target === 'plant') {
    predecessorState = buildState(definition, VALUE_POOL, rng);
    successorState = buildState(definition, VALUE_POOL, rng);
    plantRows = [
      {
        machine: '',
        signature_version: definition.signature_version,
        from_key: cloneState(predecessorState),
        to_key: cloneState(successorState),
        setup_min: intBetween(rng, 0, 60),
      },
      ...noisePlantRows,
    ];
  } else if (target === 'implicit-zero') {
    predecessorState = buildState(definition, NONEMPTY_VALUE_POOL, rng);
    successorState = cloneState(predecessorState);
  } else { // 'uncovered'
    predecessorState = buildState(definition, VALUE_POOL, rng);
    successorState = buildState(definition, VALUE_POOL, rng);
    // Force inequality so it can never accidentally land on implicit-zero.
    successorState[0] = { ...successorState[0], value: `${successorState[0].value}_DIFFERENT` };
  }

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

const TARGETS = ['occurrence', 'line', 'plant', 'implicit-zero', 'uncovered'];

test('resolveSetup with a prebuilt index is byte-identical to the unindexed scan, across all five outcome classes', () => {
  const rng = mulberry32(0xC0FFEE);
  const CASES_PER_TARGET = 120;
  const tally = { occurrence: 0, line: 0, plant: 0, 'implicit-zero': 0, uncovered: 0 };
  let caseIndex = 0;

  for (const target of TARGETS) {
    for (let i = 0; i < CASES_PER_TARGET; i += 1) {
      const input = buildTargetedCase(rng, caseIndex, target);
      caseIndex += 1;
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
        `case ${caseIndex} (target=${target}) diverged\ninput: ${JSON.stringify(input)}\nunindexed: ${JSON.stringify(unindexed)}\nindexed: ${JSON.stringify(indexed)}`,
      );
      tally[unindexed.source] = (tally[unindexed.source] ?? 0) + 1;
    }
  }

  for (const source of TARGETS) {
    assert.ok(tally[source] > 0, `outcome class "${source}" was never exercised — tally: ${JSON.stringify(tally)}`);
  }
});

test('resolveSetup with a prebuilt index is byte-identical to the unindexed scan across generic randomized (non-targeted) cases', () => {
  const rng = mulberry32(0xDECAFBAD);
  const CASES = 300;

  function randomState(innerRng, definition, opts = {}) {
    if (innerRng() < (opts.malformedShapeChance ?? 0.15)) {
      const kind = intBetween(innerRng, 0, 2);
      if (kind === 0) return definition.fields.slice(0, -1).map(fieldKey => ({ fieldKey, value: pick(innerRng, VALUE_POOL) }));
      if (kind === 1) return [...definition.fields].reverse().map(fieldKey => ({ fieldKey, value: pick(innerRng, VALUE_POOL) }));
      return definition.fields.map(fieldKey => ({ fieldKey, value: 123 }));
    }
    return definition.fields.map(fieldKey => ({ fieldKey, value: pick(innerRng, VALUE_POOL) }));
  }

  function randomMatrixRow(innerRng, definition, machinePool) {
    const versionSkew = innerRng() < 0.2 ? intBetween(innerRng, 1, 3) : definition.signature_version;
    return {
      machine: pick(innerRng, machinePool),
      signature_version: versionSkew,
      from_key: randomState(innerRng, definition, { malformedShapeChance: 0.2 }),
      to_key: randomState(innerRng, definition, { malformedShapeChance: 0.2 }),
      setup_min: innerRng() < 0.15 ? intBetween(innerRng, -5, -1) : (innerRng() < 0.15 ? 3.5 : intBetween(innerRng, 0, 60)),
    };
  }

  function randomOverride(innerRng, definition, id) {
    const versionSkew = innerRng() < 0.2 ? intBetween(innerRng, 1, 3) : definition.signature_version;
    return {
      id,
      machine: pick(innerRng, MACHINE_POOL),
      signature_version: versionSkew,
      predecessor_order_id: pick(innerRng, PREDECESSOR_ORDER_ID_POOL),
      successor_order_id: pick(innerRng, SUCCESSOR_ORDER_ID_POOL),
      predecessor_state_key: randomState(innerRng, definition, { malformedShapeChance: 0.2 }),
      successor_state_key: randomState(innerRng, definition, { malformedShapeChance: 0.2 }),
      standard_min: innerRng() < 0.15 ? -3 : intBetween(innerRng, 0, 60),
      remaining_min: innerRng() < 0.15 ? 4.25 : intBetween(innerRng, 0, 60),
      status: pick(innerRng, ['active', 'inactive', 'cleared', 'replaced']),
      reason: 'randomized fixture',
    };
  }

  for (let i = 0; i < CASES; i += 1) {
    const definition = randomDefinition(rng);
    const machineRows = Array.from({ length: intBetween(rng, 0, 6) }, () => randomMatrixRow(rng, definition, MACHINE_POOL));
    const plantRows = Array.from({ length: intBetween(rng, 0, 6) }, () => randomMatrixRow(rng, definition, ['', '', 'LINE-1']));
    const overrides = Array.from({ length: intBetween(rng, 0, 6) }, (_, j) => randomOverride(rng, definition, `${i}-${j}`));

    const input = {
      definition,
      machine: pick(rng, MACHINE_POOL),
      predecessorState: rng() < 0.1 ? null : randomState(rng, definition),
      successorState: rng() < 0.1 ? null : randomState(rng, definition),
      predecessorOrderId: pick(rng, PREDECESSOR_ORDER_ID_POOL),
      successorOrderId: pick(rng, SUCCESSOR_ORDER_ID_POOL),
      plantRows,
      machineRows,
      overrides,
    };
    const index = buildSetupResolutionIndex({ definition, machineRows, plantRows, overrides });

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
    const target = TARGETS[i % TARGETS.length];
    const input = buildTargetedCase(rng, `stale-${i}`, target);
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

// ---------------------------------------------------------------------------
// Finding 1 regression: explicit adversarial space-collision cases.
//
// A naive space-joined compound key lets two DIFFERENT (machine, state) tuples
// collide on the SAME key string: machine "LINE" + from-value "1 A" joins
// (with a space separator) to "LINE 1 A", and so does machine "LINE 1" +
// from-value "A". These cases pin that the fix (NUL-separated keys, plus a
// residual `row.machine`/`statesEqual` re-check on every index hit) holds for
// exactly the scenario the regression report described, for both the
// machine-row and plant-row indexes.
// ---------------------------------------------------------------------------

test('a machine-row index never admits a row whose (machine, from) pair collides under a naive space-joined key', () => {
  const definition = { plant: '5512', fields: ['prt01'], signature_version: 1, strict_blanks: true, active: true };

  // Row: machine "LINE", from "1 A" -> to "X". Space-joined key: "LINE 1 A X".
  const collidingRow = {
    machine: 'LINE',
    signature_version: 1,
    from_key: [{ fieldKey: 'prt01', value: '1 A' }],
    to_key: [{ fieldKey: 'prt01', value: 'X' }],
    setup_min: 5,
  };
  // Query: machine "LINE 1", from "A" -> to "X". Space-joined key: "LINE 1 A X".
  const query = {
    definition,
    machine: 'LINE 1',
    predecessorState: [{ fieldKey: 'prt01', value: 'A' }],
    successorState: [{ fieldKey: 'prt01', value: 'X' }],
    predecessorOrderId: 'P', successorOrderId: 'S',
    machineRows: [collidingRow], plantRows: [], overrides: [],
  };
  const index = buildSetupResolutionIndex({ definition, machineRows: [collidingRow], plantRows: [], overrides: [] });

  const unindexed = resolveSetup(query);
  const indexed = resolveSetup({ ...query, index });

  // Ground truth: the row's machine ("LINE") does not equal the query's
  // machine ("LINE 1"), so this must NOT resolve as a line-matrix hit.
  assert.equal(unindexed.source, 'uncovered');
  assert.deepEqual(indexed, unindexed);
});

test('a plant-row index never admits a row whose from/to pair would collide under a naive (space- or empty-) joined key', () => {
  const definition = { plant: '5512', fields: ['prt01', 'colorWheel'], signature_version: 1, strict_blanks: true, active: true };

  // Row: from = [prt01="1", colorWheel="A"], to = [prt01="X", colorWheel="Y"].
  // stateSignature (values joined with NUL) = "1 A" for from, "X Y" for to.
  // A naive empty-joined signature would be "1A" / "XY" (space-joined key "1A XY").
  const row = {
    machine: '',
    signature_version: 1,
    from_key: [{ fieldKey: 'prt01', value: '1' }, { fieldKey: 'colorWheel', value: 'A' }],
    to_key: [{ fieldKey: 'prt01', value: 'X' }, { fieldKey: 'colorWheel', value: 'Y' }],
    setup_min: 7,
  };
  // Query: from = [prt01="1A", colorWheel=""], to = [prt01="X", colorWheel="Y"].
  // stateSignature = "1A " for from — distinct from the row's "1 A" now that
  // the join is NUL; under a naive '' join both would be "1A" while the value
  // arrays still differ, which is the collision this test guards.
  const query = {
    definition,
    machine: '',
    predecessorState: [{ fieldKey: 'prt01', value: '1A' }, { fieldKey: 'colorWheel', value: '' }],
    successorState: [{ fieldKey: 'prt01', value: 'X' }, { fieldKey: 'colorWheel', value: 'Y' }],
    predecessorOrderId: 'P', successorOrderId: 'S',
    machineRows: [], plantRows: [row], overrides: [],
  };
  const index = buildSetupResolutionIndex({ definition, machineRows: [], plantRows: [row], overrides: [] });

  const unindexed = resolveSetup(query);
  const indexed = resolveSetup({ ...query, index });

  // Ground truth: statesEqual([prt01="1",colorWheel="A"], [prt01="1A",colorWheel=""])
  // is false (different value arrays), so this must NOT resolve as a
  // plant-matrix hit.
  assert.equal(unindexed.source, 'uncovered');
  assert.deepEqual(indexed, unindexed);
});

test('space-containing machine codes never cross-match between distinct lines in the indexed path', () => {
  const definition = { plant: '5512', fields: ['prt01'], signature_version: 2, strict_blanks: true, active: true };
  const from = [{ fieldKey: 'prt01', value: 'A' }];
  const to = [{ fieldKey: 'prt01', value: 'B' }];

  const machineRows = [
    { machine: 'LINE 1', signature_version: 2, from_key: from, to_key: to, setup_min: 9 },
    { machine: 'LINE', signature_version: 2, from_key: [{ fieldKey: 'prt01', value: '1 A' }], to_key: [{ fieldKey: 'prt01', value: 'B' }], setup_min: 40 },
  ];
  const index = buildSetupResolutionIndex({ definition, machineRows, plantRows: [], overrides: [] });

  const queryForLine1 = {
    definition, machine: 'LINE 1', predecessorState: from, successorState: to,
    predecessorOrderId: 'P', successorOrderId: 'S', machineRows, plantRows: [], overrides: [],
  };
  const unindexed = resolveSetup(queryForLine1);
  const indexed = resolveSetup({ ...queryForLine1, index });

  // The correct match is the first row (setup_min 9), not a cross-matched
  // read of the second, differently-keyed row.
  assert.equal(unindexed.source, 'line');
  assert.equal(unindexed.effectiveMin, 9);
  assert.deepEqual(indexed, unindexed);
});

test('two states whose values concatenate identically keep distinct index rows (#45)', () => {
  const definition = { plant: '5512', fields: ['prt01', 'colorWheel'], signature_version: 1, strict_blanks: true, active: true };
  const st = (a, b) => [{ fieldKey: 'prt01', value: a }, { fieldKey: 'colorWheel', value: b }];
  const to = st('Z', 'Z');
  const plantRows = [
    { machine: '', signature_version: 1, from_key: st('10', '220'), to_key: to, setup_min: 40 },
    { machine: '', signature_version: 1, from_key: st('102', '20'), to_key: to, setup_min: 15 },
  ];
  const index = buildSetupResolutionIndex({ definition, machineRows: [], plantRows, overrides: [] });
  const q = (from) => ({ definition, machine: '', predecessorState: from, successorState: to,
    predecessorOrderId: 'P', successorOrderId: 'S', machineRows: [], plantRows, overrides: [] });
  for (const from of [st('10', '220'), st('102', '20')]) {
    const unindexed = resolveSetup(q(from));
    const indexed = resolveSetup({ ...q(from), index });
    assert.deepEqual(indexed, unindexed);
  }
  assert.equal(resolveSetup({ ...q(st('10', '220')), index }).effectiveMin, 40);
  assert.equal(resolveSetup({ ...q(st('102', '20')), index }).effectiveMin, 15);
});
