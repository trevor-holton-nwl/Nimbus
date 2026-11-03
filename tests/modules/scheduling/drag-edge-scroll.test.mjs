import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeScrollStep, edgeFraction, initialXShiftPx, EDGE_ZONE_PX, EDGE_MAX_SPEED_PER_S } from '../../../frontend/scheduling/drag-edge-scroll.mjs';

const rect = { left: 200, right: 1200, top: 100, bottom: 700 };
const base = { rect, spanMs: 7 * 86_400_000, widthPx: 1000, dtMs: 16, multi: false };

test('edgeFraction: zero in the middle, signed ramp inside the zone, clamped to 1 outside the panel', () => {
  assert.equal(edgeFraction(700, 200, 1200), 0);
  assert.equal(edgeFraction(200 + EDGE_ZONE_PX, 200, 1200), 0);
  assert.equal(edgeFraction(240, 200, 1200), -0.5);
  assert.equal(edgeFraction(1160, 200, 1200), 0.5);
  assert.equal(edgeFraction(50, 200, 1200), -1);
  assert.equal(edgeFraction(5000, 200, 1200), 1);
  assert.equal(edgeFraction(NaN, 200, 1200), 0);
});

test('edgeScrollStep: nothing in the middle of the panel', () => {
  assert.deepEqual(edgeScrollStep({ ...base, x: 700, y: 400 }), { shiftMs: 0, vPx: 0 });
});

test('edgeScrollStep: horizontal speed ramps with the square of depth, signed by side', () => {
  const full = edgeScrollStep({ ...base, x: 1200, y: 400 });
  assert.equal(full.vPx, 0);
  assert.ok(Math.abs(full.shiftMs - EDGE_MAX_SPEED_PER_S * base.spanMs * 0.016) < 1e-6);
  const half = edgeScrollStep({ ...base, x: 1160, y: 400 });
  assert.ok(Math.abs(half.shiftMs - full.shiftMs * 0.25) < 1e-6, 'half depth = quarter speed');
  const left = edgeScrollStep({ ...base, x: 240, y: 400 });
  assert.ok(left.shiftMs < 0);
  assert.ok(Math.abs(left.shiftMs + full.shiftMs * 0.25) < 1e-6);
});

test('edgeScrollStep: a pointer outside the panel on a side is full speed that way', () => {
  const out = edgeScrollStep({ ...base, x: 20, y: 400 });
  assert.ok(Math.abs(out.shiftMs + EDGE_MAX_SPEED_PER_S * base.spanMs * 0.016) < 1e-6);
});

test('edgeScrollStep: vertical only in the top/bottom zone, not in a side zone, never for a multi-drag', () => {
  const down = edgeScrollStep({ ...base, x: 700, y: 700 });
  assert.equal(down.shiftMs, 0);
  assert.ok(down.vPx > 0);
  const up = edgeScrollStep({ ...base, x: 700, y: 100 });
  assert.ok(up.vPx < 0);
  assert.deepEqual(edgeScrollStep({ ...base, x: 700, y: 700, multi: true }), { shiftMs: 0, vPx: 0 });
  const corner = edgeScrollStep({ ...base, x: 1200, y: 700 });
  assert.equal(corner.vPx, 0, 'a side zone wins over the vertical one');
  assert.ok(corner.shiftMs > 0);
});

test('edgeScrollStep: degenerate input is inert and a long frame is clamped', () => {
  assert.deepEqual(edgeScrollStep({ ...base, x: 1200, y: 400, dtMs: 0 }), { shiftMs: 0, vPx: 0 });
  assert.deepEqual(edgeScrollStep({ ...base, x: 1200, y: 400, spanMs: 0 }), { shiftMs: 0, vPx: 0 });
  assert.deepEqual(edgeScrollStep({ ...base, x: 1200, y: 400, widthPx: 0 }), { shiftMs: 0, vPx: 0 });
  const long = edgeScrollStep({ ...base, x: 1200, y: 400, dtMs: 5000 });
  const capped = edgeScrollStep({ ...base, x: 1200, y: 400, dtMs: 100 });
  assert.equal(long.shiftMs, capped.shiftMs);
});

test('initialXShiftPx: the pixels the window scrolled, so subtracting keeps toTime(initialX) fixed', () => {
  // 1000 px over 7 days: one day = 1000/7 px.
  assert.ok(Math.abs(initialXShiftPx(86_400_000, base.spanMs, 1000) - 1000 / 7) < 1e-9);
  assert.ok(initialXShiftPx(-86_400_000, base.spanMs, 1000) < 0);
  assert.equal(initialXShiftPx(5, 0, 1000), 0);
  assert.equal(initialXShiftPx(NaN, 1000, 1000), 0);
});
