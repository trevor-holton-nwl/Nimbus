"""schedule_event foundation: pure helper tests, DDL pinning, and @pytest.mark.pg tests for the table,
`record`, the retention sweep and the read route."""
import datetime as dt
import math
import os
import re
import uuid
from decimal import Decimal

import pytest
from psycopg.types.json import Jsonb

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
    """A real error inside the savepointed history INSERT rolls back only the savepoint: the caller's earlier
    history row and later statements still commit. The failure is made unambiguous with a dict `client_id`,
    which psycopg cannot adapt (an int actor would be assignment-cast to TEXT by Postgres and succeed)."""
    import backend.schedule_events.data as data
    before = events.write_failures()
    good = EventRow(plant=se.plant, order_id="ord-ok", production_order=None, material_number=None,
                    op="modify", changes={"machine": ["a", "b"]})
    with se.db._pool.connection() as conn, conn.cursor() as cur:
        assert record(cur, EventCtx("drag", se.actor, str(uuid.uuid4())), [good]) == 1
        assert record(cur, EventCtx("drag", se.actor, str(uuid.uuid4()), client_id={"x": 1}), [good]) == 0
        cur.execute("SELECT 2")                       # the transaction survived the failed INSERT
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

# --------------------------------------------------------------------------- ingest hooks (Task 3)

@pytest.fixture
def ing(se):
    """`se` plus a short plant (material_plants.plant is VARCHAR(10)) and order/master-data cleanup."""
    ing = type("Ing", (), {})()
    ing.se, ing.db, ing.actor = se, se.db, se.actor
    ing.plant = "ZE" + se.token[:7]
    ing.material = "ZZSE" + se.token
    ing.batches = []
    ing.start = dt.datetime(2030, 3, 4, 6, 0)
    yield ing
    with se.db._pool.connection() as conn, conn.cursor() as cur:
        cleanup_schedule_events(cur, actor=se.actor, plants=[ing.plant])
        cur.execute("DELETE FROM orders WHERE plant = %s", (ing.plant,))
        cur.execute("DELETE FROM material_plants WHERE plant = %s", (ing.plant,))
        cur.execute("DELETE FROM materials WHERE material_id = %s", (ing.material,))
        if ing.batches:
            cur.execute("DELETE FROM upload_audit WHERE batch_id = ANY(%s)", (ing.batches,))
        conn.commit()


def _ing_row(ing, n, *, quantity=10, finish_days=2):
    return {
        "production_order": f"ZZSE{ing.se.token}{n}", "material_number": ing.material,
        "machine": "ZZM1", "plant": ing.plant, "basic_start_date": ing.start,
        "basic_finish_date": ing.start + dt.timedelta(days=finish_days), "run_time": 4.0,
        "order_quantity": quantity,
    }


def _ing_upload(ing, rows, *, source="excel", batch_id=None):
    batch_id = batch_id or str(uuid.uuid4())
    ing.batches.append(batch_id)
    res = ing.db.upsert_orders(rows, batch_id=batch_id, source=source, filename="zz.xlsx",
                               raw_row_count=len(rows), actor=ing.actor)
    assert res["status"] == "ok"
    return batch_id, res


def _ing_events(ing, *, order_id=None):
    with ing.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT order_id, op, source, actor, action_id::text, changes FROM schedule_event"
            " WHERE plant = %s AND (%s::text IS NULL OR order_id = %s) ORDER BY id",
            (ing.plant, order_id, order_id))
        return cur.fetchall()


def _ing_order_id(ing, n):
    return ing.db.make_id(f"ZZSE{ing.se.token}{n}", ing.material)


@pytest.mark.pg
@pytest.mark.parametrize("source,expected", [("excel", "excel_upload"), ("sap", "sap_ingest")])
def test_first_upload_writes_one_create_row_per_order_and_identical_reupload_none(ing, source, expected):
    rows = [_ing_row(ing, n) for n in (1, 2, 3)]
    batch_id, res = _ing_upload(ing, rows, source=source)
    assert res["inserted"] == 3
    evs = _ing_events(ing)
    assert len(evs) == 3
    assert {e[1] for e in evs} == {"create"} and {e[2] for e in evs} == {expected}
    assert {e[3] for e in evs} == {ing.actor} and {e[4] for e in evs} == {batch_id}
    assert all(e[5]["order_quantity"] == [None, 10] for e in evs)
    _ing_upload(ing, rows, source=source)           # identical re-upload
    assert len(_ing_events(ing)) == 3


@pytest.mark.pg
def test_sap_finish_change_on_placed_order_is_one_sap_reset_row(ing):
    _ing_upload(ing, [_ing_row(ing, 1)])
    oid = _ing_order_id(ing, 1)
    placed_end = ing.start + dt.timedelta(days=30)
    with ing.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE orders SET scheduled_start = %s, scheduled_end = %s, manual_firmed = TRUE"
                    " WHERE id = %s", (ing.start + dt.timedelta(days=29), placed_end, oid))
        conn.commit()
    _ing_upload(ing, [_ing_row(ing, 1, finish_days=5)])
    evs = _ing_events(ing, order_id=oid)
    assert [e[1] for e in evs] == ["create", "modify"]
    reset = evs[1]
    assert reset[2] == "sap_reset"
    ch = reset[5]
    assert "basic_finish_date" in ch and ch["scheduled_end"][1] is None and ch["manual_firmed"] == [True, False]
    assert ch["scheduled_start"][1] is None


@pytest.mark.pg
def test_quantity_only_sap_change_is_one_modify_row_with_ingest_source(ing):
    _ing_upload(ing, [_ing_row(ing, 1, quantity=10)], source="sap")
    oid = _ing_order_id(ing, 1)
    _ing_upload(ing, [_ing_row(ing, 1, quantity=25)], source="sap")
    evs = _ing_events(ing, order_id=oid)
    assert [e[1] for e in evs] == ["create", "modify"]
    assert evs[1][2] == "sap_ingest" and evs[1][5] == {"order_quantity": [10, 25]}


@pytest.mark.pg
def test_stamp_order_attributes_unchanged_row_writes_nothing_changed_prt_writes_one_row(ing):
    _ing_upload(ing, [_ing_row(ing, 1)])
    oid = _ing_order_id(ing, 1)
    with ing.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO materials (material_id) VALUES (%s) ON CONFLICT DO NOTHING", (ing.material,))
        cur.execute("INSERT INTO material_plants (material_id, plant, color, prt_01, prt_02) VALUES"
                    " (%s, %s, 'RED', 'PA', 'PB')", (ing.material, ing.plant))
        conn.commit()

    def stamp():
        ev = EventCtx("master_data_stamp", ing.actor, str(uuid.uuid4()))
        with ing.db._pool.connection() as conn:
            ing.db._stamp_order_attributes(conn, ids=[oid], ev=ev)
            conn.commit()

    stamp()
    first = [e for e in _ing_events(ing, order_id=oid) if e[2] == "master_data_stamp"]
    assert len(first) == 1 and first[0][5]["prt_01"] == [None, "PA"] and first[0][5]["prt_02"] == [None, "PB"]
    with ing.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT xmin::text FROM orders WHERE id = %s", (oid,))
        xmin = cur.fetchone()[0]
    stamp()                                           # nothing differs: no row, no rewrite
    assert len([e for e in _ing_events(ing, order_id=oid) if e[2] == "master_data_stamp"]) == 1
    with ing.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT xmin::text FROM orders WHERE id = %s", (oid,))
        assert cur.fetchone()[0] == xmin
        cur.execute("UPDATE material_plants SET prt_01 = 'PX' WHERE material_id = %s AND plant = %s",
                    (ing.material, ing.plant))
        conn.commit()
    stamp()
    rows = [e for e in _ing_events(ing, order_id=oid) if e[2] == "master_data_stamp"]
    assert len(rows) == 2 and rows[1][5] == {"prt_01": ["PA", "PX"]}
# --------------------------------------------------------------------------- Task 4: purge / vanish / zero_open

def test_purge_event_rows_snapshot_is_bounded_and_encodes_reason():
    import db
    rows = [{"id": "o1", "plant": "P1", "production_order": "PO1", "material_number": "M1", "machine": "L1",
             "scheduled_start": dt.datetime(2026, 10, 1, 8), "scheduled_end": dt.datetime(2026, 10, 2, 8),
             "planning_status": "needs_planning", "planning_reason": {"code": "runtime_unknown"},
             "manual_firmed": False}]
    (out,) = db._purge_event_rows("P1", rows)
    assert out.op == "remove" and out.order_id == "o1"
    assert out.changes["planning_status"] == ["needs_planning:runtime_unknown", None]
    assert out.changes["machine"] == ["L1", None] and out.changes["scheduled_end"][0] == "2026-10-02T08:00:00"
    assert "segments" not in out.changes and "notes" not in out.changes
    (with_segs,) = db._purge_event_rows("P1", rows, {"o1": [{}, {}]})
    assert with_segs.changes["segments"] == [2, None]


def test_zero_open_event_rows_skip_already_reset_orders():
    import backend.integration.sap_staging as st
    cur = FakeCur()
    base = {"plant": "P1", "production_order": "PO", "material_number": "M", "planning_reason": None}
    befores = {
        "a": {**base, "planning_status": "scheduled", "scheduled_start": dt.datetime(2026, 1, 1),
              "scheduled_end": dt.datetime(2026, 1, 2), "manual_firmed": True, "segment_count": 2},
        "b": {**base, "planning_status": "needs_planning", "planning_reason": {"code": "zero_open_quantity"},
              "scheduled_start": None, "scheduled_end": None, "manual_firmed": False, "segment_count": 0},
    }
    assert st._record_zero_open_events(cur, befores, "tester", str(uuid.uuid4())) == 1


def _mk_order(cur, plant, tag, i, *, machine="SHARED_LINE", status="scheduled", firmed=False, end=True,
              planning_reason=None):
    """Seed one order. `orders_planning_state_check`: 'scheduled' needs a NULL reason; 'needs_planning' needs a
    {code, message} reason object and NULL dates, so a held seed gets a default reason and no placement."""
    oid = f"zz-{tag}-{i}"
    held = status == "needs_planning"
    if held:
        end = False
        planning_reason = planning_reason or {"code": "zero_open_quantity", "message": "x"}
    cur.execute(
        "INSERT INTO orders (id, production_order, material_number, plant, machine, basic_start_date,"
        " basic_finish_date, scheduled_start, scheduled_end, planning_status, planning_reason, manual_firmed)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (oid, f"PO{tag}{i}", f"M{tag}", plant, machine, dt.datetime(2031, 3, 1, 6), dt.datetime(2031, 3, 2, 6),
         dt.datetime(2031, 3, 1, 6) if end else None, dt.datetime(2031, 3, 2, 6) if end else None,
         status, Jsonb(planning_reason) if planning_reason else None, firmed))
    return oid


def _events(db, plant, source=None):
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT order_id, source, op, actor, action_id::text, changes FROM schedule_event"
                    " WHERE plant = %s AND (%s::text IS NULL OR source = %s) ORDER BY id", (plant, source, source))
        return cur.fetchall()


@pytest.fixture
def pe(planning_pg):
    import backend.schedule_events.data as data
    data.ensure_schedule_event_table()
    planning_pg.tag = uuid.uuid4().hex[:8]
    try:
        yield planning_pg
    finally:
        with planning_pg.db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM sap_stage_vanished_order WHERE plant = %s", (planning_pg.plant,))
            cur.execute("DELETE FROM orders WHERE plant = %s", (planning_pg.plant,))


@pytest.mark.pg
def test_purge_by_date_writes_one_remove_row_per_order_and_keeps_admin_audit(pe):
    db = pe.db
    with db._pool.connection() as conn, conn.cursor() as cur:
        ids = [_mk_order(cur, pe.plant, pe.tag, i) for i in range(3)]
        conn.commit()
    res = db.purge_orders_by_date(pe.plant, dt.datetime(2031, 3, 1), dt.datetime(2031, 3, 3), user_email=pe.actor)
    assert res["deleted"] == 3
    rows = _events(db, pe.plant)
    assert sorted(r[0] for r in rows) == sorted(ids)
    assert {r[1] for r in rows} == {"purge"} and {r[2] for r in rows} == {"remove"}
    assert {r[3] for r in rows} == {pe.actor} and len({r[4] for r in rows}) == 1
    ch = rows[0][5]
    assert ch["machine"] == ["SHARED_LINE", None] and "scheduled_end" in ch and ch["planning_status"][0] == "scheduled"
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM admin_audit WHERE user_email = %s AND action = 'purge_by_date_range'",
                    (pe.actor,))
        assert cur.fetchone()[0] == 1


@pytest.mark.pg
def test_purge_by_ids_sap_vanish_records_source_and_segment_count(pe):
    db = pe.db
    batch = str(uuid.uuid4())
    with db._pool.connection() as conn, conn.cursor() as cur:
        a = _mk_order(cur, pe.plant, pe.tag, 0)
        b = _mk_order(cur, pe.plant, pe.tag, 1)
        cur.execute("INSERT INTO order_schedule_segments (order_id, segment_no, scheduled_start, scheduled_end)"
                    " VALUES (%s, 1, %s, %s), (%s, 2, %s, %s)",
                    (a, dt.datetime(2031, 3, 1, 6), dt.datetime(2031, 3, 1, 12),
                     a, dt.datetime(2031, 3, 2, 6), dt.datetime(2031, 3, 2, 12)))
        conn.commit()
    out = db.purge_orders_by_ids(pe.plant, [a, b], user_email=pe.actor, archive_batch_id=batch,
                                 event_source="sap_vanish")
    assert out["deleted"] == 2 and out["archived"] == 2
    rows = {r[0]: r for r in _events(db, pe.plant)}
    assert set(rows) == {a, b} and {r[1] for r in rows.values()} == {"sap_vanish"}
    assert rows[a][4] == batch
    assert rows[a][5]["segments"] == [2, None]


@pytest.mark.pg
def test_zero_open_reset_records_only_orders_that_actually_changed(pe):
    import backend.integration.sap_staging as st
    db = pe.db
    bid = str(uuid.uuid4())
    with db._pool.connection() as conn, conn.cursor() as cur:
        a = _mk_order(cur, pe.plant, pe.tag, 0, firmed=True)
        _mk_order(cur, pe.plant, pe.tag, 1, status="needs_planning", end=False)
        cur.execute("INSERT INTO order_schedule_segments (order_id, segment_no, scheduled_start, scheduled_end)"
                    " VALUES (%s, 1, %s, %s)", (a, dt.datetime(2031, 3, 1, 6), dt.datetime(2031, 3, 1, 12)))
        cur.execute(
            "SELECT o.id, o.plant, o.planning_status, o.scheduled_start, o.scheduled_end, o.production_order,"
            " o.material_number, o.manual_firmed, o.planning_reason, COALESCE(seg.segment_count, 0) AS segment_count"
            " FROM orders o " + db._SCHEDULE_SEGMENTS_LATERAL_SQL + " WHERE o.plant = %s ORDER BY o.id FOR UPDATE OF o",
            (pe.plant,))
        names = [d.name for d in cur.description]
        befores = {r[0]: dict(zip(names, r, strict=True)) for r in cur.fetchall()}
        assert st._record_zero_open_events(cur, befores, pe.actor, bid) == 1
        conn.commit()
    rows = _events(db, pe.plant, "sap_reset")
    assert len(rows) == 1 and rows[0][0] == a and rows[0][4] == bid and rows[0][3] == pe.actor
    ch = rows[0][5]
    assert ch["manual_firmed"] == [True, False] and ch["segments"] == [1, 0]
    assert ch["planning_status"] == ["scheduled", "needs_planning:zero_open_quantity"]
    assert ch["scheduled_end"][1] is None
# --------------------------------------------------------------------------- Task 5: routing resolver hooks

@pytest.mark.pg
class TestRoutingResolverEvents:
    SUB, PLANT, MATERIAL = "ZZTEST_SE5_S", "ZZTEST_SE5P", "ZZTEST_SE5_M"
    M1, W1 = "ZZTEST_SE5_L1", "ZZTEST_SE5_W1"
    START = dt.datetime(2026, 10, 5, 8)

    def _cleanup(self, cur):
        cleanup_schedule_events(cur, plants=[self.PLANT])
        cur.execute("DELETE FROM order_schedule_segments WHERE order_id IN (SELECT id FROM orders WHERE plant=%s)",
                    (self.PLANT,))
        for table in ("orders", "routing_operation", "production_version", "routing_rules", "machine",
                      "sap_workcenter", "material_plants"):
            cur.execute(f"DELETE FROM {table} WHERE plant=%s", (self.PLANT,))
        cur.execute("DELETE FROM materials WHERE material_id=%s", (self.MATERIAL,))
        cur.execute("DELETE FROM plants WHERE plant=%s AND subnetwork=%s", (self.PLANT, self.SUB))
        cur.execute("DELETE FROM subnetworks WHERE code=%s", (self.SUB,))

    @pytest.fixture(autouse=True)
    def seed(self, pg):
        import backend.schedule_events.data as data
        from backend.routing import resolver
        data.ensure_schedule_event_table()
        self.pg, self.resolver = pg, resolver
        self.ids = [pg.make_id(f"ZZTEST_SE5_O{i}", self.MATERIAL) for i in (1, 2)]
        with pg._pool.connection() as conn, conn.cursor() as cur:
            self._cleanup(cur)
            cur.execute("INSERT INTO subnetworks (code,name) VALUES (%s,'SE5 test')", (self.SUB,))
            cur.execute("INSERT INTO plants (subnetwork,plant,routing_runtime_enabled,split_order_policy,timezone)"
                        " VALUES (%s,%s,TRUE,'partial_allowed','America/New_York')", (self.SUB, self.PLANT))
            cur.execute("INSERT INTO materials (material_id) VALUES (%s)", (self.MATERIAL,))
            cur.execute("INSERT INTO material_plants (material_id,plant) VALUES (%s,%s)", (self.MATERIAL, self.PLANT))
            cur.execute("INSERT INTO sap_workcenter (plant,sap_workcenter) VALUES (%s,%s)", (self.PLANT, self.W1))
            cur.execute("INSERT INTO machine (subnetwork,plant,machine,sap_workcenter) VALUES (%s,%s,%s,%s)",
                        (self.SUB, self.PLANT, self.M1, self.W1))
            cur.execute(
                "INSERT INTO production_version (plant,material_id,production_version,task_list_type,"
                " routing_group,group_counter,valid_from,valid_to,sap_workcenter)"
                " VALUES (%s,%s,'0001','N','SE500001','01','2026-01-01','2027-12-31',%s)",
                (self.PLANT, self.MATERIAL, self.W1))
            cur.execute(
                "INSERT INTO routing_operation (plant,material_id,task_list_type,routing_group,group_counter,"
                " sequence_no,activity,sap_workcenter,workcenter_category,base_quantity,std_value_machine,"
                " std_value_unit_machine) VALUES (%s,%s,'N','SE500001','01','000000','0010',%s,'0001',10,3,'H')",
                (self.PLANT, self.MATERIAL, self.W1))
            for i, oid in enumerate(self.ids, start=1):
                start = self.START + dt.timedelta(days=i - 1)
                cur.execute(
                    "INSERT INTO orders (id,production_order,material_number,plant,machine,production_version,"
                    " order_quantity,basic_start_date,basic_finish_date,scheduled_start,scheduled_end,"
                    " run_time,run_time_source,planning_status)"
                    " VALUES (%s,%s,%s,%s,%s,'0001',10,%s,%s,%s,%s,3,'routing','scheduled')",
                    (oid, f"ZZTEST_SE5_O{i}", self.MATERIAL, self.PLANT, self.M1, start,
                     start + dt.timedelta(days=2), start, start + dt.timedelta(hours=3)))
            conn.commit()
        try:
            self.resolver.resolve_orders(self.PLANT)          # settle both orders on the resolved run time
            self._clear_events()
            yield
        finally:
            with pg._pool.connection() as conn, conn.cursor() as cur:
                self._cleanup(cur)
                conn.commit()

    def _clear_events(self):
        self._sql("DELETE FROM schedule_event WHERE plant=%s", (self.PLANT,))

    def _events(self):
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT order_id, source, actor, op, changes FROM schedule_event"
                        " WHERE plant=%s ORDER BY id", (self.PLANT,))
            return cur.fetchall()

    def _sql(self, query, params=()):
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(query, params)
            out = cur.fetchone() if cur.description else None
            conn.commit()
            return out

    def test_recompute_records_only_the_order_whose_run_time_changed(self):
        self._sql("UPDATE orders SET run_time = 99 WHERE id = %s", (self.ids[0],))
        self.resolver.resolve_orders(self.PLANT, full=True)
        rows = self._events()
        assert len(rows) == 1
        order_id, source, actor, op, changes = rows[0]
        assert (order_id, source, actor, op) == (self.ids[0], "routing_recompute", "system", "modify")
        new = self._sql("SELECT run_time FROM orders WHERE id = %s", (self.ids[0],))[0]
        assert changes == {"run_time": [99, events._ev_scalar(new)]}

    def test_resolve_orders_stamps_the_given_actor(self):
        self._sql("UPDATE orders SET run_time = 99 WHERE id = %s", (self.ids[1],))
        self.resolver.resolve_orders(self.PLANT, full=True, actor="x@y")
        rows = self._events()
        assert [r[2] for r in rows] == ["x@y"] and rows[0][0] == self.ids[1]

    def test_hold_on_a_scheduled_firmed_order_records_routing_hold(self):
        from psycopg.types.json import Jsonb
        oid = self.ids[0]
        self._sql("UPDATE orders SET manual_firmed = TRUE WHERE id = %s", (oid,))
        self._sql("INSERT INTO order_schedule_segments (order_id, segment_no, scheduled_start, scheduled_end)"
                  " VALUES (%s, 1, %s, %s)", (oid, self.START, self.START + dt.timedelta(hours=3)))
        reason = {"code": "runtime_unknown", "step": "pv_missing", "message": "x"}
        ev = EventCtx(source="routing_recompute", actor="hold@test", action_id=str(uuid.uuid4()))
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            self.resolver._write_holds(cur, [(oid, Jsonb(reason))], ev=ev)
            conn.commit()
        rows = self._events()
        assert len(rows) == 1 and rows[0][1] == "routing_hold" and rows[0][2] == "hold@test"
        changes = rows[0][4]
        assert changes["scheduled_end"][1] is None
        assert changes["manual_firmed"] == [True, False]
        assert changes["segments"] == [1, 0]
        assert changes["planning_status"] == ["scheduled", "needs_planning:runtime_unknown"]

    def test_hold_on_an_already_held_unscheduled_order_records_nothing(self):
        from psycopg.types.json import Jsonb
        reason = {"code": "runtime_unknown", "step": "pv_missing", "message": "x"}
        ev = EventCtx(source="routing_recompute", actor="hold@test", action_id=str(uuid.uuid4()))
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            self.resolver._write_holds(cur, [(self.ids[0], Jsonb(reason))], ev=ev)
            conn.commit()
        self._clear_events()
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            self.resolver._write_holds(cur, [(self.ids[0], Jsonb(reason))], ev=ev)
            conn.commit()
        assert self._events() == []


@pytest.mark.pg
def test_fresh_upload_with_existing_master_data_writes_exactly_one_create_row_per_order(ing):
    with ing.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO materials (material_id) VALUES (%s) ON CONFLICT DO NOTHING", (ing.material,))
        cur.execute("INSERT INTO material_plants (material_id, plant, color, prt_01, prt_02) VALUES"
                    " (%s, %s, 'RED', 'PA', 'PB')", (ing.material, ing.plant))
        conn.commit()
    _ing_upload(ing, [_ing_row(ing, n) for n in (1, 2)])
    evs = _ing_events(ing)
    assert len(evs) == 2
    assert {e[1] for e in evs} == {"create"} and not any(e[2] == "master_data_stamp" for e in evs)
    with ing.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT prt_01 FROM orders WHERE plant = %s", (ing.plant,))
        assert {r[0] for r in cur.fetchall()} == {"PA"}      # still stamped, just not double-recorded


def test_stamp_run_skips_event_rows_for_skip_event_ids():
    class Cur:
        def execute(self, *a, **k):
            pass

        def fetchall(self):
            return [("o1", "P", "PO1", "M", None, None, None, "PA", "PB", "PV"),
                    ("o2", "P", "PO2", "M", None, None, None, "PA", "PB", "PV")]

    captured = []
    orig = events.record
    events.record = lambda cur, ev, rows: captured.extend(rows) or len(rows)
    try:
        import db as _db
        n = _db._stamp_run(Cur(), "o.id = ANY(%s)", ([],), EventCtx("master_data_stamp", "a", str(uuid.uuid4())),
                           {"o1"})
    finally:
        events.record = orig
    assert n == 1 and [r.order_id for r in captured] == ["o2"]



# --------------------------------------------------------------------------- distribution hooks (Task 6)

@pytest.mark.pg
class TestDistributionHooks:
    """apply() / re-weight / reset record per-child create/modify/remove rows (source 'distribution');
    a dry run records nothing."""
    SUB, PLANT = "WTG", "1006"

    @pytest.fixture(autouse=True)
    def _seed(self, planning_pg):
        pg = planning_pg.db
        t = uuid.uuid4().hex[:8].upper()
        self.pg = pg
        self.actor = planning_pg.actor
        self.WC, self.L1, self.L2 = f"ZZTEST_WC_SE{t}", f"ZZTEST_L1_SE{t}", f"ZZTEST_L2_SE{t}"
        self.ORD, self.MAT = f"ZZTEST_ORD_SE{t}", f"ZZTEST_MAT_SE{t}"
        import backend.schedule_events.data as se_data
        se_data.ensure_schedule_event_table()
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO sap_workcenter (plant, sap_workcenter, distribution_mode) "
                        "VALUES (%s, %s, 'distribute')", (self.PLANT, self.WC))
            cur.execute("INSERT INTO machine (subnetwork, plant, machine, sap_workcenter) "
                        "VALUES (%s,%s,%s,%s),(%s,%s,%s,%s)",
                        (self.SUB, self.PLANT, self.L1, self.WC, self.SUB, self.PLANT, self.L2, self.WC))
            cur.execute("INSERT INTO materials (material_id) VALUES (%s) ON CONFLICT DO NOTHING", (self.MAT,))
            cur.execute("INSERT INTO material_plants (material_id, plant) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                        (self.MAT, self.PLANT))
            conn.commit()
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM schedule_event WHERE actor = %s OR production_order = ANY(%s)",
                        (self.actor, [self.ORD]))
            cur.execute("DELETE FROM orders WHERE parent_production_order = %s OR production_order = %s",
                        (self.ORD, self.ORD))
            cur.execute("DELETE FROM order_distribution WHERE plant = %s AND production_order = %s",
                        (self.PLANT, self.ORD))
            cur.execute("DELETE FROM machine WHERE plant = %s AND machine IN (%s, %s)",
                        (self.PLANT, self.L1, self.L2))
            cur.execute("DELETE FROM sap_workcenter WHERE plant = %s AND sap_workcenter = %s",
                        (self.PLANT, self.WC))
            cur.execute("DELETE FROM material_plants WHERE plant = %s AND material_id = %s",
                        (self.PLANT, self.MAT))
            cur.execute("DELETE FROM materials WHERE material_id = %s", (self.MAT,))
            conn.commit()

    def _row(self):
        return {
            "production_order": self.ORD, "material_number": self.MAT, "machine": self.WC, "plant": self.PLANT,
            "basic_start_date": dt.datetime(2026, 10, 1, 8, 0), "basic_finish_date": dt.datetime(2026, 10, 1, 18, 0),
            "order_quantity": 100.0, "run_time": 10.0,
        }

    def _events(self):
        sql = ("SELECT order_id, op, source, actor, action_id::text, changes FROM schedule_event "
               "WHERE actor = %s ORDER BY id")
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(sql, (self.actor,))
            return cur.fetchall()

    def _header_xmin(self):
        with self.pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT xmin::text::bigint FROM order_distribution WHERE plant=%s AND "
                        "production_order=%s AND material_number=%s", (self.PLANT, self.ORD, self.MAT))
            return cur.fetchone()[0]

    def _ingest(self):
        import backend.distribution.data as dd
        batch_id = str(uuid.uuid4())
        _rows, plan, _w = dd.plan([self._row()], batch_id)
        with self.pg._pool.connection() as conn:
            dd.apply(plan, batch_id, conn, actor=self.actor)
        return batch_id, plan

    def test_apply_records_two_creates_and_an_identical_reapply_records_nothing(self):
        import backend.distribution.data as dd
        batch_id, plan = self._ingest()
        rows = self._events()
        creates = [r for r in rows if r[1] == "create"]
        assert len(creates) == 2
        assert all(r[2] == "distribution" and r[3] == self.actor and r[4] == batch_id for r in rows)
        assert {r[5]["machine"][1] for r in creates} == {self.L1, self.L2}
        with self.pg._pool.connection() as conn:
            dd.apply(plan, batch_id, conn, actor=self.actor)
        assert len(self._events()) == len(rows), "an identical re-apply changes nothing, so records nothing"

    def test_reweight_to_single_machine_records_removes_with_superseded_by(self):
        import backend.distribution.data as dd
        self._ingest()
        before = len(self._events())
        result = dd.reweight_shares(
            self.PLANT, self.ORD, self.MAT,
            [{"machine": self.L1, "weight": 100}, {"machine": self.L2, "weight": 0}],
            base_version=self._header_xmin(), confirm_remove_scheduled=True, actor=self.actor)
        new = self._events()[before:]
        assert len({r[4] for r in new}) == 1, "one action_id for the whole re-weight"
        removes = [r for r in new if r[1] == "remove"]
        assert {r[0] for r in removes} == set(result["removed"])
        creates = [r for r in new if r[1] == "create"]
        for r in removes:
            if creates:
                assert r[5]["superseded_by"] == [None, creates[0][0]]
        for r in creates:
            assert "carried_from" in r[5]
        assert all(r[3] == self.actor and r[2] == "distribution" for r in new)

    def test_dry_run_records_nothing(self):
        import backend.distribution.data as dd
        self._ingest()
        before = len(self._events())
        dd.reweight_shares(
            self.PLANT, self.ORD, self.MAT,
            [{"machine": self.L1, "weight": 100}, {"machine": self.L2, "weight": 0}],
            base_version=self._header_xmin(), dry_run=True, actor=self.actor)
        assert len(self._events()) == before

    def test_reset_after_manual_reweight_records_rows_for_the_planner(self):
        import backend.distribution.data as dd
        self._ingest()
        dd.reweight_shares(
            self.PLANT, self.ORD, self.MAT,
            [{"machine": self.L1, "weight": 100}, {"machine": self.L2, "weight": 0}],
            base_version=self._header_xmin(), confirm_remove_scheduled=True, actor=self.actor)
        before = len(self._events())
        dd.reset_one_header(self.PLANT, self.ORD, self.MAT, self._header_xmin(),
                            confirm_remove_scheduled=True, actor=self.actor)
        new = self._events()[before:]
        assert new, "a reset back to the 50/50 default changes the children"
        assert all(r[3] == self.actor and r[2] == "distribution" for r in new)
        assert len({r[4] for r in new}) == 1


def _seed_master_prt(ing, **extra):
    cols = ", ".join(["material_id", "plant", "color", "prt_01", "prt_02", *extra])
    marks = ", ".join(["%s"] * (5 + len(extra)))
    with ing.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO materials (material_id) VALUES (%s) ON CONFLICT DO NOTHING", (ing.material,))
        cur.execute(f"INSERT INTO material_plants ({cols}) VALUES ({marks})",
                    (ing.material, ing.plant, "RED", "PA", "PB", *extra.values()))
        conn.commit()


@pytest.mark.pg
def test_reupload_quantity_change_with_prt_master_data_has_no_phantom_prt_rows(ing):
    """R1: a SAP-changed existing order whose PRT comes from master data records only its real change: no
    `prt_*` key in any row and no `master_data_stamp` row (the ingest net pass is the one writer)."""
    _seed_master_prt(ing)
    _ing_upload(ing, [_ing_row(ing, 1, quantity=10)])
    oid = _ing_order_id(ing, 1)
    with ing.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT prt_01 FROM orders WHERE id = %s", (oid,))
        assert cur.fetchone()[0] == "PA"                       # stamped from master data
        cur.execute("UPDATE orders SET scheduled_start = %s, scheduled_end = %s WHERE id = %s",
                    (ing.start + dt.timedelta(days=29), ing.start + dt.timedelta(days=30), oid))
        conn.commit()
    _ing_upload(ing, [_ing_row(ing, 1, quantity=25)])
    evs = _ing_events(ing, order_id=oid)
    assert [e[1] for e in evs] == ["create", "modify"]
    assert not any(e[2] == "master_data_stamp" for e in evs)
    assert not any(k.startswith("prt_") for e in evs for k in e[5])
    assert evs[1][5]["order_quantity"] == [10, 25]


@pytest.mark.pg
def test_sap_production_version_change_records_one_net_row(ing):
    _seed_master_prt(ing)
    first = {**_ing_row(ing, 1), "production_version": "0001", "sap_production_version": "0001"}
    _ing_upload(ing, [first], source="sap")
    oid = _ing_order_id(ing, 1)
    second = {**first, "production_version": "0002", "sap_production_version": "0002"}
    _ing_upload(ing, [second], source="sap")
    evs = _ing_events(ing, order_id=oid)
    pv_rows = [e for e in evs if "production_version" in e[5]]
    assert len(pv_rows) == 1
    assert pv_rows[0][5]["production_version"] == ["0001", "0002"]
    assert pv_rows[0][2] == "sap_ingest"
    assert not any(e[2] == "master_data_stamp" for e in evs)
    assert not any(k.startswith("prt_") for e in evs for k in e[5])
