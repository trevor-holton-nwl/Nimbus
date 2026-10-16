# Independent shared frontend review

Reviewed 2026-10-16 against baseline `960abf6`, before the shared author's follow-up round. Read-only implementation review; this report is the only file owned by this reviewer. Scope: shared stylesheet/index changes, platform foundation, application shell, insights services/UI, intelligence and related tests. Relevant repository/domain guidance, PRODUCT, DESIGN, PLAN and shared report were read.

**Initial disposition: changes requested.** Two reproducible snapshot issues were found. One was an inherited defect exposed by the audit's stronger restoration claim; the other was a compatibility regression introduced by narrowing only one side of comparison. See the correction re-review below for current status. No browser layout certification is possible in this environment.

## Findings

### R-SHR-01 — High: current split segments discard the requested restored finish

- Location: `frontend/nimbus-intelligence.js:1463` (TimeMachine.restore date patch), interacting with `frontend/platform/store.mts` `_normalizeDates`.
- Reproduction: load a scheduled, user-placed, unprotected local order with two current segments ending 2031-01-05 12:00. Restore a same-plant snapshot ending 2031-01-06 12:00. The production restore method retains current `scheduleSegments`; real Store normalization derives the envelope from those segments and replaces the restored finish before the engine sees it.
- Independent VM output: `requestedFinish: 2031-01-06T17:00:00.000Z`, `finishGivenToReconcile: 2031-01-05T17:00:00.000Z` (local timezone America/New_York). Only protection, reconcile and presentation collaborators were stubbed; actual restore and Store mutation/normalization ran. The reconcile stub recorded its input, so this evidence establishes loss of the requested anchor, not a complete calendar-placement outcome.
- Impact: Restore can report success while retaining the current split order's finish. This predates this branch, but contradicts SHR-08's statement that restore brings back the finish and violates the requested scheduling-preservation coverage.
- Fix: clear the stale current segment aggregate in the restore date patch and let the existing engine derive a fresh aggregate from the snapshot finish. Do not replay obsolete segment timing through a new runtime/calendar.
- Acceptance: real Store regression with a current split order must deliver the snapshot finish to reconcile. Add a current-calendar/real-engine fixture demonstrating the resulting aggregate has that finish and derived start; Undo must restore the previous valid aggregate. Include split-to-unsplit and changed-runtime cases where supported by the existing engine fixtures.

### R-SHR-02 — Medium: older mixed-plant snapshots now show false removals

- Location: `frontend/nimbus-intelligence.js:2433–2445` (Diff.showUI).
- Reproduction: an existing snapshot has `plant: 'P'` and tasks `local/P/L` plus `remote/OTHER/R`, because the baseline snapshot implementation stored all `Store.tasksArr`. Keep both orders live and unchanged, select P, then compare that snapshot. `_plantSnaps` accepts its P metadata, while the new current side contains only P.
- Independent production-showUI VM output: `selectedPlant: P`, `liveTaskIds: [local, remote]`, `reportedRemoved: [remote]`. The final harness exited successfully. An initial harness emitted the same result but lacked the output element; that harness defect was corrected before accepting the evidence.
- Impact: existing IndexedDB history falsely reports other-plant orders as deleted. The report's note about excluding snapshots with missing plant metadata does not address these ordinary, already-tagged historical snapshots.
- Fix: scope historical and current sides consistently. Resolve historical row scope using captured plant metadata when available, otherwise a live task and/or its recorded machine's plant. Exclude known other-plant rows; do not present an unresolvable legacy row as a confidently removed selected-plant order. Capture sufficient scope metadata on new snapshots, and preserve old IndexedDB history.
- Acceptance: a legacy mixed-plant snapshot compared against unchanged live data has no false added/removed/moved rows. A genuinely removed selected-plant row whose historical machine resolves to P remains a removal. An unresolvable legacy row has an explicit unknown/omitted disposition. New same-plant snapshots preserve normal diff behavior.

## Already identified follow-up work

The orchestrator separately identified the command search 2,000-order cutoff, inaccurate whole-day horizon footer, new inline Dismiss-all handler, exported `_opener` state and two no-shadow test diagnostics. Those are not duplicate independent findings here. Verify the follow-up implements all-selected-plant indexing with bounded result rendering and a 10,000-order exact-search/performance fixture, precise localized minute horizons, listener wiring, closure-private opener state, and clean targeted lint.

## Compatibility contract assessment

The new intelligence consumers `Store.tasksForSelectedPlant` and `Engine.firmingStatus` are justified. Both are existing public domain APIs (`store.mts:819`, `engine.mts:1181`) exposed through existing Store/Engine bridge objects. They centralize authoritative plant scope and manual/frozen/running protection. A narrowly reviewed compatibility-inventory addition for these references is preferable to duplicating domain rules or disguising calls to evade the ratchet. This does not authorize wholesale inventory regeneration, new private consumers or converting the classic intelligence script to a module. The inline handler and private opener growth can be removed without weakening the behavior.

## Verification and documentation assessment

Ran each file in its own process using `node --test --test-isolation=none <file>` against the existing freshly compiled twins:

| Test file under tests/modules | Passed | Failed / skipped |
| --- | ---: | ---: |
| foundation.test.mjs | 46 | 0 / 0 |
| application-shell.test.mjs | 21 | 0 / 0 |
| insights/insights-ui.test.mjs | 15 | 0 / 0 |
| insights/services.test.mjs | 27 | 0 / 0 |
| insights/confidence-lifecycle.test.mjs | 20 | 0 / 0 |
| insights/intelligence-accessibility.test.mjs | 7 | 0 / 0 |
| insights/diff.test.mjs | 6 | 0 / 0 |
| **Total** | **142** | **0 / 0** |

Minimal-DOM/mock diagnostics about localStorage and relative distribution URLs appeared in existing fixtures; all seven processes exited zero. No database, credentials, Azure or SAP actions were performed. Full build/lint/static/legacy and normal isolated npm-test gates belong to the orchestrator and are not claimed by this report.

Source and tests support the plant/window alert selector, scoped one-update dismissal, stable footer location, global Lines Set identity, native control conversion, hidden-overlay visibility, modal CSS-hidden candidate filtering and contrast calculation changes. The sampled-ramp contrast test establishes mathematical foreground contrast for its 606 sampled opaque fills; it is not rendered-browser evidence. The restore protection test stubs `firmingStatus`, which is appropriate for delegation but does not independently retest the engine's three protection reasons.

The shared report correctly discloses missing browser/zoom/screen-reader evidence and outstanding localization/announcement opportunities. Its broad source dispositions should remain labeled source inspection, not successful end-to-end coverage. SHR-08 needs qualification until the split restore and historical comparison cases above pass. No claims are made for computed layout, native-select platform behavior, actual scroll ownership, 50-plant/70-machine visual stress or browser performance.

## Correction re-review

Independently re-read the corrections and reran all seven focused suites, each in its own process: **145 passed, 0 failed, 0 skipped**. The three additional tests are in intelligence-accessibility (now 10 tests); the other counts above are unchanged.

- **R-SHR-01 closed.** The restore patch clears stale segments before normalization. The new test calls the production restore and real Store/Engine with a hydrated calendar. Six-hour split, two-hour continuous and ten-hour changed-runtime schedules retain the requested finish, derive the expected starts and segments, and Undo preserves the previous finish under the current runtime. Existing protection and pre-existing dirty-state tests also pass.
- **R-SHR-02 closed.** Version 2 snapshots capture row PLANT and explicit schema metadata. Comparison scopes legacy rows using explicit/live ownership or a unique machine owner, retaining genuine local removals and excluding foreign rows. Ambiguous or missing ownership is omitted with a localized count; an unknown-only difference no longer claims identical schedules. The machine-owner evidence set combines master data, line settings and loaded tasks so a first-match lookup cannot silently choose an ambiguous plant.
- The four intentional public compatibility reads (`Store.tasksForSelectedPlant`, `Engine.firmingStatus`, `Store.masterData`, `Store.lineSettings`) are narrowly justified by the scoped search/protection and conservative historical-scope requirements. No new bridge object or scanner weakening is needed.
- Dismiss-all is wired through an event listener; opener references are closure-private. Horizon tests verify 60 minutes as `1h` and 90 as `1h 30m`, using the existing duration formatter and a localized sentence.
- The 10,000-order fixture finds order 9,999, excludes the foreign order and generates at most nine queried results. Independent local timing was **46.96 ms indexing / 19.23 ms exact search**, excluding DOM rendering. These observations establish fixture behavior, not browser performance guarantees.

### R-SHR-03 — Medium: foreign line actions remained in the selected-plant index

Correction review found that order enumeration had been scoped but adjacent line enumeration and sample lookup still used all `Store.tasksArr` (`nimbus-intelligence.js`, `_buildIndex`). An independent VM ran the production index and selected its foreign isolate action: with P selected, local/P/L and remote/OTHER/R produced Go to/Isolate commands for both L and R; invoking the R command called `GanttFilter.isolateLine('R')`. This inherited gap permits an empty/invalid selected-plant filter despite the new scoped order search.

Requested bounded correction: reuse the selected-plant task array for order and line enumeration, and resolve the Go-to-line sample from live selected-plant tasks. Extend the existing stress fixture to reject foreign line actions while retaining local Go-to/Isolate commands. Root owns this correction; final closure follows its verification.

### Final disposition — accepted within the stated evidence limits

**R-SHR-03 closed.** Root applied the bounded correction: orders and lines share the selected-plant task array, and Go-to-line resolves its sample from current selected-plant tasks. Independent source inspection confirmed all three call sites. Reran intelligence-accessibility after this last change: **10 passed, 0 failed, 0 skipped**, including the strengthened stress assertion that the single selected-plant line generates exactly two actions despite the foreign line in loaded tasks. This final local run measured 19.73 ms index / 15.04 ms exact search; the same no-browser timing limitation applies.

All three review findings are closed. The prior seven-suite correction run passed 145 tests; the affected 10-test suite was rerun after the final line-index patch. No further concrete blocking regression was found in the reviewed shared changes. Full repository gates remain the orchestrator's responsibility. Browser layout, zoom, native keyboard behavior and screen-reader coverage remain explicitly unverified rather than implicitly accepted. This reviewer changed only this report and made no commits.
