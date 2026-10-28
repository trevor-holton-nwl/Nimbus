// Tool Inventory Wave 5: toolingRuleForSnapshot reads the plant's rule from snapshot.masterData (default Off, strict values).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolingRuleForSnapshot } from '../../../frontend/optimization/setup-scheduler.mjs';

const snap = plants => ({ masterData: plants === null ? null : { plants, lines: [], workcenters: [] } });
const p = (plant, rule) => ({ plant, subnetwork: 'S', setup_policy_config: rule === undefined ? {} : { toolingRule: rule } });

test('toolingRuleForSnapshot: default off, hard is hard, garbage and wrong case fall back to off', () => {
  assert.equal(toolingRuleForSnapshot(snap([p('P', undefined)]), 'P'), 'off');
  assert.equal(toolingRuleForSnapshot(snap([p('P', 'hard')]), 'P'), 'hard');
  assert.equal(toolingRuleForSnapshot(snap([p('P', 'off')]), 'P'), 'off');
  for (const bad of ['HARD', 'soft', '', null, 1, true, {}]) assert.equal(toolingRuleForSnapshot(snap([p('P', bad)]), 'P'), 'off', String(bad));
  assert.equal(toolingRuleForSnapshot(snap(null), 'P'), 'off');
  assert.equal(toolingRuleForSnapshot({ masterData: undefined }, 'P'), 'off');
  assert.equal(toolingRuleForSnapshot(snap([{ plant: 'P' }]), 'P'), 'off', 'no setup_policy_config at all');
});

test('toolingRuleForSnapshot: the plant row is matched by plant key and another plant never leaks its rule', () => {
  const s = snap([p('A', 'hard'), p('B', 'off'), p('C', undefined)]);
  assert.deepEqual(['A', 'B', 'C', 'D'].map(x => toolingRuleForSnapshot(s, x)), ['hard', 'off', 'off', 'off']);
});

test('toolingRuleForSnapshot is not gated on the setup flag (a setup-off plant still gets the tool rule)', () => {
  const s = snap([{ ...p('P', 'hard'), setup_active: false }]);
  assert.equal(toolingRuleForSnapshot(s, 'P'), 'hard');
});
