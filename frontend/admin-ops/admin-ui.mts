// admin-ops/admin-ui.mjs — AdminCockpit (health bar, pipeline inspector,
// backend warnings, filterable logs, upload, purge, upload history) and
// SystemConfig (System Configuration sub-tab). Extracted verbatim from
// plant-and-administration.mts (Phase P2 of
// docs/architecture/domain-refactor-plan.md, which split that
// 11,308-line mega-module into 9 domain files) — two non-contiguous
// source ranges combined into this one file per that phase's per-domain
// grouping.
/* global NIMBUS */
import { Config, Util, ErrorLog, Toast, Modal, PerfMonitor } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import type { StoreEvent } from '../platform/store.mjs';
import { Session } from '../security/session.mjs';
import { Persistence } from '../scheduling/persistence.mjs';
import { ORDER_FIELD_CATALOG } from '../scheduling/order-field-catalog.mjs';
import { AdminTables } from '../master-data/admin-tables.mjs';
// AdminCockpit's _setSub dispatches to these sub-tab renderers (Jobs: jobs-pane.mts).
import { MasterData } from '../master-data/admin-ui.mjs';
import { Interface } from '../integration/sap-interface-ui.mjs';
import { Security } from '../security/security-admin.mjs';
import { JobsAdmin } from './jobs-pane.mjs';
import { JobsClient } from './jobs-client.mjs';
import { UnifiedLogPane } from './unified-log-pane.mjs';
import type { JobRun } from './jobs-client.mjs';
import { buildSignals, buildAttention, FORBIDDEN, NOT_FOUND, THRESHOLDS } from './signals.mjs';
import { buildDiagSections, defaultOpen, ANCHOR_IDS } from './diag-sections.mjs';
import { buildPipelineSteps } from './pipeline-model.mjs';
import type { PipelineModel, PipelineStepKey } from './pipeline-model.mjs';
import type { ClientStats, DbDeep, DeepData, DiagInputs, DiagSection, DiagSectionId, PerfSample } from './diag-sections.mjs';
import type {
  AdminSub, AttentionItem, BackendCountLike, DbDeepLike, DetailTable, Fix, HealthLike, SapBatchHeader,
  SapRunLike, SapSendStatus, Signal, SignalId, SignalInputs,
} from './signals.mjs';
import { fromAudit, fromBackend, fromFrontend, fromJobRun, fromUpload, filterEntries, mergeEntries } from './unified-log.mjs';
import type { LogEntry as FrontendLogEntry, UnifiedEntry, LogFilter, LogSource } from './unified-log.mjs';

/** The eight Database sub-sections of the Diagnostics page, in page order, with the key of the help text each carries.
 *  Created as skeletons by AdminCockpit._ensureDbSubs and filled by _renderDbDeep (heads come from diag-sections.mts). */
const DB_SUBS: Array<{ id: DiagSectionId; help: string }> = [
  { id: 'db-pool', help: 'ui.diag_desc_pool' }, { id: 'db-server', help: 'ui.diag_desc_server' },
  { id: 'db-tables', help: 'ui.diag_desc_table_health' }, { id: 'db-conn', help: 'ui.diag_desc_connections' },
  { id: 'db-locks', help: 'ui.diag_desc_lock_waits' }, { id: 'db-idx', help: 'ui.diag_desc_index_usage' },
  { id: 'db-slow', help: 'ui.diag_desc_slow_queries' }, { id: 'db-seq', help: 'ui.diag_desc_sequences' },
];

/** Overview refresh cadence: the fast tier (health, backend counts, Jobs, SAP) and the slow tier (DB deep-dive, audit, uploads). */
const OV_FAST_MS = 30_000;
const OV_SLOW_MS = 300_000;
/** Fixes only an admin may run (the buttons are disabled for everyone else). */
const ADMIN_FIXES = new Set(['jobs.rerun', 'db.vacuum_all', 'db.vacuum_table']);

/** The last fast-tier read, cached so a client-only rebuild and the Recent panel can reuse it. */
interface OvFast {
  health: HealthLike | null; healthErr?: string | undefined;
  backendErrors: BackendCountLike | null; backendWarns: BackendCountLike | null; backendErr?: string | undefined;
  jobs: SignalInputs['jobs']; jobsErr?: string | undefined;
  sap: SignalInputs['sap']; sapErr?: string | undefined;
  plant: string;
}
/** The last slow-tier read; a failed read keeps the previous good data. */
interface OvSlow {
  dbDeep: DbDeepLike | null; dbDeepErr?: string | undefined; dbDeepAt: number;
  auditLog: AdminAuditLogItem[]; uploadAudit: AdminUploadAuditItem[]; at: number;
}

/* =============================================================================
   AdminCockpit backend response shapes — local interfaces for endpoints
   outside the backend's response_model= scope (GET /health, /diagnostics*,
   /logs/backend, POST /maintenance/*, /upload, /purge, /upload/audit,
   /audit/log), following schedule-data.mts's precedent for hand-written
   response interfaces (Phase 4). Fields are typed to what this module reads
   (cross-checked against brain.py/db.py), not the full backend shape.
   ========================================================================== */

/** DIAGNOSTICS.warnings entries (brain.py) — read by the pipeline "Emitted"
 *  step and rendered by _renderBackendWarnings / _warningList. */
interface AdminPipelineWarning {
  level?: 'info' | 'warn' | 'error';
  msg?: string;
  ts?: string;
  context?: Record<string, unknown>;
}

/** db.get_pool_stats() — shared by GET /health and GET /diagnostics/db. */
interface AdminPoolStats {
  pool_min?: number;
  pool_max?: number;
  pool_size?: number;
  pool_available?: number;
  requests_waiting?: number;
  requests_completed?: number;
  requests_errors?: number;
  returns_bad?: number;
  error?: string;
}

/** GET /health (brain.py get_health) — polled every 30s by the health bar. */
interface AdminHealthResponse {
  db: {
    connected: boolean;
    ping_ms: number;
    total_orders?: number;
    user_overrides?: number;
    last_upload_file?: string | null;
    last_upload_at?: string | null;
    error?: string;
  };
  pool: AdminPoolStats;
  memory: {
    stateless: boolean;
    loaded: boolean;
    task_count: number;
    loaded_at: string | null;
    load_ms?: number | null;
  };
}

/** brain.py's module-level DIAGNOSTICS dict, as returned by the `pipeline`
 *  key of GET /diagnostics/deep: ingest bookkeeping only (all plants, since restart). */
interface AdminPipelineSnapshot {
  loaded_at: string | null;
  source_file: string | null;
  unreadable_start_date: number;
  dropped_no_finish_date: number;
  warnings: AdminPipelineWarning[];
}

/** db.get_db_deep_stats() — the `db_stats` key of GET /diagnostics/deep
 *  (distinct from GET /diagnostics/db's per-table `tables`/AdminTableStat). */
interface AdminDbStatsDeep {
  total: number;
  null_start: number;
  null_end: number;
  null_color: number;
  null_line: number;
  null_desc: number;
  null_runtime: number;
  date_range: { min: string | null; max: string | null };
  by_line: Record<string, number>;
  error?: string;
}

/** GET /diagnostics/deep. */
interface AdminDiagnosticsDeepResponse {
  pipeline: AdminPipelineSnapshot;
  db_stats: AdminDbStatsDeep;
  /** Only with ?plant=: every order of that plant, no horizon filter. */
  plant_stats?: { plant: string; total: number };
}

interface AdminServerInfo {
  version?: string | null;
  started_at?: string | null;
  database?: string | null;
  db_size?: string | null;
  max_connections?: string | number | null;
  error?: string;
}

interface AdminTableStatData {
  table: string;
  live_rows: number;
  dead_rows: number;
  dead_pct: number;
  last_vacuum: string | null;
  last_autovacuum: string | null;
  last_analyze: string | null;
  last_autoanalyze: string | null;
  total_size: string;
  mods_since_analyze: number;
  needs_vacuum: boolean;
  needs_analyze: boolean;
}

/** db.get_db_table_stats() returns either N real rows or a single-element
 *  `[{error}]` sentinel list on failure — never a mix, and never a real row
 *  carrying an `error` field alongside its domain data. A discriminated
 *  union (rather than an optional `error?` bolted onto the domain shape)
 *  models that honestly and lets callers narrow with `'error' in x`. */
type AdminTableStat = AdminTableStatData | { error: string };

interface AdminLongRunningQuery {
  pid: number;
  state: string | null;
  duration_s: number | null;
  query: string | null;
  wait_event_type?: string | null;
  wait_event?: string | null;
  application?: string | null;
}

interface AdminConnectionActivity {
  total: number;
  by_state: Record<string, number>;
  long_running: AdminLongRunningQuery[];
  error?: string;
}

interface AdminLockWaitData {
  blocked_pid: number;
  blocked_query: string | null;
  blocking_pid: number;
  blocking_query: string | null;
  lock_type: string | null;
  blocked_for_s: number | null;
}

/** db.get_db_lock_waits() — same `[{error}]`-sentinel-on-failure shape as
 *  AdminTableStat; see that type's comment. */
type AdminLockWait = AdminLockWaitData | { error: string };

interface AdminIndexUsageData {
  table: string;
  index: string;
  scans: number;
  tuples_read: number;
  tuples_fetched: number;
  index_size: string;
  unused: boolean;
}

/** db.get_db_index_usage() — same `[{error}]`-sentinel-on-failure shape as
 *  AdminTableStat; see that type's comment. */
type AdminIndexUsage = AdminIndexUsageData | { error: string };

interface AdminSlowQuery {
  query: string;
  calls: number;
  total_ms: number;
  mean_ms: number;
  stddev_ms: number;
  rows: number;
}

interface AdminSlowQueriesResult {
  available: boolean;
  queries: AdminSlowQuery[];
  error?: string;
}

interface AdminSequenceHealthData {
  schema: string;
  name: string;
  data_type: string;
  last_value: number;
  max_value: number | null;
  used_pct: number;
  cycles: boolean;
  status: 'ok' | 'warn' | 'err';
}

/** db.get_db_sequence_health() — same `[{error}]`-sentinel-on-failure shape
 *  as AdminTableStat; see that type's comment. */
type AdminSequenceHealth = AdminSequenceHealthData | { error: string };

/** Postgres ops console list endpoints (db.get_db_table_stats /
 *  get_db_lock_waits / get_db_index_usage / get_db_sequence_health) return
 *  either N real rows or a single-element `[{error}]` sentinel on failure —
 *  never a mix. Narrows a raw union-typed list down to that error message
 *  (or null when the list holds real rows), so call sites can branch on a
 *  real discriminated-union check instead of an unenforced optional-chain
 *  probe like `list[0]?.error`. */
function _adminListError<T extends object>(list: ReadonlyArray<T | { error: string }>): string | null {
  const first = list[0];
  return first && 'error' in first ? first.error : null;
}

/** Companion to _adminListError: the same list narrowed to its real-data
 *  rows (empty array when the list is the `[{error}]` sentinel). */
function _adminListRows<T extends object>(list: ReadonlyArray<T | { error: string }>): T[] {
  return _adminListError(list) ? [] : (list as T[]);
}

/** GET /diagnostics/db — the Admin Cockpit DB Deep Dive panel. */
interface AdminDbDeepResponse {
  pool: AdminPoolStats;
  server: AdminServerInfo;
  tables: AdminTableStat[];
  connections: AdminConnectionActivity;
  locks: AdminLockWait[];
  indexes: AdminIndexUsage[];
  slow_queries: AdminSlowQueriesResult;
  sequences: AdminSequenceHealth[];
  fetched_at: string;
}

/** One row of the in-memory backend event ring buffer (brain.py _log_event /
 *  ingest_frontend_logs) — GET /logs/backend returns these, newest first. */
/** rid/error_code are always snake_case here — brain.py's _log_event and
 *  ingest_frontend_logs (the only two writers of the ring buffer this
 *  endpoint reads) never write camelCase reqId/errorCode, so those aliases
 *  were dropped rather than kept as permanently-undefined dead fields. */
export interface BackendLogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  category: string;
  msg: string;
  rid?: string;
  event?: string;
  outcome?: string;
  error_code?: string;
  error_type?: string;
  exc?: string;
  ctx?: Record<string, unknown>;
  source?: 'frontend';
  /** Acting user, when the event carries one (alias of actor). */
  user?: string;
  actor?: string;
}

/** POST /maintenance/vacuum-analyze | /maintenance/analyze. */
interface AdminMaintenanceResult {
  ok: boolean;
  status?: string;
  error?: string;
  error_code?: string;
  table?: string;
  results?: Record<string, string>;
}

interface AdminUploadWarning {
  level?: 'info' | 'warn' | 'error';
  msg?: string;
  status?: string;
  category?: string;
  // Upload counts entry (category 'upload_counts')
  inserted?: number;
  updated?: number;
  unchanged?: number;
  // Distribution warning fields
  parents_distributed?: number;
  children_upserted?: number;
  children_deleted?: number;
  headers_created?: number;
  headers_refreshed?: number;
  replanned_after_reweight?: number;
  single_rewrites?: number;
  duplicates_dropped?: number;
  conflicting_parent_rows?: unknown[];
  zero_quantity_children?: number;
  parent_runtime_defaulted?: number;
  ambiguous_plant?: unknown[];
  workcenter_without_members?: unknown[];
  default_machine_invalid?: unknown[];
}

/** POST /upload response (db.ingest_orders_from_excel). */
interface AdminUploadResult {
  status: 'ok' | 'error';
  message?: string;
  detail?: string;
  batch_id: string;
  raw_row_count: number;
  inserted: number;
  updated: number;
  /** Rows SAP sent nothing different for (skipped, nothing rewritten). */
  unchanged?: number;
  warnings: AdminUploadWarning[];
  lines?: string[];
  error_code?: string;
}

/** POST /purge/preview response (db.preview_purge_orders). */
interface AdminPurgePreview {
  status: string;
  plant: string;
  total: number;
  planner_overridden: number;
  message?: string;
  detail?: string;
  error_code?: string;
}

/** POST /purge response (db.purge_orders_by_date). */
interface AdminPurgeResult {
  status: string;
  deleted: number;
  plant?: string;
  machines?: string[];
  message?: string;
  detail?: string;
  error_code?: string;
}

/** One row of GET /upload/audit (db.upload_audit_log). */
export interface AdminUploadAuditItem {
  batch_id: string;
  filename: string | null;
  row_count: number;
  inserted: number;
  updated: number;
  uploaded_at: string | null;
  warnings: AdminUploadWarning[];
  /** Request id of the upload call (null on rows written before 2026-10-30). */
  rid?: string | null;
  user?: string;
  plant?: string;
}

interface AdminUploadAuditResponse {
  audit: AdminUploadAuditItem[];
}

/** One row of GET /audit/log (JSONL-backed color-wheel/optimizer audit trail). */
export interface AdminAuditLogItem {
  ts: string;
  user?: string;
  action?: string;
  plant?: string;
  rid?: string;
  details?: Record<string, unknown>;
}

/** Persistence._lastLoad snapshot (schedule-data.mts's unexported LoadStats),
 *  named the same ReturnType<typeof ...> way. */
type AdminPersistenceStats = ReturnType<typeof Persistence.stats>;

/** Persistence.storageInventory()'s unexported inline return shape, named the
 *  same ReturnType<typeof ...> way. */
type AdminStorageInventory = ReturnType<typeof Persistence.storageInventory>;

/** Chrome/V8-only `performance.memory` — not part of the standard DOM lib
 *  typings, so there is no ambient declaration to reuse; scoped locally since
 *  no other module in this migration reads it. */
interface ChromePerformanceMemory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
  totalJSHeapSize?: number;
}

/** A [label, value] pair rendered by _kvTable. */
type AdminKvRow = [string, string | number | null | undefined];

/** One row rendered by _dbTable (generic ad-hoc table builder — currently
 *  only fed the "non-idle queries" list under Active Connections). */
interface AdminDbTableRow {
  cells: Array<string | number | null>;
  rowWarn?: boolean;
  rowErr?: boolean;
  cellWarn: number[];
}

/** One box in the DB→Plant filter→Color merge→Emitted→Rendered pipeline strip
 *  built by _renderPipeline. */
interface AdminPipelineStep {
  key: string;
  label: string;
  count: number;
  delta: string | null;
  status: 'ok' | 'warn' | 'err';
  detail: () => DocumentFragment;
}

/* =============================================================================
   ADMIN COCKPIT — health bar, pipeline inspector, backend warnings,
   filterable logs, upload, purge, and upload history.
   ========================================================================== */
export const AdminCockpit = {
  _initialized: false,
  _pendingFile: null as File | null,
  _healthData: null as AdminHealthResponse | null,
  _deepData: null as AdminDiagnosticsDeepResponse | null,
  _ovTimer: null as ReturnType<typeof setInterval> | null,
  _ovTick: null as ReturnType<typeof setInterval> | null,
  _ovClientTimer: null as ReturnType<typeof setTimeout> | null,
  _ovPaused: false,
  _ovSeq: 0,
  _ovAbort: null as AbortController | null,
  _ovLastAt: 0,
  _ovFast: { health: null, backendErrors: null, backendWarns: null, jobs: null, sap: null, plant: '' } as OvFast,
  _ovSlow: { dbDeep: null, dbDeepAt: 0, auditLog: [], uploadAudit: [], at: 0 } as OvSlow,
  _ovOpenDetail: null as SignalId | null,
  _ovSignals: [] as Signal[],
  _ovAttention: [] as AttentionItem[],
  _ovSigKey: '',
  _pipelineOpen: null as string | null,
  /** The plant the cached /diagnostics/deep read was scoped to (null = none picked). */
  _deepPlant: null as string | null,
  _activeSub: 'overview',
  /** Deep-link target waiting for its element (a DOM id, or `jobs:<tab>` / `sap:<tab>`); cleared by every _setSub and once revealed. */
  _pendingAnchor: null as string | null,
  _dbDeepAbort: null as AbortController | null,
  _pipelineAbort: null as AbortController | null,
  // ── Diagnostics page (2026-10-30) ──
  /** Open/closed memory per section id. Written only by a user toggle (the capture-phase `toggle` listener on
   *  #admin-diag-pane) or an anchor reveal; it wins over the severity default (defaultOpen) on every repaint. */
  _diagOpen: new Map<string, boolean>(),
  /** The last buildDiagSections() result (13 sections, page order). */
  _diagSecs: [] as DiagSection[],
  _diagClient: null as ClientStats | null,
  _deepAt: 0,
  _deepForbidden: false,
  _dbDeepData: null as DbDeep | null,
  _dbDeepAt: 0,
  /** Rail scroll-spy: one IntersectionObserver, alive only while the Diagnostics sub-tab is showing. */
  _spy: null as IntersectionObserver | null,
  _spyVisible: new Set<string>(),
  _flashEl: null as HTMLElement | null,
  _flashTimer: null as ReturnType<typeof setTimeout> | null,
  /** The last pending-anchor reveal, kept so the first async paints can settle it once (see _settleReveal). */
  _lastReveal: null as { el: HTMLElement; scrollTop: number; at: number } | null,
  _auditAbort: null as AbortController | null,
  _fpPurgeStart: null as NimbusVendor.FlatpickrInstance | null,
  _fpPurgeEnd: null as NimbusVendor.FlatpickrInstance | null,
  _purgePlant: null as string | null,
  _purgePreview: null as AdminPurgePreview | null,
  _purgePreviewSeq: 0,

  gotoSub(sub: AdminSub, opts?: { anchor?: string }): void { AdminCockpit._setSub(sub, opts?.anchor); },

  _setSub(sub: string | undefined, anchor?: string): void {
    const known = ['overview', 'logs', 'diagnostics', 'order-maintenance', 'jobs', 'manage', 'interface', 'security', 'system-config', 'table-browser'];
    const cur = sub && known.includes(sub) ? sub : 'overview';
    AdminCockpit._activeSub = cur;
    // Set BEFORE the pane renders so _syncOpen sees it; always replaced, so a stale anchor never outlives a navigation.
    AdminCockpit._pendingAnchor = anchor ?? null;
    AdminCockpit._lastReveal = null;
    // An inner-tab anchor (jobs:<tab>, sap:<tab>) is resolved by _revealPendingAnchor, which renders the pane itself.
    const paneAnchor = /^(jobs|sap):/.test(anchor ?? '');
    document.querySelectorAll<HTMLElement>('.admin-subtab').forEach((b) => {
      b.classList.toggle('active', b.dataset.sub === cur);
    });
    const panes: Record<string, string> = {
      'admin-overview-pane': 'overview', 'admin-logs-pane': 'logs', 'admin-diag-pane': 'diagnostics',
      'admin-order-maint-pane': 'order-maintenance', 'admin-manage-pane': 'manage',
      'admin-interface-pane': 'interface', 'admin-security-pane': 'security',
      'admin-system-config-pane': 'system-config', 'admin-table-browser-pane': 'table-browser',
      'admin-jobs-pane': 'jobs',
    };
    for (const id of Object.keys(panes)) {
      const el = document.getElementById(id);
      if (el) el.hidden = (panes[id] !== cur);
    }
    if (cur !== 'overview') AdminCockpit._stopHealthPolling();
    if (cur !== 'jobs') JobsAdmin.setActive(false);
    if (cur !== 'logs') UnifiedLogPane.setActive(false);
    if (cur !== 'diagnostics') AdminCockpit._stopSpy();
    if (cur === 'manage') MasterData.render();
    else if (cur === 'interface') { if (!paneAnchor) void Interface.render(); }
    else if (cur === 'security') Security.render();
    else if (cur === 'system-config') SystemConfig.render();
    else if (cur === 'table-browser') AdminTables.render();
    else if (cur === 'jobs') { if (!paneAnchor) void JobsAdmin.render(); }
    else if (cur === 'logs') AdminCockpit._renderLogsPane();
    else if (cur === 'diagnostics') { AdminCockpit._startSpy(); AdminCockpit._renderDiagnosticsPane(); }
    else if (cur === 'order-maintenance') AdminCockpit._renderOrderMaintenance();
    else AdminCockpit._renderOverview();
    AdminCockpit._revealPendingAnchor();
  },

  init(): void {
    if (AdminCockpit._initialized) return;
    AdminCockpit._initialized = true;

    document.querySelectorAll<HTMLElement>('.admin-subtab').forEach((b) =>
      b.addEventListener('click', () => AdminCockpit._setSub(b.dataset.sub)));

    // Upload zone — drag-drop + click-browse
    const _uploadZone = document.getElementById('admin-upload-zone');
    const _uploadFile = document.getElementById('admin-upload-file') as HTMLInputElement | null;
    if (_uploadZone && _uploadFile) {
      _uploadZone.onclick    = (e: MouseEvent) => { if (e.target !== _uploadFile) _uploadFile.click(); };
      _uploadZone.onkeydown  = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _uploadFile.click(); } };
      _uploadFile.onchange   = () => { if (_uploadFile.files?.[0]) AdminCockpit._pickFile(_uploadFile.files[0]); };
      _uploadZone.ondragover = (e: DragEvent) => { e.preventDefault(); _uploadZone.classList.add('drag-over'); };
      _uploadZone.ondragleave= () => _uploadZone.classList.remove('drag-over');
      _uploadZone.ondrop     = (e: DragEvent) => {
        e.preventDefault();
        _uploadZone.classList.remove('drag-over');
        const f = e.dataTransfer?.files[0];
        if (f) AdminCockpit._pickFile(f);
      };
    }
    document.getElementById('admin-upload-clear')?.addEventListener('click', AdminCockpit._clearUpload);
    document.getElementById('admin-upload-btn')?.addEventListener('click', AdminCockpit._upload);
    document.getElementById('admin-purge-btn')?.addEventListener('click', AdminCockpit._purge);

    document.getElementById('admin-log-export-json')?.addEventListener('click', () => ErrorLog.exportJson());
    document.getElementById('admin-log-copy-filtered')?.addEventListener('click', () => AdminCockpit._copyFiltered());
    document.getElementById('admin-log-clear')?.addEventListener('click', () => {
      ErrorLog.clear();
      UnifiedLogPane.refreshFrontend();
    });

    document.getElementById('admin-audit-reload')?.addEventListener('click', AdminCockpit._renderAudit);
    document.getElementById('admin-audit-clear')?.addEventListener('click', AdminCockpit._clearAudit);
    document.getElementById('ulog-clear-upload')?.addEventListener('click', AdminCockpit._clearAudit);
    document.getElementById('admin-audit-log-clear')?.addEventListener('click', AdminCockpit._clearAuditLog);
    document.getElementById('ov-pause')?.addEventListener('click', () => AdminCockpit._setPaused(!AdminCockpit._ovPaused));
    document.getElementById('ov-refresh')?.addEventListener('click', () => { void AdminCockpit._refreshOverview({ force: true }); });
    document.getElementById('ov-open-logs')?.addEventListener('click', () => AdminCockpit.gotoSub('logs'));
    const onOvClick = (e: Event): void => {
      const t = e.target as HTMLElement | null;
      const fixBtn = t?.closest<HTMLButtonElement>('[data-fix]');
      if (fixBtn && !fixBtn.disabled) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(fixBtn.dataset.args || '{}') as Record<string, unknown>; } catch { args = {}; }
        void AdminCockpit._onSignalFix({ id: fixBtn.dataset.fix || '', labelKey: '', args, adminOnly: fixBtn.dataset.admin === '1' }, fixBtn);
        return;
      }
      const nav = t?.closest<HTMLElement>('[data-nav]');
      if (nav?.dataset.nav) { AdminCockpit.gotoSub(nav.dataset.nav as AdminSub, nav.dataset.anchor ? { anchor: nav.dataset.anchor } : undefined); return; }
      const det = t?.closest<HTMLElement>('.sig-details');
      if (det) AdminCockpit._toggleDetail(det);
    };
    document.getElementById('ov-signals')?.addEventListener('click', onOvClick);
    document.getElementById('ov-attention')?.addEventListener('click', onOvClick);
    // Diagnostics page head: one Refresh re-reads everything (the old per-card refresh buttons are gone).
    document.getElementById('admin-diag-refresh')?.addEventListener('click', () => AdminCockpit._renderDiagnosticsPane({ force: true }));
    document.getElementById('admin-diag-export')?.addEventListener('click', () => AdminCockpit._exportDiagnostics());
    const diagPane = document.getElementById('admin-diag-pane');
    diagPane?.addEventListener('toggle', (e: Event) => AdminCockpit._onDiagToggle(e), true);   // toggle does not bubble: capture
    diagPane?.addEventListener('click', (e: Event) => AdminCockpit._onDiagClick(e));
    document.getElementById('admin-db-deep')?.addEventListener('click', async (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('[data-maint-action]') as HTMLButtonElement | null;
      if (!btn) return;
      const action = btn.dataset.maintAction as 'vacuum-analyze' | 'analyze';
      const table  = btn.dataset.maintTable || null;
      if (action === 'vacuum-analyze' && !table) {
        const ok = await Modal.confirm({ title: Util.t('ui.maint_vacuum_all_confirm'), confirmLabel: Util.t('btn.run') });
        if (!ok) return;
      }
      AdminCockpit._runMaintenance(action, table, btn);
    });
    document.getElementById('admin-backend-log-clear')?.addEventListener('click', AdminCockpit._clearBackendLog);

    ErrorLog.subscribe(() => {
      const panel = document.getElementById('admin-tab');
      if (panel?.classList.contains('active') && AdminCockpit._activeSub === 'logs') {
        UnifiedLogPane.refreshFrontend();
      }
      AdminCockpit._queueClientRefresh();
    });

    document.getElementById('admin-thread-clear')?.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();   // the button sits inside the <summary>: do not toggle the section
      PerfMonitor.clear();
      AdminCockpit._refreshThreadPane();
    });

    PerfMonitor.subscribe(() => {
      if (AdminCockpit._activeSub === 'diagnostics') AdminCockpit._refreshThreadPane();
    });

    Store.subscribe((evt: StoreEvent) => {
      if (evt.type === 'plant:selected') {
        // Jobs and SAP are read for the selected plant only: re-read when it changes.
        if (AdminCockpit._isOverviewActive()) void AdminCockpit._refreshOverview();
      }
      if (evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate') {
        const panel = document.getElementById('admin-tab');
        if (panel?.classList.contains('active') && AdminCockpit._activeSub === 'diagnostics') {
          // Defer so Persistence._lastLoad stats are fully written before rendering.
          setTimeout(() => AdminCockpit._renderPipeline(), 50);
        }
        AdminCockpit._queueClientRefresh();
      }
    }, 'AdminCockpit');
  },

  render(): void {
    AdminCockpit._setSub('overview');
  },

  _renderOverview(): void {
    void AdminCockpit._refreshOverview({ force: true });
    AdminCockpit._startHealthPolling();
  },

  _renderLogsPane(): void {
    UnifiedLogPane.init();
    void UnifiedLogPane.render();
    UnifiedLogPane.setActive(true);
  },

  /** Entry for the Diagnostics sub-tab and the head Refresh. Paints the rail and the 13 section heads from what is
   *  already cached (so the page never opens blank), then lets each body renderer re-read and repaint its own heads.
   *  `force` is accepted for the head Refresh; the body renderers always re-read, so it changes nothing today. */
  _renderDiagnosticsPane(opts: { force?: boolean } = {}): void {
    void opts.force;
    AdminCockpit._computeClientStats();
    // Skeletons and heads exist synchronously, so a deep link is revealed here, before any read starts. The later
    // _repaintHeads calls find the anchor already cleared (no re-scroll) and keep the target open through _diagOpen.
    AdminCockpit._ensureDbSubs();
    AdminCockpit._repaintHeads();
    AdminCockpit._revealPendingAnchor();
    AdminCockpit._renderDiagnostics();
    AdminCockpit._renderPipeline();
    AdminCockpit._renderDbDeep();
    AdminCockpit._refreshThreadPane();
  },

  /* -----------------------------------------------------------------------
     DIAGNOSTICS PAGE MODEL -> DOM. diag-sections.mts (pure) decides severity, count, one-liner and rail
     figure for the 13 sections; the functions below only paint that result. Heads are updated in place:
     a <details> element is created once and never replaced, so a repaint cannot collapse what the user opened.
     ----------------------------------------------------------------------- */

  /** This browser's counters (cached: the thread profiler repaints often and must not walk localStorage each time). */
  _computeClientStats(): ClientStats | null {
    try {
      const inv = Persistence.storageInventory();
      const mem = (performance as Performance & { memory?: ChromePerformanceMemory }).memory;
      const c: ClientStats = {
        build: Config.BUILD_ID,
        autosave: inv.autosaveDisabled ? Util.t('ui.ls_quota_disabled') : inv.degraded ? Util.t('ui.ls_degraded') : Util.t('ui.ls_healthy'),
        autosaveDisabled: !!inv.autosaveDisabled, degraded: !!inv.degraded,
        errRate: ErrorLog.errorRatePerMin(),
      };
      if (mem) { c.heapUsed = mem.usedJSHeapSize; c.heapLimit = mem.jsHeapSizeLimit; }
      AdminCockpit._diagClient = c;
      return c;
    } catch { return null; }
  },

  /** The pipeline strip's counts, from the cached /diagnostics/deep read and this browser's last load. */
  _diagDeep(): DeepData | null {
    const A = AdminCockpit;
    if (A._deepForbidden) return { forbidden: true, inDb: 0, plant: 0, hasPlant: false, horizon: 0, sent: 0, loaded: 0, gap: 0, dropped: 0, warnings: 0 };
    const d = A._deepData;
    if (!d) return null;
    const m = A._pipelineModel(d);
    const step = (k: PipelineStepKey): number => m.steps.find((x) => x.key === k)?.count ?? 0;
    return {
      inDb: m.inDb, plant: step('plant'), hasPlant: m.plant !== null, horizon: step('horizon'),
      sent: step('sent'), loaded: step('loaded'), gap: m.gap, dropped: m.dropped,
      warnings: ((d.pipeline || {}).warnings || []).length,
    };
  },

  /** The pipeline model from a /diagnostics/deep read plus this browser's last /tasks load (one source for the strip and the Diagnostics head). */
  _pipelineModel(d: AdminDiagnosticsDeepResponse): PipelineModel {
    const st: AdminPersistenceStats = Persistence.stats ? Persistence.stats() : ({} as AdminPersistenceStats);
    const meta = (st.backend_meta ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const he = meta.visibility_horizon_end;
    return buildPipelineSteps({
      inDb: d.db_stats?.total ?? 0,
      plant: AdminCockpit._deepPlant,
      plantTotal: d.plant_stats ? d.plant_stats.total : null,
      queried: num(meta.queried_row_count),
      droppedNoDates: num(meta.dropped_no_dates) ?? 0,
      horizonEnd: typeof he === 'string' && he ? he : null,
      sent: st.raw_received ?? 0,
      loaded: st.rendered ?? 0,
    });
  },

  /** Everything buildDiagSections reads. The Database deep dive comes from the freshest of this page's own read and the Overview's slow tier. */
  _diagInputs(): DiagInputs {
    const A = AdminCockpit;
    let perf: PerfSample[] = [];
    try { perf = PerfMonitor.all().map((r) => ({ name: r.name, last: r.last, p50: r.p50, p95: r.p95, max: r.max })); } catch { perf = []; }
    const own = A._dbDeepData;
    const ov = A._ovSlow.dbDeep as unknown as DbDeep | null;
    const useOwn = own !== null && (A._dbDeepAt >= A._ovSlow.dbDeepAt || ov === null);
    const ping = A._healthData?.db?.ping_ms;
    return {
      client: A._diagClient, deep: A._diagDeep(), dbDeep: useOwn ? own : ov, perf,
      dbStatsAt: useOwn ? A._dbDeepAt : (A._ovSlow.dbDeepAt || null),
      now: Date.now(), pingMs: typeof ping === 'number' ? ping : null,
    };
  },

  /** Recompute all 13 sections and repaint the rail, every head and the page stamp. Cheap; every body renderer calls it when it finishes. */
  _repaintHeads(): void {
    const A = AdminCockpit;
    if (typeof document === 'undefined' || !document.getElementById('admin-diag-pane')) return;
    const secs = buildDiagSections(A._diagInputs());
    A._diagSecs = secs;
    A._renderDiagRail(secs);
    for (const s of secs) A._paintSectionHead(s);
    A._paintDiagStamp();
    A._observeSections();
    // A link that arrived before its section existed is revealed by the paint that creates it.
    A._revealPendingAnchor();
  },

  /** Pending deep-link target, or null. */
  _pendingAnchorValue(): string | null { return AdminCockpit._pendingAnchor; },

  /** Resolve the pending anchor if its target exists now. No-op (anchor kept) while the element is not in the DOM yet,
   *  so the paint that creates it reveals it; cleared on success, never throws. Anchor grammar: spec 6.7. */
  _revealPendingAnchor(): void {
    const A = AdminCockpit;
    const a = A._pendingAnchor;
    if (a === null || typeof document === 'undefined') return;
    const m = /^(jobs|sap):(.+)$/.exec(a);
    if (m) {
      // The inner-tab panes render themselves: act only while their sub-tab is the one showing, and only once.
      if (A._activeSub !== (m[1] === 'jobs' ? 'jobs' : 'interface')) return;
      A._pendingAnchor = null;
      void A._revealPaneTab(m[1] as 'jobs' | 'sap', m[2]);
      return;
    }
    const el = document.getElementById(a);
    if (!el) return;
    A._pendingAnchor = null;
    // A deep link jumps (no smooth scroll): a smooth scroll is computed against the skeleton layout, then stalls or lands
    // wrong when the reads fill the bodies above the target. Native scroll anchoring keeps the target put afterwards.
    A._revealAnchor(el, false);
    const sc = el.closest?.('.admin-scroll') ?? document.querySelector?.('.admin-scroll');
    A._lastReveal = sc ? { el, scrollTop: sc.scrollTop, at: Date.now() } : null;
  },

  /** After an async read paints (bodies above the target grew): re-scroll the deep-link target to the top once, but only
   *  while the reveal is under 5 s old, the target is still attached and the user has not scrolled (scrollTop unchanged).
   *  No flash, no focus change. Any other case drops the record. */
  _settleReveal(): void {
    const A = AdminCockpit;
    const r = A._lastReveal;
    if (!r) return;
    const sc = r.el.isConnected ? (r.el.closest?.('.admin-scroll') ?? document.querySelector?.('.admin-scroll')) : null;
    if (!sc || Date.now() - r.at > 5000 || sc.scrollTop !== r.scrollTop) { A._lastReveal = null; return; }
    r.el.scrollIntoView({ block: 'start', behavior: 'auto' });
    r.scrollTop = sc.scrollTop;
  },

  /** jobs:<tab> / sap:<tab>: render the pane, switch its inner view, then reveal the inner element. */
  async _revealPaneTab(pane: 'jobs' | 'sap', tab: string): Promise<void> {
    const A = AdminCockpit;
    try {
      let el: HTMLElement | null;
      if (pane === 'jobs') {
        await JobsAdmin.render();   // async: the first render awaits the type list
        JobsAdmin.showTab(tab as 'jobs' | 'runs' | 'upcoming' | 'templates');
        el = document.getElementById(`jobs-view-${tab}`);
      } else {
        await Interface.render();
        Interface.showTab(tab as 'overview' | 'staging' | 'mapping' | 'history');
        el = document.getElementById('sap-stage-batches') ?? document.getElementById('sap-tabbody');
      }
      if (el && A._activeSub === (pane === 'jobs' ? 'jobs' : 'interface')) A._revealAnchor(el);
    } catch { /* a failed pane render already reports itself; the link just lands on the sub-tab */ }
  },

  /** Section title without the "(N tables)" tail the legacy keys carry: the count is its own mono figure in the head. */
  _diagTitle(sec: DiagSection): string {
    const raw = Util.t(sec.titleKey, { count: sec.count ?? '' });
    return raw.replace(/\s*\([^)]*\)\s*$/, '') || raw;
  },

  /** Compact elapsed time for an uptime ("3d", "4h"); the unit letters are not localised (same as the ms / MB figures). */
  _diagDur(ms: number): string {
    if (!(ms > 0)) return '–';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  },

  /** The header one-liner: raw ages and uptimes from the model become words here. */
  _diagLine(sec: DiagSection): string {
    const a: Record<string, unknown> = { ...sec.lineArgs };
    if ('age' in a) a.age = typeof a.age === 'number' ? AdminCockpit._relTime(Date.now() - a.age) : '–';
    if ('uptime' in a) a.uptime = AdminCockpit._diagDur(Number(a.uptime));
    return Util.t(sec.lineKey, a as Record<string, string | number>);
  },

  /** Paint one section head (severity, title, count, line) and apply the open/closed rule. No-op if the section is not in the DOM. */
  _paintSectionHead(sec: DiagSection): void {
    const A = AdminCockpit;
    const det = document.getElementById(ANCHOR_IDS[sec.id]) as HTMLDetailsElement | null;
    if (!det) return;
    det.dataset.sev = sec.severity;
    const set = (sel: string, text: string): HTMLElement | null => {
      const n = det.querySelector<HTMLElement>(sel);   // first match is this section's own head (the summary precedes any nested section)
      if (n && n.textContent !== text) n.textContent = text;
      return n;
    };
    set('.diag-title-text', A._diagTitle(sec));
    set('.diag-count', sec.count !== undefined ? String(sec.count) : '');
    const line = A._diagLine(sec);
    set('.diag-line', line)?.setAttribute('title', line);
    A._syncOpen(det, sec);
  },

  /** Open state: the user's memory first, the severity default second (warn/err open, deep-link target open). */
  _syncOpen(det: HTMLDetailsElement, sec: DiagSection): void {
    const A = AdminCockpit;
    const pending = A._pendingAnchorValue();
    let want = A._diagOpen.get(det.id);
    if (want === undefined) {
      want = defaultOpen(sec, pending);
      // Opened only because of a deep link: remember it, or the repaint after the anchor clears would close it again.
      if (want && pending !== null && !defaultOpen(sec, null)) A._diagOpen.set(det.id, true);
    }
    if (det.open !== want) {
      det.dataset.diagAuto = want ? '1' : '0';   // marks the toggle event this change will fire as ours, not the user's
      det.open = want;
    }
  },

  _onDiagToggle(e: Event): void {
    const det = e.target as HTMLDetailsElement | null;
    if (!det || det.tagName !== 'DETAILS' || !det.id) return;
    if (!det.classList.contains('diag-sec') && !det.classList.contains('diag-sub')) return;
    const auto = det.dataset.diagAuto;
    if (auto !== undefined) {
      delete det.dataset.diagAuto;
      if (auto === (det.open ? '1' : '0')) return;   // the echo of our own programmatic change
    }
    AdminCockpit._diagOpen.set(det.id, det.open);
  },

  /** Delegated clicks inside the pane: rail links and any [data-anchor] button jump to a section; a help dot inside a head must not toggle it. */
  _onDiagClick(e: Event): void {
    const t = e.target as HTMLElement | null;
    if (t?.closest('.diag-sec-sum .adm-help')) { e.preventDefault(); return; }
    const link = t?.closest<HTMLElement>('[data-anchor]');
    if (!link) return;
    e.preventDefault();
    const el = document.getElementById(link.dataset.anchor || '');
    if (el) AdminCockpit._revealAnchor(el);
  },

  /** Open `el` and every <details> above it, scroll it into view (the scroller is .admin-scroll, found by the browser),
   *  flash it once, and put keyboard focus on its summary. Reduced motion: no smooth scroll, outline only (CSS). */
  _revealAnchor(el: HTMLElement, smooth: boolean = true): void {
    const A = AdminCockpit;
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      if (n.tagName === 'DETAILS') (n as HTMLDetailsElement).open = true;
    }
    const reduced = !smooth || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    el.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    if (A._flashEl) A._flashEl.classList.remove('is-target');
    if (A._flashTimer) clearTimeout(A._flashTimer);
    void el.offsetWidth;   // re-revealing the same section restarts its flash
    el.classList.add('is-target');
    const done = (): void => { el.classList.remove('is-target'); if (A._flashEl === el) A._flashEl = null; };
    A._flashEl = el;
    el.addEventListener('animationend', done, { once: true });
    A._flashTimer = setTimeout(done, 2600);   // reduced motion: animationend never fires
    const focusTarget = el.tagName === 'DETAILS' ? el.querySelector<HTMLElement>('summary') : (el.getAttribute('tabindex') === '-1' ? el : null);
    focusTarget?.focus({ preventScroll: true });
  },

  /** Scroll-spy: lights the rail link of the section crossing the top band of .admin-scroll. */
  _startSpy(): void {
    const A = AdminCockpit;
    A._stopSpy();
    if (typeof IntersectionObserver === 'undefined') return;
    const root = document.getElementById('admin-diag-pane')?.closest?.('.admin-scroll') ?? null;
    A._spy = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const id = (en.target as HTMLElement).id;
        if (en.isIntersecting) A._spyVisible.add(id); else A._spyVisible.delete(id);
      }
      A._paintSpy();
    }, { root, rootMargin: '-80px 0px -60% 0px' });
    A._observeSections();
  },

  _stopSpy(): void {
    const A = AdminCockpit;
    A._spy?.disconnect();
    A._spy = null;
    A._spyVisible.clear();
  },

  /** Observe every section and sub-section now in the DOM (the Database sub-sections appear after the first paint). */
  _observeSections(): void {
    const spy = AdminCockpit._spy;
    if (!spy) return;
    document.querySelectorAll<HTMLElement>('.diag-sec[id], .diag-sub[id]').forEach((el) => spy.observe(el));
  },

  _paintSpy(): void {
    const A = AdminCockpit;
    const links = Array.from(document.querySelectorAll<HTMLElement>('#diag-rail .diag-rail-link'));
    let on = links.find((l) => A._spyVisible.has(l.dataset.anchor ?? ''));
    // Database and one of its sub-sections both cross the band: the sub-section is the more exact answer.
    if (on?.dataset.anchor === 'diag-db') on = links.find((l) => l.classList.contains('is-sub') && A._spyVisible.has(l.dataset.anchor ?? '')) ?? on;
    for (const l of links) {
      const isOn = l === on;
      l.classList.toggle('is-on', isOn);
      if (isOn) l.setAttribute('aria-current', 'true'); else l.removeAttribute('aria-current');
    }
    // Keep the lit link inside the rail's own scroll box when the rail is shorter than its content (short windows).
    const rail = document.getElementById('diag-rail');
    if (on && rail && rail.scrollHeight > rail.clientHeight) {
      const top = on.offsetTop - rail.offsetTop;
      if (top < rail.scrollTop) rail.scrollTop = top - 8;
      else if (top + on.offsetHeight > rail.scrollTop + rail.clientHeight) rail.scrollTop = top + on.offsetHeight - rail.clientHeight + 8;
    }
  },

  /** Build the rail once (dot, title, mono figure per section; the eight db-* links indented), then update it in place. */
  _renderDiagRail(sections: DiagSection[]): void {
    const A = AdminCockpit;
    const rail = document.getElementById('diag-rail');
    if (!rail) return;
    if (!rail.querySelector('.diag-rail-link')) {
      rail.textContent = '';
      const cap = document.createElement('div');
      cap.className = 'diag-rail-cap';
      cap.textContent = Util.t('diag.rail_sections');
      rail.appendChild(cap);
      for (const sec of sections) {
        const a = document.createElement('a');
        a.className = sec.id.startsWith('db-') ? 'diag-rail-link is-sub' : 'diag-rail-link';
        a.href = `#${ANCHOR_IDS[sec.id]}`;
        a.dataset.anchor = ANCHOR_IDS[sec.id];
        a.dataset.sec = sec.id;
        const dot = document.createElement('span'); dot.className = 'diag-dot'; dot.setAttribute('aria-hidden', 'true');
        const ttl = document.createElement('span'); ttl.className = 'diag-rail-title';
        const sh = document.createElement('span'); sh.className = 'diag-rail-short';
        a.appendChild(dot); a.appendChild(ttl); a.appendChild(sh);
        rail.appendChild(a);
      }
    }
    for (const sec of sections) {
      const a = rail.querySelector<HTMLElement>(`[data-sec="${sec.id}"]`);
      if (!a) continue;
      a.dataset.sev = sec.severity;
      const title = A._diagTitle(sec);
      const ttl = a.querySelector<HTMLElement>('.diag-rail-title');
      if (ttl && ttl.textContent !== title) ttl.textContent = title;
      const short = Util.t(sec.shortKey, sec.shortArgs as Record<string, string | number>);
      const sh = a.querySelector<HTMLElement>('.diag-rail-short');
      if (sh && sh.textContent !== short) sh.textContent = short;
      a.title = `${title} · ${short}`;   // the label truncates with an ellipsis at 220 px
    }
  },

  /** Page head stamp: how old the two reads behind this page are. */
  _paintDiagStamp(): void {
    const A = AdminCockpit;
    const el = document.getElementById('admin-diag-ts');
    if (!el) return;
    const dbAt = A._dbDeepAt || A._ovSlow.dbDeepAt;
    const rel = (ms: number): string => (ms > 0 ? A._relTime(ms) : '–');
    el.textContent = Util.t('diag.stats_age', { db: rel(dbAt), pipe: rel(A._deepAt) });
  },

  /** Create the eight Database sub-section skeletons (once). Later calls find them by id and leave them alone. */
  _ensureDbSubs(): void {
    const A = AdminCockpit;
    const host = document.getElementById('admin-db-deep');
    if (!host) return;
    for (const s of DB_SUBS) A._mkSection(s.id, s.help, host);
  },

  /** One Database sub-section: <details class="diag-sub" id="diag-db-…"> with the same head grammar as a page section.
   *  Returns the existing element when there is one (repaint = update head and body in place, never replace the <details>). */
  _mkSection(id: DiagSectionId, helpKey: string | null, host: HTMLElement): HTMLDetailsElement {
    const existing = document.getElementById(ANCHOR_IDS[id]) as HTMLDetailsElement | null;
    if (existing) return existing;
    const det = document.createElement('details');
    det.className = 'diag-sub';
    det.id = ANCHOR_IDS[id];
    det.dataset.sev = 'info';
    const sum = document.createElement('summary');
    sum.className = 'diag-sec-sum';
    const dot = document.createElement('span'); dot.className = 'diag-dot'; dot.setAttribute('aria-hidden', 'true');
    const ttl = document.createElement('span'); ttl.className = 'diag-title';
    const tt = document.createElement('span'); tt.className = 'diag-title-text';
    const cnt = document.createElement('span'); cnt.className = 'diag-count';
    ttl.appendChild(tt); ttl.appendChild(cnt);
    if (helpKey) {
      const hEl = document.createElement('span');
      hEl.className = 'adm-help';
      hEl.tabIndex = 0;
      hEl.setAttribute('aria-label', Util.t('aria.help'));
      const hDot = document.createElement('span'); hDot.className = 'adm-help-dot'; hDot.textContent = '?';
      const hTip = document.createElement('span'); hTip.className = 'adm-help-tip'; hTip.textContent = Util.t(helpKey);
      hEl.appendChild(hDot); hEl.appendChild(hTip);
      ttl.appendChild(hEl);
    }
    const line = document.createElement('span'); line.className = 'diag-line';
    const chev = document.createElement('span'); chev.className = 'diag-chev'; chev.setAttribute('aria-hidden', 'true');
    sum.appendChild(dot); sum.appendChild(ttl); sum.appendChild(line); sum.appendChild(chev);
    det.appendChild(sum);
    const body = document.createElement('div');
    body.className = 'diag-body';
    body.textContent = Util.t('ui.diag_loading');
    det.appendChild(body);
    host.appendChild(det);
    return det;
  },

  /** Replace one sub-section's body (the head is repainted by _repaintHeads). */
  _fillSub(id: DiagSectionId, build: (body: HTMLElement) => void): void {
    const body = document.getElementById(ANCHOR_IDS[id])?.querySelector<HTMLElement>('.diag-body');
    if (!body) return;
    body.textContent = '';
    build(body);
  },

  _renderOrderMaintenance(): void {
    AdminCockpit._renderPurgeMeta();
    AdminCockpit._renderAudit();
  },

  /** Started by _renderOverview; called from application-shell.mjs's
   *  visibility-change handler once that file is converted (Phase 5) so this
   *  public start/stop pair's signature is load-bearing beyond this module.
   *  Runs the 30 s refresh tick (skipped while paused, the tab hidden or another
   *  sub-tab open) and a 1 s ticker that keeps "refreshed N s ago" honest. */
  _startHealthPolling(): void {
    if (!AdminCockpit._ovTimer) {
      AdminCockpit._ovTimer = setInterval(() => AdminCockpit._ovPoll(), OV_FAST_MS);
    }
    if (!AdminCockpit._ovTick) {
      AdminCockpit._ovTick = setInterval(() => AdminCockpit._renderOvMeta(), 1000);
    }
    AdminCockpit._renderOvMeta();
  },

  _stopHealthPolling(): void {
    if (AdminCockpit._ovTimer) { clearInterval(AdminCockpit._ovTimer); AdminCockpit._ovTimer = null; }
    if (AdminCockpit._ovTick) { clearInterval(AdminCockpit._ovTick); AdminCockpit._ovTick = null; }
    if (AdminCockpit._ovClientTimer) { clearTimeout(AdminCockpit._ovClientTimer); AdminCockpit._ovClientTimer = null; }
    AdminCockpit._ovAbort?.abort();
    AdminCockpit._ovAbort = null;
  },

  /** One tick of the 30 s timer. */
  _ovPoll(): void {
    if (AdminCockpit._ovPaused || AdminCockpit._activeSub !== 'overview') return;
    if (!document.getElementById('admin-tab')?.classList.contains('active')) return;
    void AdminCockpit._refreshOverview();
  },

  _isOverviewActive(): boolean {
    return AdminCockpit._activeSub === 'overview'
      && !!document.getElementById('admin-tab')?.classList.contains('active');
  },

  /** A burst of ErrorLog / Store events becomes one client-only rebuild. */
  _queueClientRefresh(): void {
    if (AdminCockpit._ovClientTimer || !AdminCockpit._isOverviewActive()) return;
    AdminCockpit._ovClientTimer = setTimeout(() => {
      AdminCockpit._ovClientTimer = null;
      if (AdminCockpit._isOverviewActive()) void AdminCockpit._refreshOverview({ clientOnly: true });
    }, 300);
  },

  _setPaused(on: boolean): void {
    AdminCockpit._ovPaused = on;
    const btn = document.getElementById('ov-pause');
    if (btn) {
      btn.textContent = Util.t(on ? 'btn.resume' : 'btn.pause');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    AdminCockpit._renderOvMeta();
    if (!on && AdminCockpit._activeSub === 'overview') void AdminCockpit._refreshOverview();
  },

  /** GET a JSON path under the API base with a timeout and an optional caller abort.
   *  401/403 throw Error('forbidden') and 404 Error('not_found') (the signal model's FORBIDDEN / NOT_FOUND);
   *  any other non-2xx throws Error('HTTP <status>'). The error carries `status`. */
  async _fetchJson<T>(path: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const parts: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (signal) parts.push(signal);
    const sig = AbortSignal.any ? AbortSignal.any(parts) : (signal ?? parts[0]);
    const r = await Util.fetchTraced(`${Config.API_BASE}${path}`, { signal: sig });
    if (!r.ok) {
      const msg = r.status === 401 || r.status === 403 ? FORBIDDEN : r.status === 404 ? NOT_FOUND : `HTTP ${r.status}`;
      throw Object.assign(new Error(msg), { status: r.status });
    }
    return await r.json() as T;
  },

  /** A rejected read as the string the signal model expects ('forbidden', 'not_found' or a message). */
  _ovErr(e: unknown): string {
    const m = (e as Error | null)?.message ?? String(e);
    if (m === FORBIDDEN || /HTTP 40[13]\b/.test(m)) return FORBIDDEN;
    if (m === NOT_FOUND || /HTTP 404\b/.test(m)) return NOT_FOUND;
    return m || 'error';
  },

  /** Read the Overview sources and rebuild the board. Fast tier every call (health, backend counts, Jobs, SAP);
   *  slow tier (DB deep-dive, audit, uploads) only on `force` or when older than OV_SLOW_MS, keeping the last good
   *  data when a slow read fails. `clientOnly` rebuilds from the cached payloads plus this browser's live counters. */
  async _refreshOverview(o: { force?: boolean; clientOnly?: boolean } = {}): Promise<void> {
    const A = AdminCockpit;
    // A client-only rebuild must not cancel an in-flight fetch refresh (ErrorLog events would starve the board).
    const seq = o.clientOnly ? A._ovSeq : ++A._ovSeq;
    if (!o.clientOnly) A._ovAbort?.abort();
    const ctl = o.clientOnly ? (A._ovAbort ?? new AbortController()) : new AbortController();
    if (!o.clientOnly) A._ovAbort = ctl;
    // Jobs reads take no abort signal: bound each by a timeout so one hung request cannot stall the whole settle.
    const bound = <T,>(p: Promise<T>): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))]);
    const plant = Store.selectedPlant ?? '';
    const isAdmin = Session.isAdmin();
    const ok = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null);
    const er = <T,>(r: PromiseSettledResult<T>): string | undefined => (r.status === 'rejected' ? A._ovErr(r.reason) : undefined);

    if (!o.clientOnly) {
      const since = encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString());
      const bl = (lvl: string): Promise<BackendCountLike> =>
        A._fetchJson<BackendCountLike>(`/logs/backend?level=${lvl}&since=${since}&limit=5`, 6000, ctl.signal);
      const sapOn = !!plant && isAdmin;
      const empty = { items: [] as JobRun[], nextBeforeId: null };
      const slowDue = !!o.force || !A._ovSlow.at || Date.now() - A._ovSlow.at > OV_SLOW_MS;
      const slowP = slowDue ? Promise.allSettled([
        A._fetchJson<DbDeepLike>('/diagnostics/db', 10_000, ctl.signal),
        A._fetchJson<{ entries?: AdminAuditLogItem[] }>('/audit/log?limit=20', 10_000, ctl.signal),
        A._fetchJson<{ audit?: AdminUploadAuditItem[] }>('/upload/audit', 10_000, ctl.signal),
      ]) : null;
      const [health, be, bw, jsum, jfail, jrecent, sst, sbat, srun] = await Promise.allSettled([
        A._fetchJson<HealthLike>('/health', 6000, ctl.signal),
        bl('error'), bl('warn'),
        bound(JobsClient.summary(plant)),
        plant ? bound(JobsClient.runs({ plant, status: 'failed', sinceHours: 24, limit: 1 })) : Promise.resolve(empty),
        plant ? bound(JobsClient.runs({ plant, limit: 3 })) : Promise.resolve(empty),
        sapOn ? A._fetchJson<SapSendStatus>(`/sap/staging/send/${encodeURIComponent(plant)}/status`, 6000, ctl.signal) : Promise.resolve(null),
        sapOn ? A._fetchJson<{ batches: SapBatchHeader[] }>(`/sap/staging/batches?plant=${encodeURIComponent(plant)}&limit=20`, 6000, ctl.signal) : Promise.resolve(null),
        sapOn ? A._fetchJson<{ runs: SapRunLike[] }>('/sap/interface/runs?limit=1', 6000, ctl.signal) : Promise.resolve(null),
      ]);
      const slow: PromiseSettledResult<unknown>[] | null = slowP ? await slowP : null;
      // A newer refresh started, or polling was stopped (abort): drop this response, never paint aborted errors.
      if (seq !== A._ovSeq || ctl.signal.aborted) return;   // a newer refresh started: drop this response

      const f: OvFast = { health: ok(health), healthErr: er(health), backendErrors: ok(be), backendWarns: ok(bw), backendErr: er(be) ?? er(bw), jobs: null, plant, sap: null };
      const sum = ok(jsum);
      if (sum) f.jobs = { summary: sum, lastFailed: ok(jfail)?.items ?? [], recent: ok(jrecent)?.items ?? [] };
      else f.jobsErr = er(jsum);
      if (sapOn) {
        const s = ok(sst);
        if (s) f.sap = { status: s, batches: ok(sbat)?.batches ?? [], lastRun: ok(srun)?.runs?.[0] ?? null, plant };
        else f.sapErr = er(sst);
      }
      A._ovFast = f;
      if (slow) {
        const now = Date.now();
        const [deep, audit, upl] = slow as [PromiseSettledResult<DbDeepLike>, PromiseSettledResult<{ entries?: AdminAuditLogItem[] }>, PromiseSettledResult<{ audit?: AdminUploadAuditItem[] }>];
        const s = A._ovSlow;
        const d = ok(deep);
        if (d) { s.dbDeep = d; s.dbDeepAt = now; s.dbDeepErr = undefined; s.at = now; }
        else if (!s.dbDeep) s.dbDeepErr = er(deep);   // keep the last good deep-dive when a later read fails
        const a = ok(audit); if (a) s.auditLog = a.entries ?? [];
        const u = ok(upl); if (u) s.uploadAudit = u.audit ?? [];
      }
    } else if (seq !== A._ovSeq) {
      return;
    }

    if (!o.clientOnly) A._ovLastAt = Date.now();
    const inputs = A._buildOvInputs(isAdmin);
    const signals = buildSignals(inputs);
    A._ovSignals = signals;
    A._ovAttention = buildAttention(signals, inputs);
    if (A._ovFast.health) A._healthData = A._ovFast.health as unknown as AdminHealthResponse;
    if (typeof document === 'undefined') return;
    A._renderSignals(signals);
    A._renderAttention(A._ovAttention);
    A._renderRecent();
    A._renderOvMeta();
  },

  _buildOvInputs(isAdmin: boolean): SignalInputs {
    const A = AdminCockpit;
    const f = A._ovFast;
    const s = A._ovSlow;
    let st: ReturnType<typeof Persistence.stats> | null = null;
    try { st = Persistence.stats ? Persistence.stats() : null; } catch { st = null; }
    let inv: { autosaveDisabled?: boolean; degraded?: boolean } = {};
    try { inv = Persistence.storageInventory(); } catch { inv = {}; }
    const mem = (typeof performance !== 'undefined'
      ? (performance as Performance & { memory?: ChromePerformanceMemory }).memory : undefined);
    const newestUpload = s.uploadAudit[0];
    const distribution = (newestUpload?.warnings ?? []).filter(w => w.category === 'distribution').length;
    const out: SignalInputs = {
      now: Date.now(),
      health: f.health, backendErrors: f.backendErrors, backendWarns: f.backendWarns,
      jobs: f.jobs, sap: f.sap,
      dbDeep: s.dbDeep,
      client: {
        stats: st ? { source: st.source, raw_received: st.raw_received, rendered: st.rendered } : null,
        inv,
        errors: ErrorLog.countBy('error'), warns: ErrorLog.countBy('warn'),
        errRate: ErrorLog.errorRatePerMin(),
        build: Config.BUILD_ID, schema: Config.SCHEMA_VERSION,
        tasks: Store.tasksArr.length,
      },
      isAdmin,
    };
    if (s.dbDeepAt) out.dbDeepAt = s.dbDeepAt;
    if (f.healthErr) out.healthErr = f.healthErr;
    if (s.dbDeepErr) out.dbDeepErr = s.dbDeepErr;
    if (f.backendErr) out.backendErr = f.backendErr;
    if (f.jobsErr) out.jobsErr = f.jobsErr;
    if (f.sapErr) out.sapErr = f.sapErr;
    if (mem) { out.client.heapUsed = mem.usedJSHeapSize; out.client.heapLimit = mem.jsHeapSizeLimit; }
    if (newestUpload && distribution > 0) out.uploadWarnings = { distribution, batchId: newestUpload.batch_id };
    return out;
  },

  /* ----- Overview rendering (DOM nodes + textContent only: server strings never reach innerHTML) ----- */

  _renderOvMeta(): void {
    const el = typeof document !== 'undefined' ? document.getElementById('ov-meta') : null;
    if (!el) return;
    const A = AdminCockpit;
    const parts: string[] = [];
    if (A._ovLastAt) parts.push(Util.t('ov.refreshed_ago', { n: Math.max(0, Math.round((Date.now() - A._ovLastAt) / 1000)) }));
    parts.push(A._ovPaused ? Util.t('ov.paused') : Util.t('ov.auto_every', { n: OV_FAST_MS / 1000 }));
    el.textContent = parts.join(' · ');
  },

  /** A future time ("in 5 min"), or the past form when it already happened. */
  _relFuture(ms: number): string {
    const diff = ms - Date.now();
    if (diff <= 0) return AdminCockpit._relTime(ms);
    const mins = Math.round(diff / 60_000);
    let loc = 'en';
    try { loc = Util.locale() || 'en'; } catch { /* default */ }
    try {
      const rtf = new Intl.RelativeTimeFormat(loc, { numeric: 'auto', style: 'short' });
      if (mins < 60) return rtf.format(Math.max(1, mins), 'minute');
      if (mins < 1440) return rtf.format(Math.round(mins / 60), 'hour');
      return rtf.format(Math.round(mins / 1440), 'day');
    } catch { return new Date(ms).toLocaleString(); }
  },

  /** Raw model args to display strings: epoch-ms ago / measuredAt as relative past, next as relative future. */
  _ovArgs(args: Record<string, unknown>): Record<string, string | number> {
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(args)) {
      if (k === 'ago' && typeof v === 'number') out[k] = v > 0 ? AdminCockpit._relTime(v) : Util.t('ui.diag_vacuum_never');
      else if (k === 'next' && typeof v === 'number') out[k] = v > 0 ? AdminCockpit._relFuture(v) : Util.t('sig.next_none');
      else out[k] = typeof v === 'number' || typeof v === 'string' ? v : String(v ?? '');
    }
    return out;
  },

  /** Text into `el` with each run of digits in a mono span. */
  _setNumText(el: HTMLElement, text: string): void {
    el.textContent = '';
    for (const part of text.split(/(\d[\d.,:]*)/)) {
      if (!part) continue;
      if (/^\d/.test(part)) {
        const s = document.createElement('span');
        s.className = 'sig-num';
        s.textContent = part;
        el.appendChild(s);
      } else {
        el.appendChild(document.createTextNode(part));
      }
    }
  },

  _fixButton(fix: Fix, isAdmin: boolean): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-ghost sm';
    b.dataset.fix = fix.id;
    b.dataset.args = JSON.stringify(fix.args ?? {});
    b.textContent = Util.t(fix.labelKey);
    if (fix.adminOnly || ADMIN_FIXES.has(fix.id)) {
      b.dataset.admin = '1';
      if (!isAdmin) { b.disabled = true; b.title = Util.t('ov.admin_only'); }
    }
    return b;
  },

  _detailCell(v: string | number | null, headKey: string): string {
    if (v === null || v === undefined || v === '') return '–';
    if (typeof v === 'number') {
      if (headKey === 'sig.d_duration') return `${(v / 1000).toFixed(1)} s`;
      if (headKey === 'sig.d_dead_pct') return `${v}%`;
      return v.toLocaleString();
    }
    if (/^(pipe|sig)\.[\w.]+$/.test(v)) return Util.t(v);
    if (/^\d{4}-\d\d-\d\dT/.test(v)) return AdminCockpit._relTime(v);
    return v;
  },

  _buildDetail(d: DetailTable, isAdmin: boolean): HTMLElement {
    const box = document.createElement('div');
    box.className = 'sig-detail';
    box.hidden = true;
    if (d.headKeys.length && d.rows.length) {
      const wrap = document.createElement('div');
      wrap.className = 'sig-dt-wrap';
      const tbl = document.createElement('table');
      tbl.className = 'sig-dt';
      const hasFix = (d.rowFixes ?? []).some(Boolean);
      const hr = document.createElement('tr');
      d.headKeys.forEach((k, c) => {
        const th = document.createElement('th'); th.textContent = Util.t(k);
        if (d.rows.some(r => typeof r[c] === 'number')) th.className = 'num';
        hr.appendChild(th);
      });
      if (hasFix) hr.appendChild(document.createElement('th'));
      const thead = document.createElement('thead'); thead.appendChild(hr); tbl.appendChild(thead);
      const tb = document.createElement('tbody');
      d.rows.forEach((row, i) => {
        const tr = document.createElement('tr');
        row.forEach((cell, c) => {
          const td = document.createElement('td');
          td.textContent = AdminCockpit._detailCell(cell, d.headKeys[c] ?? '');
          if (typeof cell === 'number') td.className = 'num';
          tr.appendChild(td);
        });
        if (hasFix) {
          const td = document.createElement('td');
          const rf = d.rowFixes?.[i];
          if (rf) td.appendChild(AdminCockpit._fixButton(rf, isAdmin));
          tr.appendChild(td);
        }
        tb.appendChild(tr);
      });
      tbl.appendChild(tb); wrap.appendChild(tbl); box.appendChild(wrap);
    }
    if (d.linkKey && d.linkSub) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-ghost sm';
      b.dataset.nav = d.linkSub;
      if (d.linkAnchor) b.dataset.anchor = d.linkAnchor;
      b.textContent = Util.t(d.linkKey);
      box.appendChild(b);
    }
    return box;
  },

  _renderSignals(signals: Signal[]): void {
    const host = document.getElementById('ov-signals');
    if (!host) return;
    const A = AdminCockpit;
    const isAdmin = Session.isAdmin();
    const key = JSON.stringify([signals, isAdmin, A._ovOpenDetail, Math.floor(Date.now() / 60_000)]);
    if (key === A._ovSigKey) return;   // nothing the planner could see has changed: no repaint
    A._ovSigKey = key;
    const act = document.activeElement as HTMLElement | null;
    const focus = act && host.contains(act)
      ? { sig: act.closest<HTMLElement>('.sig-row')?.dataset.sig ?? '', fix: act.dataset.fix ?? '' }
      : null;
    host.textContent = '';
    for (const sig of signals) {
      const row = document.createElement('div');
      row.className = 'sig-row';
      row.dataset.sig = sig.id;
      row.dataset.sev = sig.severity;
      row.setAttribute('role', 'listitem');

      const dot = document.createElement('span');
      dot.className = `admin-health-dot ${sig.severity}`;
      const name = document.createElement('span');
      name.className = 'sig-name';
      name.textContent = Util.t(`sig.${sig.id}`);
      const reason = document.createElement('span');
      reason.className = 'sig-reason';
      let text = Util.t(sig.reasonKey, A._ovArgs(sig.reasonArgs));
      if (sig.measuredAt && Date.now() - sig.measuredAt >= 60_000) text += ` · ${Util.t('ov.measured_ago', { ago: A._relTime(sig.measuredAt) })}`;
      A._setNumText(reason, text);
      const fixes = document.createElement('div');
      fixes.className = 'sig-fixes';
      for (const fx of sig.fixes) fixes.appendChild(A._fixButton(fx, isAdmin));
      row.append(dot, name, reason, fixes);

      if (sig.detail) {
        const open = A._ovOpenDetail === sig.id;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sig-details';
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.textContent = Util.t(open ? 'ov.details_hide' : 'ov.details');
        row.appendChild(btn);
        const detail = A._buildDetail(sig.detail, isAdmin);
        detail.hidden = !open;
        row.appendChild(detail);
      }
      host.appendChild(row);
    }
    if (focus && focus.sig) {
      const sel = focus.fix ? `.sig-row[data-sig="${focus.sig}"] [data-fix="${focus.fix}"]` : `.sig-row[data-sig="${focus.sig}"] .sig-details`;
      (host.querySelector<HTMLElement>(sel) ?? host.querySelector<HTMLElement>(`.sig-row[data-sig="${focus.sig}"] .sig-details`))?.focus();
    }
  },

  /** Open or close one Details strip in place (no repaint, so focus stays on the button). */
  _toggleDetail(btn: HTMLElement): void {
    const row = btn.closest<HTMLElement>('.sig-row');
    if (!row) return;
    const id = row.dataset.sig as SignalId;
    const A = AdminCockpit;
    A._ovOpenDetail = A._ovOpenDetail === id ? null : id;
    document.querySelectorAll<HTMLElement>('#ov-signals .sig-row').forEach((r) => {
      const isThis = r.dataset.sig === A._ovOpenDetail;
      const b = r.querySelector<HTMLElement>('.sig-details');
      const d = r.querySelector<HTMLElement>('.sig-detail');
      if (b) { b.setAttribute('aria-expanded', isThis ? 'true' : 'false'); b.textContent = Util.t(isThis ? 'ov.details_hide' : 'ov.details'); }
      if (d) d.hidden = !isThis;
    });
    A._ovSigKey = '';   // the next refresh repaints once with the new open state
  },

  _renderAttention(items: AttentionItem[]): void {
    const host = document.getElementById('ov-attention');
    if (!host) return;
    const isAdmin = Session.isAdmin();
    host.textContent = '';
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'attn-empty';
      e.textContent = Util.t('ov.attention_clear');
      host.appendChild(e);
      return;
    }
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'attn-row';
      row.dataset.sev = it.severity;
      const dot = document.createElement('span');
      dot.className = `admin-health-dot ${it.severity}`;
      const txt = document.createElement('span');
      txt.className = 'attn-text';
      AdminCockpit._setNumText(txt, Util.t(it.textKey, AdminCockpit._ovArgs(it.args)));
      row.append(dot, txt, AdminCockpit._fixButton(it.fix, isAdmin));
      host.appendChild(row);
    }
  },

  _renderRecent(): void {
    const host = document.getElementById('ov-recent');
    if (!host) return;
    const A = AdminCockpit;
    const f = A._ovFast;
    const lists: UnifiedEntry[][] = [
      [...(f.backendErrors?.entries ?? []), ...(f.backendWarns?.entries ?? [])].map(e => fromBackend(e as unknown as BackendLogEntry)),
      ErrorLog.entries().slice(-20).map(e => fromFrontend(e as unknown as FrontendLogEntry)),
      (f.jobs?.recent ?? []).map(r => fromJobRun(r as unknown as JobRun)),
      A._ovSlow.auditLog.map(fromAudit),
      A._ovSlow.uploadAudit.map(fromUpload),
    ];
    const rows = filterEntries(mergeEntries(lists), { level: 'all', sources: new Set(), user: '', plant: Store.selectedPlant ?? '', q: '' }).slice(0, 10);
    host.textContent = '';
    for (const e of rows) {
      const row = document.createElement('div');
      row.className = `admin-log-row ov-recent-row admin-log-${e.level}`;
      const ts = document.createElement('span'); ts.className = 'admin-log-ts'; ts.textContent = e.tsMs ? A._relTime(e.tsMs) : ''; ts.title = e.ts ?? '';
      const src = document.createElement('span'); src.className = 'admin-log-scope'; src.textContent = Util.t(`ulog.src_${e.source}`);
      const msg = document.createElement('span');
      msg.className = 'admin-log-msg';
      msg.textContent = e.text;
      msg.title = e.text;
      row.append(ts, src, msg);
      host.appendChild(row);
    }
  },

  /** The anchor a nav.* fix carries in its args (undefined when absent or not a string). */
  _fixAnchor(a: Record<string, unknown>): string | undefined { return typeof a.anchor === 'string' ? a.anchor : undefined; },

  /** Quick-fix dispatch for the Signal board and Needs attention buttons. */
  async _onSignalFix(fix: Fix, btn: HTMLButtonElement | null = null): Promise<void> {
    const A = AdminCockpit;
    if ((fix.adminOnly || ADMIN_FIXES.has(fix.id)) && !Session.isAdmin()) return;
    const a = (fix.args ?? {}) as Record<string, unknown>;
    const again = (): void => { A._ovSigKey = ''; void A._refreshOverview({ force: true }); };
    switch (fix.id) {
      case 'jobs.rerun': {
        const runId = Number(a.runId);
        const name = A._ovFast.jobs?.lastFailed.find(r => r.id === runId)?.job_name ?? `#${runId}`;
        if (!(await Modal.confirm({ title: Util.t('jobs.confirm_restart', { name }), confirmLabel: Util.t('btn.rerun_now') }))) return;
        try { await JobsClient.restartRun(runId); } catch (e) { Toast.show((e as Error).message, 'error'); }
        again();
        return;
      }
      case 'jobs.open_run': {
        // JobsAdmin.render() is async (first use awaits the type list); openRun before it resumes would be overwritten.
        A.gotoSub('jobs');
        await JobsAdmin.render();
        JobsAdmin.openRun(Number(a.runId));
        return;
      }
      case 'nav.jobs': A.gotoSub('jobs', { anchor: A._fixAnchor(a) }); return;
      case 'nav.diagnostics': A.gotoSub('diagnostics', { anchor: A._fixAnchor(a) }); return;
      case 'nav.interface': A.gotoSub('interface', { anchor: A._fixAnchor(a) }); return;
      case 'nav.order_maintenance': A.gotoSub('order-maintenance', { anchor: A._fixAnchor(a) }); return;
      case 'db.vacuum_all': {
        if (!(await Modal.confirm({ title: Util.t('ui.maint_vacuum_all_confirm'), confirmLabel: Util.t('btn.run') }))) return;
        await A._runMaintenance('vacuum-analyze', null, btn);
        again();
        return;
      }
      case 'db.vacuum_table':
        await A._runMaintenance('vacuum-analyze', String(a.table ?? '') || null, btn);
        again();
        return;
      case 'logs.open': {
        A.gotoSub('logs');
        const f: Partial<LogFilter> = { level: (a.level as LogFilter['level'] | undefined) ?? 'warn', sources: new Set<LogSource>([(a.source as LogSource | undefined) ?? 'backend']) };
        UnifiedLogPane.setFilter(f);
        return;
      }
      case 'data.reload': void Persistence.reload(); return;
      case 'client.reset': void A._resetClientState(); return;
      default: console.warn(`AdminCockpit: unknown fix id '${fix.id}'`); return;
    }
  },

  _renderPipeline(): void {
    const wrap = document.getElementById('admin-pipeline');
    if (!wrap) return;

    AdminCockpit._pipelineAbort?.abort();
    AdminCockpit._pipelineAbort = new AbortController();
    const sig = AbortSignal.any
      ? AbortSignal.any([AdminCockpit._pipelineAbort.signal, AbortSignal.timeout(8000)])
      : AdminCockpit._pipelineAbort.signal;
    const plant = Store.selectedPlant ?? null;
    const q = plant ? `?plant=${encodeURIComponent(plant)}` : '';
    Util.fetchTraced(`${Config.API_BASE}/diagnostics/deep${q}`, { signal: sig })
      .then((r) => { AdminCockpit._deepForbidden = r.status === 403; return r.json() as Promise<AdminDiagnosticsDeepResponse>; })
      .then((data) => {
        AdminCockpit._deepData = data;
        AdminCockpit._deepPlant = plant;
        AdminCockpit._deepAt = Date.now();
        if (AdminCockpit._deepForbidden) {
          // A viewer without the admin read: say so, never paint zeros that look healthy.
          wrap.textContent = '';
          const m = document.createElement('div');
          m.className = 'admin-log-empty';
          m.textContent = Util.t('sig.admin_only');
          wrap.appendChild(m);
          AdminCockpit._repaintHeads();
          return;
        }
        const p = (data.pipeline || {}) as AdminPipelineSnapshot;
        const st: AdminPersistenceStats = Persistence.stats ? Persistence.stats() : ({} as AdminPersistenceStats);
        const model = AdminCockpit._pipelineModel(data);

        const steps: AdminPipelineStep[] = model.steps.map((s) => {
          const dateIso = typeof s.delta?.args.date === 'string' ? s.delta.args.date : '';
          return {
            key: s.key,
            label: s.key === 'plant' ? Util.t('pipe.plant_scope', { plant: model.plant ?? '' }) : Util.t(`pipe.${s.key}`),
            count: s.count,
            delta: s.delta ? Util.t(s.delta.key, { ...s.delta.args, ...(dateIso ? { date: Util.fmtIsoDatePref(dateIso.slice(0, 10)) || dateIso } : {}) }) : null,
            status: s.status,
            detail: () => AdminCockpit._pipelineDetail(s.key, model, data, st),
          };
        });

        const toggleDetail = (key: string, mk: () => DocumentFragment): void => {
          const detail = document.getElementById('admin-pipeline-detail');
          if (!detail) return;
          if (AdminCockpit._pipelineOpen === key) {
            AdminCockpit._pipelineOpen = null;
            detail.classList.remove('open');
            detail.textContent = '';
          } else {
            AdminCockpit._pipelineOpen = key;
            detail.classList.add('open');
            detail.textContent = '';
            detail.appendChild(mk());
          }
        };
        wrap.textContent = '';
        // Info chip: every order in the database, all plants. Not a step: nothing flows from it.
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'admin-pipeline-info';
        chip.addEventListener('click', () => toggleDetail('in-db', () => AdminCockpit._pipelineDetail('in-db', model, data, st)));
        chip.dataset.key = 'in-db';
        const chipN = document.createElement('span');
        chipN.className = 'admin-pipeline-info-count';
        chipN.textContent = model.inDb.toLocaleString();
        const chipL = document.createElement('span');
        chipL.className = 'admin-pipeline-info-label';
        chipL.textContent = Util.t('pipe.in_db');
        chip.append(chipN, chipL);
        wrap.appendChild(chip);
        if (!steps.length) {
          const hint = document.createElement('div');
          hint.className = 'admin-log-empty';
          hint.textContent = Util.t('pipe.pick_plant');
          wrap.appendChild(hint);
        }
        steps.forEach((s, i) => {
          if (i > 0) {
            const arrow = document.createElement('span');
            arrow.className = 'admin-pipeline-arrow';
            arrow.textContent = '→';
            wrap.appendChild(arrow);
          }
          const box = document.createElement('div');
          box.className = `admin-pipeline-step ${s.status}`;
          box.dataset.key = s.key;

          const cnt = document.createElement('div');
          cnt.className = 'admin-pipeline-step-count';
          cnt.textContent = s.count.toLocaleString();
          box.appendChild(cnt);

          const lbl = document.createElement('div');
          lbl.className = 'admin-pipeline-step-label';
          lbl.textContent = s.label;
          box.appendChild(lbl);

          if (s.delta) {
            const delta = document.createElement('div');
            delta.className = 'admin-pipeline-delta';
            delta.textContent = s.delta;
            box.appendChild(delta);
          }

          box.addEventListener('click', () => toggleDetail(s.key, s.detail));

          wrap.appendChild(box);
        });

        // Backend warnings
        AdminCockpit._renderBackendWarnings(p.warnings || []);
        AdminCockpit._repaintHeads();   // Data pipeline and Backend warnings heads
        AdminCockpit._settleReveal();
      })
      .catch((e: Error) => {
        if (e.name === 'AbortError') return;
        wrap.innerHTML = `<div class="admin-log-empty">${Util.escapeHtml(Util.t('pipe.load_failed', { msg: e.message }))}</div>`;
        ErrorLog.warn('admin', `Pipeline fetch failed: ${e.message}`);
        AdminCockpit._repaintHeads();
        AdminCockpit._settleReveal();
      });
  },

  /** The click-through detail of one strip box (or of the info chip, key 'in-db'). */
  _pipelineDetail(key: PipelineStepKey | 'in-db', m: PipelineModel, data: AdminDiagnosticsDeepResponse, st: AdminPersistenceStats): DocumentFragment {
    const frag = document.createDocumentFragment();
    const head = (text: string): void => {
      const h = document.createElement('div');
      h.className = 'admin-pdtl-head';
      h.textContent = text;
      frag.appendChild(h);
    };
    const sub = (text: string): void => {
      const e = document.createElement('div');
      e.className = 'admin-pdtl-sub';
      e.textContent = text;
      frag.appendChild(e);
    };
    const p = (data.pipeline || {}) as AdminPipelineSnapshot;
    const dbSt = (data.db_stats || {}) as AdminDbStatsDeep;
    const meta = (st?.backend_meta ?? {}) as Record<string, unknown>;
    const metaNum = (k: string): number | string => (typeof meta[k] === 'number' ? (meta[k] as number) : '—');
    const step = (k: PipelineStepKey): number => m.steps.find((x) => x.key === k)?.count ?? 0;
    const horizonIso = typeof meta.visibility_horizon_end === 'string' ? meta.visibility_horizon_end : '';

    if (key === 'in-db') {
      head(Util.t('pipe.in_db'));
      const rows: AdminKvRow[] = [
        [Util.t('ui.diag_total_in_db'), (dbSt.total ?? '—').toLocaleString()],
        [Util.t('ui.diag_null_start_date'), dbSt.null_start ?? '—'],
        [Util.t('ui.diag_null_end_date'), dbSt.null_end ?? '—'],
        [Util.t('ui.diag_null_color'), dbSt.null_color ?? '—'],
        [Util.t('ui.diag_null_line'), dbSt.null_line ?? '—'],
        [Util.t('ui.diag_null_desc'), dbSt.null_desc ?? '—'],
        [Util.t('ui.diag_null_runtime'), dbSt.null_runtime ?? '—'],
        [Util.t('ui.diag_date_range_min'), Util.fmtIsoDatePref(dbSt.date_range?.min?.slice(0, 10)) || '—'],
        [Util.t('ui.diag_date_range_max'), Util.fmtIsoDatePref(dbSt.date_range?.max?.slice(0, 10)) || '—'],
      ];
      frag.appendChild(AdminCockpit._kvTable(rows));
      if (dbSt.by_line && Object.keys(dbSt.by_line).length) {
        sub(Util.t('ui.orders_by_line'));
        frag.appendChild(AdminCockpit._lineBar(dbSt.by_line));
      }
      // Ingest counters: per process, all plants, reset on restart. Informational; they never colour a box.
      sub(Util.t('ui.diag_since_restart'));
      frag.appendChild(AdminCockpit._kvTable([
        [Util.t('ui.diag_unreadable_start'), p.unreadable_start_date ?? 0],
        [Util.t('ui.diag_dropped_no_finish'), p.dropped_no_finish_date ?? 0],
      ]));
      return frag;
    }

    if (key === 'plant') {
      head(Util.t('pipe.plant_scope', { plant: m.plant ?? '' }));
      const total = step('plant');
      frag.appendChild(AdminCockpit._kvTable([
        [Util.t('ui.diag_active_plant'), m.plant ?? '—'],
        [Util.t('ui.diag_orders_this_plant'), total],
        [Util.t('ui.diag_orders_other_plants'), Math.max(0, m.inDb - total)],
        [Util.t('ui.diag_total_in_db'), m.inDb],
      ]));
      return frag;
    }

    if (key === 'horizon') {
      head(Util.t('pipe.horizon'));
      const inside = step('horizon');
      frag.appendChild(AdminCockpit._kvTable([
        [Util.t('ui.diag_orders_this_plant'), step('plant')],
        [Util.t('ui.diag_inside_horizon'), inside],
        [Util.t('ui.diag_beyond_horizon'), Math.max(0, step('plant') - inside)],
        [Util.t('ui.diag_horizon_until'), horizonIso ? (Util.fmtIsoDatePref(horizonIso.slice(0, 10)) || horizonIso) : '—'],
      ]));
      return frag;
    }

    if (key === 'sent') {
      head(Util.t('pipe.sent'));
      frag.appendChild(AdminCockpit._kvTable([
        [Util.t('ui.diag_inside_horizon'), step('horizon')],
        [Util.t('ui.diag_no_dates'), m.dropped],
        [Util.t('ui.diag_payload_rows'), step('sent')],
        [Util.t('ui.diag_loaded_at'), p.loaded_at ? Util.fmtIsoStampPref(p.loaded_at, true) + ' UTC' : '—'],
      ]));
      const misses = metaNum('color_merge_misses');
      if (typeof misses === 'number' && misses > 0) {
        // Neutral note: an unlisted order is sequenced last, never dropped.
        const note = document.createElement('div');
        note.className = 'admin-pdtl-sub';
        note.textContent = Util.t('ui.diag_misses_note', { n: misses });
        frag.appendChild(note);
      }
      const warnings = p.warnings || [];
      if (warnings.length) {
        sub(Util.t('ui.diag_backend_load_warnings', { count: warnings.length }));
        // The full list lives in the Backend warnings section; this step links there (delegated [data-anchor] click -> _revealAnchor).
        const see = document.createElement('button');
        see.type = 'button';
        see.className = 'btn btn-ghost sm';
        see.dataset.anchor = 'diag-bwarn';
        see.textContent = Util.t('diag.see_bwarn', { n: warnings.length });
        frag.appendChild(see);
      }
      return frag;
    }

    // loaded
    head(Util.t('pipe.loaded'));
    const sent = step('sent');
    const loaded = step('loaded');
    frag.appendChild(AdminCockpit._kvTable([
      [Util.t('ui.diag_received_by_ui'), sent],
      [Util.t('ui.diag_pl_filtered'), st.filtered_pl ?? 0],
      [Util.t('ui.diag_null_id_dropped'), st.filtered_null_id ?? 0],
      [Util.t('ui.diag_store_collisions'), st.dedup_collisions ?? 0],
      [Util.t('ui.diag_load_errors'), st.errors ?? 0],
      [Util.t('pipe.loaded'), loaded],
      [Util.t('ui.diag_gap'), m.gap],
      [Util.t('ui.diag_source'), st.source ?? '—'],
    ]));
    if (m.gap > 0) {
      const warn = document.createElement('div');
      warn.className = 'admin-pdtl-warn';
      warn.textContent = Util.t('ui.data_gap_warn', { count: m.gap });
      frag.appendChild(warn);
    }
    return frag;
  },

  _kvTable(rows: AdminKvRow[]): HTMLTableElement {
    const tbl = document.createElement('table');
    tbl.className = 'admin-pdtl-tbl';
    for (const [k, v] of rows) {
      const tr = document.createElement('tr');
      const tdK = document.createElement('td');
      tdK.className = 'admin-pdtl-key';
      tdK.textContent = k;
      const tdV = document.createElement('td');
      tdV.className = 'admin-pdtl-val';
      tdV.textContent = String(v ?? '—');
      tr.appendChild(tdK);
      tr.appendChild(tdV);
      tbl.appendChild(tr);
    }
    return tbl;
  },

  /** Render at most `cap` of `items` into `host` (render appends the visible slice to host); over the cap a
   *  "Show all N" / "Show fewer" toggle follows the list. At or under the cap there is no button. */
  _capList<T>(items: T[], cap: number, render: (visible: T[]) => void, host: HTMLElement): void {
    let all = false;
    const paint = (): void => {
      host.textContent = '';
      render(all || items.length <= cap ? items : items.slice(0, cap));
      if (items.length <= cap) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-ghost sm admin-cap-toggle';
      b.textContent = all ? Util.t('btn.show_fewer') : Util.t('btn.show_all_n', { n: items.length });
      b.addEventListener('click', () => { all = !all; paint(); });
      host.appendChild(b);
    };
    paint();
  },

  _lineBar(byLine: Record<string, number>): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'admin-pdtl-linebars';
    const max = Math.max(...Object.values(byLine));
    AdminCockpit._capList(Object.entries(byLine), 15, (vis) => { for (const [line, cnt] of vis) {
      const row = document.createElement('div');
      row.className = 'admin-pdtl-linebar-row';
      const lbl = document.createElement('span');
      lbl.className = 'admin-pdtl-linebar-lbl';
      lbl.textContent = line;
      const bar = document.createElement('div');
      bar.className = 'admin-pdtl-linebar-track';
      const fill = document.createElement('div');
      fill.className = 'admin-pdtl-linebar-fill';
      fill.style.width = `${Math.round((cnt / max) * 100)}%`;
      const num = document.createElement('span');
      num.className = 'admin-pdtl-linebar-num';
      num.textContent = String(cnt);
      bar.appendChild(fill);
      row.appendChild(lbl);
      row.appendChild(bar);
      row.appendChild(num);
      wrap.appendChild(row);
    } }, wrap);
    return wrap;
  },

  /** Flat list of load/upload warnings. Still used by the Order Maintenance upload history; the Emitted step now links to the Backend warnings section instead. */
  _warningList(warnings: AdminPipelineWarning[]): HTMLDivElement {
    const ul = document.createElement('div');
    ul.className = 'admin-bwarn-list';
    for (const w of warnings) {
      const row = document.createElement('div');
      row.className = `admin-bwarn-row admin-bwarn-${w.level || 'warn'}`;
      const lvl = document.createElement('span');
      lvl.className = 'admin-bwarn-lvl';
      lvl.textContent = (w.level || 'warn').toUpperCase();
      const msg = document.createElement('span');
      msg.className = 'admin-bwarn-msg';
      msg.textContent = w.msg || '';
      row.appendChild(lvl);
      row.appendChild(msg);
      ul.appendChild(row);
    }
    return ul;
  },

  _renderDistributionWarning(entry: AdminUploadWarning, batchId?: string): DocumentFragment {
    const frag = document.createDocumentFragment();
    if (entry.category !== 'distribution' || !entry.msg) return frag;

    // Formats one detail-list item (D49): a string stays as-is; an object
    // (conflicting_parent_rows/ambiguous_plant/workcenter_without_members/
    // default_machine_invalid, per db.py's upload-warning shapes) assembles
    // whichever of order/material/work-center/values it carries, joined with
    // ' · '. Fixes the previous `String(i)` -> "[object Object]" output.
    const fmt = (i: unknown): string => {
      if (typeof i === 'string') return i;
      if (i == null || typeof i !== 'object') return String(i);
      const o = i as Record<string, unknown>;
      const parts: string[] = [];
      if (o.production_order != null) parts.push(String(o.production_order));
      if (o.material_number != null) parts.push(String(o.material_number));
      if (o.sap_workcenter != null) parts.push(String(o.sap_workcenter));
      if (Array.isArray(o.values)) parts.push((o.values as unknown[]).join('/'));
      // B3: a brand-new distribute-mode header whose default shares come out
      // all-zero lands in `workcenter_without_members` too (data.py), tagged
      // `reason: "zero_weights"` to distinguish it from the memberless case
      // -- append a translated suffix so the planner sees WHY, not just
      // which work center.
      if (o.reason === 'zero_weights') parts.push(Util.t('ui.workcenter_zero_weights'));
      return parts.join(' · ');
    };

    // Main summary line
    const summary = document.createElement('div');
    summary.className = `admin-bwarn-row admin-bwarn-${entry.level || 'warn'}`;
    const lvl = document.createElement('span');
    lvl.className = 'admin-bwarn-lvl';
    lvl.textContent = (entry.level || 'warn').toUpperCase();
    const msg = document.createElement('span');
    msg.className = 'admin-bwarn-msg';
    msg.textContent = entry.msg;
    summary.appendChild(lvl);
    summary.appendChild(msg);
    frag.appendChild(summary);

    // Review link if there are created/refreshed distributions
    const created = entry.headers_created ?? 0;
    const refreshed = entry.headers_refreshed ?? 0;
    const total = created + refreshed;
    if (total > 0 && batchId) {
      const linkRow = document.createElement('div');
      linkRow.className = 'admin-dist-link-row';
      const link = document.createElement('a');
      link.href = '#';
      link.className = 'admin-dist-link';
      link.textContent = Util.t('ui.review_distributions', { count: total });
      link.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault();
        const nimbus = typeof NIMBUS !== 'undefined' ? NIMBUS : undefined;
        nimbus?.App?.goto?.('gantt');
        nimbus?.App?.gotoGanttSub?.('distribution');
      });
      linkRow.appendChild(link);
      frag.appendChild(linkRow);
    }

    // Expandable lists for detail items
    const listFields: Array<{ key: keyof AdminUploadWarning; label: string }> = [
      { key: 'conflicting_parent_rows', label: 'ui.conflicting_parent_rows' },
      { key: 'ambiguous_plant', label: 'ui.ambiguous_plant_conflicts' },
      { key: 'workcenter_without_members', label: 'ui.workcenter_without_members' },
      { key: 'default_machine_invalid', label: 'ui.default_machine_invalid' },
    ];

    for (const field of listFields) {
      const items = entry[field.key] as unknown[];
      if (!items || items.length === 0) continue;

      const row = document.createElement('div');
      row.className = 'admin-dist-detail-row';
      const header = document.createElement('div');
      header.className = 'admin-dist-detail-header';
      header.style.cursor = 'pointer';
      header.style.padding = '4px 0';
      header.textContent = `${Util.t(field.label)} (${items.length})`;
      row.appendChild(header);

      const detail = document.createElement('div');
      detail.className = 'admin-dist-detail-content';
      detail.style.display = 'none';
      detail.style.padding = '8px 16px';
      detail.style.fontSize = '12px';
      detail.style.fontFamily = 'monospace';
      detail.style.backgroundColor = 'rgba(0,0,0,0.03)';
      detail.style.borderRadius = '2px';
      detail.style.margin = '4px 0';
      const pre = document.createElement('pre');
      pre.style.margin = '0';
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.wordBreak = 'break-word';
      pre.textContent = items.map(fmt).join('\n');
      detail.appendChild(pre);
      row.appendChild(detail);

      header.addEventListener('click', () => {
        detail.style.display = detail.style.display === 'none' ? '' : 'none';
      });
      frag.appendChild(row);
    }

    return frag;
  },

  _renderBackendWarnings(warnings: AdminPipelineWarning[]): void {
    const host = document.getElementById('admin-backend-warnings');
    const countEl = document.getElementById('admin-bwarn-count');
    if (!host) return;
    host.textContent = '';
    if (countEl) countEl.textContent = Util.t('ui.bwarn_count', { count: warnings.length });

    if (!warnings.length) {
      const ok = document.createElement('div');
      ok.className = 'admin-bwarn-empty';
      ok.textContent = Util.t('empty.no_backend_warnings');
      host.appendChild(ok);
      return;
    }

    AdminCockpit._capList(warnings, 20, (vis) => { for (const w of vis) {
      const row = document.createElement('div');
      row.className = `admin-bwarn-row admin-bwarn-${w.level || 'warn'}`;
      row.style.cursor = w.context && Object.keys(w.context).length ? 'pointer' : '';

      const meta = document.createElement('div');
      meta.className = 'admin-bwarn-meta';
      const lvl = document.createElement('span');
      lvl.className = 'admin-bwarn-lvl';
      lvl.textContent = (w.level || 'warn').toUpperCase();
      const ts = document.createElement('span');
      ts.className = 'admin-bwarn-ts';
      ts.textContent = w.ts ? Util.fmtIsoStampPref(w.ts, true) + ' UTC' : '';
      meta.appendChild(lvl);
      meta.appendChild(ts);

      const msg = document.createElement('div');
      msg.className = 'admin-bwarn-msg';
      msg.textContent = w.msg || '';

      row.appendChild(meta);
      row.appendChild(msg);

      if (w.context && Object.keys(w.context).length) {
        const pre = document.createElement('pre');
        pre.className = 'admin-bwarn-ctx';
        pre.style.display = 'none';
        pre.textContent = JSON.stringify(w.context, null, 2);
        row.appendChild(pre);
        row.addEventListener('click', () => {
          pre.style.display = pre.style.display === 'none' ? '' : 'none';
        });
      }

      host.appendChild(row);
    } }, host);
  },

  // Server-backed preview (replaces a former client-side count over Store.tasksArr,
  // which only ever reflected the currently-loaded plant(s)/horizon while the
  // real DELETE was — and still is, absent a plant here — global; that mismatch
  // meant the shown count could silently understate the real impact by orders of
  // magnitude). Debounced + sequence-guarded so a slow, stale response can never
  // overwrite a newer one. Fails CLOSED: any preview error disables the purge
  // button rather than falling through to an un-verified confirm — the same
  // discipline frontend/master-data/admin-ui.mts uses for cascade-preview.
  _purgePreviewTimer: null as ReturnType<typeof setTimeout> | null,

  _updatePurgeCount(): void {
    // Disable immediately (not just once the debounced fetch resolves) so the
    // button is never clickable against a stale preview while a new one loads.
    AdminCockpit._purgePreview = null;
    AdminCockpit._setPurgeButtonEnabled(false);
    if (AdminCockpit._purgePreviewTimer) clearTimeout(AdminCockpit._purgePreviewTimer);
    AdminCockpit._purgePreviewTimer = setTimeout(() => AdminCockpit._fetchPurgePreview(), 250);
  },

  _setPurgeButtonEnabled(enabled: boolean): void {
    const btn = document.getElementById('admin-purge-btn') as HTMLButtonElement | null;
    if (btn) btn.disabled = !enabled;
  },

  async _fetchPurgePreview(): Promise<void> {
    const el = document.getElementById('admin-past-count');
    const plant = AdminCockpit._purgePlant;
    const start = AdminCockpit._fpPurgeStart?.selectedDates[0];
    const end   = AdminCockpit._fpPurgeEnd?.selectedDates[0];
    AdminCockpit._purgePreview = null;
    AdminCockpit._setPurgeButtonEnabled(false);
    if (!el) return;
    if (!plant) { el.textContent = Util.t('ui.purge_pick_plant'); return; }
    if (!start || !end) { el.textContent = ''; return; }
    if (start > end) { el.textContent = ''; return; }

    const seq = ++AdminCockpit._purgePreviewSeq;
    const startStr = Util.toLocalSeconds(start).slice(0, 10);
    const endStr   = Util.toLocalSeconds(end).slice(0, 10);
    el.innerHTML = `<span style="color:var(--text-muted,#888)">${Util.t('ui.checking_purge_impact')}</span>`;
    try {
      const r = await Util.fetchTraced(`${Config.API_BASE}/purge/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plant, start_date: startStr + 'T00:00:00', end_date: endStr + 'T23:59:59' }),
      });
      const body = await r.json().catch(() => ({})) as AdminPurgePreview;
      if (seq !== AdminCockpit._purgePreviewSeq) return; // superseded by a newer request
      if (!r.ok || body.status !== 'ok') {
        el.innerHTML = `<span style="color:var(--err,#c0392b)">${Util.escapeHtml(Util.t('toast.purge_preview_failed', { msg: Util.errorDetailText(body.detail) || body.message || 'unknown' }))}</span>`;
        return;
      }
      AdminCockpit._purgePreview = body;
      const { total, planner_overridden } = body;
      const parts = [Util.t('ui.orders_in_range', { count: total, plural: total === 1 ? '' : 's' })];
      if (planner_overridden > 0) parts.push(Util.t('ui.purge_planner_overridden', { count: planner_overridden }));
      el.innerHTML = total > 0
        ? `<strong style="color:var(--err,#c0392b)">${parts.join(' — ')}</strong>`
        : `<span style="color:var(--text-muted,#888)">${parts[0]}</span>`;
      AdminCockpit._setPurgeButtonEnabled(true);
    } catch (e) {
      if (seq !== AdminCockpit._purgePreviewSeq) return;
      el.innerHTML = `<span style="color:var(--err,#c0392b)">${Util.escapeHtml(Util.t('toast.purge_preview_failed', { msg: (e as Error).message }))}</span>`;
    }
  },

  _renderPurgeMeta(): void {
    const yesterday   = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const twoWeeksAgo = new Date(); twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    const plantSel = document.getElementById('admin-purge-plant') as HTMLSelectElement | null;
    if (plantSel && !plantSel.dataset.wired) {
      plantSel.dataset.wired = '1';
      plantSel.addEventListener('change', () => {
        AdminCockpit._purgePlant = plantSel.value || null;
        AdminCockpit._updatePurgeCount();
      });
    }
    if (plantSel) {
      const plants = Store.knownPlants();
      const prevValue = plantSel.value;
      plantSel.innerHTML = `<option value="">${Util.t('ui.select_plant_label')}</option>`
        + plants.map(p => `<option value="${Util.escapeHtml(p)}">${Util.escapeHtml(Store.plantLabel(p))}</option>`).join('');
      // Preserve a still-valid selection across re-renders; otherwise default to
      // the single plant when there's only one (the common pilot-scale case).
      if (prevValue && plants.includes(prevValue)) {
        plantSel.value = prevValue;
      } else if (plants.length === 1) {
        plantSel.value = plants[0];
      }
      AdminCockpit._purgePlant = plantSel.value || null;
    }

    if (!AdminCockpit._fpPurgeStart) {
      AdminCockpit._fpPurgeStart = flatpickr('#admin-purge-start', {
        dateFormat: 'Y-m-d', altInput: true, altFormat: Util._dateFormatPref(),
        onChange: () => AdminCockpit._updatePurgeCount(),
      });
      AdminCockpit._fpPurgeEnd = flatpickr('#admin-purge-end', {
        dateFormat: 'Y-m-d', altInput: true, altFormat: Util._dateFormatPref(),
        onChange: () => AdminCockpit._updatePurgeCount(),
      });
    }
    AdminCockpit._fpPurgeStart!.setDate(twoWeeksAgo, false);
    AdminCockpit._fpPurgeEnd!.setDate(yesterday, false);
    AdminCockpit._updatePurgeCount();
  },

  _setStatus(el: HTMLElement | null, text: string, kind?: string): void {
    if (!el) return;
    el.textContent = text;
    el.className = 'admin-status' + (kind ? ' ' + kind : '');
  },

  _pickFile(file: File | null): void {
    if (!file) return;
    AdminCockpit._pendingFile = file;
    document.getElementById('admin-upload-info')!.hidden = false;
    document.getElementById('admin-upload-actions')!.hidden = false;
    document.getElementById('admin-upload-fname')!.textContent = file.name;
    document.getElementById('admin-upload-fsize')!.textContent =
      file.size < 1_048_576
        ? `${(file.size / 1024).toFixed(1)} KB`
        : `${(file.size / 1_048_576).toFixed(1)} MB`;
    const status = document.getElementById('admin-upload-status');
    if (status) { status.textContent = ''; status.className = 'admin-status'; }
  },

  _clearUpload(): void {
    AdminCockpit._pendingFile = null;
    const fi = document.getElementById('admin-upload-file') as HTMLInputElement | null;
    if (fi) fi.value = '';
    const info    = document.getElementById('admin-upload-info');
    const actions = document.getElementById('admin-upload-actions');
    const status  = document.getElementById('admin-upload-status');
    if (info)    info.hidden = true;
    if (actions) actions.hidden = true;
    if (status)  { status.textContent = ''; status.className = 'admin-status'; }
  },

  _upload(): void {
    const f      = AdminCockpit._pendingFile;
    const status = document.getElementById('admin-upload-status');
    const zone   = document.getElementById('admin-upload-zone');
    const btn    = document.getElementById('admin-upload-btn') as HTMLButtonElement | null;
    if (!f) {
      AdminCockpit._setStatus(status, Util.t('toast.pick_xlsx_first'), 'warn');
      return;
    }
    if (zone) zone.classList.add('uploading');
    if (btn)  btn.disabled = true;
    AdminCockpit._setStatus(status, Util.t('toast.uploading_file', { name: f.name }), 'info');
    const fd = new FormData();
    fd.append('file', f);
    const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    Util.fetchTraced(`${Config.API_BASE}/upload`, { method: 'POST', body: fd, headers: { 'x-request-id': reqId } })
      .then((r) => r.json().catch(() => ({})).then((j) => ({ ok: r.ok, body: j as AdminUploadResult })))
      .then(({ ok, body }) => {
        if (zone) zone.classList.remove('uploading');
        if (btn)  btn.disabled = false;
        if (!ok || body.status !== 'ok') {
          const msg = body?.message || Util.errorDetailText(body?.detail) || 'HTTP error';
          AdminCockpit._setStatus(status, Util.t('toast.upload_failed', { msg }), 'error');
          ErrorLog.error('admin', `Upload failed: ${msg}`, body,
            { reqId, errorCode: body?.error_code || 'http.status' });
          return;
        }
        // The upload_counts entry is bookkeeping (shown in the summary line), not a warning.
        const realWarnings = (body.warnings ?? []).filter(x => x.category !== 'upload_counts');
        const warnCount = realWarnings.length;
        const w = warnCount ? ` (${warnCount} warning${warnCount === 1 ? '' : 's'})` : '';
        AdminCockpit._setStatus(
          status,
          Util.t('toast.upload_summary', {
            inserted: body.inserted, updated: body.updated,
            unchanged: body.unchanged ?? 0, rows: body.raw_row_count,
          }) + w,
          'success'
        );

        // Display distribution warning if present
        const distWarning = body.warnings?.find(x => (x as AdminUploadWarning).category === 'distribution') as AdminUploadWarning | undefined;
        if (distWarning) {
          const detailZone = document.getElementById('admin-upload-detail');
          if (detailZone) {
            detailZone.textContent = '';
            detailZone.appendChild(AdminCockpit._renderDistributionWarning(distWarning, body.batch_id));
            detailZone.hidden = false;
          }
        }

        ErrorLog.info('admin',
          `Upload OK: inserted=${body.inserted} updated=${body.updated} unchanged=${body.unchanged ?? 0} batch=${body.batch_id}`, body);
        if (warnCount) {
          ErrorLog.warn('admin', `Upload had ${warnCount} warning(s)`, realWarnings);
        }
        Toast.show(Util.t('toast.upload_ok', { count: body.inserted + body.updated }), 'success');
        setTimeout(() => AdminCockpit._clearUpload(), 2000);
        Persistence.reload().then(() => {
          void AdminCockpit._refreshOverview({ force: true });
          AdminCockpit._renderPipeline();
        });
        AdminCockpit._renderAudit();
      })
      .catch((e: Error) => {
        if (zone) zone.classList.remove('uploading');
        if (btn)  btn.disabled = false;
        AdminCockpit._setStatus(status, Util.t('toast.upload_failed', { msg: e.message }), 'error');
        ErrorLog.error('admin', `Upload network error: ${e.message}`,
          { reqId }, { reqId, errorCode: 'http.network' });
      });
  },

  async _purge(): Promise<void> {
    const plantSel = document.getElementById('admin-purge-plant') as HTMLSelectElement | null;
    const startEl = document.getElementById('admin-purge-start') as HTMLInputElement | null;
    const endEl   = document.getElementById('admin-purge-end') as HTMLInputElement | null;
    const status  = document.getElementById('admin-purge-status');
    const plant = plantSel?.value;
    const start = startEl?.value;
    const end   = endEl?.value;
    if (!plant) {
      AdminCockpit._setStatus(status, Util.t('toast.pick_purge_plant'), 'warn');
      return;
    }
    if (!start || !end) {
      AdminCockpit._setStatus(status, Util.t('toast.pick_purge_dates'), 'warn');
      return;
    }
    if (start > end) {
      AdminCockpit._setStatus(status, Util.t('toast.purge_start_before_end'), 'warn');
      return;
    }
    // Fail closed: never confirm a purge without a verified server-side preview
    // for the exact plant/range being submitted. The purge button is disabled
    // whenever no matching preview is in hand (see _updatePurgeCount), so
    // reaching this point with a null/mismatched preview means something raced
    // past the debounce — refuse rather than guess.
    const preview = AdminCockpit._purgePreview;
    if (!preview || preview.plant !== plant) {
      AdminCockpit._setStatus(status, Util.t('toast.purge_preview_failed', { msg: 'stale preview' }), 'warn');
      return;
    }

    const plantLabel = Store.plantLabel(plant);
    const detailLines = [Util.t('modal.purge_impact_total', { count: preview.total })];
    if (preview.planner_overridden > 0) {
      detailLines.push(Util.t('modal.purge_impact_override', { count: preview.planner_overridden }));
    }
    const ok = await Modal.confirm({
      title:        Util.t('modal.purge_confirm', { start, end }),
      message:      Util.t('modal.purge_scope', { plant: plantLabel }),
      detail:       detailLines.map(s => `<div>${s}</div>`).join(''),
      confirmLabel: Util.t('btn.yes_delete'),
      tone:         'danger',
    });
    if (!ok) return;

    AdminCockpit._setStatus(status, Util.t('toast.purging', { start, end }), 'info');
    const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    Util.fetchTraced(`${Config.API_BASE}/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-request-id': reqId },
      body: JSON.stringify({ plant, start_date: start + 'T00:00:00', end_date: end + 'T23:59:59' })
    })
      .then((r) => r.json().catch(() => ({})) as Promise<AdminPurgeResult>)
      .then((body) => {
        if (body.status !== 'ok') {
          AdminCockpit._setStatus(status, Util.t('toast.purge_failed', { msg: body.message || Util.errorDetailText(body.detail) || 'unknown' }), 'error');
          ErrorLog.error('admin', `Purge failed: ${body.message || Util.errorDetailText(body.detail) || 'unknown'}`, body,
            { reqId, errorCode: body?.error_code || 'http.status' });
          return;
        }
        AdminCockpit._setStatus(status, Util.t('toast.purge_deleted', { count: body.deleted }), 'success');
        ErrorLog.info('admin', `Purge: deleted ${body.deleted} (plant=${plant} ${start} → ${end})`);
        Toast.show(Util.t('toast.purge_ok', { count: body.deleted }), 'success');
        AdminCockpit._purgePreview = null;
        AdminCockpit._setPurgeButtonEnabled(false);
        AdminCockpit._updatePurgeCount();
        Persistence.reload().then(() => {
          void AdminCockpit._refreshOverview({ force: true });
          AdminCockpit._renderPipeline();
        });
      })
      .catch((e: Error) => {
        AdminCockpit._setStatus(status, Util.t('toast.purge_failed', { msg: e.message }), 'error');
        ErrorLog.error('admin', `Purge network error: ${e.message}`,
          { reqId }, { reqId, errorCode: 'http.network' });
      });
  },

  async _runMaintenance(action: 'vacuum-analyze' | 'analyze', table: string | null, triggerBtn: HTMLButtonElement | null): Promise<void> {
    const label = triggerBtn ? triggerBtn.textContent : action;
    if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = Util.t('ui.maint_running'); }
    const body = table ? { table } : {};
    try {
      const r = await Util.fetchTraced(`${Config.API_BASE}/maintenance/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-email': Session.actor() },
        body: JSON.stringify(body),
      }).then((res) => res.json() as Promise<AdminMaintenanceResult>);
      if (!r.ok) throw new Error(r.error || 'maintenance failed');
      Toast.show(Util.t('ui.maint_done', { label }), 'success');
      ErrorLog.info('admin', `Maintenance: ${action} ${table || '(all)'} ok`);
      AdminCockpit._renderDbDeep();
    } catch (e) {
      const err = e as Error;
      Toast.show(Util.t('ui.maint_failed', { label, msg: err.message }), 'error');
      ErrorLog.error('admin', `Maintenance: ${action} ${table || '(all)'} failed: ${err.message}`);
      if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = label; }
    }
  },
  /* -----------------------------------------------------------------------
     DB DEEP DIVE — fetches /diagnostics/db on demand, renders sections
     ----------------------------------------------------------------------- */
  _renderDbDeep(): void {
    const A = AdminCockpit;
    const wrap = document.getElementById('admin-db-deep');
    if (!wrap) return;
    A._ensureDbSubs();   // the eight sub-sections persist across repaints: only their bodies are replaced, so open state survives

    A._dbDeepAbort?.abort();
    A._dbDeepAbort = new AbortController();
    const sig = AbortSignal.any
      ? AbortSignal.any([A._dbDeepAbort.signal, AbortSignal.timeout(12000)])
      : A._dbDeepAbort.signal;

    Util.fetchTraced(`${Config.API_BASE}/diagnostics/db`, { signal: sig })
      .then((r) => (r.status === 403 ? ({ forbidden: true } as unknown as AdminDbDeepResponse) : (r.json() as Promise<AdminDbDeepResponse>)))
      .then((d) => {
        A._dbDeepData = d as unknown as DbDeep;
        A._dbDeepAt = Date.now();
        if ((d as unknown as DbDeep).forbidden) {
          for (const s of DB_SUBS) A._fillSub(s.id, (body) => { body.textContent = Util.t('sig.admin_only'); });
          A._repaintHeads();
          return;
        }

        // ── 1. Connection Pool
        const pool = d.pool || ({} as AdminPoolStats);
        const poolUsed = (pool.pool_size ?? 0) - (pool.pool_available ?? 0);
        const poolMax  = pool.pool_max || 1;
        A._fillSub('db-pool', (body) => {
          if (pool.error) { body.textContent = pool.error; return; }
          body.appendChild(A._dbFillBar(poolUsed, poolMax, Util.t('ui.diag_pool_utilization')));
          body.appendChild(A._kvTable([
            [Util.t('ui.diag_pool_min_max'),         `${pool.pool_min ?? '—'} / ${pool.pool_max ?? '—'}`],
            [Util.t('ui.diag_pool_in_use'),           `${poolUsed} / ${pool.pool_available ?? '—'}`],
            [Util.t('ui.diag_requests_waiting'),      pool.requests_waiting ?? 0],
            [Util.t('ui.diag_requests_completed'),    (pool.requests_completed ?? 0).toLocaleString()],
            [Util.t('ui.diag_request_errors'),        pool.requests_errors ?? 0],
            [Util.t('ui.diag_bad_returns'),           pool.returns_bad ?? 0],
          ]));
          if ((pool.requests_waiting ?? 0) > 0)
            A._dbWarnBanner(body, Util.t('ui.diag_pool_queued', { count: pool.requests_waiting ?? 0 }));
          if ((pool.requests_errors ?? 0) > 0)
            A._dbWarnBanner(body, Util.t('ui.diag_pool_errors', { count: pool.requests_errors ?? 0 }), true);
        });

        // ── 2. Server Info
        const srv = d.server || ({} as AdminServerInfo);
        A._fillSub('db-server', (body) => {
          if (srv.error) { body.textContent = srv.error; return; }
          body.appendChild(A._kvTable([
            [Util.t('ui.diag_database'),        srv.database ?? '—'],
            [Util.t('ui.diag_database_size'),   srv.db_size   ?? '—'],
            [Util.t('ui.diag_max_connections'), srv.max_connections ?? '—'],
            [Util.t('ui.diag_up_since'),        srv.started_at ? A._relTime(new Date(srv.started_at)) : '—'],
            [Util.t('ui.diag_version'),         (srv.version || '').split(' (')[0]],
          ]));
        });

        // ── 3. Table Health
        const tablesRaw: AdminTableStat[] = Array.isArray(d.tables) ? d.tables : [];
        const tableErr = _adminListError(tablesRaw);
        const tables = _adminListRows(tablesRaw);
        A._fillSub('db-tables', (body) => {
          if (tableErr) { body.textContent = tableErr; return; }
          if (!tables.length) { body.textContent = Util.t('empty.no_user_tables'); return; }
          const strip = document.createElement('div');
          strip.className = 'db-maint-strip';
          const vacAllBtn = document.createElement('button');
          vacAllBtn.className = 'db-maint-global-btn';
          vacAllBtn.dataset.maintAction = 'vacuum-analyze';
          vacAllBtn.dataset.maintTable = '';
          vacAllBtn.textContent = Util.t('ui.maint_vacuum_all');
          strip.appendChild(vacAllBtn);
          body.appendChild(strip);
          body.appendChild(A._dbTableCards(tables));
        });

        // ── 4. Active Connections
        const conn = d.connections || ({} as AdminConnectionActivity);
        const hasLong = (conn.long_running || []).length > 0;
        A._fillSub('db-conn', (body) => {
          if (conn.error) { body.textContent = conn.error; return; }
          body.appendChild(A._dbStackBar(conn.by_state || {}));
          if (hasLong) {
            const sub = document.createElement('div');
            sub.className = 'admin-pdtl-sub';
            sub.textContent = Util.t('ui.non_idle_queries');
            body.appendChild(sub);
            body.appendChild(A._dbTable(
              [Util.t('diag.col_pid'), Util.t('diag.col_state'), Util.t('diag.col_dur'), Util.t('diag.col_wait'), Util.t('diag.col_query')],
              (conn.long_running || []).map((q): AdminDbTableRow => ({
                cells: [q.pid, q.state || '—', q.duration_s ?? '—', q.wait_event || '—', (q.query || '').slice(0, 120)],
                rowWarn: (q.duration_s || 0) > THRESHOLDS.longQueryWarnS,
                cellWarn: [],
              }))
            ));
          }
        });

        // ── 5. Lock Waits
        const locksRaw: AdminLockWait[] = Array.isArray(d.locks) ? d.locks : [];
        const lockErr = _adminListError(locksRaw);
        const locks = _adminListRows(locksRaw);
        const activeLocks = !lockErr && locks.length > 0;
        A._fillSub('db-locks', (body) => {
          if (lockErr) { body.textContent = lockErr; return; }
          if (!activeLocks) {
            const ok = document.createElement('div');
            ok.className = 'admin-db-ok-msg';
            ok.textContent = Util.t('empty.no_lock_contention');
            body.appendChild(ok);
            return;
          }
          A._dbWarnBanner(body, Util.t('ui.diag_blocking_locks', { count: locks.length }), true);
          body.appendChild(A._dbLockChain(locks));
        });

        // ── 6. Index Usage (unused indexes are advice: the banner says so, the light stays green)
        const indexesRaw: AdminIndexUsage[] = Array.isArray(d.indexes) ? d.indexes : [];
        const idxErr = _adminListError(indexesRaw);
        const indexes = _adminListRows(indexesRaw);
        const unusedCount = !idxErr ? indexes.filter((ix) => ix.unused).length : 0;
        A._fillSub('db-idx', (body) => {
          if (idxErr) { body.textContent = idxErr; return; }
          if (!indexes.length) { body.textContent = Util.t('empty.no_indexes'); return; }
          if (unusedCount > 0)
            A._dbWarnBanner(body, Util.t('ui.diag_unused_indexes_warn', { count: unusedCount }));
          body.appendChild(A._dbHBarChart(indexes));
        });

        // ── 7. Slow Queries
        const sq = d.slow_queries || ({} as AdminSlowQueriesResult);
        A._fillSub('db-slow', (body) => {
          if (!sq.available) {
            const msg = document.createElement('div');
            msg.className = 'admin-db-na-msg';
            msg.textContent = sq.error
              ? `${Util.t('diag.error_prefix', { msg: sq.error })}`
              : Util.t('ui.diag_pg_stat_missing');
            body.appendChild(msg);
            return;
          }
          if (!(sq.queries || []).length) {
            const ok = document.createElement('div');
            ok.className = 'admin-db-ok-msg';
            ok.textContent = Util.t('empty.no_queries_yet');
            body.appendChild(ok);
            return;
          }
          body.appendChild(A._dbSlowQueryBars(sq.queries));
        });

        // ── 8. Sequences
        const seqsRaw: AdminSequenceHealth[] = Array.isArray(d.sequences) ? d.sequences : [];
        const seqErr = _adminListError(seqsRaw);
        const seqs = _adminListRows(seqsRaw);
        A._fillSub('db-seq', (body) => {
          if (seqErr) { body.textContent = seqErr; return; }
          if (!seqs.length) { body.textContent = Util.t('empty.no_sequences'); return; }
          body.appendChild(A._dbProgressBars(seqs));
        });

        A._repaintHeads();   // the Database head and its eight sub-section heads
        A._settleReveal();
      })
      .catch((e: Error) => {
        if (e.name === 'AbortError') return;
        A._dbDeepData = null;
        for (const s of DB_SUBS) A._fillSub(s.id, (body) => {
          const err = document.createElement('div');
          err.className = 'admin-db-error';
          err.textContent = Util.t('ui.failed_load_db_diag', { error: e.message });
          body.appendChild(err);
        });
        ErrorLog.warn('admin', `DB deep dive failed: ${e.message}`);
        A._repaintHeads();
        A._settleReveal();
      });
  },

  /* -----------------------------------------------------------------------
     DB visual helpers
     ----------------------------------------------------------------------- */

  _dbFillBar(used: number, max: number, label: string | null): HTMLDivElement {
    const pct = max > 0 ? Math.min(100, Math.round(100 * used / max)) : 0;
    const cls = pct >= THRESHOLDS.poolErrPct ? 'err' : (pct >= THRESHOLDS.poolWarnPct ? 'warn' : 'ok');
    const wrap = document.createElement('div');
    wrap.className = 'admin-db-fillbar';
    const track = document.createElement('div');
    track.className = 'admin-db-fillbar-track';
    const fill = document.createElement('div');
    fill.className = `admin-db-fillbar-fill ${cls}`;
    fill.style.width = `${pct}%`;
    fill.title = `${pct}%`;
    track.appendChild(fill);
    wrap.appendChild(track);
    if (label) {
      const lbl = document.createElement('span');
      lbl.className = 'admin-db-fillbar-lbl';
      lbl.textContent = `${used} / ${max} (${pct}%)`;
      wrap.appendChild(lbl);
    }
    return wrap;
  },

  _dbStackBar(byState: Record<string, number>): HTMLDivElement {
    const STATE_CLS: Record<string, string> = { 'active': 'state-active', 'idle in transaction': 'state-xit',
      'idle in transaction (aborted)': 'state-xit', 'idle': 'state-idle' };
    const total = Math.max(Object.values(byState).reduce((a, b) => a + b, 0), 1);
    const wrap = document.createElement('div');
    wrap.className = 'admin-db-stackbar-wrap';
    const bar = document.createElement('div');
    bar.className = 'admin-db-stackbar';
    for (const [state, count] of Object.entries(byState)) {
      if (!count) continue;
      const pct = Math.max(1, Math.round(100 * count / total));
      const seg = document.createElement('div');
      seg.className = `admin-db-stackbar-seg ${STATE_CLS[state] || 'state-other'}`;
      seg.style.width = `${pct}%`;
      seg.title = `${state}: ${count}`;
      bar.appendChild(seg);
    }
    wrap.appendChild(bar);
    const legend = document.createElement('div');
    legend.className = 'admin-db-stackbar-legend';
    for (const [state, count] of Object.entries(byState)) {
      if (!count) continue;
      const chip = document.createElement('span');
      chip.className = `admin-db-stackbar-chip ${STATE_CLS[state] || 'state-other'}`;
      chip.textContent = `${state}: ${count}`;
      legend.appendChild(chip);
    }
    wrap.appendChild(legend);
    return wrap;
  },

  _dbTableCards(tables: AdminTableStatData[]): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'admin-db-tbl-cards';
    AdminCockpit._capList(tables, 10, (vis) => { for (const tbl of vis) {
      const card = document.createElement('div');
      card.className = 'admin-db-tbl-card';
      const issues: string[] = [];
      if (tbl.needs_vacuum)  issues.push(Util.t('ui.diag_vacuum'));
      if (tbl.needs_analyze) issues.push(Util.t('ui.diag_analyze'));
      if (issues.length) card.classList.add('has-issues');
      const row1 = document.createElement('div');
      row1.className = 'admin-db-tbl-card-row1';
      const name = document.createElement('span');
      name.className = 'admin-db-tbl-card-name';
      name.textContent = tbl.table;
      const size = document.createElement('span');
      size.className = 'admin-db-tbl-card-size';
      size.textContent = tbl.total_size || '';
      const badge = document.createElement('span');
      badge.className = `admin-db-tbl-card-badge ${issues.length ? 'warn' : 'ok'}`;
      badge.textContent = issues.length ? issues.join(' + ') + ' ' + Util.t('ui.diag_needed') : Util.t('ui.diag_healthy');
      row1.appendChild(name); row1.appendChild(size); row1.appendChild(badge);
      card.appendChild(row1);
      const total = Math.max((tbl.live_rows ?? 0) + (tbl.dead_rows ?? 0), 1);
      const deadPct = Math.min(100, Math.round(100 * (tbl.dead_rows ?? 0) / total));
      const barWrap = document.createElement('div');
      barWrap.className = 'admin-db-tbl-card-barwrap';
      const barLive = document.createElement('div');
      barLive.className = 'admin-db-tbl-card-live';
      barLive.style.width = `${100 - deadPct}%`;
      barLive.title = `${Util.t('ui.diag_table_live')}: ${(tbl.live_rows ?? 0).toLocaleString()}`;
      const barDead = document.createElement('div');
      barDead.className = 'admin-db-tbl-card-dead';
      barDead.style.width = `${deadPct}%`;
      barDead.title = `${Util.t('ui.diag_table_dead')}: ${(tbl.dead_rows ?? 0).toLocaleString()} (${tbl.dead_pct}%)`;
      barWrap.appendChild(barLive); barWrap.appendChild(barDead);
      card.appendChild(barWrap);
      const row2 = document.createElement('div');
      row2.className = 'admin-db-tbl-card-row2';
      const vacAt = tbl.last_autovacuum || tbl.last_vacuum;
      row2.textContent = Util.t('ui.diag_table_row2', {
        live: (tbl.live_rows ?? 0).toLocaleString(),
        dead: (tbl.dead_rows ?? 0).toLocaleString(),
        deadPct: tbl.dead_pct,
        vacAt: vacAt ? AdminCockpit._relTime(new Date(vacAt)) : Util.t('ui.diag_vacuum_never'),
      });
      card.appendChild(row2);

      const actions = document.createElement('div');
      actions.className = 'db-maint-actions';
      const urgentVA = tbl.needs_vacuum || tbl.needs_analyze;
      const urgentA  = tbl.needs_analyze;
      const vaBtn = document.createElement('button');
      vaBtn.className = `db-maint-btn${urgentVA ? ' db-maint-btn--urgent' : ''}`;
      vaBtn.dataset.maintAction = 'vacuum-analyze';
      vaBtn.dataset.maintTable = tbl.table;
      vaBtn.textContent = Util.t('btn.vacuum_analyze');
      const aBtn = document.createElement('button');
      aBtn.className = `db-maint-btn${urgentA ? ' db-maint-btn--urgent' : ''}`;
      aBtn.dataset.maintAction = 'analyze';
      aBtn.dataset.maintTable = tbl.table;
      aBtn.textContent = Util.t('btn.analyze');
      actions.appendChild(vaBtn);
      actions.appendChild(aBtn);
      card.appendChild(actions);

      wrap.appendChild(card);
    } }, wrap);
    return wrap;
  },

  _dbHBarChart(indexes: AdminIndexUsageData[]): HTMLDivElement {
    const maxScans = Math.max(...indexes.map((ix) => ix.scans ?? 0), 1);
    const wrap = document.createElement('div');
    wrap.className = 'admin-db-hbar-chart';
    AdminCockpit._capList(indexes, 15, (vis) => { for (const ix of vis) {
      const pct = Math.max(ix.unused ? 0 : 1, Math.round(100 * (ix.scans ?? 0) / maxScans));
      const row = document.createElement('div');
      row.className = 'admin-db-hbar-row';
      const names = document.createElement('div');
      names.className = 'admin-db-hbar-names';
      const tblN = document.createElement('span');
      tblN.className = 'admin-db-hbar-tbl';
      tblN.textContent = ix.table || '';
      const idxN = document.createElement('span');
      idxN.className = `admin-db-hbar-idx${ix.unused ? ' unused' : ''}`;
      idxN.textContent = ix.index || '';
      names.appendChild(tblN); names.appendChild(idxN);
      const track = document.createElement('div');
      track.className = 'admin-db-hbar-track';
      const fill = document.createElement('div');
      fill.className = `admin-db-hbar-fill${ix.unused ? ' unused' : ''}`;
      fill.style.width = `${pct}%`;
      track.appendChild(fill);
      const val = document.createElement('span');
      val.className = 'admin-db-hbar-val';
      val.textContent = (ix.scans ?? 0).toLocaleString();
      const sizeChip = document.createElement('span');
      sizeChip.className = 'admin-db-hbar-size';
      sizeChip.textContent = ix.index_size || '';
      row.appendChild(names); row.appendChild(track); row.appendChild(val); row.appendChild(sizeChip);
      wrap.appendChild(row);
    } }, wrap);
    return wrap;
  },

  _dbSlowQueryBars(queries: AdminSlowQuery[]): HTMLDivElement {
    const maxMs = Math.max(...queries.map((q) => q.mean_ms ?? 0), 1);
    const wrap = document.createElement('div');
    wrap.className = 'admin-db-hbar-chart';
    AdminCockpit._capList(queries, 10, (vis) => { for (const q of vis) {
      const pct = Math.max(1, Math.round(100 * (q.mean_ms ?? 0) / maxMs));
      const cls = (q.mean_ms ?? 0) > THRESHOLDS.slowQueryErrMs ? 'err' : ((q.mean_ms ?? 0) > THRESHOLDS.slowQueryWarnMs ? 'warn' : '');
      const row = document.createElement('div');
      row.className = 'admin-db-hbar-row';
      const names = document.createElement('div');
      names.className = 'admin-db-hbar-names';
      const qText = document.createElement('span');
      qText.className = 'admin-db-hbar-idx';
      qText.textContent = (q.query || '').slice(0, 90);
      qText.title = q.query || '';
      names.appendChild(qText);
      const track = document.createElement('div');
      track.className = 'admin-db-hbar-track';
      const fill = document.createElement('div');
      fill.className = `admin-db-hbar-fill${cls ? ' ' + cls : ''}`;
      fill.style.width = `${pct}%`;
      track.appendChild(fill);
      const val = document.createElement('span');
      val.className = 'admin-db-hbar-val';
      val.textContent = `${q.mean_ms}ms`;
      if (cls) val.style.color = `var(--${cls})`;
      const callChip = document.createElement('span');
      callChip.className = 'admin-db-hbar-size';
      callChip.textContent = `${q.calls.toLocaleString()} ${Util.t('diag.calls')}`;
      row.appendChild(names); row.appendChild(track); row.appendChild(val); row.appendChild(callChip);
      wrap.appendChild(row);
    } }, wrap);
    return wrap;
  },

  _dbProgressBars(seqs: AdminSequenceHealthData[]): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'admin-db-progress-list';
    for (const s of seqs) {
      const row = document.createElement('div');
      row.className = 'admin-db-progress-row';
      const name = document.createElement('span');
      name.className = 'admin-db-progress-name';
      name.textContent = `${s.schema}.${s.name}`;
      const track = document.createElement('div');
      track.className = 'admin-db-fillbar-track';
      const fill = document.createElement('div');
      fill.className = `admin-db-fillbar-fill ${s.status || 'ok'}`;
      fill.style.width = `${Math.max(0.5, s.used_pct ?? 0)}%`;
      fill.title = `${s.used_pct}%`;
      track.appendChild(fill);
      const lbl = document.createElement('span');
      lbl.className = 'admin-db-fillbar-lbl';
      lbl.textContent = `${s.used_pct}%${s.cycles ? ' ↻' : ''}  (${(s.last_value ?? 0).toLocaleString()} / ${(s.max_value ?? 0).toLocaleString()})`;
      row.appendChild(name); row.appendChild(track); row.appendChild(lbl);
      wrap.appendChild(row);
    }
    return wrap;
  },

  _dbLockChain(locks: AdminLockWaitData[]): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'admin-db-lock-chains';
    for (const lk of locks) {
      const chain = document.createElement('div');
      chain.className = 'admin-db-lock-chain';
      // pid is non-nullable on AdminLockWaitData — both real call sites below
      // pass lk.blocking_pid/lk.blocked_pid, never a null.
      const mkNode = (pid: number, role: string, query: string | null, cls: string): HTMLDivElement => {
        const node = document.createElement('div');
        node.className = `admin-db-lock-node ${cls}`;
        node.innerHTML = `<span class="admin-db-lock-pid">PID ${pid}</span>`
          + `<span class="admin-db-lock-role">${Util.escapeHtml(role)}</span>`
          + `<div class="admin-db-lock-query">${Util.escapeHtml((query || '—').slice(0, 90))}</div>`;
        return node;
      };
      chain.appendChild(mkNode(lk.blocking_pid, Util.t('diag.lock_blocking'), lk.blocking_query, 'blocking'));
      const arrow = document.createElement('div');
      arrow.className = 'admin-db-lock-arrow';
      arrow.innerHTML = `<span class="admin-db-lock-type">${Util.escapeHtml(lk.lock_type || '')}</span> ▼`;
      chain.appendChild(arrow);
      chain.appendChild(mkNode(lk.blocked_pid, `${Util.t('diag.lock_blocked')} ${lk.blocked_for_s}s`, lk.blocked_query, 'blocked'));
      wrap.appendChild(chain);
    }
    return wrap;
  },

  _dbWarnBanner(parent: HTMLElement, text: string, isError?: boolean): void {
    const d = document.createElement('div');
    d.className = `admin-db-banner ${isError ? 'admin-db-banner-err' : 'admin-db-banner-warn'}`;
    d.textContent = text;
    parent.appendChild(d);
  },

  _dbTable(headers: string[], rowDefs: AdminDbTableRow[]): HTMLTableElement {
    const tbl = document.createElement('table');
    tbl.className = 'admin-db-tbl';
    const thead = tbl.createTHead();
    const hrow = thead.insertRow();
    headers.forEach((h) => {
      const th = document.createElement('th');
      th.textContent = h;
      hrow.appendChild(th);
    });
    const tbody = tbl.createTBody();
    for (const { cells, rowWarn, rowErr, cellWarn } of rowDefs) {
      const tr = tbody.insertRow();
      if (rowErr)  tr.style.background = 'rgba(192,57,43,0.07)';
      else if (rowWarn) tr.style.background = 'rgba(243,156,18,0.06)';
      cells.forEach((c, i) => {
        const td = tr.insertCell();
        td.textContent = (c === null || c === undefined) ? '—' : String(c);
        if (cellWarn.includes(i)) td.style.color = 'var(--warn)';
      });
    }
    return tbl;
  },

  async _clearBackendLog(): Promise<void> {
    // The server ring buffer is shared diagnostics evidence and cannot be restored.
    const ok = await Modal.confirm({
      title: Util.t('ui.backend_log_clear_confirm'),
      message: Util.t('ui.backend_log_clear_msg'),
      confirmLabel: Util.t('btn.backend_log_clear'),
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const r = await Util.fetchTraced(`${Config.API_BASE}/logs/backend/clear`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      void UnifiedLogPane.render();
    } catch (e) {
      Toast.show(Util.t('toast.backend_log_clear_failed', { msg: (e as Error).message }), 'error');
    }
  },

  _copyFiltered(): void {
    const entries = UnifiedLogPane.filteredEntries();
    const txt = entries.map((e) =>
      `${e.ts ?? ''} [${e.level.toUpperCase()}] [${e.source}]${e.user ? ' <' + e.user + '>' : ''}${e.plant ? ' (' + e.plant + ')' : ''} ${e.text}`
    ).join('\n');
    navigator.clipboard?.writeText(txt).then(
      () => Toast.show(Util.t('toast.copied_filtered', { count: entries.length }), 'success'),
      () => Toast.show(Util.t('toast.copy_failed'), 'error')
    );
  },

  _relTime(d: Date | string | number): string {
    const diffMs = Date.now() - (d instanceof Date ? d : new Date(d)).getTime();
    const s = Math.round(diffMs / 1000);
    if (s < 60)    return Util.t('ui.time_s_ago', { n: s });
    if (s < 3600)  return Util.t('ui.time_m_ago', { n: Math.floor(s / 60) });
    if (s < 86400) return Util.t('ui.time_h_ago', { n: Math.floor(s / 3600) });
    return Util.t('ui.time_d_ago', { n: Math.floor(s / 86400) });
  },

  async _clearAudit(): Promise<void> {
    const ok = await Modal.confirm({ title: Util.t('modal.delete_upload_history'), confirmLabel: Util.t('btn.yes_delete_all') });
    if (!ok) return;
    Util.fetchTraced(`${Config.API_BASE}/upload/audit/clear`, { method: 'POST' })
      .then(r => r.json())
      .then((body: { status: string; deleted: number }) => {
        if (body.status !== 'ok') { Toast.show(Util.t('toast.clear_history_failed'), 'error'); return; }
        Toast.show(Util.t('toast.history_cleared', { count: body.deleted }), 'success');
        AdminCockpit._renderAudit();
        void UnifiedLogPane.render();
      })
      .catch((e: Error) => Toast.show(Util.t('toast.clear_history_failed') + ': ' + e.message, 'error'));
  },

  _renderAudit(): void {
    const host = document.getElementById('admin-audit-list');
    if (!host) return;
    host.textContent = Util.t('ui.loading');
    AdminCockpit._auditAbort?.abort();
    AdminCockpit._auditAbort = new AbortController();
    const sig = AbortSignal.any
      ? AbortSignal.any([AdminCockpit._auditAbort.signal, AbortSignal.timeout(8000)])
      : AdminCockpit._auditAbort.signal;
    Util.fetchTraced(`${Config.API_BASE}/upload/audit`, { signal: sig })
      .then(r => r.json() as Promise<AdminUploadAuditResponse>)
      .then(body => {
        host.textContent = '';
        const items = body?.audit || [];
        if (items.length === 0) {
          const e = document.createElement('div');
          e.className = 'admin-log-empty';
          e.textContent = Util.t('empty.no_uploads');
          host.appendChild(e);
          return;
        }
        const tbl = document.createElement('table');
        tbl.className = 'admin-audit-tbl';
        const thead = document.createElement('thead');
        const htr = document.createElement('tr');
        for (const h of [Util.t('ui.audit_col_when'), Util.t('ui.audit_col_file'), Util.t('ui.audit_col_rows'), Util.t('ui.audit_col_inserted'), Util.t('ui.audit_col_updated'), Util.t('ui.audit_col_unchanged'), Util.t('ui.audit_col_batch'), Util.t('ui.audit_col_warnings')]) {
          const th = document.createElement('th');
          th.textContent = h;
          htr.appendChild(th);
        }
        thead.appendChild(htr);
        tbl.appendChild(thead);

        const tb = document.createElement('tbody');
        for (const it of items) {
          const visibleWarnings = (it.warnings ?? []).filter(x => x.category !== 'upload_counts');
          const hasWarnings = visibleWarnings.length > 0;

          const tr = document.createElement('tr');
          if (hasWarnings) tr.classList.add('admin-audit-has-warn');
          tr.style.cursor = hasWarnings ? 'pointer' : '';

          const batchShort = it.batch_id ? it.batch_id.slice(0, 8) + '…' : '—';
          const cells = [
            Util.fmtIsoStampPref(it.uploaded_at || '', true).trim(),
            it.filename || '—',
            String(it.row_count ?? '—'),
            String(it.inserted ?? '—'),
            String(it.updated ?? '—'),
            String(it.warnings?.find((x) => x.category === 'upload_counts')?.unchanged ?? '—'),
            batchShort,
            hasWarnings ? `⚠ ${visibleWarnings.length}` : '✓',
          ];
          cells.forEach((c, i) => {
            const td = document.createElement('td');
            td.textContent = c;
            if (i === 7 && hasWarnings) td.style.color = 'var(--warn,#b57a0a)';
            if (i === 6 && it.batch_id) td.title = it.batch_id;
            tr.appendChild(td);
          });

          if (hasWarnings) {
            const warnRow = document.createElement('tr');
            warnRow.className = 'admin-audit-warn-detail';
            warnRow.style.display = 'none';
            const td = document.createElement('td');
            td.colSpan = 8;
            td.style.padding = '0';
            const warnContainer = document.createElement('div');
            warnContainer.style.padding = '12px';

            // Check for distribution warning
            const distWarning = it.warnings.find(w => (w as AdminUploadWarning).category === 'distribution');
            if (distWarning) {
              warnContainer.appendChild(AdminCockpit._renderDistributionWarning(distWarning as AdminUploadWarning, it.batch_id));
            }

            // Show other warnings
            const otherWarnings = visibleWarnings.filter(w => (w as AdminUploadWarning).category !== 'distribution');
            if (otherWarnings.length > 0) {
              warnContainer.appendChild(AdminCockpit._warningList(otherWarnings));
            }

            td.appendChild(warnContainer);
            warnRow.appendChild(td);
            tb.appendChild(tr);
            tb.appendChild(warnRow);
            tr.addEventListener('click', () => {
              warnRow.style.display = warnRow.style.display === 'none' ? '' : 'none';
            });
          } else {
            tb.appendChild(tr);
          }
        }
        tbl.appendChild(tb);
        host.appendChild(tbl);
      })
      .catch((e: Error) => {
        if (e?.name === 'AbortError') return;
        host.textContent = '';
        const err = document.createElement('div');
        err.className = 'admin-status error';
        err.textContent = Util.t('ui.failed_load_upload_history', { error: e.message });
        host.appendChild(err);
      });
  },

  async _clearAuditLog(): Promise<void> {
    const ok = await Modal.confirm({ title: Util.t('modal.clear_audit_log'), confirmLabel: Util.t('btn.yes_delete') });
    if (!ok) return;
    Util.fetchTraced(`${Config.API_BASE}/audit/log/clear`, { method: 'POST' })
      .then(r => r.json())
      .then((body: { status: string }) => {
        if (body.status !== 'ok') { Toast.show(Util.t('toast.clear_failed'), 'error'); return; }
        Toast.show(Util.t('toast.audit_log_cleared'), 'success');
        void UnifiedLogPane.render();
      })
      .catch((e: Error) => Toast.show(Util.t('toast.clear_failed') + ': ' + e.message, 'error'));
  },

  /* ---------------------------------------------------------------------
     THREAD PROFILER PANEL — PerfMonitor ring-buffer stats table.
     Rendered into #admin-perf-tbody (Diagnostics pane) on tab activation and on each
     PerfMonitor notification (debounced 250 ms by PerfMonitor itself).
     --------------------------------------------------------------------- */
  _refreshThreadPane(): void {
    const tbody = document.getElementById('admin-perf-tbody');
    if (!tbody) return;
    const rows = PerfMonitor.all();
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="admin-perf-empty">${Util.escapeHtml(Util.t('thread.empty'))}</td></tr>`;
      AdminCockpit._repaintHeads();
      return;
    }
    rows.sort((a, b) => b.last - a.last);
    const fmt = (ms: number): string => ms < 1 ? `${ms.toFixed(2)}` : ms < 100 ? `${ms.toFixed(1)}` : `${Math.round(ms)}`;
    const cls = (ms: number): string => ms >= 50 ? 'perf-hot' : ms >= 16 ? 'perf-warn' : 'perf-ok';
    const ago = (ts: number): string => {
      if (!ts) return '—';
      const s = Math.round((Date.now() - ts) / 1000);
      if (s < 2)  return Util.t('thread.just_now');
      if (s < 60) return Util.t('thread.s_ago', { s });
      return Util.t('thread.m_ago', { m: Math.round(s / 60) });
    };
    tbody.innerHTML = rows.map(r => {
      const c = cls(r.last);
      return `<tr>
        <td class="perf-name">${Util.escapeHtml(r.name)}</td>
        <td class="${c}">${fmt(r.last)} ${'ms'}</td>
        <td class="${cls(r.p50)}">${fmt(r.p50)} ${'ms'}</td>
        <td class="${cls(r.p95)}">${fmt(r.p95)} ${'ms'}</td>
        <td class="${cls(r.max)}">${fmt(r.max)} ${'ms'}</td>
        <td>${r.count}</td>
        <td class="perf-ago">${ago(r.lastTs)}</td>
      </tr>`;
    }).join('');
    AdminCockpit._repaintHeads();
  },

  /* ---------------------------------------------------------------------
     DIAGNOSTICS PANEL — client-side health summary, "Reset client state",
     diagnostics bundle export. Renders into #admin-diagnostics-pane.
     --------------------------------------------------------------------- */
  _renderDiagnostics(): void {
    const host = document.getElementById('admin-diagnostics-pane');
    if (!host) return;

    const inv  = Persistence.storageInventory();
    const totK = (inv.totalBytes / 1024).toFixed(1);
    const lastK = (inv.lastBytes / 1024).toFixed(1);
    const lastWhen = inv.lastSavedAt ? Util._fmtTimePref(new Date(inv.lastSavedAt)) : '—';
    const errCount  = ErrorLog.countBy('error');
    const warnCount = ErrorLog.countBy('warn');
    const errRate   = ErrorLog.errorRatePerMin();
    const warnRate  = ErrorLog.warnRatePerMin();
    const mem = (performance as Performance & { memory?: ChromePerformanceMemory }).memory;
    const heap = mem
      ? `${(mem.usedJSHeapSize / 1048576).toFixed(0)} / ${(mem.jsHeapSizeLimit / 1048576).toFixed(0)} MB`
      : 'n/a';
    const stats: AdminPersistenceStats | Record<string, never> = (Persistence.stats && Persistence.stats()) || {};

    const autosaveTxt = inv.autosaveDisabled
      ? `<span class="admin-bad">${Util.t('ui.ls_quota_disabled')}</span>`
      : inv.degraded
        ? `<span>${Util.t('ui.ls_degraded')}</span>`
        : `<span class="admin-good">${Util.t('ui.ls_healthy')}</span>`;
    const errTxt = errRate > THRESHOLDS.errRateErrPerMin
      ? `<span class="admin-bad">${Util.t('ui.diag_err_rate_spike', { count: errCount, rate: errRate })}</span>`
      : errRate > 0
        ? `<span class="admin-warn">${Util.t('ui.diag_err_rate_warn', { count: errCount, rate: errRate })}</span>`
        : `${errCount}`;

    // The body of the Client section: the head (title, help, light, one-liner) is the section's own summary.
    // Refresh and Export bundle live in the page head now; Inspect storage and Reset stay with the data they act on.
    host.innerHTML = `
        <div class="diag-client-actions">
          <button class="btn btn-ghost sm" id="admin-diag-storage" title="${Util.t('tip.inspect_storage')}">${Util.t('btn.inspect_storage')}</button>
          <button class="btn btn-warn  sm" id="admin-diag-reset"   title="${Util.t('tip.diag_clear_cache')}">${Util.t('btn.reset_client')}</button>
        </div>
        <div class="admin-kv diag-kv2">
          <span>${Util.t('ui.diag_kv_build')}</span><span>${Config.BUILD_ID}</span>
          <span>${Util.t('ui.diag_kv_schema')}</span><span>${Config.SCHEMA_VERSION}</span>
          <span>${Util.t('ui.diag_kv_cache')}</span><span>${Util.t('ui.diag_cache_val', { size: lastK, when: lastWhen })}</span>
          <span>${Util.t('ui.diag_kv_storage')}</span><span>${Util.t('ui.diag_storage_val', { size: totK, count: inv.count })}</span>
          <span>${Util.t('ui.diag_kv_autosave')}</span><span>${autosaveTxt}</span>
          <span>${Util.t('ui.diag_kv_heap')}</span><span>${heap}</span>
          <span>${Util.t('ui.diag_kv_errors')}</span><span>${errTxt}</span>
          <span>${Util.t('ui.diag_kv_warnings')}</span><span>${warnCount} (${warnRate}/min)</span>
          <span>${Util.t('ui.diag_kv_tasks')}</span><span>${Store.tasksArr.length}</span>
          <span>${Util.t('ui.diag_kv_source')}</span><span>${stats.source || '—'}</span>
          <span>${Util.t('ui.diag_kv_plant')}</span><span>${Store.selectedPlant ? Util.escapeHtml(Store.selectedPlant) : `<em>${Util.t('ui.none')}</em>`}</span>
        </div>`;

    document.getElementById('admin-diag-storage')!.addEventListener('click', () => AdminCockpit._showStorageInventory(inv));
    document.getElementById('admin-diag-reset'  )!.addEventListener('click', () => AdminCockpit._resetClientState());
    AdminCockpit._computeClientStats();
    AdminCockpit._repaintHeads();
  },

  async _resetClientState(): Promise<void> {
    const ok = await Modal.confirm({
      title:        Util.t('modal.reset_client_title'),
      message:      Util.t('modal.reset_client_msg'),
      detail:       Util.t('modal.reset_client_detail'),
      confirmLabel: Util.t('modal.reset_client_confirm'),
      tone:         'warn',
    });
    if (!ok) return;
    Session.clearLocalPlannerData({ keepQueuedWork: true });
    ErrorLog.info('admin', 'Client state reset by user — reloading');
    // Give the log a frame to render in case of debounce, then hard-reload bypassing HTTP cache.
    setTimeout(() => location.reload(), 50);
  },

  _showStorageInventory(inv?: AdminStorageInventory): void {
    if (!inv) inv = Persistence.storageInventory();
    const top = inv.items.slice(0, 12)
      .map((i) => `${(i.bytes / 1024).toFixed(1).padStart(7)} KB  ${i.key}`)
      .join('\n') || Util.t('ui.ls_empty');
    const lsStatus = inv.autosaveDisabled ? Util.t('ui.ls_autosave_disabled') : inv.degraded ? Util.t('ui.ls_evicted_tier') : Util.t('ui.ls_healthy');
    const detail =
      `<pre style="margin:0;font:11px ui-monospace,monospace;white-space:pre;">` +
      Util.t('modal.ls_inv_total', { size: (inv.totalBytes / 1024).toFixed(1), count: inv.count }) + '\n' +
      Util.t('modal.ls_inv_snapshot', { size: (inv.lastBytes / 1024).toFixed(1), status: lsStatus }) + '\n\n' +
      Util.t('modal.ls_inventory_top_keys') + `\n${top}` +
      `</pre>`;
    Modal.confirm({
      title:        Util.t('modal.ls_inventory_title'),
      message:      Util.t('modal.ls_inventory_msg'),
      detail,
      confirmLabel: Util.t('btn.close'),
      tone:         'warn',
    });
  },

  _exportDiagnostics(): void {
    const mem = (performance as Performance & { memory?: ChromePerformanceMemory }).memory;
    const bundle = {
      generatedAt: new Date().toISOString(),
      build:       Config.BUILD_ID,
      schema:      Config.SCHEMA_VERSION,
      userAgent:   navigator.userAgent,
      location:    location.href,
      storage:     Persistence.storageInventory(),
      heap: mem ? {
        usedMB:  +(mem.usedJSHeapSize / 1048576).toFixed(1),
        limitMB: +(mem.jsHeapSizeLimit / 1048576).toFixed(1),
      } : null,
      persistence: (Persistence.stats && Persistence.stats()) || null,
      health:      AdminCockpit._healthData || null,
      deep:        AdminCockpit._deepData   || null,
      dbDeep:      AdminCockpit._diagInputs().dbDeep,   // the freshest of this page's read and the Overview's
      storeCounts: {
        tasks:        Store.tasksArr.length,
        blocks:       (Store.blocks || []).length,
        plantBlocks:  (Store.plantBlocks || []).length,
        lines:        Object.keys(Store.lineSettings || {}).length,
        plants:       Object.keys(Store.plants || {}).length,
        firmed:       Store.firmedIds ? Store.firmedIds.size : 0,
        alerts:       (Store.alerts || []).length,
      },
      selectedPlant: Store.selectedPlant,
      errorRates: {
        errorPerMin: ErrorLog.errorRatePerMin(),
        warnPerMin:  ErrorLog.warnRatePerMin(),
        totalErrors: ErrorLog.countBy('error'),
        totalWarns:  ErrorLog.countBy('warn'),
      },
      errors: ErrorLog.entries().slice(-500),
      droppedErrors: ErrorLog.droppedCount(),
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nimbus-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    Toast.show(Util.t('toast.diag_bundle_downloaded'), 'success');
  }
};

/* ============================================================================
   SystemConfig — Admin Cockpit "System Configuration" sub-tab: admin-set
   GLOBAL defaults (all users, no per-user override) for which optional Orders
   fields show in the AG Grid columns / Inspector panel. Backed by the
   system_settings singleton table (GET/POST /system-settings) and the shared
   frontend/order-field-catalog.mjs catalog.

   Deliberately distinct — in both code and UI label — from
   Plant._renderSettingsPane()'s "System Settings" pane, a different,
   plant-scoped UI surface (alert/confidence horizons + optimizer constraints).
   ========================================================================== */
export const SystemConfig = (() => {
  const API = Config.API_BASE;
  type Fields = Record<string, { grid: boolean; inspector: boolean }>;
  let _baseline: Fields = {};
  let _draft: Fields = {};
  // Order-history (schedule_event) retention window, days. Server clamps 1-60 and rejects anything else with a 400.
  let _retBaseline = 14;
  let _retDraft = 14;
  // The raw text in the input. _retDraft only follows it while it is an integer 1-60; anything else
  // leaves Save disabled (the server's 400 stays the backstop) instead of being silently clamped mid-typing.
  let _retInvalid = false;
  let _loaded = false;
  let _saving = false;
  let _loadGeneration = 0;
  let _revision = 0;

  function _normalize(fields: Record<string, { grid?: boolean; inspector?: boolean }>): Fields {
    return Object.fromEntries(ORDER_FIELD_CATALOG.map(field => [field.key, {
      grid: fields[field.key]?.grid ?? field.gridDefault,
      inspector: fields[field.key]?.inspector ?? field.inspectorDefault,
    }]));
  }

  function _retentionValue(raw: unknown): number {
    const n = Math.round(Number(raw));
    return Number.isFinite(n) && n >= 1 ? Math.min(60, n) : 14;
  }

  function _retentionParse(raw: string): number | null {
    const text = raw.trim();
    if (!/^\d+$/.test(text)) return null;
    const n = Number(text);
    return n >= 1 && n <= 60 ? n : null;
  }

  function _dirty(): boolean {
    return _loaded && (_retDraft !== _retBaseline || ORDER_FIELD_CATALOG.some(field =>
      _draft[field.key].grid !== _baseline[field.key].grid || _draft[field.key].inspector !== _baseline[field.key].inspector));
  }

  function _sync(): void {
    const host = document.getElementById('system-config-host');
    const save = host?.querySelector<HTMLButtonElement>('#sc-save-btn');
    if (save) save.disabled = _saving || _retInvalid || !_dirty();
    const retInput = host?.querySelector<HTMLInputElement>('#sc-retention-days');
    if (retInput) {
      if (_retInvalid) retInput.setAttribute('aria-invalid', 'true'); else retInput.removeAttribute('aria-invalid');
    }
    const retHint = host?.querySelector<HTMLElement>('#sc-retention-invalid');
    if (retHint) retHint.hidden = !_retInvalid;
    const state = host?.querySelector<HTMLElement>('#sc-save-state');
    if (state) state.textContent = _saving ? Util.t('ui.system_config_saving') : _retInvalid ? '' : _dirty() ? Util.t('ui.system_config_unsaved') : '';
  }

  function _writeHeaders(): Record<string, string> {
    return { 'x-user-email': Session.actor(), 'content-type': 'application/json' };
  }

  // Public entry point — fetch the current global config, then paint.
  async function render(): Promise<void> {
    const host = document.getElementById('system-config-host');
    if (!host) return;
    const generation = ++_loadGeneration;
    if (_loaded && (_saving || _dirty())) { _paint(); return; }
    const revision = _revision;
    const current = () => generation === _loadGeneration && revision === _revision && document.getElementById('system-config-host') === host;
    try {
      // Response body IS the settings content directly ({"orderFields": {...}}),
      // no wrapper envelope — see master_data.get_system_settings() in brain.py.
      const data: { orderFields?: Record<string, { grid?: boolean; inspector?: boolean }>; schedule_event_retention_days?: number } =
        await Util.fetchTraced(`${API}/system-settings`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
      if (!current()) return;
      _baseline = _normalize(data.orderFields ?? {});
      _draft = _normalize(_baseline);
      _retBaseline = _retentionValue(data.schedule_event_retention_days);
      _retDraft = _retBaseline;
      _retInvalid = false;
      _loaded = true;
      _paint();
    } catch (e) {
      if (!current()) return;
      host.innerHTML = `<div class="empty-state">${Util.escapeHtml(Util.t('ui.system_config_load_failed'))}: ${Util.escapeHtml((e as Error).message)}</div>`;
      ErrorLog.error('system-config', `Load system settings failed: ${(e as Error).message}`);
    }
  }

  function _paint(): void {
    const host = document.getElementById('system-config-host');
    if (!host) return;
    _retInvalid = false; // the repaint shows _retDraft, which is always valid
    const rows = ORDER_FIELD_CATALOG.map((f) => {
      const cfg = _draft[f.key] || {};
      const gridChecked = cfg.grid ?? f.gridDefault;
      const inspChecked = cfg.inspector ?? f.inspectorDefault;
      return `<tr>
        <td class="md-th">${Util.escapeHtml(Util.t(f.i18nInspectorKey))}</td>
        <td style="text-align:center"><input type="checkbox" data-sc-field="${Util.escapeHtml(f.key)}" data-sc-surface="grid" aria-label="${Util.escapeHtml(Util.t(f.i18nInspectorKey))}: ${Util.escapeHtml(Util.t('ui.system_config_show_grid'))}" ${gridChecked ? 'checked' : ''}></td>
        <td style="text-align:center"><input type="checkbox" data-sc-field="${Util.escapeHtml(f.key)}" data-sc-surface="inspector" aria-label="${Util.escapeHtml(Util.t(f.i18nInspectorKey))}: ${Util.escapeHtml(Util.t('ui.system_config_show_inspector'))}" ${f.inspector === false ? `disabled title="${Util.escapeHtml(Util.t('ui.system_config_no_inspector_row'))}"` : (inspChecked ? 'checked' : '')}></td>
      </tr>`;
    }).join('');

    host.innerHTML = `
      <div class="panel">
        <h3>${Util.escapeHtml(Util.t('ui.system_config_title'))}</h3>
        <p class="muted">${Util.escapeHtml(Util.t('ui.system_config_desc'))}</p>
        <div class="md-table-wrap">
          <table class="md-table">
            <thead><tr>
              <th class="md-th">${Util.escapeHtml(Util.t('ui.system_config_field'))}</th>
              <th class="md-th">${Util.escapeHtml(Util.t('ui.system_config_show_grid'))}</th>
              <th class="md-th">${Util.escapeHtml(Util.t('ui.system_config_show_inspector'))}</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="form-row" style="margin-top:14px;max-width:320px;">
          <label for="sc-retention-days">${Util.escapeHtml(Util.t('ui.system_config_history_retention'))}</label>
          <input type="number" id="sc-retention-days" min="1" max="60" step="1" value="${_retDraft}" aria-describedby="sc-retention-hint sc-retention-invalid">
          <p class="muted" id="sc-retention-hint" style="margin-top:4px;">${Util.escapeHtml(Util.t('ui.system_config_history_retention_hint'))}</p>
          <p class="muted" id="sc-retention-invalid" role="alert" style="margin-top:4px;color:var(--err);" hidden>${Util.escapeHtml(Util.t('ui.system_config_history_retention_invalid'))}</p>
        </div>
        <div style="margin-top:12px;display:flex;align-items:center;gap:10px;">
          <button class="btn btn-primary" id="sc-save-btn" disabled>${Util.escapeHtml(Util.t('btn.save'))}</button>
          <span id="sc-save-state" role="status" aria-live="polite"></span>
        </div>
      </div>
    `;

    host.querySelector('#sc-save-btn')?.addEventListener('click', _save);
    host.querySelector<HTMLInputElement>('#sc-retention-days')?.addEventListener('input', (e) => {
      const parsed = _retentionParse(String((e.target as HTMLInputElement).value));
      _retInvalid = parsed === null;
      if (parsed !== null) _retDraft = parsed;
      ++_revision;
      _sync();
    });
    // Clamp / write back only once the planner leaves the field (change fires on blur or Enter).
    host.querySelector<HTMLInputElement>('#sc-retention-days')?.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (_retentionParse(String(input.value)) === null) {
        const text = String(input.value).trim();
        const numeric = Number(text);
        // Empty or non-numeric restores the last valid draft; a number outside 1-60 clamps to the bound.
        _retDraft = text !== '' && Number.isFinite(numeric) ? Math.min(60, Math.max(1, Math.round(numeric))) : _retDraft;
      }
      _retInvalid = false;
      input.value = String(_retDraft);
      ++_revision;
      _sync();
    });
    host.querySelectorAll<HTMLInputElement>('input[data-sc-field]').forEach(input => {
      input.addEventListener('change', () => {
        const key = input.dataset.scField!;
        const surface = input.dataset.scSurface as 'grid' | 'inspector';
        _draft[key][surface] = input.checked;
        ++_revision;
        _sync();
      });
    });
    _sync();
  }

  async function _save(): Promise<void> {
    if (_saving || _retInvalid || !_dirty()) return;
    const next = _normalize(_draft);
    const nextRetention = _retDraft;
    _saving = true;
    ++_revision; // Any earlier GET is obsolete once a write starts.
    _sync();
    try {
      // POST body and response are both the unwrapped { orderFields: {...} }
      // shape (same contract as the GET above) — the whole map is always sent,
      // never a per-field diff (the backend merge replaces 'orderFields' wholesale).
      const saved: { orderFields?: Record<string, { grid?: boolean; inspector?: boolean }>; schedule_event_retention_days?: number } =
        await Util.fetchTraced(`${API}/system-settings`, {
          method: 'POST',
          headers: _writeHeaders(),
          body: JSON.stringify({ orderFields: next, schedule_event_retention_days: nextRetention }),
        }).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
      _baseline = _normalize(saved.orderFields ?? next);
      _retBaseline = _retentionValue(saved.schedule_event_retention_days ?? nextRetention);
      _retDraft = _retBaseline;
      _retInvalid = false;
      Persistence.scheduleEventRetentionDays = _retBaseline;
      Store.setOrderFieldVisibility(_baseline, 'system-config');
      Toast.show(Util.t('toast.system_config_saved'), 'success');
    } catch (e) {
      ErrorLog.error('system-config', `Save system settings failed: ${(e as Error).message}`);
      Toast.show(Util.t('toast.system_config_save_failed'), 'error');
    } finally {
      _saving = false;
      _sync();
    }
  }

  return { render };
})();
