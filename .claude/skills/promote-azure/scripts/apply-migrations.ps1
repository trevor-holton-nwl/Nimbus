<#
.SYNOPSIS
  Apply pending NIMBUS DB migrations to Postgres, safely.

.DESCRIPTION
  Guarded migration runner for the promote-azure skill. Maintains a
  `migration_files_applied` ledger so each file runs once, applies
  migrations/*.sql not yet recorded (lexicographic order), and enforces three
  safety rules:

  Two distinct ledger tables are involved, and this script owns only one of
  them:
    - `migration_files_applied (filename, applied_at)` -- THIS script's own
      per-file dedup, so a whole .sql file is never re-executed once applied.
      Owned and written here.
    - `schema_migrations (id, applied_at)` -- schema.sql's canonical ledger
      (schema.sql:20-23) for specific, named one-time DATA-MUTATING steps
      (e.g. 'plants_horizon_minutes', 'orders_mp_attrs_backfill' -- see
      docs/MIGRATION.md:884). Guarded entirely by each migration file's own
      embedded SQL (its DO blocks check/insert this by name); this script
      only bootstraps the table's existence so a file that assumes it's
      there doesn't fail on a fresh DB. Never written to by this script
      directly.
  They used to collide under one overloaded table name (both called
  `schema_migrations`, with this script's own file-tracking wrongly using
  that name) -- found and separated 2026-08-11 when Azure's live table
  turned out to be filename-keyed with no `id` column at all, because an
  earlier, unreviewed run of this script had silently created it under the
  wrong name before schema.sql's `id`-keyed design ever reached Azure.

    1. REFUSES to run schema.sql (it carries the plants x1440 data migration).
    2. BLOCKS any migration containing a destructive verb
       (ALTER/DROP/DELETE/UPDATE/TRUNCATE/RENAME/GRANT/REVOKE) unless
       -AllowDestructive is passed -- those need deliberate expand/contract
       sequencing, not a routine roll.
    2b. SKIPS any migration whose header carries the line
       `-- nimbus-migration: manual-only` (with a visible log line, in EVERY
       mode, -AllowDestructive included). A manual-only file runs only when the
       operator names it with -Only (still subject to the destructive check and
       the applied ledger). Used by the backward-scheduling snapshot + cutover.
    3. NEVER reads the DB password from Azure. The caller must set
       $env:PGPASSWORD; this script only consumes it.

  Each migration + its ledger row are applied in ONE transaction
  (--single-transaction), so a failure leaves nothing half-applied. Migrations
  must therefore be transaction-safe (no CREATE INDEX CONCURRENTLY etc.).

.PARAMETER Only
  One or more migration file names or id prefixes (e.g. `2026-10-20-0`). Applies
  EXACTLY the named file(s), in name order, and nothing else; the only way to run
  a `manual-only` file. Still subject to the destructive check and the ledger.

.PARAMETER ShowApplied
  The summary prints only a count of already-applied (ledger-skipped) files by
  default; this switch lists every filename instead.

.PARAMETER DryRun
  Touches NO database. Lists every migrations/*.sql file in order and flags
  destructive verbs. Use to preview before a real apply.

.EXAMPLE
  .\apply-migrations.ps1 -DryRun
  .\apply-migrations.ps1
  (if $env:PGPASSWORD isn't already set, you'll be prompted for it interactively
  -- it's never typed into the command line, so it never lands in shell history
  or a pasted transcript)
#>
[CmdletBinding()]
param(
  [string] $PgHost        = "pgdb-nimbus-dev.postgres.database.azure.com",
  [int]    $Port          = 5432,
  [string] $Database      = "nimbus",
  [string] $User          = "TempAdmin",
  [string] $MigrationsDir = (Join-Path (Get-Item $PSScriptRoot).Parent.Parent.Parent.Parent.FullName "migrations"),
  [string] $PsqlPath      = "C:\Program Files\PostgreSQL\18\bin\psql.exe",
  [string[]] $Only        = @(),
  [switch] $AllowDestructive,
  [switch] $DryRun,
  [switch] $ShowApplied
)

$ErrorActionPreference = "Stop"
$DESTRUCTIVE = '\b(ALTER|DROP|DELETE|UPDATE|TRUNCATE|RENAME|GRANT|REVOKE)\b'
$conn = "host=$PgHost port=$Port dbname=$Database user=$User sslmode=require connect_timeout=15"

if (-not (Test-Path $MigrationsDir)) { Write-Error "Migrations dir not found: $MigrationsDir"; exit 2 }
$files = Get-ChildItem -Path $MigrationsDir -Filter *.sql -File | Sort-Object Name
if (-not $files) { Write-Host "No migration files in $MigrationsDir -- nothing to do."; exit 0 }

$MANUAL_ONLY = '(?m)^\s*--\s*nimbus-migration:\s*manual-only'
function Test-ManualOnly([string]$path) {
  $text = Get-Content -Raw -LiteralPath $path
  return [bool]([regex]::IsMatch($text, $MANUAL_ONLY, 'IgnoreCase'))
}
function Test-Named($f) {
  foreach ($o in $Only) {
    $id = $o -replace '\.sql$',''
    if ($f.Name -ieq $o -or $f.BaseName -ieq $id -or $f.Name.StartsWith($id, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}
if ($Only.Count -gt 0) {
  $files = @($files | Where-Object { Test-Named $_ })
  if (-not $files) { Write-Error "-Only matched no migration file in $MigrationsDir"; exit 2 }
}

function Test-Destructive([string]$path) {
  $text = Get-Content -Raw -LiteralPath $path
  return [bool]([regex]::IsMatch($text, $DESTRUCTIVE, 'IgnoreCase'))
}

# ---- DRY RUN: no DB connection ----
if ($DryRun) {
  Write-Host "DRY RUN -- no database connection. Files in '$MigrationsDir' (apply order):"
  Write-Host ""
  foreach ($f in $files) {
    if ($f.Name -ieq 'schema.sql') { $tag = 'REFUSED (schema.sql)' }
    elseif ((Test-ManualOnly $f.FullName) -and $Only.Count -eq 0) { $tag = 'MANUAL-ONLY -> skipped (apply with -Only)' }
    elseif (Test-Destructive $f.FullName) { $tag = 'DESTRUCTIVE -> blocked unless -AllowDestructive' }
    else { $tag = 'additive (auto)' }
    "{0,-40} {1}" -f $f.Name, $tag
  }
  Write-Host ""
  Write-Host "At real apply time, only files NOT already in the migration_files_applied ledger will run."
  exit 0
}

# ---- REAL APPLY: requires password ----
# Never pulled from Azure. If the caller hasn't already set $env:PGPASSWORD,
# prompt for it interactively (masked) so it never appears as literal text in
# a command line, shell history, or a pasted transcript. Cleared in `finally`
# below regardless of how the script exits.
$pgPasswordWasPreset = -not [string]::IsNullOrEmpty($env:PGPASSWORD)
if (-not $pgPasswordWasPreset) {
  $securePw = Read-Host -Prompt "PGPASSWORD for $User@$PgHost (input hidden, not persisted)" -AsSecureString
  $env:PGPASSWORD = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePw))
}
if (-not (Test-Path $PsqlPath)) { Write-Error "psql not found at $PsqlPath"; exit 2 }

try {

# Ensure THIS script's own ledger (migration_files_applied, keyed by
# filename) -- separate from schema_migrations (id-keyed), which belongs to
# schema.sql and is bootstrapped independently below. Never overload one
# table for both; that's the exact collision this design replaced.
& $PsqlPath $conn -v ON_ERROR_STOP=1 -q -c "CREATE TABLE IF NOT EXISTS migration_files_applied (filename TEXT PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT NOW());"
if ($LASTEXITCODE -ne 0) { Write-Error "Could not ensure migration_files_applied ledger (check connectivity/firewall/password)."; exit 1 }

# Bootstrap schema_migrations too (id-keyed, schema.sql:20-23's exact
# definition) -- migration files' own DO blocks read/write it directly by
# name (e.g. 'orders_mp_attrs_backfill', docs/MIGRATION.md:884) and assume
# it already exists. This script never writes rows here itself.
& $PsqlPath $conn -v ON_ERROR_STOP=1 -q -c "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT NOW());"
if ($LASTEXITCODE -ne 0) { Write-Error "Could not ensure schema_migrations ledger (check connectivity/firewall/password)."; exit 1 }

$appliedRaw = & $PsqlPath $conn -t -A -v ON_ERROR_STOP=1 -c "SELECT filename FROM migration_files_applied;"
if ($LASTEXITCODE -ne 0) { Write-Error "Could not read migration_files_applied ledger."; exit 1 }
$applied = @($appliedRaw | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })

$didApply = @(); $blocked = @(); $skipped = @(); $manual = @()
foreach ($f in $files) {
  if ($f.Name -ieq 'schema.sql') { Write-Warning "Refusing schema.sql (x1440 data migration) -- skipped."; $blocked += $f.Name; continue }
  if ($applied -contains $f.Name) { $skipped += $f.Name; continue }
  if ((Test-ManualOnly $f.FullName) -and $Only.Count -eq 0) {
    Write-Warning "SKIPPED (manual-only): $($f.Name). Apply it deliberately with -Only $($f.BaseName)."
    $manual += $f.Name; continue
  }
  if ((Test-Destructive $f.FullName) -and -not $AllowDestructive) {
    Write-Warning "BLOCKED (destructive verb): $($f.Name). Re-run with -AllowDestructive only after deliberate review."
    $blocked += $f.Name; continue
  }
  $safe = $f.Name -replace "'", "''"
  Write-Host "Applying $($f.Name) ..."
  & $PsqlPath $conn --single-transaction -v ON_ERROR_STOP=1 -f $f.FullName -c "INSERT INTO migration_files_applied (filename) VALUES ('$safe') ON CONFLICT (filename) DO NOTHING;"
  if ($LASTEXITCODE -ne 0) { Write-Error "Migration FAILED (rolled back): $($f.Name). Stopping."; exit 1 }
  $didApply += $f.Name
}

if ($didApply) { $applStr = $didApply -join ', ' } else { $applStr = '(none)' }
if ($ShowApplied) {
  if ($skipped) { $skipStr = $skipped -join ', ' } else { $skipStr = '(none)' }
} else {
  $skipStr = "$(@($skipped).Count) files (in ledger, skipped)"
}
if ($blocked)  { $blockStr = $blocked -join ', ' } else { $blockStr = '(none)' }

Write-Host ""
Write-Host "--- Migration summary ---"
Write-Host "applied:         $applStr"
Write-Host "already-applied: $skipStr"
Write-Host "blocked:         $blockStr"
if ($manual) { Write-Host "manual-only (skipped, use -Only): $($manual -join ', ')" }
if ($blocked.Count -gt 0) { Write-Warning "One or more migrations were blocked -- resolve deliberately before the roll."; exit 3 }
exit 0

} finally {
  # Clear the password from this process's env regardless of how we exit --
  # whether we prompted for it or the caller pre-set it.
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
