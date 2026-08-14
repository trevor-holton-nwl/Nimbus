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


class _PolicyService:
    def __init__(self):
        self.value = dict(DEFAULT)

    def get_setup_policy_config(self, plant):
        return {"plant": plant, **self.value}

    def set_setup_policy_config(self, plant, config, expected_version, user_email=None):
        if expected_version != self.value["version"]:
            raise ValueError("Setup policy version is stale")
        if config["throughputMinSavingsMin"] < 0:
            raise ValueError("throughputMinSavingsMin must be nonnegative")
        if config["throughputMaxSlipMin"] <= 0:
            raise ValueError("throughputMaxSlipMin must be positive")
        self.value = {**config, "version": self.value["version"] + 1}
        return {"plant": plant, **self.value}


@pytest.fixture
def tc(monkeypatch):
    service = _PolicyService()
    monkeypatch.setattr(brain.md, "get_setup_policy_config", service.get_setup_policy_config, raising=False)
    monkeypatch.setattr(brain.md, "set_setup_policy_config", service.set_setup_policy_config, raising=False)
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
    body["minChangeoverEnabled"] = True
    saved = tc.put("/setup/5512/policy", json={**body, "expected_version": 1})
    assert saved.status_code == 200
    assert saved.json()["minChangeoverEnabled"] is True
    assert saved.json()["version"] == 2

    stale = tc.put("/setup/5512/policy", json={**body, "expected_version": 1})
    assert stale.status_code == 409

    brain.api.dependency_overrides[brain.require_admin] = lambda: (_ for _ in ()).throw(
        brain.HTTPException(status_code=403, detail="Admin role required")
    )
    unauthorized = tc.put("/setup/5512/policy", json={**body, "expected_version": 2})
    assert unauthorized.status_code == 403
