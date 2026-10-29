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

const OPAQUE = new Set(['params', 'summary', 'data', 'params_schema', 'defaults']);
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
  assert.deepEqual([t.key, t.plant_scoped, t.defaults.search, t.defaults.mode], ['optimizer.plant', true, 'exhaustive', 'due_date']);
  assert.deepEqual(phantom, []);
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
