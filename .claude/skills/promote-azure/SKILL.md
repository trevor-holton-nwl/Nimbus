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
- **Build, roll, and verify run automatically, always — no pause for go-ahead.** Image build (step 2), app roll (step 3), and verification (step 4) proceed straight through without stopping for confirmation. Narrate each command as it runs so the operator can see what's happening, but don't wait on a response before continuing.
- **Migration apply is the one step that still gates on confirmation** — surface the pending migration file(s) and the dry-run output, and get explicit go-ahead before running the real apply. This is deliberate asymmetry: code/roll is a one-liner rollback, a bad schema change usually isn't.
- **A destructive migration is never folded into an auto run**, confirmation gate or not — stop and sequence it as its own deliberate decision (see Red flags).
- **CI gate before build.** Never run `az acr build` until the step 1b CI gate passes (GitHub check-runs green for HEAD + local `npm test` + `check:static-assets`), or the operator passes `-OverrideCi "<reason>"` and the reason is recorded in the deploy note.
- **Do not set `NIMBUS_SAP_SYNC_ENABLED`** unless the operator explicitly wants the SAP scheduler live (it's a stub skeleton).

## Sequence

### 0. Preflight (read-only — safe to run)
```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
$env:PYTHONIOENCODING = "utf-8"
az account show --query "{sub:name,user:user.name}" -o json   # expect Quantum Leap Playground
az containerapp show -g rg-nimbus-dev -n ca-nimbus-dev --query "properties.template.containers[0].image" -o tsv  # current tag -> next vN, and the ROLLBACK target
```
- **Version stamp:** if frontend (`frontend/app.js`/`frontend/index.html`/`frontend/styles.css`) changed, the image build stamps `NIMBUS_BUILD_ID` and `styles.css?v=` (both in `frontend/index.html`, consumed by `frontend/app-entry.mjs`'s `runCacheBustGuard`) from the git SHA — pass `--build-arg BUILD_ID=$(git rev-parse --short HEAD)` to `az acr build`; confirm the arg was passed (without it the hand-set stamp in `index.html` ships unchanged, so also check the two values match each other). (The old separate `APP_VERSION` constant in `app.js` was removed — don't look for it.) **Do not auto-commit** the bump — surface it; the operator decides when to commit (they may be on a feature branch with unrelated changes).
- Decide what changed: code only? deps? schema? (schema → step 1 is required.)

### 1. DB migration FIRST — only if schema changed (guarded)
Run from a host with `psql` + DB firewall access (the dev laptop's `DevLaptop` rule, or Azure Cloud Shell). The script's paths are resolved from its own location (`$PSScriptRoot`-relative), so it works from **any** starting directory — give it as an absolute path, no `cd` to the repo required:
```powershell
& "C:\Users\PJ29587\OneDrive - Newell Brands\Documents\AI_ML Testing\Claude\.claude\skills\promote-azure\scripts\apply-migrations.ps1" -DryRun
& "C:\Users\PJ29587\OneDrive - Newell Brands\Documents\AI_ML Testing\Claude\.claude\skills\promote-azure\scripts\apply-migrations.ps1"
```
- The real-apply run **prompts for the password interactively** (`Read-Host -AsSecureString`) if `$env:PGPASSWORD` isn't already set — the operator types/pastes it at that prompt, never into the command itself, and it's cleared from the process environment in a `finally` block on exit either way. Never pre-type `$env:PGPASSWORD = '...'` into a message to Claude; just run the script and answer its prompt.
- A pending migration that trips the destructive-verb filter but is actually additive/idempotent (verified by reading the file — e.g. `ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO NOTHING`) can be forced through with `-AllowDestructive`. Already-applied files (per the ledger) are skipped regardless of that flag, so it only affects genuinely new files.
- The script maintains its own `migration_files_applied` ledger (run-once semantics, keyed by filename) — distinct from `schema_migrations` (id-keyed, owned by schema.sql for named one-time data mutations like `plants_horizon_minutes`; the script only bootstraps that table's existence, never writes to it). They collided under one overloaded name until 2026-08-11 — see the fix commit and the script's own header comment for the full story. Applies `migrations/*.sql` not yet recorded in lexicographic order, **refuses `schema.sql`**, and **blocks any file containing `ALTER/DROP/DELETE/UPDATE/TRUNCATE/RENAME/GRANT/REVOKE`** unless re-run with `-AllowDestructive` (those need expand/contract sequencing — treat as a deliberate, separate decision, not part of a routine roll).
- Schema goes before the roll so the new code never serves traffic against missing tables.

### 1b. CI gate — required before `az acr build` (read-only, safe to run)
Deploys build from the working tree, so nothing else stops a red or untested commit from shipping. Before step 2, **all three** must hold for the exact commit being built (`git rev-parse HEAD`; the tree must be clean or the build must be of a pushed commit):

1. **GitHub Actions check-runs for HEAD are green.** There is no `gh` CLI on this machine, so use the REST API with a token in an env var (`$env:GITHUB_TOKEN`, a fine-grained read-only token with Actions/Checks read on the repo; the operator sets it, never paste it into chat or a command line). Push HEAD first if needed.
```powershell
$sha  = (git rev-parse HEAD).Trim()
$h    = @{ Authorization = "Bearer $env:GITHUB_TOKEN"; Accept = "application/vnd.github+json"; "X-GitHub-Api-Version" = "2022-11-28" }
$runs = (Invoke-RestMethod "https://api.github.com/repos/trevor-holton-nwl/Nimbus/commits/$sha/check-runs?per_page=100" -Headers $h).check_runs
$runs | Select-Object name, status, conclusion | Format-Table
# PASS only if at least one run exists, every run is completed, and every conclusion is success/skipped/neutral.
$bad = $runs | Where-Object { $_.status -ne 'completed' -or $_.conclusion -notin 'success','skipped','neutral' }
if (-not $runs -or $bad) { throw "CI is not green for $sha - stop (or use -OverrideCi, below)" }
```
   Zero check-runs means CI has not run for that SHA: that is a failure, not a pass.
2. **`npm test`** passes locally (it runs the build first).
3. **`npm run check:static-assets`** passes locally.

**Escape hatch: `-OverrideCi "<reason>"`.** For an urgent hotfix (e.g. a known-flaky timing test blocking an otherwise-good commit), the operator may invoke the promotion as `promote-azure -OverrideCi "<reason>"`. This skips only the GitHub check-run requirement in item 1 (never the local `npm test` / `check:static-assets` unless the reason names why they cannot run). A non-empty reason is mandatory, and it must be written into the deploy note together with the HEAD sha, the failing/missing check names and the date, e.g. `CI OVERRIDE (<date>, <sha>): <reason>; failing: <checks>`. Without `-OverrideCi`, a red/missing gate means stop and report; do not proceed to step 2.

### 2. Build the image (fresh tag) — automatic, no pause
```powershell
az acr build --registry acrnimbusdev --image nimbus:vN --build-arg BUILD_ID=$(git rev-parse --short HEAD) .   # N = current + 1; BUILD_ID stamps NIMBUS_BUILD_ID + styles.css?v= from the git SHA
az acr task list-runs --registry acrnimbusdev --top 1 -o table   # confirm Succeeded (Windows log stream may crash; build still succeeds)
```
Run straight through; don't stop for go-ahead. If the build fails, stop and report — don't retry blindly.

### 3. Roll the app — automatic, no pause
```powershell
az containerapp update -g rg-nimbus-dev -n ca-nimbus-dev --image acrnimbusdev.azurecr.io/nimbus:vN
```
Run straight through; don't stop for go-ahead.

### 4. Verify — active polling every 15s, not a single lazy check
One-shot checks miss a container still spinning up or a revision still transitioning. Poll on a 15-second cadence until healthy or a timeout is hit, cache-busting every request (the corp proxy caches keyed on URL and will serve a pre-roll response, faking a failed deploy):
```powershell
$fqdn = az containerapp show -g rg-nimbus-dev -n ca-nimbus-dev --query properties.configuration.ingress.fqdn -o tsv
$deadline = (Get-Date).AddMinutes(5)
$healthy = $false
while ((Get-Date) -lt $deadline) {
    try {
        $cb = Get-Random
        $resp = Invoke-RestMethod "https://$fqdn/health?cb=$cb" -Headers @{ "Cache-Control" = "no-cache" }
        if ($resp.db.connected) { $healthy = $true; break }
    } catch {}
    Start-Sleep -Seconds 15
}
if (-not $healthy) { throw "Health check did not pass within 5 minutes — read the backend log in Admin Cockpit (below), then consider rollback (step 5)" }
Invoke-RestMethod "https://$fqdn/sap/interface/objects?cb=$(Get-Random)" -Headers @{ "Cache-Control" = "no-cache" }   # 200 (proves new tables + endpoints live, if SAP shipped)
```
Then read backend errors **in the browser, signed in as an admin: Admin Cockpit → Logs** (Ctrl+Alt+L). `GET /logs/backend` is RBAC-gated (`require_api_key` + `require_admin`, `backend/admin_ops/routes.py`) and returns 401 to an anonymous `Invoke-RestMethod` and to a bare session cookie — that 401 is correct, not a deploy failure. `az containerapp logs show` still dies behind the corp proxy, so the Cockpit viewer is the log source.

If the deadline is hit without a healthy response, stop and report — do not fall back to a single lazy check, and do not silently retry the roll.

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
