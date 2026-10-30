# Gantt canvas item layer — design of record (deferred Option C)

> **Status: NOT authorised.** Owner decision D2 (2026-10-26): the owner is nervous about breaking the Gantt's finicky interaction layer (drag, resize, selection, marquee, Go To) and chose Wave 1 first (stall fixes plus measurement, merged 2026-10-27, main 2167f41 / 97e5269). This document is the design of record for when the owner revisits. Judge it against the Admin Cockpit `Timeline.frame` and `Timeline.pan` numbers that Wave 1 added, and against `Timeline._bench`. Parent spec: `docs/superpowers/specs/2026-10-26-gantt-pan-perf-design.md` (measurements, D1-D6, Option C summary).
>
> Every canvas number below is a **projection**, not a measurement. No canvas code exists. Every vis-timeline private-API claim is marked where it was not read in the source for this document; the Phase 0 spike turns them into facts. Line references are to `frontend/scheduling/gantt.mts` (6,359 lines at main 97e5269) and `frontend/styles.css`, and drift: re-find by function name.

## 1. In plain words

Today the Gantt draws every order bar as its own page element, and the library that owns them (vis-timeline 7.7.3) re-measures all the visible ones on every frame of a drag. That cost grows with the number of bars on screen, and it is the reason a sideways drag feels jittery (25-70 ms per frame against a 16.7 ms budget at 1,000 orders; it gets worse as plants grow).

Option C stops using page elements for bars. We keep the library for everything it does well (the time axis, row labels, scrolling, zoom, and above all its drag machinery) and draw the bars ourselves on one canvas laid over the chart. Only the few bars a planner is actually touching (hovered, selected, the Go To target) stay as real page elements, so dragging and resizing keep working exactly as they do now.

What a planner would notice: a smooth pan at any realistic size; Ctrl+F no longer finds order bars (accepted by owner decision D3); on a touch screen a tap selects a bar first and then a drag moves it; text and hatching on bars may look slightly different from today and are reviewed against the legend.

## 2. Why canvas, with the measurements

Source: the 2026-10-26 live experiments on the Azure pilot, plant 1008 Mexicali: 966 orders, 30 lines, 1,267 vis items (295 of them background items). One pan frame is one synchronous vis redraw (`tl._origRedraw()`), median of 12 `setWindow` steps.

| Configuration | 3 d zoom | 14 d zoom |
|---|---|---|
| Baseline (211 / 457 bars in the page) | **29 ms** | **70 ms** |
| All 295 background items removed | 26 ms | ~70-84 ms (noisy) |
| ItemSet empty (no items, 30 rows) | **7 ms** | **7 ms** |

What the numbers say:

- **Bars are 80-90 % of every frame.** The empty ItemSet costs about 7 ms (time axis 2-4 ms, 30 group rows about 4 ms). That 7 ms is the "chassis" that stays under Option C.
- **Background bands are about 10 %.** Removing all 295 saved about 3 ms. A backgrounds-only canvas is therefore **not a standalone deliverable**; it is only the first slice of the bars work.
- **53-60 % of a frame is forced-layout reads.** 326 layout reads per frame at 3 d (294 at 14 d), 3-5 forced full layouts per frame, the biggest single read an `offsetTop` on a row group (8.7 ms at 3 d, 14.7 ms at 14 d). These are vis's own write-then-measure pattern, repeated for every visible bar and row. One bar moved alone costs only 0.2 ms of layout; vis dirties far more than one bar.
- **Everything cheap failed.** CSS containment, dropping box-shadow/border-radius, caching vis's group geometry plus skipping its marker check plus caching axis character size (a prototype of "fork and patch vis"), over-rendering a window of plus or minus 0.5 viewport (about 20 % gain, still over budget), and vertical row culling (vis already does it; a floor of about 15 ms remains however few rows are in view) all failed to bring a frame under 16.7 ms at 3 d, let alone at 14-30 d.

**Expected with canvas** (projection): vis chassis about 7 ms plus canvas paint about 2 ms, roughly **9 ms per frame at 1,000 orders**, about **10-12 ms at 3,000 orders / 70 lines**. Cost no longer scales with the number of DOM bars. This is the scaling fix for the roadmap (50+ plants, 70+ machines per plant, root `CLAUDE.md`).

## 3. Architecture (hybrid: vis stays the chassis)

**vis keeps:** the time axis, row labels and groups and their layout, range/zoom/pan gestures, vertical scroll, the custom and current-time bars, and **all of its drag machinery**: `editable.updateTime` / `updateGroup`, `snap`, `onMoving`, `itemsAlwaysDraggable` (set in `Timeline.init`, `gantt.mts` ~386-403).

**New:** one `<canvas id="gantt-scene">` (`position:absolute; inset:0; pointer-events:none`, sized with the device pixel ratio the way `TimelineNav._ensureSize` does it, ~3321) inside `.vis-panel.vis-center`, under `.vis-content`. It paints every bar, band and cell. Its base is transparent, so vis's axis grid and `.vis-current-time` show through.

**Live items.** The vis ItemSet holds only "live" items: hovered, selected (capped at about 150), the Go To target, and (Phase 2 only) the expanded row's bars. Everything else exists only in the scene model.

**DOM-on-demand.** On pointer move the layer hit-tests the scene and materialises the bar under the pointer into `Timeline._items`, followed by a synchronous `_tl.redraw()`, so Hammer (vis's gesture library) finds a real DOM box **before** `pointerdown`. After that the whole existing drag contract is untouched and stays byte for byte: `Interaction._onDataSetUpdate` (~5636), `_commitSingleDrop` (~5879), production-version capture and re-apply, `lockLeftEdge` (~2842), the multi-drag latch, the echo guard. The existing Gantt tests stay (141 when the parent spec was written; at main 97e5269 `gantt.test.mjs` has 184 test blocks and `pv-drag.test.mjs` 15; recount at the start).

**Selection.** A selection larger than the live cap keeps the first N as live DOM items; the rest draw their selection ring on canvas. Companions in a multi-drag are moved by the commit loop (`_onDataSetUpdate`), not by vis, so they need not be live.

**Touch.** A tap selects (which materialises the bar) and a following drag moves it. Documented limitation: a touch has no hover, so the bar does not exist as a DOM item until the tap materialises it. (Touch drag today works through vis's own gesture handling with `itemsAlwaysDraggable`; it was not tested for this document.)

## 4. New modules

All under `frontend/scheduling/`, each needing a `.gitignore` line for its compiled `.mjs` (compiled output is gitignored; see lines 42-44 for the existing Gantt entries).

| Module | Role | Contents |
|---|---|---|
| `gantt-scene.mts` | Pure, no DOM, no imports from vis | `buildScene(input) -> Scene`: per row, `Float64Array` start and end plus ids sorted by start, lane index, and a draw-state record per bar. `hitTest(scene, rows, px, py, view)`. `rectsInRange` (marquee). `cullRow` (binary search). Flag setters `setDimmed` / `setProfile` / `setSibling` / `setGoto` / `setSelected` / `setSetupDim` / `setFirmed`. `classNameFor(state)`: the inverse of `navBarStyle` (~3009), so the CSS class string for a live item is derived from the same state; a parity test keeps CSS and canvas honest. |
| `gantt-canvas-painter.mts` | DOM-free, takes a ctx-like interface (testable with a recording fake) | Layers: L0 bands, L1 setup bars and order bars, L2 rings, spotlight, marquee. `measureText` LRU plus ellipsis by cached prefix widths. Labels only on bars at least 24 px wide, pills at least 48 px. Hatch patterns from cached 16 x 16 tiles. Theme tokens read once per theme change. |
| `gantt-canvas-layer.mts` | Browser glue | The canvas element, DPR sizing, `rowsFromVis(tl)`, the `'changed'` and `rangechange` hooks, the pointer-move hit test and hover event, live-set reconcile, theme repaint. |

The scene and painter are pure on purpose: nearly all the logic is testable in Node without a browser, the same way `gantt-lanes.mts` and `nonworking-spans.mts` are.

## 5. Row geometry

The painter needs each row's top and height, and whether vis considers it visible.

- **Primary:** `itemSet.groups[line].top / .height / .isVisible`. This is the same private surface the existing heal uses through `item.parent` (`_healBackgroundBands`, ~731-772, reads `parent.top`, `parent.height`, `parent.isVisible`; typed in `VisInternalTimeline`, ~4543-4558). **Not verified:** no code in this repo reads `itemSet.groups` today, and the vis source is not vendored locally; confirm the property name and shape in the 7.7.3 bundle during Phase 0. The vis version is pinned by the SRI hash in `frontend/index.html` line 22, so a vis upgrade cannot change it silently.
- **Fallback:** read `.vis-foreground .vis-group` offsets once per `'changed'` (the existing `scrollToLine`, ~2573, and `_fitHeightMeasured`, ~2101, already do this).
- **Boot self-check:** compare the primary source against the DOM fallback on the first paint; on a mismatch or a missing property, `ErrorLog.warn` once and fall back to the DOM path (section 10).
- **x:** `(ms - win.start) / span * Timeline._centerWidthPx()` (~602). This is vis's own linear map, so canvas bars and live DOM bars land on the same pixel.
- **y:** `group.top + Timeline._getVScroll()` (~2071). vis's scroll convention is negative (0 at top, negative when scrolled down).
- **Paint synchronously inside the `'changed'` handler.** Not through a second `requestAnimationFrame`, or the bands lag the live bars by one frame during every pan. The ticker and theme repaints reuse the last `'changed'` geometry snapshot. The existing `'changed'` hooks are at ~473 (calibration, one shot) and ~481 (heal, rAF-coalesced); the canvas hook must be registered separately and must not be coalesced. Spike item: confirm `'changed'` fires on every pan frame (the heal's comment assumes it does).
- **Empty-row height floor.** Once bars leave the page, a row with no live item may collapse to zero height, and the canvas then has no row to paint in. Preferred fix: CSS `.vis-labelset .vis-label .vis-inner { min-height }` driven by `_cachedRowH` (~250, set by the one-shot calibration). Fallback: one invisible full-span spacer item per row, which pollutes `getEventProperties(...).what` and so is second choice. This is spike item #1.

## 6. Hit-testing and events

The scene index replaces vis's DOM lookup wherever the code asks "what bar is under the pointer".

| Call site today | Change |
|---|---|
| Mousedown arming of the pan peak tracker (`Interaction.install`, ~4770-4788, `getEventProperties(e)` then `_isBusinessTimelineItem`) | `Interaction._resolveHit(e)` from the scene (new) |
| Context menu (~4825-4837, `p.what === 'item'`) | `_resolveHit` |
| vis `click` wrapper `Interaction._onClick` (~5437) and `_onDoubleClick` (~5492) | `item = hoveredBarId ?? props.item`. "Click on empty canvas clears the selection" (`props.what !== 'item'`, ~5463) must consult the scene hit first, or every click on a canvas bar would read as empty and clear the selection. |
| Alert-cell click (~4810-4815, `getEventProperties` then `_onAlertCellClick`) | Keep `getEventProperties` for `group` and `time`; cell existence comes from `scene.alertCells` |
| Hover card (`itemover` / `itemout`, ~5157-5182) | Driven by the layer's own hover event, same `props.item` shape |
| Marquee `refreshItemRects` (~5253-5267, reads `itemSet.items[id].dom.box`) | `scene.rectsInRange`. Side benefit: bars outside the plus or minus 90 day DataView window, which the DOM version misses, become selectable by marquee. |
| Keyboard | Unchanged: it acts on `Selection` |
| `Timeline.focus(id)` (~2183, uses `_tl.focus`) and `Interaction._onClick` center-on-click (~5484) | Compute the window from the task span plus `scrollToLine`; `_tl.focus` needs a DOM item |
| RipplePreview (`frontend/nimbus-intelligence.js` ~2072 and ~2094: `.vis-item[data-id]`) | Must read the scene once bars are lazy; it asks the DOM for rectangles of up to five downstream bars |

Dimmed bars and ghosts have `pointer-events: none` today (`styles.css` 2744-2748, 2881-2885), so the scene hit test must skip them too.

## 7. Styling parity

Every `.vis-item` state class becomes a **draw state** composed in CSS cascade order. Source rules in `frontend/styles.css`:

| State | CSS source | Canvas treatment |
|---|---|---|
| Base bar shape | 1174-1181 (`.vis-item.vis-range`: radius 4, 11 px / 600) | Rounded rect, clipped text |
| Standard / firmed fill (`order-standard`, `order-firmed`; firmed text carries a lock emoji prefix) | 1252-1253 | Fill from `--bar-standard` / `--bar-firmed` |
| Focus outline (`alert-focus`) | 1183-1186 | 2 px dashed `--fg` outline (rev 4, 2026-10-30; was the red `conflict-order`) |
| Split segment, continuation, last | 1258-1266, pill 1267-1271 | Inner keyline; dashed left edge; solid right edge; mono pill |
| Distribution child, pill, sibling highlight | 1281-1290 | Inner keyline; letter-and-count pill; 2 px accent ring outside |
| Selected | 1294-1296 | Two-tone ring. Live DOM item up to the cap; canvas-drawn only beyond it |
| Profile match fills and rings, including the capacity / planning / warn exceptions | 1300-1323 | Six category fills and the severity inner ring composed as the CSS does (the exceptions switch the ring to the dark ink on amber and orange) |
| Go To target bar and day cell | 1334-1340 | Two-tone ring; cell uses inset 3 px plus 5 px ring |
| Go To spotlight (other bars fade to .25) | 1341-1345 | Painter alpha for 2.5 s; **skip the fade under `prefers-reduced-motion`**. Target row and label tint (`goto-row`, 1346-1348) stay DOM on the row |
| Row drag ineligible | 1224 (`opacity .35` on `.vis-group`) | Painter `rowAlpha .35`. `.vis-group` opacity no longer cascades to canvas bars, so the layer must read the group class set by `_groupClassName` (~1435) |
| Expanded row tint | 1221-1222 | Stays on the vis row (DOM) |
| Dimmed (filter) | 2744-2748 (opacity .12, desaturate, no pointer events) | Alpha .12 plus grey fill; excluded from hit test |
| Ghost, ghost-conflict (multi-drag preview) | 2881-2891 | Only if ghosts survive as DOM items. They are written as `Interaction._onTimeChange` updates (~6020), which is likely dead on real item drags (see parent spec). Decide in Phase 2 |
| Blackout (hatch, italic label) | 1367-1379 | 45 degree hatch tile; text |
| Alert cells (error, warn, calendar) | 1388-1404 | Translucent tint from the `--alertcell-*` tokens; error and calendar cells also draw a 1 px edge |
| Zones: past, alert horizon, frozen horizon | 1406-1431, ladder 1364 | Three full-width washes; the alert and frozen washes have a 3 px right edge |
| Day gridlines | 1438-1447 | 1 px line, stronger token on month starts |
| Non-working shading | 1457-1462 | Wash from `--zone-nonworking` |
| Setup bar, setup conflict, setup missing, setup drag dim | 7011-7047 | Steel hatch, error hatch, solid warning bar with "!" marker, alpha .18 |

**Paint order = today's DOM order** (bottom to top): day gridline, non-working, blackout, past, alert horizon, frozen horizon, alert cells (the ladder at `styles.css` 1361-1363), then setup bars, order bars, rings. Transparent canvas base so the axis grid and the now line show through.

**Z-order spike (#3).** The canvas sits in `.vis-panel.vis-center` under `.vis-content`. `.vis-panel.vis-center` carries a background today (`styles.css` 1195: light `--bg-elev`; 5813-5814: dark `--bg`, `!important`) which would paint over a canvas placed below it, and may need to move to `.vis-content`. Check translucency under the now line, in light and dark. This exact failure is on record: an earlier alert-cell canvas overlay was removed because it could not layer behind foreground items (`frontend/nimbus-intelligence.js` 2022-2029).

**Legend as acceptance checklist.** `gantt-legend.mts` plus the `.lg-*` rules (`styles.css` ~7414 onward, section "GANTT BOARD LEGEND") draw a miniature board from the same tokens. Every legend key must look the same in the canvas path.

**Theme.** Read tokens from `document.body`, **not** `:root`: dark tokens live on `body.dark`. `TimelineNav._cssVar` (~3465-3468) reads `getComputedStyle(document.documentElement)` and has this bug today (the minimap is probably wrong in dark mode; browser check owed). Repaint on a body-class `MutationObserver` and when `document.fonts` is ready. **Do not** add a `Timeline.*` call in `nimbus-intelligence.js`: it trips the legacy-surface ratchet (the existing `DarkMode.set` repaint hook, ~2526, calls `NIMBUS.TimelineNav?.render?.()` and is already on the surface). Use the body-class observer instead.

## 8. What happens to each coupled piece

| Piece (today) | Under canvas |
|---|---|
| `_rebuildPass` (~1571) | `buildScene` plus the unchanged group diff plus a reconcile of live items only. DataSet work falls from about 1,300 items to 30 or fewer. Wave 1's `visItemEqual` (~2880) still applies to live items. |
| Ticker zone pushes (~504-536, `zoneTickerUpdates` ~2906) | `scene.nowMs` plus a dirty L0, no DataSet write. **The `_pastZoneIds.length` guard at ~506 also gates the 30 s lock scan (~546), so repoint it, do not just delete it.** |
| `TimelineNav._collect` (~3360) | Reads `scene.bars`. It currently reads blackouts from `_items` (~3387). |
| `_syncNonWorking` (~2299), `_nonWorkingDesired` (~2264) | Keep the pure builder and the hysteresis; write `scene.nonworking`. `_nwIds` (~226, ~1972, ~2314) and the TimelineNav `oldData` skip go away. |
| `GanttFilter._doApply` (~4434), `_applyProfileMatchClasses` (~1216), `Interaction._applyDistSiblingHighlight` (~5594), `_setGotoClassIds` (~1124) and `markGotoTask` / `markGotoCell` (~1146, ~1155), `dimSetupForDrag` / `finishSetupDrag` (~1496, ~1512), `rebuildSetupForLines` (~1387) | Scene flag setters plus a `syncLiveClass` for live items |
| `_writePatches` (~946), `_itemPatchFor` (~898), `_applyTaskPatch` (~915) | `scene.patchBar(id)` plus `_items.update` only when the bar is live |
| `DependencyOverlay.render` (~3722) | Uses `rowsFromVis`. Fixes its non-numeric line sort (`.sort()` at ~3790, against the numeric-aware `_visibleLines`). Note the overlay is dead today (no `#chk-show-deps`; see the scheduling `CLAUDE.md` follow-up). |
| `scrollToLine` (~2573) | `scene.laneOf(id)` instead of reading `.dom.box` |
| `_healBackgroundBands` (~731) | Keep its foreground `repositionX` half while any bars are DOM; delete when none are |
| `_purgeItemSetGhosts` (~2377), the `_heal` ladder (~2420), `_decorateLane` (~1017), `_splitRelocations` (~933), `_laneIds` (~298) | Deleted by Phases 3 and 4 |
| `_visItems` DataView (~372), `_syncViewWindow` (~2217), `_refreshViewNow` (~2341) | Deleted; there is nothing to cull. Wave 1 made `_refreshViewNow` cheaper, which no longer matters. |

**Wave 1 pieces that stay:** `installFrameMeter` and `Timeline.frame` (~2962), `_panActive` and `_endPanGesture` (~264, ~648), the alerts gate in `_onStore` (~775), `_scheduleAlertsRebuild` (~1535).

## 9. Scaling levers and cost model

Apply only as the bench demands.

- **Viewport culling, always:** binary search per row on the sorted start array, plus skip any row where `row.isVisible` is false.
- **L1 band cache:** an offscreen canvas about 2 x viewport width; on pan, re-blit; invalidate on zoom, vertical scroll or data change. About 46 MB at DPR 2. Enable above about 1,500 visible bars. Never cache the full content height.
- **Level of detail:** bars under 2 px become a 1 px tick; more than 3 bars per pixel column become a density fill.
- **2D canvas only.** WebGL instanced quads are a documented escape hatch, gated on L1 paint over 8 ms at 3,000 orders / 30 d **with** the band cache.

Projected paint cost (estimates; the **measured chassis of about 7 ms must be added to each**):

| Scenario | 3 d zoom | 30 d zoom |
|---|---|---|
| 1k orders, 30 rows | about 4-5 ms | about 4-5 ms |
| 3k orders, 70 rows | about 8 ms | about 5-10 ms |
| 10k orders, 70 rows | pan about 5 ms (blit); zoom about 25 ms | same |

These figures come from the 2026-10-26 design review. They are more conservative than the headline "about 2 ms of canvas paint" in section 2, because they include band layers, overlays and label measurement. The spike settles which is right.

## 10. Rollback switch

- User-tier pref **`ganttCanvasBars`** in the settings catalog (`frontend/shell/application-shell.mts` ~197, same shape as `alertProfileGanttHighlight`: `category: 'workflow', type: 'boolean', tier: 'user', region: false`), read through `Store.pref` (`store.mts` ~1132).
- The catalog entry **does not render a control**. A hand-written checkbox (the settings panel does this for `us-ap-highlight`, `application-shell.mts` ~908-919) plus label and hint keys in **all five locales** are required.
- A `settings:change` handler that compares the old and new value; the event fires on every PATCH acknowledgement, not only on a change of this key (`store.mts` ~1119, ~1125).
- `?gantt=dom|canvas` URL override for support and A/B timing.
- **Default off** until Phase 2 has soaked on the pilot. The DOM path stays intact until the last phase, so rollback is a toggle, not a deploy.

## 11. Phases

| Phase | Scope | Effort | Exit criteria |
|---|---|---|---|
| **0 Spike** (ships nothing) | Prove (#1) the empty-row height floor, (#2) a hover-materialised bar drags normally one event before `pointerdown`, (#3) z-order and translucency under the now line in light and dark. Also: synchronous paint with no one-frame lag, fractional-DPR crispness (125 % and 150 % Windows scaling), font repaint, a live-node census, confirm `itemSet.groups` and `'changed'` behaviour. Produce frame numbers. | 2-3 d | Go/no-go: #1, #2 and #3 pass; frame numbers within 2 ms of the projection |
| **1 Backgrounds to L0** | Zones, nonworking, gridlines, blackouts, alert cells on canvas; theme and font repaint; the flag and the settings control. **Not a standalone deliverable** (measured about 3 ms gain); only the first slice. | 4-6 d | L0 pixel-matches the DOM bands in the legend, light and dark; no regression with the flag off |
| **2 Bars, DOM-on-demand** | Scene, painter, hit test, live-set reconcile, hover materialise, marquee and click via `_resolveHit`, ticker and TimelineNav repointed. Expanded row stays DOM. | 8-12 d | `.vis-item` count at most 30 during a pan; pan p95 at most 8 ms (plus chassis) at 30 d / 1k; all existing tests green plus new ones; the browser checklist in section 13 |
| **3 Setup bars and lanes** | Setup bars and the expanded-row lanes on canvas | 4-6 d | No `subgroup` left; the heal ladder collapses to one try/catch |
| **4 Delete the DOM path** | `_items` holds only live items; delete the pieces listed in section 8; rewrite `frontend/scheduling/CLAUDE.md`; release note (Ctrl+F) | 2-3 d | `gantt.mts` about 800-1,000 lines smaller; full suite green |

Total about **20-30 engineer-days** plus browser verification per phase. (The parent spec's own estimate is 2-3 d spike plus 15-20 d plus 2-3 d to delete; this table adds explicit per-phase verification.) Phase 0 is the cheap way to find out whether the rest is worth doing.

## 12. Risks

| Risk | Mitigation |
|---|---|
| vis internals (`itemSet.groups`, `_getScrollTop`, `body.domProps.center.width`) can change | Version pinned by SRI; boot self-check; DOM fallback; typed in one interface (`VisInternalTimeline`) |
| Hover-materialise race: pointer goes down before the real DOM bar exists | Synchronous `redraw()` after the add; spike #2 |
| Empty rows collapse | CSS min-height from `_cachedRowH`; spacer item as fallback; spike #1 |
| Z-order against the panel background and the now line | Spike #3; precedent in `nimbus-intelligence.js` 2022-2029 |
| Text antialiasing, emoji lock glyph, ellipsis differ from DOM | Design review against the legend; measure with cached prefix widths |
| Expanded row mixes canvas and DOM bars in Phase 2 | Exclude its bars from canvas; the live cap must never evict them |
| Click semantics change (empty-canvas clear) | One `_resolveHit` used by every call site (section 6) |
| Row opacity no longer cascades to canvas | `rowAlpha` from the group class |
| Tests | About 30-40 of the existing `_items.update(className)` assertions move to scene-flag assertions; **none are deleted** |
| Printing | `Printer` (`orders.mts` ~3087) was read for `vis-`, timeline and canvas references and has none (it builds a row preview and calls `window.print()`); confirm in Phase 2 that no print path captures the Gantt |
| Memory with the band cache | About 46 MB at DPR 2; enable only above about 1,500 visible bars; never cache full height |
| Ctrl+F and screen readers lose the bars | Accepted by D3. Optional hidden accessibility list (about 1 day): a visually hidden `<ul>` of the viewport's bars behind a user pref, refreshed on rebuild |
| Mixed DPR and fractional zoom blur | Spike checks 125 % and 150 %; snap rect edges to device pixels |

## 13. How to prove it

Use the Wave 1 instruments, add four, and compare DOM and canvas in the same tab.

- **Existing:** `Timeline.frame` (one real vis redraw), `Timeline.pan` and `Timeline.pan.maxGap` (Admin Cockpit Thread pane), and `Timeline._bench({days, steps, stepPx})` (~663; prints p50 / p95 / max, the `.vis-item` count and long tasks).
- **Add:** `Timeline.canvas.paint.L0`, `.L1`, `.L2`; `Timeline.live.materialise`; and `Timeline.visRedraw` only if the paint cannot be separated from `Timeline.frame` (the frame meter already times the vis redraw, and under canvas that is exactly the chassis). Durations only, never counts, in the Cockpit (`PerfMonitor.record(name, ms)`).
- **Data sets:** plant 1008 on the pilot, and a synthetic set from `scripts/seed_frontend_audit.py --orders 1000|10000`.
- **Matrix:** DOM versus canvas, at 3 d and 30 d.
- **Targets:** p50 at most 4 ms plus chassis; p95 at most 8 ms plus chassis; max at most 16 ms at 30 d / 3k orders; `.vis-item` at most 30 during a pan; `Timeline.rebuild` at most 30 ms at 3k orders.
- **How:** time `tl._origRedraw()` or `_bench`, **never** `tl.redraw()` (it only marks dirty). `requestAnimationFrame` awaits from the Chrome MCP tab stall when the window is occluded; keep the window visible and close the Chrome side panel (the MCP tab viewport was 259 px wide).
- **Browser checklist per phase:** drag, resize, multi-drag, marquee, Go To (bar and cell), expand and collapse, filter dim, profile-match fills, setup bars, keyboard, dark mode, 15 minute zoom ticker, light and dark legend comparison, fractional DPR.

## 14. Alternatives rejected on record

- **Full custom renderer** (draw the axis, rows, scroll and drag ourselves). 25-40 engineer-days and no measurable gain over the hybrid, because the vis chassis is only about 7 ms; it would also re-own every gesture vis already handles.
- **Commercial libraries** (Bryntum, DHTMLX, FullCalendar resource-timeline). None is a drop-in; every one would re-own the drag contract (snap, finish-anchored placement, the production-version drop rule) and each carries licensing and CDN caveats against the SRI-pinned, same-origin setup.
- **Fork and patch vis-timeline.** Prototyped on 2026-10-26: caching group geometry, skipping the marker check and caching axis character size gave no gain (27 ms vs 23-28 ms at 3 d; 57 ms vs 44-50 ms at 14 d). Rejected outright (D2).
- **Transform pan (Option T).** Slide the already-drawn strip during a drag and redraw every ~120 ms. Documented in the parent spec; a bridge that hides the cost at a cadence rather than removing it, and throwaway if Option C ships. The low-risk next step if the owner wants relief without touching bars.

## Context appendix

- **Who and when.** The owner, Trevor Holton, reported on 2026-10-26 that the Gantt "feels a little jittery moving around" and that he expects it to worsen with more data. He asked for options up to a renderer-level change, then for lowest risk plus best long term.
- **The decision chain (2026-10-26).** Three Sonnet reviewers checked every plan assumption against live code and the vis 7.7.3 source; a console experiment measured where a pan frame's time goes (section 2). The owner then asked, three times, "what is X in simple English" about a named mechanism before deciding. The strip-of-paper analogy (the chart as a long strip seen through a window) is what unlocked the choice between sliding the drawn strip and redrawing it. He chose **Wave 1 only** (D1, D2) because he is wary of breaking the finicky interaction layer, accepted losing Ctrl+F on bars if Option C ever ships (D3), declined horizontal wheel pan (D4), and was told steady jitter would remain after Wave 1 (D5).
- **Measurement source.** Azure pilot, plant 1008 Mexicali, 966 orders, 30 lines, 1,267 vis items (295 background), measured build image 5f89d2a (branch base main a618b69), through the Chrome MCP tab that shares the owner's login. Experiments interleaved against baseline in the same tab, p50 of 8-12 steps, machine noise about 20 %.
- **Wave 1 landed.** Merged to local main 2026-10-27 as a fast-forward (main 2167f41, then docs commit 97e5269), pushed, and deployed as nimbus:v138. It added `Timeline.frame`, `Timeline.pan`, `_panActive`, `_bench`, the alerts gate and deferred rebuild, the settle-refresh skip, the rebuild equality diff and the three-item zone washes. Owner browser checks were still owed before a pilot deploy. This document is meant to be judged against its numbers.
- **Source documents.** Parent spec `docs/superpowers/specs/2026-10-26-gantt-pan-perf-design.md`; domain rules `frontend/scheduling/CLAUDE.md`; palette and legend `DESIGN.md` and `gantt-legend.mts`; deployment `docs/DEPLOYMENT.md`.
- **Line drift found while writing this.** The parent spec cites `Timeline.init` at 323-529 (now 360-565), the ticker at 458-525 (now 504-561), `TimelineNav._cssVar` at 3163-3167 (now 3465-3468), `_rebuildPass` at 1387-1883 (now 1571), `_refreshViewNow` at 2169-2183 (now 2341), and `_onStore` at 638-739 (now 775). The "141 existing tests" figure is also stale (184 plus 15 now).

## Things learned along the way

- vis `redraw()` is `itemSet.markDirty({refreshItems:true})` plus an rAF-throttled `_redraw`, and the throttle is built from `_origRedraw`; timing needs both fields replaced (`installFrameMeter`, ~2962). Time `_origRedraw`, never `redraw()`.
- vis forces 3-5 full layouts per frame (326 reads) because it writes positions and then measures, per bar and per row. One bar's move costs 0.2 ms; the frame cost is the walk, not the move.
- `isolation: isolate` on `.vis-itemset > .vis-background` was measured to lift the foreground rows above the whole background layer (row tints and the Go To row paint over the washes, and alert cells stop being the hit target). Use `z-index: 1` on the container instead (`styles.css` 1364). Any canvas z-order work starts from this fact: vis gives every item z-index 1 and `.vis-background` and `.vis-foreground` form no stacking context, so equal z-index plus DOM order decides today.
- The alerts gate never skips after a task write (a drop always marks task data dirty), so the post-drop rebuild still runs; Wave 1 made it cheaper and moved it off the pan. Under canvas that rebuild shrinks again (scene rebuild plus 30 DataSet writes).
- vis already culls rows outside the vertical viewport; shrinking the panel does not remove a floor of about 15 ms (per-group bookkeeping, the item walk, the axis, forced layouts). Vertical culling is not the lever.
- The hover card, the Go To window and the marquee all read DOM geometry today (`itemover`, `.dom.box`); under canvas they read the scene. The hover card is event-driven, not pointer-move driven, so it can stay on the same `props.item` shape.
- `Interaction._isDragging` and `_onTimeChange` are likely dead on real item drags (vis emits `timechange` only for custom time bars), so drag-time dimming already hangs off `onMoving`; any drag-preview design must hang off `onMoving` and the DataSet update too.
- An earlier alert-cell canvas overlay was removed because it could not layer behind foreground items (`frontend/nimbus-intelligence.js` 2022-2029). Z-order, not drawing, is the real risk.
- Dimmed bars and ghosts are `pointer-events: none` today, so the scene hit test has to skip them to keep the same click behaviour.
- A settings-catalog entry does not render a control, and `settings:change` fires on every PATCH acknowledgement; any flag needs a hand-written checkbox, five locale keys and an old-versus-new comparison.
