# Schedule Events — append-only per-order change history

Plan and decisions D1-D9: `docs/superpowers/specs/2026-10-23-schedule-event-progress.md`. Supersedes the `schedule_events` sketch in the 2026-07-07 multi-user-sync spec; it does NOT reintroduce cross-user polling (removed by the owner 2026-10-22, `docs/MIGRATION.md`).

## What lives here

- `events.py` — **leaf module (stdlib + psycopg only; never import project code here)** so `db.py`, the resolver, distribution and SAP staging can import it without cycles. `TRACKED_FIELDS`/`TRACKED_COLS_SQL`, `PLANNER_SOURCES`/`SOURCES`/`OPS`, `EventCtx`/`EventRow`, `new_action_id`/`as_action_id`, `_ev_scalar`/`dumps`, `diff_tracked`, `snapshot_changes`, `row_from_record`, `record(cur, ev, rows)`, `write_failures()`/`set_failure_hook()`.
- `data.py` — imports `db` and `master_data`: `SCHEDULE_EVENT_DDL`, `ensure_schedule_event_table()` (boot hook in the `brain.py` lifespan), `sweep_schedule_events()`, `list_order_events()`; it also wires the failure counter into `DIAGNOSTICS`.
- `routes.py` — `GET /schedule-events/{plant}/order/{order_id}` (read only; registered in `brain.py`).
- Table `schedule_event`: `migrations/2026-10-23-1-schedule-event.sql` and the `schema.sql` mirror; the DDL text is pinned verbatim by `tests/test_schedule_events.py`.

## Table and indexes

Columns: `id BIGSERIAL PK`, `plant`, `order_id`, `production_order`, `material_number`, `action_id UUID`, `source`, `actor`, `client_id`, `op`, `changes JSONB`, `at TIMESTAMPTZ DEFAULT clock_timestamp()`. Created `WITH (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 10000, autovacuum_analyze_scale_factor = 0.05)` so a steady daily sweep keeps heap bloat near 1.25x. Indexes: `idx_schedule_event_order (plant, order_id, id DESC)` serves the read route; `idx_schedule_event_at (at)` bounds the sweep subquery. Roughly 0.5 KB per row.

- **No FK to `orders`, on purpose**: history outlives a purge, and ids are MD5-derived.
- **`op` is `create | modify | remove`** (CHECK constraint), not update/delete: the deploy runner's destructive regex (`\b(ALTER|DROP|DELETE|UPDATE|TRUNCATE|RENAME|GRANT|REVOKE)\b`, case-insensitive, whole file including comments) would flag those words. The same rule binds the migration text: say "sweep", "remove", "change". `source` has no CHECK (open set; `record()` coerces an unknown source to `unknown`).
- **Ordering is `id DESC`.** `at` defaults to `clock_timestamp()` (insert time) and is cosmetic; `now()` is transaction-start and would invert causality between a planner save and a concurrent SAP chunk.
- **No `(plant, id)` index yet.** It would be a fourth index on every insert for a feed that does not exist; add it (additive) when a plant-level listing or `/changes` ships.

## Invariants

- **One `record()` per transaction per path, as the last statement before that path's own `conn.commit()`**, on that path's own cursor, so history commits or rolls back with the order write. Exception: distribution `apply()` records once per parent chunk inside `_run_savepointed` before `RELEASE`, so a rolled-back chunk drops its rows.
- **Fail-open.** The INSERT sits under `SAVEPOINT sched_ev`; on any failure only that savepoint rolls back, `DIAGNOSTICS["schedule_event_write_failures"]` is bumped, a warning with the `action_id` is logged, and the order write still commits. The order is the system of record; history is derived. The ingest read-back (`_record_ingest_events`) has its own `sched_ev_rb` savepoint with the same fail-open rule.
- **DB-typed before vs DB-typed after.** Diff the locked pre-read against the `RETURNING`/read-back row, never the wire payload (phantom diffs like `Decimal('2.0')` vs `2.00`, PV `"0001"` vs `"1"` would be the biggest bloat vector). `None == ''`, numerics compare by value, strings compare stripped, only keys present in `after` are compared.
- **Unchanged means no row**: `record()` drops rows with empty `changes`, so an identical resend, an identical re-upload and a same-text note write nothing.
- **Ingest reset is ONE `sap_reset` row** per order spanning the pre-upsert image to the post-reset image, never two rows; it is only labelled `sap_reset` when a slot, firm, segments or status was really taken back (`_EV_RESET_FIELDS`), otherwise a plain `sap_ingest`/`excel_upload` change.
- **PRT and production version are recorded once, as a NET change, after the stamp** (`db._record_ingest_attr_net`). The chunk read-back runs before the stamp and uploads never carry PRT, so a chunk-level diff of `prt_01`, `prt_02` and `production_version` would record phantom `[x, null]` changes. `_record_ingest_events` therefore EXCLUDES those three fields from the ingest / `sap_reset` diff; `upsert_orders` keeps `pre_attrs` (the three values from the chunk's locked pre-read, for every existing order in the batch; inserted orders have no pre-image), and after the batch `_backfill_and_stamp` it reads the post-stamp values and records ONE `modify` row per order with the net change under the batch `action_id` (source `sap_ingest`/`excel_upload` for orders the upload wrote, `master_data_stamp` for orders it only filled from master data). `_backfill_and_stamp` passes `ev=None`, so `_stamp_run` records nothing during ingest; it records `master_data_stamp` rows only from `resync_order_attributes`. **For these three fields the ingest row is therefore written after the stamp, in its own savepoint and transaction (fail-open, same batch `action_id`), not in the chunk transaction.** Children written by distribution `apply()` have no pre-image, so they get no net row (their `create`/`modify` rows are written by `apply()` itself).
- **A new order on a routing plant gets one `create` row.** The transient `runtime_pending` hold on fresh inserts records nothing (the order already has its `create` row); the in-ingest resolver reuses the batch action id (`resolve_orders(..., batch_id=...)` derives `as_action_id(batch_id)`), so its outcome row groups with the create.
- **`create` rows skip default values** (`planning_status == 'scheduled'`, `manual_firmed` false, `segments` 0, nulls); `remove` rows keep them (the order's last known state).
- **Rows with real changes but no plant or order id are dropped** (`NOT NULL`-safe), counted in `DIAGNOSTICS["schedule_event_rows_skipped"]` and logged at debug.
- **Accepted staleness windows.** The resolver's `before` image (`_load_orders`) is an unlocked read, so a planner save landing between that read and the resolver's write can make a `routing_recompute` row show a slightly stale "before"; the "after" value is always correct. The re-weight / reset / repair before-image IS locked (`_ev_read(..., lock=True)`, id order).
- **`_stamp_run`'s `IS DISTINCT FROM` guard means an unchanged order is no longer rewritten**: its `xmin` and `updated_at` do not move on an ingest or resync stamp that changes nothing (before the guard every stamp bumped both).
- **Dry runs record nothing** (distribution dry runs return before any history read or write).
- **`ev=None` records nothing**, so every caller that passes no context (and every existing test) is unchanged until instrumented.
- **Diff, then record, on the same locked rows**: each hook reads its `before` from the path's existing `FOR UPDATE` read (widened to the tracked columns), never from a second unlocked read.

## Sources: which path writes which

| `source` | Written by | Actor |
|---|---|---|
| `drag`, `keyboard`, `grid`, `inspector`, `alert_fix`, `optimizer`, `undo` (`PLANNER_SOURCES`) | `db.update_task_dates_bulk`, per task, from the wire `source` | `x-user-email` (`auth.require_authenticated`) |
| `planner` | same save, when the task carried no (or an unknown) `source` | `x-user-email` |
| `note` | `db.update_task_note`, only when the note really changed | `x-user-email` |
| `sap_ingest` / `excel_upload` | `db.upsert_orders` create and modify rows (`sap_ingest` when ingest `source == "sap"`) | caller, else the Excel filename, else `system`; `/upload` passes the admin email, SAP staging its `actor`, `sap_sync` `sap-scheduler` |
| `sap_reset` | `db.upsert_orders` merged reset row; `sap_staging._record_zero_open_events` (zero-open reset) | as ingest; staging `actor` (`sap-staging-poll` when polled) |
| `routing_hold` | `resolver._write_holds` and `db._apply_run_time_cap` (via `replace(ev_ctx, source="routing_hold")`), and the over-cap release in `_apply_run_time_cap` (`planning_status: needs_planning:run_time_over_cap -> scheduled`); the fresh-insert `runtime_pending` hold writes no row | the run's actor |
| `routing_recompute` | `resolver._write_outcomes_chunk` | the recompute actor, else `system` |
| `master_data_stamp` | `db._stamp_order_attributes` / `resync_order_attributes` (only rows `IS DISTINCT FROM` the master data); recorded ONLY from `resync_order_attributes`, never during ingest (see the net-pass invariant) | resync route actor, else `system` |
| `purge` / `sap_vanish` | `db._purge_order_ids_on_cursor` after the `admin_audit` row, via `purge_orders_by_date` / `purge_orders_by_ids(event_source=...)` | purge user email; SAP vanish passes the staging actor |
| `distribution` | `distribution.data.apply` (ingest) and `_materialize_reweight` (re-weight, reset, repair) | ingest/route actor; repair passes `ev_actor` |
| `restore`, `admin`, `unknown` | in the vocabulary; `restore` and `admin` have no writer yet; `unknown` is the coercion target | none |

`action_id`: one per save/purge/resync/recompute; ingest and SAP vanish reuse the batch id (`as_action_id`), so a valid UUID is kept, any other non-empty id maps to a deterministic `uuid5` (the same batch always yields the same action id), and only None / empty gets a fresh one. Post-commit recomputes after a planner's re-weight / reset / repair, a work-center auto-link and master-data writes carry the route actor.

## Tracked fields

`machine, scheduled_end, scheduled_start, run_time, production_version, manual_firmed, planning_status, notes, order_quantity, basic_finish_date, prt_01, prt_02, parent_production_order, distribution_letter, segments`. Values are `{"field": [before, after]}`; only changed fields appear. `create` rows snapshot the non-null tracked fields as `[null, v]`, `remove` rows as `[v, null]` (purge/vanish store a bounded last-state snapshot).

- **`segments`** is a count pair (`[n_before, n_after]`), not an `orders` column (`TRACKED_COLS_SQL` omits it).
- **`planning_status` encoding**: a held order carries its reason code, `"needs_planning:<code>"` (e.g. `needs_planning:runtime_unknown`); plain statuses stay as-is (`db._ev_status` / `_event_status`, resolver `_status_code`).
- **Pseudo-fields (distribution id splits)**: `{"carried_from": [null, old_id]}` on the new child's `create`, `{"superseded_by": [null, new_id]}` on the old child's `remove` (the latter only when exactly one new id exists).
- **Value encoding**: `Decimal` becomes int when integral else float; datetimes are `isoformat(timespec="seconds")` exactly as stored (naive stays naive); NaN/inf become null; NUL bytes are stripped (jsonb rejects them).

## Retention sweep

- Setting `system_settings.schedule_event_retention_days`; `master_data.get_schedule_event_retention_days()` int-coerces, **clamps 1-60, default 14**, never raises (a bad stored value is logged once and falls back). `POST /system-settings` rejects a value outside integer 1-60 with a 400.
- `sweep_schedule_events()` deletes rows older than the window in 10k-row chunks through the `(at)` index (`max_chunks=500`, 0.1 s pause, 30 s `statement_timeout`). One transaction per chunk, each opening with `pg_try_advisory_xact_lock(hashtext('nimbus:schedule-event-sweep'))` (transaction-scoped, so it cannot leak through the pool); another sweeper holding it returns `{"locked": True}`. It never raises, returns `{deleted, chunks, retention_days, locked, error}` and stores that in `DIAGNOSTICS["schedule_event_last_sweep"]`.
- Jobs (`brain.py` lifespan; the `AsyncIOScheduler` is now built unconditionally, the SAP cron and staging-poll jobs stay under their flags): `nimbus:schedule-event-sweep` (every 24 h) and a one-shot `nimbus:schedule-event-sweep:boot` (+60 s, never inline in lifespan so a backlog cannot block readiness), both driving `_run_schedule_event_sweep`.
- Admin route: `POST /maintenance/schedule-event-sweep` (`require_api_key` + `require_admin`, optional `retention_days` 1-60 else 400; listed in `_ADMIN_WRITE_OPERATIONS` as `maintenance.schedule_event_sweep`). `/diagnostics/deep` carries `db_stats.schedule_event` (`db.get_schedule_event_stats()`: `rows_estimate` from `pg_class.reltuples` (null before the first ANALYZE; an exact `count(*)` would scan the table), oldest/newest `at`, plus `last_sweep`, `write_failures`; if the scheduler fails to start `last_sweep` is `{"error": "scheduler not started"}`).

**Partition upgrade path** (only if the sweep exceeds ~5 minutes or the order index passes ~1 GB, roughly >1M rows/day): create `schedule_event_v2 PARTITION BY RANGE (at)` with a DEFAULT partition and daily partition pre-creation, point `record()` and the read at v2, let the old table drain for one retention period, then drop it with a deliberate `-AllowDestructive` migration.

## Read route contract

`GET /schedule-events/{plant}/order/{order_id}?limit=50&before_id=` — `auth.require_authenticated` plus plant scope (`get_allowed_plants_for_request` / `md._assert_plant_allowed`: 403 outside the user's plants, 400 on a bad plant), `Cache-Control: no-store`, `limit` 1-200, `before_id` 1 to 9223372036854775807 (the bigint ceiling). Newest first by `id`; the query fetches `limit + 1` to compute the cursor. Response: `{plant, order_id, events: [{id, at, actor, actor_name|null, source, op, action_id, client_id, changes}], next_before_id}`. `actor_name` is `first_name last_name` from a case-insensitive `user_security` join on `actor`, null for system actors.

## Identity hazards and copy rule

- **`actor` is spoofable** until Entra replaces header auth (`x-user-email`, the same posture as `admin_audit`). System actors are plain strings: `sap-staging-poll`, `sap-scheduler`, `system`, an Excel filename.
- **Duplicate-id suffix swap** (the `_1/_2` suffix assignment in `db.py` ingest, pre-existing): two orders sharing a production order and material can swap suffixes between uploads, so a history shown for one id can belong to the other's slot. Documented only.
- **Copy rule**: because of the sweep, an empty history means **"No changes in the last N days"**, never "never changed".

## Imports in / Imported by

**Imports in:** `events.py` imports stdlib + `psycopg` only. `data.py` imports `db`, `master_data as md`, `backend.admin_ops.diagnostics_state.DIAGNOSTICS`, `backend.schedule_events.events`. `routes.py` imports `master_data as md`, `backend.schedule_events.data`, `backend.security.auth` (`require_authenticated`, `get_allowed_plants_for_request`).

**Imported by:** `events` — `db.py` (as `sched_events`), `backend/routing/resolver.py`, `backend/integration/sap_staging.py`, `backend/distribution/data.py`, `backend/scheduling/routes.py` (`EventCtx`, `new_action_id`). `data` — `brain.py` (boot `ensure_schedule_event_table()` right after the system-settings table, and the sweep job), `backend/admin_ops/routes.py` (sweep route). `routes` — `brain.py` (`api.include_router`).

## Tests

`python -m pytest tests/test_schedule_events.py tests/test_schema_idempotent.py -q` — pure tests (scalar encoding, diffs, snapshots, `record()` fail-open with a fake cursor, DDL/regex pins) run anywhere; classes marked `@pytest.mark.pg` need local Postgres with `NIMBUS_TEST_DB=1` and a local `PG_HOST` (they skip otherwise, and pytest refuses to collect against a non-local host). pg tests that write orders clean up through `tests/support/planning_pg.py::cleanup_schedule_events(cur, actor=..., plants=...)`. Admin-route and lifespan coverage lives in `tests/test_api_admin_ops_coverage.py`, `tests/test_integration_routes.py`, `tests/test_system_settings.py`. JS: `tests/modules/scheduling/{persistence,orders}.test.mjs`, `tests/modules/application-shell.test.mjs`, `tests/modules/locale-completeness.test.mjs`.
