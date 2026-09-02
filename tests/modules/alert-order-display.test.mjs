import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Util } from '../../frontend/platform/foundation.mjs';
import { deriveSetupObservation } from '../../frontend/optimization/engine.mjs';

const require = createRequire(import.meta.url);
const Core = require('../../frontend/nimbus-compute-core.js');
globalThis.NimbusComputeCore = Core;
globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || { getElementById: () => null };

const ORDER_ID = '4b957e88d3086fada2e2d6385a644439';
const ORDER_NUMBER = '2021339583';

function allDays(window) {
  const workHours = {};
  for (let day = 0; day < 7; day += 1) workHours[day] = [...window];
  return workHours;
}

function task(overrides = {}) {
  return {
    id: ORDER_ID,
    ORDER: ORDER_NUMBER,
    PLANT: 'P1',
    MACHINE: 'L1',
    RUN_TIME: 1,
    start_date: new Date('2026-08-19T08:00:00'),
    end_date: new Date('2026-08-19T09:00:00'),
    ...overrides,
  };
}

const setup = {
  plant: 'P1',
  definition: { fields: ['colorWheel'], strict_blanks: true, signature_version: 1, active: false },
  plant_rows: [],
  machine_rows: [],
  machine_states: [],
  overrides: [],
};

test('Util.orderNumber prefers the business Order Number and never uses the task ID as a fallback', () => {
  assert.equal(Util.orderNumber(task()), ORDER_NUMBER);
  assert.equal(Util.orderNumber({ PRODUCTION_ORDER: ORDER_NUMBER }), ORDER_NUMBER);
  assert.equal(Util.orderNumber({ id: ORDER_ID }), 'order number unavailable');
});

test('computeAlerts resolves setup diagnostic IDs to Order Numbers', () => {
  const { alerts } = Core.computeAlerts({
    tasks: [task()],
    blocks: [],
    plantBlocks: [],
    calendars: { L1: { workHours: allDays([0, 24]) } },
    plants: {},
    lineSettings: { L1: { plant: 'P1' } },
    masterData: { lines: [{ machine: 'L1', plant: 'P1' }] },
    dismissed: [],
    opts: {},
    setup: {
      intervals: [],
      diagnostics: [{
        type: 'initial-state-unknown',
        line: 'L1',
        scope: 'P1/L1',
        successorOrderId: ORDER_ID,
        time: task().start_date,
      }],
    },
  });

  const alert = alerts.find(candidate => candidate.type === 'initial-state-unknown');
  assert.ok(alert);
  assert.match(alert.msg, new RegExp(ORDER_NUMBER));
  assert.doesNotMatch(alert.msg, new RegExp(ORDER_ID));
});

test('deriveSetupObservation writes Order Numbers into setup diagnostic messages', () => {
  const observation = deriveSetupObservation(setup, [task()]);
  const diagnostic = observation.diagnostics.find(candidate => candidate.type === 'initial-state-unknown');

  assert.ok(diagnostic);
  assert.match(diagnostic.message, new RegExp(ORDER_NUMBER));
  assert.doesNotMatch(diagnostic.message, new RegExp(ORDER_ID));
});
