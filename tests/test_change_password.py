"""
Tests for self-service password change: auth.change_own_password and the
PATCH /security/me/password endpoint. Mirrors tests/test_user_names.py's
structure for the sibling PATCH /security/me (name) feature.
"""
from fastapi import HTTPException
import pytest

import backend.security.auth as auth

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
            auth.change_own_password(ZZ_USER_A, "wrong-pw", "new-pw-12")
        assert exc_info.value.status_code == 401
        # Password must be unchanged.
        assert auth.verify_user_password(ZZ_USER_A, "correct-pw")

    def test_correct_current_password_changes_it(self, pg):
        auth.set_user_password(ZZ_USER_A, "correct-pw")
        auth.change_own_password(ZZ_USER_A, "correct-pw", "new-pw-12")
        assert auth.verify_user_password(ZZ_USER_A, "new-pw-12")
        assert not auth.verify_user_password(ZZ_USER_A, "correct-pw")

    def test_new_password_too_short_rejected(self, pg):
        auth.set_user_password(ZZ_USER_A, "correct-pw")
        with pytest.raises(ValueError, match="at least 8 characters"):
            auth.change_own_password(ZZ_USER_A, "correct-pw", "abc")
        # Original password must still be usable.
        assert auth.verify_user_password(ZZ_USER_A, "correct-pw")

    def test_blank_actor_401s(self, pg):
        with pytest.raises(HTTPException) as exc_info:
            auth.change_own_password(None, "whatever", "new-pw-12")
        assert exc_info.value.status_code == 401

    def test_scoped_to_caller_only(self, pg):
        auth.set_user_password(ZZ_USER_A, "a-pw-1234")
        auth.set_user_password(ZZ_USER_B, "b-pw-1234")
        auth.change_own_password(ZZ_USER_A, "a-pw-1234", "a-new-pw-12")
        assert auth.verify_user_password(ZZ_USER_A, "a-new-pw-12")
        assert auth.verify_user_password(ZZ_USER_B, "b-pw-1234")


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
            json={"current_password": "wrong-pw", "new_password": "new-pw-12"},
            headers={"x-user-email": ZZ_USER_A},
        )
        assert resp.status_code == 401
        assert auth.verify_user_password(ZZ_USER_A, "correct-pw")

        # Correct current password -> 200, password actually changes.
        resp2 = client.patch(
            "/security/me/password",
            json={"current_password": "correct-pw", "new_password": "new-pw-12"},
            headers={"x-user-email": ZZ_USER_A},
        )
        assert resp2.status_code == 200
        assert auth.verify_user_password(ZZ_USER_A, "new-pw-12")

        # Too-short new password -> 400.
        resp3 = client.patch(
            "/security/me/password",
            json={"current_password": "new-pw-12", "new_password": "ab"},
            headers={"x-user-email": ZZ_USER_A},
        )
        assert resp3.status_code == 400
    finally:
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM user_security WHERE lower(username) = lower(%s)", (ZZ_USER_A,))
            conn.commit()


@pytest.mark.pg
class TestPasswordPolicyAndSettingsPg:
    @pytest.fixture(autouse=True)
    def _cleanup(self, pg):
        self.db = pg
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM user_settings WHERE lower(username) = lower(%s)", (ZZ_USER_A,))
            cur.execute("DELETE FROM user_security WHERE lower(username) IN (lower(%s), lower(%s))",
                        (ZZ_USER_A, "zztest_pw_ghost"))
            conn.commit()
        auth._login_failures.clear()

    def test_boundaries(self):
        auth.set_user_password(ZZ_USER_A, "correct-pw")
        with pytest.raises(ValueError):
            auth.change_own_password(ZZ_USER_A, "correct-pw", "a" * 7)
        with pytest.raises(ValueError, match="at most 256"):
            auth.change_own_password(ZZ_USER_A, "correct-pw", "a" * 257)
        with pytest.raises(ValueError, match="different"):
            auth.change_own_password(ZZ_USER_A, "correct-pw", "correct-pw")
        auth.change_own_password(ZZ_USER_A, "correct-pw", "a" * 8)
        auth.change_own_password(ZZ_USER_A, "a" * 8, "b" * 256)
        assert auth.verify_user_password(ZZ_USER_A, "b" * 256)

    def test_admin_reset_unknown_user_404_creates_nothing(self):
        with pytest.raises(HTTPException) as e:
            auth.set_user_password("zztest_pw_ghost", "long-enough-pw", must_exist=True)
        assert e.value.status_code == 404
        with self.db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT 1 FROM user_security WHERE lower(username)=lower(%s)", ("zztest_pw_ghost",))
            assert cur.fetchone() is None

    def test_deleted_user_is_not_recreated_by_change(self, monkeypatch):
        auth.set_user_password(ZZ_USER_A, "correct-pw")

        def verify_then_delete(u, p):
            with self.db._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM user_security WHERE lower(username)=lower(%s)", (u,))
                conn.commit()
            return True
        monkeypatch.setattr(auth, "verify_user_password", verify_then_delete)
        with pytest.raises(HTTPException) as e:
            auth.change_own_password(ZZ_USER_A, "correct-pw", "new-pw-1234")
        assert e.value.status_code == 401
        with self.db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT 1 FROM user_security WHERE lower(username)=lower(%s)", (ZZ_USER_A,))
            assert cur.fetchone() is None

    def test_endpoint_throttle_429_then_cleared(self, client):
        auth.set_user_password(ZZ_USER_A, "correct-pw")
        auth._login_failures.clear()
        h = {"x-user-email": ZZ_USER_A}
        for _ in range(8):
            r = client.patch("/security/me/password", headers=h,
                             json={"current_password": "nope", "new_password": "new-pw-1234"})
            assert r.status_code == 401
        r = client.patch("/security/me/password", headers=h,
                         json={"current_password": "correct-pw", "new_password": "new-pw-1234"})
        assert r.status_code == 429
        auth._login_failures.clear()
        r = client.patch("/security/me/password", headers=h,
                         json={"current_password": "correct-pw", "new_password": "new-pw-1234"})
        assert r.status_code == 200

    def test_settings_merge_semantics(self):
        auth.set_user_password(ZZ_USER_A, "correct-pw")
        r = auth.upsert_user_settings(ZZ_USER_A, {"theme": "dark", "gridLayout": {"a": 1, "b": 2},
                                                  "defaultPlant": "P1"})
        assert r["settings"] == {"theme": "dark", "gridLayout": {"a": 1, "b": 2}, "defaultPlant": "P1"}
        # overwrite, nested replaced wholesale, null deletes, nested null kept
        r = auth.upsert_user_settings(ZZ_USER_A, {"theme": "light", "gridLayout": {"c": None},
                                                  "defaultPlant": None})
        assert r["settings"] == {"theme": "light", "gridLayout": {"c": None}}
        # absent keys preserved
        r = auth.upsert_user_settings(ZZ_USER_A, {"language": "fr"})
        assert r["settings"] == {"theme": "light", "gridLayout": {"c": None}, "language": "fr"}
        # first-write INSERT omits null keys
        with self.db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM user_settings WHERE lower(username)=lower(%s)", (ZZ_USER_A,))
            conn.commit()
        r = auth.upsert_user_settings(ZZ_USER_A, {"theme": None, "language": "fr"})
        assert r["settings"] == {"language": "fr"}


def test_new_password_keys_present_in_all_locales():
    import os
    locales_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend", "locales")
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
