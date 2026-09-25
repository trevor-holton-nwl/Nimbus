// tests/modules/routing/runtime-client.test.mjs — parity pin for
// frontend/routing/runtime-client.mts's Runtime.resolve() against the SAME
// fixture backend/routing/resolver.py's own test (tests/test_routing_resolver.py)
// uses, per ROUTING_RUNTIME_DESIGN.md §10. The fixture's rows are shaped like
// resolver.py's resolve_one inputs (plain production_version/routing_operation
// rows), not like the rate-map payload Runtime actually consumes — this file
// adapts each fixture case into a rate-map shape (mirroring resolver.py's own
// build_rate_map/_build_ops_map aggregation at order_quantity=1) before
// driving Runtime.resolve, so a drift in either side's aggregation/rounding
// would show up as a mismatch here.
//
// Only fixture cases whose expected status is 'resolved' apply: Runtime has
// no client-side equivalent of the server's sap_order/legacy fallback chain
// (§5.2's fallback order needs machine_hours/existing run_time, data the
// rate map never carries) — those cases are the resolver's own P2 concern,
// pinned by tests/test_routing_resolver.py instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Runtime } from '../../../frontend/routing/runtime-client.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/routing_cases.json', import.meta.url),
);
const { cases } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

// -- Rate-map builders, mirroring backend/routing/resolver.py's pure
//    functions (_to_hours / _pick_operation_hours / _select_operations /
//    _build_ops_map), at order_quantity=1 — same reasoning build_rate_map
//    itself uses so ops[...].minutes_per_unit can never silently drift from
//    what resolve_one would compute for a real order. --------------------
const HOUR_UNITS = new Set(['H', 'HR', 'HRS', 'HOUR', 'HOURS']);
const MINUTE_UNITS = new Set(['MIN', 'MINS', 'MINUTE', 'MINUTES']);
const SECOND_UNITS = new Set(['S', 'SEC', 'SECS', 'SECOND', 'SECONDS']);

function toHours(value, unit) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const u = String(unit || '').trim().toUpperCase();
  if (HOUR_UNITS.has(u)) return num;
  if (MINUTE_UNITS.has(u)) return num / 60;
  if (SECOND_UNITS.has(u)) return num / 3600;
  return null;
}

function pickOperationHoursPerUnit(op) {
  let rawValue, unit;
  if (op.workcenter_category === '0001') {
    rawValue = op.std_value_machine; unit = op.std_value_unit_machine;
  } else if (op.workcenter_category === '0003') {
    rawValue = op.std_value_labor; unit = op.std_value_unit_labor;
  } else {
    return null; // other_category
  }
  if (!op.base_quantity) return null; // invalid_base_quantity
  const hours = toHours(rawValue, unit);
  if (hours === null) return null; // unit_not_time
  return hours / op.base_quantity; // qty=1, matching build_rate_map
}

function selectOperations(operations, workcenter, rules) {
  const excludeControlKeys = new Set(rules.control_key_exclude || []);
  const includeStatuses = new Set(rules.header_status_include || []);
  return operations.filter((op) => {
    if (op.deleted) return false;
    if ((op.sequence_category || '0') !== '0') return false;
    if (op.sap_workcenter !== workcenter) return false;
    if (excludeControlKeys.has(op.control_key)) return false;
    if (includeStatuses.size && !includeStatuses.has(op.header_status)) return false;
    return true;
  });
}

/** Builds the rate-map slice ({ machines, pv, ops }) one fixture case's own
 *  production_versions/operations/machine_workcenter/rules rows would
 *  produce through build_rate_map, scoped to just that case's one routing. */
function buildRateMapForCase(caseDef) {
  const pvRow = caseDef.production_versions[0];
  const routingKey = `${pvRow.task_list_type}|${pvRow.routing_group}|${pvRow.group_counter}`;
  const pv = {
    [`${pvRow.material_id}|${pvRow.production_version}`]: {
      valid_from: pvRow.valid_from,
      valid_to: pvRow.valid_to,
      lot_from: pvRow.lot_size_from,
      lot_to: pvRow.lot_size_to,
      key: routingKey,
    },
  };

  const workcenters = new Set(caseDef.operations.map((op) => op.sap_workcenter).filter(Boolean));
  const ops = {};
  for (const wc of workcenters) {
    const selected = selectOperations(caseDef.operations, wc, caseDef.rules || {});
    if (!selected.length) continue; // no_operation_at_workcenter — no key published
    let totalMinutes = 0;
    for (const op of selected) {
      const hoursPerUnit = pickOperationHoursPerUnit(op);
      if (hoursPerUnit === null) continue;
      totalMinutes += hoursPerUnit * 60;
    }
    ops[`${routingKey}|${wc}`] = { minutes_per_unit: totalMinutes };
  }

  return { plant: caseDef.order.plant, generated_at: '', machines: { ...caseDef.machine_workcenter }, pv, ops };
}

function taskFromCase(caseDef) {
  const order = caseDef.order;
  return {
    id: caseDef.name,
    MACHINE: order.machine,
    PRODUCTION_VERSION: order.production_version,
    MATERIAL_NUMBER: order.material_number,
    'ORDER_QUANTITY_(GMEIN)': order.order_quantity,
    BASIC_START_DATE: order.basic_start_date ? new Date(order.basic_start_date) : null,
  };
}

const resolvedCases = cases.filter((c) => c.expected.status === 'resolved');

test('runtime-client.resolve: parity with resolver.py fixture ("resolved" cases)', () => {
  assert.ok(resolvedCases.length > 0, 'fixture must contain at least one resolved case');

  for (const caseDef of resolvedCases) {
    Runtime._rateMap = buildRateMapForCase(caseDef);
    Runtime._rateMapPlant = caseDef.order.plant;

    const task = taskFromCase(caseDef);
    const result = Runtime.resolve(task);

    const expectedHours = caseDef.expected.expected_minutes !== undefined
      ? caseDef.expected.expected_minutes / 60
      : caseDef.expected.run_time;

    assert.equal(result.ok, true, `${caseDef.name}: expected resolve() to succeed, got ${JSON.stringify(result)}`);
    assert.equal(result.hours, expectedHours, `${caseDef.name}: hours mismatch`);
    assert.equal(result.basis.source, 'routing');
  }
});

test('runtime-client.eligible/hoursFor: thin wrappers over resolve()', () => {
  const caseDef = resolvedCases[0];
  Runtime._rateMap = buildRateMapForCase(caseDef);
  Runtime._rateMapPlant = caseDef.order.plant;
  const task = taskFromCase(caseDef);

  assert.equal(Runtime.eligible(task, task.MACHINE), true);
  assert.equal(Runtime.hoursFor(task, task.MACHINE), Runtime.resolve(task, task.MACHINE).hours);
});

test('runtime-client.resolve: pv_missing when the task has no production version', () => {
  Runtime._rateMap = { plant: 'P1', generated_at: '', machines: {}, pv: {}, ops: {} };
  Runtime._rateMapPlant = 'P1';
  const result = Runtime.resolve({ id: 'x', MACHINE: 'M1' });
  assert.deepEqual(result, { ok: false, step: 'pv_missing' });
});

test('runtime-client.resolve: falls through the same step sequence with no cached map at all', () => {
  Runtime._rateMap = null;
  Runtime._rateMapPlant = null;
  const result = Runtime.resolve({ id: 'x', MACHINE: 'M1', PRODUCTION_VERSION: '0001', MATERIAL_NUMBER: 'MAT1' });
  assert.deepEqual(result, { ok: false, step: 'pv_not_found' });
});

// -- Cross-plant cache-race guard (code-review fix) --------------------------
// A planner switching plant A -> plant B can drag/edit a plant-B task before
// Runtime.load('B')'s fetch resolves. Without a plant-match check, resolve()
// would evaluate that task against A's still-cached machines/pv/ops.

test('runtime-client.resolve: rejects when the task names a plant that does not match the cached rate map\'s plant', () => {
  const caseDef = resolvedCases[0];
  // Cache holds a fully-valid, resolvable map -- but for plant A.
  Runtime._rateMap = buildRateMapForCase(caseDef);
  Runtime._rateMapPlant = 'PLANT-A';
  const task = { ...taskFromCase(caseDef), PLANT: 'PLANT-B' };

  const result = Runtime.resolve(task);
  assert.equal(result.ok, false, `expected resolve() to reject a cross-plant task, got ${JSON.stringify(result)}`);
});

test('runtime-client.resolve: still succeeds for the SAME plant after a normal load (parity, not regressed by the plant-match guard)', () => {
  const caseDef = resolvedCases[0];
  Runtime._rateMap = buildRateMapForCase(caseDef);
  Runtime._rateMapPlant = caseDef.order.plant;
  const task = { ...taskFromCase(caseDef), PLANT: caseDef.order.plant };

  const result = Runtime.resolve(task);
  assert.equal(result.ok, true, `expected resolve() to still succeed for a same-plant task, got ${JSON.stringify(result)}`);
});

test('runtime-client.load: clears the cached map SYNCHRONOUSLY, before its own fetch resolves — closes the cross-plant race window', async () => {
  const priorMasterData = Store.masterData;
  const priorFetch = globalThis.fetch;
  const caseDef = resolvedCases[0];
  try {
    Store.setMasterData({ plants: [{ plant: 'PLANT-B', routing_runtime_enabled: true }] }, 'test');

    // Seed the cache as if plant A's load already landed.
    Runtime._rateMap = buildRateMapForCase(caseDef);
    Runtime._rateMapPlant = 'PLANT-A';

    // Simulate an in-flight fetch for plant B that hasn't resolved yet.
    let releaseFetch;
    globalThis.fetch = () => new Promise(resolve => { releaseFetch = resolve; });

    const loadPromise = Runtime.load('PLANT-B');

    // Before the fetch resolves, the stale plant-A map must already be gone —
    // a resolve() call for a plant-B task in this window must not see it.
    assert.equal(Runtime._rateMap, null,
      'Runtime._rateMap must be cleared synchronously at the start of load(), before the await');

    const bTask = { ...taskFromCase(caseDef), PLANT: 'PLANT-B' };
    const midFlightResult = Runtime.resolve(bTask);
    assert.equal(midFlightResult.ok, false,
      'resolve() must not succeed against a stale cross-plant map while a new load() is in flight');

    // Let the fetch resolve and clean up.
    releaseFetch({ ok: true, json: () => Promise.resolve(buildRateMapForCase(caseDef)) });
    await loadPromise;
    assert.equal(Runtime._rateMapPlant, 'PLANT-B');
  } finally {
    globalThis.fetch = priorFetch;
    Store.setMasterData(priorMasterData, 'test');
  }
});
