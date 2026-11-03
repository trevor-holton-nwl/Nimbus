// security/session.mjs — Session (Phase P4 of
// docs/architecture/domain-refactor-plan.md, which split schedule-data.mts
// (2,204 lines) into 3 domain files). The mandatory-login client session's
// pure state/API (currentUser/actor/isAdmin/allowedPlants/pref/setPref/
// signIn/signOut/refresh/onAuthDenied). Session's DOM/settings-pane half
// (gates, the user-settings modal, profile/password self-service — ~600
// lines that used to live inline in the same IIFE) stays in app.js as
// `SessionUIAdapter`, which owns the sole subscription to the
// `session:changed` event emitted below — mirrors the Phase 1
// Sandbox/SandboxAdapter split exactly. `Session.updateCachedUser(patch)` is
// the one small public method added for a reverse-direction need the
// original plan's own interface list didn't spell out:
// `SessionUIAdapter.saveProfile` (app.js) needs to merge a patch into the
// cached session blob after a successful profile PATCH, but the blob's
// localStorage key (`KEY`) is intentionally private to this module — same
// "small public method" resolution CLAUDE.md's Global Constraints prescribe
// for every reverse-direction need, never a bare `KEY` export or a
// `window`/`globalThis` reach-around.
//
// No cross-package dependency on scheduling/persistence.mjs or
// calendar/calendar-sync.mjs exists (verified fresh at this phase) — Session
// only needs Store, for role/plant-scoping resolvers wired at boot.
import { Config, Util, ErrorLog, Toast, Modal } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import type { TopLevelTab } from '../platform/types.mjs';

/** The subset of GET/POST /security/* fields this file reads/writes
 *  (brain.py's /security/login, /security/me, /security/me/settings). */
interface SessionUserBlob {
  username: string;
  role: string | null;
  is_admin?: boolean;
  allowed_plants?: string[] | null;
  first_name?: string | null;
  last_name?: string | null;
  settings?: Record<string, unknown>;
  role_settings?: Record<string, unknown>;
}

/** The cached shape written to localStorage under Session's own KEY —
 *  a superset of SessionUserBlob with is_admin always present post-cache. */
interface CachedSessionUser {
  username: string;
  role: string | null;
  is_admin?: boolean;
  allowed_plants: string[] | null;
  first_name: string | null;
  last_name: string | null;
  settings: Record<string, unknown>;
  role_settings: Record<string, unknown>;
  // Epoch ms this session was established (signIn only — refresh() carries it
  // forward, never resets it). Optional: sessions cached before this field
  // existed predate it, same reasoning as is_admin? above; isExpired() below
  // treats a missing/non-numeric value as expired rather than never-expiring.
  loggedInAt?: number;
}

/* =============================================================================
   SESSION — mandatory-login client session, pure state/API half. Backed by
   localStorage (mirrors the LangSwitcher get/set idiom in
   nimbus-intelligence.js), never the backend — the backend is the source of
   truth for the password check (POST /security/login); once authenticated,
   the session is just { username, role, ... } cached locally so a page reload
   doesn't force a re-login.
     Session.currentUser()   — { username, role, ... } | null
     Session.actor()         — username for X-User/x-user-email headers, else 'system'
     Session.isAdmin()       — true iff current user's role === 'admin' (or is_admin)
     Session.allowedPlants() — null (unrestricted) | string[] (role_plants scope)
     Session.canAccessTab(tab) — per-role top-level page visibility (Security >
       Roles "Page Access" toggles); admins always pass. DEFAULT_PAGE_ACCESS
       fills in for any tab a role hasn't customized.
     Session.pref(key) / .setPref(key, value) / .flushPrefs() — per-user
       settings: optimistic Store write + a debounced PATCH /security/me/settings
     Session.signIn(u, p)    — POST /security/login; persists session, emits
                                {type:'session:changed', kind:'signin'}
     Session.signOut(opts?)  — confirms if opts.hasPendingWork(), clears session + local planner data, emits kind:'signout', reloads
     Session.refresh()       — reconciles cached role/settings/plant-scope against
                                GET /security/me; emits kind:'refresh'
     Session.onAuthDenied()  — a gated request came back 403; re-reconciles via refresh()
     Session.updateCachedUser(patch) — merge `patch` into the cached session blob;
       the seam app.js's SessionUIAdapter.saveProfile uses instead of reaching into
       this module's private `KEY` constant directly.
   DOM/settings-pane code that used to live inline in this same IIFE (gates, the
   user-settings modal, profile/password self-service, personalization/workflow
   panes) stays in app.js as `SessionUIAdapter`, which owns the sole subscription
   to the `session:changed` event emitted below — mirrors the Phase 1
   Sandbox/SandboxAdapter split exactly.
   ========================================================================== */
export const Session = (() => {
  const KEY = 'nimbus.session';

  function currentUser(): CachedSessionUser | null {
    // Guard (not the `as string` assertion) so the type checker is satisfied
    // without relying on JSON.parse(null) throwing into the catch below — but
    // the try/catch itself stays wrapped around BOTH the read and the parse,
    // unlike the brief's own inline guard example, which would have dropped
    // it and let a malformed cached JSON string throw uncaught instead of
    // returning null (a real behavior regression this file's zero-behavior-
    // change discipline forbids).
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function actor(): string {
    const u = currentUser();
    return u ? u.username : 'system';
  }

  function isAdmin(): boolean {
    const u = currentUser();
    // Prefer the reconciled is_admin flag (set by refresh() from GET /security/me,
    // which mirrors the backend's require_admin grace) and fall back to the role
    // cached at login for sessions that predate a refresh.
    return !!u && (u.is_admin === true || u.role === 'admin');
  }

  // null = unrestricted (every plant); array = the caller's role_plants scope.
  // Mirrors isAdmin()'s fallback posture: trusts whatever was last cached
  // (login or refresh()) rather than blocking on a fresh network call.
  function allowedPlants(): string[] | null {
    const u = currentUser();
    return u && Array.isArray(u.allowed_plants) ? u.allowed_plants : null;
  }

  // Every page is on by default except Admin Cockpit. Must mirror
  // master_data.py's PAGE_ACCESS_KEYS / set_role_page_access default posture
  // and the Security > Roles tab's own copy in plant-and-administration.mts —
  // keep all three in sync.
  const DEFAULT_PAGE_ACCESS: Record<TopLevelTab, boolean> = {
    home: true, gantt: true, labor: true, alerts: true, masterdata: true, admin: false,
  };

  // Per-role top-level page visibility. Admins always pass (super-admin escape
  // hatch, same posture as isAdmin() itself) — this is UI-visibility gating
  // only, not endpoint-level enforcement (see brain.py's admin route note).
  // Deliberately reads ONLY role_settings (never the per-user settings
  // override) — unlike theme/lang, page access is a role-level control, not a
  // user preference. auth.get_role_settings() always returns {} for the
  // 'admin' role itself, so an admin-role user's own role_settings.pages is
  // never consulted — irrelevant here since isAdmin() already short-circuits.
  function canAccessTab(tab: TopLevelTab): boolean {
    if (isAdmin()) return true;
    const u = currentUser();
    const pages = (u?.role_settings?.pages ?? null) as Partial<Record<TopLevelTab, boolean>> | null;
    const override = pages?.[tab];
    return override ?? DEFAULT_PAGE_ACCESS[tab];
  }

  async function signIn(username: string, password: string): Promise<SessionUserBlob> {
    const res = await fetch(`${Config.API_BASE}/security/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      // Keep the HTTP status: the login screen maps 429/5xx to throttled/unavailable
      // messages instead of calling every failure "invalid password".
      const err = new Error(Util.errorDetailText(e.detail) || 'Invalid username or password') as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    const data = await res.json() as SessionUserBlob;
    // Per-user settings + role defaults are the authoritative DB blobs; the
    // login response may not carry them (only GET /security/me is guaranteed to),
    // so default to {} and let refresh() fill them from /security/me at boot.
    const settings = data.settings || {};
    const roleSettings = data.role_settings || {};
    localStorage.setItem(KEY, JSON.stringify({
      username: data.username, role: data.role,
      allowed_plants: data.allowed_plants ?? null,
      first_name: data.first_name || null, last_name: data.last_name || null,
      settings, role_settings: roleSettings,
      loggedInAt: Date.now(),
    }));
    Store.setUserSettings(settings, 'session-signin');
    Store.setRoleDefaults(roleSettings, 'session-signin');
    Store.emit({ type: 'session:changed', kind: 'signin' });
    return data;
  }

  // Wipes the planner's local working data (state cache, quarantined caches, command/pattern
  // history, queued calendar deletes, sessionStorage) so a shared PC leaves nothing behind.
  // Keeps display preferences (nimbus.theme / nimbus.locale) and does NOT touch the session
  // blob (signOut / clearExpired own that). Also used by admin "Reset client state".
  function clearLocalPlannerData(opts: { keepQueuedWork?: boolean } = {}): void {
    const quarantinePrefix = `${Config.LS_KEY}.quarantine.`;
    try {
      // 'nimbus.recentCmds' is no longer written (the command palette's recent list was write-only and is gone); it
      // stays on this list so a value left behind by an earlier build is still wiped on a shared PC.
      const toRemove: string[] = [Config.LS_KEY, 'nimbus.recentCmds', 'nimbus.patterns.v1'];
      // Queued unsent calendar deletes are work, not history: admin Reset keeps them.
      if (!opts.keepQueuedWork) toRemove.push('nimbus.calendar.pendingDeletes');
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(quarantinePrefix)) toRemove.push(k);
      }
      toRemove.forEach(k => { try { localStorage.removeItem(k); } catch { /* blocked */ } });
    } catch { /* storage unavailable */ }
    try { sessionStorage.clear(); } catch { /* storage unavailable */ }
  }

  // The shell supplies hasPendingWork/beforeClear so this file needs no import of
  // scheduling/persistence (which would add a security -> scheduling cycle).
  // Returns false when the planner cancels the unsaved-work confirm.
  async function signOut(opts: { hasPendingWork?: () => boolean; beforeClear?: () => void } = {}): Promise<boolean> {
    let pending = false;
    try { pending = !!opts.hasPendingWork?.(); } catch { pending = false; }
    if (pending) {
      const ok = await Modal.confirm({
        title:        Util.t('confirm.signout_title'),
        message:      Util.t('confirm.signout_unsaved'),
        confirmLabel: Util.t('confirm.signout_confirm'),
        tone:         'warn',
      });
      if (!ok) return false;
    }
    try { opts.beforeClear?.(); } catch { /* best effort */ }
    localStorage.removeItem(KEY);
    clearLocalPlannerData();
    try {
      Store.emit({ type: 'session:changed', kind: 'signout' });
    } finally {
      location.reload();
    }
    return true;
  }

  // 12-hour local cache lifetime, checked ONLY at the boot gate (app.js
  // _domReadyGate) — not a live in-tab timer, so a tab left open past 12h
  // keeps working until its next reload. A missing/non-numeric loggedInAt
  // (a session cached before this field existed, or a corrupted blob) counts
  // as expired rather than never-expiring — Date.now() - undefined is NaN,
  // and NaN > threshold is false, so this must be checked explicitly rather
  // than folded into the arithmetic comparison alone.
  function isExpired(): boolean {
    const u = currentUser();
    if (!u) return false;   // no session cached — not "expired", just signed out
    if (typeof u.loggedInAt !== 'number') return true;
    return Date.now() - u.loggedInAt > Config.SESSION_MAX_AGE_MS;
  }

  // Clears a stale/expired cached session pre-boot. Deliberately NOT signOut():
  // no event emit, no reload — the boot gate calls this once, synchronously,
  // before _domReadyGate falls through to the same showLoginScreen() path an
  // ordinary "not logged in" state already uses.
  // An expired login also wipes the local planner data exactly like Sign out does, but WITHOUT
  // the unsaved-work confirm (owner ruling 2026-10-06: the expired session's unsaved work is
  // discarded). Theme/locale are kept. Runs pre-boot (app.js gate), so no autosave/cache writer exists yet to cancel.
  function clearExpired(): void {
    localStorage.removeItem(KEY);
    clearLocalPlannerData();
  }

  // Reconcile the role cached at login (which the admin UI gates on) against the
  // backend's LIVE view via GET /security/me. The cached role can go stale — a DB
  // reseed, a role change, or a since-deleted identity — leaving the UI offering
  // admin controls that every request then 403s. Fire-and-forget at boot; also
  // called after a denied admin action. Never clobbers the cache on a transient
  // network/HTTP error (only a definitive answer updates it).
  async function refresh(): Promise<SessionUserBlob | null> {
    const u = currentUser();
    if (!u) return null;                       // signed out — nothing to reconcile
    try {
      // Cache-busted like /tasks (see DEPLOYMENT.md) — this URL never varies,
      // and the corp proxy caches GET responses keyed on URL regardless of
      // normal cache semantics, so an uncached fetch here would keep re-adopting
      // whatever settings blob was first ever fetched instead of DB truth.
      const r = await Util.fetchTraced(
        `${Config.API_BASE}/security/me?_cb=${Date.now()}`,
        { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } }
      );
      if (!r.ok) return null;
      const me = await r.json() as SessionUserBlob;
      // GET /security/me now carries the caller's own settings blob + their role's
      // defaults; cache both (localStorage = cache of DB truth so the app boots
      // offline from the cached blob) and push them into Store for Store.pref().
      const settings = me.settings || {};
      const roleSettings = me.role_settings || {};
      localStorage.setItem(KEY, JSON.stringify({
        username: me.username || u.username,
        role: me.role || null,
        is_admin: !!me.is_admin,
        allowed_plants: me.allowed_plants ?? null,
        first_name: me.first_name || null,
        last_name: me.last_name || null,
        settings, role_settings: roleSettings,
        loggedInAt: u.loggedInAt, // carried forward, never reset — the 12h clock is anchored to signIn()
      }));
      _adoptServerSettings(settings, 'session-refresh');
      Store.setRoleDefaults(roleSettings, 'session-refresh');
      // Plant-scope enforcement is Store-only business logic — safe to keep in
      // this pure module. The actual PlantSelector DOM refresh/toast, and the
      // admin-tab eviction (App._currentTab is DOM/UI state this module must
      // never read), happen in SessionUIAdapter's session:changed subscriber
      // (app.js) instead — this just reports the fact via the emitted event.
      let plantAccessChanged = false;
      const allowed = allowedPlants();
      if (allowed && Store.selectedPlant && !allowed.includes(Store.selectedPlant)) {
        Store.setSelectedPlant(null, 'session-refresh');
        plantAccessChanged = true;
      }
      Store.emit({ type: 'session:changed', kind: 'refresh', plantAccessChanged });
      return me;
    } catch { return null; }
  }

  // A backend admin gate returned 403 though the UI believed we were an admin —
  // the cached role is stale. Reconcile (which hides admin UI / navigates off the
  // Admin tab if we were demoted, via SessionUIAdapter's session:changed
  // subscriber) and tell the user plainly, rather than leaving a dead-end
  // "HTTP 403" in the panel.
  function onAuthDenied(): void {
    refresh();
    try { Toast.show(Util.t('sec.access_revoked'), 'error'); } catch {}
  }

  /* ── Self-service preference writes (Personalization / Workflow) ─────────
     setPref(key, value) is OPTIMISTIC (mirrors _savePlantHorizon's write-then-
     revert shape): Store.userSettings updates immediately so the UI reflects the
     change, then a debounced PATCH /security/me/settings persists it. On success
     we adopt the server's full merged blob and mirror it to the nimbus.session
     cache; on failure we revert only this batch's keys in Store AND the cache and
     Toast an i18n error. Multiple rapid setPref calls coalesce into one PATCH. */
  let _prefTimer: ReturnType<typeof setTimeout> | null = null;
  let _prefPending: Record<string, unknown> = {};   // key → queued new value for the next PATCH
  let _prefPrev: Record<string, unknown>    = {};   // key → pre-edit value, for revert on failure
  let _prefInflight: Record<string, unknown> = {};  // keys of the PATCH currently on the wire
  let _prefChain: Promise<void> = Promise.resolve(); // flushes run one at a time, in order
  let _prefFailures = 0;                             // bumped per failed batch; flushPrefs() diffs it

  // Adopt a server settings blob into Store (deleted keys disappear) while keeping
  // optimistic values a newer, not-yet-saved batch still owns, so a slow earlier
  // response can never visibly roll a newer edit back.
  // `ownInflight` is false for the response to the in-flight PATCH itself (the server
  // blob already reflects it, including deletions) and true for an unrelated refresh.
  function _adoptServerSettings(settings: Record<string, unknown>, source: string, ownInflight = true): void {
    Store.replaceUserSettings({ ...settings, ...(ownInflight ? _prefInflight : {}), ..._prefPending }, source);
  }

  async function _flushPrefs(): Promise<void> {
    const patch = _prefPending; _prefPending = {};
    const prev  = _prefPrev;    _prefPrev = {};
    if (!Object.keys(patch).length) return;
    _prefInflight = patch;
    try {
      const r = await Util.fetchTraced(`${Config.API_BASE}/security/me/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: patch }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(Util.errorDetailText(e.detail) || `HTTP ${r.status}`); }
      const updated = await r.json() as { settings?: Record<string, unknown> };
      // Server returns the full merged blob — adopt it as truth + mirror to cache.
      const settings = updated.settings || {};
      _adoptServerSettings(settings, 'settings-pref-saved', false);
      const u = currentUser();
      if (u) localStorage.setItem(KEY, JSON.stringify({ ...u, settings }));
    } catch (e) {
      _prefFailures++;
      // Revert only the keys this failed batch touched — in Store and the cache.
      // A key a newer queued batch also edits is left optimistic (that batch owns
      // it now) but its revert target is rebased to this batch's pre-edit value.
      const next: Record<string, unknown> = { ...Store.userSettings };
      const u = currentUser();
      const cached: Record<string, unknown> = (u && u.settings && typeof u.settings === 'object') ? { ...u.settings } : {};
      for (const k of Object.keys(prev)) {
        if (k in _prefPending) { _prefPrev[k] = prev[k]; continue; }
        if (prev[k] === undefined) { delete next[k]; delete cached[k]; }
        else { next[k] = prev[k]; cached[k] = prev[k]; }
      }
      Store.replaceUserSettings(next, 'settings-pref-revert');
      if (u) localStorage.setItem(KEY, JSON.stringify({ ...u, settings: cached }));
      try {
        Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
        ErrorLog.error('settings', `Save preference failed: ${(e as Error).message}`);
      } catch { /* logging must never break the revert */ }
    } finally {
      _prefInflight = {};
    }
  }

  // Chain the next flush after whatever is in flight (a patch is taken when its turn
  // starts, so edits made while an earlier PATCH is on the wire coalesce into one).
  function _enqueueFlush(): Promise<void> {
    _prefChain = _prefChain.then(_flushPrefs, _flushPrefs);
    return _prefChain;
  }

  function setPref(key: string, value: unknown): void {
    // Capture the pre-edit value once per batch (first writer wins) so a revert
    // restores the value from before this batch, not an intermediate optimistic one.
    if (!(key in _prefPrev)) _prefPrev[key] = Store.userSettings[key];
    _prefPending[key] = value;
    Store.setUserSettings({ [key]: value }, 'settings-pref');   // optimistic
    if (_prefTimer) clearTimeout(_prefTimer);
    _prefTimer = setTimeout(() => { _prefTimer = null; void _enqueueFlush(); }, 600);
  }

  // Flush any pending pref writes immediately and resolve once everything queued
  // or in flight has settled: true when no batch failed meanwhile, false otherwise
  // (the failed batch has already reverted Store/cache and toasted). The language
  // switch must await this BEFORE location.reload() — a reload cancels the
  // debounced timer and in-flight fetch, so without an explicit flush the DB
  // (and the session cache the flush refreshes on success) would never catch up —
  // and must NOT reload on false, or the failure toast is never seen.
  async function flushPrefs(): Promise<boolean> {
    if (_prefTimer) { clearTimeout(_prefTimer); _prefTimer = null; }
    const before = _prefFailures;
    await _enqueueFlush();
    return _prefFailures === before;
  }

  // Convenience read — resolves via Store.pref (user ?? role ?? system default).
  function pref(key: string): unknown { return Store.pref(key); }

  // Merge `patch` into the cached session blob and persist it. The narrow seam
  // app.js's SessionUIAdapter.saveProfile() uses to update first_name/last_name
  // in the cache after a successful PATCH /security/me, without reaching into
  // this module's private `KEY` constant — SessionUIAdapter is a consumer of
  // Session's public API only, same direction every other *UIAdapter follows.
  function updateCachedUser(patch: Partial<CachedSessionUser>): CachedSessionUser | null {
    const u = currentUser();
    if (!u) return null;
    const merged = { ...u, ...patch } as CachedSessionUser;
    localStorage.setItem(KEY, JSON.stringify(merged));
    return merged;
  }

  return {
    currentUser, actor, isAdmin, allowedPlants, canAccessTab, DEFAULT_PAGE_ACCESS,
    signIn, signOut, clearLocalPlannerData, refresh, onAuthDenied,
    setPref, flushPrefs, pref, updateCachedUser,
    isExpired, clearExpired,
  };
})();
