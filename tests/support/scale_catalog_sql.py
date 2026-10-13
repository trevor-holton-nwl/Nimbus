"""Observe attempted SQL statements while delegating to real PostgreSQL.

Connection.execute, Cursor.execute and Cursor.executemany are all observed.
Executemany records each parameter set: pipelining may reduce network round
trips, but it must not hide per-row SQL work from a query budget.
"""

from contextlib import contextmanager


class RecordingPool:
    def __init__(self, pool):
        self.pool = pool
        self.calls = []

    @contextmanager
    def connection(self):
        with self.pool.connection() as conn:
            yield _Connection(conn, self.calls)


class _Connection:
    def __init__(self, conn, calls):
        self.conn, self.calls = conn, calls

    @contextmanager
    def cursor(self, *args, **kwargs):
        with self.conn.cursor(*args, **kwargs) as cur:
            yield _Cursor(cur, self.calls)

    def execute(self, query, params=None, **kwargs):
        text = query if isinstance(query, str) else query.as_string(self.conn)
        self.calls.append((text, params))
        return _Cursor(self.conn.execute(query, params, **kwargs), self.calls)

    def __getattr__(self, name):
        return getattr(self.conn, name)


class _Cursor:
    def __init__(self, cur, calls):
        self.cur, self.calls = cur, calls

    def execute(self, query, params=None, **kwargs):
        text = query if isinstance(query, str) else query.as_string(self.cur.connection)
        self.calls.append((text, params))
        self.cur.execute(query, params, **kwargs)
        return self

    def executemany(self, query, params_seq, **kwargs):
        text = query if isinstance(query, str) else query.as_string(self.cur.connection)
        params = list(params_seq)
        self.calls.extend((text, values) for values in params)
        return self.cur.executemany(query, params, **kwargs)

    def __enter__(self):
        self.cur.__enter__()
        return self

    def __exit__(self, *args):
        return self.cur.__exit__(*args)

    def __iter__(self):
        return iter(self.cur)

    def __getattr__(self, name):
        return getattr(self.cur, name)
