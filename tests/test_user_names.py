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


ZZ_USER_A = "zztest_name_a"
ZZ_USER_B = "zztest_name_b"


@pytest.mark.pg
class TestGetUserProfile:
    @pytest.fixture(autouse=True)
    def _cleanup(self, pg):
        db = pg
        yield
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM user_security WHERE lower(username) = lower(%s)", (ZZ_USER_A,))
            conn.commit()

    def test_get_user_profile_returns_role_and_names(self, pg):
        db = pg
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO user_security (username, role, first_name, last_name) VALUES (%s, NULL, %s, %s)",
                (ZZ_USER_A, "Jane", "Smith"),
            )
            conn.commit()
        profile = auth.get_user_profile(ZZ_USER_A)
        assert profile == {"role": None, "first_name": "Jane", "last_name": "Smith"}

    def test_get_user_profile_unknown_user_returns_none(self, pg):
        assert auth.get_user_profile("zztest_does_not_exist") is None


@pytest.mark.pg
class TestBulkUpsertNames:
    @pytest.fixture(autouse=True)
    def _cleanup(self, pg):
        db = pg
        yield
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM user_security WHERE lower(username) = lower(%s)", (ZZ_USER_A,))
            conn.commit()

    def test_upsert_sets_name_fields(self, pg):
        auth.bulk_upsert_users(
            upserts=[{"username": ZZ_USER_A, "role": None, "first_name": "Jane", "last_name": "Smith"}],
            deletes=[],
        )
        result = auth.list_users(search=ZZ_USER_A)
        users = [u for u in result["users"] if u["username"].lower() == ZZ_USER_A.lower()]
        assert len(users) == 1
        assert users[0]["first_name"] == "Jane"
        assert users[0]["last_name"] == "Smith"

    def test_role_only_upsert_preserves_existing_names(self, pg):
        auth.bulk_upsert_users(
            upserts=[{"username": ZZ_USER_A, "role": None, "first_name": "Jane", "last_name": "Smith"}],
            deletes=[],
        )
        # Role-only change (no first_name/last_name keys at all) must not clobber the names —
        # this is exactly what _setUserRole sends today.
        auth.bulk_upsert_users(upserts=[{"username": ZZ_USER_A, "role": None}], deletes=[])
        result = auth.list_users(search=ZZ_USER_A)
        users = [u for u in result["users"] if u["username"].lower() == ZZ_USER_A.lower()]
        assert users[0]["first_name"] == "Jane"
        assert users[0]["last_name"] == "Smith"

    def test_upsert_can_clear_names_to_blank(self, pg):
        auth.bulk_upsert_users(
            upserts=[{"username": ZZ_USER_A, "role": None, "first_name": "Jane", "last_name": "Smith"}],
            deletes=[],
        )
        auth.bulk_upsert_users(
            upserts=[{"username": ZZ_USER_A, "role": None, "first_name": "", "last_name": ""}],
            deletes=[],
        )
        result = auth.list_users(search=ZZ_USER_A)
        users = [u for u in result["users"] if u["username"].lower() == ZZ_USER_A.lower()]
        assert users[0]["first_name"] is None
        assert users[0]["last_name"] is None

    def test_upsert_rejects_name_too_long(self, pg):
        with pytest.raises(ValueError, match="100 characters or fewer"):
            auth.bulk_upsert_users(
                upserts=[{"username": ZZ_USER_A, "role": None, "first_name": "x" * 101}],
                deletes=[],
            )
