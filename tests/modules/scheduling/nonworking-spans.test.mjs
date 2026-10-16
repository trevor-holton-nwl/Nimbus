// Tests for frontend/scheduling/nonworking-spans.mts — the pure span builder behind the Gantt's
// non-working-time shading. No vis, no Store: windowFor is a plain function of the day start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNonWorkingSpans } from '../../../frontend/scheduling/nonworking-spans.mjs';

const L = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi);
const ms = (d) => d.getTime();
const fmt = (spans) => spans.map(s => [s.start.getTime(), s.end.getTime()]);

// Mon-Fri 06:00-18:00, weekend closed. 2026-08-03 is a Monday.
function weekPattern(openH = 6, closeH = 18) {
  return (day) => {
    const dow = day.getDay();
    if (dow === 0 || dow === 6) return null;
    const a = new Date(day); a.setHours(openH, 0, 0, 0);
    const b = new Date(day); b.setHours(closeH, 0, 0, 0);
    return [a, b];
  };
}

test('closed weekend is ONE span Sat 00:00 -> Mon 00:00 when the weekdays are open all day', () => {
  const full = (day) => {
    const dow = day.getDay();
    if (dow === 0 || dow === 6) return null;
    const next = new Date(day); next.setDate(day.getDate() + 1);
    return [new Date(day), next];
  };
  const { spans, truncated } = buildNonWorkingSpans(ms(L(2026, 8, 3)), ms(L(2026, 8, 10)), full);
  assert.equal(truncated, false);
  assert.deepEqual(fmt(spans), [[ms(L(2026, 8, 8)), ms(L(2026, 8, 10))]]);
});

test('Fri 18:00 -> Mon 06:00 merges the evening, the weekend and the morning into one span', () => {
  const { spans } = buildNonWorkingSpans(ms(L(2026, 8, 3)), ms(L(2026, 8, 11)), weekPattern());
  const fri = spans.find(s => s.start.getTime() === ms(L(2026, 8, 7, 18)));
  assert.ok(fri, 'a span starts Friday 18:00');
  assert.equal(fri.end.getTime(), ms(L(2026, 8, 10, 6)));
  // Mon 00:00 -> 06:00 head, Mon 18:00 -> Tue 06:00 overnight ...
  assert.deepEqual(fmt(spans)[0], [ms(L(2026, 8, 3)), ms(L(2026, 8, 3, 6))]);
  assert.deepEqual(fmt(spans)[1], [ms(L(2026, 8, 3, 18)), ms(L(2026, 8, 4, 6))]);
});

test('a 12:00-24:00 shift gives [00:00, 12:00] per day and no tail', () => {
  const win = (day) => {
    const a = new Date(day); a.setHours(12, 0, 0, 0);
    const b = new Date(day); b.setHours(24, 0, 0, 0);
    return [a, b];
  };
  const { spans } = buildNonWorkingSpans(ms(L(2026, 8, 3)), ms(L(2026, 8, 6)), win);
  assert.deepEqual(fmt(spans), [
    [ms(L(2026, 8, 3)), ms(L(2026, 8, 3, 12))],
    [ms(L(2026, 8, 4)), ms(L(2026, 8, 4, 12))],
    [ms(L(2026, 8, 5)), ms(L(2026, 8, 5, 12))],
  ]);
});

test('a fully closed range is one span covering whole days', () => {
  const { spans } = buildNonWorkingSpans(ms(L(2026, 8, 3, 9)), ms(L(2026, 8, 6, 9)), () => null);
  assert.deepEqual(fmt(spans), [[ms(L(2026, 8, 3)), ms(L(2026, 8, 7))]]);
});

test('a degenerate window (start >= end) counts as closed', () => {
  const win = (day) => [new Date(day.getTime() + 3600_000), new Date(day.getTime() + 3600_000)];
  const { spans } = buildNonWorkingSpans(ms(L(2026, 8, 3)), ms(L(2026, 8, 5)), win);
  assert.deepEqual(fmt(spans), [[ms(L(2026, 8, 3)), ms(L(2026, 8, 5))]]);
});

test('closedDaysOnly drops partial-day spans and keeps closed days (weekend only)', () => {
  const { spans } = buildNonWorkingSpans(ms(L(2026, 8, 3)), ms(L(2026, 8, 10)), weekPattern(), { closedDaysOnly: true });
  assert.deepEqual(fmt(spans), [[ms(L(2026, 8, 8)), ms(L(2026, 8, 10))]]);
});

test('cap drops the far end and reports truncated', () => {
  const { spans, truncated } = buildNonWorkingSpans(ms(L(2026, 1, 1)), ms(L(2026, 3, 1)), weekPattern(), { cap: 5 });
  assert.equal(truncated, true);
  assert.equal(spans.length, 5);
  assert.equal(spans[0].start.getTime(), ms(L(2026, 1, 1)), 'the near end is kept');
});

test('cap is not hit: truncated false', () => {
  const { truncated } = buildNonWorkingSpans(ms(L(2026, 8, 3)), ms(L(2026, 8, 10)), weekPattern());
  assert.equal(truncated, false);
});

test('a windowFor that flips pattern mid-range (period boundary) is correct on both sides', () => {
  const cutover = L(2026, 8, 5); // Wed
  const win = (day) => {
    const early = day < cutover;
    const a = new Date(day); a.setHours(early ? 6 : 12, 0, 0, 0);
    const b = new Date(day); b.setHours(early ? 18 : 24, 0, 0, 0);
    return [a, b];
  };
  const { spans } = buildNonWorkingSpans(ms(L(2026, 8, 4)), ms(L(2026, 8, 7)), win);
  assert.deepEqual(fmt(spans), [
    [ms(L(2026, 8, 4)), ms(L(2026, 8, 4, 6))],
    [ms(L(2026, 8, 4, 18)), ms(L(2026, 8, 5, 12))],
    [ms(L(2026, 8, 6)), ms(L(2026, 8, 6, 12))],
  ]);
});

test('DST transition days: every boundary stays on a local midnight (no 23:00 / 01:00 drift)', () => {
  // Fully open 24h days with a closed Sunday exercise only midnight boundaries.
  const win = (day) => {
    if (day.getDay() === 0) return null;
    const next = new Date(day); next.setDate(day.getDate() + 1);
    return [new Date(day), next];
  };
  for (const [from, to] of [[L(2026, 3, 1), L(2026, 3, 15)], [L(2026, 10, 25), L(2026, 11, 8)]]) {
    const { spans } = buildNonWorkingSpans(ms(from), ms(to), win);
    assert.ok(spans.length >= 1);
    for (const s of spans) {
      for (const d of [s.start, s.end]) {
        assert.equal(d.getHours(), 0, `boundary ${d.toString()} is a local midnight`);
        assert.equal(d.getMinutes(), 0);
      }
    }
  }
});
