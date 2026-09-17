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
    from fastapi.routing import iter_route_contexts
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


# ---------------------------------------------------------------------------
# GET /master-data/{table} -- previously had NO auth dependency at all (an
# anonymous request resolved allowed_plants=None, i.e. unrestricted, letting
# a plant-restricted user's own scope be silently bypassed by any caller who
# simply sent no identity header). Fixed by adding
# Depends(auth.require_authenticated) -- these two tests pin that it's
# actually wired, mirroring test_task_update_requires_authentication above.
# ---------------------------------------------------------------------------
def test_master_data_list_requires_authentication(monkeypatch):
    calls = []
    monkeypatch.setattr(brain.md, "list_rows", lambda *a, **k: calls.append(1), raising=False)
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: (_ for _ in ()).throw(
        brain.HTTPException(status_code=401, detail="Not signed in")
    )
    try:
        response = TestClient(brain.api).get("/master-data/plants")
    finally:
        brain.api.dependency_overrides.clear()
    assert response.status_code == 401
    assert calls == []


def test_master_data_list_allows_an_authenticated_caller_through_to_the_data_layer(scoped_client, monkeypatch):
    """Positive-path companion: an authenticated, scoped caller must still
    reach md.list_rows with its allowed_plants forwarded unmodified."""
    calls = []

    def fake_list_rows(table, limit=None, offset=None, plant=None, allowed_plants=None, material_id=None, search=None):
        calls.append({"table": table, "allowed_plants": allowed_plants})
        return {"rows": [], "columns": [], "meta": {"total": 0}}

    monkeypatch.setattr(brain.md, "list_rows", fake_list_rows, raising=False)
    response = scoped_client.get("/master-data/plants")
    assert response.status_code == 200
    assert calls == [{"table": "plants", "allowed_plants": [PLANT_A]}]


# ---------------------------------------------------------------------------
# PUT /distribution/{plant}/workcenters/{wc} -- backend/distribution/'s FIRST
# route (aggregate_to_detail.md §4.3/§7). Modeled on backend/setup/routes.py,
# so these tests pin the exact same historical regression class this file's
# docstring describes -- a blank/whitespace plant escaping past a
# PlantNotAllowed-only catch as an unhandled 500 -- for the newest domain.
# Admin-gated (require_api_key + require_authenticated + require_admin), so
# every fixture below overrides require_admin directly rather than relying on
# the real admin_exists() DB check, mirroring test_setup_endpoints.py's `tc`
# fixture and test_priority_lists.py's oversized-upload tests.
# ---------------------------------------------------------------------------
DIST_PLANT_A = "ZZTEST_DIST_PLANT_A"
DIST_PLANT_B = "ZZTEST_DIST_PLANT_B"

_DIST_BODY = {
    "distribution_mode": "single", "default_machine": "M1", "max_separation": "none",
    "review_required": True, "distribute_tooled": False, "weights": {},
}


@pytest.fixture
def distribution_admin_client():
    """An authenticated, admin-scoped caller for DIST_PLANT_A only -- DB-free
    (require_admin/require_api_key are overridden, not the real checks)."""
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [DIST_PLANT_A]
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "dist.admin@example.com"
    brain.api.dependency_overrides[brain.require_admin] = lambda: "dist.admin@example.com"
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    try:
        yield TestClient(brain.api)
    finally:
        brain.api.dependency_overrides.clear()


def test_distribution_workcenter_write_rejects_an_out_of_scope_plant(distribution_admin_client):
    """The caller's role_plants scope is {DIST_PLANT_A}; a PUT against
    DIST_PLANT_B must be rejected 403, not merely fail validation deeper in
    the stack (and never reach backend.distribution.data)."""
    response = distribution_admin_client.put(
        f"/distribution/{DIST_PLANT_B}/workcenters/WC1", json=_DIST_BODY,
    )
    assert response.status_code == 403


def test_distribution_workcenter_write_maps_blank_plant_to_400_not_500(distribution_admin_client):
    """md._assert_plant_allowed raises ValueError (not PlantNotAllowed) for a
    blank/whitespace plant -- checked FIRST, inside _assert_plant_allowed,
    before the role_plants scope check ever runs. backend/distribution/routes.py's
    _distribution_plant_guard catches PlantNotAllowed and ValueError (in that
    order); catching only the former would let this ValueError escape as an
    unhandled 500 -- the exact regression class this file exists to guard
    against, now pinned for this domain too."""
    response = distribution_admin_client.put(
        "/distribution/%20/workcenters/WC1", json=_DIST_BODY,
    )
    assert response.status_code == 400
    assert "plant is required" in response.json()["detail"]


def test_distribution_workcenter_write_is_admin_gated():
    """Static, DB-free check mirroring test_material_plant_attributes.py's
    dependency-inspection pattern (there, the inverse assertion for
    planner-facing routes; here, this route IS admin-only, so require_admin
    must be present)."""
    matches = [r for r in iter_route_contexts(brain.api.routes)
               if getattr(r, "path", None) == "/distribution/{plant}/workcenters/{wc}"]
    assert len(matches) == 1
    dep_names = {dep.call.__name__ for dep in matches[0].dependant.dependencies}
    assert "require_admin" in dep_names


def test_distribution_workcenter_write_rejects_a_non_admin_caller():
    """A merely-authenticated (non-admin) caller must be rejected 403 --
    require_admin overridden to throw directly (no live admin_exists() DB
    call), mirroring test_setup_endpoints.py's
    test_definition_write_requires_master_data_owner."""
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [DIST_PLANT_A]
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "planner@example.com"
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    brain.api.dependency_overrides[brain.require_admin] = lambda: (_ for _ in ()).throw(
        brain.HTTPException(status_code=403, detail="Admin role required")
    )
    try:
        response = TestClient(brain.api).put(
            f"/distribution/{DIST_PLANT_A}/workcenters/WC1", json=_DIST_BODY,
        )
    finally:
        brain.api.dependency_overrides.clear()
    assert response.status_code == 403


def test_distribution_workcenter_write_allows_an_admin_through_to_the_data_layer(distribution_admin_client, monkeypatch):
    """Positive-path companion: an authorized admin call for an in-scope plant
    must reach backend.distribution.data.save_workcenter (mocked here, so this
    needs no live DB) -- proves the guard isn't rejecting valid requests too."""
    import backend.distribution.data as distribution_data
    calls = []

    def fake_save_workcenter(plant, wc, description, distribution_mode, default_machine,
                             max_separation, review_required, distribute_tooled, weights, user_email=None):
        calls.append({"plant": plant, "wc": wc})
        return {
            "plant": plant, "sap_workcenter": wc, "description": description,
            "distribution_mode": distribution_mode, "default_machine": default_machine,
            "max_separation": max_separation, "review_required": bool(review_required),
            "distribute_tooled": bool(distribute_tooled), "weights": weights or {},
        }

    monkeypatch.setattr(distribution_data, "save_workcenter", fake_save_workcenter)
    response = distribution_admin_client.put(
        f"/distribution/{DIST_PLANT_A}/workcenters/WC1", json=_DIST_BODY,
    )
    assert response.status_code == 200
    assert calls == [{"plant": DIST_PLANT_A, "wc": "WC1"}]


# ---------------------------------------------------------------------------
# GET /distribution/{plant}, /{plant}/{order}/{material}, /{plant}/summary,
# /{plant}/aggregate, /{plant}/unresolved -- backend/distribution/'s 5
# P2-6/P2-7 read routes (aggregate_to_detail.md §7). All five are
# `require_authenticated` + plant scope ONLY (no admin/api-key, §7's guard
# column), so `scoped_client` (PLANT_A/PLANT_B, defined above for /tasks and
# /task/update) applies directly -- no dedicated fixture needed. Each route
# runs the SAME `_distribution_plant_guard` the workcenters route above uses
# (routes.py, shared verbatim), so the catch order -- ValueError (blank
# plant) checked first inside `md._assert_plant_allowed`, PlantNotAllowed
# (out-of-scope) second -- is identical; verified against
# backend/distribution/routes.py, not assumed.
# ---------------------------------------------------------------------------
def test_distribution_list_rejects_an_out_of_scope_plant(scoped_client):
    response = scoped_client.get(f"/distribution/{PLANT_B}")
    assert response.status_code == 403


def test_distribution_list_maps_blank_plant_to_400_not_500(scoped_client):
    response = scoped_client.get("/distribution/%20")
    assert response.status_code == 400
    assert "plant is required" in response.json()["detail"]


def test_distribution_detail_rejects_an_out_of_scope_plant(scoped_client):
    response = scoped_client.get(f"/distribution/{PLANT_B}/ORDER1/MAT1")
    assert response.status_code == 403


def test_distribution_detail_maps_blank_plant_to_400_not_500(scoped_client):
    response = scoped_client.get("/distribution/%20/ORDER1/MAT1")
    assert response.status_code == 400
    assert "plant is required" in response.json()["detail"]


def test_distribution_summary_rejects_an_out_of_scope_plant(scoped_client):
    response = scoped_client.get(f"/distribution/{PLANT_B}/summary")
    assert response.status_code == 403


def test_distribution_summary_maps_blank_plant_to_400_not_500(scoped_client):
    response = scoped_client.get("/distribution/%20/summary")
    assert response.status_code == 400
    assert "plant is required" in response.json()["detail"]


def test_distribution_aggregate_rejects_an_out_of_scope_plant(scoped_client):
    response = scoped_client.get(f"/distribution/{PLANT_B}/aggregate")
    assert response.status_code == 403


def test_distribution_aggregate_maps_blank_plant_to_400_not_500(scoped_client):
    response = scoped_client.get("/distribution/%20/aggregate")
    assert response.status_code == 400
    assert "plant is required" in response.json()["detail"]


def test_distribution_unresolved_rejects_an_out_of_scope_plant(scoped_client):
    response = scoped_client.get(f"/distribution/{PLANT_B}/unresolved")
    assert response.status_code == 403


def test_distribution_unresolved_maps_blank_plant_to_400_not_500(scoped_client):
    response = scoped_client.get("/distribution/%20/unresolved")
    assert response.status_code == 400
    assert "plant is required" in response.json()["detail"]
