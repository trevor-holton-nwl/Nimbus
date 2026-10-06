// scheduling/persistence.mjs — Persistence (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split schedule-data.mts
// (2,204 lines) into 3 domain files). Owns backend fetch + localStorage
// cache, demo fallback, and save. Must NEVER import from
// optimization/engine.mjs, calendar/calendar-engine.mjs, or
// insights/services.mjs — only the reverse direction is allowed. The two
// real cross-package dependencies below predate this phase (Phase 2
// research, schedule-data.mts's original split from app.js) and are
// preserved exactly as they were:
//   - Persistence._snapToWorkingHours/_dueEndOfShift call Calendar via an
//     injected seam, `Persistence.setCalendarService({...})`, wired once
//     from app.js boot glue after calendar/calendar-engine.mjs's Calendar is
//     available (see app.js's bridge destructure) — never a direct import.
//   - Persistence used to call `Alerts.scheduleRecompute()` after every
//     hydration. It emits a `{ type: 'schedule:hydrated', source }` Store
//     event instead; optimization/engine.mjs subscribes to it once.
//
// `CalendarSync` (calendar/calendar-sync.mjs) is a real cross-file import
// forming a two-way ESM cycle with that module — CalendarSync's flush path
// calls back into this file's `_dirtyIds`/`_forceIds`/`_snapToWorkingHours`/
// `_saveCache`/`_relayDueDateCorrections` (see calendar/calendar-sync.mjs's
// header comment). Safe under the same rule used throughout this split:
// every cross-reference is inside a method body invoked after both modules
// finish loading, never at top-level evaluation. This dependency predates
// this phase (it existed between two sibling consts in the single-file
// module) — the split only turns it into a real ESM cycle.
//
// Session's DOM/settings-pane half (gates, the user-settings modal, profile/
// password self-service — ~600 lines that used to live inline in the same
// IIFE) stays in app.js as `SessionUIAdapter` — see security/session.mjs's
// header comment. DOM/UI code that was co-located with these modules in
// app.js stays there — see docs/architecture/cq1-compatibility-inventory.md.
import { Config, Util, ErrorLog, Toast, Modal } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import { Sandbox } from '../optimization/sandbox.mjs';
import { CalendarSync } from '../calendar/calendar-sync.mjs';
import { Runtime } from '../routing/runtime-client.mjs';
import type { NimbusTask, NimbusBlock, NimbusPlantBlock, StoredState, NaiveLocalTs, PriorityRankMaps, SetupSnapshot, OrderScheduleSegment, NimbusMasterWorkcenter } from '../platform/types.mjs';
import type { components } from '../types/api-generated.mjs';

// -- Backend DTOs generated from brain.py's Pydantic response_model=s (Task 1/2
//    of this phase) — see docs/archive/typescript_migration.md §F. Endpoints brain.py
//    does not yet model (/health, /master-data/*) get hand-written local
//    interfaces below instead, per this phase's scope.
type TasksResponse        = components['schemas']['TasksResponse'];
type BulkUpdateResult     = components['schemas']['BulkUpdateResult'];
type TasksRefreshResponse = components['schemas']['TasksRefreshResponse'];
type BaselineCorrectResult = components['schemas']['BaselineCorrectResult'];

interface RefreshBaseline {
  edits: string;
  generation: number;
  collection: number;
  version: NimbusTask['row_version'];
}
const taskEditGenerations = new Map<string, number>();
let taskCollectionGeneration = 0;

// -- Local type declarations (Phase 4 conversion; scoped to this file, for the
//    endpoints Task 1 did not add a backend response_model= for) ------------

/** GET /master-data/plants and /master-data/machine share this
 *  envelope (master_data.py); `rows`' element shape differs per endpoint, so
 *  this is generic over it. */
interface MasterDataRowsResponse<T> {
  rows: T[];
}

interface MasterLineRow {
  machine: string;
  plant: string;
  wc_group?: string;
}

interface MasterPlantRow {
  subnetwork: string;
  plant: string;
  description?: string | null;
  product_focus?: string | null;
  timezone?: string | null;
  split_order_policy?: 'never' | 'overlong_only' | 'partial_allowed' | null;
  max_pull_forward_days?: number | null;
  max_push_forward_days?: number | null;
}

/** GET /health (brain.py) — only the fields this file reads are modeled;
 *  the reconnect watcher only cares that the request resolves 200. */
interface HealthResponse {
  db?: unknown;
  pool?: unknown;
  memory?: unknown;
  color_wheel?: unknown;
}

/** Per-attempt ceiling for the bulk save POST (loads use 5-8 s; a real bulk save is slower). */
const SAVE_TIMEOUT_MS = 60_000;

/** Lazily-added fields `saveAll`'s `_post` retry closure stamps onto a plain
 *  `Error` so both the retry-vs-terminal check and the rejection log can read
 *  them back — mirrors nimbus-worker.ts's `err as Error` idiom (Phase 0). */
interface SaveError extends Error {
  timedOut?: boolean;
  httpStatus?: number;
  errorCode?: string;
  reqId?: string;
}

/** Shape of `Persistence._lastLoad` / `Persistence.stats()`. Named (rather
 *  than referenced back via `typeof Persistence._lastLoad`, as this phase's
 *  brief originally suggested) because `typeof Persistence....` inside
 *  `Persistence`'s own object-literal method signatures is circular — TS
 *  needs the whole `Persistence` object's type to resolve `stats()`'s return
 *  type, which itself depends on `Persistence`'s type (TS2307/TS7022). A
 *  named interface breaks the cycle without changing any runtime shape. */
interface LoadStats {
  source: 'backend' | 'cache' | 'demo' | null;
  ts: string | null;
  plant: string | null;
  raw_received: number;
  backend_meta: Record<string, unknown> | null;
  color_merge_misses: number;
  missed_colors: string[];
  pre_color_merge_count: number;
  filtered_pl: number;
  filtered_null_id: number;
  dedup_collisions: number;
  rendered: number;
  errors: number;
}

/** The injected calendar-capacity seam (Persistence.setCalendarService) —
 *  this file must never import calendar/calendar-engine.mjs directly (see
 *  this file's header comment); this is the whole shape it's allowed to see. */
interface CalendarService {
  beginRun(plant: string | null): void;
  endRun(): void;
  nextAvailable(line: string, from: Date, durationMs: number): Date | null;
  workWindow(line: string, date: Date): [Date, Date] | null;
}

// Injected calendar-capacity seam — replaces the former direct `Calendar.*` references
// (this file must never import calendar/calendar-engine.mjs). Defaults to a no-op so a
// snap-affecting load path degrades to "skip snapping" instead of throwing when called
// before app.js's boot glue wires the real Calendar functions (see
// Persistence.setCalendarService below).
let _calendarService: CalendarService | null = null;
type SetupWriteKind = 'definition' | 'matrix' | 'state' | 'override';
let _setupWriteListener: ((plant: string, kind: SetupWriteKind) => void) | null = null;

/* =============================================================================
   PERSISTENCE — backend fetch, demo fallback, save + local cache.
   ========================================================================== */
/** D29 - one short, translated line naming WHICH orders the server rejected and why
 *  (the save response's sparse `rejection_reasons` {id: step} map), instead of a bare
 *  "N/M persisted". Shows the first `limit` and a "+N more" tail; unknown codes fall
 *  back to the raw code. `runtime_preview_changed` and `machine_unknown` are excluded: each has its own toast. */
export function describeRejections(reasons: Record<string, string> | undefined | null, limit = 3): string {
  const entries = Object.entries(reasons || {}).filter(([, code]) => code !== 'runtime_preview_changed' && code !== 'machine_unknown');
  if (!entries.length) return '';
  const label = (code: string): string => {
    const key = `ui.reject_${code}`;
    const text = Util.t(key);
    return text === key ? code : text;
  };
  const shown = entries.slice(0, limit).map(([id, code]) => `${id}: ${label(code)}`);
  const more = entries.length - shown.length;
  return shown.join('; ') + (more > 0 ? Util.t('ui.reject_more', { count: more }) : '');
}

export const Persistence = {
  // Plant the most recent load() was ASKED for, set before the fetch so it survives a failed
  // boot load (where _currentLoadedPlant is still null). _reconnect reloads this plant.
  _lastAttemptedPlant: null as string | null,
  _currentLoadedPlant: null as string | null,  // plant whose tasks are currently in Store (null = all plants)
  // Stage 3: plant whose priority rank maps Store.priorityRankMaps currently reflects
  // (null = none/unknown). Mirrors _currentLoadedPlant's own role for tasks/calendars —
  // set only on a TRUE success (2xx response), never on a network exception NOR a
  // resolved-but-non-ok response (a transient 5xx on a single-replica restart, or a
  // corp-proxy pre-roll response — both real scenarios in this codebase), so a caller
  // that needs freshness (e.g. OptimizerPreview.runWithPreview, Task 6) can compare this
  // against the plant it's about to run against and await loadPriorityRankMaps again if
  // they don't match, instead of wrongly trusting an empty cache as "fresh".
  _rankMapsPlant: null as string | null,
  // The setup snapshot is observation-only and always represents one plant.
  // The request counter suppresses a late prior-plant response after a switch.
  _setupSnapshotPlant: null as string | null,
  _setupSnapshotRequest: 0,
  // Generation counter guarding Persistence.load() itself against a plant-switch race:
  // a slow-resolving /tasks response for an OUTGOING plant must not overwrite a
  // faster-resolving load() for a plant the user has since switched to (and must not
  // reset _currentLoadedPlant back to the stale plant). Same idiom as
  // _setupSnapshotRequest/loadSetupSnapshot below — incremented once per load() call,
  // captured before the async work starts, and compared after each response resolves;
  // a mismatch means a newer load() has since started and this response is discarded.
  _loadRequest: 0,
  // Counts /tasks fetches currently in flight. Incremented right before the
  // fetch in load() is issued, decremented via a trailing .finally() once
  // that fetch chain settles (success, the stale-generation discard branch,
  // or the cache/demo fallback in .catch) — never incremented for the
  // early-return "no plant selected" path, which never calls fetch. Consumed
  // by the Gantt's loading mask (Timeline.hideLoadingMask is gated on
  // isLoading()) so the mask stays up through a plant switch's reload rather
  // than flickering hidden between the outgoing and incoming plant's fetches.
  _loadsInFlight: 0,
  // Throttle for refreshHorizons() below, keyed by plant: last Date.now() a
  // /tasks/horizons fetch for that plant actually resolved (success or not).
  _horizonsFetchedAt: {} as Record<string, number>,
  _dirtyIds: new Set<string>(),       // task ids mutated since last successful backend save
  _forceIds: new Set<string>(),       // historical name: dependent optimizer/undo edits require atomic version checks
  _conflictedIds: new Set<string>(),  // retained local edits cannot adopt a server version without reconciliation
  // Ids whose manual firm the planner changed (Firm/Unfirm/undo). Only these rows send FIRMED:
  // an ordinary date edit must not write this client's possibly stale firm copy back over
  // another planner's firm. Never an optimizer (atomic) marker; see App._trackDirty.
  _firmDirtyIds: new Set<string>(),
  async confirmPlantSwitch(plant: string | null): Promise<boolean> {
    if (plant === Store.selectedPlant || Persistence._dirtyIds.size === 0) return true;
    const discard = await Modal.confirm({
      title: Util.t('modal.discard_schedule_title'),
      message: Util.t('modal.discard_schedule_message'),
      confirmLabel: Util.t('btn.discard_and_switch'),
      tone: 'warn',
    });
    if (!discard) return false;
    Persistence._dirtyIds.clear();
    Persistence._forceIds.clear();
    Persistence._conflictedIds.clear();
    Persistence._firmDirtyIds.clear();
    // A later re-selection of the outgoing plant must fetch its saved state,
    // including when the user cleared the selector before re-selecting it.
    Persistence._currentLoadedPlant = null;
    Persistence._syncUnsaved();
    return true;
  },
  _syncUnsaved(): void {
    const badge = typeof document === 'undefined' ? null : document.getElementById('schedule-unsaved');
    if (!badge) return;
    const count = Persistence._dirtyIds.size;
    badge.hidden = count === 0;
    badge.textContent = count ? `${count} unsaved` : '';
  },
  // Lazily-set by _writeCacheWithQuotaGuard/_quarantineCache — declared here
  // (rather than left to first assignment) since plain object-literal
  // properties need their type fixed at the literal's declaration.
  _lastCacheBytes: 0,
  _lastCacheAt: 0,
  _cacheDegraded: false,
  _autosaveDisabled: false,
  // Set at sign-out so no late _saveCache (autosave, in-flight save .finally) can rewrite
  // the planner cache that sign-out just cleared.
  _cacheWritesHalted: false,
  haltCacheWrites(): void { Persistence._cacheWritesHalted = true; },
  // Unsaved work a sign-out would discard. Deliberately includes What-If and queued calendar
  // deletes; unsaved admin-form edits (setup, master data) are not detectable here.
  hasPendingWork(): boolean {
    if (Persistence._dirtyIds.size || Persistence._forceIds.size
        || Persistence._conflictedIds.size || Persistence._firmDirtyIds.size) return true;
    if (Sandbox.active) return true;
    try {
      const raw = localStorage.getItem('nimbus.calendar.pendingDeletes');
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) return true;
    } catch { /* unreadable storage: nothing detectable */ }
    return false;
  },
  _lastQuarantineKey: null as string | null,
  // Re-entrancy guard for saveAll(): a second call while a save is already in
  // flight would build a NEW payload from current (possibly further-edited) Store
  // state while the FIRST request is still outbound, and either request's response
  // handler could then race the other's dirty-id bookkeeping. Simple flag, checked
  // at the top of saveAll() — matches this file's existing convention of a single
  // boolean latch (e.g. _autosaveDisabled) rather than a queue/promise chain.
  _saveInFlight: false,
  // Stats captured on every load, exposed via NIMBUS.Persistence.stats()
  _lastLoad: {
    source: null,          // 'backend' | 'cache' | 'demo'
    ts: null,
    plant: null,           // plant filter applied to this load (null = all plants)
    raw_received: 0,       // rows as received from /tasks (after plant filter + color merge)
    backend_meta: null,    // payload.meta from brain.py
    // Color-merge now runs per-request on the backend, so misses are scoped to
    // the active plant filter. The pipeline panel reads these instead of
    // the load-time values in /diagnostics/deep.
    color_merge_misses: 0,
    missed_colors: [],
    pre_color_merge_count: 0,   // rows entering color merge (post plant filter)
    filtered_pl: 0,        // rows removed because id startsWith 'PL_'
    filtered_null_id: 0,   // rows removed because id was null/empty
    dedup_collisions: 0,   // ids that collided during Store.setTasks
    rendered: 0,           // Store.tasksArr.length after load
    errors: 0
  } as LoadStats,

  /** Inject the calendar-capacity seam (`calendar/calendar-engine.mjs`'s `Calendar`). Wired
   *  once from app.js boot glue right after the calendar/calendar-engine.mjs bridge resolves.
   *  Until this is called, snap-affecting load paths no-op rather than throw — see
   *  `_snapToWorkingHours`. */
  setCalendarService(svc: CalendarService): void { _calendarService = svc; },

  /** Setup truth is deliberately outside the schedule cache. This tiny
   * callback seam lets a successful setup write invalidate an open detached
   * preview without importing the workbench (and therefore without a cycle). */
  setSetupWriteListener(listener: ((plant: string, kind: SetupWriteKind) => void) | null): void {
    _setupWriteListener = listener;
  },

  noteSetupWrite(plant: string, kind: SetupWriteKind): void {
    if (plant) _setupWriteListener?.(plant, kind);
  },

  stats(): LoadStats { return { ...Persistence._lastLoad }; },

  /** True while a /tasks fetch is in flight — see the `_loadsInFlight` field
   *  comment above for exactly which paths increment/decrement it. */
  isLoading(): boolean { return Persistence._loadsInFlight > 0; },

  load({ force = false, plant = null, discardLocalEdits = false }: {
    force?: boolean; plant?: string | null; discardLocalEdits?: boolean;
  } = {}): Promise<void> {
    const discardBaseline = discardLocalEdits
      ? JSON.stringify(Store.tasksArr.map(t => [t.id, Persistence._refreshBaseline(t)])) : null;
    const acceptDiscard = (): void => {
      if (!discardLocalEdits) return;
      Persistence._dirtyIds.clear();
      Persistence._forceIds.clear();
      Persistence._conflictedIds.clear();
      Persistence._firmDirtyIds.clear();
      for (const key of Object.keys(Store.dependencies)) delete Store.dependencies[key];
    };
    // Captured before any async work starts; every continuation below that would
    // otherwise mutate Store/_currentLoadedPlant checks this against the live
    // counter and discards itself if a newer load() has since started. See the
    // _loadRequest field comment above for why this mirrors _setupSnapshotRequest.
    const loadGeneration = ++Persistence._loadRequest;
    Persistence._lastAttemptedPlant = plant ?? null;
    const stats: LoadStats = Persistence._lastLoad = {
      source: null, ts: new Date().toISOString(), plant: plant ?? null,
      raw_received: 0, backend_meta: null,
      color_merge_misses: 0, missed_colors: [], pre_color_merge_count: 0,
      filtered_pl: 0, filtered_null_id: 0,
      dedup_collisions: 0, rendered: 0, errors: 0
    };
    ErrorLog.info('persistence', `Load requested (force=${force}, plant=${plant ?? 'all'})`);

    // Stage 3 fix: drop the OUTGOING plant's priority rank maps the instant we know
    // the plant is changing — before /tasks, before the master-data Promise.all, and
    // therefore long before loadPriorityRankMaps() runs for the new plant (which
    // happens down in that Promise.all's .finally()).
    //
    // Why here and not there: Store.setTasks() and the FIRST 'schedule:hydrated' emit
    // both happen well before the rank fetch even starts, and 'schedule:hydrated'
    // triggers the alert recompute that renders the auto-fix buttons. Without this
    // clear, that window has the NEW plant's tasks and alerts on screen while
    // Store.priorityRankMaps still holds the OLD plant's ranks — so an overload
    // auto-fix (which cannot await freshness: optimization/engine.mts must not import
    // this module) would produce a plausible-looking sequence built from the wrong
    // plant's priority lists. Clearing converts that failure mode into the one the
    // rest of the feature is already built around: nothing ranked yet, i.e. every
    // order at 999999, which is also exactly what OptimizeDialog.run()'s
    // `_rankMapsPlant !== plant` guard detects and recovers from.
    //
    // Conditional on an actual change so a force-reload of the SAME plant does not
    // needlessly wipe a good cache (and open a fresh window for no reason).
    if (plant !== Persistence._rankMapsPlant) {
      Persistence._rankMapsPlant = null;
      Store.setPriorityRankMaps({}, 'persistence');
    }
    if (plant !== Persistence._setupSnapshotPlant) Persistence._invalidateSetupSnapshot('persistence');
    // A later load invalidates this generation immediately. The older task-load
    // continuation must then not begin a fresh setup request for its old plant.
    const setupSnapshotGeneration = Persistence._setupSnapshotRequest;

    // A plant is the scaling unit — never request the whole order book. With no
    // plant selected we leave the board empty (each plant-scoped module renders its
    // own EmptyState "select a plant" prompt) and only load master data so the
    // plant picker is populated and the user can choose one.
    if (!plant) {
      ErrorLog.info('persistence', 'No plant selected — skipping /tasks; loading master data for the picker');
      stats.source = 'backend';
      Store.setTasks([], 'persistence');
      Store.setVisibilityHorizonEnd(null, 'persistence');
      Store.setFrozenHorizonEnd(null, 'persistence');
      Persistence._currentLoadedPlant = null;
      Persistence.loadPriorityRankMaps(null);
      Runtime.load(null);
      // No plant selected means no workcenters belong to this screen either —
      // sap_workcenter is per-plant (D25), so there is nothing to scope the
      // fetch to; skip it entirely rather than fetch every plant's rows.
      return Promise.all([
        Util.fetchTraced(`${Config.API_BASE}/master-data/plants`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<MasterPlantRow>> : null),
        // No plant selected: no machines to show (plant-scoped, #25) — never
        // fetch every plant's machine list just to populate the plant picker.
        Promise.resolve(null as MasterDataRowsResponse<MasterLineRow> | null),
      ]).then(([pData, lData]) => {
        // A newer load() may have started (and even resolved) while this was in
        // flight — discard rather than let a stale response overwrite it.
        if (loadGeneration !== Persistence._loadRequest) return;
        if (pData || lData) {
          Store.setMasterData({
            plants: pData?.rows ?? [],
            lines:  lData?.rows ?? [],
            workcenters: [],
          }, 'persistence');
        }
      }).catch(e => ErrorLog.warn('persistence', `Master-data fetch failed (no-plant path): ${e.message}`));
    }

    const tasksUrl = `${Config.API_BASE}/tasks?plant=${encodeURIComponent(plant)}`;
    Persistence._loadsInFlight++;
    return Util.fetchTraced(tasksUrl, { signal: AbortSignal.timeout(8000) })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} from /tasks`);
        return r.json() as Promise<TasksResponse>;
      })
      .then(payload => {
        // Plant-switch race guard: if a newer load() has started since this fetch
        // was issued, this response belongs to a plant the user has already
        // navigated away from. Applying it now would overwrite the newer plant's
        // already-loaded board and reset _currentLoadedPlant back to the stale
        // plant — discard it instead and let the newer load()'s own response win.
        if (loadGeneration !== Persistence._loadRequest) {
          ErrorLog.info('persistence',
            `Discarding stale /tasks response for plant=${plant ?? 'all'} (superseded by a newer load)`);
          return;
        }
        if (discardLocalEdits && discardBaseline !==
            JSON.stringify(Store.tasksArr.map(t => [t.id, Persistence._refreshBaseline(t)]))) {
          Toast.show('New edits were made while reloading. They remain unsaved; reload again to discard them.', 'warn', 8000);
          return;
        }
        if (!Array.isArray(payload?.data)) throw new Error('Invalid /tasks response');
        // A successful HTTP 200 is authoritative — after this point we
        // refuse to silently fall back to cache even if downstream throws.
        stats.source = 'backend';
        stats.raw_received = payload?.data?.length ?? 0;
        stats.backend_meta = payload?.meta ?? null;
        // Lift per-request color stats out of meta so the pipeline panel
        // can read them without digging into backend_meta.
        stats.color_merge_misses = (payload?.meta?.color_merge_misses as number | undefined) ?? 0;
        stats.missed_colors = (payload?.meta?.missed_colors as string[] | undefined) ?? [];
        stats.pre_color_merge_count = (payload?.meta?.pre_color_merge_count as number | undefined) ?? 0;
        // C1 (2026-08-20): the backend already computed the plant's visibility-
        // horizon end instant (or null if unlimited) — store it as-is rather than
        // recomputing the plant-local-midnight/roll-hour clock math client-side.
        // Timeline.rebuild (Gantt `max` clamp) and Table's chip filter both read
        // Store.visibilityHorizonEnd.
        const horizonEndIso = (payload?.meta?.visibility_horizon_end as string | null | undefined) ?? null;
        Store.setVisibilityHorizonEnd(horizonEndIso ? new Date(horizonEndIso) : null, 'persistence');
        // C2 (2026-08-20): same reasoning, for the plant's frozen-horizon
        // boundary (db.compute_frozen_horizon_end) — Engine.earliestAllowedStart/
        // isFrozenHorizon (optimization/engine.mts) and Timeline's
        // .frozen-horizon-zone band both read Store.frozenHorizonEnd rather
        // than each carrying their own copy of the clock math.
        const frozenEndIso = (payload?.meta?.frozen_horizon_end as string | null | undefined) ?? null;
        Store.setFrozenHorizonEnd(frozenEndIso ? new Date(frozenEndIso) : null, 'persistence');
        ErrorLog.info('persistence',
          `Backend returned ${stats.raw_received} rows`,
          { meta: stats.backend_meta });

        if (!stats.raw_received) {
          ErrorLog.warn('persistence', 'Backend returned zero rows — nothing to render');
          Toast.show(Util.t('toast.backend_zero_orders'), 'warn');
          acceptDiscard();
          Store.setTasks([], 'persistence');
          if (discardLocalEdits) { Persistence._syncUnsaved(); Persistence._saveCache(); }
          Persistence._currentLoadedPlant = plant;
          // Restore cached non-task state (blocks/calendars/lineSettings) so a plant
          // with no orders still shows its saved config; the backend overlay follows.
          try {
            const rawCache = localStorage.getItem(Config.LS_KEY);
            if (rawCache) Persistence._restoreNonTaskState(JSON.parse(rawCache));
          } catch {}
          // Fetch master-data so orderless plants/lines appear in Master Data tabs,
          // THEN hydrate calendars/blackouts from the backend (authoritative).
          Promise.all([
            Util.fetchTraced(`${Config.API_BASE}/master-data/plants`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<MasterPlantRow>> : null),
            Util.fetchTraced(`${Config.API_BASE}/master-data/machine?plant=${encodeURIComponent(plant)}`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<MasterLineRow>> : null),
            Util.fetchTraced(`${Config.API_BASE}/master-data/sap_workcenter?plant=${encodeURIComponent(plant)}`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<NimbusMasterWorkcenter>> : null),
          ]).then(([pData, lData, wcData]) => {
            // A newer load() (e.g. the user switched plants again) may have
            // started while this was in flight — discard rather than let a
            // stale plant's response clobber the now-current one.
            if (loadGeneration !== Persistence._loadRequest) return;
            if (pData || lData || wcData) {
              Store.setMasterData({
                plants: pData?.rows ?? [],
                lines:  lData?.rows ?? [],
                workcenters: wcData?.rows ?? [],
              }, 'persistence');
            }
          }).catch(e => ErrorLog.warn('persistence', `Master-data fetch failed (zero-task path): ${e.message}`))
            .finally(() => {
              Promise.all([
                CalendarSync.fetchPlantConfig(plant),
                Persistence.loadPriorityRankMaps(plant),
                Runtime.load(plant),
                setupSnapshotGeneration === Persistence._setupSnapshotRequest
                  ? Persistence.loadSetupSnapshot(plant) : Promise.resolve(null),
              ])
                .finally(() => Store.emit({ type: 'schedule:hydrated', source: 'persistence' }));
            });
          return;
        }

        // Step 1: drop PL_ pseudo-rows (line-group leftovers)
        const afterPL = payload.data.filter(t => {
          if (String(t.id || '').startsWith('PL_')) {
            stats.filtered_pl++;
            ErrorLog.warn('persistence', `Dropped line-group row id=${t.id}`, t);
            return false;
          }
          return true;
        });

        // Step 2: drop rows with no id at all
        const afterId = afterPL.filter(t => {
          if (t.id == null || String(t.id).trim() === '') {
            stats.filtered_null_id++;
            ErrorLog.error('persistence', 'Dropped row with null/empty id', t);
            return false;
          }
          return true;
        });

        // Step 3: prep + push to Store (Store will report collisions)
        const tasks = afterId.map(raw => {
          try { return Persistence._prepTask(raw); }
          catch (e) {
            stats.errors++;
            ErrorLog.error('persistence', `Row prep failed for id=${raw.id}: ${(e as Error).message}`, raw);
            return null;
          }
        }).filter(Boolean) as NimbusTask[];
        if (discardLocalEdits && (stats.errors || tasks.length !== payload.data.length)) {
          throw new Error('Incomplete task hydration; local edits retained');
        }

        // Restore user state (blocks, calendars, lineSettings) from localStorage
        // before setTasks so alerts compute with the correct context. The backend is
        // authoritative for task schema; the cache owns blocks/calendars AND
        // any manually-positioned task dates the user has placed beyond the auto-snap baseline.
        let cacheData = null;
        try {
          const rawCache = localStorage.getItem(Config.LS_KEY);
          if (rawCache) {
            cacheData = JSON.parse(rawCache);
            Persistence._restoreNonTaskState(cacheData);
          }
        } catch {}

        // Sync plant from backend task data BEFORE setTasks so Timeline.rebuild()
        // called synchronously by the tasks:bulk subscriber sees correct plant assignments
        for (const t of tasks) {
          const line = t.MACHINE;
          if (!line || !t.PLANT) continue;
          Store.ensureLineSettings(line);
          Store.lineSettings[line].plant = t.PLANT;
        }

        // Overlay user-explicitly-moved positions from localStorage before snapping so that
        // _snapToWorkingHours detects them via startMoved and skips re-snap. Only tasks
        // where the cached start differs from the cached original baseline are overlaid.
        let restoredDirtyIds: string[] = [];
        if (!discardLocalEdits && cacheData?.tasks?.length) {
          const optimizerIds = new Set<string>(cacheData._optimizerDirtyIds ?? []);
          const dirtyIds = cacheData._dirtyIds == null ? null : new Set<string>(cacheData._dirtyIds);
          restoredDirtyIds = Persistence._overlayUserMoves(tasks, cacheData.tasks.filter((task: NimbusTask) =>
            !optimizerIds.has(String(task.id)) && (dirtyIds === null || dirtyIds.has(String(task.id)))));
        }

        // SAP ships date-only starts (00:00) — snap each order to the first
        // feasible working slot on its line so ingest doesn't fire false
        // out-of-hours alerts and the variance baseline reflects reality.
        // This pass may run against default/stale hours (CalendarSync's
        // authoritative fetch hasn't resolved yet) — the due-date-baseline
        // correction it also computes in-memory is fine to (re-)compute here,
        // but deliberately not relayed to the backend from this call; only the
        // post-hydration re-snap in CalendarSync._applyConfig persists it.
        Persistence._snapToWorkingHours(tasks, plant);

        acceptDiscard();
        const setResult = Store.setTasks(tasks, 'persistence');
        for (const id of restoredDirtyIds) Persistence._dirtyIds.add(id);
        for (const id of (discardLocalEdits ? [] : cacheData?._optimizerDirtyIds) ?? []) {
          if (Store.tasks[id]) { Persistence._dirtyIds.add(id); Persistence._forceIds.add(id); }
        }
        Persistence._syncUnsaved();
        stats.dedup_collisions = setResult.collisions;
        stats.rendered = Store.tasksArr.length;
        Persistence._currentLoadedPlant = plant;

        (payload.links || []).forEach(link => {
          (Store.dependencies[link.target] ||= []).push(link.source);
        });
        for (const t of Store.tasksArr) Store.ensureCalendar(t.MACHINE || 'Unknown');
        Store.emit({ type: 'schedule:hydrated', source: 'persistence' });

        // Integrity reconciliation — compare received vs rendered, not total-emitted vs rendered,
        // so an active plant filter doesn't produce a false "data lost" warning.
        const lost = stats.raw_received - stats.rendered;
        if (lost > 0) {
          ErrorLog.error('persistence',
            `Data-integrity gap: received ${stats.raw_received}, UI rendered ${stats.rendered} (delta=${lost})`,
            stats);
          Toast.show(Util.t('toast.data_integrity_gap', { count: lost }), 'warn', 5000);
        } else {
          if (plant) {
            Toast.show(Util.t('toast.loaded_orders_plant', { count: stats.rendered, plant }), 'success');
          } else {
            Toast.show(Util.t('toast.loaded_orders', { count: stats.rendered }), 'success');
          }
        }

        Persistence._saveCache();

        // Load master-data plants/lines and the global system-settings blob in
        // parallel (non-blocking). System-settings response body IS the settings
        // content directly ({"orderFields": {...}}), no wrapper envelope — see
        // master_data.get_system_settings()/GET /system-settings in brain.py.
        Promise.all([
          Util.fetchTraced(`${Config.API_BASE}/master-data/plants`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<MasterPlantRow>> : null),
          Util.fetchTraced(`${Config.API_BASE}/master-data/machine?plant=${encodeURIComponent(plant)}`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<MasterLineRow>> : null),
          Util.fetchTraced(`${Config.API_BASE}/system-settings`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<{ orderFields?: Record<string, { grid?: boolean; inspector?: boolean }> }> : null),
          Util.fetchTraced(`${Config.API_BASE}/master-data/sap_workcenter?plant=${encodeURIComponent(plant)}`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<NimbusMasterWorkcenter>> : null),
        ]).then(([pData, lData, ssData, wcData]) => {
          // A newer load() (e.g. the user switched plants again) may have
          // started while this was in flight — discard rather than let a
          // stale plant's response clobber the now-current one.
          if (loadGeneration !== Persistence._loadRequest) return;
          if (pData || lData || wcData) {
            Store.setMasterData({
              plants: pData?.rows ?? [],
              lines:  lData?.rows ?? [],
              workcenters: wcData?.rows ?? [],
            }, 'persistence');
          }
          Store.setOrderFieldVisibility(ssData?.orderFields ?? {}, 'persistence');
        }).catch(e => {
          ErrorLog.warn('persistence', `Master-data fetch failed: ${e.message}`);
          Toast.show(Util.t('toast.master_data_unavail'), 'warn', 5000);
        }).finally(() => {
          // Backend is authoritative for this plant's calendars/blackouts — overlay
          // them on top of the localStorage restore that already ran. Runs after
          // master-data so getPlantForLine/subnetwork resolve reliably. Priority rank
          // maps (Stage 3) have no such ordering dependency but are fetched alongside
          // for the same reason: keep the optimizer's cache current the moment its
          // plant's tasks are (re)loaded.
          Promise.all([
            CalendarSync.fetchPlantConfig(plant),
            Persistence.loadPriorityRankMaps(plant),
            Runtime.load(plant),
            setupSnapshotGeneration === Persistence._setupSnapshotRequest
              ? Persistence.loadSetupSnapshot(plant) : Promise.resolve(null),
          ])
            .finally(() => Store.emit({ type: 'schedule:hydrated', source: 'persistence' }));
        });
      })
      .catch(err => {
        stats.errors++;
        ErrorLog.error('persistence', `Backend fetch failed: ${err.message}`);
        // Same plant-switch race guard as the success path above: a failed fetch
        // for a plant the user has since switched away from must not fall back to
        // cache/demo and clobber the newer load()'s already-rendered board.
        if (loadGeneration !== Persistence._loadRequest) return;
        if (discardLocalEdits) {
          Toast.show('Reload failed. Your local edits remain unsaved; try reloading again when the server is available.', 'error', 8000);
          return;
        }
        // Only fall back to cache / demo if we never got a successful response.
        if (stats.source !== 'backend') {
          if (Persistence._loadCache()) {
            stats.source = 'cache';
            Toast.show(Util.t('toast.backend_unreachable_cache'), 'warn', 5000);
          } else {
            Persistence._loadDemo();
            stats.source = 'demo';
          }
          stats.rendered = Store.tasksArr.length;
          // Start polling /health with exponential backoff so the UI recovers
          // automatically once the server comes back up.
          try { Persistence._reconnect.start(); } catch (e) {
            ErrorLog.warn('persistence', `Reconnect watcher failed to start: ${(e as Error).message}`);
          }
        }
      })
      // Settles exactly once per fetch chain, covering every terminal path above:
      // the success .then's normal completion, its stale-generation discard
      // branch, and this .catch's cache/demo fallback — see the `_loadsInFlight`
      // field comment for what this counter gates.
      .finally(() => { Persistence._loadsInFlight = Math.max(0, Persistence._loadsInFlight - 1); });
  },

  /** Lightweight meta-only refresh of a plant's horizon instants (visibility,
   *  frozen) plus its alert-horizon-band minutes, via `GET /tasks/horizons`.
   *
   *  Why this exists: `Store.visibilityHorizonEnd`/`frozenHorizonEnd` and the
   *  plant row's `alt_flag_horizon` are only ever set from a /tasks response's
   *  `meta` (see load() above) or the admin Plant Settings save — they go
   *  stale the moment an admin edits the horizon settings, or the daily
   *  horizon roll advances past midnight, without a fresh /tasks load to
   *  refresh them. A full load()/reload() would fix that too, but it has no
   *  dirty guard — re-running it every time the user re-enters the Gantt tab
   *  would silently clobber unsaved edits. This deliberately does NOT call
   *  load()/reload()/Store.setTasks and touches nothing task-shaped; it only
   *  ever patches the three horizon-shaped fields below.
   *
   *  Deliberately does NOT: toast on failure (a frontend deployed ahead of
   *  the backend's /tasks/horizons rollout must silently no-op forever, not
   *  nag), retry, or run more than once per plant per 10s (rapid tab flipping
   *  between Gantt/Orders must not become a request storm).
   *
   *  Resolves `true` iff something was actually applied — the caller
   *  (App.gotoGanttSub) uses that to trigger Timeline._scheduleRebuild() only
   *  when the horizon bands actually moved. */
  refreshHorizons(plant: string | null): Promise<boolean> {
    if (!plant) return Promise.resolve(false);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(false);
    if (Date.now() - (Persistence._horizonsFetchedAt[plant] ?? 0) < 10_000) return Promise.resolve(false);

    // Same generation idiom as load()'s loadGeneration: if a full load() has
    // started for a different plant by the time this resolves, that load's
    // own /tasks meta is authoritative and this response must be discarded.
    const gen = Persistence._loadRequest;
    return Util.fetchTraced(`${Config.API_BASE}/tasks/horizons?plant=${encodeURIComponent(plant)}`, { signal: AbortSignal.timeout(5000) })
      .then(r => {
        if (!r.ok) {
          // Silent by design — see the doc comment above. Most likely cause is
          // a frontend deployed ahead of a backend that doesn't have this
          // route yet, not a real error worth ErrorLog.warn/Toast. Record the
          // throttle timestamp here too (matches the `_horizonsFetchedAt`
          // field comment's "success or not") so a backend that 404s this
          // route forever doesn't turn every Gantt tab flip into a request.
          Persistence._horizonsFetchedAt[plant] = Date.now();
          ErrorLog.info('persistence', `Horizons refresh: HTTP ${r.status} from /tasks/horizons (plant=${plant}) — ignoring`);
          return false;
        }
        return (r.json() as Promise<{
          visibility_horizon_end: string | null;
          frozen_horizon_end: string | null;
          alert_horizon_minutes: number | null;
        }>).then(json => {
          // The user has since switched plants, or a newer load() has since
          // started (its own /tasks meta will win) — discard this response.
          if (Store.selectedPlant !== plant || Persistence._loadRequest !== gen) return false;
          Persistence._horizonsFetchedAt[plant] = Date.now();

          let changed = false;

          const v = json.visibility_horizon_end ? new Date(json.visibility_horizon_end) : null;
          if ((v?.getTime() ?? null) !== (Store.visibilityHorizonEnd?.getTime() ?? null)) {
            Store.setVisibilityHorizonEnd(v, 'persistence');
            changed = true;
          }

          const f = json.frozen_horizon_end ? new Date(json.frozen_horizon_end) : null;
          if ((f?.getTime() ?? null) !== (Store.frozenHorizonEnd?.getTime() ?? null)) {
            Store.setFrozenHorizonEnd(f, 'persistence');
            changed = true;
          }

          // Direct in-memory patch of the live masterData plant row — the same
          // thing the admin Plant Settings save does. No Store setter/emit
          // exists for this one field (see types.mts's alt_flag_horizon comment).
          const row = Store.masterData?.plants?.find(p => p.plant === plant);
          if (row && typeof json.alert_horizon_minutes === 'number' && row.alt_flag_horizon !== json.alert_horizon_minutes) {
            row.alt_flag_horizon = json.alert_horizon_minutes;
            changed = true;
          }

          return changed;
        });
      })
      .catch(e => {
        ErrorLog.warn('persistence', `Horizons refresh failed (plant=${plant}): ${(e as Error).message}`);
        return false;
      });
  },

  // Reconnect watcher: polls /health with exponential backoff (1s, 2s, 4s, ..., capped 30s)
  // until the backend responds, then triggers a force-reload of /tasks.
  _reconnect: {
    attempts: 0,
    timer:    null as ReturnType<typeof setTimeout> | null,
    running:  false,
    start(): void {
      if (this.running) return;
      this.running = true;
      this.attempts = 0;
      const tick = (): void => {
        this.attempts++;
        Util.fetchTraced(`${Config.API_BASE}/health`, { signal: AbortSignal.timeout(4000) })
          .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
          .then(() => {
            this.running = false;
            this.attempts = 0;
            this.timer = null;
            ErrorLog.info('persistence', 'Backend recovered — reloading');
            Toast.show(Util.t('toast.backend_recovered'), 'success', 3000);
            try { Persistence.load({ force: true, plant: Persistence._lastAttemptedPlant ?? Persistence._currentLoadedPlant }); } catch (e) {
              ErrorLog.error('persistence', `Reload after reconnect failed: ${(e as Error).message}`);
            }
          })
          .catch(() => {
            const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts - 1, 5));
            this.timer = setTimeout(tick, delay);
          });
      };
      this.timer = setTimeout(tick, 1000);
    },
    stop(): void {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.running = false;
      this.attempts = 0;
    },
  },

  _prepTask(raw: Record<string, unknown>): NimbusTask {
    // /tasks exposes the SAP baseline as original_start_date. Keep a raw copy
    // before calendar hydration adjusts the display baseline. Existing cached
    // raw dates remain authoritative on subsequent cache decoding.
    if (!Object.prototype.hasOwnProperty.call(raw, 'BASIC_START_DATE')) {
      raw.BASIC_START_DATE = raw.original_start_date ?? null;
    }
    if (raw.planning_status === 'needs_planning') {
      raw.start_date = null;
      raw.end_date = null;
      raw.schedule_segments = [];
      raw.scheduleSegments = [];
    }
    raw.scheduleSegments = Persistence._segmentsFromRaw(raw);
    delete raw.schedule_segments;
    // Coerce date-like string fields to Date.
    for (const k of Object.keys(raw)) {
      if (k.toLowerCase().includes('date') && typeof raw[k] === 'string') {
        raw[k] = Util.parseDate(raw[k] as string);
      }
    }
    return raw as unknown as NimbusTask;
  },

  /** Convert either the API's snake_case wire collection or a cache-restored
   *  camelCase collection into the one in-memory segment representation. */
  _segmentsFromRaw(raw: Record<string, unknown>): OrderScheduleSegment[] {
    const source = Array.isArray(raw.schedule_segments)
      ? raw.schedule_segments
      : (Array.isArray(raw.scheduleSegments) ? raw.scheduleSegments : []);
    const segments = source.map((candidate, index) => {
      if (!candidate || typeof candidate !== 'object') return null;
      const segment = candidate as Record<string, unknown>;
      const start = Util.parseDate(segment.start_date ?? segment.startDate);
      const end = Util.parseDate(segment.end_date ?? segment.endDate);
      const sequence = Number(segment.sequence);
      return start instanceof Date && end instanceof Date && end > start
        ? { sequence: Number.isFinite(sequence) && sequence > 0 ? sequence : index + 1, startDate: start, endDate: end }
        : null;
    }).filter((segment): segment is OrderScheduleSegment => segment !== null)
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime() || a.sequence - b.sequence);
    return segments.length >= 2 ? segments : [];
  },

  // Apply user-explicitly-moved positions from the localStorage cache back onto
  // freshly-fetched backend tasks. Only tasks where the cached start_date differs
  // from the cached original_start_date are overlaid — those are the ones the user
  // has consciously dragged beyond the auto-snap baseline. This prevents
  // _snapToWorkingHours from re-snapping user placements over blackout blocks.
  _overlayUserMoves(backendTasks: NimbusTask[], cachedTasks: Array<Record<string, unknown>>): string[] {
    const byId = new Map(cachedTasks.map(t => [t.id, t]));
    const restored: string[] = [];
    for (const t of backendTasks) {
      const cached = byId.get(t.id);
      if (t.planning_status === 'needs_planning' || cached?.planning_status === 'needs_planning') continue;
      if (!cached) continue;
      const cs  = Util.parseDate(cached.start_date);
      const ce  = Util.parseDate(cached.end_date);
      const cos = Util.parseDate(cached.original_start_date);
      if (!(cs instanceof Date) || !(ce instanceof Date)) continue;
      if (!(cos instanceof Date) || cs.getTime() === cos.getTime()) continue;
      // PR-2: a cached override only represents the planner's own unsaved edit
      // if nothing has written this row server-side since it was cached. When
      // both sides carry a row_version and they disagree, the server has a
      // newer write (another session's optimizer run, an anchor-carry, etc.)
      // that this cached copy knows nothing about — re-applying it here would
      // silently hide that real update. Old caches (or rows that never got a
      // version) fall back to the previous best-effort behavior.
      const cachedVersion = cached.row_version as number | null | undefined;
      if (cachedVersion != null && t.row_version != null && cachedVersion !== t.row_version) continue;
      t.start_date = cs;
      t.end_date   = ce;
      t.original_start_date = cos;
      t.scheduleSegments = Persistence._segmentsFromRaw(cached);
      const coe = Util.parseDate(cached.original_end_date);
      if (coe instanceof Date) t.original_end_date = coe;
      restored.push(String(t.id));
    }
    return restored;
  },

  // SAP gives us date-only `BASIC_START_DATE`s, which parse to 00:00:00. On lines
  // that don't run nights, every freshly ingested order would trip an
  // out-of-hours alert and show a misleading "shifted from SAP" variance once
  // a user (or autoReflow) moved it to a feasible slot. Snap each unfixed task
  // to the first feasible working window via the injected calendar service's
  // `nextAvailable`, using the task's OWN raw start_date — never a cursor advanced
  // past a sibling's end. Multiple orders that all originate at the same raw SAP
  // midnight therefore snap to the SAME first-working-hour instant and are left
  // overlapping on purpose: that's a real scheduling conflict, and the existing
  // Alerts overlap rule surfaces it for a human to resolve deliberately, rather
  // than this function silently auto-spreading siblings apart. Reset
  // `original_*_date` to the snapped instant so the variance badge baseline
  // reflects the feasible plan, not the midnight artifact.
  // Returns { movedIds, corrections }: movedIds are task IDs that actually
  // moved (start/end changed); corrections are due-date-baseline fixes found
  // by the phase below (see _relayDueDateCorrections — only the caller in
  // CalendarSync._applyConfig relays them; the pre-hydration call from
  // Persistence.load deliberately does not).
  _snapToWorkingHours(tasks: NimbusTask[], plant: string | null): { movedIds: string[]; corrections: Array<{ id: string; basic_finish_date: Date; base_version: number }> } {
    tasks = tasks.filter(task => task.planning_status !== 'needs_planning');
    const movedIds: string[] = [];
    const corrections: Array<{ id: string; basic_finish_date: Date; base_version: number }> = [];
    if (!_calendarService) return { movedIds, corrections }; // no-op until wired — matches
                                                              // "skip snapping" behavior when
                                                              // the calendar service isn't available
    _calendarService.beginRun(plant);
    try {
      let snappedCount = 0;

      // Capture each task's original_start_date BEFORE loop 1 (placement
      // snap) below can overwrite it. The due-date-baseline correction
      // phase further down needs the PRISTINE raw value as its
      // shape-matching anchor — reading the post-snap value would drift
      // the anchor to the snapped instant (e.g. midnight -> 07:00 on a
      // line using Config.DEFAULT_SHIFT, the common case, since a fresh
      // order never has a custom saved calendar) while original_end_date
      // (never touched by loop 1) is still anchored to the true raw
      // value — so none of the raw shapes below could ever match, and the
      // correction would silently never fire for that order.
      const pristineOriginalStart = new Map<NimbusTask, Date>();
      for (const t of tasks) {
        if (t.original_start_date instanceof Date) pristineOriginalStart.set(t, t.original_start_date);
      }

      for (const t of tasks) {
        const line = t.MACHINE;
        if (!line) continue;
        if (!(t.start_date instanceof Date) || !(t.end_date instanceof Date)) continue;
        const durationMs = t.end_date.getTime() - t.start_date.getTime();
        if (durationMs <= 0) continue;

        if (t.firmed || (t.scheduleSegments?.length ?? 0) >= 2 || t.runtime_schedule_mismatch) continue;

        // Backend has a scheduled_start/end persisted for this task — the user
        // owns its position. Never re-snap on load; alerts will flag any
        // blackout overlap so the user can resolve it deliberately.
        if (t.user_scheduled) continue;

        // User has moved or resized this task since ingest — preserve the deliberate
        // placement (including intentional overlaps and duration changes).
        const oStart = t.original_start_date instanceof Date ? t.original_start_date : null;
        // end_date is now derived as start + run_time (see db.py _EFF_END_SQL), so it
        // legitimately differs from original_end_date (the SAP due date). Detect a real
        // resize by comparing against the run-time-implied end from the original start,
        // not the SAP finish — otherwise every fresh order would look "moved" and skip snapping.
        const oEndRun = oStart ? new Date(oStart.getTime() + Util.runHours(t) * Config.MS_HOUR) : null;
        const startMoved = oStart  && t.start_date.getTime() !== oStart.getTime();
        const endMoved   = oEndRun && t.end_date.getTime()   !== oEndRun.getTime();
        if (startMoved || endMoved) continue;

        // No original baseline on record AND start is already non-midnight → task was
        // previously snapped or user-placed (e.g. backend returned a user-saved time
        // but doesn't persist original_start_date). Preserve it; Alerts will flag overlaps.
        const isMidnight = t.start_date.getHours() === 0 &&
                           t.start_date.getMinutes() === 0 &&
                           t.start_date.getSeconds() === 0;
        if (!oStart && !isMidnight) continue;

        const snappedStart = _calendarService.nextAvailable(line, t.start_date, durationMs);
        if (!(snappedStart instanceof Date)) continue;
        const snappedEnd = new Date(snappedStart.getTime() + durationMs);

        const oldStartMs = t.start_date.getTime();
        const oldEndMs = t.end_date.getTime();
        const newStartMs = snappedStart.getTime();
        const newEndMs = snappedEnd.getTime();

        if (newStartMs !== oldStartMs || newEndMs !== oldEndMs) {
          snappedCount++;
          movedIds.push(t.id);
        }
        t.start_date = snappedStart;
        t.end_date   = snappedEnd;
        t.original_start_date = new Date(snappedStart);
      }

      if (snappedCount) {
        ErrorLog.info('persistence',
          `Snapped ${snappedCount} ingested order(s) to first available working slot`);
      }

      // ---- Due-date-baseline correction ---------------------------------
      // Runs for EVERY task with a line — deliberately no fixed/user_scheduled/
      // startMoved guard, because "when is this order due" is orthogonal to
      // "where is it currently placed" (unlike the placement snap above, which
      // this loop runs after — so a freshly-snapped order's due day already
      // reflects the day it actually landed on, matching the prior behavior
      // this replaces). SAP only ships a day-level due date; ingest hygiene
      // (db.py's upload hygiene) leaves a raw/uncorrected basic_finish_date in
      // one of three known shapes (== basic_start_date, == basic_start_date +
      // RUN_TIME hours, or == basic_start_date + 1 hour — see
      // db.correct_due_date_baselines). Detect any shape (or a missing value)
      // and replace it with "due by end of the working day it lands on,"
      // computed once and then frozen: once original_end_date stops matching
      // any raw shape, this loop leaves it alone forever, until a fresh SAP
      // re-upload re-arms detection by overwriting basic_finish_date back
      // into a raw shape.
      for (const t of tasks) {
        const line = t.MACHINE;
        if (!line) continue;
        // Guard against a missing/invalid baseline (e.g. an incomplete future
        // SAP-sync field map) rather than assume original_start_date is always
        // a valid Date.
        const oStart = t.original_start_date instanceof Date ? t.original_start_date : null;
        if (!oStart) continue;

        // Shape-matching anchor: the PRISTINE original_start_date captured
        // before loop 1 above ran, NOT the (possibly already-reassigned)
        // t.original_start_date read into `oStart` just above. Loop 1
        // unconditionally overwrites original_start_date with the snapped
        // instant for every task it snaps (e.g. midnight -> 07:00 on a line
        // using Config.DEFAULT_SHIFT, the common case), which would drift
        // rawShapeStart/rawShapeRun/rawShapeHour1 away from what db.py/SAP
        // actually wrote and make looksRaw never match — silently skipping
        // the correction for exactly the fresh, never-individually-saved
        // orders this phase exists to fix. `oStart` itself is still used
        // below for the calendar service's workWindow "which day is this due"
        // lookup — that usage is deliberate (see the comment above loop 1's finish).
        const pristineStart = pristineOriginalStart.get(t) || oStart;

        const oEnd = t.original_end_date instanceof Date ? t.original_end_date : null;
        const rawShapeStart = pristineStart.getTime();
        const rawShapeRun   = pristineStart.getTime() + Util.runHours(t) * Config.MS_HOUR;
        // Legacy pre-2026-07-06 ingest-hygiene bug shape: the OLD db.py
        // upload-hygiene "bad" branch hardcoded basic_finish_date =
        // basic_start_date + 1 hour for any row with a missing/invalid
        // BASIC_FINISH_DATE. Kept permanently (not a one-off migration) —
        // old backups/re-imports could still carry this shape even though
        // new uploads never will after the ingest-hygiene fix. Unlike
        // rawShapeRun, this shape is unconditional on RUN_TIME, so it can
        // theoretically clobber a genuine SAP-set due date that happens to
        // land exactly 1 hour after start — accepted, same
        // heuristic-ambiguity class already taken on for rawShapeRun.
        const rawShapeHour1 = pristineStart.getTime() + Config.MS_HOUR;
        const looksRaw = !oEnd
          || oEnd.getTime() === rawShapeStart
          || oEnd.getTime() === rawShapeRun
          || oEnd.getTime() === rawShapeHour1;

        // Sticky within this session (this function runs twice per load: once
        // pre-hydration from Persistence.load against default/stale hours,
        // once post-hydration from CalendarSync._applyConfig against real
        // backend hours — see the call sites). Once flagged, a task STAYS
        // flagged even after the pre-hydration pass's own in-memory guess
        // stops shape-matching raw below — otherwise the post-hydration pass
        // would see an already-non-raw value (which IT set, against
        // default/stale hours) and wrongly conclude "nothing to do," so
        // neither the real-hours recompute nor the relay that depends on it
        // would ever run for the common case. A brand-new page load starts
        // with fresh task objects (no flag) and re-derives `looksRaw` from
        // the DB's actual (still-raw, since nothing was relayed) shape, so a
        // stale flag can never mask an already-corrected value across
        // separate loads.
        if (looksRaw) t._dueDateBaselinePending = true;
        if (!t._dueDateBaselinePending) continue;

        // "Due by end of the working day it lands on." Guard workWindow's null
        // return (closed day — e.g. a bare Saturday SAP date on a freshly
        // onboarded line, which defaults closed Sat/Sun via Config.WEEKEND_OFF)
        // by walking forward to the next open day instead of assuming [1] exists.
        const win = _calendarService.workWindow(line, oStart);
        let dayEnd = win ? win[1] : Persistence._dueEndOfShift(line, oStart);
        dayEnd = dayEnd instanceof Date
          ? new Date(dayEnd)
          // Every day in the search window is closed/misconfigured — fall back
          // to the run-time-implied end rather than leave it broken.
          : new Date(rawShapeRun);

        // A continuous/24h-shift line can compute a legitimately-correct dayEnd
        // that exactly coincides with one of the raw shapes above (RUN_TIME=24
        // starting exactly at a window's open — the window's close IS
        // start+24h; or, narrowly, a day whose real shift-close coincidentally
        // lands exactly 1 hour after midnight). Left alone, that value would
        // re-match "needs correction" on every future load and re-relay a
        // no-op correction forever. Nudge by a UI-invisible 1 second (never
        // rendered by Util.fmtDT / fmtDTReadable; negligible for
        // Util.latenessHours) so the next pass's shape check no longer
        // matches — freezing it like every other corrected order.
        if (dayEnd.getTime() === rawShapeStart || dayEnd.getTime() === rawShapeRun || dayEnd.getTime() === rawShapeHour1) {
          dayEnd = new Date(dayEnd.getTime() + 1000);
        }

        t.original_end_date = dayEnd;
        // Pin the correction to this task's row version (xmin), not a raw date
        // value: a date round-trips through JS Date/JSON.stringify, which
        // re-labels a naive local timestamp as UTC — comparing that directly
        // against Postgres's naive basic_start_date would be off by the
        // client's UTC offset and would simply never match for any non-UTC
        // user (i.e. every real user). xmin is an opaque version counter with
        // no such ambiguity, and — as a bonus — fails safely against ANY
        // concurrent write to the row (a re-upload, a scheduling save, or
        // another tab's correction), not just a re-upload specifically.
        if (t.row_version != null) {
          corrections.push({ id: t.id, basic_finish_date: dayEnd, base_version: t.row_version });
        }
      }
    } finally {
      _calendarService.endRun();
    }
    return { movedIds, corrections };
  },

  // Walk forward from `date`'s calendar day until an open working day is
  // found on `line`, returning that day's close. Used by the due-date-
  // baseline correction above when `date` itself lands on a closed day.
  // Bounded to 14 days so a fully closed/misconfigured calendar can't spin
  // forever; returns null if no open day is found in that window (caller
  // falls back to the run-time-implied end).
  _dueEndOfShift(line: string, date: Date): Date | null {
    let cur = new Date(date);
    const MAX_DAYS = 14;
    for (let i = 0; i < MAX_DAYS; i++) {
      const win = _calendarService!.workWindow(line, cur);
      if (win) return win[1];
      cur = new Date(cur);
      cur.setDate(cur.getDate() + 1);
      cur.setHours(0, 0, 0, 0);
    }
    return null;
  },

  // Fire-and-forget relay of due-date-baseline corrections found by
  // _snapToWorkingHours's due-date-baseline phase. Failure just means the
  // next load retries — the in-memory value set by that phase is already
  // correct for this session either way. Chunked to bound each POST's row
  // count: CLAUDE.md's production-scale roadmap anticipates 50+ plants /
  // 70+ lines, where a plant's one-time backlog could be many thousands of
  // rows in one shot, risking Postgres's bound-parameter ceiling on the
  // server's VALUES-join UPDATE. Batches are sent sequentially (not in
  // parallel) so a struggling backend isn't hit with concurrent bursts.
  _relayDueDateCorrections(corrections: Array<{ id: string; basic_finish_date: Date; base_version: number }>): void {
    if (!corrections || !corrections.length) return;
    const CHUNK = 500;
    const chunks: Array<Array<{ id: string; basic_finish_date: Date; base_version: number }>> = [];
    for (let i = 0; i < corrections.length; i += CHUNK) {
      chunks.push(corrections.slice(i, i + CHUNK));
    }

    const sendNext = (idx: number): void => {
      if (idx >= chunks.length) return;
      const chunk = chunks[idx];
      const body = JSON.stringify({
        corrections: chunk.map(c => ({
          id: c.id,
          // toLocalSeconds, not the raw Date: JSON.stringify would call
          // Date.toISOString() (UTC), which the backend's naive-datetime
          // parser mis-handles for any non-UTC client — see toLocalSeconds.
          basic_finish_date: Util.toLocalSeconds(c.basic_finish_date) as NaiveLocalTs,
          base_version: c.base_version,
        })),
      });
      Util.fetchTraced(`${Config.API_BASE}/tasks/baseline-correct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
        .then(r => r.ok ? r.json() as Promise<BaselineCorrectResult> : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then(result => {
          // Re-stamp row_version for corrected rows, mirroring saveAll() — a
          // stale cached xmin would false-conflict this order's next
          // unrelated scheduling save this session.
          const versions = result.versions || {};
          for (const id of Object.keys(versions)) {
            const tk = Store.tasks[id];
            if (tk) tk.row_version = versions[id];
          }
          ErrorLog.info('persistence',
            `Due-date baseline correction: ${result.persisted ?? 0}/${chunk.length} persisted, `
            + `${result.not_matched ?? 0} not matched (stale version or already corrected) `
            + `(batch ${idx + 1}/${chunks.length})`);
        })
        .catch(e => ErrorLog.warn('persistence',
          `Due-date baseline correction relay failed (batch ${idx + 1}/${chunks.length}): ${e.message}`))
        .finally(() => sendNext(idx + 1));
    };
    sendNext(0);
  },

  _loadCache(): boolean {
    let raw: string | null | undefined;
    try { raw = localStorage.getItem(Config.LS_KEY); }
    catch (e) { ErrorLog.error('persistence', `localStorage unavailable: ${(e as Error).message}`); return false; }
    if (!raw) return false;

    let data: StoredState | undefined;
    try { data = JSON.parse(raw); }
    catch {
      ErrorLog.error('persistence', `Cache JSON parse failed (${raw.length} bytes) — quarantining and clearing`);
      Persistence._quarantineCache(raw);
      try { localStorage.removeItem(Config.LS_KEY); } catch {}
      return false;
    }

    if (data?._schemaVersion !== undefined && data._schemaVersion !== Config.SCHEMA_VERSION) {
      ErrorLog.warn('persistence',
        `Cache schema mismatch (cached=${data._schemaVersion}, expected=${Config.SCHEMA_VERSION}) — discarding`);
      try { localStorage.removeItem(Config.LS_KEY); } catch {}
      return false;
    }

    if (data?._buildId && Config.BUILD_ID && data._buildId !== Config.BUILD_ID) {
      ErrorLog.info('persistence',
        `Cache from prior build ${data._buildId} → current ${Config.BUILD_ID} (kept; schema match)`);
    }

    if (!data || !Array.isArray(data.tasks)) {
      ErrorLog.warn('persistence', 'Cache shape invalid — discarding');
      try { localStorage.removeItem(Config.LS_KEY); } catch {}
      return false;
    }

    try {
      const tasks = data.tasks.map(Persistence._prepTask);
      for (const t of tasks) (t as NimbusTask).firmed = false;  // cached firms are never restored
      // Stage 3 fix, same class as load()'s clear above: this path hydrates tasks and
      // emits 'schedule:hydrated' (so alerts + their auto-fix buttons render) but
      // NEVER calls loadPriorityRankMaps — it is the offline/backend-failed restore.
      // The cache holds whatever plant was last persisted, which need not be the plant
      // the rank cache holds, so after this runs the ranks cannot be trusted to match
      // what is on screen. Cleared unconditionally: "nothing ranked yet" is the safe
      // fallback the feature is built around, and OptimizeDialog.run()'s
      // `_rankMapsPlant !== plant` guard re-fetches on demand the moment the user
      // actually optimizes.
      Persistence._rankMapsPlant = null;
      Store.setPriorityRankMaps({}, 'persistence');
      // Same class of bug, same fix: the cache holds whatever plant was last
      // persisted, so Store.visibilityHorizonEnd/frozenHorizonEnd — both set only
      // on a successful /tasks response (see load() above) — cannot be trusted to
      // match the plant this cache restore is about to render. Left stale, a plant
      // with a configured frozen/visibility horizon would leak it onto a DIFFERENT
      // plant's cached tasks after an offline plant switch (Timeline's clamp/band
      // and Engine.earliestAllowedStart would apply the wrong plant's bound). Clear
      // to null — "no horizon known yet" — same safe-default posture as the rank
      // maps reset just above.
      Store.setVisibilityHorizonEnd(null, 'persistence');
      Store.setFrozenHorizonEnd(null, 'persistence');
      // Restore all non-task state first so alerts compute with correct context
      Persistence._restoreNonTaskState(data);
      // Sync plant from task data for any lines not yet in lineSettings
      for (const t of tasks) {
        const line = t.MACHINE;
        if (!line || !t.PLANT) continue;
        Store.ensureLineSettings(line);
        if (!Store.lineSettings[line].plant) {
          Store.lineSettings[line].plant = t.PLANT;
        }
      }
      Store.setTasks(tasks, 'persistence');
      for (const id of data._dirtyIds ?? []) {
        if (Store.tasks[id]) Persistence._dirtyIds.add(id);
      }
      for (const id of data._optimizerDirtyIds ?? []) {
        if (Store.tasks[id]) {
          Persistence._dirtyIds.add(id);
          Persistence._forceIds.add(id);
        }
      }
      Persistence._syncUnsaved();
      for (const t of tasks) {
        Store.ensureCalendar(t.MACHINE || 'Unknown');
        Store.ensureLineSettings(t.MACHINE || 'Unknown');
      }
      Store.emit({ type: 'schedule:hydrated', source: 'persistence' });
      Toast.show(Util.t('toast.loaded_cache', { count: tasks.length }), 'info');
      return true;
    } catch (e) { ErrorLog.error('persistence', `Cache load failed: ${(e as Error).message}`); return false; }
  },

  // Restore non-task user state from a cache snapshot. Called both from _loadCache()
  // and from the backend load path (where the backend owns task dates but localStorage
  // owns everything else: blocks, calendars, lineSettings, plants; firms are server state).
  _restoreNonTaskState(data: Partial<StoredState>): void {
    if (data.lineSettings && Object.keys(data.lineSettings).length) {
      const ls = Store.lineSettings;
      for (const k of Object.keys(ls)) delete ls[k];
      Object.assign(ls, data.lineSettings);
    }
    // Track add-vs-skip so we can surface a single user-facing summary if the
    // saved cache contained duplicate blocks (Store.addBlock will silently
    // refuse dups now — count them so the user knows the heal happened).
    const before = { line: Store.blocks.length, plant: Store.plantBlocks.length };
    let lineAttempts = 0, plantAttempts = 0;
    if (Array.isArray(data.blocks))
      for (const b of data.blocks) {
        lineAttempts++;
        Store.addBlock({ ...b, start: Util.parseDate(b.start), end: Util.parseDate(b.end) } as NimbusBlock, 'persistence');
      }
    if (data.calendars) {
      const cal = Store.calendars;
      for (const k of Object.keys(cal)) delete cal[k];
      Object.assign(cal, data.calendars);
    }
    // firmedIds / fixedIds / per-task firmed in an old cache are deliberately ignored: the manual
    // firm is server state (task.firmed from GET /tasks), and browser-only firms are dropped.
    if (data.plants && Object.keys(data.plants).length) {
      const pl = Store.plants;
      for (const k of Object.keys(pl)) delete pl[k];
      Object.assign(pl, data.plants);
      Config.KNOWN_PLANTS.forEach(p => Store.ensurePlant(p));
    } else {
      Config.KNOWN_PLANTS.forEach(p => Store.ensurePlant(p));
    }
    if (Array.isArray(data.plantBlocks))
      for (const b of data.plantBlocks) {
        plantAttempts++;
        Store.addPlantBlock({ ...b, start: Util.parseDate(b.start), end: Util.parseDate(b.end) } as NimbusPlantBlock, 'persistence');
      }
    if (data.userSettings) Object.assign(Store.userSettings, data.userSettings);

    const lineDups  = lineAttempts  - (Store.blocks.length      - before.line);
    const plantDups = plantAttempts - (Store.plantBlocks.length - before.plant);
    const totalDups = lineDups + plantDups;
    if (totalDups > 0) {
      ErrorLog.warn?.('persistence', `Pruned ${totalDups} duplicate blackout block(s) from cache on load (line=${lineDups}, plant=${plantDups})`);
    }
  },

  _loadDemo(): void {
    // Stage 3 fix (see _loadCache/load): demo seeding also emits 'schedule:hydrated'
    // without ever loading rank maps, and its synthetic orders belong to no real
    // plant's priority lists at all — so any ranks left in the cache would be
    // categorically wrong for them.
    Persistence._rankMapsPlant = null;
    Store.setPriorityRankMaps({}, 'persistence');
    // Same reasoning as _loadCache(): the demo's synthetic orders belong to no
    // real plant's horizon config either, so any horizon bound left over from
    // whatever plant was on screen before the backend became unreachable would
    // be categorically wrong here too.
    Store.setVisibilityHorizonEnd(null, 'persistence');
    Store.setFrozenHorizonEnd(null, 'persistence');
    const lines = ['Line 1', 'Line 2', 'Line 3', 'Line 4'];
    const colors = ['WHITE', 'IVORY', 'TAN', 'BROWN', 'CHARCOAL', 'BLACK'];
    const forms  = ['SM', 'MD', 'LG', 'XL'];
    const today = Util.startOfDay(new Date())!;
    const tasks: Record<string, unknown>[] = [];
    let id = 1;
    for (let day = 0; day < 5; day++) {
      const dayDate = new Date(today); dayDate.setDate(today.getDate() + day);
      for (const line of lines) {
        let cursor = new Date(dayDate); cursor.setHours(7, 0, 0, 0);
        const count = 4 + Math.floor(Math.random() * 4);
        for (let i = 0; i < count; i++) {
          const run = +(0.5 + Math.random() * 2.5).toFixed(2);
          const start = new Date(cursor);
          const end   = new Date(cursor.getTime() + run * Config.MS_HOUR);
          tasks.push({
            id: String(id),
            text: `ORD-${String(id).padStart(4, '0')}`,
            ORDER: `ORD-${id}`,
            MACHINE: line,
            COLOR: colors[(id + day) % colors.length],
            FORM_SIZE: forms[(id + day) % forms.length],
            MATERIAL_DESCRIPTION: `Product ${String.fromCharCode(65 + (id % 8))}-${100 + id}`,
            MATERIAL_NUMBER: `MAT-${1000 + id}`,
            'ORDER_QUANTITY_(GMEIN)': 500 + Math.round(Math.random() * 4000),
            RUN_TIME: run,
            BASIC_START_DATE: new Date(dayDate),
            BASIC_FINISH_DATE: new Date(dayDate.getTime() + 12 * Config.MS_HOUR),
            start_date: start,
            end_date:   end
          });
          cursor = end;
          id++;
        }
      }
    }
    // Firm a couple of example orders to showcase the feature.
    if (tasks.length > 6) {
      tasks[2].firmed = true;
      tasks[10].firmed = true;
    }
    Store.setTasks(tasks as unknown as NimbusTask[], 'persistence');
    // Calendars, plant, and line settings
    for (const line of lines) {
      Store.ensureCalendar(line);
      Store.ensureLineSettings(line);
    }
    Config.KNOWN_PLANTS.forEach(p => Store.ensurePlant(p));
    // Example blackout block (maintenance on Line 2 from 12:00-13:00 tomorrow)
    const tomNoon = new Date(today); tomNoon.setDate(today.getDate() + 1); tomNoon.setHours(12, 0, 0, 0);
    const tomOne  = new Date(tomNoon); tomOne.setHours(13, 0, 0, 0);
    Store.addBlock({ line: 'Line 2', start: tomNoon, end: tomOne, reason: 'Maintenance' } as NimbusBlock, 'persistence');
    Store.emit({ type: 'schedule:hydrated', source: 'persistence' });
    Toast.show(Util.t('toast.demo_mode', { count: tasks.length }), 'info');
  },

  /** Fields saveAll() actually writes for one task, in wire shape (post
   *  toLocalSeconds date conversion) — deliberately excludes id/base_version/force
   *  (identity + concurrency metadata, not edit content). Used both to build
   *  taskPayload entries and, at response time, to snapshot the task's CURRENT
   *  live value for the "does this id's dirty flag still describe what we sent"
   *  compare in saveAll()'s success handler — keeping both call sites on this one
   *  function guarantees the two snapshots are comparable. */
  _taskEditSnapshot(t: NimbusTask): Record<string, unknown> {
    return {
      // Manual firm: sent only for rows whose firm the planner changed (see _firmDirtyIds).
      ...(Persistence._firmDirtyIds.has(String(t.id)) ? { FIRMED: !!t.firmed } : {}),
      planning_status: t.planning_status ?? 'scheduled',
      planning_reason: t.planning_reason ?? null,
      start_date: t.start_date ? Util.toLocalSeconds(t.start_date) as NaiveLocalTs : null,
      end_date:   t.end_date ? Util.toLocalSeconds(t.end_date) as NaiveLocalTs : null,
      PRT_01:       t.PRT_01,
      PRT_02:       t.PRT_02,
      PRODUCTION_VERSION: t.PRODUCTION_VERSION,
      RUN_TIME:      t.RUN_TIME,
      MACHINE:       t.MACHINE,
      schedule_segments: (t.scheduleSegments || []).map(segment => ({
        sequence: segment.sequence,
        start_date: Util.toLocalSeconds(segment.startDate) as NaiveLocalTs,
        end_date: Util.toLocalSeconds(segment.endDate) as NaiveLocalTs,
      })),
      // Note: PARENT_ORDER and DISTRIBUTION_LETTER are intentionally excluded (read-only)
    };
  },

  _refreshBaseline(t: NimbusTask): RefreshBaseline {
    return { edits: JSON.stringify(Persistence._taskEditSnapshot(t)),
      generation: taskEditGenerations.get(String(t.id)) ?? 0,
      collection: taskCollectionGeneration, version: t.row_version };
  },

  _warnUnresolvedConflict(): void {
    Toast.show('Conflicting changes remain unsaved. Reload discards these local edits and loads the server schedule.', 'warn', 8000);
  },

  /** `opts.silent`: programmatic callers (post-promote persist, banner action) skip the
   *  user-facing "save in progress" toast; an explicit user save (Ctrl+S) still shows it. */
  saveAll(opts: { silent?: boolean } = {}): void {
    // In sandbox, promote-then-save runs through Sandbox.exit(true), which itself
    // calls saveAll() after teardown — so return here to avoid a double POST (the
    // re-entrant call below does the single persist).
    if (Sandbox.active) { Sandbox.exit(true); return; }
    // A second saveAll() while one is already outbound would snapshot a NEW
    // payload from whatever Store state exists right now — including edits made
    // after the FIRST request already captured its own snapshot — and the two
    // requests' success handlers could then race each other's _dirtyIds cleanup.
    // No-op (with a warning) rather than queue: the in-flight save will itself
    // pick up any edit that lands before it snapshots, and any edit that lands
    // after is caught by _saveInFlight's caller (autosave/explicit save) retrying
    // on its own next tick — dirty ids are never cleared for anything this call
    // didn't actually send (see the per-id snapshot compare below).
    if (Persistence._saveInFlight) {
      ErrorLog.warn('persistence', 'saveAll() called while a save is already in flight — skipping');
      if (!opts.silent) Toast.show(Util.t('toast.save_in_progress'), 'warn', 4000);
      return;
    }
    // Send changed task aggregates (dates, planning state, segments and editable
    // attributes). Reload clears dirty state; undo is a new dependent edit.
    let dirtyTasks = Persistence._dirtyIds.size > 0
      ? Store.tasksArr.filter(t => Persistence._dirtyIds.has(String(t.id)))
      : [];
    const atomicOptimizer = dirtyTasks.some(t => Persistence._forceIds.has(String(t.id)));
    if (dirtyTasks.some(t => Persistence._conflictedIds.has(String(t.id)))) {
      Persistence._warnUnresolvedConflict();
      if (atomicOptimizer) return;
      dirtyTasks = dirtyTasks.filter(t => !Persistence._conflictedIds.has(String(t.id)));
      if (!dirtyTasks.length) return;
    }
    Persistence._saveInFlight = true;
    Persistence._saveCache();
    const saveCollection = taskCollectionGeneration;
    const refreshBaselines = new Map(dirtyTasks.map(t => [String(t.id), Persistence._refreshBaseline(t)]));
    // Send only the fields the backend consumes, plus the optimistic-concurrency
    // token (row_version → base_version). Optimizer edits use atomic validation
    // and cannot bypass a concurrent editor's version.
    // toLocalSeconds, not a raw Date: JSON.stringify would call Date.toISOString()
    // (UTC), but the orders read path emits bare naive strftime (no Z) which new
    // Date() parses as LOCAL — so a raw Date here round-trips shifted by the
    // client's UTC offset for any non-UTC user. Mirrors _relayDueDateCorrections;
    // see Util.toLocalSeconds and _taskEditSnapshot above.
    const taskPayload = dirtyTasks.map(t => ({
      id: t.id,
      ...Persistence._taskEditSnapshot(t),
      base_version: t.row_version ?? null,
      force:        atomicOptimizer ? false : !Config.CONCURRENCY_CHECK,
    }));
    // Snapshot of exactly what's being sent for each dirty id, keyed by id — the
    // response handler compares this against the LIVE value at response time
    // before clearing that id's dirty flag (see the success handler below), so an
    // edit made after this snapshot was taken (but before the response arrives)
    // is never silently treated as saved.
    const sentSnapshot = new Map<string, string>(
      dirtyTasks.map(t => [String(t.id), JSON.stringify(Persistence._taskEditSnapshot(t))])
    );
    const body = JSON.stringify({ tasks: taskPayload, atomic_optimizer: atomicOptimizer, blocks: Store.blocks, calendars: Store.calendars });

    // Stable reqId for this save attempt so the rejection log correlates to the
    // backend (fetchTraced reuses an x-request-id we already set).
    const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

    // Retry up to 3 times on network failures; don't retry 4xx (server rejections).
    const _post = (attempt: number): Promise<BulkUpdateResult> => Util.fetchTraced(`${Config.API_BASE}/tasks/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-request-id': reqId },
      body,
      // A hung request would hold _saveInFlight forever (every later Save is skipped).
      // Generous because a real bulk save is slow, but bounded.
      signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    }).then(async r => {
      if (!r.ok) {
        const parsed = await Util.parseBackendError(r);
        const err = new Error(parsed.message) as SaveError;
        err.httpStatus = r.status; err.errorCode = parsed.errorCode; err.reqId = reqId;
        throw err;
      }
      return r.json() as Promise<BulkUpdateResult>;
    }).catch(e => {
      // A timed-out POST may still be applied server-side; retrying it blind could double-send.
      // Surface it and let the planner re-save (version tokens reconcile any partial apply).
      if ((e as Error)?.name === 'TimeoutError') { (e as SaveError).timedOut = true; throw e; }
      if (e.httpStatus || attempt >= 3) throw e;
      return new Promise(res => setTimeout(res, 2000)).then(() => _post(attempt + 1));
    });

    _post(1)
      .then(result => {
        if (saveCollection !== taskCollectionGeneration) return;
        const runtimePreviewChanged = Object.values(result.rejection_reasons || {}).includes('runtime_preview_changed');
        if (runtimePreviewChanged) {
          // Rate-map changes can invalidate a locally valid preview without an
          // order version change. Refresh the cache for the next edit/retry;
          // ordinary stale reconciliation below still protects newer local work.
          void Runtime.load(Store.selectedPlant);
          ErrorLog.warn('persistence', 'Routing rates changed; rejected runtime previews require review', result.rejection_reasons);
          Toast.show(atomicOptimizer
            ? 'Routing rates changed. Optimizer changes remain unsaved. Review the updated rates and optimize again.'
            : 'Routing rates changed. Rejected orders are being refreshed. Review the schedule before retrying your changes.', 'warn', 8000);
        }
        const unknownMachineCount = Object.values(result.rejection_reasons || {}).filter(r => r === 'machine_unknown').length;
        if (unknownMachineCount) {
          Toast.show(Util.t('toast.machine_rejected', { count: unknownMachineCount }), 'warn', 7000);
        }
        if (atomicOptimizer && (result.status === 'error' || (result.persisted ?? 0) !== taskPayload.length
          || (result.stale || []).length || (result.invalid_ids || []).length || (result.not_found_ids || []).length)) {
          ErrorLog.warn('persistence', 'Optimizer save rejected; all dependent changes remain unsaved', result);
          if (result.error_code === 'schedule.conflicts') {
            Toast.show(Util.t('toast.optimizer_conflicts', { count: (result.conflicts || []).length }), 'warn', 8000);
          } else if (!runtimePreviewChanged) {
            Toast.show('Optimizer changes remain unsaved. Resolve the conflict or reload and optimize again.', 'warn', 8000);
          }
          return;
        }
        // Re-stamp each persisted task with its NEW row_version so the next edit
        // carries a fresh token — without this the client would self-conflict on its
        // own previous write. Direct field set, no emit (metadata only).
        const versions = result.versions || {};
        for (const id of Object.keys(versions)) {
          const tk = Store.tasks[id];
          if (tk) tk.row_version = versions[id];
        }
        // PR-1: ids the backend reports as no longer existing server-side —
        // deleted by another session, a purge, a re-upload, etc. — are ghosts
        // in Store the instant this response arrives; leaving them in place
        // just means _saveCache re-persists them to localStorage forever. Drop
        // them from Store (and their dirty/force flags) instead of merely
        // treating them as "accounted for" below.
        const notFoundIds = (result.not_found_ids || []).map(String);
        if (notFoundIds.length) {
          const removed = Persistence._removeMissingTasks(notFoundIds);
          if (removed) {
            ErrorLog.warn('persistence', `${removed} order(s) no longer exist server-side — removed from Store`, notFoundIds);
            Toast.show(Util.t('toast.orders_removed_remotely', { count: removed }), 'warn', 6000);
          }
        }
        const stale = result.stale || [];
        // Clear dirty/force ONLY for ids the backend actually accounted for (R7):
        // persisted (versions) and terminally rejected (invalid range / not in DB
        // — a corrected edit re-dirties). Stale rows stay dirty until their
        // guarded authoritative refresh succeeds.
        // Any sent id that is NONE of these — e.g. a row lost between SELECT FOR UPDATE
        // and the UPDATE — stays dirty so the next save retries it instead of silently
        // dropping the edit. Previously both sets were .clear()'d unconditionally.
        const accounted = new Set([
          ...Object.keys(versions),
          ...(result.invalid_ids || []),
          ...(result.not_found_ids || []),
        ].map(String));
        for (const id of accounted) {
          // R8: an id being "accounted for" by this response is necessary but not
          // sufficient to clear its dirty flag. If the user edited this task AGAIN
          // after this request's payload was snapshotted (sentSnapshot) but before
          // this response arrived, the live value no longer matches what was
          // actually sent — clearing dirty here would silently drop that newer
          // edit (it was never transmitted, and nothing would ever retry it).
          // Only clear when the live task still equals its sent snapshot.
          const tk = Store.tasks[id];
          const sentValue = sentSnapshot.get(id);
          const stillMatchesSent = tk != null && sentValue !== undefined
            && JSON.stringify(Persistence._taskEditSnapshot(tk)) === sentValue;
          if (stillMatchesSent) {
            Persistence._dirtyIds.delete(id);
            Persistence._forceIds.delete(id);
            Persistence._firmDirtyIds.delete(id);
          }
          // else: leave dirty — the next saveAll() will pick up the newer edit.
        }
        if (stale.length) {
          ErrorLog.warn('persistence', `Concurrency conflict on ${stale.length} order(s) — refetching`, stale);
          Persistence._refreshTasks(stale, refreshBaselines);
          if (!runtimePreviewChanged) Toast.show(Util.t('toast.concurrent_edit_conflict', { count: stale.length }), 'warn', 7000);
        }
        // N3: the server scanned the written machines inside the save
        // transaction. Advisory — rows are persisted; surface the overlaps now
        // instead of waiting for the next full alert recompute. Emitted as a
        // Store event because this file must never import insights/services.
        const conflicts = result.conflicts || [];
        if (conflicts.length) {
          const lines = [...new Set(conflicts.map(c => c.machine))];
          ErrorLog.warn('persistence', `Save produced ${conflicts.length} schedule conflict(s)`, conflicts);
          Toast.show(Util.t('toast.save_conflicts', { count: conflicts.length }), 'warn', 7000);
          Store.emit({ type: 'schedule:conflicts', lines, source: 'persistence' });
        }
        const persisted = result.persisted ?? 0;
        const total     = result.updated   ?? 0;
        if (stale.length) {
          // Conflicts already surfaced their own toast; don't also claim a partial-save error.
        } else if (persisted < total) {
          ErrorLog.warn('persistence', `Partial DB save: ${persisted}/${total} persisted`, result);
          const rejected = describeRejections(result.rejection_reasons);
          Toast.show(rejected
            ? Util.t('toast.partial_db_save_reasons', { persisted, total, details: rejected })
            : Util.t('toast.partial_db_save', { persisted, total }), 'warn', rejected ? 9000 : 6000);
        } else {
          ErrorLog.info('persistence', `Saved to backend (${persisted} tasks)`);
          Toast.show(Util.t('toast.saved_to_backend'), 'success');
        }
      })
      .catch(e => {
        if (e.httpStatus) {
          ErrorLog.error('persistence', `Backend rejected save (${e.httpStatus}): ${e.message}`,
            { status: e.httpStatus, reqId: e.reqId },
            { reqId: e.reqId, errorCode: e.errorCode || 'http.status' });
          Toast.show(Util.t('toast.save_rejected', { msg: e.message }), 'error', 6000);
        } else if (e.timedOut) {
          ErrorLog.error('persistence', `Backend save timed out after ${SAVE_TIMEOUT_MS} ms`,
            { reqId }, { reqId, errorCode: 'http.timeout' });
          Toast.show(Util.t('toast.save_timeout'), 'error', 8000);
        } else {
          ErrorLog.warn('persistence', `Backend save failed: ${e.message}`,
            { reqId }, { reqId, errorCode: 'http.network' });
          Toast.show(Util.t('toast.saved_locally'), 'info');
        }
      })
      .finally(() => { Persistence._saveInFlight = false; Persistence._syncUnsaved(); Persistence._saveCache(); });
  },

  /** PR-1: ids the backend reports as no longer existing server-side (refresh's
   *  `missing` / save's `not_found_ids`) — drop the ghost from Store (cleaning up
   *  dependencies/firmedIds/Selection via Store.removeTask) and clear any stale
   *  dirty/force flag so a removed id is never resent on the next save. Shared
   *  by _refreshTasks and saveAll's success handler so both ghost-removal paths
   *  stay identical. Returns how many ids were actually present to remove, so
   *  callers only toast when something real happened. */
  _removeMissingTasks(ids: string[]): number {
    let removed = 0;
    for (const rawId of ids) {
      const id = String(rawId);
      Persistence._dirtyIds.delete(id);
      Persistence._forceIds.delete(id);
      Persistence._conflictedIds.delete(id);
      if (Store.removeTask(id, 'persistence')) removed++;
    }
    return removed;
  },

  /** Optimistic-concurrency reconciliation: replace the complete server aggregate
   *  only when the rejected edit is still current. Newer local edits retain their
   *  old version and stay unresolved until explicit reload/discard. Emits once with source
   *  'refresh' — the dirty/autosave subscribers ignore that source so we don't
   *  re-dirty or write the rows we just pulled (see project_store_fanout). */
  _refreshTasks(ids: string[], savedBaselines?: Map<string, RefreshBaseline>): void {
    if (!ids || !ids.length) return;
    const collection = taskCollectionGeneration;
    const baselines = savedBaselines ?? new Map(ids.flatMap(id => {
      const task = Store.tasks[String(id)];
      return task ? [[String(id), Persistence._refreshBaseline(task)] as const] : [];
    }));
    for (const rawId of ids) {
      const id = String(rawId);
      if (Store.tasks[id]) {
        Persistence._conflictedIds.add(id);
        Persistence._dirtyIds.add(id);
      }
    }
    const unchanged = (id: string): boolean => {
      const task = Store.tasks[id], baseline = baselines.get(id);
      return !!task && !!baseline && baseline.collection === taskCollectionGeneration
        && baseline.generation === (taskEditGenerations.get(id) ?? 0)
        && baseline.version === task.row_version
        && baseline.edits === JSON.stringify(Persistence._taskEditSnapshot(task));
    };
    Util.fetchTraced(`${Config.API_BASE}/tasks/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
      .then(r => r.ok ? r.json() as Promise<TasksRefreshResponse> : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(({ data, missing }) => {
        if (collection !== taskCollectionGeneration) return;
        const applied: string[] = [];
        let retained = false;
        for (const row of (data || [])) {
          const tk = Store.tasks[String(row.id)];
          if (!tk) continue;
          if (!unchanged(String(row.id))) { retained = true; continue; }
          tk.MACHINE = row.MACHINE ?? '';
          tk.PRT_01 = row.PRT_01 ?? '';
          tk.PRT_02 = row.PRT_02 ?? '';
          tk.PRODUCTION_VERSION = row.PRODUCTION_VERSION ?? null;
          tk['ORDER_QUANTITY_(GMEIN)'] = row['ORDER_QUANTITY_(GMEIN)'] ?? null;
          tk.MATERIAL_NUMBER = row.MATERIAL_NUMBER ?? '';
          tk.PLANT = row.PLANT ?? '';
          tk.original_start_date = Util.parseDate(row.original_start_date);
          tk.BASIC_START_DATE = Util.parseDate(row.original_start_date);
          tk.RUN_TIME = row.RUN_TIME ?? null;
          tk.run_time_source = row.run_time_source;
          tk.run_time_basis = row.run_time_basis;
          tk.start_date  = Util.parseDate(row.start_date);
          tk.end_date    = Util.parseDate(row.end_date);
          const planning = row as unknown as { planning_status?: NimbusTask['planning_status']; planning_reason?: NimbusTask['planning_reason'] };
          tk.planning_status = planning.planning_status ?? 'scheduled';
          tk.planning_reason = planning.planning_reason ?? null;
          tk.scheduleSegments = Persistence._segmentsFromRaw(row as unknown as Record<string, unknown>);
          tk.runtime_schedule_mismatch = !!row.runtime_schedule_mismatch;
          // The server's manual firm is authoritative; _normalizeDates re-syncs firmedIds from it.
          // (TaskVersionRow.firmed is not in the generated types until the backend task regenerates them.)
          const serverFirmed = (row as unknown as { firmed?: boolean }).firmed;
          if (typeof serverFirmed === 'boolean') tk.firmed = serverFirmed;
          Store._normalizeDates(tk);
          tk.row_version = row.row_version as number | null;
          Persistence._dirtyIds.delete(String(row.id));
          Persistence._forceIds.delete(String(row.id));
          Persistence._conflictedIds.delete(String(row.id));
          Persistence._firmDirtyIds.delete(String(row.id));
          applied.push(String(row.id));
        }
        if (applied.length) {
          Store.rebuildPlantIndex();
          Store.emit({ type: 'tasks:bulkUpdate', ids: applied, source: 'refresh' });
        }
        // PR-1: ids the server says no longer exist (deleted by another
        // session, a purge, an upload, etc.) — remove the ghost from Store
        // instead of silently leaving it to be re-persisted by _saveCache.
        const missingIds = (missing || []).map(String).filter(id => {
          if (!Store.tasks[id] || unchanged(id)) return true;
          retained = true;
          return false;
        });
        if (missingIds.length) {
          const removed = Persistence._removeMissingTasks(missingIds);
          if (removed) {
            ErrorLog.warn('persistence', `${removed} order(s) no longer exist server-side — removed from Store`, missingIds);
            Toast.show(Util.t('toast.orders_removed_remotely', { count: removed }), 'warn', 6000);
          }
        }
        if (retained) Persistence._warnUnresolvedConflict();
      })
      .catch(e => {
        ErrorLog.warn('persistence', `Conflict refetch failed: ${e.message}`, ids);
        Toast.show(Util.t('toast.conflict_refresh_failed'), 'error', 8000);
      })
      .finally(() => {
        if (collection !== taskCollectionGeneration) return;
        Persistence._syncUnsaved();
        Persistence._saveCache();
      });
  },

  /** Force a full reload from backend, bypassing cache. Returns the load Promise. */
  reload(): Promise<void> {
    ErrorLog.info('persistence', 'Manual reload triggered — discarding local edits after successful hydration');
    return Persistence.load({ force: true, plant: Persistence._currentLoadedPlant ?? Persistence._lastAttemptedPlant, discardLocalEdits: true });
  },

  /** Fetch tasks for a specific plant, replacing whatever is currently in Store.
   *  Skips the fetch if that plant is already loaded. */
  loadForPlant(plant: string | null): Promise<void> {
    if (!plant || plant === Persistence._currentLoadedPlant) return Promise.resolve();
    const deps = Store.dependencies;
    for (const k of Object.keys(deps)) delete deps[k];
    return Persistence.load({ plant });
  },

  /** Fetch this plant's priority rank maps ({machine_or_empty: {field_key: {VALUE:
   *  RANK}}}) — the optimizer's Stage 3 hot-path tie-break source (GET
   *  /priority-rank-maps, brain.py's in-memory PLANT_LISTS, no reshaping). Unlike
   *  loadForPlant, this deliberately does NOT skip on "already loaded for this
   *  plant" — Stage 2's upload/delete handlers (Plant._handleUploadResult /
   *  Plant._confirmDeletePriorityList, plant-and-administration.mts) call this
   *  directly to refresh the cache after a list changes while staying on the same
   *  plant, and a dedup check would silently defeat that. Always returns (never
   *  rejects) once Store.priorityRankMaps reflects the outcome, so a caller that
   *  needs freshness (Task 6's OptimizerPreview.runWithPreview) can await it
   *  instead of racing a fire-and-forget fetch — see `_rankMapsPlant` above. */
  async loadPriorityRankMaps(plant: string | null): Promise<void> {
    if (!plant) {
      Persistence._rankMapsPlant = null;
      Store.setPriorityRankMaps({});
      return;
    }
    try {
      // Util.fetchTraced, NOT bare fetch: GET /priority-rank-maps is plant-gated
      // (brain.py's _assert_plant_allowed, same as its siblings), and the actor
      // identity that gate reads travels on the x-user-email header fetchTraced
      // attaches — a bare fetch 403s for any plant-restricted user. This is the
      // same coupling that produced a production-only failure in Stage 2 (the
      // missing-master-data fetch). Also restores x-request-id correlation, so a
      // failing rank-map load can be tied to its backend log entry.
      const r = await Util.fetchTraced(`${Config.API_BASE}/priority-rank-maps?plant=${encodeURIComponent(plant)}`);
      if (r.ok) {
        Store.setPriorityRankMaps(await r.json() as PriorityRankMaps);
        // Only recorded on a TRUE success (2xx) — a non-ok response (transient
        // 5xx on a single-replica restart, a corp-proxy pre-roll response) is
        // treated the same as a thrown/rejected fetch below and leaves this
        // untouched, so a later freshness check (`_rankMapsPlant !== plant`)
        // still sees a mismatch and retries instead of wrongly trusting an
        // empty cache as "fresh" — mirrors CalendarSync.fetchPlantConfig's own
        // `r.ok ? r.json() : Promise.reject(...)` treatment of a non-ok status.
        Persistence._rankMapsPlant = plant;
      } else {
        Store.setPriorityRankMaps({});
      }
    } catch (e) {
      ErrorLog.warn('persistence', `Priority rank maps fetch failed for ${plant}: ${(e as Error).message}`);
      Store.setPriorityRankMaps({});
    }
  },

  /** Drop any setup truth before a request starts. This is intentionally not
   * persisted alongside schedule state: Stage 0 observes setup data only. */
  _invalidateSetupSnapshot(source?: string): void {
    Persistence._setupSnapshotRequest++;
    Persistence._setupSnapshotPlant = null;
    Store.replaceSetupSnapshot(null, source);
  },

  /** Hydrate one plant's setup definition, matrix, state, and overrides.
   * A response can only replace Store when it belongs to the latest request and
   * the requested plant, preventing stale/cross-plant setup truth from leaking
   * into the active board. Failed loads intentionally leave the Store empty and
   * freshness stale so a later caller retries. */
  async loadSetupSnapshot(plant: string): Promise<SetupSnapshot | null> {
    if (!plant) return null;
    Persistence._invalidateSetupSnapshot('persistence');
    const request = Persistence._setupSnapshotRequest;
    try {
      const response = await Util.fetchTraced(`${Config.API_BASE}/setup/${encodeURIComponent(plant)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status} from /setup/${plant}`);
      const snapshot = await response.json() as SetupSnapshot;
      if (request !== Persistence._setupSnapshotRequest || snapshot?.plant !== plant) return null;
      Store.replaceSetupSnapshot(snapshot, 'persistence');
      Persistence._setupSnapshotPlant = plant;
      return snapshot;
    } catch (e) {
      if (request === Persistence._setupSnapshotRequest) {
        ErrorLog.warn('persistence', `Setup snapshot fetch failed for ${plant}: ${(e as Error).message}`);
      }
      return null;
    }
  },

  /** The plant the user last had selected, read straight from the cache so the
   *  boot load can scope to it (the backend is stateless — unscoped means
   *  fetching every plant's orders, which doesn't scale). null = none remembered. */
  _rememberedPlant(): string | null {
    try {
      const raw = localStorage.getItem(Config.LS_KEY);
      if (!raw) return null;
      return JSON.parse(raw)?.selectedPlant || null;
    } catch { return null; }
  },

  /** Wipe the localStorage cache (user-initiated from the Log drawer). */
  clearCache(): void {
    try { localStorage.removeItem(Config.LS_KEY); ErrorLog.info('persistence', 'Cache cleared'); Toast.show(Util.t('toast.cache_cleared'), 'success'); }
    catch (e) { ErrorLog.error('persistence', `Cache clear failed: ${(e as Error).message}`); }
  },

  _saveCache(): void {
    if (Persistence._cacheWritesHalted) return;
    try {
      // Annotated so a future field rename on either side (Store or StoredState)
      // is caught here rather than silently drifting.
      const snapshot: StoredState = {
        _schemaVersion: Config.SCHEMA_VERSION,
        _buildId:       Config.BUILD_ID,
        _savedAt:       new Date().toISOString(),
        _optimizerDirtyIds: [...Persistence._forceIds].filter(id => Persistence._dirtyIds.has(id)),
        _dirtyIds:      [...Persistence._dirtyIds],
        // firm is server state: never cached (a cached copy could revive a stale firm).
        tasks:          Store.tasksArr.map(({ firmed: _firmed, ...rest }) => rest as Record<string, unknown>),
        blocks:         Store.blocks,
        calendars:      Store.calendars,
        plants:         Store.plants,
        plantBlocks:    Store.plantBlocks,
        lineSettings:   Store.lineSettings,
        selectedPlant:  Store.selectedPlant,
        userSettings:   Store.userSettings
      };
      Persistence._writeCacheWithQuotaGuard(snapshot);
    } catch (e) {
      ErrorLog.warn('persistence', `Cache save failed: ${(e as Error).message}`);
    }
  },

  _writeCacheWithQuotaGuard(snapshot: StoredState): boolean {
    const baseMeta = {
      _schemaVersion: snapshot._schemaVersion,
      _buildId:       snapshot._buildId,
      _savedAt:       snapshot._savedAt,
    };
    // NOTE (deviation from the task brief's inline guidance): the brief suggested
    // typing `tiers` as `StoredState[]` on the theory that every tier "still
    // satisfies the full shape." That is not actually true of the last (most
    // degraded) tier below — it omits `blocks`/`calendars`/`plants`/`plantBlocks`
    // entirely, not just sets them empty. Fabricating those fields as `[]`/`{}`
    // to force a `StoredState[]` fit would be a real behavior change, not a
    // types-only one: `_restoreNonTaskState`'s `if (data.calendars) {...}` guard
    // treats a present-but-empty `{}` as truthy and would clear every entry in
    // Store.calendars on the next load of this degraded cache, whereas an
    // absent key today leaves Store.calendars untouched. `Partial<StoredState>`
    // is the correct, honest type for `tiers` — every tier is still a valid
    // (partial) StoredState snapshot, and JSON.stringify/localStorage.setItem
    // below don't care that some tiers omit keys.
    const tiers: Array<Partial<StoredState>> = snapshot._optimizerDirtyIds?.length ? [snapshot] : [
      snapshot,
      { ...snapshot, tasks: snapshot.tasks.slice(-2000) },
      { ...snapshot, tasks: snapshot.tasks.slice(-500) },
      { ...baseMeta,
        selectedPlant: snapshot.selectedPlant,
        lineSettings:  snapshot.lineSettings,
        tasks:         [] },
    ];
    for (let i = 0; i < tiers.length; i++) {
      try {
        const payload = JSON.stringify(tiers[i]);
        localStorage.setItem(Config.LS_KEY, payload);
        Persistence._lastCacheBytes = payload.length;
        Persistence._lastCacheAt    = Date.now();
        if (i > 0) {
          ErrorLog.warn('persistence',
            `Cache evicted to tier ${i} (${(payload.length / 1024).toFixed(1)} KB) due to quota pressure`);
          Persistence._cacheDegraded = true;
        } else {
          Persistence._cacheDegraded = false;
        }
        return true;
      } catch (e) {
        // Try next tier on QuotaExceededError; bail on anything else from tier 0
        const err = e as DOMException;
        if (i === 0 && err?.name !== 'QuotaExceededError' && err?.code !== 22) {
          ErrorLog.warn('persistence', `Cache write failed (${err.name}): ${err.message}`);
          return false;
        }
      }
    }
    ErrorLog.error('persistence', 'Cache write failed at all eviction tiers — autosave disabled this session');
    Persistence._autosaveDisabled = true;
    return false;
  },

  _quarantineCache(raw: string): void {
    try {
      const key = `${Config.LS_KEY}.quarantine.${Date.now()}`;
      localStorage.setItem(key, raw.slice(0, 200_000));
      Persistence._lastQuarantineKey = key;
    } catch {}
  },

  storageInventory(): { totalBytes: number; count: number; items: Array<{ key: string; bytes: number }>; degraded: boolean; lastBytes: number; lastSavedAt: number; autosaveDisabled: boolean } {
    let total = 0, count = 0;
    const items: Array<{ key: string; bytes: number }> = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i) as string;
        const v = localStorage.getItem(k) || '';
        const bytes = (k.length + v.length) * 2;   // UTF-16 estimate
        total += bytes;
        count++;
        items.push({ key: k, bytes });
      }
    } catch (e) { ErrorLog.warn('persistence', `Inventory failed: ${(e as Error).message}`); }
    items.sort((a, b) => b.bytes - a.bytes);
    return {
      totalBytes:       total,
      count,
      items,
      degraded:         !!Persistence._cacheDegraded,
      lastBytes:        Persistence._lastCacheBytes || 0,
      lastSavedAt:      Persistence._lastCacheAt || 0,
      autosaveDisabled: !!Persistence._autosaveDisabled,
    };
  },

  _autosave: Util.debounce(() => {
    if (typeof Sandbox !== 'undefined' && Sandbox.active) return;
    if (Persistence._autosaveDisabled) return;
    Persistence._saveCache();
  }, 1200)
};

// Track edits even when a value changes and is subsequently changed back. A
// failed save's refresh must only reconcile the rejected edit, never newer work.
Store.subscribe(evt => {
  if (evt.type === 'tasks:bulk') {
    taskCollectionGeneration++;
    taskEditGenerations.clear();
    if (evt.source === 'persistence') Persistence._conflictedIds.clear();
    return;
  }
  if (evt.source === 'refresh') return;
  const ids = evt.type === 'task:update' ? [String(evt.id)]
    : (evt.type === 'tasks:bulkUpdate' || evt.type === 'firmed:change') ? ((evt.ids ?? []) as Array<string | number>).map(String) : [];
  for (const id of ids) taskEditGenerations.set(id, (taskEditGenerations.get(id) ?? 0) + 1);
}, 'Persistence.conflictGenerations');

