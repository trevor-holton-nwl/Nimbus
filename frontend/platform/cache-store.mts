// cache-store.mts - durable store for the planner's unsaved-edit cache.
//
// One record per user+plant (`${user}|${plant}`), held by one of two interchangeable backends behind a
// single interface: IndexedDB (`nimbus-cache` v1) or localStorage (its OWN key prefix, never the legacy
// `nimbus.state.v3`). DEFAULT_BACKEND is the single switch for which one is tried first; the other is
// the automatic fallback when the first is missing, blocked or times out.
//
// Imports only the foundation layer so session.mts can import it; it must never import scheduling/.
// Nothing here is wired into persistence yet (T3). The marker in localStorage (`nimbus.cache.marker`)
// is bumped in the same synchronous block that starts a put, so a boot can tell that a newer write was
// started than the record that survived.

import { Config, ErrorLog } from './foundation.mjs';

export type BackendName = 'idb' | 'localstorage';
/** Which backend is tried first. The only place that decides this; both backends stay fully working. */
export const DEFAULT_BACKEND: BackendName = 'idb';

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
}

export interface CacheMarker { v: 1; plant: string; seq: number; backend: BackendName; user: string; dirty: boolean }
export interface WriteMeta { user: string; plant: string; dirty: boolean }
export interface WriteResult { ok: boolean; skipped?: boolean; pending?: boolean; reason?: string; error?: string }
export type CacheNotice = 'put_failed' | 'older_record' | 'dirty_no_record' | 'idb_fallback';
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
const queued = new Map<string, CacheRecord>();
let inflight = false;
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

function putOnce(rec: CacheRecord): PutResult | Promise<PutResult> {
  if (!backend) return fail(new Error('no backend'));
  try {
    const r = backend.put(rec);
    if (!isThenable(r)) return r;
    return withTimeout(r, putTimeoutMs, 'cache put').then(x => x, (e: unknown) => fail(e));
  } catch (e) { return fail(e); }
}

/** Drains `queued` (latest record per key). Synchronous backends finish inside the call. */
function pump(): void {
  if (inflight) return;
  for (;;) {
    const next = queued.entries().next();
    if (next.done) { settleIdle(); return; }
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
  peekMap.clear(); queued.clear(); failedKeys.clear();
  failedCount = 0; notifiedFail = false; lastChars = 0; inflight = false; lastPut = null;
  const marker = readMarker();
  if (marker && marker.seq > seqCounter) seqCounter = marker.seq;

  const useIdbFirst = defaultBackend === 'idb' && idbAvailable();
  const first: CacheBackend = useIdbFirst ? makeBackend('idb') : makeBackend('localstorage');

  const finish = (b: CacheBackend, m: CacheMode): Promise<BootInfo> => {
    backend = b; mode = m;
    return loadBoot(user, marker).then(info => { boot = info; return info; });
  };

  if (first.sync) {
    // Synchronous backend: installed before returning so Node/localStorage callers can write right after ready().
    if (!lsOrNull()) { backend = null; mode = 'none'; return Promise.resolve({ backend: null, mode: 'none' as CacheMode, plant: marker?.plant ?? null, record: null, notices: [] }); }
    return finish(first, defaultBackend === 'idb' ? 'fallback' : 'localstorage');
  }
  return withTimeout(first.open(), openTimeoutMs, 'cache open').then(
    () => { askPersist(); return finish(first, 'idb'); },
    (e: unknown) => {
      logWarn('IndexedDB unavailable, using localStorage', { error: errName(e) });
      pushNotice('idb_fallback');
      const ls = makeBackend('localstorage');
      return ls.open().then(() => finish(ls, 'fallback'),
        () => { backend = null; mode = 'none'; return { backend: null, mode: 'none' as CacheMode, plant: marker?.plant ?? null, record: null, notices: notices.slice() }; });
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
    try { rec = await b.get(key); } catch (e) { logWarn('cache get failed', { error: errName(e) }); }

    // The marker names the backend that held the newest write; if it is the other one, that store wins.
    if (marker.backend !== b.name && (marker.backend === 'idb' ? idbAvailable() : true)) {
      const alt = makeBackend(marker.backend);
      try {
        await withTimeout(alt.open(), openTimeoutMs, 'alt cache open');
        const altRec = await alt.get(key);
        if (altRec) {
          rec = altRec;
          const r = await b.put(altRec);
          if (r.ok) await alt.del(key);
        }
      } catch { /* alternate store unreachable: keep what the current one has */ }
    }

    if (!rec) {
      if (marker.dirty) pushNotice('dirty_no_record');
      clearMarker();
    } else {
      if (rec.seq < marker.seq) pushNotice('older_record');
      if (!peekMap.has(key)) peekMap.set(key, rec);
      if (rec.seq > seqCounter) seqCounter = rec.seq;
      info.record = rec;
    }
  }
  info.notices = notices.slice();
  return info;
}

/* ---------------------------------------------------------------- public API */

export const CacheStore = {
  /**
   * Opens the backend for `user` and resolves with the boot picture (record the marker points at, notices).
   * With no `indexedDB` (Node) or DEFAULT_BACKEND 'localstorage' the localStorage backend is chosen
   * synchronously inside this call. Calling again with the same user only lifts a previous halt().
   */
  ready(user: string): Promise<BootInfo> {
    halted = false;
    if (readyPromise && curUser === user) return readyPromise;
    curUser = user;
    readyPromise = initBackend(user).catch(() => boot);
    return readyPromise;
  },

  /** Synchronous copy of what was last written (or restored) for `plant`; defaults to the marker's plant. */
  peek(plant?: string): CacheRecord | null {
    const p = plant ?? readMarker()?.plant;
    if (!p || !curUser) return null;
    return peekMap.get(keyOf(curUser, p)) || null;
  },

  /** Plant the previous page load last wrote (from the marker), or null. */
  rememberedPlant(): string | null { return readMarker()?.plant ?? null; },

  /** Skips identical JSON, bumps the marker and starts (or coalesces) the put. Never throws. */
  write(meta: WriteMeta, json: string): WriteResult {
    try {
      if (halted) return { ok: false, skipped: true, reason: 'halted' };
      if (!meta.user || meta.user === 'system') return { ok: false, skipped: true, reason: 'system-actor' };
      if (!meta.plant) return { ok: false, skipped: true, reason: 'no-plant' };
      if (!backend) return { ok: false, skipped: true, reason: 'not-ready' };
      const key = keyOf(meta.user, meta.plant);
      const prev = peekMap.get(key);
      if (prev && prev.json === json && !failedKeys.has(key)) {
        const m = readMarker();
        if (m && m.dirty !== meta.dirty) writeMarker({ ...m, dirty: meta.dirty });
        return { ok: true, skipped: true };
      }
      const rec: CacheRecord = { key, user: meta.user, plant: meta.plant, seq: ++seqCounter, savedAt: Date.now(), json };
      peekMap.set(key, rec);
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
    await Promise.all(recs.map(async rec => {
      const r = await putOnce(rec);
      recordPutResult(rec, r);
      if (!r.ok) { allOk = false; error = r.error; }
    }));
    if (allOk) return { ok: true };
    return { ok: false, error };
  },

  /** Resolves when no put is in flight or queued (tests and the 500 ms sign-out race use it). */
  settled(): Promise<void> {
    if (!inflight && queued.size === 0) return Promise.resolve();
    return new Promise<void>(res => { idleWaiters.push(res); });
  },

  /** Deliberate discard of one plant's record (and its marker when it is the marker's plant). */
  async discard(plant: string): Promise<void> {
    if (!curUser) return;
    const key = keyOf(curUser, plant);
    queued.delete(key); peekMap.delete(key); failedKeys.delete(key);
    const m = readMarker();
    if (m && m.plant === plant && m.user === curUser) clearMarker();
    try { await backend?.del(key); } catch (e) { logWarn('cache discard failed', { error: errName(e) }); }
  },

  /** Clears every record on the open connection (never deletes the database) plus the marker. */
  async wipe(): Promise<void> {
    queued.clear(); peekMap.clear(); failedKeys.clear();
    if (!inflight) settleIdle();
    clearMarker();
    clearLsRecords();
    try { await backend?.clear(); } catch (e) { logWarn('cache wipe failed', { error: errName(e) }); }
  },

  /** Later writes become no-ops until the next ready(). */
  halt(): void { halted = true; queued.clear(); if (!inflight) settleIdle(); },

  stats(): CacheStats {
    return { mode, backend: backend?.name ?? null, failed: failedCount, pending: queued.size + (inflight ? 1 : 0), lastChars, halted, seq: seqCounter };
  },

  /** One-shot notices raised since the last call (put failure, older record restored, dirty marker without a record, IDB fallback). */
  takeNotices(): CacheNotice[] { const n = notices; notices = []; return n; },

  /**
   * Imports the old `nimbus.state.v3` blob as this user+plant's record when none exists yet, then removes the
   * legacy key. Not called from anywhere until T6.
   */
  async importLegacy(rawJson: string, plant: string, user: string): Promise<{ imported: boolean; reason?: string }> {
    if (!rawJson || !plant || !user || user === 'system') return { imported: false, reason: 'bad-args' };
    if (!backend) return { imported: false, reason: 'not-ready' };
    try {
      const parsed: unknown = JSON.parse(rawJson);
      if (!parsed || typeof parsed !== 'object') return { imported: false, reason: 'not-an-object' };
    } catch { return { imported: false, reason: 'unparseable' }; }
    const key = keyOf(user, plant);
    try { if (peekMap.get(key) || await backend.get(key)) return { imported: false, reason: 'record-exists' }; }
    catch { return { imported: false, reason: 'read-failed' }; }
    const rec: CacheRecord = { key, user, plant, seq: ++seqCounter, savedAt: Date.now(), json: rawJson, legacy: true };
    const r = await putOnce(rec);
    recordPutResult(rec, r);
    if (!r.ok) return { imported: false, reason: r.error };
    peekMap.set(key, rec);
    writeMarker({ v: 1, plant, seq: rec.seq, backend: backend.name, user, dirty: false });
    try { lsOrNull()?.removeItem(Config.LS_KEY); } catch { /* ignore */ }
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
    failedKeys.clear(); peekMap.clear(); queued.clear(); inflight = false; idleWaiters = []; lastPut = null; notices = [];
    boot = { backend: null, mode: 'none', plant: null, record: null, notices: [] };
  },
};
