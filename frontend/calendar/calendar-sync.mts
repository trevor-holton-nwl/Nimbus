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
// `Persistence._dirtyIds`/`_forceIds`/`_snapToWorkingHours`/`_saveCache`/
// `_relayDueDateCorrections` so a re-snap against freshly-authoritative
// hours can fold into the SAME dirty/force bookkeeping an in-flight manual
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
import type { NimbusBlock, NimbusPlantBlock, WorkHours, IsoUtcTs } from '../platform/types.mjs';

/** GET /plant-calendar (brain.py) response envelope. */
interface PlantCalendarConfig {
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
interface CalendarSyncResult {
  ok: boolean;
  status?: number;
  error?: string;
  skipped?: boolean;
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
      .then(cfg => CalendarSync._replayPendingDeletes(plant).then(() => CalendarSync._withoutPendingDeletes(plant, cfg)))
      .then(cfg => CalendarSync._applyConfig(plant, cfg))
      .catch(e => {
        // The localStorage restore already painted the UI — degrade gracefully.
        ErrorLog.warn('calendar-sync', `Fetch plant-calendar failed for ${plant}: ${e.message}`);
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
      }).then(r => { if (r.ok) CalendarSync._trackPendingDeletes(plant, kind, ids, false); })
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
      // Notify subscribers + refresh the offline cache with backend truth. These
      // emits fire while _hydrating=true, so no POST-back to the backend.
      Store.emit({ type: 'calendar:change',    source: 'calendar-sync', plant });
      Store.emit({ type: 'blocks:change',      source: 'calendar-sync', plant });
      Store.emit({ type: 'plantBlocks:change', source: 'calendar-sync', plant });
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
        .map(l => ({ machine: l, work_hours: Store.calendars[l].workHours }));
      if (lines.length) jobs.push(this._post('/plant-calendar/line-hours', { plant, lines }, 'migrate-line-hours'));
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
    const lines = Object.entries(pending).map(([machine, work_hours]) => ({ machine, work_hours }));
    return this._post('/plant-calendar/line-hours', { plant, lines }, 'line-hours');
  },

  saveLineBlackoutUpsert(block: NimbusBlock): Promise<CalendarSyncResult> {
    if (!block?.plant) return Promise.resolve({ ok: false });
    return this._post('/plant-calendar/line-blackouts', { plant: block.plant, upserts: [this._blockPayload(block, true)] }, 'line-blackout-upsert');
  },
  saveLineBlackoutDelete(plant: string | null, id: string): Promise<CalendarSyncResult> {
    if (!plant || !id) return Promise.resolve({ ok: false });
    return this._trackedDelete(plant, 'line', [id], '/plant-calendar/line-blackouts', { plant, deletes: [id] }, 'line-blackout-delete');
  },
  savePlantBlackoutUpsert(block: NimbusPlantBlock): Promise<CalendarSyncResult> {
    if (!block?.plant) return Promise.resolve({ ok: false });
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
    removed?: { line: string[]; plant: string[] },
    capturedLinePlants?: ReadonlyMap<string, string | null>,
  ): void {
    if (!plant) return;
    removed = removed || { line: [], plant: [] };
    this.savePlantHours(plant, Store.plants[plant]?.workHours);
    const lineOwner = (line: string): string | null =>
      Store.getPlantForLine(line) || capturedLinePlants?.get(line) || null;
    const lines = Object.keys(Store.calendars)
      .filter(l => lineOwner(l) === plant)
      .map(l => ({ machine: l, work_hours: Store.calendars[l].workHours }));
    if (lines.length) this._post('/plant-calendar/line-hours', { plant, lines }, 'promote-line-hours');
    const lineBk = Store.blocks.filter(b => b.plant === plant);
    const lineDeletes = removed.line || [];
    if (lineBk.length || lineDeletes.length) {
      this._trackedDelete(plant, 'line', lineDeletes, '/plant-calendar/line-blackouts',
        { plant, upserts: lineBk.map(b => this._blockPayload(b, true)), deletes: lineDeletes }, 'promote-line-blackouts');
    }
    const plantBk = Store.plantBlocks.filter(b => b.plant === plant);
    const plantDeletes = removed.plant || [];
    if (plantBk.length || plantDeletes.length) {
      this._trackedDelete(plant, 'plant', plantDeletes, '/plant-calendar/plant-blackouts',
        { plant, upserts: plantBk.map(b => this._blockPayload(b, false)), deletes: plantDeletes }, 'promote-plant-blackouts');
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
    return Util.fetchTraced(`${Config.API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    }).then(r => {
      if (!r.ok) {
        if (r.status === 400 || r.status === 409) Toast.show(Util.t('toast.plant_not_mastered'), 'error', 6000);
        else this._notifyUnsynced(path, body, label);
        ErrorLog.warn('calendar-sync', `${label} failed: HTTP ${r.status}`);
        return { ok: false, status: r.status };
      }
      return { ok: true };
    }).catch(e => {
      // The edit is already in Store + localStorage; only backend sync is deferred.
      ErrorLog.warn('calendar-sync', `${label} error: ${e.message}`);
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
      { label: Util.t('btn.retry'), run: () => { void this._post(path, body, label); } });
  },
};

