# NIMBUS — Hosted Azure Pilot: Migration Runbook

> **Status: NOT YET EXECUTED.** This is a transition document. No code changes have been made.
> When Newell green-lights the hosted pilot, execute the workstreams below in order.
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
5. Color-wheel filesystem durability via Azure Files mount.
6. Same-origin reverse-proxy networking (frontend nginx → internal backend).
7. Azure provisioning runbook + schema bootstrap + `DEPLOYMENT.md`.
8. **Rotate the committed Postgres password** (`Mavdob8808!` is in source history).

### Out of scope (fast-follow, documented but not built)
- Full plant-scoped RBAC (a clean seam is left, not built).
- Migrating per-browser `localStorage` state (blackouts/calendars/line-settings) to server-side per-user storage.
- Migrating color wheels from Azure Files into a Postgres table.
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

## Workstream 4 — Optimistic edit-conflict guardrail (bounded multi-user slice)

The single concession to multi-user, sized for "a few editors, same plant":
- **`schema.sql`:** add `updated_at TIMESTAMP DEFAULT NOW()` (or an integer `row_version`) to the orders table; bump it on every task write in `db.update_task_dates`.
- **`/tasks`:** include each task's `updated_at` in the response; frontend stores it on the task object.
- **`/task/update` + `/tasks/update` + `/tasks/bulk_update`:** accept the client's expected `updated_at`; if the DB row is newer, **reject that task with HTTP 409** and return the conflicting id(s) instead of overwriting.
- **Frontend:** on 409, show a Toast ("Order X was changed by someone else — reload to see the latest") rather than silently clobbering; refresh the affected row.
- **Known limitation (documented, not fixed):** `Persistence.saveAll()` pushes the whole task array coarsely; the granular `/task/update` path is where real concurrent edits flow and where the guardrail bites. Full per-user state sync is the fast-follow.

## Workstream 5 — Color-wheel durability (Azure Files)

Container Apps filesystem is ephemeral, but `COLOR_WHEEL_DIR` is written at runtime (per-plant `.xlsx`, `_meta.json`, `_audit_log.json`). **Pilot fix = Azure Files SMB mount at `/data`** — zero code change beyond the env var (WS1). Register the share as environment storage, mount as a volume on the backend, keep backend `min=max=1 replica` during pilot to avoid SMB write races on the audit JSON. Global `COLOR_FILE` stays baked read-only into the image. (Post-pilot: migrate to a `color_wheels` Postgres table — out of scope.)

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

`schema.sql` is idempotent + Azure-safe. **Pilot: one-shot `psql` from Cloud Shell** (`sslmode=require`) right after the Postgres server is up, before backend traffic — `lifespan` only reads, so schema must exist first. Re-running on later deploys is safe. (CI option: Container Apps Job from the backend image — defer.)

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
1. **Color wheels:** Azure Files mount now ✅ (recommended) vs. Postgres table now → *default: Azure Files*.
2. **Postgres exposure:** public + allow-Azure firewall (pilot) ✅ vs. VNet + Private Endpoint → *default: public for pilot, harden as fast-follow*.
3. **Schema bootstrap:** manual `psql` one-shot ✅ vs. Container Apps Job → *default: manual*.
4. **Security action (not optional):** rotate the Postgres password — `Mavdob8808!` is in git/source history.

---

## Verification (run at execution time)

1. **Local stack still works first:** with no env vars / auth disabled, `python brain.py` + local frontend behaves exactly as today.
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
- **To enable for a non-Azure host:** set `NIMBUS_API_KEY` on the backend **and** make admin
  clients send `X-API-Key`. The current frontend does **not** send it yet, so enabling the key
  without wiring the frontend will break the in-app admin actions — wire it first.

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
