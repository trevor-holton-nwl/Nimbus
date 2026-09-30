# September 30 audit repairs

> Subsequent independent review found three introduced regressions and three incomplete repairs. The passing gates below remain valid, but the branch is not ready for release. See [the review and required corrections](AUDIT_REPAIR_REVIEW_2026-09-30.md).

Base: `main@9f21d9c`. Implementation branch: `fix/audit-0930`.
Scope: twelve validated findings from `Code_Review_09_30.md`, plus the aggregate export SQL failure exposed by real database tests.

## Changes and regression coverage

| Finding | Repair | Evidence |
|---|---|---|
| N01 — missing tooling conflicts in worker | Preserve both PRT fields in worker task projection. | `worker-tool-parity.test.mjs` |
| N02 — refresh adopts version with stale attributes | Refresh returns/applies all writable attributes, nullable runtime, provenance and segments. | `conflict-reconciliation.test.mjs`, `test_audit_routing_contracts.py`, real PostgreSQL refresh test |
| N03 — delayed refresh overwrites newer edits | Track original save baseline and edit/collection generations; retain newer local edits and block unresolved resaves. | Deferred save/refresh, edit/revert, reload and atomic-group regressions |
| N04 — new share loses child pointer | Write shares before assigning their child IDs. | Real PostgreSQL add/remove/guard test in `test_distribution.py` |
| N05 — collapsed child loses segments on next save | Return complete canonical children and hydrate through the shared task decoder. | PostgreSQL collapse test and `distribution-hydration.test.mjs` actual save payload |
| N06 — material save acknowledges unsent edits | Snapshot the submitted patch; advance only that baseline and re-diff current edits. | Deferred response tests in `material-grids.test.mjs` |
| N07 — plant switch corrupts material grid | Bind acknowledgements to plant and grid generation, including A→B→A. | Plant-switch response tests |
| N08 — routing groups collide across materials | Include material in producer routing keys and consumer contract. | Shared wire fixture checked by Python producer and JavaScript consumer, both insertion orders |
| N09 — legitimate PV runtime edit rejected | Resolve candidate runtime and basis inside the schedule transaction; compare submitted preview in minutes. | Pure and real PostgreSQL candidate/ordinary-save regressions |
| N10 — returned version predates resolver write | Schedule saves use one transaction; distribution rereads complete final child snapshots after resolution. | PostgreSQL response-token equality and immediate next-save tests |
| N11 — machine move retains old duration | Resolve target runtime before constructing schedule; regenerate changed split totals under the existing split policy. | Actual grid handler, shared placement helper, hold-release and failed-allocation tests |
| N12 — rapid role toggles revert prior choices | Send partial page maps, serialize per role and retain pending choices. | Actual UI event/deferred request tests in `security-admin.test.mjs` |
| Additional — aggregate JSON/CSV returns 500 | Qualify order date/runtime operands in the shared effective-end SQL used beside distribution headers. | Existing JSON/CSV endpoint tests plus exact child finish-time assertions |

## Behavioral decisions

- A stale routing preview is rejected before writing, with `runtime_preview_changed`. Rates reload; ordinary conflict recovery refreshes only unchanged local edits. Atomic optimizer rejection retains the whole local group.
- Explicit production-version changes opt into routing. Machine-only changes retain a manual, SAP or distributed runtime; routing-derived and unknown runtimes are resolved for the target machine.
- A runtime hold can be released using its valid existing SAP start. Missing/invalid anchors remain held until explicit placement; unrelated hold reasons remain held.
- Same-duration split moves retain their shape. A changed productive duration requires a valid allocation; failure restores an AG Grid cell that was already mutated.
- Generated API declarations were regenerated from the current backend. Their diff also catches previously ungenerated routing endpoint/schema declarations.

## Verification and limits

Focused regressions demonstrated the original failures before the corresponding repairs. Transaction checks use a newly initialized, disposable PostgreSQL 18 database bound to `127.0.0.1:55439`, with the test database safety guard and required-database gate enabled. Fresh-schema distribution fixtures were repaired to create required materials and respect identifier lengths; application validation was not relaxed.

Final combined gates:

- `npm test`: **873 passed** (37 legacy + 836 module), no skips.
- Guarded full `pytest`: **755 passed, 1 existing skipped concurrency-harness placeholder**, 19 existing deprecation warnings. All database tests ran; there were no database-availability skips.
- `npm run build`, `npm run typecheck`, `ruff check .`, static-asset boundary, legacy-surface contract and `git diff --check`: passed.
- `npm run lint`: zero errors; the same 46 warnings as the audited baseline.
- Independent reviews covered routing transactions/placement, material acknowledgements, role write ordering and distribution hydration. Review findings were fixed and regression-tested.

The full database run also required fixture-only corrections for `subnetworks.name`, the additional machine/workcenter foreign key, and the constraints column normally created by FastAPI startup. No production validation was relaxed.

Browser visual/interactive QA remains outstanding because this session has no available browser instance; UI tests exercise the production event handlers with controlled DOM/grid fixtures.

No schema migration, live database repair or deployment is included. Existing production orphan rows, if any, require a separately reviewed repair. Deploying these frontend changes later requires a fresh build and `NIMBUS_BUILD_ID` bump under the normal deployment workflow.
