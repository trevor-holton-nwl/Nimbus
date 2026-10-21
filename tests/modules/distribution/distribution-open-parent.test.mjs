// DistributionPane.openParent(parentId) — public wrapper around the private _openDetail (Alert Monitor deep link).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DistributionPane, headerKeyForParent } from '../../../frontend/distribution/distribution-pane.mjs';

const row = (po, mat) => ({ header: { production_order: po, material_number: mat } });

test('headerKeyForParent finds the list row of a parent order', () => {
  const rows = [row('1000', 'MAT-A'), row('2000', 'MAT-B'), row('2000', 'MAT-C')];
  assert.equal(headerKeyForParent(rows, '2000'), '2000|MAT-B', 'first row of that parent');
  assert.equal(headerKeyForParent(rows, '2000', 'MAT-C'), '2000|MAT-C', 'material narrows the match');
  assert.equal(headerKeyForParent(rows, '3000'), null);
  assert.equal(headerKeyForParent([], '1000'), null);
  assert.equal(headerKeyForParent(rows, ''), null);
});

test('openParent is public, resolves false when the parent is not in the list, and never throws', async () => {
  assert.equal(typeof DistributionPane.openParent, 'function');
  assert.equal(await DistributionPane.openParent('NOT-LOADED'), false);
  assert.equal(await DistributionPane.openParent(''), false);
});
