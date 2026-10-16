# NIMBUS frontend audit and improvement execution

Approved scope: entire reachable desktop/laptop frontend, light/dark themes, keyboard and 100/125/150/200% zoom; correctness, readability, scrolling, filters, persistence, and planner productivity. Astra performs implementation and independent review. Preserve the product identity and scheduling semantics. Small API changes are allowed; no wholesale redesign or deployment.

Baseline: main 960abf6. Worktree: .worktrees/frontend-audit; branch feature/frontend-audit. The original checkout contains unrelated user changes and must remain untouched.

## Execution packages

1. Labor integrity: group/line filters across subviews, 16-week horizon, pinned daily overrides, aggregate/derived persistence, failure feedback, Undo, context-preserving exception navigation. Own frontend/labor, backend/labor, labor data functions in master_data.py and related tests.
2. Shared experience: context-menu contrast, heatmap contrast, alert footer/count scope, shell filter state, focus/keyboard/overlay geometry. Own styles.css, platform, shell, insights, intelligence, index.html and related tests. Coordinate CSS for other packages.
3. Administrative state: Setup compatibility, Material Plant dirty navigation, SAP stale requests/archive pagination, role plant keyboard selection, large catalogs. Own setup/master-data/integration/security/priority-list/admin-ops UI and corresponding narrow backend/test edits, excluding Labor functions.
4. Planning workflows: Scheduling/Orders filter reset and search, accessible context menu, scoped print/export, Distribution expanded detail/table layout, calendar save feedback, optimization/What-If audit. Own scheduling/distribution/calendar/optimization/routing frontend and tests; coordinate shared styles.
5. Browser evidence and complete surface inventory: safe local fixtures, all primary and nested surfaces, visible states, both themes, desktop/laptop/zoom, keyboard, errors, races, 50 plants/70 machines, 1,000 ordinary and 10,000 stress orders. No live writes. Record unavailable coverage honestly.
6. Cross-review and verification: independent Astra review of all packages, focused fixes, frontend gates and safe local Python coverage, final audit findings/coverage/opportunities/evidence documents.

## Required audit matrix

Shell/login/settings/navigation; Dashboard/heatmaps/alerts/intelligence; Timeline/Orders/Inspector; Optimization/background/What-If; Distribution list/editor; calendars/routing feedback; Master Data and generic tables; Setup and priority lists; all five Labor views; Security; SAP staging/outbound/archive; Admin diagnostics/logs/config/table browser; shared dialogs/menus/pickers/toasts. Mark unreachable legacy remnants explicitly.

For each reachable surface inspect readability and scroll ownership, all interaction states in both themes, known-data filter results/counts/actions/export scope, stale responses/failed reads/writes/dirty drafts/Undo, complete task navigation, keyboard/focus and localization. Inspect 1440x900 and 1366x768; representative 1920x1080; zoom 125/150/200% on dense and core workflows. Use measured contrast, not screenshots alone.

## Implementation contract

Reproduce behavior before fixing; evidence can be focused behavioral tests, with browser-dependent claims reserved for actual browser evidence. Add regression tests for behavior; no implementation-mirroring tests for trivial cosmetic edits. Each domain report records source, impact, reproduction, fix, tests, opportunities, and limitations. Every recommendation resolves exact behavior rather than leaving choices to a later implementer.

Maintain finish anchoring, immutable due/source dates, protected running/firmed/frozen/distributed orders, authoritative routing, explicit schedule Save, stale-preview validation, plant-scoped requests/permissions, shared Store selection identities, setup provenance, bounded matrix reads, and existing per-domain persistence contracts. Preserve existing features rather than proposing duplicates. Compile .mts to ignored .mjs before running tests or serving.

## Verification and deliverables

Run focused tests per package then npm run build, typecheck, lint, npm test, check:static-assets, check:legacy-surface. Backend changes require relevant pytest and Ruff using verified local PG_HOST and NIMBUS_TEST_DB=1; required tests cannot count as passed when skipped. Regenerate API types for changed contracts. No live Azure tests, uploads, or SAP sends.

Deliver coverage matrix, findings ledger, domain reports, opportunity register, implementation details, evidence, and test results in this directory. Separate source-confirmed behavior from runtime/visual evidence. Audit completion requires all reachable surfaces dispositioned; improvement completion requires selected changes accepted and no unresolved major regression.
