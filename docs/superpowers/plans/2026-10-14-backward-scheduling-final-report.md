# Backward scheduling: final owner report (2026-10-14)

Written for the product owner. It closes the autonomous run of Phases 1 to 4 of the backward-scheduling migration. The plan is `docs/superpowers/plans/2026-10-13-backward-scheduling-implementation.md` (Appendix C holds the same gap tables and gate reports as this file); the spec is `BACKWARD_SCHEDULING_MIGRATION.md` (section "Implementation log and gap decisions (2026-10)"). Every fact below comes from those two documents, the run ledger and the git history; where a fact was not recorded it says "not recorded".

Sections: 1 What was built; 2 Gap decisions, verbatim; 3 Rulings made on your behalf; 4 Open owner questions; 5 Browser checks owed; 6 How to take it live; 7 Deferred minors; 8 Test evidence.

---

## 1. What was built

**The idea in one line.** Today an order's bar is placed by its start and the finish follows from the run time. After this work the bar is anchored on its **finish** (the SAP finish date stays the due date, never rewritten by NIMBUS) and its start is worked out backward through the plant's working calendar. Example: an order due Friday 18:00 with 12 hours of run time, on a line that works 06:00 to 18:00, now starts Friday 06:00 and a planner who drags it holds the finish and the start follows. Why: planners promise customers a finish, and the old rule let a longer run time or a closed day silently push that finish later.

**Phase 1 (protect the due date; deployable on its own).** The first-received SAP start and finish are stored in locked columns and are the ones the screens and Send read, so NIMBUS can no longer overwrite the due date with its own derived finish. There is one rule for recognising an SAP echo of a finish NIMBUS sent. The distribution writers stop touching the baselines. An upload without a finish is rejected (finish required, start optional). A date-only due date is read by the browser as the end of that day's working window rather than literal midnight. A run time above the cap (a flat 336 hours on every plant) sends the order to Needs Planning instead of drawing a huge bar. Send transmits firmed orders only. The purge preview shows the date range. Branch `feature/backward-scheduling-phase1`, tip `5fbdfb7`, 22 commits on top of `main` at `0317dd8`; it ships alone because the due-date protection does not move any bar. Phase 1 has a whole-branch review and one fix wave (`2ca9ea4`, `5fbdfb7`).

**Phase 2 (stored-finish contract, backward calendar, manual placement, reconcile).** The server now treats the stored placed finish as the truth and the due date as the fallback. A backward calendar walk (pure and tested, plant-zone aware) places bars from the finish. Dragging, resizing or typing a date, and every run-time, machine or version edit, hold the finish; the left edge cannot be dragged (it is reverted with a message). One clock: the server instant and the plant's time zone, with plants that have no zone blocked and told so. A reconcile re-derives stale bars on load, queues the ones that cannot fit, and places a bar forward from "now" when the backward start would be in the past (a "reversal"). The save contract checks bar width, and a new marker records an approved overtime or overlong bar. Ingest keeps the stored finish and Send remembers it.

**Phase 3 (optimizer, setup, consumers, UI, i18n, distribution).** The optimizer outputs finish-keyed bars; the old forward walk is deleted; undo re-derives. The changeover (setup) time is reserved on the backward walk. Alerts, KPIs and utilization use the plant clock, one day-attribution rule, a "late" alert and the engine's own findings as alerts. The grid, Inspector, Override modal and hover card show Planned Finish and an "explain the move" line, in five languages. Distribution sub-orders share one finish and the collapse carries it. A fresh whole-branch review of Phases 2 and 3 found 1 Critical (a planner edit refused a reversal instead of placing forward), 5 Important and 13 Minor; one fix wave fixed 13 of 19 findings and the review's re-check accepted them.

**Phase 4 (global cutover).** Two migrations: a snapshot of the pre-cutover order data, then the cutover itself. The cutover removes placed starts and ends from every order that is not in Needs Planning, deletes their segments, flags them for re-derive, and keeps running orders exactly where they are (start and old end). The image bumps the browser cache version to 7 and shows one summary toast per plant on first load with four counts: bars re-anchored on their due dates, bars moved forward from now, running orders that kept their start, and orders that could not be placed. The cutover pass is recognised by what the migration leaves behind (never-placed rows plus kept running rows exceeding half of the plant's non-queued rows), so an ordinary SAP re-upload keeps its per-row messages. Undo of a never-placed row stays display-only so Save cannot persist a placement the row never had (the old defect F10), while an unsaved attribute edit is kept. The cutover runbook is written into `docs/DEPLOYMENT.md` and was audited line by line, but never executed.

**Branches and commits.**
- `main` is no longer at `0317dd8`: when the senior-review fix wave ran it stood at `62d786e`, 7 commits past `0317dd8`, the point both branches fork from. It was not touched by this run. Merge-tree of `main` with both branches is clean (section 9).
- `feature/backward-scheduling-phase1`, tip `5fbdfb7`: Phase 1 only. Deployable alone.
- `feature/backward-scheduling`, tip after the senior fix wave and final gate `18946fc` (the wrap-up docs commit follows it; the build run itself ended at `78cb71b`, which was 47 commits and not `0b45e85`, the Phase 4 gate tip): forks from the Phase 1 tip, carries Phases 2 to 4. At the gate tip it was 110 commits and 131 files (+13616 / -2886) against `5fbdfb7`, 132 commits from `0317dd8` (63 of them since `78cb71b`). This is the cutover branch.
- Nothing was pushed, merged or deployed. No `az`, no `psql` against the pilot, no `/promote-azure`, no browser run.

---

## 2. Gap decisions, verbatim

These are the Appendix C tables of the plan, copied without summarising: the Task 0 plan-audit rulings, then the gap decisions of Phases 1, 2, 3 and 4. They are the record to rework. In the Phase 3 and Phase 4 tables a row marked "(Ruling)" is a ruling the orchestrator made; Gap is the review finding label, Choice is what was ruled and Why is the cost line.

#### Task 0 — plan audit rulings (2026-10-13)

Audit: Sonnet, report at `.superpowers/sdd/2026-10-13-backward-scheduling-implementation/task-0-report.md`. Each ruling below was folded into the task text above; the plan text is the binding version.

| # | Task | Gap found | Ruling | Why | Shows in |
|---|---|---|---|---|---|
| G-0.1 | 1.2 | `finish_echoes` in `sap_staging.py` makes `db.py → sap_staging` a circular import | define in `db.py`, re-export from `sap_staging.py` | `sap_staging.py` imports `db` at module top; one definition for three callers | import path only |
| G-0.2 | 1.5, 3.3 | `nimbus-compute-core.js` is an uncompiled UMD; `export function` and "mirrored by the build" are wrong | add helpers to the UMD return object, hand-mirror `.d.ts` | the worker `importScripts` the file | code shape only |
| G-0.3 | 1.1, 1.6, 2.3, 4.1 | `tests/test_schema_idempotent.py` pins the exact migration file list | each new migration file is added to the pin in the same commit (Global Constraint) | otherwise every migration commit is red | tests |
| G-0.4 | 1.6, 2.2, 2.3, 4.1 | plan used `planning_state = 'queued'`; real column is `planning_status = 'needs_planning'` with a CHECK forcing NULL dates | corrected everywhere; queue writers null both dates and delete segments | schema fact | SQL |
| G-0.5 | 1.6 | no plant "planning-horizon setting" exists (35 days is a constant) | `cap_hours = min(336, visibility_horizon_days×24)` when that nullable column is positive, else 336 h (superseded by senior review U5: flat 336 h) | only existing per-plant horizon-like setting; one function to change if the owner names another | Needs Planning reason, 422 on planner edits |
| G-0.6 | 1.6 | OQ28 cap applied only at ingest; a 7,000 h planner edit would pass the widened 8760 bound | the same cap rejects planner run-time edits in the bulk route (`run_time_over_cap`) and queues resolver recomputes | owner: "an order with more than the cap goes to Needs Planning" | planner sees a rejection toast for over-cap edits |
| G-0.7 | 1.2 | test (a) used New York (UTC-4): 19:00 Thu local = 23:00 UTC Thu, so no echo — the test would fail against a correct rule | M1 case uses `America/Chicago` (the spec's own example); New York variant added asserting no echo | arithmetic | tests |
| G-0.8 | 1.2, 2.7 | start-only SAP change "refreshes `original_start_received`" contradicts OQ26/OQ31 (locked on echo) | on an echo both locked columns stay; the start refreshes only when the finish is not an echo | OQ26 example: SAP back-scheduling its start after an echo must not move "first received" | due/start columns |
| G-0.9 | order | Task 1.2 before 1.4 would lock hygiene-fabricated finishes in tests | execute 1.4 before 1.2 (numbers unchanged) | locked columns must hold as-received values | none |
| G-0.10 | 1.3 | header echo judgement undefined; date-only flag not carried into `parent_facts` | header uses any member child's sent roll-up end; flag carried | `order_sap_sent` is keyed per child id with the roll-up end | distribution echo |
| G-0.11 | 1.4 | `sap_staging.py:392-397` has no rewrite; `test_finish_column_absent` not flipped; renamed counter label needs 5 locales | fix the shared hygiene function once; flip the test; add the key in all locales | anchor facts, ratchet | admin diagnostics label |
| G-0.12 | 1.5 | delete list included the live working-hours snap (`persistence.mts:578`, `calendar-sync.mts:250`) — Phase 1 would move bars | keep the snap until Task 2.5; delete only the due-date phase, `_dueEndOfShift`, the relay, the pristine capture | Phase 1 promise: no bar moves | none in Phase 1 |
| G-0.13 | 1.5 | `Util.sapDueDate` layering (platform cannot import `Calendar`) and per-row cost | day window via the compute core's helper over `Store` calendar rows, cached per line+date | existing `foundation.mts:473` route; `latenessHours` runs in grid filters | none |
| G-0.14 | 1.7 | `_outbound_candidate_rows` has no `frozen_end` | firm filter in `build_outbound_groups`, where `firm_flag` already runs; aggregate roll-up end unchanged | code shape | Send summary `skipped_unfirmed` |
| G-0.15 | 2.1, 2.4 | `plantWallClockFromInstant` is private to `engine.mts`; `Store.plantNow` needs it | move it and its inverse to the compute core UMD in 2.1; engine keeps wrappers | platform layer cannot import optimization | none |
| G-0.16 | 2.2 | `_EFF_END_SQL` already exists with 12 call sites; purge selector and resolver SELECT lists unlisted | redefine in place; every caller joins the segment lateral; purge selector reads `COALESCE(scheduled_end, original_finish_received, basic_finish_date)`; resolver lists extended | contract change must reach every reader | purge preview counts |
| G-0.17 | 2.2, 2.3 | `placement_exception` had no read projection | add to `_ORDERS_SELECT`, refresh SELECT, `TaskVersionRow`, DTO | the one new wire field must be served | wire |
| G-0.18 | 2.3 | naive width validator rejects Task 2.1's own DST case (Chicago 5 h run, 6 h naive width) | width measured in plant-zone elapsed time via `zoneinfo` when the plant has a zone | 24/7 bars across DST are legal | none |
| G-0.19 | 2.3 | routing one-time cutover branch (`resolver.py:825-829`) vs "flag on any run-time change" | delete the cutover branch; the general rule subsumes it | OQ34 a: redefinition replaces the marker | none |
| G-0.20 | 2.5, 2.6 | `finishAnchoredPatchFor` resolved `reached_now` internally, but the reconcile must batch reversals per line | `opts.deferReversal: true` returns `{kind:'reached_now'}` unresolved | OQ53 b ordering | reversal order |
| G-0.21 | 2.5 | callers `gantt.mts:4389`, `orders.mts:1378`, Override `orders.mts:1517` still pass a start | all three switched in 2.5; the Override modal's date input becomes the finish in 2.5 (field + keys), 3.4 keeps the rest | a start passed into a finish parameter would misplace bars | Override modal shows "Planned finish" |
| G-0.22 | 2.6 | selection dirtied every never-placed row on every load | never-placed, non-stale rows derive for display only (non-dirty source); stale-flagged rows (and every row after the cutover) get dirty patches | today's snap is display-only; cutover persists by owner choice; Review Focus 2 holds | Save button state |
| G-0.23 | 2.6, 3.3 | 2.6 never set `derivationIssue`; plant-level conditions had no per-task field | 2.6 sets it on every touched or skipped task; worker de-duplicates plant/line codes; new codes `frozen_window_crossed` (OQ4 a), `run_time_zero` (OQ13); `reversal_forward.detail` ∈ {run_time_grew, due_date_past, cutover} for OQ56 a | alerts must come from the worker | Alerts panel |
| G-0.24 | 2.7 | `start_derived` had no model edit; bulk-route flag vs validator precedence unstated | add to `BulkUpdateResult` + types; the bulk route passes `trust_start=False` and skips the validator | OQ59 b | API types |
| G-0.25 | 3.1 | nothing made the optimizer, Remove Backlog, autoReflow or alert Fix skip `placement_exception` rows (OQ63); forward `'overlong'` on a `never` plant still drew a bar (OQ50 c) | marked rows are fixed like firmed-under-respect regardless of the toggle; forward overlong on `never` → Needs Planning `overlong_never` | owner decisions are explicit | optimizer leaves marked bars |
| G-0.26 | 3.3 | `dayByLine`/`todayByLine` deletion misses the characterization pin and insights docs | both added to the task | test would fail | none |
| G-0.27 | 3.4 | OQ16 field-visibility setting naming the retired column | `_fieldHidden` ignores unknown ids like layouts do | consistency | none |
| G-0.28 | 3.5 | collapse carry as written was OQ37 R1 (rejected) | carry start + full run time as the stored end, keep start, flag stale (R2 as accepted) | owner accepted R2 | survivor bar ends where the planner saw it |
| G-0.29 | 4.1 | wrong column names, wrong timezone expression, running rows lost their end (late running order would be re-derived from the past due date) | SQL rewritten; running rows keep start **and** old end | OQ3/OQ5 | running bars untouched at cutover |
| G-0.30 | 4.1 | `schema.sql` mirror of the cutover runs once on any re-applied developer DB | accepted; documented in DEPLOYMENT.md/MIGRATION.md | ledger guard makes it one-time | docs |
| G-0.31 | 4.2 | `SCHEMA_VERSION` bump vs OQ36 "notice only" | keep the bump, name it in the planner notice | one-time loss of an offline cache is cheaper than serving pre-cutover rows | planner notice |
| G-0.32 | 4.3 | three migration files in one `-AllowDestructive` run | three runs in order; Q15 = 0 no-zone plants gate | Global Constraint; OQ52 d | runbook |
| G-0.33 | App. A | "reversal leg is plant-zone" was wrong | only the backward walk is; forward leg naive, DST drift accepted | forward helpers untouched by design | none |
| G-0.34 | 1.4 | OQ45 a per-upload counts (derived starts, repaired finishes, reversals) | Phase 1 shows the dropped-row counters only; derived/repaired counts are moot (no server derivation); reversal counts live in the 2.6/4.2 toast | nothing to count server-side | admin diagnostics |

#### Phase 1 — gap decisions (2026-10-14)

Copied from the implementation ledger (`.superpowers/sdd/2026-10-13-backward-scheduling-implementation/progress.md`): every line that starts with `Task 1.N: gap filled:` or is a `Ruling:` for a Phase 1 task. The Task 1.1 to 1.4 rows come from the composite ledger lines and the task reports' gap sections, because those tasks logged their gaps inside one line or in the report.

| Task | Gap | Choice | Why |
|---|---|---|---|
| 1.1 | `TaskVersionRow.original_end_date` type (the brief said a datetime or None) | a string or None, like `original_start_date` and every other date on that model | the DB layer already emits strftime strings; a `datetime` field would serialise differently and give an inconsistent generated type |
| 1.1 | brief named only the finish for the distribution child read | both `basic_start_date` and `basic_finish_date` output keys now read the locked columns (key names kept) | the pane maps both keys to `original_*`; `orders` has both locked columns |
| 1.1 | refresh row's `original_start_date` | also reads `COALESCE(original_start_received, basic_start_date)` | the brief says every projection that emits an original start or end follows the wire rule |
| 1.1 | owner list query wording ("sent rows that differ") | lists sent orders where `basic_finish_date` differs from the SAP baseline or from the sent finish | the reading that surfaces rows whose due date NIMBUS may have overwritten |
| 1.1 | backfill block placement in `schema.sql` | at the end of the file; the three column statements sit with the `sap_basic_*` columns | the backfill reads `order_sap_sent`, created late in the file |
| 1.1 | `scripts/schema_bootstrap_smoke.py` exits 1 (the brief asked it to pass) | parked as pre-existing: it fails identically on the commit before Task 1.1 | a fingerprint drift on `run_time_source` unrelated to this work; the CI gate was already red on `main` |
| 1.2 | the SAP zone inside `sap_changed_fields` and `upsert_orders` | optional `sap_tz` argument; `None` means the plant's frame (Excel); the staging apply passes `SAP_SYSTEM_TZ` | the Excel path has no SAP zone of its own; `db.py` does not import `sap_staging` |
| 1.2 | the Excel path cannot say a finish is date-only | inferred from an exact 00:00:00 when the row carries no date-only flag | one place (`_row_finish_echo`) both consumers read, so they cannot drift |
| 1.2 | an echo whose stored original is NULL | carry the incoming value, per column | nothing stored to keep; the backfill makes this rare |
| 1.3 | the brief's "siblings reset" RED no longer reproduces after Task 1.4 | kept the brief's test and added tests whose RED is real (header original finish missing; re-weight rewriting a child's baselines) | after 1.4 the header finish equals the received finish, so the green is not proof of a reproduced reset |
| 1.3 | the echo judgement needs the SAP zone inside `apply()` | `apply(..., sap_tz=None)`, passed by `upsert_orders` on the SAP path only | a plan-dict key broke a contract test that pins the plan structure |
| 1.3 | planner writes versus ingest writes in `_apply_children` | `parent["_ingest"]` mark set by `apply()` instead of a new parameter | tests that patch `_apply_children(cur, parent)` keep their signature |
| 1.3 | `order_distribution` has no start column | a planner-created child inherits the earliest locked start of its living siblings, else the header's `basic_start_date` | no header original start exists to inherit |
| 1.3 | `_resolve_wc_codes` was not in the brief's line list | its synthetic rows carry the plain order's locked dates and baselines | otherwise a client-rewritten `basic_finish_date` would be locked as the due date |
| 1.3 | standalone `plan()` + `apply()` used to default `sap_basic_*` from `basic_*` | NULL unless the row carries them; the next upload fills the baseline without counting as a change | real ingest through `upsert_orders` always carries them |
| 1.3 | `_row_finish_echo` signature | extra `finish_key` argument | the ingest row and the before-image name the finish differently |
| 1.3 | header echo across a distribution family | judged by any member child's sent finish (`_header_finish_echo`, one extra query per parent) | `order_sap_sent` is per child; the one-cycle gap after collapse or 1-to-N is the accepted OQ29 gap |
| 1.4 | `dropped_no_*` counters were never incremented | both start and finish counters bumped inside `_date_hygiene_df`; the finish counter also on a finish dated before the start | one place covers the Excel and SAP staging paths |
| 1.4 | the finish counter was never shown | new cockpit row "Dropped (no finish)", DB Load turns `warn` on either counter, key `ui.diag_dropped_no_finish` in all five locales | there was no prior key to rename |
| 1.4 | pandas infers one format and turns the rest to NaT | `_parse_finish_dates` retries missed values with `format="mixed"` | a row is now dropped on NaT, so a mixed-format column would otherwise lose rows silently |
| 1.4 | naming the dropped rows | the warning lists up to five order numbers plus "+N more" when an order column exists | the start warning text is pinned by a test and left unchanged |
| 1.4 | a test relied on the derived finish shape | re-seeded through SQL (the test was deleted in Task 1.5) | preserves what it checked until the relay it covered was retired |
| 1.4 | the unparseable-date warnings in `upsert_orders` | left untouched | only the non-live SAP sync stub can still reach them |
| 1.5 | platform cannot import Store/Calendar | new DI seam Util.setDueCalendarResolver wired in app.js (rows from Store, rev = Store.rev()) | same pattern as the other four seams, no legacy-surface growth |
| 1.5 | per-batch caching of the day window | per line+date cache invalidated on Store revision change | per-row callers stay O(1) with no staleness |
| 1.5 | missing plant hours | use the line window alone (no default 7-19) | brief only defined the missing line calendar case (raw + 23:59:59) |
| 1.5 | worker jointWindowForDay defaults missing calendars to 7-19 | separate ctx._dueWindow memo returning null for a missing line row | keeps worker and main thread consistent with ruling (b) |
| 1.5 | dueTimestamp had no snapshot access | required DueScope {snapshot, plant?, ctx?} param at all 12 call sites | compiler-enforced, no module-level mutable state |
| 1.5 | Engine.earliestAllowedStart/latestAllowedEnd | routed through the same dueInstant (sourceDueInstant) | otherwise Engine and worker bounds disagree and the tighter silently wins |
| 1.5 | brief's "pristineOriginalStart cache restore (890-891)" is actually the cached original_end_date restore in _overlayUserMoves (pristineOriginalStart is the capture in the snap) | removed both | a stale cached due must not override the server's locked SAP finish |
| 1.5 (Ruling) | optimizer pull-forward floor / push ceiling on a closed due day now follow the OQ23 window rule (Sunday due, N=0 → floor Fri 00:00, ceiling Sat 00:00) | accepted as the spec's consequence, optimizer-only, to be named in the Phase 1 gate report and the owner report | cost if wrong: optimizer places some orders one weekend earlier than before Phase 1 |
| 1.6 | brief's "422-style" bulk rejection | reused the existing per-id envelope (invalid_ids + rejection_reasons[id]='run_time_over_cap', HTTP 200) | a 422 would reject the whole batch and the save path already renders rejection_reasons per id (toast needs no new key; ui.reject_run_time_over_cap added) |
| 1.6 | migration split across two files in the 2026-09 pair | one file/one transaction (DROP + ADD NOT VALID + VALIDATE + ledger row) | widening cannot fail validation and a split would leave a window with no constraint |
| 1.6 | releasing a queued over-cap order | added run_time_over_cap to the resolver's _is_routing_hold vocabulary and a symmetric release in the ingest queue step (never releases/overwrites another hold reason) | each run-time owner releases only its own reason |
| 1.6 | row number for >=8760 rejection | check runs before date hygiene resets the index (row = index+2); also rejects negative/non-finite values | matches the Excel row the planner sees and those values would fail the chunk at the CHECK too |
| 1.6 | running order over the cap | not queued (only when it holds a slot), counted as running_kept in the upload warning | honours the SAP-truth rule that an upload never un-schedules a running order |
| 1.6 | localised reason label | reason JSON carries run_time/cap_hours and orders.mts renders planning_reason.run_time_over_cap via the locale for this code (server English message remains fallback) | same pattern as planner_unscheduled |
| 1.6 | plant cap lookup in update_task_dates_bulk | lazy per-plant query (_plant_caps) instead of widening the locked eff-row SELECT | keeps fake-cursor tests that pin that row shape untouched |
| 1.6 (Ruling, flagged) | whether a queued run_time_over_cap row can re-enter the schedule via a date-only edit/optimizer | owned by Phase 2 Task 2.5 (Needs Planning release path: run_time_over_cap releases through finishAnchoredPatchFor; queued rows are excluded from reconcile/optimizer intake); no Phase 1 action | cost if wrong: an over-cap row could be dragged back onto the Gantt before Phase 2 ships (planner-visible, reversible) |
| 1.6 (Ruling) | migration header wording ('the brief for this task asked for exactly this') | reworded by Task 1.9 (docs/Haiku) together with the other durable-text nits | cost if wrong: none |
| 1.7 | summary shape for skipped_unfirmed | build_outbound_groups now returns a 3-tuple (groups, skipped_no_end, skipped_unfirmed) and callers/tests updated | the pure function is the only place that knows which groups were dropped |
| 1.7 | unit of skipped_unfirmed | counted per planned order (group), not per child row | matches "queued" semantics; firmed-but-no-end counts only in skipped_no_end |

#### Phase 2 — gap decisions (2026-10-14)

Copied from the implementation ledger (`.superpowers/sdd/2026-10-13-backward-scheduling-implementation/progress.md`): every line that starts with `Task 2.N: gap filled:` or is a `Ruling:` for a Phase 2 task (Tasks 2.1 to 2.8), one row each, in ledger order. For a Ruling, Gap is the situation, Choice is what was ruled, and Why is the stated reason followed by its `Cost if wrong:` line, copied from the ledger; where a ruling states no reason, the Why cell is only the cost line. The Phase 2 gate ruling in the ledger (no separate whole-branch review before the Phase 3 gate) is not a task ruling; it is listed last, as "Phase 2 gate".

| Task | Gap | Choice | Why |
|---|---|---|---|
| 2.1 | _freeIntervalsBackward order | chronological (allocator walks from the end) | matches forward _freeIntervals |
| 2.1 | reason when several causes apply | the last cause reached names the move (no_slot_at_finish / min_piece override closed_finish / blackout) | the later cause explains the final distance |
| 2.1 | overlong test | run time vs longest merged nominal window (blackouts ignored, finish window measured whole) | mirrors forward hasNominalWindow and avoids false overlong from a clipped window |
| 2.1 | overlong_only with an overlong order | returns overlong (forward splits) | brief says overlong for never and overlong_only; caller decides OQ50 |
| 2.1 | lookback/floor exhausted with windows present but no capacity | reached_now | brief's unavailable means no window at all; lets the caller try forward from now |
| 2.1 | invalid run time or unusable timezone | unavailable | union has no exhausted kind; non-throwing, non-placing is conservative |
| 2.1 | latestAvailable snapping | minute-level only, no 15-minute snap | second snap would break start + run time = finish |
| 2.2 | client visibility key (brief says original_start_date) | BASIC_START_DATE ?? original_start_date | original_start_date is the calendar-snapped display baseline, BASIC_START_DATE is the raw copy of the locked wire start |
| 2.2 | runtime-client.mts:192 | kept BASIC_START_DATE-first precedence, added comment + node pin | it already reads the raw copy of the wire locked start, switching to the snapped field would diverge from the server |
| 2.2 | _EFF_END_SQL has no queued CASE | added _EFF_END_UNLESS_QUEUED_SQL for wire/refresh/prefetch/distribution readers | replaces four inline copies |
| 2.2 | dup sort key finish fallback | module-level _duplicate_id_sort_key, finish used only when start is None | rows with a start must sort as before or ingest ids permute |
| 2.2 | _load_setup_coverage order key | _EFF_START_SQL (queued rows sort last per machine) | brief says order by _EFF_START_SQL |
| 2.2 (Ruling) | plan text mandated _EFF_END_SQL for neighbours, which makes a never-placed row occupy [SAP start, due date] | the scan's neighbour set is restricted to _PLACED_SQL rows (never-placed and queued rows cannot conflict server-side; the browser's overlap alert still covers display overlaps) | a conflict is between placements, and OQ33 A gives a never-placed row no server placement Cost if wrong: a server-side overlap against a never-placed row goes unreported (client alert remains). |
| 2.3 | browser always sends schedule_segments (`[]` when continuous) | width gate applies to any continuous saved shape (no segments, [] or one piece), segments ≥ 2 keep the segment rules | otherwise the validator never runs from the real client |
| 2.3 | marker precedence for the width gate | item's value if sent (None clears), else the stored one | explicit null re-enables the check, a marked bar leaves the flag untouched |
| 2.3 | single-edge rejection reason | `single_edge` (+ `width_mismatch`) translated in 5 locales | describeRejections shows plain language, not raw codes |
| 2.3 | zero run time | width gate does not apply | a bar cannot have zero width |
| 2.3 | trust_start=False (Task 2.7) | no parameter added, gate is one block in the validation loop | avoids dead code, a keyword arg can gate it later |
| 2.1 (Ruling) | optimize-ui.test.mjs regression (first bad 2f2ec27) | is fixed as Task 2.1 fix round 1 (test bootstrap line only, matching the other optimization test files) — the wrapper keeps reading the compute-core global (one code path) | Cost if wrong: another future Node test importing engine.mjs alone hits the same hazard; mitigated by the comment the fix adds. |
| 2.3 (Ruling) | plan text implied the gate on every non-segment save | skip the gate when the sent start/end equal the stored RAW scheduled_start/scheduled_end (both non-NULL) and the run time is not changed; width_passed stays False so runtime_schedule_mismatch is untouched; compare raw columns (never the effective/SAP-fallback edges) so an unplaced row's SAP window can never be stamped as a placement | a planner's PRT/machine-only edit on a stale bar the engine could not re-derive (no zone / no calendar) must not be rejected Cost if wrong: a legacy mismatched bar can be re-saved unchanged (flag stays TRUE, so the reconcile still re-derives it). |
| 2.4 | where blocked plants are recorded | Store._blockedPlants Set + one toast per plant from Store.plantNow | simplest shape; Task 3.3 reads the Set for the alert |
| 2.4 | plant not yet in master data | plantNow returns null without recording or toasting | avoids a false no-timezone report before master data loads |
| 2.4 | optimizer liveClock for a blocked plant | keeps the viewer-clock fallback but records the plant | refusing to run is placement-blocking (Tasks 2.6/3.3) and would break many fixtures |
| 2.4 | Util.plantNowParts cannot import Store | Util.setServerNowResolver self-wired at the bottom of store.mts | no cycle, no app.js edit |
| 2.4 | compute-core payload now | Record<plant, Date> read per order plant, thread clock when absent | per-plant brief wording, other callers unchanged |
| 2.1 (Ruling) | optimizer-worker.test.mjs worker_threads realm failure | test-only (real worker imports the core first); fixed as Task 2.1 fix round 2 in the test bridge strings; no production change | Cost if wrong: none at runtime. |
| 2.5 | refusal channel for a null placement | Engine.lastManualRefusal + opts.quiet | callers must tell "engine already toasted" from "say something" and ask the overtime confirm without changing the return type |
| 2.5 | overlong_only policy with an overlong order | retry the backward walk as partial_allowed | Task 2.1 returns overlong but the forward allocator splits such an order |
| 2.5 | blocked plant for a rigid segment translation | translation never needs a zone, only derivation refuses | a translation is not a derivation |
| 2.5 | no Needs Planning release action exists | release happens through the machine/run-time/version edit surfaces on rows queued runtime_unknown/overlong_never/run_time_over_cap, anchored at Util.dueInstant | the only planner re-placement path today |
| 2.5 | alert placement_exception on release | not computed on the main thread, Task 3.3 reads the wire field | shared alert-plumbing rule |
| 2.5 | OQ3 at six run-time-edit sites | one holdStartIfRunning option inside the engine | routing machine moves still need the resolver path in manualRoutingSchedulePatchFor |
| 2.5 | label for overlong_never | planning_reason.overlong_never rendered in the Planning reason cell | matches run_time_over_cap |
| 2.5 | toast.commit_failed said "requested start" | reworded in all five locales | placement is finish-anchored now |
| 2.5 | dead calendar seam after deleting the snap | removed Persistence.setCalendarService, its interface and the app.js wiring | nothing else called it, legacy surface shrinks |
| 2.5 | left-handle veto | vis onMoving (lockLeftEdge) snaps a start-only drag back, commit-time revert + toast kept as fallback | possible and cheap, handle stays visible, not browser-verified |
| 2.5 (Ruling) | planner run-time/machine/version edits route through manualSchedulePatchFor | so a held finish that cannot be reached is refused with toast.finish_cannot_hold (same as a drop, OQ13 b) rather than accepting the walk's moved finish; the walk's own answer is reserved for system re-derivations (Task 2.6 reconcile, with the finish_moved_earlier alert) **[Corrected in the Phase 3 fix wave: the refusal applies only when the walk would move the finish EARLIER; a backward start before now reverses forward from now with `reversal_forward` (O2, OQ3, OQ7 a, OQ19 c).]** | Cost if wrong: planners must drag the bar to a reachable finish before changing run time/machine on a closed-day finish (reversible; owner can flip the reading later). |
| 2.5 (Ruling) | a Needs Planning release (overlong_never / run_time_over_cap) whose due instant is already past | is NOT a finishMoved refusal: the release has no held finish to protect, so reached_now resolves forward from now (reversal) and the row carries derivationIssue reversal_forward (detail due_date_past) | Cost if wrong: a late released order lands at now instead of being refused (planner-visible, reversible). |
| 2.6 | no server-calendar-row predicate | CalendarSync.hasServerLineCalendar reads the line_work_hours keys of GET /plant-calendar | the client default is never a server row |
| 2.6 | no calendar hydration state | per-plant _hydration (pending/hydrated/failed) in calendar-sync, hydrated set before the calendar:change emit | reconcile must never derive on default hours |
| 2.6 | no non-dirty source for task writes | new 'engine-runtime-reconcile-display' added to App._trackDirty skip list | never-placed rows derive for display only, Save leaves the server row never-placed |
| 2.6 | banner ui.derive_paused | #derive-paused-banner driven by Engine.derivePausedPlants | same band as the concurrency banner |
| 2.6 | run_time_zero "no bar" | row left as is plus derivationIssue run_time_zero | nothing can be placed |
| 2.6 | running row whose start the allocator would move | keep start, end = start + run time, no segments | start never moves and width equals run time for the server width check |
| 2.6 | frozen_window_crossed scope | manually firmed rows only | SAP firm is display-only and unfirmed never-placed rows would flood alerts |
| 2.6 | calendar cannot place a row | untouched + derivationIssue no_operating_window + error-log warn | visible instead of a silent stale flag |
| 2.6 | setupMinutes | FinishAnchoredOptions.setupMinutes passed as 0 | Task 3.2 only fills it |
| 2.6 (Ruling) | user_scheduled is a server wire flag the client never updated | any client schedule write that is not display/refresh (drop, edit, optimizer apply, release) sets user_scheduled=true locally and save success keeps it; the reconcile candidate filter also skips Persistence._dirtyIds | the dirty-vs-display split must never let a display derivation clobber or save a planner placement Cost if wrong: a row the planner edited is treated as placed for the session (safe direction). |
| 2.7 | /tasks/bulk_update trust_start caller list (Phase 0 item g unanswered) | optional request field trust_start: bool = True, forwarded in the item dict only when False, honoured by /tasks/update and /tasks/bulk_update | keeps every existing item shape and test pin unchanged; browser's own save never sends it |
| 2.7 | dropped_no_start_date cockpit counter | renamed unreadable_start_date, counts only unreadable (non-blank) starts, label reworded in 5 locales (ui.diag_unreadable_start) | rows are no longer dropped; a blank start is normal |
| 2.7 | malformed start on SAP staging | still invalid_date (Excel keeps the row with a warning) | 'start optional' means absent; a malformed value is corrupt data and the existing validator/builder already reject it |
| 2.7 | dates_echo vs planner slot | now in_f == scheduled_end only | the finish is the anchor, the start no longer decides |
| 2.7 | basic_start_date on a re-upload sending no start | COALESCE(EXCLUDED, stored) | NULL means not sent everywhere else in the upsert |
| 2.7 | new-child carry (1->N and re-weight) | copy placed finish (plain order's stored finish / latest sibling stored finish) as scheduled_end, start NULL, stale flag TRUE; no placed finish = child stays unplaced | OQ58 inference, no forward start+run_time write left in db.py/backend |
| 2.7 | GET /tasks drop-filter on NULL BASIC_START_DATE | keeps any row with a finish | otherwise a NULL-start never-placed order vanishes from the browser |
| 2.7 | start_derived shape | sparse {id: True} map of persisted ids on BulkUpdateResult (not on TaskDTO) | like rejection_reasons |
| 2.7 (Ruling) | /tasks/bulk_update default trust_start=True (the browser save is the main caller and sends starts it derived) | external callers pass trust_start=false to get the start flagged instead of width-checked; flipping the default waits on the Phase 0 item g caller list (owner question) | Cost if wrong: an external writer that omits the flag gets width_mismatch rejections instead of a flagged placement (visible, reversible). |
| 2.8 | baseline test_sap_staging::test_same_instant_batches_have_exactly_one_winner | instants made relative to now (date_trunc('second', now()) - 1 hour) | hard-coded 2026-10-07 fell outside the 7-day retention window |
| 2.8 | i18n parity | no edits needed | every Phase 2 key (and the reworded commit_failed/diag_unreadable_start) is already in all five locales with real translations; node --check clean; locale tests green inside npm test |
| 2.8 | status-only 'scheduled' save on a never-placed row (db.py guard) | rejected as rejection_reasons single_edge, guard reads the RAW stored edges + segment_count (not the SAP-window fallback) | consistent with Task 2.3 (never complete an edge from anything but what the planner sent; no new wire reason, no new locale key since ui.reject_single_edge already exists); a placed row's status-only save still passes and rewrites no edge |
| 2.8 | distribution header/child basic_start_date | COALESCE(incoming, stored) in the child upsert, header SET and header change-guard (guard uses %(bs)s::timestamp, Postgres cannot infer the bare parameter type) | matches db._UPSERT_SQL; pin drives _apply_children directly because the ingest seam writes children via db._UPSERT_SQL first, which made an upload-only pin non-discriminating for the child half |
| Phase 2 gate (Ruling) | whether Phase 2 gets its own whole-branch review | no separate Phase 2 whole-branch review: the plan puts the fresh whole-branch review at the Phase 3 gate (covers Phases 2+3); the Phase 2 gate = suites green + gate report | Cost if wrong: a Phase 2 cross-task defect waits until the Phase 3 review (same branch, nothing released). |

#### Phase 3 — gap decisions (2026-10-14)

Copied from the implementation ledger (`.superpowers/sdd/2026-10-13-backward-scheduling-implementation/progress.md`, Phase 3 lines extracted to `phase3-ledger-extract.md`): every line that starts with `Task 3.N: gap filled:` or is a `Ruling:` for a Phase 3 task (Tasks 3.1 to 3.5), one row each, in ledger order. For a Ruling, Gap is the review finding or gate label, Choice is what was ruled, and Why is the cost line copied from the ledger. Task 3.6 (this documentation pass) is not a ledger task.

| Task | Gap | Choice | Why |
|---|---|---|---|
| 3.1 | reconcile on undo vs dirty rows | new ReconcileOptions.ids bypasses the unsaved-edit skip for restored ids | undo rows are dirty by construction |
| 3.1 | toast after undo re-derivation | suppressed (reason 'undo') | undo already announces itself |
| 3.1 | G-0.25 in Remove Backlog | marked rows excluded from the move set | Remove Backlog ignores firmed, so "fixed" must mean not moved |
| 3.1 | OQ50 c elapsed bar | placeForwardSequence refuses never-policy overlong (queued overlong_never via Engine.overlongNeverChanges; reconcile reversal queue too) | only remaining continuous-bar path |
| 3.1 | legacy walk callers | none in production (only 'legacy-compat' tests); unknown modes now take the setup-aware path | nothing to re-route |
| 3.1 (Ruling) | I1 | the implementer gap-fill "the optimizer has no overlong path" is overturned: a never-policy order the setup-aware scheduler cannot fit because its run time exceeds every contiguous window is queued with reason overlong_never (brief OQ50 c/a7), not no_fit_found/search_limit, so the release path keyed on overlong_never can act on it; a genuine no-window-at-all failure keeps no_fit_found | cost if wrong: an order mislabelled overlong_never could be released as an elapsed bar when it was really unplaceable for another reason (visible, reversible). |
| 3.1 | never-policy overlong detection | longer than every contiguous window while the line has windows (hasNominalWindow false for run time, true for 1 minute) | separates overlong from no-window and plain no-fit |
| 3.2 | adjacency helper at setup-domain.mts:467 does not exist | used by-start adjacency (as deriveSetupObservation) via a per-pass line index in the reconcile | brief anchor stale, same rule the setup bars use |
| 3.2 | issue priority when several findings apply | finish_moved_earlier > setup_override_orphaned > frozen_window_crossed > pull_floor_crossed | one derivationIssue field; orphaned loses planner data so outranks the advisory two |
| 3.2 | no predecessor on the line | asserted machine state if any, else 0; a display-only predecessor also gives 0 | mirrors observation "initial" and the orchestrator ruling |
| 3.2 | setup-scheduler.test.mjs O(n^2) availability reference | updated to merge across midnight | it mirrors production and would disagree by design after the A.3 #9 fix |
| 3.2 (Ruling) | I1 | when the setup-aware second walk in the reconcile cannot place (contiguous policy, run within setupMinutes of the longest window), the zero-setup placement with the held finish stands and the setup-violated alert fires; the row is never pushed to the forward reversal by the setup reservation alone (setup is a preference the V1 rule tries to honour, not a reason to reverse) | cost if wrong: a planner sees a held-finish bar with too little changeover room flagged by an alert instead of a reversed bar. |
| 3.3 | day-attribution rule | working-window-weighted spread; split exact; closed-time-only bar falls back to wall-clock | keeps hours visible so the closed alert fires, matrix sums to run time |
| 3.3 | plant-level alert line | plant smallest affected line, emitted only when in scope | incremental merges never duplicate the plant alert |
| 3.3 | late alert scope and ceiling | non-queued orders in the alert horizon; ceiling = due midnight + (N+1) days from max_push_forward_days; no-calendar line reads raw+23:59:59 | matches Util.dueInstant and the optimizer ceiling |
| 3.3 | mismatch alert type | kept runtime-schedule-mismatch, reworded via alert.start_may_be_stale | existing tests and CAT_MAP depend on the type |
| 3.3 | severity table | error: late beyond cap, reversal_forward, placement_exception, plant_no_timezone, line_no_calendar, no_anchor; warning: late, finish_moved_earlier, pull_floor_crossed, frozen_window_crossed, setup_override_orphaned, run_time_zero, no_operating_window, unknown code | orchestrator ruling |
| 3.3 | unknown derivationIssue code | generic type derivation_issue with key alert.derivation_issue | never silently dropped |
| 3.3 (Ruling) | gate 14 | the Task 2.6 scope of frozen_window_crossed (manually firmed rows only) is widened to placed, unfirmed rows whose derived start moves from outside to inside the frozen window in that reconcile (a from->to transition); never-placed / display-only / queued rows stay excluded, so the 2.6 flood concern holds while spec R26 (an unfirmed order flipping frozen is sent firm irreversibly) becomes visible to the planner | cost if wrong: extra warnings on rows a planner already expected to firm (noise, no data change). |
| 3.4 | keyboard move path | no keyboard bar-move exists, so tests pin that arrows write no dates and that drag, grid End and Inspector End all call manualRoutingSchedulePatchFor with the finish | the Gantt keyboard handler only selects (G6) |
| 3.4 | retired Original/Updated locale keys | deleted from all five files by the implementer, Haiku only adds the new-name keys | keeps the superset test green and avoids stale wrong-meaning translations |
| 3.4 | explain-the-move line | ui.insp_system_move plus six ui.insp_move_reason_* keys; codes that are not moves render nothing | matches the orchestrator ruling |
| 3.4 | no-op resize | a patch equal to the stored bar writes nothing, pushes no undo entry, rebuilds the item | A.3 #18 |
| 3.5 | CSV due_date column position | appended last | keeps existing column indices stable |
| 3.5 | "firmed" survivor in collapse dry-run | manual_firmed or SAP firming X, listed and needs confirm | start may move under R2 |
| 3.5 | gate 17 layer | calendar-engine test (allocateRuntimeBackward vs allocateRuntime) | the allocators are where the 10-minute drift lives |
| 3.5 | separation alert wording | reworded in five locales (start→finish) | message must match the finish judgement |
| 3.5 (Ruling) | minor "commit trailer reads Claude Fable 5.1" | not a defect: the session attribution rule mandates that trailer for every commit of this run; no change. |  |
| 3.5 (Ruling) | minor "manual run time carried into the R2 end" | stands as pre-existing D11 behaviour (R2 builds the end from whatever run time the collapse re-weight leaves on the survivor; whether a planner-typed partial-share run time should be rescaled on collapse is an owner question for the final report) | cost if wrong: a collapsed survivor with a manual run time gets a finish that is too early by the share ratio, visible on the Gantt and reversible by re-typing the run time. |

**Deferred minors from Phase 3 reviews** (verbatim from the ledger):

- Task 3.1: minor (deferred): setup-scheduler.test.mjs:5113 title still says "moved starts" (brief said flip it).
- Task 3.1: minor (deferred): no tests for autoReflow/Alerts.applyFix marked-row guard, Remove Backlog dialog note, TimeMachine.restore.
- Task 3.1: minor (deferred): stale "legacy" comments in engine.mts (864-871, 909-915, 962, 1721, 2423, 2477, 2568).
- Task 3.1: minor (deferred): the plain no-fit-with-windows side of neverOverlongReason has no explicit test (returns null by construction).
- Task 3.2: minor (deferred): reconcile predecessor search ties by id but the observation sorts by start only (same-start rows may differ).
- Task 3.2: minor (deferred): no test pins msgKey/msgVars on the emitted setup-violated alert.
- Task 3.2: minor (deferred): stray blank line at end of the midnight availability test in engine.test.mjs.
- Task 3.3: minor (deferred): services.mts:872 _prewarm uses the viewer today while Dashboard keys the matrix on the plant clock (cache miss only when zones differ).
- Task 3.3: minor (deferred): nimbus-intelligence.js:1836 shows English a.msg for worker alerts (t() is reachable; pre-existing, one-line fix).
- Task 3.3: minor (deferred): alert card headlines for new types are title-cased English from the type code (no ui.alert_headline_* keys).
- Task 3.3: minor (deferred): workingMinutesByDay ignores blackout blocks (matrix/overload/briefing still agree).
- Task 3.4: minor (deferred): Util.impliedOriginalStart (foundation.mts:701) now has no callers; delete.
- Task 3.4: minor (deferred): stale "Updated End" comment at orders.mts:1948.
- Task 3.4: minor (deferred): Alerts auto-fix toast (services.mts ~469) reads the finish before autoReflow runs.
- Task 3.4: minor (deferred): _varianceBadge gives a 0.0h variance the "early" class (cosmetic).
- Task 3.4: minor (deferred): still-unkeyed English: Inspector setup-override editor, Productive schedule/Part N card, hover alert type ids, modal close aria-label.
- Task 3.5: minor (deferred): stale "start" wording remains in en.js:2178 ui.dist_status_separation_violated_tip and hardcoded optimize-ui.mts:2005 beside the reworded finish alert.
- Task 3.5: minor (deferred): collapse carries a planner-typed MANUAL partial-share run_time (D11) as the survivor run time, which now drives the R2 end; confirm intended "full-share run time".
- Task 3.5: minor (deferred): untested branches: NULL/0 run-time collapse arm, SAP firming X in `firmed`, repair guard is a kwarg-capture mock.
- Task 3.5: minor (deferred): get_aggregate due_date value has no DB-backed round-trip test (mocked rows only).
- Task 3.5: minor (deferred): commit trailer reads "Claude Fable 5.1" instead of "Claude Sonnet 5.5".

**Unverified in Phase 3** (verbatim from the ledger, one per cannot-verify line):

- Task 3.1: ⚠️ cannot verify: bench wall time (after run under load; digests identical per report only) and full-suite status.
- Task 3.2: ⚠️ cannot verify: test results (read-only review); DST behaviour of the 14-day touching-window loop in setupAvailabilityMinutes.
- Task 3.3: ⚠️ cannot verify: browser rendering of msgKey alert text and plant-clock today in Gantt/orders (no smoke).
- Task 3.3: ⚠️ cannot verify: payload calendars absent-row reading always equals Util.dueInstant no-calendar reading when Store auto-creates default calendars.
- Task 3.4: ⚠️ cannot verify: Override modal / hover card in a browser; system-move line only tested against a stub locale.
- Task 3.5: ⚠️ cannot verify: pytest/node results (read-only review; relied on the implementer report).

#### Phase 4 — gap decisions (2026-10-14)

Copied from the implementation ledger (`.superpowers/sdd/2026-10-13-backward-scheduling-implementation/progress.md`, Phase 4 lines extracted to `phase4-ledger-extract.md`): every line that starts with `Task 4.N: gap filled:` or is a `Ruling:` for a Phase 4 task (Tasks 4.1 and 4.2), one row each, in ledger order. For a Ruling, Gap is the review finding label, Choice is what was ruled, and Why is the cost line copied from the ledger. Task 4.3 (the runbook text) logged no gap line.

| Task | Gap | Choice | Why |
|---|---|---|---|
| 4.1 | snapshot omits original_*_received | omitted | existing test_original_dates_schema_applies_twice pins which tables carry those columns and cutover never writes them |
| 4.1 | test isolation | single rolled-back transaction | now() is txn-stable so plant-local now is exact, no residue |
| 4.2 | who triggers the cutover pass (nobody passed reason 'cutover') | first-load pass with stale*2 > non-queued rows (queued excluded) is the cutover pass; explicit reason wins; undo never (narrowed by the I1 ruling below: the data signature, not the ratio alone) | keeps the brief's >50 % rule without a new call site; reversals then carry detail 'cutover' |
| 4.2 | count sources | stale rows only: re-anchored = backward-placed, reversed = forward-from-now placed, kept running = held-start patches, blocked = plant_no_timezone/line_no_calendar/no_anchor; toast only if counts sum > 0 | matches the brief's list; other refusals are in no bucket |
| 4.2 | F10 never-placed predicate | !task.user_scheduled after restore (the reconcile's own display-only test); reconcileRestored clears stale flag via display source and drops ids from _dirtyIds/_forceIds | so Save cannot persist a placement the row never had |
| 4.2 | placeholder syntax | {{n}}/{{m}}/{{k}}/{{j}} | the repo's Util.t only interpolates double braces |
| 4.2 (Ruling) | I1 | the cutover pass is detected by the data signature the cutover SQL leaves, not by a stale ratio alone: a first-load pass counts as the cutover pass when the stale rows that are never-placed (both edges NULL, !user_scheduled) plus the running rows that kept start and end exceed 50% of the plant non-queued rows; stale rows that still carry a placement (an ordinary SAP/routing re-upload) never count, so such a load keeps the per-row Toasts and detail run_time_grew; an explicit reason:cutover still wins | cost if wrong: a plant whose cutover rows were somehow placed before first load shows per-row Toasts instead of the summary (cosmetic). |
| 4.2 (Ruling) | I2 | the F10 fix must drop only the placement from what Save persists: on undo / Time Machine restore of a never-placed row, the row stays dirty if it carried an unsaved non-date edit before the Apply (the undo entry records per-id pre-Apply dirtiness, or the restore compares non-date fields against the server copy), and only the derived dates/segments are excluded from the save payload; the placement side of the existing F10 test stands | cost if wrong: an unsaved attribute edit on a never-placed row is silently lost on undo (the current behaviour the reviewer found). |
| 4.2 | I2 mechanism | record pre-edit dirtiness on the undo snapshot and omit dates/segments from a never-placed row's save payload | keeps unsaved attribute edits while dropping only the placement |

**Concerns recorded in Phase 4** (verbatim from the ledger, one per concern line):

- Task 4.1: schema_bootstrap_smoke still exits 1 (pre-existing routing_runtime_legacy_backfill ledger drift), nothing new from this task.
- Task 4.1: nimbus_sdd holds no orders, so the migrations were hand-applied to an empty table; data effect proven only by the rolled-back test fleet.
- Task 4.2: four existing reconcile tests had 1-2 stale rows of 3 and tripped the new >50 % threshold; each got one placed non-stale row (no behaviour assertion changed). A tiny plant with one stale row will show the cutover toast. (Superseded by fix round 1: the signature rule reverted those fixture rows.)
- Task 4.2: de/es/fr/pt toast copy is machine-quality, not native-reviewed.
- Task 4.2: F10 drops dirtiness of a never-placed row that had an unrelated unsaved non-date edit before the undo. (Fixed by the I2 ruling.)
- Task 4.2: any dirty never-placed row (not only undone ones) now saves without dates; server treats omitted dates as leave-alone (read in routes.py), not exercised against Postgres.
- Task 4.2: a snapshot not taken via snapshotTasks (Time Machine restore of stored snapshots) has no dirtiness record, so its never-placed rows are made clean as in round 0.

**Deferred minors from Phase 4 reviews** (verbatim from the ledger):

- Task 4.1: minor (deferred): test run-futuredue row cannot discriminate old_end arms, plus a stray `- _h(0)` in the assertion
- Task 4.1: minor (deferred): no boundary rows (start == now, old_end == now) pin the `<=` / `>` semantics
- Task 4.1: minor (deferred): updated_at compared via str() > OLD in the test; use datetime compare
- Task 4.1: minor (deferred): running rows with run_time and no segments get end = start + run_time, replacing a differing stored scheduled_end; mention in Task 4.3 runbook
- Task 4.2: minor (deferred): no once-per-plant guard; blocked-heavy plants re-fire the summary toast on each later pass.
- Task 4.2: minor (deferred): runbook G-6 SQL timestamp is database-session time, say so.
- Task 4.2: minor (deferred): rehearsal step 3 should say to apply the 2026-10-15 files to the copy if the pilot lacks them.
- Task 4.2: minor (deferred): Time Machine stored-snapshot restore has no dirtiness record, so a never-placed row's earlier unsaved attribute edit is not re-saved.
- Phase 4: minor (deferred): two eslint warnings in engine.test.mjs (unused `hours`, shadowed `fresh`) added by the Phase 3 fix wave; 0 errors so the gate holds. (Cleared by the fix round: the final lint run has 34 warnings, down from 36.)

**Unverified in Phase 4** (verbatim from the ledger, one per cannot-verify line, plus the unverified list of the Task 4.3 review):

- Task 4.1: ⚠️ cannot verify: did not run tests or the smoke script (read-only); test evidence taken from the implementer report
- Task 4.2: ⚠️ cannot verify: runbook gates (sslmode locally, proxy cache, revision on env change, Excel freeze, PITR) are platform facts the repo does not answer.
- Task 4.3 (runbook): review — 19 commands audited, 1 corrected (4c3df45); unverified left: local server accepting sslmode=require, proxy caching index.html, env-var change creating a revision, Excel upload freeze switch, platform PITR window, previous image's handling of flagged never-placed rows
- Task 4.3 (implementer report): the G-6 SQL and the Q15 SQL were not run against any database.

---

## 3. Rulings made on your behalf

Every `Ruling:` line in the run ledger (30), in ledger order, wording kept: what was decided, why, and what it costs if wrong. The ledger line number is in brackets. Plain reading: a ruling is a call the orchestrator made so the run did not stop; each one is reversible and each states its own cost.

1. [ledger line 9] .env read is permission-denied in this session — use PG_HOST=localhost PG_DB=nimbus (plan §1 allows "from .env or nimbus") — cost if wrong: tests hit a different local DB name and fail to connect (visible immediately).
2. [ledger line 10] spec committed as the second commit on the phase1 branch (plan doc is first, per owner) so the appended "Implementation log" section can be committed — cost if wrong: one extra docs commit the owner can drop.
3. [ledger line 16] task test runs use PG_DB=nimbus_sdd, baselines use PG_DB=nimbus — cost if wrong: none (both are fresh schema.sql copies; isolates implementer runs from phase-end baselines).
4. [ledger line 17] re-applying schema.sql to the stale, empty local `nimbus` DB counts as routine environment repair (0 orders, local only) — cost if wrong: none.
5. [ledger line 30] environment — all pytest commands add PG_SSLMODE=disable — cost if wrong: none.
6. [ledger line 85] Task 1.5 — optimizer pull-forward floor / push ceiling on a closed due day now follow the OQ23 window rule (Sunday due, N=0 → floor Fri 00:00, ceiling Sat 00:00) — accepted as the spec's consequence, optimizer-only, to be named in the Phase 1 gate report and the owner report — cost if wrong: optimizer places some orders one weekend earlier than before Phase 1.
7. [ledger line 109] Task 1.6 ⚠️ — whether a queued run_time_over_cap row can re-enter the schedule via a date-only edit/optimizer is owned by Phase 2 Task 2.5 (Needs Planning release path: run_time_over_cap releases through finishAnchoredPatchFor; queued rows are excluded from reconcile/optimizer intake) — no Phase 1 action — cost if wrong: an over-cap row could be dragged back onto the Gantt before Phase 2 ships (planner-visible, reversible).
8. [ledger line 110] Task 1.6 migration header wording ('the brief asked for exactly this') → reworded by Task 1.9 (docs/Haiku) together with the other durable-text nits — cost if wrong: none.
9. [ledger line 136] Task 1.9 (docs-only, Haiku) — the Sonnet review may correct doc statements directly and commit a docs follow-up instead of a Haiku fix round + re-review (docs carry no runtime risk; saves two dispatches) — cost if wrong: a reviewer-authored doc edit goes unreviewed; mitigated by the whole-branch review that follows.
10. [ledger line 198] Task 2.2 conflict scan — plan text mandated _EFF_END_SQL for neighbours, which makes a never-placed row occupy [SAP start, due date]; ruled: the scan's neighbour set is restricted to _PLACED_SQL rows (never-placed and queued rows cannot conflict server-side; the browser's overlap alert still covers display overlaps) — why: a conflict is between placements, and OQ33 A gives a never-placed row no server placement — cost if wrong: a server-side overlap against a never-placed row goes unreported (client alert remains).
11. [ledger line 216] optimize-ui.test.mjs regression (first bad 2f2ec27) is fixed as Task 2.1 fix round 1 (test bootstrap line only, matching the other optimization test files) — the wrapper keeps reading the compute-core global (one code path) — cost if wrong: another future Node test importing engine.mjs alone hits the same hazard; mitigated by the comment the fix adds.
12. [ledger line 223] Task 2.3 width gate — plan text implied the gate on every non-segment save; ruled: skip the gate when the sent start/end equal the stored RAW scheduled_start/scheduled_end (both non-NULL) and the run time is not changed; width_passed stays False so runtime_schedule_mismatch is untouched; compare raw columns (never the effective/SAP-fallback edges) so an unplaced row's SAP window can never be stamped as a placement — why: a planner's PRT/machine-only edit on a stale bar the engine could not re-derive (no zone / no calendar) must not be rejected — cost if wrong: a legacy mismatched bar can be re-saved unchanged (flag stays TRUE, so the reconcile still re-derives it).
13. [ledger line 249] optimizer-worker.test.mjs worker_threads realm failure = test-only (real worker imports the core first); fixed as Task 2.1 fix round 2 in the test bridge strings; no production change — cost if wrong: none at runtime.
14. [ledger line 270] Task 2.5 — planner run-time/machine/version edits route through manualSchedulePatchFor, so a held finish that cannot be reached is refused with toast.finish_cannot_hold (same as a drop, OQ13 b) rather than accepting the walk's moved finish; the walk's own answer is reserved for system re-derivations (Task 2.6 reconcile, with the finish_moved_earlier alert) — cost if wrong: planners must drag the bar to a reachable finish before changing run time/machine on a closed-day finish (reversible; owner can flip the reading later).
15. [ledger line 282] Task 2.5 — a Needs Planning release (overlong_never / run_time_over_cap) whose due instant is already past is NOT a finishMoved refusal: the release has no held finish to protect, so reached_now resolves forward from now (reversal) and the row carries derivationIssue reversal_forward (detail due_date_past) — cost if wrong: a late released order lands at now instead of being refused (planner-visible, reversible).
16. [ledger line 312] Task 2.6 — user_scheduled is a server wire flag the client never updated; ruled: any client schedule write that is not display/refresh (drop, edit, optimizer apply, release) sets user_scheduled=true locally and save success keeps it; the reconcile candidate filter also skips Persistence._dirtyIds — why: the dirty-vs-display split must never let a display derivation clobber or save a planner placement — cost if wrong: a row the planner edited is treated as placed for the session (safe direction).
17. [ledger line 332] Task 2.7 — /tasks/bulk_update default trust_start=True (the browser save is the main caller and sends starts it derived); external callers pass trust_start=false to get the start flagged instead of width-checked; flipping the default waits on the Phase 0 item g caller list (owner question) — cost if wrong: an external writer that omits the flag gets width_mismatch rejections instead of a flagged placement (visible, reversible).
18. [ledger line 351] no separate Phase 2 whole-branch review — the plan puts the fresh whole-branch review at the Phase 3 gate (covers Phases 2+3); the Phase 2 gate = suites green + gate report — cost if wrong: a Phase 2 cross-task defect waits until the Phase 3 review (same branch, nothing released).
19. [ledger line 383] Task 3.1 I1 — the implementer gap-fill "the optimizer has no overlong path" is overturned: a never-policy order the setup-aware scheduler cannot fit because its run time exceeds every contiguous window is queued with reason overlong_never (brief OQ50 c/a7), not no_fit_found/search_limit, so the release path keyed on overlong_never can act on it; a genuine no-window-at-all failure keeps no_fit_found — cost if wrong: an order mislabelled overlong_never could be released as an elapsed bar when it was really unplaceable for another reason (visible, reversible).
20. [ledger line 403] Task 3.2 I1 — when the setup-aware second walk in the reconcile cannot place (contiguous policy, run within setupMinutes of the longest window), the zero-setup placement with the held finish stands and the setup-violated alert fires; the row is never pushed to the forward reversal by the setup reservation alone (setup is a preference the V1 rule tries to honour, not a reason to reverse) — cost if wrong: a planner sees a held-finish bar with too little changeover room flagged by an alert instead of a reversed bar.
21. [ledger line 419] Task 3.3 gate 14 — the Task 2.6 scope of frozen_window_crossed (manually firmed rows only) is widened to placed, unfirmed rows whose derived start moves from outside to inside the frozen window in that reconcile (a from->to transition); never-placed / display-only / queued rows stay excluded, so the 2.6 flood concern holds while spec R26 (an unfirmed order flipping frozen is sent firm irreversibly) becomes visible to the planner — cost if wrong: extra warnings on rows a planner already expected to firm (noise, no data change).
22. [ledger line 467] Task 3.5 minor "commit trailer reads Claude Fable 5.1" — not a defect: the session attribution rule mandates that trailer for every commit of this run; no change.
23. [ledger line 468] Task 3.5 minor "manual run time carried into the R2 end" — stands as pre-existing D11 behaviour (R2 builds the end from whatever run time the collapse re-weight leaves on the survivor; whether a planner-typed partial-share run time should be rescaled on collapse is an owner question for the final report) — cost if wrong: a collapsed survivor with a manual run time gets a finish that is too early by the share ratio, visible on the Gantt and reversible by re-typing the run time.
24. [ledger line 482] Task 3.6 — the spec-log Phase 3 mirror stays after the Phase 2 gate report (each phase section carries its own gate report; inserting before it would orphan the Phase 2 report under the Phase 3 heading) — cost if wrong: reading order only.
25. [ledger line 485] Phase 3 whole-branch F1 — the Task 2.5 refusal (toast.finish_cannot_hold) applies only when the backward walk cannot hold the finish and would move it earlier (no_slot_at_finish / moved finish); when a planner run-time / machine / version edit on a placed or held row derives a start in the past (walk returns reached_now), the row reverses forward from now with derivationIssue reversal_forward (detail due_date_past or run_time_grew) and the late alert, exactly as a release does (second 2.5 ruling) and as spec O2 / OQ3 / OQ7 a / OQ19 c require — cost if wrong: a planner edit lands the bar at now instead of being refused (planner-visible, reversible by undo).
26. [ledger line 486] Phase 3 whole-branch F3 — a collapse carry with NULL or 0 run time must satisfy chk_orders_sched_range: carry scheduled_end = scheduled_start + 1 minute and set the flag (the engine run_time_zero issue surfaces it); the earlier Task 3.5 ruling "end = start" is amended — cost if wrong: a 1-minute bar on a zero-run-time survivor (visible, flagged).
27. [ledger line 499] Phase 3 F10 (undo of an Apply on never-placed rows marks them placed, so the next Save persists a placement they never had) — real, parked for Phase 4: the fix is to have reconcileRestored keep never-placed ids display-only (skip _markPlaced for rows with no server placement); carried into the Task 4.2 dispatch as a required fix since the cutover makes every non-running row never-placed and Apply+undo would otherwise persist placements plant-wide — cost if wrong: unchanged Phase 3 behaviour until 4.2 (undo then Save persists derived placements; visible, reversible by re-queueing).
28. [ledger line 500] Phase 3 F11 (reload before Save drops an unsaved placement_exception marker because the cached-edit overlay restores dates but not the marker) — real, deferred to the owner report: the marker is a server-persisted field and the overlay is a convenience for unsaved edits; extending the overlay to carry placement_exception is a one-line follow-up the owner can accept or reject — cost if wrong: an overtime/overlong bar edited and not saved before a reload loses its fixed status for that session only.
29. [ledger line 541] Task 4.2 I1 — the cutover pass is detected by the data signature the cutover SQL leaves, not by a stale ratio alone: a first-load pass counts as the cutover pass when the stale rows that are never-placed (both edges NULL, !user_scheduled) plus the running rows that kept start and end exceed 50% of the plant non-queued rows; stale rows that still carry a placement (an ordinary SAP/routing re-upload) never count, so such a load keeps the per-row Toasts and detail run_time_grew; an explicit reason:cutover still wins — cost if wrong: a plant whose cutover rows were somehow placed before first load shows per-row Toasts instead of the summary (cosmetic).
30. [ledger line 542] Task 4.2 I2 — the F10 fix must drop only the placement from what Save persists: on undo / Time Machine restore of a never-placed row, the row stays dirty if it carried an unsaved non-date edit before the Apply (the undo entry records per-id pre-Apply dirtiness, or the restore compares non-date fields against the server copy), and only the derived dates/segments are excluded from the save payload; the placement side of the existing F10 test stands — cost if wrong: an unsaved attribute edit on a never-placed row is silently lost on undo (the current behaviour the reviewer found).

---

## 4. Open owner questions

None of these blocked the run; each was filled with a default (shown) that you can accept or reverse. Items marked "before cutover" must be answered or counted before the cutover branch goes live.

**From the plan (Appendix A, questions 1 to 5)**
1. **Which plant setting is "the planning horizon" for the run-time cap?** What happens: an order whose run time is above the cap goes to Needs Planning instead of getting a bar. Example: the cap is a flat 336 hours (a shorter visibility horizon no longer lowers it); a 400-hour order is queued. Why it is open: no dedicated planning-horizon setting exists (the 35 days is a constant), so the build first used each plant's visibility horizon times 24 hours, capped at 336; senior review U5 (2026-10-14) removed that horizon term, because the backward walk now looks back about 90 days. Default used: a flat 336 hours on every plant.
2. **Delete or keep the two unreachable optimizer labels** `throughput` and `due-date-first`? Default used: keep them (they are harmless and are shown in the evaluator).
3. **Can the timeline's left resize handle be hidden?** Default used: it stays visible, a left-edge drag is reverted with a message ("the start is derived; move the finish"). Hiding it needs a timeline-library change (Phase 0 item e).
4. **Reworded translation keys.** Any further rewording in Task 3.4 extends the pinned list of reworded keys; the list was extended as needed.
5. **The SAP echo tolerance** for the locked-date match (minute precision in the SAP time frame) assumes assumption A9 holds. A real-SAP test (blocker 18) may change the compare rule in one function.

**Other open items**
- **Phase 0 item g, the caller list for `POST /tasks/bulk_update`.** What happens: the endpoint trusts a start it receives (`trust_start` defaults to true) because the browser is its main caller. Example: an integration that computed a start under the old rule should now send `trust_start=false` so its start is flagged and re-derived rather than rejected. Why open: the owner list of external callers was never supplied.
- **Profile Q13 and Q15, before cutover.** Q13 counts lines with no server calendar row (the reconcile skips them); Q15 counts plants with no time zone (nothing can be placed there and a toast tells the planner). Both must be 0 on the restored pilot copy.
- **The Phase 1 hard-bound shift.** The optimizer's earliest and latest placement on a closed due day now follow the date-only rule. Example: due Sunday with no push allowance, the earliest placement is Friday 00:00 and the latest Saturday 00:00. Effect: the optimizer may place some orders one weekend earlier than before.
- **No plant gets a cap below 336 hours.** The cap is a flat 336 hours (senior review U5, 2026-10-14); a short `visibility_horizon_days` no longer lowers it.
- **Task 3.5, a manual run time carried into the collapse finish.** When sub-orders collapse into one survivor, a planner-typed partial-share run time stays on the survivor and now sets the carried finish. Example: a survivor with a typed 4 hours (its share) gets a finish 4 hours after its start rather than the full-share duration, too early by the share ratio. Confirm that the full-share run time is what you want.
- **Phase 3 finding F11.** A reload before Save drops an unsaved overtime or overlong marker (the cached-edit overlay restores dates but not the marker), so for that session the optimizer treats the bar as movable. One-line follow-up; you decide.

**Whole-branch findings left per triage** (one line each, from the Phase 3 review)
- F9: the alert-card headlines of the new alert types show the type code in English ("Reversal Forward", "Plant No Timezone", "Placement Exception") in every language; eight types times five languages, not cheap.
- F11: see above.
- F14: the distribution "current start" and the header's earliest start read the stored or SAP start, not the browser's derived one for finish-only or stale rows; display only.
- F17: daylight-saving residual on forward legs (reversal, optimizer, Remove Backlog add raw minutes); a continuous bar on a 24/7 line spanning the plant's clock change could be refused on save, about twice a year; risk not reproduced.
- F18: a placement marker is sticky; dragging the bar back into normal hours does not clear it, only Unschedule does. Confirm.
- F19: three adapters build the same "line window intersect plant window" shape; they agree today; a single helper would remove the drift risk (refactor).
- F12 remainder: `Calendar.latestAvailable` has no production caller (tests only); deleting it deletes its tests.
- F16 remainder: `Store.plantNow` is un-memoised and the full-plant reconcile pass is unmeasured at plant scale (about 370 ms per 300 never-placed orders measured on 5 lines); a Phase 4 gate item the rehearsal should time.
- F10 was fixed in Task 4.2. Phase 4 also left one re-review note: a Time Machine restore of a stored snapshot has no dirtiness record, so a never-placed row's earlier unsaved attribute edit is not re-saved.

**Phase 4 runbook items that could not be verified from the repository** (check each in the rehearsal)
- Whether the local test server accepts `sslmode=require`, which the migration runner hardcodes (a psql fallback is documented).
- Whether the corporate proxy caches `index.html` (the runbook cache-busts the check).
- Whether changing an environment variable creates a new Container Apps revision.
- Whether the Excel upload has a freeze switch for the quiet window (none was found under the integration or admin code).
- The platform's point-in-time-restore (backup) window.
- What the previous image does with orders that are flagged for re-derive and have no placement (matters for rollback before any planner saves).
- The Q15 and G-6 SQL in the runbook were never run against any database.

**Translations not native-reviewed.** The Task 3.4 locale rows were written by a small model and then reviewed by a second pass (9 translations corrected in `02ac3a5`); the Task 4.2 cutover-summary toast in German, Spanish, French and Portuguese is machine-quality. Neither set has had a native speaker's review.

---

## 5. Browser checks owed

No browser was run in this autonomous run; every UI behaviour is covered by code and unit tests only. Before going live, someone should look at each of these:
1. **Left-handle veto.** Dragging the left edge of a bar is blocked while dragging (the timeline's move hook); the commit-time revert with a message is the fallback.
2. **Derive-paused banner.** Its appearance, and whether it overlaps the concurrency banner.
3. **Overtime confirm.** Moving a firmed order's finish outside working hours asks for confirmation and marks the bar.
4. **Display-only never-placed rows.** After the cutover every non-running order is never-placed: it shows a derived bar but is not saved until a planner acts or the first-load Save runs.
5. **Gantt bands on the plant clock.** Lock and today bands for a viewer in a different time zone from the plant.
6. **The Override modal and the hover card** (Task 3.4), including the "explain the move" line (it was only tested against a stub locale).
7. **Multi-drag ghost preview** after the F4 fix: a right-edge resize ghosts the companion bars by the finish change (the fix reads a timeline-internal value that was never seen live).
8. **The cutover summary toast**, in all five languages.
9. **The reversal toast and alert** on a planner run-time edit of a late order; the alert cards and glossary in all five languages; the distribution separation wording.
10. **G-10: rehearse the whole cutover on a restored copy of the pilot database** (runbook step 3), including timing the first-load reconcile at real plant size.

---

## 6. How to take it live

1. **Merge Phase 1 first.** Merge `feature/backward-scheduling-phase1` into `main`. It is deployable alone (its two migrations, `2026-10-15-1-orders-original-dates.sql` and `2026-10-15-2-orders-run-time-bounds-336.sql`, must reach the pilot through the ledger before the cutover branch; the apply steps are in the section above the cutover runbook in `docs/DEPLOYMENT.md` and in `docs/MIGRATION.md`, owner deploy runbook step 6). No bar moves in Phase 1.
2. **Merge the cutover branch later.** Merge `feature/backward-scheduling` into `main` by pull request as the first step of the Phase 4 runbook (one merge, CI green on the pull request). Nothing from this branch deploys before that.
3. **Then follow the runbook** in `docs/DEPLOYMENT.md`, section "Backward-scheduling cutover" (17 steps; it is not repeated here). Its backbone: the **three migration files run separately, in order** (the placement-exception column `2026-10-16-1-orders-placement-exception.sql`, the snapshot `2026-10-20-0-orders-precutover-snapshot.sql`, then the destructive cutover `2026-10-20-1-backward-cutover.sql`; the Phase 1 pair must already be in the ledger); the **Q15 = 0 gate**; the **G-10 rehearsal** on a restored pilot copy; the **image built before the migration** (record the current image tag as the rollback target); a **quiet window** with SAP flows stopped and the ready queue checked; the planner notice (browser cache version 7, hard reload, do not restore old Time Machine snapshots); the **first load per plant followed by Save** (the first planner save under the new rule ends the clean rollback); and the **rollback matrix** (step 16: before any save the previous image can be rolled back; after the first save an abort is a fix-forward decision, and the run-2 snapshot tables are the only recovery of old placements).
4. This run did none of it. The runbook has been audited (19 commands, one corrected) but never executed.

---

## 7. Deferred minors

Every `minor (deferred)` line in the ledger (94), grouped by task, wording kept. Where the Phase 3 whole-branch review triaged a Phase 2 or Phase 3 line, its verdict follows in the tables after the lists (counts: 1 must-fix, 10 fix-wave-if-cheap, 45 leave; 22 of the "leave" lines were already resolved in code by a later task). Phase 1 lines have no triage verdict recorded. The Phase 4 lines were raised after that review and have no triage.

#### Task 1.1

- persistence.mts:1727 copies the locked original_start_date into BASIC_START_DATE while the server PV-validity check reads basic_start_date — latent divergence once 1.2 writes the locked column; resolved by Task 2.2 (OQ26: validity judged on original_start_received) — carry into the 2.2 dispatch.
- distribution/data.py:3015-3016 child read now emits locked values under the keys basic_start_date/basic_finish_date — naming trap; carry into Task 1.3 dispatch (add a SQL comment or rename the keys there).
- persistence.mts refresh guard asymmetry (start unconditional, end guarded) — harmless.

#### Task 1.4

- staging validator accepts a finish dated before the start (rejected only at apply by build_order_rows; vanish protection still covers it) — admin pre-apply review shows a cleaner batch than applies.
- `_dropped_rows_label` uses str(v) — float-read Excel order ids could render as "1000012345.0" in the warning; rest of ingest uses _str_id.
- dropped_no_* diagnostics counters are process-cumulative (double count on a resumed staging apply; DB Load stays `warn` until restart after any drop) — the start counter was dead before, so the sticky warn is new.
- inactive `pedtr` field-map row now drops every staged order (consistent with finish-required; validator rejects earlier) — add a note later.

#### Task 1.2

- finish_echoes `.replace(tzinfo=…)` uses fold=0 on DST-ambiguous local times (minute precision, harmless; docstring note); sap_sync.py:774 dormant stub calls upsert_orders without sap_tz (plant frame; non-live); no chunk-boundary (>500 rows) test and no distribution-child start-only echo test.

#### Task 1.3

- per-parent query cost (+2 round trips per parent at ingest; `_parent_facts_from_header` from the 892 caller runs a planner-only query) — batch at scale; `_child_upsert_sql` f-string splicing is fragile to read; no mutation-hole test for `_CHILD_UPSERT_SQL_PLANNER`; `MAX(sent_finish)` across members is arbitrary under a partial re-send (comment).
- the named test would not catch a planner rewrite of basic_finish_date from header facts (header and children share the drifted value) — the sibling "moved child basic_finish survives re-weight" test covers it.

#### Task 1.5

- stale comment frontend/scheduling/persistence.mts:10 still names the deleted `_dueEndOfShift`; also "baseline-correct" in comments at tests/test_distribution.py:4728,4814 and docs/architecture/cq1-compatibility-inventory.md:982.
- `_calendarService.workWindow` (persistence.mts:137 interface) is now unused by Persistence; dead seam member.
- `Engine.earliestAllowedStart`/`latestAllowedEnd` via `sourceDueInstant` (engine.mts ~688) have no direct test with a midnight/Sunday due; only `allowedPlanningWindow` is pinned.
- `dueInstant` (setup-scheduler.mts ~1222) and `Util.sapDueDate` (foundation.mts ~639) silently return the raw midnight when `NimbusComputeCore.dueDateInstant` is absent; other callers use `!`, so a missing core would quietly revert to the old bound.
- `dueDateInstant` look-back loop is `back <= 30` (31 dates); a no-calendar line does 31 uncached resolver calls per sapDueDate (cache only keyed when rows exist).

#### Task 1.6

- migration header (2026-10-15-2) says "The brief for this task asked for exactly this" - a transient-brief reference in a durable file; also ADD (ACCESS EXCLUSIVE) + VALIDATE in one transaction scans under the exclusive lock, trivial at pilot size, worth a split like 2026-09-25/26 if orders grows to hundreds of thousands of rows.
- db._apply_run_time_cap calls the resolver's private _write_holds (deferred import; precedent exists at db.py:1330/4450, no cycle) - promote to a public name or move the hold writer to a shared helper so a rename cannot silently break ingest.
- the Excel per-row >= 8760 / negative check (db.py ingest) runs before plant resolution, so on a routing-on plant (run_time later nulled by upsert_orders) a junk RUN_TIME or large Machine Hours value now drops the row where it loaded before.
- only the grid Planning reason column localises run_time_over_cap; other surfaces that show planning_reason.message (tooltips, Needs Planning list, Inspector) show the English server text.
- cap is a visibility (display) horizon x 24 per the ruling; lowering a plant's horizon queues orders only when next written, no sweep, and already-scheduled orders over the new cap stay scheduled - owner-visible consequence of the ruling, not a defect; record it in the owner-facing doc.
- the report's claim that an unchanged over-cap RUN_TIME never blocks a save has no dedicated test (relies on db.py:1442-1444 clearing has_runtime); add one regression test.

#### Task 1.7

- success toast toast.sap_sent_queued '(N firm)' now always equals queued; redundant, and a 0-queued send gives no hint that unfirmed orders were skipped (skipped_unfirmed not surfaced in UI).
- an aggregate whose only firmed child has no end/needs_planning is dropped as unfirmed (only candidate members count); consistent with firm_flag, but differs from literal 'any member child' wording; documented in test only.
- the 'locale-completeness/locale-keys' tests claimed 18 pass did not catch the fr.js syntax error; no parse check in the gate.

#### Task 2.1

- _backwardFrame always walks ~92 nominal days regardless of floor and each span edge costs 2-6 Intl formatToParts calls in plantInstantFromWallClock; cache or bound before a hot optimizer loop calls it per order.
- exhausting the lookback (not the floor) with windows present but fully blacked out returns reached_now; the name is imprecise (caller reverses forward, which then fails visibly).
- no test for multi-cause moveReason precedence, for partial_allowed under plantTz across DST, for fall-back, or a Sunday-night to Monday-morning merge (midnight merge is tested Mon-Tue and in _freeIntervalsBackward only).
- engine.mts plantWallClockFromInstant wrapper now needs globalThis.NimbusComputeCore at call time (was self-contained); fine in the browser and in the current tests, a bootstrap-order hazard for any new Node test importing engine.mjs alone.

#### Task 2.2

- tests/test_sap_staging.py:1410 test_same_instant_batches_have_exactly_one_winner hard-codes 2026-10-07 and is swept by the 7-day dead-batch retention from 2026-10-14 08:00Z; confirmed date-dependent, not caused by this diff; make the instants relative to now().
- backend/integration/sap_staging.py:2222 candidate eff_start falls back to basic_start_date (echo-movable planning copy), not the locked SAP start; firm_flag's frozen-horizon test reads it for never-placed rows.
- backend/setup/data.py:987-992 _load_setup_coverage now joins the full segments lateral (jsonb aggregate per order) just to read first_start, and queued rows now sort last per machine (NULL start) so they form observed transitions after the scheduled ones; observer lookup (data.py:497-507) also evaluates the lateral for every machine order before LIMIT 1.
- backend/distribution/data.py:2484 and 2337 still read c.scheduled_start IS NOT NULL / scheduled_start as "placed" (and db.py:2854, distribution/data.py:1487 in unaliased UPSERTs where _PLACED_SQL cannot be used); one-definition-of-placed is not literally universal.
- db.py:264 _EFF_END_WITH_RUNTIME_MISMATCH_SQL now has zero callers (kept only because the brief says keep); remove or use it in Task 2.3.
- single-edge save to a never-placed row (db.py:1549-1551) now judges the inverted range against the SAP finish and leaves scheduled_end NULL (finish reads as the due date) after a start-only write; browser always sends both edges, Task 2.3 must own it.

#### Task 2.3

- tests/test_planning_exceptions.py::test_atomic_db_validation_writes_nothing is now vacuous (its `good` item is single-edge, rejected on its own); give both items both edges.
- zoneinfo fold=0 makes a 24/7 bar starting in the repeated fall-back hour measure 1 h too long (false width_mismatch, ~1 h/yr); gap wall times are accepted (pre-transition offset), no exception.
- unknown zone name / missing tzdata silently falls back to naive width (db.py _elapsed_seconds); status-only 'scheduled' guard compares EFFECTIVE edges (SAP fallback) so it cannot fire for unplaced rows.

#### Task 2.4

- Gantt lock-band/firm styling (gantt.mts:368/415/740/1020/1149) still uses the viewer clock while Engine defaults now use the plant clock; a cross-zone viewer can see a bar styled unlocked that the engine/drag path treats as frozen/running. Display only, nothing persisted; route to a Gantt follow-up (pass Store.plantNow(t.PLANT) as `now`).
- Util.latenessHours queued-order `new Date()` (foundation.mts:699) and Utilization/alert day keys (services.mts:474-475, 852, 859, 943) stay on the viewer day; display/grouping only, but Task 3.x `late`/utilization must not build on them.
- Store._blockedPlants (store.mts) is never pruned: after an admin sets a zone, plantNow succeeds but the plant stays in the set, so Task 3.3's plant_no_timezone alert would be stale until reload. Fix: delete the plant from the set on a successful plantNow (or on setMasterData).
- offset = server_now minus Date.now() taken AFTER the response is parsed (persistence.mts Store.setServerNow call), so it understates by the request round trip (seconds on a large /tasks); capture Date.now() before the fetch and pass it as receivedAtMs.
- no test pins that Compute.alerts/Alerts._recomputeSync actually send `now` (only the core reading it is tested); removing `_plantClocks` would pass the suite.

#### Task 2.5

- Table._explainManualRefusal keeps the hardcoded English 'Could not regenerate the order in the available calendar window.' (moved, not new; use toast.commit_failed / t())
- stale mentions of the removed seam/snap remain in frontend/calendar/AGENTS.md:22 and tests/README.md:33 (CLAUDE.md twin was updated)
- Push +1 hour (nimbus-intelligence.js) walks each selected order without a Calendar._beginRun/_endRun batch cache (the multi-drag path has one)
- a Release (overlong_never / run_time_over_cap) of a late order whose due instant is already past is refused finish_cannot_hold (reversal counts as finishMoved); brief says over-cap goes through finishAnchoredPatchFor
- between 2.5 and 2.6 a firm/notes edit on a never-placed row resends raw SAP edges and is rejected width_mismatch by the server (raw stored edges are NULL so the unmoved skip cannot fire; nothing is stamped)
- gantt _onDataSetUpdate startMoved/endMoved compare snap(v.*) with the unsnapped expectedItem edges; derived starts are now commonly off the 15-min grid, so an echo or a vetoed left-edge drag on such a bar can show toast.left_edge_locked

#### Task 2.6

- Persistence.conflictGenerations (persistence.mts:1710) and the autosave subscriber (application-shell.mts:2119) skip only 'refresh'; the -display source bumps edit generations and triggers cache writes.
- measured ~370 ms per pass at 300 never-placed orders (Node, 5 lines, never-split), re-run in full on every hydration/refresh/distribution save even when nothing changes; add an unchanged-inputs skip before Phase 4 / larger plants.
- a row with no anchor (engine.mts ~1594) is skipped with no derivationIssue; CalendarSync._hydration.lines is set only at fetch, so a line given a server hours row later stays line_no_calendar until the next fetch; optimization/CLAUDE.md "Imports in" omits calendar-sync; commit() emits two tasks:bulkUpdate events per batch.
- Task 3.3 must render no_operating_window (justified: reuses the FinishRefusal vocabulary), frozen_window_crossed and run_time_zero; none is in the shared-context alert list.

#### Task 2.7

- db.py:1706-1711 status-only 'scheduled' save is rejected for a non-queued NULL-start row and its comment ("cannot fire for an unplaced row") is now false.
- backend/distribution/data.py:1418 (and header _write_header_facts ~1229) still write basic_start_date = EXCLUDED, not COALESCE like db._UPSERT_SQL, so a re-upload that sends no start erases a child's stored basic start (display fallback only).
- staging rejects a malformed non-blank start as invalid_date while Excel keeps the row with a NULL start; justified, pinned at tests/test_sap_staging.py:309, but not in the Task 1.4 Excel/SAP parity test.
- trust_start is also honoured on the browser's /tasks/update (shared _apply_task_date_updates), not only /tasks/bulk_update.
- backend/integration/AGENTS.md still carries the old dropped_no_start_date text (AGENTS.md already out of sync with CLAUDE.md).

#### Task 2.8

- the new status-only guard (db.py ~1706) also rejects an attribute+status save (e.g. PRT_01 + planning_status 'scheduled', no edges, no schedule_segments key) on a never-placed row, and the reused `single_edge` text ("start and finish must be saved together") is slightly off when no edge was sent; the browser always sends schedule_segments so it never reaches this guard.
- the header change-guard (`%(bs)s::timestamp IS NOT NULL AND ...`, backend/distribution/data.py ~1240) has no isolating pin (the pin also changes finish/quantity so the WHERE fires regardless); the SET COALESCE, which is what protects the stored start, is pinned and verified discriminating.

#### Task 3.1

- setup-scheduler.test.mjs:5113 title still says "moved starts" (brief said flip it).
- no tests for autoReflow/Alerts.applyFix marked-row guard, Remove Backlog dialog note, TimeMachine.restore.
- stale "legacy" comments in engine.mts (864-871, 909-915, 962, 1721, 2423, 2477, 2568).
- the plain no-fit-with-windows side of neverOverlongReason has no explicit test (returns null by construction).

#### Task 3.2

- reconcile predecessor search ties by id but the observation sorts by start only (same-start rows may differ).
- no test pins msgKey/msgVars on the emitted setup-violated alert.
- stray blank line at end of the midnight availability test in engine.test.mjs.

#### Task 3.3

- services.mts:872 _prewarm uses the viewer today while Dashboard keys the matrix on the plant clock (cache miss only when zones differ).
- nimbus-intelligence.js:1836 shows English a.msg for worker alerts (t() is reachable; pre-existing, one-line fix).
- alert card headlines for new types are title-cased English from the type code (no ui.alert_headline_* keys).
- workingMinutesByDay ignores blackout blocks (matrix/overload/briefing still agree).

#### Task 3.4

- Util.impliedOriginalStart (foundation.mts:701) now has no callers; delete.
- stale "Updated End" comment at orders.mts:1948.
- Alerts auto-fix toast (services.mts ~469) reads the finish before autoReflow runs.
- _varianceBadge gives a 0.0h variance the "early" class (cosmetic).
- still-unkeyed English: Inspector setup-override editor, Productive schedule/Part N card, hover alert type ids, modal close aria-label.

#### Task 3.5

- stale "start" wording remains in en.js:2178 ui.dist_status_separation_violated_tip and hardcoded optimize-ui.mts:2005 beside the reworded finish alert.
- collapse carries a planner-typed MANUAL partial-share run_time (D11) as the survivor run time, which now drives the R2 end; confirm intended "full-share run time".
- untested branches: NULL/0 run-time collapse arm, SAP firming X in `firmed`, repair guard is a kwarg-capture mock.
- get_aggregate due_date value has no DB-backed round-trip test (mocked rows only).
- commit trailer reads "Claude Fable 5.1" instead of "Claude Sonnet 5.5".

#### Task 3.6

- db.py sap_changed warning text (~4137) and the "(f) slot + firm back to SAP's dates" comment (~3910) still say the slot was reset to SAP's dates; the reset clears the slot (scheduled_start/end NULL) and the browser re-derives the start from the due date. Code, out of scope.
- docs/MIGRATION.md 899/929 describe the retired Engine._dispatchDayIntegrity as live (historical 2026-07 section, predates this work).

#### Phase 3

- F1 manual reversal detail is run_time_grew for a drop to a near-future finish, and the OQ56 Remove Backlog hint counts it as "run time grew".
- F15 test pins the outbound SQL expression text, not an echo scenario.
- F4 ghost relies on the vis internal itemSet.items[id].data.end; test stubs the same shape, no browser drag run.

#### Task 4.1

- test run-futuredue row cannot discriminate old_end arms, plus a stray `- _h(0)` in the assertion
- no boundary rows (start == now, old_end == now) pin the `<=` / `>` semantics
- updated_at compared via str() > OLD in the test; use datetime compare
- running rows with run_time and no segments get end = start + run_time, replacing a differing stored scheduled_end; mention in Task 4.3 runbook

#### Task 4.2

- no once-per-plant guard; blocked-heavy plants re-fire the summary toast on each later pass.
- runbook G-6 SQL timestamp is database-session time, say so.
- rehearsal step 3 should say to apply the 2026-10-15 files to the copy if the pilot lacks them.
- Time Machine stored-snapshot restore has no dirtiness record, so a never-placed row's earlier unsaved attribute edit is not re-saved.

#### Phase 4

- two eslint warnings in engine.test.mjs (unused `hours`, shadowed `fresh`) added by the Phase 3 fix wave; 0 errors so the gate holds.

### Whole-branch triage verdicts (Phase 3 review, section C, verbatim)

#### Triage of the Phase 2 lines

| Line | Disposition | Reason |
|---|---|---|
| 2.1 `_backwardFrame` cost per call | leave | measured about 370 ms per 300-order pass; revisit with F16 |
| 2.1 `reached_now` name for an exhausted lookback | leave | naming only |
| 2.1 missing tests (multi-cause precedence, partial_allowed under a plant zone across DST, fall-back, Sunday-night merge) | **cheap** | test-only, in `calendar-engine.test.mjs` |
| 2.1 engine wrapper needs the core global at call time | leave | `index.html` orders the scripts; tests bootstrap it |
| 2.2 date-dependent same-instant test | leave | RESOLVED (fa003b3) |
| 2.2 `sap_staging.py:2222` firm rule reads echo-movable `basic_start_date` for never-placed rows | **cheap** | F15; use the locked start in the outbound query only |
| 2.2 setup-coverage lateral cost, queued rows sort last | leave | unmeasured, pilot scale fine |
| 2.2 "placed" not universal in two unaliased upserts | leave | RESOLVED for the distribution sites; the rest are write-side |
| 2.2 `_EFF_END_WITH_RUNTIME_MISMATCH_SQL` zero callers | leave | RESOLVED (deleted) |
| 2.2 single-edge save to a never-placed row | leave | RESOLVED (2.3 rejects it) |
| 2.3 vacuous atomic-validation test | leave | RESOLVED (1396cb9) |
| 2.3 fold=0 repeated fall-back hour measures 1 h long | leave | about 1 h per year, 24/7 lines only (see F17) |
| 2.3 unknown zone falls back to naive width; status-only guard reads effective edges | leave | status-only guard RESOLVED (2.8); unknown zone is a data error |
| 2.4 Gantt lock-band uses the viewer clock | leave | RESOLVED (`_nowFor`) |
| 2.4 `latenessHours` / Utilization day keys on the viewer day | leave | RESOLVED (`plantClock`/`plantToday`) |
| 2.4 `_blockedPlants` never pruned | leave | RESOLVED (pruned in `plantNow`, test) |
| 2.4 offset understated by the round trip | leave | the lag is one response transit, in the safe direction (start at or before now) |
| 2.4 no test that alerts send `now` | leave | RESOLVED (`alert-payload.test.mjs`) |
| 2.5 hardcoded English refusal text | leave | RESOLVED (`toast.manual_refusal_generic`) |
| 2.5 stale seam mentions in docs | leave | RESOLVED (only archived docs remain) |
| 2.5 Push +1 h without a batch cache | leave | RESOLVED (`pushFinishPatches`) |
| 2.5 release of a late order refused | leave | RESOLVED (ruling, 74d5c05) |
| 2.5 firm/notes edit on a never-placed row resends raw SAP edges | leave | only when the derive is paused; the display derive covers the normal case |
| 2.5 Gantt snapped-vs-unsnapped compare | leave | RESOLVED (74d5c05) |
| 2.6 `conflictGenerations` / autosave skip the display source | leave | RESOLVED (`persistence.mts:1711`, `application-shell.mts:2119, 2261`) |
| 2.6 reconcile re-runs in full on every refresh and hydration | **cheap** | F16; skip when the refreshed ids hold no candidate |
| 2.6 `no_anchor` note, hydration lines at fetch only, CLAUDE.md import list, two bulk events | leave | `no_anchor` RESOLVED; the rest cosmetic |
| 2.6 Task 3.3 must render three codes | leave | RESOLVED (core renders all three) |
| 2.7 status-only guard comment false | leave | RESOLVED (2.8) |
| 2.7 distribution header/child start COALESCE | leave | RESOLVED (60bfdfe) |
| 2.7 staging rejects a malformed start, Excel keeps the row | leave | justified and pinned |
| 2.7 `trust_start` also on `/tasks/update` | leave | the browser never sends it |
| 2.7 integration AGENTS.md old counter text | leave | RESOLVED (no remaining mention) |
| 2.8 attribute+status guard wording | leave | the browser never reaches it |
| 2.8 header change-guard has no isolating pin | leave | the protecting SET clause is pinned |

#### Triage of the Phase 3 lines

| Line | Disposition | Reason |
|---|---|---|
| 3.1 stale test title "moved starts" | leave | RESOLVED |
| 3.1 no tests for the Alerts.applyFix marked-row guard, Remove Backlog dialog note, TimeMachine.restore | **cheap** | F6; three small tests |
| 3.1 stale "legacy" comments in engine.mts | **cheap** | comment-only, `engine.mts:880-887, 925, 978, 1804, 2506, 2560, 2651, 2998` |
| 3.1 neverOverlongReason plain no-fit side untested | leave | RESOLVED (`setup-scheduler.test.mjs` OQ50 c covers it) |
| 3.2 predecessor tie-break by id vs start only | leave | cosmetic divergence on identical starts |
| 3.2 no pin on `msgKey`/`msgVars` of setup-violated | **cheap** | one assertion in `compute-core.test.js` |
| 3.2 stray blank line | leave | |
| 3.3 `_prewarm` uses the viewer day | leave | cache miss only when zones differ |
| 3.3 `nimbus-intelligence.js:1836` shows English `a.msg` | **cheap** | F8; `Util.alertMessage(a)`; i18n rule |
| 3.3 alert-card headlines for new types are English from the type code | leave | F9; 8 types x 5 locales, not cheap |
| 3.3 `workingMinutesByDay` ignores blackouts | leave | matrix, overload and briefing agree (one rule) |
| 3.4 `Util.impliedOriginalStart` has no callers | **cheap** | delete (`foundation.mts:701`) |
| 3.4 stale "Updated End" comment `orders.mts:1948` | **cheap** | comment-only |
| 3.4 auto-fix toast reads the finish before `autoReflow` | leave | not a defect: `autoReflow` moves peers, not this order |
| 3.4 `_varianceBadge` 0.0 h class | leave | cosmetic |
| 3.4 remaining unkeyed English clusters | leave | pre-existing clusters 16-18 of the spec list |
| 3.5 stale "start" wording in the separation tooltip and the preview heading | **cheap** | F7; one key in 5 locales plus one new key |
| 3.5 collapse carries a manual partial-share run time | leave | ruled (D11 behaviour); owner question for the final report |
| 3.5 untested NULL/0 run-time collapse arm | **must-fix** | F3: the arm violates `chk_orders_sched_range` and would abort the whole re-weight write |
| 3.5 `get_aggregate` due_date has no DB round trip test | leave | mocked rows cover the shape |
| 3.5 commit trailer | leave | ruled, not a defect |

---

Phase 3 whole-branch re-review, new deferred observations: F1 detail `run_time_grew` is also given to a drop to a near-future finish and the Remove Backlog hint counts it as "run time grew"; the F15 test pins the SQL expression text, not an echo scenario; the F4 ghost relies on the vis internal `itemSet.items[id].data.end` and was never browser-tested (ledger lines 502 to 504).

---

## 8. Test evidence

Four gates, one per phase. Numbers come from the ledger's gate lines; Phase 2 and 3 gates ran on `feature/backward-scheduling`, Phase 1 on its own branch.

| Command | Phase 1 gate (`643b7eb`; baseline `88c2879`) | Phase 2 gate (`60bfdfe`) | Phase 3 gate (pre-fix `f671657`; post-fix `5bb605b`) | Phase 4 gate (`b9ea599`; final `0b45e85`) |
|---|---|---|---|---|
| `npm test` legacy | 46 / 46 (baseline 40 / 40) | 47 / 47 | 68 / 68; 68 / 68 | 68 / 68; 68 / 68 |
| `npm test` modules | 1214 pass, 0 fail, 3 todo (baseline 1202 pass, 3 fail, 3 todo) | 1326 pass, 0 fail, 3 todo | 1384 pass, 0 fail, 3 todo (1387 tests); 1400 pass, 0 fail, 3 todo (1403 tests) | 1403 pass, 2 fail, 3 todo (1408 tests; both fails the load-flaky spawn probe, engine file rerun 162 / 162); final 1408 pass, 0 fail, 3 todo (total not recorded) |
| `python -m pytest tests/ -q` | 1685 passed, 2 failed, 1 skipped, 13 xfailed (baseline 1626 passed) | 1772 passed, 2 failed, 1 skipped, 13 xfailed | 1777 passed, 2 failed, 1 skipped, 13 xfailed; 1779 passed, 2 failed, 1 skipped, 13 xfailed | 1780 passed, 2 failed, 1 skipped, 13 xfailed; the same at `0b45e85` |
| `npm run lint` | 0 errors, 35 warnings (= baseline) | 0 errors | 0 errors, 35 warnings; 0 errors, 35 warnings | 0 errors, 36 warnings; 0 errors, 34 warnings |
| `typecheck`, `check:static-assets`, `check:legacy-surface` | clean (typecheck not restated; static-assets OK, legacy-surface no drift) | clean | clean; clean | clean; clean |

The pytest failures in every column are the same two tests. They are not caused by this work.

**Baseline noise, in plain terms.**
- `tests/test_scale_catalog_paging.py` (two cases, material-grid paging): fails identically on the untouched baseline because of how this machine's database sorts material ids.
- Three `knownFailure` todos in `calendar-sync-boundaries.test.mjs`: deliberate "known, tracked" markers; they show as "todo", not failures.
- One optimizer spawn probe in `engine.test.mjs` that times out when other work runs at the same moment (`spawnSync ETIMEDOUT`). It failed in the Phase 1 baseline (3 times), once in the Phase 3 run and twice in the first Phase 4 run, each time while something else was running, and passed alone.
- `test_distribution.py::test_summary_counts_past_5000_headers`: a statement timeout once when pytest overlapped lint and tsc; passes alone.
- `scripts/schema_bootstrap_smoke.py` exits 1 on `main` already (ledger drift between the replayed migrations and `schema.sql`); this branch adds no new difference.
- One date-bomb test (`test_same_instant_batches_have_exactly_one_winner`, a hard-coded date) was fixed in Task 2.8 (`fa003b3`).

**What the tests do not cover.** The cutover's effect on real order data: `nimbus_sdd` holds 0 orders, so only the rolled-back test fleet in `tests/test_backward_cutover.py` proves it. Browser behaviour (section 5) and the runbook commands (section 4) were not run.

---

## 9. Senior regression review and fix wave (2026-10-14)

**Method.** Eight Sonnet reviewers (R1 to R8, one per area) read the range `0317dd8..78cb71b` and produced 61 raw findings (2 duplicates merged). Eight Sonnet verifiers (V1 to V8) then tried to reproduce or trace each one; five more verifiers (V-UA to V-UE) did the same for the reviewer-only items. Nothing was accepted without a verifier reproduction or trace. Result: 1 Critical, 14 Important, 7 Minor confirmed, 1 plausible, 3 reviewer-only items refuted. Fixes ran as six sequential batches (B1 data/deploy, B2 backend ingest/distribution, B3 calendar, B4 optimizer, B5 scheduling UI, B6 insights/docs) with a Sonnet review after each, then a merge-gate fix. One commit per finding (or a tightly coupled pair). The binding rulings are in `.superpowers/sdd/2026-10-13-backward-scheduling-implementation/senior-review/FIXWAVE-BRIEF.md` and `FIXWAVE-U-RULINGS.md` (the R-ids below). Two rulings came after the batches: the restore script archives the snapshot tables under the suffix `_rst_<yyyymmddhh24mi>` (rename, never drop), and the late-bound `NIMBUS.Util?.plantToday?.()` / plant-clock / dirty-probe reads in `nimbus-intelligence.js` are accepted as that file's existing idiom (legacy-surface ratchet stays flat).

**Per-finding table.** Verdict CONFIRMED unless noted. Sev: C critical, I important, M minor, P plausible, U reviewer-only.

| Id | Sev | Defect | Fix commit(s) | Governing ruling |
|---|---|---|---|---|
| C1 | C | Cached-edit overlay drops `user_scheduled`; a dragged row's placement is lost on reload | 73d35c5 | R-I11/C1 |
| I1 | I | Snapshot migration had no destructive keyword; a routine promote applies it early | 4a5af9e | R-I1/I2 manual-only marker + `-Only` |
| I2 | I | Skill/runbook let a plain promote then `-AllowDestructive` run the whole cutover | 4a5af9e, 68ba126 | R-I1/I2 |
| I3 | I | Cutover deleted segments of running orders | 826439d | R-I3 |
| I4 | I | Running row with NULL/unknown plant got its start and end nulled | 826439d | R-I4 |
| I5 | I | Over-cap re-queue unplaced a placed, firmed order on every upload | e8474a7 | R-I5 |
| I6 | I | Date-only due on a 24:00-close line read 23:59:59 | 8949648, 49c16dd, 9391826 | R-I6 |
| I7 | I | Server-line calendar set not updated after a line-hours save | 163a8ec | R-I7 |
| I8 | I | Setup-aware second walk could move a held finish | 8d41093 | R-I8 (ruling 3.2) |
| I9 | I | "Overlong" defined three ways (per-day vs midnight-merged) | 9592a40 | R-I9 |
| I10 | I | Display-derived dates judged running/frozen/firmed | 3dcb767, 8d8c311, 6b192a9, e62b8ca | R-I10 |
| I11 | I | Conflict refresh applied dates but not `user_scheduled` | 73d35c5 | R-I11/C1 |
| I12 | I | Distribution planner writes had no run-time cap | aed52ee | R-I12 |
| I13 | I | Intelligence panels and worker prewarm used the viewer clock | b56d8a8, 1ef8998, 29d1004 | R-I13 + late-bound idiom ruling |
| I14 | I | Two schema re-apply tests committed the cutover on a developer DB | 723ec3f, 4c2afbe | R-I14 |
| M1 | M | Never-branch reversal run time not rounded to whole minutes | 6eeea8e | R-M1 |
| M2 | M | No restore script; restore untested | 4a5af9e, c0e5428, 20ff930 | R-M2 + `_rst_` archive suffix |
| M3 | M | Override-interval test failed under TZ=UTC | 9e57785 | R-M3 |
| M4 | M | minutesByDay test title/fixture mismatch (840 vs 600 min) | 9e57785 | R-M4 |
| M5 | M | Bounds migration header said 336, installs 8760 | a67de37 | R-M5 (no rename) |
| M6 | M | MIGRATION.md status text stale | 4a5af9e | R-M6 |
| M7 | M | Calendar CLAUDE.md/AGENTS.md conflict with main | 889e53f, eacf637 | R-M7 |
| P1 | P | No tests for spec 10.5 groups 7, 8, 15 (and 26 as listed) | 98255bb | U-ruling P1 (the tests V-UC listed as still missing) |
| U1 | U | `plants` keyed (subnetwork, plant): arbitrary row | refuted, not touched | refuted (plants globally unique) |
| U2 | U | Conflict scan misses finish-only rows | 83ee451 | U2 |
| U3 | U | Setup coverage order on startless rows | 969cffb | U3 |
| U4 | U | Horizon predicate off the C1 index | refuted, not touched | refuted (old predicate never indexed) |
| U5 | U | Cap = min(336, horizon x 24) queues orders on short horizons | e8474a7, 5337e82 | U5 flat 336 h |
| U6 | U | `trust_start` default / `bulk_update` callers | owner decision, documented only | U6 |
| U7 | U | Dependency link order follows SAP start | 0a28df4 | U7 |
| U8 | U | No restore SQL shipped | 4a5af9e, c0e5428, 20ff930 | R-M2 |
| U9 | U | `_apply_run_time_cap` plants join | refuted, not touched | refuted |
| U10 | U | Purge preview misses finish-only placements | 05bdcb6, f2cb931 (health stats) | U10 |
| U11 | U | New distribution child overwrites locked finish | 76e6e8e | U11 (raised to Important) |
| U12 | U | RUN_TIME rejection on routing plants | a450631 | U12 |
| U13 | U | PV validity on a missing start | 11edb2b | U13 |
| U14 | U | Board/CSV filters drop NULL-start headers | c240440 | U14 |
| U15 | U | `startOfDay` mutated `now[plant]` | d1cc118 | U15 |
| U16 | U | Reversal forward leg in viewer-zone time | ac5cbf7, 49c16dd, fea2de5 | U16 |
| U17 | U | ~92-day nominal walk per backward call | 5dd6da7 | U17 |
| U18 | U | `closed_finish` label where cause is a blackout | 5dd6da7 | U18 |
| U19 | U | `latestAvailable` ceil vs allocator round | 5dd6da7 | U19 |
| U20 | U | No tests for I8/I9 or boundary cases | 8d41093, 9592a40 | U20 |
| U21 | U | Optimizer ran on a no-timezone plant | 34c29c4 | U21 (OQ52) |
| U22 | U | Online load overlaid a v6 cache unchecked | 73d35c5 | U22 |
| U23 | U | `restoreTasks` flagged every row stale | 8cff88b | U23 |
| U24 | U | Cutover signature tripped on tiny plants | 5f3276c | U24 (>= 10 rows) |
| U25 | U | Second planner's first Save reported every row stale | 30f7cda | U25 |
| U26 | U | `plantNow` per task per rebuild | f5b8b6c | U26 |
| U27 | U | Multi-select ghost width differed from the drop | 1d47494 | U27 |
| U28 | U | Alert-card headline raw English type | f59022b | U28 |
| U29 | U | Finish-only row invisible to tile and matrix | 5b9cd12 | U29 |
| U30 | U | Derive-paused banner overlapped concurrency banner | e3167a4 | U30 |
| U31 | U | Time Machine restore dropped dirty ids | b68bc02 | U31 |
| U32 | U | No locale parity check for new keys | d75e552 | U32 |
| U33 | U | Inconsistent terminology in new es/fr/de/pt rows | a9090c8 | U33 (new rows only) |
| U34 | U | Push +1 h silently skipped rows | 33e51f0 | U34 |
| U35 | U | Final report section 1 / 6.1 stale facts | eadb87a, this section | U35 |
| U36 | U | Platform and root AGENTS.md not mirrored; anchors one line low | 56ebf28 | U36 |

Merge-gate fixes after the batches: `3100e0a` (pytest refresh fixture), `eacf637` (calendar docs keep main's hunk), `e62b6fe` (locale rows reordered so the merge with main is clean). `e62b6fe` dropped `btn.change_scope` and `hint.bom_pick_scope` from all five locales; the final gate caught it (`tests/js/locale-keys.test.js`) and `18946fc` restored both with verbatim values (a key-set comparison per locale file proved nothing else was lost against `78cb71b`). Lint fix `cd80096` (no-shadow in `orders.test.mjs`).

**Final gate (tip `18946fc`, 63 commits since `78cb71b`; logs in `.superpowers/sdd/2026-10-13-backward-scheduling-implementation/senior-review/gate-final/`).** build, typecheck, check:static-assets and check:legacy-surface clean. lint 0 errors / 34 warnings (baseline 0/34). `npm test` legacy 73/73, modules 1457 tests: 1454 pass, 0 fail, 3 todo (baseline 68/68 and 1408/0/3). pytest 1797 passed, 2 failed (the two baseline `test_scale_catalog_paging` cases), 1 skipped, 13 xfailed (baseline 1780 / 2 / 1 / 13). `git merge-tree --write-tree --messages` of `main` (`62d786e`) with `feature/backward-scheduling` and with `feature/backward-scheduling-phase1`: both clean, no conflicts. The five foreign working-tree files are untouched (empty diff since `78cb71b`). Nothing was pushed, merged or deployed. This docs commit comes after the gate tip and changes only `.md` files.

**Residuals and owner notes.**
- U6: `TaskDateUpdate.trust_start` still defaults true; flipping it waits on an owner decision about `/tasks/bulk_update` external callers.
- Legacy-surface idiom: three late-bound consumers in `nimbus-intelligence.js` (`Util.plantToday`, plant clock, `UndoStack.dirtyProbe`) are invisible to the legacy-surface scanner until that script migrates off `NIMBUS`.
- U33: es/fr/de/pt terminology outside the new rows (pre-existing) was not touched.
- Nits from the reviews: U17 memoisation is per run batch only; U21 leaves the `liveClock` fallback for display; U25 same-derivation replies reconcile silently (no conflict toast for them).
- The Codex runner copy of `apply-migrations.ps1` now carries the marker and `-Only` (`3fa4673`) but is still a divergent file from `scripts/apply-migrations.ps1`.
- Nine main-only locale keys (`col.orig_start`, `col.orig_end`, `col.updated_start`, `col.updated_end`, `ui.insp_orig_start`, `ui.insp_orig_end`, `ui.insp_updated_start`, `ui.insp_updated_end`, `ui.diag_dropped_no_start`) exist on main but were deliberately removed here (e33eec7 reworked the date columns); the merge is clean and nothing reads them.
- Browser checks still owed: the unchanged list in section 5, plus the cutover summary toast threshold (>= 10 non-queued rows), derive-paused banner stacking under the concurrency banner, due-date day display in the grid and Inspector (24:00-close lines), and the Optimize refusal toast on a plant without a timezone.
