# Distribution — SAP aggregate work center ↔ NIMBUS per-machine sub-order split UI

## What lives here

- **`distribution-pane.mts`** — `DistributionPane`, the Scheduling Board's Order Distribution sub-tab (§6). Structural shape mirrors `frontend/setup/setup-admin.mts`/`frontend/labor/labor-planning.mts`: a plain object literal with `init()` (wires the static shell + Store subscriptions once, called from `application-shell.mts`'s `gotoGanttSub`) and `render()` (fetch + redraw, called every time the Gantt sub switches to `'distribution'`). Also exports a set of pure, DOM-free functions used by both the pane and its tests: `pickPrimaryBadge` (§6's severity-ordered badge choice), `formatBadgeCount` (nav-badge cap/hide-at-zero), `toPersistedFilters`/`fromPersistedFilters` (the `batch`-excluded persistence round-trip), `selectEmptyState`/`filtersAreActive`, `formatSubOrders`, `describeDefaultBasis`, `reviewedCheckboxState`.

**Shipped (P2-15):** the pane shell + shell/nav registration (`_GANTT_SUBS` entry, the third `nav-sub-btn`, the `#context-sched-actions` CSS hide rule, the nav-badge reading `Store.distributionSummary.needs_review`), the paged list (`GET /distribution/{plant}`) with search/work-center/bucket/date-horizon/batch filters (machines is a read of the shared `Store.selectedLines`, not a second picker — §6's own wording), the §6 status-badge severity table (one primary `.sap-pill` per row + a `+{{n}}` tooltip for the rest), and the detail panel's **static header** display (SAP order/material/work center/quantity/window/Σ hours/the "why these defaults" sentence/updated-by/reviewed-by). The list's Reviewed checkbox and its two simplest badge actions (`needs_review` → mark reviewed, `qty_changed` indeterminate → re-stamp `reviewed_quantity`) call `POST /distribution/{plant}/review` directly — both are simple, single-call actions, not the editor.

**Deferred to P2-16 (see `distribution-pane.mts`'s own header comment for the exact list):** the shares editor body itself (`#dist-shares-editor-placeholder` is a literal stub div today), dry-run preview, Save/Reset/Undo, the reconcile banner (`Engine.reconcileRuntimeSchedules` follow-up), the What-If (`Sandbox.active`) write guard, and every OTHER status's one-click badge action (`incomplete`→Repair, `mode_mismatch`→Reset, `wc_changed`→Adjust/Reset/Review, `membership_changed`→Adjust/Reset, `below_min_lot`/`zero_quantity_children`→Adjust, `separation_violated`→Show on Gantt, `runtime_mismatch`→Save schedule) — those badges render but their click handler is a documented no-op. Deep-link routing (`#gantt/distribution?parent=&material=`, `?bucket=`, `?batch=`) is also not wired — `_batch` state exists and is already filter-plumbed so a later task can drive it from a parsed hash without touching the fetch/render path.

**The Work Centers admin tab (§4.3, P1) is NOT in this folder** — despite this file's own earlier draft saying otherwise, that work actually landed as `WorkCenters` inside `frontend/master-data/admin-ui.mts` (`PUT /distribution/{plant}/workcenters/{wc}`'s frontend counterpart). This folder is the Scheduling Board Distribution tab only.

## A real backend-shape correction worth knowing before touching this file

`aggregate_to_detail.md` §6's prose says the machine→work-center map comes from "`Store.masterData.workcenters`" and that `NimbusMasterLine` gains `sap_workcenter`/`distribution_weight` — **that's not what shipped.** Only `NimbusLineSetting` (`Store.lineSettings[machine]`) gained `sapWorkcenter`/`distributionWeight`, and there is no `Store.masterData.workcenters` cache anywhere in the app. `distribution-pane.mts` follows the real, already-established pattern instead: its own module-local `_workcenters` cache, fetched straight from `GET /master-data/sap_workcenter?plant=` and re-fetched on plant switch — the exact same shape `WorkCenters._rows` in `master-data/admin-ui.mts` already uses. Don't "fix" this file to read a `Store.masterData.workcenters` field that doesn't exist.

## Integration points

**Imports in:** `../platform/foundation.mjs` (`Config`, `Util`, `ErrorLog`, `Toast`), `../platform/store.mjs` (`Store`), `../security/session.mjs` (`Session` — `isAdmin()` gates the empty state's "Open Work Centers" button, `setPref()` persists filter state), `../insights/services.mjs` (`loadDistributionSummary`, called after a review write so the nav badge/Dashboard/Ctrl+K counts refresh immediately). Reaches shell navigation (`App.goto`/`App.gotoMasterSub`) and `EmptyState.render` through the ambient `NIMBUS` global (`frontend/types/nimbus-global.d.mts`), the same idiom `frontend/master-data/material-grids.mts` uses — NOT a real import, since this is a leaf pane and shell already imports it downward (see next line).

**Imported by:** `frontend/shell/application-shell.mts` imports `DistributionPane` directly (the same way it already imports `Table`/`Timeline`/`WorkCenters`) and calls `.init()`/`.render()`/`.setActive()` from `App.gotoGanttSub`'s `'distribution'` branch.

**Endpoints called:** `GET /distribution/{plant}` (list, paged 50), `GET /distribution/{plant}/{order}/{material}` (detail), `POST /distribution/{plant}/review` (the two wired one-click actions), `GET /master-data/sap_workcenter?plant=` (work-center combobox source + the "has a distribute-mode work center" empty-state check).

## Tests

- `tests/modules/distribution/distribution-pane.test.mjs` — the pure functions listed above: badge severity ordering, the filter-state persistence round-trip (`batch` excluded), empty-state selection priority, and the nav-badge cap/hide-at-zero behavior. No live-network tests — `Util.fetchTraced` call sites aren't exercised here (see the file's own header for what's intentionally out of scope).

Run: `npm run build && node --test tests/modules/distribution/distribution-pane.test.mjs`

## Counterpart

Backend half carries the load-bearing data, routes, and ingest logic: `backend/distribution/CLAUDE.md`.
