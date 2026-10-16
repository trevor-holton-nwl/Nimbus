# Execution ledger — docs/frontend-audit/2026-10-16/PLAN.md

- Baseline: 960abf6; isolated feature/frontend-audit branch created. Original checkout preserved.
- User authorized implementation of the complete Astra audit/fix plan.
- Package 1 Labor: implemented and independently accepted. Queue/cache, daily and aggregate draft preservation, conditional current-pin protection and canonical acknowledgements corrected. Persistent group search and localized new copy included. Final focused frontend 27 passed; all four review findings closed.
- Package 2 Shared experience: implemented and independently accepted. Contrast, alert scope/duration, focus/overlays, protected snapshot restore, conservative historical comparison and all-selected-plant order/line search included. Corrected shared suites 145 passed; all three review findings closed.
- Package 3 Administrative state: implemented and correction-reviewed. Historical draft replay and role-search findings closed; System Configuration dirty/busy behavior added. Focused Node 102 and backend 180 passed.
- Package 4 Planning workflows: implemented and independently accepted. Filters/search, keyboard menus, print scope, expanded Distribution editor and Calendar What-If persistence/hydration corrections. Final calendar review 55 passed; production finding closed and subscriber-error test strengthened.
- Package 5 Browser/coverage: supported browser runtime returns no available browsers after troubleshooting and user consent. Browser-dependent checks blocked, not passed. Local fixture server boot and API smoke passed (api-smoke.json). Seed script supplies 50 audit plants, 188 machines, 1,000/10,000 order profiles and 16 weeks of labor. Dedicated test and browser DBs are separate, local only; credentials untracked.
- Package 6 Independent review/full verification: complete within source/automated evidence boundaries. Five independent review records delivered. Full Node 1,722 passed with zero TODO/skips; full Python 1,839 passed with one existing skip and 13 existing xfails. Build/typecheck/lint/static-assets/reviewed legacy contract and changed-file Ruff passed. Full Ruff retains seven unchanged baseline issues. All 53 new locale keys verified across five languages with permanent coverage. See VERIFICATION.md.
- Temporary audit server on port 8010 stopped after verifying its process identity. Synthetic databases and ignored local fixture configuration remain available for later browser acceptance. No deployment.

## Baseline evidence

- Unchanged main checkout: 77 legacy + 1,557 module tests passed; 3 expected-failure TODOs in calendar-sync-boundaries document What-If persistence leaks. Planning package will fix these.
- Local API baseline: 166 passed, no skips.
- Initial Node spawn EPERM is sandbox infrastructure; approved npm test runs with child-process permission. Focused agents use one file per invocation with --test-isolation=none to avoid cross-file global mock contamination.
- Root environment points to live DB. It was not edited. Both audit databases use 127.0.0.1 and dedicated names; worktree .env is ignored.
