// Tests for frontend/alert-monitor/alert-monitor-model.mts — the pure summary-line / window / view helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  profileWindow, summaryLine, windowSummary, visibleAlertsFor, horizonAlerts, emptyStateFor,
  MONITOR_SORTS, groupCounts, rowActionsFor,
} from '../../../frontend/alert-monitor/alert-monitor-model.mjs';
import { ALL_ALERTS_PROFILE, ALERT_CATEGORY_ORDER, DEFAULT_CATEGORY_COLORS } from '../../../frontend/insights/alert-profiles.mjs';

const EN = {
  'am.window_rule': '{{types}} · D{{from}}–{{to}} · {{sev}}',
  'am.window_any_days': 'any day',
  'am.window_sev_any': 'all severities',
  'am.window_sev_err': 'errors only',
  'am.window_all': 'Showing every alert in the horizon',
  'am.profile_all': 'All alerts',
  'alert.type.overlap': 'Order overlap',
  'alert.type.overload': 'Overload',
  'ape.cat_capacity': 'Capacity', 'ape.cat_conflicts': 'Scheduling conflicts', 'ape.cat_calendar': 'Calendar',
  'ape.cat_setup': 'Setup', 'ape.cat_planning': 'Planning', 'ape.cat_late': 'Late', 'ape.cat_exceptions': 'Other',
};
const t = (k, v) => (EN[k] ?? k).replace(/\{\{(\w+)\}\}/g, (_, n) => String(v?.[n] ?? ''));
const rule = (o = {}) => ({ types: null, dayFrom: null, dayTo: null, minSev: null, minLateHours: null, ...o });
const prof = (rules, ranking = 'impact') => ({ id: 'p1', plant: 'P', name: 'N', description: '', rules, ranking, created_by: null, updated_at: null });

test('profileWindow: a single rule, and several rules with the same window, give that window', () => {
  assert.deepEqual(profileWindow(prof([rule({ dayFrom: 8, dayTo: 30 })])), { from: 8, to: 30 });
  assert.deepEqual(profileWindow(prof([rule({ dayFrom: 8, dayTo: 30, types: ['overlap'] }), rule({ dayFrom: 8, dayTo: 30, minSev: 'err' })])), { from: 8, to: 30 });
  assert.deepEqual(profileWindow(prof([rule({ dayFrom: -7, dayTo: 30 })])), { from: -7, to: 30 });
});

test('profileWindow: differing windows, an open bound, no rules and All alerts give null', () => {
  assert.equal(profileWindow(prof([rule({ dayFrom: 0, dayTo: 7 }), rule({ dayFrom: 8, dayTo: 30 })])), null);
  assert.equal(profileWindow(prof([rule({ dayFrom: 0, dayTo: 7 }), rule({ dayFrom: 0, dayTo: 8 })])), null);
  assert.equal(profileWindow(prof([rule({ dayFrom: 8, dayTo: null })])), null);
  assert.equal(profileWindow(prof([rule({ dayFrom: null, dayTo: 7 })])), null);
  assert.equal(profileWindow(prof([rule({ dayFrom: 0, dayTo: 7 }), rule({})])), null);
  assert.equal(profileWindow(prof([])), null);
  assert.equal(profileWindow(null), null);
  assert.equal(profileWindow(ALL_ALERTS_PROFILE), null);
});

const SUM = {
  'am.summary_window': '{{n}} alerts in D{{from}}–{{to}} match {{name}}',
  'am.summary_profile': '{{n}} alerts match {{name}}',
  'am.summary_all': '{{n}} alerts at this plant',
  'am.summary_window_one': '1 alert in D{{from}}–{{to}} matches {{name}}',
  'am.summary_profile_one': '1 alert matches {{name}}',
  'am.summary_all_one': '1 alert at this plant',
  'am.summary_errors': '{{e}} errors', 'am.summary_errors_one': '1 error',
  'am.summary_warnings': '{{w}} warnings', 'am.summary_warnings_one': '1 warning',
  'am.empty_no_plant': 'Select a plant',
};
const ts = (k, v) => (SUM[k] ?? k).replace(/\{\{(\w+)\}\}/g, (_, n) => String(v?.[n] ?? ''));
const al = (id, sev, taskId, peerId) => ({ id, sev, type: 'overlap', taskId, peerId });
const sumIn = (o = {}) => ({
  hasPlant: true, alerts: [], profileId: 'p1', profileName: 'Overlaps',
  profile: prof([rule({ dayFrom: 8, dayTo: 30 })]), confidence: 71, ...o,
});

test('summaryLine: the lead is the window, profile or all-alerts variant', () => {
  const alerts = [al('a', 'err', '1')];
  assert.equal(summaryLine(sumIn({ alerts }), ts).text, '1 alert in D8–30 matches Overlaps · 1 error');
  assert.match(summaryLine(sumIn({ alerts, profile: prof([rule({ dayFrom: 8, dayTo: null })]) }), ts).text, /^1 alert matches Overlaps · /);
  assert.match(summaryLine(sumIn({ alerts, profileId: '__all__', profile: ALL_ALERTS_PROFILE }), ts).text, /^1 alert at this plant · /);
  assert.match(summaryLine(sumIn({ alerts, profile: prof([rule({ dayFrom: -7, dayTo: 30 })]) }), ts).text, /D-7–30/);
});

test('summaryLine: zero-valued clauses are omitted and _one forms apply at exactly 1', () => {
  assert.equal(summaryLine(sumIn(), ts).text, '0 alerts in D8–30 match Overlaps');
  const warnOnly = summaryLine(sumIn({ alerts: [al('a', 'warn', undefined)] }), ts).text;
  assert.equal(warnOnly, '1 alert in D8–30 matches Overlaps · 1 warning');
  const many = summaryLine(sumIn({ alerts: [al('a', 'err', '1', '2'), al('b', 'err', '3'), al('c', 'warn', '1')] }), ts).text;
  assert.equal(many, '3 alerts in D8–30 match Overlaps · 2 errors · 1 warning');
});

test('summaryLine: the lead uses the singular _one key at exactly 1 and the plural key otherwise (window, profile, all)', () => {
  const one = [al('a', 'err', '1')], two = [al('a', 'err', '1'), al('b', 'warn', '2')];
  const profileOnly = prof([rule({ dayFrom: 8, dayTo: null })]);
  const lead = o => summaryLine(sumIn(o), ts).text.split(' · ')[0];
  assert.equal(lead({ alerts: one }), '1 alert in D8–30 matches Overlaps');
  assert.equal(lead({ alerts: two }), '2 alerts in D8–30 match Overlaps');
  assert.equal(lead({ alerts: one, profile: profileOnly }), '1 alert matches Overlaps');
  assert.equal(lead({ alerts: two, profile: profileOnly }), '2 alerts match Overlaps');
  assert.equal(lead({ alerts: one, profileId: '__all__', profile: ALL_ALERTS_PROFILE }), '1 alert at this plant');
  assert.equal(lead({ alerts: two, profileId: '__all__', profile: ALL_ALERTS_PROFILE }), '2 alerts at this plant');
});

test('summaryLine: no plant says only the select-a-plant message', () => {
  assert.deepEqual(summaryLine(sumIn({ hasPlant: false }), ts), { text: 'Select a plant' });
});

test('summaryLine never uses the words points, pts, exact or estimate', () => {
  const s = summaryLine(sumIn({ alerts: [al('a', 'err', '1', '2'), al('b', 'warn', '3')] }), ts);
  assert.doesNotMatch(s.text, /points|pts|exact|estimate/i);
});

test('windowSummary: All alerts and empty profiles read as the whole horizon', () => {
  assert.equal(windowSummary(ALL_ALERTS_PROFILE, t), 'Showing every alert in the horizon');
  assert.equal(windowSummary(null, t), 'Showing every alert in the horizon');
});

test('windowSummary: a stored profile with every group on and no narrowing rule reads the whole-horizon sentence, not the label', () => {
  const categories = Object.fromEntries(ALERT_CATEGORY_ORDER.map(c => [c, { on: true, color: DEFAULT_CATEGORY_COLORS[c] }]));
  assert.equal(windowSummary({ ...prof([]), categories }, t), 'Showing every alert in the horizon');
  // A narrowing rule keeps the per-rule line.
  assert.notEqual(windowSummary({ ...prof([rule({ types: ['late'], dayFrom: 0, dayTo: 6 })]), categories }, t), 'Showing every alert in the horizon');
});

test('windowSummary: a single rule renders types, day window and severity', () => {
  const s = windowSummary(prof([rule({ types: ['overlap', 'overload'], dayFrom: 0, dayTo: 7, minSev: 'err' })]), t);
  assert.equal(s, 'Order overlap, Overload · D0–7 · errors only');
});

test('windowSummary: no day bounds reads "any day"; many types collapse to categories; rules are joined', () => {
  const many = rule({ types: ['overlap', 'tool-conflict', 'overload'], minSev: 'warn' });
  const s = windowSummary(prof([many, rule({ types: ['overlap'], dayFrom: 8, dayTo: null })]), t);
  assert.equal(s, 'Capacity, Scheduling conflicts · any day · all severities | Order overlap · D8–… · all severities');
});

test('windowSummary names Planning when a rule spans the planning types', () => {
  const s = windowSummary(prof([rule({ types: ['overlap', 'needs_planning', 'queued_now_fits'] })]), t);
  assert.equal(s, 'Scheduling conflicts, Planning · any day · all severities');
});

test('visibleAlertsFor keeps matched alerts and hides acknowledged ones unless asked', () => {
  const alerts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const matched = new Set(['a', 'b']);
  const acked = new Map([['b', {}]]);
  assert.deepEqual(visibleAlertsFor(alerts, matched, acked, false).map(a => a.id), ['a']);
  assert.deepEqual(visibleAlertsFor(alerts, matched, acked, true).map(a => a.id), ['a', 'b']);
});

test('horizonAlerts scopes to plant lines and the horizon cutoff', () => {
  const now = new Date('2026-10-20T08:00:00');
  const alerts = [
    { id: 1, line: 'L1', time: new Date('2026-10-21T00:00:00') },
    { id: 2, line: 'L1', time: new Date('2026-12-01T00:00:00') },
    { id: 3, line: 'OTHER', time: now },
    { id: 4, line: '', time: null },
  ];
  const cutoff = new Date('2026-10-30T00:00:00');
  assert.deepEqual(horizonAlerts(alerts, new Set(['L1']), cutoff).map(a => a.id), [1, 4]);
  assert.deepEqual(horizonAlerts(alerts, new Set(['L1']), null).map(a => a.id), [1, 2, 4]);
});

test('horizonAlerts drops an alert only for a real reason: an Invalid Date time stays, an invalid cutoff cuts nothing', () => {
  const alerts = [
    { id: 1, line: 'L1', time: new Date('2026-10-21T00:00:00') },
    { id: 2, line: 'L1', time: new Date('2026-12-01T00:00:00') },
    { id: 3, line: 'L1', time: new Date(NaN) },
    { id: 4, line: 'L1' },
  ];
  const cutoff = new Date('2026-10-30T00:00:00');
  assert.deepEqual(horizonAlerts(alerts, new Set(['L1']), cutoff).map(a => a.id), [1, 3, 4], 'only the valid time past the cutoff is dropped');
  assert.deepEqual(horizonAlerts(alerts, new Set(['L1']), new Date(NaN)).map(a => a.id), [1, 2, 3, 4], 'an invalid cutoff keeps everything');
});

test('emptyStateFor picks the right empty state', () => {
  const base = { plant: 'P', scopedCount: 5, matchedCount: 3, visibleCount: 3, isAllAlerts: false };
  assert.equal(emptyStateFor({ ...base, plant: null }), 'no-plant');
  assert.equal(emptyStateFor({ ...base, scopedCount: 0 }), 'no-alerts');
  assert.equal(emptyStateFor(base), null);
  assert.equal(emptyStateFor({ ...base, matchedCount: 0, visibleCount: 0 }), 'no-match');
  assert.equal(emptyStateFor({ ...base, matchedCount: 0, visibleCount: 0, isAllAlerts: true }), 'no-alerts');
  assert.equal(emptyStateFor({ ...base, visibleCount: 0 }), 'all-acked');   // matches exist but all acknowledged
  assert.equal(emptyStateFor({ ...base, visibleCount: 0, isAllAlerts: true }), 'all-acked');
});

test('a tool conflict with zero available copies is not movable and offers no Fix; a normal one is', () => {
  const zero = { id: 'z', sev: 'err', type: 'tool-conflict', taskId: 'a', peerId: 'b', available: 0 };
  const some = { id: 's', sev: 'err', type: 'tool-conflict', taskId: 'c', peerId: 'd', available: 1 };
  const ovl = { id: 'o', sev: 'err', type: 'overlap', taskId: 'e', peerId: 'f' };
  const counts = groupCounts([zero, some, ovl], () => false);
  assert.deepEqual(counts.movableIds, ['s', 'o']);
  assert.equal(counts.movableOrders, 2);
  assert.equal(counts.orders, 6, 'the zero-copy alert still counts its orders');
  assert.equal(rowActionsFor(zero).fix, false);
  assert.equal(rowActionsFor(some).fix, true);
  assert.equal(rowActionsFor(ovl).fix, true);
});

// ---- W3: category-aware window + summary ----
const cats = (on) => Object.fromEntries(ALERT_CATEGORY_ORDER.map(c => [c, { on: on.includes(c), color: DEFAULT_CATEGORY_COLORS[c] }]));
const cprof = (rules, on) => ({ ...prof(rules), categories: cats(on) });

test('profileWindow (categories): every ON category needs an applicable rule, all sharing one window; OFF-only rules are ignored', () => {
  const w = { dayFrom: 0, dayTo: 7 };
  assert.deepEqual(profileWindow(cprof([rule({ types: ['late'], ...w }), rule({ types: ['overlap'], ...w })], ['late', 'conflicts'])), { from: 0, to: 7 });
  assert.equal(profileWindow(cprof([rule({ types: ['late'], ...w })], ['late', 'conflicts'])), null, 'conflicts has no applicable rule');
  assert.equal(profileWindow(cprof([rule({ types: ['late'], ...w }), rule({ types: ['overlap'], dayFrom: 1, dayTo: 7 })], ['late', 'conflicts'])), null, 'differing windows');
  assert.deepEqual(profileWindow(cprof([rule({ types: ['late'], ...w }), rule({ types: ['overlap'], dayFrom: 9, dayTo: 12 })], ['late'])), { from: 0, to: 7 }, 'a rule for an OFF category is ignored');
  assert.equal(profileWindow(cprof([], ['late'])), null);
  assert.equal(profileWindow(cprof([rule({ types: ['late'], dayFrom: 0 })], ['late'])), null, 'open bound');
});

test('windowSummary (categories): lists the ON category labels, not rule types', () => {
  const s = windowSummary(cprof([rule({ types: ['overlap'], dayFrom: 0, dayTo: 7, minSev: 'err' })], ['conflicts', 'late']), t);
  assert.equal(s, 'Late · any day · all severities | Scheduling conflicts · D0–7 · errors only');
  assert.equal(windowSummary(cprof([], ALERT_CATEGORY_ORDER), t), 'Showing every alert in the horizon', 'all ON, nothing narrowing: the whole-horizon sentence (W5)');
  assert.equal(windowSummary(cprof([rule({ types: ['overlap'] })], ['late']), t), 'Late · any day · all severities', 'a rule for an OFF category adds no line');
});

test('windowSummary: a stored minSev warn reads as all severities', () => {
  assert.equal(windowSummary(prof([rule({ types: ['overlap'], minSev: 'warn' })]), t), 'Order overlap · any day · all severities');
});

test('MONITOR_SORTS lists only Priority and Date', () => {
  assert.deepEqual([...MONITOR_SORTS], ['impact', 'time']);
});
