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


import re

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
    # Backward scheduling (OQ34): the flag CASE is gated on the order being PLACED (a stored start, a stored
    # finish or segments), no longer on a parent link; an unplaced order carries the flag forward.
    flag = db._UPSERT_SQL.split("runtime_schedule_mismatch = CASE", 1)[1].split("ELSE COALESCE(orders.runtime_schedule_mismatch", 1)[0]
    assert "orders.parent_production_order" not in flag
    assert "orders.scheduled_start IS NOT NULL" in flag and "orders.scheduled_end IS NOT NULL" in flag
    assert "order_schedule_segments" in flag
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

    def fake_resolve(plant, *, conn, batch_id=None, ids=None, protect_ids=None):
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

    def test_start_only_change_is_not_a_dates_change(self):
        """Backward scheduling OQ25 c: the finish decides. A moved start with the finish unchanged keeps the
        placement, with or without a remembered send."""
        assert self._run(incoming=self._incoming(basic_start_date=self.S1)) == set()
        before = self._before(sap_sent_finish=self.F0, sap_sent_version="0001")
        assert self._run(before, self._incoming(basic_start_date=self.S1)) == set()
        before = self._before(scheduled_start=self.S0, scheduled_end=self.F0)
        assert self._run(before, self._incoming(basic_start_date=self.S1)) == set()

    def test_dates_finish_only_changed(self):
        assert self._run(incoming=self._incoming(basic_finish_date=self.F1)) == {"dates"}

    def test_dates_echo_of_schedule_not_changed(self):
        before = self._before(scheduled_start=self.S1, scheduled_end=self.F1)
        inc = self._incoming(basic_start_date=self.S1, basic_finish_date=self.F1)
        assert self._run(before, inc) == set()

    def test_finish_echo_of_the_placed_finish_is_not_changed_whatever_the_start(self):
        # the placed finish is the anchor: SAP sending it back is an echo even with a different start
        before = self._before(scheduled_start=self.S1, scheduled_end=self.F1)
        assert self._run(before, self._incoming(basic_start_date=self.S0, basic_finish_date=self.F1)) == set()
        assert self._run(before, self._incoming(basic_start_date=None, basic_finish_date=self.F1)) == set()

    def test_dates_partial_echo_still_changed(self):
        before = self._before(scheduled_start=self.S1, scheduled_end=self.F0)
        inc = self._incoming(basic_start_date=self.S1, basic_finish_date=self.F1)
        assert self._run(before, inc) == {"dates"}

    def test_dates_echo_needs_the_placed_finish(self):
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

    def test_partial_conversion_open_shrinks_total_unchanged_not_changed(self):
        """A3: SAP total unchanged, open quantity smaller (partial conversion) is not a change."""
        before = self._before(order_quantity=100, planned_order_initial_quantity=100)
        inc = self._incoming(order_quantity=60, planned_order_initial_quantity=100)
        assert self._run(before, inc) == set()

    def test_total_changed_is_quantity_change_even_if_open_same(self):
        before = self._before(order_quantity=100, planned_order_initial_quantity=100)
        inc = self._incoming(order_quantity=100, planned_order_initial_quantity=130)
        assert self._run(before, inc) == {"quantity"}

    def test_quantity_without_total_falls_back_to_order_quantity(self):
        before = self._before(order_quantity=100, planned_order_initial_quantity=100)
        assert self._run(before, self._incoming(order_quantity=60)) == {"quantity"}

    def test_sap_upsert_sql_is_source_scoped_for_excel_only_columns(self):
        """A1: the SAP statement keeps stored Excel-only columns; the Excel statement is unchanged."""
        for c in db._EXCEL_ONLY_COLS:
            assert re.search(rf"\n\s+{c}\s*= COALESCE\(EXCLUDED\.{c}, orders\.{c}\),", db._UPSERT_SQL_SAP), c
            assert re.search(rf"\n\s+{c}\s*= EXCLUDED\.{c},", db._UPSERT_SQL), c
            assert f"(EXCLUDED.{c} IS NOT NULL AND orders.{c} IS DISTINCT FROM EXCLUDED.{c})" in db._SAP_DIFFERS_SQL_SAP
            assert f"orders.{c} IS DISTINCT FROM EXCLUDED.{c}" in db._SAP_DIFFERS_SQL
            assert f"EXCLUDED.{c} IS NOT NULL AND" not in db._SAP_DIFFERS_SQL
            assert f"COALESCE(EXCLUDED.{c}" not in db._UPSERT_SQL
        assert "(EXCLUDED.material_description IS NOT NULL" in db._UPSERT_SQL_SAP

    def test_quantity_none_safe(self):
        before = self._before(order_quantity=None)
        assert self._run(before, self._incoming(order_quantity=5)) == set()
        assert self._run(incoming=self._incoming(order_quantity=None)) == set()

    def test_incoming_none_dates_not_changed(self):
        assert self._run(incoming=self._incoming(basic_start_date=None)) == set()
        assert self._run(incoming=self._incoming(basic_finish_date=None)) == set()
        inc = self._incoming(basic_start_date=None, basic_finish_date=self.F1)
        assert self._run(incoming=inc) == {"dates"}
        # no start sent and a moved start baseline is not a change either
        assert self._run(self._before(sap_basic_start_date=None), self._incoming(basic_start_date=self.S1)) == set()

    def test_incoming_none_workcenter_not_changed(self):
        assert self._run(incoming=self._incoming(sap_workcenter=None)) == set()

    def test_incoming_none_production_version_not_changed(self):
        assert self._run(incoming=self._incoming(sap_production_version=None)) == set()

    def test_incoming_blank_production_version_is_a_change(self):
        assert self._run(incoming=self._incoming(sap_production_version="")) == {"production_version"}

    def test_production_version_changed(self):
        assert self._run(incoming=self._incoming(sap_production_version="0002")) == {"production_version"}

    def test_production_version_blank_vs_value_changed(self):
        assert self._run(incoming=self._incoming(sap_production_version="  ")) == {"production_version"}

    def test_production_version_strip_not_changed(self):
        assert self._run(incoming=self._incoming(sap_production_version=" 0001 ")) == set()

    def test_production_version_padding_insensitive_not_changed(self):
        # routing switched on: stored baseline '1' vs incoming zero-padded '0001'
        before = self._before(sap_production_version="1", production_version="1")
        assert self._run(before, self._incoming(sap_production_version="0001")) == set()

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
        inc = self._incoming(basic_finish_date=self.F1, sap_workcenter="WC2",
                             order_quantity=1, sap_production_version="0002")
        assert self._run(incoming=inc) == {"dates", "workcenter", "quantity", "production_version"}
        # a moved start alone adds nothing
        inc = self._incoming(basic_start_date=self.S1, sap_workcenter="WC2",
                             order_quantity=1, sap_production_version="0002")
        assert self._run(incoming=inc) == {"workcenter", "quantity", "production_version"}

    # ---- D20 echo suppression (orders.sap_sent_*) -------------------------
    def test_echo_finish_with_moved_start_is_not_a_dates_change(self):
        before = self._before(sap_sent_finish=self.F1, sap_sent_version="0001")
        inc = self._incoming(basic_start_date=self.S1, basic_finish_date=self.F1)
        # F1 differs from the F0 baseline too: without the echo this is "dates"
        assert self._run(before, inc) == set()

    def test_echo_finish_minute_precision_ignores_seconds(self):
        from datetime import timedelta
        before = self._before(sap_sent_finish=self.F1, sap_sent_version="0001")
        inc = self._incoming(basic_start_date=self.S1, basic_finish_date=self.F1 + timedelta(seconds=40))
        assert self._run(before, inc) == set()

    def test_echo_finish_but_different_version_still_reports_version_not_dates(self):
        before = self._before(sap_sent_finish=self.F1, sap_sent_version="0001")
        inc = self._incoming(basic_start_date=self.S1, basic_finish_date=self.F1,
                             sap_production_version="0002")
        assert self._run(before, inc) == {"production_version"}

    def test_echo_with_no_version_sent_suppresses_version_too(self):
        before = self._before(sap_sent_finish=self.F1, sap_sent_version=None)
        inc = self._incoming(basic_start_date=self.S1, basic_finish_date=self.F1,
                             sap_production_version="0002")
        assert self._run(before, inc) == set()

    def test_different_finish_than_sent_is_a_dates_change(self):
        before = self._before(sap_sent_finish=self.F1, sap_sent_version="0001")
        inc = self._incoming(basic_start_date=self.S1, basic_finish_date=self.F1.replace(hour=9))
        assert self._run(before, inc) == {"dates"}

    def test_no_sent_finish_behaves_as_before(self):
        before = self._before(sap_sent_finish=None, sap_sent_version="0001")
        inc = self._incoming(basic_start_date=self.S1, basic_finish_date=self.F1)
        assert self._run(before, inc) == {"dates"}

    def test_echo_finish_returned_as_date_only_midnight_matches_sent_date(self):
        from datetime import datetime as _d
        # L1: SAP echoed the finish as a date only (time 000000 -> plant-local midnight).
        before = self._before(sap_sent_finish=_d(2026, 11, 1, 19, 0), sap_sent_version="0001")
        inc = self._incoming(basic_start_date=self.S1, basic_finish_date=_d(2026, 11, 1, 0, 0))
        assert self._run(before, inc) == set()

    def test_midnight_finish_on_another_date_is_still_a_dates_change(self):
        from datetime import datetime as _d
        before = self._before(sap_sent_finish=_d(2026, 11, 1, 19, 0), sap_sent_version="0001")
        inc = self._incoming(basic_start_date=self.S1, basic_finish_date=_d(2026, 11, 3, 0, 0))
        assert self._run(before, inc) == {"dates"}

    def test_echo_does_not_hide_workcenter_or_quantity_changes(self):
        before = self._before(sap_sent_finish=self.F1, sap_sent_version="0001")
        inc = self._incoming(basic_start_date=self.S1, basic_finish_date=self.F1,
                             sap_workcenter="WC2", order_quantity=5)
        assert self._run(before, inc) == {"workcenter", "quantity"}


# ---------------------------------------------------------------------------
# finish_echoes -- the one echo rule, judged in the SAP frame (DB-free)
# ---------------------------------------------------------------------------
class Test_finish_echoes:
    """Backward-scheduling Task 1.2. SAP's own zone is `UTC`; Chicago is UTC-5 in October (CDT) and New York
    UTC-4 (EDT), so the SAME wall-clock finish lands on different SAP-frame calendar dates."""
    from datetime import datetime as _dt
    SENT = _dt(2026, 10, 22, 19, 0)         # Thu 22 Oct 19:00 plant-local
    FRI = _dt(2026, 10, 23, 0, 0)           # SAP's date-only echo of the finish: Fri 23 Oct
    SAT = _dt(2026, 10, 24, 0, 0)

    def test_m1_chicago_date_only_next_day_is_an_echo(self):
        # 19:00 CDT = 00:00 UTC Friday: SAP reads our Thursday evening finish as Friday
        assert db.finish_echoes(self.FRI, True, self.SENT, "UTC", "America/Chicago") is True

    def test_m1_chicago_sap_changed_fields_reports_no_dates(self):
        before = {"sap_basic_start_date": Test_sap_changed_fields.S0, "sap_basic_finish_date": Test_sap_changed_fields.F0,
                  "sap_workcenter": "WC1", "order_quantity": 100, "sap_production_version": "0001",
                  "production_version": "0001", "scheduled_start": None, "scheduled_end": None,
                  "sap_sent_finish": self.SENT, "sap_sent_version": "0001", "tz": "America/Chicago"}
        inc = {"basic_start_date": Test_sap_changed_fields.S1, "basic_finish_date": self.FRI,
               "_finish_date_only": True, "sap_workcenter": "WC1", "order_quantity": 100,
               "sap_production_version": "0001", "parent_production_order": None}
        assert db.sap_changed_fields(before, inc, "M1", sap_tz="UTC") == set()

    def test_genuine_change_date_only_two_days_later_is_not_an_echo(self):
        assert db.finish_echoes(self.SAT, True, self.SENT, "UTC", "America/Chicago") is False

    def test_genuine_change_sap_changed_fields_reports_dates(self):
        before = {"sap_basic_start_date": Test_sap_changed_fields.S0, "sap_basic_finish_date": Test_sap_changed_fields.F0,
                  "sap_workcenter": "WC1", "order_quantity": 100, "sap_production_version": "0001",
                  "production_version": "0001", "scheduled_start": None, "scheduled_end": None,
                  "sap_sent_finish": self.SENT, "sap_sent_version": "0001", "tz": "America/Chicago"}
        inc = {"basic_start_date": Test_sap_changed_fields.S1, "basic_finish_date": self.SAT,
               "_finish_date_only": True, "sap_workcenter": "WC1", "order_quantity": 100,
               "sap_production_version": "0001", "parent_production_order": None}
        assert db.sap_changed_fields(before, inc, "M1", sap_tz="UTC") == {"dates"}

    def test_timed_echo_to_the_minute(self):
        from datetime import timedelta
        # the incoming timed value is plant-local (already converted from the SAP zone by the staging parser)
        assert db.finish_echoes(self.SENT + timedelta(seconds=40), False, self.SENT, "UTC", "America/Chicago") is True
        assert db.finish_echoes(self.SENT + timedelta(minutes=1), False, self.SENT, "UTC", "America/Chicago") is False

    def test_no_sent_finish_is_never_an_echo(self):
        assert db.finish_echoes(self.FRI, True, None, "UTC", "America/Chicago") is False
        assert db.finish_echoes(self.SENT, False, None, "UTC", "America/Chicago") is False

    def test_no_incoming_finish_is_never_an_echo(self):
        assert db.finish_echoes(None, True, self.SENT, "UTC", "America/Chicago") is False

    def test_new_york_variant_is_not_an_echo(self):
        # 19:00 EDT = 23:00 UTC Thursday: the SAP-frame date is still Thu 22, so Friday is NOT an echo
        assert db.finish_echoes(self.FRI, True, self.SENT, "UTC", "America/New_York") is False
        assert db.finish_echoes(self._dt(2026, 10, 22), True, self.SENT, "UTC", "America/New_York") is True

    def test_unknown_sap_zone_uses_the_plant_frame(self):
        # Excel path: no SAP zone of its own, so SAP's frame is the plant's frame
        assert db.finish_echoes(self._dt(2026, 10, 22), True, self.SENT, None, "America/Chicago") is True
        assert db.finish_echoes(self.FRI, True, self.SENT, None, "America/Chicago") is False

    def test_plant_without_timezone_compares_naively(self):
        assert db.finish_echoes(self._dt(2026, 10, 22), True, self.SENT, "UTC", None) is True
        assert db.finish_echoes(self.FRI, True, self.SENT, "UTC", None) is False

    def test_date_only_defaults_to_midnight_inference_in_sap_changed_fields(self):
        # no `_finish_date_only` key (Excel path / old callers): time 00:00:00 means date only
        before = {"sap_basic_start_date": Test_sap_changed_fields.S0, "sap_basic_finish_date": Test_sap_changed_fields.F0,
                  "sap_workcenter": "WC1", "order_quantity": 100, "sap_production_version": "0001",
                  "production_version": "0001", "scheduled_start": None, "scheduled_end": None,
                  "sap_sent_finish": self._dt(2026, 11, 1, 19, 0), "sap_sent_version": "0001"}
        inc = {"basic_start_date": Test_sap_changed_fields.S1, "basic_finish_date": self._dt(2026, 11, 1),
               "sap_workcenter": "WC1", "order_quantity": 100, "sap_production_version": "0001",
               "parent_production_order": None}
        assert db.sap_changed_fields(before, inc, "M1") == set()

    def test_staging_reexport_is_the_same_function(self):
        import backend.integration.sap_staging as st
        assert st.finish_echoes is db.finish_echoes


# ---------------------------------------------------------------------------
# D20 (refined): a planner's end/version change does NOT clear what was remembered as sent to SAP.
# ---------------------------------------------------------------------------
class _BulkCursor:
    """Answers update_task_dates_bulk's lock SELECT with one canned row and
    records every other statement; fetchone/fetchall return harmless empties."""

    def __init__(self, eff_row):
        self.eff_row = eff_row
        self.executed = []
        self._all = []
        self._one = (0,)

    def execute(self, stmt, params=None):
        stmt = str(stmt)
        self.executed.append((stmt, params))
        self._one = (0,)
        if "FOR UPDATE OF o" in stmt:
            self._all = [self.eff_row]
        elif stmt.lstrip().startswith("UPDATE orders o SET"):
            self._all = [(self.eff_row[0], 4242)]
        else:
            self._all = []

    def executemany(self, stmt, params_list, returning=False):
        self.executed.append((str(stmt), params_list))

    def fetchall(self):
        return self._all

    def fetchone(self):
        return self._one


def _bulk_eff_row(oid="O1"):
    from datetime import datetime as _d
    # id, eff_start, eff_end, run_time, row_version, segment_count, plant, machine,
    # planning_status, reason_code, routing_runtime_enabled, parent_order,
    # run_time_source, material_number, order_quantity, basic_start_date, production_version
    return (oid, _d(2026, 10, 1, 6), _d(2026, 10, 1, 14), 8.0, 7, 0, "P1", "M1",
            "scheduled", None, False, None, None, "MAT", 100,
            _d(2026, 10, 1, 6), "0001", None, None, None, None)


def _run_bulk(monkeypatch, item):
    cursor = _BulkCursor(_bulk_eff_row())
    monkeypatch.setattr(db, "_pool", _Pool(cursor))
    db.update_task_dates_bulk([{"id": "O1", **item}])
    return next(s for s, _p in cursor.executed if s.lstrip().startswith("UPDATE orders o SET"))


def test_bulk_save_keeps_sap_sent_when_end_changes(monkeypatch):
    from datetime import datetime as _d
    sql = _run_bulk(monkeypatch, {"start": _d(2026, 10, 1, 7), "end": _d(2026, 10, 1, 15)})
    assert "sap_sent_" not in sql          # D20 refinement: only the next Send overwrites them


def test_bulk_save_keeps_sap_sent_when_end_unchanged(monkeypatch):
    from datetime import datetime as _d
    # same end as the current row (14:00), only the start moves (a 7 h bar for an 8 h run time: a deliberate
    # placement exception, so the width check stands down)
    sql = _run_bulk(monkeypatch, {"start": _d(2026, 10, 1, 7), "end": _d(2026, 10, 1, 14),
                                  "placement_exception": "overlong"})
    assert "sap_sent_" not in sql


def test_bulk_save_keeps_sap_sent_when_production_version_changes(monkeypatch):
    sql = _run_bulk(monkeypatch, {"PRODUCTION_VERSION": "0002"})
    assert "sap_sent_" not in sql


def test_bulk_save_keeps_sap_sent_when_version_resent_unchanged(monkeypatch):
    sql = _run_bulk(monkeypatch, {"PRODUCTION_VERSION": "0001", "FIRMED": True})
    assert "sap_sent_" not in sql
