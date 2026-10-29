// W3b frontend: the schedule policy form <-> options, the dialog's Advanced block, the run-status reasons, the timeline
// layout (bars, ticks, rows) and the Runs timeline view of the pane against the dom-stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { installDom } from '../helpers/dom-stub.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');
const dom = installDom();
const M = await import('../../../frontend/admin-ops/jobs-model.mjs');
const { policyBlockHtml, policyInnerHtml, bodyHtml, recurFieldsHtml } = await import('../../../frontend/admin-ops/jobs-dialog.mjs');
const { JobsAdmin } = await import('../../../frontend/admin-ops/jobs-pane.mjs');
const { JobsClient } = await import('../../../frontend/admin-ops/jobs-client.mjs');
const { Session } = await import('../../../frontend/security/session.mjs');
const { Store } = await import('../../../frontend/platform/store.mjs');
const { Util } = await import('../../../frontend/platform/foundation.mjs');
const { TYPES } = await import('./jobs-types-fixture.mjs');

Util.t = (k, v) => deps.t(k, v);
const EN = (() => { const w = {}; vm.runInNewContext(readFileSync(new URL('../../../frontend/locales/en.js', import.meta.url), 'utf8'), { window: w }); return w.__NIMBUS_LOCALES.en; })();
const deps = { t: (k, v) => (EN[k] ?? k).replace(/\{\{(\w+)\}\}/g, (_, n) => String(v?.[n])), esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };

// ------------------------------------------------------------------------------------------------ policy <-> options
test('an untouched policy is no options at all, so an old schedule is saved exactly as it was', () => {
  const p = M.defaultPolicy();
  assert.equal(M.policyToOptions(p, 'daily'), null);
  assert.deepEqual(M.policyFromOptions(null), p);
  assert.deepEqual(M.policyFromOptions({}), p, 'a stored object with nothing in it reads as the defaults');
  const f = M.defaultJobForm('1008');
  assert.equal(M.buildJobPayload(f).schedule.options, null);
});

test('a changed policy becomes full options, and options read back into the same form', () => {
  const p = { ...M.defaultPolicy(), dstGap: 'skip', dstOverlap: 'twice', closedDay: 'next_working_day', winOn: true, winStart: '06:00', winEnd: '18:00', winAction: 'defer', graceMin: 30, catchUp: true };
  const o = M.policyToOptions(p, 'weekly');
  assert.deepEqual(o, {
    dst_gap: 'skip', dst_overlap: 'twice', closed_day: 'next_working_day', run_window: { start: '06:00', end: '18:00', action: 'defer' },
    monthly: 'day_of_month', monthly_clamp: false, catch_up: { enabled: true, grace_s: 1800 },
  });
  assert.deepEqual(M.policyFromOptions(o), p);
  assert.deepEqual(M.policyToOptions(M.policyFromOptions({ ...o, catch_up: { enabled: false, grace_s: 7200 } }), 'daily').catch_up, { enabled: false, grace_s: 7200 });
});

test('rules that do not apply to the preset are dropped: hourly ignores DST, only monthly has monthly rules, only once-a-day kinds move days', () => {
  const p = { ...M.defaultPolicy(), dstGap: 'skip', dstOverlap: 'twice', closedDay: 'previous_working_day', monthly: 'last_day', winOn: true };
  assert.deepEqual([M.policyToOptions(p, 'hourly').dst_gap, M.policyToOptions(p, 'hourly').dst_overlap, M.policyToOptions(p, 'hourly').closed_day], ['shift', 'once', 'run']);
  assert.equal(M.policyToOptions(p, 'cron').closed_day, 'run');
  assert.equal(M.policyToOptions(p, 'monthly').monthly, 'last_day');
  assert.equal(M.policyToOptions(p, 'daily').monthly, 'day_of_month');
  assert.deepEqual([...M.closedDayChoices('hourly')], ['run', 'skip']);
  assert.deepEqual([...M.closedDayChoices('monthly')], ['run', 'skip', 'next_working_day', 'previous_working_day']);
  assert.equal(M.policyToOptions({ ...M.defaultPolicy(), monthly: 'day_of_month', monthlyClamp: true }, 'daily'), null, 'clamp means nothing outside monthly');
});

test('policy validation: a window needs two different times, grace 1-1440 minutes, calendar rules need plant time', () => {
  const ok = M.defaultPolicy();
  assert.deepEqual(M.validatePolicy(ok, 'daily', 'plant'), {});
  assert.equal(M.validatePolicy({ ...ok, winOn: true, winStart: '08:00', winEnd: '08:00' }, 'daily', 'plant').policyWin, 'jobs.err_win_same');
  assert.equal(M.validatePolicy({ ...ok, winOn: true, winStart: '', winEnd: '08:00' }, 'daily', 'plant').policyWin, 'jobs.err_win_same');
  assert.deepEqual(M.validatePolicy({ ...ok, winOn: true, winStart: '22:00', winEnd: '05:00' }, 'daily', 'utc'), {}, 'a window crossing midnight is fine');
  for (const bad of [0, 1441, 1.5, NaN]) assert.equal(M.validatePolicy({ ...ok, graceMin: bad }, 'daily', 'plant').policyGrace, 'jobs.err_grace');
  assert.deepEqual(M.validatePolicy({ ...ok, catchUp: false, graceMin: 0 }, 'daily', 'plant'), {}, 'grace is not read while catch-up is off');
  assert.equal(M.validatePolicy({ ...ok, closedDay: 'skip' }, 'daily', 'fixed').policyTz, 'jobs.err_policy_tz');
  assert.equal(M.validatePolicy({ ...ok, monthly: 'first_working_day' }, 'monthly', 'utc').policyTz, 'jobs.err_policy_tz');
  assert.deepEqual(M.validatePolicy({ ...ok, closedDay: 'skip' }, 'daily', 'plant'), {});
  const f = { ...M.defaultJobForm('1008'), name: 'x', policy: { ...ok, winOn: true, winStart: '08:00', winEnd: '08:00' } };
  assert.equal(M.validateJobForm(f, { isAdmin: true, plants: null, meta: null }).policyWin, 'jobs.err_win_same', 'the job form carries the policy errors');
});

test('monthly modes: only a fixed day sends day_of_month, validation skips the day box otherwise, and the prose follows the mode', () => {
  const r = { ...M.defaultRecurrence(), preset: 'monthly', time: '07:30', dom: 15 };
  assert.deepEqual(M.recurrenceToScheduleIn(r, { monthly: 'day_of_month' }), { kind: 'monthly', time_of_day: '07:30', day_of_month: 15 });
  assert.deepEqual(M.recurrenceToScheduleIn(r), { kind: 'monthly', time_of_day: '07:30', day_of_month: 15 }, 'the one-argument form is unchanged');
  assert.deepEqual(M.recurrenceToScheduleIn(r, { monthly: 'last_working_day' }), { kind: 'monthly', time_of_day: '07:30' });
  const f = { ...M.defaultJobForm('1008'), name: 'x', recur: { ...r, dom: 0 }, policy: { ...M.defaultPolicy(), monthly: 'last_day' } };
  assert.equal(M.validateJobForm(f, { isAdmin: true, plants: null }).dom, undefined, 'no day to enter, no day error');
  assert.equal(M.validateJobForm({ ...f, policy: M.defaultPolicy() }, { isAdmin: true, plants: null }).dom, 'jobs.err_dom');
  const text = (mode) => M.recurrenceText({ kind: 'monthly', time_of_day: '07:30', day_of_month: null, options: { monthly: mode } }, { ...deps, t: (k, v) => `${k}|${v?.time}` }, x => x);
  assert.equal(text('first_working_day'), 'jobs.cron_monthly_first_working_day|07:30');
  assert.equal(text('last_day'), 'jobs.cron_monthly_last_day|07:30');
  assert.equal(M.recurrenceText({ kind: 'monthly', time_of_day: '07:30', day_of_month: 3, options: null }, { ...deps, t: (k, v) => `${k}|${v?.dom}` }, x => x), 'jobs.cron_monthly|3');
  assert.equal(M.jobToForm({ schedule: { kind: 'monthly', time_of_day: '07:30', options: { monthly: 'last_day' } } }).policy.monthly, 'last_day');
});

// --------------------------------------------------------------------------------------------- the Advanced block
test('Advanced block: every control id is jb-pol-*, hourly swaps the DST selects for a note, hints name an example', () => {
  const form = (preset, over = {}) => ({ ...M.defaultJobForm('1008'), recur: { ...M.defaultRecurrence(), preset }, policy: { ...M.defaultPolicy(), ...over } });
  const daily = policyBlockHtml(form('daily'));
  for (const id of ['jb-pol-gap', 'jb-pol-overlap', 'jb-pol-closed', 'jb-pol-win-on', 'jb-pol-cu-on', 'jb-pol-cu-min']) assert.match(daily, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(daily, /jb-pol-monthly/, 'monthly rules only on a monthly schedule');
  assert.doesNotMatch(daily, /<details[^>]* open/, 'closed while every rule is the default');
  assert.match(daily, /02:30/, 'the DST hint carries a worked example');
  const hourly = policyInnerHtml(form('hourly'));
  assert.doesNotMatch(hourly, /jb-pol-gap|jb-pol-overlap/);
  assert.match(hourly, /25 runs/);
  assert.doesNotMatch(hourly, /next_working_day/, 'hourly cannot move a run to another day');
  const monthly = policyInnerHtml(form('monthly'));
  assert.match(monthly, /id="jb-pol-monthly"/);
  assert.match(monthly, /id="jb-pol-clamp"/, 'the shorter-month choice belongs to a fixed day');
  assert.doesNotMatch(policyInnerHtml(form('monthly', { monthly: 'last_day' })), /jb-pol-clamp/);
  assert.match(policyBlockHtml(form('daily', { closedDay: 'skip' })), /<details[^>]* open/, 'open when a rule is set');
  const win = policyInnerHtml(form('daily', { winOn: true }));
  assert.match(win, /id="jb-pol-win-start"[^>]*value="08:00"/);
  assert.match(win, /id="jb-pol-win-action"/);
  assert.doesNotMatch(policyInnerHtml(form('daily')), /jb-pol-win-start/, 'the window times exist only while the window is on');
  assert.doesNotMatch(policyInnerHtml(form('daily', { catchUp: false })), /jb-pol-cu-min/);
  const block = bodyHtml(form('daily'), 'new', true, null, []).match(/<details class="job-adv" id="jb-sadv"[\s\S]*?<\/details>/)[0];
  assert.doesNotMatch(block.replace(/<div class="ape-err"[^>]*>/g, ''), /\shidden[\s>=]/, 'only the shared error lines carry hidden; no rule is shown or hidden that way');
  assert.doesNotMatch(recurFieldsHtml({ ...M.defaultRecurrence(), preset: 'monthly' }, 'last_day'), /jb-dom/);
  assert.match(recurFieldsHtml({ ...M.defaultRecurrence(), preset: 'monthly' }), /id="jb-dom"/);
});

// ----------------------------------------------------------------------------------------------- run status reasons
test('a skipped run shows its reason in words; Missed stays a status; unknown reasons show as sent', () => {
  assert.equal(M.skipReasonText('maintenance mode', deps), 'maintenance mode');
  assert.equal(M.skipReasonText('closed day', deps), 'plant closed');
  assert.equal(M.skipReasonText('outside run window', deps), 'outside the allowed hours');
  assert.equal(M.skipReasonText('previous run still running', deps), 'previous run still running');
  assert.match(M.runStatusHtml({ status: 'skipped', error: 'maintenance mode' }, deps), /Skipped|jobs\.status_skipped[\s\S]*maintenance mode/);
  assert.equal(M.displayStatus({ status: 'skipped', error: 'missed: process was down (3 fires)' }), 'missed');
  assert.equal(M.displayStatus({ status: 'skipped', error: 'maintenance mode' }), 'skipped', 'maintenance is Skipped, not Missed');
  assert.equal(M.policyNoteText('moved_next_working_day', deps), 'moved to the next working day');
  assert.equal(M.policyNoteText(null, deps), '');
  assert.equal(M.skipReasonCodeText('closed_day', deps), 'plant closed');
  assert.equal(M.skipReasonCodeText('who_knows', deps), 'who_knows');
});

// ---------------------------------------------------------------------------------------------------- timeline model
const NOW = Date.parse('2026-10-29T12:00:00Z');
const H = 3600000;

test('timeline window: 24 h is 12 h either side of now, 7 d is 3 days back and 4 ahead (inside the server limit of 8)', () => {
  const a = M.timelineWindow('24h', NOW); const b = M.timelineWindow('7d', NOW);
  assert.deepEqual([a.toMs - a.fromMs, a.fromMs, a.toMs], [24 * H, NOW - 12 * H, NOW + 12 * H]);
  assert.equal(b.toMs - b.fromMs, 7 * 24 * H);
  assert.ok(b.toMs - b.fromMs <= 8 * 24 * H);
  assert.equal(a.from, '2026-10-29T00:00:00.000Z');
});

test('timeline bars: clipped to the window, a running run ends at now, points get a minimum width, upcoming fires are marked', () => {
  const w = M.timelineWindow('24h', NOW);
  const lane = {
    runs: [
      { id: 1, jobId: 5, jobName: 'A', status: 'succeeded', error: null, startUtc: '2026-10-29T06:00:00Z', endUtc: '2026-10-29T07:00:00Z', scheduledFor: null },
      { id: 2, jobId: 5, jobName: 'A', status: 'running', error: null, startUtc: '2026-10-29T11:00:00Z', endUtc: null, scheduledFor: null },
      { id: 3, jobId: 5, jobName: 'A', status: 'skipped', error: 'maintenance mode', startUtc: null, endUtc: '2026-10-29T08:00:00Z', scheduledFor: '2026-10-29T08:00:00Z' },
      { id: 4, jobId: 5, jobName: 'A', status: 'skipped', error: 'missed: process was down (2 fires)', startUtc: null, endUtc: '2026-10-29T09:00:00Z', scheduledFor: '2026-10-29T09:00:00Z' },
      { id: 5, jobId: 5, jobName: 'old', status: 'failed', error: null, startUtc: '2026-10-27T00:00:00Z', endUtc: '2026-10-27T01:00:00Z', scheduledFor: null },
      { id: 6, jobId: 5, jobName: 'straddle', status: 'failed', error: null, startUtc: '2026-10-28T22:00:00Z', endUtc: '2026-10-29T02:00:00Z', scheduledFor: null },
    ],
    upcoming: [{ atUtc: '2026-10-29T13:00:00Z', atLocal: '', jobId: 5, jobName: 'A', scheduleId: 11, dstShifted: true, policyNote: 'dst_gap_shifted' }, { atUtc: '2026-11-05T13:00:00Z', atLocal: '', jobId: 5, jobName: 'A', scheduleId: 11, dstShifted: false, policyNote: null }],
  };
  const bars = M.timelineBars(lane, w.fromMs, w.toMs, NOW);
  assert.deepEqual(bars.map(b => b.key), ['r6', 'r1', 'r3', 'r4', 'r2', 'u11-' + Date.parse('2026-10-29T13:00:00Z')], 'oldest first; the run before the window and the fire after it are out');
  const by = Object.fromEntries(bars.map(b => [b.key, b]));
  assert.ok(Math.abs(by.r1.w - (H / (24 * H)) * M.TL_W) < 1e-6, '1 h of 24 h');
  assert.equal(by.r1.x, (6 * H / (24 * H)) * M.TL_W, 'started 6 h into the window');
  assert.equal(by.r6.x, 0, 'a run that began before the window is clipped to the left edge');
  assert.equal(by.r2.x + by.r2.w, (12 * H + 0) / (24 * H) * M.TL_W, 'a running run ends at the now line');
  assert.equal(by.r3.w, M.TL_MIN_BAR, 'a skipped run is a point with a visible width');
  assert.deepEqual([by.r3.status, by.r4.status, by.r2.status], ['skipped', 'missed', 'running'], 'the shown status keeps Missed apart from Skipped');
  const up = bars.at(-1);
  assert.deepEqual([up.kind, up.status, up.runId, up.shifted, up.note], ['upcoming', 'upcoming', null, true, 'dst_gap_shifted']);
  for (const b of bars) assert.ok(b.x >= 0 && b.x + b.w <= M.TL_W + 1e-9, `${b.key} stays inside the lane`);
});

test('timeline ticks are relative to now and evenly spread over the window', () => {
  const w24 = M.timelineWindow('24h', NOW);
  const t24 = M.timelineTicks('24h', w24.fromMs, w24.toMs, NOW);
  assert.deepEqual(t24.map(k => [k.labelKey, k.n]), [['jobs.tl_ago', 12], ['jobs.tl_ago', 8], ['jobs.tl_ago', 4], ['jobs.tl_now_axis', 0], ['jobs.tl_ahead', 4], ['jobs.tl_ahead', 8], ['jobs.tl_ahead', 12]]);
  assert.equal(t24[3].pct, 50);
  const w7 = M.timelineWindow('7d', NOW);
  const t7 = M.timelineTicks('7d', w7.fromMs, w7.toMs, NOW);
  assert.deepEqual([t7[0].labelKey, t7[0].n, t7.at(-1).labelKey, t7.at(-1).n, t7.length], ['jobs.tl_ago_d', 3, 'jobs.tl_ahead_d', 4, 8]);
  for (let i = 1; i < t7.length; i++) assert.ok(Math.abs((t7[i].pct - t7[i - 1].pct) - 100 / 7) < 1e-9);
});

test('timeline rows: the same items as a flat table, lane order then time', () => {
  const rows = M.timelineRows({ lanes: [
    { plant: '1008', timezone: 'America/Chicago', nowLocal: '', runs: [{ id: 1, jobId: 5, jobName: 'A', status: 'failed', error: null, startUtc: '2026-10-29T10:00:00Z', endUtc: null, scheduledFor: null }],
      upcoming: [{ atUtc: '2026-10-29T13:00:00Z', atLocal: '2026-10-29T08:00:00-05:00', jobId: 5, jobName: 'A', scheduleId: 1, dstShifted: false, policyNote: 'deferred_to_window' }] },
    { plant: '2000', timezone: 'UTC', nowLocal: '', runs: [], upcoming: [] },
  ] });
  assert.deepEqual(rows.map(r => [r.plant, r.kind, r.status, r.runId, r.note]), [['1008', 'run', 'failed', 1, null], ['1008', 'upcoming', 'upcoming', null, 'deferred_to_window']]);
});

// -------------------------------------------------------------------------------------------- pane: Runs timeline
const add = (id, parent = dom.doc.body) => { const el = dom.doc.createElement('div'); el.setAttribute('id', id); parent.appendChild(el); return el; };

test('the Runs view select offers Timeline; choosing it loads /jobs/timeline for the chosen plant and range and paints lanes, bars and the table', async () => {
  Session.isAdmin = () => true; Session.allowedPlants = () => null; Store.knownPlants = () => ['1008', '2000'];
  Util.t = (k, v) => deps.t(k, v);
  JobsClient.types = async () => TYPES;
  JobsClient.list = async () => ({ items: [], nextBeforeId: null });
  JobsClient.runs = async () => ({ items: [], nextBeforeId: null });
  JobsClient.upcomingAll = async () => [];
  JobsClient.summary = async () => ({ running: 0, queued: 0, failed24h: 0, missed24h: 0, warning24h: 0, failedConfig24h: 0, failedSystem24h: 0, failedTransient24h: 0, failedBatches24h: 0,
    nextFire: null, scheduler: { ok: true, lastTickAt: null }, longerThanUsual: [], maintenance: { enabled: true, since: '2026-10-29T12:00:00+00:00', by: 'a@b.c' } });
  const asked = [];
  JobsClient.timeline = async q => {
    asked.push(q);
    const now = new Date().toISOString();
    return { from: q.from, to: q.to, nowUtc: now, totalPlants: 1, plantOffset: 0, plantLimit: 20, truncated: false, lanes: [{
      plant: '1008', timezone: 'America/Chicago', nowLocal: now, runs: [{ id: 42, jobId: 5, jobName: 'Morning <b>optimize</b>', jobType: 'optimizer.plant', status: 'failed', trigger: 'schedule', batchId: null, error: null,
        scheduledFor: null, startUtc: new Date(Date.now() - 3600000).toISOString(), endUtc: new Date(Date.now() - 1800000).toISOString() }],
      upcoming: [{ atUtc: new Date(Date.now() + 3600000).toISOString(), atLocal: now, jobId: 5, jobName: 'Morning optimize', scheduleId: 11, dstShifted: false, policyNote: null }] }] };
  };
  const pane = add('admin-jobs-pane');
  const runs = add('jobs-view-runs', pane); add('jobs-view-jobs', pane); add('jobs-view-upcoming', pane); add('jobs-health', pane); add('jobs-maint', pane);
  add('jobs-runs-plant-host'); add('jobs-runs-list'); add('jobs-table'); add('jobs-plant-host'); add('jobs-up-plant-host');
  await JobsAdmin.render();
  JobsAdmin._setTab('runs');
  assert.match(runs.innerHTML, /<option value="timeline">/, 'Runs | Batches | Timeline');
  assert.match(dom.doc.getElementById('jobs-maint').innerHTML, /job-maint-banner/, 'the banner is up while maintenance is on');
  assert.match(dom.doc.getElementById('jobs-maint').innerHTML, /id="jobs-maint-btn" data-jobs-act="maint">Resume scheduled jobs/, 'an admin sees the toggle, naming the action');
  assert.doesNotMatch(dom.doc.getElementById('jobs-maint').innerHTML, /aria-pressed/, 'a plain button: the label changes, no pressed state');
  const sel = { id: 'jobs-runs-view', value: 'timeline' };
  pane.dispatch('change', { target: { ...sel, tagName: 'SELECT' } });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(asked.length >= 1, true, 'the timeline loader ran');
  const q = asked.at(-1);
  assert.equal(Date.parse(q.to) - Date.parse(q.from), 24 * 3600000, 'the default range is 24 hours');
  const list = dom.doc.getElementById('jobs-runs-list').innerHTML;
  assert.match(list, /class="job-tl"/);
  assert.match(list, /data-tl-run="42"/, 'a run bar opens its run');
  assert.match(list, /data-tl-job="5"/, 'an upcoming bar opens its job');
  assert.match(list, /role="button"[^>]*aria-label="Morning &lt;b&gt;optimize&lt;\/b&gt;: Failed/, 'every bar says job and status in text, escaped');
  assert.match(list, /<table class="job-table"/, 'the keyboard alternative: the same items as a table');
  assert.match(list, /class="job-run-row" tabindex="0" data-tl-key="row0" data-tl-run="42"/);
  assert.match(list, /Now /, 'the lane names its own clock');
  assert.doesNotMatch(list, /Morning <b>/, 'a job name never reaches the markup unescaped');
  asked.length = 0;
  pane.dispatch('change', { target: { id: 'jobs-tl-range', value: '7d', tagName: 'SELECT' } });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(Date.parse(asked.at(-1).to) - Date.parse(asked.at(-1).from), 7 * 24 * 3600000, 'the 7 d switch asks for seven days');
  assert.match(list, /<details class="job-tl-list"><summary id="jobs-tl-sum">/, 'the list is closed until opened, and its summary can take focus back');
  // a page past the end (plants went away) still shows the pager, and a capped upcoming range says so
  JobsClient.timeline = async q => ({ from: q.from, to: q.to, nowUtc: new Date().toISOString(), totalPlants: 20, plantOffset: 20, plantLimit: 20, truncated: false, upcomingTruncated: true, lanes: [] });
  pane.dispatch('change', { target: { id: 'jobs-tl-range', value: '24h', tagName: 'SELECT' } });
  await new Promise(r => setTimeout(r, 20));
  const empty = dom.doc.getElementById('jobs-runs-list').innerHTML;
  assert.match(empty, /data-jobs-act="tl-prev"/, 'an empty page still has Previous');
  assert.match(empty, /data-jobs-act="tl-next" disabled/, 'and Next is off at the end');
  JobsClient.timeline = async q => ({ from: q.from, to: q.to, nowUtc: new Date().toISOString(), totalPlants: 1, plantOffset: 0, plantLimit: 20, truncated: false, upcomingTruncated: true, lanes: [{
    plant: '1008', timezone: 'UTC', nowLocal: new Date().toISOString(), runs: [], upcoming: [{ atUtc: new Date(Date.now() + 3600000).toISOString(), atLocal: new Date().toISOString(), jobId: 5, jobName: 'A', scheduleId: 1, dstShifted: false, policyNote: null }] }] });
  pane.dispatch('change', { target: { id: 'jobs-tl-range', value: '7d', tagName: 'SELECT' } });
  await new Promise(r => setTimeout(r, 20));
  assert.match(dom.doc.getElementById('jobs-runs-list').innerHTML, /Some upcoming runs are not drawn/, 'upcoming bars cut by the server say so');
  JobsAdmin.setActive(false);
});
