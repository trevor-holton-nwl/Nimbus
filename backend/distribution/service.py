"""
NIMBUS Order Distribution — pure service functions for ingest and materialization.

Pure functions (no DB connection, operate on plain dicts/rows passed in as arguments)
implementing the algorithms from aggregate_to_detail.md §5.1–§5.7:
  - Plant resolution (§5.1 step 2)
  - Row classification (§5.1 step 3)
  - Default-share precedence (§5.2)
  - Letter assignment (§5.3 bullet 1)
  - Hamilton / largest-remainder apportionment (§5.3 bullet "Quantity apportionment")
  - Derived-status computation (§5.7 first bullet)

Unit-testable without a DB connection; called from backend/distribution/data.py
and the ingest post-hook in db.py.
"""

from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Optional

# Exact match to frontend/nimbus-compute-core.js:391 — parity test in test_distribution.py
TOOL_PLACEHOLDERS = {'', '-', '0', 'N/A', 'NONE', 'NULL'}


def resolve_plant(
    row: dict,
    machine_lookup: dict[str, dict],  # {plant: {machine_name: {...}}}
    workcenter_lookup: dict[str, dict],  # {plant: {wc_code: {...}}}
) -> tuple[str, Optional[str]]:
    """
    Resolve the plant for an inbound row (§5.1 step 2).

    Given a row's PLANT|WERKS value, a machine-value X, and lookup dicts,
    resolve the plant via:
      1. the row's own plant field
      2. else the unique plant across machine rows matching X
      3. else the unique plant across sap_workcenter rows matching X
      4. else return None with warning code 'ambiguous_workcenter_plant'

    Returns:
      (plant: str, warning_code: str | None)
    """
    row_plant = row.get("plant")
    if row_plant and isinstance(row_plant, str) and row_plant.strip():
        return row_plant.strip(), None

    machine_value = row.get("machine")
    if not machine_value:
        return None, "ambiguous_workcenter_plant"

    # Find plants where this machine_value exists in the machine table
    machines_plants = set()
    for plant, machines_dict in machine_lookup.items():
        if machine_value in machines_dict:
            machines_plants.add(plant)

    if len(machines_plants) == 1:
        return machines_plants.pop(), None

    # Find plants where this machine_value exists in sap_workcenter
    workcenters_plants = set()
    for plant, wc_dict in workcenter_lookup.items():
        if machine_value in wc_dict:
            workcenters_plants.add(plant)

    if len(workcenters_plants) == 1:
        return workcenters_plants.pop(), None

    # Ambiguous
    return None, "ambiguous_workcenter_plant"


def classify_row(
    plant: str,
    machine_value: str,
    machine_by_plant: dict[str, dict],  # {plant: {machine_name: {...}}}
    workcenter_by_plant: dict[str, dict],  # {plant: {wc_code: {distribution_mode, default_machine, members: []}}}
) -> dict[str, Any]:
    """
    Classify a row based on its machine/work-center value (§5.1 step 3).

    Returns a dict with:
      {
        'type': 'plain' | 'single_rewrite' | 'distribute' | 'distribute_no_members',
        'machine': rewritten machine name (for single_rewrite) or original,
        'warnings': list of warning codes,
      }
    """
    if not plant or not machine_value:
        return {"type": "plain", "machine": machine_value, "warnings": []}

    machines_dict = machine_by_plant.get(plant, {})
    workcenters_dict = workcenter_by_plant.get(plant, {})

    # Check if it's a plain machine
    if machine_value in machines_dict:
        return {"type": "plain", "machine": machine_value, "warnings": []}

    # Check if it's a work center
    if machine_value in workcenters_dict:
        wc = workcenters_dict[machine_value]
        mode = wc.get("distribution_mode", "single")
        members = wc.get("members", [])

        if mode == "single":
            default_machine = wc.get("default_machine")
            if default_machine and default_machine in machines_dict:
                # Valid single-mode rewrite
                return {
                    "type": "single_rewrite",
                    "machine": default_machine,
                    "warnings": [],
                }
            else:
                # Invalid default machine
                return {
                    "type": "plain",
                    "machine": machine_value,
                    "warnings": ["default_machine_invalid"],
                }
        else:  # distribute mode
            if len(members) == 0:
                return {
                    "type": "distribute_no_members",
                    "machine": machine_value,
                    "warnings": ["workcenter_without_members"],
                }
            else:
                return {
                    "type": "distribute",
                    "machine": machine_value,
                    "warnings": [],
                }

    # Unknown line
    return {"type": "plain", "machine": machine_value, "warnings": []}


def compute_default_shares(
    material_attrs: dict[str, Any],
    workcenter: dict[str, Any],
    members: list[tuple[str, Optional[Decimal]]],  # [(machine_name, distribution_weight), ...]
) -> tuple[dict[str, Decimal], str]:
    """
    Compute default-share precedence (§5.2, §2 derived rules).

    Given a material's attributes and a work center's policy, compute the
    default weights for each member.

    Returns:
      ({machine: weight, ...}, default_basis_code)

    where default_basis_code is one of:
      'material_default', 'tooled_single', 'workcenter_weights'
    """
    member_names = [m[0] for m in members]
    member_weights = {m[0]: m[1] for m in members}

    # Rule 1: Material default machine
    material_default = material_attrs.get("default_machine")
    if material_default and material_default in member_names:
        return (
            {m: Decimal(100) if m == material_default else Decimal(0) for m in member_names},
            "material_default",
        )

    # Rule 2: Tooled single
    prt_01 = material_attrs.get("prt_01")
    prt_02 = material_attrs.get("prt_02")
    is_tooled = (
        (prt_01 and isinstance(prt_01, str) and prt_01.upper() not in TOOL_PLACEHOLDERS)
        or (prt_02 and isinstance(prt_02, str) and prt_02.upper() not in TOOL_PLACEHOLDERS)
    )

    if is_tooled and not workcenter.get("distribute_tooled"):
        wc_default = workcenter.get("default_machine")
        if wc_default and wc_default in member_names:
            single_machine = wc_default
        else:
            single_machine = member_names[0] if member_names else None

        if single_machine:
            return (
                {m: Decimal(100) if m == single_machine else Decimal(0) for m in member_names},
                "tooled_single",
            )

    # Rule 3: Work-center weights (NULL-weight rule)
    result_weights = {}
    has_any_weight = any(w is not None for w in member_weights.values())

    if has_any_weight:
        # Any member with a weight, NULLs become 0
        for m in member_names:
            w = member_weights.get(m)
            result_weights[m] = Decimal(w) if w is not None else Decimal(0)
    else:
        # All NULL: even split
        for m in member_names:
            result_weights[m] = Decimal(1)

    return result_weights, "workcenter_weights"


def assign_letters(members: list[str]) -> dict[str, str]:
    """
    Assign letters A, B, C, ..., Z, AA, AB, ... to members (§5.3 bullet 1).

    Given an alphabetically-sorted list of member machine names, assign
    spreadsheet-style letters. Gaps are allowed for zero-weight members
    (letters are assigned to ALL members, not just positive-weight ones).

    Returns:
      {machine_name: letter}
    """
    letters = {}
    for i, machine in enumerate(members):
        letters[machine] = _index_to_letter(i)
    return letters


def _index_to_letter(index: int) -> str:
    """Convert 0-based index to letter: 0->A, 1->B, ..., 25->Z, 26->AA, ..."""
    result = ""
    index += 1  # Make it 1-based
    while index > 0:
        index -= 1
        result = chr(ord('A') + (index % 26)) + result
        index //= 26
    return result


def apportion(
    total: Decimal,
    weights: dict[str, Decimal],
    unit: Decimal,
    tie_order: Optional[list[str]] = None,
    *,
    round_total: bool = False,
    round_up_remainder: bool = False,
) -> dict[str, Decimal]:
    """
    Hamilton / largest-remainder apportionment (§5.3 bullet "Quantity apportionment").

    Divides `total` into per-machine shares proportional to `weights`, rounded down
    to whole multiples of `unit`, with the remainder distributed one-unit-at-a-time
    to the machines with the largest fractional remainder (ties broken by alphabetical
    order of machine name, or the provided tie_order).

    Handles:
      - unit not evenly dividing total (remainder goes to largest fractional share)
      - total smaller than number of positive-weight shares (some shares end up 0)
      - reuse for both quantity apportionment and run-time apportionment

    D53: `total` carrying more decimal precision than `unit` (e.g. labor/
    machine hours) silently overshoots by up to one unit when the
    floor-then-largest-remainder loop below is left with a leftover that
    isn't itself a clean multiple of `unit` (2.3333 split three ways in 0.01
    units summed to 2.34, not 2.33). `round_total=True` (opt-in, default
    False) rounds `total` to the nearest whole multiple of `unit`
    (ROUND_HALF_UP) FIRST to fix that -- gated behind a flag because the
    QUANTITY path calls this same function with `unit = incremental_lot_size`
    (historically a lot-size split; since superseded by `round_up_remainder`,
    H6), and unconditionally rounding there would silently change quantity
    split results. Only the labor_hours/machine_hours callers
    (`data.py::_build_child_rows`) pass `round_total=True`; the quantity and
    run-time-minutes callers are byte-for-byte unchanged from base
    behavior. A negative total is handled symmetrically regardless of
    `round_total` (apportion the positive magnitude, then negate every
    result) rather than raising -- this function must never raise, since
    `plan_fn` runs outside `upsert_orders`' `try`.

    H6 / owner rule (aggregate_to_detail.md decision H, 2026-09-25 rev. 4):
    `round_up_remainder=True` (QUANTITY apportionment only) skips the
    largest-remainder step -- every machine's ideal share rounds UP,
    independently, to the next whole multiple of `unit` when it is not
    already one. The shares can therefore sum to MORE than `total` (by less
    than one `unit` per fractional share: 1,031 split evenly = 516 + 516 =
    1,032). That is intended, not a bug. The run-time/labor/machine-hours
    callers never pass it and keep their exact-sum behavior.

    Returns:
      {machine: quantity_in_units}
    """
    if total < 0:
        negated = apportion(-total, weights, unit, tie_order, round_total=round_total,
                            round_up_remainder=round_up_remainder)
        return {m: -v for m, v in negated.items()}

    if not weights or all(w == 0 for w in weights.values()):
        return {m: Decimal(0) for m in weights}

    if round_total:
        total = (total / unit).to_integral_value(rounding=ROUND_HALF_UP) * unit

    # Normalize weights
    total_weight = sum(w for w in weights.values() if w > 0)
    if total_weight == 0:
        return {m: Decimal(0) for m in weights}

    # Compute ideal shares (may be fractional)
    ideal_shares = {}
    for machine, weight in weights.items():
        if weight > 0:
            ideal_shares[machine] = (total * weight) / total_weight
        else:
            ideal_shares[machine] = Decimal(0)

    if round_up_remainder:
        # Each fractional share rounds up independently; an exact multiple of
        # `unit` is left as-is; a zero-weight machine stays 0.
        allocations = {}
        for machine, share in ideal_shares.items():
            if share <= 0:
                allocations[machine] = Decimal(0)
                continue
            allocation = (share // unit) * unit
            if share - allocation > 0:
                allocation += unit
            allocations[machine] = allocation
        return allocations

    # Round down to whole multiples of unit
    allocations = {}
    remainders = {}
    remaining_total = total

    for machine in sorted(ideal_shares.keys()):
        share = ideal_shares[machine]
        whole_units = int(share / unit)
        allocation = whole_units * unit
        allocations[machine] = allocation
        remaining_total -= allocation
        remainders[machine] = share - allocation

    # Distribute remainder one unit at a time to largest fractional remainders
    if remaining_total > 0:
        # Sort by remainder (descending), then by tie_order or alphabetical
        if tie_order is None:
            tie_order = sorted(allocations.keys())

        machines_by_remainder = sorted(
            allocations.keys(),
            key=lambda m: (-remainders.get(m, Decimal(0)), tie_order.index(m) if m in tie_order else float('inf')),
        )

        for machine in machines_by_remainder:
            if remaining_total <= 0:
                break
            allocations[machine] += unit
            remaining_total -= unit

    return allocations


def compute_derived_statuses(
    header: dict[str, Any],
    shares: list[dict[str, Any]],
    children: list[dict[str, Any]],
    workcenter: Optional[dict[str, Any]],
    machines: dict[str, dict[str, Any]],
) -> set[str]:
    """
    Compute derived statuses at read time (§5.7 first bullet).

    Given a header's current facts, shares, children summary, and master data,
    return the set of applicable status codes:
      'needs_review', 'qty_changed', 'incomplete', 'mode_mismatch',
      'wc_changed', 'membership_changed', 'below_min_lot',
      'zero_quantity_children', 'purged', 'runtime_mismatch'

    Returns:
      set of status code strings
    """
    statuses = set()

    # needs_review: reviewed = false
    if not header.get("reviewed"):
        statuses.add("needs_review")

    # qty_changed: reviewed header with order_quantity != reviewed_quantity.
    # D16: a NULL reviewed_quantity (never stamped) must never compare
    # unequal to a real order_quantity and falsely fire qty_changed.
    if (header.get("reviewed") and header.get("reviewed_quantity") is not None
            and header.get("order_quantity") != header.get("reviewed_quantity")):
        statuses.add("qty_changed")

    # incomplete: positive, unpurged share has no living child, or child exists with no share
    share_ids = {(s.get("machine"),): s for s in shares if s.get("weight", 0) > 0 and not s.get("purged_at")}
    child_ids = {(c.get("machine"),): c for c in children}
    for machine in share_ids:
        if machine not in child_ids:
            statuses.add("incomplete")
            break
    for machine in child_ids:
        if machine not in share_ids:
            statuses.add("incomplete")
            break

    # mode_mismatch: work center now in 'single' mode
    if workcenter is not None and workcenter.get("distribution_mode") == "single":
        statuses.add("mode_mismatch")

    # wc_changed: sap_facts.previous_workcenter is set
    sap_facts = header.get("sap_facts") or {}
    if sap_facts.get("previous_workcenter"):
        statuses.add("wc_changed")

    # membership_changed: positive share's machine no longer a member, or member has no share
    if workcenter is not None:
        wc_members = set(machines.keys())
        for share in shares:
            machine = share.get("machine")
            if share.get("weight", 0) > 0 and machine not in wc_members:
                statuses.add("membership_changed")
                break
        for machine in wc_members:
            if not any(s.get("machine") == machine for s in shares):
                statuses.add("membership_changed")
                break

    # below_min_lot: child below minimum lot size
    for child in children:
        if child.get("below_min_lot"):
            statuses.add("below_min_lot")
            break

    # zero_quantity_children: child with quantity = 0
    for child in children:
        if child.get("order_quantity") == 0:
            statuses.add("zero_quantity_children")
            break

    # purged: any share with purged_at set
    for share in shares:
        if share.get("purged_at"):
            statuses.add("purged")
            break

    # runtime_mismatch: any child with runtime_schedule_mismatch
    for child in children:
        if child.get("runtime_schedule_mismatch"):
            statuses.add("runtime_mismatch")
            break

    return statuses
