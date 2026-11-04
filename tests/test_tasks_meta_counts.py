"""`/tasks` meta pipeline counts: queried_row_count and dropped_no_dates (DB-free).

The Admin Diagnostics strip reads these two to show how many rows the SQL returned
(post plant scope + visibility horizon) and how many the no-start/no-finish rule dropped.
"""
import copy
from datetime import datetime

from backend.scheduling import routes
from tests.test_tasks_builder_golden import mk


def _build(monkeypatch, rows):
    monkeypatch.setattr(routes.db, "query_orders_rows", lambda **kw: (copy.deepcopy(rows), None, None))
    monkeypatch.setattr(routes.db, "count_orders", lambda **kw: 0)
    return routes.build_tasks_payload("P1", None, None, None, None)


def test_queried_and_dropped_counts_with_one_undated_row(monkeypatch):
    d = datetime(2026, 10, 22, 8)
    rows = [
        mk("o001", "M1", d, datetime(2026, 10, 22, 12)),
        mk("o002", "M1", None, datetime(2026, 10, 23, 12)),                 # finish only: kept
        mk("o003", "M1", None, None),                                        # neither edge, scheduled: dropped
        mk("o004", "M1", None, None, PLANNING_STATUS="needs_planning"),      # queued: kept
    ]
    meta = _build(monkeypatch, rows)["meta"]
    assert meta["queried_row_count"] == 4
    assert meta["dropped_no_dates"] == 1
    assert meta["rendered"] == 3
    assert meta["queried_row_count"] - meta["rendered"] == meta["dropped_no_dates"]
    assert meta["pre_color_merge_count"] == 3
    for key in ("color_merge_misses", "missed_colors", "color_merge_ms", "raw_row_count", "unique_id_count"):
        assert key in meta


def test_counts_on_the_empty_path(monkeypatch):
    meta = _build(monkeypatch, [])["meta"]
    assert meta["queried_row_count"] == 0 and meta["dropped_no_dates"] == 0
    assert meta["rendered"] == 0
