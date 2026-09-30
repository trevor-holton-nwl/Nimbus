import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Compute, Alerts } from '../../../frontend/insights/services.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
globalThis.window = {};
globalThis.document = { getElementById: () => null };
globalThis.Worker = class {
  postMessage({ id, payload }) {
    const result = globalThis.NimbusComputeCore.computeAlerts(structuredClone(payload));
    queueMicrotask(() => this.onmessage({ data: { id, ...result } }));
  }
};

test('worker alerts preserve shared tooling across lines, including split segments and incremental scope', async () => {
  const date = new Date(); date.setDate(date.getDate() + 1); date.setHours(8, 0, 0, 0);
  const at = hour => new Date(+date + hour * 3600000);
  Store.setSelectedPlant('P', 'test');
  Store.setTasks([
    { id: 'A', MACHINE: 'L1', PLANT: 'P', PRT_01: 'SHARED', RUN_TIME: 2, planning_status: 'scheduled',
      start_date: at(0), end_date: at(4), scheduleSegments: [
        { sequence: 1, startDate: at(0), endDate: at(1) }, { sequence: 2, startDate: at(3), endDate: at(4) }] },
    { id: 'B', MACHINE: 'L2', PLANT: 'P', PRT_02: 'SHARED', RUN_TIME: 1, planning_status: 'scheduled',
      start_date: at(3.5), end_date: at(4.5) },
  ], 'test');
  for (const opts of [{}, { lines: new Set(['L2']) }]) {
    Alerts._recomputeSync(opts);
    assert.equal(Store.alerts.filter(a => a.type === 'tool-conflict').length, 1);
    const actual = await Compute.alerts(opts);
    assert.equal(actual.alerts.filter(a => a.type === 'tool-conflict').length, 1);
  }
});
