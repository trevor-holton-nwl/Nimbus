"""
NIMBUS 2.0 — Order Distribution domain: SAP aggregate work center policy and
per-machine distribution weights.

P1 (this file): a single validated write path backs
`PUT /distribution/{plant}/workcenters/{wc}` -- create-or-replace of one
plant's `sap_workcenter` policy row plus its member machines'
`machine.distribution_weight`, in one transaction with an `admin_audit` row.
Later phases add `order_distribution` header/share persistence, ingest,
roll-up, and the Distribution tab's own read routes (aggregate_to_detail.md
§7 at the repo root is the full API table this domain grows into).

Plain psycopg-style functions over the shared pool (`db._pool`), mirroring
`backend/setup/data.py`'s convention -- no ORM, every value goes through a
parameter placeholder.

No optimistic-concurrency token on this route. aggregate_to_detail.md §3.4
pins the `xmin`/`base_version` 409-stale token to the `order_distribution`
HEADER table (P2+, one row per SAP parent order), not to this `sap_workcenter`
POLICY row (one row per work center, edited rarely, by admins only). This is
a plain last-write-wins transaction, the same shape as master_data.py's other
narrow single-purpose admin writers (e.g. `set_setup_line_compatibility`,
`set_plant_setup_active`) -- none of which carry a version token either.
"""
from psycopg.types.json import Jsonb

from db import _pool

VALID_DISTRIBUTION_MODES = frozenset({"single", "distribute"})
VALID_MAX_SEPARATIONS = frozenset({"none", "hour", "day", "week"})


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
        if weight < 0:
            raise ValueError(f"weight for {machine_name!r} must be >= 0")
        cleaned[machine_name] = float(weight)
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
