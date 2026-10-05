import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Runtime } from '../../../frontend/routing/runtime-client.mjs';

// The Python producer test asserts its actual payload matches this same file.
test('actual rate-map producer contract keeps shared routing groups material-specific', () => {
  const map = JSON.parse(readFileSync(new URL('../fixtures/routing_material_map.json', import.meta.url), 'utf8'));
  Runtime._rateMapPlant = map.plant;
  Runtime._rateMap = map;
  for (const [material, hours] of [['MAT-A', 1], ['MAT-B', 3]]) {
    const result = Runtime.resolve({ PLANT: 'P', MATERIAL_NUMBER: material,
      PRODUCTION_VERSION: '0001', MACHINE: 'M', 'ORDER_QUANTITY_(GMEIN)': 60 });
    assert.equal(result.ok, true);
    assert.equal(result.hours, hours);
  }
});

test('#36 date-only validity bounds are LOCAL calendar days (valid_to is inclusive, valid_from is not a day early)', () => {
  const map = {
    plant: 'P', generated_at: '', machines: { M: 'WC' },
    pv: { 'MAT|0001': { valid_from: '2026-08-10', valid_to: '2026-08-20', lot_from: null, lot_to: null, key: 'K' } },
    ops: { 'K|WC': { minutes_per_unit: 1 } },
  };
  const priorMap = Runtime._rateMap, priorPlant = Runtime._rateMapPlant;
  Runtime._rateMap = map; Runtime._rateMapPlant = 'P';
  const at = d => Runtime.resolve({ PLANT: 'P', MATERIAL_NUMBER: 'MAT', PRODUCTION_VERSION: '0001', MACHINE: 'M',
    'ORDER_QUANTITY_(GMEIN)': 60, BASIC_START_DATE: d });
  try {
    assert.equal(at(new Date(2026, 7, 20, 23, 0)).ok, true, 'last valid day, late evening local');
    assert.equal(at(new Date(2026, 7, 10, 0, 30)).ok, true, 'first valid day, just after local midnight');
    assert.equal(at(new Date(2026, 7, 9, 23, 0)).step, 'pv_expired', 'day before valid_from is outside');
    assert.equal(at(new Date(2026, 7, 21, 0, 30)).step, 'pv_expired', 'day after valid_to is outside');
  } finally {
    Runtime._rateMap = priorMap; Runtime._rateMapPlant = priorPlant;
  }
});

test('#36 a slow plant-A rate-map response cannot overwrite plant B after the user switched', async () => {
  const { Store } = await import('../../../frontend/platform/store.mjs');
  const { Util } = await import('../../../frontend/platform/foundation.mjs');
  const priorMaster = Store.masterData, priorFetch = Util.fetchTraced;
  const priorMap = Runtime._rateMap, priorPlant = Runtime._rateMapPlant;
  const pending = {};
  Util.fetchTraced = (url) => new Promise(resolve => {
    const plant = decodeURIComponent(String(url).split('/routing/')[1].split('/')[0]);
    pending[plant] = () => resolve({ ok: true, json: () => Promise.resolve({ plant, generated_at: '', machines: {}, pv: {}, ops: {} }) });
  });
  try {
    Store.setMasterData({ plants: [{ plant: 'A', routing_runtime_enabled: true }, { plant: 'B', routing_runtime_enabled: true }], lines: [] }, 'test');
    const loadA = Runtime.load('A');
    const loadB = Runtime.load('B');
    pending.B(); await loadB;
    assert.equal(Runtime._rateMapPlant, 'B');
    pending.A(); await loadA;
    assert.equal(Runtime._rateMapPlant, 'B', 'late A response is discarded');
    assert.equal(Runtime._rateMap?.plant, 'B');
  } finally {
    Util.fetchTraced = priorFetch;
    if (priorMaster) Store.setMasterData(priorMaster, 'test');
    Runtime._rateMap = priorMap; Runtime._rateMapPlant = priorPlant;
  }
});
