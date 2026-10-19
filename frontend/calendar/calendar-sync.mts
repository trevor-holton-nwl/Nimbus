// calendar/calendar-sync.mjs — CalendarSync (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split schedule-data.mts
// (2,204 lines) into 3 domain files). Backend-authoritative persistence of
// per-plant/per-line working hours + blackout blocks. Must NEVER import from
// optimization/engine.mjs, calendar/calendar-engine.mjs, or
// insights/services.mjs — only the reverse direction is allowed (same rule
// as scheduling/persistence.mjs — see its header comment).
//
// `Persistence` (scheduling/persistence.mjs) is a real cross-file import
// forming a two-way ESM cycle with that module — this file's flush path
// (`_flushLineHours`/`_flushPlantHours`) calls back into
// `Persistence._dirtyIds`/`_forceIds`/`_saveCache`
// so a flush can fold into the SAME dirty/force bookkeeping an in-flight manual
// edit already established, rather than silently reverting it. Safe under
// the same rule used throughout this split: every cross-reference is inside
// a method body invoked after both modules finish loading, never at
// top-level evaluation. This dependency predates this phase (it existed
// between two sibling consts in the single-file module) — the split only
// turns it into a real ESM cycle.
import { Config, Util, ErrorLog, Toast } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import { Sandbox } from '../optimization/sandbox.mjs';
import { Persistence } from '../scheduling/persistence.mjs';
import type { NimbusBlock, NimbusPlantBlock, WorkHours, IsoUtcTs, PlantPeriod } from '../platform/types.mjs';

/** Wire shape of one dated plant period (snake_case); the Store shape is `PlantPeriod`. */
interface PlantPeriodWire { id: string; name: string; valid_from: string; valid_to: string | null; work_hours: WorkHours }

/** Reserved `_hoursEdits` key for the plant's period list; it cannot collide with a machine code. */
const PERIODS_KEY = '#periods';
const PERIODS_PATH = '/plant-calendar/plant-periods';

/** GET /plant-calendar (brain.py) response envelope. */
interface PlantCalendarConfig {
  plant_periods?: PlantPeriodWire[];
  plant_work_hours?: WorkHours;
  line_work_hours?: Record<string, WorkHours>;
  machine_blackouts?: Array<{ id: string; machine: string | null; start: IsoUtcTs; end: IsoUtcTs; reason: string }>;
  plant_blackouts?: Array<{ id: string; start: IsoUtcTs; end: IsoUtcTs; reason: string }>;
}

/** Return shape shared by every CalendarSync write helper (`_post` and its
 *  callers). `skipped` marks the two guarded no-op paths (`_hydrating` /
 *  `Sandbox.active`) — additive vs. the bare `{ ok; status?; error? }` shape
 *  named in this phase's plan, since the existing early-return literal
 *  `{ ok: true, skipped: true }` needs it and this file's zero-behavior-change
 *  discipline forbids dropping that field to fit a narrower type. */
interface HoursEdit { revision: number; pending: boolean }
interface HoursReadGuard { revision: number; pending: Set<string> }

interface CalendarSyncResult {
  ok: boolean;
  status?: number;
  error?: string;
  skipped?: boolean;
  /** Structured server refusal (plant-periods writes): `detail.code`, e.g. `period_overlap`. */
  code?: string;
  ids?: string[];
  message?: string;
}

/* Blackout deletes that the server never confirmed, per plant. A delete is idempotent, so
   it is safe to re-send on the next load; without this, the backend list re-hydrated on
   the next load resurrects a blackout the planner had already removed. Hours/upsert edits
   are NOT auto-replayed (a stale replay could overwrite a newer edit by another admin);
   those get an honest toast with a manual Retry instead. */
const PENDING_DELETES_KEY = 'nimbus.calendar.pendingDeletes';
type PendingDeletes = Record<string, { line: string[]; plant: string[] }>;

function _readPendingDeletes(): PendingDeletes {
  try {
    const raw = localStorage.getItem(PENDING_DELETES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as PendingDeletes : {};
  } catch { return {}; }
}

function _writePendingDeletes(pending: PendingDeletes): void {
  try {
    if (Object.keys(pending).length) localStorage.setItem(PENDING_DELETES_KEY, JSON.stringify(pending));
    else localStorage.removeItem(PENDING_DELETES_KEY);
  } catch { /* private window / storage blocked: the toast still tells the planner */ }
}

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
  // Per-plant keys are machine names; the empty key represents plant-wide hours.
  // Successful revisions remain so GETs already in flight cannot reinstall an older snapshot.
  _hoursRevision: 0,
  _hoursEdits: {} as Record<string, Record<string, HoursEdit>>,
  _pendingLineHours: {} as Record<string, Record<string, WorkHours | null>>,   // plant → { line → workHours|null } awaiting a batched flush (null = reset to follow the plant)
  _whDebounce: {} as Record<string, ReturnType<typeof setTimeout>>,         // plant → timeout id
  _lineHoursWait: {} as Record<string, () => void>,
  _deferredHydrationPlant: null as string | null,  // plant whose config GET resolved mid-What-If (re-hydrate on exit)
  /** Per plant: has the SERVER's calendar landed in Store? `pending` until the first GET resolves, `hydrated`
   *  once `_applyConfig` has run, `failed` when the GET failed and nothing from the server is on hand. `lines`
   *  are the lines the server holds an hours row for (the client default is never a server row). The
   *  backward-scheduling reconcile derives starts only from a hydrated plant (OQ51): a derive-and-save on the
   *  client's default 07:00-19:00 would be written to the server as truth. */
  _hydration: {} as Record<string, { state: 'hydrated' | 'pending' | 'failed'; lines: Set<string> }>,

  /** Where the plant's calendar stands: `'hydrated'` (the server's rows are in Store), `'pending'` (not fetched
   *  yet, or in flight) or `'failed'` (the fetch failed and no earlier server copy is on hand). */
  calendarState(plant: string | null | undefined): 'hydrated' | 'pending' | 'failed' {
    return (plant && this._hydration[plant]?.state) || 'pending';
  },

  /** True when the server returned its own hours row for `line` in `plant` (OQ62). A line riding on the client's
   *  default calendar has no server row and is not derived. */
  hasServerLineCalendar(plant: string | null | undefined, line: string): boolean {
    return !!plant && this._hydration[plant]?.state === 'hydrated' && this._hydration[plant].lines.has(line);
  },

  /** Record a plant's hydration state (the fetch path, and tests that stand in for it). `lines` replaces the
   *  server line set only when given. */
  _setHydration(plant: string, state: 'hydrated' | 'pending' | 'failed', lines?: Iterable<string>): void {
    const prior = this._hydration[plant];
    this._hydration[plant] = { state, lines: lines ? new Set(lines) : (prior?.lines ?? new Set<string>()) };
  },

  /** A successful line-hours POST made these lines server rows (R-I7): add them to the hydration's server-line
   *  set so `hasServerLineCalendar` is true and the reconcile unblocks without a reload. A null write cleared the
   *  row (the machine follows the plant again), so it leaves the set instead. Emits `calendar:change` only when
   *  the set changed. A skipped POST (hydrating / Sandbox) wrote nothing and changes nothing. */
  _noteServerLines(plant: string, lines: ReadonlyArray<{ machine: string; work_hours: WorkHours | null }>, result: CalendarSyncResult): CalendarSyncResult {
    const entry = this._hydration[plant];
    if (!result?.ok || result.skipped || !entry) return result;
    let changed = false;
    for (const { machine, work_hours } of lines) {
      if (work_hours) {
        if (!entry.lines.has(machine)) { entry.lines.add(machine); changed = true; }
      } else if (entry.lines.delete(machine)) changed = true;
    }
    if (changed) Store.emit({ type: 'calendar:change', source: 'calendar-sync', plant });
    return result;
  },

  /* ----- load / hydration ----------------------------------------------- */
  fetchPlantConfig(plant: string | null): Promise<void> {
    if (!plant) return Promise.resolve();
    // Ensure the line→plant index is current before _applyConfig so getPlantForLine
    // resolves reliably even when the master-data fetch REJECTED (the .finally still
    // runs us). Otherwise the migration/clear filters misfire on a stale/empty index. (F4)
    Store.rebuildPlantIndex();
    const hoursRead = this._captureHoursRead(plant);
    // A plant that was never hydrated is `pending` while the GET is in flight; one that already holds a server
    // copy keeps it (a refetch that fails must not un-know what the server told us earlier).
    if (this._hydration[plant]?.state !== 'hydrated') this._setHydration(plant, 'pending');
    return Util.fetchTraced(`${Config.API_BASE}/plant-calendar?plant=${encodeURIComponent(plant)}`,
                            { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() as Promise<PlantCalendarConfig> : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(cfg => CalendarSync._replayPendingDeletes(plant).then(() => CalendarSync._withoutPendingDeletes(plant, cfg)))
      .then(cfg => CalendarSync._applyConfig(plant, cfg, hoursRead))
      .catch(e => {
        // The localStorage restore already painted the UI — degrade gracefully.
        ErrorLog.warn('calendar-sync', `Fetch plant-calendar failed for ${plant}: ${e.message}`);
        if (CalendarSync._hydration[plant]?.state !== 'hydrated') CalendarSync._setHydration(plant, 'failed');
        Toast.show(Util.t('toast.calendar_offline_cache'), 'info');
      });
  },

  /** Record (add=true) or clear (add=false) blackout ids whose server delete is unconfirmed. */
  _trackPendingDeletes(plant: string, kind: 'line' | 'plant', ids: ReadonlyArray<string>, add: boolean): void {
    if (!plant || !ids.length) return;
    const pending = _readPendingDeletes();
    const entry = pending[plant] ||= { line: [], plant: [] };
    const set = new Set(entry[kind] || []);
    for (const id of ids) { if (add) set.add(id); else set.delete(id); }
    entry[kind] = [...set];
    if (!(entry.line || []).length && !(entry.plant || []).length) delete pending[plant];
    _writePendingDeletes(pending);
  },

  /** Re-send this plant's unconfirmed deletes BEFORE the backend list is applied. */
  _replayPendingDeletes(plant: string): Promise<void> {
    const entry = _readPendingDeletes()[plant];
    if (!entry || (typeof Sandbox !== 'undefined' && Sandbox.active)) return Promise.resolve();
    const jobs: Array<Promise<void>> = [];
    for (const [kind, path] of [['line', '/plant-calendar/line-blackouts'], ['plant', '/plant-calendar/plant-blackouts']] as const) {
      const ids = entry[kind] || [];
      if (!ids.length) continue;
      jobs.push(Util.fetchTraced(`${Config.API_BASE}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plant, deletes: ids }), signal: AbortSignal.timeout(8000),
      }).then(r => {
        // 404 = already gone (the delete is idempotent). A permanent 4xx (403/409) will never
        // succeed on replay: drop the ids with a one-time warning rather than hiding the
        // blackout locally forever. Transient failures (5xx/network) stay pending.
        if (r.ok || r.status === 404) { CalendarSync._trackPendingDeletes(plant, kind, ids, false); return; }
        if (r.status === 403 || r.status === 409) {
          CalendarSync._trackPendingDeletes(plant, kind, ids, false);
          Toast.show(Util.t('toast.calendar_delete_dropped'), 'warn', 10000);
        }
      })
        .catch(e => ErrorLog.warn('calendar-sync', `Replay of pending ${kind} blackout deletes failed: ${(e as Error).message}`)));
    }
    return Promise.all(jobs).then(() => undefined);
  },

  /** Drop still-pending (replay failed) ids from a fetched config so they stay deleted locally. */
  _withoutPendingDeletes(plant: string, cfg: PlantCalendarConfig): PlantCalendarConfig {
    const entry = _readPendingDeletes()[plant];
    if (!entry || !cfg) return cfg;
    const lineGone = new Set(entry.line || []), plantGone = new Set(entry.plant || []);
    return {
      ...cfg,
      machine_blackouts: cfg.machine_blackouts?.filter(b => !lineGone.has(b.id)),
      plant_blackouts: cfg.plant_blackouts?.filter(b => !plantGone.has(b.id)),
    };
  },

  _markHoursEdit(plant: string, line: string): HoursEdit {
    const edit = { revision: ++this._hoursRevision, pending: true };
    (this._hoursEdits[plant] ||= {})[line] = edit;
    return edit;
  },

  _captureHoursRead(plant: string): HoursReadGuard {
    return { revision: this._hoursRevision,
      pending: new Set(Object.entries(this._hoursEdits[plant] || {}).filter(([, edit]) => edit.pending).map(([line]) => line)) };
  },

  _protectHours(plant: string, line: string, read: HoursReadGuard): boolean {
    const edit = this._hoursEdits[plant]?.[line];
    return read.pending.has(line) || !!edit && (edit.pending || edit.revision > read.revision);
  },

  _applyConfig(plant: string, cfg: PlantCalendarConfig, hoursRead: HoursReadGuard = CalendarSync._captureHoursRead(plant)): void {
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
      lineBlackouts:  (cfg.machine_blackouts || []).length > 0,
      plantBlackouts: (cfg.plant_blackouts || []).length > 0,
    };
    // A missing blackout slice is the migration path for older local caches.
    // Remove legacy global state before emitting or migrating it: those blocks
    // must never be fanned out or re-posted as copies for every plant.
    if (!has.lineBlackouts)  CalendarSync._discardLegacyGlobalLineBlocks();
    if (!has.plantBlackouts) CalendarSync._discardLegacyGlobalPlantBlocks();
    this._hydrating = true;
    try {
      if (has.plantHours && !this._protectHours(plant, '', hoursRead)) {
        Store.ensurePlant(plant);
        Store.plants[plant].workHours = cfg.plant_work_hours!;
      }
      // Server truth for every line of this plant, whether or not the server returned any row: a line with a row
      // holds its own hours, every other line follows the plant (a stale pinned local copy is dropped even when
      // the server returned `{}`). An edit still in flight (_protectHours) is left alone.
      const backendRows = cfg.line_work_hours || {};
      for (const line of Object.keys(Store.calendars)) {
        if ((line in backendRows || Store.getPlantForLine(line) === plant)
            && !this._protectHours(plant, line, hoursRead)) Store.inheritPlantHours(line);
      }
      for (const [line, wh] of Object.entries(backendRows)) {
        if (this._protectHours(plant, line, hoursRead)) continue;
        Store.ensureCalendar(line);
        Store.calendars[line].workHours = wh;
        Store.calendars[line].inherited = false;
      }
      if (has.lineBlackouts) {
        // Clear by the block's OWN stored plant (never a runtime getPlantForLine
        // derivation, which can be null before master data loads). Preserve backend ids.
        // In-place filter (no reference reassignment) so Store.blocks' identity is stable.
        const keptBlocks = Store.blocks.filter(b => b.plant !== plant);
        Store.blocks.length = 0;
        Store.blocks.push(...keptBlocks);
        for (const b of cfg.machine_blackouts!) {
          Store.blocks.push({ id: b.id, line: b.machine || null, plant,
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
      // Dated periods: `undefined` (an older backend) leaves local periods alone; `[]` clears them. Applied before
      // the emits so a subscriber sees them; a period write still in flight (or newer than this read) is protected.
      if (cfg.plant_periods !== undefined && !this._protectHours(plant, PERIODS_KEY, hoursRead)) {
        Store.ensurePlant(plant);
        const periods = cfg.plant_periods.map(w => this._periodFromWire(w))
          .sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
        if (periods.length) Store.plants[plant].periods = periods;
        else delete Store.plants[plant].periods;
      }
      // The server's calendar is now in Store: mark it before the emits below, because the backward-scheduling
      // reconcile subscribes to `calendar:change` and asks `calendarState` synchronously.
      this._setHydration(plant, 'hydrated', Object.keys(cfg.line_work_hours || {}));
      // Notify subscribers + refresh the offline cache with backend truth. These
      // emits fire while _hydrating=true, so no POST-back to the backend.
      Store.emit({ type: 'calendar:change',    source: 'calendar-sync', plant });
      Store.emit({ type: 'blocks:change',      source: 'calendar-sync', plant });
      Store.emit({ type: 'plantBlocks:change', source: 'calendar-sync', plant });
    } finally {
      this._hydrating = false;
    }
    // (There is no post-hydration re-snap any more: backend-authoritative hours landing does not move any
    // bar. Task 2.6's reconcile derives never-placed rows once the calendar state is known.)
    // Migrate the slices the backend still lacks but local has. Covers first upgrade
    // (backend fully empty) AND partial-migration retry. Each slice is one atomic POST
    // (all-or-nothing); a failed slice stays un-migrated and retries next load.
    // Idempotent via client-supplied ids + ON CONFLICT, so re-sending is harmless.
    this._migrateMissingSlices(plant, has);
  },

  _migrateMissingSlices(plant: string, has: { plantHours: boolean; lineHours: boolean; lineBlackouts: boolean; plantBlackouts: boolean }): void {
    if (!plant) return;
    const jobs: Array<Promise<{ ok: boolean; status?: number; error?: string }>> = [];
    if (!has.plantHours && !this._hoursEdits[plant]?.['']?.pending) {
      const wh = Store.plants[plant]?.workHours || null;
      // Don't migrate the auto-seeded DEFAULT_SHIFT — a missing backend row means
      // "no override", which the client already reproduces from the seed. Migrating it
      // would freeze today's default and hide a future DEFAULT_SHIFT policy change. (F11)
      if (wh && !CalendarSync._isDefaultWorkHours(wh)) jobs.push(this.savePlantHours(plant, wh));
    }
    if (!has.lineHours) {
      const lines = Object.keys(Store.calendars)
        .filter(l => Store.getPlantForLine(l) === plant
                  && !Store.calendars[l].inherited                         // an inherited line has no hours of its own to migrate
                  && !this._hoursEdits[plant]?.[l]?.pending
                  && !CalendarSync._isDefaultWorkHours(Store.calendars[l].workHours))  // F11
        .map(l => ({ machine: l, work_hours: Store.calendars[l].workHours as WorkHours | null }));
      if (lines.length) {
        jobs.push(this._post('/plant-calendar/line-hours', { plant, lines }, 'migrate-line-hours')
          .then(r => this._noteServerLines(plant, lines, r)));
      }
    }
    if (!has.lineBlackouts) {
      // Migrate this plant's own blocks: already-stamped for it, or line-mapped to it.
      const blks = Store.blocks.filter(b =>
        b.plant === plant || (!b.plant && b.line && Store.getPlantForLine(b.line) === plant));
      blks.forEach(b => { b.plant = plant; });
      if (blks.length) jobs.push(this._post('/plant-calendar/line-blackouts', { plant, upserts: blks.map(b => this._blockPayload(b, true)) }, 'migrate-line-blackouts'));
    }
    if (!has.plantBlackouts) {
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

  // Legacy global blackouts were previously replicated as `${id}::${plant}`.
  // The suffix is the old migration's reserved marker, so a matching stored
  // plant is unambiguously a generated copy rather than a current local block.
  _isLegacyFanoutCopy(block: { id?: unknown; plant?: string | null }): boolean {
    const id = typeof block?.id === 'string' ? block.id : '';
    const plant = typeof block?.plant === 'string' ? block.plant : '';
    return !!id && !!plant && id.endsWith(`::${plant}`);
  },

  // Global blackout state is no longer valid. Preserve line-specific legacy
  // blocks so they can still be mapped to their owning plant, but discard
  // unscoped global blocks and their old replicated copies before migration.
  _discardLegacyGlobalLineBlocks(): void {
    const before = Store.blocks.length;
    const keep = Store.blocks.filter(b => {
      if (!b.plant && !b.line) return false;
      if (!b.line && CalendarSync._isLegacyFanoutCopy(b)) return false;
      return true;
    });
    if (keep.length === before) return;
    Store.blocks.length = 0;
    Store.blocks.push(...keep);
    ErrorLog.info('calendar-sync', `Discarded ${before - keep.length} legacy global line blackout(s)`);
  },

  _discardLegacyGlobalPlantBlocks(): void {
    const before = Store.plantBlocks.length;
    const keep = Store.plantBlocks.filter(b => b.plant && !CalendarSync._isLegacyFanoutCopy(b));
    if (keep.length === before) return;
    Store.plantBlocks.length = 0;
    Store.plantBlocks.push(...keep);
    ErrorLog.info('calendar-sync', `Discarded ${before - keep.length} legacy global plant blackout(s)`);
  },

  /* ----- immediate per-edit saves --------------------------------------- */
  savePlantHours(plant: string | null, workHours: WorkHours | undefined): Promise<CalendarSyncResult> {
    if (!plant) return Promise.resolve({ ok: false });
    return this._post('/plant-calendar/plant-hours', { plant, work_hours: workHours }, 'plant-hours');
  },

  /** Replace a plant's dated period list. Pessimistic: Store changes only after the server acknowledges
   *  (What-If and hydration are local-only, promoted later by `flushPlant`). A local validation failure or a
   *  server refusal returns `{ ok: false, code, ids }` with Store untouched; the caller renders the message. */
  async savePlantPeriods(plant: string | null, next: PlantPeriod[]): Promise<CalendarSyncResult> {
    if (!plant) return { ok: false };
    const current = new Map(Store.getPlantPeriods(plant).map(p => [p.id, p] as const));
    const nextIds = new Set(next.map(p => p.id));
    const upserts = next.filter(p => { const c = current.get(p.id); return !c || !this._samePeriod(c, p); }).map(p => this._periodPayload(p));
    const deletes = [...current.keys()].filter(id => !nextIds.has(id));
    // A pure delete is not validated locally: pre-existing overlapping data (written outside the UI) must not
    // block removing a period; the server only checks pairs involving an upserted id.
    if (upserts.length) {
      const verdict = globalThis.NimbusComputeCore!.validatePlantPeriods(next);
      if (!verdict.ok) return { ok: false, code: verdict.code, ids: verdict.ids };
    }
    if (!upserts.length && !deletes.length) return { ok: true };
    if (this._hydrating || Sandbox.active) {
      Store.setPlantPeriods(plant, next, 'plant-periods');
      return { ok: true, skipped: true };
    }
    const res = await this._post(PERIODS_PATH, { plant, upserts, deletes }, 'plant-periods');
    if (res.ok) {
      Store.setPlantPeriods(plant, next, 'plant-periods');
      return res;
    }
    // A structured refusal (res.code) is shown by the caller next to the offending rows; anything else is a
    // transport/server failure. No Retry action: a retry would rebuild from a Store that was never updated.
    if (!res.code) Toast.show(Util.t('toast.calendar_save_failed'), 'warn', 10000);
    return res;
  },

  _periodFromWire(w: PlantPeriodWire): PlantPeriod {
    return { id: w.id, name: w.name, validFrom: w.valid_from, validTo: w.valid_to ?? null, workHours: w.work_hours };
  },
  _periodPayload(p: PlantPeriod): PlantPeriodWire {
    return { id: p.id, name: p.name, valid_from: p.validFrom, valid_to: p.validTo, work_hours: p.workHours };
  },
  _samePeriod(a: PlantPeriod, b: PlantPeriod): boolean {
    if (a.name !== b.name || a.validFrom !== b.validFrom || a.validTo !== b.validTo) return false;
    for (let d = 0; d < 7; d++) {
      const x = a.workHours[d] ?? null, y = b.workHours[d] ?? null;
      if (!x || !y) { if (x !== y) return false; continue; }
      if (x[0] !== y[0] || x[1] !== y[1]) return false;
    }
    return true;
  },

  // Enqueue one line's hours (`null` = reset the machine to follow the plant); a per-plant debounce coalesces a
  // burst (Reset all machines) into ONE /line-hours request.
  saveLineHours(plant: string | null, line: string, workHours: WorkHours | null): void {
    if (!plant || !line || this._hydrating || Sandbox.active) return;
    this._markHoursEdit(plant, line);
    (this._pendingLineHours[plant] ||= {})[line] = workHours ? Util.clone(workHours) : null;
    clearTimeout(this._whDebounce[plant]);
    this._whDebounce[plant] = setTimeout(() => this._flushLineHours(plant), 600);
  },
  /** The plant's machines that hold hours of their own (not inherited): what "Reset to plant" clears. */
  overrideLines(plant: string | null): string[] {
    if (!plant) return [];
    return Object.keys(Store.calendars).filter(l => !Store.calendars[l].inherited && Store.getPlantForLine(l) === plant);
  },

  /** Reset machines to follow their plant: each goes back to inherited in Store and a null write is queued
   *  (one batched POST through the saveLineHours debounce; in What-If only Store changes and `flushPlant`
   *  promotes it). Emits one `calendar:change`. */
  resetLinesToPlant(plant: string, lines: ReadonlyArray<string>): void {
    if (!plant || !lines.length) return;
    for (const line of lines) {
      Store.inheritPlantHours(line);
      this.saveLineHours(plant, line, null);
    }
    Store.emit({ type: 'calendar:change', source: 'calendar-reset', plant });
  },

  _flushLineHours(plant: string): Promise<CalendarSyncResult> | undefined {
    const pending = this._pendingLineHours[plant];
    if (!pending || !Object.keys(pending).length) return;
    // Live edits queued before entering What-If must survive a timer that fires
    // inside it. Discard resumes that live batch; promotion flushes current state.
    if (Sandbox.active) {
      this._lineHoursWait[plant] ||= Store.subscribe(event => {
        if (event.type !== 'sandbox:exited') return;
        this._lineHoursWait[plant]?.();
        delete this._lineHoursWait[plant];
        if (event.applied && this._pendingLineHours[plant]) {
          this._pendingLineHours[plant] = Object.fromEntries(Object.keys(this._pendingLineHours[plant])
            .filter(line => Store.calendars[line])
            .map(line => [line, Store.calendars[line].inherited ? null : Util.clone(Store.calendars[line].workHours)]));
        }
        void this._flushLineHours(plant);
      });
      return;
    }
    this._clearLineHoursQueue(plant);
    const lines = Object.entries(pending).map(([machine, work_hours]) => ({ machine, work_hours }));
    return this._post('/plant-calendar/line-hours', { plant, lines }, 'line-hours')
      .then(r => this._noteServerLines(plant, lines, r))
      .then(r => {
        // A failed reset (null write) leaves Store showing "follows the plant" while the server row survives:
        // release the lines' in-flight guard and re-read the server so the UI shows the truth (the Retry toast stays).
        const nulls = lines.filter(l => l.work_hours === null);
        if (!r.ok && nulls.length) {
          for (const { machine } of nulls) {
            const edit = this._hoursEdits[plant]?.[machine];
            if (edit) edit.pending = false;
          }
          void this.fetchPlantConfig(plant);
        }
        return r;
      });
  },

  _clearLineHoursQueue(plant: string): void {
    clearTimeout(this._whDebounce[plant]);
    delete this._whDebounce[plant];
    delete this._pendingLineHours[plant];
    this._lineHoursWait[plant]?.();
    delete this._lineHoursWait[plant];
  },

  saveLineBlackoutUpsert(block: NimbusBlock): Promise<CalendarSyncResult> {
    if (!block?.plant) return Promise.resolve({ ok: false });
    if (this._hydrating || Sandbox.active) return Promise.resolve({ ok: true, skipped: true });
    this._trackPendingDeletes(block.plant, 'line', [block.id], false); // a re-created id must not be replayed as a delete
    return this._post('/plant-calendar/line-blackouts', { plant: block.plant, upserts: [this._blockPayload(block, true)] }, 'line-blackout-upsert');
  },
  saveLineBlackoutDelete(plant: string | null, id: string): Promise<CalendarSyncResult> {
    if (!plant || !id) return Promise.resolve({ ok: false });
    return this._trackedDelete(plant, 'line', [id], '/plant-calendar/line-blackouts', { plant, deletes: [id] }, 'line-blackout-delete');
  },
  savePlantBlackoutUpsert(block: NimbusPlantBlock): Promise<CalendarSyncResult> {
    if (!block?.plant) return Promise.resolve({ ok: false });
    if (this._hydrating || Sandbox.active) return Promise.resolve({ ok: true, skipped: true });
    this._trackPendingDeletes(block.plant, 'plant', [block.id], false);
    return this._post('/plant-calendar/plant-blackouts', { plant: block.plant, upserts: [this._blockPayload(block, false)] }, 'plant-blackout-upsert');
  },
  savePlantBlackoutDelete(plant: string | null, id: string): Promise<CalendarSyncResult> {
    if (!plant || !id) return Promise.resolve({ ok: false });
    return this._trackedDelete(plant, 'plant', [id], '/plant-calendar/plant-blackouts', { plant, deletes: [id] }, 'plant-blackout-delete');
  },

  /** Promote path (What-If → live): push the plant's current calendar/blackout state
   *  as upserts, PLUS the blackout ids deleted during the What-If session as explicit
   *  deletes. `removed` = { line:[ids], plant:[ids] } is computed by Sandbox.exit while
   *  the pre-sandbox snapshot is still alive (it is nulled before flush). Without the
   *  deletes, a blackout removed in What-If would resurrect from the backend on the next
   *  hydration. (F3) */
  flushPlant(
    plant: string,
    removed?: { line: string[]; plant: string[]; periods?: string[] },
    capturedLinePlants?: ReadonlyMap<string, string | null>,
  ): void {
    if (!plant || this._hydrating || Sandbox.active) return;
    // A pre-scenario debounce must never overwrite the newly promoted state.
    this._clearLineHoursQueue(plant);
    removed = removed || { line: [], plant: [] };
    this.savePlantHours(plant, Store.plants[plant]?.workHours);
    const lineOwner = (line: string): string | null =>
      Store.getPlantForLine(line) || capturedLinePlants?.get(line) || null;
    // An override goes as its hours. An inherited line goes as null (clearing the row) only when the server
    // had one (a What-If reset of a pinned machine); an inherited line with no row has nothing to send.
    const lines = Object.keys(Store.calendars)
      .filter(l => lineOwner(l) === plant)
      .flatMap(l => {
        const cal = Store.calendars[l];
        if (!cal.inherited) return [{ machine: l, work_hours: cal.workHours as WorkHours | null }];
        return this.hasServerLineCalendar(plant, l) ? [{ machine: l, work_hours: null as WorkHours | null }] : [];
      });
    if (lines.length) {
      void this._post('/plant-calendar/line-hours', { plant, lines }, 'promote-line-hours')
        .then(r => this._noteServerLines(plant, lines, r));
    }
    const lineBk = Store.blocks.filter(b => b.plant === plant);
    const lineDeletes = removed.line || [];
    if (lineBk.length || lineDeletes.length) {
      this._trackPendingDeletes(plant, 'line', lineBk.map(b => b.id), false);
      this._trackedDelete(plant, 'line', lineDeletes, '/plant-calendar/line-blackouts',
        { plant, upserts: lineBk.map(b => this._blockPayload(b, true)), deletes: lineDeletes }, 'promote-line-blackouts');
    }
    const plantBk = Store.plantBlocks.filter(b => b.plant === plant);
    const plantDeletes = removed.plant || [];
    if (plantBk.length || plantDeletes.length) {
      this._trackPendingDeletes(plant, 'plant', plantBk.map(b => b.id), false);
      this._trackedDelete(plant, 'plant', plantDeletes, '/plant-calendar/plant-blackouts',
        { plant, upserts: plantBk.map(b => this._blockPayload(b, false)), deletes: plantDeletes }, 'promote-plant-blackouts');
    }
    const periods = Store.getPlantPeriods(plant);
    const periodDeletes = removed.periods || [];
    if (periods.length || periodDeletes.length) {
      void this._post(PERIODS_PATH, { plant, upserts: periods.map(p => this._periodPayload(p)), deletes: periodDeletes },
        'promote-plant-periods').then(r => {
        if (r.ok) return;
        // A structured refusal gets its own message; any other code (plant_not_mastered) was already toasted by
        // _post, so only an un-coded failure shows the generic one.
        if (r.code === 'period_overlap') Toast.show(Util.t('toast.period_overlap'), 'warn', 10000);
        else if (r.code === 'period_dates_invalid') Toast.show(Util.t('toast.period_dates_invalid'), 'warn', 10000);
        else if (!r.code) Toast.show(Util.t('toast.calendar_save_failed'), 'warn', 10000);
      });
    }
  },

  /* ----- internals ------------------------------------------------------- */
  _blockPayload(b: NimbusBlock | NimbusPlantBlock, withLine: boolean): { id: string; start: IsoUtcTs | null; end: IsoUtcTs | null; reason: string | null; machine?: string | null } {
    const s = Util.parseDate(b.start), e = Util.parseDate(b.end);
    const o: { id: string; start: IsoUtcTs | null; end: IsoUtcTs | null; reason: string | null; machine?: string | null } =
      { id: b.id, start: s ? s.toISOString() : null, end: e ? e.toISOString() : null, reason: b.reason || null };
    // Outgoing wire key is "machine" (backend's _prepare_blackouts reads
    // b.get("machine")); NimbusBlock's own internal field stays "line" — see
    // types.mts NimbusBlock comment for why the internal name wasn't renamed.
    if (withLine) o.machine = (b as NimbusBlock).line || null;
    return o;
  },

  /** A write that carries deletes: remember the ids as pending until the server confirms. */
  _trackedDelete(plant: string, kind: 'line' | 'plant', ids: ReadonlyArray<string>, path: string,
                 body: Record<string, unknown>, label: string): Promise<CalendarSyncResult> {
    const blocked = this._hydrating || (typeof Sandbox !== 'undefined' && Sandbox.active);
    if (!blocked) this._trackPendingDeletes(plant, kind, ids, true);
    return this._post(path, body, label).then(res => {
      if (res.ok && !blocked) this._trackPendingDeletes(plant, kind, ids, false);
      return res;
    });
  },

  _post(path: string, body: Record<string, unknown>, label: string): Promise<CalendarSyncResult> {
    // Single choke point for every backend write. Two guards: never POST while
    // applying a backend GET (_hydrating), and never leak What-If edits (Sandbox).
    if (this._hydrating || (typeof Sandbox !== 'undefined' && Sandbox.active)) {
      return Promise.resolve({ ok: true, skipped: true });
    }
    const plant = String(body.plant ?? '');
    const isPeriods = path === PERIODS_PATH;
    const hoursEdits = path === '/plant-calendar/plant-hours' ? [this._markHoursEdit(plant, '')]
      : isPeriods ? [this._markHoursEdit(plant, PERIODS_KEY)]
      : path === '/plant-calendar/line-hours'
        ? ((body.lines as Array<{ machine: string }> | undefined) || []).map(line => this._markHoursEdit(plant, line.machine)) : [];
    return Util.fetchTraced(`${Config.API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    }).then(async r => {
      if (!r.ok && isPeriods) {
        // Period writes are pessimistic: the caller owns the message, so no blanket toast and no Retry
        // (a retry would rebuild from a Store that was never updated). A stuck pending flag would block
        // hydration of the plant's periods forever, so it is cleared on every failure.
        for (const edit of hoursEdits) edit.pending = false;
        const payload = await Promise.resolve().then(() => r.json()).catch(() => null) as { detail?: unknown } | null;
        const detail = payload?.detail;
        const d = detail && typeof detail === 'object' ? detail as { code?: string; ids?: string[]; message?: string } : null;
        const code = d?.code;
        if (code === 'plant_not_mastered') Toast.show(Util.t('toast.plant_not_mastered'), 'error', 6000);
        ErrorLog.warn('calendar-sync', `${label} failed: HTTP ${r.status}${code ? ` (${code})` : ''}`);
        return { ok: false, status: r.status, code, ids: d?.ids, message: d?.message ?? (typeof detail === 'string' ? detail : undefined) };
      }
      if (!r.ok) {
        if (r.status === 400 || r.status === 409) Toast.show(Util.t('toast.plant_not_mastered'), 'error', 6000);
        else this._notifyUnsynced(path, body, label);
        ErrorLog.warn('calendar-sync', `${label} failed: HTTP ${r.status}`);
        return { ok: false, status: r.status };
      }
      // Only these sent revisions settle. A newer edit has a different record.
      for (const edit of hoursEdits) edit.pending = false;
      return { ok: true };
    }).catch(e => {
      // The edit is already in Store + localStorage; only backend sync is deferred.
      ErrorLog.warn('calendar-sync', `${label} error: ${e.message}`);
      if (isPeriods) {
        for (const edit of hoursEdits) edit.pending = false;
        return { ok: false, error: e.message };
      }
      this._notifyUnsynced(path, body, label);
      return { ok: false, error: e.message };
    });
  },

  /** Honest failure message. Deletes are retried automatically on the next load of the plant
   *  (see _trackedDelete); anything else (hours, upserts) is NOT replayed automatically, so the
   *  planner gets a Retry action instead of a promise the app does not keep. */
  _notifyUnsynced(path: string, body: Record<string, unknown>, label: string): void {
    const deletesOnly = Array.isArray(body.deletes) && body.deletes.length > 0 && !body.upserts;
    if (deletesOnly) { Toast.show(Util.t('toast.calendar_delete_pending'), 'warn', 8000); return; }
    Toast.show(Util.t('toast.calendar_save_failed'), 'warn', 10000,
      // Rebuild from CURRENT state at click time: the captured body may be stale by then and a
      // blind re-send could overwrite a newer edit (or resurrect a block deleted since).
      { label: Util.t('btn.retry'), run: () => {
        const fresh = this._freshBody(path, body);
        if (fresh) void this._post(path, fresh, label);
      } });
  },

  /** Re-derive a failed write's body from the live Store; null when nothing is left to send. */
  _freshBody(path: string, body: Record<string, unknown>): Record<string, unknown> | null {
    const plant = String(body.plant ?? '');
    if (path === PERIODS_PATH) return null;   // pessimistic writes: nothing to rebuild from (Store was never updated)
    if (path === '/plant-calendar/plant-hours') {
      return { plant, work_hours: Store.plants[plant]?.workHours };
    }
    if (path === '/plant-calendar/line-hours') {
      const names = ((body.lines as Array<{ machine: string }> | undefined) || []).map(l => l.machine);
      const lines = names.filter(m => Store.calendars[m])
        .map(m => ({ machine: m, work_hours: (Store.calendars[m].inherited ? null : Store.calendars[m].workHours) as WorkHours | null }));
      return lines.length ? { plant, lines } : null;
    }
    const isLine = path === '/plant-calendar/line-blackouts';
    if (isLine || path === '/plant-calendar/plant-blackouts') {
      const pool: Array<NimbusBlock | NimbusPlantBlock> = isLine ? Store.blocks : Store.plantBlocks;
      const byId = new Map(pool.map(b => [b.id, b] as const));
      const sentUpserts = ((body.upserts as Array<{ id: string }> | undefined) || []).map(u => u.id);
      const sentDeletes = ((body.deletes as string[] | undefined) || []);
      const upserts = sentUpserts.filter(id => byId.has(id)).map(id => this._blockPayload(byId.get(id)!, isLine));
      const deletes = [...new Set([...sentDeletes, ...sentUpserts.filter(id => !byId.has(id))])].filter(id => !byId.has(id));
      if (!upserts.length && !deletes.length) return null;
      const fresh: Record<string, unknown> = { plant };
      if (upserts.length) fresh.upserts = upserts;
      if (deletes.length) fresh.deletes = deletes;
      return fresh;
    }
    return body;
  },
};

