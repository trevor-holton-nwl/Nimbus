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
