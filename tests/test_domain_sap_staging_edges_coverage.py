"""Calendar discontinuities and outbound rollup isolation at the SAP boundary."""
from copy import deepcopy
from datetime import date, datetime, time, timezone
from decimal import Decimal
from itertools import permutations

import pytest

from backend.integration import sap_staging as staging


@pytest.mark.parametrize("sap_day, sap_clock, local", [
    ("20260308", "065959", datetime(2026, 3, 8, 1, 59, 59)),
    ("20260308", "070000", datetime(2026, 3, 8, 3, 0)),
    ("20261101", "053000", datetime(2026, 11, 1, 1, 30)),
    ("20261101", "063000", datetime(2026, 11, 1, 1, 30, fold=1)),
    ("20270101", "010000", datetime(2026, 12, 31, 20)),
])
def test_utc_to_plant_conversion_handles_dst_and_year_rollover(sap_day, sap_clock, local):
    actual = staging.sap_to_plant_local(sap_day, sap_clock, "America/New_York", system_tz="UTC")
    assert actual == local
    assert actual.fold == local.fold
    assert actual.tzinfo is None


@pytest.mark.parametrize("fold, expected", [(0, time(5, 30)), (1, time(6, 30))])
def test_outbound_fall_back_hour_preserves_datetime_fold(fold, expected):
    local = datetime(2026, 11, 1, 1, 30, fold=fold)
    assert staging.plant_local_to_sap(local, "America/New_York", system_tz="UTC") == (date(2026, 11, 1), expected)


def test_aware_outbound_datetime_uses_its_timezone_and_truncates_subseconds():
    instant = datetime(2026, 10, 13, 12, 0, 1, 999999, tzinfo=timezone.utc)
    assert staging.plant_local_to_sap(instant, "Asia/Tokyo", system_tz="America/New_York") == (
        date(2026, 10, 13), time(8, 0, 1),
    )


@pytest.mark.parametrize("clock", [None, "", "000000", "00:00", "00:00:00", time.min])
def test_date_only_does_not_roll_to_previous_date_across_international_date_line(clock):
    assert staging.sap_to_plant_local("20260101", clock, "Pacific/Honolulu", system_tz="Pacific/Kiritimati") == (
        datetime(2026, 1, 1)
    )


def test_open_quantity_retains_decimal_precision_beyond_binary_float_resolution():
    assert staging.open_quantity("9007199254740993.01", "9007199254740993.00") == Decimal("0.01")


@pytest.mark.parametrize("invalid", ["Infinity", "-Infinity", Decimal("NaN"), "not-numeric"])
def test_open_quantity_refuses_nonfinite_and_malformed_reductions(invalid):
    with pytest.raises(ValueError, match="invalid number"):
        staging.open_quantity("12", invalid)


def _candidate(row_id, **overrides):
    return {"id": row_id, "production_order": f"PO-{row_id}", "parent_production_order": "PARENT",
            "material_number": "MAT", "production_version": "B", "planning_status": "scheduled",
            "manual_firmed": False, "firming_indicator": None,
            "placed_start": datetime(2026, 10, 13, 12), "placed_end": datetime(2026, 10, 13, 14),
            "eff_end": datetime(2026, 10, 13, 14), **overrides}


@pytest.mark.parametrize("skip_override", [{"eff_end": None}, {"planning_status": "needs_planning"}])
def test_skipped_child_never_contributes_firmness_version_or_finish(skip_override):
    # The skipped child is firmed but is not a candidate, so its firmness cannot make the (unfirmed) group sendable.
    rows = [_candidate("ok"), _candidate("skip", manual_firmed=True, production_version="A",
                                           eff_end=datetime(2026, 10, 14, 18))]
    rows[1].update(skip_override)
    original = deepcopy(rows)
    groups, skipped, unfirmed = staging.build_outbound_groups(rows, None)
    assert (skipped, unfirmed) == (1, 1)
    assert groups == []
    assert rows == original
    # With the candidate child firmed the group is sent; the skipped child still adds no finish or version.
    rows[0]["manual_firmed"] = True
    groups, skipped, unfirmed = staging.build_outbound_groups(rows, None)
    assert (skipped, unfirmed) == (1, 0)
    assert groups == [{"plnum": "PARENT", "matnr": "MAT", "end": datetime(2026, 10, 13, 14),
                       "auffx": "X", "verid": "B", "member_ids": ["ok", "skip"], "sent_ids": ["ok"],
                       "rolled_up": True, "nimbus_order_id": None}]


def test_group_with_only_skipped_children_is_omitted_and_counts_every_skipped_row():
    groups, skipped, unfirmed = staging.build_outbound_groups([
        _candidate("a", eff_end=None), _candidate("b", planning_status="needs_planning"),
    ], None)
    assert groups == []
    assert (skipped, unfirmed) == (2, 0)


def test_direct_orders_remain_distinct_by_both_order_number_and_material():
    rows = [_candidate("a", parent_production_order=None, production_order="PO1", material_number="M1",
                       manual_firmed=True),
            _candidate("b", parent_production_order=None, production_order="PO1", material_number="M2",
                       manual_firmed=True),
            _candidate("c", parent_production_order=None, production_order="PO2", material_number="M1",
                       manual_firmed=True)]
    groups, skipped, unfirmed = staging.build_outbound_groups(rows, None)
    assert (skipped, unfirmed) == (0, 0)
    assert {(g["plnum"], g["matnr"], g["nimbus_order_id"]) for g in groups} == {
        ("PO1", "M1", "a"), ("PO1", "M2", "b"), ("PO2", "M1", "c"),
    }
    assert all(g["rolled_up"] is False for g in groups)


def test_rollup_business_values_are_invariant_to_child_input_order():
    rows = [_candidate("a", production_version=" C "),
            _candidate("b", production_version="B", eff_end=datetime(2026, 10, 14, 16)),
            _candidate("c", production_version=None, firming_indicator=" x ")]
    for permuted in permutations(rows):
        groups, skipped, unfirmed = staging.build_outbound_groups(list(permuted), None)
        assert (skipped, unfirmed) == (0, 0)
        assert len(groups) == 1
        group = groups[0]
        assert (group["end"], group["verid"], group["auffx"]) == (datetime(2026, 10, 14, 16), "B", "X")
        assert set(group["member_ids"]) == set(group["sent_ids"]) == {"a", "b", "c"}


def test_frozen_horizon_is_exclusive_at_exact_finish_boundary():
    now = datetime(2026, 10, 13, 6)
    frozen_end = datetime(2026, 10, 13, 14)                               # the candidate's placed finish
    groups, _, unfirmed = staging.build_outbound_groups([_candidate("a")], frozen_end, now)
    assert groups == [] and unfirmed == 1                                 # finish == edge: not firmed, not sent
    groups, _, unfirmed = staging.build_outbound_groups([
        _candidate("a", placed_end=datetime(2026, 10, 13, 13, 59, 59, 999999)),
    ], frozen_end, now)
    assert groups[0]["auffx"] == "X" and unfirmed == 0
