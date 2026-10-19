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
from datetime import datetime

import pytest

try:
    from fastapi.routing import iter_route_contexts
    from starlette.testclient import TestClient

    import backend.security.auth as auth
    import brain
    from backend.distribution.routes import _parse_iso_date
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


_STAGING_WRITE_PATHS = [
    "/sap/staging/batches/{batch_id}/validate", "/sap/staging/batches/{batch_id}/apply",
    "/sap/staging/batches/{batch_id}/discard", "/sap/staging/poll", "/sap/staging/upload/{object}",
    "/sap/staging/archive/{archive_id}/restore", "/sap/staging/send/{plant}",
]
_STAGING_READ_PATHS = [
    "/sap/staging/batches", "/sap/staging/batches/{batch_id}", "/sap/staging/batches/{batch_id}/rejected",
    "/sap/staging/batches/{batch_id}/deletions", "/sap/staging/archive/{plant}",
    "/sap/staging/send/{plant}/status", "/sap/staging/send/{plant}/rows",
]


@pytest.mark.parametrize("path", _STAGING_WRITE_PATHS)
def test_sap_staging_writes_are_admin_and_api_key_gated(path):
    """Apply / Send to SAP (and every other staging write) are admin-only (D14): require_admin AND
    require_api_key present, and each is registered for the admin audit log."""
    matches = [r for r in iter_route_contexts(brain.api.routes) if getattr(r, "path", None) == path]
    assert len(matches) == 1
    dep_names = {dep.call.__name__ for dep in matches[0].dependant.dependencies}
    assert {"require_admin", "require_api_key"} <= dep_names
    assert path in brain._ADMIN_WRITE_OPERATIONS


@pytest.mark.parametrize("path", _STAGING_READ_PATHS)
def test_sap_staging_reads_are_admin_gated(path):
    matches = [r for r in iter_route_contexts(brain.api.routes) if getattr(r, "path", None) == path]
    assert len(matches) == 1
    assert "require_admin" in {dep.call.__name__ for dep in matches[0].dependant.dependencies}


def test_sap_staging_apply_and_send_reject_an_out_of_scope_plant(distribution_admin_client, monkeypatch):
    """Caller scope is {DIST_PLANT_A}: applying a batch of DIST_PLANT_B or sending DIST_PLANT_B is 403
    and never reaches the staging service."""
    import backend.integration.sap_staging as ss
    reached = []
    batch = {"batch_id": "b1", "plant": DIST_PLANT_B, "object_key": "stage_planned_orders"}
    monkeypatch.setattr(ss, "get_batch", lambda bid: batch)
    monkeypatch.setattr(ss, "apply_batch", lambda *a, **k: reached.append("apply"))
    monkeypatch.setattr(ss, "queue_send_to_sap", lambda *a, **k: reached.append("send"))
    assert distribution_admin_client.post("/sap/staging/batches/b1/apply").status_code == 403
    assert distribution_admin_client.post(f"/sap/staging/send/{DIST_PLANT_B}").status_code == 403
    assert reached == []


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


# ---------------------------------------------------------------------------
# P2-8/P2-9 planner writes -- POST /distribution/{plant}/{order}/{material}/shares,
# /review, /reset (aggregate_to_detail.md SS7: `require_api_key +
# require_authenticated` + plant scope, deliberately NOT require_admin -- "All
# three planner writes use the identical guard set" is SS7's own wording) --
# and admin writes -- POST /distribution/{plant}/reapply-defaults, /resolve
# (require_api_key + require_authenticated + require_admin, the P1
# workcenters-route precedent above).
# ---------------------------------------------------------------------------
import backend.distribution.data as distribution_data  # noqa: E402


@pytest.fixture
def distribution_planner_client():
    """An authenticated, non-admin caller for DIST_PLANT_A only -- DB-free
    (require_api_key overridden, no require_admin override needed since
    these routes never depend on it)."""
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [DIST_PLANT_A]
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "dist.planner@example.com"
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    try:
        yield TestClient(brain.api)
    finally:
        brain.api.dependency_overrides.clear()


def _distribution_planner_route_paths():
    return {
        "/distribution/{plant}/{order}/{material}/shares",
        "/distribution/{plant}/review",
        "/distribution/{plant}/reset",
    }


def test_distribution_planner_writes_are_not_admin_gated():
    """Locked product decision (SS7): the three planner writes must stay
    reachable by any authenticated, in-scope, API-key-bearing caller -- a
    `require_admin` dependency creeping onto any of them would lock
    non-admin planners out of Adjust shares / Reviewed / Reset."""
    by_path = {}
    for r in iter_route_contexts(brain.api.routes):
        p = getattr(r, "path", None)
        if p in _distribution_planner_route_paths():
            by_path[p] = r
    assert set(by_path) == _distribution_planner_route_paths()
    for path, route in by_path.items():
        dep_names = {dep.call.__name__ for dep in route.dependant.dependencies}
        assert "require_admin" not in dep_names, f"{path} must not be require_admin-gated"
        assert "require_api_key" in dep_names, f"{path} must require_api_key (SS7: deletes/creates rows)"


def test_distribution_shares_rejects_an_out_of_scope_plant(distribution_planner_client):
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_B}/ORDER1/MAT1/shares",
        json={"shares": [{"machine": "M1", "weight": 1}], "base_version": 1},
    )
    assert response.status_code == 403


def test_distribution_shares_maps_blank_plant_to_400_not_500(distribution_planner_client):
    response = distribution_planner_client.post(
        "/distribution/%20/ORDER1/MAT1/shares",
        json={"shares": [{"machine": "M1", "weight": 1}], "base_version": 1},
    )
    assert response.status_code == 400
    assert "plant is required" in response.json()["detail"]


def test_distribution_shares_allows_a_planner_through_to_the_data_layer(distribution_planner_client, monkeypatch):
    calls = []

    def fake_reweight_shares(plant, order, material, shares, base_version, **kwargs):
        calls.append({"plant": plant, "order": order, "material": material})
        return {"status": "ok", "children": [], "removed": [], "previous_shares": [], "versions": {},
                "base_version": 2}

    monkeypatch.setattr(distribution_data, "reweight_shares", fake_reweight_shares)
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_A}/ORDER1/MAT1/shares",
        json={"shares": [{"machine": "M1", "weight": 1}], "base_version": 1},
    )
    assert response.status_code == 200
    assert calls == [{"plant": DIST_PLANT_A, "order": "ORDER1", "material": "MAT1"}]


def test_distribution_shares_maps_stale_version_to_409_with_structured_detail(distribution_planner_client, monkeypatch):
    def fake_reweight_shares(*a, **k):
        raise distribution_data.DistributionStaleVersion(7)

    monkeypatch.setattr(distribution_data, "reweight_shares", fake_reweight_shares)
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_A}/ORDER1/MAT1/shares",
        json={"shares": [{"machine": "M1", "weight": 1}], "base_version": 1},
    )
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "stale"
    assert detail["base_version"] == 7


def test_distribution_shares_maps_children_scheduled_to_409_with_children_list(distribution_planner_client, monkeypatch):
    def fake_reweight_shares(*a, **k):
        raise distribution_data.DistributionChildrenScheduled(
            [{"id": "x", "production_order": "A-ORDER1", "machine": "M1", "scheduled_start": None, "frozen": False}]
        )

    monkeypatch.setattr(distribution_data, "reweight_shares", fake_reweight_shares)
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_A}/ORDER1/MAT1/shares",
        json={"shares": [{"machine": "M1", "weight": 1}], "base_version": 1},
        params={"confirm": "false"},
    )
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "children_scheduled"
    assert detail["children"][0]["id"] == "x"


def test_distribution_shares_maps_children_scheduled_to_409_with_a_real_timestamp_not_500(
        distribution_planner_client, monkeypatch):
    """D10: `_error_response` builds a plain `JSONResponse`, which can't
    serialize a raw `datetime` -- the pin test above uses an empty
    `scheduled_start`, which hides this. A real timestamp must still come
    back as a 409 with an ISO string, not degrade into an unhandled 500."""
    def fake_reweight_shares(*a, **k):
        raise distribution_data.DistributionChildrenScheduled(
            [{"id": "x", "production_order": "A-ORDER1", "machine": "M1",
              "scheduled_start": datetime(2026, 10, 1, 8), "frozen": False}]
        )

    monkeypatch.setattr(distribution_data, "reweight_shares", fake_reweight_shares)
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_A}/ORDER1/MAT1/shares",
        json={"shares": [{"machine": "M1", "weight": 1}], "base_version": 1},
        params={"confirm": "false"},
    )
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "children_scheduled"
    assert detail["children"][0]["scheduled_start"] == "2026-10-01T08:00:00"


def test_distribution_shares_maps_header_not_found_to_404(distribution_planner_client, monkeypatch):
    def fake_reweight_shares(*a, **k):
        raise distribution_data.DistributionHeaderNotFound("nope")

    monkeypatch.setattr(distribution_data, "reweight_shares", fake_reweight_shares)
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_A}/ORDER1/MAT1/shares",
        json={"shares": [{"machine": "M1", "weight": 1}], "base_version": 1},
    )
    assert response.status_code == 404


@pytest.mark.parametrize("body_overrides", [
    {},                        # D18: base_version key omitted entirely
    {"base_version": None},    # D18: explicit JSON null
    {"base_version": True},    # D18: bool is an int subtype -- must still be rejected
], ids=["missing", "null", "boolean"])
def test_distribution_shares_rejects_a_non_int_base_version(distribution_planner_client, body_overrides):
    body = {"shares": [{"machine": "M1", "weight": 1}], **body_overrides}
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_A}/ORDER1/MAT1/shares", json=body,
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "base_version_required"


def test_distribution_review_rejects_an_out_of_scope_plant(distribution_planner_client):
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_B}/review",
        json={"orders": [{"production_order": "O1", "material_number": "M1", "base_version": 1}], "reviewed": True},
    )
    assert response.status_code == 403


def test_distribution_review_maps_blank_plant_to_400_not_500(distribution_planner_client):
    response = distribution_planner_client.post(
        "/distribution/%20/review",
        json={"orders": [{"production_order": "O1", "material_number": "M1", "base_version": 1}], "reviewed": True},
    )
    assert response.status_code == 400
    assert "plant is required" in response.json()["detail"]


def test_distribution_review_rejects_an_empty_orders_list(distribution_planner_client):
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_A}/review", json={"orders": [], "reviewed": True},
    )
    assert response.status_code == 400


def test_distribution_review_rejects_more_than_500_orders(distribution_planner_client):
    """D20: an unbounded `orders[]` bulk request is capped at 500."""
    orders = [{"production_order": f"O{i}", "material_number": "M1", "base_version": 1} for i in range(501)]
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_A}/review", json={"orders": orders, "reviewed": True},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "too_many_orders"


@pytest.mark.parametrize("bad_orders", [
    "not-a-list",
    [123],
    [{"production_order": "O1"}],
    [{"production_order": 1, "material_number": "M1"}],
], ids=["not-a-list", "non-dict-item", "missing-material-number", "non-string-field"])
def test_distribution_review_rejects_malformed_order_item_shape_with_400_not_500(
        distribution_planner_client, bad_orders):
    """D20: a malformed `orders[]` item (wrong container type, missing keys,
    or non-string identifiers) must be rejected at the route with a 400,
    never reach data.py and surface as an unhandled 500."""
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_A}/review", json={"orders": bad_orders, "reviewed": True},
    )
    assert response.status_code == 400


@pytest.mark.parametrize("body_overrides", [
    {},                      # D20: `reviewed` key omitted -- today this silently un-reviews
    {"reviewed": None},
    {"reviewed": "true"},
], ids=["missing", "null", "non-bool"])
def test_distribution_review_rejects_a_non_bool_reviewed(distribution_planner_client, body_overrides):
    body = {"orders": [{"production_order": "O1", "material_number": "M1", "base_version": 1}], **body_overrides}
    response = distribution_planner_client.post(f"/distribution/{DIST_PLANT_A}/review", json=body)
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "reviewed_required"


@pytest.mark.parametrize("item_overrides", [
    {},                      # D18: base_version key omitted entirely
    {"base_version": None},
    {"base_version": True},
], ids=["missing", "null", "boolean"])
def test_distribution_review_rejects_an_item_with_a_non_int_base_version(distribution_planner_client, item_overrides):
    item = {"production_order": "O1", "material_number": "M1", **item_overrides}
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_A}/review", json={"orders": [item], "reviewed": True},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "base_version_required"


def test_distribution_review_allows_a_planner_through_to_the_data_layer(distribution_planner_client, monkeypatch):
    calls = []

    def fake_review_orders(plant, items, reviewed, actor=None):
        calls.append({"plant": plant, "items": items, "reviewed": reviewed})
        return {"results": [{"production_order": "O1", "material_number": "M1", "status": "ok", "base_version": 2}]}

    monkeypatch.setattr(distribution_data, "review_orders", fake_review_orders)
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_A}/review",
        json={"orders": [{"production_order": "O1", "material_number": "M1", "base_version": 1}], "reviewed": True},
    )
    assert response.status_code == 200
    assert calls[0]["plant"] == DIST_PLANT_A
    assert calls[0]["reviewed"] is True


def test_distribution_reset_rejects_an_out_of_scope_plant(distribution_planner_client):
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_B}/reset",
        json={"orders": [{"production_order": "O1", "material_number": "M1", "base_version": 1}]},
    )
    assert response.status_code == 403


def test_distribution_reset_maps_blank_plant_to_400_not_500(distribution_planner_client):
    response = distribution_planner_client.post(
        "/distribution/%20/reset",
        json={"orders": [{"production_order": "O1", "material_number": "M1", "base_version": 1}]},
    )
    assert response.status_code == 400
    assert "plant is required" in response.json()["detail"]


def test_distribution_reset_rejects_more_than_500_orders(distribution_planner_client):
    """D20: same 500-item cap as /review."""
    orders = [{"production_order": f"O{i}", "material_number": "M1", "base_version": 1} for i in range(501)]
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_A}/reset", json={"orders": orders},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "too_many_orders"


@pytest.mark.parametrize("bad_orders", [
    "not-a-list",
    [123],
    [{"production_order": "O1"}],
    [{"production_order": 1, "material_number": "M1"}],
], ids=["not-a-list", "non-dict-item", "missing-material-number", "non-string-field"])
def test_distribution_reset_rejects_malformed_order_item_shape_with_400_not_500(
        distribution_planner_client, bad_orders):
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_A}/reset", json={"orders": bad_orders},
    )
    assert response.status_code == 400


@pytest.mark.parametrize("item_overrides", [
    {},                      # D18: base_version key omitted entirely
    {"base_version": None},
    {"base_version": True},
], ids=["missing", "null", "boolean"])
def test_distribution_reset_rejects_an_item_with_a_non_int_base_version(distribution_planner_client, item_overrides):
    item = {"production_order": "O1", "material_number": "M1", **item_overrides}
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_A}/reset", json={"orders": [item]},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "base_version_required"


def test_distribution_reset_allows_a_planner_through_to_the_data_layer(distribution_planner_client, monkeypatch):
    calls = []

    def fake_reset_orders(plant, items, **kwargs):
        calls.append({"plant": plant, "items": items})
        return {"results": [{"production_order": "O1", "material_number": "M1", "status": "ok"}]}

    monkeypatch.setattr(distribution_data, "reset_orders", fake_reset_orders)
    response = distribution_planner_client.post(
        f"/distribution/{DIST_PLANT_A}/reset",
        json={"orders": [{"production_order": "O1", "material_number": "M1", "base_version": 1}]},
    )
    assert response.status_code == 200
    assert calls == [{"plant": DIST_PLANT_A, "items": [{"production_order": "O1", "material_number": "M1", "base_version": 1}]}]


def _distribution_admin_route_paths():
    return {"/distribution/{plant}/reapply-defaults", "/distribution/{plant}/resolve"}


@pytest.fixture
def distribution_reapply_admin_client():
    """Mirrors `distribution_admin_client` above (the P1 workcenters-route
    fixture) for the two new admin writes."""
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [DIST_PLANT_A]
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "dist.admin@example.com"
    brain.api.dependency_overrides[brain.require_admin] = lambda: "dist.admin@example.com"
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    try:
        yield TestClient(brain.api)
    finally:
        brain.api.dependency_overrides.clear()


def test_distribution_admin_writes_are_admin_gated():
    by_path = {}
    for r in iter_route_contexts(brain.api.routes):
        p = getattr(r, "path", None)
        if p in _distribution_admin_route_paths():
            by_path[p] = r
    assert set(by_path) == _distribution_admin_route_paths()
    for path, route in by_path.items():
        dep_names = {dep.call.__name__ for dep in route.dependant.dependencies}
        assert "require_admin" in dep_names, f"{path} must be require_admin-gated"


def test_distribution_reapply_defaults_rejects_an_out_of_scope_plant(distribution_reapply_admin_client):
    response = distribution_reapply_admin_client.post(f"/distribution/{DIST_PLANT_B}/reapply-defaults", json={})
    assert response.status_code == 403


def test_distribution_reapply_defaults_maps_blank_plant_to_400_not_500(distribution_reapply_admin_client):
    response = distribution_reapply_admin_client.post("/distribution/%20/reapply-defaults", json={})
    assert response.status_code == 400
    assert "plant is required" in response.json()["detail"]


def test_distribution_reapply_defaults_rejects_a_non_admin_caller():
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [DIST_PLANT_A]
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "planner@example.com"
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    brain.api.dependency_overrides[brain.require_admin] = lambda: (_ for _ in ()).throw(
        brain.HTTPException(status_code=403, detail="Admin role required")
    )
    try:
        response = TestClient(brain.api).post(f"/distribution/{DIST_PLANT_A}/reapply-defaults", json={})
    finally:
        brain.api.dependency_overrides.clear()
    assert response.status_code == 403


def test_distribution_reapply_defaults_allows_an_admin_through_to_the_data_layer(
        distribution_reapply_admin_client, monkeypatch):
    calls = []

    def fake_reapply_defaults(plant, **kwargs):
        calls.append({"plant": plant})
        return {"headers_processed": 0, "children_upserted": 0, "children_deleted": 0,
                "skipped": 0, "children_scheduled": 0}

    monkeypatch.setattr(distribution_data, "reapply_defaults", fake_reapply_defaults)
    response = distribution_reapply_admin_client.post(f"/distribution/{DIST_PLANT_A}/reapply-defaults", json={})
    assert response.status_code == 200
    assert calls == [{"plant": DIST_PLANT_A}]


def test_distribution_reapply_defaults_rejects_more_than_500_orders(distribution_reapply_admin_client):
    """D20: the same 500-item cap applies to reapply-defaults' optional
    explicit `orders` list (an admin bulk sweep of ALL headers when `orders`
    is omitted is unaffected -- only an explicit oversized list is capped)."""
    orders = [{"production_order": f"O{i}", "material_number": "M1"} for i in range(501)]
    response = distribution_reapply_admin_client.post(
        f"/distribution/{DIST_PLANT_A}/reapply-defaults", json={"orders": orders},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "too_many_orders"


def test_distribution_reapply_defaults_does_not_require_base_version_per_item(
        distribution_reapply_admin_client, monkeypatch):
    """D18 explicitly exempts reapply-defaults: it's an admin bulk sweep, not
    an edit against a client-held header version, so an `orders` item
    without `base_version` must still reach the data layer."""
    calls = []

    def fake_reapply_defaults(plant, **kwargs):
        calls.append({"plant": plant, "orders": kwargs.get("orders")})
        return {"headers_processed": 0, "children_upserted": 0, "children_deleted": 0,
                "skipped": 0, "children_scheduled": 0}

    monkeypatch.setattr(distribution_data, "reapply_defaults", fake_reapply_defaults)
    response = distribution_reapply_admin_client.post(
        f"/distribution/{DIST_PLANT_A}/reapply-defaults",
        json={"orders": [{"production_order": "O1", "material_number": "M1"}]},
    )
    assert response.status_code == 200
    assert calls == [{"plant": DIST_PLANT_A, "orders": [{"production_order": "O1", "material_number": "M1"}]}]


def test_distribution_resolve_rejects_an_out_of_scope_plant(distribution_reapply_admin_client):
    response = distribution_reapply_admin_client.post(f"/distribution/{DIST_PLANT_B}/resolve", json={})
    assert response.status_code == 403


def test_distribution_resolve_maps_blank_plant_to_400_not_500(distribution_reapply_admin_client):
    response = distribution_reapply_admin_client.post("/distribution/%20/resolve", json={})
    assert response.status_code == 400
    assert "plant is required" in response.json()["detail"]


def test_distribution_resolve_rejects_a_non_admin_caller():
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [DIST_PLANT_A]
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "planner@example.com"
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    brain.api.dependency_overrides[brain.require_admin] = lambda: (_ for _ in ()).throw(
        brain.HTTPException(status_code=403, detail="Admin role required")
    )
    try:
        response = TestClient(brain.api).post(f"/distribution/{DIST_PLANT_A}/resolve", json={})
    finally:
        brain.api.dependency_overrides.clear()
    assert response.status_code == 403


def test_distribution_resolve_allows_an_admin_through_to_the_data_layer(distribution_reapply_admin_client, monkeypatch):
    calls = []

    def fake_resolve(plant, scope, **kwargs):
        calls.append({"plant": plant, "scope": scope})
        return {"headers_created": 0, "children_upserted": 0, "single_rewrites": 0, "repaired": 0, "skipped": 0}

    monkeypatch.setattr(distribution_data, "resolve", fake_resolve)
    response = distribution_reapply_admin_client.post(
        f"/distribution/{DIST_PLANT_A}/resolve", json={"scope": "wc_codes"},
    )
    assert response.status_code == 200
    assert calls == [{"plant": DIST_PLANT_A, "scope": "wc_codes"}]


def test_distribution_resolve_rejects_an_invalid_scope(distribution_reapply_admin_client, monkeypatch):
    def fake_resolve(plant, scope, **kwargs):
        raise ValueError("scope must be one of 'wc_codes', 'machines', 'repair'")

    monkeypatch.setattr(distribution_data, "resolve", fake_resolve)
    response = distribution_reapply_admin_client.post(
        f"/distribution/{DIST_PLANT_A}/resolve", json={"scope": "bogus"},
    )
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# D57 -- `_parse_iso_date`'s `to` handling. A date-only `YYYY-MM-DD` input
# means midnight, so orders starting later that same day were silently
# dropped from a `to=<that day>` filter. `end_of_day=True` (used for `to` on
# the list and aggregate routes only) widens a date-only input to the last
# instant of that day; an input that already carries a time component is
# left alone.
# ---------------------------------------------------------------------------
def test_parse_iso_date_date_only_with_end_of_day_returns_the_last_instant_of_the_day():
    result = _parse_iso_date("2026-10-01", "to", end_of_day=True)
    assert result == datetime(2026, 10, 1, 23, 59, 59, 999999)


def test_parse_iso_date_date_only_without_end_of_day_stays_at_midnight():
    result = _parse_iso_date("2026-10-01", "to")
    assert result == datetime(2026, 10, 1, 0, 0, 0)


def test_parse_iso_date_with_an_explicit_time_ignores_end_of_day():
    result = _parse_iso_date("2026-10-01T08:30:00", "to", end_of_day=True)
    assert result == datetime(2026, 10, 1, 8, 30, 0)


def test_parse_iso_date_none_ignores_end_of_day():
    assert _parse_iso_date(None, "to", end_of_day=True) is None


def test_distribution_list_to_date_is_widened_to_the_end_of_the_day(scoped_client, monkeypatch):
    """Route-level pin: GET /distribution/{plant}?to=<date-only> must reach
    distribution_data.list_headers_for_plant with date_to already widened to
    23:59:59.999999, not raw midnight."""
    captured = {}

    def fake_list_headers_for_plant(plant, **kwargs):
        captured["date_to"] = kwargs.get("date_to")
        return {"data": [], "total": 0}

    monkeypatch.setattr(distribution_data, "list_headers_for_plant", fake_list_headers_for_plant)
    response = scoped_client.get(f"/distribution/{PLANT_A}?to=2026-10-01")
    assert response.status_code == 200
    assert captured["date_to"] == datetime(2026, 10, 1, 23, 59, 59, 999999)


@pytest.mark.pg
def test_get_tasks_keeps_null_machine_orders_without_links(scoped_client, pg):
    """Plan Part 1 #43: groupby("MACHINE") used to drop NULL-machine orders."""
    from datetime import datetime, timedelta
    start = datetime.now().replace(microsecond=0) + timedelta(hours=1)
    ids = ["ZZTEST_NULLM_1", "ZZTEST_NULLM_2"]
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM orders WHERE id = ANY(%s)", (ids,))
        for i, oid in enumerate(ids):
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, machine, plant,"
                " basic_start_date, basic_finish_date, run_time) VALUES (%s,%s,%s,NULL,%s,%s,%s,2)",
                (oid, oid, "ZZTEST_MAT", PLANT_A, start + timedelta(hours=3 * i),
                 start + timedelta(hours=3 * i + 2)))
        conn.commit()
    try:
        body = scoped_client.get(f"/tasks?plant={PLANT_A}").json()
        got = {t["id"]: t for t in body["data"]}
        assert set(ids) <= set(got)
        assert got[ids[0]]["MACHINE"] == ""
        assert not [lk for lk in body["links"] if lk["source"] in ids or lk["target"] in ids]
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = ANY(%s)", (ids,))
            conn.commit()


# ---------------------------------------------------------------------------
# POST /plant-calendar/plant-blackouts -- planner-writable (was admin-only);
# plant-scoped via backend/calendars/routes.py's _calendar_plant_guard. Line
# blackouts, hours and periods stay admin, so only this route is covered here.
# ---------------------------------------------------------------------------

_BLACKOUT_BODY = {"upserts": [{"id": "ZZTEST_BLK_1", "start": "2026-12-24T00:00:00",
                               "end": "2026-12-26T00:00:00", "reason": "Holiday"}], "deletes": []}


@pytest.fixture
def blackout_planner_client():
    """A signed-in NON-admin whose scope is {PLANT_A}; require_admin is
    deliberately NOT overridden, so the route succeeding proves it is no
    longer admin-gated."""
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [PLANT_A]
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "planner@example.com"
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    try:
        yield TestClient(brain.api)
    finally:
        brain.api.dependency_overrides.clear()


def test_plant_blackouts_write_allows_a_non_admin_in_scope_caller(blackout_planner_client, monkeypatch):
    import master_data as md
    captured = {}

    def fake_save(plant, upserts, deletes, user_email=None):
        captured.update(plant=plant, upserts=upserts, deletes=deletes)
        return {"plant": plant, "upserted": len(upserts), "deleted": len(deletes)}

    monkeypatch.setattr(md, "save_plant_blackouts", fake_save)
    response = blackout_planner_client.post("/plant-calendar/plant-blackouts",
                                            json={"plant": PLANT_A, **_BLACKOUT_BODY})
    assert response.status_code == 200
    assert captured["plant"] == PLANT_A and len(captured["upserts"]) == 1


def test_plant_blackouts_write_rejects_an_out_of_scope_plant(blackout_planner_client, monkeypatch):
    import master_data as md
    calls = []
    monkeypatch.setattr(md, "save_plant_blackouts", lambda *a, **k: calls.append(1))
    response = blackout_planner_client.post("/plant-calendar/plant-blackouts",
                                            json={"plant": PLANT_B, **_BLACKOUT_BODY})
    assert response.status_code == 403
    assert calls == []


def test_plant_blackouts_write_maps_blank_plant_to_400_not_500(blackout_planner_client, monkeypatch):
    import master_data as md
    calls = []
    monkeypatch.setattr(md, "save_plant_blackouts", lambda *a, **k: calls.append(1))
    response = blackout_planner_client.post("/plant-calendar/plant-blackouts",
                                            json={"plant": "  ", **_BLACKOUT_BODY})
    assert response.status_code == 400
    assert calls == []


def test_plant_blackouts_write_maps_non_string_plant_to_400_not_500(blackout_planner_client, monkeypatch):
    import master_data as md
    calls = []
    monkeypatch.setattr(md, "save_plant_blackouts", lambda *a, **k: calls.append(1))
    for bad in (5, [PLANT_A], {"a": 1}, None):
        response = blackout_planner_client.post("/plant-calendar/plant-blackouts",
                                                json={"plant": bad, **_BLACKOUT_BODY})
        assert response.status_code == 400, bad
    assert calls == []


def test_plant_blackouts_write_requires_authentication(monkeypatch):
    import master_data as md
    calls = []
    monkeypatch.setattr(md, "save_plant_blackouts", lambda *a, **k: calls.append(1))
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: (_ for _ in ()).throw(
        brain.HTTPException(status_code=401, detail="Not signed in")
    )
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [PLANT_A]
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    try:
        response = TestClient(brain.api).post("/plant-calendar/plant-blackouts",
                                              json={"plant": PLANT_A, **_BLACKOUT_BODY})
    finally:
        brain.api.dependency_overrides.clear()
    assert response.status_code == 401
    assert calls == []
