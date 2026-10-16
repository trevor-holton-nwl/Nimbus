"""DB-free: the Python twin of the calendar-period rules, driven by the shared vectors."""

import json
import os
from datetime import date

import pytest

import master_data as md

_VECTORS = os.path.join(os.path.dirname(__file__), "fixtures", "plant_period_vectors.json")
with open(_VECTORS, encoding="utf-8") as _f:
    VECTORS = json.load(_f)


@pytest.mark.parametrize("case", VECTORS["active"], ids=lambda c: c["name"])
def test_active_work_hours_matches_vectors(case):
    periods = case["periods"]
    by_id = {p["id"]: p["work_hours"] for p in periods}
    got = md.active_work_hours(case["default"], periods, date.fromisoformat(case["day"]))
    want = case["default"] if case["expected"] == "default" else by_id[case["expected"]]
    assert got == want


def test_active_work_hours_accepts_date_objects():
    periods = [{"valid_from": date(2026, 10, 20), "valid_to": None, "work_hours": {"1": [1, 2]}}]
    assert md.active_work_hours({"1": [8, 16]}, periods, date(2026, 10, 21)) == {"1": [1, 2]}


@pytest.mark.parametrize("case", VECTORS["validate"], ids=lambda c: c["name"])
def test_validate_matches_vectors(case):
    expected = case["expected"]
    # the vectors only care about dates; give each period valid hours so only dates can fail
    periods = [{**p, "work_hours": p.get("work_hours") or {"1": [8, 16]}} for p in case["periods"]]
    try:
        rows = md._prepare_periods(periods)
        overlap = md._period_overlaps(rows)
    except md.PlantPeriodError as e:
        assert e.code == expected
        return
    if expected == "ok":
        assert overlap is None
    else:
        assert expected == "period_overlap"
        assert sorted(overlap) == sorted(case["ids"])


def _r(pid, vf, vt):
    return {"id": pid, "valid_from": date.fromisoformat(vf), "valid_to": date.fromisoformat(vt) if vt else None}


def test_overlap_check_compares_every_pair_not_just_sorted_neighbours():
    # existing A[1..100] and B[10..20] already overlap; upserting C[50..60] still clashes with A
    # (the sorted neighbour pairs are (A,B) and (B,C), and B does not touch C)
    rows = [_r("A", "2026-01-01", "2026-04-10"), _r("B", "2026-01-10", "2026-01-20"),
            _r("C", "2026-02-19", "2026-03-01")]
    assert md._period_overlaps(rows, involving_ids={"C"}) == ("A", "C")


def test_overlap_involving_ids_ignores_pre_existing_bad_pairs():
    rows = [_r("A", "2026-01-01", "2026-04-10"), _r("B", "2026-01-10", "2026-01-20"),
            _r("C", "2027-01-01", "2027-01-31")]
    assert md._period_overlaps(rows) == ("A", "B")
    assert md._period_overlaps(rows, involving_ids={"C"}) is None
    assert md._period_overlaps(rows, involving_ids={"B"}) == ("A", "B")
    assert md._period_overlaps(rows, involving_ids=set()) is None


def _p(**kw):
    return {"id": "p1", "valid_from": "2026-10-20", "valid_to": None, "work_hours": {"1": [8, 16]}, **kw}


@pytest.mark.parametrize("bad,code", [
    ({"id": ""}, "period_invalid"),
    ({"id": None}, "period_invalid"),
    ({"id": "x" * 65}, "period_invalid"),
    ({"name": "n" * 81}, "period_invalid"),
    ({"valid_from": "2026-1-2"}, "period_dates_invalid"),
    ({"valid_from": "2026-02-30"}, "period_dates_invalid"),
    ({"valid_to": "bogus"}, "period_dates_invalid"),
    ({"work_hours": {}}, "period_hours_invalid"),
    ({"work_hours": {"1": [16, 8]}}, "period_hours_invalid"),
    ({"work_hours": {"9": [1, 2]}}, "period_hours_invalid"),
])
def test_prepare_rejects_with_code(bad, code):
    with pytest.raises(md.PlantPeriodError) as ei:
        md._prepare_periods([_p(**bad)])
    assert ei.value.code == code


def test_prepare_rejects_non_dict_and_duplicate_ids():
    with pytest.raises(md.PlantPeriodError) as ei:
        md._prepare_periods(["nope"])
    assert ei.value.code == "period_invalid"
    with pytest.raises(md.PlantPeriodError) as ei:
        md._prepare_periods([_p(), _p()])
    assert ei.value.code == "period_invalid"


def test_prepare_normalises_hours_and_name():
    (row,) = md._prepare_periods([_p(name="  Winter ")])
    assert row["name"] == "Winter"
    assert row["valid_from"] == date(2026, 10, 20) and row["valid_to"] is None
    assert sorted(row["work_hours"]) == list("0123456")
    assert row["work_hours"]["1"] == [8.0, 16.0] and row["work_hours"]["0"] is None


def test_prepare_caps_upserts_at_200():
    with pytest.raises(md.PlantPeriodError) as ei:
        md._prepare_periods([_p(id=f"p{i}") for i in range(201)])
    assert ei.value.code == "period_invalid"
