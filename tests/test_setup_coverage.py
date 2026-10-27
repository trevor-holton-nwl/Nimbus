"""Read-only coverage contracts for Stage 0 setup shadow diagnostics."""
import copy
import json
from datetime import datetime

import pytest
from psycopg.types.json import Jsonb

import backend.setup.data as setup_data


DEFINITION = {
    "plant": "5512", "fields": ["colorWheel"], "signature_version": 4,
    "strict_blanks": True, "active": False,
}
RED = [{"fieldKey": "colorWheel", "value": "RED"}]
BLUE = [{"fieldKey": "colorWheel", "value": "BLUE"}]
GREEN = [{"fieldKey": "colorWheel", "value": "GREEN"}]


def _row(line, from_key, to_key, minutes=12):
    return {"machine": line, "signature_version": 4, "from_key": from_key, "to_key": to_key,
            "setup_min": minutes}


def test_coverage_distinguishes_observed_adjacencies_from_reachable_state_pairs():
    """Reachable coverage includes legal alternatives, while observed contains only schedule edges."""
    result = setup_data.build_setup_coverage(
        DEFINITION, [_row("", RED, BLUE)], [],
        [
            {"machine": "L1", "from_key": RED, "to_key": BLUE},
            {"machine": "L1", "from_key": BLUE, "to_key": GREEN},
        ],
        {"L1": [RED, BLUE, GREEN]},
    )
    assert result["observed"]["total_pairs"] == 2
    assert result["observed"]["missing_pairs"] == 1
    assert result["reachable"]["total_pairs"] == 9
    # Three complete diagonals are covered implicitly at zero; RED→BLUE has
    # the explicit plant row, leaving five missing non-diagonal transitions.
    assert result["reachable"]["missing_pairs"] == 5
    assert result["observed"]["missing"][0]["from_key"] == BLUE
    assert result["observed"]["missing"][0]["to_key"] == GREEN


def test_coverage_deduplicates_by_line_and_pair_and_keeps_line_scope_distinct():
    """Repeated schedule edges produce one review row per pair/scope, never a global accidental merge."""
    result = setup_data.build_setup_coverage(
        DEFINITION, [], [_row("L1", RED, BLUE)],
        [
            {"machine": "L1", "from_key": RED, "to_key": BLUE},
            {"machine": "L1", "from_key": RED, "to_key": BLUE},
            {"machine": "L2", "from_key": RED, "to_key": BLUE},
        ],
        {"L1": [RED, BLUE], "L2": [RED, BLUE]},
    )
    assert result["observed"]["total_pairs"] == 2
    assert result["observed"]["missing_pairs"] == 1
    assert result["observed"]["missing"][0]["machine"] == "L2"
    assert result["observed"]["missing"][0]["scope"] == "plant"


def test_coverage_excludes_implicit_diagonal_but_rejects_invalid_or_incomplete_states():
    """The only missing edge allowed to resolve is a complete identical pair; malformed data is not coverage."""
    invalid = [{"fieldKey": "wrong", "value": "RED"}]
    incomplete = [{"fieldKey": "colorWheel", "value": ""}]
    result = setup_data.build_setup_coverage(
        DEFINITION, [], [],
        [
            {"machine": "L1", "from_key": RED, "to_key": RED},
            {"machine": "L1", "from_key": RED, "to_key": incomplete},
            {"machine": "L1", "from_key": invalid, "to_key": BLUE},
        ],
        {"L1": [RED, RED, incomplete, invalid]},
    )
    assert result["observed"]["total_pairs"] == 1
    assert result["observed"]["missing_pairs"] == 0
    assert result["reachable"]["total_pairs"] == 1
    assert result["reachable"]["missing_pairs"] == 0


def test_missing_pair_page_is_stable_filtered_and_bounded():
    """Review/export requests never default to an unbounded plant-wide missing-pair payload."""
    rows = [
        {"machine": "L2", "scope": "plant", "from_key": RED, "to_key": GREEN},
        {"machine": "L1", "scope": "machine", "from_key": RED, "to_key": BLUE},
        {"machine": "L1", "scope": "plant", "from_key": BLUE, "to_key": GREEN},
    ]
    page = setup_data.page_missing_pairs(rows, machine="L1", offset=1, limit=1)
    assert page == {"rows": [rows[2]], "meta": {"total": 2, "offset": 1, "limit": 1}}
    with pytest.raises(ValueError, match="limit"):
        setup_data.page_missing_pairs(rows, offset=0, limit=501)


def test_coverage_inputs_remain_unchanged():
    """Coverage is a pure observation: it cannot rewrite schedule rows, keys, or matrix records."""
    plant_rows = [_row("", RED, BLUE)]
    transitions = [{"machine": "L1", "from_key": RED, "to_key": BLUE}]
    states = {"L1": [RED, BLUE]}
    before = copy.deepcopy((plant_rows, transitions, states))
    setup_data.build_setup_coverage(DEFINITION, plant_rows, [], transitions, states)
    assert (plant_rows, transitions, states) == before


def test_bounded_coverage_summary_and_page_match_existing_semantics_without_snapshot(monkeypatch):
    """The database-backed read path keeps the Stage 0 counts/page contract without hydrating optimizer truth."""
    cursor = _CoverageCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    monkeypatch.setattr(
        setup_data,
        "get_setup_snapshot",
        lambda _plant: (_ for _ in ()).throw(AssertionError("coverage must not load the optimizer snapshot")),
    )

    result = setup_data.get_setup_coverage_page("5512", machine="L2", offset=1, limit=2)

    assert result["plant"] == "5512"
    assert result["definition"] == DEFINITION
    assert {
        kind: {key: result[kind][key] for key in ("total_pairs", "covered_pairs", "missing_pairs")}
        for kind in ("observed", "reachable")
    } == {
        "observed": {"total_pairs": 4, "covered_pairs": 3, "missing_pairs": 1},
        "reachable": {"total_pairs": 18, "covered_pairs": 9, "missing_pairs": 9},
    }
    assert result["observed"]["default_covered_pairs"] == 0 and result["reachable"]["default_covered_pairs"] == 0
    # To-state-major: to=RED gives BLUE->RED, GREEN->RED; to=BLUE gives GREEN->BLUE (RED->BLUE is a row); ...
    assert result["reachable"]["missing_page"] == {
        "rows": [
            {"machine": "L2", "scope": "plant", "from_key": GREEN, "to_key": RED,
             "covered": False, "implicit_zero": False},
            {"machine": "L2", "scope": "plant", "from_key": GREEN, "to_key": BLUE,
             "covered": False, "implicit_zero": False},
        ],
        "meta": {"total": 5, "offset": 1, "limit": 2},
    }
    statements = "\n".join(sql for sql, _params in cursor.executed)
    assert "FROM machine_setup_state" not in statements
    assert "FROM setup_occurrence_override" not in statements
    assert "jsonb_to_recordset" in statements
    assert "setup coverage matrix rows" in statements


def test_get_setup_coverage_compatibility_wrapper_never_loads_snapshot(monkeypatch):
    """The legacy totals-only data entry point remains snapshot-free."""
    cursor = _CoverageCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    monkeypatch.setattr(
        setup_data,
        "get_setup_snapshot",
        lambda _plant: (_ for _ in ()).throw(AssertionError("coverage must not load the optimizer snapshot")),
    )

    result = setup_data.get_setup_coverage("5512")

    assert result == {
        "plant": "5512",
        "definition": DEFINITION,
        "observed": {"total_pairs": 4, "covered_pairs": 3, "default_covered_pairs": 0, "missing_pairs": 1},
        "reachable": {"total_pairs": 18, "covered_pairs": 9, "default_covered_pairs": 0, "missing_pairs": 9},
    }


def test_bounded_coverage_rejects_an_oversized_page_before_database_access(monkeypatch):
    """The public coverage bundle enforces the route's 500-row ceiling itself."""
    monkeypatch.setattr(setup_data, "_pool", _FailPool())
    with pytest.raises(ValueError, match="limit"):
        setup_data.get_setup_coverage_page("5512", limit=501)


def test_coverage_bundle_uses_one_repeatable_read_cursor_and_one_plant_wide_row_query(monkeypatch):
    """Summary and pages share one snapshot; one bounded row query serves counts and pages, never a Cartesian product."""
    cursor = _CoverageCursor()
    pool = _CountingPool(cursor)
    monkeypatch.setattr(setup_data, "_pool", pool)
    result = setup_data.get_setup_coverage_page("5512", machine="L2", offset=1, limit=2)

    assert pool.connection_calls == 1
    assert cursor.executed[0][0] == "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
    assert result["reachable"]["missing_page"]["meta"] == {"total": 5, "offset": 1, "limit": 2}
    row_queries = [(sql, params) for sql, params in cursor.executed if "setup coverage matrix rows" in sql]
    assert len(row_queries) == 1
    assert row_queries[0][1][1:] == ("5512", 4, ["L1", "L2"])
    assert "m.machine = ANY(%s)" in row_queries[0][0] and "JOIN known AS f" in row_queries[0][0]
    assert not any("candidate_input" in sql or "ordinal window" in sql for sql, _ in cursor.executed)


def test_missing_page_skips_whole_machines_by_their_missing_counts(monkeypatch):
    """An offset past machine L1's 4 missing pairs lands in L2 (counts, not enumeration, do the skipping)."""
    cursor = _CoverageCursor()
    monkeypatch.setattr(setup_data, "_pool", _Pool(cursor))
    result = setup_data.get_setup_coverage_page("5512", offset=4, limit=2)
    assert [(r["machine"], r["from_key"], r["to_key"]) for r in result["reachable"]["missing_page"]["rows"]] == [
        ("L2", BLUE, RED), ("L2", GREEN, RED)]


class _CoverageCursor:
    """Deterministic PostgreSQL boundary double for the bounded coverage helpers."""

    ORDER_ROWS = [
        ("L1", False, "RED"),
        ("L1", False, "BLUE"),
        ("L1", False, "GREEN"),
        ("L2", False, "RED"),
        ("L2", False, "BLUE"),
        ("L2", False, "GREEN"),
    ]

    def __init__(self):
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, sql, params=()):
        self.executed.append((sql, params))

    def fetchone(self):
        return (["colorWheel"], 4, True, False)

    def fetchall(self):
        sql, params = self.executed[-1]
        if "FROM orders" in sql:
            return self.ORDER_ROWS
        if "setup state text tokens" in sql:
            states = params[0].obj if hasattr(params[0], "obj") else params[0]
            return [(row["machine"], row["state_order"], json.dumps(row["state_key"], sort_keys=True))
                    for row in states]
        if "setup coverage matrix rows" in sql:
            # effective off-diagonal rows: L1 has two (covered 3 diagonal + 2), L2 has one (3 + 1)
            text = lambda key: json.dumps(key, sort_keys=True)  # noqa: E731
            return [("L1", text(RED), text(BLUE)), ("L1", text(BLUE), text(GREEN)), ("", text(RED), text(BLUE))]
        if "setup observed missing page" in sql:
            return [("L2", BLUE, GREEN)]
        if "FROM setup_value_default" in sql:
            return []
        raise AssertionError(f"Unexpected coverage query: {sql}")


class _Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def cursor(self):
        return self._cursor


class _Pool:
    def __init__(self, cursor):
        self._cursor = cursor

    def connection(self):
        return _Connection(self._cursor)


class _CountingPool(_Pool):
    def __init__(self, cursor):
        super().__init__(cursor)
        self.connection_calls = 0

    def connection(self):
        self.connection_calls += 1
        return super().connection()


class _FailPool:
    def connection(self):
        raise AssertionError("paging validation must run before database access")


@pytest.mark.pg
def test_real_coverage_no_definition_is_empty_and_snapshot_free(pg):
    """A real current-plant lookup with no definition returns empty bounded coverage."""
    plant = "ZZTEST_SETUP_COVERAGE_NO_DEF"
    _reset_real_coverage_plant(pg, plant)
    try:
        result = setup_data.get_setup_coverage_page(plant, offset=0, limit=500)
        assert result["plant"] == plant
        assert result["definition"] is None
        for kind in ("observed", "reachable"):
            assert result[kind] == {
                "total_pairs": 0, "covered_pairs": 0, "default_covered_pairs": 0, "missing_pairs": 0,
                "missing_page": {"rows": [], "meta": {"total": 0, "offset": 0, "limit": 500}},
            }
    finally:
        _reset_real_coverage_plant(pg, plant)


@pytest.mark.pg
def test_real_coverage_empty_orders_has_zero_state_universe(pg):
    """A current definition with no valid order states has no observed or reachable pairs."""
    plant = "ZZTEST_SETUP_COVERAGE_EMPTY"
    _reset_real_coverage_plant(pg, plant)
    _insert_real_coverage_definition(pg, plant, version=7)
    try:
        result = setup_data.get_setup_coverage_page(plant, offset=0, limit=500)
        assert result["definition"]["signature_version"] == 7
        assert result["observed"] == {
            "total_pairs": 0, "covered_pairs": 0, "default_covered_pairs": 0, "missing_pairs": 0,
            "missing_page": {"rows": [], "meta": {"total": 0, "offset": 0, "limit": 500}},
        }
        assert result["reachable"] == result["observed"]
    finally:
        _reset_real_coverage_plant(pg, plant)


@pytest.mark.pg
def test_real_coverage_matches_pure_semantics_for_paging_filter_and_inheritance(pg):
    """Real SQL preserves pure coverage semantics, stable pages, diagonal coverage, and inheritance."""
    plant = "ZZTEST_SETUP_COVERAGE_SEMANTICS"
    version = 7
    red = [{"fieldKey": "colorWheel", "value": "RED"}]
    blue = [{"fieldKey": "colorWheel", "value": "BLUE"}]
    green = [{"fieldKey": "colorWheel", "value": "GREEN"}]
    definition = {
        "plant": plant, "fields": ["colorWheel"], "signature_version": version,
        "strict_blanks": True, "active": False,
    }
    plant_rows = [_real_coverage_row("", red, blue, version)]
    machine_rows = [
        _real_coverage_row("L1", red, blue, version),
        _real_coverage_row("L1", blue, green, version),
    ]
    observed = [
        {"machine": "L1", "from_key": red, "to_key": blue},
        {"machine": "L1", "from_key": blue, "to_key": green},
        {"machine": "L1", "from_key": green, "to_key": red},
        {"machine": "L2", "from_key": red, "to_key": blue},
        {"machine": "L2", "from_key": blue, "to_key": green},
    ]
    states = {"L1": [red, blue, green], "L2": [red, blue, green]}
    expected = setup_data.build_setup_coverage(definition, plant_rows, machine_rows, observed, states)
    state_order = {"RED": 0, "BLUE": 1, "GREEN": 2}

    def page_row(row):
        return {key: value for key, value in row.items() if key != "covered_by"}

    def expected_missing_rows(kind, machine=None):
        rows = [page_row(r) for r in expected[kind]["missing"] if machine in (None, r["machine"])]
        if kind == "reachable":   # the reachable page is to-state-major, partners in state order
            rows.sort(key=lambda r: (r["machine"], state_order[r["to_key"][0]["value"]],
                                     state_order[r["from_key"][0]["value"]]))
        return rows
    _reset_real_coverage_plant(pg, plant)
    _insert_real_coverage_definition(pg, plant, version=version)
    _insert_real_coverage_orders(pg, plant, states={"L1": [red, blue, green, red], "L2": [red, blue, green]})
    _insert_real_coverage_matrix(pg, plant, plant_rows + machine_rows)
    try:
        result = setup_data.get_setup_coverage_page(plant, offset=1, limit=1)
        for kind in ("observed", "reachable"):
            expected_missing = expected_missing_rows(kind)
            assert {
                key: result[kind][key] for key in ("total_pairs", "covered_pairs", "missing_pairs")
            } == {
                key: expected[kind][key] for key in ("total_pairs", "covered_pairs", "missing_pairs")
            }
            assert result[kind]["missing_page"]["meta"] == {
                "total": len(expected_missing), "offset": 1, "limit": 1,
            }
            assert result[kind]["missing_page"]["rows"] == expected_missing[1:2]

        filtered = setup_data.get_setup_coverage_page(plant, machine="L2", offset=0, limit=500)
        for kind in ("observed", "reachable"):
            expected_missing = expected_missing_rows(kind, "L2")
            assert filtered[kind]["missing_page"] == {
                "rows": expected_missing,
                "meta": {"total": len(expected_missing), "offset": 0, "limit": 500},
            }

        exported_path = setup_data.get_setup_missing_pairs_page(plant, "observed", offset=1, limit=1)
        assert exported_path["page"] == result["observed"]["missing_page"]
    finally:
        _reset_real_coverage_plant(pg, plant)


def _real_coverage_row(machine, from_key, to_key, version):
    return {"machine": machine, "signature_version": version, "from_key": from_key,
            "to_key": to_key, "setup_min": 12}


def _reset_real_coverage_plant(pg, plant):
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM setup_matrix WHERE plant = %s", (plant,))
        cur.execute("DELETE FROM setup_definition WHERE plant = %s", (plant,))
        cur.execute("DELETE FROM orders WHERE plant = %s", (plant,))
        conn.commit()


def _insert_real_coverage_definition(pg, plant, version):
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """INSERT INTO setup_definition
               (plant, fields, signature_version, strict_blanks, active)
               VALUES (%s, %s, %s, TRUE, FALSE)""",
            (plant, Jsonb(["colorWheel"]), version),
        )
        conn.commit()


def _insert_real_coverage_orders(pg, plant, states):
    order_no = 0
    with pg._pool.connection() as conn, conn.cursor() as cur:
        for machine, machine_states in states.items():
            for state in machine_states:
                order_no += 1
                order_id = f"zzsc_{plant[-8:].lower()}_{order_no}"
                color = state[0]["value"]
                cur.execute(
                    """INSERT INTO orders
                       (id, production_order, material_number, plant, machine, color, basic_start_date)
                       VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                    (order_id, order_id, order_id, plant, machine, color,
                     datetime(2026, 9, 1, 8 + order_no)),
                )
        conn.commit()


def _insert_real_coverage_matrix(pg, plant, rows):
    with pg._pool.connection() as conn, conn.cursor() as cur:
        for row in rows:
            cur.execute(
                """INSERT INTO setup_matrix
                   (plant, machine, signature_version, from_key, to_key, setup_min)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (plant, row["machine"], row["signature_version"], Jsonb(row["from_key"]),
                 Jsonb(row["to_key"]), row["setup_min"]),
            )
        conn.commit()


def test_coverage_orders_on_stored_edges_and_excludes_queued_rows_from_transitions(monkeypatch):
    """U3: adjacency sorts scheduled_start -> scheduled_end -> basic_start_date (a finish-only placement sorts
    where it sits), and a queued (Needs Planning) order contributes its state but never an observed transition."""
    monkeypatch.setattr(setup_data, "_definition", lambda cur, plant: {**DEFINITION, "plant": plant})

    class Cur:
        def __init__(self):
            self.sql = None

        def execute(self, sql, params=None):
            self.sql = sql

        def fetchall(self):
            if "setup_value_default" in self.sql:
                return []
            # (machine, queued, colorWheel) in the order the SQL sorts them: RED placed, BLUE queued, GREEN placed
            return [("L1", False, "RED"), ("L1", True, "BLUE"), ("L1", False, "GREEN")]

    cur = Cur()
    result = setup_data._load_setup_coverage(cur, "5512")
    assert setup_data._COVERAGE_ORDER_SQL in cur.sql
    assert "COALESCE(seg.first_start, o.scheduled_start, o.scheduled_end, o.basic_start_date)" in cur.sql
    # the queued BLUE order is a known state, but RED -> GREEN is the only adjacency
    assert len(result["states"]) == 3
    assert [(r["from_key"], r["to_key"]) for r in result["observed"]] == [(RED, GREEN)]
