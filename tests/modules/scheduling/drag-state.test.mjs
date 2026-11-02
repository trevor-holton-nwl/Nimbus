import test from 'node:test';
import assert from 'node:assert/strict';
import { createDragGate } from '../../../frontend/scheduling/drag-state.mjs';

test('begin goes active once per gesture; repeated onMoving frames are no-ops', () => {
  const g = createDragGate();
  assert.equal(g.active, false);
  assert.equal(g.begin(), true);
  assert.equal(g.begin(), false);
  assert.equal(g.active, true);
});

test('end reports the active->idle edge once; extra pointerup/update ends are no-ops', () => {
  const g = createDragGate();
  assert.equal(g.end(), false);          // a plain click: no drag in flight
  g.begin();
  assert.equal(g.end(), true);           // pointerup
  assert.equal(g.end(), false);          // the dropped item's DataSet update afterwards
  assert.equal(g.active, false);
});

test('a new gesture can start after an end', () => {
  const g = createDragGate();
  g.begin(); g.end();
  assert.equal(g.begin(), true);
  assert.equal(g.active, true);
});
