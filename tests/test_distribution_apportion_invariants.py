"""Deterministic stress cases for plant-scale distribution arithmetic.

These assert algebraic properties across many weights and machine counts,
including the 70-machine target, without relying on implementation examples.
"""

import random
from decimal import Decimal

import pytest

from backend.distribution.service import apportion


@pytest.mark.parametrize("machine_count", [1, 2, 5, 17, 70])
def test_exact_split_conserves_units_and_ignores_weight_scale_and_input_order(machine_count):
    rng = random.Random(20261013 + machine_count)
    names = [f"M{i:03d}" for i in range(machine_count)]
    for _ in range(40):
        total = Decimal(rng.randint(0, 100_000))
        weights = {name: Decimal(rng.randint(0, 500)) for name in names}
        if not any(weights.values()):
            weights[names[0]] = Decimal(1)
        snapshot = weights.copy()

        result = apportion(total, weights, Decimal(1))
        assert set(result) == set(names)
        assert all(value >= 0 and value == value.to_integral_value() for value in result.values())
        assert all(result[name] == 0 for name in names if weights[name] == 0)
        assert sum(result.values()) == total
        assert weights == snapshot

        scaled = {name: weight * 7 for name, weight in weights.items()}
        assert apportion(total, scaled, Decimal(1)) == result
        reversed_weights = dict(reversed(list(weights.items())))
        assert apportion(total, reversed_weights, Decimal(1)) == result


@pytest.mark.parametrize("machine_count", [2, 5, 17, 70])
def test_round_up_split_bounds_excess_to_less_than_one_unit_per_active_machine(machine_count):
    rng = random.Random(1701 + machine_count)
    names = [f"M{i:03d}" for i in range(machine_count)]
    for _ in range(40):
        total = Decimal(rng.randint(1, 100_000))
        weights = {name: Decimal(rng.randint(0, 500)) for name in names}
        if not any(weights.values()):
            weights[names[0]] = Decimal(1)
        active = sum(weight > 0 for weight in weights.values())

        result = apportion(total, weights, Decimal(1), round_up_remainder=True)
        assert all(value >= 0 and value == value.to_integral_value() for value in result.values())
        assert all(result[name] == 0 for name in names if weights[name] == 0)
        assert total <= sum(result.values()) < total + active
        assert apportion(-total, weights, Decimal(1), round_up_remainder=True) == {
            name: -value for name, value in result.items()}
