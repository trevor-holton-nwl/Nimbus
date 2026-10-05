# Order Distribution — Low-Risk Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. **Every implementation subagent is dispatched with `model: "sonnet"`.** The orchestrator (Opus) writes no code. It dispatches tasks, runs the checks, reads the diffs, and runs the final review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fix the 44 findings from `Distribution_Audit_10_01.md` that rate LOW or MEDIUM-LOW risk to change (some only partly: the safe half), and leave everything riskier for a later plan.

**Step 0 (orchestrator, before B0/F0):** copy this plan to `docs/superpowers/plans/2026-10-01-distribution-low-risk-fixes.md` in the main checkout, left untracked, so it travels with the repo.

**Architecture:** two independent tracks, each in its own git worktree and branch, so the work can run in parallel without git races:
- **Track B (backend):** Python, SQL, migrations and pytest.
- **Track F (frontend):** `.mts`, locales and node tests.

Within a track, tasks run **one at a time**, one Sonnet subagent per task. Both branches are then merged into one integration branch, and the full suites run, including all database tests against a throwaway local Postgres.

**Tech stack:** FastAPI, psycopg 3, PostgreSQL 18, vanilla TypeScript compiled by `tsc` (`.mts` → `.mjs`), node:test, pytest.

**Spec:** `Distribution_Audit_10_01.md` (repo root; finding IDs D01–D61), backed by `aggregate_to_detail.md`. Implementers read the audit row for each ID they own.

## Context

The 2026-10-01 audit found 61 problems in the Order Distribution feature. You asked for a plan covering the fixes that are low to medium-low risk. Three read-only checks then looked at each candidate's exact code, its callers and dependents, and whether a test can cover it. That moved these items out:
- **H6** (the rounding rule): it would silently change existing production sub-order quantities on the next upload.
- **D11** (stamping data onto planner-created sub-orders): it changes the shared write engine.
- **D25** (plant-keyed lookups): it touches the worker code and needs a parity check against the main thread.

Every other item was confirmed small and local, and a test can cover it. Line numbers below are from `main` at `c00ea70`. Implementers must re-locate code by function name, because `main` has moved during the day.

**Decision you made (Q&A round 1):** after purge removes a finished sub-order, an explicit **Reset** brings it back.
- Example: 1000 split A-1000/B-1000, A-1000 purged, Reset → A-1000 = 500 and B-1000 = 500 again.
- Repair and re-weight still leave purged sub-orders out.
- This matches what the next upload already does when SAP still carries the parent.
- It amends design §5.7, which says a purged sub-order is "never recreated".

## Global Constraints

- **Never touch the live database.** `.env` points at the Azure pilot. Run all work inside the worktrees, which have no `.env`; `db.py:35` and `tests/conftest.py:33` load `.env` only from their own folder. Before any Python, export the test-DB variables from Task B0. Never pass `--no-verify`.
- **Sonnet implements, Opus orchestrates.** Every Edit/Write to app code, tests or docs is made by a `model: "sonnet"` subagent.
- **Extend existing test files only, no new suites.** Use scoped test commands while a task is in progress; the full sweep runs once per track and once at integration.
- **After any `.mts` edit,** run `npm run build` before the tests.
- **UI text goes through `t()` / `data-i18n`** in all five locales (en, de, es, fr, pt), even tiny labels.
- **Plain business language in docs:** no SAP field codes, no extraction mappings.
- **Commits:** one commit per task on its track branch, made by the orchestrator at the task gate. The message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nothing is pushed, merged to `main` or deployed under this plan.
- **Don't widen scope.** If a fix turns out bigger than its spec, the subagent stops and reports. The orchestrator only escalates it to you if it needs a judgment call.

## Review Focus (inputs no task's tests would otherwise exercise; each line's test is added to the task named)

1. **Upload on a routing-enabled plant that turns a scheduled plain order into sub-orders.** Expected: the upload succeeds, the sub-orders keep the start time, and there is no double count. Covered by a database test in Task B3.
2. **Plant switch while a preview, list, summary or work-center request is still loading.** Expected: nothing from the old plant appears. Covered in Tasks F3 and F4.
3. **Purge, then Reset, then upload, on the same order.** Expected: Reset brings back the purged sub-order and clears its purged mark; the upload changes nothing further. Covered by a database test in Task B6.
4. **Bulk review running at the same time as an upload `apply()`, over the same orders.** Expected: no deadlock, because both take locks in the same database order. Covered in Task B7.
5. **What-If switched on while a preview is loading, or a write result is about to come back.** Expected: nothing is written and nothing is promoted to live. Covered in Task F2.

---

## Execution topology

```
main (c00ea70+) ──┬─ worktree C:\Users\PJ29587\nimbus-wt\dist-backend  branch fix/dist-audit-backend   Tasks B0→B9 (sequential)
                  └─ worktree C:\Users\PJ29587\nimbus-wt\dist-frontend branch fix/dist-audit-frontend  Tasks F0→F11 (sequential)
                         (tracks run in parallel; disjoint files)
then: branch fix/distribution-audit-low-risk = main + both  →  Task X1 (integration) → X2 (review) → X3 (docs)
```

The worktrees live outside OneDrive, so sync never touches `node_modules` or the Postgres data. The backend track edits only `backend/**`, `brain.py`, `db.py`, `master_data.py`, `schema.sql`, `migrations/**`, `tests/*.py` and `backend/distribution/CLAUDE.md`. The frontend track edits only `frontend/**`, `tests/modules/**`, `tests/js/**` and `frontend/distribution/CLAUDE.md`.

**Per-task gate (orchestrator):**
1. The task's scoped tests pass, and each new test was seen failing before its fix.
2. Read `git diff`: it stays inside the task's file list and contains no out-of-spec edits.
3. Commit.

There is no pause for your sign-off; you get a summary at the end.

---

## Track B — Backend

### Task B0: Isolation and a throwaway test database (orchestrator runs this; it's setup, not app code)
- [ ] `git worktree add C:\Users\PJ29587\nimbus-wt\dist-backend -b fix/dist-audit-backend main`
- [ ] Throwaway cluster (local, password-less, outside the repo): `initdb -D <scratchpad>\pg-dist -U postgres -A trust`, then `pg_ctl -D <scratchpad>\pg-dist -o "-p 55439 -c listen_addresses=127.0.0.1" -l <scratchpad>\pg-dist.log start`, then `createdb -h 127.0.0.1 -p 55439 -U postgres nimbus_test`, then `psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55439 -U postgres -d nimbus_test -f schema.sql`. The binaries are in `C:\Program Files\PostgreSQL\18\bin`.
- [ ] Test environment, exported in every backend command: `PG_HOST=127.0.0.1 PG_PORT=55439 PG_DB=nimbus_test PG_USER=postgres PG_PASS=unused NIMBUS_TEST_DB=1 NIMBUS_REQUIRE_TEST_DB=1`. The Python interpreter is the main checkout's `.venv\Scripts\python.exe`, run with the worktree as the working directory.
- [ ] Baseline: `python -m pytest tests/test_distribution.py tests/test_rbac_plant_scoping.py tests/test_master_data.py tests/test_orders_routing_ingest.py tests/test_integration_pg.py -q`. **It must run with 0 database skips**; the required-DB gate fails the run if it can't connect. Record any failure that already exists on `main` so it isn't blamed on this work.

### Task B1: Route-level guards (D10, D18, D20 cap and `reviewed`, D57)
**Files:** `brain.py` (`_error_response`), `backend/distribution/routes.py`. **Test:** `tests/test_rbac_plant_scoping.py` (TestClient with dependency overrides, the `distribution_planner_client` fixture).
- [ ] **D10:** in `_error_response`, wrap the response content in `fastapi.encoders.jsonable_encoder(...)`. New test: copy `test_distribution_shares_maps_children_scheduled_to_409_with_children_list` with `scheduled_start=datetime(2026,10,1,8)`. Assert 409, not 500, and an ISO string in `detail.children[0].scheduled_start`.
- [ ] **D18:** on `POST .../shares` (body) and on every `orders[]` item of `POST .../review` and `POST .../reset`, `base_version` must be an `int` and not a `bool`. Otherwise return `HTTPException(400, {"code": "base_version_required", "message": ...})` and reject the whole request. `reapply-defaults` stays exempt. Tests: missing, `null` and `true` give 400 on each of the three routes. The vetting check found all eight frontend call sites already send it.
- [ ] **D20 (validation part):** add one shared validator. More than 500 `orders` gives `400 {"code": "too_many_orders"}` on review, reset and reapply-defaults. On review, if `body["reviewed"]` is not a `bool`, return `400 {"code": "reviewed_required"}`; today a missing value silently un-reviews. Validate item shape (a dict with string `production_order`/`material_number`) and return 400, not 500. Tests follow `test_distribution_review_rejects_an_empty_orders_list`.
- [ ] **D57:** add an `end_of_day: bool = False` parameter to `_parse_iso_date`. With a date-only `YYYY-MM-DD` input and `end_of_day=True`, return `datetime.combine(d, time.max)`. Use it for `to` on the list and aggregate routes; `data.py` doesn't change. Test: the pure function, plus a route test that captures `date_to` via a monkeypatched `list_headers_for_plant`.
- [ ] Run `pytest tests/test_rbac_plant_scoping.py -q`, then commit `fix(distribution): structured 409 encoding, required base_version, bulk caps, inclusive to-date`.

### Task B2: Weight validation (D21, D22)
**Files:** `backend/distribution/data.py` (`_clean_weights`, `_validate_share_payload`). **Test:** `tests/test_distribution.py` (pure classes next to `TestApportion`).
- [ ] **D21:** add `_MAX_WEIGHT = 1e9`. In both validators, before the `< 0` check, raise `ValueError("weight_invalid: …")` if `not math.isfinite(float(w)) or w > _MAX_WEIGHT`. Tests: `inf`, `nan`, `1e999` and `1e10` raise; `0`, `1` and `1e9` pass.
- [ ] **D22:** at the top of the per-item loop in `_validate_share_payload`, raise `ValueError("unknown_machine: …")` if `machine not in existing_shares and machine not in current_members`, at any weight and regardless of `allow_stale`. Keep the "existing share whose machine is no longer a member" branch as the only thing `allow_stale` waives, and drop the branch that let a brand-new non-member through. Tests:
  - an unknown machine at weight 0 and at weight 5, with and without `allow_stale`, raises;
  - a current member with no share row passes;
  - a stale existing share needs `allow_stale`.
  - Also map `unknown_machine` and `weight_invalid` to 400 with the existing `_distribution_error` code pattern, and add an `err.dist_unknown_machine` / `err.dist_weight_invalid` key note for Track F (Task F10 adds the locale keys).
- [ ] Run `pytest tests/test_distribution.py -q -k "Validate or CleanWeights"`, then commit.

### Task B3: Ingest correctness (D01, D16, D03, D53)
**Files:** `backend/distribution/data.py` (`_carry_anchor_onto_new_child`, `_insert_new_header`, `_plan_core`, `reset_one_header`), `backend/distribution/service.py` (`compute_derived_statuses`, `apportion`). **Test:** `tests/test_distribution.py`.
- [ ] **D01:** in the scheduled-anchor UPDATE, add `planning_status = 'scheduled', planning_reason = NULL` to SET. Add `OR planning_status IS DISTINCT FROM 'scheduled' OR planning_reason IS NOT NULL` to the WHERE guard. Leave the `needs_planning` branch unchanged.
  - **Database test (Review Focus 1):** a variant of `TestPlanApplyAnchorCarry` that goes through `db.upsert_orders(..., plan_fn=plan, apply_fn=apply, resolve_fn=<the real resolver wiring>)`. Use a plant with `routing_runtime_enabled = TRUE` (seed pattern: `tests/test_audit_routing_db.py`) and a scheduled plain order whose work center is now distribute.
  - Assert the upload succeeds, the plain order is gone, the sub-orders exist, and no row breaks `orders_planning_state_check`.
- [ ] **D16:** on a policy-reviewed insert in `_insert_new_header`, also set `reviewed_at = now()` and `reviewed_quantity = order_quantity`. In `compute_derived_statuses`, `qty_changed` also requires `header.get("reviewed_quantity") is not None`. Tests:
  - pure: in `TestComputeDerivedStatuses`, a header that is reviewed with a NULL reviewed quantity gives no `qty_changed`; the existing `test_qty_changed` still passes;
  - database: a variant of `TestApplyPreservesReviewedAndDefaultBasis` with `review_required = FALSE`.
- [ ] **D03:** in `_plan_core`, before `_plan_one_parent`, when `existing is None and ctype == "distribute"`, compute `service.compute_default_shares(mat_attrs, wc, member_pairs)`. If no share is above 0:
  - append to `warnings["workcenter_without_members"]` an item that includes `"reason": "zero_weights"`;
  - keep the row as a plain order, using exactly the ordinary-row branch (`row = dict(row); row["plant"] = plant; rows_out.append(row); continue`).
  - In `reset_one_header`, if no default share is above 0, raise `ValueError("weights_empty: …")`. `reapply_defaults` already counts a `ValueError` as skipped.
  - Tests: pure `TestComputeDefaultShares` cases for 0/0 and blank+0; database: the plain order survives the upload and the warning is present.
- [ ] **D53:** in `apportion`, round the total to the unit first: `total = (total / unit).to_integral_value(ROUND_HALF_UP) * unit`. Handle a negative total symmetrically (`-apportion(-total, …)`); never raise, because `plan_fn` runs outside the upload's `try`. Tests in `TestApportion`: 2.3333 split three ways sums to 2.33, a single child with 1.005 gives 1.01, and −10 split 50/50 gives −5/−5. **Do not change `_quantity_unit` or the quantity rule; that is H6, which is deferred.**
- [ ] Run `pytest tests/test_distribution.py -q`, then commit.

### Task B4: Uploads stop dropping orders and warnings (D04)
**Files:** `backend/distribution/data.py` (`_dedupe_and_filter_conflicts`, `plan`, `_plan_core`), `db.py` (`upsert_orders`, around the `plan_fn` call and the `apply_fn` guard). **Tests:** `tests/test_distribution.py`, `tests/test_orders_routing_ingest.py`.
- [ ] **Narrowing:** move the duplicate/conflict rule to *after* classification and the existing-header load inside `_plan_core`. Apply it only to `(production_order, material_number)` groups where some row classifies as `distribute` or the key already has a header. Every other row passes through unchanged, in its original order. That restores the pre-distribution behavior: `upsert_orders`' id loop keeps duplicates with `_1`/`_2` suffixes and one warning. Tests:
  - order 2000 on M1 and M2, plain on a non-distributed plant: both rows reach `rows_out`;
  - the same rows on a distribute work center: still filtered, with a `conflicting_parent_rows` warning.
- [ ] **Warnings:** set `plan_structure["warnings_entry"] = _build_warnings_entry(warnings, <zero counters>)` in `plan()`. In `upsert_orders`, when no parents were planned but any warning list other than `single_rewrites` is non-empty, append `distribution_plan["warnings_entry"]`. `apply_fn` must still **not** be called when there are no parents; that is pinned by `test_apply_fn_skipped_when_plan_has_no_parents`. Use summary text that doesn't claim "0 aggregate orders distributed" when there were no parents (reuse the entry's `msg` with a no-parents variant). Test: in `tests/test_orders_routing_ingest.py`, the fake-plan pattern returns warnings with no parents, and the entry appears in the audit warnings.
- [ ] Run `pytest tests/test_distribution.py tests/test_orders_routing_ingest.py -q`, then commit.

### Task B5: Excel ingest normalization (D24, D54)
**Files:** `db.py` (`ingest_orders_from_excel`, `extract_upload_plants`). **Test:** `tests/test_setup_data.py`, using the in-memory xlsx pattern from `test_extract_upload_plants_reads_plant_column` with a monkeypatched `db.upsert_orders` that captures the rows.
- [ ] **D24:** when building the row, set `"plant": _str_id(_v(r, "PLANT")) or None`, the same way as production order and material. Also use `_str_id` in `extract_upload_plants`. Test: a numeric PLANT 1000 gives `'1000'` in the captured rows, and a float 1000.0 gives `'1000'`.
- [ ] **D54:** add a `_RUN_TIME_DEFAULTED` column computed from `pd.to_numeric(RUN_TIME, errors="coerce").isna()` before `fillna(1.0)`. Use a column, not a mask, because `dropna().reset_index()` would misalign a mask. Put `"_run_time_was_defaulted": bool(...)` into each row dict. Update the stale "not-yet-wired" docstring in `data.py`. Test: a blank RUN_TIME gives the flag True; a value gives False.
- [ ] Run `pytest tests/test_setup_data.py -q`, then commit.

### Task B6: Purge retires distribution records; Reset revives (D02, per your decision)
**Files:** `db.py` (`purge_orders_by_date`), `backend/distribution/data.py` (`_write_reweight_shares`, `reset_one_header` docstring). **Tests:** `tests/test_distribution.py` (a new class on `_ReweightFixtureBase`) and/or `tests/test_integration_pg.py` (the `isolated_purge_database` fixture).
- [ ] **Purge**, in the same transaction, after the `DELETE … RETURNING id`:
  1. `UPDATE order_distribution_share SET purged_at = now(), child_id = NULL WHERE plant = %(plant)s AND child_id = ANY(%(ids)s) RETURNING production_order, material_number`;
  2. for those keys, `DELETE FROM order_distribution` where no share has `weight > 0 AND purged_at IS NULL`. The shares cascade.
  3. Add `shares_purged` / `headers_deleted` counts to the audit JSON. The return shape is unchanged apart from these optional keys.
- [ ] **Reset brings it back:** in `_write_reweight_shares`, the upsert's SET also clears `purged_at` when the new weight is above 0: `purged_at = CASE WHEN EXCLUDED.weight > 0 THEN NULL ELSE order_distribution_share.purged_at END`, with the WHERE guard extended to `OR (EXCLUDED.weight > 0 AND order_distribution_share.purged_at IS NOT NULL)`. Re-weight still refuses a positive weight on a purged share (`share_purged`), and Repair still excludes purged shares, so in practice only Reset and reapply-defaults revive one. Update the function's docstring to say so.
- [ ] **Database test (Review Focus 3):** split 1000 into A/B and schedule both; purge A's date window; assert:
  - A's share is purged with `child_id` NULL, and the header status is `purged`, not `incomplete`;
  - Repair does not recreate A;
  - Reset recreates A-1000 at 500, B is 500, and A's `purged_at` is NULL;
  - a fully purged header is deleted, and a later upload of the parent creates a fresh header.
- [ ] Run `pytest tests/test_distribution.py tests/test_integration_pg.py -q`, then commit.

### Task B7: Write-path concurrency and audit (D19, D20 lock order, D56, D55)
**Files:** `backend/distribution/data.py` (`reset_one_header`, `reapply_defaults`, `review_orders`, `_lock_one_header`, `reweight_shares`, `_resolve_wc_codes`, `_resolve_machines`), `backend/distribution/CLAUDE.md`. **Test:** `tests/test_distribution.py`.
- [ ] **D19:** add `require_unreviewed: bool = False` to `reset_one_header`. Under the lock, if it is set and `header["reviewed"]` is true, raise `ValueError("already_reviewed: …")`. `reapply_defaults` passes `require_unreviewed=bool(only_unreviewed)` for both candidate paths, including an explicit `orders` list, and counts the skip. Database test: mark a header reviewed, then call `reapply_defaults(orders=[it])`; it is skipped and its shares are unchanged.
- [ ] **D20 lock order:** in `review_orders`, take every lock up front with one statement that uses the same database order as `apply()`: `SELECT … FROM order_distribution WHERE plant=%s AND (production_order, material_number) IN (SELECT * FROM unnest(%s::text[], %s::text[])) ORDER BY plant, production_order, material_number FOR UPDATE`. Per-item processing is unchanged. Database test (Review Focus 4): two connections review [X, Y] and [Y, X] concurrently, using threads with a barrier; both finish with no `DeadlockDetected`.
- [ ] **D56:** add a `for_update: bool = True` parameter to `_lock_one_header`. The dry-run paths in `reweight_shares` and `reset_one_header` pass `for_update=not dry_run`; every other caller keeps the default. Fix the false claim in the docstring and in `backend/distribution/CLAUDE.md` ("dry run rolls back"): the pool commits on a clean exit, and a dry run simply writes nothing. Tests: a fake cursor shows the SQL has no `FOR UPDATE` when `for_update=False`. Database test: hold `FOR UPDATE` on a second connection, and the dry run still returns.
- [ ] **D55:** write one `admin_audit` row per call for `resolve` with scope `wc_codes` (before the `apply`/commit branch) and scope `machines` (before its commit). Use the inline insert pattern from `save_workcenter`, or a small local `_insert_admin_audit(cur, table, action, details, actor)` helper used by just these two sites. Database test: count the audit rows after each scope.
- [ ] Run `pytest tests/test_distribution.py -q`, then commit.

### Task B8: Read paths and master-data search (D42, D13, D59, D27)
**Files:** `backend/distribution/data.py` (`_fetch_header_rows`, `list_headers_for_plant`, `get_summary`), `db.py` (new `_like_contains` helper), `master_data.py` (`_SEARCH_COLUMNS`, `list_rows`, `delete_filtered`), `schema.sql`, new `migrations/2026-10-01-order-distribution-plant-start-index.sql`. **Tests:** `tests/test_distribution.py`, `tests/test_master_data.py`, `tests/test_schema_idempotent.py`.
- [ ] **D42:** append `, production_order ASC, material_number ASC` to the `_fetch_header_rows` ORDER BY. Add `CREATE INDEX IF NOT EXISTS idx_order_distribution_plant_start ON order_distribution (plant, basic_start_date, reviewed, production_order, material_number);` to the new migration file (styled like `migrations/2026-09-02-*.sql`) **and** to `schema.sql` right after the existing `idx_order_distribution_wc`. Tests: a fake cursor asserts the ORDER BY text; `test_schema_idempotent` re-applies cleanly; a static check confirms the index is in both files.
- [ ] **D13:** list and summary fetch `_LIST_CANDIDATE_CAP + 1` rows, set `truncated = len(rows) > cap` and trim. They return `meta.truncated` (list) and `truncated` (summary). Update the database test `test_summary_counts_the_seeded_header_as_needs_review`, which pins the summary's exact keys. Test: monkeypatch the cap to 2 and seed 3 headers, and both routes report `truncated: true`. (Track F's Task F4 shows a notice when it is true.)
- [ ] **D59:** add `db._like_contains(s)`, which returns `"%" + s.replace("\\","\\\\").replace("%","\\%").replace("_","\\_") + "%"`, and use `ILIKE %s ESCAPE '\'` in the distribution search, `list_rows` and `delete_filtered`. Those two must keep identical predicates. Leave `master_data.py:676-683` and `backend/security/auth.py:175` alone; they are out of scope. Tests: the pure helper, plus a fake-cursor `list_rows` test showing a bound parameter of `%a\_b%`.
- [ ] **D27:** add explicit `_SEARCH_COLUMNS` entries:
  - `'sap_workcenter': ('sap_workcenter','description')`;
  - `'plants': ('plant','description')`;
  - `'machine': ('machine',)`;
  - `'material_plants': ('material_id',)`;
  - `'bom_items': ('material_id','component_id')`;
  - `'role_plants': ('role',)`.
  - Test, in `tests/test_master_data.py`: a static assertion that every `_KEY_COLUMNS` table with more than one key has a `_SEARCH_COLUMNS` entry.
- [ ] Run `pytest tests/test_distribution.py tests/test_master_data.py tests/test_schema_idempotent.py -q`, then commit.

### Task B9: Backend track wrap-up
- [ ] Sonnet updates `backend/distribution/CLAUDE.md`:
  - the new 400 codes (`base_version_required`, `too_many_orders`, `reviewed_required`, `unknown_machine`, `weight_invalid`, `weights_empty`, `already_reviewed`);
  - purge/Reset semantics;
  - dry-run locking;
  - `truncated`;
  - the new index migration.
- [ ] Orchestrator runs the full backend suite against the throwaway DB, `python -m pytest tests/ -q`, with 0 database skips. Compare against the B0 baseline. Then run `ruff check .`. Commit.

---

## Track F — Frontend

### Task F0: Isolation and baseline (orchestrator)
- [ ] `git worktree add C:\Users\PJ29587\nimbus-wt\dist-frontend -b fix/dist-audit-frontend main`, then a junction to the main checkout's `node_modules` (`mklink /J node_modules "<main>\node_modules"`).
- [ ] Baseline: `npm run build && npm test`, then `npm run typecheck`, `npm run lint`, `npm run check:legacy-surface` and `npm run check:static-assets`. Record the results.

### Task F1: Shell — stop false "unsaved", deactivate the pane off-tab (D08, D48 part 1)
**Files:** `frontend/shell/application-shell.mts`. **Test:** `tests/modules/application-shell.test.mjs`.
- [ ] **D08:** move the `'Persistence.dirty'` subscriber body into `App._trackDirty(evt)` and subscribe with `evt => App._trackDirty(evt)`. Add `'distribution'` to the skip list. Tests:
  - a `tasks:bulkUpdate` with source `'distribution'` leaves `Persistence._dirtyIds` empty;
  - a `tasks:bulkUpdate` with source `'engine-runtime-reconcile'` marks the task dirty, because a reconcile-resized bar still needs saving.
- [ ] **D48 (shell part):** in `App.goto`, when leaving `gantt` while `_ganttSub === 'distribution'`, call `DistributionPane.setActive(false)`. Test: spy `setActive`, call `goto('home')`, and assert `setActive(false)` was called.
- [ ] Run `npm run build && node --test tests/modules/application-shell.test.mjs`, then commit.

### Task F2: Pane — What-If gaps and review status (D05, D45)
**Files:** `frontend/distribution/distribution-pane.mts`. **Test:** `tests/modules/distribution/distribution-write-conflicts.test.mjs` (harness).
- [ ] **D45:** extract `_postReview(plant, header, reviewed): Promise<'ok'|'stale'|'not_found'|'error'>` from `_onReviewedToggle`, and have both it and `_markReviewed` use it. On `stale`, `_markReviewed` refetches the list and shows `toast.dist_stale_refetched`. On `not_found`/`error` it shows `toast.dist_review_failed`, never the success toast.
- [ ] **D05:**
  - put a `Sandbox.active` gate in `_postReview`, `_onSaveScheduleClick`, the `runtime_mismatch` badge branch and the banner Undo;
  - render the list Reviewed checkbox, the badge actions and the banner buttons `disabled`, with the existing `ui.dist_whatif_blocked` hint (pattern: `whatIf ? 'disabled' : ''` plus `.dist-whatif-hint`);
  - have the `sandbox:entered/exited` subscriber also call `_renderList()`.
- [ ] **Tests (Review Focus 5):**
  - with `Sandbox.active = true`, `_markReviewed`, `_onSaveScheduleClick` and the badge action make zero `fetchTraced` calls and zero `Persistence.saveAll` calls;
  - What-If switched on between a preview request and its response leaves Save disabled;
  - `_markReviewed` with `{results:[{status:'stale'}]}` shows no `toast.dist_reviewed`.
- [ ] Run `npm run build && node --test tests/modules/distribution/`, then commit.

### Task F3: Pane — preview identity, write latch, Undo, By quantity (D09, D44, D46, D35)
**Files:** `frontend/distribution/distribution-pane.mts`, `frontend/distribution/shares-editor.mts`. **Tests:** `tests/modules/distribution/distribution-pane.test.mjs` (pure), `distribution-write-conflicts.test.mjs` (harness).
- [ ] **D09:**
  - add a pure `dryRunSignature(header, rows)` to `shares-editor.mts`, returning `` `${production_order}|${material_number}|${base_version}#${weightsSignature(rows)}` ``; keep `weightsSignature` as it is;
  - in the pane, add `_invalidateDryRun()` (`_dryRunSeq++`, status idle, clear the preview and its signature) and call it at the start of `_openDetail`, in `plant:selected`, and in place of each inline idle reset;
  - use `dryRunSignature` at all four signature sites, and after the `await` in `_runDryRun` also require `_detail?.header === header`;
  - **update the harness fixture's `setup(detail, weightsSignature(...))` to `dryRunSignature(...)` in the same commit.**
  - Tests: the signature differs per order and per `base_version`; harness (Review Focus 2): start A's preview, switch to B, release A's response, and assert the status is not `'ready'` and Save stays disabled.
- [ ] **D44:** add a `_writeBusy` latch with an `_latched(fn)` wrapper that sets the Save/Reset/Undo buttons `disabled` synchronously, and clears busy in `finally` then calls `_renderDetail()`. Wrap `_onSaveClick`, `_onResetClick`, `_onUndoClick` (before it touches editor state) and `_repairRow`. The bulk handlers also check `_writeBusy`. Add `|| _writeBusy` to the render-time disabled checks. Test: two quick `_onSaveClick()` calls give one POST.
- [ ] **D46:** add a pure `undoWeightMap(prevShares, currentMachines)` that gives the previous weight, or 0 for a machine the last write added. `_onUndoClick` snapshots the editor state. `_runWritePipeline` returns `Promise<boolean>` (true only when `_finishWrite` ran); when it returns false, restore the snapshot and reschedule the preview. Tests: the pure map; harness with `Modal.confirm` resolving false leaves `_editorWeights` unchanged.
- [ ] **D35:** change the signature to `quantityToWeight(q, Q, othersWeightSum): number | 'all'`. Keep the RangeError for non-finite or negative values. `q === 0` gives 0; `q >= Q` or `othersWeightSum === 0` gives `'all'`; otherwise `q*othersWeightSum/(Q-q)`. The caller (the blur handler) passes `Q = header.order_quantity` and the other rows' `resolvedWeight` sum, and maps `'all'` to `onlyThisMachine`. Update the three existing tests to the new signature. New test: 300 of 1,000 with two other rows at weight 1 gives about 0.857 (30%). Update the "By quantity" sentence in `frontend/distribution/CLAUDE.md`.
- [ ] Run `npm run build && node --test tests/modules/distribution/`, then commit.

### Task F4: Pane and summary — stale responses, paging, filters, focus, listeners (D26, D32, D36, D47, D48 part 2, D13 notice)
**Files:** `frontend/distribution/distribution-pane.mts`, `frontend/insights/services.mts`, `frontend/setup/setup-admin.mts` and `frontend/master-data/admin-ui.mts` (combobox listener mirror only). **Tests:** `tests/modules/insights/services.test.mjs`, `tests/modules/distribution/distribution-write-conflicts.test.mjs`.
- [ ] **D26:**
  - `loadDistributionSummary` keeps a module `_summarySeq` and captures the plant, then drops the response if the seq or `Store.selectedPlant` changed. Keep today's null-on-What-If/no-plant behavior.
  - Pane: add `_listSeq` (incremented by `_fetchAndRenderList`, captured by `_fetchMoreAndAppend`) plus a plant check after each `await`.
  - The work-center fetch doesn't commit `_workcentersPlant` if the plant changed.
  - Prune `_checkedKeys` to the keys present in `_rows` after each accepted list fetch.
  - Tests: summary with a deferred fetch for A, switch to B, resolve A, and the summary is null; harness: a late list for P1 after switching to P2 is not rendered.
- [ ] **D32:** `_fetchAndRenderList` re-fetches `offset=0&limit=min((_page+1)*50, 200)` and resets `_page` to match. Test: `_page=1` gives a request with `offset=0&limit=100`.
- [ ] **D36:** add `_syncControlsFromFilters()` (search value, bucket select value, `_setDatePickerValue` for from and to, with `fire=false`), called right after `_loadFilterState()` in `render()`. Verified manually, because the harness has no DOM for the toolbar.
- [ ] **D47:** in `_renderDetail`, record the focused input's row machine and class (only if it is inside `#dist-detail-pane`; use `relatedTarget` on blur) and `.focus()` it again after re-rendering. Focus only; the inputs stay `type="number"`. Verified manually.
- [ ] **D48 (listener part):** keep a module-level AbortController in `_mkCombobox`; abort the previous one and pass `{signal}` to the document listener. Mirror the same three-line change in the deliberate copies in `setup/setup-admin.mts` and `master-data/admin-ui.mts`, so the copies don't drift.
- [ ] **D13 notice:** when the list's `meta.truncated` is true, show one line through the new `ui.dist_list_truncated` key (added in F10): "Showing the oldest 5,000 orders — narrow the filters to see the rest."
- [ ] Run `npm run build && node --test tests/modules/insights/ tests/modules/distribution/ tests/modules/master-data/ tests/modules/setup/`, then commit.

### Task F5: Orders grid — removals, new sub-orders, Override lock (D12, D29)
**Files:** `frontend/scheduling/orders.mts`. **Test:** `tests/modules/scheduling/orders.test.mjs` (the stubbed `Table._api` pattern).
- [ ] **D12:**
  - In `Table._onStore`, add a `task:remove` branch: `if (evt.prev) applyTransaction({ remove: [evt.prev] })`, then `_renderEmptyState()`.
  - In the `tasks:bulkUpdate` branch, split rows with `getRowNode(id)` into `add` and `update`, using the same plant test as `rowData`: `(t.PLANT || Store.getPlantForLine(t.MACHINE)) === Store.selectedPlant`.
  - When anything was added, call `_refreshChipDropdowns()`. The line/colour/status filters are an AG Grid external filter and apply to added rows, so the filters are not bypassed.
  - Tests: a remove event gives `{remove}`; a bulk update with an unknown id gives `{add}`; an unknown id from another plant is not added.
- [ ] **D29:** the Override dialog calls `Table._getLineOptions(t)`. `applyOverride` calls `Table._rejectDistMachineMove(t)` and returns when `t.PARENT_ORDER` is set and the line changes. Test: follows the existing "rejects a cross-machine MACHINE edit" test.
- [ ] Run `npm run build && node --test tests/modules/scheduling/orders.test.mjs`, then commit.

### Task F6: Sibling lookups and highlight (D40, D51)
**Files:** `frontend/platform/store.mts`, `frontend/scheduling/gantt.mts`, `frontend/scheduling/orders.mts`. **Tests:** `tests/modules/platform/store.test.mjs`, `tests/modules/scheduling/gantt.test.mjs`, `orders.test.mjs`.
- [ ] **D40:** add `Store.siblingsByParent(): Map<string, NimbusTask[]>`, memoized on `(this._rev, selectedPlant, tasks)` like `alertsByTask()`. Replace the five per-item scans (gantt `_itemForTask`, hover, highlight; orders cell renderer, Inspector) with `.get(parent)`. Tests:
  - the memo returns the same Map for an unchanged rev and rebuilds after an emit;
  - `removeTask` is reflected;
  - the existing pill and renderer tests still pass.
- [ ] **D51:** after `rebuild()`'s selection re-sync, reset `Interaction._distSiblingItemIds` and re-apply the highlight. `_itemPatchFor` keeps ` dist-sibling` for ids in that set. Test: next to the existing highlight test, run a highlight, then the rebuild strip, then re-apply, and the class is present.
- [ ] Run `npm run build && node --test tests/modules/platform/ tests/modules/scheduling/`, then commit.

### Task F7: Separation alerts — per-plant data, dated siblings only (D25 scoping, D50)
**Files:** `frontend/scheduling/persistence.mts`, `frontend/optimization/setup-scheduler.mts`. **Tests:** `tests/modules/scheduling/persistence.test.mjs`, `setup-scheduler` test file.
- [ ] **D25 (scoping only; plant-keyed lookup is deferred):**
  - The two plant-load paths fetch `/master-data/sap_workcenter?plant=${encodeURIComponent(plant)}`; the no-plant path sets `workcenters: []` without fetching.
  - **Required in the same change:** each of the three master-data `.then` handlers returns early when `loadGeneration !== Persistence._loadRequest`.
  - Tests: the URL includes `?plant=`; a late Plant A response after switching to B is discarded.
- [ ] **D50:** in `checkDistributionSeparation`, use `dated = group.filter(t => t.start_date)` and skip when `dated.length < 2`. Buckets are built from `dated`; severity is unchanged. Test: two scheduled siblings plus one with `start_date: null` gives no finding.
- [ ] Run `npm run build && node --test tests/modules/scheduling/ tests/modules/optimization/ && node --test tests/js/compute-core.test.js`, then commit.

### Task F8: Work Centers admin — refresh alerts, no lost autosaves (D38, D28)
**Files:** `frontend/master-data/admin-ui.mts`. **Test:** `tests/modules/master-data/admin-ui.test.mjs`.
- [ ] **D38:** after a successful `WorkCenters._write`, if `plant === Store.selectedPlant`, patch the matching `Store.masterData.workcenters` row through `Store.setMasterData({...}, 'work-centers')` and call `Alerts.scheduleRecompute()`. Use a real `import { Alerts } from '../insights/services.mjs'`; the vetting check confirmed this adds no import cycle. Test: the Store row is patched and the recompute spy is called.
- [ ] **D28:** turn `_queued` into a `Map` keyed by plant + code, so a later edit to the same work center replaces the earlier one. `_autosave` drains the map while `_saving` is still true, in try/finally, and `_saving` is cleared in `finally`. The pagehide flush is deferred. Test: with a deferred fetch, queue two codes plus a repeat; the PUTs are serialized and both codes are sent, with the latest payload.
- [ ] Run `npm run build && node --test tests/modules/master-data/`, then commit.

### Task F9: Dashboard and upload-result screens (D52, D49)
**Files:** `frontend/insights/insights-ui.mts`, `frontend/admin-ops/admin-ui.mts`, `frontend/integration/sap-interface-ui.mts`, `frontend/types/nimbus-global.d.mts`. **Tests:** `tests/modules/insights/insights-ui.test.mjs`, `tests/modules/admin-ops/admin-ui.test.mjs`, `tests/modules/integration/sap-interface-ui.test.mjs`.
- [ ] **D52:** `Dashboard.init` re-renders on `distribution:summary`, with the same 300ms debounce and home-tab gate. Extract `Dashboard._ordersTileSubtitle(tasks)`, which shows "sub-orders counted individually" only when the plant's tasks include a sub-order; use the D40 map. Point the existing tautological test at the extracted function.
- [ ] **D49:**
  - Add a local `fmt(i)` to each renderer: a string stays as it is; an object becomes `order · material · work center` (or `values.join('/')`). This fixes the "[object Object]" output.
  - The "Review N distributions" link becomes `href="#"` with a click handler `NIMBUS.App.goto('gantt'); NIMBUS.App.gotoGanttSub('distribution')`.
  - Add `gotoGanttSub?(sub: string): void` to `nimbus-global.d.mts`.
  - The SAP history server-side filter is deferred.
  - Tests: the formatter output for each warning item shape, and the click calls both navigation functions.
- [ ] Run `npm run build && node --test tests/modules/insights/ tests/modules/admin-ops/ tests/modules/integration/`, then commit.

### Task F10: Translations, hard-coded text, accessible names (D34)
**Files:** `frontend/locales/{en,de,es,fr,pt}.js`, `frontend/distribution/distribution-pane.mts`, `frontend/scheduling/gantt.mts`, `frontend/scheduling/orders.mts`, `frontend/integration/sap-interface-ui.mts`. **Test:** `tests/modules/locale-completeness.test.mjs`.
- [ ] **Add the 23 keys that are English-only to de/es/fr/pt.** Sonnet translates them in the tone of the neighbouring keys:
  - `ui.review_distributions`, `col.distribution_mode`, `col.max_separation`, `col.open_distributions`, `empty.no_work_centers`, `ph.dist_search`;
  - `btn.dist_open_workcenters`, `btn.dist_even`, `btn.dist_only_this_machine`, `btn.dist_by_quantity`, `btn.dist_by_weight`, `btn.dist_reset_defaults`, `btn.dist_undo`, `btn.dist_show_on_gantt`, `btn.dist_open_inspector`, `btn.dist_confirm_remove`, `btn.dist_save_schedule`, `btn.dist_bulk_mark_reviewed`, `btn.dist_bulk_reset`;
  - `col.description`, `col.machine`, `col.weight`, `col.effective_pct`.
- [ ] **Add to all five locales:**
  - the four keys missing even in English: `ui.conflicting_parent_rows` "Conflicting parent orders", `ui.ambiguous_plant_conflicts` "Ambiguous plant conflicts", `ui.workcenter_without_members` "Work center without members", `ui.default_machine_invalid` "Invalid default machine";
  - new keys from this plan: `ui.dist_list_truncated`, `err.dist_unknown_machine`, `err.dist_weight_invalid`, `err.dist_base_version_required`, `err.dist_too_many_orders`, `ui.dist_guard_unsaved` ("Save or reload the affected schedule edits before changing distribution."), `ui.dist_no_selection` ("No plant or order selected."), `ui.dist_bulk_status_<code>` for `ok|stale|not_found|children_scheduled|error`, `aria.dist_remove`, `aria.dist_weight_input`, `aria.dist_qty_input`, `aria.dist_select_row`.
- [ ] **Replace hard-coded English:**
  - pane: the guard toast, "No plant or order selected.", the bulk-result raw status codes (map them through `ui.dist_bulk_status_*`), and `aria-label="Remove"`;
  - pane: add `aria-label` to the weight/qty inputs and the list checkboxes;
  - pane: format the TOTAL weight with `Intl.NumberFormat(locale, {maximumFractionDigits: 3})` over the resolved weights, so an Even split shows its real total and no raw float;
  - `gantt.mts` and `orders.mts`: the "Open Order Distribution" toast button becomes the existing `btn.insp_dist_open`;
  - `sap-interface-ui.mts`: the "Review N distribution(s)" text becomes `ui.review_distributions`, and the four list labels use the four `ui.*` keys above.
- [ ] **Parity test:** in `locale-completeness.test.mjs`, derive the distribution family from `keysOf('en')` with `/^(ui|btn|toast|err|empty|ph|col|aria)\.(dist_|wc_)|^ui\.review_distributions$|^col\.(max_separation|distribution_mode|open_distributions)$|^ui\.(conflicting_parent_rows|ambiguous_plant_conflicts|workcenter_without_members|default_machine_invalid)$/` and assert every locale has every key. Check that harness tests asserting on toast text still pass, since the harness stubs `Util.t = key => key`.
- [ ] Run `npm run build && node --test tests/modules/locale-completeness.test.mjs tests/js/locale-keys.test.js tests/modules/distribution/`, then commit.

### Task F11: Frontend track wrap-up
- [ ] Sonnet updates `frontend/distribution/CLAUDE.md`:
  - the By-quantity rule;
  - preview identity;
  - the write latch;
  - the truncated notice;
  - remove the now-false sentence "no `Store.masterData.workcenters` cache exists".
- [ ] Orchestrator runs: `npm run build && npm test && npm run typecheck && npm run lint && npm run check:legacy-surface && npm run check:static-assets`. Compare against the F0 baseline (no new failures, and no new lint errors). Commit.

---

## Integration

### Task X1: Combine and run every suite (orchestrator)
- [ ] `git worktree add C:\Users\PJ29587\nimbus-wt\dist-int -b fix/distribution-audit-low-risk main`, then `git merge --no-ff fix/dist-audit-backend fix/dist-audit-frontend`. The file sets are disjoint, so no conflicts are expected; any conflict is resolved by a Sonnet subagent.
- [ ] In the integration worktree, with the throwaway DB environment: `npm run build && npm test`, then `python -m pytest tests/ -q` with **0 database skips**, then `ruff check .`, `npm run typecheck` and `npm run lint`.
- [ ] Re-run the audit's scratch probe sets against the integration worktree (`…/scratchpad/audit/{ingest,writes,reads,frontend,crossdomain}`). For every fixed ID, its probe must now **fail**, because the probes assert the buggy behaviour. Probes for deferred IDs still pass. Note any surprise.

### Task X2: Whole-branch review (Opus, read-only)
- [ ] One Opus reviewer agent with `superpowers:requesting-code-review`, scope `main...fix/distribution-audit-low-risk`. It checks the diff against this plan's specs, looks for scope creep, and checks the Global Constraints, especially i18n, live-DB safety, and the purge/Reset decision.
- [ ] Sonnet fixes any confirmed finding, one commit each; then repeat X1's suites.

### Task X3: Record the outcome
- [ ] Sonnet, in the **main checkout** and left uncommitted next to your existing uncommitted edit:
  - add a status column to `Distribution_Audit_10_01.md` (Fixed / Deferred, plus branch name);
  - append a dated "Amended 2026-10-01 (owner)" line to `aggregate_to_detail.md` §5.7, saying an explicit Reset (and reapply-defaults) revives a purged sub-order and clears its purged mark, while Repair and re-weight never do.
- [ ] Stop the throwaway Postgres (`pg_ctl … stop`). Keep the worktrees until you decide on merging.
- [ ] Report to you: what was fixed, the test results (counts), anything surprising, and the deploy note. The new index migration ships through the `promote-azure` skill **when you choose to deploy**; nothing is merged, pushed or deployed under this plan.

---

## Deliberately deferred (MEDIUM risk or higher, or needs a product decision) — for a later plan

| ID | Why not now |
|---|---|
| H6 | Changes existing production sub-order quantities on the next upload; needs a rollout note and the visible "difference from SAP" UI the owner rule requires. |
| D06, D07 | Upload versus planner race, and crash-window recovery. They change the upsert column set and Repair's scope. |
| D11 | Changes the shared write engine; `apply()` commits internally; open question about manual run time on collapse. |
| D14, D39, D60 | Moving status classification into SQL, batching `apply()`, tuple joins: performance rewrites. |
| D15 | Version tokens moving on unchanged rows. The batch-id semantics feed the batch filter and stamping. |
| D17, D23, D30, D31, D33, D43 | Locking sub-orders, the upsert run-time guard, re-uploaded sub-order numbers, undo-stack invalidation, the server-side resize flag, hours from orphans: each touches a core path. |
| D25 (plant keying), D29 (server rejection reasons), D28 (pagehide flush), D49 (server-side SAP history filter), D50 (severity alignment), D20 (one resolve per bulk call; per-item error handling), D01 (savepoint per parent) | Each is the riskier half of a split item; the safe half is in this plan. |
| D37, D58 | Need your decision: should overdue unreviewed orders be in the review queue? Should the CSV be Excel-safe or byte-exact for a future connector? |
| D41, D61 | No consumer yet (aggregate export); the default-machine combobox inside AG Grid is a larger UI change. |

---

## Appendix — Things learned along the way (not tasks in this plan, but relevant)

**Environment and process**
- **`main` moves under us.** Another session committed 10 times on 2026-10-01 (`d72d66f`…`c00ea70`), and several of those commits touched distribution: N04, N05, the H10 client half, detail-response races, and wrong-plant saves. Before X1, `git fetch`/`git log main` again, and branch the integration worktree from the *latest* `main`. If `main` changed files this plan touches, a Sonnet subagent re-applies the task on top rather than force-merging.
- **`.env` in the main checkout points at the live Azure pilot DB.** The local Postgres service on :5432 needs a password we don't have. That is why the throwaway `initdb` cluster on :55439 is used, and the worktrees have no `.env`. Don't copy one in.
- **The audit's probe tests live in the session scratchpad** (`…/scratchpad/audit/…`; 62 tests plus 3 measurement scripts). They assert the buggy behaviour, so "pass" means "bug present". Several are ready-made regression tests; port them into the existing test files rather than keeping a separate suite.
- **A pre-existing failure on `main`** (the schema-idempotent skip-set, per memory) and **46 lint warnings** exist before this work; don't attribute them to it.
- **CI gap behind most findings:** the pg-marked tests skip unless a DB is available. Recommended separately, as 09-25 C2: run them in CI against a throwaway Postgres and fail the job on skips.

**Production data this plan does not repair (needs a separate, approved, read-only-first step on the live DB)**
- **Historic purge leftovers.** The D02 fix only affects *future* purges. Shares whose sub-order was purged before the fix still point at deleted orders, read as `incomplete`, and the one-click Repair would still recreate them. Read-only check first: `order_distribution_share` rows with `child_id` NOT IN `orders.id`. A one-off fix-up would mark them purged; that is a data migration and needs your go-ahead.
- **Orders already lost to all-zero weights (D03).** The fix stops new losses but can't bring back orders already deleted. Read-only check: headers with no share where `weight > 0`.
- **Policy-reviewed headers created before the D16 fix** have no reviewed quantity. After the fix they never show "quantity changed", because they have no baseline. An optional backfill (set it to today's quantity) was not included.
- **D54 rollout effect:** on the first upload after deploy, headers whose parent had a blank run time get flagged once. That bumps their version, so a planner with that editor open gets one "stale" refresh.

**Facts the vetting checks confirmed (useful for later plans)**
- **Before distribution existed**, `upsert_orders` kept duplicate order rows and gave them `_1`/`_2` id suffixes plus one warning. D04 restores this for non-distributed rows.
- **A numeric PLANT in Excel** probably makes the whole upload fail (`text = bigint`) *before* the upload's error handling, so no failed-upload audit row is written. D24 fixes it.
- **The frontend never sends `allow_stale`**, and every planner write already sends `base_version` (8 call sites checked). That is why D18 and D22 are safe.
- **A non-finite weight on the work-center save** most likely fails the whole transaction (the audit JSON insert rejects NaN/Infinity) rather than being stored. The audit text overstated this. Also, PostgreSQL treats `NaN >= 0` as true, so the column CHECK wouldn't stop it.
- **`psycopg_pool`'s `connection()` commits on a clean exit.** "Dry run rolls back" was never true; it is harmless only because a dry run writes nothing.
- **`apply()` commits internally.** Anything that must run after it on the same connection (e.g. the deferred D11 stamping) needs its own commit or an opt-in flag on `apply()`.
- **On routing plants, `upsert_orders` blanks `run_time` on the shared row dicts** before `apply()`. New sub-orders are created with no run time, and the resolver fills it in afterwards. That is why making D01's sub-orders `scheduled` (start kept, no end yet) is the correct intermediate state.
- **Translation gap:** about 254 keys per locale are English-only, mostly predating distribution and out of scope here. Four upload-warning labels are missing even in English and currently render as raw keys (fixed in F10).
- **The combobox document-listener leak is copied deliberately** into `setup/setup-admin.mts` and `master-data/admin-ui.mts` (per `frontend/CLAUDE.md`). F4 mirrors the fix into all three copies.
- **D25 with scoping only** still leaves a brief window after a plant switch where the first alert pass can see the previous plant's work centers. The plant-keyed lookup that closes it is deferred.
- **D08 residual (intended):** after a write whose reconcile resized bars, Undo stays blocked until **Save schedule**, because those bars really are unsaved.
- **D47:** weight/qty inputs are `type="number"`, so focus can be restored after a preview re-render but the caret position can't, short of switching input types.
- **D49:** deep links (`#gantt/distribution?batch=…`) still don't exist; the fixed link opens the tab but loses the batch filter.
- **Two existing pg tests pass despite the bugs they target:** `TestApplyReplanAfterConcurrentReweight` (D06) and `TestChildUpsertRunTimeSourceGuard` (D23). Fix them along with those deferred items.
- **`separation_violated` is computed only in the browser**, so the server's Problems count leaves it out. That looks like an accepted design limit; it is not in the audit's task list.
- **`cascade_preview` for `sap_workcenter`** runs 2 COUNTs per deleted row. It is admin-only and bounded, so it is not listed as a finding.

**Open product questions surfaced (not decided here)**
- D11: when a split collapses to one machine, should a planner's *manual* run time on a partial lettered sub-order be copied onto the 100% bare order? It describes a different quantity.
- H6: the design doc says run time splits by the post-rounding *quantity* ratio, but the code splits by weights. Decide this together with the rounding rule.
- D37: should overdue unreviewed orders count in the review badge and appear in the default list?
- D58: should the CSV export be Excel-safe (prefixing formula-like cells) or byte-exact for a future connector?
- D02: reapply-defaults (the admin sweep) uses the same core as Reset, so under your decision it also revives purged sub-orders across every unreviewed header it touches. Flag it if you want the sweep to behave differently from a single Reset.

## Appendix — Context

- **Brief (verbatim):** "draw up a implementation plan from this that has LOW to medium low risk - as many as you see fit. make sure sonnet does all implementation changes."
- **Source:** `Distribution_Audit_10_01.md` (same session; 61 findings, 62 probe reproductions).
- **Vetting:** three read-only checks (ingest/purge, writes/routes, frontend) rated each candidate LOW / MEDIUM-LOW / MEDIUM+ against `c00ea70`, listing callers and test homes. They changed the plan in these ways:
  - H6 and D11 rated MEDIUM+ and were dropped;
  - D25 was split (scoping without a load-generation guard would *add* a race, so the guard is mandatory);
  - D21 was corrected: non-finite weights most likely fail the transaction rather than persist, but the 400 is still needed;
  - D24 was widened: a numeric plant may currently fail the whole upload;
  - D20's lock ordering must be done in SQL, not with Python `sorted()`;
  - D09's harness fixture must change in the same commit;
  - D47 can restore focus but not the caret position on number inputs.
- **Q&A round 1 (purge quantity):** I offered three options: match Repair (the remaining sub-orders absorb the quantity), keep the finished part out, or defer. You answered: "If it was purged, and a user resets the order, I would expect it to recreate the A-1000 order, right?" How that was applied:
  - Explicit Reset and reapply-defaults recreate A-1000 and clear its purged mark (today they recreate it but leave the mark, which would contradict the status).
  - Repair and re-weight keep leaving purged sub-orders out.
  - This matches the existing upload-revives rule (§5.2) and amends §5.7.
- **Rejected alternatives:**
  - a single shared worktree with parallel agents (risk of git index races);
  - adding new test suites (you prefer extending existing files);
  - Haiku for the simplest tasks (you asked for Sonnet for all implementation).
- **Test database:** a throwaway local Postgres 18 (`initdb` with trust auth on 127.0.0.1:55439, in the session scratchpad). It is the same approach `docs/AUDIT_REPAIRS_2026-09-30.md` used, and it means the 33 database tests that skip on this machine actually run.
