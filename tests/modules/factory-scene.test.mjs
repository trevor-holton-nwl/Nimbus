import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RefinedFactoryScene } from '../../frontend/shell/factory-scene.mjs';

// Canvas calls are irrelevant to lifecycle assertions; rendering is inspected in-browser.
function withRuntime(reduced, run) {
  const names = ['window', 'document', 'ResizeObserver', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const saved = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  let rect = { width: 1080, height: 900 }, resize, frameId = 0, now = 0, draws = 0, disconnected = false;
  const frames = new Map();
  const motion = Object.assign(new EventTarget(), { matches: reduced });
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const text = [];
  const ctx = new Proxy({ clearRect() { draws++; text.length = 0; },
    fillText(value) { text.push(value); }, measureText(value) { return { width: value.length * 6 }; },
  }, { get: (target, key) => target[key] ?? (() => {}) });
  const canvas = { getContext: () => ctx, getBoundingClientRect: () => rect };
  const globals = {
    window: { devicePixelRatio: 3, matchMedia: () => motion }, document: doc,
    performance: { now: () => now },
    ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} disconnect() { disconnected = true; } },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
  };
  for (const name of names) Object.defineProperty(globalThis, name, { value: globals[name], configurable: true });
  let scene;
  try {
    scene = new RefinedFactoryScene(canvas, { assembly: 'Assembly', inspection: 'Inspection', packing: 'Packing' });
    run({ scene, canvas, motion, doc, frames, text, draws: () => draws, disconnected: () => disconnected,
      resize: value => { rect = value; resize(); },
      tick: () => { const [id, callback] = frames.entries().next().value; frames.delete(id); now += 16; callback(now); },
    });
  } finally {
    scene?.destroy();
    names.forEach((name, i) => saved[i] ? Object.defineProperty(globalThis, name, saved[i]) : delete globalThis[name]);
  }
}

test('reduced motion draws a populated still, redraws on resize and responds to preference changes', () => {
  withRuntime(true, runtime => {
    assert.ok(runtime.draws() > 0);
    assert.equal(runtime.frames.size, 0);
    assert.equal(runtime.canvas.width, 2160, 'DPR is capped at 2');
    const before = runtime.draws();
    runtime.resize({ width: 900, height: 700 });
    assert.ok(runtime.draws() > before, 'the reduced-motion canvas does not go blank on resize');
    assert.equal(runtime.frames.size, 0);
    runtime.motion.matches = false; runtime.motion.dispatchEvent(new Event('change'));
    assert.equal(runtime.frames.size, 1);
    runtime.tick();
    assert.equal(runtime.frames.size, 1);
  });
});

test('stage captions appear once beneath A-01 and floating orders follow finished products', () => {
  withRuntime(true, runtime => {
    for (const stage of ['Assembly', 'Inspection', 'Packing']) {
      assert.equal(runtime.text.filter(value => value.includes(stage)).length, 1);
    }
    assert.ok(runtime.text.some(value => value.startsWith('WO-') && value.includes(' · ')));
    runtime.resize({ width: 560, height: 700 });
    for (const stage of ['Assembly', 'Inspection', 'Packing']) {
      assert.equal(runtime.text.filter(value => value.includes(stage)).length, 1,
        'the compact A-01 line retains the stage captions');
    }
  });
});

test('animation pauses while hidden or collapsed and resumes with only one frame pending', () => {
  withRuntime(false, runtime => {
    assert.equal(runtime.frames.size, 1);
    runtime.doc.hidden = true; runtime.doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(runtime.frames.size, 0);
    runtime.doc.hidden = false; runtime.doc.dispatchEvent(new Event('visibilitychange'));
    runtime.doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(runtime.frames.size, 1);
    runtime.resize({ width: 0, height: 0 });
    assert.equal(runtime.frames.size, 0);
    runtime.resize({ width: 1080, height: 900 });
    assert.equal(runtime.frames.size, 1);
  });
});

test('sign-in cleanup cancels frames, disconnects observation and ignores queued callbacks', () => {
  withRuntime(false, runtime => {
    runtime.scene.destroy();
    assert.equal(runtime.frames.size, 0);
    assert.equal(runtime.disconnected(), true);
    const before = runtime.draws();
    runtime.resize({ width: 1200, height: 900 });
    runtime.doc.dispatchEvent(new Event('visibilitychange'));
    runtime.motion.dispatchEvent(new Event('change'));
    assert.equal(runtime.draws(), before);
    assert.equal(runtime.frames.size, 0);
  });
});
