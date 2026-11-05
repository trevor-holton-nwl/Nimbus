# Gantt jitter improvement: options

**Status:** investigation only, 2026-11-04. Nothing here is implemented or authorised. Written from three read-only reviews of the live code at main f9b4ce7 (`frontend/scheduling/gantt.mts`, 6,800 lines) plus the vis-timeline 7.7.3 source. Verify any line reference against live code before acting; the older specs cite stale lines.

**Goal:** the Gantt stays snappy while panning and scrolling with thousands of orders. Today it jitters at about 1,000 orders (25-70 ms per frame) and will worsen with more data. The owner is open to a bigger engine change ("a V12 where a V6 was") but does not want to re-invent the wheel, and is wary of breaking the finicky interaction layer (drag, multi-drag, edge scroll, marquee, keyboard, Go To).

## 1. Where the time goes

- NIMBUS's own per-frame code is about 2-3 ms after Wave 1 (minimap about 1 ms, band heal about 1 ms, listeners under 0.3 ms).
- The other 26-67 ms is vis-timeline itself. It redraws every visible bar as DOM each frame, and 53-60% of that is forced layout from its own write-then-measure pattern.
- Measured earlier on plant 1008 (966 orders, 30 lines, 1,267 vis items): 29 ms at 3-day zoom, 70 ms at 14-day zoom. An empty ItemSet costs 7 ms.
- Only two mechanisms change the steady per-frame cost: **transform pan (T)** and a **bar layer we own (C)**. Everything else trims at the edges.
- vis-timeline 7.7.3 is still the latest release. There is no upgrade path.

## 2. Options, ranked by gain per risk

### A. Cheap, behaviour-neutral trims (about 3-6 ms per frame plus the settle hitch)

| # | Item | Where | Gain | Risk | Effort |
|---|---|---|---|---|---|
| A1 | Hysteresis on the settle-time redraw: refresh the +/-90 d view window only when the window moved more than a third of the buffer (reuse the `_syncNonWorking` inner-band rule) | `_refreshViewNow` and `_refreshView` | up to about 18 ms once per pan gesture (a 16 ms full redraw plus a 1-3 ms re-filter); real value depends on how often `Timeline.refreshView.redraw` fires | none to drag | hours |
| A2 | Restrict `_healBackgroundBands`: skip while a pan is active and run once at gesture end, iterate displayed items only, log instead of silently swallowing a throw | `gantt.mts` heal pass | about 1 ms per frame; also removes a possible hidden abort that may make today's "under 1 ms" figure an artefact | band drift could reappear mid-pan until settle; test behind `_bench` | hours |
| A3 | Minimap: draw static layers to an offscreen canvas when dirty, blit plus now marker and viewport rect per frame | `TimelineNav._paint` | about 1 ms per frame | none | half a day |
| A4 | Drop the inline-styled content `<span>` in each bar (5 DOM nodes to 4); move its styles onto `.vis-item-content` | `_itemForTask` content, `styles.css` | unmeasured, likely 1-3 ms per frame at 14 d | must override vis's default 5 px padding exactly; check dist-part and split labels | hours |
| A5 | Ticker push threshold `_ZONE_MIN_PX` 0.5 to 2 px | ticker code | idle smoothness only (quarters idle redraws at fine zooms) | none | minutes |
| A6 | Axis labels via cached `Intl.DateTimeFormat` format functions | vis options | part of the 2-4 ms axis cost | label strings must match in all five locales | a day |
| A7 | `showTooltips:false` and route the three titled item kinds (setup bars, split segments, blackouts) through the existing hover card | vis options, hover card | small and spiky | visible change (vis tooltip becomes NIMBUS card) | half a day |
| A8 | `xss:{disabled:true}` | vis options | tens of ms on a full rebuild, zero per frame | loses defence in depth (content is already escaped) | minutes |
| A9 | Memoise the setup observation on rebuild | rebuild pass | one hitch per drop, not pan; check `Timeline.rebuild.desiredMap` p50 first | stale setup bars if the memo key is wrong | a day |

Not options: `throttleRedraw` (deprecated, a no-op in 7.7.3), `cluster` (behaviour change plus its own per-redraw cost), `preferZoom` / `rollingMode` / `maxMinorChars` (no perf relevance).

### B. Transform pan (Option T)

**Idea:** while the user drags, slide the already-drawn strip with a CSS transform on the compositor and do a real vis redraw only every 100-300 ms, on distance, or on settle. Pref `ganttSmoothPan`, self-disabling.

**Why it is feasible (verified in vis 7.7.3):**
- `Core._redraw` is an instance property looked up at call time, and Wave 1's `installFrameMeter` already replaces it, so it is the single choke point for pan, wheel scroll, `setOptions` and DataSet writes. `_origRedraw` stays untouched.
- `Range._onDrag` is absolute from frozen `touch.start/end`, so the live range never drifts. The offset is exact: `dx = -(liveStart - drawnStart) * widthPx / spanMs`.
- vis already positions the centre vertically with `translateY`, so we write `translate(dx, scrollTop)` and the next real redraw resets it for free.

**Sketch:**
1. New pure module `frontend/scheduling/gantt-pan.mts` (translate math, commit rule, adaptive cadence = 4 x last frame clamped 100-300 ms). Add the compiled `.mjs` to `.gitignore`.
2. Extend `installFrameMeter`: gate `_redraw` during a pan and record a pending flag; record the drawn window after each `_origRedraw`; self-disable if `dom.center`, `timeAxis.dom.*`, `range`, `props` or `currentTime` are missing, or `hiddenDates` / `rtl` are set.
3. In `_onVisRangeChange`: apply the transform or commit. Commit on cadence, distance, span change, width change, or any non-pan `rangechange` (ctrl-wheel zoom, pinch, rebuild `setWindow`).
4. Transform targets: `dom.center` (`translate(dx, scrollTop)`), the two axis containers (`translateX`), `.vis-current-time` (use `margin-left`, and pause its timer with `tl.currentTime.stop()` because vis owns its `transform`), custom-time bars (`translateX`).
5. `_endPanGesture` and the top of `_rebuildPass` force a commit. A watchdog term in the gate (no panmove for 300 ms opens it) makes a stuck flag self-heal. `try/finally` around the commit.
6. Cover the minimap drag path (`_navPanActive`): it calls `setWindow` per pointermove, which the panmove gate does not see. Item-drag and marquee edge scroll stay ungated.
7. Pref `ganttSmoothPan` (default on) in `frontend/shell/application-shell.mts` plus a settings control and five-locale strings. New PerfMonitor mark `Timeline.pan.commit`. Extend `_bench` with a gesture mode that drives `touch/panstart/panmove/panend` (today's `_bench` is `byUser:false` and never exercises the gate).
8. Optional: vertical wheel via `tl.on('scroll')` with a 100 ms idle commit.

**Honest expectation:** transform frames cost an estimated 1-3 ms (an estimate from code paths, not a measurement). Each commit still costs 25-70 ms and grows with orders, so T hides the cost at a cadence instead of reducing it. At 3 d it reads as smooth with a faint tick; at 14 d a 70 ms stall every 120 ms is still most of the time stalled unless commits are distance-driven (see B2). T alone does not scale.

| Cadence | Commits per second | Main-thread share at 3 d (29 ms) | at 14 d (70 ms) |
|---|---|---|---|
| Today (every frame) | 60 | 100% | 100% |
| T at 120 ms | about 8 | about 23% | about 56% |
| T at 250 ms | 4 | about 12% | about 28% |
| T plus over-render (B2), distance 0.4 viewport | up to 2.5 | about 7% | about 17% |

**Risks:**
- Blank leading strip: vis draws only `[start, end]` for bars, bands, gridlines and axis labels. At about 1,000 px/s and a 120 ms cadence that is about 120 px (about 10% of a 1,200 px panel) until the commit.
- Wide-bar labels jump at commit (`align:'auto'` shifts the label inside the bar). Cosmetic; worse at 14-30 d.
- Vertical drag or wheel reveals empty rows beyond vis's 2 px overscan until commit.
- A forced commit is needed when a rebuild lands mid-gesture, or the strip shows pre-rebuild bars for up to 200 ms.
- A stuck gate means no redraw until the next gesture end (mitigated by the watchdog and the `finally`).
- Layer promotion of `.vis-content` creates a stacking context and a compositor layer; it must be checked against the Wave 1 `z-index: 1` background ladder and the marquee overlay.
- Private API surface grows (`dom.center`, `timeAxis.dom.*`, `currentTime.bar/stop/start`, `range`, `props.scrollTop`, `body.domProps.center.width`). All are own writable properties in the SRI-pinned 7.7.3; self-disable on shape mismatch.
- `Timeline.frame` will record commits only during pans, and `Timeline.pan.maxGap` will grow to the cadence by design; note it in the Cockpit.

**Nothing in NIMBUS reads DOM X geometry during a vis background pan.** Item lookup uses the DOM under the pointer, time comes from the live range, and `centerContainer`'s bounding box is not transformed. The only things that must be suspended are vis's throttled redraw and the now-line timer. The only things that must be added are the nav flag and the rebuild commit.

### B2. Over-render companion to T (needs a fresh owner decision)

Patch `vis.timeline.components.items.RangeItem.prototype.isVisible` and `BackgroundItem.prototype.isVisible` (exported by the standalone bundle) to test `start < range.end + pad && end > range.start - pad` with `pad = 0.5 * span`, only while `ganttSmoothPan` is on. Then commits can be distance-driven (`|dx| >= 0.4 * width`) with no blank bars, about 3x fewer stalls at 14 d. The axis is not over-rendered, so keep an axis-only `tl.timeAxis.redraw()` (2-4 ms) on the time cadence. Earlier measured as a standalone 20% gain (20 vs 23-28 ms at 3 d) and **rejected by the owner in 2026-10-26 decision D2 on that basis**. Its value as T's companion is a different argument and must be re-raised, not assumed.

### C. A bar layer we own (the "V12")

vis keeps the time axis, row labels, Range pan/zoom, vertical scroll, now line and the drag machinery. Bars are drawn from a pure scene model; the bar under the pointer is materialised as a real vis item before `pointerdown`, so the existing drop contract (`_onDataSetUpdate`, `_commitSingleDrop`, `lockLeftEdge`, multi-drag latch) is preserved. Design of record: `docs/superpowers/specs/2026-10-27-gantt-canvas-item-layer-design.md` (not authorised; 20-30 engineer-days, projected about 9 ms per frame at 1k orders and 10-12 ms at 3k orders / 70 lines).

**Two painter variants should be spiked against each other:**
- **C1 canvas painter:** projected fastest; loses Ctrl+F on bars, DOM accessibility text, and every bar CSS rule becomes a draw state.
- **C2 DOM-scene painter (new, not in the spec):** same scene model and hit-test, but emits our own `<div class="nb-bar ...">` nodes in a sibling layer under `.vis-foreground`, positioned by `transform` only with fixed row heights and `contain: strict`, never measured. Keeps Ctrl+F, screen-reader text, every existing bar CSS rule, dark mode and print for free, and `title` tooltips. About 600 visible nodes is fine; off-screen bars must be windowed. If it lands within about 2 ms of canvas at 600 visible, it is the lower-risk V12.

**The spec is stale in ways that matter (verified against live code):**
- The 2026-11-03 drag work added four vis-private dependencies the spec does not account for: `itemSet.touchParams.itemProps` (frozen drag set, `gantt.mts` about 6457), `itemSet._onDrag` (edge auto-scroll, about 6513-6546), `itemSet.hammer` (press recogniser off, about 456), `body.emitter` (cancel restore, about 6400).
- Edge auto-scroll re-runs `_onDrag` for live vis items only, so canvas-drawn companions would stop following the pointer during an edge scroll. Either the painter feeds them the leader's delta or the live cap (about 150) must cover the whole drag set.
- `getEventProperties` returns `what:'background'` over a canvas bar. Four sites must consult the scene hit-test first: pan-vs-click arming (about 5049), alert-cell click (about 5087), context menu (about 5100), and `_onClick` (about 5740, which clears selection and the Go To target on an empty hit, a real hazard).
- The spec's "ghost" question is moot (ghost code deleted 2026-11-03; the `.vis-item.ghost*` CSS at about `styles.css:3013-3023` is dead).
- The 7 ms empty-ItemSet chassis was measured at 30 rows, never at 70. vis does per-group bookkeeping for every group every frame even for culled rows (about 4-5 ms per extra 30 rows), so the chassis could be 12-15 ms at target scale and eat the budget before any bar is painted.

**Interaction surface a bar layer must preserve (counted from live code):** about 40 vis public-API call sites, 12 vis-private touches in 8 functions, about 25 DOM-selector sites on vis markup, 12 className composers/differs, about 48 CSS rule-sets on `.vis-item`, two files outside the Gantt that read bar DOM. Tests: `tests/modules/scheduling/gantt.test.mjs` has 219 `test(` blocks and 68 lines touching vis shapes; roughly 25-30 tests pin private shapes and would need re-rigging. The minimap already parses className into state (`navBarStyle` about 3151, `navBarCategory` about 3161), a ready-made inverse.

**Spike (1-2 days, console only, no commits) and go/no-go bar** at 5,000 orders / 70 lines / about 600 visible bars / 30 d zoom:
- Day 0 (half day): seed `scripts/seed_frontend_audit.py --orders 5000` (check it supports 70 lines), record `Timeline._bench({days:3|14|30, steps:30, stepPx:20})` baselines at 1k/3k/5k orders and 30 vs 70 lines, and the empty-ItemSet chassis at 70 lines.
- Day 1: T-check, then scene plus hit layer. Keep only selected/hovered ids plus backgrounds in the DataView, paint rects on a throwaway canvas synchronously in `'changed'`, confirm `'changed'` fires per pan frame. Hand-off test: on pointermove add the hit bar to the live set, call `tl._origRedraw()` synchronously, press-drag it. Does Hammer drag it, does `onMoving` fire, does the drop reach `_onDataSetUpdate`? 20 tries. Check z-order under `.vis-current-time` in light and dark.
- Day 2 (half day): the C2 painter on the same scene, same matrix, and check Ctrl+F finds a bar.
- **Pass:** `Timeline.frame` p50 at most 6 ms and p95 at most 8 ms (chassis plus paint). **Go with LOD / band cache:** p95 at most 12 ms. **Stop, canvas does not pay:** p95 above 16 ms (fall back to A plus B). Also required: `.vis-item` count at most 30 during pan, hover-to-drag hand-off 20/20 with no missed `pointerdown`, empty rows keep `_cachedRowH`, `Timeline.rebuild` at most 30 ms at 5k. If the 70-row chassis alone exceeds 10 ms, that is its own finding and the next lever is row virtualisation (D below).

### D. Row virtualisation (windowed vis groups)

vis keeps items whose group is absent without drawing them and re-attaches them on `_onAddGroups`, so `_items` can stay whole while `_groups` is windowed to the vertical viewport plus margin, with two spacer groups keeping `scrollTop` stable. Gain is the per-group floor only: about 4-5 ms at 30 rows, 10 ms or more at 70 rows, nothing at 14 visible rows of 14. **High risk:** drag edge auto-scroll (the target row must materialise while `itemSet.touchParams` is live), `scrollToLine` (needs a `.vis-group` for every visible line), `_fitHeight`, expanded-row lanes, band heal parents. 3-5 days plus a spike. Whether vis's group `visible:false` also skips the per-group layout reads is unknown without the vis source.

### E. Rejected or ranked last

- **Patch vis in place (pan fast path on the ItemSet prototype):** the 2026-10-26 prototype cached reads but left the write-then-read boundaries, so the browser still did 3-5 full layouts per frame. A fast path that bypasses `Group._redraw` measurement and writes only `transform` could give 30-50% at 3 d but stays O(visible bars) and over budget at 14-30 d. A worse version of T. Do not build.
- **Replace vis's ItemSet with our own windowed DOM, keep vis Range/axis:** re-owns the entire interaction layer (`_onDragStart/_onDrag/_onDragEnd`, `_onSelectItem`, `itemFromTarget`) for a per-frame cost no better than C2. 25-40 days.
- **Library swap:** nothing is a drop-in; every one is a rewrite of about 70% of `gantt.mts` plus the drag rules in `frontend/scheduling/CLAUDE.md`. Verify licences and prices with procurement; the figures below came from web searches with conflicting sources.

| Library | Renders | Notes |
|---|---|---|
| Bryntum Scheduler Pro | DOM, virtualised rows and time | Best technical fit (setup buffers, 10k+ events, multi-drag). Commercial per-developer licence, private npm, 6-10 week rewrite plus procurement. |
| DHTMLX Gantt / Scheduler | DOM, smart rendering | GPLv2 free edition is a grey area for a corporate app; task-tree oriented; weaker fit. |
| Syncfusion, FullCalendar timeline, Mobiscroll, Kendo, DevExtreme | DOM | Syncfusion community licence excludes Newell by revenue; none have setup bars or scale past a few thousand. No. |
| Frappe Gantt, SVAR | SVG / framework-bound | Too small or framework-only. No. |
| ECharts custom series, Konva, PixiJS, d3 + canvas | canvas / WebGL | Not Gantt libraries; no built-in drag semantics. Konva or Pixi are candidate painters or hit-testers inside option C, not replacements. |

## 3. Recommended sequence (each step gates the next)

1. **Phase 0, measure (half a day, console only):** baselines at 1k/3k/5k orders and 30 vs 70 lines, the 70-row chassis, vertical-scroll frame time, Cockpit `Timeline.refreshView.redraw` hit rate and `Timeline.rebuild.desiredMap` p50, then the transform console spike (below). No commits.
2. **Phase 1, trims plus transform pan (about 4-5 days):** A1-A5, then B behind `ganttSmoothPan`. Re-measure. Re-raise B2 with the numbers if blank strips or commit frequency still hurt at 14 d.
3. **Phase 2, the V12 spike (1-2 days, decision gate):** only if Phase 1 leaves p95 over target at 5k orders / 70 lines. C1 vs C2 spike with the thresholds above. If it passes, update the canvas spec for the four new vis-private touches before building (20-30 days). If the chassis dominates, evaluate D instead.

Estimated outcomes are reasoned from code and earlier measurements, not new profiles. Treat them as hypotheses until Phase 0 runs.

## 4. Console spike for transform pan (Phase 0)

Run on the live Gantt tab with the window visible and the Chrome side panel closed. It drives vis's own `Range` through `tl.emit(...)` so every NIMBUS listener runs as in a real gesture, compares today vs transform at two cadences, and restores everything. Set `cadenceMs: 1e9` to see the pure-transform ceiling; repeat at 14 d by calling `tl.setWindow` first. Confirm `window.__NIMBUS_WORKBENCH.Timeline._tl` is reachable in the pilot build (`app-entry.mjs` about line 78).

```js
(async () => {
  const tl = window.__NIMBUS_WORKBENCH.Timeline._tl;
  const raf = () => new Promise(r => requestAnimationFrame(r));
  const dom = tl.dom, axisFg = tl.timeAxis.dom.foreground, axisBg = tl.timeAxis.dom.background, nowBar = tl.currentTime.bar;
  const customBars = Object.values(tl.customTimes || {}).map(c => c.bar).filter(Boolean);
  const rect = dom.centerContainer.getBoundingClientRect();
  const ev = (dx, type) => ({ type, deltaX: dx, deltaY: 0, center: { x: rect.left + rect.width / 2, y: rect.top + 40 },
                              srcEvent: {}, preventDefault() {}, stopPropagation() {} });
  const widthPx = () => tl.body.domProps.center.width;
  const win = () => ({ s: tl.range.start, e: tl.range.end });

  async function gesture({ mode, frames = 90, stepPx = 12, cadenceMs = 120 }) {
    const orig = tl.getWindow(), realRedraw = tl._redraw, gaps = [], commitMs = [];
    let drawn = null, lastCommit = performance.now();
    const setTx = dx => { dom.center.style.transform = `translate(${dx}px, ${tl.props.scrollTop}px)`;
      axisFg.style.transform = axisBg.style.transform = `translateX(${dx}px)`; nowBar.style.marginLeft = `${dx}px`;
      customBars.forEach(b => b.style.transform = `translateX(${dx}px)`); };
    const clearTx = () => { axisFg.style.transform = axisBg.style.transform = ''; nowBar.style.marginLeft = '';
      customBars.forEach(b => b.style.transform = ''); };
    const commit = () => { clearTx(); const t0 = performance.now(); tl._origRedraw(); commitMs.push(performance.now() - t0);
      drawn = win(); lastCommit = performance.now(); };
    if (mode === 'transform') { tl._redraw = () => {}; tl.currentTime.stop(); drawn = win(); }
    tl.emit('touch', ev(0, 'touch')); tl.emit('panstart', ev(0, 'panstart'));
    let prev = performance.now();
    for (let i = 1; i <= frames; i++) {
      await raf(); const now = performance.now(); gaps.push(now - prev); prev = now;
      tl.emit('panmove', ev(-stepPx * i, 'panmove'));
      if (mode === 'transform') {
        const w = win(), dx = -(w.s - drawn.s) * widthPx() / (w.e - w.s);
        if (now - lastCommit >= cadenceMs) commit(); else setTx(dx);
      }
    }
    tl.emit('panend', ev(-stepPx * frames, 'panend'));
    if (mode === 'transform') { commit(); tl._redraw = realRedraw; tl.currentTime.start(); }
    await raf(); await raf(); tl.setWindow(orig.start, orig.end, { animation: false });
    const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)] ?? 0;
    console.table({ mode, cadenceMs, p50_gap: q(gaps, .5).toFixed(1), p95_gap: q(gaps, .95).toFixed(1),
      max_gap: Math.max(...gaps).toFixed(1), commits: commitMs.length, p50_commit: q(commitMs, .5).toFixed(1),
      items: document.querySelectorAll('.vis-item').length });
  }
  await gesture({ mode: 'today' });
  await gesture({ mode: 'transform', cadenceMs: 120 });
  await gesture({ mode: 'transform', cadenceMs: 250 });
})();
```

Pass: transform p50 gap near 16.7 ms while today sits at 33 ms or more; commits cost what `Timeline.frame` says; the strip slides without tearing; axis and now line stay aligned with bars; hovering a bar mid-gesture still fires `itemover`. Also record a DevTools Performance trace to confirm no layout blocks between commits.

## 5. Side findings (logged, unfixed)

- `Interaction._isDragging` is live (set on the first `onMoving` frame, read by the pointer tracker and drag-time deferrals); the 2026-10-26 spec calls it dead.
- RipplePreview (`frontend/nimbus-intelligence.js` about 2578) queries `.vis-item[data-id]`, but vis writes `data-*` attributes only when `dataAttributes` is set and it is not, so the selector likely never matches today. Needs a browser confirmation. The canvas spec lists it as a live dependency.
- `_healBackgroundBands` wraps its whole walk in one `try/catch` (about line 839); the first throw (an in-window item in a vertically-culled row has no `dom`) silently ends the pass.
- The 1 s ticker's `_items.update` (about line 584) is outside `_suppressEvents`, so each push also runs `Interaction._onDataSetUpdate` (cheap guard) and a full vis redraw.
- `DependencyOverlay` is documented dead but still subscribes to both range events (about lines 3895-3896). Harmless.
- `gantt.mts` line count in CLAUDE.md (about 6,380) and the spec line refs are stale (6,800 now).
- `frontend/scheduling/CLAUDE.md` / `styles.css` carry dead CSS: `.vis-item.ghost` / `.ghost-conflict` (about `styles.css:3013-3023`) and probably `.setup-drag-dim`.
- Vertical wheel scroll runs the same full redraw as a pan (29-70 ms); it was never measured.

## 6. Could not be determined without a browser profile

- Whether `_healBackgroundBands` completes or aborts on the pilot, and its real cost.
- How often `Timeline.refreshView.redraw` fires per settle on real data (decides A1's value).
- The real cost of a transform frame (estimated 1-3 ms), whether Chrome keeps `.vis-content` as a persistent compositor layer across a gesture, and the first-frame raster cost of promoting it.
- How many of the 3-5 forced layouts per frame come from `_updateScrollTop`'s `scrollTop` writes (`verticalScroll:true`) vs the group `offsetTop` reads.
- Visual severity of the blank strip, the label jump and the empty-row effect at 120 vs 250 ms cadence.
- Stacking and z-order after layer promotion against the Wave 1 background ladder and the marquee overlay.
- The vis 7.7.3 internals the canvas review recalled from memory (phase queue, `dirty` gating, `_applyGroupHeight` change check, whether group `visible:false` skips bookkeeping). The bundle is not vendored; read the unpkg UMD during a spike.
- Whether `scripts/seed_frontend_audit.py` can emit a 70-line plant.
- Library prices and licence terms.

## Appendix: Context and things learned

**Context.** On 2026-11-04 the owner asked for a Fable investigation (extra high, up to three agents) of Gantt jitter with thousands of orders, wanting a possible "V12 for a V6" without reinventing the wheel. Three read-only reviewers ran in parallel: (1) an audit of the live pan, scroll and settle path, (2) transform-pan and windowing feasibility against the vis 7.7.3 source, (3) canvas and engine-swap alternatives, including a library survey. The owner then asked that the options be written to this doc with no implementation. Prior work and decisions: 2026-10-13 ticker fix (commit 757dd86, v113); 2026-10-26/27 Wave 1 (stall fixes plus instrumentation, merged, deployed v138; owner decision D2 deferred T and C and rejected over-render as a standalone 20% gain); earlier specs `docs/superpowers/specs/2026-10-26-gantt-pan-perf-design.md` and `2026-10-27-gantt-canvas-item-layer-design.md`.

**Things learned.**
- The remaining cost is structural vis layout, not NIMBUS code. Wave 1's measured post-fix NIMBUS overhead is 2-3 ms per frame.
- The Wave 1 frame meter proved `_redraw` is writable, so transform pan has a ready choke point; `_origRedraw` must stay untouched.
- The canvas spec silently went stale after the 2026-11-03 multi-drag and edge-scroll work; any build must start with a spec update.
- A commit is never cheaper under T; only its frequency drops. Over-render is what turns time-driven commits into distance-driven ones.
- A third painter option (C2, transform-only `<div>`s) keeps the accessibility, search, CSS parity and print features that the canvas design accepted losing.
- The empty-ItemSet chassis scales with row count, not bar count, so a 70-line plant may have a floor that bars-only work cannot beat.
- Measure with `tl._origRedraw()` timings or `_bench`, never `tl.redraw()` (that only marks dirty). Awaiting rAF from a Chrome MCP tab stalls when the window is occluded. The owner wants no Chrome verification by the assistant; browser checks are owner-owed.
