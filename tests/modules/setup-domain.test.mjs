import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSetup, stateForOrder } from '../../web/setup-domain.mjs';

const definition = {
  plant: '5512',
  fields: ['prt01', 'colorWheel'],
  signature_version: 7,
  strict_blanks: true,
  active: false,
};

const redTool = [
  { fieldKey: 'prt01', value: 'Tool A' },
  { fieldKey: 'colorWheel', value: 'Red' },
];

const blueTool = [
  { fieldKey: 'prt01', value: 'Tool A' },
  { fieldKey: 'colorWheel', value: 'Blue' },
];

function input(overrides = {}) {
  return {
    definition,
    line: 'LINE-1',
    predecessorState: redTool,
    successorState: blueTool,
    predecessorOrderId: 'ORDER-1',
    successorOrderId: 'ORDER-2',
    plantRows: [],
    lineRows: [],
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
      line: '', signature_version: 7, from_key: redTool, to_key: redTool, setup_min: 12,
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
    plantRows: [{ line: '', signature_version: 7, from_key: redTool, to_key: blueTool, setup_min: 20 }],
    lineRows: [{ line: 'LINE-1', signature_version: 7, from_key: redTool, to_key: blueTool, setup_min: 8 }],
  }));

  assert.equal(result.source, 'line');
  assert.equal(result.effectiveMin, 8);
  assert.equal(result.standardMin, 8);
});

test('a valid occurrence override takes precedence over the matrix standard', () => {
  const result = resolveSetup(input({
    lineRows: [{ line: 'LINE-1', signature_version: 7, from_key: redTool, to_key: blueTool, setup_min: 12 }],
    overrides: [{
      id: 42,
      line: 'LINE-1',
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
    lineRows: [{ line: 'LINE-1', signature_version: 7, from_key: redTool, to_key: blueTool, setup_min: 10 }],
    overrides: [{
      id: 43,
      line: 'LINE-1',
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
    plantRows: [{ line: '', signature_version: 6, from_key: redTool, to_key: blueTool, setup_min: 20 }],
    overrides: [{
      id: 9,
      line: 'LINE-1',
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
