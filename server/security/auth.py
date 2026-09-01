"""
NIMBUS 2.0 — Security layer (user credentials + password hashing).

Owns the `user_security` table (username -> password hash + role) and the
password hashing/verification helpers. Role and role_plants admin CRUD goes
through the existing generic master_data.py grid machinery (ALLOWED_TABLES);
this module owns only what that generic grid must never touch: password
hashes.

Passwords are hashed with PBKDF2-HMAC-SHA256 (stdlib hashlib) — no new pip
dependency. The plaintext password and its hash are never logged, returned
to a caller, or written to admin_audit.
"""
import base64
import hashlib
import hmac
import logging
import os
import secrets

import psycopg
from fastapi import Header, HTTPException, Request
from psycopg.types.json import Jsonb

# Import the shared pool from the existing db module (same idiom as master_data.py).
from db import _pool

log = logging.getLogger("nimbus.auth")

# PBKDF2-HMAC-SHA256 iteration count (current OWASP-recommended floor).
PBKDF2_ITERATIONS = 600_000


# =========================
# SCHEMA
# =========================
def ensure_user_security_table() -> None:
    """Idempotent: create the user_security table if missing (mirrors
    schema.sql / the shared roles+role_plants+user_security migration). Lets
    the app self-bootstrap even before the migration is applied, matching
    db.ensure_color_wheel_table()'s pattern. Must run AFTER roles exists —
    user_security.role FKs to roles(role). Also self-bootstraps the optional
    first_name/last_name columns (added 2026-07-08) and the last_login audit
    column (added 2026-08-03) the same way."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS user_security (
                username      TEXT PRIMARY KEY,
                password_hash TEXT,
                role          TEXT REFERENCES roles(role) ON DELETE RESTRICT ON UPDATE CASCADE,
                created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        cur.execute("ALTER TABLE user_security ADD COLUMN IF NOT EXISTS first_name TEXT")
        cur.execute("ALTER TABLE user_security ADD COLUMN IF NOT EXISTS last_name TEXT")
        cur.execute("ALTER TABLE user_security ADD COLUMN IF NOT EXISTS last_login TIMESTAMP")
        conn.commit()

    # Case-insensitive uniqueness on username. The PK stays case-sensitive
    # (preserving display case like 'PJ29587'), but every lookup — login and
    # require_admin — matches on lower(username), and the user upserts
    # (bulk_upsert_users / set_user_password) infer their ON CONFLICT target from
    # THIS index, so it must exist for those WRITES to work. Created in its own
    # transaction and best-effort: the only way it can fail is pre-existing rows
    # that already collide case-insensitively (e.g. both 'PJ29587' AND 'pj29587'),
    # and a live pilot must not fail to boot over that. On failure, reads/auth
    # still work (they don't need the index) — only user-management writes do — so
    # an admin can sign in, collapse the duplicates, then apply
    # migrations/2026-07-08-username-ci-index.sql. IF NOT EXISTS keeps it idempotent.
    try:
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_user_security_lower_username"
                " ON user_security (lower(username))"
            )
            conn.commit()
    except Exception as e:
        log.warning(
            "Could not create ux_user_security_lower_username (likely case-duplicate "
            "usernames); reads work but user upserts will fail until collapsed: %s", e
        )


def ensure_user_settings_table() -> None:
    """Idempotent: create the user_settings table if missing (mirrors schema.sql /
    migrations/2026-07-09-user-settings.sql). Lets the app self-bootstrap even
    before the migration is applied, matching ensure_user_security_table() and
    db.ensure_color_wheel_table(). Must run AFTER user_security exists —
    user_settings.username FKs to user_security(username)."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS user_settings (
                username   TEXT PRIMARY KEY REFERENCES user_security(username) ON DELETE CASCADE ON UPDATE CASCADE,
                settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
                updated_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
        """)
        conn.commit()


def ensure_role_settings_column() -> None:
    """Idempotent: add the roles.settings JSONB column if missing (mirrors
    schema.sql / migrations/2026-07-09-user-settings.sql). Holds per-role DEFAULT
    settings, shallow-merged UNDER each user's own blob by the frontend. Must run
    AFTER roles exists (md.ensure_roles_table())."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "ALTER TABLE roles ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb"
        )
        conn.commit()


# =========================
# PASSWORD HASHING
# =========================
def _hash_password(raw: str) -> str:
    """Hash a plaintext password with PBKDF2-HMAC-SHA256. Self-describing
    format so a future algorithm/iteration change doesn't break verifying
    hashes already on disk: 'pbkdf2_sha256$<iterations>$<b64 salt>$<b64 derived key>'."""
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac('sha256', raw.encode('utf-8'), salt, PBKDF2_ITERATIONS)
    salt_b64 = base64.b64encode(salt).decode()
    dk_b64 = base64.b64encode(dk).decode()
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt_b64}${dk_b64}"


def _verify_password(raw: str, stored: str | None) -> bool:
    """Verify a plaintext password against a stored `_hash_password` hash.
    Never raises — any None/empty/malformed `stored` value verifies False."""
    if not stored:
        return False
    try:
        algo, iters, salt_b64, hash_b64 = stored.split('$')
        if algo != 'pbkdf2_sha256':
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        dk = hashlib.pbkdf2_hmac('sha256', raw.encode('utf-8'), salt, int(iters))
        return hmac.compare_digest(dk, expected)
    except Exception:
        return False


_MAX_NAME_LENGTH = 100


def _validate_name(value: str | None, label: str) -> str | None:
    """Validate an optional first/last name: the only rule is a max length —
    names are optional everywhere, so None/blank always passes and normalizes
    to None (never an empty string) for storage."""
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    if len(value) > _MAX_NAME_LENGTH:
        raise ValueError(f"{label} must be {_MAX_NAME_LENGTH} characters or fewer")
    return value


# =========================
# USERS — list / bulk upsert+delete / password set + verify
# =========================
def list_users(limit: int | None = None, offset: int | None = None,
               search: str | None = None) -> dict:
    """List users — username, role, and whether a password is set. NEVER
    selects or returns password_hash itself. Mirrors master_data.list_rows's
    paging/count shape, but with plain %s placeholders (table/column names
    here are fixed literals, so psycopg.sql.Identifier isn't needed)."""
    where_sql = ""
    where_params: list = []
    if search:
        where_sql = " WHERE username ILIKE %s"
        where_params = [f"%{search}%"]

    query = (
        "SELECT username, role, (password_hash IS NOT NULL) AS has_password, first_name, last_name, last_login "
        "FROM user_security" + where_sql + " ORDER BY username"
    )
    params = list(where_params)
    if limit is not None:
        query += " LIMIT %s"
        params.append(int(limit))
    if offset:
        query += " OFFSET %s"
        params.append(int(offset))

    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(query, params)
        users = [
            {"username": r[0], "role": r[1], "has_password": bool(r[2]),
             "first_name": r[3], "last_name": r[4], "last_login": r[5]}
            for r in cur.fetchall()
        ]

        # A separate COUNT is only needed when a page window is applied;
        # otherwise `users` already holds the whole filtered set.
        if limit is not None or offset:
            cur.execute(
                "SELECT COUNT(*) FROM user_security" + where_sql,
                where_params,
            )
            total = int(cur.fetchone()[0])
        else:
            total = len(users)

    return {"users": users, "meta": {"total": total}}


def bulk_upsert_users(upserts: list[dict], deletes: list[dict],
                      user_email: str | None = None) -> dict:
    """Apply user upserts (username + role, optionally first_name/last_name)
    and deletes in one transaction. NEVER writes password_hash —
    set_user_password owns that. A row that omits first_name/last_name
    leaves those columns untouched (role keeps its existing unconditional-
    overwrite behavior — every existing caller always sends it explicitly).
    Mirrors master_data.bulk_apply's inserted/updated counting (via
    `RETURNING (xmax = 0)`) and its admin_audit insert, written here with
    table_name='user_security'."""
    inserted = updated = deleted = 0

    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM user_security WHERE role = 'admin'")
        admins_before = cur.fetchone()[0]

        for row in upserts:
            username = (row.get("username") or "").strip()
            if not username:
                raise ValueError("Username is required")
            has_first = "first_name" in row
            has_last = "last_name" in row
            first_name = _validate_name(row.get("first_name"), "First name") if has_first else None
            last_name = _validate_name(row.get("last_name"), "Last name") if has_last else None
            try:
                cur.execute(
                    "INSERT INTO user_security (username, role, first_name, last_name) VALUES (%s, %s, %s, %s)"
                    " ON CONFLICT (lower(username)) DO UPDATE SET"
                    "   role = EXCLUDED.role,"
                    "   first_name = CASE WHEN %s THEN EXCLUDED.first_name ELSE user_security.first_name END,"
                    "   last_name = CASE WHEN %s THEN EXCLUDED.last_name ELSE user_security.last_name END,"
                    "   updated_at = NOW()"
                    " RETURNING (xmax = 0)",
                    (username, row.get("role"), first_name, last_name, has_first, has_last),
                )
            except psycopg.errors.ForeignKeyViolation as exc:
                conn.rollback()
                raise ValueError(f"Role {row.get('role')!r} does not exist") from exc
            row_result = cur.fetchone()
            if row_result and row_result[0]:
                inserted += 1
            else:
                updated += 1

        for d in deletes:
            cur.execute(
                "DELETE FROM user_security WHERE lower(username) = lower(%s)",
                (d.get("username"),),
            )
            deleted += cur.rowcount

        # Guard against locking everyone out: block this batch (role changes AND
        # deletes both count) if it would leave zero admin users where at least
        # one existed before. Checked after mutating so a role-change-away and a
        # delete both trip it, but before commit so it's fully reversible.
        if admins_before > 0:
            cur.execute("SELECT COUNT(*) FROM user_security WHERE role = 'admin'")
            if cur.fetchone()[0] == 0:
                conn.rollback()
                raise ValueError("This would remove the last remaining admin user — refused")

        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES (%s, %s, %s, %s)",
            (
                "user_security",
                "bulk_upsert_users",
                Jsonb({"inserted": inserted, "updated": updated, "deleted": deleted}),
                user_email,
            ),
        )
        conn.commit()

    return {"inserted": inserted, "updated": updated, "deleted": deleted}


def set_user_password(username: str, raw_password: str,
                      user_email: str | None = None) -> dict:
    """Set/replace a user's password. Hashed before storage; the plaintext
    password and its hash are never written to admin_audit or returned."""
    username = (username or "").strip()
    if not username:
        raise ValueError("Username is required")
    if not raw_password or len(raw_password) < 4:
        raise ValueError("Password must be at least 4 characters")

    password_hash = _hash_password(raw_password)

    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO user_security (username, password_hash) VALUES (%s, %s)"
            " ON CONFLICT (lower(username)) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()",
            (username, password_hash),
        )
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES (%s, %s, %s, %s)",
            ("user_security", "set_password", Jsonb({"username": username}), user_email),
        )
        conn.commit()

    return {"ok": True}


def verify_user_password(username: str, raw_password: str) -> bool:
    """Check a plaintext password against the stored hash for `username`.
    False (never raises) if the user doesn't exist or has no password set.
    Username match is case-insensitive/trimmed, mirroring get_user_role."""
    username = (username or "").strip()
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT password_hash FROM user_security WHERE lower(username) = lower(%s)",
            (username,),
        )
        row = cur.fetchone()
    if not row or row[0] is None:
        return False
    return _verify_password(raw_password, row[0])


def change_own_password(actor_email: str | None, current_password: str, new_password: str) -> dict:
    """Self-service: change the CALLER's own password. Requires the correct
    CURRENT password — unlike update_own_name/upsert_user_settings, this can't
    just trust the actor header, since identity here comes from a client-supplied
    header rather than a verified session token (see auth._actor_email). Verifying
    the current password is the only thing standing between "I can set the
    X-User header" and "I can take over any account whose username I know"."""
    username = (actor_email or "").strip()
    if not username:
        raise HTTPException(status_code=401, detail="Not signed in")
    if not verify_user_password(username, current_password or ""):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    return set_user_password(username, new_password, user_email=username)


# =========================
# USER SETTINGS — per-user JSONB blob + per-role defaults (partial/shallow merge)
# =========================
def get_user_settings(username: str | None) -> dict:
    """Return a user's own settings blob (JSONB auto-decoded to a dict), or {}
    if the user has no row. Never raises. Case-insensitive/trimmed match, same
    as get_user_role — so header casing can't miss the stored canonical row."""
    username = (username or "").strip()
    if not username:
        return {}
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT settings FROM user_settings WHERE lower(username) = lower(%s)",
            (username,),
        )
        row = cur.fetchone()
    return (row[0] or {}) if row else {}


def get_role_settings(role: str | None) -> dict:
    """Return a role's DEFAULT settings blob, or {} for a None/unknown role or
    for 'admin' (admins never receive role defaults — they always resolve to the
    system defaults under their own settings). Never raises."""
    if not role or role == "admin":
        return {}
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT settings FROM roles WHERE role = %s", (role,))
        row = cur.fetchone()
    return (row[0] or {}) if row else {}


def upsert_user_settings(actor_username: str | None, patch: dict) -> dict:
    """Shallow-merge a PARTIAL `patch` into the CALLER's own user_settings blob
    and return the full merged result. This is a self-service write (like
    update_own_name): `actor_username` comes from the request header and must
    already resolve to a user_security row. Keys absent from `patch` are
    preserved. The canonical username casing is resolved from user_security (the
    same case-insensitive match every identity lookup uses) and used as the row
    key, so header casing can never create a duplicate row."""
    username = (actor_username or "").strip()
    if not username:
        raise HTTPException(status_code=401, detail="Not signed in")
    if not isinstance(patch, dict):
        raise ValueError("settings must be a JSON object")
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT username FROM user_security WHERE lower(username) = lower(%s)",
            (username,),
        )
        row = cur.fetchone()
        if not row:
            conn.rollback()
            raise HTTPException(status_code=401, detail="Not signed in")
        canonical = row[0]
        cur.execute(
            "INSERT INTO user_settings (username, settings) VALUES (%s, %s)"
            " ON CONFLICT (username) DO UPDATE SET"
            "   settings = user_settings.settings || EXCLUDED.settings,"
            "   updated_at = NOW()"
            " RETURNING settings",
            (canonical, Jsonb(patch)),
        )
        merged = cur.fetchone()[0]
        conn.commit()
    return {"username": canonical, "settings": merged or {}}


# =========================
# AUTHORIZATION — role lookup, require_admin dependency, login, bootstrap seed
# =========================
def get_user_role(username: str | None) -> str | None:
    """Look up a user's role by username. None for unknown/blank/no-row —
    never raises. The match is case-insensitive and whitespace-trimmed so a
    login/header casing difference (e.g. 'pj29587' vs the seeded 'PJ29587')
    can't silently fail the admin check — a lockout mode we hit before."""
    username = (username or "").strip()
    if not username:
        return None
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT role FROM user_security WHERE lower(username) = lower(%s)", (username,))
        row = cur.fetchone()
    return row[0] if row else None


def get_user_profile(username: str | None) -> dict | None:
    """Look up a user's role + first/last name by username. None for
    unknown/blank — never raises. Case-insensitive/trimmed match, same as
    get_user_role. Used by whoami() and authenticate()."""
    username = (username or "").strip()
    if not username:
        return None
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT role, first_name, last_name FROM user_security WHERE lower(username) = lower(%s)",
            (username,),
        )
        row = cur.fetchone()
    if not row:
        return None
    return {"role": row[0], "first_name": row[1], "last_name": row[2]}


def admin_exists() -> bool:
    """True once at least one user_security row has role='admin'. Backs
    require_admin's first-run grace and GET /security/bootstrap-status."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT EXISTS(SELECT 1 FROM user_security WHERE role = 'admin')")
        return bool(cur.fetchone()[0])


def get_allowed_plants(username: str | None) -> list[str] | None:
    """Resolve the plants `username`'s role is scoped to, via role_plants.
    None = unrestricted (every plant) — the safe default whenever this
    feature hasn't been deliberately engaged for a role: unknown/no-role
    users, role == 'admin', and a role with zero role_plants rows (an
    unscoped role hasn't "opted in" to restriction) all resolve to None.
    A role only becomes restricted once it has >=1 role_plants row — this
    is a stopgap ahead of WS3/Entra SSO, not a hard security boundary,
    same posture as require_admin (identity is still a spoofable header)."""
    role = get_user_role(username)
    if role is None or role == "admin":
        return None
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT plant FROM role_plants WHERE role = %s ORDER BY plant", (role,))
        rows = [r[0] for r in cur.fetchall()]
    return rows or None


def get_allowed_plants_for_request(request: Request) -> list[str] | None:
    """FastAPI-dependency-shaped resolver for get_allowed_plants. Scopes
    rather than gates — never raises, unlike require_admin."""
    return get_allowed_plants(_actor_email(request))


def _actor_email(request: Request) -> str | None:
    """Resolve the acting user's identity from request headers. WS3 SSO
    note: this is the ONLY line that changes when real SSO lands. Trimmed so
    stray whitespace never defeats the (case-insensitive) role lookup."""
    raw = request.headers.get("x-user-email") or request.headers.get("X-User")
    return raw.strip() if raw else None


def require_authenticated(request: Request) -> str:
    """Require a known user identity for mutable plant-scoped operations.

    This deliberately has no bootstrap grace: setup state and standards are
    operational truth, so an arbitrary spoofed-but-unknown header cannot write
    them.  It remains the same temporary header-backed identity boundary used
    by the rest of the pilot until Entra replaces ``_actor_email``.
    """
    email = _actor_email(request)
    if not email or get_user_role(email) is None:
        raise HTTPException(status_code=401, detail="Not signed in")
    return email


def require_setup_scheduler(request: Request) -> str:
    """Require the explicit role permission to record plant setup truth.

    Non-admin roles must opt in with ``roles.settings.permissions`` containing
    ``{"setup_scheduler": true}`` *and* have at least one assigned
    ``role_plants`` row.  This keeps the legacy unscoped-role compatibility
    used by older routes from accidentally granting a new operational write
    permission.  Admin is the sole intentionally plant-unrestricted role.
    """
    email = require_authenticated(request)
    role = get_user_role(email)
    if role == "admin":
        return email
    settings = get_role_settings(role)
    permissions = settings.get("permissions") if isinstance(settings, dict) else None
    if not isinstance(permissions, dict) or permissions.get("setup_scheduler") is not True:
        raise HTTPException(status_code=403, detail="Setup scheduler permission required")
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM role_plants WHERE role = %s LIMIT 1", (role,))
        assigned = cur.fetchone() is not None
    if not assigned:
        raise HTTPException(status_code=403, detail="Setup scheduler requires assigned plants")
    return email


def require_admin(request: Request) -> str:
    """FastAPI dependency gating admin-only endpoints. Grace: open to
    anyone until the first admin user exists, so the bootstrap seed (or an
    admin created before the seed runs) can never get locked out of its
    own onboarding."""
    email = _actor_email(request)
    role = get_user_role(email)
    if role == "admin" or not admin_exists():
        return email
    raise HTTPException(status_code=403, detail="Admin role required")


def whoami(request: Request) -> dict:
    """Live identity + effective admin status for the caller, computed the same
    way require_admin decides access (is_admin is True during first-run grace,
    before any admin exists). Ungated on purpose — any client must be able to
    call it to discover it is NOT (or no longer) an admin, so the frontend can
    reconcile a role it cached at login time. Never returns secrets."""
    email = _actor_email(request)
    profile = get_user_profile(email) or {}
    role = profile.get("role")
    return {
        "username": email,
        "role": role,
        "is_admin": role == "admin" or not admin_exists(),
        "first_name": profile.get("first_name"),
        "last_name": profile.get("last_name"),
        "allowed_plants": get_allowed_plants(email),
        "settings": get_user_settings(email) or {},
        "role_settings": get_role_settings(role) or {},
    }


def update_own_name(actor_email: str | None, first_name: str | None, last_name: str | None) -> dict:
    """Update the CALLER's own first/last name only — never a name, role, or
    password for anyone else. `actor_email` must already resolve to an
    existing user_security row. This is the only self-service write path in
    the app, so it deliberately touches nothing but these two columns for
    exactly one row, matched the same case-insensitive way as every other
    identity lookup in this module."""
    username = (actor_email or "").strip()
    if not username:
        raise HTTPException(status_code=401, detail="Not signed in")
    first_name = _validate_name(first_name, "First name")
    last_name = _validate_name(last_name, "Last name")
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE user_security SET first_name = %s, last_name = %s, updated_at = NOW()"
            " WHERE lower(username) = lower(%s) RETURNING username, role",
            (first_name, last_name, username),
        )
        row = cur.fetchone()
        if not row:
            conn.rollback()
            raise HTTPException(status_code=404, detail="User not found")
        conn.commit()
    return {"username": row[0], "role": row[1], "first_name": first_name, "last_name": last_name}


def authenticate(username: str, password: str) -> dict | None:
    """Verify a username/password pair against user_security. Returns
    {"username", "role", "first_name", "last_name"} on success, None on
    failure. Never returns or logs the password hash. On success, also stamps
    last_login = NOW() — a server-side audit record, separate from and not
    used by the frontend's own 12h local session-cache expiry."""
    if verify_user_password(username, password):
        with _pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE user_security SET last_login = NOW() WHERE lower(username) = lower(%s)",
                (username,),
            )
            conn.commit()
        profile = get_user_profile(username) or {}
        return {
            "username": username,
            "role": profile.get("role"),
            "first_name": profile.get("first_name"),
            "last_name": profile.get("last_name"),
            "allowed_plants": get_allowed_plants(username),
        }
    return None


# Bootstrap admin seed — the password is NEVER a hardcoded literal (a
# committed hash is permanently recoverable from git history, and a weak
# throwaway password gives that hash essentially no real protection).
# Provide it via env var instead: NIMBUS_BOOTSTRAP_ADMIN_PASSWORD locally
# (in a gitignored .env) or as a one-time Azure Container App env var,
# then remove it and rotate the password via Security -> Users. If unset,
# no bootstrap user is seeded — require_admin's first-run grace (see below)
# stays open until the first admin is created directly through the UI.
_BOOTSTRAP_ADMIN_USERNAME = os.getenv("NIMBUS_BOOTSTRAP_ADMIN_USERNAME", "PJ29587").strip()


def ensure_bootstrap_admin() -> None:
    """Idempotent seed: ensures the 'admin' role exists, and — only if
    NIMBUS_BOOTSTRAP_ADMIN_PASSWORD is set — seeds a bootstrap admin user
    with that password (hashed fresh on every call; harmless since the
    insert is ON CONFLICT DO NOTHING regardless). Both inserts can never
    overwrite a password already changed via set_user_password. Called
    once from brain.py's lifespan, right after ensure_user_security_table()."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO roles (role, description) VALUES (%s, %s)"
            " ON CONFLICT (role) DO NOTHING",
            ("admin", "Full administrative access"),
        )
        bootstrap_password = os.getenv("NIMBUS_BOOTSTRAP_ADMIN_PASSWORD")
        if bootstrap_password:
            password_hash = _hash_password(bootstrap_password)
            cur.execute(
                "INSERT INTO user_security (username, password_hash, role) VALUES (%s, %s, %s)"
                " ON CONFLICT (lower(username)) DO NOTHING",
                (_BOOTSTRAP_ADMIN_USERNAME, password_hash, "admin"),
            )
        conn.commit()


# =============================================================================
# API-KEY DEPLOYMENT GUARD (P5 relocation — moved here verbatim from brain.py,
# unchanged, per docs/architecture/domain-refactor-plan.md §4's router-mechanics
# note: "Auth guards live in server/security/auth.py; route modules import
# them (one-way)." require_api_key is a Depends() guard referenced by every one
# of the 9 domain routers, so it needs a home outside brain.py that none of
# them create a cycle importing — this is that home.
#
# Optional shared-secret guard for destructive / DDL / maintenance routes. It is a
# NO-OP until NIMBUS_API_KEY is set in the environment, so the (login-less) frontend
# keeps working untouched in dev; set the env var AND have admin clients send the
# matching X-API-Key header to lock these routes down for a hosted deployment.
# NOTE: this is a deployment-config patch, NOT user-level auth — actor identity is
# still taken from spoofable X-User / x-user-email headers. Proper per-user auth/SSO
# with server-verified identity is the real fix (see MIGRATION.md → "User security").
# =============================================================================
NIMBUS_API_KEY = os.getenv("NIMBUS_API_KEY")


def require_api_key(x_api_key: str | None = Header(default=None)):
    if NIMBUS_API_KEY and x_api_key != NIMBUS_API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")
