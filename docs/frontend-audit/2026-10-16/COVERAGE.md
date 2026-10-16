# Frontend coverage and browser acceptance

## Evidence boundaries

Source inspection and automated behavior/API checks do not establish browser layout, actual focus traversal, zoom behavior, screen-reader operation, or perceived responsiveness. The supported Browser integration reported an empty browser list after setup and documented troubleshooting. User consent did not expose a browser. Those checks remain blocked and must not be reported as passed.

The local audit app booted at http://127.0.0.1:8010 with external SAP schedulers disabled. Login, static delivery, plant/machine catalogs, tasks, Labor and calendars returned HTTP 200. `api-smoke.json` records the 1,000-order profile. `scale-api.json` records the 10,000-order profile: expected plant-specific counts and every returned row's PLANT were checked. Timings are local HTTP measurements, not browser performance results.

The temporary server was stopped after verification; the isolated local databases remain for a later browser session. Start the app against the browser fixture database again before executing the pending recipes.

## Surface matrix

| Surface | Source/behavior owner and record | Browser acceptance |
|---|---|---|
| Login, boot errors, command band, navigation, settings, plant/machine pickers | shared.md | Blocked: light/dark, no-access/empty, focus, 50-plant search, zoom |
| Dashboard KPIs, utilization/lateness, drills, alerts, confidence | shared.md | Blocked: ramp labels, long row names, alert scroll/empty/horizon, scope feedback |
| Timeline filters/minimap/bars/drag/selection/context menu | planning.md | Blocked: edge menus, scroll axes, keyboard gestures, long labels and overlays |
| Orders/Inspector/override/print/export | planning.md | Blocked: AG Grid popup layers, filters/counts, inline edits, copy/paste, print scope |
| Optimize/background/preview/What-If | planning.md | Blocked: nested pickers, background completion, concurrent edits, Apply/Discard |
| Distribution list/detail/shares/dry-run/Save/Undo | planning.md | Blocked: expanded detail and narrow split, 70 shares, table scroll and draft focus |
| Calendars/blackouts/routing feedback | planning.md | Blocked: Flatpickr placement, local-vs-durable save feedback, failed write retry |
| Plant/line settings/material/material-plant/routing/work centers | admin.md | Blocked: inherited settings, retained drafts navigation, dense grids/detail editors |
| Generic tables/BOM/cascade/schema dialogs | admin.md | Blocked: column menus, overflow, long FK labels, destructive preview readability |
| Setup List/Matrix/coverage/definitions/physical state/compatibility | admin.md | Blocked: bounded matrix rendering, picker/scroll layering, staged edit feedback |
| Priority cards/mapping/Color Wheel and priority viewers | admin.md | Blocked: long workbook headers, previews, reopen/close interactions |
| Labor Aggregate/Line Plan/Capacity/Exceptions/Inputs | labor.md | Blocked: 70-line 112-day grids, horizontal scroll, pinned-cell contrast, exception focus |
| Security users/roles/plants/page access/profile | admin.md and shared.md | Blocked: two searchable plant lists, role permission feedback, keyboard focus |
| SAP overview/mappings/history/staging/outbound/archive/rejected rows | admin.md | Blocked: page/search controls, long validation output, active plant identity |
| Admin diagnostics/logs/audit/maintenance/config/table browser | admin.md | Blocked: scroll, filtered logs, destructive actions, configuration save state |
| Command palette/snapshots/diff/restore/theme/language | shared.md | Blocked: native controls, focus restoration, snapshot protection feedback |
| Shared toast/confirmation/modal/menu/tooltip/dialog layers | shared.md | Blocked: full theme/state/viewport matrix and actual assistive technology |

All listed areas have an owner. Domain reports distinguish implemented changes, inspected unchanged behavior, deferred opportunities and unverified behavior. Unreachable legacy CalendarUI markup is not counted as a shipped defect without a reachable caller.

## Browser test recipes still required

Use 1440x900 and 1366x768 in both themes. Add representative 1920x1080 and 125/150/200% zoom for dense/primary workflows. Record browser version and effective viewport. Run real keyboard Tab/Shift+Tab/Enter/Space/Escape and documented arrow/menu shortcuts; do not infer keyboard behavior from DOM attributes.

1. Open working-hours/More info/context/column menus at every viewport edge, before and after scrolling. Verify default, hover, focus, disabled and selected foregrounds/backgrounds. Record computed contrast and screenshots.
2. Reach final row, rightmost column and primary action in every table/dialog at short height and high zoom. Verify the intended scroll owner, sticky cells and focus are visible; no mouse-only escape.
3. Combine quick/native/multiselect/pasted-ID filters using known rows; clear them; switch tab and plant; verify counts, totals, exports and bulk-action scope. Preserve intentional Timeline dimming versus Orders row removal.
4. Open a shared machine selector, change selection elsewhere, and verify open checks/ARIA/label remain synchronized. Test no selection, all selection, unknown pasted IDs and empty results.
5. Switch A-B-A while requests succeed/fail out of order. Verify SAP, priority viewers, Material Plant and Labor show current scope and retain authorized drafts. Fail a write, retry, navigate and reload.
6. Edit a pinned Labor day, change/paste aggregate weeks, Undo and reload. Check all selected groups and week 16, positive demand with zero capacity, and exception-to-cell navigation.
7. Enter What-If, change hours/blackouts, discard before the debounce fires, then reload live truth. Confirm no discarded write or lost live deletion.
8. Expand/collapse Distribution details with unsaved shares; scroll 70 rows; verify totals/actions and focus remain usable. Exercise dry-run rejection, Save/Undo and stale response.
9. Capture/compare/restore a snapshot, switch plant before accepting, and include protected/distributed rows. Verify scope, protection feedback, undo and explicit Save.
10. Use all five locales at least once; use long German/French labels on dense surfaces. Inspect untranslated literals, truncation and full-value access.
11. Run at least one complete planner journey: exception -> cause -> relevant order/configuration -> permitted change -> review -> save/discard -> return to original scope.

Every result needs fixture/version, role, plant, dimensions/zoom/theme, steps, expected/actual, screenshot or measured state, and finding ID. Missing Browser access remains a blocker to visual acceptance, not a failed application test.

## Reproducing the safe local fixtures

Create a fresh local database named `nimbus_frontend_audit_browser`, apply schema.sql, and configure an ignored worktree .env with loopback PG_HOST, that PG_DB, local credentials and NIMBUS_TEST_DB=1. `scripts/seed_frontend_audit.py` refuses non-local/non-audit targets and unexpected existing plants. It adds synthetic records without deleting data; schema.sql's two seed plants remain.

Run `python scripts/seed_frontend_audit.py` for 1,000 orders or `--orders 10000` for stress. The added catalog has 50 plants, 70 machines in each of two plants and one in each of the other 48, 100 materials, and 16 weeks of Labor data with a distinctive pinned override. Basic schema fixtures do not cover every specialized setup/distribution/SAP state; the focused tests provide those additional cases, and equivalent browser fixtures must be prepared before those manual scenarios.

Run tests against a separate dedicated audit test database. The browser data must not be reused by destructive database tests. The original live .env must never be copied into the audit worktree. Use the approved hidden-process launch convention and stop the temporary server after verification.
