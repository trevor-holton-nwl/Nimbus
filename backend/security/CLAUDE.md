# Security — authentication, password hashing, RBAC guards, deployment API-key gate

## What lives here

- `routes.py` (125 lines, 9 routes) — `POST /security/login`, `GET /security/bootstrap-status`, `GET /security/me`, `PATCH /security/me` (self-service name), `PATCH /security/me/settings` (self-service settings merge), `PATCH /security/me/password` (self-service password change), `GET /security/users`, `POST /security/users/bulk` (admin user CRUD, username+role only), `POST /security/users/{username}/reset-password`.
- `auth.py` (666 lines) — whole-file move, **deliberately internally untouched**. Owns the `user_security` table (username → PBKDF2-HMAC-SHA256 password hash + role), `user_settings` (per-user JSONB blob), the `roles.settings` column bootstrap, all password hashing/verification, `authenticate()`, `whoami()`, the authorization dependencies (`require_authenticated`, `require_setup_scheduler`, `require_admin`), `get_allowed_plants[_for_request]`, `_actor_email`, and the bootstrap-admin seed (`ensure_bootstrap_admin`, gated on `NIMBUS_BOOTSTRAP_ADMIN_USERNAME`/`NIMBUS_BOOTSTRAP_ADMIN_PASSWORD`). Also holds `require_api_key`/`NIMBUS_API_KEY` (moved here in Phase P5 as a licensed reading of "auth guards live in `backend/security/auth.py`" — it's a deployment-config gate, not user auth, but every domain router's `Depends(require_api_key)` needs a non-`brain.py` home that doesn't create an import cycle, and this is it).

**`auth.py` is frozen pending the Entra Auth migration** — its internals (the header-trust model, the password-hash scheme, the dependency shapes) should not be restructured here. `Entra_Auth_Migration.md` (repo root) will rewrite it; don't propose incremental cleanups to the trust model in the meantime.

Role and `role_plants` admin CRUD do **not** live here — they go through the generic `master_data.py` grid machinery (`ALLOWED_TABLES` includes `roles`, `role_plants`). This module owns only what that generic grid must never touch: password hashes.

## Counterpart

Frontend half: `frontend/security/security-admin.mts` (`Security` — user/role admin UI).

No deferred-split data functions to cite here — unlike priority_lists/master_data/labor, this domain's data layer (`auth.py`) already lives fully inside the domain folder; there is no root-level `auth.py` counterpart left behind.

## Key invariants & hazards

- **The trusted-header identity hazard.** `auth._actor_email(request)` reads `x-user-email`/`X-User` headers — a client can spoof either. This is explicitly documented as **the single line that changes when real SSO lands**.
- **`Entra_Auth_Migration.md` (repo root) is the plan of record**, and it **supersedes** `docs/MIGRATION.md`'s WS3 workstream. **That supersession is NOT marked inside `docs/MIGRATION.md` itself** — a grep of `docs/MIGRATION.md` for "supersed*" near its WS3 sections (lines ~136–231, ~277–318, ~657) finds no such note; WS3 there still reads as live, forward-looking auth-hardening guidance. Flagging this explicitly rather than repeating it silently: a reader of `MIGRATION.md` alone would not know Entra's plan has already overtaken it.
- **First-run admin grace.** `require_admin` is open to *anyone* until the first `user_security` row with `role='admin'` exists (`auth.admin_exists()`), so onboarding a fresh install can never lock itself out. Once any admin exists, the grace closes.
- **`NIMBUS_API_KEY` is a deployment-config stopgap, not user identity.** Unset (the default) it's a no-op; set, it gates destructive/DDL/maintenance routes behind an `X-API-Key` header shared-secret. It says nothing about *which* user is acting — that's still the spoofable header above.
- **`role_plants` scoping.** `get_allowed_plants(username)` returns `None` (unrestricted) for an unknown/no-role user, `role == 'admin'`, or any role with zero `role_plants` rows — a role only becomes plant-restricted once it has at least one `role_plants` row. Admin is the sole *intentionally* plant-unrestricted role.
- **The last-admin guard.** `bulk_upsert_users` refuses (rolls back) any batch of role-changes/deletes that would leave zero admin users where at least one existed before.
- Password changes always require the *current* password (`change_own_password`) even for self-service — unlike name/settings self-service writes, which trust the header alone, because a header-spoofed identity plus no current-password check would let anyone who knows a username take over that account.

## Integration points

**Imports in:** `db._pool` only (shared Postgres connection pool) plus stdlib (`hashlib`, `hmac`, `secrets`, `base64`).

**Imported by:** every one of the other 8 domain routers imports `backend.security.auth` for `require_admin`/`require_api_key`/`get_allowed_plants_for_request` (confirmed via grep: `backend/admin_ops/routes.py`, `backend/integration/routes.py`, `backend/master_data/routes.py`, `backend/priority_lists/routes.py`, plus `backend/calendars/routes.py`, `backend/scheduling/routes.py`, `backend/setup/routes.py`, and `brain.py` itself). This makes `auth.py` one of the two most cross-domain-depended-upon files in the whole backend (the other being `backend/admin_ops/logbuffer.py`).

**Endpoints:** `POST /security/login`, `GET /security/bootstrap-status`, `GET|PATCH /security/me`, `PATCH /security/me/settings`, `PATCH /security/me/password`, `GET /security/users`, `POST /security/users/bulk`, `POST /security/users/{username}/reset-password`.

## Tests

`tests/test_change_password.py`, `tests/test_user_names.py`. Plant-scoping/auth-gating is also exercised incidentally inside `tests/test_material_plant_attributes.py`, `tests/test_setup_endpoints.py`, `tests/test_admin_tables.py`, `tests/test_logs_endpoints.py` (each asserts `require_admin`/`get_allowed_plants_for_request` behavior for its own route family).

```
python -m pytest tests/test_change_password.py tests/test_user_names.py -q
```

## Gotchas

- Don't add restructuring to `auth.py` as a drive-by while touching an adjacent route file — it's frozen pending Entra, and even a well-intentioned refactor here creates merge friction against that migration.
- `docs/MIGRATION.md`'s WS3 content is stale relative to `Entra_Auth_Migration.md` despite not saying so — treat `Entra_Auth_Migration.md` as authoritative for anything auth-related, and don't resurrect WS3 as if it were still the active plan.
