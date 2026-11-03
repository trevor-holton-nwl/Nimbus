// P1-11: capAwareSequence reads ceiling/runtime once per task; parity vs a
// frozen copy of the per-round-lookup implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capAwareSequence } from '../../../frontend/optimization/scheduler-contract.mjs';

function frozen(sorted, cursorStartMs, ceilingMsFor, runtimeMsFor) {
  const hasCeiling = sorted.some(task => { const c = ceilingMsFor(task); return c !== null && Number.isFinite(c); });
  if (!hasCeiling) return [...sorted];
  const result = []; const remaining = [...sorted]; let cursor = cursorStartMs;
  while (remaining.length > 0) {
    const head = remaining[0]; const headEnd = cursor + runtimeMsFor(head);
    let atRisk = null; let earliestCeiling = Infinity; let earliestIndex = Infinity;
    for (let i = 1; i < remaining.length; i++) {
      const task = remaining[i]; const ceiling = ceilingMsFor(task); const runtime = runtimeMsFor(task);
      if (ceiling === null || !Number.isFinite(ceiling) || runtime <= 0) continue;
      const latestStart = ceiling - runtime;
      if (latestStart < cursor) continue;
      if (headEnd <= latestStart) continue;
      if (ceiling < earliestCeiling || (ceiling === earliestCeiling && i < earliestIndex)) { atRisk = task; earliestCeiling = ceiling; earliestIndex = i; }
    }
    const pick = atRisk !== null ? atRisk : head;
    const pickRuntime = runtimeMsFor(pick);
    result.push(pick); remaining.splice(remaining.indexOf(pick), 1);
    if (pickRuntime > 0) cursor += pickRuntime;
  }
  return result;
}

function rng(seed) { let a = seed; return () => { a |= 0; a = a + 0x6d2b79f5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

test('capAwareSequence matches the frozen per-round-lookup version', () => {
  const next = rng(77);
  let reordered = 0;
  for (let trial = 0; trial < 1500; trial += 1) {
    const n = Math.floor(next() * 14);
    const pool = Array.from({ length: Math.max(1, Math.floor(n * 0.8)) }, (_, i) => ({
      id: `T${i}`,
      ceiling: next() < 0.25 ? null : next() < 0.05 ? Infinity : Math.floor(next() * 3000),
      runtime: next() < 0.1 ? 0 : Math.floor(next() * 400),
    }));
    // Repeated objects exercise the indexOf-first semantics.
    const tasks = Array.from({ length: n }, () => pool[Math.floor(next() * pool.length)]);
    const cursor = Math.floor(next() * 200);
    const args = [cursor, t => t.ceiling, t => t.runtime];
    const expected = frozen(tasks, ...args);
    const actual = capAwareSequence(tasks, ...args);
    assert.deepEqual(actual, expected);
    assert.equal(actual.length, tasks.length);
    if (expected.some((t, i) => t !== tasks[i])) reordered += 1;
  }
  assert.ok(reordered > 50, `only ${reordered} reorderings exercised`);
});
