/* =============================================================================
   JOBS CLIENT — the only module that knows the /jobs wire shapes.

   Each function returns a normalised, typed value and throws Error(message) on a non-2xx (the
   server's `detail` when it sent one) so callers toast one string. The wire contract is the
   backend's (backend/jobs/CLAUDE.md, "Route contract"; pinned by tests/test_jobs_contract.py):
   lists answer {jobs|runs, next_before_id}, a run is wrapped as {run}, the log answers
   {run_id,status,log_truncated,done,lines,last_seq}, previews answer {timezone,cron_expr,entries}.
   Run instants are tz-aware ISO; schedule run_at / valid_* are naive plant-local (see jobs-model.mts).
   ========================================================================== */

import { Util, Config } from '../platform/foundation.mjs';
import { buildJobsQuery, buildRunsQuery, buildLogQuery } from './jobs-model.mjs';
import type { JobsQuery, RunsQuery, LogLine, RunSummary, HealthSummary, Proposal } from './jobs-model.mjs';

export interface JobSchedule {
  id: number;
  kind: string;
  cron_expr: string | null;
  time_of_day: string | null;
  days_of_week: number[] | null;
  day_of_month: number | null;
  run_at: string | null;
  timezone: string | null;
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
  /** The job's first live schedule (the dialog manages one); `schedules` is the full list. */
  schedule: JobSchedule | null;
  schedules: JobSchedule[];
  /** UTC instant of the next fire (tz-aware ISO) and the same moment as plant wall clock. */
  next_run_at: string | null;
  next_run_local: string | null;
  last_run: JobRun | null;
}

export interface JobType { key: string; label: string; plant_scoped: boolean; defaults: Record<string, unknown> }

/** One upcoming fire: `atLocal` is the plant wall clock (offset kept on the wire, ignore it), `atUtc` the instant. */
export interface UpcomingEntry {
  atUtc: string; atLocal: string; dstShifted: boolean;
  jobId?: number; jobName?: string; plant?: string; scheduleId?: number; timezone?: string;
}

export interface LogPage { lines: LogLine[]; status: string | null; done: boolean; lastSeq: number; truncated: boolean }

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

const _arr = (data: unknown, key: string): Raw[] => {
  const v = (data as Raw | null)?.[key];
  return Array.isArray(v) ? (v as Raw[]) : [];
};
const _s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const _n = (v: unknown): number | null => (v == null ? null : Number(v));

export function normSchedule(r: Raw): JobSchedule {
  return {
    id: Number(r.id), kind: String(r.kind ?? 'cron'), cron_expr: _s(r.cron_expr), time_of_day: _s(r.time_of_day),
    days_of_week: Array.isArray(r.days_of_week) ? (r.days_of_week as number[]).map(Number) : null,
    day_of_month: _n(r.day_of_month), run_at: _s(r.run_at), timezone: _s(r.timezone),
    valid_from: _s(r.valid_from), valid_until: _s(r.valid_until), paused: !!r.paused, skip_if_running: r.skip_if_running !== false,
  };
}

export function normRun(r: Raw): JobRun {
  return {
    id: Number(r.id), job_id: Number(r.job_id), job_name: String(r.job_name ?? ''), plant: String(r.plant ?? ''),
    status: String(r.status ?? ''), trigger: _s(r.trigger), scheduled_for: _s(r.scheduled_for), started_at: _s(r.started_at),
    ended_at: _s(r.ended_at), duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : null, triggered_by: _s(r.triggered_by),
    summary: (r.summary as RunSummary | null) ?? null, error: _s(r.error), log_truncated: !!r.log_truncated,
  };
}

export function normJob(r: Raw): Job {
  const schedules = Array.isArray(r.schedules) ? (r.schedules as Raw[]).map(normSchedule) : [];
  const lr = r.last_run as Raw | null | undefined;
  return {
    id: Number(r.id), name: String(r.name ?? ''), plant: String(r.plant ?? ''), job_type: String(r.job_type ?? ''),
    params: (r.params as Record<string, unknown> | null) ?? {}, enabled: r.enabled !== false,
    schedule: schedules[0] ?? null, schedules, next_run_at: _s(r.next_run_at), next_run_local: _s(r.next_run_local),
    last_run: lr ? normRun(lr) : null,
  };
}

export function normEntry(r: Raw): UpcomingEntry {
  return {
    atUtc: String(r.at_utc ?? ''), atLocal: String(r.at_local ?? ''), dstShifted: !!r.dst_shifted,
    jobId: r.job_id == null ? undefined : Number(r.job_id), jobName: r.job_name == null ? undefined : String(r.job_name),
    plant: r.plant == null ? undefined : String(r.plant), scheduleId: r.schedule_id == null ? undefined : Number(r.schedule_id),
    timezone: r.timezone == null ? undefined : String(r.timezone),
  };
}

export function normLog(data: unknown): LogPage {
  const d = (data as Raw | null) ?? {};
  const lines = _arr(d, 'lines').map(r => ({
    seq: Number(r.seq), at: _s(r.at), level: String(r.level ?? 'info'), step: _s(r.step), msg: String(r.msg ?? ''),
    duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : null, data: r.data,
  }));
  return { lines, status: _s(d.status), done: d.done === true, lastSeq: Number(d.last_seq ?? 0), truncated: !!d.log_truncated };
}

export function normHealth(data: unknown): HealthSummary {
  const d = (data as Raw | null) ?? {};
  const nf = d.next_fire as Raw | null | undefined;
  const sch = (d.scheduler as Raw | null | undefined) ?? {};
  return {
    running: Number(d.running ?? 0), queued: Number(d.queued ?? 0), failed24h: Number(d.failed_24h ?? 0),
    missed24h: Number(d.missed_24h ?? 0), warning24h: Number(d.warning_24h ?? 0),
    failedConfig24h: Number(d.failed_config_24h ?? 0), failedSystem24h: Number(d.failed_system_24h ?? 0),
    failedTransient24h: Number(d.failed_transient_24h ?? 0),
    nextFire: nf ? { atUtc: String(nf.at_utc ?? ''), atLocal: String(nf.at_local ?? ''), jobId: Number(nf.job_id), jobName: String(nf.job_name ?? ''), plant: String(nf.plant ?? '') } : null,
    scheduler: { ok: sch.ok === true, lastTickAt: _s(sch.last_tick_at) },
    longerThanUsual: Array.isArray(d.longer_than_usual) ? (d.longer_than_usual as unknown[]).map(Number) : [],
  };
}

export function normProposal(data: unknown): Proposal {
  const d = (data as Raw | null) ?? {};
  const rows = _arr(d, 'rows').map(r => ({
    id: String(r.id), machine: _s(r.machine), finishBefore: _s(r.finish_before), finishAfter: _s(r.finish_after),
    deltaHours: typeof r.delta_hours === 'number' ? r.delta_hours : null, status: _s(r.status), changedSince: !!r.changed_since,
  }));
  return {
    runId: Number(d.run_id), total: Number(d.total ?? rows.length), shown: Number(d.shown ?? rows.length), rows,
    findings: _arr(d, 'findings').length, boardMatches: typeof d.board_matches === 'boolean' ? d.board_matches : null, truncated: !!d.truncated,
    pending: d.pending === true,
  };
}

const _cursor = (data: unknown): number | null => { const v = (data as Raw | null)?.next_before_id; return v == null ? null : Number(v); };

export const JobsClient = {
  async types(): Promise<JobType[]> {
    return _arr(await _req('GET', '/jobs/types'), 'types')
      .map(r => ({ key: String(r.key), label: String(r.label ?? r.key), plant_scoped: r.plant_scoped !== false, defaults: (r.defaults as Record<string, unknown> | null) ?? {} }));
  },

  async list(q: JobsQuery): Promise<{ items: Job[]; nextBeforeId: number | null }> {
    const data = await _req('GET', `/jobs${buildJobsQuery(q)}`);
    return { items: _arr(data, 'jobs').map(normJob), nextBeforeId: _cursor(data) };
  },

  async create(job: Raw): Promise<Job> { return normJob((await _req('POST', '/jobs', job)) as Raw); },
  async update(id: number, patch: Raw): Promise<Job> { return normJob((await _req('PATCH', `/jobs/${id}`, patch)) as Raw); },
  /** Pause / resume the whole job. */
  setEnabled(id: number, enabled: boolean): Promise<Job> { return JobsClient.update(id, { enabled }); },
  /** There is no DELETE route: removing a job archives it (history keeps pointing at it). */
  remove(id: number): Promise<Job> { return JobsClient.update(id, { archived: true }); },

  async addSchedule(jobId: number, s: object): Promise<JobSchedule> { return normSchedule((await _req('POST', `/jobs/${jobId}/schedules`, s)) as Raw); },
  async updateSchedule(id: number, s: object): Promise<JobSchedule> { return normSchedule((await _req('PATCH', `/jobs/schedules/${id}`, s)) as Raw); },
  /** Removing a schedule retires it. */
  retireSchedule(id: number): Promise<JobSchedule> { return JobsClient.updateSchedule(id, { retired: true }); },

  /** Next N fire times of an unsaved schedule, from the same trigger the scheduler arms; `dstShifted` flags a time a spring-forward gap moved. */
  async preview(plant: string, s: object, n = 5): Promise<{ timezone: string; cronExpr: string | null; entries: UpcomingEntry[] }> {
    const data = await _req('POST', '/jobs/schedules/preview', { plant, n, ...s }) as Raw | null;
    return { timezone: String(data?.timezone ?? ''), cronExpr: _s(data?.cron_expr), entries: _arr(data, 'entries').map(normEntry) };
  },
  async upcoming(jobId: number, n = 10): Promise<UpcomingEntry[]> { return _arr(await _req('GET', `/jobs/${jobId}/upcoming?n=${n}`), 'entries').map(normEntry); },
  /** Soonest first across the viewer's visible jobs; `plant` narrows it. */
  async upcomingAll(plant: string, n = 20): Promise<UpcomingEntry[]> {
    const qs = `?n=${n}${plant ? `&plant=${encodeURIComponent(plant)}` : ''}`;
    return _arr(await _req('GET', `/jobs/upcoming${qs}`), 'entries').map(normEntry);
  },

  async runNow(jobId: number): Promise<JobRun> { return normRun((((await _req('POST', `/jobs/${jobId}/run`)) as Raw).run) as Raw); },
  /** Run the same job again as a manual run (admin); 409 while a run of it is active. */
  async restartRun(runId: number): Promise<JobRun> { return normRun((((await _req('POST', `/jobs/runs/${runId}/restart`)) as Raw).run) as Raw); },
  /** The job's CURRENT params (what a restart would run with). */
  async jobParams(jobId: number): Promise<Record<string, unknown>> {
    const jobs = await _req('GET', `/jobs?limit=1&before_id=${jobId + 1}&include_archived=true`);
    const j = _arr(jobs, 'jobs').find(x => Number(x.id) === jobId);
    return (j?.params as Record<string, unknown> | undefined) ?? {};
  },
  /** Health strip counts for one plant ('' = all the viewer's plants). */
  async summary(plant: string): Promise<HealthSummary> {
    return normHealth(await _req('GET', `/jobs/summary${plant ? `?plant=${encodeURIComponent(plant)}` : ''}`));
  },
  /** A dry run's proposal joined to the live orders (read-only). */
  async proposal(runId: number): Promise<Proposal> { return normProposal(await _req('GET', `/jobs/runs/${runId}/proposal`)); },
  async cancelRun(runId: number): Promise<JobRun> { return normRun((((await _req('POST', `/jobs/runs/${runId}/cancel`)) as Raw).run) as Raw); },

  async runs(q: RunsQuery): Promise<{ items: JobRun[]; nextBeforeId: number | null }> {
    const data = await _req('GET', `/jobs/runs${buildRunsQuery(q)}`);
    return { items: _arr(data, 'runs').map(normRun), nextBeforeId: _cursor(data) };
  },
  async getRun(runId: number): Promise<JobRun> { return normRun((((await _req('GET', `/jobs/runs/${runId}`)) as Raw).run) as Raw); },

  /** Lines after `afterSeq`; poll with `lastSeq` until `done`. */
  async log(runId: number, o: { afterSeq?: number; level?: string; limit?: number }): Promise<LogPage> {
    return normLog(await _req('GET', `/jobs/runs/${runId}/log${buildLogQuery(o)}`));
  },
};
