# PV-locked machine eligibility ("PV - Machine") — design

## Context

On routing-enabled plants NIMBUS already blocks a move to a machine whose work center has no operation in the order's production version, but only at drop or commit time, and only against the order's current PV. Planners get no preview of which rows are legal, the inspector lists every machine in the plant, and switching production version and machine are two separate edits even though they are one decision. NIMBUS sends SAP only dates and the production version, never the machine, so the PV is the only way SAP learns where an order runs. Choosing a machine must therefore choose the PV with it.

## Decisions (owner, 2026-10-21, settled, don't re-ask)

- **D1 Eligible set** for an order = for each `production_version` row on (plant, material) that is valid on the order's date, take the PV row's own `sap_workcenter` ("the scheduling operation", no multi-step routing explosion) → every machine in the plant with `machine.sap_workcenter` equal to it. Result is a list of (PV, machine) pairs; a machine may appear under several PVs. Expired PVs are not options. A PV with a blank work center offers no machines (fail closed) and is flagged on the missing-master-data report.
  - My call: "valid on the order's date" uses the resolver's existing chain (`original_start_received` → `basic_start_date` → `original_finish_received` → `basic_finish_date` → today). The server save gate judges validity on that date, so judging on the planned start would offer PVs the server then rejects.
- **D2 Picking a pair** writes `PRODUCTION_VERSION` and `MACHINE` together in one patch (one undo step), recomputes run time from that PV's routing at that machine, and re-derives the start backward from the held finish.
- **D3 Three surfaces** show the same "PV - Machine" list: inspector, orders-grid machine editor, Override dialog.
- **D4 Gantt drag** (single order): rows outside the eligible set dim while dragging. Drop rule: keep current PV if it covers the target machine; if exactly one other PV covers it, apply it with a toast (my call: no chooser for one candidate); if two or more, a small chooser; cancel springs back; none → spring back as today.
- **D5 Multi-drag** may shift time and span lines but never changes any order's line. A multi-drag that would move the dragged item to another row is rejected whole.
- **D6 No PV / unknown material / empty set** → Needs Planning.
- **D7 Recompute**: a placed order whose (PV, machine) is no longer eligible (PV expired/removed, blank WC, machine re-linked) first tries the material's default PV (`material_plants.default_production_version`); if valid and its work center covers the order's current machine → switch PV, recompute run time, keep machine. Else Needs Planning. Consequence accepted: `pv_expired`/`pv_not_found` orders that today fall back to file machine-hours will instead default or hold.
- **D8 PV header WC vs routing-operation WC disagreement** is bad master data: new resolver step `pv_workcenter_mismatch`, listed on the missing-master-data report, never hidden.
- **D9 Hand-timed (manual run time) orders**: when a planner *moves* one, the pair is checked and the run time resets to the new routing value (this replaces today's "machine-only move keeps a manual run time" rule for routing plants). Recompute does not touch manual-runtime rows (they are not loaded today); assumption recorded, since the owner answered only about moves.
- **D10** Non-routing plants and the optimizer are untouched (one exception: D14).
- **D11 PV field is read-only on routing plants** in grid and inspector; the only writer is the "PV - Machine" pair, including for unplaced orders. Non-routing plants keep today's free edit. The routing PV-edit branches (`orders.mts:1424-1452`, `2560-2586`) are removed.
- **D12 Recompute fallback order**: SAP's own last-sent PV (`orders.sap_production_version`) if valid and covering the current machine → material default PV if valid and covering → Needs Planning. Running orders and distribution children are never PV-switched.
- **D13 Pre-pass runs on every resolve pass** (uploads, SAP apply, distribution changes, routing uploads, master-data hooks, Recompute button). Accepted: one upload can unschedule many placed orders; the recompute report counts them (`pv_defaulted`, `pv_sap_restored`, holds by step).
- **D14 Multi-drag line lock applies on all plants.**

## Verification round (5 Sonnet verifiers, 2026-10-21) — what changed

Confirmed as written: PV header work center is populated by both Excel and SAP-staging ingest (unknown WCs rejected at ingest, blank stored NULL); resolver step order and fallback; save gate accepts PV+MACHINE in one save; upsert precedence; optimizer/sandbox/intelligence/undo never create a new pair; AG Grid writes the raw editor value before `_onCellChanged`; `Modal` has no chooser; Needs Planning = unplaced (dates nulled).

**Findings that changed the plan (owner decisions D11–D14 below):**
1. **PV stays independently editable** in grid (`orders.mts:418, 1424-1452`) and inspector (free-text input, `:2291-2298, 2560-2585`). A PV typed that does not cover the current machine silently unplaces the order with the PV persisted. Breaks the "choose machine chooses PV" premise.
2. **Material default PV is not fed by SAP staging** (`schema.sql:1523-1528` field map has no VERID; column is `NOT NULL DEFAULT ''`, never zero-padded). D7's default-PV fallback will mostly find nothing. Also: an SAP re-upload can change PV only (machine kept) or work center only (PV kept) → mismatched pair; D7 as written would try the material default before SAP's own new PV.
3. **Recompute pre-pass runs plant-wide** on every non-full `resolve_orders` call (`resolver.py:578` loads every routing-sourced order of the plant): Excel upload, SAP apply, distribution changes, routing uploads, master-data hooks (`db.py:4170`, `sap_sync.py:778`, `sap_staging.py:1683/1737/1778`, `distribution/data.py:3558/3644/4132`, `master_data/routes.py:79`). Not just the button.
4. **vis-timeline 7.7.3 `timechange`/`timechanged` fire only for the custom-time bar**, not item drags (verifier read the unminified CDN source: only `CustomTime` emits them; `ItemSet._onDrag` emits `_change`). If true in the browser, `_onTimeChange` (ghosts, `dimSetupForDrag`, edge-scroll, `_isDragging`) is dead on real drags and only unit tests exercise it. **Step 0 below: confirm in Chrome before building Step 7.** Row-dim must hang off `onMoving` (per-frame callback, receives `{id, group}`) with cleanup at the top of `_onDataSetUpdate` plus a document `pointerup`/`pointercancel`, `rebuild()` and `plant:selected`.
5. **Chooser re-entry hazard**: any rebuild/patch of the item while the modal is open (`alerts:change`, `tasks:bulk`, `tasks:bulkUpdate`, `firmed:change`, `calendar:change`, `plant:selected`) resets the vis item, and re-entry exits as `update:ignored`, losing the pick. Same latent hazard exists in overtime-confirm today. Fix: capture `{itemId, newLine, requestedFinish}` at drop; on pick, re-apply from captured values if the item moved.
6. **Multi-drag line lock would also hit non-routing plants** unless gated; today companions all jump to the dragged item's line (`gantt.mts:5196`). Each companion fires its own DataSet update → toast latch needed. Ghost preview (`:5409`) should stop implying a legal cross-line move.
7. **D9 contradicts documented rules** (`frontend/routing/CLAUDE.md:27`, `backend/routing/CLAUDE.md:24`, `db.py:1565-1572`: machine-only moves preserve manual/SAP run times). Server consequence: manual-source machine-only move now sends a changed RUN_TIME; Step 8's `check_pair` branch must also set `resolved_runtime` so the row writes `run_time_source='routing'`, else `invalid_ids`. Tests to update: `tests/modules/routing/machine-edit-contract.test.mjs:53-60`, `tests/test_task_response_models.py:722-734`.
8. **Setup signature may include PRODUCTION_VERSION** (`setup-domain.mts:31`, `backend/setup/data.py:81-93`). A PV switch can change changeover times with neighbours; alerts recompute catches it. Accepted consequence, documented.
9. **Undo is Gantt-only today**; grid, inspector, override push nothing. D2's one-undo-step is new work on three surfaces (small: `UndoStack.snapshotTasks/push` around one `Store.updateTask`).
10. **Only firmed orders go to SAP** (`build_outbound_groups`, OQ61); `verid` = min of members' PVs; no send-time dirty flag. PV choice on unfirmed orders reaches SAP only after firming. Premise holds for firmed orders.
11. **`_write_outcomes` WHERE lacks a PV distinct predicate** — a PV switch with identical run time would not be written. Add `o.production_version IS DISTINCT FROM v.production_version`.
12. **Missing-master-data panel** renders only when `unmatched_pairs > 0` (`admin-ui.mts:1091`) and has no PV column; there are two CSV writers (`integration/routes.py:290, 323`). PV rows must be counted and displayed; gate PV rows on routing-enabled plants.
13. **`_stamp_order_attributes`/`reapply_defaults`** fill a blank PV from the material default without a machine check → can create mismatched pairs; safe only because every call site is followed by `resolve_orders`. State that invariant in the backend CLAUDE.md.
14. **Distribution children** are not filtered out of the resolver; the D7 PV switch must exclude `parent_production_order IS NOT NULL` (children inherit the parent's PV).
15. **Same-line time-only drag** is already blocked when the current pair is ineligible (guards at `gantt.mts:5158/5209/5272` run with `newLine === t.MACHINE`). Keep that behaviour; `dropDecision` must not loosen it.
16. **Unresolved aggregate orders** whose MACHINE is still a work-center code: inspector select shows the first option today (pre-existing); the pair list for them comes from the material and is fine to show.
17. Client validity-date chain (`runtime-client.mts:196`: BASIC_START_DATE → original_start_date) is shorter than the server's; server save gate uses `COALESCE(original_start_received, basic_start_date)` with no finish fallback (`db.py:1419`). `computeEligiblePairs` must use the server's exact chain.

## Execution model (owner instruction 2026-10-21)

**Sonnet does ALL work.** The orchestrator (Fable) dispatches and rules only; it writes no code, tests, docs, ledger lines, or memory. Every step below is a Sonnet subagent task (model override `sonnet`): implementation, `npm run build`/lint/typecheck/tests, the Step 0 Chrome probe, doc updates (`CLAUDE.md` files, spec copy), progress ledger lines, and the memory note. Sequential on one worktree, or isolated worktrees for parallel steps (no two agents on one checkout). Each implementer appends its own progress line; a Sonnet reviewer verifies each step before the next dependent step starts.

## Hazards the builder must respect
1. vis group className never falsy; single composer `_groupClassName` used by rebuild and dim; a mid-drag rebuild must keep `_dragIneligibleLines`.
2. Chooser is async inside a sync vis callback; re-apply from captured drop values, never from the live vis item (finding 5).
3. AG Grid writes the raw editor value onto `p.data.MACHINE` before `_onCellChanged`.
4. PV + MACHINE + RUN_TIME must go out in ONE `Store.updateTask` patch (undo grouping, one dirty mark).
5. Blank PV header WC = empty set: run the Step 10 report on the pilot plant before enabling, expect `pv_expired` machine-hour fallbacks to become SAP-PV/default/holds after Step 9, plant-wide on the next upload (D13).
6. `_write_outcomes`: append the column last; add the PV predicate to the WHERE.
7. Setup signatures may include PRODUCTION_VERSION (`setup-domain.mts:31`): a PV switch can change changeover with neighbours; alerts recompute covers it. Say so in the release note.
8. Only firmed orders reach SAP; PV choice on unfirmed orders is sent once firmed. No send-time dirty flag exists.
9. Tests that pin the old manual-preserve rule must be updated, not deleted: `tests/modules/routing/machine-edit-contract.test.mjs:53-60`, `tests/test_task_response_models.py:722-734`, `tests/modules/scheduling/orders.test.mjs:661-663` (sub-order `_getLineOptions` stays unchanged).


## Progress ledger

- 2026-10-21 branch feature/pv-machine-eligibility created from main 7f4d058 in worktree alert-monitor; spec written.
- 2026-10-21 wave 1 (plan Steps 1-3) done: resolver `pv_workcenter_mismatch` + `_pair_step` + `check_pair`; rate-map pv `workcenter` (fixtures and seeds updated); client `resolve()` mismatch step and server-aligned validity chain; `computeEligiblePairs`/`dropDecision` helpers and `Runtime.eligiblePairs`/`dropDecision`; tests `tests/modules/routing/pv-machine.test.mjs` and new resolver cases.
- 2026-10-21 wave 2 (plan Steps 4-5) done: `Engine.pairSchedulePatchFor` + `ManualPlacementOptions.chosenPv` (D9: a line change on a routing plant always re-resolves run time); `Table._getPairOptions`/`_parsePairValue`, grid pair editor (`_SearchableLineEditor` accepts `{value,label}`), Inspector `PV_MACHINE` select, Override pair list, D11 read-only PV on routing plants, one undo step per pair write; `Runtime.eligiblePairs(task, {requireOps})` memoised per rate map (review items 1-2); locale keys `ui.insp_pv_machine`, `ui.pv_machine_option`, `ui.pv_machine_current_ineligible`, `toast.pv_machine_ineligible` in all five locales; tests in `machine-edit-contract.test.mjs` (two-WC reseed, D9 rule), `orders.test.mjs`. Not touched: gantt.mts (wave 3), backend.

- 2026-10-21 wave 3 (plan Steps 6-7) done: Gantt drop rule in `_onDataSetUpdate` single path via `_commitSingleDrop` (same-line keeps `Runtime.eligible`; line move = `chosenPv` or `Runtime.dropDecision` keep/switch/choose/reject; `toast.pv_switched`; bar-unchanged check compares PV and run time); `Modal.choose` chooser with drop values captured at drop time (`PvDropCapture`, task fingerprint, cancel springs back); multi-drag line lock on ALL plants (D14, one `toast.multi_drag_line_locked` per gesture, companion ghosts stay on their own line); drag-time row dim on vis `onMoving` (`_groupClassName`, `dimRowsForDrag`/`undimRowsForDrag`, cleared on drop, pointerup/pointercancel, plant switch; kept across a mid-drag rebuild); locale keys `toast.pv_switched`, `toast.multi_drag_line_locked`, `modal.pv_choose_title`, `modal.pv_choose_msg`, `btn.pv_choose_confirm` in five locales; wave-2 review fixes (`requireOps` now applied, pair toast wording, orphan key removed, override pair test). Tests: `tests/modules/scheduling/pv-drag.test.mjs`, `foundation.test.mjs`, `gantt.test.mjs` (multi-drag ineligible cases now time-only). Not browser-verified (owner instruction).
- 2026-10-21 wave 4 (plan Steps 8-10) done: save gate (`db.update_task_dates_bulk`) now runs `check_eligibility` for ANY changed MACHINE/PRODUCTION_VERSION on a routing plant whatever the run-time source (D9), writing `run_time_source='routing'`; recompute fallback in `resolver._resolve_orders_on_conn` (SAP PV, then material default, else hold bypassing `_fallback`; children and running orders never switched; `pv_sap_restored`/`pv_defaulted` counters; `_write_outcomes` 7th column and PV distinct predicate); missing-master-data PV rows `pv_workcenter_missing`/`pv_workcenter_no_operation` (routing plants only) with `production_version` in both CSVs, types, admin panel and five-locale keys `ui.reject_pv_workcenter_mismatch`, `ui.mmd_reason_pv_workcenter_missing`, `ui.mmd_reason_pv_workcenter_no_operation`. Found: `db.resync_order_attributes` and `distribution.resolve` scopes `wc_codes`/`machines` stamp blank PVs with no following `resolve_orders` (documented in `backend/routing/CLAUDE.md`, not changed).

## Context appendix — things learned along the way

- vis `timechange`/`timechanged` fire only for the custom-time bar in 7.7.3 (owner declined browser testing; row-dim built on onMoving and unit-tested), so the row-dim must use `onMoving`.
- The material default PV is not fed by SAP staging and is never zero-padded.
- Only firmed orders reach SAP, which gets dates + PV only.
- The recompute pre-pass runs plant-wide on every resolve pass.
- The PV was independently editable before this work.
- AG Grid writes the raw editor value before `_onCellChanged`.
- The drop chooser is async inside a sync vis callback.
- Setup signatures may include the PV.
- `_write_outcomes` lacked a PV distinct predicate.
- Grid/inspector/override had no undo.
