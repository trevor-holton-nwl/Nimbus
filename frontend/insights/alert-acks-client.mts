/* Alert-acknowledgement API client: per-plant cache (LRU of 3) of active acks keyed by
   alert id, stale-response guard and a private subscriber fanout. The server already
   filters expired acks. Never emits a Store event; it only reads Store for plant switches. */
import { Config, Util } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import type { StoreEvent } from '../platform/store.mjs';
import type { AlertAck } from '../platform/types.mjs';
import { createPlantLru, AlertApiError } from './plant-lru.mjs';

export interface AcknowledgeInput {
  plant: string;
  alert_id: string;
  reason: string;
  until?: string | null;
}

export type AckMap = Map<string, AlertAck>;

/** Matches the server's MAX_BULK_ACK_IDS (backend/alert_profiles/routes.py). */
const BULK_ACK_CHUNK = 500;

const _cache = createPlantLru<AckMap>();
const _subs = new Set<() => void>();
let _lastPlant: string | null = Store.selectedPlant ?? null;

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
  for (const fn of Array.from(_subs)) { try { fn(); } catch { /* isolate subscribers */ } }
}

async function load(plant: string, opts: { force?: boolean } = {}): Promise<AckMap> {
  if (!opts.force) { const hit = _cache.get(plant); if (hit) return hit; }
  const token = _cache.begin(plant);
  const resp = await Util.fetchTraced(`${Config.API_BASE}/alert-acks?plant=${encodeURIComponent(plant)}`);
  if (!resp.ok) return _fail(resp);
  const body = await resp.json();
  const map: AckMap = new Map();
  for (const a of (Array.isArray(body?.acks) ? body.acks : []) as AlertAck[]) map.set(a.alert_id, a);
  if (!_cache.isCurrent(plant, token)) return _cache.get(plant) ?? map;
  _cache.set(plant, map);
  return map;
}

async function _write(plant: string, req: () => Promise<Response>): Promise<unknown> {
  const resp = await req();
  if (!resp.ok) return _fail(resp);
  const body: unknown = await resp.json();
  try { await load(plant, { force: true }); } catch { _cache.invalidate(plant); }
  _notify();
  return body;
}

export const AlertAcksClient = {
  load,
  cached(plant: string): AckMap | null { return _cache.get(plant); },
  async acknowledge(p: AcknowledgeInput): Promise<AlertAck> {
    return await _write(p.plant, () => Util.fetchTraced(`${Config.API_BASE}/alert-acks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
    })) as AlertAck;
  },
  /** Chunks the ids into sequential POSTs of at most BULK_ACK_CHUNK (the server cap), then ONE forced refetch and
   *  ONE notify. Each chunk is transactional on the server; a failed chunk counts its ids as `failed` and the next chunk
   *  still runs. Throws the first AlertApiError only when every chunk failed (nothing was written, nothing notified). */
  async acknowledgeMany(plant: string, alertIds: string[], reason: string,
                        until: string | null): Promise<{ ok: number; failed: number }> {
    let ok = 0, failed = 0, firstErr: unknown = null;
    for (let i = 0; i < alertIds.length || i === 0; i += BULK_ACK_CHUNK) {
      const chunk = alertIds.slice(i, i + BULK_ACK_CHUNK);
      try {
        const resp = await Util.fetchTraced(`${Config.API_BASE}/alert-acks/bulk`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plant, alert_ids: chunk, reason, until }),
        });
        if (!resp.ok) await _fail(resp);
        const body = await resp.json() as { count?: number } | null;
        ok += typeof body?.count === 'number' ? body.count : chunk.length;
      } catch (e) {
        failed += chunk.length;
        if (firstErr === null) firstErr = e;
      }
    }
    if (ok === 0 && failed > 0) throw firstErr;
    try { await load(plant, { force: true }); } catch { _cache.invalidate(plant); }
    _notify();
    return { ok, failed };
  },
  async unacknowledge(plant: string, alertId: string): Promise<void> {
    await _write(plant, () => Util.fetchTraced(
      `${Config.API_BASE}/alert-acks/${encodeURIComponent(plant)}/${encodeURIComponent(alertId)}`, { method: 'DELETE' }));
  },
  invalidate(plant: string): void { _cache.invalidate(plant); },
  subscribe(fn: () => void): () => void { _subs.add(fn); return () => { _subs.delete(fn); }; },
};

Store.subscribe((evt: StoreEvent) => {
  if (evt.type !== 'plant:selected') return;
  const next = (evt.plant as string | null) ?? null;
  if (_lastPlant && _lastPlant !== next) AlertAcksClient.invalidate(_lastPlant);
  _lastPlant = next;
}, 'alert-acks-client');
