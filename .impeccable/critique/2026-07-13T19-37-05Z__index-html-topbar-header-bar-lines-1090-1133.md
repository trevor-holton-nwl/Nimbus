---
target: "topbar / header bar (index.html:1090-1133)"
total_score: 26
p0_count: 0
p1_count: 3
timestamp: 2026-07-13T19-37-05Z
slug: index-html-topbar-header-bar-lines-1090-1133
---
Method: dual-agent (Assessment A: source-only design review · Assessment B: detector scan, isolated, no cross-contamination)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3/4 | Save button never shows a dirty/pending indicator — the highest-stakes control in the bar gets the least feedback |
| 2 | Match System / Real World | 3/4 | Nav vocabulary is precise, but the 🧹 in the literal wordmark has no scheduling referent |
| 3 | User Control and Freedom | 3/4 | Explicit Save + working plant-clear are solid; no affordance for switching tabs mid-edit |
| 4 | Consistency and Standards | 2/4 | Two tab icons are color-presentation emoji that can't take the active-tab accent color; "Labor Plan" breaks the i18n convention every sibling tab follows; Confidence badge uses its own color set and radius outside the token system |
| 5 | Error Prevention | 3/4 | Little destructive interaction lives in the bar itself |
| 6 | Recognition Rather Than Recall | 2/4 | Plant selector shows a bare code ("1006") with no name — a recall tax that grows as the roadmap scales to 50+ plants |
| 7 | Flexibility and Efficiency of Use | 3/4 | Type-to-filter combobox and documented shortcuts serve power users; Save's own shortcut isn't documented in its own tooltip |
| 8 | Aesthetic and Minimalist Design | 3/4 | Flat hairline-bordered look matches DESIGN.md well; undercut by the broom motif, the off-token pill, and widget count (up to 10 elements in 52px for admins) |
| 9 | Error Recovery | 2/4 | Alert bell can show "0" while alerts exist outside the configured horizon, with nothing disclosing that filter is active |
| 10 | Help and Documentation | 2/4 | No persistent legend for the Confidence score's color tiers or the Log dot's meaning; bell tooltip doesn't survive accessible-name computation |
| **Total** | | **26/40** | **Acceptable — significant work needed before this is genuinely tight** |

## Anti-Patterns Verdict

**Start here: does this look AI-generated?** No, not at a glance — but two adjacent tells and one brand-register mismatch keep it from a clean pass.

**LLM assessment (Assessment A):** Checked against all seven named absolute-ban patterns (side-stripe borders, gradient text, glassmorphism, hero-metric template, card grids, uppercase eyebrows, numbered markers) — the topbar passes every one. The `.topbar::after` amber rail is the sanctioned brand device, not a stripe accent; the 11px uppercase labels (`.hps-label`, `.ni-conf-label`) are documented DESIGN.md "Label" type used functionally, not decorative eyebrows.

But two things not on the literal ban list still read as bolted-on: (1) the Confidence badge's sparkline hardcodes stock Tailwind green/amber/red (`#22c55e/#f59e0b/#ef4444`) while the score digit six lines above uses the app's real `--ok/--warn/--err` tokens — same signal, two different color families, in one 100px pill; (2) that badge's `border-radius:20px` has no home in a system DESIGN.md defines as 4/6/10/14px — a rounded pill KPI chip is a recognizable generic-SaaS silhouette even though "pill badge" isn't literally banned. Also flagged: the 🧹 broom baked directly into `.brand-name` ("NIMBUS 🧹") works against PRODUCT.md's own registered personality ("industrial, precise, no-nonsense... not a consumer app").

**Deterministic scan (Assessment B):** Ran the bundled detector against `index.html`. Exit code 2, 83 total findings — **zero of them fall inside the topbar's line range (1090-1133) or reference its CSS selectors.** This is a real "clean bill," but a partial one by construction: the detector only scanned `index.html` markup, and the topbar's most interesting anti-pattern (the sparkline's foreign color palette, the off-token radius) lives in `nimbus-intelligence.js`'s injected `<style>` string — a file/pattern the detector wasn't pointed at. This is exactly a case where the LLM review caught something the tool structurally couldn't. No false positives to report since there were no in-scope hits either way.

## Overall Impression

The topbar's bones are genuinely good — correct IA (brand → scope → nav → status/actions), a disciplined One-Accent-Rule on the active tab, and a plant-selector combobox that's a model implementation of the app's own "always searchable, never a bubble picker" mandate. What drags the score down isn't slop, it's **incompleteness**: one untranslated tab label, one unindicated dirty-save state that the codebase already knows how to build correctly two thousand lines away, a rendering bug from a typo'd closing tag, and a widget (the Confidence badge) that was clearly built as a separate feature drop and never fully reconciled into the token system it sits inside. The single biggest opportunity: reconcile the Confidence badge into the same visual language as everything around it, and give Save the same unsaved-state treatment the Master Data grid already has.

## What's Working

1. **The plant-selector combobox is a model implementation of the system's own scaling mandate.** Type-to-filter, runtime-managed `aria-expanded`/`aria-haspopup`, a working clear button, pinned-plant prioritization — exactly the "searchable combobox, never bubbles" principle CLAUDE.md and DESIGN.md call out by name, correctly built.
2. **Disciplined One-Accent-Rule execution on the active tab.** A 2px amber outline, not a fill or underline cliché, cleanly separates "current tab" (amber) from "action you can take" (deep-slate primary button) — including a correct dark-mode remap.
3. **Hairline-divider grouping instead of boxes or shadows.** The two `::before` dividers separating the status cluster from the action cluster are a small, correct application of DESIGN.md's own Hairline-Over-Shadow Rule.

## Priority Issues

**[P1] "Labor Plan" tab is permanently unlocalized**
- **Location**: `index.html:1114-1116`
- **Category**: Consistency / i18n
- **Why it matters**: The one primary-nav label with no `data-i18n` attribute, unlike its four siblings — it stays hardcoded English in de/es/fr/pt in the single most persistently-visible UI element in the app, every day, for every non-English user.
- **Fix**: Add `data-i18n="tab.labor"` and the matching key across all 5 locale files.
- **Suggested command**: `/impeccable harden`

**[P1] Global Save carries no unsaved-changes indicator**
- **Location**: `index.html:1130` (the topbar `.btn-primary`)
- **Category**: Visibility of System Status
- **Why it matters**: This button persists schedule edits to Postgres — the highest-stakes action in the app — yet gives zero visual signal about whether it's currently needed. The Master Data grid's own save button already implements a dirty-state class + badge a few thousand lines away in the same file.
- **Fix**: Port that same isDirty → class-toggle pattern to the topbar Save button, keyed off `Persistence`'s dirty-task set.
- **Suggested command**: `/impeccable polish`

**[P1] Malformed closing tag renders visibly garbled text for pinned plants**
- **Location**: `app.js:17097` — `<span class="hps-pin-ico" ...>📌<\span>` (note `<\span>`, not `</span>`)
- **Category**: Correctness / rendering bug
- **Why it matters**: Not a valid tag-close sequence — browsers parse-error and print the literal text `<\span>` right after the pin emoji in the plant dropdown. Pinning plants is a workflow the app's own User Settings feature actively encourages, and this gets more visible, not less, as the roadmap's 50+ plant target arrives.
- **Fix**: Correct to `</span>`.
- **Suggested command**: `/impeccable harden`

**[P2] Zero responsive/overflow handling on the entire bar**
- **Location**: `styles.css:87-96` (`.topbar`), `.tabs`, `.tab-btn`, `.brand`
- **Category**: Responsive Design
- **Why it matters**: Brand + 72px plant input + 5 tabs (three multi-word) + up to 5 right-side widgets, all in one non-wrapping flex row, with none of the file's 6 media breakpoints touching any of these selectors — a real risk on laptop-width viewports or a window shared side-by-side, a routine scenario for daily users.
- **Fix**: Add a breakpoint collapsing tab labels to icon-only (or truncating) below ~1200-1300px.
- **Suggested command**: `/impeccable adapt`

**[P2] `--warn` fails AA contrast as text/icon color, used twice in this bar**
- **Location**: `styles.css:56` (`--warn: #b57a0a`); consumed by the Confidence score's 40-69 tier text and the alert-bell icon when only warn-severity alerts exist
- **Category**: Accessibility
- **Why it matters**: `#b57a0a` against the app's own backgrounds computes to roughly 3.1-3.3:1 — below the 4.5:1 AA minimum — and both usages sit in the 13-15px range, so neither qualifies for the large-text exception.
- **Fix**: Introduce a darker `--warn-text` token for text/icon use; keep `--warn` for background tints only.
- **Suggested command**: `/impeccable harden`

## Persona Red Flags

**Alex (Power User, plant scheduler, dense daily use)**
- Plant recall burden: the field shows a bare code ("1006") with no name, in 72px — a tax that compounds, not shrinks, as the roadmap scales to 50 plants.
- No unsaved-state cue on the button Alex needs feedback from most, all day, every drag-edit session.
- Up to 5 discrete topbar-actions widgets with only 2 divider hairlines distinguishing "read this" from "act on this" — efficient once memorized, but nothing but position marks the difference.

**Sam (Accessibility-Dependent, screen reader / keyboard)**
- `#alert-bell`'s accessible name is computed from its visible glyph+count content, not its `title="Alerts"` — per accname precedence, visible content wins, so a screen reader announces something like "white pennant 5," not "Alerts." The one safety-critical widget (conflict/overload/blackout alerts) is effectively unlabeled.
- `role="tablist"`/`role="tab"` is applied but `aria-selected` is never set and there's no roving `tabindex` — the WAI-ARIA tabs keyboard pattern isn't implemented.
- The active-tab amber-icon cue silently fails for Master Data/Admin Cockpit because their icons are color-presentation emoji that ignore CSS `color` — a low-vision user relying on that cue gets it for 3 of 5 tabs, not 5.

**Non-English-locale scheduler** (project-specific, derived from CLAUDE.md's Design Context + the app's 5-locale support)
- Sees 4 correctly-translated tab labels and one ("Labor Plan") stuck in English every day — a persistent, visible tell that this part of the product wasn't finished for their locale, in the one UI element they see on every screen.

## Minor Observations

- `.brand-mark` and `.brand-ver` (`index.html:1092`/`1094`) are empty `<span>`s with dedicated CSS but are never populated by any code path — dead markup.
- Save has no `title` documenting its Ctrl/Cmd+S shortcut, while the admin Log button explicitly documents Ctrl+Alt+L — inconsistent shortcut discoverability within the same bar.
- The Log button's status dot is raw emoji (🔴/🟡/🟢) rather than the app's own `--err`/`--warn`/`--ok` tokens — the same "borrowed vocabulary" pattern as the Confidence sparkline.
- `alert-badge` caps at "99+" while the Log button shows its raw uncapped count — two conceptually similar counters with no shared overflow convention.
- `WelcomeSplash.init()`'s only guard is a per-page-load boolean, not a persisted flag — worth confirming live whether returning users see a brief flash of the dimmed/glowing topbar on every reload before it dismisses.

## Questions to Consider

1. Confidence badge, alert bell, and (for admins) the Log toggle are all fundamentally "is something wrong" signals — why are they three separate widgets with three separate visual languages (pill, icon+badge, dot+text) instead of one unified status affordance?
2. The plant selector is the one control everything else in the bar is scoped by — tabs, alerts, confidence score, even what Save persists. Should it really be a 72px input sandwiched between the wordmark and the tabs, or should getting the plant right be the visually dominant action once there are 50+ of them to choose from?
3. The codebase already knows how to show "you have unsaved changes" correctly on the Master Data grid. Was leaving the global Save uninstrumented a deliberate call, or just the most-used control being the least-instrumented?
