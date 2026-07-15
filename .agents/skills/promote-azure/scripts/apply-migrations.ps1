<#
.SYNOPSIS
  Apply pending NIMBUS DB migrations to Postgres, safely.

.DESCRIPTION
  Guarded migration runner for the promote-azure skill. Maintains a
  `schema_migrations` ledger so each file runs once, applies migrations/*.sql
  not yet recorded (lexicographic order), and enforces three safety rules:

    1. REFUSES to run schema.sql (it carries the plants x1440 data migration).
    2. BLOCKS any migration containing a destructive verb
       (ALTER/DROP/DELETE/UPDATE/TRUNCATE/RENAME/GRANT/REVOKE) unless
       -AllowDestructive is passed -- those need deliberate expand/contract
       sequencing, not a routine roll.
    3. NEVER reads the DB password from Azure. The caller must set
       $env:PGPASSWORD; this script only consumes it.

  Each migration + its ledger row are applied in ONE transaction
  (--single-transaction), so a failure leaves nothing half-applied. Migrations
  must therefore be transaction-safe (no CREATE INDEX CONCURRENTLY etc.).

.PARAMETER DryRun
  Touches NO database. Lists every migrations/*.sql file in order and flags
  destructive verbs. Use to preview before a real apply.

.EXAMPLE
  $env:PGPASSWORD = '...'; .\apply-migrations.ps1 -DryRun
  $env:PGPASSWORD = '...'; .\apply-migrations.ps1
#>
[CmdletBinding()]
param(
  [string] $PgHost        = "pgdb-nimbus-dev.postgres.database.azure.com",
  [int]    $Port          = 5432,
  [string] $Database      = "nimbus",
  [string] $User          = "TempAdmin",
  [string] $MigrationsDir = "migrations",
  [string] $PsqlPath      = "C:\Program Files\PostgreSQL\18\bin\psql.exe",
  [switch] $AllowDestructive,
  [switch] $DryRun
)

$ErrorActionPreference = "Stop"
$DESTRUCTIVE = '\b(ALTER|DROP|DELETE|UPDATE|TRUNCATE|RENAME|GRANT|REVOKE)\b'
$conn = "host=$PgHost port=$Port dbname=$Database user=$User sslmode=require connect_timeout=15"

if (-not (Test-Path $MigrationsDir)) { Write-Error "Migrations dir not found: $MigrationsDir"; exit 2 }
$files = Get-ChildItem -Path $MigrationsDir -Filter *.sql -File | Sort-Object Name
if (-not $files) { Write-Host "No migration files in $MigrationsDir -- nothing to do."; exit 0 }

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
    elseif (Test-Destructive $f.FullName) { $tag = 'DESTRUCTIVE -> blocked unless -AllowDestructive' }
    else { $tag = 'additive (auto)' }
    "{0,-40} {1}" -f $f.Name, $tag
  }
  Write-Host ""
  Write-Host "At real apply time, only files NOT already in the schema_migrations ledger will run."
  exit 0
}

# ---- REAL APPLY: requires password ----
if ([string]::IsNullOrEmpty($env:PGPASSWORD)) {
  Write-Error "PGPASSWORD is not set. Set `$env:PGPASSWORD before running (never pulled from Azure)."
  exit 2
}
if (-not (Test-Path $PsqlPath)) { Write-Error "psql not found at $PsqlPath"; exit 2 }

# Ensure ledger, then read applied set.
& $PsqlPath $conn -v ON_ERROR_STOP=1 -q -c "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());"
if ($LASTEXITCODE -ne 0) { Write-Error "Could not ensure schema_migrations ledger (check connectivity/firewall/password)."; exit 1 }

$appliedRaw = & $PsqlPath $conn -t -A -v ON_ERROR_STOP=1 -c "SELECT filename FROM schema_migrations;"
if ($LASTEXITCODE -ne 0) { Write-Error "Could not read schema_migrations ledger."; exit 1 }
$applied = @($appliedRaw | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })

$didApply = @(); $blocked = @(); $skipped = @()
foreach ($f in $files) {
  if ($f.Name -ieq 'schema.sql') { Write-Warning "Refusing schema.sql (x1440 data migration) -- skipped."; $blocked += $f.Name; continue }
  if ($applied -contains $f.Name) { $skipped += $f.Name; continue }
  if ((Test-Destructive $f.FullName) -and -not $AllowDestructive) {
    Write-Warning "BLOCKED (destructive verb): $($f.Name). Re-run with -AllowDestructive only after deliberate review."
    $blocked += $f.Name; continue
  }
  $safe = $f.Name -replace "'", "''"
  Write-Host "Applying $($f.Name) ..."
  & $PsqlPath $conn --single-transaction -v ON_ERROR_STOP=1 -f $f.FullName -c "INSERT INTO schema_migrations (filename) VALUES ('$safe') ON CONFLICT (filename) DO NOTHING;"
  if ($LASTEXITCODE -ne 0) { Write-Error "Migration FAILED (rolled back): $($f.Name). Stopping."; exit 1 }
  $didApply += $f.Name
}

if ($didApply) { $applStr = $didApply -join ', ' } else { $applStr = '(none)' }
if ($skipped)  { $skipStr = $skipped  -join ', ' } else { $skipStr = '(none)' }
if ($blocked)  { $blockStr = $blocked -join ', ' } else { $blockStr = '(none)' }

Write-Host ""
Write-Host "--- Migration summary ---"
Write-Host "applied:         $applStr"
Write-Host "already-applied: $skipStr"
Write-Host "blocked:         $blockStr"
if ($blocked.Count -gt 0) { Write-Warning "One or more migrations were blocked -- resolve deliberately before the roll."; exit 3 }
exit 0
