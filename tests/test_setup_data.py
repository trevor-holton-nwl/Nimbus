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


def test_last_completed_order_excludes_future_planned_work_at_snapshot_time():
    """A pre-replacement snapshot must not treat a future planned order as physical state."""
    at = datetime(2026, 8, 13, 10, 0)
    rows = [
        {"id": "done", "completed_at": datetime(2026, 8, 13, 9, 58), "color": "RED"},
        {"id": "future", "completed_at": datetime(2026, 8, 13, 10, 1), "color": "BLUE"},
    ]
    assert setup_data.last_completed_order(rows, at)["id"] == "done"


def test_last_completed_order_returns_none_when_everything_is_future():
    """Failed replacement flows cannot advance state from future work."""
    at = datetime(2026, 8, 13, 10, 0)
    assert setup_data.last_completed_order(
        [{"id": "future", "completed_at": datetime(2026, 8, 13, 10, 1)}], at
    ) is None


def test_purge_captures_observation_before_deleting_source_schedule(monkeypatch):
    """A purge must preserve only a pre-mutation observation, never schedule-changing setup work."""
    import brain

    calls = []
    monkeypatch.setattr(brain.setup_data, "capture_setup_states_before_schedule_mutation",
                        lambda **kwargs: calls.append(("snapshot", kwargs)))
    monkeypatch.setattr(brain.db, "purge_orders_by_date",
                        lambda start, end: calls.append(("purge", start, end)) or {"status": "ok", "deleted": 1})
    result = brain.purge_orders({"start_date": "2026-08-01", "end_date": "2026-08-02"})
    assert result["deleted"] == 1
    assert [call[0] for call in calls] == ["snapshot", "purge"]


def test_upload_captures_observation_before_ingesting_replacement(monkeypatch):
    """The route's controlled snapshot happens before the threadpool ingest begins."""
    import brain

    calls = []
    monkeypatch.setattr(brain.setup_data, "capture_setup_states_before_schedule_mutation",
                        lambda **kwargs: calls.append(("snapshot", kwargs)))

    async def fake_threadpool(fn, *args):
        calls.append(("ingest", args))
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
    saved = setup_data.save_definition("5512", ["prt01", "colorWheel"], True, "owner@example.com")
    assert saved == {
        "plant": "5512", "fields": ["prt01", "colorWheel"], "signature_version": 3,
        "strict_blanks": True, "active": False,
    }
    statements = "\n".join(sql for sql, _params in cursor.executed)
    assert "UPDATE setup_definition" in statements
    assert "signature_version = %s" in statements
    assert "DELETE FROM setup_matrix" not in statements
    assert "UPDATE setup_matrix" not in statements


def test_capture_coordinator_uses_each_plants_local_capture_clock(monkeypatch):
    """A server-local timestamp must not be mislabeled as a plant-local snapshot."""
    cursor = _PairsCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    calls = []
    monkeypatch.setattr(setup_data, "derive_line_state_before_replacement",
                        lambda plant, line, **kwargs: calls.append((plant, line, kwargs)) or {})
    setup_data.capture_setup_states_before_schedule_mutation(actor="system", reason="purge")
    assert calls == [("5512", "LINE-1", {"actor": "system", "reason": "purge"})]


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


class _PairsCursor(_DefinitionCursor):
    def fetchall(self):
        return [("5512", "LINE-1")]


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
