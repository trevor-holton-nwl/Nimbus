// admin-ops/unified-log.mts — the Admin Logs sub-tab's data model. Pure: no DOM, no fetch.
// The pane reads every source with its existing endpoint (backend ring, this browser's ErrorLog,
// audit, uploads, job runs, SAP runs, order changes) and these adapters turn each row into one
// UnifiedEntry; mergeEntries / filterEntries / sourceCounts / relatedTo are the list and the
// "Related" rail logic.
//
// "Plant plus global" rule: a plant filter keeps entries of THAT plant and entries with no plant
// (plant === null: backend rows without a plant context, browser rows without one, scheduler
// heartbeats). Entries carrying another plant drop. Unticking the global-carrying sources (Backend,
// Browser) with a plant set therefore yields a pure plant log. An empty plant filter is no filter.
// Exact join keys (rid, action id, order id, run id) group related rows; the user window group is
// always labelled "possible" because it is joined by time only.

import type { JobRun } from './jobs-client.mjs';

export type LogSource = 'backend' | 'frontend' | 'audit' | 'upload' | 'jobs' | 'events' | 'sap';
export type LogLevel = 'error' | 'warn' | 'info';

export interface UnifiedEntry {
  key: string;
  ts: string | null;
  tsMs: number | null;
  source: LogSource;
  level: LogLevel;
  user: string | null;
  plant: string | null;
  text: string;
  raw: unknown;
  rid?: string;
  errorCode?: string;
  actionId?: string;
  orderId?: string;
  runId?: string;
}

/* ---------------------------------------------------------------------------
   Source row shapes (structural copies of what each endpoint returns; the originals are not exported)
   ------------------------------------------------------------------------- */
/** One row of GET /logs/backend. */
export interface BackendLogEntry {
  ts: string; level: LogLevel; category: string; msg: string; rid?: string; error_code?: string;
  user?: string; actor?: string; ctx?: Record<string, unknown>; exc?: string; source?: 'frontend';
}
/** One entry of the browser ErrorLog ring. */
export interface LogEntry {
  ts: string; level: LogLevel; scope: string; msg: string; ctx?: unknown; reqId?: string; errorCode?: string;
  plant?: string; user?: string; seq?: number;
}
/** One row of GET /audit/log (rid / plant arrive with the W4b join keys). */
export interface AdminAuditLogItem { ts: string; user?: string; action?: string; plant?: string; rid?: string; details?: Record<string, unknown> }
/** One row of GET /upload/audit (rid / user arrive with the W4b join keys). */
export interface AdminUploadAuditItem {
  batch_id: string; filename: string | null; row_count: number; inserted: number; updated: number; uploaded_at: string | null;
  warnings: Array<{ level?: string; category?: string; msg?: string }>; rid?: string; user?: string; plant?: string;
}
/** One row of GET /schedule-events/{plant}/recent. */
export interface RecentScheduleEvent {
  id: number; at: string; actor: string | null; actor_name: string | null; source: string; op: string;
  action_id: string | null; client_id: string | null; order_id: string | null; production_order: string | null;
  material_number: string | null; fields: string[];
}
/** One row of GET /sap/interface/runs (sap_sync.list_runs; the table is global, so there is no plant). */
export interface SapInterfaceRun {
  id: number; object_key: string; started_at: string | null; ended_at: string | null; status: string;
  rows_read: number; rows_inserted: number; rows_updated: number; rows_failed: number; error: string | null;
  triggered_by: string | null; plant?: string | null;
}

const _ms = (ts: string | null | undefined): number | null => {
  if (!ts) return null;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : null;
};
const _s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : v == null || typeof v === 'object' ? null : String(v));
const _ctxStr = (ctx: unknown, k: string): string | null => (ctx && typeof ctx === 'object' ? _s((ctx as Record<string, unknown>)[k]) : null);

function _base(key: string, ts: string | null, source: LogSource, level: LogLevel, text: string, raw: unknown, user: string | null, plant: string | null): UnifiedEntry {
  return { key, ts, tsMs: _ms(ts), source, level, user, plant, text, raw };
}
function _opt<T extends UnifiedEntry>(e: T, extra: Partial<UnifiedEntry>): T {
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') (e as unknown as Record<string, unknown>)[k] = v;
  return e;
}

/* ---------------------------------------------------------------------------
   Adapters
   ------------------------------------------------------------------------- */
export function fromBackend(e: BackendLogEntry): UnifiedEntry {
  const ctx = e.ctx;
  const out = _base(`backend|${e.ts}|${e.rid ?? ''}|${e.category}|${e.msg}`, e.ts, 'backend', e.level, `[${e.category}] ${e.msg}`, e,
    _s(e.user) ?? _s(e.actor) ?? _ctxStr(ctx, 'actor'), _ctxStr(ctx, 'plant'));
  return _opt(out, {
    rid: e.rid, errorCode: e.error_code,
    actionId: _ctxStr(ctx, 'action_id') ?? undefined,
    orderId: _ctxStr(ctx, 'order_id') ?? _ctxStr(ctx, 'production_order') ?? undefined,
    runId: _ctxStr(ctx, 'run_id') ?? undefined,
  });
}

export function fromFrontend(e: LogEntry): UnifiedEntry {
  const out = _base(`frontend|${e.ts}|${e.seq ?? ''}|${e.scope}|${e.msg}`, e.ts, 'frontend', e.level, `[${e.scope}] ${e.msg}`, e, _s(e.user), _s(e.plant));
  return _opt(out, { rid: e.reqId, errorCode: e.errorCode });
}

export function fromAudit(e: AdminAuditLogItem): UnifiedEntry {
  const d = e.details;
  const detailTxt = d && Object.keys(d).length ? ` ${JSON.stringify(d)}` : '';
  const out = _base(`audit|${e.ts}|${e.user ?? ''}|${e.action ?? ''}`, e.ts, 'audit', 'info', `${e.action ?? 'audit'}${detailTxt}`, e, _s(e.user), _s(e.plant));
  return _opt(out, { rid: e.rid, orderId: _ctxStr(d, 'order_id') ?? _ctxStr(d, 'production_order') ?? undefined });
}

export function fromUpload(e: AdminUploadAuditItem): UnifiedEntry {
  const warns = (e.warnings ?? []).filter(w => w.category !== 'upload_counts');
  const text = `${e.filename ?? 'upload'}: ${e.row_count} rows (${e.inserted} new, ${e.updated} updated)${warns.length ? `, ${warns.length} warning${warns.length === 1 ? '' : 's'}` : ''}`;
  const out = _base(`upload|${e.batch_id}`, e.uploaded_at, 'upload', warns.length ? 'warn' : 'info', text, e, _s(e.user), _s(e.plant));
  return _opt(out, { rid: e.rid });
}

export function fromJobRun(r: JobRun): UnifiedEntry {
  const st = r.status;
  const level: LogLevel = st === 'failed' ? 'error' : st === 'warning' || st === 'skipped' || st === 'missed' ? 'warn' : 'info';
  const ts = r.started_at ?? r.scheduled_for;
  const text = `${r.job_name} (${st})${r.error ? `: ${r.error}` : ''}`;
  const out = _base(`jobs|${r.id}`, ts, 'jobs', level, text, r, r.triggered_by, r.plant || null);
  return _opt(out, { runId: String(r.id), actionId: r.summary?.action_id != null ? String(r.summary.action_id) : undefined });
}

export function fromScheduleEvent(e: RecentScheduleEvent, plant: string): UnifiedEntry {
  const who = e.actor_name ?? e.actor;
  const order = e.production_order ?? e.material_number ?? e.order_id ?? '';
  const text = `${e.op} ${order}${e.fields.length ? ` (${e.fields.join(', ')})` : ''} via ${e.source}`.replace(/\s+/g, ' ').trim();
  const out = _base(`events|${e.id}`, e.at, 'events', 'info', text, e, who ?? null, plant || null);
  return _opt(out, { actionId: e.action_id ?? undefined, orderId: e.order_id ?? e.production_order ?? undefined });
}

export function fromSapRun(r: SapInterfaceRun): UnifiedEntry {
  const st = String(r.status).toLowerCase();
  const level: LogLevel = st === 'failed' || st === 'error' || r.rows_failed > 0 && st !== 'success' ? 'error'
    : r.rows_failed > 0 || st === 'partial' || st === 'warning' ? 'warn' : 'info';
  const text = `${r.object_key} ${r.status}: ${r.rows_read} read, ${r.rows_inserted} new, ${r.rows_updated} updated, ${r.rows_failed} failed${r.error ? ` (${r.error})` : ''}`;
  return _base(`sap|${r.id}`, r.started_at, 'sap', level, text, r, r.triggered_by, _s(r.plant));
}

/* ---------------------------------------------------------------------------
   Merge / filter
   ------------------------------------------------------------------------- */
/** Newest first; entries with no timestamp last; ties by source then key so the order is stable. */
export function mergeEntries(lists: UnifiedEntry[][], limit = 500): UnifiedEntry[] {
  const all = lists.flat();
  all.sort((a, b) => {
    if (a.tsMs === null && b.tsMs !== null) return 1;
    if (a.tsMs !== null && b.tsMs === null) return -1;
    if (a.tsMs !== null && b.tsMs !== null && a.tsMs !== b.tsMs) return b.tsMs - a.tsMs;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return all.slice(0, limit);
}

/** actionId / orderId / runId are optional exact (case-insensitive) matches on the entry's join key; q keeps its
 *  substring semantics (text / user / rid / errorCode). Unset or '' means no constraint. */
export interface LogFilter {
  level: 'all' | LogLevel; sources: Set<LogSource>; user: string; plant: string; q: string;
  actionId?: string; orderId?: string; runId?: string;
}

const _LEVEL_OK: Record<'all' | LogLevel, (l: LogLevel) => boolean> = {
  all: () => true,
  warn: l => l === 'warn' || l === 'error',
  error: l => l === 'error',
  info: l => l === 'info',
};

function _match(e: UnifiedEntry, f: LogFilter, useSources: boolean): boolean {
  if (!_LEVEL_OK[f.level](e.level)) return false;
  if (useSources && f.sources.size > 0 && !f.sources.has(e.source)) return false;
  if (f.plant !== '' && !(e.plant === f.plant || e.plant === null)) return false;
  const u = f.user.trim().toLowerCase();
  if (u && (e.user ?? '').toLowerCase() !== u) return false;
  for (const [want, have] of [[f.actionId, e.actionId], [f.orderId, e.orderId], [f.runId, e.runId]] as const) {
    const w = (want ?? '').trim().toLowerCase();
    if (w && (have ?? '').toLowerCase() !== w) return false;
  }
  const q = f.q.trim().toLowerCase();
  if (q) {
    const hay = [e.text, e.user, e.rid, e.errorCode].map(x => (x ?? '').toLowerCase());
    if (!hay.some(h => h.includes(q))) return false;
  }
  return true;
}

export function filterEntries(entries: UnifiedEntry[], f: LogFilter): UnifiedEntry[] {
  return entries.filter(e => _match(e, f, true));
}

/** Per-source counts under every filter except the source one (what each checkbox would add). */
export function sourceCounts(entries: UnifiedEntry[], f: LogFilter): Record<LogSource, number> {
  const c: Record<LogSource, number> = { backend: 0, frontend: 0, audit: 0, upload: 0, jobs: 0, events: 0, sap: 0 };
  for (const e of entries) if (_match(e, f, false)) c[e.source]++;
  return c;
}

/* ---------------------------------------------------------------------------
   Related rail
   ------------------------------------------------------------------------- */
export interface RelatedGroup { kind: 'request' | 'action' | 'order' | 'run' | 'user_window'; key: string; whyKey: string; possible: boolean; entries: UnifiedEntry[] }

/** Groups of other entries related to `entry`: same request, action, order, job run (exact keys), then
 *  the same user within ±windowMs (possible, joined by time). The entry itself is excluded; empty groups omitted. */
export function relatedTo(entry: UnifiedEntry, all: UnifiedEntry[], windowMs = 300_000): RelatedGroup[] {
  const others = all.filter(e => e.key !== entry.key);
  const groups: RelatedGroup[] = [];
  const exact = (kind: RelatedGroup['kind'], val: string | undefined, whyKey: string, pick: (e: UnifiedEntry) => string | undefined): void => {
    if (!val) return;
    const hit = others.filter(e => pick(e) === val);
    if (hit.length) groups.push({ kind, key: val, whyKey, possible: false, entries: hit });
  };
  exact('request', entry.rid, 'ulog.rel_request', e => e.rid);
  exact('action', entry.actionId, 'ulog.rel_action', e => e.actionId);
  exact('order', entry.orderId, 'ulog.rel_order', e => e.orderId);
  exact('run', entry.runId, 'ulog.rel_run', e => e.runId);
  const u = (entry.user ?? '').toLowerCase();
  if (u && entry.tsMs !== null) {
    const t0 = entry.tsMs;
    const hit = others.filter(e => (e.user ?? '').toLowerCase() === u && e.tsMs !== null && Math.abs(e.tsMs - t0) <= windowMs);
    if (hit.length) groups.push({ kind: 'user_window', key: entry.user as string, whyKey: 'ulog.rel_user_window', possible: true, entries: hit });
  }
  return groups;
}
