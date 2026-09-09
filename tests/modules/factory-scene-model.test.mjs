import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleFactoryLane, factoryLaneLayout, sampleFactoryDispatch, FACTORY_GEOMETRY } from '../../frontend/shell/factory-scene-model.mjs';

const widths = [70, 46, 34, 58, 46, 30, 42, 30, 58];

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
    assert.ok(lane.x + FACTORY_GEOMETRY.infeedCrop * lane.scale >= 0);
    assert.ok(lane.x + FACTORY_GEOMETRY.assemblyX * lane.scale > 0, 'assembly stays fully visible');
    assert.ok(lane.x + FACTORY_GEOMETRY.width * lane.scale <= 1080);
    assert.ok(lane.y + 85 * lane.scale < 900);
  }
});

test('both row envelopes remain inside the canvas with clear space between machinery and labels', () => {
  for (const width of [761, 1080, 1400, 1900]) for (const height of [561, 600, 700, 900]) {
    const [back, front] = factoryLaneLayout(width, height);
    assert.equal(back.index, 1, 'A-02 is the upper line');
    assert.equal(front.index, 0);
    assert.ok(back.y - 185 * back.scale >= 24, 'roof and callouts stay inside the canvas');
    assert.ok(front.y - 185 * front.scale - (back.y + 85 * back.scale) >= 109.9,
      `rows need at least 110px clearance at ${width}x${height}`);
    assert.ok(back.x + FACTORY_GEOMETRY.assemblyX * back.scale -
      (front.x + FACTORY_GEOMETRY.assemblyX * front.scale) >= 60,
    'the assembly cells remain visibly staggered horizontally');
    assert.ok(front.y + 85 * front.scale <= height - 24, 'front feet stay inside the canvas');
  }
});

test('carton transfers begin at real belt crossings and fill four pallet positions in order', () => {
  const g = FACTORY_GEOMETRY, period = g.spacing / g.speed;
  for (const lane of [0, 1]) {
    const first = (g.beltEnd - 960 - lane * 103) / g.speed;
    for (let i = 0; i < 12; i++) {
      const arrival = first + i * period;
      if (arrival < 0) continue;
      const crossing = sampleFactoryLane(arrival, lane, widths).items.find(item => Math.abs(item.x - g.beltEnd) < 0.001);
      assert.ok(crossing && crossing.material === 'carton');
      const start = sampleFactoryDispatch(arrival + 0.00001, lane);
      assert.equal(start.placed, i % 4);
      assert.ok(Math.abs(start.transfer.x - g.beltEnd) < 0.001);
      assert.ok(Math.abs(start.transfer.y) < 0.01);
      const end = sampleFactoryDispatch(arrival + g.transferTime - 0.00001, lane);
      assert.ok(Math.abs(end.transfer.x - (g.palletX + i % 2 * 50)) < 0.01);
      assert.ok(Math.abs(end.transfer.y - (g.palletY - Math.floor(i % 4 / 2) * 34)) < 0.01);
      const placed = sampleFactoryDispatch(arrival + g.transferTime + 0.00001, lane);
      assert.equal(placed.placed, i % 4 + 1);
      assert.equal(placed.transfer, null);
    }
  }
});

test('forklift collects only four-box pallets and clears the viewport before the next carton', () => {
  const g = FACTORY_GEOMETRY, first = (g.beltEnd - 960) / g.speed;
  const fourth = first + 3 * g.spacing / g.speed;
  let sawLoaded = false, sawCollected = false;
  for (let t = first; t < fourth + g.spacing / g.speed; t += 0.01) {
    const state = sampleFactoryDispatch(t, 0, 1600);
    if (state.forklift) {
      assert.equal(state.placed, 4);
      assert.equal(state.transfer, null);
      if (state.forklift.loaded) {
        sawLoaded = true;
        assert.ok(state.forklift.lift >= 0 && state.forklift.lift <= 12);
      }
    }
    if (state.collected) { sawCollected = true; assert.equal(state.placed, 0); }
  }
  assert.ok(sawLoaded && sawCollected);
  const next = sampleFactoryDispatch(fourth + g.spacing / g.speed + 0.001, 0);
  assert.equal(next.placed, 0);
  assert.ok(next.transfer);
  assert.equal(next.forklift, null);
  assert.deepEqual(sampleFactoryDispatch(0, 0), sampleFactoryDispatch(-10, 0));
});
