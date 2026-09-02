"""
Response DTOs for backend/security/routes.py — added 2026-09 (Code_Review_09_01.md
§16 / "response_model= typing gaps") so this router stops emitting `unknown` into
frontend/types/api-generated.d.mts, mirroring the pattern already established by
backend/scheduling/models.py. auth.py itself stays untouched (frozen pending the
Entra migration, see backend/security/CLAUDE.md) -- these models only describe the
dict shapes its functions already return; they don't change auth.py's behavior.

Fields are typed against what each auth.py function's docstring/body actually
returns (verified by direct read, not inferred), with `| None` wherever the
underlying value can genuinely be null (e.g. a user with no first/last name on
file) -- response_model= enforces this at runtime, so an overly strict type here
would turn a legitimate null into a 500 ResponseValidationError.
"""
from typing import Any

from pydantic import BaseModel


class LoginResult(BaseModel):
    """auth.authenticate()'s success shape (POST /security/login).
    auth.py's authenticate() itself does not attach a "settings"/"role_settings"
    pair -- that's whoami()'s shape (WhoAmIResult), not this one."""
    username: str
    role: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    allowed_plants: list[str] | None = None


class WhoAmIResult(BaseModel):
    """auth.whoami()'s shape (GET /security/me)."""
    username: str | None = None
    role: str | None = None
    is_admin: bool
    first_name: str | None = None
    last_name: str | None = None
    allowed_plants: list[str] | None = None
    settings: dict[str, Any] = {}
    role_settings: dict[str, Any] = {}


class UpdateOwnNameResult(BaseModel):
    """auth.update_own_name()'s shape (PATCH /security/me)."""
    username: str
    role: str | None = None
    first_name: str | None = None
    last_name: str | None = None


class UpsertUserSettingsResult(BaseModel):
    """auth.upsert_user_settings()'s shape (PATCH /security/me/settings)."""
    username: str
    settings: dict[str, Any]


class OkResult(BaseModel):
    """auth.set_user_password()'s shape -- shared by PATCH /security/me/password
    (via change_own_password, which returns set_user_password's own result) and
    POST /security/users/{username}/reset-password."""
    ok: bool


class UserListEntry(BaseModel):
    """One row of auth.list_users()'s "users" list. last_login is left as `Any`
    (not `datetime`) since it comes straight off a psycopg cursor and this file
    doesn't otherwise touch datetime (de)serialization conventions -- avoids
    introducing a new one just for this field."""
    username: str
    role: str | None = None
    has_password: bool
    first_name: str | None = None
    last_name: str | None = None
    last_login: Any = None


class UserListMeta(BaseModel):
    total: int


class UserListResult(BaseModel):
    """auth.list_users()'s shape (GET /security/users)."""
    users: list[UserListEntry]
    meta: UserListMeta


class BulkUsersResult(BaseModel):
    """auth.bulk_upsert_users()'s shape (POST /security/users/bulk)."""
    inserted: int
    updated: int
    deleted: int
