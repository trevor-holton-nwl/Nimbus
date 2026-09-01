# NIMBUS stale-data cleanup review

> Review ledger created 2026-08-22. This file is intentionally read-only: it
> reports status, references, sizes, and diffs but never deletes files, removes
> worktrees, deletes branches, runs `git gc`, or connects to PostgreSQL.

Use this document to decide what can be archived or removed. Re-run the audit
commands before acting; the repository may have changed since this snapshot.

> **Update 2026-08-31:** a follow-up doc-staleness check (scoped to `docs/`
> and `.superpowers/sdd/`) confirmed several rank-3 candidates below have
> since shipped, and found one relocated file. See the amended rows and the
> new note at the end of the Rank 3 section.

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
| **2** | `.claude/worktrees/agent-a40fa30aaf3cd7dce` and `agent-aa83fa0120e4c2b4a` | Two broken-pointer snapshots, approximately 7.7 MiB total; each contains a migration not present in `main`. | **Done, 2026-08-31.** Reviewed: `orders-rush-flag.sql` (additive `orders.rush_flag` column, unwired) and `notification-prefs.sql` (singleton `notification_prefs` table for an unbuilt email-on-alert feature, unwired). Neither had any consumer in current code; user decided to scrap both rather than land or archive. Both snapshot directories deleted. |
| **2** | Registered `split-order` worktree | Clean, approximately 7.1 MiB, branch tip is merged into `main`. | **Already gone** — `.worktrees/` no longer exists on disk and `git worktree list` shows nothing registered. No action needed. |
| **2** | Registered `changeover-matrix-stage-0` worktree | Merged branch, approximately 62 MiB, but four untracked docs differ from root copies. | **Already gone** (same as above). The 4 untracked docs it carried were never separately verified as preserved — if `docs/changeover_matrix*.md`/`setup_debate.md`/`Setup_teardown_bars.md` ever look thin, that worktree's copies are no longer recoverable. |
| **2** | External `Claude-worktree-command-band-reskin` | Merged branch, approximately 178 MiB; dashboard prototype matches root, but `UI_FRONTEND_MIGRATION.md` is untracked. | **Already gone.** Its untracked `UI_FRONTEND_MIGRATION.md` was independently recovered — the same-named file now exists at `docs/UI_FRONTEND_MIGRATION.md` (untracked, current). No unique content lost. |
| **2** | `.worktrees/de-lint-baseline-check`, `workstream-a-fixes`, `workstream-b-optimizer-scheduling`, `workstream-d-e-review` | Unregistered orphaned snapshots, 9-11.5 MiB each. | **Already gone.** `.worktrees/` directory no longer exists. |
| **3** | `.planning/codebase/` | Seven files, last updated 2026-06-17 through 2026-06-30; describes retired `GLOBAL_CW`, old CORS, and the pre-module-extraction frontend. | **Done, 2026-08-31.** Confirmed stale (documents the retired `GLOBAL_CW`/`COLOR_FILE` color-wheel system and an `allow_credentials=True` CORS bug already fixed). User decided the content had no unique value worth archiving — `CLAUDE.md`/`docs/architecture/` cover this ground better and current — and it's fully recoverable from git history if ever needed. Deleted (`git rm -r`), uncommitted pending review. |
| **3** | `docs/superpowers/plans/` | 27 plan files, approximately 991 KiB, with 914 unchecked and 141 checked items. | Archive completed July/early-August plans; retain active August 20–21 workstreams. **2026-08-31 confirmed-complete (uncheckboxed, safe to archive now):** `2026-07-16-cq1-phase-{0,1,2}.md`, `2026-07-17-cq1-phase-{3,4}.md` (CQ-1 module extraction, 0 boxes ever checked in any of them despite full completion), `2026-08-01-typescript-migration-phase-{1..7}.md` (all 7 shipped per `docs/archive/typescript_migration.md:239`, "Phases 1-7 now complete"; only Phase 8 remains, deferred), `2026-08-11-priority-lists-stage-2.md` (verified merged — commit `f8e7269` is an ancestor of `main`'s HEAD, via `.superpowers/sdd/2026-08-11-priority-lists-stage-2/`), `2026-08-20-workstream-a-machine-rename.md` (its own SDD progress log says "WORKSTREAM A — COMPLETE... merged into main," so it no longer belongs in the "retain as active" carve-out this row originally gave it), `2026-08-21-workstream-b-optimizer-scheduling.md` (records its own merge to `main` at commit `6386019` inline — not misleading, just now archivable). **Done** — see the Rank 3 archive-batch row above; all 6 groups (16 files) already git-mv'd to `docs/superpowers/plans/archive/`. `2026-08-11-priority-lists-stage-3-sequencing-audit.md` and `2026-08-11-priority-lists-stage-3.md` were **not** re-verified and have no `.superpowers/sdd/` folder, consistent with still being unexecuted — left out of this archive batch. |
| **3** | `APPLICATION_REVIEW.md` and `Nimbus Dashboard.dc.html` | Approximately 38 KiB and 44 KiB; no inbound references were found in tracked text. | **Done, 2026-08-31.** `Nimbus Dashboard.dc.html` has moved from the repo root into `docs/` and is untracked there; no longer an orphan — `docs/UI_FRONTEND_MIGRATION.md` (new, also untracked) is a live "Command Band" re-skin plan built directly against it. Do not archive it on the "no inbound references" basis anymore. `APPLICATION_REVIEW.md` was re-verified and found **not stale**: its top two findings (spoofable `x-user-email` identity, non-plant-aware order identity) are still-open issues per `CLAUDE.md`'s own Auth & RBAC and Data Sources sections. User chose to leave it in place; added a pointer + one-line status note to `CLAUDE.md`'s Docs paragraph so it's no longer an orphan. |
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
verification are complete. **2026-08-31 update: workstream-a and
workstream-b-optimizer-scheduling have since completed and merged to `main`**
(confirmed via `.superpowers/sdd/2026-08-20-workstream-a-machine-rename/progress.md`
and the workstream-b plan's own inline merge note, commit `6386019`) — they no
longer need to be held out of the archive batch. `workstream-c-planning-horizons`
and `workstream-d-e-setup-hygiene-admin-browser` were not re-verified; leave
those two in the "keep active" carve-out until checked. Note also:
`docs/superpowers/plans/2026-08-20-workstream-d-e-setup-hygiene-admin-browser.md`
(line ~130) points to a `.superpowers/sdd/2026-08-20-workstream-d-e-.../progress.md`
folder that does not exist — the plan's own text says that work was "bundled
with Workstream A," so this is a dangling cross-reference to fix, not missing
data.

`.superpowers/sdd/` (gitignored local SDD workspace state, separate from
`docs/superpowers/`) also has loose top-level files predating its
dated-subfolder convention (`progress.md`, `task-*-brief/report.md`,
`phase2-/phase3-task-1-*`, five `review-*.diff` files) — these are the
TypeScript-migration Phases 1-3 tracking log and are safe to clear once the
historical diffs aren't needed (rank-1-style: ephemeral/rebuildable, not a
tracked doc). This ledger did not originally scan `.superpowers/`.

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
| `docs/superpowers/plans/` (5 cq1 + 7 typescript-migration + stage-1 + stage-2 + workstream-a + workstream-b) | 3 | [x] | [x] confirmed complete/merged, no unique content at risk | **Done** — 16 files git-mv'd to `docs/superpowers/plans/archive/`; cross-refs fixed in `brain.py`, `tests/modules/helpers/load-legacy-app.mjs`, `docs/scheduling_priority.md`, `docs/superpowers/plans/2026-08-11-priority-lists-stage-3.md`. Uncommitted, pending review. | model, 2026-08-31 |
| `APPLICATION_REVIEW.md` | 3 | [ ] | [ ] |  |  |
| `Nimbus Dashboard.dc.html` | 3 | [x] | [x] now referenced by `docs/UI_FRONTEND_MIGRATION.md` | Preserve — no longer an orphan | model, 2026-08-31 |
| `AGENTS.md` / `CLAUDE.md` | 4 | [ ] | [ ] |  |  |
| `COLOR_FILE` config references | 4 | [ ] | [ ] |  |  |
| Git unreachable objects | 6 | [ ] | [ ] |  |  |

Deletion should be a separate, deliberate change after this ledger is reviewed.

## 2026-08-31 addendum: setup/changeover doc set + multi-change spec

Beyond the items already amended above, a follow-up pass checked every
`docs/` file matching `changeover_matrix*`, `setup_*`, `multi_change_spec*`,
and `typescript_migration.md`:

- **Kept as current design-of-record (no action):** `docs/archive/typescript_migration.md`
  (the durable roadmap; Phase 8 still open), `docs/changeover_matrix.md` (design
  of record), `docs/Setup_matrix_redesign.md` (the doc that corrects it on
  specific points).
- **Archived to `docs/archive/`** (historical/superseded, same "shipped but
  never marked done" pattern as the plans batch above): `changeover_matrix_stage_{0,1,2}.md`,
  `Setup_teardown_bars.md` (explicitly "pre-feature NIMBUS" per `CLAUDE.md`),
  `setup_matrix_ui_redesign.md` (self-labeled "implemented 2026-08-14"),
  `setup_debate.md` (a verbatim chat transcript, not a living spec). All
  cross-references fixed: `CLAUDE.md`'s "Docs vs. git" caveat, `docs/changeover_matrix.md`,
  `docs/Setup_matrix_redesign.md`, `docs/superpowers/plans/2026-08-14-changeover-stage-2-release-readiness.md`,
  `tests/modules/{locale-completeness,plant-and-administration}.test.mjs`,
  `web/plant-and-administration.mts` (comment-only, no logic touched).
- **Verified still-live, left alone:** `docs/multi_change_spec_08.20.26.md`.
  Its B/C/D/F workstream items are still landing on `main` — `firming_indicator`→firmed
  (F1) shipped at the single most recent commit at time of writing (`1e85f50`),
  and the plant visibility/frozen horizon items (C1/C2) shipped within the
  last handful of commits. F2 (bounded min-changeover) and F3 (PRT tooling
  capacity) show no matching commits yet. Not a stale-doc candidate.

**Second archive batch, same day:** swept the remainder of `docs/superpowers/plans/`
and all of `docs/superpowers/specs/`. Archived 8 more plans (`2026-08-12-remove-backlog-implementation.md`,
`2026-08-12-split-order-implementation.md`, `2026-08-14-changeover-stage-2-release-readiness.md`,
`2026-08-14-setup-release-evidence.md`, `2026-08-17-optimizer-preview-reorder.md`,
`2026-08-17-setup-matrix-list-view.md`, `2026-08-20-workstream-c-planning-horizons.md`,
`2026-08-20-workstream-d-e-setup-hygiene-admin-browser.md`) and 6 specs
(`2026-06-25-error-log-architecture-design.md`, `2026-07-16-cq1-frontend-module-migration-design.md`,
`2026-08-02-login-screen-redesign-design.md`, `2026-08-12-remove-backlog-design.md`,
`2026-08-14-setup-release-evidence-design.md`, `split-order.md`) — all confirmed shipped via
git log/checkbox-ratio. Fixed cross-refs in `docs/architecture/cq1-compatibility-inventory.md`
and `web/application-shell.mts`.

**Explicitly left in place (still open, not stale):** `2026-08-18-optimizer-reason-codes.md`
plan + spec — git log shows `a0fd193` "wip: pause optimizer reason codes," genuinely paused
mid-build, no `reason_code`/`reasonCode` anywhere in current code. `2026-07-07-multi-user-sync-design.md`
— an unimplemented proposal; `CLAUDE.md`'s single-replica caveats confirm no real sync exists yet.
`2026-08-11-priority-lists-stage-3.md` + `2026-08-11-stage-3-sequencing-audit.md` — Stage 3 not
confirmed complete. `2026-08-12-agents-contributor-guide-design.md` — the design spec behind
`AGENTS.md` itself; held pending the separate `AGENTS.md`/`CLAUDE.md` consolidation decision.

**Correction + third cleanup pass, same day:** the earlier claim in this file that
`Nimbus Dashboard.dc.html` had "moved" from root into `docs/` was wrong — it was
**duplicated**, not moved. The root copy (tracked, unchanged since `8bf2f94`) is
the real file `docs/UI_FRONTEND_MIGRATION.md` references; the `docs/` copy was an
untracked, byte-identical stray left over from an earlier session. Deleted the
stray duplicate; root stays canonical.

Also discovered 4 more root-level files with no entry in `CLAUDE.md`'s docs
allowlist: `Nimbus Login.dc.html` + `INTEGRATION.md` (login-screen redesign
mockup + build guide — feature shipped, `ab20be2`) and `Optimizer Preview
Redesign.dc.html` + `OPTIMIZER-PREVIEW.md` (optimizer-preview-dialog mockup +
build guide — feature shipped, matches the archived `2026-08-17-optimizer-preview-reorder.md`
plan). Both pairs archived to `docs/archive/`. Cross-refs fixed in
`web/schedule-workbench.mts`; refs inside other archived docs (`docs/superpowers/specs/archive/2026-08-02-login-screen-redesign-design.md`,
`docs/superpowers/plans/archive/2026-08-17-optimizer-preview-reorder.md`) were left
as-is since they're accurately describing historical state ("were dropped into
the repo root..."), not broken links.

**Fourth pass, same day — `docs/typescript_migration.md` archived.** All 7 core
module conversions (Phases 1-7) are done; the only remaining item, Phase 8
(eliminating the `window.__NIMBUS_*` bridge, converting `app.js`/`nimbus-intelligence.js`
to real ES modules), is explicitly "genuinely optional... worth revisiting only
if the bridge itself becomes a real pain point" per the doc's own phase table —
no open plan, no scheduled work. User decided that's close enough to done to
archive the tracking doc itself. Moved to `docs/archive/typescript_migration.md`;
fixed all 26 live cross-references (`CLAUDE.md`, `docs/scheduling_priority.md`,
`docs/architecture/domain-refactor-plan.md`, `brain.py`, `docs/DEPLOYMENT.md`,
build/lint/CI config comments in `tsconfig*.json`, `package.json`, `eslint.config.js`,
`.gitignore`, `.dockerignore`, `Dockerfile`, `.github/workflows/ci.yml`,
`scripts/check-static-assets.mjs`, and comments across `web/*.mts`/`.d.ts`).
`npm run typecheck` confirmed clean afterward — all references were comments,
no build-config file actually depended on the doc's path. Left references
inside already-archived plans (`docs/superpowers/plans/archive/2026-08-01-typescript-migration-phase-*.md`,
`...-priority-lists-stage-1.md`) untouched — historical prose, not live links.
If Phase 8 is ever picked back up, un-archive this doc first.

**Fifth pass, same day — correcting a wrong call on the Command Band re-skin.**
Earlier in this file's history (the third-pass entries above) `Nimbus Dashboard.dc.html`
was kept at root as "canonical" on the assumption `docs/UI_FRONTEND_MIGRATION.md`
described still-unbuilt work. **That assumption was wrong.** Git log shows 9
"Command Band" commits, including "Task 11: Update design docs for Command Band
navy/blue re-skin" (`df5c73e`), confirmed on `main`. `web/styles.css`'s `--accent`
token is `#1f5fbf` (navy/blue, not the old amber) and `web/index.html` has the
`nav-drawer-nav` markup the plan called for — the re-skin is fully shipped, not
a live design source. Archived both `docs/UI_FRONTEND_MIGRATION.md` and the root
`Nimbus Dashboard.dc.html` to `docs/archive/`. No cross-references needed fixing
(only `stale_cleanup.md`'s own filename-based audit script mentioned them, which
still works regardless of path).
