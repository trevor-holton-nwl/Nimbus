"""
Pure-logic tests for db.translate_db_error — no database required, run
unconditionally.

These pin the SQLSTATE → {error_code, http_status, client_message} contract from
the error-log architecture spec §1.4 (the vocabulary is identical on both tiers,
so a drift here breaks frontend aggregation too). translate_db_error only reads
`exc.sqlstate` and `exc.diag.*` via getattr, so a lightweight fake psycopg.Error
exercises the real branching without a live connection.
"""
import psycopg

import db


class _FakeDiag:
    """Mimics psycopg's Diagnostic object — only the attrs translate_db_error reads."""
    def __init__(self, constraint_name=None, table_name=None, column_name=None,
                 message_detail=None, message_hint=None):
        self.constraint_name = constraint_name
        self.table_name = table_name
        self.column_name = column_name
        self.message_detail = message_detail
        self.message_hint = message_hint


class _FakeDbError(psycopg.Error):
    """A real psycopg.Error subclass with settable sqlstate/diag — the base
    class exposes them as read-only properties, so we shadow them here. Subclass
    (not a duck) so isinstance(e, psycopg.Error) stays True and the
    @api.exception_handler(psycopg.Error) wiring would also catch it."""
    def __init__(self, sqlstate=None, diag=None):
        self._fake_sqlstate = sqlstate
        self._fake_diag = diag

    @property
    def sqlstate(self):
        return self._fake_sqlstate

    @property
    def diag(self):
        return self._fake_diag


def _err(sqlstate, **diag):
    """A psycopg.Error carrying a sqlstate + diag built from the given diag kwargs."""
    return _FakeDbError(sqlstate=sqlstate, diag=_FakeDiag(**diag) if diag else None)


def test_unique_violation_23505():
    out = db.translate_db_error(_err("23505", constraint_name="plants_pkey"))
    assert out["error_code"] == "db.unique_violation"
    assert out["http_status"] == 409
    assert out["client_message"] == "Duplicate value violates constraint plants_pkey"
    assert out["constraint_name"] == "plants_pkey"


def test_unique_violation_23505_without_constraint_name():
    out = db.translate_db_error(_err("23505"))
    assert out["error_code"] == "db.unique_violation"
    assert out["http_status"] == 409
    assert out["client_message"] == "Duplicate value violates a unique constraint"


def test_fk_violation_23503():
    out = db.translate_db_error(_err("23503", table_name="material_plants"))
    assert out["error_code"] == "db.fk_violation"
    assert out["http_status"] == 409
    assert out["client_message"] == "Still referenced by rows in material_plants"
    assert out["table_name"] == "material_plants"


def test_not_null_23502():
    out = db.translate_db_error(_err("23502", column_name="plant"))
    assert out["error_code"] == "db.not_null"
    assert out["http_status"] == 400
    assert out["client_message"] == "Required field missing: plant"
    assert out["column_name"] == "plant"


def test_check_violation_23514():
    out = db.translate_db_error(_err("23514", constraint_name="orders_qty_chk"))
    assert out["error_code"] == "db.check_violation"
    assert out["http_status"] == 400
    assert out["client_message"] == "Value violates constraint orders_qty_chk"


def test_lock_timeout_57014():
    out = db.translate_db_error(_err("57014"))
    assert out["error_code"] == "db.lock_timeout"
    assert out["http_status"] == 503
    assert "timed out" in out["client_message"]


def test_serialization_failure_40001():
    out = db.translate_db_error(_err("40001"))
    assert out["error_code"] == "db.serialization_failure"
    assert out["http_status"] == 503
    assert "busy" in out["client_message"]


def test_deadlock_40P01():
    out = db.translate_db_error(_err("40P01"))
    assert out["error_code"] == "db.deadlock"
    assert out["http_status"] == 503
    assert "busy" in out["client_message"]


def test_generic_db_error_unknown_sqlstate():
    out = db.translate_db_error(_err("99999"))
    assert out["error_code"] == "db.error"
    assert out["http_status"] == 500
    assert out["client_message"] == "A database error occurred"


def test_generic_db_error_no_sqlstate_no_diag():
    """A bare psycopg.Error (no sqlstate, no diag) must not raise and falls back
    to db.error/500 with all diag fields None."""
    out = db.translate_db_error(psycopg.Error("opaque"))
    assert out["error_code"] == "db.error"
    assert out["http_status"] == 500
    assert out["sqlstate"] is None
    assert out["constraint_name"] is None
    assert out["table_name"] is None
    assert out["column_name"] is None


def test_diag_detail_and_hint_are_surfaced():
    out = db.translate_db_error(_err(
        "23505", constraint_name="plants_pkey",
        message_detail="Key (plant)=(5512) already exists.",
        message_hint="use a different plant code",
    ))
    assert out["detail"] == "Key (plant)=(5512) already exists."
    assert out["hint"] == "use a different plant code"


def test_client_message_never_leaks_raw_sql_or_paths():
    """Sanity guard for spec §1.5: client_message is constraint/column-name only."""
    for state in ("23505", "23503", "23502", "23514", "57014", "40001", "40P01", "99999"):
        msg = db.translate_db_error(_err(state, constraint_name="c", table_name="t",
                                         column_name="col"))["client_message"]
        assert "SELECT" not in msg.upper()
        assert "\\" not in msg and "/" not in msg
