# Plant Calendar Periods and Gantt Non-Working Shading — Design of Record

| | |
|---|---|
| **Status** | Rev. 2 — implemented on `feature/calendar-periods` (2026-10-16); browser verification and DB-backed pytest owed |
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
| D3 | **New "Calendar" inner tab** on Master Data > Plant, next to General / Optimization / System Settings: default week and a horizontal period timeline strip stacked full width, then the periods list with add/edit modal, then Plant Blackouts. The existing "Plant Working Hours" panel **moves** into this tab. *(Rev. 2026-10-19: blackouts moved here from General, are editable, and show as red marks on the timeline; see section 11.)* | Working hours, periods and blackouts all decide when the plant can run, so planners tune them in one place; the timeline shows how they interact. |
| D4 | **Line hours intersect on the fly** with whichever plant pattern is active on the date. Stored line hours are never changed by a period edit. | A period edit must be reversible by deleting the period; rewriting stored line hours would make it destructive. |
| D5 | **SUPERSEDED 2026-10-19 (see section 4.4): there is no clamp.** *(Original text:)* **Line clamping uses the widest pattern.** When the default hours are edited, `Store.clampLinesToPlant` trims each line's weekday hours to the **union** of the default and every period's hours for that weekday, not the default alone. Read-time intersection keeps ordinary weeks correct. | Otherwise a period that widens production (say 01:00-13:00 against a 12:00-24:00 default) could never be used by the lines, because they would already have been trimmed away. |
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

Every reader of plant working hours resolves the pattern for the specific date through `plantWorkHoursOn(plantEntry, date)` in `nimbus-compute-core.js`. `getDay()` appears only in `Core._dayWindow` and `setup-scheduler.localWindow`; no other code may index `workHours` by weekday directly. `periodBoundaryKeys(periods, fromKey, toKey)` returns each `validFrom`, and the day after each non-null `validTo`, within the range. `validatePlantPeriods(periods)` returns `{ok}` or `{ok: false, code, ids}` using the server's codes. Core has no `Util`; it reuses its own existing exported `dayKey(date)` (local getters, zero-padded) rather than a second private copy. `unionWeeklyHours(default, periods)` (also in Core, tested) supports D5.

### 4.1 Readers (work package W3 plus the Core change from W2)

| File | Function | What changes |
|---|---|---|
| `frontend/nimbus-compute-core.js` | `Core.workWindow` (~365) | Becomes `_dayWindow(plantWorkHoursOn(plants[plant], date), date)`. The `_wwCache` key is already per day. Exports added at ~1326-1337. |
| `frontend/optimization/engine.mts` | `sourcePlantWorkHours` (882) | Takes `date`; live reads the plant entry's pattern for that date, detached reads the same over `_candidateSnapshot.plants[plant]`, else `candidateDefaultWorkHours()`. Both go through the exported `resolvePlantHoursOn(entry, date)` (no entry gives undefined; no periods returns `entry.workHours` by reference with no Core call; periods without `Core.plantWorkHoursOn` throw `compute-core-stale`). New `sourcePlantPeriods(plant)` returns a shared frozen `NO_PERIODS` array when the plant has none. |
| `frontend/optimization/engine.mts` | `setupAvailabilityMinutes` (402-415) | Resolves plant hours per day through `plantWorkHoursOn`. |
| `frontend/calendar/calendar-engine.mts` | `workWindow` (284) | Passes `date` through to Core. |
| `frontend/calendar/calendar-engine.mts` | new `Calendar.plantWorkWindow(plant, date)` | Thin wrapper `_dayWindow(Core.plantWorkHoursOn(entry, date), date)`. Plant pattern only, not line intersect plant. Used by the Gantt shading. |
| `frontend/calendar/calendar-engine.mts` | `nextAvailable` (~366-374) | Probes start days `[cur, ...periodBoundaryKeys(...)]`, 7 days each, longest window wins. With no periods the extra list is empty, so cost is unchanged. If the plant has periods but Core lacks `periodBoundaryKeys` it throws `compute-core-stale` rather than a TypeError. |
| `frontend/calendar/calendar-engine.mts` | `_backwardFrame` nominal cache, `hasNominalWindow` / `_hasNominalOperatingWindow` | No code change (entries carry their own lo/hi and are built through the date-aware `workWindow`); tests only. |
| `frontend/platform/foundation.mts` | `Util._dueWindowForLine` / `DueCalendarSource` (~28, ~723) | `DueCalendarSource` gains `plantPeriods?`; `app.js` (~311) passes `Store.plants[plant]?.periods ?? null`; the plant window uses `plantWorkHoursOn({workHours: src.plantHours, periods: src.plantPeriods}, date)`. The cache is keyed by `rev` and self-invalidates. |
| `frontend/optimization/setup-scheduler.mts` | new local `plantHoursOn(entry, day)` | Fast path returns `entry.workHours` when there are no periods, so Core-less tests keep working. Otherwise requires `Core.plantWorkHoursOn`; if absent it throws `Error('compute-core-stale')` and never silently uses the default (see section 4.2). Two test seams were added following the file's `...ForTest` convention: `hasNominalWindowForTest` and `plantHoursOnForTest`. |
| `frontend/optimization/setup-scheduler.mts` | `jointWindowForDay` (~2520) | Uses `plantHoursOn`. |
| `frontend/optimization/setup-scheduler.mts` | `walkFreeIntervals` (~2540-2547) | In the non-context branch the plant-hours lookup moves inside the per-day loop. |
| `frontend/optimization/setup-scheduler.mts` | `freeIndexFor` (~2587) | The `withinDay` guard must also cover every `periods[i].workHours`. |
| `frontend/optimization/setup-scheduler.mts` | `hasNominalWindow` (~2768-2784), `dueWindowForDay` (~1305) | Use `plantHoursOn`. `localWindow` is unchanged. |
| `frontend/insights/services.mts` | `_snap` | No code change (it sends the whole plant entry); add `periods?` to its local type and pin with a test. |
| `master_data.py` / `backend/integration/sap_staging.py` | `active_work_hours` (twin); `_working_window_close` (~2252) | Optional `periods` parameter; the back-walk resolves `active_work_hours(plant_hours, periods, d)` per day. The "no calendar" early return now requires no line hours AND no default AND no periods. `queue_send_to_sap` (~2326) loads periods once before the candidate loop. |

Also threaded through the types: `PlantPeriod {id, name, validFrom, validTo: string|null, workHours}` and `PlantCalendarEntry extends CalendarEntry { periods?: PlantPeriod[] }`, updated in `store.mts` (~32, ~59), `types.mts` (~550, ~580), `sandbox.mts:25`, the local `CalendarEntry` copies in `engine.mts:~108`, `services.mts:~56` and `setup-scheduler.mts:~387`, and `nimbus-compute-core.d.ts` (~103).

### 4.2 Stale-core guard

The optimizer worker imports `../nimbus-compute-core.js` without a `?v=` cache-bust (the insights worker has one). A proxy-cached stale Core lacking `plantWorkHoursOn` would throw only when periods exist. `setup-scheduler.plantHoursOn` therefore checks `typeof core.plantWorkHoursOn === 'function'` and otherwise throws `Error('compute-core-stale')`. `optimizer-worker-client` maps that error to its synchronous main-thread fallback and warns once per session through `ErrorLog.warn`. The client did **not** previously fall back on a thrown worker error, so the fallback was added: a worker response whose error contains `compute-core-stale` releases the worker and resolves with `(options.syncEvaluator ?? evaluateSchedule)(snapshot, request)`; any other worker error still rejects. The guard sits in `engine.mts`'s exported `resolvePlantHoursOn` (used by `sourcePlantWorkHours` and `setupAvailabilityMinutes`) as well as in `setup-scheduler.plantHoursOn` and `Calendar.nextAvailable`; before that fix the engine called `Core.plantWorkHoursOn` directly and a stale worker core threw a TypeError even for plants with no periods. Only `plantWorkHoursOn` and `periodBoundaryKeys` are stale-guarded; other Core helpers are main-thread only or are reached through `workWindow`.

### 4.3 Cache hazard

`Utilization._cache` and `Dashboard._matrix7Cache` key on `Store.rev()`. Period writes must therefore go through `Store.setPlantPeriods` (which emits) and never assign `plants[plant].periods` directly outside `_applyConfig`.

### 4.4 Line clamping (D5): superseded 2026-10-19 by machine calendar inheritance

**Superseded.** `Store.clampLinesToPlant` is deleted and a plant save writes the plant row only. The clamp also narrowed machines that had no calendar of their own and POSTed the narrowed copies as `machine_calendar` rows, so plant 7pm to 5pm to 7pm left every machine pinned at 5pm. The rule now: **no machine row = the machine follows its plant; an inherited machine is all-day and the plant bounds it; an override keeps its own hours and the per-date intersection caps it.** See `frontend/calendar/CLAUDE.md`, "Machine calendar inheritance". The original text follows for the record.


`Store.clampLinesToPlant` (~582-609): for each weekday the clamp bound is the union of the default and every period's hours (minimum start, maximum end; open if any pattern is open), computed by `unionWeeklyHours`. The persist-only-changed-lines behaviour is unchanged. Period saves do not call it (D4).

## 5. Gantt shading

### 5.1 Items

Each shaded span is `{id: 'nonworking-<dayKey(start)>' (suffix `-t` when the span starts at an off-shift tail rather than at local midnight, so a day's head and tail never collide), kind: 'zone', start, end, type: 'background', className: 'nonworking', editable: false}` with **no `group`**, so it lives in the BackgroundGroup and `_healBackgroundBands` skips it. `kind: 'zone'` makes `TimelineNav` ignore it. Ids use the local day key of the span start rather than epoch milliseconds, so a span whose start shifts by merging updates in place; only the cover-edge span changes id on a pan. Hard cap 600 spans, like `GRIDLINE_CAP`. Never remove the DataView `type === 'background'` exemption (~263 of `gantt.mts`).

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

`_syncNonWorking(force)` reads `getWindow()`. Unless forced, it returns when the window is inside `[cover.from + margin/2, cover.to - margin/2]`. Margin is `max(windowSpan, 7 days)` on each side. When the covered range is wider than 90 days it builds with `closedDaysOnly`. At the current `zoomMax` (30 days) the covered range is window + 2 x max(window, 7 days) <= 90 days, so this coarse mode **cannot trigger today**; it is kept deliberately as a guard for a future larger `zoomMax`. There is no separate coarse flag: granularity is derived from the stored `_nwRange` span under that same > 90 day rule, and the early return also requires that the granularity the new window would produce equals the stored one, so a zoom across the threshold rebuilds even while the window sits inside the band (found in review: without it a zoom-in kept coarse, closed-days-only items). It is called from the debounced `rangechanged` handler (~312) before `_refreshViewNow()`.

### 5.5 CSS

Next to `.vis-item.day-gridline` in `styles.css`:

```css
.vis-item.nonworking { background: rgba(93,113,134,0.35) !important; border: none !important; pointer-events: none !important; }
body.dark .vis-item.nonworking { background: rgba(144,162,184,0.20) !important; }
```

In light mode it is about as dark as `.past-zone` but slate-tinted, so closed time reads as inactive; elapsed closed time stacks both washes into a visibly darker band. Add `z-index: 0` only if the browser check shows it painting above grouped bands. Ungrouped items paint beneath grouped zone washes; items painted after existing gridlines may sit above them, which is cosmetic at 35% alpha in light mode, 20% in dark (raised from 10% on 2026-10-19); if visible, raise the gridline's z-index rather than reorder.

### 5.6 Minimap guard (required)

`TimelineNav._items.on('*')` cannot look up removed items and always repaints on `remove`. Extend `_wireItemsSubscription` to read `props.oldData` and skip when every removed item is `kind: 'zone'`, otherwise every pan re-diff repaints the minimap. Leave the minimap's own closed-day shading alone (it goes through the now date-aware `Calendar.workWindow`).

### 5.7 What not to touch

Never set `position`, `top` or `height` on `.vis-item` CSS. Never remove the `type === 'background'` DataView exemption. Do not group the shading items. Do not add a timer or change the ticker. Do not make shading per-line.

## 6. UI: the Calendar inner tab

### 6.1 Layout

```
Master Data > Plant      [General] [Calendar] [Optimization] [System Settings]

+-------------------------------------------------------------------------------+
| Default week     Sun  Mon  Tue  Wed ...  (7 pills, full width)   [Edit Calendar] |
+-------------------------------------------------------------------------------+
+-------------------------------------------------------------------------------+
| Period timeline   Apr    May    Jun    Jul    Aug     Sep     (next 12 months)  |
|  [==Peak===========][Winter=============>>   red marks = blackouts            |
+-------------------------------------------------------------------------------+
+-------------------------------------------------------------------------------+
| Calendar periods   2 periods                                  [ Add period ]  |
| Peak    [Active]    2026-10-16 -> 2027-04-19   Mon-Fri 12:00-24:00   Edit  Del |
| Winter  [Upcoming]  2027-04-20 -> no end date  Mon-Thu 01:00-13:00   Edit  Del |
+-------------------------------------------------------------------------------+
+-------------------------------------------------------------------------------+
| Plant Blackouts                                                    [ + Add ]  |
| Holiday shutdown   2026-12-24 -> 2026-12-26             (click a row to edit) |
+-------------------------------------------------------------------------------+
```

The grid is `.plant-cal-grid`, a single column (rev. 2026-10-19; it was `minmax(300px,380px) 1fr`, collapsing under 780px, which cramped the day pills). `#plant-hours-panel` is a container (`container-type: inline-size`); while it is wider than 800px each open day's time stays on one line, below that `_renderHours`'s two spans (`<span>7am-</span><span>7pm</span>`) break at the dash on purpose. The moved `#plant-hours-panel` keeps its ids so `_renderHours` and `Plant.render` keep working; its header becomes "Default week". The `#plant-periods-timeline-panel` holds `#plant-periods-timeline`. The full-width `#plant-periods-panel` holds `#plant-periods-count`, `#plant-add-period-btn`, `#plant-periods-list` and nothing else; the blackout hint line was removed. `#plant-blackouts-panel` follows it as a direct child of `.cal-container`, with its ids unchanged. The pane is `#plant-tab-calendar.cal-scroll`, the fourth `button.sub-subtab[data-plant-tab="calendar"]` in the nav at `index.html:~1682` (order General / Calendar / Optimization / System Settings). General loses its `.plant-two-col` wrapper and (rev. 2026-10-19) the Plant Blackouts panel, so it holds the Production Lines roster, which now opens expanded. `.admin-subtabs` is `flex-wrap: wrap`, so a fourth tab wraps to a second row when narrow rather than clipping.

### 6.2 Period row anatomy

Do not reuse `.block-row` for period rows: `.block-row .reason { flex-shrink: 0 }` would spill long names (maxlength 60), and six cells in a plain flex row wrap unpredictably. A new `.period-row` CSS grid: `minmax(120px,1.2fr) auto minmax(210px,1fr) minmax(0,2fr) auto auto`, with `min-width: 0` and ellipsis on name and summary and the full text in `title`. The range column minimum is 210px, not the 140px first planned: the Spanish and French range text ("Sep 30, 2026 -> Sin fecha de fin") needs about 205px at 1280px (a font-metric estimate, not a render; browser check owed). Under 780px it collapses to two lines (name, badge, actions / range, summary) on a five-column grid where the name spans two, and an extra breakpoint at 560px gives three lines on phones. Cells:

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

`_wireStaticHandlers` adds the Add listener; one delegated click listener each on the list and strip hosts reads `closest('[data-action]')`. This keeps the legacy-surface ratchet from growing. `admin-ui.mts gotoTab` carries the tab list as two literals (~358 and ~364): add `'calendar'` to both and dispatch `CalendarPeriodsUI.render()`. `Plant.render()` calls it after `_renderBlocks()` (covers plant switch). A module-level `Store.subscribe` on `calendar:change` is gated only by `#plant-tab-calendar` not being hidden (a DOM check; the shipped code does not call `getActiveTabResolvers()`, which would need an admin-ui import and create a cycle).

New files: `frontend/calendar/calendar-periods.mts` (pure: `periodStatus`, `summarizeWeek`, `validatePeriodDraft`, `buildPeriodStrip`) and `frontend/calendar/calendar-periods-ui.mts` (`CalendarPeriodsUI {init, render, openModal(id?), save, remove}`). Edited: `index.html`, `admin-ui.mts`, `edit-calendar.mts`, `styles.css`, the five locale files, and `.gitignore` (the new compiled `.mjs` paths for both work packages).

### 6.5 Editor modal

The editor reuses `#modal-edit-calendar` as a third mode: `EditCalendar.openPeriod(plant, id?)`, `_mode: 'line' | 'plant' | 'period'`. A new `#cal-edit-period-fields` block sits above Quick Presets inside `.cal-edit-body` (the modal is `max-height: min(92vh, 100dvh - 32px)`; header and footer pin, the body scrolls):

- Name (`#cal-period-name`, maxlength 60, autofocus).
- Valid from and Valid to: two **Flatpickr date-only** pickers following `orders.mts:~2731` (`#print-start` / `#print-end`): `Y-m-d`, `altFormat` from `Util._dateFormatPref()` (the user's date-format preference, re-applied on each render; the code does not hardcode `'M j, Y'`), `altInputClass 'input'`. Flatpickr popups append to `body`, so they behave as the existing time pickers do.
- "No end date" checkbox on **its own row** under the date pair, so the two date fields stay level. Checking it disables Valid to and greys its alt input.
- A `.field-error` element per field.

A new period seeds its hours from the plant default, `valid_from` = plant-local today (or the day after the latest existing `valid_to`, if later), `valid_to` = from + 6 days, and No end date **unchecked**. The `.cal-copy-plant-btn` is hidden and the footer button reads "Save period". `save()` is refactored into `_collectWorkHours()` plus a per-mode branch; period mode must **not** touch `NIMBUS.Plant._persistPlantHours` or `clampLinesToPlant`. The Save button shows a busy state during the pessimistic POST (disabled plus `aria-busy`) to prevent double submit and is re-enabled on any response. The weekly-grid badge column of this modal was widened from 52px to 84px and the badge wraps, so "18h · hasta medianoche" fits (rows with a midnight end are about 12px taller). `CalendarPeriodsUI.save(period, plant?)` takes the plant the editor opened for, so a plant switch while the modal is open cannot write to the wrong plant.

### 6.6 Validation

`validatePeriodDraft` runs on Save and live afterwards. It shows inline `.field-error` text with `aria-invalid` and `.input.is-invalid` (full border in `--err`) for: name required, from required, to required (`err.period_to_required`: an empty Valid to with "No end date" unticked, which would otherwise read as "ends before it starts"), to before from, and overlap, which **names the other period and its range**. Save stays enabled. Live re-validation is wired to the day toggles, presets and every time and date picker once a Save has been attempted, and it does not move focus; only Save focuses the first invalid field. Server 400 codes map to inline or toast text (`period_overlap`, `period_dates_invalid`, `period_hours_invalid`, `period_invalid`); the modal stays open on rejection (O2). A non-blocking **warning** (`warn.period_all_closed_long`) appears when a period has no open day AND (has no end date OR spans more than 90 days): the backward walk looks back 90 and then 400 days, so an open-ended all-closed period makes every placement on that plant refuse with `no_operating_window`. The warning is live: it appears as soon as the editor opens or a day is toggled off (not only at Save) and never blocks Save. Overlap errors show inline in the editor, for both client validation and a server 400; `toast.period_overlap` is only for the What-If promote path (`flushPlant`), where no editor is open. `CalendarPeriodsUI.save` adds no second toast on a transport failure, because `CalendarSync.savePlantPeriods` already toasts one.

### 6.7 Midnight (24:00)

The model already stores 24, and `_endHours` reads a picked 00:00 end as 24. Fixes: the badge shows "12h - to midnight" when the end picker reads 00:00; a helper line says "To run until midnight, set the end time to 12:00 AM."; and the **load direction** is fixed: `_populate` and `copyFromPlant` feed `"24:00"` to Flatpickr through `Util.hoursToTimeString(24)`, and a new `_toTimeString(h, isEnd)` returns `'00:00'` for 24 (tested). There is no separate 24:00 picker option.

### 6.8 i18n

All text goes through `data-i18n` / `t()` in all five locales (`en`, `de`, `es`, `fr`, `pt`); the parity tests gate it. Keys: `tab.calendar`, `ui.default_week`, `ui.period_timeline`, `ui.period_timeline_hint`, `ui.calendar_periods`, `ui.period_count`, `ui.period_count_one` (singular, "1 period"), `btn.add_period`, `btn.save_period`, `empty.no_periods`, `ui.today`, `ui.period_active`, `ui.period_upcoming`, `ui.period_past`, `ui.no_end_date`, `ui.week_closed`, `ui.week_closed_all`, `modal.period_title`, `ui.period_name`, `ph.period_name`, `ui.valid_from`, `ui.valid_to`, `ui.cal_to_midnight`, `ui.cal_midnight_hint`, `err.period_name_required`, `err.period_from_required`, `err.period_to_before_from`, `err.period_overlap`, `toast.period_overlap`, `toast.period_dates_invalid`, `confirm.delete_period_title`, `confirm.delete_period`, `btn.delete_period`, and `warn.period_all_closed_long`. Keys added by the 2026-10-19 revision: `modal.add_plant_blackout`, `modal.edit_plant_blackout`, `btn.save_block`, `toast.plant_blackout_updated`, `toast.plant_blackout_gone`, `ui.timeline_next_12_months`, `ui.timeline_through`, `ui.blackout_legend`, `ui.blackout_cluster`, `ui.blackout_more`, `aria.blackout_mark` (and `ui.period_blackout_pointer` was removed). Keys added beyond this list while building: `err.period_to_required`, `err.period_invalid`, `btn.edit`, `ui.default_week_legend`, `toast.period_saved`, `toast.period_deleted`, `aria.period_delete`, `aria.cal_edit_close`, plus the modal's formerly hardcoded labels (`modal.edit_calendar`, `ui.cal_plant_label`, `ui.quick_presets`, `btn.preset_weekdays`, `btn.preset_mon_sat`, `btn.preset_all_days`, `ui.weekly_schedule`, `btn.copy_from_plant`, `btn.save_changes`); `ui.today` already existed and is reused. While in the modal, also translate its existing hardcoded English (title, "Plant {name}", Quick Presets and chips, Weekly Schedule, Copy from Plant schedule, Cancel, Save Changes, the close aria-label).

### 6.9 UI-fit rules

- **Measure before finalising layout (owner rule).** Longest strings across the five locales for panel headers, the Add/Save/Delete buttons, the status badges and the period row, at the narrowest supported viewport. Measure es and pt tab labels ("Configuración del sistema", "Configurações do sistema"), which are longer than German. Confirm the period row's own collapse under 780px and no horizontal scroll.
- No inline handlers (`onclick`, `NIMBUS.` in HTML) in the new markup; delegated listeners only. The Edit Calendar modal's 14 pre-existing inline handlers are out of scope.
- Flatpickr only for date and time inputs.
- No colour side stripes on rows or segments.
- The seven day pills take the full content width (cells about 145px wide at windows of 1144px and up). Times stay on one line while the panel is wider than 800px and break at the dash below that (container query). `.panel-head` already wraps, so header, count hint and Add button wrap cleanly.

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

1. **Master Data > Plant > Calendar.** The default week renders full width with one-line times (two-line below an 800px panel). Add period "Peak" Monday to Friday 12:00-24:00 valid today to +6 months. Add "Winter" Monday to Thursday 01:00-13:00 from the day after, with no end date. The strip shows both (the second open-ended with a fade) and the badges read Active and Upcoming. Attempt an overlapping third: the inline error names "Peak". Edit and delete flows work. Plant switch re-renders. The Calendar tab shows Plant Blackouts below the periods list, with red marks on the timeline and a click-to-edit list; the General tab shows the expanded Production Lines roster.
2. **Gantt.** Weekends are one grey block with no midnight seams. 00:00-12:00 is grey on the 12-24 shift days. After the switch date 13:00-01:00 is grey. The grey sits **under** the past-zone, the alert and frozen horizon bands, the blackout hatch (visible through gaps) and alert cells. Pan at 1-week and 1-day zoom with no gaps or flicker. Coarse (closed-days-only) mode cannot trigger at the current zoom range (`zoomMax` 30 days), so there is nothing to check at wide zoom beyond the 30-day maximum showing the normal shading. Dark mode is quiet but visible. The line filter changes nothing (plant-wide).
3. Drop an order whose backward walk crosses the switch date and confirm the derived start uses both patterns. Run Optimize once on that plant and confirm no placement lands in grey time.
4. `PerfMonitor` `Timeline.rebuild` at pilot scale (24 lines, about 300 orders) before versus after: shading cost is a small fraction.
5. Optimize preview worker: open the Optimize dialog on a plant with periods and confirm the worker URL carries `?v=<build id>`, the worker requests `nimbus-compute-core.js?v=<build id>` (Network tab) and the console shows no `compute-core-stale` warning (the preview ran on the worker path, not the main thread).

### 7.3 What actually ran (2026-10-16, branch tip after W5/W4 fix rounds)

- Full `npm test` on `671e48b` (after W4 and W5 landed): legacy 103/103, modules 1737/1738. The one failure, "changeover advances to a future order pull-forward floor..." in `engine.test.mjs`, spawns a child Node process with a wall-clock deadline; it passed alone twice. `engine.test.mjs` ran in 3.65 s on the branch against 4.82 s on the base checkout, so the per-date lookup added no slowdown: a load flake, not a regression. (An earlier W3 run showed the same kind of flake on a different test in that file.) **Superseded** by the final run below.
- **Final state `17589da`, after the last W4 and W5 fix rounds:** `npm test` legacy 103/103 and modules 1741/1741 (the deadline flake did not recur); `npm run build` and `npm run typecheck` clean; `npm run lint` 0 errors and 34 pre-existing warnings (no-shadow and unused-type style); `npm run check:legacy-surface` no drift; `npm run check:static-assets` OK.
- Python, DB-free only: `tests/test_plant_period_twin.py` and `tests/test_plant_calendar_routes.py`, 39 passed (1 pre-existing Starlette deprecation warning). The wider combined run, including `tests/test_sap_staging.py`, passed with the `pg`-marked tests skipped.
- **Not run: DB-backed pytest.** Local Postgres is up but password-protected and no credential was available; `.env` points at Azure and is never used for tests. Skipped as a result: the nine new `test_calendar_persistence_workflows.py` period tests, the modified unknown-plant hydration test, `test_send_uses_the_calendar_period_covering_the_due_date`, and the `pg` tests in `test_schema_idempotent.py`. The table DDL, the `FOR UPDATE` row lock, the batched upsert and the cascade are therefore unverified against a real Postgres. Recipe: `PG_HOST=localhost PG_USER=postgres PG_PASS=<password> PG_SSLMODE=disable NIMBUS_TEST_DB=1`.
- **Not run: the browser checklist (section 7.2).** No browser session was available to the implementers. The fit numbers for the Calendar tab (tightest cell: the es/fr period range, about 205px of 210px at 1280px) are font-metric estimates, not renders. Also browser-only: real paint order and z-index of the shading against grouped bands, the live `props.oldData` shape in `TimelineNav`, pan smoothness, the Flatpickr alt-input carry-over when "No end date" is toggled, and the Today tag against the open-ended segment cap.

## 8. Deployment note

The migration is `migrations/2026-10-16-3-plant-calendar-periods.sql`. Its header comments must avoid the words ALTER, DROP, DELETE, UPDATE, TRUNCATE, RENAME, GRANT and REVOKE. The foreign key's cascade clause itself still matches the destructive-word filter in the `promote-azure` skill (`apply-migrations.ps1:78`), so the deploy step needs `-Only 2026-10-16-3 -AllowDestructive`. Record this in the migration header and in `docs/DEPLOYMENT.md`. Order matters: **apply the migration first, then roll the image**. The new code tolerates a missing table (`UndefinedTable` gives `[]`), but the pilot should not run the new image ahead of its table. Deploy via the `promote-azure` skill, never `schema.sql`; when verifying, cache-bust the request. Deploying is not part of this plan's execution.

## 9. Out of scope / owed

- Deploy via `promote-azure` (section 8).
- Machine-level periods, copy-between-plants, drag-editing on the strip, a `daterange` exclusion constraint once `btree_gist` is allow-listed, and replacing the Edit Calendar modal's 14 pre-existing inline handlers.
- Known residuals unchanged by this work: OQ46 (window math without `plantTz` reads viewer-local getters); the plant 1008 timezone data fix; line hours stored before D5 landed, or not re-clamped since, are still trimmed to the default and cannot exceed a wider period's hours until the planner edits them (D5 clamps to the union from now on; surfacing this as a hint in the Calendar tab was not built).
- Owed verification: the browser checklist (section 7.2) and the DB-backed pytest suite (section 7.3).
- Documentation updates owed with the code were written in W6b: `frontend/calendar/CLAUDE.md` and its `AGENTS.md` twin, `frontend/scheduling/CLAUDE.md`, `frontend/master-data/CLAUDE.md`, `frontend/optimization/CLAUDE.md`, `backend/calendars/CLAUDE.md`, `docs/DEPLOYMENT.md` and the Calendar and Scheduling rows of the root `CLAUDE.md` directory table.

## 10. Execution model

Branch `feature/calendar-periods` from the `main` tip (`b758345`) in a `.claude/worktrees` worktree. The orchestrator does not write code; Sonnet subagents implement each work package and Sonnet reviewers verify the integration-critical ones. Packages: W1 schema, migration and backend; W2 core helper, types, Store, CalendarSync; W3 engine threading; W4 Calendar tab and editor; W5 Gantt shading; W6 docs. Order: W1 and W2 in parallel (separate worktrees), W3 needs W2, W4 and W5 need W2 and W3 compiled, W6 last (this document first). Autonomous run with no review pauses except a truly large deviation. Test-first per package. Implementers append their own progress lines.

## 11. Decision log

Implementers append gap decisions made during the run.

| Date | Decision | Why | Cost if wrong |
|---|---|---|---|
| 2026-10-16 | The shared test fixture `tests/fixtures/plant_period_vectors.json` is owned by W1 (with `tests/test_plant_period_twin.py`); W2's JS test reads it and creates it with the agreed schema only if absent. | Both the JS Core test and the Python twin test read it, and ownership was unassigned. | A duplicated fixture to reconcile at merge. (In practice W2 created it and W1 extended it with four cases.) |
| 2026-10-16 | `CalendarSync.savePlantPeriods(plant, next)` takes the full next list and computes the delta inside; the UI design pass's `{upserts, deletes}` shape is dropped. | The plan's signature stands; W4's brief states it. | None; W4 adapts. |
| 2026-10-16 | W4 and W5 run in parallel in the one worktree; each uses Edit (never Write) on the shared `styles.css` and `.gitignore`, runs no git, and the orchestrator commits. | Both packages touch those two files. | A lost CSS hunk, caught by the browser check. |
| 2026-10-16 | The scoped CSS override that stacks the seven day pills in the 300-380px column is optional; the implementer decides after measuring. | The plan and the review disagreed on whether it was required. | None. (W4 added a Calendar-tab-only override: the time text wraps at the dash and drops to 11px.) |
| 2026-10-16 | The review fixes win over the plan body for the period row: a new `.period-row` grid and `Util._fmtDatePref` dates, not `.block-row` and ISO dates. | The review amends the plan body by the plan's own words. | None. |
| 2026-10-16 | The review fixes win over the plan body for the shading items: id `nonworking-<dayKey(start)>` and a single owner `_nonWorkingDesired`, not `nonworking-<startMs>` with two writers. | Same reason. | None. |
| 2026-10-16 | W1 runs pytest only against a local database; if none is reachable it reports that plainly and the DB-backed tests are owed, never pointed at Azure. | The suite refuses to collect against the Azure host by design, and `.env` may point there. | None; the cost is the owed DB-backed run (section 7.3). |
| 2026-10-16 | Overlap errors surface inline in the editor (client validation and a server 400 both keep the modal open); `toast.period_overlap` is only for the What-If promote path (`flushPlant`), where no editor is open. | An open editor is the natural home for the message. | A misplaced message. |
| 2026-10-16 | The "owed" line about line hours clamped to the default refers only to lines stored before D5 landed or not re-clamped since (reworded in section 9). | D5 clamps to the union from now on, so only older stored lines are affected. | An over-broad warning in the docs. |
| 2026-10-16 | In the new-period editor, "No end date" stays unchecked by default. | An open-ended override is a deliberate act. | A planner has to tick one box for an open-ended period. |
| 2026-10-16 | W1 and W2 both run in `calendar-periods` in parallel (the sibling worktree is removed): their file sets are disjoint (Python, SQL, migrations and `tests/test_*.py` plus the vectors fixture, against frontend plus `tests/js` plus `tests/modules`) and neither runs git. W1's base became `ba52c8d`. | The harness pins subagents to the session worktree, so W1 could not write to its sibling worktree. | An interleaved edit on a shared file; none occurred. |
| 2026-10-16 | Every later work-package brief carries a CRLF check for files pinned `-text` in `.gitattributes`. | W2's edit rewrote `setup-scheduler.mts` from CRLF to LF and produced a 14,899-line phantom diff (Appendix B). | Unreadable diffs and merge pain. |
| 2026-10-16 | W3 starts in parallel with the W2 review (base `0110f72`). | W3's file set (`engine.mts`, `calendar-engine.mts`, `setup-scheduler.mts`, `optimizer-worker-client.mts`, `foundation.mts`, `app.js` and their tests) is disjoint from any W2 fix surface (core, store, calendar-sync, optimize-ui), and the W3 brief forbids touching anything else. | A W2 fix and a W3 edit colliding on one file, caught at commit time. |
| 2026-10-16 | W4 starts in parallel with W3 (base `0110f72`). | W4 depends only on W2, and its file set (`index.html`, `admin-ui.mts`, `edit-calendar.mts`, the new `calendar-periods*.mts`, `styles.css`, locales, `app-entry.mjs`, `.gitignore`, the calendar and master-data tests) is disjoint from W3's; both briefs forbid crossing. | An interleaved edit, caught at commit. |
| 2026-10-16 | W5 starts in parallel with W4 and the W3 review (base `7e67d6c`). | The file sets are disjoint except `styles.css` and `.gitignore`, both Edit-only in separate regions. | A lost CSS hunk, caught in the browser check. |
| 2026-10-16 | W4's commit waits for W5, so the shared `styles.css` and `.gitignore` are committed per package in one pass (W4 first, then W5); W5's CSS hunks ride in W4's commit and the reviewers were told so. | The two packages share two files. | A muddled review diff, not a code defect. |
| 2026-10-16 | The failing full-suite test in `engine.test.mjs` (the changeover pull-forward floor case) is a load flake, not a regression; noted as a minor for the final review. | It passed alone twice, and the file ran in 3.65 s on the branch against 4.82 s on the base checkout. | A real slowdown hiding behind the flake label; the timing comparison argues against it. |
| 2026-10-16 | Final review ruling: the optimizer worker loads the compute core with the build-id cache-bust. The client stamps `?v=<Config.BUILD_ID>` on the worker URL; the worker reads `self.location.search` and dynamically imports `nimbus-compute-core.js?v=...` before assigning `onmessage`. The `compute-core-stale` fallback stays as the second line of defence. | The corporate proxy caches `.js` by URL, so a static import could leave the optimizer worker on a stale core after a deploy and push every preview for plants with periods to the main thread (the freezes of 2026-08). | A worker that fails to load the core errors out and the preview rejects; confirmed only by the browser checklist (the Node tests cannot run a real browser worker). |
| 2026-10-16 | Final review ruling: the Gantt coarse shading branch (covered range > 90 days) is kept although it is unreachable at `zoomMax` 30 days; a code comment and section 7.2 say so. | It is a cheap guard for a future larger `zoomMax`, and removing it would reopen the question then. | Dead code that a reader mistakes for live behaviour; the comment mitigates it. |
| 2026-10-19 | **Rev. note: Calendar tab polish.** Plant blackouts moved from General to the Calendar tab, became editable (click a row or a red timeline mark) and planner-writable (`POST /plant-calendar/plant-blackouts` now uses the plant-scope guard instead of `require_admin`; line blackouts, hours and periods stay admin). The default week and timeline stack full width; the timeline says it looks out 12 months; the hint pointing to General was removed; the Master Data sub-tab underline runs under Refresh to the right edge; the "No end date" checkbox is 14px and left-aligned. Last writer wins on blackouts (no versioning). This supersedes D3's "Blackouts stay on General". | Owner feedback on the shipped tab. | Planners can now alter plant blackouts, so a bad edit is audited by the existing admin-log line but not versioned. |

## Appendix A. Context

**Why this change.** Plants change shift patterns through the year and the owner needs the plan to follow: a plant runs one pattern for a stretch, then another, and orders placed across the switch date must be scheduled, alerted and sent to SAP against the pattern that is actually in force on each day. Today the only choice is to overwrite the single weekly pattern, which silently rewrites the meaning of every already-placed order. Planners also had no visual cue for non-working time on the Gantt, so a bar sitting in an off-shift hour looked the same as one in a shift.

**Who asked.** The owner, decided 2026-10-16 (D1-D4), with D5 and D6 settled in the same day's review.

**What it builds on.** The plant weekly pattern (`plants.work_hours`) and `_clean_work_hours`; the plant blackout table and its delta-write pattern (`save_plant_blackouts`, client-generated ids, `flushPlant` promotion); the calendar capacity-math engine and its mirror in `nimbus-compute-core.js`; the finish-anchored backward walk (`BACKWARD_SCHEDULING_MIGRATION.md` at the repo root; there is no copy under `docs/`); CalendarSync hydration and the revision guard; the Sandbox/What-If snapshot machinery; the Gantt's vis background-item handling (gridlines, past-zone, `_healBackgroundBands`); the Send to SAP window logic (`docs/SAP_STAGING_DESIGN.md`).

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

**Build run (2026-10-16)**

- **A Write to a CRLF-pinned file rewrites its line endings.** `frontend/optimization/setup-scheduler.mts` is pinned CRLF by `.gitattributes -text`. W2's edit rewrote it as LF, which made git show a 14,899-line phantom diff over a 3-line real change. It was restored to CRLF with perl (7450 of 7450 lines at the time; 7466 after W3's edits), the real diff was 3 lines, and build plus the 197 setup-scheduler tests passed. Rule: before editing any file marked `-text`, check its line endings (count CRLF against LF by bytes, not with `grep` in git-bash, which reports every line of an LF file as matching), edit with the Edit tool rather than Write, and re-check after. Every later brief carried that check.
- **A helper call must signal a stale core, not throw a TypeError.** The optimizer worker imports the compute core without a cache-bust query, so a proxy-cached stale core can lack `plantWorkHoursOn`. The first engine cut called `Core.plantWorkHoursOn` directly, which broke even plants with no periods; review caught it. Every caller now goes through a resolver that returns the default by reference when there are no periods and throws `compute-core-stale` only when periods exist and the helper is missing, and the worker client maps that to its synchronous fallback (which did not exist before this work).
- **The harness pins subagents to the session worktree.** W1 was dispatched into a sibling worktree and every write there was refused. Packages that cannot be separated by worktree must be separated by file set instead, with Edit-only rules on shared files and the orchestrator doing all commits.
- **A flaky timing test needs a measurement, not a shrug.** The one full-suite failure (a wall-clock child-process test in `engine.test.mjs`) passed alone. To rule out a real slowdown from the per-date pattern lookup, the same file was timed on the branch (3.65 s) and on a base checkout (4.82 s); the branch was not slower.
- **Derive a flag from the state it describes when you can.** The shading hysteresis needed to know whether the stored range was built coarse. A separate `_nwCoarse` flag was considered; the shipped fix derives it from the stored range's span under the same > 90 day rule, so it cannot drift from the range.
- **A test fixture's defaults can hide a rule.** The shared vectors file had `validate` entries with empty work hours, which the writer correctly rejects; the Python twin test substitutes valid hours so only dates are exercised.
- **Overlap checks must compare every pair.** The first writer compared only sorted neighbours, which misses a short period nested inside a long one. It now compares every pair, limited to pairs that involve an upserted id so pre-existing bad data never blocks a delete, and the writer and the twin test share one helper.
