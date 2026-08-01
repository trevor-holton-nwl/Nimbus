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
import { Config, Util, ErrorLog, Toast, Modal } from './application-foundation.mjs';
import { Store } from './schedule-state.mjs';
import { Alerts } from './schedule-services.mjs';
import { Persistence, Session } from './schedule-data.mjs';
import { Timeline, TimelineNav, DependencyOverlay, Table, Hierarchy, GanttFilter, Dashboard, AlertsUIAdapter } from './schedule-workbench.mjs';
import { AdminCockpit, Plant, ProdLines, LaborPlanning } from './plant-and-administration.mjs';

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
  const CATALOG = [
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
  const DEFAULTS = {};
  for (const e of CATALOG) DEFAULTS[e.key] = e.default;

  const _byKey = {};
  for (const e of CATALOG) _byKey[e.key] = e;

  return {
    CATALOG,
    DEFAULTS,
    isRegion(key)   { return !!(_byKey[key] && _byKey[key].region); },
    byCategory(cat) { return CATALOG.filter(e => e.category === cat); },
  };
})();

/* =============================================================================
   SESSION UI ADAPTER — DOM/settings-pane remnant of the mandatory-login client
   session (CQ-1 Phase 2 Task 5). Session's pure state/API half (currentUser/
   actor/isAdmin/allowedPlants/pref/setPref/flushPrefs/signIn/signOut/refresh/
   onAuthDenied/updateCachedUser) lives in schedule-data.mjs, bridged in as the
   `Session` import above. This adapter owns everything that touches the DOM:
   gates (Admin tab visibility, header user-settings button, error-log badge),
   the User Settings modal (tab switching, Personalization/Workflow panes,
   Profile self-service, password change), all built on top of Session's
   public API. Mirrors the Phase 1 Sandbox/SandboxAdapter split exactly:
   `Session.signIn`/`signOut`/`refresh` emit `{type:'session:changed', kind}`
   instead of calling `_applyGates()`/DOM code inline; `SessionUIAdapter.init()`
   (called once from `_bootMain()`, alongside `SandboxAdapter.init()`) is the
   sole subscriber.
     SessionUIAdapter.init()        — subscribe to session:changed (call once, at boot)
     SessionUIAdapter._applyGates() — re-hides the Admin tab button / header
                                       user-settings button / error-log badge for
                                       non-admins; called after every session:changed
                                       AND once explicitly at boot (see _bootMain) so
                                       a resumed cached session (which never fires
                                       signIn(), so never emits) re-gates too.
   ========================================================================== */
const SessionUIAdapter = {
  init() {
    Store.subscribe(evt => {
      if (evt.type !== 'session:changed') return;
      SessionUIAdapter._applyGates();
      if (evt.kind === 'refresh') {
        // Mirrors the pre-split refresh()'s own DOM-adjacent tail exactly — Session
        // (schedule-data.mjs) only reports the FACTS (isAdmin(), plantAccessChanged);
        // every actual DOM/tab-navigation effect happens here.
        try { if (typeof PlantSelector !== 'undefined') PlantSelector._refreshOptions(); } catch {}
        // If we just lost admin while sitting on the Admin tab, leave it.
        if (!Session.isAdmin() && typeof App !== 'undefined' && App._currentTab === 'admin') {
          try { App.goto('home'); } catch {}
        }
        try {
          if (evt.plantAccessChanged) Toast.show(Util.t('sec.plant_access_changed'), 'warn');
          if (typeof PlantSelector !== 'undefined') PlantSelector._reflectSelection();
        } catch {}
      }
    }, 'SessionUIAdapter');
  },

  _applyGates() {
    const adminBtn = document.querySelector('.tab-btn[data-tab="admin"]');
    if (adminBtn) adminBtn.hidden = !Session.isAdmin();
    SessionUIAdapter._renderUserButton();
    try { ErrorLog.renderBadge(); } catch {}
  },

  // Avatar initials (Command Band re-skin, Task 4) — first_name/last_name are
  // the primary source; falls back to username-derived initials, then to
  // null (caller renders the static /Images/user.png icon) if there is no
  // name or username to derive anything from at all.
  _initialsFor(u) {
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
  _renderAvatar(btn, u) {
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
  _renderUserButton() {
    const btn = document.getElementById('user-settings-btn');
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
        const firstEl = document.getElementById('us-first-name');
        const lastEl = document.getElementById('us-last-name');
        if (signedInEl) signedInEl.textContent = Util.t('sec.signed_in_as', { username: current.username });
        if (roleEl) roleEl.textContent = current.role;
        if (firstEl) firstEl.value = current.first_name || '';
        if (lastEl) lastEl.value = current.last_name || '';
        // Build the Personalization / Workflow controls fresh so they reflect
        // the current resolved prefs each time the modal opens.
        try { SessionUIAdapter._renderSettingsPanes(); } catch (e) { ErrorLog.error('settings', `Render settings panes failed: ${e.message}`); }
        Modal.open('modal-user-settings');
      });
    }
    const signOutBtn = document.getElementById('us-signout-btn');
    if (signOutBtn && !signOutBtn._wired) {
      signOutBtn._wired = true;
      signOutBtn.addEventListener('click', Session.signOut);
    }
    const saveBtn = document.getElementById('us-save-btn');
    if (saveBtn && !saveBtn._wired) {
      saveBtn._wired = true;
      saveBtn.addEventListener('click', SessionUIAdapter.saveProfile);
    }
    const changePwBtn = document.getElementById('us-change-password-btn');
    if (changePwBtn && !changePwBtn._wired) {
      changePwBtn._wired = true;
      changePwBtn.addEventListener('click', SessionUIAdapter.changePassword);
    }
    // Wire the User Settings tab bar (Personalization / Workflow / Profile).
    // _renderSettingsPanes() populates the Personalization/Workflow panes on
    // modal open; this only toggles which pane + button is active. Wired once.
    document.querySelectorAll('#modal-user-settings [data-us-tab]').forEach(tabBtn => {
      if (tabBtn._wired) return;
      tabBtn._wired = true;
      tabBtn.addEventListener('click', () => SessionUIAdapter._showUserTab(tabBtn.getAttribute('data-us-tab')));
    });
  },

  // Toggle the active User Settings tab: highlight the button and reveal only
  // the matching pane (#us-tab-<name>). Names mirror Settings category ids.
  _showUserTab(name) {
    document.querySelectorAll('#modal-user-settings [data-us-tab]').forEach(b => {
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
  _optTag(value, label, selected) {
    const v = String(value);
    return `<option value="${v}"${v === String(selected) ? ' selected' : ''}>${label}</option>`;
  },

  // Repaint the display surfaces whose datetime labels are baked at render time,
  // so a timeFormat/dateFormat change is reflected without waiting for the next
  // natural re-render. Best-effort — never throws into the change handler.
  _repaintDisplayFormat() {
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

  _htmlEsc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  // Landing-view tab choices (admin tab only for admins) and their sub-views.
  _landingTabDefs() {
    const defs = [
      ['home',       Util.t('tab.home')],
      ['gantt',      Util.t('tab.gantt')],
      ['labor',      Util.t('us.tab_labor')],
      ['masterdata', Util.t('tab.masterdata')],
    ];
    if (Session.isAdmin()) defs.push(['admin', Util.t('tab.admin')]);
    return defs;
  },
  _landingSubDefs(tab) {
    if (tab === 'gantt')      return [['timeline', Util.t('us.landing_timeline')], ['orders', Util.t('tab.table')]];
    if (tab === 'masterdata') return [['lines', Util.t('tab.production_lines')], ['plant', Util.t('tab.plant')]];
    return null;   // home / labor / admin land on the tab with no sub-view here
  },

  // Render the small removable list of pinned values below a pinned combobox.
  _renderPinnedList(listEl, key) {
    if (!listEl) return;
    const items = (Session.pref(key) || []).slice();
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
  _initPinnedCombo({ inputId, dropdownId, listId, key, optionsFn, noneMsg, afterChange }) {
    const input    = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);
    const listEl   = document.getElementById(listId);
    if (!input || !dropdown || !listEl) return;
    let filtered = [];
    let activeIdx = -1;

    const open  = () => { dropdown.hidden = false; input.setAttribute('aria-expanded', 'true'); };
    const close = () => { dropdown.hidden = true; activeIdx = -1; input.setAttribute('aria-expanded', 'false'); };
    const highlight = () => {
      const els = dropdown.querySelectorAll('.us-combo-option');
      els.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
      const a = els[activeIdx]; if (a) a.scrollIntoView({ block: 'nearest' });
    };
    const add = (val) => {
      if (val == null) return;
      const cur = Session.pref(key) || [];
      if (!cur.includes(val)) Session.setPref(key, [...cur, val]);
      input.value = '';
      SessionUIAdapter._renderPinnedList(listEl, key);
      close();
      try { afterChange && afterChange(); } catch {}
    };
    const renderList = (query) => {
      const already = new Set(Session.pref(key) || []);
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
      dropdown.querySelectorAll('.us-combo-option').forEach(el => {
        el.addEventListener('mousedown', e => { e.preventDefault(); add(el.dataset.val); });
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
      const btn = e.target.closest('.us-pin-remove');
      if (!btn) return;
      const val = btn.dataset.val;
      Session.setPref(key, (Session.pref(key) || []).filter(x => x !== val));
      SessionUIAdapter._renderPinnedList(listEl, key);
      try { afterChange && afterChange(); } catch {}
    });
  },

  _renderSettingsPanes() {
    SessionUIAdapter._renderPersonalizationPane();
    SessionUIAdapter._renderWorkflowPane();
  },

  _renderPersonalizationPane() {
    const pane = document.getElementById('us-tab-personalization');
    if (!pane) return;
    // Seed from the ACTUALLY-applied theme (body.dark) so the control matches what
    // the user sees: DarkMode may have applied 'dark' from the legacy nimbus.theme
    // cache even when no user_settings.theme pref exists yet (pref() → 'light').
    const theme = document.body.classList.contains('dark') ? 'dark' : (Session.pref('theme') || 'light');
    const lang  = Session.pref('language');
    const langOpts = [
      ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'],
    ].map(([c, n]) => SessionUIAdapter._optTag(c, n, lang)).join('');
    // Landing view — tab select + (dependent) sub-view select.
    const lv       = Session.pref('landingView') || {};
    const lvTab    = SessionUIAdapter._landingTabDefs().some(([v]) => v === lv.tab) ? lv.tab : 'home';
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

    const themeSel = pane.querySelector('#us-pref-theme');
    themeSel.addEventListener('change', () => {
      const isDark = themeSel.value === 'dark';
      // DarkMode.set() does the write-through (Session.setPref + nimbus.theme cache
      // + repaint); fall back to a bare persist if the intelligence layer is absent.
      try {
        if (typeof NIMBUS !== 'undefined' && NIMBUS.DarkMode?.set) NIMBUS.DarkMode.set(isDark);
        else Session.setPref('theme', isDark ? 'dark' : 'light');
      } catch { Session.setPref('theme', isDark ? 'dark' : 'light'); }
    });

    const langSel = pane.querySelector('#us-pref-language');
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
    const landingTabSel = pane.querySelector('#us-landing-tab');
    const landingSubSel = pane.querySelector('#us-landing-sub');
    const _persistLanding = () => {
      const tab = landingTabSel.value;
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
    const gridToggle = pane.querySelector('#us-grid-layout-toggle');
    if (gridToggle) {
      gridToggle.addEventListener('change', () => {
        try { Table._setLayoutEnabled(gridToggle.checked); } catch {}
      });
    }
    const gridReset = pane.querySelector('#us-grid-layout-reset');
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
  _initDefaultPlantCombo(pane) {
    const input    = pane.querySelector('#us-plant-input');
    const dropdown = pane.querySelector('#us-plant-dropdown');
    const clearBtn = pane.querySelector('#us-plant-clear');
    const combo    = pane.querySelector('#us-plant-combo');
    if (!input || !dropdown || !combo) return;
    let filtered = [];
    let activeIdx = -1;

    const options = () => Store.knownPlants();          // already allowedPlants()-scoped
    const current = () => Session.pref('defaultPlant') || null;

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
    const choose = (plant) => { Session.setPref('defaultPlant', plant || null); reflect(); close(); input.blur(); };

    const renderList = (query) => {
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
      activeIdx = Math.max(0, filtered.indexOf(sel));
      highlight();
      dropdown.querySelectorAll('.us-combo-option').forEach(el => {
        el.addEventListener('mousedown', e => { e.preventDefault(); choose(el.dataset.plant); });
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

  _renderWorkflowPane() {
    const pane = document.getElementById('us-tab-workflow');
    if (!pane) return;
    const tf = Session.pref('timeFormat');
    const df = Session.pref('dateFormat');
    const now = new Date();
    const sample = (tok) => {
      try { if (typeof flatpickr !== 'undefined' && flatpickr.formatDate) return flatpickr.formatDate(now, tok); } catch {}
      return tok;
    };
    const dfTokens = ['M j, Y', 'm/d/Y', 'd/m/Y', 'Y-m-d', 'j M Y'];
    if (df && !dfTokens.includes(df)) dfTokens.unshift(df);   // keep a role/legacy value selectable
    const dfOpts = dfTokens.map(tok => SessionUIAdapter._optTag(tok, sample(tok), df)).join('');
    const fdow = Number(Session.pref('firstDayOfWeek'));
    const fdowSel = (fdow === 1) ? 1 : 0;
    // Optimizer defaults — seed the strategy + option toggles the dialog opens with.
    const od      = Session.pref('optimizerDefaults');
    const odMode  = (od && ['spt', 'changeover', 'combined'].includes(od.mode)) ? od.mode : 'changeover';
    const odFixed = od ? od.respectFixed !== false : true;
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
          ${SessionUIAdapter._optTag('combined',   Util.t('us.opt_mode_smart'),      odMode)}
        </select>
        <label class="us-toggle-row" style="margin-top:8px">
          <input type="checkbox" id="us-opt-fixed"${odFixed ? ' checked' : ''}>
          <span>${Util.t('us.opt_respect_fixed')}</span>
        </label>
        <label class="us-toggle-row">
          <input type="checkbox" id="us-opt-calendar"${odCal ? ' checked' : ''}>
          <span>${Util.t('us.opt_respect_calendar')}</span>
        </label>
        <button type="button" class="btn btn-ghost sm" id="us-opt-clear" style="margin-top:8px"${od ? '' : ' hidden'}>${Util.t('us.opt_defaults_clear')}</button>
        <p class="us-field-hint">${Util.t('us.opt_defaults_hint')}</p>
      </div>`;

    const tfSel = pane.querySelector('#us-pref-timeformat');
    tfSel.addEventListener('change', () => { Session.setPref('timeFormat', tfSel.value); SessionUIAdapter._repaintDisplayFormat(); });
    const dfSel = pane.querySelector('#us-pref-dateformat');
    dfSel.addEventListener('change', () => { Session.setPref('dateFormat', dfSel.value); SessionUIAdapter._repaintDisplayFormat(); });

    const fdSel = pane.querySelector('#us-pref-firstday');
    if (fdSel) fdSel.addEventListener('change', () => {
      const v = fdSel.value === '1' ? 1 : 0;
      Session.setPref('firstDayOfWeek', v);
      try { App._applyFirstDayOfWeek(); } catch {}
    });

    // Optimizer defaults — preserve any stored preset; the dialog's run() keeps
    // it fresh from the user's last actual run.
    const modeSel  = pane.querySelector('#us-opt-mode');
    const fixedChk = pane.querySelector('#us-opt-fixed');
    const calChk   = pane.querySelector('#us-opt-calendar');
    const writeOpt = () => {
      const existing = Session.pref('optimizerDefaults') || {};
      Session.setPref('optimizerDefaults', {
        mode: modeSel.value,
        preset: ['horizon', '2w'].includes(existing.preset) ? existing.preset : 'horizon',
        respectFixed: fixedChk.checked,
        respectCalendar: calChk.checked,
      });
      const clr = pane.querySelector('#us-opt-clear');
      if (clr) clr.hidden = false;
    };
    if (modeSel)  modeSel.addEventListener('change', writeOpt);
    if (fixedChk) fixedChk.addEventListener('change', writeOpt);
    if (calChk)   calChk.addEventListener('change', writeOpt);
    const optClear = pane.querySelector('#us-opt-clear');
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
  async saveProfile() {
    const firstEl = document.getElementById('us-first-name');
    const lastEl = document.getElementById('us-last-name');
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
      const updated = await r.json();
      Session.updateCachedUser({ first_name: updated.first_name || null, last_name: updated.last_name || null });
      // Refresh the header avatar immediately — updateCachedUser() doesn't emit an
      // event, and the next natural _renderUserButton() call is a future
      // session:changed (signin/refresh), which could be a while away.
      SessionUIAdapter._renderUserButton();
      Modal.close('modal-user-settings');
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: e.message }), 'error');
      ErrorLog.error('security', `Save profile failed: ${e.message}`);
    }
  },

  // Self-service: PATCH /security/me/password. Unlike saveProfile(), the
  // caller's identity header alone isn't enough here — the backend re-verifies
  // current_password (auth.change_own_password) since there's no session token
  // binding the header to a prior login. Fields are cleared on success but the
  // modal stays open (mirrors the admin panel's non-closing _savePassword).
  async changePassword() {
    const curEl = document.getElementById('us-current-password');
    const newEl = document.getElementById('us-new-password');
    const confEl = document.getElementById('us-confirm-password');
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
      Toast.show(Util.t('toast.save_failed', { msg: e.message }), 'error');
      ErrorLog.error('security', `Change password failed: ${e.message}`);
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
   ========================================================================== */
function showLoginScreen() {
  const root = document.createElement('div');
  root.className = 'login-screen';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', Util.t('sec.login_title'));

  const card = document.createElement('div');
  card.className = 'login-card';
  card.innerHTML = `
    <div class="login-title">${Util.t('sec.login_title')}</div>
    <form id="login-form" style="display:flex;flex-direction:column;gap:10px;">
      <input type="text" id="login-username" autocomplete="username" autocapitalize="off"
             placeholder="${Util.t('sec.username')}" aria-label="${Util.t('sec.username')}">
      <input type="password" id="login-password" autocomplete="current-password"
             placeholder="${Util.t('sec.password')}" aria-label="${Util.t('sec.password')}">
      <button type="submit" class="btn btn-primary" id="login-submit-btn">${Util.t('sec.sign_in')}</button>
    </form>
    <div class="login-error" id="login-error"></div>`;

  root.appendChild(card);
  document.body.appendChild(root);

  const userInp   = card.querySelector('#login-username');
  const passInp   = card.querySelector('#login-password');
  const errEl     = card.querySelector('#login-error');
  const submitBtn = card.querySelector('#login-submit-btn');

  userInp.addEventListener('input', () => {
    const pos = userInp.selectionStart;
    userInp.value = userInp.value.toLowerCase();
    userInp.setSelectionRange(pos, pos);
  });

  async function _submit() {
    errEl.textContent = '';
    submitBtn.disabled = true;
    try {
      await Session.signIn(userInp.value.trim().toLowerCase(), passInp.value);
      root.remove();
      App._bootMain();
    } catch (e) {
      // Deliberately generic — never reveal whether the username itself was wrong.
      errEl.textContent = Util.t('sec.login_invalid');
      submitBtn.disabled = false;
    }
  }

  card.querySelector('#login-form').addEventListener('submit', e => { e.preventDefault(); _submit(); });

  userInp.focus();
}

/* =============================================================================
   EMPTY STATE — reusable "select a plant" prompt rendered into a container
   whenever Store.selectedPlant is null. Each module that scopes by plant
   calls EmptyState.render(el, opts) instead of its normal render path.
   ========================================================================== */
const EmptyState = {
  render(container, opts = {}) {
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
  _root:     null,
  _input:    null,
  _dropdown: null,
  _clearBtn: null,
  _combobox: null,
  _options:  [],
  _filtered: [],
  _activeIdx: -1,
  _open:     false,

  init() {
    PlantSelector._root     = document.getElementById('header-plant-selector');
    PlantSelector._input    = document.getElementById('hps-input');
    PlantSelector._dropdown = document.getElementById('hps-dropdown');
    PlantSelector._clearBtn = document.getElementById('hps-clear');
    PlantSelector._combobox = document.getElementById('hps-combobox');
    if (!PlantSelector._root) return;

    PlantSelector._input.addEventListener('focus', () => {
      PlantSelector._refreshOptions();
      PlantSelector._renderDropdown(PlantSelector._input.value);
      PlantSelector._openDropdown();
    });
    PlantSelector._input.addEventListener('input', () => {
      PlantSelector._renderDropdown(PlantSelector._input.value);
      PlantSelector._openDropdown();
    });
    PlantSelector._input.addEventListener('keydown', PlantSelector._onKeydown);
    PlantSelector._input.addEventListener('blur', () => {
      // Defer close so clicks on dropdown items can fire first.
      setTimeout(() => {
        PlantSelector._closeDropdown();
        PlantSelector._restoreLabel();
      }, 120);
    });
    PlantSelector._clearBtn.addEventListener('mousedown', e => e.preventDefault());
    PlantSelector._clearBtn.addEventListener('click', () => {
      Store.setSelectedPlant(null, 'header');
      PlantSelector._input.value = '';
      PlantSelector._reflectSelection();
      PlantSelector._input.focus();
    });

    document.addEventListener('click', e => {
      if (!PlantSelector._root.contains(e.target)) PlantSelector._closeDropdown();
    });

    Store.subscribe(evt => {
      if (evt.type === 'plant:selected') {
        if (evt.source !== 'header') PlantSelector._reflectSelection();
      }
      if (evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate' || evt.type === 'lineSettings:change') {
        PlantSelector._refreshOptions();
      }
    }, 'PlantSelector');

    PlantSelector._refreshOptions();
    PlantSelector._reflectSelection();
  },

  _refreshOptions() {
    PlantSelector._options = Store.knownPlants();
  },

  _reflectSelection() {
    const plant = Store.selectedPlant;
    const isSet = !!plant;
    PlantSelector._input.value = isSet ? `${plant}` : '';
    PlantSelector._combobox.classList.toggle('has-value', isSet);
    PlantSelector._clearBtn.hidden = !isSet;
  },

  _restoreLabel() {
    // After blur, reset the typed query back to the canonical "Plant <id>" label.
    PlantSelector._reflectSelection();
  },

  _openDropdown() {
    PlantSelector._dropdown.hidden = false;
    PlantSelector._open = true;
    PlantSelector._input.setAttribute('aria-expanded', 'true');
  },
  _closeDropdown() {
    PlantSelector._dropdown.hidden = true;
    PlantSelector._open = false;
    PlantSelector._activeIdx = -1;
    PlantSelector._input.setAttribute('aria-expanded', 'false');
  },

  _renderDropdown(query) {
    const q = (query || '').trim().toLowerCase();
    // If the input still holds the canonical plant label, do not use
    // it as a filter — show the full list.
    const looksLikeLabel = Store.selectedPlant
      && query.trim().toLowerCase() === `${Store.selectedPlant}`.toLowerCase();
    const filterQ = looksLikeLabel ? '' : q;
    const base = filterQ
      ? PlantSelector._options.filter(p => p.toLowerCase().includes(filterQ))
      : PlantSelector._options.slice();

    // Surface the user's pinned plants at the top (scale-safe quick access at
    // 50+ plants). _filtered order MUST match the rendered option order so
    // keyboard nav (data-idx) stays correct.
    let pinnedSet;
    try { pinnedSet = new Set(Store.pref('pinnedPlants') || []); } catch { pinnedSet = new Set(); }
    const pinned = base.filter(p => pinnedSet.has(p));
    const rest   = base.filter(p => !pinnedSet.has(p));
    PlantSelector._filtered = [...pinned, ...rest];

    if (!PlantSelector._filtered.length) {
      PlantSelector._dropdown.innerHTML =
        `<div class="hps-empty">${PlantSelector._options.length ? 'No matches' : 'No plant data loaded'}</div>`;
      PlantSelector._activeIdx = -1;
      return;
    }
    const sel = Store.selectedPlant;
    const optHtml = (p, i) => {
      const isSel = p === sel;
      const isPin = pinnedSet.has(p);
      return `<div class="hps-option${isSel ? ' selected' : ''}" role="option" data-plant="${p}" data-idx="${i}">
        <span class="hps-option-prefix">${Util.t('ui.plant_label')}</span><span>${p}</span>
        ${isPin ? '<span class="hps-pin-ico" aria-hidden="true">📌</span>' : ''}
      </div>`;
    };
    let ddHtml = '';
    PlantSelector._filtered.forEach((p, i) => {
      if (pinned.length && i === 0) ddHtml += `<div class="hps-section">${Util.t('us.pinned_section')}</div>`;
      if (pinned.length && rest.length && i === pinned.length) ddHtml += `<div class="hps-section">${Util.t('us.all_plants_section')}</div>`;
      ddHtml += optHtml(p, i);
    });
    PlantSelector._dropdown.innerHTML = ddHtml;
    PlantSelector._activeIdx = Math.max(0, PlantSelector._filtered.indexOf(sel));
    PlantSelector._highlightActive();
    PlantSelector._dropdown.querySelectorAll('.hps-option').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        PlantSelector._select(el.dataset.plant);
      });
    });
  },

  _highlightActive() {
    const items = PlantSelector._dropdown.querySelectorAll('.hps-option');
    items.forEach((el, i) => el.classList.toggle('active', i === PlantSelector._activeIdx));
    const active = items[PlantSelector._activeIdx];
    if (active) active.scrollIntoView({ block: 'nearest' });
  },

  _onKeydown(e) {
    if (!PlantSelector._open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        PlantSelector._renderDropdown(PlantSelector._input.value);
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
      PlantSelector._input.blur();
    }
  },

  _select(plant) {
    Store.setSelectedPlant(plant, 'header');
    PlantSelector._reflectSelection();
    PlantSelector._closeDropdown();
    PlantSelector._input.blur();
  }
};

/* =============================================================================
   APP — bootstrap, tab switching, side-panel + resize handles.
   ========================================================================== */
const App = {
  _currentTab: 'home',
  _currentMasterSub: 'lines',
  _ganttSub: 'timeline',
  _laborSub: 'aggregate',
  _pausables: new Set(),
  _drawerOpen: false,

  // Register any object with pause()/resume() to be auto-paused on tab hide.
  registerPausable(obj) {
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
  _openDrawer() {
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
  },

  _closeDrawer() {
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
    toggle?.focus();
  },

  // ESC closes the drawer; Tab/Shift+Tab is a simple focus trap scoped to the
  // drawer's own interactive elements while it is open. Kept deliberately
  // simple per the brief — this is a slide-in nav drawer, not a complex widget.
  _onDrawerKeydown(e) {
    if (!App._drawerOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); App._closeDrawer(); return; }
    if (e.key !== 'Tab') return;
    const drawer = document.getElementById('nav-drawer');
    if (!drawer) return;
    const focusables = [...drawer.querySelectorAll(
      'button:not([hidden]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )].filter(el => !el.disabled);
    if (!focusables.length) return;
    const first = focusables[0];
    const last  = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  },

  // Command-band active-section label — MUST be set via inline Util.t() on
  // every navigation, NOT a static data-i18n attribute: App.init()'s
  // [data-i18n] sweep is one-shot and never re-runs on this dynamically-
  // updated node (see global-constraints.md's i18n note + the CSS comment
  // on .cmd-section-label in styles.css).
  _updateSectionLabel(tab) {
    const el = document.getElementById('cmd-band-section-label');
    if (!el) return;
    const KEY = { home: 'tab.home', gantt: 'tab.gantt', labor: 'tab.labor', masterdata: 'tab.masterdata', admin: 'tab.admin' };
    el.textContent = KEY[tab] ? Util.t(KEY[tab]) : '';
  },

  // Lines pill (context bar) — dispatcher only, no new line-filter UI or data
  // path. Routes to whichever tab/sub-tab's EXISTING line filter is active;
  // see the task report for the full tab → target dispatch table.
  _dispatchLinesPill(e) {
    const tab = App._currentTab;
    if (tab === 'home') {
      Dashboard._toggleDropdown('line-filter-dropdown', 'line-filter-btn');
    } else if (tab === 'gantt') {
      if (App._ganttSub === 'orders') Table._toggleChipDropdown('line');
      else GanttFilter._toggleLineDropdown();
    } else if (tab === 'labor') {
      LaborPlanning.toggleGroupDropdown(e);
    }
    // masterdata / admin: no equivalent line filter — the pill is hidden for
    // these tabs (see _updateLinesPillVisibility), so this is unreachable.
  },

  // Hidden entirely on tabs with no equivalent line filter (masterdata/admin);
  // visible (and dispatched per-tab by _dispatchLinesPill) everywhere else.
  _updateLinesPillVisibility(tab) {
    const pill = document.getElementById('context-lines-pill');
    if (!pill) return;
    pill.hidden = (tab === 'masterdata' || tab === 'admin');
  },

  init() {
    /* Apply locale translations to static HTML elements */
    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = Util.t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = Util.t(el.dataset.i18nTitle);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = Util.t(el.dataset.i18nPlaceholder);
    });

    /* Tab buttons */
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.onclick = () => App.goto(btn.dataset.tab);
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
    document.getElementById('nav-drawer-close')?.addEventListener('click', () => App._closeDrawer());

    /* Lines pill (context bar) — dispatch-only click handler; visibility is
       kept in sync with the active tab on every App.goto(), set once here
       for the initial ('home') tab. */
    document.getElementById('context-lines-pill')?.addEventListener('click', e => App._dispatchLinesPill(e));
    App._updateLinesPillVisibility(App._currentTab);

    /* Manage Master Data sub-tabs (Production Lines / Plant) */
    document.querySelectorAll('.md-master-subtabs .admin-subtab').forEach(btn => {
      btn.onclick = () => App.gotoMasterSub(btn.dataset.mdMaster);
    });

    /* Timeline toolbar view buttons */
    document.querySelectorAll('.gantt-toolbar .seg-btn[data-view]').forEach(btn => {
      btn.onclick = () => Timeline.setView(btn.dataset.view);
    });

    /* Gantt sub-tab toggle (Timeline vs Orders) — was a static onclick=
       attribute in index.html; converted to a real listener here (this
       task's own module, per this phase's inline-handler-migration mandate). */
    document.querySelectorAll('.gantt-toolbar .seg-btn[data-gantt-sub]').forEach(btn => {
      btn.onclick = () => App.gotoGanttSub(btn.dataset.ganttSub);
    });

    /* Labor Planning sub-tab toggle — same conversion as above. */
    document.querySelectorAll('.labor-toolbar .seg-btn[data-labor-sub]').forEach(btn => {
      btn.onclick = () => App.gotoLaborSub(btn.dataset.laborSub);
    });

    /* Work-header "Open schedule" CTA — same conversion as above. */
    document.getElementById('wh-cta-btn')?.addEventListener('click', () => App.gotoGanttTimeline());

    /* Alert bell */
    document.getElementById('alert-bell').onclick = () => AlertsUIAdapter.toggleDrawer();

    /* Resize handles for side panels */
    App._wireResize('left',  document.getElementById('left-sidebar'));
    App._wireResize('right', document.getElementById('right-sidebar'));

    /* Sidebar collapse toggles — same conversion as above. */
    document.getElementById('left-sidebar-toggle-btn')?.addEventListener('click', () => App.toggleSide('left'));
    document.getElementById('right-sidebar-toggle-btn')?.addEventListener('click', () => App.toggleSide('right'));

    /* Right inspector collapsed on load — reopens automatically when an order is clicked */
    document.getElementById('right-sidebar').classList.add('collapsed');

    /* Modal backdrop click = close */
    document.querySelectorAll('.modal-backdrop').forEach(b => {
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
      if (evt.type === 'tasks:bulkUpdate') evt.ids.forEach(id => {
        Persistence._dirtyIds.add(String(id));
        if (force) Persistence._forceIds.add(String(id));
      });
      if (evt.type === 'tasks:bulk') { Persistence._dirtyIds.clear(); Persistence._forceIds.clear(); }
    }, 'Persistence.dirty');

    /* Reload tasks when the user switches to a different plant */
    Store.subscribe(evt => {
      if (evt.type === 'plant:selected' && evt.plant && evt.source !== 'restore') {
        Persistence.loadForPlant(evt.plant);
      }
    }, 'Persistence.plantLoad');

    /* Keep alerts + dashboard in sync */
    Store.subscribe(evt => {
      // Any change touching schedule/fixed/calendar → recompute alerts.
      if (evt.type === 'task:update' || evt.type === 'tasks:bulk'
          || evt.type === 'tasks:bulkUpdate' || evt.type === 'fixed:change'
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
      const onMaster = (sub) => App._currentTab === 'masterdata' && App._currentMasterSub === sub;
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
        ProdLines._lineFilter = '';
        if (onMaster('lines')) ProdLines.render();
      }
    }, 'App.sync');

    /* Redraw on window resize */
    window.addEventListener('resize', Util.debounce(() => {
      if (App._currentTab === 'gantt') Timeline.redraw();
      if (App._currentTab === 'home') {
        if (Dashboard._chartToday) Dashboard._chartToday.resize();
      }
    }, 120));

    /* Pause rAF loops and admin polling when the tab is hidden — saves CPU
       when the user has the app open but is in a different tab. */
    document.addEventListener('visibilitychange', () => {
      const hidden = document.hidden;
      App._pausables.forEach(p => {
        try { hidden ? p.pause?.() : p.resume?.(); }
        catch (e) { ErrorLog.warn('visibility', `Pausable threw: ${e.message}`); }
      });
      if (hidden) {
        try { AdminCockpit._stopHealthPolling?.(); } catch {}
      } else if (App._currentTab === 'admin') {
        try { AdminCockpit._startHealthPolling?.(); } catch {}
      }
    });
  },

  goto(tab) {
    // Admin Cockpit is admin-only — blocks the tab button, the Log button's click
    // handler, and the Ctrl+Alt+L shortcut simultaneously (all three route through here).
    if (tab === 'admin' && !Session.isAdmin()) return;

    // Close the nav drawer on every navigation (Command Band re-skin, Task 4).
    if (App._drawerOpen) App._closeDrawer();

    // Redirect legacy 'table' references to the Orders sub-tab inside Scheduling Board
    if (tab === 'table') { App.goto('gantt'); App.gotoGanttSub('orders'); return; }

    // Collapse line accordions when leaving the masterdata tab entirely
    if (App._currentTab === 'masterdata' && tab !== 'masterdata') {
      document.querySelectorAll('details.line-accordion[open]').forEach(d => d.removeAttribute('open'));
    }
    if (App._currentTab === 'admin' && tab !== 'admin') {
      try { AdminCockpit._stopHealthPolling(); } catch {}
    }
    if (App._currentTab && App._currentTab !== tab) App._prevTab = App._currentTab;
    App._currentTab = tab;
    App._updateSectionLabel(tab);
    App._updateLinesPillVisibility(tab);
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(tab + '-tab').classList.add('active');
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    if (tab === 'gantt') {
      App.gotoGanttSub(App._ganttSub || 'timeline');
    } else if (tab === 'home') {
      setTimeout(() => Dashboard.render(), 30);
    } else if (tab === 'masterdata') {
      setTimeout(() => {
        if (App._currentMasterSub === 'plant') Plant.render();
        else ProdLines.render();
      }, 30);
    } else if (tab === 'admin') {
      setTimeout(() => AdminCockpit.render(), 30);
    } else if (tab === 'labor') {
      setTimeout(() => App.gotoLaborSub(App._laborSub || 'aggregate'), 30);
    }
  },

  gotoGanttSub(sub) {
    if (!['timeline', 'orders'].includes(sub)) return;
    App._ganttSub = sub;
    document.querySelectorAll('.gantt-toolbar .seg-btn[data-gantt-sub]').forEach(b => {
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
      setTimeout(() => Table._api && Table._api.sizeColumnsToFit(), 30);
    } else {
      setTimeout(() => {
        Timeline.redraw(); Timeline.rebuild(); Hierarchy.render();
        GanttFilter._apply();
        TimelineNav.render();
        if (DependencyOverlay._enabled) DependencyOverlay.render();
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
  gotoGanttTimeline() {
    App.goto('gantt');
    App.gotoGanttSub('timeline');
  },

  // Push pref('firstDayOfWeek') into Flatpickr's default l10n so calendar pickers
  // start the week on the user's chosen day. Flatpickr reads firstDayOfWeek at
  // construction time, so this affects pickers created AFTER the call (all NIMBUS
  // pickers are lazily built on first open). Safe no-op if Flatpickr isn't loaded.
  _applyFirstDayOfWeek() {
    try {
      let fdow = Store.pref('firstDayOfWeek');
      fdow = Number(fdow);
      if (fdow !== 0 && fdow !== 1) fdow = 0;
      if (typeof flatpickr !== 'undefined' && flatpickr.l10ns && flatpickr.l10ns.default) {
        flatpickr.l10ns.default.firstDayOfWeek = fdow;
      }
    } catch {}
  },

  // Navigate to the user's saved default landing view (pref('landingView') =
  // { tab, sub }), falling back to the Dashboard. Called once on boot after the
  // first task payload arrives. Guards the admin tab against non-admins and only
  // applies a sub-view for tabs that have one.
  _gotoLanding() {
    let lv = null;
    try { lv = Store.pref('landingView'); } catch {}
    const validTabs = ['home', 'gantt', 'masterdata', 'labor', 'admin'];
    let tab = (lv && validTabs.includes(lv.tab)) ? lv.tab : 'home';
    if (tab === 'admin' && !Session.isAdmin()) tab = 'home';
    App.goto(tab);
    const sub = lv && lv.sub;
    if (sub) {
      try {
        if (tab === 'gantt')           App.gotoGanttSub(sub);
        else if (tab === 'masterdata') App.gotoMasterSub(sub);
        else if (tab === 'labor')      App.gotoLaborSub(sub);
      } catch {}
    }
  },

  gotoLaborSub(sub) {
    const valid = ['aggregate','line-plan','capacity','exceptions','inputs'];
    if (!valid.includes(sub)) return;
    App._laborSub = sub;
    document.querySelectorAll('.labor-toolbar .seg-btn[data-labor-sub]').forEach(b => {
      b.classList.toggle('active', b.dataset.laborSub === sub);
    });
    valid.forEach(s => {
      const el = document.getElementById(`labor-sub-${s}`);
      if (el) el.style.display = s === sub ? 'flex' : 'none';
    });
    if (App._currentTab === 'labor') {
      const plant = Store.selectedPlant;
      if (plant) setTimeout(() => LaborPlanning.render(), 30);
    }
  },

  gotoMasterSub(sub) {
    if (!['lines', 'plant'].includes(sub)) return;
    // Collapse line accordions when switching away from the lines sub-tab
    if (App._currentMasterSub === 'lines' && sub !== 'lines') {
      document.querySelectorAll('details.line-accordion[open]').forEach(d => d.removeAttribute('open'));
    }
    App._currentMasterSub = sub;
    document.querySelectorAll('.md-master-subtabs .admin-subtab').forEach(b => {
      b.classList.toggle('active', b.dataset.mdMaster === sub);
    });
    const linesPane = document.getElementById('md-master-lines-pane');
    const plantPane = document.getElementById('md-master-plant-pane');
    if (linesPane) linesPane.hidden = (sub !== 'lines');
    if (plantPane) {
      if (sub === 'plant') { plantPane.style.display = 'flex'; plantPane.removeAttribute('hidden'); }
      else { plantPane.style.display = ''; plantPane.setAttribute('hidden', ''); }
    }
    // Only trigger render when the masterdata tab is currently visible
    if (App._currentTab === 'masterdata') {
      setTimeout(() => {
        if (sub === 'plant') Plant.render();
        else ProdLines.render();
      }, 30);
    }
  },

  toggleSide(which) {
    const el = document.getElementById(which === 'left' ? 'left-sidebar' : 'right-sidebar');
    if (el) {
      el.classList.toggle('collapsed');
      if (which === 'left') {
        const btn = el.querySelector('.side-head .icon-btn');
        if (btn) btn.textContent = el.classList.contains('collapsed') ? '▶' : '◀';
      }
    }
    setTimeout(() => { Timeline.redraw(); TimelineNav.render(); }, Config.ANIM_MS);
  },

  _wireResize(side, el) {
    const handle = el.querySelector('.resize-handle');
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
