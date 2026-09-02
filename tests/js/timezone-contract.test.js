'use strict';
// Locks the timezone save contract fixed 2026-07-07 (see MIGRATION.md → "Timezone
// save corruption"). The frontend must serialize task dates as NAIVE-LOCAL strings
// (no `Z`), and parsing such a string back must reproduce the SAME local instant —
// otherwise a save→read round-trip shifts by the client's UTC offset.
//
// These assertions are timezone-INDEPENDENT: both the Date construction and the
// read-back use local components, so they hold in any TZ (CI, US, UTC).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const Core = require('../../frontend/nimbus-compute-core.js');

test('toLocalSeconds emits naive local components with no Z suffix', () => {
  const d = new Date(2026, 6, 7, 10, 30, 45); // local 2026-07-07 10:30:45
  const s = Core.toLocalSeconds(d);
  assert.equal(s, '2026-07-07T10:30:45');
  assert.ok(!s.endsWith('Z'), 'must NOT be a UTC Z string (that is the bug)');
});

test('toLocalSeconds round-trips through parseDate to the same instant', () => {
  // The core round-trip: local Date -> naive string -> new Date(naive) parsed as LOCAL.
  // This is what the save (toLocalSeconds) + read (bare strftime, parsed local) path does.
  const d = new Date(2026, 0, 15, 23, 5, 0);
  const back = Core.parseDate(Core.toLocalSeconds(d));
  assert.equal(back.getTime(), d.getTime());
});

test('toLocalSeconds preserves seconds precision', () => {
  const d = new Date(2026, 11, 31, 8, 0, 7);
  assert.equal(Core.toLocalSeconds(d), '2026-12-31T08:00:07');
});

test('toLocalSeconds returns empty string for null/invalid (backend maps to NULL)', () => {
  assert.equal(Core.toLocalSeconds(null), '');
  assert.equal(Core.toLocalSeconds(undefined), '');
  assert.equal(Core.toLocalSeconds('not-a-date'), '');
});
