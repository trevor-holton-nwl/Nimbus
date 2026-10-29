// Tests for the run-log helpers in frontend/admin-ops/jobs-model.mts: merge/dedupe by seq (the 2 s poll can
// overlap), the minimum-level + text filter, and the plain-text form used by Copy and Download.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLog, lastSeq, filterLog, formatLogLine, logToText } from '../../../frontend/admin-ops/jobs-model.mjs';

const L = (seq, level = 'info', msg = `m${seq}`, extra = {}) => ({ seq, level, msg, at: `2026-10-29T08:00:${String(seq).padStart(2, '0')}`, ...extra });

test('mergeLog: union by seq, ascending, an incoming line replaces the stored one', () => {
  const a = [L(1), L(2), L(3)];
  const merged = mergeLog(a, [L(3, 'warn', 'updated'), L(4), L(5)]);
  assert.deepEqual(merged.map(l => l.seq), [1, 2, 3, 4, 5]);
  assert.equal(merged[2].msg, 'updated');
  assert.equal(a.length, 3, 'the input is not mutated');
});

test('mergeLog: out-of-order and duplicate batches converge; empty incoming returns the same array', () => {
  const a = [L(1)];
  assert.equal(mergeLog(a, []), a);
  const m = mergeLog(mergeLog([], [L(5), L(3)]), [L(4), L(3), L(5)]);
  assert.deepEqual(m.map(l => l.seq), [3, 4, 5]);
});

test('lastSeq: 0 for an empty log, else the highest seq', () => {
  assert.equal(lastSeq([]), 0);
  assert.equal(lastSeq([L(1), L(7)]), 7);
});

test('filterLog: level is a minimum, all keeps everything, text matches step and message case-insensitively', () => {
  const lines = [L(1, 'debug'), L(2, 'info', 'Loaded 120 orders', { step: 'snapshot' }), L(3, 'warn', 'Dropped 2 rows'), L(4, 'error', 'Engine failed', { step: 'search' })];
  assert.equal(filterLog(lines, { level: 'all' }).length, 4);
  assert.deepEqual(filterLog(lines, { level: 'info' }).map(l => l.seq), [2, 3, 4]);
  assert.deepEqual(filterLog(lines, { level: 'warn' }).map(l => l.seq), [3, 4]);
  assert.deepEqual(filterLog(lines, { level: 'error' }).map(l => l.seq), [4]);
  assert.deepEqual(filterLog(lines, { q: 'SNAPSHOT' }).map(l => l.seq), [2], 'matches the step');
  assert.deepEqual(filterLog(lines, { q: 'dropped' }).map(l => l.seq), [3]);
  assert.deepEqual(filterLog(lines, { level: 'warn', q: 'engine' }).map(l => l.seq), [4]);
  assert.deepEqual(filterLog(lines, { q: '   ' }).length, 4);
});

test('formatLogLine / logToText: time, LEVEL, [step], message, duration; time via the injected formatter', () => {
  const fmt = iso => `T(${iso.slice(11)})`;
  assert.equal(formatLogLine(L(1, 'warn', 'slow', { step: 'search', duration_ms: 4200 }), fmt), 'T(08:00:01) WARN [search] slow (4.2 s)');
  assert.equal(formatLogLine({ seq: 2, level: 'info', msg: 'plain' }, fmt), 'INFO plain');
  assert.equal(logToText([L(1), L(2)], fmt), 'T(08:00:01) INFO m1\nT(08:00:02) INFO m2');
  assert.equal(logToText([], fmt), '');
});
