// admin-ops/diag-sections.mts — the Admin Diagnostics page model. Pure: no DOM, no fetch, no imports from
// admin-ui. The pane gathers what it already reads (this browser's counters, the pipeline snapshot, the
// DB deep dive, the PerfMonitor rows) into one DiagInputs and calls buildDiagSections(); it gets back
// the 13 sections of the page in page order, each with a severity light, a header one-liner and the
// short figure the jump rail shows. Everything returned is data (locale keys + raw values); the pane
// formats times and numbers (ageMs / uptimeMs are raw milliseconds, 'ms' figures are rounded here).
//
// Rules:
//  - Thresholds come from signals.mts (THRESHOLDS), imported, never re-declared, so Diagnostics and the
//    Overview signal board agree. Operators match signals.mts exactly (pool, heap >=; long query, slow query, errors/min, ping >) so a value at a
//    threshold reads the same on Overview and here; sequences are > 80 / > 95
//    and "any" rules (any needs_vacuum, any lock wait, any waiting request).
//  - Missing input is never a silent ok: a failed or absent read is severity 'info' with
//    'diag.line_unavailable' (or 'sig.admin_only' for a 403 marker); a server-side list error sentinel
//    is 'err'. Unused indexes are advice only: the section stays 'ok' and the line carries the count; 'info' is for
//    unavailable / forbidden / empty inputs.
//  - defaultOpen: warn/err sections, the deep-link target, and the Database parent of a db-* target open.

import { THRESHOLDS, type Severity, SEVERITY_RANK } from './signals.mjs';

export type DiagSectionId = 'client' | 'pipe' | 'bwarn' | 'db' | 'db-pool' | 'db-server' | 'db-tables' | 'db-conn' | 'db-locks' | 'db-idx' | 'db-slow' | 'db-seq' | 'thread';

export interface DiagSection {
  id: DiagSectionId; severity: Severity; titleKey: string; count?: number;
  lineKey: string; lineArgs: Record<string, unknown>;   // one-line state in the header
  shortKey: string; shortArgs: Record<string, unknown>; // the rail's mono figure
}

/** This browser's counters. `autosave` is the already-translated backup state shown in the line; `degraded` = the last
 *  backup write failed or browser storage is blocked (the only backup state that is not ok). */
export interface ClientStats {
  build: string; autosave: string; degraded?: boolean; paused?: boolean;
  heapUsed?: number; heapLimit?: number;
  /** Browser errors per minute. */
  errRate: number;
}
/** The pipeline strip's counts (one active plant; inDb is all plants) plus the backend-warning count. */
export interface DeepData {
  forbidden?: boolean;
  inDb: number; plant: number; hasPlant: boolean; horizon: number; sent: number; loaded: number;
  /** sent - loaded, never negative. */
  gap: number;
  /** Rows the server dropped for having no start or finish. */
  dropped: number;
  warnings: number;
}
type ListOrError<T> = Array<T | { error: string }>;
/** GET /diagnostics/db (each list may be the `[{error}]` sentinel); `forbidden` marks a 403. */
export interface DbDeep {
  forbidden?: boolean;
  pool?: { pool_size?: number; pool_available?: number; pool_max?: number; requests_waiting?: number; error?: string };
  server?: { version?: string | null; started_at?: string | null; error?: string };
  tables?: ListOrError<{ needs_vacuum: boolean }>;
  connections?: { total?: number; long_running?: Array<{ duration_s: number | null }>; error?: string };
  locks?: ListOrError<{ blocked_pid: number }>;
  indexes?: ListOrError<{ unused: boolean }>;
  slow_queries?: { available: boolean; queries: Array<{ mean_ms: number }>; error?: string };
  sequences?: ListOrError<{ used_pct: number }>;
}
/** One PerfMonitor row (ms). */
export interface PerfSample { name: string; last: number; p50: number; p95: number; max: number }
export interface DiagInputs {
  client: ClientStats | null; deep: DeepData | null; dbDeep: DbDeep | null;
  perf: PerfSample[]; dbStatsAt: number | null; now: number;
  /** Optional: /health ping in ms, for the Server info light and line. */
  pingMs?: number | null;
}

type Thresholds = typeof THRESHOLDS;

const PAGE_ORDER: DiagSectionId[] = ['client', 'pipe', 'bwarn', 'db', 'db-pool', 'db-server', 'db-tables', 'db-conn', 'db-locks', 'db-idx', 'db-slow', 'db-seq', 'thread'];

/** Storage sizes are counted in UTF-16 code units ("chars", key plus value) everywhere in the admin UI; shown as thousands. */
export function fmtKChars(chars: number): string { return (Math.max(0, chars || 0) / 1000).toFixed(1); }

/** The backup state the admin UI reads off `Persistence.storageInventory()`: ok, failing (a record's last write failed), paused
 *  (this tab's autosave was halted by another tab) or blocked (browser storage unavailable). Blocked wins, then paused.
 *  A store that was simply never opened (no plant loaded yet) is neither: it reads as ok. */
export function backupState(inv: { degraded?: boolean; blocked?: boolean; paused?: boolean }): 'ok' | 'failed' | 'paused' | 'blocked' {
  if (inv.blocked) return 'blocked';
  if (inv.paused) return 'paused';
  return inv.degraded ? 'failed' : 'ok';
}

export const ANCHOR_IDS: Record<DiagSectionId, string> = Object.fromEntries(PAGE_ORDER.map(id => [id, `diag-${id}`])) as Record<DiagSectionId, string>;

const TITLE_KEYS: Record<DiagSectionId, string> = {
  client: 'ui.diag_client_title', pipe: 'ui.data_pipeline', bwarn: 'ui.backend_warnings', db: 'ui.db_deep_dive',
  'db-pool': 'ui.diag_section_pool', 'db-server': 'ui.diag_section_server', 'db-tables': 'ui.diag_section_table_health',
  'db-conn': 'ui.diag_section_connections', 'db-locks': 'ui.diag_section_lock_waits', 'db-idx': 'ui.diag_section_index_usage',
  'db-slow': 'ui.diag_section_slow_queries', 'db-seq': 'ui.diag_section_sequences', thread: 'thread.title',
};
const SHORT_KEYS: Record<DiagSectionId, string> = {
  client: 'diag.short_client', pipe: 'diag.short_pipe', bwarn: 'diag.short_bwarn', db: 'diag.short_db',
  'db-pool': 'diag.short_pool', 'db-server': 'diag.short_server', 'db-tables': 'diag.short_tables', 'db-conn': 'diag.short_conn',
  'db-locks': 'diag.short_locks', 'db-idx': 'diag.short_idx', 'db-slow': 'diag.short_slow', 'db-seq': 'diag.short_seq', thread: 'diag.short_thread',
};
const NA = '–';
const UNAVAILABLE = 'diag.line_unavailable';
const ADMIN_ONLY = 'sig.admin_only';

const _worst = (...s: Severity[]): Severity => s.reduce<Severity>((w, x) => (SEVERITY_RANK[x] > SEVERITY_RANK[w] ? x : w), 'ok');
const _isErrRow = (x: unknown): x is { error: string } => !!x && typeof x === 'object' && 'error' in (x as object);
const _listError = (l: ListOrError<object> | undefined): boolean => !!l && l.length > 0 && _isErrRow(l[0]);
const _rows = <T extends object>(l: ListOrError<T> | undefined): T[] => (l ?? []).filter((x): x is T => !_isErrRow(x));
const _round1 = (n: number): number => Math.round(n * 10) / 10;

function _shortArgsFor(id: DiagSectionId): Record<string, unknown> {
  switch (id) {
    case 'client': return { heap: NA };
    case 'pipe': return { loaded: NA };
    case 'bwarn': return { n: NA };
    case 'db': return { pct: NA };
    case 'db-pool': return { used: NA, max: NA, pct: NA };
    case 'db-server': return { ping: NA };
    case 'db-tables': return { vacuum: NA };
    case 'db-conn': return { n: NA };
    case 'db-locks': return { n: NA };
    case 'db-idx': return { n: NA };
    case 'db-slow': return { ms: NA };
    case 'db-seq': return { pct: NA };
    case 'thread': return { p95: NA };
  }
}
function _sec(id: DiagSectionId, severity: Severity, lineKey: string, lineArgs: Record<string, unknown>, shortArgs?: Record<string, unknown>, count?: number): DiagSection {
  const s: DiagSection = { id, severity, titleKey: TITLE_KEYS[id], lineKey, lineArgs, shortKey: SHORT_KEYS[id], shortArgs: shortArgs ?? _shortArgsFor(id) };
  if (count !== undefined) s.count = count;
  return s;
}
const _unavailable = (id: DiagSectionId, sev: Severity = 'info', key: string = UNAVAILABLE): DiagSection => _sec(id, sev, key, {});

/* ---------------------------------------------------------------------------
   Page sections
   ------------------------------------------------------------------------- */
function _client(c: ClientStats | null, t: Thresholds): DiagSection {
  if (!c) return _unavailable('client');
  const heapPct = c.heapUsed !== undefined && c.heapLimit ? Math.round((c.heapUsed / c.heapLimit) * 100) : null;
  let sev: Severity = 'ok';
  if (c.errRate > t.errRateErrPerMin) sev = 'err';
  else if (c.degraded || c.paused || (heapPct !== null && heapPct >= t.heapWarnPct) || c.errRate > 0) sev = 'warn';
  const heap = heapPct ?? NA;
  return _sec('client', sev, 'diag.line_client', { build: c.build, heap, autosave: c.autosave, errs: _round1(c.errRate) }, { heap });
}

function _pipe(d: DeepData | null): DiagSection {
  if (!d) return _unavailable('pipe');
  if (d.forbidden) return _unavailable('pipe', 'info', ADMIN_ONLY);
  const sev: Severity = d.gap > 0 ? 'err' : d.dropped > 0 ? 'warn' : 'ok';
  const n = (v: number): number | string => (d.hasPlant ? v : NA);
  return _sec('pipe', sev, 'diag.line_pipe', { inDb: d.inDb, plant: n(d.plant), horizon: n(d.horizon), sent: n(d.sent), loaded: n(d.loaded) }, { loaded: n(d.loaded) });
}

function _bwarn(d: DeepData | null): DiagSection {
  if (!d) return _unavailable('bwarn');
  if (d.forbidden) return _unavailable('bwarn', 'info', ADMIN_ONLY);
  return _sec('bwarn', d.warnings > 0 ? 'warn' : 'ok', 'diag.line_bwarn', {}, { n: d.warnings }, d.warnings);
}

/* ---------------------------------------------------------------------------
   Database sub-sections
   ------------------------------------------------------------------------- */
function _pool(db: DbDeep, t: Thresholds): DiagSection & { pct: number } {
  const p = db.pool;
  if (!p) return { ..._unavailable('db-pool'), pct: 0 };
  if (p.error) return { ..._unavailable('db-pool', 'err'), pct: 0 };
  const max = p.pool_max ?? 0;
  const used = Math.max(0, (p.pool_size ?? 0) - (p.pool_available ?? 0));
  const pct = max > 0 ? Math.round((used / max) * 100) : 0;
  const waiting = p.requests_waiting ?? 0;
  const sev: Severity = pct >= t.poolErrPct ? 'err' : pct >= t.poolWarnPct || waiting > 0 ? 'warn' : 'ok';
  return { ..._sec('db-pool', sev, 'diag.line_pool', { used, max, waiting }, { used, max, pct }), pct };
}

function _fmtVersion(v: string | null | undefined): string { return (v || '').split(' (')[0] || NA; }

function _server(db: DbDeep, now: number, ping: number | null | undefined, t: Thresholds): DiagSection {
  const s = db.server;
  if (!s) return _unavailable('db-server');
  if (s.error) return _unavailable('db-server', 'err');
  const started = s.started_at ? Date.parse(s.started_at) : NaN;
  const uptime = Number.isFinite(started) ? Math.max(0, now - started) : 0;
  const pingMs = typeof ping === 'number' ? Math.round(ping) : NA;
  const sev: Severity = typeof ping !== 'number' ? 'ok' : ping > t.dbPingErrMs ? 'err' : ping > t.dbPingWarnMs ? 'warn' : 'ok';
  if (typeof ping !== 'number') {
    // No reading: use the keys without the "ping {{ping}} ms" tail, so the unit never trails a dash.
    return { ..._sec('db-server', sev, 'diag.line_server_noping', { version: _fmtVersion(s.version), uptime }, {}), shortKey: 'diag.short_server_noping' };
  }
  return _sec('db-server', sev, 'diag.line_server', { version: _fmtVersion(s.version), uptime, ping: pingMs }, { ping: pingMs });
}

function _tables(db: DbDeep): DiagSection & { vacuum: number } {
  if (!db.tables) return { ..._unavailable('db-tables'), vacuum: 0 };
  if (_listError(db.tables)) return { ..._unavailable('db-tables', 'err'), vacuum: 0 };
  const rows = _rows(db.tables);
  const vacuum = rows.filter(r => r.needs_vacuum).length;
  return { ..._sec('db-tables', vacuum > 0 ? 'warn' : 'ok', 'diag.line_tables', { n: rows.length, vacuum }, { vacuum }, rows.length), vacuum };
}

function _conn(db: DbDeep, t: Thresholds): DiagSection & { over: number } {
  const c = db.connections;
  if (!c) return { ..._unavailable('db-conn'), over: 0 };
  if (c.error) return { ..._unavailable('db-conn', 'err'), over: 0 };
  const durations = (c.long_running ?? []).map(q => q.duration_s ?? 0);
  const longest = durations.length ? Math.max(...durations) : 0;
  const over = durations.filter(s => s > t.longQueryWarnS).length;
  const n = c.total ?? 0;
  return { ..._sec('db-conn', over > 0 ? 'warn' : 'ok', 'diag.line_conn', { n, longest: Math.round(longest) }, { n }, n), over };
}

function _locks(db: DbDeep): DiagSection {
  if (!db.locks) return _unavailable('db-locks');
  if (_listError(db.locks)) return _unavailable('db-locks', 'err');
  const n = _rows(db.locks).length;
  return n > 0
    ? _sec('db-locks', 'err', 'diag.line_locks_n', { n }, { n }, n)
    : _sec('db-locks', 'ok', 'diag.line_locks_ok', {}, { n: 0 }, 0);
}

function _idx(db: DbDeep): DiagSection {
  if (!db.indexes) return _unavailable('db-idx');
  if (_listError(db.indexes)) return _unavailable('db-idx', 'err');
  const rows = _rows(db.indexes);
  const n = rows.filter(r => r.unused).length;
  return _sec('db-idx', 'ok', 'diag.line_idx', { n }, { n }, rows.length);
}

function _slow(db: DbDeep, t: Thresholds): DiagSection {
  const q = db.slow_queries;
  if (!q || !q.available) return _unavailable('db-slow');
  const means = q.queries.map(x => x.mean_ms);
  if (!means.length) return _sec('db-slow', 'ok', 'diag.line_slow_ok', {}, { ms: 0 });
  const ms = Math.round(Math.max(...means));
  const raw = Math.max(...means);
  const n = means.filter(m => m > t.slowQueryWarnMs).length;
  const sev: Severity = raw > t.slowQueryErrMs ? 'err' : raw > t.slowQueryWarnMs ? 'warn' : 'ok';
  return _sec('db-slow', sev, 'diag.line_slow', { ms, n }, { ms });
}

function _seq(db: DbDeep): DiagSection {
  if (!db.sequences) return _unavailable('db-seq');
  if (_listError(db.sequences)) return _unavailable('db-seq', 'err');
  const rows = _rows(db.sequences);
  const top = rows.length ? Math.max(...rows.map(r => r.used_pct)) : 0;
  const pct = _round1(top);
  const sev: Severity = top > 95 ? 'err' : top > 80 ? 'warn' : 'ok';
  return _sec('db-seq', sev, 'diag.line_seq', { pct }, { pct }, rows.length);
}

function _database(i: DiagInputs, t: Thresholds): DiagSection[] {
  const db = i.dbDeep;
  if (!db || db.forbidden) {
    const key = db?.forbidden ? ADMIN_ONLY : UNAVAILABLE;
    return (['db', 'db-pool', 'db-server', 'db-tables', 'db-conn', 'db-locks', 'db-idx', 'db-slow', 'db-seq'] as DiagSectionId[]).map(id => _unavailable(id, 'info', key));
  }
  const pool = _pool(db, t);
  const server = _server(db, i.now, i.pingMs, t);
  const tables = _tables(db);
  const conn = _conn(db, t);
  const locks = _locks(db);
  const idx = _idx(db);
  const slow = _slow(db, t);
  const seq = _seq(db);
  const subs: DiagSection[] = [pool, server, tables, conn, locks, idx, slow, seq];
  const age = i.dbStatsAt === null ? null : Math.max(0, i.now - i.dbStatsAt);
  const stale = age !== null && age >= t.dbStatsStaleMs;
  const sev = _worst(...subs.map(s => s.severity), stale ? 'warn' : 'ok');
  const { pct: _p, ...poolSec } = pool;
  const { vacuum: _v, ...tablesSec } = tables;
  const { over: _o, ...connSec } = conn;
  const parent = _sec('db', sev, 'diag.line_db', { pool: pool.pct, vacuum: tables.vacuum, slow: conn.over, age }, { pct: pool.pct });
  return [parent, poolSec, server, tablesSec, connSec, locks, idx, slow, seq];
}

function _thread(perf: PerfSample[], t: Thresholds): DiagSection {
  void t;
  if (!perf.length) return _sec('thread', 'info', 'diag.line_thread_empty', {}, { p95: NA });
  let top = perf[0];
  for (const r of perf) if (r.p95 > top.p95) top = r;
  let slowest = perf[0];
  for (const r of perf) if (r.max > slowest.max) slowest = r;
  const sev: Severity = top.p95 >= 50 ? 'err' : top.p95 >= 16 ? 'warn' : 'ok';
  const p95 = _round1(top.p95);
  return _sec('thread', sev, 'diag.line_thread', { p95, op: slowest.name, ms: Math.round(slowest.max) }, { p95 });
}

/** Always 13 sections in page order. */
export function buildDiagSections(inputs: DiagInputs, thresholds: Thresholds = THRESHOLDS): DiagSection[] {
  const t = thresholds;
  const all: DiagSection[] = [
    _client(inputs.client, t), _pipe(inputs.deep), _bwarn(inputs.deep),
    ..._database(inputs, t),
    _thread(inputs.perf, t),
  ];
  return PAGE_ORDER.map(id => all.find(s => s.id === id) as DiagSection);
}

/** Open on first paint: warn/err, the deep-link target, and the Database parent of a db-* target. */
export function defaultOpen(sec: DiagSection, pendingAnchor: string | null): boolean {
  if (sec.severity === 'warn' || sec.severity === 'err') return true;
  if (pendingAnchor === null) return false;
  if (pendingAnchor === ANCHOR_IDS[sec.id]) return true;
  return sec.id === 'db' && pendingAnchor.startsWith('diag-db-');
}
