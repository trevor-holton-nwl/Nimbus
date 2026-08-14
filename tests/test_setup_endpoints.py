"""Contract tests for the authorized, plant-scoped setup API surface."""
import pytest

try:
    from starlette.testclient import TestClient

    import auth
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
            "plant_rows": [{"line": "", "setup_min": 12}],
            "line_rows": [{"line": "LINE-1", "setup_min": 9}],
            "line_states": [{"line": "LINE-1", "source": "manual"}],
            "overrides": [{"id": 7, "line": "LINE-1", "status": "inactive"}],
        }

    def save_definition(self, plant, fields, strict_blanks, actor, expected_signature_version):
        self._check_version(expected_signature_version)
        self.version += 1
        return {"plant": plant, "fields": fields, "strict_blanks": strict_blanks,
                "signature_version": self.version, "active": False}

    def replace_plant_matrix(self, plant, rows, signature_version, actor):
        self._check_rows(rows, signature_version)
        return {"plant": plant, "line": "", "signature_version": self.version, "rows": len(rows)}

    def upsert_line_matrix_rows(self, plant, line, rows, signature_version, actor):
        if line != "LINE-1":
            raise ValueError(f"Line {line!r} does not belong to plant {plant!r}")
        self._check_rows(rows, signature_version)
        return {"plant": plant, "line": line, "signature_version": self.version, "rows": len(rows)}

    def delete_plant_matrix_rows(self, plant, rows, signature_version, actor):
        self._check_rows(rows, signature_version)
        return {"plant": plant, "line": "", "signature_version": self.version, "deleted": len(rows)}

    def delete_line_matrix_rows(self, plant, line, rows, signature_version, actor):
        if line != "LINE-1":
            raise ValueError(f"Line {line!r} does not belong to plant {plant!r}")
        self._check_rows(rows, signature_version)
        return {"plant": plant, "line": line, "signature_version": self.version, "deleted": len(rows)}

    def set_line_state(self, plant, line, values, signature_version, observed_at, source, reason, actor,
                       physical_mold_id=None):
        if line != "LINE-1":
            raise ValueError(f"Line {line!r} does not belong to plant {plant!r}")
        self._check_version(signature_version)
        return {"plant": plant, "line": line, "accepted": True, "state_key": [],
                "signature_version": self.version}

    def upsert_occurrence_override(self, plant, line, predecessor_order_id, successor_order_id,
                                   predecessor_values, successor_values, standard_min, remaining_min,
                                   signature_version, reason, actor):
        if line != "LINE-1":
            raise ValueError(f"Line {line!r} does not belong to plant {plant!r}")
        self._check_version(signature_version)
        if remaining_min < 0:
            raise ValueError("Override minutes must be nonnegative")
        return {"id": 9, "plant": plant, "line": line, "signature_version": self.version,
                "standard_min": standard_min, "remaining_min": remaining_min, "status": "active"}

    def update_occurrence_override(self, plant, line, override_id, standard_min, remaining_min,
                                   signature_version, reason, actor):
        if line != "LINE-1":
            raise ValueError(f"Line {line!r} does not belong to plant {plant!r}")
        if override_id != 9:
            raise ValueError("Setup override does not belong to this plant and line")
        self._check_version(signature_version)
        if remaining_min < 0:
            raise ValueError("Override minutes must be nonnegative")
        return {"id": override_id, "plant": plant, "line": line, "remaining_min": remaining_min,
                "signature_version": self.version, "status": "active"}

    def clear_occurrence_override(self, plant, line, override_id, signature_version, actor, reason):
        self.update_occurrence_override(plant, line, override_id, 0, 0, signature_version, reason, actor)
        return {"id": override_id, "plant": plant, "line": line, "cleared": True,
                "signature_version": self.version}

    def _check_rows(self, rows, signature_version):
        self._check_version(signature_version)
        if any(row.get("setup_min", 0) < 0 for row in rows):
            raise ValueError("Setup minutes must be nonnegative")

    def _check_version(self, signature_version):
        if signature_version != self.version:
            raise ValueError("Setup signature version is stale")


def test_setup_compatibility_requires_reason_and_returns_persisted_value(tc, monkeypatch):
    """A setup-only opt-out cannot be silently stored without an operator reason."""
    calls = []
    def save(plant, line, compatible, reason, actor):
        calls.append((plant, line, compatible, reason, actor))
        if not compatible and not reason:
            raise ValueError("Setup compatibility reason is required when incompatible")
        return {"plant": plant, "line": line, "setup_compatible": compatible,
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
        "get_setup_snapshot", "save_definition", "replace_plant_matrix", "upsert_line_matrix_rows",
        "delete_plant_matrix_rows", "delete_line_matrix_rows", "set_line_state",
        "upsert_occurrence_override", "update_occurrence_override", "clear_occurrence_override",
    ):
        monkeypatch.setattr(brain.setup_data, name, getattr(service, name), raising=False)
    monkeypatch.setattr(brain, "NIMBUS_API_KEY", "setup-test-key")
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
    assert {row["line"] for row in body["line_rows"]} == {"LINE-1"}
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


def test_matrix_import_enforces_stale_versions_invalid_minutes_and_line_ownership(tc):
    """Matrix import must reject stale, invalid, and cross-plant line writes before success."""
    stale = tc.post("/setup/5512/matrix/import", json={"signature_version": 3, "rows": [_matrix_row()]})
    invalid = tc.post("/setup/5512/matrix/import", json={"signature_version": 4, "rows": [_matrix_row(-1)]})
    wrong_line = tc.post("/setup/5512/matrix/import", json={
        "line": "OTHER-PLANT-LINE", "signature_version": 4, "rows": [_matrix_row()],
    })
    assert stale.status_code == 409
    assert invalid.status_code == 400
    assert wrong_line.status_code == 400


def test_matrix_delete_rejects_stale_version_and_returns_freshness_for_the_selected_scope(tc):
    """Deleting one canonical matrix row is version-checked and never implies a broad matrix replacement."""
    stale = tc.request("DELETE", "/setup/5512/matrix", json={
        "line": "LINE-1", "signature_version": 3, "rows": [_matrix_row()],
    })
    deleted = tc.request("DELETE", "/setup/5512/matrix", headers={"x-request-id": "matrix-delete"}, json={
        "line": "LINE-1", "signature_version": 4, "rows": [_matrix_row()],
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
        "line": "LINE-1", "standard_min": 12, "remaining_min": -1,
        "signature_version": 4, "reason": "actual work",
    })
    assert state.status_code == 400
    assert override.status_code == 400


def test_override_update_and_delete_bind_url_identity_and_require_current_version(tc):
    """The override URL identifies the exact persisted resource; stale/mismatched targets never mutate it."""
    mismatch = tc.put("/setup/5512/overrides/8", json={
        "line": "LINE-1", "standard_min": 12, "remaining_min": 4,
        "signature_version": 4, "reason": "confirmed remaining work",
    })
    stale_delete = tc.request("DELETE", "/setup/5512/overrides/9", json={
        "line": "LINE-1", "signature_version": 3, "reason": "completed on floor",
    })
    updated = tc.put("/setup/5512/overrides/9", headers={"x-request-id": "override-write"}, json={
        "line": "LINE-1", "standard_min": 12, "remaining_min": 4,
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
        "line": "LINE-1", "predecessor_order_id": "before", "successor_order_id": "after",
        "predecessor_values": {"colorWheel": "RED"}, "successor_values": {"colorWheel": "BLUE"},
        "standard_min": 12, "remaining_min": 4, "signature_version": 4, "reason": "confirmed work",
    })
    assert created.status_code == 200
    assert created.json()["id"] == 9


def test_override_creation_requires_an_explicit_predecessor_key_for_initial_state(tc):
    """An initial override must send predecessor_order_id: null, not omit the binding."""
    missing = tc.post("/setup/5512/overrides", json={
        "line": "LINE-1", "successor_order_id": "after",
        "predecessor_values": {"colorWheel": "GREEN"}, "successor_values": {"colorWheel": "BLUE"},
        "standard_min": 12, "remaining_min": 4, "signature_version": 4, "reason": "initial state",
    })
    explicit_null = tc.post("/setup/5512/overrides", json={
        "line": "LINE-1", "predecessor_order_id": None, "successor_order_id": "after",
        "predecessor_values": {"colorWheel": "GREEN"}, "successor_values": {"colorWheel": "BLUE"},
        "standard_min": 12, "remaining_min": 4, "signature_version": 4, "reason": "initial state",
    })
    assert missing.status_code == 400
    assert explicit_null.status_code == 200


def test_setup_writes_reject_missing_api_key(monkeypatch):
    """The API-key guard remains active even when a scheduler identity is otherwise authorized."""
    monkeypatch.setattr(brain, "NIMBUS_API_KEY", "required-key")
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
