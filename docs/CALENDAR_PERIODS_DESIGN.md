# Plant Calendar Periods and Gantt Non-Working Shading — Design of Record

| | |
|---|---|
| **Status** | Rev. 1 — plan approved 2026-10-16; implementation in progress on branch `feature/calendar-periods` |
| **Date** | 2026-10-16 |
| **Branch base** | `main` tip `b758345` |
| **Source** | Approved plan (adversarial review folded in 2026-10-16) |

A plant today has exactly one weekly working-hours pattern. The owner needs a plant to run, for example, Monday to Friday 12:00-24:00 for the next six months and then switch to Monday to Thursday 01:00-13:00. This change adds **calendar periods**: dated overrides of the plant's weekly pattern, stored per plant, with an optional end date. Every part of NIMBUS that reads plant working hours (the scheduling engine, the optimizer, the due-date logic, the setup scheduler, Send to SAP) then resolves "which pattern applies on this date" through one shared rule. A new **Calendar** inner tab on Master Data > Plant manages the default week and the periods. Separately, the Gantt gains a quiet grey shading for all non-working time. Both features are plant-level only; machine (line) calendars stay a single weekly pattern.

## 1. Decisions

### 1.1 Owner decisions (settled 2026-10-16, do not re-open)

| # | Decision | Why |
|---|---|---|
| D1 | **Default plus dated overrides.** The existing weekly pattern stays as the plant's always-applying default. A calendar period is `{id, name, valid_from, valid_to or none, work_hours}` and overrides the default for an inclusive date range. No end date means the period never ends. Periods for one plant may not overlap. Dates not covered by a period use the default. | Keeps today's behaviour byte-identical for plants with no periods, and gives the owner the "run this pattern for six months, then switch" case without rebuilding the model. |
| D2 | **The Gantt shades all non-working time**: closed days fully grey, plus off-shift hours on open days (a 12:00-24:00 shift greys 00:00-12:00). Plant pattern only, not per-line hours. | Planners want to see at a glance where the plant is not producing. Per-line shading would roughly triple the item count and vary by line filter. |
| D3 | **New "Calendar" inner tab** on Master Data > Plant, next to General / Optimization / System Settings: default week on the left, a horizontal period timeline strip on the right, the periods list with add/edit modal below. The existing "Plant Working Hours" panel **moves** into this tab. Blackouts stay on General. | Working hours and periods belong together; blackouts are a different concept and stay where planners find them. |
| D4 | **Line hours intersect on the fly** with whichever plant pattern is active on the date. Stored line hours are never changed by a period edit. | A period edit must be reversible by deleting the period; rewriting stored line hours would make it destructive. |
| D5 | **Line clamping uses the widest pattern.** When the default hours are edited, `Store.clampLinesToPlant` trims each line's weekday hours to the **union** of the default and every period's hours for that weekday, not the default alone. Read-time intersection keeps ordinary weeks correct. | Otherwise a period that widens production (say 01:00-13:00 against a 12:00-24:00 default) could never be used by the lines, because they would already have been trimmed away. |
| D6 | **A period save raises alerts only.** Bars stay put, "outside working hours" alerts recompute, planners move, Fix or Optimize. | Same as default-hours and blackout edits today. Moving orders on a calendar edit would surprise planners. |

### 1.2 Orchestrator decisions (reconciling the two design passes)

| # | Decision | Why |
|---|---|---|
| O1 | Periods live on the plant entry: `Store.plants[plant].periods` (camelCase in the Store, snake_case on the wire). `Store.getPlantPeriods(plant)` returns `[]` when absent. | Sandbox enter/exit, undo, the local cache, `snapshotSchedule` (a deep copy of `Store.plants`), `replacePlants`, `_collectAffectedPlants` and the worker `_snap` payload already carry the whole plant entry, so periods ride along with no extra plumbing. |
| O2 | **Period writes are pessimistic**: the Store changes only after the server acknowledges. On a 400 the editor stays open and shows the mapped inline error. In What-If (`Sandbox.active`) edits are local-only and promoted through `flushPlant`, like blackouts. | Overlap and date rejections are routine user errors, not transport failures. "Retry from Store" makes no sense when the Store never held the rejected state. No tombstone ledger is needed. |
| O3 | Period ids are client-generated (`Util.uid('pper')`), like blackout `block_id`. | Matches the delta-write pattern (upserts plus deletes) already used for blackouts. |
| O4 | A period with all seven days closed **is allowed**. A plant shutdown is the most common override. The list summarises it as "Closed all week". | There is no `period_no_days` error. (See the warning in section 6.6 for long all-closed periods.) |
| O5 | One canonical pure helper in `nimbus-compute-core.js` (`activeWorkHours`, `plantWorkHoursOn`, `periodBoundaryKeys`, `validatePlantPeriods`) with a Python twin `master_data.active_work_hours`, both pinned to a shared JSON vector file. | Five independent readers of `workHours[getDay()]` exist today; the helper is the single place the date rule lives. |
| O6 | No `btree_gist` exclusion constraint. Non-overlap is enforced in the application, inside a transaction that first takes a row lock on the plant (`SELECT ... FOR UPDATE`). | Creating the extension on Azure Flexible Server needs an allow-listed parameter and a privileged role; a failure would block the boot-time `ensure_*` step. |
| O7 | Gantt shading items are **ungrouped** vis background items (plant-wide, living in the library's BackgroundGroup, skipped by `_healBackgroundBands`), built as **merged spans**, bounded to the **visible window plus a margin** with hysteresis, and re-diffed on the existing debounced `rangechanged`. | Bounded by what is viewed, not by data extent. Per-day-per-line items would roughly triple the pilot's item count. |

## 2. Data model

New table `plant_calendar_period`. Columns: subnetwork, plant, period id, name, valid-from date, valid-to date (nullable), work hours (JSONB), created-at, updated-at. Primary key is (subnetwork, plant, period id). A foreign key to `plants(subnetwork, plant)` cascades on delete and on update, so removing or renumbering a plant takes its periods with it. Two checks: `valid_to IS NULL OR valid_to >= valid_from`, and `jsonb_typeof(work_hours) = 'object'`. One index on (plant, valid_from). The server normalises `work_hours` to all seven weekday keys (a missing key becomes closed) through the existing `_clean_work_hours`. The weekday keys keep today's convention: 0 is Sunday, each value is `[startHour, endHour]` or null for closed, and an end of 24 means midnight.

The DDL is created by a new `ensure_plant_calendar_periods()` (after `ensure_plant_blackout_table`, near `master_data.py:2608`, same create-if-missing plus commit pattern), called from the `brain.py` lifespan right after line ~305. It is mirrored in `schema.sql` after the `plant_blackout` block (near line 1164) and in the migration `migrations/2026-10-16-3-plant-calendar-periods.sql`.

### 2.1 The active-pattern rule (the one rule everything shares)

`activeWorkHours(default, periods, dateKey)`: the period with `validFrom <= dateKey <= validTo` (no end date means +infinity) wins, with the earliest `validFrom` winning a tie. Otherwise the default applies. `dateKey` is the plant-local `YYYY-MM-DD` of the naive wall-clock date, the same convention `_dayWindow` already uses through `getDay()`. ISO date strings compare lexicographically. The function returns the default **by reference** when no period matches, so the no-periods path is identical to today's.

Worked example. The plant default is Monday to Friday 12:00-24:00. A period "Winter" starts 2027-04-20 with no end date and runs Monday to Thursday 01:00-13:00.

| Date | Weekday | Pattern used | Working window |
|---|---|---|---|
| 2027-04-19 | Monday | default | 12:00-24:00 |
| 2027-04-20 | Tuesday | Winter (first day) | 01:00-13:00 |
| 2027-04-23 | Friday | Winter | closed (Winter has no Friday) |
| 2027-09-06 | Monday | Winter (no end date) | 01:00-13:00 |

The Friday row shows why the rule picks a whole pattern per date and never merges: once a period applies, the default is ignored for that date.

## 3. API

- **`GET /plant-calendar?plant=`** gains `plant_periods: [{id, name, valid_from, valid_to, work_hours}]`, sorted by `valid_from`. It never returns a 500 for this field: a missing table yields `[]`.
- **New `POST /plant-calendar/plant-periods`** with body `{plant, upserts: [...], deletes: [ids]}`. Guarded by `require_api_key` and `require_admin`, and written to the admin audit log (label `calendar.plant_periods_update` in the audit-label map near `brain.py:~752`).
- **Errors.** HTTP 400 with `detail = {code, message, ids}`. Codes: `period_overlap`, `period_dates_invalid`, `period_hours_invalid`, `period_invalid`, `plant_not_mastered`. A plain `ValueError` from the save maps to `plant_not_mastered`.
- **Overlap check scope.** Overlap is checked on the **resulting** set after applying deletes and upserts, and only for pairs involving an upserted id, so pre-existing bad data never blocks a delete.
- **Validation (`_prepare_periods`).** Id at most 64 characters and unique within the request; name stripped, at most 80; dates strict `YYYY-MM-DD` (`date.fromisoformat`); hours through `_clean_work_hours`, then filled for weekdays 0 to 6. Unknown delete ids are ignored.
- **Save sequence (`save_plant_periods`, modelled on `save_plant_blackouts` near line 2857).** Validate first, then in one transaction: resolve the subnetwork, lock the plant row, load the current periods, compute the resulting set, check overlap, delete, insert-or-update, write the audit row, commit. Loading helpers: `load_plant_periods(plant)` (own connection, missing table gives `[]`) and `_load_plant_period_rows(cur, plant)` (probes for the table first, for use inside the Send to SAP transaction). `load_plant_calendar` (near line 2935) adds `plant_periods`.

### 3.1 Pessimistic write semantics (O2)

The Store changes only after the server acknowledges. On failure the editor stays open and the Store is untouched; the pending-edit flag is cleared and the caller receives `{ok: false, status, code, ids, message}`. Before posting, the client runs the same validation locally (`validatePlantPeriods`), so an obvious overlap never leaves the browser. For this write path only, the shared `_post` helper changes: it marks the `'#periods'` reserved key as an hours edit, parses `detail.code/ids/message` from a non-ok response, suppresses the blanket `toast.plant_not_mastered` unless the code really is `plant_not_mastered`, bypasses the generic "unsynced" notice, and returns no fresh body.

### 3.2 What-If behaviour

When `Sandbox.active` (or while hydrating), `savePlantPeriods` changes the Store only and returns `{ok: true, skipped: true}`. Nothing is posted. On promote, `flushPlant` posts every current period plus the deletes (`removed.periods`, computed from the snapshot against the current ids) with label `promote-plant-periods`. The Optimize dialog's promote path (`optimize-ui.mts` near 3045) and its revert handler (near 3091) compute `removed.periods` the same way. A period edit while an optimizer preview is open produces `stale_candidate`, because `validateCandidate` diffs the whole snapshot; that is intended.

### 3.3 Hydration

`CalendarSync._applyConfig` maps wire to Store and sets `plants[plant].periods` **inside the hydrating try block, before the three emits** (near lines 294-296), guarded by the existing `_protectHours(plant, '#periods', ...)` revision machinery (the reserved key cannot collide with a machine code). An absent `plant_periods` (older backend) leaves local periods alone; an empty list clears them. `Store.setPlantPeriods(plant, periods, source)` sorts by `validFrom`, deletes the key when empty, and emits `calendar:change`. Its source must never be `'calendar-sync'`, which `engine.mts:~3117` reserves for the hydration-triggered reconcile.

## 4. Engine rule: every reader resolves the pattern per date

Every reader of plant working hours resolves the pattern for the specific date through `plantWorkHoursOn(plantEntry, date)` in `nimbus-compute-core.js`. `getDay()` appears only in `Core._dayWindow` and `setup-scheduler.localWindow`; no other code may index `workHours` by weekday directly. `periodBoundaryKeys(periods, fromKey, toKey)` returns each `validFrom`, and the day after each non-null `validTo`, within the range. `validatePlantPeriods(periods)` returns `{ok}` or `{ok: false, code, ids}` using the server's codes. Core has no `Util`, so it carries a private `dayKey(date)` (local getters, zero-padded). `unionWeeklyHours(default, periods)` (also in Core, tested) supports D5.

### 4.1 Readers (work package W3 plus the Core change from W2)

| File | Function | What changes |
|---|---|---|
| `frontend/nimbus-compute-core.js` | `Core.workWindow` (~365) | Becomes `_dayWindow(plantWorkHoursOn(plants[plant], date), date)`. The `_wwCache` key is already per day. Exports added at ~1326-1337. |
| `frontend/optimization/engine.mts` | `sourcePlantWorkHours` (882) | Takes `date`; live reads `Core.plantWorkHoursOn(Store.plants[plant], date)`; detached reads the same over `_candidateSnapshot.plants[plant]`, else `candidateDefaultWorkHours()`. New `sourcePlantPeriods(plant)`. |
| `frontend/optimization/engine.mts` | `setupAvailabilityMinutes` (402-415) | Resolves plant hours per day through `plantWorkHoursOn`. |
| `frontend/calendar/calendar-engine.mts` | `workWindow` (284) | Passes `date` through to Core. |
| `frontend/calendar/calendar-engine.mts` | new `Calendar.plantWorkWindow(plant, date)` | Thin wrapper `_dayWindow(Core.plantWorkHoursOn(entry, date), date)`. Plant pattern only, not line intersect plant. Used by the Gantt shading. |
| `frontend/calendar/calendar-engine.mts` | `nextAvailable` (~366-374) | Probes start days `[cur, ...periodBoundaryKeys(...)]`, 7 days each, longest window wins. With no periods the extra list is empty, so cost is unchanged. |
| `frontend/calendar/calendar-engine.mts` | `_backwardFrame` nominal cache, `hasNominalWindow` / `_hasNominalOperatingWindow` | No code change (entries carry their own lo/hi and are built through the date-aware `workWindow`); tests only. |
| `frontend/platform/foundation.mts` | `Util._dueWindowForLine` / `DueCalendarSource` (~28, ~723) | `DueCalendarSource` gains `plantPeriods?`; `app.js` (~311) passes `Store.plants[plant]?.periods ?? null`; the plant window uses `plantWorkHoursOn({workHours: src.plantHours, periods: src.plantPeriods}, date)`. The cache is keyed by `rev` and self-invalidates. |
| `frontend/optimization/setup-scheduler.mts` | new local `plantHoursOn(entry, day)` | Fast path returns `entry.workHours` when there are no periods, so Core-less tests keep working. Otherwise requires `Core.plantWorkHoursOn`; if absent it throws `Error('compute-core-stale')` and never silently uses the default (see section 4.2). |
| `frontend/optimization/setup-scheduler.mts` | `jointWindowForDay` (~2520) | Uses `plantHoursOn`. |
| `frontend/optimization/setup-scheduler.mts` | `walkFreeIntervals` (~2540-2547) | In the non-context branch the plant-hours lookup moves inside the per-day loop. |
| `frontend/optimization/setup-scheduler.mts` | `freeIndexFor` (~2587) | The `withinDay` guard must also cover every `periods[i].workHours`. |
| `frontend/optimization/setup-scheduler.mts` | `hasNominalWindow` (~2768-2784), `dueWindowForDay` (~1305) | Use `plantHoursOn`. `localWindow` is unchanged. |
| `frontend/insights/services.mts` | `_snap` | No code change (it sends the whole plant entry); add `periods?` to its local type and pin with a test. |
| `master_data.py` / `backend/integration/sap_staging.py` | `active_work_hours` (twin); `_working_window_close` (~2252) | Optional `periods` parameter; the back-walk resolves `active_work_hours(plant_hours, periods, d)` per day. The "no calendar" early return now requires no line hours AND no default AND no periods. `queue_send_to_sap` (~2326) loads periods once before the candidate loop. |

Also threaded through the types: `PlantPeriod {id, name, validFrom, validTo: string|null, workHours}` and `PlantCalendarEntry extends CalendarEntry { periods?: PlantPeriod[] }`, updated in `store.mts` (~32, ~59), `types.mts` (~550, ~580), `sandbox.mts:25`, the local `CalendarEntry` copies in `engine.mts:~108`, `services.mts:~56` and `setup-scheduler.mts:~387`, and `nimbus-compute-core.d.ts` (~103).

### 4.2 Stale-core guard

The optimizer worker imports `../nimbus-compute-core.js` without a `?v=` cache-bust (the insights worker has one). A proxy-cached stale Core lacking `plantWorkHoursOn` would throw only when periods exist. `setup-scheduler.plantHoursOn` therefore checks `typeof core.plantWorkHoursOn === 'function'` and otherwise throws `Error('compute-core-stale')`. `optimizer-worker-client` maps that error to its synchronous main-thread fallback (verify the client already falls back on a thrown worker error; if not, add it) and warns once through `ErrorLog.warn`.

### 4.3 Cache hazard

`Utilization._cache` and `Dashboard._matrix7Cache` key on `Store.rev()`. Period writes must therefore go through `Store.setPlantPeriods` (which emits) and never assign `plants[plant].periods` directly outside `_applyConfig`.

### 4.4 Line clamping (D5)

`Store.clampLinesToPlant` (~582-609): for each weekday the clamp bound is the union of the default and every period's hours (minimum start, maximum end; open if any pattern is open), computed by `unionWeeklyHours`. The persist-only-changed-lines behaviour is unchanged. Period saves do not call it (D4).

## 5. Gantt shading

### 5.1 Items

Each shaded span is `{id: 'nonworking-<dayKey(start)>', kind: 'zone', start, end, type: 'background', className: 'nonworking', editable: false}` with **no `group`**, so it lives in the BackgroundGroup and `_healBackgroundBands` skips it. `kind: 'zone'` makes `TimelineNav` ignore it. Ids use the local day key of the span start rather than epoch milliseconds, so a span whose start shifts by merging updates in place; only the cover-edge span changes id on a pan. Hard cap 600 spans, like `GRIDLINE_CAP`. Never remove the DataView `type === 'background'` exemption (~263 of `gantt.mts`).

### 5.2 Span algorithm

New pure module `frontend/scheduling/nonworking-spans.mts`: `buildNonWorkingSpans(fromMs, toMs, windowFor, {closedDaysOnly?, cap?}) -> {spans, truncated}`.

```
run = null                                  // start of the open grey run
for day in local midnights from fromMs to toMs:   // advance with setDate(+1), never +86_400_000 (DST)
    next = day + 1 calendar day
    win  = windowFor(day)                   // degenerate window counts as closed
    if closedDaysOnly and win is partial: win = full day
    if win is closed:
        run = run ?? day                    // closed day extends the run
    else:
        if win.start > day:
            emit [run ?? day, win.start]    // grey head of the day (merges with a prior run)
            run = null
        else if run:
            emit [run, day]; run = null     // run closes at midnight
        if win.end < next:
            run = win.end                   // grey tail starts at shift end
if run: emit [run, toMs]
stop at cap; set truncated
```

Results: a closed weekend is one span Saturday 00:00 to Monday 00:00; Friday 18:00 to Monday 06:00 merges into one; a 12:00-24:00 shift yields `[00:00, 12:00]` per day with no tail. `windowFor` is `Calendar.plantWorkWindow(plant, day)` (plant pattern, not line intersect plant), after `Store.ensurePlant(plant)`.

### 5.3 Single-owner structure

One pure `Timeline._nonWorkingDesired(rangeMs)` builds the items. `Timeline._nwRange` is set only by `_syncNonWorking` (the debounced `rangechanged` path) and is seeded on `init` and on plant switch from the current window. `_rebuildPass` calls the same function with the same `_nwRange` and places the result as the **first** block of `desired` (before the past-zone block near 1099), so its full diff never removes items the pan path added. `_syncNonWorking` diffs only `nonworking-*` ids, inside `_suppressEvents` (the `Interaction` listener is gated by it), as one batched remove/update/add. The rebuild diff puts every existing id into `toUpdate` without a field compare, so a changed `end` reaches the DOM. `PerfMonitor` records `Timeline.rebuild.nonworking` and `Timeline.nonworking.sync`. No new timer; the ticker is untouched. Existing `calendar:change`, `plant:selected` and `tasks:bulk` rebuild triggers suffice; ids are not plant-scoped, so a plant switch's diff removes stale spans.

### 5.4 Bounding and hysteresis

`_syncNonWorking(force)` reads `getWindow()`. Unless forced, it returns when the window is inside `[cover.from + margin/2, cover.to - margin/2]`. Margin is `max(windowSpan, 7 days)` on each side. When the window is wider than 90 days it builds with `closedDaysOnly`. It is called from the debounced `rangechanged` handler (~312) before `_refreshViewNow()`.

### 5.5 CSS

Next to `.vis-item.day-gridline` in `styles.css`:

```css
.vis-item.nonworking { background: rgba(93,113,134,0.10) !important; border: none !important; pointer-events: none !important; }
body.dark .vis-item.nonworking { background: rgba(144,162,184,0.08) !important; }
```

It must read clearly lighter than `.past-zone` (`rgba(150,150,160,.42)`). Add `z-index: 0` only if the browser check shows it painting above grouped bands. Ungrouped items paint beneath grouped zone washes; items painted after existing gridlines may sit above them, which is cosmetic at 10% alpha; if visible, raise the gridline's z-index rather than reorder.

### 5.6 Minimap guard (required)

`TimelineNav._items.on('*')` cannot look up removed items and always repaints on `remove`. Extend `_wireItemsSubscription` to read `props.oldData` and skip when every removed item is `kind: 'zone'`, otherwise every pan re-diff repaints the minimap. Leave the minimap's own closed-day shading alone (it goes through the now date-aware `Calendar.workWindow`).

### 5.7 What not to touch

Never set `position`, `top` or `height` on `.vis-item` CSS. Never remove the `type === 'background'` DataView exemption. Do not group the shading items. Do not add a timer or change the ticker. Do not make shading per-line.

## 6. UI: the Calendar inner tab

### 6.1 Layout

```
Master Data > Plant      [General] [Calendar] [Optimization] [System Settings]

+-----------------------------+  +--------------------------------------------+
| Default week                |  | Period timeline                            |
|  Sun  Mon  Tue  Wed ...     |  |  Apr    May    Jun    Jul    Aug     Sep   |
|  (7 day pills, stack as     |  |  [==Peak===========][Winter=============>> |
|   rows in this column)      |  |        | Today                             |
+-----------------------------+  +--------------------------------------------+
+-------------------------------------------------------------------------------+
| Calendar periods   2 periods                                  [ Add period ]  |
| Peak    [Active]    2026-10-16 -> 2027-04-19   Mon-Fri 12:00-24:00   Edit  Del |
| Winter  [Upcoming]  2027-04-20 -> no end date  Mon-Thu 01:00-13:00   Edit  Del |
| Blackouts are managed on General > Plant Blackouts.                           |
+-------------------------------------------------------------------------------+
```

The grid is `.plant-cal-grid` (`minmax(300px,380px) 1fr`) and collapses to one column under 780px. The moved `#plant-hours-panel` keeps its ids so `_renderHours` and `Plant.render` keep working; its header becomes "Default week". The `#plant-periods-timeline-panel` holds `#plant-periods-timeline`. The full-width `#plant-periods-panel` holds `#plant-periods-count`, `#plant-add-period-btn`, `#plant-periods-list` and a `.panel-hint` pointing to General > Plant Blackouts. The pane is `#plant-tab-calendar.cal-scroll`, the fourth `button.sub-subtab[data-plant-tab="calendar"]` in the nav at `index.html:~1682` (order General / Calendar / Optimization / System Settings). General loses its `.plant-two-col` wrapper, so Blackouts runs full width. `.admin-subtabs` is `flex-wrap: wrap`, so a fourth tab wraps to a second row when narrow rather than clipping.

### 6.2 Period row anatomy

Do not reuse `.block-row` for period rows: `.block-row .reason { flex-shrink: 0 }` would spill long names (maxlength 60), and six cells in a plain flex row wrap unpredictably. A new `.period-row` CSS grid: `minmax(120px,1.2fr) auto minmax(140px,1fr) minmax(0,2fr) auto auto`, with `min-width: 0` and ellipsis on name and summary and the full text in `title`. Under 780px it collapses to two lines (name, badge, actions / range, summary). Cells:

1. Name.
2. Status badge: `.line-badge` plus new `.badge-ok` (Active), `.badge-info` (Upcoming), `.badge-muted` (Past). Status comes from `Util.dayKey(Store.plantNow(plant) ?? new Date())` by string compare.
3. Date range in mono, shown through `Util._fmtDatePref(date)` (the per-user date-format preference); ISO stays on the wire only. For example `2026-10-01 -> 2026-11-30` or `-> no end date` in the user's format.
4. Week summary in mono from `summarizeWeek`: groups consecutive days with equal hours in Monday-to-Sunday order, end 24 shown `24:00`, "Closed all week" for none; the first two groups plus "+N", full text in `title`.
5. Edit (`.btn.btn-ghost.sm`).
6. Delete (`.icon-btn`) through `Modal.confirm` with tone danger.

Empty state uses `.empty-state`. The no-plant state reuses `ui.select_plant_hours` and disables Add. No colour side stripes.

### 6.3 Timeline strip

Pure HTML and CSS from `buildPeriodStrip(periods, todayKey)`. Axis from `min(today - 30 days, first validFrom)` to `max(last validTo, today + 365 days)`, capped at `today + 2 years` so one far-future period cannot crush the present (a period beyond the cap is drawn clipped at the edge with its `title` intact). UTC day indices give the percentages. A neutral track shows the default week. Segments are `<button class="period-seg period-seg-{active|upcoming|past}" data-action="edit-period" data-id>` with `min-width: 6px`, an ellipsised label and a `title` of name plus range. An open-ended segment runs to 100% with a trailing fade and an arrow. A 2px `--accent` today marker carries a mono "Today" tag. Month labels sit above the track and the "Today" tag below it so they never collide. Labels thin with a container query (every other label under 600px container width; quarters when the axis exceeds 700 days). Month names use `Intl.DateTimeFormat(<active UI locale>, {month: 'short'})`. The strip is read-only; a click opens the editor. Fills only: Active `--accent` on white, Upcoming `--info-soft` with an `--info` border, Past `--bg-strong` on `--fg-faint`.

### 6.4 Wiring (no inline handlers)

`_wireStaticHandlers` adds the Add listener; one delegated click listener each on the list and strip hosts reads `closest('[data-action]')`. This keeps the legacy-surface ratchet from growing. `admin-ui.mts gotoTab` carries the tab list as two literals (~358 and ~364): add `'calendar'` to both and dispatch `CalendarPeriodsUI.render()`. `Plant.render()` calls it after `_renderBlocks()` (covers plant switch). A module-level `Store.subscribe` on `calendar:change` is gated by `getActiveTabResolvers()` plus `#plant-tab-calendar` not being hidden; the DOM gate avoids an admin-ui import cycle.

New files: `frontend/calendar/calendar-periods.mts` (pure: `periodStatus`, `summarizeWeek`, `validatePeriodDraft`, `buildPeriodStrip`) and `frontend/calendar/calendar-periods-ui.mts` (`CalendarPeriodsUI {init, render, openModal(id?), save, remove}`). Edited: `index.html`, `admin-ui.mts`, `edit-calendar.mts`, `styles.css`, the five locale files, and `.gitignore` (the new compiled `.mjs` paths for both work packages).

### 6.5 Editor modal

The editor reuses `#modal-edit-calendar` as a third mode: `EditCalendar.openPeriod(plant, id?)`, `_mode: 'line' | 'plant' | 'period'`. A new `#cal-edit-period-fields` block sits above Quick Presets inside `.cal-edit-body` (the modal is `max-height: min(92vh, 100dvh - 32px)`; header and footer pin, the body scrolls):

- Name (`#cal-period-name`, maxlength 60, autofocus).
- Valid from and Valid to: two **Flatpickr date-only** pickers following `orders.mts:~2731` (`#print-start` / `#print-end`): `Y-m-d`, `altFormat 'M j, Y'`, `altInputClass 'input'`. Flatpickr popups append to `body`, so they behave as the existing time pickers do.
- "No end date" checkbox on **its own row** under the date pair, so the two date fields stay level. Checking it disables Valid to and greys its alt input.
- A `.field-error` element per field.

A new period seeds its hours from the plant default, `valid_from` = plant-local today (or the day after the latest existing `valid_to`, if later), `valid_to` = from + 6 days, and No end date **unchecked**. The `.cal-copy-plant-btn` is hidden and the footer button reads "Save period". `save()` is refactored into `_collectWorkHours()` plus a per-mode branch; period mode must **not** touch `NIMBUS.Plant._persistPlantHours` or `clampLinesToPlant`. The Save button shows a busy state during the pessimistic POST (disabled plus `aria-busy`) to prevent double submit and is re-enabled on any response.

### 6.6 Validation

`validatePeriodDraft` runs on Save and live afterwards. It shows inline `.field-error` text with `aria-invalid` and `.input.is-invalid` (full border in `--err`) for: name required, from required, to before from, and overlap, which **names the other period and its range**. Save stays enabled. Server 400 codes map to inline or toast text (`period_overlap`, `period_dates_invalid`, `period_hours_invalid`, `period_invalid`); the modal stays open on rejection (O2). A non-blocking **warning** (`warn.period_all_closed_long`) appears when a period has no open day AND (has no end date OR spans more than 90 days): the backward walk looks back 90 and then 400 days, so an open-ended all-closed period makes every placement on that plant refuse with `no_operating_window`.

### 6.7 Midnight (24:00)

The model already stores 24, and `_endHours` reads a picked 00:00 end as 24. Fixes: the badge shows "12h - to midnight" when the end picker reads 00:00; a helper line says "To run until midnight, set the end time to 12:00 AM."; and the **load direction** is fixed: `_populate` and `copyFromPlant` feed `"24:00"` to Flatpickr through `Util.hoursToTimeString(24)`, and a new `_toTimeString(h, isEnd)` returns `'00:00'` for 24 (tested). There is no separate 24:00 picker option.

### 6.8 i18n

All text goes through `data-i18n` / `t()` in all five locales (`en`, `de`, `es`, `fr`, `pt`); the parity tests gate it. Keys: `tab.calendar`, `ui.default_week`, `ui.period_timeline`, `ui.period_timeline_hint`, `ui.calendar_periods`, `ui.period_count`, `ui.period_blackout_pointer`, `btn.add_period`, `btn.save_period`, `empty.no_periods`, `ui.today`, `ui.period_active`, `ui.period_upcoming`, `ui.period_past`, `ui.no_end_date`, `ui.week_closed`, `ui.week_closed_all`, `modal.period_title`, `ui.period_name`, `ph.period_name`, `ui.valid_from`, `ui.valid_to`, `ui.cal_to_midnight`, `ui.cal_midnight_hint`, `err.period_name_required`, `err.period_from_required`, `err.period_to_before_from`, `err.period_overlap`, `toast.period_overlap`, `toast.period_dates_invalid`, `confirm.delete_period_title`, `confirm.delete_period`, `btn.delete_period`, and `warn.period_all_closed_long`. While in the modal, also translate its existing hardcoded English (title, "Plant {name}", Quick Presets and chips, Weekly Schedule, Copy from Plant schedule, Cancel, Save Changes, the close aria-label).

### 6.9 UI-fit rules

- **Measure before finalising layout (owner rule).** Longest strings across the five locales for panel headers, the Add/Save/Delete buttons, the status badges and the period row, at the narrowest supported viewport. Measure es and pt tab labels ("Configuración del sistema", "Configurações do sistema"), which are longer than German. Confirm the one-column collapse under 780px and no horizontal scroll.
- No inline handlers (`onclick`, `NIMBUS.` in HTML) in the new markup; delegated listeners only. The Edit Calendar modal's 14 pre-existing inline handlers are out of scope.
- Flatpickr only for date and time inputs.
- No colour side stripes on rows or segments.
- The seven day pills in the 300-380px column wrap to two rows without a scoped override (`.line-hours-pills` wraps with `flex: 1 0 78px`); the override is optional. `.panel-head` already wraps, so header, count hint and Add button wrap cleanly.

## 7. Verification

### 7.1 Automated (per package, then full at the end)

- `npm run build && npm run typecheck && npm run lint`
- `node --test tests/js/compute-core.test.js tests/modules/calendar/*.test.mjs tests/modules/scheduling/gantt.test.mjs tests/modules/scheduling/nonworking-spans.test.mjs tests/modules/master-data/admin-ui.test.mjs tests/modules/optimization/engine.test.mjs tests/modules/optimization/sandbox.test.mjs tests/modules/setup-scheduler.test.mjs tests/modules/insights/compute-transport.test.mjs tests/js/locale-keys.test.js tests/modules/locale-completeness.test.mjs`
- `npm run check:legacy-surface` (no growth) and `npm run check:static-assets`
- `python -m pytest tests/test_calendar_persistence_workflows.py tests/test_plant_calendar_routes.py tests/test_sap_staging.py tests/test_plant_period_twin.py tests/test_schema_idempotent.py -q` against **local** Postgres with `NIMBUS_TEST_DB=1` (the suite refuses to collect against the Azure host by design; if Postgres is down locally, report that rather than skipping).

New test coverage by layer:

- **Core helper:** day before and on `valid_from`; on and after `valid_to`; no end date; no periods; a closed day in a period beating an open default; overlap tie where the earliest wins; default returned by identity.
- **`validatePlantPeriods`:** adjacent periods OK; a shared day overlaps; an open-ended period followed by a later one overlaps.
- **`calendar-engine`:** backward walk and `nextAvailable` crossing a boundary.
- **`setup-scheduler`:** indexed versus plain walk across a boundary; the `freeIndexFor` guard.
- **`compute-transport`:** the payload carries `periods`.
- **`calendar-sync`:** hydration (before the emit, `[]` clears, undefined leaves alone, stale GET after ack); pessimistic save; local overlap gives no POST; Sandbox changes the Store only; `flushPlant` deletes.
- **`sandbox`:** discard restores periods.
- **foundation:** `sapDueDate` with a period.
- **`calendar-periods` (pure):** status, summary, validation, strip geometry.
- **`calendar-periods-ui`:** rows, badges, empty and no-plant states, delegated edit and delete, no `onclick` or `NIMBUS.` in HTML.
- **`edit-calendar`:** period save, the 24 load fix, the "to midnight" badge.
- **`nonworking-spans`:** weekend merge, overnight merge, 12-24 head only, `closedDaysOnly`, DST days, cap, pattern flip mid-range.
- **`gantt`:** `_syncNonWorking` keeps stable ids on a small pan.
- **Python:** save, load and round-trip; overlap on insert and edit; same-request delete plus upsert; structured 400; cascade on plant delete; routes return 401; SAP close with a period; twin vectors.
- Update the exact-equality unknown-plant hydration assertion (`test_calendar_persistence_workflows.py:~169`) to include `plant_periods: []`.

### 7.2 Browser (Chrome against local `uvicorn brain:api`, the owner's session)

1. **Master Data > Plant > Calendar.** The default week renders in the left column. Add period "Peak" Monday to Friday 12:00-24:00 valid today to +6 months. Add "Winter" Monday to Thursday 01:00-13:00 from the day after, with no end date. The strip shows both (the second open-ended with a fade) and the badges read Active and Upcoming. Attempt an overlapping third: the inline error names "Peak". Edit and delete flows work. Plant switch re-renders. The General tab shows Blackouts full width.
2. **Gantt.** Weekends are one grey block with no midnight seams. 00:00-12:00 is grey on the 12-24 shift days. After the switch date 13:00-01:00 is grey. The grey sits **under** the past-zone, the alert and frozen horizon bands, the blackout hatch (visible through gaps) and alert cells. Pan at 1-week and 1-day zoom with no gaps or flicker. Zoom past 90 days gives the coarse mode. Dark mode is quiet but visible. The line filter changes nothing (plant-wide).
3. Drop an order whose backward walk crosses the switch date and confirm the derived start uses both patterns. Run Optimize once on that plant and confirm no placement lands in grey time.
4. `PerfMonitor` `Timeline.rebuild` at pilot scale (24 lines, about 300 orders) before versus after: shading cost is a small fraction.

## 8. Deployment note

The migration is `migrations/2026-10-16-3-plant-calendar-periods.sql`. Its header comments must avoid the words ALTER, DROP, DELETE, UPDATE, TRUNCATE, RENAME, GRANT and REVOKE. The foreign key's cascade clause itself still matches the destructive-word filter in the `promote-azure` skill (`apply-migrations.ps1:78`), so the deploy step needs `-Only 2026-10-16-3 -AllowDestructive`. Record this in the migration header and in `docs/DEPLOYMENT.md`. Order matters: **apply the migration first, then roll the image**. The new code tolerates a missing table (`UndefinedTable` gives `[]`), but the pilot should not run the new image ahead of its table. Deploy via the `promote-azure` skill, never `schema.sql`; when verifying, cache-bust the request. Deploying is not part of this plan's execution.

## 9. Out of scope / owed

- Deploy via `promote-azure` (section 8).
- Machine-level periods, copy-between-plants, drag-editing on the strip, a `daterange` exclusion constraint once `btree_gist` is allow-listed, and replacing the Edit Calendar modal's 14 pre-existing inline handlers.
- Known residuals unchanged by this work: OQ46 (window math without `plantTz` reads viewer-local getters); the plant 1008 timezone data fix; line hours already clamped to the default cannot exceed a wider period's hours until the planner edits them (surface as a hint in the Calendar tab if cheap).
- Documentation updates owed with the code: `frontend/calendar/CLAUDE.md` and its `AGENTS.md` twin (endpoint list, new module files, period semantics, pessimistic-write note), `frontend/scheduling/CLAUDE.md` (shading block, `nonworking-spans.mts`), `frontend/master-data/CLAUDE.md` (Calendar tab pointer), `docs/DEPLOYMENT.md` (the destructive-flag step and why).

## 10. Execution model

Branch `feature/calendar-periods` from the `main` tip (`b758345`) in a `.claude/worktrees` worktree. The orchestrator does not write code; Sonnet subagents implement each work package and Sonnet reviewers verify the integration-critical ones. Packages: W1 schema, migration and backend; W2 core helper, types, Store, CalendarSync; W3 engine threading; W4 Calendar tab and editor; W5 Gantt shading; W6 docs. Order: W1 and W2 in parallel (separate worktrees), W3 needs W2, W4 and W5 need W2 and W3 compiled, W6 last (this document first). Autonomous run with no review pauses except a truly large deviation. Test-first per package. Implementers append their own progress lines.

## 11. Decision log

Implementers append gap decisions made during the run.

| Date | Decision | Why | Cost if wrong |
|---|---|---|---|
| | | | |

## Appendix A. Context

**Why this change.** Plants change shift patterns through the year and the owner needs the plan to follow: a plant runs one pattern for a stretch, then another, and orders placed across the switch date must be scheduled, alerted and sent to SAP against the pattern that is actually in force on each day. Today the only choice is to overwrite the single weekly pattern, which silently rewrites the meaning of every already-placed order. Planners also had no visual cue for non-working time on the Gantt, so a bar sitting in an off-shift hour looked the same as one in a shift.

**Who asked.** The owner, decided 2026-10-16 (D1-D4), with D5 and D6 settled in the same day's review.

**What it builds on.** The plant weekly pattern (`plants.work_hours`) and `_clean_work_hours`; the plant blackout table and its delta-write pattern (`save_plant_blackouts`, client-generated ids, `flushPlant` promotion); the calendar capacity-math engine and its mirror in `nimbus-compute-core.js`; the finish-anchored backward walk (`docs/BACKWARD_SCHEDULING_MIGRATION.md`); CalendarSync hydration and the revision guard; the Sandbox/What-If snapshot machinery; the Gantt's vis background-item handling (gridlines, past-zone, `_healBackgroundBands`); the Send to SAP window logic (`docs/SAP_STAGING_DESIGN.md`).

## Appendix B. Things learned along the way

Start of the list: the findings of the adversarial review run on 2026-10-16 against live code, phrased as lessons. Implementers append below.

**Engine and optimizer**

- Every weekday-keyed read of plant hours was found by searching for `getDay()`: it appears only in `Core._dayWindow` and `setup-scheduler.localWindow`. Searching for the call is a cheap way to prove a reader list complete.
- Caches that look dangerous were safe because they are per-date or per-run (`_wwCache`, the `workWindow` memo, `rc.nominal` with its own lo/hi, `freeIndexFor`, `_dueWindowForLine` by rev). The ones that are not date-keyed (`Utilization._cache`, `Dashboard._matrix7Cache`) key on `Store.rev()`, so a write that does not emit a store change is invisible to them. Period writes must go through `Store.setPlantPeriods`.
- `snapshotSchedule` deep-copies `plants` and `validateCandidate` diffs whole snapshots, so a period edit during an open preview shows up as `stale_candidate`. Unknown keys such as `periods` survive `Util.clone`, `replacePlants`, the local cache and `_sameSnapshotValue`, which is why putting periods on the plant entry costs no plumbing.
- Both worker realms expose `globalThis.NimbusComputeCore`, but the optimizer worker's import has no cache-bust query. A proxy-cached stale Core would fail only for plants that have periods, so the reader must throw `compute-core-stale` rather than fall back to the default pattern silently.
- Core has no `Util`; a date-key helper it needs must be private to it.
- A plant with only closed days in a long or open-ended period makes the backward walk refuse every placement (`no_operating_window`), because it looks back only 90 then 400 days. Warn, do not forbid, since a shutdown is a legitimate period.
- Clamping line hours to the default alone would make a widening period unusable by lines; clamping must use the union of all patterns (D5).
- A period save must not move bars (D6); the hydration-triggered reconcile only derives rows the server flagged or never placed, so a non-sync emit source is essential.

**Gantt**

- Two code paths that both add and remove the same items (the pan path and the full rebuild) will fight unless one function builds the items and one variable holds the range they are built for. Hence the single owner (`_nonWorkingDesired`, `_nwRange`).
- The rebuild diff puts every existing id into `toUpdate` with no field compare, so a changed `end` does reach the DOM; ids keyed by local day key of the span start let a merged span update in place instead of churning.
- `TimelineNav` repaints the minimap on every `remove` because it cannot look up removed items; without reading `props.oldData` and skipping zone-only removals, every pan re-diff would repaint it.
- Ungrouped background items paint beneath grouped zone washes and `_healBackgroundBands` skips them; items added after existing gridlines may paint above them, which is cosmetic at this alpha.

**UI fit**

- `.admin-subtabs` wraps and its buttons do not shrink, so a fourth tab wraps rather than clipping; the es and pt labels are the long ones to measure.
- `.cal-edit-modal` pins header and footer and scrolls the body, so the period block belongs inside `.cal-edit-body`; Flatpickr popups already escape the modal.
- `.block-row .reason { flex-shrink: 0 }` spills long names, so period rows need their own grid. Dates are shown through the user's date-format preference, never raw ISO.
- Month labels and the "Today" tag must sit on opposite sides of the track to avoid collisions; thin labels with a container query; cap the axis so one far-future period cannot crush the present.
- "No end date" belongs on its own row so the two date fields stay level; a pessimistic POST needs a busy state on Save to prevent a double submit.
- `.panel-head` and `.line-hours-pills` already wrap, so the scoped override planned for the narrow column is optional.

**Deployment**

- The migration's foreign-key cascade clause matches the promote skill's destructive-word filter even though nothing is destroyed, so this migration needs `-Only 2026-10-16-3 -AllowDestructive`. Keep the destructive words out of the header comments for the same reason.
- Creating `btree_gist` on Azure Flexible Server needs an allow-listed parameter and a privileged role, and a failure there would block boot; application-side overlap checking under a row lock avoids the dependency.

*(Implementers: append further lessons below this line, dated.)*
