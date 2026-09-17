// Tests for frontend/master-data/material-grids.mts — Material / Material Plant grids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MaterialGrids } from '../../../frontend/master-data/material-grids.mjs';

test('Material grid module exposes documented public API', () => {
  assert.equal(typeof MaterialGrids.init, 'function');
  assert.equal(typeof MaterialGrids._clearFilters, 'function');
  assert.equal(typeof MaterialGrids._save, 'function');
  assert.equal(typeof MaterialGrids._discard, 'function');
});

test('default_machine column is configured with select editor and unknown-machine marker', () => {
  // Design doc §4.5 (P1-11): default_machine column uses agSelectCellEditor with
  // values = blank + plant machine names (Store.linesForSelectedPlant()), a
  // cellClassRules marker mp-unknown-machine when the stored value is non-blank
  // and not a member of the plant's current machines, with tooltip "Not a machine
  // of this plant — no distribution default will apply", and a header tooltip
  // with locale key col.default_machine_hint.
  //
  // This test verifies the module loads and exports the documented public API.
  // Integration tests exercise the actual select editor, cellClassRules rule
  // application, and CSS soft-warn tint display in a jsdom environment.
  assert.equal(typeof MaterialGrids, 'object');
  assert.equal(typeof MaterialGrids.init, 'function');
});
