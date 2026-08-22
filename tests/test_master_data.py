"""Regression coverage for master_data.bulk_apply's blank-cell handling.

The Manage Data Tables grid edits cells as contentEditable divs and POSTs raw
strings verbatim, regardless of the target column's type — a cleared cell
always arrives as "". These tests pin bulk_apply's translation of that blank
string for non-text columns (coerce to NULL, let Postgres decide whether that
succeeds or fails as a NOT NULL violation) and its translation of genuinely
bad text (e.g. "abc" into an INTEGER) into a readable ValueError, which
brain.py's `except ValueError` handler turns into an HTTP 400.

No live Postgres needed: `md._pool` and `md._column_meta` are monkeypatched
with fakes, mirroring the existing tests/test_master_data_setup_policy.py
convention. The psycopg exceptions raised by the fake cursor are real
`psycopg.errors` instances built with a hand-populated `info` diagnostics
dict (psycopg lets `Diagnostic` read from a plain dict, not just a live
libpq result), so bulk_apply's `exc.diag.*` reads behave exactly as they
would against a real connection.
"""
from contextlib import contextmanager

import pytest
from psycopg import errors as pg_errors
from psycopg.pq import DiagnosticField

import master_data as md


def _pg_error(cls, column=None, constraint=None, message=None):
    info = {}
    if message is not None:
        info[DiagnosticField.MESSAGE_PRIMARY] = message.encode()
    if column is not None:
        info[DiagnosticField.COLUMN_NAME] = column.encode()
    if constraint is not None:
        info[DiagnosticField.CONSTRAINT_NAME] = constraint.encode()
    return cls("boom", info=info)


def _plants_column_meta(extra=None):
    """Minimal column_metadata JOIN information_schema.columns shape for
    `plants`, covering the two key columns plus the two columns at the
    center of this fix: visibility_horizon_days (nullable INTEGER, NULL =
    "unlimited") and horizon_roll_hour_utc (NOT NULL INTEGER DEFAULT 19)."""
    columns = [
        {"column_name": "subnetwork", "display_label": "Subnetwork", "is_locked": True,
         "column_order": 1, "sql_type": "TEXT", "is_nullable": False, "column_default": None},
        {"column_name": "plant", "display_label": "Plant", "is_locked": True,
         "column_order": 2, "sql_type": "TEXT", "is_nullable": False, "column_default": None},
        {"column_name": "visibility_horizon_days", "display_label": "Visibility Horizon (days)",
         "is_locked": False, "column_order": 9, "sql_type": "INTEGER", "is_nullable": True,
         "column_default": None},
        {"column_name": "horizon_roll_hour_utc", "display_label": "Roll-Forward Hour (UTC)",
         "is_locked": False, "column_order": 10, "sql_type": "INTEGER", "is_nullable": False,
         "column_default": "19"},
    ]
    if extra:
        columns.extend(extra)
    return columns


class _Cursor:
    """Fake cursor: records every statement + bound params, optionally raises
    a canned psycopg exception on the upsert's INSERT ... ON CONFLICT
    statement (never on the admin_audit insert, which carries no ON CONFLICT
    clause and must always be reachable in the success-path tests)."""

    def __init__(self, raise_exc=None):
        self.executed = []
        self.raise_exc = raise_exc
        self.rolled_back = False

    def execute(self, statement, params=None):
        stmt = str(statement)
        self.executed.append((stmt, params))
        if "ON CONFLICT" in stmt and self.raise_exc is not None:
            raise self.raise_exc

    def fetchone(self):
        return (True,)

    def fetchall(self):
        return []


class _Connection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.committed = False

    @contextmanager
    def cursor(self):
        yield self._cursor

    def commit(self):
        self.committed = True

    def rollback(self):
        self._cursor.rolled_back = True


class _Pool:
    def __init__(self, cursor):
        self._cursor = cursor

    @contextmanager
    def connection(self):
        yield _Connection(self._cursor)


def _upsert_call(cursor):
    """The single INSERT ... ON CONFLICT statement bulk_apply issued for the
    row upsert (as opposed to the admin_audit insert, which has none)."""
    return next((s, p) for s, p in cursor.executed if "ON CONFLICT" in s)


def test_bulk_apply_coerces_blank_cell_to_null_for_nullable_integer_column(monkeypatch):
    """A cleared visibility_horizon_days cell POSTs "" — for this nullable
    INTEGER column (NULL means "unlimited") that must become NULL and the
    upsert must succeed, restoring the only remaining path to clear it now
    that the dedicated Scheduling Rules input is gone."""
    monkeypatch.setattr(md, "_column_meta", lambda cur, table: _plants_column_meta())
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.bulk_apply(
        "plants",
        {"upserts": [{"subnetwork": "SN", "plant": "5512", "visibility_horizon_days": ""}]},
    )

    assert result["inserted"] + result["updated"] == 1
    _, params = _upsert_call(cursor)
    assert params == ["SN", "5512", None]


def test_bulk_apply_keeps_blank_string_for_text_column(monkeypatch):
    """An empty string is a legitimate value for a TEXT column — it must NOT
    be coerced to NULL just because the cell round-tripped as ""."""
    monkeypatch.setattr(
        md, "_column_meta",
        lambda cur, table: _plants_column_meta(extra=[
            {"column_name": "description", "display_label": "Description", "is_locked": False,
             "column_order": 5, "sql_type": "TEXT", "is_nullable": True, "column_default": None},
        ]),
    )
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    md.bulk_apply(
        "plants",
        {"upserts": [{"subnetwork": "SN", "plant": "5512", "description": ""}]},
    )

    _, params = _upsert_call(cursor)
    assert params == ["SN", "5512", ""]


def test_bulk_apply_blank_cell_on_not_null_integer_column_raises_readable_error(monkeypatch):
    """plants.horizon_roll_hour_utc is NOT NULL DEFAULT 19 — a cleared cell
    must surface as a readable 400-shaped ValueError (naming the column),
    not silently persist NULL and not a bare opaque constraint dump. The
    blank->None coercion still runs (values below prove it), so Postgres is
    the one that rejects it, via NotNullViolation."""
    monkeypatch.setattr(md, "_column_meta", lambda cur, table: _plants_column_meta())
    exc = _pg_error(
        pg_errors.NotNullViolation,
        column="horizon_roll_hour_utc",
        message='null value in column "horizon_roll_hour_utc" violates not-null constraint',
    )
    cursor = _Cursor(raise_exc=exc)
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    with pytest.raises(ValueError) as excinfo:
        md.bulk_apply(
            "plants",
            {"upserts": [{"subnetwork": "SN", "plant": "5512", "horizon_roll_hour_utc": ""}]},
        )

    message = str(excinfo.value)
    assert "horizon_roll_hour_utc" in message
    assert "blank" in message
    assert cursor.rolled_back is True
    _, params = _upsert_call(cursor)
    assert params == ["SN", "5512", None]


def test_bulk_apply_non_numeric_text_into_integer_column_raises_readable_error(monkeypatch):
    """A mistyped, non-blank cell (e.g. "abc" into an INTEGER column) is a
    different failure than a cleared cell: InvalidTextRepresentation
    (SQLSTATE 22P02), not NotNullViolation — the blank->None coercion must
    never touch it since it isn't blank — and must also come back as a
    readable ValueError instead of an opaque 500."""
    monkeypatch.setattr(md, "_column_meta", lambda cur, table: _plants_column_meta())
    exc = _pg_error(
        pg_errors.InvalidTextRepresentation,
        message='invalid input syntax for type integer: "abc"',
    )
    cursor = _Cursor(raise_exc=exc)
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    with pytest.raises(ValueError) as excinfo:
        md.bulk_apply(
            "plants",
            {"upserts": [{"subnetwork": "SN", "plant": "5512", "visibility_horizon_days": "abc"}]},
        )

    message = str(excinfo.value)
    assert "abc" in message
    assert "integer" in message
    assert cursor.rolled_back is True
    _, params = _upsert_call(cursor)
    assert params == ["SN", "5512", "abc"]


def test_bulk_apply_check_violation_still_reports_the_offending_constraint(monkeypatch):
    """Pre-existing CheckViolation path (e.g. horizon_roll_hour_utc outside
    0..23) must keep naming the constraint — this fix must not regress it
    while adding InvalidTextRepresentation/NotNullViolation coverage."""
    monkeypatch.setattr(md, "_column_meta", lambda cur, table: _plants_column_meta())
    exc = _pg_error(
        pg_errors.CheckViolation,
        constraint="plants_horizon_roll_hour_utc_range",
        message='new row for relation "plants" violates check constraint "plants_horizon_roll_hour_utc_range"',
    )
    cursor = _Cursor(raise_exc=exc)
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    with pytest.raises(ValueError) as excinfo:
        md.bulk_apply(
            "plants",
            {"upserts": [{"subnetwork": "SN", "plant": "5512", "horizon_roll_hour_utc": "25"}]},
        )

    assert "plants_horizon_roll_hour_utc_range" in str(excinfo.value)
