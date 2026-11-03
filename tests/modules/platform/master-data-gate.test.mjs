// A13: the shell's master-data-changed subscriber only re-syncs lines for tables that can change them
// (Store.masterDataChangeTouchesLines), and applyMasterLinesToSettings counts changes without a per-line
// JSON.stringify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../frontend/platform/store.mjs';

test('masterDataChangeTouchesLines: no table always counts; unrelated tables are skipped', () => {
  for (const t of [undefined, null, '']) assert.equal(Store.masterDataChangeTouchesLines(t), true, `no table: ${String(t)}`);
  for (const t of ['machine', 'plants', 'sap_workcenter', 'subnetworks', 'some_future_table']) {
    assert.equal(Store.masterDataChangeTouchesLines(t), true, t);
  }
  for (const t of ['tool_inventory', 'materials', 'material_plants', 'bom_items', 'roles', 'role_plants',
    'production_version', 'routing_operation', 'routing_rules']) {
    assert.equal(Store.masterDataChangeTouchesLines(t), false, t);
  }
});

test('applyMasterLinesToSettings counts only lines whose copied fields changed', () => {
  const prior = Store.masterData;
  try {
    const row = (extra = {}) => ({ machine: 'GATE-L1', plant: 'GP', wc_group: 'G1', excl_optimizer: '', bottleneck: 'X',
      buffer_type: '%', buffer_percent: 10, sap_workcenter: 'WC1', distribution_weight: 2, ...extra });
    Store.setMasterData({ plants: [{ plant: 'GP' }], lines: [row(), { ...row(), machine: 'GATE-L2' }], workcenters: [], tool_inventory: [] }, 'unit-test');
    assert.equal(Store.applyMasterLinesToSettings(), 2, 'two new lines');
    assert.equal(Store.applyMasterLinesToSettings(), 0, 'nothing changed the second time');
    const ls = Store.lineSettings['GATE-L1'];
    assert.deepEqual([ls.bottleneck, ls.bufferUnit, ls.bufferPct, ls.plGroup, ls.plant, ls.sapWorkcenter, ls.distributionWeight],
      [true, 'pct', 10, 'G1', 'GP', 'WC1', 2]);
    for (const [patch, label] of [[{ bottleneck: '' }, 'bottleneck'], [{ buffer_percent: 12 }, 'buffer pct'], [{ wc_group: 'G2' }, 'group'],
      [{ sap_workcenter: 'WC2' }, 'sap wc'], [{ distribution_weight: null }, 'weight'], [{ buffer_type: 'hrs', buffer_hours: 3 }, 'buffer unit']]) {
      Store.setMasterData({ plants: [{ plant: 'GP' }], lines: [row(patch), { ...row(), machine: 'GATE-L2' }], workcenters: [], tool_inventory: [] }, 'unit-test');
      assert.equal(Store.applyMasterLinesToSettings(), 1, `${label} change touches exactly one line`);
      Store.setMasterData({ plants: [{ plant: 'GP' }], lines: [row(), { ...row(), machine: 'GATE-L2' }], workcenters: [], tool_inventory: [] }, 'unit-test');
      Store.applyMasterLinesToSettings();
    }
  } finally {
    Store.setMasterData(prior, 'unit-test');
  }
});
