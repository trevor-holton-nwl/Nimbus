<#
.SYNOPSIS
  Interactively re-apply the nimbus_mulesoft role grants (migrations/manual/2026-10-08-nimbus-mulesoft-role.sql).

.DESCRIPTION
  Re-grants the nimbus_mulesoft column-level INSERT on the SAP staging tables so
  newly added staging columns (for example meins on sap_stage_material_plant)
  are covered. The SQL file is idempotent. Run this after a migration that adds
  a staging column.

  Prompts for host, port, database and admin user (Enter accepts the bracketed
  default), then for the password (masked, only when $env:PGPASSWORD is unset).
  The password is never echoed and never placed on a command line; it is passed
  to psql through PGPASSWORD, which is cleared in a finally block.

  After the apply, a read-only query lists the INSERT-granted columns for
  nimbus_mulesoft on sap_stage_material_plant and reports OK / MISSING for meins.
  Exits nonzero on any psql failure or if meins is missing.

.PARAMETER Force
  Skip ONLY the y/n confirmation. All other prompts still run.

.EXAMPLE
  .\apply-mulesoft-role.ps1
#>
[CmdletBinding()]
param(
  [string] $PsqlPath = "C:\Program Files\PostgreSQL\18\bin\psql.exe",
  [string] $SqlFile  = '',
  [switch] $Force
)

$ErrorActionPreference = "Stop"

# $PSScriptRoot is empty inside param() defaults under `powershell -File`, so resolve paths here.
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$repoRoot = (Get-Item -LiteralPath $ScriptDir).Parent.Parent.Parent.Parent.FullName
if ([string]::IsNullOrWhiteSpace($SqlFile)) {
  $SqlFile = Join-Path $repoRoot "migrations\manual\2026-10-08-nimbus-mulesoft-role.sql"
}

# ---- Defaults, optionally from .env at the repo root ----
$envVals = @{}
$envFile = Join-Path $repoRoot ".env"
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in (Get-Content -LiteralPath $envFile)) {
    if ($line -match '^\s*(PG_HOST|PG_PORT|PG_DB|PG_USER)\s*=\s*(.*?)\s*$') {
      $envVals[$Matches[1]] = $Matches[2].Trim('"').Trim("'")
    }
  }
}
function Get-Default($key, $fallback) {
  if ($envVals.ContainsKey($key) -and $envVals[$key]) { return $envVals[$key] }
  return $fallback
}
$defHost = Get-Default 'PG_HOST' 'pgdb-nimbus-dev.postgres.database.azure.com'
$defPort = Get-Default 'PG_PORT' '5432'
$defDb   = Get-Default 'PG_DB'   'nimbus'
$defUser = Get-Default 'PG_USER' 'TempAdmin'

function Read-WithDefault([string]$label, [string]$default) {
  $v = Read-Host -Prompt "$label [$default]"
  if ([string]::IsNullOrWhiteSpace($v)) { return $default }
  return $v.Trim()
}

if (-not (Test-Path -LiteralPath $SqlFile)) { Write-Error "SQL file not found: $SqlFile"; exit 2 }
if (-not (Test-Path -LiteralPath $PsqlPath)) { Write-Error "psql not found at $PsqlPath"; exit 2 }

Write-Host ""
Write-Host "=== apply-mulesoft-role ==="
Write-Host "Re-grants the nimbus_mulesoft column-level INSERT on the SAP staging tables,"
Write-Host "so new staging columns (such as meins) are covered. Idempotent: safe to re-run."
Write-Host "Run it after a migration that adds a staging column."
Write-Host "Connects as an admin user with sslmode=require; the password is never echoed."
Write-Host ""

$PgHost   = Read-WithDefault "Host" $defHost
$portText = Read-WithDefault "Port" $defPort
$Database = Read-WithDefault "Database" $defDb
$User     = Read-WithDefault "Admin user" $defUser

$Port = 0
if (-not [int]::TryParse($portText, [ref]$Port) -or $Port -lt 1 -or $Port -gt 65535) {
  Write-Error "Invalid port: $portText"; exit 2
}
if ($User -ieq 'nimbus_mulesoft') {
  Write-Error "Refusing to run as nimbus_mulesoft; use an admin user that can GRANT."; exit 2
}

$pgPasswordWasPreset = -not [string]::IsNullOrEmpty($env:PGPASSWORD)

try {
  if (-not $pgPasswordWasPreset) {
    $securePw = Read-Host -Prompt "Password for $User@$PgHost (input hidden, not persisted)" -AsSecureString
    $env:PGPASSWORD = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
      [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePw))
  }

  Write-Host ""
  Write-Host "--- Confirm ---"
  Write-Host "host:     $PgHost"
  Write-Host "database: $Database"
  Write-Host "user:     $User"
  Write-Host "file:     $SqlFile"
  Write-Host ""
  if (-not $Force) {
    $ans = Read-Host -Prompt "Apply now? Type y or yes to continue"
    if ($ans.Trim() -notmatch '^(y|yes)$') { Write-Host "Cancelled."; exit 0 }
  }

  $conn = "host=$PgHost port=$Port dbname=$Database user=$User sslmode=require connect_timeout=15"

  Write-Host "Applying $(Split-Path -Leaf $SqlFile) ..."
  & $PsqlPath $conn -v ON_ERROR_STOP=1 -f $SqlFile
  if ($LASTEXITCODE -ne 0) { Write-Error "psql FAILED applying $SqlFile (exit $LASTEXITCODE)."; exit 1 }

  Write-Host ""
  Write-Host "Verifying INSERT-granted columns for nimbus_mulesoft on sap_stage_material_plant ..."
  $verifySql = "SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'nimbus_mulesoft' AND table_name = 'sap_stage_material_plant' AND privilege_type = 'INSERT' ORDER BY column_name;"
  $cols = & $PsqlPath $conn -t -A -v ON_ERROR_STOP=1 -c $verifySql
  if ($LASTEXITCODE -ne 0) { Write-Error "Verification query FAILED (exit $LASTEXITCODE)."; exit 1 }
  $colList = @($cols | ForEach-Object { "$_".Trim() } | Where-Object { $_ -ne "" })

  Write-Host "INSERT-granted columns ($($colList.Count)): $($colList -join ', ')"
  if ($colList -contains 'meins') {
    Write-Host "OK: meins is INSERT-granted to nimbus_mulesoft on sap_stage_material_plant."
    exit 0
  } else {
    Write-Host "MISSING: meins is NOT INSERT-granted to nimbus_mulesoft on sap_stage_material_plant."
    exit 1
  }
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
