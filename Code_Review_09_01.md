# NIMBUS Strategic Review — 2026-09-01, verified and prioritized 2026-09-11

## 0. How to read this doc

**What it is.** A strategic assessment of NIMBUS's scheduling model was written on 2026-09-01 (eight themes plus an investment order). On 2026-09-11 every claim in it was checked against the live working tree and against the existing design docs, the user's direction and constraints were captured, and the result was restructured into this execution roadmap.

**Audience.** The NIMBUS owner and Claude Code. Each "Now" workstream is written to be handed straight to an implementation session: why, steps, files, acceptance, tests, risks.

**Method.** Three parallel read-only verification passes (claims 1–3; claims 4–8; existing-roadmap overlap across `docs/`, `PRODUCT.md`, and every domain `CLAUDE.md`). No code was modified, no tests were run. All `file:line` references are from the 2026-09-11 working tree; several line references in the original assessment had drifted and are corrected here.

**Legend.** Verdicts: CONFIRMED · PARTIAL · REFUTED · DECIDED (already settled by a design of record). Buckets: **Now** (weeks, schema-free, pilot hardening) · **Deferred** (held back by effort, a design decision, or the schema-redesign freeze; **none is security-gated**) · **Later / discovery** (needs a plant-side answer or an external dependency first) · **Dropped**.

**The active roadmap is Section 5 only.** Sections 6 and 7 exist so the reasoning is not lost, not as a queue.

**A note on Entra.** An earlier draft of this doc parked five items as "Entra-dependent." On reflection that was wrong: none of them needs the Entra migration for security or technical reasons. What actually holds them back is effort, missing plant data, or the owner's schema-redesign freeze, which happens to be timed to Entra. Entra would improve *who-did-it* attribution for two of them (publication ledger, shared scenarios), but the pilot already records the same spoofable identity in its upload audit, audit log, and `setup_release_evidence.ownerEmail`, and that is an accepted pilot risk. Section 6 states the real reason for each.

---

## 1. Executive summary

- The assessment's structural diagnosis is correct: NIMBUS models one order on one machine, evaluates lines independently, has no shared-resource reservation, saves rows without validating the resulting schedule, and has no server-side scenarios or multi-shift calendars.
- Most of those gaps are **already known and explicitly deferred** in the design of record (`docs/changeover_matrix.md §14`, `docs/MIGRATION.md`), and two of the assessment's themes (schedule stability, unknown-vs-zero setup) are **largely built** already. The assessment under-credited existing work.
- Three claims are **wrong or inverted**: optimizer saves are the strictest path, not a `force` bypass; lateness depth *is* scored; and the shell does not intercept browser zoom keys. The timezone claim is **correct**: `plants.timezone` exists and drives the optimizer's Remove Backlog window and setup captures, while order dates and calendar math stay browser-local. The first verification pass refuted it on the strength of a stale code comment and has been corrected.
- Given the direction (pilot plants are mostly single-operation, shared tooling is the real gap, horizon is weeks, no schema redesign before Entra), the operation/routing model is **demoted to discovery**, shared resources are **reframed as tooling on the existing model**, and this month's work is eight schema-free hardening items.
- Five larger items (tooling as a hard constraint, a publication ledger, multi-shift calendars, server-side scenarios, plant-time consistency) are **deferred by effort or design, not by security**. None needs Entra. Each carries a one-line sketch and the real reason it waits. One item first thought to need a schema change (per-plant unknown-setup policy) fits an existing unwired JSONB column and is promoted to Now as N8.
- **Decision for the owner:** the "no schema redesign until Entra" constraint was applied in the first draft to *any* schema touch. This repo treats additive nullable columns and new tables via dated idempotent migrations as routine (the `plants` table alone has about fifteen such additive columns). If additive changes are acceptable, X1, X2, and X5 lose their schema blocker and are gated only by effort and data. If the freeze covers additive changes too, they stay Deferred as written.
- The highest value-per-effort items are: fix the snapshot diff, close the two real `force` exposures, return schedule conflicts from the save path, and add a cross-line shared-tooling alert.

---

## 2. Direction and constraints (confirmed 2026-09-11)

| Question | Answer | Consequence |
|---|---|---|
| Audience | Execution roadmap for owner + Claude Code | Workstreams carry steps, files, acceptance criteria |
| Plant reality | Mostly single-operation lines; **shared tooling is the real issue** | Theme 1 (operation model) → Later / discovery. Theme 2 → tooling-as-finite-resource on the order-on-machine model |
| Horizon | **Weeks: harden the pilot** | "Now" = schema-free items only; redesigns are Deferred or Later |
| Hard constraint | **No schema redesign until Entra auth lands; Entra is some time away** | Read as: no change to existing persisted contracts (the orders row, the `work_hours` shape). Additive nullable columns and new tables are routine in this repo and are **not** assumed blocked; see the owner decision in Section 1. Nothing in this doc is gated on Entra for security reasons |

Product framing that supports these calls: `PRODUCT.md` names exactly four constraints NIMBUS holds at once (due-date, calendar, blackout, changeover), makes due dates the north star, describes the user as a plant scheduler dragging orders on a Gantt, and positions scale (50+ plants, 3,500+ lines) as the differentiator rather than modeling depth.

---

## 3. Claim verification ledger

| # | Original claim | Verdict | Evidence / correction |
|---|---|---|---|
| 1 | No operation/routing model; generated links are per-machine chains | CONFIRMED | `schema.sql:34-88` is one flat row per order with a single `machine`. Links at `backend/scheduling/routes.py:175-237` are chronological chains per machine, regenerated on every read, never persisted, `type:"0"` hardcoded. Segments (`schema.sql:102-109`) are time slices of one order on one machine with no machine column. |
| 2 | No shared tool/crew reservation; PRT influences sort only | CONFIRMED | `ScheduleSnapshot` (`frontend/optimization/setup-scheduler.mts:328-350`) has no tool pool, mold inventory, or crew roster. Evaluator loops per line (`:5204-5230`); the only cross-line coupling is the wall-clock budget. PRT fields (`:1165-1169`) feed `rankForTask` → lexicographic sort key. Labor planning warns (`frontend/labor/labor-planning.mts:842`) but never constrains. Only physical-tool column anywhere: `line_setup_state.physical_mold_id`. |
| 3a | Save validates rows, not the resulting schedule | CONFIRMED | `db.py:889-1075` (`update_task_dates_bulk`) checks ranges, segment shape, xmin, plant scope per row. No cross-order overlap or calendar-feasibility check server-side. Overlap detection is client-only (`frontend/insights/services.mts`, `Core.computeAlerts` in `nimbus-compute-core.js`). Same-instant overlaps are intentional (`frontend/scheduling/persistence.mts:754-758`). |
| 3b | Optimizer saves bypass version conflicts via `force` | **REFUTED (inverted)** | Optimizer saves set `force:false, atomic_optimizer:true` (`persistence.mts:1315-1330`); `db.py:1004-1008` ignores `force` under `atomic_optimizer` and rolls back the whole batch on any stale row. The **real** exposures are `Config.CONCURRENCY_CHECK` (`frontend/platform/foundation.mts:143`, a documented last-write-wins kill-switch) and `POST /tasks/bulk_update` (`routes.py:453-459` region) which honors an external `force:true` without `atomic_optimizer`. |
| 4a | Configured priority tiers can outrank lateness | CONFIRMED except `due-date` mode | `compareCandidate` (`setup-scheduler.mts:2372-2424`, not 1836): `policyKey` at `:2392` precedes lateness at `:2420`. `compareDueDateCandidate` (`:2352-2370`) inverts this. The per-plant choice already exists. |
| 4b | Protecting late-order *count* does not protect already-late orders | **REFUTED as stated** | `latenessMinutes` is compared immediately after `lateCount` (`:2357-2360`, `:2420`). The narrower true gap: no per-order max-lateness term, and lateness is unweighted. |
| 4c | No schedule-stability term | PARTIAL | `ObjectiveFacts.instabilityMinutes` exists (`:375`, Σ\|Δstart\| at `:6576`) and is in every mode's list, but only as the second-to-last tie-break and **hardcoded to 0 in `fragmentObjectiveFacts` (`:6483`)**, so it is inert during fragment search. No sequence-disruption or machine-reassignment term. The stability *policy* itself shipped (`docs/superpowers/specs/2026-08-18-optimizer-reason-codes-stability-design.md`). |
| 4d | No business-weighted lateness | CONFIRMED | Zero `weight` occurrences in `setup-scheduler.mts` or `engine.mts`. |
| 4e | CP-SAT worth benchmarking | DECIDED (excluded) | `docs/changeover_matrix.md:489` and `docs/archive/changeover_matrix_stage_2.md:35` list a global mathematical solver under explicitly deferred/excluded. |
| 5 | Missing transitions and unknown initial states admitted at zero setup minutes | CONFIRMED and DECIDED | `setup-scheduler.mts:2514-2571`: unknown state → `unknownInitialStateEdge`, minutes 0; known signatures with no row → `uncoveredEdgeCount`, explanation `admitted-without-setup`, minutes 0. Covered alternatives preferred (`:1941-1948`; `SCORE_UNCOVERED` tier). Known-zero (`source:'implicit-zero'`, `frontend/setup/setup-domain.mts:395-405`) is already distinct from uncovered (`:304-313`). This is the approved 2026-08-18 never-freeze decision. No prohibited-transition concept exists. |
| 6 | SAP connectors return empty; no execution feedback | CONFIRMED | `backend/integration/sap_sync.py:326-391`: all connectors `return []`, `test_connection` reports stub. No confirmations object in `SAP_OBJECTS`. Direction is read-only from SAP by decision (`docs/SAP_INTEGRATION_ROADMAP.md`). A `source:'actual'` seam is reserved (`docs/changeover_matrix.md:164`). |
| 7a | Snapshot diff misses finish-only and split-segment changes | CONFIRMED | `Diff.compute` (`frontend/nimbus-intelligence.js:2107-2131`) compares only `start_date` delta and `MACHINE`. `end_date` is enriched (`:2097`) but never compared; segments are not in the enriched shape. |
| 7b | Shell intercepts browser zoom shortcuts | **REFUTED** | No ctrl/meta handlers for `+ - = 0` in `frontend/shell/` or `app.js`. Only vis-timeline's `zoomKey:'ctrlKey'` (`frontend/scheduling/gantt.mts:285`) captures Ctrl+wheel while over the Gantt canvas, which is standard timeline behavior. |
| 8a | Snapshots live only in browser IndexedDB | CONFIRMED | `indexedDB.open('nimbus-intel', 1)` (`nimbus-intelligence.js:352-362`) with `snapshots`/`scenarios`/`patterns` stores. No server table or route. |
| 8b | Calendar model is one working interval per weekday | CONFIRMED | `WorkHours = Record<number,[number,number]\|null>` (`frontend/platform/types.mts:118`), mirrored in `schema.sql:725-752` for `plants.work_hours` and `machine_calendar.work_hours`. No multi-shift or overnight representation. |
| 8c | Scheduling mixes plant-aware and browser-local time math | CONFIRMED (an earlier draft of this doc wrongly refuted it) | `plants.timezone` exists (`schema.sql:150,165`) and **is** consumed: the optimizer's Remove Backlog window (`frontend/optimization/engine.mts:616-636`, `:1914-1926`, which throws without a plant timezone), the dashboard's plant-hour (`frontend/insights/insights-ui.mts:563`), and backend setup-state captures (`backend/setup/data.py:434-445`, `:510-527`). Meanwhile order dates are wire-encoded naive browser-local via `Util.toLocalSeconds` (`persistence.mts:1015-1314`) and the calendar engine runs in browser-local time. That is exactly the mix the assessment described. The `store.mts:825-829` comment ("NO plants timezone column yet") is stale; it concerns per-plant *user-setting* regional defaults, not the column. MIGRATION.md's "do not unify the two time schemes" decision (`:892-913`) is the design constraint any fix must respect. |

---

## 4. Priority matrix

| Bucket | Item | Theme | Impact | Effort | Schema | Blocker |
|---|---|---|---|---|---|---|
| **Now** | N1 Snapshot diff correctness | 7a | High (trust in comparisons) | S | none | — |
| **Now** | N2 Close the two real `force` exposures | 3b | High (data integrity) | S | none | — |
| **Now** | N3 Return schedule conflicts from the save path | 3a | High | M | none | — |
| **Now** | N4 Cross-line shared-tooling conflict alert | 2 | High (the user's stated gap) | M | none | Confirm `PRT_01` identifies a physical tool |
| **Now** | N5 Objective tuning, cheap slice | 4b/4c/4a | Medium | M | none | — |
| **Now** | N6 Split unknown-setup diagnostics | 5 | Medium | S | none | — |
| **Now** | N7 Surface what is already built | 7 | Medium | S–M | none | — |
| **Now** | N8 Per-plant unknown-setup placement policy (promoted from X3) | 5 | Medium | M | none (existing `plants.setup_policy_config` JSONB, currently unwired) | N6 first |
| **Deferred** | X1 Tooling as optimizer admission constraint + tool catalog | 2 | High | L | additive new table | Effort; N4 must confirm `PRT_01` is a physical tool; no material→line eligibility data. Not Entra |
| **Deferred** | X2 Publication step with published-revision ledger | 3 | High | L | additive new table | Effort; N3 first. Attribution is at pilot identity trust, same as existing audit logs. Entra improves it, does not block it |
| **Deferred** | X4a Plant-time consistency for remote schedulers | 8c | Medium | M–L | none (column exists) | Design: must honor MIGRATION.md's "do not unify the two time schemes"; decide which paths become plant-aware. Not Entra |
| **Deferred** | X4b Multi-shift and overnight `WorkHours` | 8b | Medium–High | L | contract redesign (JSONB shape, backend + worker mirror) | The one item the schema-redesign freeze genuinely covers. Not Entra |
| **Deferred** | X5 Server-side named scenarios | 8a | Medium | L | additive new table | Effort and unproven demand; same attribution note as X2. Not Entra |
| **Later** | L1 Operation/routing model | 1 | Unknown for pilot plants | XL | yes | PP discovery |
| **Later** | L2 SAP execution feedback | 6 | High once live | L | yes | Live SAP connector; read-only decision |
| **Later** | L3 Crew as a finite resource | 2 | Medium | L | likely | `labor_plan_line` integration design |
| **Later** | L4 Business-weighted lateness | 4d | Medium | M | maybe | Needs a weight source; tier-weighting is a cheap proxy |
| **Dropped** | Zoom-shortcut interception | 7b | — | — | — | Refuted |
| **Dropped** | CP-SAT benchmark | 4e | — | — | — | Excluded by design of record |

---

## 5. Workstreams — Now (weeks, schema-free)

### N1 · Snapshot diff correctness

**Why.** Time Machine and What-If comparisons silently miss any change that keeps the start time and machine fixed: a duration change, a finish-only shift, or a split-order re-segmentation. Schedulers reading "no changes" will trust a comparison that is wrong.

**Steps.**
1. In `Diff._enrich` (`frontend/nimbus-intelligence.js:2092-2105`) carry `scheduleSegments` (normalize to `[[startMs,endMs],…]`, empty array when absent).
2. In `Diff.compute` (`:2107-2131`) add `endDelta = end_date(B) − end_date(A)` and `segmentsChanged = !sameSegments(A,B)`. Treat a row as changed when any of start delta, end delta, machine change, or segments change is non-zero.
3. Attach a `kinds` array per moved row: `'start' | 'finish' | 'machine' | 'split'`, and sort by the larger of |start delta| and |end delta|.
4. Update the diff renderer to show the kind badges and the finish delta alongside the start delta. Route any new badge text through `data-i18n`/`Util.t()` with keys in `frontend/locales/`.
5. Keep `lineImpact` (`:2134+`) semantics unchanged except that finish-only and split changes now count as changes.

**Files.** `frontend/nimbus-intelligence.js` (Diff object and its renderer); `frontend/locales/*.json` for new badge keys.

**Acceptance.** Two snapshots that differ only in `end_date` report one moved row of kind `finish`. Two snapshots identical except segment boundaries report kind `split`. Existing start/machine cases unchanged.

**Tests.** Extend the existing intelligence tests under `tests/js/` with three cases (finish-only, split-only, unchanged). No new suite.

**Risks.** Snapshots persisted before this change have no `scheduleSegments`; treat a missing array as "unknown, not changed" so old snapshots do not all light up as split changes.

---

### N2 · Close the two real `force` exposures

**Why.** The assessment blamed the optimizer, but the optimizer is the strict path. The genuine last-write-wins doors are the client kill-switch and the external flat-list route. Either can overwrite another planner's edits without a `stale` signal.

**Steps.**
1. In `POST /tasks/bulk_update` (`backend/scheduling/routes.py`, the flat-list alias after `tasks_update`): stop honoring a caller-supplied `force`. Either strip `force` before calling `_apply_task_date_updates`, or require `require_api_key` for any payload containing `force:true`, and log the caller through `_log_event`.
2. In `_apply_task_date_updates`, add a warn-level `_log_event` whenever a row is written with `force=True` and `atomic_optimizer=False`, including the request id, so forced writes are auditable in the `_BACKEND_LOG` ring buffer.
3. On the client, when `Config.CONCURRENCY_CHECK` is false, log once via `ErrorLog` at boot and show a persistent banner or toast so nobody runs the pilot in last-write-wins mode unknowingly. Do not remove the switch; it is a documented escape hatch.
4. Correct `backend/scheduling/CLAUDE.md`'s "Key invariants" bullet, which still says `force=True` is set by the optimizer's bulk reschedules. It is not; the optimizer uses `atomic_optimizer`.

**Files.** `backend/scheduling/routes.py`; `frontend/platform/foundation.mts` or the boot path in `frontend/shell/`; `backend/scheduling/CLAUDE.md`.

**Acceptance.** A `bulk_update` payload with `force:true` and a stale `base_version` returns that id in `stale` and does not write (or is rejected without an API key). A forced write from any path leaves a log line with the request id. Running with `CONCURRENCY_CHECK=false` is visibly flagged in the UI.

**Tests.** Add one route test alongside the existing concurrency tests in `tests/test_task_concurrency.py` (Postgres-gated) or a mocked variant next to `tests/test_task_response_models.py`. Repair-only scope.

**Risks.** Any external tooling relying on `bulk_update` + `force` breaks. Search the repo and `scripts/` for callers first; the alias comment says "external tooling" without naming any.

---

### N3 · Return schedule conflicts from the save path

**Why.** Two planners can each pass their own xmin check and jointly produce an overlapping machine. Today only the client that happens to recompute Alerts sees it. The server already holds every affected row inside one transaction and can report the resulting overlaps cheaply.

**Steps.**
1. After the row updates in `db.update_task_dates_bulk` (`db.py:889-1075`) and before commit, collect the distinct machines touched. For each, select scheduled orders on that machine (parent envelope, or segments where present) within the touched time range ±1 day and detect pairwise overlaps in SQL or Python.
2. Return `conflicts: [{machine, order_a, order_b, overlap_minutes}]` in the result dict. Extend `BulkUpdateResult` and `TaskUpdateResult` in `backend/scheduling/models.py` with an optional `conflicts` list (default empty) so the `response_model` does not drop it.
3. Default behavior is **advisory**: commit and report. Add an opt-in `strict_conflicts: true` payload flag, honored only together with `atomic_optimizer`, that rolls back if `conflicts` is non-empty. Same-instant overlaps from raw SAP midnight snaps are intentional (`persistence.mts:754-758`); do not make strict mode the default for manual saves.
4. In `frontend/scheduling/persistence.mts` `saveAll`, read `conflicts` from the response; if non-empty, toast a count and call `Alerts.scheduleRecomputeLines` for the affected lines so the existing overlap alerts appear immediately.
5. Log conflict counts through `_log_event` for pilot observability.

**Files.** `db.py`; `backend/scheduling/models.py`; `backend/scheduling/routes.py` (pass-through); `frontend/scheduling/persistence.mts`; `frontend/platform/types.mts` for the response type.

**Acceptance.** Saving order B into a slot already held by order A on the same machine returns `conflicts` naming A and B with a positive overlap. With `strict_conflicts` and `atomic_optimizer`, the same save rolls back with `status:'error'` inside a 200, per the never-4xx contract. Manual saves are never blocked.

**Tests.** One Postgres-gated case in `tests/test_task_concurrency.py`; one pure-logic test for the overlap helper if it is extracted as a function.

**Risks.** Query cost on large machines: bound the window to the touched range, and index use on `(machine, scheduled_start)` should already exist; verify with `EXPLAIN` before shipping. Keep the never-4xx contract.

---

### N4 · Cross-line shared-tooling conflict alert

**Why.** This is the user's stated real gap. Two individually feasible line schedules can require the same physical mold at the same time. NIMBUS cannot reserve tooling yet, but it can *see* the collision with data it already has and tell the scheduler.

**Steps.**
1. **Validate the assumption first**: confirm with the pilot plant that `PRT_01` (or `PRT_02`) on an order identifies a unique physical tool, not a tool type with multiple copies. If it is a type, this alert needs a quantity and becomes X1. Record the answer in this doc.
2. Add an `alerts` rule `tool-conflict` in `Core.computeAlerts` (`frontend/nimbus-compute-core.js`, the shared logic behind both the worker and the sync fallback): group scheduled orders in the selected plant by tool id, sort by start, and flag any pair on **different** machines whose intervals overlap. Same-machine adjacency is a changeover, not a conflict.
3. Mirror any type additions in `nimbus-compute-core.d.ts`, and extend the alert type union in `frontend/platform/types.mts`.
4. Add a fix affordance in `Alerts.applyFix` (`frontend/insights/services.mts:394+`): reuse the existing overlap path (search from the peer's end on the same line) so the later order slides right on its own line.
5. Add i18n strings for the alert title/description. Filter by the global line filter like the other rules.

**Files.** `frontend/nimbus-compute-core.js` + `.d.ts`; `frontend/insights/services.mts`; `frontend/platform/types.mts`; `frontend/locales/*.json`.

**Acceptance.** Two orders with the same tool id, overlapping in time, on different lines in one plant produce one `tool-conflict` alert; the same pair on one line produces none; applying the fix moves the later order to the next available slot on its own line.

**Tests.** Extend `tests/js/compute-core.test.js` parity pins with two cases (conflict, same-line non-conflict). No new suite.

**Risks.** Blank or placeholder tool ids must be skipped, otherwise every untooled order collides with every other. Scale: grouping by tool id within one plant is O(n log n), fine for 70 machines.

---

### N5 · Objective tuning, cheap slice

**Why.** The stability term exists but is inert where it matters, already-late orders have no protection against becoming *much* later, and the priority-vs-lateness question is already answerable by mode selection. None of these need a new solver.

**Steps.**
1. In `fragmentObjectiveFacts` (`setup-scheduler.mts:6483`) compute `instabilityMinutes` from the fragment's own tasks instead of hardcoding 0, or leave a comment explaining why fragment-level instability is intentionally ignored. Measure the runtime effect against the deadline-bound search budget before keeping it.
2. Add `maxLatenessMinutes` (largest single-order lateness) to `ObjectiveFacts` (`:375`) and place it immediately after `latenessMinutes` in every mode's comparison list (`:6510-6533`) and in `compareCandidate`/`compareDueDateCandidate`.
3. Document in `frontend/optimization/CLAUDE.md` and the Optimize dialog hint text that `due-date` mode ranks lateness ahead of configured priority tiers, and the other modes do the reverse. This is the per-plant tradeoff the assessment asked for; it already exists.
4. Defer weighted lateness (L4). If a cheap proxy is wanted later, weight `latenessMinutes` by the order's policy tier rank; no new data required.

**Files.** `frontend/optimization/setup-scheduler.mts`; `frontend/optimization/CLAUDE.md`; Optimize dialog hint in `frontend/optimization/optimize-ui.mts` with an i18n key.

**Acceptance.** Two candidates with equal late count and equal total lateness but different worst-case lateness prefer the smaller worst case. Fragment search no longer reports 0 instability when starts moved. No change to the five pre-existing test failures noted in the repo (they reproduce identically before and after).

**Tests.** Extend `tests/modules/setup-scheduler.test.mjs` with one comparator case per new term. Repair-only scope; run that file, not the full sweep.

**Risks.** Any comparator change can reorder existing golden outputs. Run the scheduler test file before and after and diff failures rather than asserting from memory.

---

### N6 · Split unknown-setup diagnostics

**Why.** Two different situations currently produce the same "charged zero setup minutes" story: the machine's initial state is unknown, or both states are known but no matrix row exists. The remedy differs (record the line's state vs. fill a matrix cell), so the message should too.

**Steps.**
1. In the admission block (`setup-scheduler.mts:2514-2571`) emit distinct explanation codes: `admitted-unknown-state` and `admitted-uncovered-row` (keep `admitted-without-setup` as the legacy alias for one release).
2. Carry the distinction into the missing-setup CSV and the "Review missing setups" action in the setup admin UI so the two lists can be filtered separately.
3. Update the preview's amber bucket copy to name the remedy per code.

**Files.** `frontend/optimization/setup-scheduler.mts`; `frontend/setup/setup-admin.mts` (CSV/review action); `frontend/optimization/optimize-ui.mts` copy; locales.

**Acceptance.** A run with one unknown-state edge and one uncovered edge shows two different codes in diagnostics and two filterable rows in the review list.

**Tests.** Extend the existing setup-scheduler explanation tests with one case each. The per-plant *policy* for how unknowns place is N8.

---

### N7 · Surface what is already built

**Why.** NIMBUS's own APO gap analysis (`docs/SAP_APO_Opportunities.md`) already notes that reason codes shipped, the `needs_planning` queue exists in data, and the Ripple Preview overlay is fully built but permanently disabled. The assessment asked for an exception worklist and before/after views. Most of that is a discoverability problem, not a build problem.

**Steps.**
1. Expose the `planning_status='needs_planning'` rows (with `planning_reason`) as a ranked worklist in the existing Alerts panel or the Orders grid filter, linked to the Gantt and Inspector. Reuse the grid; do not add a new tab.
2. Decide on Ripple Preview: re-enable behind a user setting, or delete the dead code. Record the decision here.
3. Only after N1 and N3 land, evaluate whether an "affected orders before/after" table is still needed or whether the corrected snapshot diff plus save-time conflicts already answer it.

**Files.** `frontend/insights/insights-ui.mts`; `frontend/scheduling/orders.mts`; `frontend/nimbus-intelligence.js` (Ripple Preview).

**Acceptance.** A scheduler can list every `needs_planning` order for the selected plant, see its reason, and jump to it on the Gantt in two clicks.

**Risks.** Lean scope: do not build an affected-orders table or resource-conflict explainer until the surfaced items are used and found insufficient.

---

### N8 · Per-plant unknown-setup placement policy (promoted from the deferred list)

**Why.** Today every plant gets the same treatment for an unknown setup: admit at zero minutes, tail-place, alert. The assessment's one genuinely new idea in theme 5 was letting each plant choose. An earlier draft of this doc deferred it as needing a new column. It does not: `plants.setup_policy_config` (`schema.sql:268-269`) is a per-plant JSONB policy sidecar created for exactly this class of optimizer policy, and no runtime code reads or writes it yet.

**Steps.**
1. After N6 lands, add `unknownSetupPolicy: 'zero' | 'plantDefaultMinutes' | 'excludeFromSearch'` plus `unknownSetupDefaultMinutes` to the `setup_policy_config` JSON shape, defaulting to `zero` so every existing plant keeps today's behavior.
2. Add a validated write route beside the existing per-plant policy routes in `master_data.py` (pattern: `POST /master-data/plants/{plant}/split-order-policy` and `.../frozen-horizon-days`), and read the value into `Store.masterData.plants[*]` with the other plant fields.
3. Consume it in the admission block at `setup-scheduler.mts:2514-2571`: `zero` unchanged; `plantDefaultMinutes` charges the configured minutes and keeps the `admitted-unknown-state` / `admitted-uncovered-row` code from N6; `excludeFromSearch` routes the order to the `needs_planning` queue with a `planning_reason` naming the missing transition.
4. Expose the three choices in the plant's setup admin page as a dropdown with a hint line, per the repo's uncluttered-modal convention. i18n all strings.

**Files.** `master_data.py` (read/write); `backend/master_data/routes.py`; `frontend/setup/setup-admin.mts`; `frontend/optimization/setup-scheduler.mts`; `frontend/platform/types.mts` (`NimbusMasterPlant`).

**Acceptance.** With `plantDefaultMinutes: 45`, an uncovered edge charges 45 minutes in the preview and the diagnostics still show the N6 code. With `excludeFromSearch`, the order lands in the `needs_planning` list with a readable reason. With `zero`, output is byte-identical to today.

**Tests.** One mocked-pool route test next to `tests/test_master_data_setup_policy.py`; one scheduler case per policy value in `tests/modules/setup-scheduler.test.mjs`.

**Risks.** The never-freeze decision of 2026-08-18 must survive: `excludeFromSearch` queues the order, it never freezes the line. Existing JSONB defaults hold `version: 1`; bump to 2 and read either.

---

## 6. Deferred — by effort or design, not by Entra

**Status: not planned, and not security-gated.** An earlier draft parked these five items as Entra-dependent. That was a mistake in reasoning: the owner's schema-redesign freeze is *timed* to Entra, but none of these items needs Entra to be safe or correct. Three of them need only an additive table, which this repo ships routinely through dated idempotent migrations. One (X4b) is a genuine contract redesign and is the only item the freeze really covers. Two (X2, X5) would record who did something, and that attribution would be exactly as trustworthy as the pilot's existing upload audit and audit log, which is an accepted risk today. The sketches are kept so the reasoning survives.

**Revisit trigger:** a Now item exposes the need (N3 conflicts prove insufficient → X2; N4 alerts fire often → X1; remote schedulers join the pilot → X4a), or the owner lifts the freeze for additive changes.

| ID | Item | Why it is deferred (real reason) | Entra relevance | Sketch (for the record) | Schema touch |
|---|---|---|---|---|---|
| X1 | Tooling as an optimizer admission constraint | Large effort (cross-line coupling breaks the per-line evaluator); no material→line eligibility data exists (`docs/MIGRATION.md:847`); `PRT_01` semantics unconfirmed until N4 | None | Tool catalog per plant (id, quantity, eligible machines). Add a plant-scoped tool reservation map to `ScheduleSnapshot`; admission rejects a placement when all copies are busy. This introduces cross-line coupling, so partition the evaluator by tool-connected machine groups rather than per line. Prior art: `docs/changeover_matrix.md §14`, `docs/MIGRATION.md:847,851`. | New `plant_tools` table; optional FK from `line_setup_state.physical_mold_id` |
| X2 | Publication step with revision ledger | Large effort; should wait until N3's advisory conflicts prove insufficient. A draft-vs-published distinction changes the scheduler's workflow and needs plant buy-in | Improves "who published" attribution; today it would record the same spoofable `X-User` the audit log already records. Not a blocker | `POST /schedule/publish` runs the N3 conflict check in strict mode across the plant, checks the proposal's baseline `readModelVersion` against current, commits atomically, and writes a `schedule_revisions` row (plant, user, baseline, resulting versions). Drafts stay flexible; "published" gains meaning. | New `schedule_revisions` table |
| X3 | Per-plant unknown-setup placement policy | **Promoted to N8.** Fits the existing unwired `plants.setup_policy_config` JSONB; no schema change | None | See N8 | none |
| X4a | Plant-time consistency for remote schedulers | Design decision first: `docs/MIGRATION.md:892-913` says the naive-local order scheme and the UTC blackout scheme are deliberately separate and must not be unified. Deciding which paths become plant-aware (display only? calendar math? wire encoding?) is the work; the `plants.timezone` column already exists and the optimizer already uses it | None | Inventory the `Util.toLocalSeconds` sites (`persistence.mts:1015-1314`) and the calendar engine's day boundaries; choose display-only projection through `plants.timezone` first (lowest risk), reusing `Engine._plantWallNow`. Fix the stale `store.mts:825-829` comment while there. Resolve the historical-offset repair in the same window | none |
| X4b | Multi-shift and overnight `WorkHours` | The one item the schema-redesign freeze genuinely covers: `WorkHours` changes shape from one `[open,close]` pair per weekday to a list with overnight wrap, mirrored in `schema.sql:725-752`, `calendar-engine.mts`, `nimbus-compute-core.js`, and every capacity test | None | Change `WorkHours` to `Record<day, Array<[start,end]>>`; write a one-time JSONB data migration wrapping existing pairs; update the calendar UI's day editor; re-pin `tests/js/compute-core.test.js` parity | JSONB shape change (contract redesign) |
| X5 | Server-side named scenarios | Large effort against unproven demand; the browser-local Time Machine and What-If cover single-scheduler use. Wait for a second scheduler per plant to ask for shared scenarios | Improves owner attribution only; same note as X2 | Persist the IndexedDB `snapshots`/`scenarios` stores server-side per plant with a constraint snapshot (calendars, blackouts, setup snapshot version) so a scenario can be refreshed against changed data before adoption. Reuse the N1 diff for comparison. | New `scenarios` table |

---

## 7. Later / discovery

**L1 · Operation/routing model.** The pilot plants are mostly single-operation, so this is not a live gap. Before any design work, run a discovery with production planning: for each pilot and next-wave plant, how many SAP operations per order actually need independent scheduling in NIMBUS, and do any have min/max time relationships (cooling, holding)? If the answer stays "one", record that here and close the theme. If not, the design must replace the atomic-order assumption in ingest (`routes.py:175-237`), the optimizer, and split-order segments together; it cannot be added incrementally.

**L2 · SAP execution feedback.** Blocked on a live connector (`sap_sync.py` is a stub) and on the read-only-from-SAP decision. The `source:'actual'` seam in the setup domain is the intended landing point. The "machine failed at 10:15, propose the smallest repair" workflow depends on this plus X2 and the stability term, so it sequences after both.

**L3 · Crew as a finite resource.** `labor_plan_line` exists but nothing in `Engine.runAndApply` reads it. Design question: does a crew constraint apply to setup windows only (the assessment's 30-minute example) or to unattended production too? Answer with the plant before modeling.

**L4 · Business-weighted lateness.** No weight source exists. The cheap proxy (weight by policy tier) is noted under N5; a real version needs a customer or order-priority attribute from SAP.

---

## 8. Corrected claims (kept so the original reasoning is not lost)

| Original statement | What is actually true |
|---|---|
| "Optimizer saves can bypass version conflicts through force." | Optimizer saves use `atomic_optimizer:true`, under which `force` is ignored and any stale row rolls back the batch. The bypass paths are the client `CONCURRENCY_CHECK` switch and the external `bulk_update` alias (see N2). |
| "Protecting the number of late orders does not protect already-late orders from becoming substantially later." | Total lateness minutes is scored right after late count. The remaining gap is a per-order worst-case term (see N5). |
| "The shell also intercepts browser zoom shortcuts." | It does not. Only the vis-timeline Ctrl+wheel zoom over the Gantt canvas exists, which is the library's standard behavior. |
| "Scheduling paths mix plant-aware and browser-local calculations." | **Correct, and the first draft of this doc wrongly refuted it.** `plants.timezone` exists and is used by the optimizer's Remove Backlog window, the dashboard's plant hour, and setup captures, while order dates and calendar math are browser-local. The stale `store.mts:825-829` comment misled the first verification pass. See X4a. |
| "Represent known-zero, nonzero, estimated, unknown, prohibited separately." | Known-zero (`implicit-zero`) and unknown (`uncovered`) are already separate sources. Estimated and prohibited do not exist; "estimated" is N8's `plantDefaultMinutes`, "prohibited" has no demand recorded yet. |
| (First draft of this doc) "X1–X5 are hard-parked because they depend on the Entra migration." | None of them does. They are held by effort, missing plant data, a design decision, or the owner's schema-redesign freeze. Entra would only improve attribution on X2 and X5. |
| Line references 171, 331, 856, 1836, 1951, 2117, 1243, 118 | Now 175-237, 328-350, 889-1075, 2372, 2514, 2107, 352, 118 respectively. |

---

## 9. Cross-references

- `docs/changeover_matrix.md` §14 (explicitly deferred: shared molds, crew constraints, global solver) and lines 512-516 (a covered matrix does not prove tool availability).
- `docs/MIGRATION.md` deferred items: 797 (line-calendar last-writer-wins), 847 (cross-line rebalancing blocked on eligibility data), 851 (labor capacity never consulted), 878 (setup straddling shift close), 883 (crew on changeover), 892-913 (timezone historical exposure).
- `docs/superpowers/specs/2026-08-18-optimizer-reason-codes-stability-design.md` and `docs/superpowers/specs/2026-09-10-optimizer-remediation-design.md` (tie-break chain including instability).
- `docs/SAP_INTEGRATION_ROADMAP.md` (read-only direction; lead-operation work-center mapping) and `docs/SAP_APO_Opportunities.md` (built-but-hidden inventory).
- `PRODUCT.md` (four constraints, due dates as north star, scale as differentiator) and root `CLAUDE.md` Production Scale Roadmap.
- `Entra_Auth_Migration.md` (design-only). It gates nothing in this doc for security reasons; it would improve who-did-it attribution for X2 and X5 and is the owner's chosen timing for lifting the schema-redesign freeze.
- Approved decision 2026-08-18: setup-aware optimizer never freezes a line for missing setup data (basis for treating theme 5 as decided).
