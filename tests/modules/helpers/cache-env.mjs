// Shared set-up for tests that exercise Persistence's cache record (T3 write side, T4 restore side): a signed-in actor,
// a full Map-backed localStorage, and a clean CacheStore (Node has no indexedDB, so the store runs on its synchronous
// localStorage fallback and `_saveCache(); readRecord()` style assertions work without awaiting).
import { CacheStore } from '../../../frontend/platform/cache-store.mjs';
import { Util } from '../../../frontend/platform/foundation.mjs';
import { installFakeLocalStorage } from './cache-backend-fake.mjs';

export const CACHE_USER = 'planner';

/** Fresh localStorage + CacheStore + actor. Returns the fake-localStorage handle. */
export function resetCacheEnv({ user = CACHE_USER, backend = {} } = {}) {
  const lsf = installFakeLocalStorage();
  CacheStore._setBackendForTests(backend);
  Util.setActorResolver(user ? () => user : () => undefined);
  return lsf;
}

/** Simulate a page reload: the store forgets its in-memory state, localStorage (and any backend) survives. */
export async function simulateReload({ user = CACHE_USER, backend = {} } = {}) {
  CacheStore._setBackendForTests(backend);
  return CacheStore.ready(user);
}

/** The parsed cache record JSON the store currently holds for a plant, or null. */
export function readRecord(plant, user = CACHE_USER) {
  const raw = CacheStore.peek(plant);
  return raw && raw.user === user ? JSON.parse(raw.json) : null;
}
