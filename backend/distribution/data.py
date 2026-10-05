"""
NIMBUS 2.0 — Order Distribution domain: SAP aggregate work center policy and
per-machine distribution weights.

P1: a single validated write path backs `PUT /distribution/{plant}/workcenters/{wc}`
-- create-or-replace of one plant's `sap_workcenter` policy row plus its member
machines' `machine.distribution_weight`, in one transaction with an
`admin_audit` row.

P2 (`plan`/`apply`, this file): the ingest transaction seam described in
aggregate_to_detail.md §5 -- `plan()` runs BEFORE db.py's `upsert_orders`
id/dedup loop, on a short-lived READ-ONLY connection, resolving/classifying
inbound rows and replacing a distributed aggregate parent with its per-machine
child rows; `apply()` runs AFTER the caller's normal upsert chunks and
backfills have committed, in ONE transaction, writing the `order_distribution`
header + `order_distribution_share` rows, carrying schedule/notes onto
brand-new children, and deleting superseded ones. Wired into `db.py`'s ingest
path via `db.upsert_orders`' optional `plan_fn`/`apply_fn` parameters (P2-4);
`plan()`/`apply()` are also self-contained and independently correct on their
own, and the `@pytest.mark.pg` tests below exercise them directly in addition
to the wired path.

P2-6/P2-7 add the five read-only routes; P2-8/P2-9 add the three planner
writes (`shares`/`review`/`reset`) and two admin writes (`reapply-defaults`/
`resolve`) -- see the module note ahead of `DistributionHeaderNotFound` below
for that section's own shared-engine design. aggregate_to_detail.md §7 at the
repo root is the full API table this domain grows into (now fully shipped).

Plain psycopg-style functions over the shared pool (`db._pool`), mirroring
`backend/setup/data.py`'s convention -- no ORM, every value goes through a
parameter placeholder. Key-ordered `FOR UPDATE` locking in `apply()` mirrors
`backend/setup/data.py`'s `_set_machine_state_cur`/override-lock precedent
explicitly named in the design doc.

No optimistic-concurrency token on the P1 `save_workcenter` route.
aggregate_to_detail.md §3.4 pins the `xmin`/`base_version` 409-stale token to
the `order_distribution` HEADER table (this file's `plan`/`apply`), not to the
`sap_workcenter` POLICY row (one row per work center, edited rarely, by admins
only). `save_workcenter` stays a plain last-write-wins transaction, the same
shape as master_data.py's other narrow single-purpose admin writers.
"""
import logging
import math
import re
import uuid
from decimal import ROUND_HALF_UP, Decimal
from datetime import datetime, timedelta, timezone

from psycopg.types.json import Jsonb

import db
import backend.distribution.service as service
import backend.setup.data as setup_data
from db import _pool

log = logging.getLogger(__name__)

VALID_DISTRIBUTION_MODES = frozenset({"single", "distribute"})
VALID_MAX_SEPARATIONS = frozenset({"none", "hour", "day", "week"})

# D21: a weight of inf/nan (JSON's non-standard `Infinity`/`NaN` constants, or
# an exponent large enough to overflow to inf) or anything above a generous
# ceiling is rejected in both validators below -- before any `< 0` comparison,
# since a non-finite Decimal raises `decimal.InvalidOperation` on ordering
# comparisons rather than comparing cleanly.
_MAX_WEIGHT = 1e9


def _clean_optional_str(value) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _validate_static_fields(distribution_mode, max_separation) -> tuple[str, str]:
    """Enum-shaped fields that don't need a DB round trip to validate."""
    if distribution_mode not in VALID_DISTRIBUTION_MODES:
        raise ValueError("distribution_mode must be 'single' or 'distribute'")
    if max_separation not in VALID_MAX_SEPARATIONS:
        raise ValueError("max_separation must be one of none/hour/day/week")
    return distribution_mode, max_separation


def _clean_weights(weights) -> dict[str, float | None]:
    """{machine: weight} -> cleaned dict; NULL means "even" per
    aggregate_to_detail.md §3.2's weight semantics -- validated here as
    "numeric or null", never coerced to 0 (that happens only once some
    sibling has a real weight, which is a read-time/optimizer concern, not
    a write-path one)."""
    if weights is None:
        return {}
    if not isinstance(weights, dict):
        raise ValueError("weights must be an object of {machine: weight}")
    cleaned: dict[str, float | None] = {}
    for machine_name, weight in weights.items():
        if not isinstance(machine_name, str) or not machine_name.strip():
            raise ValueError("weights keys must be non-blank machine names")
        if weight is None:
            cleaned[machine_name] = None
            continue
        if isinstance(weight, bool) or not isinstance(weight, (int, float)):
            raise ValueError(f"weight for {machine_name!r} must be numeric or null")
        # Route through Decimal(str(...)) first, same as _validate_share_payload
        # below -- a huge JSON integer (e.g. a ~400-digit literal) overflows
        # `float()` directly with an OverflowError, not a ValueError, which
        # would escape the route's `except ValueError` as a 500 instead of
        # the intended weight_invalid 400. Decimal(str(int)) never overflows
        # (arbitrary precision); converting THAT to float cleanly yields inf.
        w = float(Decimal(str(weight)))
        if not math.isfinite(w) or w > _MAX_WEIGHT:
            raise ValueError(
                f"weight_invalid: weight for {machine_name!r} must be finite and <= {_MAX_WEIGHT:g}"
            )
        if w < 0:
            raise ValueError(f"weight for {machine_name!r} must be >= 0")
        cleaned[machine_name] = w
    return cleaned


def save_workcenter(plant: str, wc: str, description, distribution_mode, default_machine,
                    max_separation, review_required, distribute_tooled, weights,
                    user_email: str | None = None) -> dict:
    """Create-or-replace one plant's `sap_workcenter` policy row and its
    member `machine.distribution_weight` values in a single transaction, with
    an `admin_audit` row -- the narrow validated write path
    aggregate_to_detail.md §4.3 calls for, "per the `setup_compatible`
    precedent" (own route, own function, not the generic master-data bulk
    path).

    Validates the four §3.1 write-path rules and raises ValueError on any
    violation, with the message prefixed `"<rule_code>: <detail>"` so
    routes.py can surface a structured `{"code": ...}` 400 body:
      - wc_code_shadowed_by_machine -- the code must not already be a
        machine name in this plant.
      - single_mode_without_default -- single mode requires a default
        machine (the DB CHECK also refuses this; validated here first for a
        readable 400 instead of an IntegrityError leaking through).
      - default_machine_not_member -- a set default_machine must already be
        a member (machine.sap_workcenter = wc) of this work center.
      - distribute_mode_thin -- distribute mode needs at least two current
        members. (The generic master-data grid's post-write hook only warns
        on this; this dedicated route enforces it as a hard 400, per §3.1's
        "enforced by the Work Centers route (400)".)
    An additional `weight_machine_not_member` check (not one of the four, but
    the same shape) refuses a weight keyed on a machine that isn't a member
    -- membership itself is set via the Machines pane (`machine.sap_workcenter`),
    never by this route, so a stray key here is a caller bug, not silently
    dropped.

    A blank plant or work-center code raises a plain ValueError (400, no
    rule code) -- the shared RBAC/plant-scope guard in routes.py handles the
    PlantNotAllowed/ValueError -> 403/400 split before this is ever called,
    but this function validates independently too, since it's a real write
    path other callers could reach directly.
    """
    if not plant or not plant.strip():
        raise ValueError("plant is required")
    if not wc or not isinstance(wc, str) or not wc.strip():
        raise ValueError("sap_workcenter is required")
    wc_clean = wc.strip()

    mode, separation = _validate_static_fields(distribution_mode, max_separation)
    default_machine_clean = _clean_optional_str(default_machine)
    description_clean = _clean_optional_str(description)
    review_required_clean = bool(review_required) if review_required is not None else True
    distribute_tooled_clean = bool(distribute_tooled) if distribute_tooled is not None else False
    clean_weights = _clean_weights(weights)

    with _pool.connection() as conn, conn.cursor() as cur:
        # wc_code_shadowed_by_machine: the code may not equal a machine name
        # in the same plant (aggregate_to_detail.md §3.1).
        cur.execute("SELECT 1 FROM machine WHERE plant = %s AND machine = %s", (plant, wc_clean))
        if cur.fetchone() is not None:
            raise ValueError(
                f"wc_code_shadowed_by_machine: {wc_clean!r} is already a machine name in plant {plant!r}"
            )

        # Current membership -- machines already linked via machine.sap_workcenter.
        # This route never assigns membership itself (that's the Machines pane's
        # job, §4.2); it only validates against and writes weights for it.
        cur.execute("SELECT machine FROM machine WHERE plant = %s AND sap_workcenter = %s", (plant, wc_clean))
        members = {row[0] for row in cur.fetchall()}

        if mode == "single" and not default_machine_clean:
            raise ValueError("single_mode_without_default: single mode requires a default machine")

        if default_machine_clean and default_machine_clean not in members:
            raise ValueError(
                f"default_machine_not_member: {default_machine_clean!r} is not a member of work center {wc_clean!r}"
            )

        if mode == "distribute" and len(members) < 2:
            raise ValueError(
                f"distribute_mode_thin: work center {wc_clean!r} has fewer than two member machines"
            )

        for machine_name in clean_weights:
            if machine_name not in members:
                raise ValueError(
                    f"weight_machine_not_member: {machine_name!r} is not a member of work center {wc_clean!r}"
                )

        cur.execute(
            """
            INSERT INTO sap_workcenter
                (plant, sap_workcenter, description, distribution_mode,
                 default_machine, max_separation, review_required, distribute_tooled, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (plant, sap_workcenter) DO UPDATE SET
                description       = EXCLUDED.description,
                distribution_mode = EXCLUDED.distribution_mode,
                default_machine   = EXCLUDED.default_machine,
                max_separation    = EXCLUDED.max_separation,
                review_required   = EXCLUDED.review_required,
                distribute_tooled = EXCLUDED.distribute_tooled,
                updated_at        = now()
            """,
            (plant, wc_clean, description_clean, mode, default_machine_clean, separation,
             review_required_clean, distribute_tooled_clean),
        )

        for machine_name, weight in clean_weights.items():
            cur.execute(
                "UPDATE machine SET distribution_weight = %s"
                " WHERE plant = %s AND machine = %s AND sap_workcenter = %s",
                (weight, plant, machine_name, wc_clean),
            )

        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('sap_workcenter', 'save_workcenter', %s, %s)",
            (Jsonb({
                "plant": plant, "sap_workcenter": wc_clean, "distribution_mode": mode,
                "default_machine": default_machine_clean, "max_separation": separation,
                "review_required": review_required_clean, "distribute_tooled": distribute_tooled_clean,
                "weights": clean_weights,
            }), user_email),
        )
        conn.commit()

    return {
        "plant": plant,
        "sap_workcenter": wc_clean,
        "description": description_clean,
        "distribution_mode": mode,
        "default_machine": default_machine_clean,
        "max_separation": separation,
        "review_required": review_required_clean,
        "distribute_tooled": distribute_tooled_clean,
        "weights": clean_weights,
    }


# =====================================================================
# P2 -- plan()/apply(): the ingest transaction seam (aggregate_to_detail.md §5)
# =====================================================================
#
# `plan(rows, batch_id, conn=None)` -- read-only, one short connection (a
# caller-supplied one, or our own via `_pool.connection()`), called BEFORE
# db.upsert_orders' id/dedup loop. Resolves plant, classifies each row
# against machine/sap_workcenter master data, drops/skips duplicate or
# conflicting rows for the same (production_order, material_number), and
# replaces every distributed aggregate parent row with its per-machine child
# rows. Returns (rows_out, plan_structure, warnings) -- `rows_out` is what the
# caller feeds into the normal upsert/chunking path unchanged; `plan_structure`
# is exactly what `apply()` needs per parent; `warnings` accumulates the §5.1-
# §5.3 warning codes, keyed exactly as aggregate_to_detail.md names them.
#
# `apply(plan, batch_id, conn, *, actor="system")` -- ONE transaction on the
# given connection, called AFTER the caller's normal upsert chunks and
# backfills have committed. Locks every already-existing affected header in
# one key-ordered `FOR UPDATE` statement (deadlock-safe against a concurrent
# re-weight locking the same way), re-checks each header's xmin against the
# snapshot `plan()` took, and when it differs -- a planner re-weighted between
# plan-time and apply-time -- re-plans that ONE parent from the header's
# CURRENT shares/facts (the planner's edit wins) before writing. Idempotent:
# every write is guarded (`WHERE ... IS DISTINCT FROM`, `ON CONFLICT ... DO
# NOTHING`/`DO UPDATE ... WHERE`) so re-running `apply()` with the same `plan`
# a second time changes nothing.
#
# Scope boundary this file's `apply()` deliberately does NOT cross: N->1
# collapse (when a planner re-weights a distributed header down to one 100%
# machine, copying the surviving machine's existing scheduled_*/segments onto
# the new bare id) is §5.5 bullet 6 -- the planner re-weight endpoint's job
# (POST /distribution/{plant}/{order}/{material}/shares, `reweight_shares` /
# `_collapse_to_survivor` further down this file), NOT `apply()`'s. `apply()`
# here only ever CREATES/refreshes via ingest; it has no survivor-copy logic
# and must not grow any -- ingest's "children the current shares do not want
# are treated as superseded" (§5.4 step 3) already covers the shrink-to-fewer-
# children case generically via the normal delete-superseded-children step.

_SAP_FACTS_COPIED_KEYS = (
    "material_description", "color", "form_size", "order_category", "order_type",
    "bom_alternative", "bom_usage", "planned_order_initial_quantity", "reduced_quantity",
    "no_of_fte",
)
# order_quantity/run_time/labor_hours/machine_hours are apportioned per child (Hamilton /
# largest-remainder); everything else on a parent row is copied verbatim to every child.
_ADDITIVE_COLS = ("order_quantity", "run_time", "labor_hours", "machine_hours")
_QTY_MILLI_UNIT = Decimal("0.001")          # SAP QUAN 13,3 fallback unit (§5.3)
_HOURS_APPORTION_UNIT = Decimal("0.01")     # labor_hours/machine_hours granularity (not specced
                                             # to a particular unit by aggregate_to_detail.md §5.3
                                             # the way quantity/run-time are; a fine-grained unit
                                             # keeps children summing exactly to the parent value
                                             # via the same Hamilton method, rather than inventing a
                                             # second apportionment algorithm for these two columns).


def _dec(value) -> Decimal:
    """None/int/float/Decimal -> Decimal, treating None as 0."""
    if value is None:
        return Decimal(0)
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def _empty_ingest_warnings() -> dict:
    """The exact warning keys aggregate_to_detail.md §5.1-§5.3 name, plus
    `single_rewrites` (needed to populate the §5.4 step 7 upload_audit entry,
    which lists it explicitly, even though it isn't one of the ingest-time
    warning *codes* proper -- a single_rewrite carries no warning of its own,
    just a count)."""
    return {
        "duplicate_parent_rows": [],
        "conflicting_parent_rows": [],
        "ambiguous_workcenter_plant": [],
        "default_machine_invalid": [],
        "workcenter_without_members": [],
        "sub_order_id_rows": [],
        "zero_quantity_children": 0,
        "parent_runtime_defaulted": 0,
        "single_rewrites": 0,
    }


def _dedupe_and_filter_conflicts(items: list[dict], existing_headers: dict, warnings: dict) -> set[int]:
    """§5.1 step 1 -- moved (D04) to run AFTER plant resolution/classification
    and the existing-header load, so it can tell a plain, never-to-be-
    distributed duplicate apart from a genuine distribution duplicate/
    conflict. Running this rule on the raw upload (its original position, a
    plain pre-classification pass over the whole batch) dropped/skipped
    EVERY duplicate (production_order, material_number) pair in the file --
    including ones with no distribution involvement at all -- when
    `upsert_orders`' own id loop already handles that ordinary case correctly
    (keeps every row, suffixing later copies `_1`/`_2`, one summary warning).

    Grouped by (production_order, material_number) over every `items` entry
    (ambiguous-plant rows included, so they still occupy a slot in their
    group). A group is "involved" -- i.e. subject to this rule at all -- only
    when at least one member resolves to a plant AND either classifies
    `distribute` or its (plant, production_order, material_number) key already
    has a distribution header on file (`existing_headers`). An ambiguous-
    plant member's `classification` is always None, so it never makes a group
    involved by itself ("rows whose plant is ambiguous count as not
    involved"). An uninvolved group's rows are left completely alone here --
    `_plan_core`'s normal per-row handling (including the id-loop's
    duplicate-suffix behavior further downstream in `upsert_orders`) takes
    over for every member exactly as if this function didn't exist.

    For an involved group with 2+ rows: identical `machine` values across the
    group keeps the first row and drops the rest -- counted in
    `duplicate_parent_rows` (otherwise db.py's own batch-local id dedup would
    `_1`-suffix a second, orphaned set of children). Differing values drop the
    WHOLE group -- no row is emitted for any member -- recorded in
    `conflicting_parent_rows`.

    Returns the set of `items` indices to exclude entirely from the rest of
    `_plan_core`'s processing (both the dropped duplicates and every member of
    a skipped conflict group).
    """
    groups: dict[tuple[str, str], list[int]] = {}
    order: list[tuple[str, str]] = []
    for idx, it in enumerate(items):
        row = it["row"]
        key = (db._str_id(row.get("production_order")), db._str_id(row.get("material_number")))
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(idx)

    excluded: set[int] = set()
    for key in order:
        idxs = groups[key]
        if len(idxs) == 1:
            continue
        involved = any(
            items[i]["classification"] is not None and (
                items[i]["classification"]["type"] == "distribute"
                or items[i]["key"] in existing_headers
            )
            for i in idxs
        )
        if not involved:
            continue
        machine_values = {items[i]["row"].get("machine") for i in idxs}
        if len(machine_values) == 1:
            warnings["duplicate_parent_rows"].append({
                "production_order": key[0], "material_number": key[1],
                "dropped": len(idxs) - 1,
            })
            excluded.update(idxs[1:])
        else:
            warnings["conflicting_parent_rows"].append({
                "production_order": key[0], "material_number": key[1],
                "values": sorted(str(v) for v in machine_values),
            })
            excluded.update(idxs)
    return excluded


def _load_lookups(cur) -> tuple[dict, dict]:
    """One query over `machine`, one over `sap_workcenter` -- built up front
    for the WHOLE batch, never per row (aggregate_to_detail.md §5.1 step 2
    explicitly calls for this). Both tables are small per-plant master data
    (machines: thousands system-wide per the scale roadmap, not the
    O(states^2) setup-matrix hazard that roadmap actually warns against), so
    one unscoped read of each is the efficient choice here -- row plants
    aren't even known yet for rows relying on machine/workcenter-based plant
    resolution (§5.1 step 2), so a plant-scoped query can't run first anyway.

    Returns:
      machine_lookup[plant][machine] = {"sap_workcenter": str|None, "distribution_weight": Decimal|None}
      workcenter_lookup[plant][wc] = {
          "distribution_mode": str, "default_machine": str|None,
          "review_required": bool, "distribute_tooled": bool,
          "members": [machine, ...] (alphabetical),
          "member_weights": {machine: Decimal|None},
      }
    """
    cur.execute("SELECT plant, machine, sap_workcenter, distribution_weight FROM machine")
    machine_lookup: dict[str, dict[str, dict]] = {}
    members_by_wc: dict[tuple[str, str], list[tuple[str, object]]] = {}
    for plant, machine, wc, weight in cur.fetchall():
        machine_lookup.setdefault(plant, {})[machine] = {
            "sap_workcenter": wc, "distribution_weight": weight,
        }
        if wc:
            members_by_wc.setdefault((plant, wc), []).append((machine, weight))

    cur.execute(
        "SELECT plant, sap_workcenter, distribution_mode, default_machine,"
        " review_required, distribute_tooled FROM sap_workcenter"
    )
    workcenter_lookup: dict[str, dict[str, dict]] = {}
    for plant, wc, mode, default_machine, review_required, distribute_tooled in cur.fetchall():
        pairs = members_by_wc.get((plant, wc), [])
        workcenter_lookup.setdefault(plant, {})[wc] = {
            "distribution_mode": mode,
            "default_machine": default_machine,
            "review_required": bool(review_required),
            "distribute_tooled": bool(distribute_tooled),
            "members": sorted(m for m, _w in pairs),
            "member_weights": dict(pairs),
        }
    return machine_lookup, workcenter_lookup


def _load_existing_headers(cur, keys: list[tuple[str, str, str]]) -> dict:
    """Batch-load existing `order_distribution` headers (with xmin) and their
    shares for every (plant, production_order, material_number) key this
    batch touches -- two queries total, not one per row. Broader than a
    per-plant/per-code filter would be (matched precisely against `keys` in
    Python afterward) because this must cover EVERY resolved parent
    regardless of its CURRENT classification -- decision I's reroute
    detection depends on finding an existing header even for a row that no
    longer classifies as `distribute` at all.

    Returns {key: {"header": {...}, "xmin": int,
                   "shares": [{"machine","letter","weight","child_id","purged_at"}, ...]}}.
    """
    if not keys:
        return {}
    key_set = set(keys)
    plants = sorted({k[0] for k in keys})
    prods = sorted({k[1] for k in keys})
    mats = sorted({k[2] for k in keys})

    cur.execute(
        """
        SELECT plant, production_order, material_number, sap_workcenter, order_quantity,
               run_time, basic_start_date, basic_finish_date, firming_indicator, sap_facts,
               source, default_basis, reviewed, reviewed_by, reviewed_at, reviewed_quantity,
               updated_by, last_batch_id, xmin::text::bigint
          FROM order_distribution
         WHERE plant = ANY(%s) AND production_order = ANY(%s) AND material_number = ANY(%s)
        """,
        (plants, prods, mats),
    )
    headers: dict[tuple[str, str, str], dict] = {}
    for r in cur.fetchall():
        key = (r[0], r[1], r[2])
        if key not in key_set:
            continue
        headers[key] = {
            "header": {
                "plant": r[0], "production_order": r[1], "material_number": r[2],
                "sap_workcenter": r[3], "order_quantity": r[4], "run_time": r[5],
                "basic_start_date": r[6], "basic_finish_date": r[7],
                "firming_indicator": r[8], "sap_facts": r[9] or {},
                "source": r[10], "default_basis": r[11], "reviewed": r[12],
                "reviewed_by": r[13], "reviewed_at": r[14], "reviewed_quantity": r[15],
                "updated_by": r[16], "last_batch_id": r[17],
            },
            "xmin": r[18],
            "shares": [],
        }
    if not headers:
        return {}

    cur.execute(
        """
        SELECT plant, production_order, material_number, machine, letter, weight,
               child_id, purged_at
          FROM order_distribution_share
         WHERE plant = ANY(%s) AND production_order = ANY(%s) AND material_number = ANY(%s)
        """,
        (plants, prods, mats),
    )
    for r in cur.fetchall():
        key = (r[0], r[1], r[2])
        if key not in headers:
            continue
        headers[key]["shares"].append({
            "machine": r[3], "letter": r[4], "weight": r[5],
            "child_id": r[6], "purged_at": r[7],
        })
    return headers


def _load_material_attrs(cur, keys: set[tuple[str, str]]) -> dict:
    """Batch `material_plants` lookup keyed (plant, material_number) -> the
    four attributes §5 needs: default_machine, prt_01, prt_02, min_lot_size,
    incremental_lot_size."""
    if not keys:
        return {}
    key_set = set(keys)
    plants = sorted({k[0] for k in keys})
    mats = sorted({k[1] for k in keys})
    cur.execute(
        """
        SELECT plant, material_id, default_machine, prt_01, prt_02,
               min_lot_size, incremental_lot_size
          FROM material_plants
         WHERE plant = ANY(%s) AND material_id = ANY(%s)
        """,
        (plants, mats),
    )
    attrs: dict[tuple[str, str], dict] = {}
    for plant, material_id, default_machine, prt_01, prt_02, min_lot, inc_lot in cur.fetchall():
        key = (plant, material_id)
        if key not in key_set:
            continue
        attrs[key] = {
            "default_machine": default_machine, "prt_01": prt_01, "prt_02": prt_02,
            "min_lot_size": min_lot, "incremental_lot_size": inc_lot,
        }
    return attrs


def _load_anchor_sources(cur, ids: list[str]) -> dict:
    """For every id that CURRENTLY exists as an `orders` row, capture the
    §5.2 anchor -- COALESCE(first segment start, scheduled_start) -- plus
    notes/planning_status/planning_reason, carried onto new lettered children
    on a 1->N transition (a plain order arrived before its work center was
    configured as `distribute`). Only ids that actually exist come back."""
    if not ids:
        return {}
    unique_ids = sorted(set(ids))
    cur.execute(
        """
        SELECT o.id,
               COALESCE(
                   (SELECT MIN(s.scheduled_start) FROM order_schedule_segments s
                     WHERE s.order_id = o.id),
                   o.scheduled_start
               ) AS anchor,
               o.notes, o.planning_status, o.planning_reason
          FROM orders o
         WHERE o.id = ANY(%s)
        """,
        (unique_ids,),
    )
    return {
        oid: {"anchor": anchor, "notes": notes, "planning_status": planning_status,
              "planning_reason": planning_reason}
        for oid, anchor, notes, planning_status, planning_reason in cur.fetchall()
    }


def _quantity_unit(order_quantity, incremental_lot_size) -> Decimal:
    """§5.3 quantity-apportionment unit: incremental_lot_size when set and >
    0; else one whole unit for an integral parent quantity; else a milli-unit
    (SAP QUAN 13,3)."""
    if incremental_lot_size and incremental_lot_size > 0:
        return Decimal(str(incremental_lot_size))
    if order_quantity is None:
        return Decimal(1)
    qty = _dec(order_quantity)
    if qty == qty.to_integral_value():
        return Decimal(1)
    return _QTY_MILLI_UNIT


def _extract_parent_facts(row: dict) -> tuple[dict, bool]:
    """Pull the SAP facts materialization needs from a raw ingest row
    (lowercase orders-column keys -- the shape db.upsert_orders' `rows`
    already use, e.g. from db.ingest_orders_from_excel's per-row dict build).

    `runtime_defaulted` is read from an optional row key,
    `_run_time_was_defaulted`, that db.py's ingest_orders_from_excel sets
    BEFORE its own RUN_TIME->1.0 fallback (`df["_RUN_TIME_DEFAULTED"] =
    _rt.isna()`, computed off `pd.to_numeric(RUN_TIME, errors="coerce")`
    ahead of `df["RUN_TIME"] = _rt.fillna(1.0)`) overwrites the original
    absence -- by the time `rows` reaches `plan()` that upstream default has
    already happened and is no longer detectable from the row alone except
    via this flag. Defaults to False when the flag is absent (e.g. a row
    built by some other call site that never set it)."""
    runtime_defaulted = bool(row.get("_run_time_was_defaulted", False))
    facts = {
        "material_description": row.get("material_description"),
        "basic_start_date": row.get("basic_start_date"),
        "basic_finish_date": row.get("basic_finish_date"),
        "order_quantity": row.get("order_quantity"),
        "run_time": row.get("run_time"),
        "color": row.get("color"),
        "form_size": row.get("form_size"),
        "firming_indicator": row.get("firming_indicator"),
        "planned_order_initial_quantity": row.get("planned_order_initial_quantity"),
        "reduced_quantity": row.get("reduced_quantity"),
        "order_category": row.get("order_category"),
        "order_type": row.get("order_type"),
        "bom_alternative": row.get("bom_alternative"),
        "bom_usage": row.get("bom_usage"),
        "labor_hours": row.get("labor_hours"),
        "machine_hours": row.get("machine_hours"),
        "no_of_fte": row.get("no_of_fte"),
    }
    return facts, runtime_defaulted


def _build_sap_facts(facts: dict, previous_workcenter, runtime_defaulted: bool) -> dict:
    """The header's `sap_facts` JSONB: the parent-level columns with no
    dedicated `order_distribution` column (schema.sql's own comment lists
    description/color/form-size/categories/BOM-keys/planned-order-quantities/
    no_of_fte), plus `previous_workcenter` (decision I) and
    `runtime_defaulted` (§5.3) when applicable. Rebuilt fresh from THIS
    ingest's facts each call -- order_quantity/run_time/dates are likewise
    fully refreshed each ingest (§5.2 "Existing"), so sap_facts' copied
    columns follow the same "last ingested wins" rule; only
    `previous_workcenter` is meant to persist across ingests until a planner
    acknowledges it, so callers pass the EXISTING value through when this
    ingest is not itself the reroute."""
    sap_facts = {k: facts.get(k) for k in _SAP_FACTS_COPIED_KEYS if facts.get(k) is not None}
    if previous_workcenter:
        sap_facts["previous_workcenter"] = previous_workcenter
    if runtime_defaulted:
        sap_facts["runtime_defaulted"] = True
    return sap_facts


def _build_child_rows(plant: str, production_order: str, material_number: str,
                      parent_facts: dict, shares: dict, letters: dict,
                      mat_attrs: dict) -> tuple[list[dict], dict[str, str], int]:
    """§5.3 materialize: one child row per share with weight > 0 (callers are
    responsible for excluding purged shares from `shares` before calling --
    "every share with weight > 0 and purged_at IS NULL").

    Returns (child_rows, child_ids_by_machine, zero_quantity_count). Each
    child row is a plain dict keyed by orders-column names (the same shape
    db.upsert_orders' `rows` use), with no `id` key -- `db.make_id` derives it
    from (production_order, material_number) at upsert time, exactly like any
    other order.
    """
    positive = {m: w for m, w in ((m, _dec(w)) for m, w in shares.items()) if w > 0}
    child_rows: list[dict] = []
    child_ids: dict[str, str] = {}
    zero_qty = 0
    if not positive:
        return child_rows, child_ids, zero_qty

    bare = len(positive) == 1
    # Ties broken by LETTER (§5.3: "Hamilton / largest remainder, ties by letter"),
    # not raw machine-name alphabetical order -- they coincide at header-creation
    # time but need not stay coincident once a planner has re-weighted.
    tie_order = sorted(positive.keys(), key=lambda m: letters.get(m, m))

    order_quantity = parent_facts.get("order_quantity")
    qty_alloc: dict[str, Decimal] = {}
    if order_quantity is not None:
        # H6 / owner rule (aggregate_to_detail.md decision H, 2026-09-25): no
        # lot-size rounding for quantity -- unit is a whole piece (bypassing
        # _quantity_unit's incremental_lot_size lookup) and every fractional
        # share rounds UP independently, so the children may sum to slightly
        # more than the SAP parent quantity. This is the ONE apportion() call
        # both the saved materialization and the shares-editor dry-run
        # preview go through (_build_child_rows), so they always agree.
        qty_alloc = service.apportion(
            _dec(order_quantity), positive, Decimal(1), tie_order,
            round_up_remainder=True,
        )

    run_time = parent_facts.get("run_time")
    minutes_alloc: dict[str, Decimal] = {}
    if run_time is not None:
        total_minutes = (_dec(run_time) * 60).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
        minutes_alloc = service.apportion(total_minutes, positive, Decimal(1), tie_order)

    labor_hours = parent_facts.get("labor_hours")
    labor_alloc: dict[str, Decimal] = {}
    if labor_hours is not None:
        # D53: round_total=True here only -- labor/machine hours carry more
        # decimal precision than their 0.01 unit, which overshoots without
        # it. The quantity (unit = incremental_lot_size, a real H6 lot-size
        # rule) and run-time-minutes (unit = 1, already integral minutes)
        # calls above must NOT opt in -- see apportion()'s own docstring.
        labor_alloc = service.apportion(
            _dec(labor_hours), positive, _HOURS_APPORTION_UNIT, tie_order, round_total=True)

    machine_hours = parent_facts.get("machine_hours")
    machine_alloc: dict[str, Decimal] = {}
    if machine_hours is not None:
        machine_alloc = service.apportion(
            _dec(machine_hours), positive, _HOURS_APPORTION_UNIT, tie_order, round_total=True)

    min_lot_size = mat_attrs.get("min_lot_size")

    for machine in tie_order:
        letter = letters.get(machine)
        if bare:
            child_prod = db._str_id(production_order)
            child_letter = None
        else:
            child_prod = f"{letter}-{db._str_id(production_order)}"
            child_letter = letter
        child_id = db.make_id(child_prod, material_number)
        child_ids[machine] = child_id

        child_qty = qty_alloc.get(machine) if qty_alloc else None
        if child_qty is not None and child_qty == 0:
            zero_qty += 1
        # below_min_lot is a §5.7 DERIVED (read-time) status, never stored --
        # min_lot_size is loaded here only so a future read path has it handy
        # via the same mat_attrs; no column on `orders` carries this flag.
        _ = min_lot_size

        child_run_time = (minutes_alloc[machine] / Decimal(60)) if minutes_alloc else None

        child_rows.append({
            "production_order": child_prod,
            "material_number": material_number,
            "material_description": parent_facts.get("material_description"),
            "machine": machine,
            "plant": plant,
            "basic_start_date": parent_facts.get("basic_start_date"),
            "basic_finish_date": parent_facts.get("basic_finish_date"),
            "run_time": float(child_run_time) if child_run_time is not None else None,
            "color": parent_facts.get("color"),
            "order_quantity": float(child_qty) if child_qty is not None else None,
            "form_size": parent_facts.get("form_size"),
            "firming_indicator": parent_facts.get("firming_indicator"),
            "planned_order_initial_quantity": parent_facts.get("planned_order_initial_quantity"),
            "reduced_quantity": parent_facts.get("reduced_quantity"),
            "order_category": parent_facts.get("order_category"),
            "order_type": parent_facts.get("order_type"),
            "bom_alternative": parent_facts.get("bom_alternative"),
            "bom_usage": parent_facts.get("bom_usage"),
            "labor_hours": float(labor_alloc[machine]) if labor_alloc else None,
            "machine_hours": float(machine_alloc[machine]) if machine_alloc else None,
            "no_of_fte": parent_facts.get("no_of_fte"),
            "parent_production_order": db._str_id(production_order),
            "distribution_letter": child_letter,
        })
    return child_rows, child_ids, zero_qty


def _plan_one_parent(plant: str, production_order: str, material_number: str, row: dict,
                     classification: dict, existing: dict | None, workcenter_lookup: dict,
                     mat_attrs: dict, anchor_sources: dict, plain_id: str, batch_id: str,
                     warnings: dict) -> tuple[dict, list[dict]]:
    """Plan ONE distribute-mode parent -- either a brand-new header (§5.2
    "New") or an existing one, refreshed in place, possibly rerouted
    (decision I / §5.1 step 4). Returns (parent_plan, child_rows); the caller
    accumulates parent_plan into plan_structure["parents"] and extends
    rows_out with child_rows.
    """
    ctype = classification["type"]
    raw_code = row.get("machine")  # X, the uploaded work-center/machine value verbatim

    if existing is None:
        # New header -- only reachable for ctype == 'distribute' (the caller
        # routes every other classification with no existing header straight
        # to the "ordinary row, no header" branch without calling this).
        wc = workcenter_lookup.get(plant, {}).get(raw_code, {})
        members = wc.get("members", [])
        member_pairs = [(m, wc.get("member_weights", {}).get(m)) for m in members]
        shares, default_basis = service.compute_default_shares(mat_attrs, wc, member_pairs)
        letters = service.assign_letters(sorted(members))
        sap_workcenter = raw_code
        previous_workcenter = None
        anchor = anchor_sources.get(plain_id)
        header_snapshot = None
        header_xmin = None
        review_required = wc.get("review_required", True)
        previous_child_ids = {plain_id} if plain_id in anchor_sources else set()
    else:
        # Existing header -- shares/reviewed/default_basis are UNTOUCHED by
        # ingest (§5.2 "Existing"). Membership table already loaded shares
        # regardless of purged_at; a purged share is REVIVED by this refresh
        # ("the parent is evidently still in SAP") -- reflected here by
        # simply treating every current share as live for materialization.
        header_row = existing["header"]
        shares = {s["machine"]: s["weight"] for s in existing["shares"]}
        letters = {s["machine"]: s["letter"] for s in existing["shares"]}
        default_basis = header_row["default_basis"]
        header_xmin = existing["xmin"]
        header_snapshot = header_row
        review_required = None  # not used on the existing-header path
        anchor = None            # not a 1->N transition -- header already existed
        previous_child_ids = {s["child_id"] for s in existing["shares"] if s.get("child_id")}

        if ctype == "distribute" and raw_code == header_row["sap_workcenter"]:
            # No reroute -- carry the existing previous_workcenter forward
            # as-is (only a planner acknowledgement clears it, never a plain
            # ingest refresh).
            sap_workcenter = header_row["sap_workcenter"]
            previous_workcenter = (header_row.get("sap_facts") or {}).get("previous_workcenter")
        elif ctype == "distribute":
            # Decision I sub-case A: rerouted to ANOTHER distribute-mode work
            # center -- header keeps authority; sap_workcenter takes the new
            # code, the OLD one is recorded as previous_workcenter.
            sap_workcenter = raw_code
            previous_workcenter = header_row["sap_workcenter"]
        else:
            # Decision I sub-case B: rerouted to a single-mode code, a plain
            # machine, or a now-memberless work center (none of these can
            # hold header authority) -- header's sap_workcenter is LEFT
            # UNCHANGED; the new value is recorded as previous_workcenter
            # instead (the field is deliberately overloaded to hold
            # "whichever side isn't the header's own code" -- aggregate_to_detail.md
            # §5.1 step 4's own wording).
            sap_workcenter = header_row["sap_workcenter"]
            previous_workcenter = raw_code

    parent_facts, runtime_defaulted = _extract_parent_facts(row)
    if runtime_defaulted:
        warnings["parent_runtime_defaulted"] += 1

    child_rows, child_ids_by_machine, zero_qty_count = _build_child_rows(
        plant, production_order, material_number, parent_facts, shares, letters, mat_attrs,
    )
    warnings["zero_quantity_children"] += zero_qty_count

    parent_plan = {
        "plant": plant,
        "production_order": production_order,
        "material_number": material_number,
        "sap_workcenter": sap_workcenter,
        "previous_workcenter": previous_workcenter,
        "existing_header": header_snapshot,
        "header_xmin": header_xmin,
        "shares": shares,
        "letters": letters,
        "default_basis": default_basis,
        "is_new_header": existing is None,
        "review_required": review_required,
        "child_ids": child_ids_by_machine,
        "previous_child_ids": previous_child_ids,
        "anchor": anchor,
        "parent_facts": parent_facts,
        "runtime_defaulted": runtime_defaulted,
        "child_rows": child_rows,
        "batch_id": batch_id,
        "_mat_attrs": mat_attrs,
    }
    return parent_plan, child_rows


def _plan_core(cur, rows: list[dict], batch_id: str, warnings: dict) -> tuple[list[dict], dict]:
    machine_lookup, workcenter_lookup = _load_lookups(cur)

    items = []
    for row in rows:
        plant, plant_warning = service.resolve_plant(row, machine_lookup, workcenter_lookup)
        if plant_warning:
            warnings["ambiguous_workcenter_plant"].append({
                "production_order": db._str_id(row.get("production_order")),
                "material_number": db._str_id(row.get("material_number")),
            })
            items.append({"row": row, "plant": None, "classification": None, "key": None})
            continue
        machine_value = row.get("machine")
        classification = service.classify_row(plant, machine_value, machine_lookup, workcenter_lookup)
        prod = db._str_id(row.get("production_order"))
        mat = db._str_id(row.get("material_number"))
        items.append({"row": row, "plant": plant, "classification": classification,
                     "key": (plant, prod, mat)})

    keys = [it["key"] for it in items if it["key"] is not None]
    existing_headers = _load_existing_headers(cur, keys)
    plain_ids = {key: db.make_id(key[1], key[2]) for key in keys}
    anchor_sources = _load_anchor_sources(cur, list(plain_ids.values()))
    material_attrs = _load_material_attrs(cur, {(k[0], k[2]) for k in keys})

    # D04: the duplicate/conflict rule now runs HERE -- after classification
    # and the existing-header load -- so it only touches groups actually
    # involved with distribution (see _dedupe_and_filter_conflicts' own
    # docstring). Excluded indices are skipped below without emitting a row.
    excluded = _dedupe_and_filter_conflicts(items, existing_headers, warnings)

    # D30: an uploaded row whose computed order id is an existing sub-order
    # (distribution_letter IS NOT NULL -- e.g. a grid export re-imported) would
    # pass through as an ordinary order and overwrite the sub-order's machine
    # and quantity, bypassing its machine lock. Warn and skip THAT row only
    # (never refuse the upload); skipped rows never reach rows_out, so the
    # generic upsert never writes them.
    row_ids = {idx: db.make_id(it["row"].get("production_order"), it["row"].get("material_number"))
               for idx, it in enumerate(items) if idx not in excluded}
    if row_ids:
        cur.execute(
            "SELECT id FROM orders WHERE id = ANY(%s) AND distribution_letter IS NOT NULL",
            (sorted(set(row_ids.values())),),
        )
        sub_ids = {r[0] for r in cur.fetchall()}
        if sub_ids:
            for idx, oid in sorted(row_ids.items()):
                if oid in sub_ids:
                    r = items[idx]["row"]
                    warnings["sub_order_id_rows"].append({
                        "production_order": db._str_id(r.get("production_order")),
                        "material_number": db._str_id(r.get("material_number")),
                    })
                    excluded.add(idx)

    rows_out: list[dict] = []
    parents_plan: dict[tuple[str, str, str], dict] = {}

    for idx, it in enumerate(items):
        if idx in excluded:
            continue
        row, plant, classification, key = it["row"], it["plant"], it["classification"], it["key"]
        if plant is None:
            rows_out.append(row)
            continue

        ctype = classification["type"]
        for w in classification.get("warnings", []):
            if w == "default_machine_invalid":
                warnings["default_machine_invalid"].append(
                    {"plant": plant, "production_order": key[1], "material_number": key[2]})
            elif w == "workcenter_without_members":
                warnings["workcenter_without_members"].append(
                    {"plant": plant, "production_order": key[1], "material_number": key[2],
                     "sap_workcenter": classification["machine"]})

        existing = existing_headers.get(key)

        if existing is None and ctype != "distribute":
            # Ordinary row -- no header involved. `classify_row` already
            # rewrote `classification["machine"]` for a valid single-mode
            # rewrite; a distribute_no_members / unresolved-default-machine
            # row stays exactly as classify_row left it (machine == the
            # unresolved code, per §5.1 step 3).
            row = dict(row)
            row["plant"] = plant
            row["machine"] = classification["machine"]
            if ctype == "single_rewrite":
                warnings["single_rewrites"] += 1
            rows_out.append(row)
            continue

        mat_attrs = material_attrs.get((plant, key[2]), {})

        # D03: a brand-new distribute-mode header whose default shares come
        # out all-zero (every member weight 0/NULL-and-no-material-default)
        # has no actual distribution policy -- distributing it would create
        # an all-zero-share header with zero-quantity children, same failure
        # mode as the memberless `distribute_no_members` case above. Must
        # live HERE, not in classify_row, because a material_default /
        # tooled_single rule can still yield a valid 100% share even when
        # every workcenter weight is 0 -- classify_row has no material
        # context to make that call. Self-contained on purpose: B4
        # restructures _plan_core to move the duplicate/conflict filter
        # after classification, and this branch must survive that move
        # unchanged.
        if existing is None and ctype == "distribute":
            wc = workcenter_lookup.get(plant, {}).get(classification["machine"], {})
            member_pairs = [(m, wc.get("member_weights", {}).get(m)) for m in wc.get("members", [])]
            default_shares, _default_basis = service.compute_default_shares(mat_attrs, wc, member_pairs)
            if not any(w > 0 for w in default_shares.values()):
                warnings["workcenter_without_members"].append({
                    "plant": plant, "production_order": key[1], "material_number": key[2],
                    "sap_workcenter": classification["machine"], "reason": "zero_weights",
                })
                row = dict(row)
                row["plant"] = plant
                rows_out.append(row)
                continue

        parent_plan, child_rows = _plan_one_parent(
            plant, key[1], key[2], row, classification, existing, workcenter_lookup,
            mat_attrs, anchor_sources, plain_ids.get(key), batch_id, warnings,
        )
        if ctype == "single_rewrite":
            warnings["single_rewrites"] += 1
        parents_plan[key] = parent_plan
        rows_out.extend(child_rows)

    plan_structure = {"batch_id": batch_id, "parents": parents_plan, "ingest_warnings": warnings}
    return rows_out, plan_structure


def plan(rows: list[dict], batch_id: str, conn=None) -> tuple[list[dict], dict, dict]:
    """§5.1-§5.3: resolve, classify, and materialize an ingest batch's rows
    BEFORE the caller's normal upsert/dedup loop runs.

    `rows` is the same lowercase-orders-column-keyed list of dicts
    `db.upsert_orders` consumes (e.g. as built by
    `db.ingest_orders_from_excel`'s per-row loop) -- NOT yet id-assigned or
    deduped (that happens downstream, unchanged, once the caller feeds
    `rows_out` into `db.upsert_orders`).

    `conn`, when given, is used as-is (no commit/rollback -- this function
    never writes); when omitted, a short-lived connection is opened via
    `_pool.connection()` for the duration of this call only, per
    aggregate_to_detail.md §5's "own short pooled connection" ("READ-ONLY").

    Returns (rows_out, plan_structure, warnings):
      - rows_out: the parent row replaced by its per-machine child rows (or
        left as a single, possibly machine-rewritten, row) -- feed this into
        db.upsert_orders unchanged.
      - plan_structure: {"batch_id", "parents": {key: {...}}, "ingest_warnings",
        "warnings_entry"} -- everything `apply()` needs per parent, including
        the `ingest_warnings` dict itself (apply() has no separate parameter
        for it, so it rides along on the plan structure it returns).
        `warnings_entry` (D04) is this function's OWN upload_audit.warnings
        entry, built from zero distribution counters since no parent has
        actually been distributed yet at this point (apply() hasn't run) --
        `db.upsert_orders` falls back to it when apply_fn never runs (no
        parent this batch) but this function still raised a real ingest
        warning (e.g. a conflicting/ambiguous row, or a zero-weight work
        center), so that warning isn't silently dropped.
      - warnings: aggregate_to_detail.md §5.1-§5.3's warning codes, ready to
        fold into the final `upload_audit.warnings` entry `apply()` helps
        build.
    """
    warnings = _empty_ingest_warnings()

    if conn is not None:
        with conn.cursor() as cur:
            rows_out, plan_structure = _plan_core(cur, rows, batch_id, warnings)
    else:
        with _pool.connection() as new_conn, new_conn.cursor() as cur:
            rows_out, plan_structure = _plan_core(cur, rows, batch_id, warnings)

    zero_counters = {
        "parents_distributed": 0, "children_upserted": 0, "children_deleted": 0,
        "headers_created": 0, "headers_refreshed": 0, "replanned_after_reweight": 0,
    }
    plan_structure["warnings_entry"] = _build_warnings_entry(warnings, zero_counters, no_parents=True)

    return rows_out, plan_structure, warnings


# ---------------------------------------------------------------------------
# apply() and its helpers
# ---------------------------------------------------------------------------

def _insert_new_header(cur, parent: dict, batch_id: str) -> bool:
    """INSERT a brand-new header row (§5.4 step 2: "New headers ... are
    simply INSERTed here, no lock needed"). `ON CONFLICT ... DO NOTHING`
    makes a genuine concurrent double-creation race -- or a second,
    idempotent `apply()` run over the SAME plan -- detectable by rowcount
    instead of raising a unique-violation; the caller re-fetches+locks and
    re-plans from current state in either case (see `apply()`)."""
    facts = parent["parent_facts"]
    sap_facts = _build_sap_facts(facts, None, parent.get("runtime_defaulted"))
    review_required = parent.get("review_required")
    reviewed = not review_required if review_required is not None else False
    # D16: a policy-reviewed insert (review_required = FALSE) must stamp
    # reviewed_at/reviewed_quantity the same way a manual review does
    # (_resolve_review_stamp) -- otherwise qty_changed can never fire for a
    # header that was never manually reviewed, since reviewed_quantity stays
    # NULL forever.
    reviewed_at = datetime.now(timezone.utc) if reviewed else None
    reviewed_quantity = facts.get("order_quantity") if reviewed else None
    cur.execute(
        """
        INSERT INTO order_distribution (
            plant, production_order, material_number, sap_workcenter,
            order_quantity, run_time, basic_start_date, basic_finish_date,
            firming_indicator, sap_facts, source, default_basis,
            reviewed, reviewed_by, reviewed_at, reviewed_quantity, last_batch_id
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'default', %s, %s, %s, %s, %s, %s)
        ON CONFLICT (plant, production_order, material_number) DO NOTHING
        """,
        (parent["plant"], parent["production_order"], parent["material_number"],
         parent["sap_workcenter"], facts.get("order_quantity"), facts.get("run_time"),
         facts.get("basic_start_date"), facts.get("basic_finish_date"),
         facts.get("firming_indicator"), Jsonb(sap_facts), parent["default_basis"],
         reviewed, "policy" if reviewed else None, reviewed_at, reviewed_quantity, batch_id),
    )
    return cur.rowcount == 1


def _write_header_facts(cur, parent: dict, batch_id: str) -> None:
    """Refresh header SAP facts only (§5.2 "Existing"), guarded so a second
    run with identical facts changes nothing -- shares/reviewed/default_basis
    are untouched here by design."""
    facts = parent["parent_facts"]
    sap_facts = _build_sap_facts(facts, parent.get("previous_workcenter"), parent.get("runtime_defaulted"))
    cur.execute(
        """
        UPDATE order_distribution
           SET sap_workcenter    = %(wc)s,
               order_quantity    = %(qty)s,
               run_time          = %(rt)s,
               basic_start_date  = %(bs)s,
               basic_finish_date = %(bf)s,
               firming_indicator = %(fi)s,
               sap_facts         = %(facts)s,
               last_batch_id     = %(batch)s,
               updated_at        = now()
         WHERE plant = %(plant)s AND production_order = %(po)s AND material_number = %(mat)s
           AND (sap_workcenter    IS DISTINCT FROM %(wc)s
             OR order_quantity    IS DISTINCT FROM %(qty)s
             OR run_time          IS DISTINCT FROM %(rt)s
             OR basic_start_date  IS DISTINCT FROM %(bs)s
             OR basic_finish_date IS DISTINCT FROM %(bf)s
             OR firming_indicator IS DISTINCT FROM %(fi)s
             OR sap_facts         IS DISTINCT FROM %(facts)s
             OR last_batch_id     IS DISTINCT FROM %(batch)s)
        """,
        {"wc": parent["sap_workcenter"], "qty": facts.get("order_quantity"),
         "rt": facts.get("run_time"), "bs": facts.get("basic_start_date"),
         "bf": facts.get("basic_finish_date"), "fi": facts.get("firming_indicator"),
         "facts": Jsonb(sap_facts), "batch": batch_id,
         "plant": parent["plant"], "po": parent["production_order"], "mat": parent["material_number"]},
    )


def _write_shares(cur, parent: dict) -> None:
    """New header: INSERT one share row per current member (including
    weight-0 ones -- their letter stays reserved), guarded so re-running with
    identical letters/weights is a no-op. Existing/rerouted header: shares
    are UNTOUCHED by ingest except for reviving any purged one (§5.2:
    "A share with purged_at set is revived (cleared) by this refresh because
    the parent is evidently still in SAP")."""
    if parent["is_new_header"]:
        for machine, letter in parent["letters"].items():
            weight = _dec(parent["shares"].get(machine))
            cur.execute(
                """
                INSERT INTO order_distribution_share
                    (plant, production_order, material_number, machine, letter, weight)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (plant, production_order, material_number, machine) DO UPDATE
                    SET letter = EXCLUDED.letter, weight = EXCLUDED.weight
                WHERE order_distribution_share.letter IS DISTINCT FROM EXCLUDED.letter
                   OR order_distribution_share.weight IS DISTINCT FROM EXCLUDED.weight
                """,
                (parent["plant"], parent["production_order"], parent["material_number"],
                 machine, letter, weight),
            )
    else:
        cur.execute(
            """
            UPDATE order_distribution_share
               SET purged_at = NULL
             WHERE plant = %s AND production_order = %s AND material_number = %s
               AND purged_at IS NOT NULL
            """,
            (parent["plant"], parent["production_order"], parent["material_number"]),
        )


def _lock_one_header(cur, plant: str, production_order: str, material_number: str,
                     *, for_update: bool = True) -> dict | None:
    """Lock (by default `FOR UPDATE`) + read of exactly one header, used for
    the "someone else created/changed this concurrently" race branches in
    `apply()`, and for every single-header planner-write call site below.

    `for_update=False` (D56): a dry run never writes (see
    `_materialize_reweight`'s `if dry_run: return ...` -- every line above
    that return is pure computation), so a dry-run caller passes
    `for_update=False` to read the header WITHOUT taking the row lock at
    all, instead of taking-then-releasing it. Every other caller keeps the
    default and locks as before."""
    lock_clause = "FOR UPDATE" if for_update else ""
    cur.execute(
        f"""
        SELECT plant, production_order, material_number, sap_workcenter, order_quantity,
               run_time, basic_start_date, basic_finish_date, firming_indicator, sap_facts,
               source, default_basis, reviewed, reviewed_by, reviewed_at, reviewed_quantity,
               updated_by, last_batch_id, xmin::text::bigint
          FROM order_distribution
         WHERE plant = %s AND production_order = %s AND material_number = %s
         {lock_clause}
        """,
        (plant, production_order, material_number),
    )
    r = cur.fetchone()
    if r is None:
        return None
    return {
        "plant": r[0], "production_order": r[1], "material_number": r[2],
        "sap_workcenter": r[3], "order_quantity": r[4], "run_time": r[5],
        "basic_start_date": r[6], "basic_finish_date": r[7], "firming_indicator": r[8],
        "sap_facts": r[9] or {}, "source": r[10], "default_basis": r[11],
        "reviewed": r[12], "reviewed_by": r[13], "reviewed_at": r[14],
        "reviewed_quantity": r[15], "updated_by": r[16], "last_batch_id": r[17], "xmin": r[18],
    }


def _replan_from_current_header(cur, parent: dict, current: dict | None) -> dict:
    """§5.4 step 3: re-plan ONE parent from the header's CURRENT shares and
    facts -- used both for a genuine xmin mismatch (a planner re-weighted
    between `plan()`'s snapshot and `apply()`'s lock) and for the
    "concurrently created by someone else" race on a to-be-new header. The
    planner's concurrent edit wins: children are re-materialized from what is
    on file NOW, not from the stale `plan()`-time snapshot. Membership itself
    (which machines HAVE a share row) is not something ingest ever changes --
    only weights/letters could have moved, and only among machines that
    already had a share."""
    plant, po, mat = parent["plant"], parent["production_order"], parent["material_number"]
    cur.execute(
        """SELECT machine, letter, weight, child_id, purged_at
             FROM order_distribution_share
            WHERE plant = %s AND production_order = %s AND material_number = %s""",
        (plant, po, mat),
    )
    current_shares = [
        {"machine": r[0], "letter": r[1], "weight": r[2], "child_id": r[3], "purged_at": r[4]}
        for r in cur.fetchall()
    ]
    live_shares = {s["machine"]: s["weight"] for s in current_shares}
    live_letters = {s["machine"]: s["letter"] for s in current_shares}
    previous_child_ids = {s["child_id"] for s in current_shares if s.get("child_id")}

    mat_attrs = parent.get("_mat_attrs", {})
    child_rows, child_ids, zero_qty = _build_child_rows(
        plant, po, mat, parent["parent_facts"], live_shares, live_letters, mat_attrs,
    )

    new_parent = dict(parent)
    # D06: the upload's normal chunks already wrote the PLAN-TIME child rows
    # (and left the plan-time previous set alone). If the header moved since
    # plan() -- a re-weight/collapse -- ids in either set that the current
    # shares no longer intend would otherwise never be removed. Stash them
    # BEFORE child_ids/previous_child_ids are overwritten below; apply()
    # supersedes (previous ∪ plan-time) - intended.
    new_parent["plan_time_child_ids"] = (
        set(parent.get("child_ids", {}).values()) | set(parent.get("previous_child_ids", set()))
    )
    new_parent["shares"] = live_shares
    new_parent["letters"] = live_letters
    new_parent["child_ids"] = child_ids
    new_parent["previous_child_ids"] = previous_child_ids
    new_parent["child_rows"] = child_rows
    new_parent["is_new_header"] = False
    new_parent["anchor"] = None
    if current is not None:
        new_parent["sap_workcenter"] = current["sap_workcenter"]
        new_parent["default_basis"] = current["default_basis"]
        new_parent["previous_workcenter"] = (current.get("sap_facts") or {}).get("previous_workcenter")
        new_parent["existing_header"] = current
        new_parent["header_xmin"] = current["xmin"]
    return new_parent


_CHILD_UPSERT_SQL = """
    INSERT INTO orders (
        id, production_order, material_number, material_description,
        machine, plant, basic_start_date, basic_finish_date,
        run_time, color, order_quantity, form_size, firming_indicator,
        planned_order_initial_quantity, reduced_quantity, order_category, order_type,
        bom_alternative, bom_usage, labor_hours, machine_hours, no_of_fte,
        parent_production_order, distribution_letter, upload_batch_id, updated_at
    ) VALUES (
        %(id)s, %(production_order)s, %(material_number)s, %(material_description)s,
        %(machine)s, %(plant)s, %(basic_start_date)s, %(basic_finish_date)s,
        %(run_time)s, %(color)s, %(order_quantity)s, %(form_size)s, %(firming_indicator)s,
        %(planned_order_initial_quantity)s, %(reduced_quantity)s, %(order_category)s, %(order_type)s,
        %(bom_alternative)s, %(bom_usage)s, %(labor_hours)s, %(machine_hours)s, %(no_of_fte)s,
        %(parent_production_order)s, %(distribution_letter)s, %(batch_id)s, NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
        order_quantity          = EXCLUDED.order_quantity,
        run_time                = CASE
            WHEN orders.run_time_source IN ('routing', 'manual') THEN orders.run_time
            ELSE EXCLUDED.run_time END,
        labor_hours             = EXCLUDED.labor_hours,
        machine_hours           = EXCLUDED.machine_hours,
        material_description    = EXCLUDED.material_description,
        basic_start_date        = EXCLUDED.basic_start_date,
        basic_finish_date       = EXCLUDED.basic_finish_date,
        color                   = EXCLUDED.color,
        form_size               = EXCLUDED.form_size,
        firming_indicator       = EXCLUDED.firming_indicator,
        planned_order_initial_quantity = EXCLUDED.planned_order_initial_quantity,
        reduced_quantity        = EXCLUDED.reduced_quantity,
        order_category          = EXCLUDED.order_category,
        order_type              = EXCLUDED.order_type,
        bom_alternative         = EXCLUDED.bom_alternative,
        bom_usage               = EXCLUDED.bom_usage,
        no_of_fte               = EXCLUDED.no_of_fte,
        machine                 = EXCLUDED.machine,
        plant                   = EXCLUDED.plant,
        parent_production_order = EXCLUDED.parent_production_order,
        distribution_letter     = EXCLUDED.distribution_letter,
        upload_batch_id         = EXCLUDED.upload_batch_id,
        runtime_schedule_mismatch = COALESCE(orders.runtime_schedule_mismatch, FALSE),
        updated_at              = NOW()
    WHERE orders.order_quantity IS DISTINCT FROM EXCLUDED.order_quantity
       OR orders.run_time IS DISTINCT FROM EXCLUDED.run_time
       OR orders.labor_hours IS DISTINCT FROM EXCLUDED.labor_hours
       OR orders.machine_hours IS DISTINCT FROM EXCLUDED.machine_hours
       OR orders.material_description IS DISTINCT FROM EXCLUDED.material_description
       OR orders.basic_start_date IS DISTINCT FROM EXCLUDED.basic_start_date
       OR orders.basic_finish_date IS DISTINCT FROM EXCLUDED.basic_finish_date
       OR orders.color IS DISTINCT FROM EXCLUDED.color
       OR orders.form_size IS DISTINCT FROM EXCLUDED.form_size
       OR orders.firming_indicator IS DISTINCT FROM EXCLUDED.firming_indicator
       OR orders.planned_order_initial_quantity IS DISTINCT FROM EXCLUDED.planned_order_initial_quantity
       OR orders.reduced_quantity IS DISTINCT FROM EXCLUDED.reduced_quantity
       OR orders.order_category IS DISTINCT FROM EXCLUDED.order_category
       OR orders.order_type IS DISTINCT FROM EXCLUDED.order_type
       OR orders.bom_alternative IS DISTINCT FROM EXCLUDED.bom_alternative
       OR orders.bom_usage IS DISTINCT FROM EXCLUDED.bom_usage
       OR orders.no_of_fte IS DISTINCT FROM EXCLUDED.no_of_fte
       OR orders.machine IS DISTINCT FROM EXCLUDED.machine
       OR orders.plant IS DISTINCT FROM EXCLUDED.plant
       OR orders.parent_production_order IS DISTINCT FROM EXCLUDED.parent_production_order
       OR orders.distribution_letter IS DISTINCT FROM EXCLUDED.distribution_letter
       OR orders.upload_batch_id IS DISTINCT FROM EXCLUDED.upload_batch_id
"""
# Deliberately NOT in the SET clause (mirrors db.py's own _UPSERT_SQL
# comment): scheduled_start, scheduled_end, notes, planning_status,
# planning_reason. A KEPT child's schedule/notes/planning state must survive
# every ingest untouched; only a BRAND-NEW child gets those fields at all,
# via _carry_anchor_onto_new_child below, never through this statement.


def _carry_anchor_onto_new_child(cur, child_id: str, anchor: dict | None) -> None:
    """§5.4 step 5: carry the 1->N anchor onto a BRAND-NEW child only. `anchor`
    is None for an ordinary new header with no prior plain order (children
    stay unscheduled, like any newly-uploaded order). Segments are
    deliberately NOT carried (they belonged to one machine and one run time)."""
    if not anchor:
        return
    if anchor.get("planning_status") == "needs_planning":
        reason = anchor.get("planning_reason")
        cur.execute(
            """
            UPDATE orders
               SET scheduled_start = NULL, scheduled_end = NULL,
                   notes = %(notes)s, planning_status = 'needs_planning',
                   planning_reason = %(reason)s, updated_at = NOW()
             WHERE id = %(id)s
               AND (notes IS DISTINCT FROM %(notes)s
                 OR planning_status IS DISTINCT FROM 'needs_planning'
                 OR planning_reason IS DISTINCT FROM %(reason)s)
            """,
            {"notes": anchor.get("notes"), "reason": Jsonb(reason) if reason is not None else None,
             "id": child_id},
        )
        return

    start = anchor.get("anchor")
    if start is None:
        return
    cur.execute("SELECT run_time FROM orders WHERE id = %s", (child_id,))
    row = cur.fetchone()
    run_time = row[0] if row else None
    end = start + timedelta(hours=float(run_time)) if run_time and _dec(run_time) > 0 else None
    cur.execute(
        """
        UPDATE orders
           SET scheduled_start = %(start)s, scheduled_end = %(end)s,
               notes = %(notes)s, planning_status = 'scheduled',
               planning_reason = NULL, updated_at = NOW()
         WHERE id = %(id)s
           AND (scheduled_start IS DISTINCT FROM %(start)s
             OR scheduled_end IS DISTINCT FROM %(end)s
             OR notes IS DISTINCT FROM %(notes)s
             OR planning_status IS DISTINCT FROM 'scheduled'
             OR planning_reason IS NOT NULL)
        """,
        {"start": start, "end": end, "notes": anchor.get("notes"), "id": child_id},
    )


def _apply_children(cur, parent: dict) -> int:
    """Idempotently create/correct every child row this parent's current
    shares call for (§5.3 materialization + §5.4 steps 3 and 5). Any child
    NOT in `previous_child_ids` is brand-new and gets the anchor carry;
    everything else is a guarded, no-op-when-unchanged correction. Returns
    the number of rows actually written (touched)."""
    previous_ids = parent["previous_child_ids"]
    anchor = parent.get("anchor")
    touched = 0
    for child_row in parent["child_rows"]:
        child_id = db.make_id(child_row["production_order"], child_row["material_number"])
        is_new = child_id not in previous_ids
        params = dict(child_row)
        params["id"] = child_id
        params["batch_id"] = parent["batch_id"]
        cur.execute(_CHILD_UPSERT_SQL, params)
        if cur.rowcount:
            touched += 1
        if is_new:
            _carry_anchor_onto_new_child(cur, child_id, anchor)
    return touched


def _delete_superseded_children(cur, ids: set[str]) -> int:
    """§5.4 step 6: delete every `orders` row whose id is superseded (in the
    previous child set but not the new intended one). `order_schedule_segments`
    cascades via its FK. Any ACTIVE `setup_occurrence_override` naming a
    deleted id as predecessor or successor moves to 'replaced' first (guarded
    to `status = 'active'` so a second run touches zero rows)."""
    if not ids:
        return 0
    id_list = sorted(ids)
    # D17: lock the rows in id order before moving overrides / deleting, so a
    # concurrent /tasks save of one of them waits (and then conflicts) instead
    # of racing the delete.
    cur.execute("SELECT id FROM orders WHERE id = ANY(%s) ORDER BY id FOR UPDATE", (id_list,))
    cur.execute(
        """
        UPDATE setup_occurrence_override
           SET status = 'replaced', updated_at = NOW()
         WHERE status = 'active'
           AND (predecessor_order_id = ANY(%s) OR successor_order_id = ANY(%s))
        """,
        (id_list, id_list),
    )
    cur.execute("DELETE FROM orders WHERE id = ANY(%s)", (id_list,))
    return cur.rowcount


def _unscheduled_ids(cur, ids: set[str]) -> set[str]:
    """Subset of `ids` that exist and carry no schedule (no scheduled_start
    and no segments) -- safe to delete without a scheduled-removal confirm."""
    if not ids:
        return set()
    cur.execute(
        """
        SELECT o.id FROM orders o
         WHERE o.id = ANY(%s) AND o.scheduled_start IS NULL
           AND NOT EXISTS (SELECT 1 FROM order_schedule_segments g WHERE g.order_id = o.id)
        """,
        (sorted(ids),),
    )
    return {r[0] for r in cur.fetchall()}


def _update_share_child_ids(cur, parent: dict) -> None:
    """§5.4 step 7: point every share at its current child (or NULL for a
    weight-0/purged member), guarded so an already-correct value is a no-op."""
    for machine, child_id in parent["child_ids"].items():
        cur.execute(
            """
            UPDATE order_distribution_share
               SET child_id = %s
             WHERE plant = %s AND production_order = %s AND material_number = %s AND machine = %s
               AND child_id IS DISTINCT FROM %s
            """,
            (child_id, parent["plant"], parent["production_order"], parent["material_number"],
             machine, child_id),
        )
    zero_or_purged = [m for m in parent["letters"] if m not in parent["child_ids"]]
    if zero_or_purged:
        cur.execute(
            """
            UPDATE order_distribution_share
               SET child_id = NULL
             WHERE plant = %s AND production_order = %s AND material_number = %s
               AND machine = ANY(%s) AND child_id IS NOT NULL
            """,
            (parent["plant"], parent["production_order"], parent["material_number"], zero_or_purged),
        )


def _build_warnings_entry(ingest_warnings: dict, counters: dict, *, no_parents: bool = False) -> dict:
    """Build the ONE `upload_audit.warnings` entry this whole ingest run
    contributes (§5.4 step 7) -- shape mirrors the existing
    `missing_master_data` entry (db.py's own `upsert_orders`): only `level`
    and `msg` are guaranteed read by the cockpit's warning list; everything
    else is this entry's own detail.

    `no_parents=True` (D04) is passed from `plan()`, where `counters` is
    always all-zero because apply() hasn't run yet -- the summary clause is
    phrased accordingly instead of claiming "0 aggregate order(s)
    distributed", which would misleadingly read as a failed distribution
    attempt rather than as "none was needed this batch"."""
    duplicates_dropped = len(ingest_warnings.get("duplicate_parent_rows", []))
    conflicting = ingest_warnings.get("conflicting_parent_rows", [])
    ambiguous = ingest_warnings.get("ambiguous_workcenter_plant", [])
    wc_no_members = ingest_warnings.get("workcenter_without_members", [])
    default_invalid = ingest_warnings.get("default_machine_invalid", [])
    sub_order_rows = ingest_warnings.get("sub_order_id_rows", [])
    failed_parents = ingest_warnings.get("failed_parents", [])
    zero_qty = int(ingest_warnings.get("zero_quantity_children", 0))
    runtime_defaulted = int(ingest_warnings.get("parent_runtime_defaulted", 0))
    single_rewrites = int(ingest_warnings.get("single_rewrites", 0))

    entry = {
        "category": "distribution",
        "parents_distributed": counters["parents_distributed"],
        "children_upserted": counters["children_upserted"],
        "children_deleted": counters["children_deleted"],
        "headers_created": counters["headers_created"],
        "headers_refreshed": counters["headers_refreshed"],
        "replanned_after_reweight": counters["replanned_after_reweight"],
        "single_rewrites": single_rewrites,
        "duplicates_dropped": duplicates_dropped,
        "conflicting_parent_rows": conflicting,
        "zero_quantity_children": zero_qty,
        "parent_runtime_defaulted": runtime_defaulted,
        "ambiguous_plant": ambiguous,
        "workcenter_without_members": wc_no_members,
        "default_machine_invalid": default_invalid,
        "sub_order_id_rows": sub_order_rows,
        "failed_parents": failed_parents,
    }
    warn_worthy = bool(
        failed_parents or sub_order_rows or conflicting or ambiguous or wc_no_members or default_invalid
        or counters["children_deleted"] or zero_qty or runtime_defaulted
        or duplicates_dropped or counters["replanned_after_reweight"]
    )
    n, m, k, p = (counters["parents_distributed"], counters["children_upserted"],
                 counters["children_deleted"], len(conflicting))
    entry["level"] = "warn" if warn_worthy else "info"
    if no_parents:
        entry["msg"] = (
            f"No aggregate orders distributed this batch ({p} parent(s) ambiguous)" if p
            else "No aggregate orders distributed this batch"
        )
    else:
        entry["msg"] = (f"{n} aggregate order(s) distributed into {m} sub-order(s) "
                        f"({k} deleted, {p} parent(s) ambiguous)")
    if sub_order_rows:
        sample = ", ".join(r["production_order"] for r in sub_order_rows[:5])
        more = f" (+{len(sub_order_rows) - 5} more)" if len(sub_order_rows) > 5 else ""
        entry["msg"] += (f"; {len(sub_order_rows)} row(s) skipped because their order number is an "
                         f"existing distributed sub-order: {sample}{more}")
    if failed_parents:
        sample = ", ".join(f"{r['production_order']}/{r['material_number']}" for r in failed_parents[:5])
        more = f" (+{len(failed_parents) - 5} more)" if len(failed_parents) > 5 else ""
        entry["msg"] += (f"; {len(failed_parents)} aggregate order(s) could not be distributed and "
                         f"were skipped: {sample}{more}")
    return entry


def _empty_apply_result() -> dict:
    counters = {
        "parents_distributed": 0, "children_upserted": 0, "children_deleted": 0,
        "headers_created": 0, "headers_refreshed": 0, "replanned_after_reweight": 0,
    }
    return {**counters, "warnings_entry": _build_warnings_entry({}, counters), "ingest_warnings": {}}


_APPLY_CHUNK_PARENTS = 50  # D01: parents per SAVEPOINT in apply()


def apply(plan: dict, batch_id: str, conn, *, actor: str = "system") -> dict:
    """§5.4: the post-hook transaction, run AFTER the caller's normal upsert
    chunks and backfills have committed, as ONE transaction on `conn` (the
    caller commits/rolls back -- this function does call `conn.commit()`
    itself at the end on success, matching every other multi-step write in
    this module, e.g. `save_workcenter`).

    `plan` is exactly the `plan_structure` `plan()` returned (its
    `ingest_warnings` key rides along so this function doesn't need a
    separate parameter for function 1's warnings dict).

    Idempotent: every write here is guarded (`ON CONFLICT ... DO NOTHING` /
    `DO UPDATE ... WHERE`, or a plain `UPDATE ... WHERE x IS DISTINCT FROM`)
    so calling `apply()` a second time with the SAME `plan` touches zero rows
    beyond what postgres's MVCC bookkeeping does internally -- no new
    children, no re-deleted children, no re-written header/shares.

    N->1 collapse is explicitly OUT of scope here -- see this file's module
    docstring "Scope boundary" note; that belongs to the planner re-weight
    endpoint (§5.5 bullet 6, `reweight_shares`/`_collapse_to_survivor` further
    down this file).
    """
    parents: dict = plan.get("parents", {})
    if not parents:
        return _empty_apply_result()

    plants = sorted({p["plant"] for p in parents.values()})
    setup_data.capture_setup_states_before_schedule_mutation(
        actor=actor, reason=f"Order distribution ingest (batch {batch_id})",
        plants=plants or None,
    )

    keys = sorted(parents.keys())
    counters = {
        "parents_distributed": 0, "children_upserted": 0, "children_deleted": 0,
        "headers_created": 0, "headers_refreshed": 0, "replanned_after_reweight": 0,
    }

    with conn.cursor() as cur:
        # Step 2: lock every EXISTING header in ONE key-ordered statement --
        # deadlock-safe against a concurrent re-weight, which locks the same
        # way. New headers are simply INSERTed below; no lock needed for a
        # row that doesn't exist yet.
        existing_keys = [k for k in keys if not parents[k]["is_new_header"]]
        locked: dict[tuple[str, str, str], dict] = {}
        if existing_keys:
            plants_l = [k[0] for k in existing_keys]
            prods_l = [k[1] for k in existing_keys]
            mats_l = [k[2] for k in existing_keys]
            cur.execute(
                """
                SELECT plant, production_order, material_number, sap_workcenter, order_quantity,
                       run_time, basic_start_date, basic_finish_date, firming_indicator, sap_facts,
                       source, default_basis, reviewed, reviewed_by, reviewed_at, reviewed_quantity,
                       updated_by, last_batch_id, xmin::text::bigint
                  FROM order_distribution
                 WHERE plant = ANY(%s) AND production_order = ANY(%s) AND material_number = ANY(%s)
                 ORDER BY plant, production_order, material_number
                 FOR UPDATE
                """,
                (plants_l, prods_l, mats_l),
            )
            key_set = set(existing_keys)
            for r in cur.fetchall():
                key = (r[0], r[1], r[2])
                if key not in key_set:
                    continue
                locked[key] = {
                    "plant": r[0], "production_order": r[1], "material_number": r[2],
                    "sap_workcenter": r[3], "order_quantity": r[4], "run_time": r[5],
                    "basic_start_date": r[6], "basic_finish_date": r[7], "firming_indicator": r[8],
                    "sap_facts": r[9] or {}, "source": r[10], "default_basis": r[11],
                    "reviewed": r[12], "reviewed_by": r[13], "reviewed_at": r[14],
                    "reviewed_quantity": r[15], "updated_by": r[16], "last_batch_id": r[17],
                    "xmin": r[18],
                }

        def _apply_one_parent(key: tuple[str, str, str], local: dict) -> None:
            parent = parents[key]
            plant, production_order, material_number = key

            if parent["is_new_header"]:
                inserted = _insert_new_header(cur, parent, batch_id)
                if inserted:
                    local["headers_created"] += 1
                    _write_shares(cur, parent)
                else:
                    # Race: another writer created this header between our
                    # plan() snapshot and this apply()'s attempted insert.
                    # Re-fetch+lock it and re-plan from what's there NOW.
                    current = _lock_one_header(cur, plant, production_order, material_number)
                    parent = _replan_from_current_header(cur, parent, current)
                    local["replanned_after_reweight"] += 1
                    _write_header_facts(cur, parent, batch_id)
                    local["headers_refreshed"] += 1
                    _write_shares(cur, parent)
            else:
                current = locked.get(key) or _lock_one_header(cur, plant, production_order, material_number)
                if current is None:
                    # Header vanished entirely between plan() and apply()
                    # (e.g. fully purged) -- fall back to creating it fresh.
                    _insert_new_header(cur, parent, batch_id)
                    local["headers_created"] += 1
                    _write_shares(cur, parent)
                else:
                    if current["xmin"] != parent["header_xmin"]:
                        # Step 3: re-check. A planner re-weighted between
                        # plan() and apply() -- the re-weight WINS.
                        parent = _replan_from_current_header(cur, parent, current)
                        local["replanned_after_reweight"] += 1
                    _write_header_facts(cur, parent, batch_id)
                    local["headers_refreshed"] += 1
                    _write_shares(cur, parent)

            local["children_upserted"] += _apply_children(cur, parent)
            local["parents_distributed"] += 1

            intended = set(parent["child_ids"].values())
            superseded = parent["previous_child_ids"] - intended
            local["children_deleted"] += _delete_superseded_children(cur, superseded)
            # D06: plan-time-only ids (replan path). Scheduled-removal safeguard:
            # these are not on any current share, so they are upload-created
            # orphans -- delete only the unscheduled ones; a scheduled one is
            # left in place (visible, carries the parent link) rather than
            # destroying planner work without confirmation.
            stale = parent.get("plan_time_child_ids", set()) - parent["previous_child_ids"] - intended
            if stale:
                local["children_deleted"] += _delete_superseded_children(
                    cur, _unscheduled_ids(cur, stale))

            _update_share_child_ids(cur, parent)

        # D01: one bad parent must not fail the whole upload. A SAVEPOINT per
        # chunk of parents (not per parent: thousands of subtransactions in one
        # SAP sync degrade every other session). On a chunk failure, roll back
        # to it and retry that chunk's parents one by one under their own
        # savepoints; only the parents that still fail are skipped and reported.
        failed_parents: list[dict] = []

        def _run_savepointed(sp: str, chunk_keys: list, local: dict) -> bool:
            cur.execute(f"SAVEPOINT {sp}")
            try:
                for k in chunk_keys:
                    _apply_one_parent(k, local)
            except Exception:
                cur.execute(f"ROLLBACK TO SAVEPOINT {sp}")
                cur.execute(f"RELEASE SAVEPOINT {sp}")
                return False
            cur.execute(f"RELEASE SAVEPOINT {sp}")
            return True

        for ci in range(0, len(keys), _APPLY_CHUNK_PARENTS):
            chunk = keys[ci:ci + _APPLY_CHUNK_PARENTS]
            local = {name: 0 for name in counters}
            if _run_savepointed(f"dist_chunk_{ci}", chunk, local):
                for name, n_ in local.items():
                    counters[name] += n_
                continue
            for k in chunk:
                local = {name: 0 for name in counters}
                if _run_savepointed(f"dist_parent_{ci}", [k], local):
                    for name, n_ in local.items():
                        counters[name] += n_
                else:
                    log.exception("distribution apply: parent %s failed; skipped", k)
                    failed_parents.append({"plant": k[0], "production_order": k[1], "material_number": k[2]})

    conn.commit()

    ingest_warnings = {**plan.get("ingest_warnings", {})}
    if failed_parents:
        ingest_warnings["failed_parents"] = failed_parents
    warnings_entry = _build_warnings_entry(ingest_warnings, counters)
    return {**counters, "warnings_entry": warnings_entry, "ingest_warnings": ingest_warnings}


# =====================================================================
# P2-6/P2-7 -- read routes (aggregate_to_detail.md §6 "Data", §7, §10.2)
# =====================================================================
#
# GET /distribution/{plant}                       -> list_headers_for_plant
# GET /distribution/{plant}/{order}/{material}     -> get_header_detail
# GET /distribution/{plant}/summary                -> get_summary
# GET /distribution/{plant}/aggregate              -> get_aggregate
# GET /distribution/{plant}/unresolved             -> get_unresolved
#
# Derived statuses are never stored (§5.7) -- every one of these functions
# recomputes them at read time via service.compute_derived_statuses(), fed
# from the SAME batched-load shape plan()/_load_existing_headers() already
# use elsewhere in this file (one query per table, never per header).

# Bucket definitions (§6 "Data" bullet) -- the SINGLE source of truth both
# list_headers_for_plant()'s `bucket` filter and get_summary()'s counts
# classify against, so the two routes can never drift apart (§7's summary
# row calls this out by name).
NEEDS_REVIEW_STATUSES = frozenset({"needs_review", "qty_changed"})
CHANGED_STATUSES = frozenset({
    "wc_changed", "membership_changed", "mode_mismatch",
    "below_min_lot", "zero_quantity_children",
})
# separation_violated is a P3a status computed CLIENT-SIDE from live children
# starts and the work center's max_separation (§6) -- it can never appear in
# a compute_derived_statuses() result. Listed here only so the bucket
# membership and the deep-link status list stay documented together; it
# never actually matches anything server-side.
PROBLEM_STATUSES = frozenset({"incomplete", "runtime_mismatch", "separation_violated"})

_STATUS_BUCKETS: dict[str, frozenset] = {
    "needs_review": NEEDS_REVIEW_STATUSES,
    "changed": CHANGED_STATUSES,
    "problems": PROBLEM_STATUSES,
}


def classify_bucket_membership(statuses: set) -> set:
    """One header's derived-status set -> the subset of {'needs_review',
    'changed', 'problems'} it belongs to. A header can be a member of more
    than one bucket at once (e.g. `needs_review` + `incomplete`) -- this
    counts memberships for `summary`'s counts, it does not pick the single
    primary badge the list pane shows (that severity ordering is a §6
    frontend concern, not this)."""
    return {bucket for bucket, codes in _STATUS_BUCKETS.items() if statuses & codes}


def status_matches_filter(statuses: set, status_or_bucket: str | None) -> bool:
    """`status_or_bucket` is None/''/'all' (no filter), one of the three
    bucket names above, or an individual status code accepted directly "for
    deep links" (aggregate_to_detail.md §6/§7, e.g. `?bucket=purged`)."""
    if not status_or_bucket or status_or_bucket == "all":
        return True
    if status_or_bucket in _STATUS_BUCKETS:
        return bool(statuses & _STATUS_BUCKETS[status_or_bucket])
    return status_or_bucket in statuses


# Safety cap on the candidate header set list_headers_for_plant()/get_summary()
# load before computing derived statuses in Python. A plant's order_distribution
# header count is bounded by its count of currently-tracked aggregate SAP
# orders (not the O(states^2) setup-matrix hazard the scale roadmap actually
# warns against, root CLAUDE.md), but bucket/status filtering is inherently a
# read-time Python computation (derived statuses are never stored, §5.7) that
# can't be pushed into the SQL LIMIT/OFFSET -- this bounds the SQL-filterable
# candidate set before that computation runs, rather than fetching every
# header a plant has ever had.
_LIST_CANDIDATE_CAP = 5000

_HEADER_COLUMNS_SQL = """
    plant, production_order, material_number, sap_workcenter, order_quantity,
    run_time, basic_start_date, basic_finish_date, firming_indicator, sap_facts,
    source, default_basis, reviewed, reviewed_by, reviewed_at, reviewed_quantity,
    updated_by, last_batch_id, updated_at, xmin::text::bigint
"""


def _row_to_header(r) -> dict:
    return {
        "plant": r[0], "production_order": r[1], "material_number": r[2],
        "sap_workcenter": r[3], "order_quantity": r[4], "run_time": r[5],
        "basic_start_date": r[6], "basic_finish_date": r[7], "firming_indicator": r[8],
        "sap_facts": r[9] or {}, "source": r[10], "default_basis": r[11],
        "reviewed": r[12], "reviewed_by": r[13], "reviewed_at": r[14],
        "reviewed_quantity": r[15], "updated_by": r[16], "last_batch_id": r[17],
        "updated_at": r[18], "base_version": r[19],
    }


# Keys `_attach_*` helpers stash onto a header dict that are internal
# working state, never part of the wire "header" object.
_INTERNAL_HEADER_KEYS = frozenset({"shares", "children", "workcenter", "machines", "statuses"})


def _fetch_header_rows(cur, plant: str, *, search: str | None = None, workcenter: str | None = None,
                       reviewed: bool | None = None, batch: str | None = None,
                       date_from=None, date_to=None, machines: list | None = None,
                       limit_cap: int | None = _LIST_CANDIDATE_CAP) -> list[dict]:
    """Every header matching the SQL-expressible filters (§6 "Data"), ordered
    `basic_start_date ASC, reviewed ASC` (§6's stated default sort), with
    `production_order ASC, material_number ASC` appended as a stable
    tiebreaker (D42) so paging never reorders same-start-date rows between
    pages. Bucket/status filtering happens afterward in Python (see module
    note above)."""
    where = ["plant = %s"]
    params: list = [plant]
    if search:
        where.append("(production_order ILIKE %s ESCAPE '\\' OR material_number ILIKE %s ESCAPE '\\')")
        like = db._like_contains(search)
        params.extend([like, like])
    if workcenter:
        where.append("sap_workcenter = %s")
        params.append(workcenter)
    if reviewed is not None:
        where.append("reviewed = %s")
        params.append(bool(reviewed))
    if batch:
        where.append("last_batch_id = %s")
        params.append(batch)
    if date_from is not None:
        where.append("basic_start_date >= %s")
        params.append(date_from)
    if date_to is not None:
        where.append("basic_start_date <= %s")
        params.append(date_to)
    if machines:
        where.append(
            "EXISTS (SELECT 1 FROM order_distribution_share s"
            " WHERE s.plant = order_distribution.plant"
            " AND s.production_order = order_distribution.production_order"
            " AND s.material_number = order_distribution.material_number"
            " AND s.machine = ANY(%s))"
        )
        params.append(list(machines))
    where_sql = " AND ".join(where)
    limit_sql = ""
    if limit_cap is not None:
        limit_sql = " LIMIT %s"
        params.append(limit_cap)
    cur.execute(
        f"""
        SELECT {_HEADER_COLUMNS_SQL}
          FROM order_distribution
         WHERE {where_sql}
         ORDER BY basic_start_date ASC NULLS LAST, reviewed ASC, production_order ASC, material_number ASC
         {limit_sql}
        """,
        params,
    )
    return [_row_to_header(r) for r in cur.fetchall()]


def _fetch_header_by_key(cur, plant: str, order: str, material: str) -> dict | None:
    cur.execute(
        f"SELECT {_HEADER_COLUMNS_SQL} FROM order_distribution"
        " WHERE plant = %s AND production_order = %s AND material_number = %s",
        (plant, order, material),
    )
    r = cur.fetchone()
    return _row_to_header(r) if r is not None else None


def _attach_shares(cur, plant: str, headers: list[dict]) -> None:
    """Batch-load shares for every header in `headers` -- one query, not one
    per header, mirroring `_load_existing_headers`'s convention."""
    if not headers:
        return
    prods = sorted({h["production_order"] for h in headers})
    mats = sorted({h["material_number"] for h in headers})
    cur.execute(
        """
        SELECT production_order, material_number, machine, letter, weight, child_id, purged_at
          FROM order_distribution_share
         WHERE plant = %s AND production_order = ANY(%s) AND material_number = ANY(%s)
        """,
        (plant, prods, mats),
    )
    by_key: dict[tuple, list[dict]] = {}
    for po, mat, machine, letter, weight, child_id, purged_at in cur.fetchall():
        by_key.setdefault((po, mat), []).append({
            "machine": machine, "letter": letter, "weight": weight,
            "child_id": child_id, "purged_at": purged_at,
        })
    for h in headers:
        h["shares"] = by_key.get((h["production_order"], h["material_number"]), [])


def _attach_children(cur, plant: str, headers: list[dict]) -> None:
    """Batch-load each header's current materialized children (`orders` rows
    pointing back via `parent_production_order`), keyed by machine so the
    derived-status computation and the detail route's per-share enrichment
    can both look a child up by (parent key, machine)."""
    if not headers:
        return
    prods = sorted({h["production_order"] for h in headers})
    mats = sorted({h["material_number"] for h in headers})
    cur.execute(
        """
        SELECT parent_production_order, material_number, production_order, machine,
               order_quantity, run_time, labor_hours, machine_hours,
               scheduled_start, basic_start_date, runtime_schedule_mismatch, id
          FROM orders
         WHERE plant = %s AND parent_production_order = ANY(%s) AND material_number = ANY(%s)
        """,
        (plant, prods, mats),
    )
    by_key: dict[tuple, list[dict]] = {}
    for (parent_po, mat, po, machine, qty, run_time, labor_hours, machine_hours,
         sched_start, basic_start, mismatch, oid) in cur.fetchall():
        by_key.setdefault((parent_po, mat), []).append({
            "id": oid, "production_order": po, "machine": machine,
            "order_quantity": qty, "run_time": run_time, "labor_hours": labor_hours,
            "machine_hours": machine_hours, "scheduled_start": sched_start,
            "basic_start_date": basic_start, "runtime_schedule_mismatch": bool(mismatch),
            "below_min_lot": False,
        })
    for h in headers:
        h["children"] = by_key.get((h["production_order"], h["material_number"]), [])


def _attach_workcenter_and_machines(cur, plant: str, headers: list[dict]) -> None:
    """Batch-load each header's work-center policy row and its CURRENT
    member machines (`machine.sap_workcenter`) -- the same shapes
    `service.compute_derived_statuses` takes for its `workcenter`/`machines`
    parameters."""
    if not headers:
        return
    wcs = sorted({h["sap_workcenter"] for h in headers if h.get("sap_workcenter")})
    if not wcs:
        for h in headers:
            h["workcenter"] = None
            h["machines"] = {}
        return
    cur.execute(
        """
        SELECT sap_workcenter, distribution_mode, default_machine, review_required, distribute_tooled
          FROM sap_workcenter WHERE plant = %s AND sap_workcenter = ANY(%s)
        """,
        (plant, wcs),
    )
    wc_by_code = {
        row[0]: {"sap_workcenter": row[0], "distribution_mode": row[1], "default_machine": row[2],
                 "review_required": bool(row[3]), "distribute_tooled": bool(row[4])}
        for row in cur.fetchall()
    }
    cur.execute(
        "SELECT machine, sap_workcenter FROM machine WHERE plant = %s AND sap_workcenter = ANY(%s)",
        (plant, wcs),
    )
    machines_by_wc: dict[str, dict[str, dict]] = {}
    for machine, wc in cur.fetchall():
        machines_by_wc.setdefault(wc, {})[machine] = {}
    for h in headers:
        wc = h.get("sap_workcenter")
        h["workcenter"] = wc_by_code.get(wc)
        h["machines"] = machines_by_wc.get(wc, {})


def _attach_min_lot(cur, plant: str, headers: list[dict]) -> None:
    """Batch-load `material_plants.min_lot_size` and flag each already-loaded
    child `below_min_lot` (§5.3: "children whose quantity is below
    material_plants.min_lot_size (> 0) are still created; the read path marks
    them below_min_lot")."""
    if not headers:
        return
    mats = sorted({h["material_number"] for h in headers})
    cur.execute(
        "SELECT material_id, min_lot_size FROM material_plants WHERE plant = %s AND material_id = ANY(%s)",
        (plant, mats),
    )
    min_lot_by_mat = {r[0]: r[1] for r in cur.fetchall()}
    for h in headers:
        min_lot = min_lot_by_mat.get(h["material_number"])
        if not min_lot or min_lot <= 0:
            continue
        for child in h.get("children", []):
            qty = child.get("order_quantity")
            child["below_min_lot"] = qty is not None and _dec(qty) < _dec(min_lot)


def _hydrate_headers(cur, plant: str, headers: list[dict]) -> None:
    """The full batched hydration + derived-status computation shared by
    every read route below: shares, children, workcenter/machines,
    below_min_lot, then `statuses`."""
    _attach_shares(cur, plant, headers)
    _attach_children(cur, plant, headers)
    _attach_workcenter_and_machines(cur, plant, headers)
    _attach_min_lot(cur, plant, headers)
    for h in headers:
        children_for_service = [
            {"machine": c["machine"], "order_quantity": c["order_quantity"],
             "below_min_lot": c.get("below_min_lot", False),
             "runtime_schedule_mismatch": c.get("runtime_schedule_mismatch", False)}
            for c in h.get("children", [])
        ]
        h["statuses"] = service.compute_derived_statuses(
            h, h.get("shares", []), children_for_service, h.get("workcenter"), h.get("machines", {}),
        )


def _children_summary(children: list[dict]) -> dict:
    total_qty = Decimal(0)
    starts = []
    for c in children:
        if c.get("order_quantity") is not None:
            total_qty += _dec(c["order_quantity"])
        start = c.get("scheduled_start") or c.get("basic_start_date")
        if start is not None:
            starts.append(start)
    return {
        "count": len(children),
        "total_quantity": float(total_qty),
        "earliest_start": min(starts) if starts else None,
    }


def _header_wire_shape(h: dict) -> dict:
    return {k: v for k, v in h.items() if k not in _INTERNAL_HEADER_KEYS}


def list_headers_for_plant(plant: str, *, search: str | None = None, workcenter: str | None = None,
                           machines: list | None = None, reviewed: bool | None = None,
                           bucket: str | None = None, batch: str | None = None,
                           date_from=None, date_to=None, limit: int = 50, offset: int = 0) -> dict:
    """`GET /distribution/{plant}` (§6 "Data", §7). Paged (default 50/page)
    list of a plant's `order_distribution` headers, each with its shares,
    derived statuses, and a children summary (count, total quantity,
    earliest start).

    `bucket` accepts `all`, one of the three §6 buckets (`needs_review`,
    `changed`, `problems`), or an individual status code directly (deep
    links); `None`/`''`/`'all'` means unfiltered.

    `meta.truncated` (D13) is True when the plant's SQL-filterable candidate
    header set exceeds `_LIST_CANDIDATE_CAP` -- `total`/bucket counts then
    reflect only the capped candidate set, not the plant's true header count.
    """
    with _pool.connection() as conn, conn.cursor() as cur:
        headers = _fetch_header_rows(
            cur, plant, search=search, workcenter=workcenter, reviewed=reviewed,
            batch=batch, date_from=date_from, date_to=date_to, machines=machines,
            limit_cap=_LIST_CANDIDATE_CAP + 1,
        )
        truncated = len(headers) > _LIST_CANDIDATE_CAP
        headers = headers[:_LIST_CANDIDATE_CAP]
        _hydrate_headers(cur, plant, headers)

    if bucket and bucket != "all":
        headers = [h for h in headers if status_matches_filter(h["statuses"], bucket)]

    total = len(headers)
    scheduled_children = sum(
        1 for h in headers for c in h.get("children", []) if c.get("scheduled_start") is not None
    )

    page = headers[offset:offset + limit] if limit else headers[offset:]
    data = [
        {
            "header": _header_wire_shape(h),
            "shares": h.get("shares", []),
            "statuses": sorted(h.get("statuses", set())),
            "children_summary": _children_summary(h.get("children", [])),
        }
        for h in page
    ]
    return {
        "data": data,
        "meta": {"total": total, "scheduled_children": scheduled_children, "truncated": truncated},
    }


def get_header_detail(plant: str, order: str, material: str) -> dict | None:
    """`GET /distribution/{plant}/{order}/{material}` (§7). One header's full
    detail: header, shares (each with `child_id`, the current child's live
    quantity/hours/start when it exists, and stale/purged/below-min-lot
    flags), derived statuses, and `base_version` (the header's xmin).
    Returns None when no such header exists (route maps this to 404).
    """
    with _pool.connection() as conn, conn.cursor() as cur:
        header = _fetch_header_by_key(cur, plant, order, material)
        if header is None:
            return None
        headers = [header]
        _hydrate_headers(cur, plant, headers)

    h = headers[0]
    children_by_machine = {c["machine"]: c for c in h.get("children", [])}
    current_members = set(h.get("machines", {}).keys())
    enriched_shares = []
    for s in h.get("shares", []):
        machine = s["machine"]
        child = children_by_machine.get(machine)
        enriched_shares.append({
            "machine": machine, "letter": s.get("letter"), "weight": s.get("weight"),
            "child_id": s.get("child_id"),
            "quantity": child.get("order_quantity") if child else None,
            "hours": child.get("run_time") if child else None,
            "start": (child.get("scheduled_start") or child.get("basic_start_date")) if child else None,
            "purged": s.get("purged_at") is not None,
            "stale": machine not in current_members,
            "below_min_lot": bool(child.get("below_min_lot")) if child else False,
        })
    return {
        "header": _header_wire_shape(h),
        "shares": enriched_shares,
        "statuses": sorted(h.get("statuses", set())),
        "base_version": h.get("base_version"),
    }


def get_summary(plant: str) -> dict:
    """`GET /distribution/{plant}/summary` (§7). `{needs_review, changed,
    problems}` counts over the plant's headers, classified by the SAME
    `classify_bucket_membership` this module's `list_headers_for_plant`
    `bucket` filter uses -- the two can't drift apart because they share
    this one function. `truncated` (D13) mirrors the list route's
    `meta.truncated`: True when the plant's candidate header set exceeds
    `_LIST_CANDIDATE_CAP`, so the counts above are then a lower bound."""
    with _pool.connection() as conn, conn.cursor() as cur:
        headers = _fetch_header_rows(cur, plant, limit_cap=_LIST_CANDIDATE_CAP + 1)
        truncated = len(headers) > _LIST_CANDIDATE_CAP
        headers = headers[:_LIST_CANDIDATE_CAP]
        _hydrate_headers(cur, plant, headers)

    counts = {"needs_review": 0, "changed": 0, "problems": 0}
    for h in headers:
        for bucket_name in classify_bucket_membership(h["statuses"]):
            counts[bucket_name] += 1
    counts["truncated"] = truncated
    return counts


def get_aggregate(plant: str, *, workcenter: str | None = None, date_from=None, date_to=None) -> list[dict]:
    """`GET /distribution/{plant}/aggregate` (§10.2). One row per header:
    `{production_order, material_number, machine, quantity, sum_child_quantity,
    start, finish, child_count, queued_children, all_scheduled,
    firming_indicator, reviewed, children}`.

    Built from `db._EFF_END_SQL` / `db._SCHEDULE_SEGMENTS_LATERAL_SQL` -- the
    SAME SQL fragments the `/tasks` read path uses for effective end
    considering segments -- and the matching effective-*start* expression
    `db.py` repeats inline in several places (`COALESCE(seg.first_start,
    scheduled_start, basic_start_date)`, gated by `planning_status <>
    'needs_planning'`), reused here verbatim rather than re-derived, so this
    roll-up can never silently drift from how the Gantt/task read path
    computes effective start/end.
    """
    where = ["hd.plant = %s"]
    params: list = [plant]
    if workcenter:
        where.append("hd.sap_workcenter = %s")
        params.append(workcenter)
    if date_from is not None:
        where.append("hd.basic_start_date >= %s")
        params.append(date_from)
    if date_to is not None:
        where.append("hd.basic_start_date <= %s")
        params.append(date_to)
    where_sql = " AND ".join(where)

    eff_start_sql = (
        "CASE WHEN o.planning_status = 'needs_planning' THEN NULL "
        "ELSE COALESCE(seg.first_start, o.scheduled_start, o.basic_start_date) END"
    )
    # Headers share the runtime/date names with orders. Qualify only bare
    # operands of the shared expression, preserving its fallback precedence.
    order_end_sql = re.sub(
        r"(?<![\w.])(scheduled_start|basic_start_date|run_time|scheduled_end|basic_finish_date)\b",
        r"o.\1", db._EFF_END_SQL,
    )
    eff_end_sql = (
        f"CASE WHEN o.planning_status = 'needs_planning' THEN NULL "
        f"ELSE COALESCE(seg.last_end, {order_end_sql}) END"
    )

    query = f"""
        SELECT hd.production_order, hd.material_number, hd.sap_workcenter,
               hd.order_quantity, hd.firming_indicator, hd.reviewed,
               o.production_order, o.machine, o.order_quantity, o.planning_status,
               {eff_start_sql}, {eff_end_sql}
          FROM order_distribution hd
          LEFT JOIN orders o
            ON o.plant = hd.plant AND o.parent_production_order = hd.production_order
           AND o.material_number = hd.material_number
          {db._SCHEDULE_SEGMENTS_LATERAL_SQL}
         WHERE {where_sql}
         ORDER BY hd.production_order, hd.material_number, o.machine
    """
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(query, params)
        rows = cur.fetchall()

    by_header: dict[tuple, dict] = {}
    order_keys: list[tuple] = []
    for (po, mat, wc, header_qty, firming, reviewed, child_po, child_machine, child_qty,
         planning_status, eff_start, eff_end) in rows:
        key = (po, mat)
        if key not in by_header:
            by_header[key] = {
                "production_order": po, "material_number": mat, "machine": wc,
                "quantity": float(header_qty) if header_qty is not None else None,
                "sum_child_quantity": Decimal(0),
                "start": None, "finish": None, "child_count": 0, "queued_children": 0,
                "firming_indicator": firming, "reviewed": reviewed, "children": [],
            }
            order_keys.append(key)
        agg = by_header[key]
        if child_po is not None:
            agg["child_count"] += 1
            if child_qty is not None:
                agg["sum_child_quantity"] += _dec(child_qty)
            if planning_status == "needs_planning":
                agg["queued_children"] += 1
            if eff_start is not None and (agg["start"] is None or eff_start < agg["start"]):
                agg["start"] = eff_start
            if eff_end is not None and (agg["finish"] is None or eff_end > agg["finish"]):
                agg["finish"] = eff_end
            agg["children"].append({
                "production_order": child_po, "machine": child_machine,
                "quantity": float(child_qty) if child_qty is not None else None,
                "start": eff_start, "end": eff_end,
            })

    result = []
    for key in order_keys:
        agg = by_header[key]
        agg["sum_child_quantity"] = float(agg["sum_child_quantity"])
        agg["all_scheduled"] = agg["child_count"] > 0 and agg["queued_children"] == 0
        result.append(agg)
    return result


def get_unresolved(plant: str) -> dict:
    """`GET /distribution/{plant}/unresolved` (§7). Plain orders
    (`parent_production_order IS NULL`) whose `machine` matches no current
    `machine` row in the plant -- a work-center code with no members, or a
    line the row never got resolved against. The analogue of
    `db.missing_master_data_for_plant` (`db.py:2209`)."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT o.machine, COUNT(*)
              FROM orders o
              LEFT JOIN machine m ON m.plant = o.plant AND m.machine = o.machine
             WHERE o.plant = %s
               AND o.parent_production_order IS NULL
               AND o.machine IS NOT NULL
               AND m.machine IS NULL
             GROUP BY o.machine
             ORDER BY o.machine
            """,
            (plant,),
        )
        rows = cur.fetchall()
    exceptions = [
        {"plant": plant, "machine": r[0], "order_count": r[1], "reason": "no_machine_row"}
        for r in rows
    ]
    return {
        "unmatched_pairs": len(exceptions),
        "unmatched_orders": sum(e["order_count"] for e in exceptions),
        "exceptions": exceptions,
    }


# =====================================================================
# P2-8/P2-9 -- planner re-weight/review/reset + admin reapply-defaults/resolve
# (aggregate_to_detail.md SS5.5-SS5.7, SS7's API table)
# =====================================================================
#
# The shared engine below (`_materialize_reweight`) is the ONE internal
# function `POST .../shares`, `POST .../reset`, and the `repair` scope of
# `POST .../resolve` all call to recompute a header's children from a
# {machine: weight} map and a {machine: letter} map against the header's
# STORED facts -- never a second, independently-maintained code path. A
# `dry_run` boolean threads straight through it: with `dry_run=True` the
# function stops before any write and returns the SS5.5 step 8 preview shape;
# with `dry_run=False` it performs the exact same computation and then writes
# it. This is what makes a dry run's preview and the following real write
# provably identical -- they share every line of materialization logic.
#
# `_build_child_rows`, `_apply_children`, `_delete_superseded_children`, and
# `_update_share_child_ids` (all defined above, for plan()/apply()) are
# reused VERBATIM here rather than re-implemented -- see each call site below.


class DistributionHeaderNotFound(Exception):
    """No `order_distribution` header at this (plant, production_order,
    material_number) -- routes.py maps this to 404."""


class DistributionStaleVersion(Exception):
    """409 'stale': the caller's base_version no longer matches the header's
    current xmin."""
    def __init__(self, base_version):
        self.base_version = base_version
        super().__init__("stale: base_version does not match the current header")


class DistributionChildrenScheduled(Exception):
    """409 'children_scheduled': removing these children would discard a
    planner's schedule (or their segments) without `confirm_remove_scheduled`.
    `children` is the SS5.5 step 5 list: [{id, production_order, machine,
    scheduled_start, frozen}, ...]."""
    def __init__(self, children: list[dict]):
        self.children = children
        super().__init__("children_scheduled: removal would discard scheduled sub-orders")


def _check_base_version(header: dict, base_version) -> None:
    """The identical equality check every planner-write call site runs before
    touching a header -- factored out so dry-run and real-write paths (and
    the bulk review/reset loops) all apply it the same way."""
    if base_version is not None and header["xmin"] != base_version:
        raise DistributionStaleVersion(header["xmin"])


def _load_one_header_shares(cur, plant: str, order: str, material: str) -> dict[str, dict]:
    """Every current share row for ONE header, keyed by machine -- the
    single-header analogue of `_load_existing_headers`'s batched shares
    query, used by the planner-write routes below (one header per call)."""
    cur.execute(
        """
        SELECT machine, letter, weight, child_id, purged_at
          FROM order_distribution_share
         WHERE plant = %s AND production_order = %s AND material_number = %s
        """,
        (plant, order, material),
    )
    return {
        r[0]: {"machine": r[0], "letter": r[1], "weight": r[2], "child_id": r[3], "purged_at": r[4]}
        for r in cur.fetchall()
    }


def _load_workcenter_for_plant(cur, plant: str, wc: str | None) -> dict | None:
    """One work center's policy + CURRENT members, scoped to a single known
    plant (unlike `_load_lookups`, which is deliberately unscoped for the
    ingest path where plant isn't known yet -- see that function's
    docstring). Returns None when `wc` is falsy or no longer exists."""
    if not wc:
        return None
    cur.execute(
        "SELECT distribution_mode, default_machine, review_required, distribute_tooled, max_separation"
        " FROM sap_workcenter WHERE plant = %s AND sap_workcenter = %s",
        (plant, wc),
    )
    row = cur.fetchone()
    if row is None:
        return None
    cur.execute(
        "SELECT machine, distribution_weight FROM machine WHERE plant = %s AND sap_workcenter = %s",
        (plant, wc),
    )
    pairs = cur.fetchall()
    return {
        "sap_workcenter": wc,
        "distribution_mode": row[0], "default_machine": row[1],
        "review_required": bool(row[2]), "distribute_tooled": bool(row[3]), "max_separation": row[4],
        "members": sorted(m for m, _w in pairs),
        "member_weights": dict(pairs),
    }


def _load_one_material_attrs(cur, plant: str, material: str) -> dict:
    cur.execute(
        "SELECT default_machine, prt_01, prt_02, min_lot_size, incremental_lot_size"
        " FROM material_plants WHERE plant = %s AND material_id = %s",
        (plant, material),
    )
    row = cur.fetchone()
    if row is None:
        return {}
    return {
        "default_machine": row[0], "prt_01": row[1], "prt_02": row[2],
        "min_lot_size": row[3], "incremental_lot_size": row[4],
    }


def _parent_facts_from_header(cur, plant: str, order: str, material: str, header: dict) -> dict:
    """Reconstruct a `_build_child_rows`-shaped `parent_facts` dict from a
    STORED header -- used by re-weight/reset/repair, none of which have a
    fresh ingest row to read facts from.

    `labor_hours`/`machine_hours` have no `order_distribution` column (only
    `order_quantity`/`run_time`/dates/`firming_indicator` do -- SS3's
    `_ADDITIVE_COLS` are apportioned per child at ingest time and never
    summed back onto the header). Deliberately re-derived here as the SUM of
    the header's CURRENT living children's own `labor_hours`/`machine_hours`,
    so a re-weight/reset/repair preserves the parent's total rather than
    silently losing it -- see backend/distribution/CLAUDE.md."""
    sap_facts = header.get("sap_facts") or {}
    facts = {k: sap_facts.get(k) for k in _SAP_FACTS_COPIED_KEYS}
    # D43: sum only the sub-orders a share actually points at -- never every
    # order carrying the parent link (orphans from a failed/raced upload would
    # inflate the total that then gets re-split).
    cur.execute(
        "SELECT SUM(o.labor_hours), SUM(o.machine_hours) FROM orders o"
        " WHERE o.id IN (SELECT s.child_id FROM order_distribution_share s"
        "                 WHERE s.plant = %s AND s.production_order = %s AND s.material_number = %s"
        "                   AND s.child_id IS NOT NULL)",
        (plant, order, material),
    )
    row = cur.fetchone()
    labor_hours, machine_hours = row if row else (None, None)
    facts.update({
        "basic_start_date": header.get("basic_start_date"),
        "basic_finish_date": header.get("basic_finish_date"),
        "order_quantity": header.get("order_quantity"),
        "run_time": header.get("run_time"),
        "firming_indicator": header.get("firming_indicator"),
        "labor_hours": labor_hours,
        "machine_hours": machine_hours,
    })
    return facts


def _reweight_letters(existing_shares: dict[str, dict], desired_machines: set[str]) -> dict[str, str]:
    """SS5.3 bullet 1 + SS5.7 "Membership": every existing share KEEPS its
    letter (including a now-zero-weight one -- letters stay reserved); a
    machine that doesn't have a share row yet gets the lowest unused letter,
    per SS5.7 ("A machine joining gets the lowest unused letter in an
    existing header the first time a planner gives it weight")."""
    letters = {m: s["letter"] for m, s in existing_shares.items() if s.get("letter")}
    used = set(letters.values())
    new_machines = sorted(m for m in desired_machines if m not in letters)
    idx = 0
    for machine in new_machines:
        while service._index_to_letter(idx) in used:
            idx += 1
        letter = service._index_to_letter(idx)
        letters[machine] = letter
        used.add(letter)
        idx += 1
    return letters


def _validate_share_payload(shares_input, existing_shares: dict[str, dict],
                            current_members: set[str], allow_stale: bool) -> dict[str, Decimal]:
    """SS5.5 step 1: validate one `{shares:[{machine, weight}], ...}` payload
    and return the {machine: weight} map it specifies (existing shares not
    mentioned are NOT included here -- the caller fills them in at 0, SS5.5
    "Removed children"). Raises ValueError with a `"<code>: <detail>"`
    message (routes.py's `_distribution_error` renders `code` structurally)
    for every 400 this step can produce; raises `DistributionChildrenScheduled`
    for nothing (that's a later step) and never raises for base_version (the
    caller checks that separately via `_check_base_version`, shared with the
    other planner-write routes)."""
    if not isinstance(shares_input, list) or not shares_input:
        raise ValueError("weights_empty: shares must be a non-empty list of {machine, weight}")
    desired: dict[str, Decimal] = {}
    total = Decimal(0)
    for entry in shares_input:
        if not isinstance(entry, dict):
            raise ValueError("each share entry must be an object with machine/weight")
        machine = entry.get("machine")
        if not isinstance(machine, str) or not machine.strip():
            raise ValueError("each share entry needs a non-blank machine")
        machine = machine.strip()
        # D22: a machine that is neither a current work-center member nor the
        # owner of an existing share is rejected outright -- at any weight
        # (including 0) and regardless of `allow_stale`, which only waives
        # staleness for a share that once existed. This never trips for a
        # current member with no share row yet (SS5.7's "joining" case).
        if machine not in existing_shares and machine not in current_members:
            raise ValueError(f"unknown_machine: {machine!r} is not a current work-center "
                             f"member or an existing share")
        if machine in desired:
            raise ValueError(f"duplicate_machine: {machine!r} appears more than once in shares")
        weight = entry.get("weight")
        if weight is None:
            weight_dec = Decimal(0)
        elif isinstance(weight, bool) or not isinstance(weight, (int, float, Decimal)):
            raise ValueError(f"weight for {machine!r} must be numeric or null")
        else:
            weight_dec = Decimal(str(weight))
        # D21: check finiteness/ceiling via a plain float BEFORE any Decimal
        # ordering comparison -- a NaN/Infinity Decimal raises
        # decimal.InvalidOperation on `<`/`>` rather than comparing cleanly.
        weight_float = float(weight_dec)
        if not math.isfinite(weight_float) or weight_float > _MAX_WEIGHT:
            raise ValueError(
                f"weight_invalid: weight for {machine!r} must be finite and <= {_MAX_WEIGHT:g}"
            )
        if weight_dec < 0:
            raise ValueError(f"weight for {machine!r} must be >= 0")
        if weight_dec > 0:
            existing = existing_shares.get(machine)
            if existing is not None and existing.get("purged_at") is not None:
                raise ValueError(
                    f"share_purged: {machine!r} is purged; an upload of the parent, Reset, "
                    f"or reapply-defaults revives it")
            is_current_member = machine in current_members
            has_existing_share = existing is not None
            # SS5.7: "A share is stale when its machine is not a current
            # member or no longer exists" -- an existing share whose machine
            # has since left the work center needs allow_stale to receive a
            # positive weight. A brand-new non-member is now rejected
            # unconditionally above (unknown_machine) before weight is even
            # considered. A CURRENT member with no share row yet (SS5.7's
            # "joining" case) needs neither -- that's the ordinary new-member
            # path, handled by `_reweight_letters` assigning it a fresh letter
            # below.
            if has_existing_share and not is_current_member and not allow_stale:
                raise ValueError(f"stale_machine: {machine!r} is no longer a current member "
                                 f"of the work center")
        desired[machine] = weight_dec
        total += weight_dec
    if total <= 0:
        raise ValueError("weights_empty: at least one share must carry a positive weight")
    return desired


def _compute_reweight_anchor(cur, plant: str, order: str, material: str, fallback) -> dict | None:
    """SS5.5 step 4: "New children: anchor = the earliest existing child's
    effective start, else basic_start_date." Shaped like
    `_load_anchor_sources`' per-id value so `_carry_anchor_onto_new_child`
    (reused verbatim) needs no change to consume it."""
    cur.execute(
        """
        SELECT MIN(COALESCE(seg.first_start, o.scheduled_start))
          FROM orders o
          LEFT JOIN LATERAL (
              SELECT MIN(s.scheduled_start) AS first_start
                FROM order_schedule_segments s WHERE s.order_id = o.id
          ) seg ON true
         WHERE o.plant = %s AND o.parent_production_order = %s AND o.material_number = %s
        """,
        (plant, order, material),
    )
    row = cur.fetchone()
    earliest = row[0] if row else None
    start = earliest if earliest is not None else fallback
    if start is None:
        return None
    return {"anchor": start, "notes": None, "planning_status": None, "planning_reason": None}


def _collapse_to_survivor(cur, old_child_id: str, new_child_id: str) -> None:
    """SS5.5 bullet 6, the N->1 collapse: when the surviving 100 % machine
    already had a living child, copy that child's `scheduled_*`, `notes`,
    `planning_status`/`planning_reason` and re-point its
    `order_schedule_segments` rows onto the NEW bare id BEFORE the old
    lettered child is deleted -- schedule-preserving collapse. Must run
    AFTER the new bare row has been upserted (so it exists as an UPDATE
    target) and BEFORE `_delete_superseded_children` removes `old_child_id`
    (segments cascade-delete on that removal otherwise)."""
    cur.execute(
        """
        UPDATE orders AS new_o
           SET scheduled_start = old_o.scheduled_start,
               scheduled_end   = old_o.scheduled_end,
               notes           = old_o.notes,
               planning_status = old_o.planning_status,
               planning_reason = old_o.planning_reason,
               production_version = old_o.production_version,
               prt_01          = old_o.prt_01,
               prt_02          = old_o.prt_02,
               -- D11: a partial share's hours must not land on the now-whole order,
               -- so run time travels only when a planner typed it.
               run_time        = CASE WHEN old_o.run_time_source = 'manual'
                                      THEN old_o.run_time ELSE new_o.run_time END,
               run_time_source = CASE WHEN old_o.run_time_source = 'manual'
                                      THEN old_o.run_time_source ELSE new_o.run_time_source END,
               run_time_basis  = CASE WHEN old_o.run_time_source = 'manual'
                                      THEN old_o.run_time_basis ELSE new_o.run_time_basis END,
               updated_at      = NOW()
          FROM orders AS old_o
         WHERE new_o.id = %s AND old_o.id = %s
        """,
        (new_child_id, old_child_id),
    )
    cur.execute(
        "UPDATE order_schedule_segments SET order_id = %s WHERE order_id = %s",
        (new_child_id, old_child_id),
    )


def _stamp_batch_children(conn, batch_id: str) -> None:
    """D11: give children written under `batch_id` the same machine_key and
    material_plants attributes (prt_01/prt_02/production_version/color) an
    ordinary upload stamps, so re-weight/reset/repair/resolve-created
    sub-orders are not unknown-setup (optimizer) or held (routing plants).
    Scoped to this batch's rows only; same transaction, no commit. Mirrors
    db.upsert_orders' machine_key backfill + `_stamp_order_attributes`."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE orders o
               SET machine_key = (
                   SELECT m.machine_key FROM machine m
                    WHERE m.plant = o.plant AND m.machine = o.machine
               )
             WHERE o.upload_batch_id = %s AND o.machine_key IS NULL AND o.plant IS NOT NULL
               AND (
                   SELECT COUNT(*) FROM machine m
                    WHERE m.plant = o.plant AND m.machine = o.machine
               ) = 1
            """,
            (batch_id,),
        )
    db._stamp_order_attributes(conn, batch_id=batch_id)


def _write_reweight_shares(cur, plant: str, order: str, material: str,
                          letters: dict[str, str], desired_weights: dict[str, Decimal]) -> None:
    """Upsert every share this materialization touches (every machine in
    `letters`), guarded so an unchanged letter/weight/purged-state is a
    no-op. `child_id` is still `_update_share_child_ids`'s job, not this
    function's -- but `purged_at` IS this function's job for the one case
    D02 (owner decision) assigns it: this clears a purged share's
    `purged_at` the moment it receives a positive weight again, in the same
    write that brings the weight back. D02: an upload of the parent, Reset,
    and reapply-defaults revive a purged share; Repair and re-weight never
    do -- `reweight_shares` can never reach this branch itself
    (`_validate_share_payload`'s `share_purged` check refuses a positive
    weight on an already-purged share before this runs), and
    `_repair_one_header` excludes purged shares from its desired weights
    entirely."""
    for machine, letter in letters.items():
        weight = desired_weights.get(machine, Decimal(0))
        cur.execute(
            """
            INSERT INTO order_distribution_share
                (plant, production_order, material_number, machine, letter, weight)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (plant, production_order, material_number, machine) DO UPDATE
                SET letter = EXCLUDED.letter, weight = EXCLUDED.weight,
                    purged_at = CASE WHEN EXCLUDED.weight > 0 THEN NULL
                                     ELSE order_distribution_share.purged_at END
            WHERE order_distribution_share.letter IS DISTINCT FROM EXCLUDED.letter
               OR order_distribution_share.weight IS DISTINCT FROM EXCLUDED.weight
               OR (EXCLUDED.weight > 0 AND order_distribution_share.purged_at IS NOT NULL)
            """,
            (plant, order, material, machine, letter, weight),
        )


def _write_reweight_header(cur, plant: str, order: str, material: str, *, source: str,
                          default_basis: str, reviewed: bool, reviewed_by, reviewed_at,
                          reviewed_quantity, actor: str) -> None:
    """Unconditional header UPDATE -- every planner-write call here is a
    deliberate, one-shot mutation (never an idempotent ingest re-run), so
    `updated_at`/`xmin` bump on every call, the same way
    `db.resync_order_attributes` bumps `orders.xmin` unconditionally for
    every row it touches (root CLAUDE.md's `_ADMIN_WRITE_OPERATIONS` note).
    A caller that wants a field left alone passes the header's own current
    value back in (see `_resolve_review_stamp`)."""
    cur.execute(
        """
        UPDATE order_distribution
           SET source = %s, default_basis = %s, reviewed = %s, reviewed_by = %s,
               reviewed_at = %s, reviewed_quantity = %s, updated_by = %s, updated_at = now()
         WHERE plant = %s AND production_order = %s AND material_number = %s
        """,
        (source, default_basis, reviewed, reviewed_by, reviewed_at, reviewed_quantity, actor,
         plant, order, material),
    )


def _resolve_review_stamp(header: dict, requested_reviewed, actor: str):
    """`reviewed?` in the SS5.5 body is optional -- when omitted (`None`),
    every reviewed-related column is passed back through unchanged; when
    given, it stamps `reviewed_by`/`reviewed_at`/`reviewed_quantity` from the
    caller's identity and the header's CURRENT `order_quantity`."""
    if requested_reviewed is None:
        return (header["reviewed"], header["reviewed_by"], header["reviewed_at"], header["reviewed_quantity"])
    reviewed = bool(requested_reviewed)
    reviewed_by = actor if reviewed else None
    reviewed_at = datetime.now(timezone.utc) if reviewed else None
    reviewed_quantity = header["order_quantity"] if reviewed else None
    return (reviewed, reviewed_by, reviewed_at, reviewed_quantity)


def _fetch_children_by_machine(cur, plant: str, order: str, material: str, *,
                               lock: bool = False) -> dict[str, dict]:
    """Every LIVE child currently materialized for one header, keyed by
    machine -- the "before" snapshot the dry-run preview and the
    scheduled-removal check both need.

    `lock=True` (D17, real writes only) takes `FOR UPDATE OF o` in id order, the
    same order a normal /tasks save locks in, so a re-weight cannot overwrite or
    delete a sub-order a planner is saving, and the two cannot deadlock. The
    dry-run preview stays lock-free (D56)."""
    cur.execute(
        f"""
        SELECT o.id, o.production_order, o.machine, o.order_quantity, o.run_time,
               o.scheduled_start, o.scheduled_end, o.notes, o.planning_status, o.planning_reason,
               EXISTS(SELECT 1 FROM order_schedule_segments s WHERE s.order_id = o.id) AS has_segments
          FROM orders o
         WHERE o.plant = %s AND o.parent_production_order = %s AND o.material_number = %s
         ORDER BY o.id
        {"FOR UPDATE OF o" if lock else ""}
        """,
        (plant, order, material),
    )
    out = {}
    for (oid, po, machine, qty, run_time, sched_start, sched_end, notes, plan_status,
         plan_reason, has_segments) in cur.fetchall():
        out[machine] = {
            "id": oid, "production_order": po, "order_quantity": qty, "run_time": run_time,
            "scheduled_start": sched_start, "scheduled_end": sched_end, "notes": notes,
            "planning_status": plan_status, "planning_reason": plan_reason,
            "has_segments": bool(has_segments),
        }
    return out


def _read_write_children(cur, child_ids) -> list[dict]:
    """Read complete child aggregates for Store hydration and subsequent saves.

    Reuse the scheduling projections so segmented, queued and legacy orders
    have the same effective dates and mismatch flags as /tasks/refresh.
    """
    if not child_ids:
        return []
    cur.execute(
        f"""
        SELECT o.id, o.production_order, o.machine, o.order_quantity, o.run_time,
               o.labor_hours, o.machine_hours, o.scheduled_start, o.scheduled_end,
               o.basic_start_date, o.basic_finish_date, o.notes,
               o.planning_status, o.planning_reason, o.distribution_letter, o.parent_production_order,
               o.xmin::text::bigint AS base_version,
               o.plant, o.material_number, o.material_description,
               o.prt_01, o.prt_02, o.production_version, o.firming_indicator, o.color, o.form_size,
               o.run_time_source, o.run_time_basis,
               CASE WHEN o.planning_status = 'needs_planning' THEN '[]'::jsonb
                    ELSE seg.schedule_segments END AS schedule_segments,
               {db._SCHEDULE_RUNTIME_MISMATCH_SQL} AS runtime_schedule_mismatch,
               CASE WHEN o.planning_status = 'needs_planning' THEN NULL
                    ELSE COALESCE(seg.first_start, o.scheduled_start, o.basic_start_date) END AS start_date,
               CASE WHEN o.planning_status = 'needs_planning' THEN NULL
                    ELSE COALESCE(seg.last_end, {db._EFF_END_WITH_RUNTIME_MISMATCH_SQL}) END AS end_date
          FROM orders o
          {db._SCHEDULE_SEGMENTS_LATERAL_SQL}
         WHERE o.id = ANY(%s)
         ORDER BY o.id
        """,
        (sorted(child_ids),),
    )
    columns = [column.name for column in cur.description]
    return [dict(zip(columns, row, strict=True)) for row in cur.fetchall()]


def _refresh_write_children(result: dict) -> None:
    """Replace the pre-resolve snapshot with the final committed task versions.

    One SELECT reads fields, segments and xmin from one MVCC snapshot. A
    later concurrent edit may stale that version, as with any task read,
    but the returned version never acknowledges fields from an older read.
    """
    ids = [child["id"] for child in result["children"]]
    with _pool.connection() as conn, conn.cursor() as cur:
        result["children"] = _read_write_children(cur, ids)
    result["versions"] = {child["id"]: child["base_version"] for child in result["children"]}


def _materialize_reweight(cur, plant: str, order: str, material: str, header: dict,
                          existing_shares: dict[str, dict], mat_attrs: dict,
                          desired_weights: dict[str, Decimal], letters: dict[str, str], *,
                          source: str, default_basis: str, reviewed, confirm_remove_scheduled: bool,
                          dry_run: bool, actor: str, audit_action: str) -> dict:
    """The ONE shared internal function behind `POST .../shares`, `POST
    .../reset`, and `resolve`'s `repair` scope. `dry_run` is the only branch:
    every line of materialization above it runs identically either way, so a
    dry run's `plan` can never disagree with what the following real call
    writes (SS5.5 step 8's parity requirement).

    `desired_weights`/`letters` are the CALLER's full target share set
    (already validated) -- this function only diffs it against what's
    currently on file and writes/previews the difference; it never validates
    payload shape (that's `_validate_share_payload`'s job) and never checks
    `base_version` (that's `_check_base_version`'s job, run by every caller
    before this).
    """
    parent_facts = _parent_facts_from_header(cur, plant, order, material, header)
    child_rows, child_ids_by_machine, _zero_qty = _build_child_rows(
        plant, order, material, parent_facts, desired_weights, letters, mat_attrs,
    )
    child_rows_by_machine = {c["machine"]: c for c in child_rows}

    previous_child_ids = {s["child_id"] for s in existing_shares.values() if s.get("child_id")}
    intended_child_ids = set(child_ids_by_machine.values())
    removed_ids = previous_child_ids - intended_child_ids

    # SS5.5 bullet 6: N->1 collapse detection. Only reachable when exactly
    # one machine ends up with a positive share AND that same machine
    # already carried a positive, living share BEFORE this call -- a
    # brand-new 100% share (no prior positive weight) uses the anchor
    # instead, per the bullet's own wording.
    collapse = None
    if len(child_ids_by_machine) == 1:
        (surv_machine, new_bare_id), = child_ids_by_machine.items()
        prev = existing_shares.get(surv_machine)
        if (prev and prev.get("child_id") and prev["child_id"] != new_bare_id
                and prev.get("weight") is not None and _dec(prev["weight"]) > 0):
            collapse = {"machine": surv_machine, "old_child_id": prev["child_id"], "new_child_id": new_bare_id}

    children_before = _fetch_children_by_machine(cur, plant, order, material, lock=not dry_run)
    _visibility_end, frozen_end = db._horizon_bounds_for_plant(cur, plant)

    removed_details = []
    for machine, before in children_before.items():
        if before["id"] not in removed_ids:
            continue
        if collapse and before["id"] == collapse["old_child_id"]:
            continue  # schedule survives via _collapse_to_survivor, not a destructive removal
        frozen = bool(before["scheduled_start"] and frozen_end and before["scheduled_start"] < frozen_end)
        removed_details.append({
            "id": before["id"], "production_order": before["production_order"], "machine": machine,
            "scheduled_start": before["scheduled_start"], "frozen": frozen,
        })
    scheduled_removed = [d for d in removed_details
                         if d["scheduled_start"] is not None
                         or children_before.get(d["machine"], {}).get("has_segments")]

    if not dry_run and scheduled_removed and not confirm_remove_scheduled:
        raise DistributionChildrenScheduled(scheduled_removed)

    min_lot_size = mat_attrs.get("min_lot_size")
    total_weight = sum(w for w in desired_weights.values() if w > 0) or Decimal(0)
    plan_entries = []
    for machine, letter in sorted(letters.items(), key=lambda kv: kv[1]):
        weight = desired_weights.get(machine, Decimal(0))
        before = children_before.get(machine)
        after = child_rows_by_machine.get(machine)
        qty_before = before["order_quantity"] if before else None
        hours_before = before["run_time"] if before else None
        qty_after = after["order_quantity"] if after else None
        hours_after = after["run_time"] if after else None
        if before is None and after is not None:
            outcome = "new"
        elif before is not None and after is None:
            outcome = "removed"
        elif before is not None and after is not None:
            # Cross-type compare (DB NUMERIC arrives as Decimal, _build_child_rows'
            # output is float) via a shared float() cast so a value that is
            # merely re-typed, not actually changed, never misclassifies as resized.
            qty_changed = (qty_before is None) != (qty_after is None) or (
                qty_before is not None and abs(float(qty_before) - float(qty_after)) > 1e-9)
            hours_changed = (hours_before is None) != (hours_after is None) or (
                hours_before is not None and abs(float(hours_before) - float(hours_after)) > 1e-9)
            outcome = "resized" if (qty_changed or hours_changed) else "unchanged"
        else:
            outcome = "unchanged"
        effective_pct = float(weight / total_weight * 100) if total_weight else 0.0
        scheduled = bool(before and (before["scheduled_start"] is not None or before["has_segments"]))
        frozen = bool(before and before["scheduled_start"] and frozen_end and before["scheduled_start"] < frozen_end)
        below_min_lot = bool(
            min_lot_size and min_lot_size > 0 and qty_after is not None
            and Decimal(0) < _dec(qty_after) < _dec(min_lot_size)
        )
        plan_entries.append({
            "machine": machine, "letter": letter, "weight": float(weight),
            "effective_pct": effective_pct, "qty_before": qty_before, "qty_after": qty_after,
            "hours_before": hours_before, "hours_after": hours_after, "outcome": outcome,
            "scheduled": scheduled, "frozen": frozen, "below_min_lot": below_min_lot,
        })

    if dry_run:
        return {
            "plan": plan_entries,
            "removed_scheduled": [
                {"id": d["id"], "production_order": d["production_order"], "machine": d["machine"],
                 "scheduled_start": d["scheduled_start"], "frozen": d["frozen"]}
                for d in scheduled_removed
            ],
            "base_version": header["xmin"],
        }

    # --- real write from here -------------------------------------------------
    anchor_skip_ids = {collapse["new_child_id"]} if collapse else set()
    real_new_ids = intended_child_ids - previous_child_ids - anchor_skip_ids
    anchor = _compute_reweight_anchor(cur, plant, order, material, header.get("basic_start_date")) \
        if real_new_ids else None

    # `orders.upload_batch_id` is a UUID column -- `audit_action` (a
    # human-readable admin_audit label, e.g. "reweight_shares") is NOT a
    # valid value for it, so a fresh uuid4 is minted here, purely for this
    # one write's child rows, distinct from the admin_audit `action` string.
    upload_batch_id = str(uuid.uuid4())
    parent_stub = {
        "plant": plant, "production_order": order, "material_number": material,
        "previous_child_ids": previous_child_ids | anchor_skip_ids,
        "anchor": anchor, "child_rows": child_rows, "batch_id": upload_batch_id,
        "letters": letters, "child_ids": child_ids_by_machine,
    }
    touched = _apply_children(cur, parent_stub)
    if collapse:
        _collapse_to_survivor(cur, collapse["old_child_id"], collapse["new_child_id"])
    superseded = previous_child_ids - intended_child_ids
    deleted = _delete_superseded_children(cur, superseded)
    _write_reweight_shares(cur, plant, order, material, letters, desired_weights)
    _update_share_child_ids(cur, parent_stub)
    _stamp_batch_children(cur.connection, upload_batch_id)

    reviewed_val, reviewed_by, reviewed_at, reviewed_quantity = _resolve_review_stamp(header, reviewed, actor)
    _write_reweight_header(
        cur, plant, order, material, source=source, default_basis=default_basis,
        reviewed=reviewed_val, reviewed_by=reviewed_by, reviewed_at=reviewed_at,
        reviewed_quantity=reviewed_quantity, actor=actor,
    )
    cur.execute(
        "SELECT xmin::text::bigint FROM order_distribution WHERE plant=%s AND production_order=%s AND material_number=%s",
        (plant, order, material),
    )
    new_xmin = cur.fetchone()[0]

    cur.execute(
        "INSERT INTO admin_audit (table_name, action, details, user_email) VALUES "
        "('order_distribution', %s, %s, %s)",
        (audit_action, Jsonb({
            "plant": plant, "production_order": order, "material_number": material,
            "source": source, "children_upserted": touched, "children_deleted": deleted,
            "collapse": collapse is not None,
        }), actor),
    )

    children_out = _read_write_children(cur, intended_child_ids)
    versions = {c["id"]: c["base_version"] for c in children_out}

    previous_shares_out = [
        {"machine": m, "letter": s.get("letter"), "weight": s.get("weight")}
        for m, s in existing_shares.items()
    ]

    return {
        "status": "ok",
        "children": children_out,
        "removed": sorted(superseded),
        "previous_shares": previous_shares_out,
        "versions": versions,
        "base_version": new_xmin,
    }


def _capture_setup_states_for_reweight(plant: str, actor: str, reason: str) -> None:
    """Snapshot machine setup states before a re-weight moves/deletes schedules
    (D17). Uses its own connection, so call it BEFORE taking any row lock,
    exactly as `apply()` does."""
    setup_data.capture_setup_states_before_schedule_mutation(
        actor=actor, reason=reason, plants=[plant])


def reweight_shares(plant: str, order: str, material: str, shares_input, base_version, *,
                    reviewed=None, allow_stale: bool = False, confirm_remove_scheduled: bool = False,
                    dry_run: bool = False, actor: str = "system") -> dict:
    """`POST /distribution/{plant}/{order}/{material}/shares` (SS5.5). Opens
    one connection, locks the header (and, implicitly, its shares/children
    through that same transaction) `FOR UPDATE` in the SAME single-header
    query shape `apply()`'s multi-header lock generalizes -- a concurrent
    `apply()` ingest run locks in `ORDER BY plant, production_order,
    material_number`, which a single-row lock trivially satisfies, so the two
    can never deadlock each other.

    For `dry_run=True`, `_lock_one_header` is called with `for_update=False`
    (D56) instead -- a dry run never writes anything (every line of
    `_materialize_reweight` above its `if dry_run: return ...` is pure
    computation), so there is no row lock to take in the first place. This
    is NOT about releasing a lock early: psycopg_pool's `connection()`
    context manager is `with conn: yield conn`, and `Connection.__exit__`
    COMMITS on a clean exit (it only rolls back when an exception
    propagates) -- so a dry run that took the lock would still hold it for
    the connection's full lifetime, same as a real write. Skipping the lock
    read entirely is what keeps a dry run from blocking a concurrent writer.
    """
    if not dry_run:
        _capture_setup_states_for_reweight(plant, actor, f"Distribution re-weight {order}/{material}")
    with _pool.connection() as conn, conn.cursor() as cur:
        header = _lock_one_header(cur, plant, order, material, for_update=not dry_run)
        if header is None:
            raise DistributionHeaderNotFound(f"no distribution header at {plant}/{order}/{material}")
        _check_base_version(header, base_version)

        workcenter = _load_workcenter_for_plant(cur, plant, header["sap_workcenter"])
        current_members = set(workcenter["members"]) if workcenter else set()
        existing_shares = _load_one_header_shares(cur, plant, order, material)
        mat_attrs = _load_one_material_attrs(cur, plant, material)

        input_weights = _validate_share_payload(shares_input, existing_shares, current_members, allow_stale)
        desired_weights = {m: Decimal(0) for m in existing_shares}
        desired_weights.update(input_weights)
        letters = _reweight_letters(existing_shares, set(desired_weights) | set(input_weights))

        result = _materialize_reweight(
            cur, plant, order, material, header, existing_shares, mat_attrs, desired_weights, letters,
            source="manual", default_basis=header["default_basis"], reviewed=reviewed,
            confirm_remove_scheduled=confirm_remove_scheduled, dry_run=dry_run, actor=actor,
            audit_action="reweight_shares",
        )
        if not dry_run:
            conn.commit()
    if not dry_run:
        # Recompute routing-sourced run_time for this plant's affected
        # sub-orders now that the re-weight has committed (ROUTING_RUNTIME_DESIGN.md
        # §4 item 4). Deferred import to avoid a cross-domain module-level
        # import cycle, matching this codebase's established convention
        # (e.g. backend/routing/routes.py, backend/master_data/routes.py).
        import backend.routing.resolver as routing_resolver
        routing_resolver.resolve_orders(plant)
        _refresh_write_children(result)
    return result


def reset_one_header(plant: str, order: str, material: str, base_version, *,
                     confirm_remove_scheduled: bool = False, dry_run: bool = False,
                     require_unreviewed: bool = False, actor: str = "system",
                     capture_states: bool = True) -> dict:
    """`POST /distribution/{plant}/reset`'s per-parent core (SS5.2's default
    precedence, `source = 'default'`) -- shares the SAME
    `_materialize_reweight` engine `reweight_shares` uses, just with the
    desired weights computed from `service.compute_default_shares` instead of
    a planner-typed payload. Raises the same `DistributionHeaderNotFound` /
    `DistributionStaleVersion` / `DistributionChildrenScheduled` /
    `ValueError` family; `reset_orders` (the bulk route entry point) catches
    them per item.

    `require_unreviewed=True` (D19) raises `ValueError("already_reviewed: ...")`
    under the lock when the header is already reviewed -- `reapply_defaults`
    passes this for both of its candidate paths (the `NOT reviewed` DB query
    AND an explicit `orders` list, which previously skipped that filter
    entirely) so a reviewed header is never silently re-defaulted by a bulk
    sweep; `reset_orders`' single/bulk reset route keeps the default
    (`False`) since an explicit Reset is allowed on a reviewed header.
    Raising here (inside the `with` block, under the lock) rolls the
    transaction back and releases the lock, same as any other guard above.

    D02 (owner decision): a purge retires a finished sub-order's share
    (`purged_at` set, `child_id` cleared, letter/weight left alone) rather
    than deleting it. An upload of the parent, Reset, and reapply-defaults
    revive a purged share; Repair and re-weight never do. Here, `default_shares`
    assigns the purged machine a fresh positive weight the same as any other
    current member, and `_write_reweight_shares` clears `purged_at` the
    moment that positive weight lands. Admin reapply-defaults shares this
    same core, so it revives purged shares identically. Repair
    (`_repair_one_header`) and a planner re-weight (`reweight_shares`) both
    deliberately leave a purged share purged.

    `capture_states=False` is for bulk callers that already captured setup
    states once for the whole sweep (D17)."""
    if not dry_run and capture_states:
        _capture_setup_states_for_reweight(plant, actor, f"Distribution reset {order}/{material}")
    with _pool.connection() as conn, conn.cursor() as cur:
        header = _lock_one_header(cur, plant, order, material, for_update=not dry_run)
        if header is None:
            raise DistributionHeaderNotFound(f"no distribution header at {plant}/{order}/{material}")
        _check_base_version(header, base_version)
        if require_unreviewed and header["reviewed"]:
            raise ValueError(
                f"already_reviewed: {plant!r}/{order!r}/{material!r} is already reviewed"
            )

        workcenter = _load_workcenter_for_plant(cur, plant, header["sap_workcenter"])
        if workcenter is None:
            raise ValueError(f"workcenter_missing: {header['sap_workcenter']!r} no longer exists in {plant!r}")
        existing_shares = _load_one_header_shares(cur, plant, order, material)
        mat_attrs = _load_one_material_attrs(cur, plant, material)

        member_pairs = [(m, workcenter["member_weights"].get(m)) for m in workcenter["members"]]
        default_shares, default_basis = service.compute_default_shares(mat_attrs, workcenter, member_pairs)
        if not any(w > 0 for w in default_shares.values()):
            # D03: same zero-weights policy as the ingest-side check in
            # _plan_core -- resetting to a default that is itself all-zero
            # would silently zero out every child; reapply_defaults already
            # counts a ValueError as skipped (not a hard failure).
            raise ValueError(
                f"weights_empty: default shares for {plant!r}/{order!r}/{material!r} are all zero")
        desired_weights = {m: Decimal(0) for m in existing_shares}
        desired_weights.update({m: _dec(w) for m, w in default_shares.items()})
        letters = _reweight_letters(existing_shares, set(workcenter["members"]))

        review_required = workcenter.get("review_required", True)
        reviewed_flag = not review_required

        result = _materialize_reweight(
            cur, plant, order, material, header, existing_shares, mat_attrs, desired_weights, letters,
            source="default", default_basis=default_basis, reviewed=reviewed_flag,
            confirm_remove_scheduled=confirm_remove_scheduled, dry_run=dry_run, actor=actor,
            audit_action="reset_shares",
        )
        if not dry_run:
            conn.commit()
    if not dry_run:
        # See reweight_shares' identical call -- same gap, same fix.
        import backend.routing.resolver as routing_resolver
        routing_resolver.resolve_orders(plant)
        _refresh_write_children(result)
    return result


def review_orders(plant: str, items: list[dict], reviewed: bool, actor: str = "system") -> dict:
    """`POST /distribution/{plant}/review` (SS5.5/SS7 table, SS5.7's "review
    acknowledges wc_changed implicitly"). Per-item: stamps
    `reviewed`/`reviewed_by`/`reviewed_at`/`reviewed_quantity` (=
    `order_quantity` at the moment of review) from the caller's identity.
    Does NOT clear `sap_facts.previous_workcenter` -- SS5.7 pins that only a
    re-weight or reset (an actual materialization) acknowledges `wc_changed`
    by clearing it; a plain review only stops the header showing as
    unreviewed. One partial-success pass over `items`: an individual stale/
    not-found item is recorded in its own result and does not abort the rest
    of the batch (each header is an independent row, locked and updated
    within the same transaction one at a time).

    D20 (lock order): every targeted header is locked up front, in ONE
    `unnest`-driven `FOR UPDATE` statement ordered `plant, production_order,
    material_number` -- the SAME key order `apply()`'s multi-header lock
    uses. Locking one at a time in REQUEST order (the previous shape) could
    deadlock against a concurrent `apply()` or another `review_orders` call
    that targets the same two headers in the opposite order. Per-item
    processing below is otherwise unchanged (still one UPDATE per item, in
    the caller's original order) and the response's per-item order still
    matches `items`."""
    results = []
    ok_count = 0
    with _pool.connection() as conn, conn.cursor() as cur:
        locked: dict[tuple[str, str], dict] = {}
        if items:
            orders_l = [item.get("production_order") for item in items]
            mats_l = [item.get("material_number") for item in items]
            cur.execute(
                """
                SELECT plant, production_order, material_number, sap_workcenter, order_quantity,
                       run_time, basic_start_date, basic_finish_date, firming_indicator, sap_facts,
                       source, default_basis, reviewed, reviewed_by, reviewed_at, reviewed_quantity,
                       updated_by, last_batch_id, xmin::text::bigint
                  FROM order_distribution
                 WHERE plant = %s AND (production_order, material_number)
                       IN (SELECT * FROM unnest(%s::text[], %s::text[]))
                 ORDER BY plant, production_order, material_number
                 FOR UPDATE
                """,
                (plant, orders_l, mats_l),
            )
            for r in cur.fetchall():
                locked[(r[1], r[2])] = {
                    "plant": r[0], "production_order": r[1], "material_number": r[2],
                    "sap_workcenter": r[3], "order_quantity": r[4], "run_time": r[5],
                    "basic_start_date": r[6], "basic_finish_date": r[7], "firming_indicator": r[8],
                    "sap_facts": r[9] or {}, "source": r[10], "default_basis": r[11],
                    "reviewed": r[12], "reviewed_by": r[13], "reviewed_at": r[14],
                    "reviewed_quantity": r[15], "updated_by": r[16], "last_batch_id": r[17],
                    "xmin": r[18],
                }

        for item in items:
            order = item.get("production_order")
            material = item.get("material_number")
            base_version = item.get("base_version")
            header = locked.get((order, material))
            if header is None:
                results.append({"production_order": order, "material_number": material, "status": "not_found"})
                continue
            try:
                _check_base_version(header, base_version)
            except DistributionStaleVersion as exc:
                results.append({"production_order": order, "material_number": material,
                                "status": "stale", "base_version": exc.base_version})
                continue
            cur.execute(
                """
                UPDATE order_distribution
                   SET reviewed = %s, reviewed_by = %s, reviewed_at = now(),
                       reviewed_quantity = order_quantity, updated_by = %s, updated_at = now()
                 WHERE plant = %s AND production_order = %s AND material_number = %s
                """,
                (bool(reviewed), actor, actor, plant, order, material),
            )
            cur.execute(
                "SELECT xmin::text::bigint FROM order_distribution"
                " WHERE plant=%s AND production_order=%s AND material_number=%s",
                (plant, order, material),
            )
            new_xmin = cur.fetchone()[0]
            results.append({"production_order": order, "material_number": material,
                            "status": "ok", "base_version": new_xmin})
            ok_count += 1
        if ok_count:
            cur.execute(
                "INSERT INTO admin_audit (table_name, action, details, user_email) VALUES "
                "('order_distribution', 'review', %s, %s)",
                (Jsonb({"plant": plant, "reviewed": bool(reviewed), "count": ok_count}), actor),
            )
        conn.commit()
    return {"results": results}


def _bulk_item_error_code(message: str) -> str | None:
    """Same `<code>: <detail>` partition rule as `routes._distribution_error`
    (code is the part before ':' when it's alphabetic after removing '_';
    else there's no structured code) -- applied here so a per-item bulk
    error carries a `code` the frontend can key UI copy off of, the same way
    the single-item `/shares` 400 path already does via `_distribution_error`.
    """
    code, sep, _rest = message.partition(":")
    if sep and code.strip().replace("_", "").isalpha():
        return code.strip()
    return None


def reset_orders(plant: str, items: list[dict], *, confirm_remove_scheduled: bool = False,
                 dry_run: bool = False, actor: str = "system") -> dict:
    """`POST /distribution/{plant}/reset`'s bulk entry point: one
    `reset_one_header` call per requested `{production_order, material_number,
    base_version}` item, each independently succeeding/failing (a
    `children_scheduled` guard on one parent never blocks the others in the
    same request)."""
    results = []
    if not dry_run:
        _capture_setup_states_for_reweight(plant, actor, "Distribution bulk reset")
    for item in items:
        order = item.get("production_order")
        material = item.get("material_number")
        base_version = item.get("base_version")
        try:
            result = reset_one_header(
                plant, order, material, base_version,
                confirm_remove_scheduled=confirm_remove_scheduled, dry_run=dry_run, actor=actor,
                capture_states=False,
            )
        except DistributionHeaderNotFound:
            results.append({"production_order": order, "material_number": material, "status": "not_found"})
            continue
        except DistributionStaleVersion as exc:
            results.append({"production_order": order, "material_number": material,
                            "status": "stale", "base_version": exc.base_version})
            continue
        except DistributionChildrenScheduled as exc:
            results.append({"production_order": order, "material_number": material,
                            "status": "children_scheduled", "children": exc.children})
            continue
        except ValueError as exc:
            message = str(exc)
            error_item = {"production_order": order, "material_number": material,
                         "status": "error", "message": message}
            code = _bulk_item_error_code(message)
            if code:
                error_item["code"] = code
            results.append(error_item)
            continue
        results.append({"production_order": order, "material_number": material,
                        "status": "ok", **result})
    return {"results": results}


def reapply_defaults(plant: str, *, workcenter: str | None = None, orders: list[dict] | None = None,
                     only_unreviewed: bool = True, confirm_remove_scheduled: bool = False,
                     actor: str = "system") -> dict:
    """`POST /distribution/{plant}/reapply-defaults` (admin). Bulk-applies
    SS5.2's default-share precedence to every matching header via the same
    `reset_one_header` core (no `base_version` gate here -- this is an
    explicit, admin-initiated bulk sweep, not a single planner's edit; every
    touched header's `xmin` bumps unconditionally per `_write_reweight_header`,
    the same "bump plant-wide" pattern `db.resync_order_attributes` uses).

    Candidates: `orders` (an explicit list of {production_order,
    material_number}) when given; else every header in `plant` (optionally
    filtered to `workcenter`) that is `NOT reviewed` when `only_unreviewed`
    (the default and, per SS7, the only mode this route documents), or every
    matching header when `only_unreviewed` is explicitly False.

    D19: the DB-query candidate path already filters to `NOT reviewed` when
    `only_unreviewed`, but an explicit `orders` list bypassed that filter
    entirely -- `reset_one_header`'s own `require_unreviewed` guard now
    covers BOTH paths uniformly (whichever path built `keys`, every key is
    passed through the SAME `reset_one_header` call below), so an already-
    reviewed header named in an explicit `orders` list is skipped (its
    `ValueError("already_reviewed: ...")` is caught by the generic
    `except ValueError` below, same as any other skip) instead of silently
    re-defaulted."""
    _capture_setup_states_for_reweight(plant, actor, "Distribution reapply defaults")
    with _pool.connection() as conn, conn.cursor() as cur:
        if orders:
            keys = [(o.get("production_order"), o.get("material_number")) for o in orders]
        else:
            where = ["plant = %s"]
            params: list = [plant]
            if workcenter:
                where.append("sap_workcenter = %s")
                params.append(workcenter)
            if only_unreviewed:
                where.append("reviewed = FALSE")
            cur.execute(
                f"SELECT production_order, material_number FROM order_distribution WHERE {' AND '.join(where)}",
                params,
            )
            keys = [(r[0], r[1]) for r in cur.fetchall()]

    counters = {"headers_processed": 0, "children_upserted": 0, "children_deleted": 0,
               "skipped": 0, "children_scheduled": 0}
    for order, material in keys:
        try:
            result = reset_one_header(
                plant, order, material, base_version=None,
                confirm_remove_scheduled=confirm_remove_scheduled, dry_run=False,
                require_unreviewed=bool(only_unreviewed), actor=actor, capture_states=False,
            )
        except DistributionHeaderNotFound:
            counters["skipped"] += 1
            continue
        except DistributionChildrenScheduled:
            counters["children_scheduled"] += 1
            continue
        except ValueError:
            counters["skipped"] += 1
            continue
        counters["headers_processed"] += 1
        counters["children_upserted"] += len(result.get("children", []))
        counters["children_deleted"] += len(result.get("removed", []))
    return counters


def _insert_admin_audit(cur, table: str, action: str, details: dict, actor: str) -> None:
    """D55: the one-line `admin_audit` insert pattern `save_workcenter` uses
    inline, factored out for the two `resolve` scopes below -- `_resolve_wc_codes`
    and `_resolve_machines` each write real rows (new headers, rewritten
    `orders.machine`/`parent_production_order`) but previously left no
    `admin_audit` trail at all. Call this on the SAME cursor/transaction as
    the writes it's auditing, before whichever branch commits, so the audit
    row lands in the SAME commit as the writes it describes -- never used
    for `repair` (that scope's writes already go through
    `_materialize_reweight`, which audits itself)."""
    cur.execute(
        "INSERT INTO admin_audit (table_name, action, details, user_email) VALUES (%s, %s, %s, %s)",
        (table, action, Jsonb(details), actor),
    )


def _resolve_wc_codes(plant: str, actor: str, dry_run: bool) -> dict:
    """`resolve` scope `wc_codes` (SS5.6 bullet 1): plain orders whose
    `machine` equals a `sap_workcenter` code get run through the SAME
    `plan()`/`apply()` ingest machinery a fresh upload would use -- this
    function builds one synthetic ingest row per candidate plain order (from
    the row's OWN current column values) and feeds it through `plan()`/
    `apply()` unchanged, rather than re-implementing SS5.1-SS5.4's
    resolve/classify/materialize logic a second time."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT o.id, o.production_order, o.material_number, o.material_description, o.machine,
                   o.basic_start_date, o.basic_finish_date, o.run_time, o.color, o.order_quantity,
                   o.form_size, o.firming_indicator, o.planned_order_initial_quantity, o.reduced_quantity,
                   o.order_category, o.order_type, o.bom_alternative, o.bom_usage, o.labor_hours,
                   o.machine_hours, o.no_of_fte
              FROM orders o
             WHERE o.plant = %s AND o.parent_production_order IS NULL
               AND o.machine IN (SELECT sap_workcenter FROM sap_workcenter WHERE plant = %s)
            """,
            (plant, plant),
        )
        candidates = cur.fetchall()
        if not candidates:
            return {"headers_created": 0, "children_upserted": 0, "single_rewrites": 0,
                    "repaired": 0, "skipped": 0}

        rows = [
            {
                "production_order": r[1], "material_number": r[2], "material_description": r[3],
                "machine": r[4], "plant": plant, "basic_start_date": r[5], "basic_finish_date": r[6],
                "run_time": r[7], "color": r[8], "order_quantity": r[9], "form_size": r[10],
                "firming_indicator": r[11], "planned_order_initial_quantity": r[12],
                "reduced_quantity": r[13], "order_category": r[14], "order_type": r[15],
                "bom_alternative": r[16], "bom_usage": r[17], "labor_hours": r[18],
                "machine_hours": r[19], "no_of_fte": r[20],
            }
            for r in candidates
        ]
        ids_by_key = {(r[1], r[2]): r[0] for r in candidates}

        batch_id = str(uuid.uuid4())
        rows_out, plan_structure, warnings = plan(rows, batch_id, conn=conn)
        single_rewrites = int(warnings.get("single_rewrites", 0))
        distributed_keys = set(plan_structure.get("parents", {}).keys())
        skipped = len(candidates) - single_rewrites - len(distributed_keys)

        if dry_run:
            return {"headers_created": len(distributed_keys), "children_upserted": 0,
                    "single_rewrites": single_rewrites, "repaired": 0, "skipped": max(skipped, 0)}

        # Single-mode rewrites: rows_out carries the caller's normal upsert
        # shape, but this scope isn't going through db.upsert_orders' chunked
        # path -- apply the machine rewrite directly, guarded the same way
        # aggregate_to_detail.md SS5.6 calls for.
        for row in rows_out:
            key = (row.get("production_order"), row.get("material_number"))
            oid = ids_by_key.get(key)
            if oid is None or key in distributed_keys:
                continue
            cur.execute(
                "UPDATE orders SET machine = %s, updated_at = NOW() WHERE id = %s AND machine IS DISTINCT FROM %s",
                (row.get("machine"), oid, row.get("machine")),
            )

        # D55: one admin_audit row per `resolve` call, written on THIS cursor
        # before either commit branch below -- `apply()` commits internally
        # on the first branch, so the row must already be part of that same
        # transaction to land at all.
        _insert_admin_audit(
            cur, "order_distribution", "resolve_wc_codes",
            {"plant": plant, "candidates": len(candidates), "single_rewrites": single_rewrites,
             "headers_created": len(distributed_keys), "skipped": max(skipped, 0)},
            actor,
        )

        apply_result = {"headers_created": 0, "children_upserted": 0}
        if plan_structure.get("parents"):
            apply_result = apply(plan_structure, batch_id, conn, actor=actor)
            _stamp_batch_children(conn, batch_id)
            conn.commit()
        else:
            conn.commit()

    return {
        "headers_created": apply_result.get("headers_created", 0),
        "children_upserted": apply_result.get("children_upserted", 0),
        "single_rewrites": single_rewrites,
        "repaired": 0,
        "skipped": max(skipped, 0),
    }


def _resolve_machines(plant: str, workcenter: str, actor: str, dry_run: bool) -> dict:
    """`resolve` scope `machines` (SS5.6 bullet 2, opt-in): a plain order
    already sitting on one of `workcenter`'s CURRENT member machines gets a
    brand-new header with 100 % weight on its current machine -- schedule
    PRESERVED, since the plain order's bare id IS the winning share's child
    id already (a 100 % share never gets a letter prefix, SS5.3), so nothing
    about the `orders` row itself needs to move; it only gains
    `parent_production_order`/`distribution_letter` so the read paths
    recognize it as a distributed child from now on."""
    with _pool.connection() as conn, conn.cursor() as cur:
        workcenter_row = _load_workcenter_for_plant(cur, plant, workcenter)
        if workcenter_row is None or not workcenter_row["members"]:
            return {"headers_created": 0, "children_upserted": 0, "single_rewrites": 0,
                    "repaired": 0, "skipped": 0}
        members = workcenter_row["members"]
        cur.execute(
            """
            SELECT o.id, o.production_order, o.material_number, o.machine, o.order_quantity, o.run_time,
                   o.basic_start_date, o.basic_finish_date, o.firming_indicator
              FROM orders o
              LEFT JOIN order_distribution od
                ON od.plant = o.plant AND od.production_order = o.production_order
               AND od.material_number = o.material_number
             WHERE o.plant = %s AND o.parent_production_order IS NULL
               AND o.machine = ANY(%s) AND od.production_order IS NULL
            """,
            (plant, members),
        )
        candidates = cur.fetchall()
        if not candidates:
            return {"headers_created": 0, "children_upserted": 0, "single_rewrites": 0,
                    "repaired": 0, "skipped": 0}

        if dry_run:
            return {"headers_created": len(candidates), "children_upserted": 0,
                    "single_rewrites": 0, "repaired": 0, "skipped": 0}

        letters = service.assign_letters(sorted(members))
        resolve_batch_id = str(uuid.uuid4())  # order_distribution.last_batch_id is UUID-typed
        headers_created = 0
        for oid, order, material, machine, qty, run_time, bs, bf, firming in candidates:
            shares = {m: (Decimal(100) if m == machine else Decimal(0)) for m in members}
            parent = {
                "plant": plant, "production_order": order, "material_number": material,
                "sap_workcenter": workcenter, "parent_facts": {
                    "order_quantity": qty, "run_time": run_time, "basic_start_date": bs,
                    "basic_finish_date": bf, "firming_indicator": firming,
                },
                "default_basis": "workcenter_weights", "is_new_header": True, "letters": letters,
                "shares": shares, "runtime_defaulted": False,
            }
            inserted = _insert_new_header(cur, parent, batch_id=resolve_batch_id)
            if not inserted:
                continue
            cur.execute(
                "UPDATE order_distribution SET source = 'manual', reviewed = FALSE"
                " WHERE plant = %s AND production_order = %s AND material_number = %s",
                (plant, order, material),
            )
            _write_shares(cur, parent)
            cur.execute(
                "UPDATE order_distribution_share SET child_id = %s"
                " WHERE plant = %s AND production_order = %s AND material_number = %s AND machine = %s",
                (oid, plant, order, material, machine),
            )
            cur.execute(
                "UPDATE orders SET parent_production_order = %s, distribution_letter = NULL,"
                " updated_at = NOW() WHERE id = %s",
                (order, oid),
            )
            headers_created += 1
        # D55: one admin_audit row per `resolve` call -- same cursor/
        # transaction as the writes above, before the commit.
        _insert_admin_audit(
            cur, "order_distribution", "resolve_machines",
            {"plant": plant, "workcenter": workcenter, "candidates": len(candidates),
             "headers_created": headers_created, "skipped": len(candidates) - headers_created},
            actor,
        )
        conn.commit()
    return {"headers_created": headers_created, "children_upserted": headers_created,
            "single_rewrites": 0, "repaired": 0, "skipped": len(candidates) - headers_created}


def _repair_one_header(cur, plant: str, order: str, material: str, header: dict) -> dict:
    """`resolve` scope `repair`'s per-header core (SS5.6 bullet 3 / SS5's
    crash-window recovery): re-materialize from the header's CURRENT,
    non-purged shares and facts -- explicitly excluding purged shares from
    both weights and letters, so a purged share's child is NEVER recreated
    (SS5.7's guarantee, which the more general `_replan_from_current_header`
    used by `apply()`'s own re-check branch does not enforce, since that
    branch never needs to -- ingest's `_write_shares` for an existing header
    only revives `purged_at`, it never assigns a fresh positive weight to a
    just-revived share)."""
    all_shares = _load_one_header_shares(cur, plant, order, material)
    live_shares = {m: s for m, s in all_shares.items() if s.get("purged_at") is None}
    desired_weights = {m: _dec(s.get("weight")) for m, s in live_shares.items()}
    letters = {m: s["letter"] for m, s in live_shares.items()}
    mat_attrs = _load_one_material_attrs(cur, plant, material)

    result = _materialize_reweight(
        cur, plant, order, material, header, all_shares, mat_attrs, desired_weights, letters,
        source=header["source"], default_basis=header["default_basis"], reviewed=None,
        confirm_remove_scheduled=True, dry_run=False, actor="system", audit_action="resolve_repair",
    )
    return {"children_upserted": len(result.get("children", [])), "children_deleted": len(result.get("removed", []))}


def _resolve_repair(plant: str, dry_run: bool) -> dict:
    """`resolve` scope `repair`: every header currently classified
    `incomplete` (SS5.7) gets re-materialized via `_repair_one_header`."""
    with _pool.connection() as conn, conn.cursor() as cur:
        headers = _fetch_header_rows(cur, plant)
        _hydrate_headers(cur, plant, headers)
        incomplete = [h for h in headers if "incomplete" in h.get("statuses", set())]

        if dry_run:
            return {"headers_created": 0, "children_upserted": 0, "single_rewrites": 0,
                    "repaired": len(incomplete), "skipped": 0}

        repaired = 0
        children_upserted = 0
        if incomplete:
            # Own connection: must run before this loop takes its row locks,
            # but the header lock below is per-iteration so capture first.
            _capture_setup_states_for_reweight(plant, "system", "Distribution resolve repair")
        for h in incomplete:
            po, mat = h["production_order"], h["material_number"]
            current = _lock_one_header(cur, plant, po, mat)
            if current is None:
                continue
            result = _repair_one_header(cur, plant, po, mat, current)
            children_upserted += result["children_upserted"]
            repaired += 1
        conn.commit()
    # Reached only on the real (non-dry-run) path -- the dry_run branch
    # above returns before any commit. See reweight_shares' identical call.
    import backend.routing.resolver as routing_resolver
    routing_resolver.resolve_orders(plant)
    return {"headers_created": 0, "children_upserted": children_upserted, "single_rewrites": 0,
            "repaired": repaired, "skipped": len(incomplete) - repaired}


def resolve(plant: str, scope: str, *, workcenter: str | None = None, dry_run: bool = False,
           actor: str = "system") -> dict:
    """`POST /distribution/{plant}/resolve` (admin, SS5.6). Dispatches to one
    of the three scope-specific helpers above; every scope shares the
    `{headers_created, children_upserted, single_rewrites, repaired, skipped}`
    response shape (a scope simply leaves the fields it doesn't touch at 0)."""
    if scope == "wc_codes":
        return _resolve_wc_codes(plant, actor, dry_run)
    if scope == "machines":
        if not workcenter:
            raise ValueError("workcenter is required for the 'machines' resolve scope")
        return _resolve_machines(plant, workcenter, actor, dry_run)
    if scope == "repair":
        return _resolve_repair(plant, dry_run)
    raise ValueError("scope must be one of 'wc_codes', 'machines', 'repair'")
