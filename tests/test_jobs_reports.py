"""Report job types: artifacts (pure cap/page/CSV tests run anywhere) and each of the five reports against rows in a
throwaway Postgres (`@pytest.mark.pg`, NIMBUS_TEST_DB=1)."""
import json
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from backend.jobs import artifacts, windows
from tests.test_jobs import _wait, api, jobs_pg  # noqa: F401 - fixtures

pytest_plugins = ("tests.support.planning_pg",)

CHI = "America/Chicago"


# ----------------------------------------------------------------------------------------------- pure
def _art(n, width=40):
    rows = [[i, "x" * width] for i in range(n)]
    return {"sections": [artifacts.section("a", "A", ["i", "s"], rows), artifacts.section("b", "B", ["i"], [[1], [2]])],
            "summary": {"k": 1}}


def test_cap_keeps_small_artifacts_whole():
    out, trunc = artifacts.cap_artifact(_art(10), limit=1_000_000)
    assert not trunc and [s["row_count"] for s in out["sections"]] == [10, 2]
    assert all(s["truncated"] is False for s in out["sections"]) and "truncated" not in out["summary"]


def test_cap_truncates_largest_section_with_flag_and_counts():
    out, trunc = artifacts.cap_artifact(_art(5000), limit=20_000)
    a, b = out["sections"]
    assert trunc and a["truncated"] and not b["truncated"]
    assert a["row_count"] == 5000 and 0 < len(a["rows"]) < 5000, "row_count is the pre-cap total"
    assert len(json.dumps(out, separators=(",", ":")).encode()) <= 20_000
    assert out["summary"]["truncated"] is True and out["summary"]["max_bytes"] == 20_000


def test_cap_env_override(monkeypatch):
    monkeypatch.setenv("NIMBUS_JOBS_ARTIFACT_MAX_BYTES", "4096")
    assert artifacts.max_bytes() == 4096
    monkeypatch.setenv("NIMBUS_JOBS_ARTIFACT_MAX_BYTES", "junk")
    assert artifacts.max_bytes() == artifacts.DEFAULT_MAX_BYTES


def test_page_clamps_to_500_and_reports_stored():
    out, _ = artifacts.cap_artifact(_art(1200, 4), limit=1_000_000)
    p = artifacts.page(out["sections"][0], 500, 9999)
    assert len(p["rows"]) == 500 and p["offset"] == 500 and p["limit"] == 500 and p["rows_stored"] == 1200
    assert len(artifacts.page(out["sections"][0], 1100, 500)["rows"]) == 100


def test_csv_has_bom_header_and_formula_guard():
    sec = artifacts.section("a", "A", [("i", "Item"), "s"], [[1, "=SUM(A1)"], [2, None]])
    text = artifacts.section_csv(sec)
    assert text.startswith("﻿Item,s\r\n") and "'=SUM(A1)" in text and "2,\r\n" in text


# -------------------------------------------------------------------------------------------------- pg
@pytest.fixture
def rep(jobs_pg):
    """jobs_pg plus: plant timezone set, an ensured schedule_event table and cleanup of what the tests insert."""
    import backend.schedule_events.data as sed
    db = jobs_pg.db
    sed.ensure_schedule_event_table()
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE plants SET timezone = %s WHERE plant = %s", (CHI, jobs_pg.plant))
        conn.commit()
    yield jobs_pg
    with db._pool.connection() as conn, conn.cursor() as cur:
        plants = [jobs_pg.plant, jobs_pg.other]
        cur.execute("DELETE FROM job_run_artifact WHERE run_id IN (SELECT id FROM job_run WHERE plant = ANY(%s))",
                    (plants,))
        cur.execute("DELETE FROM schedule_event WHERE plant = ANY(%s)", (plants,))
        cur.execute("DELETE FROM orders WHERE plant = ANY(%s)", (plants,))
        cur.execute("DELETE FROM tool_inventory WHERE plant = ANY(%s)", (plants,))
        conn.commit()


def _run(api, plant, job_type, params=None, name="r"):
    r = api.post("/jobs", json={"plant": plant, "job_type": job_type, "name": name, "params": params or {}})
    assert r.status_code == 200, r.text
    run = api.post(f"/jobs/{r.json()['id']}/run").json()["run"]
    return _wait(api, run["id"], t=60)


def _artifact(api, run_id, **q):
    r = api.get(f"/jobs/runs/{run_id}/artifact", params=q)
    assert r.status_code == 200, r.text
    return r.json()


def _sections(art):
    return {s["key"]: s for s in art["sections"]}


def _order(cur, plant, oid, *, machine="SHARED_LINE", start=None, end=None, due=None, status="scheduled", prt=None):
    cur.execute(
        "INSERT INTO orders (id, production_order, material_number, machine, plant, scheduled_start, scheduled_end,"
        " original_finish_received, planning_status, prt_01) VALUES (%s, %s, 'ZZ_MAT', %s, %s, %s, %s, %s, %s, %s)",
        (oid, oid, machine, plant, start, end, due, status, prt))


def _event(cur, plant, order_id, source="drag", actor="a@x.com", op="modify", at=None):
    cur.execute(
        "INSERT INTO schedule_event (plant, order_id, production_order, material_number, action_id, source, actor, op,"
        " changes, at) VALUES (%s, %s, %s, 'ZZ_MAT', %s, %s, %s, %s, '{\"machine\": [\"A\", \"B\"]}'::jsonb,"
        " COALESCE(%s, clock_timestamp()))",
        (plant, order_id, order_id, str(uuid.uuid4()), source, actor, op, at))


def _local_naive(days=0, hours=0):
    """A plant-local naive wall time relative to the plant's now (matches how orders store dates)."""
    return (datetime.now(ZoneInfo(CHI)) + timedelta(days=days, hours=hours)).replace(tzinfo=None, microsecond=0)


@pytest.mark.pg
def test_schedule_event_plant_index_exists(rep):
    import backend.schedule_events.data as sed
    sed.ensure_schedule_event_table()
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_schedule_event_plant'")
        row = cur.fetchone()
    assert row and "(plant, id DESC)" in row[0]


@pytest.mark.pg
def test_what_changed_counts_top_orders_and_window(api, rep):
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        for _ in range(3):
            _event(cur, rep.plant, "zz-o1", source="drag")
        _event(cur, rep.plant, "zz-o2", source="optimizer", actor="job:1")
        _event(cur, rep.plant, "zz-old", at=datetime.now(timezone.utc) - timedelta(days=40))
        _event(cur, rep.other, "zz-other")
        conn.commit()
    win = windows.last_days(7)
    pre = api.post("/jobs/windows/preview", json={"plant": rep.plant, "window": win}).json()
    run = _run(api, rep.plant, "report.what_changed", {"window": win, "top_n": 5})
    assert run["status"] == "succeeded", run
    assert run["summary"]["events"] == 4 and run["summary"]["orders_changed"] == 2
    assert run["summary"]["window"]["label"] == pre["label"], "the run resolved what the preview showed"
    assert run["summary"]["window"]["timezone"] == CHI
    secs = _sections(_artifact(api, run["id"]))
    counts = {(r[0], r[1]): r[2] for r in secs["counts"]["rows"]}
    assert counts[("source", "drag")] == 3 and counts[("source", "optimizer")] == 1 and counts[("op", "modify")] == 4
    assert [r[0] for r in secs["top_orders"]["rows"]][:2] == ["zz-o1", "zz-o2"]
    assert run["summary"]["row_counts"] == {"counts": len(secs["counts"]["rows"]), "top_orders": 2}


@pytest.mark.pg
def test_what_changed_since_last_success_advances(api, rep):
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        _event(cur, rep.plant, "zz-a", at=datetime.now(timezone.utc) - timedelta(hours=30))
        conn.commit()
    j = api.post("/jobs", json={"plant": rep.plant, "job_type": "report.what_changed", "name": "digest",
                                "params": {}}).json()
    first = _wait(api, api.post(f"/jobs/{j['id']}/run").json()["run"]["id"], t=60)
    assert first["summary"]["events"] == 0, "first run looks back 1 day by default; the event is 30 h old"
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        _event(cur, rep.plant, "zz-b")
        conn.commit()
    second = _wait(api, api.post(f"/jobs/{j['id']}/run").json()["run"]["id"], t=60)
    assert second["summary"]["events"] == 1
    started = datetime.fromisoformat(first["started_at"]).astimezone(ZoneInfo(CHI))
    assert second["summary"]["window"]["start"][:16] == started.isoformat(timespec="seconds")[:16]


@pytest.mark.pg
def test_late_orders_report(api, rep):
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        _order(cur, rep.plant, "zz-late", start=_local_naive(1), end=_local_naive(3), due=_local_naive(1))
        _order(cur, rep.plant, "zz-ontime", start=_local_naive(1), end=_local_naive(2), due=_local_naive(5))
        _order(cur, rep.plant, "zz-queued", status="needs_planning", due=_local_naive(0, -5))
        _order(cur, rep.plant, "zz-far", start=_local_naive(40), end=_local_naive(42), due=_local_naive(30))
        conn.commit()
    run = _run(api, rep.plant, "report.late_orders")
    assert run["status"] == "warning" and run["summary"]["late_orders"] == 1, run
    secs = _sections(_artifact(api, run["id"]))
    assert [r[1] for r in secs["orders"]["rows"]] == ["zz-late"]
    assert secs["orders"]["rows"][0][5] == pytest.approx(2.0, abs=0.01)
    assert secs["by_machine"]["rows"][0][:2] == ["SHARED_LINE", 1]
    assert run["summary"]["window"]["label"].startswith(_local_naive().date().isoformat())
    strict = _run(api, rep.plant, "report.late_orders", {"min_days_late": 5})
    assert strict["status"] == "succeeded" and strict["summary"]["late_orders"] == 0


@pytest.mark.pg
def test_missing_master_data_report(api, rep):
    clean = _run(api, rep.plant, "report.missing_master_data")
    assert clean["status"] == "succeeded" and clean["summary"]["unmatched_pairs"] == 0
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        _order(cur, rep.plant, "zz-mm1")
        _order(cur, rep.plant, "zz-mm2")
        conn.commit()
    run = _run(api, rep.plant, "report.missing_master_data")
    assert run["status"] == "warning" and run["summary"]["unmatched_orders"] == 2
    rows = _sections(_artifact(api, run["id"]))["exceptions"]["rows"]
    assert rows[0][0] == "no_mp_row" and rows[0][3] == 2


@pytest.mark.pg
def test_coverage_report_sections_are_selectable(api, rep):
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        _order(cur, rep.plant, "zz-t1", prt=" tool-a ")
        _order(cur, rep.plant, "zz-t2", prt="TOOL-A")
        cur.execute("INSERT INTO tool_inventory (plant, tool_id, total_qty) VALUES (%s, 'TOOL-A', 2)", (rep.plant,))
        conn.commit()
    run = _run(api, rep.plant, "report.coverage", {"sections": ["tools", "priority_lists"]})
    assert run["status"] in ("succeeded", "warning"), run
    secs = _sections(_artifact(api, run["id"]))
    assert set(secs) == {"tools", "priority_lists"}
    assert secs["tools"]["rows"] == [["TOOL-A", 2, "yes", 2, 0]]
    assert {"colorWheel", "prt01", "prt02"} <= {r[0] for r in secs["priority_lists"]["rows"]}
    full = _run(api, rep.plant, "report.coverage")
    assert set(_sections(_artifact(api, full["id"]))) == {"tools", "priority_lists", "setup"}, full


@pytest.mark.pg
def test_distribution_report_unresolved(api, rep):
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        _order(cur, rep.plant, "zz-d1", machine="GHOST_WC")
        conn.commit()
    run = _run(api, rep.plant, "report.distribution")
    assert run["status"] == "warning" and run["summary"]["unresolved_orders"] == 1, run
    secs = _sections(_artifact(api, run["id"]))
    assert secs["unresolved"]["rows"] == [["GHOST_WC", 1, "no_machine_row"]]
    assert "aggregate" in secs
    windowed = _run(api, rep.plant, "report.distribution", {"filter_by_window": True})
    assert windowed["summary"]["window"]["timezone"] == CHI


@pytest.mark.pg
def test_window_without_plant_timezone_fails_as_config(api, rep):
    run = _run(api, rep.other, "report.late_orders")            # rep.other has no timezone
    assert run["status"] == "failed" and "no timezone" in run["error"]
    assert run["summary"]["error_kind"] == "config" and run["summary"]["failed_step"] == "window"
    assert api.get(f"/jobs/runs/{run['id']}/artifact").status_code == 404
    mm = _run(api, rep.other, "report.missing_master_data")      # no window: no timezone needed
    assert mm["status"] == "succeeded"


@pytest.mark.pg
def test_artifact_size_cap_truncates_and_pages(api, rep, monkeypatch):
    monkeypatch.setenv("NIMBUS_JOBS_ARTIFACT_MAX_BYTES", "3000")
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        for i in range(120):
            _event(cur, rep.plant, f"zz-big-{i:03d}")
        conn.commit()
    run = _run(api, rep.plant, "report.what_changed", {"window": windows.last_days(2), "top_n": 100})
    assert run["status"] == "succeeded", run
    info = run["summary"]["artifact"]
    assert info["truncated"] is True and info["size_bytes"] <= 3000
    assert run["summary"]["row_counts"]["top_orders"] == 100, "the summary keeps the pre-cap count"
    art = _artifact(api, run["id"], section="top_orders", limit=500)
    sec = art["sections"][0]
    assert art["truncated"] is True and sec["truncated"] is True and sec["row_count"] == 100
    assert 0 < sec["rows_stored"] < 100
    page = _artifact(api, run["id"], section="top_orders", offset=1, limit=2)["sections"][0]
    assert len(page["rows"]) == 2 and page["rows"][0] == sec["rows"][1]
    csv_r = api.get(f"/jobs/runs/{run['id']}/artifact", params={"section": "top_orders", "format": "csv"})
    assert csv_r.status_code == 200 and csv_r.text.count("\r\n") == sec["rows_stored"] + 1


@pytest.mark.pg
def test_retention_sweep_removes_artifacts_with_their_run(api, rep):
    import backend.jobs.data as data
    run = _run(api, rep.plant, "report.missing_master_data")
    assert data.get_artifact(run["id"]) is not None
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE job_run SET created_at = now() - interval '30 days' WHERE id = %s", (run["id"],))
        conn.commit()
    res = data.sweep_job_runs(retention_days=7, pause_s=0)
    assert res["error"] is None and res["deleted_artifacts"] >= 1
    assert data.get_artifact(run["id"]) is None and api.get(f"/jobs/runs/{run['id']}").status_code == 404


@pytest.mark.pg
def test_artifact_ddl_is_idempotent_and_has_no_cascade(rep):
    import backend.jobs.data as data
    data.ensure_job_tables()
    data.ensure_job_tables()
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT confdeltype FROM pg_constraint WHERE conrelid = 'job_run_artifact'::regclass AND contype = 'f'")
        assert [r[0] for r in cur.fetchall()] == ["a"], "NO ACTION: nothing cascades"


@pytest.mark.pg
def test_report_types_cannot_write_orders(api, rep):
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        _order(cur, rep.plant, "zz-ro", start=_local_naive(1), end=_local_naive(2), due=_local_naive(0))
        conn.commit()
        cur.execute("SELECT xmin::text FROM orders WHERE id = 'zz-ro'")
        before = cur.fetchone()[0]
    for jt in ("report.late_orders", "report.missing_master_data", "report.distribution", "report.coverage",
               "report.what_changed"):
        assert _run(api, rep.plant, jt)["status"] in ("succeeded", "warning")
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT xmin::text FROM orders WHERE id = 'zz-ro'")
        assert cur.fetchone()[0] == before
