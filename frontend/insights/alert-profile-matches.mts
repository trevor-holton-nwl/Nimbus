/* =============================================================================
   ALERT PROFILE MATCHES — the always-on producer of "which alerts / orders does the
   active alert profile match". The Gantt highlight, the bell + drawer filter and the
   Alert Monitor page all read it; it is initialised once from App.init, independent of
   which tab is open.

   Never emits a Store event (Store.emit bumps the revision and re-renders everything):
   consumers use this module's own `subscribe(fn)` fanout.

   Inputs: Store.alerts / Store.tasks (plant scope), the active profile (session "view
   as" override > user pref > role default > All alerts, via resolveActiveProfileId over
   AlertProfileClient.cached) and AlertAcksClient.cached. `'__all__'` matches every plant
   alert but highlights nothing (taskIds / sevByTask / categoryByTask stay empty).
   ========================================================================== */

import { Store } from '../platform/store.mjs';
import type { StoreEvent } from '../platform/store.mjs';
import type { AlertAck, AlertCategory, AlertProfile } from '../platform/types.mjs';
import { AlertProfileClient } from './alert-profile-client.mjs';
import { AlertAcksClient } from './alert-acks-client.mjs';
import {
  ALL_ALERTS_PROFILE, ALL_ALERTS_PROFILE_ID, categoryOf, profileMatches, resolveActiveProfileId,
} from './alert-profiles.mjs';

export interface AlertProfileMatchSet {
  plant: string | null;
  profileId: string;
  profile: AlertProfile;
  alertIds: Set<string>;
  taskIds: Set<string>;
  sevByTask: Map<string, 'err' | 'warn'>;
  /** Most severe matching category per task (err beats warn; tie → CATEGORY_ORDER). */
  categoryByTask: Map<string, AlertCategory>;
  acked: Map<string, AlertAck>;
  rev: number;
}

type ProfileSettingsArg = Parameters<typeof resolveActiveProfileId>[1];

const CATEGORY_ORDER: AlertCategory[] = ['capacity', 'conflicts', 'calendar', 'setup', 'exceptions'];
const RELEVANT_PREFS = ['alertProfileByPlant', 'alertProfileGanttHighlight', 'alertsShowAcknowledged'] as const;
const DEBOUNCE_MS = 120;

let _inited = false;
let _rev = 0;
let _sessionProfile: string | null = null;
let _prefSnapshot = '';
let _timer: ReturnType<typeof setTimeout> | null = null;
const _subs = new Set<() => void>();
const _fetching = new Set<string>();

function _emptySet(): AlertProfileMatchSet {
  return {
    plant: null, profileId: ALL_ALERTS_PROFILE_ID, profile: ALL_ALERTS_PROFILE,
    alertIds: new Set(), taskIds: new Set(), sevByTask: new Map(), categoryByTask: new Map(),
    acked: new Map(), rev: 0,
  };
}

let _current: AlertProfileMatchSet = _emptySet();

function _prefs(): string {
  try { return JSON.stringify(RELEVANT_PREFS.map(k => Store.pref(k) ?? null)); } catch { return ''; }
}

function _plantToday(plant: string | null): Date {
  const now = Store.plantNow(plant) ?? new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Fetch a plant's cache once (no retry loop on failure); recompute when it lands. */
function _ensureLoaded(key: string, cached: unknown, load: () => Promise<unknown>): void {
  if (cached || _fetching.has(key)) return;
  _fetching.add(key);
  load().then(() => { _fetching.delete(key); recompute(); }, () => { _fetching.delete(key); });
}

export function recompute(): void {
  const plant = Store.selectedPlant ?? null;
  const set = _emptySet();
  set.plant = plant;
  if (plant) {
    const profiles = AlertProfileClient.cached(plant);
    _ensureLoaded(`p:${plant}`, profiles, () => AlertProfileClient.list(plant));
    const acks = AlertAcksClient.cached(plant);
    _ensureLoaded(`a:${plant}`, acks, () => AlertAcksClient.load(plant));
    if (acks) set.acked = acks;
    const available = profiles ?? [];
    const prefId = resolveActiveProfileId(plant, Store.userSettings as ProfileSettingsArg, Store.roleDefaults as ProfileSettingsArg, available);
    const wanted = _sessionProfile ?? prefId;
    set.profileId = wanted === ALL_ALERTS_PROFILE_ID || available.some(p => p.id === wanted) ? wanted : ALL_ALERTS_PROFILE_ID;
    set.profile = set.profileId === ALL_ALERTS_PROFILE_ID
      ? ALL_ALERTS_PROFILE : available.find(p => p.id === set.profileId) ?? ALL_ALERTS_PROFILE;

    const today = _plantToday(plant);
    const tasks = Store.tasks;
    const all = set.profileId === ALL_ALERTS_PROFILE_ID;
    const catSev = new Map<string, 'err' | 'warn'>();   // severity of the alert that owns each task's category
    for (const a of Store.alerts) {
      const task = a.taskId ? tasks[a.taskId] : undefined;
      if (all) { set.alertIds.add(a.id); continue; }
      if (!profileMatches(a, task, set.profile, today)) continue;
      set.alertIds.add(a.id);
      if (!a.taskId) continue;
      set.taskIds.add(a.taskId);
      const sev: 'err' | 'warn' = a.sev === 'err' ? 'err' : 'warn';
      const prevSev = set.sevByTask.get(a.taskId);
      if (prevSev !== 'err') set.sevByTask.set(a.taskId, sev);
      const cat = categoryOf(a.type);
      const prevCat = set.categoryByTask.get(a.taskId);
      // Only err alerts can displace on severity; ties break on category order.
      if (!prevCat) { set.categoryByTask.set(a.taskId, cat); catSev.set(a.taskId, sev); continue; }
      const prevCatSev = catSev.get(a.taskId)!;
      const better = (sev === 'err' && prevCatSev !== 'err')
        || (sev === prevCatSev && CATEGORY_ORDER.indexOf(cat) < CATEGORY_ORDER.indexOf(prevCat));
      if (better) { set.categoryByTask.set(a.taskId, cat); catSev.set(a.taskId, sev); }
    }
      }
  set.rev = ++_rev;
  _current = set;
  for (const fn of Array.from(_subs)) { try { fn(); } catch { /* isolate subscribers */ } }
}

function _onStoreEvent(evt: StoreEvent): void {
  switch (evt.type) {
    case 'alerts:change':
      if (_timer) clearTimeout(_timer);
      _timer = setTimeout(() => { _timer = null; recompute(); }, DEBOUNCE_MS);
      break;
    case 'plant:selected':
      _sessionProfile = null;
      _prefSnapshot = _prefs();
      recompute();
      break;
    case 'settings:change': {
      const next = _prefs();
      if (next === _prefSnapshot) return;
      _prefSnapshot = next;
      recompute();
      break;
    }
  }
}

export const AlertProfileMatches = {
  /** Idempotent. Wires the Store + client subscriptions once. */
  init(): void {
    if (_inited) return;
    _inited = true;
    _prefSnapshot = _prefs();
    Store.subscribe(_onStoreEvent, 'alert-profile-matches');
    AlertProfileClient.subscribe(recompute);
    AlertAcksClient.subscribe(recompute);
    recompute();
  },
  current(): AlertProfileMatchSet { return _current; },
  recompute,
  subscribe(fn: () => void): () => void { _subs.add(fn); return () => { _subs.delete(fn); }; },
  /** "View as" override for this session: beats the pref until cleared (null) or the plant changes. */
  setSessionProfile(id: string | null): void {
    _sessionProfile = id;
    recompute();
  },
  sessionProfile(): string | null { return _sessionProfile; },
};
