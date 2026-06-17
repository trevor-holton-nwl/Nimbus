# Codebase Concerns

**Analysis Date:** 2026-06-17

## Tech Debt

### Machine-specific hardcoded paths — blocks all deployments
- **Issue:** `COLOR_FILE` and `COLOR_WHEEL_DIR` in `brain.py` (lines 86, 108) are hardcoded absolute Windows paths (`C:\Users\pj29587\OneDrive...`). These MUST be manually edited on every new machine, and will fail at runtime if the paths don't exist or are inaccessible.
- **Files:** `brain.py:86–108`
- **Impact:** Deployment blocker. On-boarding new machines or deploying to Azure requires manual source-code edits (bad practice). The `/reload` endpoint silently fails if paths are missing. The lifespan handler at `brain.py:115` creates the directory but doesn't validate the parent path exists.
- **Fix approach:** Migrate to environment variables with sensible defaults (WS1 of MIGRATION.md provides the exact pattern). Add startup validation: `if not os.path.exists(COLOR_FILE): raise RuntimeError(f"COLOR_FILE {COLOR_FILE} not found")` before trying to load.

### Committed plaintext Postgres password — security incident
- **Issue:** `Mavdob8808!` is a plaintext Postgres password hardcoded in source history. Although `db.py:32` now reads from `PG_PASS` env var with an empty default, the credential is permanently in git history.
- **Files:** `db.py` (git history — not visible in current line 32 but in `git log`)
- **Impact:** Critical security issue. Anyone with repo access has the production Postgres credentials (if the same password is reused on hosted systems). This must be rotated immediately regardless of deployment timeline.
- **Fix approach:** (1) Rotate the Postgres password on all systems now. (2) If this repo will be shared / made semi-public, purge history with `git-filter-branch` or `git-filter-repo` (requires a full rewrite and re-push — involves team coordination). (3) Going forward, never commit secrets; use `.env.example` + `.env` (gitignored) for local development, and environment variables for hosted systems. MIGRATION.md WS1 already specifies this pattern.

### CORS misconfiguration — allows any origin with credentials
- **Issue:** `brain.py:143–144` sets `allow_origins=["*"]` with `allow_credentials=True`. This is an invalid CORS posture: `*` is not allowed when credentials are enabled (browsers reject it). The server will emit `Access-Control-Allow-Origin: *` which the browser treats as "no actual CORS protection."
- **Files:** `brain.py:141–148`
- **Impact:** In practice, if the frontend is on the same origin (via the nginx proxy planned in MIGRATION.md WS6), this is moot. But if the frontend ever moves to a CDN or separate domain, the current config leaves the backend CORS-open.
- **Fix approach:** (1) For the hosted MVP (WS6): use a same-origin proxy; leave `allow_origins=["*"]` but it won't matter (CORS only applies cross-origin). (2) Once containerized: list only the frontend FQDN(s) in `allow_origins`, or use an env var to inject them. (3) Remove `allow_credentials=True` if not needed; add a comment if it stays. The pattern is in MIGRATION.md WS1 (`CORS_ALLOW_ORIGINS` env var).

### Optimization heuristics are not true optimization — wrong model for scheduling
- **Issue:** `Engine` mode names (`'spt'`, `'changeover'`, `'combined'`) are misleading. They implement **greedy dispatching heuristics** that can produce suboptimal sequences. There is no changeover-cost matrix, no finite-capacity constraints, no precedence-link awareness, no multi-line leveling. CLAUDE.md documents this, but external stakeholders may misunderstand what "optimize" means.
- **Files:** `brain.py:1151–1195` (dispatcher), `app.js:3840–8438` (UI surfaces), CLAUDE.md (documented but easily missed)
- **Impact:** User confusion. An order optimized on line A can still collide with an order on line B. Optimizations don't account for material availability, tooling setup, or supplier lead time. Real manufacturing schedulers use MIP solvers or constraint-satisfaction engines; this is a UX affordance, not an optimization.
- **Fix approach:** (1) Rename to `'shortest-job-first'`, `'group-by-color'`, `'group-then-shortest'` to clarify they are heuristics. (2) Add an `OptimizeModal` disclaimer: "Sort approximations help organize orders — not a full optimizer." (3) Spike a real constraint-satisfaction engine as a future phase (this is not urgent for a single-plant pilot but becomes critical at 50+ plants).

### Event-loop blocking in 11 async handlers — invisible to single user, stalls on concurrency
- **Issue:** 11 routes in `brain.py` are declared `async def` but run blocking operations (Postgres sync driver, file I/O, VACUUM, JSON rewrite) directly on the event loop: lines 954 (`POST /upload`), 986 (`POST /purge`), 995 (`POST /task/note`), 1011 (`POST /tasks/update`), 1032 (`POST /task/update`), 1043 (`POST /audit/log`), 1065 (`POST /reload`), 1097 (`POST /color-wheel/{plant}` PUT), 1120 (`POST /color-wheel/{plant}` DELETE), 1166 (`GET /maintenance/vacuum-analyze`), 1178 (`POST /labor-plan/line` POST).
- **Files:** `brain.py:954–1178` (throughout the handler definitions)
- **Impact:** Single-user development is unaffected (minimal concurrent requests). But the Azure pilot (2–5 editors, 30-second concurrent drag+save bursts) will see request stalls. A 500 ms VACUUM or 200 ms color-wheel JSON rewrite blocks **all** in-flight requests on the event loop. Starlette's thread pool exists for exactly this reason — the sync `def` handlers (e.g., `POST /health`) are already correct.
- **Fix approach:** Convert each to a sync `def` handler OR wrap blocking calls in `run_in_threadpool`. The pattern is small: either `def upload(...):` or `await run_in_threadpool(db.query_orders)`. The AUDIT_REPORT_BACKEND.md specifically identifies this as the #1 HIGH-severity fix (small effort, measurable gain under concurrency). Test with `locust` or curl loops: 2 concurrent `POST /task/update` calls should not see the second one stalled.

### `/tasks` endpoint has no pagination — scales poorly to 50+ plants, 3,500+ lines
- **Issue:** `GET /tasks?plant=…` returns the entire order list for a plant in one response. There is no `?limit=` / `?offset=` support exposed to the frontend, even though `db.query_orders()` accepts them (db.py:143–173). This is fine for a 15-line pilot, but at 3,500 lines the full response becomes 1–2 MB, and the frontend must parse/render all rows even if the user only sees 50 at a time.
- **Files:** `brain.py:548–599` (`GET /tasks` handler), `db.py:143–173` (pagination-ready), `app.js` (Persistence fetches full plant)
- **Impact:** Network bandwidth waste. Initial load latency grows with plant size. If the frontend later virtualizes the table, pagination becomes a must-have but requires a coordinated backend+frontend redesign.
- **Fix approach:** Wire the optional `?limit=` / `?offset=` parameters through now (backward-compatible, optional). Prepare the frontend for paginated hydration (preload first 100, fetch on scroll). This is not urgent for the MVP pilot but should be a WS9 checklist item before 50-plant rollout. MIGRATION.md notes it as out-of-scope for WS1–WS8.

### Color-wheel audit log grows unbounded, rewrites entire file per append
- **Issue:** `brain.py:296–304` appends a new event to `_audit_log.json` and **rewrites the entire file** on every append (via `json.dump(events, ...)`). The log is never pruned. After months of operation, the audit log becomes large, and every color-wheel event (user upload, plan reload, optimization) triggers a full-file rewrite — this is O(n) per operation.
- **Files:** `brain.py:296–304`
- **Impact:** Performance degradation over time. On a 50-plant system with daily uploads + optimizations, the audit log could grow to 10,000+ events. Each event blocks the request briefly. Secondary: disk churn on Azure Files.
- **Fix approach:** (1) Switch to JSON-Lines append (one JSON object per line, no array wrapping — read with streaming). (2) Or, cap retention: keep only the last 1,000 events, archive/rotate older entries. (3) Or, migrate to a Postgres `color_wheel_audit` table (cleaner, queryable). For the pilot, JSON-Lines is fastest; the migration to Postgres is a later optimization.

### `ingest_orders_from_excel()` is a 154-line monolith — hard to review
- **Issue:** `db.py:812–965` combines parsing, validation, deduplication, chunked upsert, and audit logging in one function. The function is correct but touches the most critical data path: every new order upload goes through here. At 154 lines, it's difficult to review exhaustively for edge cases.
- **Files:** `db.py:812–965`
- **Impact:** Code-review burden. If a bug is introduced in the upload path (e.g., a bad dedup rule, truncation of a field), it affects every order in the upload. The function deserves smaller, testable pieces.
- **Fix approach:** Decompose into five small functions: `_parse_excel()` (validate format, return DataFrame), `_validate_rows()` (schema check, type coercion), `_dedup_orders()` (produce id → latest-row map), `_upsert_chunked()` (batch into DB), `_log_upload_audit()` (write metadata). Keep the public `ingest_orders_from_excel()` as a thin orchestrator that calls all five. This is a MEDIUM effort (70 lines → 5 × 15-line functions + 10-line orchestrator) and turns the most-feared path into reviewable pieces. AUDIT_REPORT_BACKEND.md recommends this as a follow-on.

## Known Bugs

**None formally catalogued.** The AUDIT_REPORT_BACKEND.md and AUDIT_REPORT_FRONTEND.md found zero correctness bugs (verified: no unused imports, no circular imports, no silent data loss, no layout thrash, no listener stacking).

However, the following are known limitations / expected behaviors:

### `Persistence.saveAll()` coarse-grained, not task-aware
- **Limitation:** Frontend saves all tasks with a single `POST /tasks/update` (app.js:1604–1632). If two users edit different orders on the same plant simultaneously, the second save may silently overwrite changes from the first (no per-task conflict detection). The optimistic 409 guardrail in MIGRATION.md WS4 only helps if both users edit the **same** order.
- **Files:** `app.js:1604–1632` (auto-save path), `brain.py:1011` (`POST /tasks/update`)
- **Impact:** Pilot scale (2–5 users, one plant) makes this unlikely unless both users edit overlapping orders. At 50 plants this becomes intractable.
- **Known mitigation:** MIGRATION.md WS4 adds per-task `updated_at` timestamps; frontend checks them and shows a toast if a task was changed by someone else. This is "optimistic" — it helps but doesn't prevent all races (the coarse-grained save is the root cause).
- **Workaround (documented):** The UI is single-plant + single-user-per-plant by design. Plant-level edit locks or strict serial access during pilot phase.

### Labor-plan per-cell writes are N round trips, not batched
- **Issue:** `master_data.py:548–570` and `621–644` write one labor-plan cell at a time via `execute()` in a loop. A 7×10 grid edit (70 cells) makes 70 Postgres round trips. This compounds the event-loop blocking issue.
- **Files:** `master_data.py:548–570` (per-cell DELETE), `621–644` (per-cell INSERT)
- **Impact:** Slow interaction on large grids. Feels sluggish on low-latency local networks; noticeable on Azure.
- **Fix approach:** Replace the loop with (1) `executemany()` for the inserts (one round trip for all 70), (2) `DELETE … IN (...)` for deletions. This is a 5-line mechanical refactor and is MEDIUM priority in AUDIT_REPORT_BACKEND.md.

## Security Considerations

### Trusted `X-User` header — no authentication
- **Risk:** `brain.py:909, 965, 1018` read `X-User` from the request header with no validation. Any client can set `X-User: ceo@company.com` and perform actions as that user. On localhost this is fine (single developer); on Azure this is a critical gap.
- **Files:** `brain.py:909, 965, 1018`; `app.js:1604, 1632, 3798, 11979, 12637, 12756, 12786, 12812, 12860` (hardcoded to `trevor.holton@newellco.com`)
- **Current mitigation:** Local-only development. MIGRATION.md WS3 replaces this with Entra ID SSO (JWT validation + `require_user` dependency).
- **Recommendations:** (1) For Azure, implement WS3 (MSAL.js + JWT validation). (2) For local dev, disable the `X-User` check entirely (no auth), or require an explicit flag like `NIMBUS_AUTH_DISABLED=1`. (3) Never allow `X-User` on a hosted system — the check must fail-closed in production.

### No input validation on max note length
- **Issue:** `brain.py:995–1010` (`POST /task/note`) updates the `notes` column with no length check. The comment in `schema.sql:36` says `max 500 chars enforced at app layer`, but no validation code is visible. If a user submits a 50 KB note, it is inserted as-is.
- **Files:** `brain.py:995–1010`, `schema.sql:36` (comment only)
- **Impact:** Column bloat over time. A Postgres `TEXT` is unbounded, so this is not a schema-level crash, but Newell's DB governance may have field-length expectations.
- **Fix approach:** Add a simple check: `if len(note) > 500: raise ValueError("Note exceeds 500 characters")` at the handler level. Or enforce in the Pydantic model if `/task/note` switches to `BaseModel`. This is LOW effort and LOW risk.

### `/maintenance/vacuum-analyze` has no protection
- **Issue:** `brain.py:1166–1176` exposes a `GET /maintenance/vacuum-analyze` endpoint that runs `VACUUM ANALYZE` on the orders table with no authentication or rate-limiting. Any client can GET this and stall the entire backend for seconds.
- **Files:** `brain.py:1166–1176`
- **Impact:** Denial of service. A malicious user or accident can make the app unresponsive.
- **Fix approach:** (1) Require auth (WS3 dependency: add `Depends(require_user)` and check that user is an admin). (2) Alternatively, move maintenance to a separate admin CLI/script, not an HTTP endpoint. (3) Add rate-limiting: "vacuum only once per day" guard.

### Raw SQL string in `db.get_db_slow_queries()` is parameterized but comments say "no SQL in brain.py"
- **Issue:** `db.py:711–739` is correct (parameterized), but the AUDIT_REPORT_BACKEND.md proudly notes "SQL boundary (zero SQL in brain.py)." This is strictly true, but the comment might mislead future developers into thinking it's okay to write ad-hoc SQL elsewhere.
- **Files:** Verification comment in AUDIT_REPORT_BACKEND.md; actual code in `db.py` is fine
- **Impact:** Low (code is correct), but a documentation drift.
- **Fix approach:** Update the AUDIT_REPORT verification note to clarify: "zero SQL in brain.py; all SQL in db.py is parameterized."

## Performance Bottlenecks

### Dashboard rebuilds all six panels on every Store mutation, even when inputs unchanged
- **Issue:** `app.js:6866–6883` (Dashboard.render()) calls `_renderKPIs()`, `_renderHeatmap()`, `_renderLineStatus()`, `_renderAlertSummary()`, `_renderFixedList()`, `_renderLatenessHeatmap()` behind a 300 ms debounce, but with no memoization. An alert-only recompute (no task changes) still triggers a full `innerHTML` rebuild of all panels.
- **Files:** `app.js:6866–6883`, `6733–6734` (debounce declaration)
- **Impact:** Measurable DOM-write cost on every Store mutation burst. Scales poorly with line count (each panel render cost is O(lines)). At 3,500 lines, a six-panel rebuild could take 100+ ms even when nothing changed.
- **Improvement path:** Add a memo key: `` `${Store._rev}|${Store.selectedPlant}|${[...Dashboard._filterLines].sort().join(',')}|${Dashboard._latenessHorizon}` `` and bail early on match. The pattern is already proven in `Utilization.computeMatrix()` (app.js:4613–4616). This is HIGH priority (H-3 in AUDIT_REPORT_FRONTEND.md) and is a 4-line addition.

### ProdLines re-wires six listener loops on every settings edit
- **Issue:** `app.js:1895–1946` (ProdLines._wireInputs) re-runs a `querySelectorAll().forEach` loop for six input groups after every `_renderDetail` call. The `.buf-unit-btn` click handler calls `_renderDetail`, creating a render → re-wire cycle per button click.
- **Files:** `app.js:1895–1946`
- **Impact:** Unnecessary DOM queries and listener re-binding. Diverges from the house pattern (Hierarchy uses event delegation; see commit 3bfec65).
- **Improvement path:** Replace `_wireInputs` with delegated listeners on the stable `#lines-body` container (one-time setup, never re-wired). This is cleaner, matches existing patterns, and saves ~30 lines. Effort: MEDIUM, with reference code in Hierarchy (`_delegated` pattern at app.js:6687).

### Hierarchy tree re-renders entire subtree on every Store mutation
- **Issue:** `app.js:6617` (Hierarchy.init → Store.subscribe) calls `_render()` on **every** event. `_render()` rebuilds the entire tree from scratch (app.js:6726–6754), even if only one line's utilization changed.
- **Files:** `app.js:6617–6754`
- **Impact:** At 70 lines per plant, a full tree rebuild is expensive. The impact is hidden by the currently-small scale (15 lines total) but becomes visible at target scale.
- **Improvement path:** Convert to incremental updates: (1) track which lines changed (e.g., a `Store._changedLines` hint), (2) update only those tree nodes. Or (2) add memoization: bail if the tree's input key is unchanged. The plant-level collapse state is already memoized (app.js:6697); extend the pattern to the whole tree.

### Flatpickr config duplicated across 16 init sites
- **Issue:** The same datetime config `{ enableTime: true, dateFormat: 'Y-m-d\\TH:i', altInput: true, altFormat: 'M j, Y · h:i K', minuteIncrement: 30 }` is pasted 8 times; date-only config 4 times; time-only config 4 times (app.js:1128, 1132, 1507, 1511, …).
- **Files:** `app.js:1128–12629` (16 pasted occurrences)
- **Impact:** Low-severity maintainability debt. If the format changes (e.g., new `minuteIncrement: 60`), all 16 sites must be updated.
- **Fix approach:** Extract three factory functions in `Util`: `Util.fpDatetime(el, overrides={})`, `Util.fpDate(el, overrides={})`, `Util.fpTime(el, overrides={})`. Each returns a `flatpickr` instance. This is MEDIUM priority and is a mechanical ~30-line refactor documented in M-1 of AUDIT_REPORT_FRONTEND.md.

### Time-unit magic numbers: 59 occurrences across 56 lines
- **Issue:** `3600000` (ms/hour) appears 32 times; `86400000` (ms/day) 15 times; `60000` (ms/minute) 12 times. All in arithmetic contexts but with no single source of truth. A change to one would require 59 replacements.
- **Files:** `app.js` (54 occurrences), `nimbus-intelligence.js` (10 occurrences)
- **Impact:** Maintainability debt and risk of off-by-one errors if a value is typo'd. Composed forms (e.g., `15 * 60 * 1000`) are self-documenting and were left alone.
- **Fix approach:** Add to `Config`: `MS_MIN: 60000, MS_HOUR: 3600000, MS_DAY: 86400000`. Replace literals with `Config.MS_MIN`, etc. This is LOW-severity (M-2 in AUDIT_REPORT_FRONTEND.md) but high-value for maintainability.

## Fragile Areas

### Color-wheel file-based storage — no durability on container restart
- **Files:** `brain.py:296–304` (audit log append), `brain.py:235–294` (load/save), `COLOR_WHEEL_DIR`
- **Why fragile:** Per-plant color wheels are `.xlsx` files written to the local filesystem. On a containerized system (like Azure Container Apps), the container's filesystem is ephemeral — a redeploy, auto-scaling, or crash loses all per-plant color wheels.
- **Safe modification:** MIGRATION.md WS5 addresses this: mount Azure Files at `/data/color_wheels` so the storage survives restarts. No code change needed — just an infrastructure change. Until then, color wheels must be re-uploaded after any container restart.
- **Test coverage:** No tests exist for color-wheel I/O; the path is manual-QA only.

### Task update validation is split: frontend + backend but not atomic
- **Issue:** `app.js:1620` validates `start ≤ end` on the frontend; `brain.py:1032–1045` validates again server-side via `db.update_task_dates_bulk()`. But the frontend can send multiple tasks; the server validates the batch as a whole but doesn't reject individual inverted tasks — it rolls back the entire batch.
- **Files:** `app.js:1620`, `brain.py:1032–1045`, `db.py:880–920`
- **Why fragile:** If user B is editing while user A sends a broken request, user B's valid changes are rolled back too (atomic batch, not per-task rollback). The user sees no clarity about which task was rejected.
- **Safe modification:** (1) Add per-task validation at the handler level: return HTTP 409 with a list of invalid task IDs instead of rolling back the whole batch. (2) Or accept the current behavior but document it: "batch updates are atomic; a single invalid task rejects the entire save."

### Admin DDL (add/drop column) is unguarded except by audit logging
- **Files:** `master_data.py:272–377` (column management endpoints)
- **Why fragile:** `POST /admin/column` can add a new column to any table with no schema validation. The endpoint checks that the operation is JSON-valid and the new column has a display label, but it doesn't validate the Postgres data type or check for naming conflicts with reserved words.
- **Safe modification:** (1) Whitelist allowed data types (TEXT, INTEGER, NUMERIC, BOOLEAN, TIMESTAMP). (2) Reject reserved words (e.g., "order", "group"). (3) Require auth (WS3: `Depends(require_user)`). (4) Add a dry-run mode: `?dry_run=1` returns the ALTER TABLE statement without executing.

### localStorage for state — no sync on plant change
- **Files:** `app.js:1543` (localStorage save), `Persistence` module
- **Why fragile:** App state (blackout calendars, line settings, filter choices) is persisted to `localStorage:nimbus.state.v3` per browser session. If a user bookmarks a view on plant 5512 and later selects plant 1006, the app loads plant 1006's data but the UI still shows calendars/filters from plant 5512 until manually cleared.
- **Safe modification:** (1) Scope localStorage by plant: `localStorage:nimbus.state.v3.${plant}`. (2) Or, migrate state to server-side per-user storage (MIGRATION.md notes this as fast-follow). (3) For now, add a guard in Plant selection: if selected plant differs, reset UI to defaults.

## Scaling Limits

### Frontend renders one DOM node per line, per alert → 70+ lines × 50 plants = thousands of nodes
- **Current capacity:** 15 production lines across 2 plants render comfortably. The Hierarchy tree, Dashboard line-status panel, and Alerts drawer each create one DOM node per line.
- **Limit:** At 70 lines per plant × 50 plants = 3,500 lines, rendering all of them would create 3,500+ DOM nodes per pane. Browser layout will become the bottleneck.
- **Scaling path:** (1) Virtualize the custom panes (render only visible rows + spacer). Hierarchy tree needs a windowing helper. (2) Use `content-visibility: auto` on off-screen tab panels and dashboard cards so the browser skips layout for them.

### Database indexes tuned for single-plant use, not 50-plant federation
- **Current capacity:** `idx_orders_line_eff_start` (schema.sql:51) is tuned for a single `/tasks?plant=…` request. It's optimal for 15 lines.
- **Limit:** At 50 plants × 70 lines/plant = 3,500 lines, a user browsing across plants will issue separate `/tasks` requests per plant (frontend scopes by plant). Each request is fast (the index is used). But **the index doesn't cover** a hypothetical future "all-plant dashboard" query (if Newell ever wants to see cross-plant metrics).
- **Scaling path:** (1) For MVP, keep the per-plant scope (CLAUDE.md mandates this). (2) Pre-pilot, add `?limit=`, `?offset=` support (documented above). (3) If cross-plant views are needed, design a separate aggregation index or materialized view (fast-follow).

### Optimization heuristics not designed for multi-line interaction
- **Current capacity:** The Engine greedily places orders line-by-line. Within a single line, it works. Across lines, there's no awareness.
- **Limit:** A real manufacturer might have finish-to-start links across lines (e.g., "cut on line A, then sand on line B"). The current dispatcher ignores these. At 70 lines, ignoring cross-line precedence will produce invalid schedules.
- **Scaling path:** (1) For pilot: disable multi-line orders (enforce single-line orders only). (2) Future: extend the dispatcher to respect `production_line` finish-to-start links, or switch to a true constraint-satisfaction solver (not in MVP scope).

### Auth is per-request but no plant-level RBAC
- **Current capacity:** All users with valid Entra logins can access all plants (once WS3 lands). No plant-level access control.
- **Limit:** A 50-plant deployment needs plant-level RBAC so plant managers can only see their plant. Currently, every authenticated user sees every plant.
- **Scaling path:** Add a `user_plants` table mapping user OID → allowed plants. The stub is in MIGRATION.md WS3 (`require_plant_access` is a no-op today). Implement it before 50-plant rollout.

## Dependencies at Risk

### No production-grade test suite
- **Risk:** Zero test files in the codebase. All testing is manual QA or ad-hoc Postman requests.
- **Impact:** Regressions introduced in future phases could go undetected until user-reported. The most critical path (order upload) has no automated tests.
- **Migration plan:** Standing up a test suite is a separate effort. Recommended approach: pytest API-level tests (no UI test overhead; tests hit the real DB). AUDIT_REPORT_BACKEND.md recommends a "smoke.py" script (50 lines) as the on-ramp: hit `/health`, `/tasks?plant=…`, `/diagnostics`, one round-trip `POST /task/update` (reverted). This is a pre-deploy tripwire, not a full test suite.

### vis-timeline library (vis.js) is on version 7.7.3 (aging but still maintained)
- **Risk:** vis.js is a legacy library (last major version bump was years ago). It is not actively developed. If a critical bug is discovered, patches may be slow.
- **Impact:** Low-severity for the pilot. The library is stable and NIMBUS uses its diffed update API (not setItems) correctly, so upgrade risk is low.
- **Migration plan:** Monitor GitHub releases. If a CVE is discovered or maintenance stops, consider migrating to a modern Gantt library (e.g., Bryntum, dhtmlxGantt, or a React-based solution). This is not urgent.

### pandas/numpy/openpyxl versions not pinned
- **Risk:** `requirements.txt` (if it exists) or the implied versions in `brain.py` imports are not explicitly pinned. On a future `pip install -r requirements.txt` on a new machine or in a container, you might pull a newer version with breaking API changes.
- **Impact:** Medium-risk for containerization. A pandas 3.0 release could break `df.columns.str.upper()` syntax.
- **Migration plan:** MIGRATION.md WS2 specifies pinning versions (e.g., `pandas==2.0.3`). Create a `requirements.txt` with pinned versions. Use `pip freeze > requirements.txt` to generate it from your current environment, then commit it.

### azure-identity, msal-browser will be new dependencies
- **Risk:** WS3 adds `PyJWT[crypto]` and MSAL.js (via CDN). These are maintainer-owned libraries (Microsoft/Auth0), so they are reasonably stable. But they are critical path for hosted auth.
- **Impact:** If MSAL.js breaks on a browser update, users can't log in. If PyJWT breaks, the backend can't validate tokens.
- **Migration plan:** MIGRATION.md documents the version specs. Pin them in `requirements.txt` and in index.html's CDN URL (use explicit version tags, not `latest`).

## Test Coverage Gaps

### Order upload path — no tests, most critical code path
- **What's not tested:** `db.ingest_orders_from_excel()` (db.py:812–965) and the entire `POST /upload` handler (brain.py:954–982). This path touches every order in a bulk import.
- **Files:** `db.py:812–965`, `brain.py:954–982`
- **Risk:** A regex error in the upload parser could silently drop orders. A dedup logic error could merge two distinct orders.
- **Priority:** **CRITICAL** — recommend: write 5–10 pytest fixtures covering (1) happy path, (2) malformed Excel, (3) duplicate detection, (4) date parsing, (5) missing columns.

### Labor-plan bulk edit — no tests
- **What's not tested:** The labor-plan grid (LaborPlanning module, app.js:2316–2820) and its backend (`master_data.py:548–644`). No tests for save-on-blur, conflict detection (if implemented), or range edits.
- **Files:** `app.js:2316–2820`, `master_data.py:548–644`
- **Risk:** A UI typo or batch-write bug could silently corrupt labor-plan data.
- **Priority:** **HIGH** — recommend: pytest tests for (1) bulk INSERT, (2) bulk DELETE, (3) edge cases (empty ranges, large grids).

### Dashboard KPI calculations — no tests
- **What's not tested:** The six KPI panels (`_renderKPIs`, app.js:6921–6981 and related helpers) have no isolated tests. If the calculation logic changes, regressions are invisible until manual visual inspection.
- **Files:** `app.js:6921–6981`, related helpers
- **Risk:** A Dashboard metric could silently report wrong numbers (e.g., "Overdue backlog" undercount due to a date comparison bug).
- **Priority:** **HIGH** — recommend: unit tests for each KPI metric (overdue count, conflict count, capacity headroom, etc.) with fixed data.

### Optimization modes — no tests
- **What's not tested:** The three Engine modes (`'spt'`, `'changeover'`, `'combined'`) are never validated. The output sequences are never tested against expected heuristic behavior.
- **Files:** `brain.py:1151–1195` (dispatcher), `app.js` (Engine module)
- **Risk:** A dispatcher refactor could silently change the output order without anyone noticing.
- **Priority:** **MEDIUM** — recommend: pytest tests for each mode with a fixed scenario (5 orders, 2 colors, 2 lines); assert the output sequence matches the documented heuristic (e.g., "SPT = shortest job first").

---

*Concerns audit: 2026-06-17*
