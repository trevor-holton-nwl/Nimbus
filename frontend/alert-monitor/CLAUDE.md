# Alert Monitor — the profile-driven alert triage tab

Frontend half of the Alert Monitor (spec: `docs/superpowers/specs/2026-10-20-alert-monitor-design.md`, including its "Shipped vs deferred" section). Backend half: `backend/alert_profiles/` (profiles + acknowledgements). The shared logic lives in `frontend/insights/` (see its CLAUDE.md); this folder is the page, its pure model and two modals.

## What lives here

- **`alert-monitor-pane.mts`** — `AlertMonitorPane`, the `#alerts-tab` page (`#am-scroll` is its scroll element). Lifecycle is the `DistributionPane` shape: the shell calls `init()` once (idempotent; wires the Store, `AlertProfileMatches` and `AlertProfileClient` subscriptions) on first entry, `render()` on every entry, `setActive(false)` on leave (`application-shell.mts`, `App.goto`). **`_active` gates every subscriber** — a hidden pane does no work, and `render()` sets `_levStale` because events were ignored while hidden. `_paint()` calls `_ensureShell()` (builds the static shell once; `_setHtml`/`_lastHtml` diff the HTML per region), then paints toolbar, KPI strip, banner, prompt, leverage panel and groups. `resetView()` (also run on a plant change) clears folds, open diagnose panels, "Show all" and the focus set. `setFocus(ids, title)` / `clearFocus()` implement the "Showing N alerts for: …" chip (a focused list bypasses the profile).
- **`alert-monitor-model.mts`** — pure builders (`kpiSummary`, `windowSummary`, `viewFor`, `visibleAlertsFor`, `horizonAlerts`, `emptyStateFor`, `rowActionsFor`, `rowHtml`, `groupHeadHtml`, `diagnoseHtml`, `levSectionHtml`, `levTitle`, `levSummaryText`, `levPairsForReview`, `GROUP_ROW_CAP = 40`). No DOM, no Store: translation is an **injected `t`**, and every interpolated value goes through the module's `_esc` once (don't escape again in a caller; a double-escaped `title=` was a Task 12 bug).
- **`alert-profile-editor.mts`** — `AlertProfileEditor`, the modal (`#modal-alert-profile`, body `#ape-body`, footer `#ape-foot`) opened from the pane's Manage/Create buttons and **never from inside the User Settings modal** (settings closes itself and navigates to the tab instead). Left rail = the plant's profiles, right = the draft form; typing never re-renders the body (it would drop focus), only the live day range, live match count and structural changes touch the DOM. **Validation is not re-implemented:** `validateProfile` (`insights/alert-profiles.mts`) returns i18n keys per field path and the editor only renders them. **Permission model** (`canDeleteProfile`): an admin or the creator (`created_by`, case-insensitive) may edit/delete; anyone else sees a read-only form with a Duplicate hint. Duplicate and "Copy to plants…" (searchable multi-select of accessible plants) create new rows; a server 409 `stale` surfaces as a stale-edit message.
- **`alert-ack-modal.mts`** — `AlertAckModal.open({plant, alertId})` over the static `#modal-alert-ack` (Modal's central focus trap). `validateAck` is pure: reason required, trimmed, at most 200 characters; `until` is the picked day sent as **naive local** `YYYY-MM-DDT23:59:59` (end of that day, so "until the 27th" hides through the 27th), or `null` with "No end date". Never an offset or `Z` (server convention: `backend/alert_profiles/CLAUDE.md`, "Naive local time"). Submit goes through `AlertAcksClient.acknowledge`, which refetches and fans out so every list repaints itself; the modal never touches the Store.

## The leverage render loop (`_levRun`)

High-leverage fix cards are computed in two phases so the alert list never waits on them:

1. `_levScheduleFirst()` defers the first run one tick (the list paints first). `_levRun` builds the input (`_levDeps.buildInput`, over `buildPlantSnapshot`), runs **`groupLeverage`** (pure, immediate), sets `_levHave`, and paints — **phase 1**, removal numbers only.
2. Unless `_levSkipAnalysis()` (Sandbox active or `OptimizerPreview.active`), it awaits **`analyzeLeverage`** through the worker-backed runner (`Compute.leverageBatch`), re-applies any minutes the user typed (`_levTyped` -> `replayWithMinutes`), and paints again — **phase 2**, replayed numbers.

What keeps it correct: **one in flight** (`_levInFlight`; a request during a run sets `_levRerun` and re-queues afterwards); the **`Store.rev()` stale guard** (`rev0` is read before the work; if the plan moved, the result is dropped and re-queued through `_levDebounced`, at most `_LEV_MAX_STALE_RETRIES = 3` times); a **400 ms debounce** (`_LEV_DEBOUNCE_MS`) on `alerts:change`, `tasks:bulk*`, `setup-snapshot:replace`, `calendar:change`, `blocks:change`, `plantBlocks:change`; a half-typed minutes box survives an unrelated repaint (`_renderLeverage` returns while `.am-lev-min-input` has focus) **except** the repaint that shows that box's own result — `_levMinutesEntered` sets the one-shot `_levForcePaint` around a synchronous `_paint()` (it relies on `_paint` staying synchronous). A `requiresMinutes` card renders "enter minutes", never as a prediction. Cards work on all of the plant's alerts (`PaintState.scoped`), not the profile's (D10).

## Action vocabulary

Row and group-head actions are `focus | fix | override | diagnose | ack | unack | dismiss` (`_onAlertAction`) and make the same calls as the drawer (`AlertsUIAdapter._handleAction`). Eligibility comes from the shared **`FIXABLE_ALERT_TYPES` / `OVERRIDE_ALERT_TYPES` / `CALENDAR_ALERT_TYPES`** exported by `insights/alert-profiles.mts`, which the drawer, the cell card, the monitor model and the Gantt all import (a parity test over `FIRING_ALERT_TYPES` pins it). Fix and Override are no-ops in What-If. Card actions (`_onLevAction`) add: `show-alerts` (focus + `AlertProfileMatches.setFocusTaskIds`, so the Gantt follows the card), `open-table`, `copy-summary`, `goto`/`focus-first`, `diagnose-cell`/`diagnose-worst`, `cal-fix`, `edit-calendar`, `rg-workcenters`, `rg-routing`, `setup-review`/`setup-copy`, `optimize`.

## "View as" vs "Make default"

"View as" calls `AlertProfileMatches.setSessionProfile(id)` — session-only, beats the pref **for this page only** (the pane reads `AlertProfileMatches.view()`; the Gantt, bell, drawer and Orders read `current()`, which ignores the override), until cleared or the plant changes, writes nothing. "Make my default" is the one control that writes the persisted pref (`alertProfileByPlant`: one key holding the whole `{plant: profileId}` map, then clears the session override). Group-by / sort per profile persist in `alertMonitorView`; the Gantt highlight toggle and "Show acknowledged" persist as `alertProfileGanttHighlight` / `alertsShowAcknowledged`.

## Import edges (read before adding an import)

- Direct imports: `platform/*`, `security/session`, `insights/*` (`Alerts`, `Compute`, `Utilization`, `buildPlantSnapshot` from `services.mjs`; the profile, matches, leverage and client modules), `optimization/sandbox` (`Sandbox.active`).
- **Lazy direct imports inside action handlers** (rare paths; the engine <-> services loop makes new top-level edges risky): `../setup/setup-admin.mjs` (`SetupAdmin` is **not** on the `NIMBUS` global — it is reachable only through the boot-time `__NIMBUS_PLANT_ADMIN` bridge that `app.js` never destructures), `../calendar/edit-calendar.mjs` (`EditCalendar.open(line)`), `../master-data/material-grids.mjs` (`MaterialGrids.setQuickFilter`), `../optimization/optimize-ui.mjs` (`OptimizeDialog.open(prefill)`).
- **Through the `NIMBUS` global** (classic-script bridge, typed locally as `AmNimbus`, always optional-chained): `Timeline.gotoLineDay`, `Table._openOverrideModalForId` / `_onPoMatApply`, `App.goto` / `gotoGanttSub` / `gotoMasterSub`, `AlertsUIAdapter.focus` / `showForCell`, `Inspector`, `OptimizerPreview`; `Confidence` (`_score` for the KPI badge, `showBreakdown()` for its click-through).

## The no-Store-event rule

Nothing here emits a Store event: `Store.emit()` bumps the revision and re-renders everything, and the leverage stale guard reads that revision. Derived UI state (profile matches, profile and ack caches) travels on each module's own `subscribe()` fanout (`AlertProfileMatches`, `AlertProfileClient`, `AlertAcksClient`). The pane only listens to Store events, and only while `_active`.

## Scale notes

Everything is plant-scoped (profiles, acks, matches, the leverage input); never fetch or render two plants at once. Each group card lists at most `GROUP_ROW_CAP` (40) rows until "Show all"; **group-by none** is the one unbounded list and renders through `VirtualList` (`_vl`; fixed row height `ROW_H`, a fixed `DIAG_H` diagnose panel). The profile picker is a searchable combobox, never chips.

## Tests

`tests/modules/alert-monitor/*.test.mjs` (model, pane, rows, leverage, leverage-pane, editor, ack modal). On this machine the directory form of `node --test` fails; pass the glob or file names. Browser-only checks still owed (Flatpickr inside the modal focus trap, VirtualList positioning, fr/pt KPI widths at 1,024 px, dark mode) are listed in the spec's deferred section.

## Gotchas

- The ack modal's Flatpickr `minDate` is the plant's today (`Util.dayKey(Util.plantToday(plant))`), not the browser's.
- `app.js` assigns `globalThis.NIMBUS = NIMBUS` after building the namespace: `const NIMBUS` is a script-scope binding, not a `window` property, so without that line every `_nim()` read here would be `undefined` (Go To, Override, Confidence, open-in-table all silently do nothing). `tests/modules/legacy-nimbus-global.test.mjs` pins it.
- `DistributionPane.openParent` exists for a distribution deep link, but nothing in this folder calls it yet.
- The editor compares `profileFromDraft(draft)` with the snapshot taken when the draft was loaded (`baseline`); rail switch / New / Duplicate / Copy ask `Modal.confirm` (`ape.discard_*`) when they differ. A non-409 save or delete failure shows the server message or `ape.err_save_failed`, never `ape.err_stale`.
- "Show all fixes" reveals `LEV_STEP` (20) more cards per click up to `LEV_MAX_RENDER` (100); the KPI "of N" is every alert at the plant (not horizon-limited).
