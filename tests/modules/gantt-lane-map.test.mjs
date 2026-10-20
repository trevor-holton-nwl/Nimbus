// Tests for frontend/scheduling/gantt-lanes.mts - the pure lane assignment behind the Gantt's
// expandable rows. No vis, no Store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLaneMap, laneId } from '../../frontend/scheduling/gantt-lanes.mjs';

const iv = (parentId, startMs, endMs) => ({ parentId, startMs, endMs });

test('empty input has depth 0', () => {
  const r = computeLaneMap([]);
  assert.equal(r.maxDepth, 0);
  assert.equal(r.laneByParent.size, 0);
});

test('non-overlapping orders share lane 0', () => {
  const r = computeLaneMap([iv('a', 0, 10), iv('b', 20, 30)]);
  assert.equal(r.maxDepth, 1);
  assert.equal(r.laneByParent.get('a'), 0);
  assert.equal(r.laneByParent.get('b'), 0);
});

test('nested intervals stack into three lanes', () => {
  const r = computeLaneMap([iv('a', 0, 100), iv('b', 10, 90), iv('c', 20, 30)]);
  assert.equal(r.maxDepth, 3);
  assert.equal(r.laneByParent.get('a'), 0);
  assert.equal(r.laneByParent.get('b'), 1);
  assert.equal(r.laneByParent.get('c'), 2);
});

test('back-to-back orders do not stack', () => {
  const r = computeLaneMap([iv('a', 0, 10), iv('b', 10, 20), iv('c', 20, 30)]);
  assert.equal(r.maxDepth, 1);
});

test('a later order reuses a freed lane', () => {
  const r = computeLaneMap([iv('a', 0, 100), iv('b', 10, 20), iv('c', 30, 40)]);
  assert.equal(r.maxDepth, 2);
  assert.equal(r.laneByParent.get('b'), 1);
  assert.equal(r.laneByParent.get('c'), 1);
});

test('split order stays in one lane, even when a segment gap holds another order', () => {
  // s runs 0-10 and 50-60; x sits in the gap (20-30). x does not clash with s's pieces,
  // but y (5-55) clashes with both pieces so it goes to lane 1.
  const r = computeLaneMap([iv('s', 0, 10), iv('s', 50, 60), iv('x', 20, 30), iv('y', 5, 55)]);
  assert.equal(r.laneByParent.get('s'), 0);
  assert.equal(r.laneByParent.get('x'), 0);
  assert.equal(r.laneByParent.get('y'), 1);
  assert.equal(r.maxDepth, 2);
});

test('split order whose later piece clashes moves whole to the next lane', () => {
  const r = computeLaneMap([iv('a', 0, 100), iv('s', 10, 20), iv('s', 60, 70)]);
  assert.equal(r.laneByParent.get('s'), 1);
  assert.equal(r.maxDepth, 2);
});

test('ordering is stable regardless of input order; ties break by id', () => {
  const items = [iv('b', 0, 10), iv('a', 0, 10), iv('c', 5, 15)];
  const one = computeLaneMap(items);
  const two = computeLaneMap([...items].reverse());
  assert.deepEqual([...one.laneByParent.entries()].sort(), [...two.laneByParent.entries()].sort());
  assert.equal(one.laneByParent.get('a'), 0);
  assert.equal(one.laneByParent.get('b'), 1);
  assert.equal(one.laneByParent.get('c'), 2);
});

test('laneId formats the subgroup id', () => {
  assert.equal(laneId(0), 'lane-0');
  assert.equal(laneId(3), 'lane-3');
});
