// P1-6: the linear best-scan must pick exactly what the old per-pick stable
// sort + [0] picked, including through the whole consume loop and ties.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as SetupScheduler from '../../../frontend/optimization/setup-scheduler.mjs';

globalThis.NimbusComputeCore = undefined; // raw due instants: no calendar needed

function rng(seed) { let a = seed; return () => { a |= 0; a = a + 0x6d2b79f5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dueOf = task => new Date(task.original_end_date).getTime();

// Frozen old comparator + selection.
function oldPick(ranked) {
  const copy = [...ranked];
  copy.sort((l, r) => (
    l.covered - r.covered
    || l.minutes - r.minutes
    || ordinal(l.policy, r.policy)
    || dueOf(l.task) - dueOf(r.task)
    || String(l.task.id).localeCompare(String(r.task.id))
  ));
  return copy[0];
}

test('bestSetupNearestIndex picks what a stable full sort picked, through a full consume loop', () => {
  const next = rng(1103);
  const scope = { snapshot: {}, plant: 'P1', ctx: undefined };
  for (let trial = 0; trial < 600; trial += 1) {
    const n = 1 + Math.floor(next() * 40);
    const idPool = Math.max(2, Math.floor(n * (next() < 0.3 ? 0.5 : 3)));
    const ranked = Array.from({ length: n }, (_, i) => ({
      task: { id: `T${String(Math.floor(next() * idPool)).padStart(3, '0')}${next() < 0.2 ? 'b' : ''}`, original_end_date: `2026-08-0${1 + Math.floor(next() * 3)}T12:00:00` },
      covered: next() < 0.3 ? 1 : 0,
      minutes: Math.floor(next() * 3) * 15,
      policy: next() < 0.5 ? '001' : '002',
      i,
    }));
    const oldRemaining = [...ranked];
    const newRemaining = [...ranked];
    while (oldRemaining.length) {
      const expected = oldPick(oldRemaining);
      const got = newRemaining[SetupScheduler.bestSetupNearestIndex(newRemaining, scope)];
      assert.equal(got, expected);
      oldRemaining.splice(oldRemaining.findIndex(r => String(r.task.id) === String(expected.task.id)), 1);
      newRemaining.splice(newRemaining.findIndex(r => String(r.task.id) === String(got.task.id)), 1);
    }
  }
});
