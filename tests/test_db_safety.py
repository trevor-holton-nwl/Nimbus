import ast
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.support.db_safety import (
    UnsafeTestDatabase,
    is_test_database_opted_in,
    validate_test_database,
)

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize('value', ['1', 'true', 'TRUE', 'yes', ' on '])
def test_test_db_opt_in_accepts_explicit_truthy_values(value):
    assert is_test_database_opted_in(value)


@pytest.mark.parametrize('value', [None, '', '0', 'false', 'no'])
def test_test_db_opt_in_is_off_by_default(value):
    assert not is_test_database_opted_in(value)


@pytest.mark.parametrize('host', ['localhost', '127.0.0.1', '::1', 'postgres'])
def test_local_test_hosts_are_allowed_only_with_opt_in(host):
    validate_test_database(host, 'nimbus_test', opted_in=True)
    with pytest.raises(UnsafeTestDatabase, match='NIMBUS_TEST_DB=1'):
        validate_test_database(host, 'nimbus_test', opted_in=False)


@pytest.mark.parametrize('host', [
    'pgdb-nimbus-dev.postgres.database.azure.com',
    'db.example.com',
    '10.20.30.40',
])
def test_remote_hosts_are_rejected_even_with_opt_in(host):
    with pytest.raises(UnsafeTestDatabase, match='local/CI PostgreSQL'):
        validate_test_database(host, 'nimbus', opted_in=True)


@pytest.mark.parametrize('database', ['', '   '])
def test_test_database_name_must_not_be_empty(database):
    with pytest.raises(UnsafeTestDatabase, match='must not be empty'):
        validate_test_database('localhost', database, opted_in=True)


def test_conftest_imports_db_only_inside_pg_available():
    from tests import conftest

    tree = ast.parse(Path(conftest.__file__).read_text(encoding='utf-8'))
    pg_available = next(
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == '_pg_available'
    )
    allowed_lines = set(range(pg_available.lineno, pg_available.end_lineno + 1))
    db_import_lines = {
        node.lineno for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        and any(alias.name == 'db' for alias in node.names)
    }

    assert len(db_import_lines) == 1
    assert db_import_lines <= allowed_lines


def test_pg_fixture_returns_the_module_loaded_by_the_guarded_probe(monkeypatch):
    from tests import conftest

    expected = SimpleNamespace()
    monkeypatch.setattr(conftest, 'PG_UP', True)
    monkeypatch.setitem(sys.modules, 'db', expected)

    assert conftest.pg.__wrapped__() is expected


@pytest.mark.parametrize(
    ("required", "opted_in", "pg_up", "expected"),
    [
        (False, False, False, None),
        (True, False, False, "NIMBUS_REQUIRE_TEST_DB=1 requires NIMBUS_TEST_DB=1"),
        (True, True, False, "NIMBUS_REQUIRE_TEST_DB=1 requires reachable local/CI PostgreSQL test DB"),
        (True, True, True, None),
    ],
)
def test_required_test_db_setting_turns_pg_skip_into_collection_error(required, opted_in, pg_up, expected):
    from tests import conftest

    assert conftest._required_test_db_error(required=required, opted_in=opted_in, pg_up=pg_up) == expected


@pytest.mark.parametrize(
    ("test_db", "port", "expected"),
    [
        (None, "5432", "NIMBUS_REQUIRE_TEST_DB=1 requires NIMBUS_TEST_DB=1"),
        ("1", "1", "NIMBUS_REQUIRE_TEST_DB=1 requires reachable local/CI PostgreSQL test DB"),
    ],
)
def test_required_test_db_fails_collection_in_subprocess_when_guard_cannot_pass(test_db, port, expected):
    """Collection must fail before pg tests can be silently marked skipped."""
    env = os.environ.copy()
    env.update(
        {
            "PG_HOST": "localhost",
            "PG_PORT": port,
            "PG_DB": "nimbus",
            "PG_USER": "postgres",
            "PG_PASS": "test-only",
            "NIMBUS_REQUIRE_TEST_DB": "1",
            "NIMBUS_PG_POOL_MIN": "0",
        }
    )
    if test_db is None:
        # load_dotenv() does not replace an explicitly present empty value;
        # this makes the missing-opt-in branch independent of the developer .env.
        env["NIMBUS_TEST_DB"] = ""
    else:
        env["NIMBUS_TEST_DB"] = test_db

    result = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_integration_pg.py", "--collect-only", "-q"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    output = f"{result.stdout}\n{result.stderr}"
    assert result.returncode != 0
    assert expected in output


def test_pytest_sessionfinish_closes_an_imported_application_pool(monkeypatch):
    from tests import conftest

    class Pool:
        closed = False

        def close(self):
            self.closed = True

    pool = Pool()
    monkeypatch.setitem(sys.modules, 'db', SimpleNamespace(_pool=pool))

    conftest.pytest_sessionfinish(None, 0)

    assert pool.closed
