// Hand-rolled fake for the cache store (no dependency): a Map-backed localStorage with an optional character quota and
// fault injection. The cache store keeps every record in localStorage, so this is the only double it needs.

const quotaError = () => Object.assign(new Error('quota'), { name: 'QuotaExceededError' });

/**
 * Map-backed localStorage. Knobs on `ctl`, changeable at any time:
 *   quotaChars   limit on the summed key+value length (setItem throws QuotaExceededError past it)
 *   failNext     number of upcoming setItem calls that throw QuotaExceededError
 *   failGet      predicate (key) => boolean; a matching getItem throws a SecurityError
 */
export function makeFakeLocalStorage({ quotaChars = Infinity } = {}) {
  const m = new Map();
  const ctl = { quotaChars, failNext: 0, failGet: null };
  const used = () => { let n = 0; for (const [k, v] of m) n += k.length + v.length; return n; };
  const ls = {
    get length() { return m.size; },
    key: i => [...m.keys()][i] ?? null,
    getItem(k) {
      if (ctl.failGet && ctl.failGet(k)) throw Object.assign(new Error('blocked'), { name: 'SecurityError' });
      return m.has(k) ? m.get(k) : null;
    },
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
