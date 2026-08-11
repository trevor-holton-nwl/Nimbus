// Tests for web/plant-and-administration.mjs — CQ-1 Phase 4 Tasks 1-3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarUI, Plant, ProdLines, MasterData, LaborPlanning, Interface, Security, AdminCockpit } from '../../web/plant-and-administration.mjs';

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
