/* =============================================================================
   JOBS MODEL — the pure half of Admin > Jobs (no DOM, no Store, no fetch, no imports).

   Everything here is a function of its arguments: translation and HTML escaping arrive through a
   `JobsDeps` the caller injects (`t`, `esc`, optional `fmtTime`), so the node tests drive it with
   plain stubs. The client owns wire shapes (jobs-client.mts); the pane, dialog and run detail own the DOM.

   Times: every instant the backend sends is a naive plant-local ISO string (the Naive-local-time
   convention in backend/alert_profiles/CLAUDE.md), and every cron / run_at we send is plant-local too,
   so this module never converts a zone; the plant's timezone is shown read-only in the dialog.
   ========================================================================== */

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
export const RECUR_PRESETS = ['once', 'hourly', 'daily', 'weekly', 'monthly', 'cron'] as const;
export type RecurPreset = typeof RECUR_PRESETS[number];

export interface Recurrence {
  preset: RecurPreset;
  /** 'HH:MM' (daily / weekly / monthly). */
  time: string;
  /** Minute past the hour (hourly). */
  minute: number;
  /** Cron weekday numbers, 0 = Sunday (weekly). */
  days: number[];
  /** Day of month 1-31 (monthly). */
  dom: number;
  cron: string;
  /** Plant-local 'YYYY-MM-DDTHH:MM' (once). */
  runAt: string;
}

export const DEFAULT_TIME = '08:00';

export function defaultRecurrence(): Recurrence {
  return { preset: 'daily', time: DEFAULT_TIME, minute: 0, days: [1, 2, 3, 4, 5], dom: 1, cron: '', runAt: '' };
}

/** 'HH:MM' -> [hour, minute], or null when it is not a valid 24-hour time. */
export function parseTime(s: string | null | undefined): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? [h, mi] : null;
}

/** The 5-field cron for a preset, or null for 'once' / an incomplete or invalid form. */
export function presetToCron(r: Pick<Recurrence, 'preset'> & Partial<Recurrence>): string | null {
  const tm = parseTime(r.time ?? DEFAULT_TIME);
  switch (r.preset) {
    case 'hourly': {
      const m = Number(r.minute ?? 0);
      return Number.isInteger(m) && m >= 0 && m <= 59 ? `${m} * * * *` : null;
    }
    case 'daily': return tm ? `${tm[1]} ${tm[0]} * * *` : null;
    case 'weekly': {
      const days = [...new Set((r.days ?? []).filter(x => Number.isInteger(x) && x >= 0 && x <= 6))].sort((a, b) => a - b);
      return tm && days.length ? `${tm[1]} ${tm[0]} * * ${days.join(',')}` : null;
    }
    case 'monthly': {
      const dom = Number(r.dom ?? 1);
      return tm && Number.isInteger(dom) && dom >= 1 && dom <= 31 ? `${tm[1]} ${tm[0]} ${dom} * *` : null;
    }
    case 'cron': return isValidCronShape(r.cron ?? '') ? String(r.cron).trim().replace(/\s+/g, ' ') : null;
    default: return null;
  }
}

/** A cheap shape check (five whitespace-separated fields of cron characters); the server's trigger is the authority. */
export function isValidCronShape(c: string | null | undefined): boolean {
  const p = String(c ?? '').trim().split(/\s+/);
  return p.length === 5 && p.every(f => /^[\d*/,\-A-Za-z?LW#]+$/.test(f));
}

const _isNum = (s: string): boolean => /^\d+$/.test(s);

/** Reverse of presetToCron, for editing a saved schedule: the preset the cron came from, else 'cron' (advanced). */
export function cronToRecurrence(cron: string | null | undefined): Recurrence {
  const base = defaultRecurrence();
  const c = String(cron ?? '').trim();
  const p = c.split(/\s+/);
  if (p.length !== 5) return { ...base, preset: c ? 'cron' : base.preset, cron: c };
  const [mi, ho, dom, mon, dow] = p;
  const pad = (s: string): string => s.padStart(2, '0');
  if (_isNum(mi) && ho === '*' && dom === '*' && mon === '*' && dow === '*') return { ...base, preset: 'hourly', minute: Number(mi), cron: c };
  if (_isNum(mi) && _isNum(ho) && mon === '*') {
    const time = `${pad(ho)}:${pad(mi)}`;
    if (dom === '*' && dow === '*') return { ...base, preset: 'daily', time, cron: c };
    if (dom === '*' && /^\d(,\d)*$/.test(dow)) return { ...base, preset: 'weekly', time, days: dow.split(',').map(Number), cron: c };
    if (_isNum(dom) && dow === '*') return { ...base, preset: 'monthly', time, dom: Number(dom), cron: c };
  }
  return { ...base, preset: 'cron', cron: c };
}

const _defaultFmtTime = (h: number, m: number): string => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

/** Plain-language reading of a cron, or null when it is not one of the shapes we can phrase (the UI then shows the raw cron). */
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
  if (dom === '*' && /^\d(,\d)*$/.test(dow)) {
    const days = dow.split(',').map(Number);
    if (days.join(',') === '1,2,3,4,5') return d.t('jobs.cron_weekdays', { time });
    return d.t('jobs.cron_weekly', { days: days.map(x => d.t(`jobs.dow_${x}`)).join(', '), time });
  }
  if (_isNum(dom) && dow === '*') return d.t('jobs.cron_monthly', { dom, time });
  return null;
}

export interface ScheduleLike {
  kind?: string | null;
  cron_expr?: string | null;
  run_at?: string | null;
  paused?: boolean | null;
}

/** One-line recurrence for the table: prose, the raw cron, or "Once <when>" (the pane formats run_at through Util.fmtDTPref). */
export function recurrenceText(s: ScheduleLike | null | undefined, d: JobsDeps, fmtDT: (iso: string) => string): string {
  if (!s) return d.t('jobs.no_schedule');
  if (s.kind === 'once' || (!s.cron_expr && s.run_at)) return d.t('jobs.once_at', { when: fmtDT(String(s.run_at ?? '')) });
  return cronProse(s.cron_expr, d) ?? String(s.cron_expr ?? d.t('jobs.no_schedule'));
}

/* ---------------------------------------------------------------------------
   Query builders (server pagination: limit/offset for jobs, a before_id cursor for runs)
   ------------------------------------------------------------------------- */
export const JOBS_PAGE = 50;
export const RUNS_PAGE = 50;

function _qs(pairs: Array<[string, string | number | null | undefined]>): string {
  const sp = pairs.filter(([, v]) => v !== null && v !== undefined && String(v) !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return sp.length ? `?${sp.join('&')}` : '';
}

export interface JobsQuery { plant?: string; q?: string; status?: string; type?: string; limit?: number; offset?: number }
export function buildJobsQuery(o: JobsQuery): string {
  const limit = Math.max(1, Math.min(200, Math.floor(o.limit ?? JOBS_PAGE)));
  const offset = Math.max(0, Math.floor(o.offset ?? 0));
  return _qs([['plant', o.plant], ['q', (o.q ?? '').trim()], ['status', o.status], ['type', o.type], ['limit', limit], ['offset', offset || null]]);
}

export interface RunsQuery { plant?: string; status?: string; beforeId?: number | string | null; limit?: number; jobId?: number | string }
export function buildRunsQuery(o: RunsQuery): string {
  const limit = Math.max(1, Math.min(200, Math.floor(o.limit ?? RUNS_PAGE)));
  return _qs([['plant', o.plant], ['status', o.status], ['job_id', o.jobId], ['before_id', o.beforeId], ['limit', limit]]);
}

export function buildLogQuery(o: { afterSeq?: number | null; level?: string }): string {
  return _qs([['after_seq', o.afterSeq ?? 0], ['level', o.level && o.level !== 'all' ? o.level : null]]);
}

/** "1-50 of 130" bounds for the server-paged jobs table; to is clamped to total. */
export function pageRange(offset: number, count: number, total: number): { from: number; to: number } {
  if (!count || !total) return { from: 0, to: 0 };
  return { from: offset + 1, to: Math.min(total, offset + count) };
}

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
export const JOB_MODES = ['due-date', 'min-changeover', 'spt'] as const;
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
  respectCalendar: boolean;
  /** 'propose' = leave the run's result as a proposal; 'apply' = write it to the schedule (admin only). */
  result: string;
  recur: Recurrence;
  validFrom: string;
  validUntil: string;
  skipIfRunning: boolean;
}

export function defaultJobForm(plant = '', jobType = 'optimizer.plant'): JobForm {
  return {
    jobType, name: '', plant, mode: 'due-date', search: 'exhaustive', respectFirmed: true, respectCalendar: true,
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
    if (presetToCron(r) === null) e.minute = 'jobs.err_minute';
  } else if (r.preset === 'cron') {
    if (!isValidCronShape(r.cron)) e.cron = 'jobs.err_cron';
  } else {
    if (!parseTime(r.time)) e.time = 'jobs.err_time';
    if (r.preset === 'weekly' && !r.days.length) e.days = 'jobs.err_days';
    if (r.preset === 'monthly' && presetToCron(r) === null && parseTime(r.time)) e.dom = 'jobs.err_dom';
  }
  if (f.validFrom && f.validUntil && f.validUntil < f.validFrom) e.validity = 'jobs.err_validity';
  return e;
}

/** The three request bodies the client sends for a valid form. Plant-local, naive; the server owns the zone. */
export function buildJobPayload(f: JobForm): {
  job: { name: string; plant: string; job_type: string; params: Record<string, unknown> };
  schedule: { kind: 'once' | 'cron'; cron_expr: string | null; run_at: string | null; valid_from: string | null; valid_until: string | null; skip_if_running: boolean };
} {
  const once = f.recur.preset === 'once';
  return {
    job: {
      name: f.name.trim(), plant: f.plant, job_type: f.jobType,
      params: { mode: f.mode, search: f.search, respect_firmed: f.respectFirmed, respect_calendar: f.respectCalendar, apply_mode: f.result },
    },
    schedule: {
      kind: once ? 'once' : 'cron',
      cron_expr: once ? null : presetToCron(f.recur),
      run_at: once ? f.recur.runAt : null,
      valid_from: f.validFrom || null,
      valid_until: f.validUntil || null,
      skip_if_running: f.skipIfRunning,
    },
  };
}

/** A saved job (+ its schedule) back into the form; also the Duplicate seed (caller clears the name). */
export function jobToForm(job: {
  name?: string; plant?: string; job_type?: string; params?: Record<string, unknown> | null;
  schedule?: { kind?: string | null; cron_expr?: string | null; run_at?: string | null; valid_from?: string | null; valid_until?: string | null; skip_if_running?: boolean | null } | null;
}): JobForm {
  const base = defaultJobForm(job.plant ?? '', job.job_type ?? 'optimizer.plant');
  const p = job.params ?? {};
  const s = job.schedule;
  const recur = s ? (s.kind === 'once' ? { ...defaultRecurrence(), preset: 'once' as const, runAt: String(s.run_at ?? '').slice(0, 16) } : cronToRecurrence(s.cron_expr)) : base.recur;
  return {
    ...base,
    name: job.name ?? '',
    mode: String(p.mode ?? base.mode),
    search: String(p.search ?? base.search),
    respectFirmed: p.respect_firmed !== false,
    respectCalendar: p.respect_calendar !== false,
    result: String(p.apply_mode ?? base.result),
    recur,
    validFrom: String(s?.valid_from ?? '').slice(0, 10),
    validUntil: String(s?.valid_until ?? '').slice(0, 10),
    skipIfRunning: s?.skip_if_running !== false,
  };
}
