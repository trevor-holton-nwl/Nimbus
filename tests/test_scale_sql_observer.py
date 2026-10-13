"""Check the instrumentation supporting the real-SQL performance assertions."""

import pytest
from psycopg import sql

from tests.support.scale_catalog_sql import RecordingPool


@pytest.mark.pg
def test_sql_budget_observes_convenience_cursor_and_batch_execution_without_double_counting(pg):
    recorder = RecordingPool(pg._pool)
    with recorder.connection() as conn:
        # Session-local and automatically dropped; no persistent schema changes.
        conn.execute("CREATE TEMP TABLE scale_observer_probe(value integer) ON COMMIT DROP").close()
        recorder.calls.clear()
        with conn.execute(sql.SQL("SELECT %s::integer"), (11,)) as direct:
            assert direct.fetchone() == (11,)
            assert direct.execute("SELECT %s::integer", (12,)).fetchone() == (12,)
        with conn.cursor() as cursor:
            statement = "INSERT INTO scale_observer_probe(value) VALUES (%s)"
            cursor.executemany(sql.SQL(statement), ((value,) for value in [21, 22]))
            cursor.execute("SELECT value FROM scale_observer_probe ORDER BY value")
            assert list(cursor) == [(21,), (22,)]
        assert recorder.calls == [
            ("SELECT %s::integer", (11,)),
            ("SELECT %s::integer", (12,)),
            (statement, (21,)),
            (statement, (22,)),
            ("SELECT value FROM scale_observer_probe ORDER BY value", None),
        ]
