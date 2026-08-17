"""Stage 0 setup-data contracts that do not require a PostgreSQL target."""
from datetime import datetime
from math import inf, nan
import asyncio

import pytest

import setup_data


def test_canonical_state_key_preserves_registered_definition_order_and_values():
    """A reordered signature must not silently identify the same transition."""
    assert setup_data.canonical_state_key(
        ["prt01", "colorWheel"], {"colorWheel": " Blue ", "prt01": 12}
    ) == [
        {"fieldKey": "prt01", "value": "12"},
        {"fieldKey": "colorWheel", "value": "Blue"},
    ]


def test_derived_order_state_values_are_scoped_to_the_setup_definition():
    """Pre-upload state capture must not submit registered fields the plant did not configure."""
    assert setup_data.derived_order_state_values(
        ["colorWheel", "prt01"], "Blue", "Tool-1", "Mold-2", "0007"
    ) == {"colorWheel": "Blue", "prt01": "Tool-1"}


@pytest.mark.parametrize("fields", [
    ["not_registered"],
    ["colorWheel", "colorWheel"],
])
def test_canonical_state_key_rejects_unknown_or_duplicate_fields(fields):
    """A malformed signature must not be persisted as a key another caller cannot resolve."""
    with pytest.raises(ValueError):
        setup_data.canonical_state_key(fields, {"colorWheel": "RED", "prt01": "M1"})


@pytest.mark.parametrize("value", [-1, 1.5, nan, inf, "4.2", True])
def test_validate_minutes_rejects_non_finite_or_non_integer_values(value):
    """Bad units must not reach the database's seven-day guard as an implicit conversion."""
    with pytest.raises(ValueError):
        setup_data.validate_setup_minutes(value)


def test_validate_minutes_accepts_integer_boundary_and_rejects_more_than_seven_days():
    """The documented upper bound prevents accidental unbounded setup durations."""
    assert setup_data.validate_setup_minutes("10080") == 10080
    with pytest.raises(ValueError):
        setup_data.validate_setup_minutes(10081)


def test_validate_override_minutes_accepts_unbounded_nonnegative_integer():
    """A long-running physical override must not be limited by the matrix's seven-day standard cap."""
    assert setup_data.validate_override_minutes(100_081) == 100_081


@pytest.mark.parametrize("value", [-1, 1.5, nan, inf, "4.2", True])
def test_validate_override_minutes_rejects_non_finite_or_non_integer_values(value):
    """Only finite, whole, nonnegative override duration is meaningful operational truth."""
    with pytest.raises(ValueError):
        setup_data.validate_override_minutes(value)


def test_validate_matrix_rows_rejects_duplicate_canonical_transition():
    """Two spellings of one canonical transition must not make import order decide the duration."""
    fields = ["colorWheel"]
    duplicate_rows = [
        {"from": {"colorWheel": "RED"}, "to": {"colorWheel": "BLUE"}, "setup_min": 10},
        {"from": {"colorWheel": " RED "}, "to": {"colorWheel": "BLUE"}, "setup_min": 15},
    ]
    with pytest.raises(ValueError, match="Duplicate"):
        setup_data.validate_matrix_rows(fields, duplicate_rows)


def test_validate_signature_version_rejects_stale_write():
    """An old editor cannot write rows that look current after a definition change."""
    with pytest.raises(ValueError, match="signature version"):
        setup_data.validate_signature_version(3, 2)


def test_should_replace_derived_state_never_overwrites_newer_manual_or_actual_state():
    """A delayed replacement snapshot cannot erase a more trusted floor confirmation."""
    captured = datetime(2026, 8, 13, 10, 0)
    newer_manual = {"observed_at": datetime(2026, 8, 13, 10, 1), "source": "manual"}
    older_actual = {"observed_at": datetime(2026, 8, 13, 9, 59), "source": "actual"}
    assert not setup_data.should_replace_line_state(newer_manual, captured, "derived")
    assert not setup_data.should_replace_line_state(older_actual, captured, "derived")


def test_manual_line_state_requires_a_nonblank_reason_before_database_access(monkeypatch):
    """An unauditable manual floor assertion must be rejected before it can be persisted."""
    monkeypatch.setattr(setup_data, "_pool", _FailPool())
    with pytest.raises(ValueError, match="reason"):
        setup_data.set_line_state("5512", "LINE-1", {"colorWheel": "RED"}, 1,
                                  datetime(2026, 8, 13, 10), "manual", " ", "owner@example.com")


def test_override_requires_a_nonblank_reason_before_database_access(monkeypatch):
    """A remaining-duration override is physical truth and must retain its explanation."""
    monkeypatch.setattr(setup_data, "_pool", _FailPool())
    with pytest.raises(ValueError, match="reason"):
        setup_data.upsert_occurrence_override(
            "5512", "LINE-1", "before", "after", {"colorWheel": "RED"},
            {"colorWheel": "BLUE"}, 12, 100_081, 1, "", "owner@example.com"
        )


def test_initial_override_preserves_an_explicit_null_predecessor(monkeypatch):
    """The first setup transition is bound to no prior order, not to an empty id."""
    cursor = _InitialOverrideCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    result = setup_data.upsert_occurrence_override(
        "5512", "LINE-1", None, "after", {"colorWheel": "GREEN"},
        {"colorWheel": "BLUE"}, 12, 4, 1, "initial floor state", "owner@example.com"
    )
    assert result["id"] == 42
    update_sql, _ = cursor.executed[-2]
    insert_sql, insert_params = cursor.executed[-1]
    assert "IS NOT DISTINCT FROM %s" in update_sql
    assert "predecessor_order_id" in insert_sql
    assert insert_params[3] is None


def test_clear_override_requires_nonblank_reason_before_database_access(monkeypatch):
    """Clearing physical setup truth must retain an auditable explanation too."""
    monkeypatch.setattr(setup_data, "_pool", _FailPool())
    with pytest.raises(ValueError, match="reason"):
        setup_data.clear_occurrence_override("5512", "LINE-1", 7, 1, "owner@example.com", " ")


def test_clear_override_persists_its_reason(monkeypatch):
    """A valid clear records why the remaining-duration override stopped applying."""
    cursor = _ClearCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    result = setup_data.clear_occurrence_override(
        "5512", "LINE-1", 7, 1, "owner@example.com", "completed on floor"
    )
    assert result == {"id": 7, "plant": "5512", "line": "LINE-1", "cleared": True,
                      "signature_version": 1}
    update_sql, update_params = cursor.executed[-1]
    assert "reason = %s" in update_sql
    assert update_params == ("completed on floor", "owner@example.com", 7, "5512", "LINE-1")


def test_public_line_matrix_write_rejects_line_outside_plant(monkeypatch):
    """Sparse line setup values cannot be written under a plant that does not own the line."""
    monkeypatch.setattr(setup_data, "_pool", _Pool(_MissingLineCursor()))
    with pytest.raises(ValueError, match="does not belong"):
        setup_data.upsert_line_matrix_rows(
            "5512", "OTHER-PLANT-LINE", [], 1, "owner@example.com"
        )


def test_last_completed_order_excludes_future_planned_work_at_snapshot_time():
    """A pre-replacement snapshot must not treat a future planned order as physical state."""
    at = datetime(2026, 8, 13, 10, 0)
    rows = [
        {"id": "done", "completed_at": datetime(2026, 8, 13, 9, 58), "color": "RED"},
        {"id": "future", "completed_at": datetime(2026, 8, 13, 10, 1), "color": "BLUE"},
    ]
    assert setup_data.last_completed_order(rows, at)["id"] == "done"


def test_failed_ingest_or_purge_snapshot_cannot_advance_from_future_work():
    """Even when the following mutation fails, a snapshot cannot use future planned work."""
    at = datetime(2026, 8, 13, 10, 0)
    assert setup_data.last_completed_order(
        [{"id": "future", "completed_at": datetime(2026, 8, 13, 10, 1)}], at
    ) is None


def test_purge_captures_observation_before_deleting_source_schedule_with_actor(monkeypatch):
    """A purge must preserve only a pre-mutation observation, never schedule-changing setup work."""
    import brain

    calls = []
    monkeypatch.setattr(brain.setup_data, "capture_setup_states_before_schedule_mutation",
                        lambda **kwargs: calls.append(("snapshot", kwargs)))
    monkeypatch.setattr(brain.db, "purge_orders_by_date",
                        lambda start, end: calls.append(("purge", start, end)) or {"status": "ok", "deleted": 1})
    request = type("Request", (), {"headers": {"x-user-email": "scheduler@example.com"}})()
    result = brain.purge_orders({"start_date": "2026-08-01", "end_date": "2026-08-02"}, request)
    assert result["deleted"] == 1
    assert [call[0] for call in calls] == ["snapshot", "purge"]
    assert calls[0][1]["actor"] == "scheduler@example.com"


def test_upload_captures_observation_before_ingesting_replacement(monkeypatch):
    """The route's controlled snapshot happens before the threadpool ingest begins."""
    import brain

    calls = []
    monkeypatch.setattr(brain.setup_data, "capture_setup_states_before_schedule_mutation",
                        lambda **kwargs: calls.append(("snapshot", kwargs)))

    async def fake_threadpool(fn, *args, **kwargs):
        calls.append(("snapshot" if fn is brain.setup_data.capture_setup_states_before_schedule_mutation else "ingest", args, kwargs))
        if fn is brain.setup_data.capture_setup_states_before_schedule_mutation:
            return None
        return {"status": "ok", "inserted": 1, "updated": 0, "raw_row_count": 1,
                "warnings": [], "lines": []}

    monkeypatch.setattr(brain, "run_in_threadpool", fake_threadpool)
    monkeypatch.setattr(brain.md, "known_plant_line_codes", lambda: {"lines": set()})
    request = type("Request", (), {
        "headers": {"x-user-email": "scheduler@example.com"},
        "state": type("State", (), {})(),
    })()
    upload = type("Upload", (), {"filename": "orders.xlsx", "read": lambda self: _async_bytes(b"xlsx")})()
    result = asyncio.run(brain.upload_orders(request, upload))
    assert result["inserted"] == 1
    assert [call[0] for call in calls] == ["snapshot", "ingest"]
    assert calls[0][2] == {"actor": "scheduler@example.com", "reason": "Excel upload replacement"}


async def _async_bytes(value):
    return value


def test_sap_sync_captures_observation_before_upserting_orders(monkeypatch):
    """SAP replacement shares the exact controlled snapshot boundary as Excel ingest."""
    import sap_sync

    calls = []
    monkeypatch.setattr(sap_sync.setup_data, "capture_setup_states_before_schedule_mutation",
                        lambda **kwargs: calls.append(("snapshot", kwargs)))
    monkeypatch.setattr(sap_sync, "get_config", lambda _: {"transport": "file_drop", "last_watermark": None})
    monkeypatch.setattr(sap_sync, "_run_start", lambda *args: 1)
    monkeypatch.setattr(sap_sync, "_run_finish", lambda *args, **kwargs: None)
    monkeypatch.setattr(sap_sync, "map_records", lambda _key, records: records)
    monkeypatch.setattr(sap_sync, "make_connector", lambda *_: type(
        "Connector", (), {"extract": lambda self, *_args, **_kwargs: [{"id": "order-1"}]}
    )())
    monkeypatch.setattr(sap_sync.db, "upsert_orders", lambda *args, **kwargs: calls.append(("upsert", args)) or {
        "inserted": 1, "updated": 0, "failed": 0
    })
    result = sap_sync.sync_object("orders", user_email="scheduler@example.com")
    assert result["status"] == "ok"
    assert [call[0] for call in calls] == ["snapshot", "upsert"]


def test_definition_edit_versions_and_deactivates_without_rewriting_prior_matrix_keys(monkeypatch):
    """Changing a signature invalidates old keys instead of corrupting their historical meaning."""
    cursor = _DefinitionCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    saved = setup_data.save_definition(
        "5512", ["prt01", "colorWheel"], True, "owner@example.com", expected_signature_version=2
    )
    assert saved == {
        "plant": "5512", "fields": ["prt01", "colorWheel"], "signature_version": 3,
        "strict_blanks": True, "active": False,
    }
    statements = "\n".join(sql for sql, _params in cursor.executed)
    assert "UPDATE setup_definition" in statements
    assert "signature_version = %s" in statements
    assert "DELETE FROM setup_matrix" not in statements
    assert "UPDATE setup_matrix" not in statements


def test_set_definition_active_toggles_without_touching_fields(monkeypatch):
    """The single 'Include Setup Times in Optimizer' checkbox flips one column only."""
    cursor = _DefinitionCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    result = setup_data.set_definition_active("5512", True, "owner@example.com", expected_signature_version=2)
    assert result == {
        "plant": "5512", "fields": ["colorWheel"], "signature_version": 2,
        "strict_blanks": True, "active": True,
    }
    statements = "\n".join(sql for sql, _params in cursor.executed)
    assert "UPDATE setup_definition" in statements
    assert "SET active = %s" in statements


def test_set_definition_active_rejects_stale_signature_version(monkeypatch):
    cursor = _DefinitionCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    with pytest.raises(ValueError, match="signature version"):
        setup_data.set_definition_active("5512", True, "owner@example.com", expected_signature_version=1)


def test_snapshot_reads_only_one_current_signature_version_in_a_repeatable_transaction(monkeypatch):
    """A setup hydration never combines historical rows with a newer definition's effective truth."""
    cursor = _SnapshotCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    snapshot = setup_data.get_setup_snapshot("5512")
    assert snapshot["definition"]["signature_version"] == 4
    assert snapshot["plant_rows"][0]["signature_version"] == 4
    assert snapshot["line_states"][0]["signature_version"] == 4
    assert snapshot["overrides"][0]["signature_version"] == 4
    statements = "\n".join(sql for sql, _params in cursor.executed)
    assert "REPEATABLE READ READ ONLY" in statements
    assert statements.count("signature_version = %s") >= 3
    assert "status IN ('active', 'inactive')" in statements


def test_identified_override_update_rejects_cleared_history_before_writing(monkeypatch):
    """A URL-bound override update cannot resurrect or alter cleared/replaced historical truth."""
    cursor = _InactiveOverrideCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    with pytest.raises(ValueError, match="not active"):
        setup_data.update_occurrence_override(
            "5512", "LINE-1", 7, 12, 4, 1, "confirmed work", "owner@example.com"
        )
    assert not any("UPDATE setup_occurrence_override" in sql for sql, _params in cursor.executed)


def test_capture_coordinator_forwards_one_plant_local_timestamp_to_every_line(monkeypatch):
    """A plant replacement snapshot is one instant shared by every line at that plant."""
    cursor = _PairsCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    calls = []
    monkeypatch.setattr(setup_data, "derive_line_state_before_replacement",
                        lambda plant, line, **kwargs: calls.append((plant, line, kwargs)) or {})
    setup_data.capture_setup_states_before_schedule_mutation(actor="system", reason="purge")
    assert [(plant, line) for plant, line, _kwargs in calls] == [("5512", "LINE-1"), ("5512", "LINE-2")]
    first_capture = calls[0][2]["captured_at"]
    assert first_capture == calls[1][2]["captured_at"]
    assert first_capture.tzinfo is None
    assert all(kwargs["actor"] == "system" and kwargs["reason"] == "purge" for _, _, kwargs in calls)
    query, _params = cursor.executed[0]
    assert "JOIN production_lines" in query


class _DefinitionCursor:
    def __init__(self):
        self.executed = []
        self.rowcount = 0

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, sql, params=()):
        self.executed.append((sql, params))

    def fetchone(self):
        return (["colorWheel"], 2, True, True)


class _InitialOverrideCursor(_DefinitionCursor):
    def fetchone(self):
        query = self.executed[-1][0]
        if "SELECT 1 FROM production_lines" in query:
            return (1,)
        if "SELECT fields" in query:
            return (["colorWheel"], 1, True, True)
        if "RETURNING id" in query:
            return (42,)
        return None


class _PairsCursor(_DefinitionCursor):
    def fetchall(self):
        return [("5512", "America/New_York", "LINE-1"), ("5512", "America/New_York", "LINE-2")]


class _SnapshotCursor(_DefinitionCursor):
    def fetchone(self):
        if "SELECT fields" in self.executed[-1][0]:
            return (["colorWheel"], 4, True, False)
        return None

    def fetchall(self):
        query = self.executed[-1][0]
        if "FROM setup_matrix" in query:
            return [("", 4, [], [], 12, "manual", {}, None, "owner", None, "owner", None)]
        if "FROM line_setup_state" in query:
            return [("LINE-1", [], 4, None, None, "manual", "floor", "owner", None, "owner", None)]
        if "FROM setup_occurrence_override" in query:
            return [(9, "LINE-1", 4, "before", "after", [], [], 12, 4, "active", "floor", "owner", None,
                     "owner", None)]
        return []


class _InactiveOverrideCursor(_DefinitionCursor):
    def fetchone(self):
        query = self.executed[-1][0]
        if "SELECT 1 FROM production_lines" in query:
            return (1,)
        if "SELECT fields" in query:
            return (["colorWheel"], 1, True, False)
        if "SELECT signature_version, status FROM setup_occurrence_override" in query:
            return (1, "cleared")
        return None


class _MissingLineCursor(_DefinitionCursor):
    def fetchone(self):
        return None


class _ClearCursor(_DefinitionCursor):
    def fetchone(self):
        query = self.executed[-1][0]
        if "SELECT fields" in query:
            return (["colorWheel"], 1, True, True)
        return (1,)

    def execute(self, sql, params=()):
        super().execute(sql, params)
        if "UPDATE setup_occurrence_override" in sql:
            self.rowcount = 1


class _FailPool:
    def connection(self):
        raise AssertionError("validation should reject before opening a database connection")


class _Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def cursor(self):
        return self._cursor

    def commit(self):
        return None


class _Pool:
    def __init__(self, cursor):
        self._cursor = cursor

    def connection(self):
        return _Connection(self._cursor)
