import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  evaluateDueDateFirst, evaluateMinChangeover, evaluateSptWithSetup, fillPlanningGaps,
} from '../../../frontend/optimization/setup-scheduler.mjs';
import {
  assertScalePlan, finalRows, hours, instant, MINUTE, scaleFixture, state,
} from '../helpers/optimizer-scale-fixture.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');

// These are the live UI's three setup-aware strategies. Throughput and the
// compatibility allocator are intentionally absent: neither is a UI strategy.
const strategies = [
  ['Due Date', (snapshot, bounds) => evaluateDueDateFirst(snapshot, bounds, 'due-date')],
  ['Min Changeover', evaluateMinChangeover],
  ['SPT', evaluateSptWithSetup],
];

for (const [name, evaluate] of strategies) {
  test(`${name}: 840 queued orders on 70 machines conserve demand, runtime and setup capacity`, () => {
    const fixture = scaleFixture();
    const before = structuredClone(fixture.snapshot);
    const result = evaluate(fixture.snapshot, fixture.bounds);
    const plan = assertScalePlan(fixture, result);
    assert.equal(plan.scheduledCount, 840, 'every line has enough capacity, including worst-case setup');
    assert.equal(plan.runtimeMinutes, 70 * 9 * 60);
    assert.equal(result.diagnostics.quality, 'heuristic', '12 orders/four states must avoid factorial exact traversal');
    assert.ok(result.diagnostics.seedCount >= 70, 'each populated machine gets a heuristic seed');
    assert.ok(result.diagnostics.iterationsUsed <= fixture.bounds.iterationCap);
    assert.deepEqual(fixture.snapshot, before, 'detached optimization leaves the captured read model intact');
  });

  test(`${name}: 70 capacity-constrained machines each admit exactly two orders and retain all overflow`, () => {
    const fixture = scaleFixture({ ordersPerLine: 4, colors: ['GREEN'], runtime: 1 });
    fixture.bounds.horizonEnd = instant(10);
    const result = evaluate(fixture.snapshot, fixture.bounds);
    assert.equal(assertScalePlan(fixture, result).scheduledCount, 140);
    for (const machine of fixture.lines) {
      const outcomes = result.dispositions.filter(row => row.line === machine);
      assert.equal(outcomes.filter(row => row.status === 'scheduled').length, 2);
      assert.equal(outcomes.filter(row => row.status === 'needs_planning').length, 2);
    }
  });

  test(`${name}: 70 manually firmed mid-shift orders remain exact capacity boundaries`, () => {
    const fixture = scaleFixture({ ordersPerLine: 6, colors: ['GREEN'], runtime: 1 });
    for (const machine of fixture.lines) {
      const fixed = fixture.snapshot.tasks.find(row => row.MACHINE === machine);
      Object.assign(fixed, { start_date: instant(11), end_date: instant(12), planning_status: 'scheduled', firmed: true });
      fixture.snapshot.firmedIds.push(fixed.id);
    }
    const result = evaluate(fixture.snapshot, fixture.bounds);
    assert.equal(assertScalePlan(fixture, result).scheduledCount, 420);
    assert.equal(result.dispositions.filter(row => row.status === 'protected').length, 70);
    assert.equal(result.patches.length, 350);
  });

  test(`${name}: per-machine maintenance and plant downtime consume capacity across 70 machines`, () => {
    const fixture = scaleFixture({ ordersPerLine: 6, colors: ['GREEN'], runtime: 1 });
    fixture.snapshot.plantBlocks = [{ plant: fixture.plant, start: instant(12), end: instant(13) }];
    fixture.snapshot.blocks = fixture.lines.filter((_, index) => index % 2 === 0).map(line => ({
      plant: fixture.plant, line, start: instant(9), end: instant(10),
    }));
    const result = evaluate(fixture.snapshot, fixture.bounds);
    assert.equal(assertScalePlan(fixture, result, {
      windows: machine => fixture.lines.indexOf(machine) % 2 === 0
        ? [[instant(8), instant(9)], [instant(10), instant(12)], [instant(13), instant(18)]]
        : [[instant(8), instant(12)], [instant(13), instant(18)]],
    }).scheduledCount, 420);
  });

  test(`${name}: selected machines remain isolated inside 50-plant / 3500-machine metadata`, () => {
    const fixture = scaleFixture({ ordersPerLine: 3, plantCount: 50, colors: ['GREEN'], runtime: 1 });
    const foreignLines = fixture.snapshot.masterData.lines.filter(row => row.plant !== fixture.plant);
    fixture.snapshot.tasks.push(...foreignLines.map(({ machine, plant }) => ({
      ...fixture.snapshot.tasks[0], id: `${machine}-foreign`, PLANT: plant, plant, MACHINE: machine,
    })));
    const selectedLines = [fixture.lines[0], fixture.lines[34], fixture.lines[69]];
    fixture.bounds.lines = selectedLines;
    const before = structuredClone(fixture.snapshot);
    const result = evaluate(fixture.snapshot, fixture.bounds);
    assert.equal(fixture.snapshot.masterData.lines.length, 3500);
    assert.equal(fixture.snapshot.tasks.length, 3640);
    assert.equal(assertScalePlan(fixture, result, { selectedLines }).scheduledCount, 9);
    const afterRows = finalRows(fixture.snapshot, result);
    for (let index = 0; index < before.tasks.length; index++) {
      const task = before.tasks[index];
      if (task.PLANT !== fixture.plant || !selectedLines.includes(task.MACHINE)) assert.deepEqual(afterRows[index], task);
    }
    assert.deepEqual(fixture.snapshot, before);
  });

  test(`${name}: an expired run retains 70 valid incumbents and accounts for all 140 queued orders`, () => {
    const fixture = scaleFixture({ ordersPerLine: 3, colors: ['GREEN'], runtime: 1 });
    for (const machine of fixture.lines) {
      Object.assign(fixture.snapshot.tasks.find(row => row.MACHINE === machine), {
        start_date: instant(8), end_date: instant(9), planning_status: 'scheduled',
      });
    }
    fixture.bounds.clock = () => 10000;
    fixture.bounds.deadline = 1;
    const result = evaluate(fixture.snapshot, fixture.bounds);
    assert.equal(assertScalePlan(fixture, result).scheduledCount, 70);
    assert.equal(result.searchComplete, false);
    assert.equal(result.diagnostics.iterationsUsed, 0);
    assert.equal(result.diagnostics.termination, 'deadline');
    const rows = finalRows(fixture.snapshot, result);
    for (const incumbent of fixture.snapshot.tasks.filter(row => row.start_date)) {
      assert.deepEqual(rows.find(row => row.id === incumbent.id), incumbent);
    }
  });

  test(`${name}: a cap of 17 iterations is shared by all 70 machine searches`, () => {
    const fixture = scaleFixture();
    fixture.bounds.iterationCap = 17;
    const result = evaluate(fixture.snapshot, fixture.bounds);
    const plan = assertScalePlan(fixture, result);
    assert.ok(plan.scheduledCount > 0, 'a useful partial winner survives the limit');
    assert.ok(plan.scheduledCount < 840, 'later machines must not receive a fresh search allowance');
    assert.equal(result.diagnostics.iterationsUsed, 17);
    assert.equal(result.diagnostics.termination, 'iteration-cap');
    assert.equal(result.searchComplete, false);
  });

  test(`${name}: an in-flight deadline retains a useful partial plant plan without resetting per machine`, () => {
    const fixture = scaleFixture();
    let ticks = 0;
    fixture.bounds.clock = () => ticks++;
    fixture.bounds.deadline = 150;
    const result = evaluate(fixture.snapshot, fixture.bounds);
    const plan = assertScalePlan(fixture, result);
    assert.ok(plan.scheduledCount > 0 && plan.scheduledCount < 840);
    assert.equal(result.diagnostics.termination, 'deadline');
    assert.equal(result.diagnostics.deadlineAt, 150);
    // Each search iteration checks this clock. The wall-time budget is soft:
    // accounting/validation may continue, but no line restarts sequence search.
    assert.ok(result.diagnostics.iterationsUsed > 0 && result.diagnostics.iterationsUsed <= 150);
    assert.equal(result.searchComplete, false);
  });

  test(`${name}: machine-specific setup costs decide admission independently on all 70 machines`, () => {
    const fixture = scaleFixture({ ordersPerLine: 1, colors: ['RED'], runtime: 1 });
    fixture.bounds.horizonEnd = instant(9, 10);
    fixture.setup.machine_rows = fixture.lines.filter((_, index) => index % 2 === 0).map(machine => ({
      machine, signature_version: 1, from_key: state('GREEN'), to_key: state('RED'), setup_min: 20,
    }));
    const result = evaluate(fixture.snapshot, fixture.bounds);
    assert.equal(assertScalePlan(fixture, result, {
      setupMinutes: (_from, _to, machine) => fixture.lines.indexOf(machine) % 2 === 0 ? 20 : 5,
    }).scheduledCount, 35);
    for (const [index, machine] of fixture.lines.entries()) {
      assert.equal(result.dispositions.find(row => row.line === machine).status, index % 2 === 0 ? 'needs_planning' : 'scheduled');
    }
  });

  test(`${name}: gap fill recovers capacity on 70 machines after the primary budget expires`, () => {
    const fixture = scaleFixture({ ordersPerLine: 3, colors: ['GREEN'], runtime: 1 });
    const primaryBounds = { ...fixture.bounds, clock: () => 10000, deadline: 1 };
    const primary = evaluate(fixture.snapshot, primaryBounds);
    assert.equal(primary.dispositions.filter(row => row.status === 'scheduled').length, 0);
    const result = fillPlanningGaps(fixture.snapshot, fixture.bounds, primary);
    assert.equal(assertScalePlan(fixture, result).scheduledCount, 210);
    assert.equal(result.gapFill.placed, 210);
    assert.equal(result.gapFill.complete, true);
    assert.equal(result.gapFill.unchecked, 0);
    assert.equal(result.searchComplete, false, 'capacity checking does not retroactively complete sequence search');
  });

  test(`${name}: gap fill shares its own deadline across 70 machines and preserves successful insertions`, () => {
    const fixture = scaleFixture({ ordersPerLine: 3, colors: ['GREEN'], runtime: 1 });
    const primary = evaluate(fixture.snapshot, { ...fixture.bounds, clock: () => 10000, deadline: 1 });
    let ticks = 0;
    const result = fillPlanningGaps(fixture.snapshot, { ...fixture.bounds, clock: () => ticks++ }, primary, 20);
    const plan = assertScalePlan(fixture, result);
    assert.ok(plan.scheduledCount > 0 && plan.scheduledCount < 210);
    assert.equal(result.gapFill.placed, plan.scheduledCount);
    assert.equal(result.gapFill.complete, false);
    assert.equal(result.gapFill.unchecked, 210 - plan.scheduledCount);
    for (const outcome of result.dispositions.filter(row => row.status === 'needs_planning')) {
      assert.equal(outcome.reason.code, 'search_limit', 'unchecked capacity must not be reported as a proved no-fit');
    }
  });

  test(`${name}: whole-order splits on 70 machines preserve runtime around a plant closure`, () => {
    const fixture = scaleFixture({ ordersPerLine: 1, colors: ['GREEN'], runtime: 6 });
    fixture.snapshot.masterData.plants[0].split_order_policy = 'partial_allowed';
    fixture.snapshot.plantBlocks = [{ plant: fixture.plant, start: instant(11), end: instant(13) }];
    fixture.snapshot.plants[fixture.plant].workHours = hours(8, 17);
    fixture.bounds.horizonEnd = instant(17);
    const result = evaluate(fixture.snapshot, fixture.bounds);
    const plan = assertScalePlan(fixture, result, {
      allowSplit: true, windows: () => [[instant(8), instant(11)], [instant(13), instant(17)]],
    });
    assert.equal(plan.scheduledCount, 70);
    for (const row of plan.rows) {
      assert.equal(row.scheduleSegments.length, 2);
      assert.equal(row.scheduleSegments.reduce((sum, segment) => sum + (+segment.endDate - +segment.startDate) / MINUTE, 0), 360);
    }
  });
}
