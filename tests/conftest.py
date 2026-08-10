"""
NIMBUS backend test harness — shared fixtures.

Design constraints (per the project setup): the app deps live in `.venv`, and
Postgres is frequently NOT running on dev machines. So:

  * Pure-logic tests (e.g. make_id) run unconditionally.
  * DB-integration tests are marked `@pytest.mark.pg`, require the explicit
    `NIMBUS_TEST_DB=1` opt-in, and are AUTO-SKIPPED when opt-in is absent or
    Postgres is unreachable.

The probe is pool-free with a short connect timeout so collection never blocks
on `db.py`'s eagerly-opened connection pool.
"""
import os
import sys

import pytest
from dotenv import load_dotenv

# Make the project root importable (db.py / brain.py / master_data.py live there).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from tests.support.db_safety import (  # noqa: E402
    LOCAL_TEST_HOSTS,
    UnsafeTestDatabase,
    is_test_database_opted_in,
    validate_test_database,
)

load_dotenv(os.path.join(ROOT, ".env"))

PG_HOST = os.getenv("PG_HOST", "localhost")
PG_DB = os.getenv("PG_DB", "nimbus")
TEST_DB_OPTED_IN = is_test_database_opted_in(os.getenv("NIMBUS_TEST_DB"))

# Prevent application imports in DB-free tests from opening warm connections.
# A non-local host is always rejected, including when the suite is not opted in.
if not TEST_DB_OPTED_IN:
    os.environ["NIMBUS_PG_POOL_MIN"] = "0"

try:
    validate_test_database(PG_HOST, PG_DB, opted_in=TEST_DB_OPTED_IN)
except UnsafeTestDatabase as exc:
    if str(PG_HOST or "").strip().lower() not in LOCAL_TEST_HOSTS:
        raise pytest.UsageError(str(exc)) from exc
    if TEST_DB_OPTED_IN:
        raise pytest.UsageError(str(exc)) from exc


def _pg_available() -> bool:
    """Fast, pool-free probe; reuses db.py's resolved PG_* connection params."""
    try:
        import psycopg

        import db  # noqa: E402 — also resolves PG_* from .env / environment
        with psycopg.connect(
            host=db.PG_HOST, port=db.PG_PORT, dbname=db.PG_DB,
            user=db.PG_USER, password=db.PG_PASS, connect_timeout=2,
        ) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
        return True
    except Exception:
        return False


PG_UP = _pg_available() if TEST_DB_OPTED_IN else False


def pytest_sessionfinish(session, exitstatus):
    """Close an application pool already imported by tests before Python exits."""
    db_module = sys.modules.get("db")
    pool = getattr(db_module, "_pool", None) if db_module is not None else None
    if pool is not None:
        pool.close()


def pytest_collection_modifyitems(config, items):
    """Auto-skip every @pytest.mark.pg test when Postgres is unreachable."""
    if PG_UP:
        return
    skip_pg = pytest.mark.skip(
        reason="Postgres unavailable (set NIMBUS_TEST_DB=1 for a local/CI test DB)"
    )
    for item in items:
        if "pg" in item.keywords:
            item.add_marker(skip_pg)


@pytest.fixture(scope="session")
def pg():
    """Returns the `db` module, guaranteed connected. Skips if the DB is down."""
    if not PG_UP:
        pytest.skip("Postgres not reachable")
    return sys.modules["db"]


@pytest.fixture
def client():
    """
    FastAPI TestClient over brain.api, for endpoint-level tests (e.g. the #191
    color-wheel auth-gate fix). Imports brain lazily and skips if it cannot be
    constructed (e.g. the hardcoded COLOR_WHEEL_DIR path is absent on this
    machine).
    """
    try:
        from starlette.testclient import TestClient

        import brain
        return TestClient(brain.api)
    except Exception as e:  # pragma: no cover - environment dependent
        pytest.skip(f"brain app could not be imported in this environment: {e}")
