"""Route-level coverage for backend/routing/routes.py's validate route
(POST /routing/validate/{table}) and the `plants` field both upload routes
now return.

DB-free: the ingest parse functions and every write/recompute seam are
monkeypatched, so nothing here opens a connection. `require_admin` is
overridden and `NIMBUS_API_KEY` cleared, same shape as
tests/test_integration_routes.py's `admin_client`.
"""
import os
import sys
from io import BytesIO

import pandas as pd
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

os.environ.setdefault("NIMBUS_PG_POOL_MIN", "0")

from starlette.testclient import TestClient  # noqa: E402

import backend.routing.routes as routing_routes  # noqa: E402
import backend.security.auth as auth  # noqa: E402
import brain  # noqa: E402


@pytest.fixture
def admin_client(monkeypatch):
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", None)
    brain.api.dependency_overrides[routing_routes.require_admin] = lambda: "test-admin"
    try:
        yield TestClient(brain.api)
    finally:
        brain.api.dependency_overrides.pop(routing_routes.require_admin, None)


def _xlsx(rows: list[dict]) -> bytes:
    buf = BytesIO()
    pd.DataFrame(rows).to_excel(buf, index=False)
    return buf.getvalue()


_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


# ---------------------------------------------------------------------------
# POST /routing/validate/{table}
# ---------------------------------------------------------------------------
def test_validate_production_versions_returns_parser_rows_and_rejected(admin_client, monkeypatch):
    seen = {}
    warnings = [
        {"level": "reject", "msg": "unknown_plant: row references data not known to NIMBUS", "row": 2},
        {"level": "warn", "msg": "something informational"},
    ]

    def fake_parse(rows, conn=None, *, first_row=2, prefix_warnings=None):
        seen.update(rows=rows, first_row=first_row, prefix=prefix_warnings)
        return {"upserts": [{"plant": "5512", "production_version": "0001"}], "deletes": []}, warnings

    monkeypatch.setattr(routing_routes.ingest, "parse_production_versions_rows", fake_parse)

    response = admin_client.post(
        "/routing/validate/production_version",
        json={"rows": [{"Plant": "5512", "Material Id": "1", "FOO": "x"}]},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["rows"] == [{"plant": "5512", "production_version": "0001"}]
    assert body["rejected"] == 1
    assert [w["level"] for w in body["warnings"]] == ["reject", "warn"]
    # Headers were mapped before parsing, unknown key dropped with one warning,
    # and rows are numbered from 1 (paste rows have no header row).
    assert seen["rows"] == [{"plant": "5512", "material_id": "1"}]
    assert seen["first_row"] == 1
    assert len(seen["prefix"]) == 1 and "FOO" in seen["prefix"][0]["msg"]


def test_validate_operations_flattens_groups_in_order(admin_client, monkeypatch):
    groups = {
        ("5512", "M1", "N", "G1", "01"): [{"activity": "0010"}, {"activity": "0020"}],
        ("5512", "M2", "N", "G2", "01"): [{"activity": "0010"}],
    }

    def fake_parse(rows, conn=None, *, first_row=2, prefix_warnings=None):
        return groups, [{"level": "reject", "msg": "duplicate_key: x", "row": 3}]

    monkeypatch.setattr(routing_routes.ingest, "parse_routing_operations_rows", fake_parse)

    response = admin_client.post(
        "/routing/validate/routing_operation", json={"rows": [{"plant": "5512"}]})

    assert response.status_code == 200
    body = response.json()
    assert body["rows"] == [{"activity": "0010"}, {"activity": "0020"}, {"activity": "0010"}]
    assert body["rejected"] == 1
    assert body["warnings"][0]["msg"].startswith("duplicate_key")


def test_validate_unknown_table_is_404(admin_client):
    response = admin_client.post("/routing/validate/orders", json={"rows": []})

    assert response.status_code == 404
    assert response.json()["detail"] == "Unknown table"


def test_validate_over_20000_rows_is_413(admin_client):
    response = admin_client.post(
        "/routing/validate/production_version", json={"rows": [{}] * 20001})

    assert response.status_code == 413


# ---------------------------------------------------------------------------
# `plants` on the upload results
# ---------------------------------------------------------------------------
def test_upload_production_versions_reports_distinct_sorted_plants(admin_client, monkeypatch):
    ops = {"upserts": [{"plant": "5513"}, {"plant": "5512"}, {"plant": "5513"}, {"plant": ""}],
           "deletes": []}
    recomputed = []
    monkeypatch.setattr(routing_routes.ingest, "parse_production_versions_upload",
                        lambda raw: (ops, []))
    monkeypatch.setattr(routing_routes, "write_production_versions",
                        lambda o, email: {"inserted": 4, "updated": 0})
    monkeypatch.setattr(routing_routes, "_recompute_after_write", recomputed.append)

    response = admin_client.post(
        "/routing/upload/production-versions",
        files={"file": ("pv.xlsx", _xlsx([{"PLANT": "5512"}]), _XLSX_MIME)},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["plants"] == ["5512", "5513"]
    assert body["inserted"] == 4
    assert len(recomputed) == 1


def test_upload_operations_reports_plants(admin_client, monkeypatch):
    groups = {
        ("5513", "M1", "N", "G1", "01"): [{"activity": "0010"}],
        ("5512", "M2", "N", "G2", "01"): [{"activity": "0010"}],
    }
    monkeypatch.setattr(routing_routes.ingest, "parse_routing_operations_upload",
                        lambda raw: (groups, []))
    monkeypatch.setattr(routing_routes, "write_operation_groups", lambda g, email: 2)
    monkeypatch.setattr(routing_routes, "_recompute_after_write", lambda plants: None)

    response = admin_client.post(
        "/routing/upload/operations",
        files={"file": ("ops.xlsx", _xlsx([{"PLANT": "5512"}]), _XLSX_MIME)},
    )

    assert response.status_code == 200
    assert response.json()["plants"] == ["5512", "5513"]


def test_upload_operations_with_no_groups_reports_empty_plants(admin_client, monkeypatch):
    monkeypatch.setattr(routing_routes.ingest, "parse_routing_operations_upload",
                        lambda raw: ({}, []))

    response = admin_client.post(
        "/routing/upload/operations",
        files={"file": ("ops.xlsx", _xlsx([{"PLANT": "5512"}]), _XLSX_MIME)},
    )

    assert response.status_code == 200
    assert response.json()["plants"] == []
