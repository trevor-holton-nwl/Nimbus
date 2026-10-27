"""Value defaults ("default changeover by value"): pure maths, oracle, and write contracts.

The grouping maths that counts default-covered pairs has no SQL cross-check, so the
brute-force oracle below is the only guard on it: random states, fields, defaults and
rows must give the same counts and the same missing-page windows as naive pair
enumeration.  Real-Postgres tests live in tests/test_setup_value_defaults_pg.py.
"""
import random

import pytest

import backend.setup.data as setup_data


# ---------------------------------------------------------------------------
# Canonical value (client rule)

@pytest.mark.parametrize("raw, expected", [
    ("Black", "BLACK"), (" black ", "BLACK"), ("TRUE", "true"), (" True ", "true"), ("false", "false"),
    ("FALSE", "false"), (True, "true"), (False, "false"), (12, "12"), (None, ""), ("", ""), ("  ", ""),
])
def test_canonical_default_value_mirrors_the_client_rule(raw, expected):
    assert setup_data.canonical_default_value(raw) == expected


# ---------------------------------------------------------------------------
# Pure grouping maths vs the brute-force oracle

def _naive_default_covered(tuples, default_sets, a, b):
    """Reference rule: arrival at b is covered iff some changed field has a default on b's value."""
    return any(
        tuples[a][i] != tuples[b][i] and tuples[b][i] and tuples[b][i] in default_sets[i]
        for i in range(len(tuples[b]))
    )


def _random_case(rng):
    n_fields = rng.randint(1, 4)
    values = [["A", "B", "C", ""][: rng.randint(2, 4)] for _ in range(n_fields)]
    n_states = rng.randint(0, 12)
    states = []
    seen = set()
    for _ in range(n_states):
        t = tuple(rng.choice(values[i]) for i in range(n_fields))
        if t not in seen:           # state sets are unique by token in production
            seen.add(t)
            states.append(t)
    default_sets = [
        {v for v in values[i] if v and rng.random() < 0.5} for i in range(n_fields)
    ]
    n = len(states)
    row_pairs = set()
    for _ in range(rng.randint(0, max(1, n * n // 2))):
        if n:
            a, b = rng.randrange(n), rng.randrange(n)
            if a != b:
                row_pairs.add((a, b))
    return states, default_sets, row_pairs


def test_grouping_maths_and_lazy_page_generator_equal_naive_enumeration_500_cases():
    rng = random.Random(20261027)
    for case in range(500):
        states, default_sets, row_pairs = _random_case(rng)
        n = len(states)
        masks, groups = setup_data._value_default_structure(states, default_sets)

        naive_default = {(a, b) for a in range(n) for b in range(n)
                         if a != b and _naive_default_covered(states, default_sets, a, b)}
        assert setup_data._default_covered_all(states, masks, groups) == len(naive_default), case

        # overlap of default coverage with the recorded rows (what the counts subtract)
        overlap = sum(1 for p in row_pairs if p in naive_default)
        assert setup_data._rows_default_overlap(states, masks, row_pairs) == overlap, case
        assert setup_data._rows_default_overlap_codes(
            states, masks, [a * n + b for a, b in row_pairs], n) == overlap, case

        # missing = off-diagonal, no row, no default; to-state-major, partners in state order
        naive_missing = [(a, b) for b in range(n) for a in range(n)
                         if a != b and (a, b) not in row_pairs and (a, b) not in naive_default]
        row_hits = {}
        for a, b in row_pairs:
            row_hits.setdefault(b, set()).add(a)
        assert setup_data._missing_count(states, masks, groups, row_hits) == len(naive_missing), case
        for offset, limit in ((0, 500), (0, 1), (1, 3), (len(naive_missing) // 2, 4),
                              (max(len(naive_missing) - 1, 0), 5), (len(naive_missing), 2)):
            got = setup_data._iter_missing_pairs(states, masks, groups, row_hits, offset=offset, limit=limit)
            assert got == naive_missing[offset:offset + limit], (case, offset, limit)


def test_no_defaults_means_every_off_diagonal_pair_is_partnered_and_nothing_default_covered():
    states = [("A",), ("B",), ("C",)]
    masks, groups = setup_data._value_default_structure(states, [set()])
    assert setup_data._default_covered_all(states, masks, groups) == 0
    assert setup_data._missing_count(states, masks, groups, {}) == 6


def test_worked_check_partial_sum_pairs_are_default_covered():
    """PRT01 A=10 B=30 C=60, COLOR RED=15: any change that arrives at a defaulted value is covered."""
    states = [("A", "RED"), ("B", "RED"), ("A", "BLUE"), ("C", "BLUE")]
    default_sets = [{"A", "B", "C"}, {"RED"}]
    masks, groups = setup_data._value_default_structure(states, default_sets)
    # b=(A,BLUE): mask (0,) -> a must differ on PRT01 to be covered; (B,RED)->(A,BLUE) covered, (A,RED)->(A,BLUE) not.
    assert setup_data._default_covered_all(states, masks, groups) == 12 - setup_data._missing_count(
        states, masks, groups, {}
    )
    assert not _naive_default_covered(states, default_sets, 0, 2)
    assert _naive_default_covered(states, default_sets, 1, 2)


# ---------------------------------------------------------------------------
# Pair-level tier on the pure coverage path

DEFINITION = {"fields": ["prt01", "colorWheel"], "signature_version": 3, "strict_blanks": True}


def _key(prt, color):
    return [{"fieldKey": "prt01", "value": prt}, {"fieldKey": "colorWheel", "value": color}]


def test_coverage_pair_reports_value_default_tier_and_row_wins():
    defaults = [{"field_key": "prt01", "value": "B", "setup_min": 30, "signature_version": 3},
                {"field_key": "prt01", "value": "A", "setup_min": 10, "signature_version": 2}]  # old version ignored
    rows = [{"machine": "", "signature_version": 3, "from_key": _key("A", "RED"), "to_key": _key("B", "RED"),
             "setup_min": 5}]
    by_default = setup_data._coverage_pair(DEFINITION, [], "L1", _key("A", "RED"), _key("B", "RED"), defaults)
    assert by_default["covered"] is True and by_default["covered_by"] == "value_default"
    by_row = setup_data._coverage_pair(DEFINITION, rows, "L1", _key("A", "RED"), _key("B", "RED"), defaults)
    assert by_row["covered_by"] == "row"
    zero = setup_data._coverage_pair(DEFINITION, [], "L1", _key("A", "RED"), _key("A", "RED"), defaults)
    assert zero["covered_by"] == "implicit_zero" and zero["implicit_zero"] is True
    old_version_only = setup_data._coverage_pair(DEFINITION, [], "L1", _key("B", "RED"), _key("A", "RED"), defaults)
    assert old_version_only["covered"] is False and old_version_only["covered_by"] is None
    # no defaults argument keeps today's behaviour
    plain = setup_data._coverage_pair(DEFINITION, [], "L1", _key("A", "RED"), _key("B", "RED"))
    assert plain["covered"] is False


def test_build_setup_coverage_counts_default_covered_pairs_separately():
    defaults = [{"field_key": "prt01", "value": "B", "setup_min": 30, "signature_version": 3}]
    result = setup_data.build_setup_coverage(
        DEFINITION, [], [], [{"machine": "L1", "from_key": _key("A", "RED"), "to_key": _key("B", "RED")}],
        {"L1": [_key("A", "RED"), _key("B", "RED")]}, value_defaults=defaults,
    )
    assert result["observed"]["default_covered_pairs"] == 1
    assert result["observed"]["missing_pairs"] == 0
    assert result["reachable"]["default_covered_pairs"] == 1
    assert result["reachable"]["missing_pairs"] == 1     # (B,RED)->(A,RED): arrival at A has no default


# ---------------------------------------------------------------------------
# Write contract (fakes)

class _Cur:
    def __init__(self, definition=(["prt01", "colorWheel"], 3, True, True)):
        self.executed = []
        self.rowcount = 1
        self._definition = definition

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, sql, params=()):
        self.executed.append((sql, params))

    def fetchone(self):
        if "FROM setup_definition" in self.executed[-1][0]:
            return self._definition
        return None


class _Conn:
    def __init__(self, cur):
        self._cur = cur
        self.commits = 0

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def cursor(self):
        return self._cur

    def commit(self):
        self.commits += 1


class _PoolFake:
    def __init__(self, cur):
        self.conn = _Conn(cur)

    def connection(self):
        return self.conn


def test_save_value_defaults_upserts_deletes_and_canonicalizes(monkeypatch):
    cur = _Cur()
    pool = _PoolFake(cur)
    monkeypatch.setattr(setup_data, "_pool", pool)
    result = setup_data.save_value_defaults(
        "5512", 3, "prt01",
        [{"value": " b ", "setup_min": 30}, {"value": "TRUE", "setup_min": "15"}, {"value": "c", "setup_min": None}],
        "admin@example.com",
    )
    assert result == {"plant": "5512", "signature_version": 3, "field_key": "prt01", "upserted": 2, "deleted": 1}
    assert pool.conn.commits == 1
    definition_sql = next(sql for sql, _ in cur.executed if "FROM setup_definition" in sql)
    assert "FOR UPDATE" in definition_sql
    upserts = [p for sql, p in cur.executed if "INSERT INTO setup_value_default" in sql]
    assert [p[3] for p in upserts] == ["B", "true"]          # client canonical form
    assert [p[4] for p in upserts] == [30, 15]
    deletes = [p for sql, p in cur.executed if "DELETE FROM setup_value_default" in sql]
    assert [p[3] for p in deletes] == ["C"]


@pytest.mark.parametrize("field_key, entries, match", [
    ("notAField", [{"value": "A", "setup_min": 1}], "not part of the setup definition"),
    ("prt01", "nope", "entries"),
    ("prt01", [{"value": "A", "setup_min": 10081}], "between 0 and 10080"),
    ("prt01", [{"value": "A", "setup_min": -1}], "nonnegative"),
    ("prt01", [{"value": "  ", "setup_min": 1}], "value is required"),
    ("prt01", [{"value": "a", "setup_min": 1}, {"value": "A", "setup_min": 2}], "Duplicate"),
    ("prt01", [{"value": str(i), "setup_min": 1} for i in range(2001)], "at most 2000"),
])
def test_save_value_defaults_validates(monkeypatch, field_key, entries, match):
    monkeypatch.setattr(setup_data, "_pool", _PoolFake(_Cur()))
    with pytest.raises(ValueError, match=match):
        setup_data.save_value_defaults("5512", 3, field_key, entries, "admin@example.com")


def test_save_value_defaults_rejects_a_stale_version_and_a_missing_definition(monkeypatch):
    monkeypatch.setattr(setup_data, "_pool", _PoolFake(_Cur()))
    with pytest.raises(ValueError, match="is stale"):
        setup_data.save_value_defaults("5512", 2, "prt01", [{"value": "A", "setup_min": 1}], "a@example.com")

    class _NoDef(_Cur):
        def fetchone(self):
            return None

    monkeypatch.setattr(setup_data, "_pool", _PoolFake(_NoDef()))
    with pytest.raises(ValueError, match="No setup definition"):
        setup_data.save_value_defaults("5512", 3, "prt01", [{"value": "A", "setup_min": 1}], "a@example.com")


def test_value_defaults_values_lists_priority_and_observed_values_in_client_form(monkeypatch):
    monkeypatch.setattr(setup_data, "_pool", _PoolFake(_Cur()))
    monkeypatch.setattr(setup_data.db, "get_priority_list",
                        lambda plant, field, line="": {"entries": {"RED": 1, "TRUE": 2}})
    monkeypatch.setattr(setup_data.db, "distinct_order_values", lambda plant, column: ["BLUE", "TRUE"])
    result = setup_data.value_defaults_values("5512", "prt01")
    assert result == {"plant": "5512", "field_key": "prt01", "listed": ["RED", "true"], "observed": ["BLUE", "true"]}


def test_value_defaults_values_rejects_unknown_field_and_missing_definition(monkeypatch):
    monkeypatch.setattr(setup_data, "_pool", _PoolFake(_Cur()))
    with pytest.raises(ValueError, match="not part of the setup definition"):
        setup_data.value_defaults_values("5512", "colorWheelX")

    class _NoDef(_Cur):
        def fetchone(self):
            return None

    monkeypatch.setattr(setup_data, "_pool", _PoolFake(_NoDef()))
    with pytest.raises(ValueError, match="No setup definition"):
        setup_data.value_defaults_values("5512", "prt01")


def test_value_default_entries_reject_non_scalar_values():
    for value in ([1], {"a": 1}):
        with pytest.raises(ValueError):
            setup_data._validated_value_default_entries([{"value": value, "setup_min": 5}])
    assert setup_data._validated_value_default_entries(
        [{"value": "red", "setup_min": 5}, {"value": 7, "setup_min": None}, {"value": True, "setup_min": 1}]
    ) == [("RED", 5), ("7", None), ("true", 1)]
