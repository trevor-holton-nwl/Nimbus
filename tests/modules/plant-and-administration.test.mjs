// Tests for web/plant-and-administration.mjs — CQ-1 Phase 4 Tasks 1-3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarUI, Plant, ProdLines, MasterData, LaborPlanning, Interface, Security, AdminCockpit, SetupAdmin } from '../../web/plant-and-administration.mjs';

test('CalendarUI/Plant/ProdLines expose their documented public API', () => {
  assert.equal(typeof CalendarUI.render, 'function');
  assert.equal(typeof Plant.init, 'function');
  assert.equal(typeof Plant.gotoTab, 'function');
  assert.equal(typeof Plant._renderSettingsPane, 'function', 'App._renderSettingsPane was relocated bodily onto Plant in Task 1 — must land here');
  assert.equal(typeof ProdLines.render, 'function');
});

test('MasterData/LaborPlanning expose their documented public API', () => {
  assert.equal(typeof MasterData.render, 'function');
  assert.equal(typeof MasterData.syncLineSettings, 'function');
  assert.equal(typeof LaborPlanning.init, 'function');
  assert.equal(typeof LaborPlanning.render, 'function');
  assert.equal(typeof LaborPlanning.onGroupToggle, 'function');
  assert.equal(typeof LaborPlanning.clearGroupFilter, 'function');
  assert.equal(typeof LaborPlanning.prevHorizon, 'function');
  assert.equal(typeof LaborPlanning.nextHorizon, 'function');
  assert.equal(typeof LaborPlanning.setSpan, 'function');
});

test('Interface/Security/AdminCockpit expose their documented public API', () => {
  assert.equal(typeof Interface.render, 'function');
  assert.equal(typeof Security.render, 'function');
  assert.equal(typeof AdminCockpit.init, 'function');
  assert.equal(typeof AdminCockpit.render, 'function');
  assert.equal(typeof AdminCockpit._startHealthPolling, 'function');
  assert.equal(typeof AdminCockpit._stopHealthPolling, 'function');
  assert.equal(typeof AdminCockpit.gotoOvTab, 'function');
  assert.equal(typeof AdminCockpit._setSub, 'function');
});

test('Plant Settings pane exposes tree-rendering internals', () => {
  // Smoke-level, matching this file's existing thin public-API-shape style.
  // The Stage 3 priority tree's actual behavior is covered by
  // Engine.flattenConstraints' own tests in tests/modules/schedule-services.test.mjs
  // — _renderSettingsPane is a thin consumer of it (it deliberately does not
  // reimplement the flatten), and its render path needs a live DOM, which this
  // node:test suite has no jsdom for.
  assert.equal(typeof Plant._renderSettingsPane, 'function');
});

test('Plant exposes the generalized priority-list optimization API', () => {
  assert.equal(typeof Plant._renderOptimization, 'function');
  assert.equal(typeof Plant._uploadPriorityList, 'function');
  assert.equal(typeof Plant._confirmDeletePriorityList, 'function');
  assert.equal(typeof Plant._resyncOrderAttributes, 'function');
});

test('SetupAdmin keeps read, copy, and export available to non-writers', () => {
  // Regression target: hiding the entire matrix UI from a scheduler/preview
  // user would remove the inspection and export access Stage 0 requires.
  assert.deepEqual(SetupAdmin.permissionsFor({ isAdmin: false, isScheduler: false }), {
    read: true, copy: true, export: true, definitionWrite: false, matrixWrite: false, stateWrite: false,
  });
  assert.deepEqual(SetupAdmin.permissionsFor({ isAdmin: false, isScheduler: true }), {
    read: true, copy: true, export: true, definitionWrite: false, matrixWrite: false, stateWrite: true,
  });
});

test('SetupAdmin resolves sparse line rows over inherited plant rows and deletes only the override', () => {
  // Regression target: treating an override deletion as a plant-row deletion
  // would erase the shared standard instead of revealing it again.
  const from = [{ fieldKey: 'COLOR', value: 'RED' }];
  const to = [{ fieldKey: 'COLOR', value: 'BLUE' }];
  const plant = { line: '', signature_version: 4, from_key: from, to_key: to, setup_min: 20, source: 'manual' };
  const line = { line: 'L-10', signature_version: 4, from_key: from, to_key: to, setup_min: 7, source: 'manual' };
  assert.deepEqual(SetupAdmin.effectiveRows({ plantRows: [plant], lineRows: [line], line: 'L-10', version: 4 }), [{
    ...line, inherited: false, inheritedFromPlant: false,
  }]);
  assert.deepEqual(SetupAdmin.deleteRequest(line), {
    line: 'L-10', signature_version: 4, rows: [line],
  });
  assert.equal(SetupAdmin.effectiveRows({ plantRows: [plant], lineRows: [], line: 'L-10', version: 4 })[0].setup_min, 20);
  assert.equal(SetupAdmin.effectiveRows({ plantRows: [plant], lineRows: [], line: 'L-10', version: 4 })[0].inherited, true);
});

test('SetupAdmin blocks stale writes and reports why activation is unavailable after a definition change', () => {
  // Regression target: submitting an old signature version after the fields
  // changed could write rows that can never resolve against the new definition.
  assert.equal(SetupAdmin.canWriteVersion(3, 4), false);
  assert.match(SetupAdmin.activationStatus({ active: false, signature_version: 4, fields: ['COLOR'] }, { matrixVersion: 3, coveragePass: true }).reason,
    /version-matched matrix/i);
  assert.match(SetupAdmin.activationStatus({ active: false, signature_version: 4, fields: ['COLOR'] }, { matrixVersion: 4, coveragePass: false }).reason,
    /coverage pass/i);
});

test('SetupAdmin exports canonical long-form columns with plant, line, and version metadata', () => {
  // Regression target: changing labels or omitting scope/version makes an
  // exported file impossible to import deterministically into this editor.
  assert.deepEqual(SetupAdmin.csvColumns(), [
    'Plant', 'Line', 'Signature version', 'From setup state', 'To setup state', 'Setup minutes',
  ]);
});
