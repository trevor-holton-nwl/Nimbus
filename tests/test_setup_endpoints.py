"""Contract tests for the authorized, plant-scoped setup API surface."""
import pytest

try:
    from starlette.testclient import TestClient

    import backend.security.auth as auth
    import brain
except Exception as exc:  # pragma: no cover - depends on local application imports
    pytest.skip(f"brain/TestClient unavailable in this environment: {exc}", allow_module_level=True)


class _SetupService:
    """Small deterministic service double; endpoint tests own authorization/wire behavior."""

    version = 4

    def get_setup_snapshot(self, plant):
        return {
            "plant": plant,
            "definition": {"plant": plant, "signature_version": self.version,
                           "fields": ["colorWheel"], "strict_blanks": True, "active": False},
            "plant_rows": [{"machine": "", "setup_min": 12}],
            "machine_rows": [{"machine": "LINE-1", "setup_min": 9}],
            "machine_states": [{"machine": "LINE-1", "source": "manual"}],
            "overrides": [{"id": 7, "machine": "LINE-1", "status": "inactive"}],
        }

    def save_definition(self, plant, fields, strict_blanks, actor, expected_signature_version):
        self._check_version(expected_signature_version)
        self.version += 1
        return {"plant": plant, "fields": fields, "strict_blanks": strict_blanks,
                "signature_version": self.version, "active": False}

    def set_definition_active(self, plant, active, actor, expected_signature_version):
        self._check_version(expected_signature_version)
        return {"plant": plant, "fields": ["colorWheel"], "strict_blanks": True,
                "signature_version": self.version, "active": active}

    def replace_plant_matrix(self, plant, rows, signature_version, actor, expected_token=None):
        self._check_rows(rows, signature_version)
        return {"plant": plant, "machine": "", "signature_version": self.version, "rows": len(rows)}

    def upsert_machine_matrix_rows(self, plant, machine, rows, signature_version, actor):
        if machine != "LINE-1":
            raise ValueError(f"Machine {machine!r} does not belong to plant {plant!r}")
        self._check_rows(rows, signature_version)
        return {"plant": plant, "machine": machine, "signature_version": self.version, "rows": len(rows)}

    def delete_plant_matrix_rows(self, plant, rows, signature_version, actor):
        self._check_rows(rows, signature_version)
        return {"plant": plant, "machine": "", "signature_version": self.version, "deleted": len(rows)}

    def delete_machine_matrix_rows(self, plant, machine, rows, signature_version, actor):
        if machine != "LINE-1":
            raise ValueError(f"Machine {machine!r} does not belong to plant {plant!r}")
        self._check_rows(rows, signature_version)
        return {"plant": plant, "machine": machine, "signature_version": self.version, "deleted": len(rows)}

    def set_machine_state(self, plant, machine, values, signature_version, observed_at, source, reason, actor,
                       physical_mold_id=None):
        if machine != "LINE-1":
            raise ValueError(f"Machine {machine!r} does not belong to plant {plant!r}")
        self._check_version(signature_version)
        return {"plant": plant, "machine": machine, "accepted": True, "state_key": [],
                "signature_version": self.version}

    def upsert_occurrence_override(self, plant, machine, predecessor_order_id, successor_order_id,
                                   predecessor_values, successor_values, standard_min, remaining_min,
                                   signature_version, reason, actor):
        if machine != "LINE-1":
            raise ValueError(f"Machine {machine!r} does not belong to plant {plant!r}")
        self._check_version(signature_version)
        if remaining_min < 0:
            raise ValueError("Override minutes must be nonnegative")
        return {"id": 9, "plant": plant, "machine": machine, "signature_version": self.version,
                "standard_min": standard_min, "remaining_min": remaining_min, "status": "active"}

    def update_occurrence_override(self, plant, machine, override_id, standard_min, remaining_min,
                                   signature_version, reason, actor):
        if machine != "LINE-1":
            raise ValueError(f"Machine {machine!r} does not belong to plant {plant!r}")
        if override_id != 9:
            raise ValueError("Setup override does not belong to this plant and machine")
        self._check_version(signature_version)
        if remaining_min < 0:
            raise ValueError("Override minutes must be nonnegative")
        return {"id": override_id, "plant": plant, "machine": machine, "remaining_min": remaining_min,
                "signature_version": self.version, "status": "active"}

    def clear_occurrence_override(self, plant, machine, override_id, signature_version, actor, reason):
        self.update_occurrence_override(plant, machine, override_id, 0, 0, signature_version, reason, actor)
        return {"id": override_id, "plant": plant, "machine": machine, "cleared": True,
                "signature_version": self.version}

    def _check_rows(self, rows, signature_version):
        self._check_version(signature_version)
        if any(row.get("setup_min", 0) < 0 for row in rows):
            raise ValueError("Setup minutes must be nonnegative")

    def _check_version(self, signature_version):
        if signature_version != self.version:
            raise ValueError("Setup signature version is stale")


class _SetupServiceWithMatrixRows(_SetupService):
    def current_signature_version(self, plant):
        assert plant == "PLANT-A"
        return 4

    def page_matrix_rows(self, plant, machine, signature_version, from_key=None, offset=0, limit=100):
        assert plant == "PLANT-A"
        rows = [
            {"from_key": [{"fieldKey": "colorWheel", "value": "BLUE"}],
             "to_key": [{"fieldKey": "colorWheel", "value": "RED"}],
             "setup_min": 35, "source": "manual", "inherited": False, "plant_value": 30},
            {"from_key": [{"fieldKey": "colorWheel", "value": "BLUE"}],
             "to_key": [{"fieldKey": "colorWheel", "value": "WHITE"}],
             "setup_min": 40, "source": "manual", "inherited": True, "plant_value": 40},
        ]
        if from_key is not None:
            rows = [r for r in rows if r["from_key"] == from_key]
        return {"plant": plant, "machine": machine, "signature_version": signature_version,
                "rows": rows[offset:offset + limit],
                "meta": {"total": len(rows), "offset": offset, "limit": limit}}

    def get_setup_snapshot(self, plant):
        raise AssertionError("get_setup_snapshot must not be called by matrix-rows endpoint")


class _SetupServiceWithCoverage(_SetupService):
    def __init__(self):
        self.page_calls = []

    def get_setup_coverage_page(self, plant, machine=None, offset=0, limit=100):
        assert plant == "PLANT-A"
        return self._coverage_result(plant, machine, offset, limit, ("observed", "reachable"))

    def get_setup_missing_pairs_page(self, plant, kind, machine=None, offset=0, limit=100):
        assert plant == "PLANT-A"
        result = self._coverage_result(plant, machine, offset, limit, (kind,))
        return {"plant": plant, "definition": result["definition"], "page": result[kind]["missing_page"]}

    def _coverage_result(self, plant, machine, offset, limit, page_kinds):
        result = {
            "plant": "PLANT-A",
            "definition": {"signature_version": 4},
            "observed": {"total_pairs": 3, "covered_pairs": 2, "missing_pairs": 1},
            "reachable": {"total_pairs": 9, "covered_pairs": 4, "missing_pairs": 5},
        }
        for page_kind in page_kinds:
            result[page_kind]["missing_page"] = self._page(page_kind, machine, offset, limit)
        return result

    def _page(self, kind, machine, offset, limit):
        self.page_calls.append((kind, machine, offset, limit))
        row = {
            "machine": machine or "LINE-1", "scope": "plant",
            "from_key": [{"fieldKey": "colorWheel", "value": "BLUE"}],
            "to_key": [{"fieldKey": "colorWheel", "value": "GREEN"}],
            "covered": False, "implicit_zero": False,
        }
        return {"rows": [row], "meta": {"total": 1, "offset": offset, "limit": limit}}

    def get_setup_snapshot(self, plant):
        raise AssertionError("coverage endpoints must not call get_setup_snapshot")


def _install_matrix_rows_double(monkeypatch):
    """Install the matrix-rows service double over the real `setup_data` module.

    `get_setup_snapshot` is patched in DELIBERATELY, wired to the double's
    AssertionError-raising version: the whole point of this read path is that
    it resolves the signature version through the cheap
    `current_signature_version()` lookup and never loads a full plant
    snapshot. Patching only the two functions the endpoint is *supposed* to
    call (as this file originally did) left the guard uninstalled on the real
    module, so the test passed whether or not the hot path stayed
    snapshot-free. AssertionError is not in the endpoint's `except` tuple, so
    a reintroduced `get_setup_snapshot` call now surfaces as a test failure.
    """
    service = _SetupServiceWithMatrixRows()
    for name in ("current_signature_version", "page_matrix_rows", "get_setup_snapshot"):
        monkeypatch.setattr(brain.setup_data, name, getattr(service, name), raising=False)
    # P5 note: NIMBUS_API_KEY/require_api_key now live in backend/security/auth.py
    # (moved there per docs/architecture/domain-refactor-plan.md §4's "auth
    # guards live in backend/security/auth.py" rule) — the real guard reads the
    # module-level constant from there, not from brain.
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "setup-test-key")
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "tester@example.com"
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ["PLANT-A"]
    return service


def _install_coverage_double(monkeypatch):
    service = _SetupServiceWithCoverage()
    for name in ("get_setup_coverage_page", "get_setup_missing_pairs_page",
                 "get_setup_snapshot"):
        monkeypatch.setattr(brain.setup_data, name, getattr(service, name), raising=False)
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "setup-test-key")
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "tester@example.com"
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ["PLANT-A"]
    return service


def test_setup_compatibility_requires_reason_and_returns_persisted_value(tc, monkeypatch):
    """A setup-only opt-out cannot be silently stored without an operator reason."""
    calls = []
    def save(plant, machine, compatible, reason, actor):
        calls.append((plant, machine, compatible, reason, actor))
        if not compatible and not reason:
            raise ValueError("Setup compatibility reason is required when incompatible")
        return {"plant": plant, "machine": machine, "setup_compatible": compatible,
                "setup_compatibility_reason": reason}
    monkeypatch.setattr(brain.md, "set_setup_line_compatibility", save, raising=False)
    rejected = tc.put("/setup/5512/lines/LINE-1/compatibility", json={"setup_compatible": False, "reason": ""})
    saved = tc.put("/setup/5512/lines/LINE-1/compatibility", json={"setup_compatible": False, "reason": "Tooling differs"})
    assert rejected.status_code == 400
    assert saved.status_code == 200
    assert saved.json()["setup_compatibility_reason"] == "Tooling differs"
    assert calls[-1][:4] == ("5512", "LINE-1", False, "Tooling differs")


@pytest.fixture
def tc(monkeypatch):
    service = _SetupService()
    for name in (
        "get_setup_snapshot", "save_definition", "set_definition_active", "replace_plant_matrix",
        "upsert_machine_matrix_rows", "delete_plant_matrix_rows", "delete_machine_matrix_rows", "set_machine_state",
        "upsert_occurrence_override", "update_occurrence_override", "clear_occurrence_override",
    ):
        monkeypatch.setattr(brain.setup_data, name, getattr(service, name), raising=False)
    # GET /setup/{plant} merges in plants.setup_active as `plant_active`
    # (Workstream D2) via brain.md.get_plant_setup_active — stub it so this
    # DB-double-backed fixture never opens a real Postgres connection.
    monkeypatch.setattr(brain.md, "get_plant_setup_active", lambda plant: False, raising=False)
    # P5 note: NIMBUS_API_KEY/require_api_key now live in backend/security/auth.py
    # (moved there per docs/architecture/domain-refactor-plan.md §4's "auth
    # guards live in backend/security/auth.py" rule) — the real guard reads the
    # module-level constant from there, not from brain.
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "setup-test-key")
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    brain.api.dependency_overrides[brain.require_admin] = lambda: "owner@example.com"
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "scheduler@example.com"
    scheduler = getattr(auth, "require_setup_scheduler", None)
    if scheduler is not None:
        brain.api.dependency_overrides[scheduler] = lambda: "scheduler@example.com"
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ["5512"]
    try:
        yield TestClient(brain.api)
    finally:
        brain.api.dependency_overrides.clear()


def _matrix_row(minutes=12):
    return {"from": {"colorWheel": "RED"}, "to": {"colorWheel": "BLUE"}, "setup_min": minutes}


def test_setup_snapshot_is_plant_scoped_and_versioned(tc):
    """A requested plant receives only its own complete setup snapshot and freshness marker."""
    response = tc.get("/setup/5512", headers={"x-user-email": "scheduler@example.com", "x-request-id": "setup-read"})
    assert response.status_code == 200
    body = response.json()
    assert body["plant"] == "5512"
    assert {row["machine"] for row in body["machine_rows"]} == {"LINE-1"}
    assert body["freshness"] == {"signature_version": 4, "request_id": "setup-read"}


def test_setup_snapshot_rejects_unassigned_plant(tc):
    """Changing the URL plant must not expose another plant's setup truth."""
    response = tc.get("/setup/1006", headers={"x-user-email": "scheduler@example.com"})
    assert response.status_code == 403


def test_setup_write_requires_authenticated_actor(monkeypatch):
    """A missing authenticated identity cannot create a state assertion."""
    authenticated = getattr(auth, "require_authenticated", None)
    assert authenticated is not None, "setup endpoints require an authenticated dependency"
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    brain.api.dependency_overrides[authenticated] = lambda: (_ for _ in ()).throw(
        brain.HTTPException(status_code=401, detail="Not signed in")
    )
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ["5512"]
    try:
        response = TestClient(brain.api).put(
            "/setup/5512/lines/LINE-1/state",
            json={"values": {"colorWheel": "RED"}, "signature_version": 4,
                  "observed_at": "2026-08-13T10:00:00", "source": "manual", "reason": "floor check"},
        )
    finally:
        brain.api.dependency_overrides.clear()
    assert response.status_code == 401


def test_plant_scheduler_write_requires_explicit_scheduler_permission(monkeypatch):
    """A merely authenticated plant user cannot assert floor setup state without the named role policy."""
    scheduler = getattr(auth, "require_setup_scheduler", None)
    assert scheduler is not None, "setup scheduler writes require an explicit role permission dependency"
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    brain.api.dependency_overrides[scheduler] = lambda: (_ for _ in ()).throw(
        brain.HTTPException(status_code=403, detail="Setup scheduler permission required")
    )
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ["5512"]
    try:
        response = TestClient(brain.api).put(
            "/setup/5512/lines/LINE-1/state",
            json={"values": {"colorWheel": "RED"}, "signature_version": 4,
                  "observed_at": "2026-08-13T10:00:00", "source": "manual", "reason": "floor check"},
        )
    finally:
        brain.api.dependency_overrides.clear()
    assert response.status_code == 403


def test_named_scheduler_permission_rejects_a_role_without_explicit_opt_in(monkeypatch):
    """Role existence and a plant assignment alone cannot silently grant setup-write authority."""
    request = type("Request", (), {"headers": {"x-user-email": "planner@example.com"}})()
    monkeypatch.setattr(auth, "require_authenticated", lambda _request: "planner@example.com")
    monkeypatch.setattr(auth, "get_user_role", lambda _email: "planner")
    monkeypatch.setattr(auth, "get_role_settings", lambda _role: {"permissions": {}})
    with pytest.raises(brain.HTTPException, match="Setup scheduler permission required"):
        auth.require_setup_scheduler(request)


def test_definition_write_requires_master_data_owner(tc, monkeypatch):
    """A scheduler cannot edit a plant's shared signature definition."""
    brain.api.dependency_overrides[brain.require_admin] = lambda: (_ for _ in ()).throw(
        brain.HTTPException(status_code=403, detail="Admin role required")
    )
    response = tc.put("/setup/5512/definition", json={"fields": ["colorWheel"], "strict_blanks": True})
    assert response.status_code == 403


def test_active_write_requires_master_data_owner(tc, monkeypatch):
    """A scheduler cannot flip 'Include Setup Times in Optimizer' for a plant."""
    brain.api.dependency_overrides[brain.require_admin] = lambda: (_ for _ in ()).throw(
        brain.HTTPException(status_code=403, detail="Admin role required")
    )
    response = tc.put("/setup/5512/active", json={"active": True, "expected_signature_version": 4})
    assert response.status_code == 403


def test_active_write_requires_current_version_and_returns_freshness(tc):
    enabled = tc.put(
        "/setup/5512/active", headers={"x-request-id": "setup-active"},
        json={"active": True, "expected_signature_version": 4},
    )
    assert enabled.status_code == 200
    body = enabled.json()
    assert body["active"] is True
    assert body["freshness"] == {"signature_version": 4, "request_id": "setup-active"}

    stale = tc.put("/setup/5512/active", json={"active": True, "expected_signature_version": 3})
    assert stale.status_code == 409


def test_plant_setup_active_write_rejects_non_bool_and_persists_valid_bool(tc, monkeypatch):
    """PUT /plant/{plant}/setup-active (Workstream D2's relocated gate) validates
    like set_setup_line_compatibility: a real bool or a 400, never a truthy-string
    coercion."""
    calls = []
    def save(plant, active, subnetwork="", user_email=None):
        calls.append((plant, active, subnetwork, user_email))
        return {"status": "ok", "plant": plant, "setup_active": active}
    monkeypatch.setattr(brain.md, "set_plant_setup_active", save, raising=False)

    rejected = tc.put("/plant/5512/setup-active", json={"active": "true"})
    assert rejected.status_code == 400

    accepted = tc.put("/plant/5512/setup-active", json={"active": True})
    assert accepted.status_code == 200
    assert accepted.json() == {"status": "ok", "plant": "5512", "setup_active": True}
    assert calls[-1][:2] == ("5512", True)


def test_plant_setup_active_write_requires_admin(tc):
    """Only an admin may flip the relocated plant-level setup-active flag."""
    brain.api.dependency_overrides[brain.require_admin] = lambda: (_ for _ in ()).throw(
        brain.HTTPException(status_code=403, detail="Admin role required")
    )
    response = tc.put("/plant/5512/setup-active", json={"active": True})
    assert response.status_code == 403


def test_plant_setup_active_write_requires_authenticated_actor(monkeypatch):
    """Fix 3 regression: the endpoint must depend on auth.require_authenticated
    (matching the machine.setup_compatible precedent's exact shape -- see
    test_setup_write_requires_authenticated_actor above for the same pattern
    applied to a different setup route), not just read the x-user-email
    header directly. A request lacking a genuine authenticated identity must
    be rejected before it ever reaches the handler."""
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    brain.api.dependency_overrides[brain.require_admin] = lambda: "owner@example.com"
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: (_ for _ in ()).throw(
        brain.HTTPException(status_code=401, detail="Not signed in")
    )
    try:
        response = TestClient(brain.api).put("/plant/5512/setup-active", json={"active": True})
    finally:
        brain.api.dependency_overrides.clear()
    assert response.status_code == 401


def test_setup_snapshot_surfaces_plant_active_independently_of_definition_active(tc, monkeypatch):
    """plant_active (the real gate) must never be conflated with the vestigial
    setup_definition.active — the service double always returns active=False
    for the definition, so a True plant_active here proves the two are read
    from genuinely independent sources."""
    monkeypatch.setattr(brain.md, "get_plant_setup_active", lambda plant: True, raising=False)
    response = tc.get("/setup/5512", headers={"x-user-email": "scheduler@example.com"})
    assert response.status_code == 200
    body = response.json()
    assert body["plant_active"] is True
    assert body["definition"]["active"] is False


def test_matrix_import_enforces_stale_versions_invalid_minutes_and_line_ownership(tc):
    """Matrix import must reject stale, invalid, and cross-plant line writes before success."""
    stale = tc.post("/setup/5512/matrix/import", json={"signature_version": 3, "rows": [_matrix_row()]})
    invalid = tc.post("/setup/5512/matrix/import", json={"signature_version": 4, "rows": [_matrix_row(-1)]})
    wrong_line = tc.post("/setup/5512/matrix/import", json={
        "machine": "OTHER-PLANT-LINE", "signature_version": 4, "rows": [_matrix_row()],
    })
    assert stale.status_code == 409
    assert invalid.status_code == 400
    assert wrong_line.status_code == 400


def test_matrix_delete_rejects_stale_version_and_returns_freshness_for_the_selected_scope(tc):
    """Deleting one canonical matrix row is version-checked and never implies a broad matrix replacement."""
    stale = tc.request("DELETE", "/setup/5512/matrix", json={
        "machine": "LINE-1", "signature_version": 3, "rows": [_matrix_row()],
    })
    deleted = tc.request("DELETE", "/setup/5512/matrix", headers={"x-request-id": "matrix-delete"}, json={
        "machine": "LINE-1", "signature_version": 4, "rows": [_matrix_row()],
    })
    assert stale.status_code == 409
    assert deleted.status_code == 200
    assert deleted.json()["deleted"] == 1
    assert deleted.json()["freshness"] == {"signature_version": 4, "request_id": "matrix-delete"}


def test_definition_write_requires_expected_current_version_and_returns_freshness(tc):
    """Every successful setup mutation returns the signature version and request freshness."""
    definition = tc.put(
        "/setup/5512/definition", headers={"x-request-id": "setup-write"},
        json={"fields": ["colorWheel"], "strict_blanks": True, "expected_signature_version": 4},
    )
    assert definition.status_code == 200
    body = definition.json()
    assert body["signature_version"] == 5
    assert body["freshness"] == {"signature_version": 5, "request_id": "setup-write"}

    stale = tc.put("/setup/5512/definition", json={
        "fields": ["colorWheel"], "strict_blanks": True, "expected_signature_version": 3,
    })
    assert stale.status_code == 409


def test_line_state_and_override_reject_wrong_line_and_invalid_remaining_minutes(tc):
    """Scheduler-owned writes remain constrained to a plant-owned line and valid minutes."""
    state = tc.put("/setup/5512/lines/OTHER-PLANT-LINE/state", json={
        "values": {"colorWheel": "RED"}, "signature_version": 4,
        "observed_at": "2026-08-13T10:00:00", "source": "manual", "reason": "floor check",
    })
    override = tc.put("/setup/5512/overrides/9", json={
        "machine": "LINE-1", "standard_min": 12, "remaining_min": -1,
        "signature_version": 4, "reason": "actual work",
    })
    assert state.status_code == 400
    assert override.status_code == 400


def test_override_update_and_delete_bind_url_identity_and_require_current_version(tc):
    """The override URL identifies the exact persisted resource; stale/mismatched targets never mutate it."""
    mismatch = tc.put("/setup/5512/overrides/8", json={
        "machine": "LINE-1", "standard_min": 12, "remaining_min": 4,
        "signature_version": 4, "reason": "confirmed remaining work",
    })
    stale_delete = tc.request("DELETE", "/setup/5512/overrides/9", json={
        "machine": "LINE-1", "signature_version": 3, "reason": "completed on floor",
    })
    updated = tc.put("/setup/5512/overrides/9", headers={"x-request-id": "override-write"}, json={
        "machine": "LINE-1", "standard_min": 12, "remaining_min": 4,
        "signature_version": 4, "reason": "confirmed remaining work",
    })
    assert mismatch.status_code == 400
    assert stale_delete.status_code == 409
    assert updated.status_code == 200
    assert updated.json()["id"] == 9
    assert updated.json()["freshness"] == {"signature_version": 4, "request_id": "override-write"}


def test_override_creation_uses_a_server_assigned_resource_identity(tc):
    """Creation is distinct from URL-identified PUT so a client cannot silently replace another override."""
    created = tc.post("/setup/5512/overrides", json={
        "machine": "LINE-1", "predecessor_order_id": "before", "successor_order_id": "after",
        "predecessor_values": {"colorWheel": "RED"}, "successor_values": {"colorWheel": "BLUE"},
        "standard_min": 12, "remaining_min": 4, "signature_version": 4, "reason": "confirmed work",
    })
    assert created.status_code == 200
    assert created.json()["id"] == 9


def test_override_creation_requires_an_explicit_predecessor_key_for_initial_state(tc):
    """An initial override must send predecessor_order_id: null, not omit the binding."""
    missing = tc.post("/setup/5512/overrides", json={
        "machine": "LINE-1", "successor_order_id": "after",
        "predecessor_values": {"colorWheel": "GREEN"}, "successor_values": {"colorWheel": "BLUE"},
        "standard_min": 12, "remaining_min": 4, "signature_version": 4, "reason": "initial state",
    })
    explicit_null = tc.post("/setup/5512/overrides", json={
        "machine": "LINE-1", "predecessor_order_id": None, "successor_order_id": "after",
        "predecessor_values": {"colorWheel": "GREEN"}, "successor_values": {"colorWheel": "BLUE"},
        "standard_min": 12, "remaining_min": 4, "signature_version": 4, "reason": "initial state",
    })
    assert missing.status_code == 400
    assert explicit_null.status_code == 200


def test_setup_writes_reject_missing_api_key(monkeypatch):
    """The API-key guard remains active even when a scheduler identity is otherwise authorized."""
    # P5 note: NIMBUS_API_KEY/require_api_key now live in backend/security/auth.py
    # — the real guard reads the module-level constant from there, not from brain.
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "required-key")
    brain.api.dependency_overrides[auth.require_setup_scheduler] = lambda: "scheduler@example.com"
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ["5512"]
    try:
        response = TestClient(brain.api).put("/setup/5512/lines/LINE-1/state", json={
            "values": {"colorWheel": "RED"}, "signature_version": 4,
            "observed_at": "2026-08-13T10:00:00", "source": "manual", "reason": "floor check",
        })
    finally:
        brain.api.dependency_overrides.clear()
    assert response.status_code == 401


def test_setup_write_audit_has_safe_actor_operation_scope_outcome_and_request_id(tc):
    """The setup audit identifies the action but never stores raw uploaded/request content."""
    brain._BACKEND_LOG.clear()
    response = tc.put(
        "/setup/5512/definition",
        headers={"x-user-email": "owner@example.com", "x-request-id": "setup-audit"},
        json={"fields": ["colorWheel"], "strict_blanks": True, "expected_signature_version": 4,
              "file_content": "never-log-me"},
    )
    assert response.status_code == 200
    event = brain._BACKEND_LOG[-1]
    assert event["event"] == "setup.definition_write"
    assert event["outcome"] == "success"
    assert event["rid"] == "setup-audit"
    assert event["ctx"]["actor"] == "owner@example.com"
    assert event["ctx"]["plant"] == "5512"
    assert "file_content" not in event["ctx"]


def test_setup_coverage_and_csv_share_the_bounded_snapshot_free_page_path(monkeypatch):
    """JSON keeps its wire shape and CSV delegates to the identical capped missing-pair helper."""
    service = _install_coverage_double(monkeypatch)
    try:
        client = TestClient(brain.api)
        coverage = client.get(
            "/setup/PLANT-A/coverage",
            params={"machine": "LINE-2", "offset": 1, "limit": 2},
        )
        exported = client.get(
            "/setup/PLANT-A/missing-pairs.csv",
            params={"kind": "reachable", "machine": "LINE-2", "offset": 1, "limit": 2},
        )
    finally:
        brain.api.dependency_overrides.clear()

    assert coverage.status_code == 200
    body = coverage.json()
    assert body["signature_version"] == 4
    assert body["observed"] == {
        "total_pairs": 3,
        "covered_pairs": 2,
        "missing_pairs": 1,
        "missing_page": {
            "rows": [{
                "machine": "LINE-2", "scope": "plant",
                "from_key": [{"fieldKey": "colorWheel", "value": "BLUE"}],
                "to_key": [{"fieldKey": "colorWheel", "value": "GREEN"}],
                "covered": False, "implicit_zero": False,
            }],
            "meta": {"total": 1, "offset": 1, "limit": 2},
        },
    }
    assert "definition" not in body
    assert exported.status_code == 200
    assert exported.headers["x-total-count"] == "1"
    assert "PLANT-A,LINE-2,plant,4" in exported.text
    assert service.page_calls == [
        ("observed", "LINE-2", 1, 2),
        ("reachable", "LINE-2", 1, 2),
        ("reachable", "LINE-2", 1, 2),
    ]


def test_get_setup_matrix_rows_scopes_by_line_and_from_state(monkeypatch):
    """Also pins the no-full-snapshot contract: the installed double's
    get_setup_snapshot raises, so a 200 here proves the hot path never
    loaded a whole-plant snapshot to answer one bounded page."""
    _install_matrix_rows_double(monkeypatch)
    try:
        client = TestClient(brain.api)
        response = client.get(
            "/setup/PLANT-A/matrix-rows",
            params={"machine": "LINE-1", "from_key": '[{"fieldKey":"colorWheel","value":"BLUE"}]', "limit": 1},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["meta"]["total"] == 2
        assert len(body["rows"]) == 1
        assert body["rows"][0]["setup_min"] == 35
    finally:
        brain.api.dependency_overrides.clear()


def test_get_setup_matrix_rows_rejects_bad_limit(monkeypatch):
    _install_matrix_rows_double(monkeypatch)
    try:
        client = TestClient(brain.api)
        response = client.get("/setup/PLANT-A/matrix-rows", params={"limit": 0})
        assert response.status_code in (400, 422)
    finally:
        brain.api.dependency_overrides.clear()


def test_get_setup_matrix_rows_never_loads_a_full_snapshot(monkeypatch):
    """Regression guard for the fix that replaced get_setup_snapshot() with
    current_signature_version() on this path. Proves the guard actually bites:
    with get_setup_snapshot rewired to the *endpoint's* version resolver, the
    request fails — so the passing sibling tests above are meaningful, not
    vacuous."""
    _install_matrix_rows_double(monkeypatch)
    monkeypatch.setattr(
        brain.setup_data, "current_signature_version",
        lambda plant: brain.setup_data.get_setup_snapshot(plant)["definition"]["signature_version"],
        raising=False,
    )
    try:
        client = TestClient(brain.api)
        with pytest.raises(AssertionError, match="must not be called"):
            client.get("/setup/PLANT-A/matrix-rows")
    finally:
        brain.api.dependency_overrides.clear()


def test_stale_plant_matrix_token_maps_to_409(tc, monkeypatch):
    """Plan Part 2 #20: a stale content-hash token reuses the stale -> 409 mapping."""
    def _stale(self, plant, rows, signature_version, actor, expected_token=None):
        raise ValueError("Setup plant-default matrix is stale: another admin changed it; reload and retry")
    monkeypatch.setattr(brain.setup_data, "replace_plant_matrix", lambda *a, **k: _stale(None, *a, **k))
    response = tc.post("/setup/5512/matrix/import",
                       json={"signature_version": 4, "rows": [], "plant_matrix_token": "old"})
    assert response.status_code == 409


def test_setup_missing_pairs_csv_is_bom_prefixed_and_formula_guarded(monkeypatch):
    """Exporter wiring (plan Part 1 #8): the missing-pairs CSV must run every
    text cell through csv_row and start with the UTF-8 BOM -- a machine/scope/
    plant beginning with = + - @ is neutralised with a leading apostrophe."""
    def page(plant, kind, machine=None, offset=0, limit=100):
        return {
            "definition": {"signature_version": 4},
            "page": {"rows": [{"machine": "=HYPERLINK(\"x\")", "scope": "+plant",
                               "from_key": [{"fieldKey": "colorWheel", "value": "A"}],
                               "to_key": [{"fieldKey": "colorWheel", "value": "B"}]}],
                     "meta": {"total": 1, "offset": offset, "limit": limit}},
        }

    monkeypatch.setattr(brain.setup_data, "get_setup_missing_pairs_page", page, raising=False)
    monkeypatch.setattr(auth, "NIMBUS_API_KEY", "setup-test-key")
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "tester@example.com"
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ["@PLANT"]
    try:
        response = TestClient(brain.api).get("/setup/@PLANT/missing-pairs.csv")
    finally:
        brain.api.dependency_overrides.clear()
    assert response.status_code == 200
    assert response.content.startswith(b"\xef\xbb\xbf")
    import csv as _csv
    import io as _io
    rows = list(_csv.reader(_io.StringIO(response.content.decode("utf-8-sig"))))
    assert rows[0][0] == "Plant"
    assert rows[1][:3] == ["'@PLANT", "'=HYPERLINK(\"x\")", "'+plant"]
