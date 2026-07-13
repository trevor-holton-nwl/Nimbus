---
target: NIMBUS Dashboard (index.html home-tab)
total_score: 27
p0_count: 0
p1_count: 1
timestamp: 2026-07-13T15-29-42Z
slug: nimbus-dashboard-index-html-home-tab
---
Method: dual-agent (A: a6c7eb95b3d08a43a · B: a83745ee13e629c1d)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3/4 | No "last updated" timestamp; no loading indicator while a large plant's matrix builds |
| 2 | Match System / Real World | 3/4 | Strong domain vocabulary throughout; the 🧹 emoji in the hero has no scheduling referent |
| 3 | User Control and Freedom | 3/4 | Filter/clear/horizon toggle all present; no Escape-to-close on the line-filter dropdown |
| 4 | Consistency and Standards | 2/4 | Line-filter trigger lacks the ARIA popup semantics the header's plant selector has for the same interaction pattern on the same screen |
| 5 | Error Prevention | 3/4 | Low-risk read-mostly surface; "Unfix" gives no confirmation feedback beyond the row vanishing |
| 6 | Recognition Rather Than Recall | 2/4 | Conflicts Pending / Overdue Backlog / Open Alerts sit side-by-side with identical styling despite different scopes (today-only vs. all-time vs. rolling horizon) |
| 7 | Flexibility and Efficiency | 3/4 | Click-through KPIs, searchable line filter, horizon toggle; filter selection doesn't persist across sessions |
| 8 | Aesthetic and Minimalist Design | 3/4 | Flat/hairline aesthetic matches DESIGN.md; docked for a redundant double-banner (hero strip + "Today's Overview" saying the same thing) |
| 9 | Error Recovery | 3/4 | The lateness drill-down is a genuine diagnose-and-act loop; no verified fetch-failure state for this tab specifically |
| 10 | Help and Documentation | 2/4 | Inline legends work as micro-docs; no contextual help for denser concepts like "capacity headroom" |
| **Total** | | **27/40** | **Acceptable — up from 22/40 baseline** |

## Anti-Patterns Verdict

**LLM assessment:** The prior fix pass genuinely landed on what it targeted — no bubble/chip selectors, no gradient hero, no glassmorphism, and the `border-left` accent stripe on KPI tiles is confirmed gone (replaced by a leading status dot, `styles.css:348-350`). Two softer smells remain: the KPI stack is still the generic six-identical-cards dashboard template with no prominence hierarchy between tiles, and the "Welcome to NIMBUS 🧹" hero banner is an unpersonalized, permanently-visible line of chrome whose emoji doesn't map to anything in the domain — for a screen opened dozens of times a day, it's the generic-consumer-SaaS habit PRODUCT.md explicitly disclaims.

**Deterministic scan:** `detect.mjs --json index.html` returned 84 total findings (exit 2). After mapping every finding's line to its owning selector, **26 are Dashboard-owned** (11 `design-system-font-size`, 11 `design-system-radius`, 4 `design-system-color`); the remaining 58 sit in the OptimizerPreview modal (`.opt-pv-*`), User Settings, header plant-selector, or Labor Planning — out of scope for this tab. Of the in-scope color findings, one is a confirmed true positive both assessments caught independently: `.lh-drill-late { color: #dc2626; }` (index.html:463) doesn't match the documented `--err` token (`#b1362a` light / `#d94a3a` dark) — a stray off-palette red inside the very panel that was supposed to have been fully tokenized. One font-size finding is a confirmed **false positive**: `.lh-legend-more`'s 10px JetBrains Mono sits exactly inside DESIGN.md's documented 10–14px mono range, which the detector's frontmatter ramp doesn't encode. The remaining font-size/radius findings are all sub-11px/sub-4px micro-UI values (status dots, scrollbar thumbs, mono date digits, legend captions) that look like an undocumented "micro" tier rather than real drift — the same class of gap already fixed once this session for the 12.5px `control` type step.

**Visual overlays:** Not available — no browser automation tool is exposed in this session, so no live overlay could be injected. This report is based on markup/CSS/JS-logic review, not pixel inspection.

## Overall Impression

The Dashboard is materially better than the 22/40 baseline: the generic hero is gone, KPI tiles and heatmap cells are now real keyboard-accessible buttons, and color/contrast logic reads live tokens instead of hardcoded per-theme hex. What's left is narrower and more surgical — the fixes so far addressed structure and token plumbing, but didn't touch how severity is *communicated*. The single biggest opportunity: the KPI row is the first thing a scheduler sees every time they open this tab, and right now a business-critical Overdue Backlog of 40 reads exactly as calm as a Fixed Orders count of 3, because severity color never reaches the number itself.

## What's Working

1. **The lateness drill-down is a real diagnose-and-act loop.** Clicking a red cell surfaces the actual late orders (due date, scheduled date, lateness magnitude) with a jump-to-order action into the Gantt — not just a metric, an escalation path.
2. **The accessibility fix actually landed in code, not just in claim.** KPI tiles, utilization-heatmap cells, and clickable lateness cells are confirmed genuine `<button type="button">` elements with `:focus-visible` outlines — both assessments independently verified this by reading the render code, not just the CSS.
3. **The line filter takes the scale mandate seriously.** A search-filterable checklist with stale-selection cleanup on plant change is a real implementation of CLAUDE.md's "no bubble/chip pickers past ~10 entries" rule, not lip service.

## Priority Issues

**[P1] KPI severity color never reaches the number it's meant to flag**
- **Why it matters:** `.kpi-tile.warn .k` / `.kpi-tile.err .k` (styles.css:358-361) recolor only the tiny uppercase label and the 6px dot — there is no `.kpi-tile.warn .v` / `.kpi-tile.err .v` rule anywhere (confirmed by direct grep). The 26px mono value, the single most glanceable element on the tile, stays plain ink regardless of severity. PRODUCT.md's own north-star principle is that on-time delivery risk should be legible before anything else competes for attention — right now it isn't, on the row a scheduler scans first.
- **Fix:** Add `.kpi-tile.warn .v { color: var(--warn); }` / `.kpi-tile.err .v { color: var(--err); }`.
- **Suggested command:** `/impeccable colorize`

**[P2] A hardcoded off-token red survives inside the panel this session was supposed to fully tokenize**
- **Why it matters:** `.lh-drill-late { color: #dc2626; }` (index.html:463) — found independently by both assessments. It doesn't match `--err` (`#b1362a`/`#d94a3a`), won't remap in dark mode, and drifts from the app's own semantic-red everywhere else on the same screen.
- **Fix:** Replace with `color: var(--err);`.
- **Suggested command:** `/impeccable polish`

**[P2] Dark-mode token gaps in exactly the surfaces this session already touched**
- **Why it matters:** Two independent gaps: `--warn-vivid` (the heatmap's mid-severity ramp stop) has no `body.dark` override, so dark mode silently reuses a light-tuned amber while its ramp neighbors are dark-tuned — breaking the intended smooth idle→overload gradient. Separately, `.kpi-tile.is-actionable:hover`'s box-shadow (`rgba(0,0,0,0.06)`) has no dark variant, so the hover affordance on the KPI row is nearly invisible in dark mode. Both are the "partial dark-mode remap" trap DESIGN.md's own Named Rules section warns against, reproduced inside code that was specifically supposed to have been fixed to read real tokens.
- **Fix:** Add a dark-tuned `--warn-vivid` to the `body.dark` block; give `.kpi-tile` hover a token-based or dark-specific shadow.
- **Suggested command:** `/impeccable polish`

**[P2] Line-filter dropdown lacks the ARIA popup semantics its sibling combobox has**
- **Why it matters:** `#line-filter-btn` (index.html:1147) has no `aria-haspopup`/`aria-expanded`, and its dropdown has no `role="listbox"`. Three feet away, the header's plant-selector uses the identical interaction pattern and correctly ships `aria-haspopup="listbox" aria-expanded="false"`. There's also no Escape-to-close — only an outside-click listener — so a keyboard-only user who opens the dropdown has no keyboard path to dismiss it.
- **Fix:** Mirror the plant-selector's ARIA attributes and wire an Escape key handler.
- **Suggested command:** `/impeccable audit`

**[P2] Three overlapping "problem" KPIs, same visual weight, different scopes**
- **Why it matters:** Conflicts Pending (today, err-severity only), Overdue Backlog (all-time past-due), and Open Alerts (rolling horizon, all severities) sit adjacent with identical styling and only a one-line caption distinguishing them. Under the time pressure this product is built for, misreading "0 conflicts today" as "nothing's overdue" while Overdue Backlog silently carries 15 is a plausible, costly failure.
- **Fix:** Add a consistent scope prefix to each caption ("Today ·", "All-time ·", "Next Nh ·"), or visually cluster the three risk tiles apart from the two informational ones.
- **Suggested command:** `/impeccable clarify`

## Persona Red Flags

**Sam (Accessibility-dependent):** Gets a properly announced combobox at the top of the screen (header plant selector) and a mystery button with no announced popup semantics three feet below it (line-filter). No keyboard path to dismiss the open dropdown.

**Central Planner / cross-plant admin** *(project-specific persona, derived from PRODUCT.md's stated admin audience)*: PRODUCT.md describes this role as "monitoring health across plants through the dashboard," but the Dashboard tab is entirely single-plant-scoped with no comparison view. At the 50+ plant target, an admin has no way to see "which plant is worst today" without clicking through the plant selector one plant at a time — this persona is named in the product doc but effectively unserved by this tab.

**Alex (Power user):** The line-filter selection lives in an in-memory `Set` on the Dashboard module, reset on plant change, with no evidence it's persisted to `Store`/localStorage. A scheduler who always filters to "my 3 lines" has to reapply that filter every session.

## Minor Observations

- `.ls-bar` declares a `transform` transition (`index.html:921-925`) but the fill percentage is set via inline `style="width:..."` in JS — `width` isn't in the transition's property list, and the row's HTML is fully rebuilt on refresh anyway, so the intended smooth utilization-bar animation is dead CSS that never fires.
- The fixed-orders list truncates silently at 12 items with no overflow affordance, while the alert list explicitly renders "See all N alerts →" past 8 — at target scale, a scheduler could lose visibility into locked orders without knowing more exist.
- The `_relLuminance` contrast check for heatmap/lateness cell text uses a fixed `>0.45` threshold rather than computing an actual contrast ratio against both text-color candidates — a reasonable proxy, but not a guaranteed 4.5:1 at the margins.
- Three different "go look at X" conventions coexist on one screen (top tabs, context-strip shortcuts, KPI tile click-throughs) — not wrong, but worth being deliberate about as the tab grows.

## Questions to Consider

- If due dates are the stated north star, why does "Orders Today" (a neutral count) get the same visual priority as Overdue Backlog — and why does neither KPI's own number carry severity color?
- Is a "Welcome to NIMBUS" banner earning its permanent slot on a screen a scheduler opens dozens of times a day — what would that strip say if it had to justify its pixels the way every KPI tile does?
- Given PRODUCT.md names cross-plant admins as an equal-weight persona, does a single-plant Dashboard even make sense at 50+ plant scale, or does that persona need a fundamentally different view this tab doesn't attempt?
