# Universal "Firmed" status: finish-based frozen horizon, SAP firm as a flag, lock-aware firm actions

> **Status (2026-10-27): PLANNING, not approved, nothing built.**
> Six Sonnet verifiers checked the plan against live code, and all six reports are folded in below.
> **Resume after a restart:** all owner questions are answered (D1–D9, section 3). The plan is ready for approval. Approval then triggers the worktree + Wave A.
> After approval, copy this doc to `docs/superpowers/specs/2026-10-27-universal-firm-design.md` (design of record) and add a memory note.
> Repo HEAD when verified: `3c606ac` (docs only on top of `97e5269`). No commits touch `engine.mts` / `orders.mts` / `sap_staging.py` since. Re-check HEAD before branching.

---

## 1. Context

The owner wants "firmed" to be one universal status in NIMBUS, modelled on SAP's planning time fence. An order is firmed by **planner intervention** (manual firm) or by the **frozen horizon**. "SAP firmed" is a visible flag that never locks anything in NIMBUS. Once an order holds the lock, the UI must stop offering "Firm this order". The owner also asked for the Inspector-pane implications.

What the investigation found, against what the owner described:
- **SAP firm already locks nothing** (since 2026-10-06; `Engine.firmingStatus` reasons are `frozen | manual | running`, `Engine.isSapFirmed` is display-only). Three spots still treat it as "firmed":
  - `frontend/alert-monitor/alert-monitor-pane.mts:1264` (diagnostic shows "Firmed" for `firmed || ecc_firmed`)
  - `backend/distribution/data.py:3343` (`"firmed": manual OR firming_indicator == 'X'`, used only by the N→1 survivor confirm at :3450)
  - `frontend/integration/sap-interface-ui.mts:1335` (vanish-deletion modal "Firmed" column = `manual_firmed || firming_indicator==='X'`)
- **The frozen horizon is START-based today** (`Engine.isFrozenHorizon`, `frontend/optimization/engine.mts:1261-1267`: `start_date >= now && start_date < frozenEnd`, persisted placement only). The owner wants the end date. SAP's PP/DS planning time fence also firms an order (dynamically, no indicator set) once its **finish** is inside the fence; heuristics make no automatic changes inside; new proposals are pushed to the fence end.
- **There is a third lock, "running"** (`Engine.isInProgress`: start <= now < end). The owner keeps it as a firm reason.
- **Firm actions read only the manual layer** (`Store.isFirmed`). A frozen order shows a red "Firmed" banner and a blue primary "🔒 Firm this order" button at the same time.
- **The grid "Firming" column is blank for every order today.** `/tasks` (`backend/scheduling/routes.py:262-290`) sends only `ecc_firmed` (boolean), never the raw `FIRMING_INDICATOR`, so the column and the Inspector "More" row read `undefined`.

## 2. Settled owner decisions (2026-10-27, don't re-ask)

| # | Decision |
|---|---|
| D1 | Firmed = **manual** OR **frozen** OR **running**. SAP firm is display-only. |
| D2 | Frozen = **planned finish in [now, frozenHorizonEnd)**, persisted placement only. An overdue order (finish already past, not complete) is **not** frozen. |
| D3 | Straddler rule, following SAP. An order starting inside the window but finishing after the edge is **not frozen**, and Optimize may move it. **No unfrozen order may finish inside the frozen window**: the optimizer's frozen floor becomes a FINISH floor. Manual drag keeps ignoring the frozen horizon. |
| D4 | Firm actions. Not firmed → "Firm this order". Manual only → "Unfirm". Frozen or running (with or without manual) → **no firm/unfirm action anywhere**. "Of course a user can move it" (drag stays allowed). |
| D5 | SAP flag. A neutral "SAP firmed" tag at the top of the Inspector. The grid column is renamed **"SAP Firmed"**, shows a **capital X** or blank (no checkmark), stays hidden by default. Remove the remaining SAP-as-lock spots. The Gantt hover card is unchanged. |
| D6 | Send to SAP sends **X for all firms**: manual, SAP's own X (add-only, unchanged), frozen by finish, running. SAP firm just doesn't drive NIMBUS locking. |

**Prior decisions this reverses** (tell the owner explicitly):
- OD-C2a (`docs/multi_change_spec_08.20.26.md:496,833`): "frozen iff the order's start is inside".
- OQ27 (`BACKWARD_SCHEDULING_MIGRATION.md:150, 3924-3931`): frozen judged on the stored derived start, "where the bar physically sits".
- R26 (:3400): one start expression for the five readers.
- VU17/D19: the `frozen_window_crossed` alert.
- OQ54/OQ61: the frozen-entry firm flag is start-based. OQ61's "only firmed orders are sent" stands.

## 3. Owner answers to the post-verification questions (2026-10-27, settled)

- **D7 (Q1):** **Strict.** Send to SAP sends only NIMBUS-firmed orders (manual, SAP X add-only, frozen by finish, running). Overdue and never-placed orders are not sent. No outbound-only overdue arm.
- **D8 (Q2):** **Rename** the Optimize checkbox to "Respect planner-firmed orders", with the hint "Frozen-horizon and running orders always stay put."
- **D9 (Q3):** The distribution survivor confirm applies when the survivor is **NIMBUS-firmed** (planner, frozen by finish, running); SAP-X-only no longer asks.

The original question text is kept below for the record.

1. **Send to SAP drops more orders (load-bearing).** Today `firm_flag` uses `eff_start < frozen_end` with **no lower bound**, so every overdue/past order, placed or never-placed, goes out as X. Under D2/D6 overdue orders and never-placed orders are not firmed. OQ61 sends **only firmed orders**, so they **stop being sent at all**; `skipped_unfirmed` jumps on the first Send.
   - The repo's note (unverified, owner-relayed) says SAP's weekly run replaces/renumbers unfirmed planned orders.
   - Options:
     - (a) accept, strict D6
     - (b) outbound-only extra rule: also send X for **placed overdue** orders (finish < now), so SAP keeps the NIMBUS date for orders NIMBUS has planned but not finished. NIMBUS still treats them as movable.
   - Recommend (b) only if the owner confirms SAP's weekly run hurts unfirmed orders; otherwise (a).
   - Side fact: once SAP echoes an X back, that order sends X forever via the add-only SAP arm, even after NIMBUS unlocks it (pre-existing).
2. **"Respect firmed orders" checkbox wording.** It only ever frees **planner** firms; frozen and running always stay put. Rename it to "Respect planner-firmed orders", with a hint (`ui.opt_respect_firmed`, `index.html:2898`, hard-coded tooltip `optimize-ui.mts:313`)? Recommend yes.
3. **Distribution re-weight confirm (C2).**
   - Today an **unfirmed frozen or running** survivor collapses silently, even though its finish is recomputed (start + full run time) and may move.
   - Plan: require the confirm when the survivor is firmed by NIMBUS (manual, frozen by finish, running), and **stop** requiring it for SAP-X-only survivors.
   - Both directions are behaviour changes. Recommend yes.

## 4. My calls (owner to check while reading)

- **C1.** Send to SAP judges frozen/running on the **placed** start/finish (first/last segment, else `scheduled_start`/`scheduled_end`), not `eff_end`. This matches the browser's "persisted placement only" rule. A never-placed order (whose `eff_end` is SAP's due date) is not frozen. Today it *is* sent X by SAP start, so this is a behaviour change (see Q1).
- **C2.** See Q3.
- **C3.** F key on an all-frozen/running selection does nothing and shows an info toast. Bulk actions (Firm all, Firm selected, palette, Freeze All) skip locked orders and say how many were skipped.
- **C4.** `frozen_window_crossed` becomes **unreachable** under the finish rule: the reconcile holds a placed row's finish, and a moved finish is reported as `finish_moved_earlier` first. **Delete the reconcile branch** (`engine.mts:2023-2027`), but keep the alert type id accepted (`backend/alert_profiles/data.py:26`) so saved profiles still validate. Mark it deprecated in the docs. Two silent flips to frozen remain, both already alerted by their own movement alert, so no new frozen alert:
  - a `reversal_forward` row re-placed from now can land its finish inside the window
  - a calendar closure can pull a finish inside
- **C5.** Manual-only behaviours stay manual-only, documented as such:
  - the overtime-confirm gate (`engine.mts:1682`): a manual firm gets the overtime prompt; a frozen drag onto closed time gets `finish_cannot_hold`
  - multi-drag companions (`gantt.mts:5733`) exclude only manual firms; a running companion aborts the whole drag (`companionFailed`)
  - Push +1 h (`pushFinishPatches` `engine.mts:1707`) skips every firmed order (union)

  **What "a planner can still move it" really covers** (V4 correction):
  - frozen and manual-firmed orders: draggable, overridable and keyboard-movable (`gantt.mts:387, 5659-5673`; `engine.mts:1259`)
  - **running orders: not draggable**, refused with `running_finish_locked` (`engine.mts:1616-1620`, `gantt.mts:5553`); override is refused the same way (`orders.mts:1679`), and only a run-time edit changes one. This is existing behaviour and stays.
  - Push skips all of them.
- **C9.** The Needs Planning **Slot** modal (`alert-monitor/alert-slot-modal.mts:620,623`) auto-firms the order it places ("then firmed", `am.slot_place`).
  - When the placed finish is inside the frozen window, **skip the manual firm**: the frozen horizon already protects the order, and a redundant planner firm would be unremovable under D4.
  - Otherwise firm it as today.
  - Update `am.slot_place` to say "firmed (or protected by the frozen horizon)".
- **C10.** One choke point. `Engine.applyFirm(ids, firmed, source)` filters through `firmPlan` and returns `{changed, skipped}`, and every surface calls it.
  - This is the only path to `Store.setFirmed`, apart from Sandbox, undo and Time Machine restores, which stay raw.
  - The classic script reaches it with the uncounted `NIMBUS.Engine?.applyFirm?.()` idiom (as at `nimbus-intelligence.js:35,1210,1467`), so the legacy surface does not grow.
- **C11.** `placement_exception` (an approved overtime/overlong placement) is fixed in the optimizer (`engine.mts:303`) but is **not** a firm reason, so the UI may still offer Firm on it. The owner said firm = manual/frozen/running, so leave it; document it as a fixed-but-not-firmed state.
- **C6.** Server timezone parity: `frozen_window_for_plant` returns **no frozen window** for a plant with no timezone. This matches the browser (no clock = not frozen) and stops Send from firming orders the UI never shows as frozen.
- **C7.** "Running" copy: the old rule "running is protected, not locked, in UI copy" (`frontend/scheduling/CLAUDE.md:36`) is superseded by D1. The Inspector says "Firmed · Running". Update that CLAUDE.md line.
- **C8.** No growth of the legacy surface. The command palette gets its firm/unfirm/locked lists through an existing bridge or a precomputed value, not a new `NIMBUS.Engine.firmPlan` reach (the ratchet only shrinks; `nimbus-intelligence.js:746-747` precedent).

## 5. Workstream A: finish-based frozen predicate + finish floor (frontend optimizer)

**A1. Predicate.** `Engine.isFrozenHorizon` (`engine.mts:1261`):
```ts
if (!end || !task.end_date || !Engine.hasPersistedPlacement(task)) return false;
const at = now ?? Engine._clockFor(task);
return !!at && task.end_date >= at && task.end_date < end;
```
- Drop the `start_date` guard. A finish-only placed row (distribution child, `scheduled_start` NULL) freezes correctly on its real held finish. Verified desirable.
- `end_date` = last segment end (verified, `db.py:239`, `engine.mts:1494/2044/3220`).
- Rewrite the doc comment (:1231-1260, cites OD-C2a).
- Automatic followers (comment edits at most):
  - `effectiveFirmedIdSet` :303, `firmingStatus` :1331
  - autoReflow :3197/:3253, Remove Backlog `frozenMoved` :2287
  - `Timeline._inLockBand` `gantt.mts:571` (comment :538-546; the 30 s scan rebuilds membership fresh, no change needed)
  - setup-scheduler `taskIsFirmed` :2394 (reads the effective set; `isWindowEndBoundary` :6656 follows)
  - UI consumers: `gantt.mts` 1244/3939/5109/6218, `orders.mts` 532/804/2071/2526, `insights-ui.mts` 985/1397, `services.mts:661` (Alerts.applyFix refuses frozen-by-finish automatically), `nimbus-intelligence.js:1444`, `distribution-pane.mts:1489`, `optimize-ui.mts:1612`
- Verified set algebra: new frozen ⊆ old frozen ∪ running, so the lock union loses **exactly the straddlers** and gains nothing. A running order finishing in the window now reports both `frozen` and `running` (display only).

**A2. Split the floors.**
- `earliestAllowedStart` (`engine.mts:1354`) becomes the pull-forward START floor only: delete the `frozenHorizonEnd` param and the fold at :1370-1371.
- Callers (complete list, verified):
  - `:2029` (already passes null; only positional args shift)
  - `:2988` (optimizer `notBefore` closure)
  - `orders.mts:214` (live Store)
- Delete `applyFrozenFloor` (:1343). Its only callers are autoReflow at `:3209`/`:3265`. Fix the comments at :1339, :2210 and `docs/architecture/optimizer-dispatch.md:107`.
- Add `Engine.frozenFinishFloor(runNow, frozenEnd)` → `frozenEnd` when `frozenEnd > runNow`, else null.
- **It must take the snapshot's `frozenHorizonEnd`, never live Store** (the worker's Store is empty).

**A3. New bound** `finishFloor?: Date|null` on `DueDateFirstBounds` (`setup-scheduler.mts:515`).
- Set at `engine.mts:2988` from `baseSnapshot.frozenHorizonEnd`.
- `hardBounds`/`withRunContext`/`normalizeRunDates` spread it automatically.
- Worker contract: add it to `SerializedOptimizerValidation` and `serializeOptimizerValidation` (`optimizer-worker-contract.mts:17-91`), rehydrate plus a malformed check at `engine.mts` ~:3399-3441 (null allowed).
- Update the literal at `optimizer-worker.test.mjs:32-39`.
- Staleness is covered by `Cache-Control: no-cache` on `.mjs` (`brain.py:588-593`), **not** by `?v=`. The verifier corrected the earlier claim.

**A4. Placement.** Corrected after verification; the earlier "shift and re-place" helper had two bugs.
- **Bug 1:** `freeIntervalsForPlacement` stops at the first fitting interval (T3 early exit, `setup-scheduler.mts:2781-2785`). It is built from the pre-shift cursor at :3206/:4872, so re-placing with only `earliestStart` changed fails, and the order is wrongly left unadmitted. **Every attempt must rebuild the free intervals and recompute `isInherentlyOverlong`** (:3195/:4861/:7372; it can flip under `overlong_only` with plant periods).
- **Bug 2:** "shift by (floor − finish)" overshoots for split policies. Example: windows 0-8 and 24-32, 6 h run, floor 26. The minimal start is 4; the naive shift gives 24.
- **Mechanism:**
  - **Contiguous policies (default `never`):** one exact placement with `earliestStart = max(cursor, finishFloor − setupMinutes − runMinutes)` (setup + run sit in one interval). If the result still finishes before the floor (closed time), shift and retry with rebuilt intervals.
  - **Split-capable policies (`partial_allowed`, split-capable `overlong_only`):** bounded retries (≤4), each rebuilding intervals. Last resort `earliestStart = finishFloor`, which is today's rule and always finishes ≥ floor.
  - Never start before `bounds.now` (placementStart). This is already enforced (fragment start = `max(anchor.end, bounds.now)` :6011-6013).
- **Sites** (complete, verified):
  - `candidateForSequence` :3200 (pre-check: fragment `completionEnd < finishFloor` → unadmitted)
  - unknown tail :4866 (also reached via `placeWholeLineAsTail` ~:5950)
  - `fillPlanningGaps` :7370 (already rebuilds intervals via flatMap :7374; skip gaps whose ceiling < floor)
  - autoReflow `engine.mts` :3208/:3264 (`Calendar.placeWithSetup` builds intervals from `earliestStart`, `calendar-engine.mts:1105`; floor from the changed order's plant clock)
- Iteration caps are unaffected: retries don't call `consumeSearchIteration` (:1163-1168); they only consume wall-clock. The floor binds roughly the first placed order per ordering.

**A5. Validator** (unprotected orders only):
- `validateCandidate` `date_window` :6850 adds `end < finishFloor`, with a **deterministic message** (`applyPartial` keys baseline findings on code|taskId|message).
- `planningDefect` :6572: `ceiling < finishFloor` → `expired_window` (equality valid).
- `baselineWithinWindow` :7442-7447 requires `end >= finishFloor`.
- `setup_floor` :6906 stays pull-forward only (a straddler's setup may start inside the window, at or after now).
- `Table._planningWindowLabel` (`orders.mts:207-220`): the start limit shows the pull-forward floor only; add a "finish on/after {frozenEnd}" conflict when `frozenEnd > ceiling`.
- Protection checks through `taskIsFirmed` (:6458, :6690, :6813, :6833-6834 `protected_changed`, :6889, :6910, :7112) follow automatically. The stale-diff exclusion of `frozenHorizonEnd` (:6783-6788) is unchanged.

**A6. Remove Backlog stays exempt.**
- `backlogBounds` (:2767-2786) has `notBefore: () => null`, `ignorePlantWindow`, and no `finishFloor`.
- `frozenMoved` (:2287) now counts finish-in-window orders, **including running ones** (Backlog moves running orders). Reword `ui.opt_pv_backlog_frozen_moved` if needed.

**A7. Reconcile.** Delete the dead `frozen_window_crossed` branch (C4). Remove the hard-coded English at `nimbus-compute-core.js:1161` only if the alert can no longer be raised. Keep the locale keys while the type id stays accepted, or mark them deprecated.

**A8. Copy (all 5 locales).**
- Reword `ui.frozen_horizon_help` (Master Data help, `admin-ui.mts:185`; "already start inside") and `legend.frozen_d` (+ fallback `index.html:2696`).
- Reword `ui.sap_send_confirm` ("orders starting inside the frozen horizon").
- Reword `ui.opt_pv_card_util_frozen_tip` (straddlers can now start inside the window).
- `ui.opt_pv_backlog_frozen_moved` (see A6).
- **Delete** the dead key `ui.insp_frozen_horizon_banner` (no consumer).

## 6. Workstream B: backend alignment

**B1. `db.py` helpers.**
- Keep `_horizon_bounds_for_plant(cur, plant) -> (visibility_end, frozen_end)` (`:546`, 7 callers, monkeypatched in tests).
- Add `frozen_window_for_plant(cur, plant) -> (now_local, frozen_end)`. Reuse `compute_frozen_horizon_end(now_utc, tz, …)` (`:543`) and `_plant_local_now(tz)` (`:3767`), with **one `now_utc`** for both (avoids skew).
- Return `(None, None)` when the plant has no timezone (C6).
- Add pure `finish_in_frozen_window(end, now, frozen_end)`.
- Note the `LIMIT 1` with no ORDER BY on the plant timezone reads (plants keyed on subnetwork). Pre-existing; record it, don't fix it here.

**B2. `backend/integration/sap_staging.py`.**
- `firm_flag(manual, ind, placed_start, placed_end, frozen_end, now)` (:2200) returns X for manual, SAP X (strip/upper, add-only), `finish_in_frozen_window`, or running (`placed_start <= now < placed_end`, same as `db._order_is_running` `db.py:3778`).
- Running must **not** depend on `frozen_end` (a plant with no frozen horizon still has running orders).
- Only caller: `build_outbound_groups` :2245. Make it `build_outbound_groups(rows, frozen_end, now=None)`; when `now` is None, running is off, so the existing `(rows, None)` test calls keep working.
- Roll-up stays "any member firmed ⇒ group X" with group end = MAX over all candidate members. A running/frozen child can carry a far-later sibling end out with X (existing behaviour, more qualifying cases; note it).
- `_outbound_candidate_rows` (:2265) selects `placed_start = COALESCE(seg.first_start, o.scheduled_start)`, `placed_end = COALESCE(seg.last_end, o.scheduled_end)` (NULL when needs_planning).
- The **sent** end stays `db._EFF_END_SQL`. Drop the old `original_start_received`/`basic_start_date` start chain from the firm decision.
- `queue_send_to_sap` :2359 uses `frozen_window_for_plant` (it already refuses an invalid plant timezone at :2356).
- D7 strict: no outbound-only overdue arm.
- Fix docstrings :2201, :2217, :2335 and the comment :2269-2271.

**B3. `backend/distribution/data.py`.**
- :3343 becomes `"firmed": bool(manual_firmed)`.
- `_fetch_children_by_machine` (:3324-3329) must also return the last segment end (or confirm `scheduled_end` always equals it). Keep `ORDER BY o.id` + `FOR UPDATE OF o`, which `TestBundle3FetchChildrenLock` `test_distribution.py:4606-4615` pins.
- `frozen` at :3455/:3499 becomes `finish_in_frozen_window(last_end or scheduled_end, now_local, frozen_end)`. Today it is start-based with no lower bound and False for finish-only children.
- The survivor check at :3450 becomes `not (firmed or frozen or running)` (Q3).
- Frontend consumers of `frozen` are unchanged in shape: `distribution-pane.mts:1174,2586`, `shares-editor.mts:32,44,240,263,345,351`.

**B4. `ecc_firmed` normalisation.** `backend/scheduling/routes.py:275` becomes `str(r.get("FIRMING_INDICATOR") or "").strip().upper() == "X"`. Ingest normalises nothing: Excel `db.py:5041/5094` is raw, SAP staging only strips (:302). This keeps the grid X, the Inspector tag and Send's X in agreement.

**B5. `sap-interface-ui.mts:1335`.** Rename that modal column to show the planner firm and the SAP firm separately, or label it "Firmed (planner or SAP)". Recommend two columns, "Planner firm" and "SAP firmed" (X), to match D5.

## 7. Workstream C: lock-aware firm actions, Inspector, grid, SAP flag

**C-1. One helper.**
- New pure module `frontend/optimization/firm-actions.mts`; add its `.mjs` twin to `.gitignore`. It exports `firmActionForReasons(reasons) → 'firm'|'unfirm'|null` (null when frozen or running present) and `firmReasonLabels(...)`, in the order running, frozen, manual.
- On `Engine` (UI/live-path only):
  - `firmActionFor(task, now?)`
  - `firmPlan(ids, now?) → {firm, unfirm, locked}`, with **one shared clock and frozenEnd per plant** (scale: `firmingStatus` already costs about 3 `plantNow` calls per task)
  - `firmReasonsText(task)`; the frozen label reads "Frozen horizon (finishes before Thu 30 Oct)"
  - `firmStatusText(task)`
- Every click handler re-checks at click time (the window rolls) and toasts if the action changed.

**C-2. Surfaces** (V4-verified complete: every `Store.setFirmed` caller; `store.mts:569` has no guard, so each surface goes through `Engine.applyFirm`, C10):
- Context menu (`index.html` 2279-2285; `orders.mts` 3015-3016/3056-3058).
  - Keep toggling `style.display`: `_buttons()` at :3026-3029 filters on it and queries only `button`, so a `<div class="ctx-note" role="none">` is skipped by arrow/Tab navigation.
  - Show the lock reason in that note when no action applies, and hide the separator.
  - **Null-guard** `.ctx-note` and a missing `Store.tasks[id]` (`planning-audit.test.mjs:53-67` mocks only the four buttons).
- Alert Slot modal auto-firm (`alert-slot-modal.mts:620,623`), per C9.
- Inspector button (`orders.mts` 2719-2725, `toggleFirm` 2988-2993). Inline `onclick` becomes `data-act` listeners, which shrinks the legacy surface.
- Gantt F key (`gantt.mts` 6194-6201), per C3.
- Multi-inspector Firm all / Unfirm all (`gantt.mts` 6272-6309): show each only when its list is non-empty; i18n the hard-coded " firmed" count as the union.
- Remove `Selection.stats().firmedCount` (`selection.mts:103-115`); importing Engine there would add a cycle.
- Grid toolbar Firm/Unfirm selected (`orders.mts:1602-1609`).
- Command palette (`nimbus-intelligence.js` 1170-1196, Freeze All 743), per C8/C10.
  - Mixed selection: offer **Firm (n)** when `firm.length > 0`, else **Unfirm (n)** when `unfirm.length > 0`, else hide the command.
  - The undo entry (`_pushTaskUndo`) covers only the changed ids.
  - Freeze All is scoped to the **selected plant** (today it runs over all of `Store.tasksArr`); `confirm.firm_all` counts the to-firm list only.
- Override modal "Also firm" row (`index.html` ~2446; `orders.mts` 1636/1653/1689).
  - Hidden when locked, via `firmEl.closest?.('.chk-row')`: test fixtures mock `#ovr-firm` as a bare `{checked:false}` at `orders.test.mjs` 839/892/1801/2054/2236.
  - Keep setting `.checked` before hiding.
  - **Re-check at apply time**, so a window that rolled while the modal was open can't add a firm to a now-locked order.
- Dashboard firmed list (`insights-ui.mts` 981-1003): Unfirm only for manual-only; add a reason; show the **finish**, not the start (:992); compute text only for rendered rows.
- Grid 🔒 cell (`orders.mts:536`): a lazy `tooltipValueGetter` with `firmStatusText` replaces the hard-coded `title="Firmed"`.

**C-3. Inspector top block.** Corrected after V5.
- Replace `orders.mts:2567-2568` (before the alerts card at 2569) with:
```html
<div class="insp-flags" data-insp-lock>                 <!-- rendered when firmed OR SAP firmed -->
  <div class="insp-status">                             <!-- only when firmed -->
    <div class="insp-status-head"><span aria-hidden="true">🔒</span> <strong>Firmed</strong></div>
    <div class="insp-status-reasons">Running · Frozen horizon (finishes before Thu 30 Oct) · Planner</div>
  </div>
  <span class="sap-pill neutral insp-sap-tag" title="{ui.sap_firm_marker}">SAP firmed</span>  <!-- only when SAP firmed -->
</div>
```
```css
.insp-flags { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
.insp-status { flex:1 1 100%; min-width:0; background:var(--bg-elev); border:1px solid var(--line);
  border-radius:var(--r-md); padding:8px 10px; font-size:12px; color:var(--fg); }
.insp-status-head { font-weight:600; }
.insp-status-reasons { margin-top:2px; font-size:11.5px; line-height:1.4; color:var(--fg-mute); overflow-wrap:anywhere; }
.insp-sap-tag { background:var(--bg-subtle); border:1px solid var(--line); }   /* AA: --fg-mute on --bg-strong is 4.44:1 in light */
```
- **Reuse `.sap-pill.neutral`** (`styles.css:6908-6917`, already used at `distribution-pane.mts:2354`) rather than inventing a tag class.
- The tag sits **outside** the status card: the card means "NIMBUS locks this", the tag means "SAP flag, locks nothing".
- **The reasons wrap** to 2-3 lines in every locale (pane 340 px, about 280 px of text). A head row plus a reasons line is therefore required.
- The 🔒 is a colour emoji, so CSS `color` does nothing. Drop the "red glyph" idea. Use `aria-hidden` and let the visible "Firmed" carry the meaning.
- No `aria-live` (the 30 s refresh would chatter).
- Delete `.insp-sap-firm-info` (styles.css:1700), `.insp-firmed-banner` (1754-1764) and `.insp-frozen-banner` + comment (1765-1773). All are verified unused elsewhere; no test asserts them.
- Action button rendered from `firmActionFor`: `firm` = primary, `unfirm` = plain, null = none.
- `Inspector.refreshLock(id)` patches only `[data-insp-lock]` and the action region, and re-attaches the button listener.
  - The 30 s lock-band scan (`gantt.mts:551-556`) calls `refreshLock(Inspector._currentId)` **on every scan**, not only on membership change: reason text changes (frozen ↔ running) and the first scan has `prev == null`. `gantt.mts:35` already imports Inspector.
  - **Not** a full `_render`: that replaces the Notes textarea (:2709), Flatpickr and the History card.
  - Today the scan writes only the vis DataSet (`_applyTaskPatch` :915, no Store event), so a rolled window never refreshes the Inspector. That is a real gap this fixes.
  - The Inspector already fully re-renders on `firmed:change` / `task:update` / `tasks:bulk*` (`orders.mts:2203-2228`); that path is unchanged.
- Tokens are verified in `:root` and `body.dark` (dark mode is the `body.dark` class).

**C-4. Grid column "SAP Firmed".**
- `order-field-catalog.mjs:74-76`: `i18nGridKey: 'col.sap_firmed'`, `i18nInspectorKey: 'ui.sap_firmed'`. Keep `key`/`field: 'FIRMING_INDICATOR'` (saved layouts are keyed by colId; admin visibility by key). `gridDefault: false`.
- `_catalogOnlyColumns` (`orders.mts:448-460`): one-key `valueGetter: p => Engine.isSapFirmed(p.data) ? 'X' : ''`. It **must read `ecc_firmed`**, since the raw key never reaches the browser.
- Text filter works on the valueGetter output. CSV export and range copy use `getValue`, so X exports correctly.
- Inspector "More" loop (`orders.mts:2659-2669`) reads `task[key]` generically, so it needs a special case for this key (X or `—`).
- **Keep** `ui.insp_firming`: the Alert Monitor uses it. The admin System Config row label comes from `i18nInspectorKey` (`admin-ui.mts:3145`) and will read "SAP firmed".

**C-5. Alert Monitor** (`alert-monitor-pane.mts:1264`): use `Engine.firmingStatus(task).firmed ? Engine.firmStatusText(task) : t('am.diag_not_firmed')`.
- Engine is imported directly. It is already reachable transitively; use it only inside `_diagnoseFor`.
- `DIAG_H` 166 is fixed; the `dd` truncates with an ellipsis and a `title`. Optionally `grid-column: span 2` for this field.
- Update the test at `alert-monitor-pane.test.mjs:691`.

**C-6. i18n (all 5 locales).**
- **New:** `ui.firm_status_line`, `ui.firm_reason_frozen`, `ui.firm_reason_frozen_until`, `ui.firm_reason_manual` ("Planner"), `ui.firm_reason_running_short`, `ui.sap_firmed`, `col.sap_firmed`, `ui.multi_firmed_count`, `toast.firm_skipped_locked`, `toast.firm_nothing`, `toast.firm_none_to_firm`, `toast.unfirm_none_selected`
- **Reworded:**
  - `legend.firmed_d` (wrong today: says "Locked by a planner")
  - `tip.firmed_column`
  - `toast.still_firmed`
  - `cmdp.intent_freeze_sub`
  - `toast.cannot_fix_firmed` ("Unfirm it first" is impossible for frozen/running)
  - `ui.history_field_manual_firmed` → "Planner firm" (history records only the planner firm)
  - `ui.opt_respect_firmed` + `optimize-ui.mts:313` (Q2)
  - `ui.dist_banner_firmed_left` ("left for you to unfirm"; `distribution-pane.mts:1489` builds it from the union)
  - `toast.freeze_saved`, `toast.frozen_schedule`, `toast.unschedule_all_firmed` ("all orders firmed")
  - `am.slot_place` (C9)
  - `cmdp.intent_freeze_sub` is English-with-`// MISSING TRANSLATION` in de/es/fr/pt; translate all four.
- **Locale-test rules** (`locale-completeness.test.mjs`):
  - append the new keys to the hand-kept BRANCH_KEYS list (:632), with all 5 locales non-empty and matching `{{x}}` placeholders (:715-752)
  - removed keys go from **all 5** locales (en-superset test :540)
  - the missing-key ratchet is 226 against baseline 230 (:551); add keys to every locale at once
  - `ui.firm_reason_running` is pinned (:566-573)
  - no `fixiert`/`Fixierung` in the German `ui.sap_send_confirm` (:778)
- `toast.still_firmed` becomes race-only after D4; keep it for that race.
- **Kept:**
  - `ui.firm_reason_running` (pinned by the G3 locale test)
  - `ui.sap_firm_marker` (now the tag tooltip)
  - `ui.hov_firmed_badge` (hover unchanged)
  - `ui.insp_firming` (Alert Monitor)
- **Removed:** `ui.insp_firmed_banner`, `col.firming`, `ui.insp_frozen_horizon_banner`. V4 is greping all usages.
- **Alert core wording** (`nimbus-compute-core.js:984/1010`, "Firmed order" only when manual `t.firmed`) is **left alone**: it is a pure worker with no clock input, the headline is already neutral, and `tests/js/compute-core.test.js:120-131` pins it.

**C-7. Hover card** (`gantt.mts:5109-5113`) is unchanged per D5. Known wording inconsistency: the hover shows no frozen/manual reason, and its long SAP line differs from the Inspector's short tag. Record it in the spec.

## 8. Docs to update

Every listed file has an **`AGENTS.md` twin** with the same stale lines; update both.
- **Domain docs** (CLAUDE.md + AGENTS.md):
  - `frontend/optimization` :22 (`frozen_window_crossed` "manually firmed rows only", already wrong), :26, :32, :69 "effective ECC/frozen", :95, :98
  - `frontend/scheduling` :36 (C7 + firm-action rule)
  - `frontend/insights`, `frontend/platform`, `frontend/alert-monitor`
  - `backend/integration` (outbound firm rule), `backend/distribution` :33, `backend/scheduling`
- **Other docs:**
  - `docs/SAP_STAGING_DESIGN.md` D9 :37, D10 :38, §119
  - `docs/NIMBUS_INTERFACE_ARCHITECTURE.md:600`
  - `docs/architecture/optimizer-dispatch.md:107`
  - `BACKWARD_SCHEDULING_MIGRATION.md` :1982, :2142, OQ27/OQ54 (add a "superseded 2026-10-27" note)
  - `docs/multi_change_spec_08.20.26.md` :496, :833 (historical note)
- **Code comments:**
  - `engine.mts` :254, :1231-1260, :1337-1342, :2194-2211, :3114-3117, :3147
  - `setup-scheduler.mts` :381, :2399, :5248, :5322, :6720
  - `styles.css:106-107`, `types.mts:51`, `store.mts:1181-1183`
  - `db.py:519-520`, `schema.sql:399-401`, `migrations/2026-08-20-plant-frozen-horizon.sql` header, `master_data.py:1633`
  - `services.test.mjs:540`, `engine.test.mjs` :265, :436, :3617-3683, :4319
- **No DB migration** (verified: no view, function, index or generated column encodes frozen logic).

## 9. Risks (tell the owner at hand-off)

1. **Send to SAP sends fewer orders** (accepted, D7). Overdue and never-placed orders stop going out; `skipped_unfirmed` jumps on the first Send after cutover. SAP keeps whatever it last had for them.
2. **Straddlers lose protection at cutover, with real churn.**
   - Instability ranks near last in Min Changeover (`compareObjectiveFacts` :7490-7492). Any setup or priority gain will move a straddler, pulled earlier until its finish equals the edge.
   - Expect about one order per line, plus successors, on the first run.
   - Each line's first unfrozen order lands finishing exactly at the edge, then freezes within a minute as the fence rolls.
3. **Anchor side effect.** A straddler that was a line's first order is no longer a protected anchor (`initialScheduledAnchor` :5971). On plants without `machine_state` rows, the next order's setup becomes "state unrecorded" and gets default minutes.
4. **A planner firm inside the frozen window can't be removed** until the order is dragged out or finishes. Running + planner firm: likewise until it finishes. Accepted (D4).
5. **Preview → Apply drift.** The window rolls between run and Apply (`frozenHorizonEnd` is excluded from the stale diff on purpose). A finish placed at the floor can sit inside the window at Apply time. Benign, pre-existing for starts; the guarantee holds at run time.
6. **Stale-tab writes.** The lock is client-side; the server accepts `FIRMED` toggles regardless (`routes.py:574-616`). A stale tab can write a harmless planner firm on a frozen order.
7. **Server/browser running parity.** A finish-only placed child reads "running" in the browser (derived start) but not on the server (`_order_is_running` needs both stored edges). Transient, until the reconcile saves.

## 10. Sequencing and delivery

- Branch `feature/universal-firm` in a `.claude/worktrees` worktree off `main`. Record HEAD at start; the owner commits concurrently.
- Sonnet subagents implement; the orchestrator dispatches and rules. Subagents append their own progress lines.
- **Wave A** first (the predicate and floor are the foundation). Then **B** and **C** in parallel; the files are disjoint, except that C's helper reads `firmingStatus`.
- Each wave runs scoped tests, then a Sonnet reviewer and verifiers; fix waves stay inside the wave.
- Deploy later via `/promote-azure` (no migration). Bump `NIMBUS_BUILD_ID` as usual.

## 11. Verification

- **Build and static checks:**
  - `npm run build`, `npm run typecheck`, `npm run lint`, `npm run check:static-assets`
  - `npm run check:legacy-surface`: it must **shrink or hold**, no `--allow-growth` (C8/C10).
    - The scanner reads compiled `.mjs`, so build first.
    - Removing the two inline `toggleFirm` entries (`cq1-legacy-surface.json:507,512`) is a shrink, but `legacy-surface.test.mjs` does `deepStrictEqual`. Re-record with `node scripts/legacy-surface.mjs --write`.
- **JS tests to update** (verified break list):
  - `engine.test.mjs`:
    - :248, :287, :312 (fold test), :411, :3583: fixtures lack `end_date`
    - :470 (asserts start ≥ frozenEnd at :508)
    - :4311, :4346 (crossing branch deleted)
    - not breaking: :522, :3624, :4506
  - `orders.test.mjs:107` (window label)
  - `confidence-lifecycle.test.mjs:246` ("frozen" 8-9 with the edge at 9:00)
  - `confidence-lifecycle.test.mjs:462-490`: c1 is already manual-firmed, so a mixed selection now firms only c2/c3 and the undo scope shrinks. :495-510, :181-232 and :512-535 should pass; the `firmedCount` stubs go.
  - `planning-audit.test.mjs:53-95` (needs the null guards)
  - `legacy-surface.test.mjs` (contract re-record)
  - `locale-completeness.test.mjs` (BRANCH_KEYS)
  - `orders.test.mjs` override fixtures (`closest?.`)
  - unaffected: `intelligence-accessibility.test.mjs:177`
  - `optimizer-worker.test.mjs:32-39` + rehydrate tests
  - `alert-monitor-pane.test.mjs:691`
  - `planning-audit.test.mjs` ~66
  - `remove-backlog.test.mjs` :220/:253 should pass unchanged
  - `setup-scheduler`, `order-rules-matrix` and `optimize-ui` don't pin the frozen floor
- **New JS tests:**
  - **Predicate.** Finish in window = frozen; finish == edge = not frozen; overdue = not frozen; straddler = not frozen; a finish-only placed row with no start freezes.
  - **Optimizer.** After Optimize no unprotected order ends before the floor. A straddler may start inside the window. The first post-window order may be pulled to finish exactly at the edge. A fragment or gap ending before the floor admits nothing. The validator gives `date_window` for an unprotected end < floor and nothing for a protected one.
  - **Placement edge cases.** Free intervals are rebuilt per attempt (T3 truncation regression). Split-policy convergence and the last resort. autoReflow overdue peer.
  - **firm-actions.test.mjs.** All 8 reason subsets.
  - **UI.** `firmPlan` mixed selection. Inspector block per combination; SAP tag neutral; no button when frozen or running; `refreshLock` partial patch. Context menu three states + note. Override row hidden. SAP Firmed column X/blank from `ecc_firmed`.
  - **Gantt.** F key; multi-inspector.
  - **Dashboard.**
  - **Locale completeness.** New keys in all 5 locales; removed keys gone.
- **Python** (local Postgres only; check `.env` `PG_HOST` is local and set `NIMBUS_TEST_DB=1`):
  - **`tests/test_sap_staging.py`:**
    - :585 (SQL string)
    - :604-617 `test_firm_flag_truth_table` (4 → 6 args): manual / SAP X / lowercase x / finish in window / finish == edge / finish < now / straddler / running / never-placed / no horizon / no timezone
    - `_o` helper :620, :649
    - :656 `test_send_skips_unfirmed_orders` (f1 needs a finish in the window)
    - pg Send tests :891-950 etc. are unaffected
  - `tests/test_domain_sap_staging_edges_coverage.py` `_candidate` :60, :119 (now a finish boundary); the `(rows, None)` calls are fine
  - **`tests/test_distribution.py`:** new pg cases: a SAP-X-only survivor is not listed; a frozen survivor is listed; a running survivor is listed; a finish-only child is frozen by finish. Lock-order pin :4606-4615 still green.
  - `tests/test_task_response_models.py` / golden tests for the `ecc_firmed` normalisation.
- **Then the full `npm test` and the scoped pytest.**
- **Browser (owner, live):**
  - frozen order: lock block with no Firm button and no right-click firm item, only the reason note
  - manual-only order: Unfirm
  - SAP-firmed unlocked order: neutral tag + Firm
  - SAP Firmed column: X
  - Optimize: no movable order finishing inside the window
  - Send to SAP summary counts

---

## Appendix A: Verifier ledger (2026-10-27, Sonnet)

| Verifier | Scope | Result |
|---|---|---|
| V1 | Frozen predicate + call sites | Sound. Followers listed; set algebra; prior decisions reversed; `frozen_window_crossed` fully dead; dead key `ui.insp_frozen_horizon_banner`. |
| V2 | Finish-floor optimizer | Idea sound. **Two placement bugs found** (T3 interval truncation, split overshoot) → closed form + rebuild per attempt. Churn and anchor risks. `?v=` claim corrected. Exact test break list. |
| V3 | Backend Send/distribution | Verified. eff_* semantics; C1 behaviour change; Send drop consequence; `_fetch_children_by_machine` lacks last segment end; one-`now_utc`; ecc normalisation gap; AGENTS.md twins. |
| V4 | Firm-action UI surfaces | Partial. **Missed surface:** the Slot modal auto-firm (C9). **Running orders are not draggable** (C5 corrected). Single choke point recommended (C10). `refreshLock` on every scan. Ratchet: `NIMBUS.Engine?.x?.()` is uncounted. More stale "unfirm it" copy. `placement_exception` is a fixed-not-firmed state (C11). Exact break list. |
| V5 | Inspector design + grid | **Blocker:** `/tasks` has no raw `FIRMING_INDICATOR`. Emoji can't be tinted; contrast AA fix; wraps 2-3 lines; reuse `.sap-pill.neutral`. |
| V6 | Cross-cutting | No migration. Third SAP-firmed meaning (sap-interface modal). Respect-firmed copy. Overtime/multi-drag manual-only. Timezone parity. Running copy rule. Ratchet invariant. Scale. Doc list. HEAD 3c606ac. |

## Appendix B: Things learned along the way

- SAP firming facts (sources gathered 2026-10-27):
  - PP/DS planning time fence firms dynamically once the **finish/availability date** is inside the fence; no indicator is set.
  - Heuristics make no automatic changes inside; new proposals are pushed to the fence end.
  - A manual change to a planned order sets SAP's firming indicator. NIMBUS deliberately does **not** auto-firm on drag (not requested).
- Sources:
  - [SAP Learning, PP/DS additional topics](https://learning.sap.com/courses/exploring-advanced-production-planning-with-sap-s-4hana-pp-ds/examining-additional-topics-in-production-planning-1)
  - [SAP Help, Firming Procurement Proposals](https://help.sap.com/saphelp_46c/helpdata/en/f4/7d2ca444af11d182b40000e829fbfe/content.htm)
  - [SAP Community, not-firmed planned orders in APO](https://community.sap.com/t5/supply-chain-management-q-a/not-firmed-planned-orders-in-sap-apo/qaq-p/12339465)
- Manual firm is server-side (`orders.manual_firmed`, sent only for firm-dirty rows `persistence.mts:1207`). History records it as a `modify` with `changes.manual_firmed`; there is no firm event kind.
- `Engine.firmingStatus` is UI/live-path only. Detached optimizer runs use `effectiveFirmedIdSet` from the snapshot, and so must the new `finishFloor`.
