// integration/sap-interface-ui.mjs — SAP integration console (Admin ->
// Interface sub-tab). Extracted verbatim from
// plant-and-administration.mts (Phase P2 of
// docs/architecture/domain-refactor-plan.md, which split that
// 11,308-line mega-module into 9 domain files).
/* global NIMBUS */
import { Config, Util, ErrorLog, Toast, Modal } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import { Session } from '../security/session.mjs';

// SAP transport kinds — must mirror sap_sync._CONNECTORS' keys in the backend contract.
type SapTransport = 'file_drop' | 'odata' | 'rfc';

// SAP value-transform names — must mirror sap_sync.TRANSFORMS' keys.
type SapTransformName = 'none' | 'alpha' | 'strip_zeros' | 'dats' | 'tims' | 'decimal' | 'uom' | 'bool_x';

/** One `sap_sync_run` row — shared shape returned both embedded as
 *  `SapObject.last_run` (`GET /sap/interface/objects`, latest run only) and
 *  in bulk by `GET /sap/interface/runs` (`sap_sync.list_runs`). Not part of
 *  the backend's `response_model=` scope (only the task-date-update endpoint
 *  family is — see Phase 4's landed note), so hand-written locally. */
interface SapRun {
  id: number;
  object_key: string;
  started_at: string | null;
  ended_at: string | null;
  status: string;
  rows_read: number;
  rows_inserted: number;
  rows_updated: number;
  rows_failed: number;
  error: string | null;
  watermark_before: string | null;
  watermark_after: string | null;
  triggered_by: string | null;
}

/** One entry of `GET /sap/interface/objects` (`sap_sync.SAP_OBJECTS` catalog
 *  + live config/last-run/next-run overlay — `brain.py`'s `sap_objects`). */
interface SapObject {
  object_key: string;
  label?: string;
  kind?: 'master' | 'orders' | 'staging';
  apply_mode?: 'manual' | 'auto';
  enabled: boolean;
  transport?: SapTransport;
  schedule_cron?: string | null;
  last_run: SapRun | null;
  next_run: string | null;
}

interface SapObjectsResponse {
  objects: SapObject[];
}

/** `GET /sap/interface/config/{object}` / `POST` response (`sap_get_config`/
 *  `sap_set_config`) — secret `source_params` keys are stripped server-side,
 *  replaced by the `has_secret` flag. `object_key`/`enabled` are optional here
 *  because `_renderOverview`'s catch-fallback constructs a partial literal
 *  missing them (network/parse failure path, not a real endpoint response).
 *  `last_watermark` is READ by `_renderOverview` but neither `sap_get_config`
 *  nor the fallback literal ever supplies it — a pre-existing latent gap in
 *  the frontend (the field never actually appears at runtime); kept optional
 *  so the existing read type-checks without changing behavior. */
interface SapObjectConfig {
  object_key?: string;
  enabled?: boolean;
  transport: SapTransport;
  schedule_cron: string | null;
  source_params: Record<string, string>;
  has_secret: boolean;
  last_watermark?: string | null;
}

/** Payload accepted by `POST /sap/interface/config/{object}` — every field optional
 *  (only supplied fields are merged server-side; `source_params` itself is a
 *  merge, not a replace — see `sap_set_config`). */
interface SapConfigPatch {
  enabled?: boolean;
  apply_mode?: 'manual' | 'auto';
  transport?: SapTransport;
  schedule_cron?: string | null;
  source_params?: Record<string, string>;
}

/** One row of the Mapping tab's client-side editor buffer (`_mapState[key].rows`) —
 *  mirrors `GET /sap/interface/mappings/{object}`'s `mappings[]` shape minus
 *  `field_order` (assigned from array position only when saving). */
interface SapMapRow {
  sap_field: string;
  nimbus_column: string;
  transform: SapTransformName | string;
  active: boolean;
}

interface SapMapState {
  rows: SapMapRow[];
  dirty: boolean;
}

interface SapMappingsResponse {
  object_key: string;
  mappings: SapMapRow[];
}

/** `POST /sap/interface/mappings/{object}` response (`sap_sync.replace_field_map`). */
interface SapMappingsSaveResult {
  status: string;
  object_key: string;
  count: number;
}

interface SapRunsResponse {
  runs: SapRun[];
}

/** `POST /sap/interface/test-connection` response (`sap_sync.test_connection`
 *  / `SapConnector.test_connection` — always a stub `{ok:false,...}` today). */
interface SapTestConnectionResult {
  ok: boolean;
  detail?: string;
}

/** `_testResult` UI state — a locally-synthesized status strip, not a raw
 *  backend shape (built in `_testConnection` from `SapTestConnectionResult`). */
interface SapTestResultUI {
  cls: string;
  dot: string;
  msg: string;
}

/** `POST /sap/interface/sync/{object}` response (`sap_sync.sync_object`). */
interface SapSyncResult {
  object_key: string;
  status: 'ok' | 'error';
  rows_read: number;
  rows_inserted: number;
  rows_updated: number;
  rows_failed: number;
  error: string | null;
  run_id: number | null;
}

/** One `upload_audit` row for SAP syncs (filename='sap:sap'). */
interface SapUploadWarning {
  level?: 'info' | 'warn' | 'error';
  msg?: string;
  category?: string;
  // Distribution warning fields
  parents_distributed?: number;
  children_upserted?: number;
  children_deleted?: number;
  headers_created?: number;
  headers_refreshed?: number;
  conflicting_parent_rows?: unknown[];
  ambiguous_plant?: unknown[];
  workcenter_without_members?: unknown[];
  default_machine_invalid?: unknown[];
}

interface SapUploadAuditItem {
  batch_id: string;
  filename: string | null;
  row_count: number;
  inserted: number;
  updated: number;
  uploaded_at: string | null;
  warnings: SapUploadWarning[];
}

interface SapUploadAuditResponse {
  audit: SapUploadAuditItem[];
}

// --- SAP staging (Mulesoft landing zone) wire shapes. The `/sap/staging/*`
// routes carry no response_model, so api-generated.d.mts types their bodies as
// untyped; these are hand-written from the backend contract
// (backend/integration/sap_staging.py), same as the SapRun family above.

/** One entry of a batch's `warnings` list — `msg` is what the backend writes today;
 *  `message` is accepted too. Unknown codes render as the raw code. */
interface StageWarning {
  code?: string;
  /** Warnings produced by the order upsert carry `category` instead of `code`. */
  category?: string;
  level?: string;
  count?: number;
  msg?: string;
  message?: string;
}

interface StageCounts {
  total?: number;
  valid?: number;
  rejected?: number;
  by_reason?: Record<string, number>;
  in_horizon_live?: number;
  vanish_candidates?: number;
  /** Fraction 0..1 (0.26 = 26 %), not a percentage. */
  vanish_pct?: number;
  held?: boolean;
  confirmed_held?: boolean;
  step?: string;
}

/** One `sap_stage_batch` header (`GET /sap/staging/batches`). */
interface StageBatch {
  batch_id: string;
  object_key: string;
  plant: string;
  source?: string;
  status: string;
  row_count_expected?: number | null;
  received_at?: string | null;
  ready_at?: string | null;
  validated_at?: string | null;
  applied_at?: string | null;
  applied_by?: string | null;
  created_by?: string | null;
  counts?: StageCounts | null;
  warnings?: StageWarning[] | null;
  error?: string | null;
}

interface StageBatchesResponse {
  batches: StageBatch[];
}

/** One order a planned-order batch would delete (`GET .../deletions`). */
interface StageDeletion {
  /** Display key of a master-object row (material / plant, production version, routing); absent for orders. */
  key?: string;
  id?: string;
  production_order?: string | null;
  material_number?: string | null;
  machine?: string | null;
  scheduled_start?: string | null;
  scheduled_end?: string | null;
  manual_firmed?: boolean | null;
  firming_indicator?: string | null;
  parent_production_order?: string | null;
  /** True when the order is running right now (it is still deleted, D21). */
  running?: boolean;
}

/** One vanish-deleted order in the 30-day archive (`GET /sap/staging/archive/{plant}`). */
interface ArchivedOrder {
  id: number | string;
  batch_id: string;
  plant: string;
  order_id: string;
  production_order: string | null;
  material_number: string | null;
  machine: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  restored_at: string | null;
  restored_by: string | null;
}

/** `GET /sap/staging/send/{plant}/status`. */
interface SendStatus {
  ready: number;
  sent: number;
  error: number;
  last_queued_at: string | null;
  last_sent_at: string | null;
}

/** `POST /sap/staging/poll` — each field is a LIST of what the pass touched (not a count). */
interface StagePollResult {
  processed?: unknown[];
  applied?: unknown[];
  held?: unknown[];
  skipped?: unknown[];
  errors?: unknown[];
}

/** The Refresh toast's three numbers: the lengths of the poll result's lists. */
function pollCounts(res: StagePollResult): { processed: number; applied: number; held: number } {
  const n = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  return { processed: n(res.processed), applied: n(res.applied), held: n(res.held) };
}

/** Bookkeeping columns of a staging row that say nothing to an admin reading the rejected-rows drawer. */
const STAGE_REJECT_HIDDEN_COLS = new Set(['reject_reason', 'batch_id', 'id', 'row_status', 'received_at', 'applied_at']);

/** The one free-text batch error the backend writes for an all-rejected batch (the rest are coded or technical). */
const STAGE_NO_VALID_ROWS = 'no valid rows in batch';
const STAGE_STATUSES = ['loading', 'ready', 'validated', 'held', 'applying', 'applied', 'error', 'rejected', 'superseded', 'discarded'];
/** Every batch warning / hold / error / apply-refusal code the backend emits (ui.sap_stage_warn_<code>). */
const STAGE_WARN_CODES = [
  'routing_required', 'vanish_threshold', 'horizon_unlimited_no_deletes', 'empty_snapshot', 'incomplete_rows',
  'lot_size_rounded', 'stale_loading', 'unknown_columns', 'rows_not_staged', 'discarded', 'unknown_object_key',
  'unknown_plant', 'vanish_not_reviewed', 'revalidate_required', 'apply_in_progress', 'not_applicable',
  'superseded', 'order_exists', 'sap_changed', 'unfirmed', 'sap_changed_running', 'unparseable_dates',
  'routing_running_kept', 'sap_system_tz_invalid',
];
/** Every row-level `reject_reason` the staging validators emit (ui.sap_stage_reject_<code>). */
const STAGE_REJECT_CODES = [
  'missing_key', 'plant_mismatch', 'unknown_plant', 'duplicate_key', 'invalid_date', 'invalid_time',
  'invalid_number', 'invalid_int', 'key_too_long', 'value_too_long', 'deleted_flag', 'rejected_by_validator',
];

/** Pure formatter for a batch's status pill + counts text (rail status line and
 *  batch rows). Unknown statuses fall back to the neutral pill with the raw status. */
function stageStatusLine(b: StageBatch): { pillClass: string; text: string } {
  const known = STAGE_STATUSES.indexOf(b.status) > -1;
  const label = known ? Util.t(`ui.sap_stage_status_${b.status}`) : String(b.status);
  const c = b.counts || {};
  return {
    pillClass: `sap-batch-pill sap-batch-pill-${known ? b.status : 'unknown'}`,
    text: `${label} · ${c.valid ?? 0}/${c.rejected ?? 0}`,
  };
}

/** One-line consequence of an apply mode, shown under the mode select. */
function applyModeHint(mode: string | null | undefined): string {
  return Util.t(mode === 'auto' ? 'ui.sap_stage_mode_hint_auto' : 'ui.sap_stage_mode_hint_manual');
}

function stageWarningText(w: StageWarning, objectKey?: string): string {
  const code = w.code || w.category || '';
  if (STAGE_WARN_CODES.indexOf(code) > -1) {
    // The 25 % hold says "orders" for planned orders and "rows" for the master-data objects.
    const key = code === 'vanish_threshold' && objectKey && objectKey !== 'stage_planned_orders'
      ? 'ui.sap_stage_warn_vanish_threshold_rows' : `ui.sap_stage_warn_${code}`;
    const text = Util.t(key, { count: w.count ?? 0 });
    // These two carry the ignored column names / sample failures only in the backend text.
    const detail = code === 'unknown_columns' ? /: (.+)$/.exec(w.msg || '')
      : code === 'rows_not_staged' ? /\((.+)\)\s*$/.exec(w.msg || '') : null;
    return detail ? `${text} (${detail[1]})` : text;
  }
  return code || w.message || w.msg || '';
}

/** A row's `reject_reason` as plain words. `value_too_long:<column>` keeps the column; text outside the
 *  known codes (the routing validators' own messages) is shown as sent. */
function stageRejectText(reason: unknown): string {
  const raw = reason == null ? '' : String(reason);
  const i = raw.indexOf(':');
  const base = i > -1 ? raw.slice(0, i) : raw;
  if (STAGE_REJECT_CODES.indexOf(base) < 0) return raw;
  const text = Util.t(`ui.sap_stage_reject_${base}`);
  return i > -1 && raw.slice(i + 1).trim() ? `${text} (${raw.slice(i + 1).trim()})` : text;
}

/** Whether an apply click must go through the confirm modal: always for a held batch (Confirm & Apply),
 *  and for a plain Apply / Retry whose batch will delete rows. Only a batch with zero deletions applies
 *  straight away. */
function stageApplyNeedsConfirm(b: StageBatch, act: string): boolean {
  if (act === 'confirm') return true;
  if (act !== 'apply' && act !== 'retry') return false;
  return (b.counts?.vanish_candidates ?? 0) > 0;
}

/** A 409 body's `error` code (apply / validate / restore refusals) as plain words, else null. */
function stageErrorCodeText(detail: unknown): string | null {
  const code = detail && typeof detail === 'object' ? (detail as { error?: unknown }).error : null;
  return typeof code === 'string' && STAGE_WARN_CODES.indexOf(code) > -1 ? Util.t(`ui.sap_stage_warn_${code}`, { count: 0 }) : null;
}

/* =============================================================================
   INTERFACE — SAP integration console (Admin → Interface sub-tab)
   A master-detail console rendered into #sap-interface-host, driven by the
   /sap/interface/* endpoints:
     • status ribbon  — aggregate health (connection, enabled, last activity, errors)
     • object rail    — the 6 sync objects (status dot, kind, enable toggle); selects detail
     • detail pane    — Overview (transport/secret/schedule/checklist + Test connection),
                        Mapping (SAP→transform→NIMBUS flow + key-column guardrail),
                        History (run timeline with counts/duration/watermark/error drill-down)
   Dirty-tracking/save is local to this module; it does not touch MasterData.
   Reads use Util.fetchTraced; writes use fetch with x-user-email. Reuses NIMBUS
   component classes (.kpi-tile, .panel, .admin-health-dot, .cal-toggle-*) + a .sap-* block.
   ========================================================================== */
export const Interface = (() => {
  const API = Config.API_BASE;
  // Transform names — must mirror sap_sync.TRANSFORMS in the backend contract.
  const TRANSFORMS = ['none', 'alpha', 'strip_zeros', 'dats', 'tims', 'decimal', 'uom', 'bool_x'];
  const TRANSPORTS = ['file_drop', 'odata', 'rfc'];

  let _objects: SapObject[] = [];         // last GET /objects payload — drives ribbon + rail
  let _selected: string | null = null;    // selected object_key (master selection)
  type SapTab = 'overview' | 'staging' | 'mapping' | 'history';
  let _tab: SapTab = 'overview'; // active detail tab
  let _archiveOffset = 0;
  let _archiveSearch = '';
  const _stageReads = new WeakMap<HTMLElement, number>();
  let _stagePlant = '';                   // plant chosen in the Staging tab's combobox ('' = none yet)
  const _latest: Record<string, StageBatch | null> = {}; // object_key -> newest batch header (rail status line)
  const _rejectedOpen = new Set<string>(); // batch_ids whose rejected-rows drawer is open
  let _testResult: SapTestResultUI | null = null; // last {cls,dot,msg} from a Test-connection click
  let _lastNewestKey: string | null = null; // object_key of the most-recent run (ribbon deep-link)
  const _config: Record<string, SapObjectConfig> = {}; // object_key -> GET /config payload (transport/params/has_secret)
  // Per-object mapping editor state: { rows:[{sap_field,nimbus_column,transform,active}], dirty:bool }
  const _mapState: Record<string, SapMapState> = {};

  // Master upsert keys — MUST mirror sap_sync._MASTER_KEY_COLUMNS. A master object whose
  // active mapping omits any of these hits a NOT-NULL on upsert, so the editor blocks Save.
  const MASTER_KEYS: Record<string, string[]> = {
    subnetworks:      ['code'],
    plants:           ['subnetwork', 'plant'],
    machine: ['subnetwork', 'plant', 'machine'],
    materials:        ['material_id'],
    material_plants:  ['material_id', 'plant'],
  };
  // One-line transform descriptions (keys mirror sap_sync.TRANSFORMS).
  const XHINT: Record<string, string> = {
    none: 'pass through unchanged',    alpha: 'ALPHA-pad — e.g. MATNR',
    strip_zeros: 'drop leading zeros', dats: 'SAP YYYYMMDD → ISO date',
    tims: 'SAP HHMMSS → time',         decimal: 'packed decimal, trailing sign',
    uom: 'unit of measure → ISO',      bool_x: "SAP 'X' flag → boolean",
  };
  // Transport-specific connection fields (label + example only — scaffolds the params editor).
  const TRANSPORT_FIELDS: Record<SapTransport, [string, string, string][]> = {
    file_drop: [['path', 'Share / Blob path', '/data/sap_drop'], ['glob', 'File glob', 'plants_*.xlsx']],
    odata:     [['base_url', 'Service base URL', 'https://sap-gw/odata/ZNIMBUS_SRV'], ['entity_set', 'Entity set', 'PlantSet'], ['filter', '$filter (delta)', 'LAEDA gt {watermark}'], ['page_size', 'Page size', '1000']],
    rfc:       [['dest', 'RFC destination', 'SAP_PRD'], ['function', 'Function module', 'Z_NIMBUS_GET_PLANTS'], ['batch', 'Batch size', '2000']],
  };


  function _writeHeaders(json = true): Record<string, string> {
    const h: Record<string, string> = { 'x-user-email': Session.actor() };
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  // -----------------------------------------------------------------------
  // Public entry point
  // -----------------------------------------------------------------------
  async function render(): Promise<void> {
    const host = document.getElementById('sap-interface-host');
    if (!host) return;
    await _reload();
  }

  // Fetch /objects, then paint the console. Used on first load + after every write.
  async function _reload(): Promise<void> {
    const host = document.getElementById('sap-interface-host');
    if (!host) return;
    try {
      const data: SapObjectsResponse = await Util.fetchTraced(`${API}/sap/interface/objects`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
      // Staging objects first (stable), legacy connectors after — same order as the rail groups.
      const objs = data.objects || [];
      _objects = [...objs.filter((o) => o.kind === 'staging'), ...objs.filter((o) => o.kind !== 'staging')];
      await _loadLatest();
      if (!_selected || !_objects.some((o) => o.object_key === _selected)) {
        _selected = _objects.length ? _objects[0].object_key : null;
      }
      _paint();
    } catch (e) {
      host.innerHTML = `<div class="sap-empty"><div class="sap-empty-ico">⚠</div>`
        + `<div class="sap-empty-t">${Util.escapeHtml(Util.t('ui.sap_load_failed'))}</div>`
        + `<div class="sap-empty-d">${Util.escapeHtml((e as Error).message)}</div></div>`;
      ErrorLog.error('sap-interface', `Load objects failed: ${(e as Error).message}`);
    }
  }

  // Newest batch header per staging object (limit=1, no plant filter) for the rail status line.
  // Best-effort: a failed probe just shows "no batches" rather than blocking the console.
  async function _loadLatest(): Promise<void> {
    await Promise.all(_objects.filter((o) => o.kind === 'staging').map(async (o) => {
      try {
        const d: StageBatchesResponse = await Util.fetchTraced(`${API}/sap/staging/batches?object=${encodeURIComponent(o.object_key)}&limit=1`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
        _latest[o.object_key] = (d.batches && d.batches[0]) || null;
      } catch { _latest[o.object_key] = null; }
    }));
  }

  // Rebuild the whole console from cached _objects (no fetch).
  function _paint(): void {
    const host = document.getElementById('sap-interface-host');
    if (!host) return;
    host.innerHTML = `
      <div class="sap-pagehead">
        <div>
          <div class="sap-pagehead-title"><h2>${Util.escapeHtml(Util.t('tab.interface'))}</h2>
            <span class="sap-flow">SAP ECC <b>━▶</b> NIMBUS</span></div>
          <div class="sap-pagehead-sub">${Util.escapeHtml(Util.t('ui.sap_subtitle'))}</div>
        </div>
        <span class="sap-mode-chip"><span class="admin-health-dot"></span> ${Util.escapeHtml(Util.t('ui.sap_stub_mode'))}</span>
      </div>
      ${_renderRibbon()}
      <div class="sap-console">
        <div id="sap-rail"></div>
        <div id="sap-detail"></div>
      </div>`;
    host.querySelectorAll<HTMLElement>('[data-jump]').forEach((tile) => tile.addEventListener('click', () => {
      const j = tile.dataset.jump;
      if (j === 'errors') { const eo = _objects.find((o) => o.last_run && o.last_run.status === 'error'); if (eo) _selected = eo.object_key; }
      else if (j === 'last' && _lastNewestKey) { _selected = _lastNewestKey; }
      _tab = 'history'; _renderRail(); _renderDetail();
    }));
    _renderRail();
    _renderDetail();
  }

  function _renderRibbon(): string {
    const enabled = _objects.filter((o) => o.enabled).length;
    // A plain for-of (not .forEach) so TS's flow analysis actually widens
    // `newest`/`newestObj` back to their declared nullable type after the
    // loop — a `let x: T | null = null` reassigned only inside a callback
    // stays narrowed to `null` at every read after a `.forEach`, a known TS
    // control-flow limitation across function boundaries.
    let newest: SapRun | null = null;
    let newestObj: SapObject | null = null;
    for (const o of _objects) {
      const lr = o.last_run;
      if (lr && lr.started_at && (!newest || new Date(lr.started_at) > new Date(newest.started_at as string))) { newest = lr; newestObj = o; }
    }
    _lastNewestKey = newestObj ? newestObj.object_key : null;
    const errs = _objects.filter((o) => o.last_run && o.last_run.status === 'error').length;
    const tile = (k: string, v: string, d: string, cls: string, act: string) =>
      `<div class="kpi-tile${cls ? ' ' + cls : ''}${act ? ' is-actionable' : ''}"${act ? ` data-jump="${act}"` : ''}>`
      + `<div class="k">${Util.escapeHtml(k)}</div><div class="v">${v}</div><div class="d">${Util.escapeHtml(d)}</div></div>`;
    const lastV = newest ? `<span class="sap-v-sm">${Util.escapeHtml(_relTime(newest.started_at))}</span>` : '—';
    const lastD = newest ? `${newestObj?.label} · ${newest.triggered_by || 'manual'}` : 'no runs yet';
    const rowsV = newest ? Number(newest.rows_read || 0).toLocaleString() : '0';
    const rowsD = newest ? `+${newest.rows_inserted ?? 0} ins / ~${newest.rows_updated ?? 0} upd` : '—';
    return `<div class="sap-ribbon">
      ${tile(Util.t('ui.sap_kpi_connection'), 'Stub', 'connectors not live', 'warn', '')}
      ${tile(Util.t('ui.sap_kpi_objects'), `${enabled} <span class="sap-frac">/ ${_objects.length}</span>`, enabled ? `${_objects.length - enabled} awaiting setup` : 'none enabled', enabled ? '' : 'warn', '')}
      ${tile(Util.t('ui.sap_kpi_last_activity'), lastV, lastD, '', newest ? 'last' : '')}
      ${tile(Util.t('ui.sap_kpi_rows'), rowsV, rowsD, '', '')}
      ${tile(Util.t('ui.sap_kpi_errors'), String(errs), errs ? 'most recent run failed' : 'no failures', errs ? 'err' : '', errs ? 'errors' : '')}
    </div>`;
  }

  // -----------------------------------------------------------------------
  // Object rail (master) + detail shell (Overview / Mapping / History tabs)
  // -----------------------------------------------------------------------
  function _renderRail(): void {
    const el = document.getElementById('sap-rail');
    if (!el) return;
    const rowHtml = (o: SapObject): string => {
      const sel = o.object_key === _selected ? ' sap-rail-row-sel' : '';
      const lr = o.last_run;
      const kind = o.kind || 'master';
      if (kind === 'staging') {
        // Staging objects have no enable switch (the poll + apply mode govern them); the
        // status line is the newest batch's pill + valid/rejected counts.
        const lb = _latest[o.object_key] || null;
        const dot = !lb ? '' : (lb.status === 'applied' || lb.status === 'validated' ? 'ok'
          : (lb.status === 'held' ? 'warn' : (lb.status === 'error' || lb.status === 'rejected' ? 'err' : '')));
        const sl = lb ? stageStatusLine(lb) : null;
        const statusHtml = sl
          ? `<span class="${Util.escapeHtml(sl.pillClass)}">${Util.escapeHtml(sl.text)}</span> <span class="sap-hint">${Util.escapeHtml(lb ? lb.plant : '')}</span>`
          : Util.escapeHtml(Util.t('ui.sap_stage_no_batches'));
        return `<div class="sap-rail-row sap-rail-row-staging${sel}" data-obj="${Util.escapeHtml(o.object_key)}" tabindex="0" role="button">
          <span class="admin-health-dot ${dot}"></span>
          <div class="sap-rail-main">
            <div class="sap-rail-name">${Util.escapeHtml(o.label || o.object_key)} <span class="sap-kind sap-kind-staging">${Util.escapeHtml(Util.t('ui.sap_staging'))}</span></div>
            <div class="sap-rail-meta">${Util.escapeHtml(o.object_key)} · ${Util.escapeHtml(o.apply_mode === 'auto' ? Util.t('ui.sap_stage_mode_auto') : Util.t('ui.sap_stage_mode_manual'))}</div>
            <div class="sap-rail-status">${statusHtml}</div>
          </div>
        </div>`;
      }
      const dotCls = !lr ? '' : (lr.status === 'ok' ? 'ok' : (lr.status === 'error' ? 'err' : (lr.status === 'running' ? 'warn' : '')));
      const statusTxt = !lr ? Util.t('ui.sap_never_run')
        : (lr.status === 'ok' ? `ok · ${_relTime(lr.started_at)}`
        : (lr.status === 'error' ? `failed · ${_relTime(lr.started_at)}` : lr.status));
      return `<div class="sap-rail-row${sel}" data-obj="${Util.escapeHtml(o.object_key)}">
        <span class="admin-health-dot ${dotCls}"></span>
        <div class="sap-rail-main">
          <div class="sap-rail-name">${Util.escapeHtml(o.label || o.object_key)} <span class="sap-kind sap-kind-${Util.escapeHtml(kind)}">${Util.escapeHtml(kind)}</span></div>
          <div class="sap-rail-meta">${Util.escapeHtml(o.object_key)} · ${Util.escapeHtml(o.transport || 'file_drop')}</div>
          <div class="sap-rail-status">${Util.escapeHtml(statusTxt)}</div>
        </div>
        <label class="cal-day-toggle-wrap sap-railsw" title="${Util.escapeHtml(Util.t('ui.sap_enabled'))}">
          <input type="checkbox" data-enable="${Util.escapeHtml(o.object_key)}" ${o.enabled ? 'checked' : ''}>
          <span class="cal-toggle-track"></span><span class="cal-toggle-thumb"></span>
        </label>
      </div>`;
    };
    const stagingObjs = _objects.filter((o) => o.kind === 'staging');
    const legacyObjs = _objects.filter((o) => o.kind !== 'staging');
    const group = (label: string, list: SapObject[]): string => list.length
      ? `<div class="sap-rail-group">${Util.escapeHtml(label)}</div>${list.map(rowHtml).join('')}` : '';
    // Group labels only make sense when both kinds exist (an older backend sends no staging kind).
    const rows = stagingObjs.length
      ? group(Util.t('ui.sap_staging_group'), stagingObjs) + group(Util.t('ui.sap_connectors_group'), legacyObjs)
      : legacyObjs.map(rowHtml).join('');
    el.innerHTML = `<div class="panel">
      <div class="panel-head"><span class="sap-section-label">${Util.escapeHtml(Util.t('ui.sap_objects'))}</span>
        <span class="sap-hint">${_objects.filter((o) => o.enabled).length} / ${_objects.length}</span></div>
      <div class="sap-rail">${rows}</div></div>`;
    el.querySelectorAll<HTMLElement>('.sap-rail-row-staging').forEach((r) =>
      r.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); r.click(); } }));
    el.querySelectorAll<HTMLElement>('[data-obj]').forEach((r) =>
      r.addEventListener('click', () => { _selected = r.dataset.obj ?? null; _testResult = null; _renderRail(); _renderDetail(); }));
    el.querySelectorAll<HTMLInputElement>('[data-enable]').forEach((cb) => {
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => _saveConfig(cb.dataset.enable as string, { enabled: cb.checked }, cb.checked ? Util.t('toast.sap_enable_note') : null));
    });
  }

  function _renderDetail(): void {
    const el = document.getElementById('sap-detail');
    if (!el) return;
    const o = _objects.find((x) => x.object_key === _selected);
    if (!o) { el.innerHTML = ''; return; }
    const kind = o.kind || 'master';
    const isStaging = kind === 'staging';
    // Staging objects have no Overview tab (no transport/cron/test-connection) and legacy ones no Staging tab.
    if (isStaging && _tab === 'overview') _tab = 'staging';
    if (!isStaging && _tab === 'staging') _tab = 'overview';
    const tabBtn = (id: string, label: string) => `<button class="sap-tab${_tab === id ? ' sap-tab-active' : ''}" data-tab="${id}">${Util.escapeHtml(label)}</button>`;
    const mode = o.apply_mode === 'auto' ? 'auto' : 'manual';
    const actions = isStaging
      ? `<div class="sap-stage-mode">
          <label class="sap-stage-mode-label" for="sap-apply-mode">${Util.escapeHtml(Util.t('ui.sap_stage_apply_mode'))}</label>
          <select id="sap-apply-mode" class="sap-stage-mode-sel" title="${Util.escapeHtml(Util.t('ui.sap_stage_mode_hint'))}">
            <option value="manual"${mode === 'manual' ? ' selected' : ''}>${Util.escapeHtml(Util.t('ui.sap_stage_mode_manual'))}</option>
            <option value="auto"${mode === 'auto' ? ' selected' : ''}>${Util.escapeHtml(Util.t('ui.sap_stage_mode_auto'))}</option>
          </select>
          <div class="sap-help" id="sap-apply-mode-hint">${Util.escapeHtml(applyModeHint(mode))}</div>
        </div>
        <button class="btn btn-sm btn-primary" id="sap-stage-refresh">${Util.escapeHtml(Util.t('ui.sap_stage_refresh'))}</button>`
      : `<button class="btn btn-sm" data-act="dry">${Util.escapeHtml(Util.t('ui.sap_dry_run'))}</button>
          <button class="btn btn-sm btn-primary" data-act="run">${Util.escapeHtml(Util.t('ui.sap_run_now'))} ▸</button>`;
    const tabs = isStaging
      ? tabBtn('staging', Util.t('ui.sap_staging')) + tabBtn('mapping', Util.t('ui.sap_mapping')) + tabBtn('history', Util.t('ui.sap_history'))
      : tabBtn('overview', Util.t('ui.sap_overview')) + tabBtn('mapping', Util.t('ui.sap_mapping')) + tabBtn('history', Util.t('ui.sap_history'));
    el.innerHTML = `<div class="panel">
      <div class="sap-detail-head">
        <span class="sap-detail-name">${Util.escapeHtml(o.label || o.object_key)}</span>
        <span class="sap-kind sap-kind-${Util.escapeHtml(kind)}">${Util.escapeHtml(isStaging ? Util.t('ui.sap_staging') : kind)}</span>
        <span class="sap-detail-key">${Util.escapeHtml(o.object_key)}</span>
        <div class="sap-detail-actions">${actions}</div>
      </div>
      <div class="sap-tabs">${tabs}</div>
      <div class="sap-tabbody" id="sap-tabbody"><div class="md-loading">${Util.escapeHtml(Util.t('ui.loading'))}</div></div>
    </div>`;
    el.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => { _tab = b.dataset.tab as SapTab; _renderDetail(); }));
    el.querySelectorAll<HTMLElement>('[data-act]').forEach((b) =>
      b.addEventListener('click', () => _runNow(o.object_key, b.dataset.act === 'dry', b as HTMLButtonElement)));
    if (isStaging) {
      document.getElementById('sap-apply-mode')?.addEventListener('change', (e: Event) => {
        const value = (e.target as HTMLSelectElement).value === 'auto' ? 'auto' : 'manual';
        const hint = document.getElementById('sap-apply-mode-hint');
        if (hint) hint.textContent = applyModeHint(value);
        _saveConfig(o.object_key, { apply_mode: value }, null);
      });
      document.getElementById('sap-stage-refresh')?.addEventListener('click', (e: Event) => _pollNow(e.currentTarget as HTMLButtonElement));
    }
    if (_tab === 'overview') _renderOverview(o);
    else if (_tab === 'staging') _renderStaging(o);
    else if (_tab === 'mapping') _renderMapping(o);
    else _renderHistory(o);
  }

  function _relTime(ts: string | null | undefined): string {
    if (!ts) return '—';
    const d = new Date(ts); if (isNaN(d.getTime())) return String(ts);
    let s = Math.floor((Date.now() - d.getTime()) / 1000); if (s < 0) s = 0;
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function _cronProse(c: string | null | undefined): string | null {
    if (!c) return null;
    const p = c.trim().split(/\s+/); if (p.length !== 5) return null;
    const mi = p[0], ho = p[1], dom = p[2], mon = p[3];
    const pad = (x: string) => (x === '*' ? '00' : (x.length < 2 ? '0' + x : x));
    if (dom === '*' && mon === '*' && p[4] === '*' && ho !== '*' && mi !== '*') return `Every day at ${pad(ho)}:${pad(mi)}`;
    if (mi.indexOf('*/') === 0) return `Every ${mi.slice(2)} minutes`;
    if (ho.indexOf('*/') === 0 && dom === '*') return `Every ${ho.slice(2)} hours`;
    return null;
  }

  // -----------------------------------------------------------------------
  // Overview tab — transport config, secret indicator, schedule, checklist
  // -----------------------------------------------------------------------
  async function _renderOverview(o: SapObject): Promise<void> {
    const body = document.getElementById('sap-tabbody');
    if (!body) return;
    let cfg: SapObjectConfig | undefined = _config[o.object_key];
    if (!cfg) {
      try {
        cfg = await Util.fetchTraced(`${API}/sap/interface/config/${encodeURIComponent(o.object_key)}`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
        _config[o.object_key] = cfg as SapObjectConfig;
      } catch {
        cfg = { transport: (o.transport || 'file_drop'), source_params: {}, has_secret: false, schedule_cron: o.schedule_cron ?? null };
      }
    }
    // bail if the user switched object/tab while awaiting
    if (document.getElementById('sap-tabbody') !== body || _tab !== 'overview' || _selected !== o.object_key) return;
    // cfg is always assigned by this point (fetch-success or catch-fallback
    // above) — TS's flow analysis can't track the reassignment through the
    // async .then()-with-throw chain inside the try, a known CFA limitation
    // across function boundaries (same family of gap as `_renderRibbon`'s
    // for-of note above), so it's asserted here rather than left as a
    // scattered `cfg!` at every read site below.
    cfg = cfg as SapObjectConfig;

    const transport: SapTransport = cfg.transport || o.transport || 'file_drop';
    const cron = cfg.schedule_cron != null ? cfg.schedule_cron : (o.schedule_cron || '');
    const prose = _cronProse(cron);
    const lr = o.last_run;
    const errBanner = (lr && lr.status === 'error')
      ? `<div class="sap-banner sap-banner-err"><span class="sap-banner-ico">⚠</span><div><b>${Util.escapeHtml(Util.t('ui.sap_last_failed'))} ${Util.escapeHtml(_relTime(lr.started_at))}</b><div class="sap-mono">${Util.escapeHtml(lr.error || '')}</div></div></div>`
      : '';
    const secret = cfg.has_secret
      ? `<div class="sap-chipline"><span class="admin-health-dot ok"></span> ${Util.escapeHtml(Util.t('ui.sap_credential_present'))}</div>`
      : `<div class="sap-chipline"><span class="admin-health-dot warn"></span> ${Util.escapeHtml(Util.t('ui.sap_no_credential'))}</div>`;
    const activeMaps = (_mapState[o.object_key]?.rows || []).filter((m) => m.active && m.sap_field && m.nimbus_column).length;
    const steps: [string, string, boolean][] = [
      ['01', Util.t('ui.sap_step_transport'), true],
      ['02', Util.t('ui.sap_step_map'), activeMaps > 0],
      ['03', Util.t('ui.sap_step_enable'), o.enabled && !!cron],
      ['04', Util.t('ui.sap_step_test'), false],
      ['05', Util.t('ui.sap_step_dryrun'), !!(lr && lr.triggered_by === 'dry-run')],
      ['06', Util.t('ui.sap_step_first'), !!(lr && lr.status === 'ok' && (lr.rows_inserted || 0) > 0)],
    ];
    const checklist = steps.map((s) =>
      `<div class="sap-check-step${s[2] ? ' done' : ''}"><span class="sap-check-n">${s[0]}</span><span class="sap-check-mark">${s[2] ? '✓' : ''}</span><span class="sap-check-t">${Util.escapeHtml(s[1])}</span></div>`).join('');
    const tr = _testResult;
    const testStrip = tr
      ? `<div class="sap-test-strip ${tr.cls}"><span class="admin-health-dot ${tr.dot || ''}"></span> ${Util.escapeHtml(tr.msg)}</div>`
      : `<div class="sap-test-strip"><span class="admin-health-dot"></span> ${Util.escapeHtml(Util.t('ui.sap_not_tested'))}</div>`;

    body.innerHTML = `${errBanner}
      <div class="sap-ov-grid">
        <div>
          <div class="sap-section-label">${Util.escapeHtml(Util.t('ui.sap_connection_section'))}</div>
          <div class="sap-field"><label>${Util.escapeHtml(Util.t('ui.sap_transport'))}</label>
            <select id="sap-transport-sel">${TRANSPORTS.map(tp => `<option${tp === transport ? ' selected' : ''}>${tp}</option>`).join('')}</select></div>
          <div id="sap-transport-fields">${_transportFieldsHTML(transport, cfg.source_params || {})}</div>
          <div class="sap-secretbox">${secret}<div class="sap-secret-note">${Util.escapeHtml(Util.t('ui.sap_secret_note'))}</div></div>
          <div class="sap-test-row"><button class="btn" id="sap-test-btn">${Util.escapeHtml(Util.t('ui.sap_test_connection'))}</button></div>
          ${testStrip}
        </div>
        <div>
          <div class="sap-section-label">${Util.escapeHtml(Util.t('ui.sap_schedule_section'))}</div>
          <div class="sap-field"><label>${Util.escapeHtml(Util.t('ui.sap_cron'))}</label>
            <input class="sap-mono" id="sap-cron-input" value="${Util.escapeHtml(cron)}" placeholder="— — — — —">
            ${prose ? `<div class="sap-cron-prose">${Util.escapeHtml(prose)}<span class="sap-cron-raw">${Util.escapeHtml(cron)}</span></div>` : `<div class="sap-help">${Util.escapeHtml(Util.t('ui.sap_not_scheduled'))}</div>`}</div>
          <div class="sap-banner sap-banner-info"><span class="sap-banner-ico">ℹ</span><div>${Util.escapeHtml(Util.t('ui.sap_scheduler_note_a'))} <span class="sap-mono">NIMBUS_SAP_SYNC_ENABLED=1</span> ${Util.escapeHtml(Util.t('ui.sap_scheduler_note_b'))}</div></div>
          <div class="sap-section-label">${Util.escapeHtml(Util.t('ui.sap_delta_section'))}</div>
          <div class="sap-kv"><span>${Util.escapeHtml(Util.t('ui.sap_last_watermark'))}</span><span class="sap-mono">${Util.escapeHtml(cfg.last_watermark || '— (full load)')}</span></div>
        </div>
        <div class="sap-ov-full">
          <div class="sap-section-label">${Util.escapeHtml(Util.t('ui.sap_checklist'))}</div>
          <div class="sap-check">${checklist}</div>
        </div>
      </div>`;

    document.getElementById('sap-transport-sel')?.addEventListener('change', (e: Event) => {
      const value = (e.target as HTMLSelectElement).value as SapTransport;
      _config[o.object_key] = { ...(_config[o.object_key] || cfg as SapObjectConfig), transport: value };
      _testResult = null;
      _saveConfig(o.object_key, { transport: value }, null);
    });
    document.getElementById('sap-cron-input')?.addEventListener('change', (e: Event) =>
      _saveConfig(o.object_key, { schedule_cron: (e.target as HTMLInputElement).value.trim() || null }, null));
    document.getElementById('sap-test-btn')?.addEventListener('click', () => _testConnection(o.object_key, transport));
  }

  function _transportFieldsHTML(transport: SapTransport, params: Record<string, string>): string {
    const fields = TRANSPORT_FIELDS[transport] || [];
    if (!fields.length) return '';
    return fields.map((f) =>
      `<div class="sap-field"><label>${Util.escapeHtml(f[1])}</label><input class="sap-mono" data-param="${Util.escapeHtml(f[0])}" value="${Util.escapeHtml(params[f[0]] != null ? params[f[0]] : '')}" placeholder="${Util.escapeHtml(f[2])}" spellcheck="false"></div>`).join('');
  }

  async function _testConnection(object: string, transport: SapTransport): Promise<void> {
    const params: Record<string, string> = {};
    document.querySelectorAll<HTMLInputElement>('#sap-transport-fields [data-param]').forEach((inp) => {
      if (inp.value.trim() && inp.dataset.param) params[inp.dataset.param] = inp.value.trim();
    });
    _testResult = { cls: 'info', dot: '', msg: Util.t('ui.sap_testing') };
    _renderDetail();
    try {
      const res: SapTestConnectionResult = await Util.fetchTraced(`${API}/sap/interface/test-connection`, {
        method: 'POST', headers: _writeHeaders(),
        body: JSON.stringify({ transport, source_params: params }),
      }).then((r) => { if (!r.ok) return r.json().then((e) => { throw new Error(Util.errorDetailText(e.detail) || `HTTP ${r.status}`); }); return r.json(); });
      _testResult = res.ok
        ? { cls: 'ok', dot: 'ok', msg: `${Util.t('toast.sap_conn_ok')} — ${res.detail || ''}`.trim() }
        : { cls: 'info', dot: '', msg: res.detail || Util.t('toast.sap_conn_fail') };
    } catch (e) {
      _testResult = { cls: 'err', dot: 'err', msg: `${Util.t('toast.sap_conn_fail')} — ${(e as Error).message}` };
      ErrorLog.error('sap-interface', `Test connection failed: ${(e as Error).message}`);
    }
    if (_tab === 'overview' && _selected === object) _renderDetail();
  }

  async function _saveConfig(object: string, patch: SapConfigPatch, confirmMsg: string | null): Promise<void> {
    try {
      await Util.fetchTraced(`${API}/sap/interface/config/${encodeURIComponent(object)}`, {
        method: 'POST', headers: _writeHeaders(), body: JSON.stringify(patch),
      }).then((r) => { if (!r.ok) return r.json().then((e) => { throw new Error(Util.errorDetailText(e.detail) || `HTTP ${r.status}`); }); return r.json(); });
      if (_config[object]) _config[object] = { ...(_config[object]), ...patch };
      if (confirmMsg) Toast.show(confirmMsg, 'info');
      await _reload();
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('sap-interface', `Config save failed for ${object}: ${(e as Error).message}`);
      await _reload();
    }
  }

  async function _runNow(object: string, dryRun: boolean, btn: HTMLButtonElement | null): Promise<void> {
    if (btn) btn.disabled = true;
    try {
      const res: SapSyncResult = await Util.fetchTraced(`${API}/sap/interface/sync/${encodeURIComponent(object)}`, {
        method: 'POST', headers: _writeHeaders(), body: JSON.stringify({ dry_run: !!dryRun }),
      }).then((r) => { if (!r.ok) return r.json().then((e) => { throw new Error(Util.errorDetailText(e.detail) || `HTTP ${r.status}`); }); return r.json(); });
      if (res.status === 'ok') {
        Toast.show(`${dryRun ? Util.t('toast.sap_dryrun_done') : Util.t('toast.sap_sync_done')} (read ${res.rows_read ?? 0} · +${res.rows_inserted ?? 0} / ~${res.rows_updated ?? 0})`, 'success');
      } else {
        Toast.show(`${Util.t('toast.sap_sync_failed')}: ${res.error || ''}`.trim(), 'error', 6000);
      }
      await _reload();
    } catch (e) {
      Toast.show(`${Util.t('toast.sap_sync_failed')}: ${(e as Error).message}`, 'error');
      ErrorLog.error('sap-interface', `Sync failed for ${object}: ${(e as Error).message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // -----------------------------------------------------------------------
  // Mapping tab — SAP field ━▶ transform ━▶ NIMBUS column flow editor
  // -----------------------------------------------------------------------
  async function _renderMapping(o: SapObject): Promise<void> {
    const body = document.getElementById('sap-tabbody');
    if (!body) return;
    if (!_mapState[o.object_key]) {
      body.innerHTML = `<div class="md-loading">${Util.escapeHtml(Util.t('ui.loading'))}</div>`;
      try {
        const data: SapMappingsResponse = await Util.fetchTraced(`${API}/sap/interface/mappings/${encodeURIComponent(o.object_key)}`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
        _mapState[o.object_key] = {
          rows: (data.mappings || []).map((m) => ({
            sap_field: m.sap_field || '', nimbus_column: m.nimbus_column || '',
            transform: m.transform || 'none', active: m.active !== false,
          })),
          dirty: false,
        };
      } catch (e) {
        body.innerHTML = `<div class="sap-empty"><div class="sap-empty-t">${Util.escapeHtml(Util.t('ui.sap_map_load_failed'))}</div><div class="sap-empty-d">${Util.escapeHtml((e as Error).message)}</div></div>`;
        ErrorLog.error('sap-interface', `Load mappings failed for ${o.object_key}: ${(e as Error).message}`);
        return;
      }
    }
    if (document.getElementById('sap-tabbody') !== body || _tab !== 'mapping' || _selected !== o.object_key) return;
    _drawMapping(o);
  }

  function _drawMapping(o: SapObject): void {
    const body = document.getElementById('sap-tabbody');
    const st = _mapState[o.object_key];
    if (!body || !st) return;
    const isMaster = (o.kind || 'master') === 'master';
    // Staging objects skip the MASTER_KEYS save-guard: the backend forces their key
    // columns active on every save, so the editor never needs to block on them.
    const isStaging = o.kind === 'staging';
    const keys = MASTER_KEYS[o.object_key] || [];
    const rails = `<div class="sap-flow-rails"><span class="sap-fr">▤ ${Util.escapeHtml(Util.t('ui.sap_field'))}</span><span class="sap-fr c">${Util.escapeHtml(Util.t('ui.sap_transform'))}</span><span class="sap-fr r">${Util.escapeHtml(Util.t('ui.sap_nimbus_column'))} ◆</span></div>`;

    if (!st.rows.length) {
      body.innerHTML = `${isMaster ? _keystrip(o, st) : ''}
        <div class="sap-banner sap-banner-info"><span class="sap-banner-ico">→</span><div>${Util.escapeHtml(Util.t(isStaging ? 'ui.sap_map_primer_staging' : (isMaster ? 'ui.sap_map_primer_master' : 'ui.sap_map_primer_orders')))}</div></div>
        ${rails}
        <div class="sap-ghost-row"><div class="sap-ghost-node">SAP field</div><div class="sap-ghost-mid">transform</div><div class="sap-ghost-node">nimbus_column</div></div>
        <div class="sap-map-actions"><button class="btn btn-sm" id="sap-add-map">+ ${Util.escapeHtml(Util.t('ui.sap_add_first'))}</button></div>`;
      document.getElementById('sap-add-map')?.addEventListener('click', () => { st.rows.push({ sap_field: '', nimbus_column: '', transform: 'none', active: true }); st.dirty = true; _drawMapping(o); });
      return;
    }

    const rows = st.rows.map((m, i) => {
      const isKey = isMaster && keys.indexOf(m.nimbus_column) > -1;
      const opts = TRANSFORMS.map((tr) => `<option${tr === m.transform ? ' selected' : ''}>${tr}</option>`).join('');
      return `<div class="sap-map-row${m.active ? '' : ' inactive'}" style="animation-delay:${i * 55}ms">
        <input class="sap-node sap-node-sap" data-idx="${i}" data-f="sap_field" value="${Util.escapeHtml(m.sap_field)}" placeholder="SAP field" spellcheck="false">
        <span class="sap-wire"><span class="sap-wire-fill" style="animation-delay:${i * 55}ms"></span></span>
        <span class="sap-xform-wrap${m.transform === 'none' ? ' none' : ''}"><select class="sap-xform${m.transform === 'none' ? ' none' : ''}" data-idx="${i}" data-f="transform">${opts}</select><span class="sap-xform-hint">${Util.escapeHtml(XHINT[m.transform] || '')}</span></span>
        <span class="sap-node-wrap"><input class="sap-node sap-node-nimbus${isKey ? ' key' : ''}" data-idx="${i}" data-f="nimbus_column" value="${Util.escapeHtml(m.nimbus_column)}" placeholder="nimbus_column" spellcheck="false">${isKey ? '<span class="sap-keytag" title="Key column">🔑</span>' : ''}</span>
        <span class="sap-row-tools"><label class="cal-day-toggle-wrap sap-rowsw" title="${Util.escapeHtml(Util.t('ui.sap_active'))}"><input type="checkbox" data-idx="${i}" data-f="active" ${m.active ? 'checked' : ''}><span class="cal-toggle-track"></span><span class="cal-toggle-thumb"></span></label><button class="sap-icon-btn danger" data-del="${i}" title="Remove">🗑</button></span>
      </div>`;
    }).join('');

    let guard = '', blocked = false;
    if (isMaster && keys.length) {
      const missing = keys.filter((k) => !st.rows.some((m) => m.nimbus_column === k && m.active));
      blocked = missing.length > 0;
      guard = _keystrip(o, st);
      if (blocked) {
        guard += `<div class="sap-banner sap-banner-err"><span class="sap-banner-ico">⚠</span><div><b>${Util.escapeHtml(o.label || o.object_key)} ${Util.escapeHtml(Util.t('ui.sap_upsert_fail'))}</b> ${Util.escapeHtml(Util.t('ui.sap_key_missing'))} <span class="sap-mono">${missing.map(m => Util.escapeHtml(m)).join(', ')}</span>.</div></div>`;
      }
    } else if (isStaging) {
      guard = `<div class="sap-banner sap-banner-info"><span class="sap-banner-ico">ℹ</span><div>${Util.escapeHtml(Util.t('ui.sap_map_primer_staging'))}</div></div>`;
    } else if (!isMaster) {
      guard = `<div class="sap-help" style="margin-bottom:12px"><span class="sap-mono">production_order</span> ${Util.escapeHtml(Util.t('ui.sap_orders_identity'))}</div>`;
    }

    body.innerHTML = `${guard}${rails}<div class="sap-flow">${rows}</div>
      <div class="sap-map-actions">
        <button class="btn btn-sm" id="sap-add-map">+ ${Util.escapeHtml(Util.t('ui.sap_add_mapping'))}</button>
        <span class="sap-spacer"></span>
        ${st.dirty ? `<span class="sap-dirty">${Util.escapeHtml(Util.t('ui.sap_unsaved'))}</span>` : ''}
        <button class="btn btn-sm btn-primary" id="sap-save-map"${blocked ? ` disabled title="${Util.escapeHtml(Util.t('ui.sap_resolve_keys'))}"` : ''}>${Util.escapeHtml(Util.t('ui.sap_save_mappings'))}</button>
      </div>`;

    body.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-f]').forEach((inp) => {
      const isText = inp.tagName === 'INPUT' && (inp as HTMLInputElement).type === 'text';
      const update = () => {
        const idx = Number(inp.dataset.idx);
        const field = inp.dataset.f as keyof SapMapRow;
        const row = st.rows[idx]; if (!row || !field) return;
        const checked = (inp as HTMLInputElement).type === 'checkbox' ? (inp as HTMLInputElement).checked : undefined;
        if (field === 'active') row.active = !!checked;
        else if (field === 'sap_field') row.sap_field = inp.value;
        else if (field === 'nimbus_column') row.nimbus_column = inp.value;
        else if (field === 'transform') row.transform = inp.value;
        st.dirty = true;
      };
      if (isText) { inp.addEventListener('input', update); inp.addEventListener('change', () => { update(); _drawMapping(o); }); }
      else { inp.addEventListener('change', () => { update(); _drawMapping(o); }); }
    });
    body.querySelectorAll<HTMLElement>('[data-del]').forEach((b) =>
      b.addEventListener('click', () => { st.rows.splice(Number(b.dataset.del), 1); st.dirty = true; _drawMapping(o); }));
    document.getElementById('sap-add-map')?.addEventListener('click', () => { st.rows.push({ sap_field: '', nimbus_column: '', transform: 'none', active: true }); st.dirty = true; _drawMapping(o); });
    document.getElementById('sap-save-map')?.addEventListener('click', () => _saveMappings(o.object_key));
  }

  function _keystrip(o: SapObject, st: SapMapState): string {
    const keys = MASTER_KEYS[o.object_key] || [];
    if (!keys.length) return '';
    const chips = keys.map((k) => {
      const ok = st.rows.some((m) => m.nimbus_column === k && m.active);
      return `<span class="sap-keychip${ok ? '' : ' miss'}"><span class="admin-health-dot ${ok ? 'ok' : 'err'}"></span>${Util.escapeHtml(k)}${ok ? '' : ` <span class="sap-req">${Util.escapeHtml(Util.t('ui.sap_required'))}</span>`}</span>`;
    }).join('');
    return `<div class="sap-keystrip"><span class="sap-ks-label">${Util.escapeHtml(Util.t('ui.sap_key_columns'))}</span>${chips}</div>`;
  }

  async function _saveMappings(object: string): Promise<void> {
    const st = _mapState[object];
    if (!st) return;
    const mappings = st.rows
      .filter((m) => m.sap_field.trim() && m.nimbus_column.trim())
      .map((m, i) => ({ sap_field: m.sap_field.trim(), nimbus_column: m.nimbus_column.trim(), transform: m.transform || 'none', active: m.active !== false, field_order: i }));
    try {
      await Util.fetchTraced(`${API}/sap/interface/mappings/${encodeURIComponent(object)}`, {
        method: 'POST', headers: _writeHeaders(), body: JSON.stringify({ mappings }),
      }).then((r) => { if (!r.ok) return r.json().then((e) => { throw new Error(Util.errorDetailText(e.detail) || `HTTP ${r.status}`); }); return r.json() as Promise<SapMappingsSaveResult>; });
      delete _mapState[object];
      Toast.show(Util.t('toast.sap_mappings_saved'), 'success');
      await _reload();
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('sap-interface', `Save mappings failed for ${object}: ${(e as Error).message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Staging tab — Mulesoft landing zone: batches, apply/confirm/discard,
  // rejected rows, test upload, plus Outbound + Archive on planned orders.
  // -----------------------------------------------------------------------

  // One module-level AbortController for the staging tab's combobox (its document-level click
  // listener). `_renderStaging` replaces the container's HTML on every render, so a per-container
  // map never saw the old element again and leaked a listener per render; the controller is aborted
  // at the start of every `_renderStaging`. Derived from setup-admin.mts / master-data/admin-ui.mts /
  // distribution-pane.mts, the deliberately duplicated searchable-combobox helper
  // (frontend/CLAUDE.md "Cross-cutting hazards").
  let _comboAbort: AbortController | null = null;

  /** Searchable single-select combobox (Production Scale Roadmap: never chips for plants). */
  function _mkCombobox(containerEl: HTMLElement | null, options: string[], opts: { value?: string; placeholder?: string; onSelect?: (value: string) => void } = {}): void {
    if (!containerEl) return;
    _comboAbort?.abort();
    _comboAbort = new AbortController();
    const comboSignal = _comboAbort.signal;
    const { value = '', placeholder = '', onSelect } = opts;
    containerEl.innerHTML = `
      <div class="hps-combobox md-bom-combobox">
        <input type="text" class="hps-input" placeholder="${Util.escapeHtml(placeholder)}" autocomplete="off" spellcheck="false"
               aria-haspopup="listbox" aria-expanded="false" aria-label="${Util.escapeHtml(Util.t('ui.plant_label'))}">
        <button type="button" class="hps-clear" hidden>&times;</button>
        <div class="hps-dropdown" role="listbox" hidden></div>
      </div>`;
    const root = containerEl.querySelector('.hps-combobox') as HTMLElement;
    const input = root.querySelector('.hps-input') as HTMLInputElement;
    const clearBtn = root.querySelector('.hps-clear') as HTMLButtonElement;
    const dropdown = root.querySelector('.hps-dropdown') as HTMLElement;
    let filtered: string[] = [];
    let activeIdx = -1;
    let open = false;
    let selected = value;

    function reflect(): void {
      input.value = selected || '';
      root.classList.toggle('has-value', !!selected);
      clearBtn.hidden = !selected;
    }
    function renderDropdown(query: string): void {
      const q = (query || '').trim().toLowerCase();
      const looksLikeLabel = selected && String(query).trim().toLowerCase() === String(selected).toLowerCase();
      const filterQ = looksLikeLabel ? '' : q;
      filtered = filterQ ? options.filter((o) => String(o).toLowerCase().includes(filterQ)) : options.slice();
      if (!filtered.length) {
        dropdown.innerHTML = `<div class="hps-empty">${Util.t(options.length ? 'ui.no_matches' : 'ui.no_options')}</div>`;
        activeIdx = -1;
        return;
      }
      dropdown.innerHTML = filtered.map((o, i) => `<div class="hps-option${o === selected ? ' selected' : ''}" role="option" data-idx="${i}">${Util.escapeHtml(o)}</div>`).join('');
      activeIdx = Math.max(0, filtered.indexOf(selected));
      highlight();
      dropdown.querySelectorAll('.hps-option').forEach((el, i) => {
        el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(filtered[i] as string); });
      });
    }
    function highlight(): void {
      const items = dropdown.querySelectorAll('.hps-option');
      items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
      if (items[activeIdx]) items[activeIdx]!.scrollIntoView({ block: 'nearest' });
    }
    function openDd(): void { dropdown.hidden = false; open = true; input.setAttribute('aria-expanded', 'true'); }
    function closeDd(): void { dropdown.hidden = true; open = false; activeIdx = -1; input.setAttribute('aria-expanded', 'false'); }
    function pick(o: string): void {
      selected = o;
      reflect();
      closeDd();
      input.blur();
      if (onSelect) onSelect(o);
    }

    input.addEventListener('focus', () => { renderDropdown(input.value); openDd(); });
    input.addEventListener('input', () => { renderDropdown(input.value); openDd(); });
    input.addEventListener('keydown', (e) => {
      if (!open) {
        if (e.key === 'ArrowDown' || e.key === 'Enter') { renderDropdown(input.value); openDd(); e.preventDefault(); }
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, filtered.length - 1); highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); highlight(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (filtered[activeIdx]) pick(filtered[activeIdx] as string); }
      else if (e.key === 'Escape') { closeDd(); reflect(); input.blur(); }
    });
    input.addEventListener('blur', () => { setTimeout(() => { closeDd(); reflect(); }, 120); });
    clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
    clearBtn.addEventListener('click', () => { selected = ''; reflect(); if (onSelect) onSelect(''); input.focus(); });
    document.addEventListener('click', (e) => { if (!root.contains(e.target as Node)) closeDd(); }, { signal: comboSignal });

    reflect();
  }

  /** Readable text out of a non-OK response body (409 → `detail.message`). */
  function _errText(body: unknown, status: number): string {
    const b = (body || {}) as { detail?: unknown; message?: unknown };
    const d = b.detail as { message?: unknown } | string | undefined;
    const coded = stageErrorCodeText(d);
    if (coded) return coded;
    if (d && typeof d === 'object' && typeof d.message === 'string') return d.message;
    return Util.errorDetailText(b.detail) || (typeof b.message === 'string' ? b.message : '') || `HTTP ${status}`;
  }

  /** One staging write: POST, toast the outcome, always reload. Returns the parsed body on success. */
  async function _stagePost<T>(path: string, body: unknown, errKey: string | null): Promise<T | null> {
    try {
      const isForm = body instanceof FormData;
      const r = await Util.fetchTraced(`${API}${path}`, {
        method: 'POST',
        headers: _writeHeaders(!isForm),
        body: isForm ? body : JSON.stringify(body ?? {}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = _errText(j, r.status);
        Toast.show(errKey ? Util.t(errKey, { msg }) : msg, 'error', 6000);
        ErrorLog.error('sap-interface', `Staging POST ${path} failed: ${msg}`);
        return null;
      }
      return j as T;
    } catch (e) {
      Toast.show(errKey ? Util.t(errKey, { msg: (e as Error).message }) : (e as Error).message, 'error', 6000);
      ErrorLog.error('sap-interface', `Staging POST ${path} failed: ${(e as Error).message}`);
      return null;
    }
  }

  async function _pollNow(btn: HTMLButtonElement | null): Promise<void> {
    if (btn) btn.disabled = true;
    const res = await _stagePost<StagePollResult>('/sap/staging/poll', {}, null);
    if (res) {
      const errs = Array.isArray(res.errors) ? res.errors.length : 0;
      Toast.show(Util.t('toast.sap_poll_done', pollCounts(res)), errs > 0 ? 'warn' : 'success');
    }
    await _reload();
    if (btn) btn.disabled = false;
  }

  async function _downloadCsv(path: string, filename: string): Promise<void> {
    try {
      const r = await Util.fetchTraced(`${API}${path}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      Toast.show((e as Error).message, 'error');
      ErrorLog.error('sap-interface', `CSV download failed: ${(e as Error).message}`);
    }
  }

  async function _getJson<T>(path: string): Promise<T> {
    const r = await Util.fetchTraced(`${API}${path}`);
    if (!r.ok) throw new Error(_errText(await r.json().catch(() => ({})), r.status));
    return r.json();
  }

  function _stageIsCurrent(o: SapObject, body: HTMLElement): boolean {
    return document.getElementById('sap-tabbody') === body && _tab === 'staging' && _selected === o.object_key;
  }

  function _beginStageRead(o: SapObject, body: HTMLElement, host: HTMLElement): () => boolean {
    const plant = _stagePlant;
    const token = (_stageReads.get(host) || 0) + 1;
    _stageReads.set(host, token);
    return () => _stageIsCurrent(o, body) && _stagePlant === plant
      && document.getElementById(host.id) === host && _stageReads.get(host) === token;
  }

  async function _renderStaging(o: SapObject): Promise<void> {
    const body = document.getElementById('sap-tabbody');
    if (!body) return;
    _comboAbort?.abort();      // drop the previous render's document-level combobox listener
    const isOrders = o.object_key === 'stage_planned_orders';
    body.innerHTML = `
      <div class="sap-stage-bar">
        <div class="sap-field sap-stage-plant"><label>${Util.escapeHtml(Util.t('ui.plant_label'))}</label><div id="sap-stage-plant-host"></div></div>
        <div class="sap-stage-upload">
          <input type="file" id="sap-stage-file" accept=".xlsx,.xls,.csv" aria-label="${Util.escapeHtml(Util.t('ui.sap_stage_upload'))}">
          <button class="btn btn-sm" id="sap-stage-upload-btn" disabled>${Util.escapeHtml(Util.t('ui.sap_stage_upload'))}</button>
          <div class="sap-help" id="sap-stage-upload-hint"></div>
        </div>
      </div>
      <div class="sap-section-label">${Util.escapeHtml(Util.t('ui.sap_stage_batches'))}</div>
      <div id="sap-stage-batches"><div class="md-loading">${Util.escapeHtml(Util.t('ui.loading'))}</div></div>
      ${isOrders ? '<div id="sap-stage-outbound" class="sap-stage-panel"></div><div id="sap-stage-archive" class="sap-stage-panel"></div>' : ''}`;

    const fileEl = document.getElementById('sap-stage-file') as HTMLInputElement | null;
    const upBtn = document.getElementById('sap-stage-upload-btn') as HTMLButtonElement | null;
    const upHint = document.getElementById('sap-stage-upload-hint');
    const syncUpload = (): void => {
      if (upBtn) upBtn.disabled = !(_stagePlant && fileEl && fileEl.files && fileEl.files.length);
      if (upHint) upHint.textContent = _stagePlant ? '' : Util.t('ui.sap_stage_plant_required');
    };
    fileEl?.addEventListener('change', syncUpload);
    upBtn?.addEventListener('click', () => { void _uploadToStaging(o, fileEl, upBtn); });
    syncUpload();

    _mkCombobox(document.getElementById('sap-stage-plant-host'), Store.knownPlants(), {
      value: _stagePlant,
      placeholder: Util.t('ph.select_plant'),
      onSelect: (p) => {
        _stagePlant = p || '';
        _archiveOffset = 0;
        _archiveSearch = '';
        syncUpload();
        void _loadBatches(o, body);
        if (isOrders) { void _renderOutbound(o, body); void _renderArchive(o, body); }
      },
    });

    await _loadBatches(o, body);
    if (isOrders) { void _renderOutbound(o, body); void _renderArchive(o, body); }
  }

  async function _loadBatches(o: SapObject, body: HTMLElement): Promise<void> {
    const host = document.getElementById('sap-stage-batches');
    if (!host) return;
    const current = _beginStageRead(o, body, host);
    host.innerHTML = `<div class="md-loading">${Util.escapeHtml(Util.t('ui.loading'))}</div>`;
    try {
      const params = new URLSearchParams({ object: o.object_key, limit: '50' });
      if (_stagePlant) params.set('plant', _stagePlant);
      const d = await _getJson<StageBatchesResponse>(`/sap/staging/batches?${params.toString()}`);
      if (!current()) return;
      const batches = d.batches || [];
      if (!batches.length) {
        host.innerHTML = `<div class="sap-empty"><div class="sap-empty-ico">◍</div><div class="sap-empty-t">${Util.escapeHtml(Util.t('ui.sap_stage_no_batches'))}</div></div>`;
        return;
      }
      host.innerHTML = `<div class="sap-batch-list">${batches.map(_batchRowHtml).join('')}</div>`;
      host.querySelectorAll<HTMLButtonElement>('[data-bact]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const b = batches.find((x) => x.batch_id === btn.dataset.bid);
          if (b) void _stageAction(b, btn.dataset.bact as string, btn);
        }));
      host.querySelectorAll<HTMLButtonElement>('[data-brej]').forEach((btn) =>
        btn.addEventListener('click', () => { void _toggleRejected(btn.dataset.brej as string, host); }));
      host.querySelectorAll<HTMLButtonElement>('[data-bcsv]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const bid = btn.dataset.bcsv as string;
          void _downloadCsv(`/sap/staging/batches/${encodeURIComponent(bid)}/rejected?format=csv`, `rejected_${bid.slice(0, 8)}.csv`);
        }));
      _rejectedOpen.forEach((bid) => { if (host.querySelector(`#sap-rej-${CSS.escape(bid)}`)) void _fillRejected(bid, host); });
    } catch (e) {
      if (!current()) return;
      host.innerHTML = `<div class="sap-empty"><div class="sap-empty-t">${Util.escapeHtml(Util.t('ui.sap_load_failed'))}</div><div class="sap-empty-d">${Util.escapeHtml((e as Error).message)}</div></div>`;
      ErrorLog.error('sap-interface', `Load batches failed: ${(e as Error).message}`);
    }
  }

  function _batchRowHtml(b: StageBatch): string {
    const sl = stageStatusLine(b);
    const c = b.counts || {};
    const held = b.status === 'held';
    const rejected = c.rejected ?? 0;
    const vanishPct = c.vanish_pct != null ? Math.round(c.vanish_pct * 100) : null;
    const vanish = vanishPct != null && (c.vanish_candidates ?? 0) > 0
      ? `<span class="sap-batch-vanish${held ? ' is-held' : ''}">${Util.escapeHtml(Util.t('ui.sap_stage_vanish', { count: c.vanish_candidates ?? 0, pct: vanishPct }))}</span>` : '';
    const times = [
      [Util.t('ui.sap_stage_time_received'), b.received_at], [Util.t('ui.sap_stage_time_ready'), b.ready_at],
      [Util.t('ui.sap_stage_time_validated'), b.validated_at], [Util.t('ui.sap_stage_time_applied'), b.applied_at],
    ].filter((t) => t[1]).map((t) => `<span>${Util.escapeHtml(String(t[0]))} ${Util.escapeHtml(_fmtTs(t[1]))}</span>`).join('');
    const warns = (b.warnings || []).map((w) => `<div class="sap-batch-warn">${Util.escapeHtml(stageWarningText(w, b.object_key))}</div>`).join('');
    const errText = b.error && STAGE_WARN_CODES.indexOf(b.error) > -1 ? stageWarningText({ code: b.error }, b.object_key)
      : (b.error === STAGE_NO_VALID_ROWS ? Util.t('ui.sap_stage_err_no_valid_rows') : b.error);
    const err = b.error ? `<div class="sap-batch-warn is-err">${Util.escapeHtml(errText || '')}${c.step ? ` (${Util.escapeHtml(c.step)})` : ''}</div>` : '';
    const needsRouting = (b.warnings || []).some((w) => w.code === 'routing_required');
    const heldBanner = held
      ? `<div class="sap-banner sap-banner-err sap-batch-held"><span class="sap-banner-ico">⚠</span><div><b>${Util.escapeHtml(Util.t(needsRouting ? 'ui.sap_stage_held_routing' : 'ui.sap_stage_held_banner'))}</b></div></div>` : '';
    const btn = (act: string, key: string, cls = '') =>
      `<button class="btn btn-sm${cls ? ' ' + cls : ''}" data-bact="${act}" data-bid="${Util.escapeHtml(b.batch_id)}">${Util.escapeHtml(Util.t(key))}</button>`;
    let actions = '';
    switch (b.status) {
      case 'validated': actions = btn('apply', 'ui.sap_stage_apply', 'btn-primary') + btn('discard', 'ui.sap_stage_discard'); break;
      case 'held': actions = btn('confirm', 'ui.sap_stage_confirm_apply', 'btn-danger') + btn('discard', 'ui.sap_stage_discard'); break;
      case 'ready': actions = btn('validate', 'ui.sap_stage_validate') + btn('discard', 'ui.sap_stage_discard'); break;
      // A rejected batch has no valid rows (Validate would only repeat the verdict); an errored one is
      // resumed with Retry apply (the apply path re-runs the gates), so Validate is not offered there.
      case 'rejected': actions = btn('discard', 'ui.sap_stage_discard'); break;
      case 'error': actions = btn('retry', 'ui.sap_stage_retry_apply', 'btn-primary') + btn('discard', 'ui.sap_stage_discard'); break;
      default: actions = ''; // loading / applying / applied / superseded / discarded
    }
    const rejBtn = rejected > 0
      ? `<button class="btn btn-sm btn-ghost" data-brej="${Util.escapeHtml(b.batch_id)}" aria-expanded="${_rejectedOpen.has(b.batch_id)}">${Util.escapeHtml(Util.t('ui.sap_stage_rejected_rows'))} (${rejected})</button>` : '';
    return `<div class="sap-batch-row" data-batch="${Util.escapeHtml(b.batch_id)}">
      <div class="sap-batch-head">
        <span class="${Util.escapeHtml(sl.pillClass)}">${Util.escapeHtml(STAGE_STATUSES.indexOf(b.status) > -1 ? Util.t(`ui.sap_stage_status_${b.status}`) : String(b.status))}</span>
        <span class="sap-batch-plant">${Util.escapeHtml(b.plant)}</span>
        <span class="sap-batch-src">${Util.escapeHtml(b.source || '')}</span>
        ${c.total != null ? `<span class="sap-batch-counts sap-mono">${Util.escapeHtml(Util.t('ui.sap_stage_counts', { total: c.total, valid: c.valid ?? 0, rejected }))}</span>` : ''}
        ${vanish}
        <span class="sap-batch-actions">${rejBtn}${actions}</span>
      </div>
      <div class="sap-batch-times">${times}</div>
      ${heldBanner}${warns}${err}
      <div class="sap-batch-rej" id="sap-rej-${Util.escapeHtml(b.batch_id)}"${_rejectedOpen.has(b.batch_id) ? '' : ' hidden'}></div>
    </div>`;
  }

  async function _toggleRejected(bid: string, host: HTMLElement): Promise<void> {
    if (_rejectedOpen.has(bid)) {
      _rejectedOpen.delete(bid);
      const el = host.querySelector<HTMLElement>(`#sap-rej-${CSS.escape(bid)}`);
      if (el) el.hidden = true;
      host.querySelector(`[data-brej="${CSS.escape(bid)}"]`)?.setAttribute('aria-expanded', 'false');
      return;
    }
    _rejectedOpen.add(bid);
    host.querySelector(`[data-brej="${CSS.escape(bid)}"]`)?.setAttribute('aria-expanded', 'true');
    await _fillRejected(bid, host);
  }

  async function _fillRejected(bid: string, host: HTMLElement): Promise<void> {
    const el = host.querySelector<HTMLElement>(`#sap-rej-${CSS.escape(bid)}`);
    if (!el) return;
    el.hidden = false;
    el.innerHTML = `<div class="md-loading">${Util.escapeHtml(Util.t('ui.loading'))}</div>`;
    try {
      const d = await _getJson<{ rows: Record<string, unknown>[] }>(`/sap/staging/batches/${encodeURIComponent(bid)}/rejected?limit=50`);
      const rows = (d.rows || []).slice(0, 50);
      const csvBtn = `<button class="btn btn-sm btn-ghost" data-bcsv="${Util.escapeHtml(bid)}">${Util.escapeHtml(Util.t('ui.sap_stage_download_csv'))}</button>`;
      if (!rows.length) { el.innerHTML = `<div class="sap-help">${Util.escapeHtml(Util.t('ui.sap_stage_rejected_empty'))}</div>${csvBtn}`; }
      else {
        // reject_reason first, then up to 7 further columns that carry data in the first rows.
        const keys = Object.keys(rows[0] as Record<string, unknown>).filter((k) => !STAGE_REJECT_HIDDEN_COLS.has(k));
        const cols = ['reject_reason', ...keys].filter((k) => rows.some((r) => r[k] != null && r[k] !== '')).slice(0, 8);
        const head = (k: string): string => (k === 'reject_reason' ? Util.t('ui.sap_stage_col_reason') : k);
        const cell = (r: Record<string, unknown>, k: string): string =>
          (k === 'reject_reason' ? stageRejectText(r[k]) : (r[k] == null ? '' : String(r[k])));
        el.innerHTML = `<div class="sap-batch-rej-scroll"><table class="sap-batch-table"><thead><tr>${cols.map((k) => `<th>${Util.escapeHtml(head(k))}</th>`).join('')}</tr></thead><tbody>${
          rows.map((r) => `<tr>${cols.map((k) => `<td>${Util.escapeHtml(cell(r, k))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
          <div class="sap-help">${Util.escapeHtml(Util.t('ui.sap_stage_rejected_shown', { count: rows.length }))}</div>${csvBtn}`;
      }
      el.querySelector<HTMLButtonElement>('[data-bcsv]')?.addEventListener('click', () =>
        void _downloadCsv(`/sap/staging/batches/${encodeURIComponent(bid)}/rejected?format=csv`, `rejected_${bid.slice(0, 8)}.csv`));
    } catch (e) {
      el.innerHTML = `<div class="sap-help">${Util.escapeHtml((e as Error).message)}</div>`;
    }
  }

  /** Confirm-and-apply modal. Opens for a held batch (lists the held warnings) and for any batch whose
   *  apply would delete rows (`counts.vanish_candidates` > 0), listing the exact rows. For planned
   *  orders it says plainly that running orders are deleted too and stay recoverable for 30 days (D21). */
  async function _confirmApply(b: StageBatch): Promise<boolean> {
    const warnings = b.warnings || [];
    const held = b.status === 'held';
    const candidates = b.counts?.vanish_candidates ?? 0;
    const reasons = held ? warnings.map((w) => `<li>${Util.escapeHtml(stageWarningText(w, b.object_key))}</li>`).join('') : '';
    let deletions = '';
    let notice = '';
    if (warnings.some((w) => w.code === 'vanish_threshold') || candidates > 0) {
      try {
        const d = await _getJson<{ orders: StageDeletion[] }>(`/sap/staging/batches/${encodeURIComponent(b.batch_id)}/deletions`);
        const orders = d.orders || [];
        const shown = orders.slice(0, 200);
        // Master-object batches (material plants, production versions, routings) return a generic `key`
        // per row; planned-order batches return the full order columns.
        const generic = orders.length > 0 && orders.every((x) => x.key != null);
        const row = (x: StageDeletion): string => {
          if (generic) return `<tr><td>${Util.escapeHtml(x.key ?? '')}</td></tr>`;
          // Two separate flags (universal firm D5): the planner's firm locks the order in NIMBUS; the SAP firming
          // indicator is display-only. The old single "Firmed" column mixed them.
          const plannerFirm = !!x.manual_firmed;
          const sapFirmed = String(x.firming_indicator ?? '').trim().toUpperCase() === 'X';
          return `<tr><td>${Util.escapeHtml(x.production_order ?? '')}</td><td>${Util.escapeHtml(x.material_number ?? '')}</td>`
            + `<td>${Util.escapeHtml(x.machine ?? '')}</td><td>${Util.escapeHtml(_fmtTs(x.scheduled_end ?? null))}</td>`
            + `<td>${plannerFirm ? Util.escapeHtml(Util.t('ui.sap_stage_firmed_yes')) : ''}</td>`
            + `<td>${sapFirmed ? 'X' : ''}</td>`
            + `<td>${x.running ? `<b>${Util.escapeHtml(Util.t('ui.sap_stage_running_yes'))}</b>` : ''}</td></tr>`;
        };
        const head = generic
          ? `<th>${Util.escapeHtml(Util.t('ui.sap_stage_col_key'))}</th>`
          : `<th>${Util.escapeHtml(Util.t('ui.sap_stage_col_order'))}</th><th>${Util.escapeHtml(Util.t('col.material'))}</th><th>${Util.escapeHtml(Util.t('col.machine'))}</th>
            <th>${Util.escapeHtml(Util.t('ui.sap_stage_col_end'))}</th><th>${Util.escapeHtml(Util.t('ui.sap_stage_col_firmed'))}</th><th>${Util.escapeHtml(Util.t('ui.sap_stage_col_sap_firmed'))}</th><th>${Util.escapeHtml(Util.t('ui.sap_stage_col_running'))}</th>`;
        if (!generic && orders.length > 0) {
          const running = orders.filter((x) => x.running).length;
          notice = `<div class="sap-banner sap-banner-err"><span class="sap-banner-ico">⚠</span><div><b>${Util.escapeHtml(Util.t('ui.sap_stage_delete_notice'))}</b>`
            + `${running > 0 ? ` ${Util.escapeHtml(Util.t('ui.sap_stage_delete_running_count', { count: running }))}` : ''}</div></div>`;
        }
        deletions = `<div class="sap-section-label">${Util.escapeHtml(Util.t(generic ? 'ui.sap_stage_deletions_rows' : 'ui.sap_stage_deletions'))} (${orders.length})</div>
          <div class="sap-stage-deletions"><table class="sap-batch-table"><thead><tr>${head}</tr></thead>
            <tbody>${shown.map(row).join('')}</tbody></table></div>
          ${orders.length > shown.length ? `<div class="sap-help">${Util.escapeHtml(Util.t('ui.sap_stage_deletions_more', { count: orders.length - shown.length }))}</div>` : ''}`;
      } catch (e) {
        deletions = `<div class="sap-help">${Util.escapeHtml((e as Error).message)}</div>`;
      }
    }
    const label = Util.t(held ? 'ui.sap_stage_confirm_apply' : 'ui.sap_stage_apply');
    return Modal.confirm({
      title: label,
      message: Util.t(held ? 'ui.sap_stage_confirm_msg' : 'ui.sap_stage_confirm_delete_msg', { plant: b.plant, count: candidates }),
      detail: `${reasons ? `<ul class="sap-stage-reasons">${reasons}</ul>` : ''}${notice}${deletions}`,
      confirmLabel: label,
      tone: 'danger',
    });
  }

  async function _stageAction(b: StageBatch, act: string, btn: HTMLButtonElement): Promise<void> {
    if (stageApplyNeedsConfirm(b, act) && !(await _confirmApply(b))) return;
    btn.disabled = true;
    const base = `/sap/staging/batches/${encodeURIComponent(b.batch_id)}`;
    if (act === 'validate') {
      if (await _stagePost(`${base}/validate`, {}, 'toast.sap_stage_failed')) Toast.show(Util.t('toast.sap_stage_validated'), 'success');
    } else if (act === 'discard') {
      if (await _stagePost(`${base}/discard`, {}, 'toast.sap_stage_failed')) Toast.show(Util.t('toast.sap_stage_discarded'), 'info');
    } else {
      const res = await _stagePost(`${base}/apply`, act === 'confirm' ? { confirm_held: true } : {}, 'toast.sap_stage_apply_failed');
      if (res) Toast.show(Util.t('toast.sap_stage_applied'), 'success');
    }
    await _reload();
  }

  async function _uploadToStaging(o: SapObject, fileEl: HTMLInputElement | null, btn: HTMLButtonElement): Promise<void> {
    const f = fileEl && fileEl.files && fileEl.files[0];
    if (!f || !_stagePlant) return;
    btn.disabled = true;
    const fd = new FormData();
    fd.append('file', f);
    fd.append('plant', _stagePlant);
    const res = await _stagePost<{ rows_staged?: number; rows_skipped?: number; status?: string }>(
      `/sap/staging/upload/${encodeURIComponent(o.object_key)}`, fd, 'toast.sap_stage_failed');
    if (res) {
      Toast.show(Util.t('toast.sap_stage_uploaded', { staged: res.rows_staged ?? 0, skipped: res.rows_skipped ?? 0, status: res.status ?? '' }), 'success', 4000);
    }
    await _reload();
  }

  // Outbound panel (planned orders only): ready / sent / error tiles + Send to SAP.
  async function _renderOutbound(o: SapObject, body: HTMLElement): Promise<void> {
    const host = document.getElementById('sap-stage-outbound');
    if (!host) return;
    const current = _beginStageRead(o, body, host);
    host.innerHTML = `<div class="md-loading">${Util.escapeHtml(Util.t('ui.loading'))}</div>`;
    const title = `<div class="sap-section-label">${Util.escapeHtml(Util.t('ui.sap_outbound'))}</div>`;
    const plant = _stagePlant;
    if (!plant) {
      host.innerHTML = `${title}<div class="sap-help">${Util.escapeHtml(Util.t('ui.sap_stage_plant_required'))}</div>
        <button class="btn btn-sm btn-primary" disabled>${Util.escapeHtml(Util.t('ui.sap_send_to_sap'))}</button>`;
      return;
    }
    try {
      const s = await _getJson<SendStatus>(`/sap/staging/send/${encodeURIComponent(plant)}/status`);
      if (!current()) return;
      const tile = (key: string, n: number, cls: string) =>
        `<div class="kpi-tile${cls ? ' ' + cls : ''}"><div class="k">${Util.escapeHtml(Util.t(key))}</div><div class="v">${n}</div></div>`;
      host.innerHTML = `${title}
        <div class="sap-stage-tiles">${tile('ui.sap_send_status_ready', s.ready ?? 0, '')}${tile('ui.sap_send_status_sent', s.sent ?? 0, '')}${tile('ui.sap_send_status_error', s.error ?? 0, (s.error ?? 0) > 0 ? 'err' : '')}</div>
        <div class="sap-kv sap-stage-kv"><span>${Util.escapeHtml(Util.t('ui.sap_outbound_last_queued'))}</span><span>${Util.escapeHtml(_fmtTs(s.last_queued_at))}</span>
          <span>${Util.escapeHtml(Util.t('ui.sap_outbound_last_sent'))}</span><span>${Util.escapeHtml(_fmtTs(s.last_sent_at))}</span></div>
        <div class="sap-stage-panel-actions">
          <button class="btn btn-sm btn-primary" id="sap-send-btn">${Util.escapeHtml(Util.t('ui.sap_send_to_sap'))}</button>
          <button class="btn btn-sm btn-ghost" id="sap-send-errcsv">${Util.escapeHtml(Util.t('ui.sap_outbound_error_csv'))}</button>
        </div>`;
      document.getElementById('sap-send-btn')?.addEventListener('click', (e) => { void _sendToSap(plant, e.currentTarget as HTMLButtonElement); });
      document.getElementById('sap-send-errcsv')?.addEventListener('click', () =>
        void _downloadCsv(`/sap/staging/send/${encodeURIComponent(plant)}/rows?status=error&format=csv`, `sap_send_errors_${plant}.csv`));
    } catch (e) {
      if (!current()) return;
      host.innerHTML = `${title}<div class="sap-help">${Util.escapeHtml((e as Error).message)}</div>`;
    }
  }

  async function _sendToSap(plant: string, btn: HTMLButtonElement): Promise<void> {
    const ok = await Modal.confirm({
      title: Util.t('ui.sap_send_to_sap'),
      message: Util.t('ui.sap_send_confirm', { plant: Store.plantLabel ? Store.plantLabel(plant) : plant }),
      confirmLabel: Util.t('ui.sap_send_to_sap'),
      tone: 'warn',
    });
    if (!ok) return;
    btn.disabled = true;
    const res = await _stagePost<{ queued?: number; skipped_unfirmed?: number }>(`/sap/staging/send/${encodeURIComponent(plant)}`, {}, 'toast.sap_stage_failed');
    if (res) {
      const skipped = res.skipped_unfirmed ?? 0;
      const text = Util.t('toast.sap_sent_queued', { queued: res.queued ?? 0 })
        + (skipped > 0 ? ' ' + Util.t('toast.sap_sent_skipped_unfirmed', { count: skipped }) : '');
      Toast.show(text, 'success', 4000);
    }
    await _reload();
  }

  // Archive panel (planned orders only): vanish-deleted orders of the last 30 days, with Restore.
  async function _renderArchive(o: SapObject, body: HTMLElement): Promise<void> {
    const host = document.getElementById('sap-stage-archive');
    if (!host) return;
    const current = _beginStageRead(o, body, host);
    host.innerHTML = `<div class="md-loading">${Util.escapeHtml(Util.t('ui.loading'))}</div>`;
    const title = `<div class="sap-section-label">${Util.escapeHtml(Util.t('ui.sap_archive'))}</div>`;
    const plant = _stagePlant;
    if (!plant) { host.innerHTML = `${title}<div class="sap-help">${Util.escapeHtml(Util.t('ui.sap_stage_plant_required'))}</div>`; return; }
    try {
      const params = new URLSearchParams({ limit: '50', offset: String(_archiveOffset), search: _archiveSearch });
      const d = await _getJson<{ orders: ArchivedOrder[]; has_more?: boolean }>(`/sap/staging/archive/${encodeURIComponent(plant)}?${params}`);
      if (!current()) return;
      const orders = d.orders || [];

      const row = (a: ArchivedOrder): string => `<tr>
        <td>${Util.escapeHtml(a.production_order ?? a.order_id ?? '')}</td><td>${Util.escapeHtml(a.material_number ?? '')}</td><td>${Util.escapeHtml(a.machine ?? '')}</td>
        <td>${Util.escapeHtml(_fmtTs(a.deleted_at))}</td><td>${Util.escapeHtml(a.deleted_by ?? '')}</td>
        <td>${a.restored_at
          ? `${Util.escapeHtml(Util.t('ui.sap_archive_restored'))} ${Util.escapeHtml(_fmtTs(a.restored_at))}`
          : `<button class="btn btn-sm" data-restore="${Util.escapeHtml(String(a.id))}">${Util.escapeHtml(Util.t('ui.sap_archive_restore'))}</button>`}</td></tr>`;
      const controls = `<form data-archive-search class="sap-stage-panel-actions"><input class="input" type="search" maxlength="200" aria-label="${Util.escapeHtml(Util.t('ui.sap_archive_search'))}" placeholder="${Util.escapeHtml(Util.t('ui.sap_archive_search'))}" value="${Util.escapeHtml(_archiveSearch)}"><button class="btn btn-sm" type="submit">${Util.escapeHtml(Util.t('btn.search'))}</button></form>`;
      const pager = `<div class="sap-stage-panel-actions"><button class="btn btn-sm" data-archive-prev ${_archiveOffset === 0 ? 'disabled' : ''}>${Util.escapeHtml(Util.t('btn.setup_list_prev'))}</button><span>${_archiveOffset + (orders.length ? 1 : 0)}–${_archiveOffset + orders.length}</span><button class="btn btn-sm" data-archive-next ${d.has_more ? '' : 'disabled'}>${Util.escapeHtml(Util.t('btn.setup_list_next'))}</button></div>`;
      host.innerHTML = `${title}${controls}<div class="sap-batch-rej-scroll"><table class="sap-batch-table"><thead><tr>
        <th>${Util.escapeHtml(Util.t('ui.sap_stage_col_order'))}</th><th>${Util.escapeHtml(Util.t('col.material'))}</th><th>${Util.escapeHtml(Util.t('col.machine'))}</th>
        <th>${Util.escapeHtml(Util.t('ui.sap_stage_col_deleted_at'))}</th><th>${Util.escapeHtml(Util.t('ui.sap_stage_col_deleted_by'))}</th><th></th></tr></thead>
        <tbody>${orders.map(row).join('')}</tbody></table></div>${orders.length ? '' : `<div class="sap-help">${Util.escapeHtml(Util.t('ui.sap_archive_empty'))}</div>`}${pager}`;
      host.querySelector('[data-archive-search]')?.addEventListener('submit', e => {
        e.preventDefault(); _archiveSearch = host.querySelector<HTMLInputElement>('input[type=search]')!.value.trim(); _archiveOffset = 0; void _renderArchive(o, body);
      });
      host.querySelector('[data-archive-prev]')?.addEventListener('click', () => { _archiveOffset = Math.max(0, _archiveOffset - 50); void _renderArchive(o, body); });
      host.querySelector('[data-archive-next]')?.addEventListener('click', () => { _archiveOffset += 50; void _renderArchive(o, body); });
      host.querySelectorAll<HTMLButtonElement>('[data-restore]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const a = orders.find((x) => String(x.id) === btn.dataset.restore);
          if (a) void _restoreArchived(a, btn);
        }));
    } catch (e) {
      if (!current()) return;
      host.innerHTML = `${title}<div class="sap-help">${Util.escapeHtml((e as Error).message)}</div>`;
    }
  }

  async function _restoreArchived(a: ArchivedOrder, btn: HTMLButtonElement): Promise<void> {
    const ok = await Modal.confirm({
      title: Util.t('ui.sap_archive_restore'),
      message: Util.t('ui.sap_archive_restore_confirm', { order: a.production_order ?? a.order_id }),
      confirmLabel: Util.t('ui.sap_archive_restore'),
    });
    if (!ok) return;
    btn.disabled = true;
    const res = await _stagePost(`/sap/staging/archive/${encodeURIComponent(String(a.id))}/restore`, {}, 'toast.sap_stage_failed');
    if (res) Toast.show(Util.t('toast.sap_archive_restored'), 'success');
    await _reload();
  }

  // -----------------------------------------------------------------------
  // History tab — run timeline (status, counts, duration, watermark, errors)
  // -----------------------------------------------------------------------
  async function _renderHistory(o: SapObject): Promise<void> {
    const body = document.getElementById('sap-tabbody');
    if (!body) return;
    const current = () => document.getElementById('sap-tabbody') === body && _tab === 'history' && _selected === o.object_key;
    body.innerHTML = `<div class="md-loading">${Util.escapeHtml(Util.t('ui.loading'))}</div>`;
    try {
      // Fetch both SAP runs and SAP-related upload audit entries
      const params = new URLSearchParams({ limit: '50', object: o.object_key });
      const runsData: SapRunsResponse = await Util.fetchTraced(`${API}/sap/interface/runs?${params.toString()}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });

      if (!current()) return;

      // Also fetch upload audit for SAP syncs (filename='sap:sap')
      const auditData: SapUploadAuditResponse = await Util.fetchTraced(`${API}/upload/audit?source=sap&limit=50`).then((r) => {
        if (!r.ok) return { audit: [] };
        return r.json().catch(() => ({ audit: [] }));
      });

      if (!current()) return;
      const runs = runsData.runs || [];

      // The server already filtered to SAP syncs (?source=sap) before applying the limit.
      const sapAuditItems = auditData.audit || [];

      if (!runs.length && !sapAuditItems.length) {
        body.innerHTML = `<div class="sap-empty"><div class="sap-empty-ico">◍</div><div class="sap-empty-t">${Util.escapeHtml(Util.t('ui.sap_no_runs'))}</div><div class="sap-empty-d">${Util.escapeHtml(Util.t('ui.sap_no_runs_hint'))}</div>${o.kind === 'staging' ? '' : `<button class="btn btn-sm" data-act-empty="dry">${Util.escapeHtml(Util.t('ui.sap_dry_run'))}</button>`}</div>`;
        body.querySelector('[data-act-empty]')?.addEventListener('click', () => _runNow(o.object_key, true, null));
        return;
      }

      // Build combined history: runs + audit entries with distribution warnings
      let html = '<div class="sap-feed">';
      html += runs.map((rn, i) => _runRow(rn, i)).join('');

      // Add distribution warnings from upload audit
      for (const item of sapAuditItems) {
        const distWarning = item.warnings?.find(w => (w as SapUploadWarning).category === 'distribution') as SapUploadWarning | undefined;
        if (distWarning) {
          html += _renderSapAuditRow(item, distWarning);
        }
      }

      html += '</div>';
      body.innerHTML = html;
      body.querySelectorAll<HTMLElement>('[data-exp]').forEach((b) =>
        b.addEventListener('click', () => b.closest('.sap-run')?.classList.toggle('open')));

      // Wire up distribution detail toggles and populate them
      body.querySelectorAll<HTMLElement>('[data-dist-exp]').forEach((btn) => {
        const item = btn.closest('.sap-dist-item') as HTMLElement | null;
        if (!item) return;
        const detailDiv = item.querySelector('.sap-dist-detail') as HTMLElement | null;
        if (!detailDiv) return;

        // Find the corresponding batch_id and populate details
        const batchTitle = item.querySelector('.sap-run-batch')?.getAttribute('title');
        const auditItem = sapAuditItems.find(x => x.batch_id === batchTitle);
        if (auditItem) {
          const distWarning = auditItem.warnings?.find(w => (w as SapUploadWarning).category === 'distribution') as SapUploadWarning | undefined;
          if (distWarning) {
            detailDiv.appendChild(_renderSapDistributionWarning(distWarning, auditItem.batch_id));
          }
        }

        btn.addEventListener('click', () => {
          const isOpen = item.classList.contains('open');
          item.classList.toggle('open');
          detailDiv.style.display = isOpen ? 'none' : '';
          btn.textContent = isOpen ? 'details ▾' : 'details ▴';
        });
      });
    } catch (e) {
      if (!current()) return;
      body.innerHTML = `<div class="sap-empty"><div class="sap-empty-t">${Util.escapeHtml(Util.t('ui.sap_runs_load_failed'))}</div><div class="sap-empty-d">${Util.escapeHtml((e as Error).message)}</div></div>`;
      ErrorLog.error('sap-interface', `Load runs failed: ${(e as Error).message}`);
    }
  }

  function _renderSapAuditRow(item: SapUploadAuditItem, distWarning: SapUploadWarning): string {
    const date = item.uploaded_at ? _fmtTs(item.uploaded_at) : '—';
    const batchShort = item.batch_id ? item.batch_id.slice(0, 8) + '…' : '—';
    return `<div class="sap-dist-item">
      <div class="sap-dist-head">
        <span class="sap-pill info">distribution</span>
        <span class="sap-run-t">${Util.escapeHtml(date)}</span>
        <span class="sap-run-by">SAP sync</span>
        <span class="sap-run-batch" title="${Util.escapeHtml(item.batch_id)}">${Util.escapeHtml(batchShort)}</span>
        <button class="sap-exp" data-dist-exp>details ▾</button>
      </div>
      <div class="sap-dist-detail" style="display:none; padding:12px; background:rgba(0,0,0,0.02); margin:8px 0;">
      </div>
    </div>`;
  }

  function _runRow(rn: SapRun, i: number): string {
    const status = rn.status || 'unknown';
    const cls = status === 'ok' ? 'ok' : (status === 'error' ? 'err' : 'info');
    const pill = status === 'ok' ? '<span class="sap-pill ok">ok</span>'
      : (status === 'error' ? '<span class="sap-pill err">error</span>' : `<span class="sap-pill info">${Util.escapeHtml(status)}</span>`);
    const dur = _dur(rn.started_at, rn.ended_at);
    const counts = `read ${rn.rows_read ?? 0} · <span class="ins">+${rn.rows_inserted ?? 0} ins</span> / <span class="upd">~${rn.rows_updated ?? 0} upd</span> / <span class="fail">!${rn.rows_failed ?? 0} fail</span>`;
    const wm = (rn.watermark_before || rn.watermark_after)
      ? `<div class="sap-run-wm">watermark ${Util.escapeHtml(rn.watermark_before || '∅')} → ${Util.escapeHtml(rn.watermark_after || '∅')}</div>` : '';
    const err = rn.error
      ? `<div class="sap-run-err"><button class="sap-exp" data-exp="${i}">view error ▾</button><pre>${Util.escapeHtml(rn.error)}</pre></div>` : '';
    return `<div class="sap-run ${cls}"><div class="sap-run-head">${pill}<span class="sap-run-t">${Util.escapeHtml(_fmtTs(rn.started_at))}</span><span class="sap-run-by">${Util.escapeHtml(rn.triggered_by || 'manual')}</span>${dur ? `<span class="sap-run-dur">${Util.escapeHtml(dur)}</span>` : ''}</div><div class="sap-run-counts">${counts}</div>${wm}${err}</div>`;
  }

  function _dur(a: string | null | undefined, b: string | null | undefined): string {
    if (!a || !b) return '';
    const d = (new Date(b).getTime() - new Date(a).getTime()) / 1000;
    if (isNaN(d) || d < 0) return '';
    if (d < 1) return `${Math.round(d * 1000)}ms`;
    if (d < 60) return `${d.toFixed(1)}s`;
    return `${Math.floor(d / 60)}m ${Math.round(d % 60)}s`;
  }

  function _fmtTs(ts: string | null | undefined): string {
    if (!ts) return '—';
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return String(ts);
      return Util.fmtDTReadable ? Util.fmtDTReadable(d) : Util.fmtDT(d);
    } catch { return String(ts); }
  }

  // Render distribution warning details from upload_audit SAP entries
  function _renderSapDistributionWarning(entry: SapUploadWarning, batchId?: string): DocumentFragment {
    const frag = document.createDocumentFragment();
    if (entry.category !== 'distribution' || !entry.msg) return frag;

    // Formats one detail-list item (D49) — duplicated locally, same as
    // admin-ui.mts's _renderDistributionWarning (the established convention
    // for these two renderers): a string stays as-is; an object assembles
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
    summary.className = 'sap-dist-summary';
    summary.style.padding = '8px 0';
    summary.style.fontSize = '13px';
    const lvl = document.createElement('span');
    lvl.style.fontWeight = '600';
    lvl.style.marginRight = '8px';
    lvl.style.color = entry.level === 'warn' ? 'var(--warn,#b57a0a)' : 'var(--ok,#2f7a4d)';
    lvl.textContent = (entry.level || 'warn').toUpperCase() + ':';
    summary.appendChild(lvl);
    const msg = document.createElement('span');
    msg.textContent = entry.msg;
    summary.appendChild(msg);
    frag.appendChild(summary);

    // Review link if there are created/refreshed distributions
    const created = entry.headers_created ?? 0;
    const refreshed = entry.headers_refreshed ?? 0;
    const total = created + refreshed;
    if (total > 0 && batchId) {
      const linkRow = document.createElement('div');
      linkRow.style.padding = '4px 0';
      const link = document.createElement('a');
      link.href = '#';
      link.style.color = 'var(--accent,#0066cc)';
      link.style.textDecoration = 'underline';
      link.style.fontSize = '13px';
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
    const listFields: Array<{ key: keyof SapUploadWarning; label: string }> = [
      { key: 'conflicting_parent_rows', label: 'ui.conflicting_parent_rows' },
      { key: 'ambiguous_plant', label: 'ui.ambiguous_plant_conflicts' },
      { key: 'workcenter_without_members', label: 'ui.workcenter_without_members' },
      { key: 'default_machine_invalid', label: 'ui.default_machine_invalid' },
    ];

    for (const field of listFields) {
      const items = entry[field.key] as unknown[];
      if (!items || items.length === 0) continue;

      const row = document.createElement('div');
      row.style.padding = '4px 0';
      const header = document.createElement('div');
      header.style.cursor = 'pointer';
      header.style.fontSize = '12px';
      header.style.color = 'var(--text-muted,#666)';
      header.textContent = `${Util.t(field.label)} (${items.length}) ▾`;
      row.appendChild(header);

      const detail = document.createElement('div');
      detail.style.display = 'none';
      detail.style.padding = '4px 0 4px 8px';
      detail.style.fontSize = '12px';
      detail.style.fontFamily = 'monospace';
      detail.style.borderLeft = '2px solid var(--text-muted,#ccc)';
      const pre = document.createElement('pre');
      pre.style.margin = '0';
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.wordBreak = 'break-word';
      pre.style.fontSize = '11px';
      pre.textContent = items.map(fmt).join('\n');
      detail.appendChild(pre);
      row.appendChild(detail);

      header.addEventListener('click', () => {
        detail.style.display = detail.style.display === 'none' ? '' : 'none';
        header.textContent = detail.style.display === 'none'
          ? `${Util.t(field.label)} (${items.length}) ▾`
          : `${Util.t(field.label)} (${items.length}) ▴`;
      });
      frag.appendChild(row);
    }

    return frag;
  }

  return {
    render,
    // Test-only hook (ForTest precedent: setup-scheduler.mts's
    // fragmentObjectiveFactsForTest/checkDistributionSeparationForTest) —
    // _renderSapDistributionWarning itself stays closure-private; this just
    // exposes it to tests/modules/integration/sap-interface-ui.test.mjs,
    // which otherwise cannot reach a non-exported module-scope function.
    _renderSapDistributionWarningForTest: _renderSapDistributionWarning,
    // Pure staging formatters (no DOM) — same ForTest precedent, for the same test file.
    _stageStatusLineForTest: stageStatusLine,
    _applyModeHintForTest: applyModeHint,
    _stageWarningTextForTest: stageWarningText,
    _stageRejectTextForTest: stageRejectText,
    _stageErrorCodeTextForTest: stageErrorCodeText,
    _stageApplyNeedsConfirmForTest: stageApplyNeedsConfirm,
    _pollCountsForTest: pollCounts,
    _renderHistoryForTest: (key: string) => {
      _selected = key; _tab = 'history';
      return _renderHistory({ object_key: key } as SapObject);
    },
    _loadStagePanelForTest: (panel: 'batches' | 'outbound' | 'archive', plant: string, body: HTMLElement) => {
      _stagePlant = plant; _tab = 'staging'; _selected = 'stage_planned_orders';
      const object = { object_key: _selected } as SapObject;
      return panel === 'batches' ? _loadBatches(object, body) : panel === 'outbound' ? _renderOutbound(object, body) : _renderArchive(object, body);
    },
  };
})();

