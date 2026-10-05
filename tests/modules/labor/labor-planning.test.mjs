// Tests for frontend/labor/labor-planning.mjs.
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LaborPlanning } from '../../../frontend/labor/labor-planning.mjs';

test('LaborPlanning exposes its documented public API', () => {
  assert.equal(typeof LaborPlanning.init, 'function');
  assert.equal(typeof LaborPlanning.render, 'function');
  assert.equal(typeof LaborPlanning.onGroupToggle, 'function');
  assert.equal(typeof LaborPlanning.clearGroupFilter, 'function');
  assert.equal(typeof LaborPlanning.prevHorizon, 'function');
  assert.equal(typeof LaborPlanning.nextHorizon, 'function');
  assert.equal(typeof LaborPlanning.setSpan, 'function');
});

test('Labor attribute selectors are CSS-escaped, never hand-escaped with &quot; (#47)', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../../frontend/labor/labor-planning.mts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /&quot;'\)\}/, 'a name containing a quote must not be turned into &quot; inside a selector');
  assert.match(source, /_cssEsc\(grp\)/);
});
