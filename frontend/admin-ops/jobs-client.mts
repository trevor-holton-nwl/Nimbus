/* =============================================================================
   JOBS CLIENT — the only module that knows the /jobs wire shapes.

   Each function returns a normalised, typed value and throws Error(message) on a non-2xx (the
   server's `detail` when it sent one) so callers toast one string. Routes follow the plan's
   contract (backend/jobs/). Instants are naive plant-local ISO strings. List endpoints may answer
   a bare array or an envelope; the normalisers accept both.
   ========================================================================== */

import { Util, Config } from '../platform/foundation.mjs';
import { buildJobsQuery, buildRunsQuery, buildLogQuery } from './jobs-model.mjs';
import type { JobsQuery, RunsQuery, LogLine, RunSummary } from './jobs-model.mjs';

export interface JobSchedule {
  id: number;
  kind: string;
  cron_expr: string | null;
  run_at: string | null;
  timezone?: string | null;
  valid_from: string | null;
  valid_until: string | null;
  paused: boolean;
  skip_if_running: boolean;
}

export interface JobRun {
  id: number;
  job_id: number;
  job_name: string;
  plant: string;
  status: string;
  trigger: string | null;
  scheduled_for: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  triggered_by: string | null;
  summary: RunSummary | null;
  error: string | null;
  log_truncated: boolean;
}

export interface Job {
  id: number;
  name: string;
  plant: string;
  job_type: string;
  params: Record<string, unknown>;
  enabled: boolean;
  schedule: JobSchedule | null;
  next_run_at: string | null;
  last_run: Pick<JobRun, 'id' | 'status' | 'ended_at'> | null;
}

export interface JobType { key: string; label: string; plant_scoped: boolean }

type Raw = Record<string, unknown>;
const API = (): string => Config.API_BASE;

async function _req(method: string, path: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = { method };
  if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
  const r = await Util.fetchTraced(`${API()}${path}`, init);
  let data: unknown = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) {
    const d = (data as Raw | null)?.detail;
    throw new Error(typeof d === 'string' && d ? d : `HTTP ${r.status}`);
  }
  return data;
}

const _list = (data: unknown, ...keys: string[]): Raw[] => {
  if (Array.isArray(data)) return data as Raw[];
  for (const k of keys) { const v = (data as Raw | null)?.[k]; if (Array.isArray(v)) return v as Raw[]; }
  return [];
};
const _s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

function _schedule(r: Raw | null | undefined): JobSchedule | null {
  if (!r) return null;
  return {
    id: Number(r.id), kind: String(r.kind ?? 'cron'), cron_expr: _s(r.cron_expr), run_at: _s(r.run_at), timezone: _s(r.timezone),
    valid_from: _s(r.valid_from), valid_until: _s(r.valid_until), paused: !!r.paused, skip_if_running: r.skip_if_running !== false,
  };
}

function _job(r: Raw): Job {
  const sched = (r.schedule as Raw | null | undefined) ?? (Array.isArray(r.schedules) ? (r.schedules as Raw[])[0] : null);
  const lr = r.last_run as Raw | null | undefined;
  return {
    id: Number(r.id), name: String(r.name ?? ''), plant: String(r.plant ?? ''), job_type: String(r.job_type ?? ''),
    params: (r.params as Record<string, unknown> | null) ?? {}, enabled: r.enabled !== false,
    schedule: _schedule(sched), next_run_at: _s(r.next_run_at),
    last_run: lr ? { id: Number(lr.id), status: String(lr.status ?? ''), ended_at: _s(lr.ended_at) } : null,
  };
}

function _run(r: Raw): JobRun {
  return {
    id: Number(r.id), job_id: Number(r.job_id), job_name: String(r.job_name ?? r.name ?? ''), plant: String(r.plant ?? ''),
    status: String(r.status ?? ''), trigger: _s(r.trigger), scheduled_for: _s(r.scheduled_for), started_at: _s(r.started_at),
    ended_at: _s(r.ended_at), duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : null, triggered_by: _s(r.triggered_by),
    summary: (r.summary as RunSummary | null) ?? null, error: _s(r.error), log_truncated: !!r.log_truncated,
  };
}

const _times = (data: unknown): string[] =>
  _list(data, 'runs', 'next', 'upcoming', 'items').map(x => (typeof x === 'string' ? x : String((x as Raw).at ?? (x as Raw).run_at ?? ''))).filter(Boolean);

export const JobsClient = {
  async types(): Promise<JobType[]> {
    return _list(await _req('GET', '/jobs/types'), 'types', 'items')
      .map(r => ({ key: String(r.key), label: String(r.label ?? r.key), plant_scoped: r.plant_scoped !== false }));
  },

  async list(q: JobsQuery): Promise<{ items: Job[]; total: number }> {
    const data = await _req('GET', `/jobs${buildJobsQuery(q)}`);
    const items = _list(data, 'items', 'jobs').map(_job);
    const total = Number((data as Raw | null)?.total);
    return { items, total: Number.isFinite(total) ? total : items.length };
  },

  async create(job: Raw): Promise<Job> { return _job((await _req('POST', '/jobs', job)) as Raw); },
  async update(id: number, patch: Raw): Promise<Job> { return _job((await _req('PATCH', `/jobs/${id}`, patch)) as Raw); },
  /** Pause / resume the whole job. */
  setEnabled(id: number, enabled: boolean): Promise<Job> { return JobsClient.update(id, { enabled }); },
  /** The contract has no DELETE route; a delete is a soft PATCH the server turns into a tombstone. */
  remove(id: number): Promise<Job> { return JobsClient.update(id, { deleted: true }); },

  async addSchedule(jobId: number, s: Raw): Promise<JobSchedule | null> { return _schedule((await _req('POST', `/jobs/${jobId}/schedules`, s)) as Raw); },
  async updateSchedule(id: number, s: Raw): Promise<JobSchedule | null> { return _schedule((await _req('PATCH', `/jobs/schedules/${id}`, s)) as Raw); },

  /** Next N fire times of an unsaved schedule, computed by the same trigger the scheduler uses; `dst` flags a skipped / repeated local hour. */
  async preview(plant: string, s: Raw, n = 5): Promise<{ runs: string[]; dst: boolean }> {
    const data = await _req('POST', '/jobs/schedules/preview', { plant, n, ...s });
    return { runs: _times(data), dst: !!(data as Raw | null)?.dst_warning };
  },
  async upcoming(jobId: number, n = 10): Promise<string[]> { return _times(await _req('GET', `/jobs/${jobId}/upcoming?n=${n}`)); },

  async runNow(jobId: number): Promise<JobRun | null> {
    const d = (await _req('POST', `/jobs/${jobId}/run`)) as Raw | null;
    return d && d.id != null ? _run(d) : null;
  },
  cancelRun(runId: number): Promise<unknown> { return _req('POST', `/jobs/runs/${runId}/cancel`); },

  async runs(q: RunsQuery): Promise<{ items: JobRun[]; nextBeforeId: number | null }> {
    const data = await _req('GET', `/jobs/runs${buildRunsQuery(q)}`);
    const items = _list(data, 'items', 'runs').map(_run);
    const nb = (data as Raw | null)?.next_before_id;
    return { items, nextBeforeId: nb == null ? null : Number(nb) };
  },

  /** Lines after `afterSeq`; `status` rides along so the 2 s poll can stop once the run ends. */
  async log(runId: number, o: { afterSeq?: number; level?: string }): Promise<{ lines: LogLine[]; status: string | null }> {
    const data = await _req('GET', `/jobs/runs/${runId}/log${buildLogQuery(o)}`);
    const lines = _list(data, 'items', 'lines').map(r => ({
      seq: Number(r.seq), at: _s(r.at), level: String(r.level ?? 'info'), step: _s(r.step), msg: String(r.msg ?? ''),
      duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : null, data: r.data,
    }));
    const st = (data as Raw | null)?.status ?? ((data as Raw | null)?.run as Raw | undefined)?.status;
    return { lines, status: st == null ? null : String(st) };
  },
};
