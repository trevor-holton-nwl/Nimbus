import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../../../frontend/routing/runtime-client.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util } from '../../../frontend/platform/foundation.mjs';

// A plant has 70 machines and 2,100 materials. Routing groups deliberately
// repeat across materials; material identity must remain part of every lookup.
function rateMap(plant, factor = 1) {
  const machines = {}, pv = {}, ops = {};
  for (let i = 0; i < 70; i++) machines[`M${i}`] = `WC${i}`;
  for (let i = 0; i < 2100; i++) {
    const key = `MAT${i}|N|GROUP${i % 7}|1`;
    pv[`MAT${i}|0001`] = { key, valid_from: '2026-01-01', valid_to: '2026-12-31', lot_from: null, lot_to: null, workcenter: `WC${i % 70}` };
    ops[`${key}|WC${i % 70}`] = { minutes_per_unit: factor * (1 + i % 11) };
  }
  return { plant, generated_at: '2026-10-13T08:00:00', machines, pv, ops };
}

function order(plant, i) {
  return { id: `${plant}-${i}`, PLANT: plant, MACHINE: `M${i % 70}`, MATERIAL_NUMBER: `MAT${i}`,
    PRODUCTION_VERSION: '0001', BASIC_START_DATE: '2026-10-13T08:00:00', 'ORDER_QUANTITY_(GMEIN)': 30 };
}

function preserve(t) {
  const master = Store.masterData;
  const cache = { _rateMap: Runtime._rateMap, _rateMapPlant: Runtime._rateMapPlant, _loadSeq: Runtime._loadSeq };
  t.after(() => { Store.setMasterData(master, 'test'); Object.assign(Runtime, cache); });
  Store.setMasterData({ plants: Array.from({ length: 50 }, (_, i) => ({ plant: `P${i}`, routing_runtime_enabled: true })), lines: [] }, 'test');
}

test('50 plant switches resolve 105,000 orders with one rate fetch per plant and constant indexed work per order', async t => {
  preserve(t);
  let requests = 0, reads = 0, enumerations = 0;
  t.mock.method(Util, 'fetchTraced', async url => {
    requests++;
    const plant = String(url).match(/\/routing\/([^/]+)\/rate-map$/)?.[1];
    assert.ok(plant);
    const map = rateMap(plant, Number(plant.slice(1)) + 1);
    // Observe the real resolver's accesses to a transport response. A linear
    // scan/enumeration in the hot path is a deterministic performance regression.
    for (const field of ['machines', 'pv', 'ops']) map[field] = new Proxy(map[field], {
      get(target, key) { reads++; return Reflect.get(target, key); },
      ownKeys(target) { enumerations++; return Reflect.ownKeys(target); },
    });
    return { ok: true, json: async () => map };
  });
  let resolved = 0;
  for (let p = 0; p < 50; p++) {
    const plant = `P${p}`;
    await Runtime.load(plant);
    const beforeRevision = Store.rev();
    for (let i = 0; i < 2100; i++) {
      const task = Object.freeze(order(plant, i));
      const result = Runtime.resolve(task);
      assert.equal(result.ok, true);
      assert.equal(result.hours, (p + 1) * (1 + i % 11) / 2);
      assert.equal(result.basis.routingKey, `MAT${i}|N|GROUP${i % 7}|1`);
      assert.equal(result.basis.workcenter, `WC${i % 70}`);
      resolved++;
    }
    assert.deepEqual(Runtime.resolve(order(`P${(p + 1) % 50}`, 0)), { ok: false, step: 'pv_not_found' });
    assert.equal(Store.rev(), beforeRevision, 'preview lookups must not mutate reactive state');
    assert.equal(requests, p + 1, 'orders must reuse the plant map without extra HTTP calls');
  }
  assert.equal(resolved, 105000);
  assert.ok(reads <= 3 * resolved, 'lookup reads must remain bounded per order; fewer reads are allowed');
  assert.equal(enumerations, 0);
});

test('refreshing a large same-plant rate map replaces every material preview without retaining stale entries', async t => {
  preserve(t);
  let requests = 0;
  t.mock.method(Util, 'fetchTraced', async () => {
    const map = rateMap('P0', ++requests);
    if (requests === 2) delete map.ops['MAT2099|N|GROUP6|1|WC69'];
    return { ok: true, json: async () => map };
  });
  await Runtime.load('P0');
  const oldMap = Runtime._rateMap;
  assert.equal(Runtime.hoursFor(order('P0', 2099)), (1 + 2099 % 11) / 2);
  await Runtime.load('P0');
  assert.notEqual(Runtime._rateMap, oldMap);
  for (let i = 0; i < 2099; i++) assert.equal(Runtime.hoursFor(order('P0', i)), 1 + i % 11);
  assert.equal(Runtime.eligible(order('P0', 2099), 'M69'), false);
  assert.equal(Runtime.hoursFor(order('P0', 2099)), null);
  assert.equal(requests, 2);
});
