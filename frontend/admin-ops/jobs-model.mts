/* =============================================================================
   JOBS MODEL — the pure half of Admin > Jobs (no DOM, no Store, no fetch, no imports).

   Everything here is a function of its arguments: translation and HTML escaping arrive through a
   `JobsDeps` the caller injects (`t`, `esc`, optional `fmtTime`), so the node tests drive it with
   plain stubs. The client owns wire shapes (jobs-client.mts); the pane, dialog and run detail own the DOM.

   Times (backend contract, backend/jobs/CLAUDE.md): run and created/modified instants are tz-aware ISO
   strings (TIMESTAMPTZ), schedule run_at / valid_from / valid_until are naive plant-local, and the
   preview / upcoming entries carry both `at_utc` and `at_local`. Display always goes through
   plantWall() so a viewer in another zone still reads the plant's wall clock; Util.fmtDTPref then
   applies the viewer's date/time format. Schedules are sent as PRESET kinds with time_of_day,
   days_of_week (0 = Monday .. 6 = Sunday) and day_of_month; the server compiles the cron.
   */

export interface JobsDeps {
  t: (key: string, vars?: Record<string, string | number>) => string;
  esc: (s: unknown) => string;
  /** Hour + minute -> the viewer's time format (Util._fmtTimePref); defaults to HH:MM. */
  fmtTime?: (hour: number, minute: number) => string;
}

/* ---------------------------------------------------------------------------
   Status
   ------------------------------------------------------------------------- */
/** The wire statuses plus `missed` (a synthetic filter: a skipped run recorded for a misfire). Labels follow SAP's
 *  job monitor: scheduled = Queued, succeeded = Finished, warning = Finished with warnings. */
export const RUN_STATUSES = ['scheduled', 'running', 'succeeded', 'warning', 'failed', 'cancelled', 'skipped', 'missed'] as const;
export type RunStatus = typeof RUN_STATUSES[number];

/** Existing badge classes only; the label is always shown beside the colour. */
const STATUS_BADGE: Record<RunStatus, string> = {
  scheduled: 'badge-muted', running: 'badge-info', succeeded: 'badge-ok', warning: 'badge-warn',
  failed: 'badge-err', cancelled: 'badge-muted', skipped: 'badge-muted', missed: 'badge-warn',
};

export function statusBadgeClass(status: string | null | undefined): string {
  return STATUS_BADGE[status as RunStatus] ?? 'badge-muted';
}

export function statusLabel(status: string | null | undefined, d: JobsDeps): string {
  return (RUN_STATUSES as readonly string[]).includes(String(status)) ? d.t(`jobs.status_${status}`) : String(status ?? '');
}

/** The backend records a misfire as `skipped` with an error starting `missed:`; the UI shows it as Missed. */
export const MISSED_PREFIX = 'missed:';
export function displayStatus(run: { status: string; error?: string | null } | null | undefined): string {
  if (!run) return '';
  return run.status === 'skipped' && String(run.error ?? '').startsWith(MISSED_PREFIX) ? 'missed' : run.status;
}

export function statusBadgeHtml(status: string | null | undefined, d: JobsDeps): string {
  if (!status) return '';
  // A static dot (no animation) marks a run that is going now; the text label always follows it.
  const dot = status === 'running' ? '<i class="job-dot" aria-hidden="true"></i>' : '';
  return `<span class="badge ${statusBadgeClass(status)} job-status">${dot}${d.esc(statusLabel(status, d))}</span>`;
}

/** A run's badge: Missed for a misfire, else its status; Skipped carries the reason beside it. */
export function runStatusHtml(run: { status: string; error?: string | null }, d: JobsDeps): string {
  const shown = displayStatus(run);
  const reason = shown === 'skipped' && run.error ? ` <span class="job-sub">${d.esc(run.error)}</span>` : '';
  return statusBadgeHtml(shown, d) + reason;
}

export type ErrorKind = 'config' | 'system' | 'transient';
/** `error_kind` from a failed run's summary; anything else is unknown (no badge). `transient` = the board changed. */
export function errorKindOf(summary: { error_kind?: string | null } | null | undefined): ErrorKind | null {
  const k = summary?.error_kind;
  return k === 'config' || k === 'system' || k === 'transient' ? k : null;
}

export function isActiveRun(status: string | null | undefined): boolean {
  return status === 'running' || status === 'scheduled';
}

/* ---------------------------------------------------------------------------
   Recurrence: preset <-> cron, cron -> prose
   ------------------------------------------------------------------------- */
export const RECUR_PRESETS = ['once', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'cron'] as const;
export type RecurPreset = typeof RECUR_PRESETS[number];

export interface Recurrence {
  preset: RecurPreset;
  /** 'HH:MM' (daily / weekdays / weekly / monthly). */
  time: string;
  /** Minute past the hour (hourly). */
  minute: number;
  /** Backend weekday numbers, 0 = Monday .. 6 = Sunday (weekly). */
  days: number[];
  /** Day of month 1-31 (monthly). */
  dom: number;
  cron: string;
  /** Plant-local 'YYYY-MM-DDTHH:MM' (once). */
  runAt: string;
}

export const DEFAULT_TIME = '08:00';

export function defaultRecurrence(): Recurrence {
  return { preset: 'daily', time: DEFAULT_TIME, minute: 0, days: [0, 1, 2, 3, 4], dom: 1, cron: '', runAt: '' };
}

/** 'HH:MM' -> [hour, minute], or null when it is not a valid 24-hour time. */
export function parseTime(s: string | null | undefined): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? [h, mi] : null;
}

/** A cheap shape check (five whitespace-separated fields of cron characters); the server's trigger is the authority. */
export function isValidCronShape(c: string | null | undefined): boolean {
  const p = String(c ?? '').trim().split(/\s+/);
  return p.length === 5 && p.every(f => /^[\d*/,\-A-Za-z?LW#]+$/.test(f));
}

const _isNum = (s: string): boolean => /^\d+$/.test(s);
const _pad2 = (n: number): string => String(n).padStart(2, '0');

/** The ScheduleIn body for a recurrence (only the fields its kind reads, so a PATCH never carries stale ones). */
export interface ScheduleIn {
  kind: RecurPreset;
  time_of_day?: string;
  days_of_week?: number[];
  day_of_month?: number;
  cron_expr?: string;
  run_at?: string;
}
export function recurrenceToScheduleIn(r: Recurrence): ScheduleIn {
  switch (r.preset) {
    case 'once': return { kind: 'once', run_at: r.runAt };
    case 'hourly': return { kind: 'hourly', time_of_day: `00:${_pad2(Number(r.minute) || 0)}` };
    case 'weekly': return { kind: 'weekly', time_of_day: r.time, days_of_week: [...new Set(r.days)].sort((a, b) => a - b) };
    case 'monthly': return { kind: 'monthly', time_of_day: r.time, day_of_month: Number(r.dom) };
    case 'cron': return { kind: 'cron', cron_expr: String(r.cron).trim().replace(/\s+/g, ' ') };
    default: return { kind: r.preset, time_of_day: r.time };
  }
}

export interface ScheduleWire {
  kind?: string | null;
  time_of_day?: string | null;
  days_of_week?: number[] | null;
  day_of_month?: number | null;
  cron_expr?: string | null;
  run_at?: string | null;
}

/** A saved schedule back into the editable recurrence. */
export function scheduleToRecurrence(s: ScheduleWire | null | undefined): Recurrence {
  const base = defaultRecurrence();
  if (!s) return base;
  const kind = (RECUR_PRESETS as readonly string[]).includes(String(s.kind)) ? (s.kind as RecurPreset) : 'cron';
  const tm = parseTime(s.time_of_day);
  const time = tm ? `${_pad2(tm[0])}:${_pad2(tm[1])}` : base.time;
  switch (kind) {
    case 'once': return { ...base, preset: 'once', runAt: String(s.run_at ?? '').slice(0, 16) };
    case 'hourly': return { ...base, preset: 'hourly', minute: tm ? tm[1] : 0 };
    case 'weekly': return { ...base, preset: 'weekly', time, days: s.days_of_week?.length ? [...s.days_of_week] : base.days };
    case 'monthly': return { ...base, preset: 'monthly', time, dom: s.day_of_month ?? 1 };
    case 'cron': return { ...base, preset: 'cron', cron: String(s.cron_expr ?? '') };
    default: return { ...base, preset: kind, time };
  }
}

const _defaultFmtTime = (h: number, m: number): string => `${_pad2(h)}:${_pad2(m)}`;

/** Plain-language reading of a stored cron (kind 'cron'), or null when it is not a shape we can phrase (the UI then shows the raw cron). */
export function cronProse(cron: string | null | undefined, d: JobsDeps): string | null {
  const c = String(cron ?? '').trim();
  if (!c) return null;
  const p = c.split(/\s+/);
  if (p.length !== 5) return null;
  const [mi, ho, dom, mon, dow] = p;
  const fmt = d.fmtTime ?? _defaultFmtTime;
  if (mi.startsWith('*/') && ho === '*' && dom === '*' && mon === '*' && dow === '*' && _isNum(mi.slice(2))) {
    return d.t('jobs.cron_every_minutes', { n: mi.slice(2) });
  }
  if (_isNum(mi) && ho.startsWith('*/') && dom === '*' && mon === '*' && dow === '*' && _isNum(ho.slice(2))) {
    return d.t('jobs.cron_every_hours', { n: ho.slice(2), m: mi });
  }
  if (_isNum(mi) && ho === '*' && dom === '*' && mon === '*' && dow === '*') return d.t('jobs.cron_hourly', { m: mi });
  if (!_isNum(mi) || !_isNum(ho) || mon !== '*') return null;
  const time = fmt(Number(ho), Number(mi));
  if (dom === '*' && dow === '*') return d.t('jobs.cron_daily', { time });
  if (_isNum(dom) && dow === '*') return d.t('jobs.cron_monthly', { dom, time });
  return null;
}

/** Locale key for a backend weekday number (0 = Monday); the existing keys are numbered 0 = Sunday. */
export const dowLabelKey = (d: number): string => `jobs.dow_${(d + 1) % 7}`;

export interface ScheduleLike extends ScheduleWire {
  paused?: boolean | null;
}

/** One-line recurrence for the table, read from the stored preset fields (the pane formats run_at through Util.fmtDTPref). */
export function recurrenceText(s: ScheduleLike | null | undefined, d: JobsDeps, fmtDT: (iso: string) => string): string {
  if (!s) return d.t('jobs.no_schedule');
  const tm = parseTime(s.time_of_day);
  const time = tm ? (d.fmtTime ?? _defaultFmtTime)(tm[0], tm[1]) : '';
  switch (s.kind) {
    case 'once': return d.t('jobs.once_at', { when: fmtDT(String(s.run_at ?? '')) });
    case 'hourly': return d.t('jobs.cron_hourly', { m: tm ? tm[1] : 0 });
    case 'daily': return d.t('jobs.cron_daily', { time });
    case 'weekdays': return d.t('jobs.cron_weekdays', { time });
    case 'weekly': return d.t('jobs.cron_weekly', { days: [...(s.days_of_week ?? [])].sort((a, b) => a - b).map(x => d.t(dowLabelKey(x))).join(', '), time });
    case 'monthly': return d.t('jobs.cron_monthly', { dom: s.day_of_month ?? '', time });
    default: return cronProse(s.cron_expr, d) ?? String(s.cron_expr ?? d.t('jobs.no_schedule'));
  }
}

/* ---------------------------------------------------------------------------
   Query builders (both lists page by a before_id cursor: no total count, a Load more button)
   ------------------------------------------------------------------------- */
export const JOBS_PAGE = 50;
export const RUNS_PAGE = 50;

function _qs(pairs: Array<[string, string | number | null | undefined]>): string {
  const sp = pairs.filter(([, v]) => v !== null && v !== undefined && String(v) !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return sp.length ? `?${sp.join('&')}` : '';
}

export interface JobsQuery { plant?: string; q?: string; status?: string; type?: string; limit?: number; beforeId?: number | string | null }
export function buildJobsQuery(o: JobsQuery): string {
  const limit = Math.max(1, Math.min(200, Math.floor(o.limit ?? JOBS_PAGE)));
  return _qs([['plant', o.plant], ['q', (o.q ?? '').trim()], ['status', o.status], ['job_type', o.type], ['before_id', o.beforeId], ['limit', limit]]);
}

export interface RunsQuery {
  plant?: string; status?: string; beforeId?: number | string | null; limit?: number; jobId?: number | string;
  /** Schedule kind (or `manual`), `triggered_by` ('schedule' or an admin email) and a look-back window in hours. */
  periodicity?: string; scheduledBy?: string; sinceHours?: number;
  /** Job type key (`optimizer.plant`). */
  jobType?: string;
}
export function buildRunsQuery(o: RunsQuery): string {
  const limit = Math.max(1, Math.min(200, Math.floor(o.limit ?? RUNS_PAGE)));
  return _qs([['plant', o.plant], ['status', o.status], ['job_id', o.jobId], ['job_type', o.jobType], ['periodicity', o.periodicity],
    ['scheduled_by', (o.scheduledBy ?? '').trim()], ['since_hours', o.sinceHours], ['before_id', o.beforeId], ['limit', limit]]);
}

export const PERIODICITIES = ['once', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'cron', 'manual'] as const;

/** The server's log page is 500 lines by default and 2000 at most; the viewer asks for the most so it pages less. */
export const LOG_PAGE = 2000;

export function buildLogQuery(o: { afterSeq?: number | null; level?: string; limit?: number }): string {
  return _qs([['after_seq', o.afterSeq ?? 0], ['level', o.level && o.level !== 'all' ? o.level : null], ['limit', o.limit ?? null]]);
}

/** Runs list: page 1 read again by the poll merged into whatever is already loaded (later pages stay), newest id first. */
export function mergeRuns<T extends { id: number }>(existing: T[], firstPage: T[]): T[] {
  const byId = new Map<number, T>();
  for (const r of existing) byId.set(r.id, r);
  for (const r of firstPage) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

/* ---------------------------------------------------------------------------
   Plant wall clock
   ------------------------------------------------------------------------- */
const _OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/;

/** An ISO string as a naive plant wall-clock 'YYYY-MM-DDTHH:MM:SS' for Util.fmtDTPref. A string with an offset is an
 *  instant, converted into `tz`; with no `tz` it is returned untouched (the viewer's zone). A naive string is already wall. */
export function plantWall(iso: string | null | undefined, tz?: string | null): string {
  const s = String(iso ?? '').trim();
  if (!s || !_OFFSET_RE.test(s)) return s;
  const t = String(tz ?? '').trim();
  if (!t) return s;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return s;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: t, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
    const g = (k: string): string => parts.find(p => p.type === k)?.value ?? '00';
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}`;
  } catch { return s; }
}

/** Short zone name for a time suffix ('CDT', 'GMT+1'), read at the instant when `iso` carries an offset (else now);
 *  the IANA id when the zone has no short form; '' when the plant has no timezone. */
export function tzShort(tz: string | null | undefined, iso?: string | null): string {
  const z = String(tz ?? '').trim();
  if (!z) return '';
  try {
    const s = String(iso ?? '');
    const at = _OFFSET_RE.test(s) && Number.isFinite(Date.parse(s)) ? new Date(s) : new Date();
    return new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'short' }).formatToParts(at).find(p => p.type === 'timeZoneName')?.value ?? z;
  } catch { return z; }
}

/** An `at_local` value: the plant wall clock with its offset dropped. */
export const stripOffset = (iso: string | null | undefined): string => String(iso ?? '').replace(_OFFSET_RE, '');

/* ---------------------------------------------------------------------------
   Run log: merge / dedupe by seq, level filter, text for copy + download
   ------------------------------------------------------------------------- */
export interface LogLine {
  seq: number;
  at?: string | null;
  level: string;
  step?: string | null;
  msg: string;
  duration_ms?: number | null;
  data?: unknown;
}

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const LEVEL_RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Union by seq (an incoming line replaces the stored one with the same seq), ascending. A 2 s poll can overlap. */
export function mergeLog(existing: LogLine[], incoming: LogLine[]): LogLine[] {
  if (!incoming.length) return existing;
  const bySeq = new Map<number, LogLine>();
  for (const l of existing) bySeq.set(l.seq, l);
  for (const l of incoming) bySeq.set(l.seq, l);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function lastSeq(lines: LogLine[]): number {
  return lines.length ? lines[lines.length - 1].seq : 0;
}

/** Level is a minimum ('warn' keeps warn + error); `q` is a case-insensitive substring over step and message. */
export function filterLog(lines: LogLine[], o: { level?: string; q?: string }): LogLine[] {
  const min = o.level && o.level !== 'all' ? (LEVEL_RANK[o.level] ?? 0) : 0;
  const q = (o.q ?? '').trim().toLowerCase();
  return lines.filter(l => (LEVEL_RANK[l.level] ?? 1) >= min
    && (!q || `${l.step ?? ''} ${l.msg}`.toLowerCase().includes(q)));
}

/** One plain-text line for Copy / Download. `fmtAt` is the display-pref formatter (Util.fmtDTPref). */
export function formatLogLine(l: LogLine, fmtAt: (iso: string) => string): string {
  const when = l.at ? fmtAt(l.at) : '';
  const step = l.step ? ` [${l.step}]` : '';
  const dur = l.duration_ms != null ? ` (${durationText(l.duration_ms)})` : '';
  return `${when} ${String(l.level).toUpperCase()}${step} ${l.msg}${dur}`.trim();
}

export function logToText(lines: LogLine[], fmtAt: (iso: string) => string): string {
  return lines.map(l => formatLogLine(l, fmtAt)).join('\n');
}

/** Offset of a log line from the run's start, '+0:03.2' style; '' when either instant is missing. */
export function elapsedText(at: string | null | undefined, startIso: string | null | undefined): string {
  const a = Date.parse(String(at ?? '')); const s = Date.parse(String(startIso ?? ''));
  if (!Number.isFinite(a) || !Number.isFinite(s)) return '';
  const ms = Math.max(0, a - s);
  const m = Math.floor(ms / 60000); const sec = (ms - m * 60000) / 1000;
  return `+${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
}

/** Index (within `lines`) of the first error-level line, or -1. */
export function firstErrorIndex(lines: LogLine[]): number {
  return lines.findIndex(l => l.level === 'error');
}

/** A line's structured `data` as indented JSON for the collapsed detail under it; null when there is none. */
export function lineDataText(data: unknown): string | null {
  if (data == null) return null;
  if (typeof data === 'object' && !Array.isArray(data) && !Object.keys(data as object).length) return null;
  if (Array.isArray(data) && !data.length) return null;
  try { return JSON.stringify(data, null, 2); } catch { return String(data); }
}

/** Plain text for "copy / download errors": error lines (and their data) of the whole log. */
export function errorsToText(lines: LogLine[], fmtAt: (iso: string) => string): string {
  return lines.filter(l => l.level === 'error').map(l => {
    const d = lineDataText(l.data);
    return formatLogLine(l, fmtAt) + (d ? `\n${d}` : '');
  }).join('\n');
}

/** Whether a run is taking longer than usual: the server names the ids in `GET /jobs/summary`. */
export const isLongerThanUsual = (runId: number, ids: ReadonlyArray<number> | null | undefined): boolean => !!ids && ids.includes(runId);

/** Elapsed ms of a run that has not ended (now - started_at); null when it has not started. */
export function elapsedMs(startedAt: string | null | undefined, endedAt: string | null | undefined, nowMs: number): number | null {
  const s = Date.parse(String(startedAt ?? ''));
  if (!Number.isFinite(s)) return null;
  const e = endedAt ? Date.parse(endedAt) : nowMs;
  return Math.max(0, (Number.isFinite(e) ? e : nowMs) - s);
}

/* ---------------------------------------------------------------------------
   Health strip (GET /jobs/summary)
   ------------------------------------------------------------------------- */
export interface HealthSummary {
  running: number; queued: number; failed24h: number; missed24h: number; warning24h: number;
  /** The failed count split by `error_kind`: fix the job / platform error / the board changed under the run. */
  failedConfig24h: number; failedSystem24h: number; failedTransient24h: number;
  nextFire: { atUtc: string; atLocal: string; jobId: number; jobName: string; plant: string } | null;
  scheduler: { ok: boolean; lastTickAt: string | null };
  longerThanUsual: number[];
}

export type HealthKey = 'running' | 'queued' | 'failed' | 'missed' | 'next';
export interface HealthTile {
  key: HealthKey; value: number | null; tone: '' | 'warn' | 'err';
  /** The filter a click applies: a run status (Runs tab, optionally last 24 h), or the Upcoming tab. */
  status?: string; sinceHours?: number; tab: 'runs' | 'upcoming';
}

/** Five tiles in fixed order; Failed goes red and Missed amber only when above zero. */
export function healthTiles(h: HealthSummary): HealthTile[] {
  return [
    { key: 'running', value: h.running, tone: '', status: 'running', tab: 'runs' },
    { key: 'queued', value: h.queued, tone: '', status: 'scheduled', tab: 'runs' },
    { key: 'failed', value: h.failed24h, tone: h.failed24h > 0 ? 'err' : '', status: 'failed', sinceHours: 24, tab: 'runs' },
    { key: 'missed', value: h.missed24h, tone: h.missed24h > 0 ? 'warn' : '', status: 'missed', sinceHours: 24, tab: 'runs' },
    { key: 'next', value: null, tone: '', tab: 'upcoming' },
  ];
}

export const HEARTBEAT_STALE_S = 180;
/** 'ok' while the server says so and the tick is under 3 min old (by the viewer's clock too); 'none' before the first tick. */
export function heartbeatState(s: HealthSummary['scheduler'], nowMs: number): { state: 'ok' | 'stale' | 'none'; ageS: number } {
  const at = Date.parse(String(s.lastTickAt ?? ''));
  if (!Number.isFinite(at)) return { state: 'none', ageS: 0 };
  const ageS = Math.max(0, Math.round((nowMs - at) / 1000));
  return { state: s.ok && ageS <= HEARTBEAT_STALE_S ? 'ok' : 'stale', ageS };
}

/** 12 s / 3 min: language-neutral, for "last tick 12 s ago". */
export function ageText(ageS: number): string {
  return ageS < 60 ? `${ageS} s` : ageS < 3600 ? `${Math.floor(ageS / 60)} min` : `${Math.floor(ageS / 3600)} h`;
}

/** The Jobs list polls (30 s) while anything is going: the summary's live counts, or a loaded job whose last run is active. */
export function shouldPollJobs(h: HealthSummary | null, jobs: ReadonlyArray<{ last_run: { status: string } | null }>): boolean {
  return !!h && (h.running + h.queued > 0) || jobs.some(j => isActiveRun(j.last_run?.status));
}

/** Sequential bulk action over loaded rows: one failure never stops the rest; reports counts and the first message. */
export async function runSequential<T>(items: T[], fn: (item: T) => Promise<unknown>): Promise<{ ok: number; failed: number; firstError: string }> {
  let ok = 0; let failed = 0; let firstError = '';
  for (const it of items) {
    try { await fn(it); ok++; } catch (e) { failed++; if (!firstError) firstError = (e as Error).message; }
  }
  return { ok, failed, firstError };
}

/* ---------------------------------------------------------------------------
   Dry-run proposal (GET /jobs/runs/{id}/proposal)
   ------------------------------------------------------------------------- */
export interface ProposalRow { id: string; machine: string | null; finishBefore: string | null; finishAfter: string | null; deltaHours: number | null; status: string | null; changedSince: boolean }
export interface Proposal { runId: number; total: number; shown: number; rows: ProposalRow[]; findings: number; boardMatches: boolean | null; truncated: boolean; pending: boolean }

/** +4.0 h / -1.5 h / 0 h; '' when unknown. */
export function deltaText(h: number | null | undefined): string {
  if (h == null || !Number.isFinite(h)) return '';
  return `${h > 0 ? '+' : ''}${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

/** Whether a run is a dry run (an optimizer run whose result mode is Dry run); the proposal route 400s otherwise. */
export function isDryRun(summary: { apply_mode?: string | null } | null | undefined): boolean {
  return summary?.apply_mode === 'propose';
}

/* ---------------------------------------------------------------------------
   Run detail helpers
   ------------------------------------------------------------------------- */
/** 850 ms / 4.2 s / 3 min 36 s / 1 h 05 min. Compact, language-neutral units. */
export function durationText(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60); const rs = Math.round(s - m * 60);
  if (m < 60) return `${m} min ${String(rs).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export interface StepTiming { step: string; duration_ms: number }
export interface StepSegment { step: string; ms: number; pct: number; label: string }

/** Proportional widths for the step-timing bar; a segment never drops below 2 % so it stays visible. */
export function stepSegments(steps: StepTiming[] | null | undefined): StepSegment[] {
  const list = (steps ?? []).filter(s => s && s.duration_ms > 0);
  const total = list.reduce((a, s) => a + s.duration_ms, 0);
  if (!total) return [];
  return list.map(s => ({ step: s.step, ms: s.duration_ms, pct: Math.max(2, Math.round((s.duration_ms / total) * 1000) / 10), label: durationText(s.duration_ms) }));
}

export interface RunSummary {
  late?: number | null; changeovers?: number | null; moved?: number | null; applied?: number | null; dropped?: number | null;
  action_id?: string | number | null; steps?: StepTiming[] | null;
  /** Failed runs: config = fix the job or its inputs, system = fix the platform; the step the failure came from. */
  error_kind?: string | null; failed_step?: string | null;
  /** The optimizer's result mode: `apply` or `propose` (a dry run). */
  apply_mode?: string | null;
  /** Report runs: rows per section (before the size cap), the stored artifact's facts and the window the run resolved. */
  row_counts?: Record<string, number> | null;
  artifact?: { size_bytes?: number; truncated?: boolean } | null;
  window?: { start: string; end: string; label: string; timezone: string } | null;
}
export const RESULT_TILES = ['late', 'changeovers', 'moved', 'applied', 'dropped'] as const;

/** Tiles in fixed order; a count the run did not report is omitted, not shown as zero. */
export function resultTiles(s: RunSummary | null | undefined): Array<{ key: typeof RESULT_TILES[number]; value: number }> {
  if (!s) return [];
  const out: Array<{ key: typeof RESULT_TILES[number]; value: number }> = [];
  for (const k of RESULT_TILES) { const v = s[k]; if (typeof v === 'number' && Number.isFinite(v)) out.push({ key: k, value: v }); }
  return out;
}

/* ---------------------------------------------------------------------------
   Upcoming: the next-N list and the 7-day strip
   ------------------------------------------------------------------------- */
/** Day key (YYYY-MM-DD) of a naive ISO string, read from its text so no zone shift can creep in. */
export function isoDayKey(iso: string | null | undefined): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso ?? ''));
  return m ? m[1] : '';
}

export function addDays(dayKey: string, n: number): string {
  const [y, mo, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export interface UpcomingRun { at: string; jobId?: number | string; jobName?: string; plant?: string }
export interface StripDay { day: string; runs: UpcomingRun[] }

/** Seven consecutive day buckets from `startDay` (the plant's today); runs outside the week are ignored. */
export function weekStrip(runs: UpcomingRun[], startDay: string): StripDay[] {
  const days: StripDay[] = Array.from({ length: 7 }, (_, i) => ({ day: addDays(startDay, i), runs: [] }));
  for (const r of runs) { const b = days.find(x => x.day === isoDayKey(r.at)); if (b) b.runs.push(r); }
  for (const b of days) b.runs.sort((x, y) => x.at.localeCompare(y.at));
  return days;
}

/** `GET /jobs/upcoming` is soonest-first and capped at `requested` entries. When the cap was reached the week may be
 *  incomplete: returns the day (of the last entry returned) up to which the list is complete, else null. */
export function stripCompleteThrough(runs: UpcomingRun[], requested: number): string | null {
  if (runs.length < requested || !runs.length) return null;
  return isoDayKey(runs[runs.length - 1].at) || null;
}

/* ---------------------------------------------------------------------------
   Job types and their params (GET /jobs/types)
   ------------------------------------------------------------------------- */
export type JobKind = 'action' | 'report';
export type ParamType = 'string' | 'enum' | 'boolean' | 'integer' | 'number' | 'multi_enum' | 'date_window';

/** One param as the server describes it (registry.describe_params): the generic form renders from this. */
export interface ParamMeta {
  key: string; type: ParamType; labelKey: string; title: string; default: unknown; required: boolean;
  enum?: string[]; enumLabelKeys?: Record<string, string>; min?: number; max?: number; pattern?: string; widget?: string | null;
}
export interface TypeMeta {
  key: string; label: string; kind: JobKind; mutates: boolean; plantScoped: boolean;
  params: ParamMeta[]; defaults: Record<string, unknown>;
}

/** Strings the optimizer's params already had before the generic form: reused so no translation is duplicated. */
export const LABEL_ALIASES: Record<string, string> = {
  'jobs.p.optimizer.plant.mode': 'jobs.f_mode',
  'jobs.p.optimizer.plant.mode.due_date': 'jobs.mode_due_date',
  'jobs.p.optimizer.plant.mode.min_changeover': 'jobs.mode_min_changeover',
  'jobs.p.optimizer.plant.mode.spt': 'jobs.mode_spt',
  'jobs.p.optimizer.plant.search': 'jobs.f_search',
  'jobs.p.optimizer.plant.search.normal': 'jobs.search_normal',
  'jobs.p.optimizer.plant.search.exhaustive': 'jobs.search_exhaustive',
  'jobs.p.optimizer.plant.search.hint': 'jobs.search_note',
  'jobs.p.optimizer.plant.respect_firmed': 'jobs.f_firmed',
  'jobs.p.optimizer.plant.apply_mode': 'jobs.f_result',
  'jobs.p.optimizer.plant.apply_mode.apply': 'jobs.result_apply',
  'jobs.p.optimizer.plant.apply_mode.propose': 'jobs.result_propose',
  'jobs.type.optimizer.plant': 'jobs.type_optimizer',
};

/** The translation for `key` (or its legacy alias), or '' when neither exists. */
export function tryKey(key: string, d: Pick<JobsDeps, 't'>): string {
  for (const k of [key, LABEL_ALIASES[key]]) { if (k) { const v = d.t(k); if (v && v !== k) return v; } }
  return '';
}

export const paramLabel = (m: ParamMeta, d: Pick<JobsDeps, 't'>): string => tryKey(m.labelKey, d) || m.title;
export const enumLabel = (m: ParamMeta, v: string, d: Pick<JobsDeps, 't'>): string => tryKey(m.enumLabelKeys?.[v] ?? `${m.labelKey}.${v}`, d) || v;
/** The hint under a param (`jobs.p.<type>.<param>.hint`, or an alias), '' when it has none. */
export const paramHint = (m: ParamMeta, d: Pick<JobsDeps, 't'>): string => tryKey(`${m.labelKey}.hint`, d);
export const typeLabel = (x: { key: string; label: string }, d: Pick<JobsDeps, 't'>): string => tryKey(`jobs.type.${x.key}`, d) || x.label;

/** Dialog / filter groups: Optimization (actions) then Reports. */
export function typeGroups(types: ReadonlyArray<TypeMeta>): Array<{ kind: JobKind; labelKey: string; types: TypeMeta[] }> {
  return (['action', 'report'] as const)
    .map(kind => ({ kind, labelKey: kind === 'report' ? 'jobs.group_reports' : 'jobs.group_optimization', types: types.filter(x => x.kind === kind) }))
    .filter(g => g.types.length);
}

export const findType = (types: ReadonlyArray<TypeMeta>, key: string): TypeMeta | undefined => types.find(x => x.key === key);
/** The Result control (Apply / Dry run) shows only for an action type that has an `apply_mode` param. */
export const hasApplyMode = (m: TypeMeta | undefined | null): boolean => !!m && m.kind === 'action' && m.params.some(p => p.key === 'apply_mode');

/* ---------------------------------------------------------------------------
   DateWindow (mirror of backend/jobs/windows.py; the server resolves, this only shapes and validates)
   ------------------------------------------------------------------------- */
export const WINDOW_ANCHORS = ['now', 'start_of_day', 'start_of_week', 'start_of_month', 'last_success'] as const;
export const WINDOW_UNITS = ['day', 'week', 'month'] as const;
export const WINDOW_CHOICES = ['fixed', 'older_than', 'last', 'next', 'since_last_success', 'this_week', 'this_month', 'custom'] as const;
export type WindowChoice = typeof WINDOW_CHOICES[number];
export const WINDOW_OPEN_START = 3650;   // a day-unit from_offset at or below -3650 means "no lower bound"
export const WINDOW_MAX_OFFSET = 3660;

export interface DateWindow {
  mode: 'fixed' | 'rolling';
  fixed?: { from: string; to: string } | null;
  rolling?: { anchor: string; from_offset: number; to_offset: number; unit: string } | null;
}

/** What the picker edits: one choice plus the fields that choice uses. */
export interface WindowUi {
  choice: WindowChoice; n: number; from: string; to: string;
  anchor: string; fromOffset: number; toOffset: number; unit: string;
}

export const defaultWindowUi = (choice: WindowChoice = 'last', n = 7): WindowUi =>
  ({ choice, n, from: '', to: '', anchor: 'start_of_day', fromOffset: -7, toOffset: 1, unit: 'day' });

/** A stored window back into the picker, recognising the presets the picker writes (anything else is Custom). */
export function windowToUi(w: DateWindow | null | undefined): WindowUi {
  const ui = defaultWindowUi();
  if (!w) return ui;
  if (w.mode === 'fixed') return { ...ui, choice: 'fixed', from: w.fixed?.from ?? '', to: w.fixed?.to ?? '' };
  const r = w.rolling;
  if (!r) return ui;
  const custom = { ...ui, choice: 'custom' as const, anchor: r.anchor, fromOffset: r.from_offset, toOffset: r.to_offset, unit: r.unit };
  if (r.anchor === 'last_success' && r.from_offset === 0 && r.to_offset === 0 && r.unit === 'day') return { ...custom, choice: 'since_last_success' };
  if (r.anchor === 'start_of_week' && r.from_offset === 0 && r.to_offset === 1 && r.unit === 'week') return { ...custom, choice: 'this_week' };
  if (r.anchor === 'start_of_month' && r.from_offset === 0 && r.to_offset === 1 && r.unit === 'month') return { ...custom, choice: 'this_month' };
  if (r.anchor === 'start_of_day' && r.unit === 'day') {
    if (r.from_offset <= -WINDOW_OPEN_START && r.to_offset <= 0) return { ...custom, choice: 'older_than', n: -r.to_offset };
    if (r.from_offset < 0 && r.to_offset === 1) return { ...custom, choice: 'last', n: -r.from_offset };
    if (r.from_offset === 0 && r.to_offset > 0) return { ...custom, choice: 'next', n: r.to_offset };
  }
  return custom;
}

const _roll = (anchor: string, f: number, t: number, unit = 'day'): DateWindow =>
  ({ mode: 'rolling', fixed: null, rolling: { anchor, from_offset: f, to_offset: t, unit } });

export function uiToWindow(ui: WindowUi): DateWindow {
  const n = Math.trunc(Number(ui.n));
  switch (ui.choice) {
    case 'fixed': return { mode: 'fixed', fixed: { from: ui.from, to: ui.to }, rolling: null };
    case 'older_than': return _roll('start_of_day', -WINDOW_OPEN_START, -n);
    case 'last': return _roll('start_of_day', -n, 1);
    case 'next': return _roll('start_of_day', 0, n);
    case 'since_last_success': return _roll('last_success', 0, 0);
    case 'this_week': return _roll('start_of_week', 0, 1, 'week');
    case 'this_month': return _roll('start_of_month', 0, 1, 'month');
    default: return _roll(ui.anchor, Math.trunc(Number(ui.fromOffset)), Math.trunc(Number(ui.toOffset)), ui.unit);
  }
}

/** i18n key of the first problem with a picker state, '' when it is valid (the server re-checks and resolves it). */
export function validateWindowUi(ui: WindowUi): string {
  const isoDay = /^\d{4}-\d{2}-\d{2}$/;
  if (ui.choice === 'fixed') {
    if (!isoDay.test(ui.from) || !isoDay.test(ui.to)) return 'jobs.err_win_dates';
    return ui.to < ui.from ? 'jobs.err_win_order' : '';
  }
  if (ui.choice === 'older_than' || ui.choice === 'last' || ui.choice === 'next') {
    const n = Number(ui.n);
    const min = ui.choice === 'older_than' ? 0 : 1;
    return Number.isInteger(n) && n >= min && n <= WINDOW_OPEN_START ? '' : 'jobs.err_win_n';
  }
  if (ui.choice === 'custom') {
    const f = Number(ui.fromOffset); const t = Number(ui.toOffset);
    if (!Number.isInteger(f) || !Number.isInteger(t) || Math.abs(f) > WINDOW_MAX_OFFSET || Math.abs(t) > WINDOW_MAX_OFFSET) return 'jobs.err_win_offset';
    if (!(WINDOW_ANCHORS as readonly string[]).includes(ui.anchor) || !(WINDOW_UNITS as readonly string[]).includes(ui.unit)) return 'jobs.err_win_offset';
    // last_success anchors the start only (the end is the run's own now), so the order check applies to the other anchors.
    if (ui.anchor !== 'last_success' && t < f) return 'jobs.err_win_order';
  }
  return '';
}

/* ---------------------------------------------------------------------------
   Params: defaults, validation
   ------------------------------------------------------------------------- */
/** Server defaults first, then each param's own default for anything the defaults did not carry. */
export function seedParams(meta: TypeMeta | undefined | null, defaults: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of meta?.params ?? []) if (p.default !== undefined && p.default !== null) out[p.key] = p.default;
  return { ...out, ...(defaults ?? {}) };
}

/** Param key -> i18n key of its error. Empty object = valid. Client-side only: the server validates again. */
export function validateParams(meta: ReadonlyArray<ParamMeta>, params: Record<string, unknown>): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const m of meta) {
    const v = params[m.key];
    const blank = v === undefined || v === null || v === '';     // NaN (an unparsable number box) is NOT blank: it is an error below
    switch (m.type) {
      case 'boolean': break;
      case 'integer': case 'number': {
        if (blank) { if (m.required) errs[m.key] = 'jobs.err_param_required'; break; }
        const n = Number(v);
        if (!Number.isFinite(n) || (m.type === 'integer' && !Number.isInteger(n))) errs[m.key] = m.type === 'integer' ? 'jobs.err_param_int' : 'jobs.err_param_num';
        else if ((m.min != null && n < m.min) || (m.max != null && n > m.max)) errs[m.key] = 'jobs.err_param_range';
        break;
      }
      case 'enum':
        if (blank ? m.required : !(m.enum ?? []).includes(String(v))) errs[m.key] = blank ? 'jobs.err_param_required' : 'jobs.err_param_enum';
        break;
      case 'multi_enum': {
        const arr = Array.isArray(v) ? v.map(String) : [];
        if (!arr.length) errs[m.key] = 'jobs.err_param_pick';
        else if (arr.some(x => !(m.enum ?? []).includes(x))) errs[m.key] = 'jobs.err_param_enum';
        break;
      }
      case 'date_window': {
        const e = validateWindowUi(windowToUi(v as DateWindow | null));
        if (e) errs[m.key] = e;
        break;
      }
      default:
        if (blank) { if (m.required) errs[m.key] = 'jobs.err_param_required'; }
        else if (m.pattern && !new RegExp(m.pattern).test(String(v))) errs[m.key] = 'jobs.err_param_pattern';
    }
  }
  return errs;
}

/* ---------------------------------------------------------------------------
   Job form: shape, validation, payload
   ------------------------------------------------------------------------- */
export const JOB_RESULTS = ['apply', 'propose'] as const;
export const NAME_MAX = 80;

export interface JobForm {
  jobType: string;
  name: string;
  plant: string;
  /** The type's params, keyed as the server names them (the generic form renders and reads these). `apply_mode`
   *  'apply' (default) writes the result to the schedule; 'propose' is a Dry run, shown but never applied. */
  params: Record<string, unknown>;
  recur: Recurrence;
  validFrom: string;
  validUntil: string;
  skipIfRunning: boolean;
}

/** A new job starts from the server's own param defaults (`GET /jobs/types` -> `defaults`, plus each param's default).
 *  The Result defaults to APPLY (SAP-style background job; owner ruling 2026-10-28); a Dry run is the alternative. */
export function defaultJobForm(plant = '', jobType = 'optimizer.plant', defaults: Record<string, unknown> | null = null, meta: TypeMeta | null = null): JobForm {
  return { jobType, name: '', plant, params: seedParams(meta, defaults), recur: defaultRecurrence(), validFrom: '', validUntil: '', skipIfRunning: true };
}

/** The result mode of a form or a stored params object ('apply' when the job never set one). */
export const resultOf = (params: Record<string, unknown> | null | undefined): string => String(params?.apply_mode ?? 'apply');

export type FormErrors = Partial<Record<'name' | 'plant' | 'result' | 'time' | 'minute' | 'days' | 'dom' | 'cron' | 'runAt' | 'validity', string>>
  & { params?: Record<string, string> };

/** Field -> i18n key. Empty object = valid. `isAdmin` guards the auto-apply result (the server re-checks).
 *  `meta` is the type's param list (for the generic checks); without it only the result gate runs. */
export function validateJobForm(f: JobForm, o: { isAdmin: boolean; plants: string[] | null; meta?: TypeMeta | null }): FormErrors {
  const e: FormErrors = {};
  const name = f.name.trim();
  if (!name) e.name = 'jobs.err_name';
  else if (name.length > NAME_MAX) e.name = 'jobs.err_name_long';
  if (!f.plant) e.plant = 'jobs.err_plant';
  else if (o.plants && !o.plants.includes(f.plant)) e.plant = 'jobs.err_plant_scope';
  const pe = o.meta ? validateParams(o.meta.params, f.params) : {};
  if (o.meta ? hasApplyMode(o.meta) : 'apply_mode' in f.params) {
    const r = resultOf(f.params);
    if (!(JOB_RESULTS as readonly string[]).includes(r)) e.result = 'jobs.err_result';
    else if (r === 'apply' && !o.isAdmin) e.result = 'jobs.err_apply_admin';
    delete pe.apply_mode;
  }
  if (Object.keys(pe).length) e.params = pe;
  const r = f.recur;
  if (r.preset === 'once') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(r.runAt)) e.runAt = 'jobs.err_run_at';
  } else if (r.preset === 'hourly') {
    if (!Number.isInteger(Number(r.minute)) || Number(r.minute) < 0 || Number(r.minute) > 59) e.minute = 'jobs.err_minute';
  } else if (r.preset === 'cron') {
    if (!isValidCronShape(r.cron)) e.cron = 'jobs.err_cron';
  } else {
    if (!parseTime(r.time)) e.time = 'jobs.err_time';
    if (r.preset === 'weekly' && !r.days.length) e.days = 'jobs.err_days';
    if (r.preset === 'monthly' && !(Number.isInteger(Number(r.dom)) && Number(r.dom) >= 1 && Number(r.dom) <= 31)) e.dom = 'jobs.err_dom';
  }
  if (f.validFrom && f.validUntil && f.validUntil < f.validFrom) e.validity = 'jobs.err_validity';
  return e;
}

/** The request bodies for a valid form: the job (params as the form holds them) and its ScheduleIn. The server owns the zone and the cron. */
export function buildJobPayload(f: JobForm): {
  job: { name: string; plant: string; job_type: string; params: Record<string, unknown> };
  schedule: ScheduleIn & { valid_from: string | null; valid_until: string | null; skip_if_running: boolean };
} {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f.params)) if (v !== undefined) params[k] = v;
  return {
    job: { name: f.name.trim(), plant: f.plant, job_type: f.jobType, params },
    schedule: {
      ...recurrenceToScheduleIn(f.recur),
      valid_from: f.validFrom || null,
      valid_until: f.validUntil || null,
      skip_if_running: f.skipIfRunning,
    },
  };
}

/** A saved job (+ its schedule) back into the form; also the Duplicate seed (caller clears the name). */
export function jobToForm(job: {
  name?: string; plant?: string; job_type?: string; params?: Record<string, unknown> | null;
  schedule?: (ScheduleWire & { valid_from?: string | null; valid_until?: string | null; skip_if_running?: boolean | null }) | null;
}, meta: TypeMeta | null = null): JobForm {
  const base = defaultJobForm(job.plant ?? '', job.job_type ?? 'optimizer.plant', null, meta);
  const s = job.schedule;
  return {
    ...base,
    name: job.name ?? '',
    params: { ...base.params, ...(job.params ?? {}) },     // a saved job always carries its own params
    recur: s ? scheduleToRecurrence(s) : base.recur,
    validFrom: String(s?.valid_from ?? '').slice(0, 10),
    validUntil: String(s?.valid_until ?? '').slice(0, 10),
    skipIfRunning: s?.skip_if_running !== false,
  };
}

/* ---------------------------------------------------------------------------
   Report artifact (GET /jobs/runs/{id}/artifact)
   ------------------------------------------------------------------------- */
export const ARTIFACT_PAGE = 500;
export interface ArtifactColumn { key: string; label: string }
export interface ArtifactSection {
  key: string; title: string; columns: ArtifactColumn[]; rows: unknown[][];
  /** Rows the report found (before the size cap) and rows actually stored; `offset` is where `rows` starts. */
  rowCount: number; rowsStored: number; truncated: boolean; offset: number;
}
export interface Artifact { runId: number; sizeBytes: number; truncated: boolean; sections: ArtifactSection[] }

/** Section titles and column labels fall back to the server's English when the locale has no `jobs.a.*` string. */
export const sectionTitle = (s: { key: string; title: string }, d: Pick<JobsDeps, 't'>): string => tryKey(`jobs.a.sec.${s.key}`, d) || s.title;
export const columnLabel = (c: ArtifactColumn, d: Pick<JobsDeps, 't'>): string => tryKey(`jobs.a.col.${c.key}`, d) || c.label;

/** One cell as text: null is empty, 'yes' / 'no' are translated, numbers drop float noise. */
export function cellText(v: unknown, d: Pick<JobsDeps, 't'>): string {
  if (v == null) return '';
  if (v === 'yes' || v === 'no' || v === true || v === false) return d.t(v === 'yes' || v === true ? 'jobs.a.yes' : 'jobs.a.no');
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return String(v);
}

/** Row-count tiles for a report run, in the report's own section order (summary.row_counts), zero counts kept. */
export function artifactTiles(s: RunSummary | null | undefined): Array<{ key: string; value: number }> {
  const rc = s?.row_counts;
  if (!rc || typeof rc !== 'object') return [];
  return Object.entries(rc).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)).map(([key, value]) => ({ key, value: value as number }));
}

/** A run that produced a report artifact (the summary carries its row counts). */
export const isReportRun = (s: RunSummary | null | undefined): boolean => !!s && (!!s.artifact || !!s.row_counts);

/** The resolved window line: "Window: 2026-09-28 to 2026-10-28, plant time". */
export const windowLine = (w: { label: string } | null | undefined, d: Pick<JobsDeps, 't'>): string => (w?.label ? d.t('jobs.run_window', { label: w.label }) : '');
