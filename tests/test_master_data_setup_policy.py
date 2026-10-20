"""Regression coverage for setup-policy changes beside existing setup admin writes."""
from contextlib import contextmanager

import pytest

import master_data as md


class _Cursor:
    rowcount = 1

    def __init__(self):
        self.executed = []

    def execute(self, statement, params=None):
        self.executed.append((str(statement), params))


class _Pool:
    def __init__(self, cursor):
        self.cursor_value = cursor

    @contextmanager
    def connection(self):
        yield _Connection(self.cursor_value)


class _Connection:
    def __init__(self, cursor):
        self.cursor_value = cursor
        self.committed = False

    @contextmanager
    def cursor(self):
        yield self.cursor_value

    def commit(self):
        self.committed = True


def test_setup_compatibility_write_returns_its_persisted_plant_line_payload(monkeypatch):
    """A policy-sidecar insertion must not strand the preceding write return."""
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_setup_line_compatibility("5512", "LINE-1", False, "Tooling differs", "owner@example.com")

    assert result == {
        "plant": "5512", "machine": "LINE-1", "setup_compatible": False,
        "setup_compatibility_reason": "Tooling differs",
    }
    assert any("UPDATE machine" in statement for statement, _ in cursor.executed)


def test_max_pull_forward_write_persists_nullable_integer_and_audits(monkeypatch):
    """A plant-scoped limit must be persisted and attributed to the admin actor."""
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_plant_max_pull_forward_days("SN", "5512", 7, "owner@example.com")

    assert result == {"status": "ok", "plant": "5512", "max_pull_forward_days": 7}
    update = next((item for item in cursor.executed if "UPDATE plants SET max_pull_forward_days" in item[0]), None)
    assert update is not None
    assert update[1] == [7, "5512", "SN"]
    assert any("set_max_pull_forward_days" in statement for statement, _ in cursor.executed)


def test_max_pull_forward_rejects_invalid_values():
    for value in (-1, 1.5, "7", True):
        try:
            md.set_plant_max_pull_forward_days("SN", "5512", value)
        except ValueError as error:
            assert "max_pull_forward_days" in str(error)
        else:
            raise AssertionError(f"{value!r} must be rejected")


def test_max_push_forward_write_persists_nullable_integer_and_audits(monkeypatch):
    """A plant-scoped limit must be persisted and attributed to the admin actor."""
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_plant_max_push_forward_days("SN", "5512", 7, "owner@example.com")

    assert result == {"status": "ok", "plant": "5512", "max_push_forward_days": 7}
    update = next((item for item in cursor.executed if "UPDATE plants SET max_push_forward_days" in item[0]), None)
    assert update is not None
    assert update[1] == [7, "5512", "SN"]
    assert any("set_max_push_forward_days" in statement for statement, _ in cursor.executed)


def test_max_push_forward_rejects_invalid_values():
    for value in (-1, 1.5, "7", True):
        try:
            md.set_plant_max_push_forward_days("SN", "5512", value)
        except ValueError as error:
            assert "max_push_forward_days" in str(error)
        else:
            raise AssertionError(f"{value!r} must be rejected")


def test_min_productive_segment_minutes_write_persists_positive_integer_and_audits(monkeypatch):
    """B3 (2026-08-21): the plant-configurable productive-segment floor must
    be persisted and attributed to the admin actor, mirroring
    set_plant_max_pull_forward_days's validated-write shape."""
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_plant_min_productive_segment_minutes("SN", "5512", 15, "owner@example.com")

    assert result == {"status": "ok", "plant": "5512", "min_productive_segment_minutes": 15}
    update = next(
        (item for item in cursor.executed if "UPDATE plants SET min_productive_segment_minutes" in item[0]), None,
    )
    assert update is not None
    assert update[1] == [15, "5512", "SN"]
    assert any("set_min_productive_segment_minutes" in statement for statement, _ in cursor.executed)


def test_min_productive_segment_minutes_rejects_invalid_values():
    """Unlike max_pull_forward_days, this column is NOT NULL — null, zero,
    negative, non-integer, and bool values must all be rejected."""
    for value in (-1, 0, 1.5, "30", True, None):
        try:
            md.set_plant_min_productive_segment_minutes("SN", "5512", value)
        except ValueError as error:
            assert "min_productive_segment_minutes" in str(error)
        else:
            raise AssertionError(f"{value!r} must be rejected")


def test_setup_active_write_persists_bool_and_audits(monkeypatch):
    """The relocated plant-level "include setup times" flag must persist to
    plants.setup_active and land in admin_audit, mirroring
    set_setup_line_compatibility's validated-write shape."""
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_plant_setup_active("5512", True, subnetwork="SN", user_email="owner@example.com")

    assert result == {"status": "ok", "plant": "5512", "setup_active": True}
    update = next((item for item in cursor.executed if "UPDATE plants SET setup_active" in item[0]), None)
    assert update is not None
    assert update[1] == [True, "5512", "SN"]
    assert any("set_setup_active" in statement for statement, _ in cursor.executed)


def test_setup_active_rejects_non_bool_the_same_way_setup_compatible_does():
    """No truthy-string coercion — a real bool or a ValueError, exactly like
    set_setup_line_compatibility's setup_compatible check."""
    for value in ("true", 1, None, 0):
        try:
            md.set_plant_setup_active("5512", value)
        except ValueError as error:
            assert "active" in str(error)
        else:
            raise AssertionError(f"{value!r} must be rejected")


def test_get_plant_setup_active_reads_the_persisted_column(monkeypatch):
    """A read-only fetch used to embed `plant_active` into GET /setup/{plant}."""
    class _ReadCursor(_Cursor):
        def execute(self, statement, params=None):
            super().execute(statement, params)
            self._row = (True,) if "setup_active" in str(statement) else None

        def fetchone(self):
            return self._row

    cursor = _ReadCursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    assert md.get_plant_setup_active("5512") is True


def test_unknown_setup_policy_write_merges_jsonb_and_audits(monkeypatch):
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_plant_unknown_setup_policy("SN", "5512", "plantDefaultMinutes", 45, "owner@example.com")

    assert result["status"] == "ok" and result["plant"] == "5512"
    assert result["setup_policy_config"] == {
        "unknownSetupPolicy": "plantDefaultMinutes", "unknownSetupDefaultMinutes": 45, "version": 2,
    }
    update = next((item for item in cursor.executed if "UPDATE plants SET setup_policy_config" in item[0]), None)
    assert update is not None
    assert "setup_policy_config || %s" in update[0]
    assert update[1][1:] == ["5512", "SN"]
    assert any("set_unknown_setup_policy" in statement for statement, _ in cursor.executed)


def test_unknown_setup_policy_rejects_invalid_values():
    for policy, minutes in (("freeze", 0), ("zero", -1), ("zero", 1.5), ("zero", True), ("plantDefaultMinutes", "45")):
        try:
            md.set_plant_unknown_setup_policy("SN", "5512", policy, minutes)
        except ValueError as error:
            assert "unknown_setup" in str(error)
        else:
            raise AssertionError(f"{policy!r}/{minutes!r} must be rejected")


# ── Order Rules matrix (order-rules-hardening, Phase 1): setters beside the five settings ──

@pytest.mark.parametrize("policy", ["never", "overlong_only", "partial_allowed"])
def test_split_order_policy_write_persists_each_allowed_value_and_audits(monkeypatch, policy):
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_plant_split_order_policy("SN", "5512", policy, "owner@example.com")

    assert result == {"status": "ok", "plant": "5512", "split_order_policy": policy}
    update = next((item for item in cursor.executed if "UPDATE plants SET split_order_policy" in item[0]), None)
    assert update is not None
    assert update[1] == [policy, "5512", "SN"]
    assert any("set_split_order_policy" in statement for statement, _ in cursor.executed)


def test_split_order_policy_normalizes_case_and_whitespace(monkeypatch):
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_plant_split_order_policy("SN", "5512", "  Overlong_Only ")

    assert result["split_order_policy"] == "overlong_only"


@pytest.mark.parametrize("policy", ["split", "always", "", None, "never,partial_allowed", 1])
def test_split_order_policy_rejects_values_outside_the_allowlist(policy):
    with pytest.raises(ValueError, match="split_order_policy"):
        md.set_plant_split_order_policy("SN", "5512", policy)


def test_split_order_policy_requires_a_plant():
    with pytest.raises(ValueError, match="plant is required"):
        md.set_plant_split_order_policy("SN", "", "never")


@pytest.mark.parametrize("setter,column", [
    (md.set_plant_max_pull_forward_days, "max_pull_forward_days"),
    (md.set_plant_max_push_forward_days, "max_push_forward_days"),
])
def test_pull_and_push_limits_accept_null_to_clear_the_limit(monkeypatch, setter, column):
    """Blank in the UI means no limit: a null must be written through, not rejected or coerced to 0."""
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = setter("SN", "5512", None, "owner@example.com")

    assert result == {"status": "ok", "plant": "5512", column: None}
    update = next((item for item in cursor.executed if f"UPDATE plants SET {column}" in item[0]), None)
    assert update is not None
    assert update[1] == [None, "5512", "SN"]


@pytest.mark.parametrize("setter,column", [
    (md.set_plant_max_pull_forward_days, "max_pull_forward_days"),
    (md.set_plant_max_push_forward_days, "max_push_forward_days"),
])
def test_pull_and_push_limits_accept_zero_as_a_real_limit(monkeypatch, setter, column):
    """Zero is a hard "due day only" limit, distinct from blank (no limit)."""
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = setter("SN", "5512", 0, "owner@example.com")

    assert result == {"status": "ok", "plant": "5512", column: 0}
    update = next((item for item in cursor.executed if f"UPDATE plants SET {column}" in item[0]), None)
    assert update[1] == [0, "5512", "SN"]


@pytest.mark.parametrize("setter", [md.set_plant_max_pull_forward_days, md.set_plant_max_push_forward_days])
def test_pull_and_push_limits_without_a_subnetwork_scope_by_plant_only(monkeypatch, setter):
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    setter("", "5512", 3)

    update = next(item for item in cursor.executed if "UPDATE plants SET" in item[0])
    assert update[1] == [3, "5512"]
    assert "subnetwork" not in update[0]


def test_unknown_setup_policy_zero_persists_zero_minutes(monkeypatch):
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_plant_unknown_setup_policy("SN", "5512", "zero", 0, "owner@example.com")

    assert result["setup_policy_config"] == {"unknownSetupPolicy": "zero", "unknownSetupDefaultMinutes": 0, "version": 2}


def test_unknown_setup_policy_exclude_from_search_succeeds_and_null_minutes_become_zero(monkeypatch):
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_plant_unknown_setup_policy("SN", "5512", "excludeFromSearch", None, "owner@example.com")

    assert result["status"] == "ok"
    assert result["setup_policy_config"] == {
        "unknownSetupPolicy": "excludeFromSearch", "unknownSetupDefaultMinutes": 0, "version": 2,
    }
    assert any("set_unknown_setup_policy" in statement for statement, _ in cursor.executed)


def test_unknown_setup_policy_plant_default_minutes_accepts_zero(monkeypatch):
    """plantDefaultMinutes with 0 minutes is accepted (it behaves like zero; the panel hints at that)."""
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_plant_unknown_setup_policy("SN", "5512", "plantDefaultMinutes", 0)

    assert result["setup_policy_config"]["unknownSetupDefaultMinutes"] == 0
    assert result["setup_policy_config"]["unknownSetupPolicy"] == "plantDefaultMinutes"


def test_unknown_setup_policy_requires_a_plant():
    with pytest.raises(ValueError, match="plant is required"):
        md.set_plant_unknown_setup_policy("SN", "", "zero", 0)


# ── S4 caps (order-rules-hardening Phase 3) ──

@pytest.mark.parametrize("setter,column", [
    (md.set_plant_max_pull_forward_days, "max_pull_forward_days"),
    (md.set_plant_max_push_forward_days, "max_push_forward_days"),
])
def test_pull_and_push_limits_cap_at_365_days(monkeypatch, setter, column):
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    assert setter("SN", "5512", 365)["status"] == "ok"
    with pytest.raises(ValueError, match=column):
        setter("SN", "5512", 366)
    assert not any("set_" + column in statement for statement, _ in cursor.executed[2:])


def test_min_productive_segment_minutes_caps_at_1440(monkeypatch):
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    assert md.set_plant_min_productive_segment_minutes("SN", "5512", 1440)["status"] == "ok"
    with pytest.raises(ValueError, match="min_productive_segment_minutes"):
        md.set_plant_min_productive_segment_minutes("SN", "5512", 1441)


class _StoredMinutesCursor(_Cursor):
    def __init__(self, stored):
        super().__init__()
        self._stored = stored

    def fetchone(self):
        return (self._stored,)


def test_unknown_setup_minutes_over_cap_rejected_when_changed(monkeypatch):
    cursor = _StoredMinutesCursor("30")
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    with pytest.raises(ValueError, match="unknown_setup_default_minutes"):
        md.set_plant_unknown_setup_policy("SN", "5512", "plantDefaultMinutes", 1441)
    assert not any("UPDATE plants" in statement for statement, _ in cursor.executed)


def test_unknown_setup_minutes_at_cap_accepted_without_a_stored_read(monkeypatch):
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_plant_unknown_setup_policy("SN", "5512", "plantDefaultMinutes", 1440)

    assert result["setup_policy_config"]["unknownSetupDefaultMinutes"] == 1440


def test_legacy_over_cap_row_does_not_block_an_unrelated_policy_save(monkeypatch):
    """The stored value is already over the cap; re-sending it unchanged (a policy-only
    change) must succeed, while changing it to another over-cap value still fails."""
    cursor = _StoredMinutesCursor("5000")
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_plant_unknown_setup_policy("SN", "5512", "excludeFromSearch", 5000)

    assert result["setup_policy_config"]["unknownSetupDefaultMinutes"] == 5000
    assert any("UPDATE plants SET setup_policy_config" in statement for statement, _ in cursor.executed)
    with pytest.raises(ValueError, match="unknown_setup_default_minutes"):
        md.set_plant_unknown_setup_policy("SN", "5512", "excludeFromSearch", 6000)
