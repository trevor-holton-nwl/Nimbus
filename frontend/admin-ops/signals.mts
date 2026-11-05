// admin-ops/signals.mts — the Admin Overview "signal model". Pure: no DOM, no fetch, no imports from
// admin-ui. The pane gathers the raw reads (GET /health, /diagnostics/db, /logs/backend, the Jobs
// summary and runs, the SAP status, this browser's counters) into one SignalInputs and calls
// buildSignals() / buildAttention(); everything it returns is data (locale keys + raw values) that the
// pane renders and formats (relative times, numbers) itself.
//
// Rules of the model (docs: Admin Cockpit redesign, "Overview: the signal model"):
//  - Always seven signals, worst-first; ties keep the fixed id order jobs, database, backend,
//    data_load, connections, sap, browser.
//  - A failed read is never a silent ok: it is severity 'err' with reasonKey 'sig.unavailable'
//    ({msg}). A 401/403 (the *Err field equals the string 'forbidden') or a non-admin viewer on an
//    admin-only source is severity 'info' with 'sig.admin_only'.
//  - Time values in reasonArgs ('ago', 'next', measuredAt) are raw epoch milliseconds (0 = unknown or
//    never); the pane formats them. Counts and ids are plain numbers or strings.
//  - Scope: plant-scoped sources (Jobs runs, SAP) are read for the selected plant only, so the
//    signals never fan out across plants (the 50+ plant scale rule).
//  - The thresholds are constants with an override argument; the pool rule (60 % warn / 85 % err)
//    matches Diagnostics so the two never disagree, and the server's needs_vacuum flag is trusted.

export type Severity = 'err' | 'warn' | 'info' | 'ok';
export const SEVERITY_RANK: Record<Severity, number> = { err: 3, warn: 2, info: 1, ok: 0 };
export type SignalId = 'jobs' | 'database' | 'backend' | 'data_load' | 'connections' | 'sap' | 'browser';
export type AdminSub = 'overview' | 'logs' | 'diagnostics' | 'order-maintenance' | 'jobs' | 'manage' | 'interface' | 'security' | 'system-config' | 'table-browser';

/** A one-click remedy. `id` is dispatched by the pane (jobs.rerun, jobs.open_run, db.vacuum_all,
 *  db.vacuum_table, logs.open, data.reload, client.reset, client.save, nav.diagnostics,
 *  nav.interface, nav.order_maintenance, nav.jobs); `args` carries what it needs (runId, table, ...). */
export interface Fix { id: string; labelKey: string; args?: Record<string, unknown>; adminOnly?: boolean }

/** A small table under a signal row. Cells are raw values (ISO strings, numbers) the pane formats.
 *  For the data_load detail the first column holds locale keys (pipe.*) the pane translates. */
export interface DetailTable {
  headKeys: string[];
  rows: Array<Array<string | number | null>>;
  rowFixes?: Array<Fix | null>;
  linkKey?: string;
  linkSub?: AdminSub;
  /** Deep-link target inside linkSub (DOM id, or `jobs:<tab>` / `sap:<tab>`); see the Anchor grammar in the diagnostics design spec. */
  linkAnchor?: string;
}

export interface Signal {
  id: SignalId;
  severity: Severity;
  reasonKey: string;
  reasonArgs: Record<string, string | number>;
  fixes: Fix[];
  detail: DetailTable | null;
  /** Epoch ms of the slow-tier stats this signal used (Database), so the pane can add "stats from N min ago". */
  measuredAt?: number;
}

export interface AttentionItem { id: string; severity: Severity; textKey: string; args: Record<string, unknown>; fix: Fix }

/* ---------------------------------------------------------------------------
   Input shapes: only the fields the model reads (cross-checked against the backend and jobs-model).
   ------------------------------------------------------------------------- */
/** GET /health. */
export interface HealthLike {
  db: { connected: boolean; ping_ms: number; total_orders?: number; error?: string };
  pool: { pool_max?: number; pool_size?: number; pool_available?: number; requests_waiting?: number };
  memory?: { loaded?: boolean; task_count?: number; loaded_at?: string | null };
}
export interface TableStatLike {
  table: string; live_rows: number; dead_pct: number; last_vacuum: string | null; last_autovacuum: string | null;
  last_analyze: string | null; last_autoanalyze: string | null; needs_vacuum: boolean;
}
/** GET /diagnostics/db (lists may be the `[{error}]` sentinel on a server-side failure). */
export interface DbDeepLike {
  tables: Array<TableStatLike | { error: string }>;
  connections: { total?: number; long_running?: Array<{ duration_s: number | null }>; error?: string };
  locks: Array<{ blocked_pid: number } | { error: string }>;
  slow_queries: { available: boolean; queries: Array<{ mean_ms: number }>; error?: string };
}
export interface BackendRowLike { ts: string; level: string; category?: string; msg: string }
/** GET /logs/backend (level + since + limit): `total` counts every match, `entries` the newest few. */
export interface BackendCountLike { total: number; entries: BackendRowLike[] }
export interface JobRunLike {
  id: number; job_name: string; plant: string; status: string; started_at: string | null; scheduled_for: string | null;
  ended_at?: string | null; duration_ms: number | null; error: string | null;
}
export interface JobsSummaryLike {
  failed24h: number; missed24h: number; warning24h: number; longerThanUsual: number[];
  nextFire: { atUtc: string } | null; scheduler: { ok: boolean };
  maintenance?: { enabled: boolean };
}
/** GET /sap/staging/send/{plant}/status. */
export interface SapSendStatus { ready: number; sent: number; error: number; last_queued_at: string | null; last_sent_at: string | null }
/** One header of GET /sap/staging/batches. */
export interface SapBatchHeader { batch_id: string; status: string; plant?: string; object_key?: string }
/** One row of GET /sap/interface/runs. */
export interface SapRunLike { id: number; object_key: string; started_at: string | null; ended_at: string | null; status: string; rows_read: number; rows_failed: number; error: string | null }

export interface SignalInputs {
  /** Epoch ms "now" (injected so the model is deterministic). */
  now: number;
  health: HealthLike | null;
  healthErr?: string;
  dbDeep: DbDeepLike | null;
  dbDeepErr?: string;
  /** Epoch ms the dbDeep read was taken (slow tier). */
  dbDeepAt?: number;
  backendErrors: BackendCountLike | null;
  backendWarns: BackendCountLike | null;
  backendErr?: string;
  jobs: { summary: JobsSummaryLike; lastFailed: JobRunLike[]; recent: JobRunLike[] } | null;
  jobsErr?: string;
  sap: { status: SapSendStatus; batches: SapBatchHeader[]; lastRun: SapRunLike | null; plant: string } | null;
  sapErr?: string;
  client: {
    stats: { source: 'backend' | null; raw_received: number; rendered: number } | null;
    inv: { autosaveDisabled?: boolean; degraded?: boolean };
    errors: number; warns: number;
    /** Browser errors per minute. */
    errRate: number;
    heapUsed?: number; heapLimit?: number;
    build: string; schema: string | number;
    /** Orders currently in the browser Store. */
    tasks: number;
  };
  /** Distribution warnings in the newest upload (slow tier). */
  uploadWarnings?: { distribution: number; batchId: string };
  isAdmin: boolean;
}

export const THRESHOLDS = {
  dbPingWarnMs: 500, dbPingErrMs: 2000,
  poolWarnPct: 60, poolErrPct: 85,
  longQueryWarnS: 30,
  slowQueryWarnMs: 100, slowQueryErrMs: 500,
  backendErrWarn: 1, backendErrErr: 5, backendWarnWarn: 20,
  heapWarnPct: 80,
  errRateErrPerMin: 10,
  dbStatsStaleMs: 600_000,
};
type Thresholds = typeof THRESHOLDS;

const ID_ORDER: SignalId[] = ['jobs', 'database', 'backend', 'data_load', 'connections', 'sap', 'browser'];
export const FORBIDDEN = 'forbidden';
/** `sapErr` value for a 404 (the interface is not live for this plant). */
export const NOT_FOUND = 'not_found';

export function worstOf(...s: Severity[]): Severity {
  let w: Severity = 'ok';
  for (const x of s) if (SEVERITY_RANK[x] > SEVERITY_RANK[w]) w = x;
  return w;
}

/* ---------------------------------------------------------------------------
   helpers
   ------------------------------------------------------------------------- */
interface Cond { sev: Severity; key: string; args: Record<string, string | number>; fixes?: Fix[] }

const _ms = (iso: string | null | undefined): number => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const _isErrRow = (x: unknown): x is { error: string } => !!x && typeof x === 'object' && 'error' in (x as object);
const _rows = <T extends object>(l: Array<T | { error: string }> | undefined): T[] => (l ?? []).filter((x): x is T => !_isErrRow(x));
const _fix = (id: string, labelKey: string, args?: Record<string, unknown>, adminOnly?: boolean): Fix => {
  const f: Fix = { id, labelKey };
  if (args) f.args = args;
  if (adminOnly) f.adminOnly = true;
  return f;
};
const _nav = (id: string, labelKey: string, anchor: string): Fix => _fix(id, labelKey, { anchor });

function _unavailable(id: SignalId, msg: string): Signal {
  return { id, severity: 'err', reasonKey: 'sig.unavailable', reasonArgs: { msg }, fixes: [], detail: null };
}
function _adminOnly(id: SignalId): Signal {
  return { id, severity: 'info', reasonKey: 'sig.admin_only', reasonArgs: {}, fixes: [], detail: null };
}
/** Pick the most severe condition (the first one listed wins ties, so list the most telling first). */
function _pick(id: SignalId, conds: Cond[], okCond: Cond, detail: DetailTable | null): Signal {
  let best: Cond | null = null;
  for (const c of conds) if (!best || SEVERITY_RANK[c.sev] > SEVERITY_RANK[best.sev]) best = c;
  const c = best ?? okCond;
  return { id, severity: c.sev, reasonKey: c.key, reasonArgs: c.args, fixes: c.fixes ?? [], detail };
}
const _failedRead = (id: SignalId, err: string | undefined, isAdmin: boolean, adminOnly: boolean): Signal | null => {
  if (err === FORBIDDEN || (adminOnly && !isAdmin)) return _adminOnly(id);
  if (err) return _unavailable(id, err);
  return null;
};
const _poolUsed = (p: HealthLike['pool']): { used: number; max: number; pct: number } => {
  const max = p.pool_max ?? 0;
  const used = Math.max(0, (p.pool_size ?? 0) - (p.pool_available ?? 0));
  return { used, max, pct: max > 0 ? Math.round((used / max) * 100) : 0 };
};

/* ---------------------------------------------------------------------------
   per-subsystem builders
   ------------------------------------------------------------------------- */
function _jobs(i: SignalInputs): Signal {
  if (!i.jobs) return _failedRead('jobs', i.jobsErr, i.isAdmin, true) ?? _unavailable('jobs', 'no data');
  const { summary: s, lastFailed, recent } = i.jobs;
  const conds: Cond[] = [];
  const lf = lastFailed[0];
  if (s.failed24h > 0) {
    conds.push({
      sev: 'err', key: 'sig.jobs_failed',
      args: { n: s.failed24h, job: lf?.job_name ?? '', plant: lf?.plant ?? '', ago: _ms(lf?.started_at ?? lf?.scheduled_for ?? lf?.ended_at) || i.now, reason: lf?.error ?? '' },
      fixes: lf ? [_fix('jobs.rerun', 'btn.rerun_now', { runId: lf.id }, true), _fix('jobs.open_run', 'btn.open_run', { runId: lf.id })] : [_nav('nav.jobs', 'ov.details', 'jobs:runs')],
    });
  }
  if (!s.scheduler.ok) conds.push({ sev: 'err', key: 'sig.jobs_scheduler_stale', args: {}, fixes: [_nav('nav.jobs', 'ov.details', 'jobs:jobs')] });
  if (s.missed24h > 0) conds.push({ sev: 'warn', key: 'sig.jobs_missed', args: { n: s.missed24h }, fixes: [_nav('nav.jobs', 'ov.details', 'jobs:runs')] });
  if (s.warning24h > 0) conds.push({ sev: 'warn', key: 'sig.jobs_warning', args: { n: s.warning24h }, fixes: [_nav('nav.jobs', 'ov.details', 'jobs:runs')] });
  if (s.maintenance?.enabled) conds.push({ sev: 'warn', key: 'sig.jobs_maint', args: {}, fixes: [_nav('nav.jobs', 'ov.details', 'jobs:jobs')] });
  if (s.longerThanUsual.length > 0) conds.push({ sev: 'warn', key: 'sig.jobs_slow', args: { n: s.longerThanUsual.length }, fixes: [_nav('nav.jobs', 'ov.details', 'jobs:runs')] });
  const nextMs = s.nextFire ? _ms(s.nextFire.atUtc) : 0;
  const okCond: Cond = recent.length === 0 && !s.nextFire
    ? { sev: 'info', key: 'sig.jobs_none', args: {} }
    : { sev: 'ok', key: 'sig.jobs_ok', args: { next: nextMs } };   // next 0 = nothing scheduled (the pane renders sig.next_none)
  const detail: DetailTable = {
    headKeys: ['sig.d_job', 'sig.d_plant', 'sig.d_status', 'sig.d_started', 'sig.d_duration', 'sig.d_error'],
    rows: recent.slice(0, 3).map(r => [r.job_name, r.plant, r.status, r.started_at ?? r.scheduled_for, r.duration_ms, r.error]),
    rowFixes: recent.slice(0, 3).map(r => (r.status === 'failed' ? _fix('jobs.open_run', 'btn.open_run', { runId: r.id }) : null)),
    linkKey: 'ov.details', linkSub: 'jobs', linkAnchor: 'jobs:runs',
  };
  return _pick('jobs', conds, okCond, detail);
}

function _database(i: SignalInputs, t: Thresholds): Signal {
  if (i.healthErr || !i.health) return _failedRead('database', i.healthErr, i.isAdmin, false) ?? _unavailable('database', 'no data');
  const h = i.health;
  if (!h.db.connected) {
    return { id: 'database', severity: 'err', reasonKey: 'sig.db_offline', reasonArgs: {}, fixes: [_nav('nav.diagnostics', 'btn.open_diagnostics', 'diag-db')], detail: null };
  }
  if (!i.dbDeep) {
    // The slow tier is admin-only. Not an admin (or 403): ping is all we may show.
    if (i.dbDeepErr === FORBIDDEN || !i.isAdmin) {
      if (h.db.ping_ms > t.dbPingErrMs) return { id: 'database', severity: 'err', reasonKey: 'sig.db_slow', reasonArgs: { ms: Math.round(h.db.ping_ms) }, fixes: [], detail: null };
      if (h.db.ping_ms > t.dbPingWarnMs) return { id: 'database', severity: 'warn', reasonKey: 'sig.db_slow', reasonArgs: { ms: Math.round(h.db.ping_ms) }, fixes: [], detail: null };
      return _adminOnly('database');
    }
    if (i.dbDeepErr) return _unavailable('database', i.dbDeepErr);
  }
  const conds: Cond[] = [];
  const ping = Math.round(h.db.ping_ms);
  if (h.db.ping_ms > t.dbPingErrMs) conds.push({ sev: 'err', key: 'sig.db_slow', args: { ms: ping }, fixes: [_nav('nav.diagnostics', 'btn.open_diagnostics', 'diag-db-server')] });
  else if (h.db.ping_ms > t.dbPingWarnMs) conds.push({ sev: 'warn', key: 'sig.db_slow', args: { ms: ping }, fixes: [_nav('nav.diagnostics', 'btn.open_diagnostics', 'diag-db-server')] });
  const tables = i.dbDeep ? _rows<TableStatLike>(i.dbDeep.tables) : [];
  const sorted = [...tables].sort((a, b) => b.dead_pct - a.dead_pct);
  const need = sorted.filter(x => x.needs_vacuum);
  if (need.length > 0) {
    const w = need[0];
    conds.push({
      sev: 'warn', key: 'sig.db_vacuum',
      args: { n: need.length, table: w.table, pct: Math.round(w.dead_pct * 10) / 10, ago: Math.max(_ms(w.last_vacuum), _ms(w.last_autovacuum)) },
      fixes: [_fix('db.vacuum_all', 'btn.vacuum_analyze', undefined, true)],
    });
  }
  const stale = i.dbDeepAt !== undefined && i.now - i.dbDeepAt > t.dbStatsStaleMs;
  if (stale) conds.push({ sev: 'warn', key: need.length > 0 ? 'sig.db_vacuum' : 'sig.db_ok', args: { ms: ping, n: tables.length - need.length }, fixes: [] });
  const okCond: Cond = { sev: 'ok', key: 'sig.db_ok', args: { ms: ping, n: i.dbDeep ? tables.length - need.length : '–' } };
  const top = sorted.slice(0, 8);
  const detail: DetailTable | null = i.dbDeep ? {
    headKeys: ['sig.d_table', 'sig.d_live', 'sig.d_dead_pct', 'sig.d_last_vacuum', 'sig.d_last_analyze'],
    rows: top.map(x => [x.table, x.live_rows, x.dead_pct, x.last_vacuum ?? x.last_autovacuum, x.last_analyze ?? x.last_autoanalyze]),
    rowFixes: top.map(x => (x.needs_vacuum ? _fix('db.vacuum_table', 'btn.vacuum', { table: x.table }, true) : null)),
    linkKey: 'btn.open_diagnostics', linkSub: 'diagnostics', linkAnchor: 'diag-db-tables',
  } : null;
  const sig = _pick('database', conds, okCond, detail);
  if (i.dbDeepAt !== undefined) sig.measuredAt = i.dbDeepAt;
  return sig;
}

function _backend(i: SignalInputs, t: Thresholds): Signal {
  if (!i.backendErrors || !i.backendWarns) return _failedRead('backend', i.backendErr, i.isAdmin, true) ?? _unavailable('backend', 'no data');
  const e = i.backendErrors.total;
  const w = i.backendWarns.total;
  const conds: Cond[] = [];
  const counts = { errors: e, warns: w };
  if (e >= t.backendErrErr) conds.push({ sev: 'err', key: 'sig.backend_counts', args: counts, fixes: [_fix('logs.open', 'btn.view_logs', { source: 'backend', level: 'error' })] });
  else if (e >= t.backendErrWarn) conds.push({ sev: 'warn', key: 'sig.backend_counts', args: counts, fixes: [_fix('logs.open', 'btn.view_logs', { source: 'backend', level: 'error' })] });
  if (w >= t.backendWarnWarn) conds.push({ sev: 'warn', key: 'sig.backend_counts', args: counts, fixes: [_fix('logs.open', 'btn.view_logs', { source: 'backend', level: 'warn' })] });
  const rows = [...i.backendErrors.entries.slice(0, 5), ...i.backendWarns.entries.slice(0, 5)];
  return _pick('backend', conds, { sev: 'ok', key: 'sig.backend_ok', args: {} }, {
    headKeys: ['sig.d_level', 'sig.d_when', 'sig.d_message'],
    rows: rows.map(r => [r.level, r.ts, r.category ? `[${r.category}] ${r.msg}` : r.msg]),
    linkKey: 'ov.open_logs', linkSub: 'logs',
  });
}

function _dataLoad(i: SignalInputs): Signal {
  if (i.healthErr || !i.health) return _failedRead('data_load', i.healthErr, i.isAdmin, false) ?? _unavailable('data_load', 'no data');
  const h = i.health;
  const st = i.client.stats;
  const conds: Cond[] = [];
  const reload = _fix('data.reload', 'btn.reload_data');
  const pipe = _nav('nav.diagnostics', 'btn.open_diagnostics', 'diag-pipe');
  if (st && st.rendered < st.raw_received) conds.push({ sev: 'err', key: 'sig.data_gap', args: { n: st.raw_received - st.rendered }, fixes: [reload, pipe] });
  if (h.db.connected && i.client.tasks === 0) conds.push({ sev: 'err', key: 'sig.data_none', args: {}, fixes: [reload, pipe] });
  const ago = _ms(h.memory?.loaded_at) || i.now;
  return _pick('data_load', conds, { sev: 'ok', key: 'sig.data_ok', args: { orders: i.client.tasks, ago } }, {
    headKeys: ['sig.d_step', 'sig.d_count'],
    rows: [
      ['pipe.in_db', h.db.total_orders ?? null],
      ['pipe.sent', st ? st.raw_received : null],
      ['pipe.loaded', st ? st.rendered : null],
    ],
    linkKey: 'btn.open_diagnostics', linkSub: 'diagnostics', linkAnchor: 'diag-pipe',
  });
}

function _connections(i: SignalInputs, t: Thresholds): Signal {
  if (i.healthErr || !i.health) return _failedRead('connections', i.healthErr, i.isAdmin, false) ?? _unavailable('connections', 'no data');
  const p = _poolUsed(i.health.pool);
  const diagAt = (anchor: string): Fix => _nav('nav.diagnostics', 'btn.open_diagnostics', anchor);
  const conds: Cond[] = [];
  const locks = _rows<{ blocked_pid: number }>(i.dbDeep?.locks).length;
  if (locks > 0) conds.push({ sev: 'err', key: 'sig.conn_locks', args: { n: locks }, fixes: [diagAt('diag-db-locks')] });
  const poolArgs = { used: p.used, max: p.max, pct: p.pct };
  if (p.pct >= t.poolErrPct) conds.push({ sev: 'err', key: 'sig.conn_pool', args: poolArgs, fixes: [diagAt('diag-db-pool')] });
  const slowest = Math.max(0, ...(i.dbDeep?.slow_queries.available ? i.dbDeep.slow_queries.queries.map(q => q.mean_ms) : [0]));
  if (slowest > t.slowQueryErrMs) conds.push({ sev: 'err', key: 'sig.conn_slow', args: { ms: Math.round(slowest) }, fixes: [diagAt('diag-db-slow')] });
  if (p.pct >= t.poolWarnPct) conds.push({ sev: 'warn', key: 'sig.conn_pool', args: poolArgs, fixes: [diagAt('diag-db-pool')] });
  const waiting = i.health.pool.requests_waiting ?? 0;
  if (waiting > 0) conds.push({ sev: 'warn', key: 'sig.conn_waiting', args: { n: waiting }, fixes: [diagAt('diag-db-pool')] });
  const long = (i.dbDeep?.connections.long_running ?? []).filter(q => (q.duration_s ?? 0) > t.longQueryWarnS).length;
  if (long > 0) conds.push({ sev: 'warn', key: 'sig.conn_long', args: { n: long, s: t.longQueryWarnS }, fixes: [diagAt('diag-db-conn')] });
  if (slowest > t.slowQueryWarnMs) conds.push({ sev: 'warn', key: 'sig.conn_slow', args: { ms: Math.round(slowest) }, fixes: [diagAt('diag-db-slow')] });
  return _pick('connections', conds,
    { sev: 'ok', key: 'sig.conn_ok', args: { used: p.used, max: p.max, sessions: i.dbDeep?.connections.total ?? '–' } },
    { headKeys: [], rows: [], linkKey: 'btn.open_diagnostics', linkSub: 'diagnostics', linkAnchor: 'diag-db-conn' });
}

function _sap(i: SignalInputs): Signal {
  if (!i.isAdmin || i.sapErr === FORBIDDEN) return _adminOnly('sap');
  if (i.sapErr === NOT_FOUND) return { id: 'sap', severity: 'info', reasonKey: 'sig.sap_not_live', reasonArgs: {}, fixes: [], detail: null };
  if (i.sapErr) return _unavailable('sap', i.sapErr);
  if (!i.sap) return { id: 'sap', severity: 'info', reasonKey: 'sig.sap_no_plant', reasonArgs: {}, fixes: [], detail: null };
  const { status, batches, lastRun } = i.sap;
  const nav = _nav('nav.interface', 'btn.open_interface', 'sap:staging');
  const conds: Cond[] = [];
  if (status.error > 0) conds.push({ sev: 'err', key: 'sig.sap_errors', args: { n: status.error }, fixes: [nav] });
  const pending = batches.filter(b => b.status === 'ready' || b.status === 'validated' || b.status === 'held').length;
  if (pending > 0) conds.push({ sev: 'warn', key: 'sig.sap_pending', args: { n: pending }, fixes: [nav] });
  const sentAt = _ms(status.last_sent_at);
  const okCond: Cond = sentAt
    ? { sev: 'ok', key: 'sig.sap_ok', args: { ago: sentAt, rows: status.ready + status.sent + status.error, sent: status.sent } }
    : lastRun?.started_at
      ? { sev: 'ok', key: 'sig.sap_last_pull', args: { ago: _ms(lastRun.started_at) } }
      : { sev: 'ok', key: 'sig.sap_never', args: {} };
  return _pick('sap', conds, okCond, { headKeys: [], rows: [], linkKey: 'btn.open_interface', linkSub: 'interface', linkAnchor: 'sap:staging' });
}

function _browser(i: SignalInputs, t: Thresholds): Signal {
  const c = i.client;
  const reset = _fix('client.reset', 'btn.reset_client');
  const save = _fix('client.save', 'btn.save');
  const conds: Cond[] = [];
  if (c.inv.autosaveDisabled) conds.push({ sev: 'err', key: 'sig.browser_autosave_off', args: {}, fixes: [save] });
  if (c.errRate > t.errRateErrPerMin) conds.push({ sev: 'err', key: 'sig.browser_errors', args: { n: c.errors }, fixes: [reset] });
  if (c.inv.degraded) conds.push({ sev: 'info', key: 'sig.browser_degraded', args: {} });
  const heapPct = c.heapUsed !== undefined && c.heapLimit ? Math.round((c.heapUsed / c.heapLimit) * 100) : null;
  if (heapPct !== null && heapPct >= t.heapWarnPct) conds.push({ sev: 'warn', key: 'sig.browser_heap', args: { pct: heapPct }, fixes: [reset] });
  if (c.errors > 0) conds.push({ sev: 'warn', key: 'sig.browser_errors', args: { n: c.errors }, fixes: [reset] });
  const heap = c.heapUsed !== undefined ? `${Math.round(c.heapUsed / 1048576)} MB` : '–';
  return _pick('browser', conds, { sev: 'ok', key: 'sig.browser_ok', args: { build: c.build, schema: c.schema, heap } },
    { headKeys: [], rows: [], linkKey: 'btn.open_diagnostics', linkSub: 'diagnostics', linkAnchor: 'diag-client' });
}

/** Seven signals, worst first; ties keep the fixed id order. */
export function buildSignals(i: SignalInputs, t?: Partial<Thresholds>): Signal[] {
  const th: Thresholds = { ...THRESHOLDS, ...(t ?? {}) };
  const all: Signal[] = [_jobs(i), _database(i, th), _backend(i, th), _dataLoad(i), _connections(i, th), _sap(i), _browser(i, th)];
  return all
    .map((s, idx) => ({ s, idx }))
    .sort((a, b) => SEVERITY_RANK[b.s.severity] - SEVERITY_RANK[a.s.severity] || ID_ORDER.indexOf(a.s.id) - ID_ORDER.indexOf(b.s.id) || a.idx - b.idx)
    .map(x => x.s);
}

/** What needs a human, worst first, one item per cause, capped at 8; empty when everything is fine. */
export function buildAttention(signals: Signal[], i: SignalInputs): AttentionItem[] {
  const byId = new Map(signals.map(s => [s.id, s] as const));
  const out: AttentionItem[] = [];
  const seen = new Set<string>();
  const add = (it: AttentionItem): void => { if (!seen.has(it.id)) { seen.add(it.id); out.push(it); } };

  const jobsSig = byId.get('jobs');
  if (i.jobs && jobsSig && i.jobs.summary.failed24h > 0) {
    const lf = i.jobs.lastFailed[0];
    add({
      id: 'job_failed', severity: 'err', textKey: 'attn.job_failed',
      args: { job: lf?.job_name ?? '', plant: lf?.plant ?? '', ago: _ms(lf?.started_at ?? lf?.scheduled_for ?? lf?.ended_at) || i.now },
      fix: lf ? _fix('jobs.open_run', 'btn.open_run', { runId: lf.id }) : _nav('nav.jobs', 'ov.details', 'jobs:runs'),
    });
  }
  if (i.jobs && !i.jobs.summary.scheduler.ok) add({ id: 'scheduler_stale', severity: 'err', textKey: 'attn.scheduler_stale', args: {}, fix: _nav('nav.jobs', 'ov.details', 'jobs:jobs') });

  const be = i.backendErrors?.total ?? 0;
  const beSig = byId.get('backend');
  if (be > 0 && beSig) add({ id: 'backend_errors', severity: beSig.severity === 'err' ? 'err' : 'warn', textKey: 'attn.backend_errors', args: { n: be }, fix: _fix('logs.open', 'btn.view_logs', { source: 'backend', level: 'error' }) });

  const tables = i.dbDeep ? _rows<TableStatLike>(i.dbDeep.tables) : [];
  const vac = tables.filter(x => x.needs_vacuum).length;
  if (vac > 0) add({ id: 'vacuum', severity: 'warn', textKey: 'attn.vacuum', args: { n: vac }, fix: _fix('db.vacuum_all', 'btn.vacuum_analyze', undefined, true) });
  const locks = _rows<{ blocked_pid: number }>(i.dbDeep?.locks).length;
  if (locks > 0) add({ id: 'locks', severity: 'err', textKey: 'attn.locks', args: { n: locks }, fix: _nav('nav.diagnostics', 'btn.open_diagnostics', 'diag-db-locks') });

  const st = i.client.stats;
  if (st && st.rendered < st.raw_received) add({ id: 'gap', severity: 'err', textKey: 'attn.gap', args: { n: st.raw_received - st.rendered }, fix: _fix('data.reload', 'btn.reload_data') });

  if (i.sap) {
    if (i.sap.status.error > 0) add({ id: 'sap_errors', severity: 'err', textKey: 'attn.sap_errors', args: { n: i.sap.status.error }, fix: _nav('nav.interface', 'btn.open_interface', 'sap:staging') });
    const held = i.sap.batches.filter(b => b.status === 'held').length;
    if (held > 0) add({ id: 'sap_held', severity: 'warn', textKey: 'attn.sap_held', args: { n: held }, fix: _nav('nav.interface', 'btn.open_interface', 'sap:staging') });
  }
  if (i.client.inv.autosaveDisabled) add({ id: 'autosave', severity: 'err', textKey: 'attn.autosave', args: {}, fix: _fix('client.save', 'btn.save') });
  if (i.uploadWarnings && i.uploadWarnings.distribution > 0) {
    add({ id: 'distribution', severity: 'warn', textKey: i.uploadWarnings.distribution === 1 ? 'attn.distribution_one' : 'attn.distribution', args: { n: i.uploadWarnings.distribution, batchId: i.uploadWarnings.batchId }, fix: _nav('nav.order_maintenance', 'btn.open_history', 'admin-audit') });
  }

  return out
    .map((x, idx) => ({ x, idx }))
    .sort((a, b) => SEVERITY_RANK[b.x.severity] - SEVERITY_RANK[a.x.severity] || a.idx - b.idx)
    .map(e => e.x)
    .slice(0, 8);
}
