import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  evaluateDueDateFirst, evaluateMinChangeover, evaluateSptWithSetup, fillPlanningGaps, validateCandidate,
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

  test(`${name}: every placed order's finish is the last productive edge (Reading A: the finish is the result)`, () => {
    const fixture = scaleFixture();
    const result = evaluate(fixture.snapshot, fixture.bounds);
    const byId = new Map(fixture.snapshot.tasks.map(task => [String(task.id), task]));
    let checked = 0;
    for (const patch of result.patches) {
      const { start_date: start, end_date: end, scheduleSegments } = patch.changes;
      if (!start || !end) continue;
      const runMinutes = Math.round(Number(byId.get(String(patch.id)).RUN_TIME) * 60);
      if (scheduleSegments?.length >= 2) {
        assert.equal(+end, +scheduleSegments.at(-1).endDate, `${patch.id}: end_date is the last segment end`);
        assert.equal(+start, +scheduleSegments[0].startDate, `${patch.id}: start_date is the first segment start`);
        const productive = scheduleSegments.reduce((sum, segment) => sum + (+segment.endDate - +segment.startDate) / MINUTE, 0);
        assert.equal(productive, runMinutes, `${patch.id}: segments carry exactly the run time`);
      } else {
        assert.equal((+end - +start) / MINUTE, runMinutes, `${patch.id}: an unsplit bar is start plus run time`);
      }
      checked++;
    }
    assert.equal(checked, 840, 'every order of the fixture is placed and checked');
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

// ── Tool Inventory Wave 6: the overflow pass at plant scale ─────────────────────────────────────────────────────────
// 840 orders on 70 machines, 20 tools (2-4 copies each) assigned round-robin so ~3.5 machines want every tool at the same
// time. The deterministic assertions (the pass completes, no overflow) run on an injectable FAKE clock (`fakeClock`: it never
// expires), so a loaded CI runner cannot flake them; one real-clock smoke test keeps generous bounds. The rule Off must be
// byte-identical to a snapshot with no inventory at all.
const TOOL_COUNT = 20;
function toolScaleFixture(rule, { withInventory = true, fakeClock = false } = {}) {
  const fixture = scaleFixture();
  for (const task of fixture.snapshot.tasks) {
    const machine = fixture.lines.indexOf(task.MACHINE);
    task.PRT_01 = 'TL' + String((machine + Number(task.id.slice(-2))) % TOOL_COUNT).padStart(2, '0');
  }
  if (rule) fixture.snapshot.masterData.plants[0].setup_policy_config = { toolingRule: rule };
  if (withInventory) {
    fixture.snapshot.masterData.tool_inventory = Array.from({ length: TOOL_COUNT }, (_, i) => ({
      plant: fixture.plant, tool_id: 'TL' + String(i).padStart(2, '0'), total_qty: 2 + (i % 3), out_of_service_qty: 0, note: null }));
  }
  fixture.bounds.clock = fakeClock ? () => 0 : () => performance.now();
  fixture.bounds.deadline = fixture.bounds.clock() + (fakeClock ? 1e9 : 30000);
  fixture.bounds.gapFillBudgetMs = 2000;
  return fixture;
}
const runScale = fixture => fillPlanningGaps(fixture.snapshot, { ...fixture.bounds, deadline: fixture.bounds.clock() + (fixture.bounds.clock() === 0 ? 1e9 : 30000) }, evaluateMinChangeover(fixture.snapshot, fixture.bounds));
const canonScale = result => JSON.stringify({
  patches: [...result.patches].sort((a, b) => (a.id < b.id ? -1 : 1)),
  dispositions: [...result.dispositions].sort((a, b) => (a.id < b.id ? -1 : 1)),
  score: result.score,
  findings: result.validationFindings.map(f => [f.code, f.severity, f.taskId ?? null]).sort(),
});

test('tool overflow at scale: Off (inventory loaded) and Hard-with-inventory-not-loaded are identical to a snapshot with no inventory', () => {
  const base = runScale(toolScaleFixture(null, { withInventory: false }));
  const off = runScale(toolScaleFixture('off'));
  const unloaded = runScale(toolScaleFixture('hard', { withInventory: false }));
  assert.equal(canonScale(off), canonScale(base));
  assert.equal(canonScale(unloaded), canonScale(base));
  for (const result of [off, unloaded]) { assert.equal(result.toolPass, undefined); assert.equal(result.toolBlocked, undefined); assert.equal(result.toolMoved, undefined); }
});

test('tool overflow at scale: 840 orders / 70 machines / 20 tools complete the pass (fake clock) with no overflow and no error finding', () => {
  const fixture = toolScaleFixture('hard', { fakeClock: true });
  const result = runScale(fixture);
  assert.equal(result.toolPass.complete, true, 'the pass finished (the fake clock never expires)');
  assert.deepEqual(result.validationFindings.filter(f => f.severity === 'error'), []);
  assert.ok(result.toolMoved.length > 0 || result.toolBlocked.length > 0, 'the instance genuinely contends');
  // Independent overflow check over the final schedule: distinct machines per tool at every start instant.
  const finals = finalRows(fixture.snapshot, result).filter(row => row.planning_status !== 'needs_planning' && row.start_date && row.end_date);
  const copies = tool => 2 + (Number(tool.slice(2)) % 3);
  const byTool = new Map();
  for (const row of finals) { const list = byTool.get(row.PRT_01) ?? []; list.push([+row.start_date, +row.end_date, row.MACHINE]); byTool.set(row.PRT_01, list); }
  for (const [tool, list] of byTool) {
    for (const [start] of list) {
      const machines = new Set(list.filter(([s, e]) => s <= start && start < e).map(item => item[2]));
      assert.ok(machines.size <= copies(tool), tool + ' uses ' + machines.size + ' machines at once, only ' + copies(tool) + ' copies');
    }
  }
  // The tool pass never costs more placed orders than the pure-queue outcome would (every offender queued).
  const placed = result.dispositions.filter(d => d.status === 'scheduled').length;
  assert.ok(placed >= 840 - 840 * 0.4, 'a bounded share of the plant is queued for tooling (' + placed + ' placed)');
});

test('tool overflow at scale: REAL-clock smoke (generous bounds; whether the pass completed is not asserted, a loaded runner may expire it)', () => {
  const fixture = toolScaleFixture('hard');
  const started = performance.now();
  const result = runScale(fixture);
  const elapsed = performance.now() - started;
  assert.ok(result.toolPass, 'the pass ran');
  assert.ok(result.toolPass.elapsedMs < 8000, 'pass time ' + Math.round(result.toolPass.elapsedMs) + ' ms (budget 1 s per call, soft)');
  assert.ok(elapsed < 60000, 'whole run ' + Math.round(elapsed) + ' ms');
  assert.deepEqual(result.validationFindings.filter(f => f.severity === 'error'), [], 'an expired pass still leaves no error finding');
});

test('tool overflow at scale: building the plant-wide tool index and sweeping it is fast (validateCandidate with the tool check, 840 orders, 20 tools)', () => {
  const fixture = toolScaleFixture('hard');
  const result = runScale(fixture);
  const started = performance.now();
  for (let i = 0; i < 5; i++) validateCandidate(fixture.snapshot, fixture.bounds, result);
  const perCall = (performance.now() - started) / 5;
  assert.ok(perCall < 500, 'tool-aware validation ' + Math.round(perCall) + ' ms per call');
  // 50 plants of metadata (3,500 machines) around the selected plant: the index only ever holds the selected plant's orders.
  const wide = scaleFixture({ plantCount: 50 });
  wide.snapshot.masterData.plants[0].setup_policy_config = { toolingRule: 'hard' };
  wide.snapshot.masterData.tool_inventory = [{ plant: wide.plant, tool_id: 'TL00', total_qty: 2, out_of_service_qty: 0, note: null }];
  for (const task of wide.snapshot.tasks) task.PRT_01 = 'TL00';
  const t0 = performance.now();
  validateCandidate(wide.snapshot, wide.bounds, { patches: [], dispositions: [], score: [], explanation: [], diagnostics: {}, unchangedLines: [], missingEdges: [], toolPass: { complete: true, elapsedMs: 0 } });
  assert.ok(performance.now() - t0 < 2000, 'index build over 3,500 machines of metadata ' + Math.round(performance.now() - t0) + ' ms');
});
