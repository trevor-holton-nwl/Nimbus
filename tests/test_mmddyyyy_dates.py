"""MM/DD/YYYY display dates in user-facing CSV exports and the routing paste validator.

Storage, API wire formats and ISO keys stay ISO; only what a person reads (CSV downloads) and what
they type (pasted dates) changes. DB-free: every seam is monkeypatched.
"""
import contextlib
import datetime
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

os.environ.setdefault("NIMBUS_PG_POOL_MIN", "0")

from fastapi import Response  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402

import backend.csv_util as csv_util  # noqa: E402
import backend.distribution.routes as dist_routes  # noqa: E402
import backend.master_data.browser as browser  # noqa: E402
import backend.routing.ingest as ingest  # noqa: E402
import backend.routing.routes as routing_routes  # noqa: E402
import backend.security.auth as auth  # noqa: E402
import brain  # noqa: E402


# ---------------------------------------------------------------------------
# csv_util
# ---------------------------------------------------------------------------
def test_us_date_cell_formats_only_date_objects():
    assert csv_util.us_date_cell(datetime.date(2026, 1, 1)) == "01/01/2026"
    assert csv_util.us_date_cell(datetime.datetime(2026, 1, 1, 7, 5, 9)) == "01/01/2026 07:05:09"
    assert csv_util.us_date_cell(datetime.datetime(2026, 1, 1, 7, 5, 9), seconds=False) == "01/01/2026 07:05"
    assert csv_util.us_date_cell(datetime.date(9999, 12, 31)) == "12/31/9999"
    for other in ("2026-01-01", 5, 2.5, None, True, ["x"]):
        assert csv_util.us_date_cell(other) == other


def test_us_date_any_also_handles_iso_strings():
    f = csv_util.us_date_any
    assert f("2026-01-01") == "01/01/2026"
    assert f("2026-01-01T07:05:09") == "01/01/2026 07:05"
    assert f("2026-01-01 07:05:09+00:00") == "01/01/2026 07:05"
    assert f("2026-01-01T07:05:09.123456Z") == "01/01/2026 07:05"
    assert f(datetime.datetime(2026, 10, 22, 19, 0)) == "10/22/2026 19:00"
    for other in ("PO-1", "20261001", "12:30:00", "", None, 7):
        assert f(other) == other


# ---------------------------------------------------------------------------
# Admin table browser CSV
# ---------------------------------------------------------------------------
class _FakeCursor:
    def __init__(self, rows):
        self._rows = rows

    def stream(self, query, params):
        return iter(self._rows)


class _FakePool:
    def __init__(self, rows):
        self._rows = rows

    @contextlib.contextmanager
    def connection(self):
        conn = self

        class _Conn:
            @contextlib.contextmanager
            def cursor(self_inner):
                yield _FakeCursor(conn._rows)

        yield _Conn()


def test_browser_csv_formats_dates_and_keeps_other_types(monkeypatch):
    rows = [(datetime.date(2026, 1, 1), datetime.datetime(2026, 1, 2, 3, 4, 5), "=x", 12, None)]
    cols = [{"name": n, "is_pk": n == "a"} for n in "abcde"]
    monkeypatch.setattr(browser, "_pool", _FakePool(rows))
    monkeypatch.setattr(browser, "_validate_and_describe", lambda cur, table: (cols, [c["name"] for c in cols]))
    out = "".join(browser.stream_csv_rows("t"))
    lines = out.lstrip(csv_util.CSV_BOM).splitlines()
    assert lines[0] == "a,b,c,d,e"
    assert lines[1] == "01/01/2026,01/02/2026 03:04:05,'=x,12,"


# ---------------------------------------------------------------------------
# Distribution aggregate CSV
# ---------------------------------------------------------------------------
def test_distribution_aggregate_csv_uses_us_dates(monkeypatch):
    row = {
        "production_order": "PO1", "material_number": "M1", "machine": "AGG", "quantity": 10,
        "sum_child_quantity": 10, "start": datetime.datetime(2026, 1, 5, 6, 0),
        "finish": "2026-01-06T18:30:00", "child_count": 1, "queued_children": 0, "all_scheduled": True,
        "firming_indicator": "", "reviewed": False, "due_date": datetime.date(2026, 1, 7),
        "children": [{"production_order": "PO1-A", "machine": "L1", "quantity": 10,
                      "start": "2026-01-05T06:00:00", "end": None}],
    }
    monkeypatch.setattr(dist_routes.distribution_data, "get_aggregate", lambda *a, **k: [row])
    resp = dist_routes.get_distribution_aggregate(
        "1000", Response(), workcenter=None, from_=None, to_=None, format="csv", allowed_plants=None)
    text = resp.body.decode("utf-8").lstrip(csv_util.CSV_BOM)
    data_line = text.splitlines()[1]
    assert "01/05/2026 06:00" in data_line and "01/06/2026 18:30" in data_line
    assert "PO1-A|L1|10|01/05/2026 06:00|" in data_line
    assert data_line.endswith("01/07/2026")
    assert "2026-01" not in text


# ---------------------------------------------------------------------------
# ingest.normalize_date_cell
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("raw, iso", [
    ("2026-01-01", "2026-01-01"),
    ("01/01/2026", "2026-01-01"),
    ("1/5/2026", "2026-01-05"),
    ("12/31/9999", "9999-12-31"),
    ("2026-01-15 00:00:00", "2026-01-15"),
    (datetime.date(2026, 3, 4), "2026-03-04"),
    (datetime.datetime(2026, 3, 4, 5, 6), "2026-03-04"),
    ("", None),
    (None, None),
    ("nan", None),
])
def test_normalize_date_cell_accepts(raw, iso):
    assert ingest.normalize_date_cell(raw) == iso


@pytest.mark.parametrize("raw", ["02/30/2026", "13/01/2026", "2026-02-30", "soon", "01-15-2026", "1/5/26"])
def test_normalize_date_cell_rejects(raw):
    with pytest.raises(ValueError):
        ingest.normalize_date_cell(raw)


# ---------------------------------------------------------------------------
# POST /routing/validate/{table}: dates normalised, bad dates reported per row
# ---------------------------------------------------------------------------
@pytest.fixture
def admin_client(monkeypatch):
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", None)
    brain.api.dependency_overrides[routing_routes.require_admin] = lambda: "test-admin"
    try:
        yield TestClient(brain.api)
    finally:
        brain.api.dependency_overrides.pop(routing_routes.require_admin, None)


def test_validate_converts_dates_to_iso_and_reports_bad_dates(admin_client, monkeypatch):
    seen = {}

    def fake_parse(rows, conn=None, *, first_row=2, prefix_warnings=None):
        seen["rows"] = rows
        # The parser sees only the rows that passed the date check and numbers them 1..n.
        return ({"upserts": [dict(r) for r in rows], "deletes": []},
                [{"level": "reject", "msg": "unknown_plant: x", "row": 2}])

    monkeypatch.setattr(routing_routes.ingest, "parse_production_versions_rows", fake_parse)
    body = {"rows": [
        {"plant": "1000", "material_id": "A", "production_version": "1", "valid_from": "01/15/2026", "valid_to": "12/31/9999"},
        {"plant": "1000", "material_id": "B", "production_version": "1", "valid_from": "02/30/2026", "valid_to": ""},
        {"plant": "1000", "material_id": "C", "production_version": "1", "valid_from": "2026-03-01", "valid_to": "3/2/2026"},
    ]}
    resp = admin_client.post("/routing/validate/production_version", json=body)
    assert resp.status_code == 200
    out = resp.json()
    # Row B never reaches the parser; A and C carry ISO dates.
    assert [(r["material_id"], r["valid_from"], r["valid_to"]) for r in seen["rows"]] == [
        ("A", "2026-01-15", "9999-12-31"), ("C", "2026-03-01", "2026-03-02")]
    assert [r["material_id"] for r in out["rows"]] == ["A", "C"]
    # The parser's "row 2" (= second KEPT row, pasted line 3) is mapped back to the pasted line.
    assert {"level": "reject", "msg": "unknown_plant: x", "row": 3} in out["warnings"]
    bad = [w for w in out["warnings"] if w["msg"].startswith("invalid_date")]
    assert len(bad) == 1 and bad[0]["row"] == 2 and bad[0]["level"] == "reject"
    assert "valid_from" in bad[0]["msg"] and "02/30/2026" in bad[0]["msg"]
    assert out["rejected"] == 2
    assert set(out) == {"rows", "rejected", "warnings"}      # response shape unchanged


def test_validate_operation_dates(admin_client, monkeypatch):
    seen = {}

    def fake_parse(rows, conn=None, *, first_row=2, prefix_warnings=None):
        seen["rows"] = rows
        return {("k",): list(rows)}, []

    monkeypatch.setattr(routing_routes.ingest, "parse_routing_operations_rows", fake_parse)
    resp = admin_client.post("/routing/validate/routing_operation", json={"rows": [
        {"plant": "1000", "header_valid_from": "1/2/2026", "header_valid_to": "bogus"},
        {"plant": "1000", "header_valid_from": "2026-01-02"},
    ]})
    out = resp.json()
    assert [r["header_valid_from"] for r in seen["rows"]] == ["2026-01-02"]
    assert out["rejected"] == 1
    assert out["warnings"][0]["row"] == 1 and "header_valid_to" in out["warnings"][0]["msg"]
