// P1-7: the in-slice scheduler callers read patched rows only, so they use a
// shallow view; nothing in a full evaluation may clone a task row or write
// into the captured snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { evaluateDueDateFirst, evaluateMinChangeover, evaluateSptWithSetup } from '../../../frontend/optimization/setup-scheduler.mjs';
import { scaleFixture } from '../helpers/optimizer-scale-fixture.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value) || value instanceof Date) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return value;
}

const strategies = [
  ['Due Date', (snapshot, bounds) => evaluateDueDateFirst(snapshot, bounds, 'due-date')],
  ['Min Changeover', evaluateMinChangeover],
  ['SPT', evaluateSptWithSetup],
];

for (const [name, evaluate] of strategies) {
  test(`${name}: evaluation never clones a task row and tolerates a deep-frozen snapshot`, () => {
    const make = () => scaleFixture({ ordersPerLine: 4 });
    const ref = make();
    const refResult = evaluate(ref.snapshot, ref.bounds);

    const frozen = make();
    deepFreeze(frozen.snapshot.tasks);
    const realClone = globalThis.structuredClone;
    let taskClones = 0;
    globalThis.structuredClone = value => {
      if (value && typeof value === 'object' && 'MACHINE' in value && 'id' in value) taskClones += 1;
      return realClone(value);
    };
    let result;
    try { result = evaluate(frozen.snapshot, frozen.bounds); } finally { globalThis.structuredClone = realClone; }
    assert.equal(taskClones, 0, 'patched rows are viewed, not cloned');
    const strip = r => JSON.stringify([r.patches, r.dispositions, r.explanation, r.score]);
    assert.equal(strip(result), strip(refResult));
  });
}
