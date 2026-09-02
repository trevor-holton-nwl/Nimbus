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
    clause and must always be reachable in the success-path tests).

    bulk_apply batches its upsert loop via executemany(..., returning=True)
    (2026-09 perf pass, one call per resolved column-set group) instead of
    one execute() per row -- executemany()/fetchone()/nextset() here
    simulate the exact per-row result-set walk db.py's upsert_orders
    already established: each row in a group gets its own result set;
    fetchone() returns that row's outcome tuple, nextset() advances to the
    next row's set. `row_results`, when given, supplies one outcome tuple
    per row across ALL executemany() calls in call order (default: every
    row is `(True,)`, i.e. "inserted") -- lets a test control insert-vs-
    update per row for a mixed-outcome batch."""

    def __init__(self, raise_exc=None, row_results=None):
        self.executed = []        # plain execute() calls: (stmt, params)
        self.executed_many = []   # executemany() calls: (stmt, params_list)
        self.raise_exc = raise_exc
        self.rolled_back = False
        self._row_results = list(row_results) if row_results is not None else None
        self._pending = []
        self._idx = 0

    def execute(self, statement, params=None):
        stmt = str(statement)
        self.executed.append((stmt, params))
        if "ON CONFLICT" in stmt and self.raise_exc is not None:
            raise self.raise_exc

    def executemany(self, statement, params_list, returning=False):
        stmt = str(statement)
        self.executed_many.append((stmt, params_list))
        if "ON CONFLICT" in stmt and self.raise_exc is not None:
            raise self.raise_exc
        if self._row_results is not None:
            self._pending = [self._row_results.pop(0) for _ in params_list]
        else:
            self._pending = [(True,)] * len(params_list)
        self._idx = 0

    def fetchone(self):
        if self._idx < len(self._pending):
            return self._pending[self._idx]
        return None

    def nextset(self):
        self._idx += 1
        return self._idx < len(self._pending)

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
    """The single INSERT ... ON CONFLICT executemany() call bulk_apply issued
    for one column-set group's row upsert(s) (as opposed to the admin_audit
    insert, which is a plain execute() with no ON CONFLICT clause and has no
    entry here). Returns (stmt, params_list) -- params_list has one row per
    upsert sharing that group's column set (one row for every existing
    single-upsert test in this file)."""
    return next((s, p) for s, p in cursor.executed_many if "ON CONFLICT" in s)


def _single_row_params(cursor):
    """Convenience for the single-upsert-row tests below: the one row's bound
    params out of _upsert_call's params_list, asserting there's exactly one."""
    _, params_list = _upsert_call(cursor)
    assert len(params_list) == 1, f"expected exactly one batched row, got {len(params_list)}"
    return params_list[0]


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
    params = _single_row_params(cursor)
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

    params = _single_row_params(cursor)
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
    params = _single_row_params(cursor)
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
    params = _single_row_params(cursor)
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


# ---------------------------------------------------------------------------
# Batching coverage (2026-09 perf pass) — bulk_apply's upsert loop moved from
# one execute() per row to one executemany(..., returning=True) per resolved
# column-set group. The four tests above pin the pre-existing per-row
# behaviors (blank-cell coercion, error translation) still hold under the
# rewrite; these three pin the batching mechanics themselves.
# ---------------------------------------------------------------------------
def test_bulk_apply_batches_same_shape_rows_into_one_executemany_call(monkeypatch):
    """Two rows sharing one column set (the common case per _markDirty in
    admin-ui.mts — see master_data.py's own comment on the grouping loop)
    must reach the database as ONE executemany() call carrying both rows'
    params, not two separate calls."""
    monkeypatch.setattr(md, "_column_meta", lambda cur, table: _plants_column_meta())
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    md.bulk_apply(
        "plants",
        {"upserts": [
            {"subnetwork": "SN", "plant": "5512", "visibility_horizon_days": "30"},
            {"subnetwork": "SN", "plant": "5513", "visibility_horizon_days": "60"},
        ]},
    )

    _, params_list = _upsert_call(cursor)
    assert params_list == [["SN", "5512", "30"], ["SN", "5513", "60"]]


def test_bulk_apply_reports_a_mixed_insert_and_update_batch_correctly(monkeypatch):
    """(xmax = 0) per row distinguishes insert from update within one batched
    executemany() call — must not collapse to "all inserted" or "all
    updated" just because they were sent together."""
    monkeypatch.setattr(md, "_column_meta", lambda cur, table: _plants_column_meta())
    cursor = _Cursor(row_results=[(True,), (False,)])
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.bulk_apply(
        "plants",
        {"upserts": [
            {"subnetwork": "SN", "plant": "5512", "visibility_horizon_days": "30"},
            {"subnetwork": "SN", "plant": "5513", "visibility_horizon_days": "60"},
        ]},
    )

    assert result["inserted"] == 1
    assert result["updated"] == 1


def test_bulk_apply_splits_divergent_column_sets_into_separate_batches(monkeypatch):
    """Rows with different resolved column sets can't share one INSERT ...
    ON CONFLICT statement (the column list is baked into the SQL text) --
    each distinct shape must get its own executemany() call, and no row may
    be silently dropped because it didn't match the first row's shape."""
    monkeypatch.setattr(md, "_column_meta", lambda cur, table: _plants_column_meta())
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.bulk_apply(
        "plants",
        {"upserts": [
            {"subnetwork": "SN", "plant": "5512", "visibility_horizon_days": "30"},
            {"subnetwork": "SN", "plant": "5513", "horizon_roll_hour_utc": "20"},
        ]},
    )

    assert result["inserted"] + result["updated"] == 2
    upsert_calls = [(s, p) for s, p in cursor.executed_many if "ON CONFLICT" in s]
    assert len(upsert_calls) == 2, "divergent column-set rows must not share one executemany() call"
    all_params = [row for _, params_list in upsert_calls for row in params_list]
    assert ["SN", "5512", "30"] in all_params
    assert ["SN", "5513", "20"] in all_params


def test_bulk_apply_mid_batch_failure_still_rolls_back_the_whole_transaction(monkeypatch):
    """A failure anywhere in a multi-row batched executemany() call must
    still roll back everything applied so far in this bulk_apply call —
    same all-or-nothing atomicity as the pre-batching per-row execute()
    loop, not a new partial-commit behavior."""
    monkeypatch.setattr(md, "_column_meta", lambda cur, table: _plants_column_meta())
    exc = _pg_error(
        pg_errors.NotNullViolation,
        column="horizon_roll_hour_utc",
        message='null value in column "horizon_roll_hour_utc" violates not-null constraint',
    )
    cursor = _Cursor(raise_exc=exc)
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    with pytest.raises(ValueError):
        md.bulk_apply(
            "plants",
            {"upserts": [
                {"subnetwork": "SN", "plant": "5512", "visibility_horizon_days": "30"},
                {"subnetwork": "SN", "plant": "5513", "visibility_horizon_days": ""},
            ]},
        )

    assert cursor.rolled_back is True
    _, params_list = _upsert_call(cursor)
    assert len(params_list) == 2, "both rows must have been submitted in the one failing batch"
