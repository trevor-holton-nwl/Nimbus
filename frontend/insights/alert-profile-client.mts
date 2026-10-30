/* Alert-profile API client: per-plant cache (LRU of 3), stale-response guard and a
   private subscriber fanout. Never emits a Store event (Store.emit bumps the revision
   and re-triggers Utilization/Confidence); it only reads Store to notice plant switches. */
import { Config, Util } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import type { StoreEvent } from '../platform/store.mjs';
import type { AlertProfile, AlertProfileRule, AlertRanking, ProfileCategories } from '../platform/types.mjs';
import { createPlantLru, AlertApiError } from './plant-lru.mjs';

export interface AlertProfileInput {
  plant: string;
  name: string;
  description?: string;
  rules: AlertProfileRule[];
  ranking?: AlertRanking;
  categories?: ProfileCategories | null;
}

export interface AlertProfilePatch {
  plant: string;
  name?: string;
  description?: string;
  rules?: AlertProfileRule[];
  ranking?: AlertRanking;
  /** Explicit null reverts the profile to derived-from-rules categories. */
  categories?: ProfileCategories | null;
  expected_updated_at?: string | null;
}

const _cache = createPlantLru<AlertProfile[]>();
const _subs = new Set<() => void>();
let _lastPlant: string | null = Store.selectedPlant ?? null;

/** Throws AlertApiError; `code` is the string `detail` (name_taken / stale) when present. */
async function _fail(resp: Response): Promise<never> {
  let code: string | null = null;
  try {
    const body = await resp.clone().json();
    if (body && typeof body.detail === 'string') code = body.detail;
  } catch { /* non-JSON body */ }
  const parsed = await Util.parseBackendError(resp);
  throw new AlertApiError(parsed.message, code, resp.status);
}

function _notify(): void {
  for (const fn of Array.from(_subs)) { try { fn(); } catch { /* a bad subscriber must not break the fanout */ } }
}

async function list(plant: string, opts: { force?: boolean } = {}): Promise<AlertProfile[]> {
  if (!opts.force) { const hit = _cache.get(plant); if (hit) return hit; }
  const token = _cache.begin(plant);
  const resp = await Util.fetchTraced(`${Config.API_BASE}/alert-profiles?plant=${encodeURIComponent(plant)}`);
  if (!resp.ok) return _fail(resp);
  const body = await resp.json();
  const profiles: AlertProfile[] = Array.isArray(body?.profiles) ? body.profiles : [];
  // Out-of-order / invalidated response: do not overwrite what a newer request produced.
  if (!_cache.isCurrent(plant, token)) return _cache.get(plant) ?? profiles;
  _cache.set(plant, profiles);
  return profiles;
}

async function _write(plant: string, req: () => Promise<Response>): Promise<unknown> {
  const resp = await req();
  if (!resp.ok) return _fail(resp);
  const body: unknown = await resp.json();
  try { await list(plant, { force: true }); } catch { _cache.invalidate(plant); }
  _notify();
  return body;
}

const _json = (method: string, body: unknown): RequestInit =>
  ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const AlertProfileClient = {
  list,
  cached(plant: string): AlertProfile[] | null { return _cache.get(plant); },
  async create(p: AlertProfileInput): Promise<AlertProfile> {
    return await _write(p.plant, () => Util.fetchTraced(`${Config.API_BASE}/alert-profiles`, _json('POST', p))) as AlertProfile;
  },
  async update(id: string, patch: AlertProfilePatch): Promise<AlertProfile> {
    return await _write(patch.plant, () => Util.fetchTraced(`${Config.API_BASE}/alert-profiles/${encodeURIComponent(id)}`, _json('PUT', patch))) as AlertProfile;
  },
  async remove(id: string, plant: string): Promise<void> {
    await _write(plant, () => Util.fetchTraced(`${Config.API_BASE}/alert-profiles/${encodeURIComponent(id)}?plant=${encodeURIComponent(plant)}`, { method: 'DELETE' }));
  },
  invalidate(plant: string): void { _cache.invalidate(plant); },
  subscribe(fn: () => void): () => void { _subs.add(fn); return () => { _subs.delete(fn); }; },
};

// Leaving a plant drops its cache so coming back refetches (reading Store is fine; emitting is not).
Store.subscribe((evt: StoreEvent) => {
  if (evt.type !== 'plant:selected') return;
  const next = (evt.plant as string | null) ?? null;
  if (_lastPlant && _lastPlant !== next) AlertProfileClient.invalidate(_lastPlant);
  _lastPlant = next;
}, 'alert-profile-client');
