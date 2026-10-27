# Tool Inventory: progress ledger

The ORCHESTRATOR owns this file. Subagents (implementers, reviewers) do not edit it; they report their ledger lines (status, SHA, verdict, drift found) in their final message and the orchestrator records them here.

- Design: `2026-10-27-tool-inventory-design.md`
- Main HEAD at start: `831bbf21381b6ae81c8ad6dd76ffdfef810010eb` (831bbf2, "fix(shell): skip boot during cache-bust redirect")
- Branch: `feature/tool-inventory`
- Worktree: `.claude/worktrees/tool-inventory` (repo root `C:\Users\PJ29587\OneDrive - Newell Brands\Documents\AI_ML Testing\Claude`)
- Rebase rule: record HEAD at start; `git fetch && git rebase main` before every wave; re-verify anchors at the new HEAD.

| Wave | Status | Commit SHA | Reviewer verdict | Anchors re-verified at HEAD | Notes |
|---|---|---|---|---|---|
| 0 Design doc, ledger, worktree | done (committed) | 3976ce2 | n/a | 831bbf2 | `npm ci`, `npm run build`, `npm run typecheck` green on the untouched tree. `git worktree prune` printed permission-denied errors for many stale `.git/worktrees/*` entries (OneDrive); worktree add still succeeded. |
| 1 Backend (table, routes, tests) | DONE | a78a8d9, da7b20c, f5fe742, 55daa38 | APPROVE WITH FIXES, fixes applied and committed | 3976ce2 | Wave 1 contract for Wave 4: dry_run shape {counts{new,changed,unchanged,rejected}, new/changed/unchanged/rejected lists capped 200, rows:int, warnings capped}; upsert-only; apply re-parses the file (client re-POSTs the same File; no review token); apply writes valid rows and skips rejected; ids stored UPPER-cased; /bulk validation all-or-nothing (400 first 5 problems) vs /upload per row; delete = {tool_id} in deletes; typo fix = delete + upsert in one /bulk; POST /tool-inventory/{plant}/usage for 'used by N orders'; tooling-rule setter planner-level, {subnetwork, tooling_rule:'off'|'hard'}; no tool_inventory cleanup on plant removal (no FK; orphans accepted). frontend/types/api-generated.d.mts: committed file at main already drifted from a fresh generation (~600 lines); Wave 1 applied an additive diff only (500 added, 0 removed); a CI drift check may fail from main's drift, not this branch. |
| 2 Shared core + count-aware alert (may run parallel with 1) | DONE | 4a61f81, 4265d19, 8c4060a, 5e68216, 6cb70c7; merge ff7419d | APPROVE WITH FIXES, fixes applied and committed | 3976ce2 | Gate on merged tree: build, typecheck, lint (0 errors, 37 pre-existing warnings), check:legacy-surface, check:static-assets green; npm test 130/130 (legacy) + 3369 tests, 3366 pass, 0 fail, 2 skipped, 1 todo (modules); pytest 1656 passed, 666 skipped (pg-marked, no local credentials), 13 xfailed; ruff: no new findings vs 3976ce2 (6 pre-existing). Holders string is language-neutral 'ORDER (LINE), ... +N'; alert text references 'Master Data > Tool Inventory' (page arrives in Wave 4); until Wave 4 every existing conflict reads 'no inventory row (treated as 1 copy)' => ship Waves 1-5 together; zero-copy Fix is hidden + refused (toast.cannot_fix_tool_unavailable); tie-break order is (time, type, start, end, id, line); the two-tools-on-one-pair legacy-id flip is documented. Locale wording for the Wave 4 tab name (`tab.tool_inventory` must match): DE Stammdaten > Werkzeugbestand, ES Datos Maestros > Inventario de herramientas, FR Données maîtres > Inventaire des outils, PT Dados Mestre > Inventário de ferramentas. Wave 6 API notes: findToolOverages returns the pusher and the OTHER holders (form the full cluster as pusher + holders); items carry id/line/plant/tools/interval and no protected flag (look holders up by id in the snapshot); buildToolIndex (grouped map, deterministic, cheap) + toolIndexUpdate(index, id, oldInterval, newInterval) exist for the pass's remove/insert steps; toolHeadroom re-sorts per call (fine: 840 orders, 29 ms measured); sweep is first-pusher-only so re-sweep after each move. |
| 3 Store/load/freshness | pending | | | | |
| 4 Master Data subtab + Manage Data + Excel UI | pending | | | | |
| 5 Order Rules toggle (gated) + Optimize UX + reasons + Inspector | pending | | | | |
| 6 Optimizer overflow pass (behind toggle) | pending | | | | |
| 7 Docs, release notes, deploy runbook, rollback | pending | | | | |

## Deferred items log
(Orchestrator appends per wave.)

- OWED: pg-marked tests unrun (no local Postgres credentials): tests/test_tool_inventory.py (2 tests), the new DDL parity/replay tests in tests/test_schema_idempotent.py; run them once credentials are available (local DB only, NIMBUS_TEST_DB=1, NIMBUS_REQUIRE_TEST_DB=1).
- Wave 5 follow-up: also consider a pane test for _runBatchMove over many holders; the tool-conflict `lineA/lineB` fields no longer exist.
