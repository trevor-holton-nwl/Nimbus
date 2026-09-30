# Independent review of the September 30 repairs

**Verdict: changes required before merge or deployment.**

Reviewed `9f21d9c..a8671f2` on `fix/audit-0930` (five commits, 39 changed files). This review traces the changed code through its callers, API payloads, Store subscriptions, cache recovery and database writes. It supersedes the earlier repair report's readiness assessment. The earlier passing tests are real, but do not cover the interactions below.

No application code was changed during this review. Findings distinguish introduced regressions from incomplete repairs; they are not a recommendation to revert every fix.

## Confirmed findings

### R1 — High: distribution hydration discards unsaved child attributes

**Location:** `frontend/distribution/distribution-pane.mts:115`, `:1030`, `:1050`.

The new canonical child decoder unconditionally takes PRT/PV values from the distribution response and assigns them onto an existing Store task. Distribution writes do not submit the planner's unsaved task attributes, and `_applyWriteResult` does not check the task's dirty state or edit generation.

**Reproduction:** keep a child with unsaved `PRT_01=LOCAL_UNSAVED_TOOL`, `PRODUCTION_VERSION=0002`; apply a successful share response containing the saved `SERVER_TOOL`/`0001`. The old implementation retains the local attributes. The new implementation replaces them with server values. Both versions install response version 42 and initially leave the task dirty. Calling actual `Persistence.saveAll` then posts local values on base but overwritten server values on head, and the success response clears dirty state in both. The dirty indicator does not protect the lost edit.

**Classification:** introduced regression. The segment-hydration repair expanded which fields an existing task loses.

**Required correction:** establish an explicit pending-edit policy for distribution writes and protect edits made during their requests. Do not blindly combine local attributes with a new server version: that can overwrite a concurrent server change. Preserve a conflict for reconciliation, or require affected edits to be resolved before the distribution write and guard later edits separately.

### R2 — High: switching plants allows material writes to commit out of order

**Location:** `frontend/master-data/material-grids.mts:337`, `:358`, `:769`.

The generation checks correctly suppress old UI responses, but the new resets of `st.saving=false` also permit another write while the first POST is still running. A navigation generation cannot cancel a database mutation already in flight.

**Reproduction:** on plant A save color red; switch A→B→A; save color blue; finish blue first, then red. The visible row is blue and Save is disabled, while the last server write is red. The older response is discarded by the generation guard, hiding the divergence. Previously the pending save flag prevented the second same-plant save.

**Classification:** introduced regression in the plant-switch repair.

**Database confirmation:** the actual `set_material_plant_attributes` writer was replayed on isolated PostgreSQL in newer-blue/older-red order. Both calls returned success and the stored color was red. This complements the actual frontend-handler proof of two pending requests; no threaded database race test is claimed.

**Required correction:** coordinate writes per plant independently of the displayed grid generation. Serialize writes or otherwise prevent overlapping writes to the same record, and reconcile the current view after outstanding writes settle. Test server commit order as well as response display order.

### R3 — Medium: a missing production version becomes an invalid edit after refresh

**Location:** `frontend/scheduling/persistence.mts:1618`; `db.py:1206`, `:1246`.

Refresh converts `PRODUCTION_VERSION=null` to `''`. The backend compares that with database `NULL` before normalizing nullable attributes, treats it as an explicit PV change, and invokes routing eligibility even for a manually timed order. A later date/tooling save can therefore fail with `pv_missing` although the planner never changed the production version.

**Reproduction:** routing-enabled plant, manual runtime 2, database PV `NULL`. Through the actual route normalizer and bulk-save implementation, base accepts snapshots containing either null or empty PV. Head accepts null but rejects empty PV with zero persisted rows and `rejection_reasons[id]='pv_missing'`.

**Classification:** introduced interaction between the expanded refresh and explicit-PV routing gate.

**Required correction:** compare canonical nullable attribute values before deciding whether a PV edit occurred. Preserve null consistently through refresh and payload generation. Add a refresh→ordinary-edit→save regression for an order without a PV.

### R4 — Medium: refresh leaves routing inputs stale and causes repeated rejection

**Location:** `db.py:815`, `frontend/scheduling/persistence.mts:1615`, `db.py:1289`.

The refreshed runtime and version are authoritative, but the quantity used by the client runtime calculator is not refreshed. Other calculation inputs, including the order's baseline date, also lie outside this refresh contract. Reloading the rate map alone cannot correct an obsolete task quantity.

**Reproduction:** a task starts at quantity 60/runtime 3. A concurrent upload changes its quantity to 120; refresh adopts runtime 6 and version 2 while leaving quantity 60. Moving it to a machine at 6 minutes/unit produces a client preview of 6 hours; the server correctly computes 12. The new `runtime_preview_changed` guard rejects the save. Its rate-map/row refresh repeats the same incomplete state, so retrying the move repeats the failure.

**Classification:** incomplete N02/N09/N11 integration; the new preview guard exposes a missing dependency in the refresh contract.

**Required correction:** refresh the complete authoritative input set needed by runtime calculation and subsequent editing, not only writable fields. Keep the task data and version from one coherent read. Cover quantity changes and baseline-date validity changes in end-to-end contract tests.

### R5 — Medium: the offered Reload recovery can restore the rejected edits

**Location:** `frontend/scheduling/persistence.mts:1350`, `:485`, `:1926`.

The new conflict warning says Reload discards local edits. `reload()` invokes `load({force:true})`, but force does not suppress cached task overlays. When routing rates change without changing the order's row version, the rejected local placement still passes the overlay's version check. Loading tasks clears the new conflict marker while restoring that placement as dirty.

**Reproduction:** server start 08:00; rejected preview followed by a newer local edit at 12:00; guarded refresh retains it as a conflict with the same row version. Invoke the real reload/cache path. The resulting task is still at 12:00, dirty=true, conflicted=false. It did not load the promised server schedule.

**Classification:** incomplete recovery introduced by the new conflict workflow; the underlying cache overlay predates this branch.

**Required correction:** provide an explicit discard-and-reload path that bypasses cached task edits and clears the corresponding cached dirty/conflict state. Preserve ordinary offline/startup restoration separately. Test recovery after a same-version rate change, not only after another order write increments its version.

### R6 — Medium: held-order recovery reads a date absent from normal task responses

**Location:** `frontend/scheduling/orders.mts:1243`; `backend/scheduling/routes.py:194`.

`_runtimeEditAnchor` falls back to `BASIC_START_DATE`. Normal `/tasks` responses expose the baseline as `original_start_date`; neither `_prepTask` nor Store normalization creates the uppercase alias. Distribution hydration and synthetic tests supply the alias, masking the difference.

**Reproduction:** decode a normal GET-shaped held task with a valid `original_start_date`, null scheduled dates and no `BASIC_START_DATE`. Successful Inspector manual-runtime, PV and machine edits produce valid durations, but `_runtimeEditAnchor` remains null and the task remains held with null dates. The new hold-release tests fabricate the uppercase field and therefore pass.

**Classification:** incomplete held-order repair. This finding does not claim the old held-order flow was correct.

**Required correction:** use the canonical API baseline field (or explicitly normalize it at one shared boundary). Replace synthetic-only coverage with actual DTO→decoder→grid/Inspector→save tests, while retaining tests for genuinely missing anchors and unrelated holds.

## Dependency and security impact

| Area traced | Assessment |
|---|---|
| External packages, lockfile, Python requirements | No dependency additions, removals or version changes in this branch. |
| Database schema, migrations, container definition | Unchanged. Fixture changes do not relax production constraints. |
| Routing calculation and scheduling | Internal contracts are affected; R3, R4 and R6 must be corrected. Material-qualified rate-map keys are consumed as opaque prefixes, so this change does not require a package upgrade. |
| Store, cache, undo/optimizer and conflict recovery | New generation checks protect several races, but R5 prevents the promised recovery for a same-version rejection. Atomic rejection retains the whole group as intended. |
| Distribution writes and canonical hydration | Pointer ordering and final child snapshots have regression coverage; R1 leaves an unsaved-edit integration gap. |
| Material grid navigation and saves | Immutable submitted patches address the original acknowledgement bug; R2 adds a distinct server ordering race. |
| Role page toggles | Partial maps, per-role serialization and pending overlays fit the existing backend merge contract. No validated new authorization bypass found in this scope. |
| Worker tooling fields and nullable runtime types | Tool-conflict fields now survive transport; nullable declarations match the API. No additional defect validated in these changes. |
| API types and SQL boundaries | Generated declarations add existing backend contracts; no new executable endpoints are introduced by that file. Changed SQL values remain parameterized. Existing plant/auth guards remain in place. |
| Deployment | No deployment occurred. Later release still requires rebuilding frontend assets and bumping the build ID; browser interaction checks remain outstanding. |

## Verification record and limitations

- The previous implementation run passed 873 JavaScript tests and 755 Python tests, with one existing skipped placeholder. Those tests cover useful cases but do not establish that these six scenarios work.
- This review reran typecheck, static-asset boundaries and the legacy-surface contract successfully against the reviewed head.
- The reviewer reran 35 focused persistence/Store/sandbox/worker tests successfully; the new counterexamples identify scenarios those tests omit.
- Independent reviewers traced routing/save, persistence/cache/worker, and distribution/material/security paths. Counterexamples use the real handlers/decoders and controlled asynchronous responses; base comparisons isolate the introduced regressions.
- Local reproduction artifacts are retained under `.superpowers/audit-0930/review-routing/`, `review-state/` and `review-distribution-ui/`. They are intentionally outside production code.
- No live database was used. Null-PV rejection and reverse-ordered material writes were confirmed against the disposable loopback PostgreSQL database with identity checks and the normal safety guard; synthetic fixtures were cleaned afterward.
- This is a review of the repair branch and its affected dependencies, not a claim that all other NIMBUS defects or installed-package vulnerabilities have been audited.

The next correction pass should address these six cases and add the missing contract/race regressions before another release-readiness decision.
