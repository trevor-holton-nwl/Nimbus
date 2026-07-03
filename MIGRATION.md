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
| **Color-wheel durability** — Container Apps `/data` is ephemeral, so uploaded per-plant wheels + `_meta.json` + `_audit_log.json` are **wiped on every restart/redeploy** (orders are safe — they're in Postgres). Keep `--min/max-replicas 1` meanwhile. | **Workstream 5** (Azure Files SMB mount; zero code change beyond the env var). |
| **Real authentication / login** — the pilot URL is **open to anyone who has it**. | **Workstream 3** (Entra SSO). Interim stopgap: `NIMBUS_API_KEY` (see audit-remediation addendum) — but it guards only destructive *admin* routes, **not** `/tasks` reads or task edits. |
| **Registry auth without a stored password** (ACR admin user → managed identity). | **Workstream 7** (UAMI + `AcrPull`). |
| **Postgres network hardening** (allow-Azure firewall → VNet / Private Endpoint). | **Workstream 7** item 4 + **Fork 2**. |
| **Rotate the committed Postgres password** (`Mavdob8808!` is in git history; current code reads `PG_PASS` from env, so this is a history/secret-hygiene task, not a code change). | **In-scope #8 / Fork 4** — do it regardless; use a fresh password as the pilot's `pg-pass` secret. |
| **Frontend CDN dependency** *(NEW — not previously tracked; see below)*. | New deferred item, documented below. |

### NEW deferred item — frontend CDN dependency
`index.html` loads several libraries from **public CDNs in the browser** (not bundled in the image):
vis-timeline, AG Grid, Chart.js, Flatpickr, and Google Fonts (unpkg / jsdelivr / fonts.googleapis.com).
Implications for a hosted plant pilot:
- End users' **browsers** need outbound internet to those CDNs (the container does not). On a
  locked-down corporate/plant network that blocks public CDNs, the UI breaks — unstyled page, no
  Gantt timeline, no orders grid.
- No Content-Security-Policy is set and there is **no Subresource-Integrity** pinning on the CDN
  `<script>`/`<link>` tags.
- **Fix (deferred):** vendor these libraries into the repo and serve them from the same container
  (they would be covered by the existing `StaticFiles` mount), or front them with an approved
  internal mirror; add SRI hashes + a CSP. **Decide before any network-restricted plant rollout.**

---

## Workstream — SAP Interface (deferred hardening)

> The SAP→NIMBUS sync engine (`sap_sync.py`, the Admin "Interface" sub-tab, and the
> `sap_sync_config` / `sap_sync_run` / `sap_field_map` tables) ships as a **non-live skeleton** —
> connectors are stubs, the in-process scheduler is **disabled by default**, and no real SAP
> transport is wired. The items below must be resolved **before** any production SAP pull goes live.

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
