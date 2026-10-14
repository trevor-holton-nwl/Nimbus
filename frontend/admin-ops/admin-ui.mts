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
// AdminCockpit's _setSub dispatches to these three sub-tab renderers.
import { MasterData } from '../master-data/admin-ui.mjs';
import { Interface } from '../integration/sap-interface-ui.mjs';
import { Security } from '../security/security-admin.mjs';

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
  color_wheel: {
    path: string;
    reachable: boolean;
    misses: number;
    missed_colors: string[];
  };
}

/** brain.py's module-level DIAGNOSTICS dict, as returned by the `pipeline`
 *  key of GET /diagnostics/deep. */
interface AdminPipelineSnapshot {
  loaded_at: string | null;
  load_ms: number | null;
  source_file: string | null;
  raw_row_count: number;
  unreadable_start_date: number;
  dropped_no_finish_date: number;
  duplicate_ids_suffixed: number;
  color_merge_misses: number;
  color_merge_ms: number | null;
  missed_colors: string[];
  emitted_task_count: number;
  unique_id_count: number;
  lines: Record<string, number>;
  warnings: AdminPipelineWarning[];
  color_merge_is_per_request?: boolean;
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

interface AdminColorWheelStats {
  error: string | null;
  total_in_orders: number;
  matched: number;
  missed: number;
  missed_colors: string[];
  wheel_total?: number;
  missed_order_count?: number;
  missed_behavior?: string;
}

/** GET /diagnostics/deep. */
interface AdminDiagnosticsDeepResponse {
  pipeline: AdminPipelineSnapshot;
  db_stats: AdminDbStatsDeep;
  color_wheel: AdminColorWheelStats;
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
interface BackendLogEntry {
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
}

/** GET /logs/backend. `dropped` is read by _renderBackendLog but the backend
 *  does not actually return it — always undefined; kept optional so the type
 *  matches that pre-existing (unchanged) runtime behavior exactly. */
interface BackendLogResponse {
  entries: BackendLogEntry[];
  total: number;
  dropped?: number;
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
interface AdminUploadAuditItem {
  batch_id: string;
  filename: string | null;
  row_count: number;
  inserted: number;
  updated: number;
  uploaded_at: string | null;
  warnings: AdminUploadWarning[];
}

interface AdminUploadAuditResponse {
  audit: AdminUploadAuditItem[];
}

/** One row of GET /audit/log (JSONL-backed color-wheel/optimizer audit trail). */
interface AdminAuditLogItem {
  ts: string;
  user?: string;
  action?: string;
  plant?: string;
  details?: Record<string, unknown>;
}

interface AdminAuditLogResponse {
  entries: AdminAuditLogItem[];
}

/** Frontend ErrorLog entry, named via the ReturnType<typeof ...> precedent
 *  (see e.g. schedule-workbench.mts's OptimizerKpis) rather than duplicating
 *  application-foundation.mts's unexported LogEntry shape. */
type AdminFrontendLogEntry = ReturnType<typeof ErrorLog.entries>[number];

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
  _logFilter: { level: 'all', scope: 'all', search: '', errorCode: 'all', reqId: '' },
  _backendLogFilter: { level: 'all', category: 'all', since: '', q: '', reqId: '' },
  _healthData: null as AdminHealthResponse | null,
  _deepData: null as AdminDiagnosticsDeepResponse | null,
  _healthTimer: null as ReturnType<typeof setInterval> | null,
  _pipelineOpen: null as string | null,
  _activeSub: 'overview',
  _activeOvTab: 'diagnostics' as 'diagnostics' | 'data-ops' | 'logs' | 'thread',
  _dbDeepAbort: null as AbortController | null,
  _backendLogAbort: null as AbortController | null,
  _healthAbort: null as AbortController | null,
  _pipelineAbort: null as AbortController | null,
  _auditAbort: null as AbortController | null,
  _auditLogAbort: null as AbortController | null,
  _fpPurgeStart: null as NimbusVendor.FlatpickrInstance | null,
  _fpPurgeEnd: null as NimbusVendor.FlatpickrInstance | null,
  _purgePlant: null as string | null,
  _purgePreview: null as AdminPurgePreview | null,
  _purgePreviewSeq: 0,

  gotoOvTab(tab: 'diagnostics' | 'data-ops' | 'logs' | 'thread'): void {
    AdminCockpit._activeOvTab = tab;
    document.querySelectorAll<HTMLElement>('.admin-ov-tabs .sub-subtab').forEach((b) =>
      b.classList.toggle('active', b.dataset.ovTab === tab));
    (['diagnostics', 'data-ops', 'logs', 'thread'] as const).forEach(t => {
      const el = document.getElementById(`admin-ov-${t}`);
      if (el) el.hidden = (t !== tab);
    });
    if (tab === 'thread') AdminCockpit._refreshThreadPane();
  },

  _setSub(sub: string | undefined): void {
    AdminCockpit._activeSub = sub ?? 'overview';
    document.querySelectorAll<HTMLElement>('.admin-subtab').forEach((b) =>
      b.classList.toggle('active', b.dataset.sub === sub));
    const ov = document.getElementById('admin-overview-pane');
    const mg = document.getElementById('admin-manage-pane');
    const ifc = document.getElementById('admin-interface-pane');
    const sec = document.getElementById('admin-security-pane');
    const sc  = document.getElementById('admin-system-config-pane');
    const tbl = document.getElementById('admin-table-browser-pane');
    if (ov) ov.hidden = (sub !== 'overview');
    if (mg) mg.hidden = (sub !== 'manage');
    if (ifc) ifc.hidden = (sub !== 'interface');
    if (sec) sec.hidden = (sub !== 'security');
    if (sc) sc.hidden = (sub !== 'system-config');
    if (tbl) tbl.hidden = (sub !== 'table-browser');
    if (sub === 'manage') MasterData.render();
    else if (sub === 'interface') Interface.render();
    else if (sub === 'security') Security.render();
    else if (sub === 'system-config') SystemConfig.render();
    else if (sub === 'table-browser') AdminTables.render();
    else AdminCockpit._renderOverview();
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

    document.getElementById('admin-log-reload')?.addEventListener('click', () => Persistence.reload());
    document.getElementById('admin-log-cache')?.addEventListener('click', () => Persistence.clearCache());
    document.getElementById('admin-log-copy')?.addEventListener('click', () => ErrorLog.copy());
    document.getElementById('admin-log-copy-filtered')?.addEventListener('click', () => AdminCockpit._copyFiltered());
    document.getElementById('admin-log-clear')?.addEventListener('click', () => {
      ErrorLog.clear();
      AdminCockpit._renderLogs();
    });

    document.getElementById('admin-audit-reload')?.addEventListener('click', AdminCockpit._renderAudit);
    document.getElementById('admin-audit-clear')?.addEventListener('click', AdminCockpit._clearAudit);
    document.getElementById('admin-audit-log-reload')?.addEventListener('click', AdminCockpit._renderAuditLog);
    document.getElementById('admin-audit-log-clear')?.addEventListener('click', AdminCockpit._clearAuditLog);
    document.getElementById('admin-health-refresh')?.addEventListener('click', AdminCockpit._renderHealth);
    document.getElementById('admin-pipeline-refresh')?.addEventListener('click', AdminCockpit._renderPipeline);
    document.getElementById('admin-db-deep-refresh')?.addEventListener('click', AdminCockpit._renderDbDeep);
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
    document.getElementById('admin-backend-log-refresh')?.addEventListener('click', AdminCockpit._renderBackendLog);
    document.getElementById('admin-backend-log-clear')?.addEventListener('click', AdminCockpit._clearBackendLog);
    document.getElementById('admin-backend-log-filter-level')?.addEventListener('change', (e: Event) => {
      AdminCockpit._backendLogFilter.level = (e.target as HTMLSelectElement).value;
      AdminCockpit._renderBackendLog();
    });

    // Filter controls
    document.getElementById('admin-log-filter-level')?.addEventListener('change', (e: Event) => {
      AdminCockpit._logFilter.level = (e.target as HTMLSelectElement).value;
      AdminCockpit._renderLogs();
    });
    document.getElementById('admin-log-filter-scope')?.addEventListener('change', (e: Event) => {
      AdminCockpit._logFilter.scope = (e.target as HTMLSelectElement).value;
      AdminCockpit._renderLogs();
    });
    document.getElementById('admin-log-search')?.addEventListener('input', (e: Event) => {
      AdminCockpit._logFilter.search = (e.target as HTMLInputElement).value.toLowerCase();
      AdminCockpit._renderLogs();
    });

    ErrorLog.subscribe(() => {
      const panel = document.getElementById('admin-tab');
      if (panel?.classList.contains('active')) {
        AdminCockpit._renderLogs();
      }
    });

    document.getElementById('admin-thread-clear')?.addEventListener('click', () => {
      PerfMonitor.clear();
      AdminCockpit._refreshThreadPane();
    });

    PerfMonitor.subscribe(() => {
      if (AdminCockpit._activeOvTab === 'thread') AdminCockpit._refreshThreadPane();
    });

    Store.subscribe((evt: StoreEvent) => {
      if (evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate') {
        const panel = document.getElementById('admin-tab');
        if (panel?.classList.contains('active')) {
          // Defer so Persistence._lastLoad stats are fully written before rendering.
          setTimeout(() => AdminCockpit._renderPipeline(), 50);
        }
      }
    }, 'AdminCockpit');

    document.addEventListener('mouseover', (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest?.('.adm-help') as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--tip-x', `${r.left + r.width / 2}px`);
      el.style.setProperty('--tip-y', `${r.top}px`);
    });
  },

  render(): void {
    AdminCockpit._setSub('overview');
    AdminCockpit._renderOverview();
  },

  _renderOverview(): void {
    AdminCockpit._renderPurgeMeta();
    AdminCockpit._renderHealth();
    AdminCockpit._renderDiagnostics();
    AdminCockpit._renderPipeline();
    AdminCockpit._renderDbDeep();
    AdminCockpit._renderBackendLog();
    AdminCockpit._renderLogs();
    AdminCockpit._renderAudit();
    AdminCockpit._renderAuditLog();
    AdminCockpit._startHealthPolling();
  },

  /** Started by _renderOverview; called from application-shell.mjs's
   *  visibility-change handler once that file is converted (Phase 5) so this
   *  public start/stop pair's signature is load-bearing beyond this module. */
  _startHealthPolling(): void {
    if (AdminCockpit._healthTimer) return;
    AdminCockpit._healthTimer = setInterval(() => {
      if (document.getElementById('admin-tab')?.classList.contains('active')) {
        AdminCockpit._renderHealth();
      }
    }, 30_000);
  },

  _stopHealthPolling(): void {
    if (AdminCockpit._healthTimer) {
      clearInterval(AdminCockpit._healthTimer);
      AdminCockpit._healthTimer = null;
    }
  },

  _renderHealth(): void {
    AdminCockpit._healthAbort?.abort();
    AdminCockpit._healthAbort = new AbortController();
    const sig = AbortSignal.any
      ? AbortSignal.any([AdminCockpit._healthAbort.signal, AbortSignal.timeout(6000)])
      : AdminCockpit._healthAbort.signal;
    Util.fetchTraced(`${Config.API_BASE}/health`, { signal: sig })
      .then((r) => r.json() as Promise<AdminHealthResponse>)
      .then((data) => {
        AdminCockpit._healthData = data;
        const db = data.db || {};
        const mem = data.memory || {};
        const cw = data.color_wheel || {};

        const dbEl = document.getElementById('admin-health-db');
        if (dbEl) {
          const dot = dbEl.querySelector<HTMLElement>('.admin-health-dot')!;
          const lbl = dbEl.querySelector<HTMLElement>('.admin-health-label')!;
          const cls = !db.connected ? 'err' : (db.ping_ms ?? 0) > 500 ? 'warn' : 'ok';
          dot.className = `admin-health-dot ${cls}`;
          lbl.textContent = db.connected
            ? `DB ${db.ping_ms}ms`
            : `DB offline${db.error ? ': ' + db.error.slice(0, 60) : ''}`;
        }

        const ordEl = document.getElementById('admin-health-orders');
        if (ordEl) {
          ordEl.querySelector<HTMLElement>('.admin-health-label')!.textContent =
            `${(db.total_orders ?? 0).toLocaleString()} orders`;
        }

        const ovEl = document.getElementById('admin-health-overrides');
        if (ovEl) {
          ovEl.querySelector<HTMLElement>('.admin-health-label')!.textContent =
            `${(db.user_overrides ?? 0).toLocaleString()} user overrides`;
        }

        const cwEl = document.getElementById('admin-health-color');
        if (cwEl) {
          const dot = cwEl.querySelector<HTMLElement>('.admin-health-dot')!;
          const lbl = cwEl.querySelector<HTMLElement>('.admin-health-label')!;
          const misses = cw.misses ?? 0;
          dot.className = `admin-health-dot ${misses > 0 ? 'warn' : 'ok'}`;
          lbl.textContent = misses > 0
            ? Util.t('ui.color_wheel_miss', { count: misses, plural: misses === 1 ? '' : 'es' })
            : Util.t('ui.color_wheel_all_matched');
        }

        const poolChip = document.getElementById('admin-health-pool');
        if (poolChip) {
          const pPool = data.pool || {};
          const dot  = poolChip.querySelector<HTMLElement>('.admin-health-dot');
          const plbl = poolChip.querySelector<HTMLElement>('.admin-health-label');
          if (pPool.error) {
            if (dot) dot.className = 'admin-health-dot warn';
            if (plbl) plbl.textContent = Util.t('ui.pool_unavailable');
          } else {
            const used = (pPool.pool_size ?? 0) - (pPool.pool_available ?? 0);
            const max  = pPool.pool_max || 1;
            const pct  = Math.round(100 * used / max);
            const cls  = pct >= 85 ? 'err' : (pct >= 60 ? 'warn' : 'ok');
            if (dot) dot.className = `admin-health-dot ${cls}`;
            if (plbl) plbl.textContent = `Pool ${used}/${max}`;
          }
        }

        const ldEl = document.getElementById('admin-health-loaded');
        if (ldEl) {
          const lbl = ldEl.querySelector<HTMLElement>('.admin-health-label')!;
          const loadedAt = mem.loaded_at ? new Date(mem.loaded_at) : null;
          lbl.textContent = loadedAt
            ? `Loaded ${AdminCockpit._relTime(loadedAt)}${mem.load_ms != null ? ' · ' + mem.load_ms + 'ms' : ''}`
            : Util.t('ui.not_loaded');
        }
      })
      .catch((e: Error) => {
        const dbEl = document.getElementById('admin-health-db');
        if (dbEl) {
          const dot = dbEl.querySelector<HTMLElement>('.admin-health-dot')!;
          const lbl = dbEl.querySelector<HTMLElement>('.admin-health-label')!;
          dot.className = 'admin-health-dot err';
          lbl.textContent = Util.t('ui.backend_unreachable');
        }
        if (e.name !== 'AbortError') ErrorLog.warn('admin', `Health check failed: ${e.message}`);
      });
  },

  _renderPipeline(): void {
    const wrap = document.getElementById('admin-pipeline');
    if (!wrap) return;

    AdminCockpit._pipelineAbort?.abort();
    AdminCockpit._pipelineAbort = new AbortController();
    const sig = AbortSignal.any
      ? AbortSignal.any([AdminCockpit._pipelineAbort.signal, AbortSignal.timeout(8000)])
      : AdminCockpit._pipelineAbort.signal;
    Util.fetchTraced(`${Config.API_BASE}/diagnostics/deep`, { signal: sig })
      .then((r) => r.json() as Promise<AdminDiagnosticsDeepResponse>)
      .then((data) => {
        AdminCockpit._deepData = data;
        const p = (data.pipeline || {}) as AdminPipelineSnapshot;
        const dbSt = (data.db_stats || {}) as AdminDbStatsDeep;
        const cw = (data.color_wheel || {}) as AdminColorWheelStats;
        const st: AdminPersistenceStats = Persistence.stats ? Persistence.stats() : ({} as AdminPersistenceStats);

        const rendered   = st.rendered ?? 0;
        const rawDb      = p.raw_row_count ?? dbSt.total ?? 0;
        const activePlant = st.plant ?? null;
        // Color-merge stats come from the last /tasks response (per-request,
        // plant-scoped) — not /diagnostics/deep, which holds load-time defaults.
        const colorMiss  = st.color_merge_misses ?? 0;
        // received = rows after both plant filter + color merge (what UI got)
        const received   = st.raw_received ?? 0;
        // Rows entering color merge = post-plant-filter count (= received + misses)
        const preMerge   = st.pre_color_merge_count ?? (received + colorMiss);
        // Rows removed by plant filter = raw - what entered color merge
        const plantFiltered = activePlant ? Math.max(0, rawDb - preMerge) : 0;
        const gap = received - rendered;

        // Pipeline order: DB → [Plant filter if active] → Color Merge → Emitted → Rendered.
        // Reordered (May 2026) so color-miss counts are plant-scoped — the merge
        // now runs *after* the plant filter, against only the rows the user will see.
        const steps: AdminPipelineStep[] = [
          {
            key: 'db',
            label: 'DB Load',
            count: rawDb,
            delta: null,
            status: (p.unreadable_start_date > 0 || p.dropped_no_finish_date > 0) ? 'warn' : 'ok',
            detail: () => AdminCockpit._pipelineDetailDB(p, dbSt),
          },
          ...(activePlant ? [{
            key: 'plant-filter',
            label: `Plant ${activePlant}`,
            count: preMerge,
            delta: plantFiltered > 0 ? `-${plantFiltered} (other plants)` : null,
            status: 'ok' as const,
            detail: () => AdminCockpit._pipelineDetailPlantFilter(st, plantFiltered, rawDb),
          }] : []),
          {
            key: 'color',
            label: 'Color Merge',
            count: received,
            delta: colorMiss > 0 ? `-${colorMiss} miss${colorMiss === 1 ? '' : 'es'}` : null,
            status: colorMiss > 0 ? 'warn' : 'ok',
            detail: () => AdminCockpit._pipelineDetailColor(p, cw, st),
          },
          {
            key: 'emitted',
            label: 'Emitted',
            count: received,
            delta: null,
            status: (p.warnings?.length ?? 0) > 0 ? 'warn' : 'ok',
            detail: () => AdminCockpit._pipelineDetailEmitted(p, st),
          },
          {
            key: 'rendered',
            label: 'Rendered',
            count: rendered,
            delta: gap > 0 ? `-${gap} gap` : null,
            status: gap > 0 ? 'err' : 'ok',
            detail: () => AdminCockpit._pipelineDetailRendered(st, p),
          },
        ];

        wrap.textContent = '';
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

          box.addEventListener('click', () => {
            const detail = document.getElementById('admin-pipeline-detail');
            if (!detail) return;
            if (AdminCockpit._pipelineOpen === s.key) {
              AdminCockpit._pipelineOpen = null;
              detail.classList.remove('open');
              detail.textContent = '';
            } else {
              AdminCockpit._pipelineOpen = s.key;
              detail.classList.add('open');
              detail.textContent = '';
              detail.appendChild(s.detail());
            }
          });

          wrap.appendChild(box);
        });

        // Backend warnings
        AdminCockpit._renderBackendWarnings(p.warnings || []);
      })
      .catch((e: Error) => {
        if (e.name === 'AbortError') return;
        wrap.innerHTML = `<div class="admin-log-empty">Could not load pipeline: ${Util.escapeHtml(e.message)}</div>`;
        ErrorLog.warn('admin', `Pipeline fetch failed: ${e.message}`);
      });
  },

  _pipelineDetailDB(p: AdminPipelineSnapshot, dbSt: AdminDbStatsDeep): DocumentFragment {
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'admin-pdtl-head';
    head.textContent = Util.t('ui.db_load_details');
    frag.appendChild(head);

    const rows: AdminKvRow[] = [
      [Util.t('ui.diag_total_in_db'), (dbSt.total ?? '—').toLocaleString()],
      [Util.t('ui.diag_null_start_date'), dbSt.null_start ?? '—'],
      [Util.t('ui.diag_null_end_date'), dbSt.null_end ?? '—'],
      [Util.t('ui.diag_null_color'), dbSt.null_color ?? '—'],
      [Util.t('ui.diag_null_line'), dbSt.null_line ?? '—'],
      [Util.t('ui.diag_null_desc'), dbSt.null_desc ?? '—'],
      [Util.t('ui.diag_null_runtime'), dbSt.null_runtime ?? '—'],
      [Util.t('ui.diag_date_range_min'), dbSt.date_range?.min?.slice(0, 10) ?? '—'],
      [Util.t('ui.diag_date_range_max'), dbSt.date_range?.max?.slice(0, 10) ?? '—'],
      [Util.t('ui.diag_unreadable_start'), p.unreadable_start_date ?? 0],
      [Util.t('ui.diag_dropped_no_finish'), p.dropped_no_finish_date ?? 0],
      [Util.t('ui.diag_load_time'), p.load_ms != null ? p.load_ms + ' ms' : '—'],
    ];

    if (dbSt.by_line && Object.keys(dbSt.by_line).length) {
      const lbl = document.createElement('div');
      lbl.className = 'admin-pdtl-sub';
      lbl.textContent = Util.t('ui.orders_by_line');
      frag.appendChild(AdminCockpit._kvTable(rows));
      frag.appendChild(lbl);
      frag.appendChild(AdminCockpit._lineBar(dbSt.by_line));
      return frag;
    }

    frag.appendChild(AdminCockpit._kvTable(rows));
    return frag;
  },

  _pipelineDetailColor(p: AdminPipelineSnapshot, cw: AdminColorWheelStats, st: AdminPersistenceStats): DocumentFragment {
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'admin-pdtl-head';
    const scope = st?.plant ? ` (${Util.t('ui.plant_prefix')} ${st.plant})` : '';
    head.textContent = Util.t('ui.color_wheel_details') + scope;
    frag.appendChild(head);

    // Misses are now plant-scoped — pulled from the last /tasks meta via Persistence stats.
    const requestMiss = st?.color_merge_misses ?? 0;
    const requestMissed = st?.missed_colors ?? [];
    const requestMs = st?.backend_meta?.color_merge_ms as number | undefined;

    const rows: AdminKvRow[] = [
      [Util.t('ui.diag_scope'), st?.plant ? `${Util.t('ui.plant_prefix')} ${st.plant} only` : Util.t('ui.all_plants')],
      [Util.t('ui.diag_rows_entering_merge'), st?.pre_color_merge_count ?? '—'],
      [Util.t('ui.diag_global_wheel_colors'), cw.wheel_total ?? '—'],
      [Util.t('ui.diag_matched_rows'), (st?.pre_color_merge_count ?? 0) - requestMiss],
      [Util.t('ui.diag_missed_rows'), requestMiss],
      [Util.t('ui.diag_merge_time'), requestMs != null ? requestMs + ' ms' : '—'],
    ];
    frag.appendChild(AdminCockpit._kvTable(rows));

    if (requestMissed.length) {
      const sub = document.createElement('div');
      sub.className = 'admin-pdtl-sub';
      sub.textContent = Util.t('ui.unmatched_colors', { count: requestMissed.length });
      frag.appendChild(sub);
      const chips = document.createElement('div');
      chips.className = 'admin-pdtl-chips';
      for (const c of requestMissed) {
        const chip = document.createElement('span');
        chip.className = 'admin-pdtl-chip warn';
        chip.textContent = c;
        chips.appendChild(chip);
      }
      frag.appendChild(chips);
    } else {
      const ok = document.createElement('div');
      ok.className = 'admin-pdtl-ok';
      ok.textContent = Util.t('empty.no_colors_matched');
      frag.appendChild(ok);
    }
    return frag;
  },

  _pipelineDetailEmitted(p: AdminPipelineSnapshot, st: AdminPersistenceStats): DocumentFragment {
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'admin-pdtl-head';
    head.textContent = Util.t('ui.emitted_details');
    frag.appendChild(head);

    const scopeLbl = st?.plant ? `${Util.t('ui.plant_prefix')} ${st.plant}` : Util.t('ui.all_plants');
    const rows: AdminKvRow[] = [
      [Util.t('ui.diag_raw_from_db'), p.raw_row_count ?? '—'],
      [Util.t('ui.diag_unreadable_start'), p.unreadable_start_date ?? 0],
      [Util.t('ui.diag_dropped_no_finish'), p.dropped_no_finish_date ?? 0],
      [Util.t('ui.diag_active_scope'), scopeLbl],
      [Util.t('ui.diag_rows_entering_cmerge'), st?.pre_color_merge_count ?? '—'],
      [Util.t('ui.diag_color_merge_misses'), st?.color_merge_misses ?? 0],
      [Util.t('ui.diag_emitted'), st?.raw_received ?? '—'],
      [Util.t('ui.diag_unique_ids'), p.unique_id_count ?? '—'],
      [Util.t('ui.diag_loaded_at'), p.loaded_at ? p.loaded_at.replace('T', ' ').slice(0, 19) + ' UTC' : '—'],
    ];
    frag.appendChild(AdminCockpit._kvTable(rows));

    const warnings = p.warnings || [];
    if (warnings.length) {
      const sub = document.createElement('div');
      sub.className = 'admin-pdtl-sub';
      sub.textContent = Util.t('ui.diag_backend_load_warnings', { count: warnings.length });
      frag.appendChild(sub);
      frag.appendChild(AdminCockpit._warningList(warnings));
    }
    return frag;
  },

  _pipelineDetailPlantFilter(st: AdminPersistenceStats, plantFiltered: number, rawDb: number): DocumentFragment {
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'admin-pdtl-head';
    head.textContent = Util.t('ui.plant_filter_details');
    frag.appendChild(head);

    // Pipeline order is now: DB → Plant filter → Color merge → Emitted.
    // The pre-merge count here is what reaches the color merge stage.
    const preMerge = st?.pre_color_merge_count ?? 0;
    const rows: AdminKvRow[] = [
      [Util.t('ui.diag_active_plant'), st.plant ?? '—'],
      [Util.t('ui.diag_raw_rows_from_db'), rawDb ?? '—'],
      [Util.t('ui.diag_rows_this_plant'), preMerge],
      [Util.t('ui.diag_other_plant_excluded'), plantFiltered],
      [Util.t('ui.diag_final_emitted'), st.raw_received ?? '—'],
    ];
    frag.appendChild(AdminCockpit._kvTable(rows));
    return frag;
  },

  _pipelineDetailRendered(st: AdminPersistenceStats, p: AdminPipelineSnapshot): DocumentFragment {
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'admin-pdtl-head';
    head.textContent = Util.t('ui.rendering_details');
    frag.appendChild(head);

    // Gap is measured from received (post-plant-filter) so plant filtering does not
    // look like data loss here.
    const received = st.raw_received ?? 0;
    const rendered = st.rendered ?? 0;
    const gap = received - rendered;
    const rows: AdminKvRow[] = [
      [Util.t('ui.diag_received_by_ui'), received],
      [Util.t('ui.diag_pl_filtered'), st.filtered_pl ?? 0],
      [Util.t('ui.diag_null_id_dropped'), st.filtered_null_id ?? 0],
      [Util.t('ui.diag_store_collisions'), st.dedup_collisions ?? 0],
      [Util.t('ui.diag_rendered'), rendered],
      [Util.t('ui.diag_gap'), gap],
      [Util.t('ui.diag_source'), st.source ?? '—'],
    ];
    frag.appendChild(AdminCockpit._kvTable(rows));

    if (gap > 0) {
      const warn = document.createElement('div');
      warn.className = 'admin-pdtl-warn';
      warn.textContent = Util.t('ui.data_gap_warn', { count: gap });
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

  _lineBar(byLine: Record<string, number>): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'admin-pdtl-linebars';
    const max = Math.max(...Object.values(byLine));
    for (const [line, cnt] of Object.entries(byLine)) {
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
    }
    return wrap;
  },

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

    for (const w of warnings) {
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
      ts.textContent = w.ts ? w.ts.replace('T', ' ').slice(0, 19) + ' UTC' : '';
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
    }
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
        dateFormat: 'Y-m-d', altInput: true, altFormat: 'M j, Y',
        onChange: () => AdminCockpit._updatePurgeCount(),
      });
      AdminCockpit._fpPurgeEnd = flatpickr('#admin-purge-end', {
        dateFormat: 'Y-m-d', altInput: true, altFormat: 'M j, Y',
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
          AdminCockpit._renderHealth();
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
          AdminCockpit._renderHealth();
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

  /* FE↔BE correlation: clicking a reqId pins it as a filter on BOTH panes and
     refreshes them so the operator sees the matching frontend + backend events. */
  _correlateReqId(reqId: string | undefined): void {
    if (!reqId) return;
    AdminCockpit._logFilter.reqId        = reqId;
    AdminCockpit._backendLogFilter.reqId = reqId;
    AdminCockpit._renderLogs();
    AdminCockpit._renderBackendLog();
  },

  /* Render (or clear) a small "filtering by request <id>" chip at the top of a
     log list. `onClear` removes the filter. Self-contained: builds the chip if
     a reqId is set, removes any prior chip otherwise. */
  _renderReqIdChip(listId: string, reqId: string, onClear: () => void): void {
    const list = document.getElementById(listId);
    if (!list || !list.parentElement) return;
    const chipId = `${listId}-reqid-chip`;
    let chip = document.getElementById(chipId);
    if (!reqId) { if (chip) chip.remove(); return; }
    if (!chip) {
      chip = document.createElement('div');
      chip.id = chipId;
      chip.className = 'admin-log-reqid-chip';
      list.parentElement.insertBefore(chip, list);
    }
    chip.textContent = '';
    const label = document.createElement('span');
    label.textContent = `req ${String(reqId).slice(0, 8)}…`;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'admin-log-reqid-chip-x';
    x.textContent = '✕';
    x.title = 'Clear request filter';
    x.addEventListener('click', () => { onClear(); });
    chip.appendChild(document.createTextNode('Filtering: '));
    chip.appendChild(label);
    chip.appendChild(x);
  },

  _getFilteredEntries(): AdminFrontendLogEntry[] {
    const { level, scope, search, errorCode, reqId } = AdminCockpit._logFilter;
    return ErrorLog.entries().filter(e => {
      if (level !== 'all' && e.level !== level) return false;
      if (scope !== 'all' && e.scope !== scope) return false;
      if (errorCode && errorCode !== 'all' && e.errorCode !== errorCode) return false;
      if (reqId && e.reqId !== reqId) return false;
      if (search) {
        const haystack = `${e.scope} ${e.msg} ${e.ts} ${e.errorCode || ''} ${e.reqId || ''}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  },

  /* -----------------------------------------------------------------------
     DB DEEP DIVE — fetches /diagnostics/db on demand, renders sections
     ----------------------------------------------------------------------- */
  _renderDbDeep(): void {
    const wrap = document.getElementById('admin-db-deep');
    if (!wrap) return;
    wrap.innerHTML = `<div class="admin-db-loading">${Util.t('ui.diag_loading')}</div>`;

    AdminCockpit._dbDeepAbort?.abort();
    AdminCockpit._dbDeepAbort = new AbortController();
    const sig = AbortSignal.any
      ? AbortSignal.any([AdminCockpit._dbDeepAbort.signal, AbortSignal.timeout(12000)])
      : AdminCockpit._dbDeepAbort.signal;

    Util.fetchTraced(`${Config.API_BASE}/diagnostics/db`, { signal: sig })
      .then(r => r.json() as Promise<AdminDbDeepResponse>)
      .then(d => {
        wrap.textContent = '';

        // ── Top: summary tiles strip ──────────────────────────────────────────────
        AdminCockpit._dbSummaryStrip(d, wrap);

        if (d.fetched_at) {
          const tsEl = document.createElement('div');
          tsEl.className = 'admin-db-fetched';
          tsEl.textContent = Util.t('ui.diag_last_refreshed', { time: AdminCockpit._relTime(new Date(d.fetched_at)) });
          wrap.appendChild(tsEl);
        }

        const mkSection = (title: string, statusCls: string, buildFn: (body: HTMLDivElement) => void, openByDefault: boolean, helpText?: string): void => {
          const det = document.createElement('details');
          det.className = 'admin-db-section';
          if (openByDefault) det.open = true;
          const sum = document.createElement('summary');
          sum.className = 'admin-db-section-sum';
          const dot = document.createElement('span');
          dot.className = `admin-health-dot ${statusCls}`;
          const ttl = document.createElement('span');
          ttl.className = 'admin-db-section-title';
          ttl.textContent = title;
          sum.appendChild(dot);
          sum.appendChild(ttl);
          if (helpText) {
            const hEl = document.createElement('span');
            hEl.className = 'adm-help';
            hEl.tabIndex = 0;
            hEl.setAttribute('aria-label', Util.t('aria.help'));
            hEl.addEventListener('click', (e: Event) => e.stopPropagation());
            const hDot = document.createElement('span');
            hDot.className = 'adm-help-dot';
            hDot.textContent = '?';
            const hTip = document.createElement('span');
            hTip.className = 'adm-help-tip';
            hTip.textContent = helpText;
            hEl.appendChild(hDot);
            hEl.appendChild(hTip);
            sum.appendChild(hEl);
          }
          det.appendChild(sum);
          const body = document.createElement('div');
          body.className = 'admin-db-section-body';
          buildFn(body);
          det.appendChild(body);
          wrap.appendChild(det);
        };

        // ── 1. Connection Pool
        const pool = d.pool || ({} as AdminPoolStats);
        const poolUsed = (pool.pool_size ?? 0) - (pool.pool_available ?? 0);
        const poolMax  = pool.pool_max || 1;
        const poolSt   = pool.error ? 'err' : ((pool.requests_waiting ?? 0) > 0 || (pool.requests_errors ?? 0) > 0 ? 'warn' : 'ok');
        mkSection(Util.t('ui.diag_section_pool'), poolSt, (body) => {
          if (pool.error) { body.textContent = pool.error; return; }
          body.appendChild(AdminCockpit._dbFillBar(poolUsed, poolMax, Util.t('ui.diag_pool_utilization')));
          body.appendChild(AdminCockpit._kvTable([
            [Util.t('ui.diag_pool_min_max'),         `${pool.pool_min ?? '—'} / ${pool.pool_max ?? '—'}`],
            [Util.t('ui.diag_pool_in_use'),           `${poolUsed} / ${pool.pool_available ?? '—'}`],
            [Util.t('ui.diag_requests_waiting'),      pool.requests_waiting ?? 0],
            [Util.t('ui.diag_requests_completed'),    (pool.requests_completed ?? 0).toLocaleString()],
            [Util.t('ui.diag_request_errors'),        pool.requests_errors ?? 0],
            [Util.t('ui.diag_bad_returns'),           pool.returns_bad ?? 0],
          ]));
          if ((pool.requests_waiting ?? 0) > 0)
            AdminCockpit._dbWarnBanner(body, Util.t('ui.diag_pool_queued', { count: pool.requests_waiting ?? 0 }));
          if ((pool.requests_errors ?? 0) > 0)
            AdminCockpit._dbWarnBanner(body, Util.t('ui.diag_pool_errors', { count: pool.requests_errors ?? 0 }), true);
        }, true, Util.t('ui.diag_desc_pool'));

        // ── 2. Server Info
        const srv = d.server || ({} as AdminServerInfo);
        mkSection(Util.t('ui.diag_section_server'), srv.error ? 'err' : 'ok', (body) => {
          if (srv.error) { body.textContent = srv.error; return; }
          body.appendChild(AdminCockpit._kvTable([
            [Util.t('ui.diag_database'),        srv.database ?? '—'],
            [Util.t('ui.diag_database_size'),   srv.db_size   ?? '—'],
            [Util.t('ui.diag_max_connections'), srv.max_connections ?? '—'],
            [Util.t('ui.diag_up_since'),        srv.started_at ? AdminCockpit._relTime(new Date(srv.started_at)) : '—'],
            [Util.t('ui.diag_version'),         (srv.version || '').split(' (')[0]],
          ]));
        }, true, Util.t('ui.diag_desc_server'));

        // ── 3. Table Health
        const tablesRaw: AdminTableStat[] = Array.isArray(d.tables) ? d.tables : [];
        const tableErr = _adminListError(tablesRaw);
        const tables = _adminListRows(tablesRaw);
        const tablesNeedWork = !tableErr && tables.some((t) => t.needs_vacuum || t.needs_analyze);
        mkSection(Util.t('ui.diag_section_table_health', { count: tableErr ? '?' : tables.length }),
            tableErr ? 'err' : (tablesNeedWork ? 'warn' : 'ok'), (body) => {
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
          body.appendChild(AdminCockpit._dbTableCards(tables));
        }, false, Util.t('ui.diag_desc_table_health'));

        // ── 4. Active Connections
        const conn = d.connections || ({} as AdminConnectionActivity);
        const hasLong = (conn.long_running || []).length > 0;
        mkSection(Util.t('ui.diag_section_connections', { count: conn.total ?? '?' }),
            conn.error ? 'err' : (hasLong ? 'warn' : 'ok'), (body) => {
          if (conn.error) { body.textContent = conn.error; return; }
          body.appendChild(AdminCockpit._dbStackBar(conn.by_state || {}));
          if (hasLong) {
            const sub = document.createElement('div');
            sub.className = 'admin-pdtl-sub';
            sub.textContent = Util.t('ui.non_idle_queries');
            body.appendChild(sub);
            body.appendChild(AdminCockpit._dbTable(
              ['PID', 'State', 'Dur (s)', 'Wait event', 'Query'],
              (conn.long_running || []).map((q): AdminDbTableRow => ({
                cells: [q.pid, q.state || '—', q.duration_s ?? '—', q.wait_event || '—', (q.query || '').slice(0, 120)],
                rowWarn: (q.duration_s || 0) > 30,
                cellWarn: [],
              }))
            ));
          }
        }, false, Util.t('ui.diag_desc_connections'));

        // ── 5. Lock Waits
        const locksRaw: AdminLockWait[] = Array.isArray(d.locks) ? d.locks : [];
        const lockErr = _adminListError(locksRaw);
        const locks = _adminListRows(locksRaw);
        const activeLocks = !lockErr && locks.length > 0;
        mkSection(Util.t('ui.diag_section_lock_waits', { count: lockErr ? '?' : locks.length }),
            lockErr ? 'err' : (activeLocks ? 'err' : 'ok'), (body) => {
          if (lockErr) { body.textContent = lockErr; return; }
          if (!activeLocks) {
            const ok = document.createElement('div');
            ok.className = 'admin-db-ok-msg';
            ok.textContent = Util.t('empty.no_lock_contention');
            body.appendChild(ok);
            return;
          }
          AdminCockpit._dbWarnBanner(body, Util.t('ui.diag_blocking_locks', { count: locks.length }), true);
          body.appendChild(AdminCockpit._dbLockChain(locks));
        }, false, Util.t('ui.diag_desc_lock_waits'));

        // ── 6. Index Usage
        const indexesRaw: AdminIndexUsage[] = Array.isArray(d.indexes) ? d.indexes : [];
        const idxErr = _adminListError(indexesRaw);
        const indexes = _adminListRows(indexesRaw);
        const unusedCount = !idxErr ? indexes.filter((ix) => ix.unused).length : 0;
        mkSection(unusedCount
            ? Util.t('ui.diag_section_index_unused', { count: idxErr ? '?' : indexes.length, unused: unusedCount })
            : Util.t('ui.diag_section_index_usage', { count: idxErr ? '?' : indexes.length }),
            idxErr ? 'err' : (unusedCount > 0 ? 'warn' : 'ok'), (body) => {
          if (idxErr) { body.textContent = idxErr; return; }
          if (!indexes.length) { body.textContent = Util.t('empty.no_indexes'); return; }
          if (unusedCount > 0)
            AdminCockpit._dbWarnBanner(body, Util.t('ui.diag_unused_indexes_warn', { count: unusedCount }));
          body.appendChild(AdminCockpit._dbHBarChart(indexes));
        }, false, Util.t('ui.diag_desc_index_usage'));

        // ── 7. Slow Queries
        const sq = d.slow_queries || ({} as AdminSlowQueriesResult);
        mkSection(Util.t('ui.diag_section_slow_queries'),
            !sq.available ? 'warn' : ((sq.queries || []).length ? 'warn' : 'ok'), (body) => {
          if (!sq.available) {
            const msg = document.createElement('div');
            msg.className = 'admin-db-na-msg';
            msg.textContent = sq.error
              ? `Error: ${sq.error}`
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
          body.appendChild(AdminCockpit._dbSlowQueryBars(sq.queries));
        }, false, Util.t('ui.diag_desc_slow_queries'));

        // ── 8. Sequences
        const seqsRaw: AdminSequenceHealth[] = Array.isArray(d.sequences) ? d.sequences : [];
        const seqErr = _adminListError(seqsRaw);
        const seqs = _adminListRows(seqsRaw);
        const seqIssues = !seqErr ? seqs.filter((s) => s.status !== 'ok').length : 0;
        mkSection(Util.t('ui.diag_section_sequences', { count: seqErr ? '?' : seqs.length }),
            seqErr ? 'err' : (seqIssues > 0 ? 'warn' : 'ok'), (body) => {
          if (seqErr) { body.textContent = seqErr; return; }
          if (!seqs.length) { body.textContent = Util.t('empty.no_sequences'); return; }
          body.appendChild(AdminCockpit._dbProgressBars(seqs));
        }, false, Util.t('ui.diag_desc_sequences'));
      })
      .catch((e: Error) => {
        if (e.name === 'AbortError') return;
        wrap.textContent = '';
        const err = document.createElement('div');
        err.className = 'admin-db-error';
        err.textContent = Util.t('ui.failed_load_db_diag', { error: e.message });
        wrap.appendChild(err);
        ErrorLog.warn('admin', `DB deep dive failed: ${e.message}`);
      });
  },

  /* -----------------------------------------------------------------------
     DB visual helpers
     ----------------------------------------------------------------------- */

  _dbSummaryStrip(d: AdminDbDeepResponse, wrap: HTMLElement): void {
    const strip = document.createElement('div');
    strip.className = 'admin-db-summary';
    const mkTile = (label: string, num: string, sub: string, status: string, extra: HTMLElement | null): HTMLDivElement => {
      const tile = document.createElement('div');
      tile.className = `admin-db-stat-tile ${status}`;
      const top = document.createElement('div');
      top.className = 'admin-db-stat-tile-top';
      const dot = document.createElement('span');
      dot.className = `admin-health-dot ${status}`;
      const lbl = document.createElement('span');
      lbl.className = 'admin-db-stat-tile-lbl';
      lbl.textContent = label;
      top.appendChild(dot); top.appendChild(lbl);
      tile.appendChild(top);
      const numEl = document.createElement('div');
      numEl.className = 'admin-db-stat-tile-num';
      numEl.innerHTML = num;
      tile.appendChild(numEl);
      if (extra) tile.appendChild(extra);
      if (sub) {
        const subEl = document.createElement('div');
        subEl.className = 'admin-db-stat-tile-sub';
        subEl.textContent = sub;
        tile.appendChild(subEl);
      }
      return tile;
    };
    const pool = d.pool || ({} as AdminPoolStats);
    const poolUsed = (pool.pool_size ?? 0) - (pool.pool_available ?? 0);
    const poolMax  = pool.pool_max || 1;
    const poolPct  = Math.round(100 * poolUsed / poolMax);
    const poolSt   = pool.error ? 'err' : (poolPct >= 85 || (pool.requests_waiting ?? 0) > 0 ? 'warn' : 'ok');
    strip.appendChild(mkTile(Util.t('ui.diag_tile_pool'),
      `${poolUsed}<span style="font-size:14px;font-weight:400;color:var(--fg-mute)">/${poolMax}</span>`,
      Util.t('ui.diag_tile_pct_utilized', {pct: poolPct}), poolSt,
      pool.error ? null : AdminCockpit._dbFillBar(poolUsed, poolMax, null)));
    const conn = d.connections || ({} as AdminConnectionActivity);
    const activeConn = (conn.by_state || {})['active'] ?? 0;
    strip.appendChild(mkTile(Util.t('ui.diag_tile_sessions'), String(conn.total ?? '—'), Util.t('ui.diag_tile_active', {count: activeConn}),
      conn.error ? 'err' : ((conn.long_running || []).length > 0 ? 'warn' : 'ok'), null));
    const locks = _adminListRows<AdminLockWaitData>(Array.isArray(d.locks) ? d.locks : []);
    strip.appendChild(mkTile(Util.t('ui.diag_tile_lock_waits'),
      locks.length > 0 ? `<span style="color:var(--err)">${locks.length}</span>` : '0',
      locks.length > 0 ? Util.t('ui.diag_tile_contention') : Util.t('ui.diag_tile_clear'),
      locks.length > 0 ? 'err' : 'ok', null));
    const tables = _adminListRows<AdminTableStatData>(Array.isArray(d.tables) ? d.tables : []);
    const tblIssues = tables.filter((t) => t.needs_vacuum || t.needs_analyze).length;
    strip.appendChild(mkTile(Util.t('ui.diag_tile_table_issues'),
      tblIssues > 0 ? `<span style="color:var(--warn)">${tblIssues}</span>` : '0',
      tblIssues > 0 ? Util.t('ui.diag_tables_need_work', {total: tables.length, issues: tblIssues}) : Util.t('ui.diag_tables_healthy', {count: tables.length}),
      tblIssues > 0 ? 'warn' : 'ok', null));
    const sq = d.slow_queries || ({} as AdminSlowQueriesResult);
    let sqNum = '—', sqSub = Util.t('ui.diag_not_tracked'), sqSt = 'warn';
    if (sq.available && (sq.queries || []).length) {
      const top = sq.queries[0];
      sqNum = `${top.mean_ms}<span style="font-size:12px;font-weight:400;color:var(--fg-mute)">ms</span>`;
      sqSub = Util.t('ui.diag_avg_calls', {calls: top.calls.toLocaleString()});
      sqSt  = top.mean_ms > 500 ? 'err' : (top.mean_ms > 100 ? 'warn' : 'ok');
    } else if (sq.available) {
      sqNum = '0'; sqSub = Util.t('ui.diag_no_queries'); sqSt = 'ok';
    }
    strip.appendChild(mkTile(Util.t('ui.diag_tile_slowest_query'), sqNum, sqSub, sqSt, null));
    wrap.appendChild(strip);
  },

  _dbFillBar(used: number, max: number, label: string | null): HTMLDivElement {
    const pct = max > 0 ? Math.min(100, Math.round(100 * used / max)) : 0;
    const cls = pct >= 85 ? 'err' : (pct >= 60 ? 'warn' : 'ok');
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
    for (const tbl of tables) {
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
      vaBtn.textContent = 'VACUUM ANALYZE';
      const aBtn = document.createElement('button');
      aBtn.className = `db-maint-btn${urgentA ? ' db-maint-btn--urgent' : ''}`;
      aBtn.dataset.maintAction = 'analyze';
      aBtn.dataset.maintTable = tbl.table;
      aBtn.textContent = 'ANALYZE';
      actions.appendChild(vaBtn);
      actions.appendChild(aBtn);
      card.appendChild(actions);

      wrap.appendChild(card);
    }
    return wrap;
  },

  _dbHBarChart(indexes: AdminIndexUsageData[]): HTMLDivElement {
    const maxScans = Math.max(...indexes.map((ix) => ix.scans ?? 0), 1);
    const wrap = document.createElement('div');
    wrap.className = 'admin-db-hbar-chart';
    for (const ix of indexes) {
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
    }
    return wrap;
  },

  _dbSlowQueryBars(queries: AdminSlowQuery[]): HTMLDivElement {
    const maxMs = Math.max(...queries.map((q) => q.mean_ms ?? 0), 1);
    const wrap = document.createElement('div');
    wrap.className = 'admin-db-hbar-chart';
    for (const q of queries) {
      const pct = Math.max(1, Math.round(100 * (q.mean_ms ?? 0) / maxMs));
      const cls = (q.mean_ms ?? 0) > 500 ? 'err' : ((q.mean_ms ?? 0) > 100 ? 'warn' : '');
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
      callChip.textContent = `${q.calls.toLocaleString()} calls`;
      row.appendChild(names); row.appendChild(track); row.appendChild(val); row.appendChild(callChip);
      wrap.appendChild(row);
    }
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
      chain.appendChild(mkNode(lk.blocking_pid, 'BLOCKING', lk.blocking_query, 'blocking'));
      const arrow = document.createElement('div');
      arrow.className = 'admin-db-lock-arrow';
      arrow.innerHTML = `<span class="admin-db-lock-type">${Util.escapeHtml(lk.lock_type || '')}</span> ▼`;
      chain.appendChild(arrow);
      chain.appendChild(mkNode(lk.blocked_pid, `BLOCKED ${lk.blocked_for_s}s`, lk.blocked_query, 'blocked'));
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

  /* -----------------------------------------------------------------------
     BACKEND EVENT LOG — fetches /logs/backend, renders like the front-end log
     ----------------------------------------------------------------------- */
  _renderBackendLog(): void {
    const host = document.getElementById('admin-backend-log-list');
    const countEl = document.getElementById('admin-backend-log-count');
    if (!host) return;
    host.innerHTML = `<div class="admin-log-empty">${Util.t('ui.loading')}</div>`;

    AdminCockpit._backendLogAbort?.abort();
    AdminCockpit._backendLogAbort = new AbortController();
    const sig = AbortSignal.any
      ? AbortSignal.any([AdminCockpit._backendLogAbort.signal, AbortSignal.timeout(8000)])
      : AdminCockpit._backendLogAbort.signal;

    const bf = AdminCockpit._backendLogFilter || {};
    // Lazily inject a free-text query input beside the level select (markup is in
    // index.html which we don't own). Drives the server-side ?q= filter.
    const lvlSel = document.getElementById('admin-backend-log-filter-level');
    if (lvlSel && lvlSel.parentElement && !document.getElementById('admin-backend-log-q')) {
      const qIn = document.createElement('input');
      qIn.id = 'admin-backend-log-q';
      qIn.type = 'search';
      qIn.className = 'input';
      qIn.placeholder = 'Filter backend (msg / code / category)';
      qIn.title = 'Server-side free-text filter';
      qIn.addEventListener('input', Util.debounce((ev: Event) => {
        AdminCockpit._backendLogFilter.q = (ev.target as HTMLInputElement).value.trim();
        AdminCockpit._renderBackendLog();
      }, 350));
      lvlSel.insertAdjacentElement('afterend', qIn);
    }
    const lvl = bf.level || 'all';
    const qp = [`limit=200`];
    if (lvl !== 'all')                  qp.push('level='    + encodeURIComponent(lvl));
    if (bf.category && bf.category !== 'all') qp.push('category=' + encodeURIComponent(bf.category));
    if (bf.since)                       qp.push('since='    + encodeURIComponent(bf.since));
    if (bf.q)                           qp.push('q='        + encodeURIComponent(bf.q));
    const params = `?${qp.join('&')}`;
    const reqIdFilter = bf.reqId || '';

    // Reqid-correlation chip on the backend pane.
    AdminCockpit._renderReqIdChip('admin-backend-log-list', reqIdFilter, () => {
      AdminCockpit._backendLogFilter.reqId = '';
      AdminCockpit._renderBackendLog();
    });

    Util.fetchTraced(`${Config.API_BASE}/logs/backend${params}`, { signal: sig })
      .then((r) => r.json() as Promise<BackendLogResponse>)
      .then(({ entries: rawEntries, total, dropped }) => {
        host.textContent = '';
        // Client-side reqId correlation filter (server filters category/since/q/level).
        let entries = rawEntries || [];
        if (reqIdFilter) entries = entries.filter((e) => e.rid === reqIdFilter);
        if (countEl) countEl.textContent = Util.t('ui.backend_log_count', { total, shown: entries.length });

        // Overflow marker if the backend reports a dropped count.
        if (dropped && dropped > 0) {
          const ov = document.createElement('div');
          ov.className = 'admin-log-older';
          ov.textContent = `${dropped} older backend entr${dropped === 1 ? 'y' : 'ies'} dropped`;
          host.appendChild(ov);
        }

        if (!entries.length) {
          const empty = document.createElement('div');
          empty.className = 'admin-log-empty';
          empty.textContent = lvl !== 'all' ? Util.t('ui.diag_no_level_events', {level: lvl}) : Util.t('empty.no_backend_events');
          host.appendChild(empty);
          return;
        }

        for (const e of entries) {
          const row = document.createElement('div');
          row.className = `admin-log-row admin-log-${e.level || 'info'}`;

          const head = document.createElement('div');
          head.className = 'admin-log-head';

          const lvlEl = document.createElement('span');
          lvlEl.className = 'admin-log-lvl';
          lvlEl.textContent = (e.level || 'info').toUpperCase();

          const tsEl = document.createElement('span');
          tsEl.className = 'admin-log-ts';
          const d = e.ts ? new Date(e.ts) : null;
          tsEl.textContent = d ? AdminCockpit._relTime(d) : '';
          tsEl.title = e.ts || '';

          const scopeEl = document.createElement('span');
          scopeEl.className = 'admin-log-scope';
          scopeEl.textContent = e.category || '';

          head.appendChild(lvlEl);
          head.appendChild(tsEl);
          head.appendChild(scopeEl);
          if (e.source === 'frontend') {
            const src = document.createElement('span');
            src.className = 'admin-log-src';
            src.textContent = 'FE';
            src.title = 'Forwarded from a frontend client';
            head.appendChild(src);
          }
          const code = e.error_code;
          if (code) {
            const codeEl = document.createElement('span');
            codeEl.className = 'admin-log-code';
            codeEl.textContent = code;
            codeEl.title = 'Filter by this error code';
            codeEl.addEventListener('click', ev => {
              ev.stopPropagation();
              AdminCockpit._backendLogFilter.q = code;
              AdminCockpit._renderBackendLog();
            });
            head.appendChild(codeEl);
          }
          const rid = e.rid;
          if (rid) {
            const ridEl = document.createElement('span');
            ridEl.className = 'admin-log-reqid';
            ridEl.textContent = `req ${String(rid).slice(0, 8)}`;
            ridEl.title = `Correlate request ${rid} across the frontend log`;
            ridEl.addEventListener('click', ev => {
              ev.stopPropagation();
              AdminCockpit._correlateReqId(rid);
            });
            head.appendChild(ridEl);
          }
          if (e.error_type) {
            const typeEl = document.createElement('span');
            typeEl.className = 'admin-log-etype';
            typeEl.textContent = e.error_type;
            head.appendChild(typeEl);
          }
          row.appendChild(head);

          const msg = document.createElement('div');
          msg.className = 'admin-log-msg';
          msg.textContent = e.msg || '';
          row.appendChild(msg);

          const hasCtx = !!(e.ctx && Object.keys(e.ctx).length);
          if (hasCtx) {
            const pre = document.createElement('pre');
            pre.className = 'admin-log-ctx';
            pre.textContent = JSON.stringify(e.ctx, null, 2);
            row.appendChild(pre);
          }
          if (e.exc) {
            const excPre = document.createElement('pre');
            excPre.className = 'admin-log-ctx admin-log-exc';
            excPre.textContent = e.exc;
            row.appendChild(excPre);

            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'admin-log-copy';
            copyBtn.textContent = Util.t('ui.log_copy');
            copyBtn.title = Util.t('ui.log_copy_title');
            copyBtn.addEventListener('click', ev => {
              ev.stopPropagation();
              const text = [e.rid ? `rid: ${e.rid}` : '', e.msg || '', e.exc].filter(Boolean).join('\n');
              void navigator.clipboard?.writeText(text).then(() => {
                copyBtn.textContent = Util.t('ui.log_copied');
                setTimeout(() => { copyBtn.textContent = Util.t('ui.log_copy'); }, 1500);
              }, () => { /* clipboard unavailable: leave the button as is */ });
            });
            row.appendChild(copyBtn);
          }
          if (hasCtx || e.exc) {
            row.style.cursor = 'pointer';
            row.addEventListener('click', () => row.classList.toggle('expanded'));
          }

          host.appendChild(row);
        }
      })
      .catch((e: Error) => {
        host.textContent = '';
        const err = document.createElement('div');
        err.className = 'admin-log-empty';
        err.textContent = Util.t('ui.failed_load_backend_log', { error: e.message });
        host.appendChild(err);
      });
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
      AdminCockpit._renderBackendLog();
    } catch (e) {
      Toast.show(Util.t('toast.backend_log_clear_failed', { msg: (e as Error).message }), 'error');
    }
  },

  _copyFiltered(): void {
    const entries = AdminCockpit._getFilteredEntries();
    const txt = entries.map((e) =>
      `${e.ts} [${e.level.toUpperCase()}] ${e.scope}: ${e.msg}${e.ctx ? ' :: ' + JSON.stringify(e.ctx) : ''}`
    ).join('\n');
    navigator.clipboard?.writeText(txt).then(
      () => Toast.show(Util.t('toast.copied_filtered', { count: entries.length }), 'success'),
      () => Toast.show(Util.t('toast.copy_failed'), 'error')
    );
  },

  _renderLogs(): void {
    const list = document.getElementById('admin-log-list');
    if (!list) return;

    // Rebuild scope filter options
    const allEntries = ErrorLog.entries();
    const scopeEl = document.getElementById('admin-log-filter-scope') as HTMLSelectElement | null;
    if (scopeEl) {
      const currentScope = AdminCockpit._logFilter.scope;
      const scopes = [...new Set(allEntries.map(e => e.scope).filter(Boolean))].sort();
      scopeEl.textContent = '';
      const allOpt = document.createElement('option');
      allOpt.value = 'all';
      allOpt.textContent = Util.t('ui.all_scopes');
      scopeEl.appendChild(allOpt);
      for (const s of scopes) {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        if (s === currentScope) opt.selected = true;
        scopeEl.appendChild(opt);
      }
      // Lazily inject an errorCode filter select beside the scope select (the
      // markup lives in index.html which we don't own — build it on demand).
      let codeEl = document.getElementById('admin-log-filter-code') as HTMLSelectElement | null;
      if (!codeEl && scopeEl.parentElement) {
        codeEl = document.createElement('select');
        codeEl.id = 'admin-log-filter-code';
        codeEl.className = scopeEl.className || '';
        codeEl.title = 'Filter by error code';
        codeEl.addEventListener('change', (ev: Event) => {
          AdminCockpit._logFilter.errorCode = (ev.target as HTMLSelectElement).value;
          AdminCockpit._renderLogs();
        });
        scopeEl.insertAdjacentElement('afterend', codeEl);
      }
      if (codeEl) {
        const curCode = AdminCockpit._logFilter.errorCode;
        const codes = [...new Set(allEntries.map(e => e.errorCode).filter((c): c is string => Boolean(c)))].sort();
        codeEl.textContent = '';
        const cAll = document.createElement('option');
        cAll.value = 'all'; cAll.textContent = 'All codes';
        codeEl.appendChild(cAll);
        for (const c of codes) {
          const opt = document.createElement('option');
          opt.value = c; opt.textContent = c;
          if (c === curCode) opt.selected = true;
          codeEl.appendChild(opt);
        }
      }
    }

    // Active reqId-correlation chip (set by clicking a reqId in either pane).
    AdminCockpit._renderReqIdChip('admin-log-list', AdminCockpit._logFilter.reqId, () => {
      AdminCockpit._logFilter.reqId = '';
      AdminCockpit._renderLogs();
    });

    const filtered = AdminCockpit._getFilteredEntries();
    const visible = filtered.slice().reverse();

    list.textContent = '';

    // Overflow marker — N entries evicted past MAX since last clear.
    const dropped = ErrorLog.droppedCount();
    if (dropped > 0) {
      const ov = document.createElement('div');
      ov.className = 'admin-log-older';
      ov.textContent = `${dropped} older entr${dropped === 1 ? 'y' : 'ies'} dropped (ring at ${ErrorLog.MAX})`;
      list.appendChild(ov);
    }

    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'admin-log-empty';
      empty.textContent = filtered.length === 0 && allEntries.length > 0
        ? Util.t('empty.no_entries_filter')
        : Util.t('empty.no_log_entries');
      list.appendChild(empty);
    }

    const SCOPE_COLORS: Record<string, string> = {
      persistence: 'var(--info,#3498db)',
      engine:      '#9b59b6',
      admin:       'var(--accent,#b8791a)',
      alerts:      'var(--err,#c0392b)',
      store:       '#16a085',
      calendar:    '#2ecc71',
      interaction: '#e67e22',
    };

    for (const e of visible) {
      const row = document.createElement('div');
      row.className = `admin-log-row admin-log-${e.level}`;
      row.style.cursor = e.ctx != null ? 'pointer' : '';

      const head = document.createElement('div');
      head.className = 'admin-log-head';

      const lvl = document.createElement('span');
      lvl.className = 'admin-log-lvl';
      lvl.textContent = e.level;

      const ts = document.createElement('span');
      ts.className = 'admin-log-ts';
      const d = e.ts ? new Date(e.ts) : null;
      ts.textContent = d ? AdminCockpit._relTime(d) : '';
      ts.title = e.ts || '';

      const scope = document.createElement('span');
      scope.className = 'admin-log-scope';
      scope.textContent = e.scope || '';
      if (SCOPE_COLORS[e.scope]) scope.style.color = SCOPE_COLORS[e.scope];

      head.appendChild(lvl);
      head.appendChild(ts);
      head.appendChild(scope);
      const errorCode = e.errorCode;
      if (errorCode) {
        const code = document.createElement('span');
        code.className = 'admin-log-code';
        code.textContent = errorCode;
        code.title = 'Filter by this error code';
        code.addEventListener('click', ev => {
          ev.stopPropagation();
          AdminCockpit._logFilter.errorCode = errorCode;
          AdminCockpit._renderLogs();
        });
        head.appendChild(code);
      }
      const reqId = e.reqId;
      if (reqId) {
        const rid = document.createElement('span');
        rid.className = 'admin-log-reqid';
        rid.textContent = `req ${String(reqId).slice(0, 8)}`;
        rid.title = `Correlate request ${reqId} across the backend log`;
        rid.addEventListener('click', ev => {
          ev.stopPropagation();
          AdminCockpit._correlateReqId(reqId);
        });
        head.appendChild(rid);
      }
      row.appendChild(head);

      const msg = document.createElement('div');
      msg.className = 'admin-log-msg';
      msg.textContent = e.msg || '';
      row.appendChild(msg);

      if (e.ctx != null) {
        const pre = document.createElement('pre');
        pre.className = 'admin-log-ctx';
        pre.textContent = typeof e.ctx === 'string' ? e.ctx : JSON.stringify(e.ctx, null, 2);
        row.appendChild(pre);
        row.addEventListener('click', () => row.classList.toggle('expanded'));
      }

      list.appendChild(row);
    }

    const counts = document.getElementById('admin-log-counts');
    if (counts) {
      const errs  = ErrorLog.countBy('error');
      const warns = ErrorLog.countBy('warn');
      const show  = filtered.length !== allEntries.length ? Util.t('ui.log_shown', { count: filtered.length }) : '';
      counts.textContent = Util.t('ui.log_count_summary', {
        total: allEntries.length,
        errs, errp: errs === 1 ? '' : 's',
        warns, warnp: warns === 1 ? '' : 's',
        shown: show,
      });
    }
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
            (it.uploaded_at || '').replace('T', ' ').slice(0, 19),
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
        AdminCockpit._renderAuditLog();
      })
      .catch((e: Error) => Toast.show(Util.t('toast.clear_failed') + ': ' + e.message, 'error'));
  },

  _renderAuditLog(): void {
    const host = document.getElementById('admin-audit-log-list');
    if (!host) return;
    host.textContent = Util.t('ui.loading');
    AdminCockpit._auditLogAbort?.abort();
    AdminCockpit._auditLogAbort = new AbortController();
    const sig = AbortSignal.any
      ? AbortSignal.any([AdminCockpit._auditLogAbort.signal, AbortSignal.timeout(8000)])
      : AdminCockpit._auditLogAbort.signal;
    Util.fetchTraced(`${Config.API_BASE}/audit/log?limit=200`, { signal: sig })
      .then(r => r.json() as Promise<AdminAuditLogResponse>)
      .then(body => {
        host.textContent = '';
        const items = body?.entries || [];
        if (!items.length) {
          const e = document.createElement('div');
          e.className = 'admin-log-empty';
          e.textContent = Util.t('empty.no_audit_events');
          host.appendChild(e);
          return;
        }
        const tbl = document.createElement('table');
        tbl.className = 'admin-audit-tbl';
        const thead = document.createElement('thead');
        const htr   = document.createElement('tr');
        for (const h of [Util.t('ui.audit_log_col_when'), Util.t('ui.audit_log_col_user'), Util.t('ui.audit_log_col_action'), Util.t('ui.audit_log_col_plant'), Util.t('ui.audit_log_col_details')]) {
          const th = document.createElement('th');
          th.textContent = h;
          htr.appendChild(th);
        }
        thead.appendChild(htr);
        tbl.appendChild(thead);

        const ACTION_ICONS: Record<string, string> = {
          color_wheel_upload:  '⬆',
          color_wheel_replace: '↻',
          color_wheel_delete:  '⌫',
          optimization_run:    '📈',
        };
        const ACTION_COLORS: Record<string, string> = {
          color_wheel_upload:  'var(--ok,#2f7a4d)',
          color_wheel_replace: 'var(--info,#2d5f8c)',
          color_wheel_delete:  'var(--err,#c0392b)',
          optimization_run:    'var(--accent,#b8791a)',
        };

        const tb = document.createElement('tbody');
        for (const it of items) {
          const tr = document.createElement('tr');
          const action = it.action || '—';
          const icon   = ACTION_ICONS[action] || '•';
          const color  = ACTION_COLORS[action] || 'inherit';
          const details = it.details
            ? Object.entries(it.details).map(([k, v]) => `${k}: ${v}`).join(' · ')
            : '—';
          const cells = [
            (it.ts || '').replace('T', ' ').slice(0, 19),
            it.user || '—',
            '',
            it.plant || '—',
            details,
          ];
          cells.forEach((c, i) => {
            const td = document.createElement('td');
            if (i === 2) {
              // `action` is server-stored and not whitelisted, so render it as inert
              // text — never innerHTML — to avoid a stored-XSS sink (R1). icon is from
              // the fixed ACTION_ICONS map; color is a CSS var, set via style only.
              const span = document.createElement('span');
              span.style.color = color;
              span.style.fontWeight = '600';
              span.textContent = `${icon} ${action}`;
              td.appendChild(span);
            } else {
              td.textContent = c;
            }
            if (i === 3 && it.plant) td.style.fontWeight = '600';
            tr.appendChild(td);
          });
          tb.appendChild(tr);
        }
        tbl.appendChild(tb);
        host.appendChild(tbl);
      })
      .catch((e: Error) => {
        if (e?.name === 'AbortError') return;
        host.textContent = '';
        const err = document.createElement('div');
        err.className = 'admin-status error';
        err.textContent = Util.t('ui.failed_load_audit_log', { error: e.message });
        host.appendChild(err);
      });
  },

  /* ---------------------------------------------------------------------
     THREAD PROFILER PANEL — PerfMonitor ring-buffer stats table.
     Rendered into #admin-ov-thread on tab activation and on each
     PerfMonitor notification (debounced 250 ms by PerfMonitor itself).
     --------------------------------------------------------------------- */
  _refreshThreadPane(): void {
    const tbody = document.getElementById('admin-perf-tbody');
    if (!tbody) return;
    const rows = PerfMonitor.all();
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="admin-perf-empty">No data yet — interact with the app to record operations.</td></tr>`;
      return;
    }
    rows.sort((a, b) => b.last - a.last);
    const fmt = (ms: number): string => ms < 1 ? `${ms.toFixed(2)}` : ms < 100 ? `${ms.toFixed(1)}` : `${Math.round(ms)}`;
    const cls = (ms: number): string => ms >= 50 ? 'perf-hot' : ms >= 16 ? 'perf-warn' : 'perf-ok';
    const ago = (ts: number): string => {
      if (!ts) return '—';
      const s = Math.round((Date.now() - ts) / 1000);
      if (s < 2)  return 'just now';
      if (s < 60) return `${s}s ago`;
      return `${Math.round(s / 60)}m ago`;
    };
    tbody.innerHTML = rows.map(r => {
      const c = cls(r.last);
      return `<tr>
        <td class="perf-name">${Util.escapeHtml(r.name)}</td>
        <td class="${c}">${fmt(r.last)} ms</td>
        <td class="${cls(r.p50)}">${fmt(r.p50)} ms</td>
        <td class="${cls(r.p95)}">${fmt(r.p95)} ms</td>
        <td class="${cls(r.max)}">${fmt(r.max)} ms</td>
        <td>${r.count}</td>
        <td class="perf-ago">${ago(r.lastTs)}</td>
      </tr>`;
    }).join('');
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
    const lastWhen = inv.lastSavedAt ? new Date(inv.lastSavedAt).toLocaleTimeString() : '—';
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
        ? `<span class="admin-warn">${Util.t('ui.ls_degraded')}</span>`
        : `<span class="admin-good">${Util.t('ui.ls_healthy')}</span>`;
    const errTxt = errRate > 10
      ? `<span class="admin-bad">${Util.t('ui.diag_err_rate_spike', { count: errCount, rate: errRate })}</span>`
      : errRate > 0
        ? `<span class="admin-warn">${Util.t('ui.diag_err_rate_warn', { count: errCount, rate: errRate })}</span>`
        : `${errCount}`;

    host.innerHTML = `
      <div class="admin-card">
        <div class="admin-card-hd">
          <h3>${Util.t('ui.diag_client_title')}<span class="adm-help" tabindex="0" aria-label="Help"><span class="adm-help-dot">?</span><span class="adm-help-tip">${Util.t('ui.diag_client_help')}</span></span></h3>
          <div class="admin-card-actions">
            <button class="btn btn-ghost sm" id="admin-diag-refresh" title="${Util.t('tip.refresh')}">${Util.t('btn.refresh')}</button>
            <button class="btn btn-ghost sm" id="admin-diag-storage" title="${Util.t('tip.inspect_storage')}">${Util.t('btn.inspect_storage')}</button>
            <button class="btn btn-ghost sm" id="admin-diag-export" title="${Util.t('tip.diag_export_bundle')}">${Util.t('btn.export_bundle')}</button>
            <button class="btn btn-warn  sm" id="admin-diag-reset"   title="${Util.t('tip.diag_clear_cache')}">${Util.t('btn.reset_client')}</button>
          </div>
        </div>
        <div class="admin-kv">
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
          <span>${Util.t('ui.diag_kv_plant')}</span><span>${Store.selectedPlant ? Util.escapeHtml(Store.selectedPlant) : '<em>none</em>'}</span>
        </div>
      </div>`;

    document.getElementById('admin-diag-refresh')!.addEventListener('click', () => AdminCockpit._renderDiagnostics());
    document.getElementById('admin-diag-storage')!.addEventListener('click', () => AdminCockpit._showStorageInventory(inv));
    document.getElementById('admin-diag-export' )!.addEventListener('click', () => AdminCockpit._exportDiagnostics());
    document.getElementById('admin-diag-reset'  )!.addEventListener('click', () => AdminCockpit._resetClientState());
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
    const lsStatus = inv.degraded ? Util.t('ui.ls_evicted_tier') : inv.autosaveDisabled ? Util.t('ui.ls_autosave_disabled') : Util.t('ui.ls_healthy');
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
  let _orderFields: Record<string, { grid?: boolean; inspector?: boolean }> = {};

  function _writeHeaders(): Record<string, string> {
    return { 'x-user-email': Session.actor(), 'content-type': 'application/json' };
  }

  // Public entry point — fetch the current global config, then paint.
  async function render(): Promise<void> {
    const host = document.getElementById('system-config-host');
    if (!host) return;
    try {
      // Response body IS the settings content directly ({"orderFields": {...}}),
      // no wrapper envelope — see master_data.get_system_settings() in brain.py.
      const data: { orderFields?: Record<string, { grid?: boolean; inspector?: boolean }> } =
        await Util.fetchTraced(`${API}/system-settings`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
      _orderFields = data.orderFields ?? {};
      _paint();
    } catch (e) {
      host.innerHTML = `<div class="empty-state">${Util.escapeHtml(Util.t('ui.system_config_load_failed'))}: ${Util.escapeHtml((e as Error).message)}</div>`;
      ErrorLog.error('system-config', `Load system settings failed: ${(e as Error).message}`);
    }
  }

  function _paint(): void {
    const host = document.getElementById('system-config-host');
    if (!host) return;
    const rows = ORDER_FIELD_CATALOG.map((f) => {
      const cfg = _orderFields[f.key] || {};
      const gridChecked = cfg.grid ?? f.gridDefault;
      const inspChecked = cfg.inspector ?? f.inspectorDefault;
      return `<tr>
        <td class="md-th">${Util.escapeHtml(Util.t(f.i18nInspectorKey))}</td>
        <td style="text-align:center"><input type="checkbox" data-sc-field="${Util.escapeHtml(f.key)}" data-sc-surface="grid" ${gridChecked ? 'checked' : ''}></td>
        <td style="text-align:center"><input type="checkbox" data-sc-field="${Util.escapeHtml(f.key)}" data-sc-surface="inspector" ${inspChecked ? 'checked' : ''}></td>
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
        <div style="margin-top:12px;display:flex;align-items:center;gap:10px;">
          <button class="btn btn-primary" id="sc-save-btn">${Util.escapeHtml(Util.t('btn.save'))}</button>
        </div>
      </div>
    `;

    host.querySelector('#sc-save-btn')?.addEventListener('click', _save);
  }

  async function _save(): Promise<void> {
    const host = document.getElementById('system-config-host');
    if (!host) return;
    const next: Record<string, { grid: boolean; inspector: boolean }> = {};
    for (const f of ORDER_FIELD_CATALOG) {
      const gridEl = host.querySelector<HTMLInputElement>(`input[data-sc-field="${f.key}"][data-sc-surface="grid"]`);
      const inspEl = host.querySelector<HTMLInputElement>(`input[data-sc-field="${f.key}"][data-sc-surface="inspector"]`);
      next[f.key] = {
        grid: gridEl ? gridEl.checked : f.gridDefault,
        inspector: inspEl ? inspEl.checked : f.inspectorDefault,
      };
    }
    try {
      // POST body and response are both the unwrapped { orderFields: {...} }
      // shape (same contract as the GET above) — the whole map is always sent,
      // never a per-field diff (the backend merge replaces 'orderFields' wholesale).
      const saved: { orderFields?: Record<string, { grid?: boolean; inspector?: boolean }> } =
        await Util.fetchTraced(`${API}/system-settings`, {
          method: 'POST',
          headers: _writeHeaders(),
          body: JSON.stringify({ orderFields: next }),
        }).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
      _orderFields = saved.orderFields ?? next;
      Store.setOrderFieldVisibility(_orderFields, 'system-config');
      Toast.show(Util.t('toast.system_config_saved'), 'success');
    } catch (e) {
      ErrorLog.error('system-config', `Save system settings failed: ${(e as Error).message}`);
      Toast.show(Util.t('toast.system_config_save_failed'), 'error');
    }
  }

  return { render };
})();
