"""Report job types: artifacts (pure cap/page/CSV tests run anywhere) and each of the five reports against rows in a
throwaway Postgres (`@pytest.mark.pg`, NIMBUS_TEST_DB=1)."""
import json
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from backend.jobs import artifacts, windows
from tests.test_jobs import _wait, api, jobs_pg  # noqa: F401 - fixtures

from backend.jobs.types.reports import PLANT_TOTAL, PLANT_WIDE  # noqa: E402

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
        " original_finish_received, planning_status, planning_reason, prt_01)"
        " VALUES (%s, %s, 'ZZ_MAT', %s, %s, %s, %s, %s, %s,"
        " CASE WHEN %s = 'needs_planning' THEN '{\"code\":\"x\",\"message\":\"y\"}'::jsonb END, %s)",
        (oid, oid, machine, plant, start, end, due, status, status, prt))


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
        cur.execute("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_schedule_event_plant_at'")
        row = cur.fetchone()
    assert row and "(plant, at DESC)" in row[0]
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_indexes WHERE indexname = 'idx_schedule_event_plant'")
        assert cur.fetchone() is None, "the first draft's (plant, id) index is removed by the startup hook"


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
    counts = {(r[0], r[1]): r[3] for r in secs["counts"]["rows"]}
    assert counts[("source", "drag")] == 3 and counts[("source", "optimizer")] == 1 and counts[("op", "modify")] == 4
    assert counts[("category", "planner")] == 3 and counts[("category", "optimizer")] == 1
    assert {c["key"]: c["type"] for c in secs["top_orders"]["columns"]} == {
        "production_order": "text", "material_number": "text", "changes": "number", "last_change": "datetime"}
    assert not any(c["key"] == "order_id" for c in secs["top_orders"]["columns"])
    assert "T" in secs["top_orders"]["rows"][0][3] and "+" not in secs["top_orders"]["rows"][0][3][10:], "plant-local naive ISO"
    assert "notes" not in secs, "a 7-day window is inside the 14-day retention"
    assert [r[0] for r in secs["top_orders"]["rows"]][:2] == ["zz-o1", "zz-o2"]
    assert run["summary"]["row_counts"] == {"counts": len(secs["counts"]["rows"]), "top_orders": 2}


@pytest.mark.pg
def test_what_changed_watermark_is_the_previous_scheduled_window_end(api, rep):
    import backend.jobs.data as data
    j = api.post("/jobs", json={"plant": rep.plant, "job_type": "report.what_changed", "name": "digest",
                                "params": {}}).json()
    assert data.last_success_watermark(j["id"]) is None
    first = _wait(api, api.post(f"/jobs/{j['id']}/run").json()["run"]["id"], t=60)
    assert first["trigger"] == "manual"
    assert data.last_success_watermark(j["id"]) is None, "a manual run never moves the watermark"
    end = datetime(2026, 10, 27, 12, 0, tzinfo=timezone.utc)
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO job_run (job_id, plant, job_type, status, trigger, started_at, ended_at, summary)"
                    " VALUES (%s, %s, 'report.what_changed', 'succeeded', 'schedule', %s, %s, %s::jsonb)",
                    (j["id"], rep.plant, end + timedelta(minutes=5), end + timedelta(minutes=6),
                     json.dumps({"window": {"end": end.isoformat()}})))
        conn.commit()
    assert data.last_success_watermark(j["id"]) == end, "anchored on the resolved END, not on started_at"
    nxt = _wait(api, api.post(f"/jobs/{j['id']}/run").json()["run"]["id"], t=60)
    start = datetime.fromisoformat(nxt["summary"]["window"]["start"])
    assert start.astimezone(timezone.utc) == end
    stop = datetime.fromisoformat(nxt["summary"]["window"]["end"])
    started = datetime.fromisoformat(nxt["started_at"])
    assert 100 <= (started - stop).total_seconds() <= 200, "the window ends a safety margin before the run started"
    assert nxt["summary"]["safety_margin_s"] == 120


@pytest.mark.pg
def test_what_changed_flags_a_window_older_than_the_retention(api, rep):
    win = {"mode": "fixed", "fixed": {"from": (datetime.now().date() - timedelta(days=90)).isoformat(),
                                      "to": datetime.now().date().isoformat()}}
    run = _run(api, rep.plant, "report.what_changed", {"window": win})
    assert run["status"] == "succeeded" and run["summary"]["window_truncated"] is True
    assert run["summary"]["retention_days"] >= 1
    notes = _sections(_artifact(api, run["id"]))["notes"]["rows"]
    assert notes[0][0] == "window_truncated" and notes[0][1] == run["summary"]["retention_days"]


@pytest.mark.pg
def test_late_orders_report(api, rep):
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        _order(cur, rep.plant, "zz-late", start=_local_naive(1), end=_local_naive(3), due=_local_naive(1))
        _order(cur, rep.plant, "zz-ontime", start=_local_naive(1), end=_local_naive(2), due=_local_naive(5))
        _order(cur, rep.plant, "zz-queued", status="needs_planning", due=_local_naive(0, -5))
        _order(cur, rep.plant, "zz-far", start=_local_naive(40), end=_local_naive(42), due=_local_naive(30))
        conn.commit()
    run = _run(api, rep.plant, "report.late_orders")
    assert run["status"] == "succeeded", "report content never changes the run status"
    assert run["summary"]["late_orders"] == 1 and run["summary"]["queued_past_due"] == 1, run
    assert run["summary"]["findings"] == 2
    secs = _sections(_artifact(api, run["id"]))
    assert [r[2] for r in secs["orders"]["rows"]] == ["zz-late"]
    assert secs["orders"]["rows"][0][0] == "window" and secs["orders"]["rows"][0][6] == pytest.approx(2.0, abs=0.01)
    assert secs["by_machine"]["rows"][0][:2] == ["SHARED_LINE", 1]
    assert [(r[0], r[3]) for r in secs["queued"]["rows"]] == [("past_due", "zz-queued")]
    assert {c["key"]: c["type"] for c in secs["orders"]["columns"]}["finish"] == "datetime"
    assert run["summary"]["window"]["label"].startswith(_local_naive().date().isoformat())
    warned = _run(api, rep.plant, "report.late_orders", {"warn_if_over": 1})
    assert warned["status"] == "warning", "2 findings exceed warn_if_over=1"
    quiet = _run(api, rep.plant, "report.late_orders", {"warn_if_over": 2})
    assert quiet["status"] == "succeeded"
    strict = _run(api, rep.plant, "report.late_orders", {"min_days_late": 5})
    assert strict["status"] == "succeeded" and strict["summary"]["late_orders"] == 0


@pytest.mark.pg
def test_late_orders_date_only_due_is_the_close_of_the_day_and_overdue_is_kept(api, rep):
    today = _local_naive().replace(hour=0, minute=0, second=0)
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE plants SET work_hours = %s::jsonb WHERE plant = %s",
                    (json.dumps({str(d): [0, 24] for d in range(7)}), rep.plant))
        _order(cur, rep.plant, "zz-sameday", start=today, end=today + timedelta(hours=1), due=today)     # on the day
        _order(cur, rep.plant, "zz-old", start=today, end=today + timedelta(days=2), due=today - timedelta(days=3))
        _order(cur, rep.plant, "zz-after", start=today, end=today + timedelta(days=40), due=today + timedelta(days=2))
        conn.commit()
    run = _run(api, rep.plant, "report.late_orders")
    rows = {r[2]: r for r in _sections(_artifact(api, run["id"]))["orders"]["rows"]}
    assert "zz-sameday" not in rows, "a date-only due finishing on that day is on time"
    assert rows["zz-old"][0] == "overdue", "due before the window start: the Already overdue bucket"
    assert rows["zz-after"][0] == "window", "due inside the horizon even though it finishes after it"
    assert run["summary"]["overdue_orders"] == 1


@pytest.mark.pg
def test_missing_master_data_report(api, rep):
    clean = _run(api, rep.plant, "report.missing_master_data")
    assert clean["status"] == "succeeded" and clean["summary"]["unmatched_pairs"] == 0
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        _order(cur, rep.plant, "zz-mm1")
        _order(cur, rep.plant, "zz-mm2")
        conn.commit()
    run = _run(api, rep.plant, "report.missing_master_data")
    assert run["status"] == "succeeded" and run["summary"]["unmatched_orders"] == 2
    rows = _sections(_artifact(api, run["id"]))["exceptions"]["rows"]
    assert rows[0][0] == "no_mp_row" and rows[0][3] == 2
    assert _run(api, rep.plant, "report.missing_master_data", {"warn_if_over": 0})["status"] == "warning"
    assert _run(api, rep.plant, "report.missing_master_data", {"warn_if_over": 1})["status"] == "succeeded"


@pytest.mark.pg
def test_coverage_report_sections_are_selectable(api, rep):
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        _order(cur, rep.plant, "zz-t1", prt=" tool-a ")
        _order(cur, rep.plant, "zz-t2", prt="TOOL-A")
        cur.execute("INSERT INTO tool_inventory (plant, tool_id, total_qty) VALUES (%s, 'TOOL-A', 2)", (rep.plant,))
        conn.commit()
    run = _run(api, rep.plant, "report.coverage", {"sections": ["tools", "priority_lists"]})
    assert run["status"] == "succeeded", run
    secs = _sections(_artifact(api, run["id"]))
    assert set(secs) <= {"tools", "priority_lists", "notes"} and {"tools", "priority_lists"} <= set(secs)
    assert secs["tools"]["rows"] == [["TOOL-A", 2, True, 2, 0, 2, False]]
    assert {c["key"]: c["type"] for c in secs["tools"]["columns"]}["no_usable_copy"] == "bool"
    notes = secs.get("notes", {"rows": []})["rows"]
    listed = {r[0] for r in secs["priority_lists"]["rows"]}
    assert listed.isdisjoint({r[1] for r in notes if r[0] == "no_list"}), "a field without a list is a note, not noise"
    assert all(r[1] in (PLANT_TOTAL, PLANT_WIDE) or r[1] for r in secs["priority_lists"]["rows"])
    full = _run(api, rep.plant, "report.coverage")
    assert {"tools", "priority_lists"} <= set(_sections(_artifact(api, full["id"]))), full


@pytest.mark.pg
def test_coverage_skips_setup_with_a_note_when_setup_is_off(api, rep):
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE plants SET setup_active = FALSE WHERE plant = %s", (rep.plant,))
        conn.commit()
    try:
        run = _run(api, rep.plant, "report.coverage", {"sections": ["setup"]})
    finally:
        with rep.db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("UPDATE plants SET setup_active = TRUE WHERE plant = %s", (rep.plant,))
            conn.commit()
    secs = _sections(_artifact(api, run["id"]))
    assert run["status"] == "succeeded" and "setup" not in secs and secs["notes"]["rows"] == [["setup_off", ""]]


@pytest.mark.pg
def test_distribution_report_unresolved(api, rep):
    with rep.db._pool.connection() as conn, conn.cursor() as cur:
        _order(cur, rep.plant, "zz-d1", machine="GHOST_WC")
        conn.commit()
    run = _run(api, rep.plant, "report.distribution")
    assert run["status"] == "succeeded" and run["summary"]["unresolved_orders"] == 1, run
    assert _run(api, rep.plant, "report.distribution", {"warn_if_over": 0})["status"] == "warning"
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


# ------------------------------------------------------------------------ W2 fix wave: pure report/artifact tests
def test_columns_carry_a_type_and_plain_strings_default_to_text():
    sec = artifacts.section("a", "A", ["x", ("y", "Why"), ("z", "Zed", "number"), artifacts.col("d", "datetime")], [])
    assert [(c["key"], c["label"], c["type"]) for c in sec["columns"]] == [
        ("x", "x", "text"), ("y", "Why", "text"), ("z", "Zed", "number"), ("d", "d", "datetime")]
    with pytest.raises(ValueError):
        artifacts.col("k", "money")


def test_nan_and_inf_become_null_and_datetimes_are_iso():
    art = {"sections": [artifacts.section("a", "A", ["n", "d"], [[float("nan"), datetime(2026, 10, 28, 9, 30)],
                                                                [float("inf"), None], [1.5, None]])], "summary": {}}
    out, _ = artifacts.cap_artifact(art)
    assert [r[0] for r in out["sections"][0]["rows"]] == [None, None, 1.5]
    text = artifacts._dumps(out)
    assert "NaN" not in text and "Infinity" not in text
    assert datetime(2026, 10, 28, 9, 30).isoformat() in text


def test_cap_gives_up_rows_or_flags_an_error_when_nothing_fits():
    out, trunc = artifacts.cap_artifact(_art(50, 400), limit=1500)
    assert len(artifacts._dumps(out).encode()) <= 1500 or out["summary"].get("artifact_error") == "too_large"
    tiny, t2 = artifacts.cap_artifact({"sections": [artifacts.section("a", "A", ["c" * 3000], [[1]])], "summary": {}}, limit=1024)
    assert t2 and tiny["sections"][0]["rows"] == [] and tiny["summary"]["artifact_error"] == "too_large"


def test_report_module_contains_no_write_sql():
    import re
    from pathlib import Path
    text = (Path(__file__).resolve().parent.parent / "backend" / "jobs" / "types" / "reports.py").read_text(encoding="utf-8")
    assert not re.search(r"\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b", text)
    assert "SET TRANSACTION READ ONLY" in text


def test_report_status_is_never_driven_by_content():
    from backend.jobs.types import reports
    assert reports._outcome([], summary={}, count=500, warn_if_over=None).status == "succeeded"
    assert reports._outcome([], summary={}, count=5, warn_if_over=5).status == "succeeded"
    assert reports._outcome([], summary={}, count=6, warn_if_over=5).status == "warning"
    assert reports._outcome([], summary={}).status == "succeeded"


def test_what_changed_categories_cover_every_documented_source():
    from backend.jobs.types.reports import CATEGORY_ORDER, SOURCE_CATEGORY
    assert {SOURCE_CATEGORY[k] for k in ("drag", "keyboard", "grid", "inspector", "alert_fix")} == {"planner"}
    assert SOURCE_CATEGORY["optimizer"] == "optimizer" and SOURCE_CATEGORY["sap_ingest"] == "ingest"
    assert SOURCE_CATEGORY["routing_hold"] == SOURCE_CATEGORY["master_data_stamp"] == "routing"
    assert SOURCE_CATEGORY["purge"] == SOURCE_CATEGORY["sap_vanish"] == "purge"
    assert set(SOURCE_CATEGORY.values()) <= set(CATEGORY_ORDER)
