# backend/scheduling — the `/tasks` route family and optimistic-concurrency contract

## What lives here

- **`routes.py`** (655 lines) — every `GET/POST /task(s)*` route:
  - `GET /tasks` (`get_tasks`) — the task-list read path with finish-to-start links and diagnostics metadata; plant/machine scoping, `?limit=`/`?offset=` paging, per-user `role_plants` enforcement.
  - `GET /tasks/horizons` (`get_task_horizons`) — meta-only horizon probe: resolved visibility/frozen horizon instants and alert-flag horizon minutes without the task list.
  - `POST /task/update` (`update_task`) — single-task schedule/attribute edit.
  - `POST /task/note` (`update_task_note`) — free-text note persistence (max 500 chars).
  - `POST /tasks/update` (`tasks_update`) — the frontend's bulk explicit-save path, payload `{ tasks, blocks?, calendars? }` (only `tasks` is consumed).
  - `POST /tasks/bulk_update` (`bulk_update`) — flat-list alias of the same logic for external tooling.
  - `POST /tasks/refresh` (`tasks_refresh`) — refetch complete writable task aggregates, runtime provenance and matching `row_version` for concurrency reconciliation.
  - `POST /tasks/baseline-correct` (`baseline_correct`) — persists due-date-baseline (`basic_finish_date`) corrections found by the frontend's `Persistence._snapToWorkingHours`.
  - Private helpers used only within this domain: `_clean_id` (strips Excel float suffix from SAP ids), `_to_pydt` (pandas/ISO/None → naive datetime), `_schedule_segments_to_wire` (normalizes the split-order JSONB aggregate to the API's naive-local contract), `_apply_task_date_updates` (the single shared validate/persist/rollback path behind all three `/update`-family endpoints).
- **`models.py`** (315 lines) — the Pydantic DTOs backing `GET /tasks`'s `response_model=` runtime validation and every update endpoint's request/response shapes: `LinkDTO`, `ScheduleSegmentDTO`, `PlanningReason`, `TaskDTO` (mirrors `get_tasks`'s `data.append({...})` dict literal field-for-field), `TasksResponse`, `HorizonsResponse`, `ScheduleConflict`, `TaskUpdateResult`, `BulkUpdateResult`, `TaskVersionRow`, `TasksRefreshResponse`, `BaselineCorrectResult`, `ScheduleSegmentInput`, `TaskDateUpdate` (carries `base_version`/`force` for the xmin contract), `TasksUpdatePayload`, `TaskRefreshPayload`, `DueDateCorrection`, `DueDateCorrectionPayload`.

Both files carry a header docstring confirming this was a **pure move from `brain.py`** (routes.py: lines 1493-1982 of the pre-split file; models.py: verbatim) per `docs/architecture/domain-refactor-plan.md` §4 — route paths, payload shapes, and response models are byte-identical to before.

## Counterpart

Frontend half: `frontend/scheduling/CLAUDE.md` (`gantt.mts`, `orders.mts`, `selection.mts`, `persistence.mts`, `order-field-catalog.mjs`) — the UI/drag/save semantics that call these routes.

**`db.py`/`master_data.py` are not split** (deferred, see `docs/MIGRATION.md`) — this domain's route file imports both whole at repo root (`import db`, `import master_data as md`) and calls into them for all actual data work. Current line ranges this domain's logic depends on (grepped fresh against `db.py` on main as of 2026-10-06, 4,473 lines total):
- `db.make_id()` — line 122 (the MD5 task-id scheme; not called directly by these routes but its stability is why ids can key `/tasks/refresh` and drag/edit operations across reloads).
- `db._horizon_bounds_for_plant()` — line 491 (visibility/frozen horizon bounds `get_tasks` rides along on, per its own C1/C2 comments).
- `db.query_orders()` — line 599 (the `GET /tasks` data source).
- `db.count_orders()` — line 670 (paging total).
- `db.get_task_versions()` — line 827 (backs `/tasks/refresh`; `TaskVersionRow`'s docstring cites `db.py:437-445` for its shape, which is stale — re-grep before trusting either number).
- `db.update_task_dates_bulk()` — line 1179 (the shared persist path behind `_apply_task_date_updates`).
- `db.correct_due_date_baselines()` — line 1653 (backs `/tasks/baseline-correct`).
- `db.update_task_note()` — line 1796 (backs `/task/note`).
- `master_data.plants_for_line()` — line 2990 (used by `get_tasks`'s `?machine=`-only plant-scope check).

## Key invariants & hazards

- **Refresh runtime contract (2026-10-01):** `get_task_versions` reads quantity, material, raw SAP start, runtime and xmin together. The route filters by authorized plant before exposing `PLANT`; quantity uses the existing `ORDER_QUANTITY_(GMEIN)` wire name. Nullable PV/machine attributes normalize before edit detection, so null and empty snapshots do not manufacture routing edits; an explicit clear of an existing PV still requires eligibility validation.

- **`orders.xmin` is `base_version`.** Any `UPDATE orders` — even on a column no UI reads yet — bumps xmin for every row touched, so those ids come back in the next save's `stale` list and the frontend discards its unsaved edit via last-writer-loses reconciliation (`POST /tasks/refresh`). Before adding any new `UPDATE orders` statement anywhere in the codebase, ask what it does to in-flight planner edits.
- **A version conflict is never a 4xx.** Under `SELECT … FOR UPDATE`, a `base_version` mismatch reports the id in a `stale` list inside a 200 response (see `TaskUpdateResult`/`BulkUpdateResult`), never an HTTP error. `force=True` bypasses the check only on `/tasks/update` in non-atomic mode (the client sends it when `Config.CONCURRENCY_CHECK` is false) and is logged as a warn `forced_write` event. The optimizer never uses `force` — it uses `atomic_optimizer`, under which `force` is ignored. `/tasks/bulk_update` strips `force` from every item.
- **Split-order segments:** `order_schedule_segments` (`(order_id, segment_no)`) is a durable multi-segment schedule aggregate handled by `_schedule_segments_to_wire`/`TaskDateUpdate.schedule_segments`. **Parent `orders.xmin` is the sole concurrency token** — segment rows are never independently exposed or updated by this API. Gated per plant by `plants.split_order_policy` (`never` | `overlong_only` | `partial_allowed`); an absent/malformed value keeps the continuous-order scheduler unchanged.
- **`orders.runtime_schedule_mismatch`** flags an ingest-side `RUN_TIME` change that would otherwise make prior NIMBUS timing look valid; surfaced on `TaskDTO`/`TaskVersionRow` as `runtime_schedule_mismatch`.
- **An explicit aggregate replacement is required, not implied.** `_apply_task_date_updates` treats a JSON `null` for `schedule_segments` as invalid (increments `invalid`, does not silently erase durable productive pieces) — a client must send `[]` explicitly to clear segments.
- **Never a whole-batch 4xx for `/tasks/update`/`/tasks/bulk_update`.** Both are best-effort and report per-row counts in the body (`persisted`/`failed`/`invalid`/`not_found`/`stale`/`versions`, plus `invalid_ids`/`not_found_ids` so the frontend can distinguish terminal rejections from transient loss). A whole-transaction rollback (a raised `psycopg.Error`) is reported as `{"status": "error", "error_code": ..., "cause": ...}` inside a 200, not as an HTTP 5xx.
- **`GET /tasks` refuses an unscoped, unbounded pull** — no `?plant=`, no `?machine=`, no `?limit=` raises 400. Plant is the scaling unit; this is deliberate given the production-scale roadmap (50+ plants).
- **Save path reports `conflicts` (N3).** The bulk-save path returns a `conflicts` list — plant+machine-scoped strict overlaps found among the orders just written, scanned under `SAVEPOINT conflict_scan` inside the same save transaction. Advisory by default (rows are already persisted); becomes hard rejection only when the save is also `strict_conflicts` with `atomic_optimizer` (`status:'error'`, `error_code:'schedule.conflicts'`, still inside a 200).

## Integration points

**Imports in:** `db`, `master_data as md` (root, unsplit); `backend.admin_ops.diagnostics_state.DIAGNOSTICS`; `backend.admin_ops.logbuffer._current_rid`/`_log_event`; `backend.priority_lists.cache as plcache` (`apply_priority_merge` for the per-request color/priority merge on `GET /tasks`); `backend.scheduling.models` (all DTOs); `backend.security.auth` (`get_allowed_plants_for_request` for per-user plant scoping).

**Imported by:**
- `brain.py` — `import backend.scheduling.routes as scheduling_routes` (router registration) plus explicit back-compat re-exports: `from backend.scheduling.models import BulkUpdateResult, TaskDateUpdate, TaskDTO` and `from backend.scheduling.routes import _apply_task_date_updates, _to_pydt` (both `# noqa: E402,F401 — back-compat`), so `brain._to_pydt(...)` and `brain.TaskDTO` etc. still resolve for any test or tool that imports `brain` rather than this module directly.
- `tests/test_to_pydt.py` — calls `brain._to_pydt(...)` (via the back-compat re-export above, not a direct `backend.scheduling` import).
- `tests/test_task_response_models.py` — regression guard for the `TaskDTO` field set (pins that FastAPI's `response_model=` won't silently drop a key `get_tasks` still emits).

**Endpoints:** see "What lives here" above for the full route list — all are consumed by `frontend/scheduling/persistence.mts` (`saveAll`, `_refreshTasks`, `load`) and `frontend/scheduling/orders.mts`/`gantt.mts` (via `Persistence`).

## Tests

- `tests/test_to_pydt.py` — pure-logic tests for `_to_pydt`'s naive-local timezone contract (no DB required).
- `tests/test_task_response_models.py` — `TaskDTO` field-set regression guard (no live DB; builds a synthetic dict).
- `tests/test_planning_exceptions.py` and `tests/test_task_response_models.py` import `backend.scheduling.models`/`backend.scheduling.routes` directly; older files go through `brain` (back-compat re-exports) or a live `TestClient`.

Run: `python -m pytest tests/test_to_pydt.py tests/test_task_response_models.py -q`

## Gotchas

- Don't trust the `TaskVersionRow` docstring's `db.py:437-445` citation for `get_task_versions`'s shape — that function is at line 827 on main (2026-10-06). Line numbers drift across phases; re-grep before citing.
- `brain.py`'s own comments (around its `backend.scheduling.*` imports) explain the re-export pattern exists specifically so pre-refactor test files that still say `import brain` keep working without edits — this is intentional back-compat scaffolding, not leftover duplication to clean up.
- `response_model=` is only wired for this domain's routes (`GET /tasks` and the whole task-date-update family) — per the root `CLAUDE.md`, no other endpoint family in the app has it yet, so don't assume the same runtime-validation safety net exists elsewhere.

## Optimizer planning exceptions (2026-09-09)

`orders.planning_status` is `scheduled` or `needs_planning`; `planning_reason` is a nullable `{code,message}` JSON object. Queued rows retain SAP baselines but expose null effective dates, have no child segments, and remain in scoped horizon-filtered query/count results. Date edits restore scheduled status. `/tasks/update` accepts opt-in `atomic_optimizer: true`: every row must have a current `base_version`, force is ignored, and any invalid/not-found/stale row prevents the entire batch from writing. Default and flat-list callers retain best-effort semantics. Apply migration `2026-09-09_optimizer_planning_exceptions.sql` before deploying dependent code.

## Save-path contracts added in the 2026-10 review/audit rounds

- **`machine_unknown` rejection + canonicalisation.** A `MACHINE` edit must name a machine the item's plant knows (registered in `machine`, or already holding orders there; `db._known_machine_keys`). Anything else is rejected per item inside the normal 200 envelope: the id lands in `invalid_ids` and `rejection_reasons[id] == "machine_unknown"`. The match is case/whitespace-insensitive (`db._machine_match_key`) and the stored value is the **canonical spelling**, never the typed one (`'m1 '` -> `'M1'`); a numeric Excel cell arrives as clean text via `_str_id` (`101.0` -> `'101'`). A distribution child still cannot take a direct `MACHINE` edit (decision C) -- that rejection comes first.
- **Strict-save advisory locks.** `atomic_optimizer + strict_conflicts` saves take `pg_advisory_xact_lock` per (plant, machine) in sorted order **before** the row `FOR UPDATE`s (`db._lock_machines_for_strict_save`). The lock text is `db._strict_lock_key(plant, _machine_match_key(machine))` -- the canonical key, so `'M1'`/`'m1'` share one lock; keying on the raw spelling let a differently-cased MACHINE edit slip past. **Scope: strict saves serialise only against other strict saves.** A non-strict (manual) save takes no advisory lock, so it can still interleave with a strict save's overlap scan; that is accepted, not a bug.
- **Routing eligibility cache (P7).** `update_task_dates_bulk` builds one eligibility cache per call and threads it through every `_check_eligibility_on_conn` of the batch, so N edited rows of a plant load the production-version/operation reference data once, not N times. Never hoist the cache above a call (it is not safe across transactions).
- **Batched UPDATE leaves unset columns untouched.** Date saves go through a batched `UPDATE ... FROM (VALUES ...)`; columns a payload row does not carry keep their stored value (including a non-NULL `run_time`/`scheduled_end`) -- tests seed those to prove it.
- **`RUN_TIME` is validated at the DTO.** `TaskDateUpdate.RUN_TIME` rejects NaN/Infinity/negative/>=168 hours (models.py `field_validator`, H8) so a crafted value cannot reach the schedule math.
- **Body caps on the free-form sinks** (`brain.py` `_BODY_CAPS`, enforced on `Content-Length`; a missing/non-numeric length is 411, over the cap 413): `/logs/frontend` 1 MB, `/audit/log` 64 KB, `/logs/csp-report` 16 KB.

## What was last sent to SAP: `orders.sap_sent_*` (2026-10-07, SAP staging)

- **`orders.sap_sent_finish` / `sap_sent_version` / `sap_sent_firm` / `sap_sent_at`** are written only by Send to SAP (`sap_staging.queue_send_to_sap`, `backend/integration/CLAUDE.md`), and only when the remembered values actually change (an unchanged order is not rewritten, so its xmin is untouched). **A planner's save does NOT clear them** (`db.update_task_dates_bulk` no longer touches `sap_sent_*`; D20 refinement): they are overwritten only by the next Send. Reason: clearing let SAP's echo of the old send wipe the planner's newer edit. They are never part of the `/tasks` DTO.
- **Effect on re-ingest (echo rule, D20).** `db.sap_changed_fields` (`db.py:2584`) treats an incoming SAP finish equal to `sap_sent_finish` as NOT an SAP date change even when SAP back-scheduled the start (and a version equal to `sap_sent_version` as not a version change), so a re-import of what NIMBUS just sent does not reset the planner's slot; the new SAP baselines are still written. A different finish, version or work center still re-plans the order as before.

## Manual firm and Delete (SAP-is-truth firming)

- **A planner's firm is `orders.manual_firmed`, shared server-side.** `GET /tasks` returns it as `firmed: bool` (`_ORDERS_SELECT` alias `FIRMED`), the refresh read (`get_task_versions` -> `TaskVersionRow.firmed`) returns it too, and `POST /tasks/update` accepts `FIRMED: bool` **only for rows whose firm the planner toggled** (omitted or null means untouched). SAP's own firming indicator stays in `ecc_firmed` and locks nothing.
- **A FIRMED-only item is a valid edit.** Both empty-item checks (`routes.py` `_apply_task_date_updates` and `db.update_task_dates_bulk`) count it, it bumps xmin, it is still subject to the `base_version` stale check, and it is allowed on distribution children (the only `orders` rows of a distributed order). It does not count as a move for the conflict scan.
- **Delete** is the existing queued-write path: `planning_status='needs_planning'`, `planning_reason={"code":"planner_unscheduled","message":"Unscheduled by planner"}` (JSONB), null dates. No CHECK change; the routing resolver ignores unknown reason codes, so the order stays queued.
