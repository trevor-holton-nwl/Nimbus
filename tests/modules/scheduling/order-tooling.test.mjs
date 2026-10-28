// Tool Inventory Wave 5: the Inspector "Tooling" facts and the soft unknown-tool-id warning (frontend/scheduling/order-tooling.mts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orderToolingState, toolingRowHtml, isUnknownToolId, warnUnknownToolId } from '../../../frontend/scheduling/order-tooling.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Toast } from '../../../frontend/platform/foundation.mjs';

globalThis.NimbusComputeCore = createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null };

const at = h => new Date(`2035-08-10T${String(h).padStart(2, '0')}:00:00`);
const order = (id, line, s, e, prt = {}, plant = 'P') => ({ id, PLANT: plant, MACHINE: line, RUN_TIME: e - s, start_date: at(s), end_date: at(e), ...prt });
const inv = (tool, total, oos = 0, plant = 'P') => ({ plant, tool_id: tool, total_qty: total, out_of_service_qty: oos });

function withStore(tasks, inventory, fn) {
  const prior = { tasks: structuredClone(Store.tasksArr), md: Store.masterData };
  Store.setTasks(tasks, 'unit-test');
  Store.setMasterData({ plants: [], lines: [], workcenters: [], tool_inventory: inventory }, 'unit-test');
  try { return fn(); } finally { Store.setTasks(prior.tasks, 'unit-test'); if (prior.md) Store.setMasterData(prior.md, 'unit-test'); }
}

test('orderToolingState: available copies, peak machines in use during the order, over flag, and a missing row counts as 1 copy', () => {
  const tasks = [
    order('a', 'L1', 8, 12, { PRT_01: 't100', PRT_02: 'T200' }),
    order('b', 'L2', 9, 11, { PRT_01: 'T100' }),
    order('c', 'L3', 10, 14, { PRT_02: 'T100' }),
    order('d', 'L4', 20, 22, { PRT_01: 'T100' }),                  // not concurrent with a
    order('e', 'L9', 8, 12, { PRT_01: 'T100' }, 'OTHER'),          // another plant never counts
  ];
  withStore(tasks, [inv('T100', 3, 1)], () => {
    const s = orderToolingState(Store.tasks.a);
    assert.equal(s.state, 'ok');
    const byTool = Object.fromEntries(s.tools.map(x => [x.tool, x]));
    assert.deepEqual([byTool.T100.available, byTool.T100.inUse, byTool.T100.hasRow, byTool.T100.over], [2, 3, true, true], 'a + b + c overlap at 10:00 against 2 copies');
    assert.deepEqual([byTool.T200.available, byTool.T200.hasRow, byTool.T200.inUse, byTool.T200.over], [1, false, 1, false], 'no row: 1 copy');
    assert.equal(orderToolingState(Store.tasks.d).tools[0].inUse, 1);
  });
});

test('orderToolingState: undefined inventory reads "not loaded", an order with no tool reads none', () => {
  withStore([order('a', 'L1', 8, 12, { PRT_01: 'T1' }), order('n', 'L2', 8, 12)], undefined, () => {
    assert.equal(orderToolingState(Store.tasks.a).state, 'not_loaded');
    assert.match(toolingRowHtml(Store.tasks.a), /ui\.insp_tool_not_loaded/);
    assert.equal(orderToolingState(Store.tasks.n).state, 'none');
    assert.equal(toolingRowHtml(Store.tasks.n), '');
  });
});

test('toolingRowHtml escapes ids, links to the inventory and marks an over-limit tool', () => {
  withStore([order('a', 'L1', 8, 12, { PRT_01: 'T<1>' }), order('b', 'L2', 8, 12, { PRT_01: 'T<1>' })], [], () => {
    const html = toolingRowHtml(Store.tasks.a);
    assert.match(html, /data-act="open-tool-inventory"/);
    assert.match(html, /data-tool="T&lt;1&gt;"/);
    assert.doesNotMatch(html, /T<1>/);
    assert.match(html, /ui\.insp_tool_over/, '2 machines on a 1-copy (no row) tool');
    assert.match(html, /ui\.insp_tool_line_norow/);
  });
});

test('isUnknownToolId / warnUnknownToolId: soft toast only for a real id with no row that no other loaded order carries; one toast per edit', () => {
  const tasks = [order('a', 'L1', 8, 12, { PRT_01: 'OLD' }), order('b', 'L2', 8, 12, { PRT_01: 'KNOWN-BY-ORDER' })];
  withStore(tasks, [inv('IN-INV', 2)], () => {
    const a = Store.tasks.a;
    assert.equal(isUnknownToolId(a, 'in-inv'), false, 'has a row (case-insensitive)');
    assert.equal(isUnknownToolId(a, 'known-by-order'), false, 'another loaded order already carries it');
    assert.equal(isUnknownToolId(a, 'TYPO9'), true);
    assert.equal(isUnknownToolId(a, ''), false, 'blank clears the tool');
    assert.equal(isUnknownToolId(a, 'N/A'), false, 'placeholder');
    const prior = Toast.show; const seen = [];
    Toast.show = (m, k) => seen.push([String(m), k]);
    try {
      assert.equal(warnUnknownToolId(a, 'typo9'), true);
      assert.equal(seen.length, 1);
      assert.match(seen[0][0], /toast\.tool_id_unknown/);
      assert.equal(seen[0][1], 'warn');
      assert.equal(warnUnknownToolId(a, 'IN-INV'), false);
      assert.equal(seen.length, 1);
    } finally { Toast.show = prior; }
  });
  withStore(tasks, undefined, () => assert.equal(isUnknownToolId(Store.tasks.a, 'TYPO9'), false, 'inventory not loaded: cannot tell'));
});
