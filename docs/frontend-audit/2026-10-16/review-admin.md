# Independent administrative package review

Reviewed working changes against main `960abf6` on 2026-10-16. Scope: Setup, Material Plant and table menus, SAP staging/archive, role plant assignment, priority previews, System Configuration, and related backend/tests. Read PLAN.md and admin.md. No application edits, commits, live DB writes, or browser validation performed by this reviewer.

Verdict: two P2 corrections required before accepting this package. Archive backend changes preserve admin/plant guards, use parameterized literal search, and have deterministic paging. No additional important regression found in Setup compatibility, staging request guards, column-menu changes, or preview response guards.

## Findings

### P2 — Previously saved/discarded fields become drafts and overwrite fresh server values

Location: `frontend/master-data/material-grids.mts:402` (capture), `:468` (replay).

The retained patch unions the dirty patch with every field in `st.edited`. That set survives successful saves and discard, and records edits since the last load rather than only outstanding edits. If any field remains dirty, previously acknowledged or discarded fields are retained too. A subsequent fresh GET can therefore be overwritten by a historical local value and that value included in the next Save.

Executable reproduction used the existing `gridFixture` through an in-memory Node module, without modifying repository tests:

1. Load plant A with color white. Edit color to red, Save, resolve success.
2. Edit only `prt_01` to TOOL. Switch to B.
3. Return to A with fresh server color purple (another administrator/SAP update).
4. Expected: TOOL retained and purple shown. Actual: TOOL retained and red shown. Assertion `color === 'purple'` fails with actual `red`.

Also reconcile stored drafts when an A write succeeds while B is mounted: currently the early return at `:906` leaves the acknowledged fields in A's stored draft. If A changes again on the server before returning, those acknowledged fields are replayed as local work.

Minimal correction: retain actual dirty fields plus only the additional fields needed to preserve edits made relative to a currently pending write (including a return to the old baseline). Do not use historical `edited` fields unconditionally. On write acknowledgement, reconcile both the visible rows and stored plant draft, removing submitted fields only when their current draft still equals the submitted value; preserve later differing edits. Add regressions for acknowledged/discarded fields alongside an unrelated dirty field, and acknowledgement while another plant is mounted.

### P2 — Role assignment reload destroys the search before restoration reads it

Location: `frontend/security/security-admin.mts:676`, with call path `:727`/`:739` -> `_reloadRoles` at `:552` -> `_renderRolesTab` at `:577`.

The new search-preservation code reads `sec-plant-search` from the DOM in `_renderRolesDetail`. After adding/removing a plant, `_reloadRoles` calls `_renderRolesTab`, which first replaces `security-tabbody.innerHTML`. That removes the search input before `_renderRolesDetail` reads it. Every assignment consequently clears the search and removes keyboard focus. With a 50+ plant list, the administrator must repeatedly restore the filter and navigate back to the relevant controls.

Reproduction from the actual call path: select a role, search PLANT-3, activate Add for PLANT-30, let the write and reload resolve. The rebuilt search is empty and the full lists return. This is source-confirmed; no browser was available to validate physical focus behavior.

Minimal correction: retain the query in module state on input (or capture it before replacing the outer roles markup), and restore focus to the search or a logical remaining action after a successful add/remove when the same role is still selected. Test after the write/reload, not just before the POST.

The new security fixture cannot detect this: its `nodes` Map holds permanent `sec-plant-search`/assigned/available objects, and its `innerHTML` setter does not detach or recreate descendant IDs. The test also stops after checking the payload and one settle; it never asserts the post-reload query. Add a fixture lifecycle that represents descendant replacement or use a DOM harness for this regression.

## Requested follow-ups

### ADM-O2 — SAP History stale catch

The catch at `frontend/integration/sap-interface-ui.mts:1581` lacks the success-path current-view predicate. However, admin.md overstates the current impact: `_renderHistory` writes its captured `body`, and its sole caller `_renderDetail` reconstructs `sap-tabbody` on every tab/object change (`:629`–`:641`). A late catch therefore targets detached DOM in the normal navigation path; a cross-tab overwrite is not established.

Minimal consistency hardening: define a local current predicate using body identity, `_tab === 'history'`, and `_selected === o.object_key`; apply it to both success and catch, and optionally before the second audit request to avoid obsolete work. A request generation is needed only if a same-host overlapping call is introduced. Test with actual host replacement, and describe this as defensive stale-completion suppression rather than a reproduced cross-tab overwrite.

### ADM-O3 — System Configuration busy/dirty behavior

At `frontend/admin-ops/admin-ui.mts:3105`, `_save` allows overlapping whole-map POSTs; later checkbox edits remain visibly changed while success only acknowledges an earlier snapshot. Minimal behavior:

- Keep a normalized acknowledged baseline, current checkbox draft, and one busy flag. Normalize omitted field values through catalog defaults before comparing.
- Disable Save when clean or busy, guard duplicate calls in `_save`, and show visible translated pending/unsaved state. Keep checkboxes editable during the write.
- Capture an immutable request snapshot. On success update the acknowledged baseline and `Store.setOrderFieldVisibility` from the returned saved map; do not repaint over newer checkbox edits. Recompute dirty against the current draft and enable the next Save if it differs.
- On failure retain the draft and previous baseline, clear busy, and leave Save retryable. Protect render/load completion from overwriting a later draft or a newer render; a persistent host can receive overlapping `render()` calls.
- Add behavior tests for duplicate Save suppression, an in-flight subsequent edit (including reversal to the original value), successful acknowledgement updating Store only to the acknowledged snapshot, retry after failure, and out-of-order loads.

## Small correction

`frontend/integration/sap-interface-ui.mts:1474` renders the archive range with a literal `?` (`1?50`). Replace it with an en dash or a plain hyphen; this is source-visible, not a browser finding.

## Verification and evidence limits

Ran each file in its own `node --test --test-isolation=none` process against the compiled modules already present in the worktree:

| Suite | Result |
|---|---:|
| Setup Admin | 38 passed |
| Material Grids | 25 passed |
| SAP Interface | 17 passed |
| Security Admin | 6 passed |
| Priority Viewers | 4 passed |

All 90 existing focused tests passed with no skips. The additional in-memory material regression failed as described above, showing the current suite's missing case. Backend changes/tests were reviewed, not rerun here; the parent owns safe local backend and final build/gate verification.

New staging tests exercise success/error ordering against the same host, and archive tests exercise URL parameters and bounded backend results. Setup's new test verifies restoration/failure/retry, but its mounted-line assertion never changes `_lineScope` between mount and Save, so it does not prove that particular race. Preview tests cover stale completion and close, but do not test close-then-reopen before the animation timer fires. These are focused test gaps, not additional confirmed implementation defects.

No visual, real keyboard traversal, screen-reader, zoom, or browser-layout pass is claimed.

## Correction verification by coordinating reviewer

The coordinating agent independently inspected the corrected capture/replay and acknowledgement paths, the role search state and replacement-aware fixture, and System Configuration baseline/draft/load handling after the author completed round 1. The two P2 findings above are resolved in the working changes: saved/discarded historical fields are excluded; offscreen acknowledgements retire only matching submitted values; role query state survives outer DOM replacement and focus returns only for the same selected role/tab.

Reran the three directly affected compiled-module suites in separate processes: Material Grids **30 passed**, Security **6 passed**, System Configuration **5 passed**, with zero failures/skips. Their assertions cover fresh server values, later differing edits, post-reload search/focus, immutable save acknowledgement, retry and obsolete loads. No further important issue was found in this targeted correction review. Full branch tests and browser acceptance remain separate gates; the original review findings are retained above as an audit trail.
