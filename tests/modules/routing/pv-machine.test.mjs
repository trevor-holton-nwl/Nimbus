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

test('computeEligiblePairs: requireOps drops a pair whose routing has no operation at the work center; without it the pair stays', () => {
  const m = map();
  delete m.ops['MAT|N|G|02|WC2'];   // PV 0002 (WC2 -> M3) now has no operation
  const without = computeEligiblePairs(m, 'MAT', D('2026-09-01T00:00:00'));
  assert.ok(pairKeys(without).includes('0002|M3'));
  const withOps = computeEligiblePairs(m, 'MAT', D('2026-09-01T00:00:00'), { requireOps: true });
  assert.ok(!pairKeys(withOps).includes('0002|M3'));
  assert.ok(pairKeys(withOps).includes('0001|M1'), 'pairs that do have operations stay');
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
    'ORDER_QUANTITY_(GMEIN)': 60, BASIC_START_DATE: new Date(2026, 2, 1), original_start_date: new Date(2027, 0, 1) };
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

test('Runtime.dropDecision judges pairs with requireOps: a PV with no operation at the target work center is not offered', () => {
  const m = map();
  delete m.ops['MAT|N|G|02|WC2'];   // PV 0002 covers M3 by header work center but has no operation there
  Runtime._rateMap = m; Runtime._rateMapPlant = 'P';
  const task = { id: 't', PLANT: 'P', MATERIAL_NUMBER: 'MAT', PRODUCTION_VERSION: '0001', MACHINE: 'M1', BASIC_START_DATE: new Date(2026, 8, 1) };
  assert.deepEqual(Runtime.dropDecision(task, 'M3'), { kind: 'reject' }, 'resolve would fail no_operation_at_workcenter');
});

test('Runtime.hasMapFor: false without a map or for another plant, true for the loaded plant', () => {
  Runtime._rateMap = null; Runtime._rateMapPlant = null;
  assert.equal(Runtime.hasMapFor('P'), false);
  Runtime._rateMap = map(); Runtime._rateMapPlant = 'P';
  assert.equal(Runtime.hasMapFor('P'), true);
  assert.equal(Runtime.hasMapFor('OTHER'), false);
});

// ---- Fix wave F1 -------------------------------------------------------------------------------------------

test('F1 normPv: pads 1-3 digit numerics to 4, trims, uppercases, leaves the rest alone, null stays null', () => {
  assert.equal(Runtime.normPv('1'), '0001');
  assert.equal(Runtime.normPv('0001'), '0001');
  assert.equal(Runtime.normPv('A1'), '00A1');
  assert.equal(Runtime.normPv(' 12 '), '0012');
  assert.equal(Runtime.normPv('a1'), '00A1');
  assert.equal(Runtime.normPv('12345'), '12345');
  assert.equal(Runtime.normPv(''), '');
  assert.equal(Runtime.normPv('  '), '');
  assert.equal(Runtime.normPv(null), null);
  assert.equal(Runtime.normPv(undefined), null);
});

test('F1 S1: an order holding the unpadded PV "1" resolves against the padded map row, offers no prefixed option and keeps on drop', () => {
  Runtime._rateMap = map(); Runtime._rateMapPlant = 'P';
  const task = { id: 't', PLANT: 'P', MATERIAL_NUMBER: 'MAT', PRODUCTION_VERSION: '1', MACHINE: 'M1',
    'ORDER_QUANTITY_(GMEIN)': 60, BASIC_START_DATE: new Date(2026, 8, 1) };
  assert.equal(Runtime.resolve(task).ok, true, 'padded lookup finds MAT|0001');
  assert.deepEqual(Runtime.dropDecision(task, 'M2'), { kind: 'keep' }, 'current PV "1" is the padded 0001, which covers M2');
  assert.ok(Runtime.eligiblePairs(task).every(p => /^\d{4}$/.test(p.pv)), 'pair pvs are padded');
});

test('F1 S1b: an order holding the alphanumeric PV "A1" resolves against the padded "MAT|00A1" row and its pair is offered', () => {
  const m = map();
  m.pv['MAT|00A1'] = { key: 'MAT|N|G|01', valid_from: null, valid_to: null, workcenter: 'WC1' };
  Runtime._rateMap = m; Runtime._rateMapPlant = 'P';
  const task = { id: 't', PLANT: 'P', MATERIAL_NUMBER: 'MAT', PRODUCTION_VERSION: 'A1', MACHINE: 'M1',
    'ORDER_QUANTITY_(GMEIN)': 60, BASIC_START_DATE: new Date(2026, 8, 1) };
  assert.equal(Runtime.resolve(task).ok, true, 'A1 -> 00A1 finds MAT|00A1');
  assert.ok(pairKeys(Runtime.eligiblePairs(task, { requireOps: true })).includes('00A1|M1'), 'the 00A1|M1 pair is offered');
});

test('F1 S2: the list is the gate: a zero-rate pair is not offered, quantity 0 empties the list, a positive rate and quantity is offered and resolves', () => {
  const m = map();
  m.ops['MAT|N|G|03|WC1'] = { minutes_per_unit: 0 };   // PV 0003 published with a zero rate
  Runtime._rateMap = m; Runtime._rateMapPlant = 'P';
  const task = { id: 't', PLANT: 'P', MATERIAL_NUMBER: 'MAT', PRODUCTION_VERSION: '0001', MACHINE: 'M1',
    'ORDER_QUANTITY_(GMEIN)': 60, BASIC_START_DATE: new Date(2026, 8, 1) };
  const offered = pairKeys(Runtime.eligiblePairs(task, { requireOps: true }));
  assert.ok(!offered.some(k => k.startsWith('0003|')), 'zero_runtime pair dropped');
  assert.ok(offered.includes('0001|M1'));
  for (const pair of Runtime.eligiblePairs(task, { requireOps: true })) {
    assert.equal(Runtime.resolve({ ...task, PRODUCTION_VERSION: pair.pv }, pair.machine).ok, true, `${pair.pv}|${pair.machine} resolves`);
  }
  assert.deepEqual(Runtime.eligiblePairs({ ...task, 'ORDER_QUANTITY_(GMEIN)': 0 }, { requireOps: true }), [], 'zero quantity: nothing resolves');
  assert.ok(pairKeys(Runtime.eligiblePairs(task)).some(k => k.startsWith('0003|')), 'without requireOps the structural list is unchanged');
});

test('F1 computeEligiblePairs takes a predicate that decides each candidate under requireOps', () => {
  const seen = [];
  const pairs = computeEligiblePairs(map(), 'MAT', D('2026-09-01'), { requireOps: true, accept: (pv, machine) => { seen.push(`${pv}|${machine}`); return machine === 'M2'; } });
  assert.deepEqual(pairKeys(pairs), ['0001|M2', '0003|M2']);
  assert.ok(seen.includes('0001|M1'));
});

test('F1 reload race: load() keeps the old map until the new one lands, and clears it on a plant change', async () => {
  const { Store } = await import('../../../frontend/platform/store.mjs');
  const { Util } = await import('../../../frontend/platform/foundation.mjs');
  const priorMd = Store.masterData, priorFetch = Util.fetchTraced;
  Store.setMasterData({ ...(priorMd || {}), plants: [{ plant: 'P', routing_runtime_enabled: true }, { plant: 'Q', routing_runtime_enabled: true }] }, 'test');
  const old = map();
  Runtime._rateMap = old; Runtime._rateMapPlant = 'P';
  let release;
  const gate = new Promise(r => { release = r; });
  const fresh = { ...map(), generated_at: 'new' };
  Util.fetchTraced = async () => { await gate; return { ok: true, json: async () => fresh }; };
  try {
    const p = Runtime.load('P');
    assert.equal(Runtime._rateMap, old, 'old map still served mid-reload');
    release(); await p;
    assert.equal(Runtime._rateMap, fresh);
    Util.fetchTraced = async () => ({ ok: false });
    await Runtime.load('P');
    assert.equal(Runtime._rateMap, fresh, 'non-ok keeps the old map');
    Util.fetchTraced = async () => new Promise(() => {});
    Runtime.load('Q');
    assert.equal(Runtime._rateMap, null, 'plant changed: cleared');
  } finally {
    Util.fetchTraced = priorFetch; Store.setMasterData(priorMd, 'test');
  }
});