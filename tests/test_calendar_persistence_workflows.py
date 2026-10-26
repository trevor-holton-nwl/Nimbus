"""Real calendar persistence, delta semantics, UTC hydration and HTTP round trips."""

from contextlib import closing

import psycopg
import pytest
from fastapi.testclient import TestClient

import brain
import master_data as md
from backend.security import auth
from tests.support.planning_pg import audit_rows

pytest_plugins = ("tests.support.planning_pg",)
pytestmark = pytest.mark.pg


@pytest.fixture(params=["machine", "plant"])
def blackout_kind(request):
    if request.param == "machine":
        return md.save_machine_blackouts, md.load_machine_blackouts, "machine_blackout"
    return md.save_plant_blackouts, md.load_plant_blackouts, "plant_blackout"


def block(block_id="maintenance", **changes):
    return {"id": block_id, "start": "2026-10-13T08:00:00Z", "end": "2026-10-13T10:00:00Z",
            "reason": "Scheduled service", **changes}


def test_calendar_hydrates_all_slices_with_no_other_plant_leakage(planning_pg):
    c = planning_pg
    for plant, hours in [(c.plant, {"1": [6.5, 18.25], "0": None}), (c.other, {"1": [0, 24]})]:
        md.set_plant_work_hours(plant, hours, c.actor)
        md.set_line_work_hours(plant, [{"machine": c.machine, "work_hours": hours}], c.actor)
        md.save_machine_blackouts(plant, [block(machine=c.machine, reason=plant)], user_email=c.actor)
        md.save_plant_blackouts(plant, [block(reason=plant)], user_email=c.actor)
    config = md.load_plant_calendar(c.plant)
    assert config["plant"] == c.plant and config["subnetwork"] == c.subnet
    assert config["plant_work_hours"] == {"1": [6.5, 18.25], "0": None}
    assert config["line_work_hours"] == {c.machine: {"1": [6.5, 18.25], "0": None}}
    assert config["machine_blackouts"] == [block(machine=c.machine, reason=c.plant)]
    assert config["plant_blackouts"] == [block(reason=c.plant)]


@pytest.mark.parametrize("clear", [None, {}], ids=["null", "empty-object"])
def test_clearing_hours_restores_inheritance_without_deleting_unmentioned_lines(planning_pg, clear):
    c = planning_pg
    md.set_plant_work_hours(c.plant, {"1": [8, 16]}, c.actor)
    md.set_line_work_hours(c.plant, [
        {"machine": c.machine, "work_hours": {"1": None}},
        {"machine": "ORDER_DERIVED", "work_hours": {"1": [0, 24]}},
    ], c.actor)
    md.set_plant_work_hours(c.plant, clear, c.actor)
    md.set_line_work_hours(c.plant, [{"machine": c.machine, "work_hours": clear}], c.actor)
    config = md.load_plant_calendar(c.plant)
    assert config["plant_work_hours"] is None
    assert config["line_work_hours"] == {"ORDER_DERIVED": {"1": [0.0, 24.0]}}


def test_bad_later_line_does_not_partially_overwrite_valid_line(planning_pg):
    c = planning_pg
    md.set_line_work_hours(c.plant, [{"machine": c.machine, "work_hours": {"1": [8, 16]}}], c.actor)
    before = md.load_plant_calendar(c.plant)
    with pytest.raises(ValueError, match="range invalid"):
        md.set_line_work_hours(c.plant, [
            {"machine": c.machine, "work_hours": {"1": [10, 20]}},
            {"machine": "PACK_LINE", "work_hours": {"1": [16, 8]}},
        ], c.actor)
    assert md.load_plant_calendar(c.plant) == before
    assert len(audit_rows(c, "machine_calendar")) == 1


@pytest.mark.parametrize("hours", [
    {"7": [8, 16]}, {"Monday": [8, 16]}, {"1": [True, 16]}, {"1": [8, False]},
    {"1": [8]}, {"1": "8-16"}, {"1": [-1, 16]}, {"1": [8, 25]},
    {"1": [8, 8]}, {"1": [float("nan"), 16]}, {"1": [8, float("inf")]},
])
def test_invalid_hours_preserve_saved_calendar_and_audit(planning_pg, hours):
    c = planning_pg
    md.set_plant_work_hours(c.plant, {"1": [8, 16]}, c.actor)
    with pytest.raises(ValueError, match="work_hours"):
        md.set_plant_work_hours(c.plant, hours, c.actor)
    assert md.load_plant_calendar(c.plant)["plant_work_hours"] == {"1": [8, 16]}
    assert len(audit_rows(c, "plants")) == 1


def test_delta_upserts_and_deletes_are_plant_scoped_and_never_prune_by_omission(planning_pg, blackout_kind):
    c = planning_pg
    write, read, table = blackout_kind
    for plant in [c.plant, c.other]:
        assert write(plant, [block("a"), block("b")], user_email=c.actor) == {"upserted": 2, "deleted": 0}
    assert write(c.plant, [block("a", reason="Changed")], user_email=c.actor) == {"upserted": 1, "deleted": 0}
    assert {b["id"]: b["reason"] for b in read(c.plant)} == {"a": "Changed", "b": "Scheduled service"}
    assert write(c.plant, [], ["a", "missing", None, ""], c.actor) == {"upserted": 0, "deleted": 1}
    assert {b["id"] for b in read(c.plant)} == {"b"}
    assert {b["id"] for b in read(c.other)} == {"a", "b"}
    assert write(c.plant, [], ["a"], c.actor) == {"upserted": 0, "deleted": 0}
    assert audit_rows(c, table)[-1][1]["deleted"] == 0


def test_repeated_upsert_keeps_one_block_and_same_request_delete_then_upsert_recreates_it(planning_pg, blackout_kind):
    c = planning_pg
    write, read, _ = blackout_kind
    write(c.plant, [block()], user_email=c.actor)
    write(c.plant, [block()], user_email=c.actor)
    assert len(read(c.plant)) == 1
    assert write(c.plant, [block(reason="Recreated")], ["maintenance"], c.actor) == {"upserted": 1, "deleted": 1}
    assert len(read(c.plant)) == 1 and read(c.plant)[0]["reason"] == "Recreated"


@pytest.mark.parametrize("changes", [
    {"id": ""}, {"start": "invalid"}, {"end": None},
    {"end": "2026-10-13T08:00:00Z"}, {"end": "2026-10-13T07:59:59Z"},
])
def test_invalid_blackout_rejects_entire_delta_before_deletion(planning_pg, blackout_kind, changes):
    c = planning_pg
    write, read, table = blackout_kind
    write(c.plant, [block("existing")], user_email=c.actor)
    before = read(c.plant)
    with pytest.raises(ValueError, match="blackout"):
        write(c.plant, [block("valid"), block("invalid", **changes)], ["existing"], c.actor)
    assert read(c.plant) == before
    assert len(audit_rows(c, table)) == 1


def test_database_error_rolls_back_delete_and_preceding_valid_blackout(planning_pg, blackout_kind):
    c = planning_pg
    write, read, table = blackout_kind
    write(c.plant, [block("existing")], user_email=c.actor)
    before = read(c.plant)
    # PostgreSQL cannot adapt this object as TEXT. The failure occurs after
    # the delta's DELETE, exercising a real transaction rollback.
    with pytest.raises(psycopg.ProgrammingError):
        write(c.plant, [block("valid"), block("invalid", reason={"not": "text"})], ["existing"], c.actor)
    assert read(c.plant) == before
    assert len(audit_rows(c, table)) == 1
    assert write(c.plant, [block("recovery")], user_email=c.actor)["upserted"] == 1


@pytest.mark.parametrize("start,end,expected_start,expected_end", [
    ("2026-10-13T08:30:00-04:00", "2026-10-13T09:30:00-04:00",
     "2026-10-13T12:30:00Z", "2026-10-13T13:30:00Z"),
    ("2026-10-14T00:15:00+05:30", "2026-10-14T01:15:00+05:30",
     "2026-10-13T18:45:00Z", "2026-10-13T19:45:00Z"),
    ("2026-11-01T01:30:00-04:00", "2026-11-01T01:30:00-05:00",
     "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"),
])
def test_offset_and_dst_fold_timestamps_round_trip_as_utc(planning_pg, blackout_kind,
                                                         start, end, expected_start, expected_end):
    c = planning_pg
    write, read, _ = blackout_kind
    write(c.plant, [block(start=start, end=end)], user_email=c.actor)
    result = read(c.plant)[0]
    assert result["start"] == expected_start
    assert result["end"] == expected_end


def test_all_machine_block_can_be_reassigned_without_duplicate_rows(planning_pg):
    c = planning_pg
    md.save_machine_blackouts(c.plant, [block(machine="")], user_email=c.actor)
    assert md.load_machine_blackouts(c.plant)[0]["machine"] is None
    md.save_machine_blackouts(c.plant, [block(machine=c.machine)], user_email=c.actor)
    assert [b["machine"] for b in md.load_machine_blackouts(c.plant)] == [c.machine]


def test_unknown_plant_hydration_is_empty_but_write_is_rejected(planning_pg):
    c = planning_pg
    unknown = c.plant + "_MISSING"
    assert md.load_plant_calendar(unknown) == {
        "plant": unknown, "subnetwork": None, "plant_work_hours": None,
        "line_work_hours": {}, "machine_blackouts": [], "plant_blackouts": [], "plant_periods": [],
    }
    with pytest.raises(ValueError, match="not in Master Data"):
        md.save_plant_blackouts(unknown, [block()], user_email=c.actor)
    assert audit_rows(c, "plant_blackout") == []


def period(pid="winter", valid_from="2026-10-20", valid_to="2027-04-19", **changes):
    return {"id": pid, "name": "Winter", "valid_from": valid_from, "valid_to": valid_to,
            "work_hours": {"1": [6, 14]}, **changes}


def _period_count(c, plant=None):
    with c.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM plant_calendar_period WHERE plant = %s", (plant or c.plant,))
        return cur.fetchone()[0]


def test_period_round_trip_is_sorted_with_seven_keys_and_iso_dates(planning_pg):
    c = planning_pg
    md.save_plant_periods(c.plant, [period("b", "2027-01-01", None), period("a", "2026-10-20", "2026-12-31")],
                          user_email=c.actor)
    loaded = md.load_plant_periods(c.plant)
    assert [p["id"] for p in loaded] == ["a", "b"]
    assert loaded[0]["valid_from"] == "2026-10-20" and loaded[0]["valid_to"] == "2026-12-31"
    assert loaded[1]["valid_to"] is None
    assert sorted(loaded[0]["work_hours"]) == list("0123456")
    assert loaded[0]["work_hours"]["1"] == [6, 14] and loaded[0]["work_hours"]["0"] is None
    assert md.load_plant_calendar(c.plant)["plant_periods"] == loaded
    assert md.load_plant_periods(c.other) == []


def test_period_delta_never_prunes_by_omission_and_deletes_are_plant_scoped(planning_pg):
    c = planning_pg
    md.save_plant_periods(c.plant, [period("a")], user_email=c.actor)
    md.save_plant_periods(c.other, [period("a")], user_email=c.actor)
    md.save_plant_periods(c.plant, [period("b", "2027-05-01", None)], user_email=c.actor)
    assert [p["id"] for p in md.load_plant_periods(c.plant)] == ["a", "b"]
    assert md.save_plant_periods(c.plant, [], deletes=["a", "unknown"], user_email=c.actor) == {
        "upserted": 0, "deleted": 1}
    assert [p["id"] for p in md.load_plant_periods(c.plant)] == ["b"]
    assert [p["id"] for p in md.load_plant_periods(c.other)] == ["a"]


def test_period_overlap_rejected_on_insert_and_edit_but_adjacent_accepted(planning_pg):
    c = planning_pg
    md.save_plant_periods(c.plant, [period("a", "2026-10-01", "2026-10-31")], user_email=c.actor)
    with pytest.raises(md.PlantPeriodError) as e:
        md.save_plant_periods(c.plant, [period("b", "2026-10-31", "2026-11-30")], user_email=c.actor)
    assert e.value.code == "period_overlap" and sorted(e.value.ids) == ["a", "b"]
    md.save_plant_periods(c.plant, [period("b", "2026-11-01", "2026-11-30")], user_email=c.actor)
    with pytest.raises(md.PlantPeriodError) as e:
        md.save_plant_periods(c.plant, [period("b", "2026-10-15", "2026-11-30")], user_email=c.actor)
    assert e.value.code == "period_overlap"
    assert [p["valid_from"] for p in md.load_plant_periods(c.plant)] == ["2026-10-01", "2026-11-01"]


def test_period_same_request_delete_plus_conflicting_upsert_is_accepted(planning_pg):
    c = planning_pg
    md.save_plant_periods(c.plant, [period("a", "2026-10-01", "2026-10-31")], user_email=c.actor)
    md.save_plant_periods(c.plant, [period("b", "2026-10-15", "2026-11-30")], deletes=["a"], user_email=c.actor)
    assert [p["id"] for p in md.load_plant_periods(c.plant)] == ["b"]


@pytest.mark.parametrize("bad,code", [
    (period(valid_from="2026-1-2"), "period_dates_invalid"),
    (period(valid_from="2026-10-20", valid_to="2026-10-19"), "period_dates_invalid"),
    (period(work_hours={"1": [16, 8]}), "period_hours_invalid"),
    (period(work_hours={}), "period_hours_invalid"),
    (period(pid=""), "period_invalid"),
])
def test_bad_period_is_rejected_with_code_and_leaves_db_and_audit_untouched(planning_pg, bad, code):
    c = planning_pg
    with pytest.raises(md.PlantPeriodError) as e:
        md.save_plant_periods(c.plant, [period("ok", "2030-01-01", None), bad], user_email=c.actor)
    assert e.value.code == code
    assert _period_count(c) == 0
    assert audit_rows(c, "plant_calendar_period") == []


def test_period_save_writes_one_audit_row(planning_pg):
    c = planning_pg
    md.save_plant_periods(c.plant, [period("a")], user_email=c.actor)
    ((action, details),) = audit_rows(c, "plant_calendar_period")
    assert action == "save" and details["plant"] == c.plant
    assert details["upserted"] == 1 and details["deleted"] == 0 and details["ids"] == ["a"]


def test_plant_delete_cascades_to_periods(planning_pg):
    c = planning_pg
    md.save_plant_periods(c.other, [period("a")], user_email=c.actor)
    with c.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM plants WHERE plant = %s", (c.other,))
        conn.commit()
    assert _period_count(c, c.other) == 0


def test_unknown_plant_periods_load_empty_and_write_is_rejected(planning_pg):
    c = planning_pg
    unknown = c.plant + "_MISSING"
    assert md.load_plant_periods(unknown) == []
    with pytest.raises(ValueError, match="not in Master Data"):
        md.save_plant_periods(unknown, [period()], user_email=c.actor)
    assert audit_rows(c, "plant_calendar_period") == []


def test_http_periods_round_trip_and_400_carries_code_and_ids(planning_pg, monkeypatch):
    c = planning_pg
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "calendar-test-key")
    monkeypatch.setattr(auth, "get_user_role", lambda email: "admin" if email == c.actor else None)
    headers = {"x-user-email": c.actor, "x-api-key": "calendar-test-key"}
    with closing(TestClient(brain.api)) as client:
        url = "/plant-calendar/plant-periods"
        ok = client.post(url, headers=headers, json={"plant": c.plant, "upserts": [period("a", "2026-10-01", "2026-10-31")]})
        assert ok.status_code == 200 and ok.json() == {"upserted": 1, "deleted": 0}
        config = client.get("/plant-calendar", headers=headers, params={"plant": c.plant}).json()
        assert [p["id"] for p in config["plant_periods"]] == ["a"]
        bad = client.post(url, headers=headers, json={"plant": c.plant, "upserts": [period("b", "2026-10-31", None)]})
        assert bad.status_code == 400
        detail = bad.json()["detail"]
        assert detail["code"] == "period_overlap" and sorted(detail["ids"]) == ["a", "b"] and detail["message"]
        missing = client.post(url, headers=headers, json={"plant": c.plant + "_MISSING", "upserts": [period()]})
        assert missing.status_code == 400 and missing.json()["detail"]["code"] == "plant_not_mastered"
        gone = client.post(url, headers=headers, json={"plant": c.plant, "deletes": ["a"]})
        assert gone.status_code == 200 and gone.json() == {"upserted": 0, "deleted": 1}


def test_http_calendar_save_hydrate_delete_round_trip_uses_real_database(planning_pg, monkeypatch):
    c = planning_pg
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "calendar-test-key")
    monkeypatch.setattr(auth, "get_user_role", lambda email: "admin" if email == c.actor else None)
    headers = {"x-user-email": c.actor, "x-api-key": "calendar-test-key"}
    # Closing the client does not start app lifespan/background SAP polling.
    with closing(TestClient(brain.api)) as client:
        for path, body in [
            ("plant-hours", {"work_hours": {"1": [7.5, 16]}}),
            ("line-hours", {"lines": [{"machine": c.machine, "work_hours": {"1": [9, 17]}}]}),
            ("line-blackouts", {"upserts": [block(machine=c.machine)]}),
            ("plant-blackouts", {"upserts": [block()]}),
        ]:
            response = client.post(f"/plant-calendar/{path}", headers=headers, json={"plant": c.plant, **body})
            assert response.status_code == 200, response.text
        response = client.get("/plant-calendar", headers=headers, params={"plant": c.plant})
        assert response.status_code == 200, response.text
        config = response.json()
        assert config["plant_work_hours"] == {"1": [7.5, 16]}
        assert config["line_work_hours"] == {c.machine: {"1": [9, 17]}}
        assert config["machine_blackouts"] == [block(machine=c.machine)]
        assert config["plant_blackouts"] == [block()]
        response = client.post("/plant-calendar/plant-blackouts", headers=headers,
                               json={"plant": c.plant, "deletes": ["maintenance"]})
        assert response.status_code == 200 and response.json() == {"upserted": 0, "deleted": 1}
        config = client.get("/plant-calendar", headers=headers, params={"plant": c.plant}).json()
        assert config["plant_blackouts"] == []
        assert config["machine_blackouts"] == [block(machine=c.machine)]


# Part 2 (2026-10-23): /tasks/horizons carries a plant-scoped calendar fingerprint so another tab can notice a change.
def test_horizons_calendar_version_changes_on_every_calendar_write_and_is_plant_scoped(planning_pg):
    import db
    from backend.scheduling import routes as scheduling_routes

    c = planning_pg
    v0 = db.plant_horizons(c.plant)["calendar_version"]
    assert isinstance(v0, str) and len(v0) == 32
    assert db.plant_horizons(c.plant)["calendar_version"] == v0, "stable while nothing changes"
    other0 = db.plant_horizons(c.other)["calendar_version"]

    seen = {v0}

    def changed():
        v = db.plant_horizons(c.plant)["calendar_version"]
        assert v not in seen, "the fingerprint must move on this write"
        seen.add(v)

    md.save_plant_periods(c.plant, [period("a")], user_email=c.actor)
    changed()                                                             # a period save
    md.set_plant_work_hours(c.plant, {"1": [8, 16]}, c.actor)
    changed()                                                             # the plant default week
    md.set_line_work_hours(c.plant, [{"machine": c.machine, "work_hours": {"1": [9, 15]}}], c.actor)
    changed()                                                             # a machine row
    md.save_plant_blackouts(c.plant, [block()], user_email=c.actor)
    changed()                                                             # a plant blackout
    md.save_machine_blackouts(c.plant, [block("m1", machine=c.machine)], user_email=c.actor)
    changed()                                                             # a machine blackout
    md.save_plant_periods(c.plant, [], deletes=["a"], user_email=c.actor)
    changed()                                                             # a delete moves it too

    assert db.plant_horizons(c.other)["calendar_version"] == other0, "another plant's writes never move it"
    assert db.plant_horizons("NO_SUCH_PLANT_X")["calendar_version"] is None

    body = scheduling_routes.get_task_horizons(plant=c.plant, allowed_plants=None)
    assert body["calendar_version"] == db.plant_horizons(c.plant)["calendar_version"]

    # GET /plant-calendar carries the same fingerprint: hydration records it as the baseline the probe compares with.
    from backend.calendars import routes as calendar_routes
    cfg = calendar_routes.plant_calendar_get(c.plant)
    assert cfg["calendar_version"] == body["calendar_version"]
    md.save_plant_periods(c.plant, [period("z", "2027-06-01", None)], user_email=c.actor)
    assert calendar_routes.plant_calendar_get(c.plant)["calendar_version"] != cfg["calendar_version"]
