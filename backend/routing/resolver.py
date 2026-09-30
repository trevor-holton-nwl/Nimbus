"""
NIMBUS 2.0 -- Routing run-time resolver (ROUTING_RUNTIME_DESIGN.md §5).

P2 slice: pure functions over plain dict rows -- unit-testable without a DB,
per the design's own framing -- plus a thin DB wrapper, `resolve_orders`,
that loads one plant's in-scope orders + reference data ONCE, runs the pure
functions over each order in Python, and writes outcomes back in a small,
fixed number of set-based UPDATEs (never one execute() per order).

Reproduces ROUTING_RUNTIME_DESIGN.md §5.1-§5.6 exactly:
  - §5.2 steps 1-8 and their failure codes -> the shared `_resolve_steps`
    helper, wrapped by `resolve_one` (+ `_fallback`) for a real order and by
    `check_eligibility` (no fallback) for a hypothetical candidate
    combination (§8.5) -- ONE step implementation, never two that could
    drift apart.
  - §5.3 unit conversion -> `_to_hours`.
  - §5.4 the per-operation formula + minute rounding -> `_pick_operation_hours`
    / `_round_to_minute`.
  - §5.5 outcome writes (set-based, change-only, cutover re-place/keep-in-
    place) -> `resolve_orders` + its `_write_outcomes`/`_write_holds` helpers.
  - §5.6 the recompute report -> `resolve_orders`' return value.
  - §8.5 the write-time eligibility gate -> `check_eligibility`, called from
    `backend/scheduling/db.update_task_dates_bulk` inside its own open
    transaction (this module never writes for it).

`resolve_orders(plant, *, conn=None)` is the shape a LATER task wires into
`db.upsert_orders`'s `resolve_fn` seam (see that function's docstring) --
this task only has to make the signature and conn-reuse behavior match;
the actual wiring is out of scope here.

Judgment calls made while implementing this (flagged for review -- see each
one's inline comment for the reasoning):
  1. `_within_validity`: a `None` basic_start_date can't be checked either
     way -- treated as within validity rather than fail-closed.
  2. `_pick_operation_hours`: a falsy/zero `base_quantity` skips that one
     operation (`invalid_base_quantity`) rather than raising -- the design
     doesn't explicitly cover this, but crashing the whole order's resolve
     over one bad operation row would be worse.
  3. Cutover detection (`resolve_orders`): "this plant has zero orders with
     run_time_source = 'routing' yet" -- there's no explicit "first cutover"
     flag on `plants`, so this is inferred.
  4. Cutover re-placement for a normal (non-firmed, non-frozen) already-
     scheduled order reuses the EXISTING `runtime_schedule_mismatch` flag +
     `_EFF_END_SQL`/`_EFF_END_WITH_RUNTIME_MISMATCH_SQL` mechanism (db.py)
     rather than computing a new `scheduled_end` directly. No re-place/
     resequence helper exists anywhere in backend/scheduling/ (only a
     frontend one, `Engine.manualSchedulePatchFor`) -- and this flag IS the
     system's already-documented answer to "a schedule's run_time changed,
     re-place its bar" (ROUTING_RUNTIME_DESIGN.md §4 item 6: "The resolver's
     write is the only thing allowed to set runtime_schedule_mismatch, and
     only when the number it writes actually differs from what's stored").
     A firmed/frozen-window order NEVER gets this flag and NEVER has its
     scheduled_start/scheduled_end touched -- it keeps its exact stored
     schedule, full stop, and is reported in `orders_kept_in_place`.
  5. A `fallback_legacy` outcome only WRITES (relabels `run_time_source` to
     'legacy') when the order's CURRENT `run_time_source` is NULL. An order
     that already carries a real label (manual/distributed/sap_order/
     legacy) is genuinely left untouched -- matching §5.5's "left
     untouched, no flag" wording for that specific branch (as opposed to
     the order-file-machine-hours fallback branch, which always writes,
     since that's a fresh number rather than a retained one).
  6. Held-outcome writes clear `scheduled_start`/`scheduled_end` alongside
     `planning_status`/`planning_reason` -- required by the existing
     `orders_planning_state_check` CHECK constraint (schema.sql), which
     requires both NULL whenever planning_status = 'needs_planning'. This
     mirrors db.py's own `update_task_dates_bulk` "queued" branch.
  7. Orders join production_version/routing_operation via
     orders.material_number == production_version.material_id -- the same
     business material code under two different column names (historical),
     confirmed against schema.sql/migrations, not merely assumed.
"""
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from psycopg.types.json import Jsonb

import db
from db import _pool

# ---------------------------------------------------------------------------
# §5.3 units -- hour-equivalent units convert at x1, minutes at 1/60, seconds
# at 1/3600; any other (or missing) unit means the value isn't a time at all.
# ---------------------------------------------------------------------------
_HOUR_UNITS = frozenset({"H", "HR", "HRS", "HOUR", "HOURS"})
_MINUTE_UNITS = frozenset({"MIN", "MINS", "MINUTE", "MINUTES"})
_SECOND_UNITS = frozenset({"S", "SEC", "SECS", "SECOND", "SECONDS"})

# §5.2's failure-step vocabulary -- shared between resolve_one's fallback
# chain (as `reason_code`/`detail_step`) and resolve_orders' held-outcome
# write guard, which only lets a fresh resolve overwrite a hold that is
# EITHER unset OR already one of these routing-specific steps (never some
# other subsystem's hold reason).
ROUTING_HOLD_STEPS = frozenset({
    "pv_missing", "pv_not_found", "pv_expired", "no_machine",
    "workcenter_unmapped", "no_routing", "no_operation_at_workcenter",
    "zero_runtime",
})


# ===========================================================================
# Pure functions (§5.1-§5.4) -- no DB access, unit-testable directly.
# ===========================================================================
def _to_hours(value, unit: str | None) -> Decimal | None:
    """§5.3: convert one operation's std-value/unit pair to hours. Returns
    None when `value` is missing/unparseable or `unit` isn't a recognized
    time unit -- the caller treats either as `unit_not_time` and skips just
    that operation, never the whole order."""
    if value is None:
        return None
    try:
        dec_value = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    unit_norm = (unit or "").strip().upper()
    if unit_norm in _HOUR_UNITS:
        return dec_value
    if unit_norm in _MINUTE_UNITS:
        return dec_value / Decimal(60)
    if unit_norm in _SECOND_UNITS:
        return dec_value / Decimal(3600)
    return None


def _pick_operation_hours(op: dict, order_quantity) -> tuple[Decimal | None, str | None]:
    """§5.2 step 7 / §5.4: pick the one value/unit pair this operation's
    work-center category counts (0001 -> machine, 0003 -> labor; anything
    else is skipped), scale by order_quantity / base_quantity.

    Returns (hours, None) on success, or (None, skip_reason) when this ONE
    operation must be skipped and reported -- never fatal to the order as a
    whole (§5.2's own framing: "filtering, not a failure by itself" for step
    7; a partial skip is recorded in run_time_basis, not raised).
    """
    category = op.get("workcenter_category")
    if category == "0001":
        raw_value, unit = op.get("std_value_machine"), op.get("std_value_unit_machine")
    elif category == "0003":
        raw_value, unit = op.get("std_value_labor"), op.get("std_value_unit_labor")
    else:
        return None, "other_category"

    base_quantity = op.get("base_quantity")
    if not base_quantity:
        # Judgment call #2 (module docstring): the design doesn't explicitly
        # cover a zero/blank base_quantity -- skip this one operation and
        # report it rather than dividing by zero and failing the order.
        return None, "invalid_base_quantity"

    hours = _to_hours(raw_value, unit)
    if hours is None:
        return None, "unit_not_time"

    qty = Decimal(0) if order_quantity is None else (
        order_quantity if isinstance(order_quantity, Decimal) else Decimal(str(order_quantity)))
    base_q = base_quantity if isinstance(base_quantity, Decimal) else Decimal(str(base_quantity))
    try:
        return hours * qty / base_q, None
    except (InvalidOperation, ValueError, ZeroDivisionError):
        return None, "invalid_base_quantity"


def _select_operations(operations: list[dict], workcenter: str, rules: dict) -> list[dict]:
    """§5.2 step 6: not deleted, standard sequence, at the machine's work
    center, control key not excluded, and -- only when the plant has at
    least one header_status-include rule -- header status included.

    `rules` is `{'control_key_exclude': frozenset[str], 'header_status_include':
    frozenset[str]}` as built by resolve_orders' `_load_rules`.
    """
    exclude_control_keys = rules.get("control_key_exclude") or frozenset()
    include_statuses = rules.get("header_status_include") or frozenset()
    selected = []
    for op in operations:
        if op.get("deleted"):
            continue
        if (op.get("sequence_category") or "0") != "0":
            continue
        if op.get("sap_workcenter") != workcenter:
            continue
        if op.get("control_key") in exclude_control_keys:
            continue
        if include_statuses and op.get("header_status") not in include_statuses:
            continue
        selected.append(op)
    return selected


def _round_to_minute(total_hours: Decimal) -> Decimal:
    """§5.4: "rounded to the nearest minute" -- round(total_hours * 60) / 60,
    entirely in Decimal so the pure functions never touch a float."""
    minutes = (total_hours * Decimal(60)).to_integral_value(rounding=ROUND_HALF_UP)
    return minutes / Decimal(60)


def _within_validity(basic_start, valid_from, valid_to) -> bool:
    """§5.2 step 3 / D8: valid_from/valid_to bound the order's SAP basic
    start date, inclusive; a NULL bound is open. Judgment call #1 (module
    docstring): a None basic_start_date can't be checked either way, so it's
    treated as within validity rather than failing closed."""
    if basic_start is None:
        return True
    start_date = basic_start.date() if hasattr(basic_start, "date") else basic_start
    if valid_from is not None and start_date < valid_from:
        return False
    return valid_to is None or start_date <= valid_to


def _fallback(order: dict, reason_code: str) -> dict:
    """§5.2's fallback order, used whenever steps 2-8 fail: (1) the order
    file's machine-hours value, always read as machine time, source
    'sap_order'; (2) the order's existing run_time, source 'legacy'; (3)
    otherwise hold in Needs Planning with the real failing step recorded.
    Step 1 (a missing production version) never reaches this function --
    resolve_one returns its own hold directly for that case, per D4."""
    machine_hours = order.get("machine_hours")
    if machine_hours:
        return {
            "status": "fallback_sap_order",
            "run_time": machine_hours,
            "run_time_source": "sap_order",
            "reason_code": reason_code,
        }
    existing_run_time = order.get("run_time")
    if existing_run_time:
        return {
            "status": "fallback_legacy",
            "run_time": existing_run_time,
            "run_time_source": "legacy",
            "reason_code": reason_code,
        }
    return {"status": "held", "reason_code": "runtime_unknown", "detail_step": reason_code}


def _resolve_steps(order: dict, *, pv_lookup: dict, op_lookup: dict,
                   machine_workcenter: dict, rules: dict) -> dict:
    """§5.2 steps 1-8 + §5.4's formula + the lot-size warning, over one
    order's plain dict row -- the literal step/failure-code logic, with NO
    fallback wrapping. Shared by `resolve_one` (which wraps a step failure
    in `_fallback`, since a real order may have an order-file machine-hours
    value or an existing run_time to fall back to) and `check_eligibility`
    (§8.5 -- which reports a step failure directly, with no fallback at
    all, since a hypothetical candidate combination has neither of those to
    fall back to). Keeping this logic in ONE place is deliberate: the two
    callers must never independently drift on what "eligible" means.

    `order['production_version']` is assumed ALREADY resolved to its final
    value (the order's own edit, or the Material Plant default, per D3/§4
    item 2 -- this function never reads material_plants itself).

    `pv_lookup`: {(plant, material_id, production_version): row}
    `op_lookup`: {(plant, material_id, task_list_type, routing_group,
                   group_counter): [operation_row, ...]}
    `machine_workcenter`: {machine: sap_workcenter_or_None}
    `rules`: see `_select_operations`.

    Returns one of:
      {"ok": False, "step": <failure code>}   -- §5.2's own vocabulary:
        pv_missing, pv_not_found, pv_expired, no_machine, workcenter_unmapped,
        no_routing, no_operation_at_workcenter, zero_runtime.
      {"ok": True, "run_time": Decimal, "run_time_basis": {...},
       "lot_size_warning": bool}
    """
    pv_value = order.get("production_version")
    if not pv_value:
        # Step 1: caller decides what "no fallback" means for it -- D4: a
        # missing production version always holds/fails, no guess.
        return {"ok": False, "step": "pv_missing"}

    plant = order.get("plant")
    material = order.get("material_number")
    pv_row = pv_lookup.get((plant, material, pv_value))
    if pv_row is None:
        return {"ok": False, "step": "pv_not_found"}

    if not _within_validity(order.get("basic_start_date"), pv_row.get("valid_from"), pv_row.get("valid_to")):
        return {"ok": False, "step": "pv_expired"}

    machine = order.get("machine")
    if not machine:
        return {"ok": False, "step": "no_machine"}
    workcenter = machine_workcenter.get(machine)
    if not workcenter:
        return {"ok": False, "step": "workcenter_unmapped"}

    routing_key = (plant, material, pv_row.get("task_list_type"),
                   pv_row.get("routing_group"), pv_row.get("group_counter"))
    operations = op_lookup.get(routing_key)
    if not operations:
        return {"ok": False, "step": "no_routing"}

    selected = _select_operations(operations, workcenter, rules)
    if not selected:
        return {"ok": False, "step": "no_operation_at_workcenter"}

    total_hours = Decimal(0)
    op_breakdown: list[dict] = []
    skipped_ops: list[dict] = []
    order_quantity = order.get("order_quantity")
    for op in selected:
        hours, skip_reason = _pick_operation_hours(op, order_quantity)
        if skip_reason:
            skipped_ops.append({
                "activity": op.get("activity"),
                "sequence_no": op.get("sequence_no"),
                "category": op.get("workcenter_category"),
                "reason": skip_reason,
            })
            continue
        total_hours += hours
        op_breakdown.append({
            "activity": op.get("activity"),
            "sequence_no": op.get("sequence_no"),
            "category": op.get("workcenter_category"),
            "hours": float(hours),
        })

    rounded_hours = _round_to_minute(total_hours)
    if rounded_hours <= 0:
        return {"ok": False, "step": "zero_runtime"}

    lot_from, lot_to = pv_row.get("lot_size_from"), pv_row.get("lot_size_to")
    lot_size_warning = bool(
        order_quantity is not None and (lot_from is not None or lot_to is not None)
        and ((lot_from is not None and order_quantity < lot_from)
             or (lot_to is not None and order_quantity > lot_to))
    )

    basis = {
        "production_version": pv_value,
        "routing_key": {
            "task_list_type": pv_row.get("task_list_type"),
            "routing_group": pv_row.get("routing_group"),
            "group_counter": pv_row.get("group_counter"),
        },
        "workcenter": workcenter,
        "machine": machine,
        "operations": op_breakdown,
        "skipped_operations": skipped_ops,
        "total_hours": float(rounded_hours),
        "lot_size_warning": lot_size_warning,
    }
    return {"ok": True, "run_time": rounded_hours, "run_time_basis": basis,
            "lot_size_warning": lot_size_warning}


def resolve_one(order: dict, *, pv_lookup: dict, op_lookup: dict,
                machine_workcenter: dict, rules: dict) -> dict:
    """§5.2 steps 1-8 + §5.4's formula + the lot-size warning, over one
    order's plain dict row -- see `_resolve_steps` for the shared step
    logic; this wraps a step failure in `_fallback` (order-file machine-
    hours, then existing run_time, then hold) exactly as §5.2 specifies.

    `order['production_version']` is assumed ALREADY resolved to its final
    value (the order's own edit, or the Material Plant default, per D3/§4
    item 2 -- this function never reads material_plants itself).

    `pv_lookup`: {(plant, material_id, production_version): row}
    `op_lookup`: {(plant, material_id, task_list_type, routing_group,
                   group_counter): [operation_row, ...]}
    `machine_workcenter`: {machine: sap_workcenter_or_None}
    `rules`: see `_select_operations`.

    Returns one of:
      {"status": "held", "reason_code": "pv_missing"}
      {"status": "held", "reason_code": "runtime_unknown", "detail_step": <step>}
      {"status": "fallback_sap_order"|"fallback_legacy", "run_time": ...,
       "run_time_source": ..., "reason_code": <step>}
      {"status": "resolved", "run_time": Decimal, "run_time_source": "routing",
       "run_time_basis": {...}, "lot_size_warning": bool}
    """
    steps = _resolve_steps(order, pv_lookup=pv_lookup, op_lookup=op_lookup,
                           machine_workcenter=machine_workcenter, rules=rules)
    if not steps["ok"]:
        step = steps["step"]
        if step == "pv_missing":
            # Step 1: skip the fallback chain entirely -- D4: a missing
            # production version always holds, no guess.
            return {"status": "held", "reason_code": "pv_missing"}
        return _fallback(order, step)

    return {
        "status": "resolved",
        "run_time": steps["run_time"],
        "run_time_source": "routing",
        "run_time_basis": steps["run_time_basis"],
        "lot_size_warning": steps["lot_size_warning"],
    }


# ===========================================================================
# §8.5 eligibility check -- ONE hypothetical (material, production_version,
# machine, quantity, start-date) combination, no DB write, no fallback (a
# candidate combination has no order-file machine-hours value or existing
# run_time to fall back to -- it either resolves via routing or it doesn't).
# ===========================================================================
def _check_eligibility_on_conn(plant: str, material_id: str, production_version,
                               machine, order_quantity, sap_basic_start_date, conn) -> dict:
    """Does the real work of `check_eligibility` on an already-open
    connection -- a pure read (reuses the SAME plant-reference-data loaders
    `resolve_orders`/`build_rate_map` use), never writes."""
    with conn.cursor() as cur:
        pv_lookup = _load_pv_lookup(cur, plant)
        op_lookup = _load_op_lookup(cur, plant)
        machine_workcenter = _load_machine_workcenter(cur, plant)
        rules = _load_rules(cur, plant)

    order = {
        "plant": plant,
        "material_number": material_id,
        "production_version": production_version,
        "machine": machine,
        "order_quantity": order_quantity,
        "basic_start_date": sap_basic_start_date,
    }
    steps = _resolve_steps(order, pv_lookup=pv_lookup, op_lookup=op_lookup,
                           machine_workcenter=machine_workcenter, rules=rules)
    if not steps["ok"]:
        return {"ok": False, "step": steps["step"]}
    return {"ok": True, "hours": float(steps["run_time"]), "basis": steps["run_time_basis"]}


def check_eligibility(plant: str, material_id: str, production_version, machine,
                      order_quantity, sap_basic_start_date, *, conn=None) -> dict:
    """§8.5's server-side eligibility check for a MACHINE/PRODUCTION_VERSION
    edit: runs the exact same §5.2 steps 1-8 `resolve_one` uses (via the
    shared `_resolve_steps` helper) for ONE hypothetical (material,
    production_version, machine, quantity, start-date) combination, WITHOUT
    writing anything.

    Returns {"ok": True, "hours": float, "basis": {...}} on success, or
    {"ok": False, "step": <failure code>} on the first failing step --
    matching resolve_one's own failure-step vocabulary exactly (§5.2's
    table: pv_missing, pv_not_found, pv_expired, workcenter_unmapped/
    no_machine, no_routing, no_operation_at_workcenter, zero_runtime).

    Same `conn=None` convention as `resolve_orders`/`build_rate_map`: given
    a conn (e.g. `backend/scheduling/db.update_task_dates_bulk`'s own open,
    uncommitted transaction, per §8.5), it is reused as-is -- this is a
    read within THAT caller's transaction, never a second connection opened
    mid-write. Omitted, this opens and closes its own short pooled
    connection, since nothing here is ever written either way.
    """
    if conn is not None:
        return _check_eligibility_on_conn(plant, material_id, production_version,
                                          machine, order_quantity, sap_basic_start_date, conn)
    with _pool.connection() as new_conn:
        return _check_eligibility_on_conn(plant, material_id, production_version,
                                          machine, order_quantity, sap_basic_start_date, new_conn)


# ===========================================================================
# DB wrapper (§5.5-§5.6)
# ===========================================================================
def _load_rules(cur, plant: str) -> dict:
    cur.execute(
        "SELECT rule_kind, code, action FROM routing_rules WHERE plant = %s",
        (plant,),
    )
    control_key_exclude = set()
    header_status_include = set()
    for rule_kind, code, action in cur.fetchall():
        if rule_kind == "control_key" and action == "exclude":
            control_key_exclude.add(code)
        elif rule_kind == "header_status" and action == "include":
            header_status_include.add(code)
    return {
        "control_key_exclude": frozenset(control_key_exclude),
        "header_status_include": frozenset(header_status_include),
    }


def _load_pv_lookup(cur, plant: str) -> dict:
    cur.execute(
        "SELECT plant, material_id, production_version, valid_from, valid_to,"
        " task_list_type, routing_group, group_counter, sap_workcenter,"
        " lot_size_from, lot_size_to"
        " FROM production_version WHERE plant = %s",
        (plant,),
    )
    cols = [d[0] for d in cur.description]
    lookup: dict = {}
    for row in cur.fetchall():
        rec = dict(zip(cols, row, strict=True))
        lookup[(rec["plant"], rec["material_id"], rec["production_version"])] = rec
    return lookup


def _load_op_lookup(cur, plant: str) -> dict:
    cur.execute(
        "SELECT plant, material_id, task_list_type, routing_group, group_counter,"
        " sequence_no, activity, sap_workcenter, workcenter_category, base_quantity,"
        " control_key, header_status, deleted, sequence_category,"
        " activity_type_machine, std_value_machine, std_value_unit_machine,"
        " activity_type_labor, std_value_labor, std_value_unit_labor"
        " FROM routing_operation WHERE plant = %s",
        (plant,),
    )
    cols = [d[0] for d in cur.description]
    lookup: dict = {}
    for row in cur.fetchall():
        rec = dict(zip(cols, row, strict=True))
        key = (rec["plant"], rec["material_id"], rec["task_list_type"],
               rec["routing_group"], rec["group_counter"])
        lookup.setdefault(key, []).append(rec)
    return lookup


def _load_machine_workcenter(cur, plant: str) -> dict:
    cur.execute("SELECT machine, sap_workcenter FROM machine WHERE plant = %s", (plant,))
    return dict(cur.fetchall())


def _load_orders(cur, plant: str, is_cutover: bool) -> list[dict]:
    """The set of orders one resolve run considers (§4 item 4's "resolve
    after distribution" ordering is the CALLER's concern, not this query's --
    resolve_orders is called per-plant on demand, over whatever rows exist
    at call time).

    Loads every order in `plant` whose run_time_source isn't 'manual'
    (§5.5: manual entries are never touched by a resolve run) AND that is
    either currently routing-sourced (might need a refresh), currently held
    (any reason -- a resolve is the only way a routing hold clears), or has
    never had a run_time at all. During a cutover (judgment call #3, module
    docstring) every already-`scheduled` order in the plant is ALSO pulled
    in, per D5/§5.5's cutover behavior.
    """
    cur.execute(
        "SELECT id, plant, material_number, production_version, machine, order_quantity,"
        " basic_start_date, run_time, run_time_source, run_time_basis, machine_hours,"
        " planning_status, planning_reason, firming_indicator, scheduled_start, scheduled_end"
        " FROM orders"
        " WHERE plant = %s"
        "   AND run_time_source IS DISTINCT FROM 'manual'"
        "   AND (run_time_source = 'routing'"
        "        OR planning_status = 'needs_planning'"
        "        OR run_time IS NULL"
        "        OR (%s AND planning_status = 'scheduled'))",
        (plant, is_cutover),
    )
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row, strict=True)) for row in cur.fetchall()]


def _is_routing_hold(planning_reason) -> bool:
    """True when a CURRENT hold is either unset or already belongs to this
    resolver's own vocabulary (code 'runtime_unknown', step in
    ROUTING_HOLD_STEPS) -- only then may a fresh resolve release or
    overwrite it. A hold some other subsystem set (an unrelated code, or a
    'runtime_unknown' whose step this module doesn't recognize) is left
    alone, per the defensive instruction in ROUTING_RUNTIME_DESIGN.md §5.5."""
    if not planning_reason:
        return True
    if not isinstance(planning_reason, dict):
        return False
    code = planning_reason.get("code")
    if code is None:
        return True
    if code != "runtime_unknown":
        return False
    step = planning_reason.get("step")
    return step is None or step in ROUTING_HOLD_STEPS


def _effective_start(order: dict):
    """COALESCE(scheduled_start, basic_start_date) -- same precedence as
    db.py's own `_EFF_START_SQL`/eff_start projections."""
    return order.get("scheduled_start") or order.get("basic_start_date")


def _build_held_row(order: dict, step: str):
    """One row for the held-outcomes' VALUES-joined UPDATE, or None when the
    order is currently held for a DIFFERENT, non-routing reason (defensive:
    a resolve run must never claw back another subsystem's hold)."""
    if order.get("planning_status") == "needs_planning" and not _is_routing_hold(order.get("planning_reason")):
        return None
    reason = {
        "code": "runtime_unknown",
        "step": step,
        "message": f"Runtime could not be resolved from routing (step: {step}).",
    }
    return (order["id"], Jsonb(reason))


def _build_write_row(order: dict, result: dict, is_cutover: bool, frozen_horizon_end, report: dict):
    """One row for the non-held outcomes' VALUES-joined UPDATE, or None when
    this outcome must leave the order genuinely untouched (judgment call #5,
    module docstring: an already-labeled fallback_legacy order)."""
    status = result["status"]
    run_time = result["run_time"]
    run_time_source = result["run_time_source"]

    if status == "fallback_legacy":
        if order.get("run_time_source") is not None:
            return None
        basis = {"fallback": "legacy", "reason_code": result.get("reason_code")}
    elif status == "fallback_sap_order":
        basis = {"fallback": "sap_order", "reason_code": result.get("reason_code")}
    else:  # "resolved"
        basis = result["run_time_basis"]

    release_hold = (
        order.get("planning_status") == "needs_planning"
        and _is_routing_hold(order.get("planning_reason"))
    )

    # Judgment call #4 (module docstring): cutover re-place/keep-in-place,
    # only for an order that was already `scheduled` (pulled in by the
    # cutover-only clause in _load_orders) -- a previously-held order
    # resolving now is an ordinary release, not a cutover re-place.
    set_mismatch = False
    if is_cutover and order.get("planning_status") == "scheduled":
        firmed = order.get("firming_indicator") == "X"
        eff_start = _effective_start(order)
        frozen = frozen_horizon_end is not None and eff_start is not None and eff_start < frozen_horizon_end
        if firmed or frozen:
            report.setdefault("orders_kept_in_place", []).append(order["id"])
        elif order.get("scheduled_start") is not None or order.get("scheduled_end") is not None:
            # Only a genuinely user-placed order needs a re-place signal --
            # one that's merely "scheduled" via basic_start_date alone picks
            # up the new run_time automatically through _EFF_END_SQL.
            set_mismatch = True

    return (order["id"], run_time, run_time_source, Jsonb(basis), release_hold, set_mismatch)


def _write_outcomes(cur, rows: list[tuple]) -> None:
    """ONE set-based UPDATE ... FROM (VALUES ...) for every non-held outcome
    (resolved / fallback_sap_order / fallback_legacy) in this resolve run --
    run_time/source/basis vary per row (inherent to the data), but this is
    still a single statement for the whole batch, never one execute() per
    order. Explicit ::casts on the VALUES columns, same reasoning as db.py's
    own VALUES-joined bulk updates: an all-NULL column would otherwise be of
    unknown type. `IS DISTINCT FROM` in the WHERE clause keeps a genuinely
    unchanged row from bumping orders.xmin (§5.5)."""
    if not rows:
        return
    placeholders = ", ".join(
        ["(%s::text, %s::numeric, %s::text, %s::jsonb, %s::boolean, %s::boolean)"] * len(rows)
    )
    params = [v for row in rows for v in row]
    query = (
        "UPDATE orders o SET"
        " run_time = v.run_time,"
        " run_time_source = v.run_time_source,"
        " run_time_basis = v.run_time_basis,"
        " planning_status = CASE WHEN v.release_hold THEN 'scheduled' ELSE o.planning_status END,"
        " planning_reason = CASE WHEN v.release_hold THEN NULL ELSE o.planning_reason END,"
        " runtime_schedule_mismatch = CASE WHEN v.set_mismatch THEN TRUE ELSE o.runtime_schedule_mismatch END,"
        " updated_at = NOW()"
        f" FROM (VALUES {placeholders}) AS v(id, run_time, run_time_source, run_time_basis, release_hold, set_mismatch)"
        " WHERE o.id = v.id"
        "   AND (o.run_time IS DISTINCT FROM v.run_time"
        "        OR o.run_time_source IS DISTINCT FROM v.run_time_source"
        "        OR o.run_time_basis IS DISTINCT FROM v.run_time_basis"
        "        OR (v.release_hold AND o.planning_status = 'needs_planning')"
        "        OR (v.set_mismatch AND o.runtime_schedule_mismatch IS DISTINCT FROM TRUE))"
    )
    cur.execute(query, params)


def _write_holds(cur, rows: list[tuple]) -> None:
    """ONE set-based UPDATE ... FROM (VALUES ...) for every held outcome.
    Clears scheduled_start/scheduled_end alongside planning_status/
    planning_reason (judgment call #6, module docstring) -- required by the
    existing orders_planning_state_check CHECK constraint, which demands
    both be NULL whenever planning_status = 'needs_planning'; a row that's
    already held has them NULL already, so this is a no-op for it."""
    if not rows:
        return
    placeholders = ", ".join(["(%s::text, %s::jsonb)"] * len(rows))
    params = [v for row in rows for v in row]
    query = (
        "UPDATE orders o SET"
        " planning_status = 'needs_planning',"
        " planning_reason = v.reason,"
        " scheduled_start = NULL,"
        " scheduled_end = NULL,"
        " updated_at = NOW()"
        f" FROM (VALUES {placeholders}) AS v(id, reason)"
        " WHERE o.id = v.id"
        "   AND (o.planning_status IS DISTINCT FROM 'needs_planning'"
        "        OR o.planning_reason IS DISTINCT FROM v.reason"
        "        OR o.scheduled_start IS NOT NULL"
        "        OR o.scheduled_end IS NOT NULL)"
    )
    cur.execute(query, params)


def _new_report(is_cutover: bool) -> dict:
    report = {
        "resolved": 0,
        "unknown_by_step": {},
        "legacy_retained": 0,
        "sap_order_fallback_count": 0,
        "skipped_other_category": 0,
        "unmapped_workcenters": [],
        "lot_size_warnings": 0,
    }
    if is_cutover:
        report["orders_kept_in_place"] = []
    return report


def _resolve_orders_on_conn(plant: str, conn) -> dict:
    """Does the real work of `resolve_orders` on an already-open connection;
    never commits (that's `resolve_orders`' job -- either its own, for a
    connection it opened itself, or the caller's, for one it was given)."""
    with conn.cursor() as cur:
        # Gate: this is the ONE choke point every caller of resolve_orders
        # goes through (db.upsert_orders' resolve_fn seam, the master-data
        # post-write hooks, the /recompute admin route) -- callers may ALSO
        # pre-filter by this same switch as an optimization (db.upsert_orders
        # does, via routing_enabled_plants), but this function must be safe
        # on its own regardless of what any caller does or doesn't filter.
        # Bug this closes: with no gate here, a disabled plant (every real
        # plant today) would have is_cutover=True below, which pulls in
        # every currently-scheduled order in the plant via _load_orders'
        # cutover clause, then holds most of them on pv_missing -- sweeping
        # the whole book into Needs Planning on an ordinary order upload.
        # A missing plants row reads as disabled, same posture as db.py's
        # own LEFT JOIN read (~line 1130: "Missing plants row (shouldn't
        # happen) reads as disabled"). Deliberately applies to EVERY caller,
        # including the explicit /recompute admin endpoint -- nothing in
        # this codebase needs to force-resolve a disabled plant, and the
        # design doc's own D5/§3.6 wording only ever describes resolving
        # once a plant's switch is on.
        cur.execute("SELECT routing_runtime_enabled FROM plants WHERE plant = %s", (plant,))
        row = cur.fetchone()
        if row is None or not row[0]:
            return _new_report(is_cutover=False)

        cur.execute(
            "SELECT EXISTS(SELECT 1 FROM orders WHERE plant = %s AND run_time_source = 'routing')",
            (plant,),
        )
        is_cutover = not cur.fetchone()[0]

        report = _new_report(is_cutover)

        orders = _load_orders(cur, plant, is_cutover)
        if not orders:
            return report

        pv_lookup = _load_pv_lookup(cur, plant)
        op_lookup = _load_op_lookup(cur, plant)
        machine_workcenter = _load_machine_workcenter(cur, plant)
        rules = _load_rules(cur, plant)

        frozen_horizon_end = None
        if is_cutover:
            # Only fetched for a cutover run -- a routine resolve never
            # needs it (nothing but the cutover clause cares about firmed/
            # frozen orders' scheduled_start/scheduled_end).
            frozen_horizon_end = db.plant_horizons(plant).get("frozen_horizon_end")

        write_rows: list[tuple] = []
        held_rows: list[tuple] = []
        unmapped_workcenters: set[str] = set()

        for order in orders:
            result = resolve_one(order, pv_lookup=pv_lookup, op_lookup=op_lookup,
                                 machine_workcenter=machine_workcenter, rules=rules)
            status = result["status"]

            if status == "held":
                step = result.get("detail_step") or result["reason_code"]
                report["unknown_by_step"][step] = report["unknown_by_step"].get(step, 0) + 1
                if step == "workcenter_unmapped" and order.get("machine"):
                    unmapped_workcenters.add(order["machine"])
                held_row = _build_held_row(order, step)
                if held_row is not None:
                    held_rows.append(held_row)
                continue

            if status == "resolved":
                report["resolved"] += 1
                for skipped in result["run_time_basis"].get("skipped_operations", []):
                    if skipped.get("reason") == "other_category":
                        report["skipped_other_category"] += 1
                if result.get("lot_size_warning"):
                    report["lot_size_warnings"] += 1
            elif status == "fallback_sap_order":
                report["sap_order_fallback_count"] += 1
            elif status == "fallback_legacy":
                report["legacy_retained"] += 1

            write_row = _build_write_row(order, result, is_cutover, frozen_horizon_end, report)
            if write_row is not None:
                write_rows.append(write_row)

        _write_outcomes(cur, write_rows)
        _write_holds(cur, held_rows)

    report["unmapped_workcenters"] = sorted(unmapped_workcenters)
    return report


def resolve_orders(plant: str, *, conn=None) -> dict:
    """§5's thin DB wrapper -- the shape a later task wires into
    `db.upsert_orders`'s `resolve_fn` seam.

    When `conn` is given, it is reused as-is and the CALLER commits (mirrors
    `backend/distribution/data.py`'s `plan()`/`apply()` conn=None convention,
    which this task's brief points to explicitly). When omitted, this
    function opens its own short pooled connection and commits/closes it
    itself, exactly like every other self-contained write path in this
    codebase (e.g. `backend/routing/routes.py`'s `_do_upload_operations`).
    """
    if conn is not None:
        return _resolve_orders_on_conn(plant, conn)
    with _pool.connection() as new_conn:
        report = _resolve_orders_on_conn(plant, new_conn)
        new_conn.commit()
        return report


# ===========================================================================
# §8.1 rate-map payload (P3 client-side mirror) -- a pre-aggregated read-only
# projection of the SAME plant reference data + SAME pure functions
# resolve_one uses, so it can never silently drift from what resolve_one
# would compute for a real order.
# ===========================================================================
def _numeric_or_none(value):
    """A `Decimal`/`None` DB value -> a plain JSON-safe number/`None` (`lot_from`/
    `lot_to`) -- never a string, so the client can compare it against
    order_quantity directly."""
    return float(value) if value is not None else None


def _build_pv_map(pv_lookup: dict) -> dict:
    """Pure (§8.1's "pv"): one entry per (material_id, production_version)
    already present in `pv_lookup` (as `_load_pv_lookup` shapes it), keyed
    `"<material>|<pv>"`, routing `key` = `"<material>|<type>|<group>|<counter>"`."""
    pv: dict = {}
    for (_plant, material_id, production_version), row in pv_lookup.items():
        valid_from = row.get("valid_from")
        valid_to = row.get("valid_to")
        pv[f"{material_id}|{production_version}"] = {
            "valid_from": valid_from.isoformat() if valid_from is not None else None,
            "valid_to": valid_to.isoformat() if valid_to is not None else None,
            "lot_from": _numeric_or_none(row.get("lot_size_from")),
            "lot_to": _numeric_or_none(row.get("lot_size_to")),
            "key": f"{material_id}|{row.get('task_list_type')}|{row.get('routing_group')}|{row.get('group_counter')}",
        }
    return pv


def _build_ops_map(op_lookup: dict, rules: dict) -> dict:
    """Pure (§8.1's "ops"): ONE pre-aggregated `minutes_per_unit` per
    (routing key, work center), computed by the LITERAL SAME per-operation
    math `resolve_one` uses (`_select_operations` + `_pick_operation_hours`),
    run at `order_quantity=1` so `_pick_operation_hours`'s own `hours * qty /
    base_quantity` formula collapses to plain "hours per unit" -- summed
    across every surviving, categorized operation at that combination, then
    converted to minutes. This is a literal parity port of §5.2 step 6/7 +
    §5.4, never a re-derivation: for any order at this routing key/work
    center, `ops[key].minutes_per_unit * order_quantity / 60` (rounded to
    the nearest minute) equals what `resolve_one` would compute as that
    order's pre-fallback `run_time`.

    `op_lookup` is shaped like `_load_op_lookup`'s return value: {(plant,
    material_id, task_list_type, routing_group, group_counter):
    [operation_row, ...]}.
    """
    ops: dict = {}
    for (_plant, material_id, task_list_type, routing_group, group_counter), operations in op_lookup.items():
        workcenters = {op.get("sap_workcenter") for op in operations if op.get("sap_workcenter")}
        for workcenter in workcenters:
            selected = _select_operations(operations, workcenter, rules)
            if not selected:
                # Nothing at this work center survives §5.2 step 6's filters
                # -- matches resolve_one's own "no_operation_at_workcenter"
                # fallback path, so no key is published for it.
                continue
            total_minutes = Decimal(0)
            for op in selected:
                hours_per_unit, skip_reason = _pick_operation_hours(op, 1)
                if skip_reason:
                    # other_category / invalid_base_quantity / unit_not_time
                    # -- skip just this operation, never the whole key,
                    # mirroring resolve_one's own per-operation skip.
                    continue
                total_minutes += hours_per_unit * Decimal(60)
            key = f"{material_id}|{task_list_type}|{routing_group}|{group_counter}|{workcenter}"
            ops[key] = {"minutes_per_unit": float(total_minutes)}
    return ops


def _build_rate_map_on_conn(plant: str, conn) -> dict:
    """Does the real work of `build_rate_map` on an already-open connection.
    Never writes anything -- purely a read + in-Python aggregation."""
    with conn.cursor() as cur:
        pv_lookup = _load_pv_lookup(cur, plant)
        op_lookup = _load_op_lookup(cur, plant)
        machine_workcenter = _load_machine_workcenter(cur, plant)
        rules = _load_rules(cur, plant)

    return {
        "plant": plant,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        # §8.1: "machines" -- every machine in this plant with a non-null
        # sap_workcenter, {machine: sap_workcenter}.
        "machines": {m: wc for m, wc in machine_workcenter.items() if wc},
        "pv": _build_pv_map(pv_lookup),
        "ops": _build_ops_map(op_lookup, rules),
    }


def build_rate_map(plant: str, *, conn=None) -> dict:
    """§8.1's rate-map payload -- `GET /routing/{plant}/rate-map`'s response
    body. Reuses the SAME plant-reference-data loaders `resolve_orders` uses
    (`_load_pv_lookup`/`_load_op_lookup`/`_load_machine_workcenter`/
    `_load_rules`) and the SAME pure functions `resolve_one` uses
    (`_select_operations`/`_pick_operation_hours`) -- a literal parity port,
    not a second, independently-maintained calculation that could drift.

    Purely a read: `conn=None` opens its own short pooled connection and
    never commits (nothing is written); a caller-supplied `conn` is used
    as-is, with no transaction requirement either way.
    """
    if conn is not None:
        return _build_rate_map_on_conn(plant, conn)
    with _pool.connection() as new_conn:
        return _build_rate_map_on_conn(plant, new_conn)
