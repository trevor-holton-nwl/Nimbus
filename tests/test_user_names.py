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
