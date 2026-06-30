# NIMBUS — Azure Deployment Runbook

> Operational companion to `MIGRATION.md`. `MIGRATION.md` is the plan/vision + hardening roadmap;
> this file is **what's deployed now and how to operate it**. First deployed 2026-06-30.

## What's deployed

A **single container** on **Azure Container Apps**: FastAPI (`brain:api`) serves both the JSON API
and the static frontend (a `StaticFiles` mount at `/`, frontend bundled under `/app/web`), connected
to Azure Database for PostgreSQL over TLS. **No SSO yet** — treat as an internal pilot (anyone with
the URL can use it).

**Live URL:** https://ca-nimbus-dev.delightfulwater-7252cdf0.eastus2.azurecontainerapps.io/

| Resource | Value |
|---|---|
| Subscription | Quantum Leap Playground (`cf82eecb-e714-440e-83b0-7e92a12cb728`) |
| Resource group | `rg-nimbus-dev` |
| Region | `eastus2` |
| Container Registry | `acrnimbusdev` (admin user enabled), image `nimbus:vN` |
| Container App | `ca-nimbus-dev` (ingress external, target-port 8000, **min=max=1 replica**) |
| Container Apps env | `cae-nimbus-dev` |
| Postgres | `pgdb-nimbus-dev` / db `nimbus` / user `TempAdmin` / `sslmode=require` |
| PG firewall rules | `AllowAzure` (0.0.0.0 — lets the app connect), `DevLaptop` (a dev client IP; removable) |
| DB password | Container App secret `pg-pass`, referenced as `PG_PASS=secretref:pg-pass` — **never stored in the repo** |

**Single replica is required:** the color-wheel cache and the in-memory log ring buffer are per-process.

## Prerequisites
- Azure CLI (`winget install --exact --id Microsoft.AzureCLI`), `az login`, and **Contributor on `rg-nimbus-dev`**.
- If `az` isn't found in a shell opened before the install, refresh PATH from the registry:
  ```powershell
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  ```

## Redeploy after a code change (the common case)
From the repo root, bumping the image tag each time:
```powershell
az acr build --registry acrnimbusdev --image nimbus:v2 .
az containerapp update -g rg-nimbus-dev -n ca-nimbus-dev --image acrnimbusdev.azurecr.io/nimbus:v2
```
- Changed frontend JS/CSS? Bump `NIMBUS_BUILD_ID` in `index.html` (and `APP_VERSION` in `app.js`) so browsers don't serve stale assets.
- Do **not** re-run `schema.sql` on a normal redeploy (it carries data migrations — see the warning below).

## First-time provisioning (already done — recorded for rebuilds / new environments)
Replace `<DB_PASSWORD>` with the Postgres admin password; **never commit it**.
```powershell
# 1. Registry
az acr create -g rg-nimbus-dev -n acrnimbusdev --sku Basic
az acr update -n acrnimbusdev --admin-enabled true

# 2. Build the image in the cloud (no local Docker needed)
az acr build --registry acrnimbusdev --image nimbus:v1 .

# 3. Database: allow Azure services, create the db, load schema ONCE
az postgres flexible-server firewall-rule create -g rg-nimbus-dev --server-name pgdb-nimbus-dev `
  --name AllowAzure --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0
az postgres flexible-server db create -g rg-nimbus-dev --server-name pgdb-nimbus-dev --database-name nimbus
# Load schema from a host with psql + DB firewall access:
#   $env:PGPASSWORD='<DB_PASSWORD>'
#   psql "host=pgdb-nimbus-dev.postgres.database.azure.com port=5432 dbname=nimbus user=TempAdmin sslmode=require" -f schema.sql

# 4. Container Apps environment + the app
az containerapp env create -g rg-nimbus-dev -n cae-nimbus-dev --location eastus2
$acrUser = az acr credential show -n acrnimbusdev --query username -o tsv
$acrPass = az acr credential show -n acrnimbusdev --query "passwords[0].value" -o tsv
az containerapp create -g rg-nimbus-dev -n ca-nimbus-dev --environment cae-nimbus-dev `
  --image acrnimbusdev.azurecr.io/nimbus:v1 `
  --registry-server acrnimbusdev.azurecr.io --registry-username $acrUser --registry-password $acrPass `
  --target-port 8000 --ingress external --min-replicas 1 --max-replicas 1 `
  --secrets pg-pass=<DB_PASSWORD> `
  --env-vars PG_HOST=pgdb-nimbus-dev.postgres.database.azure.com PG_PORT=5432 PG_DB=nimbus PG_USER=TempAdmin PG_PASS=secretref:pg-pass PG_SSLMODE=require NIMBUS_ALLOWED_ORIGINS="*"
```
> ⚠️ `schema.sql` is **run-once-ish**: it multiplies `plants` horizon columns ×1440 for values ≤365 on every run. Apply it once at provisioning; don't blindly re-run.

## Verify
```powershell
$fqdn = az containerapp show -g rg-nimbus-dev -n ca-nimbus-dev --query properties.configuration.ingress.fqdn -o tsv
# GET https://$fqdn/health  -> JSON with db.connected:true
# GET https://$fqdn/        -> the NIMBUS UI
# GET https://$fqdn/tasks?plant=<code> -> 200 JSON (bare /tasks is a 400 "pick a plant" guard)
```

## Gotchas (learned the hard way)
- **Permissions:** subscription-level actions (e.g. `az provider register`) fail for an RG-scoped account — harmless if the providers are already registered. You need **Contributor on `rg-nimbus-dev`** to create resources.
- **`az containerapp logs show` fails behind a corporate proxy** (`SSL: CERTIFICATE_VERIFY_FAILED`, self-signed cert in chain). Read backend errors from the app's own endpoint instead: `GET https://<fqdn>/logs/backend` (PowerShell `Invoke-RestMethod` trusts the proxy CA via the Windows cert store).
- **`az acr build` log streaming crashes on Windows** with `UnicodeEncodeError` (cp1252). Set `$env:PYTHONIOENCODING="utf-8"`. The remote build still **succeeds** regardless — confirm with `az acr task list-runs --registry acrnimbusdev`.
- **`/data` is ephemeral:** uploaded color wheels + their audit log are wiped on restart/redeploy. Orders are safe (Postgres). Durability fix is Azure Files — see `MIGRATION.md` (Workstream 5).

## Deferred hardening
See `MIGRATION.md`: Entra SSO (real login — the URL is currently open), Key Vault for secrets,
managed-identity registry pull, Azure Files for color-wheel durability, VNet/Private Endpoint for
Postgres. Also **rotate the `TempAdmin` password**, then update the secret and restart:
```powershell
az containerapp secret set -g rg-nimbus-dev -n ca-nimbus-dev --secrets pg-pass=<NEW_PASSWORD>
az containerapp revision restart -g rg-nimbus-dev -n ca-nimbus-dev   # (use the active revision name)
```
