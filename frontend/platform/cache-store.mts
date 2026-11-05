// cache-store.mts - durable store for the planner's unsaved-edit cache.
//
// One record per user+plant (`${user}|${plant}`), held by one of two interchangeable backends behind a
// single interface: IndexedDB (`nimbus-cache` v1) or localStorage (its OWN key prefix, never the legacy
// `nimbus.state.v3`). DEFAULT_BACKEND is the single switch for which one is tried first (localStorage:
// dirty-rows-only records fit and its writes are synchronous, so nothing is lost on page unload); the other
// is the automatic fallback when the first is missing, blocked, full or times out.
//
// Imports only the foundation layer so session.mts can import it; it must never import scheduling/.
// Nothing here is wired into persistence yet (T3). The marker in localStorage (`nimbus.cache.marker`)
// is bumped in the same synchronous block that starts a put, so a boot can tell that a newer write was
// started than the record that survived.

import { Config, ErrorLog } from './foundation.mjs';

export type BackendName = 'idb' | 'localstorage';
/** Which backend is tried first. The only place that decides this; both backends stay fully working. */
export const DEFAULT_BACKEND: BackendName = 'localstorage';

export const MARKER_KEY = 'nimbus.cache.marker';
export const LS_RECORD_PREFIX = 'nimbus.cache.rec.';
export const IDB_NAME = 'nimbus-cache';
export const IDB_STORE = 'records';
export const OPEN_TIMEOUT_MS = 3000;
export const PUT_TIMEOUT_MS = 15000;

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

/** `put` of a synchronous backend (localStorage) returns its result directly so callers can observe it at once. */
export interface CacheBackend {
  readonly name: BackendName;
  readonly sync: boolean;
  open(): Promise<void>;
  get(key: string): Promise<CacheRecord | null>;
  put(rec: CacheRecord): PutResult | Promise<PutResult>;
  del(key: string): Promise<void>;
  clear(): Promise<void>;
  /** Record keys currently stored (the orphan sweep lists, then reads and judges each). */
  keys(): Promise<string[]>;
  /** Releases a connection opened only to wipe or sweep (no-op for localStorage). */
  close?(): void;
}

export interface CacheMarker { v: 1; plant: string; seq: number; backend: BackendName; user: string; dirty: boolean }
/** `rows` = unsaved rows in the record. 0 deletes the stored record instead of writing an empty one (undefined = unknown, written as is). */
export interface WriteMeta { user: string; plant: string; dirty: boolean; rows?: number }
export interface WriteResult { ok: boolean; skipped?: boolean; pending?: boolean; reason?: string; error?: string }
export type CacheNotice = 'put_failed' | 'older_record' | 'dirty_no_record' | 'idb_fallback' | 'read_failed';
export type CacheMode = 'none' | 'idb' | 'localstorage' | 'fallback';
export interface BootInfo { backend: BackendName | null; mode: CacheMode; plant: string | null; record: CacheRecord | null; notices: CacheNotice[] }
export interface CacheStats { mode: CacheMode; backend: BackendName | null; failed: number; pending: number; lastChars: number; halted: boolean; seq: number }

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
const isThenable = (v: unknown): v is Promise<PutResult> => !!v && typeof (v as { then?: unknown }).then === 'function';
const lsOrNull = (): Storage | null => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };
const logWarn = (msg: string, ctx?: unknown): void => { try { ErrorLog.warn('cache-store', msg, ctx); } catch { /* logging never throws */ } };
const logInfo = (msg: string, ctx?: unknown): void => { try { ErrorLog.info('cache-store', msg, ctx); } catch { /* logging never throws */ } };
const keyOf = (user: string, plant: string): string => `${user}|${plant}`;
/** Rows held by a stored record's JSON (0 when it is not parseable as a record). */
const rowCount = (json: string): number => {
  try { const r = (JSON.parse(json) as { rows?: unknown } | null)?.rows; return Array.isArray(r) ? r.length : 0; } catch { return 0; }
};

/* ------------------------------------------------------- localStorage backend */

export function makeLocalStorageBackend(): CacheBackend {
  return {
    name: 'localstorage',
    sync: true,
    open: () => (lsOrNull() ? Promise.resolve() : Promise.reject(new Error('localStorage unavailable'))),
    get(key) {
      try {
        const raw = lsOrNull()?.getItem(LS_RECORD_PREFIX + key);
        if (!raw) return Promise.resolve(null);
        const rec = JSON.parse(raw) as CacheRecord;
        return Promise.resolve(rec && typeof rec.json === 'string' ? rec : null);
      } catch (e) { return Promise.reject(e); }
    },
    put(rec) {
      try {
        const ls = lsOrNull();
        if (!ls) return fail(new Error('localStorage unavailable'));
        ls.setItem(LS_RECORD_PREFIX + rec.key, JSON.stringify(rec));
        return { ok: true };
      } catch (e) { return fail(e); }
    },
    del(key) { try { lsOrNull()?.removeItem(LS_RECORD_PREFIX + key); } catch { /* ignore */ } return Promise.resolve(); },
    clear() { clearLsRecords(); return Promise.resolve(); },
    keys() {
      const out: string[] = [];
      try {
        const ls = lsOrNull();
        if (ls) for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.startsWith(LS_RECORD_PREFIX)) out.push(k.slice(LS_RECORD_PREFIX.length)); }
      } catch { /* ignore */ }
      return Promise.resolve(out);
    },
  };
}

function clearLsRecords(): void {
  const ls = lsOrNull();
  if (!ls) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.startsWith(LS_RECORD_PREFIX)) keys.push(k); }
    for (const k of keys) ls.removeItem(k);
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------ IndexedDB backend */

/**
 * Deliberately NOT the ErrorLog pattern: that one has no blocked/abort handling and keeps a null handle
 * forever after a failure. Here the handle is re-acquired lazily after `close` or `versionchange`.
 */
export function makeIdbBackend(): CacheBackend {
  let db: IDBDatabase | null = null;
  let opening: Promise<IDBDatabase> | null = null;

  const acquire = (): Promise<IDBDatabase> => {
    if (db) return Promise.resolve(db);
    if (opening) return opening;
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const done = (err: unknown, d?: IDBDatabase): void => {
        if (settled) { if (d && !err) { try { d.close(); } catch { /* late success after we gave up */ } } return; }
        settled = true;
        if (err) reject(err); else resolve(d as IDBDatabase);
      };
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(IDB_STORE)) d.createObjectStore(IDB_STORE, { keyPath: 'key' });
        };
        req.onsuccess = () => {
          const d = req.result;
          d.onclose = () => { if (db === d) db = null; };
          d.onversionchange = () => { try { d.close(); } catch { /* ignore */ } if (db === d) db = null; };
          if (settled) { done(null, d); return; }
          db = d;
          done(null, d);
        };
        req.onerror = () => done(req.error || new Error('idb open error'));
        req.onblocked = () => done(new Error('idb open blocked'));
      } catch (e) { done(e); }
    }).finally(() => { opening = null; });
    return opening;
  };

  /** Runs one transaction; resolves on `complete`, rejects on abort/error. */
  const run = <T,>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest | null): Promise<T | undefined> =>
    acquire().then(d => new Promise<T | undefined>((resolve, reject) => {
      let tx: IDBTransaction;
      let req: IDBRequest | null = null;
      try {
        tx = d.transaction(IDB_STORE, mode);
        tx.oncomplete = () => resolve(req ? (req.result as T) : undefined);
        tx.onabort = () => reject(tx.error || new Error('idb tx aborted'));
        tx.onerror = () => reject(tx.error || new Error('idb tx error'));
        req = fn(tx.objectStore(IDB_STORE));
        // Ask for an early commit where supported; plain completion otherwise.
        const c = (tx as unknown as { commit?: () => void }).commit;
        if (mode === 'readwrite' && typeof c === 'function') { try { c.call(tx); } catch { /* auto-commit still happens */ } }
      } catch (e) {
        // A closed handle (InvalidStateError) is dropped so the next call reopens.
        if (db === d) db = null;
        reject(e);
      }
    }));

  return {
    name: 'idb',
    sync: false,
    open: () => acquire().then(() => undefined),
    get: key => run<CacheRecord>('readonly', s => s.get(key)).then(r => (r && typeof r.json === 'string' ? r : null)),
    put: rec => run('readwrite', s => s.put(rec)).then((): PutResult => ({ ok: true }), (e: unknown) => fail(e)),
    del: key => run('readwrite', s => s.delete(key)).then(() => undefined),
    clear: () => run('readwrite', s => s.clear()).then(() => undefined),
    keys: () => run<IDBValidKey[]>('readonly', s => s.getAllKeys()).then(r => (Array.isArray(r) ? r.map(String) : [])),
    close() { const d = db; db = null; if (d) { try { d.close(); } catch { /* ignore */ } } },
  };
}

/* ------------------------------------------------------------------- state */

interface Overrides { idb?: CacheBackend; localstorage?: CacheBackend }
let overrides: Overrides = {};
let defaultBackend: BackendName = DEFAULT_BACKEND;
let openTimeoutMs = OPEN_TIMEOUT_MS;
let putTimeoutMs = PUT_TIMEOUT_MS;

let backend: CacheBackend | null = null;
let mode: CacheMode = 'none';
let curUser: string | null = null;
let readyPromise: Promise<BootInfo> | null = null;
let halted = false;
let seqCounter = 0;
let failedCount = 0;
let lastChars = 0;
let notifiedFail = false;
let persistAsked = false;
const failedKeys = new Set<string>();
const peekMap = new Map<string, CacheRecord>();
/** Rows in what this tab last wrote or read per key; a zero-row write only deletes a record this tab itself held rows in. */
const peekRows = new Map<string, number>();
/** Keys whose stored record could not be read (error or timeout): writes for them are held so an unread record is never
 *  overwritten. 'primary' clears on a later successful read(); 'alt' (the other store was unreachable) holds for the session. */
const readFailed = new Map<string, 'primary' | 'alt'>();
let legacyCache: { raw: string; plant: string | null; dirty: boolean } | null | undefined;
const queued = new Map<string, CacheRecord>();
let inflight = false;
/** Puts started by flush() that have not settled yet (they bypass `inflight`, so settled() needs their own count). */
let flushing = 0;
/** A wipe still running; ready() waits for it so a fast sign-in is not wiped by the previous session's clear. */
let wipeInFlight: Promise<void> | null = null;
let idleWaiters: Array<() => void> = [];
let lastPut: PutResult | null = null;
let notices: CacheNotice[] = [];
let boot: BootInfo = { backend: null, mode: 'none', plant: null, record: null, notices: [] };

const idbAvailable = (): boolean => !!overrides.idb || typeof indexedDB !== 'undefined';
const makeBackend = (n: BackendName): CacheBackend => overrides[n] || (n === 'idb' ? makeIdbBackend() : makeLocalStorageBackend());
const pushNotice = (n: CacheNotice): void => { if (!notices.includes(n)) notices.push(n); };

function readMarker(): CacheMarker | null {
  try {
    const raw = lsOrNull()?.getItem(MARKER_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as CacheMarker;
    return m && typeof m.plant === 'string' && typeof m.seq === 'number' ? m : null;
  } catch { return null; }
}
function writeMarker(m: CacheMarker): void { try { lsOrNull()?.setItem(MARKER_KEY, JSON.stringify(m)); } catch { /* marker is best effort */ } }
function clearMarker(): void { try { lsOrNull()?.removeItem(MARKER_KEY); } catch { /* ignore */ } }

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    (t as unknown as { unref?: () => void }).unref?.();
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

const isIdle = (): boolean => !inflight && flushing === 0 && queued.size === 0;
function settleIdle(): void {
  const w = idleWaiters; idleWaiters = [];
  for (const f of w) f();
}

function recordPutResult(rec: CacheRecord, r: PutResult): void {
  lastPut = r;
  if (r.ok) {
    failedKeys.delete(rec.key);
    notifiedFail = false;
    lastChars = rec.json.length;
    return;
  }
  failedCount++;
  failedKeys.add(rec.key);
  if (!notifiedFail) { notifiedFail = true; pushNotice('put_failed'); }
  logWarn('cache put failed', { error: r.error, quota: !!r.quota, chars: rec.json.length, backend: backend?.name });
}

/** localStorage refused a write (full/blocked): move the store to IndexedDB and redo the put there. */
function putViaIdbFallback(rec: CacheRecord, lsFailure: PutResult): Promise<PutResult> {
  if (!idbAvailable()) return Promise.resolve(lsFailure);
  const idb = makeBackend('idb');
  return withTimeout(idb.open(), openTimeoutMs, 'cache open')
    .then(() => Promise.resolve(idb.put(rec)))
    .then(r => {
      if (!r.ok) return lsFailure;
      backend = idb; mode = 'fallback';
      pushNotice('idb_fallback');
      logWarn('localStorage write failed, switched to IndexedDB', { error: lsFailure.ok ? '' : lsFailure.error });
      askPersist();
      const m = readMarker();
      if (m && m.user === rec.user && m.plant === rec.plant) writeMarker({ ...m, backend: 'idb' });
      return r;
    }, () => lsFailure);
}

function putOnce(rec: CacheRecord): PutResult | Promise<PutResult> {
  if (!backend) return fail(new Error('no backend'));
  const used = backend;
  try {
    const r = used.put(rec);
    if (!isThenable(r)) {
      if (r.ok || used.name !== 'localstorage' || !idbAvailable()) return r;
      return withTimeout(putViaIdbFallback(rec, r), putTimeoutMs, 'cache put').then(x => x, (e: unknown) => fail(e));
    }
    return withTimeout(r, putTimeoutMs, 'cache put').then(x => x, (e: unknown) => fail(e));
  } catch (e) { return fail(e); }
}

/** Drains `queued` (latest record per key). Synchronous backends finish inside the call. */
function pump(): void {
  if (inflight) return;
  for (;;) {
    const next = queued.entries().next();
    if (next.done) { if (isIdle()) settleIdle(); return; }
    const [key, rec] = next.value;
    queued.delete(key);
    const r = putOnce(rec);
    if (isThenable(r)) {
      inflight = true;
      r.then(res => { recordPutResult(rec, res); inflight = false; pump(); });
      return;
    }
    recordPutResult(rec, r);
  }
}

/* --------------------------------------------------------------------- init */

function initBackend(user: string): Promise<BootInfo> {
  notices = [];
  peekMap.clear(); peekRows.clear(); readFailed.clear(); queued.clear(); failedKeys.clear();
  failedCount = 0; notifiedFail = false; lastChars = 0; inflight = false; flushing = 0; lastPut = null;
  const marker = readMarker();
  if (marker && marker.seq > seqCounter) seqCounter = marker.seq;

  const useIdbFirst = defaultBackend === 'idb' && idbAvailable();
  const first: CacheBackend = useIdbFirst ? makeBackend('idb') : makeBackend('localstorage');

  const finish = (b: CacheBackend, m: CacheMode): Promise<BootInfo> => {
    backend = b; mode = m;
    return loadBoot(user, marker).then(info => { boot = info; return info; });
  };

  const noBackend = (): BootInfo => { backend = null; mode = 'none'; return { backend: null, mode: 'none' as CacheMode, plant: marker?.plant ?? null, record: null, notices: notices.slice() }; };
  const openIdb = (m: CacheMode): Promise<BootInfo> => {
    const idb = makeBackend('idb');
    return withTimeout(idb.open(), openTimeoutMs, 'cache open').then(() => { askPersist(); return finish(idb, m); });
  };

  if (first.sync) {
    // Synchronous backend: installed before returning so Node/localStorage callers can write right after ready().
    if (lsOrNull()) return finish(first, defaultBackend === 'idb' ? 'fallback' : 'localstorage');
    // localStorage is blocked: try IndexedDB before giving up.
    if (!idbAvailable()) return Promise.resolve(noBackend());
    logWarn('localStorage unavailable, using IndexedDB');
    pushNotice('idb_fallback');
    return openIdb('fallback').catch(() => noBackend());
  }
  return openIdb('idb').catch((e: unknown) => {
    logWarn('IndexedDB unavailable, using localStorage', { error: errName(e) });
    pushNotice('idb_fallback');
    const ls = makeBackend('localstorage');
    return ls.open().then(() => finish(ls, 'fallback'), () => noBackend());
  });
}

function askPersist(): void {
  if (persistAsked) return;
  persistAsked = true;
  try {
    const sm = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (sm && typeof sm.persist === 'function') {
      sm.persist().then(granted => logInfo('storage.persist()', { granted }), () => logInfo('storage.persist() failed'));
    }
  } catch { /* ignore */ }
}

/** Reads the record the marker points at, reconciles seq and the stale-backend case. */
async function loadBoot(user: string, marker: CacheMarker | null): Promise<BootInfo> {
  const b = backend as CacheBackend;
  const info: BootInfo = { backend: b.name, mode, plant: marker?.plant ?? null, record: null, notices: [] };
  if (marker && marker.user === user) {
    const key = keyOf(user, marker.plant);
    let rec: CacheRecord | null = null;
    // A read that ERRORS or times out is never "no record": the marker stays, writes for the plant are held and the
    // planner is told (a zero-row write over an unread record would be silent loss).
    let failed: 'primary' | 'alt' | null = null;
    try { rec = await withTimeout(b.get(key), openTimeoutMs, 'cache read'); }
    catch (e) { failed = 'primary'; logWarn('cache get failed', { error: errName(e) }); }

    // The marker names the backend that held the newest write; if it is the other one, that store wins.
    if (!failed && marker.backend !== b.name && (marker.backend === 'idb' ? idbAvailable() : true)) {
      const alt = makeBackend(marker.backend);
      try {
        await withTimeout(alt.open(), openTimeoutMs, 'alt cache open');
        const altRec = await withTimeout(alt.get(key), openTimeoutMs, 'alt cache read');
        // A zero-row copy never replaces a record that still holds unsaved rows.
        if (altRec && !(rec && rowCount(altRec.json) === 0 && rowCount(rec.json) > 0)) {
          rec = altRec;
          const r = await withTimeout(Promise.resolve(b.put(altRec)), putTimeoutMs, 'alt cache copy');
          if (r.ok) await withTimeout(alt.del(key), putTimeoutMs, 'alt cache delete');
        }
      } catch (e) {
        // The store that may hold the newest record is unreachable: keep what this one has, write nothing over it.
        failed = 'alt'; logWarn('alternate cache store unreachable', { error: errName(e) });
      }
    }

    if (failed) { readFailed.set(key, failed); pushNotice('read_failed'); }
    if (rec) {
      if (rec.seq < marker.seq) pushNotice('older_record');
      if (!peekMap.has(key)) { peekMap.set(key, rec); peekRows.set(key, rowCount(rec.json)); }
      if (rec.seq > seqCounter) seqCounter = rec.seq;
      info.record = rec;
    } else if (!failed && marker.dirty) {
      // The marker keeps pointing at the plant (rememberedPlant); only its dirty claim is withdrawn.
      pushNotice('dirty_no_record');
      writeMarker({ ...marker, dirty: false });
    }
  }
  info.notices = notices.slice();
  return info;
}

/** Another tab bumped the marker: what this tab remembers of that plant's record is no longer what is stored, so the next
 *  autosave rewrites it and an empty write can no longer delete it. */
function onStorage(e: { key?: string | null; newValue?: string | null }): void {
  if (e.key != null && e.key !== MARKER_KEY) return;
  const dropAll = (): void => { peekMap.clear(); peekRows.clear(); };
  if (e.key == null) { dropAll(); return; }
  try {
    const m = e.newValue ? JSON.parse(e.newValue) as CacheMarker : null;
    if (!m) dropAll();
    else if (curUser && m.user === curUser) { const k = keyOf(m.user, m.plant); peekMap.delete(k); peekRows.delete(k); }
  } catch { dropAll(); }
}
try {
  const g = globalThis as unknown as { addEventListener?: (t: string, f: (e: never) => void) => void };
  if (typeof g.addEventListener === 'function') g.addEventListener('storage', onStorage as (e: never) => void);
} catch { /* no window */ }

/** A marker only speaks for the user who wrote it; with no user known the caller cannot compare, so it is trusted. */
function markerBelongsTo(m: CacheMarker, user?: string): boolean {
  const u = user ?? curUser;
  return !u || !m.user || m.user === u;
}

/** Rows in a record's JSON, or null when it cannot be parsed as a record (never judged empty). */
function rowsOf(json: string): number | null {
  try { const r = (JSON.parse(json) as { rows?: unknown } | null)?.rows; return Array.isArray(r) ? r.length : null; } catch { return null; }
}

/** Another user's queued puts and peek copies are dropped on purpose (and logged), never silently. */
function dropOtherUserState(from: string, to: string): void {
  const q = queued.size; const p = peekMap.size;
  queued.clear(); peekMap.clear(); peekRows.clear(); readFailed.clear(); failedKeys.clear();
  if (isIdle()) settleIdle();
  if (q || p) logWarn('cache state of the previous user dropped', { from, to, queued: q, peeked: p });
}

/** False only when IndexedDB.databases() proves the cache database does not exist (so a wipe/sweep need not create it). */
async function idbExists(): Promise<boolean> {
  if (overrides.idb || typeof indexedDB === 'undefined') return true;
  const f = (indexedDB as unknown as { databases?: () => Promise<Array<{ name?: string }>> }).databases;
  if (typeof f !== 'function') return true;
  try { const dbs = await withTimeout(f.call(indexedDB), openTimeoutMs, 'idb databases'); return dbs.some(d => d.name === IDB_NAME); }
  catch { return true; }
}

/** Clears IndexedDB without a prior ready(): open, store.clear(), close. Never deleteDatabase; bounded; fails open. */
async function wipeIdbStandalone(): Promise<void> {
  if (!(await idbExists())) return;
  const idb = makeBackend('idb');
  try {
    await withTimeout(idb.open(), openTimeoutMs, 'cache open');
    await withTimeout(idb.clear(), openTimeoutMs, 'cache wipe');
  } catch (e) { logWarn('cache wipe (IndexedDB) failed', { error: errName(e) }); }
  finally { try { idb.close?.(); } catch { /* ignore */ } }
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
   * Opens the backend for `user` and resolves with the boot picture (record the marker points at, notices).
   * With no `indexedDB` (Node) or with DEFAULT_BACKEND 'localstorage' (the default) the localStorage backend is chosen
   * synchronously inside this call. Calling again with the same user only lifts a previous halt().
   */
  ready(user: string): Promise<BootInfo> {
    // Never lifts halt(): a load that resolves after sign-out must not revive the store. Only resume(user) does.
    if (readyPromise && curUser === user) return readyPromise;
    if (curUser && curUser !== user) dropOtherUserState(curUser, user);
    curUser = user;
    const start = (): Promise<BootInfo> => initBackend(user).catch(() => boot);
    readyPromise = wipeInFlight ? wipeInFlight.then(start) : start();
    return readyPromise;
  },

  /** Lifts halt() for a signed-in `user` (the sign-in path). A different user than the one this page was opened for starts clean. */
  resume(user: string): void {
    halted = false;
    if (curUser && curUser !== user) { dropOtherUserState(curUser, user); curUser = null; readyPromise = null; }
  },

  /** The user this store was opened for (null before ready()). */
  user(): string | null { return curUser; },

  /** Synchronous copy of what was last written (or restored) for `plant`; defaults to the marker's plant. */
  peek(plant?: string): CacheRecord | null {
    const p = plant ?? readMarker()?.plant;
    if (!p || !curUser) return null;
    return peekMap.get(keyOf(curUser, p)) || null;
  },

  /** Plant the previous page load last wrote (from the marker), or null. */
  rememberedPlant(user?: string): string | null {
    const m = readMarker();
    if (m) return markerBelongsTo(m, user) ? m.plant : null;
    return legacyInfo()?.plant ?? null;
  },

  /** True when a marker exists (the new cache has been in use). */
  hasMarker(): boolean { return readMarker() !== null; },

  /** True when the marker says the remembered plant holds unsaved edits (a boot-time guard for plant auto-switches). */
  rememberedDirty(user?: string): boolean {
    const m = readMarker();
    if (m) return markerBelongsTo(m, user) && !!m.dirty;
    return !!legacyInfo()?.dirty;
  },

  /** The raw legacy `nimbus.state.v3` blob (null when absent). Persistence converts it; see importLegacy / dropLegacy. */
  legacyBlob(): string | null { return legacyInfo()?.raw ?? null; },

  /** Removes the legacy blob (also when clean or unparseable). Always safe once its dirty rows are converted or void. */
  dropLegacy(): void { dropLegacyBlob(); },

  /**
   * Reads `plant`'s stored record (backend get on a peek miss, filling peek). Await it before restoring or writing for a
   * plant the boot did not read (the marker only names one). A failed or timed-out read holds writes for that plant
   * (`ok: false`, notice 'read_failed'); a later successful read lifts the hold.
   */
  async read(plant: string): Promise<{ ok: boolean; record: CacheRecord | null }> {
    if (halted) return { ok: false, record: null };
    if (!curUser || !backend || !plant) return { ok: true, record: null };
    const key = keyOf(curUser, plant);
    const held = readFailed.get(key);
    if (held === 'alt') return { ok: false, record: peekMap.get(key) || null };
    if (!held && peekMap.has(key)) return { ok: true, record: peekMap.get(key) || null };
    try {
      const rec = await withTimeout(backend.get(key), openTimeoutMs, 'cache read');
      readFailed.delete(key);
      if (rec && !peekMap.has(key)) { peekMap.set(key, rec); peekRows.set(key, rowCount(rec.json)); }
      if (rec && rec.seq > seqCounter) seqCounter = rec.seq;
      return { ok: true, record: peekMap.get(key) || null };
    } catch (e) {
      logWarn('cache read failed', { error: errName(e), plant });
      readFailed.set(key, 'primary');
      pushNotice('read_failed');
      return { ok: false, record: null };
    }
  },

  /** Skips identical JSON, bumps the marker and starts (or coalesces) the put. Never throws. */
  write(meta: WriteMeta, json: string): WriteResult {
    try {
      if (halted) return { ok: false, skipped: true, reason: 'halted' };
      if (!meta.user || meta.user === 'system') return { ok: false, skipped: true, reason: 'system-actor' };
      if (!meta.plant) return { ok: false, skipped: true, reason: 'no-plant' };
      if (!backend) return { ok: false, skipped: true, reason: 'not-ready' };
      const key = keyOf(meta.user, meta.plant);
      if (readFailed.has(key)) return { ok: false, skipped: true, reason: 'read-failed' };
      const prev = peekMap.get(key);
      const sameMarker = (m: CacheMarker | null): boolean => !!m && m.plant === meta.plant && m.user === meta.user;
      /** The marker follows the plant being written; its dirty flag only ever describes that plant. */
      const touchMarker = (): void => {
        const m = readMarker();
        if (sameMarker(m)) { if (m && m.dirty !== meta.dirty) writeMarker({ ...m, dirty: meta.dirty }); return; }
        writeMarker({ v: 1, plant: meta.plant, seq: prev?.seq ?? seqCounter, backend: (backend as CacheBackend).name, user: meta.user, dirty: !!meta.dirty });
      };
      if (meta.rows === 0) {
        // Nothing unsaved: delete the stored record, but only one this tab itself held rows in. A tab that never saw
        // rows (or whose view another tab invalidated) must not delete what another tab is editing.
        const had = (peekRows.get(key) ?? (prev ? rowCount(prev.json) : 0)) > 0;
        if (had) {
          queued.delete(key); peekMap.delete(key); peekRows.delete(key); failedKeys.delete(key);
          const b = backend;
          void Promise.resolve(b.del(key)).catch((e: unknown) => logWarn('cache delete failed', { error: errName(e) }));
        }
        touchMarker();
        return { ok: true, skipped: true };
      }
      if (prev && prev.json === json && !failedKeys.has(key)) {
        touchMarker();
        return { ok: true, skipped: true };
      }
      const rec: CacheRecord = { key, user: meta.user, plant: meta.plant, seq: ++seqCounter, savedAt: Date.now(), json };
      peekMap.set(key, rec);
      peekRows.set(key, meta.rows ?? rowCount(json));
      // Marker first, in the same synchronous block that starts the put.
      writeMarker({ v: 1, plant: meta.plant, seq: rec.seq, backend: backend.name, user: meta.user, dirty: !!meta.dirty });
      queued.set(key, rec);
      lastPut = null;
      pump();
      if (lastPut) { const r = lastPut as PutResult; return r.ok ? { ok: true } : { ok: false, error: r.error }; }
      return { ok: true, pending: true };
    } catch (e) {
      logWarn('cache write threw', { error: errName(e) });
      return { ok: false, error: errName(e) };
    }
  },

  /**
   * Puts the newest not-yet-started record in its OWN transaction right now; never waits on an in-flight put
   * (IndexedDB orders same-store readwrite transactions by creation, so the newest value commits last).
   */
  async flush(): Promise<WriteResult> {
    if (halted || !backend) return { ok: false, skipped: true, reason: halted ? 'halted' : 'not-ready' };
    const recs = [...queued.values()];
    queued.clear();
    if (!recs.length) return { ok: true, skipped: true };
    let allOk = true; let error: string | undefined;
    flushing += recs.length;
    try {
      await Promise.all(recs.map(async rec => {
        const r = await putOnce(rec);
        recordPutResult(rec, r);
        if (!r.ok) { allOk = false; error = r.error; }
      }));
    } finally { flushing -= recs.length; if (isIdle()) settleIdle(); }
    if (allOk) return { ok: true };
    return { ok: false, error };
  },

  /** Resolves when no put is in flight or queued (tests and the 500 ms sign-out race use it). */
  settled(): Promise<void> {
    if (isIdle()) return Promise.resolve();
    return new Promise<void>(res => { idleWaiters.push(res); });
  },

  /** Deliberate discard of one plant's record (and its marker when it is the marker's plant). */
  async discard(plant: string): Promise<void> {
    if (halted || !curUser) return;
    const key = keyOf(curUser, plant);
    queued.delete(key); peekMap.delete(key); peekRows.delete(key); failedKeys.delete(key); readFailed.delete(key);
    const m = readMarker();
    if (m && m.plant === plant && m.user === curUser) clearMarker();
    try { await backend?.del(key); } catch (e) { logWarn('cache discard failed', { error: errName(e) }); }
  },

  /**
   * Clears every record plus the marker, bounded by the 3 s open timeout and failing open. Works with no prior ready():
   * with no backend open it opens IndexedDB itself, clears the store and closes (never deleteDatabase). With a backend open
   * the clear runs on that connection, so it queues behind an in-flight put. The other store is cleared too, so a copy left
   * there by a fallback cannot survive.
   */
  wipe(): Promise<void> {
    queued.clear(); peekMap.clear(); peekRows.clear(); readFailed.clear(); failedKeys.clear();
    if (isIdle()) settleIdle();
    clearMarker();
    clearLsRecords();
    const b = backend;
    const run = (async (): Promise<void> => {
      if (b) {
        try { await withTimeout(Promise.resolve(b.clear()), openTimeoutMs, 'cache wipe'); }
        catch (e) { logWarn('cache wipe failed', { error: errName(e) }); }
      }
      if (idbAvailable() && b?.name !== 'idb') await wipeIdbStandalone();
    })();
    const tracked: Promise<void> = run.finally(() => { if (wipeInFlight === tracked) wipeInFlight = null; });
    wipeInFlight = tracked;
    return tracked;
  },

  /**
   * Orphan sweep for the sign-in gate (never inside load()): deletes records of any other user, and zero-row records the
   * marker does not point at. A record that holds rows for `user` is NEVER deleted (a recoverable orphan), nor is one whose
   * rows cannot be counted. Works without ready(); bounded and fail-open.
   */
  async sweepOrphans(user: string): Promise<{ deleted: number; kept: number }> {
    const out = { deleted: 0, kept: 0 };
    if (!user || user === 'system') return out;
    const m = readMarker();
    if (m && m.user !== user) clearMarker();
    const live = m && m.user === user ? m : null;
    const stores: CacheBackend[] = [];
    if (lsOrNull()) stores.push(makeBackend('localstorage'));
    if (idbAvailable() && await idbExists()) stores.push(makeBackend('idb'));
    for (const store of stores) {
      try {
        await withTimeout(store.open(), openTimeoutMs, 'sweep open');
        for (const key of await withTimeout(store.keys(), openTimeoutMs, 'sweep list')) {
          const rec = await withTimeout(store.get(key), openTimeoutMs, 'sweep read').catch(() => null);
          if (!rec) continue;
          const rows = rec.legacy ? null : rowsOf(rec.json);
          const own = (rec.user ?? key.split('|')[0]) === user;
          const pointedAt = !!live && keyOf(live.user, live.plant) === key;
          if (!own || (rows === 0 && !pointedAt)) { await withTimeout(store.del(key), openTimeoutMs, 'sweep delete'); out.deleted++; }
          else out.kept++;
        }
      } catch (e) { logWarn('cache orphan sweep failed', { error: errName(e), backend: store.name }); }
      finally { if (store !== backend) store.close?.(); }
    }
    if (out.deleted) logInfo('cache orphan sweep', out);
    return out;
  },

  /** Later writes become no-ops until resume(user) (ready() does NOT lift it). */
  halt(): void { halted = true; queued.clear(); if (isIdle()) settleIdle(); },

  stats(): CacheStats {
    return { mode, backend: backend?.name ?? null, failed: failedCount, pending: queued.size + (inflight ? 1 : 0), lastChars, halted, seq: seqCounter };
  },

  /** One-shot notices raised since the last call (put failure, older record restored, dirty marker without a record, IDB fallback). */
  takeNotices(): CacheNotice[] { const n = notices; notices = []; return n; },

  /**
   * Imports the old `nimbus.state.v3` blob as this user+plant's record when none exists yet, then removes the
   * legacy key. Not called from anywhere until T6.
   */
  async importLegacy(rawJson: string, plant: string, user: string, opts: { converted?: boolean; dirty?: boolean } = {}): Promise<{ imported: boolean; reason?: string }> {
    if (halted) return { imported: false, reason: 'halted' };
    if (!rawJson || !plant || !user || user === 'system') return { imported: false, reason: 'bad-args' };
    if (!backend) return { imported: false, reason: 'not-ready' };
    try {
      const parsed: unknown = JSON.parse(rawJson);
      if (!parsed || typeof parsed !== 'object') return { imported: false, reason: 'not-an-object' };
    } catch { return { imported: false, reason: 'unparseable' }; }
    const key = keyOf(user, plant);
    try { if (peekMap.get(key) || await withTimeout(backend.get(key), openTimeoutMs, 'cache read')) return { imported: false, reason: 'record-exists' }; }
    catch { return { imported: false, reason: 'read-failed' }; }
    // `converted` = the caller already built the compact record shape from the legacy blob; the record is then a normal one.
    const rec: CacheRecord = { key, user, plant, seq: ++seqCounter, savedAt: Date.now(), json: rawJson, ...(opts.converted ? {} : { legacy: true }) };
    let r = await putOnce(rec);
    // The multi-MB legacy blob itself can be what fills localStorage: its content is in memory now, so free it and retry once.
    if (!r.ok && r.quota) { dropLegacyBlob(); r = await putOnce(rec); }
    recordPutResult(rec, r);
    if (!r.ok) return { imported: false, reason: r.error };
    peekMap.set(key, rec);
    peekRows.set(key, rowCount(rawJson));
    writeMarker({ v: 1, plant, seq: rec.seq, backend: backend.name, user, dirty: !!opts.dirty });
    dropLegacyBlob();
    return { imported: true };
  },

  /** Test hook: replace backend factories and reset all module state. */
  _setBackendForTests(o: Overrides & { defaultBackend?: BackendName; openTimeoutMs?: number; putTimeoutMs?: number } = {}): void {
    overrides = { idb: o.idb, localstorage: o.localstorage };
    defaultBackend = o.defaultBackend ?? DEFAULT_BACKEND;
    openTimeoutMs = o.openTimeoutMs ?? OPEN_TIMEOUT_MS;
    putTimeoutMs = o.putTimeoutMs ?? PUT_TIMEOUT_MS;
    backend = null; mode = 'none'; curUser = null; readyPromise = null; halted = false;
    seqCounter = 0; failedCount = 0; lastChars = 0; notifiedFail = false; persistAsked = true;
    failedKeys.clear(); peekMap.clear(); peekRows.clear(); readFailed.clear(); legacyCache = undefined;
    queued.clear(); inflight = false; flushing = 0; wipeInFlight = null; idleWaiters = []; lastPut = null; notices = [];
    boot = { backend: null, mode: 'none', plant: null, record: null, notices: [] };
  },

  /** Test hook: deliver a `storage` event as another tab would. */
  _storageEventForTests(e: { key?: string | null; newValue?: string | null }): void { onStorage(e); },
};
