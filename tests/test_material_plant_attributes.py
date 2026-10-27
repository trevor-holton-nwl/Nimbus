"""
Pure-logic + route-topology tests for the Master Data > Material / Material
Plant grids (material_grid / material_plant_grid / set_material_plant_attributes
in master_data.py; the three new /master-data/* routes in brain.py). No
database required — these run unconditionally, including when .env points at
the live Azure DB (which makes the @pytest.mark.pg suite refuse to collect).

Background: the grids are plant-scoped through a semi-join (materials that
have a material_plants row for the selected plant), and prt_01/prt_02/color
are writable through a deliberately non-admin-gated endpoint with a hard
server-side column allowlist. These tests pin the security-relevant
invariants: the allowlist's exact contents, that `materials` was NOT added to
PLANT_SCOPED_TABLES (which would silently no-op the scope check instead of
enforcing it), the route registration order that keeps the two new GET routes
reachable, and that the write route can never be captured by the generic
`/master-data/{table}` path regardless of registration order.
"""
import master_data as md
import brain
from fastapi.routing import iter_route_contexts
from starlette.routing import compile_path


def test_editable_material_plant_attrs_is_exactly_the_four_planner_fields():
    """This is a security boundary, not a convenience list — widening it is a
    deliberate act. If this test needs to change, the change itself is the
    thing that should get scrutiny."""
    assert frozenset({"prt_01", "prt_02", "color", "default_machine"}) == md.EDITABLE_MATERIAL_PLANT_ATTRS


def test_editable_material_plant_attrs_excludes_key_and_sap_owned_columns():
    assert md._KEY_COLUMNS["material_plants"].isdisjoint(md.EDITABLE_MATERIAL_PLANT_ATTRS)
    for col in ("status_pl", "min_lot_size", "incremental_lot_size", "default_production_version", "subnetwork"):
        assert col not in md.EDITABLE_MATERIAL_PLANT_ATTRS


def test_materials_was_not_added_to_plant_scoped_tables():
    """`materials` has no physical plant column, so adding it here would make
    list_rows's `"plant" in col_names` guard silently no-op the scope check —
    worse than no check at all, because it looks enforced. The plant-scoped
    Material grid closes this gap itself via _assert_plant_allowed instead."""
    assert "materials" not in md.PLANT_SCOPED_TABLES
    assert frozenset({"plants", "machine", "material_plants", "bom_items", "sap_workcenter",
                      "production_version", "routing_operation", "routing_rules",
                      "tool_inventory"}) == md.PLANT_SCOPED_TABLES


def test_plant_not_allowed_is_a_permission_error_not_a_value_error():
    """Must NOT subclass ValueError — brain.py's route handlers catch
    ValueError -> 400 before md.PlantNotAllowed -> 403; if PlantNotAllowed
    were a ValueError, a scope violation would silently downgrade to a 400."""
    assert issubclass(md.PlantNotAllowed, PermissionError)
    assert not issubclass(md.PlantNotAllowed, ValueError)


def test_assert_plant_allowed_rejects_empty_plant():
    try:
        md._assert_plant_allowed("", None)
        raise AssertionError("expected ValueError for an empty plant")
    except ValueError:
        pass
    try:
        md._assert_plant_allowed("   ", None)
        raise AssertionError("expected ValueError for a whitespace-only plant")
    except ValueError:
        pass


def test_assert_plant_allowed_scopes_to_role_plants():
    # None = unrestricted (the auth.get_allowed_plants "unscoped role" default).
    md._assert_plant_allowed("5512", None)
    md._assert_plant_allowed("5512", ["5512", "1006"])
    try:
        md._assert_plant_allowed("5512", ["1006"])
        raise AssertionError("expected PlantNotAllowed for an out-of-scope plant")
    except md.PlantNotAllowed:
        pass


def test_set_material_plant_attributes_rejects_disallowed_columns_before_any_db_work():
    """Phase-1 allowlist rejection must fire before _pool.connection() is ever
    touched — a disallowed column must never reach the database, and the
    error must name the rejected column(s) so a silent drop is impossible."""
    try:
        md.set_material_plant_attributes(
            "5512", [{"material_id": "X", "status_pl": "99"}], allowed_plants=None, user_email=None,
        )
        raise AssertionError("expected ValueError for a disallowed column")
    except ValueError as e:
        assert "status_pl" in str(e)


def test_set_material_plant_attributes_rejects_plant_inside_a_row():
    """plant is specified once at the top level; a per-row plant would make a
    cross-plant write structurally possible and must be rejected, not ignored."""
    try:
        md.set_material_plant_attributes(
            "5512", [{"material_id": "X", "plant": "1006", "color": "RED"}], allowed_plants=None, user_email=None,
        )
        raise AssertionError("expected ValueError for a per-row plant key")
    except ValueError:
        pass


def test_set_material_plant_attributes_rejects_missing_material_id():
    try:
        md.set_material_plant_attributes(
            "5512", [{"color": "RED"}], allowed_plants=None, user_email=None,
        )
        raise AssertionError("expected ValueError for a missing material_id")
    except ValueError:
        pass


def test_set_material_plant_attributes_scopes_before_normalizing():
    try:
        md.set_material_plant_attributes(
            "5512", [{"material_id": "X", "color": "RED"}], allowed_plants=["1006"], user_email=None,
        )
        raise AssertionError("expected PlantNotAllowed for an out-of-scope plant")
    except md.PlantNotAllowed:
        pass


def test_max_attribute_updates_ceiling_rejects_oversized_batches():
    updates = [{"material_id": str(i), "color": "RED"} for i in range(md.MAX_ATTRIBUTE_UPDATES + 1)]
    try:
        md.set_material_plant_attributes("5512", updates, allowed_plants=None, user_email=None)
        raise AssertionError("expected ValueError for a too-large batch")
    except ValueError as e:
        assert "Too many updates" in str(e)


def _master_data_paths():
    # P5 note: brain.api.routes now holds one _IncludedRouter per domain
    # router — iter_route_contexts() walks those to yield the real per-path
    # route contexts (same helper app.openapi() uses internally), preserving
    # registration order both within and across the included routers.
    return [getattr(r, "path", None) for r in iter_route_contexts(brain.api.routes)
            if (getattr(r, "path", "") or "").startswith("/master-data")]


def test_material_grid_routes_are_registered_before_the_table_catchall():
    """FastAPI/Starlette matches routes in REGISTRATION order, not by
    specificity — a single-segment literal registered after `{table}` is
    permanently shadowed (this is exactly what happened to a former sibling,
    `_audit`, once — since removed entirely as confirmed dead, 2026-09)."""
    paths = _master_data_paths()
    i_table = paths.index("/master-data/{table}")
    for literal in ("/master-data/_schema-export",
                    "/master-data/_material-grid", "/master-data/_material-plant-grid"):
        assert paths.index(literal) < i_table, f"{literal} is registered after {{table}} and is shadowed"


def test_material_plant_attributes_route_exists_and_cannot_be_captured_by_table_catchall():
    """The write route is a TWO-segment path. The default `str` path converter
    behind {table} excludes "/", so {table} can only ever capture one path
    segment — this route is unreachable by it at ANY registration order. This
    pins the reasoning, not just the current position, so a future refactor
    that changes registration order can't silently break it."""
    assert "/master-data/material-plants/attributes" in _master_data_paths()
    regex, _, _ = compile_path("/master-data/{table}")
    assert regex.match("/master-data/material-plants/attributes") is None


def test_material_plant_attributes_write_operation_is_audit_logged():
    """Without an _ADMIN_WRITE_OPERATIONS entry, the request-id middleware's
    _admin_route_details() returns operation=None and the structured operator
    log silently drops this write entirely."""
    assert brain._ADMIN_WRITE_OPERATIONS.get("/master-data/material-plants/attributes") == \
        "material_plants.attributes_update"


def test_new_master_data_routes_are_not_admin_gated():
    """Locked product decision: planners (not just admins) must be able to use
    these grids. A `require_admin` dependency creeping onto any of the three
    new routes would silently lock non-admin planners out."""
    by_path = {}
    for r in iter_route_contexts(brain.api.routes):
        p = getattr(r, "path", None)
        if p in ("/master-data/_material-grid", "/master-data/_material-plant-grid",
                 "/master-data/material-plants/attributes"):
            by_path[p] = r
    assert set(by_path) == {
        "/master-data/_material-grid", "/master-data/_material-plant-grid",
        "/master-data/material-plants/attributes",
    }
    for path, route in by_path.items():
        dep_names = {dep.call.__name__ for dep in route.dependant.dependencies}
        assert "require_admin" not in dep_names, f"{path} must not be require_admin-gated"
