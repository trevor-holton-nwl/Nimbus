// Tests for web/plant-and-administration.mjs — CQ-1 Phase 4 Tasks 1-2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarUI, Plant, ProdLines, MasterData, LaborPlanning } from '../../web/plant-and-administration.mjs';

test('CalendarUI/Plant/ProdLines expose their documented public API', () => {
  assert.equal(typeof CalendarUI.render, 'function');
  assert.equal(typeof Plant.init, 'function');
  assert.equal(typeof Plant.gotoTab, 'function');
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
