# NIMBUS stale-data cleanup review

> Review ledger created 2026-08-22. This file is intentionally read-only: it
> reports status, references, sizes, and diffs but never deletes files, removes
> worktrees, deletes branches, runs `git gc`, or connects to PostgreSQL.

Use this document to decide what can be archived or removed. Re-run the audit
commands before acting; the repository may have changed since this snapshot.

## Decision ranking

| Rank | Decision | Meaning |
|---|---|---|
| **1** | **Delete now** | Rebuildable cache only, after confirming no process needs it. |
| **1B** | **Delete/recreate** | Large disposable environment such as `.venv` or `node_modules`; remove only if you can reinstall it. |
| **2** | **Open code differences** | Worktree, branch, untracked file, or snapshot. Diff and preserve unique content before removal. |
| **3** | **Archive** | Historical plans/reviews that are useful for provenance but should not compete with current project guidance. |
| **4** | **Consolidate** | Duplicated or drift-prone instructions/configuration; edit after choosing the canonical source. |
| **5** | **Preserve** | Active work, runtime assets, migrations, fixtures, or compatibility surfaces. |
| **6** | **Defer** | Git object/database cleanup requiring a separate backup, deployment, or local-database decision. |

## Current ranked inventory

| Rank | Candidate | Evidence from the last audit | Review action |
|---|---|---|---|
| **1** | `.pytest_cache/`, `.ruff_cache/`, `.mypy_cache/` | Rebuildable caches; approximately 10.5 MiB combined, mostly `.mypy_cache`. | Confirm no test/type-check process is running, then clear. |
| **1B** | `.venv/`, `node_modules/` | Rebuildable environments, approximately 358 MiB and 52 MiB. | Remove only if `pip install -r requirements.txt` and `npm install` are acceptable afterward. |
| **2** | `.worktrees/de-lint-baseline-check` | 9.2 MiB; no matching `.git/worktrees/` metadata; last written 2026-08-21. | Compare against `main`; preserve any unique files before removal. |
| **2** | `.worktrees/workstream-a-fixes` | 10.7 MiB; no matching Git metadata; last written 2026-08-21. | Diff first; likely an orphaned agent snapshot. |
| **2** | `.worktrees/workstream-b-optimizer-scheduling` | 11.5 MiB; no matching Git metadata; last written 2026-08-21. | Diff first; it may contain optimizer WIP. |
| **2** | `.worktrees/workstream-d-e-review` | 10.8 MiB; no matching Git metadata; last written 2026-08-21. | Diff first; preserve review artifacts if unique. |
| **2** | `.claude/worktrees/agent-a40fa30aaf3cd7dce` and `agent-aa83fa0120e4c2b4a` | Two broken-pointer snapshots, approximately 7.7 MiB total; each contains a migration not present in `main`. | Review `orders-rush-flag.sql` and `notification-prefs.sql`; do not delete blindly. |
| **2** | Registered `split-order` worktree | Clean, approximately 7.1 MiB, branch tip is merged into `main`. | Review branch history, then retire the worktree and branch if no longer needed. |
| **2** | Registered `changeover-matrix-stage-0` worktree | Merged branch, approximately 62 MiB, but four untracked docs differ from root copies. | Compare `docs/changeover_matrix*.md`, `docs/setup_debate.md`, and `docs/Setup_teardown_bars.md`. |
| **2** | External `Claude-worktree-command-band-reskin` | Merged branch, approximately 178 MiB; dashboard prototype matches root, but `UI_FRONTEND_MIGRATION.md` is untracked. | Preserve or archive the migration note before retiring the worktree. |
| **3** | `.planning/codebase/` | Seven files, last updated 2026-06-17 through 2026-06-30; describes retired `GLOBAL_CW`, old CORS, and the pre-module-extraction frontend. | Regenerate or archive as one snapshot; do not use it as current architecture guidance. |
| **3** | `docs/superpowers/plans/` | 27 plan files, approximately 991 KiB, with 914 unchecked and 141 checked items. | Archive completed July/early-August plans; retain active August 20–21 workstreams. |
| **3** | `APPLICATION_REVIEW.md` and `Nimbus Dashboard.dc.html` | Approximately 38 KiB and 44 KiB; no inbound references were found in tracked text. | Archive or remove only after confirming they are not needed as design/review references. |
| **4** | `AGENTS.md` and `CLAUDE.md` | Approximately 93 KiB combined; overlapping project guidance updated on different dates. | Choose one canonical guide and make the other a short redirect/supplement. |
| **4** | `COLOR_FILE` deployment/config references | No current executable runtime read was found, but Docker, CI, and historical docs still mention it. | Remove the vestigial setting and update current deployment docs after a code review. |
| **5** | `migrations/`, `sample-data/`, generated `web/*.mjs`, and legacy color-wheel routes/table | These are runtime, deployment, fixture, or compatibility surfaces; grep alone cannot prove them dead. | Preserve. Review only as part of an explicit migration/compatibility change. |
| **6** | Git unreachable objects | 163 unreachable commits and 472 unreachable objects, many recent WIP/index snapshots. | Do not run `git gc` yet; recover or intentionally reject WIP first. |
| **6** | PostgreSQL rows/tables | Not audited here because the configured `.env` may point at the Azure pilot. | Use a separate local, read-only database audit before any data deletion or DDL. |

## Read-only audit runner

Run from the repository root in PowerShell. It prints the current state and
compares source trees while skipping environments, caches, generated worktrees,
and `.git` internals. A non-zero exit from `git diff --no-index` means files
differ; it is not a deletion instruction.

```powershell
$ErrorActionPreference = 'Continue'
$ProjectRoot = (Get-Location).Path
$ParentRoot = Split-Path -Parent $ProjectRoot

function Get-SizeMiB([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $Files = @(Get-ChildItem -LiteralPath $Path -File -Recurse -Force -ErrorAction SilentlyContinue)
    $Bytes = ($Files | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $Bytes) { $Bytes = 0 }
    return [math]::Round($Bytes / 1MB, 2)
}

function Get-TreeIndex([string] $Base) {
    $Resolved = (Resolve-Path -LiteralPath $Base).Path.TrimEnd('\')
    $Skip = '\\(?:\.git|\.venv|node_modules|\.worktrees|\.claude\\worktrees|\.superpowers|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)(?:\\|$)'
    $Index = @{}
    Get-ChildItem -LiteralPath $Resolved -File -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch $Skip } |
        ForEach-Object {
            $Relative = $_.FullName.Substring($Resolved.Length + 1)
            try { $Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
            catch { $Hash = '<unreadable>' }
            $Index[$Relative] = [pscustomobject]@{ Hash = $Hash; Bytes = $_.Length }
        }
    return $Index
}

function Compare-SourceTrees([string] $Left, [string] $Right) {
    $L = Get-TreeIndex $Left
    $R = Get-TreeIndex $Right
    $Paths = @($L.Keys + $R.Keys | Sort-Object -Unique)
    $Rows = foreach ($Path in $Paths) {
        $HasL = $L.ContainsKey($Path)
        $HasR = $R.ContainsKey($Path)
        if (-not $HasL) { $Kind = 'only-right' }
        elseif (-not $HasR) { $Kind = 'only-left' }
        elseif ($L[$Path].Hash -ne $R[$Path].Hash) { $Kind = 'different' }
        else { continue }
        [pscustomobject]@{ Kind = $Kind; Path = $Path }
    }
    $Rows | Group-Object Kind | Select-Object Name, Count | Format-Table -AutoSize
    $Rows | Where-Object { $_.Kind -ne 'different' -or $_.Path -match '(?i)(\.sql$|\.md$|continue|handoff|report|brief)' } |
        Select-Object -First 80 | Format-Table -AutoSize
}

Write-Host '=== ROOT STATUS ===' -ForegroundColor Cyan
git status --short --branch

Write-Host '=== LOCAL MAIN AHEAD OF ORIGIN ===' -ForegroundColor Cyan
git log --oneline --decorate origin/main..main

Write-Host '=== REGISTERED WORKTREES ===' -ForegroundColor Cyan
git worktree list
Write-Host '=== GIT WORKTREE DRY-RUN PRUNE ===' -ForegroundColor Cyan
git worktree prune --dry-run

Write-Host '=== WORKTREE DIRECTORY SIZES ===' -ForegroundColor Cyan
Get-ChildItem -LiteralPath (Join-Path $ProjectRoot '.worktrees') -Directory -Force -ErrorAction SilentlyContinue |
    ForEach-Object {
        $Metadata = Join-Path $ProjectRoot (Join-Path '.git\worktrees' $_.Name)
        [pscustomobject]@{
            Path = $_.FullName
            MiB = Get-SizeMiB $_.FullName
            GitMetadataExists = Test-Path -LiteralPath $Metadata
            LastWrite = $_.LastWriteTime
        }
    } | Sort-Object MiB -Descending | Format-Table -AutoSize

Write-Host '=== BROKEN/UNREGISTERED SNAPSHOT DIFFS ===' -ForegroundColor Cyan
foreach ($Name in @('de-lint-baseline-check', 'workstream-a-fixes', 'workstream-b-optimizer-scheduling', 'workstream-d-e-review')) {
    $Snapshot = Join-Path $ProjectRoot (Join-Path '.worktrees' $Name)
    if (Test-Path -LiteralPath $Snapshot) {
        Write-Host "--- $Name ---"
        Compare-SourceTrees $ProjectRoot $Snapshot
    }
}
foreach ($Name in @('agent-a40fa30aaf3cd7dce', 'agent-aa83fa0120e4c2b4a')) {
    $Snapshot = Join-Path $ProjectRoot (Join-Path '.claude\worktrees' $Name)
    if (Test-Path -LiteralPath $Snapshot) {
        Write-Host "--- .claude/worktrees/$Name ---"
        Compare-SourceTrees $ProjectRoot $Snapshot
    }
}

Write-Host '=== REGISTERED WORKTREE STATUS/BRANCH DIFFS ===' -ForegroundColor Cyan
$Registered = @(
    (Join-Path $ProjectRoot '.worktrees\changeover-matrix-stage-0'),
    (Join-Path $ProjectRoot '.worktrees\optimizer-reason-codes'),
    (Join-Path $ProjectRoot '.worktrees\split-order'),
    (Join-Path $ParentRoot 'Claude-worktree-command-band-reskin')
)
foreach ($Worktree in $Registered) {
    if (Test-Path -LiteralPath $Worktree) {
        Write-Host "--- $Worktree ---"
        git -C $Worktree status --short --branch
        git -C $Worktree log -1 --format='commit=%h date=%cs subject=%s'
    }
}

Write-Host '=== BRANCH HISTORY TO REVIEW ===' -ForegroundColor Cyan
foreach ($Branch in @('db-changes', 'master-data', 'minor-bug-fixes', 'feature/optimizer-reason-codes')) {
    Write-Host "--- $Branch ---"
    git log --left-right --cherry-pick --oneline main...$Branch
    git diff --stat main...$Branch
}

Write-Host '=== DOCUMENT REFERENCE SCAN ===' -ForegroundColor Cyan
foreach ($Name in @('APPLICATION_REVIEW.md', 'Nimbus Dashboard.dc.html', 'Nimbus Login.dc.html', 'Optimizer Preview Redesign.dc.html', 'Nimbus Mega-Spec document.docx')) {
    Write-Host "--- $Name ---"
    rg -n -F --hidden --glob '!.git/**' --glob '!node_modules/**' --glob '!.venv/**' --glob '!.worktrees/**' $Name .
}

Write-Host '=== RETIRED CONFIG/COMPATIBILITY SCAN ===' -ForegroundColor Cyan
rg -n --hidden --glob '!.git/**' --glob '!node_modules/**' --glob '!.venv/**' --glob '!.worktrees/**' 'COLOR_FILE|GLOBAL_CW|color_wheel|deprecated|obsolete|TODO|FIXME' .

Write-Host '=== UNREACHABLE GIT OBJECTS (DO NOT GC FROM THIS OUTPUT) ===' -ForegroundColor Cyan
git fsck --full --unreachable --no-reflogs
```

## Diff recipes by rank

### Rank 1 / 1B: rebuildable state

Verify the process is idle and that the environment can be recreated before
removing anything. These are not source files and are ignored by Git.

```powershell
Get-Process python,node -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path
Get-ChildItem .pytest_cache,.ruff_cache,.mypy_cache -Force -ErrorAction SilentlyContinue
Get-ChildItem .venv,node_modules -Force -ErrorAction SilentlyContinue
```

### Rank 2: open differences

Never discard a worktree solely because its branch is merged. First inspect its
status, branch history, untracked files, and source-tree differences.

```powershell
# Current root changes
git status --short
git diff --stat
git diff -- web/schedule-workbench.mts
git ls-files --others --exclude-standard

# Branch-level review; '+' means a patch is not present in main.
git cherry main feature/optimizer-reason-codes
git cherry main db-changes

# Explicit file comparison; exit code 1 means differences were found.
git diff --no-index --stat -- . '.worktrees\changeover-matrix-stage-0' 2>$null
git diff --no-index --stat -- . '.worktrees\optimizer-reason-codes' 2>$null
```

The current root has an untracked `Nimbus Mega-Spec document.docx` and a
modified `web/schedule-workbench.mts`; neither is a cleanup target until its
owner confirms it is disposable.

### Rank 3: archive stale context

Before archiving a plan or review, search for references and confirm that its
claims are historical rather than current requirements.

```powershell
git log -1 --format='%h %cs %s' -- .planning/codebase
rg -n -i 'GLOBAL_CW|COLOR_FILE|old app\.js|file-based color|allow_credentials|stale|superseded' .planning docs
rg -n --hidden --glob '!.git/**' --glob '!node_modules/**' --glob '!.venv/**' --glob '!.worktrees/**' `
  'APPLICATION_REVIEW|Nimbus Dashboard|docs/superpowers/plans|Entra_Auth_Migration|OPTIMIZER-PREVIEW' .
```

Recommended archive groups:

- `.planning/codebase/` as one dated snapshot, or regenerate it from current code.
- Completed CQ-1, TypeScript, priority-list, split-order, and changeover plans.
- One-off application reviews and unreferenced visual prototypes.

Keep active August 20–21 workstream plans until their implementation and
verification are complete.

### Rank 4: consolidate instructions/configuration

```powershell
git diff --no-index --stat -- AGENTS.md CLAUDE.md 2>$null
rg -n 'COLOR_FILE|GLOBAL_CW' Dockerfile .github brain.py db.py docs AGENTS.md CLAUDE.md
```

Choose one authoritative project guide before deleting or shortening either
instruction file. Remove only the vestigial `COLOR_FILE` deployment setting
after confirming there is no executable consumer. Keep the `color_wheel`
compatibility routes/table until their external contract is intentionally
retired.

### Rank 5 / 6: preserve or defer

Do not prune these from a text grep:

- `migrations/` and `schema.sql`; migration history is part of deployment state.
- `sample-data/` and generated `web/*.mjs`; they support tests/runtime delivery.
- Active `feature/optimizer-reason-codes` work and current dirty root changes.
- Legacy surface scanners, compatibility tests, and legacy color-wheel routes.
- Unreachable Git objects until WIP recovery and the `main`/`origin/main` gap are resolved.
- PostgreSQL rows, tables, or columns until a separate local-only database audit.

## Review ledger

Fill this in before removing anything. Use one row per candidate directory,
branch, or document; link the diff or review commit where possible.

| Candidate | Rank | Diff reviewed? | Unique content preserved? | Decision | Reviewer/date |
|---|---:|---|---|---|---|
| `.pytest_cache/` | 1 | [ ] | [ ] |  |  |
| `.ruff_cache/` | 1 | [ ] | [ ] |  |  |
| `.mypy_cache/` | 1 | [ ] | [ ] |  |  |
| `.venv/` | 1B | [ ] | [ ] |  |  |
| `node_modules/` | 1B | [ ] | [ ] |  |  |
| `.worktrees/de-lint-baseline-check` | 2 | [ ] | [ ] |  |  |
| `.worktrees/workstream-a-fixes` | 2 | [ ] | [ ] |  |  |
| `.worktrees/workstream-b-optimizer-scheduling` | 2 | [ ] | [ ] |  |  |
| `.worktrees/workstream-d-e-review` | 2 | [ ] | [ ] |  |  |
| `.claude/worktrees/*` | 2 | [ ] | [ ] |  |  |
| Registered merged worktrees | 2 | [ ] | [ ] |  |  |
| `.planning/codebase/` | 3 | [ ] | [ ] |  |  |
| `docs/superpowers/plans/` | 3 | [ ] | [ ] |  |  |
| `APPLICATION_REVIEW.md` | 3 | [ ] | [ ] |  |  |
| `Nimbus Dashboard.dc.html` | 3 | [ ] | [ ] |  |  |
| `AGENTS.md` / `CLAUDE.md` | 4 | [ ] | [ ] |  |  |
| `COLOR_FILE` config references | 4 | [ ] | [ ] |  |  |
| Git unreachable objects | 6 | [ ] | [ ] |  |  |

Deletion should be a separate, deliberate change after this ledger is reviewed.
