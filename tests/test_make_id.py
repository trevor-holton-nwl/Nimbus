"""
Pure-logic tests for db.make_id — no database required, run unconditionally.

These pin the task-id contract the whole frontend relies on (stable MD5 of
PRODUCTION_ORDER|MATERIAL_NUMBER), AND document the #202 plant-blindness root
cause as a regression guard.
"""
import db


def test_make_id_is_deterministic():
    assert db.make_id("1000261702", "MAT1") == db.make_id("1000261702", "MAT1")


def test_make_id_strips_excel_float_suffix():
    # _str_id normalizes '1000261702.0' -> '1000261702' so an Excel-float order
    # number produces the same id as its integer form (stable across re-uploads).
    assert db.make_id("1000261702.0", "MAT1") == db.make_id("1000261702", "MAT1")


def test_make_id_order_and_material_are_distinct_positions():
    assert db.make_id("A", "B") != db.make_id("B", "A")
    assert db.make_id("ORD1", "MAT1") != db.make_id("ORD1", "MAT2")


def test_make_id_is_plant_blind():
    """
    REGRESSION GUARD for the #202 plant-blindness root cause.

    make_id excludes plant, so the SAME (production_order, material_number) raised
    in two different plants collides to ONE row id. This test PINS that current
    (intentional-but-risky) behavior. When make_id becomes plant-aware (see the
    'Decisions needed' section of CODE_REVIEW_FINDINGS.md), flip this assertion to
    require the ids DIFFER once a plant argument is threaded in.
    """
    id_in_plant_1006 = db.make_id("ORD1", "MAT1")
    id_in_plant_5512 = db.make_id("ORD1", "MAT1")  # no plant in the key -> identical
    assert id_in_plant_1006 == id_in_plant_5512, (
        "make_id is currently plant-blind; if this fails, make_id gained plant-awareness "
        "— update this test and the #202 remediation accordingly."
    )
