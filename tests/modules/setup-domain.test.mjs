import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeShadowDiagnostics, resolveSetup, stateForOrder } from '../../frontend/setup/setup-domain.mjs';

const definition = {
  plant: '5512',
  fields: ['prt01', 'colorWheel'],
  signature_version: 7,
  strict_blanks: true,
  active: false,
};

// Canonical (post-case-fold) form: stateForOrder now uppercases every value,
// so fixtures representing an already-canonicalized state must be uppercase
// too — the raw, mixed-case order literals fed into stateForOrder below are
// what exercise the fold itself.
const redTool = [
  { fieldKey: 'prt01', value: 'TOOL A' },
  { fieldKey: 'colorWheel', value: 'RED' },
];

const blueTool = [
  { fieldKey: 'prt01', value: 'TOOL A' },
  { fieldKey: 'colorWheel', value: 'BLUE' },
];

function input(overrides = {}) {
  return {
    definition,
    machine: 'LINE-1',
    predecessorState: redTool,
    successorState: blueTool,
    predecessorOrderId: 'ORDER-1',
    successorOrderId: 'ORDER-2',
    plantRows: [],
    machineRows: [],
    overrides: [],
    ...overrides,
  };
}

test('stateForOrder follows the definition field order and rejects strict blank values', () => {
  assert.deepEqual(stateForOrder({ COLOR: ' Red ', PRT_01: ' Tool A ' }, definition), redTool);
  assert.equal(stateForOrder({ COLOR: 'Red', PRT_01: ' ' }, definition), null);
});

test('an explicit diagonal matrix row takes precedence over the implicit zero', () => {
  const result = resolveSetup(input({
    successorState: redTool,
    plantRows: [{
      machine: '', signature_version: 7, from_key: redTool, to_key: redTool, setup_min: 12,
    }],
  }));

  assert.deepEqual(result, {
    covered: true,
    requiredMin: 12,
    effectiveMin: 12,
    standardMin: 12,
    source: 'plant',
    reason: 'Plant setup-matrix row',
    signatureVersion: 7,
  });
});

test('a complete identical state without an explicit row resolves to an implicit zero', () => {
  const result = resolveSetup(input({ successorState: redTool }));

  assert.deepEqual(result, {
    covered: true,
    requiredMin: 0,
    effectiveMin: 0,
    standardMin: 0,
    source: 'implicit-zero',
    reason: 'Identical complete setup states',
    signatureVersion: 7,
  });
});

test('a matching line row overrides the matching plant row', () => {
  const result = resolveSetup(input({
    plantRows: [{ machine: '', signature_version: 7, from_key: redTool, to_key: blueTool, setup_min: 20 }],
    machineRows: [{ machine: 'LINE-1', signature_version: 7, from_key: redTool, to_key: blueTool, setup_min: 8 }],
  }));

  assert.equal(result.source, 'line');
  assert.equal(result.effectiveMin, 8);
  assert.equal(result.standardMin, 8);
});

test('a valid occurrence override takes precedence over the matrix standard', () => {
  const result = resolveSetup(input({
    machineRows: [{ machine: 'LINE-1', signature_version: 7, from_key: redTool, to_key: blueTool, setup_min: 12 }],
    overrides: [{
      id: 42,
      machine: 'LINE-1',
      signature_version: 7,
      predecessor_order_id: 'ORDER-1',
      successor_order_id: 'ORDER-2',
      predecessor_state_key: redTool,
      successor_state_key: blueTool,
      standard_min: 12,
      remaining_min: 4,
      status: 'active',
      reason: 'Floor crew has already completed most of the changeover',
    }],
  }));

  assert.deepEqual(result, {
    covered: true,
    requiredMin: 4,
    effectiveMin: 4,
    standardMin: 12,
    source: 'occurrence',
    reason: 'Floor crew has already completed most of the changeover',
    signatureVersion: 7,
    overrideId: '42',
  });
});

test('an occurrence override retains remaining work while reporting the current matrix standard', () => {
  const result = resolveSetup(input({
    machineRows: [{ machine: 'LINE-1', signature_version: 7, from_key: redTool, to_key: blueTool, setup_min: 10 }],
    overrides: [{
      id: 43,
      machine: 'LINE-1',
      signature_version: 7,
      predecessor_order_id: 'ORDER-1',
      successor_order_id: 'ORDER-2',
      predecessor_state_key: redTool,
      successor_state_key: blueTool,
      standard_min: 16,
      remaining_min: 4,
      status: 'active',
      reason: 'The current changeover is nearly complete',
    }],
  }));

  assert.equal(result.source, 'occurrence');
  assert.equal(result.effectiveMin, 4);
  assert.equal(result.standardMin, 10);
});

test('an uncovered non-diagonal transition has no duration', () => {
  const result = resolveSetup(input());

  assert.deepEqual(result, {
    covered: false,
    requiredMin: null,
    effectiveMin: null,
    standardMin: null,
    source: 'uncovered',
    reason: 'No version-matched setup transition covers this state pair',
    signatureVersion: 7,
  });
});

test('incomplete equal-looking states do not receive an implicit zero', () => {
  const incomplete = [{ fieldKey: 'prt01', value: 'Tool A' }];
  const result = resolveSetup(input({
    definition: { ...definition, strict_blanks: false },
    predecessorState: incomplete,
    successorState: incomplete,
  }));

  assert.equal(result.covered, false);
  assert.equal(result.source, 'uncovered');
});

test('stale matrix rows and overrides never resolve a transition', () => {
  const result = resolveSetup(input({
    plantRows: [{ machine: '', signature_version: 6, from_key: redTool, to_key: blueTool, setup_min: 20 }],
    overrides: [{
      id: 9,
      machine: 'LINE-1',
      signature_version: 6,
      predecessor_order_id: 'ORDER-1',
      successor_order_id: 'ORDER-2',
      predecessor_state_key: redTool,
      successor_state_key: blueTool,
      standard_min: 20,
      remaining_min: 5,
      status: 'active',
      reason: 'Old signature',
    }],
  }));

  assert.equal(result.covered, false);
  assert.equal(result.source, 'uncovered');
});

test('malformed fractional setup minutes do not create coverage', () => {
  const result = resolveSetup({
    definition, machine: 'LINE-1', predecessorState: redTool, successorState: blueTool,
    predecessorOrderId: 'a', successorOrderId: 'b', overrides: [], machineRows: [],
    plantRows: [{ machine: '', signature_version: 7, from_key: redTool, to_key: blueTool, setup_min: 2.5 }],
  });
  assert.equal(result.covered, false);
});

test('shadow diagnostics count coverage and state density without mutating schedule inputs', () => {
  const snapshot = {
    plant: '5512', definition,
    plant_rows: [{ machine: '', signature_version: 7, from_key: redTool, to_key: blueTool, setup_min: 12 }],
    machine_rows: [], overrides: [], machine_states: [],
  };
  const tasks = [
    { id: '1', PLANT: '5512', MACHINE: 'LINE-1', COLOR: 'Red', PRT_01: 'Tool A', start_date: new Date('2026-08-13T08:00:00Z'), scheduleSegments: [{ sequence: 1, startDate: new Date('2026-08-13T08:00:00Z'), endDate: new Date('2026-08-13T09:00:00Z') }] },
    { id: '2', PLANT: '5512', MACHINE: 'LINE-1', COLOR: 'Blue', PRT_01: 'Tool A', start_date: new Date('2026-08-13T09:00:00Z') },
    { id: '3', PLANT: '5512', MACHINE: 'LINE-1', COLOR: '', PRT_01: 'Tool A', start_date: new Date('2026-08-13T10:00:00Z') },
  ];
  const before = structuredClone({ snapshot, tasks });
  const result = computeShadowDiagnostics(snapshot, tasks, { percentile: 0.95 });

  assert.equal(result.coveredTransitions, 1);
  assert.equal(result.uncoveredTransitions, 0);
  assert.equal(result.totalStandardMinutes, 12);
  assert.deepEqual(result.distinctStates, { count: 2, median: 2, max: 2, percentile: 2 });
  assert.equal(result.taskCount, 3);
  assert.equal(typeof result.derivationMs, 'number');
  assert.deepEqual({ snapshot, tasks }, before);
});
