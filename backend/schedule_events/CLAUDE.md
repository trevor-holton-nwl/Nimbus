# Schedule Events — append-only per-order change history

Plan and decisions D1-D9: `docs/superpowers/specs/2026-10-23-schedule-event-progress.md`. Supersedes the `schedule_events` sketch in the 2026-07-07 multi-user-sync spec; it does NOT reintroduce cross-user polling.

## What lives here

- `events.py` — **leaf module (stdlib + psycopg only; never import project code here)** so `db.py`, the resolver, distribution and SAP staging can import it without cycles. Tracked fields, `EventCtx`/`EventRow`, `diff_tracked`, `snapshot_changes`, `row_from_record`, `record(cur, ev, rows)`, `write_failures()`.
- `data.py` — imports `db` and `master_data`: `SCHEDULE_EVENT_DDL`, `ensure_schedule_event_table()` (boot hook in the `brain.py` lifespan), `sweep_schedule_events()`, `list_order_events()`.
- `routes.py` — `GET /schedule-events/{plant}/order/{order_id}?limit=&before_id=` (authenticated, plant-scoped, `Cache-Control: no-store`).
- Table `schedule_event`: `migrations/2026-10-23-1-schedule-event.sql` and the `schema.sql` mirror; the DDL text is pinned verbatim by `tests/test_schedule_events.py`.

## Invariants

- **Same cursor, before commit.** `record(cur, ev, rows)` runs on the write path's own cursor as the last statement before that path's `conn.commit()`, so history commits or rolls back with the order write.
- **Fail-open.** The INSERT sits under `SAVEPOINT sched_ev`; on any failure only that savepoint rolls back, `DIAGNOSTICS["schedule_event_write_failures"]` is bumped, a warning with the `action_id` is logged and the order write still commits. The order is the system of record; history is derived.
- **DB-typed before vs DB-typed after.** Diff the locked pre-read against the `RETURNING`/read-back row, never the wire payload (phantom diffs like `Decimal('2.0')` vs `2.00`, PV `"0001"` vs `"1"` would be the biggest bloat vector). `None == ''`, numerics compare by value, only keys present in `after` are compared.
- **op vocabulary is `create | modify | remove`**, not update/delete: the deploy runner's destructive regex (`\b(ALTER|DROP|DELETE|UPDATE|TRUNCATE|RENAME|GRANT|REVOKE)\b`, case-insensitive, whole file including comments) would flag those words. The same rule applies to the migration text: say "sweep", "remove", "change". `source` has no CHECK (open set; Python coerces unknown to `unknown`).
- **No FK to `orders` on purpose**: history outlives a purge, and ids are MD5-derived. The known identity hazard is the duplicate-id `_1/_2` suffix swap (`db.py` ~3855, pre-existing): document only.
- **Ordering is `id DESC`.** `at` defaults to `clock_timestamp()` (insert time) and is cosmetic; `now()` would invert causality between a planner save and a concurrent SAP chunk.
- **`actor` is spoofable** (`x-user-email` via `auth.require_authenticated`, same posture as `admin_audit`; Entra replaces it). System actors are plain strings: `sap-staging-poll`, `sap-scheduler`, `system`, an Excel filename.
- **`ev=None` records nothing**, so every existing caller and test stays unchanged until it is instrumented.

## Retention sweep

`sweep_schedule_events()` deletes rows older than `system_settings.schedule_event_retention_days` (default 14, clamped 1-60, `master_data.get_schedule_event_retention_days()`) in 10k-row chunks through the `(at)` index. One transaction per chunk, each opening with `pg_try_advisory_xact_lock(hashtext('nimbus:schedule-event-sweep'))` (transaction-scoped, so it cannot leak through the pool); another sweeper holding it returns `{"locked": True}`. It never raises and stores its result in `DIAGNOSTICS["schedule_event_last_sweep"]`. The table is created `WITH (autovacuum_vacuum_scale_factor = 0.02, ...)` so a steady daily sweep keeps bloat near 1.25x.

**Partition upgrade path** (only if the sweep exceeds ~5 minutes or the order index passes ~1 GB, roughly >1M rows/day): create `schedule_event_v2 PARTITION BY RANGE (at)` with a DEFAULT partition and daily partition pre-creation, point `record()` and the read at v2, let the old table drain for one retention period, then drop it with a deliberate `-AllowDestructive` migration.

## Copy rule

Because of the sweep, an empty history means **"No changes in the last N days"**, never "never changed".

## Tests

`tests/test_schedule_events.py` (pure tests plus `@pytest.mark.pg`); schema checks in `tests/test_schema_idempotent.py`. pg tests clean up through `tests/support/planning_pg.py::cleanup_schedule_events`.
