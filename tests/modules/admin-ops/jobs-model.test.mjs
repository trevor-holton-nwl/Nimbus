// Tests for frontend/admin-ops/jobs-model.mts: status map, preset <-> ScheduleIn (the server compiles the cron),
// cron prose, query builders (before_id cursors), plant wall clock, the job form validation / payload, step bar,
// result tiles and the 7-day strip. Pure: no DOM, no Store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  statusBadgeClass, statusBadgeHtml, isActiveRun, recurrenceToScheduleIn, scheduleToRecurrence, cronProse, isValidCronShape, parseTime,
  recurrenceText, buildJobsQuery, buildRunsQuery, buildLogQuery, plantWall, stripOffset, dowLabelKey, durationText, stepSegments, resultTiles,
  weekStrip, addDays, isoDayKey, mergeRuns, stripCompleteThrough, LOG_PAGE, defaultJobForm, validateJobForm, buildJobPayload, jobToForm, defaultRecurrence,
  displayStatus, runStatusHtml, errorKindOf, elapsedText, firstErrorIndex, lineDataText, errorsToText, elapsedMs, healthTiles, heartbeatState, ageText,
  shouldPollJobs, runSequential, deltaText, isDryRun, tzShort, isLongerThanUsual, RUN_STATUSES, JOB_RESULTS,
  resultOf, seedParams, typeGroups, findType, hasApplyMode, paramLabel, enumLabel, paramHint, typeLabel, validateParams, defaultWindowUi,
  uiToWindow, windowToUi, validateWindowUi, artifactTiles, isReportRun, cellText, windowLine, sectionTitle, columnLabel, isReportType,
  plural, targetsLossless, targetRowCount, TARGET_ROWS_MAX, buildTargetRows, targetsLabel, filterPlants, targetsPreviewText, targetsToForm, batchTiles, buildBatchesQuery, timeZoneList, TARGET_MODES, TZ_MODES,
} from '../../../frontend/admin-ops/jobs-model.mjs';
import { TYPES, OPT, byKey } from './jobs-types-fixture.mjs';

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

test('a new job is seeded from the type\'s own param defaults, then the server defaults; the result defaults to apply', () => {
  const seeded = defaultJobForm('1008', 'optimizer.plant', { mode: 'spt', search: 'normal', respect_firmed: false, apply_mode: 'propose' }, OPT);
  assert.deepEqual(seeded.params, { mode: 'spt', search: 'normal', respect_firmed: false, apply_mode: 'propose' });
  assert.deepEqual(defaultJobForm('1008', 'optimizer.plant', null, OPT).params, { mode: 'due_date', search: 'exhaustive', respect_firmed: true, apply_mode: 'apply' });
  assert.deepEqual(defaultJobForm('1008', 'optimizer.plant').params, {}, 'no hardcoded optimizer params: without metadata the server fills its own defaults');
  assert.equal(resultOf(defaultJobForm('1008', 'optimizer.plant').params), 'apply');
  assert.equal(seedParams(byKey('report.late_orders'), null).horizon.rolling.to_offset, 14);
});

test('mergeRuns folds page 1 into loaded pages (newest first, later pages kept); buildLogQuery can ask for a big page', () => {
  const loaded = [{ id: 90, s: 'x' }, { id: 60, s: 'a' }, { id: 59, s: 'a' }];
  const merged = mergeRuns(loaded, [{ id: 95, s: 'new' }, { id: 90, s: 'done' }]);
  assert.deepEqual(merged.map(r => [r.id, r.s]), [[95, 'new'], [90, 'done'], [60, 'a'], [59, 'a']]);
  assert.equal(buildLogQuery({ afterSeq: 0, limit: LOG_PAGE }), '?after_seq=0&limit=2000');
});

test('stripCompleteThrough: null while the list is short of its cap, else the last returned day', () => {
  const runs = [{ at: '2026-11-02T08:00:00' }, { at: '2026-11-03T08:00:00' }, { at: '2026-11-03T20:00:00' }];
  assert.equal(stripCompleteThrough(runs, 4), null);
  assert.equal(stripCompleteThrough(runs, 3), '2026-11-03');
  assert.equal(stripCompleteThrough([], 0), null);
});

const ok = { isAdmin: true, plants: null, meta: OPT };
const good = () => ({ ...defaultJobForm('1008', 'optimizer.plant', null, OPT), name: 'Morning optimize' });
const withParams = (patch) => ({ ...good(), params: { ...good().params, ...patch } });

test('defaults: 08:00 daily, Exhaustive, and the result is APPLY (a Dry run is the alternative)', () => {
  const f = defaultJobForm('1008', 'optimizer.plant', null, OPT);
  assert.equal(f.recur.preset, 'daily'); assert.equal(f.recur.time, '08:00');
  assert.equal(f.params.search, 'exhaustive'); assert.equal(resultOf(f.params), 'apply');
  assert.deepEqual(validateJobForm(good(), ok), {});
});

test('validateJobForm: name, plant scope, result gate, recurrence fields and validity window', () => {
  assert.equal(validateJobForm({ ...good(), name: '  ' }, ok).name, 'jobs.err_name');
  assert.equal(validateJobForm({ ...good(), name: 'x'.repeat(81) }, ok).name, 'jobs.err_name_long');
  assert.equal(validateJobForm({ ...good(), plant: '' }, ok).plant, 'jobs.err_plant');
  assert.equal(validateJobForm(good(), { isAdmin: true, plants: ['2000'] }).plant, 'jobs.err_plant_scope');
  const nonAdmin = { isAdmin: false, plants: null, meta: OPT };
  assert.equal(validateJobForm(withParams({ apply_mode: 'apply' }), nonAdmin).result, 'jobs.err_apply_admin');
  assert.equal(validateJobForm(good(), nonAdmin).result, 'jobs.err_apply_admin', 'jobs are admin-only: the default (apply) needs an admin');
  assert.equal(validateJobForm(withParams({ apply_mode: 'propose' }), nonAdmin).result, undefined, 'a dry run changes nothing');
  assert.equal(validateJobForm(withParams({ apply_mode: 'yolo' }), ok).result, 'jobs.err_result');
  assert.equal(validateJobForm(withParams({ mode: 'remove-backlog' }), ok).params.mode, 'jobs.err_param_enum');
  assert.equal(validateJobForm(withParams({ mode: 'due-date' }), ok).params.mode, 'jobs.err_param_enum', 'the backend names are due_date / min_changeover / spt');
  assert.equal(validateJobForm(withParams({ search: 'forever' }), ok).params.search, 'jobs.err_param_enum');
  assert.equal('params' in validateJobForm(good(), ok), false, 'a valid form carries no params key');
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
  const p = buildJobPayload({ ...withParams({ apply_mode: 'apply' }), name: '  Morning optimize ', validFrom: '2026-11-01' });
  assert.deepEqual(p.job, {
    name: 'Morning optimize', plant: '1008', job_type: 'optimizer.plant',
    params: { mode: 'due_date', search: 'exhaustive', respect_firmed: true, apply_mode: 'apply' }, targets: [], fan_out: null,
  });
  assert.deepEqual(p.schedule, { kind: 'daily', time_of_day: '08:00', valid_from: '2026-11-01', valid_until: null, skip_if_running: true, tz_mode: 'plant', fixed_timezone: null, options: null });
  const once = buildJobPayload({ ...good(), recur: { ...defaultRecurrence(), preset: 'once', runAt: '2026-11-02T08:00' } });
  assert.deepEqual([once.schedule.kind, once.schedule.cron_expr, once.schedule.run_at], ['once', undefined, '2026-11-02T08:00']);
  assert.doesNotMatch(JSON.stringify(p), /Z"|\+\d\d:\d\d|"timezone"/, 'no zone suffix, offset or timezone field (the server owns the zone; only tz_mode travels)');
  assert.equal(buildJobPayload(withParams({ apply_mode: 'propose' })).job.params.apply_mode, 'propose');
  assert.equal('undefined' in buildJobPayload({ ...good(), params: { a: undefined, b: 1 } }).job.params, false);
});

test('jobToForm restores a saved job (preset schedule, once, params) for Edit and Duplicate', () => {
  const f = jobToForm({
    name: 'N', plant: '1008', job_type: 'optimizer.plant',
    params: { mode: 'spt', search: 'normal', respect_firmed: false, apply_mode: 'propose' },
    schedule: { kind: 'weekly', time_of_day: '06:05', days_of_week: [0, 2, 4], cron_expr: '5 6 * * mon,wed,fri', valid_until: '2026-12-31T00:00:00', skip_if_running: false },
  });
  assert.deepEqual(f.params, { mode: 'spt', search: 'normal', respect_firmed: false, apply_mode: 'propose' });
  assert.equal(f.recur.preset, 'weekly'); assert.deepEqual(f.recur.days, [0, 2, 4]); assert.equal(f.validUntil, '2026-12-31'); assert.equal(f.skipIfRunning, false);
  const once = jobToForm({ name: 'O', plant: 'P', schedule: { kind: 'once', run_at: '2026-11-02T08:00:00' } });
  assert.equal(once.recur.preset, 'once'); assert.equal(once.recur.runAt, '2026-11-02T08:00');
  assert.equal(jobToForm({ name: 'bare', plant: 'P' }).recur.preset, 'daily');
  const saved = jobToForm({ name: 'N', plant: 'P', job_type: 'optimizer.plant', params: { search: 'normal' } }, OPT);
  assert.deepEqual(saved.params, { mode: 'due_date', search: 'normal', respect_firmed: true, apply_mode: 'apply' }, 'a saved job keeps its own values; missing keys take the type default');
});

// ---- W2: generic params, types, DateWindow, report artifact -----------------------------------------------------------
test('typeGroups: Optimization then Reports, each only when it has types; findType and hasApplyMode', () => {
  const g = typeGroups(TYPES);
  assert.deepEqual(g.map(x => [x.kind, x.labelKey]), [['action', 'jobs.group_optimization'], ['report', 'jobs.group_reports'], ['chain', 'jobs.group_chains']]);
  assert.deepEqual(g[1].types.map(x => x.key), ['report.what_changed', 'report.late_orders', 'report.missing_master_data', 'report.coverage', 'report.distribution']);
  assert.deepEqual(typeGroups(TYPES.filter(x => x.kind === 'report')).map(x => x.kind), ['report']);
  assert.equal(findType(TYPES, 'report.coverage').kind, 'report');
  assert.equal(hasApplyMode(OPT), true, 'the Result control shows for an action type with apply_mode');
  assert.equal(hasApplyMode(byKey('report.late_orders')), false);
  assert.equal(hasApplyMode(undefined), false);
});

test('labels: a translation wins, an optimizer alias keeps the old strings, else the server title or the raw value', () => {
  const dict = { 'jobs.f_mode': 'Mode', 'jobs.mode_spt': 'SPT', 'jobs.p.report.late_orders.horizon': 'Orders finishing in', 'jobs.search_note': 'Exhaustive takes minutes' };
  const d = { t: k => dict[k] ?? k };
  const mode = OPT.params.find(p => p.key === 'mode'); const hz = byKey('report.late_orders').params[0]; const top = byKey('report.what_changed').params[2];
  assert.equal(paramLabel(mode, d), 'Mode', 'alias jobs.f_mode');
  assert.equal(enumLabel(mode, 'spt', d), 'SPT');
  assert.equal(enumLabel(mode, 'due_date', d), 'due_date', 'no translation: the raw value');
  assert.equal(paramLabel(hz, d), 'Orders finishing in');
  assert.equal(paramLabel(top, d), 'Top N', 'no translation: the schema title');
  assert.equal(paramHint(OPT.params.find(p => p.key === 'search'), d), 'Exhaustive takes minutes', 'the Exhaustive note survives as the search hint');
  assert.equal(typeLabel({ key: 'report.late_orders', label: 'Late-order digest' }, d), 'Late-order digest');
});

test('validateParams: numbers, ranges, enums, multi-select and windows from the served metadata', () => {
  const late = byKey('report.late_orders'); const wc = byKey('report.what_changed'); const cov = byKey('report.coverage');
  assert.deepEqual(validateParams(late.params, late.defaults), {});
  assert.equal(validateParams(late.params, { ...late.defaults, min_days_late: 400 }).min_days_late, 'jobs.err_param_range');
  assert.equal(validateParams(late.params, { ...late.defaults, min_days_late: -1 }).min_days_late, 'jobs.err_param_range');
  assert.equal(validateParams(late.params, { ...late.defaults, min_days_late: NaN }).min_days_late, 'jobs.err_param_num');
  assert.equal(validateParams(wc.params, { ...wc.defaults, top_n: 2.5 }).top_n, 'jobs.err_param_int');
  assert.equal(validateParams(wc.params, { ...wc.defaults, top_n: 201 }).top_n, 'jobs.err_param_range');
  assert.equal(validateParams(wc.params, { ...wc.defaults, top_n: null }).top_n, undefined, 'blank is fine when not required (the server default applies)');
  assert.equal(validateParams(cov.params, { sections: [] }).sections, 'jobs.err_param_pick');
  assert.equal(validateParams(cov.params, { sections: ['tools', 'bogus'] }).sections, 'jobs.err_param_enum');
  assert.deepEqual(validateParams(cov.params, { sections: ['setup'] }), {});
  assert.equal(validateParams(late.params, { ...late.defaults, horizon: { mode: 'fixed', fixed: { from: '2026-10-31', to: '2026-10-01' } } }).horizon, 'jobs.err_win_order');
  assert.equal(validateParams(late.params, { ...late.defaults, horizon: { mode: 'fixed', fixed: { from: '', to: '2026-10-01' } } }).horizon, 'jobs.err_win_dates');
});

const roll = (anchor, f, t, unit = 'day') => ({ mode: 'rolling', fixed: null, rolling: { anchor, from_offset: f, to_offset: t, unit } });

test('DateWindow presets round-trip through the picker and match the backend presets (windows.py)', () => {
  const cases = [
    [defaultWindowUi('older_than', 30), roll('start_of_day', -3650, -30)],
    [defaultWindowUi('last', 7), roll('start_of_day', -7, 1)],
    [defaultWindowUi('next', 14), roll('start_of_day', 0, 14)],
    [defaultWindowUi('since_last_success'), roll('last_success', 0, 0)],
    [defaultWindowUi('this_week'), roll('start_of_week', 0, 1, 'week')],
    [defaultWindowUi('this_month'), roll('start_of_month', 0, 1, 'month')],
  ];
  for (const [ui, win] of cases) {
    assert.deepEqual(uiToWindow(ui), win, ui.choice);
    const back = windowToUi(win);
    assert.equal(back.choice, ui.choice);
    if (['older_than', 'last', 'next'].includes(ui.choice)) assert.equal(back.n, ui.n);
  }
  const fixed = { mode: 'fixed', fixed: { from: '2026-10-01', to: '2026-10-31' }, rolling: null };
  assert.deepEqual(uiToWindow(windowToUi(fixed)), fixed);
  assert.equal(windowToUi(roll('now', -3, 0, 'month')).choice, 'custom', 'anything else is Custom');
  assert.equal(windowToUi(null).choice, 'last');
});

test('validateWindowUi: dates, N, offsets and order; last_success may end at 0 whatever it starts at', () => {
  const ui = (patch) => ({ ...defaultWindowUi(), ...patch });
  assert.equal(validateWindowUi(ui({ choice: 'last', n: 7 })), '');
  assert.equal(validateWindowUi(ui({ choice: 'last', n: 0 })), 'jobs.err_win_n');
  assert.equal(validateWindowUi(ui({ choice: 'older_than', n: 0 })), '');
  assert.equal(validateWindowUi(ui({ choice: 'next', n: 4000 })), 'jobs.err_win_n');
  assert.equal(validateWindowUi(ui({ choice: 'next', n: 1.5 })), 'jobs.err_win_n');
  assert.equal(validateWindowUi(ui({ choice: 'fixed', from: '2026-10-01', to: '2026-10-01' })), '');
  assert.equal(validateWindowUi(ui({ choice: 'fixed', from: '2026-10-01', to: '' })), 'jobs.err_win_dates');
  assert.equal(validateWindowUi(ui({ choice: 'custom', anchor: 'now', fromOffset: 2, toOffset: -1 })), 'jobs.err_win_order');
  assert.equal(validateWindowUi(ui({ choice: 'custom', anchor: 'last_success', fromOffset: 2, toOffset: -1 })), '');
  assert.equal(validateWindowUi(ui({ choice: 'custom', fromOffset: 5000, toOffset: 1 })), 'jobs.err_win_offset');
  assert.equal(validateWindowUi(ui({ choice: 'custom', anchor: 'tomorrow' })), 'jobs.err_win_offset');
  assert.equal(validateWindowUi(ui({ choice: 'custom', unit: 'year' })), 'jobs.err_win_offset');
  assert.equal(validateWindowUi(ui({ choice: 'since_last_success' })), '');
});

test('artifact helpers: row-count tiles keep the report\'s order, cells read plainly, the window line', () => {
  assert.deepEqual(artifactTiles({ row_counts: { counts: 12, top_orders: 0 } }), [{ key: 'counts', value: 12 }, { key: 'top_orders', value: 0 }]);
  assert.deepEqual(artifactTiles({}), []); assert.deepEqual(artifactTiles(null), []);
  assert.equal(isReportRun({ row_counts: { a: 1 } }), true); assert.equal(isReportRun({ late: 3 }), false); assert.equal(isReportRun(null), false);
  const d = { t: k => ({ 'jobs.a.yes': 'Yes', 'jobs.a.no': 'No', 'jobs.run_window': 'Window: {{label}}, plant time' }[k] ?? k) };
  assert.deepEqual([cellText(null, d), cellText(3, d), cellText(2.456, d), cellText('yes', d), cellText('no', d), cellText('x', d)], ['', '3', '2.46', 'Yes', 'No', 'x']);
  assert.equal(windowLine(null, d), '');
  assert.match(windowLine({ label: '2026-09-28 to 2026-10-28' }, { t: (k, v) => `Window: ${v.label}, plant time` }), /^Window: 2026-09-28 to 2026-10-28, plant time$/);
  assert.equal(sectionTitle({ key: 'counts', title: 'Changes' }, { t: k => k }), 'Changes', 'no translation: the server title');
  assert.equal(columnLabel({ key: 'x', label: 'Ex' }, { t: k => (k === 'jobs.a.col.x' ? 'Why' : k) }), 'Why');
});

// ---- W1: run status, health strip, error panel, log helpers, dry-run proposal --------------------------------------
test('SAP-style status model: a misfire shows as Missed, running has a static dot, text label always follows', () => {
  assert.deepEqual([...RUN_STATUSES], ['scheduled', 'running', 'succeeded', 'warning', 'failed', 'cancelled', 'skipped', 'missed']);
  assert.equal(displayStatus({ status: 'skipped', error: 'missed: fired after its grace time' }), 'missed');
  assert.equal(displayStatus({ status: 'skipped', error: 'previous run still running' }), 'skipped');
  assert.equal(displayStatus({ status: 'failed', error: 'missed: x' }), 'failed');
  assert.equal(statusBadgeClass('missed'), 'badge-warn');
  assert.match(statusBadgeHtml('running', deps), /<i class="job-dot" aria-hidden="true"><\/i>jobs\.status_running/);
  assert.doesNotMatch(statusBadgeHtml('failed', deps), /job-dot/);
  const skipped = runStatusHtml({ status: 'skipped', error: 'previous run still running' }, deps);
  assert.match(skipped, /jobs\.status_skipped/); assert.match(skipped, /previous run still running/, 'Skipped(reason)');
  assert.match(runStatusHtml({ status: 'skipped', error: 'missed: late' }, deps), /badge-warn[^>]*>jobs\.status_missed/);
  assert.doesNotMatch(runStatusHtml({ status: 'skipped', error: '<b>x</b>' }, deps), /<b>/, 'reason is escaped');
});

test('runs query carries the job type filter', () => {
  assert.equal(buildRunsQuery({ jobType: 'optimizer.plant' }), '?job_type=optimizer.plant&limit=50');
});

test('error kind: config, system and transient are recognised', () => {
  assert.equal(errorKindOf({ error_kind: 'transient' }), 'transient');
  assert.equal(errorKindOf({ error_kind: 'config' }), 'config');
  assert.equal(errorKindOf({ error_kind: 'system' }), 'system');
  assert.equal(errorKindOf({ error_kind: 'other' }), null);
  assert.equal(errorKindOf(null), null);
});

test('log helpers: elapsed from start, first error, collapsed data text, errors-only copy', () => {
  assert.equal(elapsedText('2026-10-29T12:00:03.200+00:00', '2026-10-29T12:00:00+00:00'), '+0:03.2');
  assert.equal(elapsedText('2026-10-29T12:03:09+00:00', '2026-10-29T12:00:00+00:00'), '+3:09.0');
  assert.equal(elapsedText('2026-10-29T11:59:00+00:00', '2026-10-29T12:00:00+00:00'), '+0:00.0', 'never negative');
  assert.equal(elapsedText(null, 'x'), '');
  const lines = [{ seq: 1, level: 'info', msg: 'a' }, { seq: 2, level: 'warn', msg: 'b' }, { seq: 3, level: 'error', msg: 'boom', data: { orders: ['A1'] } }, { seq: 4, level: 'error', msg: 'again' }];
  assert.equal(firstErrorIndex(lines), 2);
  assert.equal(firstErrorIndex(lines.slice(0, 2)), -1);
  assert.equal(lineDataText({}), null); assert.equal(lineDataText([]), null); assert.equal(lineDataText(null), null);
  assert.match(lineDataText({ orders: ['A1'] }), /"orders": \[\s+"A1"\s+\]/);
  const txt = errorsToText(lines, x => x);
  assert.match(txt, /ERROR boom/); assert.match(txt, /"A1"/); assert.match(txt, /ERROR again/); assert.doesNotMatch(txt, /WARN|INFO/);
});

test('elapsed of a run that has not ended counts to now; unstarted runs have none', () => {
  const now = Date.parse('2026-10-29T12:01:00+00:00');
  assert.equal(elapsedMs('2026-10-29T12:00:00+00:00', null, now), 60000);
  assert.equal(elapsedMs('2026-10-29T12:00:00+00:00', '2026-10-29T12:00:30+00:00', now), 30000);
  assert.equal(elapsedMs(null, null, now), null);
  assert.equal(isLongerThanUsual(43, [43]), true); assert.equal(isLongerThanUsual(42, [43]), false); assert.equal(isLongerThanUsual(1, null), false);
});

test('health tiles: Failed goes err and Missed warn only above zero; each tile names its filter', () => {
  const h = { running: 1, queued: 2, failed24h: 0, missed24h: 0, warning24h: 0, nextFire: null, scheduler: { ok: true, lastTickAt: null }, longerThanUsual: [] };
  const calm = healthTiles(h);
  assert.deepEqual(calm.map(x => x.key), ['running', 'queued', 'failed', 'missed', 'next']);
  assert.deepEqual(calm.map(x => x.tone), ['', '', '', '', '']);
  const hot = healthTiles({ ...h, failed24h: 3, missed24h: 1 });
  assert.deepEqual([hot[2].tone, hot[3].tone], ['err', 'warn']);
  assert.deepEqual([hot[2].status, hot[2].sinceHours, hot[3].status, hot[3].sinceHours], ['failed', 24, 'missed', 24]);
  assert.deepEqual([hot[0].status, hot[1].status, hot[4].tab], ['running', 'scheduled', 'upcoming']);
});

test('scheduler heartbeat: ok within 3 min, stale after, none before the first tick; age text is compact', () => {
  const now = Date.parse('2026-10-29T12:00:12+00:00');
  assert.deepEqual(heartbeatState({ ok: true, lastTickAt: '2026-10-29T12:00:00+00:00' }, now), { state: 'ok', ageS: 12 });
  assert.equal(heartbeatState({ ok: true, lastTickAt: '2026-10-29T11:56:00+00:00' }, now).state, 'stale', 'the viewer clock also says stale');
  assert.equal(heartbeatState({ ok: false, lastTickAt: '2026-10-29T12:00:00+00:00' }, now).state, 'stale', 'the server says stale');
  assert.equal(heartbeatState({ ok: false, lastTickAt: null }, now).state, 'none');
  assert.deepEqual([ageText(12), ageText(180), ageText(7200)], ['12 s', '3 min', '2 h']);
});

test('the list polls only while something is active', () => {
  const idle = { running: 0, queued: 0, failed24h: 0, missed24h: 0, warning24h: 0, nextFire: null, scheduler: { ok: true, lastTickAt: null }, longerThanUsual: [] };
  assert.equal(shouldPollJobs(idle, [{ last_run: { status: 'succeeded' } }, { last_run: null }]), false);
  assert.equal(shouldPollJobs({ ...idle, running: 1 }, []), true);
  assert.equal(shouldPollJobs({ ...idle, queued: 1 }, []), true);
  assert.equal(shouldPollJobs(null, [{ last_run: { status: 'running' } }]), true);
  assert.equal(shouldPollJobs(null, []), false);
});

test('bulk actions run one after another; a failure never stops the rest', async () => {
  const order = [];
  const res = await runSequential([1, 2, 3], async n => { order.push(n); if (n === 2) throw new Error('nope'); });
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(res, { ok: 2, failed: 1, firstError: 'nope' });
});

test('proposal helpers and the Apply / Dry run result modes', () => {
  assert.deepEqual([deltaText(4), deltaText(-1.5), deltaText(0), deltaText(null)], ['+4 h', '-1.5 h', '0 h', '']);
  assert.equal(isDryRun({ apply_mode: 'propose' }), true); assert.equal(isDryRun({ apply_mode: 'apply' }), false); assert.equal(isDryRun(null), false);
  assert.deepEqual([...JOB_RESULTS], ['apply', 'propose'], 'Apply is first and the default; propose is the stored value of Dry run');
});

test('tzShort reads the plant zone at the instant; blank zone gives nothing', () => {
  assert.match(tzShort('America/Chicago', '2026-07-01T12:00:00+00:00'), /CDT|GMT-5/);
  assert.match(tzShort('America/Chicago', '2026-01-01T12:00:00+00:00'), /CST|GMT-6/);
  assert.equal(tzShort('', 'x'), '');
});

test('cellText by column type: bool, date / datetime through the formatter, sentinel and code translation, notes with detail', () => {
  const tr = { 'jobs.a.yes': 'Yes', 'jobs.a.no': 'No', 'jobs.a.sentinel.plant_total': 'Plant total', 'jobs.a.val.reason.no_mp_row': 'No material-plant row',
    'jobs.a.val.value.planner': 'Planner edits', 'jobs.a.note.no_list': 'No list for {{detail}}' };
  const d = { t: (k, v) => (tr[k] ?? k).replace('{{detail}}', v?.detail ?? '') };
  const fmt = { datetime: s => `DT(${s})`, date: s => `D(${s})` };
  assert.equal(cellText('yes', d, { key: 'x', type: 'text' }), 'yes', 'yes/no words are only translated for bool (or untyped) columns');
  assert.equal(cellText('yes', d, { key: 'x', type: 'bool' }), 'Yes');
  assert.equal(cellText(false, d, { key: 'x', type: 'bool' }), 'No');
  assert.equal(cellText('2026-10-28T09:00:00', d, { key: 'f', type: 'datetime' }, fmt), 'DT(2026-10-28T09:00:00)');
  assert.equal(cellText('2026-10-28', d, { key: 'f', type: 'date' }, fmt), 'D(2026-10-28)');
  assert.equal(cellText('__plant_total__', d, { key: 'machine', type: 'text' }), 'Plant total');
  assert.equal(cellText('__unknown__', d, { key: 'machine', type: 'text' }), '__unknown__');
  assert.equal(cellText('no_mp_row', d, { key: 'reason', type: 'text' }), 'No material-plant row');
  assert.equal(cellText('planner', d, { key: 'value', type: 'text' }, undefined, ['category', 'planner', '', 3]), 'Planner edits');
  assert.equal(cellText('planner', d, { key: 'value', type: 'text' }, undefined, ['source', 'planner', '', 3]), 'planner', 'value is a code only on category rows');
  assert.equal(cellText('no_list', d, { key: 'code', type: 'text' }, undefined, ['no_list', 'colorWheel']), 'No list for colorWheel');
  assert.equal(cellText('colorWheel', d, { key: 'detail', type: 'text' }, undefined, ['no_list', 'colorWheel']), '', 'the detail is already in the sentence');
});

test('windowToUi: a stored offset beyond the picker range stays Custom and validates; a blank offset fails validation', () => {
  const far = windowToUi({ mode: 'rolling', rolling: { anchor: 'start_of_day', from_offset: -3655, to_offset: 1, unit: 'day' } });
  assert.equal(far.choice, 'custom'); assert.equal(validateWindowUi(far), '');
  const nextFar = windowToUi({ mode: 'rolling', rolling: { anchor: 'start_of_day', from_offset: 0, to_offset: 3660, unit: 'day' } });
  assert.equal(nextFar.choice, 'custom'); assert.equal(validateWindowUi(nextFar), '');
  assert.equal(windowToUi({ mode: 'rolling', rolling: { anchor: 'start_of_day', from_offset: -30, to_offset: 1, unit: 'day' } }).choice, 'last');
  const blank = windowToUi({ mode: 'rolling', rolling: { anchor: 'now', from_offset: null, to_offset: 3, unit: 'day' } });
  assert.equal(validateWindowUi(blank), 'jobs.err_win_offset');
  assert.equal(validateWindowUi({ ...defaultWindowUi('custom'), anchor: 'now', fromOffset: NaN, toOffset: 1 }), 'jobs.err_win_offset');
});

test('isReportType: a report job is a report even when the type metadata failed to load', () => {
  assert.equal(isReportType('report.late_orders', []), true);
  assert.equal(isReportType('optimizer.plant', []), false);
});

// ---------------------------------------------------------------------------------------------- W3a multi-plant
const multi = (over) => ({ ...good(), ...over });

test('a single-plant form saves no targets and no fan-out (today\'s job); the modes and zone modes are the documented sets', () => {
  const p = buildJobPayload(good());
  assert.deepEqual([p.job.targets, p.job.fan_out, p.schedule.tz_mode, p.schedule.fixed_timezone], [[], null, 'plant', null]);
  assert.deepEqual([...TARGET_MODES], ['single', 'selected', 'all', 'subnetwork']);
  assert.deepEqual([...TZ_MODES], ['plant', 'fixed', 'utc']);
});

test('buildTargetRows: selected = one explicit row per plant, all / subnetwork add exclusions, per-plant overrides ride along', () => {
  const stored = [{ kind: 'explicit', value: '2000', excluded: false, params_override: { mode: 'spt' } }];
  assert.deepEqual(buildTargetRows(multi({ targetMode: 'selected', targetPlants: ['1008', '2000'], storedTargets: stored })).map(r => [r.kind, r.value, r.excluded, r.params_override]),
    [['explicit', '1008', false, null], ['explicit', '2000', false, { mode: 'spt' }]]);
  assert.deepEqual(buildTargetRows(multi({ targetMode: 'all', excludedPlants: ['3000'] })).map(r => [r.kind, r.value, r.excluded]),
    [['all', '', false], ['explicit', '3000', true]]);
  assert.deepEqual(buildTargetRows(multi({ targetMode: 'subnetwork', targetSubnetwork: 'NA', excludedPlants: ['1008'] })).map(r => [r.kind, r.value, r.excluded]),
    [['subnetwork', 'NA', false], ['explicit', '1008', true]]);
  const p = buildJobPayload(multi({ targetMode: 'selected', targetPlants: ['1008'], fanOut: { staggerS: 30, maxParallel: 2, failFast: true }, tzMode: 'fixed', fixedTz: ' Asia/Tokyo ' }));
  assert.deepEqual(p.job.fan_out, { stagger_s: 30, max_parallel: 2, fail_fast: true });
  assert.deepEqual([p.schedule.tz_mode, p.schedule.fixed_timezone], ['fixed', 'Asia/Tokyo']);
  assert.equal(buildJobPayload(multi({ tzMode: 'utc', fixedTz: 'Asia/Tokyo' })).schedule.fixed_timezone, null, 'a zone only travels in fixed mode');
});

test('validateJobForm: targets, fixed zone and fan-out limits', () => {
  const ok = { isAdmin: true, plants: null };
  assert.equal(validateJobForm(multi({ targetMode: 'selected', targetPlants: [] }), ok).targets, 'jobs.err_targets_none');
  assert.equal(validateJobForm(multi({ targetMode: 'subnetwork' }), ok).targets, 'jobs.err_targets_subnetwork');
  assert.equal(validateJobForm(multi({ targetMode: 'selected', targetPlants: ['1008', '9999'] }), { isAdmin: true, plants: ['1008'] }).targets, 'jobs.err_plant_scope');
  assert.equal('targets' in validateJobForm(multi({ targetMode: 'all' }), ok), false);
  assert.equal(validateJobForm(multi({ tzMode: 'fixed', fixedTz: '  ' }), ok).fixedTz, 'jobs.err_fixed_tz');
  const fo = (staggerS, maxParallel) => validateJobForm(multi({ targetMode: 'all', fanOut: { staggerS, maxParallel, failFast: false } }), ok).fanOut;
  assert.equal(fo(0, null), undefined);
  assert.equal(fo(3601, null), 'jobs.err_fan_out');
  assert.equal(fo(-1, null), 'jobs.err_fan_out');
  assert.equal(fo(0, 0), 'jobs.err_fan_out');
  assert.equal(fo(0, 51), 'jobs.err_fan_out');
  assert.equal(validateJobForm(multi({ targetMode: 'single', fanOut: { staggerS: 99999, maxParallel: 0, failFast: false } }), ok).fanOut, undefined, 'fan-out only matters for many plants');
});

test('jobToForm / targetsToForm restore the mode, plants, exclusions and zone mode of a saved multi-plant job', () => {
  const rows = [{ kind: 'subnetwork', value: 'NA', excluded: false, params_override: null }, { kind: 'explicit', value: '1021', excluded: true, params_override: null }];
  const f = jobToForm({ name: 'J', plant: '1008', job_type: 'optimizer.plant', params: {}, targets: rows, fanOut: { stagger_s: 20, max_parallel: 3, fail_fast: true },
    schedule: { kind: 'daily', time_of_day: '08:00', tzMode: 'fixed', fixedTimezone: 'Europe/London' } });
  assert.deepEqual([f.targetMode, f.targetSubnetwork, f.excludedPlants, f.tzMode, f.fixedTz], ['subnetwork', 'NA', ['1021'], 'fixed', 'Europe/London']);
  assert.deepEqual(f.fanOut, { staggerS: 20, maxParallel: 3, failFast: true });
  assert.deepEqual(buildTargetRows(f).map(r => [r.kind, r.value, r.excluded]), [['subnetwork', 'NA', false], ['explicit', '1021', true]], 'round trip');
  assert.equal(targetsToForm([{ kind: 'all', value: '*', excluded: false, params_override: null }], null).targetMode, 'all');
  assert.equal(targetsToForm([{ kind: 'explicit', value: '1', excluded: false, params_override: null }], null).targetMode, 'selected');
  assert.equal(targetsToForm([], null).targetMode, 'single');
  assert.equal(jobToForm({ name: 'J', plant: '1008', job_type: 'optimizer.plant', params: {} }).tzMode, 'plant');
});

test('targetsLabel names the targets: Plant 1021, 12 plants, All plants, Subnetwork NA', () => {
  const d = { t: (k, v) => `${k}|${JSON.stringify(v ?? {})}` };
  assert.equal(targetsLabel({ plant: '1021' }, d), 'jobs.targets_single|{"plant":"1021"}');
  assert.equal(targetsLabel({ plant: '1021', targetKind: 'selected', targetCount: 12 }, d), 'jobs.targets_n|{"n":12}');
  assert.equal(targetsLabel({ plant: '1021', targetKind: 'mixed', targetCount: 3 }, d), 'jobs.targets_n|{"n":3}');
  assert.equal(targetsLabel({ plant: '1021', targetKind: 'all', targetCount: 50 }, d), 'jobs.targets_all_n|{"n":50}');
  assert.equal(targetsLabel({ plant: '1021', targetKind: 'all', targetCount: 1 }, d), 'jobs.targets_all_one|{}');
  assert.equal(targetsLabel({ plant: '1021', targetKind: 'selected', targetCount: 1 }, { t: (k, v) => (k === 'jobs.targets_n_one' ? `one:${v?.n}` : `${k}`) }), 'one:1');
  assert.equal(targetsLabel({ plant: '1021', targetKind: 'subnetwork', targets: [{ kind: 'subnetwork', value: 'NA', excluded: false }] }, d), 'jobs.targets_subnetwork|{"name":"NA"}');
});

test('filterPlants searches and caps the rendered rows; targetsPreviewText reads "12 plants; 2 skipped: no timezone"', () => {
  const all = Array.from({ length: 500 }, (_, i) => `P${String(i).padStart(3, '0')}`);
  assert.deepEqual(filterPlants(all, '').shown.length, 200);
  assert.equal(filterPlants(all, '').total, 500);
  assert.deepEqual(filterPlants(all, 'p49'), { shown: all.slice(490, 500), total: 10 });
  assert.equal(filterPlants(all, 'p', 5).shown.length, 5);
  const d = { t: (k, v) => `${k}|${JSON.stringify(v ?? {})}` };
  assert.equal(targetsPreviewText({ count: 12, skipped: 0, warnings: [] }, d), 'jobs.t_preview|{"n":12}');
  const txt = targetsPreviewText({ count: 10, skipped: 2, warnings: ['3001: plant has no timezone', '3002: plant has no timezone'] }, d);
  assert.match(txt, /^jobs\.t_preview_skipped\|/);
  assert.match(txt, /"skipped":2/);
  assert.match(txt, /jobs\.t_skip_no_tz/, 'the reason is translated once, not repeated per plant');
});

test('batchTiles keeps a fixed order and drops zero counts; buildBatchesQuery pages by cursor', () => {
  assert.deepEqual(batchTiles({ counts: { failed: 1, total: 3, succeeded: 2, skipped: 0 } }).map(x => [x.key, x.value]), [['total', 3], ['succeeded', 2], ['failed', 1]]);
  assert.deepEqual(batchTiles({ counts: {} }), []);
  assert.equal(buildBatchesQuery({ plant: '1008', status: 'failed', jobId: 5, beforeId: 9, limit: 20 }), '?plant=1008&status=failed&job_id=5&before_id=9&limit=20');
  assert.equal(buildBatchesQuery({}), '?limit=50');
  assert.equal(buildBatchesQuery({ limit: 9999 }), '?limit=200');
  assert.ok(timeZoneList().includes('UTC') && timeZoneList().length >= 10);
});

test('plural picks the _one key for a count of one and falls back to the base key when a locale has none', () => {
  const t = (k, v) => ({ 'jobs.x': 'many {{n}}', 'jobs.x_one': 'one {{n}}' }[k] ?? k);
  assert.equal(plural('jobs.x', 1, { t }), 'one {{n}}');
  assert.equal(plural('jobs.x', 2, { t }), 'many {{n}}');
  assert.equal(plural('jobs.y', 1, { t }), 'jobs.y');
  assert.equal(targetsPreviewText({ count: 1, skipped: 0, warnings: [] }, { t: (k) => k }), 'jobs.t_preview');
});

test('mixed target rows are not editable in the form: they are kept exactly as saved (a subnetwork plus a plant, an excluded subnetwork)', () => {
  const sub = { kind: 'subnetwork', value: 'NA', excluded: false, params_override: null };
  const one = { kind: 'explicit', value: '1008', excluded: false, params_override: { mode: 'spt' } };
  const exclSub = { kind: 'subnetwork', value: 'EU', excluded: true, params_override: null };
  assert.equal(targetsLossless([sub]), true);
  assert.equal(targetsLossless([sub, { kind: 'explicit', value: '3001', excluded: true, params_override: null }]), true);
  assert.equal(targetsLossless([sub, one]), false);
  assert.equal(targetsLossless([sub, exclSub]), false);
  const f = { ...defaultJobForm('1008'), ...targetsToForm([sub, one], null) };
  assert.equal(f.targetsLocked, true);
  assert.deepEqual(buildTargetRows(f), [sub, one], 'every row, override included, survives an edit');
  assert.equal(targetsToForm([sub], null).targetsLocked, false);
});

test('a selection beyond the server cap of 500 target rows is refused client-side with its own message', () => {
  const plants = Array.from({ length: TARGET_ROWS_MAX + 1 }, (_, i) => 'P' + i);
  const f = { ...defaultJobForm('1008'), name: 'n', targetMode: 'selected', targetPlants: plants };
  assert.equal(targetRowCount(f), TARGET_ROWS_MAX + 1);
  assert.equal(validateJobForm(f, { isAdmin: true, plants: null }).targets, 'jobs.err_targets_cap');
  assert.equal(validateJobForm({ ...f, targetPlants: plants.slice(0, TARGET_ROWS_MAX) }, { isAdmin: true, plants: null }).targets, undefined);
});
