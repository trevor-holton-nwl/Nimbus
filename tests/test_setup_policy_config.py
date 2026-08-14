"""Contract tests for the per-plant, disabled-by-default setup policy sidecar."""
import pytest

try:
    from starlette.testclient import TestClient

    import auth
    import brain
except Exception as exc:  # pragma: no cover - environment-owned imports
    pytest.skip(f"brain/TestClient unavailable in this environment: {exc}", allow_module_level=True)


DEFAULT = {
    "dueDateFirstEnabled": False,
    "minChangeoverEnabled": False,
    "throughputEnabled": False,
    "throughputMinSavingsMin": 60,
    "throughputMaxSlipMin": 1440,
    "version": 1,
}

EVIDENCE_DEFAULT = {
    "stage1Validated": False,
    "localDbVerified": False,
    "performanceVerified": False,
    "browserUatVerified": False,
    "representativeReplayVerified": False,
    "nullPredecessorVerified": False,
    "ownerApproved": False,
    "ownerEmail": None,
    "approvedAt": None,
    "notes": "",
    "version": 1,
}


class _PolicyService:
    def __init__(self):
        self.value = dict(DEFAULT)
        self.evidence = dict(EVIDENCE_DEFAULT)

    def get_setup_policy_config(self, plant):
        return {"plant": plant, **self.value}

    def get_setup_release_evidence(self, plant):
        return {"plant": plant, **self.evidence, "ready": self.evidence_ready()}

    def evidence_ready(self):
        return all(self.evidence[key] for key in (
            "stage1Validated", "localDbVerified", "performanceVerified",
            "browserUatVerified", "representativeReplayVerified",
            "nullPredecessorVerified", "ownerApproved",
        )) and bool(self.evidence["ownerEmail"] and self.evidence["approvedAt"] and self.evidence["notes"])

    def set_setup_policy_config(self, plant, config, expected_version, user_email=None):
        if expected_version != self.value["version"]:
            raise ValueError("Setup policy version is stale")
        if config["throughputMinSavingsMin"] < 0:
            raise ValueError("throughputMinSavingsMin must be nonnegative")
        if config["throughputMaxSlipMin"] <= 0:
            raise ValueError("throughputMaxSlipMin must be positive")
        if any(config[key] for key in ("dueDateFirstEnabled", "minChangeoverEnabled", "throughputEnabled")) and not self.evidence_ready():
            raise ValueError("Setup policy activation requires complete release evidence")
        self.value = {**config, "version": self.value["version"] + 1}
        return {"plant": plant, **self.value}

    def set_setup_release_evidence(self, plant, evidence, expected_version, user_email=None):
        if expected_version != self.evidence["version"]:
            raise ValueError("Setup release evidence version is stale")
        self.evidence = {**evidence, "version": expected_version + 1}
        return {"plant": plant, **self.evidence, "ready": self.evidence_ready()}


@pytest.fixture
def tc(monkeypatch):
    service = _PolicyService()
    monkeypatch.setattr(brain.md, "get_setup_policy_config", service.get_setup_policy_config, raising=False)
    monkeypatch.setattr(brain.md, "set_setup_policy_config", service.set_setup_policy_config, raising=False)
    monkeypatch.setattr(brain.md, "get_setup_release_evidence", service.get_setup_release_evidence, raising=False)
    monkeypatch.setattr(brain.md, "set_setup_release_evidence", service.set_setup_release_evidence, raising=False)
    monkeypatch.setattr(brain, "NIMBUS_API_KEY", "policy-test-key")
    brain.api.dependency_overrides[brain.require_api_key] = lambda: None
    brain.api.dependency_overrides[brain.require_admin] = lambda: "owner@example.com"
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "owner@example.com"
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: ["5512"]
    try:
        yield TestClient(brain.api)
    finally:
        brain.api.dependency_overrides.clear()


def test_setup_policy_defaults_are_plant_scoped_and_disabled(tc):
    response = tc.get("/setup/5512/policy")
    assert response.status_code == 200
    assert response.json() == {"plant": "5512", **DEFAULT}

    forbidden = tc.get("/setup/1006/policy")
    assert forbidden.status_code == 403


def test_setup_release_evidence_defaults_are_plant_scoped_and_not_ready(tc):
    response = tc.get("/setup/5512/release-evidence")
    assert response.status_code == 200
    assert response.json() == {"plant": "5512", **EVIDENCE_DEFAULT, "ready": False}
    assert tc.get("/setup/1006/release-evidence").status_code == 403


@pytest.mark.parametrize(("field", "value", "message"), [
    ("throughputMinSavingsMin", -1, "nonnegative"),
    ("throughputMaxSlipMin", 0, "positive"),
])
def test_setup_policy_rejects_invalid_thresholds(tc, field, value, message):
    body = {k: v for k, v in DEFAULT.items() if k != "version"}
    body[field] = value
    response = tc.put("/setup/5512/policy", json={**body, "expected_version": 1})
    assert response.status_code == 400
    assert message in response.json()["detail"]


def test_setup_policy_write_requires_admin_and_current_version(tc):
    body = {k: v for k, v in DEFAULT.items() if k != "version"}
    # Threshold maintenance remains available while activation evidence is absent.
    saved = tc.put("/setup/5512/policy", json={**body, "expected_version": 1})
    assert saved.status_code == 200
    assert saved.json()["minChangeoverEnabled"] is False
    assert saved.json()["version"] == 2

    stale = tc.put("/setup/5512/policy", json={**body, "expected_version": 1})
    assert stale.status_code == 409

    brain.api.dependency_overrides[brain.require_admin] = lambda: (_ for _ in ()).throw(
        brain.HTTPException(status_code=403, detail="Admin role required")
    )
    unauthorized = tc.put("/setup/5512/policy", json={**body, "expected_version": 2})
    assert unauthorized.status_code == 403


def test_setup_policy_activation_requires_complete_evidence_and_then_allows_it(tc):
    body = {k: v for k, v in DEFAULT.items() if k != "version"}
    body["minChangeoverEnabled"] = True
    blocked = tc.put("/setup/5512/policy", json={**body, "expected_version": 1})
    assert blocked.status_code == 400
    assert "release evidence" in blocked.json()["detail"].lower()

    evidence = {k: v for k, v in EVIDENCE_DEFAULT.items() if k != "version"}
    evidence.update({
        "stage1Validated": True, "localDbVerified": True, "performanceVerified": True,
        "browserUatVerified": True, "representativeReplayVerified": True,
        "nullPredecessorVerified": True, "ownerApproved": True,
        "ownerEmail": "owner@example.com", "approvedAt": "2026-08-14T12:00:00Z",
        "notes": "All release checks recorded.",
    })
    recorded = tc.put("/setup/5512/release-evidence", json={**evidence, "expected_version": 1})
    assert recorded.status_code == 200
    assert recorded.json()["ready"] is True
    enabled = tc.put("/setup/5512/policy", json={**body, "expected_version": 1})
    assert enabled.status_code == 200
    assert enabled.json()["minChangeoverEnabled"] is True
