"""
Regression guard for Phase 4's response_model= additions (docs/typescript_migration.md).

FastAPI's response_model serializes the return value THROUGH the Pydantic model —
any dict key the handler returns that isn't declared on the model is silently
dropped (not an error). A typo'd or forgotten field name is invisible to
`npm run typecheck` (that's the frontend) and to a naive "does it 200" test.
This test builds a synthetic dict with the EXACT key set get_tasks's `data.append({...})`
literal produces (brain.py), constructs a TaskDTO from it, and asserts the
round-tripped key set is unchanged — so a field silently dropped by the model
fails this test immediately, without needing a live database.
"""
import os

import pytest

os.environ.setdefault("NIMBUS_PG_POOL_MIN", "0")

import brain  # noqa: E402


SAMPLE_TASK_ROW = {
    "id": "abc123",
    "text": "Order abc123",
    "start_date": "2026-08-01T07:00:00",
    "end_date": "2026-08-01T15:00:00",
    "original_start_date": "2026-08-01T07:00:00",
    "original_end_date": "2026-08-01T15:00:00",
    "user_scheduled": False,
    "PRODUCTION_LINE": "Line 1",
    "MATERIAL_DESCRIPTION": "Widget",
    "MATERIAL_NUMBER": "MAT-1",
    "ORDER_QUANTITY_(GMEIN)": 500.0,
    "COLOR": "WHITE",
    "PRT_01": "MOLD-A",
    "PRT_02": "MOLD-B",
    "PRODUCTION_VERSION": "0001",
    "PLANT": "5512",
    "ORDER": "ORD-1",
    "ORDER_Y": 1.0,
    "RUN_TIME": 2.5,
    "FORM_SIZE": "MD",
    "notes": None,
    "firmed": False,
    "row_version": 42,
}


def test_task_dto_round_trips_every_field_get_tasks_emits():
    dto = brain.TaskDTO(**SAMPLE_TASK_ROW)
    out = dto.model_dump(by_alias=True)
    assert set(out.keys()) == set(SAMPLE_TASK_ROW.keys()), (
        "TaskDTO's declared fields no longer match get_tasks's dict literal — "
        "a field was renamed/dropped on one side only. Diff: "
        f"missing={set(SAMPLE_TASK_ROW) - set(out)}, extra={set(out) - set(SAMPLE_TASK_ROW)}"
    )
    assert out == SAMPLE_TASK_ROW


def test_bulk_update_result_round_trips_db_shape():
    sample = {
        "status": "ok", "updated": 3, "persisted": 3, "failed": 0, "invalid": 0,
        "not_found": 0, "invalid_ids": [], "not_found_ids": [], "stale": [],
        "versions": {"abc123": 43}, "error_code": None, "cause": None,
    }
    out = brain.BulkUpdateResult(**sample).model_dump()
    assert out == sample


def test_task_attribute_updates_are_forwarded_to_the_bulk_db_writer(monkeypatch):
    captured = {}

    def fake_update(items):
        captured["items"] = items
        return {
            "applied": 1, "persisted": 1, "failed": 0, "invalid": 0,
            "not_found": 0, "invalid_ids": [], "not_found_ids": [],
            "stale": [], "versions": {"abc123": 43},
        }

    monkeypatch.setattr(brain.db, "update_task_dates_bulk", fake_update)
    result = brain._apply_task_date_updates([
        brain.TaskDateUpdate(
            id="abc123",
            PRT_01="MOLD-A",
            PRT_02="MOLD-B",
            PRODUCTION_VERSION="0001",
            base_version=42,
        )
    ])

    assert result["persisted"] == 1
    assert captured["items"] == [{
        "id": "abc123",
        "start": None,
        "end": None,
        "PRT_01": "MOLD-A",
        "PRT_02": "MOLD-B",
        "PRODUCTION_VERSION": "0001",
        "base_version": 42,
        "force": False,
    }]


def test_openapi_schema_includes_new_components():
    schema = brain.api.openapi()
    names = set(schema.get("components", {}).get("schemas", {}).keys())
    for expected in ("TasksResponse", "TaskDTO", "LinkDTO", "TaskUpdateResult",
                     "BulkUpdateResult", "TasksRefreshResponse", "BaselineCorrectResult"):
        assert expected in names, f"{expected} missing from OpenAPI components.schemas"


@pytest.mark.pg
def test_tasks_endpoint_response_validates_live(client):
    """Live smoke test: hit GET /tasks against whatever plant/line data exists
    (or an empty result — both are valid TasksResponse shapes) and confirm
    response_model didn't reject/mangle a real row. Skips automatically when
    Postgres isn't reachable (see tests/conftest.py)."""
    r = client.get("/tasks", params={"limit": 5})
    assert r.status_code == 200
    body = r.json()
    assert "data" in body and "links" in body and "meta" in body
    if body["data"]:
        row = body["data"][0]
        assert "id" in row and "start_date" in row and "row_version" in row
