"""
Pure-logic tests for brain._to_pydt — no database required, run unconditionally.

These pin the timezone-save contract fixed 2026-07-07 (see MIGRATION.md →
"Timezone save corruption"). The frontend save path now sends NAIVE-LOCAL
datetime strings (no `Z`, via Util.toLocalSeconds); _to_pydt must parse those
tz-naive and preserve the clock digits verbatim so a save→read round-trip does
not shift by the client's UTC offset. The `.replace(tzinfo=None)` stays as a
defensive guard for any stray tz-aware (UTC `Z`) input from external callers.
"""
import datetime

import brain


def test_naive_local_string_preserves_clock_digits():
    # The Fix-1 contract: what Util.toLocalSeconds emits must come back with the
    # SAME wall-clock digits and no tzinfo (stored verbatim into a TIMESTAMP
    # WITHOUT TIME ZONE column, read back bare, parsed as local by the frontend).
    got = brain._to_pydt("2026-07-07T10:30:00")
    assert got == datetime.datetime(2026, 7, 7, 10, 30, 0)
    assert got.tzinfo is None


def test_naive_local_string_preserves_seconds():
    got = brain._to_pydt("2026-07-07T10:30:45")
    assert got == datetime.datetime(2026, 7, 7, 10, 30, 45)
    assert got.tzinfo is None


def test_none_and_empty_are_none():
    # Cleared schedule dates (unschedule path) round-trip to SQL NULL.
    assert brain._to_pydt(None) is None
    assert brain._to_pydt("") is None


def test_unparseable_is_none():
    assert brain._to_pydt("not-a-date") is None


def test_utc_z_string_is_coerced_tz_naive_defensively():
    # Defensive guard: a stray UTC `Z` string (e.g. an external /tasks/bulk_update
    # caller) must still be accepted as tz-naive (psycopg3 rejects tz-aware values
    # for TIMESTAMP WITHOUT TIME ZONE). The clock digits are kept as-is (UTC),
    # which is the documented external-caller contract — NOT the frontend path.
    got = brain._to_pydt("2026-07-07T14:30:00Z")
    assert got == datetime.datetime(2026, 7, 7, 14, 30, 0)
    assert got.tzinfo is None
