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
  /** `workcenter` is the PV header's own SAP work center ("the scheduling operation"); null/blank
   *  means the PV offers no machines (fail closed -> `pv_workcenter_mismatch`). */
  pv: Record<string, { valid_from: string | null; valid_to: string | null; lot_from: number | null; lot_to: number | null; key: string; workcenter?: string | null }>;
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
  | 'workcenter_unmapped' | 'pv_workcenter_mismatch' | 'no_operation_at_workcenter' | 'zero_runtime';

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
  if (validFrom && startDay < _dateOnlyMs(_parseValidityDate(validFrom))) return false;
  if (validTo && startDay > _dateOnlyMs(_parseValidityDate(validTo))) return false;
  return true;
}

/** Date-only validity bounds ('YYYY-MM-DD', the server's DATE columns) are calendar days,
 *  not instants. `new Date('2026-08-01')` parses as UTC midnight, which in the US is the
 *  previous LOCAL day (a validity window that starts a day early / ends a day early). Build
 *  the local date from the parts instead; anything else falls back to the native parser. */
function _parseValidityDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T00:00:00(?:\.0+)?Z?$)/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
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

/** The date a production version's validity window is judged on: the server save-gate rule
 *  (`COALESCE(original_start_received, basic_start_date)`, no finish fallback), else today.
 *  BASIC_START_DATE is the raw, un-snapped copy of the wire `original_start_date` (the locked
 *  value), never the placed `start_date` nor the calendar-snapped display baseline. */
function _validityDateFor(task: NimbusTask): Date {
  return _asDate(task.BASIC_START_DATE) ?? _asDate(task.original_start_date) ?? new Date();
}

function _asQuantity(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

/** One selectable (production version, machine) pair for an order. */
export interface EligiblePair { pv: string; machine: string; workcenter: string }

/** The one production-version normaliser for the client: null/undefined -> null; trimmed and uppercased; any
 *  non-blank value shorter than 4 characters is left-padded with zeros to 4 (blank stays ''). Mirrors the server's
 *  `db._norm_pv` exactly, so an unpadded stored order PV ('1', 'A1') still finds the padded master row ('0001', '00A1'). */
export function normPv(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).trim().toUpperCase();
  return cleaned && cleaned.length < 4 ? cleaned.padStart(4, '0') : cleaned;
}

/** What a drop onto `targetMachine` should do about the production version. */
export type DropDecision =
  | { kind: 'keep' }
  | { kind: 'switch'; pv: string }
  | { kind: 'choose'; pvs: string[] }
  | { kind: 'reject' };

/** Pure: every (PV, machine) pair the material offers on `validityDate` -- each PV row valid that day
 *  with a non-blank header work center, crossed with every machine at that work center. A machine may
 *  appear under several PVs; expired and blank-work-center PVs offer nothing. Sorted pv, then machine. */
export function computeEligiblePairs(map: RoutingRateMap, material: string, validityDate: Date,
                                     opts: { requireOps?: boolean; accept?: (pv: string, machine: string) => boolean } = {}): EligiblePair[] {
  const prefix = `${material}|`;
  const pairs: EligiblePair[] = [];
  for (const [key, row] of Object.entries(map.pv)) {
    if (!key.startsWith(prefix)) continue;
    const workcenter = row.workcenter;
    if (!workcenter) continue;
    if (!_withinValidity(validityDate, row.valid_from, row.valid_to)) continue;
    const pv = key.slice(prefix.length);
    // requireOps: the routing must have an operation at this work center (otherwise `resolve` would fail).
    if (opts.requireOps && !map.ops[`${row.key}|${workcenter}`]) continue;
    for (const [machine, machineWc] of Object.entries(map.machines)) {
      if (machineWc !== workcenter) continue;
      // requireOps + accept: the caller's own gate (`Runtime.resolve`) has the last word, so the list can never
      // offer a pair the gate then refuses (zero rate, zero quantity, any future step).
      if (opts.requireOps && opts.accept && !opts.accept(pv, machine)) continue;
      pairs.push({ pv, machine, workcenter });
    }
  }
  pairs.sort((a, b) => (a.pv < b.pv ? -1 : a.pv > b.pv ? 1 : a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : 0));
  return pairs;
}

/** Pure drop rule: keep the current PV when it covers the target machine; else switch when exactly one
 *  other PV covers it, choose when two or more do, reject when none does. */
export function dropDecision(pairs: EligiblePair[], currentPv: string | null | undefined, targetMachine: string): DropDecision {
  const covering = [...new Set(pairs.filter(p => p.machine === targetMachine).map(p => p.pv))].sort();
  if (covering.length === 0) return { kind: 'reject' };
  if (currentPv && covering.includes(currentPv)) return { kind: 'keep' };
  if (covering.length === 1) return { kind: 'switch', pv: covering[0] };
  return { kind: 'choose', pvs: covering };
}

export const Runtime = {
  /** Plant whose rate map `Runtime._rateMap` currently reflects (null = none/
   *  unknown) — mirrors `Persistence._rankMapsPlant`'s own freshness-field
   *  role. Set only on a true fetch success; left stale on a disabled plant,
   *  a network failure, or a non-ok response so a later freshness check
   *  keeps retrying instead of trusting an empty cache as current. */
  _rateMapPlant: null as string | null,
  _rateMap: null as RoutingRateMap | null,
  /** Monotonic load token. Every load() takes the next value up front and a continuation
   *  only installs its result while it is still the newest — a plant switch mid-fetch can no
   *  longer land plant A's rate map (and A's _rateMapPlant) after B's load began. */
  _loadSeq: 0,

  /** The client's one production-version normaliser (see the exported `normPv`). */
  normPv,

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
    // A reload for the SAME plant keeps the old map until the new one lands (a pick mid-reload must not resolve
    // against nothing); only a plant change, or no/disabled plant, clears it.
    if (plant !== Runtime._rateMapPlant) Runtime._rateMap = null;
    const seq = ++Runtime._loadSeq;

    if (!plant) {
      Runtime._rateMap = null;
      Runtime._rateMapPlant = null;
      return;
    }
    const row = Store.masterData?.plants?.find(p => p.plant === plant);
    if (!row?.routing_runtime_enabled) {
      Runtime._rateMap = null;
      Runtime._rateMapPlant = null;
      return;
    }
    try {
      const r = await Util.fetchTraced(`${Config.API_BASE}/routing/${encodeURIComponent(plant)}/rate-map`);
      if (seq !== Runtime._loadSeq) return;   // superseded by a newer load()
      if (r.ok) {
        const map = await r.json() as RoutingRateMap;
        if (seq !== Runtime._loadSeq) return;
        Runtime._rateMap = map;
        Runtime._rateMapPlant = plant;
      } else {
        // Non-ok (transient 5xx, corp-proxy pre-roll response) — treated the
        // same as a thrown fetch below: keep the old same-plant map (already
        // cleared above on a plant change) and leave _rateMapPlant as is.
        ErrorLog.warn('routing', `Rate map fetch for ${plant} returned ${r.status}; keeping the previous map`);
      }
    } catch (e) {
      if (seq !== Runtime._loadSeq) return;
      ErrorLog.warn('routing', `Rate map fetch failed for ${plant}: ${(e as Error).message}`);
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

    const pvValue = normPv(task.PRODUCTION_VERSION);
    if (!pvValue) return { ok: false, step: 'pv_missing' };

    const material = task.MATERIAL_NUMBER ?? '';
    const pvRow = map.pv[`${material}|${pvValue}`];
    if (!pvRow) return { ok: false, step: 'pv_not_found' };

    // Validity is judged on the SAP start as first received (backward scheduling OQ26), the same
    // date the server's save gate reads (see `_validityDateFor`), falling back to today.
    if (!_withinValidity(_validityDateFor(task), pvRow.valid_from, pvRow.valid_to)) {
      return { ok: false, step: 'pv_expired' };
    }

    const targetMachine = machine || task.MACHINE;
    if (!targetMachine) return { ok: false, step: 'no_machine' };
    const workcenter = map.machines[targetMachine];
    if (!workcenter) return { ok: false, step: 'workcenter_unmapped' };
    if (!pvRow.workcenter || pvRow.workcenter !== workcenter) return { ok: false, step: 'pv_workcenter_mismatch' };

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

  /** Memo for `eligiblePairs`: per rate-map object (a reload, or a test swapping `_rateMap`, invalidates it for
   *  free), keyed by material, validity day and the requireOps flag. Callers must not mutate the result. */
  _pairCache: new WeakMap<RoutingRateMap, Map<string, EligiblePair[]>>(),

  /** Every (PV, machine) pair the order's material offers, judged on the order's validity date. Same
   *  cross-plant cache guard as `resolve()`: a stale/other-plant map offers nothing. `requireOps` also drops
   *  pairs whose routing has no operation at the work center (those would fail `resolve`). */
  eligiblePairs(task: NimbusTask, opts: { requireOps?: boolean } = {}): EligiblePair[] {
    if (task.PLANT && task.PLANT !== Runtime._rateMapPlant) return [];
    const map = Runtime._rateMap ?? _EMPTY_MAP;
    const material = task.MATERIAL_NUMBER ?? '';
    const date = _validityDateFor(task);
    const key = `${material}|${_dateOnlyMs(date)}|${opts.requireOps ? `1|${_asQuantity(task['ORDER_QUANTITY_(GMEIN)'])}` : 0}`;
    let byKey = Runtime._pairCache.get(map);
    if (!byKey) { byKey = new Map(); Runtime._pairCache.set(map, byKey); }
    let pairs = byKey.get(key);
    if (!pairs) {
      // requireOps: the real gate decides each candidate (zero rate, zero quantity, expiry, mismatch...), so an
      // offered pair always resolves. The quantity is part of the verdict, so it joins the memo key below.
      const accept = opts.requireOps
        ? (pv: string, machine: string) => Runtime.resolve({ ...task, PRODUCTION_VERSION: pv }, machine).ok
        : undefined;
      pairs = computeEligiblePairs(map, material, date, { ...opts, accept });
      byKey.set(key, pairs);
    }
    return pairs;
  },

  /** True when a rate map is loaded for `plant` (an unloaded map makes `eligiblePairs` empty for every order). */
  hasMapFor(plant: string | null | undefined): boolean {
    return !!Runtime._rateMap && (!plant || plant === Runtime._rateMapPlant);
  },

  /** `dropDecision` over this order's own pairs and current PV, for a drop onto `machine`. */
  dropDecision(task: NimbusTask, machine: string): DropDecision {
    return dropDecision(Runtime.eligiblePairs(task, { requireOps: true }), normPv(task.PRODUCTION_VERSION), machine);
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
