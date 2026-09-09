import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleFactoryLane, factoryLaneLayout, FACTORY_GEOMETRY } from '../../frontend/shell/factory-scene-model.mjs';

const widths = [70, 46, 34, 58, 42, 30, 42, 30, 58];

test('a product travels continuously through assembly, inspection and packing before leaving', () => {
  const seen = new Set();
  let previous;
  for (let time = 0; time < 40; time += 0.1) {
    const item = sampleFactoryLane(time, 0, widths).items.find(candidate => candidate.serial === 0);
    if (!item) continue;
    seen.add(item.material);
    if (previous) {
      assert.ok(item.x > previous.x, 'transport advances to the right');
      assert.equal(item.productIndex, previous.productIndex, 'same product survives all stations');
      assert.ok(Math.abs(item.x - previous.x - FACTORY_GEOMETRY.speed * 0.1) < 0.001);
    }
    previous = item;
  }
  assert.deepEqual([...seen], ['raw', 'finished', 'carton']);
});

test('the production loop starts populated, stays bounded and keeps products separated', () => {
  for (const time of [0, 5, 20, 100, 3600]) {
    const lane = sampleFactoryLane(time, 1, widths);
    assert.equal(lane.items.length, 6);
    const ordered = [...lane.items].sort((a, b) => a.x - b.x);
    for (let i = 1; i < ordered.length; i++) {
      assert.ok(ordered[i].x - ordered[i - 1].x > widths[ordered[i - 1].productIndex] + 30);
    }
    assert.ok(lane.items.some(item => item.material === 'finished'));
  }
});

test('inspection lights only while a finished product intersects the inspection beam', () => {
  let hits = 0;
  for (let t = 0; t < 20; t += 0.1) {
    const lane = sampleFactoryLane(t, 0, widths);
    const crossing = lane.items.some(item => item.material === 'finished' && item.x <= FACTORY_GEOMETRY.scanX &&
      item.x + widths[item.productIndex] >= FACTORY_GEOMETRY.scanX);
    assert.equal(lane.inspecting, crossing);
    if (crossing) hits++;
  }
  assert.ok(hits > 0);
});

test('layout uses two lanes on a large scene, one on a compact scene, and none when hidden', () => {
  assert.equal(factoryLaneLayout(1080, 900).length, 2);
  assert.equal(factoryLaneLayout(560, 700).length, 1);
  assert.deepEqual(factoryLaneLayout(0, 0), []);
  for (const lane of factoryLaneLayout(1080, 900)) {
    assert.ok(lane.x >= 0);
    assert.ok(lane.x + FACTORY_GEOMETRY.width * lane.scale <= 1080);
    assert.ok(lane.y + 85 * lane.scale < 900);
  }
});
