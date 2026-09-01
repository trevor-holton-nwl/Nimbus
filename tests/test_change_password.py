"""
Tests for self-service password change: auth.change_own_password and the
PATCH /security/me/password endpoint. Mirrors tests/test_user_names.py's
structure for the sibling PATCH /security/me (name) feature.
"""
from fastapi import HTTPException
import pytest

import server.security.auth as auth

ZZ_USER_A = "zztest_pw_a"
ZZ_USER_B = "zztest_pw_b"


@pytest.mark.pg
class TestChangeOwnPassword:
    @pytest.fixture(autouse=True)
    def _cleanup(self, pg):
        db = pg
        yield
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "DELETE FROM user_security WHERE lower(username) IN (lower(%s), lower(%s))",
                (ZZ_USER_A, ZZ_USER_B),
            )
            conn.commit()

    def test_wrong_current_password_401s(self, pg):
        auth.set_user_password(ZZ_USER_A, "correct-pw")
        with pytest.raises(HTTPException) as exc_info:
            auth.change_own_password(ZZ_USER_A, "wrong-pw", "new-pw")
        assert exc_info.value.status_code == 401
        # Password must be unchanged.
        assert auth.verify_user_password(ZZ_USER_A, "correct-pw")

    def test_correct_current_password_changes_it(self, pg):
        auth.set_user_password(ZZ_USER_A, "correct-pw")
        auth.change_own_password(ZZ_USER_A, "correct-pw", "new-pw")
        assert auth.verify_user_password(ZZ_USER_A, "new-pw")
        assert not auth.verify_user_password(ZZ_USER_A, "correct-pw")

    def test_new_password_too_short_rejected(self, pg):
        auth.set_user_password(ZZ_USER_A, "correct-pw")
        with pytest.raises(ValueError, match="at least 4 characters"):
            auth.change_own_password(ZZ_USER_A, "correct-pw", "abc")
        # Original password must still be usable.
        assert auth.verify_user_password(ZZ_USER_A, "correct-pw")

    def test_blank_actor_401s(self, pg):
        with pytest.raises(HTTPException) as exc_info:
            auth.change_own_password(None, "whatever", "new-pw")
        assert exc_info.value.status_code == 401

    def test_scoped_to_caller_only(self, pg):
        auth.set_user_password(ZZ_USER_A, "a-pw")
        auth.set_user_password(ZZ_USER_B, "b-pw")
        auth.change_own_password(ZZ_USER_A, "a-pw", "a-new-pw")
        assert auth.verify_user_password(ZZ_USER_A, "a-new-pw")
        assert auth.verify_user_password(ZZ_USER_B, "b-pw")


@pytest.mark.pg
def test_patch_security_me_password_endpoint(client, pg):
    db = pg
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM user_security WHERE lower(username) = lower(%s)", (ZZ_USER_A,))
        conn.commit()
    auth.set_user_password(ZZ_USER_A, "correct-pw")
    try:
        # Wrong current password -> 401, password unchanged.
        resp = client.patch(
            "/security/me/password",
            json={"current_password": "wrong-pw", "new_password": "new-pw"},
            headers={"x-user-email": ZZ_USER_A},
        )
        assert resp.status_code == 401
        assert auth.verify_user_password(ZZ_USER_A, "correct-pw")

        # Correct current password -> 200, password actually changes.
        resp2 = client.patch(
            "/security/me/password",
            json={"current_password": "correct-pw", "new_password": "new-pw"},
            headers={"x-user-email": ZZ_USER_A},
        )
        assert resp2.status_code == 200
        assert auth.verify_user_password(ZZ_USER_A, "new-pw")

        # Too-short new password -> 400.
        resp3 = client.patch(
            "/security/me/password",
            json={"current_password": "new-pw", "new_password": "ab"},
            headers={"x-user-email": ZZ_USER_A},
        )
        assert resp3.status_code == 400
    finally:
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM user_security WHERE lower(username) = lower(%s)", (ZZ_USER_A,))
            conn.commit()


def test_new_password_keys_present_in_all_locales():
    import os
    locales_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", "locales")
    required = [
        "sec.change_password_title", "sec.current_password", "sec.new_password",
        "sec.confirm_password", "sec.update_password", "sec.password_mismatch",
        "sec.password_updated",
    ]
    for fname in ["en.js", "de.js", "es.js", "fr.js", "pt.js"]:
        path = os.path.join(locales_dir, fname)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        for key in required:
            assert f"'{key}'" in text, f"{fname} is missing i18n key {key}"
