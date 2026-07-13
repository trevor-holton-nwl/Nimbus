---
target: NIMBUS Dashboard (index.html home-tab)
total_score: 22
p0_count: 0
p1_count: 3
timestamp: 2026-07-13T14-33-00Z
slug: nimbus-dashboard-index-html-home-tab
---
Method: dual-agent (A: a49f11296290c76ba · B: a15f455447b07add2)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | KPI ticker and alert bell update live, but no loading/skeleton state distinguishes "still computing" from a genuine zero on plant switch/first load. |
| 2 | Match System / Real World | 3 | Domain vocabulary (SAP due date, "CO", blackout) is correct for expert schedulers, but "Hop On" + 🧹 clash with the plant-floor register the rest of the page uses. |
| 3 | User Control and Freedom | 3 | Clear-filter, dismiss-alert, and close-drill all work, but "Unfix" and alert dismiss are single unconfirmed clicks with no visible undo affordance on the surface itself. |
| 4 | Consistency and Standards | 2 | Two ad hoc heatmap color ramps bypass the app's real `--warn`/`--err` tokens; the KPI accent-stripe reintroduces a banned pattern; fixed-list truncates silently at 12 while alerts get a "See all N" link for the identical overflow problem. |
| 5 | Error Prevention | 2 | No confirmation/undo surfaced for "Unfix" or alert dismiss taken directly from the dashboard. |
| 6 | Recognition Rather Than Recall | 2 | KPI-tile clickability is invisible until hover (`.is-actionable::after` opacity 0→1 only on `:hover`) — nothing static signals these are buttons. |
| 7 | Flexibility and Efficiency | 2 | No dashboard-specific keyboard shortcuts; the one line filter is mouse-only and has no search box (unlike its Gantt/Table siblings). |
| 8 | Aesthetic and Minimalist Design | 2 | Panels below are genuinely dense/clean, but the 1.3fr hero (40px h1 + eyebrow + dual CTA) outweighs the 1fr KPI stack beside it. |
| 9 | Error Recovery | 1 | No error-state UI anywhere in `Dashboard.render()`'s pipeline — only "no plant selected" is handled. |
| 10 | Help and Documentation | 2 | Panel-hint microcopy gives light contextual help; no glossary/doc link for terms like "CO". |
| **Total** | | **22/40** | **Acceptable — significant improvements needed** |

## Anti-Patterns Verdict

**LLM assessment (product-slop test):** Passes at a glance, fails on inspection. The panel/grid/hairline-border vocabulary is genuinely close to Linear/Stripe-caliber density. But a fluent eye stops at three places: (1) the hero banner — `<div class="eyebrow">Hop On</div>` / `<h1>Welcome to NIMBUS 🧹</h1>` (index.html:1157-1158) is a straight consumer-SaaS marketing-hero pattern sitting on top of what's supposed to be a control-room instrument; (2) `.kpi-tile::before` (styles.css:338-341) is a 3px colored left-edge stripe on every KPI card — the exact "colored bar on a stat card" pattern DESIGN.md's own Don'ts list bans; (3) three different, mutually inconsistent "red" systems appear on one screen (`--err` #b1362a on KPI tiles, `#dc2626`/`#991b1b` in the two heatmaps, `#c0392b` on `.dash-filter-clear`) — a template-assembled look, not a designed one.

**Deterministic scan:** `detect.mjs --json index.html` — exit code 2, 141 total findings, all in `index.html` (styles.css was not scanned this pass — see gap note below). Assessment B corrected the resolved target boundary: `#home-tab` actually spans lines 1130–1238 (not 1130–1622 as initially scoped; the next tab, `#gantt-tab`, opens at 1242). Within the true Dashboard range, only 2 findings: an undocumented color (`#9a8f84`) and an off-ramp font-size (12px) both on the same inline-styled "Line Status · Today" label (index.html:1186) — real drift, not a false positive, verified against DESIGN.md's palette/type ramp. The other 139 findings sit in unrelated markup (OptimizerPreview/color-wheel modal, User Settings, Labor Planning, Master Data) — out of scope for this Dashboard critique, but two are worth flagging anyway since they're confirmed real DESIGN.md violations elsewhere in the same file: a `border-left` accent stripe on `.opt-pv-footer-note` (line 807, the exact pattern this Dashboard critique also flags on KPI tiles) and two bounce-easing violations (`cubic-bezier` overshoot >1, lines 515/789) against DESIGN.md's "nothing bounces" rule.

**Gap to disclose:** the detector was only run against `index.html`; `styles.css`'s actual DASHBOARD section (styles.css:291-561, 3183-3195) — where the `.kpi-tile::before` accent-stripe violation lives — was never mechanically scanned this pass. That finding stands on the LLM review alone; it is not detector-confirmed (though it doesn't need to be — it's a direct, verifiable match against DESIGN.md's own banned-pattern list).

**Visual overlays:** unavailable this run — no browser-automation tool exposed in this session, and the app's Postgres+uvicorn backend wasn't confirmed running. CLI/LLM findings stand alone.

## Overall Impression

The panel-and-KPI vocabulary below the fold is genuinely close to the Linear/Stripe caliber this register aims for — dense, hairline-bordered, state-aware copy. It's undercut by three things stacked at the very top of the screen the user opens 20+ times a day: a consumer-SaaS marketing hero that outranks the due-date KPIs it sits beside, a colored-stripe card pattern the project's own DESIGN.md explicitly bans, and an interactive layer (KPI tiles, heatmap cells) that announces itself as keyboard-accessible without actually being so. The single highest-leverage fix is the hero/KPI hierarchy inversion — a one-line grid-template change that directly serves DESIGN.md principle #1 ("due dates are the north star"), which this screen currently violates on its own front door.

## What's Working

1. KPI tile description text is state-aware, not static — flips between reassuring ("no backlog", "none blocking") and urgent ("blocking, fix now") copy based on live value (app.js:9647-9653) — gives the "due dates north star" principle real teeth in copy, not just color.
2. `Dashboard._animateTicker` (app.js:9784-9796) eases KPI values between old/new numbers on re-render instead of hard-cutting — motion tied to a real state change, matching the product register's "motion conveys state, not decoration" rule.
3. The lateness drill-down (app.js:10191-10235) is textbook progressive disclosure: dense heatmap by default, click-to-expand a capped, worst-first list of actual late orders with due-vs-scheduled comparison and a one-click jump — directly serves the product's core due-date-visibility purpose.

## Priority Issues

**[P1] Hero banner outranks the KPIs it sits beside.** `.hero-row` (styles.css:301-305) is `grid-template-columns: 1.3fr 1fr`, giving "Welcome to NIMBUS 🧹 / Hop On" plus two large CTA buttons more width and reading priority than `#kpi-stack`. Why it matters: this is the first thing every plant scheduler sees, every session, on a screen whose stated job is to make on-time delivery legible before anything else competes for attention — and it duplicates navigation already in the top tab bar. Fix: collapse the hero to a slim single-line context strip (plant name / date) and give the KPI stack full width and first visual priority. Suggested command: `/impeccable layout`.

**[P1] KPI-tile accent stripe is the exact pattern DESIGN.md bans.** `.kpi-tile::before` (styles.css:338-341, recolored by `.warn`/`.err` at 349-350) is a 3px colored bar pinned to the card's left edge — the same `border-left`-as-accent-stripe pattern the Don'ts list explicitly forbids, confirmed elsewhere in the same codebase by the detector (index.html:807). Why it matters: it's on the single most-viewed surface in the app and is a well-known generic-dashboard-template tell. Fix: replace with a soft background tint or a small leading icon. Suggested command: `/impeccable harden`.

**[P1] KPI tiles are keyboard-dead despite announcing themselves as buttons.** `role="button"`/`tabindex="0"` (app.js:9680-9681) is wired only to `onclick` — no `keydown` handler anywhere targets these elements. Why it matters: a screen-reader/keyboard user tabs to the tile, hears "button," presses Enter/Space, and nothing happens — actively worse than not being focusable at all. Fix: use a real `<button class="kpi-tile">` (same CSS, free keyboard semantics) or add a shared Enter/Space handler. Suggested command: `/impeccable harden`.

**[P2] Two invented severity-color systems compete with the app's real tokens.** `heatBg`/`heatText` (app.js:9819-9832) and `cellBg`/`cellText` (app.js:10124-10137) hand-roll gradient ramps instead of the app's own `--ok`/`--warn`/`--warn-vivid`/`--err` tokens used by the KPI tiles and alert rows on the same screen. Fix: derive both ramps from the existing semantic tokens. Suggested command: `/impeccable colorize`.

**[P2] The dashboard's line filter is the least scale-ready filter in the app.** `_refreshLineDropdown` (app.js:9442-9465) renders a plain scrollable checkbox list with zero search/paste affordance — unlike the functionally identical dropdowns in the Gantt and Orders table, which both support paste-to-select. This undercuts the project's core scale mandate (searchable/filterable at 50+ plants / 3,500+ lines). Fix: reuse the paste-row pattern already built twice elsewhere in this file. Suggested command: `/impeccable adapt`.

## Persona Red Flags

**Alex (Power User):**
- No static affordance that KPI tiles are clickable — the `→` glyph is invisible until hover — so a scan-and-click user won't discover the shortcut and will manually re-navigate to Orders instead.
- Every session opens on the same unchangeable "Welcome to NIMBUS" hero with no collapse/dismiss control — pure daily scroll-past tax for a repeat user.
- `_renderFixedList` caps at 12 (app.js:10044) with no count or "see all" link — if Alex has 20 fixed orders, 8 are invisible with no indication, unlike the Active Alerts panel's "See all N alerts" link for the identical problem.

**Sam (Accessibility-Dependent):**
- KPI tiles are `role="button" tabindex="0"` with no keydown handler — Tab reaches them, the screen reader announces "button," Enter/Space do nothing.
- Both heatmap cells (`.hm-cell`, `.lh-cell`) are plain `<div onclick=...>` with no `tabindex`/`role` at all — the lateness heatmap's drill-down, one of the richest interactions on the page, is entirely unreachable without a mouse.
- `.dash-filter-hint` (index.html:149-154) is `color:#b5b0a8` on a white/off-white panel — roughly 2:1 contrast, well under the WCAG AA 4.5:1 floor for the "N orders visible" status text.

**Priya — Central Planner (project-specific persona, from PRODUCT.md's second named user role):**
- The Dashboard is single-plant only (scoped throughout `Dashboard.render` to `Store.selectedPlant`); there's no cross-plant rollup ("which of my plants have open err alerts right now") anywhere on this screen, so her actual job — triage across many plants — requires switching the global Plant Selector N times and re-reading an identical single-plant layout each time.
- The static hero banner never adapts for her workflow (no per-plant summary, no "N of 12 plants have open conflicts" framing) — it's built for the plant-scheduler persona and offers her nothing, even though PRODUCT.md names her as an equal-weight user of this exact screen.
- Every plant switch drops any line-filter selection that isn't valid in the new plant, with no per-plant memory — she re-sets her focus every hop.

## Minor Observations

- `index.html:1186` — inline style on the "Line Status · Today" label uses an undocumented color (`#9a8f84`, closest DESIGN.md neutral is Faint Iron Gray `#9a9ba1`) and an off-ramp 12px font-size — small, real drift caught by the detector.
- `.dash-filter-clear` uses hardcoded `#c0392b` (index.html:141,144) instead of `var(--err)` (`#b1362a`) — a detectably off-palette red.
- The entire `.dash-filter-*` family (index.html:50-197) is hardcoded light-mode hex with zero `body.dark` overrides — in dark mode this filter bar stays light while every surrounding panel goes dark.
- `_syncLineStatusHeight()` (app.js:9511-9521) copies pixel heights between panels via `requestAnimationFrame` but has no `window.resize` listener — resizing the window can leave two panels visibly mismatched until the next data-driven re-render.
- Emoji-as-icon (🧹 in the h1, 🔒 as the fixed-order pin) stand out against an otherwise glyph-consistent icon system (▾, ✕, →) — reads as inconsistency, not a deliberate choice.
- Detector also confirmed real DESIGN.md violations elsewhere in `index.html`, outside this Dashboard critique's scope (a border-left accent stripe on the OptimizerPreview modal footer, two bounce-easing violations) — worth a dedicated `/impeccable audit` pass on the rest of the file.

## Questions to Consider

- If a scheduler opens this 20+ times a day, what does "Welcome to NIMBUS" actually buy after session one — and wouldn't that space be worth more as a 7th KPI or a cross-plant alert rollup?
- The KPI tiles already know how to sound calm on a good day and urgent on a bad one — what would it take to give the two heatmaps below them the same voice, instead of leaving them as raw colored numbers?
- PRODUCT.md names two equal-weight personas, but this Dashboard is built for exactly one of them (the plant scheduler) — is "Dashboard" secretly two different screens wearing one tab?
