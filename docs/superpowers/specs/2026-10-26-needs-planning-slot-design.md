# Needs Planning on the Alert Monitor + "Slot..." machine recommendation — design

Status: design settled 2026-10-26 (owner decisions D1-D4, controller calls C1-C11). Branch `feature/needs-planning-slot` (from `main` tip 330df34), worktree `.claude/worktrees/alert-monitor`. All paths are repo-relative. Lettered sections are design; "D#" rows are owner decisions; "C#" rows are the controller's calls, flagged to the owner and changeable on request.

## Context

Orders with `planning_status = 'needs_planning'` are queued: null planner dates and a stored `planning_reason {code, message}`. They are invisible on the Gantt (a queued row draws no bar). On the Alert Monitor, only two reason codes ever surfaced before this work: `runtime_unknown` (as the `runtime-unknown` alert) and `overlong_never` once it now fits (as `queued_now_fits`). A planner finds the rest only through the Dashboard tile, the grid Status filter, or the command palette, and places an order by typing a Planned Finish, using the Override dialog, or running Optimize. Nothing in NIMBUS suggests a machine: the optimizer never changes the machine.

The owner wants two things:
1. Every Needs Planning order listed on the Alert Monitor.
2. A recommendation of which eligible PV-machine pair could take the order on a given day, ranked by free capacity, with a dropdown to pick another pair, a "place it" action, and an "Are you sure? insufficient capacity" confirm when the day cannot absorb the order.

## Goals, non-goals, anti-goals

**Goals**
- One alert per placeable queued order, with a due-date-based time so the profile windows and ranking work unchanged.
- A sixth alert category, "Planning", with its own Overview bar, so these rows are never buried in machine groups.
- A single Top fixes card that sizes the queue ("N orders need a slot, X h of unplaced demand") and filters the list to exactly those rows.
- A "Slot..." row action that opens a dialog showing the eligible pairs ranked by free hours on the chosen day, and places the order there with one confirmation when capacity is short.
- Placement behaves like every other planner edit: dirty until the explicit Save, Undo works, the schedule-event history records it.

**Non-goals (v1)**
- A capacity warning on a Gantt drag, Inspector integration, a server-side recommendation, an OptimizerPreview-active guard (Fix has the same gap).
- (controller) Changing what the optimizer does with machines.
- (controller) Any new table, migration, or backend route. The only backend change is the alert-type whitelist.

**Anti-goals**
- No immediate save on place (owner, D3). (controller) No auto-placing of orders without a planner click.
- (controller) No confidence-score promise on the card (the score would move the wrong way when a slot adds load); see C7.
- (controller) No bar fill promised on the Gantt for the Planning colour: queued rows draw no bar, so the legend copy must not imply one.
- (controller) No new top-level tab or page.

## Owner decisions (settled 2026-10-26, do not re-open)

| # | Decision | Owner's answer |
|---|---|---|
| D1 | Ranking | Most free hours on that machine that day first: fits-first, then free hours descending. |
| D2 | Target day | Defaults to the due date. The planner can change the day in the dialog and the ranking refreshes. |
| D3 | Place | Finish-anchored placement plus firming the order. Save stays explicit: the order is dirty until Save, and Undo works. No immediate save. |
| D4 | Visibility | A Top fixes card ("N orders need a slot, X h of unplaced demand", action "Show these") plus a sixth alert category "Planning" with its own Overview bar. |

## Controller calls (flag to owner, change on request)

| # | Call | Reason |
|---|---|---|
| C1 | Excluded reason codes: `runtime_unknown`, `runtime_pending`, `zero_open_quantity`. | The first two are already alerted as `runtime-unknown` and have no run time to recommend with. The third has nothing to make; a placement would be re-queued by the next ingest. |
| C2 | `queued_now_fits` stays and moves from the `exceptions` category to the new `planning` category. An `overlong_never` row that now fits produces both alerts; the Needs Planning row's reason text reads "now fits". | It is a queue alert and belongs with the queue. |
| C3 | Severity `warn`; `err` when the due instant is already before the plant's now. Category `planning` (new). | Overdue queued orders are the most urgent ones. |
| C4 | Default day is `max(due day, plant today)`. | A past due day gives meaningless capacity numbers, and the engine would reverse forward from now anyway. |
| C5 | A closed day is never handed to the engine. The dialog walks back up to 30 days to the latest open window and the place step confirms the move. | The engine refuses a closed-day finish (`finish_cannot_hold`). |
| C6 | Write gate mirrors Fix and Override exactly: blocked in What-If, otherwise any signed-in user. One `canPlaceSlot()` seam for a future role check. | There is no viewer role in NIMBUS today; `/tasks/update` is authenticated-only. |
| C7 | Top fixes card has no confidence delta (`method: 'none'`, like the optimize-window card). | Slotting adds load; a removal delta would over-promise. |
| C8 | Overdue queued orders score as if due now for the card's ranking points. | The core gives 0 points to anything before the horizon start, which would bury the most urgent orders. |
| C9 | The "Clears N alerts on N orders" line is suppressed for this family; hours are shown with one decimal. | One alert per order makes the line a pure repeat of N. |
| C10 | Category colour `--bar-pm-planning: #e8702a`, foreground `#0c1c30`, both themes. | Nearest to Signal Warn vivid in DESIGN.md; matches the red Dashboard tile's attention register; the only hue family distinct from the five existing fills and from `--ok` green in light, dark, and the three colour-vision simulations. Re-run the dataviz checker cited near `styles.css` line 112 before landing. |
| C11 | Out of scope for v1: Gantt-drag capacity warning, Inspector integration, server-side recommendation, OptimizerPreview-active guard. | Keeps the change to the Alert Monitor surface. |

## Execution model

The orchestrator dispatches and rules; Sonnet subagents implement every task (subagent-driven development), one task per agent in dependency order. Each agent runs its own scoped tests and appends its own ledger line. Tasks, in dependency order:

0. This spec document; commit.
1. Leaf helper `frontend/scheduling/planning-reason.mts`; `Table._planningReasonText` delegates; `.gitignore` twin; test `tests/modules/scheduling/planning-reason.test.mjs`.
2. Register the type and the `planning` category (all of A2), including the four `alert.*` locale keys in five locales and the locale gates (`FIRING_ALERT_TYPES` 31 to 32, `BRANCH_KEYS` with both message keys), plus `tests/test_alert_profiles_data.py::test_alert_types_exclude_never_firing` asserting both queued types are present.
2b. Top fixes family (all of A3): `alert-leverage.mts`, `levActions`, two leverage locale keys in five locales, the tests listed in A3.
3. Producer `Alerts.needsPlanning` plus `queuedAlerts` and the four call sites.
5. Row model: the `slot` action in `alert-monitor-model.mts`.
6. Dialog module `alert-slot-modal.mts`, the `index.html` shell, `.gitignore` twin, and the `am.slot_*` locale keys in five locales with `ALERT_MONITOR_KEYS`.
7. Pane wiring: `_runAlertAction`, `_openRowMenu`, `_diagnoseFor`, `AmNimbus`, `DIAG_H`.
9. Docs: the CLAUDE.md files listed under Docs below, then ledger and memory (delegated).
10. Review wave: one reviewer per area (producer/registration, dialog/place flow, locales/tests), a fix wave, then merge to local `main` via the finishing-a-development-branch flow.

The design sections below are what these tasks implement.

## Design

### A. Alert kind `needs_planning`

**Producer.** The frontend `Alerts` layer in `frontend/insights/services.mts`, next to `Alerts.queuedNowFits` (about line 464), because the reason text must be localised (`Util.t`) and the worker core cannot. Templates: commit `0f36af8` (`queued_now_fits`, 2026-10-23) and `df0505a` (the `setAlerts` per-type diff, which already covers a new type).

```ts
Alerts.needsPlanning(onlyLines: Set<string>|null = null, nowFitsIds: ReadonlySet<string> = new Set()): NimbusAlert[]
Alerts.queuedAlerts(onlyLines): NimbusAlert[]   // queuedNowFits(...) concat needsPlanning(..., fitsIds)
```

Rule per task in `Store.tasksArr`: `planning_status === 'needs_planning'`; skip the three excluded codes (C1); `line = MACHINE` (skip when empty or not in `onlyLines`); skip `Alerts._dismissed`. The due instant is `Util.dueInstant(t)` (reads `original_end_date`, which queued DTO rows carry); now is `Store.plantNow(plant)`. Severity is `err` when due is before now, else `warn`; `time = due ?? now`. The id is `'needs-planning-' + t.id` (stable, so it is also the acknowledgement key). Message key `alert.needs_planning` (`alert.needs_planning_no_reason` when there is no reason text), vars `{order: Util.orderNumber(t), reason}`, plus `taskId`, `line`, `type 'needs_planning'`.

The four existing `Alerts.queuedNowFits(...)` call sites in services.mts (about lines 506, 508, 550, 552) are replaced with `Alerts.queuedAlerts(...)`.

**Reason text without an import cycle.** `services.mts` must not import `orders.mjs`. The body of `Table._planningReasonText` (`frontend/scheduling/orders.mts`, about lines 388-403) moves into a zero-import leaf `frontend/scheduling/planning-reason.mts`:

```ts
export function planningReasonText(reason, t: (key, vars?) => string, opts: { nowFits?: boolean } = {}): string
```

`Table._planningReasonText` keeps its signature and delegates. The `.mjs` twin goes in `.gitignore`.

**Registration (no migration).** `AlertType` union in `frontend/platform/types.mts` (about line 505); `NimbusAlert.type` in `frontend/nimbus-compute-core.d.ts` (about line 35); a new `planning: ['queued_now_fits', 'needs_planning']` key in `ALERT_CATEGORIES` (between `setup` and `exceptions`, with `queued_now_fits` removed from `exceptions`); a new `export const SLOT_ALERT_TYPES = new Set(['needs_planning'])` in `frontend/insights/alert-profiles.mts` (about lines 99-104 and 122). `SLOT_ALERT_TYPES` must stay disjoint from `FIXABLE`, `OVERRIDE` and `CALENDAR_ALERT_TYPES`; the drawer/monitor parity test in `tests/modules/insights/insights-ui.test.mjs` (about lines 333-350) depends on it. The backend whitelist `ALERT_TYPES` in `backend/alert_profiles/data.py` (about line 27) gains `needs_planning`.

### A2. Sixth category `planning`

Insert `'planning'` between `setup` and `exceptions` in every ordered list, so "Other" stays the catch-all: the `AlertCategory` union (`types.mts`, about line 510), `MONITOR_CATEGORIES` (`frontend/alert-monitor/alert-monitor-model.mts`, about line 32), and `CATEGORY_ORDER` (`frontend/insights/alert-profile-matches.mts`, about line 41). The profile editor (`CATEGORIES = Object.keys(ALERT_CATEGORIES)`), `_typesText` and `overviewData` follow automatically.

**Crash hazard.** The cell briefing `byCat` in `frontend/insights/insights-ui.mts` (about lines 1375-1381) has four fixed keys and does `byCat[cat === 'setup' ? 'exceptions' : cat].push(a)`. A sixth category would push into an undefined array and throw. Map `planning` to `exceptions` there too (`cat === 'setup' || cat === 'planning'`).

**Styling** (`frontend/styles.css`): tokens `--bar-pm-planning` and `--bar-pm-planning-fg` in `:root` (about lines 115-119) and `body.dark` (about lines 5738-5742); `.vis-item.vis-range.profile-match-planning` (about lines 1294-1298) plus a `.profile-match-warn` ring override like the capacity rule (about line 1304, since the amber ring is 1.4:1 on this orange); `.lg-pm-planning` (about lines 7397-7401); `.am-ov-sw-planning` (about lines 7722-7726); `.am-ov-cat-planning` (about lines 7803-7807); comments "five" become "six" (about line 7795). A legend `<li>` goes into `frontend/index.html` after about line 2660. No structurally hard-coded 5 exists anywhere (grid columns, flex rows and legend verified).

**Locales** (all five): `ape.cat_planning` (Planning / Planung / Planificación / Planification / Planejamento) and `legend.pm_planning_t` / `_d` beside the `pm_exceptions_*` rows. Spanish says "pedido", French "commande".

**Tests:** `locale-completeness.test.mjs` (`REQUIRED` legend list and `ALERT_MONITOR_KEYS`), `alert-profiles.test.mjs` (six keys, `ALERT_CATEGORIES.planning`, `categoryOf('needs_planning') === 'planning'`), `alert-monitor-overview-css.test.mjs`, `alert-monitor-overview.test.mjs`, `alert-profile-editor.test.mjs`, `alert-monitor-model.test.mjs`; new `insights-ui.test.mjs` case "showForCell files a planning alert under Other and does not throw"; new `alert-profile-matches.test.mjs` case "categoryByTask ranks planning ahead of exceptions at equal severity"; `services.test.mjs` (the `queued_now_fits` category assertion becomes `planning`). **Docs:** `frontend/insights/CLAUDE.md`, `frontend/scheduling/CLAUDE.md` ("five category fills"), the 2026-10-20 Alert Monitor spec (about line 280), and a comment in `alert-monitor-overview.mts` (about line 345).

### A3. Top fixes family `needs-planning` (`frontend/insights/alert-leverage.mts`)

- `LeverageFamily` gains `'needs-planning'`; `LeverageAction` gains `{ kind: 'needs-planning'; alertIds: string[] }`; `LeverageItem` gains `unplacedHours?: number`.
- New `_needsPlanningItems(ctx, alerts)` after `_optimizeItems`: one plant-wide bucket over alerts of type `needs_planning`. Hours are the sum of `max(0, parseFloat(task.RUN_TIME) || 0)` over `ctx.input.tasksById` (a two-line local mirror of `Util.runHours`, because this module imports nothing from the foundation by design), rounded to one decimal. Key `'needs-planning'`, title key `leverage.title.needs-planning` with vars `{n, h}`, action `{kind:'needs-planning', alertIds}`; returns `[]` when empty.
- Points are the sum of `impactPoints` with an overdue alert scored as if due now (C8: time before plant-now is raised to plant-now). `outsideConfidenceWindowCount` is recomputed the same way.
- `_finish` treats `'needs-planning'` like `'optimize-window'`: `method: 'none'`, `confidenceAfter: null` (C7).
- `groupLeverage` spreads `_needsPlanningItems`; `_sortItems` places it. `_replayable` requires `setup-pair`, so `analyzeLeverage` never sends this family to the worker (pinned by a test).
- `levActions` in `alert-monitor-model.mts` (about lines 618-669): `case 'needs-planning': add('show-alerts', 'leverage.action.needs-planning', true)`; the generic `show-alerts` entry is guarded so the menu does not repeat it; `fixClearsText` is suppressed for this family (C9).
- The pane needs no change: `_onLevAction` leads to `_levShowAlerts(item)`, which sets `AlertMonitorPane.setFocus(item.alertIds, title)` and `AlertProfileMatches.setFocusTaskIds`. That lists exactly those ids (profile bypassed) with the focus chip, and the Orders table profile filter follows the task ids.
- Locales (five): `leverage.title.needs-planning` = "{{n}} orders need a slot · {{h}} h of unplaced demand" (reusing each locale's `kpi.needs_planning_demand` phrasing), `leverage.action.needs-planning` = "Show these".

**Tests.** `tests/modules/insights/alert-leverage.test.mjs`: "one plant-wide item; hours sum RUN_TIME, unknown counts 0, one decimal"; "method none, confidenceAfter null, never replayed"; "overdue scores as if due now; beyond-window scores 0"; "absent when no needs_planning alert"; extend the sort test. `tests/modules/alert-monitor/alert-monitor-leverage.test.mjs`: an `npItem` fixture; primary action is Show these and the menu does not repeat it; the title carries n and h; add the family to the never-prints-points loop. `tests/modules/alert-monitor/alert-monitor-leverage-pane.test.mjs`: "Show these focuses exactly its alert ids". **Docs:** `frontend/insights/CLAUDE.md` (the families list, about line 20) and `frontend/alert-monitor/CLAUDE.md` (about lines 28 and 55).

**Alert locale keys** (five locales, identical placeholders): `alert.needs_planning` = `Order "{{order}}" has no slot yet: {{reason}}`, `alert.needs_planning_no_reason`, `alert.type.needs_planning` = "Needs Planning" (mirroring each locale's `ui.needs_planning`), `alert.help.needs_planning`.

### B. "Slot..." action and dialog (Alert Monitor)

**Row.** In `frontend/alert-monitor/alert-monitor-model.mts`: `RowActions.slot = SLOT_ALERT_TYPES.has(a.type) && hasTask`; `RowActionId` and `RowPrimary.second` gain `'slot'`. `rowPrimaryActions` picks `second = fix ? 'fix' : override ? 'override' : slot ? 'slot'`; the action column is fixed-width and a third button does not fit. The overflow menu gets item `am.slot`, locked in What-If like Fix. `rowHtml` renders `data-alert-action="slot"` with the label `'◫ Slot…'` (the leading glyph is required by `_splitGlyph`).

**Pane.** In `frontend/alert-monitor/alert-monitor-pane.mts`: `_runAlertAction` `case 'slot'` returns early in What-If, else calls `AlertSlotModal.open({plant, taskId, alertId})`; `_openRowMenu` treats `slot` as modal-opening (refocus the trigger first); `_diagnoseFor(a, task, plant)` adds the field `am.slot_suggested` = `formatSlotOption(AlertSlotModal.suggest(task, plant))` for `needs_planning` rows (synchronous, memoised per `${taskId}|${Store.dataRev()}`, map cleared on `plant:selected`); `DIAG_H` (model, about line 231) rises from 132 to 166 for the extra grid row. The `AmNimbus` type gains `Timeline.gotoLineDay`, `Table._getPairOptions` and `Table._planningReasonText`.

**Dialog module.** New `frontend/alert-monitor/alert-slot-modal.mts` (plus a `.gitignore` twin), patterned on `alert-ack-modal.mts`. The static shell `#modal-alert-slot` goes in `frontend/index.html` right after `#modal-alert-ack` (about line 2404), **with `data-no-backdrop-close`**; otherwise the shell's backdrop-click handler in `application-shell.mts` (about line 2246) bypasses the module's own `close()`. It opens via `Modal.open('modal-alert-slot')`; `Modal.confirm` stacks on top of it (proven by the Override dialog and `confirmOvertimePlacement`, `orders.mts` about line 1356 and `engine.mts` about line 1566); `plant:selected` closes it.

Body: order and machine (read-only), the reason, a `#asl-day` Flatpickr date (default `defaultSlotDay`), a `#asl-pair` select of ranked candidates (top one preselected) and the hint `am.slot_hint`. Footer: Cancel and `#asl-place` (disabled with an `am.whatif_blocked` title in What-If).

**Pure exports** (dependencies injected so Node can test them):

```ts
export interface SlotCandidate { value; pv: string|null; machine; label; needHours: number|null; resolveStep?; freeHours: number|null; capHours: number|null; closed: boolean; fits: boolean }
export interface SlotDeps { pairOptions(task); hoursFor(task, pv, machine); dayCapacity(machine, day) }
export function parsePairValue(value): { pv, machine }                       // orders.mts ~1595 logic, Runtime.normPv
export function rankSlotCandidates(task, day, deps): SlotCandidate[]        // fits first; freeHours desc (null last); needHours null last; machine, pv asc
export function slotFinishFor(machine, day, workWindow): { finish, day, movedBack } | null   // latest open window end within SLOT_LOOKBACK_DAYS=30
export function slotTaskKey(t): string      // copy of Interaction._dropTaskKey (gantt.mts ~5626) + planning_reason.code, firmed, row_version, the order quantity (and its unit)
export function defaultSlotDay(task, plantToday): string
export function formatSlotOption(c, t): string
export function canPlaceSlot(): boolean     // signed in && !Sandbox.active
```

**Live dependencies.** `pairOptions` is `NIMBUS.Table._getPairOptions(task)` (it already falls back to the plant line list on non-routing plants), else `Store.linesForSelectedPlant()`. `hoursFor` on a routing plant is `Runtime.resolve({...task, PRODUCTION_VERSION: pv}, machine)` (`frontend/routing/runtime-client.mts`, about line 241; validity is judged on the basic start date, then the original start date, then today, so null planner dates are fine); otherwise `Util.runHours(task)`. `dayCapacity` is `Utilization.computeMatrix(Util.startOfDay(day), 1)[machine][dayKey]` giving `{free: max(0, effectiveCapacity - scheduled), cap: effectiveCapacity, closed: capacity <= 0}`; `scheduled` includes derived setup. The utilisation cache serves a day that lies inside the Dashboard's 7-day window; any other day costs one synchronous plant-wide compute, acceptable per dialog open or day change.

**`place()` sequence.**
1. Staleness check: `slotTaskKey(Store.tasks[id]) === s.taskKey`, else toast `am.slot_stale` and close. Also `canPlaceSlot()`.
2. `parsePairValue`, then `slotFinishFor(machine, day, Calendar.workWindow)`. If null, toast `am.slot_no_window` and stay open.
3. If `movedBack > 0` or `needHours > freeHours` (or either is unknown): `Modal.confirm({tone:'warn', title: am.slot_confirm_title, message: am.slot_confirm_closed | am.slot_confirm_short, confirmLabel: am.slot_confirm_place})`. Cancel stays open. The staleness check is re-run after the await.
4. Build the patch: on a routing plant with a PV, `Engine.pairSchedulePatchFor(cur, pv, machine, finish, {quiet:true})`; otherwise `Engine.manualRoutingSchedulePatchFor(cur, machine, finish, {quiet:true})`. Both are pure. On null, read `Engine.lastManualRefusal`: `finish_cannot_hold` gives `toast.finish_cannot_hold`; null on a routing plant gives `toast.pv_machine_ineligible`; anything else gives `toast.manual_refusal_generic`. Stay open.
5. `wasFirmed = Store.isFirmed(id); snap = UndoStack.snapshotTasks([id]); Store.updateTask(id, patch, 'alerts'); if (!wasFirmed) Store.setFirmed([id], true, 'alerts');` then `UndoStack.push(t('am.slot_undo'), () => { UndoStack.restoreTasks(snap); if (!wasFirmed) Store.setFirmed([id], false, 'undo'); }, [id])`. `restoreTasks` strips `firmed`, hence the explicit unfirm. The Store both-dates rule (`store.mts` about line 496) flips `planning_status` to scheduled and clears the reason for every code.
6. `Alerts.scheduleRecompute()`, toast `am.slot_placed`, close, then `NIMBUS.Timeline.gotoLineDay(machine, Util.dayKey(patch.end_date), undefined, {taskId})`. Not `AlertsUIAdapter.focus`: the alert vanishes on recompute and carries the old line and day.

**Wire.** Source `'alerts'` maps through `SOURCE_WIRE.alerts = 'alert_fix'` (`persistence.mts`, about line 43), already accepted by the backend `PLANNER_SOURCES` (`backend/schedule_events/events.py`, about line 40). `App._trackDirty` dirties both `task:update` and `firmed:change`, and Save sends `FIRMED` for `_firmDirtyIds`. The Inspector History therefore reads "Alert fix".

**Alert Monitor locale keys** (five locales plus `ALERT_MONITOR_KEYS` in the locale test; no "points", "pts", "exact" or "estimate" in `am.*`): `am.slot` (`◫ Slot…`), `am.slot_title`, `am.slot_day`, `am.slot_pair`, `am.slot_hint`, `am.slot_option` (`{{pair}} — {{free}} of {{cap}} h free · needs {{need}} h`), `am.slot_option_short` (adds `· {{short}} h short`), `am.slot_option_closed`, `am.slot_option_unknown`, `am.slot_none`, `am.slot_suggested`, `am.slot_place`, `am.slot_confirm_title`, `am.slot_confirm_short`, `am.slot_confirm_closed`, `am.slot_confirm_place`, `am.slot_placed`, `am.slot_stale`, `am.slot_no_window`, `am.slot_undo`. Fit: an option line is about 45-60 characters in de/fr/pt inside a full-width select in a standard modal; acceptable at 1,024 px (the `.lbl` text of the row button already hides below 1,200 px).

**Tests (B).** `tests/modules/alert-monitor/alert-monitor-rows.test.mjs`: Slot appears only on needs_planning rows with a task id, never alongside Fix or Override, carries `data-task-id`, is locked in What-If, menu order is Go to, Slot..., Diagnose, Acknowledge. `tests/modules/alert-monitor/alert-slot-modal.test.mjs` (harness: `alert-ack-modal.test.mjs` plus a `globalThis.NIMBUS` stub): rank order; `slotFinishFor` open day, closed day, and 31 closed days returning null; `slotTaskKey` and `defaultSlotDay`; `formatSlotOption` key choice; open renders and Place is hidden when `canPlaceSlot` is false; re-rank on day change; place happy path (one patch with source alerts, firm with source alerts, one undo entry that restores and unfirms, recompute, toast, close, `gotoLineDay` arguments); short-day confirm and cancel writes nothing; closed day confirms and places at the previous window end; engine refusal stays open; stale task aborts (also after the confirm); plant change closes. `tests/modules/alert-monitor/alert-monitor-pane.test.mjs`: slot dispatches `AlertSlotModal.open` from the button and the menu and is a no-op in What-If; Diagnose shows `am.slot_suggested` from a stubbed `suggest`. **Docs:** `frontend/insights/CLAUDE.md` (producer paragraph beside `queued_now_fits`, about line 170), `frontend/alert-monitor/CLAUDE.md` (module, action vocabulary, import edges, gotchas: closed-day walk-back and no role gate), `backend/alert_profiles/CLAUDE.md` (about line 222), `frontend/scheduling/CLAUDE.md` (about line 127, the delegation to the leaf helper).

**Tests (A).** `tests/modules/scheduling/planning-reason.test.mjs`: fixed codes, overlong with now-fits, run-time-over-cap numbers and fallback, unknown code, null reason (`orders.test.mjs` about line 2619 stays green). `tests/modules/insights/services.test.mjs` (extend `withQueuedFixture`, about line 816): one warn alert per queued row with the due instant as time and `err` when overdue; skips the three excluded codes, rows with no machine and dismissed rows; honours `onlyLines`; clears once placed; `queuedAlerts` publishes both types through `_recomputeSync` with the "now fits" reason; a registration test copied from about lines 869-874. `tests/modules/insights/alert-profiles.test.mjs`: Slot set disjoint from Fix and Override. `tests/test_alert_profiles_data.py::test_alert_types_exclude_never_firing` asserts both queued types are present. `tests/modules/locale-completeness.test.mjs`: firing-type count 31 to 32 (about line 858) and `BRANCH_KEYS` (about line 648) gain both message keys.

## Hazards verified (two independent agents, spot-checked by the controller)

- `Modal.confirm` stacks over a `Modal.open`-ed shell; capture-phase Escape closes the confirm first; focus returns to the opener. Backdrop click needs `data-no-backdrop-close`.
- A closed-day finish is refused (`finish_cannot_hold`, `engine.mts` about lines 1673-1694; `closed_finish` in `calendar-engine.mts` about line 987), hence the dialog-side walk-back. `needs_overtime_confirm` cannot fire (place before firm) and `running_finish_locked` cannot (no start). `run_time_zero`, `plant_no_timezone`, `overlong_never` and `no_operating_window` can, and produce a toast with the dialog staying open.
- The Store both-dates rule (`store.mts` about lines 496, 559) releases every reason code; `_markPlaced` sets `user_scheduled`; the row leaves the list only after the debounced recompute (use `_refocusKey` / `_restoreRowFocus`).
- `Utilization.computeMatrix` cache: hit when plant and data revision match and the window lies inside a cached one; 6-entry LRU; a 1-day call does not evict the 7-day matrix.
- `Runtime.eligiblePairs` requires the plant's rate map to be loaded (`Runtime.hasMapFor`); `requireOps` drops `zero_runtime` and `pv_expired` pairs; on routing plants the per-candidate hours differ, so use `Runtime.resolve`, not `task.RUN_TIME`.
- `scheduleAlertsForPatches` needs no escalation (the alert sits on the order's own machine; Slot calls a full recompute).
- Confidence score: overdue `err` rows (time before now) add 0; in-horizon `warn` rows add 2 times the time weight. Documented, no change.
- Locale gates that trip: `FIRING_ALERT_TYPES.length === 31` (becomes 32), the union regex (no digits in the type name), help and type keys in all five locales, the missing-key ratchet (every new key in de/es/fr/pt), the `am.*` vocabulary, and the es/fr noun checks. The `insights-ui.test.mjs` parity test requires `needs_planning` outside the Fix, Override and Calendar sets.
- Node tests have no `NIMBUS` global: every `_nim().Table` / `Timeline` read goes through an injectable seam.

## Verification

```bash
npm run build && npm run typecheck && npm run lint
node --test tests/modules/scheduling/planning-reason.test.mjs tests/modules/scheduling/orders.test.mjs
node --test tests/modules/insights/services.test.mjs tests/modules/insights/alert-profiles.test.mjs tests/modules/insights/insights-ui.test.mjs
node --test tests/modules/alert-monitor/alert-monitor-rows.test.mjs tests/modules/alert-monitor/alert-monitor-pane.test.mjs tests/modules/alert-monitor/alert-slot-modal.test.mjs tests/modules/alert-monitor/alert-monitor-model.test.mjs
node --test tests/modules/insights/alert-leverage.test.mjs tests/modules/insights/alert-profile-matches.test.mjs tests/modules/alert-monitor/alert-monitor-leverage.test.mjs tests/modules/alert-monitor/alert-monitor-leverage-pane.test.mjs tests/modules/alert-monitor/alert-monitor-overview.test.mjs tests/modules/alert-monitor/alert-monitor-overview-css.test.mjs tests/modules/alert-monitor/alert-profile-editor.test.mjs
node --test tests/modules/locale-completeness.test.mjs tests/modules/platform/store.test.mjs tests/modules/static-assets.test.mjs
node --test "tests/js/*.test.js"
npm run check:static-assets && npm run check:legacy-surface
python -m pytest tests/test_alert_profiles_data.py tests/test_alert_profiles.py -q   # pg tests need local PG + NIMBUS_TEST_DB=1
```

Compare against base before calling the gate red (known pre-existing: the `styles.css` CRLF test and the leverage timing flake).

**Manual browser script** (`uvicorn brain:api --port 8000`, a plant with queued rows):
1. The Alert Monitor lists one "Needs Planning" row per queued order except runtime-unknown and zero-quantity ones; overdue rows are `err`; Diagnose shows "Suggested slot". Top fixes shows the "N orders need a slot · X h" card near the top (an overdue queue outranks single-line cards); "Show these" lists only those rows with the focus chip. The Overview What panel shows a "Planning" bar in the new orange; clicking narrows the list. In dark theme the bar and legend swatch are readable. The profile editor shows a Planning group with both queued types.
2. "Slot..." opens the dialog: order, reason, day = due day (or today if overdue), a ranked select with the top pair preselected; changing the day re-ranks the numbers.
3. Place a fitting candidate: the bar lands at the machine's close on the Gantt (Go To centres it), the firmed badge shows, the row leaves the Needs Planning filter, the unsaved badge increments, Ctrl+Z removes the bar and the firm, Save persists, Inspector History reads "Alert fix".
4. Place on a short or closed day: warn confirm; Cancel keeps the dialog; Confirm places (closed goes to the previous open day's close).
5. Edit the order in the grid while the dialog is open: Place toasts stale and closes.
6. What-If on: Slot... is disabled with the hint. The profile editor shows the type under Planning; an explicit-type profile that ticks it saves (backend whitelist).
7. de/fr/pt: option lines readable at 1,024 px.

Deploy needs only the image; there is no migration. Not pushed or deployed unless the owner says so.

## Context appendix

**What prompted it (2026-10-26).** The owner asked whether queued (Needs Planning) orders could be shown on the Alert Monitor and whether NIMBUS could recommend a machine for them by free capacity on a chosen day, with a confirm when the day cannot absorb the order. Before the design was fixed, three read-only explorer agents (Alert Monitor domain, the Needs Planning definition, capacity plus the Gantt drop flow) and three planning/verification agents checked what exists.

**Explorer findings that shaped the design.**
- No machine-picking logic existed anywhere. The optimizer never changes `MACHINE`, so the recommendation is new code built from existing parts: eligible pairs from the routing layer, per-pair hours from `Runtime.resolve`, free hours from the utilisation matrix.
- A Gantt drop has no capacity check at all (verified: the drop path, `_commitSingleDrop`, only checks PV-machine eligibility). This is why a capacity warning on drag is out of scope but the Slot dialog carries its own confirm, rather than relying on a downstream guard.
- Queued rows are absent from the Gantt (no bar is drawn). The Gantt fill and the legend row for the Planning colour exist for parity with the other five categories only; the colour is really seen on the Alert Monitor Overview, and the legend copy must not promise a bar.
- Only two reason codes alerted before (`runtime_unknown` as `runtime-unknown`, and `overlong_never` that now fits as `queued_now_fits`). Every other reason was silent on the Monitor, which is the gap the new kind closes; for example no eligible pair, run time over cap, or a missing quantity (examples, not an exhaustive list).

**Things learned along the way.**
- A closed-day finish is refused by the engine (`finish_cannot_hold`), so the dialog must pick the open window itself (walk back up to 30 days) and ask the planner to confirm the move.
- `UndoStack.restoreTasks` strips the firm flag, so an undo that only restores the snapshot would leave the order firmed; the undo closure unfirms explicitly when the order was not firmed before.
- The cell briefing's `byCat` map has four fixed keys; a sixth category without a mapping throws on the first `showForCell` that hits a planning alert.
- `Modal.confirm` stacks over a `Modal.open` shell (proven by the Override dialog); the shell backdrop click is the exception and needs `data-no-backdrop-close` so the module's own `close()` runs.
- No viewer role exists in NIMBUS today: `/tasks/update` is authenticated-only. The write gate is therefore What-If only, behind one `canPlaceSlot()` seam so a future role check is a one-line change.
- A queued order that is also an `overlong_never` row that now fits yields two alerts (queue-fit and needs-planning); the reason text says "now fits" so the pair reads consistently.
- The core gives zero confidence points to anything dated before the horizon start; without the overdue-as-now rule the most urgent queued orders would sort to the bottom of Top fixes.
