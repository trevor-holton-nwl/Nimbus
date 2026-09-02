// Tests for frontend/integration/sap-interface-ui.mjs (Interface).
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from '../../../frontend/integration/sap-interface-ui.mjs';

test('Interface exposes its documented public API', () => {
  assert.equal(typeof Interface.render, 'function');
});
