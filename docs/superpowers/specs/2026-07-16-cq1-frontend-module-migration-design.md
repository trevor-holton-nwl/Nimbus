# CQ-1 Frontend Module Migration Design

**Status:** Approved for implementation on 2026-07-16.

**Status: CQ-1 complete as of Phase 4 Task 7 (commit closing "docs: close out
CQ-1 — all four phases of the frontend module migration complete").** All
four phases landed; the seven modules below are real, `app.js` is the
documented small launcher this doc's own completion bar describes, and
`nimbus-intelligence.js` no longer monkey-patches `UndoStack.push`/
`Alerts.recompute`. One known, deliberate gap remains, quantified rather than
silently closed: **91 static inline event-handler attributes** still exist in
`index.html` (down from 123 at the start of Phase 4) — full elimination was
explicitly out of this migration's scope (converting all of them in one pass
was judged the single riskiest, least-tested change available), and it
remains the blocker to promoting the new Report-Only CSP to an enforcing one.
Two further caveats, so this note doesn't read as more complete than the
repository actually is: global task-ID uniqueness is **not** enforced (task
lookups are still keyed by the bare, plant-blind MD5 id — see this doc's own
`schedule-state.mjs` section and `MIGRATION.md → task-id`), and a distinct
`hydrate` transactional mode was **never implemented** (`Store.mode()` has
exactly two values, `'live'`/`'draft'`, not three). See
`docs/architecture/cq1-compatibility-inventory.md` §8 for the full,
criterion-by-criterion report against this document's own "Verification and
completion" paragraph below, including that the Docker/browser boot smoke
test this section calls for has never actually been run in any of CQ-1's
four phases (no Docker/browser environment was available in any execution
session) — this is the largest outstanding verification gap and should be
the first thing exercised, by whoever has a Docker environment, before this
branch ships.

**Source decision:** This committed design carries the approved architecture from the workspace-level `Module_migration.md` into the isolated CQ-1 branch. The migration is a behavior-preserving architecture change; it is not a framework rewrite, bundler adoption, or scheduling-algorithm redesign.

## Goal

Replace the monolithic browser application in `app.js` with seven coarse native ES modules whose ownership and dependency direction are explicit, while preserving scheduling behavior, explicit Save semantics, worker/core contracts, authentication gates, and the static single-container deployment model.

## Module map

```text
application-foundation.mjs
        ↓
schedule-state.mjs
        ↓
schedule-services.mjs ───→ schedule-data.mjs
        ↓                         ↓
schedule-workbench.mjs    plant-and-administration.mjs
        \                         /
         └── application-shell.mjs
```

Imports flow downward only. A cycle is resolved through a post-commit event or a small public method. No consumer imports underscored fields.

### `application-foundation.mjs`

Owns immutable configuration, date/local-time helpers, formatting, i18n, traced requests, Flatpickr helpers, performance monitoring, virtual lists, errors, toasts, generic modals, and verification of required CDN globals. It owns no schedule state, feature endpoint, scheduling rule, view instance, or boot behavior.

### `schedule-state.mjs`

Owns schedule state, derived indexes, selection, undo, sandbox snapshots, and synchronous post-commit events. Every logical change is a transaction with `source`, applicable plant scope, and mode `live`, `draft`, or `hydrate`. Public task references are `{ plant, id }`; the boundary never assumes the current database ID is globally unique.

### `schedule-services.mjs`

Owns calendar orchestration, the Compute worker client, alerts, utilization, optimizer dispatch, auto-reflow, and non-DOM optimizer preview coordination. It delegates algorithmic truth to `nimbus-compute-core.js` and preserves the existing worker protocol.

### `schedule-data.mjs`

Owns schedule and calendar repositories, local cache, Session, hydration, explicit Save, task refresh, and optimistic-concurrency reconciliation. Draft transactions never write remotely. Promoting a draft creates one dirty live transaction and still requires the existing explicit Save action.

### `schedule-workbench.mjs`

Owns the planner workspace: timeline, order grid, inspector, hierarchy, dashboard, navigation, filters, dependency overlay, context menu, interaction pipeline, and planner dialogs. Third-party instances remain private and lifecycle cleanup is explicit.

### `plant-and-administration.mjs`

Owns Plant, production lines, labor planning, Master Data, Bill of Materials browsing/filtering/upload, SAP Interface, Security, Admin Cockpit, color-wheel administration, and plant/line calendar management. It owns no planner timeline or application-wide navigation.

### `application-shell.mjs`

Owns ordered boot, login gating, top-level routing, screen lifecycle, plant selector, empty/welcome states, printing, intelligence initialization, and the temporary versioned compatibility adapter. It composes the six lower modules without duplicating their state, calculations, or endpoint calls.

## Stable contracts

1. Only the state module mutates schedule state or publishes schedule events.
2. Only the services module applies calendar, alert, utilization, and optimizer rules.
3. Only the data module reads/writes task, calendar, cache, and session data.
4. Views convert gestures to public state/service/repository calls.
5. Events are immutable post-commit facts containing `type`, `source`, `revision`, plant scope when applicable, and affected IDs.
6. Listener failure is isolated and logged. `subscribe()` returns an unsubscribe function.
7. Event consumers do not synchronously mutate the same state in response to the same event.
8. Hydration cannot overwrite an active draft. Failed transaction validation leaves prior state intact and emits no event.

The initial event vocabulary is:

```js
export const scheduleEvents = Object.freeze({
  PLANT_SELECTED: 'plant:selected',
  TASKS_CHANGED: 'tasks:changed',
  CALENDAR_CHANGED: 'calendar:changed',
  ALERTS_CHANGED: 'alerts:changed',
  UNDO_ENTRY_ADDED: 'undo:entry-added',
  SESSION_CHANGED: 'session:changed',
});
```

## Lifecycle and async safety

Imports define exports only; they perform no application behavior. The shell creates modules once and owns cleanup. Each request, worker job, debounce, timer, and subscription belongs to a scope containing selected plant, state revision, `AbortController`, and cleanup callbacks. Plant changes always create a fresh scope. Late fetch/worker results update state only when both plant and revision still match.

Each major screen uses one lifecycle consistently: mount once and show/hide, or mount/unmount with returned cleanup. A screen may not mix both. No migration step may boot old and new implementations together, create duplicate workers, or double-subscribe to state.

## Compatibility and intelligence

Before globals move, the shell exposes a versioned, shrinking adapter containing documented commands and read-only selectors needed by existing `index.html` and `nimbus-intelligence.js` consumers. It does not expose raw modules or private state. Consumer inventory is committed and entries are removed only after each caller migrates.

Intelligence moves from runtime method replacement to events and public commands/selectors. In particular, Time Machine stops wrapping `UndoStack.push`, and Confidence stops replacing `Alerts.recompute`.

## Bootstrap and static delivery

A single classic loader performs the version guard, loads locale dictionaries and the UMD compute core, then dynamically imports the active entry. The entry initializes intelligence only after required public APIs exist. Boot is exactly once and asset failure produces a visible actionable error.

Frontend assets live in a dedicated directory copied to `/app/web` by convention. Container checks verify the entry and full static-import closure exist, return HTTP 200, and `.mjs` responses use a JavaScript MIME type. Until a generated versioned manifest exists, module responses use `Cache-Control: no-cache`; the existing build-ID contract remains for classic assets.

## Security constraints

- No new inline script, event-handler, or style attributes may be added. CI maintains a shrinking allowlist for existing inline handlers in HTML and JavaScript-rendered markup.
- CQ-1 establishes a report-only CSP and explicit CDN allowlist; enforcement waits until incompatible inline presentation is removed.
- Existing server-side authentication and authorization gates remain authoritative. The temporary frontend adapter is not a security boundary.
- User-controlled values continue to be rendered through safe DOM APIs or context-appropriate encoding; module extraction must not introduce new HTML injection sinks.
- Database-backed tests require explicit local/CI opt-in. Test collection rejects Azure, remote, and known pilot database hosts before opening a pool or executing SQL.
- Upload, admin, security, and SAP endpoints retain existing API-key/admin dependencies and server-side validation.

## Migration sequence

### Phase 0 — Prepare the seam

Add the remote-database test guard and dependency overrides for truly DB-free endpoint tests; inventory facade consumers; add characterization coverage for plant scoping, worker snapshots, save/refresh, and main planner actions; configure `.mjs` lint/tests; establish frontend asset directory, cache policy, static-closure smoke test, lifecycle decision, event contract, task-reference convention, and inline-handler allowlist.

### Phase 1 — Foundation and state

Introduce the ordered loader and temporary ESM entry, then extract foundation and state behind public APIs. Establish transactional modes and scoped cleanup before moving Sandbox, repositories, or subscribers. Replace private Store reads only in callers migrated in this phase and track remaining exceptions.

### Phase 2 — Services and data

Extract scheduling services without changing compute algorithms or worker messages. Extract repositories and Session. Add stale plant/revision response tests, draft/save tests, plant-scoped task-reference tests, worker contract tests, and optimistic-concurrency characterization.

### Phase 3 — Workbench and administration

Move the planner and operational domains. Migrate inline handlers to owned listeners as screens move. Verify lifecycle teardown leaves no listeners, timers, worker jobs, requests, or third-party instances for the prior screen/plant.

### Phase 4 — Shell and intelligence bridge

Finish application composition and routing, convert intelligence monkey patches to events, delete compatibility entries with their final callers, remove the legacy boot path and remaining inline presentation blockers, and verify CSP-ready static delivery.

## Verification and completion

The release gate includes legacy CommonJS compute/timezone tests, ESM module tests, module-aware ESLint, Python tests that cannot contact a remote database without explicit opt-in, static import-closure/MIME/cache tests, and browser smoke coverage for single boot, missing-module boot error, login, plant selection, timeline, explicit Save, administration/BOM, and lifecycle teardown.

CQ-1 is complete only when `app.js` is gone or a documented small launcher; the seven files are clear owners; no task API assumes global ID uniqueness; live/draft/hydrate semantics are isolated; late async results cannot overwrite a newer plant/revision; worker/core parity remains green; intelligence no longer monkey-patches behavior; inline compatibility is removed; and the container reliably ships a coherent module graph.
