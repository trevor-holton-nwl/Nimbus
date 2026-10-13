"""API workflow checks across separate planners, save aliases, and refresh.

The in-memory data double represents only the database's versioned row and
plant filter. Requests still traverse FastAPI auth dependencies, request
normalization, response models, and the shared scheduling route code.
"""

from datetime import datetime

import pytest
from fastapi.testclient import TestClient

import brain
import db
from backend.security import auth


ORDER_A = "ZZTEST_WORKFLOW_A"
ORDER_B = "ZZTEST_WORKFLOW_B"
HIDDEN = "ZZTEST_DOES_NOT_EXIST"
PLANT_A = "ZZTEST_WORKFLOW_PLANT_A"
PLANT_B = "ZZTEST_WORKFLOW_PLANT_B"


@pytest.fixture
def planners(monkeypatch):
    rows = {
        ORDER_A: {"plant": PLANT_A, "version": 10, "start": "2026-10-13T08:00:00", "notes": None},
        ORDER_B: {"plant": PLANT_B, "version": 20, "start": "2026-10-13T08:00:00", "notes": None},
    }
    roles = {"alice@example.com": "planner_a", "charlie@example.com": "planner_a",
             "bob@example.com": "planner_b"}
    scopes = {"alice@example.com": [PLANT_A], "charlie@example.com": [PLANT_A],
              "bob@example.com": [PLANT_B]}
    monkeypatch.setattr(auth, "get_user_role", roles.get)
    monkeypatch.setattr(auth, "get_allowed_plants", lambda email: scopes.get(email, []))

    def versions(ids):
        return [
            {"id": order_id, "plant": rows[order_id]["plant"],
             "start_date": rows[order_id]["start"], "end_date": "2026-10-13T12:00:00",
             "row_version": rows[order_id]["version"]}
            for order_id in ids if order_id in rows
        ]

    def save(items, allowed_plants=None, **_kwargs):
        result = {"applied": len(items), "persisted": 0, "failed": 0, "invalid": 0,
                  "not_found": 0, "invalid_ids": [], "not_found_ids": [], "stale": [],
                  "versions": {}, "conflicts": [], "rejection_reasons": {}}
        for item in items:
            order_id = item["id"]
            row = rows.get(order_id)
            if row is None or (allowed_plants is not None and row["plant"] not in allowed_plants):
                result["not_found"] += 1
                result["not_found_ids"].append(order_id)
            elif item["base_version"] != row["version"] and not item["force"]:
                result["stale"].append(order_id)
            else:
                assert isinstance(item["start"], datetime)  # HTTP string was normalized before persistence
                row["start"] = item["start"].isoformat()
                row["version"] += 1
                result["persisted"] += 1
                result["versions"][order_id] = row["version"]
        return result

    monkeypatch.setattr(db, "get_task_versions", versions)
    monkeypatch.setattr(db, "update_task_dates_bulk", save)
    monkeypatch.setattr(db, "get_order_plant", lambda order_id: rows.get(order_id, {}).get("plant"))

    def update_note(order_id, notes):
        rows[order_id]["notes"] = notes
        return {"status": "ok"}

    monkeypatch.setattr(db, "update_task_note", update_note)
    yield TestClient(brain.api), rows, scopes


def _headers(user):
    return {"x-user-email": f"{user}@example.com"}


def test_two_planners_stale_save_then_refresh_current_version(planners):
    client, rows, _scopes = planners
    alice = _headers("alice")
    charlie = _headers("charlie")
    bob = _headers("bob")
    edit = {"id": ORDER_A, "start_date": "2026-10-13T09:00:00", "base_version": 10}

    saved = client.post("/tasks/update", json={"tasks": [edit]}, headers=alice)
    assert saved.status_code == 200
    assert saved.json()["versions"] == {ORDER_A: 11}

    stale = client.post("/tasks/bulk_update", json=[{**edit, "force": True}], headers=charlie)
    assert stale.status_code == 200
    assert stale.json()["stale"] == [ORDER_A]
    assert stale.json()["persisted"] == 0
    assert rows[ORDER_A]["version"] == 11

    refreshed = client.post("/tasks/refresh", json={"ids": [ORDER_A, ORDER_B]}, headers=charlie)
    assert refreshed.status_code == 200
    assert refreshed.json()["missing"] == [ORDER_B]
    assert [(row["id"], row["row_version"], row["PLANT"]) for row in refreshed.json()["data"]] == [
        (ORDER_A, 11, PLANT_A)]

    other = client.post("/tasks/refresh", json={"ids": [ORDER_A, ORDER_B]}, headers=bob)
    assert other.status_code == 200
    assert other.json()["missing"] == [ORDER_A]
    assert [row["id"] for row in other.json()["data"]] == [ORDER_B]


def test_cross_plant_write_and_note_are_masked_as_missing(planners):
    client, rows, _scopes = planners
    bob = _headers("bob")
    update = {"id": ORDER_A, "start_date": "2026-10-13T09:00:00", "base_version": 10}

    hidden = client.post("/tasks/update", json={"tasks": [update]}, headers=bob)
    absent = client.post("/tasks/update", json={"tasks": [{**update, "id": HIDDEN}]}, headers=bob)
    assert hidden.status_code == absent.status_code == 200
    assert hidden.json()["not_found_ids"] == [ORDER_A]
    assert absent.json()["not_found_ids"] == [HIDDEN]
    assert hidden.json()["versions"] == absent.json()["versions"] == {}

    hidden_note = client.post("/task/note", json={"id": ORDER_A, "notes": "private"}, headers=bob)
    absent_note = client.post("/task/note", json={"id": HIDDEN, "notes": "private"}, headers=bob)
    assert hidden_note.status_code == absent_note.status_code == 404
    assert hidden_note.json() == absent_note.json()
    assert rows[ORDER_A]["version"] == 10
    assert rows[ORDER_A]["notes"] is None


def test_revoked_plant_scope_takes_effect_on_existing_task_id(planners):
    client, rows, scopes = planners
    alice = _headers("alice")
    initial = client.post("/tasks/refresh", json={"ids": [ORDER_A]}, headers=alice)
    assert initial.status_code == 200
    assert initial.json()["data"][0]["row_version"] == 10

    scopes["alice@example.com"] = [PLANT_B]
    refreshed = client.post("/tasks/refresh", json={"ids": [ORDER_A]}, headers=alice)
    assert refreshed.status_code == 200
    assert refreshed.json() == {"data": [], "missing": [ORDER_A]}

    edit = client.post("/task/update", json={
        "id": ORDER_A, "start_date": "2026-10-13T09:00:00", "base_version": 10,
    }, headers=alice)
    note = client.post("/task/note", json={"id": ORDER_A, "notes": "old access"}, headers=alice)
    assert edit.status_code == note.status_code == 404
    assert rows[ORDER_A]["version"] == 10
    assert rows[ORDER_A]["notes"] is None
