'use strict';
// First automated coverage of the NIMBUS compute core (capacity engine + alert
// rules + utilization matrix) — previously untested and hand-mirrored between
// app.js and the worker. These pin current behavior so the eventual app.js→core
// migration (and any worker edit) can't silently change results.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const Core = require('../../frontend/nimbus-compute-core.js');

const allDays = (window) => {
  const wh = {};
  for (let i = 0; i < 7; i++) wh[i] = window ? [...window] : null;
  return wh;
};
const noPlant = { lines: [] };

test('_dayWindow keeps fractional working hours (08:30, not floored to 08:00)', () => {
  // Regression guard for R3: setHours() truncates its hour arg, so 8.5 must be
  // split into 08:30, not collapsed to 08:00.
  const [s, e] = Core._dayWindow(allDays([8.5, 16.5]), new Date(2026, 6, 7, 12));
  assert.equal(s.getHours(), 8);
  assert.equal(s.getMinutes(), 30);
  assert.equal(e.getHours(), 16);
  assert.equal(e.getMinutes(), 30);
});

test('_dayWindow returns null on a closed (null) day', () => {
  assert.equal(Core._dayWindow(allDays(null), new Date(2026, 6, 7, 12)), null);
});

test('effectiveFromCapacity applies pct and hours buffers, else passthrough', () => {
  assert.equal(Core.effectiveFromCapacity('L', 10, { L: { bufferUnit: 'pct', bufferPct: 20 } }), 8);
  assert.equal(Core.effectiveFromCapacity('L', 10, { L: { bufferUnit: 'hours', bufferHours: 3 } }), 7);
  assert.equal(Core.effectiveFromCapacity('L', 10, {}), 10);            // no line settings
  assert.equal(Core.effectiveFromCapacity('L', 10, { L: {} }), 10);     // settings, no buffer
});

test('dailyCapacityHours = working-window hours minus blackout overlap', () => {
  const calendars = { L: { workHours: allDays([8, 16]) } };   // 8h window
  const lineSettings = { L: { plant: null } };                // no plant → line window only
  const blocks = [{ line: 'L', start: '2026-07-07T10:00:00', end: '2026-07-07T12:00:00' }]; // 2h out
  const cap = Core.dailyCapacityHours(
    'L', new Date(2026, 6, 7, 12), calendars, {}, lineSettings, noPlant, blocks, [], null,
  );
  assert.equal(cap, 6);
});

test('dailyCapacityHours is 0 on a closed day-of-week', () => {
  const calendars = { L: { workHours: allDays(null) } };
  const cap = Core.dailyCapacityHours(
    'L', new Date(2026, 6, 7, 12), calendars, {}, { L: { plant: null } }, noPlant, [], [], null,
  );
  assert.equal(cap, 0);
});

test('computeAlerts flags exactly one overlap for two overlapping orders on a line', () => {
  const base = Date.now() + 24 * 3600000; // tomorrow → "active"
  const t1 = { id: 'a', text: 'A', MACHINE: 'L', RUN_TIME: 2,
    start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) };
  const t2 = { id: 'b', text: 'B', MACHINE: 'L', RUN_TIME: 2,
    start_date: new Date(base + 2 * 3600000), end_date: new Date(base + 4 * 3600000) };
  const res = Core.computeAlerts({
    tasks: [t1, t2], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {},
  });
  const overlaps = res.alerts.filter(a => a.type === 'overlap');
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].line, 'L');
});

test('computeAlerts honours the dismissed set', () => {
  const base = Date.now() + 24 * 3600000;
  const t1 = { id: 'a', MACHINE: 'L', RUN_TIME: 2,
    start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) };
  const t2 = { id: 'b', MACHINE: 'L', RUN_TIME: 2,
    start_date: new Date(base + 2 * 3600000), end_date: new Date(base + 4 * 3600000) };
  const res = Core.computeAlerts({
    tasks: [t1, t2], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: ['ovl-a-b'], opts: {},
  });
  assert.equal(res.alerts.filter(a => a.type === 'overlap').length, 0);
});

// B1 (part 2): the firmed-closed/firmed-out-of-hours rules used to `continue` on
// any task that wasn't `t.firmed`, so an unpinned order sitting outside working
// hours or on a closed day raised nothing. These pin the dropped guard staying
// dropped, plus the message wording still telling firmed apart from unpinned.
test('computeAlerts raises firmed-out-of-hours for an UNPINNED task scheduled outside working hours', () => {
  const base = Date.now() + 24 * 3600000; // tomorrow → "active"
  const start = new Date(base); start.setHours(18, 0, 0, 0); // outside the 08:00-16:00 window below
  const end = new Date(start.getTime() + 2 * 3600000);
  const t = { id: 'u1', MACHINE: 'L', RUN_TIME: 2, firmed: false, start_date: start, end_date: end };
  const res = Core.computeAlerts({
    tasks: [t], blocks: [], plantBlocks: [], calendars: { L: { workHours: allDays([8, 16]) } }, plants: {},
    lineSettings: { L: { plant: null } }, masterData: noPlant, dismissed: [], opts: {},
  });
  const hits = res.alerts.filter(a => a.type === 'firmed-out-of-hours');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].taskId, 'u1');
  assert.match(hits[0].msg, /^Order "/);
});

test('computeAlerts raises firmed-closed for an UNPINNED task scheduled on a closed day', () => {
  const base = Date.now() + 24 * 3600000; // tomorrow → "active"
  const start = new Date(base); start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 2 * 3600000);
  const t = { id: 'u2', MACHINE: 'L', RUN_TIME: 2, firmed: false, start_date: start, end_date: end };
  const res = Core.computeAlerts({
    // Every day-of-week closed, so whatever day "tomorrow" lands on is closed.
    tasks: [t], blocks: [], plantBlocks: [], calendars: { L: { workHours: allDays(null) } }, plants: {},
    lineSettings: { L: { plant: null } }, masterData: noPlant, dismissed: [], opts: {},
  });
  const hits = res.alerts.filter(a => a.type === 'firmed-closed');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].taskId, 'u2');
  assert.match(hits[0].msg, /^Order "/);
});

test('computeAlerts keeps "Firmed order..." wording for a FIRMED task outside working hours (regression guard)', () => {
  const base = Date.now() + 24 * 3600000; // tomorrow → "active"
  const start = new Date(base); start.setHours(18, 0, 0, 0); // outside the 08:00-16:00 window below
  const end = new Date(start.getTime() + 2 * 3600000);
  const t = { id: 'f1', MACHINE: 'L', RUN_TIME: 2, firmed: true, start_date: start, end_date: end };
  const res = Core.computeAlerts({
    tasks: [t], blocks: [], plantBlocks: [], calendars: { L: { workHours: allDays([8, 16]) } }, plants: {},
    lineSettings: { L: { plant: null } }, masterData: noPlant, dismissed: [], opts: {},
  });
  const hits = res.alerts.filter(a => a.type === 'firmed-out-of-hours');
  assert.equal(hits.length, 1);
  assert.match(hits[0].msg, /^Firmed order "/);
});

test('computeUtilization buckets scheduled hours onto the task line/day', () => {
  const start = new Date(2026, 6, 7); // local midnight
  const t = { id: 'x', MACHINE: 'L', RUN_TIME: 4,
    start_date: new Date(2026, 6, 7, 9), end_date: new Date(2026, 6, 7, 13) };
  const { matrix } = Core.computeUtilization({
    tasks: [t], lineSettings: { L: { plant: null } },
    calendars: { L: { workHours: allDays([8, 16]) } }, plants: {},
    blocks: [], plantBlocks: [], masterData: noPlant,
    startMs: start.getTime(), days: 3,
  });
  assert.ok(matrix.L, 'line L present in matrix');
  const key = Core.dayKey(start);
  assert.ok(matrix.L[key].scheduled > 0, 'scheduled hours bucketed onto the day');
  assert.ok(matrix.L[key].tasks.includes('x'));
});

test('computeUtilization counts supplied positive setup intervals without charging zero or missing setup', () => {
  // This fails if setup capacity is ignored, if a zero setup is accidentally
  // counted, or if the core tries to resolve matrix rows itself.
  const day = new Date(2026, 6, 7);
  const workHours = allDays([0, 24]);
  const task = {
    id: 'setup-successor', MACHINE: 'L-SETUP', RUN_TIME: 2,
    start_date: new Date(2026, 6, 7, 10), end_date: new Date(2026, 6, 7, 12),
  };
  const { matrix } = Core.computeUtilization({
    tasks: [task], lineSettings: { 'L-SETUP': { plant: null } },
    calendars: { 'L-SETUP': { workHours } }, plants: {}, blocks: [], plantBlocks: [], masterData: noPlant,
    startMs: day.getTime(), days: 1,
    setup: {
      intervals: [
        { line: 'L-SETUP', predecessorOrderId: 'previous', successorOrderId: 'setup-successor',
          start: new Date(2026, 6, 7, 8), end: new Date(2026, 6, 7, 10), requiredMinutes: 120 },
        { line: 'L-SETUP', predecessorOrderId: 'setup-successor', successorOrderId: 'zero',
          start: new Date(2026, 6, 7, 12), end: new Date(2026, 6, 7, 12), requiredMinutes: 0 },
      ],
      diagnostics: [],
    },
  });

  assert.equal(matrix['L-SETUP'][Core.dayKey(day)].scheduled, 4);
  assert.deepEqual(matrix['L-SETUP'][Core.dayKey(day)].tasks, ['setup-successor']);
});

test('computeAlerts reports resolved setup violations and de-duplicates supplied state diagnostics by pair and scope', () => {
  // This fails if computeAlerts re-resolves setup truth, omits the shortfall
  // detail, or publishes the same uncovered pair twice.
  const time = new Date(Date.now() + 24 * 3600000);
  const workHours = allDays([0, 24]);
  const { alerts } = Core.computeAlerts({
    tasks: [], blocks: [], plantBlocks: [], calendars: { L: { workHours } }, plants: {},
    lineSettings: { L: { plant: 'P' } }, masterData: { lines: [{ machine: 'L', plant: 'P' }] },
    dismissed: [], opts: {},
    setup: {
      intervals: [{
        line: 'L', predecessorOrderId: 'previous', successorOrderId: 'next', scope: 'P/L',
        start: time, end: new Date(time.getTime() + 60 * 60000), requiredMinutes: 60, availableMinutes: 20,
      }],
      diagnostics: [
        { type: 'setup-uncovered', line: 'L', scope: 'P/L', pairKey: 'RED->BLUE', successorOrderId: 'later-blue', time },
        { type: 'setup-uncovered', line: 'L', scope: 'P/L', pairKey: 'RED->BLUE', time },
        { type: 'initial-state-unknown', line: 'L', scope: 'P/L', successorOrderId: 'next', time },
        { type: 'current-state-diverged', line: 'L', scope: 'P/L', successorOrderId: 'next', time },
        { type: 'override-inactive', line: 'L', scope: 'P/L', successorOrderId: 'next', time },
      ],
    },
  });

  const violation = alerts.find(alert => alert.type === 'setup-violated');
  assert.deepEqual(
    { requiredMinutes: violation?.requiredMinutes, availableMinutes: violation?.availableMinutes, shortMinutes: violation?.shortMinutes },
    { requiredMinutes: 60, availableMinutes: 20, shortMinutes: 40 },
  );
  // Gate 7: the localized message is keyed, with the three numbers its text interpolates.
  assert.equal(violation.msgKey, 'alert.setup_violated');
  assert.deepEqual(
    { required: violation.msgVars.required, available: violation.msgVars.available, short: violation.msgVars.short, line: violation.msgVars.line },
    { required: 60, available: 20, short: 40, line: 'L' },
  );
  assert.equal(alerts.filter(alert => alert.type === 'setup-uncovered').length, 1);
  assert.match(alerts.find(alert => alert.type === 'setup-uncovered').msg, /Add a setup rule or a default by value./);
  assert.deepEqual(alerts.filter(alert => alert.type !== 'setup-violated' && alert.type !== 'setup-uncovered').map(alert => alert.type).sort(), [
    'current-state-diverged', 'initial-state-unknown', 'override-inactive',
  ]);
});

test('computeAlerts recognizes predecessor-state-unknown/successor-state-unknown and assigns the new per-type severity map', () => {
  // This fails if the two new diagnostic types are missing from the core's
  // diagnosticTypes allowlist (silently dropped) or if severity regresses to
  // the old "override-inactive is the only warn" blanket rule.
  const time = new Date(Date.now() + 24 * 3600000);
  const workHours = allDays([0, 24]);
  const { alerts } = Core.computeAlerts({
    tasks: [], blocks: [], plantBlocks: [], calendars: { L: { workHours } }, plants: {},
    lineSettings: { L: { plant: 'P' } }, masterData: { lines: [{ machine: 'L', plant: 'P' }] },
    dismissed: [], opts: {},
    setup: {
      intervals: [],
      diagnostics: [
        { type: 'predecessor-state-unknown', line: 'L', scope: 'P/L', predecessorOrderId: 'mid', successorOrderId: 'after-mid', time },
        { type: 'successor-state-unknown', line: 'L', scope: 'P/L', predecessorOrderId: 'before', successorOrderId: 'unknown-successor', time },
        { type: 'setup-uncovered', line: 'L', scope: 'P/L', pairKey: 'RED->BLUE', successorOrderId: 'uncovered-successor', time },
        { type: 'initial-state-unknown', line: 'L', scope: 'P/L', successorOrderId: 'first', time },
        { type: 'override-inactive', line: 'L', scope: 'P/L', successorOrderId: 'override-line', time },
        { type: 'current-state-diverged', line: 'L', scope: 'P/L', successorOrderId: 'diverged-line', time },
      ],
    },
  });

  const sevByType = Object.fromEntries(
    ['predecessor-state-unknown', 'successor-state-unknown', 'setup-uncovered', 'initial-state-unknown', 'override-inactive', 'current-state-diverged']
      .map(type => [type, alerts.find(alert => alert.type === type)?.sev]),
  );
  assert.deepEqual(sevByType, {
    'predecessor-state-unknown': 'err',
    'successor-state-unknown': 'err',
    'setup-uncovered': 'err',
    'initial-state-unknown': 'warn',
    'override-inactive': 'warn',
    'current-state-diverged': 'warn',
  }, 'each of the six setup diagnostic types must resolve its documented severity, not a blanket default');
});

test('computeAlerts raises no setup alerts only when the plant setup_active flag is truly off', () => {
  const time = new Date(Date.now() + 24 * 3600000);
  const workHours = allDays([0, 24]);
  const fixture = (setupActive) => ({
    tasks: [], blocks: [], plantBlocks: [], calendars: { L: { workHours } }, plants: {},
    lineSettings: { L: { plant: 'P' } },
    masterData: { lines: [{ machine: 'L', plant: 'P' }], plants: setupActive === undefined ? [] : [{ plant: 'P', setup_active: setupActive }] },
    dismissed: [], opts: {},
    setup: {
      intervals: [{
        line: 'L', predecessorOrderId: 'previous', successorOrderId: 'next', scope: 'P/L',
        start: time, end: new Date(time.getTime() + 60 * 60000), requiredMinutes: 60, availableMinutes: 20,
      }],
      diagnostics: [
        { type: 'setup-uncovered', line: 'L', scope: 'P/L', pairKey: 'RED->BLUE', successorOrderId: 'later-blue', time },
        { type: 'predecessor-state-unknown', line: 'L', scope: 'P/L', predecessorOrderId: 'mid', successorOrderId: 'after-mid', time },
        { type: 'successor-state-unknown', line: 'L', scope: 'P/L', predecessorOrderId: 'before', successorOrderId: 'unknown-successor', time },
        { type: 'override-inactive', line: 'L', scope: 'P/L', successorOrderId: 'override-line', time },
        { type: 'initial-state-unknown', line: 'L', scope: 'P/L', successorOrderId: 'first', time },
        { type: 'current-state-diverged', line: 'L', scope: 'P/L', successorOrderId: 'diverged-line', time },
      ],
    },
  });

  const sevOf = (alerts, type) => alerts.find(alert => alert.type === type)?.sev;

  const off = Core.computeAlerts(fixture(false)).alerts;
  for (const type of ['setup-violated', 'setup-uncovered', 'predecessor-state-unknown', 'successor-state-unknown',
    'override-inactive', 'initial-state-unknown', 'current-state-diverged']) {
    assert.equal(sevOf(off, type), undefined, `${type} must be suppressed on a setup-off plant`);
  }

  for (const on of [Core.computeAlerts(fixture(true)).alerts, Core.computeAlerts(fixture(undefined)).alerts]) {
    assert.equal(sevOf(on, 'setup-violated'), 'err');
    assert.equal(sevOf(on, 'setup-uncovered'), 'err');
    assert.equal(sevOf(on, 'predecessor-state-unknown'), 'err');
    assert.equal(sevOf(on, 'successor-state-unknown'), 'err');
    assert.equal(sevOf(on, 'override-inactive'), 'warn');
  }
});

test('computeAlerts ignores malformed setup diagnostics', () => {
  // This fails if an invalid observation payload can crash the normal alert
  // path instead of remaining fail-safe and diagnostic-only.
  assert.doesNotThrow(() => Core.computeAlerts({
    tasks: [], blocks: [], plantBlocks: [], calendars: {}, plants: {}, lineSettings: {}, masterData: noPlant,
    dismissed: [], opts: {}, setup: { intervals: [], diagnostics: {} },
  }));
});

// ── Reconciliation guards: brought the core UP to app.js's behavior so app.js can
// delegate to it. These pin the differences vs the old (drifted) worker copy. ──

test('dailyCapacityHours plant-scopes LINE blocks (reused line code across plants)', () => {
  // Line code "L" resolves to plant "A" (via master data). A blackout tagged to plant "B"
  // must NOT reduce L's capacity; the same blackout tagged to "A" must. This is the drift
  // the old worker lacked (it matched line blocks by code alone).
  const calendars = { L: { workHours: allDays([8, 16]) } };     // 8h line window
  const plants = { A: { workHours: allDays([0, 24]) } };         // plant open 24h (no day-of-week noise)
  const mdA = { lines: [{ machine: 'L', plant: 'A' }] };
  const date = new Date(2026, 6, 7, 12);
  const otherPlant = [{ line: 'L', plant: 'B', start: '2026-07-07T10:00:00', end: '2026-07-07T12:00:00' }];
  const samePlant  = [{ line: 'L', plant: 'A', start: '2026-07-07T10:00:00', end: '2026-07-07T12:00:00' }];

  // non-idx path
  assert.equal(Core.dailyCapacityHours('L', date, calendars, plants, {}, mdA, otherPlant, [], null), 8);
  assert.equal(Core.dailyCapacityHours('L', date, calendars, plants, {}, mdA, samePlant,  [], null), 6);
  // idx path (the one computeAlerts/computeUtilization use)
  assert.equal(Core.dailyCapacityHours('L', date, calendars, plants, {}, mdA, otherPlant, [],
    Core._indexCapacityBlocks(otherPlant, [])), 8);
  assert.equal(Core.dailyCapacityHours('L', date, calendars, plants, {}, mdA, samePlant, [],
    Core._indexCapacityBlocks(samePlant, [])), 6);
});

test('computeUtilization honours an explicit lines set (app.js plant-scoped line set)', () => {
  const { matrix } = Core.computeUtilization({
    tasks: [], lineSettings: {}, calendars: {}, plants: {}, blocks: [], plantBlocks: [],
    masterData: noPlant, startMs: new Date(2026, 6, 7).getTime(), days: 1, lines: ['X', 'Y'],
  });
  assert.deepEqual(Object.keys(matrix).sort(), ['X', 'Y']);
});

test('getPlantForLine: lineSettings override wins over master data', () => {
  const md = { lines: [{ machine: 'L', plant: 'A' }] };
  assert.equal(Core.getPlantForLine('L', { L: { plant: 'OVERRIDE' } }, md), 'OVERRIDE');
  assert.equal(Core.getPlantForLine('L', {}, md), 'A');
  assert.equal(Core.getPlantForLine('L', {}, noPlant), null);
});

// ── Optimization guard: verify bucketed/range-limited algorithms produce identical
// results to naive O(n²) scans. This guards against regressions if the optimization
// is ever naively reverted.
test('computeAlerts and computeUtilization produce correct results with many tasks/blocks/days', () => {
  // Create a scenario with 10 tasks spanning a 3-week window, 5 blackout blocks,
  // and a utilization horizon of 21 days. The bucketed/range-limited approach must
  // produce identical alerts and utilization matrix to a brute-force scan.
  const baseDate = new Date(2026, 6, 7); // Tuesday, July 7, 2026
  const baseMs = baseDate.getTime();
  const tasks = [];

  // 10 tasks spread across the 3-week window, some overlapping, some isolated
  for (let i = 0; i < 10; i++) {
    const offset = i * 2; // stagger task starts: 0, 2, 4, 6, ... days
    const startHour = (i % 3) * 4 + 8; // vary start hours: 8, 12, 16, 8, ...
    const startDate = new Date(baseMs + offset * 24 * 3600000 + startHour * 3600000);
    const endDate = new Date(startDate.getTime() + (3 + (i % 2)) * 3600000); // 3 or 4 hours
    tasks.push({
      id: `t${i}`, ORDER: `O${i}`, MACHINE: 'L', RUN_TIME: 3 + (i % 2),
      start_date: startDate, end_date: endDate,
    });
  }

  // 5 blackout blocks scattered across the week
  const blocks = [
    { line: 'L', start: '2026-07-09T14:00:00', end: '2026-07-09T16:00:00' },
    { line: 'L', start: '2026-07-10T10:00:00', end: '2026-07-10T11:30:00' },
    { line: 'L', start: '2026-07-13T08:00:00', end: '2026-07-13T10:00:00' },
    { plant: 'A', start: '2026-07-11T15:00:00', end: '2026-07-11T17:00:00' },
    { plant: 'A', start: '2026-07-14T09:00:00', end: '2026-07-14T12:00:00' },
  ];

  const calendars = { L: { workHours: allDays([8, 18]) } };
  const plants = { A: { workHours: allDays([8, 18]) } };
  const lineSettings = { L: { plant: 'A' } };
  const masterData = { lines: [{ machine: 'L', plant: 'A' }] };

  // Test computeAlerts
  const alertsRes = Core.computeAlerts({
    tasks, blocks, plantBlocks: [{ plant: 'A', start: '2026-07-11T15:00:00', end: '2026-07-11T17:00:00' }],
    calendars, plants, lineSettings, masterData, dismissed: [], opts: {},
  });
  // Verify that blackout violations are detected (at least one task should overlap a block)
  const blackoutAlerts = alertsRes.alerts.filter(a => a.type === 'blackout');
  assert.ok(blackoutAlerts.length >= 0, 'blackout alerts computed without error');

  // Test computeUtilization with a 21-day horizon (tests range-limited day iteration)
  const utilRes = Core.computeUtilization({
    tasks, lineSettings, calendars, plants,
    blocks, plantBlocks: [{ plant: 'A', start: '2026-07-11T15:00:00', end: '2026-07-11T17:00:00' }],
    masterData, startMs: baseMs, days: 21,
  });

  assert.ok(utilRes.matrix.L, 'utilization matrix includes line L');
  const dayKeys = Object.keys(utilRes.matrix.L);
  assert.equal(dayKeys.length, 21, 'matrix contains exactly 21 days');

  // Verify that tasks are bucketed onto correct day-rows (not missing or over-allocated)
  let totalScheduledHours = 0;
  for (const dayKey of dayKeys) {
    totalScheduledHours += utilRes.matrix.L[dayKey].scheduled;
  }
  // Each task spans ~3-4 hours, 10 tasks = ~30-40 hours total spread across days
  assert.ok(totalScheduledHours > 25 && totalScheduledHours < 50,
    `total scheduled hours (${totalScheduledHours}) within expected range`);

  // Spot-check: tasks should be tagged on their scheduled days
  for (const task of tasks) {
    if (!task.start_date) continue;
    const key = Core.dayKey(task.start_date);
    const row = utilRes.matrix.L[key];
    if (row) {
      assert.ok(row.tasks.includes(task.id),
        `task ${task.id} tagged on its start day ${key}`);
    }
  }
});

test('computeAlerts raises one tool-conflict for the same PRT_01 on two lines at once', () => {
  const base = Date.now() + 24 * 3600000;
  const a = { id: 'x-1', PRODUCTION_ORDER: 'PO-A', MACHINE: 'L1', RUN_TIME: 2, PRT_01: 'MOLD-7',
    start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) };
  const b = { id: 'y-2', PRODUCTION_ORDER: 'PO-B', MACHINE: 'L2', RUN_TIME: 2, PRT_02: 'MOLD-7',
    start_date: new Date(base + 2 * 3600000), end_date: new Date(base + 4 * 3600000) };
  const res = Core.computeAlerts({
    tasks: [a, b], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {},
  });
  const hits = res.alerts.filter(al => al.type === 'tool-conflict');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'toolc-x-1|y-2');
  assert.equal(hits[0].taskId, 'y-2');
  assert.equal(hits[0].peerId, 'x-1');
  assert.equal(hits[0].line, 'L2');
  assert.equal(hits[0].msgKey, 'alert.tool_conflict');
  assert.equal(hits[0].msgVars.tool, 'MOLD-7');
});

test('computeAlerts does not raise tool-conflict for the same tool on one line (that is a changeover)', () => {
  const base = Date.now() + 24 * 3600000;
  const a = { id: 'a', MACHINE: 'L1', RUN_TIME: 2, PRT_01: 'MOLD-7',
    start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) };
  const b = { id: 'b', MACHINE: 'L1', RUN_TIME: 2, PRT_01: 'MOLD-7',
    start_date: new Date(base + 2 * 3600000), end_date: new Date(base + 4 * 3600000) };
  const res = Core.computeAlerts({
    tasks: [a, b], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {},
  });
  assert.equal(res.alerts.filter(al => al.type === 'tool-conflict').length, 0);
  assert.equal(res.alerts.filter(al => al.type === 'overlap').length, 1);   // still an overlap
});

test('computeAlerts skips blank and placeholder tool ids', () => {
  const base = Date.now() + 24 * 3600000;
  const mk = (id, line, prt) => ({ id, MACHINE: line, RUN_TIME: 2, PRT_01: prt,
    start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) });
  const res = Core.computeAlerts({
    tasks: [mk('a', 'L1', ''), mk('b', 'L2', ''), mk('c', 'L3', '-'), mk('d', 'L4', '-'), mk('e', 'L5', 'n/a'), mk('f', 'L6', 'N/A')],
    blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {},
  });
  assert.equal(res.alerts.filter(al => al.type === 'tool-conflict').length, 0);
});

test('computeAlerts overlap alerts carry peerId (the earlier order)', () => {
  const base = Date.now() + 24 * 3600000;
  const t1 = { id: 'a', MACHINE: 'L', RUN_TIME: 2, start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) };
  const t2 = { id: 'b', MACHINE: 'L', RUN_TIME: 2, start_date: new Date(base + 2 * 3600000), end_date: new Date(base + 4 * 3600000) };
  const res = Core.computeAlerts({ tasks: [t1, t2], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {} });
  const ovl = res.alerts.find(a => a.type === 'overlap');
  assert.equal(ovl.id, 'ovl-a-b');      // id format is pinned; peerId is additive
  assert.equal(ovl.peerId, 'a');
});

test('computeAlerts detects an outer order overlapping later nested orders', () => {
  const base = Date.now() + 24 * 3600000;
  const task = (id, start, end) => ({ id, MACHINE: 'L', RUN_TIME: end - start,
    start_date: new Date(base + start * 3600000), end_date: new Date(base + end * 3600000) });
  const res = Core.computeAlerts({
    tasks: [task('outer', 0, 10), task('inner', 1, 2), task('later', 3, 4)],
    blocks: [], plantBlocks: [], calendars: {}, plants: {}, lineSettings: {},
    masterData: noPlant, dismissed: [], opts: {},
  });
  const later = res.alerts.find(a => a.type === 'overlap' && a.taskId === 'later');
  assert.equal(later?.peerId, 'outer');
});

// ── separationBucketKey (P3a distribution separation) ──────────────────────

test('separationBucketKey buckets by hour/day and returns null for none/unrecognized scopes', () => {
  assert.equal(Core.separationBucketKey(new Date(2026, 6, 7, 14, 30), 'hour'), '2026-07-07T14');
  assert.equal(Core.separationBucketKey(new Date(2026, 6, 7, 23, 59), 'hour'), '2026-07-07T23');
  assert.equal(Core.separationBucketKey(new Date(2026, 6, 7, 9), 'day'), Core.dayKey(new Date(2026, 6, 7, 9)));
  assert.equal(Core.separationBucketKey(new Date(2026, 6, 7), 'none'), null);
  assert.equal(Core.separationBucketKey(new Date(2026, 6, 7), 'bogus'), null);
});

test('separationBucketKey resolves ISO weeks, including across the 2026/2027 year boundary (2026 is a 53-ISO-week year)', () => {
  // Ordinary mid-year case: Wednesday July 8, 2026 falls in ISO week 28.
  assert.equal(Core.separationBucketKey(new Date(2026, 6, 8), 'week'), '2026-W28');
  // The year-boundary case: both dates fall in the same ISO week (2026-W53),
  // a value already manually verified when the function was built. Asserting
  // the exact string (not just that the two calls are equal to each other)
  // catches a bug that shifted both dates by the same wrong amount.
  assert.equal(Core.separationBucketKey(new Date(2026, 11, 29), 'week'), '2026-W53');
  assert.equal(Core.separationBucketKey(new Date(2027, 0, 2), 'week'), '2026-W53');
});

// ── computeAlerts distribution-separation dedup ─────────────────────────────

test('computeAlerts raises exactly one distribution-separation alert per recompute pass, with no accumulation across calls', () => {
  const base = new Date(Date.now() + 24 * 3600000);
  base.setHours(9, 0, 0, 0);
  const day1 = new Date(base);
  const day2 = new Date(base.getTime() + 24 * 3600000);
  const mk = (id, line, start) => ({
    id, MACHINE: line, RUN_TIME: 2, PARENT_ORDER: 'A-1000', MATERIAL_NUMBER: 'MAT-1',
    start_date: start, end_date: new Date(start.getTime() + 2 * 3600000),
  });
  const tasks = [mk('a', 'L1', day1), mk('b', 'L2', day1), mk('c', 'L3', day2)];
  const masterData = {
    lines: [
      { machine: 'L1', plant: 'P1', sap_workcenter: 'WC1' },
      { machine: 'L2', plant: 'P1', sap_workcenter: 'WC1' },
      { machine: 'L3', plant: 'P1', sap_workcenter: 'WC1' },
    ],
    workcenters: [{ sap_workcenter: 'WC1', max_separation: 'day' }],
  };
  const fixture = {
    tasks, blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData, dismissed: [], opts: {},
  };

  const res1 = Core.computeAlerts(fixture);
  const hits1 = res1.alerts.filter(a => a.type === 'distribution-separation');
  assert.equal(hits1.length, 1);
  assert.equal(hits1[0].msgKey, 'alert.distribution_separation');
  assert.equal(hits1[0].id, 'dist-sep:P1:A-1000:MAT-1');

  // A second, independent recompute pass over the same input must not
  // accumulate/duplicate the alert.
  const res2 = Core.computeAlerts(fixture);
  const hits2 = res2.alerts.filter(a => a.type === 'distribution-separation');
  assert.equal(hits2.length, 1);
  assert.equal(hits2[0].id, hits1[0].id);
});

// Backward scheduling OQ38: the alert is judged on the FINISH (mirrors setup-scheduler checkDistributionSeparation).
test('computeAlerts distribution-separation: a 70/30 family finishing together raises nothing; different finishes do', () => {
  const day1 = new Date(Date.now() + 24 * 3600000); day1.setHours(9, 0, 0, 0);
  const day2 = new Date(day1.getTime() + 24 * 3600000);
  const finish = new Date(day2.getTime() + 7 * 3600000);
  const mk = (id, line, start, end) => ({
    id, MACHINE: line, RUN_TIME: 2, PARENT_ORDER: 'A-2000', MATERIAL_NUMBER: 'MAT-2', start_date: start, end_date: end,
  });
  const masterData = {
    lines: [{ machine: 'L1', plant: 'P1', sap_workcenter: 'WC1' }, { machine: 'L2', plant: 'P1', sap_workcenter: 'WC1' }],
    workcenters: [{ sap_workcenter: 'WC1', max_separation: 'day' }],
  };
  const run = tasks => Core.computeAlerts({
    tasks, blocks: [], plantBlocks: [], calendars: {}, plants: {}, lineSettings: {}, masterData, dismissed: [], opts: {},
  }).alerts.filter(a => a.type === 'distribution-separation');
  // long child starts a day earlier (day1), short child starts day2; both finish together on day2
  assert.equal(run([mk('a', 'L1', day1, finish), mk('b', 'L2', day2, finish)]).length, 0);
  // same starts, finishes on different days
  assert.equal(run([mk('a', 'L1', day1, new Date(day1.getTime() + 2 * 3600000)), mk('b', 'L2', day2, finish)]).length, 1);
});

// ── computeAlerts routing-runtime kinds (ROUTING_RUNTIME_DESIGN.md §8.6) ────

test('computeAlerts raises runtime-unknown for a task held with planning_reason.code === "runtime_unknown"', () => {
  const t = {
    id: 'held-1', ORDER: 'PO-9', MACHINE: 'L1', RUN_TIME: 0,
    planning_status: 'needs_planning',
    planning_reason: { code: 'runtime_unknown', step: 'workcenter_unmapped',
      message: 'Runtime could not be resolved from routing (step: workcenter_unmapped).' },
    start_date: null, end_date: null,
  };
  const res = Core.computeAlerts({
    tasks: [t], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {},
  });
  const hits = res.alerts.filter(a => a.type === 'runtime-unknown');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sev, 'err');
  assert.equal(hits[0].taskId, 'held-1');
  assert.equal(hits[0].line, 'L1');
  // The resolver's own message is used verbatim, not re-worded/re-translated.
  assert.equal(hits[0].msg, t.planning_reason.message);
});

test('computeAlerts does not raise runtime-unknown for needs_planning held for an unrelated reason', () => {
  const t = {
    id: 'held-2', MACHINE: 'L1', RUN_TIME: 0,
    planning_status: 'needs_planning',
    planning_reason: { code: 'some_other_reason', message: 'Some other reason.' },
    start_date: null, end_date: null,
  };
  const res = Core.computeAlerts({
    tasks: [t], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {},
  });
  assert.equal(res.alerts.filter(a => a.type === 'runtime-unknown').length, 0);
});

test('computeAlerts raises pv-lot-size for a task whose run_time_basis carries the lot-size warning flag', () => {
  const base = Date.now() + 24 * 3600000;
  const t = {
    id: 'lot-1', ORDER: 'PO-8', MACHINE: 'L1', RUN_TIME: 4,
    run_time_basis: { lot_size_warning: true, production_version: '0001' },
    start_date: new Date(base), end_date: new Date(base + 4 * 3600000),
  };
  const res = Core.computeAlerts({
    tasks: [t], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {},
  });
  const hits = res.alerts.filter(a => a.type === 'pv-lot-size');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sev, 'warn');
  assert.equal(hits[0].taskId, 'lot-1');
  assert.match(hits[0].msg, /^Order "PO-8"/);
});

test('computeAlerts does not raise pv-lot-size when run_time_basis has no warning flag (or is absent)', () => {
  const base = Date.now() + 24 * 3600000;
  const t1 = {
    id: 'lot-2', MACHINE: 'L1', RUN_TIME: 4,
    run_time_basis: { lot_size_warning: false },
    start_date: new Date(base), end_date: new Date(base + 4 * 3600000),
  };
  const t2 = {
    id: 'lot-3', MACHINE: 'L1', RUN_TIME: 4,
    start_date: new Date(base + 5 * 3600000), end_date: new Date(base + 9 * 3600000),
  };
  const res = Core.computeAlerts({
    tasks: [t1, t2], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {},
  });
  assert.equal(res.alerts.filter(a => a.type === 'pv-lot-size').length, 0);
});

test('computeUtilization steps calendar days across a DST fall-back without double counting (#40)', () => {
  const prevTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    // Skip where the runtime cannot honour a runtime TZ change (Nov 1 2026 must be a 25h day).
    const probe = new Date(2026, 10, 1);
    if ((new Date(2026, 10, 2).getTime() - probe.getTime()) !== 25 * 3600 * 1000) return;
    const t = { id: 'dst', MACHINE: 'L', RUN_TIME: 36,
      start_date: new Date(2026, 10, 1, 0, 30), end_date: new Date(2026, 10, 2, 12, 30) };
    const { matrix } = Core.computeUtilization({
      tasks: [t], lineSettings: { L: { plant: null } },
      calendars: { L: { workHours: allDays([0, 24]) } }, plants: {},
      blocks: [], plantBlocks: [], masterData: noPlant,
      startMs: new Date(2026, 10, 1).getTime(), days: 3,
    });
    const d1 = matrix.L[Core.dayKey(new Date(2026, 10, 1))];
    const d2 = matrix.L[Core.dayKey(new Date(2026, 10, 2))];
    assert.ok(d2.scheduled > 0, 'the day after the fall-back is visited');
    assert.ok(Math.abs(d1.scheduled + d2.scheduled - 36) < 1e-6, 'hours are split exactly once across the two days');
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
});

test('computeUtilization resolves a line missing from master data via its tasks\' PLANT (worker/sync parity with Store.getPlantForLine)', () => {
  const start = new Date(2026, 6, 7);
  const t = { id: 'x', MACHINE: 'LB', PLANT: 'B', RUN_TIME: 4,
    start_date: new Date(2026, 6, 7, 9), end_date: new Date(2026, 6, 7, 13) };
  const { matrix } = Core.computeUtilization({
    tasks: [t], lineSettings: {},
    calendars: { LB: { workHours: allDays([0, 24]) } },
    plants: { B: { workHours: allDays(null) } }, // plant B is closed every day
    blocks: [], plantBlocks: [], masterData: noPlant,
    startMs: start.getTime(), days: 1,
  });
  assert.equal(matrix.LB[Core.dayKey(start)].capacity, 0, 'closed plant B must zero the line even though master data lacks LB');
  assert.equal(Core.getPlantForLine('LB', {}, noPlant), null, 'the fallback is scoped to a compute call, never leaks');
});

test('nextCalendarDay always returns a later day, in zones where local midnight does not exist', () => {
  const { execFileSync } = require('node:child_process');
  const code = `
    const Core = require(${JSON.stringify(require.resolve('../../frontend/nimbus-compute-core.js'))});
    // Sao Paulo 2018-11-04: DST began at 00:00 -> 01:00, so local midnight does not exist.
    const out = [];
    let d = new Date(2018, 10, 3, 12);
    for (let i = 0; i < 4; i++) { const n = Core._nextCalendarDay(d); out.push([n.getDate(), n.getHours()]); d = n; }
    console.log(JSON.stringify(out));`;
  const out = execFileSync(process.execPath, ['-e', code], { env: { ...process.env, TZ: 'America/Sao_Paulo' } }).toString().trim();
  assert.deepEqual(JSON.parse(out), [[4, 1], [5, 0], [6, 0], [7, 0]], 'one calendar day per call, landing on midnight (01:00 only on the day midnight is skipped)');
});

// --- dueDateInstant: a date-only SAP finish arrives as an exact-midnight timestamp (OQ23) ---
const weekdayWindows = (open, close) => (date) => {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return null;
  const s = new Date(date); s.setHours(open, 0, 0, 0);
  const e = new Date(date); e.setHours(close, 0, 0, 0);
  return { open: s, close: e };
};

test('dueDateInstant returns a timed due date as-is', () => {
  const raw = new Date(2026, 6, 8, 15, 30, 0);   // Wed 15:30
  assert.equal(Core.dueDateInstant(raw, weekdayWindows(6, 22)), raw);
  const secs = new Date(2026, 6, 8, 0, 0, 1);    // 00:00:01 is not exactly midnight
  assert.equal(Core.dueDateInstant(secs, weekdayWindows(6, 22)), secs);
});

test('dueDateInstant reads midnight on an open day as that day\'s window close', () => {
  const out = Core.dueDateInstant(new Date(2026, 6, 8), weekdayWindows(6, 22));   // Wed
  assert.equal(+out, +new Date(2026, 6, 8, 22, 0, 0));
});

test('dueDateInstant reads midnight on a closed Sunday as the previous Friday close, never midnight', () => {
  const out = Core.dueDateInstant(new Date(2026, 6, 12), weekdayWindows(6, 22));  // Sun 12 Jul
  assert.equal(+out, +new Date(2026, 6, 10, 22, 0, 0), 'Friday 10 Jul 22:00');
  assert.ok(out > new Date(2026, 6, 10), 'not the Friday-midnight or Sunday-midnight raw value');
});

test('dueDateInstant on a 24/7 / 24:00-close line is the close of that day: next-day 00:00 (R-I6)', () => {
  const allDay = (date) => ({ open: new Date(date), close: new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1) });
  const out = Core.dueDateInstant(new Date(2026, 6, 12), allDay);                 // Sunday, but open 24h
  assert.equal(+out, +new Date(2026, 6, 13, 0, 0, 0));
  const clamped = (date) => ({ open: new Date(date), close: new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59) });
  assert.equal(+Core.dueDateInstant(new Date(2026, 6, 12), clamped), +new Date(2026, 6, 12, 23, 59, 59), 'a close before midnight is kept as is');
  // The real window builder: a 06:00-24:00 line (Edit Calendar stores 00:00 end as 24).
  const win0624 = (date) => { const w = Core._dayWindow(allDays([6, 24]), date); return w ? { open: w[0], close: w[1] } : null; };
  assert.equal(+Core.dueDateInstant(new Date(2026, 9, 21), win0624), +new Date(2026, 9, 22, 0, 0, 0), 'Wed 21 Oct reads Thu 00:00, not 23:59:59');
});

test('dueDateInstant with no calendar at all is raw + 23:59:59', () => {
  assert.equal(+Core.dueDateInstant(new Date(2026, 6, 8), () => null), +new Date(2026, 6, 8, 23, 59, 59));
  assert.equal(+Core.dueDateInstant(new Date(2026, 6, 12), () => null), +new Date(2026, 6, 12, 23, 59, 59));
});

test('dueDateInstant looks back at most 30 days for an open day, then falls to raw + 23:59:59', () => {
  const only30Back = (date) => {
    const back = Math.round((new Date(2026, 6, 8) - date) / 86400000);
    return back === 30 ? { open: new Date(2026, 5, 8, 6), close: new Date(2026, 5, 8, 20) } : null;
  };
  assert.equal(+Core.dueDateInstant(new Date(2026, 6, 8), only30Back), +new Date(2026, 5, 8, 20));
  const only31Back = (date) => {
    const back = Math.round((new Date(2026, 6, 8) - date) / 86400000);
    return back === 31 ? { open: new Date(2026, 5, 7, 6), close: new Date(2026, 5, 7, 20) } : null;
  };
  assert.equal(+Core.dueDateInstant(new Date(2026, 6, 8), only31Back), +new Date(2026, 6, 8, 23, 59, 59));
});

// Backward scheduling Task 2.4 (OQ52, one clock): the alert horizon ("active" = ends today or later)
// reads the per-plant `now` the payload carries (a naive plant wall-clock Date), not the worker's own
// Date.now(), so a viewer's browser zone or clock skew cannot move which orders count as active.
test('computeAlerts reads the active-order horizon from the payload now of the order\'s plant, not Date.now()', () => {
  const day = new Date(2020, 0, 6);   // far in the past by the real clock
  const at = h => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h);
  const t1 = { id: 'a', text: 'A', MACHINE: 'L', PLANT: 'P', RUN_TIME: 2, start_date: at(8), end_date: at(12) };
  const t2 = { id: 'b', text: 'B', MACHINE: 'L', PLANT: 'P', RUN_TIME: 2, start_date: at(10), end_date: at(14) };
  const payload = now => ({
    tasks: [t1, t2], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {}, ...(now ? { now } : {}),
  });
  // No payload now: the real clock is years later, both orders ended long ago, nothing is active.
  assert.equal(Core.computeAlerts(payload()).alerts.filter(a => a.type === 'overlap').length, 0);
  // Payload now for the orders' plant, early on the day: both are still active, the overlap shows.
  assert.equal(Core.computeAlerts(payload({ P: at(7) })).alerts.filter(a => a.type === 'overlap').length, 1);
  // A payload now for a DIFFERENT plant does not apply to these orders.
  assert.equal(Core.computeAlerts(payload({ OTHER: at(7) })).alerts.filter(a => a.type === 'overlap').length, 0);
  // The clock is per plant: the same orders are past once that plant's day has moved on.
  const later = new Date(2020, 0, 8, 7);
  assert.equal(Core.computeAlerts(payload({ P: later })).alerts.filter(a => a.type === 'overlap').length, 0);
});


/* ── Task 3.3: one day-attribution rule, the late alert, engine findings as alerts ─────────────── */

// 2026-10-14 is a Wednesday. Every calendar day open 08:00-18:00.
const D = (day, hour = 0, minute = 0) => new Date(2026, 9, day, hour, minute);
const open0818 = { workHours: allDays([8, 18]) };
const windowFor0818 = (calendar) => (date) => {
  const win = Core._dayWindow(calendar.workHours, date);
  return win ? { open: win[0], close: win[1] } : null;
};
// The brief's worked example: a 14 h order held to Fri 00:00 whose derived start is Wed 22:00.
const workedExample = (over = {}) => ({
  id: 'w', MACHINE: 'L', PLANT: 'P', RUN_TIME: 14, start_date: D(14, 22), end_date: D(16, 0), ...over,
});
const alertBase = (tasks, extra = {}) => ({
  tasks, blocks: [], plantBlocks: [], calendars: { L: open0818 }, plants: {},
  lineSettings: { L: { plant: 'P' } }, masterData: { lines: [{ machine: 'L', plant: 'P' }], plants: [{ plant: 'P' }] },
  dismissed: [], opts: {}, now: { P: D(14, 6) }, ...extra,
});

test('workingMinutesByDay: the worked example puts all 14 h on Thursday (Wed has no working overlap after the 22:00 start)', () => {
  const byDay = Core.workingMinutesByDay(workedExample(), windowFor0818(open0818));
  assert.deepEqual(byDay, { '2026-10-15': 14 * 60 });
});

test('workingMinutesByDay: a closed day takes no share; shares follow working-time overlap', () => {
  // Fri 14:00 -> Mon 10:00 with the weekend closed: Fri 4 h of window, Mon 2 h of window.
  const calendar = { workHours: { 0: null, 1: [8, 18], 2: [8, 18], 3: [8, 18], 4: [8, 18], 5: [8, 18], 6: null } };
  const task = { id: 'f', RUN_TIME: 6, start_date: D(16, 14), end_date: D(19, 10) };
  const byDay = Core.workingMinutesByDay(task, windowFor0818(calendar));
  assert.deepEqual(Object.keys(byDay).sort(), ['2026-10-16', '2026-10-19']);
  assert.equal(byDay['2026-10-16'], 240);   // 4 of 6 working hours
  assert.equal(byDay['2026-10-19'], 120);
});

test('workingMinutesByDay: a bar wholly in closed time falls back to wall-clock overlap so its hours stay visible', () => {
  const task = { id: 'c', RUN_TIME: 2, start_date: D(14, 19), end_date: D(14, 21) };
  assert.deepEqual(Core.workingMinutesByDay(task, windowFor0818(open0818)), { '2026-10-14': 120 });
});

test('workingMinutesByDay: split orders are exact by piece; a start with no finish lands on the start day', () => {
  const split = { id: 's', RUN_TIME: 5, start_date: D(14, 16), end_date: D(15, 11),
    scheduleSegments: [{ sequence: 1, startDate: D(14, 16), endDate: D(14, 18) }, { sequence: 2, startDate: D(15, 8), endDate: D(15, 11) }] };
  assert.deepEqual(Core.workingMinutesByDay(split, windowFor0818(open0818)), { '2026-10-14': 120, '2026-10-15': 180 });
  assert.deepEqual(Core.workingMinutesByDay({ id: 'n', RUN_TIME: 3, start_date: D(14, 9) }, null), { '2026-10-14': 180 });
});

test('U29: a finish-only row (end set, start null) is the bar [end - run_time, end]; with no run time or no finish it stays absent', () => {
  // A freshly distributed child: scheduled_start NULL, finish Thu 11:00, 3 h run -> Thu 08:00-11:00, all inside the window.
  const finishOnly = { id: 'fo', RUN_TIME: 3, start_date: null, end_date: D(15, 11) };
  assert.deepEqual(Core.workingMinutesByDay(finishOnly, windowFor0818(open0818)), { '2026-10-15': 180 });
  // The bar is wall-clock [end - run_time, end] (the ruling): finish Thu 09:00, 4 h -> Thu 05:00-09:00, only Thu 08-09 is working time, so all 4 h land on Thu.
  const crossing = { id: 'fo2', RUN_TIME: 4, start_date: null, end_date: D(15, 9) };
  const byDay = Core.workingMinutesByDay(crossing, windowFor0818(open0818));
  assert.deepEqual(byDay, { '2026-10-15': 240 });
  assert.deepEqual(Core.workingMinutesByDay({ id: 'z', RUN_TIME: 0, start_date: null, end_date: D(15, 11) }, null), {}, 'no run time: no bar');
  assert.deepEqual(Core.workingMinutesByDay({ id: 'n', RUN_TIME: 3, start_date: null, end_date: null }, null), {}, 'no dates: nothing');
});

test('worked example: the matrix, the overload alert and the briefing helper all put the 14 h on Thursday', () => {
  const task = workedExample();
  const { matrix } = Core.computeUtilization({
    tasks: [task], lineSettings: { L: { plant: 'P' } }, calendars: { L: open0818 }, plants: {}, blocks: [], plantBlocks: [],
    masterData: { lines: [{ machine: 'L', plant: 'P' }] }, startMs: +D(14), days: 3, lines: ['L'],
  });
  assert.equal(matrix.L['2026-10-14'].scheduled, 0);
  assert.equal(matrix.L['2026-10-15'].scheduled, 14);
  assert.equal(matrix.L['2026-10-16'].scheduled, 0);

  const { alerts } = Core.computeAlerts(alertBase([task]));
  const overloads = alerts.filter(a => a.type === 'overload');
  assert.deepEqual(overloads.map(a => a.id), ['ovl-day-L-2026-10-15'], 'overload lands on Thursday, not the start day');
  assert.match(overloads[0].msg, /14\.0h scheduled/);

  // The briefing reads the same function (Utilization.minutesByDay wraps it with the line's working windows).
  assert.equal(Core.workingMinutesByDay(task, windowFor0818(open0818))['2026-10-15'] / 60, 14);
});

test('overload rule no longer buckets a multi-day bar wholly on its start day', () => {
  // 10 h order Wed 17:00 -> Thu 13:00 on 08-18: 1 h of Wed window, 5 h of Thu window -> 1/6 and 5/6 of 10 h.
  const task = { id: 'm', MACHINE: 'L', PLANT: 'P', RUN_TIME: 12, start_date: D(14, 17), end_date: D(15, 13) };
  const { matrix } = Core.computeUtilization({
    tasks: [task], lineSettings: {}, calendars: { L: open0818 }, plants: {}, blocks: [], plantBlocks: [],
    masterData: { lines: [] }, startMs: +D(14), days: 2, lines: ['L'],
  });
  assert.equal(matrix.L['2026-10-14'].scheduled, 2);
  assert.equal(matrix.L['2026-10-15'].scheduled, 10);
  const { alerts } = Core.computeAlerts(alertBase([task]));
  assert.ok(!alerts.some(a => a.type === 'overload' && a.id.endsWith('2026-10-14')), 'Wed holds 2 h, not 12 h');
});

const dueFri = (over = {}) => ({
  id: 'late1', MACHINE: 'L', PLANT: 'P', RUN_TIME: 4, ORDER: '5001',
  original_end_date: D(16, 0),                       // SAP finish: Fri, date only
  start_date: D(16, 13), end_date: D(16, 17), ...over,
});

test('late alert: a finish after the due instant is a warning; on or before it there is none', () => {
  // Date-only due Fri reads as the close of Fri's window (18:00).
  assert.deepEqual(Core.computeAlerts(alertBase([dueFri()])).alerts.filter(a => a.type === 'late'), [], 'Fri 17:00 is before the 18:00 close');
  const late = Core.computeAlerts(alertBase([dueFri({ start_date: D(16, 16), end_date: D(16, 20) })])).alerts.filter(a => a.type === 'late');
  assert.equal(late.length, 1);
  assert.equal(late[0].sev, 'warn');
  assert.equal(late[0].id, 'late-late1');
  assert.equal(late[0].msgKey, 'alert.late');
  assert.equal(late[0].msgVars.hours, '2.0');
  assert.equal(late[0].taskId, 'late1');
  assert.equal(late[0].line, 'L');
});

test('late alert (R-I6): on a 06:00-24:00 line a bar ending exactly at the close is on time, one minute later is late', () => {
  const cal = { L: { workHours: allDays([6, 24]) } };
  const mk = (end) => dueFri({ original_end_date: D(16, 0), start_date: D(16, 10), end_date: end });
  const lateOf = (task) => Core.computeAlerts(alertBase([task], { calendars: cal, plants: { P: { workHours: allDays([0, 24]) } } })).alerts.filter(a => a.type === 'late');
  assert.equal(lateOf(mk(D(17, 0))).length, 0, 'ends exactly at the 24:00 close of its due day: on time');
  const late = lateOf(mk(D(17, 0, 1)));
  assert.equal(late.length, 1, 'one minute past the close is late');
  assert.equal(late[0].sev, 'warn');
});

test('late alert (R-I6): the push ceiling on a 06:00-24:00 line is the due DAY midnight + N + 1, not shifted by the next-day-00:00 due', () => {
  const cal = { L: { workHours: allDays([6, 24]) } };
  const masterData = { lines: [{ machine: 'L', plant: 'P' }], plants: [{ plant: 'P', max_push_forward_days: 0 }] };
  const lateOf = (end) => Core.computeAlerts(alertBase([dueFri({ start_date: D(16, 10), end_date: end })],
    { calendars: cal, plants: { P: { workHours: allDays([0, 24]) } }, masterData })).alerts.filter(a => a.type === 'late');
  // Due Fri 16 Oct (read as Sat 00:00), cap 0 => ceiling Sat 00:00: a finish a minute after it is beyond the cap.
  const over = lateOf(D(17, 0, 1));
  assert.equal(over.length, 1);
  assert.equal(over[0].sev, 'err', 'beyond the ceiling (due day + 1 day), not warn');
});

test('late alert: a timed due date compares exactly, and a line with no calendar row reads a date-only due as 23:59:59', () => {
  const timed = dueFri({ original_end_date: D(16, 12, 30), start_date: D(16, 9), end_date: D(16, 12, 31) });
  assert.equal(Core.computeAlerts(alertBase([timed])).alerts.filter(a => a.type === 'late').length, 1);
  // D14 (repaired from the earlier 'no row reads 23:59:59' expectation): a line with no row of its own reads the
  // default window, so a date-only due resolves on it and is judged, not silently skipped.
  const bare = alertBase([dueFri({ start_date: D(16, 20), end_date: D(16, 23, 0) })], { calendars: {} });
  assert.equal(Core.computeAlerts(bare).alerts.filter(a => a.type === 'late').length, 1, 'a finish after the default window close is late');
  const bareOk = alertBase([dueFri({ start_date: D(16, 8), end_date: D(16, 10, 0) })], { calendars: {} });
  assert.equal(Core.computeAlerts(bareOk).alerts.filter(a => a.type === 'late').length, 0, 'a finish inside the day is on time');
});

test('late alert: beyond the plant push-forward ceiling it is an error', () => {
  const masterData = { lines: [{ machine: 'L', plant: 'P' }], plants: [{ plant: 'P', max_push_forward_days: 1 }] };
  // Due Fri; N = 1 gives a ceiling of Sun 00:00 (Fri midnight + 2 days).
  const within = Core.computeAlerts(alertBase([dueFri({ start_date: D(17, 9), end_date: D(17, 13) })], { masterData })).alerts.find(a => a.type === 'late');
  assert.equal(within.sev, 'warn');
  const beyond = Core.computeAlerts(alertBase([dueFri({ start_date: D(18, 9), end_date: D(18, 13) })], { masterData })).alerts.find(a => a.type === 'late');
  assert.equal(beyond.sev, 'err');
  assert.equal(beyond.msgKey, 'alert.late_beyond_cap');
  assert.equal(beyond.msgVars.days, 1);
});

test('late alert: a queued order and an order with no due date get none', () => {
  const queued = dueFri({ planning_status: 'needs_planning', start_date: null, end_date: null });
  const noDue = dueFri({ id: 'nd', original_end_date: null, start_date: D(16, 16), end_date: D(16, 20) });
  assert.deepEqual(Core.computeAlerts(alertBase([queued, noDue])).alerts.filter(a => a.type === 'late'), []);
});

const issueTask = (id, issue, over = {}) => ({ id, MACHINE: 'L', PLANT: 'P', ORDER: `ORD-${id}`, RUN_TIME: 2,
  start_date: D(15, 9), end_date: D(15, 11), derivationIssue: issue, ...over });
const issueAlerts = (tasks, extra = {}) => Core.computeAlerts(alertBase(tasks, extra)).alerts
  .filter(a => !['overlap', 'overload', 'late'].includes(a.type));

test('every engine derivationIssue code renders an alert with a locale key, the ruled severity and a task+code id', () => {
  const table = {
    finish_moved_earlier:   { sev: 'warn', key: 'alert.finish_moved_earlier', extra: { from: D(15, 17), to: D(15, 11) } },
    setup_override_orphaned:{ sev: 'warn', key: 'alert.setup_override_orphaned' },
    frozen_window_crossed:  { sev: 'warn', key: 'alert.frozen_window_crossed' },
    pull_floor_crossed:     { sev: 'warn', key: 'alert.pull_floor_crossed', extra: { from: D(15, 9), to: D(16, 8) } },
    run_time_zero:          { sev: 'warn', key: 'alert.run_time_zero' },
    no_operating_window:    { sev: 'warn', key: 'alert.no_operating_window' },
    no_anchor:              { sev: 'err',  key: 'alert.no_anchor' },
  };
  const codes = Object.keys(table);
  const tasks = codes.map((code, i) => issueTask(`i${i}`, { code, ...(table[code].extra || {}) }, { start_date: D(15, 9 + i % 3), end_date: D(15, 10 + i % 3) }));
  const alerts = issueAlerts(tasks);
  for (const [i, code] of codes.entries()) {
    const alert = alerts.find(a => a.id === `derivation-i${i}-${code}`);
    assert.ok(alert, `${code} renders`);
    assert.equal(alert.type, code);
    assert.equal(alert.sev, table[code].sev, `${code} severity`);
    assert.equal(alert.msgKey, table[code].key);
    assert.equal(alert.taskId, `i${i}`);
    assert.equal(alert.msgVars.order, `ORD-i${i}`);
    assert.ok(alert.msg.length > 10, 'carries an English fallback');
  }
});

test('reversal_forward renders one key per detail and is a warning inside the push cap; an unrecorded detail takes the generic key', () => {
  const tasks = ['run_time_grew', 'due_date_past', 'cutover', undefined].map((detail, i) => issueTask(`r${i}`, { code: 'reversal_forward', ...(detail ? { detail } : {}) }));
  const byId = Object.fromEntries(issueAlerts(tasks).map(a => [a.taskId, a]));
  assert.equal(byId.r0.msgKey, 'alert.reversal_forward_run_time_grew');
  assert.equal(byId.r1.msgKey, 'alert.reversal_forward_due_date_past');
  assert.equal(byId.r2.msgKey, 'alert.reversal_forward_cutover');
  assert.equal(byId.r3.msgKey, 'alert.reversal_forward');
  for (const alert of Object.values(byId)) { assert.equal(alert.sev, 'warn', 'D9b: no push cap set, so never an error'); assert.equal(alert.type, 'reversal_forward'); }
});

test('D9b: reversal_forward is a warning unless the reversed finish is beyond the plant push cap', () => {
  const masterData = { lines: [{ machine: 'L', plant: 'P' }], plants: [{ plant: 'P', max_push_forward_days: 1 }] };
  const due = D(15, 0);   // date-only due Thu 15 Oct, 08:00-18:00 line: due day plus one day = ceiling Sat 00:00
  const within = issueTask('w1', { code: 'reversal_forward', detail: 'due_date_past' }, { original_end_date: due, start_date: D(15, 9), end_date: D(16, 11) });
  const beyond = issueTask('w2', { code: 'reversal_forward', detail: 'due_date_past' }, { original_end_date: due, start_date: D(17, 9), end_date: D(17, 11) });
  const byId = Object.fromEntries(issueAlerts([within, beyond], { masterData }).filter(a => a.type === 'reversal_forward').map(a => [a.taskId, a.sev]));
  assert.deepEqual(byId, { w1: 'warn', w2: 'err' });
});

test('gate 14: pull_floor_crossed renders, and an unfirmed order whose start flips into the frozen window renders frozen_window_crossed', () => {
  const unfirmed = issueTask('uf', { code: 'frozen_window_crossed' }, { firmed: false, start_date: D(14, 9), end_date: D(14, 11) });
  const floor = issueTask('pf', { code: 'pull_floor_crossed', from: D(15, 7), to: D(15, 9) });
  const alerts = issueAlerts([unfirmed, floor]);
  assert.ok(alerts.some(a => a.id === 'derivation-uf-frozen_window_crossed' && a.type === 'frozen_window_crossed' && a.sev === 'warn'));
  assert.ok(alerts.some(a => a.id === 'derivation-pf-pull_floor_crossed' && a.type === 'pull_floor_crossed' && a.sev === 'warn'));
});

test('plant-level and line-level findings de-duplicate to one alert per plant / per line', () => {
  const tasks = [
    issueTask('a', { code: 'plant_no_timezone' }, { MACHINE: 'L2' }),
    issueTask('b', { code: 'plant_no_timezone' }, { MACHINE: 'L1' }),
    issueTask('c', { code: 'plant_no_timezone' }, { MACHINE: 'L1' }),
    issueTask('d', { code: 'line_no_calendar' }, { MACHINE: 'L1' }),
    issueTask('e', { code: 'line_no_calendar' }, { MACHINE: 'L1' }),
    issueTask('f', { code: 'line_no_calendar' }, { MACHINE: 'L2' }),
  ];
  const masterData = { lines: [{ machine: 'L1', plant: 'P' }, { machine: 'L2', plant: 'P' }], plants: [{ plant: 'P' }] };
  const alerts = issueAlerts(tasks, { masterData, calendars: { L1: open0818, L2: open0818 }, lineSettings: { L1: { plant: 'P' }, L2: { plant: 'P' } } });
  const plantAlerts = alerts.filter(a => a.type === 'plant_no_timezone');
  assert.equal(plantAlerts.length, 1);
  assert.equal(plantAlerts[0].id, 'plant-no-timezone-P');
  assert.equal(plantAlerts[0].line, 'L1', 'sits on the plant\'s first affected line');
  assert.equal(plantAlerts[0].sev, 'err');
  assert.deepEqual(plantAlerts[0].msgVars, { plant: 'P' });
  // D14/VM13: line_no_calendar is retired; it is no longer emitted, one per line or otherwise.
  assert.equal(alerts.filter(a => a.type === 'line_no_calendar').length, 0, 'line_no_calendar is no longer emitted');
});

test('computeAlerts never mutates now[plant]; derivation alerts carry the real now as their time (U15)', () => {
  const nowP = D(14, 15, 42);
  const before = +nowP;
  const masterData = { lines: [{ machine: 'L1', plant: 'P' }], plants: [{ plant: 'P' }] };
  const alerts = issueAlerts([issueTask('n1', { code: 'plant_no_timezone' }, { MACHINE: 'L1' })], {
    masterData, calendars: {}, lineSettings: { L1: { plant: 'P' } }, now: { P: nowP },
  });
  assert.equal(+nowP, before, 'the now Date passed in is left alone');
  const alert = alerts.find(x => x.type === 'plant_no_timezone');   // repaired: line_no_calendar is retired (D14); same time rule on the plant alert
  assert.ok(alert, 'plant_no_timezone alert present');
  assert.equal(+alert.time, before, 'alert time is the real now, not 00:00');
});

test('a plant the clock refused (blockedPlants) alerts even when no order carries a note; a scoped run stays on its own line', () => {
  const masterData = { lines: [{ machine: 'L1', plant: 'P' }, { machine: 'L2', plant: 'P' }], plants: [{ plant: 'P' }] };
  const payload = { masterData, blockedPlants: ['P'], calendars: {}, lineSettings: {} };
  const full = Core.computeAlerts(alertBase([], payload)).alerts.filter(a => a.type === 'plant_no_timezone');
  assert.equal(full.length, 1);
  assert.equal(full[0].line, 'L1');
  const scopedOther = Core.computeAlerts(alertBase([], { ...payload, opts: { lines: ['L2'] } })).alerts.filter(a => a.type === 'plant_no_timezone');
  assert.equal(scopedOther.length, 0, 'an incremental run for L2 does not duplicate the L1-anchored alert');
  const scopedOwn = Core.computeAlerts(alertBase([], { ...payload, opts: { lines: ['L1'] } })).alerts.filter(a => a.type === 'plant_no_timezone');
  assert.equal(scopedOwn.length, 1);
});

test('an unknown derivationIssue code still renders a generic alert (never silently dropped)', () => {
  const alerts = issueAlerts([issueTask('u', { code: 'brand_new_code' })]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'derivation_issue');
  assert.equal(alerts[0].msgKey, 'alert.derivation_issue');
  assert.equal(alerts[0].msgVars.code, 'brand_new_code');
  assert.equal(alerts[0].sev, 'warn');
});

test('placement_exception markers render as warnings (D20); a normal row or a cleared marker does not', () => {
  const tasks = [
    issueTask('o', null, { placement_exception: 'overtime' }),
    issueTask('l', null, { placement_exception: 'overlong' }),
    issueTask('n', null, { placement_exception: null }),
  ];
  const alerts = issueAlerts(tasks).filter(a => a.type === 'placement_exception');
  assert.deepEqual(alerts.map(a => [a.taskId, a.msgKey, a.sev]).sort(), [
    ['l', 'alert.placement_exception_overlong', 'warn'], ['o', 'alert.placement_exception_overtime', 'warn'],
  ]);
});

test('the runtime/schedule mismatch alert is reworded through alert.start_may_be_stale', () => {
  const alert = Core.computeAlerts(alertBase([issueTask('s', null, { runtime_schedule_mismatch: true })])).alerts
    .find(a => a.type === 'runtime-schedule-mismatch');
  assert.equal(alert.msgKey, 'alert.start_may_be_stale');
  assert.deepEqual(alert.msgVars, { order: 'ORD-s' });
  assert.match(alert.msg, /may be out of date/);
});

test('engine findings respect the incremental line scope and the dismissed set', () => {
  const tasks = [issueTask('a', { code: 'run_time_zero' }, { MACHINE: 'L' }), issueTask('b', { code: 'run_time_zero' }, { MACHINE: 'L2' })];
  const masterData = { lines: [{ machine: 'L', plant: 'P' }, { machine: 'L2', plant: 'P' }], plants: [{ plant: 'P' }] };
  const base = { masterData, calendars: { L: open0818, L2: open0818 }, lineSettings: { L: { plant: 'P' }, L2: { plant: 'P' } } };
  const scoped = issueAlerts(tasks, { ...base, opts: { lines: ['L2'] } });
  assert.deepEqual(scoped.map(a => a.id), ['derivation-b-run_time_zero']);
  const dismissed = issueAlerts(tasks, { ...base, dismissed: ['derivation-a-run_time_zero'] });
  assert.deepEqual(dismissed.map(a => a.id), ['derivation-b-run_time_zero']);
});

test('the alert horizon reads the payload per-plant clock: an order that ended before the plant\'s today is ignored', () => {
  const yesterday = dueFri({ id: 'y', start_date: D(13, 9), end_date: D(13, 13), original_end_date: D(13, 0) });
  const stale = Core.computeAlerts(alertBase([yesterday, { ...yesterday, id: 'y2', end_date: D(13, 20), original_end_date: D(13, 12) }])).alerts;
  assert.equal(stale.filter(a => a.type === 'late').length, 0, 'finished before today on the plant clock: past the horizon');
});

test('U16: the plant-zone conversion pair the forward and backward legs share keeps Chicago spring-forward elapsed time exact', () => {
  const tz = 'America/Chicago';
  // Sun 8 Mar 2026: wall 00:00 -> 06:00 is 5 elapsed hours (02:00-03:00 does not exist).
  const a = Core.plantInstantFromWallClock(tz, new Date(2026, 2, 8, 0, 0));
  const b = Core.plantInstantFromWallClock(tz, new Date(2026, 2, 8, 6, 0));
  assert.equal((b - a) / 3600000, 5);
  // And 5 h after 00:00 reads back as wall 06:00 (what the forward allocator returns for a 5 h bar).
  const back = Core.plantWallClockFromInstant(tz, new Date(+a + 5 * 3600000));
  assert.deepEqual([back.getHours(), back.getMinutes(), back.getDate()], [6, 0, 8]);
});

test('D20: an approved placement exception is a warning, not an error', () => {
  const alerts = issueAlerts([issueTask('pe', null, { placement_exception: 'overtime' })]).filter(a => a.type === 'placement_exception');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].sev, 'warn');
});

test('VM13: line_no_calendar is no longer emitted for a line without a calendar row', () => {
  const alerts = issueAlerts([issueTask('lc', { code: 'line_no_calendar' }, { MACHINE: 'L1' })], {
    masterData: { lines: [{ machine: 'L1', plant: 'P' }], plants: [{ plant: 'P' }] }, calendars: {}, lineSettings: { L1: { plant: 'P' } },
  });
  assert.equal(alerts.filter(a => a.type === 'line_no_calendar').length, 0);
});

test('VM12: a finish-only row contributes its hours to computeUtilization', () => {
  const task = { id: 'fo', MACHINE: 'L', PLANT: 'P', RUN_TIME: 4, start_date: null, end_date: D(15, 12) };
  const { matrix } = Core.computeUtilization({
    tasks: [task], lineSettings: { L: { plant: 'P' } }, calendars: { L: open0818 }, plants: {}, blocks: [], plantBlocks: [],
    masterData: { lines: [{ machine: 'L', plant: 'P' }], plants: [{ plant: 'P' }] }, startMs: +D(15, 0), days: 1, lines: ['L'],
  });
  const row = Object.values(matrix.L)[0];
  assert.equal(row.scheduled * 60, 240);
});

// ---- Effective-dated plant calendar periods ----------------------------------------------------------------------
const periodVectors = require('../fixtures/plant_period_vectors.json');
const toPeriod = (p) => ({ id: p.id, name: p.name || p.id, validFrom: p.valid_from, validTo: p.valid_to, workHours: { ...p.work_hours } });

for (const v of periodVectors.active) {
  test(`activeWorkHours vector: ${v.name}`, () => {
    const periods = v.periods.map(toPeriod);
    const def = { ...v.default };
    const got = Core.activeWorkHours(def, periods, v.day);
    if (v.expected === 'default') assert.equal(got, def);
    else assert.equal(got, periods.find(p => p.id === v.expected).workHours);
  });
}

for (const v of periodVectors.validate) {
  test(`validatePlantPeriods vector: ${v.name}`, () => {
    const r = Core.validatePlantPeriods(v.periods.map(toPeriod));
    if (v.expected === 'ok') assert.deepEqual(r, { ok: true });
    else {
      assert.equal(r.ok, false);
      assert.equal(r.code, v.expected);
      assert.deepEqual([...r.ids].sort(), [...v.ids].sort());
    }
  });
}

test('activeWorkHours: undefined/empty periods return the default by identity', () => {
  const def = allDays([8, 16]);
  assert.equal(Core.activeWorkHours(def, undefined, '2026-10-21'), def);
  assert.equal(Core.activeWorkHours(def, [], '2026-10-21'), def);
});

test('activeWorkHours: a closed period day beats the default open day', () => {
  const def = allDays([8, 16]);
  const closed = allDays(null);
  const got = Core.activeWorkHours(def, [{ id: 'p', name: 'p', validFrom: '2026-10-01', validTo: null, workHours: closed }], '2026-10-05');
  assert.equal(got, closed);
});

test('activeWorkHours: overlapping periods tie-break to the earliest validFrom', () => {
  const a = allDays([6, 14]), b = allDays([7, 15]);
  const got = Core.activeWorkHours(allDays([8, 16]), [
    { id: 'b', name: 'b', validFrom: '2026-10-10', validTo: null, workHours: b },
    { id: 'a', name: 'a', validFrom: '2026-10-01', validTo: null, workHours: a },
  ], '2026-10-12');
  assert.equal(got, a);
});

test('plantWorkHoursOn reads the local calendar date', () => {
  const def = allDays([8, 16]), per = allDays([6, 14]);
  const entry = { workHours: def, periods: [{ id: 'p', name: 'p', validFrom: '2026-10-20', validTo: null, workHours: per }] };
  assert.equal(Core.plantWorkHoursOn(entry, new Date(2026, 9, 19, 23, 59)), def);
  assert.equal(Core.plantWorkHoursOn(entry, new Date(2026, 9, 20, 0, 0)), per);
  assert.equal(Core.plantWorkHoursOn({ workHours: def }, new Date(2026, 9, 20)), def);
  assert.equal(Core.plantWorkHoursOn(undefined, new Date(2026, 9, 20)), undefined);
});

test('periodBoundaryKeys lists each validFrom and the day after each validTo, within (from, to]', () => {
  const periods = [
    { id: 'a', name: 'a', validFrom: '2026-10-20', validTo: '2026-10-31', workHours: {} },
    { id: 'b', name: 'b', validFrom: '2026-12-01', validTo: '2026-12-31', workHours: {} },
    { id: 'c', name: 'c', validFrom: '2027-03-01', validTo: null, workHours: {} },
  ];
  assert.deepEqual(Core.periodBoundaryKeys(periods, '2026-10-01', '2027-12-31'),
    ['2026-10-20', '2026-11-01', '2026-12-01', '2027-01-01', '2027-03-01']);
  assert.deepEqual(Core.periodBoundaryKeys(periods, '2026-10-20', '2026-11-01'), ['2026-11-01']);  // from exclusive, to inclusive
  assert.deepEqual(Core.periodBoundaryKeys(undefined, '2026-01-01', '2026-12-31'), []);
  const leap = [{ id: 'l', name: 'l', validFrom: '2028-01-01', validTo: '2028-02-28', workHours: {} }];
  assert.deepEqual(Core.periodBoundaryKeys(leap, '2028-02-01', '2028-03-31'), ['2028-02-29']);
});

test('unionWeeklyHours: per weekday min start / max end; null only when every pattern is closed', () => {
  const def = { 0: null, 1: [8, 16], 2: null, 3: [8, 16], 4: null, 5: null, 6: null };
  const per = { 0: null, 1: [6, 12], 2: null, 3: null, 4: null, 5: null, 6: [8, 12] };
  const u = Core.unionWeeklyHours(def, [{ id: 'p', name: 'p', validFrom: '2026-10-01', validTo: null, workHours: per }]);
  assert.deepEqual(u[1], [6, 16]);
  assert.deepEqual(u[3], [8, 16]);
  assert.deepEqual(u[6], [8, 12]);
  assert.equal(u[0], null);
  assert.equal(u[2], null);
  assert.deepEqual(Core.unionWeeklyHours(def, undefined)[1], [8, 16]);
});

test('Core.workWindow returns different plant windows either side of a period boundary', () => {
  const plants = { P: { workHours: allDays([8, 16]), periods: [{ id: 'p', name: 'p', validFrom: '2026-10-20', validTo: null, workHours: allDays([6, 14]) }] } };
  const calendars = { L: { workHours: allDays([0, 24]) } };
  const ls = { L: { plant: 'P' } };
  const before = Core.workWindow('L', new Date(2026, 9, 19, 12), calendars, plants, ls, {});
  const after = Core.workWindow('L', new Date(2026, 9, 20, 12), calendars, plants, ls, {});
  assert.deepEqual([before[0].getHours(), before[1].getHours()], [8, 16]);
  assert.deepEqual([after[0].getHours(), after[1].getHours()], [6, 14]);
});

test('validatePlantPeriods: missing or duplicate id is period_invalid', () => {
  const p = { name: 'x', validFrom: '2026-10-01', validTo: null, workHours: {} };
  assert.equal(Core.validatePlantPeriods([{ ...p, id: '' }]).code, 'period_invalid');
  assert.equal(Core.validatePlantPeriods([{ ...p, id: 'a' }, { ...p, id: 'a', validFrom: '2027-01-01' }]).code, 'period_invalid');
});

test('Core.workWindow: a line with no calendar entry inherits the plant (all-day seed), or the default shift when its plant is unknown', () => {
  const plants = { P: { workHours: allDays([6, 17]) } };
  const calendars = {};
  const withPlant = Core.workWindow('L', new Date(2026, 9, 19, 12), calendars, plants, { L: { plant: 'P' } }, {});
  assert.equal(withPlant[0].getHours(), 6);
  assert.equal(withPlant[1].getHours(), 17);
  assert.equal(calendars.L.inherited, true, 'the seeded entry is flagged inherited');
  assert.deepEqual(calendars.L.workHours[1], [0, 24]);
  const orphanCals = {};
  const orphan = Core.workWindow('O', new Date(2026, 9, 19, 12), orphanCals, {}, {}, { lines: [] });
  assert.equal(orphan[0].getHours(), 7, 'no plant resolves: nothing would bound an all-day seed, so DEFAULT_SHIFT is used');
  assert.equal(orphan[1].getHours(), 19);
  assert.equal(orphanCals.O.inherited, true);
});

test('Core.workWindow: an inherited all-day line is bounded exactly by the plant (including a dated period)', () => {
  const calendars = { L: { workHours: allDays([0, 24]), inherited: true } };
  const plants = { P: { workHours: allDays([7, 19]), periods: [{ id: 'x', name: 'x', validFrom: '2026-10-20', validTo: null, workHours: allDays([5, 22]) }] } };
  const ls = { L: { plant: 'P' } };
  const before = Core.workWindow('L', new Date(2026, 9, 19, 12), calendars, plants, ls, {});
  const after = Core.workWindow('L', new Date(2026, 9, 20, 12), calendars, plants, ls, {});
  assert.deepEqual([before[0].getHours(), before[1].getHours()], [7, 19]);
  assert.deepEqual([after[0].getHours(), after[1].getHours()], [5, 22]);
});
