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
## Backward scheduling Phase 1 migrations (2026-10-15)

`migrations/2026-10-15-1-orders-original-dates.sql` and `migrations/2026-10-15-2-orders-run-time-bounds-336.sql` are destructive by text (`ALTER`, `UPDATE`, `DROP`, comments included). The runner blocks each one unless `-AllowDestructive` is passed, and that flag releases every pending destructive file that is not manual-only, so each file needs its own `-AllowDestructive` run. Before each run, read `migration_files_applied` and every pending file, and name exactly that run's file with `-Only <file>`. The owner runbook is in `docs/MIGRATION.md`, section "Backward scheduling — Phase 1 shipped / Phases 2–4 pending".

The `2026-10-15-1` backfill `UPDATE` rewrites every `orders` row, which bumps each row's xmin (the optimistic-concurrency `base_version`). Apply it at deploy time, never mid-shift. Planners must save before the run (an unsaved edit goes stale on its next save) and reload afterwards. The `2026-10-15-1` file also reads `order_sap_sent`, so `2026-10-08-sap-staging-tables.sql` must already be in the ledger.

## Backward-scheduling cutover

> **This runbook was written, not executed.** The 2026-10 backward-scheduling work was built and reviewed without touching the pilot (owner decision "deploy nothing", 2026-10-13): no `az` command, no `psql` against Azure and no `/promote-azure` run was made while writing it. Every command below is a plan for the operator, to be rehearsed on a copy first (step 3). Where a platform fact could not be checked from the repository it is marked **[unverified]**. The design evidence and every decision behind it are in `BACKWARD_SCHEDULING_MIGRATION.md` (section 8.13 is the long form of this runbook; section 8.8 is the rollback matrix).

### What the cutover does

From the cutover image on, a bar is anchored on its **finish** and its start is derived backward from it through the working calendar. For the data, the cutover migration does this to every order that is not waiting in Needs Planning:

- It removes the placed start and end, so the order reads as "never placed" and re-derives from its due date the first time its plant is opened under the new image.
- A **running** order keeps its start and **keeps its stored end** (no recompute to start plus run time during the migration; the first run-time edit re-derives it by walking the remaining run forward through working time from the actual start).
- **Every placed order is cut over; no line is excluded.** When the browser derives the bars, every line derives: a line without an hours row of its own uses the plant's default calendar, and there is no "line has no calendar" alert.
- It removes the schedule segments of those orders, clears the placement-exception marker, flags the order as needing a re-derive (`runtime_schedule_mismatch`) and moves `updated_at`, which gives every touched row a new version (any unsaved edit in an open browser tab goes stale).
- Orders in Needs Planning are not touched. Nothing is sent to SAP by the migration.

Nothing in the database restores the old placed finishes once planners have saved under the new rule (step 13). The snapshot tables from run 2 are the only recovery path, and using them loses every later edit.

### Roles (the owner fills in names before the window)

**Decider** (go, no-go, abort) `<name>`; **deploy operator** (runs the migration runner and the image commands) `<name>`; **platform operator** (backup, restore, firewall) `<name>`; **dump owner** (takes the pilot dump for the rehearsal) `<name>`; **SAP contact** `<name>`; **watcher** (reads Admin Cockpit, Logs and planner reports in the first shift) `<name>`; **capturer** (takes the pre-roll numbers) `<name>`.

### The runbook, in order

**1. Merge, once.** Merge `feature/backward-scheduling` into `main` by pull request: one merge, one image, one cutover window, CI green on the PR. The retired `feature/backward-scheduling-phase1` branch is not merged on its own; it predates the fix waves.

**2. Read the pending set.** Phase 1 (`2026-10-15-1-orders-original-dates.sql` and `2026-10-15-2-orders-run-time-bounds-336.sql`) must already be in the ledger; if it is not, stop and apply it first as described in the section above. Read the ledger, read-only, as an admin login (never paste the password into chat or a command line):

```sql
SELECT filename, applied_at FROM migration_files_applied ORDER BY filename;
```

The pending set must then be **exactly** these four files, and nothing else:

1. `2026-10-16-1-orders-placement-exception.sql` (adds a nullable column; inert to the old image)
2. `2026-10-16-2-orders-original-finish-date-only.sql` (additive and routine, not manual-only: adds the flag that records a due date arrived date-only, and marks existing exact-midnight locked finishes once; it rewrites those rows, so apply it at deploy time, never mid-shift)
3. `2026-10-20-0-orders-precutover-snapshot.sql` (copies orders, segments and sent-to-SAP rows into three snapshot tables; **manual-only**)
4. `2026-10-20-1-backward-cutover.sql` (the data change described above; **manual-only**; it raises an error and writes nothing unless the snapshot's ledger id `backward_cutover_snapshot` is already recorded, so the snapshot always comes first)

Files 3 and 4 carry the header line `-- nimbus-migration: manual-only`. The runner SKIPS such a file with a visible warning in every mode, `-AllowDestructive` included, so a routine `/promote-azure` after the merge (plain, or re-run with `-AllowDestructive`) can never take the snapshot early or run the cutover. They run only when the operator names them with `-Only` (steps 10 and 11). Until then the runner's summary lists them under `manual-only (skipped, use -Only)` and a later pending file is unaffected.

`apply-migrations.ps1 -DryRun` lists every file in the folder in apply order and never reads the ledger, so it cannot show what is pending; compare its list with the ledger yourself. It also shows which files the runner treats as destructive (the 1st, 2nd and 4th are, by text: `ALTER`, `UPDATE`, `DELETE`). `-Only <file-name-or-id-prefix>` applies exactly the named file(s) and nothing else (for example `-Only 2026-10-20-1`); it is the only way to run a manual-only file, and the file is still subject to the destructive check and the applied ledger. Without `-Only`, `-AllowDestructive` releases every pending destructive file that is not manual-only, so give each destructive file its own `-Only` run (step 11).

**3. Rehearse on a copy of the pilot database (gate G-10, part 2).** Do this from a **fresh** dump, shortly before the window; it is the only end-to-end run of the cutover before the real one.

1. The dump owner takes a fresh `pg_dump` of `pgdb-nimbus-dev` / `nimbus` and records how. The dump holds real order data and user rows: handle it under the owner's data rule.
2. Restore it into a local Postgres database (a new database name, for example `nimbus_rehearsal`).
3. Apply the four files to the copy **twice**, in the order of step 2, with the connection given explicitly so the runner cannot reach the pilot (its defaults are the pilot host and user): `-PgHost localhost -Port 5432 -Database nimbus_rehearsal -User postgres`, one file per run with `-Only <file>` exactly as in step 11 (the two manual-only files are applied by name only, and the cutover only after the snapshot: it refuses to run without it). The second pass of each must change nothing (the ledger skips it). The runner always connects with `sslmode=require` **[unverified: whether the local server accepts it]**; if it does not, run each file with `psql --single-transaction -v ON_ERROR_STOP=1 -f <file> -c "INSERT INTO migration_files_applied (filename) VALUES ('<file name>') ON CONFLICT (filename) DO NOTHING;"` instead, which is what the runner does per file. Time every file against the length of the quiet window.
4. Start the app against the copy (`uvicorn brain:api --port 8000` with `PG_HOST`/`PG_DB`/`PG_USER`/`PG_PASS` in the shell environment pointing at the local copy; never edit `.env` to point at Azure), open **every plant** in a browser, let the reconcile finish, and write down the toast it shows for each plant (the "N bars re-anchored on due dates, M reversed from now, K kept their running start, J blocked" summary) and any alert about a plant without a time zone. The summary toast appears only for a plant with at least 10 non-queued orders where more than half carry the cutover signature; a smaller plant shows ordinary per-row toasts, so the pass bar for it is the step 9 / G-6 SQL counts.
5. The owner reviews the numbers. **Pass bar:** the second apply is a no-op; the count of rows the cutover updated equals the number of non-queued orders on the copy (gate G-6); every plant's toast counts are explained (for a plant too small to show the summary toast, the G-6 SQL counts stand in for it; the running count matches the orders actually in production at the dump time; blocked is zero or accounted for); the timings fit the window.

**4. Gate: no plant without a time zone (OQ52, profile Q15).** On the pilot, before run 3, in a read-only transaction:

```sql
BEGIN READ ONLY;
SELECT plant FROM plants GROUP BY plant
HAVING COALESCE(NULLIF(MIN(timezone), ''), '') = ''
    OR MIN(timezone) NOT IN (SELECT name FROM pg_timezone_names);
ROLLBACK;
```

The result must be **zero rows** (a blank zone or a name the database does not know both count). Send to SAP also refuses a plant with no valid time zone and ingest rejects such a plant's rows, so this gate is a second guard, not the only one; keep it. The cutover SQL falls back to UTC for a plant with no time zone when it decides which orders are running; that fallback must never decide a real row. A plant listed here is a stop until its time zone is set in master data.

**5. Build the image before the migration (gate G-9).** Run the preflight and the build from the `promote-azure` skill (`az account show`, then read the current image tag) and **record the current tag as the rollback target**. Confirm CI is green for the commit being built, and that local `npm test` and `npm run check:static-assets` pass on a clean tree or a pushed commit. Build under a **fresh** tag, passing the build id so the cache-bust stamp follows the commit:

```powershell
az acr build --registry acrnimbusdev --image nimbus:vN --build-arg BUILD_ID=$(git rev-parse --short HEAD) .
az acr task list-runs --registry acrnimbusdev --top 1 -o table   # expect Succeeded
```

**Hold the roll.** Unlike a routine promotion, do not let the skill build and roll in one go here: the image is built first only so that the old image never serves planners on migrated data while a build runs. The roll is step 12. Run 1 (step 7) may follow right after this build.

**6. Quiet window and planner notice (gate G-11).** Pick the window from profile Q12 (plant time; no query can see an open browser tab). Send the notice ahead and again at the start:

- the date and time of the window;
- **save and close every browser tab before the window** (an unsaved edit goes stale when the migration gives every order a new version);
- after the roll, **hard reload** (Ctrl+F5); if the page looks unchanged, clear this site's data for the address (save first: unsaved local edits are lost);
- **unsaved offline edits in a pre-cutover cache are discarded**: the cached copy of the board in each browser (cache version 7) is thrown away on first load, so anything not yet saved to the server is lost once;
- **do not restore a Time Machine snapshot dated before the cutover** (it would put old start-anchored bars back and a Save would store them as placed finishes);
- **every bar will move to its due-date position**, and the late warnings will fire at once for every late order; the dashboard tiles and the utilization figures use the new rules too;
- whom to tell about a moved bar and how; and that the old behaviour cannot be restored once planners have saved, so "report, do not retry".

**7. Run 1, early or in the window: the placement-exception column, then the date-only flag.** The first adds a nullable column and is inert to the old image, so it may run days before the window. The second (`-Only 2026-10-16-2`, its own run, with `-AllowDestructive` because the runner reads its backfill as destructive by text) adds the date-only flag and rewrites the rows it marks, so run it at deploy time, never mid-shift, and have planners save first.

**8. Flows stopped.**

- Staging poll off: `NIMBUS_SAP_STAGING_POLL_SECONDS` is `0` (the default) or unset. If it must be changed, change it **before** the window opens (changing an environment variable creates a new revision **[unverified: platform behaviour]**).
- Every staging object on manual apply: `GET /sap/interface/objects` shows `"apply_mode": "manual"` for all of them, or `SELECT * FROM sap_sync_config;` shows `manual`. A poll with an object on automatic apply would rewrite order rows inside the window.
- Excel uploads frozen: tell every uploader. No code switch exists for this **[unverified]**.
- **Outbound `ready` queue is zero for every plant.** Check:

  ```sql
  SELECT plant, count(*) FROM sap_stage_planned_order_out WHERE row_status = 'ready' GROUP BY plant;
  ```

  Any rows listed hold a finish computed under the old rule and would reach SAP after the roll, because Mulesoft reads them on its own cadence. With the owner's explicit go, the database administrator retires them with the statement the application itself runs (outside the runner), once per plant: `UPDATE sap_stage_planned_order_out SET row_status = 'error', error_text = 'requeued', sent_at = now() WHERE plant = '<plant>' AND row_status = 'ready';`. Rows Mulesoft has already read cannot be recalled.

**9. Pre-roll capture (capturer, from the old image, per plant).** Alert counts by type and in total; the dashboard tile values (including Late and Capacity Headroom 7D); the utilization matrix by line and day for the next 14 days; the Orders grid Late filter count. Screenshot or export, filed with the rehearsal numbers. Also record the count of non-queued orders per plant for gate G-6:

```sql
SELECT plant, count(*) FROM orders WHERE planning_status <> 'needs_planning' GROUP BY plant ORDER BY plant;
```

**10. Run 2: the snapshot (`-Only`, no destructive flag).** One file, named with `-Only 2026-10-20-0` and **without** `-AllowDestructive` (the snapshot holds none of the runner's destructive words; if `-DryRun -Only 2026-10-20-0` marks it destructive, stop and read the file). Confirm afterwards that `orders_precutover_snapshot`, `order_schedule_segments_precutover_snapshot` and `order_sap_sent_precutover_snapshot` exist and that the first has as many rows as `orders`. The platform operator separately confirms the platform's own backup / point-in-time-restore window **[unverified: not visible from the repository]** and records the time.

**11. Run 3: the cutover, alone, inside the window.** Read the whole file first, comments included (the runner counts the word "update" in a comment). Apply it alone with `-Only` and the runner's own `-AllowDestructive`, and only after run 2 (the snapshot): the file raises an error and changes nothing while the snapshot's ledger id is missing. **Four separate runs, in order, never one run for several files.** The pattern for any single-file run (shown for run 3):

```powershell
.\.claude\skills\promote-azure\scripts\apply-migrations.ps1 -Only 2026-10-20-1 -DryRun                    # read the line for this file
.\.claude\skills\promote-azure\scripts\apply-migrations.ps1 -Only 2026-10-20-1 -AllowDestructive         # prompts for the password, hidden
```

Run 1 uses the same pattern with its own file (`-Only 2026-10-16-1`, then `-Only 2026-10-16-2`, each with `-AllowDestructive`), the snapshot run with `-Only 2026-10-20-0` and no destructive flag. **Exit 3 means a file was blocked: stop.** Each file and its ledger row run in one transaction, so a failure leaves nothing half-applied.

**Gate G-6** (rows updated equals the non-queued order count), as an admin login in a read-only transaction, per plant:

```sql
SELECT plant, count(*) AS flagged_non_queued FROM orders
WHERE planning_status <> 'needs_planning' AND runtime_schedule_mismatch AND updated_at >= '<time run 3 started>'
GROUP BY plant ORDER BY plant;
```

Each count must equal the step 9 count for that plant. The orders that still carry a start are the running ones (they also keep their stored end): their number should match the rehearsal's "kept their running start" figure.

**12. Roll the image, then verify with cache-busted requests, planners still out.** Roll the image built in step 5:

```powershell
az containerapp update -g rg-nimbus-dev -n ca-nimbus-dev --image acrnimbusdev.azurecr.io/nimbus:vN
```

Poll health every 15 seconds as the skill's step 4 does, **cache-busting every request** (a random query parameter and a `no-cache` header; the corporate proxy caches by URL and will serve a pre-roll page). Then request the page itself the same way (for example `GET /?cb=<random>`) and check that the `NIMBUS_BUILD_ID` it carries is the commit stamped in step 5 **[unverified: whether the proxy caches the page]**. `GET /tasks?plant=<code>` must answer 200 for each plant. Read backend errors in the browser as an administrator (Admin Cockpit, Logs); the log route answers 401 to an anonymous request, which is not a failed deploy.

**13. Open each plant once, record the toast, press Save.** The operator signs in on the admin tab, opens each plant once under the new image, lets the reconcile run, writes down the cutover summary toast it shows (the four counts; it appears only for a plant with at least 10 non-queued orders where more than half carry the cutover signature, and a smaller plant shows ordinary per-row toasts, so for it the pass bar is the step 9 / G-6 SQL counts) and presses Save. Saving persists the re-derived bars and clears the flag on the server. Expect a "stale" answer to a save only if a tab was left open across the migration. Compare the toast counts with the rehearsal's and with the step 9 capture; the alerts, tiles and utilization differences must each be explained by a named rule change. The first planner save under the new rule ends the clean rollback (step 16), so no one saves in a plant before step 14.

**14. Go / no-go (gate G-12).** Go only when the checks above are true (rehearsal passed, time-zone gate zero, G-6 equal, image verified, plants opened without unexplained differences), no `ready` outbound rows exist, and the **decider** has said go in writing. Only then tell planners they may resume.

**15. Post-roll watch (first shift, watcher).** Starting values are suggestions; the owner sets the numbers before the window.

| Signal | Source | Abort (roll back the image) if | Starting value |
|---|---|---|---|
| Plant differs from the capture without a rule that explains it | Step 13 | Any unexplained difference | 0 unexplained |
| Stale and conflict notices | `schedule.conflicts`, planner reports | More than N in the first hour | N = `<owner>` |
| Reports of a moved bar | Reports to the watcher | Any no rule explains, or more than N | N = `<owner>` |
| Server errors on `/tasks` or on a save | Admin Cockpit, Logs | Any sustained error | longer than `<owner>` minutes |
| `ready` outbound rows appear | `sap_stage_planned_order_out` | Any (nobody should press Send) | 0 |

The abort decision belongs to the decider, who must know what an abort costs (step 16): after the first save it is a fix-forward decision, not a rollback.

**16. Rollback matrix.**

| Situation | What restores | What is lost |
|---|---|---|
| The image fails **before any planner saves** under the new rule | Roll the previous image tag only (the recorded rollback target: `az containerapp update ... --image acrnimbusdev.azurecr.io/nimbus:<previous-tag>`) | No planner edit is lost. The cutover has already emptied the placed starts and ends, so old code reads those orders as never placed and shows them wherever it shows a never-placed order **[unverified: what the previous image does with orders that are flagged for a re-derive and have no placement; check it in the rehearsal by running the previous image against the migrated copy]**; the old placements are in the run-2 snapshot tables, and `migrations/manual/2026-10-20-restore-precutover-snapshot.sql` puts them back (see below) |
| Planners **have saved**, then the image rolls back | Nothing restores the old placed finishes without losing newer work; the restore script below overwrites the saved columns, so the alternatives are fix-forward or the platform's point-in-time restore, run by the operator | Every edit made after the snapshot; the restore is itself an update and bumps every row's version |
| Finishes already sent to SAP | Cannot be recalled | n/a |

**Restore script (`migrations/manual/2026-10-20-restore-precutover-snapshot.sql`, manual-only).** Rolls the pre-cutover placements, firm flags, `runtime_schedule_mismatch`, `placement_exception` and schedule segments back from the three snapshot tables, for every order that was in the snapshot (orders created later are left alone, and a snapshot segment whose order has been deleted since is skipped; the script reports how many segments it restored and how many it skipped; `updated_at` is set to the restore time so caches re-read). A restore before any planner save is exact; after a save it overwrites that save. Run it only after the previous image is back, in one transaction, as the admin login: `psql --single-transaction -f migrations/manual/2026-10-20-restore-precutover-snapshot.sql` (it lives outside `migrations/`, so the runner never lists it). It also deletes the two cutover ledger rows (`backward_cutover_snapshot`, `backward_scheduling_cutover`) from `schema_migrations` and renames the three snapshot tables to `<table>_rst_<yyyymmddhh24mi>` (the pre-cutover rows stay recoverable there; the operator drops the archived tables by hand once the window has closed), so the window can be re-run afterwards: take the snapshot again (`-Only 2026-10-20-0`) and re-apply the cutover (`-Only 2026-10-20-1`); the runner's own `migration_files_applied` rows for those two files must be deleted by the operator first, or the runner skips them as already applied.

At any rollback: **retire any `ready` outbound rows** queued under the new rule with the statement of step 8; send the planner notice again (hard reload, clear site data, do not restore snapshots dated after the cutover); and **record the rollback timestamp**. If the new image later returns, the stale placed-finish case of section 8.8a of the spec applies and needs its own decision before the roll forward.

**17. Later, per plant, in its own window: the SAP staging first apply (OQ10).** Snapshot the as-sent baselines first. The first apply resets slots where SAP's dates differ from the stored ones; those orders lose their placed finishes and re-derive from the due date on the next load by the same path. Record the reset count against the rehearsal's count, and only switch the poll on, or press an apply, inside that window.

### Executed on the pilot (2026-10-15, image nimbus:v117, commit 06bb2fc)

The cutover above was run once, on 2026-10-15 between 19:15 and 19:25 UTC, by the owner through `/promote-azure`. What was done and what was not:

- **Merge and push.** `main` at `06bb2fc` (merge of `feature/backward-scheduling`, tip `8bfe558`) was pushed to GitHub at the start of the run; GitHub CI ran on the push but nobody read it before the build. **CI OVERRIDE (2026-10-15, 06bb2fc): operator chose to override the GitHub check-run gate; no `GITHUB_TOKEN` on the deploy machine and the repository is private. Missing checks: all four workflow jobs (ESLint + JS unit tests, Generated API types in sync, Ruff, pytest with Postgres) unread at build time. Local gate that did run: `npm test` (legacy 77/77, modules 1525 pass, 0 fail, 3 todo) and `npm run check:static-assets`, both green on the tree at 06bb2fc.**
- **Rehearsal (step 3, gate G-10) was skipped by owner decision.** The pilot held 6261 orders, 25 placed, 0 running, 0 schedule segments, 0 sent-to-SAP rows; the time-zone gate (step 4) returned zero rows, the outbound `ready` queue was empty and every staging object was on manual apply.
- **Image built first** (step 5): ACR run `ch3v`, `nimbus:v117`, `BUILD_ID=06bb2fc`; rollback target `nimbus:v116` (revision `ca-nimbus-dev--0000121`).
- **Six migration runs, one file each, through the runner with `-Only`** (the password came from the deploy machine's own `.env`, consumed in-process, never typed or printed). Phase 1 was not yet in the ledger, so it went first: `2026-10-15-1` (19:22 UTC; 6261 rows backfilled with their original dates), `2026-10-15-2` (constraint `chk_orders_run_time_bounds` now `0 <= run_time < 8760`, validated), `2026-10-16-1` (nullable `placement_exception`), `2026-10-16-2` (4419 of 6261 rows flagged date-only), `2026-10-20-0` (snapshot: 6261 orders, 0 segments, 0 sent rows, 25 placed), `2026-10-20-1` (cutover at 19:23:39 UTC).
- **Gate G-6 passed:** flagged non-queued rows equal the non-queued count per plant (1008: 3826, 1085: 1842, rows with no plant: 593); 0 rows still placed (0 running, as the pre-roll count predicted); 0 markers; 0 segments.
- **Roll and verify** (step 12): revision `ca-nimbus-dev--0000122` on `nimbus:v117`, 100 % traffic, healthy; the first cache-busted health answer after the roll still came from the old process (page build id `be40b55`), the new one (`06bb2fc`, loaded 19:24:48 UTC) answered 40 s later. `/tasks?plant=1008` and `/tasks?plant=1085` answer 200; `/sap/interface/objects` answers 403 to an anonymous request (RBAC, expected).
- **Still owed from this runbook:** step 13 (open each plant as an admin, record the cutover toast, press Save), the Admin Cockpit log read, the step 9 browser capture (alerts, tiles, utilization; only the SQL counts were taken), the step 14 written go for planners, the step 15 first-shift watch, and the planner notice of step 6. Until step 13 is done no planner has saved under the new rule, so the step 16 clean rollback (roll `nimbus:v116` back, then `migrations/manual/2026-10-20-restore-precutover-snapshot.sql`) is still exact.

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
>
> **Exception (backward-scheduling cutover):** `schema.sql` now also mirrors the ledger-guarded cutover (`backward_cutover_snapshot`, then `backward_scheduling_cutover`). On a developer database that has not yet recorded those ids, re-applying `schema.sql` runs the cutover ONCE and nulls local placed finishes and schedule segments (running rows keep their start and end). Later re-applies are no-ops. On Azure the cutover ships through `migrations/` as a manual-only file, in its own `-Only ... -AllowDestructive` run, never through `schema.sql` and never from a routine promote.

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
- **`az containerapp logs show` fails behind a corporate proxy** (`SSL: CERTIFICATE_VERIFY_FAILED`, self-signed cert in chain). Read backend errors from the app's own ring buffer instead — **Admin Cockpit → Logs (Ctrl+Alt+L), signed in as an admin**. The underlying `GET /logs/backend` is RBAC-gated (`require_api_key` + `require_admin` in `backend/admin_ops/routes.py`), so an anonymous `Invoke-RestMethod` gets a 401; that is expected, not a deploy failure (confirmed 2026-10-13 on the v113 roll).
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
