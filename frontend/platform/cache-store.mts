// cache-store.mts - durable store for the planner's unsaved-edit cache.
//
// One record per user+plant (`${user}|${plant}`) in localStorage under its OWN key prefix (never the legacy
// `nimbus.state.v3`). Every operation is synchronous: a write has landed (or failed) when write() returns, so nothing is
// lost on page unload. A write that fails (full or blocked storage) is counted, raised once as a `put_failed` notice and
// retried by the next write; it never latches autosave off.
//
// Imports only the foundation layer so session.mts can import it; it must never import scheduling/.
// The marker in localStorage (`nimbus.cache.marker`) is bumped in the same synchronous block that starts a put, so a boot
// can tell that a newer write was started than the record that survived. It also lists the plants of this user whose
// record holds unsaved rows (`dirtyPlants`), so a clean write for one plant can never hide another plant's unsaved record.

import { Config, ErrorLog } from './foundation.mjs';

export const MARKER_KEY = 'nimbus.cache.marker';
export const LS_RECORD_PREFIX = 'nimbus.cache.rec.';
export const CACHE_KEY_PREFIX = 'nimbus.cache.';
/** The last unparseable record, copied here (capped) before it is removed from the record keys. */
export const QUARANTINE_KEY = 'nimbus.cache.quarantine';
export const QUARANTINE_CAP_CHARS = 200 * 1024;

export interface CacheRecord {
  key: string;
  user: string;
  plant: string;
  seq: number;
  savedAt: number;
  json: string;
  legacy?: boolean;
}
export type PutResult = { ok: true } | { ok: false; error: string; quota?: boolean };

/** `dirtyPlants` = plants of `user` whose record holds rows; `dirty` stays for compatibility (true iff dirtyPlants is not empty).
 *  A marker written before `dirtyPlants` existed has only `dirty`, meaning "the marker's plant is dirty". */
export interface CacheMarker { v: 1; plant: string; seq: number; user: string; dirty: boolean; dirtyPlants?: string[] }
/** `rows` = unsaved rows in the record. 0 deletes the stored record instead of writing an empty one (undefined = unknown, written as is). */
export interface WriteMeta { user: string; plant: string; dirty: boolean; rows?: number }
export interface WriteResult { ok: boolean; skipped?: boolean; reason?: string; error?: string }
export type CacheNotice = 'put_failed' | 'older_record' | 'dirty_no_record' | 'read_failed' | 'corrupt_record' | 'other_dirty_plants';
export type CacheMode = 'none' | 'localstorage';
export interface BootInfo { mode: CacheMode; plant: string | null; record: CacheRecord | null; notices: CacheNotice[] }
export interface CacheStats { mode: CacheMode; failed: number; pending: number; lastChars: number; halted: boolean; seq: number }

/* ----------------------------------------------------------------- helpers */

const errName = (e: unknown): string => {
  const x = e as { name?: string; message?: string } | null;
  return (x && (x.name || x.message)) || String(e);
};
const isQuota = (e: unknown): boolean => {
  const x = e as { name?: string; code?: number } | null;
  return !!x && (x.name === 'QuotaExceededError' || x.name === 'NS_ERROR_DOM_QUOTA_REACHED' || x.code === 22 || x.code === 1014);
};
const fail = (e: unknown): PutResult => ({ ok: false, error: errName(e), quota: isQuota(e) });
const lsOrNull = (): Storage | null => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };
const logWarn = (msg: string, ctx?: unknown): void => { try { ErrorLog.warn('cache-store', msg, ctx); } catch { /* logging never throws */ } };
const logInfo = (msg: string, ctx?: unknown): void => { try { ErrorLog.info('cache-store', msg, ctx); } catch { /* logging never throws */ } };
const keyOf = (user: string, plant: string): string => `${user}|${plant}`;
/** Rows held by a stored record's JSON (0 when it is not parseable as a record). */
const rowCount = (json: string): number => {
  try { const r = (JSON.parse(json) as { rows?: unknown } | null)?.rows; return Array.isArray(r) ? r.length : 0; } catch { return 0; }
};
/** Rows in a record's JSON, or null when it cannot be parsed as a record (never judged empty). */
const rowsOf = (json: string): number | null => {
  try { const r = (JSON.parse(json) as { rows?: unknown } | null)?.rows; return Array.isArray(r) ? r.length : null; } catch { return null; }
};

/** The stored wrapper of one record, or null when it is not a usable wrapper. */
function parseStored(raw: string): CacheRecord | null {
  try {
    const rec = JSON.parse(raw) as CacheRecord | null;
    return rec && typeof rec.json === 'string' ? rec : null;
  } catch { return null; }
}

function keysWithPrefix(prefix: string): string[] {
  const out: string[] = [];
  try {
    const ls = lsOrNull();
    if (ls) for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.startsWith(prefix)) out.push(k); }
  } catch { /* ignore */ }
  return out;
}

/* ------------------------------------------------------------------- state */

let mode: CacheMode = 'none';
let curUser: string | null = null;
let readyPromise: Promise<BootInfo> | null = null;
let halted = false;
let seqCounter = 0;
let failedCount = 0;
let lastChars = 0;
let notifiedFail = false;
const failedKeys = new Set<string>();
const peekMap = new Map<string, CacheRecord>();
/** Rows in what this tab last wrote or read per key; a zero-row write only deletes a record this tab itself held rows in. */
const peekRows = new Map<string, number>();
/** Highest seq THIS tab wrote per key. Never cleared by a storage event: it is what proves a stored record is this tab's own. */
const lastSeqWritten = new Map<string, number>();
/** Keys whose stored record could not be read (storage threw): writes for them are held so an unread record is never
 *  overwritten. A later successful read() (every load does one) lifts the hold. */
const readFailed = new Set<string>();
let legacyCache: { raw: string; plant: string | null; dirty: boolean } | null | undefined;
let notices: CacheNotice[] = [];
let boot: BootInfo = { mode: 'none', plant: null, record: null, notices: [] };

const pushNotice = (n: CacheNotice): void => { if (!notices.includes(n)) notices.push(n); };

/* ------------------------------------------------------------------ marker */

function readMarker(): CacheMarker | null {
  try {
    const raw = lsOrNull()?.getItem(MARKER_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as CacheMarker;
    return m && typeof m.plant === 'string' && typeof m.seq === 'number' ? m : null;
  } catch { return null; }
}
function writeMarker(m: CacheMarker): void {
  const dirtyPlants = [...new Set(m.dirtyPlants ?? [])];
  try { lsOrNull()?.setItem(MARKER_KEY, JSON.stringify({ v: 1, plant: m.plant, seq: m.seq, user: m.user, dirty: dirtyPlants.length > 0, dirtyPlants })); }
  catch { /* marker is best effort */ }
}
function clearMarker(): void { try { lsOrNull()?.removeItem(MARKER_KEY); } catch { /* ignore */ } }

/** Plants whose record holds unsaved rows, per a marker (a pre-dirtyPlants marker names only its own plant). */
function dirtyOf(m: CacheMarker): string[] {
  if (Array.isArray(m.dirtyPlants)) return m.dirtyPlants.filter(p => typeof p === 'string' && p);
  return m.dirty ? [m.plant] : [];
}
/** The plant a boot should open: the marker's plant, unless that one is clean and another plant holds unsaved rows. */
function rememberedOf(m: CacheMarker): string {
  const d = dirtyOf(m);
  return !d.length || d.includes(m.plant) ? m.plant : d[0];
}
/** A marker only speaks for the user who wrote it; with no user known the caller cannot compare, so it is trusted. */
function markerBelongsTo(m: CacheMarker, user?: string): boolean {
  const u = user ?? curUser;
  return !u || !m.user || m.user === u;
}

/** The marker follows the plant just written; its dirtyPlants merge into what is already stored (so a clean write for one
 *  plant never erases another plant's dirty claim) and only this plant's membership changes. */
function touchMarker(user: string, plant: string, dirty: boolean, seq: number): void {
  const m = readMarker();
  const set = new Set(m && m.user === user ? dirtyOf(m) : []);
  if (dirty) set.add(plant); else set.delete(plant);
  writeMarker({ v: 1, plant, seq, user, dirty: set.size > 0, dirtyPlants: [...set] });
}

/** Removes `plant` from the marker's dirty list; the marker follows another dirty plant (or goes away) when it pointed at it. */
function withdrawFromMarker(user: string, plant: string, clearIfEmptyAndPointed: boolean): void {
  const m = readMarker();
  if (!m || m.user !== user) return;
  const left = dirtyOf(m).filter(p => p !== plant);
  if (m.plant === plant && clearIfEmptyAndPointed && !left.length) { clearMarker(); return; }
  writeMarker({ ...m, plant: m.plant === plant && left.length ? left[0] : m.plant, dirty: left.length > 0, dirtyPlants: left });
}

/** Plants of `user` whose stored record holds rows, read from storage (the marker's list is only a claim). */
function dirtyFromStorage(user: string): { plants: string[]; seq: number } {
  const plants: string[] = []; let seq = 0;
  for (const k of keysWithPrefix(LS_RECORD_PREFIX + user + '|')) {
    let rec: CacheRecord | null = null;
    try { const raw = lsOrNull()?.getItem(k); rec = raw ? parseStored(raw) : null; } catch { rec = null; }
    if (rec && (rowsOf(rec.json) ?? 0) > 0) { plants.push(rec.plant); if (rec.seq > seq) seq = rec.seq; }
  }
  return { plants, seq };
}

/* ----------------------------------------------------------------- storage */

function putRecord(rec: CacheRecord): PutResult {
  try {
    const ls = lsOrNull();
    if (!ls) return fail(new Error('localStorage unavailable'));
    ls.setItem(LS_RECORD_PREFIX + rec.key, JSON.stringify(rec));
    return { ok: true };
  } catch (e) { return fail(e); }
}
function removeRecord(key: string): void { try { lsOrNull()?.removeItem(LS_RECORD_PREFIX + key); } catch { /* ignore */ } }

/** Copies an unusable record (capped) to the quarantine key and removes it from the record keys. */
function quarantine(key: string, raw: string): void {
  try { lsOrNull()?.setItem(QUARANTINE_KEY, JSON.stringify({ key, at: Date.now(), chars: raw.length, raw: raw.slice(0, QUARANTINE_CAP_CHARS) })); }
  catch (e) { logWarn('cache quarantine copy failed', { error: errName(e) }); }
  removeRecord(key);
  pushNotice('corrupt_record');
  logWarn('cache record unparseable, quarantined', { key, chars: raw.length });
}

/** Reads one stored record. A storage error is never "no record" (status 'error'); a record that cannot be parsed is
 *  quarantined and then reads as "no record" so it cannot hold the plant's writes for the session. */
function readStored(key: string): { status: 'ok'; record: CacheRecord | null } | { status: 'error' } {
  let raw: string | null | undefined;
  try { raw = lsOrNull()?.getItem(LS_RECORD_PREFIX + key); }
  catch (e) { logWarn('cache get failed', { error: errName(e) }); return { status: 'error' }; }
  if (!raw) return { status: 'ok', record: null };
  const rec = parseStored(raw);
  if (!rec) { quarantine(key, raw); return { status: 'ok', record: null }; }
  return { status: 'ok', record: rec };
}

function recordPutResult(rec: CacheRecord, r: PutResult): void {
  if (r.ok) {
    failedKeys.delete(rec.key);
    notifiedFail = false;
    lastChars = rec.json.length;
    return;
  }
  failedCount++;
  failedKeys.add(rec.key);
  if (!notifiedFail) { notifiedFail = true; pushNotice('put_failed'); }
  logWarn('cache put failed', { error: r.error, quota: !!r.quota, chars: rec.json.length });
}

/* --------------------------------------------------------------------- init */

function initStore(user: string): BootInfo {
  notices = [];
  peekMap.clear(); peekRows.clear(); lastSeqWritten.clear(); readFailed.clear(); failedKeys.clear();
  failedCount = 0; notifiedFail = false; lastChars = 0;
  const marker = readMarker();
  if (marker && marker.seq > seqCounter) seqCounter = marker.seq;
  if (!lsOrNull()) { mode = 'none'; return { mode: 'none', plant: null, record: null, notices: [] }; }
  mode = 'localstorage';
  return loadBoot(user, marker);
}

/** Reads the record of the plant the marker points at (the dirty one when the marker's own plant is clean), reconciles seq. */
function loadBoot(user: string, marker: CacheMarker | null): BootInfo {
  const info: BootInfo = { mode, plant: marker ? rememberedOf(marker) : null, record: null, notices: [] };
  if (marker && marker.user === user) {
    const plant = rememberedOf(marker);
    const key = keyOf(user, plant);
    // A read that ERRORS is never "no record": the marker stays, writes for the plant are held and the planner is told
    // (a zero-row write over an unread record would be silent loss). The next load's read() retries.
    const r = readStored(key);
    if (r.status === 'error') { readFailed.add(key); pushNotice('read_failed'); }
    else if (r.record) {
      const rec = r.record;
      // The marker's seq belongs to the marker's own plant only.
      if (plant === marker.plant && rec.seq < marker.seq) pushNotice('older_record');
      peekMap.set(key, rec); peekRows.set(key, rowCount(rec.json));
      if (rec.seq > seqCounter) seqCounter = rec.seq;
      info.record = rec;
    } else if (dirtyOf(marker).includes(plant)) {
      // The marker keeps pointing at the plant (rememberedPlant); only its dirty claim for it is withdrawn.
      pushNotice('dirty_no_record');
      withdrawFromMarker(user, plant, false);
    }
    if (dirtyOf(marker).some(p => p !== plant)) pushNotice('other_dirty_plants');
  }
  info.notices = notices.slice();
  boot = info;
  return info;
}

/** Another tab changed storage. The event names exactly what changed: a record key invalidates only that record's local view
 *  (so the next autosave rewrites it and an empty write can no longer delete it); a vanished or clobbered marker has its dirty
 *  list recomputed from the stored records; only a full clear() drops everything this tab remembers. */
function onStorage(e: { key?: string | null; newValue?: string | null }): void {
  if (e.key == null) { peekMap.clear(); peekRows.clear(); return; }
  if (e.key.startsWith(LS_RECORD_PREFIX)) {
    const k = e.key.slice(LS_RECORD_PREFIX.length);
    peekMap.delete(k); peekRows.delete(k);
    return;
  }
  if (e.key !== MARKER_KEY || !curUser || mode === 'none') return;
  try {
    const m = e.newValue ? JSON.parse(e.newValue) as CacheMarker : null;
    if (m && m.user !== curUser) return;
    // The new marker may have lost a plant this tab holds rows for (two tabs, last writer wins): put the truth back.
    const claimed = m ? new Set(dirtyOf(m)) : new Set<string>();
    let heldHere = false;
    for (const [k, n] of peekRows) if (n > 0 && k.startsWith(curUser + '|') && !claimed.has(k.slice(curUser.length + 1))) { heldHere = true; break; }
    if (m && !heldHere) return;
    const real = dirtyFromStorage(curUser);
    if (!real.plants.length && !m) return;
    const keep = m && real.plants.includes(m.plant) ? m.plant : (real.plants[0] ?? m?.plant ?? '');
    if (!keep) return;
    writeMarker({ v: 1, plant: keep, seq: m && m.plant === keep ? m.seq : real.seq, user: curUser, dirty: real.plants.length > 0, dirtyPlants: real.plants });
  } catch { /* a marker nobody can read is rewritten by the next write */ }
}
try {
  const g = globalThis as unknown as { addEventListener?: (t: string, f: (e: never) => void) => void };
  if (typeof g.addEventListener === 'function') g.addEventListener('storage', onStorage as (e: never) => void);
} catch { /* no window */ }

/** Another user's peek copies are dropped on purpose (and logged), never silently. */
function dropOtherUserState(from: string, to: string): void {
  const p = peekMap.size;
  peekMap.clear(); peekRows.clear(); lastSeqWritten.clear(); readFailed.clear(); failedKeys.clear();
  if (p) logWarn('cache state of the previous user dropped', { from, to, peeked: p });
}

function dropLegacyBlob(): void {
  legacyCache = null;
  try { lsOrNull()?.removeItem(Config.LS_KEY); } catch { /* ignore */ }
}

/** The legacy `nimbus.state.v3` blob, read once (it can be megabytes) with the plant it was saved for. */
function legacyInfo(): { raw: string; plant: string | null; dirty: boolean } | null {
  if (legacyCache !== undefined) return legacyCache;
  legacyCache = null;
  try {
    const raw = lsOrNull()?.getItem(Config.LS_KEY);
    if (raw) {
      let plant: string | null = null;
      let dirty = false;
      try {
        const p = JSON.parse(raw) as { selectedPlant?: unknown; _dirtyIds?: unknown } | null;
        plant = typeof p?.selectedPlant === 'string' && p.selectedPlant ? p.selectedPlant : null;
        dirty = Array.isArray(p?._dirtyIds) && p._dirtyIds.length > 0;
      } catch { /* unparseable */ }
      legacyCache = { raw, plant, dirty };
    }
  } catch { /* ignore */ }
  return legacyCache;
}

/* ---------------------------------------------------------------- public API */

export const CacheStore = {
  /**
   * Opens the store for `user` and resolves with the boot picture (record the marker points at, notices). Everything is
   * synchronous, so a write right after ready() (no await) already lands. Calling again with the same user returns the same
   * boot picture; it never lifts halt().
   */
  ready(user: string): Promise<BootInfo> {
    // Never lifts halt(): a load that resolves after sign-out must not revive the store. Only resume(user) does.
    if (readyPromise && curUser === user) return readyPromise;
    if (curUser && curUser !== user) dropOtherUserState(curUser, user);
    curUser = user;
    try { readyPromise = Promise.resolve(initStore(user)); } catch { readyPromise = Promise.resolve(boot); }
    return readyPromise;
  },

  /** Lifts halt() for a signed-in `user` (the sign-in path). A different user than the one this page was opened for starts clean. */
  resume(user: string): void {
    halted = false;
    if (curUser && curUser !== user) { dropOtherUserState(curUser, user); curUser = null; readyPromise = null; }
  },

  /** The user this store was opened for (null before ready()). */
  user(): string | null { return curUser; },

  /** Synchronous copy of what was last written (or restored) for `plant`; defaults to the plant a boot would open. */
  peek(plant?: string): CacheRecord | null {
    const m = plant ? null : readMarker();
    const p = plant ?? (m ? rememberedOf(m) : null);
    if (!p || !curUser) return null;
    return peekMap.get(keyOf(curUser, p)) || null;
  },

  /** Plant the previous page load should open: a plant holding unsaved rows when there is one, else the last one written. */
  rememberedPlant(user?: string): string | null {
    const m = readMarker();
    if (m) return markerBelongsTo(m, user) ? rememberedOf(m) : null;
    return legacyInfo()?.plant ?? null;
  },

  /** Plants of this user that hold unsaved rows, per the marker. */
  dirtyPlants(user?: string): string[] {
    const m = readMarker();
    return m && markerBelongsTo(m, user) ? dirtyOf(m) : [];
  },

  /** True when a marker exists (the new cache has been in use). */
  hasMarker(): boolean { return readMarker() !== null; },

  /** True when the marker says some plant holds unsaved edits (a boot-time guard for plant auto-switches). */
  rememberedDirty(user?: string): boolean {
    const m = readMarker();
    if (m) return markerBelongsTo(m, user) && dirtyOf(m).length > 0;
    return !!legacyInfo()?.dirty;
  },

  /** The raw legacy `nimbus.state.v3` blob (null when absent). Persistence converts it; see importLegacy / dropLegacy. */
  legacyBlob(): string | null { return legacyInfo()?.raw ?? null; },

  /** Removes the legacy blob (also when clean or unparseable). Always safe once its dirty rows are converted or void. */
  dropLegacy(): void { dropLegacyBlob(); },

  /**
   * Reads `plant`'s stored record (on a peek miss, filling peek). Call it before restoring or writing for a plant the boot
   * did not read (the boot reads one plant). A storage error holds writes for that plant (`ok: false`, notice 'read_failed');
   * the next read() retries and a success lifts the hold. An unparseable record is quarantined and reads as no record.
   */
  async read(plant: string): Promise<{ ok: boolean; record: CacheRecord | null }> {
    if (halted) return { ok: false, record: null };
    if (!curUser || mode === 'none' || !plant) return { ok: true, record: null };
    const key = keyOf(curUser, plant);
    if (!readFailed.has(key) && peekMap.has(key)) return { ok: true, record: peekMap.get(key) || null };
    const r = readStored(key);
    if (r.status === 'error') { readFailed.add(key); pushNotice('read_failed'); return { ok: false, record: null }; }
    readFailed.delete(key);
    if (r.record && !peekMap.has(key)) { peekMap.set(key, r.record); peekRows.set(key, rowCount(r.record.json)); }
    if (r.record && r.record.seq > seqCounter) seqCounter = r.record.seq;
    return { ok: true, record: peekMap.get(key) || null };
  },

  /** Skips identical JSON, bumps the marker and puts the record. Never throws. */
  write(meta: WriteMeta, json: string): WriteResult {
    try {
      if (halted) return { ok: false, skipped: true, reason: 'halted' };
      if (!meta.user || meta.user === 'system') return { ok: false, skipped: true, reason: 'system-actor' };
      if (!meta.plant) return { ok: false, skipped: true, reason: 'no-plant' };
      if (mode === 'none') return { ok: false, skipped: true, reason: 'not-ready' };
      const key = keyOf(meta.user, meta.plant);
      if (readFailed.has(key)) return { ok: false, skipped: true, reason: 'read-failed' };
      const prev = peekMap.get(key);
      const dirty = !!meta.dirty && (meta.rows === undefined || meta.rows > 0);
      if (meta.rows === 0) {
        // Nothing unsaved: delete the stored record, but only one this tab itself held rows in, or can prove it wrote
        // (its stored seq is not newer than the last this tab wrote for the key). A record another tab wrote stays,
        // and so does the plant's dirty claim for it.
        let had = (peekRows.get(key) ?? (prev ? rowCount(prev.json) : 0)) > 0;
        let foreign = false;
        if (!had) {
          const r = readStored(key);
          if (r.status === 'ok' && r.record) {
            const mine = lastSeqWritten.get(key);
            if (mine !== undefined && r.record.seq <= mine) had = true;
            else foreign = (rowsOf(r.record.json) ?? 0) > 0;
          }
        }
        if (had) { peekMap.delete(key); peekRows.delete(key); failedKeys.delete(key); removeRecord(key); }
        touchMarker(meta.user, meta.plant, foreign, prev?.seq ?? seqCounter);
        return { ok: true, skipped: true };
      }
      if (prev && prev.json === json && !failedKeys.has(key)) {
        touchMarker(meta.user, meta.plant, dirty, prev.seq);
        return { ok: true, skipped: true };
      }
      const rec: CacheRecord = { key, user: meta.user, plant: meta.plant, seq: ++seqCounter, savedAt: Date.now(), json };
      peekMap.set(key, rec);
      peekRows.set(key, meta.rows ?? rowCount(json));
      lastSeqWritten.set(key, rec.seq);
      // Marker first, then the put.
      touchMarker(meta.user, meta.plant, dirty, rec.seq);
      const r = putRecord(rec);
      recordPutResult(rec, r);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    } catch (e) {
      logWarn('cache write threw', { error: errName(e) });
      return { ok: false, error: errName(e) };
    }
  },

  /** Deliberate discard of one plant's record (and its place in the marker). */
  async discard(plant: string): Promise<void> {
    if (halted || !curUser) return;
    const key = keyOf(curUser, plant);
    peekMap.delete(key); peekRows.delete(key); failedKeys.delete(key); readFailed.delete(key);
    withdrawFromMarker(curUser, plant, true);
    removeRecord(key);
  },

  /** Clears the marker, every record, the quarantine copy and the legacy blob, synchronously. Works with no prior ready(). */
  wipe(): Promise<void> {
    peekMap.clear(); peekRows.clear(); lastSeqWritten.clear(); readFailed.clear(); failedKeys.clear();
    clearMarker();
    for (const k of keysWithPrefix(CACHE_KEY_PREFIX)) { try { lsOrNull()?.removeItem(k); } catch { /* ignore */ } }
    dropLegacyBlob();
    return Promise.resolve();
  },

  /**
   * Orphan sweep for the sign-in gate (never inside load()): deletes records of any other user, and zero-row records the
   * marker does not point at. A record that holds rows for `user` is NEVER deleted (a recoverable orphan), nor is one whose
   * rows cannot be counted. Works without ready().
   */
  async sweepOrphans(user: string): Promise<{ deleted: number; kept: number }> {
    const out = { deleted: 0, kept: 0 };
    if (!user || user === 'system') return out;
    const m = readMarker();
    if (m && m.user !== user) clearMarker();
    const live = m && m.user === user ? m : null;
    for (const full of keysWithPrefix(LS_RECORD_PREFIX)) {
      const key = full.slice(LS_RECORD_PREFIX.length);
      let rec: CacheRecord | null = null;
      try { const raw = lsOrNull()?.getItem(full); rec = raw ? parseStored(raw) : null; } catch { rec = null; }
      if (!rec) continue;
      const rows = rec.legacy ? null : rowsOf(rec.json);
      const own = (rec.user ?? key.split('|')[0]) === user;
      const pointedAt = !!live && keyOf(live.user, live.plant) === key;
      if (!own || (rows === 0 && !pointedAt)) { removeRecord(key); out.deleted++; }
      else out.kept++;
    }
    if (out.deleted) logInfo('cache orphan sweep', out);
    return out;
  },

  /** Later writes become no-ops until resume(user) (ready() does NOT lift it). */
  halt(): void { halted = true; },

  stats(): CacheStats {
    return { mode, failed: failedCount, pending: 0, lastChars, halted, seq: seqCounter };
  },

  /** One-shot notices raised since the last call (put failure, older record restored, dirty marker without a record, corrupt record, other dirty plants). */
  takeNotices(): CacheNotice[] { const n = notices; notices = []; return n; },

  /**
   * Imports the old `nimbus.state.v3` blob as this user+plant's record when none exists yet, then removes the legacy key.
   * The caller drops the blob first (its content is in memory) so the put has the quota it needs.
   */
  async importLegacy(rawJson: string, plant: string, user: string, opts: { converted?: boolean; dirty?: boolean } = {}): Promise<{ imported: boolean; reason?: string }> {
    if (halted) return { imported: false, reason: 'halted' };
    if (!rawJson || !plant || !user || user === 'system') return { imported: false, reason: 'bad-args' };
    if (mode === 'none') return { imported: false, reason: 'not-ready' };
    try {
      const parsed: unknown = JSON.parse(rawJson);
      if (!parsed || typeof parsed !== 'object') return { imported: false, reason: 'not-an-object' };
    } catch { return { imported: false, reason: 'unparseable' }; }
    const key = keyOf(user, plant);
    if (peekMap.get(key)) return { imported: false, reason: 'record-exists' };
    const existing = readStored(key);
    if (existing.status === 'error') return { imported: false, reason: 'read-failed' };
    if (existing.record) return { imported: false, reason: 'record-exists' };
    // `converted` = the caller already built the compact record shape from the legacy blob; the record is then a normal one.
    const rec: CacheRecord = { key, user, plant, seq: ++seqCounter, savedAt: Date.now(), json: rawJson, ...(opts.converted ? {} : { legacy: true }) };
    let r = putRecord(rec);
    // The multi-MB legacy blob itself can be what fills localStorage: its content is in memory now, so free it and retry once.
    if (!r.ok && r.quota) { dropLegacyBlob(); r = putRecord(rec); }
    recordPutResult(rec, r);
    if (!r.ok) return { imported: false, reason: r.error };
    peekMap.set(key, rec);
    peekRows.set(key, rowCount(rawJson));
    lastSeqWritten.set(key, rec.seq);
    touchMarker(user, plant, !!opts.dirty, rec.seq);
    dropLegacyBlob();
    return { imported: true };
  },

  /** Test hook: reset all module state (storage itself is the test's own fake localStorage). */
  _setBackendForTests(): void {
    mode = 'none'; curUser = null; readyPromise = null; halted = false;
    seqCounter = 0; failedCount = 0; lastChars = 0; notifiedFail = false;
    failedKeys.clear(); peekMap.clear(); peekRows.clear(); lastSeqWritten.clear(); readFailed.clear(); legacyCache = undefined;
    notices = [];
    boot = { mode: 'none', plant: null, record: null, notices: [] };
  },

  /** Test hook: deliver a `storage` event as another tab would. */
  _storageEventForTests(e: { key?: string | null; newValue?: string | null }): void { onStorage(e); },
};
