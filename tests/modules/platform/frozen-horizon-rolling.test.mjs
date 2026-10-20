// Rolling frozen horizon (2026-10-19): Store.frozenHorizonEnd = plant-local now + N days, computed live on
// every read (both edges of the frozen window advance with the clock, like the alert horizon).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Store } from '../../../frontend/platform/store.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';

globalThis.NimbusComputeCore ??= createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');

const HOUR = 3_600_000;
const plantRow = (days, tz = 'UTC') => ({ plant: 'FZ1', timezone: tz, frozen_horizon_days: days });

function withPlant(fn) {
  const priorMd = structuredClone(Store.masterData);
  const priorPlant = Store.selectedPlant;
  const priorOffset = Store.serverOffsetMs;
  const priorFallback = Store.frozenHorizonEnd;
  try {
    Store.setSelectedPlant('FZ1', 'unit-test');
    Store.serverOffsetMs = 0;
    fn();
  } finally {
    Store.serverOffsetMs = priorOffset;
    Store.setMasterData(priorMd, 'unit-test');
    Store.setSelectedPlant(priorPlant, 'unit-test');
    Store.setFrozenHorizonEnd(priorFallback, 'unit-test');
  }
}

test('Store.frozenHorizonEnd is plant now + N days and advances with the clock (no daily jump)', () => withPlant(() => {
  Store.setMasterData({ plants: [plantRow(2)], lines: [] }, 'unit-test');
  const t0 = Store.plantNow('FZ1').getTime();
  const end0 = Store.frozenHorizonEnd.getTime();
  assert.ok(Math.abs((end0 - t0) - 48 * HOUR) < 5_000, 'end is plant now + 2 days (UTC plant, no DST)');
  Store.serverOffsetMs = HOUR;   // the server clock is an hour later
  const end1 = Store.frozenHorizonEnd.getTime();
  assert.ok(Math.abs((end1 - end0) - HOUR) < 5_000, 'clocks an hour apart give ends an hour apart');
  assert.equal(Engine.frozenHorizonEnd().getTime() >= end1, true, 'Engine.frozenHorizonEnd reads the same live value');
}));

test('Store.frozenHorizonEnd is null when days is 0 or null, and for a plant with no valid clock (never throws)', () => withPlant(() => {
  Store.setMasterData({ plants: [plantRow(0)], lines: [] }, 'unit-test');
  assert.equal(Store.frozenHorizonEnd, null, '0 days = off');
  Store.setMasterData({ plants: [plantRow(null)], lines: [] }, 'unit-test');
  assert.equal(Store.frozenHorizonEnd, null, 'null days = off');
  // plantNow announces a clock-less plant once per session through Toast (needs a DOM); mark it
  // already announced so this Node test exercises only the null result.
  Store._blockedPlants.add('FZ1');
  Store.setMasterData({ plants: [plantRow(3, '')], lines: [] }, 'unit-test');
  assert.doesNotThrow(() => Store.frozenHorizonEnd);
  assert.equal(Store.frozenHorizonEnd, null, 'no timezone -> null');
  Store.setMasterData({ plants: [plantRow(3, 'Not/A_Zone')], lines: [] }, 'unit-test');
  assert.equal(Store.frozenHorizonEnd, null, 'unresolvable zone -> null');
  Store._blockedPlants.delete('FZ1');
}));

test('Store.frozenHorizonEnd falls back to the cached server instant only when the plant row lacks the days key', () => withPlant(() => {
  const cached = new Date('2031-01-02T03:04:05');
  Store.setMasterData({ plants: [{ plant: 'FZ1', timezone: 'UTC' }], lines: [] }, 'unit-test');
  Store.setFrozenHorizonEnd(cached, 'unit-test');
  assert.equal(Store.frozenHorizonEnd.getTime(), cached.getTime());
  Store.setMasterData({ plants: [plantRow(0)], lines: [] }, 'unit-test');
  assert.equal(Store.frozenHorizonEnd, null, 'a row that carries days=0 wins over the cached instant');
}));
