"""Read-only coverage contracts for Stage 0 setup shadow diagnostics."""
import copy
from datetime import datetime

import pytest

import backend.setup.data as setup_data


DEFINITION = {
    "plant": "5512", "fields": ["colorWheel"], "signature_version": 4,
    "strict_blanks": True, "active": False,
}
RED = [{"fieldKey": "colorWheel", "value": "RED"}]
BLUE = [{"fieldKey": "colorWheel", "value": "BLUE"}]
GREEN = [{"fieldKey": "colorWheel", "value": "GREEN"}]


def _row(line, from_key, to_key, minutes=12):
    return {"machine": line, "signature_version": 4, "from_key": from_key, "to_key": to_key,
            "setup_min": minutes}


def test_coverage_distinguishes_observed_adjacencies_from_reachable_state_pairs():
    """Reachable coverage includes legal alternatives, while observed contains only schedule edges."""
    result = setup_data.build_setup_coverage(
        DEFINITION, [_row("", RED, BLUE)], [],
        [
            {"machine": "L1", "from_key": RED, "to_key": BLUE},
            {"machine": "L1", "from_key": BLUE, "to_key": GREEN},
        ],
        {"L1": [RED, BLUE, GREEN]},
    )
    assert result["observed"]["total_pairs"] == 2
    assert result["observed"]["missing_pairs"] == 1
    assert result["reachable"]["total_pairs"] == 9
    # Three complete diagonals are covered implicitly at zero; RED→BLUE has
    # the explicit plant row, leaving five missing non-diagonal transitions.
    assert result["reachable"]["missing_pairs"] == 5
    assert result["observed"]["missing"][0]["from_key"] == BLUE
    assert result["observed"]["missing"][0]["to_key"] == GREEN


def test_coverage_deduplicates_by_line_and_pair_and_keeps_line_scope_distinct():
    """Repeated schedule edges produce one review row per pair/scope, never a global accidental merge."""
    result = setup_data.build_setup_coverage(
        DEFINITION, [], [_row("L1", RED, BLUE)],
        [
            {"machine": "L1", "from_key": RED, "to_key": BLUE},
            {"machine": "L1", "from_key": RED, "to_key": BLUE},
            {"machine": "L2", "from_key": RED, "to_key": BLUE},
        ],
        {"L1": [RED, BLUE], "L2": [RED, BLUE]},
    )
    assert result["observed"]["total_pairs"] == 2
    assert result["observed"]["missing_pairs"] == 1
    assert result["observed"]["missing"][0]["machine"] == "L2"
    assert result["observed"]["missing"][0]["scope"] == "plant"


def test_coverage_excludes_implicit_diagonal_but_rejects_invalid_or_incomplete_states():
    """The only missing edge allowed to resolve is a complete identical pair; malformed data is not coverage."""
    invalid = [{"fieldKey": "wrong", "value": "RED"}]
    incomplete = [{"fieldKey": "colorWheel", "value": ""}]
    result = setup_data.build_setup_coverage(
        DEFINITION, [], [],
        [
            {"machine": "L1", "from_key": RED, "to_key": RED},
            {"machine": "L1", "from_key": RED, "to_key": incomplete},
            {"machine": "L1", "from_key": invalid, "to_key": BLUE},
        ],
        {"L1": [RED, RED, incomplete, invalid]},
    )
    assert result["observed"]["total_pairs"] == 1
    assert result["observed"]["missing_pairs"] == 0
    assert result["reachable"]["total_pairs"] == 1
    assert result["reachable"]["missing_pairs"] == 0


def test_missing_pair_page_is_stable_filtered_and_bounded():
    """Review/export requests never default to an unbounded plant-wide missing-pair payload."""
    rows = [
        {"machine": "L2", "scope": "plant", "from_key": RED, "to_key": GREEN},
        {"machine": "L1", "scope": "machine", "from_key": RED, "to_key": BLUE},
        {"machine": "L1", "scope": "plant", "from_key": BLUE, "to_key": GREEN},
    ]
    page = setup_data.page_missing_pairs(rows, machine="L1", offset=1, limit=1)
    assert page == {"rows": [rows[2]], "meta": {"total": 2, "offset": 1, "limit": 1}}
    with pytest.raises(ValueError, match="limit"):
        setup_data.page_missing_pairs(rows, offset=0, limit=501)


def test_coverage_inputs_remain_unchanged():
    """Coverage is a pure observation: it cannot rewrite schedule rows, keys, or matrix records."""
    plant_rows = [_row("", RED, BLUE)]
    transitions = [{"machine": "L1", "from_key": RED, "to_key": BLUE}]
    states = {"L1": [RED, BLUE]}
    before = copy.deepcopy((plant_rows, transitions, states))
    setup_data.build_setup_coverage(DEFINITION, plant_rows, [], transitions, states)
    assert (plant_rows, transitions, states) == before


def test_bounded_coverage_summary_and_page_match_existing_semantics_without_snapshot(monkeypatch):
    """The database-backed read path keeps the Stage 0 counts/page contract without hydrating optimizer truth."""
    cursor = _CoverageCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    monkeypatch.setattr(
        setup_data,
        "get_setup_snapshot",
        lambda _plant: (_ for _ in ()).throw(AssertionError("coverage must not load the optimizer snapshot")),
    )

    context = setup_data.load_setup_coverage("5512")
    summary = setup_data.summarize_setup_coverage(context)
    page = setup_data.page_setup_missing_pairs(context, "reachable", machine="L2", offset=1, limit=2)

    assert summary == {
        "plant": "5512",
        "definition": DEFINITION,
        "observed": {"total_pairs": 4, "covered_pairs": 3, "missing_pairs": 1},
        "reachable": {"total_pairs": 18, "covered_pairs": 9, "missing_pairs": 9},
    }
    assert page == {
        "rows": [
            {"machine": "L2", "scope": "plant", "from_key": BLUE, "to_key": RED,
             "covered": False, "implicit_zero": False},
            {"machine": "L2", "scope": "plant", "from_key": BLUE, "to_key": GREEN,
             "covered": False, "implicit_zero": False},
        ],
        "meta": {"total": 5, "offset": 1, "limit": 2},
    }
    statements = "\n".join(sql for sql, _params in cursor.executed)
    assert "FROM machine_setup_state" not in statements
    assert "FROM setup_occurrence_override" not in statements
    assert "jsonb_to_recordset" in statements
    assert "LIMIT %s OFFSET %s" in statements


def test_bounded_coverage_rejects_an_oversized_page_before_database_access(monkeypatch):
    """The public missing-pair helper enforces the route's 500-row ceiling itself."""
    monkeypatch.setattr(setup_data, "_pool", _FailPool())
    with pytest.raises(ValueError, match="limit"):
        setup_data.page_setup_missing_pairs(
            {"plant": "5512", "definition": DEFINITION, "states": [], "observed": []},
            "reachable",
            limit=501,
        )


class _CoverageCursor:
    """Deterministic PostgreSQL boundary double for the bounded coverage helpers."""

    ORDER_ROWS = [
        ("L1", datetime(2026, 9, 1, 8), "RED"),
        ("L1", datetime(2026, 9, 1, 9), "BLUE"),
        ("L1", datetime(2026, 9, 1, 10), "GREEN"),
        ("L2", datetime(2026, 9, 1, 8), "RED"),
        ("L2", datetime(2026, 9, 1, 9), "BLUE"),
        ("L2", datetime(2026, 9, 1, 10), "GREEN"),
    ]

    def __init__(self):
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, sql, params=()):
        self.executed.append((sql, params))

    def fetchone(self):
        return (["colorWheel"], 4, True, False)

    def fetchall(self):
        sql, _params = self.executed[-1]
        if "FROM orders" in sql:
            return self.ORDER_ROWS
        if "setup coverage summary" in sql:
            return [("observed", "L1", 2), ("observed", "L2", 1),
                    ("reachable", "L1", 5), ("reachable", "L2", 4)]
        if "setup reachable missing page" in sql:
            return [("L2", BLUE, RED), ("L2", BLUE, GREEN)]
        raise AssertionError(f"Unexpected coverage query: {sql}")


class _Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def cursor(self):
        return self._cursor


class _Pool:
    def __init__(self, cursor):
        self._cursor = cursor

    def connection(self):
        return _Connection(self._cursor)


class _FailPool:
    def connection(self):
        raise AssertionError("paging validation must run before database access")
