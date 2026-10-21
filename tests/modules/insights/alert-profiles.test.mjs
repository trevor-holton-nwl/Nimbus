// Tests for frontend/insights/alert-profiles.mjs (pure alert-profile semantics: matching,
// ranking, grouping, validation, active-profile resolution). No Store/DOM: the module is
// imported bare; the compute-core is loaded via createRequire only in the tests that need
// the real scoring primitives (the module also carries literal fallbacks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  ALL_ALERTS_PROFILE_ID, ALL_ALERTS_PROFILE, ALERT_CATEGORIES, categoryOf, FIRING_ALERT_TYPES,
  anchorTime, alertDayOffset, ruleMatches, profileMatches, filterByProfile,
  impactPoints, compareAlerts, groupAlerts, validateProfile, resolveActiveProfileId,
} from '../../../frontend/insights/alert-profiles.mjs';

const require = createRequire(import.meta.url);

// Injected deps: the module never reaches for Util/Store, so tests control the due instant and lateness.
const deps = {
  dueInstant: (t) => t.due ?? t.original_end_date ?? null,
  latenessHours: (t) => t.late ?? 0,
};

const TODAY = new Date(2026, 9, 20);                       // plant-local start of day, Tue 2026-10-20
const at = (n, h = 0, mi = 0, s = 0, ms = 0) => new Date(2026, 9, 20 + n, h, mi, s, ms);
const rule = (o = {}) => ({ types: null, dayFrom: null, dayTo: null, minSev: null, minLateHours: null, ...o });
const alert = (o = {}) => ({ id: 'a1', sev: 'warn', type: 'overlap', line: 'L1', time: at(0, 9), ...o });

// ---- categories -----------------------------------------------------------------------------

test('ALERT_CATEGORIES keeps the four legacy groups and adds setup', () => {
  assert.deepEqual(Object.keys(ALERT_CATEGORIES).sort(), ['calendar', 'capacity', 'conflicts', 'exceptions', 'setup']);
  assert.deepEqual(ALERT_CATEGORIES.capacity, ['overload', 'near-capacity']);
  assert.deepEqual(ALERT_CATEGORIES.conflicts, ['overlap', 'tool-conflict', 'distribution-separation']);
  assert.ok(ALERT_CATEGORIES.calendar.includes('finish_moved_earlier'));
  assert.ok(ALERT_CATEGORIES.exceptions.includes('late'));
  assert.deepEqual(ALERT_CATEGORIES.setup, [
    'setup-violated', 'setup-uncovered', 'initial-state-unknown', 'current-state-diverged',
    'override-inactive', 'predecessor-state-unknown', 'successor-state-unknown',
  ]);
});

test('categoryOf maps every listed type and falls back to exceptions', () => {
  assert.equal(categoryOf('overload'), 'capacity');
  assert.equal(categoryOf('tool-conflict'), 'conflicts');
  assert.equal(categoryOf('blackout'), 'calendar');
  assert.equal(categoryOf('setup-uncovered'), 'setup');
  assert.equal(categoryOf('late'), 'exceptions');
  assert.equal(categoryOf('not-a-type'), 'exceptions');
});

test('every alert type is in exactly one category; FIRING excludes the two never-firing types', () => {
  const all = Object.values(ALERT_CATEGORIES).flat();
  assert.equal(new Set(all).size, all.length, 'no type in two categories');
  assert.ok(!FIRING_ALERT_TYPES.includes('near-capacity'));
  assert.ok(!FIRING_ALERT_TYPES.includes('line_no_calendar'));
  assert.equal(FIRING_ALERT_TYPES.length, all.length - 2);
});

// ---- anchor + day offset --------------------------------------------------------------------

test('anchorTime: due date beats alert time when the alert has a task with a due date', () => {
  const due = at(20, 23, 59);
  const a = alert({ taskId: 't1', time: at(0, 9) });
  assert.equal(anchorTime(a, { id: 't1', original_end_date: at(20), due }, deps).getTime(), due.getTime());
});

test('anchorTime: alert time when no taskId, no task, or the task has no due date', () => {
  const al = alert({ taskId: 't1' });
  const t = al.time;
  assert.equal(anchorTime(alert({ time: t }), undefined, deps), t);
  assert.equal(anchorTime(al, undefined, deps), t);
  assert.equal(anchorTime(al, { id: 't1', original_end_date: null }, deps), t);
  // a task with a due date but an unresolvable due instant also falls back to the alert time
  assert.equal(anchorTime(al, { id: 't1', original_end_date: at(5) }, { ...deps, dueInstant: () => null }), t);
  // a due date on the task is ignored when the alert has no taskId
  assert.equal(anchorTime(alert({ time: t }), { id: 't1', original_end_date: at(5), due: at(5) }, deps), t);
});

test('anchorTime: null when neither a due date nor an alert time exists', () => {
  assert.equal(anchorTime(alert({ time: undefined }), undefined, deps), null);
  assert.equal(anchorTime(alert({ time: new Date('x') }), undefined, deps), null);
});

test('alertDayOffset: calendar days from plantToday, DST-safe', () => {
  assert.equal(alertDayOffset(at(0, 0), TODAY), 0);
  assert.equal(alertDayOffset(at(0, 23, 59, 59, 999), TODAY), 0);
  assert.equal(alertDayOffset(at(1, 0), TODAY), 1);
  assert.equal(alertDayOffset(at(-1, 23, 59), TODAY), -1);
  // across the US spring-forward (2026-03-08) and fall-back (2026-11-01) boundaries
  const marchToday = new Date(2026, 2, 7);
  assert.equal(alertDayOffset(new Date(2026, 2, 9, 0, 0), marchToday), 2);
  assert.equal(alertDayOffset(new Date(2026, 2, 8, 23, 59, 59, 999), marchToday), 1);
  const octToday = new Date(2026, 9, 31);
  assert.equal(alertDayOffset(new Date(2026, 10, 2, 0, 0), octToday), 2);
  assert.equal(alertDayOffset(new Date(2026, 10, 1, 23, 59, 59, 999), octToday), 1);
});

// ---- ruleMatches ----------------------------------------------------------------------------

test('window is inclusive of day+N 00:00:00.000 and 23:59:59.999, exclusive of the next midnight', () => {
  const r = rule({ dayFrom: 2, dayTo: 4 });
  const m = (time) => ruleMatches(alert({ time }), undefined, r, TODAY, deps);
  assert.equal(m(at(2, 0, 0, 0, 0)), true, 'start of dayFrom');
  assert.equal(m(at(1, 23, 59, 59, 999)), false, 'just before dayFrom');
  assert.equal(m(at(4, 23, 59, 59, 999)), true, 'end of dayTo');
  assert.equal(m(at(5, 0, 0, 0, 0)), false, 'day dayTo+1 midnight');
});

test('null bounds are unbounded on that side', () => {
  const m = (r, n) => ruleMatches(alert({ time: at(n, 12) }), undefined, r, TODAY, deps);
  assert.equal(m(rule({ dayFrom: 3 }), 400), true);
  assert.equal(m(rule({ dayFrom: 3 }), 2), false);
  assert.equal(m(rule({ dayTo: 3 }), -400), true);
  assert.equal(m(rule({ dayTo: 3 }), 4), false);
  assert.equal(m(rule(), 12345), true);
});

test('negative bounds select overdue days', () => {
  const r = rule({ dayFrom: -3, dayTo: -1 });
  const m = (n, h = 12) => ruleMatches(alert({ time: at(n, h) }), undefined, r, TODAY, deps);
  assert.equal(m(-3, 0), true);
  assert.equal(m(-1, 23), true);
  assert.equal(m(0, 0), false);
  assert.equal(m(-4, 23), false);
});

test('minSev: err requires an error; warn accepts both', () => {
  const warn = alert({ sev: 'warn' }), err = alert({ sev: 'err' });
  assert.equal(ruleMatches(warn, undefined, rule({ minSev: 'err' }), TODAY, deps), false);
  assert.equal(ruleMatches(err, undefined, rule({ minSev: 'err' }), TODAY, deps), true);
  assert.equal(ruleMatches(warn, undefined, rule({ minSev: 'warn' }), TODAY, deps), true);
  assert.equal(ruleMatches(err, undefined, rule({ minSev: 'warn' }), TODAY, deps), true);
  assert.equal(ruleMatches(warn, undefined, rule({ minSev: null }), TODAY, deps), true);
});

test('types: null matches any; a list matches only its members', () => {
  assert.equal(ruleMatches(alert({ type: 'late' }), undefined, rule({ types: null }), TODAY, deps), true);
  assert.equal(ruleMatches(alert({ type: 'late' }), undefined, rule({ types: ['late', 'overlap'] }), TODAY, deps), true);
  assert.equal(ruleMatches(alert({ type: 'blackout' }), undefined, rule({ types: ['late', 'overlap'] }), TODAY, deps), false);
});

test('an alert with no anchor matches only when both bounds are null', () => {
  const noAnchor = alert({ time: undefined });
  assert.equal(ruleMatches(noAnchor, undefined, rule(), TODAY, deps), true);
  assert.equal(ruleMatches(noAnchor, undefined, rule({ dayFrom: 0 }), TODAY, deps), false);
  assert.equal(ruleMatches(noAnchor, undefined, rule({ dayTo: 5 }), TODAY, deps), false);
  assert.equal(ruleMatches(noAnchor, undefined, rule({ dayFrom: -5, dayTo: 5 }), TODAY, deps), false);
});

test('the window is evaluated on the due date, not the alert time (D15)', () => {
  const task = { id: 't1', original_end_date: at(20), due: at(20, 23, 59) };
  const a = alert({ taskId: 't1', time: at(0, 9) });                 // the alert fires today, the order is due in 20 days
  assert.equal(ruleMatches(a, task, rule({ dayFrom: 0, dayTo: 3 }), TODAY, deps), false);
  assert.equal(ruleMatches(a, task, rule({ dayFrom: 18, dayTo: 22 }), TODAY, deps), true);
  // without the task the alert time is the anchor
  assert.equal(ruleMatches(a, undefined, rule({ dayFrom: 0, dayTo: 3 }), TODAY, deps), true);
});

test('minLateHours: needs a task and lateness >= threshold', () => {
  const a = alert({ taskId: 't1' });
  const r = rule({ minLateHours: 24 });
  assert.equal(ruleMatches(a, { id: 't1', late: 23.9 }, r, TODAY, deps), false);
  assert.equal(ruleMatches(a, { id: 't1', late: 24 }, r, TODAY, deps), true);
  assert.equal(ruleMatches(a, { id: 't1', late: 100 }, r, TODAY, deps), true);
  assert.equal(ruleMatches(alert(), undefined, r, TODAY, deps), false, 'no task never matches');
  assert.equal(ruleMatches(a, { id: 't1', late: 0 }, rule({ minLateHours: null }), TODAY, deps), true);
});

test('all rule fields are ANDed within one rule', () => {
  const r = rule({ types: ['late'], dayFrom: 0, dayTo: 7, minSev: 'err' });
  assert.equal(ruleMatches(alert({ type: 'late', sev: 'err', time: at(3) }), undefined, r, TODAY, deps), true);
  assert.equal(ruleMatches(alert({ type: 'late', sev: 'warn', time: at(3) }), undefined, r, TODAY, deps), false);
  assert.equal(ruleMatches(alert({ type: 'overlap', sev: 'err', time: at(3) }), undefined, r, TODAY, deps), false);
  assert.equal(ruleMatches(alert({ type: 'late', sev: 'err', time: at(9) }), undefined, r, TODAY, deps), false);
});

// ---- profiles -------------------------------------------------------------------------------

test('profileMatches ORs the rules', () => {
  const p = { ...ALL_ALERTS_PROFILE, builtIn: false, rules: [rule({ types: ['late'] }), rule({ types: ['blackout'], minSev: 'err' })] };
  assert.equal(profileMatches(alert({ type: 'late' }), undefined, p, TODAY, deps), true);
  assert.equal(profileMatches(alert({ type: 'blackout', sev: 'err' }), undefined, p, TODAY, deps), true);
  assert.equal(profileMatches(alert({ type: 'blackout', sev: 'warn' }), undefined, p, TODAY, deps), false);
  assert.equal(profileMatches(alert({ type: 'overlap' }), undefined, p, TODAY, deps), false);
  assert.equal(profileMatches(alert(), undefined, { ...p, rules: [] }, TODAY, deps), false, 'no rules matches nothing');
});

test('ALL_ALERTS_PROFILE matches everything, including no-anchor alerts', () => {
  assert.equal(ALL_ALERTS_PROFILE_ID, '__all__');
  assert.equal(ALL_ALERTS_PROFILE.id, '__all__');
  assert.equal(ALL_ALERTS_PROFILE.builtIn, true);
  assert.equal(ALL_ALERTS_PROFILE.rules.length, 1);
  const alerts = [alert(), alert({ id: 'b', type: 'late', sev: 'err', time: at(-900) }), alert({ id: 'c', time: undefined }), alert({ id: 'd', time: at(900) })];
  assert.equal(filterByProfile(alerts, {}, ALL_ALERTS_PROFILE, TODAY, deps).length, 4);
});

test('filterByProfile looks tasks up by taskId and keeps order', () => {
  const tasksById = { t1: { id: 't1', original_end_date: at(1), due: at(1, 23, 59) }, t2: { id: 't2', original_end_date: at(30), due: at(30, 23, 59) } };
  const alerts = [alert({ id: 'x', taskId: 't2' }), alert({ id: 'y', taskId: 't1' }), alert({ id: 'z' })];
  const p = { ...ALL_ALERTS_PROFILE, builtIn: false, rules: [rule({ dayFrom: 0, dayTo: 7 })] };
  assert.deepEqual(filterByProfile(alerts, tasksById, p, TODAY, deps).map(a => a.id), ['y', 'z']);
});

// ---- validation -----------------------------------------------------------------------------

const draft = (o = {}) => ({ plant: '1006', name: 'Next week', description: '', ranking: 'impact', rules: [rule({ types: ['late'] })], ...o });
const existing = [{ id: 'p1', plant: '1006', name: 'Errors', description: '', rules: [rule()], ranking: 'impact', created_by: null, updated_at: null },
  { id: 'p2', plant: '5512', name: 'Other plant', description: '', rules: [rule()], ranking: 'impact', created_by: null, updated_at: null }];

test('validateProfile: a clean draft is ok', () => {
  assert.deepEqual(validateProfile(draft(), existing), { ok: true, errors: {} });
});

test('validateProfile: name required and unique per plant, case-insensitive, excluding self', () => {
  assert.equal(validateProfile(draft({ name: '   ' }), existing).errors.name, 'ape.err_name_required');
  assert.equal(validateProfile(draft({ name: 'errors' }), existing).errors.name, 'ape.err_name_dup');
  assert.equal(validateProfile(draft({ name: '  ERRORS ' }), existing).errors.name, 'ape.err_name_dup');
  assert.equal(validateProfile(draft({ name: 'errors', id: 'p1' }), existing).ok, true, 'editing self is not a duplicate');
  assert.equal(validateProfile(draft({ name: 'other plant' }), existing).ok, true, 'a different plant may reuse the name');
});

test('validateProfile: needs at least one rule', () => {
  const r = validateProfile(draft({ rules: [] }), existing);
  assert.equal(r.ok, false);
  assert.equal(r.errors.rules, 'ape.err_no_rules');
});

test('validateProfile: types null is fine, an empty or unknown list is not', () => {
  assert.equal(validateProfile(draft({ rules: [rule({ types: null })] }), existing).ok, true);
  assert.equal(validateProfile(draft({ rules: [rule({ types: [] })] }), existing).errors['rules.0.types'], 'ape.err_rule_no_types');
  assert.equal(validateProfile(draft({ rules: [rule({ types: ['bogus'] })] }), existing).errors['rules.0.types'], 'ape.err_rule_no_types');
  assert.equal(validateProfile(draft({ rules: [rule({ types: ['near-capacity'] })] }), existing).errors['rules.0.types'], 'ape.err_rule_no_types', 'never-firing types are rejected like the server');
});

test('validateProfile: day bounds are integers within +/-365 and ordered', () => {
  const err = (r) => validateProfile(draft({ rules: [r] }), existing).errors;
  assert.equal(validateProfile(draft({ rules: [rule({ dayFrom: -365, dayTo: 365 })] }), existing).ok, true);
  assert.equal(err(rule({ dayFrom: -366 }))['rules.0.dayFrom'], 'ape.err_days_range');
  assert.equal(err(rule({ dayTo: 366 }))['rules.0.dayTo'], 'ape.err_days_range');
  assert.equal(err(rule({ dayFrom: 1.5 }))['rules.0.dayFrom'], 'ape.err_days_range');
  assert.equal(err(rule({ dayTo: NaN }))['rules.0.dayTo'], 'ape.err_days_range');
  assert.equal(err(rule({ dayFrom: 5, dayTo: 2 }))['rules.0.days'], 'ape.err_days_order');
  assert.equal(validateProfile(draft({ rules: [rule({ dayFrom: 3, dayTo: 3 })] }), existing).ok, true);
  assert.equal(validateProfile(draft({ rules: [rule({ dayFrom: 3 })] }), existing).ok, true);
});

test('validateProfile: minLateHours is null or a finite number >= 0', () => {
  const err = (v) => validateProfile(draft({ rules: [rule({ minLateHours: v })] }), existing).errors['rules.0.minLateHours'];
  assert.equal(err(null), undefined);
  assert.equal(err(0), undefined);
  assert.equal(err(12.5), undefined);
  assert.equal(err(-1), 'ape.err_late_hours');
  assert.equal(err(Infinity), 'ape.err_late_hours');
  assert.equal(err(NaN), 'ape.err_late_hours');
  assert.equal(err('3'), 'ape.err_late_hours');
});

test('validateProfile: identical rules are flagged on the later rule (type order does not matter)', () => {
  const a = rule({ types: ['late', 'overlap'], dayFrom: 0 });
  const b = rule({ types: ['overlap', 'late'], dayFrom: 0 });
  const r = validateProfile(draft({ rules: [a, b] }), existing);
  assert.equal(r.errors['rules.1.dup'], 'ape.err_rule_dup');
  assert.equal(r.errors['rules.0.dup'], undefined);
  assert.equal(validateProfile(draft({ rules: [a, rule({ types: ['late', 'overlap'], dayFrom: 1 })] }), existing).ok, true);
});

test('validateProfile: name length 60 ok, 61 rejected (trimmed)', () => {
  assert.equal(validateProfile(draft({ name: 'x'.repeat(60) }), existing).ok, true);
  assert.equal(validateProfile(draft({ name: ' ' + 'x'.repeat(60) + ' ' }), existing).ok, true);
  assert.equal(validateProfile(draft({ name: 'x'.repeat(61) }), existing).errors.name, 'ape.err_name_long');
});

test('validateProfile: 20 rules ok, 21 rejected', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => rule({ dayFrom: i }));
  assert.equal(validateProfile(draft({ rules: many(20) }), existing).ok, true);
  assert.equal(validateProfile(draft({ rules: many(21) }), existing).errors.rules, 'ape.err_too_many_rules');
});

test('validateProfile: minSev must be null, warn or err', () => {
  const err = (v) => validateProfile(draft({ rules: [rule({ minSev: v })] }), existing).errors['rules.0.minSev'];
  assert.equal(err(null), undefined);
  assert.equal(err('warn'), undefined);
  assert.equal(err('err'), undefined);
  for (const bad of ['error', 'info', '', 'WARN', 1, true]) assert.equal(err(bad), 'ape.err_min_sev', String(bad));
});

test('validateProfile: a non-object rule entry is a rule-level error, not a throw', () => {
  for (const bad of [null, 'x', 5, [], undefined]) {
    const r = validateProfile(draft({ rules: [bad] }), existing);
    assert.equal(r.ok, false);
    assert.equal(r.errors['rules.0.types'], 'ape.err_rule_no_types');
  }
});

// ---- ranking --------------------------------------------------------------------------------

const ctx = (extra = {}) => ({ tasksById: {}, horizonStart: at(0), horizonMinutes: 14 * 1440, plantToday: TODAY, deps, ...extra });

test('impactPoints: err 5 / warn 2 with the time weight, 0 outside the horizon (fallback weights)', () => {
  const start = at(0), mins = 14 * 1440;
  assert.equal(impactPoints(alert({ sev: 'err', time: at(1) }), start, mins), 7.5);     // 5 x 1.5
  assert.equal(impactPoints(alert({ sev: 'warn', time: at(5) }), start, mins), 2.5);    // 2 x 1.25
  assert.equal(impactPoints(alert({ sev: 'warn', time: at(10) }), start, mins), 2);
  assert.equal(impactPoints(alert({ sev: 'err', time: at(14) }), start, mins), 0, 'horizon end is exclusive');
  assert.equal(impactPoints(alert({ sev: 'err', time: at(-1) }), start, mins), 0);
  assert.equal(impactPoints(alert({ sev: 'err', time: undefined }), start, mins), 0);
});

test('impactPoints matches the compute-core alertPoints when the core is loaded', () => {
  const prev = globalThis.NimbusComputeCore;
  globalThis.NimbusComputeCore = require('../../../frontend/nimbus-compute-core.js');
  try {
    const start = at(0), mins = 14 * 1440, end = new Date(start.getTime() + mins * 60000);
    for (const a of [alert({ sev: 'err', time: at(1) }), alert({ sev: 'warn', time: at(6) }), alert({ sev: 'warn', time: at(13) }), alert({ time: at(20) })]) {
      assert.equal(impactPoints(a, start, mins), globalThis.NimbusComputeCore.alertPoints(a, start, end));
    }
  } finally { globalThis.NimbusComputeCore = prev; }
});

const sorted = (ranking, alerts, c = ctx()) => [...alerts].sort(compareAlerts(ranking, c)).map(a => a.id);

test('compareAlerts impact: points desc, then anchor asc, then id', () => {
  const alerts = [
    alert({ id: 'w-soon', sev: 'warn', time: at(1) }),                // 3
    alert({ id: 'e-late', sev: 'err', time: at(10) }),                // 5
    alert({ id: 'e-soon', sev: 'err', time: at(2) }),                 // 7.5
    alert({ id: 'e-late2', sev: 'err', time: at(9) }),                // 5, earlier than e-late
  ];
  assert.deepEqual(sorted('impact', alerts), ['e-soon', 'e-late2', 'e-late', 'w-soon']);
  const tie = [alert({ id: 'b', time: at(3) }), alert({ id: 'a', time: at(3) })];
  assert.deepEqual(sorted('impact', tie), ['a', 'b'], 'full tie breaks on id');
});

test('compareAlerts time: anchor asc with no-anchor alerts last', () => {
  const alerts = [alert({ id: 'none', time: undefined }), alert({ id: 'later', time: at(5) }), alert({ id: 'sooner', time: at(1) })];
  assert.deepEqual(sorted('time', alerts), ['sooner', 'later', 'none']);
  assert.deepEqual(sorted('time', [alert({ id: 'n2', time: undefined }), alert({ id: 'n1', time: undefined })]), ['n1', 'n2']);
});

test('compareAlerts time uses the due-date anchor', () => {
  const tasksById = { t1: { id: 't1', original_end_date: at(30), due: at(30) } };
  const alerts = [alert({ id: 'due-far', taskId: 't1', time: at(0) }), alert({ id: 'mid', time: at(5) })];
  assert.deepEqual(sorted('time', alerts, ctx({ tasksById })), ['mid', 'due-far']);
});

test('compareAlerts severity: err first, then anchor asc, nulls last', () => {
  const alerts = [
    alert({ id: 'w1', sev: 'warn', time: at(1) }), alert({ id: 'e2', sev: 'err', time: at(8) }),
    alert({ id: 'e1', sev: 'err', time: at(2) }), alert({ id: 'en', sev: 'err', time: undefined }),
  ];
  assert.deepEqual(sorted('severity', alerts), ['e1', 'e2', 'en', 'w1']);
});

test('compareAlerts orders: affected-order count desc (1 + peer), then anchor', () => {
  const alerts = [
    alert({ id: 'single-soon', time: at(1) }),
    alert({ id: 'pair-late', peerId: 't9', time: at(6) }),
    alert({ id: 'pair-soon', peerId: 't8', time: at(2) }),
  ];
  assert.deepEqual(sorted('orders', alerts), ['pair-soon', 'pair-late', 'single-soon']);
});

// ---- grouping -------------------------------------------------------------------------------

const GA = [
  alert({ id: 'a', sev: 'err', type: 'overlap', line: 'L1', taskId: 't1', peerId: 't2', time: at(1, 8) }),     // 7.5
  alert({ id: 'b', sev: 'warn', type: 'overlap', line: 'L2', taskId: 't3', time: at(1, 15) }),                 // 3
  alert({ id: 'c', sev: 'warn', type: 'late', line: 'L1', taskId: 't1', time: at(9) }),                        // 2
  alert({ id: 'd', sev: 'err', type: 'setup-uncovered', line: 'L2', time: undefined }),                        // 0 (no time)
];

test('groupAlerts by category', () => {
  const g = groupAlerts(GA, 'category', ctx());
  assert.deepEqual(g.map(x => x.key), ['conflicts', 'exceptions', 'setup']);
  assert.equal(g[0].points, 10.5);
  assert.deepEqual(g[0].alerts.map(a => a.id), ['a', 'b']);
  assert.deepEqual(g[0].vars, { category: 'conflicts' });
});

test('groupAlerts by type, sorted by points desc', () => {
  const g = groupAlerts(GA, 'type', ctx());
  assert.deepEqual(g.map(x => x.key), ['overlap', 'late', 'setup-uncovered']);
  assert.deepEqual(g.map(x => x.points), [10.5, 2, 0]);
});

test('groupAlerts by line', () => {
  const g = groupAlerts(GA, 'line', ctx());
  assert.deepEqual(g.map(x => x.key), ['L1', 'L2']);
  assert.deepEqual(g[0].alerts.map(a => a.id), ['a', 'c']);
  assert.deepEqual(g[0].vars, { line: 'L1' });
});

test('groupAlerts by day uses the anchor day; no-anchor alerts go to a "none" group', () => {
  const tasksById = { t1: { id: 't1', original_end_date: at(20), due: at(20, 12) } };
  const g = groupAlerts(GA, 'day', ctx({ tasksById }));
  const keys = g.map(x => x.key);
  assert.deepEqual(new Set(keys), new Set(['2026-10-21', '2026-11-09', 'none']));
  const d21 = g.find(x => x.key === '2026-10-21');
  assert.deepEqual(d21.alerts.map(a => a.id), ['b'], 'a and c are anchored to the t1 due date, not their alert time');
  assert.deepEqual(g.find(x => x.key === '2026-11-09').alerts.map(a => a.id), ['a', 'c']);
  assert.deepEqual(g.find(x => x.key === 'none').alerts.map(a => a.id), ['d']);
  assert.deepEqual(d21.vars, { day: '2026-10-21' });
});

test('groupAlerts by order lists an alert under its own order and collects peer ids', () => {
  const g = groupAlerts(GA, 'order', ctx());
  const t1 = g.find(x => x.key === 't1');
  assert.deepEqual(t1.alerts.map(a => a.id), ['a', 'c']);
  assert.deepEqual(t1.orderIds.sort(), ['t1', 't2']);
  assert.deepEqual(g.find(x => x.key === 't3').orderIds, ['t3']);
  assert.deepEqual(g.find(x => x.key === 'none').alerts.map(a => a.id), ['d'], 'alerts with no order are grouped together');
  assert.equal(g[0].key, 't1', 'sorted by points desc');
});

test('groupAlerts none gives one group; empty input gives no groups', () => {
  const g = groupAlerts(GA, 'none', ctx());
  assert.equal(g.length, 1);
  assert.equal(g[0].alerts.length, 4);
  assert.equal(g[0].points, 12.5);
  assert.deepEqual(groupAlerts([], 'type', ctx()), []);
});

test('groupAlerts ties on points break by size then key', () => {
  const al = [alert({ id: 'x', line: 'B', time: undefined }), alert({ id: 'y', line: 'A', time: undefined })];
  assert.deepEqual(groupAlerts(al, 'line', ctx()).map(x => x.key), ['A', 'B']);
});

// ---- active profile -------------------------------------------------------------------------

test('resolveActiveProfileId: user beats role beats __all__', () => {
  const available = [{ id: 'u1' }, { id: 'r1' }];
  assert.equal(resolveActiveProfileId('1006', { alertProfileByPlant: { 1006: 'u1' } }, { alertProfileByPlant: { 1006: 'r1' } }, available), 'u1');
  assert.equal(resolveActiveProfileId('1006', { alertProfileByPlant: { 5512: 'u1' } }, { alertProfileByPlant: { 1006: 'r1' } }, available), 'r1');
  assert.equal(resolveActiveProfileId('1006', {}, {}, available), '__all__');
  assert.equal(resolveActiveProfileId('1006', null, undefined, available), '__all__');
  assert.equal(resolveActiveProfileId('1006', { alertProfileByPlant: null }, { alertProfileByPlant: null }, available), '__all__');
});

test('resolveActiveProfileId: an id that is not available falls back to __all__ (does not fall through to the role)', () => {
  const available = [{ id: 'r1' }];
  assert.equal(resolveActiveProfileId('1006', { alertProfileByPlant: { 1006: 'gone' } }, { alertProfileByPlant: { 1006: 'r1' } }, available), '__all__');
  assert.equal(resolveActiveProfileId('1006', { alertProfileByPlant: { 1006: '__all__' } }, {}, []), '__all__');
});
