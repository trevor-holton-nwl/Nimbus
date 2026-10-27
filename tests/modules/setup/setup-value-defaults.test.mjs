import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSetupResolutionIndex, computeShadowDiagnostics, resolveSetup, stateForOrder,
} from '../../../frontend/setup/setup-domain.mjs';

const definition = { plant: '5512', fields: ['prt01', 'colorWheel'], signature_version: 3, strict_blanks: true, active: false };
const st = (prt, color) => [{ fieldKey: 'prt01', value: prt }, { fieldKey: 'colorWheel', value: color }];
const vd = (field_key, value, setup_min, signature_version = 3) => ({ field_key, value, setup_min, signature_version });
// Worked check: PRT01 A=10 B=30 C=60; COLOR RED=15.
const DEFAULTS = [vd('prt01', 'A', 10), vd('prt01', 'B', 30), vd('prt01', 'C', 60), vd('colorWheel', 'RED', 15)];

function input(from, to, extra = {}) {
  return {
    definition, machine: 'LINE-1', predecessorState: from, successorState: to,
    predecessorOrderId: 'O1', successorOrderId: 'O2',
    plantRows: [], machineRows: [], overrides: [], valueDefaults: DEFAULTS, ...extra,
  };
}

// Every assertion runs through both the linear path and the prebuilt-index path.
function both(from, to, extra = {}) {
  const base = input(from, to, extra);
  const linear = resolveSetup(base);
  const index = buildSetupResolutionIndex({
    definition: base.definition, machineRows: base.machineRows, plantRows: base.plantRows,
    overrides: base.overrides, valueDefaults: base.valueDefaults,
  });
  const indexed = resolveSetup({ ...base, index });
  assert.deepEqual(indexed, linear, 'indexed and linear paths must agree');
  return linear;
}

test('worked check: arriving at B on PRT01 costs 30', () => {
  const r = both(st('A', 'RED'), st('B', 'RED'));
  assert.equal(r.covered, true);
  assert.equal(r.source, 'value-default');
  assert.equal(r.requiredMin, 30);
  assert.equal(r.effectiveMin, 30);
  assert.equal(r.standardMin, 30);
  assert.equal(r.signatureVersion, 3);
});

test('worked check: partial sum, the field without a default is named in the reason', () => {
  const r = both(st('B', 'RED'), st('A', 'BLUE'));
  assert.equal(r.source, 'value-default');
  assert.equal(r.effectiveMin, 10);
  assert.match(r.reason, /prt01=A \(10\)/);
  assert.match(r.reason, /no default: colorWheel=BLUE/);
});

test('worked check: only the changed field is charged (same PRT01 value never charges PRT01)', () => {
  const r = both(st('C', 'BLUE'), st('C', 'RED'));
  assert.equal(r.effectiveMin, 15);
  assert.doesNotMatch(r.reason, /prt01/);
});

test('several changed fields are summed', () => {
  const r = both(st('A', 'BLUE'), st('C', 'RED'));
  assert.equal(r.effectiveMin, 75);
  assert.match(r.reason, /prt01=C \(60\) \+ colorWheel=RED \(15\)/);
  assert.doesNotMatch(r.reason, /no default/);
});

test('direction is arriving-at: A to C and C to A differ', () => {
  assert.equal(both(st('A', 'RED'), st('C', 'RED')).effectiveMin, 60);
  assert.equal(both(st('C', 'RED'), st('A', 'RED')).effectiveMin, 10);
});

test('worked check: identical complete states stay implicit zero, not a default', () => {
  const r = both(st('A', 'RED'), st('A', 'RED'));
  assert.equal(r.source, 'implicit-zero');
  assert.equal(r.effectiveMin, 0);
});

test('worked check: a plant row beats the default (even a smaller one)', () => {
  const plantRows = [{ machine: '', signature_version: 3, from_key: st('A', 'RED'), to_key: st('B', 'RED'), setup_min: 5 }];
  const r = both(st('A', 'RED'), st('B', 'RED'), { plantRows });
  assert.equal(r.source, 'plant');
  assert.equal(r.effectiveMin, 5);
});

test('a line row beats the default', () => {
  const machineRows = [{ machine: 'LINE-1', signature_version: 3, from_key: st('A', 'RED'), to_key: st('B', 'RED'), setup_min: 99 }];
  const r = both(st('A', 'RED'), st('B', 'RED'), { machineRows });
  assert.equal(r.source, 'line');
  assert.equal(r.effectiveMin, 99);
});

test('an occurrence override beats the default and its standardMin baseline is the default sum', () => {
  const overrides = [{
    id: 1, machine: 'LINE-1', signature_version: 3, predecessor_order_id: 'O1', successor_order_id: 'O2',
    predecessor_state_key: st('A', 'RED'), successor_state_key: st('B', 'RED'),
    standard_min: 777, remaining_min: 4, status: 'active', reason: 'half done',
  }];
  const r = both(st('A', 'RED'), st('B', 'RED'), { overrides });
  assert.equal(r.source, 'occurrence');
  assert.equal(r.effectiveMin, 4);
  assert.equal(r.standardMin, 30, 'currentStandard agrees with the default the Gantt would show');
});

test('an override on an uncovered pair with no default keeps its own standard_min', () => {
  const overrides = [{
    id: 2, machine: 'LINE-1', signature_version: 3, predecessor_order_id: 'O1', successor_order_id: 'O2',
    predecessor_state_key: st('A', 'RED'), successor_state_key: st('Z', 'BLUE'),
    standard_min: 55, remaining_min: 4, status: 'active', reason: '',
  }];
  assert.equal(both(st('A', 'RED'), st('Z', 'BLUE'), { overrides }).standardMin, 55);
});

test('no default for any changed field stays uncovered (never zero)', () => {
  const r = both(st('A', 'RED'), st('Z', 'BLUE'));
  assert.equal(r.covered, false);
  assert.equal(r.source, 'uncovered');
  assert.equal(r.effectiveMin, null);
});

test('blank to-values never contribute; a blank from-value still lets the to-value charge', () => {
  assert.equal(both(st('A', 'RED'), st('B', '')).effectiveMin, 30);
  assert.equal(both(st('A', 'RED'), st('', '')).covered, false);
  assert.equal(both(st('', 'RED'), st('B', 'RED')).effectiveMin, 30);
});

test('a 0-minute default is covered at zero, like a 0-minute plant row', () => {
  const r = both(st('A', 'RED'), st('B', 'RED'), { valueDefaults: [vd('prt01', 'B', 0)] });
  assert.equal(r.covered, true);
  assert.equal(r.source, 'value-default');
  assert.equal(r.effectiveMin, 0);
});

test('defaults of another signature version or an unknown field are ignored', () => {
  assert.equal(both(st('A', 'RED'), st('B', 'RED'), { valueDefaults: [vd('prt01', 'B', 30, 2)] }).covered, false);
  assert.equal(both(st('A', 'RED'), st('B', 'RED'), { valueDefaults: [vd('prt02', 'B', 30)] }).covered, false);
});

test('values compare normalized: lowercase default keys and true/false booleans', () => {
  const boolDef = { ...definition, fields: ['prt01'] };
  const s = v => [{ fieldKey: 'prt01', value: v }];
  const base = { ...input(s('x'), s('true')), definition: boolDef, valueDefaults: [vd('prt01', ' True ', 12)] };
  assert.equal(resolveSetup(base).effectiveMin, 12);
  // Server-form "TRUE" on a machine-state from-key is the same value as "true": no change, nothing charged.
  const same = resolveSetup({ ...base, predecessorState: s('TRUE') });
  assert.equal(same.covered, false);
  // A lowercase default key matches an uppercase state value.
  assert.equal(both(st('A', 'RED'), st('b', 'RED'), { valueDefaults: [vd('prt01', 'b', 31)] }).effectiveMin, 31);
});

test('resolveSetup tolerates missing valueDefaults at runtime (untyped callers)', () => {
  const base = input(st('A', 'RED'), st('B', 'RED'));
  delete base.valueDefaults;
  assert.equal(resolveSetup(base).source, 'uncovered');
  const index = buildSetupResolutionIndex({ definition, machineRows: [], plantRows: [], overrides: [] });
  assert.equal(resolveSetup({ ...base, index }).source, 'uncovered');
  assert.equal(index.valueDefaults.size, 0);
});

test('index precomputes version-filtered, normalized per-field maps', () => {
  const index = buildSetupResolutionIndex({
    definition, machineRows: [], plantRows: [], overrides: [],
    valueDefaults: [vd('prt01', 'b', 5), vd('prt01', 'B', 6), vd('prt01', 'C', 7, 9), vd('colorWheel', ' ', 3)],
  });
  assert.deepEqual([...index.valueDefaults.keys()], ['prt01']);
  assert.deepEqual([...index.valueDefaults.get('prt01')], [['B', 5]]);
});

test('computeShadowDiagnostics counts default-covered transitions and their minutes', () => {
  const d = new Date(2026, 9, 1, 8);
  const t = (id, prt, color, hours) => ({
    id, MACHINE: 'LINE-1', PLANT: '5512', PRT_01: prt, COLOR: color, start_date: new Date(d.getTime() + hours * 3600e3),
  });
  const snapshot = { plant: '5512', definition, plant_rows: [], machine_rows: [], overrides: [], value_defaults: DEFAULTS };
  const result = computeShadowDiagnostics(snapshot, [t('a', 'A', 'RED', 0), t('b', 'B', 'RED', 1), t('c', 'Z', 'BLUE', 2)]);
  assert.equal(result.coveredTransitions, 1);
  assert.equal(result.uncoveredTransitions, 1);
  assert.equal(result.totalStandardMinutes, 30);
  const none = computeShadowDiagnostics({ ...snapshot, value_defaults: undefined }, [t('a', 'A', 'RED', 0), t('b', 'B', 'RED', 1)]);
  assert.equal(none.uncoveredTransitions, 1);
});

test('order-derived states resolve through stateForOrder end to end', () => {
  const from = stateForOrder({ PRT_01: 'a', COLOR: 'red' }, definition);
  const to = stateForOrder({ PRT_01: 'c', COLOR: 'red' }, definition);
  assert.equal(both(from, to).effectiveMin, 60);
});
