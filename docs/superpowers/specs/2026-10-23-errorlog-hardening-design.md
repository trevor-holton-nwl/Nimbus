# ErrorLog hardening + planner Toast Log tab — design

## Intent and why

When a finicky Gantt bug happens today, the owner pings Claude and the two of them probe the Chrome console until the cause appears. The frontend `ErrorLog` (`frontend/platform/foundation.mts:1440-1726`) is already structured (ring of 500, breadcrumbs, IndexedDB durability, batched shipping of error-level entries to `POST /logs/frontend`, request-id correlation with the backend ring), but several classes of failure never reach it, and entries lack the context those sessions reconstruct by hand:

- Toasts never log (179 error-toast call sites; `Toast.show` is in the same file, right after `ErrorLog`).
- `console.error`/`console.warn` from vis-timeline, AG Grid and the worker client are not captured.
- `Store.emit` (`frontend/platform/store.mts:397-401`) already try/catches each listener but reports only to `console.error`.
- The Compute worker forwards job errors, but has no `self.onerror`/`unhandledrejection`, and the client lacks `onmessageerror` (`frontend/insights/services.mts:237-279`).
- No `user` on entries; no state snapshot; copy is clipboard text only.
- Planners have no window onto their own toasts (the Logs tab is admin-only).

The primary deliverable is a JSON export the owner can hand to Claude, so a bug report arrives with its own evidence instead of a console-probing session.

## Goals, non-goals, anti-goals

**Goals**
- Every toast, captured console error/warn, Store listener failure and worker-global error lands in the one `ErrorLog` ring.
- Error-level entries carry who (`user`), where the app was (state snapshot from registered providers), and a stable `errorCode` for the known cases.
- A planner can see their own toasts, with the time each fired, and download them as JSON.
- Admins can filter the Logs tab by user and export JSON.

**Non-goals (owner, settled, do not re-ask)**
- Freeze detection, in-flight request tracking, dedupe, and a DB table for logs.
- Call-site retrofits of the 179 error-toast sites (the `Toast.show` change covers them).

**Anti-goals**
- Do not turn the alerts drawer into a notification centre: the Alerts tab and the bell badge stay exactly as they are; the badge counts alerts only.
- Do not add colors; reuse `styles.css` custom properties.
- Do not add inline `on*=` handlers or `NIMBUS.X.y` references to `index.html`.

## Constraints

1. Work happens on `feature/errorlog-hardening`, never directly on `main`; run `npm run build` after any `.mts`/`.ts` edit.
2. New UI strings go through `data-i18n` / `Util.t` in all five locales (`frontend/locales/{en,de,es,fr,pt}.js`).
3. `store.mts:20` already imports `ErrorLog` from `./foundation.mjs` and `foundation.mts` has no runtime imports, so no new import cycle may be introduced.
4. `scripts/legacy-surface.mjs` must not grow (see appendix); all new wiring uses `addEventListener` from a module.
5. Business terms only in docs; no SAP field codes.
6. The plant-scale rule from the root `CLAUDE.md` is unaffected: nothing here renders per-plant or per-machine lists.

## Owner decisions (settled)

- Toast history is cached per login in the browser (IndexedDB key per user). Error toasts still ship to the shared admin ring; warn/info stay local. The admin Logs tab gets a user filter.
- Planner access: the existing alerts drawer (`#alert-drawer`, `index.html:2253-2263`) splits into two tabs, **Alerts** (unchanged, still drives the bell badge) and **Toast Log** (every toast, newest first, with the time it fired, scrollable, with a Download JSON button).
- The primary deliverable is the JSON export.

## Decided design

- **Toast logging.** `Toast.show(msg, type, ms?, action?, opts?: {err?, reqId?, ctx?})`. Log before the `#toast-stack` early return so headless callers still record. Level map: error → `ErrorLog.error`, warn → `warn`, info/success → `info`; scope `'toast'`; ctx `{type, ms, hasAction, ...opts.ctx}`; LogOpts `{reqId, stack: err?.stack, errorCode: 'toast.'+type}`. Every call logs, including deduped repeats. No call-site retrofits.
- **Console capture.** `installGlobalHandlers()` saves `_console = {error, warn}` bound originals before wrapping; `_push` mirrors through `_console`, never `console[fn]`. A module-level `_capturing` flag makes the wrapper a no-op on re-entry. Message = args joined (Error → message, objects → JSON, capped 2 KB); `opts.stack` from the first Error arg. Scope `'console'`, errorCode `'console.error'|'console.warn'`.
  - *Orchestrator's call:* raise `ErrorLog.MAX` from 500 to 800 so console noise cannot evict a planner's toast history as quickly. Still one ring; the IndexedDB snapshot grows accordingly.
- **Per-login IndexedDB key.** `_ringKey()` returns `` `entries:${_actorResolver() || 'system'}` ``; `_saveNow` and `restore` use it. The legacy key `'entries'` is read once as a fallback when the per-user key is empty. Sign-out reloads the page and sign-in goes through `_bootMain`, so no session-change subscription is needed (comment this in the code).
- **State providers.** `ErrorLog.registerStateProvider(name, fn): () => void` into a `Map`. `_collectState()` runs only for error-level pushes and not while `_capturing`; each provider is try/caught, JSON capped at 2048 chars (replaced by `{_truncated:true, bytes}`), and the loop stops after 20 ms total. Attached as `ctx.state` beside `breadcrumbs`. Server-side ctx caps may truncate `state`; the local export keeps it whole.
- **`user` on entries.** `LogEntry.user?` set in `_push` from `_actorResolver()`; included in the ship payload; the bare ship fetch also sends `x-user-email`. Backend stores `entry["user"] = raw.get("user") or request.headers.get("x-user-email")`.
- **Conflict code.** `errorCode: 'tasks.conflict'` applied client-side at the `stale` branch and in `_refreshTasks` where the server `row_version` is known. `fetchTraced` maps a real 409 to `errorCode: 'http.conflict'` (one line).
- **Store guard.** Replace the `console.error` in `emit()` with `ErrorLog.error('store', ..., {event, source, listener: l._pmLabel || l.name || '?'}, {stack, errorCode:'store.listener'})`. Track `_lastEvent` for the platform state provider.
- **Toast Log placement.** New module `frontend/insights/toast-log-tab.mts` (`ToastLogTab`), not inside `insights-ui.mts`. It owns the tab strip, its body, and an `ErrorLog.subscribe` hook that re-renders (debounced 100 ms) only while the drawer is open and its tab is active. Plain list, newest first (toasts ≤ ring size). `renderBell`/`_visibleAlerts` are untouched, so the badge counts alerts only.
- **Export.** `ErrorLog.exportJsonPayload()` (pure, testable) → `{buildId, sessionId, user, plant, route, exportedAt, dropped, entries}`; `ErrorLog.exportJson()` downloads `nimbus-log-<user>-<ts>.json` (user sanitized to `[A-Za-z0-9._-]`; `document`/`URL.createObjectURL` guarded for Node).

### Preflight rulings folded in (2026-10-23)

These refine individual tasks after a conflict scan of the plan against live code.

1. **One conflict warning, not two.** The `stale` branch already calls `ErrorLog.warn('persistence', 'Concurrency conflict on N order(s) — refetching', stale)` (`persistence.mts:~1347`, no opts). That call is modified, not duplicated: it gains ctx `{ids, base_versions}` and opts `{errorCode:'tasks.conflict', reqId}` (`reqId` is declared at `:1236` in the same function, so it is in scope). The `_refreshTasks` entry is logged at **info** level with `{id, base_version, server_version}` and the same errorCode: it carries the server version the stale branch cannot know, and info level avoids double-counting errors. Cost if wrong: one redundant info line per conflict.
2. **`persistence` provider has no `loadedPlant`.** The field does not exist in `persistence.mts`; the plant is already in the `platform` provider. The provider reports `{dirty, force, conflicted, firmDirty, autosaveDisabled}`. The `scheduling` provider's `selected` ids (first 50, plus `selectedCount`) come from whatever accessor `frontend/scheduling/selection.mts` exposes; the implementer locates it.
3. **The Toast Log and Admin Logs tasks run sequentially in one worktree** (both edit `index.html` and the five locale files). The Toast Log task also adds the `ph.filter_user` locale key, so the Admin Logs task only consumes keys.
4. **Backend tests need env overrides.** The log-endpoint tests are database-free, but pytest collection is guarded: run with `NIMBUS_TEST_DB=1 PG_HOST=localhost PG_DB=nimbus_test`. If a test genuinely opens a connection and fails, report it verbatim and verify by reading.
5. **`ToastLogTab.init()` wiring.** The implementer attaches it to whichever insights init app.js already invokes (around `app.js:600`) and names the place in the report and in `frontend/insights/CLAUDE.md`.

## Work breakdown (for orientation)

- **Foundation core** (the only task editing `foundation.mts`): types (`LogEntry.user?`, `ToastShowOpts`, `StateProvider`), the `ErrorLog` changes above, the `Util.fetchTraced` 409 mapping, the `Toast.show` fifth argument, tests in `tests/modules/foundation.test.mjs`, `frontend/platform/CLAUDE.md`.
- **Store guard + `platform` provider** (`store.mts`): `{plant, selectedLines: size, lastEvent, rev, mode}`.
- **Worker gaps** (`nimbus-worker.ts`, `services.mts`): the worker posts `{type:'ERROR', id:null, failingType:'uncaught'|'unhandledrejection', error, stack, filename, lineno}`; the client handles `data.type === 'ERROR' && data.id == null` before the `_pending` lookup, and adds `onmessageerror`.
- **Scheduling** (`persistence.mts`, `gantt.mts`, `optimize-ui.mts`): conflict code, `persistence`/`scheduling`/`optimization` providers, and a nine-site silent-catch triage (`ErrorLog.warn` with the error stack; pointer-capture, grid/clipboard and date-picker teardown catches excluded; line numbers re-anchored by content).
- **Backend** (`backend/admin_ops/routes.py`): ingest stores `user` (truncated to 128); `GET /logs/backend` gains `?user=` matching `user` or `actor`.
- **Toast Log tab**, then **Admin Logs tab** (user filter inputs and an Export JSON button next to Copy).
- **Integrate**: merge in order, run the full gate, fold into local `main`. No push or deploy unless the owner asks (no migrations involved).

## Left to the builder

- Exact Toast Log tab styling within existing tokens; measure both tab labels against the 380 px drawer width in all five locales before finalizing.
- The selection accessor for the `scheduling` provider and the exact test file for persistence conflict coverage (the conflict-reconciliation tests stub `ErrorLog` at module scope, so a `tasks.conflict` test needs its own spy or a separate file).
- Where `ToastLogTab.init()` is called from (ruling 5).
- Whether any DESIGN.md token is needed for the tab strip (prefer reusing `.seg-btn.active`, `styles.css:644-661`).

## Verification

- `npm run build && npm run typecheck && npm run lint`
- `node --test` on the foundation, store, services and toast-log-tab module tests plus the scheduling persistence tests.
- `npm run check:legacy-surface` (must not grow) and `npm run check:static-assets`.
- Backend: `tests/test_logs_endpoints.py` and `tests/test_log_event.py` with the env overrides from ruling 4.
- Browser checks (owner-owed unless asked): an error toast shows in Toast Log with its time and the bell badge is unchanged; entries persist across reload; a second user sees an empty Toast Log; `console.error('x')` yields one `console` entry with no loop; a throwing `Store.subscribe` callback yields a `store` entry with its label; saving after another tab edited the same order yields a `tasks.conflict` entry; the Admin Logs export contains `user`, `state.scheduling.window` and `state.persistence.dirty`; the backend user filter narrows rows.

## Risks

- The console wrapper can flood the ring from a chatty library; no dedupe by decision. Mitigations: `MAX` 800 and the 2 KB message cap.
- A Store listener that throws on every event now produces one error entry and one ship per event.
- The per-user IndexedDB key orphans the old `'entries'` ring after the one-time fallback read.
- Server ctx caps truncate `state`; the local export is the full record.

## Context appendix — things learned along the way

- A `/tasks` version conflict is **not HTTP 409**: the backend returns 200 with the conflicting ids in a `stale` list (`backend/scheduling/routes.py:456`). The client handles it at `frontend/scheduling/persistence.mts:1346-1352` and in `_refreshTasks` (`:1426`). So `http.conflict` (a real 409) is a different, rarer code from `tasks.conflict`.
- `ErrorLog.restore()` (`app.js:501`) runs inside `_bootMain()`, after login, and `Util.setActorResolver(() => Session.actor())` is wired at `app.js:294`. The actor is therefore known when the ring is restored, so the per-user key needs no lazy re-key; sign-out reloads the page.
- `scripts/legacy-surface.mjs` ratchets on new inline `on*=` attributes and `NIMBUS.X.y` references in `index.html`; the Toast Log tab and export buttons must be wired with `addEventListener` from a module.
- `Store.emit` already try/catches each listener (reporting only to the console), so the guard is a change of reporting target, not new protection.
- The worker already forwards job errors; what is missing is worker-global errors with no job id. `services.mts:239-241` drops any worker message whose `id` is not in `_pending`, so the global-error branch must run before that lookup. `tsconfig.worker.json` includes `frontend/nimbus-worker.ts`.
- The alerts drawer rows have no timestamp, and no toast history existed anywhere, so the Toast Log tab needs its own time column (`Util.fmtDTReadable`, `foundation.mts:349`). The drawer is owned by `AlertsUIAdapter` in `frontend/insights/insights-ui.mts` (`toggleDrawer`, `renderDrawer`, `renderBell`, `_visibleAlerts`); an existing tab pattern is `nav.us-tabs role=tablist` at `index.html:2310-2313`.
- Existing Toast tests use a fake DOM that supplies only `toast-stack`; logging before the stack lookup keeps them valid, but tests that count entries must call `ErrorLog.clear()` in setup.
- Line numbers in this doc are as of `main` 4c37368; re-anchor by content.
