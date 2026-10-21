// Tests for frontend/alert-monitor/alert-monitor-model.mts — the pure summary-line / window / view helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  profileWindow, summaryLine, windowSummary, viewFor, visibleAlertsFor, horizonAlerts, emptyStateFor,
  MONITOR_GROUP_BYS, MONITOR_SORTS,
} from '../../../frontend/alert-monitor/alert-monitor-model.mjs';
import { ALL_ALERTS_PROFILE } from '../../../frontend/insights/alert-profiles.mjs';

const EN = {
  'am.window_rule': '{{types}} · D{{from}}–{{to}} · {{sev}}',
  'am.window_any_days': 'any day',
  'am.window_sev_any': 'all severities',
  'am.window_sev_warn': 'warnings and errors',
  'am.window_sev_err': 'errors only',
  'am.window_all': 'Showing every alert in the horizon',
  'am.profile_all': 'All alerts',
  'alert.type.overlap': 'Order overlap',
  'alert.type.overload': 'Overload',
  'ape.cat_capacity': 'Capacity', 'ape.cat_conflicts': 'Scheduling conflicts', 'ape.cat_calendar': 'Calendar',
  'ape.cat_setup': 'Setup', 'ape.cat_exceptions': 'Other',
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
  'am.summary_orders': '{{o}} orders affected', 'am.summary_orders_one': '1 order affected',
  'am.summary_conf': 'Plant confidence {{score}}',
  'am.focus_chip': 'Showing {{n}} alerts for: {{title}}',
  'am.focus_chip_outside': 'Showing {{n}} alerts for: {{title}} ({{k}} outside your profile)',
  'am.empty_no_plant': 'Select a plant',
};
const ts = (k, v) => (SUM[k] ?? k).replace(/\{\{(\w+)\}\}/g, (_, n) => String(v?.[n] ?? ''));
const al = (id, sev, taskId, peerId) => ({ id, sev, type: 'overlap', taskId, peerId });
const sumIn = (o = {}) => ({
  hasPlant: true, alerts: [], profileId: 'p1', profileName: 'Overlaps',
  profile: prof([rule({ dayFrom: 8, dayTo: 30 })]), focus: null, confidence: 71, ...o,
});

test('summaryLine: the lead is the window, profile, all-alerts or focus variant', () => {
  const alerts = [al('a', 'err', '1')];
  assert.equal(summaryLine(sumIn({ alerts }), ts).text, '1 alert in D8–30 matches Overlaps · 1 error · 1 order affected');
  assert.match(summaryLine(sumIn({ alerts, profile: prof([rule({ dayFrom: 8, dayTo: null })]) }), ts).text, /^1 alert matches Overlaps · /);
  assert.match(summaryLine(sumIn({ alerts, profileId: '__all__', profile: ALL_ALERTS_PROFILE }), ts).text, /^1 alert at this plant · /);
  assert.match(summaryLine(sumIn({ alerts, focus: { title: 'Setup pair', outside: 0 } }), ts).text, /^Showing 1 alerts for: Setup pair · /);
  assert.match(summaryLine(sumIn({ alerts, focus: { title: 'Setup pair', outside: 2 } }), ts).text, /^Showing 1 alerts for: Setup pair \(2 outside your profile\) · /);
  assert.match(summaryLine(sumIn({ alerts, profile: prof([rule({ dayFrom: -7, dayTo: 30 })]) }), ts).text, /D-7–30/);
});

test('summaryLine: zero-valued clauses are omitted and _one forms apply at exactly 1', () => {
  assert.equal(summaryLine(sumIn(), ts).text, '0 alerts in D8–30 match Overlaps');
  const warnOnly = summaryLine(sumIn({ alerts: [al('a', 'warn', undefined)] }), ts).text;
  assert.equal(warnOnly, '1 alert in D8–30 matches Overlaps · 1 warning');
  const many = summaryLine(sumIn({ alerts: [al('a', 'err', '1', '2'), al('b', 'err', '3'), al('c', 'warn', '1')] }), ts).text;
  assert.equal(many, '3 alerts in D8–30 match Overlaps · 2 errors · 1 warning · 3 orders affected');
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

test('summaryLine: the confidence link splits around the score; no score, no link', () => {
  assert.deepEqual(summaryLine(sumIn({ confidence: 71.4 }), ts).conf, { prefix: 'Plant confidence ', score: '71', suffix: '' });
  assert.equal(summaryLine(sumIn({ confidence: null }), ts).conf, null);
  assert.equal(summaryLine(sumIn({ confidence: NaN }), ts).conf, null);
});

test('summaryLine: no plant says only the select-a-plant message', () => {
  assert.deepEqual(summaryLine(sumIn({ hasPlant: false }), ts), { text: 'Select a plant', conf: null });
});

test('summaryLine never uses the words points, pts, exact or estimate', () => {
  const s = summaryLine(sumIn({ alerts: [al('a', 'err', '1', '2'), al('b', 'warn', '3')] }), ts);
  assert.doesNotMatch(`${s.text} ${s.conf?.prefix}`, /points|pts|exact|estimate/i);
});

test('windowSummary: All alerts and empty profiles read as the whole horizon', () => {
  assert.equal(windowSummary(ALL_ALERTS_PROFILE, t), 'Showing every alert in the horizon');
  assert.equal(windowSummary(null, t), 'Showing every alert in the horizon');
});

test('windowSummary: a single rule renders types, day window and severity', () => {
  const s = windowSummary(prof([rule({ types: ['overlap', 'overload'], dayFrom: 0, dayTo: 7, minSev: 'err' })]), t);
  assert.equal(s, 'Order overlap, Overload · D0–7 · errors only');
});

test('windowSummary: no day bounds reads "any day"; many types collapse to categories; rules are joined', () => {
  const many = rule({ types: ['overlap', 'tool-conflict', 'overload'], minSev: 'warn' });
  const s = windowSummary(prof([many, rule({ types: ['overlap'], dayFrom: 8, dayTo: null })]), t);
  assert.equal(s, 'Capacity, Scheduling conflicts · any day · warnings and errors | Order overlap · D8–… · all severities');
});

test('viewFor: stored choice wins, else Machine + the profile ranking, junk is ignored', () => {
  assert.deepEqual(viewFor('p1', null, prof([], 'time')), { groupBy: 'line', sort: 'time' });
  assert.deepEqual(viewFor('p1', { p1: { groupBy: 'day', sort: 'time' } }, prof([], 'impact')), { groupBy: 'day', sort: 'time' });
  assert.deepEqual(viewFor('p1', { p1: { groupBy: 'bogus', sort: 7 } }, prof([], 'orders')), { groupBy: 'line', sort: 'impact' });
  assert.deepEqual(viewFor('p2', { p1: { groupBy: 'category', sort: 'time' } }, null), { groupBy: 'line', sort: 'impact' });
  assert.deepEqual(viewFor('__all__', null, ALL_ALERTS_PROFILE), { groupBy: 'line', sort: 'impact' });
});

test('viewFor: a stored severity / orders sort reads as impact, even when the profile ranks by time', () => {
  assert.equal(viewFor('p1', { p1: { sort: 'severity' } }, prof([], 'time')).sort, 'impact');
  assert.equal(viewFor('p1', { p1: { sort: 'orders' } }, prof([], 'time')).sort, 'impact');
});

test('viewFor: a stored groupBy survives without a stored sort, and the profile ranking time gives Date', () => {
  assert.deepEqual(viewFor('p1', { p1: { groupBy: 'category' } }, prof([], 'time')), { groupBy: 'category', sort: 'time' });
});

test('MONITOR_GROUP_BYS lists Machine first and MONITOR_SORTS only Priority and Date', () => {
  assert.equal(MONITOR_GROUP_BYS[0], 'line');
  assert.deepEqual([...MONITOR_GROUP_BYS].sort(), ['category', 'day', 'line', 'none', 'order', 'type']);
  assert.deepEqual(MONITOR_SORTS, ['impact', 'time']);
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
