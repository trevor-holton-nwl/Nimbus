# Verification record

Implementation baseline: main `960abf6`. Isolated branch: `feature/frontend-audit`, worktree `.worktrees/frontend-audit`. Source implementation and independent correction reviews are accepted. Browser acceptance remains blocked; this is not a complete visual certification.

## Environment and evidence limits

- Original checkout and its unrelated user changes are preserved. Ignored worktree credentials target loopback PostgreSQL only.
- Tests use `nimbus_frontend_audit`; synthetic HTTP fixtures use the separate `nimbus_frontend_audit_browser`. Collection-time DB safety remains enabled. No Azure, SAP send, deployment or real production mutation was used for acceptance.
- Supported Browser runtime reported no available browser after documented setup/troubleshooting. All actual layout, scroll, theme, zoom, native focus and screen-reader acceptance remains **blocked**, as enumerated in COVERAGE.md. DOM harness results do not replace it.
- Compiled module twins, local environment, server logs/password and temporary build artifacts remain ignored. Temporary OpenAPI dumps are removed from the public static tree after generation.

## Baseline

| Check | Observed baseline |
|---|---|
| Full Node tests on unchanged main | 77 legacy + 1,557 module passed; 3 expected-failure TODOs in Calendar What-If boundaries |
| Initial local API suites | 166 passed, no skips |
| Full Ruff during implementation | Seven unchanged findings: db.py B007 x2; test_backward_cutover.py B905 x2; test_distribution.py SIM117; test_routing_resolver.py SIM114; test_schema_idempotent.py B017. `git diff` confirms all five files unchanged from baseline. These remain baseline lint debt, not passing checks. |

The three Calendar TODOs are now ordinary passing regressions. Additional tests exposed live debounce/promotion and deferred hydration cases; all reproduced planning review findings are closed.

## Package verification

See domain reports for failing-before evidence, exact test files and counts. Counts overlap with the full suite and must not be added together as independent coverage.

- Administrative initial independent review: 90 existing tests passed but two added reviewer cases exposed missing coverage. Author corrected both; coordinating reviewer reran Material Grids 30, Security 6 and System Configuration 5, all passed. Author's complete corrected package: 102 Node and 180 backend passed, no skips. Review history is retained in review-admin.md.
- Labor independent review: original queue, daily draft and server-pin findings closed after deterministic DOM and real overlapping-transaction tests. A follow-up aggregate draft case was also reproduced, fixed and independently closed. Final focused frontend count: 27 passed; backend compatibility run: 211 passed, 8 existing xfails. Full backend suite below includes the new 16-case batch acceptance file.
- Planning independent review: 256 focused tests initially passed, but an actual SandboxAdapter/CalendarSync integration reproduction exposed stale hydration after discard. Correction independently accepted with 55 calendar tests. The coordinator then strengthened the integration harness to observe Store's actual console-error channel and reran 10/10.
- Shared independent review: split-segment restore, mixed-plant historical comparison and foreign-line command scope findings all closed. Seven corrected suites: 145 passed; affected production-handler suite independently rerun at 10/10 after the final line-scope correction. The 10,000-order index/search samples were approximately 20–47 ms / 15–20 ms in Node; these are not browser timings or performance thresholds.
- Locale completeness: **29 passed**. Integration review independently executed every locale and checked all 53 audit-added keys, values, duplicates and placeholders. A permanent 53-key regression exposed that the old discovery regex missed double-quoted keys; the quote-aware correction now covers both styles. The regression failed before and passed after the parser fix.
- Frontend lint: **0 errors, 34 warnings**. The new test shadow warnings were removed; remaining warnings are unchanged code/test lint debt.
- Static asset boundary and reviewed compatibility inventory: passed. Temporary OpenAPI generation output lives outside the public static tree.

## Local fixture measurements

`api-smoke.json` records login/static/catalog/task/Labor/calendar HTTP checks with 1,000 synthetic orders. `scale-api.json` records the 10,000-order profile: AUD01 returned 9,500 correctly scoped rows, AUD02 500; every row's plant was checked. Local HTTP timings and payload sizes are recorded verbatim, with no claim about browser rendering or production performance.

## Final gates

| Command / check | Result |
|---|---|
| `npm test` (includes build) | **77 legacy + 1,645 module = 1,722 passed**, zero failures/skips/TODOs; normal isolated Node processes |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed: 0 errors / 34 existing warnings |
| `npm run check:static-assets` | Passed |
| `npm run check:legacy-surface` | Passed against deliberately reviewed inventory, as detailed below |
| `python -m pytest -q -p no:cacheprovider --basetemp=.superpowers/frontend-audit/pytest-tmp-full-3` | **1,839 passed, 1 existing skipped, 13 existing xfailed**, exit 0; local PostgreSQL required and reachable |
| Ruff on every changed Python file | Passed |
| `ruff check .` | Seven unchanged baseline violations remain, listed above; full Ruff is not green |
| API type regeneration | Passed; route diff matches archive paging/search and Labor batch endpoint. Generic dictionary request types remain generic; runtime validation is tested separately. |
| `git diff --check` | Passed; Git line-ending conversion notices are informational |
| Credential / artifact check | All 74 reviewable files scanned against the local DB and temporary browser passwords: no matches. Environment, password, logs, node_modules and compiled twins remain ignored. |

The one existing skipped Python test documents an unimplemented concurrent-delete harness in `test_data_integrity.py`. The 13 existing expected failures are eight malformed-payload cases on legacy Labor endpoints, four malformed login identities, and one SAP configuration-error boundary. They are not counted as passing behavior.

First full Python run: 1,836 passed, two sort-order assertion failures and one temporary-directory error. The unchanged catalog paging test assumed Python code-point order, while the local `English_United States.1252` database collation places punctuation before digits. Its assertion now compares sorted actual IDs with expected IDs, retaining exact completeness, uniqueness, bounds and constant SQL-budget checks; production SQL is unchanged. Pytest's own newly created temporary directories were inaccessible to the restricted process token, even inside the worktree. The final approved normal-process run used a fresh worktree temporary directory and passed. No DB safety guard was bypassed. Node isolation also required normal child-process permissions.

## Deliberate compatibility inventory exception

The classic intelligence script must remain classic under the shell contract. Four new reads reuse **existing public APIs/data**: `Store.tasksForSelectedPlant` for scoped capture/search/compare, `Engine.firmingStatus` for authoritative protection checks, and `Store.masterData` / `Store.lineSettings` for unambiguous historical machine ownership. The first-match `getPlantForLine` cannot establish legacy ownership when machine names repeat across plants. Duplicating protection/scope logic or hiding these references from the scanner would be worse.

Both shared and integration reviewers accepted this narrow exception. Before `--write --allow-growth`, a guard asserted that the additions were **exactly those four intelligence commands**, with no new inline or private consumers. The update also removes five inline-handler entries, one HTML command and direct private `UndoStack._entries` use. The scanner/rules remain unchanged. Final inventory: 105 inline handlers, 54 HTML commands, 49 intelligence commands and 83 private consumers; subsequent drift still fails normally.
