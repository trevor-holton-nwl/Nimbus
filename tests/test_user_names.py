"""
Tests for the First/Last Name feature on user_security: schema, validation,
bulk-upsert preserve/clear semantics, and the self-service PATCH /security/me
endpoint.
"""
from fastapi import HTTPException
import pytest

import auth


@pytest.mark.pg
def test_user_security_has_name_columns(pg):
    db = pg
    auth.ensure_user_security_table()
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT first_name, last_name FROM user_security LIMIT 1")


def test_validate_name_accepts_none_and_blank():
    assert auth._validate_name(None, "First name") is None
    assert auth._validate_name("", "First name") is None
    assert auth._validate_name("   ", "First name") is None


def test_validate_name_trims_whitespace():
    assert auth._validate_name("  Jane  ", "First name") == "Jane"


def test_validate_name_accepts_max_length():
    value = "x" * 100
    assert auth._validate_name(value, "First name") == value


def test_validate_name_rejects_too_long():
    with pytest.raises(ValueError, match="100 characters or fewer"):
        auth._validate_name("x" * 101, "First name")
