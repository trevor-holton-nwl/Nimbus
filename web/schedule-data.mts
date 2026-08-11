// schedule-data.mts — CQ-1 schedule-data module.
//
// Owns backend fetch + localStorage cache (Persistence), backend-
// authoritative persistence of per-plant/per-line working hours + blackout
// blocks (CalendarSync), and the mandatory-login client session's pure
// state/API (Session — currentUser/actor/isAdmin/allowedPlants/pref/setPref/
// signIn/signOut/refresh/onAuthDenied). Must NEVER import from
// schedule-services.mjs — only the reverse direction is allowed. Two real
// cross-package dependencies were found during Phase 2 research and are
// resolved here without a reverse import:
//   - Persistence._snapToWorkingHours/_dueEndOfShift used to call
//     Calendar._beginRun/_endRun/nextAvailable/workWindow directly. They now
//     go through an injected seam, `Persistence.setCalendarService({...})`,
//     wired once from app.js boot glue after schedule-services.mjs's Calendar
//     is available (see app.js's bridge destructure).
//   - Persistence used to call `Alerts.scheduleRecompute()` after every
//     hydration. It now emits a `{ type: 'schedule:hydrated', source }` Store
//     event instead; schedule-services.mjs subscribes to it once (see the
//     bottom of that file, added alongside Alerts in Task 2/this task).
// Session's DOM/settings-pane half (gates, the user-settings modal, profile/
// password self-service — ~600 lines that used to live inline in the same
// IIFE) stays in app.js as `SessionUIAdapter` (Task 5), mirroring the Phase 1
// Sandbox/SandboxAdapter split: `signIn`/`signOut`/`refresh` emit a
// `{ type: 'session:changed', kind }` Store event instead of calling
// `_applyGates()`/DOM code inline; `SessionUIAdapter.init()` (app.js) is the
// sole subscriber. `Session.updateCachedUser(patch)` is the one small public
// method added for a reverse-direction need the plan's own interface list
// didn't spell out: `SessionUIAdapter.saveProfile` (app.js) needs to merge a
// patch into the cached session blob after a successful profile PATCH, but
// the blob's localStorage key (`KEY`) is intentionally private to this
// module — same "small public method" resolution CLAUDE.md's Global
// Constraints prescribe for every reverse-direction need, never a bare
// `KEY` export or a `window`/`globalThis` reach-around.
// DOM/UI code that was co-located with these modules in app.js stays there —
// see docs/architecture/cq1-compatibility-inventory.md.
import { Config, Util, ErrorLog, Toast } from './application-foundation.mjs';
import { Store, Sandbox } from './schedule-state.mjs';
import type { NimbusTask, NimbusBlock, NimbusPlantBlock, WorkHours, NimbusLineSetting, LiveState, StoredState, NaiveLocalTs, IsoUtcTs, TopLevelTab, PriorityRankMaps } from './types.mjs';
import type { components } from './types/api-generated.mjs';

// -- Backend DTOs generated from brain.py's Pydantic response_model=s (Task 1/2
//    of this phase) — see docs/typescript_migration.md §F. Endpoints brain.py
//    does not yet model (/health, /plant-calendar, /master-data/*, /security/*)
//    get hand-written local interfaces below instead, per this phase's scope.
type TasksResponse        = components['schemas']['TasksResponse'];
type TaskDTOWire          = components['schemas']['TaskDTO'];
type BulkUpdateResult     = components['schemas']['BulkUpdateResult'];
type TaskUpdateResultWire = components['schemas']['TaskUpdateResult'];
type TasksRefreshResponse = components['schemas']['TasksRefreshResponse'];
type BaselineCorrectResult = components['schemas']['BaselineCorrectResult'];

// -- Local type declarations (Phase 4 conversion; scoped to this file, for the
//    endpoints Task 1 did not add a backend response_model= for) ------------

/** GET /master-data/plants and /master-data/production_lines share this
 *  envelope (master_data.py); `rows`' element shape differs per endpoint, so
 *  this is generic over it. */
interface MasterDataRowsResponse<T> {
  rows: T[];
}

interface MasterLineRow {
  production_line: string;
  plant: string;
  pl_group?: string;
}

interface MasterPlantRow {
  subnetwork: string;
  plant: string;
}

/** GET /health (brain.py) — only the fields this file reads are modeled;
 *  the reconnect watcher only cares that the request resolves 200. */
interface HealthResponse {
  db?: unknown;
  pool?: unknown;
  memory?: unknown;
  color_wheel?: unknown;
}

/** GET /plant-calendar (brain.py) response envelope. */
interface PlantCalendarConfig {
  plant_work_hours?: WorkHours;
  line_work_hours?: Record<string, WorkHours>;
  line_blackouts?: Array<{ id: string; line: string | null; start: IsoUtcTs; end: IsoUtcTs; reason: string }>;
  plant_blackouts?: Array<{ id: string; start: IsoUtcTs; end: IsoUtcTs; reason: string }>;
}

/** The subset of GET/POST /security/* fields this file reads/writes
 *  (brain.py's /security/login, /security/me, /security/me/settings). */
interface SessionUserBlob {
  username: string;
  role: string | null;
  is_admin?: boolean;
  allowed_plants?: string[] | null;
  first_name?: string | null;
  last_name?: string | null;
  settings?: Record<string, unknown>;
  role_settings?: Record<string, unknown>;
}

/** The cached shape written to localStorage under Session's own KEY —
 *  a superset of SessionUserBlob with is_admin always present post-cache. */
interface CachedSessionUser {
  username: string;
  role: string | null;
  is_admin?: boolean;
  allowed_plants: string[] | null;
  first_name: string | null;
  last_name: string | null;
  settings: Record<string, unknown>;
  role_settings: Record<string, unknown>;
  // Epoch ms this session was established (signIn only — refresh() carries it
  // forward, never resets it). Optional: sessions cached before this field
  // existed predate it, same reasoning as is_admin? above; isExpired() below
  // treats a missing/non-numeric value as expired rather than never-expiring.
  loggedInAt?: number;
}

/** Lazily-added fields `saveAll`'s `_post` retry closure stamps onto a plain
 *  `Error` so both the retry-vs-terminal check and the rejection log can read
 *  them back — mirrors nimbus-worker.ts's `err as Error` idiom (Phase 0). */
interface SaveError extends Error {
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

/** Return shape shared by every CalendarSync write helper (`_post` and its
 *  callers). `skipped` marks the two guarded no-op paths (`_hydrating` /
 *  `Sandbox.active`) — additive vs. the bare `{ ok; status?; error? }` shape
 *  named in this phase's plan, since the existing early-return literal
 *  `{ ok: true, skipped: true }` needs it and this file's zero-behavior-change
 *  discipline forbids dropping that field to fit a narrower type. */
interface CalendarSyncResult {
  ok: boolean;
  status?: number;
  error?: string;
  skipped?: boolean;
}

/** The injected calendar-capacity seam (Persistence.setCalendarService) —
 *  schedule-data.mts must never import schedule-services.mts directly (see
 *  this file's header comment); this is the whole shape it's allowed to see. */
interface CalendarService {
  beginRun(plant: string | null): void;
  endRun(): void;
  nextAvailable(line: string, from: Date, durationMs: number): Date;
  workWindow(line: string, date: Date): [Date, Date] | null;
}

// Injected calendar-capacity seam — replaces the former direct `Calendar.*` references
// (schedule-data.mts must never import schedule-services.mjs). Defaults to a no-op so a
// snap-affecting load path degrades to "skip snapping" instead of throwing when called
// before app.js's boot glue wires the real Calendar functions (see
// Persistence.setCalendarService below).
let _calendarService: CalendarService | null = null;

/* =============================================================================
   PERSISTENCE — backend fetch, demo fallback, save + local cache.
   ========================================================================== */
export const Persistence = {
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
  _dirtyIds: new Set<string>(),       // task ids mutated since last successful backend save
  _forceIds: new Set<string>(),       // dirty ids written by an authoritative bulk op (optimize) —
                              // these skip the optimistic-concurrency version check on save
  // Lazily-set by _writeCacheWithQuotaGuard/_quarantineCache — declared here
  // (rather than left to first assignment) since plain object-literal
  // properties need their type fixed at the literal's declaration.
  _lastCacheBytes: 0,
  _lastCacheAt: 0,
  _cacheDegraded: false,
  _autosaveDisabled: false,
  _lastQuarantineKey: null as string | null,
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

  /** Inject the calendar-capacity seam (`schedule-services.mjs`'s `Calendar`). Wired
   *  once from app.js boot glue right after the schedule-services.mjs bridge resolves.
   *  Until this is called, snap-affecting load paths no-op rather than throw — see
   *  `_snapToWorkingHours`. */
  setCalendarService(svc: CalendarService): void { _calendarService = svc; },

  stats(): LoadStats { return { ...Persistence._lastLoad }; },

  load({ force = false, plant = null }: { force?: boolean; plant?: string | null } = {}): Promise<void> {
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
    // auto-fix (which cannot await freshness: schedule-services.mts must not import
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

    // A plant is the scaling unit — never request the whole order book. With no
    // plant selected we leave the board empty (each plant-scoped module renders its
    // own EmptyState "select a plant" prompt) and only load master data so the
    // plant picker is populated and the user can choose one.
    if (!plant) {
      ErrorLog.info('persistence', 'No plant selected — skipping /tasks; loading master data for the picker');
      stats.source = 'backend';
      Store.setTasks([], 'persistence');
      Persistence._currentLoadedPlant = null;
      Persistence.loadPriorityRankMaps(null);
      return Promise.all([
        fetch(`${Config.API_BASE}/master-data/plants`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<MasterPlantRow>> : null),
        fetch(`${Config.API_BASE}/master-data/production_lines`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<MasterLineRow>> : null),
      ]).then(([pData, lData]) => {
        if (pData || lData) {
          Store.setMasterData({
            plants: pData?.rows ?? [],
            lines:  lData?.rows ?? [],
          }, 'persistence');
        }
      }).catch(e => ErrorLog.warn('persistence', `Master-data fetch failed (no-plant path): ${e.message}`));
    }

    const tasksUrl = `${Config.API_BASE}/tasks?plant=${encodeURIComponent(plant)}`;
    return fetch(tasksUrl, { signal: AbortSignal.timeout(8000) })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} from /tasks`);
        return r.json() as Promise<TasksResponse>;
      })
      .then(payload => {
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
        ErrorLog.info('persistence',
          `Backend returned ${stats.raw_received} rows`,
          { meta: stats.backend_meta });

        if (!stats.raw_received) {
          ErrorLog.warn('persistence', 'Backend returned zero rows — nothing to render');
          Toast.show(Util.t('toast.backend_zero_orders'), 'warn');
          Store.setTasks([], 'persistence');
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
            fetch(`${Config.API_BASE}/master-data/plants`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<MasterPlantRow>> : null),
            fetch(`${Config.API_BASE}/master-data/production_lines`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<MasterLineRow>> : null),
          ]).then(([pData, lData]) => {
            if (pData || lData) {
              Store.setMasterData({
                plants: pData?.rows ?? [],
                lines:  lData?.rows ?? [],
              }, 'persistence');
            }
          }).catch(e => ErrorLog.warn('persistence', `Master-data fetch failed (zero-task path): ${e.message}`))
            .finally(() => {
              Promise.all([CalendarSync.fetchPlantConfig(plant), Persistence.loadPriorityRankMaps(plant)])
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

        // Restore user state (blocks, calendars, fixedIds, lineSettings) from localStorage
        // before setTasks so alerts compute with the correct context. The backend is
        // authoritative for task schema; the cache owns blocks/calendars/fixedIds AND
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
          const line = t.PRODUCTION_LINE;
          if (!line || !t.PLANT) continue;
          Store.ensureLineSettings(line);
          Store.lineSettings[line].plant = t.PLANT;
        }

        // Overlay user-explicitly-moved positions from localStorage before snapping so that
        // _snapToWorkingHours detects them via startMoved and skips re-snap. Only tasks
        // where the cached start differs from the cached original baseline are overlaid.
        if (cacheData?.tasks?.length) {
          Persistence._overlayUserMoves(tasks, cacheData.tasks);
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

        const setResult = Store.setTasks(tasks, 'persistence');
        stats.dedup_collisions = setResult.collisions;
        stats.rendered = Store.tasksArr.length;
        Persistence._currentLoadedPlant = plant;

        // Apply fixed flag to tasks restored from cache
        for (const id of Store.fixedIds) {
          const t = Store.tasks[id]; if (t) t.fixed = true;
        }

        (payload.links || []).forEach(link => {
          (Store.dependencies[link.target] ||= []).push(link.source);
        });
        for (const t of Store.tasksArr) Store.ensureCalendar(t.PRODUCTION_LINE || 'Unknown');
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

        // Load master-data plants and lines in parallel (non-blocking).
        Promise.all([
          fetch(`${Config.API_BASE}/master-data/plants`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<MasterPlantRow>> : null),
          fetch(`${Config.API_BASE}/master-data/production_lines`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() as Promise<MasterDataRowsResponse<MasterLineRow>> : null),
        ]).then(([pData, lData]) => {
          if (pData || lData) {
            Store.setMasterData({
              plants: pData?.rows ?? [],
              lines:  lData?.rows ?? [],
            }, 'persistence');
          }
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
          Promise.all([CalendarSync.fetchPlantConfig(plant), Persistence.loadPriorityRankMaps(plant)])
            .finally(() => Store.emit({ type: 'schedule:hydrated', source: 'persistence' }));
        });
      })
      .catch(err => {
        stats.errors++;
        ErrorLog.error('persistence', `Backend fetch failed: ${err.message}`);
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
            try { Persistence.load({ force: true, plant: Persistence._currentLoadedPlant }); } catch (e) {
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
    // Coerce date-like string fields to Date.
    for (const k of Object.keys(raw)) {
      if (k.toLowerCase().includes('date') && typeof raw[k] === 'string') {
        raw[k] = Util.parseDate(raw[k] as string);
      }
    }
    return raw as unknown as NimbusTask;
  },

  // Apply user-explicitly-moved positions from the localStorage cache back onto
  // freshly-fetched backend tasks. Only tasks where the cached start_date differs
  // from the cached original_start_date are overlaid — those are the ones the user
  // has consciously dragged beyond the auto-snap baseline. This prevents
  // _snapToWorkingHours from re-snapping user placements over blackout blocks.
  _overlayUserMoves(backendTasks: NimbusTask[], cachedTasks: Array<Record<string, unknown>>): void {
    const byId = new Map(cachedTasks.map(t => [t.id, t]));
    for (const t of backendTasks) {
      const cached = byId.get(t.id);
      if (!cached) continue;
      const cs  = Util.parseDate(cached.start_date);
      const ce  = Util.parseDate(cached.end_date);
      const cos = Util.parseDate(cached.original_start_date);
      if (!(cs instanceof Date) || !(ce instanceof Date)) continue;
      if (!(cos instanceof Date) || cs.getTime() === cos.getTime()) continue;
      t.start_date = cs;
      t.end_date   = ce;
      t.original_start_date = cos;
      const coe = Util.parseDate(cached.original_end_date);
      if (coe instanceof Date) t.original_end_date = coe;
    }
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
        const line = t.PRODUCTION_LINE;
        if (!line) continue;
        if (!(t.start_date instanceof Date) || !(t.end_date instanceof Date)) continue;
        const durationMs = t.end_date.getTime() - t.start_date.getTime();
        if (durationMs <= 0) continue;

        if (t.fixed) continue;

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
        const line = t.PRODUCTION_LINE;
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
      // Restore all non-task state first so alerts compute with correct context
      Persistence._restoreNonTaskState(data);
      // Sync plant from task data for any lines not yet in lineSettings
      for (const t of tasks) {
        const line = t.PRODUCTION_LINE;
        if (!line || !t.PLANT) continue;
        Store.ensureLineSettings(line);
        if (!Store.lineSettings[line].plant) {
          Store.lineSettings[line].plant = t.PLANT;
        }
      }
      Store.setTasks(tasks, 'persistence');
      for (const id of Store.fixedIds) {
        const t = Store.tasks[id]; if (t) t.fixed = true;
      }
      for (const t of tasks) {
        Store.ensureCalendar(t.PRODUCTION_LINE || 'Unknown');
        Store.ensureLineSettings(t.PRODUCTION_LINE || 'Unknown');
      }
      Store.emit({ type: 'schedule:hydrated', source: 'persistence' });
      Toast.show(Util.t('toast.loaded_cache', { count: tasks.length }), 'info');
      return true;
    } catch (e) { ErrorLog.error('persistence', `Cache load failed: ${(e as Error).message}`); return false; }
  },

  // Restore non-task user state from a cache snapshot. Called both from _loadCache()
  // and from the backend load path (where the backend owns task dates but localStorage
  // owns everything else: blocks, calendars, fixedIds, lineSettings, plants).
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
    if (Array.isArray(data.fixedIds)) {
      Store.fixedIds.clear();
      for (const id of data.fixedIds) Store.fixedIds.add(String(id));
    }
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
            PRODUCTION_LINE: line,
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
    // Fix a couple of example orders to showcase the feature.
    if (tasks.length > 6) {
      tasks[2].fixed = true;
      tasks[10].fixed = true;
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

  saveAll(): void {
    // In sandbox, promote-then-save runs through Sandbox.exit(true), which itself
    // calls saveAll() after teardown — so return here to avoid a double POST (the
    // re-entrant call below does the single persist).
    if (Sandbox.active) { Sandbox.exit(true); return; }
    Persistence._saveCache();

    // Only send tasks that changed since the last successful save. The backend
    // only persists start_date/end_date so fixed/line changes don't need to be
    // in this payload. tasks:bulk (reload/undo) clears _dirtyIds because Store
    // state came from a known-good source that doesn't need to be written back.
    const dirtyTasks = Persistence._dirtyIds.size > 0
      ? Store.tasksArr.filter(t => Persistence._dirtyIds.has(String(t.id)))
      : [];
    // Send only the fields the backend consumes, plus the optimistic-concurrency
    // token (row_version → base_version). Optimize-dirtied ids carry force=true so an
    // authoritative reschedule never false-conflicts with a concurrent editor.
    const taskPayload = dirtyTasks.map(t => ({
      id:           t.id,
      // toLocalSeconds, not the raw Date: JSON.stringify would call
      // Date.toISOString() (UTC), but the orders read path emits bare naive
      // strftime (no Z) which new Date() parses as LOCAL — so a raw Date here
      // round-trips shifted by the client's UTC offset for any non-UTC user.
      // Mirrors _relayDueDateCorrections; see Util.toLocalSeconds.
      start_date:   Util.toLocalSeconds(t.start_date) as NaiveLocalTs,
      end_date:     Util.toLocalSeconds(t.end_date) as NaiveLocalTs,
      base_version: t.row_version ?? null,
      force:        !Config.CONCURRENCY_CHECK || Persistence._forceIds.has(String(t.id)),
    }));
    const body = JSON.stringify({ tasks: taskPayload, blocks: Store.blocks, calendars: Store.calendars });

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
    }).then(async r => {
      if (!r.ok) {
        const parsed = await Util.parseBackendError(r);
        const err = new Error(parsed.message) as SaveError;
        err.httpStatus = r.status; err.errorCode = parsed.errorCode; err.reqId = reqId;
        throw err;
      }
      return r.json() as Promise<BulkUpdateResult>;
    }).catch(e => {
      if (e.httpStatus || attempt >= 3) throw e;
      return new Promise(res => setTimeout(res, 2000)).then(() => _post(attempt + 1));
    });

    _post(1)
      .then(result => {
        // Re-stamp each persisted task with its NEW row_version so the next edit
        // carries a fresh token — without this the client would self-conflict on its
        // own previous write. Direct field set, no emit (metadata only).
        const versions = result.versions || {};
        for (const id of Object.keys(versions)) {
          const tk = Store.tasks[id];
          if (tk) tk.row_version = versions[id];
        }
        const stale = result.stale || [];
        // Clear dirty/force ONLY for ids the backend actually accounted for (R7):
        // persisted (versions), concurrency-stale (refetched, last-writer-loses), and
        // terminally rejected (invalid range / not in DB — a corrected edit re-dirties).
        // Any sent id that is NONE of these — e.g. a row lost between SELECT FOR UPDATE
        // and the UPDATE — stays dirty so the next save retries it instead of silently
        // dropping the edit. Previously both sets were .clear()'d unconditionally.
        const accounted = new Set([
          ...Object.keys(versions),
          ...stale,
          ...(result.invalid_ids || []),
          ...(result.not_found_ids || []),
        ].map(String));
        for (const id of accounted) {
          Persistence._dirtyIds.delete(id);
          Persistence._forceIds.delete(id);
        }
        if (stale.length) {
          ErrorLog.warn('persistence', `Concurrency conflict on ${stale.length} order(s) — refetching`, stale);
          Persistence._refreshTasks(stale);
          Toast.show(Util.t('toast.concurrent_edit_conflict', { count: stale.length }), 'warn', 7000);
        }
        const persisted = result.persisted ?? 0;
        const total     = result.updated   ?? 0;
        if (stale.length) {
          // Conflicts already surfaced their own toast; don't also claim a partial-save error.
        } else if (persisted < total) {
          ErrorLog.warn('persistence', `Partial DB save: ${persisted}/${total} persisted`, result);
          Toast.show(Util.t('toast.partial_db_save', { persisted, total }), 'warn', 6000);
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
        } else {
          ErrorLog.warn('persistence', `Backend save failed: ${e.message}`,
            { reqId }, { reqId, errorCode: 'http.network' });
          Toast.show(Util.t('toast.saved_locally'), 'info');
        }
      });
  },

  /** Optimistic-concurrency reconciliation: pull the server's current dates +
   *  row_version for orders a concurrent editor changed underneath us, and overwrite
   *  the stale local copies. Writes _state directly and emits ONCE with source
   *  'refresh' — the dirty/autosave subscribers ignore that source so we don't
   *  re-dirty or write the rows we just pulled (see project_store_fanout). */
  _refreshTasks(ids: string[]): void {
    if (!ids || !ids.length) return;
    fetch(`${Config.API_BASE}/tasks/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
      .then(r => r.ok ? r.json() as Promise<TasksRefreshResponse> : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(({ data }) => {
        const applied: string[] = [];
        for (const row of (data || [])) {
          const tk = Store.tasks[String(row.id)];
          if (!tk) continue;
          tk.start_date  = Util.parseDate(row.start_date);
          tk.end_date    = Util.parseDate(row.end_date);
          tk.row_version = row.row_version as number | null;
          Persistence._dirtyIds.delete(String(row.id));
          Persistence._forceIds.delete(String(row.id));
          applied.push(String(row.id));
        }
        if (applied.length) {
          Store.emit({ type: 'tasks:bulkUpdate', ids: applied, source: 'refresh' });
        }
      })
      .catch(e => ErrorLog.warn('persistence', `Conflict refetch failed: ${e.message}`, ids));
  },

  /** Force a full reload from backend, bypassing cache. Returns the load Promise. */
  reload(): Promise<void> {
    ErrorLog.info('persistence', 'Manual reload triggered — clearing dependencies');
    const deps = Store.dependencies;
    for (const k of Object.keys(deps)) delete deps[k];
    return Persistence.load({ force: true, plant: Persistence._currentLoadedPlant });
  },

  /** Fetch tasks for a specific plant, replacing whatever is currently in Store.
   *  Skips the fetch if that plant is already loaded. */
  loadForPlant(plant: string | null): Promise<void> {
    if (!plant || plant === Persistence._currentLoadedPlant) return Promise.resolve();
    const deps = Store.dependencies;
    for (const k of Object.keys(deps)) delete deps[k];
    return Persistence.load({ plant });
  },

  /** Fetch this plant's priority rank maps ({line_or_empty: {field_key: {VALUE:
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
    try {
      // Annotated so a future field rename on either side (Store or StoredState)
      // is caught here rather than silently drifting.
      const snapshot: StoredState = {
        _schemaVersion: Config.SCHEMA_VERSION,
        _buildId:       Config.BUILD_ID,
        _savedAt:       new Date().toISOString(),
        tasks:          Store.tasksArr,
        blocks:         Store.blocks,
        calendars:      Store.calendars,
        fixedIds:       [...Store.fixedIds],
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
    const tiers: Array<Partial<StoredState>> = [
      snapshot,
      { ...snapshot, tasks: snapshot.tasks.slice(-2000) },
      { ...snapshot, tasks: snapshot.tasks.slice(-500) },
      { ...baseMeta,
        selectedPlant: snapshot.selectedPlant,
        lineSettings:  snapshot.lineSettings,
        fixedIds:      snapshot.fixedIds,
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

  /** Restore the persisted plant selection (if any). Called at boot once Store
   *  is populated enough to know what plants exist. Falls back to null when
   *  the persisted plant no longer matches a known plant. */
  restoreSelectedPlant(): void {
    try {
      const raw = localStorage.getItem(Config.LS_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      const saved = data?.selectedPlant;
      if (!saved) return;
      const known = Store.knownPlants();
      Store.setSelectedPlant(known.includes(saved) ? saved : null, 'restore');
    } catch {
      // ignore — selectedPlant restore is best-effort
    }
  },

  _autosave: Util.debounce(() => {
    if (typeof Sandbox !== 'undefined' && Sandbox.active) return;
    if (Persistence._autosaveDisabled) return;
    Persistence._saveCache();
  }, 1200)
};

/* =============================================================================
   CALENDAR SYNC — backend-authoritative persistence of per-plant/per-line
   working hours + blackout blocks (dedicated /plant-calendar/* endpoints).
   - fetchPlantConfig(plant): GET a plant's config and hydrate Store (backend
     authoritative; localStorage stays the offline fallback).
   - immediate per-edit saves: working hours (batched per plant), blackouts
     (delta — upsert on add/edit, explicit delete on remove).
   - per-slice migration: push slices the backend still lacks (first upgrade / retry).
   Two guards live in the single _post choke point: _hydrating (don't POST while
   applying a backend GET) and Sandbox.active (What-If edits stay local until
   promoted). Block scoping/keying uses the block's stored `plant` + stable id.
   ========================================================================== */
export const CalendarSync = {
  _hydrating: false,
  _pendingLineHours: {} as Record<string, Record<string, WorkHours>>,   // plant → { line → workHours } awaiting a batched flush
  _whDebounce: {} as Record<string, ReturnType<typeof setTimeout>>,         // plant → timeout id
  _deferredHydrationPlant: null as string | null,  // plant whose config GET resolved mid-What-If (re-hydrate on exit)

  /* ----- load / hydration ----------------------------------------------- */
  fetchPlantConfig(plant: string | null): Promise<void> {
    if (!plant) return Promise.resolve();
    // Ensure the line→plant index is current before _applyConfig so getPlantForLine
    // resolves reliably even when the master-data fetch REJECTED (the .finally still
    // runs us). Otherwise the migration/clear filters misfire on a stale/empty index. (F4)
    Store.rebuildPlantIndex();
    return Util.fetchTraced(`${Config.API_BASE}/plant-calendar?plant=${encodeURIComponent(plant)}`,
                            { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() as Promise<PlantCalendarConfig> : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(cfg => CalendarSync._applyConfig(plant, cfg))
      .catch(e => {
        // The localStorage restore already painted the UI — degrade gracefully.
        ErrorLog.warn('calendar-sync', `Fetch plant-calendar failed for ${plant}: ${e.message}`);
        Toast.show(Util.t('toast.calendar_offline_cache'), 'info');
      });
  },

  _applyConfig(plant: string, cfg: PlantCalendarConfig): void {
    // Never overwrite live What-If state — mirror the _post guard. A plant switch or a
    // late in-flight fetch during What-If must not clobber sandbox edits (the write path
    // already no-ops under Sandbox.active; the hydration write path must too). (F2)
    // Record the plant so Sandbox.exit can re-hydrate it — otherwise a config GET that
    // resolves mid-What-If is dropped and the plant shows stale cached state all session.
    if (typeof Sandbox !== 'undefined' && Sandbox.active) {
      CalendarSync._deferredHydrationPlant = plant;
      return;
    }
    cfg = cfg || {};
    // Evaluate emptiness PER SLICE. Backend is authoritative only for the slices it
    // actually has; slices it still lacks are left intact locally and migrated up
    // (below) — so a partial migration (or first upgrade) can never let a
    // clear-and-replace wipe an un-persisted slice.
    const has = {
      plantHours:     !!cfg.plant_work_hours,
      lineHours:      Object.keys(cfg.line_work_hours || {}).length > 0,
      lineBlackouts:  (cfg.line_blackouts || []).length > 0,
      plantBlackouts: (cfg.plant_blackouts || []).length > 0,
    };
    this._hydrating = true;
    try {
      if (has.plantHours) {
        Store.ensurePlant(plant);
        Store.plants[plant].workHours = cfg.plant_work_hours!;
      }
      if (has.lineHours) {
        // Clear this plant's line calendars (backend line set ∪ getPlantForLine===plant), then apply.
        const backendLines = new Set(Object.keys(cfg.line_work_hours!));
        for (const line of Object.keys(Store.calendars)) {
          if (backendLines.has(line) || Store.getPlantForLine(line) === plant) delete Store.calendars[line];
        }
        for (const [line, wh] of Object.entries(cfg.line_work_hours!)) {
          Store.ensureCalendar(line);
          Store.calendars[line].workHours = wh;
        }
      }
      if (has.lineBlackouts) {
        // Clear by the block's OWN stored plant (never a runtime getPlantForLine
        // derivation, which can be null before master data loads). Preserve backend ids.
        // In-place filter (no reference reassignment) so Store.blocks' identity is stable.
        const keptBlocks = Store.blocks.filter(b => b.plant !== plant);
        Store.blocks.length = 0;
        Store.blocks.push(...keptBlocks);
        for (const b of cfg.line_blackouts!) {
          Store.blocks.push({ id: b.id, line: b.line || null, plant,
            start: Util.parseDate(b.start), end: Util.parseDate(b.end), reason: b.reason || '' } as NimbusBlock);
        }
      }
      if (has.plantBlackouts) {
        const keptPlantBlocks = Store.plantBlocks.filter(b => b.plant !== plant);
        Store.plantBlocks.length = 0;
        Store.plantBlocks.push(...keptPlantBlocks);
        for (const b of cfg.plant_blackouts!) {
          Store.plantBlocks.push({ id: b.id, plant,
            start: Util.parseDate(b.start), end: Util.parseDate(b.end), reason: b.reason || '' } as NimbusPlantBlock);
        }
      }
      // Notify subscribers + refresh the offline cache with backend truth. These
      // emits fire while _hydrating=true, so no POST-back to the backend.
      Store.emit({ type: 'calendar:change',    source: 'calendar-sync' });
      Store.emit({ type: 'blocks:change',      source: 'calendar-sync' });
      Store.emit({ type: 'plantBlocks:change', source: 'calendar-sync' });
    } finally {
      this._hydrating = false;
    }
    // Backend-authoritative working hours just landed. The initial ingest snap
    // (Persistence._snapToWorkingHours at load) ran against default/stale hours, and is
    // never otherwise re-run — so fresh (non-user-scheduled) orders may sit outside the
    // real working window. Re-snap against the now-correct hours and re-render/cache.
    // Idempotent when hours match; _snapToWorkingHours re-baselines each pass, so a
    // second pass leaves the correct final baseline (no set-once needed). (F7)
    // Deliberately NOT gated on (has.plantHours || has.lineHours): "backend has no
    // override" is still an authoritative answer (use defaults) that the due-date
    // correction phase needs in order to relay — gating on has.* left the relay
    // permanently dead for every plant that has never had custom hours saved to the
    // backend, which is the common case (CalendarSync never migrates auto-seeded
    // default hours up), not a rare one.
    if (Store.tasksArr.length) {
      try {
        // A slow (8s) fetchPlantConfig can resolve AFTER the user started editing this
        // session. tasks:bulk clears _dirtyIds/_forceIds (reload semantics, app.js:14840),
        // so snapshot and restore them — the re-snap only re-places non-user-scheduled
        // orders (user moves are startMoved-skipped) and must not drop pending saves.
        const dirtySnapshot  = new Set(Persistence._dirtyIds);
        const forceSnapshot  = new Set(Persistence._forceIds);
        const { movedIds, corrections } = Persistence._snapToWorkingHours(Store.tasksArr, plant);
        Persistence._saveCache();
        // Only emit and re-render if tasks actually moved; idempotent when hours haven't
        // changed (nextAvailable will find the same slots, startMoved-skip user-placed).
        if (movedIds.length) {
          Store.emit({ type: 'tasks:bulkUpdate', ids: movedIds, source: 'calendar-resnap' });
        }
        for (const id of dirtySnapshot) Persistence._dirtyIds.add(id);
        for (const id of forceSnapshot) Persistence._forceIds.add(id);
        // Backend-authoritative hours have now landed — this is the only point
        // in the session safe to PERSIST due-date-baseline corrections. The
        // earlier pre-hydration call in Persistence.load may have computed
        // against Config.DEFAULT_SHIFT / stale cached hours, and this
        // correction is deliberately freeze-once (see _snapToWorkingHours) —
        // persisting from that first pass could lock in a wrong value before
        // the accurate hours ever get a chance to run.
        Persistence._relayDueDateCorrections(corrections);
      } catch (e) {
        ErrorLog.warn('calendar-sync', `Re-snap after hydrate failed for ${plant}: ${(e as Error).message}`);
      }
    }
    // Migrate the slices the backend still lacks but local has. Covers first upgrade
    // (backend fully empty) AND partial-migration retry. Each slice is one atomic POST
    // (all-or-nothing); a failed slice stays un-migrated and retries next load.
    // Idempotent via client-supplied ids + ON CONFLICT, so re-sending is harmless.
    this._migrateMissingSlices(plant, has);
  },

  _migrateMissingSlices(plant: string, has: { plantHours: boolean; lineHours: boolean; lineBlackouts: boolean; plantBlackouts: boolean }): void {
    if (!plant) return;
    const jobs: Array<Promise<{ ok: boolean; status?: number; error?: string }>> = [];
    if (!has.plantHours) {
      const wh = Store.plants[plant]?.workHours || null;
      // Don't migrate the auto-seeded DEFAULT_SHIFT — a missing backend row means
      // "no override", which the client already reproduces from the seed. Migrating it
      // would freeze today's default and hide a future DEFAULT_SHIFT policy change. (F11)
      if (wh && !CalendarSync._isDefaultWorkHours(wh)) jobs.push(this.savePlantHours(plant, wh));
    }
    if (!has.lineHours) {
      const lines = Object.keys(Store.calendars)
        .filter(l => Store.getPlantForLine(l) === plant
                  && !CalendarSync._isDefaultWorkHours(Store.calendars[l].workHours))  // F11
        .map(l => ({ production_line: l, work_hours: Store.calendars[l].workHours }));
      if (lines.length) jobs.push(this._post('/plant-calendar/line-hours', { plant, lines }, 'migrate-line-hours'));
    }
    if (!has.lineBlackouts) {
      // Legacy line-less UNSTAMPED blocks were global (applied to every plant). Don't let
      // the first-loading plant capture them — fan each out to a deterministic stamped
      // copy per known plant, preserving global reach durably + idempotently. (F8)
      CalendarSync._fanOutLegacyGlobalLineBlocks();
      // Now migrate this plant's own blocks: already-stamped for it, or line-mapped to it.
      const blks = Store.blocks.filter(b =>
        b.plant === plant || (!b.plant && b.line && Store.getPlantForLine(b.line) === plant));
      blks.forEach(b => { b.plant = plant; });
      if (blks.length) jobs.push(this._post('/plant-calendar/line-blackouts', { plant, upserts: blks.map(b => this._blockPayload(b, true)) }, 'migrate-line-blackouts'));
    }
    if (!has.plantBlackouts) {
      CalendarSync._fanOutLegacyGlobalPlantBlocks();  // same first-loader-capture fix (F8)
      const blks = Store.plantBlocks.filter(b => b.plant === plant);
      if (blks.length) jobs.push(this._post('/plant-calendar/plant-blackouts', { plant, upserts: blks.map(b => this._blockPayload(b, false)) }, 'migrate-plant-blackouts'));
    }
    if (jobs.length) {
      Promise.all(jobs).then(rs => {
        if (rs.every(r => r && r.ok)) {
          ErrorLog.info('calendar-sync', `Migrated local calendar/blackout config for plant ${plant} to backend`);
          Toast.show(Util.t('toast.calendar_migrated'), 'info', 4000);
        }
      });
    }
  },

  // True when a weekly workHours map equals the DEFAULT_SHIFT / WEEKEND_OFF seed, i.e.
  // represents "no override" — used to skip migrating auto-seeded defaults. (F11)
  _isDefaultWorkHours(wh: WorkHours | null | undefined): boolean {
    if (!wh) return true;
    for (let d = 0; d < 7; d++) {
      const v = wh[d];
      if (Config.WEEKEND_OFF && (d === 0 || d === 6)) {
        if (v !== null && v !== undefined) return false;
        continue;
      }
      if (!Array.isArray(v) || v.length !== 2) return false;
      if (v[0] !== Config.DEFAULT_SHIFT[0] || v[1] !== Config.DEFAULT_SHIFT[1]) return false;
    }
    return true;
  },

  // One-time migration fix: legacy line-less UNSTAMPED blackouts were global (applied to
  // every plant). Replace each with one deterministic stamped copy per known plant so no
  // single plant captures it and none is dropped from other plants. Idempotent — after
  // the first run there are no un-stamped line-less blocks left to fan out. (F8)
  _fanOutLegacyGlobalLineBlocks(): void {
    const plants = Store.knownPlants();
    if (!plants.length) return;
    const legacy = Store.blocks.filter(b => !b.plant && !b.line);
    if (!legacy.length) return;
    const keep = Store.blocks.filter(b => b.plant || b.line);
    for (const b of legacy) {
      for (const p of plants) {
        keep.push({ id: `${b.id}::${p}`, line: null, plant: p, start: b.start, end: b.end, reason: b.reason || '' });
      }
    }
    // In-place replace (no reference reassignment) so Store.blocks' identity is stable.
    Store.blocks.length = 0;
    Store.blocks.push(...keep);
    ErrorLog.info('calendar-sync', `Fanned out ${legacy.length} legacy global line blackout(s) across ${plants.length} plant(s)`);
  },

  _fanOutLegacyGlobalPlantBlocks(): void {
    const plants = Store.knownPlants();
    if (!plants.length) return;
    const legacy = Store.plantBlocks.filter(b => !b.plant);
    if (!legacy.length) return;
    const keep = Store.plantBlocks.filter(b => b.plant);
    for (const b of legacy) {
      for (const p of plants) {
        keep.push({ id: `${b.id}::${p}`, plant: p, start: b.start, end: b.end, reason: b.reason || '' });
      }
    }
    Store.plantBlocks.length = 0;
    Store.plantBlocks.push(...keep);
    ErrorLog.info('calendar-sync', `Fanned out ${legacy.length} legacy global plant blackout(s) across ${plants.length} plant(s)`);
  },

  /* ----- immediate per-edit saves --------------------------------------- */
  savePlantHours(plant: string | null, workHours: WorkHours | undefined): Promise<CalendarSyncResult> {
    if (!plant) return Promise.resolve({ ok: false });
    return this._post('/plant-calendar/plant-hours', { plant, work_hours: workHours }, 'plant-hours');
  },

  // Enqueue one line's hours; a per-plant debounce coalesces the ~70-line clamp
  // fan-out from a single plant-hours edit into ONE /line-hours request.
  saveLineHours(plant: string | null, line: string, workHours: WorkHours): void {
    if (!plant || !line) return;
    (this._pendingLineHours[plant] ||= {})[line] = workHours;
    clearTimeout(this._whDebounce[plant]);
    this._whDebounce[plant] = setTimeout(() => this._flushLineHours(plant), 600);
  },
  _flushLineHours(plant: string): Promise<CalendarSyncResult> | undefined {
    const pending = this._pendingLineHours[plant];
    if (!pending || !Object.keys(pending).length) return;
    delete this._pendingLineHours[plant];
    const lines = Object.entries(pending).map(([production_line, work_hours]) => ({ production_line, work_hours }));
    return this._post('/plant-calendar/line-hours', { plant, lines }, 'line-hours');
  },

  saveLineBlackoutUpsert(block: NimbusBlock): Promise<CalendarSyncResult> {
    if (!block?.plant) return Promise.resolve({ ok: false });
    return this._post('/plant-calendar/line-blackouts', { plant: block.plant, upserts: [this._blockPayload(block, true)] }, 'line-blackout-upsert');
  },
  saveLineBlackoutDelete(plant: string | null, id: string): Promise<CalendarSyncResult> {
    if (!plant || !id) return Promise.resolve({ ok: false });
    return this._post('/plant-calendar/line-blackouts', { plant, deletes: [id] }, 'line-blackout-delete');
  },
  savePlantBlackoutUpsert(block: NimbusPlantBlock): Promise<CalendarSyncResult> {
    if (!block?.plant) return Promise.resolve({ ok: false });
    return this._post('/plant-calendar/plant-blackouts', { plant: block.plant, upserts: [this._blockPayload(block, false)] }, 'plant-blackout-upsert');
  },
  savePlantBlackoutDelete(plant: string | null, id: string): Promise<CalendarSyncResult> {
    if (!plant || !id) return Promise.resolve({ ok: false });
    return this._post('/plant-calendar/plant-blackouts', { plant, deletes: [id] }, 'plant-blackout-delete');
  },

  /** Promote path (What-If → live): push the plant's current calendar/blackout state
   *  as upserts, PLUS the blackout ids deleted during the What-If session as explicit
   *  deletes. `removed` = { line:[ids], plant:[ids] } is computed by Sandbox.exit while
   *  the pre-sandbox snapshot is still alive (it is nulled before flush). Without the
   *  deletes, a blackout removed in What-If would resurrect from the backend on the next
   *  hydration. (F3) */
  flushPlant(plant: string, removed?: { line: string[]; plant: string[] }): void {
    if (!plant) return;
    removed = removed || { line: [], plant: [] };
    this.savePlantHours(plant, Store.plants[plant]?.workHours);
    const lines = Object.keys(Store.calendars)
      .filter(l => Store.getPlantForLine(l) === plant)
      .map(l => ({ production_line: l, work_hours: Store.calendars[l].workHours }));
    if (lines.length) this._post('/plant-calendar/line-hours', { plant, lines }, 'promote-line-hours');
    const lineBk = Store.blocks.filter(b => b.plant === plant);
    const lineDeletes = removed.line || [];
    if (lineBk.length || lineDeletes.length) {
      this._post('/plant-calendar/line-blackouts',
        { plant, upserts: lineBk.map(b => this._blockPayload(b, true)), deletes: lineDeletes }, 'promote-line-blackouts');
    }
    const plantBk = Store.plantBlocks.filter(b => b.plant === plant);
    const plantDeletes = removed.plant || [];
    if (plantBk.length || plantDeletes.length) {
      this._post('/plant-calendar/plant-blackouts',
        { plant, upserts: plantBk.map(b => this._blockPayload(b, false)), deletes: plantDeletes }, 'promote-plant-blackouts');
    }
  },

  /* ----- internals ------------------------------------------------------- */
  _blockPayload(b: NimbusBlock | NimbusPlantBlock, withLine: boolean): { id: string; start: IsoUtcTs | null; end: IsoUtcTs | null; reason: string | null; line?: string | null } {
    const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
    const o: { id: string; start: IsoUtcTs | null; end: IsoUtcTs | null; reason: string | null; line?: string | null } =
      { id: b.id, start: s ? s.toISOString() : null, end: e ? e.toISOString() : null, reason: b.reason || null };
    if (withLine) o.line = (b as NimbusBlock).line || null;
    return o;
  },

  _post(path: string, body: Record<string, unknown>, label: string): Promise<CalendarSyncResult> {
    // Single choke point for every backend write. Two guards: never POST while
    // applying a backend GET (_hydrating), and never leak What-If edits (Sandbox).
    if (this._hydrating || (typeof Sandbox !== 'undefined' && Sandbox.active)) {
      return Promise.resolve({ ok: true, skipped: true });
    }
    return Util.fetchTraced(`${Config.API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    }).then(r => {
      if (!r.ok) {
        if (r.status === 400 || r.status === 409) Toast.show(Util.t('toast.plant_not_mastered'), 'error', 6000);
        else                                       Toast.show(Util.t('toast.calendar_saved_locally'), 'info');
        ErrorLog.warn('calendar-sync', `${label} failed: HTTP ${r.status}`);
        return { ok: false, status: r.status };
      }
      return { ok: true };
    }).catch(e => {
      // The edit is already in Store + localStorage; only backend sync is deferred.
      ErrorLog.warn('calendar-sync', `${label} error: ${e.message}`);
      Toast.show(Util.t('toast.calendar_saved_locally'), 'info');
      return { ok: false, error: e.message };
    });
  },
};

/* =============================================================================
   SESSION — mandatory-login client session, pure state/API half. Backed by
   localStorage (mirrors the LangSwitcher get/set idiom in
   nimbus-intelligence.js), never the backend — the backend is the source of
   truth for the password check (POST /security/login); once authenticated,
   the session is just { username, role, ... } cached locally so a page reload
   doesn't force a re-login.
     Session.currentUser()   — { username, role, ... } | null
     Session.actor()         — username for X-User/x-user-email headers, else 'system'
     Session.isAdmin()       — true iff current user's role === 'admin' (or is_admin)
     Session.allowedPlants() — null (unrestricted) | string[] (role_plants scope)
     Session.canAccessTab(tab) — per-role top-level page visibility (Security >
       Roles "Page Access" toggles); admins always pass. DEFAULT_PAGE_ACCESS
       fills in for any tab a role hasn't customized.
     Session.pref(key) / .setPref(key, value) / .flushPrefs() — per-user
       settings: optimistic Store write + a debounced PATCH /security/me/settings
     Session.signIn(u, p)    — POST /security/login; persists session, emits
                                {type:'session:changed', kind:'signin'}
     Session.signOut()       — clears session, emits kind:'signout', reloads the page
     Session.refresh()       — reconciles cached role/settings/plant-scope against
                                GET /security/me; emits kind:'refresh'
     Session.onAuthDenied()  — a gated request came back 403; re-reconciles via refresh()
     Session.updateCachedUser(patch) — merge `patch` into the cached session blob;
       the seam app.js's SessionUIAdapter.saveProfile uses instead of reaching into
       this module's private `KEY` constant directly.
   DOM/settings-pane code that used to live inline in this same IIFE (gates, the
   user-settings modal, profile/password self-service, personalization/workflow
   panes) stays in app.js as `SessionUIAdapter`, which owns the sole subscription
   to the `session:changed` event emitted below — mirrors the Phase 1
   Sandbox/SandboxAdapter split exactly.
   ========================================================================== */
export const Session = (() => {
  const KEY = 'nimbus.session';

  function currentUser(): CachedSessionUser | null {
    // Guard (not the `as string` assertion) so the type checker is satisfied
    // without relying on JSON.parse(null) throwing into the catch below — but
    // the try/catch itself stays wrapped around BOTH the read and the parse,
    // unlike the brief's own inline guard example, which would have dropped
    // it and let a malformed cached JSON string throw uncaught instead of
    // returning null (a real behavior regression this file's zero-behavior-
    // change discipline forbids).
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function actor(): string {
    const u = currentUser();
    return u ? u.username : 'system';
  }

  function isAdmin(): boolean {
    const u = currentUser();
    // Prefer the reconciled is_admin flag (set by refresh() from GET /security/me,
    // which mirrors the backend's require_admin grace) and fall back to the role
    // cached at login for sessions that predate a refresh.
    return !!u && (u.is_admin === true || u.role === 'admin');
  }

  // null = unrestricted (every plant); array = the caller's role_plants scope.
  // Mirrors isAdmin()'s fallback posture: trusts whatever was last cached
  // (login or refresh()) rather than blocking on a fresh network call.
  function allowedPlants(): string[] | null {
    const u = currentUser();
    return u && Array.isArray(u.allowed_plants) ? u.allowed_plants : null;
  }

  // Every page is on by default except Admin Cockpit. Must mirror
  // master_data.py's PAGE_ACCESS_KEYS / set_role_page_access default posture
  // and the Security > Roles tab's own copy in plant-and-administration.mts —
  // keep all three in sync.
  const DEFAULT_PAGE_ACCESS: Record<TopLevelTab, boolean> = {
    home: true, gantt: true, labor: true, masterdata: true, admin: false,
  };

  // Per-role top-level page visibility. Admins always pass (super-admin escape
  // hatch, same posture as isAdmin() itself) — this is UI-visibility gating
  // only, not endpoint-level enforcement (see brain.py's admin route note).
  // Deliberately reads ONLY role_settings (never the per-user settings
  // override) — unlike theme/lang, page access is a role-level control, not a
  // user preference. auth.get_role_settings() always returns {} for the
  // 'admin' role itself, so an admin-role user's own role_settings.pages is
  // never consulted — irrelevant here since isAdmin() already short-circuits.
  function canAccessTab(tab: TopLevelTab): boolean {
    if (isAdmin()) return true;
    const u = currentUser();
    const pages = (u?.role_settings?.pages ?? null) as Partial<Record<TopLevelTab, boolean>> | null;
    const override = pages?.[tab];
    return override ?? DEFAULT_PAGE_ACCESS[tab];
  }

  async function signIn(username: string, password: string): Promise<SessionUserBlob> {
    const res = await fetch(`${Config.API_BASE}/security/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.detail || 'Invalid username or password');
    }
    const data = await res.json() as SessionUserBlob;
    // Per-user settings + role defaults are the authoritative DB blobs; the
    // login response may not carry them (only GET /security/me is guaranteed to),
    // so default to {} and let refresh() fill them from /security/me at boot.
    const settings = data.settings || {};
    const roleSettings = data.role_settings || {};
    localStorage.setItem(KEY, JSON.stringify({
      username: data.username, role: data.role,
      allowed_plants: data.allowed_plants ?? null,
      first_name: data.first_name || null, last_name: data.last_name || null,
      settings, role_settings: roleSettings,
      loggedInAt: Date.now(),
    }));
    Store.setUserSettings(settings, 'session-signin');
    Store.setRoleDefaults(roleSettings, 'session-signin');
    Store.emit({ type: 'session:changed', kind: 'signin' });
    return data;
  }

  function signOut() {
    localStorage.removeItem(KEY);
    Store.emit({ type: 'session:changed', kind: 'signout' });
    location.reload();
  }

  // 12-hour local cache lifetime, checked ONLY at the boot gate (app.js
  // _domReadyGate) — not a live in-tab timer, so a tab left open past 12h
  // keeps working until its next reload. A missing/non-numeric loggedInAt
  // (a session cached before this field existed, or a corrupted blob) counts
  // as expired rather than never-expiring — Date.now() - undefined is NaN,
  // and NaN > threshold is false, so this must be checked explicitly rather
  // than folded into the arithmetic comparison alone.
  function isExpired(): boolean {
    const u = currentUser();
    if (!u) return false;   // no session cached — not "expired", just signed out
    if (typeof u.loggedInAt !== 'number') return true;
    return Date.now() - u.loggedInAt > Config.SESSION_MAX_AGE_MS;
  }

  // Clears a stale/expired cached session pre-boot. Deliberately NOT signOut():
  // no event emit, no reload — the boot gate calls this once, synchronously,
  // before _domReadyGate falls through to the same showLoginScreen() path an
  // ordinary "not logged in" state already uses.
  function clearExpired(): void {
    localStorage.removeItem(KEY);
  }

  // Reconcile the role cached at login (which the admin UI gates on) against the
  // backend's LIVE view via GET /security/me. The cached role can go stale — a DB
  // reseed, a role change, or a since-deleted identity — leaving the UI offering
  // admin controls that every request then 403s. Fire-and-forget at boot; also
  // called after a denied admin action. Never clobbers the cache on a transient
  // network/HTTP error (only a definitive answer updates it).
  async function refresh(): Promise<SessionUserBlob | null> {
    const u = currentUser();
    if (!u) return null;                       // signed out — nothing to reconcile
    try {
      // Cache-busted like /tasks (see DEPLOYMENT.md) — this URL never varies,
      // and the corp proxy caches GET responses keyed on URL regardless of
      // normal cache semantics, so an uncached fetch here would keep re-adopting
      // whatever settings blob was first ever fetched instead of DB truth.
      const r = await Util.fetchTraced(
        `${Config.API_BASE}/security/me?_cb=${Date.now()}`,
        { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } }
      );
      if (!r.ok) return null;
      const me = await r.json() as SessionUserBlob;
      // GET /security/me now carries the caller's own settings blob + their role's
      // defaults; cache both (localStorage = cache of DB truth so the app boots
      // offline from the cached blob) and push them into Store for Store.pref().
      const settings = me.settings || {};
      const roleSettings = me.role_settings || {};
      localStorage.setItem(KEY, JSON.stringify({
        username: me.username || u.username,
        role: me.role || null,
        is_admin: !!me.is_admin,
        allowed_plants: me.allowed_plants ?? null,
        first_name: me.first_name || null,
        last_name: me.last_name || null,
        settings, role_settings: roleSettings,
        loggedInAt: u.loggedInAt, // carried forward, never reset — the 12h clock is anchored to signIn()
      }));
      Store.setUserSettings(settings, 'session-refresh');
      Store.setRoleDefaults(roleSettings, 'session-refresh');
      // Plant-scope enforcement is Store-only business logic — safe to keep in
      // this pure module. The actual PlantSelector DOM refresh/toast, and the
      // admin-tab eviction (App._currentTab is DOM/UI state this module must
      // never read), happen in SessionUIAdapter's session:changed subscriber
      // (app.js) instead — this just reports the fact via the emitted event.
      let plantAccessChanged = false;
      const allowed = allowedPlants();
      if (allowed && Store.selectedPlant && !allowed.includes(Store.selectedPlant)) {
        Store.setSelectedPlant(null, 'session-refresh');
        plantAccessChanged = true;
      }
      Store.emit({ type: 'session:changed', kind: 'refresh', plantAccessChanged });
      return me;
    } catch { return null; }
  }

  // A backend admin gate returned 403 though the UI believed we were an admin —
  // the cached role is stale. Reconcile (which hides admin UI / navigates off the
  // Admin tab if we were demoted, via SessionUIAdapter's session:changed
  // subscriber) and tell the user plainly, rather than leaving a dead-end
  // "HTTP 403" in the panel.
  function onAuthDenied(): void {
    refresh();
    try { Toast.show(Util.t('sec.access_revoked'), 'error'); } catch {}
  }

  /* ── Self-service preference writes (Personalization / Workflow) ─────────
     setPref(key, value) is OPTIMISTIC (mirrors _savePlantHorizon's write-then-
     revert shape): Store.userSettings updates immediately so the UI reflects the
     change, then a debounced PATCH /security/me/settings persists it. On success
     we adopt the server's full merged blob and mirror it to the nimbus.session
     cache; on failure we revert only this batch's keys in Store AND the cache and
     Toast an i18n error. Multiple rapid setPref calls coalesce into one PATCH. */
  let _prefTimer: ReturnType<typeof setTimeout> | null = null;
  let _prefPending: Record<string, unknown> = {};   // key → queued new value for the next PATCH
  let _prefPrev: Record<string, unknown>    = {};   // key → pre-edit value, for revert on failure

  async function _flushPrefs(): Promise<void> {
    _prefTimer = null;
    const patch = _prefPending; _prefPending = {};
    const prev  = _prefPrev;    _prefPrev = {};
    if (!Object.keys(patch).length) return;
    try {
      const r = await Util.fetchTraced(`${Config.API_BASE}/security/me/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: patch }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || `HTTP ${r.status}`); }
      const updated = await r.json() as { settings?: Record<string, unknown> };
      // Server returns the full merged blob — adopt it as truth + mirror to cache.
      const settings = updated.settings || {};
      Store.setUserSettings(settings, 'settings-pref');
      const u = currentUser();
      if (u) localStorage.setItem(KEY, JSON.stringify({ ...u, settings }));
    } catch (e) {
      // Revert only the keys this failed batch touched — in Store and the cache —
      // leaving keys a still-pending batch owns untouched.
      Store.setUserSettings(prev, 'settings-pref-revert');
      const u = currentUser();
      if (u) {
        const cached: Record<string, unknown> = (u.settings && typeof u.settings === 'object') ? { ...u.settings } : {};
        for (const k of Object.keys(prev)) {
          if (prev[k] === undefined) delete cached[k]; else cached[k] = prev[k];
        }
        localStorage.setItem(KEY, JSON.stringify({ ...u, settings: cached }));
      }
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('settings', `Save preference failed: ${(e as Error).message}`);
    }
  }

  function setPref(key: string, value: unknown): void {
    // Capture the pre-edit value once per batch (first writer wins) so a revert
    // restores the value from before this batch, not an intermediate optimistic one.
    if (!(key in _prefPrev)) _prefPrev[key] = Store.userSettings[key];
    _prefPending[key] = value;
    Store.setUserSettings({ [key]: value }, 'settings-pref');   // optimistic
    if (_prefTimer) clearTimeout(_prefTimer);
    _prefTimer = setTimeout(_flushPrefs, 600);
  }

  // Flush any pending pref writes immediately and return the PATCH promise. The
  // language switch must await this BEFORE location.reload() — a reload cancels
  // the debounced timer and in-flight fetch, so without an explicit flush the DB
  // (and the session cache _flushPrefs refreshes on success) would never catch up
  // and the next boot would revert the language from stale truth.
  function flushPrefs(): Promise<void> {
    if (_prefTimer) { clearTimeout(_prefTimer); _prefTimer = null; }
    return _flushPrefs();
  }

  // Convenience read — resolves via Store.pref (user ?? role ?? system default).
  function pref(key: string): unknown { return Store.pref(key); }

  // Merge `patch` into the cached session blob and persist it. The narrow seam
  // app.js's SessionUIAdapter.saveProfile() uses to update first_name/last_name
  // in the cache after a successful PATCH /security/me, without reaching into
  // this module's private `KEY` constant — SessionUIAdapter is a consumer of
  // Session's public API only, same direction every other *UIAdapter follows.
  function updateCachedUser(patch: Partial<CachedSessionUser>): CachedSessionUser | null {
    const u = currentUser();
    if (!u) return null;
    const merged = { ...u, ...patch } as CachedSessionUser;
    localStorage.setItem(KEY, JSON.stringify(merged));
    return merged;
  }

  return {
    currentUser, actor, isAdmin, allowedPlants, canAccessTab, DEFAULT_PAGE_ACCESS,
    signIn, signOut, refresh, onAuthDenied,
    setPref, flushPrefs, pref, updateCachedUser,
    isExpired, clearExpired,
  };
})();
