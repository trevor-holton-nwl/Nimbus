# Planning workflows audit and implementation

Date: 2026-10-16. Baseline: main `960abf6`. Work: `.worktrees/frontend-audit` only. Scope: Scheduling, Orders/Inspector, Distribution, Calendar, Optimization/What-If/background runs, and client routing feedback. PRODUCT.md, DESIGN.md, frontend and domain guidance informed changes. Shared styles and locales were coordinated with their owners. No deployment, live writes, backend schema changes, or optimization algorithm changes.

## Findings and changes

| ID | Severity | Reproduction / evidence | Resolution |
| --- | --- | --- | --- |
| PLN-001 | High | Enter What-If, edit line hours, discard before the 600 ms timer: speculative hours were posted after discard. Existing boundary test documented this as TODO. | Guard `saveLineHours` before enqueue, clone payloads, convert TODO to ordinary regression. Hydration has the same enqueue guard. |
| PLN-002 | High | A speculative line or plant blackout upsert cleared the durable live pending-delete tombstone before `_post` checked What-If. Discard then lost the outstanding deletion. Two existing TODO cases. | Check hydration/What-If before changing the tombstone. Both tests now ordinary passing regressions. |
| PLN-003 | High | Queue live hours, enter What-If, let debounce expire, discard: the live batch was drained through a skipped `_post` and silently lost. Newly added test failed against the first fix. | Keep the batch while What-If is active; a one-shot Store exit subscription resumes live values on discard. Cloned values prevent in-place trial edits from mutating the queued live payload. |
| PLN-004 | High | Queue live hours, enter/edit/promote before debounce expiry: promotion posted retained values, then old timer posted the pretrial values over them. Newly added test failed against the first fix. | `flushPlant` clears the old timer, payload and exit listener before posting promoted state. A batch whose timer already expired resumes current retained values on promotion; an unchanged other plant's live batch is preserved too. |
| PLN-005 | Medium | Orders toolbar Clear reset chips and native filters but left quick search; the empty-state Clear separately reset quick search. Quick/native filter changes did not refresh the filter summary, and `isAnyFilterPresent` could label external/quick filters as column filters. | Both buttons call one reset path for quick text, native filters, shared machine selection, color/status/date/pasted IDs and picker search. Filter-change events refresh summary/clear visibility. Native-filter annotation reads the actual column filter model; quick search independently exposes Clear. |
| PLN-006 | Medium | Gantt free text searched description/order display text but omitted material number and parent order identifiers. | Match task ID, order/production order, parent order, material number and description. Existing line/color/form/pasted-ID restrictions remain conjunctive. |
| PLN-007 | Medium | Scheduling context menu had pointer invocation only, no menu focus/navigation, and bottom clamping could produce negative top on a short viewport. | Shift+F10/Menu opens the focused Orders row or selected Gantt order. Add menu/menuitem roles, focus first available action, Up/Down wrapping, Home/End, Escape restore, Tab exit, and viewport-bounded geometry. Scrolling inside the menu keeps it open. Gantt container is focusable. Shared owner supplied overflow and focus styles. |
| PLN-008 | Medium | Nine-column Distribution shares table occupied a 45% detail pane with no editor CSS, preventing practical comparison of weights, quantities, hours, outcomes and actions. | Expand details / Show order list changes the existing layout without rerendering inputs, retaining draft weights, preview identity and caret/input DOM. Add accessible state and a named keyboard-focusable table scroll region. Shared CSS supplies bounded two-axis scroll, sticky header/totals, numeric input widths and wrapping actions/facts. |
| PLN-009 | Medium | Edit Calendar immediately showed success although line hours were only queued and plant saves had not been acknowledged. | Accurate informational text: locally updated/syncing, or What-If only/promote to save. Existing failed-sync Retry/delete-pending feedback remains authoritative. |
| PLN-010 | Low | Print/CSV modal silently used all loaded orders, with no explicit plant/current Orders filter scope. | Add a scope selector: All loaded orders (unchanged default), Selected plant, Current Orders filters. Filtered scope uses AG Grid's displayed row model, including native, quick and chip filters. Date-overlap and split-piece range logic remain unchanged. CSV uses the same preview rows. Missing dates clear cached export rows. |

## Surface coverage and retained contracts

All entries below are source/behavioral-test coverage. No browser visual pass is claimed.

| Surface | Reviewed behavior and disposition |
| --- | --- |
| Timeline, navigator, hierarchy and filters | Shared selection, material/order search, line/filter semantics, split-item identity, setup markers, plant clock, drag/resize finish anchoring, protected-row unschedule guards. Search and context menu changed; existing geometry and scheduling tests pass. |
| Orders toolbar/grid/saved layout/empty state | Quick/native/chip/paste reset, shared machine selection, counts/clear visibility, Needs Planning status/reason/window, explicit-save edits, source/due date immutability, grid cell routing guards. Unified reset and summary feedback changed. |
| Inspector, multi-selection, override and setup detail | Planned finish remains editable; planned start/due date remain readonly. Routing edit releases use existing hold rules. Manual/frozen/running protections and distribution machine lock retained. Existing focused tests verify all keyboard date paths still use finish anchoring. |
| Context menu | Pointer and keyboard entry, visible actions, focus restore, viewport clamping and internal scroll. Unit tests verify behavior with a small viewport; actual zoom/screen-reader behavior remains pending. |
| Print/CSV | Explicit scope, all-loaded compatibility, current grid rows, plant isolation, date overlap/split pieces, CSV quoting/formula guard, plant-local time. Existing 500-row print preview cap retained. |
| Distribution list | Search/work-center/bucket/date/batch/shared-machine filters, pagination refresh, reviewed/bulk actions, current plant/request guards, error/truncation state. Existing tests pass; no behavior changes. |
| Distribution detail/editor | Facts/basis/audit metadata, weights and quantity mode, totals, Only this machine/Even, preview/save/remove-confirm/reset/undo/repair, Gantt/Inspector navigation, resized-child banner. Expansion/layout changes preserve all handlers and drafts. Tests retain stale-response, double-submit and What-If protection coverage. |
| Edit Calendar modal | Plant/line hours, off-day toggles, presets, copy-from-plant, midnight=24 handling, clamp delegation, local/pending feedback. Calendar persistence boundaries now tested around discard/promotion and 70-line coalescing. |
| Blackout persistence | Plant/line scope, upsert/delete, failed delete tombstones, replay, retry rebuilt from current state, guarded hydration. Actual reachable plant/line blackout management markup is owned by Master Data; persistence fixes apply to those paths. |
| Legacy CalendarUI | `calendar-admin.mts` remains exported, but its render immediately needs `#cal-hours-body`; no such element or direct CalendarUI invocation exists in current index/shell. Treat its old hours table/add-blackout chrome as unreachable legacy, not visually tested current UI. |
| Optimize dialog | Searchable plant/line scope, four existing strategies, budgets, date range, default clock, background-run state. Existing dialog behavior retained. |
| Foreground preview | Detached candidates, comparison/rationale, diagnostics/export, task/setup/calendar invalidation, Apply gating and explicit commit. Existing stale-preview and protected placement tests pass. |
| Background optimizer | Cancellation, worker termination/run identity, toolbar state, completion popup, plant switch, task baseline changes, partial-apply validation, missing Worker refusal. Existing 65 UI / 13 worker tests pass; no scheduling engine change. |
| What-If | Enter/discard/promote/Undo task and calendar state plus dirty tracking contracts. Calendar side effects fixed. Existing 7 Sandbox tests pass. Shared agent separately owns historical snapshot restore. |
| Routing feedback | Material-specific rate-map lookup, local validity dates, SAP source-start validation, latest-request guards after response/body, same/cross-plant failures, manual runtime and distributed machine protections. Existing contract/scale suites pass; server stays authoritative. |

## Verification

Run after compiling with `npm run build`. Each Node invocation used `node --test --test-isolation=none tests/modules/<file>.test.mjs` with exactly one file, avoiding shared global-stub pollution. Latest observed results:

| File | Passed |
| --- | ---: |
| calendar/calendar-sync-boundaries | 34 (0 TODO, 0 skipped) |
| calendar/calendar-sync | 11 |
| calendar/edit-calendar | 2 |
| scheduling/planning-audit | 6 |
| scheduling/orders | 67 |
| scheduling/gantt | 81 |
| distribution/distribution-pane | 62 |
| distribution/distribution-write-conflicts | 48 |
| distribution/distribution-hydration | 3 |
| optimization/optimize-ui | 65 |
| optimization/optimizer-worker | 13 |
| optimization/sandbox | 7 |
| routing/runtime-client | 13 |
| routing/runtime-scale | 2 |
| routing/machine-edit-contract | 24 |
| routing/rate-map-contract | 4 |

Build passed. `npm run lint` completed with zero errors; new test-shadow warnings were then removed. `git diff --check` passed (an unrelated generated API-types line-ending warning remains informational). Root agent owns full repository gates and independent review. Test-emitted failure logs are deliberate mock scenarios; passing tests do not imply successful browser requests.

## Resolved choices and opportunities

- Keep the existing Needs Planning status/reason/window workflow, direct Inspector correction and optimizer diagnostic remedies. The filter-reset/search/keyboard fixes improve entry and recovery without a second exception queue or competing scheduling engine.
- Keep expanded Distribution detail inline. It is the same editor, not a modal copy; expansion changes no draft or write state. At 70 rows the bounded table avoids page growth. Virtualization remains a possible measured follow-up, not a prerequisite asserted without browser evidence.
- Keep all-loaded print default for compatibility. Selected-plant and exact Orders-filter scope are explicit opt-ins; no inferred union with Gantt dimming.
- Keep calendar feedback honest about asynchronous persistence. Durable per-edit success toasts would require a separate settled-operation contract across the plant clamp fan-out; failure Retry remains visible through CalendarSync.
- Distribution members with no share row and URL deep links remain known product gaps. This audit does not claim to have delivered either; each requires coordinated API/shell behavior beyond a layout fix.

## Limitations / pending evidence

Browser automation was unavailable despite root troubleshooting. Light/dark visual rendering, 1440x900/1366x768/1920x1080, zoom 125/150/200%, focus ring appearance, sticky totals, print layout, 1,000/10,000-order rendered stress, and assistive-technology announcements remain **pending**, not passed. Routing scale tests exercise 50 plants and 105,000 resolver calls; they are computational evidence, not UI responsiveness evidence. No screenshot or measured visual contrast evidence is attributed to this package. Independent review and full-suite results belong to root evidence files.


## Independent review response: R-PLN-001

The reviewer reproduced a deferred-hydration race omitted by the original boundary tests. Reproduced locally with the real `SandboxAdapter._onExited` subscribed before CalendarSync's delayed exit subscriber: both success and failure variants replaced the live 09:00-17:00 hours with the GET's 08:00-16:00 snapshot. The new integration suite failed before correction.

Correction stays in CalendarSync: line and plant hours carry revisions and outstanding-acknowledgment state; each GET captures a revision/pending boundary. Hydration preserves queued, in-flight, failed, and newer edits while continuing to hydrate unrelated lines/plants. A POST acknowledges only the revision it actually sent. Keeping acknowledged revision numbers also protects a GET that started earlier but resolves after the POST. Failed edits remain visible with the existing Retry action, and missing-slice migration skips pending edits rather than resending them automatically. No scheduling algorithm, SandboxAdapter ordering, or new locale text changed.

Added `calendar/calendar-hydration-races.test.mjs`: actual adapter discard with success/failure, GET before and after POST acknowledgment, POST already in flight before What-If, edits during GET/POST, actual promotion with an older GET, queued edits before debounce, missing backend rows, unrelated-line and other-plant hydration, plant-hours failure/retry, and fresh hydration after acknowledgment. Every case asserts that no adapter exception was swallowed through Store's subscriber error handler. Reviewer correction check is pending; browser limitations above still apply.


R-PLN-001 correction verification: `npm run build` passed; `calendar-hydration-races` 10/10, `calendar-sync-boundaries` 34/34, `calendar-sync` 11/11, and `optimization/optimize-ui` 65/65 passed after the corrected build, each as a separate Node process with zero TODO/skips. Targeted ESLint passed with zero errors and one existing unused `Persistence` import warning; `git diff --check` passed. An intermediate TypeScript default-parameter error was corrected before these final runs; earlier runs against stale compiled output are excluded from this evidence.
