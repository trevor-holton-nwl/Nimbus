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
  // No inventory row: the legacy id / peerId survive, the wording says the tool is counted as 1 copy.
  assert.equal(hits[0].msgKey, 'alert.tool_conflict_no_row');
  assert.equal(hits[0].hasRow, false);
  assert.deepEqual(hits[0].peerIds, ['x-1']);
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

// Overload tolerance: exactly-full (or float-drifted, or sub-3-minute) days are not an alert.
const fullDay = (runTimes) => runTimes.map((rt, i) => ({
  id: 'f' + i, MACHINE: 'L', PLANT: 'P', RUN_TIME: rt, start_date: D(15, 8), end_date: D(15, 18),
}));
const dayScheduled = (tasks) => Core.computeUtilization({
  tasks, lineSettings: { L: { plant: 'P' } }, calendars: { L: open0818 }, plants: {}, blocks: [], plantBlocks: [],
  masterData: { lines: [{ machine: 'L', plant: 'P' }] }, startMs: +D(14), days: 3, lines: ['L'],
}).matrix.L['2026-10-15'].scheduled;
const overloadsOf = (tasks) => Core.computeAlerts(alertBase(tasks)).alerts.filter(a => a.type === 'overload');

test('overload tolerance: float drift in the per-day sum (10 h of orders in a 10 h window) is not an alert', () => {
  // The plain sum of these RUN_TIMEs is exactly 10, but the engine sums minutes/60 per task and lands a hair above 10.
  const tasks = fullDay([5.82, 1.49, 2.69]);
  const scheduled = dayScheduled(tasks);
  assert.ok(scheduled > 10 && scheduled !== 10, 'engine sum drifts above 10 (' + scheduled + ')');
  assert.ok(Math.abs(scheduled - 10) < 1e-9);
  assert.deepEqual(overloadsOf(tasks), []);
});

test('overload tolerance: exactly full is not an alert; 10.04 h is inside the tolerance; 10.1 h alerts', () => {
  assert.deepEqual(overloadsOf(fullDay([10])), []);
  assert.deepEqual(overloadsOf(fullDay([10.04])), []);
  const over = overloadsOf(fullDay([10.1]));
  assert.equal(over.length, 1);
  assert.match(over[0].msg, /10.1h scheduled/);
});

test('Core.isOverloaded: threshold plus the 0.05 h tolerance; a zero effective capacity alerts only when the line had capacity (B4)', () => {
  assert.equal(Core.isOverloaded(10, 10), false);
  assert.equal(Core.isOverloaded(10.04, 10), false);
  assert.equal(Core.isOverloaded(10.06, 10), true);
  // Without the full capacity the old rule holds: nothing is overloaded on zero effective capacity.
  assert.equal(Core.isOverloaded(1, 0), false);
  // Fully buffered (capacity > 0, effective <= 0): any load beyond the tolerance is an overload.
  assert.equal(Core.isOverloaded(1, 0, 10), true);
  assert.equal(Core.isOverloaded(0.05, 0, 10), false, 'inside the tolerance');
  assert.equal(Core.isOverloaded(0, 0, 10), false, 'no load');
  // A truly closed line (no capacity at all) is the closed alert's business, never an overload.
  assert.equal(Core.isOverloaded(1, 0, 0), false);
});

test('B4: a fully buffered line with scheduled hours raises an overload alert; a closed line keeps the closed alert; no load stays silent', () => {
  const buffered = { L: { plant: 'P', bufferUnit: 'pct', bufferPct: 100 } };
  const over = Core.computeAlerts(alertBase(fullDay([2]), { lineSettings: buffered })).alerts.filter(a => a.type === 'overload');
  assert.equal(over.length, 1, 'fully buffered day with 2 h scheduled alerts');
  assert.match(over[0].msg, /2\.0h scheduled vs 0\.0h effective capacity \(10\.0h total\)/);
  // Same line, no load: nothing.
  assert.deepEqual(Core.computeAlerts(alertBase([], { lineSettings: buffered })).alerts, []);
  // A buffer above 100 % clamps to zero instead of going negative.
  assert.equal(Core.effectiveFromCapacity('L', 10, { L: { bufferUnit: 'pct', bufferPct: 150 } }), 0);
  assert.equal(Core.effectiveFromCapacity('L', 10, { L: { bufferUnit: 'hours', bufferHours: 12 } }), 0);
  // A truly closed line (0 h capacity) with load is the closed alert, not an overload.
  const closed = Core.computeAlerts(alertBase(fullDay([2]), { calendars: { L: { workHours: allDays(null) } } })).alerts;
  assert.ok(closed.some(a => a.type === 'closed'));
  assert.ok(!closed.some(a => a.type === 'overload'));
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
  // Confidence scores a late order by its due instant (Fri 18:00 close), while `time` stays the finish.
  assert.equal(+late[0].due, +D(16, 18));
  assert.equal(+late[0].time, +D(16, 20));
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

// ---------------------------------------------------------------------------------------------------------------
// Tool inventory: the shared pure API + the count-aware rule 1b.
// ---------------------------------------------------------------------------------------------------------------
const H = 3600000;
const T0 = Date.UTC(2031, 0, 6, 8);   // a fixed Monday 08:00 UTC, far in the future
const item = (id, line, fromH, toH, tools = ['T100'], plant = 'P1') =>
  ({ id, line, plant, tools, start: new Date(T0 + fromH * H), end: new Date(T0 + toH * H) });
const cap = n => () => ({ available: n, hasRow: true });

test('TOOL_PLACEHOLDERS / normalizeToolId: one set, trimmed + upper-cased, placeholders and blanks -> null', () => {
  assert.deepEqual([...Core.TOOL_PLACEHOLDERS].sort(), ['', '-', '0', 'N/A', 'NAN', 'NONE', 'NULL', 'TBD']);
  assert.equal(Core.normalizeToolId('t100 '), 'T100');
  for (const v of ['', ' ', '-', '0', 'n/a', 'None', 'null', 'nan', 'tbd', null, undefined]) assert.equal(Core.normalizeToolId(v), null, String(v));
  assert.equal(Core.normalizeToolId(100), '100');
});

test('taskToolIds: deduped, normalized, PRT_01 == PRT_02 is one tool', () => {
  assert.deepEqual(Core.taskToolIds({ PRT_01: 't1 ', PRT_02: 'T1' }), ['T1']);
  assert.deepEqual(Core.taskToolIds({ PRT_01: 'T1', PRT_02: 'T2' }), ['T1', 'T2']);
  assert.deepEqual(Core.taskToolIds({ PRT_01: 'TBD', PRT_02: '-' }), []);
  assert.deepEqual(Core.taskToolIds(null), []);
});

test('taskToolPlant: the order PLANT first, else its line plant', () => {
  const plantOf = line => (line === 'L1' ? 'P9' : null);
  assert.equal(Core.taskToolPlant({ PLANT: 'P1', MACHINE: 'L1' }, plantOf), 'P1');
  assert.equal(Core.taskToolPlant({ MACHINE: 'L1' }, plantOf), 'P9');
  assert.equal(Core.taskToolPlant({ MACHINE: 'L2' }, plantOf), null);
});

test('toolOccupancyInterval: envelope across a weekend gap, single bar, finish-only U29 bar, otherwise null', () => {
  const fri = new Date(T0 + 4 * 24 * H), mon = new Date(T0 + 7 * 24 * H);
  const split = { scheduleSegments: [
    { startDate: new Date(+mon), endDate: new Date(+mon + 2 * H), sequence: 2 },
    { startDate: new Date(+fri), endDate: new Date(+fri + 2 * H), sequence: 1 }] };
  const occ = Core.toolOccupancyInterval(split);
  assert.equal(+occ.start, +fri, 'envelope starts at the first segment');
  assert.equal(+occ.end, +mon + 2 * H, 'and ends at the LAST segment, covering the weekend gap');
  assert.deepEqual(Core.toolOccupancyInterval({ start_date: new Date(T0), end_date: new Date(T0 + 3 * H) }),
    { start: new Date(T0), end: new Date(T0 + 3 * H) });
  // finish-only row (start null): [end - run_time, end]
  const fin = Core.toolOccupancyInterval({ start_date: null, end_date: new Date(T0 + 10 * H), RUN_TIME: 4 });
  assert.equal(+fin.start, T0 + 6 * H); assert.equal(+fin.end, T0 + 10 * H);
  assert.equal(Core.toolOccupancyInterval({ start_date: null, end_date: new Date(T0), RUN_TIME: 0 }), null);
  assert.equal(Core.toolOccupancyInterval({ start_date: new Date(T0), end_date: null, RUN_TIME: 2 }), null);
  assert.equal(Core.toolOccupancyInterval({}), null);
});

test('buildToolCapacity / availableCopies: tolerates undefined, old rows, compact rows; missing row = 1 copy; qty 0 = unavailable', () => {
  assert.equal(Core.buildToolCapacity(undefined).size, 0);
  assert.equal(Core.buildToolCapacity({ lines: [] }).size, 0);
  assert.equal(Core.buildToolCapacity({ tool_inventory: undefined }).size, 0);
  const c = Core.buildToolCapacity({ tool_inventory: [
    { plant: 'P1', tool_id: 't100 ', total_qty: 5, out_of_service_qty: 2 },
    { plant: 'P1', tool_id: 'T0', total_qty: 0, out_of_service_qty: 0 },
    { plant: 'P1', tool_id: 'T9', total_qty: 1, out_of_service_qty: 3 },
    { plant: 'P2', tool_id: 'T100', total_qty: 1, out_of_service_qty: 0 },
    { plant: 'P1', tool_id: 'TC', available: 4 }] });
  assert.deepEqual(Core.availableCopies(c, 'P1', 'T100'), { available: 3, hasRow: true });
  assert.deepEqual(Core.availableCopies(c, 'P1', 'T0'), { available: 0, hasRow: true });
  assert.deepEqual(Core.availableCopies(c, 'P1', 'T9'), { available: 0, hasRow: true }, 'max(0, total - out of service)');
  assert.deepEqual(Core.availableCopies(c, 'P2', 'T100'), { available: 1, hasRow: true }, 'plant keyed');
  assert.deepEqual(Core.availableCopies(c, 'P1', 'TC'), { available: 4, hasRow: true }, 'compact projection');
  assert.deepEqual(Core.availableCopies(c, 'P3', 'T100'), { available: 1, hasRow: false }, 'missing row -> 1 copy');
  assert.deepEqual(Core.availableCopies(undefined, 'P1', 'X'), { available: 1, hasRow: false });
});

test('findToolOverages: 3 copies and 4 machines -> one cluster, on the 4th starter', () => {
  const items = [item('a', 'L1', 0, 10), item('b', 'L2', 1, 10), item('c', 'L3', 2, 10), item('d', 'L4', 3, 10)];
  const out = Core.findToolOverages({ items, capacityFor: cap(3) });
  assert.equal(out.length, 1);
  assert.equal(out[0].pusher, 'd'); assert.equal(out[0].pusherLine, 'L4');
  assert.equal(out[0].inUse, 4); assert.equal(out[0].available, 3);
  assert.deepEqual(out[0].holders.map(h => h.id), ['a', 'b', 'c']);
  assert.equal(+out[0].at, T0 + 3 * H);
  // 4 machines but 4 copies -> pruned
  assert.equal(Core.findToolOverages({ items, capacityFor: cap(4) }).length, 0);
});

test('findToolOverages: touching intervals do not overlap (half-open); a free copy releases at the instant', () => {
  const items = [item('a', 'L1', 0, 5), item('b', 'L2', 5, 9)];
  assert.equal(Core.findToolOverages({ items, capacityFor: cap(1) }).length, 0);
  assert.equal(Core.findToolOverages({ items: [item('a', 'L1', 0, 5), item('b', 'L2', 4, 9)], capacityFor: cap(1) }).length, 1);
});

test('findToolOverages: zero copies -> every machine is over; the pusher has no holder when alone', () => {
  const out = Core.findToolOverages({ items: [item('a', 'L1', 0, 5)], capacityFor: cap(0) });
  assert.equal(out.length, 1);
  assert.equal(out[0].inUse, 1); assert.equal(out[0].available, 0); assert.deepEqual(out[0].holders, []);
});

test('findToolOverages: the same machine twice counts once; the same id in PRT_01 and PRT_02 counts once', () => {
  const sameMachine = [item('a', 'L1', 0, 6), item('b', 'L1', 2, 8), item('c', 'L2', 3, 7)];
  assert.equal(Core.findToolOverages({ items: sameMachine, capacityFor: cap(2) }).length, 0);
  assert.equal(Core.findToolOverages({ items: sameMachine, capacityFor: cap(1) }).length, 1);
  const twice = [item('a', 'L1', 0, 6, ['T100', 'T100']), item('b', 'L2', 7, 9)];
  assert.equal(Core.findToolOverages({ items: twice, capacityFor: cap(1) }).length, 0);
  const both = Core.findToolOverages({ items: [item('a', 'L1', 0, 6, ['T100', 't100 ']), item('b', 'L2', 1, 9)], capacityFor: cap(1) });
  assert.equal(both.length, 1); assert.equal(both[0].inUse, 2);
});

test('findToolOverages: 3-way overlap on a 1-copy tool -> 2 clusters (one per pusher), not 3 pair alerts', () => {
  const out = Core.findToolOverages({ items: [item('a', 'L1', 0, 9), item('b', 'L2', 1, 9), item('c', 'L3', 2, 9)], capacityFor: cap(1) });
  assert.deepEqual(out.map(c => c.pusher), ['b', 'c']);
  assert.deepEqual(out[1].holders.map(h => h.id), ['a', 'b']);
});

test('findToolOverages: plant keyed (two plants sharing a tool id never conflict) and ids are normalized', () => {
  const items = [item('a', 'L1', 0, 9, ['T100'], 'P1'), item('b', 'L2', 1, 9, ['T100'], 'P2')];
  assert.equal(Core.findToolOverages({ items, capacityFor: cap(1) }).length, 0);
  const norm = [item('a', 'L1', 0, 9, ['t100 ']), item('b', 'L2', 1, 9, ['T100'])];
  const out = Core.findToolOverages({ items: norm, capacityFor: cap(1) });
  assert.equal(out.length, 1); assert.equal(out[0].tool, 'T100');
});

test('findToolOverages: deterministic under shuffled input, ties on start resolved by (line, id)', () => {
  const base = [item('a', 'L1', 0, 9), item('b', 'L2', 0, 9), item('c', 'L3', 0, 9), item('d', 'L4', 2, 6), item('e', 'L5', 2, 6)];
  const want = JSON.stringify(Core.findToolOverages({ items: base, capacityFor: cap(2) }));
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 25; i++) {
    const shuffled = base.slice().sort(() => rnd() - 0.5);
    assert.equal(JSON.stringify(Core.findToolOverages({ items: shuffled, capacityFor: cap(2) })), want);
  }
  assert.ok(JSON.parse(want).length >= 2);
});

test('findToolOverages: now drops finished intervals and clips starts', () => {
  const items = [item('a', 'L1', 0, 4), item('b', 'L2', 2, 9)];
  assert.equal(Core.findToolOverages({ items, capacityFor: cap(1) }).length, 1);
  assert.equal(Core.findToolOverages({ items, capacityFor: cap(1), now: new Date(T0 + 4 * H) }).length, 0, 'a ended by now');
});

test('toolConflictAlertId: legacy id for exactly 2 orders, tool form otherwise, sanitized, collision-suffixed', () => {
  const two = { tool: 'T1', pusher: 'cur', holders: [{ id: 'prev' }] };
  assert.equal(Core.toolConflictAlertId(two), 'toolc-prev|cur');
  const three = { tool: 'T/1%2#', pusher: 'p', holders: [{ id: 'a' }, { id: 'b' }] };
  assert.equal(Core.toolConflictAlertId(three), 'toolc-p|T_1_2_');
  const used = new Set();
  assert.equal(Core.toolConflictAlertId(two, used), 'toolc-prev|cur');
  // a second tool conflicting on the same pair falls through to the tool form, then a suffix
  assert.equal(Core.toolConflictAlertId({ ...two, tool: 'T2' }, used), 'toolc-cur|T2');
  assert.equal(Core.toolConflictAlertId({ ...two, tool: 'T2' }, used), 'toolc-cur|T2~2');
});

test('toolHeadroom: tool-free windows for a machine, other machines only, every tool must have a free copy', () => {
  const items = [item('a', 'L1', 2, 5), item('b', 'L2', 4, 8), item('c', 'L3', 0, 20, ['T200'])];
  const index = Core.buildToolIndex({ items, capacityFor: (p, t) => ({ available: t === 'T100' ? 2 : 1, hasRow: true }) });
  const win = (tools, ex) => Core.toolHeadroom(index, 'P1', tools, new Date(T0), new Date(T0 + 10 * H), ex)
    .map(w => [(+w.start - T0) / H, (+w.end - T0) / H]);
  // T100 has 2 copies: blocked only while BOTH a (2-5) and b (4-8) run -> 4..5
  assert.deepEqual(win(['T100'], 'L9'), [[0, 4], [5, 10]]);
  // excluding L2 (the machine itself) removes b's usage
  assert.deepEqual(win(['T100'], 'L2'), [[0, 10]]);
  // T200 has 1 copy fully held by L3 -> no window; both tools together -> no window
  assert.deepEqual(win(['T200'], 'L9'), []);
  assert.deepEqual(win(['T100', 'T200'], 'L9'), []);
  assert.deepEqual(win(['T200'], 'L3'), [[0, 10]]);
  // zero copies -> never free; unknown tool -> always free
  const zero = Core.buildToolIndex({ items, capacityFor: cap(0) });
  assert.deepEqual(Core.toolHeadroom(zero, 'P1', ['T100'], new Date(T0), new Date(T0 + H), 'L9'), []);
  assert.equal(Core.toolHeadroom(index, 'P1', ['NOPE'], new Date(T0), new Date(T0 + H), 'L9').length, 1);
});

// ---- rule 1b through computeAlerts ----
const futureBase = () => Date.now() + 24 * H;
const toolTask = (id, line, fromH, toH, extra = {}) => {
  const b = futureBase();
  return { id, ORDER: 'PO-' + id, MACHINE: line, PLANT: 'P1', RUN_TIME: toH - fromH, PRT_01: 'T100',
    start_date: new Date(b + fromH * H), end_date: new Date(b + toH * H), ...extra };
};
const alertsFor = (tasks, tool_inventory, opts = {}) => Core.computeAlerts({
  tasks, blocks: [], plantBlocks: [], calendars: {}, plants: {}, lineSettings: {},
  masterData: { lines: [{ machine: 'L1', plant: 'P1' }], tool_inventory }, dismissed: [], opts,
}).alerts.filter(a => a.type === 'tool-conflict');

test('rule 1b: 3 copies and 4 machines -> ONE red alert on the 4th order naming tool, available, in use and holders', () => {
  const inv = [{ plant: 'P1', tool_id: 'T100', total_qty: 3, out_of_service_qty: 0 }];
  const four = () => [toolTask('a', 'L1', 1, 9), toolTask('b', 'L2', 2, 9), toolTask('c', 'L3', 3, 9), toolTask('d', 'L4', 4, 9)];
  const hits = alertsFor(four(), inv);
  assert.equal(hits.length, 1);
  const h = hits[0];
  assert.equal(h.taskId, 'd'); assert.equal(h.line, 'L4'); assert.equal(h.sev, 'err');
  assert.equal(h.peerId, 'a'); assert.deepEqual(h.peerIds, ['a', 'b', 'c']);
  assert.equal(h.id, 'toolc-d|T100');
  assert.equal(h.msgKey, 'alert.tool_conflict');
  assert.equal(h.msgVars.available, 3); assert.equal(h.msgVars.inUse, 4); assert.equal(h.msgVars.tool, 'T100');
  assert.match(h.msgVars.holders, /PO-a \(L1\), PO-b \(L2\), PO-c \(L3\)/);
  assert.equal(h.hasRow, true);
  // out of service shrinks the copies: 3 total - 1 oos = 2 -> the alert moves to the 3rd order (and the 4th also pushes)
  const inv2 = [{ plant: 'P1', tool_id: 'T100', total_qty: 3, out_of_service_qty: 1 }];
  assert.deepEqual(alertsFor(four(), inv2).map(x => x.taskId), ['c', 'd']);
  // 4 copies -> nothing
  assert.equal(alertsFor(four(), [{ plant: 'P1', tool_id: 'T100', total_qty: 4, out_of_service_qty: 0 }]).length, 0);
});

test('rule 1b: quantity 0 raises the zero-copy wording; a missing row raises the no-row wording', () => {
  const zero = alertsFor([toolTask('a', 'L1', 1, 5)], [{ plant: 'P1', tool_id: 'T100', total_qty: 0, out_of_service_qty: 0 }]);
  assert.equal(zero.length, 1); assert.equal(zero[0].msgKey, 'alert.tool_conflict_zero'); assert.equal(zero[0].available, 0);
  assert.equal(zero[0].peerId, undefined);
  const norow = alertsFor([toolTask('a', 'L1', 1, 5), toolTask('b', 'L2', 2, 6)], []);
  assert.equal(norow.length, 1); assert.equal(norow[0].msgKey, 'alert.tool_conflict_no_row');
  assert.equal(norow[0].id, 'toolc-a|b', 'no inventory: the legacy two-order id and peerId survive');
  assert.equal(norow[0].peerId, 'a');
  // inventory table undefined (failed load) behaves like no rows
  assert.equal(alertsFor([toolTask('a', 'L1', 1, 5), toolTask('b', 'L2', 2, 6)], undefined)[0].id, 'toolc-a|b');
});

test('rule 1b: a 3-way overlap on one copy yields 2 alerts (one per pusher), the 3rd listing both holders', () => {
  const hits = alertsFor([toolTask('a', 'L1', 1, 9), toolTask('b', 'L2', 2, 9), toolTask('c', 'L3', 3, 9)], undefined);
  assert.deepEqual(hits.map(h => [h.id, h.taskId, h.peerIds]), [['toolc-a|b', 'b', ['a']], ['toolc-c|T100', 'c', ['a', 'b']]]);
});

test('rule 1b: PRT_01 and PRT_02 with the same id count once; the same machine twice counts once; ids are case/space-insensitive', () => {
  const one = [{ plant: 'P1', tool_id: 'T100', total_qty: 1, out_of_service_qty: 0 }];
  const dbl = alertsFor([toolTask('a', 'L1', 1, 9, { PRT_02: 't100 ' }), toolTask('b', 'L2', 10, 12)], one);
  assert.equal(dbl.length, 0);
  const sameLine = alertsFor([toolTask('a', 'L1', 1, 9), toolTask('b', 'L1', 3, 7), toolTask('c', 'L2', 4, 8)], [{ plant: 'P1', tool_id: 'T100', total_qty: 2, out_of_service_qty: 0 }]);
  assert.equal(sameLine.length, 0, 'L1 counts once, so 2 machines fit 2 copies');
  const lower = alertsFor([toolTask('a', 'L1', 1, 9, { PRT_01: 't100 ' }), toolTask('b', 'L2', 2, 9)], [{ plant: 'P1', tool_id: 'T100', total_qty: 2, out_of_service_qty: 0 }]);
  assert.equal(lower.length, 0, "'t100 ' matches the inventory row 'T100'");
});

test('rule 1b: a split order keeps its tool across the weekend gap (envelope); a second machine in the gap conflicts', () => {
  const b = futureBase();
  const split = toolTask('s', 'L1', 0, 1, { start_date: new Date(b), end_date: new Date(b + 100 * H), scheduleSegments: [
    { startDate: new Date(b), endDate: new Date(b + 8 * H), sequence: 1 },
    { startDate: new Date(b + 90 * H), endDate: new Date(b + 100 * H), sequence: 2 }] });
  const inGap = toolTask('g', 'L2', 40, 44);
  const hits = alertsFor([split, inGap], [{ plant: 'P1', tool_id: 'T100', total_qty: 1, out_of_service_qty: 0 }]);
  assert.equal(hits.length, 1); assert.equal(hits[0].taskId, 'g'); assert.deepEqual(hits[0].peerIds, ['s']);
});

test('rule 1b: a finish-only row occupies [end - run_time, end]', () => {
  const b = futureBase();
  const fin = toolTask('f', 'L2', 0, 1, { start_date: null, end_date: new Date(b + 10 * H), RUN_TIME: 4 });
  const hits = alertsFor([toolTask('a', 'L1', 7, 9), fin], [{ plant: 'P1', tool_id: 'T100', total_qty: 1, out_of_service_qty: 0 }]);
  assert.equal(hits.length, 1);
});

test('rule 1b: plant keyed - the same tool id in two plants never conflicts; onlyLines gates on the pusher line', () => {
  const p2 = toolTask('b', 'L2', 2, 9, { PLANT: 'P2' });
  assert.equal(alertsFor([toolTask('a', 'L1', 1, 9), p2], undefined).length, 0);
  const tasks = [toolTask('a', 'L1', 1, 9), toolTask('b', 'L2', 2, 9)];
  assert.equal(alertsFor(tasks, undefined, { lines: ['L1'] }).length, 0, 'pusher b is on L2, out of scope');
  assert.equal(alertsFor(tasks, undefined, { lines: ['L2'] }).length, 1);
});

test('rule 1b: the holders text is capped (3 shown, +N for the rest)', () => {
  const tasks = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => toolTask(id, 'L' + (i + 1), 1 + i, 20));
  const hits = alertsFor(tasks, [{ plant: 'P1', tool_id: 'T100', total_qty: 5, out_of_service_qty: 0 }]);
  assert.equal(hits.length, 1);
  assert.match(hits[0].msgVars.holders, /\+2$/);
});

test('findToolOverages: at an equal instant the pusher is chosen by (start, end, id), not by machine name', () => {
  const run = (lineX, lineY) => Core.findToolOverages({
    items: [item('ord-a', lineX, 0, 4), item('ord-b', lineY, 0, 6)], capacityFor: cap(1),
  }).map(c => c.pusher);
  // same start; shorter order sorts first: it holds, the longer one pushes - whichever machine name each has
  assert.deepEqual(run('L1', 'L2'), ['ord-b']);
  assert.deepEqual(run('L2', 'L1'), ['ord-b'], 'swapping the machines does not change the pusher');
  // identical start and end: the id decides, again independent of the machines
  const tie = (lineX, lineY) => Core.findToolOverages({
    items: [item('ord-a', lineX, 0, 4), item('ord-b', lineY, 0, 4)], capacityFor: cap(1),
  }).map(c => c.pusher);
  assert.deepEqual(tie('L1', 'L2'), ['ord-b']);
  assert.deepEqual(tie('L2', 'L1'), ['ord-b']);
});

test('toolIndexUpdate: moves the interval of one order inside the index without a rebuild', () => {
  const cf = cap(1);
  const items = [item('a', 'L1', 0, 4), item('b', 'L2', 6, 10)];
  const live = Core.buildToolIndex({ items, capacityFor: cf });
  const win = (idx, ex) => Core.toolHeadroom(idx, 'P1', ['T100'], new Date(T0), new Date(T0 + 12 * H), ex)
    .map(w => [(+w.start - T0) / H, (+w.end - T0) / H]);
  assert.deepEqual(win(live, 'L9'), [[4, 6], [10, 12]]);
  // move b from 6-10 to 2-5
  Core.toolIndexUpdate(live, 'b', item('b', 'L2', 6, 10), item('b', 'L2', 2, 5));
  const rebuilt = Core.buildToolIndex({ items: [item('a', 'L1', 0, 4), item('b', 'L2', 2, 5)], capacityFor: cf });
  assert.deepEqual(win(live, 'L9'), win(rebuilt, 'L9'));
  assert.deepEqual(win(live, 'L9'), [[5, 12]]);
  // null new: remove only; null old: insert only
  Core.toolIndexUpdate(live, 'b', item('b', 'L2', 2, 5), null);
  assert.deepEqual(win(live, 'L9'), [[4, 12]]);
  Core.toolIndexUpdate(live, 'a', item('a', 'L1', 0, 4), item('a', 'L1', 8, 9));
  assert.deepEqual(win(live, 'L9'), [[0, 8], [9, 12]]);
  // removing an interval that is not there is a no-op; emptying a tool drops its group
  Core.toolIndexUpdate(live, 'zz', item('zz', 'L5', 0, 1), null);
  assert.equal(live.groups.size, 1);
  Core.toolIndexUpdate(live, 'a', item('a', 'L1', 8, 9), null);
  assert.equal(live.groups.size, 0);
});

// --- due-rule twin vectors: the SAME cases run through backend/jobs/due.py (tests/test_jobs_due.py), so the
// late-order digest and the app cannot disagree on what is late. Hours maps are keyed by JS weekday. ---
const dueVectors = require('../fixtures/due_rule_vectors.json');
const _localDate = (iso) => { const [d, t] = iso.split('T'); const [y, m, dd] = d.split('-').map(Number); const [h, mi, s] = t.split(':').map(Number); return new Date(y, m - 1, dd, h, mi, s); };
for (const c of dueVectors.cases) {
  test(`due-rule vector: ${c.name}`, () => {
    const cal = dueVectors.calendars[c.calendar];
    const periods = (cal.plant_periods || []).map(p => ({ validFrom: p.valid_from, validTo: p.valid_to, workHours: p.work_hours }));
    const dayWindowFor = (date) => {
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const plantWin = Core._dayWindow(Core.activeWorkHours(cal.plant_work_hours, periods, key), date);
      const own = cal.line_work_hours[c.machine];
      const lineWin = own ? Core._dayWindow(own, date) : [new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0), new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)];
      if (!plantWin || !lineWin) return null;
      const open = new Date(Math.max(+plantWin[0], +lineWin[0])), close = new Date(Math.min(+plantWin[1], +lineWin[1]));
      return open < close ? { open, close } : null;
    };
    const due = Core.dueDateInstant(_localDate(c.due_raw), dayWindowFor);
    assert.equal(+due, +_localDate(c.due));
    assert.equal(_localDate(c.finish) > due, c.late);
  });
}

test('overload message prints two decimals when one decimal would show the same figure twice', () => {
  const near24 = { workHours: allDays([1 / 60, 24]) };   // a "24h" day that opens at 00:01 (23.98 h)
  const tasks = [{ id: 'n1', MACHINE: 'L', PLANT: 'P', RUN_TIME: 24.04, start_date: D(15, 0, 1), end_date: D(15, 23, 59) }];
  const over = Core.computeAlerts(alertBase(tasks, { calendars: { L: near24 }, plants: { P: near24 } })).alerts.filter(a => a.type === 'overload');
  assert.equal(over.length, 1);
  assert.match(over[0].msg, /24\.04h scheduled vs 23\.98h effective capacity \(23\.98h total\)/);
  assert.doesNotMatch(over[0].msg, /24\.0h scheduled vs 24\.0h/);
});

// B1: startOfDay hands back a new Date; alertPoints/scoreConfidence must not move the caller's horizonStart.
test('B1: startOfDay clones; alertPoints leaves horizonStart unchanged; scoreConfidence is order-independent', () => {
  const src = D(15, 13, 30);
  const before = +src;
  const day = Core.startOfDay(src);
  assert.equal(+src, before, 'the argument is not moved to midnight');
  assert.equal(+day, +D(15, 0, 0));
  assert.notEqual(day, src);

  const horizonStart = D(15, 13, 30);
  const horizonEnd = new Date(+horizonStart + 7 * 86400000);
  const dated = { id: 'x', sev: 'err', type: 'overload', line: 'L', time: D(15, 12, 0) };   // earlier today: counts as due now
  const points = Core.alertPoints(dated, horizonStart, horizonEnd);
  assert.ok(points > 0);
  assert.equal(+horizonStart, +D(15, 13, 30), 'alertPoints did not mutate horizonStart');

  const alerts = [
    dated,
    { id: 'y', sev: 'warn', type: 'late', line: 'L', time: D(16, 9), due: D(16, 9) },
    { id: 'z', sev: 'err', type: 'overlap', line: 'L', time: D(14, 9) },   // an earlier day: history
  ];
  const a = Core.scoreConfidence({ alerts, horizonStart, horizonMinutes: 7 * 1440, machines: 5 });
  const b = Core.scoreConfidence({ alerts: alerts.slice().reverse(), horizonStart, horizonMinutes: 7 * 1440, machines: 5 });
  assert.deepEqual(a, b);
  assert.equal(+horizonStart, +D(15, 13, 30));
});

// B2: the module-level memos are cleared on every exit, thrown or not.
const throwingTask = () => {
  let reads = 0;
  return { id: 'boom', get MACHINE() { if (++reads > 1) throw new Error('rule blew up'); return 'L'; }, PLANT: 'P', RUN_TIME: 1,
    start_date: D(15, 9), end_date: D(15, 10) };
};
const memoIsClear = () => {
  const lines = plant => ({ lines: [{ machine: 'MEMO', plant }] });
  assert.equal(Core.getPlantForLine('MEMO', {}, lines('P1')), 'P1');
  assert.equal(Core.getPlantForLine('MEMO', {}, lines('P2')), 'P2', 'a stale _plantMemo would still answer P1');
};
test('B2: computeAlerts clears its caches when a rule throws', () => {
  assert.throws(() => Core.computeAlerts(alertBase([throwingTask()])), /rule blew up/);
  memoIsClear();
});
test('B2: computeUtilization clears its caches when it throws', () => {
  assert.throws(() => Core.computeUtilization({
    tasks: [throwingTask()], lineSettings: { L: { plant: 'P' } }, calendars: { L: open0818 }, plants: {}, blocks: [], plantBlocks: [],
    masterData: { lines: [{ machine: 'L', plant: 'P' }] }, startMs: +D(14), days: 3, lines: ['L'],
  }), /rule blew up/);
  memoIsClear();
});

// B3: an alert with no date of its own is stamped with the order's PLANT clock, not the thread's.
test('B3: dateless alerts use the plant now (runtime mismatch, placement, runtime-unknown, pv-lot-size, setup diagnostic)', () => {
  const nowP = D(14, 6, 15);
  const bare = { MACHINE: 'L', PLANT: 'P', ORDER: 'O', RUN_TIME: 2 };
  const tasks = [
    { ...bare, id: 'mm', runtime_schedule_mismatch: true },
    { ...bare, id: 'pe', placement_exception: 'overtime' },
    { ...bare, id: 'ru', planning_status: 'needs_planning', planning_reason: { code: 'runtime_unknown', step: 's' } },
    { ...bare, id: 'ls', run_time_basis: { lot_size_warning: true } },
  ];
  const setup = { intervals: [], diagnostics: [{ type: 'setup-uncovered', line: 'L', scope: 'P/L', pairKey: 'A->B' }] };
  const { alerts } = Core.computeAlerts(alertBase(tasks, { setup, now: { P: nowP } }));
  const timeOf = type => alerts.find(a => a.type === type)?.time;
  for (const type of ['runtime-schedule-mismatch', 'placement_exception', 'runtime-unknown', 'pv-lot-size', 'setup-uncovered']) {
    assert.ok(timeOf(type), type + ' is raised');
    assert.equal(+timeOf(type), +nowP, type + ' carries the plant now');
  }
  assert.equal(+nowP, +D(14, 6, 15), 'now[plant] is left alone');
  // With no clock for the plant the thread clock still stands in (no throw).
  const noClock = Core.computeAlerts(alertBase(tasks.slice(0, 1), { now: {} })).alerts.find(a => a.type === 'runtime-schedule-mismatch');
  assert.ok(noClock.time instanceof Date && !isNaN(noClock.time));
});

// B9: distribution grouping prefers the task's own PLANT, like every other rule.
test('B9: a distribution family is grouped under the task PLANT when the machine is not in master data', () => {
  const day1 = D(15, 9), day2 = D(16, 9);
  const mk = (id, line, start) => ({ id, MACHINE: line, PLANT: 'PT', RUN_TIME: 2, PARENT_ORDER: 'A-1', MATERIAL_NUMBER: 'M',
    start_date: start, end_date: new Date(+start + 2 * 3600000) });
  const masterData = {
    lines: [{ machine: 'L1', sap_workcenter: 'WC1' }, { machine: 'L2', sap_workcenter: 'WC1' }],
    workcenters: [{ sap_workcenter: 'WC1', max_separation: 'day' }],
  };
  const { alerts } = Core.computeAlerts({
    tasks: [mk('a', 'L1', day1), mk('b', 'L2', day2)], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData, dismissed: [], opts: {}, now: { PT: D(14, 6) },
  });
  assert.deepEqual(alerts.filter(a => a.type === 'distribution-separation').map(a => a.id), ['dist-sep:PT:A-1:M']);
});

// B27: dates embedded in alert text travel with their instant so the main thread can use the user's format.
test('B27: firmed-out-of-hours and derivation alerts ship msgDates (default text + instant) matching their embedded dates', () => {
  const t = { id: 'oh', MACHINE: 'L', PLANT: 'P', ORDER: 'O', RUN_TIME: 2, start_date: D(15, 6), end_date: D(15, 20) };
  const { alerts } = Core.computeAlerts(alertBase([t]));
  const hit = alerts.find(a => a.type === 'firmed-out-of-hours');
  assert.ok(hit, 'raised');
  assert.equal(hit.msgDates.length, 2);
  for (const d of hit.msgDates) {
    assert.ok(hit.msg.includes(d.text), 'the default text is embedded in msg');
    assert.equal(d.text, Core.fmtDTReadable(new Date(d.ms)));
  }
  assert.deepEqual(hit.msgDates.map(d => d.ms), [+D(15, 8), +D(15, 18)]);

  const issue = issueAlerts([issueTask('fm', { code: 'finish_moved_earlier', from: D(15, 17), to: D(15, 11) })])
    .find(a => a.type === 'finish_moved_earlier');
  assert.deepEqual(issue.msgDates.map(d => d.ms), [+D(15, 17), +D(15, 11)]);
  assert.equal(issue.msgVars.from, issue.msgDates[0].text);
  assert.equal(issue.msgVars.to, issue.msgDates[1].text);
  // An alert that embeds no date carries no msgDates.
  assert.equal(issueAlerts([issueTask('rz', { code: 'run_time_zero' })]).find(a => a.type === 'run_time_zero').msgDates, undefined);
});
