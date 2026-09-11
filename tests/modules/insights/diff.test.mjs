// Pure-function tests for the classic-script Diff module. The VM harness runs
// the production nimbus-intelligence.js with the boot gate closed (no
// IndexedDB, no command palette); Diff.compute only needs Store.tasks for a
// live-row enrichment fallback, which is empty here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext } from 'node:vm';
import { loadLegacyApp, ROOT } from '../helpers/load-legacy-app.mjs';

const { nimbus, context } = await loadLegacyApp();
context.document.readyState = 'loading';
context.document.addEventListener = () => {};
runInContext(readFileSync(`${ROOT}/frontend/nimbus-intelligence.js`, 'utf8'), context);
const Diff = nimbus.Diff;

const H = 3600000;
const T0 = Date.UTC(2026, 8, 14, 8);
const row = (over = {}) => ({
  id: 'o1', start_date: T0, end_date: T0 + 4 * H, MACHINE: 'L1', PRODUCTION_ORDER: 'PO1',
  text: 'Order 1', COLOR: '', FORM_SIZE: '', FIRMED: false, scheduleSegments: null, ...over,
});

test('Diff.compute reports a finish-only change as one moved row of kind finish', () => {
  const d = Diff.compute([row()], [row({ end_date: T0 + 6 * H })]);
  assert.equal(d.moved.length, 1);
  assert.equal(JSON.stringify(d.moved[0].kinds), JSON.stringify(['finish']));
  assert.equal(d.moved[0].startDelta, 0);
  assert.equal(d.moved[0].endDelta, 2 * H);
  assert.equal(d.lineImpact.L1.moved, 1);
});

test('Diff.compute reports a re-segmentation with identical envelope as kind split', () => {
  const a = row({ scheduleSegments: [[T0, T0 + 2 * H], [T0 + 3 * H, T0 + 4 * H]] });
  const b = row({ scheduleSegments: [[T0, T0 + 1 * H], [T0 + 2 * H, T0 + 4 * H]] });
  const d = Diff.compute([a], [b]);
  assert.equal(d.moved.length, 1);
  assert.equal(JSON.stringify(d.moved[0].kinds), JSON.stringify(['split']));
});

test('Diff.compute reports nothing for identical snapshots', () => {
  const d = Diff.compute([row()], [row()]);
  assert.equal(d.moved.length, 0);
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
});

test('Diff.compute treats a legacy snapshot without scheduleSegments as unknown, not split', () => {
  const legacy = row(); delete legacy.scheduleSegments;
  const d = Diff.compute([legacy], [row({ scheduleSegments: [[T0, T0 + 2 * H], [T0 + 2 * H, T0 + 4 * H]] })]);
  assert.equal(d.moved.length, 0);
});

test('Diff.compute keeps start and machine detection unchanged and sorts by the larger delta', () => {
  const d = Diff.compute(
    [row({ id: 'a' }), row({ id: 'b' })],
    [row({ id: 'a', start_date: T0 + 1 * H, end_date: T0 + 5 * H }), row({ id: 'b', MACHINE: 'L2' })],
  );
  const byId = Object.fromEntries(d.moved.map(m => [m.id, m]));
  assert.equal(JSON.stringify(byId.a.kinds), JSON.stringify(['start']));          // pure move: finish shifts with start, not a finish change
  assert.equal(byId.a.delta, 1 * H);
  assert.equal(JSON.stringify(byId.b.kinds), JSON.stringify(['machine']));
  assert.equal(byId.b.lineChanged, true);
  assert.equal(d.lineImpact.L2.moved, 1);
});
