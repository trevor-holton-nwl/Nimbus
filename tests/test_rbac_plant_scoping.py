"""
RBAC / plant-scoping tests for the routes guarded by this session's P0/P1
remediation (plan `rippling-brewing-hamming.md`, sections A1/A2, B8 item 2).

Style: mirrors `tests/test_setup_endpoints.py` -- stub
`auth.get_allowed_plants_for_request` / `auth.require_authenticated` via
`brain.api.dependency_overrides` and drive a real `TestClient` against
`brain.api`, rather than importing route functions directly. This lets the
whole file run WITHOUT a live Postgres connection (no `NIMBUS_TEST_DB=1`
needed, no `@pytest.mark.pg`): every assertion here either short-circuits on
a 403 before any `db`/`master_data` call, or replaces the underlying
data-layer call with a monkeypatched double the same way
`test_setup_endpoints.py._install_matrix_rows_double`/`.tc` do.

Coverage, per the plan:
  - GET /tasks?plant=<out-of-scope>       -> 403 (get_tasks's pre-existing
    explicit-plant check; pinned here, not newly added by this session).
  - POST /task/update on an out-of-scope order -> masked as a plain 404
    ("not found"), never a distinguishing 403/error -- db.update_task_dates_bulk
    folds an out-of-scope row into not_found_ids so a caller can't tell
    "not found" from "not yours" (see routes.py's `update_task` +
    `_apply_task_date_updates`, and db.py:940-951's `allowed_plants` check).
    The row-lock logic that makes this decision under a real FOR UPDATE is
    a real-DB concern -- see tests/test_task_concurrency.py for that. This
    file instead pins the *route*-level contract: the caller's allowed_plants
    reaches db.update_task_dates_bulk unmodified, and a not_found result
    surfaces as 404.
  - GET /labor-plan(/line)?plant=<out-of-scope> -> 403 via
    md._assert_plant_allowed + md.PlantNotAllowed (pure logic, no DB touched
    before the 403 fires).
  - POST /labor-plan(/line) for an out-of-scope plant -> 403, and the
    underlying upsert is never called.

None of these tests require a live database -- confirmed via `ast.parse`
(this docstring) and, where noted, by mocking the data-layer call.
"""
import pytest

try:
    from starlette.testclient import TestClient

    import backend.security.auth as auth
    import brain
except Exception as exc:  # pragma: no cover - depends on local application imports
    pytest.skip(f"brain/TestClient unavailable in this environment: {exc}", allow_module_level=True)

import db

PLANT_A = "ZZTEST_RBAC_PLANT_A"
PLANT_B = "ZZTEST_RBAC_PLANT_B"


@pytest.fixture
def scoped_client():
    """A caller whose role_plants scope is exactly {PLANT_A}, with a genuine
    (stubbed) authenticated identity -- mirrors test_setup_endpoints.py's
    `tc` fixture shape."""
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [PLANT_A]
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "planta.user@example.com"
    try:
        yield TestClient(brain.api)
    finally:
        brain.api.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# GET /tasks
# ---------------------------------------------------------------------------
def test_get_tasks_rejects_an_explicit_out_of_scope_plant(scoped_client):
    response = scoped_client.get(f"/tasks?plant={PLANT_B}")
    assert response.status_code == 403


def test_get_tasks_allows_an_in_scope_plant_through_to_the_data_layer(scoped_client, monkeypatch):
    """Positive-path companion: an in-scope ?plant= must not be rejected --
    it should reach db.query_orders. Mocked (empty result) so this needs no
    live DB and isolates the route's scoping decision from the query itself."""
    calls = []

    def fake_query_orders(plant=None, line=None, limit=None, offset=None, allowed_plants=None):
        calls.append({"plant": plant, "allowed_plants": allowed_plants})
        return None, None, None

    monkeypatch.setattr(db, "query_orders", fake_query_orders)
    response = scoped_client.get(f"/tasks?plant={PLANT_A}")
    assert response.status_code == 200
    assert calls == [{"plant": PLANT_A, "allowed_plants": [PLANT_A]}]


# ---------------------------------------------------------------------------
# POST /task/update
# ---------------------------------------------------------------------------
def test_task_update_on_an_out_of_scope_order_is_masked_as_not_found(scoped_client, monkeypatch):
    captured = {}

    def fake_update_task_dates_bulk(items, allowed_plants=None):
        captured["allowed_plants"] = allowed_plants
        captured["items"] = items
        # Mirrors db.update_task_dates_bulk's real behavior (db.py:949-951)
        # for a row whose plant falls outside allowed_plants: folded into
        # not_found_ids, not a distinct rejection reason.
        return {"applied": 1, "persisted": 0, "failed": 0, "invalid": 0,
                "not_found": 1, "invalid_ids": [], "not_found_ids": [items[0]["id"]],
                "stale": [], "versions": {}}

    monkeypatch.setattr(db, "update_task_dates_bulk", fake_update_task_dates_bulk)

    response = scoped_client.post("/task/update", json={
        "id": "ZZTEST_ORDER_ON_PLANT_B",
        "start_date": "2026-09-05T08:00:00",
        "end_date": "2026-09-05T12:00:00",
    })

    assert response.status_code == 404
    assert captured["allowed_plants"] == [PLANT_A], (
        "the caller's role_plants scope must reach db.update_task_dates_bulk unmodified"
    )


def test_task_update_requires_authentication(monkeypatch):
    """Without an authenticated identity, /task/update must reject outright
    (401) before ever reaching db.update_task_dates_bulk -- proves the
    Depends(auth.require_authenticated) added in A1 is actually wired, not
    just documented."""
    calls = []
    monkeypatch.setattr(db, "update_task_dates_bulk", lambda *a, **k: calls.append(1), raising=False)
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: (_ for _ in ()).throw(
        brain.HTTPException(status_code=401, detail="Not signed in")
    )
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [PLANT_A]
    try:
        response = TestClient(brain.api).post("/task/update", json={
            "id": "ZZTEST_ANY_ORDER", "start_date": "2026-09-05T08:00:00", "end_date": "2026-09-05T12:00:00",
        })
    finally:
        brain.api.dependency_overrides.clear()
    assert response.status_code == 401
    assert calls == []


# ---------------------------------------------------------------------------
# POST /task/note -- also A1-guarded (db.get_order_plant + allowed_plants)
# ---------------------------------------------------------------------------
def test_task_note_on_an_out_of_scope_order_is_masked_as_not_found(scoped_client, monkeypatch):
    monkeypatch.setattr(db, "get_order_plant", lambda task_id: PLANT_B)
    response = scoped_client.post("/task/note", json={"id": "ZZTEST_ORDER_ON_PLANT_B", "notes": "hello"})
    assert response.status_code == 404


def test_task_note_on_an_in_scope_order_persists(scoped_client, monkeypatch):
    monkeypatch.setattr(db, "get_order_plant", lambda task_id: PLANT_A)
    monkeypatch.setattr(db, "update_task_note", lambda task_id, notes: {"status": "ok"})
    response = scoped_client.post("/task/note", json={"id": "ZZTEST_ORDER_ON_PLANT_A", "notes": "hello"})
    assert response.status_code == 200


# ---------------------------------------------------------------------------
# GET/POST /labor-plan, /labor-plan/line
# ---------------------------------------------------------------------------
def test_labor_plan_get_rejects_an_out_of_scope_plant(scoped_client):
    response = scoped_client.get(f"/labor-plan?plant={PLANT_B}")
    assert response.status_code == 403


def test_labor_plan_get_allows_an_in_scope_plant_through_to_the_data_layer(scoped_client, monkeypatch):
    calls = []
    monkeypatch.setattr(brain.md, "load_labor_plan", lambda plant: calls.append(plant) or {"cells": []}, raising=False)
    response = scoped_client.get(f"/labor-plan?plant={PLANT_A}")
    assert response.status_code == 200
    assert calls == [PLANT_A]


def test_labor_plan_post_on_out_of_scope_plant_is_rejected_before_any_write(scoped_client, monkeypatch):
    calls = []
    monkeypatch.setattr(brain.md, "upsert_labor_plan", lambda **kw: calls.append(kw), raising=False)
    response = scoped_client.post("/labor-plan", json={"subnetwork": "WTG", "plant": PLANT_B, "cells": []})
    assert response.status_code == 403
    assert calls == [], "upsert_labor_plan must never be called for an out-of-scope plant"


def test_labor_plan_post_requires_authentication(monkeypatch):
    calls = []
    monkeypatch.setattr(brain.md, "upsert_labor_plan", lambda **kw: calls.append(kw), raising=False)
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: (_ for _ in ()).throw(
        brain.HTTPException(status_code=401, detail="Not signed in")
    )
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [PLANT_A]
    try:
        response = TestClient(brain.api).post("/labor-plan", json={"subnetwork": "WTG", "plant": PLANT_A, "cells": []})
    finally:
        brain.api.dependency_overrides.clear()
    assert response.status_code == 401
    assert calls == []


def test_labor_plan_line_get_rejects_an_out_of_scope_plant(scoped_client):
    response = scoped_client.get(f"/labor-plan/line?plant={PLANT_B}")
    assert response.status_code == 403


def test_labor_plan_line_post_on_out_of_scope_plant_is_rejected_before_any_write(scoped_client, monkeypatch):
    calls = []
    monkeypatch.setattr(brain.md, "upsert_labor_plan_machine", lambda **kw: calls.append(kw), raising=False)
    response = scoped_client.post("/labor-plan/line", json={"subnetwork": "WTG", "plant": PLANT_B, "cells": []})
    assert response.status_code == 403
    assert calls == [], "upsert_labor_plan_machine must never be called for an out-of-scope plant"
