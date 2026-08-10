---
name: promote-azure
description: Use when shipping NIMBUS changes to the Azure Container Apps pilot (rg-nimbus-dev) — application code, dependencies, and/or database schema — i.e. building+rolling the container image and applying pending DB migrations.
---

# Promote NIMBUS to Azure

## Overview

Streamlines a NIMBUS promotion into one guarded sequence. **Core principle: code is cheap to roll back (re-point the app at the previous image tag); a bad DB change usually is not.** So schema changes are applied *before* the roll, behind a ledger + a destructive-statement gate, and the full `schema.sql` is **never** run against a live DB.

This consolidates the authoritative runbook in `DEPLOYMENT.md` — read that file for full detail and the resource table; this skill is the decision logic + the streamlined steps + the guardrails.

## Hard rules (never violate)

- **NEVER run `schema.sql` against the live DB.** It re-multiplies `plants` horizon columns ×1440 on every run (`schema.sql` ~line 110). Apply schema changes only via files in `migrations/`.
- **NEVER read/echo the `pg-pass` secret** (`az containerapp secret show`). The operator supplies the DB password at runtime — `apply-migrations.ps1` prompts for it interactively (masked, `-AsSecureString`) when `$env:PGPASSWORD` isn't already set, so it's never typed into a command line, shell history, or a pasted transcript. Never ask the operator to paste the password into chat; have them run the script themselves.
- **NEVER reuse an image tag.** A fresh `vN` is what makes rollback a one-liner.
- **Confirm before each prod mutation** (migration apply, image build, app roll). Auto-mode will gate these — that's expected; surface the command and get explicit go-ahead.
- **Do not set `NIMBUS_SAP_SYNC_ENABLED`** unless the operator explicitly wants the SAP scheduler live (it's a stub skeleton).

## Sequence

### 0. Preflight (read-only — safe to run)
```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
$env:PYTHONIOENCODING = "utf-8"
az account show --query "{sub:name,user:user.name}" -o json   # expect Quantum Leap Playground
az containerapp show -g rg-nimbus-dev -n ca-nimbus-dev --query "properties.template.containers[0].image" -o tsv  # current tag -> next vN, and the ROLLBACK target
```
- **Version stamp:** if frontend (`app.js`/`index.html`/`styles.css`) changed, confirm `APP_VERSION` (app.js) == `NIMBUS_BUILD_ID` (index.html) == `styles.css?v=` and bump all three to a new dated tag. **Do not auto-commit** the bump — surface it; the operator decides when to commit (they may be on a feature branch with unrelated changes).
- Decide what changed: code only? deps? schema? (schema → step 1 is required.)

### 1. DB migration FIRST — only if schema changed (guarded)
Run from a host with `psql` + DB firewall access (the dev laptop's `DevLaptop` rule, or Azure Cloud Shell). The script's paths are resolved from its own location (`$PSScriptRoot`-relative), so it works from **any** starting directory — give it as an absolute path, no `cd` to the repo required:
```powershell
& "C:\Users\PJ29587\OneDrive - Newell Brands\Documents\AI_ML Testing\Claude\.claude\skills\promote-azure\scripts\apply-migrations.ps1" -DryRun
& "C:\Users\PJ29587\OneDrive - Newell Brands\Documents\AI_ML Testing\Claude\.claude\skills\promote-azure\scripts\apply-migrations.ps1"
```
- The real-apply run **prompts for the password interactively** (`Read-Host -AsSecureString`) if `$env:PGPASSWORD` isn't already set — the operator types/pastes it at that prompt, never into the command itself, and it's cleared from the process environment in a `finally` block on exit either way. Never pre-type `$env:PGPASSWORD = '...'` into a message to Claude; just run the script and answer its prompt.
- A pending migration that trips the destructive-verb filter but is actually additive/idempotent (verified by reading the file — e.g. `ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO NOTHING`) can be forced through with `-AllowDestructive`. Already-applied files (per the ledger) are skipped regardless of that flag, so it only affects genuinely new files.
- The script maintains a `schema_migrations` ledger (run-once semantics), applies `migrations/*.sql` not yet recorded in lexicographic order, **refuses `schema.sql`**, and **blocks any file containing `ALTER/DROP/DELETE/UPDATE/TRUNCATE/RENAME/GRANT/REVOKE`** unless re-run with `-AllowDestructive` (those need expand/contract sequencing — treat as a deliberate, separate decision, not part of a routine roll).
- Schema goes before the roll so the new code never serves traffic against missing tables.

### 2. Build the image (fresh tag)
```powershell
az acr build --registry acrnimbusdev --image nimbus:vN .   # N = current + 1
az acr task list-runs --registry acrnimbusdev --top 1 -o table   # confirm Succeeded (Windows log stream may crash; build still succeeds)
```

### 3. Roll the app
```powershell
az containerapp update -g rg-nimbus-dev -n ca-nimbus-dev --image acrnimbusdev.azurecr.io/nimbus:vN
```

### 4. Verify
```powershell
$fqdn = az containerapp show -g rg-nimbus-dev -n ca-nimbus-dev --query properties.configuration.ingress.fqdn -o tsv
Invoke-RestMethod "https://$fqdn/health"                  # db.connected: true
Invoke-RestMethod "https://$fqdn/sap/interface/objects"   # 200 (proves new tables + endpoints live, if SAP shipped)
Invoke-RestMethod "https://$fqdn/logs/backend"            # read errors here — `az logs` dies behind the corp proxy
```

### 5. Rollback (if verify fails)
```powershell
az containerapp update -g rg-nimbus-dev -n ca-nimbus-dev --image acrnimbusdev.azurecr.io/nimbus:<previous-tag>
```
Additive migrations need no rollback (unused by old code). Destructive ones are why step 1 gates them.

## Resource reference
RG `rg-nimbus-dev` · ACR `acrnimbusdev` · app `ca-nimbus-dev` · env `cae-nimbus-dev` · PG `pgdb-nimbus-dev`/`nimbus`/`TempAdmin` · sub `cf82eecb-e714-440e-83b0-7e92a12cb728` · single-replica (min=max=1) · `/data` ephemeral · no SSO (open URL). Full detail + first-time provisioning: `DEPLOYMENT.md`.

## Red flags — STOP
- About to run `psql ... -f schema.sql` against prod → **STOP**, use `migrations/`.
- About to `az containerapp secret show pg-pass` → **STOP**, ask the operator for the password.
- About to overwrite an existing image tag → **STOP**, bump to a new `vN`.
- A pending migration contains a destructive verb → **STOP**, do not fold it into a routine roll; sequence it deliberately.
