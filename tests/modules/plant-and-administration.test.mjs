// Tests for web/plant-and-administration.mjs — CQ-1 Phase 4 Task 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarUI, Plant, ProdLines } from '../../web/plant-and-administration.mjs';

test('CalendarUI/Plant/ProdLines expose their documented public API', () => {
  assert.equal(typeof CalendarUI.render, 'function');
  assert.equal(typeof Plant.init, 'function');
  assert.equal(typeof Plant.gotoTab, 'function');
  assert.equal(typeof ProdLines.render, 'function');
});
