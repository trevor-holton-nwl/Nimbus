TRUTHY = frozenset({'1', 'true', 'yes', 'on'})
LOCAL_TEST_HOSTS = frozenset({'localhost', '127.0.0.1', '::1', 'postgres'})


class UnsafeTestDatabase(RuntimeError):
    pass


def is_test_database_opted_in(value: str | None) -> bool:
    return str(value or '').strip().lower() in TRUTHY


def validate_test_database(host: str, database: str, *, opted_in: bool) -> None:
    normalized_host = str(host or '').strip().lower()
    if normalized_host not in LOCAL_TEST_HOSTS:
        raise UnsafeTestDatabase(
            f'Tests may use local/CI PostgreSQL only; rejected host {normalized_host!r}'
        )
    if not opted_in:
        raise UnsafeTestDatabase(
            'Database tests require explicit NIMBUS_TEST_DB=1 opt-in'
        )
    if not str(database or '').strip():
        raise UnsafeTestDatabase('Test database name must not be empty')
