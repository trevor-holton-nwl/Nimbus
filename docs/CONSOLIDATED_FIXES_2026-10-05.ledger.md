# Consolidated fixes ledger (2026-10-05)

Plan: Code_Review_Consolidated_10_05.md. One row per item.

| Plan item | Status | Commit | Tests run | Note |
|---|---|---|---|---|
| A1 plan file | DONE | 4a4bbb2 | n/a | Code_Review_Consolidated_10_05.md at repo root (Hand-off section omitted) |
| A1 test DB harness | DONE | (outside repo) | schema.sql ON_ERROR_STOP=1 applied; pytest tests/test_task_concurrency.py | SCRATCH\pg-test\start.ps1 / stop.ps1, 127.0.0.1:55439 db nimbus_test, idempotent; usage in start.ps1 header |
| Part 2 B0 #1 promote gate | DONE | 0cbe1a4 | docs only, no Azure command run | step 1b added to .claude and .agents promote-azure SKILL.md: GitHub check-runs REST (Invoke-RestMethod, $env:GITHUB_TOKEN) + npm test + check:static-assets; -OverrideCi "<reason>" recorded in deploy note |
| Part 2 B0 #2 cross-seam save test | DONE | f7bcbda | node --test persistence.test.mjs (44 pass); pytest tests/test_task_concurrency.py (6 pass); lint 0 errors; typecheck ok | fixture tests/modules/fixtures/save_payload_cases.json (JS-generated, drift-checked; regenerate NIMBUS_UPDATE_FIXTURES=1). Python substitutes only base_version; blocks/calendars pinned empty in fixture (server ignores them) |
