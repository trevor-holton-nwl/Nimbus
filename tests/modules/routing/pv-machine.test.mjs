import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime, computeEligiblePairs, dropDecision } from '../../../frontend/routing/runtime-client.mjs';

// Seeded like machine-edit-contract.test.mjs: a plant-tagged cache the pure/sync helpers read.
const priorMap = Runtime._rateMap, priorPlant = Runtime._rateMapPlant;
afterEach(() => { Runtime._rateMap = priorMap; Runtime._rateMapPlant = priorPlant; });

function map() {
  return {
    plant: 'P', generated_at: '',
    machines: { M1: 'WC1', M2: 'WC1', M3: 'WC2', M4: 'WC3' },
    pv: {
      'MAT|0001': { key: 'MAT|N|G|01', valid_from: null, valid_to: null, workcenter: 'WC1' },
      'MAT|0002': { key: 'MAT|N|G|02', valid_from: null, valid_to: null, workcenter: 'WC2' },
      'MAT|0003': { key: 'MAT|N|G|03', valid_from: null, valid_to: null, workcenter: 'WC1' },   // M1/M2 again, under a second PV
      'MAT|0004': { key: 'MAT|N|G|04', valid_from: null, valid_to: null, workcenter: '' },      // blank header WC: offers nothing
      'MAT|0005': { key: 'MAT|N|G|05', valid_from: '2026-01-01', valid_to: '2026-06-30', workcenter: 'WC3' },
      'OTHER|0001': { key: 'OTHER|N|G|01', valid_from: null, valid_to: null, workcenter: 'WC1' },
    },
    ops: {
      'MAT|N|G|01|WC1': { minutes_per_unit: 1 }, 'MAT|N|G|02|WC2': { minutes_per_unit: 1 },
      'MAT|N|G|03|WC1': { minutes_per_unit: 1 }, 'MAT|N|G|05|WC3': { minutes_per_unit: 1 },
    },
  };
}

const D = (s) => new Date(s);
const pairKeys = (pairs) => pairs.map(p => `${p.pv}|${p.machine}`);

test('computeEligiblePairs: only the material own PVs, sorted pv then machine, machine may sit under two PVs', () => {
  const pairs = computeEligiblePairs(map(), 'MAT', D('2026-09-01T00:00:00'));
  assert.deepEqual(pairKeys(pairs), ['0001|M1', '0001|M2', '0002|M3', '0003|M1', '0003|M2']);
  assert.equal(pairs[0].workcenter, 'WC1');
});

test('computeEligiblePairs: a blank-work-center PV offers no machines', () => {
  const pairs = computeEligiblePairs(map(), 'MAT', D('2026-03-01T00:00:00'));
  assert.ok(!pairs.some(p => p.pv === '0004'));
});

test('computeEligiblePairs: the validity window decides which PVs are options (inclusive bounds)', () => {
  const m = map();
  const inside = computeEligiblePairs(m, 'MAT', new Date(2026, 5, 30, 23, 0));
  assert.deepEqual(inside.filter(p => p.pv === '0005').map(p => p.machine), ['M4'], 'valid_to day is inside');
  const after = computeEligiblePairs(m, 'MAT', new Date(2026, 6, 1, 0, 30));
  assert.ok(!after.some(p => p.pv === '0005'), 'expired PV is not an option');
  const before = computeEligiblePairs(m, 'MAT', new Date(2025, 11, 31, 23, 0));
  assert.ok(!before.some(p => p.pv === '0005'), 'not yet valid');
});

test('computeEligiblePairs: unknown material is empty', () => {
  assert.deepEqual(computeEligiblePairs(map(), 'NOPE', D('2026-03-01T00:00:00')), []);
});

test('dropDecision: keep / switch / choose / reject', () => {
  const pairs = computeEligiblePairs(map(), 'MAT', D('2026-09-01T00:00:00'));
  assert.deepEqual(dropDecision(pairs, '0001', 'M1'), { kind: 'keep' }, 'current PV covers the target');
  assert.deepEqual(dropDecision(pairs, '0001', 'M3'), { kind: 'switch', pv: '0002' }, 'exactly one other PV');
  assert.deepEqual(dropDecision(pairs, '0002', 'M1'), { kind: 'choose', pvs: ['0001', '0003'] }, 'two or more PVs');
  assert.deepEqual(dropDecision(pairs, '0003', 'M1'), { kind: 'keep' }, 'keep wins even when others also cover');
  assert.deepEqual(dropDecision(pairs, '0001', 'M4'), { kind: 'reject' }, 'no PV covers an expired-only machine');
  assert.deepEqual(dropDecision(pairs, null, 'M3'), { kind: 'switch', pv: '0002' }, 'an order without a PV takes the only one');
  assert.deepEqual(dropDecision(pairs, '0001', 'GHOST'), { kind: 'reject' });
});

test('Runtime.eligiblePairs / dropDecision read the cache, judge validity on BASIC_START_DATE then original_start_date', () => {
  Runtime._rateMap = map(); Runtime._rateMapPlant = 'P';
  const task = { id: 't', PLANT: 'P', MATERIAL_NUMBER: 'MAT', PRODUCTION_VERSION: '0001', MACHINE: 'M1',
    BASIC_START_DATE: new Date(2026, 2, 1), original_start_date: new Date(2027, 0, 1) };
  assert.ok(Runtime.eligiblePairs(task).some(p => p.pv === '0005'), 'BASIC_START_DATE wins');
  const snapped = { ...task, BASIC_START_DATE: null };
  assert.ok(!Runtime.eligiblePairs(snapped).some(p => p.pv === '0005'), 'falls back to original_start_date (2027: expired)');
  assert.deepEqual(Runtime.dropDecision(task, 'M3'), { kind: 'switch', pv: '0002' });
  assert.deepEqual(Runtime.dropDecision({ ...task, PLANT: 'OTHER_PLANT' }, 'M3'), { kind: 'reject' }, 'plant guard: stale cache offers nothing');
});

test('Runtime.resolve: a PV whose header work center differs from the machine, or is blank, is pv_workcenter_mismatch', () => {
  Runtime._rateMap = map(); Runtime._rateMapPlant = 'P';
  const base = { id: 't', PLANT: 'P', MATERIAL_NUMBER: 'MAT', 'ORDER_QUANTITY_(GMEIN)': 60,
    BASIC_START_DATE: new Date(2026, 8, 1) };
  assert.equal(Runtime.resolve({ ...base, PRODUCTION_VERSION: '0001', MACHINE: 'M1' }).ok, true);
  assert.deepEqual(Runtime.resolve({ ...base, PRODUCTION_VERSION: '0001', MACHINE: 'M3' }),
    { ok: false, step: 'pv_workcenter_mismatch' });
  assert.deepEqual(Runtime.resolve({ ...base, PRODUCTION_VERSION: '0004', MACHINE: 'M1' }),
    { ok: false, step: 'pv_workcenter_mismatch' }, 'blank header work center fails closed');
  assert.equal(Runtime.eligible({ ...base, PRODUCTION_VERSION: '0001' }, 'M3'), false);
});

test('Runtime.resolve: with no start date at all validity is judged today', () => {
  const m = map();
  m.pv['MAT|0001'] = { ...m.pv['MAT|0001'], valid_from: '2020-01-01', valid_to: '2020-12-31' };
  Runtime._rateMap = m; Runtime._rateMapPlant = 'P';
  assert.deepEqual(Runtime.resolve({ id: 't', PLANT: 'P', MATERIAL_NUMBER: 'MAT', PRODUCTION_VERSION: '0001',
    MACHINE: 'M1', 'ORDER_QUANTITY_(GMEIN)': 60 }), { ok: false, step: 'pv_expired' });
});
