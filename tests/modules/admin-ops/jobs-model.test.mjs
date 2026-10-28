// Tests for frontend/admin-ops/jobs-model.mts: status map, preset <-> ScheduleIn (the server compiles the cron),
// cron prose, query builders (before_id cursors), plant wall clock, the job form validation / payload, step bar,
// result tiles and the 7-day strip. Pure: no DOM, no Store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  statusBadgeClass, statusBadgeHtml, isActiveRun, recurrenceToScheduleIn, scheduleToRecurrence, cronProse, isValidCronShape, parseTime,
  recurrenceText, buildJobsQuery, buildRunsQuery, buildLogQuery, plantWall, stripOffset, dowLabelKey, durationText, stepSegments, resultTiles,
  weekStrip, addDays, isoDayKey, defaultJobForm, validateJobForm, buildJobPayload, jobToForm, defaultRecurrence,
} from '../../../frontend/admin-ops/jobs-model.mjs';

const EN = {
  'jobs.cron_daily': 'Every day at {{time}}', 'jobs.cron_weekdays': 'Weekdays at {{time}}', 'jobs.cron_weekly': 'Every {{days}} at {{time}}',
  'jobs.cron_monthly': 'Day {{dom}} of every month at {{time}}', 'jobs.cron_hourly': 'Every hour at minute {{m}}',
  'jobs.cron_every_minutes': 'Every {{n}} minutes', 'jobs.cron_every_hours': 'Every {{n}} hours at minute {{m}}',
  'jobs.dow_0': 'Sun', 'jobs.dow_1': 'Mon', 'jobs.dow_3': 'Wed', 'jobs.dow_5': 'Fri', 'jobs.dow_2': 'Tue',
  'jobs.no_schedule': 'No schedule', 'jobs.once_at': 'Once, {{when}}', 'jobs.status_failed': 'Failed',
};
const deps = {
  t: (k, v) => (EN[k] ?? k).replace(/\{\{(\w+)\}\}/g, (_, n) => String(v?.[n])),
  esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
};

test('status badges use existing classes only, and unknown statuses fall back to muted', () => {
  assert.equal(statusBadgeClass('succeeded'), 'badge-ok');
  assert.equal(statusBadgeClass('warning'), 'badge-warn');
  assert.equal(statusBadgeClass('failed'), 'badge-err');
  assert.equal(statusBadgeClass('running'), 'badge-info');
  for (const s of ['scheduled', 'cancelled', 'skipped', 'whatever', undefined]) assert.equal(statusBadgeClass(s), 'badge-muted');
  assert.match(statusBadgeHtml('failed', deps), /badge-err[^>]*>Failed</, 'text label always shown');
  assert.equal(statusBadgeHtml('', deps), '');
  assert.equal(isActiveRun('running'), true);
  assert.equal(isActiveRun('succeeded'), false);
});

test('status badge escapes an unknown status instead of injecting it', () => {
  assert.doesNotMatch(statusBadgeHtml('<img onerror=x>', deps), /<img/);
});

test('recurrenceToScheduleIn: preset kinds with only the fields they read (the server compiles the cron)', () => {
  const base = defaultRecurrence();
  assert.deepEqual(recurrenceToScheduleIn(base), { kind: 'daily', time_of_day: '08:00' });
  assert.deepEqual(recurrenceToScheduleIn({ ...base, preset: 'weekdays', time: '17:45' }), { kind: 'weekdays', time_of_day: '17:45' });
  assert.deepEqual(recurrenceToScheduleIn({ ...base, preset: 'weekly', time: '06:05', days: [4, 0, 0, 2] }), { kind: 'weekly', time_of_day: '06:05', days_of_week: [0, 2, 4] });
  assert.deepEqual(recurrenceToScheduleIn({ ...base, preset: 'monthly', dom: 15 }), { kind: 'monthly', time_of_day: '08:00', day_of_month: 15 });
  assert.deepEqual(recurrenceToScheduleIn({ ...base, preset: 'hourly', minute: 30 }), { kind: 'hourly', time_of_day: '00:30' });
  assert.deepEqual(recurrenceToScheduleIn({ ...base, preset: 'once', runAt: '2026-11-02T08:00' }), { kind: 'once', run_at: '2026-11-02T08:00' });
  assert.deepEqual(recurrenceToScheduleIn({ ...base, preset: 'cron', cron: '  0   8 * *  1-5 ' }), { kind: 'cron', cron_expr: '0 8 * * 1-5' });
});

test('parseTime and isValidCronShape', () => {
  assert.deepEqual(parseTime('08:00'), [8, 0]);
  assert.deepEqual(parseTime('8:05'), [8, 5]);
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('08:60'), null);
  assert.equal(parseTime(''), null);
  assert.equal(isValidCronShape('*/15 * * * *'), true);
  assert.equal(isValidCronShape('0 8 * * 1-5'), true);
  assert.equal(isValidCronShape('0 8 * *'), false);
  assert.equal(isValidCronShape('0 8 * * ; rm'), false);
});

test('scheduleToRecurrence reads the stored preset fields back (days 0 = Monday) and round-trips', () => {
  const daily = scheduleToRecurrence({ kind: 'daily', time_of_day: '08:00', cron_expr: '0 8 * * *' });
  assert.deepEqual([daily.preset, daily.time], ['daily', '08:00']);
  assert.equal(scheduleToRecurrence({ kind: 'weekdays', time_of_day: '7:05' }).time, '07:05');
  const wk = scheduleToRecurrence({ kind: 'weekly', time_of_day: '06:05', days_of_week: [0, 2, 4] });
  assert.equal(wk.preset, 'weekly'); assert.deepEqual(wk.days, [0, 2, 4]); assert.equal(wk.time, '06:05');
  const mo = scheduleToRecurrence({ kind: 'monthly', time_of_day: '08:00', day_of_month: 15 });
  assert.equal(mo.preset, 'monthly'); assert.equal(mo.dom, 15);
  const hr = scheduleToRecurrence({ kind: 'hourly', time_of_day: '00:30' });
  assert.equal(hr.preset, 'hourly'); assert.equal(hr.minute, 30);
  assert.equal(scheduleToRecurrence({ kind: 'cron', cron_expr: '*/15 * * * *' }).cron, '*/15 * * * *');
  assert.equal(scheduleToRecurrence({ kind: 'mystery', cron_expr: '1 2 3 4 5' }).preset, 'cron');
  assert.equal(scheduleToRecurrence(null).preset, 'daily');
  for (const s of [{ kind: 'daily', time_of_day: '08:00' }, { kind: 'weekly', time_of_day: '06:05', days_of_week: [0, 2, 4] }, { kind: 'monthly', time_of_day: '08:00', day_of_month: 15 }, { kind: 'hourly', time_of_day: '00:30' }]) {
    assert.deepEqual(recurrenceToScheduleIn(scheduleToRecurrence(s)), s);
  }
});

test('cronProse phrases the supported shapes and returns null for the rest', () => {
  assert.equal(cronProse('0 8 * * *', deps), 'Every day at 08:00');
  assert.equal(cronProse('0 8 * * mon,wed', deps), null, 'a day-of-week cron falls back to the raw expression');
  assert.equal(cronProse('0 8 15 * *', deps), 'Day 15 of every month at 08:00');
  assert.equal(cronProse('30 * * * *', deps), 'Every hour at minute 30');
  assert.equal(cronProse('*/15 * * * *', deps), 'Every 15 minutes');
  assert.equal(cronProse('10 */6 * * *', deps), 'Every 6 hours at minute 10');
  assert.equal(cronProse('0 8 * 6 *', deps), null);
  assert.equal(cronProse('bogus', deps), null);
  assert.equal(cronProse('', deps), null);
  assert.equal(cronProse('0 17 * * *', { ...deps, fmtTime: (h, m) => `${h % 12 || 12}:${String(m).padStart(2, '0')} PM` }), 'Every day at 5:00 PM', 'viewer time format injected');
});

test('recurrenceText: preset prose from the stored fields (0 = Monday), raw cron fallback, once, none', () => {
  const fmt = iso => `<${iso}>`;
  assert.equal(recurrenceText(null, deps, fmt), 'No schedule');
  assert.equal(recurrenceText({ kind: 'daily', time_of_day: '08:00' }, deps, fmt), 'Every day at 08:00');
  assert.equal(recurrenceText({ kind: 'weekdays', time_of_day: '08:00' }, deps, fmt), 'Weekdays at 08:00');
  assert.equal(recurrenceText({ kind: 'weekly', time_of_day: '06:30', days_of_week: [4, 0, 2] }, deps, fmt), 'Every Mon, Wed, Fri at 06:30');
  assert.equal(recurrenceText({ kind: 'monthly', time_of_day: '08:00', day_of_month: 15 }, deps, fmt), 'Day 15 of every month at 08:00');
  assert.equal(recurrenceText({ kind: 'hourly', time_of_day: '00:30' }, deps, fmt), 'Every hour at minute 30');
  assert.equal(recurrenceText({ kind: 'cron', cron_expr: '0 8 * * *' }, deps, fmt), 'Every day at 08:00');
  assert.equal(recurrenceText({ kind: 'cron', cron_expr: '0 8 * 6 *' }, deps, fmt), '0 8 * 6 *');
  assert.equal(recurrenceText({ kind: 'once', run_at: '2026-11-02T08:00:00' }, deps, fmt), 'Once, <2026-11-02T08:00:00>');
  assert.equal(dowLabelKey(0), 'jobs.dow_1', 'Monday');
  assert.equal(dowLabelKey(6), 'jobs.dow_0', 'Sunday');
});

test('query builders: encode, drop empties, clamp limit, before_id cursor, job_type name', () => {
  assert.equal(buildJobsQuery({}), '?limit=50');
  assert.equal(buildJobsQuery({ plant: '1008', q: ' a b&c ', status: 'failed', type: 'optimizer.plant', limit: 20, beforeId: 40 }), '?plant=1008&q=a%20b%26c&status=failed&job_type=optimizer.plant&before_id=40&limit=20');
  assert.equal(buildJobsQuery({ limit: 9999 }), '?limit=200');
  assert.doesNotMatch(buildJobsQuery({ plant: 'P' }), /offset/);
  assert.equal(buildRunsQuery({ plant: 'P1', beforeId: 120 }), '?plant=P1&before_id=120&limit=50');
  assert.equal(buildRunsQuery({ jobId: 7 }), '?job_id=7&limit=50');
  assert.equal(buildRunsQuery({}), '?limit=50');
  assert.equal(buildLogQuery({}), '?after_seq=0');
  assert.equal(buildLogQuery({ afterSeq: 17, level: 'warn' }), '?after_seq=17&level=warn');
  assert.equal(buildLogQuery({ afterSeq: 3, level: 'all' }), '?after_seq=3');
});

test('plantWall: an instant is shown on the plant wall clock (DST aware); naive and offset-free values pass through', () => {
  assert.equal(plantWall('2026-10-29T12:00:00+00:00', 'America/New_York'), '2026-10-29T08:00:00', 'EDT');
  assert.equal(plantWall('2026-11-02T13:00:00+00:00', 'America/New_York'), '2026-11-02T08:00:00', 'EST after fall-back');
  assert.equal(plantWall('2026-10-29T12:00:00Z', 'Asia/Tokyo'), '2026-10-29T21:00:00');
  assert.equal(plantWall('2026-10-29T08:00:00', 'Asia/Tokyo'), '2026-10-29T08:00:00', 'naive is already wall clock');
  assert.equal(plantWall('2026-10-29T12:00:00+00:00', ''), '2026-10-29T12:00:00+00:00', 'no zone known: left for the viewer zone');
  assert.equal(plantWall('2026-10-29T12:00:00+00:00', 'Not/AZone'), '2026-10-29T12:00:00+00:00');
  assert.equal(plantWall(null, 'UTC'), '');
  assert.equal(stripOffset('2026-10-30T08:00:00-04:00'), '2026-10-30T08:00:00');
  assert.equal(stripOffset('2026-10-30T08:00:00'), '2026-10-30T08:00:00');
});

test('durationText is compact and tolerant', () => {
  assert.equal(durationText(850), '850 ms');
  assert.equal(durationText(4200), '4.2 s');
  assert.equal(durationText(42000), '42 s');
  assert.equal(durationText(216000), '3 min 36 s');
  assert.equal(durationText(3900000), '1 h 05 min');
  assert.equal(durationText(null), '');
  assert.equal(durationText(-1), '');
});

test('stepSegments: proportional, zero-duration dropped, minimum visible width', () => {
  const segs = stepSegments([{ step: 'load', duration_ms: 1000 }, { step: 'search', duration_ms: 99000 }, { step: 'noop', duration_ms: 0 }]);
  assert.deepEqual(segs.map(s => s.step), ['load', 'search']);
  assert.equal(segs[0].pct, 2, 'a 1 % step is lifted to the 2 % floor');
  assert.equal(segs[1].pct, 99);
  assert.deepEqual(stepSegments(null), []);
  assert.deepEqual(stepSegments([{ step: 'x', duration_ms: 0 }]), []);
});

test('resultTiles keeps the fixed order and omits counts the run did not report', () => {
  assert.deepEqual(resultTiles({ dropped: 2, late: 0, applied: 14 }).map(t => [t.key, t.value]), [['late', 0], ['applied', 14], ['dropped', 2]]);
  assert.deepEqual(resultTiles(null), []);
  assert.deepEqual(resultTiles({ late: null, moved: undefined }), []);
});

test('weekStrip buckets naive ISO runs into 7 plant days from the text, ignoring the rest', () => {
  assert.equal(isoDayKey('2026-10-29T08:00:00'), '2026-10-29');
  assert.equal(addDays('2026-10-30', 3), '2026-11-02');
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  const days = weekStrip([
    { at: '2026-10-29T08:00:00' }, { at: '2026-10-29T06:00:00' }, { at: '2026-11-04T08:00:00' }, { at: '2026-11-05T08:00:00' }, { at: '2026-10-28T23:00:00' },
  ], '2026-10-29');
  assert.equal(days.length, 7);
  assert.equal(days[0].day, '2026-10-29');
  assert.deepEqual(days[0].runs.map(r => r.at), ['2026-10-29T06:00:00', '2026-10-29T08:00:00'], 'sorted within a day');
  assert.equal(days[6].day, '2026-11-04');
  assert.equal(days[6].runs.length, 1, 'day 7 included, day 8 and yesterday dropped');
});

const ok = { isAdmin: true, plants: null };
const good = () => ({ ...defaultJobForm('1008'), name: 'Morning optimize' });

test('defaults: 08:00 daily, Exhaustive, apply automatically (owner decision)', () => {
  const f = defaultJobForm('1008');
  assert.equal(f.recur.preset, 'daily'); assert.equal(f.recur.time, '08:00');
  assert.equal(f.search, 'exhaustive'); assert.equal(f.result, 'apply');
  assert.deepEqual(validateJobForm(good(), ok), {});
});

test('validateJobForm: name, plant scope, result gate, recurrence fields and validity window', () => {
  assert.equal(validateJobForm({ ...good(), name: '  ' }, ok).name, 'jobs.err_name');
  assert.equal(validateJobForm({ ...good(), name: 'x'.repeat(81) }, ok).name, 'jobs.err_name_long');
  assert.equal(validateJobForm({ ...good(), plant: '' }, ok).plant, 'jobs.err_plant');
  assert.equal(validateJobForm(good(), { isAdmin: true, plants: ['2000'] }).plant, 'jobs.err_plant_scope');
  assert.equal(validateJobForm(good(), { isAdmin: false, plants: null }).result, 'jobs.err_apply_admin');
  assert.equal(validateJobForm({ ...good(), result: 'propose' }, { isAdmin: false, plants: null }).result, undefined);
  assert.equal(validateJobForm({ ...good(), mode: 'remove-backlog' }, ok).mode, 'jobs.err_mode');
  assert.equal(validateJobForm({ ...good(), mode: 'due-date' }, ok).mode, 'jobs.err_mode', 'the backend names are due_date / min_changeover / spt');
  const r = (patch) => ({ ...good(), recur: { ...defaultRecurrence(), ...patch } });
  assert.equal(validateJobForm(r({ time: '' }), ok).time, 'jobs.err_time');
  assert.equal(validateJobForm(r({ preset: 'weekly', days: [] }), ok).days, 'jobs.err_days');
  assert.equal(validateJobForm(r({ preset: 'monthly', dom: 0 }), ok).dom, 'jobs.err_dom');
  assert.equal(validateJobForm(r({ preset: 'hourly', minute: 99 }), ok).minute, 'jobs.err_minute');
  assert.equal(validateJobForm(r({ preset: 'cron', cron: 'nope' }), ok).cron, 'jobs.err_cron');
  assert.equal(validateJobForm(r({ preset: 'once', runAt: '' }), ok).runAt, 'jobs.err_run_at');
  assert.deepEqual(validateJobForm(r({ preset: 'once', runAt: '2026-11-02T08:00' }), ok), {});
  assert.equal(validateJobForm({ ...good(), validFrom: '2026-11-10', validUntil: '2026-11-01' }, ok).validity, 'jobs.err_validity');
});

test('buildJobPayload: backend job params (apply_mode explicit) and a preset ScheduleIn, trimmed name, no zone', () => {
  const p = buildJobPayload({ ...good(), name: '  Morning optimize ', validFrom: '2026-11-01' });
  assert.deepEqual(p.job, {
    name: 'Morning optimize', plant: '1008', job_type: 'optimizer.plant',
    params: { mode: 'due_date', search: 'exhaustive', respect_firmed: true, apply_mode: 'apply' },
  });
  assert.deepEqual(p.schedule, { kind: 'daily', time_of_day: '08:00', valid_from: '2026-11-01', valid_until: null, skip_if_running: true });
  const once = buildJobPayload({ ...good(), recur: { ...defaultRecurrence(), preset: 'once', runAt: '2026-11-02T08:00' } });
  assert.deepEqual([once.schedule.kind, once.schedule.cron_expr, once.schedule.run_at], ['once', undefined, '2026-11-02T08:00']);
  assert.doesNotMatch(JSON.stringify(p), /Z"|\+\d\d:\d\d|timezone/, 'no zone suffix, offset or timezone field');
  assert.equal(buildJobPayload({ ...good(), result: 'propose' }).job.params.apply_mode, 'propose');
});

test('jobToForm restores a saved job (preset schedule, once, params) for Edit and Duplicate', () => {
  const f = jobToForm({
    name: 'N', plant: '1008', job_type: 'optimizer.plant',
    params: { mode: 'spt', search: 'normal', respect_firmed: false, apply_mode: 'propose' },
    schedule: { kind: 'weekly', time_of_day: '06:05', days_of_week: [0, 2, 4], cron_expr: '5 6 * * mon,wed,fri', valid_until: '2026-12-31T00:00:00', skip_if_running: false },
  });
  assert.equal(f.mode, 'spt'); assert.equal(f.search, 'normal'); assert.equal(f.respectFirmed, false); assert.equal(f.result, 'propose');
  assert.equal(f.recur.preset, 'weekly'); assert.deepEqual(f.recur.days, [0, 2, 4]); assert.equal(f.validUntil, '2026-12-31'); assert.equal(f.skipIfRunning, false);
  const once = jobToForm({ name: 'O', plant: 'P', schedule: { kind: 'once', run_at: '2026-11-02T08:00:00' } });
  assert.equal(once.recur.preset, 'once'); assert.equal(once.recur.runAt, '2026-11-02T08:00');
  assert.equal(jobToForm({ name: 'bare', plant: 'P' }).recur.preset, 'daily');
});
