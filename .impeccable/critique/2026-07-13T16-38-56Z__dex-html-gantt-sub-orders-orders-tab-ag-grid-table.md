---
target: Orders tab (AG Grid table + filter-chip bar)
total_score: 24
p0_count: 1
p1_count: 2
timestamp: 2026-07-13T16-38-56Z
slug: dex-html-gantt-sub-orders-orders-tab-ag-grid-table
---
Method: dual-agent (A: a1f7d69a2db2496d4 · B: aefc7c02ef5d6d3a9)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Native AG-column filters can silently suppress rows with no chip-bar acknowledgment |
| 2 | Match System / Real World | 3 | Two icon-only column headers (🔒, 📝) with hover-only tooltips, no text fallback |
| 3 | User Control and Freedom | 2 | Inline cell edits, Fix/Unfix, and date overrides get no Undo coverage |
| 4 | Consistency and Standards | 2 | Same filter-chip component behaves differently on this tab vs. its Gantt-tab sibling |
| 5 | Error Prevention | 1 | Bulk Fix/Unfix has no confirmation and no undo, regardless of selection size |
| 6 | Recognition Rather Than Recall | 3 | Chip labels and the line-color dot aid recognition; Copy Mode is 100% recall-only |
| 7 | Flexibility and Efficiency | 3 | Strong power-user surface, but the two scale-critical pickers are the least efficient controls in the view |
| 8 | Aesthetic and Minimalist Design | 3 | Clean and token-driven; marred by a hardcoded-hex leak in JS-generated dropdown markup |
| 9 | Error Recovery | 2 | Zero-rows states (empty plant / over-filtered) fall through to AG Grid's raw, unstyled default overlay |
| 10 | Help and Documentation | 2 | No in-context help; the tab's richest feature (Copy Mode) has no discoverable entry point |
| **Total** | | **24/40** | **Acceptable — significant improvements needed before users are happy** |

## Anti-Patterns Verdict

**Start here.** Does this look AI-generated? **No** — and that's worth stating plainly. The Orders tab has none of the composition-level AI-slop tells: no side-stripe borders, no gradient text, no glassmorphism, no hero-metric template, no identical card grids, no eyebrow labels standing in for real hierarchy. It's a purpose-built data-grid toolbar that follows its own established `.dash-filter-*` component shape consistently, including correct disabled-state treatment pre-plant-selection. This is a genuine strength, not a given.

Where it does slip is a level down: a **hardcoded-hex-color leak** inside JS-generated dropdown HTML, bypassing the token system entirely.

**LLM assessment (Assessment A)**: flagged `#9a9285` (muted text), `accent-color:#b8791a`, and `border-top:1px solid #ece8e0` scattered across the chip-dropdown-building code (`app.js` ~8250-8320), plus a third, independently-invented "amber" recipe in `.orders-copy-badge`/`.nimbus-range-sel` (Tailwind-style `#fef3c7`/`#fcd34d`/`#b45309`, and a bare `rgba(251,191,36,…)`) sitting a few lines from the real `--accent`/`--accent-wash`/`--accent-hot` tokens. None of these participate in `body.dark` — dark-mode correctness here is a real open question, not a nitpick.

**Deterministic scan (Assessment B)**: 117 raw findings across `index.html`+`app.js`, but almost all belong to other tabs/modules. Scoped strictly to the Orders tab markup (`index.html:1257-1258,1384-1475`) and the `Table` module (`app.js:7852-8959`): **zero** findings in `index.html`'s own Orders markup, and **8** in `Table` — four `design-system-color` hits at `app.js:8251,8268,8287,8314` for `#9a9285`, one `border-radius:5px` (between the documented sm/md steps), two off-ramp font-sizes (`14px`/`16px` in the alert-breakdown popup), and one false positive (`font-family: inherit` at line 8058 — the detector's regex flagged the CSS keyword `inherit` as an undeclared font; it isn't one).

**Where they agree — and it's a strong signal**: both assessments independently landed on the *same four lines* (`8251/8268/8287/8314`, off by one in A's citation) for the `#9a9285` leak, without seeing each other's work. That's not a coincidence of two people reading the same obvious thing — it's a real, verifiable drift, confirmed twice.

**Where the detector missed what the LLM caught**: A also found `accent-color:#b8791a` and `border-top:#ece8e0` hardcodes in the same region that B's automated scan never flagged — those CSS properties apparently sit outside detect.mjs's current color-matching pattern. Worth a note for whoever maintains the detector, but not something to chase here.

**Visual overlays**: not available this run. No browser automation/computer-use tool was exposed in this session, so Assessment B correctly skipped starting a live server rather than guessing at rendered appearance — and, per this project's own documented risk (local `.env` may point at the live Azure pilot database), it deliberately did **not** attempt to boot the real backend to get a live view. No user-visible overlay exists to check in a browser tab this run; all findings below are source-verified, not visually confirmed.

## Overall Impression

This is a well-built, disciplined data grid that doesn't read as AI-generated — genuinely rare, and worth crediting. But it has two regressions relative to the codebase's *own* established patterns, both concrete and low-risk to fix: (1) its filter-chip bar is structurally identical to the Gantt tab's — which just got upgraded this session to search-as-you-type under an explicit CLAUDE.md scale mandate — and never received the same fix, so the two sibling views of the same data now behave differently for no design reason; (2) bulk Fix/Unfix, arguably the single most consequential toggle on this tab (it decides whether the optimizer can touch an order at all), is the only bulk-mutation path anywhere in the app with zero confirmation and zero undo. Closing the first gap is almost a copy-paste of work already done this session on the Gantt tab.

## What's Working

1. **The line-color dot in the `PRODUCTION_LINE` cell** (`app.js:8013-8018`) reuses the same `Timeline._colorIndex` palette as the Gantt chart — a scheduler recognizes a line's color instantly whether they're on the grid or the timeline, without a second color language to learn.
2. **Copy Mode's flash feedback** (`styles.css:1121-1126`) is a precise, on-brand micro-interaction — sub-100ms, no bounce, exactly the "mechanical switch" feel DESIGN.md prescribes. Evidence the team executes the brand's motion vocabulary correctly when they get to a feature.
3. **The filter-chip bar's compositional discipline** — no AI-slop template reflexes anywhere in this view, and disabled pre-plant-selection states correctly follow the documented 0.4-opacity/not-allowed treatment.

## Priority Issues

**[P0] Line filter and line-reassignment editor violate the Production Scale Roadmap's hard mandate**
- **Why it matters**: CLAUDE.md states, as a hard project mandate, that plant/line lists must always be filterable at scale and bans unsearchable chip/bubble selectors. The Orders tab's Line/Color chip dropdowns (`app.js:8171-8186,8235-8269`) are paste-only — no type-to-filter — while the *structurally identical* Gantt-tab dropdown one tab over was upgraded this session specifically to satisfy this mandate (its code comment cites CLAUDE.md directly). The inline line-reassignment cell editor (`app.js:8010-8012`) is also a plain, unsearchable AG Grid Community select — the actual scheduling control, not just a filter, making this the more consequential of the two instances.
- **Fix**: port the Gantt tab's `oninput`→`_filterLineSearch`/`_filterColorSearch` wiring onto `Table`'s existing paste inputs (additive, not a rebuild — the DOM and paste-wiring are already there); for the cell editor, build a lightweight custom searchable editor or move to `agRichSelectCellEditor` if AG Grid Enterprise licensing allows.
- **Suggested command**: `/impeccable harden`

**[P1] No confirmation or undo for bulk Fix/Unfix**
- **Why it matters**: `fixSelected(fixed)` (`app.js:8629-8636`) mutates any number of selected rows' optimizer-lock state in one click. Every other bulk-mutation path in the app (drag-move, unschedule, optimizer apply, labor-cell paste) calls `UndoStack.push`; this is the sole exception, on the one action that decides whether the optimizer is even allowed to touch these orders.
- **Fix**: snapshot fixed-state via `UndoStack` before mutating, and add a confirm step for large selections or for unfixing (the riskier direction).
- **Suggested command**: `/impeccable harden`

**[P1] Zero-rows states fall through to AG Grid's raw default overlay**
- **Why it matters**: neither "plant selected, zero orders" nor "filtered to zero results" reuses the app's own `EmptyState` component (`app.js:16806-16819`) — both hit AG Grid Community's unstyled, unlocalized "No Rows To Show" with no clear-filters affordance, despite a Clear Filters button sitting two lines away and a working empty-state pattern already built for the no-plant-selected case.
- **Fix**: add `overlayNoRowsTemplate` to `gridOptions` reusing `.nimbus-empty-state` markup, with copy distinguishing "no orders yet" from "your filters matched nothing" (linked to `_clearChipFilters()`).
- **Suggested command**: `/impeccable polish`

**[P2] Silent AG-native column filters aren't reflected in the chip bar's state**
- **Why it matters**: `_hasChipFilters()` (`app.js:8188-8191`) only tracks the 5 custom chips; AG Grid's own per-column filters can be silently restored from a saved layout (`_applySavedLayout`, `app.js:7904-7921`) and remain active with zero acknowledgment — a returning user can see "All Lines / All Colors" and an inexplicably low row count.
- **Fix**: have chip-state checks also query `Table._api.isAnyFilterPresent()` and surface a distinct indicator, or fold native-filter clearing into `_clearChipFilters()`.
- **Suggested command**: `/impeccable clarify`

**[P3] Hardcoded hex colors bypass the token system in JS-generated dropdown markup**
- **Why it matters**: confirmed independently by both assessments (see Anti-Patterns Verdict) — `#9a9285`, `accent-color:#b8791a`, `border-top:#ece8e0`, and a third ad-hoc amber recipe in `.orders-copy-badge`/`.nimbus-range-sel` all bypass `var(--fg-mute)`/`var(--accent)`/`var(--line)`, with real dark-mode-correctness risk since none participate in `body.dark`.
- **Fix**: straight find-and-replace onto the real CSS variables — no design decision required.
- **Suggested command**: `/impeccable polish`

## Persona Red Flags

**Alex (Power User)**: Hits the P0 gap hardest — Alex manages many plants/lines and feels a 70-entry unsearchable checkbox and an unsearchable line-reassignment dropdown every day. Also the persona most likely to multi-select rows and use "Unfix selected" as a routine action, making Alex the one most exposed to the no-confirm/no-undo gap. And Alex is the only persona likely to ever discover Copy Mode at all, since there's no in-UI entry point — just a keyboard shortcut (`Ctrl+Y`) a tooltip only reveals after it's already been triggered.

**Sam (Accessibility-Dependent)**: Two icon-only column headers (🔒, 📝) have no aria-label or text fallback, only hover-only tooltips a keyboard-only or screen-reader user may never trigger. Copy Mode's actual value — dragging to extend a range — is mouse-only; a keyboard-only Sam can enter the mode but can't do anything more than `Ctrl+C` a single cell inside it. The hardcoded, non-token colors in the Status/Date dropdowns are also the most likely spot in this view to fail dark-mode contrast, and Sam is the persona for whom that's a functional blocker, not a cosmetic nit.

## Minor Observations

- Status/Date chip descriptive copy ("past SAP due date", "has error alert", "Any status" — `app.js:8276-8292,8319`) is hardcoded English, unlike the grid's column headers, which are properly localized via `t('col.*')` — an inconsistency within the same tab. This is the same pattern already flagged once before in this project's history (route new UI text through `t()`, even small badges).
- `MATERIAL_DESCRIPTION` has no tooltip for overflow text, while the adjacent `notes` column hand-rolls one via a `title` attribute — likely an oversight, not a deliberate choice.
- The "fixed" column header is visually blank (`headerName: ''`); a first-time user scanning headers sees two unlabeled narrow columns before reaching anything legible.
- The `applyOverride()` toast fires before the user has any visual signal that the override created a new conflict — reactive, not preflight, for the action most likely to create a due-date conflict.
- Detector false positive: `app.js:8058`'s `font-family:inherit` is the CSS keyword, not an undeclared custom font — no action needed.

## Questions to Consider

- If the Gantt tab's filter dropdown was explicitly upgraded to search-as-you-type under the Production Scale Roadmap mandate this session, why wasn't the *structurally identical* Orders-tab filter bar upgraded in the same pass?
- Fix/Unfix is the only bulk action in the app with no undo — deliberate scope cut, or did it just never get wired up when `UndoStack` was added elsewhere?
- Copy Mode is real and well-built but has zero discoverable entry point — is it meant to stay an insider shortcut, or should it graduate into a visible toolbar button?
