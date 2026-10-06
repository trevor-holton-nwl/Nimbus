"""Regression coverage for db.py's routing-runtime ingest wiring
(ROUTING_RUNTIME_DESIGN.md §4) inside `upsert_orders`/`_stamp_order_attributes`:

  1. The file's run-time column is nulled before upsert for a plant whose
     `plants.routing_runtime_enabled` switch is on; a disabled plant's row is
     byte-for-byte unaffected.
  2. `_stamp_order_attributes`'s COALESCE(NULLIF(...)) fix — a blank/missing
     PRODUCTION_VERSION falls back to the Material Plant default; an explicit
     value (file or a planner's prior NIMBUS edit) is never overwritten.
  3. `_zero_pad` on `production_version` is applied ONLY to an enabled plant's
     rows.
  4. A brand-new order row on an enabled plant is UPDATEd into
     `needs_planning`/`runtime_pending` before the resolver runs; a
     pre-existing row that was merely updated is never touched by this step.
  5. `_UPSERT_SQL` no longer contains the old "flag runtime_schedule_mismatch
     on every re-upload" condition — only a plain carry-forward remains.
  6. The optional `resolve_fn(plant, conn=conn)` seam: called once per
     distinct affected plant, after `apply_fn` and before the `upload_audit`
     INSERT, with each plant's result folded into the returned `warnings`.

No live Postgres is reachable in this environment: `db.PG_HOST` resolves (via
`.env`) to the Azure pilot host, which `tests/conftest.py`/
`tests/support/db_safety.py` correctly refuse to treat as a local/CI test
database even with `NIMBUS_TEST_DB=1` (see root CLAUDE.md's "pytest is
guarded against the live Azure DB"). So — mirroring
`tests/test_master_data.py`'s established convention — every test here
monkeypatches `db._pool` with a fake cursor/connection/pool that records every
`execute()`/`executemany()` call instead of touching a real database.

`upsert_orders` issues several distinct SQL statements over the same
connection; the fake cursor below tells them apart by matching a stable
substring of each statement (the same style `test_master_data.py` already
uses for spotting the "ON CONFLICT" upsert vs. the plain audit insert), not by
executing real SQL. Two consequences of that:

  * Coverage for item 2 (the COALESCE fix) can only pin the SQL text of the
    fix — it cannot execute Postgres's actual COALESCE evaluator.
    `tests/test_routing_resolver.py`
    (ROUTING_RUNTIME_DESIGN.md §10) is where any resolver-side behavior gets a
    genuine live-value check once a DB is reachable.
  * Coverage for item 4's plant-scoping (`AND plant = ANY(%s)`) pins the two
    bound parameter lists the query is built from (ids to hold, plants to
    scope to) rather than re-deriving Postgres's own `ANY()` row selection —
    that part is a single, unremarkable relational AND that doesn't need a
    live engine to trust once the parameters themselves are proven correct.
"""
from contextlib import contextmanager
from decimal import Decimal


import db


# ---------------------------------------------------------------------------
# Fake pool/connection/cursor — see module docstring.
# ---------------------------------------------------------------------------
class _Cursor:
    """Records every execute()/executemany() call. `execute()` recognizes two
    read queries `upsert_orders` issues and answers them from canned data;
    every other `execute()` (UPDATE/backfill statements whose result nobody
    reads) just clears the pending fetchall() result. `executemany()`
    recognizes the one `INSERT INTO orders (...) ... RETURNING id, (xmax = 0)
    AS inserted` call and answers each row from `insert_flags` (default: every
    row looks like a fresh insert, matching a from-empty-table upload)."""

    def __init__(self, *, enabled_plants=(), insert_flags=None):
        self.executed = []        # [(stmt, params), ...] — plain execute() calls
        self.executed_many = []   # [(stmt, params_list), ...] — executemany() calls
        self._enabled_plants = set(enabled_plants)
        self._insert_flags = dict(insert_flags) if insert_flags else {}
        self._fetchall_result = []
        self._pending = []
        self._idx = 0

    def execute(self, statement, params=None):
        stmt = str(statement)
        self.executed.append((stmt, params))
        if "routing_runtime_enabled = TRUE" in stmt:
            self._fetchall_result = [(p,) for p in sorted(self._enabled_plants)]
        elif "COALESCE(production_version, '') <> ''" in stmt:
            self._pending, self._idx = [(0,)], 0   # pv_kept_on_blank count: nothing kept
        else:
            # Every other execute() this function issues (plant/machine_key
            # backfill UPDATEs, _stamp_order_attributes's UPDATE+exceptions
            # SELECT, the ambiguous-plant SELECT, the runtime_pending hold
            # UPDATE) either isn't read via fetchall() at all, or wants an
            # empty result for these tests (no unmatched-master-data rows,
            # no ambiguous machines).
            self._fetchall_result = []

    def executemany(self, statement, params_list, returning=False):
        stmt = str(statement)
        self.executed_many.append((stmt, params_list))
        if "INSERT INTO orders (" in stmt:
            self._pending = [
                (row[0], self._insert_flags.get(row[0], True)) for row in params_list
            ]
        else:
            self._pending = [(True,)] * len(params_list)
        self._idx = 0

    def fetchone(self):
        if self._idx < len(self._pending):
            return self._pending[self._idx]
        return None

    def nextset(self):
        self._idx += 1
        return self._idx < len(self._pending)

    def fetchall(self):
        return self._fetchall_result


class _Connection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.commits = 0

    @contextmanager
    def cursor(self):
        yield self._cursor

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass


class _Pool:
    """Every `with pool.connection()` yields a fresh `_Connection` wrapping
    the SAME cursor instance, so calls across multiple `with` blocks (as
    `upsert_orders` issues) still land in one shared `executed`/`executed_many`
    log — mirrors `tests/test_master_data.py`'s `_Pool`."""

    def __init__(self, cursor):
        self._cursor = cursor

    @contextmanager
    def connection(self):
        yield _Connection(self._cursor)


def _orders_upsert_params(cursor):
    """The single `INSERT INTO orders (...) ... RETURNING` executemany()
    call's params_list — one bound tuple per upserted row, in `_UPSERT_SQL`
    column order (`id`, then `db._UPSERT_ROW_COLS`, then `batch_id`)."""
    return next(p for s, p in cursor.executed_many if "INSERT INTO orders (" in s)


def _col_index(col: str) -> int:
    """Index of `col` within one upsert row tuple — offset by 1 since `id` is
    prepended ahead of `db._UPSERT_ROW_COLS` in `_UPSERT_SQL`'s VALUES list."""
    return db._UPSERT_ROW_COLS.index(col) + 1


RUN_TIME_IDX = _col_index("run_time")
PROD_VER_IDX = _col_index("production_version")


# ---------------------------------------------------------------------------
# 1. File run-time column ignored on an enabled plant, unchanged on a disabled one.
# ---------------------------------------------------------------------------
def test_run_time_forced_null_on_enabled_plant_unchanged_on_disabled(monkeypatch):
    cursor = _Cursor(enabled_plants={"E1"})
    monkeypatch.setattr(db, "_pool", _Pool(cursor))

    rows = [
        {"id": "ROW-E", "production_order": "PO-E", "material_number": "MAT-E",
         "machine": "MC-E", "plant": "E1", "run_time": 5.0},
        {"id": "ROW-D", "production_order": "PO-D", "material_number": "MAT-D",
         "machine": "MC-D", "plant": "D1", "run_time": 7.5},
    ]
    db.upsert_orders(rows, batch_id="batch-1", source="excel", filename="f.xlsx")

    by_id = {t[0]: t for t in _orders_upsert_params(cursor)}
    assert by_id["ROW-E"][RUN_TIME_IDX] is None, \
        "enabled-plant row's file-supplied run_time must be forced to NULL before upsert"
    assert by_id["ROW-D"][RUN_TIME_IDX] == 7.5, \
        "disabled-plant row must keep its file-supplied run_time exactly as before"


# ---------------------------------------------------------------------------
# 2. PRODUCTION_VERSION COALESCE behavior (_stamp_order_attributes).
# ---------------------------------------------------------------------------
def test_stamp_order_attributes_pins_the_coalesce_nullif_fix_batch_scoped():
    """batch_id-scoped path: the UPDATE's production_version assignment must
    read COALESCE(NULLIF(o.production_version, ''), mp.default_production_version)
    — NULLIF turns a blank upload value into NULL first, so COALESCE only
    falls back to the Material Plant default when the order's own value is
    genuinely missing or blank; a non-blank value (from the file, or a
    planner's prior NIMBUS edit) passes NULLIF unchanged and is never
    overwritten."""
    cursor = _Cursor()
    conn = _Connection(cursor)

    db._stamp_order_attributes(conn, batch_id="batch-1")

    update_stmt, params = cursor.executed[0]
    assert "COALESCE(NULLIF(o.production_version, ''), mp.default_production_version)" in update_stmt
    assert params == ("batch-1",)


def test_stamp_order_attributes_pins_the_coalesce_nullif_fix_plant_scoped():
    """Same fix, plant-scoped path (POST /master-data/resync-order-attributes)."""
    cursor = _Cursor()
    conn = _Connection(cursor)

    db._stamp_order_attributes(conn, plant="5501")

    update_stmt, params = cursor.executed[0]
    assert "COALESCE(NULLIF(o.production_version, ''), mp.default_production_version)" in update_stmt
    assert params == ("5501",)


# ---------------------------------------------------------------------------
# 3. Zero-padding gated to enabled plants only.
# ---------------------------------------------------------------------------
def test_production_version_zero_padded_only_for_enabled_plant(monkeypatch):
    cursor = _Cursor(enabled_plants={"E1"})
    monkeypatch.setattr(db, "_pool", _Pool(cursor))

    rows = [
        {"id": "ROW-E", "production_order": "PO-E", "material_number": "MAT-E",
         "machine": "MC-E", "plant": "E1", "production_version": "7"},
        {"id": "ROW-D", "production_order": "PO-D", "material_number": "MAT-D",
         "machine": "MC-D", "plant": "D1", "production_version": "7"},
    ]
    db.upsert_orders(rows, batch_id="batch-2", source="excel", filename="f.xlsx")

    by_id = {t[0]: t for t in _orders_upsert_params(cursor)}
    assert by_id["ROW-E"][PROD_VER_IDX] == "0007", \
        "enabled-plant row's production_version must be zero-padded to 4 chars"
    assert by_id["ROW-D"][PROD_VER_IDX] == "7", \
        "disabled-plant row's production_version must pass through completely untouched"


# ---------------------------------------------------------------------------
# 4. New orders on an enabled plant arrive held.
# ---------------------------------------------------------------------------
def test_new_order_on_enabled_plant_held_existing_order_untouched(monkeypatch):
    cursor = _Cursor(
        enabled_plants={"E1"},
        insert_flags={"NEW-E": True, "EXIST-E": False, "NEW-D": True},
    )
    monkeypatch.setattr(db, "_pool", _Pool(cursor))

    rows = [
        {"id": "NEW-E", "production_order": "PO1", "material_number": "M1",
         "machine": "MC1", "plant": "E1", "run_time": 1.0},
        {"id": "EXIST-E", "production_order": "PO2", "material_number": "M2",
         "machine": "MC2", "plant": "E1", "run_time": 1.0},
        {"id": "NEW-D", "production_order": "PO3", "material_number": "M3",
         "machine": "MC3", "plant": "D1", "run_time": 1.0},
    ]
    db.upsert_orders(rows, batch_id="batch-3", source="excel", filename="f.xlsx")

    hold_calls = [(s, p) for s, p in cursor.executed if "runtime_pending" in s]
    assert len(hold_calls) == 1, "one set-based hold UPDATE, not one per row"
    _, params = hold_calls[0]
    held_ids, held_plants = params
    assert held_ids == ["NEW-E", "NEW-D"], \
        "every genuinely fresh insert this batch is a candidate, regardless of plant"
    assert held_plants == ["E1"], \
        "but the query's own plant filter restricts the UPDATE to enabled plants only " \
        "(NEW-D's id is present in the id list yet excluded by AND plant = ANY(['E1']))"


def test_no_hold_update_when_no_fresh_inserts(monkeypatch):
    """A batch that only updates pre-existing orders must never touch
    planning_status/planning_reason via this mechanism."""
    cursor = _Cursor(enabled_plants={"E1"}, insert_flags={"EXIST-E": False})
    monkeypatch.setattr(db, "_pool", _Pool(cursor))

    rows = [{"id": "EXIST-E", "production_order": "PO1", "material_number": "M1",
             "machine": "MC1", "plant": "E1", "run_time": 1.0}]
    db.upsert_orders(rows, batch_id="batch-4", source="excel", filename="f.xlsx")

    assert not any("runtime_pending" in s for s, _ in cursor.executed)


def test_no_hold_update_when_plant_disabled(monkeypatch):
    """A brand-new order on a plant whose switch is off must never be held by
    this mechanism (routing_enabled_plants is empty)."""
    cursor = _Cursor(enabled_plants=set())
    monkeypatch.setattr(db, "_pool", _Pool(cursor))

    rows = [{"id": "NEW-D", "production_order": "PO1", "material_number": "M1",
             "machine": "MC1", "plant": "D1", "run_time": 1.0}]
    db.upsert_orders(rows, batch_id="batch-5", source="excel", filename="f.xlsx")

    assert not any("runtime_pending" in s for s, _ in cursor.executed)


# ---------------------------------------------------------------------------
# 5. runtime_schedule_mismatch no longer flags every re-upload.
# ---------------------------------------------------------------------------
def test_upsert_sql_no_longer_blanket_flags_runtime_mismatch():
    """The old condition — flag if EXCLUDED.run_time IS DISTINCT FROM
    orders.run_time AND scheduled_start IS NOT NULL — must be gone from
    _UPSERT_SQL; only a plain carry-forward (COALESCE(...,FALSE)) remains, so
    only the resolver's own write (backend/routing/resolver.py, elsewhere) may
    ever set this flag now."""
    # Review round (H10/D33): the ONLY exception is a scheduled distribution child,
    # i.e. the flag CASE is gated on a parent link; ordinary orders carry forward.
    flag = db._UPSERT_SQL.split("runtime_schedule_mismatch = CASE", 1)[1].split("ELSE COALESCE", 1)[0]
    assert "orders.parent_production_order IS NOT NULL" in flag
    assert "COALESCE(orders.runtime_schedule_mismatch, FALSE)" in db._UPSERT_SQL


# ---------------------------------------------------------------------------
# 6. resolve_fn seam.
# ---------------------------------------------------------------------------
def test_resolve_fn_called_once_per_plant_after_apply_before_audit(monkeypatch):
    cursor = _Cursor()
    monkeypatch.setattr(db, "_pool", _Pool(cursor))

    calls = []

    def fake_plan(rows, batch_id):
        # A non-empty parents dict so apply_fn's own non-empty-plan guard fires.
        return rows, {"parents": {"p1": {}}}, {}

    def fake_apply(plan_structure, batch_id, conn, *, actor="system"):
        calls.append("apply")
        assert plan_structure == {"parents": {"p1": {}}}
        return {"warnings_entry": {"level": "info", "msg": "fake apply ran"}}

    resolve_calls = []

    def fake_resolve(plant, *, conn, batch_id=None):
        calls.append(f"resolve:{plant}")
        resolve_calls.append(plant)
        assert "apply" in calls, "resolve_fn must run after apply_fn"
        assert not any("INSERT INTO upload_audit" in s for s, _ in cursor.executed), \
            "resolve_fn must run before the upload_audit INSERT"
        return {"resolved": 1, "unknown_by_step": {}}

    rows = [
        {"id": "A1", "production_order": "PO1", "material_number": "M1",
         "machine": "MC1", "plant": "5501", "run_time": 3.0},
        {"id": "A2", "production_order": "PO2", "material_number": "M2",
         "machine": "MC2", "plant": "5501", "run_time": 4.0},
        {"id": "B1", "production_order": "PO3", "material_number": "M3",
         "machine": "MC3", "plant": "5502", "run_time": 5.0},
    ]
    result = db.upsert_orders(
        rows, batch_id="batch-6", source="excel", filename="f.xlsx",
        plan_fn=fake_plan, apply_fn=fake_apply, resolve_fn=fake_resolve,
    )

    assert sorted(resolve_calls) == ["5501", "5502"], \
        "called once per DISTINCT affected plant, not once per row"
    assert calls[0] == "apply", "apply_fn must run before any resolve_fn call"
    assert set(calls[1:]) == {"resolve:5501", "resolve:5502"}

    resolve_warnings = [w for w in result["warnings"] if w.get("category") == "routing_resolve"]
    assert {w["plant"] for w in resolve_warnings} == {"5501", "5502"}
    for w in resolve_warnings:
        assert w["level"] == "info"
        assert w["resolved"] == 1
    assert {"level": "info", "msg": "fake apply ran"} in result["warnings"]


# ---------------------------------------------------------------------------
# 7. D04: plan()'s own warnings_entry surfaces when no parent was planned.
# ---------------------------------------------------------------------------
def test_distribution_warnings_entry_surfaces_when_plan_has_no_parents_but_warned(monkeypatch):
    """No parent was planned this batch -- apply_fn must NOT run (same guard
    TestUpsertOrdersDistributionSeamWiring.test_apply_fn_skipped_when_plan_has_no_parents
    pins in tests/test_distribution.py) -- but plan_fn still raised a real
    ingest-time warning (conflicting_parent_rows here): plan_structure's own
    `warnings_entry` must still land in the upload's warnings list instead of
    being silently dropped."""
    cursor = _Cursor()
    monkeypatch.setattr(db, "_pool", _Pool(cursor))

    warnings_entry = {
        "category": "distribution", "level": "warn",
        "msg": "No aggregate orders distributed this batch",
        "conflicting_parent_rows": [{"production_order": "PO1", "material_number": "M1"}],
    }

    def fake_plan(rows, batch_id):
        return (
            rows,
            {"parents": {}, "warnings_entry": warnings_entry},
            {"conflicting_parent_rows": [{"production_order": "PO1", "material_number": "M1"}],
             "single_rewrites": 0},
        )

    def fake_apply(*args, **kwargs):
        raise AssertionError("apply_fn must not be called for an empty plan")

    rows = [{"id": "A1", "production_order": "PO1", "material_number": "M1",
             "machine": "MC1", "plant": "5501", "run_time": 3.0}]
    result = db.upsert_orders(
        rows, batch_id="batch-7", source="excel", filename="f.xlsx",
        plan_fn=fake_plan, apply_fn=fake_apply,
    )

    assert warnings_entry in result["warnings"]


def test_distribution_warnings_entry_not_surfaced_when_only_single_rewrites(monkeypatch):
    """A batch whose only ingest-time count is single_rewrites (a routine
    machine-code rewrite, not itself warn-worthy) must NOT surface plan()'s
    zero-counter entry -- `single_rewrites` is explicitly excluded from the
    "any warning list non-empty" check."""
    cursor = _Cursor()
    monkeypatch.setattr(db, "_pool", _Pool(cursor))

    warnings_entry = {
        "category": "distribution", "level": "info",
        "msg": "No aggregate orders distributed this batch",
    }

    def fake_plan(rows, batch_id):
        return rows, {"parents": {}, "warnings_entry": warnings_entry}, {"single_rewrites": 1}

    def fake_apply(*args, **kwargs):
        raise AssertionError("apply_fn must not be called for an empty plan")

    rows = [{"id": "A1", "production_order": "PO1", "material_number": "M1",
             "machine": "MC1", "plant": "5501", "run_time": 3.0}]
    result = db.upsert_orders(
        rows, batch_id="batch-8", source="excel", filename="f.xlsx",
        plan_fn=fake_plan, apply_fn=fake_apply,
    )

    assert warnings_entry not in result["warnings"]


# ---------------------------------------------------------------------------
# sap_changed_fields — pure "did SAP change this order" detection (DB-free)
# ---------------------------------------------------------------------------
class Test_sap_changed_fields:
    from datetime import datetime as _dt
    S0, F0 = _dt(2026, 10, 1, 6), _dt(2026, 10, 2, 6)
    S1, F1 = _dt(2026, 10, 3, 6), _dt(2026, 10, 4, 6)

    def _before(self, **kw):
        base = {
            "sap_basic_start_date": self.S0, "sap_basic_finish_date": self.F0,
            "sap_workcenter": "WC1", "order_quantity": 100,
            "sap_production_version": "0001", "production_version": "0001",
            "scheduled_start": None, "scheduled_end": None,
        }
        base.update(kw)
        return base

    def _incoming(self, **kw):
        base = {
            "basic_start_date": self.S0, "basic_finish_date": self.F0,
            "sap_workcenter": "WC1", "order_quantity": 100,
            "sap_production_version": "0001", "parent_production_order": None,
        }
        base.update(kw)
        return base

    def _run(self, before=None, incoming=None, wc="M1"):
        return db.sap_changed_fields(before or self._before(), incoming or self._incoming(), wc)

    def test_unchanged_returns_empty(self):
        assert self._run() == set()

    def test_dates_changed(self):
        inc = self._incoming(basic_start_date=self.S1, basic_finish_date=self.F1)
        assert self._run(incoming=inc) == {"dates"}

    def test_dates_finish_only_changed(self):
        assert self._run(incoming=self._incoming(basic_finish_date=self.F1)) == {"dates"}

    def test_dates_echo_of_schedule_not_changed(self):
        before = self._before(scheduled_start=self.S1, scheduled_end=self.F1)
        inc = self._incoming(basic_start_date=self.S1, basic_finish_date=self.F1)
        assert self._run(before, inc) == set()

    def test_dates_partial_echo_still_changed(self):
        before = self._before(scheduled_start=self.S1, scheduled_end=self.F0)
        inc = self._incoming(basic_start_date=self.S1, basic_finish_date=self.F1)
        assert self._run(before, inc) == {"dates"}

    def test_dates_echo_needs_both_schedule_values(self):
        before = self._before(scheduled_start=self.S1, scheduled_end=None)
        inc = self._incoming(basic_start_date=self.S1, basic_finish_date=self.F1)
        assert self._run(before, inc) == {"dates"}

    def test_null_date_baselines_not_changed(self):
        before = self._before(sap_basic_start_date=None, sap_basic_finish_date=None)
        inc = self._incoming(basic_start_date=self.S1, basic_finish_date=self.F1)
        assert self._run(before, inc) == set()

    def test_workcenter_changed(self):
        assert self._run(incoming=self._incoming(sap_workcenter="WC2")) == {"workcenter"}

    def test_workcenter_echo_of_current_machine_not_changed(self):
        assert self._run(incoming=self._incoming(sap_workcenter="M9"), wc="M9") == set()

    def test_null_workcenter_baseline_not_changed(self):
        before = self._before(sap_workcenter=None)
        assert self._run(before, self._incoming(sap_workcenter="WC2")) == set()

    def test_quantity_changed(self):
        assert self._run(incoming=self._incoming(order_quantity=120)) == {"quantity"}

    def test_quantity_100_vs_100_0_not_changed(self):
        before = self._before(order_quantity=100)
        assert self._run(before, self._incoming(order_quantity=100.0)) == set()
        before = self._before(order_quantity=Decimal("100.000"))
        assert self._run(before, self._incoming(order_quantity="100.0")) == set()

    def test_quantity_none_safe(self):
        before = self._before(order_quantity=None)
        assert self._run(before, self._incoming(order_quantity=5)) == set()
        assert self._run(incoming=self._incoming(order_quantity=None)) == {"quantity"}

    def test_production_version_changed(self):
        assert self._run(incoming=self._incoming(sap_production_version="0002")) == {"production_version"}

    def test_production_version_blank_vs_value_changed(self):
        assert self._run(incoming=self._incoming(sap_production_version="  ")) == {"production_version"}

    def test_production_version_strip_not_changed(self):
        assert self._run(incoming=self._incoming(sap_production_version=" 0001 ")) == set()

    def test_production_version_echo_of_planner_value_not_changed(self):
        before = self._before(production_version="0007")
        assert self._run(before, self._incoming(sap_production_version="0007")) == set()

    def test_null_production_version_baseline_not_changed(self):
        before = self._before(sap_production_version=None)
        assert self._run(before, self._incoming(sap_production_version="0002")) == set()

    def test_child_row_production_version_ignored(self):
        inc = self._incoming(sap_production_version="0002", parent_production_order="P1")
        assert self._run(incoming=inc) == set()

    def test_child_row_other_fields_still_detected(self):
        inc = self._incoming(sap_production_version="0002", parent_production_order="P1",
                             order_quantity=7)
        assert self._run(incoming=inc) == {"quantity"}

    def test_several_fields_at_once(self):
        inc = self._incoming(basic_start_date=self.S1, sap_workcenter="WC2",
                             order_quantity=1, sap_production_version="0002")
        assert self._run(incoming=inc) == {"dates", "workcenter", "quantity", "production_version"}
