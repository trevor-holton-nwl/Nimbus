import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  evaluateDueDateFirst, evaluateMinChangeover, evaluateSptWithSetup,
} from '../../../frontend/optimization/setup-scheduler.mjs';
import {
  at, dueDateBounds, rulesSnapshot, scheduledTask, setupRow, setupTruth,
} from '../helpers/order-rules-fixture.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');

const monday = '2035-08-06';
const tuesday = '2035-08-07';
const clock = (day, time) => +at(`${day}T${time}:00`);
const hours = (start, end, mondayOpen = true) => Object.fromEntries(
  Array.from({ length: 7 }, (_, day) => [day, day === 1 && !mondayOpen ? null : [start, end]]),
);

function fixture({ siblingMondayOpen, sharedTool = false }) {
  const due = `${tuesday}T09:00:00`;
  const parent = { PARENT_ORDER: 'SAP-42', MATERIAL_NUMBER: 'MAT-42' };
  const long = {
    ...scheduledTask('long-child', 3, 'BLUE', due), ...parent,
    MACHINE: 'L1', PRT_01: 'T-LONG',
  };
  const short = {
    ...scheduledTask('short-child', 1, 'GREEN', due), ...parent,
    MACHINE: 'L2', PRT_01: sharedTool ? 'T-LONG' : 'T-SHORT',
  };
  const snapshot = rulesSnapshot([long, short], {
    split_order_policy: 'partial_allowed', min_productive_segment_minutes: 60,
    max_push_forward_days: 0,
    setup_policy_config: { unknownSetupPolicy: 'excludeFromSearch', toolingRule: 'hard' },
  });
  snapshot.calendars = {
    L1: { workHours: hours(8, 10.5) },
    L2: { workHours: hours(8, 9, siblingMondayOpen) },
  };
  snapshot.masterData.lines = [
    { plant: 'P1', machine: 'L1', sap_workcenter: 'WC-1' },
    { plant: 'P1', machine: 'L2', sap_workcenter: 'WC-1' },
  ];
  snapshot.masterData.workcenters = [{ plant: 'P1', sap_workcenter: 'WC-1', max_separation: 'day' }];
  snapshot.masterData.tool_inventory = [
    { plant: 'P1', tool_id: 'T-LONG', total_qty: 1, out_of_service_qty: 0 },
    { plant: 'P1', tool_id: 'T-SHORT', total_qty: 1, out_of_service_qty: 0 },
  ];
  const setup = setupTruth({ rows: [setupRow('GREEN', 'BLUE', 30)] });
  setup.machine_states.push({ machine: 'L2', state_key: [{ fieldKey: 'colorWheel', value: 'GREEN' }], signature_version: 1 });
  snapshot.setupSnapshot = { ...setup, plant_active: true };
  const bounds = dueDateBounds(setup, {
    now: at(`${monday}T08:00:00`), placementStart: at(`${monday}T08:00:00`),
    horizonEnd: at(`2035-08-08T09:00:00`), deadline: 1,
  });
  return { snapshot, bounds };
}

const strategies = [
  ['Due Date', (snapshot, bounds) => evaluateDueDateFirst(snapshot, bounds, 'due-date')],
  ['Min Changeover', evaluateMinChangeover],
  ['SPT', evaluateSptWithSetup],
];

for (const [name, evaluate] of strategies) {
  test(`${name}: a split child and a one-piece sibling finishing together have no distribution warning`, () => {
    const { snapshot, bounds } = fixture({ siblingMondayOpen: false });
    const original = structuredClone(snapshot);
    const result = evaluate(snapshot, bounds);
    const byId = new Map(result.patches.map(patch => [patch.id, patch.changes]));
    const long = byId.get('long-child');
    const short = byId.get('short-child');

    assert.deepEqual(result.dispositions.map(row => row.status), ['scheduled', 'scheduled']);
    assert.ok(long && short, 'both children receive placements');
    assert.deepEqual(long.scheduleSegments.map(segment => [
      +segment.startDate, +segment.endDate,
    ]), [
      [clock(monday, '08:30'), clock(monday, '10:30')],
      [clock(tuesday, '08:00'), clock(tuesday, '09:00')],
    ], '30 minutes of setup precede two productive pieces of at least 60 minutes');
    assert.equal(+long.end_date, clock(tuesday, '09:00'));
    assert.equal(+short.start_date, clock(tuesday, '08:00'));
    assert.equal(+short.end_date, +long.end_date);
    assert.equal(result.validationFindings.filter(f => f.code === 'distribution_separation').length, 0);
    assert.deepEqual(result.validationFindings.filter(f => f.severity === 'error'), []);
    assert.deepEqual(snapshot, original, 'candidate search leaves its input snapshot detached');
  });

  test(`${name}: opening the sibling machine on Monday reports separation without dropping either child`, () => {
    const { snapshot, bounds } = fixture({ siblingMondayOpen: true });
    const result = evaluate(snapshot, bounds);
    const byId = new Map(result.patches.map(patch => [patch.id, patch.changes]));
    const findings = result.validationFindings.filter(f => f.code === 'distribution_separation');

    assert.equal(+byId.get('long-child').end_date, clock(tuesday, '09:00'));
    assert.equal(+byId.get('short-child').end_date, clock(monday, '09:00'));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'warning');
    assert.deepEqual(findings[0].parents.slice().sort(), ['long-child', 'short-child']);
    assert.deepEqual(result.dispositions.map(row => row.status), ['scheduled', 'scheduled']);
  });

  test(`${name}: one shared tool cannot run both distributed children at the same instant`, () => {
    const { snapshot, bounds } = fixture({ siblingMondayOpen: false, sharedTool: true });
    const result = evaluate(snapshot, bounds);
    const statuses = new Map(result.dispositions.map(row => [row.id, row.status]));
    const byId = new Map(result.patches.map(patch => [patch.id, patch.changes]));

    assert.equal(statuses.get('long-child'), 'scheduled');
    assert.equal(statuses.get('short-child'), 'needs_planning');
    assert.equal(byId.get('short-child').planning_reason.code, 'tool_contention');
    assert.equal(result.validationFindings.filter(f => f.code === 'distribution_separation').length, 0,
      'a queued child is absent from the final distribution comparison');
    assert.deepEqual(result.validationFindings.filter(f => f.severity === 'error'), []);
  });
}
