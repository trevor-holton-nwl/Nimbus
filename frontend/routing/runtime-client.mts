// frontend/routing/runtime-client.mts — Runtime, the client-side mirror of
// backend/routing/resolver.py's per-plant rate map (ROUTING_RUNTIME_DESIGN.md
// §8.1, P3 slice). Read-only: the server (backend/routing/resolver.py) stays
// authoritative for the persisted RUN_TIME/run_time_source/run_time_basis on
// every ingest/save/master-data change — this module exists only so a
// planner's drag/edit/override gets instant local feedback and an eligibility
// check without a round trip, via `Runtime.eligible`/`Runtime.hoursFor`.
//
// Same "never reject to the caller" contract as
// `Persistence.loadPriorityRankMaps` (frontend/scheduling/persistence.mts):
// `Runtime.load` always resolves, and a plant with the routing-runtime switch
// off (or unknown, or no plant selected at all) simply clears the cache and
// skips the fetch rather than erroring.
import { Config, Util, ErrorLog } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import type { NimbusTask } from '../platform/types.mjs';

/** §8.1's rate-map payload shape (`GET /routing/{plant}/rate-map`), verbatim
 *  from `backend/routing/resolver.py`'s `build_rate_map`/`_build_pv_map`/
 *  `_build_ops_map`. `pv` is keyed `"<material_id>|<production_version>"`;
 *  `ops` is keyed `"<material_id>|<task_list_type>|<routing_group>|<group_counter>|<sap_workcenter>"`
 *  (the same string `pv[...].key` is a prefix of, joined with the target
 *  work center) and carries a PRE-AGGREGATED `minutes_per_unit` — already
 *  summed across every counted operation at that routing+workcenter, at
 *  order_quantity=1. */
export interface RoutingRateMap {
  plant: string;
  generated_at: string;
  machines: Record<string, string>;
  pv: Record<string, { valid_from: string | null; valid_to: string | null; lot_from: number | null; lot_to: number | null; key: string }>;
  ops: Record<string, { minutes_per_unit: number }>;
}

/** §5.2's failure-step vocabulary, client subset (mirrors
 *  `backend/routing/resolver.py`'s `ROUTING_HOLD_STEPS`, minus `no_routing`,
 *  which has no client-side analog — the rate map simply omits an `ops` key
 *  for a routing/workcenter combination with nothing selected, which this
 *  module reports as `no_operation_at_workcenter` the same way `resolve_one`
 *  does for both "the routing doesn't exist" and "nothing at this work
 *  center survives filtering," since the client never sees routing rows
 *  directly — only the already-collapsed `ops` map). */
export type RuntimeResolveStep =
  | 'pv_missing' | 'pv_not_found' | 'pv_expired' | 'no_machine'
  | 'workcenter_unmapped' | 'no_operation_at_workcenter' | 'zero_runtime';

/** Lightweight local echo for an instant Inspector-line update — NOT an
 *  exhaustive mirror of the server's own `run_time_basis` shape (§8.1: the
 *  server remains authoritative and overwrites this on the next save). */
export interface RuntimeResolveBasis {
  workcenter: string;
  routingKey: string;
  source: 'routing';
}

export type RuntimeResolveResult =
  | { ok: true; hours: number; basis: RuntimeResolveBasis }
  | { ok: false; step: RuntimeResolveStep };

/** Fallback used whenever no rate map is cached (plant disabled, not yet
 *  loaded, or the last load failed) — every lookup against it simply misses,
 *  so `resolve()` needs no separate "no map at all" branch; it falls through
 *  the same step sequence a real map with nothing in it would produce. */
const _EMPTY_MAP: RoutingRateMap = { plant: '', generated_at: '', machines: {}, pv: {}, ops: {} };

/** `valid_from`/`valid_to` bound the order's SAP basic start date, inclusive;
 *  a null/absent bound is open — mirrors `resolver.py`'s `_within_validity`
 *  (day-level comparison, timezone-naive like the server's `DATE` columns). */
function _withinValidity(startDate: Date, validFrom: string | null, validTo: string | null): boolean {
  const startDay = _dateOnlyMs(startDate);
  if (validFrom && startDay < _dateOnlyMs(new Date(validFrom))) return false;
  if (validTo && startDay > _dateOnlyMs(new Date(validTo))) return false;
  return true;
}

function _dateOnlyMs(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function _asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

function _asQuantity(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

export const Runtime = {
  /** Plant whose rate map `Runtime._rateMap` currently reflects (null = none/
   *  unknown) — mirrors `Persistence._rankMapsPlant`'s own freshness-field
   *  role. Set only on a true fetch success; left stale on a disabled plant,
   *  a network failure, or a non-ok response so a later freshness check
   *  keeps retrying instead of trusting an empty cache as current. */
  _rateMapPlant: null as string | null,
  _rateMap: null as RoutingRateMap | null,

  /** Fetches `GET /routing/{plant}/rate-map` and caches it, but only for a
   *  plant whose `routing_runtime_enabled` switch is on (per
   *  `Store.masterData.plants[].routing_runtime_enabled` —
   *  ROUTING_RUNTIME_DESIGN.md §3.6/§8.1). A falsy plant, an unknown plant,
   *  or a disabled plant all clear the cache and return without fetching.
   *  Never throws/rejects to the caller — same contract as
   *  `Persistence.loadPriorityRankMaps`. */
  async load(plant: string | null): Promise<void> {
    // Drop the cached map SYNCHRONOUSLY, before anything else below runs
    // (including the falsy/unknown/disabled-plant early returns) — closes a
    // cross-plant race: without this, a switch from plant A to plant B left
    // `_rateMap` holding A's map for the whole duration of B's in-flight
    // fetch, so a `resolve()` call for a B-task in that window would be
    // evaluated against A's `machines`/`pv`/`ops`. `_rateMapPlant`'s own
    // assignments below are untouched — see its docstring for why it must
    // stay stale (not nulled) on a network failure/non-ok response.
    Runtime._rateMap = null;

    if (!plant) {
      Runtime._rateMapPlant = null;
      return;
    }
    const row = Store.masterData?.plants?.find(p => p.plant === plant);
    if (!row?.routing_runtime_enabled) {
      Runtime._rateMapPlant = null;
      return;
    }
    try {
      const r = await Util.fetchTraced(`${Config.API_BASE}/routing/${encodeURIComponent(plant)}/rate-map`);
      if (r.ok) {
        Runtime._rateMap = await r.json() as RoutingRateMap;
        Runtime._rateMapPlant = plant;
      } else {
        // Non-ok (transient 5xx, corp-proxy pre-roll response) — treated the
        // same as a thrown fetch below: drop the map, leave _rateMapPlant
        // stale so a later `_rateMapPlant !== plant` check retries rather
        // than wrongly trusting an empty cache as fresh.
        Runtime._rateMap = null;
      }
    } catch (e) {
      ErrorLog.warn('routing', `Rate map fetch failed for ${plant}: ${(e as Error).message}`);
      Runtime._rateMap = null;
    }
  },

  /** Pure, synchronous mirror of `resolver.py`'s `resolve_one`, read against
   *  ONLY the cached rate map (no fetch, no Store mutation) — §5.2 steps
   *  1-6 (collapsed: the rate map's `ops` entry already encodes step 6/7's
   *  filtering) + §5.4's formula. `machine` defaults to the task's own
   *  current machine when omitted/falsy. */
  resolve(task: NimbusTask, machine?: string): RuntimeResolveResult {
    // Cross-plant cache-race guard: if the task names a plant and it's not
    // the plant `_rateMap` was last successfully fetched for (a `load()`
    // for a different/newer plant is in flight, or hasn't landed yet),
    // treat the cache as if nothing were loaded at all — same _EMPTY_MAP
    // fallback an unloaded/disabled plant already falls through, so this
    // naturally surfaces as `pv_not_found`/`workcenter_unmapped`/etc.
    // rather than a fabricated new step. A task with no PLANT (some
    // synthetic/edit-path task shapes omit it) skips this check, matching
    // every other guarded call site in gantt.mts/orders.mts, which all key
    // off `task.PLANT` directly (no derived-plant fallback) before ever
    // calling into Runtime.
    const mapMatchesPlant = !task.PLANT || task.PLANT === Runtime._rateMapPlant;
    const map = mapMatchesPlant ? (Runtime._rateMap ?? _EMPTY_MAP) : _EMPTY_MAP;

    const pvValue = task.PRODUCTION_VERSION;
    if (!pvValue) return { ok: false, step: 'pv_missing' };

    const material = task.MATERIAL_NUMBER ?? '';
    const pvRow = map.pv[`${material}|${pvValue}`];
    if (!pvRow) return { ok: false, step: 'pv_not_found' };

    const startDate = _asDate(task.BASIC_START_DATE === undefined ? task.original_start_date : task.BASIC_START_DATE);
    if (startDate && !_withinValidity(startDate, pvRow.valid_from, pvRow.valid_to)) {
      return { ok: false, step: 'pv_expired' };
    }

    const targetMachine = machine || task.MACHINE;
    if (!targetMachine) return { ok: false, step: 'no_machine' };
    const workcenter = map.machines[targetMachine];
    if (!workcenter) return { ok: false, step: 'workcenter_unmapped' };

    const opRow = map.ops[`${pvRow.key}|${workcenter}`];
    if (!opRow) return { ok: false, step: 'no_operation_at_workcenter' };

    const quantity = _asQuantity(task['ORDER_QUANTITY_(GMEIN)']);
    // §5.4/§8.1: the client multiplies by quantity and rounds to the nearest
    // MINUTE — matching the server's own rounding point exactly (never round
    // the final hours value instead; `resolver.py`'s `_round_to_minute` also
    // rounds minutes, then divides by 60).
    const roundedMinutes = Math.round(opRow.minutes_per_unit * quantity);
    const hours = roundedMinutes / 60;
    if (hours <= 0) return { ok: false, step: 'zero_runtime' };

    return {
      ok: true,
      hours,
      basis: { workcenter, routingKey: pvRow.key, source: 'routing' },
    };
  },

  /** `resolve(...).ok` — the boolean a drop/edit guard needs. */
  eligible(task: NimbusTask, machine: string): boolean {
    return Runtime.resolve(task, machine).ok;
  },

  /** `resolve(...).hours`, or null on any failure step. */
  hoursFor(task: NimbusTask, machine?: string): number | null {
    const result = Runtime.resolve(task, machine);
    return result.ok ? result.hours : null;
  },
};
