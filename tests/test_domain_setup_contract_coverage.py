"""Physical-state precedence and setup import contracts without a database."""
from copy import deepcopy
from datetime import datetime, timedelta

import pytest

from backend.setup import data as setup


NOW = datetime(2026, 10, 13, 12)


@pytest.mark.parametrize("prior, incoming, allowed", [
    ("derived", "derived", True), ("derived", "manual", True), ("derived", "actual", True),
    ("manual", "derived", False), ("manual", "manual", True), ("manual", "actual", True),
    ("actual", "derived", False), ("actual", "manual", False), ("actual", "actual", True),
])
@pytest.mark.parametrize("delta_seconds", [-1, 0, 1])
def test_physical_state_requires_both_monotonic_time_and_sufficient_trust(prior, incoming, allowed, delta_seconds):
    existing = {"source": prior, "observed_at": NOW, "state_key": [{"value": "RED"}]}
    original = deepcopy(existing)
    result = setup.should_replace_machine_state(existing, NOW + timedelta(seconds=delta_seconds), incoming)
    assert result is (allowed and delta_seconds >= 0)
    assert existing == original


@pytest.mark.parametrize("existing", [
    None, {}, {"source": "obsolete", "observed_at": NOW},
    {"source": "actual", "observed_at": None}, {"source": "actual", "observed_at": "2026-10-13"},
])
def test_valid_observation_can_initialize_missing_or_unusable_prior_state(existing):
    assert setup.should_replace_machine_state(existing, NOW, "derived") is True


@pytest.mark.parametrize("existing", [None, {"source": "actual", "observed_at": NOW}])
def test_unknown_source_is_rejected_even_when_no_prior_state_exists(existing):
    with pytest.raises(ValueError, match="Unknown machine-state source"):
        setup.should_replace_machine_state(existing, NOW, "imported")


@pytest.mark.parametrize("values, message", [
    ({"colorWheel": "RED"}, "missing setup fields"),
    ({"colorWheel": "RED", "prt01": "A", "prt02": "B"}, "outside the setup definition"),
    ([{"fieldKey": "colorWheel", "value": "RED"}, {"fieldKey": "colorWheel", "value": "BLUE"}],
     "Duplicate state field"),
    (["RED", "A"], "require fieldKey"),
    (None, "object or canonical key array"),
])
def test_canonical_state_rejects_ambiguous_or_incomplete_composite_keys(values, message):
    with pytest.raises(ValueError, match=message):
        setup.canonical_state_key(["colorWheel", "prt01"], values)


def test_canonical_array_input_is_reordered_by_definition_and_does_not_mutate_input():
    values = [{"fieldKey": "prt01", "value": " tool-x "}, {"fieldKey": "colorWheel", "value": " blue "}]
    original = deepcopy(values)
    assert setup.canonical_state_key(["colorWheel", "prt01"], values) == [
        {"fieldKey": "colorWheel", "value": "BLUE"}, {"fieldKey": "prt01", "value": "TOOL-X"},
    ]
    assert values == original


@pytest.mark.parametrize("blank", [None, "", " \t "])
def test_strict_matrix_import_rejects_blank_attribute_on_either_side(blank):
    for side in ("from", "to"):
        row = {"from": {"colorWheel": "RED"}, "to": {"colorWheel": "BLUE"}, "setup_min": 0}
        row[side]["colorWheel"] = blank
        with pytest.raises(ValueError, match="Blank setup-state"):
            setup.validate_matrix_rows(["colorWheel"], [row], strict_blanks=True)


def test_nonstrict_import_retains_blank_and_zero_as_distinct_canonical_states():
    rows = [{"from": {"colorWheel": None}, "to": {"colorWheel": 0}, "setup_min": 0,
             "source": "measured", "source_reference": "trial-1", "source_metadata": {"sample_count": 3}}]
    original = deepcopy(rows)
    assert setup.validate_matrix_rows(["colorWheel"], rows, strict_blanks=False) == [{
        "from_key": [{"fieldKey": "colorWheel", "value": ""}],
        "to_key": [{"fieldKey": "colorWheel", "value": "0"}],
        "setup_min": 0, "source": "measured", "source_reference": "trial-1",
        "source_metadata": {"sample_count": 3},
    }]
    assert rows == original


def test_opposite_matrix_directions_are_independent_not_duplicate_transitions():
    rows = [
        {"from": {"colorWheel": "RED"}, "to": {"colorWheel": "BLUE"}, "setup_min": 12},
        {"from": {"colorWheel": "BLUE"}, "to": {"colorWheel": "RED"}, "setup_min": 23},
    ]
    result = setup.validate_matrix_rows(["colorWheel"], rows)
    assert [r["setup_min"] for r in result] == [12, 23]
    assert result[0]["from_key"] == result[1]["to_key"]
    assert result[0]["to_key"] == result[1]["from_key"]


def test_composite_state_boundaries_do_not_collapse_when_values_contain_delimiters():
    rows = [
        {"from": {"colorWheel": "A|B", "prt01": "C"},
         "to": {"colorWheel": "D", "prt01": "E"}, "setup_min": 1},
        {"from": {"colorWheel": "A", "prt01": "B|C"},
         "to": {"colorWheel": "D", "prt01": "E"}, "setup_min": 2},
    ]
    result = setup.validate_matrix_rows(["colorWheel", "prt01"], rows)
    assert len(result) == 2
    assert result[0]["from_key"] != result[1]["from_key"]


@pytest.mark.parametrize("supplied", [True, False, "4", 4.0, None])
def test_signature_version_does_not_coerce_a_noninteger_client_token(supplied):
    with pytest.raises(ValueError, match="signature version is required"):
        setup.validate_signature_version(4, supplied)


def test_last_completed_order_includes_exact_boundary_and_ignores_missing_completion():
    rows = [{"id": "future", "completed_at": NOW + timedelta(microseconds=1)},
            {"id": "unknown", "completed_at": None},
            {"id": "boundary", "completed_at": NOW},
            {"id": "older", "completed_at": NOW - timedelta(microseconds=1)}]
    assert setup.last_completed_order(rows, NOW) is rows[2]
    assert setup.last_completed_order(rows[:2], NOW) is None
    assert setup.last_completed_order([], NOW) is None
