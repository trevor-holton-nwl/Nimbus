---
target: "Gantt Timeline (app.js Timeline module + index.html #gantt-tab + styles.css vis-timeline overrides)"
total_score: 29
p0_count: 2
p1_count: 1
timestamp: 2026-07-13T15-56-28Z
slug: gantt-timeline
---
Method: dual-agent (A: aec5d06b6b8743ad6 · B: a7aff46e03d5ad720)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Drag-commit and Undo push are silent — no toast on either (`app.js:11201`) |
| 2 | Match System / Real World | 4 | n/a — blackout hatch, fixed-order stripe, changeover language all match shop-floor mental models |
| 3 | User Control and Freedom | 3 | Undo (10 levels) and What-If exist but Undo has zero on-screen affordance in the Gantt toolbar — Ctrl/Cmd+Z only |
| 4 | Consistency and Standards | 2 | Four different "active" visual treatments for one semantic state; an undefined `--amber` token silently falls back to a fourth ad hoc hex |
| 5 | Error Prevention | 3 | A "Fixed" (🔒) order is actually draggable — the code explicitly falls through to the normal update path |
| 6 | Recognition Rather Than Recall | 2 | Gantt Line/Color/Form filters have no live text search, only clipboard-paste matching — at 70+ lines/plant that's scroll-and-hunt |
| 7 | Flexibility and Efficiency | 4 | Paste-to-select, marquee multi-select w/ edge-scroll, double-click line isolation, 500ms hover preview — real power-user tooling |
| 8 | Aesthetic and Minimalist Design | 3 | Clean hairline/dense layout; icon-set inconsistency (mono glyphs + color emoji in one toolbar row) is the main blemish |
| 9 | Error Recovery | 3 | Concurrency conflicts get a specific toast; a blackout drag-snap-away reverts silently with no explanation |
| 10 | Help and Documentation | 2 | Tooltips exist on toolbar buttons, but no legend anywhere decodes the 10-line palette, the two hatch meanings, or the conflict outline |
| **Total** | | **29/40** | **Good** — solid foundation, address the weak areas below |

## Anti-Patterns Verdict

**Start here: does this look AI-generated?** Mostly no — with three specific tells.

**LLM assessment (Assessment A):** The interaction engineering is genuinely mature — a peak-displacement pan-vs-click disambiguator, marquee multi-select with edge-scroll, paste-to-select filtering, a virtualized/pinned line hierarchy built for the 70-lines/plant target. That's not template output. But three things would make an expert user of Linear/Stripe-caliber tools flinch: (1) monochrome glyph icons (◉ ▦ ☖ ⊡ ⊙ ⎙) mixed with full-color emoji (🗂️ 🖥️ 📈 🔮) in the same toolbar row — an assembled, not designed, icon vocabulary; (2) **four incompatible visual treatments for the same "this control is active" concept** on one screen; (3) a stray blue fallback (`var(--accent, #60a5fa)`) and an undefined `--amber` token in an amber-only design system, both suggesting some rules were written without cross-checking the token file.

**Deterministic scan (Assessment B):** `detect.mjs --json index.html` returned exit 2, 83 findings (35 design-system-color, 27 design-system-font-size, 17 design-system-radius, 2 bounce-easing, 1 side-tab, 1 em-dash-overuse). **Zero of these 83 fall inside the `#gantt-tab` element (verified precisely: lines 1253–1480)** — every hit is in the inline `<style>` block for other components (OptimizerPreview modal, header plant combobox, Labor tab) or in `#labor-tab` itself. Spot-checked 3 flagged lines against source; all were accurate, not misfires.

**Where the two assessments agree vs. diverge:** This isn't a contradiction — it's the expected division of labor. The static detector can only see markup that exists in `index.html` at parse time: the toolbar shell, filter-dropdown markup, sidebar containers. The actual Gantt bars, line-color classes, blackout hatch, conflict outlines, and active-state CSS are either rendered at runtime by vis-timeline/JS or live in the external `styles.css` (which a markup-only scan of `index.html` doesn't reach). That's exactly where Assessment A's real findings live — the line-0/accent color collision and the four active-state rules are both in `styles.css`, invisible to this scan. **A clean scoped scan here does not mean the rendered timeline is clean; it means the detector's blind spot and this critique's area of concern happen to be the same place.**

**Visual overlays:** Not available this run — no browser-automation tool was exposed to either sub-agent, and no dev server was running on localhost:8000. No screenshot or live-page evidence was captured; every finding below comes from reading source, not from observing the rendered page. Treat visual-only claims (spacing, exact rendered contrast) with that caveat; every finding below was independently verified against the actual `styles.css`/`app.js` source, not taken on the sub-agent's word.

## Overall Impression

This is a well-engineered scheduling surface let down by CSS that was never reconciled against its own token file. The interaction model — drag, marquee-select, paste-filter, sandbox what-if — is the kind of depth a template-generated UI never accumulates. But the visual system has drifted: one line color is byte-identical to the one accent DESIGN.md says should never mean anything but "focused," and the same "is this button on?" question gets answered four different ways within a single screen. The single biggest opportunity is a consistency pass on state styling (P1 below) paired with actually filterable line/color/form pickers (P0) — the latter isn't cosmetic, it's a direct violation of NIMBUS's own scale mandate on its busiest screen.

## What's Working

- **The blackout treatment matches the design spec exactly**: `.vis-item.blackout` renders a diagonal red hatch, not a solid fill (`styles.css:761`) — precisely the "unavailable, not an order" language DESIGN.md calls for.
- **Interaction engineering is genuinely mature**: the peak-displacement pan-vs-click disambiguator (`app.js:11838+`) solves a real touchpad/inertial-scroll false-trigger bug most UIs never get around to fixing.
- **Hierarchy scales deliberately**: the virtualized, pinned-to-top, alpha-sorted line list in the left sidebar (`app.js:9262+`) is the one part of this screen actually built with the 70-lines/plant target in mind — worth using as the reference pattern for the fixes below.

## Priority Issues

**[P0] Gantt line/color/form filters have no live search, contradicting NIMBUS's own scale mandate**
- **Why it matters**: CLAUDE.md states directly: "Plant and line lists must always be filterable — at 50+ plants and 70+ lines, scrolling is not enough." The Gantt filter checklists (`#gantt-line-checklist` / `-color-checklist` / `-form-checklist`) only respond to a clipboard-paste event (`Util.wirePasteToCheckboxes`, `app.js:549`) — there's no `oninput` handler, so typing does nothing. Verified: the Dashboard's near-identical filter (`#line-filter-search`, `index.html:1155`) *does* wire `oninput="NIMBUS.Dashboard._filterLineSearch(this.value)"` — same `dash-filter-*` component class, materially different behavior, on the app's two busiest screens.
- **Fix**: Wire the same live-filter handler the Dashboard already has onto the three Gantt checklist inputs.
- **Suggested command**: `/impeccable harden`

**[P0] Line-0's Gantt color is byte-identical to the one brand accent color**
- **Why it matters**: Verified in `styles.css`: `--l0: #b8791a` (line 69) and `--accent: #b8791a` (line 43) are the exact same hex in light mode. DESIGN.md's One-Accent Rule requires amber to mean "highlighted/active/focused" and nothing else — but on this screen, an amber Gantt bar is genuinely ambiguous with "this element is selected." (Note: dark mode remaps `--accent` to `#d4920f`, so this specific collision is light-mode-only — light is the default theme.) `--l4`/`--l8` (`#b14a3e`/`#a8493a`) are also close enough at Gantt-bar size to warrant a second look, though that's a softer claim than the exact l0/accent match.
- **Fix**: Regenerate the 10-color line palette to exclude the accent hue, and re-check l4/l8 separation.
- **Suggested command**: `/impeccable colorize`

**[P1] Four incompatible "active" visual treatments on one screen**
- **Why it matters**: Verified all four in `styles.css`: `.seg-btn.active` fills with `var(--primary)` (line 245); `.gantt-toolbar .seg-btn[data-gantt-sub].active` fills with `var(--accent)` plus a box-shadow glow (line 248); `.tab-btn.active` uses a 2px outline plus a `--bg-subtle` fill (line 132); `.gantt-line-btn.active` fills with `var(--amber, #d4a843)` — and `--amber` is never defined anywhere in the file, so that fallback hex is the *only* value that ever renders (line 1884). DESIGN.md documents the tab convention as "the outline, not the fill, marks current" and separately bans shadow-accents outside floating surfaces — this screen has both problems plus a genuinely undefined token, undermining "consistent component vocabulary" on the app's primary screen.
- **Fix**: Pick one active-state pattern and apply it to seg-btn, the gantt-sub toggle, and the filter-trigger buttons; define `--amber` or drop it in favor of the real `--accent` token.
- **Suggested command**: `/impeccable polish`

**[P2] Silent drag-commit with no visible Undo, and a padlock that doesn't actually lock**
- **Why it matters**: `UndoStack.push` has no toast (`app.js:11201`) and the Gantt toolbar has no Undo button — Ctrl/Cmd+Z is the only affordance. Separately, verified via code comment (`app.js:~12520`): a "Fixed" (🔒) order falls through to the normal drag-update path — "Fixed items are user-draggable." A scheduler dragging a real order gets no confirmation it moved or that it's reversible; a stress-tester's first instinct — "does the lock actually lock?" — fails silently.
- **Fix**: Add a lightweight toast on drag-commit referencing Undo; either enforce the fixed-order drag-lock or relabel the padlock to mean "protected from the optimizer" rather than implying immobility.
- **Suggested command**: `/impeccable clarify`

**[P3] `.timeline-empty-overlay` hardcodes a light-mode color with no dark-mode override**
- **Why it matters**: Verified — `.timeline-empty-overlay` (`styles.css:3883`) sets `background: rgba(245, 244, 239, 0.92)` with no corresponding `body.dark` rule anywhere in the file. This overlay sits directly on the Gantt canvas for the "no plant selected" state, so a dark-mode user gets a near-white flash on the app's primary screen — a live instance of the dark-mode gap CLAUDE.md already flags as a known, general issue.
- **Fix**: Add a `body.dark .timeline-empty-overlay` rule using the `--bg`/`--bg-elev` dark tokens.
- **Suggested command**: `/impeccable adapt`

## Persona Red Flags

**Alex (Power User)**: Reassigning an order's line in the Inspector uses a bare native `<select>` with no search (`app.js:9046`), and the Gantt line/color/form filters are paste-only (P0 above). At the declared 70-lines/plant target, Alex's two most routine actions — filter to my lines, reassign this order — both degrade to scroll-and-hunt or "paste from Excel and hope."

**Sam (Accessibility-Dependent)**: Line-0's color literally equals the one accent color used to signal "active/focused" elsewhere on screen, so an amber Gantt bar can't be reliably told apart from a focused control. There is no on-screen legend anywhere decoding the 10-line palette, the two different diagonal-hatch meanings (locked vs. blackout), or the conflict outline — Sam has to reverse-engineer the visual grammar from scratch, with no text alternative to lean on.

**Riley (Stress Tester)**: Dragging a padlocked "Fixed" order succeeds rather than being blocked — the exact "does the lock actually lock" probe a stress-tester runs first — and it fails silently, with no warning toast on that path (unlike the adjacent skipped-fixed-in-multi-drag path, which does toast).

## Minor Observations

- A plant with zero orders (vs. no plant selected) has no dedicated empty state — the empty overlay only fires on `!Store.selectedPlant`, so a valid-but-empty plant shows blank line rows indistinguishable from "still loading."
- `.vis-item.fixed-order` (diagonal white stripe) and `.vis-item.blackout` (diagonal red hatch) reuse the same "diagonal hatch = special state" grammar for two opposite meanings — workable via color, but worth a legend.
- `var(--accent, #60a5fa)` on `.btn-optimize:hover` (`styles.css:257`) is a stray blue fallback in an amber-only system — harmless today since `--accent` is always defined, but a code-quality tell worth cleaning up alongside the `--amber` fix above.
- The toolbar's Optimize/What-If buttons share `.seg-btn` styling with the Hour/Day/Week view toggles, even though they're one-shot launchers rather than persistent-state toggles — same visual vocabulary for two different interaction models.
- A blackout drag-snap-away reverts a drop with no toast or explanation — a first-timer sees their drag silently undone with no stated reason.

## Questions to Consider

- If line-0 is byte-identical to the brand's one accent color, has anyone looked at Line 0's Gantt bars sitting next to a focused element in the running app, or only at the token list in isolation?
- The Dashboard's line filter got a live search box and the Gantt's near-identical filter didn't — intentional scope cut, or two components built independently against the same class names without comparing notes?
- "Fixed" orders show a padlock and a diagonal stripe that read as "cannot move," but the code lets you drag them anyway — is the promise "protected from the optimizer" or "protected from you," and does the UI say which?
- Four different encodings of "this control is on" exist on one screen — was there ever a moment all the active-state CSS was read side by side, or did each ship independently against the same class-name pattern?
