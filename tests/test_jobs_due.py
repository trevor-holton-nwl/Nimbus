"""The late-order digest's due rule (backend/jobs/due.py) against the app's, plus the report's classification
(`late_orders_compute`). Pure: no database. The vectors are shared with tests/js/compute-core.test.js, which runs the
SAME cases through NimbusComputeCore.dueDateInstant, so the digest and the app cannot disagree on what is late."""
import json
from datetime import datetime
from pathlib import Path

import pytest

from backend.jobs import due
from backend.jobs.types.reports import late_orders_compute

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "due_rule_vectors.json").read_text(encoding="utf-8"))
iso = datetime.fromisoformat


@pytest.mark.parametrize("case", VECTORS["cases"], ids=[c["name"][:60] for c in VECTORS["cases"]])
def test_due_rule_matches_the_shared_vectors(case):
    close_for = due.make_close_for(VECTORS["calendars"][case["calendar"]])
    di = due.due_instant(iso(case["due_raw"]), lambda d: close_for(case["machine"], d))
    assert di == iso(case["due"])
    assert (iso(case["finish"]) > di) is case["late"]


def test_no_window_at_all_falls_back_to_the_end_of_the_due_day():
    closed = {"plant_work_hours": {str(d): None for d in range(7)}, "plant_periods": [], "line_work_hours": {}}
    di = due.due_instant(iso("2026-10-28T00:00:00"), lambda d, c=due.make_close_for(closed): c("L1", d))
    assert di == iso("2026-10-28T23:59:59")


def test_missing_plant_hours_use_the_app_default_shift():
    close_for = due.make_close_for({})
    assert close_for("L1", iso("2026-10-28").date()) == iso("2026-10-28T19:00:00")      # DEFAULT_SHIFT 7-19
    assert close_for("L1", iso("2026-10-31").date()) is None                            # Saturday off


def _rows(case_cal="weekday_8_17"):
    return VECTORS["calendars"][case_cal]


def test_report_late_list_equals_the_apps_rule_on_the_same_orders():
    cal = due.make_close_for(_rows())
    now = iso("2026-10-28T09:00:00")
    start, end = iso("2026-10-28T00:00:00"), iso("2026-11-11T00:00:00")
    rows = [
        # (machine, po, material, finish, due_raw, status)
        ("L1", "ON_THE_DAY", "M", iso("2026-10-28T14:00:00"), iso("2026-10-28T00:00:00"), "scheduled"),   # must NOT be late
        ("L1", "AFTER_CLOSE", "M", iso("2026-10-28T17:30:00"), iso("2026-10-28T00:00:00"), "scheduled"),
        ("L1", "OVERDUE", "M", iso("2026-10-29T10:00:00"), iso("2026-10-26T00:00:00"), "scheduled"),
        ("L1", "FINISHES_AFTER_HORIZON", "M", iso("2026-12-01T10:00:00"), iso("2026-11-02T00:00:00"), "scheduled"),
        ("L1", "DUE_BEYOND_HORIZON", "M", iso("2026-12-01T10:00:00"), iso("2026-11-30T00:00:00"), "scheduled"),
        ("L1", "QUEUED_PAST", "M", None, iso("2026-10-27T00:00:00"), "needs_planning"),
        ("L1", "QUEUED_SOON", "M", None, iso("2026-10-30T00:00:00"), "needs_planning"),
        ("L1", "QUEUED_FAR", "M", None, iso("2026-12-30T00:00:00"), "needs_planning"),
    ]
    late, queued = late_orders_compute(rows, cal, now, start, end)
    assert {r["production_order"]: r["bucket"] for r in late} == {
        "AFTER_CLOSE": "window", "OVERDUE": "overdue", "FINISHES_AFTER_HORIZON": "window"}
    assert "ON_THE_DAY" not in {r["production_order"] for r in late}
    by = {r["production_order"]: r for r in queued}
    assert set(by) == {"QUEUED_PAST", "QUEUED_SOON"}
    assert by["QUEUED_PAST"]["state"] == "past_due" and by["QUEUED_PAST"]["bucket"] == "overdue"
    assert by["QUEUED_SOON"]["state"] == "due_soon" and by["QUEUED_SOON"]["days_late"] == 0
    # days_late is in days and is measured against the due INSTANT (the close of the day), not midnight
    assert {r["production_order"]: r["days_late"] for r in late}["AFTER_CLOSE"] == pytest.approx(0.02, abs=0.01)


def test_min_days_late_filters_placed_and_queued():
    cal = due.make_close_for(_rows())
    now = iso("2026-10-28T09:00:00")
    rows = [("L1", "A", "M", iso("2026-10-28T17:30:00"), iso("2026-10-28T00:00:00"), "scheduled"),
            ("L1", "Q", "M", None, iso("2026-10-27T00:00:00"), "needs_planning")]
    late, queued = late_orders_compute(rows, cal, now, iso("2026-10-28T00:00:00"), iso("2026-11-11T00:00:00"), 1.0)
    assert late == [] and queued == []
