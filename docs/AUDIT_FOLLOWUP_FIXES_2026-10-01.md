# October 1 follow-up repairs

Scope: the six confirmed findings in [the September 30 repair review](AUDIT_REPAIR_REVIEW_2026-09-30.md), starting at `ea46778` on `fix/audit-0930`.

## Corrections

| Finding | Implemented behavior | Regression evidence |
| --- | --- | --- |
| R1: distribution overwrites unsaved child attributes | Distribution writes require affected schedule edits to be saved or reloaded first. Each request captures the affected group and edit/version generations. New edits during a request retain the entire local group and old tokens as unresolved; ordinary saves skip those conflicts and atomic saves remain unsaved. Late plant/collection responses do not hydrate another view. | `distribution-write-conflicts.test.mjs`: real mutation handlers and actual subsequent saves, including removals, replacements, siblings and unrelated orders. |
| R2: material writes commit out of order after plant navigation | Outstanding writes are tracked per plant independently of grid generations. Same-plant writes cannot overlap. Acknowledgements reconcile the current baseline and untouched cells while retaining newer edits; delayed reads incorporate a pending write that succeeded. | `material-grids.test.mjs`: A→B→A, response ordering, delayed GET, reverted edits and failed-write retry. |
| R3: null PV becomes an unintended clear | Nullable attributes normalize before backend edit detection. Refresh retains null PV. Missing attributes remain absent; clearing an existing PV still invokes routing validation. | PostgreSQL route/save cases in `test_audit_routing_db.py`; refresh→ordinary edit→actual save payload in `authoritative-recovery.test.mjs`. |
| R4: refresh leaves runtime inputs stale | Quantity, material, plant and raw SAP start are returned with runtime and version from the same SQL read. Plant authorization runs before exposing them. Refresh applies the complete runtime input set. | Real database quantity-change→12-hour machine save and validity-date rejection; browser refresh→grid move→save snapshot; authorization regression. |
| R5: Reload restores rejected cached edits | Explicit reload bypasses task overlays and optimizer dirty restoration. Dirty/conflict/cache state clears only after successful authoritative hydration. Failed or malformed responses retain local edits. Edits during reload cancel discard. Startup/offline cache restoration remains separate. | Actual load/reload/cache tests for same-version conflicts, atomic edits, failed requests, malformed responses, empty results and in-flight edits. |
| R6: held recovery reads a missing date field | The shared decoder copies the API's `original_start_date` into a raw SAP date before calendar snapping changes the display baseline. Routing validity and held-order anchors use that raw value; direct DTOs have a canonical-field fallback. | GET-shaped DTO→decoder→Table/Inspector cases for runtime, PV and machine edits; missing anchors and unrelated holds remain held; save snapshots and cache round trip checked. |

The final review also identified a same-plant distribution detail-switch race in Undo state. Its correction scopes response UI state to the detail that initiated the request while still applying a valid schedule response to its own group.

## Dependency impact

- No external package, lockfile, schema, migration, environment or container changes.
- The additive refresh response fields are reflected in regenerated TypeScript API declarations. Backend and frontend should ship together.
- Existing optimistic concurrency, atomic optimizer rejection and plant authorization remain enforced.
- Distribution and material coordination is within the current browser session; backend row versions still govern cross-session schedule edits.
- No production database was accessed; database regressions use disposable PostgreSQL on loopback port 55439 with the normal collection safety guard.

## Verification

- Final JavaScript suite: **909 passed** (37 legacy + 872 module tests). The normal-concurrency run hit three existing 1.5-second optimizer subprocess timeouts while other checks were running. The full suite passed with two concurrent module workers and unchanged time limits.
- Full Python suite: **767 passed, 1 existing skipped placeholder**, 19 existing deprecation warnings. The skip is the previously documented #203 concurrent-delete harness.
- Independent reviews found no remaining concrete blocker across the six corrections. The reviewers ran 81 scheduling/runtime tests, 21 distribution tests, and 13 material-grid tests plus three additional ordering scenarios. The final distribution suite adds one bulk-reset collection-replacement regression.
- New behavior regressions were observed failing before their fixes. One old mock SQL tuple required updating to the expanded refresh SELECT; no production constraint or test safety gate was relaxed.
- Build, typecheck, Ruff, static-asset boundary, legacy-surface contract and diff whitespace checks passed. ESLint passed with **0 errors and 46 existing warnings**. The temporary OpenAPI JSON was removed before the final static-asset check.

All six confirmed findings are corrected and covered by regressions. The final cross-file review found no remaining concrete blocker in this scope. Work is retained on `fix/audit-0930` for integration.

Browser interaction checks remain outstanding because no browser session was available. No merge, push or deployment was performed. Static assets require the normal build and build-ID bump when deployed.
