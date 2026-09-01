// security/security-admin.mjs — user accounts and role-based plant
// assignment admin sub-tab. Extracted verbatim from
// plant-and-administration.mts (Phase P2 of
// docs/architecture/domain-refactor-plan.md, which split that
// 11,308-line mega-module into 9 domain files) — two non-contiguous
// source ranges combined into this one file (Security's own private
// backend-response-shape interfaces were textually positioned just
// ahead of SystemConfig's comment block in the original file, not
// Security's — moved here with the code that actually uses them).
import { Config, Util, ErrorLog, Toast, Modal } from '../platform/foundation.mjs';
import { Store } from '../schedule-state.mjs';
import { Session } from '../schedule-data.mjs';
import type { TopLevelTab } from '../platform/types.mjs';

/** One `GET /security/users` row (`auth.list_users`) — username, role, and
 *  whether a password is set; NEVER carries the hash itself. Not part of the
 *  backend's `response_model=` scope (only the task-date-update endpoint
 *  family is), so hand-written locally, matching Interface's precedent. */
interface SecurityUser {
  username: string;
  role: string | null;
  has_password: boolean;
  first_name?: string | null;
  last_name?: string | null;
  // ISO timestamp string (or null = never logged in since this column
  // existed) from auth.list_users; server-side audit only, unrelated to the
  // frontend's own 12h local session-cache expiry.
  last_login?: string | null;
}

interface SecurityUsersResponse {
  users: SecurityUser[];
  meta?: { total: number };
}

/** A row staged client-side via "Paste rows" (`_pasteUsers`), not yet POSTed
 *  to `/security/users/bulk` — distinct from `SecurityUser` (no
 *  `has_password`; that only exists once the backend has a real row). All
 *  four fields are genuinely guaranteed present here because `_pasteUsers`
 *  always normalizes a `SecurityPastedRow` (below) through `|| ''` before
 *  pushing onto `_staged` — this interface describes that post-normalization
 *  invariant, not the raw parse output. */
interface SecurityStagedUser {
  username: string;
  role: string;
  first_name: string;
  last_name: string;
}

/** The RAW shape of one `_parseUserPaste` row, before `_pasteUsers`
 *  normalizes it into a `SecurityStagedUser` — built dynamically from
 *  whatever header columns actually appeared in the pasted clipboard text
 *  (`headers.forEach((h, i) => { row[h] = ...; })`), so only the fields
 *  matching a detected header column exist. `username` is intentionally
 *  optional here too (a plain `Record<string, string>`'s index signature
 *  cannot prove any specific key is present) — `_parseUserPaste`'s trailing
 *  `.filter((r): r is SecurityPastedRow & { username: string } => ...)` is
 *  what actually narrows it to guaranteed-present before returning. */
interface SecurityPastedRow {
  username?: string;
  role?: string;
  first_name?: string;
  last_name?: string;
}

/** `POST /security/users/bulk` payload (`auth.bulk_upsert_users`) — role-only
 *  upserts never send passwords (`set_user_password` owns those separately). */
interface SecurityUserUpsert {
  username: string;
  role?: string | null;
  first_name?: string;
  last_name?: string;
}

/** Shared bulk-write result shape — `auth.bulk_upsert_users` and
 *  `master_data.bulk_apply` (used generically here for `roles`/`role_plants`,
 *  per the correction that those two tables belong to Security's domain, not
 *  MasterData's — kept as Security's own local type rather than reused from
 *  MasterData's `MasterDataBulkResult`, same self-contained spirit as the
 *  module's own `_esc`/`_writeHeaders` copies). */
interface SecurityBulkResult {
  inserted: number;
  updated: number;
  deleted: number;
}

/** One `roles` table row (`GET /master-data/roles`, generic master_data.py
 *  read path — `roles`/`role_plants` are registered in `ALLOWED_TABLES` but
 *  belong to Security's domain, not MasterData's UI). */
interface SecurityRoleRow {
  role: string;
  description?: string | null;
  /** roles.settings.pages — per-role top-level page-access toggles, attached
   *  by master_data.py's list_rows() for the 'roles' table only (not a real
   *  registered column_metadata column, so it never shows in a plain grid). */
  pages?: Partial<Record<TopLevelTab, boolean>> | null;
}

/** One `role_plants` table row (`GET /master-data/role_plants`). */
interface SecurityRolePlantRow {
  role: string;
  plant: string;
}

/** Generic `GET /master-data/{table}` envelope, narrowed to the two rows
 *  shapes Security reads (`roles`, `role_plants`) — mirrors
 *  `MasterDataResponse` structurally but kept local/self-contained. */
interface SecurityMasterDataResponse<T> {
  rows: T[];
  meta?: { total: number };
}

/* =============================================================================
   SECURITY — admin sub-tab: user accounts (username / role / password) and
   role-based plant assignment (roles + role_plants). Same self-contained,
   paint-into-one-host-div idiom as Interface: private state, a public
   render() entry point, an internal 'users' | 'roles' tab, full re-render on
   every tab switch and on every write (mirrors Interface's _saveConfig: try
   the write, Toast+log on failure, then unconditionally reload+repaint from
   the server either way). Backend: /security/users(+/bulk, +/{username}/
   reset-password) for accounts (auth.py); the generic /master-data/roles
   and /master-data/role_plants (+/bulk) for roles and their plant scoping
   (master_data.py) — this module only renders and posts, never touches
   password hashes beyond the single write they're submitted in.
   ========================================================================== */
export const Security = (() => {
  const API = Config.API_BASE;

  let _tab: 'users' | 'roles' = 'users'; // active top-level tab

  // ---- Users tab state ----
  let _users: SecurityUser[] = [];        // last GET /security/users .users: [{username,role,has_password}]
  let _usersSearch = '';           // current server-side search query
  let _roleOptions: string[] = [];        // role names for the Role <select> (from GET /master-data/roles)
  let _staged: SecurityStagedUser[] = []; // rows staged via "Paste rows", not yet saved: [{username, role}]
  const _pwOpen: Set<string> = new Set();       // usernames with an open inline password-reveal row
  const _nameSaveTimers: Map<string, ReturnType<typeof setTimeout>> = new Map(); // username -> pending debounce timeout id

  // ---- Roles tab state ----
  let _roles: SecurityRoleRow[] = [];         // GET /master-data/roles rows: [{role, description}]
  let _rolePlants: SecurityRolePlantRow[] = []; // GET /master-data/role_plants rows: [{role, plant}]
  let _rolesInUse: Set<string> = new Set();     // role names currently assigned to >=1 user (best-effort; disables delete)
  let _selectedRole: string | null = null;

  const _esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c: string) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

  function _writeHeaders(json = true): Record<string, string> {
    const h: Record<string, string> = { 'x-user-email': Session.actor() };
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  function _postJSON(url: string, body: unknown): Promise<unknown> {
    return fetch(url, { method: 'POST', headers: _writeHeaders(), body: JSON.stringify(body) })
      .then((r) => {
        if (!r.ok) {
          // A 403 here means the backend admin gate rejected us though the UI
          // believed we were admin (stale cached role). Reconcile + prompt
          // re-auth instead of only bubbling a raw error to the caller.
          if (r.status === 403) { try { Session.onAuthDenied(); } catch {} }
          return r.json().catch(() => ({})).then((e) => {
            const err: Error & { status?: number } = new Error(e.detail || `HTTP ${r.status}`);
            err.status = r.status;
            throw err;
          });
        }
        return r.json();
      });
  }

  const _debouncedUserSearch = Util.debounce(() => _reloadUsers(), 300);

  // -----------------------------------------------------------------------
  // Public entry point
  // -----------------------------------------------------------------------
  async function render(): Promise<void> {
    const host = document.getElementById('security-host');
    if (!host) return;
    _paintShell();
    await _loadActiveTab();
  }

  function _paintShell(): void {
    const host = document.getElementById('security-host');
    if (!host) return;
    const tabBtn = (id: string, label: string) => `<button class="sap-tab${_tab === id ? ' sap-tab-active' : ''}" data-tab="${id}">${_esc(label)}</button>`;
    host.innerHTML = `
      <div class="sap-pagehead">
        <div><div class="sap-pagehead-title"><h2>${_esc(Util.t('tab.security'))}</h2></div></div>
      </div>
      <div class="sap-tabs">${tabBtn('users', Util.t('tab.security_users'))}${tabBtn('roles', Util.t('tab.security_roles'))}</div>
      <div id="security-tabbody"><div class="md-loading">${_esc(Util.t('ui.loading'))}</div></div>`;
    host.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => { _tab = b.dataset.tab as 'users' | 'roles'; _paintShell(); _loadActiveTab(); }));
  }

  function _loadActiveTab(): Promise<void> {
    return _tab === 'users' ? _reloadUsers() : _reloadRoles();
  }

  // -----------------------------------------------------------------------
  // USERS tab
  // -----------------------------------------------------------------------
  async function _reloadUsers(): Promise<void> {
    const body = document.getElementById('security-tabbody');
    try {
      const q = _usersSearch.trim();
      const usersUrl = `${API}/security/users` + (q ? `?search=${encodeURIComponent(q)}` : '');
      const [usersData, rolesData]: [SecurityUsersResponse, SecurityMasterDataResponse<SecurityRoleRow>] = await Promise.all([
        Util.fetchTraced(usersUrl).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
        Util.fetchTraced(`${API}/master-data/roles`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
      ]);
      _users = usersData.users || [];
      _roleOptions = [...new Set((rolesData.rows || []).map((r) => r.role).filter(Boolean))].sort();
      if (_tab !== 'users') return; // bail if the admin switched tabs while awaiting
      _renderUsersTab();
    } catch (e) {
      const is403 = (e as Error & { status?: number }).status === 403 || /\b403\b/.test((e as Error).message || '');
      // Stale-admin 403 (the /master-data/roles half of the Promise.all is
      // ungated, so a 403 here is from /security/users): reconcile + re-auth.
      if (is403) { try { Session.onAuthDenied(); } catch {} }
      if (body) body.innerHTML = `<div class="md-empty">${_esc(is403 ? Util.t('sec.access_revoked') : Util.t('sec.load_users_failed', { msg: (e as Error).message }))}</div>`;
      ErrorLog.error('security', `Load users failed: ${(e as Error).message}`);
    }
  }

  function _renderUsersTab(): void {
    const body = document.getElementById('security-tabbody');
    if (!body) return;
    // Preserve the search box's focus/caret across the re-render a debounced
    // keystroke-driven reload causes (captured synchronously, not via
    // focus/blur listeners, since replacing innerHTML can race those).
    const hadFocus = document.activeElement && document.activeElement.id === 'sec-user-search';
    const caret = hadFocus ? (document.activeElement as HTMLInputElement).selectionStart : null;
    body.innerHTML = _usersShellHtml();
    _wireUsersShell();
    _renderUsersRows();
    _renderUsersActions();
    if (hadFocus) {
      const search = document.getElementById('sec-user-search') as HTMLInputElement | null;
      if (search) {
        search.focus();
        const pos = caret ?? search.value.length;
        search.setSelectionRange(pos, pos);
      }
    }
  }

  function _usersShellHtml(): string {
    return `
      <div class="panel">
        <div class="md-toolbar">
          <input type="search" class="input md-search" id="sec-user-search" placeholder="${_esc(Util.t('sec.search_users_ph'))}" value="${_esc(_usersSearch)}">
          <span class="spacer"></span>
          <button class="btn btn-ghost sm" id="sec-paste-users" title="${_esc(Util.t('tip.paste_rows'))}">${_esc(Util.t('btn.paste_rows'))}</button>
          <span id="sec-users-actions" style="display:inline-flex;gap:8px;align-items:center"></span>
        </div>
        <div style="display:flex;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);align-items:center;flex-wrap:wrap">
          <input type="text" class="input" id="sec-new-username" placeholder="${_esc(Util.t('sec.username_ph'))}" style="flex:1;min-width:120px">
          <input type="text" class="input" id="sec-new-firstname" placeholder="${_esc(Util.t('sec.first_name_ph'))}" maxlength="100" style="flex:1;min-width:100px">
          <input type="text" class="input" id="sec-new-lastname" placeholder="${_esc(Util.t('sec.last_name_ph'))}" maxlength="100" style="flex:1;min-width:100px">
          ${_roleSelectHtml('', 'id="sec-new-role-select"')}
          <input type="password" class="input" id="sec-new-password" placeholder="${_esc(Util.t('sec.new_password_ph'))}" autocomplete="new-password" style="flex:1;min-width:120px">
          <button class="btn btn-primary sm" id="sec-add-user-btn">${_esc(Util.t('sec.add_user'))}</button>
        </div>
        <div class="md-table-wrap">
          <table class="md-table">
            <thead><tr>
              <th class="md-th">${_esc(Util.t('sec.username'))}</th>
              <th class="md-th">${_esc(Util.t('sec.first_name'))}</th>
              <th class="md-th">${_esc(Util.t('sec.last_name'))}</th>
              <th class="md-th">${_esc(Util.t('sec.role'))}</th>
              <th class="md-th">${_esc(Util.t('sec.password'))}</th>
              <th class="md-th">${_esc(Util.t('sec.last_login'))}</th>
              <th class="md-th"></th>
            </tr></thead>
            <tbody id="sec-users-tbody"></tbody>
          </table>
        </div>
      </div>`;
  }

  function _wireUsersShell(): void {
    const search = document.getElementById('sec-user-search') as HTMLInputElement | null;
    if (search) {
      search.addEventListener('input', () => { _usersSearch = search.value; _debouncedUserSearch(); });
    }
    document.getElementById('sec-paste-users')?.addEventListener('click', _pasteUsers);
    document.getElementById('sec-add-user-btn')?.addEventListener('click', _addUser);
  }

  function _renderUsersActions(): void {
    const el = document.getElementById('sec-users-actions');
    if (!el) return;
    el.innerHTML = _staged.length
      ? `<span class="md-dirty-badge">${_esc(Util.t('ui.unsaved_badge', { count: _staged.length }))}</span>
         <button class="btn btn-primary sm" id="sec-save-staged">${_esc(Util.t('sec.save_changes'))}</button>`
      : '';
    document.getElementById('sec-save-staged')?.addEventListener('click', _saveStaged);
  }

  // extraAttrs is a caller-built, already-escaped attribute string (id="..." or data-x="...").
  function _roleSelectHtml(value: string, extraAttrs: string): string {
    const opts = [`<option value=""${!value ? ' selected' : ''}>${_esc(Util.t('ui.select_placeholder'))}</option>`]
      .concat(_roleOptions.map((r) => `<option value="${_esc(r)}"${r === value ? ' selected' : ''}>${_esc(r)}</option>`))
      .join('');
    return `<select class="input" ${extraAttrs}>${opts}</select>`;
  }

  function _userRowHtml(u: SecurityUser): string {
    const pwOpen = _pwOpen.has(u.username);
    const pwCell = pwOpen
      ? `<div style="display:flex;gap:6px;align-items:center">
           <input type="password" class="input" data-pw-input="${_esc(u.username)}" placeholder="${_esc(Util.t('sec.new_password_ph'))}" autocomplete="new-password" style="width:140px">
           <button class="btn btn-primary sm" data-pw-save="${_esc(u.username)}">${_esc(Util.t('sec.save_password'))}</button>
           <button class="btn btn-ghost sm" data-pw-cancel="${_esc(u.username)}">${_esc(Util.t('btn.cancel'))}</button>
         </div>`
      : `<div style="display:flex;gap:8px;align-items:center">
           <span class="admin-health-dot ${u.has_password ? 'ok' : 'warn'}"></span>
           <span>${_esc(u.has_password ? Util.t('sec.password_set') : Util.t('sec.password_not_set'))}</span>
           <button class="btn btn-ghost sm" data-pw-toggle="${_esc(u.username)}">${_esc(u.has_password ? Util.t('sec.reset_password') : Util.t('sec.set_password'))}</button>
         </div>`;
    return `<tr data-username="${_esc(u.username)}">
      <td class="md-td">${_esc(u.username)}</td>
      <td class="md-td"><input type="text" class="input" data-first-name-user="${_esc(u.username)}" value="${_esc(u.first_name || '')}" maxlength="100"></td>
      <td class="md-td"><input type="text" class="input" data-last-name-user="${_esc(u.username)}" value="${_esc(u.last_name || '')}" maxlength="100"></td>
      <td class="md-td">${_roleSelectHtml(u.role || '', `data-role-select-user="${_esc(u.username)}"`)}</td>
      <td class="md-td">${pwCell}</td>
      <td class="md-td">${_esc(u.last_login ? new Date(u.last_login).toLocaleString() : Util.t('sec.never'))}</td>
      <td class="md-td md-td-action"><button class="icon-btn md-del-btn" data-del-user="${_esc(u.username)}" title="${_esc(Util.t('tip.delete_row'))}">🗑</button></td>
    </tr>`;
  }

  function _stagedRowHtml(r: SecurityStagedUser, i: number): string {
    return `<tr class="md-row-new">
      <td class="md-td">${_esc(r.username)}</td>
      <td class="md-td"><input type="text" class="input" data-first-name-staged="${i}" value="${_esc(r.first_name || '')}" maxlength="100"></td>
      <td class="md-td"><input type="text" class="input" data-last-name-staged="${i}" value="${_esc(r.last_name || '')}" maxlength="100"></td>
      <td class="md-td">${_roleSelectHtml(r.role, `data-role-select-staged="${i}"`)}</td>
      <td class="md-td">${_esc(Util.t('sec.password_not_set'))}</td>
      <td class="md-td">—</td>
      <td class="md-td md-td-action"><button class="icon-btn md-del-btn" data-del-staged="${i}" title="${_esc(Util.t('tip.delete_row'))}">🗑</button></td>
    </tr>`;
  }

  function _renderUsersRows(): void {
    const tbody = document.getElementById('sec-users-tbody');
    if (!tbody) return;
    if (!_users.length && !_staged.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="md-empty">${_esc(Util.t('sec.no_users_yet'))}</td></tr>`;
    } else {
      tbody.innerHTML = _users.map(_userRowHtml).join('') + _staged.map(_stagedRowHtml).join('');
    }
    tbody.querySelectorAll<HTMLSelectElement>('[data-role-select-user]').forEach((sel) =>
      sel.addEventListener('change', () => _setUserRole(sel.dataset.roleSelectUser as string, sel.value)));
    tbody.querySelectorAll<HTMLSelectElement>('[data-role-select-staged]').forEach((sel) =>
      sel.addEventListener('change', () => { _staged[Number(sel.dataset.roleSelectStaged)].role = sel.value; }));
    tbody.querySelectorAll<HTMLInputElement>('[data-first-name-user]').forEach((inp) =>
      inp.addEventListener('blur', () => _scheduleSetUserName(inp.dataset.firstNameUser as string)));
    tbody.querySelectorAll<HTMLInputElement>('[data-last-name-user]').forEach((inp) =>
      inp.addEventListener('blur', () => _scheduleSetUserName(inp.dataset.lastNameUser as string)));
    tbody.querySelectorAll<HTMLInputElement>('[data-first-name-staged]').forEach((inp) =>
      inp.addEventListener('blur', () => { _staged[Number(inp.dataset.firstNameStaged)].first_name = inp.value; }));
    tbody.querySelectorAll<HTMLInputElement>('[data-last-name-staged]').forEach((inp) =>
      inp.addEventListener('blur', () => { _staged[Number(inp.dataset.lastNameStaged)].last_name = inp.value; }));
    tbody.querySelectorAll<HTMLElement>('[data-pw-toggle]').forEach((b) =>
      b.addEventListener('click', () => { _pwOpen.add(b.dataset.pwToggle as string); _renderUsersRows(); }));
    tbody.querySelectorAll<HTMLElement>('[data-pw-cancel]').forEach((b) =>
      b.addEventListener('click', () => { _pwOpen.delete(b.dataset.pwCancel as string); _renderUsersRows(); }));
    tbody.querySelectorAll<HTMLElement>('[data-pw-save]').forEach((b) =>
      b.addEventListener('click', () => _savePassword(b.dataset.pwSave as string)));
    tbody.querySelectorAll<HTMLElement>('[data-del-user]').forEach((b) =>
      b.addEventListener('click', () => _deleteUser(b.dataset.delUser as string)));
    tbody.querySelectorAll<HTMLElement>('[data-del-staged]').forEach((b) =>
      b.addEventListener('click', () => { _staged.splice(Number(b.dataset.delStaged), 1); _renderUsersRows(); _renderUsersActions(); }));
  }

  async function _setUserRole(username: string, role: string): Promise<void> {
    try {
      await _postJSON(`${API}/security/users/bulk`, { upserts: [{ username, role: role || null }] });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Set role failed for ${username}: ${(e as Error).message}`);
    }
    await _reloadUsers();
  }

  // Debounced by username so tabbing from First Name straight into Last Name
  // in the same row coalesces into one save (reading both fields' live
  // values) instead of firing mid-edit and losing the second field's
  // keystrokes to the unconditional reload/re-render below.
  function _scheduleSetUserName(username: string): void {
    clearTimeout(_nameSaveTimers.get(username));
    _nameSaveTimers.set(username, setTimeout(() => {
      _nameSaveTimers.delete(username);
      _setUserName(username);
    }, 200));
  }

  async function _setUserName(username: string): Promise<void> {
    const row = document.querySelector(`tr[data-username="${CSS.escape(username)}"]`);
    if (!row) return;
    const roleSelect = row.querySelector('[data-role-select-user]') as HTMLSelectElement | null;
    const firstInput = row.querySelector('[data-first-name-user]') as HTMLInputElement | null;
    const lastInput = row.querySelector('[data-last-name-user]') as HTMLInputElement | null;
    try {
      await _postJSON(`${API}/security/users/bulk`, {
        upserts: [{
          username,
          role: roleSelect ? (roleSelect.value || null) : null,
          first_name: firstInput ? firstInput.value.trim() : '',
          last_name: lastInput ? lastInput.value.trim() : '',
        }],
      });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Set name failed for ${username}: ${(e as Error).message}`);
    }
    await _reloadUsers();
  }

  async function _savePassword(username: string): Promise<void> {
    const input = document.querySelector(`[data-pw-input="${CSS.escape(username)}"]`) as HTMLInputElement | null;
    const pw = input ? input.value : '';
    if (!pw || pw.length < 4) { Toast.show(Util.t('sec.password_too_short'), 'error'); return; }
    try {
      await _postJSON(`${API}/security/users/${encodeURIComponent(username)}/reset-password`, { password: pw });
      _pwOpen.delete(username);
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Set password failed for ${username}: ${(e as Error).message}`);
    }
    await _reloadUsers();
  }

  async function _deleteUser(username: string): Promise<void> {
    const ok = await Modal.confirm({
      title: Util.t('sec.confirm_delete_user_title'),
      message: Util.t('sec.confirm_delete_user_msg', { username }),
      confirmLabel: Util.t('btn.yes_delete'),
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await _postJSON(`${API}/security/users/bulk`, { deletes: [{ username }] });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Delete user failed for ${username}: ${(e as Error).message}`);
    }
    await _reloadUsers();
  }

  async function _addUser(): Promise<void> {
    const uInput = document.getElementById('sec-new-username') as HTMLInputElement | null;
    const fInput = document.getElementById('sec-new-firstname') as HTMLInputElement | null;
    const lInput = document.getElementById('sec-new-lastname') as HTMLInputElement | null;
    const rSelect = document.getElementById('sec-new-role-select') as HTMLSelectElement | null;
    const pInput = document.getElementById('sec-new-password') as HTMLInputElement | null;
    const username = (uInput?.value || '').trim();
    if (!username) { Toast.show(Util.t('sec.username_required'), 'error'); return; }
    const password = pInput?.value || '';
    if (password && password.length < 4) { Toast.show(Util.t('sec.password_too_short'), 'error'); return; }
    const role = rSelect?.value || null;
    const first_name = (fInput?.value || '').trim();
    const last_name = (lInput?.value || '').trim();
    try {
      await _postJSON(`${API}/security/users/bulk`, { upserts: [{ username, role, first_name, last_name }] });
      if (password) await _postJSON(`${API}/security/users/${encodeURIComponent(username)}/reset-password`, { password });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Add user failed: ${(e as Error).message}`);
    }
    await _reloadUsers();
  }

  // Mirrors MasterData._parsePaste's header-detection idiom, scoped to a fixed
  // username/role 2-column shape (no password column — passwords are never pasted).
  function _parseUserPaste(rawText: string): (SecurityPastedRow & { username: string })[] {
    const lines = rawText.replace(/\r/g, '').split('\n').filter((l) => l.trim());
    if (!lines.length) return [];
    const first = lines[0].split('\t').map((h) => h.trim().toLowerCase());
    const nameHdrs = ['username', Util.t('sec.username').toLowerCase()];
    const roleHdrs = ['role', Util.t('sec.role').toLowerCase()];
    const firstNameHdrs = ['first name', 'firstname', Util.t('sec.first_name').toLowerCase()];
    const lastNameHdrs = ['last name', 'lastname', Util.t('sec.last_name').toLowerCase()];
    const hasHeader = first.some((h) =>
      nameHdrs.includes(h) || roleHdrs.includes(h) || firstNameHdrs.includes(h) || lastNameHdrs.includes(h));
    let headers: string[], dataLines: string[];
    if (hasHeader) {
      headers = first.map((h) => {
        if (nameHdrs.includes(h)) return 'username';
        if (roleHdrs.includes(h)) return 'role';
        if (firstNameHdrs.includes(h)) return 'first_name';
        if (lastNameHdrs.includes(h)) return 'last_name';
        return h;
      });
      dataLines = lines.slice(1);
    } else {
      headers = ['username', 'role'];
      dataLines = lines;
    }
    return dataLines.map((line) => {
      const vals = line.split('\t');
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = (vals[i] ?? '').trim(); });
      return row as SecurityPastedRow;
      // Single cast (not the prior `as unknown as`): every field on
      // SecurityPastedRow is optional, so a plain Record<string,string>'s
      // index signature genuinely does overlap it — no bridge through
      // `unknown` needed. `username`'s presence is proven below, not here.
    }).filter((r): r is SecurityPastedRow & { username: string } => Boolean(r.username));
  }

  async function _pasteUsers(): Promise<void> {
    let raw: string;
    try { raw = await navigator.clipboard.readText(); }
    catch { Toast.show(Util.t('toast.clipboard_denied'), 'error'); return; }
    if (!raw.trim()) { Toast.show(Util.t('toast.clipboard_empty'), 'error'); return; }
    const rows = _parseUserPaste(raw);
    if (!rows.length) { Toast.show(Util.t('toast.no_rows_paste'), 'error'); return; }
    rows.forEach((r) => _staged.push({
      username: r.username, role: r.role || '',
      first_name: r.first_name || '', last_name: r.last_name || '',
    }));
    _renderUsersRows();
    _renderUsersActions();
  }

  async function _saveStaged(): Promise<void> {
    if (!_staged.length) return;
    const upserts: SecurityUserUpsert[] = _staged.map((r) => ({
      username: r.username, role: r.role || null,
      first_name: r.first_name || '', last_name: r.last_name || '',
    }));
    try {
      await _postJSON(`${API}/security/users/bulk`, { upserts });
      _staged = [];
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Save staged users failed: ${(e as Error).message}`);
    }
    await _reloadUsers();
  }

  // -----------------------------------------------------------------------
  // ROLES tab — master-detail: role list (left) + its plant assignments (right)
  // -----------------------------------------------------------------------
  async function _reloadRoles(): Promise<void> {
    const body = document.getElementById('security-tabbody');
    try {
      const [rolesData, rpData]: [SecurityMasterDataResponse<SecurityRoleRow>, SecurityMasterDataResponse<SecurityRolePlantRow>] = await Promise.all([
        Util.fetchTraced(`${API}/master-data/roles`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
        Util.fetchTraced(`${API}/master-data/role_plants`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
      ]);
      _roles = rolesData.rows || [];
      _rolePlants = rpData.rows || [];
      if (_selectedRole && !_roles.some((r) => r.role === _selectedRole)) _selectedRole = null;
      // Best-effort: knowing which roles have >=1 user lets the delete button be
      // disabled pre-emptively. Non-fatal if this fetch fails — bulk_apply's FK
      // hardening (ForeignKeyViolation -> clean 400) remains the authoritative guard.
      try {
        const usersData: SecurityUsersResponse = await Util.fetchTraced(`${API}/security/users`).then((r) => { if (!r.ok) throw new Error(); return r.json(); });
        _rolesInUse = new Set((usersData.users || []).map((u) => u.role).filter((r): r is string => Boolean(r)));
      } catch { _rolesInUse = new Set(); }
      if (_tab !== 'roles') return; // bail if the admin switched tabs while awaiting
      _renderRolesTab();
    } catch (e) {
      if (body) body.innerHTML = `<div class="md-empty">Failed to load roles: ${_esc((e as Error).message)}</div>`;
      ErrorLog.error('security', `Load roles failed: ${(e as Error).message}`);
    }
  }

  function _renderRolesTab(): void {
    const body = document.getElementById('security-tabbody');
    if (!body) return;
    body.innerHTML = `<div class="sap-console"><div id="sec-roles-rail"></div><div id="sec-roles-detail"></div></div>`;
    _renderRolesRail();
    _renderRolesDetail();
  }

  function _roleRowHtml(r: SecurityRoleRow): string {
    const sel = r.role === _selectedRole ? ' sap-rail-row-sel' : '';
    const inUse = _rolesInUse.has(r.role);
    const delAttrs = inUse
      ? `disabled title="${_esc(Util.t('sec.role_in_use'))}"`
      : `title="${_esc(Util.t('tip.delete_row'))}"`;
    return `<div class="sap-rail-row${sel}" style="display:flex;align-items:center;gap:8px" data-role="${_esc(r.role)}">
      <div style="flex:1;min-width:0">
        <div class="sap-rail-name" style="cursor:pointer" data-role-select="${_esc(r.role)}">${_esc(r.role)}</div>
        <input type="text" class="input" data-role-desc="${_esc(r.role)}" value="${_esc(r.description || '')}"
          title="${_esc(Util.t('sec.description'))}" placeholder="${_esc(Util.t('sec.description_ph'))}"
          style="margin-top:4px;width:100%;font-size:11.5px;padding:3px 6px">
      </div>
      <button class="btn btn-ghost sm" data-role-desc-save="${_esc(r.role)}">${_esc(Util.t('btn.save'))}</button>
      <button class="sap-icon-btn danger" data-role-del="${_esc(r.role)}" ${delAttrs}>🗑</button>
    </div>`;
  }

  function _renderRolesRail(): void {
    const el = document.getElementById('sec-roles-rail');
    if (!el) return;
    const rows = !_roles.length
      ? `<div class="md-empty">${_esc(Util.t('sec.no_roles_yet'))}</div>`
      : _roles.map(_roleRowHtml).join('');
    el.innerHTML = `<div class="panel">
      <div class="panel-head"><span class="sap-section-label">${_esc(Util.t('tab.security_roles'))}</span></div>
      <div style="display:flex;gap:8px;padding:12px;border-bottom:1px solid var(--line);flex-wrap:wrap">
        <input type="text" class="input" id="sec-new-role" placeholder="${_esc(Util.t('sec.role'))}" style="flex:1;min-width:90px">
        <input type="text" class="input" id="sec-new-role-desc" placeholder="${_esc(Util.t('sec.description_ph'))}" style="flex:1.6;min-width:110px">
        <button class="btn btn-primary sm" id="sec-add-role-btn">${_esc(Util.t('sec.add_role'))}</button>
      </div>
      <div class="sap-rail" id="sec-roles-list">${rows}</div>
    </div>`;
    document.getElementById('sec-add-role-btn')?.addEventListener('click', _addRole);
    el.querySelectorAll<HTMLElement>('[data-role-select]').forEach((nameEl) =>
      nameEl.addEventListener('click', () => _selectRole(nameEl.dataset.roleSelect as string)));
    el.querySelectorAll<HTMLElement>('[data-role-desc-save]').forEach((b) =>
      b.addEventListener('click', () => _saveRoleDescription(b.dataset.roleDescSave as string)));
    el.querySelectorAll<HTMLElement>('[data-role-del]').forEach((b) =>
      b.addEventListener('click', () => _deleteRole(b.dataset.roleDel as string)));
  }

  function _selectRole(role: string): void {
    _selectedRole = role;
    // Local-only: toggle the selected highlight instead of rebuilding the rail,
    // so an in-progress "add role" draft elsewhere in the rail isn't wiped.
    document.querySelectorAll<HTMLElement>('#sec-roles-list .sap-rail-row').forEach((el) =>
      el.classList.toggle('sap-rail-row-sel', el.dataset.role === role));
    _renderRolesDetail();
  }

  // Nav order + labels for the Page Access toggles — mirrors App._firstAccessibleTab's
  // order (application-shell.mts) and Session.DEFAULT_PAGE_ACCESS's key set
  // (schedule-data.mts); keep all three, plus master_data.py's PAGE_ACCESS_KEYS, in sync.
  function _pageAccessDefs(): Array<[TopLevelTab, string]> {
    return [
      ['home',       Util.t('tab.home')],
      ['gantt',      Util.t('tab.gantt')],
      ['labor',      Util.t('us.tab_labor')],
      ['masterdata', Util.t('tab.masterdata')],
      ['admin',      Util.t('tab.admin')],
    ];
  }

  // Default when a role hasn't customized a given page yet: everything on
  // except Admin Cockpit — except for the 'admin' role itself, which defaults
  // to Admin Cockpit on too (Session.canAccessTab never even reaches this
  // default for real admin users, since it short-circuits on isAdmin(), but
  // the Roles tab shows explicit per-role state so 'admin' needs it directly).
  function _defaultPageAccess(role: string): Record<TopLevelTab, boolean> {
    return { home: true, gantt: true, labor: true, masterdata: true, admin: role === 'admin' };
  }

  function _pageAccessRowHtml(role: string, tab: TopLevelTab, label: string, roleRow: SecurityRoleRow | undefined): string {
    const defaults = _defaultPageAccess(role);
    const checked = roleRow?.pages?.[tab] ?? defaults[tab];
    const locked = role === 'admin' && tab === 'admin';
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
      <span style="font-size:13px">${_esc(label)}</span>
      <label class="cal-day-toggle-wrap" style="${locked ? 'cursor:default' : ''}"
          title="${locked ? _esc(Util.t('sec.admin_page_locked')) : ''}">
        <input type="checkbox" data-page-toggle="${_esc(tab)}" ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''}>
        <span class="cal-toggle-track"></span><span class="cal-toggle-thumb"></span>
      </label>
    </div>`;
  }

  function _renderRolesDetail(): void {
    const el = document.getElementById('sec-roles-detail');
    if (!el) return;
    const role = _selectedRole;
    const roleRow = role ? _roles.find((r) => r.role === role) : undefined;
    const header = role ? Util.t('sec.plants_for_role', { role }) : Util.t('sec.no_role_selected');
    const plants = role ? _rolePlants.filter((rp) => rp.role === role).map((rp) => rp.plant).sort() : [];
    const addHtml = !role ? '' : `
      <div class="sap-section-label">${_esc(Util.t('sec.add_plant'))}</div>
      <div class="hps-combobox" id="sec-plant-combobox" style="max-width:280px">
        <input type="text" class="input" id="sec-plant-search" placeholder="${_esc(Util.t('sec.search_plants_ph'))}" autocomplete="off">
        <div class="hps-dropdown" id="sec-plant-dropdown" hidden></div>
      </div>`;
    const listHtml = !role ? '' : !plants.length
      ? `<div class="sap-help" style="margin-top:12px">${_esc(Util.t('sec.no_plants_yet'))}</div>`
      : `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:12px">${plants.map((p) =>
          `<span class="sap-keychip">${_esc(p)}<button data-remove-plant="${_esc(p)}" title="${_esc(Util.t('tip.delete_row'))}"
             style="border:none;background:transparent;cursor:pointer;color:var(--fg-mute);font-size:12px;line-height:1;padding:0;margin-left:2px">✕</button></span>`
        ).join('')}</div>`;
    const pageAccessHtml = !role ? '' : `
      <div class="sap-section-label" style="margin-top:20px">${_esc(Util.t('sec.page_access'))}</div>
      <div class="sap-help" style="margin:2px 0 8px">${_esc(Util.t('sec.page_access_sub'))}</div>
      <div id="sec-role-pages" style="display:flex;flex-direction:column;gap:8px">
        ${_pageAccessDefs().map(([tab, label]) => _pageAccessRowHtml(role, tab, label, roleRow)).join('')}
      </div>`;
    el.innerHTML = `<div class="panel">
      <div class="sap-detail-head"><span class="sap-detail-name">${_esc(header)}</span></div>
      <div class="panel-body">${addHtml}${listHtml}${pageAccessHtml}</div>
    </div>`;
    if (role) {
      const srch = document.getElementById('sec-plant-search') as HTMLInputElement | null;
      srch?.addEventListener('focus', () => { _renderPlantDropdown(srch.value); (document.getElementById('sec-plant-dropdown') as HTMLElement).hidden = false; });
      srch?.addEventListener('input', () => { _renderPlantDropdown(srch.value); (document.getElementById('sec-plant-dropdown') as HTMLElement).hidden = false; });
      srch?.addEventListener('blur', () => { setTimeout(() => { const dd = document.getElementById('sec-plant-dropdown'); if (dd) dd.hidden = true; }, 150); });
    }
    el.querySelectorAll<HTMLElement>('[data-remove-plant]').forEach((b) =>
      b.addEventListener('click', () => _removePlantFromRole(b.dataset.removePlant as string)));
    el.querySelectorAll<HTMLInputElement>('[data-page-toggle]').forEach((cb) =>
      cb.addEventListener('change', () => _setRolePageAccess(cb.dataset.pageToggle as TopLevelTab, cb.checked)));
  }

  // Type-to-filter Store.knownPlants() down to matches, click one to add it —
  // NIMBUS's plant lists must never be a plain <select> at 50+ plant scale (see
  // CLAUDE.md); mirrors the PlantSelector/OptimizeDialog filterPlants pattern.
  function _renderPlantDropdown(query: string): void {
    const dd = document.getElementById('sec-plant-dropdown');
    if (!dd || !_selectedRole) return;
    const assigned = new Set(_rolePlants.filter((rp) => rp.role === _selectedRole).map((rp) => rp.plant));
    const all = Store.knownPlants().filter((p) => !assigned.has(p));
    const q = (query || '').trim().toLowerCase();
    const filtered = q ? all.filter((p) => p.toLowerCase().includes(q)) : all;
    if (!filtered.length) {
      dd.innerHTML = `<div class="hps-empty">${all.length ? 'No matches' : 'No plants available'}</div>`;
      return;
    }
    dd.innerHTML = filtered.map((p) => `<div class="hps-option" data-plant="${_esc(p)}">${_esc(p)}</div>`).join('');
    dd.querySelectorAll<HTMLElement>('[data-plant]').forEach((optEl) =>
      optEl.addEventListener('mousedown', (e) => { e.preventDefault(); _addPlantToRole(optEl.dataset.plant as string); }));
  }

  async function _addPlantToRole(plant: string): Promise<void> {
    if (!_selectedRole) return;
    try {
      await _postJSON(`${API}/master-data/role_plants/bulk`, { upserts: [{ role: _selectedRole, plant }] });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Add plant to role failed: ${(e as Error).message}`);
    }
    await _reloadRoles();
  }

  async function _removePlantFromRole(plant: string): Promise<void> {
    if (!_selectedRole) return;
    try {
      await _postJSON(`${API}/master-data/role_plants/bulk`, { deletes: [{ role: _selectedRole, plant }] });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Remove plant from role failed: ${(e as Error).message}`);
    }
    await _reloadRoles();
  }

  // Backend rejects role:'admin' + admin:false outright (server-side backstop
  // for the checkbox's own disabled state), so this can only ever persist a
  // legal combination. Full-page reload isn't needed — patch the in-memory
  // role row on success (same "commit only once confirmed" posture as
  // Plant's constraint toggles) and repaint either way, so a failure visibly
  // reverts the checkbox to the last-confirmed state.
  async function _setRolePageAccess(tab: TopLevelTab, checked: boolean): Promise<void> {
    const role = _selectedRole;
    if (!role) return;
    const roleRow = _roles.find((r) => r.role === role);
    const pages: Partial<Record<TopLevelTab, boolean>> = { ..._defaultPageAccess(role), ...(roleRow?.pages || {}), [tab]: checked };
    try {
      const r = await fetch(`${API}/master-data/roles/${encodeURIComponent(role)}/page-access`, {
        method:  'POST',
        headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
        body:    JSON.stringify({ pages }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || `HTTP ${r.status}`); }
      const result: { pages?: Partial<Record<TopLevelTab, boolean>> } = await r.json();
      if (roleRow) roleRow.pages = result.pages ?? pages;
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Save role page access failed: ${(e as Error).message}`);
    }
    _renderRolesDetail();
  }

  async function _addRole(): Promise<void> {
    const nameInput = document.getElementById('sec-new-role') as HTMLInputElement | null;
    const descInput = document.getElementById('sec-new-role-desc') as HTMLInputElement | null;
    const role = (nameInput?.value || '').trim();
    if (!role) return;
    try {
      await _postJSON(`${API}/master-data/roles/bulk`, { upserts: [{ role, description: (descInput?.value || '').trim() }] });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Add role failed: ${(e as Error).message}`);
    }
    await _reloadRoles();
  }

  async function _saveRoleDescription(role: string): Promise<void> {
    const input = document.querySelector(`[data-role-desc="${CSS.escape(role)}"]`) as HTMLInputElement | null;
    if (!input) return;
    try {
      await _postJSON(`${API}/master-data/roles/bulk`, { upserts: [{ role, description: input.value }] });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Save role description failed: ${(e as Error).message}`);
    }
    await _reloadRoles();
  }

  async function _deleteRole(role: string): Promise<void> {
    const ok = await Modal.confirm({
      title: Util.t('sec.confirm_delete_role_title'),
      message: Util.t('sec.confirm_delete_role_msg', { role }),
      confirmLabel: Util.t('btn.yes_delete'),
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await _postJSON(`${API}/master-data/roles/bulk`, { deletes: [{ role }] });
      if (_selectedRole === role) _selectedRole = null;
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('security', `Delete role failed: ${(e as Error).message}`);
    }
    await _reloadRoles();
  }

  return { render };
})();
