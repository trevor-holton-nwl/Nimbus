// scheduling/persistence.mjs — Persistence (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split schedule-data.mts
// (2,204 lines) into 3 domain files). Owns backend fetch + localStorage
// cache, offline-cache fallback, and save. Must NEVER import from
// optimization/engine.mjs, calendar/calendar-engine.mjs, or
// insights/services.mjs — only the reverse direction is allowed. The two
// real cross-package dependencies below predate this phase (Phase 2
// research, schedule-data.mts's original split from app.js) and are
// preserved exactly as they were:
//   - (Backward scheduling Task 2.5 removed the former calendar seam,
//     `Persistence.setCalendarService`: the load-time re-snap of ingested
//     orders it served is gone; the reconcile derives never-placed rows.)
//   - Persistence used to call `Alerts.scheduleRecompute()` after every
//     hydration. It emits a `{ type: 'schedule:hydrated', source }` Store
//     event instead; optimization/engine.mjs subscribes to it once.
//
// `CalendarSync` (calendar/calendar-sync.mjs) is a real cross-file import
// forming a two-way ESM cycle with that module — CalendarSync's flush path
// calls back into this file's `_dirtyIds`/`_forceIds`/
// `_saveCache` (see calendar/calendar-sync.mjs's
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
import type { NimbusTask, NimbusBlock, NimbusPlantBlock, StoredState, NaiveLocalTs, PriorityRankMaps, SetupSnapshot, OrderScheduleSegment, NimbusMasterWorkcenter, NimbusToolInventoryRow } from '../platform/types.mjs';
import type { components } from '../types/api-generated.mjs';

/** Store event source tag -> the per-task `source` the server records in schedule_event (PLANNER_SOURCES in
 *  backend/schedule_events/events.py). Tags absent here (distribution, refresh, note, engine-runtime-reconcile)
 *  never reach the wire; the server defaults those saves to 'planner'. */
export const SOURCE_WIRE: Readonly<Record<string, string>> = {
  timeline: 'drag', interaction: 'keyboard', table: 'grid', inspector: 'inspector', ctx: 'inspector',
  alerts: 'alert_fix', engine: 'optimizer', 'engine-backlog': 'optimizer', undo: 'undo',
};

// -- Backend DTOs generated from brain.py's Pydantic response_model=s (Task 1/2
//    of this phase) — see docs/archive/typescript_migration.md §F. Endpoints brain.py
//    does not yet model (/health, /master-data/*) get hand-written local
//    interfaces below instead, per this phase's scope.
type TasksResponse        = components['schemas']['TasksResponse'];
type BulkUpdateResult     = components['schemas']['BulkUpdateResult'];
type TasksRefreshResponse = components['schemas']['TasksRefreshResponse'];

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
// S7-7: the backend-unreachable notice stays up this long (effectively until the reconnect watcher recovers).
const UNREACHABLE_TOAST_MS = 600_000;
/** S7-2: ceiling for the /tasks/refresh conflict reconciliation fetch. */
const REFRESH_TIMEOUT_MS = 15_000;

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
  source: 'backend' | 'cache' | null;
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

type SetupWriteKind = 'definition' | 'matrix' | 'state' | 'override' | 'value-default';
let _setupWriteListener: ((plant: string, kind: SetupWriteKind) => void) | null = null;

/* =============================================================================
   PERSISTENCE — backend fetch, save + local cache.
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

/** S7-9: the quota-eviction tiers for one cache snapshot, most complete first. Every tier below the first trims
 *  CLEAN tasks only: a dirty (unsaved) task is never evicted, because losing it loses the planner's edit. A snapshot
 *  carrying optimizer-dirty ids is written whole (a partial dependent task set must never be cached). */
export function cacheTiers(snapshot: StoredState): Array<Partial<StoredState>> {
  if (snapshot._optimizerDirtyIds?.length) return [snapshot];
  const dirty = new Set((snapshot._dirtyIds ?? []).map(String));
  const dirtyTasks = snapshot.tasks.filter(t => dirty.has(String(t.id)));
  const clean = snapshot.tasks.filter(t => !dirty.has(String(t.id)));
  const keep = (n: number): Array<Record<string, unknown>> =>
    [...clean.slice(Math.max(0, clean.length - Math.max(0, n - dirtyTasks.length))), ...dirtyTasks];
  return [
    snapshot,
    { ...snapshot, tasks: keep(2000) },
    { ...snapshot, tasks: keep(500) },
    { _schemaVersion: snapshot._schemaVersion,
      _buildId:       snapshot._buildId,
      _savedAt:       snapshot._savedAt,
      _dirtyIds:      dirtyTasks.map(t => String(t.id)),
      selectedPlant:  snapshot.selectedPlant,
      lineSettings:   snapshot.lineSettings,
      tasks:          dirtyTasks },
  ];
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
  /** True once the selected plant's whole load fan-out (tasks, master data, calendars, rate maps, setup snapshot) has
   *  resolved; cleared at the top of every load(). A plain flag, never a Store event (an event would bump the revision).
   *  Schedule Confidence holds its first paint until this is true so the badge does not jump when late inputs arrive. */
  bootReady: false,
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
  // The plant calendar fingerprint (`calendar_version` on /tasks/horizons) this tab last hydrated, per plant. The
  // first value seen is the baseline (the boot hydration already loaded that calendar); a later different value
  // means another session changed the calendar, so the plant config is re-fetched (see _noteCalendarVersion).
  _calendarVersion: {} as Record<string, string>,
  _calendarRefreshing: new Set<string>(),
  // Tool Inventory (Wave 3). The plant whose rows Store.masterData.tool_inventory currently holds (null = none):
  // a load for any other plant clears the key at once so the previous plant's counts are never judged against
  // the new plant's orders. Never "empty": undefined means not loaded / the fetch failed.
  _toolInventoryPlant: null as string | null,
  // Per-plant baseline: the server's own tool_inventory_version string, read BEFORE the rows were fetched and kept
  // verbatim (never recomputed client-side). The first /tasks/horizons probe that disagrees (see
  // _noteToolInventoryVersion) re-fetches. Undefined = the version read failed or nothing good is held.
  _toolInventoryBaseline: {} as Record<string, string | undefined>,
  _toolInventoryRefreshing: new Set<string>(),
  _toolingRuleRefreshing: new Set<string>(),
  // Plants already warned about an unavailable inventory this session (one ErrorLog.warn + toast each).
  _toolInventoryWarned: new Set<string>(),
  // Seam wired by the shell: true while a Gantt drag is in flight (persistence cannot import gantt).
  _calendarRefreshBlocked: null as null | (() => boolean),
  // Plants whose calendar / tool-inventory probe was skipped by the drag block; re-probed when the drag ends.
  _deferredRefreshPlants: new Set<string>(),
  runDeferredRefreshes(): Promise<boolean> {
    const plants = [...Persistence._deferredRefreshPlants];
    Persistence._deferredRefreshPlants.clear();
    return Promise.all(plants.map(p => Persistence.refreshHorizons(p))).then(r => r.some(Boolean));
  },
  _dirtyIds: new Set<string>(),       // task ids mutated since last successful backend save
  _forceIds: new Set<string>(),       // historical name: dependent optimizer/undo edits require atomic version checks
  /** Does this task id carry unsaved local edits? (The engine's reconcile never re-derives such a row.) */
  isDirty(id: string): boolean { return Persistence._dirtyIds.has(id); },
  /** Forget one task's unsaved-edit mark (the dirty and force sets together). */
  discardDirty(id: string): void { Persistence._dirtyIds.delete(id); Persistence._forceIds.delete(id); },
  _conflictedIds: new Set<string>(),  // retained local edits cannot adopt a server version without reconciliation
  // Ids whose manual firm the planner changed (Firm/Unfirm/undo). Only these rows send FIRMED:
  // an ordinary date edit must not write this client's possibly stale firm copy back over
  // another planner's firm. Never an optimizer (atomic) marker; see App._trackDirty.
  _firmDirtyIds: new Set<string>(),
  // Per-task wire `source` for the schedule_event history (id -> 'drag' | 'keyboard' | ...). Last writer wins;
  // set by App._trackDirty from the Store event source via SOURCE_WIRE. Deliberately NOT persisted in the offline
  // cache: ids restored from the cache save without a source and the server records them as 'planner'.
  _dirtySource: new Map<string, string>(),
  // S7-2: ids whose conflict refresh failed or timed out, with what the retry needs (see _retryFailedRefreshes).
  _refreshRetry: new Map<string, { baseline: RefreshBaseline | undefined; sent: string | undefined }>(),
  /** S10-9: true while a planner's note for this order is typing/unsaved (debounce pending or in the failed-retry set).
   *  orders.mts registers the real predicate (persistence cannot import it); a refresh must not overwrite such a note. */
  noteUnsaved: ((_id: string): boolean => false) as (id: string) => boolean,
  /** Stable per-tab id sent as `client_id` on every save (reserved for a future change feed). */
  get clientId(): string {
    const fresh = (): string => (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    try {
      const k = 'nimbus.client_id';
      const have = sessionStorage.getItem(k);
      if (have) return have;
      const id = fresh();
      sessionStorage.setItem(k, id);
      return id;
    } catch {
      if (!Persistence._clientIdFallback) Persistence._clientIdFallback = fresh();
      return Persistence._clientIdFallback;
    }
  },
  _clientIdFallback: '' as string,
  /** schedule_event retention window (days), from the system-settings blob the boot fetch loads. Default 14. */
  scheduleEventRetentionDays: 14,
  async confirmPlantSwitch(plant: string | null): Promise<boolean> {
    if (plant === Store.selectedPlant || Persistence._dirtyIds.size === 0) return true;
    const discard = await Modal.confirm({
      title: Util.t('modal.discard_schedule_title'),
      message: Util.t('modal.discard_schedule_message'),
      confirmLabel: Util.t('btn.discard_and_switch'),
      tone: 'warn',
    });
    if (!discard) return false;
    Persistence.discardUnsavedForPlantSwitch();
    return true;
  },
  /** Drop every unsaved-edit set (the outgoing plant's). Shared by the confirmed plant switch and the What-If
   *  auto-exit, whose discard hands the pre-What-If sets back before the switch completes. */
  discardUnsavedForPlantSwitch(): void {
    Persistence._dirtyIds.clear();
    Persistence._forceIds.clear();
    Persistence._conflictedIds.clear();
    Persistence._firmDirtyIds.clear();
    Persistence._dirtySource.clear();
    // A later re-selection of the outgoing plant must fetch its saved state,
    // including when the user cleared the selector before re-selecting it.
    Persistence._currentLoadedPlant = null;
    Persistence._syncUnsaved();
  },
  /** Undo-settle baseline: per order, the last SERVER-sourced saved state (the `_taskEditSnapshot` key, minus the
   *  per-edit `source`/`FIRMED` markers, plus the row_version it was taken at). Recorded only from a server load of a row
   *  no cached edit was overlaid on, a successful save (what was sent + the new version) and an applied refresh row;
   *  cleared on every tasks:bulk. A row with no entry is "unknown" and an undo never un-dirties it. */
  _savedBaseline: new Map<string, { version: NimbusTask['row_version']; key: string }>(),
  /** The comparable key of an edit snapshot: the per-edit markers differ after an undo and are not saved content. */
  _baselineKey(snapshot: Record<string, unknown>): string {
    const { source: _source, FIRMED: _firmed, ...rest } = snapshot;
    return JSON.stringify(rest);
  },
  _baselineKeyFromJson(json: string | undefined): string | null {
    if (json === undefined) return null;
    try { return Persistence._baselineKey(JSON.parse(json) as Record<string, unknown>); } catch { return null; }
  },
  /** A write that changes only what is NOT in the baseline key (a note) moved the server row from `fromVersion` to
   *  `toVersion`: carry the baseline along, but only when it sat exactly at `fromVersion` (anything else is not the state
   *  that write was made on, and stays as it is: the row then simply never settles). */
  adoptBaselineVersion(id: string, fromVersion: NimbusTask['row_version'], toVersion: NimbusTask['row_version']): void {
    const base = Persistence._savedBaseline.get(id);
    if (base && fromVersion != null && toVersion != null && base.version === fromVersion) base.version = toVersion;
  },
  _recordBaseline(id: string, version: NimbusTask['row_version'], key: string | null): void {
    if (key === null || version == null) { Persistence._savedBaseline.delete(id); return; }
    Persistence._savedBaseline.set(id, { version, key });
  },
  /** After an undo restore wrote its rows: un-dirty every restored row that provably equals what was last saved.
   *  Default is dirty: any missing proof leaves the row exactly as it was (see the plan's Stage 1 rule). */
  settleRestored(ids: Iterable<string>): void {
    if (Sandbox.active || Persistence._saveInFlight) return;
    let settled = false;
    const displayPatches: Array<{ id: string; changes: Partial<NimbusTask> }> = [];
    for (const raw of ids) {
      const id = String(raw);
      if (!Persistence._dirtyIds.has(id)) continue;
      const live = Store.tasks[id];
      const base = Persistence._savedBaseline.get(id);
      if (!live || !base) continue;
      if (live.row_version == null || live.row_version !== base.version) continue;
      if (live.runtime_schedule_mismatch) continue;
      if (Persistence._firmDirtyIds.has(id) || Persistence._conflictedIds.has(id) || Persistence._refreshRetry.has(id)) continue;
      if (Persistence._baselineKey(Persistence._taskEditSnapshot(live)) !== base.key) continue;
      Persistence.discardDirty(id);
      Persistence._dirtySource.delete(id);
      // Session notes that describe a move to the very place the row now sits are stale.
      const cleared: Partial<NimbusTask> = {};
      for (const note of ['systemMove', 'derivationIssue'] as const) {
        const n = live[note] as { from?: Date; to?: Date } | null | undefined;
        if (n?.from instanceof Date && n?.to instanceof Date && n.from.getTime() === n.to.getTime()) cleared[note] = null;
      }
      if (Object.keys(cleared).length) displayPatches.push({ id, changes: cleared });
      settled = true;
    }
    // Through the Store so Gantt / Inspector repaint; the display source is skipped by the dirty tracker.
    if (displayPatches.length) Store.updateMany(displayPatches, 'engine-runtime-reconcile-display');
    if (settled) { Persistence._syncUnsaved(); Persistence._autosave(); }
  },
  _syncUnsaved(): void {
    const badge = typeof document === 'undefined' ? null : document.getElementById('schedule-unsaved');
    if (!badge) return;
    const count = Persistence._dirtyIds.size;
    badge.hidden = count === 0;
    // The badge is a button: its live count sits in an inner role="status" span so the button role survives.
    const live = typeof badge.querySelector === 'function' ? badge.querySelector('[role="status"]') : null;
    (live ?? badge).textContent = count ? Util.t('ui.n_unsaved', { count }) : '';
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
    } catch (e) { ErrorLog.warn('persistence', 'pending-deletes storage unreadable', undefined, { stack: (e as Error)?.stack }); }
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
    source: null,          // 'backend' | 'cache' (null = nothing loaded)
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
      Persistence._dirtySource.clear();
      for (const key of Object.keys(Store.dependencies)) delete Store.dependencies[key];
    };
    // Captured before any async work starts; every continuation below that would
    // otherwise mutate Store/_currentLoadedPlant checks this against the live
    // counter and discards itself if a newer load() has since started. See the
    // _loadRequest field comment above for why this mirrors _setupSnapshotRequest.
    const loadGeneration = ++Persistence._loadRequest;
    Persistence.bootReady = false;
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
    // Same idea for the tool inventory: the outgoing plant's counts must not be judged against the new plant's
    // orders while its own rows are still in flight (the first schedule:hydrated alert pass runs before them).
    // Silent in-place clear (no emit): undefined = "not loaded", which the compute core treats as no counts; the
    // setMasterData below announces the real rows. lines/workcenters are replaced wholesale only on arrival.
    if (plant !== Persistence._toolInventoryPlant && Store.masterData && Store.masterData.tool_inventory !== undefined) {
      Store.masterData.tool_inventory = undefined;
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
            // No plant, no inventory: undefined (not loaded), never [].
            tool_inventory: undefined,
          }, 'persistence');
          Persistence._toolInventoryPlant = null;
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
          Toast.show(Util.t('toast.reload_edits_during'), 'warn', 8000);
          return;
        }
        if (!Array.isArray(payload?.data)) throw new Error('Invalid /tasks response');
        // A successful HTTP 200 is authoritative — after this point we
        // refuse to silently fall back to cache even if downstream throws.
        stats.source = 'backend';
        stats.raw_received = payload?.data?.length ?? 0;
        stats.backend_meta = payload?.meta ?? null;
        // OQ52 (one clock): keep the server-vs-browser offset so Store.plantNow is the server's "now".
        // Every /tasks load refreshes it; a response without a usable server_now keeps the last one.
        Store.setServerNow(payload?.meta?.server_now);
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
        // C2 (2026-08-20): the plant's frozen-horizon boundary
        // (db.compute_frozen_horizon_end). Since 2026-10-19 the horizon rolls with
        // the clock, so the Store.frozenHorizonEnd getter computes it live from the
        // plant clock + master data; this server instant is cached only as the
        // fallback for when the plant's master-data row is not available.
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
            const zeroCache = rawCache ? JSON.parse(rawCache) : null;
            // S10-6: another plant's cached lines/calendars/blocks are never applied to this plant.
            if (zeroCache && Persistence._cacheMatchesPlant(zeroCache, plant)) Persistence._restoreNonTaskState(zeroCache);
          } catch (e) { ErrorLog.warn('persistence', 'cached non-task state restore failed (zero-task path)', undefined, { stack: (e as Error)?.stack }); }
          // Fetch master-data so orderless plants/lines appear in Master Data tabs,
          // THEN hydrate calendars/blackouts from the backend (authoritative).
          Promise.all([
            Util.fetchTraced(`${Config.API_BASE}/master-data/plants`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<MasterPlantRow>> : null),
            Util.fetchTraced(`${Config.API_BASE}/master-data/machine?plant=${encodeURIComponent(plant)}`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<MasterLineRow>> : null),
            Util.fetchTraced(`${Config.API_BASE}/master-data/sap_workcenter?plant=${encodeURIComponent(plant)}`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<NimbusMasterWorkcenter>> : null),
            Persistence._fetchToolInventoryWithVersion(plant),
          ]).then(([pData, lData, wcData, tiRows]) => {
            // A newer load() (e.g. the user switched plants again) may have
            // started while this was in flight — discard rather than let a
            // stale plant's response clobber the now-current one.
            if (loadGeneration !== Persistence._loadRequest) return;
            if (pData || lData || wcData) {
              Store.setMasterData({
                plants: pData?.rows ?? [],
                lines:  lData?.rows ?? [],
                workcenters: wcData?.rows ?? [],
                tool_inventory: Persistence._resolveToolInventory(plant, tiRows),
              }, 'persistence');
            }
          }).catch(e => ErrorLog.warn('persistence', `Master-data fetch failed (zero-task path): ${e.message}`))
            .finally(() => {
              // S7-1: a newer load() owns hydration now; this plant's calendar/rate-map/setup fan-out is stale.
              if (loadGeneration !== Persistence._loadRequest) return;
              Promise.all([
                CalendarSync.fetchPlantConfig(plant),
                Persistence.loadPriorityRankMaps(plant),
                Runtime.load(plant),
                setupSnapshotGeneration === Persistence._setupSnapshotRequest
                  ? Persistence.loadSetupSnapshot(plant) : Promise.resolve(null),
              ])
                .finally(() => {
                  if (loadGeneration === Persistence._loadRequest) Persistence.bootReady = true;
                  Store.emit({ type: 'schedule:hydrated', source: 'persistence' });
                });
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
            if (cacheData?._schemaVersion !== undefined && cacheData._schemaVersion !== Config.SCHEMA_VERSION) {
              // Same rule as the offline fallback: a cache written under another schema is discarded before any overlay.
              ErrorLog.warn('persistence',
                `Cache schema mismatch (cached=${cacheData._schemaVersion}, expected=${Config.SCHEMA_VERSION}) — discarding`);
              try { localStorage.removeItem(Config.LS_KEY); } catch {}
              cacheData = null;
            } else if (!Persistence._cacheMatchesPlant(cacheData, plant)) {
              // S10-6: the cache belongs to another plant; neither its non-task state nor its task overlay applies.
              ErrorLog.info('persistence', `Cache is for plant ${cacheData?.selectedPlant}, not ${plant} — ignored`);
              cacheData = null;
            } else {
              Persistence._restoreNonTaskState(cacheData);
            }
          }
        } catch (e) { ErrorLog.warn('persistence', 'cached non-task state restore failed', undefined, { stack: (e as Error)?.stack }); }

        // Sync plant from backend task data BEFORE setTasks so Timeline.rebuild()
        // called synchronously by the tasks:bulk subscriber sees correct plant assignments
        for (const t of tasks) {
          const line = t.MACHINE;
          if (!line || !t.PLANT) continue;
          Store.ensureLineSettings(line);
          Store.lineSettings[line].plant = t.PLANT;
        }

        // Overlay user-explicitly-moved positions from localStorage. Only tasks
        // where the cached start differs from the cached original baseline are overlaid.
        let restoredDirtyIds: string[] = [];
        // Undo-settle baseline: the server row's own edit key, taken BEFORE the cache overlay touches it.
        const serverKeys = new Map<string, string>();
        // Normalized on a SHALLOW CLONE with no id: the real row must keep its original flow (overlay first, then
        // setTasks normalizes), and _normalizeDates writes Store.firmedIds for any row that carries an id.
        for (const t of tasks) {
          const { id, ...rest } = t;
          // A server row flagged stale: the reconcile will write a dirty patch to persist its re-derivation, so an undo
          // landing on the same key must never un-dirty it. No baseline (unknown = stays dirty).
          if (t.runtime_schedule_mismatch === true) continue;
          const probe = rest as NimbusTask;
          Store._normalizeDates(probe);
          probe.id = String(id);
          serverKeys.set(String(id), Persistence._baselineKey(Persistence._taskEditSnapshot(probe)));
        }
        if (!discardLocalEdits && cacheData?.tasks?.length) {
          const optimizerIds = new Set<string>(cacheData._optimizerDirtyIds ?? []);
          const dirtyIds = cacheData._dirtyIds == null ? null : new Set<string>(cacheData._dirtyIds);
          restoredDirtyIds = Persistence._overlayUserMoves(tasks, cacheData.tasks.filter((task: NimbusTask) =>
            !optimizerIds.has(String(task.id)) && (dirtyIds === null || dirtyIds.has(String(task.id)))));
        }

        // (No load-time snap of ingested starts any more: a row nobody has placed is derived backward
        // from its due date by the reconcile, and a placed row keeps the stored edges.)

        acceptDiscard();
        const setResult = Store.setTasks(tasks, 'persistence');
        // setTasks cleared the baseline (tasks:bulk). A row with a cached overlay or an optimizer-dirty mark is not the
        // server row any more, so it gets no baseline (unknown = stays dirty on undo).
        {
          const overlaid = new Set<string>(restoredDirtyIds);
          if (!discardLocalEdits) for (const id of cacheData?._optimizerDirtyIds ?? []) overlaid.add(String(id));
          for (const [id, key] of serverKeys) {
            const live = Store.tasks[id];
            if (live && !overlaid.has(id)) Persistence._recordBaseline(id, live.row_version, key);
          }
        }
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
          Util.fetchTraced(`${Config.API_BASE}/system-settings`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<{ orderFields?: Record<string, { grid?: boolean; inspector?: boolean }>; schedule_event_retention_days?: number }> : null),
          Util.fetchTraced(`${Config.API_BASE}/master-data/sap_workcenter?plant=${encodeURIComponent(plant)}`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<NimbusMasterWorkcenter>> : null),
          Persistence._fetchToolInventoryWithVersion(plant),
        ]).then(([pData, lData, ssData, wcData, tiRows]) => {
          // A newer load() (e.g. the user switched plants again) may have
          // started while this was in flight — discard rather than let a
          // stale plant's response clobber the now-current one.
          if (loadGeneration !== Persistence._loadRequest) return;
          if (pData || lData || wcData) {
            Store.setMasterData({
              plants: pData?.rows ?? [],
              lines:  lData?.rows ?? [],
              workcenters: wcData?.rows ?? [],
              tool_inventory: Persistence._resolveToolInventory(plant, tiRows),
            }, 'persistence');
          }
          Store.setOrderFieldVisibility(ssData?.orderFields ?? {}, 'persistence');
          const retention = Number(ssData?.schedule_event_retention_days);
          Persistence.scheduleEventRetentionDays = Number.isFinite(retention) && retention >= 1 ? Math.min(60, Math.round(retention)) : 14;
        }).catch(e => {
          ErrorLog.warn('persistence', `Master-data fetch failed: ${e.message}`);
          Toast.show(Util.t('toast.master_data_unavail'), 'warn', 5000);
        }).finally(() => {
          // S7-1: see the zero-task path above.
          if (loadGeneration !== Persistence._loadRequest) return;
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
            .finally(() => {
              if (loadGeneration === Persistence._loadRequest) Persistence.bootReady = true;
              Store.emit({ type: 'schedule:hydrated', source: 'persistence' });
            });
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
          Toast.show(Util.t('toast.reload_failed_local_edits'), 'error', 8000);
          return;
        }
        // Only fall back to cache if we never got a successful response.
        if (stats.source !== 'backend') {
          if (Persistence._loadCache(plant)) {
            stats.source = 'cache';
            Toast.show(Util.t('toast.backend_unreachable_cache'), 'warn', 5000);
          } else {
            // S7-7: no demo data. An honest empty board plus a notice that stays up until the watcher reconnects.
            Persistence._showUnreachableEmpty();
            stats.source = null;
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
          calendar_version?: string | null;
          tool_inventory_version?: string | null;
          tooling_rule?: 'off' | 'hard';
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

          Persistence._noteCalendarVersion(plant, json.calendar_version);
          Persistence._noteToolInventoryVersion(plant, json.tool_inventory_version, json.tooling_rule);

          return changed;
        });
      })
      .catch(e => {
        ErrorLog.warn('persistence', `Horizons refresh failed (plant=${plant}): ${(e as Error).message}`);
        return false;
      });
  },

  /** The plant's calendar fingerprint came back on /tasks/horizons. The baseline is whatever the last successful
   *  hydration recorded (`CalendarSync._applyConfig`, from `calendar_version` on GET /plant-calendar); with no
   *  baseline (not hydrated yet, or an older backend) there is nothing to compare and this does nothing. A different
   *  value re-fetches the plant calendar (`fetchPlantConfig` emits `calendar:change`, which re-shades the Gantt,
   *  recomputes alerts and re-renders the Machines pane; it never moves a placed bar or touches a dirty row) and
   *  toasts once if the hours, periods or blackouts really changed. The baseline moves only when that fetch really
   *  applied (it is set by the hydration itself); a failed fetch keeps the old baseline and zeroes the throttle so
   *  the next entry retries. Skipped, and retried on the next entry, while a drag is in flight, a dialog is open
   *  or What-If is active. Nothing task-shaped is loaded, so there is no undo invalidation and no unsaved-edit
   *  hazard. */
  _noteCalendarVersion(plant: string, version: string | null | undefined): void {
    if (!version) return;                                       // older backend, or an unknown plant
    const known = Persistence._calendarVersion[plant];
    if (known === undefined) return;                            // no hydration baseline to compare with
    if (known === version || Persistence._calendarRefreshing.has(plant)) return;
    if (Sandbox.active || Modal.anyOpen() || Persistence._calendarRefreshBlocked?.()) {
      if (Persistence._calendarRefreshBlocked?.()) Persistence._deferredRefreshPlants.add(plant);
      Persistence._horizonsFetchedAt[plant] = 0;                // not a real fetch: let the next entry retry at once
      return;
    }
    const before = Persistence._calendarFingerprint(plant);
    Persistence._calendarRefreshing.add(plant);
    void CalendarSync.fetchPlantConfig(plant).then(applied => {
      if (!applied) { Persistence._horizonsFetchedAt[plant] = 0; return; }   // failed or What-If-deferred: keep the baseline, retry next entry
      if (Persistence._calendarVersion[plant] === known) Persistence._calendarVersion[plant] = version;   // a backend whose GET lacks the field
      if (Persistence._calendarFingerprint(plant) !== before) Toast.show(Util.t('toast.calendar_refreshed_remote'), 'info');
    }).finally(() => { Persistence._calendarRefreshing.delete(plant); });
  },

  /** GET /master-data/tool_inventory?plant= -> the plant's rows sorted by tool_id (ascending, plain code-unit order:
   *  deterministic input for the optimizer's JSON stale diff), or `undefined` when the response is not ok, the body
   *  is unusable, the request times out or throws. Never rejects, and NEVER returns [] for a failure: a failed fetch
   *  must not read as "loaded, every tool is 1 copy". */
  _fetchToolInventory(plant: string): Promise<NimbusToolInventoryRow[] | undefined> {
    return Util.fetchTraced(`${Config.API_BASE}/master-data/tool_inventory?plant=${encodeURIComponent(plant)}`, { signal: AbortSignal.timeout(5000) })
      .then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<NimbusToolInventoryRow>> : null)
      .then(body => {
        if (!body || !Array.isArray(body.rows)) return undefined;
        return body.rows.slice().sort((a, b) => (a.tool_id < b.tool_id ? -1 : a.tool_id > b.tool_id ? 1 : 0));
      })
      .catch(() => undefined);
  },

  /** The server's own `tool_inventory_version` for a plant (the /tasks/horizons field), read directly (not through the
   *  10 s throttle of refreshHorizons). `null` (no rows / table missing) reads as '' (a valid version); `undefined`
   *  when the call fails or an older backend omits the field. Never rejects. The string is only ever stored and
   *  compared verbatim: the client never recomputes it (the row endpoint does not return updated_at). */
  _readToolInventoryVersion(plant: string): Promise<string | undefined> {
    return Util.fetchTraced(`${Config.API_BASE}/tasks/horizons?plant=${encodeURIComponent(plant)}`, { signal: AbortSignal.timeout(5000) })
      .then(r => r.ok ? r.json() as Promise<{ tool_inventory_version?: string | null }> : null)
      .then(j => (j && j.tool_inventory_version !== undefined ? (j.tool_inventory_version ?? '') : undefined))
      .catch(() => undefined);
  },

  /** Public freshness check for a consumer that is about to READ the inventory (the Optimize run, rule Hard): one cheap
   *  version probe, and a re-read only when the server's version differs from the one the held rows were read at. Bounded
   *  by `timeoutMs` (default 1500) so a slow or dead probe never stalls the caller: on timeout, a failed probe or no
   *  baseline to compare it resolves {fresh:false} and the caller proceeds with the held rows. {fresh:true} means the held
   *  rows are confirmed current (version unchanged, or re-read and applied). Never rejects. */
  async ensureToolInventoryCurrent(plant: string | null, opts: { timeoutMs?: number } = {}): Promise<{ fresh: boolean }> {
    if (!plant) return { fresh: false };
    const timeoutMs = opts.timeoutMs ?? 1500;
    const work = (async (): Promise<boolean> => {
      const version = await Persistence._readToolInventoryVersion(plant);
      const baseline = Persistence._toolInventoryBaseline[plant];
      if (version === undefined || baseline === undefined) return false;
      if (version === baseline) return true;
      return Persistence.refreshToolInventory(plant);
    })().catch(() => false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
    try { return { fresh: await Promise.race([work, timeout]) }; } finally { clearTimeout(timer); }
  },

  /** Version FIRST, rows SECOND (sequential on purpose): an edit landing between the two reads leaves the stored
   *  baseline OLDER than the rows, so the worst case is one extra refetch, never a missed edit. */
  async _fetchToolInventoryWithVersion(plant: string): Promise<{ rows: NimbusToolInventoryRow[] | undefined; version: string | undefined }> {
    const version = await Persistence._readToolInventoryVersion(plant);
    const rows = await Persistence._fetchToolInventory(plant);
    return { rows, version };
  },

  /** Always logs (ErrorLog.warn) when a plant's inventory could not be loaded; toasts once per plant per session. */
  _warnToolInventoryUnavailable(plant: string): void {
    ErrorLog.warn('persistence', `Tool inventory fetch failed (plant=${plant}); tools are treated as 1 copy until it loads`);
    if (Persistence._toolInventoryWarned.has(plant)) return;
    Persistence._toolInventoryWarned.add(plant);
    Toast.show(Util.t('toast.tool_inventory_unavailable', { plant }), 'warn', 6000);
  },

  /** What `masterData.tool_inventory` should be after a load's fetch: the fresh rows; on failure `undefined` (never
   *  []), except a same-plant reload keeps the rows already held (keep-on-failure, like workcenters). Records the
   *  owning plant and the probe baseline (the server's version string read before the rows; undefined when that read
   *  failed). A different plant's rows are never reused. */
  _resolveToolInventory(plant: string, fetched: { rows: NimbusToolInventoryRow[] | undefined; version: string | undefined }): NimbusToolInventoryRow[] | undefined {
    let rows = fetched.rows;
    if (rows === undefined) {
      Persistence._warnToolInventoryUnavailable(plant);
      rows = Persistence._toolInventoryPlant === plant ? Store.masterData?.tool_inventory : undefined;
      if (rows === undefined) Persistence._toolInventoryBaseline[plant] = undefined;
    } else {
      Persistence._toolInventoryBaseline[plant] = fetched.version;
    }
    Persistence._toolInventoryPlant = plant;
    return rows;
  },

  /** Re-fetch one plant's inventory into Store.masterData.tool_inventory (emits master-data-changed with table
   *  'tool_inventory', which the shell already turns into an alert recompute). Resolves true iff rows were applied
   *  (or already identical, in which case only the baseline moves and nothing is emitted). The plant is marked in
   *  _toolInventoryRefreshing for the whole call so a probe racing it is ignored. A failed fetch keeps whatever is
   *  held; a plant switch or newer load() while the request is in flight discards the response (the same
   *  selectedPlant + _loadRequest guard as refreshHorizons). */
  async refreshToolInventory(plant: string | null): Promise<boolean> {
    if (!plant) return false;
    const gen = Persistence._loadRequest;
    Persistence._toolInventoryRefreshing.add(plant);
    try {
      const { rows, version } = await Persistence._fetchToolInventoryWithVersion(plant);
      if (Store.selectedPlant !== plant || Persistence._loadRequest !== gen) return false;
      if (rows === undefined) { Persistence._warnToolInventoryUnavailable(plant); return false; }
      const md = Store.masterData;
      if (!md) return false;
      const held = Persistence._toolInventoryPlant === plant ? md.tool_inventory : undefined;
      Persistence._toolInventoryBaseline[plant] = version;
      Persistence._toolInventoryPlant = plant;
      if (held !== undefined && JSON.stringify(held) === JSON.stringify(rows)) return true;   // nothing changed: no emit
      Store.setMasterData({ ...md, tool_inventory: rows }, 'tool-inventory-refresh', 'tool_inventory');
      return true;
    } finally { Persistence._toolInventoryRefreshing.delete(plant); }
  },

  /** The /tasks/horizons probe's Tool Inventory fields. The baseline is the server's own version string, read before
   *  the rows were loaded (never recomputed here). A held baseline that differs from the probe's version re-fetches
   *  and toasts (only if the rows really changed). No baseline: with rows held (loaded this session, but the version
   *  read failed) the probe adopts the server value WITHOUT refetching; with no rows held (a failed load) it
   *  refetches silently. A version-less (older) backend does nothing. A `tooling_rule` that differs from the plant
   *  row in the Store re-fetches the plants rows and toasts likewise. Skipped (and the throttle zeroed so the next
   *  entry retries) while a drag is in flight, a dialog is open or What-If is active, like the calendar probe. */
  _noteToolInventoryVersion(plant: string, version: string | null | undefined, rule: 'off' | 'hard' | undefined): void {
    const blocked = (): boolean => {
      if (Sandbox.active || Modal.anyOpen() || Persistence._calendarRefreshBlocked?.()) {
        if (Persistence._calendarRefreshBlocked?.()) Persistence._deferredRefreshPlants.add(plant);
        Persistence._horizonsFetchedAt[plant] = 0;
        return true;
      }
      return false;
    };

    if (version !== undefined && Persistence._toolInventoryPlant === plant && !Persistence._toolInventoryRefreshing.has(plant)) {
      const server = version ?? '';
      const known = Persistence._toolInventoryBaseline[plant];
      const heldBefore = Store.masterData?.tool_inventory;
      if (known === undefined && heldBefore !== undefined) {
        Persistence._toolInventoryBaseline[plant] = server;      // adopt, no refetch (no loop when the version read failed)
      } else if (known !== server && !blocked()) {
        void Persistence.refreshToolInventory(plant).then(applied => {
          if (!applied) { Persistence._horizonsFetchedAt[plant] = 0; return; }
          if (known !== undefined && Store.masterData?.tool_inventory !== heldBefore) Toast.show(Util.t('toast.tool_inventory_refreshed_remote'), 'info');
        });
      }
    }

    if (rule !== undefined && !Persistence._toolingRuleRefreshing.has(plant)) {
      const row = Store.masterData?.plants?.find(p => p.plant === plant);
      const held = row?.setup_policy_config?.toolingRule ?? 'off';
      if (row && held !== rule && !blocked()) {
        Persistence._toolingRuleRefreshing.add(plant);
        void Persistence._refreshPlantRows(plant).then(applied => {
          if (!applied) { Persistence._horizonsFetchedAt[plant] = 0; return; }
          const now = Store.masterData?.plants?.find(p => p.plant === plant)?.setup_policy_config?.toolingRule ?? 'off';
          if (now !== held) Toast.show(Util.t('toast.tool_inventory_refreshed_remote'), 'info');
        }).finally(() => { Persistence._toolingRuleRefreshing.delete(plant); });
      }
    }
  },

  /** Re-fetch GET /master-data/plants and replace Store.masterData.plants (lines, work centers and the inventory are
   *  carried unchanged). Same selectedPlant + _loadRequest guard; a failed fetch keeps the held rows. */
  async _refreshPlantRows(plant: string): Promise<boolean> {
    const gen = Persistence._loadRequest;
    const data = await Util.fetchTraced(`${Config.API_BASE}/master-data/plants`, { signal: AbortSignal.timeout(5000) })
      .then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<MasterPlantRow>> : null)
      .catch(() => null);
    if (Store.selectedPlant !== plant || Persistence._loadRequest !== gen) return false;
    const md = Store.masterData;
    if (!data || !Array.isArray(data.rows) || !md) return false;
    Store.setMasterData({ ...md, plants: data.rows }, 'tooling-rule-refresh', 'plants');
    return true;
  },

  /** What the browser holds of a plant's calendar, for "did the re-hydration change anything". */
  _calendarFingerprint(plant: string): string {
    const lineCalendars: Record<string, unknown> = {};
    for (const [line, cal] of Object.entries(Store.calendars)) {
      if (Store.getPlantForLine(line) === plant) lineCalendars[line] = cal;
    }
    return JSON.stringify([
      Store.plants[plant] ?? null,
      lineCalendars,
      Store.blocks.filter(b => b.plant === plant),
      Store.plantBlocks.filter(b => b.plant === plant),
    ]);
  },

  /** Tab came back to the foreground: run the same throttled horizons probe a Gantt entry runs, so a calendar
   *  another session changed while this tab sat in the background is picked up. Resolves like refreshHorizons. */
  refreshHorizonsOnReturn(): Promise<boolean> {
    if (typeof document !== 'undefined' && document.hidden) return Promise.resolve(false);
    return Persistence.refreshHorizons(Store.selectedPlant);
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
    // /tasks exposes the SAP baseline as original_start_date. Keep a raw copy as
    // BASIC_START_DATE (nothing snaps original_start_date any more; the client's
    // SAP-start checks read this copy). Existing cached raw dates remain
    // authoritative on subsequent cache decoding.
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
  // has consciously dragged beyond the baseline, so a reload keeps their placement.
  _overlayUserMoves(backendTasks: NimbusTask[], cachedTasks: Array<Record<string, unknown>>): string[] {
    const byId = new Map(cachedTasks.map(t => [t.id, t]));
    const restored: string[] = [];
    for (const t of backendTasks) {
      const cached = byId.get(t.id);
      if (!cached) continue;
      if (cached.planning_status === 'needs_planning') {
        // S7-5: an unsaved Unschedule. Nothing to restore when the server already queues the row, or when the
        // server row moved on after the cache was written (same version rule as a date move below).
        if (t.planning_status === 'needs_planning') continue;
        const queuedVersion = cached.row_version as number | null | undefined;
        if (queuedVersion != null && t.row_version != null && queuedVersion !== t.row_version) continue;
        t.start_date = null;
        t.end_date = null;
        t.scheduleSegments = [];
        t.planning_status = 'needs_planning';
        t.planning_reason = (cached.planning_reason as NimbusTask['planning_reason']) ?? null;
        t.placement_exception = (cached.placement_exception as NimbusTask['placement_exception']) ?? null;
        restored.push(String(t.id));
        continue;
      }
      if (t.planning_status === 'needs_planning') continue;
      const cs  = Util.parseDate(cached.start_date);
      const ce  = Util.parseDate(cached.end_date);
      const cos = Util.parseDate(cached.original_start_date);
      if (!(cs instanceof Date) || !(ce instanceof Date)) continue;
      // S7-5: a move is a changed start OR a changed end (a right-edge resize leaves the start alone).
      const endMoved = t.end_date instanceof Date && ce.getTime() !== t.end_date.getTime();
      if (!(cos instanceof Date) || (cs.getTime() === cos.getTime() && !endMoved)) continue;
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
      // The overlay itself proves a placement existed: carry the placed flag and the exception marker exactly
      // as cached, or the next Save would treat the row as display-only and drop its dates.
      t.user_scheduled = !!cached.user_scheduled;
      t.placement_exception = (cached.placement_exception as NimbusTask['placement_exception']) ?? null;
      // VI9: the unsaved edit that moved the dates may also have changed the run time, machine, tooling or
      // version; a bar restored on the old run time fails the server width check and the edit is lost.
      for (const key of ['RUN_TIME', 'MACHINE', 'PRT_01', 'PRT_02', 'PRODUCTION_VERSION', 'run_time_source'] as const) {
        if (key in cached) (t as Record<string, unknown>)[key] = cached[key];
      }
      // D21 (VM8): the "run time grew" note survives a reload until the row is saved or re-placed.
      const issue = cached.derivationIssue as { code?: string; detail?: string; from?: unknown; to?: unknown } | null | undefined;
      if (issue?.code) {
        t.derivationIssue = { code: issue.code, ...(issue.detail ? { detail: issue.detail } : {}),
          ...(issue.from ? { from: Util.parseDate(issue.from as string) ?? undefined } : {}),
          ...(issue.to ? { to: Util.parseDate(issue.to as string) ?? undefined } : {}) } as NimbusTask['derivationIssue'];
      }
      restored.push(String(t.id));
    }
    return restored;
  },

  /** S10-6 / S7-3: a cached snapshot is only usable for the plant it was written for. A cache with no plant tag (an
   *  older snapshot) or a call with no requested plant is accepted unchanged. */
  _cacheMatchesPlant(data: { selectedPlant?: string | null } | null | undefined, plant: string | null | undefined): boolean {
    if (!plant || !data?.selectedPlant) return true;
    return data.selectedPlant === plant;
  },

  /** S7-7: the backend is unreachable and there is no usable cache. Show an empty board (never invented orders)
   *  and a notice that stays up until the reconnect watcher recovers (its success toast replaces the need for it). */
  _showUnreachableEmpty(): void {
    Persistence._rankMapsPlant = null;
    Store.setPriorityRankMaps({}, 'persistence');
    Store.setVisibilityHorizonEnd(null, 'persistence');
    Store.setFrozenHorizonEnd(null, 'persistence');
    Store.setTasks([], 'persistence');
    Persistence._currentLoadedPlant = null;
    Toast.show(Util.t('toast.backend_unreachable_empty'), 'error', UNREACHABLE_TOAST_MS);
  },

  _loadCache(plant?: string | null): boolean {
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

    // S7-3: another plant's cache must never render under this plant's name. Left in place (not removed): it is
    // that plant's own offline copy, and the next successful load for this plant overwrites it.
    if (!Persistence._cacheMatchesPlant(data, plant)) {
      ErrorLog.info('persistence', `Cache is for plant ${data.selectedPlant}, not ${plant} — not restored`);
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


  /** Fields saveAll() actually writes for one task, in wire shape (post
   *  toLocalSeconds date conversion) — deliberately excludes id/base_version/force
   *  (identity + concurrency metadata, not edit content). Used both to build
   *  taskPayload entries and, at response time, to snapshot the task's CURRENT
   *  live value for the "does this id's dirty flag still describe what we sent"
   *  compare in saveAll()'s success handler — keeping both call sites on this one
   *  function guarantees the two snapshots are comparable. */
  _taskEditSnapshot(t: NimbusTask): Record<string, unknown> {
    // F10: a row that was never placed server-side (and is not queued) holds only DISPLAY-derived dates. A save for it
    // carries its attribute edits and leaves the dates, segments and planning status (VC1) out, so Save cannot store a placement the planner
    // never made. A planner placement marks the row placed (Store._markPlaced) and sends them as usual.
    const displayOnly = !t.user_scheduled && t.planning_status !== 'needs_planning';
    return {
      // Manual firm: sent only for rows whose firm the planner changed (see _firmDirtyIds).
      ...(Persistence._firmDirtyIds.has(String(t.id)) ? { FIRMED: !!t.firmed } : {}),
      // Schedule-event history: what kind of edit last touched this row (see SOURCE_WIRE). Absent => server 'planner'.
      ...(Persistence._dirtySource.has(String(t.id)) ? { source: Persistence._dirtySource.get(String(t.id)) } : {}),
      // VC1: a display-only row has no placement to describe; sending a status with no edges is rejected by the
      // server (single_edge). Its save carries attributes only; the stored status is already 'scheduled'.
      ...(displayOnly ? {} : {
        planning_status: t.planning_status ?? 'scheduled',
        planning_reason: t.planning_reason ?? null,
      }),
      // Placement exception (backward scheduling OQ50): the marker the planner's bar carries, sent with every
      // save of a task that holds the field. An explicit null clears the stored marker; a task that never
      // carried the field (an older server, a demo row) omits it, so the server leaves the stored one alone.
      ...(t.placement_exception !== undefined ? { placement_exception: t.placement_exception } : {}),
      ...(displayOnly ? {} : {
        start_date: t.start_date ? Util.toLocalSeconds(t.start_date) as NaiveLocalTs : null,
        end_date:   t.end_date ? Util.toLocalSeconds(t.end_date) as NaiveLocalTs : null,
      }),
      PRT_01:       t.PRT_01,
      PRT_02:       t.PRT_02,
      PRODUCTION_VERSION: t.PRODUCTION_VERSION,
      RUN_TIME:      t.RUN_TIME,
      MACHINE:       t.MACHINE,
      ...(displayOnly ? {} : { schedule_segments: (t.scheduleSegments || []).map(segment => ({
        sequence: segment.sequence,
        start_date: Util.toLocalSeconds(segment.startDate) as NaiveLocalTs,
        end_date: Util.toLocalSeconds(segment.endDate) as NaiveLocalTs,
      })) }),
      // Note: PARENT_ORDER and DISTRIBUTION_LETTER are intentionally excluded (read-only)
    };
  },

  /** U25: does the server row already hold exactly what this client sent (same start, end, segments and the edited
   *  attributes)? A display-only send (no dates) never matches: it proves nothing about the placement. */
  _sameAsSent(row: Record<string, unknown>, sentJson: string | undefined): boolean {
    if (!sentJson) return false;
    let sent: Record<string, unknown>;
    try { sent = JSON.parse(sentJson); } catch { return false; }
    if (!sent.start_date || !sent.end_date || !Array.isArray(sent.schedule_segments)) return false;
    const same = (a: unknown, b: unknown): boolean => {
      const x = Util.parseDate(a as string), y = Util.parseDate(b as string);
      return x instanceof Date && y instanceof Date && x.getTime() === y.getTime();
    };
    if (!same(sent.start_date, row.start_date) || !same(sent.end_date, row.end_date)) return false;
    const serverSegments = Persistence._segmentsFromRaw(row);
    const sentSegments = sent.schedule_segments as Array<{ start_date: string; end_date: string }>;
    if (serverSegments.length !== sentSegments.length
      || sentSegments.some((seg, i) => !same(seg.start_date, serverSegments[i].startDate) || !same(seg.end_date, serverSegments[i].endDate))) return false;
    const text = (v: unknown): string => (v == null ? '' : String(v));
    // S10-2: a concurrent firm/unfirm, queue/release or exception change is a real conflict, never "the same placement".
    if (sent.FIRMED !== undefined && !!sent.FIRMED !== !!(row as { firmed?: unknown }).firmed) return false;
    if (sent.planning_status !== undefined && text(sent.planning_status) !== text(row.planning_status ?? 'scheduled')) return false;
    if (sent.planning_reason !== undefined) {
      const code = (v: unknown): string => text((v as { code?: unknown } | null | undefined)?.code);
      if (code(sent.planning_reason) !== code(row.planning_reason)) return false;
    }
    if (sent.placement_exception !== undefined && text(sent.placement_exception) !== text(row.placement_exception)) return false;
    return text(sent.MACHINE) === text(row.MACHINE) && text(sent.PRT_01) === text(row.PRT_01)
      && text(sent.PRT_02) === text(row.PRT_02) && text(sent.PRODUCTION_VERSION) === text(row.PRODUCTION_VERSION)
      && (sent.RUN_TIME == null ? null : Number(sent.RUN_TIME)) === (row.RUN_TIME == null ? null : Number(row.RUN_TIME));
  },

  _refreshBaseline(t: NimbusTask): RefreshBaseline {
    return { edits: JSON.stringify(Persistence._taskEditSnapshot(t)),
      generation: taskEditGenerations.get(String(t.id)) ?? 0,
      collection: taskCollectionGeneration, version: t.row_version };
  },

  _warnUnresolvedConflict(): void {
    Toast.show(Util.t('toast.conflict_unsaved_remain'), 'warn', 8000);
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
    // S7-2: a conflict refresh that failed or timed out earlier is retried by this Save (for the ids still conflicted).
    Persistence._retryFailedRefreshes();
    // S7-14: an id whose order is gone from the Store can never be sent; drop it so "N unsaved" stays honest.
    Persistence._pruneDirty();
    // Send changed task aggregates (dates, planning state, segments and editable
    // attributes). Reload clears dirty state; undo is a new dependent edit.
    const dirtyTasks = Persistence._dirtyIds.size > 0
      ? Store.tasksArr.filter(t => Persistence._dirtyIds.has(String(t.id)))
      : [];
    // S10-1/S10-4/S7-11: dependent optimizer/undo rows are ONE atomic request, every other row a separate
    // non-atomic request, so a stale optimizer row never blocks manual edits (and manual stale rows still get
    // the stale-refresh path).
    const groups = Persistence._saveGroups(dirtyTasks);
    if (groups.hadConflicted) Persistence._warnUnresolvedConflict();
    const toSend = [
      { tasks: groups.atomic, atomic: true },
      { tasks: groups.manual, atomic: false },
    ].filter(g => g.tasks.length > 0);
    if (!toSend.length) {
      if (!groups.hadConflicted && !opts.silent) Toast.show(Util.t('toast.nothing_to_save'), 'info', 3000);
      Persistence._syncUnsaved();
      return;
    }
    Persistence._saveInFlight = true;
    Persistence._saveCache();
    (async () => {
      let allSaved = true;
      for (const g of toSend) {
        const outcome = await Persistence._sendSaveGroup(g.tasks, g.atomic);
        if (outcome !== 'saved') allSaved = false;
        // The server is unreachable or timed out: a second request would only wait out the same failure.
        if (outcome === 'unreachable') break;
      }
      if (allSaved) Toast.show(Util.t('toast.saved_to_backend'), 'success');
    })()
      .catch(e => ErrorLog.error('persistence', `Save sequencing failed: ${(e as Error).message}`))
      .finally(() => { Persistence._saveInFlight = false; Persistence._syncUnsaved(); Persistence._saveCache(); });
  },

  /** S7-14: drop dirty/force/firm/conflict/source markers for ids with no order in the Store. */
  _pruneDirty(): void {
    for (const id of [...Persistence._dirtyIds]) {
      if (Store.tasks[id]) continue;
      Persistence._dirtyIds.delete(id);
      Persistence._forceIds.delete(id);
      Persistence._firmDirtyIds.delete(id);
      Persistence._conflictedIds.delete(id);
      Persistence._dirtySource.delete(id);
    }
  },

  /** S10-1: split the dirty rows into the atomic optimizer/undo group and the ordinary group. A group that holds a
   *  conflicted row is withheld whole when atomic (it is all-or-nothing); an ordinary group just omits those rows. */
  _saveGroups(dirtyTasks: NimbusTask[]): { atomic: NimbusTask[]; manual: NimbusTask[]; hadConflicted: boolean } {
    const isConflicted = (t: NimbusTask): boolean => Persistence._conflictedIds.has(String(t.id));
    const forced = dirtyTasks.filter(t => Persistence._forceIds.has(String(t.id)));
    const rest = dirtyTasks.filter(t => !Persistence._forceIds.has(String(t.id)));
    return {
      atomic: forced.some(isConflicted) ? [] : forced,
      manual: rest.filter(t => !isConflicted(t)),
      hadConflicted: dirtyTasks.some(isConflicted),
    };
  },

  /** One /tasks/update request for one group (see saveAll). Resolves, never rejects:
   *  'saved' = clean success, 'problem' = rejected/partial/stale (its own toast was shown),
   *  'unreachable' = network failure or timeout (the caller stops sending further groups). */
  async _sendSaveGroup(tasks: NimbusTask[], atomicOptimizer: boolean): Promise<'saved' | 'problem' | 'unreachable'> {
    const saveCollection = taskCollectionGeneration;
    const refreshBaselines = new Map(tasks.map(t => [String(t.id), Persistence._refreshBaseline(t)]));
    const sentVersions = new Map<string, number | null | undefined>(tasks.map(t => [String(t.id), t.row_version]));
    // Send only the fields the backend consumes, plus the optimistic-concurrency
    // token (row_version → base_version). Optimizer edits use atomic validation
    // and cannot bypass a concurrent editor's version.
    // toLocalSeconds, not a raw Date: JSON.stringify would call Date.toISOString()
    // (UTC), but the orders read path emits bare naive strftime (no Z) which new
    // Date() parses as LOCAL — so a raw Date here round-trips shifted by the
    // client's UTC offset for any non-UTC user. The same rule covers every date-carrying field;
    // see Util.toLocalSeconds and _taskEditSnapshot above.
    const taskPayload = tasks.map(t => ({
      id: t.id,
      ...Persistence._taskEditSnapshot(t),
      base_version: t.row_version ?? null,
      force:        atomicOptimizer ? false : !Config.CONCURRENCY_CHECK,
    }));
    // Snapshot of exactly what's being sent for each dirty id, keyed by id — the
    // response handler compares this against the LIVE value at response time
    // before clearing that id's dirty flag, so an edit made after this snapshot
    // was taken (but before the response arrives) is never silently treated as saved.
    const sentSnapshot = new Map<string, string>(
      tasks.map(t => [String(t.id), JSON.stringify(Persistence._taskEditSnapshot(t))])
    );
    // S10-7: the backend only consumes `tasks`; blocks/calendars persist through /plant-calendar/*.
    const body = JSON.stringify({ tasks: taskPayload, client_id: Persistence.clientId, atomic_optimizer: atomicOptimizer });

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

    // The network outcome and the response handler are separate steps: a bug in the handler must never be
    // reported as "saved locally" (S10-4).
    let result: BulkUpdateResult;
    try {
      result = await _post(1);
    } catch (err) {
      const e = err as SaveError;
      if (e.httpStatus) {
        ErrorLog.error('persistence', `Backend rejected save (${e.httpStatus}): ${e.message}`,
          { status: e.httpStatus, reqId: e.reqId },
          { reqId: e.reqId, errorCode: e.errorCode || 'http.status' });
        Toast.show(Util.t('toast.save_rejected', { msg: e.message }), 'error', 6000);
        return 'problem';
      }
      if (e.timedOut) {
        ErrorLog.error('persistence', `Backend save timed out after ${SAVE_TIMEOUT_MS} ms`,
          { reqId }, { reqId, errorCode: 'http.timeout' });
        Toast.show(Util.t('toast.save_timeout'), 'error', 8000);
        return 'unreachable';
      }
      ErrorLog.warn('persistence', `Backend save failed: ${e.message}`,
        { reqId }, { reqId, errorCode: 'http.network' });
      Toast.show(Util.t('toast.saved_locally'), 'info');
      return 'unreachable';
    }

    try {
      return Persistence._applySaveResult(result, {
        tasks, atomicOptimizer, saveCollection, refreshBaselines, sentVersions, sentSnapshot, reqId,
      });
    } catch (e) {
      ErrorLog.error('persistence', `Save response handler failed: ${(e as Error).message}`,
        { reqId }, { reqId, stack: (e as Error)?.stack });
      Toast.show(Util.t('toast.save_handler_error'), 'error', 8000);
      return 'problem';
    }
  },

  /** The success side of one save group: stamp versions, clear what the server accounted for, refresh rejected and
   *  stale rows, and toast. Returns 'saved' only when nothing needed a warning toast. */
  _applySaveResult(result: BulkUpdateResult, ctx: {
    tasks: NimbusTask[]; atomicOptimizer: boolean; saveCollection: number;
    refreshBaselines: Map<string, RefreshBaseline>; sentVersions: Map<string, number | null | undefined>;
    sentSnapshot: Map<string, string>; reqId: string;
  }): 'saved' | 'problem' {
    const { atomicOptimizer, saveCollection, refreshBaselines, sentVersions, sentSnapshot, reqId } = ctx;
    const versions = result.versions || {};
    if (saveCollection !== taskCollectionGeneration) {
      // S7-8: the board was replaced while this request was out. Gate the dirty bookkeeping and toasts, but a row
      // the server just wrote whose live version is still the one we sent must adopt the new version, or its next
      // save would conflict with our own write.
      for (const id of Object.keys(versions)) {
        const tk = Store.tasks[id];
        if (tk && tk.row_version === sentVersions.get(id)) tk.row_version = versions[id];
      }
      return 'problem';
    }
    const runtimePreviewChanged = Object.values(result.rejection_reasons || {}).includes('runtime_preview_changed');
    if (runtimePreviewChanged) {
      // Rate-map changes can invalidate a locally valid preview without an
      // order version change. Refresh the cache for the next edit/retry;
      // ordinary stale reconciliation below still protects newer local work.
      void Runtime.load(Store.selectedPlant);
      ErrorLog.warn('persistence', 'Routing rates changed; rejected runtime previews require review', result.rejection_reasons);
      Toast.show(Util.t(atomicOptimizer ? 'toast.routing_rates_changed_optimizer' : 'toast.routing_rates_changed_rejected'), 'warn', 8000);
    }
    const unknownMachineCount = Object.values(result.rejection_reasons || {}).filter(r => r === 'machine_unknown').length;
    if (unknownMachineCount) {
      Toast.show(Util.t('toast.machine_rejected', { count: unknownMachineCount }), 'warn', 7000);
    }
    if (atomicOptimizer && (result.status === 'error' || (result.persisted ?? 0) !== ctx.tasks.length
      || (result.stale || []).length || (result.invalid_ids || []).length || (result.not_found_ids || []).length)) {
      ErrorLog.warn('persistence', 'Optimizer save rejected; all dependent changes remain unsaved', result);
      if (result.error_code === 'schedule.conflicts') {
        Toast.show(Util.t('toast.optimizer_conflicts', { count: (result.conflicts || []).length }), 'warn', 8000);
      } else if (!runtimePreviewChanged) {
        Toast.show(Util.t('toast.optimizer_unsaved_resolve'), 'warn', 8000);
      }
      return 'problem';
    }
    // Re-stamp each persisted task with its NEW row_version so the next edit
    // carries a fresh token — without this the client would self-conflict on its
    // own previous write. Direct field set, no emit (metadata only).
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
    const invalidSet = new Set((result.invalid_ids || []).map(String));
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
    const savedIds: string[] = [];
    const rejectedToRefresh: string[] = [];
    // Undo-settle baseline: the server now holds exactly what was sent, at the version it returned (also when a newer
    // local edit keeps the row dirty: the baseline is the server state, not the live row).
    for (const id of Object.keys(versions)) Persistence._recordBaseline(String(id), versions[id], Persistence._baselineKeyFromJson(sentSnapshot.get(String(id))));
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
        if (invalidSet.has(id) && !Object.prototype.hasOwnProperty.call(versions, id)) {
          // S7-4: the server refused this exact edit. Pull the server row back so the bar snaps back instead of
          // staying on screen as an edit that is no longer pending; the refresh clears the dirty markers itself.
          rejectedToRefresh.push(id);
          continue;
        }
        Persistence._dirtyIds.delete(id);
        Persistence._forceIds.delete(id);
        Persistence._firmDirtyIds.delete(id);
        Persistence._dirtySource.delete(id);
        // Only rows the server persisted (a version came back) gained history events; not_found ids
        // clear their dirty flag but wrote nothing.
        if (Object.prototype.hasOwnProperty.call(versions, id)) savedIds.push(id);
      }
      // else: leave dirty — the next saveAll() will pick up the newer edit.
    }
    // Inspector History refetches the saved orders' events (the server wrote them in the save transaction).
    if (savedIds.length) Store.emit({ type: 'tasks:saved', ids: savedIds, source: 'persistence' });
    if (rejectedToRefresh.length) Persistence._refreshTasks(rejectedToRefresh, refreshBaselines, { sent: sentSnapshot });
    if (stale.length) {
      const base_versions: Record<string, number | null> = {};
      for (const id of stale) base_versions[String(id)] = Store.tasks[String(id)]?.row_version ?? null;
      ErrorLog.warn('persistence', `Concurrency conflict on ${stale.length} order(s) — refetching`,
        { ids: stale, base_versions }, { errorCode: 'tasks.conflict', reqId });
      // U25: a stale row whose server copy already holds this client's exact placement is reconciled silently;
      // the conflict toast counts only the real conflicts (known once the refresh answers).
      Persistence._refreshTasks(stale, refreshBaselines, { sent: sentSnapshot, onConflicts: count => {
        if (count > 0 && !runtimePreviewChanged) Toast.show(Util.t('toast.concurrent_edit_conflict', { count }), 'warn', 7000);
      } });
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
      return 'problem';
    }
    if (persisted < total) {
      ErrorLog.warn('persistence', `Partial DB save: ${persisted}/${total} persisted`, result);
      const rejected = describeRejections(result.rejection_reasons);
      Toast.show(rejected
        ? Util.t('toast.partial_db_save_reasons', { persisted, total, details: rejected })
        : Util.t('toast.partial_db_save', { persisted, total }), 'warn', rejected ? 9000 : 6000);
      return 'problem';
    }
    ErrorLog.info('persistence', `Saved to backend (${persisted} tasks)`);
    return 'saved';
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
      Persistence._dirtySource.delete(id);
      if (Store.removeTask(id, 'persistence')) removed++;
    }
    return removed;
  },

  /** Optimistic-concurrency reconciliation: replace the complete server aggregate
   *  only when the rejected edit is still current. Newer local edits retain their
   *  old version and stay unresolved until explicit reload/discard. Emits once with source
   *  'refresh' — the dirty/autosave subscribers ignore that source so we don't
   *  re-dirty or write the rows we just pulled (see project_store_fanout). */
  /** `opts.sent` (U25): what the rejected save sent per id (the `_taskEditSnapshot` JSON). A server row that already
   *  carries exactly those dates, segments and attributes (two planners' browsers derived the same placement) is
   *  reconciled silently; `opts.onConflicts` receives how many ids were a REAL conflict, for the caller's toast. */
  _refreshTasks(ids: string[], savedBaselines?: Map<string, RefreshBaseline>,
                opts: { sent?: ReadonlyMap<string, string>; onConflicts?: (count: number) => void } = {}): void {
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
      // S7-2: a hung refresh must not leave its rows conflicted until Reload.
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    })
      .then(r => r.ok ? r.json() as Promise<TasksRefreshResponse> : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(({ data, missing }) => {
        for (const id of ids) Persistence._refreshRetry.delete(String(id));
        if (collection !== taskCollectionGeneration) return;
        const applied: string[] = [];
        let retained = false;
        let silent = 0;
        for (const row of (data || [])) {
          const tk = Store.tasks[String(row.id)];
          if (!tk) continue;
          if (!unchanged(String(row.id))) { retained = true; continue; }
          if (Persistence._sameAsSent(row as unknown as Record<string, unknown>, opts.sent?.get(String(row.id)))) silent++;
          else ErrorLog.info('persistence', 'conflict confirmed',
            { id: String(row.id), base_version: tk.row_version ?? null, server_version: row.row_version ?? null },
            { errorCode: 'tasks.conflict' });
          tk.MACHINE = row.MACHINE ?? '';
          tk.PRT_01 = row.PRT_01 ?? '';
          tk.PRT_02 = row.PRT_02 ?? '';
          tk.PRODUCTION_VERSION = row.PRODUCTION_VERSION ?? null;
          tk['ORDER_QUANTITY_(GMEIN)'] = row['ORDER_QUANTITY_(GMEIN)'] ?? null;
          tk.MATERIAL_NUMBER = row.MATERIAL_NUMBER ?? '';
          tk.PLANT = row.PLANT ?? '';
          tk.original_start_date = Util.parseDate(row.original_start_date);
          tk.BASIC_START_DATE = Util.parseDate(row.original_start_date);
          // The locked SAP due date. A row from an older server omits the field: keep what the client holds.
          if (row.original_end_date !== undefined) tk.original_end_date = Util.parseDate(row.original_end_date);
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
          tk.placement_exception = row.placement_exception ?? null;
          // A server-placed row must not be re-derived by the engine: carry the placed flag (older servers omit it).
          if (typeof row.user_scheduled === 'boolean') tk.user_scheduled = row.user_scheduled;
          // The server row replaces whatever the engine derived locally, so its session notes go with it.
          tk.derivationIssue = null;
          tk.systemMove = null;
          // The server's manual firm is authoritative; _normalizeDates re-syncs firmedIds from it.
          const serverFirmed = row.firmed;
          if (typeof serverFirmed === 'boolean') tk.firmed = serverFirmed;
          // S10-9: attributes an ingest rewrites. Only when the row carries them (older servers omit them); colour, form,
          // description, ORDER_Y and ecc_firmed are never edited locally, a note only while no local note is unsaved.
          const ingest = row as unknown as Partial<Pick<NimbusTask, 'COLOR' | 'FORM_SIZE' | 'MATERIAL_DESCRIPTION' | 'ORDER_Y' | 'ecc_firmed' | 'notes'>>;
          if (ingest.COLOR != null) tk.COLOR = ingest.COLOR;
          if (ingest.FORM_SIZE != null) tk.FORM_SIZE = ingest.FORM_SIZE;
          if (ingest.MATERIAL_DESCRIPTION != null) tk.MATERIAL_DESCRIPTION = ingest.MATERIAL_DESCRIPTION;
          if (ingest.ORDER_Y != null) tk.ORDER_Y = ingest.ORDER_Y;
          if (typeof ingest.ecc_firmed === 'boolean') tk.ecc_firmed = ingest.ecc_firmed;
          if (ingest.notes !== undefined && !Persistence.noteUnsaved(String(row.id))) tk.notes = ingest.notes;
          Store._normalizeDates(tk);
          tk.row_version = row.row_version as number | null;
          // A row the server still flags stale gets no baseline: the reconcile will dirty it to persist the re-derivation.
          if (row.runtime_schedule_mismatch) Persistence._savedBaseline.delete(String(row.id));
          else Persistence._recordBaseline(String(row.id), tk.row_version, Persistence._baselineKey(Persistence._taskEditSnapshot(tk)));
          Persistence._dirtyIds.delete(String(row.id));
          Persistence._forceIds.delete(String(row.id));
          Persistence._conflictedIds.delete(String(row.id));
          Persistence._firmDirtyIds.delete(String(row.id));
          Persistence._dirtySource.delete(String(row.id));
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
        opts.onConflicts?.(Math.max(0, ids.length - silent));
      })
      .catch(e => {
        // S7-2: remember what to retry; the next Save re-runs this refresh for the ids still conflicted.
        for (const id of ids) Persistence._refreshRetry.set(String(id), { baseline: baselines.get(String(id)), sent: opts.sent?.get(String(id)) });
        opts.onConflicts?.(ids.length);
        ErrorLog.warn('persistence', `Conflict refetch failed: ${e.message}`, ids);
        Toast.show(Util.t('toast.conflict_refresh_failed'), 'error', 8000);
      })
      .finally(() => {
        if (collection !== taskCollectionGeneration) return;
        Persistence._syncUnsaved();
        Persistence._saveCache();
      });
  },

  /** S7-2: re-run a conflict refresh that failed or timed out, for the ids still conflicted and still in the Store.
   *  Called by saveAll(); the retried call re-registers its ids if it fails again. */
  _retryFailedRefreshes(): void {
    if (!Persistence._refreshRetry.size) return;
    const ids: string[] = [];
    const baselines = new Map<string, RefreshBaseline>();
    const sent = new Map<string, string>();
    for (const [id, entry] of Persistence._refreshRetry) {
      if (!Store.tasks[id] || !Persistence._conflictedIds.has(id)) continue;
      ids.push(id);
      if (entry.baseline) baselines.set(id, entry.baseline);
      if (entry.sent !== undefined) sent.set(id, entry.sent);
    }
    Persistence._refreshRetry.clear();
    if (!ids.length) return;
    Persistence._refreshTasks(ids, baselines, { sent, onConflicts: count => {
      if (count > 0) Toast.show(Util.t('toast.concurrent_edit_conflict', { count }), 'warn', 7000);
    } });
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
        // `systemMove` is session-only and never cached: a restored copy would keep announcing a move that no
        // longer applies. The `reversal_forward/run_time_grew` `derivationIssue` IS cached so Remove Backlog's
        // count survives a reload (D21); it is revived only through the overlay (an unsaved placement edit) and is
        // cleared by the next schedule edit or refresh as before.
        tasks:          Store.tasksArr.map(({ firmed: _firmed, systemMove: _move, ...rest }) => rest as Record<string, unknown>),
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
    const tiers: Array<Partial<StoredState>> = cacheTiers(snapshot);
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
    } catch (e) { ErrorLog.warn('persistence', 'cache quarantine write failed', undefined, { stack: (e as Error)?.stack }); }
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
    Persistence._savedBaseline.clear();
    Persistence._refreshRetry.clear();
    if (evt.source === 'persistence') Persistence._conflictedIds.clear();
    return;
  }
  if (evt.source === 'refresh' || evt.source === 'engine-runtime-reconcile-display') return;
  const ids = evt.type === 'task:update' ? [String(evt.id)]
    : (evt.type === 'tasks:bulkUpdate' || evt.type === 'firmed:change') ? ((evt.ids ?? []) as Array<string | number>).map(String) : [];
  for (const id of ids) taskEditGenerations.set(id, (taskEditGenerations.get(id) ?? 0) + 1);
}, 'Persistence.conflictGenerations');

// State snapshot attached to error-level log entries (cheap: sizes only; may run during a drag).
ErrorLog.registerStateProvider('persistence', () => ({
  dirty: Persistence._dirtyIds.size,
  force: Persistence._forceIds.size,
  conflicted: Persistence._conflictedIds.size,
  firmDirty: Persistence._firmDirtyIds.size,
  autosaveDisabled: Persistence._autosaveDisabled,
}));

// S7-6: leaving the page (close, reload, navigate) with unsaved work asks first, and the cache is flushed on the
// way out so the debounced autosave cannot lose the last edit. Guarded: headless/test realms have no real window.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
    if (!Persistence.hasPendingWork()) return;
    e.preventDefault();
    e.returnValue = '';
  });
  window.addEventListener('pagehide', () => {
    if (Sandbox.active || Persistence._autosaveDisabled) return;
    Persistence._saveCache();
  });
}
