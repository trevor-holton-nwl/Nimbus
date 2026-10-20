// Tests for frontend/alert-monitor/alert-monitor-model.mts — the pure KPI / summary / view helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kpiSummary, windowSummary, viewFor, visibleAlertsFor, horizonAlerts, emptyStateFor,
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

test('kpiSummary counts severities, distinct orders and the horizon in days', () => {
  const matched = [
    { id: 'a', sev: 'err', type: 'overlap', taskId: '1' },
    { id: 'b', sev: 'warn', type: 'overlap', taskId: '1' },
    { id: 'c', sev: 'warn', type: 'late', taskId: '2' },
    { id: 'd', sev: 'warn', type: 'overload' },
  ];
  const k = kpiSummary(matched, new Array(9).fill({ id: 'x', sev: 'warn', type: 'late' }), 4320, 71.5, 3);
  assert.deepEqual(k, { matched: 4, total: 9, days: 3, errors: 1, warnings: 3, orders: 2, confidence: 71.5, confidenceWindowAlerts: 3 });
});

test('kpiSummary tolerates a missing horizon and confidence', () => {
  const k = kpiSummary([], [], null, undefined);
  assert.equal(k.days, null);
  assert.equal(k.confidence, null);
  assert.equal(k.matched, 0);
  assert.equal(kpiSummary([], [], 0, NaN).days, null);
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

test('viewFor: stored choice wins, else category + the profile ranking, junk is ignored', () => {
  assert.deepEqual(viewFor('p1', null, prof([], 'time')), { groupBy: 'category', sort: 'time' });
  assert.deepEqual(viewFor('p1', { p1: { groupBy: 'line', sort: 'severity' } }, prof([], 'time')), { groupBy: 'line', sort: 'severity' });
  assert.deepEqual(viewFor('p1', { p1: { groupBy: 'bogus', sort: 7 } }, prof([], 'orders')), { groupBy: 'category', sort: 'orders' });
  assert.deepEqual(viewFor('p2', { p1: { groupBy: 'line', sort: 'severity' } }, null), { groupBy: 'category', sort: 'impact' });
  assert.deepEqual(viewFor('__all__', null, ALL_ALERTS_PROFILE), { groupBy: 'category', sort: 'impact' });
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
  assert.equal(emptyStateFor({ ...base, visibleCount: 0 }), 'no-alerts');   // matches exist but all acknowledged
});
