// integration/sap-interface-ui.mjs — SAP integration console (Admin ->
// Interface sub-tab). Extracted verbatim from
// plant-and-administration.mts (Phase P2 of
// docs/architecture/domain-refactor-plan.md, which split that
// 11,308-line mega-module into 9 domain files).
import { Config, Util, ErrorLog, Toast } from '../platform/foundation.mjs';
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
  kind?: 'master' | 'orders';
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
  let _tab: 'overview' | 'mapping' | 'history' = 'overview'; // active detail tab
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
      _objects = data.objects || [];
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
    const rows = _objects.map((o) => {
      const sel = o.object_key === _selected ? ' sap-rail-row-sel' : '';
      const lr = o.last_run;
      const dotCls = !lr ? '' : (lr.status === 'ok' ? 'ok' : (lr.status === 'error' ? 'err' : (lr.status === 'running' ? 'warn' : '')));
      const statusTxt = !lr ? Util.t('ui.sap_never_run')
        : (lr.status === 'ok' ? `ok · ${_relTime(lr.started_at)}`
        : (lr.status === 'error' ? `failed · ${_relTime(lr.started_at)}` : lr.status));
      const kind = o.kind || 'master';
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
    }).join('');
    el.innerHTML = `<div class="panel">
      <div class="panel-head"><span class="sap-section-label">${Util.escapeHtml(Util.t('ui.sap_objects'))}</span>
        <span class="sap-hint">${_objects.filter((o) => o.enabled).length} / ${_objects.length}</span></div>
      <div class="sap-rail">${rows}</div></div>`;
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
    const tabBtn = (id: string, label: string) => `<button class="sap-tab${_tab === id ? ' sap-tab-active' : ''}" data-tab="${id}">${Util.escapeHtml(label)}</button>`;
    el.innerHTML = `<div class="panel">
      <div class="sap-detail-head">
        <span class="sap-detail-name">${Util.escapeHtml(o.label || o.object_key)}</span>
        <span class="sap-kind sap-kind-${Util.escapeHtml(kind)}">${Util.escapeHtml(kind)}</span>
        <span class="sap-detail-key">${Util.escapeHtml(o.object_key)}</span>
        <div class="sap-detail-actions">
          <button class="btn btn-sm" data-act="dry">${Util.escapeHtml(Util.t('ui.sap_dry_run'))}</button>
          <button class="btn btn-sm btn-primary" data-act="run">${Util.escapeHtml(Util.t('ui.sap_run_now'))} ▸</button>
        </div>
      </div>
      <div class="sap-tabs">${tabBtn('overview', Util.t('ui.sap_overview'))}${tabBtn('mapping', Util.t('ui.sap_mapping'))}${tabBtn('history', Util.t('ui.sap_history'))}</div>
      <div class="sap-tabbody" id="sap-tabbody"><div class="md-loading">${Util.escapeHtml(Util.t('ui.loading'))}</div></div>
    </div>`;
    el.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => { _tab = b.dataset.tab as 'overview' | 'mapping' | 'history'; _renderDetail(); }));
    el.querySelectorAll<HTMLElement>('[data-act]').forEach((b) =>
      b.addEventListener('click', () => _runNow(o.object_key, b.dataset.act === 'dry', b as HTMLButtonElement)));
    if (_tab === 'overview') _renderOverview(o);
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
      const res: SapTestConnectionResult = await fetch(`${API}/sap/interface/test-connection`, {
        method: 'POST', headers: _writeHeaders(),
        body: JSON.stringify({ transport, source_params: params }),
      }).then((r) => { if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); }); return r.json(); });
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
      await fetch(`${API}/sap/interface/config/${encodeURIComponent(object)}`, {
        method: 'POST', headers: _writeHeaders(), body: JSON.stringify(patch),
      }).then((r) => { if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); }); return r.json(); });
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
      const res: SapSyncResult = await fetch(`${API}/sap/interface/sync/${encodeURIComponent(object)}`, {
        method: 'POST', headers: _writeHeaders(), body: JSON.stringify({ dry_run: !!dryRun }),
      }).then((r) => { if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); }); return r.json(); });
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
    const keys = MASTER_KEYS[o.object_key] || [];
    const rails = `<div class="sap-flow-rails"><span class="sap-fr">▤ ${Util.escapeHtml(Util.t('ui.sap_field'))}</span><span class="sap-fr c">${Util.escapeHtml(Util.t('ui.sap_transform'))}</span><span class="sap-fr r">${Util.escapeHtml(Util.t('ui.sap_nimbus_column'))} ◆</span></div>`;

    if (!st.rows.length) {
      body.innerHTML = `${isMaster ? _keystrip(o, st) : ''}
        <div class="sap-banner sap-banner-info"><span class="sap-banner-ico">→</span><div>${isMaster ? Util.escapeHtml(Util.t('ui.sap_map_primer_master')) : Util.escapeHtml(Util.t('ui.sap_map_primer_orders'))}</div></div>
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
      await fetch(`${API}/sap/interface/mappings/${encodeURIComponent(object)}`, {
        method: 'POST', headers: _writeHeaders(), body: JSON.stringify({ mappings }),
      }).then((r) => { if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); }); return r.json() as Promise<SapMappingsSaveResult>; });
      delete _mapState[object];
      Toast.show(Util.t('toast.sap_mappings_saved'), 'success');
      await _reload();
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('sap-interface', `Save mappings failed for ${object}: ${(e as Error).message}`);
    }
  }

  // -----------------------------------------------------------------------
  // History tab — run timeline (status, counts, duration, watermark, errors)
  // -----------------------------------------------------------------------
  async function _renderHistory(o: SapObject): Promise<void> {
    const body = document.getElementById('sap-tabbody');
    if (!body) return;
    body.innerHTML = `<div class="md-loading">${Util.escapeHtml(Util.t('ui.loading'))}</div>`;
    try {
      const params = new URLSearchParams({ limit: '50', object: o.object_key });
      const data: SapRunsResponse = await Util.fetchTraced(`${API}/sap/interface/runs?${params.toString()}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
      if (document.getElementById('sap-tabbody') !== body || _tab !== 'history' || _selected !== o.object_key) return;
      const runs = data.runs || [];
      if (!runs.length) {
        body.innerHTML = `<div class="sap-empty"><div class="sap-empty-ico">◍</div><div class="sap-empty-t">${Util.escapeHtml(Util.t('ui.sap_no_runs'))}</div><div class="sap-empty-d">${Util.escapeHtml(Util.t('ui.sap_no_runs_hint'))}</div><button class="btn btn-sm" data-act-empty="dry">${Util.escapeHtml(Util.t('ui.sap_dry_run'))}</button></div>`;
        body.querySelector('[data-act-empty]')?.addEventListener('click', () => _runNow(o.object_key, true, null));
        return;
      }
      body.innerHTML = `<div class="sap-feed">${runs.map((rn, i) => _runRow(rn, i)).join('')}</div>`;
      body.querySelectorAll<HTMLElement>('[data-exp]').forEach((b) =>
        b.addEventListener('click', () => b.closest('.sap-run')?.classList.toggle('open')));
    } catch (e) {
      body.innerHTML = `<div class="sap-empty"><div class="sap-empty-t">${Util.escapeHtml(Util.t('ui.sap_runs_load_failed'))}</div><div class="sap-empty-d">${Util.escapeHtml((e as Error).message)}</div></div>`;
      ErrorLog.error('sap-interface', `Load runs failed: ${(e as Error).message}`);
    }
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
      return Util.fmtDTReadable ? Util.fmtDTReadable(d) : d.toLocaleString();
    } catch { return String(ts); }
  }

  return { render };
})();

