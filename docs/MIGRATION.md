# NIMBUS — Hosted Azure Pilot: Migration Runbook

> **Status: PARTIALLY EXECUTED — single-container pilot LIVE on Azure (2026-06-30).** The pilot code
> changes (containerization, env-driven paths, same-origin serving, the `firming_indicator` schema
> fix) are done, committed, and deployed — see the closing addendum and `DEPLOYMENT.md`.
> The hardening workstreams below (two-container split, Entra SSO, Key Vault, Azure Files durability,
> VNet) remain the plan of record; execute them in order as the pilot graduates toward production.
>
> **Local-first guarantee:** every change here is designed to be *additive and backward-compatible*.
> With no environment variables set and auth disabled, NIMBUS runs on your machine exactly as it
> does today — local Postgres, local login, `localhost:8000`. Nothing forces you off your current
> workflow until you deliberately deploy to Azure.

---

## Context

NIMBUS is graduating from a localhost single-user prototype to a **hosted deployment piloted in one Newell plant** (decision made after an executive presentation). The code itself is healthy and has already moved past its own docs — the backend runs on **Postgres** (`db.py`, `schema.sql`, `master_data.py`), not Excel; `styles.css` and `nimbus-intelligence.js` exist. The gap to a real plant pilot is almost entirely **infrastructure, security, and a thin slice of multi-user safety** — not features.

This runbook gets ONE plant safely live on Azure with real Newell logins, kills the committed secrets, and adds a single bounded guardrail so the 2–5 schedulers editing concurrently don't silently clobber each other.

### Decisions locked
- **Host:** Azure managed — Container Apps + Azure Database for PostgreSQL Flexible Server + Key Vault + Entra ID.
- **Auth:** Entra ID (Azure AD) SSO — real Newell accounts, replaces the trusted `X-User` header.
- **Scope:** Hosting + security MVP (defer deep multi-user state migration).
- **Concurrency:** 2–5 editors on the same plant → add a lightweight optimistic edit-conflict guardrail (the one bounded exception to "MVP").

### In scope
1. Externalize all config + secrets (Postgres creds, paths, CORS, frontend API base + Entra IDs).
2. Containerize (backend + frontend) with a local `docker compose` full stack.
3. Entra ID SSO: MSAL.js on the frontend, JWT validation on the backend, dev bypass that fails-closed in prod.
4. Optimistic edit-conflict detection on task-update endpoints (409 + frontend warn).
5. Color-wheel filesystem durability — **shipped 2026-07-07 via a Postgres `color_wheel` table** (per-plant wheels), superseding the originally-planned Azure Files mount. See WS5.
6. Same-origin reverse-proxy networking (frontend nginx → internal backend).
7. Azure provisioning runbook + schema bootstrap + `DEPLOYMENT.md`.
8. **Rotate the committed Postgres password** (`Mavdob8808!` is in source history).

### Out of scope (fast-follow, documented but not built)
- Full plant-scoped RBAC (a clean seam is left, not built).
- Migrating per-browser `localStorage` state (blackouts/calendars/line-settings) to server-side per-user storage.
- ~~Migrating color wheels from Azure Files into a Postgres table.~~ **Done 2026-07-07** — pulled forward: per-plant wheels persist in the `color_wheel` table (they never went via Azure Files). See WS5.
- VNet + Private Endpoint Postgres hardening.
- Pagination/filtering toward the 50-plant / 3,500-line roadmap.

---

## ⚠️ Preserving local development (read this first)

The migration is engineered so your current setup keeps working throughout:

| Concern | How local stays intact |
|---|---|
| **Postgres creds** | `os.environ.get("PG_HOST", "localhost")` etc. — defaults = today's local DB. No env = no change. |
| **File paths** | `COLOR_FILE` / `COLOR_WHEEL_DIR` keep working via `.env` overrides pointing at your existing Windows paths. |
| **Login / auth** | `NIMBUS_AUTH_DISABLED=1` (backend) + `window.NIMBUS_AUTH.disabled=true` (frontend) → run with **no Entra dependency**. Fail-closed guard only trips when `NIMBUS_ENV=production`. |
| **Frontend API base** | `app.js` falls back to `http://localhost:8000` when `window.NIMBUS_API_BASE` is unset. |
| **Full stack test** | `docker compose up` runs the hosted shape entirely on your machine before Azure is ever involved. |

**The committed password (`Mavdob8808!` in `db.py`) should be rotated regardless of timeline** — it is in source/version history.

---

## Workstream 1 — Config externalization & secrets

**`db.py` (lines ~23–36):** replace hardcoded `PG_*` block with `os.environ.get(...)` reads; **delete the plaintext password**. Add a new `PG_SSLMODE` (default `prefer` local, `require` on Azure — Flexible Server requires TLS). Build `CONN_STR` from env; the `ConnectionPool(..., min_size=0, open=True)` at line 36 stays (min_size=0 means import never networks, so unset env won't crash import). `master_data.py` shares this pool via `from db import _pool` — covered automatically.

```python
import os
PG_HOST    = os.environ.get("PG_HOST", "localhost")
PG_PORT    = os.environ.get("PG_PORT", "5432")
PG_DB      = os.environ.get("PG_DB",   "nimbus")
PG_USER    = os.environ.get("PG_USER", "postgres")
PG_PASS    = os.environ.get("PG_PASS", "")            # no default secret in source
PG_SSLMODE = os.environ.get("PG_SSLMODE", "prefer")   # Azure Flexible Server needs "require"
CONN_STR = (f"host={PG_HOST} port={PG_PORT} dbname={PG_DB} "
            f"user={PG_USER} password={PG_PASS} sslmode={PG_SSLMODE}")
```

**`brain.py`:**
- Lines ~45 / 67: `COLOR_FILE` and `COLOR_WHEEL_DIR` from env (defaults `/app/Color_Wheel.XLSX` and `/data/color_wheels`; override to your Windows paths locally via `.env`).
- Lines ~88–95: CORS `allow_origins` from `CORS_ALLOW_ORIGINS` env (comma-split). With same-origin proxy (WS6) this is effectively unused, but keep it env-driven; never `*` with `allow_credentials=True`.

**Frontend runtime config (no build step):** reuse the existing `window.NIMBUS_BUILD_ID` injection pattern.
- `index.html` (~line 45): add `<script src="/config.js"></script>` **before** `app.js`.
- `/config.js` is generated at frontend-container start from env (sets `window.NIMBUS_API_BASE`, `NIMBUS_TENANT_ID`, `NIMBUS_CLIENT_ID`).
- `app.js:69`: `API_BASE` consumes `window.NIMBUS_API_BASE` with `'http://localhost:8000'` fallback (mirror the line-83 pattern). Add `TENANT_ID` / `CLIENT_ID` Config fields for the auth module. When `API_BASE=""` or `"/api"`, all ~11 `${Config.API_BASE}/...` fetch sites resolve same-origin and are proxied — no other frontend change.

## Workstream 2 — Containerization (new files, app root)

- **`requirements.txt`** — pinned: `fastapi`, `uvicorn[standard]`, `pandas`, `numpy`, `openpyxl`, `psycopg[binary]`, `psycopg-pool`, **`python-multipart`** (required for `UploadFile` on `/upload` + color-wheel upload — easy to miss), `PyJWT==2.10.1`, `cryptography` (RS256 token validation).
- **`Dockerfile.backend`** — `python:3.12-slim`, non-root `appuser` (uid 10001), `pip install -r requirements.txt`, copy `brain.py db.py master_data.py schema.sql Color_Wheel.XLSX`, pre-create + chown `/data/color_wheels`, `CMD ["uvicorn","brain:api","--host","0.0.0.0","--port","8000"]`. (No `__main__` guard in brain.py — uvicorn entrypoint is correct.)
- **`Dockerfile.frontend`** — `nginx:1.27-alpine`, copy static assets + `nginx.conf` + entrypoint into `/docker-entrypoint.d/` (nginx image auto-runs it before start).
- **`docker-entrypoint.sh`** — writes `/config.js` from env at start; `envsubst` `BACKEND_FQDN` into `nginx.conf`.
- **`nginx.conf`** — serve static; `location /api/ { proxy_pass http://BACKEND_FQDN:8000/; ... }`; `location = /config.js { add_header Cache-Control "no-store"; }`; SPA `try_files $uri $uri/ /index.html`.
- **`docker-compose.yml`** — `db` (postgres:16, mounts `schema.sql` into `/docker-entrypoint-initdb.d/` for auto-apply, healthcheck), `backend` (env wired, `PG_SSLMODE=disable`, `/data` volume), `frontend` (`NIMBUS_API_BASE=/api`). Lets you `docker compose up` and exercise the whole stack at `http://localhost:8080` before touching Azure.
- **`.dockerignore`** (exclude `Sequence_Testing.XLSX`, `__pycache__`, `.env*`, `.git`, keep `Color_Wheel.XLSX`), **`.env.example`**, **`.gitignore`**, **`DEPLOYMENT.md`**.

## Workstream 3 — Entra ID SSO

**App registrations (you + IT, in Entra portal — cannot be scripted by Claude):** two apps —
- `NIMBUS-API` (exposes scope `access_as_user`, App ID URI `api://<api-client-id>`).
- `NIMBUS-SPA` (platform = **Single-page application**, PKCE, no secret; redirect URIs `http://localhost:8080` + `https://<frontend>.azurecontainerapps.io`; delegated permission on the API scope + admin consent).
- Record Tenant ID + both client IDs.

**Backend — new `auth.py`:**
- `PyJWT[crypto]` + `PyJWKClient` (cached JWKS, key rotation). Chosen over `fastapi-azure-auth`: fewer pinned deps, ~60 readable lines, trivial dev bypass.
- `require_user(request) -> dict` FastAPI dependency: validates `Authorization: Bearer` against issuer `https://login.microsoftonline.com/<tenant>/v2.0`, audience `<api-client-id>`, `RS256`. Returns `{email, oid, name, claims}`. Missing/invalid → `HTTPException(401)`.
- **Dev bypass:** `NIMBUS_AUTH_DISABLED=1` injects `{email:"dev@local",...}` — but **fail-closed**: if `NIMBUS_ENV==production` (or a Container Apps marker is present), the bypass refuses to run.
- **RBAC seam (stub only):** `require_plant_access(plant, user=Depends(require_user))` returns `user` today; future maps `user["oid"] -> allowed_plants`. Attach later to routes already carrying `plant`.

**Backend — `brain.py`:** `from auth import require_user`; add `user: dict = Depends(require_user)` per the protection matrix; replace the 6 trusted-header reads (lines ~809, 859, 905, 953, 973, 985, 1000) with `user["email"]` (master-data `md.*` calls already accept `user_email`).
- **Protect (all mutating):** `/task/update`, `/task/note`, `/tasks/update`, `/tasks/bulk_update`, `/upload`, `/purge`, `/reload`, `/upload/audit/clear`, `/logs/backend/clear`, `/color-wheel/{plant}` POST+DELETE, `/audit/log` POST+clear, all `/master-data/...` POST/DELETE/PATCH.
- **Protect (reads exposing business/infra data):** `/tasks`, `/color-wheel(s)`, `/audit/log` GET, `/master-data/*` GET, `/diagnostics/deep`, `/diagnostics/db`, `/logs/backend`.
- **Leave open:** `GET /health` (ACA liveness probe — must stay unauthenticated); basic `/diagnostics` optional.

**Frontend — `app.js` + `index.html`:**
- `index.html`: add MSAL UMD CDN (`@azure/msal-browser` v3) + `window.NIMBUS_AUTH` config (from `/config.js`).
- New `Auth` module after `Util` (~line 277): `PublicClientApplication` (Auth Code + PKCE, `sessionStorage` cache); `init()` (handle redirect, login if no account — honors `NIMBUS_AUTH.disabled` for local); `getToken()` (`acquireTokenSilent` → fallback redirect); `currentUser()`.
- **Single choke-point:** monkey-patch `window.fetch` early (after `Auth` defined) to attach `Authorization: Bearer` only for URLs starting with `Config.API_BASE`. Covers both raw `fetch()` and `Util.fetchTraced` without retrofitting ~50 scattered call sites; CDN/font requests untouched.
- Gate boot: make the `DOMContentLoaded` handler (~line 12878) `async`, `await NIMBUS.Auth.init()` before module init.
- Remove hardcoded `trevor.holton@newellco.com` `X-User` headers (lines ~1604, 1632, 3798, 11979, 12637, 12756, 12786, 12812, 12860) — identity now comes from the JWT.

### `roles` / `role_plants` / `user_security` — RBAC seam partially shipped (relates to Workstream 3, 2026-07-07)

A user-admin feature shipped three new, additive Postgres tables ahead of full Workstream 3.
Recorded here because **`role_plants` is exactly the per-plant RBAC seam this workstream already
anticipated** (the `require_plant_access` stub above), and because it creates a filename
collision this workstream's eventual implementer needs to know about.

- **`roles`** (`role` PK + `description`) and **`role_plants`** (`role`+`plant` composite PK, FK
  `role` → `roles(role)` `ON DELETE CASCADE`) are plain admin-managed tables wired through the
  **existing generic CRUD path** — added to `master_data.py`'s `ALLOWED_TABLES` / `_KEY_COLUMNS`,
  bootstrapped by new `ensure_roles_table()` / `ensure_role_plants_table()` (same
  `CREATE TABLE IF NOT EXISTS` + `column_metadata` seed idiom as every other `ensure_*` in that
  file), and served by `GET`/`POST /master-data/roles` + `/role_plants` like any other
  master-data table. **`role_plants` *is* the RBAC seam:** once WS3 lands, `require_plant_access`
  can resolve `user["email"]`/`oid` → `user_security.role` → `role_plants.plant` rows instead of
  returning `user` unchecked — no new table needed then, just wiring the dependency.
- **`user_security`** (`username` PK, `password_hash`, `role` FK → `roles(role)` `ON DELETE
  RESTRICT`) is **not** on the generic CRUD path — it's backed by a new, dedicated **`auth.py`**
  module (`list_users`, `bulk_upsert_users`, `set_user_password`, `verify_user_password`).
  Passwords are salted PBKDF2-SHA256 (600k iterations), set only via admin reset, and **never
  retrievable** — the read path never selects `password_hash`, only a `has_password` boolean.
- **⚠ Filename collision with this workstream's plan.** WS3 above already earmarks a future
  `auth.py` for Entra JWT validation (`require_user`, `require_plant_access`,
  `NIMBUS_AUTH_DISABLED` bypass) — that module didn't exist yet, so **this feature's `auth.py`
  claimed the filename first**, for an unrelated purpose (local username/password admin accounts,
  no JWT/Entra code). Whoever executes WS3 must reconcile the two — most likely fold Entra's
  `require_user`/`require_plant_access` into this same file alongside the password/user-admin
  functions (one `auth.py`, two concerns: Entra handles *authentication*, `roles`/`role_plants`
  handle *authorization*) — rather than assume `auth.py` is greenfield when WS3 starts.
- All DDL is additive-only (`CREATE TABLE IF NOT EXISTS`) and Azure/Entra-independent, consistent
  with this doc's local-first guarantee — runs against local Postgres like every other `ensure_*`
  table, no new infra required.

**Deferred follow-ups (tracked here, not built):**
- **Login-path hardening**, needed once an actual login screen consumes `verify_user_password`
  (today there's no session/token issuance — `user_security` is purely admin-managed username +
  role + password). Before wiring a real login: make a lookup on a nonexistent username
  constant-time (today it short-circuits before the PBKDF2 hash runs, a timing side-channel that
  lets an attacker enumerate valid usernames), add account lockout / rate-limiting on repeated
  failures, and decide session-vs-token issuance — this may fold into WS3's JWT flow rather than
  become a second, parallel auth mechanism (see the filename-collision note above).
- **Server-side `?role=` filter on `GET /master-data/role_plants`.** The endpoint returns the
  whole table today; the admin Security → Roles master-detail view (role list → its plants)
  filters client-side. Fine at prototype scale, but per this project's scale rule (`CLAUDE.md`:
  plant/line-list endpoints must be server-filterable at 50+ plants), add `?role=` server-side
  before the role/plant count grows.
- **Role-deletion cascade preview.** `plants`/`subnetworks` already get a friendly pre-delete
  usage preview (`/master-data/{table}/cascade-preview`) before a destructive delete. Deleting an
  in-use `role` does not — it now returns a clean `400` (the new generic `ForeignKeyViolation`
  catch added to `bulk_apply()` alongside these tables, firing on the `user_security.role`
  `RESTRICT` FK; `role_plants` rows just cascade-delete silently) instead of a `500`, which is
  correct but still just an error message, not a preview of which users would be affected. Extend
  cascade-preview to cover `roles` before real admins are managing many users per role.

### Per-plant RBAC enforcement (shipped 2026-07-09, closes the role_plants seam above)

`role_plants` stopped being CRUD-only scaffolding ahead of full WS3/Entra SSO. `auth.py` gained
`get_allowed_plants(username) -> list[str] | None` (`None` = unrestricted) and a FastAPI-dependency
wrapper `get_allowed_plants_for_request`. Semantics, mirroring `require_admin`'s fail-open posture:
unknown/no-role users, `role == 'admin'`, and a role with **zero** `role_plants` rows are all
unrestricted — a role is only restricted once it has ≥1 `role_plants` row (an unscoped role hasn't
"opted in" yet, so existing users are unaffected until an admin deliberately scopes their role).

**Enforced at (all narrowing, never widening an explicit filter):**
- `GET /tasks` — an explicit `?plant=` outside the caller's allowed set 403s; a `?line=`-only
  request 403s only if none of that line's plants (a line code can repeat across plants) are
  allowed; the unscoped `?limit=`-only tooling path is silently bounded to the allowed set rather
  than rejected (`db.query_orders`/`count_orders` gained an `allowed_plants` AND-filter).
- `GET /master-data/{table}` for `table in master_data.PLANT_SCOPED_TABLES` — `{'plants',
  'production_lines', 'material_plants'}`, a **static** allowlist (deliberately not derived from
  the dynamic "does this table have a `plant` column" check `list_rows` already uses for the
  `?plant=` param — the admin Add-Column DDL wizard can add a column named `plant` to any table on
  a whim, and this security boundary must not be able to widen itself via an unrelated admin
  action). Same 403-on-explicit-mismatch / silent-bound-otherwise behavior as `/tasks`.
- Frontend: `Session` caches `allowed_plants` from `POST /security/login` and `GET /security/me`
  (added a new `Session.allowedPlants()` accessor, mirroring `isAdmin()`); `Store.knownPlants()`
  intersects with it, so the header plant selector only ever offers allowed plants; if a role's
  scope changes and the currently-selected plant falls outside it, `Session.refresh()` clears the
  selection (same posture as its existing admin-tab-demotion redirect).

**Deliberately NOT scoped (documented, not missed):**
- `GET /master-data/roles` / `/role_plants` themselves — that `plant` column means "which plant
  this role can see," a different concept from "which plant this business record belongs to";
  scoping them would conflate the two. (Both remain otherwise ungated for GET, per the existing
  note above — unrelated to this change.)
- `subnetworks`/`materials` — no `plant` column, unaffected by construction.
- Orders with `orders.plant IS NULL` (ambiguous shared-line-code orders — see `db.py`'s
  `reattribute_null_plant_orders`) are invisible to **restricted** callers via the `ANY()` filter,
  by design (never guess) — an unrestricted caller still sees them today when no plant/line filter
  is given. If a "missing order" ticket ever traces back to a restricted role, check this first.
- Frontend filtering is UX, not the security boundary — `Session.refresh()` is fire-and-forget at
  boot, so a resumed session can briefly show a stale (possibly wider) plant list before it
  resolves. The backend enforcement above is unconditional and per-request regardless.

**⚠ Before re-deploying or re-seeding role_plants data:** any role that already has ≥1
`role_plants` row instantly restricts every user holding that role — there is no rollout toggle.
Audit first: `SELECT rp.role, array_agg(rp.plant), COUNT(us.username) FROM role_plants rp LEFT
JOIN user_security us ON us.role = rp.role GROUP BY rp.role;` — confirm every returned role is an
intentional, reviewed part of whatever change prompted the check.

`require_plant_access` from the original WS3 stub (line 109 above) is superseded by this —
`get_allowed_plants_for_request` is the real dependency now. When WS3/Entra SSO lands, only
`auth._actor_email` needs to change, same swap-point `require_admin` already relies on.

### Mandatory login + `require_admin` (shipped 2026-07-08, relates to Workstream 3)

Ahead of full Entra SSO, the app now **requires sign-in against `user_security` before any UI
renders**, and admin-only backend routes are gated behind a new `require_admin` dependency. This
is a stopgap that reuses the `roles`/`user_security` seam above, not a replacement for WS3.

- **Full-screen login gate.** `app.js` boots into a JS-built `.login-screen` overlay (mirroring
  `WelcomeSplash`'s append-to-`document.body` technique — no static markup added to
  `index.html` beyond the header `#user-chip`) whenever no `Session.currentUser()` is cached in
  `localStorage`. The rest of the existing `DOMContentLoaded` boot sequence was extracted into
  `App._bootMain()` so the exact same boot path runs whether the gate passes immediately or only
  after a successful `Session.signIn()`.
- **`auth.py` additions:** `authenticate()` (verifies against `verify_user_password`, never
  returns/logs the hash), `get_user_role()`, `admin_exists()`, `_actor_email(request)` (reads
  `x-user-email`/`X-User` — see SSO swap-point note below), `require_admin` (a FastAPI
  dependency; grace-opens if no admin row exists yet, otherwise requires `role == 'admin'`), and
  `ensure_bootstrap_admin()` (seeds the `admin` role + a `PJ29587` bootstrap user, both
  `ON CONFLICT DO NOTHING` — see the `schema.sql` note next to `user_security`).
- **New ungated endpoints** (they establish identity, by construction): `POST /security/login`,
  `GET /security/bootstrap-status`.
- **Endpoint gating, applied in three tiers** (audited call-by-call against actual frontend
  callers, not a blanket sweep):
  - **Admin-exclusive reads/ops, gated fresh with `require_admin`** — diagnostics, backend logs,
    audit log read/clear, upload-audit read/clear, master-data cascade-preview and
    `_schema-export`, plant-calendar writes (`plant-hours`/`line-hours`/`*-blackouts`), and the
    SAP interface read endpoints (`/sap/interface/objects`, `/mappings/{object}`,
    `/config/{object}`, `/runs`). `POST /reload` also picked up `require_api_key` alongside
    `require_admin` — it previously had **zero** auth, unlike its `/maintenance/*` siblings.
  - **Admin-exclusive writes, stacked onto the existing `require_api_key` guard** — `/upload`,
    `/purge`, color-wheel POST/DELETE, master-data bulk/DDL/constraints writes, `/security/users`
    (list + bulk + reset-password), the SAP interface write/sync/test-connection endpoints, and
    `/maintenance/vacuum-analyze`, `/maintenance/analyze`, `/logs/backend/clear`.
  - **Left untouched, explicitly** — app-wide/ops-critical/pre-auth-by-construction endpoints:
    `GET /tasks`, all three task-update endpoints, `/tasks/refresh`, `/tasks/baseline-correct`,
    `GET /health`, `/livez`, labor-plan read/write, `GET /master-data/{table}`,
    `GET /plant-calendar`, `GET /color-wheel(s)`, `POST /audit/log`, `POST /logs/frontend`, and
    the two new login endpoints. Gating any of these would break the app for non-admin users or
    the platform's own liveness probe. The in-process SAP `APScheduler` job is unaffected either
    way — it calls `master_data.bulk_apply()`/`db.upsert_orders()` directly in-process, never
    through brain.py's HTTP layer, so it never passes through `Depends()`.
- **Frontend actor identity:** the 12 raw-`fetch()` call sites and 2 module-level `USER_EMAIL`
  constants that hardcoded `'trevor.holton@newellco.com'` now read `Session.actor()` instead,
  so audit trails and `X-User`/`x-user-email` headers reflect whoever is actually signed in.

**Deferred, by design (not missed — flagged by the same verification pass that produced the
gating table above):**
- **Login-path hardening.** `/security/login` has no rate-limiting/lockout on repeated failed
  attempts, and an unknown-username lookup is not constant-time (same timing side-channel noted
  under the `user_security` RBAC-seam entry above, now directly reachable from an unauthenticated
  endpoint instead of only from admin-managed password verification).
- **The SSO swap point is `auth._actor_email(request)` — and only that one function.** When WS3
  lands, this is the single line that changes (from reading trusted `X-User`/`x-user-email`
  headers to reading a validated Entra JWT claim); `require_admin`, `authenticate()`, and the
  frontend `Session` module are all written to not care where the email came from.
- **Retire the first-run grace in `require_admin`** once WS3 (or any real SSO) lands — today it
  intentionally leaves every admin route open until the *first* admin row exists, which is safe
  only because that row is seeded at the very next boot by `ensure_bootstrap_admin()`.
- **Rotate/remove the `PJ29587` / `1234` bootstrap seed** once real named accounts exist in
  `user_security` — it is a throwaway credential checked into the hardcoded hash literal in
  `auth.py`, not a secret, and should not survive past initial onboarding.
- **Two optional low-priority UX fast-follows**, not built: re-checking a stale cached role on
  window focus (a demoted admin stays "admin" client-side until next login), and multi-tab
  sign-out sync via a `storage` event listener (signing out in one tab leaves other open tabs
  with a stale session until they next hit a 401/refresh).

### Admin 403-lockout hardening (shipped 2026-07-08, follows the section above)

The `require_admin` rollout above had a recurring failure mode: the frontend gates admin UI on the
`role` cached in `localStorage['nimbus.session']` **at login**, while the backend re-resolves the
role **live** on every request via an exact, **case-sensitive** `WHERE username = %s` lookup. A
seeded uppercase `PJ29587` admin therefore never matched a `pj29587` (or whitespace-padded) login,
and any post-login drift (DB reseed, role change, since-deleted row) left the admin UI visible while
every admin request returned a dead-end `403 "Admin role required"`. Fixed:

- **Case-insensitive, trimmed username matching** across `get_user_role`, `verify_user_password`,
  the `_actor_email` header read, the two user upserts (`ON CONFLICT (lower(username))`), and the
  bootstrap seed. Backed by a unique index on `lower(username)` — in `schema.sql`,
  `migrations/2026-07-08-username-ci-index.sql`, and self-bootstrapped **best-effort** in
  `ensure_user_security_table()` (it must never crash boot). **Run the case-collision pre-check in
  the migration file before deploying** — if two rows already differ only by case, collapse them
  first, or the index (and thus user upserts) can't be created.
- **`GET /security/me`** (`auth.whoami`, ungated like `/security/bootstrap-status`) returns the
  caller's live `{username, role, is_admin}`, mirroring `require_admin`'s grace. `Session.refresh()`
  reconciles the cached role against it **on boot** and **after any admin 403**, closing most of the
  "re-check stale cached role" fast-follow noted just above (only window-focus re-check and
  multi-tab `storage` sign-out sync remain deferred).
- **Graceful 403:** `Session.onAuthDenied()` turns a 403 on any admin action into a reconcile + a
  clear "sign in again" toast, wired into the Security tab's read and write paths.

**Not a security boundary.** `/security/me` and the graceful-403 UX only make the client agree with
the backend about admin status — identity is still the spoofable `x-user-email`/`X-User` header, so
the real trust boundary remains the WS3 Entra SSO swap point in `_actor_email` (above).

## Workstream 4 — Optimistic edit-conflict guardrail (bounded multi-user slice)

The single concession to multi-user, sized for "a few editors, same plant":
- **`schema.sql`:** add `updated_at TIMESTAMP DEFAULT NOW()` (or an integer `row_version`) to the orders table; bump it on every task write in `db.update_task_dates`.
- **`/tasks`:** include each task's `updated_at` in the response; frontend stores it on the task object.
- **`/task/update` + `/tasks/update` + `/tasks/bulk_update`:** accept the client's expected `updated_at`; if the DB row is newer, **reject that task with HTTP 409** and return the conflicting id(s) instead of overwriting.
- **Frontend:** on 409, show a Toast ("Order X was changed by someone else — reload to see the latest") rather than silently clobbering; refresh the affected row.
- **Known limitation (documented, not fixed):** `Persistence.saveAll()` pushes the whole task array coarsely; the granular `/task/update` path is where real concurrent edits flow and where the guardrail bites. Full per-user state sync is the fast-follow.

## Workstream 5 — Color-wheel durability (SHIPPED via Postgres, 2026-07-07)

Container Apps filesystem is ephemeral, but `COLOR_WHEEL_DIR` was written at runtime. **Resolved by pulling the post-pilot option forward: per-plant color wheels now persist in a Postgres `color_wheel` table** (one row per plant: a JSONB `{COLOR: ORDER_Y}` map + upload metadata; migration `migrations/2026-07-07-color-wheel-table.sql`, mirrored into `schema.sql`, self-bootstrapped by `db.ensure_color_wheel_table()`). This needed **no new Azure infra, dependency, or auth** — Postgres was already the only durable store wired — and removes the durability/SMB-race reason the app was pinned to single-replica (the in-process `PLANT_CWS` cache + log ring buffer are the remaining single-replica reasons; cross-replica cache refresh after an upload still needs `/reload`). The originally-planned **Azure Files SMB mount at `/data` was NOT built** (net-new storage account + share, and it kept single-replica); this **supersedes Fork 1's "Azure Files now" default**. The `brain.py` seams (`load_color_wheels`, `_reload_one_plant_wheel`, the four `/color-wheel*` endpoints) now read/write the DB. An **opt-in** one-time `_backfill_color_wheels_from_disk()` (env `NIMBUS_CW_BACKFILL=1`, **off by default**) imports legacy on-disk wheels into the empty table — off by default so running the app locally against a remote DB never silently pushes local dev wheels into it; a no-op in the container regardless (its `/data` is empty on boot).

**Still on `/data` (ephemeral) — separate follow-ups:**
- ~~**Global wheel** (`COLOR_FILE`)~~ — **retired entirely, 2026-08-11** (`docs/scheduling_priority.md` Stage 1: "Default tier: Per-plant only"). It previously lived at `/data/color_wheel.xlsx`, was never baked into the image (`.dockerignore` excludes all `*.xlsx`), and so was always empty after a restart in practice — one more reason removing the tier cost nothing real. The `COLOR_FILE`/`COLOR_WHEEL_DIR` split in deployment config is now vestigial (`COLOR_WHEEL_DIR` still holds the audit log below; `COLOR_FILE` can be dropped from container env vars in a follow-up).
- **Audit log** (`COLOR_WHEEL_DIR/_audit_log.json`): a shared append-only log of color-wheel **and** `optimization_run` events (see the `/audit/log` endpoints). Left file-based for now; its durability is a distinct item spanning optimization events, not just color wheels.

### Priority lists generalize color wheels (2026-08-11) — three follow-ups

`docs/scheduling_priority.md` Stage 1 generalized this workstream's `color_wheel` table into
`priority_list` (one row per plant/line/field instead of one row per plant). Three items to track
going forward, none blocking:

1. **`PLANT_LISTS` is per-process — same gap as `PLANT_CWS` before it, but wider.** An upload/
   resync on one replica does not update another replica's in-memory cache until that replica's
   own `POST /reload` runs. This was already true for the color-only cache; it now spans up to 4
   fields × however many line overrides exist, instead of 1 field × 1 scope per plant. Not a
   blocker on the pilot's single-replica deployment; needs a real fix (pub/sub invalidation, or
   just reading `priority_list` per request) before multi-replica.
2. **Three deliberate compat shims**, kept so `ColorWheelViewer`, the Admin Cockpit coverage
   panel, and the `/color-wheel/*` API contract could survive the migration untouched:
   - The `color_wheel` table itself is left in place, fully populated, and never read again except
     by the one-time migration that already ran.
   - `/color-wheel/{plant}` (GET/POST/DELETE) and `/color-wheels` are a thin compat layer over
     `priority_list` rows scoped to `field_key='colorWheel', line=''` — a real client of the
     generalized API would call the (Stage 2+) `priority_list` endpoints directly instead.
   - `ORDER_Y` on the task DTO is a color-only alias, stamped by `apply_priority_merge` from
     whichever `colorWheel` list applies — not a generic rank, and not read by the optimizer once
     Stage 3 ships its own per-field terms.
   Untracked, these read as odd/redundant surface to a future reader; this paragraph is that
   tracking.
3. **PRT_02 is single-valued today** (`material_plants.prt_02` is one TEXT column), matching what
   the schema holds and what was explicitly scoped for now. The known long-term shape is
   PRT_02 → **production version** → BoM + routing (multiple molds/tools per material via a
   production-version-keyed table) — `material_plants.default_production_version` (materialized
   onto `orders.production_version`) is deliberately the eventual join anchor for that rework, so
   when it lands, only `db._stamp_order_attributes`' query changes.

### Priority lists Stage 2 (2026-08-10) — five more follow-ups

Stage 2 of `docs/scheduling_priority.md` shipped the generic upload/column-mapping UI, per-field
coverage, a generic list-preview viewer, and the missing-master-data admin panel on top of Stage 1's
data plumbing above. Checking the two open items Stage 1 left behind: **R13** (`PLANT_LISTS` is
per-process) is unaffected — Stage 2 adds read/CRUD surface, not a new caching layer, and everything
still funnels through the existing `_reload_one_plant_lists`. **R17**'s three compat shims are if
anything narrowed by item 3 below (the `/color-wheel/{plant}` rewrite consolidates onto shared
helpers instead of adding a fourth shim) — though it surfaces one new naming-family nuance worth
tracking on its own. Five more items, in addition to the three above:

1. **`PriorityListMapping` and `PriorityListViewer` are new bridge-wired modules**, added to
   `schedule-workbench.mts` (bridged onto `window.__NIMBUS_WORKBENCH` per CQ-1's module bridge — see
   `CLAUDE.md`/`AGENTS.md` → Architecture → Frontend). They belong in
   `docs/architecture/cq1-compatibility-inventory.md`'s §1 Module Ownership Map and §5 export lists
   alongside `ColorWheelViewer`/`OptimizerPreview`/etc. — that inventory was **not** touched as part
   of this stage, so keep it in sync if a future module reshuffle moves workbench modules around.
2. **The "not yet used in sequencing" badge is Stage-3-removable scaffolding, not permanent UI.** It
   exists so real tooling/production-version data — and its coverage — can be validated before the
   optimizer depends on it (`docs/scheduling_priority.md` N16). Grep the literal strings
   `pl-inert-badge` (CSS class, `web/styles.css`) and `not_yet_used_in_sequencing` (i18n key, all 5
   `web/locales/*.js`) to find every place it needs to come out once a field is actually wired into
   `Engine._sortTerms`.
   **DONE 2026-08-11.** Stage 3 wired all four fields into `Engine._sortTerms` but initially left the
   badge up, making it a false statement on the very screen where an admin configures the field —
   caught by Stage 3's Task 10 verification and removed in its fix round. All three carriers are gone:
   the `inertBadge` local and its `<span>` in `web/plant-and-administration.mts`, the
   `.pl-inert-badge` rule in `web/styles.css`, and `ui.not_yet_used_in_sequencing` in all five
   `web/locales/*.js` (verified no other surface used either, and that `locale-completeness.test.mjs`
   does not require the key; `lint:errors` still reports the same 47 pre-existing `no-dupe-keys`).
   One thing to know if this ever comes back up: a *replacement* caution ("newly used in sequencing —
   verify your coverage") was considered and deliberately not shipped, because nobody has yet
   validated real `prt_01`/`prt_02` values against a real list (Risk 3 is live) — so this removal did
   drop a warning, and that residual now lives only in `docs/scheduling_priority.md`'s Stage 3 status
   and the Stage 2 coverage readout.
3. **`POST /color-wheel/{plant}` was rewritten (Task 5, Decision 9b) onto the same
   `_resolve_priority_list_columns`/`_persist_priority_list` helpers** the new generic
   `POST /priority-list/{plant}/{field_key}` endpoint uses. One deliberate behavior change: a
   color-wheel file with no `ORDER_Y` column now succeeds via row-order fallback instead of
   400ing — strictly more permissive (no previously-valid file can start failing), but worth knowing
   if any external caller relied on the old rejection as a validation signal. Its audit-log action
   names (`color_wheel_upload`/`color_wheel_replace`) are now the **only** route still emitting that
   naming family — `priority_list_upload`/`priority_list_replace` is standard everywhere else,
   including color uploaded through the new generic UI. Two other legacy behaviors were deliberately
   preserved on this route only (duplicate-value last-write-wins instead of the generic endpoint's
   400 on conflicting ranks, and no empty-file rejection) — see the `upload_color_wheel` docstring in
   `brain.py`. **Not yet verified against a real external caller** — a manual curl/Postman test with
   and without `ORDER_Y` is still on `docs/scheduling_priority.md`'s own pre-ship checklist.
4. **~~`tests/contracts/cq1-legacy-surface.json` is stale.~~ RESOLVED in the final fix pass.** Tasks
   10-12 had added 6 inline `onclick`/`oninput` handlers to `web/index.html` for the mapping/viewer
   modals, which both broke the legacy-surface contract snapshot and moved `CLAUDE.md`'s tracked
   static-inline-handler count (the quantified blocker to switching `index.html`'s CSP meta tag from
   Report-Only to enforcing) the *wrong* way. Rather than regenerate the snapshot around them, all 6
   were removed and re-wired through the existing boot-time hook in
   `web/plant-and-administration.mts` (`Plant`'s `_wireStaticHandlers`, the same place
   CalendarUI/Plant/ProdLines' static markup is wired). The regenerated fixture is therefore a net
   **removal** of 2 entries versus the pre-stage snapshot (the two color-wheel inline handlers this
   stage's field-card rewrite deleted), with zero additions. One gotcha worth knowing: the
   legacy-surface scanner greps `index.html`'s **raw text** for `Module._member`, so writing that
   hook's name literally in an HTML comment adds a phantom `privateConsumers` row — the comments
   there deliberately spell it without the dot.

5. **The Optimization tab uploads colour through the STRICT validation path, on purpose — stricter
   than what `POST /color-wheel/{plant}` still allows.** Every field card, colour included, posts to
   `POST /priority-list/{plant}/{field_key}`, which runs `_resolve_priority_list_columns` with
   `reject_conflicts=True` (a duplicate value carrying two different ranks is a 400) and rejects an
   empty/header-only file. The legacy `POST /color-wheel/{plant}` route keeps the opposite posture
   for backward compatibility (`reject_conflicts=False`, last-value-wins; no empty-file check — see
   item 3 above and the `upload_color_wheel` docstring). So the same colour-wheel file can be
   accepted by the legacy API route and rejected by the UI. **This divergence is deliberate and was
   reviewed** — the choice was explicitly to keep the UI strict rather than special-case colour down
   to legacy permissiveness, because a conflicting-rank or empty colour file is a data error worth
   surfacing to the admin uploading it, and the UI has a mapping/error surface to surface it on
   (external API callers do not). Do not "fix" the UI path to match the legacy route; if anything
   converges later, it should be the legacy route tightening once no external caller depends on its
   tolerance (item 3's unverified-external-caller note still applies).

### Priority lists Stage 3 (2026-08-11) — R13 widens, R17 narrows, plus two new items

Stage 3 of `docs/scheduling_priority.md` wired the priority tree into the optimizer: `Engine._sortTerms`
is now a generic term factory over the plant's (possibly nested) constraint tree, resolving ranks from
`Store.priorityRankMaps`, which is loaded from a new `GET /priority-rank-maps?plant=` served straight
out of the in-memory `PLANT_LISTS`. Re-checking the two items Stages 1-2 left behind:

- **R13 (`PLANT_LISTS` is per-process) — same mechanism, materially wider blast radius. Read the
  Stage 1 wording above as *understated* from Stage 3 onward.** Before Stage 3 a stale `PLANT_LISTS` on
  one replica meant that replica served stale *display* data — the Optimization tab's coverage numbers,
  `ColorWheelViewer`, the Admin Cockpit coverage panel, and the `ORDER_Y` column stamped on `/tasks`.
  Now `GET /priority-rank-maps` reads the same cache and the optimizer's tie-break terms read *that*,
  so **a stale replica changes the sequence a planner gets from Optimize → Run and from an overload
  alert's auto-fix** — not just what a panel displays. Concretely, on a multi-replica deploy: an admin
  uploads a corrected tooling list, replica A refreshes its cache, a planner whose next request lands on
  replica B optimizes against the *old* ranks, and nothing in the UI indicates which they got.
  **Not urgent — the pilot is deliberately single-replica** (`docs/DEPLOYMENT.md`; the in-process cache
  and the log ring buffer are the two reasons), so today there is exactly one cache and it is always the
  one that was updated. But this moves R13 from "stale numbers on a screen" to "wrong schedule", so it
  should be fixed *before* scaling to 2+ replicas, not after. The fix options are unchanged (pub/sub
  invalidation, or have `/priority-rank-maps` read `priority_list` per request and accept the DB hit —
  the endpoint exists precisely to be a zero-DB read, so the second option is a deliberate trade).
- **R17 (three compat shims) — narrowed by one, and the third is now factually true rather than
  forward-looking.** The `ORDER_Y` shim's wording ("not read by the optimizer once Stage 3 ships its own
  per-field terms") is now **realized**: `grep -rn "colorMap" web/` returns nothing, and no live
  `ORDER_Y` read remains anywhere on the optimizer path (only the upload drop-hint locale strings, the
  `NimbusTask`/`TaskDTO` declarations, and two comments recording the retirement). `ORDER_Y` is still
  stamped server-side by `apply_priority_merge` and still keys the emitted row sort (`brain.py:1026`,
  presentation only) and `ColorWheelViewer`. The `/color-wheel/{plant}` shim also lost frontend readers:
  Stage 3 repointed the Optimize dialog's wheel badge/confirm **and** Plant → System Settings' "(no
  wheel)" hint onto the shared `Engine.hasPriorityRanks(fieldKey)`, which reads
  `Store.priorityRankMaps` — so it sees per-line overrides, which the plant-wide-only endpoint never
  did. `ColorWheelViewer._load()` is now that endpoint's **only** frontend reader; everything else is
  external-API back-compat.
- **~~NEW: `GET /priority-rank-maps` has no plant-authorization check, and its client uses bare
  `fetch`.~~ FIXED 2026-08-11** — both halves in one change: the route now takes
  `allowed_plants: … = Depends(auth.get_allowed_plants_for_request)` and runs `_assert_plant_allowed`
  with the sibling routes' `PlantNotAllowed`→403 / `ValueError`→400 mapping, and
  `Persistence.loadPriorityRankMaps` now uses `Util.fetchTraced`. Unrestricted users are unaffected
  (no identity header still resolves to unscoped). Kept below because the *coupling* is the durable
  lesson: it is the only plant-scoped endpoint in `brain.py`'s priority-list block without an
  `allowed_plants: … = Depends(auth.get_allowed_plants_for_request)` gate — `/priority-lists`,
  `/priority-list/{plant}/{field_key}` and `GET /tasks` all have one. A plant-restricted user can read
  any plant's rank maps (color names, tool codes, ranks). Low severity while actor identity still comes
  from spoofable `X-User`/`x-user-email` headers (see Workstream 3 / `Entra_Auth_Migration.md`), but it
  is an inconsistency to close. **These two facts are coupled:** `Persistence.loadPriorityRankMaps`
  (`web/schedule-data.mts:1187`) calls the endpoint with bare `fetch`, not `Util.fetchTraced`, so it
  sends no identity header — adding the gate without switching that call to `fetchTraced` in the same
  change would 403 every rank-map load for plant-restricted users. That is the same coupling that
  produced a production-only bug in Stage 2 (the missing-master-data fetch). Switching to `fetchTraced`
  also restores the `x-request-id` correlation this fetch currently loses.
- **~~NEW: the alert auto-fix path can sequence against the previously-selected plant's ranks.~~
  FIXED 2026-08-11** — `Persistence.load()` now clears `Store.priorityRankMaps` and `_rankMapsPlant`
  at the top of the function whenever the requested plant differs from the one the cache holds (so
  before `/tasks`, before the master-data `Promise.all`, and long before the `:404`
  `schedule:hydrated` emit), and `_loadCache()`/`_loadDemo()` clear unconditionally since neither ever
  loads rank maps. The window now degrades to "nothing ranked yet", which `OptimizeDialog.run()`'s
  existing guard already recovers from. Same-plant force-reloads deliberately keep their cache.
  Original diagnosis kept below, since it explains why the clear sits where it does:
  `Store.priorityRankMaps` is never cleared when the selected plant changes, and
  `Persistence.loadPriorityRankMaps(plant)` is only invoked inside the `.finally()` of `load()`'s
  master-data `Promise.all` (`web/schedule-data.mts:445`, whose fetches carry 5 s timeouts) — while
  `schedule:hydrated` is *also* emitted earlier, at `:404`, which is what triggers the alert recompute
  that renders the Fix buttons. So there is a window during a plant switch where plant B's alerts are
  live but plant A's rank maps are still cached. `Optimize → Run` is protected (it awaits
  `loadPriorityRankMaps` on a `Persistence._rankMapsPlant` mismatch and confirms with the user
  otherwise); `Alerts.applyFix` structurally cannot be, because `schedule-services.mts` may not import
  `schedule-data.mts`. Cheapest mitigation, deliberately **not** applied: clear the cache and
  `_rankMapsPlant` at the top of `Persistence.load()` when the plant differs, degrading the failure
  mode from "wrong plant's ranks" to "unranked" (which the Run-path confirm already catches). Also
  affects `_loadCache()` (`:893`) and `_loadDemo()` (`:1003`), which emit `schedule:hydrated` and never
  load rank maps at all. Full trace in
  `docs/superpowers/plans/2026-08-11-stage-3-sequencing-audit.md` §11.1.
  **Two residual follow-ups from the final-review re-check of this fix (2026-08-11), neither blocking
  — both degrade to the same safe "unranked" fallback, not to a wrong-plant sequence:**
  - `_loadCache()`'s clear is unconditional, but its one caller is `load()`'s network-failure `.catch()`
    — so a same-plant reload during a backend outage now needlessly wipes a still-valid rank cache
    (pre-fix it would have kept it). Cheap symmetric fix available: gate on
    `data.selectedPlant !== Persistence._rankMapsPlant`, same as `load()` itself. `_loadDemo()`'s
    unconditional clear is correct as-is (synthetic orders belong to no plant).
  - `loadPriorityRankMaps` has no generation/request token (unlike `_updatePlantBadge`'s own
    `_wheelFetchToken`, which guards the *badge* but not the *Store write* it triggers). An in-flight
    fetch for the outgoing plant can still resolve and repopulate the cache after the new plant's
    clear, reopening a narrower version of the same window — reachable via a rapid double plant-switch,
    or an admin upload/delete refresh immediately before a switch. One-line remedy: apply the same
    monotonic-token pattern inside `loadPriorityRankMaps` itself.

- **`POST /master-data/plants/{plant}/constraints` has no per-plant authorization gate.**
  (`brain.py:2451`.) The route carries `Depends(require_api_key)` and `Depends(require_admin)`, but
  neither it nor `master_data.set_plant_constraints` calls `md._assert_plant_allowed(plant,
  allowed_plants)` the way every priority-list route does — so an admin whose `role_plants` scope is
  limited to one plant can POST another plant's priority tree and silently change that plant's
  optimizer precedence.

  **Pre-existing, deliberately parked** at Stage 3's final review (2026-08-11) rather than folded into
  its closing fix wave: the endpoint predates this feature and its only Stage 3 change was the
  nested-`children` normalization, so this is broader than the stage and deserves its own scoped
  change. What Stage 3 *did* change is the consequence — the route went from writing a largely dormant
  list to writing live sequencing config — which is why it is recorded here instead of dropped. Note
  the asymmetry it leaves behind: Task 10 closed the identical omission on `GET /priority-rank-maps`
  on exactly this reasoning ("the only plant-scoped endpoint in its block without it"), so the two
  sibling surfaces now disagree about whether plant scope is enforced.

  Fix shape: add the same `_assert_plant_allowed` try/except (403 on `PlantNotAllowed`, 400 on
  `ValueError`) the priority-list routes use, plus an `allowed_plants` dependency. Two related hardening
  items in the same function while it is open — `master_data._normalize_constraint_tree` caps depth at 3
  but bounds neither node count nor sibling breadth, and never validates `key` against
  `RANKABLE_FIELDS`, so a direct API call can store an arbitrarily wide tree of arbitrary keys into the
  `plants.constraints` JSONB (the tree UI bounds both, but the UI is not the only writer).

- **`Dashboard._nextChangeover` still hardcodes `COLOR`/`FORM_SIZE`** (`web/schedule-workbench.mts:4339`)
  — the third and last changeover-detection surface, feeding the "Next CO" cell of the line-status
  panel via `Dashboard._renderLineStatus` (`:4392`). On a plant that sequences by tooling it reports
  the wrong next-changeover time (and "—" where a real PRT change is imminent), because a PRT-only
  regrouping changes `PRT_01` while leaving color and form identical.

  **Parked at Stage 3's final re-review (2026-08-11)**, after that wave generalized the other two
  copies. Deliberate scope call, not an oversight: this is a **display-only** readout with no effect
  on sequencing, unlike the two that were fixed — `Util.countChangeovers` backs the Optimizer
  Preview's Apply/Discard KPI (a planner acts on it), and `AlertsUIAdapter`'s cell briefing sits on
  the alert path. Parked rather than folded in because this stage runs exactly one fix wave.

  Fix shape: one line. Replace the inline
  `(t.COLOR||'') !== (ref.COLOR||'') || (t.FORM_SIZE||'') !== (ref.FORM_SIZE||'')` with
  `Util.changeoverFields().some(f => (t[f]||'') !== (ref[f]||''))`, exactly as `countChangeovers`
  (`web/application-foundation.mts:563`) and the cell briefing (`web/schedule-workbench.mts:7696`)
  already do. `Util.changeoverFields()` is public and already resolves through the
  `Engine.changeoverTaskFields` seam that wave installed, so no new plumbing is needed — hoist the
  call above the loop, like both existing callers.

## Workstream 6 — Networking: same-origin reverse proxy

Frontend nginx proxies `/api` → backend; **backend ingress = `internal`** (not publicly exposed). Eliminates CORS entirely (resolves the invalid `*`+credentials combo), makes auth/token flow clean, shrinks attack surface. `NIMBUS_API_BASE="/api"`. (Cross-origin + CORS only needed if the frontend later moves to a CDN/Static Web App.)

## Workstream 7 — Azure provisioning runbook (`az` CLI)

Ordered (user-assigned managed identity + Key Vault **before** the apps — a system-assigned identity can't be referenced at create time):
1. Resource group.
2. **User-assigned managed identity** (UAMI) first.
3. Azure Container Registry (`az acr build` for both images).
4. Postgres Flexible Server (Burstable `Standard_B1ms` for pilot) + `nimbus` db + firewall (allow-Azure for pilot).
5. Key Vault (RBAC mode) + secrets (`pg-pass`, `pg-host`, `pg-user`).
6. Grant UAMI `Key Vault Secrets User` + `AcrPull`.
7. Storage account + Azure Files share `nimbus-colorwheels`.
8. Container Apps environment + register file share as env storage.
9. Backend Container App: `--ingress internal`, `--min/max-replicas 1`, KV secret refs via `--user-assigned`/`--registry-identity`, env vars (`PG_*`, `PG_SSLMODE=require`, `COLOR_*`, `NIMBUS_ENV=production`, `NIMBUS_TENANT_ID`, `NIMBUS_API_CLIENT_ID`); mount `/data/color_wheels` volume via `az containerapp update --yaml`.
10. Frontend Container App: `--ingress external`, env vars `NIMBUS_API_BASE=/api`, `BACKEND_FQDN`, `NIMBUS_TENANT_ID`, `NIMBUS_CLIENT_ID`.

> The full `az` command sequence with all variables belongs in `DEPLOYMENT.md` (created during WS2). This list is the ordering contract.

## Workstream 8 — Schema bootstrap

`schema.sql` is idempotent + Azure-safe. **Pilot: one-shot `psql` from Cloud Shell** (`sslmode=require`) right after the Postgres server is up, before backend traffic — `lifespan` runs idempotent `ensure_*` DDL at boot (`db.ensure_color_wheel_table`, `ensure_priority_list_table`, `ensure_order_schedule_segments_table`, `ensure_order_distribution_tables`, `md.ensure_labor_plan_table` and the `ensure_plant_*` column helpers, `brain.py` lifespan) on top of the migrated schema, so the base schema must exist first. Re-running on later deploys is safe. (CI option: Container Apps Job from the backend image — defer.)

---

## Files

**Create (app root):** `requirements.txt`, `Dockerfile.backend`, `Dockerfile.frontend`, `nginx.conf`, `docker-entrypoint.sh`, `docker-compose.yml`, `.dockerignore`, `.env.example`, `.gitignore`, `auth.py`, `DEPLOYMENT.md`.

**Modify:**
| File | Change |
|---|---|
| `db.py` | env-driven `PG_*` + `PG_SSLMODE`; delete plaintext password |
| `brain.py` | env `COLOR_FILE`/`COLOR_WHEEL_DIR`/CORS; `Depends(require_user)` per matrix; replace 6 trusted-header reads; 409 conflict checks on task-update routes |
| `schema.sql` | add `updated_at`/`row_version` to orders table |
| `app.js` | `API_BASE`+`TENANT_ID`/`CLIENT_ID` from `window.*`; `Auth` module; `window.fetch` monkey-patch; async boot gate; remove hardcoded `X-User`; handle 409 |
| `index.html` | `<script src="/config.js">` + MSAL CDN + `window.NIMBUS_AUTH` |

---

## Forks (defaults chosen; confirm at execution time)
1. **Color wheels:** ~~Azure Files mount now vs. Postgres table now → default: Azure Files~~ → **REVERSED — shipped as a Postgres `color_wheel` table (2026-07-07)** for per-plant wheels; Azure Files was never provisioned. See WS5.
2. **Postgres exposure:** public + allow-Azure firewall (pilot) ✅ vs. VNet + Private Endpoint → *default: public for pilot, harden as fast-follow*.
3. **Schema bootstrap:** manual `psql` one-shot ✅ vs. Container Apps Job → *default: manual*.
4. **Security action (not optional):** rotate the Postgres password — `Mavdob8808!` is in git/source history.

---

## Verification (run at execution time)

1. **Local stack still works first:** with no env vars / auth disabled, `uvicorn brain:api --port 8000` (open `http://localhost:8000/`) behaves exactly as today.
2. **Local containerized stack:** `docker compose up` → `http://localhost:8080`. Schema auto-applied, `/tasks` loads, drag/edit persists, color-wheel upload writes to `/data` volume, app boots with `NIMBUS_AUTH.disabled=true`.
3. **Auth:** with dev bypass off, unauthenticated `POST /task/update` → 401; valid Entra token accepted; `GET /health` stays open; audit rows record the real signed-in email, not `trevor.holton@`.
4. **Conflict guardrail:** two sessions on the same plant edit the same order; second save gets 409 + Toast, not a silent overwrite.
5. **Config externalization:** grep images/source for `Mavdob8808!`, `localhost:8000`, and Windows `C:\...Scheduler` paths — all gone from runtime config.
6. **Azure pilot:** run `DEPLOYMENT.md` into a test resource group; frontend external URL loads, `/api/*` proxies to internal backend, Key Vault secret refs resolve, color wheels survive a backend revision restart.

---

## Addendum — Pre-migration audit remediation (applied 2026-06-25)

> These are **audit fixes applied ahead of** the Azure workstreams above — additive and
> backward-compatible (no env set ⇒ behaves as before). They do **not** replace the
> workstreams; where they overlap (auth, CORS), the workstream is still the real fix.

### User security — the hole is *patched*, not *closed* (relates to Workstream 3)

The destructive / DDL / maintenance endpoints (`/upload`, `/purge`, `/master-data/{table}/bulk`,
`/master-data/{table}/columns` ADD/DROP/rename, `/master-data/plants/{plant}/constraints`,
`/maintenance/*`) now carry an **optional shared-secret guard** (`brain.py` `require_api_key`):

- **No-op until `NIMBUS_API_KEY` is set** — local/dev runs unchanged.
- When set, those routes require a matching `X-API-Key` header (else `401`).
- **2026-09-02: the frontend is now wired.** `GET /security/client-config` (public, no
  `Depends(...)`) lets the SPA learn the current key at boot; `Util.setApiKey` +
  `fetchTraced` (`frontend/platform/foundation.mts`) echo it back as `X-API-Key` on every
  request. This closes the exact gap flagged just above — enabling the key on
  `ca-nimbus-dev` the same day `700daab` swept `require_api_key` onto more admin routes,
  *before* this wiring existed, briefly 401'd real admin users on `/security/users`,
  `/admin/tables`, `/diagnostics/db`, and `/logs/backend`. To enable on a non-Azure host now,
  only the backend env var needs setting — the frontend picks it up automatically.

**This is NOT user-level security.** Actor identity is *still* read from spoofable
`X-User` / `x-user-email` headers, so audit attribution remains untrustworthy. The real fix is
**Workstream 3 (Entra ID SSO)** — server-verified per-user identity that replaces both the trusted
headers and this stopgap key. Treat `NIMBUS_API_KEY` as a deployment-config lock for the gap
between now and SSO, nothing more. Per-plant RBAC remains the documented fast-follow (WS3 seam).

CORS was also corrected: `allow_credentials=False` (the frontend sends no cookies) and origins
from `NIMBUS_ALLOWED_ORIGINS` (default `*`), removing the spec-invalid `*`+credentials combo.
Workstream 6 (same-origin reverse proxy) still supersedes this once hosted.

### orders.plant — schema migration required (relates to roadmap multi-plant scaling)

The `/tasks` read path previously derived an order's plant by `LEFT JOIN production_lines` on the
**line code alone**. At 50+ plants a reused line code would fan out / mis-attribute orders
(duplicate task ids, inflated counts, wrong plant). Fixed by materializing plant **onto the order**:

- **`schema.sql`** now adds `orders.plant TEXT` + `idx_orders_plant` and backfills it from the
  line→plant mapping (idempotent, NULL-only).
- **`db.py`** reads `o.plant` directly and **no longer joins** `production_lines`; ingest sets
  `plant` from a `WERKS`/`PLANT` upload column when present, else derives it from the line mapping
  (post-upsert, scoped to the batch). Re-uploads keep an existing derived plant (`COALESCE`).
- **⚠ Deployment ordering:** the code references `o.plant`, so **`schema.sql` MUST be re-run**
  before this backend serves traffic, or `GET /tasks` errors on the missing column. (Consistent
  with how schema.sql already carries migrations.)

**Still open for true multi-plant (fast-follow, before line codes are reused across plants):**
- **Authoritative plant at ingest.** Today plant is line-derived when the upload omits it, which is
  only unambiguous while line codes are globally unique. Add a real source — a `PLANT`/`WERKS`
  column in the `sequence_testing` export (already read if present) **or** a plant picker in the
  upload UI applied to the whole file.
- **`make_id` collision.** Ids are `MD5(production_order|material_number)`, plant-independent. If the
  same `(production_order, material_number)` legitimately exists in two plants, ids collide; the
  id scheme must incorporate plant before that scenario is real.
- **Re-attribution.** A materialized `orders.plant` does not track later master-data changes the way
  the old per-request join did. Two cases: **(1)** an order uploaded *before* its line exists in master
  data gets `plant=NULL` and is invisible to the plant-scoped read path — now **self-healed by a
  re-derivation hook** that runs after any `production_lines` bulk change
  (`db.reattribute_null_plant_orders`, called from `POST /master-data/{table}/bulk`); lines added
  directly via `psql` (not the app) still need a `schema.sql` re-run to backfill. **(2)** re-uploading
  an order onto a *different line* now self-heals: the upsert resets `plant` to NULL when the line
  changed and no explicit plant was supplied, and the post-upsert derivation re-resolves it from the
  new line. **(3)** the one remaining gap — reassigning an existing *line* to a different *plant* in
  master data (the order's line is unchanged) — does not move already-attributed orders; a targeted
  re-derivation (compare stored plant vs the current line→plant mapping) or a re-upload would be needed.

---

## Addendum — Single-container "just get it running" pilot (DEPLOYED 2026-06-30)

> **LIVE:** `https://ca-nimbus-dev.delightfulwater-7252cdf0.eastus2.azurecontainerapps.io/`
>
> NIMBUS is deployed to **Azure Container Apps as a single container**: FastAPI serves both the JSON
> API **and** the static frontend (via a `StaticFiles` mount, same-origin), against Azure Postgres
> (`pgdb-nimbus-dev`/`nimbus`), with config as plain Container App env vars and **no SSO**. Resources
> in RG `rg-nimbus-dev` (region `eastus2`): ACR `acrnimbusdev`, Container App `ca-nimbus-dev`, env
> `cae-nimbus-dev`. This is the on-ramp, not the destination — simpler than the two-container model
> in Workstreams 2/6. Exact commands + ops gotchas live in **`DEPLOYMENT.md`**; the deferred-hardening
> items below remain the plan of record. **One schema fix was required during deploy:** `schema.sql`
> was missing the `orders.firming_indicator` column that `db.py` reads/writes (the tasks endpoint
> 500'd until it was added) — now fixed in `schema.sql`.

### How the pilot diverges from the runbook above
- **One container, not two.** FastAPI serves the frontend itself —
  `api.mount("/", StaticFiles(directory=NIMBUS_STATIC_DIR, html=True))` added as the **last** route
  in `brain.py` — instead of a separate `nginx` frontend. So the pilot has **no `/config.js`, no
  `nginx.conf`, no `docker-entrypoint.sh`, no reverse proxy** (WS2/WS6). Same-origin is achieved by
  the API serving the page directly; CORS is therefore vestigial (`NIMBUS_ALLOWED_ORIGINS=*`,
  `allow_credentials=False`).
- **`app.js:69` `API_BASE`** = `(typeof window !== 'undefined' && window.NIMBUS_API_BASE) || ''`.
  Empty string ⇒ same-origin relative calls. (WS1 specified a `localhost:8000` fallback for the
  nginx model; the single-container shape defaults to **relative** instead, and local dev runs as
  the same single-container shape — `uvicorn brain:api`, open `http://localhost:8000/`.)
- **Color paths** (`COLOR_FILE`/`COLOR_WHEEL_DIR`) are env-driven with the **current Windows path as
  the local-dev fallback** (so local dev is untouched with no `.env`), set to `/data/...` in the
  image. (WS1 specified `/app`-relative defaults; the local-fallback form is used to preserve the
  existing local workflow.)
- **Registry pull** uses the **ACR admin user** (simplest for a first-timer), not the UAMI (WS7).
- **Secrets** are **Container App secrets** (`--secrets pg-pass=…` + `secretref:`), not Key Vault (WS7).

### Deferred — where each item lives
| Deferred item | Status / home |
|---|---|
| **Color-wheel durability** — per-plant wheels + metadata are now **durable in the Postgres `color_wheel` table** (shipped 2026-07-07). Still ephemeral on `/data`: the **global** `COLOR_FILE` wheel (fix = bake into image) and the shared `_audit_log.json` (color-wheel + `optimization_run` events). Single-replica is still required for the in-process cache/log buffer (DEPLOYMENT.md), not for wheel durability. | **Workstream 5 DONE via Postgres** (not Azure Files). Global-wheel + audit-log durability remain follow-ups. |
| **Real authentication / login** — the pilot URL is **open to anyone who has it**. | **Workstream 3** (Entra SSO). Interim stopgap: `NIMBUS_API_KEY` (see audit-remediation addendum) — but it guards only destructive *admin* routes, **not** `/tasks` reads or task edits. |
| **Registry auth without a stored password** (ACR admin user → managed identity). | **Workstream 7** (UAMI + `AcrPull`). |
| **Postgres network hardening** (allow-Azure firewall → VNet / Private Endpoint). | **Workstream 7** item 4 + **Fork 2**. |
| **Rotate the committed Postgres password** (`Mavdob8808!` is in git history; current code reads `PG_PASS` from env, so this is a history/secret-hygiene task, not a code change). | **In-scope #8 / Fork 4** — do it regardless; use a fresh password as the pilot's `pg-pass` secret. |
| **Frontend CDN dependency** *(NEW — not previously tracked; see below)*. | New deferred item, documented below. |
| **Domain-oriented codebase refactor** — reorganize frontend + backend into per-domain folders with per-domain CLAUDE.md files (planned 2026-08-31, not executed). | **`docs/architecture/domain-refactor-plan.md`** — 13-domain map, full relocation tables, 6 green phases; its §9 also records the items it defers (nimbus-intelligence.js placement, styles.css decomposition, index.html inline `<style>` migration). |

### NEW deferred item — frontend CDN dependency
`index.html` loads several libraries from **public CDNs in the browser** (not bundled in the image):
vis-timeline, AG Grid, Chart.js, Flatpickr, and Google Fonts (unpkg / jsdelivr / fonts.googleapis.com).
Implications for a hosted plant pilot:
- End users' **browsers** need outbound internet to those CDNs (the container does not). On a
  locked-down corporate/plant network that blocks public CDNs, the UI breaks — unstyled page, no
  Gantt timeline, no orders grid.
- **Status (updated 2026-10-05):** the CDN `<script>`/`<link>` tags in `frontend/index.html` now carry
  Subresource-Integrity hashes (`integrity=` + `crossorigin="anonymous"`); the Google Fonts stylesheet
  cannot take SRI (Google varies it per user agent). A **report-only** Content-Security-Policy
  (`Content-Security-Policy-Report-Only`, set by `brain.py`'s `csp_report_only_mw` on HTML responses
  only) is live and nothing is blocked: the ~100 static inline `on*=` handlers still violate
  `script-src` (deliberately no `'unsafe-inline'`), and that report stream is the work list for
  enforcing. Browsers POST violations to the unauthenticated `POST /logs/csp-report`
  (`backend/admin_ops/routes.py`): body capped at 16 KB by the body-cap middleware (413; 411 without a
  Content-Length), at most 10 reports per request, **de-duplicated** by (directive, blocked-uri,
  source-file, line) with a counter (a repeat is logged only at its 10th/100th/1000th... occurrence,
  with `occurrences`) and **rate-limited** to 20 distinct reports/minute per process (drops are
  summarised in one `csp.rate_limited` entry), so a report flood cannot evict real errors from the
  2,000-entry `_BACKEND_LOG` ring. Both the dedupe table and the rate window are per-process state.
- **Still deferred:** vendoring the libraries into the repo (served by the existing `StaticFiles`
  mount) or fronting them with an approved internal mirror, and moving the policy from report-only to
  enforcing once the inline handlers are gone. **Decide before any network-restricted plant rollout.**

---

## Workstream — SAP Interface (deferred hardening)

> The SAP→NIMBUS sync engine (`sap_sync.py`, the Admin "Interface" sub-tab, and the
> `sap_sync_config` / `sap_sync_run` / `sap_field_map` tables) ships as a **non-live skeleton** —
> connectors are stubs, the in-process scheduler is **disabled by default**, and no real SAP
> transport is wired. The items below must be resolved **before** any production SAP pull goes live.
>
> **SAP staging (2026-10-07, `feature/sap-staging`)** is the path that is built for real: Mulesoft
> writes snapshots into `sap_stage_*` Postgres tables and NIMBUS validates/applies them under admin
> control (`docs/SAP_STAGING_DESIGN.md`, contract in `docs/NIMBUS_INTERFACE_ARCHITECTURE.md`
> section 7, runbook in `docs/DEPLOYMENT.md`). Its open items are the next four bullets and the two
> lists after the hardening bullets.

- **SAP credentials → Azure Key Vault.** SAP service-account creds (and any RFC/OData secrets) come
  from **env only** and must be sourced from Key Vault (per Workstream 7) — **never** in code, the
  Interface UI, DB seeds, or logs. Treat them like `pg-pass`.
- **Private network path required before any pull transport.** No SAP pull (OData or RFC) may run
  over the public internet — a private path (**VPN / ExpressRoute / SAP Cloud Connector**) must be in
  place first. This is gated by the same VNet/Private-Endpoint hardening tracked in Workstream 7 /
  Fork 2.
- **PyRFC + SAP NW RFC SDK bundling.** If the **RFC** transport is chosen (vs. OData), `PyRFC` and the
  proprietary **SAP NetWeaver RFC SDK** must be bundled into the `Dockerfile` (the SDK is a licensed
  native dependency, not a pip wheel — it needs explicit copy + `LD_LIBRARY_PATH` wiring). OData
  needs no native SDK.
- **Multi-replica scheduler safety.** The in-process APScheduler is only safe today because the pilot
  runs **single-replica**. Before scaling past one replica, `sap_sync.sync_object` must be guarded by
  a **`pg_try_advisory_lock`** so only one replica runs a given sync at a time (otherwise every
  replica fires the same scheduled pull concurrently).
- **Classification extraction performance.** Deriving `COLOR` / `FORM_SIZE` classification must be
  resolved **server-side in SAP** (in the extractor / CDS view), not by post-hoc parsing in NIMBUS —
  per-row classification on the NIMBUS side does not scale to the production order volume.

### SAP staging — deferred items (2026-10-07)

- **Live "data changed" banner for open planner sessions (D35).** An applied batch (including
  vanish deletions) reaches an open Gantt session only on its next save or reload; the server version
  wins and the existing stale toast fires. A push or poll-driven "data changed, refresh" banner is
  deferred.
- **Multi-replica safety beyond the poll lock.** `poll_once` and each batch apply take advisory
  locks (`sap:staging-poll`, `sap:apply:<batch>`), but the per-object cron jobs (`sap_sync.sync_object`)
  still have no lock, the color-wheel cache and log ring buffer are per process, and staging has only
  been exercised single replica.
- **Dry-run apply for planned orders.** `db.upsert_orders` has no plan-only mode, so an admin cannot
  preview exactly which orders an apply would insert or update (the deletion list is previewable;
  inserts and updates are not). Needs a plan-only path through the shared upsert.
- **Retention knobs.** The retention windows are constants in `sap_staging.py` (archive 30 days,
  outbound `sent` rows 30 days, rejected/discarded/superseded batches 7 days, latest applied batch
  per object and plant only); making them configurable is deferred.
- **Owed by others before go-live:** SAP field names for the two routing tables (SAP Development,
  follow-up rename migration); the FSD change request adding Material Description to the Material
  Plant export (until then new materials have blank descriptions); the SAP system time zone for
  `NIMBUS_SAP_SYSTEM_TZ`; Mulesoft runtime location, egress IPs, TLS and per-row write-back
  capability, and the role password (integration team / Basis); confirmation that SAP accepts
  unpadded material and order numbers or that Mulesoft pads them.
- **Hardening now also covers the Mulesoft login.** The public Postgres endpoint with the allow-all-Azure
  rule and the app connecting as the server admin (`TempAdmin`) are already tracked above (Workstream 7
  item 4 / Fork 2, and the `TempAdmin` rotation in `docs/DEPLOYMENT.md`). The `nimbus_mulesoft` role
  is a second login on that surface (least privilege, TLS required, firewall to its egress IPs, see
  `docs/DEPLOYMENT.md`); private networking, a Key Vault secret for its password and rotating both
  logins close the same gap.
- **Staging schema additions (migrations dated 2026-10-08).** `migrations/2026-10-08-sap-staging-tables.sql` (the `sap_stage_*` tables, the outbound queue, the archive and the side table `order_sap_sent`) and `migrations/2026-10-08-sap-staging-columns.sql` (`sap_sync_config.apply_mode`, and the nullable `TIMESTAMPTZ` columns `material_plants.sap_missing_since` and `production_version.sap_missing_since`, stamped when a snapshot omits a row that something still references). Both trip the runner's destructive filter and need `-AllowDestructive` (runner-wide; dry run first, see `docs/DEPLOYMENT.md`). Apply them before the image that reads `order_sap_sent` rolls.
- **Open items from the 2026-10-07 validation (owner decisions; `docs/SAP_STAGING_VALIDATION_PLAN.md` section 12):**
  - **A killed apply is not resumed by the poll.** A batch left `applying` (or `error`) stays there until an admin presses Apply; the poll visits only `ready` / `validated` batches. Options: let the poll resume when the apply lock is free, or alert when a batch has been `applying` longer than a set time (recommended: alert first, auto-resume later).
  - **Plant-scoped admins cannot use staging at all.** Every `/sap/staging/*` route needs the `admin` role, which sees all plants, so a per-plant staging admin does not exist. Keep it global-admin only for the pilot (recommended) or add a plant-scoped permission.
  - **Advisory-lock residual.** Any database login can take advisory locks, so a leaked Mulesoft session could hold `hashtext('sap:staging-poll')` and make the poll skip until it ends. Mitigated by `CONNECTION LIMIT 10` and `pg_terminate_backend`; a code fix is deferred.
  - **`GET /sap/staging/batches/{id}/deletions` is uncapped for planned orders** (low; bounded by one plant's in-horizon orders, about 2.6 MB at 10,000).
  - **71 older connector UI keys exist only in English** in de / es / fr / pt (low; a translation pass).
  - **Blank firming indicator semantics** (open confirmation with the integration team): NIMBUS sends a blank for "not firm" and never un-firms; SAP's import must treat blank as "leave as is".
- **Known limits from the review round (documented, not fixed):**
  - `POST /sap/staging/poll` is global, not plant-scoped: a plant-restricted admin triggers validation/auto-apply for every plant (it would have run on the timer anyway).
  - The upload route's size check (413) runs after the file body is read, matching the existing `/upload` and `/bom/upload` routes.
  - A plant with no `timezone` gets no SAP-zone conversion in either direction (both sides stay consistent, no warning).
  - Requeueing outbound rows can race a Mulesoft read, so Mulesoft may send both queues; SAP last-write-wins makes it benign.
  - The midnight-echo acceptance compares dates in the plant frame; a sent finish that crosses midnight when converted into the SAP zone (e.g. 19:00 Chicago to 00:00 UTC next day) is not recognised as an echo and causes one unnecessary re-plan for that order. Fix would need the plant timezone inside `sap_changed_fields`; deferred.

### SAP sync skeleton — discrepancies found while building staging (not fixed)

Verified against `backend/integration/sap_sync.py` and `frontend/integration/sap-interface-ui.mts`:

- **The sync watermark never advances.** `update_watermark()` has no caller, and `sync_object` writes
  `watermark_after = watermark_before`, so delta pulls could never resume from the last run.
- **No `sap_sync_config` seed for `sap_workcenter`.** The catalog has the `sap_workcenter` master
  object but `migrations/2026-06-30-sap-interface.sql` seeds config rows only for the other six
  objects (the staging migration seeds its four).
- **The Interface tab's `MASTER_KEYS` lacks `sap_workcenter`**, so the key-column save guard does not
  cover that object.
- **`rows_failed` is always 0.** It is read from `db.upsert_orders`'s result `failed` key, which that
  function never returns, and master-data syncs never set it.
- **`_t_alpha` is misnamed.** It does no ALPHA (zero-pad/strip) conversion, only `db._str_id` (Excel
  float-suffix strip); the new `alpha_strip` transform is the one that strips leading zeros.

---

## Calendar/blackout persistence — deferred hardening (post-review, 2026-07-01)

The calendar-persistence feature (`/plant-calendar/*`) shipped and a persistence-architect review
remediated the correctness/integration findings inline. Three items are **deliberately deferred**
here because they are at-scale/multi-user hardening or product decisions, not pilot-blocking bugs.

- **Line-calendar optimistic concurrency (F9 — full fix).** Working-hours writes are last-writer-wins
  (`ON CONFLICT DO UPDATE`, no `base_version`/`xmin` token), unlike the orders path. The shipped
  mitigation only re-POSTs the lines a plant-hours clamp actually changed, so a concurrent
  single-line edit that still fits the new plant window is not clobbered. The **complete** fix is to
  carry the `line_calendar` row `xmin` on read and enforce it on write (mirror the orders
  optimistic-concurrency protocol), returning a `stale` list the frontend reconciles. Required before
  many schedulers edit the same plant's calendars concurrently.
- **Subnetwork-aware calendar writes (F10).** `_resolve_subnetwork` resolves a plant→subnetwork
  server-side and assumes plant codes are globally unique (`ensure_unique_plant` adds `UNIQUE(plant)`).
  The `plants` PK is `(subnetwork, plant)`, so a plant code **can** legally recur across subnetworks at
  the 50+ plant target. When that happens `ensure_unique_plant` skips the constraint (now logged
  loudly + `admin_audit`), and every calendar/blackout POST for the ambiguous plant 400s (calendar
  persistence silently disabled for it). Full fix: send `subnetwork` on the write path (the frontend
  already knows it from `Store.masterData`) and scope `_resolve_subnetwork` / the UPDATE by it, instead
  of relying on global plant uniqueness.
- **Gantt bar-width vs. explicit resize (F12 — product decision).** `db.py._EFF_END_SQL` derives the
  Gantt bar width as `scheduled_start + run_time` (intentional: bar width must always represent
  run-time, since stored SAP `scheduled_end` durations rarely match). A user's **edge-resize** (drag
  the right edge to a duration ≠ run_time) persists `scheduled_end` but silently reverts to a
  run-time-wide bar on reload. Decide one of: (a) honor an explicit user resize (distinguish a
  user-set `scheduled_end` from the SAP window and prefer it in the read), or (b) lock the timeline to
  move-only so the UI never lets the user create a width the reload discards. Left intact pending the
  ruling — do **not** silently change `_EFF_END_SQL` (it would revert the deliberate run-time
  normalization for SAP orders).

## Optimizer — deferred enhancements (post-review, 2026-07-03)

An expert review of the three optimize modes (SPT / Min Changeover / Smart) led to `Engine.runAndApply`
routing `'changeover'` and `'combined'` through a new day-integrity dispatch (`Engine._dispatchDayIntegrity`
— see `CLAUDE.md` Key Patterns). Several further improvements were identified and explicitly **declined for
this round** by the product owner — recorded here so they aren't silently forgotten, not because they're
blocked on anything technical:

- **Sequence-dependent setup-time modeling.** Changeovers are currently a sort key and a KPI count only —
  reducing them doesn't free any actual capacity, since no time is charged for a color/form switch between
  adjacent orders. A per-plant scalar (e.g. N minutes for a color change, M minutes for a form change,
  editable in the existing `plants.constraints` JSONB pane) would let changeover reduction genuinely
  shrink schedules. A full color-to-color cost matrix is the more accurate but heavier alternative (needs a
  new data table + someone to maintain it per plant). Until this exists, "minimize changeovers" is a
  proxy metric, not a capacity lever.
- **Release-date floor on pull-forward.** The optimizer will pull an order as early as any line slack
  allows, with no check against `ORIGINAL_START_DATE` (the SAP-planned release/material-availability date).
  Explicitly declined this round ("no cap") — revisit if planners report orders being pulled ahead of when
  components are actually available.
- **Auto-pin protections.** Today the only order the optimizer won't move is one a planner has manually
  pinned (`Store.isFixed`). Declined this round, all still on the table: (a) auto-pin an order that's
  already in progress (start in the past, end in the future — physically on the line); (b) auto-pin
  SAP-firmed orders (`FIRMING_INDICATOR`/FIXKZ is already ingested into every order and currently read
  nowhere in the optimizer); (c) a "frozen fence" — an Optimize-dialog setting that protects the next N
  hours on a line from re-sequencing, for run-to-run stability near the current time.
- **Cross-line rebalancing.** All three modes are strictly per-line — an overloaded line's overflow can
  only push to a later day on the *same* line, never move to a sister line with spare capacity. Blocked on
  data, not design: NIMBUS has no material→line eligibility mapping today (which lines can legally run a
  given material/form), so the optimizer cannot know which lines are valid alternates for a given order.
- **Labor-plan capacity integration.** `labor_plan_line.avail_hours` (the Labor Planning subsystem) is
  never consulted by `Engine.runAndApply` — the optimizer only respects the `Calendar` working-hours/
  blackout capacity model, not a line's planned headcount-derived capacity. Folding the two together would
  let a labor shortage day behave like a partial closure to the dispatcher instead of a silent overcommit.
- **Setup-time-aware carryover across days.** Once setup time (above) is modeled, a day-integrity dispatch
  could also prefer ending a day on the same color/form it opens the next day with, to avoid a changeover
  that straddles midnight for no schedule-quality reason. Not meaningful to build before setup time itself
  exists.

### Sequence-dependent setup is now designed (2026-08-11) — see `docs/changeover_matrix.md`

The first bullet above ("Sequence-dependent setup-time modeling") has moved from *declined* to
*designed but not implemented*. `docs/changeover_matrix.md` is the agreed design and staged migration
plan; it chose the "full cost matrix" alternative over the per-plant scalar, but keyed on **attribute
signatures** (an ordered subset of `master_data.RANKABLE_FIELDS` — `prt01`/`prt02`/`colorWheel`, chosen
per plant) rather than on materials, which is what keeps the matrix populatable at enterprise scale.
Three consequences worth knowing here rather than only in that doc:

- **It rewrites `Engine._dispatchDayIntegrity`.** Phase 2's justifying invariant — "total duration is
  order-independent" — is false once cost depends on adjacency, so admission and sequencing must merge
  into a single cost-aware pass. This is the change that finally touches that 252-line body.
- **It supersedes the `'changeover'` vs `'combined'` mode distinction**, which today is *only* a tier-2
  ranking difference and is really a policy question in disguise (how much lateness may be traded for
  setup savings). It becomes three named per-plant presets, defaulting to one that cannot make any
  schedule later than today's engine would.
- **The "setup-time-aware carryover across days" bullet above is partly answered and partly widened.**
  The design attributes a transition block to its *successor*, which makes each day computable
  left-to-right; but whether a changeover may straddle a shift close, or must run contiguously, is
  explicitly deferred and blocks making the setup/teardown split anything other than presentational.

Newly deferred by that design, recorded here so they aren't lost:

- **Crew/labor constraints on changeover.** A changeover consumes people, and `labor_plan_line` already
  exists. Narrower than (and complementary to) the "Labor-plan capacity integration" bullet above:
  that one is about a line's *run* capacity, this is about whether the changeover itself is staffed.
- **Material-pair exception rows.** The matrix schema carries a `key_kind` discriminator so a specific
  material pair can override its signature pair, for costs no attribute set explains. Designed for,
  not built.
- **Sequence-dependent run *rate*** (as opposed to setup) — the same material may run slower after
  certain predecessors. Not modeled, not designed.

## Timezone save corruption (fixed 2026-07-07)

**The code path is fixed; historical rows saved before the fix may be shifted.**

*The bug:* `saveAll`'s task payload serialized `start_date`/`end_date` as raw `Date` objects, so
`JSON.stringify` emitted `toISOString()` UTC (`…Z`) strings. The backend stored the UTC clock digits
naively, and the orders read path emits **bare** `strftime` (no `Z`), which the frontend `new Date()`
parses as **local** — so a save→reload round-trip shifted every task's start/end by the saving client's
UTC offset (e.g. +4/+5 h for US Eastern). Silent, and on the primary save path.

*The fix:* `saveAll` now routes `start_date`/`end_date` through `Util.toLocalSeconds` (naive-local, no `Z`),
mirroring the already-correct `_relayDueDateCorrections` path. `brain.py:_to_pydt` then parses tz-naive and
stores the local clock digits verbatim, round-tripping correctly. The blackout/plant-calendar path is a
**separate, self-consistent UTC scheme** (`_blockPayload` sends `toISOString()`, `master_data.py:_parse_ts`
parses Z-aware, the read path re-appends `Z`) and was deliberately left unchanged — do not unify the two.

*Historical exposure (deferred, needs a decision):* rows persisted before this fix by a non-UTC client are
already shifted by that client's offset. There is **no reliable per-row offset to invert** (the offset
wasn't recorded), so an automatic backfill is unsafe. A bulk correction would have to assume a single site
offset (e.g. all edits made in US Eastern) and be run as a **separate, explicitly-approved one-off
migration** against a backup — not folded into `schema.sql`. Until then, treat pre-2026-07-07 scheduled
times as potentially offset for any non-UTC editor.

## Schema migration ledger — ×1440 horizon landmine (fixed 2026-07-07)

**`schema.sql` is now safe to re-apply.** Previously it re-ran an unguarded
`UPDATE plants SET *_horizon = *_horizon * 1440 WHERE *_horizon <= 365` on **every** apply,
silently re-multiplying any legitimate sub-365-**minute** horizon edit into garbage (e.g. a 300-min
horizon → 432000). This is the "×1440 landmine" and was the gating fix before revisiting prod promotion.

*The fix:* a new `schema_migrations (id, applied_at)` ledger table records one-time, data-mutating
migrations so they never re-run. The horizon conversion is recorded as `plants_horizon_minutes` and is
**no longer executed on apply** — because every live DB was converted long ago (the old UPDATE ran on
every apply), so their values are already minutes, and re-running risks corrupting a current sub-365
value (the conversion is ambiguous by value alone: a small number could be a day-count to convert or an
already-correct minute value). Going forward, **any data-mutating statement belongs in a ledger-guarded
block, never as a bare UPDATE in `schema.sql`** — this mirrors the `promote-azure` skill's migration-ledger
model (never hand-mutate prod outside that flow).

*One-off restore case:* the only scenario that could still need the conversion is restoring from a
**pre-minutes (day-valued) dump**. Handle it as an explicit, backup-first one-off — run the two
`UPDATE ... * 1440 WHERE ... <= 365` statements once (preserved in the `schema.sql` comment), then
`INSERT INTO schema_migrations (id) VALUES ('plants_horizon_minutes')` so it never repeats.

### The inverse ledger trap — a general pattern (2026-08-11)

The ×1440 landmine above is a ledger-guarded step running **too often** (unguarded, so it re-ran
forever and corrupted data). There is a mirror-image failure mode: a ledger-guarded step that runs
**too early** — before the data it depends on exists — records itself applied and then **never runs
again**, even after the dependency shows up. Both are "the ledger and reality disagree," just in
opposite directions; both are worth checking for whenever a new guarded migration step is added.

Concrete instance: `migrations/2026-08-11-priority-lists.sql`'s `orders_mp_attrs_backfill` step
copies `material_plants.{color,prt_01,prt_02,default_production_version}` onto matching `orders`
rows. If it runs on a fresh/empty `material_plants` (a new plant onboarding, or an environment
provisioned before master data was loaded), it finds no matches, does nothing useful, and still
records `orders_mp_attrs_backfill` as applied — a re-apply of `schema.sql` after `material_plants`
is finally populated will **not** retroactively fix those orders, because the ledger says it already
ran. This is why that step is documented (in `schema.sql` and the migration file itself) as
**convenience only** — the real mechanism is `POST /master-data/resync-order-attributes`
(`db._stamp_order_attributes`, called with a plant rather than a batch), which has no ledger gate and
can be re-run any time master data changes. See `docs/scheduling_priority.md`'s R3 finding for the
full writeup, and `tests/test_priority_lists.py::TestStampOrderAttributesAndTheInverseLedgerTrap` for
the regression test.

**Rule of thumb going forward:** if a ledger-guarded `schema.sql` step's correctness depends on
another table already being populated, either (a) provide a live, ungated resync path as the actual
mechanism and label the guarded step convenience-only (as here), or (b) make the step's effect
naturally re-appliable without the ledger at all (a `WHERE col IS NULL`-style backfill, like
`orders.plant`'s NULL-only backfill just above it in `schema.sql`, which is safe to leave unguarded
because re-running it only ever fills in newly-NULL rows).

## pandas 3 `NaN` handling in xlsx ingest — a general landmine (found 2026-08-10)

`requirements.txt` pins `pandas==3.0.3`. Under pandas 3, `Series.astype(str)` on a column with
missing values no longer stringifies them to the literal `"nan"` the way pandas 2 did — they survive
as an actual float `NaN`, which then crashes the next `.lower()`/`.upper()` call and breaks JSON
serialization downstream (`allow_nan=False`). This surfaced as four separate crash bugs during
`docs/scheduling_priority.md` Stage 2's upload-parsing work: blank `LINE`/`PLANT` cells producing
500s, and a stray `NaN` surviving into a `needs_mapping` column-sample payload doing the same. All
four were fixed with the same pattern, applied throughout the new upload-parsing code in
`brain.py`: **call `.fillna("")` before `.astype(str)`, never after.**

**Not specific to priority lists** — this is a landmine for any future code that parses an uploaded
`.xlsx` with `pandas` (a new upload endpoint, SAP sync's eventual real connectors, anything touching
`pandas.read_excel` output). Copying an older, pandas-2-era `.astype(str)`-then-clean snippet will
silently reintroduce these crashes; check the ordering explicitly instead.

## Admin-gated and plant-scoped fetches must use `Util.fetchTraced`, never bare `fetch()` (found 2026-08-10)

A production-breaking bug in `docs/scheduling_priority.md` Stage 2's new Optimization tab:
`_fetchAndRenderOptimization` (`web/plant-and-administration.mts`) called bare `fetch()` against
`GET /master-data/{plant}/missing-master-data`, an admin-gated, plant-scoped endpoint. Bare `fetch()`
carries no identity header, so locally — where auth is effectively disabled — it worked fine, but on
the Azure pilot, where identity actually determines access, the missing-master-data panel and its
Resync Now button would have silently never rendered for a real admin user; worse, a plant-restricted
user's request would have been evaluated as unrestricted instead of scoped to their allowed plants.
Fixed by switching to `Util.fetchTraced`, which attaches the identity header (see `CLAUDE.md`/
`AGENTS.md` → Architecture → Frontend, `Util` row of the module layer table).

**General rule, not specific to this feature:** any new fetch against an admin-gated or plant-scoped
endpoint must go through `Util.fetchTraced`, never bare `fetch()`. The failure mode — works locally
with no auth, silently breaks or mis-scopes once real users/roles exist — is easy to miss in local
dev and easy to reintroduce in a future feature that copies an older snippet using bare `fetch()`.

## Changeover Matrix Stage 0 — apply and rollback (2026-08-13)

Stage 0 adds observation-only setup truth: versioned definitions, matrix rows, physical line state,
and occurrence overrides. It does **not** charge setup time, change order dates, or enable a
setup-aware optimizer.

1. Back up the target database and confirm it is the intended environment.
2. Apply `migrations/2026-08-13-changeover-matrix-stage-0.sql`, then deploy the matching backend
   and static frontend together. The same additive DDL is mirrored in `schema.sql`, so a normal
   idempotent `schema.sql` application is also sufficient for a fresh environment.
3. Verify `GET /setup/{plant}` for an authorized plant before importing a definition or matrix.
   Definitions/matrix rows are versioned; changing the definition intentionally deactivates setup
   activation and makes prior-version rows historical rather than rewriting them.

Rollback is data-preserving by default: disable the setup editor/activation path and redeploy the
previous application version; production schedules are unaffected because Stage 0 never persisted
setup pseudo-orders or changed order dates. Do not drop the four setup tables as an operational
rollback step—they contain audit-worthy matrix/state/override truth. A destructive schema rollback,
if ever required, must be a separately reviewed backup-restoration decision.

## Multi-user real-time sync (planned)

A design for near-real-time (seconds) freshness across concurrent schedulers on the same plant was
brainstormed and approved 2026-07-07, alongside a Phase 0 render-perf fix (batching `Timeline.patchLoop`).
Full spec: **`docs/superpowers/specs/2026-07-07-multi-user-sync-design.md`**. This is a pointer/index
entry only — see the spec for the full architecture.

- **Phase 1 — write-through autosave.** Both prerequisites are now **fixed**: (1) the **TZ corruption
  hard blocker** (see "Timezone save corruption" below) — `saveAll` sends naive-local strings, so
  write-through no longer corrupts on every drag; and (2) the **partial-save dirty-id-clearing bug** —
  `saveAll` now clears only the ids the backend actually accounted for (persisted `versions`, `stale`,
  and the terminally-rejected `invalid_ids`/`not_found_ids`), instead of `.clear()`-ing both sets
  unconditionally, so genuinely-unpersisted rows stay dirty and retry. The final piece of (2) landed
  2026-07-28: the `/tasks/update` + `/tasks/bulk_update` endpoints now actually forward
  `invalid_ids`/`not_found_ids` (they previously sent only counts, so terminally-rejected ids never
  cleared and re-warned every save). What remains for Phase 1 is the net-new work itself: adding a
  dirty-tasks-only backend leg to the existing 1.2 s autosave debounce.
- **Phase 2 — change feed.** A `schedule_events` table (append-only, cursor `id`, plant-scoped) written
  in the same transaction as task/order/calendar writes; `GET /changes?plant=&since=&client=` cursor-polled
  every ~3 s by a new frontend `Sync` module, applied via `Store.applyRemote` without dirty-marking
  (skips locally-dirty ids to avoid yanking a mid-drag edit).
- **Phase 3 — presence & attribution.** Heartbeat-based who's-here presence (piggybacked on the poll),
  "moved by X" flash on remote-applied changes, and an attribution banner on remote optimizer runs.
- **Future (not yet planned):** swap cursor polling for an SSE transport if proxy constraints ease
  (today all users sit behind a corp proxy that mangles streaming responses — memory:
  nimbus-deploy-verify-http-cache); soft per-line claims if collision friction remains after Phase 3.
# Setup policy activation and rollback

Stage 2 setup policies are stored per plant in `plants.setup_policy_config` and
default to disabled. Do not enable Due-date first, Min Changeover, or Throughput
until a safe-local database migration has been verified, null-predecessor
override persistence is fixed, representative-plant performance/browser UAT is
recorded, and scheduling owners approve the configured savings/slip limits.

To roll back, set all three `*Enabled` fields to `false` through the
plant-scoped setup policy endpoint. This prevents new setup-aware policy runs;
it intentionally does not alter existing orders, derived setup bars, setup
truth, diagnostics, or alerts.

**2026-08-14 evidence status:** policy controls and detached threshold checks
are implemented, but activation remains blocked. The current environment is
configured for Azure PostgreSQL, so it is not a valid local DB verification
target; browser/performance UAT, representative-plant replay, owner approval,
and null-predecessor override persistence are also outstanding. Do not deploy
or enable policies based on automated checks alone.

## Setup Matrix List view — known limitations / follow-up (2026-08-17)

The Setup Matrix's **List view** (default view as of the `feature/setup-matrix-and-optimizer-preview`
branch; `SetupAdmin` in `web/plant-and-administration.mts`, backed by
`GET /setup/{plant}/matrix-rows` → `setup_data.page_matrix_rows`) shipped with three known
scalability gaps. All three were found in the branch's final review, and all three were
**deliberately deferred** rather than fixed in that wave: none is a correctness bug at today's
prototype scale (single-digit plants, ~5 lines, a handful of signature values per axis), and fixing
them properly is a scoped effort of its own — server-side pagination with a pushed-down SQL
`LIMIT`/`OFFSET`, a paging UI, and a memoized state-resolution cache.

They become real when a plant approaches the **Production Scale Roadmap** target in `CLAUDE.md`
(50+ plants, 70+ lines per plant, ~1,600 states per signature axis — i.e. ~2.5 M possible pairs per
plant/version). Treat this section as the follow-up ticket's scope.

1. **Pagination is plumbed but has no UI, and the merge order can make line-only overrides
   unreachable.** `_listMeta.offset` exists and is sent to the endpoint, but no next/prev control
   was ever wired, so the List view only ever shows page 0 (`limit` 50). Worse,
   `page_matrix_rows` merges plant-default rows first and *appends* line-only rows afterwards
   (`setup_data.py`, the `merged` dict build) — dict insertion order is the page order, so once a
   plant has more than one page of plant-default rows, a line's own overrides on pairs the plant has
   no default for sort past the end of page 0 and become unreachable from the UI entirely.
   *Fix direction:* deterministic server-side ordering that does not depend on the merge sequence
   (order by `from_key, to_key` across the merged set), plus a real paging control. Note the axis
   ordering must stay stable across pages or paging will duplicate/skip rows.

2. **`page_matrix_rows` has no SQL-level `LIMIT`/`OFFSET` despite its docstring claiming
   "bounded".** It is bounded only by `plant`/`signature_version`/`line IN ('', :line)` — it fetches
   **every** matching row for that scope and slices in Python (`rows[offset:offset + limit]`). At
   1,600 states per axis that is a multi-million-row fetch per keystroke-triggered refetch. The
   `from_key` filter is the only genuinely narrow path today.
   *Fix direction:* push the merge into SQL (e.g. `DISTINCT ON (from_key, to_key)` with
   `ORDER BY from_key, to_key, line DESC` so the line row wins, plus a `LEFT JOIN`/window to carry
   the plant default through as `plant_value`) so `LIMIT`/`OFFSET` can go into the query. `meta.total`
   then needs its own bounded `COUNT` — it must stay the **post-merge effective** count, which
   `tests/test_setup_data.py::test_page_matrix_rows_pages_over_the_post_merge_effective_rows` pins.

3. **`resolveFromKey` rebuilds the full cartesian state list on every call, and the mass-upload
   validator revalidates on every keystroke with no debounce.** `resolveFromKey`
   (`web/plant-and-administration.mts`) calls `fieldValueSet` per definition field and then
   `cartesianStates` over the product, unmemoized — and it is called once per List-view render, once
   per "Add pair" draft-row status refresh, and **twice per pasted row** in
   `parseMassUploadText`. The mass-upload modal's `revalidate()` is bound to the textarea's `input`
   event with no debounce, so a real paste of a few thousand rows against a large signature will
   stall the main thread.
   *Fix direction:* memoize the resolved state lookup on
   `(definition.fields, _lineScope, Store.priorityRankMaps revision)` and build a `sig → key` map
   once per validation pass instead of scanning candidates per row; debounce `revalidate()`
   (~150 ms) and/or move validation off the paste path onto an explicit "Validate" step.

Not deferred, and already fixed in the same review wave (recorded here so the follow-up does not
re-litigate them): the Optimizer-Preview → "Fill these in the Setup Matrix" hand-off now forces the
Matrix view (the review/highlight affordance lives only in `paintGrid`), the "Hide states with no
value" filter and the clear-an-override path now test the row's **effective** `setup_min` rather
than `plant_value`, the "From" box narrows the displayed page by substring, and `_listNewRows` is
cleared on both Save and Discard.

## Optimizer-speedup whole-branch review — deferred follow-ups (2026-08-22)

Three items surfaced by the final whole-branch review of the optimizer-speedup effort
(`docs/architecture/optimizer-dispatch.md` → "Search controls") that were deliberately **not** built
in that fix wave. The worker item shipped in the 2026-09-10 optimizer remediation; the remaining
historical note is retained here so it is not silently forgotten.

- **Worker offload of the pure setup-aware evaluator (resolved 2026-09-10).**
  `frontend/optimization/optimizer-worker.mts` now runs the detached
  (`evaluateDueDateFirst`/`evaluateSptWithSetup`/`evaluateMinChangeover`/`evaluateThroughput`) path
  in a cancellable Worker. The client sends the remaining primary budget, and the worker localizes its
  own monotonic deadline before evaluating. Synchronous evaluation remains available for tests and
  non-UI callers; apply-time validation uses the serialized detached snapshot and effective firming
  context returned with each candidate.
- **Duplicate unknown-state diagnostics when a trailing search has no winner (pre-existing, reproducible
  on `main`, not introduced by this branch).** In both `evaluateLineWithFixedBoundaries` and
  `evaluateLineWithFixedBoundariesSpt`, when the fragment's final `trailing` search
  (`searchFragment(..., { start: fragmentStart, end: bounds.horizonEnd, ... })`) produces no winner, the
  `!trailing.winner` branch does two things with the *same* set of unresolved orders: it pushes
  `trailing.missingEdges` verbatim into the run's `missingEdges` array, **and** folds those same orders
  into `remaining`/`tailTasks`, which then goes through `applyUnknownTail` a few lines later —
  `applyUnknownTail` pushes its *own* diagnostics (e.g. `'initial-state-unknown'`) for the same orders into
  that same `missingEdges` array. The net effect: an order whose state genuinely can't be resolved gets
  counted/reported twice in the run's diagnostics (and, downstream, potentially double-counted in the
  OptimizerPreview missing-pairs tally or the live-run "orders scheduled without setup data" toast).
  Reproduce by driving `evaluateDueDateFirst`/`evaluateSptWithSetup` with a fixed boundary whose trailing
  fragment contains an order with an unresolvable signature and confirm `missingEdges` (or the exported
  `SearchDiagnostics`) carries that order's edge more than once. *Fix direction:* de-duplicate by
  `(line, predecessorOrderId, successorOrderId, reason)` before appending, the same shape
  `appendRejectedCoverageDiagnostics` already uses elsewhere, or skip the raw `trailing.missingEdges` push
  entirely when every one of those orders is about to be re-diagnosed via the tail placement anyway.
- **Boundary-fallback branch is currently unreachable — needs an integration test if `supportsBoundaryFallback`'s
  reason allowlist is ever widened.** `supportsBoundaryFallback(run)` (setup-scheduler.mts) only returns
  true when every one of `run.missingEdges` has reason `UNCOVERED_SETUP_TRANSITION_REASON` or
  `'incoming-fixed-setup-infeasible'` — but the branch that consumes it
  (`if (!winner && run.termination === 'completed' && supportsBoundaryFallback(run))`) requires
  `run.winner === null`, which the code comment above `isSearchConclusive` documents as **provably
  unreachable under current `candidateForSequence` semantics**: a completed search with a nonempty
  `missingEdges` restricted to those two reasons always produces a winner today, so the fallback path is
  dead code in practice, only reachable through the unit tests that construct a `SearchRun` directly
  (`tests/modules/setup-scheduler.test.mjs`) rather than through the public `evaluateDueDateFirst`/
  `evaluateSptWithSetup` API end-to-end. This is fine as long as it stays true — but if
  `supportsBoundaryFallback`'s reason allowlist is ever widened (e.g. to admit another "safe to reroute"
  missing-edge reason), whoever does that widening must also add an end-to-end integration test that
  drives the branch through the public API, not just a direct `SearchRun` unit test, since a reachability
  assumption this specific is exactly the kind of thing a future change can invalidate without anyone
  noticing.

## Optimizer `_setupExclusions` scoping — deferred fix (2026-09-11, N8b)

**Optimizer `_setupExclusions` is run-scoped and last-write-wins across losing candidates**
(2026-09-11, N8b): a task refused under `excludeFromSearch` in a losing arrangement keeps its
exclusion in the winner, so `placeUnknownTail` skips it and it can be queued with
`setup_transition_unrecorded` when the winning arrangement would have placed it. Fix: per-candidate
exclusion map merged on the winner. Only affects plants that opt into `excludeFromSearch`.

## Domain refactor — deferred backend data-layer split (2026-08-31)

The domain refactor plan (`docs/architecture/domain-refactor-plan.md`, v2) deliberately scopes the
backend phase to a **routes-only split**: `brain.py` becomes a thin assembly over nine
`backend/<domain>/routes.py` routers, four whole modules move (`setup_data.py`, `auth.py`,
`admin_tables.py`, `sap_sync.py`), and the `PLANT_LISTS` cache + `_BACKEND_LOG` ring buffer are
extracted behind narrow accessors. The following were **deferred, not abandoned** — pick them up only
when a real need arrives (they were cut to keep the refactor executable in ~13–16h instead of ~30h):

- **`db.py` / `master_data.py` domain split.** The line-range carve-up of both files into
  `backend/<domain>/data.py` modules (scheduling data + segments, integration ingest/upsert/stamping,
  priority-list stores, master-data tables/policies, labor, calendars, security DDL, admin-ops
  diagnostics). Costs when executed: rewrite of every bare `import db` / `import master_data as md`
  across ~24 test files, pyproject ruff per-file-ignore key moves, and either a `backend/core/db.py`
  (pool, `clean`/`_str_id`, `make_id`, `translate_db_error`) or `_pool`/`_str_id` compatibility aliases
  for the five modules importing those private names. The v1 plan's §4 table (in git history of the
  plan doc) carries the verified line ranges as of 2026-08-31 — re-derive them at execution time.
- **`backend/core/` package.** Only exists as part of the split above; do not create it independently.
- **Field-registry extraction.** Moving `RANKABLE_FIELDS`/`CONFIGURABLE_PRIORITY_FIELDS`
  (`master_data.py:94–154` as of 2026-08-31) to `backend/priority_lists/fields.py`, which would also
  remove the `setup_data → master_data` import edge. Until then the registry stays in `master_data.py`
  and `backend/priority_lists/CLAUDE.md` points at it.
- **Finer intra-domain frontend splits.** The refactor lands one file per domain per source
  mega-module (e.g. Timeline+Interaction+Hierarchy together in `frontend/scheduling/gantt.mts`). Splitting
  further is a within-folder edit with no cross-domain seams — cheap to do later if a file grows
  painful, and not worth pre-paying.

## Setup Matrix four-band redesign — two open items (2026-09-01)

`docs/archive/Setup_matrix_redesign.md` was archived on 2026-09-01: its core proposal (the four-band
layout, the `MAX_AXIS`-capped grid, and the six-state cell model) turned out to already be shipped in
commit `9576055`, the same commit that added the doc. Two items from its §16 "open questions" were
never resolved and have no other home now that the doc is archived:

1. **Keyboard arrow-navigation between grid cells** — explicitly flagged "not done" in `9576055`'s
   commit message and never picked up since. Low-severity accessibility/efficiency gap for planners
   editing many cells in a row.
2. **Whether `Scope` should bind live to `Store.selectedLines`, or only seed from it on open.** The
   doc's author leaned toward seed-only (binding live would silently re-scope the matrix being edited
   whenever the Gantt's line filter changes elsewhere), but this was never actually decided or built —
   `Scope` in `frontend/setup/setup-admin.mts` currently has whatever behavior shipped by default, not
   a deliberate choice either way. Worth a five-minute decision next time someone is in this file.

## Setup-signature tooling landmine — was already closed on Azure, docs just didn't know it (2026-09-01)

`master_data.RANKABLE_FIELDS` (`prt01`/`prt02`/`productionVersion`) has always been a valid setup
signature field, and `backend/setup/data.py`'s `derive_machine_state_before_replacement` has always read
`orders.prt_01`/`prt_02`/`production_version` directly on every schedule-mutation path (not just an
admin-config action). Those columns are created by `migrations/2026-08-11-priority-lists.sql`. Both
`docs/scheduling_priority.md` and this investigation initially believed that migration had **never**
been applied anywhere — it turns out it landed on Azure on **2026-08-11 18:51:51+00, the same day it
was written**, via a routine `promote-azure` run nobody recorded here. Plant `1085`'s data is 100%
populated (179/179 `material_plants` rows, 1,842/1,842 `orders` rows) and has been for three weeks. The
landmine never fired only because no plant's live `setup_definition.fields` has ever included a tooling
field (`1085` is `["colorWheel"]` only) — the capability was safe to use the entire time.

**What actually needed fixing, found while chasing this down (2026-09-01):**
- Local dev Postgres had the same migration recorded in its ledger (2026-08-20) but as a **complete
  no-op** — `color_wheel`/`material_plants` were both empty locally at that moment, so no test or local
  run could ever have caught this by accident. This dev machine's `.env` is Azure-configured
  (`PG_USER=TempAdmin`), not local — see `CLAUDE.md`'s Database Setup DB-safety note; overriding
  `PG_HOST`/`PG_USER`/`PG_PASS`/`PG_SSLMODE` got all 57 `@pytest.mark.pg` tests in
  `tests/test_priority_lists.py` (plus `test_setup_data.py`) running locally for the first time (117
  passed, up from 17 that had ever actually executed before).
- Fixed a genuine, unrelated, dormant bug this surfaced: `TestStampOrderAttributesAndTheInverseLedgerTrap
  ._seed` in `tests/test_priority_lists.py` inserted into `subnetworks` without the required `name`
  column — a `NotNullViolation` that had never been hit because these tests had never run against a
  real database before.
- Added `test_setup_signature_on_tooling_fields_reads_the_materialized_orders_columns` — no prior test
  exercised the tooling-signature DB-read path against a live row; this one does and passes.

**Still genuinely open, unrelated to the above:** the RBAC gap on
`POST /master-data/plants/{plant}/constraints` (tracked further up this file), and no plant has actually
turned on a tooling-based signature or priority-list ranking yet — the data and code both support it,
turning it on for a real plant is a product decision, not an engineering one.

## `orders.run_time` bound constraint — pre-deploy data check needed (2026-09-25, H8)

`migrations/2026-09-25-orders-run-time-bounds.sql` adds a `NOT VALID` CHECK constraint bounding
`orders.run_time` to `[0, 168)` hours and rejecting `NaN`/`Infinity`. The constraint exists
specifically because an unvalidated `RUN_TIME` was reaching SQL interval arithmetic as `NaN`/
out-of-range and crashing `/tasks` — which means there's a real chance the live Azure `orders` table
already holds an offending row.

**Two separate files, two separate transactions (Wave-0 final review, Finding 1).** The
`VALIDATE CONSTRAINT` step lives in its own, later-dated file —
`migrations/2026-09-26-orders-run-time-bounds-validate.sql` — not in the same file as the
`ADD CONSTRAINT ... NOT VALID` step. This repo's deploy runner
(`.claude/skills/promote-azure/scripts/apply-migrations.ps1`, and its `.agents/` mirror) applies each
migration **file** in its own `--single-transaction` — one transaction per file, not one per logical
migration. Putting both steps in one file would have meant the `ADD CONSTRAINT NOT VALID` step's heavy
table lock stayed held through the *entire* `VALIDATE CONSTRAINT` scan too (same transaction),
defeating the whole point of the two-step pattern, and a `VALIDATE CONSTRAINT` failure would have
rolled back the `ADD CONSTRAINT` right along with it, leaving no constraint in place at all.
Splitting them into two files means:

- The `2026-09-25-...-bounds.sql` file's `ACCESS EXCLUSIVE` lock is brief — released the moment
  *that file's own* transaction commits, not held through the later validation scan.
- The constraint **does** stay in place blocking new bad writes from the moment
  `2026-09-25-...-bounds.sql` commits, regardless of whether the later validate file ever succeeds.
- If `2026-09-26-...-validate.sql` fails (existing data violates the bound), only **that file**
  needs to be re-run after data cleanup — not the whole pair.

(Naming note: the validate file is intentionally dated `2026-09-26`, not
`2026-09-25-orders-run-time-bounds-validate.sql` — the runner sorts filenames with plain
`Sort-Object Name`, and `-` (0x2D) sorts *before* `.` (0x2E) in ASCII, so a same-day `-validate` suffix
would have sorted *before* the base file it depends on. A later calendar date avoids that trap.)

**Before promoting either migration to Azure**, run this against the live DB to check for existing
violations:

```sql
SELECT production_order, run_time
FROM orders
WHERE run_time IS NOT NULL
  AND (run_time < 0 OR run_time >= 168 OR run_time != run_time);
```

(`run_time != run_time` is the standard SQL idiom for detecting `NaN`, which is otherwise not equal to
itself.) Clean up any offending rows first, or be prepared for `2026-09-26-orders-run-time-bounds-validate.sql`
to fail — that failure is non-destructive: the `NOT VALID` constraint from the other file is already in
place and keeps blocking new bad writes even while validation hasn't completed, so a failed validate
just means manual data cleanup is needed before re-running that one file, not a rollback of either.

**Also check realistic magnitude, not just violations (Wave-0 final review, Finding 3).** The query
above only finds rows that already violate the `168`-hour bound. Before promoting, also check the
*largest* actual `run_time` in a recent real SAP/Excel order file (not synthetic test data) — if
legitimate production runs are close to or exceed 168 hours, the bound itself needs revisiting before
this constraint ever reaches production, not just a data cleanup.

**Deferred follow-up (Finding 3, documented not fixed in this pass):** this constraint can fail an
entire batch, not just one bad row. `upsert_orders`' Excel/SAP ingest path commits in 500-row chunks —
one row with an out-of-bound `run_time` aborts its whole chunk, leaving a partial upload. The routing
resolver's `_round_to_minute`/hours-computation path has the same latent exposure for a whole
`resolve_orders` batch (latent today since no plant has routing switched on). Per-row
rejection/warning — instead of whole-batch/whole-chunk failure — should eventually be added to both
paths so one bad row doesn't abort an entire upload or resolve batch. Not implemented here; recorded
as follow-up work for whoever picks up ingest/resolver hardening next.

## Backward scheduling — Phase 1 owner checks

`migrations/2026-10-15-1-orders-original-dates.sql` adds the locked SAP start/finish columns
(`orders.original_start_received`, `orders.original_finish_received`, `order_distribution.original_finish_received`)
and backfills them once, guarded by the `schema_migrations` id `orders_original_dates_backfill`. An order that
NIMBUS has already sent back to SAP (it has an `order_sap_sent` row) had its SAP finish overwritten by that send,
so its original is lost and the backfill can only copy the current `basic_finish_date`. The owner may want to
review those orders before relying on their due dates. Read-only query (SELECT only — never run by an agent):

```sql
SELECT o.id, o.plant, o.production_order, o.basic_finish_date, o.sap_basic_finish_date, s.sent_finish
FROM orders o
JOIN order_sap_sent s ON s.order_id = o.id
WHERE o.basic_finish_date IS DISTINCT FROM o.sap_basic_finish_date
   OR o.basic_finish_date IS DISTINCT FROM s.sent_finish
ORDER BY o.plant, o.production_order;
```

The backfill `UPDATE` touches every `orders` row, which bumps each row's xmin (the `base_version`), so apply it at
deploy time and never mid-shift.

