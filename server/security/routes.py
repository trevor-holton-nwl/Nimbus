"""
NIMBUS 2.0 — security domain routes: login, self-service profile/password/
settings, and admin user CRUD. All logic lives in server/security/auth.py
(moved whole and internally untouched — see the Entra migration note there);
this file is purely the route layer.

P5 relocation: pure move from brain.py (lines 3418-3524 as verified against
the pre-split file), per docs/architecture/domain-refactor-plan.md §4. Route
paths and payload/response shapes are byte-identical to before.
"""
from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request

from server.security import auth
from server.security.auth import require_admin, require_api_key

router = APIRouter()


@router.post("/security/login")
def security_login(body: dict = Body(default={})):
    """Authenticate against user_security. Never exposes the hash."""
    result = auth.authenticate(body.get("username", ""), body.get("password", ""))
    if not result:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    return result


@router.get("/security/bootstrap-status")
def security_bootstrap_status():
    return {"admin_exists": auth.admin_exists()}


@router.get("/security/me")
def security_me(request: Request):
    """Live identity + effective admin status for the caller. Ungated on purpose
    (like /security/bootstrap-status): the frontend calls it to reconcile the
    role it cached at login against backend truth, so it must be reachable even
    when the caller is NOT an admin. Returns {username, role, is_admin,
    first_name, last_name, allowed_plants, settings, role_settings}; no secrets."""
    return auth.whoami(request)


@router.patch("/security/me")
def security_update_me(request: Request, body: dict = Body(default={})):
    """Self-service: update the CALLER's own first/last name only. Ungated
    (like GET /security/me) — identity comes from the header, and
    auth.update_own_name scopes the write to exactly that one row."""
    try:
        return auth.update_own_name(
            request.headers.get("x-user-email") or request.headers.get("X-User"),
            body.get("first_name"),
            body.get("last_name"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.patch("/security/me/settings")
def security_update_my_settings(request: Request, body: dict = Body(default={})):
    """Self-service: shallow-merge a PARTIAL settings patch into the CALLER's own
    user_settings blob. Ungated (like PATCH /security/me) — identity comes from
    the header, and auth.upsert_user_settings scopes the write to exactly that
    one row (resolving canonical username casing so header casing can't create a
    duplicate). Body: {settings: {...}}. Returns {username, settings} with the
    full merged blob. A blank/unknown actor -> 401; a non-dict settings -> 400."""
    try:
        return auth.upsert_user_settings(
            auth._actor_email(request),
            body.get("settings"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.patch("/security/me/password")
def security_change_my_password(request: Request, body: dict = Body(default={})):
    """Self-service: change the CALLER's own password. Requires the correct
    current password (see auth.change_own_password) since identity here comes
    from a client header, not a verified session token."""
    try:
        return auth.change_own_password(
            auth._actor_email(request),
            body.get("current_password", ""),
            body.get("new_password", ""),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/security/users", dependencies=[Depends(require_api_key), Depends(require_admin)])
def security_list_users(
        limit: int | None = Query(default=None, ge=1, le=100000,
            description="Max users to return. Omit for the full list."),
        offset: int | None = Query(default=None, ge=0,
            description="Rows to skip before returning (for paging)."),
        search: str | None = Query(default=None,
            description="Filter to usernames containing this substring.")):
    """List users (never includes password hashes)."""
    return auth.list_users(limit=limit, offset=offset, search=search)


@router.post("/security/users/bulk", dependencies=[Depends(require_api_key), Depends(require_admin)])
def security_bulk_users(request: Request, body: dict = Body(default={})):
    """Apply user upserts/deletes (username + role only — never touches passwords).
    Payload: { upserts: [{username, role}], deletes: [{username}] }"""
    try:
        return auth.bulk_upsert_users(
            upserts=body.get("upserts", []),
            deletes=body.get("deletes", []),
            user_email=request.headers.get("x-user-email") or request.headers.get("X-User"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/security/users/{username}/reset-password", dependencies=[Depends(require_api_key), Depends(require_admin)])
def security_reset_password(username: str, request: Request, body: dict = Body(default={})):
    """Set/replace a user's password. Hashed before storage; never retrievable afterward."""
    try:
        return auth.set_user_password(
            username, body.get("password", ""),
            user_email=request.headers.get("x-user-email") or request.headers.get("X-User"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
