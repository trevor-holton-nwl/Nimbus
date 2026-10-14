import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Distribution from '../../../frontend/distribution/distribution-pane.mjs';
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

function child(patch = {}) {
  return {
    id: 'bare', production_order: '100', material_number: 'MAT', plant: 'P', machine: 'L1',
    material_description: 'Material', run_time: 2, order_quantity: 100,
    labor_hours: 2, machine_hours: 2, scheduled_start: '2026-10-01T08:00:00',
    scheduled_end: '2026-10-01T12:00:00', start_date: '2026-10-01T08:00:00',
    end_date: '2026-10-01T12:00:00', basic_start_date: '2026-10-01T08:00:00',
    basic_finish_date: '2026-10-02T18:00:00', notes: null,
    planning_status: 'scheduled', planning_reason: null, parent_production_order: '100',
    distribution_letter: null, base_version: 42, runtime_schedule_mismatch: false,
    run_time_source: 'routing', run_time_basis: { rate: 50 },
    prt_01: 'TOOL-1', prt_02: null, production_version: '0001', firming_indicator: 'X',
    schedule_segments: [
      { sequence: 1, start_date: '2026-10-01T08:00:00', end_date: '2026-10-01T09:00:00' },
      { sequence: 2, start_date: '2026-10-01T11:00:00', end_date: '2026-10-01T12:00:00' },
    ], ...patch,
  };
}

test('collapsed distribution child retains productive segments through the next save payload', () => {
  const wire = child();
  const task = Distribution.hydrateDistributionChild(wire);
  Store._normalizeDates(task);
  assert.deepEqual(Persistence._taskEditSnapshot(task).schedule_segments, wire.schedule_segments);
  assert.equal(task.row_version, 42);
  assert.equal(task.ecc_firmed, true);
  assert.equal(task.MATERIAL_NUMBER, 'MAT');
  assert.equal(task.PLANT, 'P');
  assert.equal(task.original_end_date.getTime(), new Date(wire.basic_finish_date).getTime());
});

test('kept children replace server state, cleared attributes, and obsolete segments', () => {
  const existing = Distribution.hydrateDistributionChild(child());
  existing.firmed = true;
  const task = Distribution.hydrateDistributionChild(child({
    planning_status: 'needs_planning', planning_reason: { code: 'runtime_unknown', message: 'Missing routing' },
    start_date: null, end_date: null, scheduled_start: null, scheduled_end: null,
    schedule_segments: [], run_time: null, run_time_source: null, run_time_basis: null,
    runtime_schedule_mismatch: true, prt_01: null, production_version: null, base_version: 43,
  }), existing);
  Store._normalizeDates(task);
  assert.equal(task.start_date, null);
  assert.equal(task.end_date, null);
  assert.deepEqual(task.scheduleSegments, []);
  assert.equal(task.planning_status, 'needs_planning');
  assert.equal(task.RUN_TIME, null);
  assert.equal(task.run_time_source, null);
  assert.equal(task.run_time_basis, null);
  assert.equal(task.PRT_01, null);
  assert.equal(task.PRODUCTION_VERSION, null);
  assert.equal(task.runtime_schedule_mismatch, true);
  assert.equal(task.firmed, true);
  assert.equal(task.row_version, 43);
});

test('a child with only a stored finish counts as placed (scheduled = the stored-edge shape)', () => {
  const finishOnly = Distribution.hydrateDistributionChild(child({
    scheduled_start: null, scheduled_end: '2026-10-01T12:00:00', start_date: null, schedule_segments: [],
    runtime_schedule_mismatch: true,
  }));
  assert.equal(finishOnly.user_scheduled, true);
  const neither = Distribution.hydrateDistributionChild(child({
    scheduled_start: null, scheduled_end: null, start_date: null, end_date: null, schedule_segments: [],
  }));
  assert.equal(neither.user_scheduled, false);
  assert.equal(Distribution.hydrateDistributionChild(child()).user_scheduled, true);
});
