# SAP APO PP/DS Opportunity Gaps for NIMBUS

**Date:** 2026-08-22
**Scope:** SAP APO / embedded PP/DS **Detailed Scheduling** only — the DS planning board (`/SAPAPO/CDPS0`), DS scheduling strategies, the DS Optimizer, and the DS-side monitoring surfaces. This is *not* a request to recreate APO verbatim; it is an inventory of the capabilities experienced APO schedulers treat as table stakes, mapped against what NIMBUS ships today, so we can pick the gaps that make NIMBUS "feel like home" to planners coming off SAP.

**Deliberately excluded (production planning, not detailed scheduling):** MRP / net-requirements calculation, lot sizing, order creation and quantity changes, multi-level BOM explosion and material pegging networks, CTP/ATP checks, forecast consumption, days-of-supply analytics, procurement alerts. APO's DS optimizer itself never creates, deletes, or resizes orders — it only moves, re-sequences, re-assigns, and deallocates — and that is exactly the line NIMBUS should hold too. Where a DS feature touches pegging (e.g., demand-anchored lateness), the DS-side portion is noted and the material-flow portion is out of scope.

**Method note:** every "NIMBUS today" claim below was verified against live code (2026-08-22), not docs. SAP claims are sourced from SAP Help Portal (SCM 7.0 EhP2), SAP Learning (ePP/DS courses), SAP KBAs, and SAP community material.

---

## 0. Parity already achieved (don't rebuild)

Anchors — NIMBUS already has credible analogs of these APO concepts:

| APO concept | NIMBUS today |
|---|---|
| Fixing individual orders (`Functions → Fix`) | `Store.isFixed` — context menu, `F` key, Inspector, Table bulk, palette |
| Planning time fence (partially) | Frozen horizon band + `fixedIds` folding; Remove Backlog exempt (matches SAP002 behavior) |
| Sequence-dependent setup matrix + setup recalc on re-sequence | `setup_data.py` + setup-aware evaluator + derived setup bars that rebuild on drag |
| Dissolve Backlog heuristic (SAP002) | `'backlog'` mode with frozen-horizon carve-out |
| Simulative planning layer (unsaved board state) | Sandbox / What-If with Discard/Promote; explicit save |
| Optimizer before/after evaluation | OptimizerPreview: 5 KPIs, verdict, plan comparison, prune tallies |
| Order splitting | `order_schedule_segments` + split bars + per-plant policy |
| Resource overload / double-booking alerts | 9-rule alert engine incl. overlap/overload/near-capacity |
| Non-working time as hard geometry | Calendars + blackouts, optimizer snap; blackout drag-snap |

---

## 1. Missing logics — scheduling semantics the engine doesn't have yet

These are behavioral gaps in how NIMBUS *places* orders, independent of any UI.

### 1.1 Strategy-mediated drag & drop (scheduling modes) — the single biggest "feel like home" gap
In APO, a drop is a **request**, not a placement. The drop point is the *desired date*; the active strategy decides what actually happens:

- **Find Slot** — first gap in the planning direction big enough, sequence untouched.
- **Insert Operation** — place at the drop point and shove neighbors in the planning direction to make room, preserving sequence.
- **Squeeze In** — make room by moving neighbors in *both* directions.
- **Insert + Close Gaps** — insert, then compress all downstream gaps.
- **Infinite** — place exactly where dropped; overlap allowed, overload alert raised.

NIMBUS today has exactly one drag semantic: infinite placement with a 15-minute grid snap. No working-hours snap on manual drag, no reflow — dropping onto a neighbor just raises an overlap alert. Meanwhile `Engine.autoReflow` (a full setup/frozen/fixed-aware forward walk) already exists and is wired only into the overlap alert auto-fix.

**Opportunity:** a small strategy selector (toolbar segmented control or a modifier-key convention, e.g. plain drag = infinite, Shift-drag = insert-and-push) backed by `autoReflow` for the insert/close-gaps modes. This is the interaction APO planners miss most, and most of the engine work is already done.

### 1.2 Planning direction + backward-with-reversal
APO placement searches run forward, backward, or **backward-with-reversal** (search backward from the due date; if the search hits "now," flip to forward). Backward-from-due-date is the canonical way APO avoids building earliness/stock. NIMBUS schedules forward-only; `max_pull_forward_days` is a floor, not a direction. An "align to due date (backward), fall forward if needed" placement option — both for manual snap actions and as an optimizer post-pass (see §2.6) — is a genuine logic gap.

### 1.3 Deallocation pool (unscheduled-but-existing worklist)
APO's third state between "scheduled" and "deleted": a **deallocated** operation keeps its identity and machine affinity but consumes no capacity, appears in a **pool chart/worklist**, and is re-dispatched later by drag or by "schedule from pool." Planners use it constantly: clear a disrupted line into the pool, keep the demand visible as a to-do list, re-dispatch deliberately. It is also APO's **safe failure mode** — when a finite placement can't succeed, the choice is fail / place infinitely / **deallocate**, never a silent drop.

NIMBUS has bulk unschedule (Del key), but no visible pool: an unscheduled order effectively disappears from the planner's working surface until they find it in the Orders grid. **Opportunity:** a dedicated pool lane (or pinned drawer) on the Gantt — drag out to deallocate, drag in to schedule, count badge, "schedule all from pool" action — plus a `deallocated` alert ("N orders are parked and loading no capacity").

### 1.4 Finish-to-start links as real constraints
NIMBUS hydrates `Store.dependencies` from the payload, but **the Engine ignores them entirely** — no optimizer term, no drag validation, no reflow awareness — and `DependencyOverlay` (arrows + critical-chain highlight, already implemented) is permanently disabled because its `#chk-show-deps` toggle doesn't exist in the DOM. In APO, order-internal and cross-order relationships are first-class scheduling constraints with three planner-selectable postures: ignore (violations become alerts), always honor (dependents get rescheduled to stay legal), or honor-within-scope. Min/max intervals between linked steps are part of that (max intervals matter for cure/quality windows).

**Opportunity (staged):** (1) resurrect the overlay checkbox — free; (2) add a `relationship-violated` alert rule when a drag inverts or over-stretches a link; (3) let the optimizer treat links as a constraint or a heavy penalty. Do *not* import APO's full activity-network model — order-level finish-to-start with a min/max gap is the right altitude for NIMBUS.

### 1.5 Fixing intervals per line (freeze a time window, not just orders)
APO has **four distinct freeze mechanisms** and planners feel the difference: fix an order (hard everywhere), fix a **time interval on one resource** (everything wholly or partly inside behaves as fixed *for scheduling*, drawn as a red band), the product-level planning time fence, and the outer planning horizon. NIMBUS has two of the four: per-order fix and the plant-wide frozen horizon. The missing middle is the one planners use hourly: "freeze line 3 through Wednesday shift-end" as one gesture instead of pinning 14 orders. **Opportunity:** drag-to-create fixing intervals on a line row (context menu on empty canvas — note `ContextMenu.openCanvas` is currently called but not implemented, so that right-click is a silent no-op today), rendered like the frozen-horizon band but per-line, honored by drag validation, reflow, and all optimizer modes.

### 1.6 Placement failure policy (the "error action" dial)
Every APO strategy carries an explicit answer to "what if the placement can't succeed": terminate-and-revert, **schedule infinitely anyway** (overload + alert instead of failure), or **deallocate to pool**. NIMBUS's optimizer has the never-freeze invariant (good — that *is* this idea), but manual/auto-fix paths have no equivalent policy, and there is no user-visible dial. Worth adopting as an explicit per-action setting once §1.1 and §1.3 exist, because insert/find-slot modes create failure cases that infinite drag never had.

### 1.7 Auto-fix on out-of-hours placement
APO nuance worth stealing outright: an operation deliberately scheduled into non-working time is **automatically fixed** — the system treats an out-of-hours placement as an intentional exception that no heuristic may silently move. NIMBUS raises `fixed-out-of-hours` only for already-fixed orders; a manual drop into a closed window is just an alert, and the next optimizer run will relocate it. Auto-fixing (with a toast + easy unfix) matches planner intent and is nearly free to implement.

### 1.8 Compact scheduling / "close gaps" as a line action
APO offers gap-closing both as a scheduling mode and as a standalone compression step. NIMBUS's changeover/backlog modes compress as a side effect, but there is no lightweight "compact this line from here forward — keep the sequence, just remove the air" verb that doesn't involve running the optimizer. `autoReflow` is 90% of this; it needs an entry point (line context menu / palette).

### 1.9 Block planning (reserved time windows for product families)
APO blocks reserve time windows on a resource for orders matching characteristics (color, size, family); placement into a non-matching block is inadmissible, and gap-closing respects block boundaries. This is *the* pattern for businesses that run color/family wheels — highly relevant to Newell. NIMBUS's priority lists rank sequence preference but nothing reserves capacity windows. **Opportunity:** per-line "block" calendar entries carrying a signature filter (reuse the setup-signature machinery), enforced as drag admissibility + an optimizer constraint. Campaign *formation* (auto-grouping same-signature orders, setup/clean-out orders) is the deluxe version — defer it; blocks are the 80/20.

---

## 2. Optimization settings & options

NIMBUS's Optimize modal today: plant, window (2 presets + custom), whole-plant/specific-lines scope, three strategy pills, and exactly two checkboxes (respect fixed / respect calendar). APO users are accustomed to considerably more control:

### 2.1 Weighted multi-criteria objective instead of mode pills
The DS Optimizer minimizes one **weighted sum**: makespan + setup time + setup cost + **maximum delay** + total delay cost + mode cost, with user-set weights per criterion. Planners tune trade-offs as ratios ("1 h of setup is as bad as 24 h of total delay ⇒ weights 24:1"). NIMBUS's pills (SPT / Min Changeover / Remove Backlog) are fixed points in that weight space — and the evaluator already runs multiple objectives internally (`'due-date-first'` is implemented but unexposed). **Opportunity:** keep the pills as presets, add an "Advanced" disclosure with 3–4 weight sliders (changeover, lateness, max-single-order-lateness, span) feeding the existing evaluator's score vector. Presets stay the default so casual users never see a slider.

### 2.2 Maximum delay as a distinct objective term
APO separates **total delay** from **maximum delay** — 10 orders × 1 day late scores very differently from 1 order × 10 days late, and weighting max-delay *balances* pain across orders instead of sacrificing one order badly. NIMBUS's KPI set has `late_count`/`late_h` but no max-lateness term in scoring or preview. Cheap to add to both the evaluator score vector and the preview KPI cards ("worst single order: 46 h late → 12 h late").

### 2.3 Priority-tiered delay costs
APO prices delay through **priority intervals**: order priority (1–255, usually inherited from the demand) maps to a per-interval delay cost rate — a priority-1 order being late costs 10× a priority-200 order. NIMBUS has per-plant priority *rank lists* that drive sequence preference, but lateness is priority-blind. **Opportunity:** an order-priority field (SAP upload already carries candidates) with 2–3 tiers ("critical / normal / filler") weighting the lateness terms. This is how "protect the Walmart order" becomes an optimizer input instead of a manual pin.

### 2.4 Cross-line assignment ("mode" changes) as an optimizer option
The DS Optimizer may move an operation to an **alternative resource** (mode), steered by mode priorities (A–O) and mode costs, with explicit toggles: "may change mode" vs "retain existing mode," and **mode fixation** ("re-sequence only, don't re-assign"). NIMBUS's optimizer sequences within lines only; cross-line moves are manual. Given machine↔material eligibility exists in master data (`material_plants`, machine mapping), an opt-in **"allow machine changes"** checkbox — with per-machine preference (production version priority is already a rankable field) — is the natural next optimizer capability, and its inverse ("keep every order on its current machine, just re-sequence") should be the wording of the default.

### 2.5 Runtime budget + live improvement curve
APO's primary optimizer knob is **maximum runtime**, with a live objective-value curve during the run ("watch it flatten, stop when flat") and a min-runtime early-exit. NIMBUS has deadline-bound search internally (optimizer-speedup work) but exposes no runtime knob and shows a spinner. **Opportunity:** a "search effort" control (Quick ~2 s / Standard / Thorough ~30 s) and a live "best plan so far" number ticking down during the run. The curve is disproportionately trust-building — planners coming from APO *expect* to see the optimizer improving.

### 2.6 Backward-scheduling / minimize-earliness post-pass
After its forward run, APO can pull activities **toward (never past) their due dates** — reducing earliness and finished-goods inventory, optionally without increasing makespan. NIMBUS is compress-early-only; `max_pull_forward_days` caps earliness but nothing *optimizes* it. An "align completion to due dates (JIT)" checkbox running a right-shift post-pass over the optimized plan fills a real gap for inventory-sensitive plants.

### 2.7 Deallocate-instead-of-late escape valve
APO option: operations that would end after the horizon (or be later than a threshold in hours) are **deallocated** rather than placed absurdly late — optionally including their successors — with internal costs guaranteeing deallocation is always worse than any real placement. Pairs with §1.3; once a pool exists, "park anything that would land >N days late, and tell me" is a far more honest optimizer outcome than a bar in November.

### 2.8 Horizon-edge semantics for partially-inside orders
APO's scope rule is explicit and planners know it cold: an operation is touched only if it is **completely inside the horizon**, on a selected resource, and not fixed; partially-inside orders are treated as fixed obstacles. NIMBUS should (a) verify and pin its own edge behavior for orders straddling the optimizer window, and (b) *state it in the preview* ("3 orders straddle the window boundary and were held in place") — see §2.9.

### 2.9 Explanation log ("why didn't my order move?")
APO's explanation facility (`/SAPAPO/OPTEXPLAIN`) itemizes **Delays** (with cause), **Fixings** (why an operation was treated as immovable), **Deallocations**, and **Reschedulings** — the answer to the single most common planner question. NIMBUS's prune tallies and `whyNot` sentences are a good start at plan level; the gap is **per-order**: click any order in the preview (or Inspector post-apply) and get "held: inside frozen horizon" / "held: straddles window" / "moved +6 h: displaced by O-4471 (setup grouping)" / "late 18 h: capacity on L-03, Thu". The optimizer already computes most of these facts; they're discarded instead of surfaced.

### 2.10 Named optimizer profiles
APO planners work through saved **optimization profiles** (weights + horizon + scope + policies) rather than re-entering settings. NIMBUS remembers one implicit default per user (`optimizerDefaults`). Once §2.1's weights exist, per-plant named presets ("Friday cleanup," "Backlog burn-down," "Changeover blitz") become the natural container — and an admin-blessed default per plant beats every planner tuning their own weights.

### 2.11 What-if capacity overrides inside the run
APO's Capacity Change tab lets a run assume **per-period capacity percentages** (including >100% — "what if we add a weekend shift?") without touching master data. NIMBUS's Sandbox can simulate calendar edits by hand; a lightweight "assume +8 h Saturday on L-02 for this run only" input inside the Optimize modal is the planner-shaped version.

---

## 3. UX enhancements — making the board "feel like home"

### 3.1 Surface what's already built (highest ROI in this document)
Code-verified: five substantial features exist and are effectively invisible —

1. **TimeMachine** (auto-snapshots + restore) — reachable only via Cmd+K.
2. **Diff / Compare Schedules** — reachable only via Cmd+K.
3. **RipplePreview** (Alt-hover downstream ghost) — zero affordance anywhere; this is APO's "what will this move drag along" answered *before* the drop, and nobody can find it.
4. **`'due-date-first'` optimizer mode** — implemented in the evaluator, no strategy pill.
5. **DependencyOverlay** — fully built, permanently disabled by a missing checkbox (§1.4).

Plus one bug: empty-canvas right-click calls a nonexistent `ContextMenu.openCanvas`. Fixing discoverability here delivers several "APO-grade" capabilities for the cost of buttons.

### 3.2 Scheduling log for interactive actions
After every drag/heuristic, APO's DS board offers a **scheduling log**: every order changed, before/after times, and the constraint messages behind a placement or failure. Because strategy-mediated drops land non-obviously (§1.1), the log is how planners keep trust. NIMBUS logs nothing user-visible for manual actions. **Opportunity:** a transient post-action summary ("Moved O-4471 → Thu 06:00; reflowed 3 orders; setup +25 min") expandable into a session action log, with the same treatment on optimizer apply. Pairs with UndoStack — the log *is* the undo stack, annotated.

### 3.3 Named scenarios with KPI comparison (simulation versions + Plan Monitor)
APO planners keep **multiple named simulation versions** of a plan, "Save As" before risky steps, compare them by key figures in the **Plan Monitor** (delays, setup time, utilization), and **adopt** the winner — with merge semantics where confirmed reality wins over the simulation. NIMBUS has the pieces (Sandbox = one unnamed simulation; TimeMachine = snapshots; Diff = comparison; `Util.scheduleKpis` = key figures) but not the workflow: you cannot hold two candidate schedules side by side by name and pick one. **Opportunity:** promote Sandbox to named scenarios ("Friday plan A/B"), score each with the existing 5-KPI panel, diff any two, adopt one. Most of this is composition of shipped modules.

### 3.4 Configurable bar color/label rules (graphical-object decision table)
In APO, a decision table maps order attributes (status, setup group, product, custom conditions) to bar color, pattern, and **bar text** — mature sites live off "color by setup group" so changeover-friendly runs are visible at a glance. NIMBUS bar rendering is fixed. **Opportunity:** a per-user "Color bars by: status / color field / setup signature / lateness / priority tier" selector plus a bar-label template (order no. / material / qty). Cheap in vis-timeline (class + content functions), transformative for at-a-glance reading, and it makes the setup matrix *visible* on the board.

### 3.5 Saved work areas (named line/scope selections)
APO planners open the board through a **work area** — a saved selection of resources scoped to their responsibility. NIMBUS's `Store.selectedLines` filter is session-state; at 50+ plants / 70+ machines (the roadmap scale), "My lines: Blow-molding A" as a named, recallable, default-on-login selection becomes essential. Include the APO distinction between what you *see* and what you may *touch* (§3.9).

### 3.6 Synchronized companion charts
The APO board stacks up to 8 charts on one time axis; the two DS-relevant ones NIMBUS lacks: an **orders chart** (one row per order — reads an order's placement without hunting the line rows; also the natural home for split-segment overviews) and a fuller **per-line utilization curve** aligned under the Gantt (UtilStrip is the seed). The product stock curve is pegging/material territory — correctly out of scope.

### 3.7 Richer context menus (the interactive verb set)
APO's right-click set: reschedule (per strategy), deallocate, schedule from pool, fix/unfix, **change resource/mode**, highlight order network, find, run a heuristic on the selection, optimize the selection. NIMBUS has four entries. Natural additions as their engines land: "Send to pool" (§1.3), "Compact line from here" (§1.8), "Move to machine ▸" (eligibility-filtered submenu), "Optimize just this line," "Freeze line until…" (§1.5). Empty-canvas menu (once fixed): "Add downtime block here," "Create fixing interval."

### 3.8 Board-native downtime creation
APO planners draw downtimes directly on the resource row and scheduling flows around them. NIMBUS's blackouts live in the calendar manager — correct as the system of record, but the board gesture ("drag on empty canvas → downtime/blackout block") is the ergonomic gap, and it currently dead-ends on the missing `openCanvas`.

### 3.9 Propagation range — see more than you may touch
APO separates the display scope from the **propagation range** (resources/products a planner may change); everything else is visible but read-only. NIMBUS's `role_plants` scopes at plant granularity. At target scale, per-user *line-level* touchability ("see the whole plant, edit only your lines") prevents cross-planner clobbering — and NIMBUS's optimistic-concurrency machinery already handles the collision case; this prevents it instead.

### 3.10 Time-scale ergonomics
Small familiar gestures: right-click the time axis to switch scale granularity; Shift-drag a frame on the axis to zoom to a period; an explicit **display window vs. editable window** distinction (view 8 weeks, touch 2 — the frozen-horizon band is half of this). Also APO's "expand multiple loading" — when overlapping bars stack, an explicit per-line expand keeps overlaps visible rather than occluded.

---

## 4. Alerts & monitoring depth

NIMBUS's 9-rule engine and click-to-navigate flow already match APO's exception-based working style. The gaps are calibration and workflow:

### 4.1 Thresholds and three-tier severities per alert type
APO alert types carry up to **three user-set thresholds** mapping magnitude to Info / Warning / Error (late >24 h = info, >120 h = warning, >240 h = error; overload >5% vs >25%). NIMBUS severities are hardcoded per rule. Per-plant (or per-user) thresholds — especially a **lateness tolerance** ("don't alert on lateness under N hours," APO's max-lateness pegging tolerance in DS clothing) — turn the alert list from noise into a worklist. This tolerance should also feed the optimizer's lateness terms so "tolerated late" isn't re-planned.

### 4.2 Alert profiles (which alerts do *I* care about)
APO planners subscribe to alert types via per-user profiles scoped to their objects. NIMBUS shows everyone everything. A per-user rule-type + severity filter on the drawer (persisted via `user_settings`) is the 20% version.

### 4.3 New alert rules unlocked by §1
Each engine gap above brings its APO alert with it: `deallocated` (orders in the pool loading nothing), `relationship-violated` (link inverted / max-gap exceeded), `starts-in-past` (a true backlog alert per order, beyond the Dashboard tile), and block-mismatch once §1.9 exists.

### 4.4 Saved alert situations / push
APO batches alert determination and emails saved alert situations on a schedule. NIMBUS equivalent: a daily digest ("Plant 5512: 3 new errors overnight") via Teams/email once notification infrastructure exists. Low priority until multi-user pilot feedback asks for it.

### 4.5 KPI canon check
The S/4 PP/DS KPI canon: **capacity utilization, order delays, schedule adherence, service level**. NIMBUS covers the first two well. **Schedule adherence** — planned vs. actually-executed (needs SAP confirmation data, so post-SAP-sync) — and a service-level proxy (% orders completing by due date, which NIMBUS *can* compute today) round out the Dashboard's credibility with APO-literate management.

---

## 5. Suggested priority order

| Tier | Item | Why first |
|---|---|---|
| **1 — cheap, high trust** | §3.1 Surface hidden features + fix `openCanvas` / dep-overlay checkbox | Days of work, several "new" capabilities |
| **1** | §2.9 Per-order explanations ("why held / why moved") | Directly answers the #1 planner question; data already computed |
| **1** | §1.7 Auto-fix out-of-hours placements; §2.2 max-delay KPI | Tiny, high-signal |
| **2 — the "feels like APO" core** | §1.1 Drag scheduling modes (insert/find-slot via existing autoReflow) | The interaction gap APO users feel within minutes |
| **2** | §1.3 Deallocation pool + §2.7 deallocate-late escape valve | New state, big honesty win for backlog reality |
| **2** | §1.5 Per-line fixing intervals | Hourly-use freeze gesture; completes the fixing model |
| **2** | §3.2 Scheduling log; §3.4 bar color/label rules | Trust + at-a-glance reading |
| **3 — optimizer depth** | §2.1/§2.3 weights + priority tiers; §2.5 runtime knob + curve; §2.6 JIT post-pass | Turns three pills into a real optimizer console |
| **3** | §3.3 Named scenarios + KPI compare | Mostly composition of shipped modules |
| **4 — structural** | §2.4 cross-line assignment; §1.4 links as constraints; §1.9 blocks; §3.9 propagation range | Bigger engine work; sequence after tier 2/3 validate demand |

---

## Appendix: primary sources

- SAP Help Portal (SCM 7.0 EhP2): DS Planning Board; Detailed Scheduling Strategy; Searching for a Slot; Inserting an Operation and Closing Gaps; Scheduling Submode; Deallocation of Operations and Orders; Fixing Operations, Orders, and Time Intervals; Propagation Range; Rescheduling Operations and Orders; Campaign Optimization; Block Planning with PDS; Application Logs for Optimizers; Monitoring of PP/DS Alerts; Fixed Pegging; Resource Planning Table; Adopting or Saving a Simulation Version.
- SAP Learning (ePP/DS journeys): Defining Objectives for DS Optimization; Configuring the Optimization Profile; Defining Constraints for DS Optimization; Understanding Genetic Algorithms; Explaining the Detailed Scheduling Planning Board; Exploring Concepts and Principles of Detailed Scheduling; Exploring the Usage of Optimization in SAP S/4HANA PP/DS.
- SAP KBAs 2309349 (multi-op drag & drop), 2458574 (graphical objects), 2394127 (order creation in gaps), 1960168 (propagation-range selection).
- SAP Community / SAPinsider: Alert Monitor management in PP/DS; DS scheduling log usage; PP/DS optimizer vs. material time fence; GUI DS board vs. Fiori Advanced Scheduling Board; KPI Monitoring in PP/DS for S/4HANA.
