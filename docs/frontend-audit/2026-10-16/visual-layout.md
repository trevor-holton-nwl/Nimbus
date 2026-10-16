# Visual layout repair record

## Scope and evidence

Baseline: `main` at `3f58bfe`. Implements the approved desktop/laptop visual repair plan from the conversation: scrolling, clipping, input sizing, modal padding, crowded navigation, and tooltip placement. Existing design tokens, data contracts, scheduling behavior, and save semantics are retained.

**Rendered acceptance is pending.** The supported Browser runtime returned an empty browser list on both the planning and implementation passes. No screenshots, browser geometry measurements, or visual pass results were produced. The Node tests exercise layout interaction logic, not a rendering engine.

Worktree creation was attempted but the sandbox denied the Git ref lock. Targeted edits were therefore made in the original checkout; unrelated user changes were preserved. No database was accessed, fixture was seeded, or deployment performed.

## Finding register

All “implemented” entries below still require the specified browser retest.

| ID | Priority | Reproduction / previous cause | Implemented correction | Browser retest |
|---|---|---|---|---|
| V01 | P1 | Master Data → Work Centers, enough rows to exceed window height. Pane omitted from bounded flex rules; body hides overflow. | Bounded pane, shrinkable scrollers, fixed Load More, full-width sidebar search. | Reach final row and Load More; scroll detail independently; switch away/back and verify hidden panes. |
| V02 | P1 | Open plant or machine Edit Calendar. Shared Optimize section class applies a two-column grid to calendar content. | Dedicated vertically stacked calendar sections; narrow-container day layout. | All seven day controls, badges, and copy action remain separated. |
| V03 | P2 | Calendar labels and content meet modal edges because body horizontal padding is zero. | 16px vertical / 20px horizontal padding, 20px section gaps. | Check both modes, short height, all presets, and focus rings. |
| V04 | P1 | Generic typed-input selectors override component classes. | Low-specificity baseline type selectors; explicit flexible time inputs and viewer search sizing. | Calendar visible Flatpickr inputs, Distribution dates, Setup filters, priority/color search; compare to other inputs and login. |
| V05 | P1 | Setup override history: four columns exceed the standard dialog body width. | Dedicated 720px maximum dialog, shrinkable/wrapping columns, body-container breakpoint. | Long machine/signature/reason, small and large minutes values, 200% zoom. |
| V06 | P2 | Setup upload asks for 720px width but inherits a 440px maximum. | Explicit 720px maximum, bounded by backdrop gutters. | Upload/paste, preview counters, long rejection messages, footer. |
| V07 | P2 | Manage Data Tables: column menu overlays heading and is transparent on keyboard focus. | Reserved 32px trailing header space and focus-within visibility. | Hover/focus every narrow header; open column menu at viewport edge. |
| V08 | P2 | Security user toolbar has no inset inside its panel. | Scoped 12px/14px padding; staged action group can wrap. | Search, paste, staged-save state, long translations. |
| V09 | P2 | Column mapping close button has an undefined styling class. | Existing small icon-button component. | Open mapping, focus/activate Close, confirm dismissal behavior. |
| V10 | P2 | Admin help coordinates initialize only on mouseover and do not clamp to viewport. | Focus/hover positioning, edge clamping, downward fallback, scroll/resize repositioning; long tips can scroll. | Keyboard-first opening, each viewport edge, scroll while focused, resized window. |
| V11 | P1 | Global listeners prevent browser zoom shortcuts and Ctrl-wheel. | Removed global zoom cancellation. | Browser zoom/reset work; verify timeline-specific gestures separately. |

## Additional containment changes

- Master Data and table navigation scroll horizontally. Refresh and Export Schema remain outside the strips. Focus/click and programmatic tab selection reveal the relevant tab without scrolling the vertical page.
- Orders/grid toolbars wrap and search inputs can shrink. Panel headings have explicit gaps and can wrap.
- Plant General and Setup configuration use available-width-based grids. Production Line hours can wrap across rows.
- Shared, Optimize, Calendar, and priority-viewer dialogs have bounded heights, nonshrinking headers/footers, and shrinkable body/list scrollers. Viewport gutter target: at least 16px.
- Login header, form, and footer participate in normal flow within a vertically scrollable panel, preventing the fixed footer from covering a tall form/error state.

These additional changes address source-demonstrated constraints. Their actual visual appearance remains unverified. Remaining dashboard drilldown, Labor nested-scroll, shell chrome, and popup layering risks must be evaluated in the browser before further layout changes are justified.

## Coverage matrix

Every row requires rendered inspection; existing source/functional coverage is not a visual pass.

| Area | Required states / interactions | Rendered status |
|---|---|---|
| Shell | Login/error, navigation, command/context bars, settings, plant/machine search, toasts | Pending browser |
| Dashboard | KPI extremes, long labels, charts, both heatmaps, drilldowns, alerts, confidence | Pending browser |
| Scheduling | Timeline axes, sidebars, context menus, Orders filters/editors, inspector, override, print | Pending browser |
| Optimization | Options, nested date pickers, preview, completion, What-If | Pending browser |
| Distribution | List/detail, expanded editor, 70 members, totals, actions, rejection feedback | Pending browser |
| Master Data | All six tabs; calendars, blackouts, long names; 100 Work Centers; paging/search | Pending browser |
| Setup | List, Matrix, definitions, physical state, history, upload, compatibility | Pending browser |
| Priority lists | Cards, mapping, color and generic viewers, search/sort/empty | Pending browser |
| Labor | Aggregate, Line Plan, Capacity, Exceptions, Inputs; 70 lines and 16 weeks | Pending browser |
| Security | Users/roles, searchable plant access, staged rows, password controls | Pending browser |
| SAP | Overview, mappings, history, staging, outbound/archive, long rejection output | Pending browser |
| Admin | Diagnostics, logs, maintenance, configuration, generic tables, table browser | Pending browser |
| Shared overlays | Confirmation/schema/cascade dialogs, tooltips, dropdowns, date pickers, menus | Pending browser |

## Browser acceptance recipe

Use local synthetic data only; check the active DB before setup. Reuse the existing frontend-audit fixture recipe, adding Work Centers and specialized Setup/Distribution states as needed. Do not use destructive tests against the browser fixture DB.

1. Record build, browser, role, plant, theme, viewport, and zoom. Capture 1920×1080, 1440×900, 1366×768, 1280×720, and 1280×600. Run critical workflows at 100/125/150/200% zoom and record effective viewport dimensions.
2. Check light/dark, admin/planner, long German/French text, loading/empty/error, expanded content, and unsaved validation states.
3. Reach every final row, last column, and primary action. Dense data grids may scroll horizontally; page chrome and forms must not accidentally spill offscreen.
4. Use keyboard focus as well as mouse. Check focus rings, time-picker popups, dropdowns, and menus at every viewport edge. Modal footers must remain accessible.
5. Capture before/after evidence for each finding and record actual scroll owners, measured overflow, and any new defect. Retest fixes together once, preserving unchanged correct layouts.

## Automated verification

Implementation checks and independent source review are recorded here after completion. Browser results remain pending regardless of automated test outcomes.

- Initial build: passed.
- Focused frontend suites: 102 passed (includes four new layout interaction tests).
- `npm test` (including fresh build): **77 legacy + 1,649 module = 1,726 passed**, zero failures/skips/TODOs.
- `npm run typecheck`: passed.
- `npm run lint`: passed, zero errors and 34 existing warnings.
- `npm run check:static-assets`: passed; the new layout module is inside the served import boundary.
- `npm run check:legacy-surface`: passed, no inventory drift.
- `git diff --check`: passed.
- Independent source review: no confirmed defects. Reviewer specifically retained browser verification for global input specificity, Calendar container sizing, and tooltip hover/scroll behavior.

The sandbox blocked isolated Node child-process creation during the first focused run. The focused and full suites subsequently ran successfully with approved normal-process execution. Existing tests intentionally log simulated HTTP errors; the recorded totals above are the runner's final results.

## Execution decisions

- Implement in the original checkout after sandbox-denied worktree creation; preserve unrelated edits and leave changes reviewable.
- Use existing CSS and TypeScript build conventions, with a small dependency-free `platform/layout.mts` for layout interactions. Its compiled twin is ignored.
- Do not fabricate screenshots or substitute DOM mocks for rendered acceptance. Browser unavailability blocks visual certification, not the confirmed source fixes.
- No speculative redesign or backend changes. Remaining unconfirmed layout risks are retained in the acceptance matrix.
