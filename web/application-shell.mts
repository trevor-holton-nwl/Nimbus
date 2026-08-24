// application-shell.mjs — CQ-1 application-shell module.
// Owns ordered boot, login gating, top-level routing, screen lifecycle,
// plant selector, empty state. Composes the other six CQ-1 modules
// without duplicating their state, calculations, or endpoint calls. This is
// the last of the seven files — after this phase, app.js contains no module
// bodies of its own, only bridge wiring and boot orchestration (see the
// note at the top of app.js).
//
// `_bootMain()`/`_domReadyGate()` are deliberately NOT here. Per this phase's
// plan (Task 4 Step 3), they stay literally in app.js as "boot orchestration"
// — by the time they run, every module they call `.init()` on (including
// this file's own `App`, `PlantSelector`) is already
// available in app.js's own scope via its seven bridge destructures, so
// moving the boot sequence here would buy nothing and would strand
// `App._bootMain = _bootMain` (the linkage `showLoginScreen`, below, calls)
// on the wrong side of the module boundary for no reason. `App._bootMain` is
// assigned from app.js after this module loads; mutating a property onto the
// SAME `App` object export works identically to how the pre-split code always
// did it (both were bare identifiers in one IIFE scope; an imported binding
// to a mutable object behaves the same way for property writes).
//
// `Settings` (the per-user settings catalog: personalization/workflow keys,
// their system defaults, and tier/region metadata) also lives here, not in
// app.js: it is not one of CQ-1's 14 tracked modules and isn't named in this
// task's Interfaces list, but app.js's DI-seam wiring
// (`Store.setSettingsDefaultsResolver(() => Settings.DEFAULTS)`) needs
// `Settings.DEFAULTS`, and Settings itself has no state or behavior beyond
// this static catalog — something has to own it once app.js stops defining
// module bodies, and `SessionUIAdapter`'s Personalization/Workflow panes are
// its only real reader. Exported back to app.js via the bridge, same as
// `App`/`Timeline`/etc.
//
// TypeScript migration Phase 5 Task 1 converts this file to real TypeScript —
// the last of the seven CQ-1 modules (see docs/typescript_migration.md). Two
// real (not `NIMBUS`-ambient) findings surfaced during conversion:
//   - `Dashboard._chartToday` (the resize handler's home-tab branch) was dead
//     code — grep + `git log -S` across the whole repo's history confirm no
//     commit ever assigned `Dashboard._chartToday` anything, predating even
//     the CQ-1 split. Dashboard (schedule-workbench.mts, out of this task's
//     scope) has no such property, so the reference doesn't compile against
//     its real type. Removed — it was always a no-op at runtime.
//   - `Table._api.sizeColumnsToFit()` (Orders sub-tab activation) needed a
//     real method added to `NimbusVendor.AgGridApi` in web/types/vendor.d.ts
//     (not just this file's own three declared files) — see that interface's
//     own doc comment for the established "add exactly what a real call site
//     uses" convention this follows.
/* global NIMBUS */
// NIMBUS is the classic-script global app.js's IIFE assigns its return value
// to (`const NIMBUS = (function () {...})()`) — a bare reference to it
// resolves correctly from inside a real ES module sharing the same page
// realm, the same idiom already established in schedule-workbench.mjs and
// plant-and-administration.mjs (see their own `/* global NIMBUS */` notes and
// docs/architecture/cq1-compatibility-inventory.md). Used below only for
// cross-file calls into nimbus-intelligence.js's DarkMode/LangSwitcher (which
// never move into any CQ-1 file) and — per this task's "moved verbatim"
// mandate — the pre-existing `NIMBUS.Timeline`/`.TimelineNav`/`.Table`/
// `.Inspector` indirections inside `SessionUIAdapter`, left exactly as they
// were even though Timeline/TimelineNav/Table are now also directly imported
// above (the same "no further change needed" idiom Phase 3/4 used for every
// other now-same-file forward reference).
import { Config, Util, ErrorLog, Toast, Modal } from './application-foundation.mjs';
import type { VirtualList } from './application-foundation.mjs';
import { Store } from './schedule-state.mjs';
import { Alerts, Engine } from './schedule-services.mjs';
import { Persistence, Session } from './schedule-data.mjs';
import { Timeline, TimelineNav, DependencyOverlay, Table, Hierarchy, GanttFilter, Dashboard, AlertsUIAdapter } from './schedule-workbench.mjs';
import { AdminCockpit, Plant, ProdLines, LaborPlanning } from './plant-and-administration.mjs';
import { MaterialGrids } from './master-data-grids.mjs';
import type { TopLevelTab, GanttSubTab, MasterSubTab, LaborSubTab, PriorityFieldMeta } from './types.mjs';

// -- Local type declarations (Phase 5 conversion; scoped to this file) ------

/** Settings.CATALOG entry shape — see the header comment above the CATALOG
 *  array below for the meaning of each field. */
interface SettingsCatalogEntry {
  key: string;
  category: 'personalization' | 'workflow' | 'profile';
  type: string;
  default: unknown;
  tier: 'user' | 'role' | 'system';
  region: boolean;
}

/** The subset of Session.currentUser()'s cached-session-blob shape this file
 *  reads. schedule-data.mts's own CachedSessionUser (the full shape) is not
 *  exported — every consumer scopes its own local view onto it, the same
 *  "local interface per file" convention that file's own SessionUserBlob
 *  already follows. Structurally compatible with (a subset of) the real
 *  return type, so no import/cast is needed at call sites. */
interface SessionUserView {
  username: string;
  role: string | null;
  first_name: string | null;
  last_name: string | null;
}

/** Session.pref('landingView') shape — the user's saved default landing tab
 *  + (tab-dependent) sub-view. */
interface LandingViewPref {
  tab?: string;
  sub?: string;
}

/** Session.pref('optimizerDefaults') shape. Duplicated (not imported) from
 *  schedule-workbench.mts's own non-exported OptimizerDefaults local
 *  interface of the same shape — that type isn't part of that module's
 *  public surface, so each file scopes its own view, same as
 *  SessionUserView above. */
interface OptimizerDefaultsPref {
  mode?: string;
  preset?: string;
  respectFirmed?: boolean;
  respectCalendar?: boolean;
}

/** _initPinnedCombo's options bag (pinned-plants / pinned-lines comboboxes). */
interface PinnedComboOptions {
  inputId: string;
  dropdownId: string;
  listId: string;
  key: string;
  optionsFn(): string[];
  noneMsg: string;
  afterChange?(): void;
}

/** PATCH /security/me (brain.py) success response — only the fields this
 *  file reads (no response_model= yet on this endpoint — see Phase 4's own
 *  local-interface precedent in schedule-data.mts for non-modeled endpoints). */
interface SecurityMeResponse {
  first_name?: string | null;
  last_name?: string | null;
}

/** Marks a DOM node this file has already wired a listener onto — guards
 *  against double-binding on repeated calls (modal reopen, pane rebuild). */
type WiredElement = HTMLElement & { _wired?: boolean };

/* =============================================================================
   SETTINGS — per-user settings catalog + system defaults (single source of
   truth on the frontend; mirrors the backend contract).

   CATALOG entry shape: { key, category, type, default, tier, region }
     category : 'personalization' | 'workflow' | 'profile'
     type     : coarse editor/value hint for the (later) settings UI
     default  : the SYSTEM default — last link in the resolution chain
     tier     : the LOWEST tier that may SET the key ('user' | 'role' | 'system').
                Every key here is user-settable, so all are 'user'; roles supply
                defaults for all EXCEPT the three "user tier only" workflow keys
                (gridLayout / pinnedPlants / pinnedLines), which are inherently
                per-person and never role-overridable.
     region   : true only for keys eligible for the (NO-OP today) {plant} region
                fallback — timezone & firstDayOfWeek.
   timeFormat / dateFormat / timezone are DISPLAY-ONLY (they change how values
   render, never the stored data).
   ========================================================================== */
const Settings = (() => {
  const CATALOG: SettingsCatalogEntry[] = [
    // ── Personalization ────────────────────────────────────────────────
    // (category MUST match the modal pane the control renders in — see
    //  _renderPersonalizationPane / _renderWorkflowPane below.)
    { key: 'theme',        category: 'personalization', type: 'enum',   default: 'light', tier: 'user', region: false },
    { key: 'language',     category: 'personalization', type: 'enum',   default: 'en',    tier: 'user', region: false },
    { key: 'defaultPlant', category: 'personalization', type: 'plant',  default: null,    tier: 'user', region: false },
    { key: 'landingView',  category: 'personalization', type: 'object', default: null,    tier: 'user', region: false },
    // gridLayout / pinnedPlants / pinnedLines are USER-TIER ONLY — inherently
    // per-person, so roles never supply defaults for them.
    { key: 'gridLayout',   category: 'personalization', type: 'object', default: null, tier: 'user', region: false },
    { key: 'pinnedPlants', category: 'personalization', type: 'array',  default: [],   tier: 'user', region: false },
    { key: 'pinnedLines',  category: 'personalization', type: 'array',  default: [],   tier: 'user', region: false },
    // ── Workflow ───────────────────────────────────────────────────────
    { key: 'timeFormat',        category: 'workflow', type: 'enum',     default: '12h',              tier: 'user', region: false },
    { key: 'dateFormat',        category: 'workflow', type: 'enum',     default: 'M j, Y',           tier: 'user', region: false },
    { key: 'timezone',          category: 'workflow', type: 'timezone', default: 'America/New_York', tier: 'user', region: true  },
    { key: 'firstDayOfWeek',    category: 'workflow', type: 'enum',     default: 0,                  tier: 'user', region: true  },
    { key: 'optimizerDefaults', category: 'workflow', type: 'object',   default: null,               tier: 'user', region: false },
  ];

  // { key: default } map derived from CATALOG (last link in Store.pref precedence).
  const DEFAULTS: Record<string, unknown> = {};
  for (const e of CATALOG) DEFAULTS[e.key] = e.default;

  const _byKey: Record<string, SettingsCatalogEntry> = {};
  for (const e of CATALOG) _byKey[e.key] = e;

  return {
    CATALOG,
    DEFAULTS,
    isRegion(key: string): boolean   { return !!(_byKey[key] && _byKey[key].region); },
    byCategory(cat: string): SettingsCatalogEntry[] { return CATALOG.filter(e => e.category === cat); },
  };
})();

/* =============================================================================
   SESSION UI ADAPTER — DOM/settings-pane remnant of the mandatory-login client
   session (CQ-1 Phase 2 Task 5). Session's pure state/API half (currentUser/
   actor/isAdmin/allowedPlants/pref/setPref/flushPrefs/signIn/signOut/refresh/
   onAuthDenied/updateCachedUser) lives in schedule-data.mjs, bridged in as the
   `Session` import above. This adapter owns everything that touches the DOM:
   gates (per-role tab visibility, header user-settings button, error-log badge),
   the User Settings modal (tab switching, Personalization/Workflow panes,
   Profile self-service, password change), all built on top of Session's
   public API. Mirrors the Phase 1 Sandbox/SandboxAdapter split exactly:
   `Session.signIn`/`signOut`/`refresh` emit `{type:'session:changed', kind}`
   instead of calling `_applyGates()`/DOM code inline; `SessionUIAdapter.init()`
   (called once from `_bootMain()`, alongside `SandboxAdapter.init()`) is the
   sole subscriber.
     SessionUIAdapter.init()        — subscribe to session:changed (call once, at boot)
     SessionUIAdapter._applyGates() — re-hides tab buttons per the current
                                       role's page access (Security > Roles),
                                       plus the header user-settings button /
                                       error-log badge for non-admins; called
                                       after every session:changed AND once
                                       explicitly at boot (see _bootMain) so a
                                       resumed cached session (which never
                                       fires signIn(), so never emits) re-gates
                                       too.
   ========================================================================== */
const SessionUIAdapter = {
  init(): void {
    Store.subscribe(evt => {
      if (evt.type !== 'session:changed') return;
      SessionUIAdapter._applyGates();
      if (evt.kind === 'refresh') {
        // Mirrors the pre-split refresh()'s own DOM-adjacent tail exactly — Session
        // (schedule-data.mjs) only reports the FACTS (isAdmin(), plantAccessChanged);
        // every actual DOM/tab-navigation effect happens here.
        try { if (typeof PlantSelector !== 'undefined') PlantSelector._refreshOptions(); } catch {}
        // If we just lost access to the tab we're sitting on, leave it.
        if (typeof App !== 'undefined' && !Session.canAccessTab(App._currentTab)) {
          try { App.goto(App._firstAccessibleTab()); } catch {}
        }
        try {
          if (evt.plantAccessChanged) Toast.show(Util.t('sec.plant_access_changed'), 'warn');
          if (typeof PlantSelector !== 'undefined') PlantSelector._reflectSelection();
        } catch {}
      }
    }, 'SessionUIAdapter');
  },

  _applyGates(): void {
    document.querySelectorAll<HTMLElement>('.tab-btn[data-tab]').forEach(btn => {
      const tab = btn.dataset.tab as TopLevelTab | undefined;
      if (tab) btn.hidden = !Session.canAccessTab(tab);
    });
    SessionUIAdapter._renderUserButton();
    try { ErrorLog.renderBadge(); } catch {}
  },

  // Avatar initials (Command Band re-skin, Task 4) — first_name/last_name are
  // the primary source; falls back to username-derived initials, then to
  // null (caller renders the static /Images/user.png icon) if there is no
  // name or username to derive anything from at all.
  _initialsFor(u: SessionUserView): string | null {
    const first = (u.first_name || '').trim();
    const last  = (u.last_name  || '').trim();
    if (first && last) return (first[0] + last[0]).toUpperCase();
    if (first) return first.slice(0, 2).toUpperCase();
    if (last)  return last.slice(0, 2).toUpperCase();
    const uname = (u.username || '').trim();
    if (!uname) return null;
    // "john.doe" / "john_doe" / "john doe" → JD; a bare "jdoe" → first 2 chars.
    const parts = uname.split(/[.\s_-]+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : uname.slice(0, 2)).toUpperCase();
  },

  // Renders in place into #user-settings-btn — no id/class change, no change
  // to the click wiring below. Uses an inline style (not a new styles.css
  // rule, out of scope for this task) sized to match the existing
  // .user-icon-avatar 22px circle, colored with the same --chrome-* tokens
  // the dark command band already uses elsewhere (not a new hardcoded color).
  _renderAvatar(btn: HTMLElement, u: SessionUserView): void {
    const initials = SessionUIAdapter._initialsFor(u);
    if (!initials) {
      if (!btn.querySelector('img.user-icon-avatar')) {
        btn.innerHTML = '<img src="/Images/user.png" alt="" class="user-icon-avatar">';
      }
      return;
    }
    btn.innerHTML =
      `<span class="user-icon-avatar" aria-hidden="true" style="` +
      `display:flex;align-items:center;justify-content:center;` +
      `background:var(--chrome-accent);color:var(--chrome-accent-fg);` +
      `font-family:'JetBrains Mono',monospace;font-size:9.5px;font-weight:700;` +
      `line-height:1;">${initials}</span>`;
  },

  // Populates/hides the header user-settings icon button (#user-settings-btn, static
  // markup in index.html) and wires its click (once) to open the User Settings modal.
  _renderUserButton(): void {
    const btn = document.getElementById('user-settings-btn') as WiredElement | null;
    if (!btn) return;
    const u = Session.currentUser();
    btn.hidden = !u;
    if (!u) return;
    SessionUIAdapter._renderAvatar(btn, u);
    if (!btn._wired) {
      btn._wired = true;
      btn.addEventListener('click', () => {
        const current = Session.currentUser();
        if (!current) return;
        const signedInEl = document.getElementById('us-signed-in-as');
        const roleEl = document.getElementById('us-role');
        const firstEl = document.getElementById('us-first-name') as HTMLInputElement | null;
        const lastEl = document.getElementById('us-last-name') as HTMLInputElement | null;
        if (signedInEl) signedInEl.textContent = Util.t('sec.signed_in_as', { username: current.username });
        if (roleEl) roleEl.textContent = current.role;
        if (firstEl) firstEl.value = current.first_name || '';
        if (lastEl) lastEl.value = current.last_name || '';
        // Build the Personalization / Workflow controls fresh so they reflect
        // the current resolved prefs each time the modal opens.
        try { SessionUIAdapter._renderSettingsPanes(); } catch (e) { ErrorLog.error('settings', `Render settings panes failed: ${(e as Error).message}`); }
        Modal.open('modal-user-settings');
      });
    }
    const signOutBtn = document.getElementById('us-signout-btn') as WiredElement | null;
    if (signOutBtn && !signOutBtn._wired) {
      signOutBtn._wired = true;
      signOutBtn.addEventListener('click', Session.signOut);
    }
    const saveBtn = document.getElementById('us-save-btn') as WiredElement | null;
    if (saveBtn && !saveBtn._wired) {
      saveBtn._wired = true;
      saveBtn.addEventListener('click', SessionUIAdapter.saveProfile);
    }
    const changePwBtn = document.getElementById('us-change-password-btn') as WiredElement | null;
    if (changePwBtn && !changePwBtn._wired) {
      changePwBtn._wired = true;
      changePwBtn.addEventListener('click', SessionUIAdapter.changePassword);
    }
    // Wire the User Settings tab bar (Personalization / Workflow / Profile).
    // _renderSettingsPanes() populates the Personalization/Workflow panes on
    // modal open; this only toggles which pane + button is active. Wired once.
    document.querySelectorAll<WiredElement>('#modal-user-settings [data-us-tab]').forEach(tabBtn => {
      if (tabBtn._wired) return;
      tabBtn._wired = true;
      tabBtn.addEventListener('click', () => SessionUIAdapter._showUserTab(tabBtn.getAttribute('data-us-tab') as string));
    });
  },

  // Toggle the active User Settings tab: highlight the button and reveal only
  // the matching pane (#us-tab-<name>). Names mirror Settings category ids.
  _showUserTab(name: string): void {
    document.querySelectorAll<HTMLElement>('#modal-user-settings [data-us-tab]').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-us-tab') === name);
    });
    ['personalization', 'workflow', 'profile'].forEach(n => {
      const body = document.getElementById('us-tab-' + n);
      if (body) body.hidden = (n !== name);
    });
  },

  /* ── Personalization + Workflow panes (Phase-1 self-service settings) ─────
     Rebuilt each time the modal opens so every control reflects the current
     resolved pref (Store.pref = user ?? role ?? system default). Labels use
     Util.t() inline — App.init()'s one-shot [data-i18n] sweep never runs over these
     dynamically-inserted nodes. Each control persists via Session.setPref()
     and, where it changes the running app, applies the effect immediately. */
  _optTag(value: string | number, label: string, selected: unknown): string {
    const v = String(value);
    return `<option value="${v}"${v === String(selected) ? ' selected' : ''}>${label}</option>`;
  },

  // Repaint the display surfaces whose datetime labels are baked at render time,
  // so a timeFormat/dateFormat change is reflected without waiting for the next
  // natural re-render. Best-effort — never throws into the change handler.
  _repaintDisplayFormat(): void {
    if (typeof NIMBUS === 'undefined') return;
    // Timeline bar tooltips + blackout titles are baked at build time.
    try { if (NIMBUS.Timeline?.rebuild) NIMBUS.Timeline.rebuild(); } catch {}
    try { if (NIMBUS.TimelineNav?.render) NIMBUS.TimelineNav.render(); } catch {}
    // AG Grid date columns render through pref-aware valueFormatters — force a
    // cell repaint so the new format shows without an edit/scroll.
    try { if (NIMBUS.Table?._api) NIMBUS.Table._api.refreshCells({ force: true }); } catch {}
    // Inspector schedule rows are baked into innerHTML — re-render the current
    // selection so its dates repaint too.
    try {
      const id = NIMBUS.Inspector?._currentId;
      if (id && NIMBUS.Inspector?._render) {
        const task = NIMBUS.Store?.tasks?.[id];
        if (task) NIMBUS.Inspector._render(task);
      }
    } catch {}
  },

  _htmlEsc(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  // Landing-view tab choices, filtered by per-role page access (Security >
  // Roles "Page Access" toggles) and their sub-views.
  _landingTabDefs(): Array<[string, string]> {
    const defs: Array<[TopLevelTab, string]> = [
      ['home',       Util.t('tab.home')],
      ['gantt',      Util.t('tab.gantt')],
      ['labor',      Util.t('us.tab_labor')],
      ['masterdata', Util.t('tab.masterdata')],
      ['admin',      Util.t('tab.admin')],
    ];
    return defs.filter(([tab]) => Session.canAccessTab(tab));
  },
  _landingSubDefs(tab: string): Array<[string, string]> | null {
    if (tab === 'gantt')      return [['timeline', Util.t('us.landing_timeline')], ['orders', Util.t('tab.table')]];
    if (tab === 'masterdata') return [
      ['lines',          Util.t('tab.machine')],
      ['plant',          Util.t('tab.plant')],
      ['material',       Util.t('tab.materials')],
      ['material-plant', Util.t('tab.material_plant')],
    ];
    return null;   // home / labor / admin land on the tab with no sub-view here
  },

  // Render the small removable list of pinned values below a pinned combobox.
  _renderPinnedList(listEl: HTMLElement | null, key: string): void {
    if (!listEl) return;
    const items = ((Session.pref(key) as string[] | undefined) ?? []).slice();
    if (!items.length) {
      listEl.innerHTML = `<div class="us-pinned-empty">${Util.t('us.pinned_none')}</div>`;
      return;
    }
    listEl.innerHTML = items.map(v => {
      const safe = SessionUIAdapter._htmlEsc(v);
      return `<span class="us-pinned-item"><span class="us-pinned-name">${safe}</span>` +
        `<button type="button" class="us-pin-remove" data-val="${safe}" title="${Util.t('us.pin_remove')}" aria-label="${Util.t('us.pin_remove')}">×</button></span>`;
    }).join('');
  },

  /* Searchable pin picker (scale-safe — never a chip selector). optionsFn()
     supplies the full candidate list; already-pinned values are filtered out.
     Choosing appends to Session.pref(key) via setPref; the removable list
     handles unpin. afterChange() lets the caller refresh the affected surface
     immediately. */
  _initPinnedCombo({ inputId, dropdownId, listId, key, optionsFn, noneMsg, afterChange }: PinnedComboOptions): void {
    const input    = document.getElementById(inputId) as HTMLInputElement | null;
    const dropdown = document.getElementById(dropdownId) as HTMLElement | null;
    const listEl   = document.getElementById(listId) as HTMLElement | null;
    if (!input || !dropdown || !listEl) return;
    let filtered: string[] = [];
    let activeIdx = -1;

    const open  = () => { dropdown.hidden = false; input.setAttribute('aria-expanded', 'true'); };
    const close = () => { dropdown.hidden = true; activeIdx = -1; input.setAttribute('aria-expanded', 'false'); };
    const highlight = () => {
      const els = dropdown.querySelectorAll('.us-combo-option');
      els.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
      const a = els[activeIdx]; if (a) a.scrollIntoView({ block: 'nearest' });
    };
    const add = (val: string | null) => {
      if (val == null) return;
      const cur = (Session.pref(key) as string[] | undefined) ?? [];
      if (!cur.includes(val)) Session.setPref(key, [...cur, val]);
      input.value = '';
      SessionUIAdapter._renderPinnedList(listEl, key);
      close();
      try { afterChange?.(); } catch {}
    };
    const renderList = (query: string) => {
      const already = new Set((Session.pref(key) as string[] | undefined) ?? []);
      const all = (optionsFn() || []).filter(o => !already.has(o));
      const q = (query || '').trim().toLowerCase();
      filtered = q ? all.filter(o => o.toLowerCase().includes(q)) : all.slice();
      if (!filtered.length) {
        dropdown.innerHTML = `<div class="us-combo-empty">${all.length ? Util.t('us.no_matches') : noneMsg}</div>`;
        activeIdx = -1;
        return;
      }
      dropdown.innerHTML = filtered.map((o, i) => {
        const safe = SessionUIAdapter._htmlEsc(o);
        return `<div class="us-combo-option" role="option" data-val="${safe}" data-idx="${i}"><span>${safe}</span></div>`;
      }).join('');
      activeIdx = 0;
      highlight();
      dropdown.querySelectorAll<HTMLElement>('.us-combo-option').forEach(el => {
        el.addEventListener('mousedown', e => { e.preventDefault(); add(el.dataset.val ?? null); });
      });
    };

    input.addEventListener('focus', () => { renderList(input.value); open(); });
    input.addEventListener('input', () => { renderList(input.value); open(); });
    input.addEventListener('keydown', e => {
      if (dropdown.hidden) {
        if (e.key === 'ArrowDown' || e.key === 'Enter') { renderList(input.value); open(); e.preventDefault(); }
        return;
      }
      if (e.key === 'ArrowDown')    { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, filtered.length - 1); highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); highlight(); }
      else if (e.key === 'Enter')   { e.preventDefault(); const v = filtered[activeIdx]; if (v != null) add(v); }
      else if (e.key === 'Escape')  { close(); input.blur(); }
    });
    input.addEventListener('blur', () => setTimeout(close, 120));

    SessionUIAdapter._renderPinnedList(listEl, key);
    listEl.addEventListener('click', e => {
      const btn = (e.target as HTMLElement | null)?.closest('.us-pin-remove') as HTMLElement | null;
      if (!btn) return;
      const val = btn.dataset.val;
      Session.setPref(key, ((Session.pref(key) as string[] | undefined) ?? []).filter(x => x !== val));
      SessionUIAdapter._renderPinnedList(listEl, key);
      try { afterChange?.(); } catch {}
    });
  },

  _renderSettingsPanes(): void {
    SessionUIAdapter._renderPersonalizationPane();
    SessionUIAdapter._renderWorkflowPane();
  },

  _renderPersonalizationPane(): void {
    const pane = document.getElementById('us-tab-personalization');
    if (!pane) return;
    // Seed from the ACTUALLY-applied theme (body.dark) so the control matches what
    // the user sees: DarkMode may have applied 'dark' from the legacy nimbus.theme
    // cache even when no user_settings.theme pref exists yet (pref() → 'light').
    const theme = document.body.classList.contains('dark') ? 'dark' : ((Session.pref('theme') as string | undefined) || 'light');
    const lang  = Session.pref('language') as string | undefined;
    const langOpts = [
      ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'],
    ].map(([c, n]) => SessionUIAdapter._optTag(c, n, lang)).join('');
    // Landing view — tab select + (dependent) sub-view select.
    const lv       = (Session.pref('landingView') as LandingViewPref | undefined) || {};
    const validLvTab = SessionUIAdapter._landingTabDefs().some(([v]) => v === lv.tab);
    const lvTab    = (validLvTab && lv.tab) ? lv.tab : 'home';
    const landingTabOpts = SessionUIAdapter._landingTabDefs().map(([v, n]) => SessionUIAdapter._optTag(v, n, lvTab)).join('');
    const lvSubDefs = SessionUIAdapter._landingSubDefs(lvTab);
    const landingSubOpts = lvSubDefs
      ? lvSubDefs.map(([v, n]) => SessionUIAdapter._optTag(v, n, lv.sub)).join('')
      : '';
    // Saved grid layout — the on/off toggle mirrors Session.pref('gridLayout') null-ness.
    const gridLayoutOn = Session.pref('gridLayout') != null;
    pane.innerHTML = `
      <div class="form-row">
        <label data-i18n="us.theme">${Util.t('us.theme')}</label>
        <select id="us-pref-theme">
          ${SessionUIAdapter._optTag('light', Util.t('us.theme_light'), theme)}
          ${SessionUIAdapter._optTag('dark',  Util.t('us.theme_dark'),  theme)}
        </select>
      </div>
      <div class="form-row">
        <label data-i18n="us.language">${Util.t('us.language')}</label>
        <select id="us-pref-language">${langOpts}</select>
      </div>
      <div class="form-row">
        <label data-i18n="us.default_plant">${Util.t('us.default_plant')}</label>
        <div class="us-combo" id="us-plant-combo">
          <input type="text" id="us-plant-input" class="us-combo-input" autocomplete="off" spellcheck="false"
                 placeholder="${Util.t('us.default_plant_ph')}" role="combobox" aria-haspopup="listbox" aria-expanded="false">
          <button type="button" class="us-combo-clear" id="us-plant-clear" title="${Util.t('us.default_plant_clear')}" hidden>×</button>
          <div class="us-combo-dropdown" id="us-plant-dropdown" role="listbox" hidden></div>
        </div>
        <p class="us-field-hint">${Util.t('us.default_plant_hint')}</p>
      </div>
      <div class="form-row">
        <label data-i18n="us.landing_view">${Util.t('us.landing_view')}</label>
        <div class="us-landing-row">
          <select id="us-landing-tab">${landingTabOpts}</select>
          <select id="us-landing-sub"${landingSubOpts ? '' : ' hidden'}>${landingSubOpts || ''}</select>
        </div>
        <p class="us-field-hint">${Util.t('us.landing_view_hint')}</p>
      </div>
      <div class="form-row">
        <label data-i18n="us.grid_layout">${Util.t('us.grid_layout')}</label>
        <label class="us-toggle-row">
          <input type="checkbox" id="us-grid-layout-toggle"${gridLayoutOn ? ' checked' : ''}>
          <span>${Util.t('us.grid_layout_toggle')}</span>
        </label>
        <button type="button" class="btn btn-ghost sm" id="us-grid-layout-reset" style="margin-top:8px">${Util.t('us.grid_layout_reset')}</button>
        <p class="us-field-hint">${Util.t('us.grid_layout_hint')}</p>
      </div>
      <div class="form-row">
        <label data-i18n="us.pinned_plants">${Util.t('us.pinned_plants')}</label>
        <div class="us-combo" id="us-pinplant-combo">
          <input type="text" id="us-pinplant-input" class="us-combo-input" autocomplete="off" spellcheck="false"
                 placeholder="${Util.t('us.pinned_plants_ph')}" role="combobox" aria-haspopup="listbox" aria-expanded="false">
          <div class="us-combo-dropdown" id="us-pinplant-dropdown" role="listbox" hidden></div>
        </div>
        <div class="us-pinned-list" id="us-pinplant-list"></div>
        <p class="us-field-hint">${Util.t('us.pinned_plants_hint')}</p>
      </div>
      <div class="form-row">
        <label data-i18n="us.pinned_lines">${Util.t('us.pinned_lines')}</label>
        <div class="us-combo" id="us-pinline-combo">
          <input type="text" id="us-pinline-input" class="us-combo-input" autocomplete="off" spellcheck="false"
                 placeholder="${Util.t('us.pinned_lines_ph')}" role="combobox" aria-haspopup="listbox" aria-expanded="false">
          <div class="us-combo-dropdown" id="us-pinline-dropdown" role="listbox" hidden></div>
        </div>
        <div class="us-pinned-list" id="us-pinline-list"></div>
        <p class="us-field-hint">${Util.t('us.pinned_lines_hint')}</p>
      </div>`;

    const themeSel = pane.querySelector<HTMLSelectElement>('#us-pref-theme')!;
    themeSel.addEventListener('change', () => {
      const isDark = themeSel.value === 'dark';
      // DarkMode.set() does the write-through (Session.setPref + nimbus.theme cache
      // + repaint); fall back to a bare persist if the intelligence layer is absent.
      try {
        if (typeof NIMBUS !== 'undefined' && NIMBUS.DarkMode?.set) NIMBUS.DarkMode.set(isDark);
        else Session.setPref('theme', isDark ? 'dark' : 'light');
      } catch { Session.setPref('theme', isDark ? 'dark' : 'light'); }
    });

    const langSel = pane.querySelector<HTMLSelectElement>('#us-pref-language')!;
    langSel.addEventListener('change', () => {
      // LangSwitcher.set() persists via Session.setPref, keeps nimbus.locale in
      // sync, and reloads so the whole UI re-renders in the chosen locale.
      try {
        if (typeof NIMBUS !== 'undefined' && NIMBUS.LangSwitcher?.set) NIMBUS.LangSwitcher.set(langSel.value);
        else { Session.setPref('language', langSel.value); location.reload(); }
      } catch { Session.setPref('language', langSel.value); location.reload(); }
    });

    SessionUIAdapter._initDefaultPlantCombo(pane);

    // ── Default landing view (tab + dependent sub-view) ──────────────────
    const landingTabSel = pane.querySelector<HTMLSelectElement>('#us-landing-tab');
    const landingSubSel = pane.querySelector<HTMLSelectElement>('#us-landing-sub');
    const _persistLanding = () => {
      const tab = landingTabSel!.value;
      const subs = SessionUIAdapter._landingSubDefs(tab);
      const sub  = (subs && landingSubSel && !landingSubSel.hidden) ? landingSubSel.value : null;
      Session.setPref('landingView', { tab, sub });
    };
    if (landingTabSel) {
      landingTabSel.addEventListener('change', () => {
        const subs = SessionUIAdapter._landingSubDefs(landingTabSel.value);
        if (landingSubSel) {
          if (subs) {
            landingSubSel.innerHTML = subs.map(([v, n]) => SessionUIAdapter._optTag(v, n, subs[0][0])).join('');
            landingSubSel.hidden = false;
          } else {
            landingSubSel.innerHTML = '';
            landingSubSel.hidden = true;
          }
        }
        _persistLanding();
      });
    }
    if (landingSubSel) landingSubSel.addEventListener('change', _persistLanding);

    // ── Saved grid layout (toggle + reset) ───────────────────────────────
    const gridToggle = pane.querySelector<HTMLInputElement>('#us-grid-layout-toggle');
    if (gridToggle) {
      gridToggle.addEventListener('change', () => {
        try { Table._setLayoutEnabled(gridToggle.checked); } catch {}
      });
    }
    const gridReset = pane.querySelector<HTMLButtonElement>('#us-grid-layout-reset');
    if (gridReset) {
      gridReset.addEventListener('click', () => {
        let ok = false;
        try { ok = Table._resetGridLayout(); } catch {}
        Toast.show(ok ? Util.t('us.grid_layout_reset_done') : Util.t('us.grid_layout_no_grid'), ok ? 'success' : 'warn');
      });
    }

    // ── Pinned plants / lines ─────────────────────────────────────────────
    SessionUIAdapter._initPinnedCombo({
      inputId: 'us-pinplant-input', dropdownId: 'us-pinplant-dropdown', listId: 'us-pinplant-list',
      key: 'pinnedPlants', optionsFn: () => Store.knownPlants(), noneMsg: Util.t('us.no_plants'),
      afterChange: () => { try { PlantSelector._reflectSelection(); } catch {} },
    });
    SessionUIAdapter._initPinnedCombo({
      inputId: 'us-pinline-input', dropdownId: 'us-pinline-dropdown', listId: 'us-pinline-list',
      key: 'pinnedLines', optionsFn: () => Store.allLines().slice().sort((a, b) => a.localeCompare(b)),
      noneMsg: Util.t('us.no_lines'),
      afterChange: () => { try { Hierarchy.render(); } catch {} },
    });
  },

  // Searchable plant combobox (scale-safe — never a chip list). Bound to
  // Session.pref('defaultPlant'); writes via Session.setPref('defaultPlant',
  // code|null). Modeled on the header PlantSelector, scoped to this modal instance.
  _initDefaultPlantCombo(pane: HTMLElement): void {
    const input    = pane.querySelector<HTMLInputElement>('#us-plant-input');
    const dropdown = pane.querySelector<HTMLElement>('#us-plant-dropdown');
    const clearBtn = pane.querySelector<HTMLElement>('#us-plant-clear');
    const combo    = pane.querySelector<HTMLElement>('#us-plant-combo');
    if (!input || !dropdown || !combo || !clearBtn) return;
    let filtered: string[] = [];
    let activeIdx = -1;

    const options = () => Store.knownPlants();          // already allowedPlants()-scoped
    const current = (): string | null => (Session.pref('defaultPlant') as string | null | undefined) || null;

    const reflect = () => {
      const dp = current();
      input.value = dp ? `${dp}` : '';
      combo.classList.toggle('has-value', !!dp);
      clearBtn.hidden = !dp;
    };
    const open  = () => { dropdown.hidden = false; input.setAttribute('aria-expanded', 'true'); };
    const close = () => { dropdown.hidden = true; activeIdx = -1; input.setAttribute('aria-expanded', 'false'); };
    const highlight = () => {
      const items = dropdown.querySelectorAll('.us-combo-option');
      items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
      const a = items[activeIdx]; if (a) a.scrollIntoView({ block: 'nearest' });
    };
    const choose = (plant: string | null) => { Session.setPref('defaultPlant', plant || null); reflect(); close(); input.blur(); };

    const renderList = (query: string) => {
      const all = options();
      const q = (query || '').trim().toLowerCase();
      const looksLikeLabel = current() && q === `${current()}`.toLowerCase();
      const fq = looksLikeLabel ? '' : q;
      filtered = fq ? all.filter(p => p.toLowerCase().includes(fq)) : all.slice();
      if (!filtered.length) {
        dropdown.innerHTML = `<div class="us-combo-empty">${all.length ? Util.t('us.no_matches') : Util.t('us.no_plants')}</div>`;
        activeIdx = -1;
        return;
      }
      const sel = current();
      dropdown.innerHTML = filtered.map((p, i) =>
        `<div class="us-combo-option${p === sel ? ' selected' : ''}" role="option" data-plant="${p}" data-idx="${i}">
           <span class="us-combo-option-prefix">${Util.t('ui.plant_label')}</span><span>${p}</span>
         </div>`).join('');
      activeIdx = Math.max(0, filtered.indexOf(sel ?? ''));
      highlight();
      dropdown.querySelectorAll<HTMLElement>('.us-combo-option').forEach(el => {
        el.addEventListener('mousedown', e => { e.preventDefault(); choose(el.dataset.plant ?? null); });
      });
    };

    input.addEventListener('focus', () => { renderList(input.value); open(); });
    input.addEventListener('input', () => { renderList(input.value); open(); });
    input.addEventListener('keydown', e => {
      if (dropdown.hidden) {
        if (e.key === 'ArrowDown' || e.key === 'Enter') { renderList(input.value); open(); e.preventDefault(); }
        return;
      }
      if (e.key === 'ArrowDown')      { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, filtered.length - 1); highlight(); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); highlight(); }
      else if (e.key === 'Enter')     { e.preventDefault(); const p = filtered[activeIdx]; if (p) choose(p); }
      else if (e.key === 'Escape')    { close(); reflect(); input.blur(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { close(); reflect(); }, 120));
    clearBtn.addEventListener('mousedown', e => e.preventDefault());
    clearBtn.addEventListener('click', () => { choose(null); input.focus(); });
    reflect();
  },

  _renderWorkflowPane(): void {
    const pane = document.getElementById('us-tab-workflow');
    if (!pane) return;
    const tf = Session.pref('timeFormat') as string | undefined;
    const df = Session.pref('dateFormat') as string | undefined;
    const now = new Date();
    const sample = (tok: string): string => {
      try { if (typeof flatpickr !== 'undefined' && flatpickr.formatDate) return flatpickr.formatDate(now, tok); } catch {}
      return tok;
    };
    const dfTokens = ['M j, Y', 'm/d/Y', 'd/m/Y', 'Y-m-d', 'j M Y'];
    if (df && !dfTokens.includes(df)) dfTokens.unshift(df);   // keep a role/legacy value selectable
    const dfOpts = dfTokens.map(tok => SessionUIAdapter._optTag(tok, sample(tok), df)).join('');
    const fdow = Number(Session.pref('firstDayOfWeek'));
    const fdowSel = (fdow === 1) ? 1 : 0;
    // Optimizer defaults — seed the strategy + option toggles the dialog opens with.
    const od      = Session.pref('optimizerDefaults') as OptimizerDefaultsPref | null | undefined;
    const odMode: string = (od && od.mode && ['spt', 'changeover'].includes(od.mode)) ? od.mode : 'changeover';
    const odFirmed = od ? (od.respectFirmed ?? (od as any).respectFixed) !== false : true;
    const odCal   = od ? od.respectCalendar !== false : true;
    pane.innerHTML = `
      <div class="form-row">
        <label data-i18n="us.time_format">${Util.t('us.time_format')}</label>
        <select id="us-pref-timeformat">
          ${SessionUIAdapter._optTag('12h', Util.t('us.time_12h'), tf)}
          ${SessionUIAdapter._optTag('24h', Util.t('us.time_24h'), tf)}
        </select>
      </div>
      <div class="form-row">
        <label data-i18n="us.date_format">${Util.t('us.date_format')}</label>
        <select id="us-pref-dateformat">${dfOpts}</select>
        <p class="us-field-hint">${Util.t('us.date_format_hint')}</p>
      </div>
      <div class="form-row">
        <label data-i18n="us.first_day">${Util.t('us.first_day')}</label>
        <select id="us-pref-firstday">
          ${SessionUIAdapter._optTag(0, Util.t('us.first_day_sun'), fdowSel)}
          ${SessionUIAdapter._optTag(1, Util.t('us.first_day_mon'), fdowSel)}
        </select>
        <p class="us-field-hint">${Util.t('us.first_day_hint')}</p>
      </div>
      <div class="form-row">
        <label data-i18n="us.opt_defaults">${Util.t('us.opt_defaults')}</label>
        <select id="us-opt-mode">
          ${SessionUIAdapter._optTag('spt',        Util.t('us.opt_mode_spt'),        odMode)}
          ${SessionUIAdapter._optTag('changeover', Util.t('us.opt_mode_changeover'), odMode)}
        </select>
        <label class="us-toggle-row" style="margin-top:8px">
          <input type="checkbox" id="us-opt-firmed"${odFirmed ? ' checked' : ''}>
          <span>${Util.t('us.opt_respect_firmed')}</span>
        </label>
        <label class="us-toggle-row">
          <input type="checkbox" id="us-opt-calendar"${odCal ? ' checked' : ''}>
          <span>${Util.t('us.opt_respect_calendar')}</span>
        </label>
        <button type="button" class="btn btn-ghost sm" id="us-opt-clear" style="margin-top:8px"${od ? '' : ' hidden'}>${Util.t('us.opt_defaults_clear')}</button>
        <p class="us-field-hint">${Util.t('us.opt_defaults_hint')}</p>
      </div>`;

    const tfSel = pane.querySelector<HTMLSelectElement>('#us-pref-timeformat')!;
    tfSel.addEventListener('change', () => { Session.setPref('timeFormat', tfSel.value); SessionUIAdapter._repaintDisplayFormat(); });
    const dfSel = pane.querySelector<HTMLSelectElement>('#us-pref-dateformat')!;
    dfSel.addEventListener('change', () => { Session.setPref('dateFormat', dfSel.value); SessionUIAdapter._repaintDisplayFormat(); });

    const fdSel = pane.querySelector<HTMLSelectElement>('#us-pref-firstday');
    if (fdSel) fdSel.addEventListener('change', () => {
      const v = fdSel.value === '1' ? 1 : 0;
      Session.setPref('firstDayOfWeek', v);
      try { App._applyFirstDayOfWeek(); } catch {}
    });

    // Optimizer defaults — preserve any stored preset; the dialog's run() keeps
    // it fresh from the user's last actual run.
    const modeSel  = pane.querySelector<HTMLSelectElement>('#us-opt-mode');
    const firmedChk = pane.querySelector<HTMLInputElement>('#us-opt-firmed');
    const calChk   = pane.querySelector<HTMLInputElement>('#us-opt-calendar');
    const writeOpt = () => {
      const existing = (Session.pref('optimizerDefaults') as OptimizerDefaultsPref | undefined) || {};
      Session.setPref('optimizerDefaults', {
        mode: modeSel!.value,
        preset: ['horizon', '2w'].includes(existing.preset ?? '') ? existing.preset : 'horizon',
        respectFirmed: firmedChk!.checked,
        respectCalendar: calChk!.checked,
      });
      const clr = pane.querySelector<HTMLElement>('#us-opt-clear');
      if (clr) clr.hidden = false;
    };
    if (modeSel)  modeSel.addEventListener('change', writeOpt);
    if (firmedChk) firmedChk.addEventListener('change', writeOpt);
    if (calChk)   calChk.addEventListener('change', writeOpt);
    const optClear = pane.querySelector<HTMLElement>('#us-opt-clear');
    if (optClear) optClear.addEventListener('click', () => {
      Session.setPref('optimizerDefaults', null);
      SessionUIAdapter._renderWorkflowPane();
    });
  },

  // Self-service: PATCH /security/me with just this user's own name fields.
  // Keeps the modal open with the typed values on failure so the user can
  // retry; on success, updates the local cache (via Session.updateCachedUser —
  // the private nimbus.session KEY constant lives only in schedule-data.mjs)
  // and closes.
  async saveProfile(): Promise<void> {
    const firstEl = document.getElementById('us-first-name') as HTMLInputElement | null;
    const lastEl = document.getElementById('us-last-name') as HTMLInputElement | null;
    const first_name = firstEl ? firstEl.value.trim() : '';
    const last_name = lastEl ? lastEl.value.trim() : '';
    try {
      const r = await Util.fetchTraced(`${Config.API_BASE}/security/me`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ first_name, last_name }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.detail || `HTTP ${r.status}`);
      }
      const updated = await r.json() as SecurityMeResponse;
      Session.updateCachedUser({ first_name: updated.first_name || null, last_name: updated.last_name || null });
      // Refresh the header avatar immediately — updateCachedUser() doesn't emit an
      // event, and the next natural _renderUserButton() call is a future
      // session:changed (signin/refresh), which could be a while away.
      SessionUIAdapter._renderUserButton();
      Modal.close('modal-user-settings');
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Save profile failed: ${(e as Error).message}`);
    }
  },

  // Self-service: PATCH /security/me/password. Unlike saveProfile(), the
  // caller's identity header alone isn't enough here — the backend re-verifies
  // current_password (auth.change_own_password) since there's no session token
  // binding the header to a prior login. Fields are cleared on success but the
  // modal stays open (mirrors the admin panel's non-closing _savePassword).
  async changePassword(): Promise<void> {
    const curEl = document.getElementById('us-current-password') as HTMLInputElement | null;
    const newEl = document.getElementById('us-new-password') as HTMLInputElement | null;
    const confEl = document.getElementById('us-confirm-password') as HTMLInputElement | null;
    const current_password = curEl ? curEl.value : '';
    const new_password = newEl ? newEl.value : '';
    const confirm_password = confEl ? confEl.value : '';
    if (!new_password || new_password.length < 4) {
      Toast.show(Util.t('sec.password_too_short'), 'error');
      return;
    }
    if (new_password !== confirm_password) {
      Toast.show(Util.t('sec.password_mismatch'), 'error');
      return;
    }
    try {
      const r = await Util.fetchTraced(`${Config.API_BASE}/security/me/password`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current_password, new_password }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.detail || `HTTP ${r.status}`);
      }
      if (curEl) curEl.value = '';
      if (newEl) newEl.value = '';
      if (confEl) confEl.value = '';
      Toast.show(Util.t('sec.password_updated'), 'success');
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Change password failed: ${(e as Error).message}`);
    }
  },
};

/* =============================================================================
   AUTH (LOGIN SCREEN) — mandatory full-screen gate, JS-built only (no static
   index.html markup for the overlay itself — build a full-viewport overlay,
   append to document.body, call Util.t(...) inline for every label rather
   than relying on the [data-i18n] sweep, which only runs inside App.init()
   — i.e. AFTER this gate has already decided whether to run it).
   showLoginScreen() is called from the DOMContentLoaded gate (see _bootMain in
   app.js) when no session is cached; on successful sign-in it tears itself down
   and calls App._bootMain() — the same boot path a resumed session takes.

   Layout/visual design ported from the "NIMBUS Login" mockup (see
   docs/superpowers/specs/2026-08-02-login-screen-redesign-design.md): a
   split screen — an animated factory-floor canvas (FactoryScene, below) on
   the left, a fixed-dark-chrome sign-in panel on the right. The panel is
   --chrome-* tokens in both light and dark mode by design (not themed).
   ========================================================================== */
function showLoginScreen(opts?: { expired?: boolean }): void {
  const root = document.createElement('div');
  root.className = 'login-screen';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', Util.t('sec.login_title'));

  root.innerHTML = `
    <div class="login-scene">
      <canvas class="login-scene-canvas" role="img"
        aria-label="Animated manufacturing cell: raw components travel by conveyor into an automated machine and emerge as finished consumer products"></canvas>
    </div>
    <div class="login-panel">
      <div class="login-panel-brand">
        <div class="login-brand-badge" aria-hidden="true">N</div>
        <div class="login-brand-name">NIMBUS</div>
        <div class="login-brand-tag">SCHED&nbsp;CONSOLE</div>
      </div>
      <form id="login-form" aria-label="${Util.t('sec.login_title')}">
        <h1 class="login-heading">${Util.t('sec.login_title')}</h1>
        <div class="login-error" id="login-error" role="alert" hidden></div>
        <label for="login-username" class="login-field-label">${Util.t('sec.username')}</label>
        <input type="text" id="login-username" name="username" class="login-input"
               autocomplete="username" autocapitalize="off" spellcheck="false"
               aria-label="${Util.t('sec.username')}">
        <label for="login-password" class="login-field-label">${Util.t('sec.password')}</label>
        <input type="password" id="login-password" name="password" class="login-input"
               autocomplete="current-password" aria-label="${Util.t('sec.password')}">
        <button type="submit" class="login-submit-btn" id="login-submit-btn">${Util.t('sec.sign_in')}</button>
      </form>
      <div class="login-panel-footer"><span>NIMBUS ${Config.BUILD_ID}</span></div>
    </div>`;

  document.body.appendChild(root);

  const canvasEl  = root.querySelector<HTMLCanvasElement>('.login-scene-canvas')!;
  const userInp   = root.querySelector<HTMLInputElement>('#login-username')!;
  const passInp   = root.querySelector<HTMLInputElement>('#login-password')!;
  const errEl     = root.querySelector<HTMLElement>('#login-error')!;
  const submitBtn = root.querySelector<HTMLButtonElement>('#login-submit-btn')!;
  const signInLabel = Util.t('sec.sign_in');

  const scene = new FactoryScene(canvasEl);

  userInp.addEventListener('input', () => {
    const pos = userInp.selectionStart;
    userInp.value = userInp.value.toLowerCase();
    userInp.setSelectionRange(pos!, pos!);
  });
  [userInp, passInp].forEach(inp => inp.addEventListener('input', () => {
    errEl.hidden = true;
    errEl.textContent = '';
  }));

  function _setBusy(busy: boolean): void {
    submitBtn.disabled = busy;
    submitBtn.textContent = busy ? Util.t('sec.authenticating') : signInLabel;
  }
  function _showError(msg: string): void {
    errEl.textContent = msg;
    errEl.hidden = false;
  }

  // Reuses the same error element/styling the invalid-credentials path uses
  // below — no separate "session expired" UI state, per the boot gate's
  // one-shot opts.expired flag (nothing persisted, consumed once here).
  if (opts?.expired) _showError(Util.t('sec.session_expired'));

  async function _submit(): Promise<void> {
    const username = userInp.value.trim().toLowerCase();
    const password = passInp.value;
    if (!username || !password) {
      _showError(Util.t('sec.login_missing_fields'));
      return;
    }
    errEl.hidden = true;
    _setBusy(true);
    try {
      await Session.signIn(username, password);
      scene.destroy();
      root.remove();
      App._bootMain!();
    } catch (e) {
      // Deliberately generic on bad credentials — never reveal whether the
      // username itself was wrong. A thrown TypeError means fetch() itself
      // failed (offline/unreachable), which is a distinct, honest message.
      _showError(e instanceof TypeError ? Util.t('sec.login_unreachable') : Util.t('sec.login_invalid'));
      _setBusy(false);
    }
  }

  root.querySelector('#login-form')!.addEventListener('submit', e => { e.preventDefault(); _submit(); });

  userInp.focus();
}

/* =============================================================================
   FACTORY SCENE — the login screen's animated left-hand canvas. Framework-
   agnostic (only ever touches the <canvas> it's given; no Store/DOM coupling
   beyond that), ported from the "NIMBUS Login" mockup's initScene(). Ignores
   `prefers-reduced-motion: reduce` at the rAF level by rendering exactly one
   static frame instead of starting the loop.
   ========================================================================== */
type ProductDraw = (x: number, y: number, k: number, T: (l: number, s?: number) => string, hue: number) => void;
interface ProductDef { id: string; w: number; draw: ProductDraw }
interface SceneItem {
  state: 'raw' | 'consumed' | 'out';
  def: ProductDef;
  x: number;
  age: number;
  entering?: boolean;
  wo?: string;
  hue?: number;
  util?: number;
}
interface SceneLane {
  y: number; k: number; cellTag: string; items: SceneItem[]; t: number;
  mx: number; mw: number;
  busy: { wo: string } | null; busyT: number; nextSpawn: number;
  scanX: number; scanFlash: number;
}

class FactoryScene {
  private cv: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private raf = 0;
  private W = 0;
  private H = 0;
  // Reassigned by _init() to close over that call's local `build`/lane state.
  // The ResizeObserver registered in the constructor calls this indirection;
  // by the time a resize can actually fire, _init() has already run.
  private _fit: () => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.ro = new ResizeObserver(() => this._fit());
    this.ro.observe(canvas);
    this._init();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
  }

  private _init(): void {
    const cv = this.cv, ctx = this.ctx;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const SPEED = 56;          // px/s conveyor
    const CYCLE = 2.6;         // s inside the cell
    const SPAWN_GAP = 1.2;     // s between blanks queuing
    const showOverlays = true;
    let dpr = 1;

    // iso constants: top faces offset up-right
    const IX = 11, IY = -7;
    const shade = (hex: string, f: number): string => {
      const n = parseInt(hex.slice(1), 16);
      const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
      const r = c(((n >> 16) & 255) * f), g = c(((n >> 8) & 255) * f), b = c((n & 255) * f);
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    };
    const hslHex = (h: number, s: number, l: number): string => {
      s /= 100; l /= 100;
      const f = (n: number) => {
        const kk = (n + h / 30) % 12;
        const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(kk - 3, 9 - kk, 1));
        return Math.round(c * 255).toString(16).padStart(2, '0');
      };
      return '#' + f(0) + f(8) + f(4);
    };
    const quad = (a: number[], b: number[], c: number[], d: number[], fill: string): void => {
      ctx.fillStyle = fill; ctx.beginPath();
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]);
      ctx.closePath(); ctx.fill();
    };
    // front face at (x, y-h .. y), plus top + right side
    const isoBox = (x: number, y: number, w: number, h: number, color: string, opts?: { top?: string; side?: string }): void => {
      const o = opts || {};
      ctx.fillStyle = color;
      ctx.fillRect(x, y - h, w, h);
      quad([x, y - h], [x + w, y - h], [x + w + IX, y - h + IY], [x + IX, y - h + IY], o.top || shade(color, 1.22));
      quad([x + w, y - h], [x + w + IX, y - h + IY], [x + w + IX, y + IY], [x + w, y], o.side || shade(color, 0.78));
    };
    const roundRect = (x: number, y: number, w: number, h: number, r: number): void => {
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    };

    // ---- product library (drawn with base-left at x, sitting on belt line y, scale k) ----
    const PRODUCTS: ProductDef[] = [
      { id: 'COOLER-65Q', w: 70, draw(x, y, k, T) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        // body: Coleman-style box in the item's tint
        isoBox(0, 0, 66, 32, T(40));
        ctx.fillStyle = T(32); ctx.fillRect(0, -10, 66, 2.5); // molded body groove
        // white lid: overhangs, rounded
        ctx.fillStyle = '#e8edf3'; roundRect(-3, -43, 72, 12, 3); ctx.fill();
        quad([-1, -43], [70, -43], [70 + IX, -43 + IY], [-1 + IX, -43 + IY], '#ffffff');
        quad([69, -42], [69 + IX, -42 + IY], [69 + IX, -32 + IY], [69, -31], shade('#e8edf3', 0.8));
        // lid handle recess (front center)
        ctx.fillStyle = shade('#e8edf3', 0.78); roundRect(22, -40, 22, 6, 3); ctx.fill();
        ctx.fillStyle = shade('#e8edf3', 0.9); roundRect(24, -39, 18, 4, 2); ctx.fill();
        // drain plug, bottom front corner
        ctx.fillStyle = '#e8edf3'; ctx.beginPath(); ctx.arc(9, -5, 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = shade('#e8edf3', 0.7); ctx.beginPath(); ctx.arc(9, -5, 1.4, 0, Math.PI * 2); ctx.fill();
        ctx.restore(); } },
      { id: 'BRUTE-44G', w: 46, draw(x, y, k, T, hue) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        const B = ['#3a4148', '#6b7278', '#9aa1a7', '#e2e5e8'][hue % 4]; // BRUTE ships gray/black/white only
        quad([4, 0], [42, 0], [46, -48], [0, -48], B);                  // tapered body
        quad([0, -48], [46, -48], [46 + IX, -48 + IY], [IX, -48 + IY], shade(B, 1.22));
        ctx.fillStyle = shade(B, 0.8);
        ctx.fillRect(-3, -50, 52, 5);                                   // rim
        ctx.fillRect(8, -38, 4, 26); ctx.fillRect(34, -38, 4, 26);      // ribs
        ctx.restore(); } },
      { id: 'BLENDER-PRO', w: 34, draw(x, y, k, T) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        isoBox(0, 0, 34, 16, T(24));
        ctx.globalAlpha = 0.75; quad([4, -16], [30, -16], [26, -50], [8, -50], '#c9ddf7'); ctx.globalAlpha = 1;
        ctx.strokeStyle = '#8fa1b3'; ctx.strokeRect(9.5, -46.5, 15, 27); // jar marks
        isoBox(7, -50, 20, 6, T(24));                                   // lid
        ctx.fillStyle = T(55); ctx.fillRect(6, -12, 8, 5);              // dial
        ctx.restore(); } },
      { id: 'STROLLER-S2', w: 58, draw(x, y, k, T) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        // wheels (rear left, front right — travelling right)
        const wheel = (wx: number, r: number) => {
          ctx.fillStyle = '#1c2b3a'; ctx.beginPath(); ctx.arc(wx, -r, r, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#56677c'; ctx.beginPath(); ctx.arc(wx, -r, r * 0.42, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#1c2b3a'; ctx.beginPath(); ctx.arc(wx, -r, r * 0.16, 0, Math.PI * 2); ctx.fill();
        };
        wheel(12, 9); wheel(48, 7);
        // frame: rear axle up to push handle (leaning back-left), front axle up to seat
        ctx.strokeStyle = '#56677c'; ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(12, -9); ctx.lineTo(4, -52); ctx.stroke();   // handle stem
        ctx.beginPath(); ctx.moveTo(48, -7); ctx.lineTo(30, -30); ctx.stroke();  // front strut
        ctx.beginPath(); ctx.moveTo(12, -9); ctx.lineTo(30, -30); ctx.stroke();  // rear strut
        // push handle grip
        ctx.strokeStyle = '#1c2b3a'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(4, -52); ctx.quadraticCurveTo(1, -56, 6, -58); ctx.stroke();
        ctx.lineWidth = 1; ctx.lineCap = 'butt';
        // seat pod: reclined bucket hanging on the frame
        ctx.fillStyle = T(44); ctx.beginPath();
        ctx.moveTo(18, -26);                             // seat front-bottom
        ctx.quadraticCurveTo(34, -22, 44, -28);          // footwell curve
        ctx.quadraticCurveTo(48, -36, 42, -42);          // seat front rises
        ctx.lineTo(28, -44);                             // seat top edge
        ctx.quadraticCurveTo(18, -46, 16, -38);          // back of seat
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = T(30); ctx.beginPath();          // seat pad inset
        ctx.moveTo(24, -40); ctx.quadraticCurveTo(34, -40, 40, -34);
        ctx.quadraticCurveTo(34, -28, 24, -30); ctx.closePath(); ctx.fill();
        // canopy hood over the top
        ctx.fillStyle = T(37); ctx.beginPath();
        ctx.moveTo(14, -40); ctx.quadraticCurveTo(20, -58, 40, -52);
        ctx.quadraticCurveTo(30, -50, 24, -44); ctx.quadraticCurveTo(18, -42, 14, -40);
        ctx.closePath(); ctx.fill();
        ctx.restore(); } },
      { id: 'BOTTLE-40OZ', w: 24, draw(x, y, k, T) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        // stainless body: tapered base like a tumbler-bottle
        ctx.fillStyle = T(42); ctx.beginPath();
        ctx.moveTo(3, 0); ctx.lineTo(1, -34);            // body side (slightly wider up top)
        ctx.quadraticCurveTo(1, -40, 5, -42);            // shoulder
        ctx.lineTo(19, -42); ctx.quadraticCurveTo(23, -40, 23, -34);
        ctx.lineTo(21, 0); ctx.closePath(); ctx.fill();
        // brushed-steel highlight + darker edge
        ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(4.5, -39, 3, 37);
        ctx.fillStyle = T(30); ctx.fillRect(19, -38, 2.5, 37);
        // neck + cap with carry loop
        ctx.fillStyle = T(36); ctx.fillRect(6, -45, 12, 3);
        ctx.fillStyle = '#1c2b3a'; roundRect(7, -52, 10, 7, 2); ctx.fill();
        ctx.strokeStyle = '#1c2b3a'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(12, -53, 4.5, Math.PI, 0); ctx.stroke(); ctx.lineWidth = 1;
        ctx.restore(); } },
      { id: 'CANDLE-22OZ', w: 30, draw(x, y, k, T) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        // glass jar: gently tapered cylinder, shoulder curving into a narrower neck
        ctx.fillStyle = 'rgba(201,221,247,0.35)'; ctx.beginPath();
        ctx.moveTo(2, 0); ctx.lineTo(1, -30);            // straight body sides
        ctx.quadraticCurveTo(1, -37, 6, -39);            // shoulder
        ctx.lineTo(24, -39); ctx.quadraticCurveTo(29, -37, 29, -30);
        ctx.lineTo(28, 0); ctx.closePath(); ctx.fill();
        // wax fill visible through glass
        ctx.fillStyle = T(48); ctx.globalAlpha = 0.8;
        ctx.fillRect(3, -29, 24, 28); ctx.globalAlpha = 1;
        // paper label band
        ctx.fillStyle = '#f4f7fa'; ctx.fillRect(5, -25, 20, 15);
        ctx.strokeStyle = '#c6d0db'; ctx.strokeRect(5.5, -24.5, 19, 14);
        ctx.fillStyle = '#8fa1b3'; ctx.fillRect(9, -20, 12, 1.5); ctx.fillRect(11, -16, 8, 1.5); // label text lines
        // glass highlight
        ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fillRect(4, -36, 3, 34);
        // domed metal lid with knob
        ctx.fillStyle = '#7a5a2a'; ctx.beginPath();
        ctx.moveTo(4, -39); ctx.quadraticCurveTo(15, -47, 26, -39); ctx.closePath(); ctx.fill();
        ctx.fillRect(3, -41, 24, 3);
        ctx.fillStyle = shade('#7a5a2a', 1.25); ctx.beginPath(); ctx.arc(15, -45, 2.2, 0, Math.PI * 2); ctx.fill();
        ctx.restore(); } },
      { id: 'BREW-12C', w: 42, draw(x, y, k, T) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        const B = T(22);
        isoBox(0, 0, 42, 8, B);                                         // base
        isoBox(24, -8, 18, 40, B);                                      // tower
        quad([24, -48], [42, -48], [10, -48], [10, -44], shade(B, 1.2));
        isoBox(8, -44, 18, 5, B);                                       // head
        ctx.globalAlpha = 0.7; quad([6, -8], [24, -8], [22, -30], [8, -30], '#c9ddf7'); ctx.globalAlpha = 1; // carafe
        ctx.fillStyle = '#1e7a4a'; ctx.fillRect(30, -20, 4, 4);         // LED
        ctx.restore(); } },
      { id: 'LANTERN-LED', w: 30, draw(x, y, k, T) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        const B = T(38);
        // base (cylinder hint: rounded + darker sides)
        ctx.fillStyle = B; roundRect(1, -12, 28, 12, 3); ctx.fill();
        ctx.fillStyle = shade(B, 0.75); ctx.fillRect(1, -12, 3, 12); ctx.fillRect(26, -12, 3, 12);
        // glass globe with inner glow + vertical supports
        const glow = ctx.createLinearGradient(0, -34, 0, -12);
        glow.addColorStop(0, '#fdf6dd'); glow.addColorStop(1, '#f0ddac');
        ctx.fillStyle = glow; roundRect(4, -34, 22, 22, 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(12, -31, 6, 16); // hot core
        ctx.fillStyle = shade(B, 0.8); ctx.fillRect(4, -34, 2, 22); ctx.fillRect(24, -34, 2, 22);
        // cap: vented dome
        ctx.fillStyle = B; roundRect(2, -41, 26, 7, 3); ctx.fill();
        ctx.fillStyle = shade(B, 1.2); ctx.beginPath();
        ctx.moveTo(6, -41); ctx.quadraticCurveTo(15, -47, 24, -41); ctx.closePath(); ctx.fill();
        ctx.fillStyle = shade(B, 0.7); ctx.fillRect(8, -39, 14, 1.5); // vent slit
        // wire bail handle, hinged at sides
        ctx.strokeStyle = '#8fa1b3'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(5, -42); ctx.quadraticCurveTo(15, -54, 25, -42); ctx.stroke(); ctx.lineWidth = 1;
        ctx.fillStyle = '#8fa1b3'; ctx.fillRect(4, -43, 2.5, 2.5); ctx.fillRect(23.5, -43, 2.5, 2.5);
        ctx.restore(); } },
      { id: 'PEN-GEL07', w: 58, draw(x, y, k, T) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        isoBox(0, 0, 50, 7, T(28));
        quad([50, 0], [58, -3.5], [50, -7], [50, -7], T(28));           // nose cone
        ctx.fillStyle = T(55); ctx.fillRect(38, -7, 4, 7);              // grip band
        ctx.fillStyle = '#8fa1b3'; ctx.fillRect(4, -9, 14, 3);          // clip
        ctx.restore(); } },
    ];
    const RAW: ProductDef = { id: 'RAW', w: 44, draw(x, y, k) { ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
      ctx.fillStyle = '#8fa1b3'; roundRect(0, -24, 44, 24, 5); ctx.fill();
      quad([3, -24], [41, -24], [41 + IX, -24 + IY], [3 + IX, -24 + IY], shade('#8fa1b3', 1.18));
      ctx.fillStyle = shade('#8fa1b3', 0.85); ctx.fillRect(6, -14, 32, 2); // mold line
      ctx.restore(); } };

    // ---- lanes ----
    let lanes: SceneLane[] = [];
    const build = (): void => {
      lanes = [];
      const mk = (y: number, k: number, cellTag: string, phase: number): SceneLane => ({
        y, k, cellTag, items: [], t: 0,
        mx: this.W * 0.34, mw: 190 * k,
        busy: null, busyT: 0, nextSpawn: phase,
        scanX: this.W * 0.34 + 190 * k + 130 * k,
        scanFlash: 0,
      });
      if (this.H > 480 && this.W > 700) lanes.push(mk(this.H * 0.40, 0.72, 'A-02', 1.6)); // back lane
      lanes.push(mk(this.H * 0.68, 1, 'A-01', 0));
    };

    this._fit = (): void => {
      const r = cv.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.W = r.width; this.H = r.height;
      cv.width = Math.max(1, this.W * dpr); cv.height = Math.max(1, this.H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
    };

    const WOS = ['WO-48213', 'WO-48214', 'WO-48297', 'WO-48302', 'WO-48318', 'WO-48340'];

    const drawBelt = (l: SceneLane, t: number): void => {
      const y = l.y, k = l.k, bh = 12 * k, depth = 16 * k, W = this.W, H = this.H;
      // belt top surface (iso parallelogram)
      quad([0, y], [W, y], [W + depth, y + IY * (depth / IX)], [depth, y + IY * (depth / IX)], '#16304f');
      // belt front
      ctx.fillStyle = '#12263f'; ctx.fillRect(0, y, W, bh);
      ctx.strokeStyle = '#2c4a6b'; ctx.strokeRect(-1, y + 0.5, W + 2, bh - 1);
      // moving seam marks on top surface
      const seamGap = 42 * k, off = (t * SPEED) % seamGap;
      ctx.strokeStyle = 'rgba(44,74,107,0.9)';
      for (let x = -off; x < W + depth; x += seamGap) {
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + depth, y + IY * (depth / IX)); ctx.stroke();
      }
      // rollers
      const rr = 3 * k, spacing = 24 * k;
      const roff = (t * SPEED / 2) % spacing;
      ctx.strokeStyle = '#2c4a6b';
      for (let x = -roff; x < W; x += spacing) {
        ctx.beginPath(); ctx.arc(x, y + bh + 5 * k, rr, 0, Math.PI * 2); ctx.stroke();
        const a = (t * SPEED) / rr * 0.5;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * rr, y + bh + 5 * k + Math.sin(a) * rr);
        ctx.lineTo(x - Math.cos(a) * rr, y + bh + 5 * k - Math.sin(a) * rr);
        ctx.stroke();
      }
      // legs
      ctx.fillStyle = '#0f2440';
      for (let x = 60; x < W; x += 220 * k) ctx.fillRect(x, y + bh, 5 * k, Math.min(40 * k, H - y - bh - 6));
    };

    const drawMachine = (l: SceneLane, t: number): void => {
      const k = l.k, x = l.mx, w = l.mw, y = l.y, h = 118 * k;
      const active = !!l.busy;
      // body
      isoBox(x, y, w, h, '#1a3252', { top: '#24446c', side: '#132844' });
      // entrance/exit openings
      ctx.fillStyle = '#0a1626';
      ctx.fillRect(x - 1, y - 40 * k, 10 * k, 40 * k);
      ctx.fillRect(x + w - 10 * k + 1, y - 40 * k, 10 * k, 40 * k);
      // rubber flaps
      ctx.fillStyle = '#2c4a6b';
      for (let f = 0; f < 3; f++) { ctx.fillRect(x + 2, y - 38 * k + f, 6 * k, 1); ctx.fillRect(x + w - 8 * k, y - 38 * k + f, 6 * k, 1); }
      // inspection windows with interior flashes
      const wins: [number, number, number, number][] = [
        [x + w * 0.18, y - 86 * k, w * 0.24, 30 * k],
        [x + w * 0.58, y - 86 * k, w * 0.24, 30 * k],
      ];
      for (let wi = 0; wi < wins.length; wi++) {
        const [wx, wy, ww, wh] = wins[wi];
        ctx.fillStyle = '#0a1626'; roundRect(wx, wy, ww, wh, 3); ctx.fill();
        ctx.strokeStyle = '#2c4a6b'; roundRect(wx + 0.5, wy + 0.5, ww - 1, wh - 1, 3); ctx.stroke();
        if (active) {
          ctx.save(); roundRect(wx + 1, wy + 1, ww - 2, wh - 2, 3); ctx.clip();
          const ph = (l.busyT * 2.1 + wi * 1.7) % 2;
          // robotic arm silhouette
          const aa = Math.sin(l.busyT * 5 + wi * 2) * 0.6;
          ctx.strokeStyle = '#56677c'; ctx.lineWidth = 3; ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(wx + ww * 0.3, wy + wh);
          ctx.lineTo(wx + ww * 0.3 + Math.cos(-1.2 + aa) * wh * 0.7, wy + wh + Math.sin(-1.2 + aa) * wh * 0.7);
          ctx.stroke(); ctx.lineWidth = 1; ctx.lineCap = 'butt';
          // laser sweep
          const lx = wx + ((l.busyT * 1.4 + wi * 0.5) % 1) * ww;
          ctx.strokeStyle = 'rgba(77,159,255,0.8)';
          ctx.beginPath(); ctx.moveTo(lx, wy); ctx.lineTo(lx, wy + wh); ctx.stroke();
          // weld sparks
          if (ph > 1.55) {
            const sx = wx + ww * 0.62, sy = wy + wh * 0.66;
            ctx.fillStyle = '#f39c12';
            for (let s = 0; s < 5; s++) {
              const sa = (s / 5) * Math.PI * 2 + l.busyT * 9;
              ctx.fillRect(sx + Math.cos(sa) * (2 + (ph - 1.55) * 26), sy + Math.sin(sa) * (2 + (ph - 1.55) * 20), 1.6, 1.6);
            }
            ctx.fillStyle = '#fff'; ctx.fillRect(sx - 1, sy - 1, 2.5, 2.5);
          }
          ctx.restore();
        }
      }
      // pneumatic actuator on roof
      const stroke = active ? Math.abs(Math.sin(l.busyT * 4)) * 7 * k : 0;
      ctx.fillStyle = '#2c4a6b'; ctx.fillRect(x + w * 0.44, y - h - 16 * k - stroke, 6 * k, 16 * k + stroke);
      isoBox(x + w * 0.40, y - h - 16 * k - stroke, 14 * k, 6 * k, '#3a5a80');
      // LED stack
      const lx2 = x + w + 8;
      ctx.fillStyle = '#1f3a5c'; ctx.fillRect(lx2, y - 70 * k, 6, 26);
      const leds: [string, boolean][] = [['#1e7a4a', !active], ['#f39c12', active], ['#b02a20', false]];
      leds.forEach((ld, i) => {
        ctx.globalAlpha = ld[1] ? (0.55 + 0.45 * Math.sin(t * 6 + i)) : 0.18;
        ctx.fillStyle = ld[0]; ctx.beginPath(); ctx.arc(lx2 + 3, y - 64 * k + i * 8, 2.6, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      });
      // cell label
      ctx.fillStyle = '#7e93ab'; ctx.font = '600 ' + Math.round(9.5 * Math.max(k, 0.85)) + "px 'JetBrains Mono', monospace";
      ctx.fillText('CELL ' + l.cellTag, x + 10, y - h + 16 * k);
      ctx.fillStyle = active ? '#f39c12' : '#1e7a4a';
      ctx.fillText(active ? 'RUN' : 'IDLE', x + w - 34 * k - 6, y - h + 16 * k);
    };

    const drawScanner = (l: SceneLane): void => {
      const k = l.k, sx = l.scanX, y = l.y;
      ctx.fillStyle = '#1f3a5c';
      ctx.fillRect(sx - 2 * k, y - 54 * k, 4 * k, 54 * k);
      ctx.fillRect(sx - 9 * k, y - 58 * k, 18 * k, 6 * k);
      const hit = l.items.some((it) => it.state === 'out' && it.x < sx && it.x + it.def.w * k > sx);
      if (hit) {
        l.scanFlash = 0.18;
        ctx.strokeStyle = 'rgba(77,159,255,0.85)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(sx, y - 52 * k); ctx.lineTo(sx, y); ctx.stroke(); ctx.lineWidth = 1;
      }
      ctx.fillStyle = hit || l.scanFlash > 0 ? '#4d9fff' : '#1e7a4a';
      ctx.beginPath(); ctx.arc(sx + 6 * k, y - 55 * k, 2.2, 0, Math.PI * 2); ctx.fill();
    };

    const drawLane = (l: SceneLane, t: number): void => {
      drawBelt(l, t);
      // items behind machine drawn before machine so they disappear into it
      for (const it of l.items) it.def.draw(it.x, l.y, l.k, (li, s) => hslHex(it.hue ?? 210, s ?? 58, li), it.hue ?? 0);
      drawMachine(l, t);
      drawScanner(l);
      // WO overlay above freshest finished item
      if (showOverlays) {
        const out = l.items.find((it) => it.state === 'out' && it.age < 3.4 && it.age > 0.5);
        if (out) {
          const a = Math.min(1, (out.age - 0.5) * 2, (3.4 - out.age) * 2);
          ctx.globalAlpha = Math.max(0, a);
          ctx.font = "500 10px 'JetBrains Mono', monospace";
          const label = out.wo + ' · ' + out.def.id + ' · ' + out.util + '%';
          const tw = ctx.measureText(label).width + 16;
          const tx = Math.max(12, Math.min(this.W - tw - 12, out.x - 10)), ty = l.y - 110 * l.k;
          ctx.fillStyle = 'rgba(18,38,63,0.92)'; ctx.strokeStyle = '#2c4a6b';
          roundRect(tx, ty, tw, 22, 3); ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#a7b8ca'; ctx.fillText(label, tx + 8, ty + 14.5);
          ctx.beginPath(); ctx.moveTo(tx + 12, ty + 22); ctx.lineTo(tx + 12, l.y - 64 * l.k); ctx.strokeStyle = '#2c4a6b'; ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    };

    const stepLane = (l: SceneLane, dt: number, t: number): void => {
      const k = l.k, speed = SPEED * (0.85 + 0.15 * k);
      l.scanFlash = Math.max(0, l.scanFlash - dt);
      // spawn raw blanks
      if (t > l.nextSpawn) {
        const lastRaw = l.items.filter((i) => i.state === 'raw').pop();
        if (!lastRaw || lastRaw.x > 90) {
          l.items.push({ state: 'raw', def: RAW, x: -70, age: 0 });
          l.nextSpawn = t + SPAWN_GAP + CYCLE + Math.random() * 1.5;
        }
      }
      // move
      for (const it of l.items) {
        it.age += dt;
        if (it.state === 'raw') {
          const hold = l.mx - RAW.w * k - 30 * k; // pneumatic stop short of the door
          if (it.entering) {
            it.x += speed * dt; // glide fully under the cell body (machine is drawn over it)
            if (it.x >= l.mx + 14 * k) { l.busyT = 0; it.state = 'consumed'; }
          } else if (l.busy) {
            it.x = Math.min(it.x + speed * dt, hold); // wait at the stop
          } else {
            it.x += speed * dt;
            if (it.x + RAW.w * k >= l.mx + 2) { // front crosses the door: claim the cell, keep sliding in
              it.entering = true;
              l.busy = { wo: WOS[Math.floor(Math.random() * WOS.length)] };
              l.busyT = -((l.mx + 14 * k - it.x) / speed); // cycle starts once fully inside
            }
          }
        } else if (it.state === 'out') {
          it.x += speed * dt;
        }
      }
      l.items = l.items.filter((it) => it.state !== 'consumed' && it.x < this.W + 120);
      // machine cycle
      if (l.busy) {
        l.busyT += dt;
        if (l.busyT >= CYCLE) {
          const def = PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)];
          l.items.push({ state: 'out', def, x: l.mx + l.mw + 2, age: 0, wo: l.busy.wo, hue: Math.floor(Math.random() * 360), util: 82 + Math.floor(Math.random() * 15) });
          l.busy = null; l.busyT = 0;
        }
      }
    };

    const frame = (t: number): void => {
      const W = this.W, H = this.H;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#0c1c30'; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(44,74,107,0.22)';
      for (let x = 0; x < W; x += 80) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); ctx.stroke(); }
      // floor line glow under lanes
      for (const l of lanes) drawLane(l, t);
    };

    let last = performance.now(), t = 0;
    const tick = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
      for (const l of lanes) stepLane(l, dt, t);
      frame(t);
      this.raf = requestAnimationFrame(tick);
    };

    this._fit();
    if (reduced) {
      // static factory illustration: one raw inbound, one product outbound, cells idle
      for (const l of lanes) {
        l.items.push({ state: 'raw', def: RAW, x: this.W * 0.14, age: 1 });
        l.items.push({ state: 'out', def: PRODUCTS[(l.k === 1 ? 0 : 2)], x: l.mx + l.mw + 90 * l.k, age: 1.2, wo: 'WO-48213', hue: l.k === 1 ? 210 : 30, util: 88 });
      }
      frame(1);
    } else {
      this.raf = requestAnimationFrame(tick);
    }
  }
}

/* =============================================================================
   EMPTY STATE — reusable "select a plant" prompt rendered into a container
   whenever Store.selectedPlant is null. Each module that scopes by plant
   calls EmptyState.render(el, opts) instead of its normal render path.
   ========================================================================== */
const EmptyState = {
  render(container: HTMLElement | null, opts: { title?: string; msg?: string; icon?: string } = {}): void {
    if (!container) return;
    const title = opts.title || Util.t('empty.select_plant_title');
    const msg = opts.msg || Util.t('empty.select_plant_msg');
    const icon = opts.icon || '◨';
    container.innerHTML =
      `<div class="nimbus-empty-state">
         <div class="nes-icon">${icon}</div>
         <div class="nes-title">${title}</div>
         <div class="nes-msg">${msg}</div>
       </div>`;
  }
};

/* =============================================================================
   PLANT SELECTOR — global, searchable combobox in the topbar.
   Owns the selected-plant UI; writes to Store.selectedPlant; subscribes to
   'plant:selected' so external mutations (e.g. OptimizeDialog) stay in sync.
   ========================================================================== */
const PlantSelector = {
  _root:     null as HTMLElement | null,
  _input:    null as HTMLElement | null,
  _dropdown: null as HTMLElement | null,
  _clearBtn: null as HTMLElement | null,
  _combobox: null as HTMLElement | null,
  _options:  [] as string[],
  _filtered: [] as string[],
  _activeIdx: -1,
  _open:     false,
  _measureCtx: null as CanvasRenderingContext2D | null,

  init(): void {
    PlantSelector._root     = document.getElementById('header-plant-selector');
    PlantSelector._input    = document.getElementById('hps-input');
    PlantSelector._dropdown = document.getElementById('hps-dropdown');
    PlantSelector._clearBtn = document.getElementById('hps-clear');
    PlantSelector._combobox = document.getElementById('hps-combobox');
    if (!PlantSelector._root) return;

    PlantSelector._input!.addEventListener('focus', () => {
      PlantSelector._refreshOptions();
      PlantSelector._renderDropdown((PlantSelector._input as HTMLInputElement).value);
      PlantSelector._openDropdown();
    });
    PlantSelector._input!.addEventListener('input', () => {
      PlantSelector._renderDropdown((PlantSelector._input as HTMLInputElement).value);
      PlantSelector._openDropdown();
    });
    PlantSelector._input!.addEventListener('keydown', PlantSelector._onKeydown);
    PlantSelector._input!.addEventListener('blur', () => {
      // Defer close so clicks on dropdown items can fire first.
      setTimeout(() => {
        PlantSelector._closeDropdown();
        PlantSelector._restoreLabel();
      }, 120);
    });
    PlantSelector._clearBtn!.addEventListener('mousedown', e => e.preventDefault());
    PlantSelector._clearBtn!.addEventListener('click', () => {
      Store.setSelectedPlant(null, 'header');
      (PlantSelector._input as HTMLInputElement).value = '';
      PlantSelector._reflectSelection();
      PlantSelector._input!.focus();
    });

    document.addEventListener('click', e => {
      if (!PlantSelector._root!.contains(e.target as Node)) PlantSelector._closeDropdown();
    });

    Store.subscribe(evt => {
      if (evt.type === 'plant:selected') {
        if (evt.source !== 'header') PlantSelector._reflectSelection();
      }
      if (evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate' || evt.type === 'lineSettings:change') {
        PlantSelector._refreshOptions();
      }
      if (evt.type === 'master-data-changed') {
        // Descriptions may have just arrived (or been edited) — refresh the
        // option list and the current-plant label so both pick up the name.
        PlantSelector._refreshOptions();
        PlantSelector._reflectSelection();
      }
    }, 'PlantSelector');

    PlantSelector._refreshOptions();
    PlantSelector._reflectSelection();
  },

  _refreshOptions(): void {
    PlantSelector._options = Store.knownPlants();
  },

  _reflectSelection(): void {
    const plant = Store.selectedPlant;
    const isSet = !!plant;
    const label = isSet ? Store.plantLabel(plant) : '';
    const input = PlantSelector._input as HTMLInputElement;
    input.value = label;
    // Ellipsis-truncated in CSS at this width — full label still readable on hover.
    if (label) input.title = label; else input.removeAttribute('title');
    PlantSelector._combobox!.classList.toggle('has-value', isSet);
    PlantSelector._clearBtn!.hidden = !isSet;
    PlantSelector._autosizeInput();
  },

  // Sizes the input to fit its current label (clamped to the CSS min/max-width
  // rails) instead of a one-size-fits-all fixed width — plant descriptions
  // range from a bare code up to a long site name, and a fixed width either
  // wastes space or clips names, at any of the 50+ plants this is meant to scale to.
  _autosizeInput(): void {
    const input = PlantSelector._input as HTMLInputElement;
    if (!PlantSelector._measureCtx) {
      PlantSelector._measureCtx = document.createElement('canvas').getContext('2d');
    }
    const ctx = PlantSelector._measureCtx;
    if (!ctx) return; // canvas unsupported — CSS min/max-width still bound the box
    const text = input.value || input.getAttribute('placeholder') || '';
    const cs = getComputedStyle(input);
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const textWidth = ctx.measureText(text).width;
    const clearBtnRoom = (PlantSelector._clearBtn && !PlantSelector._clearBtn.hidden) ? 22 : 0;
    const chrome = 8 + 9 + 2 + clearBtnRoom + 4; // padding + border + clear (x) button + measurement fudge
    input.style.width = Math.ceil(textWidth + chrome) + 'px';
  },

  _restoreLabel(): void {
    // After blur, reset the typed query back to the canonical "<code> — <description>" label.
    PlantSelector._reflectSelection();
  },

  _openDropdown(): void {
    PlantSelector._dropdown!.hidden = false;
    PlantSelector._open = true;
    PlantSelector._input!.setAttribute('aria-expanded', 'true');
    // The dropdown shares this input's positioning context (#hps-combobox),
    // which is only as wide as the input itself — so a tightly autosized
    // input (e.g. just "Select") starves option rows of room and their
    // "<code> — <description>" wraps mid-label. Widen to the full rail while
    // searching; _reflectSelection()/_autosizeInput() shrinks it back on
    // close (blur, Escape, or picking an option all route through it).
    const input = PlantSelector._input as HTMLInputElement;
    input.style.width = getComputedStyle(input).maxWidth;
  },
  _closeDropdown(): void {
    PlantSelector._dropdown!.hidden = true;
    PlantSelector._open = false;
    PlantSelector._activeIdx = -1;
    PlantSelector._input!.setAttribute('aria-expanded', 'false');
  },

  _renderDropdown(query: string): void {
    const q = (query || '').trim().toLowerCase();
    // If the input still holds the canonical plant label, do not use
    // it as a filter — show the full list.
    const looksLikeLabel = Store.selectedPlant
      && query.trim().toLowerCase() === Store.plantLabel(Store.selectedPlant).toLowerCase();
    const filterQ = looksLikeLabel ? '' : q;
    const matches = (p: string): boolean => {
      if (p.toLowerCase().includes(filterQ)) return true;
      const desc = (Store.masterPlant(p)?.description ?? '').toLowerCase();
      return !!desc && desc.includes(filterQ);
    };
    const base = filterQ
      ? PlantSelector._options.filter(matches)
      : PlantSelector._options.slice();

    // Surface the user's pinned plants at the top (scale-safe quick access at
    // 50+ plants). _filtered order MUST match the rendered option order so
    // keyboard nav (data-idx) stays correct.
    let pinnedSet: Set<string>;
    try { pinnedSet = new Set((Store.pref('pinnedPlants') as string[] | undefined) ?? []); } catch { pinnedSet = new Set(); }
    const pinned = base.filter(p => pinnedSet.has(p));
    const rest   = base.filter(p => !pinnedSet.has(p));
    PlantSelector._filtered = [...pinned, ...rest];

    if (!PlantSelector._filtered.length) {
      PlantSelector._dropdown!.innerHTML =
        `<div class="hps-empty">${PlantSelector._options.length ? Util.t('ui.no_matches') : Util.t('ui.no_plant_data_loaded')}</div>`;
      PlantSelector._activeIdx = -1;
      return;
    }
    const sel = Store.selectedPlant;
    const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c: string) => (({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]));
    const optHtml = (p: string, i: number): string => {
      const isSel = p === sel;
      const isPin = pinnedSet.has(p);
      const desc = (Store.masterPlant(p)?.description ?? '').trim();
      return `<div class="hps-option${isSel ? ' selected' : ''}" role="option" data-plant="${p}" data-idx="${i}">
        <span class="hps-option-prefix">${Util.t('ui.plant_label')}</span><span class="hps-option-code">${esc(p)}</span>${desc ? `<span class="hps-option-desc">${esc(desc)}</span>` : ''}
        ${isPin ? '<span class="hps-pin-ico" aria-hidden="true">📌</span>' : ''}
      </div>`;
    };
    let ddHtml = '';
    PlantSelector._filtered.forEach((p, i) => {
      if (pinned.length && i === 0) ddHtml += `<div class="hps-section">${Util.t('us.pinned_section')}</div>`;
      if (pinned.length && rest.length && i === pinned.length) ddHtml += `<div class="hps-section">${Util.t('us.all_plants_section')}</div>`;
      ddHtml += optHtml(p, i);
    });
    PlantSelector._dropdown!.innerHTML = ddHtml;
    PlantSelector._activeIdx = Math.max(0, PlantSelector._filtered.indexOf(sel ?? ''));
    PlantSelector._highlightActive();
    PlantSelector._dropdown!.querySelectorAll<HTMLElement>('.hps-option').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        PlantSelector._select(el.dataset.plant as string);
      });
    });
  },

  _highlightActive(): void {
    const items = PlantSelector._dropdown!.querySelectorAll('.hps-option');
    items.forEach((el, i) => el.classList.toggle('active', i === PlantSelector._activeIdx));
    const active = items[PlantSelector._activeIdx];
    if (active) active.scrollIntoView({ block: 'nearest' });
  },

  _onKeydown(e: KeyboardEvent): void {
    if (!PlantSelector._open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        PlantSelector._renderDropdown((PlantSelector._input as HTMLInputElement).value);
        PlantSelector._openDropdown();
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      PlantSelector._activeIdx = Math.min(PlantSelector._activeIdx + 1, PlantSelector._filtered.length - 1);
      PlantSelector._highlightActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      PlantSelector._activeIdx = Math.max(PlantSelector._activeIdx - 1, 0);
      PlantSelector._highlightActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = PlantSelector._filtered[PlantSelector._activeIdx];
      if (pick) PlantSelector._select(pick);
    } else if (e.key === 'Escape') {
      PlantSelector._closeDropdown();
      PlantSelector._restoreLabel();
      PlantSelector._input!.blur();
    }
  },

  _select(plant: string): void {
    Store.setSelectedPlant(plant, 'header');
    PlantSelector._reflectSelection();
    PlantSelector._closeDropdown();
    PlantSelector._input!.blur();
  }
};

/* =============================================================================
   APP — bootstrap, tab switching, side-panel + resize handles.
   ========================================================================== */
const App = {
  _currentTab: 'home' as TopLevelTab,
  _currentMasterSub: 'lines' as MasterSubTab,
  _ganttSub: 'timeline' as GanttSubTab,
  _laborSub: 'aggregate' as LaborSubTab,
  _pausables: new Set<{ pause?(): void; resume?(): void }>(),
  _drawerOpen: false,
  // Minute-aligned tick chain for the drawer's plant-local clock; armed in
  // _openDrawer, cleared in _closeDrawer so it never runs while the drawer is
  // shut. Plain ReturnType<typeof setTimeout>, not setInterval — re-aligning
  // to the next minute boundary on every tick keeps it from drifting.
  _plantClockTimer: null as ReturnType<typeof setTimeout> | null,
  _prevTab: null as TopLevelTab | null,
  // Context-bar Lines combobox search text (mirrors ProdLines._lineSearch /
  // LaborPlanning's equivalent — same pattern, just owned by the persistent
  // header control instead of a per-tab toolbar).
  _linesPillSearch: '',
  // Assigned externally from app.js once this module loads (see this file's
  // header comment) — showLoginScreen's sign-in success handler and the
  // DOMContentLoaded gate both call it. Never set from within this file.
  _bootMain: undefined as (() => void) | undefined,

  // Session-scoped scroll-position memory (Part A2). Keyed by the same
  // tab/sub identity goto/gotoGanttSub/gotoMasterSub/gotoLaborSub already
  // compute (e.g. 'home', 'gantt:timeline', 'masterdata:plant',
  // 'labor:capacity'). Deliberately a plain in-memory Map, not Store.pref
  // or localStorage — mirrors Timeline._viewWindow's existing idiom of a
  // module-level variable for session-only UI state that shouldn't survive
  // a reload. Cleared on plant switch (see Store.subscribe below) since a
  // remembered offset means nothing once the content is entirely different.
  _scrollMemory: new Map<string, number>(),

  // Register any object with pause()/resume() to be auto-paused on tab hide.
  registerPausable(obj: { pause?(): void; resume?(): void } | null | undefined): void {
    if (obj && (typeof obj.pause === 'function' || typeof obj.resume === 'function')) {
      App._pausables.add(obj);
    }
  },

  /* ── Nav drawer (Command Band re-skin, Task 4) ────────────────────────────
     Open/close + a11y: ESC closes, a simple focus trap keeps focus inside the
     drawer while open, aria-expanded mirrors state, body scroll is locked, and
     focus returns to the hamburger on close. Mutual exclusion on open: close
     the alert drawer (same idiom the command-palette FAB already uses —
     nimbus-intelligence.js — `document.getElementById('alert-drawer')?.classList
     .remove('open')`) and close the command palette via its own real
     NIMBUS.CommandPalette.close() (idempotent — safe even if already closed;
     no new close mechanism invented here). */
  _openDrawer(): void {
    const drawer = document.getElementById('nav-drawer');
    const scrim  = document.getElementById('nav-drawer-scrim');
    const toggle = document.getElementById('nav-drawer-toggle');
    if (!drawer || !scrim) return;
    document.getElementById('alert-drawer')?.classList.remove('open');
    try { if (typeof NIMBUS !== 'undefined') NIMBUS.CommandPalette?.close?.(); } catch {}
    drawer.classList.add('open');
    scrim.classList.add('open');
    App._drawerOpen = true;
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', App._onDrawerKeydown);
    const closeBtn = document.getElementById('nav-drawer-close');
    (closeBtn || drawer).focus();
    App._renderDrawerPlantMeta();
    App._armPlantClockTimer();
  },

  _closeDrawer(): void {
    const drawer = document.getElementById('nav-drawer');
    const scrim  = document.getElementById('nav-drawer-scrim');
    const toggle = document.getElementById('nav-drawer-toggle');
    if (!drawer || !scrim) return;
    drawer.classList.remove('open');
    scrim.classList.remove('open');
    App._drawerOpen = false;
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', App._onDrawerKeydown);
    if (App._plantClockTimer != null) { clearTimeout(App._plantClockTimer); App._plantClockTimer = null; }
    toggle?.focus();
  },

  // Re-arms itself on every tick, aligned to the next minute boundary, so the
  // clock flips exactly on the minute instead of drifting off a fixed interval.
  _armPlantClockTimer(): void {
    if (App._plantClockTimer != null) clearTimeout(App._plantClockTimer);
    const tick = (): void => {
      if (!App._drawerOpen) return;
      App._renderDrawerPlantMeta();
      App._plantClockTimer = setTimeout(tick, 60000 - (Date.now() % 60000));
    };
    App._plantClockTimer = setTimeout(tick, 60000 - (Date.now() % 60000));
  },

  // ESC closes the drawer; Tab/Shift+Tab is a simple focus trap scoped to the
  // drawer's own interactive elements while it is open. Kept deliberately
  // simple per the brief — this is a slide-in nav drawer, not a complex widget.
  _onDrawerKeydown(e: KeyboardEvent): void {
    if (!App._drawerOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      // The Change-Plant modal renders ON TOP of the still-open drawer
      // (see App._openChangePlantModal) — Escape must dismiss it first,
      // not fall through to the drawer's own (until now, sole) global
      // Escape handler.
      const cpModal = document.getElementById('modal-change-plant');
      if (cpModal && !cpModal.hidden) { Modal.close('modal-change-plant'); return; }
      App._closeDrawer();
      return;
    }
    if (e.key !== 'Tab') return;
    const drawer = document.getElementById('nav-drawer');
    if (!drawer) return;
    const focusables = Array.from(drawer.querySelectorAll<HTMLElement>(
      'button:not([hidden]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )).filter(el => !(el as HTMLButtonElement).disabled);
    if (!focusables.length) return;
    const first = focusables[0];
    const last  = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  },

  /* ── Change Plant modal (nav-drawer "Change" action) ──────────────────────
     Opens ON TOP of the still-open drawer — deliberately does NOT call
     App._closeDrawer(), replacing the old delegate-to-header-combobox
     behavior. Filter + pinned-first ordering mirrors PlantSelector
     ._renderDropdown at a level of complexity appropriate for a modal
     list: click-to-select-and-close, no keyboard nav / combobox mechanics.
     Selecting a plant calls Store.setSelectedPlant(plant, 'nav-drawer');
     PlantSelector's own Store.subscribe listener (source !== 'header')
     already re-syncs the header combobox with zero new coupling. */
  _openChangePlantModal(): void {
    const search = document.getElementById('cpm-search') as HTMLInputElement | null;
    if (!search) return;
    search.value = '';
    App._renderChangePlantList('');
    Modal.open('modal-change-plant');
    search.focus();
  },

  _renderChangePlantList(query: string): void {
    const list = document.getElementById('cpm-list');
    if (!list) return;
    const all = Store.knownPlants();
    const q = query.trim().toLowerCase();
    const matches = (p: string): boolean => {
      if (p.toLowerCase().includes(q)) return true;
      const desc = (Store.masterPlant(p)?.description ?? '').toLowerCase();
      return !!desc && desc.includes(q);
    };
    const base = q ? all.filter(matches) : all.slice();

    let pinnedSet: Set<string>;
    try { pinnedSet = new Set((Store.pref('pinnedPlants') as string[] | undefined) ?? []); } catch { pinnedSet = new Set(); }
    const pinned = base.filter(p => pinnedSet.has(p));
    const rest   = base.filter(p => !pinnedSet.has(p));
    const filtered = [...pinned, ...rest];

    if (!filtered.length) {
      list.innerHTML = `<div class="hps-empty">${all.length ? Util.t('ui.no_matches') : Util.t('ui.no_plant_data_loaded')}</div>`;
      return;
    }
    const sel = Store.selectedPlant;
    const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c: string) => (({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]));
    let html = '';
    filtered.forEach((p, i) => {
      if (pinned.length && i === 0) html += `<div class="hps-section">${Util.t('us.pinned_section')}</div>`;
      if (pinned.length && rest.length && i === pinned.length) html += `<div class="hps-section">${Util.t('us.all_plants_section')}</div>`;
      const isSel = p === sel;
      const isPin = pinnedSet.has(p);
      const desc = (Store.masterPlant(p)?.description ?? '').trim();
      html += `<div class="hps-option${isSel ? ' selected' : ''}" role="option" data-plant="${p}">
        <span class="hps-option-prefix">${Util.t('ui.plant_label')}</span><span class="hps-option-code">${esc(p)}</span>${desc ? `<span class="hps-option-desc">${esc(desc)}</span>` : ''}
        ${isPin ? '<span class="hps-pin-ico" aria-hidden="true">📌</span>' : ''}
      </div>`;
    });
    list.innerHTML = html;
    list.querySelectorAll<HTMLElement>('.hps-option').forEach(el => {
      el.addEventListener('click', () => App._selectChangePlant(el.dataset.plant as string));
    });
  },

  _selectChangePlant(plant: string): void {
    Store.setSelectedPlant(plant, 'nav-drawer');
    Modal.close('modal-change-plant');
  },

  // Live label at the bottom of the drawer — kept in sync via Store.subscribe
  // in init() regardless of *who* changed the plant (header combobox, this
  // modal, or any other writer), not just this modal's own selections.
  _reflectDrawerPlantLabel(): void {
    const lbl = document.getElementById('nav-drawer-plant-current');
    if (lbl) {
      const plant = Store.selectedPlant;
      lbl.textContent = plant ? Store.plantLabel(plant) : Util.t('ui.select_plant_label');
    }
    App._renderDrawerPlantMeta();
  },

  // Quiet secondary line under the plant name: what the plant makes, and its
  // local clock. Both are optional per-plant — hidden individually when
  // absent, and the whole row hides when neither is available. The clock
  // only ever shows genuine plant-local time (Util.plantNowParts zoned:true);
  // an empty/invalid timezone hides the clock rather than mislabeling viewer
  // time as "plant time".
  _renderDrawerPlantMeta(): void {
    const row = document.getElementById('nav-drawer-plant-meta') as HTMLElement | null;
    const focusEl = document.getElementById('nav-drawer-plant-focus') as HTMLElement | null;
    const clockEl = document.getElementById('nav-drawer-plant-clock') as HTMLElement | null;
    if (!row || !focusEl || !clockEl) return;
    const plant = Store.selectedPlant;
    const mp = plant ? Store.masterPlant(plant) : null;
    const focus = (mp?.product_focus ?? '').trim();
    focusEl.textContent = focus;
    focusEl.hidden = !focus;
    let clockText = '';
    if (mp?.timezone) {
      const t = Util.plantNowParts(mp.timezone);
      if (t.zoned) clockText = Util.t('ui.plant_time', { time: t.hhmm });
    }
    clockEl.textContent = clockText;
    clockEl.hidden = !clockText;
    row.hidden = !focus && !clockText;
  },

  // Command-band active-section label — MUST be set via inline Util.t() on
  // every navigation, NOT a static data-i18n attribute: App.init()'s
  // [data-i18n] sweep is one-shot and never re-runs on this dynamically-
  // updated node (see global-constraints.md's i18n note + the CSS comment
  // on .cmd-section-label in styles.css).
  _updateSectionLabel(tab: TopLevelTab): void {
    const el = document.getElementById('cmd-band-section-label');
    if (!el) return;
    const KEY: Record<TopLevelTab, string> = { home: 'tab.home', gantt: 'tab.gantt', labor: 'tab.labor', masterdata: 'tab.masterdata', admin: 'tab.admin' };
    el.textContent = KEY[tab] ? Util.t(KEY[tab]) : '';
  },

  // Context-bar Lines combobox — a persistent, always-visible control (same
  // footing as the Plant selector next to it), reading/writing the same
  // Store.selectedLines every screen already reacts to via 'lines:selected'.
  // Tab-local Lines buttons (Gantt/Dashboard/Labor/Master Data) are untouched
  // and keep working independently — this is an additional global entry
  // point into the same shared selection, not a replacement.
  _renderLinesPillChecklist(): void {
    const plant = Store.selectedPlant;
    const candidates = plant ? Store.linesForSelectedPlant() : [];
    Util.renderLineChecklist(
      document.getElementById('context-lines-checklist'), candidates, Store.selectedLines, App._linesPillSearch,
      (line, checked) => {
        const next = new Set(Store.selectedLines);
        if (checked) next.add(line); else next.delete(line);
        Store.setSelectedLines(next, 'header');
      });
  },

  _refreshLinesPillLabel(): void {
    Util.refreshMultiSelectLabel(
      document.getElementById('context-lines-label'), document.getElementById('context-lines-pill'), Store.selectedLines);
  },

  _toggleLinesPillDropdown(e?: Event): void {
    e?.stopPropagation();
    const drop = document.getElementById('context-lines-dropdown');
    if (!drop) return;
    drop.hidden = !drop.hidden;
    if (!drop.hidden) App._renderLinesPillChecklist();
  },

  init(): void {
    /* Apply locale translations to static HTML elements */
    document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
      el.textContent = Util.t(el.dataset.i18n as string);
    });
    document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach(el => {
      el.title = Util.t(el.dataset.i18nTitle as string);
    });
    document.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach(el => {
      (el as HTMLInputElement).placeholder = Util.t(el.dataset.i18nPlaceholder as string);
    });

    /* Tab buttons */
    document.querySelectorAll<HTMLElement>('.tab-btn').forEach(btn => {
      btn.onclick = () => App.goto(btn.dataset.tab as TopLevelTab | 'table');
    });

    /* Nav drawer (Command Band re-skin) — hamburger open, scrim/close-button
       close, ESC + focus trap + aria-expanded + scroll-lock + focus-return
       live in _openDrawer/_closeDrawer/_onDrawerKeydown above. There is no
       data-i18n-aria-label sweep mechanism, so the hamburger's aria-label is
       set here via inline Util.t() (mirrors the existing inline-aria-label
       pattern used elsewhere, e.g. nimbus-intelligence.js's command-palette
       FAB) rather than the static "Menu" placeholder Task 3 left in markup. */
    const navDrawerToggle = document.getElementById('nav-drawer-toggle');
    if (navDrawerToggle) {
      navDrawerToggle.setAttribute('aria-label', Util.t('aria.nav_drawer_toggle'));
      navDrawerToggle.addEventListener('click', () => {
        App._drawerOpen ? App._closeDrawer() : App._openDrawer();
      });
    }
    document.getElementById('nav-drawer-scrim')?.addEventListener('click', () => App._closeDrawer());
    const navDrawerClose = document.getElementById('nav-drawer-close');
    if (navDrawerClose) {
      navDrawerClose.setAttribute('aria-label', Util.t('aria.nav_drawer_close'));
      navDrawerClose.addEventListener('click', () => App._closeDrawer());
    }

    /* Drawer's PLANT row — "Change" button opens a modal ON TOP of the
       still-open drawer (drawer is intentionally NOT closed here — this
       replaces the old delegate-to-header-combobox behavior). The
       drawer's live plant-name label stays in sync with any writer via
       the Store.subscribe below, not just this button's own clicks. */
    document.getElementById('nav-drawer-plant-btn')?.addEventListener('click', () => {
      App._openChangePlantModal();
    });
    document.getElementById('cpm-search')?.addEventListener('input', e => {
      App._renderChangePlantList((e.target as HTMLInputElement).value);
    });
    App._reflectDrawerPlantLabel();
    Store.subscribe(evt => {
      if (evt.type === 'plant:selected' || evt.type === 'master-data-changed') App._reflectDrawerPlantLabel();
    }, 'NavDrawerPlantLabel');

    /* Lines combobox (context bar) — persistent, always-visible control next
       to Plant. Wiring mirrors GanttFilter/LaborPlanning/ProdLines' own line
       pickers: click toggles the dropdown, outside-click closes it, search
       filters the checklist, paste auto-checks matches. */
    const linesPillBtn  = document.getElementById('context-lines-pill');
    const linesPillDrop = document.getElementById('context-lines-dropdown');
    linesPillBtn?.addEventListener('click', e => App._toggleLinesPillDropdown(e));
    document.addEventListener('click', (e: MouseEvent) => {
      if (linesPillDrop && !linesPillDrop.hidden
          && !linesPillDrop.contains(e.target as Node) && e.target !== linesPillBtn) {
        linesPillDrop.hidden = true;
      }
    });
    const linesPillSearch = document.getElementById('context-lines-search') as HTMLInputElement | null;
    if (linesPillSearch) {
      linesPillSearch.oninput = () => {
        App._linesPillSearch = linesPillSearch.value || '';
        App._renderLinesPillChecklist();
      };
      Util.wirePasteToCheckboxes(linesPillSearch,
        () => Array.from(document.getElementById('context-lines-checklist')?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') ?? []));
    }
    App._refreshLinesPillLabel();
    Store.subscribe(evt => {
      if (evt.type === 'lines:selected') App._refreshLinesPillLabel();
      if (evt.type === 'plant:selected') {
        App._linesPillSearch = '';
        App._renderLinesPillChecklist();
        App._refreshLinesPillLabel();
      }
    }, 'ContextLinesPill');

    /* Manage Master Data sub-tabs (Production Lines / Plant) */
    document.querySelectorAll<HTMLElement>('.md-master-subtabs .admin-subtab').forEach(btn => {
      btn.onclick = () => App.gotoMasterSub(btn.dataset.mdMaster as MasterSubTab);
    });

    /* Timeline toolbar view buttons */
    document.querySelectorAll<HTMLElement>('.gantt-toolbar .seg-btn[data-view]').forEach(btn => {
      btn.onclick = () => Timeline.setView(btn.dataset.view as string);
    });

    /* Gantt sub-tab toggle (Timeline vs Orders) — was a static onclick=
       attribute in index.html; converted to a real listener here (this
       task's own module, per this phase's inline-handler-migration mandate). */
    document.querySelectorAll<HTMLElement>('.gantt-toolbar .seg-btn[data-gantt-sub]').forEach(btn => {
      btn.onclick = () => App.gotoGanttSub(btn.dataset.ganttSub as GanttSubTab);
    });

    /* Labor Planning sub-tab toggle — same conversion as above. */
    document.querySelectorAll<HTMLElement>('.labor-toolbar .seg-btn[data-labor-sub]').forEach(btn => {
      btn.onclick = () => App.gotoLaborSub(btn.dataset.laborSub as LaborSubTab);
    });

    /* Work-header "Open schedule" CTA — same conversion as above. */
    document.getElementById('wh-cta-btn')?.addEventListener('click', () => App.gotoGanttTimeline());

    /* Alert bell */
    document.getElementById('alert-bell')!.onclick = () => AlertsUIAdapter.toggleDrawer();

    /* Resize handles for side panels */
    App._wireResize('left',  document.getElementById('left-sidebar')!);
    App._wireResize('right', document.getElementById('right-sidebar')!);

    /* Sidebar collapse toggles — same conversion as above. */
    document.getElementById('left-sidebar-toggle-btn')?.addEventListener('click', () => App.toggleSide('left'));
    document.getElementById('right-sidebar-toggle-btn')?.addEventListener('click', () => App.toggleSide('right'));

    /* Right inspector collapsed on load — reopens automatically when an order is clicked */
    document.getElementById('right-sidebar')!.classList.add('collapsed');

    /* Modal backdrop click = close */
    document.querySelectorAll<HTMLElement>('.modal-backdrop').forEach(b => {
      b.addEventListener('click', e => { if (e.target === b) Modal.close(b.id); });
    });

    /* Autosave on store mutations. Skip 'refresh' — those rows came FROM the server
       during conflict reconciliation, so writing them back would be a pointless echo. */
    Store.subscribe(evt => { if (evt.source !== 'refresh') Persistence._autosave(); }, 'Persistence.autosave');

    /* Track which tasks need to be written to the backend on next saveAll(). Optimize
       ('engine' source) marks its ids force so the authoritative reschedule bypasses
       the version check. 'refresh' is ignored — _refreshTasks already reconciled those. */
    Store.subscribe(evt => {
      if (evt.source === 'refresh') return;
      const force = evt.source === 'engine';
      if (evt.type === 'task:update') {
        Persistence._dirtyIds.add(String(evt.id));
        if (force) Persistence._forceIds.add(String(evt.id));
      }
      if (evt.type === 'tasks:bulkUpdate') (evt.ids as Array<string | number>).forEach(id => {
        Persistence._dirtyIds.add(String(id));
        if (force) Persistence._forceIds.add(String(id));
      });
      if (evt.type === 'tasks:bulk') { Persistence._dirtyIds.clear(); Persistence._forceIds.clear(); }
    }, 'Persistence.dirty');

    /* Reload tasks when the user switches to a different plant */
    Store.subscribe(evt => {
      if (evt.type === 'plant:selected' && evt.plant && evt.source !== 'restore') {
        Persistence.loadForPlant(evt.plant as string);
      }
    }, 'Persistence.plantLoad');

    /* Part A2: a remembered scroll offset means nothing once the plant
       switch has replaced the content underneath it — clear so every pane
       falls back to "scroll to top" on next visit, rather than restoring a
       stale position from the previous plant's (likely different-length)
       data. Fires for every 'plant:selected', including the initial boot
       selection and 'restore' — the memory is empty at boot either way, and
       clearing is idempotent. */
    Store.subscribe(evt => {
      if (evt.type === 'plant:selected') App._scrollMemory.clear();
    }, 'App.scrollMemoryReset');

    /* Keep alerts + dashboard in sync */
    Store.subscribe(evt => {
      // Any change touching schedule/firmed/calendar → recompute alerts.
      if (evt.type === 'task:update' || evt.type === 'tasks:bulk'
          || evt.type === 'tasks:bulkUpdate' || evt.type === 'firmed:change'
          || evt.type === 'calendar:change' || evt.type === 'blocks:change'
          || evt.type === 'plantBlocks:change') {
          Alerts.scheduleRecompute();
      }
      // Alert drawer always reflects current state if open
      if (evt.type === 'alerts:change') {
        const d = document.getElementById('alert-drawer');
        if (d && d.classList.contains('open') && typeof AlertsUIAdapter.renderDrawer === 'function') AlertsUIAdapter.renderDrawer();
        AlertsUIAdapter.renderBell();
      }
      // Blocks / calendar changes → re-render whichever sub-tab is active
      const onMaster = (sub: MasterSubTab) => App._currentTab === 'masterdata' && App._currentMasterSub === sub;
      if (evt.type === 'blocks:change' || evt.type === 'calendar:change') {
        if (onMaster('plant')) Plant.render();
        if (onMaster('lines')) ProdLines.render();
      }
      if (evt.type === 'plantBlocks:change') {
        if (onMaster('plant')) Plant.render();
        if (onMaster('lines')) ProdLines.render();
      }
      if (evt.type === 'lineSettings:change') {
        if (onMaster('plant')) Plant.render();
        if (onMaster('lines')) ProdLines.render();
      }
      if (evt.type === 'plant:selected') {
        ProdLines._lineSearch = '';
        if (onMaster('lines')) ProdLines.render();
      }
      if (evt.type === 'lines:selected') {
        // Cross-screen production-line filter (Gantt/Orders/Dashboard/Labor
        // Plan) — Store.setSelectedPlant already clears the selection itself
        // on a real plant change, so this only needs to react, not reset anything.
        if (onMaster('lines')) ProdLines.render();
      }
    }, 'App.sync');

    /* Redraw on window resize */
    window.addEventListener('resize', Util.debounce(() => {
      if (App._currentTab === 'gantt') Timeline.redraw();
    }, 120));

    /* Pause rAF loops and admin polling when the tab is hidden — saves CPU
       when the user has the app open but is in a different tab. */
    document.addEventListener('visibilitychange', () => {
      const hidden = document.hidden;
      App._pausables.forEach(p => {
        try { hidden ? p.pause?.() : p.resume?.(); }
        catch (e) { ErrorLog.warn('visibility', `Pausable threw: ${(e as Error).message}`); }
      });
      if (hidden) {
        try { AdminCockpit._stopHealthPolling?.(); } catch {}
      } else if (App._currentTab === 'admin') {
        try { AdminCockpit._startHealthPolling?.(); } catch {}
      }
    });

    // Priority-field registry (Stage 3) — load once at boot, independent of
    // plant selection, so Engine's scheduling-constraint catalog
    // (Engine.CONSTRAINT_CATALOG) and task-field lookup
    // (Engine._fieldTaskFields) reflect the real backend registry rather
    // than their hardcoded single-entry (colorWheel) fallback BEFORE any
    // optimize can run — not only once the Plant → Optimization tab happens
    // to open (Plant._loadPriorityOptimizationData,
    // plant-and-administration.mts:811, fetches the same endpoint for that
    // tab's own render; the duplication here is deliberate, per Task 7's
    // brief, since Engine needs the registry regardless of whether that tab
    // is ever opened). Loading-state note (R8): until this resolves,
    // CONSTRAINT_CATALOG stays the one-entry fallback — exactly today's
    // synchronous behavior, so a plant opened before this completes sees no
    // regression.
    //
    // Plant.onPriorityFieldsLoaded() is what makes the R8 loading state actually
    // recoverable: _renderSettingsPane is synchronous, so a Scheduling
    // Constraints pane opened before this resolves renders its whole tree — and,
    // critically, its add-field pickers — against the 1-entry fallback, which
    // leaves every picker disabled with no way back. Nothing re-rendered it
    // before (an earlier comment here asserted it did), so a slow fetch left the
    // tree unusable for the session. That call is a guarded no-op unless that
    // pane is the one on screen.
    //
    // Deliberately NOT a Store.emit: Persistence.autosave subscribes with no
    // event-type filter, so a broadcast here would schedule a full localStorage
    // write and invalidate Utilization's memo for a registry load that changes no
    // schedule data (the same reason Store.setPriorityRankMaps does not emit).
    fetch(`${Config.API_BASE}/priority-fields`)
      .then(r => r.ok ? r.json() : { fields: [] })
      .then((body: { fields?: PriorityFieldMeta[] }) => {
        Engine.setConstraintCatalog(body.fields || []);
        Engine.setFieldTaskFields(body.fields || []);
        Plant.onPriorityFieldsLoaded();
      })
      .catch(() => {}); // offline fallback: Engine.CONSTRAINT_CATALOG's hardcoded colorWheel entry stands
  },

  // First tab (in nav order) the current role can see; 'home' if somehow none
  // are — home is the only tab a role can't have hidden via the Roles tab UI
  // in practice (all-off would leave a user stranded), but this stays a hard
  // fallback rather than an assumption.
  _firstAccessibleTab(): TopLevelTab {
    const order: TopLevelTab[] = ['home', 'gantt', 'labor', 'masterdata', 'admin'];
    return order.find(t => Session.canAccessTab(t)) ?? 'home';
  },

  // Current tab/sub identity as a scroll-memory key. Mirrors the shape each
  // goto*Sub already tracks in its own _currentTab/_ganttSub/etc fields, so
  // this stays correct even if a caller saves/restores at a point where the
  // sub hasn't been reassigned yet (compute it explicitly, don't cache it).
  _scrollKeyFor(tab: TopLevelTab | null): string | null {
    if (!tab) return null;
    if (tab === 'gantt')      return `gantt:${App._ganttSub}`;
    if (tab === 'masterdata') return `masterdata:${App._currentMasterSub}`;
    if (tab === 'labor')      return `labor:${App._laborSub}`;
    return tab;
  },

  // The concrete scroll container(s) for a given pane key, plus the
  // VirtualList that owns one of them when applicable. Only panes with an
  // identifiable, persistent scroll container are listed — ag-grid-backed
  // panes (Orders sub-tab, Labor grids, Master Data material grids) manage
  // their own internal viewport and are left alone; nothing here disturbs
  // them. `vl` is a getter (not the instance itself) because the VirtualList
  // may not exist yet the first time a key is saved/restored.
  _paneScrollTargets(key: string): Array<{ el: HTMLElement; vl?: () => VirtualList<any> | null }> {
    switch (key) {
      case 'home': {
        const out: Array<{ el: HTMLElement; vl?: () => VirtualList<any> | null }> = [];
        const page = document.querySelector<HTMLElement>('.home-scroll');
        if (page) out.push({ el: page });
        const list = document.getElementById('line-status-panel');
        if (list) out.push({ el: list, vl: () => Dashboard._lsVL });
        return out;
      }
      case 'gantt:timeline': {
        // The Gantt's own horizontal/vertical timeline scroll is handled
        // separately by Timeline._vScrollTop (Part A3) — this is only the
        // sidebar line list next to it.
        const el = document.getElementById('hierarchy');
        return el ? [{ el, vl: () => Hierarchy._vl }] : [];
      }
      case 'admin': {
        const el = document.querySelector<HTMLElement>('.admin-scroll');
        return el ? [{ el }] : [];
      }
      case 'masterdata:plant': {
        const el = document.querySelector<HTMLElement>('#md-master-plant-pane .cal-scroll');
        return el ? [{ el }] : [];
      }
      default:
        return [];
    }
  },

  // Save the outgoing pane's scroll offset(s) before a tab/sub switch.
  _saveScroll(key: string | null): void {
    if (!key) return;
    App._paneScrollTargets(key).forEach((t, i) => {
      const vl = t.vl ? t.vl() : null;
      const top = vl ? vl.saveTop() : t.el.scrollTop;
      App._scrollMemory.set(`${key}#${i}`, top);
    });
  },

  // Restore (or default to top) the incoming pane's scroll offset(s). Routed
  // through restoreTop()/scrollToTop() for VirtualList-owned targets so the
  // list repaints its visible window to match, not just the raw pixel.
  _restoreScroll(key: string | null): void {
    if (!key) return;
    App._paneScrollTargets(key).forEach((t, i) => {
      const vl = t.vl ? t.vl() : null;
      const remembered = App._scrollMemory.get(`${key}#${i}`);
      if (vl) {
        if (remembered !== undefined) vl.restoreTop(remembered); else vl.scrollToTop();
      } else {
        t.el.scrollTop = remembered !== undefined ? remembered : 0;
      }
    });
  },

  goto(tab: TopLevelTab | 'table'): void {
    // Per-role page access (Security > Roles "Page Access" toggles) — blocks
    // the tab button, the Log button's click handler, and the Ctrl+Alt+L
    // shortcut simultaneously (all three route through here). Admins always
    // pass via Session.canAccessTab's own isAdmin() short-circuit.
    if (tab !== 'table' && !Session.canAccessTab(tab)) return;

    // Close the nav drawer on every navigation (Command Band re-skin, Task 4).
    if (App._drawerOpen) App._closeDrawer();

    // Redirect legacy 'table' references to the Orders sub-tab inside Scheduling Board
    if (tab === 'table') { App.goto('gantt'); App.gotoGanttSub('orders'); return; }

    // Collapse line accordions when leaving the masterdata tab entirely
    if (App._currentTab === 'masterdata' && tab !== 'masterdata') {
      document.querySelectorAll('details.line-accordion[open]').forEach(d => d.removeAttribute('open'));
      // The Production Lines line-filter dropdown is portaled onto <body> (see
      // ProdLines._wireNav) to escape the sidebar's overflow:hidden clipping,
      // so it no longer gets hidden for free by the tab-panel switch below.
      document.getElementById('lines-nav-filter-dropdown')?.setAttribute('hidden', '');
    }
    if (App._currentTab === 'admin' && tab !== 'admin') {
      try { AdminCockpit._stopHealthPolling(); } catch {}
    }
    // Save the outgoing pane's scroll offset before its content is torn down.
    // Only when actually changing tabs — re-entering the same tab (e.g. the
    // 'table' redirect above going gantt -> gantt) has no "outgoing" pane.
    if (App._currentTab && App._currentTab !== tab) {
      App._saveScroll(App._scrollKeyFor(App._currentTab));
      App._prevTab = App._currentTab;
    }
    App._currentTab = tab;
    App._updateSectionLabel(tab);
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(tab + '-tab')!.classList.add('active');
    document.querySelectorAll<HTMLElement>('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    if (tab === 'gantt') {
      App.gotoGanttSub(App._ganttSub || 'timeline');
    } else if (tab === 'home') {
      setTimeout(() => {
        Dashboard.render();
        // rAF, not inline: the restore must run after the browser has laid
        // out whatever Dashboard.render() just painted, or the max-scroll
        // clamp in restoreTop()/scrollToTop() is computed against stale
        // (often zero) scrollHeight.
        requestAnimationFrame(() => App._restoreScroll('home'));
      }, 30);
    } else if (tab === 'masterdata') {
      // Delegating instead of re-deciding: gotoMasterSub owns the whole
      // sub-pane registry (visibility + render dispatch), so a new sub-tab
      // can never again fall through to ProdLines here. gotoMasterSub's own
      // setTimeout(30) fires because App._currentTab is already 'masterdata'
      // (set above), so the render timing is unchanged.
      App.gotoMasterSub(App._currentMasterSub || 'lines');
    } else if (tab === 'admin') {
      setTimeout(() => {
        AdminCockpit.render();
        requestAnimationFrame(() => App._restoreScroll('admin'));
      }, 30);
    } else if (tab === 'labor') {
      setTimeout(() => App.gotoLaborSub(App._laborSub || 'aggregate'), 30);
    }
  },

  gotoGanttSub(sub: GanttSubTab): void {
    if (!['timeline', 'orders'].includes(sub)) return;
    // Only a genuine within-tab sub switch (not the initial gantt-tab entry,
    // where App._ganttSub already equals `sub` and there's no outgoing pane)
    // has anything worth saving.
    if (App._currentTab === 'gantt' && App._ganttSub !== sub) {
      App._saveScroll(App._scrollKeyFor('gantt'));
    }
    App._ganttSub = sub;
    document.querySelectorAll<HTMLElement>('.gantt-toolbar .seg-btn[data-gantt-sub]').forEach(b => {
      b.classList.toggle('active', b.dataset.ganttSub === sub);
    });
    const timelinePane = document.getElementById('gantt-sub-timeline');
    const ordersPane   = document.getElementById('gantt-sub-orders');
    if (timelinePane) timelinePane.style.display = sub === 'timeline' ? 'flex' : 'none';
    if (ordersPane)   ordersPane.style.display   = sub === 'orders'   ? 'flex' : 'none';
    const show = sub === 'timeline';
    ['gantt-zoom-controls', 'gantt-zoom-sep', 'gantt-fit-controls'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = show ? '' : 'none';
    });
    if (sub === 'orders') {
      setTimeout(() => {
        if (Table._api) Table._api.sizeColumnsToFit();
        requestAnimationFrame(() => App._restoreScroll('gantt:orders'));
      }, 30);
    } else {
      setTimeout(() => {
        Timeline.redraw(); Timeline.rebuild(); Hierarchy.render();
        GanttFilter._apply!();
        TimelineNav.render();
        if (DependencyOverlay._enabled) DependencyOverlay.render();
        requestAnimationFrame(() => App._restoreScroll('gantt:timeline'));
      }, 30);
    }
  },

  // Convenience combinator for every "go to a specific order/line" entry
  // point (AlertsUIAdapter.focus, Dashboard._gotoLine/_jumpToOrder, Timeline.gotoLineDay,
  // Command Palette handlers in nimbus-intelligence.js) that must manipulate
  // Timeline right after navigating. Plain App.goto('gantt') alone preserves
  // whatever Gantt sub-tab (timeline vs orders) was last active — if the
  // user was last on the Orders AG-Grid sub-tab, the Timeline pan/selection
  // happens invisibly behind it. Force 'timeline' explicitly instead. Do NOT
  // change App.goto('gantt') itself — that preservation behavior is correct
  // for plain top-nav tab switches.
  gotoGanttTimeline(): void {
    App.goto('gantt');
    App.gotoGanttSub('timeline');
  },

  // Push pref('firstDayOfWeek') into Flatpickr's default l10n so calendar pickers
  // start the week on the user's chosen day. Flatpickr reads firstDayOfWeek at
  // construction time, so this affects pickers created AFTER the call (all NIMBUS
  // pickers are lazily built on first open). Safe no-op if Flatpickr isn't loaded.
  _applyFirstDayOfWeek(): void {
    try {
      let fdow = Number(Store.pref('firstDayOfWeek'));
      if (fdow !== 0 && fdow !== 1) fdow = 0;
      if (typeof flatpickr !== 'undefined' && flatpickr.l10ns && flatpickr.l10ns.default) {
        (flatpickr.l10ns.default as { firstDayOfWeek?: number }).firstDayOfWeek = fdow;
      }
    } catch {}
  },

  // Navigate to the user's saved default landing view (pref('landingView') =
  // { tab, sub }), falling back to the Dashboard. Called once on boot after the
  // first task payload arrives. Guards each tab against the current role's
  // page access and only applies a sub-view for tabs that have one.
  _gotoLanding(): void {
    let lv: LandingViewPref | null = null;
    try { lv = (Store.pref('landingView') as LandingViewPref | undefined) ?? null; } catch {}
    const validTabs: TopLevelTab[] = ['home', 'gantt', 'masterdata', 'labor', 'admin'];
    let tab: TopLevelTab = (lv?.tab && (validTabs as string[]).includes(lv.tab)) ? (lv.tab as TopLevelTab) : 'home';
    if (!Session.canAccessTab(tab)) tab = App._firstAccessibleTab();
    App.goto(tab);
    const sub = lv && lv.sub;
    if (sub) {
      try {
        if (tab === 'gantt')           App.gotoGanttSub(sub as GanttSubTab);
        else if (tab === 'masterdata') App.gotoMasterSub(sub as MasterSubTab);
        else if (tab === 'labor')      App.gotoLaborSub(sub as LaborSubTab);
      } catch {}
    }
  },

  gotoLaborSub(sub: LaborSubTab): void {
    const valid: LaborSubTab[] = ['aggregate','line-plan','capacity','exceptions','inputs'];
    if (!valid.includes(sub)) return;
    // Same "genuine switch only" guard as gotoGanttSub — App._laborSub
    // already equals `sub` on plain tab entry, so this only fires when the
    // user actually clicks a different labor sub-tab while already there.
    if (App._currentTab === 'labor' && App._laborSub !== sub) {
      App._saveScroll(App._scrollKeyFor('labor'));
    }
    App._laborSub = sub;
    document.querySelectorAll<HTMLElement>('.labor-toolbar .seg-btn[data-labor-sub]').forEach(b => {
      b.classList.toggle('active', b.dataset.laborSub === sub);
    });
    valid.forEach(s => {
      const el = document.getElementById(`labor-sub-${s}`);
      if (el) el.style.display = s === sub ? 'flex' : 'none';
    });
    if (App._currentTab === 'labor') {
      const plant = Store.selectedPlant;
      if (plant) setTimeout(() => {
        LaborPlanning.render();
        requestAnimationFrame(() => App._restoreScroll(`labor:${sub}`));
      }, 30);
    }
  },

  // Registry of Master Data sub-panes — mirrors gotoLaborSub's `valid` array
  // above rather than a hardcoded two-pane if/else, so a new sub-tab is added
  // by appending one entry instead of touching four separate branches (the
  // old shape silently fell through to ProdLines.render() for any sub not
  // literally 'plant'). Order matches the button order in index.html.
  _MASTER_SUBS: [
    { sub: 'lines',          paneId: 'md-master-lines-pane',          render: () => ProdLines.render() },
    { sub: 'plant',          paneId: 'md-master-plant-pane',          render: () => Plant.render() },
    { sub: 'material',       paneId: 'md-master-material-pane',       render: () => MaterialGrids.render('material') },
    { sub: 'material-plant', paneId: 'md-master-material-plant-pane', render: () => MaterialGrids.render('material-plant') },
  ] as Array<{ sub: MasterSubTab; paneId: string; render(): void }>,

  gotoMasterSub(sub: MasterSubTab): void {
    const entry = App._MASTER_SUBS.find(e => e.sub === sub);
    if (!entry) return;
    // Same "genuine switch only" guard as gotoGanttSub/gotoLaborSub.
    if (App._currentTab === 'masterdata' && App._currentMasterSub !== sub) {
      App._saveScroll(App._scrollKeyFor('masterdata'));
    }
    // Collapse line accordions when switching away from the lines sub-tab
    if (App._currentMasterSub === 'lines' && sub !== 'lines') {
      document.querySelectorAll('details.line-accordion[open]').forEach(d => d.removeAttribute('open'));
      document.getElementById('lines-nav-filter-dropdown')?.setAttribute('hidden', '');
    }
    App._currentMasterSub = sub;
    document.querySelectorAll<HTMLElement>('.md-master-subtabs .admin-subtab').forEach(b => {
      b.classList.toggle('active', b.dataset.mdMaster === sub);
    });
    App._MASTER_SUBS.forEach(e => {
      const el = document.getElementById(e.paneId);
      if (el) el.hidden = (e.sub !== sub);
    });
    // Only trigger render when the masterdata tab is currently visible
    if (App._currentTab === 'masterdata') {
      setTimeout(() => {
        entry.render();
        requestAnimationFrame(() => App._restoreScroll(`masterdata:${sub}`));
      }, 30);
    }
  },

  toggleSide(which: 'left' | 'right'): void {
    const el = document.getElementById(which === 'left' ? 'left-sidebar' : 'right-sidebar');
    if (el) {
      el.classList.toggle('collapsed');
      if (which === 'left') {
        const btn = el.querySelector<HTMLElement>('.side-head .icon-btn');
        if (btn) btn.textContent = el.classList.contains('collapsed') ? '▶' : '◀';
      }
    }
    setTimeout(() => { Timeline.redraw(); TimelineNav.render(); }, Config.ANIM_MS);
  },

  _wireResize(side: 'left' | 'right', el: HTMLElement): void {
    const handle = el.querySelector<HTMLElement>('.resize-handle');
    if (!handle) return;
    let dragging = false;
    handle.addEventListener('mousedown', e => {
      dragging = true; document.body.style.cursor = 'ew-resize'; e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const w = side === 'left' ? e.clientX : window.innerWidth - e.clientX;
      if (w > 60 && w < 600) el.style.width = w + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; document.body.style.cursor = ''; Timeline.redraw(); }
    });
  }
};

export { Settings, SessionUIAdapter, showLoginScreen, EmptyState, PlantSelector, App };
