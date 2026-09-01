// Tests for web/admin-ops/admin-ui.mjs (AdminCockpit).
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdminCockpit } from '../../../web/admin-ops/admin-ui.mjs';

test('AdminCockpit exposes its documented public API', () => {
  assert.equal(typeof AdminCockpit.init, 'function');
  assert.equal(typeof AdminCockpit.render, 'function');
  assert.equal(typeof AdminCockpit._startHealthPolling, 'function');
  assert.equal(typeof AdminCockpit._stopHealthPolling, 'function');
  assert.equal(typeof AdminCockpit.gotoOvTab, 'function');
  assert.equal(typeof AdminCockpit._setSub, 'function');
});
