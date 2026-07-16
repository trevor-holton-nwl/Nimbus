import sys
from types import SimpleNamespace

import pytest

from tests.support.db_safety import (
    UnsafeTestDatabase,
    is_test_database_opted_in,
    validate_test_database,
)


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
