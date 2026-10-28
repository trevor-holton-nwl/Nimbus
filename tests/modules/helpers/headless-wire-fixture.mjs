// A hand-built HeadlessWire bundle (the bodies of /tasks, /plant-calendar, /setup, /priority-rank-maps,
// /master-data/* for plant P1) shared by the headless snapshot, derivation and runner tests. Dates are naive
// local strings, as the backend emits them; run under TZ=UTC (helpers/force-utc.mjs).

export const PLANT = 'P1';
export const SERVER_NOW = new Date('2035-08-06T13:00:00Z');   // 08:00 in America/Chicago (CDT)
export const PLANT_TZ = 'America/Chicago';

const week = (open, close) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, (d === 0 || d === 6) ? null : [open, close]]));

export function taskRow(id, extra = {}) {
  return {
    id, PLANT, MACHINE: 'L1', RUN_TIME: 2, COLOR: 'GREEN', PRT_01: null, PRT_02: null,
    planning_status: 'scheduled', planning_reason: null, user_scheduled: true, row_version: 7,
    start_date: '2035-08-07T08:00:00', end_date: '2035-08-07T10:00:00',
    original_start_date: '2035-08-07T07:00:00', original_end_date: '2035-08-07T18:00:00',
    schedule_segments: [], firmed: false, ...extra,
  };
}

export function wireFixture() {
  return {
    tasks: {
      data: [
        taskRow('1002', { MACHINE: 'L2', COLOR: 'BLUE', start_date: '2035-08-07T09:00:00', end_date: '2035-08-07T11:00:00' }),
        taskRow('1001', { firmed: true }),
        taskRow('A-3', { MACHINE: 'L9', start_date: '2035-08-08T08:00:00', end_date: '2035-08-08T10:00:00' }),
        taskRow('1003', {
          MACHINE: 'L2', RUN_TIME: 4, start_date: '2035-08-08T08:00:00', end_date: '2035-08-08T16:00:00',
          schedule_segments: [
            { sequence: 1, start_date: '2035-08-08T08:00:00', end_date: '2035-08-08T10:00:00' },
            { sequence: 2, start_date: '2035-08-08T14:00:00', end_date: '2035-08-08T16:00:00' },
          ],
        }),
        taskRow('1004', { planning_status: 'needs_planning', planning_reason: { code: 'no_fit_found', message: 'x' }, start_date: null, end_date: null, user_scheduled: false }),
        taskRow('2001', { PLANT: 'P2', MACHINE: 'Z1' }),
      ],
      meta: { server_now: '2035-08-06T13:00:00Z', frozen_horizon_end: '2035-08-09T08:00:00' },
    },
    calendar: {
      calendar_version: 'cal-1',
      plant_work_hours: week(7, 19),
      line_work_hours: { L1: week(6, 22) },
      plant_periods: [{ id: 'pp1', name: 'Shutdown week', valid_from: '2035-08-13', valid_to: '2035-08-19', work_hours: week(9, 15) }],
      machine_blackouts: [{ id: 'mb1', machine: 'L1', start: '2035-08-07T12:00:00', end: '2035-08-07T13:00:00', reason: 'PM' }],
      plant_blackouts: [{ id: 'pb1', start: '2035-08-10T00:00:00', end: '2035-08-11T00:00:00', reason: 'Holiday' }],
    },
    setup: {
      plant: PLANT, plant_active: true,
      definition: { plant: PLANT, fields: ['colorWheel'], signature_version: 1, strict_blanks: true, active: true },
      plant_rows: [], machine_rows: [], machine_states: [], overrides: [],
    },
    priorityRankMaps: { color: { GREEN: 1, BLUE: 2 } },
    masterData: {
      plants: { rows: [
        { subnetwork: 'S1', plant: PLANT, timezone: PLANT_TZ, frozen_horizon_days: 3, setup_active: true, max_pull_forward_days: 3 },
        { subnetwork: 'S1', plant: 'P2', timezone: 'UTC', frozen_horizon_days: null },
      ] },
      machine: { rows: [
        { machine: 'L1', plant: PLANT, wc_group: 'G1', excl_optimizer: '', bottleneck: 'X' },
        { machine: 'L2', plant: PLANT, wc_group: 'G1', buffer_type: '%', buffer_percent: '5', sap_workcenter: 'WC2', distribution_weight: 2 },
        { machine: 'L3', plant: PLANT },
      ] },
      sap_workcenter: { rows: [{ plant: PLANT, workcenter: 'WC2' }] },
      tool_inventory: { rows: [
        { plant: PLANT, tool_id: 'T2', total_qty: 2, out_of_service_qty: 0, note: null },
        { plant: PLANT, tool_id: 'T1', total_qty: 3, out_of_service_qty: 1, note: null },
      ] },
    },
    horizons: { calendar_version: 'cal-1', tool_inventory_version: '2|2035-08-01T00:00:00Z' },
  };
}

/** The fixture plus rows the browser derives starts for: a never-placed order (finish only), a second one on a
 * machine with its own hours, and a placed order the server flagged stale (a dirty re-derivation). */
export function wireWithUnplaced() {
  const wire = wireFixture();
  wire.tasks.data.push(
    taskRow('3001', { user_scheduled: false, start_date: null, end_date: '2035-08-09T17:00:00', original_end_date: '2035-08-09T17:00:00', row_version: 3 }),
    taskRow('3002', { MACHINE: 'L2', user_scheduled: false, RUN_TIME: 6, start_date: null, end_date: '2035-08-10T17:00:00', original_end_date: '2035-08-10T17:00:00' }),
    taskRow('3003', { MACHINE: 'L2', runtime_schedule_mismatch: true, RUN_TIME: 3, start_date: '2035-08-09T09:00:00', end_date: '2035-08-09T12:00:00' }),
  );
  return wire;
}
