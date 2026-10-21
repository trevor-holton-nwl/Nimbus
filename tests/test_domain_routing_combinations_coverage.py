"""Combined routing behavior with independent minute totals and isolation checks."""
from copy import deepcopy
from datetime import date
from decimal import Decimal

import pytest

from backend.routing import resolver


def _operation(activity="0010", **overrides):
    return {"activity": activity, "sequence_no": "0", "sequence_category": "0", "deleted": False,
            "sap_workcenter": "WC1", "control_key": "PP01", "header_status": "4",
            "workcenter_category": "0001", "base_quantity": Decimal("10"),
            "std_value_machine": Decimal("30"), "std_value_unit_machine": "MIN", **overrides}


@pytest.fixture
def routing_case():
    order = {"plant": "P1", "material_number": "MAT1", "production_version": "V1", "machine": "M1",
             "basic_start_date": date(2026, 10, 13), "order_quantity": Decimal("20")}
    pv = {"task_list_type": "N", "routing_group": "R1", "group_counter": "1", "sap_workcenter": "WC1",
          "valid_from": date(2026, 1, 1), "valid_to": date(2026, 12, 31),
          "lot_size_from": Decimal("10"), "lot_size_to": Decimal("30")}
    context = {"pv_lookup": {("P1", "MAT1", "V1"): pv},
               "op_lookup": {("P1", "MAT1", "N", "R1", "1"): [_operation()]},
               "machine_workcenter": {"M1": "WC1"}, "rules": {}}
    return order, context


def test_rounding_happens_once_after_summing_subminute_operations(routing_case):
    order, context = routing_case
    order["order_quantity"] = Decimal("10")
    context["op_lookup"][("P1", "MAT1", "N", "R1", "1")] = [
        _operation("0010", std_value_machine=Decimal("20"), std_value_unit_machine="SEC"),
        _operation("0020", std_value_machine=Decimal("20"), std_value_unit_machine="SEC"),
    ]
    result = resolver.resolve_one(order, **context)
    assert result["status"] == "resolved"
    assert result["run_time"] == Decimal(1) / Decimal(60)
    assert len(result["run_time_basis"]["operations"]) == 2


def test_machine_and_labor_operations_select_their_own_time_column(routing_case):
    order, context = routing_case
    context["op_lookup"][("P1", "MAT1", "N", "R1", "1")] = [
        _operation("0010", std_value_labor=Decimal("999"), std_value_unit_labor="H"),
        _operation("0020", workcenter_category="0003", std_value_labor=Decimal("900"),
                   std_value_unit_labor="SEC", std_value_machine=Decimal("999"), std_value_unit_machine="H"),
    ]
    original = deepcopy((order, context))
    result = resolver.resolve_one(order, **context)
    assert result["status"] == "resolved"
    assert result["run_time"] == Decimal("1.5")
    assert [op["hours"] for op in result["run_time_basis"]["operations"]] == [1.0, 0.5]
    assert (order, context) == original


def test_partial_operation_failures_are_reported_without_losing_valid_runtime(routing_case):
    order, context = routing_case
    context["op_lookup"][("P1", "MAT1", "N", "R1", "1")] += [
        _operation("0020", workcenter_category="0002"),
        _operation("0030", base_quantity=Decimal(0)),
        _operation("0040", std_value_unit_machine="EA"),
    ]
    result = resolver.resolve_one(order, **context)
    assert result["run_time"] == Decimal(1)
    assert [(op["activity"], op["reason"]) for op in result["run_time_basis"]["skipped_operations"]] == [
        ("0020", "other_category"), ("0030", "invalid_base_quantity"), ("0040", "unit_not_time"),
    ]


@pytest.mark.parametrize("source", [None, "routing", "sap_order", "distributed", "legacy"])
def test_failed_resolution_never_reuses_stale_nonmanual_runtime(routing_case, source):
    order, context = routing_case
    order.update(production_version="missing", run_time=Decimal("99"), run_time_source=source)
    result = resolver.resolve_one(order, **context)
    assert result == {"status": "held", "reason_code": "runtime_unknown", "detail_step": "pv_not_found"}


def test_machine_hours_fallback_precedes_a_manual_runtime(routing_case):
    order, context = routing_case
    order.update(production_version="missing", machine_hours=Decimal("2.5"),
                 run_time=Decimal("99"), run_time_source="manual")
    assert resolver.resolve_one(order, **context) == {
        "status": "fallback_sap_order", "run_time": Decimal("2.5"),
        "run_time_source": "sap_order", "reason_code": "pv_not_found",
    }


@pytest.mark.parametrize("quantity, warning", [(9, True), (10, False), (30, False), (31, True)])
def test_lot_range_boundaries_warn_without_blocking_valid_routing(routing_case, quantity, warning):
    order, context = routing_case
    order["order_quantity"] = Decimal(quantity)
    result = resolver.resolve_one(order, **context)
    assert result["status"] == "resolved"
    assert result["lot_size_warning"] is warning
    assert result["run_time_basis"]["lot_size_warning"] is warning


@pytest.mark.parametrize("foreign_key", [
    ("P2", "MAT1", "N", "R1", "1"), ("P1", "MAT2", "N", "R1", "1"),
    ("P1", "MAT1", "R", "R1", "1"), ("P1", "MAT1", "N", "R1", "2"),
])
def test_routing_lookup_never_borrows_operations_across_composite_identity(routing_case, foreign_key):
    order, context = routing_case
    context["op_lookup"] = {foreign_key: [_operation()]}
    assert resolver.resolve_one(order, **context) == {
        "status": "held", "reason_code": "runtime_unknown", "detail_step": "no_routing",
    }


def test_filtered_operations_do_not_inflate_runtime_or_appear_as_calculation_skips(routing_case):
    order, context = routing_case
    context["rules"] = {"control_key_exclude": {"EXCL"}, "header_status_include": {"4"}}
    context["op_lookup"][("P1", "MAT1", "N", "R1", "1")] += [
        _operation("0020", deleted=True), _operation("0030", sequence_category="1"),
        _operation("0040", sap_workcenter="WC2"), _operation("0050", control_key="EXCL"),
        _operation("0060", header_status="1"),
    ]
    result = resolver.resolve_one(order, **context)
    assert result["run_time"] == Decimal(1)
    assert [op["activity"] for op in result["run_time_basis"]["operations"]] == ["0010"]
    assert result["run_time_basis"]["skipped_operations"] == []
