"""Universal firm (2026-10-27), backend pieces that need no database: the frozen-window helpers in `db.py`. Send to SAP's firm rule lives in tests/test_sap_staging.py, the distribution
survivor rule in tests/test_distribution.py."""
from __future__ import annotations

from datetime import datetime

import pytest

import db


@pytest.mark.parametrize("end, now, edge, expected", [
    (datetime(2026, 10, 7), datetime(2026, 10, 5), datetime(2026, 10, 10), True),     # finish inside the window
    (datetime(2026, 10, 5), datetime(2026, 10, 5), datetime(2026, 10, 10), True),     # finish == now is inside
    (datetime(2026, 10, 10), datetime(2026, 10, 5), datetime(2026, 10, 10), False),   # finish == edge is outside
    (datetime(2026, 10, 4), datetime(2026, 10, 5), datetime(2026, 10, 10), False),    # overdue
    (datetime(2026, 10, 12), datetime(2026, 10, 5), datetime(2026, 10, 10), False),   # straddler (finishes after)
    (None, datetime(2026, 10, 5), datetime(2026, 10, 10), False),                     # no finish
    (datetime(2026, 10, 7), None, datetime(2026, 10, 10), False),                     # no clock
    (datetime(2026, 10, 7), datetime(2026, 10, 5), None, False),                      # no frozen horizon
])
def test_finish_in_frozen_window(end, now, edge, expected):
    assert db.finish_in_frozen_window(end, now, edge) is expected


class _Cur:
    def __init__(self, row):
        self._row = row
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchone(self):
        return self._row


def test_frozen_window_unknown_plant_and_no_timezone_have_no_window():
    assert db.frozen_window_for_plant(_Cur(None), "P") == (None, None)
    assert db.frozen_window_for_plant(_Cur((0, None, 3)), "P") == (None, None)       # C6: no timezone -> nothing frozen
    assert db.frozen_window_for_plant(_Cur((0, "", 3)), "P") == (None, None)


def test_frozen_window_returns_one_clock_for_both_edges():
    now, edge = db.frozen_window_for_plant(_Cur((0, "America/Chicago", 3)), "P")
    assert now is not None and edge is not None and now.tzinfo is None and edge.tzinfo is None
    assert abs((edge - now).total_seconds() - 3 * 86400) < 1e-6                       # exactly now + 3 days


@pytest.mark.parametrize("days", [None, 0])
def test_frozen_window_off_keeps_the_clock_for_running(days):
    now, edge = db.frozen_window_for_plant(_Cur((0, "America/Chicago", days)), "P")
    assert now is not None and edge is None


def test_frozen_window_bad_timezone_name_falls_back_to_utc_like_the_horizon_math():
    now, edge = db.frozen_window_for_plant(_Cur((0, "Not/AZone", 1)), "P")
    assert now is not None and edge is not None and (edge - now).days == 1

