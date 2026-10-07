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

## Optimizer planning exceptions release

Apply `migrations/2026-09-09_optimizer_planning_exceptions.sql` through the migration ledger before releasing the dependent application. The application now reads `planning_status` and `planning_reason` on every task query. Queued orders preserve SAP baselines but have no committed dates or segments. Older application versions do not understand this state and can reconstruct dates from SAP baselines, so a rollback after orders enter Needs Planning must retain queue-aware application code. Build the frontend as part of the application release (pass `--build-arg BUILD_ID=<git short sha>` to `az acr build` so the cache-bust id is stamped automatically). Verify a queued order and a scheduled peer together through Save/reload, and verify that a stale optimizer save persists neither row.

## SAP staging release (Mulesoft interface)

Design of record `docs/SAP_STAGING_DESIGN.md`; the contract Mulesoft codes against is `docs/NIMBUS_INTERFACE_ARCHITECTURE.md` section 7. Nothing flows until the role exists, Mulesoft has network access and the poll interval is set, so the app can ship first and be switched on later.

### 1. Migrations (through the ledger) — apply BEFORE the new image rolls

**Order matters against the image, not between the two files.** The new application reads the side table `order_sap_sent` on every order upload (the shared upsert joins it), so applying the image first would break Excel uploads until the tables exist. Apply the migrations first; the old image keeps working with the new tables (they are additive).

The two files are `migrations/2026-10-08-sap-staging-columns.sql` and `migrations/2026-10-08-sap-staging-tables.sql`. The runner applies files in name order, so the columns file goes first. That is harmless: it only alters tables that already exist (`sap_sync_config`, `material_plants`, `production_version`) and no longer depends on the tables file (the remembered-send values moved from `orders` columns into the side table `order_sap_sent`, which the tables file creates).

**`-AllowDestructive` is runner-wide, not per file.** The runner's filter is a plain word match over each whole file (comments included): the columns file trips it on `ALTER` and the tables file on `ON DELETE CASCADE` (and a comment). Both files were reviewed and are additive only (`CREATE TABLE IF NOT EXISTS`, `INSERT ... ON CONFLICT DO NOTHING`, `ADD COLUMN IF NOT EXISTS` nullable or defaulted; nothing dropped, rewritten or backfilled; re-running is a no-op). But the flag also unblocks every OTHER pending migration that the filter would have stopped. So:

1. From the repo root, **dry run first and read the whole list**: `.\.claude\skills\promote-azure\scripts\apply-migrations.ps1 -DryRun` (touches no database; every pending file is listed, destructive ones marked `DESTRUCTIVE -> blocked`). If anything other than the two staging files is pending and marked destructive, review it before continuing.
2. Apply with `.\.claude\skills\promote-azure\scripts\apply-migrations.ps1 -AllowDestructive`. The password is read from `$env:PGPASSWORD` or, if unset, from an interactive hidden prompt (never typed on the command line); the script uses `C:\Program Files\PostgreSQL\18\bin\psql.exe` unless you pass `-PsqlPath`, and connects to `pgdb-nimbus-dev` / `nimbus` as `TempAdmin` with `sslmode=require` by default.
3. Each file and its ledger row run in one transaction; a failure leaves nothing half-applied.
### 2. Environment variables on the Container App

| Variable | Default | Meaning |
|---|---|---|
| `NIMBUS_SAP_STAGING_POLL_SECONDS` | `0` (no poll job) | Poll interval for new Mulesoft batches. Suggested pilot value `60`. Setting it creates the in-process scheduler even when `NIMBUS_SAP_SYNC_ENABLED` is off. |
| `NIMBUS_SAP_STAGING_LOADING_TIMEOUT_MIN` | `120` | A batch left in `loading` (or marked `ready` with a row count that never matches) longer than this is rejected as stale. |
| `NIMBUS_SAP_STAGING_STATEMENT_TIMEOUT_MS` | `600000` | `statement_timeout` (ms) for the staging module's own validate / apply / sweep connections; the pool-wide default is 30 s (`NIMBUS_PG_STATEMENT_TIMEOUT_MS`), too short for a snapshot of tens of thousands of rows. The planned-order upsert itself runs on `db.upsert_orders`' own connections and keeps the pool default. |
| `NIMBUS_SAP_SYSTEM_TZ` | `UTC` | IANA name of the time zone SAP's dates and times are expressed in (for example `America/New_York`). **Value to be confirmed with SAP Development**; a wrong value shifts every order's start and finish by whole hours. A name that is not a valid zone (a typo, or blank) is caught: the app still boots and logs a warning, every batch shows the warning `sap_system_tz_invalid`, and planned-order apply and Send to SAP are refused until the value is fixed. The poll knobs (`..._POLL_SECONDS`, `..._LOADING_TIMEOUT_MIN`, `..._STATEMENT_TIMEOUT_MS`) never stop boot either: a non-integer value logs a warning and uses the default. |

```powershell
az containerapp update -g rg-nimbus-dev -n ca-nimbus-dev `
  --set-env-vars NIMBUS_SAP_STAGING_POLL_SECONDS=60 NIMBUS_SAP_STAGING_LOADING_TIMEOUT_MIN=120 NIMBUS_SAP_SYSTEM_TZ=<IANA name from SAP Development>
```

**Recommendation: deploy with `NIMBUS_SAP_STAGING_POLL_SECONDS=0` (the default; simply leave it unset) until Mulesoft is ready.** With the poll off nothing in the staging pipeline runs on its own: the Admin > Interface staging section and the Excel test upload still work, and an admin can press Refresh to run one pass by hand. Set the interval (for example `60`) only when Mulesoft has its login and the first batches are expected.

The poll holds a Postgres advisory lock, but the pilot stays single replica (`min = max = 1`); see `MIGRATION.md` for what is still open before scaling out.

### 3. The `nimbus_mulesoft` database login (manual, once per environment)

`migrations/manual/2026-10-08-nimbus-mulesoft-role.sql` is never applied by the runner (it lives under `migrations/manual/`) because the password and network rules differ per environment. A DB admin applies it by hand, after the tables migration:

1. Run the file as the server admin (`TempAdmin`) against database `nimbus`, from a host allowed through the firewall: `psql "host=pgdb-nimbus-dev.postgres.database.azure.com port=5432 dbname=nimbus user=TempAdmin sslmode=require" -f migrations/manual/2026-10-08-nimbus-mulesoft-role.sql`. It creates `nimbus_mulesoft` (login) with least-privilege grants on the `sap_stage_*` tables only: column-level `INSERT` (SAP-supplied columns only, no status/housekeeping/resolved columns, no batch `status`) plus a trigger that pins the batch status machine for this login (new batch = `loading`; only `loading` to `ready`/`rejected`). The file is idempotent and also tightens an earlier, broader grant when re-run.
2. Set the password **out of band; never in git, never in a ticket or chat**. Generate it, store it as a secret (a Container App secret such as `nimbus-mulesoft-pass`, or Key Vault once that exists) and run `ALTER ROLE nimbus_mulesoft PASSWORD '<value>'` interactively in `psql` so it does not land in shell history. Hand it to the Mulesoft team through the same secret store.
3. Re-run the file if a staging table is ever dropped and recreated (grants go with the table).

### 4. Network access for Mulesoft

The pilot Postgres endpoint is public with an allow-all-Azure rule (`AllowAzure`, 0.0.0.0) and the app itself connects as the server admin; both are already tracked in `MIGRATION.md`. The Mulesoft login is a second way into that surface, so:

- Require TLS: Mulesoft's JDBC URL must carry `sslmode=require` (`ssl=true` for the PostgreSQL JDBC driver).
- Add a firewall rule limited to Mulesoft's egress IP addresses: `az postgres flexible-server firewall-rule create -g rg-nimbus-dev --server-name pgdb-nimbus-dev --name MulesoftEgress --start-ip-address <MULESOFT_EGRESS_IP> --end-ip-address <MULESOFT_EGRESS_IP>` (**placeholder: the runtime location and egress IPs are not known yet**, design D31; repeat per address). The flag names (`-g`, `--server-name`, `--name`, `--start-ip-address`, `--end-ip-address`) match the output of `az postgres flexible-server firewall-rule create --help` as checked on 2026-10-07; the same command, with the same flags, is used for the `AllowAzure` rule further down this file. Azure CLI flags do change between versions, so run `az postgres flexible-server firewall-rule create --help` and confirm before running it against the pilot server.
- Mulesoft's per-row write-back of outbound status is also unconfirmed; without it the Send to SAP tiles stay at `ready`.

### 5. Operational rules (publish to planners and admins before the first apply)

- **Keep the two horizons equal per plant.** SAP's planning horizon for the export and NIMBUS's `visibility_horizon_days` must match; NIMBUS uses its own to decide which orders are "in the window" and may vanish. A plant with an unlimited visibility horizon never deletes anything (batch warning).
- **No Excel order uploads on a plant that receives SAP snapshots.** An order that exists only from Excel is absent from the next SAP snapshot and is deleted at apply.
- **Routing runtime must be on, with routings loaded, before planned orders can apply.** Otherwise the batch is held (`routing_required`). Apply Material Plant and Routing first.
- **The first SAP apply on a plant resets most scheduled slots** (SAP's dates differ from what NIMBUS holds). Plan it for a quiet moment and tell planners.
- **Apply the first planned-order batch for a plant at a quiet moment for a second reason (rehearsed, validation Track 4).** On an Excel-loaded plant the first SAP apply writes every order row once (the stored SAP production-version baseline goes from empty to blank), so every order's `xmin` moves. A planner with an unsaved edit open at that moment gets one concurrent-edit notice on their next save (the server version wins). In the rehearsal SAP's dates matched what NIMBUS held and no slot was reset (0 of 26); where SAP's dates differ, slots reset as in the bullet above. The concurrent-edit notice happens once per plant.
- **Converted orders vanish, even if running.** A planned order converted to a production order leaves the SAP export and is deleted at the next apply. It is recoverable for **30 days** from the Archive panel (Restore) in Admin > Interface.
- Open planner sessions learn of an apply only on save or reload.
- Roll back by discarding an un-applied batch (Discard) or restoring archived orders; an applied batch is not undone automatically.

### 6. Verify after deploy

1. **Migrations are in the ledger**: `SELECT filename FROM migration_files_applied WHERE filename LIKE '2026-10-08-sap-staging%';` returns both files (run as an admin login, never paste the password anywhere).
2. **Excel upload still works** (the shared upsert now reads `order_sap_sent`): upload a small test file through the UI and confirm the result counts.
3. **Poll state in the log**: if you set `NIMBUS_SAP_STAGING_POLL_SECONDS` above 0, the Admin log (or the container log) shows the line `SAP staging poll started` with the interval; with the default it shows `SAP staging poll disabled`. A line `SAP scheduler failed to start` is an error.
4. **Mulesoft login works** (once the role exists and the network rule is in place): connect as `nimbus_mulesoft` with `sslmode=require` and insert a header (`INSERT INTO sap_stage_batch (batch_id, object_key, plant, source) VALUES (gen_random_uuid(), 'stage_material_plants', '<a real plant>', 'mulesoft')`). It must succeed, the batch must show as `loading`, and an `UPDATE ... SET status = 'applied'` as that login must fail. Mark the test batch `rejected` afterwards (the only other move this login can make); NIMBUS removes it after 7 days.
5. **Upload into staging via the UI**: Admin > Interface > a staging object > upload a small Excel file with SAP column headers. The batch appears, validates, and is **not** applied automatically.
6. **`apply_mode` defaults to `manual`**: each staging object's mode selector reads Manual (`GET /sap/interface/objects` shows `"apply_mode": "manual"` for all four). To switch an object to automatic apply, an admin changes the Manual / Automatic selector on that object in Admin > Interface (it posts `{"apply_mode": "auto"}` to `/sap/interface/config/{object}`); switch back the same way. Leave everything on manual until the first batches have been reviewed by hand.
7. **Routing is ON and loaded before the first planned-order apply**: the plant has routing runtime switched on and routings loaded (Material Plant and Routing batches applied first). Otherwise the planned-order batch is held with `routing_required` (an admin cannot confirm that away).
8. **`NIMBUS_SAP_SYSTEM_TZ` is set** to the value SAP Development confirmed. A wrong or invalid value shows as the warning `sap_system_tz_invalid` on every batch and refuses planned-order apply and Send to SAP.
## Prerequisites

- Azure CLI (`winget install --exact --id Microsoft.AzureCLI`), `az login`, and **Contributor on `rg-nimbus-dev`**.
- If `az` isn't found in a shell opened before the install, refresh PATH from the registry:
  ```powershell
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  ```

## Redeploy after a code change (the common case)
From the repo root, bumping the image tag each time:
```powershell
az acr build --registry acrnimbusdev --image nimbus:v2 --build-arg BUILD_ID=$(git rev-parse --short HEAD) .
az containerapp update -g rg-nimbus-dev -n ca-nimbus-dev --image acrnimbusdev.azurecr.io/nimbus:v2
```
- Changed frontend JS/CSS? Pass `--build-arg BUILD_ID=$(git rev-parse --short HEAD)` to `az acr build` (as above). The Dockerfile stamps it into `NIMBUS_BUILD_ID` and `styles.css?v=` in `index.html` at image build time (letters, digits, `.`, `_`, `-` only; the build fails on anything else). `NIMBUS_BUILD_ID` single-source-drives the `?v=` on every asset URL and the `app-entry.mjs` cache-bust guard, so browsers don't serve stale assets - there is no need to hand-edit it in `index.html`. Without the build arg the committed value ships unchanged, so browsers may serve stale assets. (There is **no** separate `APP_VERSION` in `app.js`; that constant lives in `app-entry.mjs`'s `runCacheBustGuard()`.)
- Edited a `.ts`/`.mts` file? `az acr build` compiles it automatically in the cloud (the multi-stage `Dockerfile`'s `node:22.23.3-slim` builder (same major as CI's Node 22) runs `npm run build`), so a redeploy needs nothing extra. For **local** dev only, run `npm run build` before `uvicorn brain:api` serves the fresh output — see `docs/archive/typescript_migration.md`.
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

## Schema bootstrap smoke check

A fresh `psql -f schema.sql` bootstrap failed for a while (`column "plant" does not exist` — an index on `orders.plant` fired before the `ALTER TABLE orders ADD COLUMN plant` that ran later in the same file). Fixed by moving the column-add immediately after `CREATE TABLE orders`, plus a new `migrations/2026-09-02-orders-plant-column.sql` so the ledger-only deploy path also carries it. `scripts/schema_bootstrap_smoke.py` automates the regression check: it (1) applies `schema.sql` fresh to an empty scratch DB, (2) applies `schema.sql` then the full `migrations/*.sql` ledger (filename-sorted) to a second scratch DB — mirroring Azure's real history of "load schema once, then apply migrations" — and (3) diffs the two `orders` table shapes via `information_schema.columns`.

Run locally (never against the Azure pilot — it CREATEs/DROPs scratch databases):
```powershell
$env:PGPASSWORD = '<local postgres password>'
.\.venv\Scripts\python.exe scripts\schema_bootstrap_smoke.py --host localhost --port 5432 --user postgres
```
Or the two manual one-liners it automates, if you just want to eyeball it:
```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c 'DROP DATABASE IF EXISTS nimbus_bootstrap_test;'
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c 'CREATE DATABASE nimbus_bootstrap_test;'
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d nimbus_bootstrap_test -v ON_ERROR_STOP=1 -f schema.sql
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d nimbus_bootstrap_test -c "\d orders"
```
**Not run as part of this change** — no local Postgres was reachable in the environment this was written in (`psql -h localhost` hangs waiting on a connection). A human with local Postgres needs to run this to confirm it actually passes; it is not wired into `npm run test`/CI yet (no existing `tests/*.py` convention shells out to `psql` with an environment-conditional skip, so this stays a standalone `scripts/` entry point rather than a new pytest pattern).

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
