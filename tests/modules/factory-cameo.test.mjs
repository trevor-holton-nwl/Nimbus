import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sampleFactoryCameo, FactoryCameo } from '../../frontend/shell/factory-cameo.mjs';

test('the cameo waits one minute and repeats a bounded entrance, wave and exit on each minute', () => {
  for (const t of [-1, 0, 59.99, NaN, Infinity]) assert.equal(sampleFactoryCameo(t), null);
  for (const minute of [60, 120, 180, 3600]) {
    assert.equal(sampleFactoryCameo(minute).mode, 'enter');
    assert.equal(sampleFactoryCameo(minute + 5).mode, 'wave');
    assert.equal(sampleFactoryCameo(minute + 9).mode, 'leave');
    assert.equal(sampleFactoryCameo(minute + 11), null);
    assert.equal(sampleFactoryCameo(minute + 59.99), null);
    for (let t = 0; t < 10.8; t += 0.01) {
      const pose = sampleFactoryCameo(minute + t);
      assert.ok(pose.frame >= 0 && pose.frame < 8);
      assert.ok(pose.progress >= 0 && pose.progress <= 1);
    }
  }
});

function withArtworkRuntime(run) {
  const names = ['Image', 'document'];
  const saved = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const images = [], rendered = [], pixels = new Uint8ClampedArray([0, 255, 0, 255, 220, 160, 130, 255]);
  let canvasCount = 0;
  const atlasContext = { drawImage() {}, getImageData: () => ({ data: pixels }), putImageData() {} };
  const globals = {
    Image: class { constructor() { this.naturalWidth = 1536; this.naturalHeight = 1024; images.push(this); } },
    document: { createElement() { canvasCount++; return { getContext: () => atlasContext }; } },
  };
  names.forEach(name => Object.defineProperty(globalThis, name, { value: globals[name], configurable: true }));
  const ctx = new Proxy({ drawImage(...args) { rendered.push(args); } }, { get: (target, key) => target[key] ?? (() => {}) });
  const cameo = new FactoryCameo(), lane = { x: 100, y: 300, scale: 0.8, index: 1 };
  try { run({ cameo, images, pixels, rendered, canvasCount: () => canvasCount,
    draw: elapsed => cameo.draw(ctx, lane, elapsed, 1080) }); }
  finally {
    cameo.destroy();
    names.forEach((name, i) => saved[i] ? Object.defineProperty(globalThis, name, saved[i]) : delete globalThis[name]);
  }
}

test('artwork loads once shortly before the first cameo and composites without removing skin tones', () => {
  withArtworkRuntime(runtime => {
    runtime.draw(49.9); assert.equal(runtime.images.length, 0);
    runtime.draw(50); assert.equal(runtime.images.length, 1);
    assert.match(runtime.images[0].src, /\/shell\/assets\/chris-peterson-cameo\.png$/);
    runtime.images[0].onload();
    assert.equal(runtime.pixels[3], 0, 'green screen becomes transparent');
    assert.deepEqual([...runtime.pixels.slice(4)], [220, 160, 130, 255]);
    runtime.draw(59); assert.equal(runtime.rendered.length, 0);
    runtime.draw(65); assert.equal(runtime.rendered.length, 1);
    runtime.draw(71); assert.equal(runtime.rendered.length, 1);
    runtime.draw(125); assert.equal(runtime.rendered.length, 2);
    assert.equal(runtime.images.length, 1);
    assert.equal(runtime.canvasCount(), 1);
  });
});

test('a missing image is silent and is not requested again each frame', () => {
  withArtworkRuntime(runtime => {
    runtime.draw(50); runtime.images[0].onerror();
    runtime.draw(65); runtime.draw(125);
    assert.equal(runtime.images.length, 1); assert.equal(runtime.rendered.length, 0);
  });
});

test('sign-in disposal ignores late image callbacks and releases rendering', () => {
  withArtworkRuntime(runtime => {
    runtime.draw(50); const lateLoad = runtime.images[0].onload;
    runtime.cameo.destroy(); lateLoad(); runtime.draw(65);
    assert.equal(runtime.images[0].onload, null);
    assert.equal(runtime.images[0].onerror, null);
    assert.equal(runtime.canvasCount(), 0); assert.equal(runtime.rendered.length, 0);
  });
});

test('the packaged atlas retains its eight-frame registration', () => {
  const png = readFileSync(new URL('../../frontend/shell/assets/chris-peterson-cameo.png', import.meta.url));
  assert.equal(png.readUInt32BE(16), 1536);
  assert.equal(png.readUInt32BE(20), 1024);
});
