# NIMBUS — Azure Hosting Request

**Requestor:** trevor.holton@newellco.com
**App:** NIMBUS (Newell Integrated Batch & Unified Scheduling) — a production-scheduling web app
(FastAPI backend + static vanilla-JS frontend) currently running on a laptop. We are moving it to a
**hosted single-plant pilot** so it can be reached as an internal company web app.

**What I already have:** an Azure Database for PostgreSQL **Flexible Server** (provisioned; I have
server-scoped access — I can create/connect to databases on it). The database side is handled.

**What this request covers:** the compute, registry, secrets, identity, storage, SSO, and networking
needed to host the frontend + backend. I do **not** have rights to provision these myself.

> A full architecture runbook (`MIGRATION.md`) and exact `az`-CLI ordering exist in the repo. The
> intended shape is **Azure Container Apps + the existing Postgres Flexible Server + Key Vault +
> Entra ID SSO**, with an nginx reverse proxy so the frontend and backend share one origin.

---

## Summary of asks

| # | Resource | Why |
|---|----------|-----|
| 1 | Azure Container Apps environment (same region as the Postgres server) | Runs the backend + frontend containers |
| 2 | Azure Container Registry (ACR) + `AcrPush` for me | Stores the two app images |
| 3 | Azure Key Vault (RBAC mode) | Holds DB credentials out of source/images |
| 4 | User-assigned managed identity (UAMI) + role grants | Lets the apps pull images + read secrets |
| 5 | Storage Account + Azure Files share | Durable storage for per-plant color-wheel files |
| 6 | Two Entra ID app registrations + admin consent | Real Newell login (SSO) instead of a hardcoded user |
| 7 | Networking config (ingress + Postgres reachability + optional domain) | Secure, same-origin access |
| 8 | Contributor on the target resource group for me | So I can deploy/update the apps |

---

## 1. Compute / hosting
- An **Azure Container Apps environment**, **in the same region as the Postgres Flexible Server**.
- Two container apps will live in it:
  - **backend** — FastAPI on uvicorn, listening on port 8000.
  - **frontend** — nginx serving static assets and reverse-proxying `/api` to the backend.
- *Acceptable alternative if you prefer:* two **App Service "Web App for Containers"** instances.

## 2. Container registry
- An **Azure Container Registry (ACR)**.
- Please grant me **`AcrPush`** so I can build/push the two images (`az acr build`), **or** let me
  know if your team owns image builds via a pipeline instead.

## 3. Secrets
- An **Azure Key Vault** in **RBAC mode**, holding these secrets (I'll provide values):
  - `pg-pass`, `pg-host`, `pg-user` (the Postgres Flexible Server admin credentials).

## 4. Identity & role assignments
- A **user-assigned managed identity (UAMI)** — please create this **before** the container apps
  (a system-assigned identity can't be referenced at app-create time).
- Grant the UAMI: **Key Vault Secrets User** (on the Key Vault) + **AcrPull** (on the ACR).

## 5. Storage for color-wheel files
- A **Storage Account** + an **Azure Files share** named `nimbus-colorwheels`.
- Register it as **Container Apps environment storage** and mount it on the backend at
  `/data/color_wheels`.
- *Why:* the app writes per-plant color-config `.xlsx` files at runtime; container filesystems are
  ephemeral, so without a mounted share these are lost on every restart/redeploy.

## 6. Entra ID SSO  *(needs an Entra/Azure-AD admin — cannot be self-served)*
Two **app registrations** in our tenant, with **admin consent** granted:
- **NIMBUS-API**
  - Exposes an API scope named **`access_as_user`**.
  - Application ID URI: `api://<NIMBUS-API-client-id>`.
- **NIMBUS-SPA**
  - Platform = **Single-page application** (Auth Code + PKCE, **no client secret**).
  - Redirect URIs: the frontend URL(s) — e.g. `https://<frontend>.azurecontainerapps.io` and, for
    local testing, `http://localhost:8080`.
  - Delegated permission on the **NIMBUS-API** `access_as_user` scope.

**Please send back:** the **Tenant ID**, the **NIMBUS-API client ID**, and the **NIMBUS-SPA client ID**.
*(These replace a hardcoded user identity in the current prototype with real Newell logins.)*

## 7. Networking
- **Backend ingress = `internal`** (not publicly exposed); **frontend ingress = `external`**. The
  frontend nginx proxies `/api` → backend, so there's a single public origin and no CORS surface.
- Ensure the **backend can reach the Postgres Flexible Server** — either enable "Allow Azure
  services" on the Postgres firewall, or set up VNet integration (your call).
- **Also:** please confirm whether I can add a **client-IP firewall rule** on the Postgres server
  myself for local development. If my access doesn't expose Networking, I'll need that rule added.
- *Optional:* a **custom domain + TLS certificate + DNS record** if the pilot should have a friendly
  company URL rather than the default `*.azurecontainerapps.io` hostname.

## 8. Deployment access
- **Contributor on the target resource group** for me, so I can run
  `az containerapp create/update` to deploy and update the apps. If your team prefers to own
  deployment instead, let me know and I'll hand over the images + config.

---

## What I will provide / do once the above exists
- Build and push the backend + frontend container images.
- Provide the Postgres credential values for Key Vault.
- Wire the app's runtime config (API base URL, Tenant/Client IDs) and the JWT-validation /
  MSAL.js SSO integration (these code changes are scoped and documented in `MIGRATION.md`).
- Bootstrap the database schema (one-shot `psql`, already idempotent).

## Open questions for IT
1. Container Apps vs App Service — any platform preference?
2. Do I run image builds + deploys (need ACR push + RG Contributor), or do you own that pipeline?
3. Postgres reachability from the backend — "Allow Azure services" or VNet integration?
4. Custom domain needed for the pilot, or is the default Azure hostname fine to start?
