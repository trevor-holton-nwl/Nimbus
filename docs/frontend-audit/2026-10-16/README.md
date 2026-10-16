# NIMBUS frontend audit and implementation

Work is isolated on `feature/frontend-audit` in `.worktrees/frontend-audit`, based on main `960abf6`. Astra agents audited and implemented the domain packages; independent reviewers reproduced additional races and correctness gaps before acceptance. The original checkout was preserved. No deployment was performed.

**Status:** source audit, selected implementation and independent correction reviews are complete. Final checks: **1,722 Node tests and 1,839 Python tests passed**; Python retains one existing skipped test and 13 existing expected failures. Build, typecheck, frontend lint, static assets and the reviewed compatibility inventory pass. Full Ruff retains seven unchanged baseline violations; changed Python files pass. Actual browser acceptance is blocked by the unavailable supported Browser connection. Do not interpret automated checks as certification of layout, scroll reachability, native keyboard behavior, themes or zoom.

## Read the results

| Document | Purpose |
|---|---|
| [PLAN.md](PLAN.md) | Approved scope, execution packages, invariants and required acceptance matrix |
| [COVERAGE.md](COVERAGE.md) | Whole-frontend surface inventory, precise evidence boundaries, pending browser recipes and local fixture reproduction |
| [shared.md](shared.md) | Menu/heatmap contrast, alerts and scope, shared focus/overlays, shell selectors, intelligence and snapshot protection |
| [planning.md](planning.md) | Calendar/What-If persistence, Orders/Timeline filtering and menu access, print scopes, Distribution editor and optimization/routing disposition |
| [labor.md](labor.md) | Atomic aggregate/daily persistence, pins/Undo, filter/horizon correctness, read/write errors, exception navigation and capacity display |
| [admin.md](admin.md) | Setup, Material Plant drafts, SAP race guards/archive paging, role assignments, previews, table menus and System Configuration |
| [OPPORTUNITIES.md](OPPORTUNITIES.md) | Selected productivity improvements and explicitly deferred work with implementation boundaries and acceptance criteria |
| [VERIFICATION.md](VERIFICATION.md) | Baseline, final gates, package evidence, environment and limitations |
| [PROGRESS.md](PROGRESS.md) | Execution ledger |

Independent review trails: [administration](review-admin.md), [Labor](review-labor.md), [planning](review-planning.md), [shared experience](review-shared.md), [integration and evidence](review-integration.md). All reproduced blocking findings in these reviews are closed. Findings remain recorded so readers can distinguish the original reproduction, author response and verification.

## What changed for planners

- Menus and heatmaps use matched, measured foreground/background choices; overlays have viewport bounds and stronger keyboard/focus behavior.
- Filters, alerts and summaries consistently respect the relevant scope. Orders has one clear-filter behavior; printing makes its scope explicit.
- Command search covers all selected-plant orders and line actions with bounded results, including the 10,000th test order. Labor group search retains selections outside the current search.
- Distribution details can expand in place while retaining draft shares. Tables gain bounded scroll regions and sticky context without replacing the existing workflow.
- Calendar What-If edits stay separate from live persistence; delayed saves and hydration are reviewed together.
- Labor aggregates and derived daily cells persist atomically, preserve pins, expose failures, and support exact Undo and exception-to-cell navigation over the full requested horizon.
- Material Plant drafts survive plant switches; stale SAP responses cannot replace current panels; archived orders are searchable and paged; role assignment works with searchable plant lists.
- System Configuration shows dirty/pending state and retains subsequent edits during a save.
- Snapshot restore/compare uses plant identity and existing protection/Undo rules. Independent review covers historical mixed-plant and split-segment cases.

The reports describe exact behavior and deliberate limits. New server work is limited to archive paging/search and atomic Labor reconciliation; no schema migration or scheduling algorithm redesign is part of this branch.

## Remaining acceptance

Complete the browser matrix in COVERAGE.md before declaring the entire frontend visually accepted. Synthetic fixtures cover 50 plants, 188 machines (including two 70-machine plants), 1,000/10,000 orders and 16 Labor weeks. API scope checks passed, but no browser responsiveness measurement or screenshot was possible. Remaining product opportunities are separately prioritized in OPPORTUNITIES.md; they are not hidden implementation commitments.
