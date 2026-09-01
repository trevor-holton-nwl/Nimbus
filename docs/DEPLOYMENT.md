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
- Changed frontend JS/CSS? Bump `NIMBUS_BUILD_ID` in `index.html` — it single-source-drives the `?v=` on every asset URL and the `app-entry.mjs` cache-bust guard, so browsers don't serve stale assets. (There is **no** separate `APP_VERSION` in `app.js` anymore — that constant moved into `app-entry.mjs`'s `runCacheBustGuard()`, which reads `NIMBUS_BUILD_ID` directly.)
- Edited a `.ts`/`.mts` file? `az acr build` compiles it automatically in the cloud (the multi-stage `Dockerfile`'s `node:20-slim` builder runs `npm run build`), so a redeploy needs nothing extra. For **local** dev only, run `npm run build` before `uvicorn brain:api` serves the fresh output — see `docs/archive/typescript_migration.md`.
- Do **not** re-run `schema.sql` on a normal redeploy — it's idempotent and ledger-guarded now (safe if you do), but a redeploy never needs it since the schema already exists.

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
> `schema.sql` is **idempotent and safe to re-apply** (fixed 2026-07-07). The former ×1440 horizon
> landmine — an unguarded `UPDATE plants SET *_horizon = *_horizon * 1440 WHERE *_horizon <= 365` that
> re-multiplied values on every run — is now recorded in a `schema_migrations` ledger and no longer
> executes on apply. See `MIGRATION.md` → "Schema migration ledger". You still only *need* to run it
> once (at provisioning); re-running just won't corrupt anything.

## Verify
```powershell
$fqdn = az containerapp show -g rg-nimbus-dev -n ca-nimbus-dev --query properties.configuration.ingress.fqdn -o tsv
# GET https://$fqdn/health  -> JSON with db.connected:true
# GET https://$fqdn/        -> the NIMBUS UI
# GET https://$fqdn/tasks?plant=<code> -> 200 JSON (bare /tasks is a 400 "pick a plant" guard)
```

## Syncing live schema changes back into files

The Admin → Manage Data Tables screen's "Add Column"/"Drop Column" wizard (`master_data.add_column`/`drop_column`) mutates whichever Postgres the running app is pointed at **directly** — it does not touch `schema.sql` or `migrations/*.sql`. Admins are expected to use these buttons against the live pilot when they need to, so nothing blocks that. This means a column added on Azure has no record anywhere in git unless someone deliberately syncs it back — which is exactly how `production_lines.bottleneck`/`excl_optimizer`/`buffer_*` went missing before being reconstructed and fixed (2026-07-03).

To close that gap after the fact: hit `GET /master-data/_schema-export` (or click "Export Schema" in the Manage Data Tables screen) against whichever environment you want to check. It returns every column currently registered on `subnetworks`/`plants`/`production_lines`/`materials`/`material_plants` as idempotent SQL (`ADD COLUMN IF NOT EXISTS` + `INSERT ... ON CONFLICT DO NOTHING`) — safe to paste into `schema.sql` wholesale, since anything already correctly present is a no-op. Workflow:

1. Hit the export endpoint against the live Azure URL (or click the button in the Azure-hosted UI).
2. Diff the output against the current `schema.sql` — anything new is what an admin added since the last sync.
3. Fold the new lines into `schema.sql` (for fresh-DB parity) **and** copy them into a new `migrations/*.sql` file (same pattern as `migrations/2026-07-03-production-line-optimizer-flags.sql`).
4. Apply that migration file to Azure via the promote-azure guarded ledger (it'll already match Azure's live state, so this step is really just recording it in the `schema_migrations` ledger — see the `promote-azure` skill).

There's no automatic trigger for step 1 — the Add/Drop Column success toast includes a one-line reminder, but someone still has to remember to run the export periodically.

## Gotchas (learned the hard way)
- **Permissions:** subscription-level actions (e.g. `az provider register`) fail for an RG-scoped account — harmless if the providers are already registered. You need **Contributor on `rg-nimbus-dev`** to create resources.
- **`az containerapp logs show` fails behind a corporate proxy** (`SSL: CERTIFICATE_VERIFY_FAILED`, self-signed cert in chain). Read backend errors from the app's own endpoint instead: `GET https://<fqdn>/logs/backend` (PowerShell `Invoke-RestMethod` trusts the proxy CA via the Windows cert store).
- **`az acr build` log streaming crashes on Windows** with `UnicodeEncodeError` (cp1252). Set `$env:PYTHONIOENCODING="utf-8"`. The remote build still **succeeds** regardless — confirm with `az acr task list-runs --registry acrnimbusdev`.
- **`/data` is ephemeral:** Orders are safe (Postgres), and **per-plant color wheels are now durable too** — they persist in the Postgres `color_wheel` table (shipped 2026-07-07 via WS5, superseding the originally-planned Azure Files mount). Still wiped on restart/redeploy: the **global** `COLOR_FILE` wheel (fix = bake `color_wheel.xlsx` into the image) and the shared `_audit_log.json`. See `MIGRATION.md` (Workstream 5).

## Deferred hardening
See `MIGRATION.md`: Entra SSO (real login — the URL is currently open), Key Vault for secrets,
managed-identity registry pull, VNet/Private Endpoint for Postgres, and the remaining color-wheel
durability leftovers (per-plant wheels are already durable in Postgres; the **global** wheel +
`_audit_log.json` are the open items). Also **rotate the `TempAdmin` password**, then update the
secret and restart:
```powershell
az containerapp secret set -g rg-nimbus-dev -n ca-nimbus-dev --secrets pg-pass=<NEW_PASSWORD>
az containerapp revision restart -g rg-nimbus-dev -n ca-nimbus-dev   # (use the active revision name)
```
