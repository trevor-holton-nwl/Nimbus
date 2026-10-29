// Contract test for frontend/admin-ops/jobs-client.mts against tests/fixtures/jobs_contract.json (the real backend
// response shapes, pinned by tests/test_jobs_contract.py). Every wire body is wrapped in a recording Proxy: the client
// may only read keys that exist in the body, and the normalised values must come out populated. Also pins the request
// URLs / bodies the client sends (cursor paging, archive / retire deletes, preset schedules).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JobsClient } from '../../../frontend/admin-ops/jobs-client.mjs';
import { Util } from '../../../frontend/platform/foundation.mjs';

globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || createRequire(import.meta.url)('../../../frontend/nimbus-compute-core.js');

const FIX = JSON.parse(readFileSync(new URL('../../fixtures/jobs_contract.json', import.meta.url), 'utf8'));
const resolve = v => (typeof v === 'string' && v.startsWith('$') ? resolve(FIX[v.slice(1)])
  : Array.isArray(v) ? v.map(resolve) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)])) : v);
const body = name => resolve(FIX[name]);

const OPAQUE = new Set(['params', 'summary', 'data', 'params_schema', 'defaults', 'options']);
let phantom;   // keys the client read that the wire body does not have
function recording(obj, path = '$') {
  if (Array.isArray(obj)) return obj.map((x, i) => recording(x, `${path}[${i}]`));
  if (!obj || typeof obj !== 'object') return obj;
  return new Proxy(obj, {
    get(t, k) {
      if (typeof k !== 'string' || k === 'then') return t[k];   // `then`: the promise machinery probing the json() result
      if (!(k in t)) phantom.push(`${path}.${k}`);
      return OPAQUE.has(k) ? t[k] : recording(t[k], `${path}.${k}`);
    },
  });
}

let calls; let reply; const prior = {};
beforeEach(() => {
  phantom = []; calls = []; reply = null;
  prior.fetch = Util.fetchTraced;
  Util.fetchTraced = async (url, init) => { calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined }); return { ok: true, status: 200, json: async () => recording(reply) }; };
});
afterEach(() => { Util.fetchTraced = prior.fetch; });

const path = i => calls[i].url.replace(/^.*?(\/jobs)/, '$1');

test('list: {jobs, next_before_id} envelope, cursor paging, job_type filter, schedule + last_run normalised', async () => {
  reply = body('jobs_list');
  const r = await JobsClient.list({ plant: '1008', type: 'optimizer.plant', status: 'warning', limit: 20, beforeId: 9 });
  assert.equal(path(0), '/jobs?plant=1008&status=warning&job_type=optimizer.plant&before_id=9&limit=20');
  assert.equal(r.nextBeforeId, 4);
  const j = r.items[0];
  assert.deepEqual([j.id, j.name, j.plant, j.enabled, j.next_run_at, j.next_run_local], [5, 'Morning optimize', '1008', true, '2026-10-30T12:00:00+00:00', '2026-10-30T08:00:00-04:00']);
  assert.deepEqual([j.schedule.kind, j.schedule.time_of_day, j.schedule.days_of_week], ['weekly', '08:00', [0, 2, 4]]);
  assert.equal(j.schedules.length, 1);
  assert.deepEqual([j.last_run.status, j.last_run.duration_ms, j.last_run.summary.applied], ['warning', 219000, 118]);
  assert.deepEqual(phantom, []);
  reply = { jobs: [], next_before_id: null };
  assert.equal((await JobsClient.list({})).nextBeforeId, null, 'no cursor on the last page');
});

test('types: key, label, plant_scoped and the params defaults', async () => {
  reply = body('types');
  const t = (await JobsClient.types())[0];
  assert.deepEqual([t.key, t.plantScoped, t.defaults.search, t.defaults.mode], ['optimizer.plant', true, 'exhaustive', 'due_date']);
  assert.deepEqual([t.kind, t.mutates, t.params[0].key, t.params[0].labelKey, t.params[0].enum], ['action', true, 'mode', 'jobs.p.optimizer.plant.mode', ['due_date', 'min_changeover', 'spt']]);
  assert.deepEqual(phantom, []);
});

test('types: kind, mutates and the param metadata of every type survive normalisation (real /jobs/types shapes)', async () => {
  reply = { types: JSON.parse(readFileSync(new URL('../../fixtures/jobs_types.json', import.meta.url), 'utf8')).types };
  const ts = await JobsClient.types();
  assert.deepEqual(ts.map(t => [t.key, t.kind]), [['optimizer.plant', 'action'], ['report.what_changed', 'report'], ['report.late_orders', 'report'],
    ['report.missing_master_data', 'report'], ['report.coverage', 'report'], ['report.distribution', 'report']]);
  assert.ok(ts.filter(t => t.kind === 'report').every(t => t.mutates === false));
  const p = Object.fromEntries(ts.find(t => t.key === 'report.late_orders').params.map(x => [x.key, x]));
  assert.deepEqual([p.horizon.type, p.horizon.widget, p.min_days_late.type, p.min_days_late.min, p.min_days_late.max], ['date_window', 'date-window', 'number', 0, 365]);
  assert.equal(p.horizon.default.rolling.to_offset, 14);
  const cov = ts.find(t => t.key === 'report.coverage').params[0];
  assert.deepEqual([cov.type, cov.enum, cov.enumLabelKeys.setup], ['multi_enum', ['tools', 'priority_lists', 'setup'], 'jobs.p.report.coverage.sections.setup']);
});

test('windowPreview posts {plant, window} (+ job_id, lookback) and returns the resolved window', async () => {
  reply = body('window_preview');
  const win = { mode: 'rolling', rolling: { anchor: 'last_success', from_offset: 0, to_offset: 0, unit: 'day' } };
  const r = await JobsClient.windowPreview('1008', win, { jobId: 5, lookbackDays: 3 });
  assert.deepEqual([calls[0].method, path(0)], ['POST', '/jobs/windows/preview']);
  assert.deepEqual(calls[0].body, { plant: '1008', window: win, job_id: 5, first_run_lookback_days: 3 });
  assert.deepEqual([r.label, r.timezone, r.start.slice(0, 10)], ['2026-09-28 to 2026-10-28', 'America/Chicago', '2026-09-28']);
  await JobsClient.windowPreview('1008', win);
  assert.deepEqual(calls[1].body, { plant: '1008', window: win }, 'no job id, no lookback when not given');
  assert.deepEqual(phantom, []);
});

test('artifact: sections with columns and one page of rows; a section page asks offset / limit', async () => {
  reply = body('artifact');
  const a = await JobsClient.artifact(42);
  assert.equal(path(0), '/jobs/runs/42/artifact?offset=0&limit=500');
  assert.deepEqual([a.runId, a.truncated, a.sizeBytes, a.sections.length], [42, false, 512, 1]);
  const s = a.sections[0];
  assert.deepEqual([s.key, s.title, s.columns.map(c => c.key), s.rows, s.rowCount, s.rowsStored, s.truncated, s.offset], ['counts', 'Changes', ['value', 'events'], [['drag', 3]], 1, 1, false, 0]);
  assert.deepEqual(phantom, []);
  await JobsClient.artifact(42, { section: 'top orders', offset: 500, limit: 500 });
  assert.equal(path(1), '/jobs/runs/42/artifact?offset=500&limit=500&section=top%20orders');
});

test('artifactCsv fetches one section as BYTES (the UTF-8 BOM survives; Response.text() would strip it) and throws the server detail on a non-2xx', async () => {
  const bytes = new TextEncoder().encode('\uFEFFvalue,events\r\ndrag,3\r\n');
  Util.fetchTraced = async (url, init) => { calls.push({ url, method: init?.method }); return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }; };
  const out = await JobsClient.artifactCsv(42, 'counts');
  assert.deepEqual([...out.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM bytes kept');
  assert.equal(new TextDecoder().decode(out.slice(3)), 'value,events\r\ndrag,3\r\n');
  assert.equal(path(0), '/jobs/runs/42/artifact?section=counts&format=csv');
  Util.fetchTraced = async () => ({ ok: false, status: 404, json: async () => ({ detail: 'This run has no artifact' }) });
  await assert.rejects(JobsClient.artifactCsv(43, 'counts'), /no artifact/);
});

test('runs: {runs, next_before_id}; getRun and runNow / cancelRun unwrap {run}', async () => {
  reply = body('runs_list');
  const r = await JobsClient.runs({ plant: '1008', jobId: 5, beforeId: 100 });
  assert.equal(path(0), '/jobs/runs?plant=1008&job_id=5&before_id=100&limit=50');
  assert.equal(r.nextBeforeId, 41);
  assert.deepEqual([r.items[0].id, r.items[0].trigger, r.items[0].scheduled_for], [42, 'schedule', '2026-10-29T12:00:00+00:00']);
  reply = body('run_wrapped');
  assert.equal((await JobsClient.getRun(42)).id, 42);
  assert.equal(path(1), '/jobs/runs/42');
  assert.equal((await JobsClient.runNow(5)).status, 'warning');
  assert.deepEqual([calls[2].method, path(2)], ['POST', '/jobs/5/run']);
  assert.equal((await JobsClient.cancelRun(42)).id, 42);
  assert.equal(path(3), '/jobs/runs/42/cancel');
  assert.deepEqual(phantom, []);
});

test('log: lines, last_seq and done drive the poll', async () => {
  reply = body('log');
  const p = await JobsClient.log(42, { afterSeq: 0 });
  assert.equal(path(0), '/jobs/runs/42/log?after_seq=0');
  assert.deepEqual([p.lines.length, p.lastSeq, p.done, p.status, p.truncated], [1, 1, false, 'running', false]);
  assert.deepEqual([p.lines[0].seq, p.lines[0].step, p.lines[0].duration_ms], [1, 'load', 850]);
  reply = { ...body('log'), done: true, status: 'succeeded' };
  assert.equal((await JobsClient.log(42, { afterSeq: 1 })).done, true);
  assert.deepEqual(phantom, []);
});

test('preview: {timezone, cron_expr, entries[{at_utc, at_local, dst_shifted}]}', async () => {
  reply = body('preview');
  const r = await JobsClient.preview('1008', { kind: 'weekly', time_of_day: '08:00', days_of_week: [0, 2, 4] }, 5);
  assert.deepEqual(calls[0].body, { plant: '1008', n: 5, kind: 'weekly', time_of_day: '08:00', days_of_week: [0, 2, 4] });
  assert.deepEqual([r.timezone, r.cronExpr, r.entries[0].atLocal, r.entries[0].atUtc, r.entries[0].dstShifted], ['America/New_York', '0 8 * * mon,wed,fri', '2026-10-30T08:00:00-04:00', '2026-10-30T12:00:00+00:00', false]);
  // The shared entry reader also looks for the job fields that only the upcoming routes carry; those are optional there.
  assert.deepEqual(phantom.filter(k => !/\.entries\[\d+\]\.(job_id|job_name|plant|schedule_id|timezone)$/.test(k)), []);
});

test('upcoming: per-job and across jobs (GET /jobs/upcoming)', async () => {
  reply = body('upcoming_job');
  assert.equal((await JobsClient.upcoming(5, 3))[0].atLocal, '2026-10-30T08:00:00-04:00');
  assert.equal(path(0), '/jobs/5/upcoming?n=3');
  reply = body('upcoming_all');
  const e = (await JobsClient.upcomingAll('1008', 50))[0];
  assert.equal(path(1), '/jobs/upcoming?n=50&plant=1008');
  assert.deepEqual([e.jobId, e.jobName, e.plant, e.timezone], [5, 'Morning optimize', '1008', 'America/New_York']);
  await JobsClient.upcomingAll('', 20);
  assert.equal(path(2), '/jobs/upcoming?n=20');
  assert.deepEqual(phantom, []);
});

test('writes: archive a job, retire a schedule, pause, schedule add / update send preset fields', async () => {
  reply = body('job');
  await JobsClient.remove(5);
  assert.deepEqual([calls[0].method, path(0), calls[0].body], ['PATCH', '/jobs/5', { archived: true }]);
  await JobsClient.setEnabled(5, false);
  assert.deepEqual(calls[1].body, { enabled: false });
  await JobsClient.create({ name: 'n', plant: '1008', job_type: 'optimizer.plant', params: {}, schedules: [{ kind: 'daily', time_of_day: '08:00' }] });
  assert.deepEqual([calls[2].method, path(2)], ['POST', '/jobs']);
  reply = body('schedule');
  await JobsClient.retireSchedule(11);
  assert.deepEqual([calls[3].method, path(3), calls[3].body], ['PATCH', '/jobs/schedules/11', { retired: true }]);
  const s = await JobsClient.addSchedule(5, { kind: 'weekly', time_of_day: '08:00', days_of_week: [0] });
  assert.deepEqual([path(4), s.id, s.kind, s.timezone, s.paused], ['/jobs/5/schedules', 11, 'weekly', 'America/New_York', false]);
  await JobsClient.updateSchedule(11, { time_of_day: '09:00' });
  assert.equal(path(5), '/jobs/schedules/11');
  assert.deepEqual(phantom, []);
});

test('summary: the health strip body (counts, next_fire, scheduler heartbeat, longer_than_usual)', async () => {
  reply = body('summary');
  const h = await JobsClient.summary('1008');
  assert.equal(path(0), '/jobs/summary?plant=1008');
  assert.deepEqual([h.running, h.queued, h.failed24h, h.missed24h, h.warning24h], [1, 0, 2, 0, 1]);
  assert.deepEqual([h.failedConfig24h, h.failedSystem24h, h.failedTransient24h], [1, 0, 1], 'the failed split is read from the body');
  assert.deepEqual([h.nextFire.jobId, h.nextFire.jobName, h.nextFire.plant, h.nextFire.atLocal], [5, 'Morning optimize', '1008', '2026-10-30T08:00:00-04:00']);
  assert.deepEqual([h.scheduler.ok, h.scheduler.lastTickAt, h.longerThanUsual], [true, '2026-10-29T12:00:00+00:00', [43]]);
  assert.deepEqual(phantom, []);
  reply = { ...body('summary'), next_fire: null };
  assert.equal((await JobsClient.summary('')).nextFire, null);
  assert.equal(path(1), '/jobs/summary');
});

test('proposal: rows joined to live orders, count, findings, board match; restart posts and unwraps {run}', async () => {
  reply = body('proposal');
  const p = await JobsClient.proposal(44);
  assert.equal(path(0), '/jobs/runs/44/proposal');
  assert.deepEqual([p.total, p.shown, p.truncated, p.boardMatches, p.findings], [1, 1, false, true, 1]);
  assert.deepEqual([p.rows[0].id, p.rows[0].machine, p.rows[0].finishBefore, p.rows[0].finishAfter, p.rows[0].deltaHours, p.rows[0].status, p.rows[0].changedSince],
    ['1008-100', 'L1', '2026-10-30T10:00:00', '2026-10-30T14:00:00', 4, 'scheduled', false]);
  assert.deepEqual(phantom, []);
  reply = body('run_wrapped');
  assert.equal((await JobsClient.restartRun(42)).id, 42);
  assert.deepEqual([calls[1].method, path(1)], ['POST', '/jobs/runs/42/restart']);
  assert.deepEqual(phantom, []);
});

test('runs: periodicity, scheduled_by and since_hours go on the query', async () => {
  reply = body('runs_list');
  await JobsClient.runs({ plant: '1008', status: 'missed', periodicity: 'daily', scheduledBy: 'schedule', sinceHours: 24 });
  assert.equal(path(0), '/jobs/runs?plant=1008&status=missed&periodicity=daily&scheduled_by=schedule&since_hours=24&limit=50');
});

test('types: the optimizer default result is apply', async () => {
  reply = body('types');
  assert.equal((await JobsClient.types())[0].defaults.apply_mode, 'apply');
});

test('a non-2xx throws the server detail', async () => {
  Util.fetchTraced = async () => ({ ok: false, status: 409, json: async () => ({ detail: 'Run is already succeeded' }) });
  await assert.rejects(JobsClient.cancelRun(1), /Run is already succeeded/);
});

test('a 422 with an array detail reads as field: message, never "HTTP 422"', async () => {
  const { detailText } = await import('../../../frontend/admin-ops/jobs-client.mjs');
  assert.equal(detailText('plain'), 'plain');
  assert.equal(detailText([{ loc: ['body', 'params', 'top_n'], msg: 'Input should be a valid integer', type: 'int_type' }, { loc: ['body', 'name'], msg: 'Field required' }]),
    'top_n: Input should be a valid integer; name: Field required');
  assert.equal(detailText(undefined), '');
  Util.fetchTraced = async () => ({ ok: false, status: 422, json: async () => ({ detail: [{ loc: ['body', 'params', 'top_n'], msg: 'Input should be a valid integer' }] }) });
  await assert.rejects(JobsClient.update(1, { params: { top_n: null } }), /top_n: Input should be a valid integer/);
});

test('artifact columns carry a type; a plain string column reads as text and an unknown type falls back to text', async () => {
  reply = { run_id: 1, sections: [{ key: 'a', title: 'A', columns: ['plain', { key: 'n', label: 'N', type: 'number' }, { key: 'x', label: 'X', type: 'money' }, { key: 'd', type: 'datetime' }], rows: [] }] };
  const a = await JobsClient.artifact(1);
  assert.deepEqual(a.sections[0].columns.map(c => [c.key, c.label, c.type]), [['plain', 'plain', 'text'], ['n', 'N', 'number'], ['x', 'X', 'text'], ['d', 'd', 'datetime']]);
});

// ----------------------------------------------------------------------------------------------- W3a multi-plant
test('job: targets, target_kind / count / skipped, fan_out and the schedule zone mode come through normJob', async () => {
  reply = body('jobs_list');
  const j = (await JobsClient.list({})).items[0];
  assert.deepEqual(j.targets, [{ kind: 'explicit', value: '1008', excluded: false, params_override: { mode: 'spt' } }]);
  assert.deepEqual([j.targetKind, j.targetCount, j.targetSkipped], ['selected', 2, 0]);
  assert.deepEqual(j.fanOut, { stagger_s: 30, max_parallel: 2, fail_fast: false });
  assert.deepEqual([j.schedule.tzMode, j.schedule.fixedTimezone], ['plant', null]);
  assert.equal(j.last_run.batchId, null);
  assert.deepEqual(phantom, []);
});

test('batches: cursor envelope, counts, and one batch with its child runs', async () => {
  reply = body('batches_list');
  const r = await JobsClient.batches({ plant: '1008', status: 'warning', jobId: 5, beforeId: 20, limit: 10 });
  assert.equal(path(0), '/jobs/batches?plant=1008&status=warning&job_id=5&before_id=20&limit=10');
  assert.equal(r.nextBeforeId, 8);
  assert.deepEqual([r.items[0].id, r.items[0].jobName, r.items[0].status, r.items[0].trigger, r.items[0].durationMs], [9, 'Morning optimize', 'warning', 'schedule', 300000]);
  assert.deepEqual(r.items[0].counts, { total: 3, succeeded: 1, warning: 1, skipped: 1 });
  assert.deepEqual(phantom, []);
  reply = body('batch_detail');
  const d = await JobsClient.batch(9);
  assert.equal(path(1), '/jobs/batches/9');
  assert.deepEqual([d.batch.id, d.runs.length, d.runs[0].plant], [9, 1, '1008']);
  assert.deepEqual(phantom, []);
});

test('targetsPreview posts the rows with paging and reads count / skipped / per-plant warnings', async () => {
  reply = body('targets_preview');
  const rows = [{ kind: 'subnetwork', value: 'NA', excluded: false, params_override: null }];
  const r = await JobsClient.targetsPreview(rows, { offset: 5, limit: 10 });
  assert.equal(path(0), '/jobs/targets/preview');
  assert.deepEqual(calls[0].body, { targets: rows, offset: 5, limit: 10 });
  assert.deepEqual([r.count, r.skipped, r.plants[1].warning, r.plants[0].timezone], [1, 1, 'plant has no timezone', 'America/Chicago']);
  assert.deepEqual(phantom, []);
});

test('schedule preview: single plant keeps entries; targets add the plants paging parameters and read per-plant fires', async () => {
  reply = body('preview');
  const one = await JobsClient.preview('1008', { kind: 'daily', time_of_day: '08:00' }, 3);
  assert.deepEqual(calls[0].body, { plant: '1008', n: 3, kind: 'daily', time_of_day: '08:00' }, 'no targets, no paging fields');
  assert.deepEqual([one.entries.length, one.plants, one.totalPlants], [1, [], 1]);
  reply = body('preview_multi');
  const rows = [{ kind: 'explicit', value: '1008', excluded: false, params_override: null }];
  const m = await JobsClient.preview('1008', { kind: 'daily', tz_mode: 'plant' }, 3, { targets: rows, plantOffset: 0, plantLimit: 20 });
  assert.deepEqual([calls[1].body.targets, calls[1].body.plant_offset, calls[1].body.plant_limit], [rows, 0, 20]);
  assert.deepEqual([m.totalPlants, m.plants[0].plant, m.plants[0].timezone, m.plants[0].entries[0].atUtc], [2, '1008', 'America/Chicago', '2026-10-30T13:00:00+00:00']);
  assert.deepEqual(phantom.filter(k => !/entries\[0\]\.(job_id|job_name|plant|schedule_id|timezone)$/.test(k)), [], 'preview entries carry only the fire times (the job fields are the upcoming lists\')');
});

test('run now and restart still answer the run (a batch rides next to it and the run carries its batch_id)', async () => {
  reply = body('batch_run_started');
  const r = await JobsClient.runNow(5);
  assert.equal(r.id, 42);
  assert.deepEqual(phantom, []);
});

test('W3a fix wave: health carries failed_batches_24h, a job carries last_batch, batch detail pages, and batch cancel / restart hit their routes', async () => {
  reply = body('summary');
  assert.equal((await JobsClient.summary('')).failedBatches24h, 1);
  reply = body('jobs_list');
  const j = (await JobsClient.list({})).items[0];
  assert.deepEqual(j.lastBatch, { id: 9, status: 'warning', counts: { total: 3, succeeded: 1, warning: 1, skipped: 1 } });
  reply = body('batch_detail');
  const b = await JobsClient.batch(9, { limit: 50, offset: 100 });
  assert.equal(calls.at(-1).url.endsWith('/jobs/batches/9?limit=50&offset=100'), true);
  assert.equal(b.hasMore, false);
  reply = body('batch_cancelled');
  await JobsClient.cancelBatch(9);
  assert.equal(calls.at(-1).method, 'POST'); assert.match(calls.at(-1).url, /\/jobs\/batches\/9\/cancel$/);
  reply = body('batch_run_started');
  const r = await JobsClient.restartBatch(9);
  assert.match(calls.at(-1).url, /\/jobs\/batches\/9\/restart$/); assert.equal(r.id, 42);
  assert.deepEqual(phantom, [], 'the client read only keys the wire has');
});


// ---- W3b: policy options, skipped occurrences, maintenance mode, the runs timeline ----
test('schedules carry their options and last fire; the preview lists skipped occurrences with their reason codes', async () => {
  reply = body('jobs_list');
  const s = (await JobsClient.list({})).items[0].schedule;
  assert.equal(s.options.closed_day, 'run');
  assert.equal(s.options.catch_up.grace_s, 3600);
  assert.equal(s.lastFireAt, '2026-10-29T12:00:00+00:00');
  reply = body('preview_multi');
  const rows = [{ kind: 'explicit', value: '1008', excluded: false, params_override: null }];
  const m = await JobsClient.preview('1008', { kind: 'daily', tz_mode: 'plant', options: { closed_day: 'skip' } }, 3, { targets: rows });
  assert.equal(calls[1].body.options.closed_day, 'skip', 'options travel with the preview body');
  assert.deepEqual(m.plants[0].skipped.map(x => [x.atUtc, x.reason]), [['2026-10-31T13:00:00+00:00', 'closed_day']]);
  assert.deepEqual([m.skipped, m.plants[0].entries[0].policyNote], [[], null]);
  reply = body('preview');
  assert.deepEqual((await JobsClient.preview('1008', { kind: 'daily' }, 3)).skipped, []);
});

test('maintenance: POST /jobs/maintenance {enabled}, and the summary carries the state', async () => {
  reply = body('maintenance');
  const m = await JobsClient.setMaintenance(true);
  assert.deepEqual([calls[0].method, path(0), calls[0].body], ['POST', '/jobs/maintenance', { enabled: true }]);
  assert.deepEqual([m.enabled, m.by, m.since], [true, 'admin@example.com', '2026-10-29T12:00:00+00:00']);
  reply = body('summary');
  assert.deepEqual((await JobsClient.summary('')).maintenance, { enabled: false, since: null, by: null });
  assert.deepEqual(phantom, []);
});

test('timeline: range, plant and plant paging go in the query; lanes with runs and upcoming fires come out typed', async () => {
  reply = body('timeline');
  const tl = await JobsClient.timeline({ from: '2026-10-29T00:00:00.000Z', to: '2026-10-30T00:00:00.000Z', plant: '1008', plantOffset: 20, plantLimit: 20 });
  assert.equal(path(0), '/jobs/timeline?from=2026-10-29T00%3A00%3A00.000Z&to=2026-10-30T00%3A00%3A00.000Z&plant=1008&plant_offset=20&plant_limit=20');
  assert.deepEqual([tl.totalPlants, tl.plantOffset, tl.plantLimit, tl.truncated, tl.nowUtc], [1, 0, 20, false, '2026-10-29T12:00:00+00:00']);
  const l = tl.lanes[0];
  assert.deepEqual([l.plant, l.timezone, l.nowLocal], ['1008', 'America/Chicago', '2026-10-29T07:00:00-05:00']);
  assert.deepEqual([l.runs[0].id, l.runs[0].status, l.runs[0].startUtc, l.runs[0].endUtc, l.runs[0].batchId], [42, 'warning', '2026-10-29T12:00:01+00:00', '2026-10-29T12:03:40+00:00', null]);
  assert.deepEqual([l.upcoming[0].atUtc, l.upcoming[0].jobName, l.upcoming[0].dstShifted, l.upcoming[0].policyNote], ['2026-10-29T13:00:00+00:00', 'Morning optimize', false, null]);
  assert.deepEqual(phantom, []);
  reply = body('timeline');
  await JobsClient.timeline({ from: 'a', to: 'b' });
  assert.equal(path(1), '/jobs/timeline?from=a&to=b&plant_limit=20', 'no plant filter, first page of 20 lanes');
});