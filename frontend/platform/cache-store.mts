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
/** One quarantine copy per user+plant record lives at `${QUARANTINE_KEY}.${user}|${plant}`; the bare key is the pre-A3 single slot. */
const quarantineKeyOf = (key: string): string => `${QUARANTINE_KEY}.${key}`;
export const QUARANTINE_CAP_CHARS = 200 * 1024;

export interface CacheRecord {
  key: string;
  user: string;
  plant: string;
  seq: number;
  savedAt: number;
  json: string;
  legacy?: boolean;
  /** Id of the tab (page load) that wrote this record. Absent on records written before cross-tab ownership existed. */
  writer?: string;
}
export type PutResult = { ok: true } | { ok: false; error: string; quota?: boolean };

/** `dirtyPlants` = plants of `user` whose record holds rows; `dirty` stays for compatibility (true iff dirtyPlants is not empty).
 *  A marker written before `dirtyPlants` existed has only `dirty`, meaning "the marker's plant is dirty". */
export interface CacheMarker { v: 1; plant: string; seq: number; user: string; dirty: boolean; dirtyPlants?: string[] }
/** `rows` = unsaved rows in the record. 0 deletes the stored record instead of writing an empty one (undefined = unknown, written as is). */
export interface WriteMeta { user: string; plant: string; dirty: boolean; rows?: number }
export interface WriteResult { ok: boolean; skipped?: boolean; reason?: string; error?: string }
export type CacheNotice = 'put_failed' | 'older_record' | 'dirty_no_record' | 'read_failed' | 'corrupt_record' | 'corrupt_removed' | 'other_dirty_plants';
export type CacheMode = 'none' | 'localstorage';
export interface BootInfo { mode: CacheMode; plant: string | null; record: CacheRecord | null; notices: CacheNotice[] }
/** `failed` = cumulative put failures (history); `failedKeys` = records whose LAST put failed (a later success clears it);
 *  `blocked` = browser storage is unavailable right now (mode 'none' alone also means "not opened yet"). */
export interface CacheStats { mode: CacheMode; failed: number; failedKeys: number; blocked: boolean; pending: number; lastChars: number; halted: boolean; seq: number }

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
/** This page load's identity. A record is "mine" only when it carries it (seq numbers are per-tab and do not order tabs). */
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
/** Rows held by a stored record's JSON (0 when it is not parseable as a record). */
const rowCount = (json: string): number => {
  try { const r = (JSON.parse(json) as { rows?: unknown } | null)?.rows; return Array.isArray(r) ? r.length : 0; } catch { return 0; }
};
/** Rows in a record's JSON, or null when it cannot be parsed as a record (never judged empty). */
const rowsOf = (json: string): number | null => {
  try { const r = (JSON.parse(json) as { rows?: unknown } | null)?.rows; return Array.isArray(r) ? r.length : null; } catch { return null; }
};

/** The rows array of a record's JSON, or null when it cannot be parsed as a record. */
const rowListOf = (json: string): unknown[] | null => {
  try { const r = (JSON.parse(json) as { rows?: unknown } | null)?.rows; return Array.isArray(r) ? r : null; } catch { return null; }
};

/** The stored wrapper of one record, or null when it is not a usable wrapper. */
function parseStored(raw: string): CacheRecord | null {
  try {
    const rec = JSON.parse(raw) as CacheRecord | null;
    return rec && typeof rec.json === 'string' ? rec : null;
  } catch { return null; }
}
/** Like parseStored, but says WHY a record is unusable: 'syntax' = JSON.parse throws (the text is damaged), 'shape' = it parses
 *  but is not a record wrapper (valid JSON, unexpected structure: never judged damaged). */
function classifyStored(raw: string): { kind: 'ok'; rec: CacheRecord } | { kind: 'syntax' } | { kind: 'shape' } {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { kind: 'syntax' }; }
  const rec = v as CacheRecord | null;
  return rec && typeof rec.json === 'string' ? { kind: 'ok', rec } : { kind: 'shape' };
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
/** Keys whose unparseable record was quarantined during this boot (their dirty claim is withdrawn without a second notice). */
const quarantinedNow = new Set<string>();
/** Plants the signed-in user may open (null = unknown or unrestricted). Set by the app; used only to decide which dirty
 *  plant a boot opens or announces. Never used to delete a stored record or to leave one out of a count. */
let plantScope: (() => string[] | null) | null = null;
const allowedList = (): string[] | null => { try { const a = plantScope ? plantScope() : null; return Array.isArray(a) ? a : null; } catch { return null; } };
let legacyCache: { raw: string; plant: string | null; dirty: boolean } | null | undefined;
/** The username this page booted or signed in as (set by Session at the boot gate and in signIn). Edits held in memory belong
 *  to it: a write for anybody else is refused, and only this user's session write can resume a halted tab. */
let pageUser: string | null = null;
/** The first user the store was opened for in this page load (the fallback when Session never named the page user). */
let firstUser: string | null = null;
/** Set when ready() was called for another user while halted: only a sign-in on this page (resume) lifts it. */
let signInRequired = false;
const resumeHooks = new Set<() => void>();
/** The user the edits held in this page belong to. 'system' (nobody signed in) is never an owner. */
const capturedUser = (): string | null => pageUser ?? firstUser ?? (curUser && curUser !== 'system' ? curUser : null);
/** True when `user` is somebody other than the user this page was named for: their records must never reach this page's board. */
const foreignToPage = (user: string | null | undefined): boolean => !!pageUser && !!user && user !== pageUser;
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
function rememberedOf(m: CacheMarker): string | null {
  const allowed = allowedList();
  const d = allowed ? dirtyOf(m).filter(p => allowed.includes(p)) : dirtyOf(m);
  if (!d.length) return !allowed || allowed.includes(m.plant) ? m.plant : null;
  return d.includes(m.plant) ? m.plant : d[0];
}
/** The marker's dirty plants the user can still open (all of them when the scope is unknown). */
function openableDirty(m: CacheMarker): string[] {
  const allowed = allowedList();
  return allowed ? dirtyOf(m).filter(p => allowed.includes(p)) : dirtyOf(m);
}
/** A marker only speaks for the user who wrote it; with no user known the caller cannot compare, so it is trusted. */
function markerBelongsTo(m: CacheMarker, user?: string): boolean {
  // Once a page user is named, only that user's marker is ever visible to this page.
  if (pageUser && m.user && m.user !== pageUser) return false;
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
function scanDirty(user: string): { plants: string[]; seq: number; rows: Map<string, number>; ids: Map<string, string[]> } {
  const plants: string[] = []; let seq = 0; const rows = new Map<string, number>(); const ids = new Map<string, string[]>();
  for (const k of keysWithPrefix(LS_RECORD_PREFIX + user + '|')) {
    let rec: CacheRecord | null = null;
    try { const raw = lsOrNull()?.getItem(k); rec = raw ? parseStored(raw) : null; } catch { rec = null; }
    const list = rec ? rowListOf(rec.json) : null;
    const n = list ? list.length : 0;
    if (rec && list && n > 0) { plants.push(rec.plant); rows.set(rec.plant, n); ids.set(rec.plant, list.map(r => String((r as { id?: unknown } | null)?.id))); if (rec.seq > seq) seq = rec.seq; }
  }
  return { plants, seq, rows, ids };
}
/** Highest seq in the marker and in the stored record for `key`, read cheaply (the wrapper's own `"seq"` precedes the payload). */
function storedSeqFloor(key: string): number {
  let top = readMarker()?.seq ?? 0;
  try {
    const raw = lsOrNull()?.getItem(LS_RECORD_PREFIX + key);
    const m = raw ? /"seq":(\d+)/.exec(raw.slice(0, 400)) : null;
    if (m) top = Math.max(top, Number(m[1]));
  } catch { /* an unreadable record is handled by the callers' own reads */ }
  return top;
}
/** True when this tab wrote the stored record itself (its writer id and a seq not newer than the last this tab wrote). */
function isMine(rec: CacheRecord, key: string): boolean {
  const last = lastSeqWritten.get(key);
  return rec.writer === TAB_ID && last !== undefined && rec.seq <= last;
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

/** Copies an unusable record to its own per-user quarantine key, then removes it from the record keys. A record that fits the
 *  cap is copied whole; a bigger one is copied truncated (it can never be parsed anyway) after raising `corrupt_removed`, so it
 *  cannot hold the plant's writes for the session. Returns false (record left in place) only when no copy can be stored: a
 *  record is never removed without a copy. */
function quarantine(key: string, raw: string): boolean {
  const tooBig = raw.length > QUARANTINE_CAP_CHARS;
  const copy = tooBig ? raw.slice(0, QUARANTINE_CAP_CHARS) : raw;
  try { lsOrNull()?.setItem(quarantineKeyOf(key), JSON.stringify({ key, at: Date.now(), chars: raw.length, raw: copy, ...(tooBig ? { truncated: true } : {}) })); }
  catch (e) { logWarn('cache quarantine copy failed, record left in place', { error: errName(e), key }); return false; }
  removeRecord(key);
  quarantinedNow.add(key);
  // A truncated copy means the stored edits are gone (and the writes resumed): say so, never "not backed up".
  pushNotice(tooBig ? 'corrupt_removed' : 'corrupt_record');
  logWarn(tooBig ? 'cache record unparseable and too large, quarantined truncated' : 'cache record unparseable, quarantined', { key, chars: raw.length });
  return true;
}

/** Reads one stored record. A storage error is never "no record" (status 'error'); a record that cannot be parsed is
 *  quarantined and then reads as "no record" so it cannot hold the plant's writes for the session. */
function readStored(key: string): { status: 'ok'; record: CacheRecord | null } | { status: 'error' } {
  let raw: string | null | undefined;
  try { raw = lsOrNull()?.getItem(LS_RECORD_PREFIX + key); }
  catch (e) { logWarn('cache get failed', { error: errName(e) }); return { status: 'error' }; }
  if (!raw) return { status: 'ok', record: null };
  const c = classifyStored(raw);
  if (c.kind === 'ok') return { status: 'ok', record: c.rec };
  // Valid JSON in an unexpected shape is not damage: a big one stays where it is and holds the plant's writes (read_failed);
  // truncating and removing is only for text JSON.parse cannot read.
  if (c.kind === 'shape' && raw.length > QUARANTINE_CAP_CHARS) { logWarn('cache record has an unexpected shape and is too large to copy, left in place', { key, chars: raw.length }); return { status: 'error' }; }
  return quarantine(key, raw) ? { status: 'ok', record: null } : { status: 'error' };
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
  peekMap.clear(); peekRows.clear(); lastSeqWritten.clear(); readFailed.clear(); failedKeys.clear(); quarantinedNow.clear();
  failedCount = 0; notifiedFail = false; lastChars = 0;
  const marker = readMarker();
  if (marker && marker.seq > seqCounter) seqCounter = marker.seq;
  if (!lsOrNull()) { mode = 'none'; return { mode: 'none', plant: null, record: null, notices: [] }; }
  mode = 'localstorage';
  // A page named for X never reads Y's records: Y's unsaved rows must not be overlaid on X's board.
  if (foreignToPage(user)) { boot = { mode, plant: null, record: null, notices: [] }; return boot; }
  return loadBoot(user, marker);
}

/** Reads the record of the plant the marker points at (the dirty one when the marker's own plant is clean), reconciles seq. */
function loadBoot(user: string, marker: CacheMarker | null): BootInfo {
  const plant = marker ? rememberedOf(marker) : null;
  const info: BootInfo = { mode, plant, record: null, notices: [] };
  if (marker && marker.user === user && plant) {
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
      // The marker keeps pointing at the plant (rememberedPlant); only its dirty claim for it is withdrawn. A record that was
      // just quarantined already told the planner (corrupt_record): no second toast for the same key.
      if (!quarantinedNow.has(key)) pushNotice('dirty_no_record');
      withdrawFromMarker(user, plant, false);
    }
    if (openableDirty(marker).some(p => p !== plant)) pushNotice('other_dirty_plants');
  }
  info.notices = notices.slice();
  boot = info;
  return info;
}

/** Another tab changed storage. The event names exactly what changed: a record key invalidates only that record's local view
 *  (so the next autosave rewrites it and an empty write can no longer delete it); a vanished or clobbered marker has its dirty
 *  list recomputed from the stored records; only a full clear() drops everything this tab remembers. */
function onStorage(e: { key?: string | null; newValue?: string | null }): void {
  // Record events invalidate this tab's local view even while halted: a sign-out wipe in another tab removes the records, and a
  // stale peek would make the first write after a resume look identical to what is "stored" and skip it.
  if (e.key == null) { peekMap.clear(); peekRows.clear(); return; }
  if (e.key.startsWith(LS_RECORD_PREFIX)) {
    const k = e.key.slice(LS_RECORD_PREFIX.length);
    peekMap.delete(k); peekRows.delete(k);
    return;
  }
  // A halted tab (signed out, reset) must never rebuild a marker from records that are about to be removed.
  if (halted) return;
  if (e.key !== MARKER_KEY || !curUser || mode === 'none') return;
  try {
    const m = e.newValue ? JSON.parse(e.newValue) as CacheMarker : null;
    if (m && m.user !== curUser) return;
    // The new marker may have lost a plant this tab holds rows for (two tabs, last writer wins): put the truth back.
    const claimed = m ? new Set(dirtyOf(m)) : new Set<string>();
    let heldHere = false;
    for (const [k, n] of peekRows) if (n > 0 && k.startsWith(curUser + '|') && !claimed.has(k.slice(curUser.length + 1))) { heldHere = true; break; }
    if (m && !heldHere) return;
    const real = scanDirty(curUser);
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
  peekMap.clear(); peekRows.clear(); lastSeqWritten.clear(); readFailed.clear(); failedKeys.clear(); quarantinedNow.clear();
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
    // A halted page asked to open the store for someone other than the user it was loaded for: only a sign-in lifts this.
    const cap = capturedUser();
    // 'system' (nobody signed in, e.g. a load in a stale tab after another tab signed out) says nothing about who is signed in:
    // it never latches and, on a page that already has an owner, never touches the store (no foreign state, no reads).
    if (user === 'system' && cap) return Promise.resolve({ mode, plant: null, record: null, notices: [] });
    // Any other user than this page's owner needs a sign-in on this page, halted or not (a Y that is only opened while this tab
    // is live would otherwise let a later same-user resume pass with Y's rows in memory).
    if (cap && user !== cap && user !== 'system') signInRequired = true;
    if (readyPromise && curUser === user) return readyPromise;
    if (curUser && curUser !== user) dropOtherUserState(curUser, user);
    if (!firstUser && user !== 'system') firstUser = user;
    curUser = user;
    try { readyPromise = Promise.resolve(initStore(user)); } catch { readyPromise = Promise.resolve(boot); }
    return readyPromise;
  },

  /** Lifts halt() for a signed-in `user` (the sign-in path). A different user than the one this page was opened for starts clean. */
  resume(user: string): void {
    const wasHalted = halted;
    halted = false; signInRequired = false; pageUser = user;
    if (curUser && curUser !== user) { dropOtherUserState(curUser, user); curUser = null; readyPromise = null; }
    else if (wasHalted) { peekMap.clear(); peekRows.clear(); }
    // The record keys changed while this tab was halted (and the edits held here were not written): re-store them once.
    if (wasHalted) for (const h of [...resumeHooks]) { try { h(); } catch { /* a hook never breaks resume */ } }
  },

  /** The storage-event resume: only for the user this page was loaded for, and never after the page was asked to open the store
   *  for someone else while halted (sign-in required). Returns true when it resumed. */
  resumeSameUser(user: string): boolean {
    if (!halted || signInRequired) return false;
    const cap = capturedUser();
    if (!cap || user !== cap) return false;
    CacheStore.resume(user);
    return true;
  },

  /** Registers a callback run once whenever resume() lifts a halt (Persistence re-stores its in-memory edits). Returns the unsubscribe. */
  onResume(fn: () => void): () => void { resumeHooks.add(fn); return () => { resumeHooks.delete(fn); }; },

  /** Names the user this page booted or signed in as (see pageUser). */
  setPageUser(user: string | null): void { pageUser = user || null; },
  /** The user this page holds edits for (null when never named). */
  pageUser(): string | null { return pageUser; },
  /** pageUser, else the first user the store was opened for, else the current store user. */
  capturedUser(): string | null { return capturedUser(); },

  /** The user this store was opened for (null before ready()). */
  user(): string | null { return curUser; },

  /** Synchronous copy of what was last written (or restored) for `plant`; defaults to the plant a boot would open. */
  peek(plant?: string): CacheRecord | null {
    const m = plant ? null : readMarker();
    const p = plant ?? (m ? rememberedOf(m) : null);
    if (!p || !curUser || foreignToPage(curUser)) return null;
    return peekMap.get(keyOf(curUser, p)) || null;
  },

  /** Plant the previous page load should open: a plant holding unsaved rows when there is one, else the last one written. */
  rememberedPlant(user?: string): string | null {
    if (foreignToPage(user)) return null;
    const m = readMarker();
    if (m) return markerBelongsTo(m, user) ? rememberedOf(m) : null;
    return legacyInfo()?.plant ?? null;
  },

  /** Plants of this user that hold unsaved rows, per the marker, limited to plants the user can still open (when known). */
  dirtyPlants(user?: string): string[] {
    if (foreignToPage(user)) return [];
    const m = readMarker();
    return m && markerBelongsTo(m, user) ? openableDirty(m) : [];
  },

  /** Unsaved rows per plant stored for `user`, read from storage (every record, whatever the marker or the plant scope says).
   *  Reset and sign-out use it: they wipe every stored record, so every stored row must be counted. */
  dirtyFromStorage(user: string): Array<{ plant: string; rows: number; ids: string[] }> {
    if (!user || user === 'system' || foreignToPage(user)) return [];
    const s = scanDirty(user);
    return s.plants.map(plant => ({ plant, rows: s.rows.get(plant) ?? 0, ids: s.ids.get(plant) ?? [] }));
  },

  /** Tells the store which plants the signed-in user may open (null = unknown or unrestricted); see plantScope. */
  setPlantScope(fn: (() => string[] | null) | null): void { plantScope = fn; },

  /** True when a marker exists (the new cache has been in use). */
  hasMarker(): boolean { return readMarker() !== null; },

  /** True when the marker says some plant holds unsaved edits (a boot-time guard for plant auto-switches). */
  rememberedDirty(user?: string): boolean {
    if (foreignToPage(user)) return false;
    const m = readMarker();
    if (m) return markerBelongsTo(m, user) && openableDirty(m).length > 0;
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
    if (!curUser || mode === 'none' || !plant || foreignToPage(curUser)) return { ok: true, record: null };
    const key = keyOf(curUser, plant);
    if (!readFailed.has(key) && peekMap.has(key)) return { ok: true, record: peekMap.get(key) || null };
    const r = readStored(key);
    if (r.status === 'error') { if (!readFailed.has(key)) pushNotice('read_failed'); readFailed.add(key); return { ok: false, record: null }; }
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
      // This page's in-memory edits belong to the user it was loaded for; never file them under whoever is signed in now.
      if (pageUser && meta.user !== pageUser) return { ok: false, skipped: true, reason: 'wrong-user' };
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
            if (isMine(r.record, key)) had = true;
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
      // Seq numbers are per tab: lift ours above what any tab has stored (marker, this key's record) so a newer write always
      // carries the higher number.
      seqCounter = Math.max(seqCounter, storedSeqFloor(key));
      const rec: CacheRecord = { key, user: meta.user, plant: meta.plant, seq: ++seqCounter, savedAt: Date.now(), json, writer: TAB_ID };
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
    // Record first, marker second: a halted-or-racing tab can never rebuild the marker from a record that is still there.
    removeRecord(key);
    withdrawFromMarker(curUser, plant, true);
  },

  /** Clears the marker, every record, the quarantine copy and the legacy blob, synchronously. Works with no prior ready(). */
  wipe(): Promise<void> {
    peekMap.clear(); peekRows.clear(); lastSeqWritten.clear(); readFailed.clear(); failedKeys.clear(); quarantinedNow.clear();
    // Records (and every other cache key) first, the marker last (see discard()).
    for (const k of keysWithPrefix(CACHE_KEY_PREFIX)) { if (k !== MARKER_KEY) try { lsOrNull()?.removeItem(k); } catch { /* ignore */ } }
    clearMarker();
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
    if (!user || user === 'system' || foreignToPage(user)) return out;
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
    // A quarantine copy belongs to the user whose record it came from; another user's copy is not ours to keep or see.
    for (const qk of keysWithPrefix(QUARANTINE_KEY)) {
      let owner: string | null = null;
      if (qk === QUARANTINE_KEY) {
        try { const q = JSON.parse(lsOrNull()?.getItem(qk) ?? 'null') as { key?: unknown } | null; owner = typeof q?.key === 'string' ? q.key.split('|')[0] : null; } catch { owner = null; }
      } else owner = qk.slice(QUARANTINE_KEY.length + 1).split('|')[0];
      if (owner !== user) { try { lsOrNull()?.removeItem(qk); out.deleted++; } catch { /* ignore */ } }
    }
    if (out.deleted) logInfo('cache orphan sweep', out);
    return out;
  },

  /** Later writes become no-ops until resume(user) (ready() does NOT lift it). */
  halt(): void { halted = true; },

  stats(): CacheStats {
    return { mode, failed: failedCount, failedKeys: failedKeys.size, blocked: !lsOrNull(), pending: 0, lastChars, halted, seq: seqCounter };
  },

  /** One-shot notices raised since the last call (put failure, older record restored, dirty marker without a record, corrupt record, other dirty plants). */
  takeNotices(): CacheNotice[] { const n = notices; notices = []; return n; },

  /**
   * Imports the old `nimbus.state.v3` blob as this user+plant's record when none exists yet, then removes the legacy key.
   * A put that hits the quota frees the blob (its content is in memory) and retries once. The caller (Persistence) removes the
   * blob after its single attempt whatever happened here.
   */
  async importLegacy(rawJson: string, plant: string, user: string, opts: { converted?: boolean; dirty?: boolean; loadedPlant?: string | null } = {}): Promise<{ imported: boolean; reason?: string }> {
    if (halted) return { imported: false, reason: 'halted' };
    if (!rawJson || !plant || !user || user === 'system') return { imported: false, reason: 'bad-args' };
    if (foreignToPage(user)) return { imported: false, reason: 'wrong-user' };
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
    seqCounter = Math.max(seqCounter, storedSeqFloor(key));
    const rec: CacheRecord = { key, user, plant, seq: ++seqCounter, savedAt: Date.now(), json: rawJson, writer: TAB_ID, ...(opts.converted ? {} : { legacy: true }) };
    let r = putRecord(rec);
    // The multi-MB legacy blob itself can be what fills localStorage: its content is in memory now, so free it and retry once.
    if (!r.ok && r.quota) { dropLegacyBlob(); r = putRecord(rec); }
    recordPutResult(rec, r);
    if (!r.ok) return { imported: false, reason: r.quota ? 'quota' : r.error };
    peekMap.set(key, rec);
    peekRows.set(key, rowCount(rawJson));
    lastSeqWritten.set(key, rec.seq);
    touchMarker(user, plant, !!opts.dirty, rec.seq);
    // Kept edits for a plant other than the one being loaded are announced like the boot's other dirty plants.
    if (opts.dirty && opts.loadedPlant && opts.loadedPlant !== plant) pushNotice('other_dirty_plants');
    dropLegacyBlob();
    return { imported: true };
  },

  /** Test hook: reset all module state (storage itself is the test's own fake localStorage). */
  _setBackendForTests(): void {
    mode = 'none'; curUser = null; readyPromise = null; halted = false;
    seqCounter = 0; failedCount = 0; lastChars = 0; notifiedFail = false;
    failedKeys.clear(); peekMap.clear(); peekRows.clear(); lastSeqWritten.clear(); readFailed.clear(); quarantinedNow.clear(); legacyCache = undefined;
    pageUser = null; firstUser = null; signInRequired = false;
    notices = [];
    boot = { mode: 'none', plant: null, record: null, notices: [] };
  },

  /** This page load's writer id (tests stamp foreign records with another one). */
  _tabIdForTests(): string { return TAB_ID; },

  /** Test hook: deliver a `storage` event as another tab would. */
  _storageEventForTests(e: { key?: string | null; newValue?: string | null }): void { onStorage(e); },
};
