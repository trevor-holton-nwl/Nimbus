"""Read-only coverage contracts for Stage 0 setup shadow diagnostics."""
import copy

import pytest

import server.setup.data as setup_data


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
