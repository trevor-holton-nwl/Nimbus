# Gantt pan performance — design (Wave 1 committed; transform pan and canvas deferred)

## Problem and measured root cause

**What the planner feels.** Dragging the Gantt sideways "feels a little jittery", and the owner expects it to get worse as plants grow. A second, different complaint rides along: a short hitch right after moving an order or finishing a pan, when the page re-checks itself.

**Why, in plain words.** The Gantt is drawn by a third-party library (vis-timeline 7.7.3) that makes every order bar a separate element on the page. On every frame of a drag the library moves and re-measures every bar it is currently showing, and it does that by writing positions and then reading sizes several times per frame, which forces the browser to re-lay-out the whole chart each time. So the cost of one frame is proportional to the number of bars on screen and how wide the window is. NIMBUS code does almost nothing extra per frame; the cost is the library's own write-then-measure pattern times the number of visible bars. A smooth frame has a budget of 16.7 ms.

**Measured on the Azure pilot** (plant 1008 Mexicali, 966 orders, 30 lines; the plan records the measured build as image 5f89d2a; 2026-10-26). One pan frame = one synchronous vis redraw (`tl._origRedraw()`) after a `setWindow` step, median of 12 steps:

| Configuration | 3 d zoom | 14 d zoom |
|---|---|---|
| Baseline, all 1,267 items (211 / 457 bars in the page) | **29 ms** | **70 ms** |
| 295 background items removed | 26 ms | ~70-84 ms (noisy) |
| ItemSet empty (0 items, 30 rows) | 7 ms | 7 ms |

Breakdown of one baseline frame by vis component: bars and bands (ItemSet) **30 ms at 3 d / 60 ms at 14 d**; the same with no items (30 empty rows) ~4 ms; time axis 2-4 ms; background panel, current-time bar, custom time bar under 0.2 ms.

**Root cause (confirmed).** Bars rendered as page elements are 80-90 % of every pan frame. Background bands are about 10 %. vis's own chassis (axis plus rows) is about 7 ms, well under budget. The 1 s ticker, the 30 s lock scan, the minimap repaint and `_healBackgroundBands` are each 1 ms or less per frame. Opening a day-alert popup is one 1.36 s long task (a separate issue, logged below).

### What inside the bars costs the time

Every layout-read getter (`offsetTop/Left/Width/Height`, `clientWidth/Height`, `getBoundingClientRect`) was instrumented during one real pan frame (`tl._origRedraw()` after a `setWindow` step):

| | 3 d zoom (211 bars) | 14 d zoom (457 bars) |
|---|---|---|
| Frame | 27 ms | 40 ms |
| Time inside forced-layout reads | 16 ms (60 %) | 21 ms (53 %) |
| Layout reads per frame | 326 | 294 |
| "Slow" reads (0.5 ms or more, i.e. a forced full layout) | 3.5 | 4.6 |
| Biggest single read | `offsetTop` on a row group, 8.7 ms | 14.7 ms |

The reads are vis-timeline's own: 60 `offsetTop/offsetLeft` plus 68 `offsetWidth` (one set per row group in `_calculateGroupSizeAndPosition`), 72 `clientHeight` (`_didMarkerHeightChange`, per group), axis character measurement, panel sizes. Each is issued after vis has written positions or heights, so the browser must re-lay-out the Gantt 3-5 times per frame. The rest (about 10-18 ms) is vis's JavaScript walking the ItemSet.

### Live experiments

Each interleaved against baseline in the same tab (p50 of 8-10 pan steps; machine noise about 20 %):

| Experiment | 3 d | 14 d | Verdict |
|---|---|---|---|
| Baseline | 23-28 ms | 44-50 ms | - |
| Remove all 295 background items | 26 ms | ~70 ms | no gain |
| Halve the bars | 20 ms | 29 ms | cost proportional to visible bars |
| ItemSet empty (vis chassis only) | 7 ms | 7 ms | chassis is fine |
| CSS `contain: layout style` on items/groups/panels | 25 ms | 42 ms | no gain |
| Drop box-shadow/border-radius/overflow on bars | 23 ms | 49 ms | no gain |
| Single bar `left` change then one layout read | 0.2 ms | - | one layout is cheap; vis dirties far more than one bar |
| Tiny (1/600 span) vs large (1/10 span) pan steps | 27 vs 24 ms | 43 vs 50 ms | bars entering the viewport are not the driver |
| Over-render bars +/-0.5 viewport (patch `RangeItem.isVisible`) | 20 ms | 35 ms | about 20 % gain, still over budget |
| Cache vis's group geometry + skip marker check + cache axis char size (prototype of "fork and patch vis") | 27 ms | 57 ms | no gain |
| Over-render + the vis caches | 21 ms | 40 ms | about 20 %, from over-render only |

**"Only measure the rows in view"** (the owner's question): vis already culls rows outside the vertical viewport (`_isGroupVisible`; in the test tab 14 of 31 rows were in view, 8-29 bars displayed in off-screen rows versus 190-430 in view). Shrinking the panel so 8 rows were in view gave 30 ms (3 d) / 52 ms (14 d); 3 rows gave 18 / 23 ms. There is a floor of about 15 ms that does not shrink with rows (per-group bookkeeping over all 31 groups, the item-list walk, the axis, the forced layouts). Real screens show more rows than the test panel, so production frames sit at or above the 14-row line.

### Conclusion

No CSS, no caching of vis's measurements, no reduction of our own work, no vertical culling beyond what vis already does, and no vis patch that was prototyped brings a bars-in-the-page pan frame under 16.7 ms at 3 d, or anywhere near it at 14-30 d. The cost is structural and proportional to visible bars. Removing only the background bands (an earlier "Phase 1" idea) is worth about 3 ms of 29 and is not worth building on its own. **Only two mechanisms fix the steady jitter**: (1) stop redrawing vis on every frame of a gesture (transform pan: slide the already-drawn picture, do a real redraw every so often), or (2) take the bars out of the page (draw them on a canvas ourselves; vis chassis about 7 ms plus canvas paint about 2 ms, roughly 9 ms per frame, scaling to 3,000 orders). Both are documented below as deferred options. "Fork vis-timeline and patch it" is rejected on this evidence.

The mid-pan stalls (the alerts rebuild after a drop, the settle refresh) are separate from steady jitter and cheap to fix. That is Wave 1.

## Decisions (owner, 2026-10-26, settled, don't re-ask)

- **D1. Committed scope is Wave 1 only** (the five items below). Reason: the owner is nervous about breaking the Gantt's finicky interaction layer (drag, resize, selection, marquee, Go To) and chose the zero-behaviour-change set first.
- **D2. Transform pan (Option T) and the canvas item layer (Option C) are NOT authorised.** They stay documented here as the only two mechanisms that fix steady pan jitter, for a separate decision once Wave 1's frame timings are visible in the Admin Cockpit. Rejected outright on the evidence: a full custom renderer, commercial libraries, forking or patching vis-timeline, CSS containment, over-render.
- **D3. Ctrl+F on bars is accepted as lost** if Option C is ever built (bars on a canvas are not searchable text). Release-note it then; a hidden accessibility list is an optional later add.
- **D4. No horizontal wheel pan** is added.
- **D5. Expectation set with the owner:** Wave 1 removes the stalls (the alerts-driven rebuild landing mid-pan, the settle refresh, rebuild cost) and adds measurement. Note the post-drop rebuild itself still runs, because a drop always marks task data dirty and the gate never skips after a task write; it is cheaper (Items 3 and 4) and deferred off the pan. **The steady jitter while dragging will remain** (frames about 25-70 ms).
- **D6. Process:** Sonnet subagents implement, TDD, one commit per item on `feature/gantt-pan-perf`; implementers append to the Progress ledger below; the orchestrator dispatches and reviews only. Plan file `C:\Users\PJ29587\.claude\plans\it-feels-a-little-serene-island.md` was the authority until this spec landed. Per-task briefs live in the git-ignored `.superpowers/sdd/it-feels-a-little-serene-island/`.

## What the review corrected (binding on the builders)

Three Sonnet reviewers checked every plan assumption against live code and the vis 7.7.3 source on 2026-10-26. The corrections, which bind the items below:

- `tl.redraw()` (public) = a synchronous `itemSet.markDirty({refreshItems:true})` plus a rAF-throttled `_redraw`; `_redraw` is `throttle(_origRedraw)`. Any wrapper must replace **both** `_origRedraw` (timed) and `_redraw` (a re-created throttle), or it either measures nothing or destroys vis's rAF coalescing.
- The `alerts:change` rebuild is **not** redundant: it is the only path that refreshes setup bars, stack-depth badges, `_itemIdsByTask` and frozen/lock state after optimizer applies, grid or Inspector edits and undo (those go through `_applyTaskPatch`, which patches order bars only). A signature gate must also require "no task data changed since the last rebuild".
- `Interaction._isDragging` is dead (set only from `timechange`, which vis emits only for custom time bars). `_scheduleRebuild` is the spring-back path for 13+ drag call sites; deferral must not sit inside it.
- `_alertSig` must include `hasConflictErr` (it chooses `alertcell-err` versus `alertcell-calendar`, gantt.mts 1669-1671) and hash every alert with a `taskId` (the `_conflictIds` set), computed with the same line-filter predicate, stored only on a clean (non-healed) pass.
- `_refreshViewNow`: safe to skip the explicit `redraw()` when the DataView had no add/remove (the DataView events already queue a redraw); the flag must be computed after `refresh()` returns; keep the boolean return. Saves about 16 ms at pan settle and after every rebuild.
- `_healBackgroundBands` also re-runs `repositionX` on foreground bars (commit 1a88121, fixes Day-zoom bar drift); only its background half can go while bars are in the page.
- Flag plumbing (relevant only if a canvas flag ever ships): a settings-catalog entry (application-shell.mts:197) does not render a control; it needs a hand-written checkbox, label/hint keys in all 5 locales, and a `settings:change` handler that compares old and new value (the event fires on every PATCH ack).
- Gates: no legacy-surface impact for Wave 1; a `Timeline.repaintTheme()` call added in nimbus-intelligence.js would trip the ratchet (use a body-class MutationObserver instead). New `.mts` modules need `.gitignore` lines. No migrations. CI (`.github/workflows/ci.yml`) runs typecheck/lint/test/gates and promote-azure requires it green.
- Under the committed scope a canvas flag does not exist, so planners keep the page-element path; the two items first dropped as "redundant with the canvas wave" (zones 90 to 3; the rebuild equality diff) are exactly the ones that help the path planners actually use, so they are reinstated as items 4 and 5.

**Dropped after review** (do not build): minimap static cache (step 8 of `TimelineNav._paint` draws `Date.now()` and the 60 s tick does not set `_dirty`, so a static cache would freeze the now marker; gain about 0.9 ms); ticker reorder / lock-scan batching (must keep the `hasMultipleItemsForTask` to rebuild branch; gain unmeasurable); layout.mts scroll guard (popovers are pure CSS `:hover/:focus-within`, no close handler exists, no effect on Gantt pan); removing the `.dimmed` saturate filter (only active while a filter is on; zero gain on the measured baseline; faint hue tint if removed).

## Wave 1 (committed): stop the stalls, measure the frames

Each item is independently shippable, test-first, its own commit, no planner-visible behaviour change intended. Order: 1, 2, 3, 4, 5, strictly sequential (all five edit `frontend/scheduling/gantt.mts`). Common gates for every item: `npm run build`; `node --test tests/modules/scheduling/gantt.test.mjs tests/modules/scheduling/pv-drag.test.mjs`; `npm run lint`; `npm run typecheck`; `npm run check:static-assets`; `npm run check:legacy-surface`. Tests go in `tests/modules/scheduling/gantt.test.mjs`.

Line references are to `frontend/scheduling/gantt.mts` (6,057 lines at main a618b69) and were re-verified against the worktree.

### Item 1. Instrumentation (about 0.5 day)

**In plain words.** Make the Gantt report how long each redraw takes and how long each pan gesture lasts, so the Admin Cockpit shows real frame numbers, and add a console benchmark for repeatable before/after measurements. This item changes nothing the planner sees.

**Planner-visible impact.** None. Two new rows (`Timeline.frame`, `Timeline.pan`) appear in the Cockpit Thread pane.

**Where.** `Timeline.init` (323-529), right after the vis Timeline is built at line 383 (`Timeline._tl = new vis.Timeline(...)`); the `rangechanged` hook at 395-396 is the neighbour. Pure helper and the `_bench` method live beside `Timeline`. `PerfMonitor` is already imported (line 24; `record(name, ms)` at `frontend/platform/foundation.mts:1377`).

**What.**
- `tl._origRedraw = timed(tl._origRedraw)` recording `Timeline.frame`; `tl._redraw = ownRafThrottle(() => tl._origRedraw())` re-creating vis's throttle; guard against a double install.
- `Timeline.pan` gesture summary from `rangechange {byUser, event.type: 'panmove'}` to `rangechanged {event.type: 'panend'}` (milliseconds, redraw count, max gap between redraws) with a 300 ms watchdog (a cancelled pan never emits `rangechanged`). It also exposes `Timeline._panActive` (boolean) for item 2.
- Dev console `Timeline._bench({days, steps, stepPx})`: one `setWindow` per rAF, prints p50 / p95 / max, the `.vis-item` count and long tasks.
- Do not record counts as ms marks (the Thread pane labels everything "ms").

**Binding corrections.** Replace both `_origRedraw` and `_redraw`; never install a synchronous wrapper on `_redraw` (every queued redraw would become synchronous and pans would get slower); self-disable (no throw) if either is missing or not writable; the pan flag keys on `event.type === 'panmove'`, not on `byUser` alone (wheel zoom also emits `rangechange{byUser:true}`, see the pan-detection history in the comment at 4440-4462).

**Tests.** `frameMeterSummary` (pure); the wrapper preserves a throttle (two `_redraw` calls in one tick queue one rAF; `_origRedraw` runs once); the double-install guard; missing-field self-disable; pan start/end/watchdog/pointerup; `_bench` is a function and returns its summary against a fake timeline.

**Acceptance.** All existing tests green; new tests green; Cockpit rows appear in a browser check; `_bench({days:3})` prints numbers on the pilot.

### Item 2. Alerts-rebuild gate and deferred rebuild (about 1 day)

**In plain words.** Today every time the alert list is recomputed (which happens after nearly every edit) the Gantt rebuilds all its items, even when the alerts did not actually change. And if that rebuild lands in the middle of a pan, the pan hitches. This item skips the rebuild when nothing it depends on changed, and when it must run during a pan it waits until the pan ends.

**Planner-visible impact.** None intended: setup bars, stack-depth badges and lock styling must still refresh after an optimizer apply, a grid or Inspector edit and undo (that is why the "no task data changed" flag exists).

**Where.** `Timeline._onStore` (638-739): the `alerts:change` branch at 729-738 currently ends in `Timeline._scheduleRebuild()`; the early return for `evt.source === 'timeline'` is at 640-650. `_scheduleRebuild` is at 1366-1372 and stays untouched. `_rebuildPass` (1387-1883): `conflictIds` at 1443-1444, `alertCellMapFor` call at 1666, clean-pass bookkeeping at 1855-1856.

**What.**
- `_taskDataDirty` flag set in `_onStore` on `task:update`, `tasks:bulkUpdate`, `firmed:change`, `tasks:bulk`, `setup-snapshot:replace`; cleared at the end of a clean `_rebuildPass`.
- `_alertSig` = sorted `line|day|sev|hasConflictErr` from `alertCellMapFor` plus the sorted ids of every alert that has a `taskId`, using the same `lineVisible` predicate as the rebuild; stored as `_lastAlertSig` only at the end of a clean (non-healed) pass.
- In the `alerts:change` branch: skip scheduling only when `!_taskDataDirty && sig === _lastAlertSig`; still run `_applyProfileMatchClasses`.
- Deferral: a separate `_scheduleAlertsRebuild()` used only by this branch. While a vis pan gesture is active (flag from item 1; cleared on `rangechanged` of any type, document `pointerup`/`pointercancel`, and the watchdog) it only records "pending", and the flush schedules one rebuild. `_scheduleRebuild` and its drag call sites stay immediate.

**Binding corrections.** Never skip the Store emit (the gate lives only in the Timeline subscriber); never put the deferral inside `_scheduleRebuild`; the signature must include `hasConflictErr`; store the signature only on a clean pass; a stuck flag must be impossible (watchdog, pointerup, `rangechanged`).

**Tests.** `_alertSig` including `hasConflictErr`; order independence; the task-id part; the dirty-flag gate; the deferred flush including the 300 ms watchdog; a heal pass stores nothing; `_scheduleRebuild` still schedules during a pan.

**Acceptance.** The gate never skips after a task write (a drop always marks `_taskDataDirty`), so the post-drop rebuild still runs; it is cheaper (Items 3 and 4) and deferred off the pan. An `alerts:change` with no task write since the last clean pass and an unchanged signature causes no rebuild; setup bars and stack badges still update after an optimizer apply or an Inspector edit (browser check on the pilot).

### Item 3. Settle refresh (about 0.5 day)

**In plain words.** When a pan settles (and after every rebuild) NIMBUS re-filters which orders the library should know about and then forces a full redraw. The forced redraw is only needed when orders actually entered or left that set; otherwise the library already queues its own redraw. This item skips the redundant forced redraw.

**Planner-visible impact.** None. Saves about 16 ms at pan settle and after every rebuild.

**Where.** `Timeline._refreshViewNow` (2169-2183): currently sets `_viewWindow`, calls `_visItems.refresh()`, then `_tl.redraw()` unconditionally. Called from the debounced `rangechanged` handler (395-396) and from `_rebuildPass` (1855).

**What.** Subscribe once to `_visItems` `add` / `remove` setting a flag; after `refresh()` returns, call `redraw()` only if the flag fired; reset the flag per call; keep the boolean return and the try/catch heal path. Split the mark into `Timeline.refreshView.filter` and `Timeline.refreshView.redraw`.

**Binding corrections.** Compute the add/remove flag after `refresh()` returns (events fired by earlier item writes in the same rebuild must not count); keep the boolean return (`rebuild` reads `=== false`); keep `_heal('refresh-view', e)`.

**Tests.** No add/remove: no redraw; add: one redraw; remove: one redraw; flag resets between calls; a throw returns false and heals; the subscription is wired once per DataView instance; the new marks are recorded.

**Acceptance.** Settle refresh under 2 ms when nothing entered the window, and bars are still correct after a long pan (browser check).

### Item 4. Rebuild equality diff (about 1 day)

**In plain words.** After every rebuild NIMBUS currently re-sends every item to the library as "updated" even when nothing about it changed, which makes the library re-measure it. This item compares each item with what is already there and only sends the ones that really changed.

**Planner-visible impact.** None. Expected rebuild cost 20-35 ms down to 3-6 ms when little changed.

**Where.** `_rebuildPass` diff at 1743-1760 (the `toUpdate.push(data)` at 1756); `rebuildSetupForLines` (1233-1268; the update/add split at 1248-1250).

**What.** Skip `toUpdate.push` when `visItemEqual(existing, desired)` (pure, exported, tested). Compared fields: id, group, kind, parentId, segment fields, `+start`, `+end`, className, editable, type, title, content, style, `subgroup` (presence-aware, after the lane-relocation check), laneIndex, setup fields. Same treatment in `rebuildSetupForLines`.

**Binding corrections.** Run the lane-relocation check before the equality skip (a lane change is remove + add, never update; vis 7.7.3 leaves a dangling subgroup reference otherwise); `subgroup` compared only when the desired item carries the key.

**Tests.** `visItemEqual` per field; a second identical rebuild writes no order items; a changed order writes only that order; the relocation check still wins; `rebuildSetupForLines` skips equal setup bars; a className difference (dimmed, `dist-sibling`) is still written.

**Acceptance.** Existing lane, heal and drag tests unchanged; `Timeline.rebuild` several times cheaper when little changed.

### Item 5. Zones 90 to 3 (about 0.5 day)

**In plain words.** The grey "past", light-green "alert horizon" and dark-green "frozen horizon" washes are today drawn as one band per machine row: with 30 rows that is 90 separate items the library redraws on every frame. This item draws each wash once, across all rows, giving 3 items. Nothing looks different.

**Planner-visible impact.** None intended (bands look identical: edges, dark mode, 15-minute zoom ticker movement, expanded-row tint).

**Where.** `_rebuildPass` zone blocks at 1536-1611 (ids set at 1554, 1576, 1605); ticker at 458-525 (reads `_pastZoneIds`, `_alertHorizonIds`, `_frozenHorizonIds`); CSS `frontend/styles.css` 1385-1405 (zone rules) and 1428-1432 (`.nonworking`, the precedent for ungrouped background items).

**What.** Emit `past-zone`, `alert-horizon-zone`, `frozen-horizon-zone` as single ungrouped background items; keep the `_*ZoneIds` arrays (now length 1) so the ticker and its `_pastZoneIds.length` guard are untouched; z-order by CSS `z-index`, never `top`/`height`. The heal's background loop then sees only blackouts and alert cells.

**Binding corrections.** Never set `top`/`height` on background items via CSS; keep the three `_*ZoneIds` arrays.

**Stacking-order hazard found while verifying the plan against vis's own stylesheet (not in the plan; the builder and the browser check must resolve it).** vis 7.7.3 gives every `.vis-item`, background items included, `z-index: 1` (selected bars 2), and its `.vis-background` and `.vis-foreground` containers are positioned but form no stacking context. Today every wash and every bar therefore tie at 1 and the bars win by DOM order. The plan's `z-index` ladder `.nonworking` 0 < `.past-zone` 1 < `.alert-horizon-zone` 2 < `.frozen-horizon-zone` 3 would lift the alert-horizon and frozen washes above the bars, and grouped bands that keep `z-index: 1` (blackouts, alert cells) would end up under the new zones, where today alert cells sit above them. The required end state: bars above every wash; and bottom to top gridline, nonworking, blackout, past, alert-horizon, frozen, alert cell. A safe way to get there is to make the background container its own stacking context (`.vis-itemset > .vis-background { isolation: isolate; }`, no layout effect) and give the background classes an explicit ladder inside it. **Resolved in the final fix wave:** isolation was measured on a scratch vis 7.7.3 page and rejected, because it lifts the foreground rows above the whole background layer (row tints and the Go To row paint over washes and alert cells, and an alert cell stops being the hit target). The shipped rule is `.vis-itemset > .vis-background { z-index: 1; }`, which restores today's relationships exactly: bars on top, alert cells above zones, horizon washes pass-through. Unit tests can only pin the CSS text; the owner-owed browser check is what confirms it.

**Also.** Create the three items only when there is at least one visible row (today no rows means no zone ids, and the ticker's early return depends on it).

**Tests.** Zone item shape (no `group`, kind zone, type background, class, `editable:false`); 3 items for 30 lines; the ticker's update list still covers the 3 ids (via a behaviour-neutral pure extraction of its update-building step); CSS ladder and no `top`/`height` on the zone rules.

**Acceptance.** Zone bands look identical in the browser (light and dark, expanded row, 15-minute zoom), bars stay on top of every wash, alert cells stay above the zones.

### Expected result of Wave 1

Post-drop and settle stalls gone (the "hitch after I move something"), rebuilds several times cheaper, a frame-time number in the Admin Cockpit. **Steady pan jitter unchanged** (about 25 ms at 3 d, 45-70 ms at 14 d on plant 1008).

### Verification

- Node: `npm run build && node --test tests/modules/scheduling/gantt.test.mjs tests/modules/scheduling/pv-drag.test.mjs` plus the new tests; all existing tests stay green. `npm run lint`, `npm run typecheck`, `npm run check:static-assets`, `npm run check:legacy-surface`.
- Browser (Azure pilot plant 1008, or local with `scripts/seed_frontend_audit.py --orders 1000|10000`): Admin Cockpit, Thread pane shows `Timeline.frame` and `Timeline.pan`; `Timeline._bench({days:3|14|30})` prints p50 / p95 / max. Checks: after a drop, the post-drop `Timeline.rebuild` and the settle are short (the rebuild still runs, since the gate never skips after a task write), and that setup bars and stack badges still update after an optimizer apply or an Inspector edit; settle refresh under 2 ms when nothing entered the window and still correct after a long pan; zone bands look identical (edges, dark mode, 15-minute zoom ticker movement, expanded-row tint) with bars above them; a rebuild after a filter change still dims and undims correctly; Go To, marquee, expand/collapse and plant switch unchanged.
- Added by the final fix wave (owner-owed browser checks): the expanded-row tint and the Go To row tint do not paint over the washes or the alert cells, and a Go To cell stays visible over the washes; a rejected drop springs back (`finish_cannot_hold`, `running_finish_locked`, `multi_drag_line_locked`); a click on the empty past area below the last row clears the selection; a ctrl-drag marquee starting there works.
- Expected after Wave 1: stalls gone, `Timeline.rebuild` several times cheaper when little changed, steady pan frames unchanged.

## Deferred options (documented, not authorised): the two mechanisms that fix the jitter

### Option T: transform pan (composite the gesture, redraw on a cadence)

**In simple English.** Picture the chart as a long strip of paper seen through a window. Today, every time the planner drags, vis re-draws the whole visible strip from scratch on every frame. Option T instead just slides the already-drawn strip under the window during the drag (cheap, 60 frames per second), and only re-draws properly every ~120 ms and when the drag ends.

**Design.** Keep vis's own drag; on each `rangechange(panmove)` apply `transform: translate(dx, scrollY)` to `.vis-panel.vis-center > .vis-content`, `.vis-panel.vis-top > .vis-time-axis.vis-foreground`, and the children of `.vis-panel.vis-background.vis-vertical` (axis grid, current-time bar, custom time bar); gate `tl._redraw` so vis's queued redraws are deferred while the gesture is active; commit (clear transforms, run `_origRedraw` synchronously in the same rAF) every 120 ms or more, or when |dx| reaches 20 % of the viewport, and on `panend`. The label panel and vertical scrollbar do not move. Ctrl+wheel zoom is untouched (its `rangechange` carries a wheel event). Vertical scroll gets the same treatment in a second step if the owner wants it. Self-disabling if `_redraw`/`_origRedraw` are not writable; per-user pref `ganttSmoothPan` default on, so one toggle returns today's behaviour. Pure helpers (`panTranslatePx`, `panShouldCommit`) in `frontend/scheduling/gantt-pan.mts`.

- **Planner impact.** Drag-pan at 60 fps; one real redraw (about 29 ms at 3 d) every ~120 ms instead of every frame; momentary blank strips at the leading edge on fast flicks (up to about 8 % of width at 1,000 px/s) until the next commit. Bars, selection, drag, hover, tooltips, Go To and filters: untouched.
- **Risk.** Medium-low and contained. Relies on vis private `_redraw`/`_origRedraw` (verified present and writable; a reviewer confirmed the throttle structure) and `props.scrollTop`. A stuck gate means no redraw until pointerup, so the pan flag needs the Wave 1 watchdog. Wave 1 item 2 (deferral) is a prerequisite so a rebuild never lands under a gated redraw.
- **Effort.** 2-3 days plus browser checks. Throwaway if Option C ships later (then the real redraw is about 9 ms and the bridge is unnecessary).
- **Does not scale.** The committed redraw still costs 29-70 ms and grows with orders; it hides the cost at the cadence rather than removing it.

### Option C: canvas item layer (bars drawn by us, vis keeps the chassis)

**Design.** A scene model plus a painter, with DOM-on-demand for hovered and selected bars so vis's drag contract and the existing 141 Gantt tests stay. Corrections from review: paint synchronously inside the `'changed'` handler (not via the heal's rAF, or bands lag bars by a frame); read theme tokens from `document.body` (dark tokens live on `body.dark`), repaint on a body-class MutationObserver and when `document.fonts` is ready; keep the foreground half of the heal until bars leave the page; repoint the ticker guard (`_pastZoneIds.length` also gates the 30 s lock scan), the TimelineNav blackout read (it reads blackouts from `_items`), `_syncNonWorking` / `_nwIds` (they write items directly), the alert-cell click and Go To cell lookups; settings checkbox plus 5 locale keys; a `settings:change` handler comparing old and new value; RipplePreview (`frontend/nimbus-intelligence.js` 2072 and 2094) looks up `.vis-item[data-id]` and must use the scene once bars are lazy. A background-only canvas layer ("Phase 1") is **not** a standalone deliverable (measured about 3 ms); it is just the first slice of the bars work. Two spikes are the real go/no-go items: (#1) the empty-row height floor, (#2) hover-to-materialise drag.

- **Planner impact.** Pan about 9 ms per frame at 1k orders and still about 10-12 ms at 3k orders / 70 lines; Ctrl+F on bars gone (accepted, D3); touch needs tap-then-drag; subtle text and hatch rendering differences, reviewed against the legend.
- **Risk.** Medium-high but contained by a flag with the page-element path intact until the last phase; the bar interaction hand-off (hover-materialise before pointerdown) is the main hazard and is proven or killed in the spike.
- **Effort.** Spike 2-3 days, then about 15-20 days for bars, backgrounds, setup bars and lanes, plus 2-3 days to delete the old path. Scales to the roadmap (50+ plants, 70+ machines per plant).

### Option S: stalls only (Wave 1, stop there)

Hitches after drops and at settle disappear; frames still 25-70 ms during a pan. Cheapest; does not meet the "solve jittering" ask by itself.

**Recommendation on record.** The plan recommended Wave 1 plus Option T (no canvas); the owner chose Wave 1 only. When the owner revisits: Option T is the low-risk next step (bars and drag untouched, per-user toggle, self-disabling); Option C is the scaling fix and should start with the measurement-only spike.

## Progress ledger

Implementers and reviewers append one row per task as they finish.

| Task | Commit | Status | Notes |
|---|---|---|---|
| 1 Instrumentation | 2105317 | Done, reviewed | Frame meter, `Timeline.pan`, `_panActive`, `_bench` |
| 2 Alerts gate + deferred rebuild | f2b729a + fix 8e0017c | Done, reviewed | Gate, deferral; fix: `task:remove` marks task data dirty (ghost bar) |
| 3 Settle refresh | 1f40e7b | Done, reviewed | Redraw only on DataView add/remove |
| 4 Rebuild equality diff | c160ccd | Done, reviewed | `visItemEqual`; skips unchanged DataSet writes |
| 5 Zones 90 to 3 | e02a69d | Done, reviewed | Three ungrouped washes plus z-index ladder |
| Final fix wave | 2167f41 | Done | Background `z-index: 1` (not isolation), past-zone pass-through, test hygiene, docs |

Merged to local main as a fast-forward on 2026-10-27 (main = 2167f41). Not pushed, not deployed. Owner browser check (spec checklist) still owed before deploy.

## Side issues to log (not fixed here)

- **Day-alert popup is one 1.36 s long task.** Opening a day-cell alert popup blocks the page for 1.36 s on plant 1008. Separate from pan; unscheduled.
- **`TimelineNav._cssVar` reads `:root`, but dark tokens live on `body.dark`** (`frontend/scheduling/gantt.mts` 3163-3167: `getComputedStyle(document.documentElement)`). The minimap is probably wrong in dark mode today; browser check owed. Option C needs the same fix for its own theme reads.
- **Stale line-count claim** in `frontend/scheduling/CLAUDE.md` (line 5): `gantt.mts` "(~5,550 lines)"; the file was 6,057 lines at main a618b69. Corrected in the final fix wave.
- Also noticed: the comment at `gantt.mts` 2735-2737 still says the ticker is "~line 291"; it is at 458-525.

## Context appendix

- **Who asked, when, why.** The owner (Trevor Holton) reported on 2026-10-26 that the Gantt "feels a little jittery moving around" and that he expects it to get worse with more data. He asked for options including a renderer-level change, with very high priority on a sharp, snappy feel, and then for lowest risk plus best long term. Three Sonnet reviewers checked every plan assumption against live code and the vis 7.7.3 source; a console experiment then measured exactly where a pan frame's time goes (tables above). After the findings, the owner asked, three times, what a named mechanism meant "in simple English" before deciding, and chose Wave 1 only because he is wary of breaking the finicky interaction layer.
- **Measurement setup.** Azure pilot, plant 1008 Mexicali, 966 orders, 30 lines (1,267 vis items including 295 background items), the plan records the measured build as image 5f89d2a; branch base is main a618b69. Measured through the Chrome MCP tab, which shares the owner's login.
- **Chrome MCP measuring caveats.** Time `tl._origRedraw()` (synchronous), never `tl.redraw()`: the public `redraw()` only marks dirty and queues the real redraw, so it measures about nothing. Awaiting `requestAnimationFrame` from the MCP tab stalls when the browser window is occluded, so use synchronous timings or `Timeline._bench` with the window visible. Close the Chrome side panel first: the MCP tab's viewport was 259 px wide, which shrinks every pan step and the number of visible bars.
- **Scope facts.** Wave 1 touches no migrations and no backend; the only non-gantt files are `frontend/styles.css` (item 5) and the test file.

## Things learned along the way

- vis `redraw()` = `itemSet.markDirty({refreshItems:true})` plus an rAF-throttled `_redraw`; the throttle is created from `_origRedraw` (`_redraw = throttle(_origRedraw)`), so timing needs both fields replaced.
- `Interaction._isDragging` is dead on real item drags: it is set only from the `timechange` handler (`gantt.mts` 5718-5724), and vis 7.7.3 emits `timechange` only for custom time bars. Drag-time row dimming already hangs off `onMoving` for that reason.
- The alerts rebuild after `alerts:change` is load-bearing: besides the conflict class it is the only path that refreshes setup bars, stack-depth badges, `_itemIdsByTask` and lock state after optimizer applies, grid or Inspector edits and undo.
- vis already culls rows outside the vertical viewport; shrinking the panel does not remove a floor of about 15 ms (per-group bookkeeping and forced layouts).
- A single bar move costs about 0.2 ms of layout, but vis forces 3-5 layouts per frame because it dirties far more than one bar.
- CSS containment, removing shadows and borders, and caching vis's group geometry gave no gain; over-rendering a wider window gave about 20 %, which is not enough.
- An earlier alert-cell canvas overlay was removed because it could not layer behind foreground items (`frontend/nimbus-intelligence.js` 2022-2029). Any canvas work must solve z-order, not just drawing.
- vis gives every item (backgrounds included) `z-index: 1` and leaves `.vis-background`/`.vis-foreground` without a stacking context; bars beat washes today only through DOM order at equal z-index. Any z-index above 1 on a background item puts it over the bars.
- The existing rig patterns for the Gantt tests: `nwWithPlant`/`nwFakeItems`/`laneRebuildHarness` (fake DataSets that record writes, around `_rebuildPass`) at `tests/modules/scheduling/gantt.test.mjs` 2526-2726 and 2612-2643, the Go To rig `_gotoLineDayRig` (rAF queue and mocked timers) at 3127-3155, and the pure `tickerShouldPush` tests at 887-896.
