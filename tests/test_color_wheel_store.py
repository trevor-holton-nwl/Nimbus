"""
Tests for the durable color_wheel Postgres store (2026-07-07).

Background: per-plant color wheels used to live only as ephemeral
COLOR_WHEEL_DIR/color_wheel_<SAFE>.xlsx + _meta.json files (wiped on every
Container Apps restart). They now persist in the `color_wheel` table as a JSONB
{COLOR: ORDER_Y} map. See MIGRATION.md -> Workstream 5.

Two layers, mirroring test_schema_idempotent.py:
  * Pure-logic tests of brain._cw_df_to_entries pin the JSONB-safety coercion
    (NaN -> None, numpy -> native float) so the stored payload is always valid
    JSON. They run whenever pandas + brain import cleanly.
  * The @pytest.mark.pg CRUD round-trip exercises the real table (auto-skipped
    when Postgres is down) — the true proof that entries survive a JSONB
    round-trip and that upsert/get/delete/load_all/list behave.
"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


def _brain():
    try:
        import brain
        return brain
    except Exception as e:  # pragma: no cover - environment dependent
        pytest.skip(f"brain could not be imported in this environment: {e}")


# ---------------------------------------------------------------------------
# Pure-logic: JSONB-safe coercion (no DB)
# ---------------------------------------------------------------------------
def test_df_to_entries_coerces_colors_and_blank_ranks():
    import pandas as pd
    brain = _brain()
    df = pd.DataFrame({"COLOR": [" red ", "Blue", "green"], "ORDER": [1, 2, None]})
    entries = brain._cw_df_to_entries(df)
    assert set(entries) == {"RED", "BLUE", "GREEN"}      # upper/stripped
    assert entries["RED"] == 1.0 and isinstance(entries["RED"], float)
    assert entries["GREEN"] is None                       # blank rank -> None
    json.dumps(entries)                                   # must be JSON-safe (no NaN)


def test_df_to_entries_int_ranks_are_json_serializable():
    """An all-integer ORDER column yields numpy int64; float() coercion must make
    it JSON-serializable (json.dumps raises TypeError on a raw np.int64)."""
    import pandas as pd
    brain = _brain()
    df = pd.DataFrame({"COLOR": ["RED", "BLUE"], "ORDER_Y": [1, 2]})
    entries = brain._cw_df_to_entries(df)
    json.dumps(entries)                                   # would raise if np.int64 leaked
    assert entries == {"RED": 1.0, "BLUE": 2.0}


# ---------------------------------------------------------------------------
# DB round-trip (auto-skipped when Postgres is unreachable)
# ---------------------------------------------------------------------------
@pytest.mark.pg
class TestColorWheelStore:
    KEY = "ZZTEST_CW_PLANT"
    LABEL = "ZZtest/cw plant"     # raw label differs from the sanitized key

    @pytest.fixture(autouse=True)
    def _clean(self, pg):
        pg.ensure_color_wheel_table()
        for _ in range(1):
            with pg._pool.connection() as conn, conn.cursor() as cur:
                cur.execute("DELETE FROM color_wheel WHERE plant_key = %s", (self.KEY,))
                conn.commit()
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM color_wheel WHERE plant_key = %s", (self.KEY,))
            conn.commit()

    def test_upsert_insert_then_replace_round_trips_entries(self, pg):
        entries = {"RED": 1.0, "BLUE": 2.0, "GREEN": None}
        res = pg.upsert_color_wheel(self.KEY, self.LABEL, entries,
                                    filename="wheel.xlsx", row_count=3, uploaded_by="tester")
        assert res["inserted"] is True

        row = pg.get_color_wheel_row(self.KEY)
        assert row is not None
        # entries survive the JSONB round-trip, including the None rank
        assert row["entries"] == {"RED": 1.0, "BLUE": 2.0, "GREEN": None}
        assert row["plant_label"] == self.LABEL
        assert row["filename"] == "wheel.xlsx"
        assert row["row_count"] == 3

        # re-upsert = replace: inserted False, data fully overwritten
        res2 = pg.upsert_color_wheel(self.KEY, self.LABEL, {"RED": 5.0},
                                     filename="wheel2.xlsx", row_count=1, uploaded_by="tester")
        assert res2["inserted"] is False
        row2 = pg.get_color_wheel_row(self.KEY)
        assert row2["entries"] == {"RED": 5.0}
        assert row2["row_count"] == 1

    def test_load_all_list_and_delete(self, pg):
        pg.upsert_color_wheel(self.KEY, self.LABEL, {"RED": 1.0},
                              filename="w.xlsx", row_count=1, uploaded_by="tester")

        allw = pg.load_all_color_wheels()
        assert allw.get(self.KEY) == {"RED": 1.0}         # keyed by sanitized key

        listing, total = pg.list_color_wheels_meta()
        assert self.LABEL in listing                       # listing keyed by raw label
        assert listing[self.LABEL]["filename"] == "w.xlsx"
        assert total >= 1

        # delete returns the deleted row's filename, then the row is gone
        assert pg.delete_color_wheel(self.KEY) == {"filename": "w.xlsx"}
        assert pg.get_color_wheel_row(self.KEY) is None
        assert pg.delete_color_wheel(self.KEY) is None     # idempotent
