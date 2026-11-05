// Hand-rolled fakes for the cache store (no dependency): an in-memory CacheBackend with fault injection, a
// Map-backed localStorage with an optional character quota, and a tiny indexedDB global that is just enough
// to drive the real IndexedDB backend in cache-store.mts (open / transaction / put / get / delete / clear).

const quotaError = () => Object.assign(new Error('quota'), { name: 'QuotaExceededError' });

/**
 * Backend double. Fault knobs live on `ctl` and can change at any time:
 *   failOpen      open() rejects            blockOpen   open() never settles
 *   quotaOnPut    1-based put number that aborts with QuotaExceededError (once)
 *   hold          number of upcoming puts that stay pending until release()
 *   hangPuts      puts never commit (and never settle)
 *   failGet       get() rejects
 */
export function makeFakeBackend({ name = 'idb', sync = false } = {}) {
  const data = new Map();
  const pending = [];
  const ctl = { failOpen: false, blockOpen: false, quotaOnPut: 0, hold: 0, hangPuts: false, failGet: false, putCount: 0, puts: [], opens: 0 };
  const backend = {
    name, sync,
    open() {
      ctl.opens++;
      if (ctl.blockOpen) return new Promise(() => {});
      return ctl.failOpen ? Promise.reject(new Error('open failed')) : Promise.resolve();
    },
    get(key) { return ctl.failGet ? Promise.reject(new Error('get failed')) : Promise.resolve(data.has(key) ? structuredClone(data.get(key)) : null); },
    put(rec) {
      ctl.putCount++;
      const n = ctl.putCount;
      ctl.puts.push(rec.seq);
      if (ctl.quotaOnPut && n === ctl.quotaOnPut) {
        const r = { ok: false, error: 'QuotaExceededError', quota: true };
        return sync ? r : Promise.resolve(r);
      }
      if (ctl.hangPuts) return new Promise(() => {});
      if (ctl.hold > 0) {
        ctl.hold--;
        return new Promise(resolve => pending.push(() => { data.set(rec.key, structuredClone(rec)); resolve({ ok: true }); }));
      }
      data.set(rec.key, structuredClone(rec));
      return sync ? { ok: true } : Promise.resolve({ ok: true });
    },
    del(key) { data.delete(key); return Promise.resolve(); },
    clear() { data.clear(); return Promise.resolve(); },
  };
  return {
    backend, ctl, data,
    /** Commit held puts in creation order. */
    release() { while (pending.length) pending.shift()(); },
    heldCount: () => pending.length,
  };
}

/** Map-backed localStorage. `quotaChars` limits the summed key+value length; `failNext` throws once. */
export function makeFakeLocalStorage({ quotaChars = Infinity } = {}) {
  const m = new Map();
  const ctl = { quotaChars, failNext: 0 };
  const used = () => { let n = 0; for (const [k, v] of m) n += k.length + v.length; return n; };
  const ls = {
    get length() { return m.size; },
    key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      v = String(v);
      if (ctl.failNext > 0) { ctl.failNext--; throw quotaError(); }
      const prev = m.has(k) ? k.length + m.get(k).length : 0;
      if (used() - prev + k.length + v.length > ctl.quotaChars) throw quotaError();
      m.set(k, v);
    },
    removeItem: k => { m.delete(k); },
    clear: () => m.clear(),
  };
  return { ls, ctl, map: m };
}

export function installFakeLocalStorage(opts) {
  const f = makeFakeLocalStorage(opts);
  globalThis.localStorage = f.ls;
  return f;
}

/** Minimal indexedDB global. mode: 'ok' | 'error' | 'blocked' | 'hang'. abortPuts: aborts every put tx with a quota error. */
export function installFakeIndexedDB() {
  const records = new Map();
  const ctl = { mode: 'ok', abortPuts: false, opens: 0, dbs: [], upgraded: 0 };
  let created = false;
  const makeDb = () => {
    const db = {
      closed: false, onclose: null, onversionchange: null,
      objectStoreNames: { contains: () => created },
      createObjectStore() { created = true; ctl.upgraded++; },
      close() { db.closed = true; },
      transaction() {
        if (db.closed) throw Object.assign(new Error('closed'), { name: 'InvalidStateError' });
        const tx = { oncomplete: null, onabort: null, onerror: null, error: null, aborted: false, commit() {} };
        const req = result => ({ result });
        let last = null;
        const store = {
          put(rec) { if (ctl.abortPuts) { tx.aborted = true; tx.error = quotaError(); } else records.set(rec.key, structuredClone(rec)); last = req(undefined); return last; },
          get(key) { last = req(records.has(key) ? structuredClone(records.get(key)) : undefined); return last; },
          delete(key) { records.delete(key); last = req(undefined); return last; },
          clear() { records.clear(); last = req(undefined); return last; },
        };
        tx.objectStore = () => store;
        queueMicrotask(() => queueMicrotask(() => { if (tx.aborted) tx.onabort?.(); else tx.oncomplete?.(); }));
        return tx;
      },
    };
    ctl.dbs.push(db);
    return db;
  };
  globalThis.indexedDB = {
    open() {
      ctl.opens++;
      const req = { result: null, error: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      setTimeout(() => {
        if (ctl.mode === 'hang') return;
        if (ctl.mode === 'error') { req.error = new Error('open error'); req.onerror?.(); return; }
        if (ctl.mode === 'blocked') { req.onblocked?.(); return; }
        req.result = makeDb();
        if (!created) req.onupgradeneeded?.();
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
  return {
    ctl, records,
    uninstall() { delete globalThis.indexedDB; },
    /** Simulate another tab asking this connection to close. */
    versionChange() { for (const d of ctl.dbs) if (!d.closed) d.onversionchange?.(); },
    /** Simulate the browser dropping the connection. */
    dropConnections() { for (const d of ctl.dbs) if (!d.closed) { d.closed = true; d.onclose?.(); } },
  };
}
