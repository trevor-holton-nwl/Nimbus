"""Labor HTTP -> authorization -> real data functions, with only SQL I/O doubled.

No PostgreSQL is required. Transaction and bound-parameter assertions cover
the operation selected by a request; they do not claim to execute PostgreSQL.
"""

from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import brain
import master_data as md
from backend.security import auth


class _MalformedCellsInternalError(AssertionError):
    """Only the verified cells-validation exception is an expected defect."""


@pytest.fixture
def labor(monkeypatch):
    pool = MagicMock(name="labor_pool")
    conn = pool.connection.return_value.__enter__.return_value
    cursor = conn.cursor.return_value.__enter__.return_value
    cursor.fetchall.return_value = []
    cursor.rowcount = 2
    monkeypatch.setattr(md, "_pool", pool)
    monkeypatch.setattr(auth, "get_user_role", lambda actor: "planner" if actor == "planner" else None)
    monkeypatch.setattr(auth, "get_allowed_plants", lambda actor: ["P1"])
    # Do not enter brain's lifespan: this suite deliberately has no real DB.
    logs = list(brain._BACKEND_LOG)
    try:
        yield TestClient(brain.api, raise_server_exceptions=False), pool, conn, cursor
    finally:
        brain._BACKEND_LOG.clear()
        brain._BACKEND_LOG.extend(logs)


@pytest.mark.parametrize("path", ["/labor-plan", "/labor-plan/line"])
@pytest.mark.parametrize("params,status", [({}, 422), ({"plant": ""}, 400), ({"plant": "  "}, 400)])
def test_read_requires_nonblank_plant_before_sql(labor, path, params, status):
    client, pool, _, _ = labor
    response = client.get(path, params=params)
    assert response.status_code == status
    pool.connection.assert_not_called()


@pytest.mark.parametrize("path", ["/labor-plan", "/labor-plan/line"])
@pytest.mark.parametrize("headers", [{}, {"x-user-email": "unknown"}, {"x-user-email": " "}])
def test_write_uses_real_auth_guard_and_never_opens_sql_for_unknown_actor(labor, path, headers):
    client, pool, _, _ = labor
    response = client.post(path, headers=headers, json={"plant": "P1", "subnetwork": "S", "cells": []})
    assert response.status_code == 401
    assert response.json()["detail"] == "Not signed in"
    pool.connection.assert_not_called()


@pytest.mark.parametrize("path", ["/labor-plan", "/labor-plan/line"])
@pytest.mark.parametrize("plant", [None, "", "   "])
def test_write_rejects_missing_plant_before_sql(labor, path, plant):
    client, pool, _, _ = labor
    response = client.post(path, headers={"x-user-email": "planner"}, json={"plant": plant, "subnetwork": "S"})
    assert response.status_code == 400
    assert "plant" in response.json()["detail"]
    pool.connection.assert_not_called()


@pytest.mark.parametrize("path", ["/labor-plan", "/labor-plan/line"])
def test_write_requires_subnetwork_even_for_empty_batch(labor, path):
    client, pool, _, _ = labor
    response = client.post(path, headers={"x-user-email": "planner"}, json={"plant": "P1", "cells": []})
    assert response.status_code == 400
    assert "subnetwork" in response.json()["detail"]
    pool.connection.assert_not_called()


@pytest.mark.parametrize("path,key,period,bad", [
    ("/labor-plan", "wc_group", "period", "2026-W00"),
    ("/labor-plan", "wc_group", "period", "2026-W54"),
    ("/labor-plan", "wc_group", "period", "2026-W1"),
    ("/labor-plan", "wc_group", "period", 202601),
    ("/labor-plan/line", "machine", "day", "2026-02-29"),
    ("/labor-plan/line", "machine", "day", "2026-13-01"),
    ("/labor-plan/line", "machine", "day", "2026-1-01"),
    ("/labor-plan/line", "machine", "day", 20260101),
])
def test_invalid_cell_date_returns_400_before_any_partial_batch_write(labor, path, key, period, bad):
    client, pool, _, _ = labor
    good = "2026-W01" if period == "period" else "2026-01-01"
    response = client.post(path, headers={"x-user-email": "planner"}, json={
        "plant": "P1", "subnetwork": "S", "cells": [
            {key: "M1", period: good, "avail_hours": 8},
            {key: "M2", period: bad, "avail_hours": None},
        ],
    })
    assert response.status_code == 400
    assert f"Invalid {period}" in response.json()["detail"]
    pool.connection.assert_not_called()


def test_aggregate_read_converts_decimal_preserves_null_and_binds_plant(labor):
    client, _, _, cursor = labor
    cursor.fetchall.return_value = [("G1", "2026-W01", Decimal("12.75")), ("G2", "2026-W01", None)]
    response = client.get("/labor-plan", params={"plant": "P1"})
    assert response.status_code == 200
    assert response.json() == {"rows": [
        {"wc_group": "G1", "period": "2026-W01", "avail_hours": 12.75},
        {"wc_group": "G2", "period": "2026-W01", "avail_hours": None},
    ]}
    assert cursor.execute.call_args.args[1] == ("P1",)


@pytest.mark.parametrize("filters,expected", [
    ({}, ["P1"]),
    ({"group": "G1"}, ["P1", "G1"]),
    ({"from_date": "2026-01-01"}, ["P1", "2026-01-01"]),
    ({"to_date": "2026-01-31"}, ["P1", "2026-01-31"]),
    ({"group": "G1", "from_date": "2026-01-01", "to_date": "2026-01-31"},
     ["P1", "G1", "2026-01-01", "2026-01-31"]),
    ({"group": "x'; DROP TABLE orders;--"}, ["P1", "x'; DROP TABLE orders;--"]),
])
def test_line_filters_reach_bound_sql_and_serialized_rows(labor, filters, expected):
    client, _, _, cursor = labor
    cursor.fetchall.return_value = [("M1", "2026-01-01", Decimal("0"), "manual")]
    response = client.get("/labor-plan/line", params={"plant": "P1", **filters})
    assert response.status_code == 200
    assert response.json() == {"rows": [{"machine": "M1", "day": "2026-01-01", "avail_hours": 0.0,
                                         "source": "manual"}]}
    statement, params = cursor.execute.call_args.args
    assert params == expected
    assert "pl.plant = lpl.plant" in statement
    for value in expected:
        assert value not in statement


@pytest.mark.parametrize("path,key,date_field,date", [
    ("/labor-plan", "wc_group", "period", "2026-W01"),
    ("/labor-plan/line", "machine", "day", "2024-02-29"),
])
def test_mixed_batch_distinguishes_zero_from_delete_and_audits_once(labor, path, key, date_field, date):
    client, _, conn, cursor = labor
    response = client.post(path, headers={"x-user-email": "planner"}, json={
        "plant": "P1", "subnetwork": "S", "cells": [
            {key: "zero", date_field: date, "avail_hours": 0},
            {key: "fraction", date_field: date, "avail_hours": 7.25, "source": "manual"},
            {key: "delete-null", date_field: date, "avail_hours": None},
            {key: "delete-empty", date_field: date, "avail_hours": ""},
            {key: "incomplete", "avail_hours": 8},
        ],
    })
    assert response.status_code == 200
    assert response.json() == {"upserted": 2, "deleted": 2}
    delete_call, audit_call = cursor.execute.call_args_list
    assert delete_call.args[1] == ("S", "P1", ["delete-null", "delete-empty"], [date, date])
    inserted = cursor.executemany.call_args.args[1]
    assert [row[:5] for row in inserted] == [("S", "P1", "zero", date, 0), ("S", "P1", "fraction", date, 7.25)]
    if path.endswith("/line"):
        assert [row[5] for row in inserted] == ["auto_split", "manual"]
    assert "admin_audit" in audit_call.args[0]
    details, actor = audit_call.args[1]
    assert details.obj == {"upserted": 2, "deleted": 2, "plant": "P1"}
    assert actor == "planner"
    conn.commit.assert_called_once_with()


@pytest.mark.parametrize("path", ["/labor-plan", "/labor-plan/line"])
def test_empty_cells_audit_without_upsert_or_delete(labor, path):
    client, _, conn, cursor = labor
    response = client.post(path, headers={"x-user-email": "planner"}, json={"plant": "P1", "subnetwork": "S"})
    assert response.status_code == 200
    assert response.json() == {"upserted": 0, "deleted": 0}
    cursor.executemany.assert_not_called()
    assert cursor.execute.call_count == 1
    assert "admin_audit" in cursor.execute.call_args.args[0]
    conn.commit.assert_called_once_with()


@pytest.mark.parametrize("path,key,date_field,date", [
    ("/labor-plan", "wc_group", "period", "2026-W01"),
    ("/labor-plan/line", "machine", "day", "2026-01-01"),
])
def test_failed_upsert_never_commits_or_records_success_audit(labor, path, key, date_field, date):
    client, _, conn, cursor = labor
    cursor.executemany.side_effect = RuntimeError("simulated SQL failure")
    response = client.post(path, headers={"x-user-email": "planner"}, json={
        "plant": "P1", "subnetwork": "S", "cells": [{key: "M1", date_field: date, "avail_hours": 8}],
    })
    assert response.status_code == 500
    conn.commit.assert_not_called()
    cursor.execute.assert_not_called()


@pytest.mark.xfail(strict=True, raises=_MalformedCellsInternalError,
                   reason="Untyped labor cells=None/non-object entries raise TypeError/AttributeError -> 500")
@pytest.mark.parametrize("path", ["/labor-plan", "/labor-plan/line"])
@pytest.mark.parametrize("cells", [None, [None], [3], ["invalid"]])
def test_malformed_cells_are_a_client_error_not_an_internal_error(labor, path, cells):
    _, pool, _, _ = labor
    client = TestClient(brain.api, raise_server_exceptions=True)
    try:
        response = client.post(path, headers={"x-user-email": "planner"},
                               json={"plant": "P1", "subnetwork": "S", "cells": cells})
    except (TypeError, AttributeError) as exc:
        expected_type = TypeError if cells is None else AttributeError
        expected_message = ("'NoneType' object is not iterable" if cells is None
                            else f"'{type(cells[0]).__name__}' object has no attribute 'get'")
        assert type(exc) is expected_type
        assert str(exc) == expected_message
        origin = exc.__traceback__
        while origin.tb_next is not None:
            origin = origin.tb_next
        expected_function = md.upsert_labor_plan_machine if path.endswith("/line") else md.upsert_labor_plan
        assert origin.tb_frame.f_code.co_filename == expected_function.__code__.co_filename
        assert origin.tb_frame.f_code.co_name in (expected_function.__name__, "<listcomp>")
        raise _MalformedCellsInternalError("Malformed cells escaped data validation instead of returning 400/422") from exc
    finally:
        pool.connection.assert_not_called()
    assert response.status_code in (400, 422)
