# Independent Labor review — 2026-10-16

Reviewed the Labor diff against `960abf6`, the audit plan/report, domain contracts, API/SQL implementation, and new tests. **Changes required:** two reproduced in-page races and one remaining server-side pin-preservation gap. No implementation files were modified by this review.

## Findings

### RLAB-01 — High: returning to a plant deletes state needed by queued writes and Undo

Locations: `frontend/labor/labor-planning.mts:1035`, `:228`, `:244`.

The plant-selection subscriber deletes the destination plant's aggregate and line caches immediately. The new queue derives automatic cells and captures Undo snapshots later, when each queued operation starts. Waiting for `_writeQueue` in `render()` does not protect those caches: deletion already happened before that wait.

Reproduction: load plant P with a 3h pinned LINE-A Monday. Delay a group B aggregate save. Queue a group A 70h save, then select another plant and return to P before releasing the first save. The queued group A edit sees no cached pin and submits that Monday as `auto_split`. It also captures absent prior aggregate/line values for Undo instead of the actual prior values. This occurs in one browser with no competing client.

Evidence: an in-memory extension of the existing DOM harness reproduced the sequence. Assertion `writes[1].line_cells.some(c => c.machine === 'LINE-A' && c.day === day) === false` failed with actual `true`. Test initialized the actual `LaborPlanning.init()` subscription and used `Store.setSelectedPlant()` for both switches; POST 1 was held by a promise while POST 2 queued.

Fix: preserve committed per-plant caches while writes using them are queued/in flight. Serialize invalidation after those writes (and guard the resulting refresh against stale scope), or retain a separate durable write-state cache independent of display invalidation. Do not snapshot all edits before queuing, since later edits must see preceding successful edits. Add the above switch-away/back test with original aggregate values and pins, then Undo and verify exact persisted values/provenance/absence are restored.

### RLAB-02 — Medium: a completed line save discards another cell's uncommitted draft

Locations: `frontend/labor/labor-planning.mts:717`, `:733`, `:688`.

After awaiting a line save, the handler unconditionally rebuilds the active line grid and focuses the just-saved cell. During a slow save, a planner can already be typing in the next cell. The rebuild removes that input before its change/blur event commits it, losing the typed value and moving focus backward. A write failure follows the same redraw path. The queue only protects changes that have already emitted `change`.

Reproduction: in Line Plan, change Monday to 3 and tab to Tuesday, holding Monday's POST. Type 7 in Tuesday without blurring. Release Monday's POST. Tuesday returns to its saved/calendar value and Monday is focused.

Evidence: deterministic in-memory harness assertion `g.inputs[1].value === '7'` fails after releasing the first save. The test sets `document.activeElement` to the second input, whose value was changed while the POST promise was pending. This proves draft replacement at the DOM abstraction level; a real browser keyboard run remains appropriate for final acceptance.

Fix: patch the acknowledged cell's value, source styling and totals without rebuilding the editable grid; preserve the current focused cell and its draft. Alternatively, retain per-cell draft revisions and restore them through renders, updating focus only if the user has not moved since submission. Verify success and failure, the next-cell draft, and two already-enqueued edits.

### RLAB-03 — High integrity gap, inherited cross-client behavior: automatic reconciliation can overwrite/delete a current server pin

Locations: `master_data.py:2331`, `:2402`, `:2417`; `frontend/labor/labor-planning.mts:230`.

The batch transaction guarantees all-or-nothing persistence but calls the same unconditional line upsert/delete helper. Pin exclusion depends entirely on cached browser state. Client A reads an automatic or absent cell; client B pins it; A changes/clears group hours. A's derived payload overwrites the current override with `auto_split`, or deletes it when clearing a previously cached automatic cell.

This is **not a newly introduced general concurrency defect**: the former endpoints were also last-writer-wins, and LAB-O01 acknowledges the limitation. It is nevertheless a concrete gap in the new pin-preservation claim and the requested automatic-reconciliation invariant. Full cell versioning/schema work is unnecessary to enforce this narrower rule.

Smallest bounded fix: distinguish automatic aggregate reconciliation from explicit daily edit/reset and exact Undo intent in the batch contract. In SQL, automatic upserts must update conflicts only when the current row is not `override`; automatic deletes must likewise exclude current overrides. Return canonical skipped/preserved rows and apply those rows to the browser cache instead of blindly applying its requested changes. Preserve explicit reset and Undo behavior through their separate intent; do not globally block every `auto_split` payload, because an intentional reset uses that source too. Make conditions part of the database mutations, not an unlocked pre-read. Also ensure the batch transaction and audit results describe actual affected rows.

Acceptance tests: (1) A reads absent/automatic Monday, B commits a 3h override, A submits automatic 10h reconciliation; stored value/source remain 3/override and A receives canonical 3/override. (2) Repeat with A clearing group hours and requesting deletion of Monday; pin survives. (3) An explicit reset can replace the pin with an automatic value or calendar fallback. (4) Undo of that reset intentionally restores the prior pin. (5) Existing aggregate+line rollback test continues passing. These tests should use actual PostgreSQL, including a controlled overlapping transaction case for the conditional update/delete.

## Verification and other conclusions

- Verified safe worktree `.env`: `PG_HOST=127.0.0.1`, `PG_DB=nimbus_frontend_audit`, `NIMBUS_TEST_DB=1`; no credential contents printed.
- `../../.venv/Scripts/python.exe -m pytest tests/test_labor_plan.py -q -p no:cacheprovider`: **7 passed**, including actual PostgreSQL rollback. One existing Starlette/httpx deprecation warning.
- `node --test --test-isolation=none tests/modules/labor/labor-audit.test.mjs`: **12 passed**.
- `node --test --test-isolation=none tests/modules/labor/labor-planning.test.mjs`: **4 passed**, separate process.
- Two additional in-memory reviewer race tests: **2 failed** as described above; no source/test files changed to execute them.
- Atomic transaction boundaries, authentication/plant permission dependencies, strict batch finite/nonnegative hours and actual ISO-week/day validation are present. Existing legacy validation weaknesses remain outside the new contract and are already documented.
- The horizon now reaches 112 days consistently; local midnight week starts and containing-Monday date navigation are coherent. Daily views/KPIs use the same group/line intersection. Aggregate edits deliberately target the entire visible group and explain that scope.
- Ordinary saved Undo captures plant identity, source/value/absence and preserves its entry after failed persistence. Cross-scope Undo checks the active plant before updating the DOM. RLAB-01 is the important exception caused by invalidation before snapshotting.
- No claim of browser theme, zoom, screen-reader, clipboard, or large-grid performance verification is made by this review.

## Correction review — second pass

The original three findings are addressed in the corrected implementation:

- **RLAB-01 closed:** plant switching marks refresh-needed state; render drains the latest write queue before cache invalidation and checks generation. The actual subscriber/plant-switch regression now verifies both preserved pins and restoration of prior aggregate, automatic values and absent cells through Undo.
- **RLAB-02 closed for Line Plan:** successful/failed saves patch acknowledged cells in place; submission revisions and values preserve subsequent drafts, and save completion no longer forces focus. Undo patches clean daily inputs in place. The success/failure next-cell tests and the two-queued-edits/third-draft test pass.
- **RLAB-03 closed for automatic batch reconciliation:** mutation predicates protect current overrides, and canonical rows reconcile cached state. Only applied keys enter Undo. Explicit reset and intentional Undo retain their semantics. Inspected the real PostgreSQL tests covering stale reads, explicit reset/Undo, transaction rollback and genuinely blocked insert/update/delete using `pg_blocking_pids`. **Did not rerun database tests** because root was executing the full backend suite against the shared local audit DB; root owns runtime backend verification for this pass.

The new persistent group search retains hidden selections and supports Escape/focus return; its behavioral regression passes. New copy routes through localization keys. No new defect was found in those additions.

### RLAB-04 — Medium: Aggregate acknowledgement still replaces a later draft in the same input

Locations: `frontend/labor/labor-planning.mts:249` (`_refreshSavedCells`) and aggregate `inp.onchange` at `:595`.

The line-cell correction does not cover aggregate inputs. `_refreshSavedCells` always assigns the saved value to each changed aggregate input, without checking whether the user has resumed typing there since submission. Reproduction: submit group/week 70h while holding its POST, return focus to that same input and type 84h without committing another change event, then release the POST. The draft is replaced with 70h. A failed first save likewise restores the prior saved value over the newer draft.

Confirmed using the updated harness in an in-memory reviewer probe: `h.holdNext(); input.value='70'; const save=input.onchange(); await gate.started; document.activeElement=input; input.value='84'; gate.release(); await save;` printed `{"expectedDraft":"84","actual":"70"}`. This is an uncovered sibling of the earlier draft-loss defect, not a regression in the newly fixed line-cell patch.

Fix: apply the submitted-value/revision and saved-baseline protection to aggregate acknowledgement too. Only restore the submitted draft on failure if that input still contains that submission; preserve any later draft. Verify success, failure, and two submitted edits to the same cell followed by a third unsubmitted draft. Keep deliberate Undo able to update a clean input.

Second-pass frontend verification, one file per process: `labor-audit.test.mjs` **18 passed**; `labor-planning.test.mjs` **4 passed**. No source edits, commits, or concurrent database tests were performed by this reviewer.

## Final targeted correction review — RLAB-04

**RLAB-04 closed.** Aggregate inputs now track a saved baseline and input revisions; submissions carry their value and revision into acknowledgement. Acknowledgements update clean inputs or the still-current submitted value, preserving later drafts even when a later clear happens to equal the old saved baseline. Invalid-input recovery retains unrelated dirty inputs, while deliberate Undo still updates clean cells.

Reviewed the corrected source and independently reran each Labor suite in its own process: `labor-audit.test.mjs` **23 passed** and `labor-planning.test.mjs` **4 passed**, with no failures or skips. Coverage includes successful/failed same-cell acknowledgements, two queued submissions followed by another draft, an unrelated dirty input, a later clear matching the old baseline, and clean-input Undo. No further finding in this targeted correction. No database execution, source edits or commits were performed for this pass; root owns complete backend/frontend gate results.
