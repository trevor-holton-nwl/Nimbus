"""schedule_event foundation: pure helper tests, DDL pinning, and @pytest.mark.pg tests for the table,
`record`, the retention sweep and the read route."""
import datetime as dt
import math
import os
import re
import uuid
from decimal import Decimal

import pytest

from backend.schedule_events import events
from backend.schedule_events.events import (
    EventCtx, EventRow, as_action_id, diff_tracked, dumps, record, snapshot_changes, _ev_scalar,
)
from tests.support.planning_pg import cleanup_schedule_events

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIGRATION = os.path.join(ROOT, "migrations", "2026-10-23-1-schedule-event.sql")
SCHEMA = os.path.join(ROOT, "schema.sql")
DESTRUCTIVE = re.compile(r"\b(ALTER|DROP|DELETE|UPDATE|TRUNCATE|RENAME|GRANT|REVOKE)\b", re.IGNORECASE)


# --------------------------------------------------------------------------- _ev_scalar

def test_ev_scalar_decimal_integral_becomes_int():
    out = _ev_scalar(Decimal("2.00"))
    assert out == 2 and isinstance(out, int) and not isinstance(out, bool)


def test_ev_scalar_decimal_fraction_becomes_float():
    out = _ev_scalar(Decimal("2.50"))
    assert out == 2.5 and isinstance(out, float)


def test_ev_scalar_naive_datetime_isoformat_seconds():
    assert _ev_scalar(dt.datetime(2026, 10, 23, 8, 30, 15, 123456)) == "2026-10-23T08:30:15"


def test_ev_scalar_date():
    assert _ev_scalar(dt.date(2026, 10, 23)) == "2026-10-23"


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf"),
                                 Decimal("NaN"), Decimal("Infinity")])
def test_ev_scalar_non_finite_is_none(bad):
    assert _ev_scalar(bad) is None


def test_ev_scalar_passthrough():
    assert _ev_scalar(True) is True
    assert _ev_scalar(False) is False
    assert _ev_scalar("abc") == "abc"
    assert _ev_scalar(7) == 7
    assert _ev_scalar(None) is None


def test_dumps_handles_decimal_datetime_nan_and_strips_nul():
    text = dumps({"a": [Decimal("1.0"), Decimal("1.5")], "b": [dt.datetime(2026, 1, 2, 3, 4, 5), float("nan")],
                  "c": ["x\x00y"]})
    assert text == '{"a":[1,1.5],"b":["2026-01-02T03:04:05",null],"c":["xy"]}'


# --------------------------------------------------------------------------- diff_tracked

def test_diff_none_equals_empty_string():
    assert diff_tracked({"notes": None}, {"notes": ""}) is None
    assert diff_tracked({"notes": "  "}, {"notes": None}) is None


def test_diff_decimal_vs_int_equal():
    assert diff_tracked({"run_time": Decimal("1.000")}, {"run_time": 1}) is None
    assert diff_tracked({"order_quantity": Decimal("2.0")}, {"order_quantity": Decimal("2.00")}) is None


def test_diff_compares_only_keys_in_after():
    assert diff_tracked({"machine": "L1", "notes": "a"}, {"machine": "L1"}) is None


def test_diff_returns_before_after_pair():
    d = diff_tracked({"machine": "L1", "run_time": Decimal("2.0")},
                     {"machine": "L2", "run_time": Decimal("2.50")})
    assert d == {"machine": ["L1", "L2"], "run_time": [2, 2.5]}


def test_diff_strips_strings_and_serialises_datetimes():
    before = {"scheduled_end": dt.datetime(2026, 10, 23, 8, 0, 0), "planning_status": " ok "}
    after = {"scheduled_end": dt.datetime(2026, 10, 23, 9, 0, 0), "planning_status": "ok"}
    assert diff_tracked(before, after) == {"scheduled_end": ["2026-10-23T08:00:00", "2026-10-23T09:00:00"]}


def test_diff_bool_is_not_numeric():
    assert diff_tracked({"manual_firmed": 1}, {"manual_firmed": True}) == {"manual_firmed": [1, True]}
    assert diff_tracked({"manual_firmed": False}, {"manual_firmed": False}) is None


def test_diff_with_no_before_reports_all_non_null_as_changes():
    assert diff_tracked(None, {"machine": "L1"}) == {"machine": [None, "L1"]}


# --------------------------------------------------------------------------- snapshot_changes

def test_snapshot_create_and_remove():
    row = {"machine": "L1", "notes": None, "run_time": Decimal("3.0"), "segments": 2, "unrelated": "zz"}
    assert snapshot_changes(row, op="create") == {"machine": [None, "L1"], "run_time": [None, 3],
                                                  "segments": [None, 2]}
    assert snapshot_changes(row, op="remove") == {"machine": ["L1", None], "run_time": [3, None],
                                                  "segments": [2, None]}


def test_snapshot_rejects_modify():
    with pytest.raises(ValueError):
        snapshot_changes({"machine": "L1"}, op="modify")


# --------------------------------------------------------------------------- ids and vocab

def test_as_action_id_keeps_valid_uuid_and_replaces_garbage():
    good = str(uuid.uuid4())
    assert as_action_id(good) == good
    assert as_action_id(uuid.UUID(good)) == good
    for bad in ("not-a-uuid", "", None, 123):
        out = as_action_id(bad)
        assert str(uuid.UUID(out)) == out and out != bad


def test_op_vocabulary_avoids_destructive_words():
    assert events.OPS == {"create", "modify", "remove"}
    assert not any(DESTRUCTIVE.search(op) for op in events.OPS)
    assert events.PLANNER_SOURCES <= events.SOURCES
    assert "segments" in events.TRACKED_FIELDS and "o.segments" not in events.TRACKED_COLS_SQL


# --------------------------------------------------------------------------- record (fake cursor)

class FakeCur:
    def __init__(self, fail_on=None):
        self.calls = []
        self.fail_on = fail_on

    def execute(self, sql, params=None):
        self.calls.append((sql.strip(), params))
        if self.fail_on and self.fail_on in sql:
            raise RuntimeError("boom")


def _ctx(**kw):
    base = dict(source="drag", actor="a@example.com", action_id=str(uuid.uuid4()), client_id="c1")
    base.update(kw)
    return EventCtx(**base)


def _row(order_id="o1", changes=None, **kw):
    return EventRow(plant="P1", order_id=order_id, production_order="PO1", material_number="M1", op="modify",
                    changes={"machine": ["L1", "L2"]} if changes is None else changes, **kw)


def test_record_none_ctx_returns_zero_without_touching_cursor():
    cur = FakeCur()
    assert record(cur, None, [_row()]) == 0
    assert cur.calls == []


def test_record_skips_empty_changes_rows():
    cur = FakeCur()
    assert record(cur, _ctx(), [_row("o1", changes={}), _row("o2", changes={})]) == 0
    assert cur.calls == []
    assert record(cur, _ctx(), [_row("o1", changes={}), _row("o2")]) == 1
    insert = [c for c in cur.calls if c[0].startswith("INSERT INTO schedule_event")]
    assert len(insert) == 1 and insert[0][1]["order_ids"] == ["o2"]


def test_record_savepoint_sequence_and_unknown_source_coerced():
    cur = FakeCur()
    n = record(cur, _ctx(source="bogus"), [_row("o1", source="also-bogus"), _row("o2", source="note")])
    assert n == 2
    assert [c[0] for c in cur.calls if not c[0].startswith("INSERT")] == [
        "SAVEPOINT sched_ev", "RELEASE SAVEPOINT sched_ev"]
    params = [c[1] for c in cur.calls if c[0].startswith("INSERT")][0]
    assert params["sources"] == ["unknown", "note"]
    assert params["changes"] == ['{"machine":["L1","L2"]}'] * 2
    assert params["actor"] == "a@example.com" and params["client_id"] == "c1"


def test_record_swallows_insert_failure_rolls_back_savepoint_and_counts():
    cur = FakeCur(fail_on="INSERT INTO schedule_event")
    seen = []
    events.set_failure_hook(seen.append)
    before = events.write_failures()
    try:
        assert record(cur, _ctx(), [_row()]) == 0
    finally:
        events.set_failure_hook(None)
    sqls = [c[0] for c in cur.calls]
    assert "SAVEPOINT sched_ev" in sqls and "ROLLBACK TO SAVEPOINT sched_ev" in sqls
    assert events.write_failures() == before + 1
    assert seen == [before + 1]


def test_record_with_unserialisable_changes_is_fail_open():
    class Weird:
        def __str__(self):
            raise RuntimeError("no str")
    cur = FakeCur()
    before = events.write_failures()
    assert record(cur, _ctx(), [_row(changes={"machine": [Weird(), "x"]})]) == 0
    assert events.write_failures() == before + 1


# --------------------------------------------------------------------------- DDL pinning

def _create_table_stmt(text):
    start = text.index("CREATE TABLE IF NOT EXISTS schedule_event (")
    end = text.index("autovacuum_analyze_scale_factor = 0.05);", start) + len("autovacuum_analyze_scale_factor = 0.05);")
    return text[start:end]


def test_ddl_constant_matches_migration_and_schema_verbatim():
    import backend.schedule_events.data as data
    stmt = _create_table_stmt(data.SCHEDULE_EVENT_DDL)
    for path in (MIGRATION, SCHEMA):
        with open(path, encoding="utf-8") as f:
            text = f.read()
        assert stmt in text, path
        for idx in ("CREATE INDEX IF NOT EXISTS idx_schedule_event_order ON schedule_event (plant, order_id, id DESC);",
                    "CREATE INDEX IF NOT EXISTS idx_schedule_event_at    ON schedule_event (at);"):
            assert idx in text, (path, idx)
            assert idx in data.SCHEDULE_EVENT_DDL


def test_ddl_constant_has_no_destructive_words():
    import backend.schedule_events.data as data
    assert not DESTRUCTIVE.search(data.SCHEDULE_EVENT_DDL)


# --------------------------------------------------------------------------- retention getter (pure)

def test_retention_getter_coerces_clamps_and_never_raises(monkeypatch):
    import master_data as md
    monkeypatch.setattr(md, "_retention_bad_logged", False)
    cases = [({}, 14), ({"schedule_event_retention_days": 30}, 30), ({"schedule_event_retention_days": "21"}, 21),
             ({"schedule_event_retention_days": 0}, 1), ({"schedule_event_retention_days": -5}, 1),
             ({"schedule_event_retention_days": 999}, 60), ({"schedule_event_retention_days": "abc"}, 14),
             ({"schedule_event_retention_days": True}, 14), ({"schedule_event_retention_days": None}, 14)]
    for settings, expected in cases:
        monkeypatch.setattr(md, "get_system_settings", lambda s=settings: s)
        assert md.get_schedule_event_retention_days() == expected, settings

    def boom():
        raise RuntimeError("db down")
    monkeypatch.setattr(md, "get_system_settings", boom)
    assert md.get_schedule_event_retention_days() == 14


# --------------------------------------------------------------------------- pg tests

@pytest.fixture
def se(pg):
    token = uuid.uuid4().hex[:10]
    ctx = type("Ctx", (), {})()
    ctx.db = pg
    ctx.plant = f"ZZTEST_SE_{token}"
    ctx.other = f"ZZTEST_SE_{token}_B"
    ctx.actor = f"zztest.se.{token}@example.com"
    ctx.token = token
    import backend.schedule_events.data as data
    data.ensure_schedule_event_table()
    try:
        yield ctx
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cleanup_schedule_events(cur, actor=ctx.actor, plants=[ctx.plant, ctx.other])
            cur.execute("DELETE FROM user_security WHERE username = %s", (ctx.actor,))


def _write(se, rows, *, source="drag", actor=None, action_id=None):
    ev = EventCtx(source=source, actor=actor or se.actor, action_id=action_id or str(uuid.uuid4()),
                  client_id="zz-client")
    with se.db._pool.connection() as conn, conn.cursor() as cur:
        n = record(cur, ev, rows)
        conn.commit()
    return n


@pytest.mark.pg
def test_ensure_schedule_event_table_twice_is_structural_noop(se):
    from tests.test_schema_idempotent import _schema_fingerprint
    import backend.schedule_events.data as data
    with se.db._pool.connection() as conn, conn.cursor() as cur:
        data.ensure_schedule_event_table()
        before = _schema_fingerprint(cur)
        data.ensure_schedule_event_table()
        after = _schema_fingerprint(cur)
    assert before == after
    assert any(r[0] == "schedule_event" for r in before["columns"])
    names = {r[1] for r in before["indexes"] if r[0] == "schedule_event"}
    assert {"idx_schedule_event_order", "idx_schedule_event_at"} <= names


@pytest.mark.pg
def test_record_rows_are_listed_newest_first_with_paging(se):
    import backend.schedule_events.data as data
    for i in range(5):
        n = _write(se, [EventRow(plant=se.plant, order_id="ord-1", production_order="PO1", material_number="M1",
                                 op="modify", changes={"machine": [f"L{i}", f"L{i + 1}"]})])
        assert n == 1
    _write(se, [EventRow(plant=se.plant, order_id="ord-2", production_order="PO2", material_number="M2",
                         op="create", changes={"machine": [None, "L9"]})])
    page1 = data.list_order_events(se.plant, "ord-1", limit=2)
    assert [e["changes"]["machine"][0] for e in page1["events"]] == ["L4", "L3"]
    assert page1["next_before_id"] == page1["events"][-1]["id"]
    ids = [e["id"] for e in page1["events"]]
    assert ids == sorted(ids, reverse=True)
    page2 = data.list_order_events(se.plant, "ord-1", limit=2, before_id=page1["next_before_id"])
    assert [e["changes"]["machine"][0] for e in page2["events"]] == ["L2", "L1"]
    page3 = data.list_order_events(se.plant, "ord-1", limit=2, before_id=page2["next_before_id"])
    assert [e["changes"]["machine"][0] for e in page3["events"]] == ["L0"]
    assert page3["next_before_id"] is None
    ev = page1["events"][0]
    assert ev["source"] == "drag" and ev["actor"] == se.actor and ev["client_id"] == "zz-client"
    assert ev["actor_name"] is None and ev["op"] == "modify"
    assert datetime_is_aware(ev["at"])
    assert data.list_order_events(se.plant, "ord-2")["events"][0]["op"] == "create"
    assert data.list_order_events(se.other, "ord-1")["events"] == []


def datetime_is_aware(text):
    return dt.datetime.fromisoformat(text).tzinfo is not None


@pytest.mark.pg
def test_record_db_failure_is_fail_open_and_caller_transaction_survives(se):
    """A real DB error in the history INSERT (an int actor cannot bind to the TEXT column) rolls back only the
    savepoint: the caller's earlier history row and later statements still commit."""
    import backend.schedule_events.data as data
    before = events.write_failures()
    good = EventRow(plant=se.plant, order_id="ord-ok", production_order=None, material_number=None,
                    op="modify", changes={"machine": ["a", "b"]})
    with se.db._pool.connection() as conn, conn.cursor() as cur:
        assert record(cur, EventCtx("drag", se.actor, str(uuid.uuid4())), [good]) == 1
        assert record(cur, EventCtx("drag", 12345, str(uuid.uuid4())), [good]) == 0
        cur.execute("SELECT 2")
        assert cur.fetchone()[0] == 2
        conn.commit()
    assert events.write_failures() == before + 1
    assert len(data.list_order_events(se.plant, "ord-ok")["events"]) == 1


@pytest.mark.pg
def test_sweep_removes_only_rows_older_than_retention(se):
    import backend.schedule_events.data as data
    with se.db._pool.connection() as conn, conn.cursor() as cur:
        for days, oid in ((20, "old-1"), (20, "old-2"), (20, "old-3"), (1, "new-1")):
            cur.execute(
                "INSERT INTO schedule_event (plant, order_id, action_id, source, actor, op, changes, at)"
                " VALUES (%s, %s, %s, 'drag', %s, 'modify', '{\"machine\":[\"a\",\"b\"]}'::jsonb,"
                " now() - make_interval(days => %s))",
                (se.plant, oid, str(uuid.uuid4()), se.actor, days))
        conn.commit()
    result = data.sweep_schedule_events(retention_days=14, chunk=1, pause_s=0)
    assert result["error"] is None and result["locked"] is False and result["retention_days"] == 14
    assert result["deleted"] >= 3 and result["chunks"] >= 3
    with se.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT order_id FROM schedule_event WHERE plant = %s ORDER BY order_id", (se.plant,))
        assert [r[0] for r in cur.fetchall()] == ["new-1"]
    from backend.admin_ops.diagnostics_state import DIAGNOSTICS
    assert DIAGNOSTICS["schedule_event_last_sweep"]["deleted"] == result["deleted"]


@pytest.mark.pg
def test_sweep_reports_locked_when_another_session_holds_the_lock(se):
    import backend.schedule_events.data as data
    with se.db._pool.connection() as holder, holder.cursor() as hcur:
        hcur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (data.SWEEP_LOCK_KEY,))
        result = data.sweep_schedule_events(retention_days=14, chunk=10, pause_s=0)
        holder.rollback()
    assert result["locked"] is True and result["deleted"] == 0 and result["error"] is None


@pytest.fixture
def api_client():
    from starlette.testclient import TestClient
    import brain
    client = TestClient(brain.api)
    try:
        yield client, brain
    finally:
        brain.api.dependency_overrides.clear()


@pytest.mark.pg
def test_read_route_requires_authentication(se, api_client):
    client, brain = api_client
    brain.api.dependency_overrides.clear()
    r = client.get(f"/schedule-events/{se.plant}/order/ord-1")
    assert r.status_code == 401


@pytest.mark.pg
def test_read_route_forbidden_outside_role_plants(se, api_client):
    from backend.security import auth
    client, brain = api_client
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: se.actor
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [se.other]
    r = client.get(f"/schedule-events/{se.plant}/order/ord-1")
    assert r.status_code == 403


@pytest.mark.pg
def test_read_route_returns_events_with_actor_name_and_no_store(se, api_client):
    from backend.security import auth
    client, brain = api_client
    with se.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO user_security (username, first_name, last_name) VALUES (%s, 'Zed', 'Tester')",
                    (se.actor,))
        conn.commit()
    _write(se, [EventRow(plant=se.plant, order_id="ord-1", production_order="PO1", material_number="M1",
                         op="modify", changes={"machine": ["L1", "L2"]})])
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: se.actor
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [se.plant]
    r = client.get(f"/schedule-events/{se.plant}/order/ord-1?limit=10")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-store"
    body = r.json()
    assert body["plant"] == se.plant and body["order_id"] == "ord-1" and body["next_before_id"] is None
    assert len(body["events"]) == 1
    ev = body["events"][0]
    assert ev["actor"] == se.actor and ev["actor_name"] == "Zed Tester"
    assert ev["changes"] == {"machine": ["L1", "L2"]} and ev["source"] == "drag"
    # limit bounds are enforced by the route
    assert client.get(f"/schedule-events/{se.plant}/order/ord-1?limit=0").status_code == 422
    assert client.get(f"/schedule-events/{se.plant}/order/ord-1?limit=201").status_code == 422


# --------------------------------------------------------------------------- planner save + note hooks (Task 2)

def _se_events(ctx, plant=None):
    with ctx.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT order_id, source, op, actor, action_id::text, client_id, changes FROM schedule_event "
                    "WHERE plant = %s ORDER BY id", (plant or ctx.plant,))
        return cur.fetchall()


class TestPlannerSaveEvents:
    @pytest.fixture
    def seeded(self, planning_pg):
        ctx = planning_pg
        ctx.t0 = dt.datetime(2026, 11, 2, 8, 0, 0)
        ctx.end0 = dt.datetime(2026, 11, 2, 12, 0, 0)
        ctx.a = ctx.db.make_id("ZZTEST_SE_PO_A", "ZZTEST_SE_MAT")
        ctx.b = ctx.db.make_id("ZZTEST_SE_PO_B", "ZZTEST_SE_MAT")
        import backend.schedule_events.data as data
        data.ensure_schedule_event_table()
        with ctx.db._pool.connection() as conn, conn.cursor() as cur:
            for oid, po in ((ctx.a, "ZZTEST_SE_PO_A"), (ctx.b, "ZZTEST_SE_PO_B")):
                cur.execute(
                    "INSERT INTO orders (id, production_order, material_number, machine, plant, basic_start_date,"
                    " basic_finish_date, scheduled_start, scheduled_end) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (oid, po, "ZZTEST_SE_MAT", ctx.machine, ctx.plant, ctx.t0, ctx.end0, ctx.t0, ctx.end0))
            conn.commit()
        try:
            yield ctx
        finally:
            with ctx.db._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM orders WHERE id = ANY(%s)", ([ctx.a, ctx.b],))
                conn.commit()

    def _ev(self, ctx, client_id="zz-client"):
        return EventCtx(source="planner", actor=ctx.actor, action_id=str(uuid.uuid4()), client_id=client_id)

    @pytest.mark.pg
    def test_save_writes_one_row_per_changed_order_sharing_an_action_id(self, seeded):
        ctx = seeded
        new_end = ctx.end0 + dt.timedelta(hours=1)
        ev = self._ev(ctx)
        res = ctx.db.update_task_dates_bulk(
            [{"id": ctx.a, "start": ctx.t0, "end": new_end, "MACHINE": "PACK_LINE", "source": "drag"},
             {"id": ctx.b, "FIRMED": True}], ev=ev)
        assert res["persisted"] == 2
        rows = _se_events(ctx)
        assert len(rows) == 2
        by_order = {r[0]: r for r in rows}
        a, b = by_order[ctx.a], by_order[ctx.b]
        assert a[1] == "drag" and a[2] == "modify" and a[3] == ctx.actor and a[5] == "zz-client"
        assert a[6] == {"machine": [ctx.machine, "PACK_LINE"],
                        "scheduled_end": ["2026-11-02T12:00:00", "2026-11-02T13:00:00"]}
        assert b[1] == "planner" and b[6] == {"manual_firmed": [False, True]}
        assert a[4] == b[4] == ev.action_id

    @pytest.mark.pg
    def test_unchanged_resend_writes_no_rows_but_still_bumps_xmin(self, seeded):
        ctx = seeded
        item = {"id": ctx.a, "start": ctx.t0, "end": ctx.end0, "source": "drag"}
        v0 = ctx.db.get_task_versions([ctx.a])[0]["row_version"]
        res = ctx.db.update_task_dates_bulk([item], ev=self._ev(ctx))
        assert res["persisted"] == 1
        assert res["versions"][ctx.a] != v0
        assert _se_events(ctx) == []

    @pytest.mark.pg
    def test_save_without_an_event_context_records_nothing(self, seeded):
        ctx = seeded
        res = ctx.db.update_task_dates_bulk(
            [{"id": ctx.a, "start": ctx.t0, "end": ctx.end0 + dt.timedelta(hours=2)}])
        assert res["persisted"] == 1
        assert _se_events(ctx) == []

    @pytest.mark.pg
    def test_note_change_records_old_and_new_and_same_note_records_nothing(self, seeded):
        ctx = seeded
        ctx.db.update_task_note(ctx.a, "first", ev=EventCtx(source="note", actor=ctx.actor,
                                                             action_id=str(uuid.uuid4())))
        ctx.db.update_task_note(ctx.a, "first", ev=EventCtx(source="note", actor=ctx.actor,
                                                             action_id=str(uuid.uuid4())))
        rows = _se_events(ctx)
        assert len(rows) == 1
        assert rows[0][1] == "note" and rows[0][2] == "modify" and rows[0][6] == {"notes": [None, "first"]}
        ctx.db.update_task_note(ctx.a, "second", ev=EventCtx(source="note", actor=ctx.actor,
                                                              action_id=str(uuid.uuid4())))
        assert _se_events(ctx)[-1][6] == {"notes": ["first", "second"]}


# --- DB-free route tests: actor plumbing and the `source` / `client_id` wire fields

@pytest.fixture
def save_client(monkeypatch):
    import brain
    import db
    from fastapi.testclient import TestClient
    from backend.security import auth
    calls = []

    def fake_bulk(items, allowed_plants=None, **kw):
        calls.append((items, kw))
        return {"applied": 0, "persisted": 0, "failed": 0, "invalid": 0, "not_found": 0, "invalid_ids": [],
                "not_found_ids": [], "stale": [], "versions": {}, "conflicts": [], "rejection_reasons": {},
                "start_derived": {}}
    monkeypatch.setattr(db, "update_task_dates_bulk", fake_bulk)
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: None
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "zz.planner@example.com"
    try:
        yield TestClient(brain.api), calls
    finally:
        brain.api.dependency_overrides.clear()


def test_task_date_update_accepts_source_and_unknown_value_is_ignored_server_side(save_client):
    from backend.scheduling.models import TaskDateUpdate
    assert TaskDateUpdate(id="x", source="drag").source == "drag"
    assert TaskDateUpdate(id="x").source is None
    client, calls = save_client
    body = {"client_id": "tab-1", "tasks": [
        {"id": "o1", "start_date": "2026-11-02T08:00:00", "end_date": "2026-11-02T12:00:00", "source": "drag"},
        {"id": "o2", "start_date": "2026-11-02T08:00:00", "end_date": "2026-11-02T12:00:00", "source": "bogus"}]}
    response = client.post("/tasks/update", json=body)
    assert response.status_code == 200
    items, kw = calls[0]
    assert items[0]["source"] == "drag" and "source" not in items[1]
    ev = kw["ev"]
    assert ev.source == "planner" and ev.actor == "zz.planner@example.com" and ev.client_id == "tab-1"
    assert kw["actor"] == "zz.planner@example.com" and kw["client_id"] == "tab-1"
    assert as_action_id(ev.action_id) == ev.action_id


def test_tasks_update_still_requires_authentication(save_client):
    import brain
    from fastapi.testclient import TestClient
    from backend.security import auth
    _client, calls = save_client

    def deny():
        raise brain.HTTPException(status_code=401, detail="Not signed in")
    brain.api.dependency_overrides[auth.require_authenticated] = deny
    response = TestClient(brain.api).post("/tasks/update", json={"tasks": [], "client_id": "t"})
    assert response.status_code == 401
    assert calls == []
