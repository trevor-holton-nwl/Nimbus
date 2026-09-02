# NIMBUS Comprehensive Code Review & Architecture Audit — 2026-09-01

**Method:** Seven scoped review passes over non-overlapping slices (backend platform; backend scheduling/setup/calendars; backend master-data/integration/priority-lists/labor; frontend platform/shell; frontend scheduling/optimization; remaining frontend domains; cross-stack wiring + schema + tests), followed by direct verification of every P0-level claim against live code. Read-only — no code was modified. ~90 API routes cross-matched against every frontend call site; ~70k lines reviewed.

**Legend:** Priority P0 (critical) → P3 (nice-to-have). Confidence High/Med/Low. Every finding cites file:line evidence.

---

## 1. Executive Summary

NIMBUS is in materially better shape than its own audit trail suggests. The wiring between frontend and backend is essentially complete — **no frontend call targets a nonexistent endpoint, no method mismatches, no orphaned features mid-migration**. The Store/reactive platform layer is disciplined, the setup domain's optimistic-concurrency design is sound, SQL is parameterized throughout (no injection surface found), password hashing is strong, and several historically "open" defects are confirmed **already fixed** (the four 2026-07-03 setup-scheduler defects were resolved by architectural replacement; the saveAll timezone corruption fix is durable; the ×1440 schema landmine is genuinely removed, not just guarded).

The real risk is concentrated in **three places**:

1. **The authorization model is a client-spoofable HTTP header, and the highest-blast-radius write surface (the `/tasks` family) has no auth at all.** Anyone who can reach the live Azure pilot can reschedule any order in any plant with zero credentials, and anyone who knows an admin username (one is hardcoded in source) can do everything else. CORS defaulting to `*` makes this browser-exploitable from any webpage unless the env allowlist is set. This is partially a known/accepted pilot posture (Entra migration is the plan of record), but the task-route gap is worse than the documented posture — those routes don't even have the spoofable-header floor.
2. **`schema.sql` cannot bootstrap a fresh database**: an index on `orders(plant, …)` is created 269 lines before the `plant` column is added, and the `orders.plant` column itself exists in no migration file — so both provisioning paths (fresh `schema.sql`, or ledger-only migrations) produce a broken or incomplete schema. Existing environments are unaffected, which is why nobody has noticed.
3. **The three highest-risk behaviors have zero server-side test coverage**: the xmin save-concurrency contract on `/tasks/update`, the Excel/BOM ingest path, and RBAC/plant scoping. All three have already produced (or nearly produced) production data bugs historically.

Below those, the findings are the normal texture of a fast-moving codebase: a handful of unescaped-`innerHTML` XSS holes where a module skipped its own escaping convention, several stale-response races on rapid plant/table switching, a system-wide N+1 in setup-state capture, i18n gaps clustered in the oldest surfaces, and a small amount of genuinely dead code.

**Top 8 most important findings:**

| # | Finding | Priority |
|---|---|---|
| 1 | `/task*`/`/tasks/*` write routes: no authentication, no plant scoping | P0 |
| 2 | Entire auth boundary = spoofable `X-User` header on a live system; CORS defaults `*` | P0 |
| 3 | `schema.sql` fresh-bootstrap failure (index before column); `orders.plant` in no migration | P0 |
| 4 | Zero server-side tests for save concurrency, ingest, and RBAC | P1 |
| 5 | Stored XSS via blackout `reason` in calendar; 2 more unescaped-HTML holes | P1 |
| 6 | Stale-response races: `Persistence.load()` plant switch, master-data table switch, labor plan | P1 |
| 7 | Overlapping `saveAll()` can silently drop the newest edit; `/task/note` breaks the version contract | P1 |
| 8 | `capture_setup_states_before_schedule_mutation` scans all plants/machines on every single-plant ingest | P1 |

---

## 2. Critical Findings (P0/P1)

### P0-1 — Task read/write routes have no authentication and no plant scoping
- **Location:** `backend/scheduling/routes.py:344-505` (`update_task`, `update_task_note`, `tasks_update`, `bulk_update`, `tasks_refresh`, `baseline_correct`); `db.py:849` (`update_task_dates_bulk`), `db.py:1064`, `db.py:1185`
- **Problem:** None of the six task-mutation handlers declare any `Depends(...)` guard — verified directly. `brain.py` has no global auth middleware. `get_tasks` is the only handler in the domain that consults `allowed_plants`; every write path accepts bare order ids with no check that the order's plant is in the caller's `role_plants` scope.
- **Evidence:** `@router.post("/task/update")` → `def update_task(task: TaskDateUpdate):` — no dependencies. `db.update_task_dates_bulk` filters only by id (`WHERE o.id = ANY(%s) FOR UPDATE OF o`).
- **Impact:** Any network client that can reach the API — no header, no login — can reschedule any order in any plant, edit priority fields, clear notes, and rewrite due-date baselines. A plant-A-restricted user can write to plant B–Z orders by id (ids are stable MD5s, visible in exports). This is the single most consequential write surface in the app and it sits below even the weak header-based floor every other domain has.
- **Recommendation:** Add `Depends(auth.require_authenticated)` to all six routes and thread `allowed_plants` through `_apply_task_date_updates` / `update_task_dates_bulk` / `correct_due_date_baselines` / `update_task_note` / `get_task_versions`, rejecting out-of-scope ids the way `get_tasks` already filters reads.
- **Priority:** P0 · **Confidence:** High (verified) · **Category:** Security / Data Integrity

### P0-2 — The entire authorization boundary is a client-supplied header; CORS defaults to `*`
- **Location:** `backend/security/auth.py:480-536` (`_actor_email`, `require_admin`); `brain.py:354-367` (CORS)
- **Problem:** Identity resolves solely from `request.headers.get("x-user-email")`/`X-User` — no cookie, signature, or server session. Any client can claim any username; if it maps to `role='admin'`, that's full admin (password resets for any user, DB maintenance, master-data mutation). `NIMBUS_API_KEY` gates only the destructive subset of admin routes and is opt-in/unset by default. Compounding it: `NIMBUS_ALLOWED_ORIGINS` defaults to `"*"` with `allow_headers=["*"]`, and since the "auth" is a custom header (not a cookie), **any third-party webpage's JavaScript can set it** — the wildcard makes header-spoofing a remotely triggerable, browser-based exploit, not just a curl-based one. The default bootstrap admin username is also hardcoded in source (`auth.py:618`, `"PJ29587"`), handing an attacker a known-good admin identity.
- **Impact:** Full system takeover for anyone with network access to the live pilot, if the two env vars aren't set. This is a documented/accepted pilot gap pending the Entra migration — but "planned to fix" doesn't reduce present exposure, and the live URL has been public since 2026-06-30.
- **Recommendation:** (1) **Verify today** that `NIMBUS_API_KEY` and `NIMBUS_ALLOWED_ORIGINS` are actually set on `ca-nimbus-dev` — this is a 5-minute check with the highest risk-reduction-per-effort in this report. (2) Apply `require_api_key` uniformly to *all* admin routes, not just destructive ones. (3) Change the bootstrap-admin default to something generic. (4) Keep the Entra migration the top structural priority.
- **Priority:** P0 (code-level exposure High confidence; live exploitability depends on unverified env config) · **Category:** Security

### P0-3 — `schema.sql` cannot bootstrap a fresh database; `orders.plant` exists in no migration
- **Location:** `schema.sql:81-82` (index) vs `schema.sql:34-60` (CREATE TABLE — verified: no `plant` column) vs `schema.sql:350` (ALTER adds `plant`); `migrations/` (no file adds `orders.plant`)
- **Problem:** `CREATE INDEX idx_orders_plant_eff_start ON orders(plant, …)` runs at line 81; `orders.plant` isn't added until the `ALTER TABLE` at line 350. On a truly fresh database, line 81 throws `column "plant" does not exist` — without `ON_ERROR_STOP` the script limps on and the index is silently never created; with it, bootstrap aborts. Separately, no `migrations/*.sql` file adds `orders.plant` (the 2026-08-20 migration creates the *index* but not the column), contradicting the "deploys apply `migrations/`, never `schema.sql`" rule — a ledger-only rebuild of the Azure DB would silently lack the column that fixes the documented multi-plant mis-attribution bug.
- **Impact:** Every new environment (new dev machine, DR rebuild, prod promotion) hits this. Existing environments are unaffected, which is why it's latent.
- **Recommendation:** Move the `ALTER TABLE orders ADD COLUMN IF NOT EXISTS plant` block above line 81 (or move the index below it), and add a dated migration for `orders.plant` + backfill so the ledger path is self-sufficient. Add a CI smoke test that applies `schema.sql` to a scratch Postgres with `ON_ERROR_STOP=1`, and one that applies only `migrations/` and diffs the result.
- **Priority:** P0 · **Confidence:** High (verified) · **Category:** Bug / Data Integrity

### P1 findings

**P1-1 — Labor Plan endpoints: zero auth, zero plant scoping** — `backend/labor/routes.py:16-57` (verified: no `Depends` on any of the four routes). Any caller can read or overwrite any plant's labor-hours plan. Add `allowed_plants` + `_assert_plant_allowed` matching the master-data pattern. *(Security, High)*

**P1-2 — Stored XSS via blackout `reason`/`line`** — `frontend/calendar/calendar-admin.mts:135-136` (verified: `${b.reason || …}` straight into `innerHTML`). Any user who can create a blackout can persist `<img onerror=…>` that fires for every user opening Calendar for that plant. Same render path also interpolates `b.id` into an inline `onclick` (line 138). Route through the `esc()` helper used elsewhere. *(Security, High)*

**P1-3 — Two more unescaped-`innerHTML` holes** — `frontend/admin-ops/admin-ui.mts:1889-1902` (`_dbLockChain` injects raw `pg_stat_activity` query text — application data literals inside SQL text can carry markup into the admin DB view); `frontend/insights/insights-ui.mts:658,668` (machine/line names unescaped in heatmap attributes + inline `onclick`, while the sibling lateness heatmap escapes the same values); `frontend/master-data/admin-ui.mts:2794` (backend `err.message` into `innerHTML`). Each file has a working escape helper it uses elsewhere — these are skipped-convention holes, not missing infrastructure. *(Security, High)*

**P1-4 — `/task/note` bypasses the xmin version contract** — `backend/scheduling/routes.py:363-380`, `db.py:1185-1192`. The note UPDATE bumps xmin but returns no new version, so the client's next real schedule save on that task spuriously lands in `stale`. Return `RETURNING id, xmin::text::bigint` and surface it as `versions`, mirroring `update_task_dates_bulk`. *(Bug/Data Integrity, High)*

**P1-5 — Overlapping `saveAll()` can silently drop the newest edit** — `frontend/scheduling/persistence.mts:1091-1211`. No in-flight lock; the success handler clears `_dirtyIds` by id alone, so an edit made after the payload snapshot but before the response gets its dirty flag cleared without ever being sent. Add an in-flight lock and clear dirty only when sent value == current value. *(Bug, Med)*

**P1-6 — Plant-switch race in `Persistence.load()`** — `frontend/scheduling/persistence.mts:203-473`. No generation guard (unlike `loadSetupSnapshot`, which has exactly this protection); switching A→B fast can let A's slow response overwrite B's board and reset `_currentLoadedPlant`. Apply the same generation-counter pattern. Two siblings of the same race: master-data table switching (`admin-ui.mts:2759-2798`, missing the staleness guard its own sibling modules have) and Labor Planning plant switches (`labor-planning.mts:941-1010`, no render token). *(Bug, High)*

**P1-7 — Optimize preview→apply doesn't detect concurrent task edits** — `frontend/optimization/optimize-ui.mts:1141-1361, 1764-1842`. `OptimizerPreview.stale` is set only by setup-data writes; a remote `tasks:bulkUpdate` while the preview is open is silently clobbered by Apply, bypassing the xmin contract the domain otherwise honors. Re-diff snapshot task versions against Store state before enabling Apply. *(Bug/Architecture, Med)*

**P1-8 — System-wide N+1 in setup-state capture on every ingest** — `backend/setup/data.py:501-524`. `capture_setup_states_before_schedule_mutation` takes no plant parameter: one plant's upload re-derives machine state for **every** plant/machine with a setup definition, one query + transaction per machine (~3,500 sequential queries at target scale). Add a `plants=` filter derived from the upload. *(Performance, High)*

**P1-9 — `GET /setup/{plant}` and `/coverage` still do the unbounded O(states²) full-matrix fetch** — `backend/setup/data.py:656-711, 888-922`. The exact pattern `matrix-rows` was built to avoid; the frontend uses `matrix-rows` correctly, but the snapshot/coverage endpoints remain unbounded and are still called on Setup admin loads. Bound the matrix portion or drop it from the snapshot payload. *(Performance/Architecture, Med)*

**P1-10 — Login endpoint: no rate limiting, 4-char password minimum, timing-based username enumeration** — `backend/security/routes.py:19-25`, `auth.py:287-296`. Unthrottled `/security/login` + `len(raw_password) < 4` + fast-path returns for unknown usernames. Raise the minimum to 8+, add per-username/IP backoff, compute a dummy hash for unknown users. *(Security, High)*

**P1-11 — `cascade_preview` reports "0 rows affected" for role deletions that actually cascade** — `master_data.py:665-727`. No branch for `roles` (or `machine`/`workcenter_mapping`), so the confirm dialog shows zeros while `role_plants` rows are silently cascade-deleted — an admin can strip a role's entire plant scoping unknowingly. Compounded on the frontend: `admin-ui.mts:3320-3339` swallows cascade-preview fetch failures (`catch {}`) and proceeds to an ordinary confirm indistinguishable from "zero dependents." *(Data Integrity, High)*

**P1-12 — `GET /plant-calendar` fully unauthenticated** — `backend/calendars/routes.py:19-30`. Not even the spoofable-header floor. Low-sensitivity data, but add `require_authenticated` for consistency. *(Security, High)*

---

## 3. Missing / Broken Wiring

The cross-match of ~90 backend routes against every frontend call site found **no broken links in the frontend→backend direction** — every fetch targets a real route with the right method. Gaps are all backend-side or contract-level:

| Item | Location | Status | Priority |
|---|---|---|---|
| `/security/bootstrap-status` — no frontend caller, but a comment on `/security/me` asserts "the frontend calls it" | `backend/security/routes.py:28,36` | Backend exists / frontend missing, misleading comment | P2 |
| `/setup/{plant}/missing-pairs.csv` — documented in `frontend/setup/CLAUDE.md:38` as a UI caller; UI actually builds CSVs client-side | `backend/setup/routes.py:179` | Backend exists / frontend missing (doc wrong) | P3 |
| `/master-data/_audit`, `/color-wheels` (paginated) — no caller anywhere | `master_data/routes.py:94`; `priority_lists/routes.py:537` | Backend exists / frontend missing | P3 |
| Plain `/diagnostics` — superseded by `/deep` and `/db`, both wired | `admin_ops/routes.py:30` | Vestigial | P3 |
| **Type contracts:** only `backend/scheduling/routes.py` declares `response_model=`. Security, setup, and master-data routers emit `unknown` into `api-generated.d.mts` — those types are "in sync" only because there's no contract to drift from. A backend field rename in auth/config/CRUD responses is invisible to `npm run typecheck` and surfaces as a runtime `undefined` | `backend/security/routes.py`, `backend/setup/routes.py`, `backend/master_data/routes.py` | Contract gap | P2 |
| AG Grid ↔ Gantt selection sync wired via one-shot `setTimeout(…, 80)` check on `Table._api`; on a slow client it silently never wires for the session | `frontend/scheduling/gantt.mts:3934-3964` | Fragile wiring | P2 |
| Optimizer audit-log POSTs use `.catch(() => {})` — apply proceeds and shows success even when no audit record was written | `frontend/optimization/optimize-ui.mts:1775-1814` | Silent failure | P2 |
| Double-click / Enter-to-edit on Gantt orders gated behind `Modal.openEdit`/`ContextMenu.openCanvas`, which don't exist — self-documented as always-false dead branches | `frontend/scheduling/gantt.mts:2611-2624, 3444-3461` | Dead wiring (or missing feature) | P2 |
| Unsaved SAP field-mapping edits: dirty state tracked in memory with a badge, nothing intercepts tab switch/reload | `frontend/integration/sap-interface-ui.mts:540-663` | Incomplete wiring | P2 |

**Verified intentional (not flagged):** `/livez` (ACA probe), `/reload` (manual ops), `/tasks/bulk_update` (documented external/Postman alias), `/setup/{plant}/active` (documented vestigial, superseded).

---

## 4. Feature-by-Feature Audit

| Feature | UI | API | Backend | DB | End-to-end verdict |
|---|---|---|---|---|---|
| Login / session | `session.mts`, shell login screen | `/security/login`, `/security/me` | `security/routes.py` + `auth.py` | `user_security`, `user_settings` | **Implemented + Wired** — but auth is header-trust (P0-2), no login throttle (P1-10) |
| Gantt / orders scheduling + explicit save | `gantt.mts`, `orders.mts`, `persistence.mts` | `/tasks`, `/tasks/update`, `/tasks/refresh`, `/tasks/baseline-correct` | `scheduling/routes.py`, `db.py` | `orders` (xmin versioning) | **Implemented + Wired** — concurrency design sound; routes unguarded (P0-1); save/load races (P1-5/6); `/task/note` contract hole (P1-4) |
| Optimizer (incl. setup-aware, preview, sandbox) | `engine.mts`, `optimize-ui.mts`, `sandbox.mts`, `setup-scheduler.mts` | same task endpoints + `/audit/log` | — (client-side engine) | `orders` | **Implemented + Wired** — the four 2026-07 defects confirmed resolved by replacement; preview staleness gap (P1-7); sandbox doesn't restore `lastOptimize`/alert dismissals on discard |
| Setup matrix / changeover | `setup-admin.mts`, `setup-domain.mts` | `/setup/{plant}/*` (15 routes) | `setup/routes.py`, `setup/data.py` | `setup_*` tables, `signature_version` | **Implemented + Wired** — strongest domain; UI correctly uses `matrix-rows`; server snapshot/coverage still unbounded (P1-9); ingest-time state capture N+1 (P1-8) |
| Calendar / blackouts | `calendar-admin.mts`, `edit-calendar.mts`, `calendar-sync.mts` | `/plant-calendar/*` | `calendars/routes.py` | `plant_calendar*`, blackout tables | **Implemented + Wired** — stored XSS (P1-2), unauthenticated GET (P1-12), Flatpickr instance leak, line filter not synced with global `Store.selectedLines` |
| Insights / alerts / utilization | `insights-ui.mts`, `services.mts`, worker | none (off-thread compute only) | — | — | **Implemented + Wired** — heatmap XSS (P1-3); O(tasks×blocks) loops masked by the worker; capacity math duplicated in 3 places (§8) |
| Master data CRUD/DDL | `admin-ui.mts`, `admin-tables.mts`, `material-grids.mts` | `/master-data/*`, `/admin/tables/*` | `master_data/routes.py`, `master_data.py` | 9 `ALLOWED_TABLES` | **Implemented + Wired** — DDL identifier safety genuinely solid; cascade-preview gap (P1-11); stale table-switch race (P1-6); unauthenticated reads (accepted pilot posture); unscoped full `machine` fetch (§6) |
| Excel/BOM ingest + purge | `admin-ui.mts` upload flows | `/upload`, `/bom/upload`, `/purge` | `integration/routes.py`, `db.py`/`master_data.py` | `orders`, `bom_items`, `upload_audit` | **Implemented + Wired** — zero test coverage (§10); no upload size cap; per-row upsert loops; per-chunk commits mean "failed" ≠ "rolled back" |
| SAP sync | `sap-interface-ui.mts` | `/sap/interface/*` (8 routes) | `sap_sync.py` | `sap_sync_*` tables | **Partially Implemented (by design)** — full config/mapping/run plumbing wired end-to-end, but all three connectors' `extract()` return `[]`; every run reports `rows_read: 0`. A skeleton awaiting real connectors, correctly documented |
| Priority lists / color wheel | `viewers.mts`, `admin-ui.mts` | `/priority-list/*`, `/color-wheel/*` | `priority_lists/routes.py` | `priority_list`, `color_wheel` | **Implemented + Wired** — legacy color-wheel GETs skip plant scoping (§7); in-process cache breaks at >1 replica (§8) |
| Labor plan | `labor-planning.mts` | `/labor-plan`, `/labor-plan/line` | `labor/routes.py` | labor tables | **Implemented + Wired** — but zero auth (P1-1), plant-switch race, additive-only client cache never prunes server-side deletions, no loading states, big i18n gap |
| Security admin (users/roles/plants) | `security-admin.mts` | `/security/users*`, `/master-data/roles*`, `role_plants` | `security/routes.py`, `auth.py` | `user_security`, `roles`, `role_plants` | **Implemented + Wired** — last-admin lockout guard verified; unbounded plant-chip display violates scale mandate at 50+ plants |
| Admin ops / diagnostics | `admin-ops/admin-ui.mts` | `/health`, `/diagnostics/*`, `/maintenance/*`, `/logs/*` | `admin_ops/routes.py` | — | **Implemented + Wired** — lock-chain XSS (P1-3); per-table VACUUM fires with no confirmation; `/health` leaks raw DB error text unauthenticated |
| Command palette / intelligence | `nimbus-intelligence.js` | `/audit/log` | — | — | **Implemented + Wired** — entirely unlocalized, invisible to the locale-completeness test |

---

## 5. Code Quality Findings

**Bugs (beyond §2):**
- `Modal.confirm()` is not reentrant — `foundation.mts:1465-1490`. Concurrent confirms cross-fire listeners: one click can resolve both pending promises, executing an action the user never saw confirmed. P2/Med.
- Labor `_lineData` cache is merge-only — `labor-planning.mts:216-235`. Server-side-cleared overrides keep rendering and feeding exception math until full plant reselect. P2/Med.
- `SystemConfig._save` failure toast uses tone `'err'` where every other call site uses `'error'` — `admin-ops/admin-ui.mts:2807-2810`; the save-failure signal renders unstyled. P2/Med.
- Firmed-order no-op guard compares `start`/`group` but not `end` — `gantt.mts:3489-3501`; asymmetric with the non-firmed check below it. P3/Med.
- `DependencyOverlay` critical-path recursion has no cycle guard — `gantt.mts:1739-1761`; cyclic dependency data stack-overflows on every pan/zoom. P3/Med.
- Missing-key-column toast always says "no plant selected" even for non-plant-keyed tables — `admin-ui.mts:3376-3381`. P3/High.
- KPI-tile → table filter navigation relies on a blind `setTimeout(…, 120)` — `insights-ui.mts:487-522`; silently no-ops on slow first tab mount. P3/Med.
- `calendar-engine.mts:308-405`: three day-walk loops share a hardcoded 90-day cap; two of three exhaustion paths return silently with no diagnostic. P3/Med.

**Less-optimal (works, but materially better implementation exists):**
- `Engine.runAndApply` is ~250 lines interleaving four dispatch modes accumulated via dated patches — `engine.mts:1611-1862`. Extract `_runSetupAware`/`_runLegacyWalk`. P2.
- `setup-scheduler.mts` (~4,900 lines) is annotated in phase codes ("A1", "B3a", "Phase 1e") with no glossary — high archaeology cost, real reintroduction risk. Add a top-of-file glossary. P2.
- `Selection` never self-prunes against task-list changes; the only reconciliation lives in `Timeline.rebuild()`, so a user solely on the Orders tab can carry stale selection ids. P2.
- The completion-time `COALESCE(...)` formula is duplicated verbatim 3× inside one SQL statement — `backend/setup/data.py:462-498`; the codebase has already been bitten once by exactly this duplication pattern. P2.
- Flatpickr re-instantiated per cell per render, never destroyed — `calendar-admin.mts:100-101`; slow leak on repeated filter switching. P2.
- No loading/busy state during `/tasks` fetch or `saveAll()`; grid stays fully editable mid-flight, compounding the race findings. P2.
- Platform exports no shared `escapeHtml()` — at least four local `esc()`/`_esc()`/`_htmlEsc()` reimplementations; `Modal.confirm`'s `detail` is documented as raw HTML with no guardrail. Centralize. P2.
- i18n gaps cluster in: master-data delete/paste modals, Labor Planning KPI/Inputs/Capacity tabs, the entire CommandPalette (~40 strings, invisible to the locale-completeness test), Gantt hover-card labels, Optimize dialog tooltips, setup machine-state editor, SAP config UI. P2 collectively — the repo's own stated convention is being bypassed on its most-used surfaces.
- `PerfMonitor.subscribe()` returns no unsubscribe, unlike `Store`/`ErrorLog` — an API trap. P3.
- `FactoryScene` (~650 lines of decorative login-canvas code) inlined in the boot-critical `application-shell.mts`; lazy-load it. P3.

---

## 6. Performance Findings

| Finding | Location | What happens / why it matters | Worth doing |
|---|---|---|---|
| Setup-state capture scans all plants (P1-8) | `backend/setup/data.py:501-524` | ~3,500 sequential queries per single-plant upload at target scale | **Now** — small change, large win |
| Unbounded setup snapshot/coverage (P1-9) | `setup/data.py:656-711` | O(states²) rows per request at 70+ machines/plant | Now (server-side bound) |
| Per-row `cur.execute` in `bulk_apply` upserts | `master_data.py:823-910` | BOM ingest ("tens of thousands of rows") = one round-trip per row inside one transaction; timeout risk | Next — batch via `executemany`/multi-row VALUES |
| `known_material_plant_pairs()` loads the whole table per BOM upload | `master_data.py:2461-2468` | Rebuild of full cross-plant set per upload; scope to plants present in the file | Next |
| `ingest_bom_from_excel` uses `df.iterrows()` | `master_data.py:2526` | Slowest pandas iteration on the largest expected input | Later, with the batching change |
| Full unscoped `machine` table fetch to patch one line | `frontend/master-data/admin-ui.mts:3659-3671` | Direct scale-mandate violation; 3,500+ rows for a one-field edit | Next |
| Blackout-violation loop O(tasks×blocks); utilization loop O(tasks×horizon-days) | `nimbus-compute-core.js:483-513, 698-754` | Masked off-thread today; a ceiling at scale. Adjacent code already has the bucketing helper | Later — reuse `_indexCapacityBlocks` |
| Excel uploads read fully into memory, no size cap | `integration/routes.py:47,97`; `priority_lists/routes.py:331,462` | Memory exhaustion risk on oversized files (admin-gated, so bounded likelihood) | Next — cheap header check |
| VACUUM runs under the pool's 30s statement timeout | `db.py:1627-1652` | Admin maintenance fails on large tables at scale | Later |
| Auth dependency = 3 sequential DB round-trips per gated request | `auth.py:502-524` | Marginal today; consolidate to one JOIN if it lands on a hot path | Later / if profiled |
| Freeze watchdog + heap sampling run 1 Hz / 30s for every user | `app.js:513-552` | Small permanent tick cost; gate behind admin/debug | Optional |

---

## 7. Security Findings

Covered in §2: P0-1 (unguarded task routes), P0-2 (header auth + CORS `*` + hardcoded bootstrap admin), P1-1 (labor), P1-2/P1-3 (XSS), P1-10 (login hardening), P1-12 (calendar GET). Additional:

- **Admin routes inconsistently API-key-gated** — `security/routes.py`, `admin_ops/routes.py:30-246`: `/diagnostics/db` and `/logs/backend` (full structured log incl. tracebacks, slow-query text) are `require_admin`-only, while destructive siblings also require the API key. Uniform `require_api_key` when set. P2/Med.
- **Legacy color-wheel GETs skip plant scoping** — `priority_lists/routes.py:498-561`: a plant-restricted user can read other plants' priority data via the legacy endpoint even though the generic endpoint for the same data enforces scoping. P2/High.
- **`GET /master-data/{table}` fully unauthenticated** — documented, deliberate pilot posture, but any anonymous caller enumerates all master data cross-plant (incl. `roles`, `role_plants`). Require `require_authenticated` before pilot scope expands. P2/High.
- **`admin_exists()` grace period is unbounded** — `auth.py:527-536`: any state where zero admin rows exist (partial restore, migration race) leaves `require_admin` fully open to everyone, indefinitely, silently. Log loudly and continuously. P2/Med.
- **`POST /audit/log` is open and unvalidated** — `master_data/routes.py:58-64`: anyone can append arbitrary JSON (spoofed user/action, unbounded growth). P3/Med.
- **`/health` returns raw exception text unauthenticated** — `admin_ops/routes.py:36-59`: could leak internal hostnames/ports on DB failure. Redact. P3/Med.
- **Client-side password minimum mirrors the weak 4-char server rule** — `security-admin.mts:426,463` + `auth.py:287-296`. Fix server-side first. P3.
- **Latent escaping traps** — `_optTag()` label unescaped (`application-shell.mts:365-368`), `EmptyState.render()` raw interpolation (`:1520-1531`), BOM scope bar (`admin-ui.mts:2818`): safe with current callers, no contract stopping the next caller. Fold into the shared-escape-helper work. P3.

**Verified clean:** no SQL injection anywhere (all dynamic identifiers via `psycopg.sql.Identifier` or fixed literals; the f-string `WHERE` fragments in `master_data.py:1280-1543` interpolate only hardcoded strings — flagged P2 as a convention inconsistency, not a vulnerability). PBKDF2-HMAC-SHA256 @ 600k iterations with constant-time compare. `.env` excluded from git and Docker context. Non-root container. SAP secret keys never logged or returned raw. `NUMERIC` precision injection already fixed.

---

## 8. Architecture Findings

- **Single-replica assumptions vs. the scale roadmap** — `brain.py:4-7` claims stateless multi-replica readiness; the Dockerfile pins one worker *because* the priority-list cache (`backend/priority_lists/cache.py`) and `_BACKEND_LOG` ring buffer are in-process, and `POST /reload` refreshes only the calling replica. Scale-out silently reintroduces cross-replica cache staleness. Document as a hard single-replica constraint or move the cache to a shared store before scale-out. P2/High.
- **Capacity math triplicated** — `nimbus-compute-core.js:108-130` vs `platform/foundation.mts:303-326` vs `calendar-engine.mts:232-264` (`mergedOverlapHours` ×3), plus `_indexCapacityBlocks` duplicated. Byte-equivalent today; the domain doc claims delegation that doesn't exist. Any single-copy fix silently drifts worker vs. main-thread capacity. Delegate to `NimbusComputeCore` or pin with a parity test. P2/High.
- **`Sandbox.enter()` snapshot is incomplete** — `sandbox.mts:44-51`: discarding a What-If that included a trial Optimize leaves `Store.lastOptimize` and cleared alert dismissals permanently mutated. P2/Med.
- **Admin audit map is a static dict keyed by route template** — `brain.py:580-640`: new admin routes silently skip audit logging; no test cross-checks `require_admin` routes against `_ADMIN_WRITE_OPERATIONS`. Add the assertion. P3/Med.
- **`list_rows` orders by positional column luck** — `master_data.py:291-293`: self-documented in sibling functions as "only works by seed-order luck"; apply their explicit key-membership filter. P3/Med.
- **Calendar's line filter ignores the global `Store.selectedLines`** — `calendar-admin.mts:23`: inconsistent with the app-wide filter convention every other tab follows. P3.
- **Non-emitting Store setters** (`store.mts:203-266`) — correct and well-commented, but only comments enforce the exception. Informational.
- **Redundant index** — `schema.sql:1201-1202`: `idx_setup_matrix_plant_machine_version` is a strict prefix of the table's PK. P3/Low.
- **Intentional soft-FK convention verified** — `workcenter_mapping`/`color_wheel`/`priority_list` deliberately carry no FK to `plants`/`machine` (supports ingest-before-master-data ordering, explicitly commented). Not a defect; recorded so future audits don't re-flag it.

---

## 9. Dead / Orphaned Code

- Gantt double-click/Enter edit branches gated on nonexistent `Modal.openEdit`/`ContextMenu.openCanvas` — self-documented always-false. Decide: wire a real edit modal or delete. `gantt.mts:2611-2624, 3444-3461, 3805-3812`. P2.
- `Interaction.uninstall()` — never called, only reverses 4 of ~10 listener categories. `gantt.mts:2967-2974`. P3.
- `/security/bootstrap-status`, `/master-data/_audit`, `/color-wheels`, plain `/diagnostics`, dedicated `visibility-horizon` POST — uncalled endpoints (§3). P3.
- `setup_definition.active` — self-documented vestigial column. P3.
- `RemoveBacklogDiagnostics.movedRuntimeHours` — populated, never consumed by its only reader. P3.
- `COLOR_WHEEL_DIR` defaults to a hardcoded personal Windows path — `priority_lists/audit_log.py:30`. Silently degrades audit durability on any other machine. P3.
- Stale comment in `viewers.mts:252-258` claiming no identity header is sent (fetchTraced auto-attaches it). P3.
- **Stale project memory/docs:** the four 2026-07-03 setup-scheduler defects (multi-day window bypass, force-place off-by-one, SPT non-determinism, force-place/fixed overlap) are recorded as "shipped unfixed" but the `_dispatchDayIntegrity` path they lived in is fully removed — they are resolved by replacement. Update the records.

---

## 10. Testing Gaps

Ranked by value; per project convention, these are targeted additions, not new suites everywhere.

1. **`/tasks/update` real-DB xmin conflict** — no test drives two competing writes through real Postgres on the primary save path (the only real-DB stale-version test covers priority attributes on a different endpoint; `persistence.test.mjs` mocks fetch). This is NIMBUS's primary data-corruption surface and the bug class that has already fired twice. **P0-equivalent gap.**
2. **`backend/integration/` has zero coverage** — Excel ingest, BOM ingest, purge-and-replace: the widest bulk-write blast radius in the app. `tests/modules/integration/` covers only the SAP UI skeleton.
3. **Auth/RBAC has zero server-side coverage** — nothing hits `/security/login` or asserts a plant-A-scoped user can't read/write plant B. Directly relevant to P0-1/P1-1; a fix for those without a test will regress.
4. **Schema bootstrap smoke test** — apply `schema.sql` to scratch Postgres with `ON_ERROR_STOP=1`; apply `migrations/` alone and diff. Would have caught P0-3 immediately.
5. **Optimizer wall-clock regression guard** — `engine.test.mjs` verifies placement but nothing pins a time/iteration bound; the previously fixed 5–30s freeze has no guard.
6. **OpenAPI ↔ `api-generated.d.mts` CI check** — `tests/contracts/` holds one data fixture, no contract test; pairs with adding `response_model=` to the three untyped routers.
7. **Worker/main-thread capacity parity test** — pins the three `mergedOverlapHours` copies until they're consolidated (§8).
8. **Client stale-response reconciliation** — all "stale" assertions check request shape only; none prove the UI reconciles to server truth after a real 409 (the drag-spring-back failure mode).

---

## 11. Recommended Action Plan

**Fix immediately (P0 — hours, not days):**
1. Verify `NIMBUS_API_KEY` and `NIMBUS_ALLOWED_ORIGINS` are set on the live Container App (5-minute check; highest risk-reduction in this report).
2. Add `Depends(auth.require_authenticated)` to the six task routes and the four labor routes (P0-1, P1-1). This is additive and low-risk.
3. Fix `schema.sql` statement ordering + add the `orders.plant` migration (P0-3).
4. Escape the calendar blackout render path (P1-2) — a two-line fix for the one stored-XSS hole reachable by non-admin users.

**Fix next (P1 — this sprint):**
5. Thread `allowed_plants` through the task-write and labor DB paths (completes P0-1/P1-1; depends on item 2's auth identity being present).
6. `/task/note` returns fresh xmin (P1-4). Small, self-contained.
7. `saveAll()` in-flight lock + precise dirty-clearing; generation guard on `Persistence.load()`; staleness guards on master-data table switch and labor renders (P1-5/6 — all the same pattern, one concept applied four places).
8. Remaining XSS holes + export a shared `Util.escapeHtml()` and migrate the local helpers (P1-3 + latent traps, one change).
9. `cascade_preview` roles branch + frontend fail-closed on preview failure (P1-11).
10. Plant-filter `capture_setup_states_before_schedule_mutation` (P1-8).
11. Login hardening: 8-char minimum, throttling, constant-time unknown-user path (P1-10).
12. Tests 1–4 from §10 — write the RBAC test *with* items 2/5 so the fix lands guarded.

**Refactor afterward (P2):**
13. Bound the setup snapshot/coverage endpoints (P1-9) — coordinate with the frontend snapshot consumer.
14. Optimize-preview task-staleness detection (P1-7).
15. Consolidate capacity math to one implementation (or add the parity test first, then consolidate).
16. Add `response_model=` to security/setup/master-data routers + regenerate types + contract CI check.
17. `Modal.confirm` reentrancy; sandbox snapshot completeness; `Engine.runAndApply` extraction; setup-scheduler phase-code glossary.
18. Uniform `require_api_key` across all admin routes; single-replica constraint documented or cache externalized.

**Optimize afterward:**
19. Batch `bulk_apply` upserts + scope `known_material_plant_pairs` (do together — same ingest path).
20. Upload size caps; scoped machine fetch in `syncLineSettings`; compute-core loop bucketing.

**Optional cleanup (P3):**
21. i18n sweep (CommandPalette first — extend the locale-completeness test to cover it so the gap can't silently regrow), dead endpoints/branches, `COLOR_WHEEL_DIR` default, bootstrap-admin username default, redundant index, stale comments, and the stale memory/doc records about the four resolved scheduler defects.

**Dependencies worth noting:** items 2→5→12 form a chain (auth identity must exist before scoping can use it; the test should land with the fix). Item 8 (shared escape helper) should precede any further XSS point-fixes so they're done once. Item 15's parity test should precede consolidation so behavior is pinned.

---

## 12. Overall Assessment

## 🟠 Significant Technical Debt — but narrowly concentrated, with a healthy core

The engineering fundamentals are genuinely good: complete frontend↔backend wiring with zero broken links, disciplined SQL parameterization, a sound optimistic-concurrency design, careful DDL safety, correct transaction discipline in the write paths that matter, and a platform layer whose past bugs have been fixed *and stayed fixed*. Several defects this audit expected to find open were confirmed resolved. That is not the profile of a high-risk codebase.

What earns the orange rating is that the debt sits exactly where the stakes are highest: **a live, internet-reachable production pilot whose authorization is a spoofable header, whose most consequential write surface has no auth at all, whose schema cannot bootstrap a fresh environment, and whose three riskiest behaviors have zero server-side test coverage.** Every one of those has a bounded, well-understood fix — the P0 list is roughly a day of work plus one env-var verification — and the Entra migration already on the books resolves the structural half. Executing items 1–4 of the action plan moves this to 🟡 Needs Attention; landing the P1 list and the four core tests moves it to 🟢 for the pilot's scope.
