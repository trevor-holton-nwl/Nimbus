# web/scheduling — Gantt, Orders grid, selection, and backend persistence

## What lives here

- **`gantt.mts`** (3,966 lines) — the Gantt timeline surface and its supporting UI:
  - `Timeline` — the vis-timeline wrapper (render, item lifecycle, drag/resize hooks).
  - `TimelineNav` — the minimap/navigator strip above the Gantt.
  - `DependencyOverlay` — finish-to-start link line rendering.
  - `Hierarchy` — plant → machine navigation tree.
  - `GanttFilter` — the Gantt's own line/search filter UI.
  - `Interaction` — the unified click/keyboard/drag pipeline (marquee multi-select, hover-preview card, double-click line isolation, multi-order ghost-drag, two-way AG Grid ↔ `Selection` sync).
  - `setupDiagnosticLabel` / `setupSourceLabel` — small label helpers for setup-aware diagnostics badges drawn on the timeline; `SetupPresentationDetail` is their shared type.
- **`orders.mts`** (2,352 lines) — the AG Grid orders table and order-detail chrome:
  - `Table` — the AG Grid wrapper (column defs, cell editors, row model).
  - `Inspector` — the single/multi-selection detail panel.
  - `ContextMenu` — right-click actions on grid rows/Gantt bars.
  - `Printer` — print/export.
  - `notifyResidualFirming` — standalone helper (fires a toast/alert when firming an order leaves a residual gap); `AgGridRowNode` is the row-node type used by both this file and `gantt.mts`.
- **`selection.mts`** (138 lines) — `Selection`, the multi-select store (which task ids are selected, anchor tracking for Shift-range-select, listener fanout). Independent of vis-timeline internals; every UI (Timeline, Table, Inspector, ContextMenu) subscribes to it. Never persisted, never autosaved.
- **`persistence.mts`** (1,496 lines) — `Persistence`: backend fetch (`load`/`loadForPlant`/`reload`), the localStorage cache (`_saveCache`, key `nimbus.state.v3`), dirty-id tracking, and the explicit `saveAll()` backend-save path.
- **`order-field-catalog.mjs`** (110 lines, + `order-field-catalog.d.mts` ambient types) — `ORDER_FIELD_CATALOG`, the single source of truth for which optional Orders fields exist and their default show/hide state in the AG Grid columns and Inspector panel. Deliberately a zero-dependency leaf module (no imports) so both this domain and the admin System Configuration UI can depend on it without adding a cross-domain edge.

## Counterpart

Backend half: `server/scheduling/CLAUDE.md` (`server/scheduling/routes.py`, `server/scheduling/models.py`) — the `/tasks` family and the xmin concurrency contract this domain's `saveAll()`/`_refreshTasks()` talk to.

This domain's frontend files do not call `db.py`/`master_data.py` directly — they only ever go through the `/tasks*` HTTP endpoints owned by `server/scheduling/routes.py`. No root-file line ranges to cite here.

## Key invariants & hazards

- **Timezone-naive save contract (fixed, not open):** `saveAll()` (persistence.mts:1091) converts every date to local seconds via `Util.toLocalSeconds` before `JSON.stringify` — a raw `Date` would serialize as UTC (`toISOString()`), but the backend read path emits bare naive `strftime` strings that `new Date()` parses as local, so a raw `Date` here would round-trip shifted by the client's UTC offset for non-UTC users. This was a real corruption bug, fixed 2026-07-07; it is not still open.
- **`saveAll()` always POSTs full `blocks`/`calendars`** (persistence.mts:1129 — `JSON.stringify({ tasks: taskPayload, blocks: Store.blocks, calendars: Store.calendars })`) even when the dirty-task list is empty. The backend (`TasksUpdatePayload`) only consumes `tasks` — `blocks`/`calendars` are accepted but ignored (calendars/blackouts persist through the separate `/plant-calendar/*` endpoints). This is legacy ride-along, harmless but worth knowing before assuming an empty save is a no-op network call.
- **Partial-save dirty-id clearing is narrower than the root `CLAUDE.md`/older docs describe.** The current code (persistence.mts's `saveAll` success handler, "R7") does **not** unconditionally clear all dirty ids on a partial save. It clears only ids the backend actually "accounted for": persisted (present in `result.versions`), concurrency-stale (`result.stale`), or terminally rejected (`result.invalid_ids`/`result.not_found_ids`). Any sent id that is none of those (e.g. lost between `SELECT FOR UPDATE` and the `UPDATE`) **stays dirty** and is retried on the next save. A code comment explicitly notes this replaced an earlier version where "both sets were `.clear()`'d unconditionally" — so if you're reading an older doc that says un-persisted rows are never auto-retried, that has since been fixed.
- **Auto-reflow after manual edits:** `Engine.autoReflow()` (owned by the optimization domain, called from this domain's `Interaction`/drag handlers) re-flows subsequent unfixed orders on one line to eliminate drag-created overlap. It only shifts dates within one line, triggering an incremental line-scoped alert recompute. Anything in the `Interaction` → `Engine` path must be aware this can fire.
- **Task IDs are MD5 hashes** of `f"{PRODUCTION_ORDER}|{MATERIAL_NUMBER}"` (`make_id()` in root `db.py`, currently line 103). The hash excludes time, so ids are stable across reloads/reschedules — `Selection`, `Table`'s row keying, and drag/edit operations across this whole domain rely on that stability.
- **`gantt.mts` ↔ `orders.mts` form a two-way in-domain module dependency**: `gantt.mts` imports `Table`/`Inspector`/`ContextMenu`/`notifyResidualFirming` from `orders.mjs`, and `orders.mts` imports `Timeline`/`TimelineNav`/`setupDiagnosticLabel`/`setupSourceLabel` back from `gantt.mjs`. This is intentional (both are the same domain) — don't "fix" it by trying to break the cycle across a domain boundary.
- **This `CLAUDE.md` (and every other `web/<domain>/CLAUDE.md`) is blocked from public static serving** by `brain.py`'s `block_markdown_mw` (any request path ending `.md` gets a 404), regardless of the `StaticFiles` mount at `/`. Not a scheduling-specific concern, but worth knowing if you're verifying this file isn't web-reachable.

## Integration points

**Imports in** (selected):
- `../platform/foundation.mjs` (`Config`, `Util`, `ErrorLog`, `Toast`, `Modal`, `PerfMonitor`, `VirtualList`), `../platform/store.mjs` (`Store`, `UndoStack`) — foundation/state layer.
- `../insights/services.mjs` (`Utilization`, `Alerts`) — alert/utilization compute.
- `../optimization/engine.mjs` (`Engine`, `deriveSetupObservation`) — optimizer entry point and setup-observation derivation.
- `../setup/setup-domain.mjs` (`resolveSetup`, `stateForOrder`) and `../setup/setup-admin.mjs` (`SetupAdmin`) — `orders.mts` reads/resolves setup state for display and links into the Setup Matrix admin console.
- `../optimization/sandbox.mjs` (`Sandbox`) and `../calendar/calendar-sync.mjs` (`CalendarSync`) — `persistence.mts` suppresses autosave while `Sandbox.active` and delegates calendar persistence to `CalendarSync`.
- `../security/session.mjs` (`Session`) — `orders.mts` reads session/role state for permission-gated UI.

**Imported by** (external callers, grep-verified): `web/app-entry.mjs` (boot-time bridge onto `window.__NIMBUS_*`), `web/admin-ops/admin-ui.mts`, `web/calendar/calendar-sync.mts`, `web/insights/insights-ui.mts`, `web/master-data/admin-ui.mts`, `web/optimization/optimize-ui.mts`, `web/setup/setup-admin.mts`, `web/shell/application-shell.mts`, `web/platform/store.mts` (imports `Selection` — forms the two-way `Store` ↔ `Selection` ESM cycle documented in `store.mts`'s own header).

**Endpoints called:** `GET /tasks`, `POST /task/update`, `POST /tasks/update` (the `saveAll()` path), `POST /tasks/refresh` (concurrency reconciliation via `_refreshTasks`), `POST /tasks/baseline-correct` (due-date-baseline corrections from `_snapToWorkingHours`), `GET|POST /plant-calendar/*` (via `CalendarSync`, not directly).

**Store events:** emits/reads `tasks:bulkUpdate` (e.g. `source: 'refresh'` after concurrency reconciliation, deliberately ignored by dirty/autosave subscribers to avoid re-dirtying rows just pulled from the server).

## Tests

- `tests/modules/scheduling/gantt.test.mjs`
- `tests/modules/scheduling/orders.test.mjs`
- `tests/modules/scheduling/selection.test.mjs`
- `tests/modules/scheduling/persistence.test.mjs`
- Also exercised indirectly by `tests/modules/insights/insights-ui.test.mjs`, `tests/modules/optimization/optimize-ui.test.mjs`, `tests/modules/platform/store.test.mjs`, and `tests/modules/helpers/load-legacy-app.mjs` (shared fixture harness).

Run: `npm run build && node --test tests/modules/scheduling/gantt.test.mjs tests/modules/scheduling/orders.test.mjs tests/modules/scheduling/selection.test.mjs tests/modules/scheduling/persistence.test.mjs` (build first — these are compiled `.mjs` outputs, gitignored, not committed).

## Gotchas

- `Calendar.workWindow`/`dailyCapacityHours`/`effectiveCapacityHours` are **not** in this domain — they remain in `app.js`/the platform layer, parity-pinned against `nimbus-compute-core.js` by `tests/js/compute-core.test.js`. A change to that capacity math must be mirrored there even though `gantt.mts`/`orders.mts` call it.
- `web/optimization/setup-scheduler.mts` is **not** part of this domain (it lives under `web/optimization/`) even though it consumes `../setup/setup-domain.mjs` — don't confuse it with anything here.
- The `_relayDueDateCorrections`/`saveAll` comments both explicitly warn against ever passing a raw `Date` object into the wire payload — grep `Util.toLocalSeconds` before adding any new date-carrying field to either payload builder.
