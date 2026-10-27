// Universal firm (2026-10-27, Workstream C): the pure firm-action rules and the Engine choke point built on them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  firmActionForReasons, firmReasonLabels, planFirmActions,
} from '../../../frontend/optimization/firm-actions.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || require('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

// Every subset of {running, frozen, manual}: only "nothing" and "manual only" take an action (D4).
const SUBSETS = [
  [[], 'firm'],
  [['manual'], 'unfirm'],
  [['frozen'], null],
  [['running'], null],
  [['frozen', 'manual'], null],
  [['running', 'manual'], null],
  [['frozen', 'running'], null],
  [['frozen', 'running', 'manual'], null],
];

test('firmActionForReasons: all 8 reason subsets', () => {
  assert.equal(SUBSETS.length, 8);
  for (const [reasons, expected] of SUBSETS) {
    assert.equal(firmActionForReasons(reasons), expected, `reasons ${JSON.stringify(reasons)}`);
  }
});

test('firmReasonLabels lists running, frozen, manual in that order and uses the dated frozen label when given a date', () => {
  const t = (k, p) => (p ? `${k}(${Object.values(p).join(',')})` : k);
  assert.deepEqual(firmReasonLabels(['manual', 'frozen', 'running'], { t, frozenUntil: 'Thu 30 Oct' }),
    ['ui.firm_reason_running_short', 'ui.firm_reason_frozen_until(Thu 30 Oct)', 'ui.firm_reason_manual']);
  assert.deepEqual(firmReasonLabels(['frozen'], { t }), ['ui.firm_reason_frozen']);
  assert.deepEqual(firmReasonLabels([], { t }), []);
});

test('planFirmActions splits ids and drops unknown ones', () => {
  const reasons = { a: [], b: ['manual'], c: ['frozen'], d: ['running', 'manual'] };
  const plan = planFirmActions(['a', 'b', 'c', 'd', 'ghost'], id => reasons[id] ?? null);
  assert.deepEqual(plan, { firm: ['a'], unfirm: ['b'], locked: ['c', 'd'] });
});

// ---- Engine surface -------------------------------------------------------
const NOW = new Date('2026-10-27T08:00:00');
const FROZEN_END = new Date('2026-10-30T08:00:00');
const placed = (id, start, end, extra = {}) => ({ id, PLANT: 'FP', MACHINE: 'FP-L1', user_scheduled: true, start_date: start, end_date: end, ...extra });

function withFixture(body) {
  const priorTasks = Store.tasksArr.map(t => ({ ...t }));
  const priorFirmed = new Set(Store.firmedIds);
  const priorEnd = Store.frozenHorizonEnd;
  try {
    Store.setTasks([
      placed('open', new Date('2026-11-05T08:00:00'), new Date('2026-11-05T10:00:00')),
      placed('manual', new Date('2026-11-06T08:00:00'), new Date('2026-11-06T10:00:00')),
      placed('frozen', new Date('2026-10-28T08:00:00'), new Date('2026-10-28T10:00:00')),
      placed('frozenManual', new Date('2026-10-28T11:00:00'), new Date('2026-10-28T12:00:00')),
      placed('running', new Date('2026-10-27T06:00:00'), new Date('2026-10-27T10:00:00')),
      placed('straddler', new Date('2026-10-30T06:00:00'), new Date('2026-10-30T12:00:00')),
    ], 'test');
    Store.firmedIds.clear();
    Store.setFirmed(['manual', 'frozenManual'], true, 'test');
    Store.setFrozenHorizonEnd(FROZEN_END, 'test');
    body();
  } finally {
    Store.setFrozenHorizonEnd(priorEnd, 'test');
    Store.setTasks(priorTasks, 'test');
    Store.firmedIds.clear();
    for (const id of priorFirmed) Store.firmedIds.add(id);
  }
}

test('Engine.firmActionFor / firmPlan: open, planner-only, frozen, running, locked+manual and a straddler', () => {
  withFixture(() => {
    const t = id => Store.tasks[id];
    assert.equal(Engine.firmActionFor(t('open'), NOW), 'firm');
    assert.equal(Engine.firmActionFor(t('manual'), NOW), 'unfirm');
    assert.equal(Engine.firmActionFor(t('frozen'), NOW), null);
    assert.equal(Engine.firmActionFor(t('frozenManual'), NOW), null, 'a manual firm inside the window stays unremovable (D4)');
    assert.equal(Engine.firmActionFor(t('running'), NOW), null);
    assert.equal(Engine.firmActionFor(t('straddler'), NOW), 'firm', 'a straddler is not frozen under the finish rule');
    const plan = Engine.firmPlan(['open', 'manual', 'frozen', 'frozenManual', 'running', 'straddler', 'ghost'], NOW);
    assert.deepEqual(plan, { firm: ['open', 'straddler'], unfirm: ['manual'], locked: ['frozen', 'frozenManual', 'running'] });
  });
});

test('Engine.firmReasonsText / firmStatusText name the reasons; empty when nothing firms the order', () => {
  withFixture(() => {
    assert.equal(Engine.firmReasonsText(Store.tasks.open), '');
    assert.equal(Engine.firmStatusText(Store.tasks.open), '');
    // Util.t returns the key when no locale is loaded; the reasons text still carries one entry per reason.
    const text = Engine.firmReasonsText(Store.tasks.manual);
    assert.match(text, /firm_reason_manual|Planner/);
  });
});

test('Engine.applyFirm is the choke point: it refuses locked ids and reports them', () => {
  withFixture(() => {
    const calls = [];
    const prior = Store.setFirmed;
    Store.setFirmed = function (ids, firmed, source) { calls.push({ ids: [...ids], firmed, source }); return prior.call(this, ids, firmed, source); };
    try {
      // No plant clock in this fixture: frozen/running read false in applyFirm, so lock-state is exercised on
      // firmPlan above. Here: firm only writes ids that are not yet firmed; unfirm only planner-only ids.
      const res = Engine.applyFirm(['open', 'manual', 'ghost'], true, 'test-src');
      assert.deepEqual(res, { changed: ['open'], skipped: [] });
      assert.deepEqual(calls, [{ ids: ['open'], firmed: true, source: 'test-src' }]);
      assert.equal(Store.isFirmed('open'), true);
      const res2 = Engine.applyFirm(['open', 'manual'], false, 'test-src');
      assert.deepEqual(res2.changed.sort(), ['manual', 'open']);
      assert.equal(Engine.applyFirm(['open'], false, 'x').changed.length, 0, 'nothing left to unfirm: no write');
    } finally { Store.setFirmed = prior; }
  });
});

test('Engine.applyFirm on the live plant clock skips frozen and running orders (counted in `skipped`)', () => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const priorOffset = Store.serverOffsetMs;
  withFixture(() => {
    try {
      Store.setMasterData({ plants: [{ plant: 'FP', timezone: tz }], lines: [] }, 'test');
      Store._blockedPlants.clear();
      Store.serverOffsetMs = NOW.getTime() - Date.now();
      const res = Engine.applyFirm(['open', 'frozen', 'running', 'manual'], true, 'test');
      assert.deepEqual(res.changed, ['open']);
      assert.deepEqual(res.skipped.sort(), ['frozen', 'running']);
      assert.equal(Store.isFirmed('frozen'), false, 'a frozen order is never given a planner firm');
      const res2 = Engine.applyFirm(['frozenManual', 'manual'], false, 'test');
      assert.deepEqual(res2.changed, ['manual']);
      assert.deepEqual(res2.skipped, ['frozenManual'], 'the planner firm inside the window cannot be removed');
    } finally {
      Store.serverOffsetMs = priorOffset;
      Store._blockedPlants.clear();
    }
  });
});
