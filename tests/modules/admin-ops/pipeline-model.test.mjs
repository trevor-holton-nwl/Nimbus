import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPipelineSteps } from '../../../frontend/admin-ops/pipeline-model.mjs';

const base = (o = {}) => ({
  inDb: 5000, plant: '1008', plantTotal: 900, queried: 862, droppedNoDates: 0,
  horizonEnd: '2026-12-01T00:00:00', sent: 862, loaded: 862, ...o,
});
const step = (m, k) => m.steps.find((s) => s.key === k);

test('database total and plant count are separate: the DB total is a chip, never a step', () => {
  const m = buildPipelineSteps(base());
  assert.equal(m.inDb, 5000);
  assert.deepEqual(m.steps.map((s) => s.key), ['plant', 'horizon', 'sent', 'loaded']);
  assert.equal(step(m, 'plant').count, 900);
  assert.ok(m.steps.every((s) => s.key !== 'db'));
});

test('DB total is never reported as 0 when the database has rows', () => {
  const m = buildPipelineSteps(base({ sent: 0, loaded: 0, queried: null, plantTotal: 0 }));
  assert.equal(m.inDb, 5000);
});

test('horizon delta is plant total minus rows inside the horizon, with the end date', () => {
  const h = step(buildPipelineSteps(base()), 'horizon');
  assert.equal(h.count, 862);
  assert.equal(h.delta.key, 'pipe.delta_beyond_horizon');
  assert.equal(h.delta.args.n, 38);
  assert.equal(h.delta.args.date, '2026-12-01T00:00:00');
  assert.equal(h.status, 'ok');
});

test('horizon delta is clamped at zero and absent when nothing is beyond it', () => {
  assert.equal(step(buildPipelineSteps(base({ plantTotal: 800, queried: 862 })), 'horizon').delta, null);
  assert.equal(step(buildPipelineSteps(base({ plantTotal: 862, horizonEnd: null })), 'horizon').delta, null);
  const plain = step(buildPipelineSteps(base({ horizonEnd: null })), 'horizon').delta;
  assert.equal(plain.key, 'pipe.delta_beyond_horizon_plain');
});

test('rows with no start or finish are a delta and a warning on the sent step', () => {
  const s = step(buildPipelineSteps(base({ droppedNoDates: 4 })), 'sent');
  assert.equal(s.status, 'warn');
  assert.deepEqual(s.delta, { key: 'pipe.delta_no_dates', args: { n: 4 } });
  assert.equal(step(buildPipelineSteps(base()), 'sent').status, 'ok');
});

test('a gap between rows sent and rows loaded is an error with the gap as the delta', () => {
  const m = buildPipelineSteps(base({ sent: 862, loaded: 850 }));
  assert.equal(m.gap, 12);
  assert.equal(step(m, 'loaded').status, 'err');
  assert.equal(step(m, 'loaded').delta.args.n, 12);
  assert.equal(buildPipelineSteps(base({ sent: 5, loaded: 9 })).gap, 0);
});

test('no plant: no steps, the database total survives', () => {
  const m = buildPipelineSteps(base({ plant: null, plantTotal: null }));
  assert.deepEqual(m.steps, []);
  assert.equal(m.inDb, 5000);
});

test('ordering holds: in DB >= plant >= horizon >= sent >= loaded for a consistent fixture', () => {
  const m = buildPipelineSteps(base({ droppedNoDates: 2, sent: 860, loaded: 860 }));
  const counts = [m.inDb, ...m.steps.map((s) => s.count)];
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i - 1] >= counts[i], counts.join(','));
});
