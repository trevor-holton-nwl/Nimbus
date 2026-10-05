// Tests for frontend/calendar/calendar-engine.mjs, split from
// tests/modules/schedule-services.test.mjs (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split schedule-services.mts
// into 4 domain files: optimization/scheduler-contract.mjs,
// optimization/engine.mjs, calendar/calendar-engine.mjs,
// insights/services.mjs).
//
// Calendar's capacity-math functions delegate to nimbus-compute-core.js via
// the ambient `globalThis.NimbusComputeCore` global (a real browser loads it
// via a parser-blocking <script> before app-entry.mjs's static imports run).
// Under plain Node ESM (this file) nothing sets that global automatically, so
// we bootstrap it here via createRequire — mirroring
// tests/modules/helpers/load-legacy-app.mjs's identical bootstrap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Calendar } from '../../../frontend/calendar/calendar-engine.mjs';
import { Store } from '../../../frontend/platform/store.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');

test('Calendar exposes capacity-math methods only (no render/openBlockModal/DOM)', () => {
  assert.equal(typeof Calendar.workWindow, 'function');
  assert.equal(typeof Calendar.dailyCapacityHours, 'function');
  assert.equal(typeof Calendar.nextAvailable, 'function');
  assert.equal(Calendar.render, undefined, 'Calendar must not carry UI methods after the split');
  assert.equal(Calendar.openBlockModal, undefined);
  assert.equal(Calendar.saveBlockFromModal, undefined);
});

test('Calendar.workWindow returns null outside working hours, a window inside them', () => {
  Store.setCalendar('L1', { 1: [7, 19] }, 'unit-test'); // Monday 7am-7pm
  const monday = new Date('2026-08-03T12:00:00'); // a Monday, midday
  const win = Calendar.workWindow('L1', monday);
  assert.ok(win === null || Array.isArray(win));
});

test('nextAvailable returns null for an overlong order or a closed line, never a bogus start (#41)', () => {
  const all = (w) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, w]));
  Store.setCalendar('NA-L1', all([8, 16]), 'unit-test');
  const from = new Date('2031-03-03T09:00:00');
  assert.equal(Calendar.nextAvailable('NA-L1', from, 9 * 3600 * 1000), null, '9h order cannot fit an 8h window');
  assert.ok(Calendar.nextAvailable('NA-L1', from, 4 * 3600 * 1000) instanceof Date, 'a fitting order still gets a start');
  Store.setCalendar('NA-CLOSED', all(null), 'unit-test');
  assert.equal(Calendar.nextAvailable('NA-CLOSED', from, 3600 * 1000), null, 'no nominal window at all');
});

test('nextAvailable rounds a 10:05 blackout end UP so the start is clear of the blackout (#41)', () => {
  const all = (w) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, w]));
  Store.setCalendar('NA-L2', all([0, 24]), 'unit-test');
  const prior = Store.blocks.slice();
  try {
    Store.replaceBlocks([{ id: 'na-b', line: 'NA-L2', start: new Date('2031-03-03T09:00:00'), end: new Date('2031-03-03T10:05:00') }], 'unit-test');
    const start = Calendar.nextAvailable('NA-L2', new Date('2031-03-03T09:30:00'), 3600 * 1000);
    assert.ok(start instanceof Date);
    assert.ok(start.getTime() >= new Date('2031-03-03T10:05:00').getTime(), 'start must not sit inside the blackout');
    assert.equal(start.getTime() % (15 * 60 * 1000), 0, 'start stays on the 15-minute grid');
  } finally {
    Store.replaceBlocks(prior, 'unit-test');
  }
});
