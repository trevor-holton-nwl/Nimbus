/* =============================================================================
   ALERT PROFILE MATCHES — the always-on producer of "which alerts / orders does the
   active alert profile match". The Gantt highlight, the bell + drawer filter and the
   Alert Monitor page all read it; it is initialised once from App.init, independent of
   which tab is open.

   Never emits a Store event (Store.emit bumps the revision and re-renders everything):
   consumers use this module's own `subscribe(fn)` fanout.

   Inputs: Store.alerts / Store.tasks (plant scope), the active profile (user pref > role
   default > All alerts, via resolveActiveProfileId over AlertProfileClient.cached) and
   AlertAcksClient.cached. `current()` ignores the session "View as" override (the Gantt, bell,
   drawer and Orders follow the saved default); `view()` applies it (the Alert Monitor page only). `'__all__'` matches every plant
   alert but highlights nothing (taskIds / sevByTask / categoryByTask stay empty).
   ========================================================================== */

import { Store } from '../platform/store.mjs';
import type { StoreEvent } from '../platform/store.mjs';
import type { AlertAck, AlertCategory, AlertProfile } from '../platform/types.mjs';
import { AlertProfileClient } from './alert-profile-client.mjs';
import { AlertAcksClient } from './alert-acks-client.mjs';
import {
  ALL_ALERTS_PROFILE, ALL_ALERTS_PROFILE_ID, ALERT_CATEGORY_ORDER, categoryOf, alertOrderIds, categoryColorDecls, profileMatches, resolveActiveProfileId,
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

const CATEGORY_ORDER: readonly AlertCategory[] = ALERT_CATEGORY_ORDER;
const RELEVANT_PREFS = ['alertProfileByPlant', 'alertProfileGanttHighlight', 'alertsShowAcknowledged'] as const;
const DEBOUNCE_MS = 120;

let _inited = false;
let _rev = 0;
let _sessionProfile: string | null = null;
/** "Show alerts" focus from the Alert Monitor: the Gantt follows these orders instead of the profile. */
let _focusTaskIds: Set<string> | null = null;
let _prefSnapshot = '';
let _timer: ReturnType<typeof setTimeout> | null = null;
const _subs = new Set<() => void>();
const _fetching = new Set<string>();
/** Per-plant time of the last failed profile/ack fetch: no retry for FETCH_BACKOFF_MS (reset on plant change / success). */
const _failedAt = new Map<string, number>();
const FETCH_BACKOFF_MS = 30_000;

function _emptySet(): AlertProfileMatchSet {
  return {
    plant: null, profileId: ALL_ALERTS_PROFILE_ID, profile: ALL_ALERTS_PROFILE,
    alertIds: new Set(), taskIds: new Set(), sevByTask: new Map(), categoryByTask: new Map(),
    acked: new Map(), rev: 0,
  };
}

let _current: AlertProfileMatchSet = _emptySet();
/** The set with the session "View as" override applied (same object shape; equals `_current` minus focus when no override). */
let _view: AlertProfileMatchSet = _current;

function _prefs(): string {
  try { return JSON.stringify(RELEVANT_PREFS.map(k => Store.pref(k) ?? null)); } catch { return ''; }
}

function _plantToday(plant: string | null): Date {
  const now = Store.plantNow(plant) ?? new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Fetch a plant's cache once; after a failure wait FETCH_BACKOFF_MS before trying again; recompute when it lands. */
function _ensureLoaded(key: string, cached: unknown, load: () => Promise<unknown>): void {
  if (cached || _fetching.has(key)) return;
  const failed = _failedAt.get(key);
  if (failed !== undefined && Date.now() - failed < FETCH_BACKOFF_MS) return;
  _fetching.add(key);
  load().then(
    () => { _fetching.delete(key); _failedAt.delete(key); recompute(); },
    () => { _fetching.delete(key); _failedAt.set(key, Date.now()); },
  );
}

/** Replace the highlighted orders with the focused ones: severity / category come from the alerts that name them
 *  (as the order or as a peer / holder of a multi-order alert). `alertIds` stays profile-based. */
function _applyFocus(set: AlertProfileMatchSet, focus: ReadonlySet<string>): void {
  set.taskIds = new Set(focus);
  set.sevByTask = new Map();
  set.categoryByTask = new Map();
  const catSev = new Map<string, 'err' | 'warn'>();
  for (const a of Store.alerts) {
    const sev: 'err' | 'warn' = a.sev === 'err' ? 'err' : 'warn';
    const cat = categoryOf(a.type);
    for (const id of alertOrderIds(a)) {
      if (!focus.has(id)) continue;
      if (set.sevByTask.get(id) !== 'err') set.sevByTask.set(id, sev);
      const prev = set.categoryByTask.get(id);
      const prevSev = catSev.get(id);
      const better = !prev || (sev === 'err' && prevSev !== 'err')
        || (sev === prevSev && CATEGORY_ORDER.indexOf(cat) < CATEGORY_ORDER.indexOf(prev));
      if (better) { set.categoryByTask.set(id, cat); catSev.set(id, sev); }
    }
  }
}

/** Match the plant's alerts against `wanted` (a profile id, or '__all__'); `available` are the plant's profiles. */
function _buildSet(plant: string, wanted: string, available: AlertProfile[], acks: Map<string, AlertAck> | null | undefined): AlertProfileMatchSet {
  const set = _emptySet();
  set.plant = plant;
  if (acks) set.acked = acks;
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
  return set;
}

/** Write a profile's category colours as inline custom properties on `el`: the `--bar-pm-*` tokens every consumer reads
 *  (Gantt fills, legend, minimap, Alert Monitor) re-point at the profile's swatches with no other CSS. Writes only the
 *  keys that differ, never `setAttribute('style')`. The values are `var(--pal-...)`, resolved on `el`, so `el` must be
 *  `document.body` (where `body.dark` declares the dark swatches) or a descendant. No-op without a document or element. */
export function applyCategoryColors(el: HTMLElement | null | undefined, profile: AlertProfile | null | undefined): void {
  if (typeof document === 'undefined' || !el?.style) return;
  const decls = categoryColorDecls(profile);
  for (const key of Object.keys(decls)) {
    if (el.style.getPropertyValue(key) !== decls[key]) el.style.setProperty(key, decls[key]);
  }
}

/** JSON signature of a profile's decl map: `recompute` and the minimap compare it to skip redundant work. */
export function categoryColorSignature(profile: AlertProfile | null | undefined): string {
  return JSON.stringify(categoryColorDecls(profile));
}

let _colorSig = '';

export function recompute(): void {
  const plant = Store.selectedPlant ?? null;
  let set = _emptySet();
  let view = set;
  if (plant) {
    const profiles = AlertProfileClient.cached(plant);
    _ensureLoaded(`p:${plant}`, profiles, () => AlertProfileClient.list(plant));
    const acks = AlertAcksClient.cached(plant);
    _ensureLoaded(`a:${plant}`, acks, () => AlertAcksClient.load(plant));
    const available = profiles ?? [];
    const prefId = resolveActiveProfileId(plant, Store.userSettings as ProfileSettingsArg, Store.roleDefaults as ProfileSettingsArg, available);
    set = _buildSet(plant, prefId, available, acks);
    // "View as" builds a second set only when it differs from the default; otherwise the view shares the default's
    // content (a shallow copy, taken before the focus overrides below replace the task maps on `set` only).
    view = _sessionProfile && _sessionProfile !== prefId
      ? _buildSet(plant, _sessionProfile, available, acks)
      : { ...set };
  }
  if (_focusTaskIds) _applyFocus(set, _focusTaskIds);
  set.rev = ++_rev;
  view.rev = set.rev;
  _current = set;
  _view = view;
  const sig = categoryColorSignature(set.profile);
  if (sig !== _colorSig) {
    _colorSig = sig;
    applyCategoryColors(typeof document === 'undefined' ? null : document.body, set.profile);
  }
  for (const fn of Array.from(_subs)) { try { fn(); } catch { /* isolate subscribers */ } }
}

function _onStoreEvent(evt: StoreEvent): void {
  switch (evt.type) {
    case 'alerts:change':
      if (_timer) clearTimeout(_timer);
      _timer = setTimeout(() => { _timer = null; recompute(); }, DEBOUNCE_MS);
      break;
    case 'plant:selected':
      _failedAt.clear();
      _sessionProfile = null;
      _focusTaskIds = null;
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
  /** The saved-default view (session "View as" ignored): what the Gantt, bell, drawer and Orders follow. */
  current(): AlertProfileMatchSet { return _current; },
  /** The Alert Monitor's own view: `current()` with the session "View as" override applied. */
  view(): AlertProfileMatchSet { return _view; },
  recompute,
  subscribe(fn: () => void): () => void { _subs.add(fn); return () => { _subs.delete(fn); }; },
  /** "View as" override for this session (Alert Monitor page only; `current()` ignores it): until cleared (null) or the plant changes. */
  setSessionProfile(id: string | null): void {
    _sessionProfile = id;
    recompute();
  },
  sessionProfile(): string | null { return _sessionProfile; },
  /**
   * The Alert Monitor's "Show alerts" focus: while set, `taskIds` / `sevByTask` / `categoryByTask` describe these
   * orders (task ids and peers of the focused alerts) rather than the profile, so the Gantt follows the focused card.
   * null restores the profile. Fires the fanout; a plant change clears it.
   */
  setFocusTaskIds(ids: Iterable<string> | null): void {
    const next = ids ? new Set(ids) : null;
    if (!next && !_focusTaskIds) return;   // nothing to clear: no recompute, no fanout
    _focusTaskIds = next;
    recompute();
  },
};
