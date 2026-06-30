# NIMBUS 2.0 — Principal-Level Vision Review

> A "shoot for the stars" review of high-leverage, transformative improvements for NIMBUS, scoped to the vanilla JS / one-new-file constraint, anchored in the existing module architecture.

---

## Context

NIMBUS is a vanilla JS production scheduling app (9,537 lines `app.js` / 27 IIFE modules / single `Store` reactive pub-sub) used by Newell schedulers and planners. It already has solid bones: a `Sandbox` what-if mode, 10-level `UndoStack`, `TimelineNav` minimap, `DependencyOverlay`, `Alerts`, `Utilization`, and an `Engine` with three optimization modes (SPT / changeover-group / combined). Scale target is 50 plants × 70 lines = **3,500+ lines**.

The opportunity is not to rewrite — it is to layer **operational intelligence, cinematic interaction, and confidence-under-pressure** on top of what exists. The single new file (`nimbus-intelligence.js`) is reserved as a holster for the heaviest new modules (Time Machine, Command Palette, Confidence engine, Stress Heatmap, Daily Briefing) so they don't bloat `app.js` further.

Every idea below is graded against a real scheduler workflow: a planner with a customer on the phone, a maintenance ticket on screen 2, and a coffee getting cold.

---

# Executive Summary

NIMBUS is already further along than most factory-floor scheduling tools. The strategic gap is **explainability + ripple + recovery** — schedulers don't trust optimizers they can't see, they fear drags they can't undo, and they lose minutes hunting through plants/lines/orders that don't fit on one screen. Five capabilities would move the product from "competent internal tool" to "best-in-class scheduling cockpit":

1. **Command Palette (Cmd+K)** — fuzzy jump to any order/line/plant/action. Eliminates scroll fatigue at 3,500-line scale. Hours of cumulative time saved weekly.
2. **Schedule Time Machine** — scrubbable history with named auto-snapshots before every risky action. The single biggest unlock for *confidence under pressure*.
3. **Ripple Preview Overlay** — Alt-hover on any order shows ghost-positions of every downstream task that would shift. Drags stop being scary.
4. **Confidence Score + Stress Heatmap** — one number (0-100) and one canvas overlay tell you whether today's schedule is fragile, where, and why. Replaces guesswork.
5. **Multi-Scenario Branches** — elevate `Sandbox` from binary enter/exit to git-style named branches, switchable in a dropdown. Schedulers can hold three plans simultaneously: "today," "if line 5 breaks," "if rush order lands."

These are not features — they are **postures**. Together they shift NIMBUS from reactive ("a tool to enter schedules") to proactive ("a copilot that catches problems before you commit them"). All five are achievable inside the one-new-file constraint.

The competitive moat: SAP APO, Asprova, Preactor, and Plex all show you a Gantt and let you drag boxes. None of them feels alive. NIMBUS can.

---

# Highest Impact Ideas — Ranked

| # | Idea | Impact | Complexity | Fits Constraint |
|---|------|:------:|:----------:|:---------------:|
| 1 | Command Palette (Cmd+K) | 10 | 4 | ✅ |
| 2 | Schedule Time Machine (scrubbable history) | 10 | 6 | ✅ |
| 3 | Ripple Preview Overlay (Alt-hover) | 10 | 5 | ✅ |
| 4 | Confidence Score + Stress Heatmap | 10 | 6 | ✅ |
| 5 | Multi-Scenario Branches (elevate Sandbox) | 9 | 5 | ✅ |
| 6 | Schedule Diff Viewer ("what changed since yesterday") | 9 | 4 | ✅ |
| 7 | Smart Conflict Resolver (3 ranked options) | 9 | 5 | ✅ |
| 8 | Daily Briefing on App Load | 9 | 3 | ✅ |
| 9 | Bottleneck Pulse + Downstream Trace | 9 | 4 | ✅ |
| 10 | Drag Physics (momentum + magnetic snap) | 8 | 4 | ✅ |
| 11 | Constraint Tuner (weighted optimize) | 8 | 4 | ✅ |
| 12 | Mass Reschedule Lasso | 8 | 5 | ✅ |
| 13 | Order DNA Strip (changeover similarity) | 8 | 3 | ✅ |
| 14 | Causality Tracer (action blame log) | 8 | 6 | ✅ |
| 15 | Time Compression Lens (fisheye Gantt) | 8 | 6 | ✅ |
| 16 | Predictive Drag Targets (glowing slots) | 8 | 5 | ✅ |
| 17 | Cinematic Optimization Playback | 7 | 5 | ✅ |
| 18 | Auto-Snapshot on Risk | 7 | 2 | ✅ |
| 19 | Capacity Forecast Strip (4-week mountains) | 7 | 4 | ✅ |
| 20 | Shadow Schedule Overlay (last week ghost) | 7 | 3 | ✅ |
| 21 | Recipe-Based Sequence Suggestions | 7 | 5 | ✅ |
| 22 | Floating Inspector Cards (multi-pin) | 7 | 3 | ✅ |
| 23 | Focus Mode (dim everything else) | 7 | 2 | ✅ |
| 24 | Triage Mode (auto-prioritize alerts) | 7 | 4 | ✅ |
| 25 | Schedule Time-Lapse Recording | 7 | 5 | ✅ |
| 26 | Voice-Activated Reschedule | 6 | 5 | ✅ |
| 27 | Air Traffic Control View | 6 | 7 | ✅ |
| 28 | Production Weather Radar | 6 | 7 | ✅ |
| 29 | Ambient Wall-Display Mode | 6 | 3 | ✅ |
| 30 | Generative Schedule Variations (5 thumbnails) | 6 | 6 | ✅ |
| 31 | Gamepad Haptic Alerts | 5 | 3 | ✅ |
| 32 | Eye-Tracking Idle Pause | 4 | 6 | ✅ |

---

# UI / UX Innovations

### 1. Command Palette (Cmd+K)
**Why it changes the game.** At 3,500 lines and 50 plants, scrolling is the silent killer of velocity. A schedulers' day is interrupted constantly — "find PO 47823," "jump to line 12," "open the optimizer for plant 1006." Every one of those is currently a click-trail. Cmd+K collapses them all to <2 seconds.

**UX feel.** Press Cmd+K → frosted-glass overlay slides in. Type "47823" → top hit is the order, second hit is its line, third is its plant. Arrow keys + Enter. Or type "optimize" → action item. Or type "blackout 3pm" → blackout block jump-to. Like Linear, Notion, VS Code — schedulers will recognize it instantly.

**Feasibility (vanilla JS).** Trivial. Single-page overlay, fuzzy-match on a flat index rebuilt from `Store` on publish. No dependencies needed.

**Complexity: 4 / 10.** **Impact: 10 / 10.** **Fits constraint: ✅**

**Implementation.**
- Add to `nimbus-intelligence.js` as `NIMBUS.CommandPalette` module.
- Listen for `Ctrl/Cmd+K` globally (capture phase, in `Interaction` or directly).
- Build index from `Store.tasksArr`, `Store.lines`, `Store.plants`, and a static `actions[]` registry: `{label, run, scope}`.
- Render overlay in a `<dialog>` element (native modal, ESC closes, focus trap free).
- Fuzzy match: simple subsequence-with-bonus algorithm (50 lines).

**Browser APIs.** `<dialog>` (showModal), `backdrop-filter: blur(20px)`, `KeyboardEvent` capture, `requestAnimationFrame` for result highlight.

**Why competitors don't have it.** SAP APO, Asprova, Plex Schedule all come from a click-driven design lineage. Schedulers there learn 200 menu locations. Cmd+K thinking is web-native, not ERP-native.

---

### 2. Ripple Preview Overlay (Alt-hover)
**Why it changes the game.** The #1 reason planners refuse to touch a schedule under pressure is fear of downstream consequences. NIMBUS already does auto-reflow — but the user *commits the drag first* and *learns the damage second*. Inverting that order is the unlock.

**UX feel.** Hold **Alt** and hover any order. Every order that would shift if you moved this one ±1 hour appears as a translucent ghost-bar at its new position, color-graded by shift magnitude (yellow = small, red = large). Release Alt → ghosts vanish. Drop the order while Alt is held → the ghosts solidify; commit happens with zero surprise.

**Feasibility (vanilla JS).** Medium. Requires cloning the relevant tasks, running `Engine.autoReflow()` on the clone without publishing, and rendering ghost items in vis-timeline (or as an absolute-positioned canvas/SVG overlay above it).

**Complexity: 5 / 10.** **Impact: 10 / 10.** **Fits constraint: ✅**

**Implementation.**
- Extend `Interaction` module: on `mouseover` of a `.vis-item` while `e.altKey`, capture task ID.
- Add `Engine.previewReflow(taskId, deltaMs)` — pure function, returns `{id, newStart, newEnd}[]` without mutating Store.
- Render ghosts via a sibling `<div>` overlay positioned over vis-timeline using `timeline.getItemRange()` + `timeline.timeToScreen()` (vis-timeline exposes these).
- CSS: `.ripple-ghost { opacity: 0.35; border: 1px dashed; pointer-events: none; }`.

**Browser APIs.** `KeyboardEvent.altKey`, `requestAnimationFrame` throttling, CSS `mix-blend-mode: screen` for layering.

**Why competitors don't have it.** Most schedulers ship a "what if" mode that requires entering a separate workspace. Inline preview at hover-time requires the optimizer to be cheap enough to run synchronously — which only works if your engine is JS-fast, which only works in a single-page app.

---

### 3. Confidence Score (live, top-right)
**Why it changes the game.** Right now, "is today's schedule okay?" is a question the planner answers by scanning alerts, scrolling utilization, eyeballing the Gantt, and forming a vibe. Replace the vibe with a number.

**UX feel.** A single 0-100 number in the top toolbar. Color band: red <40, amber 40-70, green 70+. Below it, a tiny sparkline showing the last 30 minutes of confidence (did the planner just make things worse?). Click the number → side drawer breakdown: *"−12 from overlapping orders on Line 7. −8 from blackout proximity on Line 3. −5 from changeover density on Line 1. +3 from light Friday."*

**Feasibility (vanilla JS).** Easy. Pure computation over existing `Alerts`, `Utilization`, and changeover proximity. Already have all the inputs.

**Complexity: 6 / 10** (mostly tuning the score weights). **Impact: 10 / 10.** **Fits constraint: ✅**

**Implementation.**
- New `NIMBUS.Confidence` in `nimbus-intelligence.js`.
- Composite: `score = 100 − w₁·alertPenalty − w₂·overloadPenalty − w₃·changeoverPenalty − w₄·blackoutProximityPenalty + w₅·slackBonus`.
- Subscribe to `Store.publish('tasks')` / `Store.publish('alerts')` → recompute (cheap, < 5ms).
- Render: small inline SVG sparkline (60×24 px), text number, click-handler opens existing `Modal` with breakdown.
- Sparkline: rolling buffer of last 30 samples in module memory.

**Browser APIs.** `Store` pub-sub (existing), inline SVG, CSS animated number tween via `Number.prototype.toFixed` + RAF interpolation.

**Why competitors don't have it.** Most planning tools surface alerts as a list. Aggregating alerts into a single emotional signal is a *consumer-software* mindset, not enterprise.

---

### 4. Stress Heatmap Overlay
**Why it changes the game.** The Gantt today shows *where things are scheduled*. The heatmap shows *where the schedule is fragile*. Two different questions, both critical.

**UX feel.** Toolbar toggle: ☀️ Normal | 🌡️ Stress. In Stress mode, every Gantt cell gets a translucent heat color — cool blue = relaxed, deep red = stressed. Stress = (utilization × changeover density × downstream criticality × blackout proximity). The eye instantly finds the red zones. Hover a red cell → tooltip: *"108% util, 3 changeovers, blocks 4 downstream orders."*

**Feasibility (vanilla JS).** Medium. Compute matrix per (line, day) — same shape as `Utilization.computeMatrix()`. Render as Canvas overlay above vis-timeline.

**Complexity: 6 / 10.** **Impact: 9 / 10.** **Fits constraint: ✅**

**Implementation.**
- Extend `Utilization` with `computeStressMatrix()` returning `Map<line, Map<dayKey, stressScore>>`.
- Add `<canvas id="stress-overlay">` absolutely positioned over the vis-timeline `.vis-foreground`.
- On Store publish, re-render the canvas: for each (line, day), draw a colored rect using `timeline.getItemRange()` to translate dayKey to pixels.
- Use OffscreenCanvas for compute if needed (rare at this scale).

**Browser APIs.** Canvas 2D, `OffscreenCanvas`, CSS `mix-blend-mode: multiply`, `ResizeObserver` to keep overlay sized to timeline.

**Why competitors don't have it.** Heatmap thinking comes from observability / SRE (Datadog, Grafana). Manufacturing UIs are still in spreadsheet aesthetics. NIMBUS borrowing from observability is a bet on where planners' brains are evolving.

---

### 5. Drag Physics (momentum + magnetic snap + elastic resistance)
**Why it changes the game.** Dragging in vis-timeline is binary: it follows the cursor exactly until you drop. Real schedulers want *feel* — they want a drop to magnetically snap to a shift boundary, they want resistance when they drag into an overloaded slot, they want a satisfying flick.

**UX feel.** Flick an order — it glides 3 seconds and decelerates onto the next valid slot, like swiping a card in iOS. Drag toward a blackout → the cursor feels heavy (visual resistance via cursor-lag CSS). Drag near a shift boundary → magnetic pull (last 5% of distance auto-completes). Drop onto an overloaded slot → bar shakes "no" before snapping back.

**Feasibility (vanilla JS).** Medium. vis-timeline allows `onMove` callbacks. We can intercept the position before commit, apply physics in JS, and override.

**Complexity: 4 / 10.** **Impact: 8 / 10.** **Fits constraint: ✅**

**Implementation.**
- In `Interaction`, hook vis-timeline's `onMoving` callback: receive proposed position, apply transforms.
- Magnetic snap: if `|proposed - nearestShiftBoundary| < threshold`, return shiftBoundary.
- Resistance: scale `proposedDelta = rawDelta * (1 − overloadFactor)` if dropping into overload.
- Shake animation on illegal drop: CSS keyframe `@keyframes shake { 0%,100% { transform: translateX(0); } 25% { translateX(-4px); } 75% { translateX(4px); } }`.
- Momentum on release: track velocity in last 100ms (pointermove deltas), `requestAnimationFrame` deceleration over 300-500ms.

**Browser APIs.** Pointer Events, `performance.now()`, CSS animations, vis-timeline `onMoving`.

**Why competitors don't have it.** Physics-based interaction is the domain of native mobile design. Bringing it to manufacturing software is a tonal signal: *this tool respects the user's senses*.

---

### 6. Time Compression Lens (horizontal fisheye Gantt)
**Why it changes the game.** Schedulers oscillate between two needs: *zoomed-out context* (see the week) and *zoomed-in detail* (move a 2-hour order precisely). Today, that means zoom in, lose context; zoom out, can't drag precisely. Fisheye breaks the tradeoff.

**UX feel.** Hover the Gantt with **Shift held** — pixels under your cursor expand 4× horizontally, with smooth falloff in both directions. Like macOS Dock zoom but horizontal and temporal. You see Monday-Friday compressed, but the 4 hours around your cursor are 16× more readable. Move the cursor → the lens slides smoothly.

**Feasibility (vanilla JS).** Hard but possible. vis-timeline uses a linear time→pixel map. We override it with a non-uniform function when the lens is active.

**Complexity: 6 / 10.** **Impact: 8 / 10.** **Fits constraint: ✅**

**Implementation.**
- Two paths:
  - **A (cheap, fake).** Don't touch vis-timeline. Render a sibling overlay canvas showing only the visible orders, with a non-linear x-scale, layered over the real timeline (hide real `.vis-item` opacity → 0.3). Re-render on `pointermove`. Fast, ~200 LOC.
  - **B (real).** Patch vis-timeline's time mapping function. Risky — would need to monkey-patch internal methods.
- Recommend A. CSS `transform-origin: cursor-x` + non-uniform scaling on a clone of items.

**Browser APIs.** `pointermove`, `getBoundingClientRect`, Canvas 2D or absolute-positioned divs with CSS transforms.

**Why competitors don't have it.** Nobody has thought to apply fisheye to Gantt charts. It's the kind of idea that sounds gimmicky until you use it for 90 seconds.

---

### 7. Bottleneck Pulse + Downstream Trace
**Why it changes the game.** Today, the planner has to mentally compute which line is the constraint. The data is there (utilization + dependency arrows) but cognitive load is high.

**UX feel.** Lines that are bottlenecks (util >90% AND blocking ≥2 downstream orders) get a subtle pulsing amber border in the Hierarchy panel. Pulse frequency = severity (faster = worse). Click the line → red arrows snake outward across the Gantt showing exactly which downstream orders are blocked. Click an arrow → jumps to that order.

**Feasibility (vanilla JS).** Easy. We already have `Utilization` and `DependencyOverlay`.

**Complexity: 4 / 10.** **Impact: 9 / 10.** **Fits constraint: ✅**

**Implementation.**
- Extend `Utilization` with `getBottlenecks()` returning `[{line, severity, blockedDownstream: [taskId]}]`.
- In `Hierarchy._renderLine()`, add `class="bottleneck"` + CSS variable `--pulse-speed: ${1000/severity}ms`.
- CSS: `@keyframes pulse { 0%,100% { border-color: var(--amber-soft); } 50% { border-color: var(--amber-hot); } }`.
- On line-click, extend `DependencyOverlay` to render *outbound* arrows only from that line, styled red/thicker.

**Browser APIs.** CSS custom properties, `@keyframes`, SVG overlay (existing).

**Why competitors don't have it.** Bottleneck visualization in ERP is usually a "Theory of Constraints report" — a PDF, not an animated UI element.

---

### 8. Focus Mode (single-line cockpit)
**Why it changes the game.** When a planner is fixing one line's problems, every other line is visual noise. A single keystroke that *quiets the world* is a productivity multiplier.

**UX feel.** Press **F**. The selected line stays at full opacity; every other line, group, sidebar item, and arrow fades to 15% opacity. Alerts on other lines mute. The cursor is now optimized for *this line only*. Press F again → world un-fades.

**Feasibility (vanilla JS).** Trivial. CSS class on `<body>` + opacity rules.

**Complexity: 2 / 10.** **Impact: 7 / 10.** **Fits constraint: ✅**

**Implementation.**
- Listen for `F` key in `Interaction`.
- Toggle `body.focus-mode-on` + `data-focus-line="<lineId>"`.
- CSS: `body.focus-mode-on .vis-group:not([data-line="${focusLine}"]) { opacity: 0.15; }` (would require labeling vis groups with a data attribute — easy to add).

**Browser APIs.** `KeyboardEvent`, CSS attribute selectors.

**Why competitors don't have it.** Focus modes come from writing apps (iA Writer, Bear) — not yet crossed into enterprise.

---

### 9. Floating Inspector Cards (multi-pin)
**Why it changes the game.** The right-side Inspector shows *one* order at a time. But planners constantly compare 2-3 orders ("which has the tighter due date? which has more changeover with its neighbor?"). Today they alt-tab through Inspector or jot on paper.

**UX feel.** Click the pin icon on the Inspector. A floating card detaches and snaps to the screen edge, miniaturized. Open another order → Inspector shows it; pinned card stays. Pin 3-4 orders. Drag cards around. Compare at a glance. Right-click a card → "Promote to Inspector," "Close," "Open in Sandbox."

**Feasibility (vanilla JS).** Easy. New module `InspectorPins` clones Inspector content into a draggable card.

**Complexity: 3 / 10.** **Impact: 7 / 10.** **Fits constraint: ✅**

**Implementation.**
- New `NIMBUS.InspectorPins` in `nimbus-intelligence.js`.
- On pin click, `Inspector._renderCardHTML(taskId)` → wraps in `<div class="pin-card" draggable>`.
- Persist pin IDs in `localStorage`; rehydrate on boot.
- Drag handled via Pointer Events; position stored.

**Browser APIs.** Pointer Events, `localStorage`, CSS `position: fixed`.

**Why competitors don't have it.** Detached panes are an IDE pattern (VS Code, JetBrains). Manufacturing tools don't import IDE thinking.

---

### 10. Cinematic Optimization Playback
**Why it changes the game.** Today, click "Optimize" → the schedule abruptly rearranges. Schedulers don't trust what they don't see happen. Animation = trust.

**UX feel.** Click Optimize → 1.5 second cinematic. Each task glides from its old position to its new one with slight trail effect. Tasks that moved most have brighter trails. The Confidence Score (#3) animates upward in sync. When it ends, a small "+18 confidence, −22 minutes changeover" floats in. Optionally: a "replay" button.

**Feasibility (vanilla JS).** Easy. Compute before/after positions, animate via CSS transforms + RAF.

**Complexity: 5 / 10.** **Impact: 7 / 10.** **Fits constraint: ✅**

**Implementation.**
- Wrap `Engine.runAndApply()`: snapshot old positions, compute new ones, *don't* publish yet.
- Render each task as a tweening `<div>` overlay (positioned over real timeline items, which are hidden during animation).
- Tween via `requestAnimationFrame` with ease-out curve over 1500ms.
- After animation, publish `Store` and remove overlay.

**Browser APIs.** `requestAnimationFrame`, CSS transforms, `Animation` API (Web Animations).

**Why competitors don't have it.** Animation is dismissed as "fluff" in enterprise. It is actually a trust mechanism. Stripe, Linear, Apple know this.

---

### 11. Schedule Diff Viewer ("what changed since…")
**Why it changes the game.** When a planner returns from lunch / overnight / the weekend, the first question is *"what's different?"* — particularly if a colleague edited the schedule too. The answer today is "look really hard."

**UX feel.** Toolbar button: "Compare against…" → dropdown of timestamps (auto-snapshots from Time Machine + manual saves). Pick one. The Gantt enters Diff mode: green ghosts = added tasks, red ghosts = removed, yellow outlines = moved (with arrow from old → new position). A summary chip top-right: *"7 moved, 2 added, 1 removed since 4pm yesterday."*

**Feasibility (vanilla JS).** Easy. We already snapshot via UndoStack. Just need a diff function and visual layer.

**Complexity: 4 / 10.** **Impact: 9 / 10.** **Fits constraint: ✅**

**Implementation.**
- Persist snapshots in IndexedDB (UndoStack is in-memory only; needs durability).
- `NIMBUS.Diff.compute(snapshotA, snapshotB) → {added, removed, moved}`.
- Render: ghost items on the Gantt via overlay (same pattern as Ripple Preview).
- Arrows from old→new via SVG overlay.

**Browser APIs.** IndexedDB, SVG, `Object.keys`/`Map` diff.

**Why competitors don't have it.** Diff is a developer concept (git). Importing it to a domain UI is brave.

---

### 12. Order DNA Strip
**Why it changes the game.** Changeover cost is determined by *similarity to neighbors*. Today the planner has to read color/form/size text for each order. A 4-pixel visual strip beneath each order showing similarity to left/right neighbors is faster than any number.

**UX feel.** Below each Gantt bar: a thin 3-pixel strip split into three sections (color | form | size). Each section is bright if the attribute matches the previous order, dim if not. A run of all-bright strips = "this is a great sequence." A run of all-dim = "this is fragmented." The pattern is *immediately* visible from 6 feet away.

**Feasibility (vanilla JS).** Easy. Render in Timeline as part of each item.

**Complexity: 3 / 10.** **Impact: 8 / 10.** **Fits constraint: ✅**

**Implementation.**
- In `Timeline` item template (vis-timeline supports HTML in items), append `<span class="dna" data-c="${match_c}" data-f="${match_f}" data-s="${match_s}">`.
- CSS: render three 33%-wide segments with conditional bright/dim colors.
- Compute matches at render time vs. predecessor on same line.

**Browser APIs.** Pure CSS + DOM.

**Why competitors don't have it.** This is "sparkline thinking" applied at the bar level. It's the kind of micro-information that takes 10 minutes to ship and saves 10 minutes daily.

---

### 13. Predictive Drag Targets (glowing slots)
**Why it changes the game.** When the user starts dragging an order, NIMBUS already knows the best landing spots — same line, valid working hours, low changeover with neighbors. Why not *show* them?

**UX feel.** On dragstart, dim the entire Gantt except 3-5 glowing "good landing" zones, ranked: 1st = brightest gold, 5th = soft amber. As the user moves toward a zone, it brightens further. Drop near it → magnetic snap. Drop elsewhere → drop wherever, no penalty.

**Feasibility (vanilla JS).** Medium. Need a fast "score this slot" function.

**Complexity: 5 / 10.** **Impact: 8 / 10.** **Fits constraint: ✅**

**Implementation.**
- On `dragstart`, call `Engine.suggestLandingZones(taskId, k=5)` → returns 5 (line, startTime) candidates ranked by composite score (changeover similarity + utilization fit + dependency respect).
- Render glowing rectangles via overlay (canvas or div).
- Combine with Drag Physics (#5) for magnetic snap.

**Browser APIs.** `dragstart`/`dragend` (or vis-timeline `onMoving`), Canvas or absolute divs.

**Why competitors don't have it.** Suggestive UI is the next frontier in productivity software. Currently rare in any domain.

---

### 14. Mass Reschedule Lasso
**Why it changes the game.** When a machine breaks, schedulers need to move *all orders downstream* in one gesture. Today: shift-click each one, then drag. With lasso: drag a rectangle, drag the bundle.

**UX feel.** Shift+drag on empty Gantt area → rectangle appears. Release → all orders inside become a selection group, highlighted in a single accent color. Now drag any one of them → all move together, with internal spacing preserved. Magnetic snap to shift boundaries applies to the leading edge.

**Feasibility (vanilla JS).** Medium. vis-timeline supports multi-select natively, but the lasso UX is custom.

**Complexity: 5 / 10.** **Impact: 8 / 10.** **Fits constraint: ✅**

**Implementation.**
- In `Interaction`, detect `pointerdown` with shift on empty Gantt → start lasso state.
- Track `pointermove` → draw rectangle (SVG or canvas overlay).
- On `pointerup`, compute which task bars intersect the rect → set `Store.selection` to that set (existing Selection module).
- Subsequent drag of any selected item moves the whole set (vis-timeline does this if multi-select is enabled).

**Browser APIs.** Pointer Events, `Element.getBoundingClientRect`.

**Why competitors don't have it.** Lassos came from design tools (Figma, Sketch). Crossing them into operational UIs is rare.

---

# Functional Innovations

### 15. Schedule Time Machine (scrubbable history)
**Why it changes the game.** UndoStack is 10 levels and ephemeral. Schedulers need *durable*, *visual*, *named* history — "rewind to before that bad optimize," "compare last Tuesday's plan to today," "what was I doing at 2pm?" This is the single biggest unlock for **confidence under pressure**.

**UX feel.** A thin film-strip ribbon below the Gantt: timestamped tick marks for every committed action (drag, optimize, sandbox commit, blackout add). Hover a tick → tooltip: *"3:42pm — Optimized line 7, +12 confidence."* Drag the playhead → the Gantt rewinds smoothly to that moment (live preview). Release outside the strip → no commit. Click "Restore" → that state becomes current (and the rewound steps remain in a forward stack like git branches).

**Feasibility (vanilla JS).** Hard but tractable. Need durable storage (IndexedDB) and a delta-based diff per action.

**Complexity: 6 / 10.** **Impact: 10 / 10.** **Fits constraint: ✅**

**Implementation.**
- New `NIMBUS.TimeMachine` in `nimbus-intelligence.js`.
- On every `UndoStack.push()`, also write a `{timestamp, label, delta}` entry to IndexedDB.
- Delta = changed task fields only (not full snapshot) — keeps storage tiny.
- UI: a horizontal ribbon (200 ticks visible, scroll/zoom). Tick = action; click = preview.
- Preview = build virtual Store state by replaying deltas from a base snapshot, render Gantt against that virtual state without publishing.
- Restore = make virtual state the new real state.
- Storage budget: cap at 1000 entries, prune oldest. ~1MB.

**Browser APIs.** IndexedDB, `structuredClone`, `requestIdleCallback` for prune.

**Why competitors don't have it.** Real time-travel debugging in production tools is rare even in software (Redux DevTools is dev-only). In manufacturing, unheard of.

---

### 16. Multi-Scenario Branches (elevate Sandbox)
**Why it changes the game.** `Sandbox` today is binary: a single "what-if" you can apply or discard. Real schedulers want **3-5 concurrent plans**: "today as-is," "if rush order comes," "if line 5 breaks," "Mike's draft." Git-style branches make this trivial.

**UX feel.** Toolbar dropdown: "📋 Main" → expand → list of scenarios. "+ New from current." Switch between them with a click; Gantt re-renders smoothly. A small badge top-right shows current scenario name and (if not Main) a "🔄 Compare to Main" button → diff viewer (#11).

**Feasibility (vanilla JS).** Easy. Sandbox already snapshots; just allow N snapshots with names + a selector.

**Complexity: 5 / 10.** **Impact: 9 / 10.** **Fits constraint: ✅**

**Implementation.**
- Extend `Sandbox` to `Scenarios`: object map `{name: snapshot}`.
- Persist to IndexedDB.
- UI: toolbar dropdown lists names; "New," "Rename," "Delete," "Compare," "Merge into Main" (which is just "make Main the current scenario's snapshot").
- Each scenario is a full `tasksArr` snapshot — cheap (~50KB per).

**Browser APIs.** IndexedDB.

**Why competitors don't have it.** Branching = mental model from version control. Crossing it into ERP is rare and immediately powerful.

---

### 17. Smart Conflict Resolver (3 ranked options)
**Why it changes the game.** Today, dragging into an overlap → it just overlaps. Or hitting a blackout → it just refuses. Neither is helpful. Schedulers want *options*.

**UX feel.** Drag an order into a conflict → at drop, a small floating card appears:
- **Option 1:** "Slot at 16:00 (next valid gap, no downstream impact)" — 1 click.
- **Option 2:** "Push line's downstream by 2.5h" — shows affected orders.
- **Option 3:** "Swap with order PO-4892 (same color, saves 18min changeover)" — clever.
- "Cancel" — drop somewhere else.

Each option has a tiny ghost-preview of what the schedule looks like if applied.

**Feasibility (vanilla JS).** Medium. Engine needs a `resolveConflict(taskId, attemptedPosition)` returning candidates.

**Complexity: 5 / 10.** **Impact: 9 / 10.** **Fits constraint: ✅**

**Implementation.**
- Extend `Engine` with `resolveConflict(taskId, dropPosition) → Option[]` where each option = `{label, action, impactPreview}`.
- Strategies: (a) find-next-gap; (b) push-downstream; (c) swap-with-similar-neighbor.
- UI: floating card anchored to drop position, rendered via existing `Modal`-style.
- Ghost previews: same overlay tech as Ripple Preview (#2).

**Browser APIs.** DOM.

**Why competitors don't have it.** Most planning UIs treat conflicts as errors. Treating them as decision points is a UX inversion.

---

### 18. Daily Briefing on App Load
**Why it changes the game.** Every morning the planner reconstructs context: "what shifted overnight, what's at risk today?" Replace 10 minutes of scrolling with a 30-second briefing.

**UX feel.** Open NIMBUS → before the Gantt appears, a "Today's Briefing" overlay (10 seconds, skippable):
- **"7 orders shifted since you last logged in."** [tap to see diff]
- **"Today's risk: Line 7 at 102% util — watch PO-4823."** [tap to jump]
- **"Watch out for blackout: Line 3 at 14:00."** [tap to jump]
- **"Confidence: 78. Yesterday at logout: 82."** [tap to see breakdown]

Briefing dismissable. Stored "last seen" timestamp.

**Feasibility (vanilla JS).** Easy. All data is already computed.

**Complexity: 3 / 10.** **Impact: 9 / 10.** **Fits constraint: ✅**

**Implementation.**
- In `App.boot()`, after Store hydration, compute briefing items.
- Diff vs. `localStorage['nimbus.lastSeen.snapshot']`.
- Render in existing `Modal` with custom layout.
- Update `lastSeen` on dismiss.

**Browser APIs.** `localStorage`, existing `Modal`.

**Why competitors don't have it.** Briefings are a chat/email UX pattern. Crossing into operational tools is rare.

---

### 19. Constraint Tuner (weighted optimize)
**Why it changes the game.** Engine has three modes: SPT, changeover, combined. Real schedulers think in *weights*: "I care 70% about on-time delivery, 30% about changeover today." Expose the dials.

**UX feel.** Optimize dialog gains three sliders:
- **On-time delivery** (0-100)
- **Changeover minimization** (0-100)
- **Utilization leveling** (0-100)

Below them: a live preview thumbnail of the Gantt as you slide. Tap "Run" → applies. Tap "Reset" → defaults.

**Feasibility (vanilla JS).** Medium. Engine needs a weighted blend mode — and a fast enough scorer to drive the live preview.

**Complexity: 4 / 10.** **Impact: 8 / 10.** **Fits constraint: ✅**

**Implementation.**
- Extend `Engine.runAndApply` to accept `mode='weighted', weights={dueDate, changeover, util}`.
- Engine produces a score-sorted permutation; doesn't need to be a real optimizer.
- Live preview: debounced thumbnail render at ¼ size (canvas, 200×100 px).

**Browser APIs.** Canvas (for thumbnail), `requestAnimationFrame`.

**Why competitors don't have it.** Most tools hide optimizer knobs as advanced settings. Surfacing them as primary UI is a confidence vote in the user.

---

### 20. Causality Tracer
**Why it changes the game.** "Why is line 7 overloaded?" Today: no answer. With tracing: a click reveals every action that contributed.

**UX feel.** Click any alert → side drawer:
> **"Overload on Line 7 (102%)"**
> Contributing actions:
> - 2:14pm — Drag PO-4823 to Line 7 (+12% util)
> - 1:03pm — Optimize "combined" added 3 orders
> - 11:45am — Blackout block extended on Line 5 (rerouted to Line 7)
> Each row links to Time Machine timestamp.

**Feasibility (vanilla JS).** Medium-hard. Requires tagging every Store mutation with metadata.

**Complexity: 6 / 10.** **Impact: 8 / 10.** **Fits constraint: ✅**

**Implementation.**
- Extend Store mutations to carry `{action, affectedTaskIds, affectedLines}`.
- TimeMachine entries inherit this.
- On alert click, scan recent entries that touched the alerting line/task; rank by recency × magnitude.
- Render in side drawer.

**Browser APIs.** DOM.

**Why competitors don't have it.** Provenance tracking is borrowed from observability. Manufacturing has no analog.

---

### 21. Auto-Snapshot on Risk
**Why it changes the game.** "I just clicked Optimize and now everything is wrong. Can I get back?" Yes — automatically.

**UX feel.** Before any of: Optimize, mass-drag, scenario merge, blackout add, line config change → silent auto-snapshot with a descriptive name. Appears in Time Machine. Toast: *"Snapshot saved before Optimize. Undo always available for 24h."*

**Feasibility (vanilla JS).** Trivial.

**Complexity: 2 / 10.** **Impact: 7 / 10.** **Fits constraint: ✅**

**Implementation.**
- Wrap risky-action entry points with `TimeMachine.snapshot('Auto: Pre-Optimize ${timestamp}')`.
- Tag as `auto: true` so UI can group.

**Browser APIs.** IndexedDB.

**Why competitors don't have it.** Many do checkpoint-on-action, but few make it visible.

---

### 22. Capacity Forecast Strip (4-week outlook)
**Why it changes the game.** The current Gantt shows *now*. The forecast strip shows *trouble approaching*.

**UX feel.** A 50px strip above the Gantt timeline: 4 weeks of bars, each bar showing total scheduled hours vs. available hours per line group. Mountains visible at a glance. Red zones = scheduled-over. Hover → "Week of June 8: 47% over on injection lines."

**Feasibility (vanilla JS).** Easy.

**Complexity: 4 / 10.** **Impact: 7 / 10.** **Fits constraint: ✅**

**Implementation.**
- New `NIMBUS.Forecast` module.
- Aggregate from `Utilization` + `Calendar`.
- Render as inline SVG bars or Canvas.
- Click a bar → zoom Gantt to that week.

**Browser APIs.** SVG/Canvas, vis-timeline `setWindow()`.

**Why competitors don't have it.** Forecasting in SAP APO requires a separate "Long-Term Planning" workspace. Inline is novel.

---

### 23. Shadow Schedule Overlay (last week's ghost)
**Why it changes the game.** "Is this week looking like last week?" — a question planners ask constantly. Answer it visually.

**UX feel.** Toolbar toggle: "👻 Show last week." Last week's schedule overlays in 30% opacity, gray. The eye instantly sees: today's orders are running later, or grouped differently, or denser. Toggle off when done.

**Feasibility (vanilla JS).** Easy. Just snapshot weekly and overlay.

**Complexity: 3 / 10.** **Impact: 7 / 10.** **Fits constraint: ✅**

**Implementation.**
- TimeMachine auto-creates a weekly snapshot every Friday EOD.
- Toggle reads that snapshot, renders items in an overlay layer (translated 7 days forward).
- Snap to today's time grid.

**Browser APIs.** IndexedDB, overlay rendering.

**Why competitors don't have it.** "Shadow" rendering is a video-game / motion-graphics technique. Cross-domain.

---

### 24. Recipe-Based Sequence Suggestions
**Why it changes the game.** A planner who always runs Color A before Color B should be *learned* — without ML infrastructure, just a frequency tally. After 3 matching reorders, NIMBUS asks: *"Apply this pattern to similar orders?"*

**UX feel.** While dragging an order into a sequence → a faint banner: *"You moved Blue→Red 4 times this week. Want me to suggest this whenever you have unsequenced Blue+Red?"* Yes → next time, NIMBUS pre-positions them.

**Feasibility (vanilla JS).** Medium. Heuristic learning is just a frequency dict.

**Complexity: 5 / 10.** **Impact: 7 / 10.** **Fits constraint: ✅**

**Implementation.**
- New `NIMBUS.Patterns` module.
- Listen for drag commits. For each (prev, next) attribute pair (color/form/size), increment a counter in localStorage.
- When the counter > threshold *and* the pattern is novel for current task batch → surface suggestion.
- Suggestions appear as inline chips on the Inspector or as a non-intrusive toast.

**Browser APIs.** localStorage.

**Why competitors don't have it.** "AI" in their world = LLMs. Light heuristic learning is unfashionable and effective.

---

### 25. Triage Mode (auto-prioritize alerts)
**Why it changes the game.** When 14 alerts fire at once (machine breaks, blackout extends, rush order), the planner needs to know which to fix *first*. Today: a list, sorted by time. Useless.

**UX feel.** Toolbar button: "🚑 Triage" — opens a ranked list of alerts:
1. **Critical** — Line 7 overload blocks 4 downstream (impact: $24k late penalty risk)
2. **High** — Order PO-9821 missing changeover slot before due date
3. **Medium** — Line 3 utilization 88% — leveling opportunity
…

Each row has a "Fix" button → applies the conflict resolver (#17) automatically.

**Feasibility (vanilla JS).** Medium.

**Complexity: 4 / 10.** **Impact: 7 / 10.** **Fits constraint: ✅**

**Implementation.**
- Extend `Alerts` with `triageRank(alert) → {severity, impactScore, suggestedFix}`.
- Severity = type weight × (downstream count + lateness risk + util magnitude).
- Render in a dedicated panel (existing alerts panel can host it as a tab).
- "Fix" calls the same engine as Smart Conflict Resolver.

**Browser APIs.** DOM.

**Why competitors don't have it.** Triage thinking is from incident response (PagerDuty, FireHydrant). Importing the framing here is a status upgrade.

---

### 26. Schedule Time-Lapse Recording
**Why it changes the game.** Reviewing a chaotic day after the fact, or training a new planner — replay the day at 50× speed and watch decisions unfold.

**UX feel.** Toolbar: "🎬 Replay yesterday." → modal with timeline scrubber. Press play → the Gantt rapidly cycles through every state change of yesterday: drags, optimizes, blackouts. Speed control 1× to 100×. Pause to inspect.

**Feasibility (vanilla JS).** Medium. Same data as Time Machine, different UI.

**Complexity: 5 / 10.** **Impact: 7 / 10.** **Fits constraint: ✅**

**Implementation.**
- TimeMachine already stores deltas with timestamps. Add a "playback" mode that applies them in sequence with a speed multiplier.
- Render virtual state without committing.
- Stop = exit.

**Browser APIs.** `requestAnimationFrame`, IndexedDB.

**Why competitors don't have it.** Replay is a video-editor pattern. Almost nobody in enterprise tools surfaces it.

---

# Unexpected / Moonshot Ideas

These sound borderline absurd. They would be unforgettable.

### 27. Air Traffic Control View
**Why it changes the game.** Sometimes a planner wants a *radically different mental model*. Lines as horizontal bars is one model. Lines as concentric circles, with orders converging from the periphery toward "now" at the center, is another — and for visualizing *imminent load* it is genuinely better.

**UX feel.** Toolbar toggle: "🛩 ATC." The Gantt morphs into a radar display: each line is a ring, each order is a wedge moving inward as time passes. The center is "right now." Orders that need to start within 1 hour glow. Orders that need to complete within 1 hour pulse. You see the *next 4 hours of urgency* without scrolling.

**Feasibility (vanilla JS).** Hard. Full custom Canvas rendering.

**Complexity: 7 / 10.** **Impact: 6 / 10.** **Fits constraint: ✅**

**Implementation.**
- New Canvas layer overlaid on Gantt (Gantt hidden when ATC mode is on).
- Polar coordinate rendering. Line N = ring at radius R_N. Order O on line N at time T = angular position θ = (T - now) * speed.
- Click an order wedge → still hits the same Store API.

**Browser APIs.** Canvas 2D, requestAnimationFrame.

**Why competitors don't have it.** Mode-switching the entire visualization is high-stakes. Bold.

---

### 28. Production Weather Radar
**Why it changes the game.** A literal radar-style storm overlay where high-load zones are storms, low-load zones are clear, and *forecast* high-load zones (4 days out) are pulsing cumulonimbus.

**UX feel.** Toolbar toggle: "🌩 Weather." The Gantt background becomes a cellular animation, blue (calm) to red (storm). Animated noise textures evoke real weather. A small "forecast" panel: *"Storm front building Wednesday-Thursday on injection lines."*

**Feasibility (vanilla JS).** Hard.

**Complexity: 7 / 10.** **Impact: 6 / 10.** **Fits constraint: ✅**

**Implementation.**
- Canvas overlay running a cellular automaton seeded by the stress matrix from #4.
- Forecast cells based on Capacity Forecast (#22).
- Pure aesthetic on top of the analytical layer.

**Browser APIs.** Canvas 2D, animation.

**Why competitors don't have it.** Borrowed from weather apps and game design. Nobody in factory software has thought to.

---

### 29. Voice-Activated Reschedule
**Why it changes the game.** Schedulers on the phone can't type. "Move all blue orders to line 3 next week" — spoken — is faster than 8 clicks.

**UX feel.** Hold spacebar → mic indicator. Speak. Release. NIMBUS shows the parsed intent ("Move all orders with color=blue from current to line 3, week of [date]") with a Confirm/Cancel. Apply.

**Feasibility (vanilla JS).** Medium. Web Speech API is browser-native; intent parsing is regex/keyword (no LLM needed).

**Complexity: 5 / 10.** **Impact: 6 / 10.** **Fits constraint: ✅**

**Implementation.**
- New `NIMBUS.Voice` module.
- `SpeechRecognition.start()` on spacebar hold.
- Parse transcript with keyword grammar: verbs (move, swap, schedule), nouns (orders/lines/colors), modifiers (all, blue, next week).
- Map to existing Store actions.

**Browser APIs.** Web Speech API (Chrome/Edge).

**Why competitors don't have it.** Voice in enterprise is rare because of the LLM-cost assumption. Local grammar parsing breaks that assumption.

---

### 30. Ambient Wall-Display Mode
**Why it changes the game.** Many factories want NIMBUS running on a TV in the control room. Currently it's just the same UI, too dense, with no auto-cycling. Build a mode designed for it.

**UX feel.** Press F11 + "A" → Ambient mode. UI cycles through 5 views every 12 seconds with smooth transitions: (1) full Gantt, (2) bottleneck pulse closeup, (3) confidence + alerts dashboard, (4) stress heatmap, (5) capacity forecast. Big fonts, high contrast, no interactive elements. Looks expensive.

**Feasibility (vanilla JS).** Easy.

**Complexity: 3 / 10.** **Impact: 6 / 10.** **Fits constraint: ✅**

**Implementation.**
- New `NIMBUS.Ambient` module.
- CSS class on body; cycler runs `setInterval` swapping a single visible panel.
- Transition: CSS `opacity` crossfade.

**Browser APIs.** Fullscreen API, CSS animations.

**Why competitors don't have it.** Designed-for-wall-display is a niche thought few enterprise tools entertain.

---

### 31. Gamepad Haptic Alerts
**Why it changes the game.** This sounds absurd. But: a USB controller with rumble, plugged into the scheduler's PC, vibrating gently when an overload occurs, is *more attentional* than a toast notification — *and* it doesn't interrupt the screen. The scheduler's hand feels the alert.

**UX feel.** Plug any USB game controller. NIMBUS detects it, asks "Use for haptic alerts?" Yes. Now: gentle rumble on warn, sharp pulse on critical, pattern-rumble on overload (.- .- .-).

**Feasibility (vanilla JS).** Easy.

**Complexity: 3 / 10.** **Impact: 5 / 10.** **Fits constraint: ✅**

**Implementation.**
- New `NIMBUS.Haptic` module.
- `navigator.getGamepads()`; check for `vibrationActuator`.
- On Alert.severity change, play preset rumble pattern.

**Browser APIs.** Gamepad API, `GamepadHapticActuator`.

**Why competitors don't have it.** Nobody thinks of it. That's exactly why it would be memorable.

---

### 32. Eye-Tracking Idle Pause
**Why it changes the game.** A subtle one: pause expensive animation and polling when the user isn't looking at the screen. Saves battery on laptops, but more importantly — feels eerily aware.

**UX feel.** No visible UI. Just: if the user looks away for 30 seconds, animations slow to 0.1 fps and Confidence sparkline pauses. When they look back, everything resumes seamlessly.

**Feasibility (vanilla JS).** Hard, privacy-sensitive.

**Complexity: 6 / 10.** **Impact: 4 / 10.** **Fits constraint: ✅**

**Implementation.**
- Use `FaceDetector` API (Chrome) or fall back to `Page Visibility API` only.
- Webcam access requires explicit user opt-in (browser permission prompt).
- Even simpler fallback: detect cursor idle > 60s + window unfocused → pause.

**Browser APIs.** `FaceDetector` (experimental), `Page Visibility`, `requestIdleCallback`.

**Why competitors don't have it.** Too clever for ERP, perfect for NIMBUS.

---

# Top 5 Must-Build Features

The five features below are the strategic core. Build them all in order; ship them as a single "NIMBUS Intelligence" release.

### 1. Command Palette (Cmd+K) — *Quick Win*
Single biggest velocity multiplier. Build first. <1 week.

### 2. Confidence Score + Stress Heatmap — *Foundation*
Establishes NIMBUS as a *measurement* tool, not just a *display* tool. Becomes the daily anchor metric. ~1.5 weeks.

### 3. Schedule Time Machine — *Confidence Foundation*
Without durable, scrubbable history, every other feature is scary. Build before anything destructive. ~2 weeks.

### 4. Ripple Preview Overlay — *Trust Multiplier*
Pairs with Time Machine. Removes drag anxiety. ~1.5 weeks.

### 5. Multi-Scenario Branches — *Strategic Mode*
Schedulers stop fearing what-ifs because they're now first-class. Builds on Sandbox; elevates it. ~1.5 weeks.

**Total: ~7-8 weeks for a transformative release.** All five fit in the single new `nimbus-intelligence.js` file. They share patterns (overlay rendering, IndexedDB storage, Store subscriptions).

---

# Quick Wins (1-3 days each)

These are insanely cheap, high-impact. Ship them within sprint zero.

- **Daily Briefing on App Load** (#18) — 1 day
- **Focus Mode (F key)** (#8) — 0.5 days
- **Order DNA Strip** (#12) — 1 day
- **Auto-Snapshot on Risk** (#21) — 0.5 days (once Time Machine is shipped)
- **Shadow Schedule Overlay** (#23) — 1 day (once weekly snapshots run)
- **Ambient Wall-Display Mode** (#30) — 2 days
- **Floating Inspector Cards** (#9) — 2-3 days

---

# Medium Complexity, High-Value Features (1-2 weeks each)

- **Command Palette** (#1)
- **Confidence Score + Stress Heatmap** (#3, #4)
- **Ripple Preview Overlay** (#2)
- **Schedule Diff Viewer** (#11)
- **Smart Conflict Resolver** (#17)
- **Multi-Scenario Branches** (#16)
- **Capacity Forecast Strip** (#22)
- **Bottleneck Pulse + Trace** (#7)
- **Constraint Tuner** (#19)
- **Drag Physics** (#5)
- **Mass Reschedule Lasso** (#14)
- **Predictive Drag Targets** (#13)
- **Triage Mode** (#25)

---

# Moonshots (high effort, brand-defining)

These are the ones that get NIMBUS featured. Pick 1-2 to ship in the release after the foundation is in.

- **Schedule Time Machine** (#15) — foundation, but moonshot in *polish*
- **Time Compression Lens** (#6)
- **Cinematic Optimization Playback** (#10)
- **Causality Tracer** (#20)
- **Schedule Time-Lapse Recording** (#26)
- **Voice-Activated Reschedule** (#29)
- **Air Traffic Control View** (#27)
- **Production Weather Radar** (#28)
- **Eye-Tracking Idle Pause** (#32)

---

# Architecture Plan: The One New File

`nimbus-intelligence.js` is the proposed new file. It is loaded *after* `app.js` and follows the same IIFE-module pattern. It hosts:

```
NIMBUS.CommandPalette    — Cmd+K overlay + fuzzy index
NIMBUS.TimeMachine       — durable IndexedDB history + scrubber UI
NIMBUS.Confidence        — composite score + sparkline + breakdown
NIMBUS.StressHeatmap     — overlay canvas + computeStressMatrix
NIMBUS.Briefing          — load-time briefing modal
NIMBUS.RipplePreview     — Alt-hover ghost rendering
NIMBUS.Diff              — snapshot diff + visual layer
NIMBUS.Scenarios         — multi-branch elevation of Sandbox
NIMBUS.Patterns          — sequence-learning heuristic
NIMBUS.Forecast          — 4-week capacity strip
NIMBUS.Triage            — ranked alert panel
NIMBUS.Voice             — Web Speech driver
NIMBUS.Ambient           — wall-display cycler
NIMBUS.Haptic            — gamepad rumble
```

**Why one file works.** Each module is small (50-300 LOC) once the heavy lifting (Store, Engine, Timeline) lives in `app.js`. The new file's job is to *consume* Store and add new visualization/interaction layers — it never duplicates business logic.

**Loading order:** `index.html` adds one `<script src="nimbus-intelligence.js" defer>` after `app.js`. Modules check `if (window.NIMBUS && NIMBUS.Store)` before init.

**Storage:** Single IndexedDB database `nimbus-intel` with object stores `snapshots`, `scenarios`, `patterns`. Auto-prune via `requestIdleCallback`.

**Risk to existing code:** Zero. All extensions are subscribers / overlays, never mutators of existing module internals.

---

# Final Recommendation

NIMBUS is at the stage where *competence* is solved and *delight* is the differentiator. The five must-build features (Command Palette, Confidence/Heatmap, Time Machine, Ripple Preview, Multi-Scenario Branches) move it from "best in our category" to "category-defining" — and they fit comfortably in one new file totaling 2,000-3,000 lines of additive vanilla JS.

**Ship strategy:**

1. **Sprint 1 (1 week).** Quick wins: Daily Briefing, Focus Mode, Order DNA, Auto-Snapshot scaffolding, Floating Inspector Cards.
2. **Sprint 2-3 (3 weeks).** Foundation: Command Palette + Confidence + Stress Heatmap. Ship as "NIMBUS Intelligence" preview.
3. **Sprint 4-5 (3 weeks).** Confidence stack: Time Machine + Auto-Snapshot + Diff Viewer. Ship as "NIMBUS Time Machine."
4. **Sprint 6-7 (3 weeks).** Trust stack: Ripple Preview + Smart Conflict Resolver + Multi-Scenario Branches. Ship as "NIMBUS Scenarios."
5. **Sprint 8+ (ongoing).** Pick 2-3 moonshots per quarter. Cinematic Optimization Playback is the showpiece for a marketing video.

The competitive moat is not any single feature — it is the *combination* of operational intelligence (Confidence/Heatmap/Triage), reversible action (Time Machine/Ripple), and cinematic feel (Optimization Playback/Drag Physics). No competitor combines all three because they each come from different design lineages (observability, version control, motion design). NIMBUS uniting them is the bet.

**One final principle:** every feature here should pass the *coffee-cold test*. The planner has been pulled into a phone call, came back, and forgot where they were. The product should answer "where was I?" in under 2 seconds. Confidence Score answers it numerically. Diff Viewer answers it visually. Briefing answers it on load. Time Machine answers it temporally. That is the throughline.

Build for the coffee that got cold.
