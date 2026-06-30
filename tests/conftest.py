"""
NIMBUS backend test harness — shared fixtures.

Design constraints (per the project setup): the app deps live in `.venv`, and
Postgres is frequently NOT running on dev machines. So:

  * Pure-logic tests (e.g. make_id) run unconditionally.
  * DB-integration tests are marked `@pytest.mark.pg` and are AUTO-SKIPPED when
    Postgres is unreachable — the suite stays green offline and only exercises
    the DB when one is available (CI with a service container, or a local DB).

The probe is pool-free with a short connect timeout so collection never blocks
on `db.py`'s eagerly-opened connection pool.
"""
import os
import sys

import pytest

# Make the project root importable (db.py / brain.py / master_data.py live there).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


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


PG_UP = _pg_available()


def pytest_collection_modifyitems(config, items):
    """Auto-skip every @pytest.mark.pg test when Postgres is unreachable."""
    if PG_UP:
        return
    skip_pg = pytest.mark.skip(reason="Postgres not reachable (start the DB / set PG_* env)")
    for item in items:
        if "pg" in item.keywords:
            item.add_marker(skip_pg)


@pytest.fixture(scope="session")
def pg():
    """Returns the `db` module, guaranteed connected. Skips if the DB is down."""
    if not PG_UP:
        pytest.skip("Postgres not reachable")
    import db
    return db


@pytest.fixture
def client():
    """
    FastAPI TestClient over brain.api, for endpoint-level tests (e.g. the #191
    color-wheel auth-gate fix). Imports brain lazily and skips if it cannot be
    constructed (e.g. the hardcoded COLOR_FILE / COLOR_WHEEL_DIR paths are absent
    on this machine).
    """
    try:
        from starlette.testclient import TestClient

        import brain
        return TestClient(brain.api)
    except Exception as e:  # pragma: no cover - environment dependent
        pytest.skip(f"brain app could not be imported in this environment: {e}")
