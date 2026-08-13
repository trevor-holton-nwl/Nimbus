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

    def save_definition(self, plant, fields, strict_blanks, actor):
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

    def clear_occurrence_override(self, plant, line, override_id, actor, reason):
        if line != "LINE-1":
            raise ValueError(f"Line {line!r} does not belong to plant {plant!r}")
        return {"id": override_id, "plant": plant, "line": line, "cleared": True,
                "signature_version": self.version}

    def _check_rows(self, rows, signature_version):
        self._check_version(signature_version)
        if any(row.get("setup_min", 0) < 0 for row in rows):
            raise ValueError("Setup minutes must be nonnegative")

    def _check_version(self, signature_version):
        if signature_version != self.version:
            raise ValueError("Setup signature version is stale")


@pytest.fixture
def tc(monkeypatch):
    service = _SetupService()
    for name in (
        "get_setup_snapshot", "save_definition", "replace_plant_matrix", "upsert_line_matrix_rows",
        "delete_plant_matrix_rows", "delete_line_matrix_rows", "set_line_state",
        "upsert_occurrence_override", "clear_occurrence_override",
    ):
        monkeypatch.setattr(brain.setup_data, name, getattr(service, name), raising=False)
    monkeypatch.setattr(brain, "NIMBUS_API_KEY", "setup-test-key")
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    brain.api.dependency_overrides[brain.require_admin] = lambda: "owner@example.com"
    authenticated = getattr(auth, "require_authenticated", None)
    if authenticated is not None:
        brain.api.dependency_overrides[authenticated] = lambda: "scheduler@example.com"
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


def test_successful_setup_writes_return_new_versioned_freshness(tc):
    """Every successful setup mutation returns the signature version and request freshness."""
    definition = tc.put(
        "/setup/5512/definition", headers={"x-request-id": "setup-write"},
        json={"fields": ["colorWheel"], "strict_blanks": True},
    )
    assert definition.status_code == 200
    body = definition.json()
    assert body["signature_version"] == 5
    assert body["freshness"] == {"signature_version": 5, "request_id": "setup-write"}


def test_line_state_and_override_reject_wrong_line_and_invalid_remaining_minutes(tc):
    """Scheduler-owned writes remain constrained to a plant-owned line and valid minutes."""
    state = tc.put("/setup/5512/lines/OTHER-PLANT-LINE/state", json={
        "values": {"colorWheel": "RED"}, "signature_version": 4,
        "observed_at": "2026-08-13T10:00:00", "source": "manual", "reason": "floor check",
    })
    override = tc.put("/setup/5512/overrides/9", json={
        "line": "LINE-1", "predecessor_order_id": "before", "successor_order_id": "after",
        "predecessor_values": {"colorWheel": "RED"}, "successor_values": {"colorWheel": "BLUE"},
        "standard_min": 12, "remaining_min": -1, "signature_version": 4, "reason": "actual work",
    })
    assert state.status_code == 400
    assert override.status_code == 400


def test_setup_write_audit_has_safe_actor_operation_scope_outcome_and_request_id(tc):
    """The setup audit identifies the action but never stores raw uploaded/request content."""
    brain._BACKEND_LOG.clear()
    response = tc.put(
        "/setup/5512/definition",
        headers={"x-user-email": "owner@example.com", "x-request-id": "setup-audit"},
        json={"fields": ["colorWheel"], "strict_blanks": True, "file_content": "never-log-me"},
    )
    assert response.status_code == 200
    event = brain._BACKEND_LOG[-1]
    assert event["event"] == "setup.definition_write"
    assert event["outcome"] == "success"
    assert event["rid"] == "setup-audit"
    assert event["ctx"]["actor"] == "owner@example.com"
    assert event["ctx"]["plant"] == "5512"
    assert "file_content" not in event["ctx"]
