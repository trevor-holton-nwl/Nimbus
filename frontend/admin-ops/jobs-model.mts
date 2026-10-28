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
export const RUN_STATUSES = ['scheduled', 'running', 'succeeded', 'warning', 'failed', 'cancelled', 'skipped'] as const;
export type RunStatus = typeof RUN_STATUSES[number];

/** Existing badge classes only; the label is always shown beside the colour. */
const STATUS_BADGE: Record<RunStatus, string> = {
  scheduled: 'badge-muted', running: 'badge-info', succeeded: 'badge-ok', warning: 'badge-warn',
  failed: 'badge-err', cancelled: 'badge-muted', skipped: 'badge-muted',
};

export function statusBadgeClass(status: string | null | undefined): string {
  return STATUS_BADGE[status as RunStatus] ?? 'badge-muted';
}

export function statusLabel(status: string | null | undefined, d: JobsDeps): string {
  return (RUN_STATUSES as readonly string[]).includes(String(status)) ? d.t(`jobs.status_${status}`) : String(status ?? '');
}

export function statusBadgeHtml(status: string | null | undefined, d: JobsDeps): string {
  if (!status) return '';
  return `<span class="badge ${statusBadgeClass(status)} job-status">${d.esc(statusLabel(status, d))}</span>`;
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

export interface RunsQuery { plant?: string; status?: string; beforeId?: number | string | null; limit?: number; jobId?: number | string }
export function buildRunsQuery(o: RunsQuery): string {
  const limit = Math.max(1, Math.min(200, Math.floor(o.limit ?? RUNS_PAGE)));
  return _qs([['plant', o.plant], ['status', o.status], ['job_id', o.jobId], ['before_id', o.beforeId], ['limit', limit]]);
}

export function buildLogQuery(o: { afterSeq?: number | null; level?: string }): string {
  return _qs([['after_seq', o.afterSeq ?? 0], ['level', o.level && o.level !== 'all' ? o.level : null]]);
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

/* ---------------------------------------------------------------------------
   Job form: shape, validation, payload
   ------------------------------------------------------------------------- */
export const JOB_MODES = ['due_date', 'min_changeover', 'spt'] as const;
export const JOB_SEARCHES = ['normal', 'exhaustive'] as const;
export const JOB_RESULTS = ['propose', 'apply'] as const;
export const NAME_MAX = 80;

export interface JobForm {
  jobType: string;
  name: string;
  plant: string;
  mode: string;
  search: string;
  respectFirmed: boolean;
  /** 'propose' = leave the run's result as a proposal; 'apply' = write it to the schedule (admin only); sent as params.apply_mode. */
  result: string;
  recur: Recurrence;
  validFrom: string;
  validUntil: string;
  skipIfRunning: boolean;
}

export function defaultJobForm(plant = '', jobType = 'optimizer.plant'): JobForm {
  return {
    jobType, name: '', plant, mode: 'due_date', search: 'exhaustive', respectFirmed: true,
    result: 'apply', recur: defaultRecurrence(), validFrom: '', validUntil: '', skipIfRunning: true,
  };
}

export type FormErrors = Partial<Record<'name' | 'plant' | 'mode' | 'search' | 'result' | 'time' | 'minute' | 'days' | 'dom' | 'cron' | 'runAt' | 'validity', string>>;

/** Field -> i18n key. Empty object = valid. `isAdmin` guards the auto-apply result (the server re-checks). */
export function validateJobForm(f: JobForm, o: { isAdmin: boolean; plants: string[] | null }): FormErrors {
  const e: FormErrors = {};
  const name = f.name.trim();
  if (!name) e.name = 'jobs.err_name';
  else if (name.length > NAME_MAX) e.name = 'jobs.err_name_long';
  if (!f.plant) e.plant = 'jobs.err_plant';
  else if (o.plants && !o.plants.includes(f.plant)) e.plant = 'jobs.err_plant_scope';
  if (!(JOB_MODES as readonly string[]).includes(f.mode)) e.mode = 'jobs.err_mode';
  if (!(JOB_SEARCHES as readonly string[]).includes(f.search)) e.search = 'jobs.err_search';
  if (!(JOB_RESULTS as readonly string[]).includes(f.result)) e.result = 'jobs.err_result';
  else if (f.result === 'apply' && !o.isAdmin) e.result = 'jobs.err_apply_admin';
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

/** The request bodies for a valid form: the job (params carry apply_mode explicitly) and its ScheduleIn. The server owns the zone and the cron. */
export function buildJobPayload(f: JobForm): {
  job: { name: string; plant: string; job_type: string; params: Record<string, unknown> };
  schedule: ScheduleIn & { valid_from: string | null; valid_until: string | null; skip_if_running: boolean };
} {
  return {
    job: {
      name: f.name.trim(), plant: f.plant, job_type: f.jobType,
      params: { mode: f.mode, search: f.search, respect_firmed: f.respectFirmed, apply_mode: f.result },
    },
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
}): JobForm {
  const base = defaultJobForm(job.plant ?? '', job.job_type ?? 'optimizer.plant');
  const p = job.params ?? {};
  const s = job.schedule;
  return {
    ...base,
    name: job.name ?? '',
    mode: String(p.mode ?? base.mode),
    search: String(p.search ?? base.search),
    respectFirmed: p.respect_firmed !== false,
    result: String(p.apply_mode ?? base.result),
    recur: s ? scheduleToRecurrence(s) : base.recur,
    validFrom: String(s?.valid_from ?? '').slice(0, 10),
    validUntil: String(s?.valid_until ?? '').slice(0, 10),
    skipIfRunning: s?.skip_if_running !== false,
  };
}
