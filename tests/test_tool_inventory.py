"""Tool Inventory backend (Wave 1): registry, the shared normaliser/validator, the planner
routes (plant scoping, dry-run review diff, template/export round trip), the usage counter,
the Order Rule setter and the admin-audit registrations.

Most of this runs WITHOUT Postgres: data-layer calls are replaced by monkeypatched doubles and
the pool by a recording fake (same style as tests/test_rbac_plant_scoping.py and
tests/test_master_data_setup_policy.py). The two `@pytest.mark.pg` tests at the bottom need a
real local database (NIMBUS_TEST_DB=1).
"""
import io
from contextlib import contextmanager

import psycopg
import pytest
from openpyxl import Workbook, load_workbook

import db
import master_data as md
from backend.master_data import tool_inventory as ti

try:
    from fastapi.routing import iter_route_contexts
    from starlette.testclient import TestClient

    import backend.security.auth as auth
    import brain
except Exception as exc:  # pragma: no cover - depends on local application imports
    pytest.skip(f"brain/TestClient unavailable in this environment: {exc}", allow_module_level=True)

PLANT = "ZZTEST_TI_PLANT"
OTHER = "ZZTEST_TI_OTHER"


# --- registry ------------------------------------------------------------------------------------
def test_tool_inventory_is_registered_everywhere():
    assert "tool_inventory" in md.ALLOWED_TABLES
    assert "tool_inventory" in md.PLANT_SCOPED_TABLES
    assert md._KEY_COLUMNS["tool_inventory"] == frozenset({"plant", "tool_id"})
    assert md._SEARCH_COLUMNS["tool_inventory"] == ("tool_id", "note")
    assert len(md.ALLOWED_TABLES) == 13


def test_admin_write_operations_register_the_new_routes():
    ops = brain._ADMIN_WRITE_OPERATIONS
    assert ops["/tool-inventory/{plant}/bulk"] == "tool_inventory.bulk_write"
    assert ops["/tool-inventory/{plant}/upload"] == "tool_inventory.upload"
    assert ops["/master-data/plants/{plant}/tooling-rule"] == "plant.tooling_rule_update"


# --- normaliser / validator -----------------------------------------------------------------------
def _row(**kw):
    base = {"tool_id": "T100", "total_qty": 3, "out_of_service_qty": 0, "note": None}
    base.update(kw)
    return base


def test_tool_id_is_trimmed_upper_cased_and_float_suffix_stripped():
    assert md.normalize_tool_inventory_row(_row(tool_id=" t100 "), PLANT)["tool_id"] == "T100"
    assert md.normalize_tool_inventory_row(_row(tool_id=1234.0), PLANT)["tool_id"] == "1234"


@pytest.mark.parametrize("bad", ["", "  ", "-", "0", "N/A", "none", "Null", "nan", "TBD", None])
def test_placeholder_or_blank_tool_ids_are_rejected(bad):
    with pytest.raises(ValueError):
        md.normalize_tool_inventory_row(_row(tool_id=bad), PLANT)


def test_tool_id_length_cap():
    md.normalize_tool_inventory_row(_row(tool_id="X" * 100), PLANT)
    with pytest.raises(ValueError):
        md.normalize_tool_inventory_row(_row(tool_id="X" * 101), PLANT)


@pytest.mark.parametrize("raw,expected", [(3, 3), ("3", 3), ("3.0", 3), (3.0, 3), (" 7 ", 7), (0, 0)])
def test_quantities_accept_whole_numbers(raw, expected):
    assert md.normalize_tool_inventory_row(_row(total_qty=raw), PLANT)["total_qty"] == expected


@pytest.mark.parametrize("raw", [2.7, "2.7", True, False, -1, "-1", -3.0, "abc", float("inf"), 10**7, [1]])
def test_quantities_reject_fractions_bools_negatives_and_junk(raw):
    with pytest.raises(ValueError):
        md.normalize_tool_inventory_row(_row(total_qty=raw), PLANT)


@pytest.mark.parametrize("blank", [None, "", "  ", float("nan")])
def test_blank_total_is_rejected_but_blank_out_of_service_is_zero(blank):
    with pytest.raises(ValueError):
        md.normalize_tool_inventory_row(_row(total_qty=blank), PLANT)
    assert md.normalize_tool_inventory_row(_row(out_of_service_qty=blank), PLANT)["out_of_service_qty"] == 0


def test_out_of_service_cannot_exceed_total_and_may_equal_it():
    with pytest.raises(ValueError):
        md.normalize_tool_inventory_row(_row(total_qty=2, out_of_service_qty=3), PLANT)
    assert md.normalize_tool_inventory_row(_row(total_qty=2, out_of_service_qty=2), PLANT)["out_of_service_qty"] == 2
    assert md.normalize_tool_inventory_row(_row(total_qty=0, out_of_service_qty=0), PLANT)["total_qty"] == 0


def test_note_is_trimmed_blank_means_none_and_capped():
    assert md.normalize_tool_inventory_row(_row(note="  hi "), PLANT)["note"] == "hi"
    assert md.normalize_tool_inventory_row(_row(note="  "), PLANT)["note"] is None
    with pytest.raises(ValueError):
        md.normalize_tool_inventory_row(_row(note="n" * 501), PLANT)


def test_plant_is_forced_onto_the_row_and_required_otherwise():
    assert md.normalize_tool_inventory_row(_row(plant=OTHER), PLANT)["plant"] == PLANT
    assert md.normalize_tool_inventory_row(_row(plant=OTHER))["plant"] == OTHER
    with pytest.raises(ValueError):
        md.normalize_tool_inventory_row(_row())


def test_duplicates_after_normalisation_reject_the_later_row():
    clean, rejected = md.normalize_tool_inventory_upserts(
        [_row(tool_id="t100", total_qty=1), _row(tool_id="T100 ", total_qty=9), _row(tool_id="T200")], PLANT)
    assert [(r["tool_id"], r["total_qty"]) for r in clean] == [("T100", 1), ("T200", 3)]
    assert [r["index"] for r in rejected] == [1]


def test_prepare_forces_plant_onto_deletes_and_upserts_and_caps_ops():
    ups, dels = md._prepare_tool_inventory_ops({
        "plant": PLANT,
        "upserts": [_row(plant=OTHER)],
        "deletes": [{"tool_id": " t9 "}, {"tool_id": "T9", "plant": OTHER}],
    })
    assert ups[0]["plant"] == PLANT
    assert dels == [{"plant": PLANT, "tool_id": "T9"}]  # normalised, forced, de-duplicated
    with pytest.raises(ValueError):
        md._prepare_tool_inventory_ops({"upserts": [_row() for _ in range(md.MAX_TOOL_INVENTORY_OPS + 1)]})
    with pytest.raises(ValueError):  # no ops['plant'] (generic admin path): each delete must carry its own
        md._prepare_tool_inventory_ops({"deletes": [{"tool_id": "T1"}]})


def test_prepare_is_all_or_nothing():
    with pytest.raises(ValueError, match="Total Inventory"):
        md._prepare_tool_inventory_ops({"plant": PLANT, "upserts": [_row(), _row(tool_id="T2", total_qty=2.7)]})


# --- bulk_apply with a recording fake pool ---------------------------------------------------------
class _Cur:
    rowcount = 1

    def __init__(self):
        self.calls = []
        self._last = ""
        self._ins = 0

    def execute(self, stmt, params=None):
        self._last = str(stmt)
        self.calls.append((self._last, params))

    def executemany(self, stmt, values, returning=False):
        self.calls.append((str(stmt), list(values)))
        self._ins = len(values)

    def nextset(self):
        return True

    def fetchone(self):
        return (True,)

    def fetchall(self):
        if "column_metadata" in self._last:
            return [(c, c, c in ("plant", "tool_id"), i, "TEXT", "NO", None)
                    for i, c in enumerate(("plant", "tool_id", "total_qty", "out_of_service_qty", "note"))]
        return []  # before-state read: nothing exists yet


class _Conn:
    def __init__(self, cur):
        self.cur = cur

    @contextmanager
    def cursor(self):
        yield self.cur

    def commit(self):
        pass

    def rollback(self):
        pass


class _Pool:
    def __init__(self, cur):
        self.cur = cur

    @contextmanager
    def connection(self):
        yield _Conn(self.cur)


def test_bulk_apply_forces_plant_on_deletes_and_writes_a_detailed_audit_row(monkeypatch):
    cur = _Cur()
    monkeypatch.setattr(md, "_pool", _Pool(cur))
    md.bulk_apply("tool_inventory", {
        "plant": PLANT, "source": "grid", "filename": "f.xlsx",
        "upserts": [_row(tool_id="t5", plant=OTHER)],
        "deletes": [{"tool_id": "t4", "plant": OTHER}],
    }, user_email="a@example.com")
    delete = next(c for c in cur.calls if c[0].startswith("DELETE") or "DELETE FROM" in c[0])
    assert delete[1] == [PLANT, "T4"]
    insert_values = next(c for c in cur.calls if "INSERT INTO" in c[0] and isinstance(c[1], list))[1]
    assert insert_values[0][:2] == [PLANT, "T5"]
    audit = next(c for c in cur.calls if "admin_audit" in c[0])
    details = audit[1][2].obj
    assert details["plants"] == [PLANT] and details["source"] == "grid" and details["filename"] == "f.xlsx"
    # before-state is empty: the new T5 is a change; deleting a row that never existed is not
    assert [c["tool_id"] for c in details["changes"]] == ["T5"]
    assert details["changes_total"] == len(details["changes"])
    assert audit[1][3] == "a@example.com"


# --- route harness ---------------------------------------------------------------------------------
@pytest.fixture
def client():
    brain.api.dependency_overrides[auth.get_allowed_plants_for_request] = lambda: [PLANT]
    brain.api.dependency_overrides[auth.require_authenticated] = lambda: "planner@example.com"
    try:
        yield TestClient(brain.api)
    finally:
        brain.api.dependency_overrides.clear()


@pytest.fixture
def known_plant(monkeypatch):
    monkeypatch.setattr(md, "plant_exists", lambda p: p == PLANT)


def _xlsx(rows, headers=("Tool ID", "Total Inventory", "Out of Service", "Note")):
    wb = Workbook()
    ws = wb.active
    ws.append(list(headers))
    for r in rows:
        ws.append(list(r))
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


@pytest.mark.parametrize("method,path,kw", [
    ("post", "/tool-inventory/{p}/bulk", {"json": {"upserts": [], "deletes": []}}),
    ("post", "/tool-inventory/{p}/upload", {"files": {"file": ("f.xlsx", b"x")}}),
    ("get", "/tool-inventory/{p}/template.xlsx", {}),
    ("get", "/tool-inventory/{p}/export.xlsx", {}),
    ("post", "/tool-inventory/{p}/usage", {"json": {"tool_ids": ["T1"]}}),
    ("post", "/master-data/plants/{p}/tooling-rule", {"json": {"tooling_rule": "hard"}}),
])
def test_out_of_scope_plant_is_403_on_every_planner_route(client, monkeypatch, method, path, kw):
    monkeypatch.setattr(md, "bulk_apply", lambda *a, **k: pytest.fail("write reached the data layer"))
    monkeypatch.setattr(md, "set_plant_tooling_rule", lambda *a, **k: pytest.fail("write reached the data layer"))
    assert getattr(client, method)(path.format(p=OTHER), **kw).status_code == 403


def test_unknown_plant_is_404(client, monkeypatch):
    monkeypatch.setattr(md, "plant_exists", lambda p: False)
    assert client.post(f"/tool-inventory/{PLANT}/usage", json={"tool_ids": []}).status_code == 404


def test_bulk_route_passes_the_path_plant_and_the_auth_email_to_bulk_apply(client, known_plant, monkeypatch):
    seen = {}

    def fake(table, ops, user_email=None):
        seen.update(table=table, ops=ops, email=user_email)
        return {"inserted": 1, "updated": 0, "deleted": 0}

    monkeypatch.setattr(md, "bulk_apply", fake)
    r = client.post(f"/tool-inventory/{PLANT}/bulk", headers={"x-user-email": "spoof@example.com"},
                    json={"upserts": [_row(plant=OTHER)], "deletes": [{"tool_id": "T1"}], "source": "grid"})
    assert r.status_code == 200 and r.json()["inserted"] == 1
    assert seen["table"] == "tool_inventory" and seen["ops"]["plant"] == PLANT
    assert seen["email"] == "planner@example.com"  # from the auth dependency, not the raw header


def test_bulk_route_maps_validation_errors_to_400(client, known_plant):
    r = client.post(f"/tool-inventory/{PLANT}/bulk", json={"upserts": [_row(total_qty=2.7)]})
    assert r.status_code == 400 and "Total Inventory" in r.json()["detail"]


# --- upload: dry-run diff and apply -----------------------------------------------------------------
CURRENT = [
    {"tool_id": "T1", "total_qty": 2, "out_of_service_qty": 0, "note": None},
    {"tool_id": "T2", "total_qty": 1, "out_of_service_qty": 0, "note": None},
    {"tool_id": "T9", "total_qty": 5, "out_of_service_qty": 1, "note": "left alone"},
]


def test_dry_run_returns_the_review_diff_and_writes_nothing(client, known_plant, monkeypatch):
    monkeypatch.setattr(md, "load_tool_inventory_rows", lambda p: CURRENT)
    monkeypatch.setattr(md, "bulk_apply", lambda *a, **k: pytest.fail("dry run must not write"))
    data = _xlsx([("t1", 4, 1, "x"),          # changed
                  ("T2", 1, None, None),      # unchanged
                  ("t3", 2, 0, None),         # new
                  ("T4", 2.7, 0, None),       # rejected
                  ("T3", 5, 0, None)])        # duplicate after normalisation
    r = client.post(f"/tool-inventory/{PLANT}/upload?dry_run=1", files={"file": ("f.xlsx", data)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["counts"] == {"new": 1, "changed": 1, "unchanged": 1, "rejected": 2}
    assert [n["tool_id"] for n in body["new"]] == ["T3"]
    assert body["changed"][0]["tool_id"] == "T1"
    assert body["changed"][0]["before"]["total_qty"] == 2 and body["changed"][0]["after"]["total_qty"] == 4
    assert body["unchanged"] == ["T2"] and body["rows"] == 5
    assert {x["row"] for x in body["rejected"]} == {5, 6}
    assert "T9" not in str(body)  # upsert-only: tools missing from the file never show up


def test_apply_writes_only_new_and_changed_rows(client, known_plant, monkeypatch):
    monkeypatch.setattr(md, "load_tool_inventory_rows", lambda p: CURRENT)
    seen = {}

    def fake(table, ops, user_email=None):
        seen.update(ops=ops)
        return {"inserted": 1, "updated": 1, "deleted": 0}

    monkeypatch.setattr(md, "bulk_apply", fake)
    data = _xlsx([("T1", 4, 1, None), ("T2", 1, 0, None), ("T3", 2, 0, None), ("", 1, 0, None)])
    r = client.post(f"/tool-inventory/{PLANT}/upload", files={"file": ("f.xlsx", data)})
    assert r.status_code == 200, r.text
    assert sorted(u["tool_id"] for u in seen["ops"]["upserts"]) == ["T1", "T3"]
    assert seen["ops"]["deletes"] == [] and seen["ops"]["filename"] == "f.xlsx"
    assert r.json()["inserted"] == 1 and r.json()["rejected"] == 1 and r.json()["plants"] == [PLANT]


def test_upload_rejects_unreadable_file_missing_columns_wrong_plant_and_oversize(client, known_plant, monkeypatch):
    monkeypatch.setattr(md, "load_tool_inventory_rows", lambda p: [])
    r = client.post(f"/tool-inventory/{PLANT}/upload?dry_run=1", files={"file": ("f.xls", b"not a workbook")})
    assert r.status_code == 400 and ".xlsx" in r.json()["detail"]
    r = client.post(f"/tool-inventory/{PLANT}/upload?dry_run=1",
                    files={"file": ("f.xlsx", _xlsx([("T1", 1)], headers=("Tool ID", "Qty")))})
    assert r.status_code == 400 and "Missing required column" in r.json()["detail"]
    data = _xlsx([("T1", 1, 0, None, OTHER), ("T2", 1, 0, None, PLANT)],
                 headers=("Tool ID", "Total Inventory", "Out of Service", "Note", "Plant"))
    body = client.post(f"/tool-inventory/{PLANT}/upload?dry_run=1", files={"file": ("f.xlsx", data)}).json()
    assert [n["tool_id"] for n in body["new"]] == ["T2"] and body["counts"]["rejected"] == 1
    monkeypatch.setattr(ti, "MAX_UPLOAD_BYTES", 10)
    assert client.post(f"/tool-inventory/{PLANT}/upload?dry_run=1",
                       files={"file": ("f.xlsx", data)}).status_code == 413


def test_parser_strips_leading_apostrophe_and_handles_text_numbers_and_floats():
    rows = [{"tool_id": "'=T1", "total_qty": "3", "out_of_service_qty": 1.0, "note": "'-x"},
            {"tool_id": 77.0, "total_qty": 2, "out_of_service_qty": None, "note": None}]
    ups, rej = ti.parse_tool_inventory_rows(rows, PLANT, first_row=2)
    assert not rej
    assert ups[0] == {"plant": PLANT, "tool_id": "=T1", "total_qty": 3, "out_of_service_qty": 1, "note": "-x"}
    assert ups[1]["tool_id"] == "77"


# --- template / export -------------------------------------------------------------------------------
def test_template_round_trips_into_upload_and_export_is_no_store(client, known_plant, monkeypatch):
    monkeypatch.setattr(md, "load_tool_inventory_rows", lambda p: CURRENT)
    monkeypatch.setattr(db, "tool_ids_in_use", lambda p, include_material_plants=False: ["T1", "T7", "=EVIL"])
    r = client.get(f"/tool-inventory/{PLANT}/template.xlsx")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    wb = load_workbook(io.BytesIO(r.content))
    assert wb.sheetnames == ["Tool Inventory", "How to use"]  # data sheet FIRST
    assert [c.value for c in wb["Tool Inventory"][1]] == ["Tool ID", "Total Inventory", "Out of Service", "Note"]
    ups, rej, _w, n = ti.parse_tool_inventory_excel(r.content, PLANT)
    assert not rej and n == 5
    by_id = {u["tool_id"]: u for u in ups}
    assert by_id["T7"]["note"] == ti.NO_ROW_NOTE and by_id["T7"]["total_qty"] == 1
    assert by_id["=EVIL"]["tool_id"] == "=EVIL"  # apostrophe guard stripped on re-import
    assert by_id["T9"]["note"] == "left alone" and by_id["T1"]["total_qty"] == 2  # current rows win
    raw_cells = [c.value for c in wb["Tool Inventory"]["A"]]
    assert "'=EVIL" in raw_cells  # guarded in the file itself

    e = client.get(f"/tool-inventory/{PLANT}/export.xlsx")
    assert e.status_code == 200 and e.headers["cache-control"] == "no-store"
    assert load_workbook(io.BytesIO(e.content)).sheetnames == ["Tool Inventory"]
    assert ti.parse_tool_inventory_excel(e.content, PLANT)[0] == [
        {"plant": PLANT, **r_} for r_ in CURRENT]


# --- usage -------------------------------------------------------------------------------------------
def test_usage_route_returns_counts_and_orders(client, known_plant, monkeypatch):
    monkeypatch.setattr(db, "tool_usage_counts",
                        lambda plant, ids: {t: {"count": 2, "orders": ["A", "B"]} for t in ids})
    r = client.post(f"/tool-inventory/{PLANT}/usage", json={"tool_ids": ["T1", "T2"]})
    assert r.status_code == 200 and r.json() == {"T1": {"count": 2, "orders": ["A", "B"]},
                                                 "T2": {"count": 2, "orders": ["A", "B"]}}


def test_usage_sql_reads_both_prt_columns_with_the_same_normalisation(monkeypatch):
    seen = {}

    class Cur:
        def execute(self, q, params=None):
            seen["q"], seen["params"] = q, params

        def fetchall(self):
            return [("T1", 3, ["10", "11", "12"])]

    monkeypatch.setattr(db, "_pool", _Pool(Cur()))
    out = db.tool_usage_counts(PLANT, [" t1 ", "T2", "t1"])
    assert "o.prt_01" in seen["q"] and "o.prt_02" in seen["q"] and "UPPER(BTRIM" in seen["q"]
    assert "o.plant IS NULL" in seen["q"]  # NULL-plant orders attributed through the plant's machines
    assert seen["params"][-1] == ["T1", "T2"]
    assert out == {"T1": {"count": 3, "orders": ["10", "11", "12"]}, "T2": {"count": 0, "orders": []}}


# --- Order Rule setter ---------------------------------------------------------------------------------
@pytest.mark.parametrize("bad", ["", "Hard", " hard", "on", "soft", None, True, 1])
def test_tooling_rule_is_a_strict_enum(bad):
    with pytest.raises(ValueError):
        md.set_plant_tooling_rule("", PLANT, bad)


def test_tooling_rule_merges_jsonb_and_audits(monkeypatch):
    cur = _Cur()
    monkeypatch.setattr(md, "_pool", _Pool(cur))
    out = md.set_plant_tooling_rule("SN", PLANT, "hard", "a@example.com")
    assert out == {"status": "ok", "plant": PLANT, "setup_policy_config": {"toolingRule": "hard", "version": 2}}
    update_sql, params = cur.calls[0]
    assert "setup_policy_config = setup_policy_config || %s" in update_sql  # merge, not replace
    assert params[0].obj == {"toolingRule": "hard", "version": 2} and params[1:] == [PLANT, "SN"]
    audit = cur.calls[1]
    assert "'set_tooling_rule'" in audit[0] and audit[1][1] == "a@example.com"


def test_tooling_rule_unknown_plant_raises(monkeypatch):
    cur = _Cur()
    cur.rowcount = 0
    monkeypatch.setattr(md, "_pool", _Pool(cur))
    with pytest.raises(ValueError, match="not found"):
        md.set_plant_tooling_rule("", PLANT, "off")


def test_tooling_rule_route_is_planner_level_not_admin(client, known_plant, monkeypatch):
    route = next(r for r in iter_route_contexts(brain.api.routes)
                 if getattr(r, "path", None) == "/master-data/plants/{plant}/tooling-rule")
    names = {d.call.__name__ for d in route.dependant.dependencies}
    assert "require_admin" not in names and "require_authenticated" in names
    monkeypatch.setattr(md, "set_plant_tooling_rule",
                        lambda subnetwork, plant, rule, user_email=None: {
                            "status": "ok", "plant": plant, "setup_policy_config": {"toolingRule": rule, "version": 2}})
    r = client.post(f"/master-data/plants/{PLANT}/tooling-rule", json={"tooling_rule": "hard"})
    assert r.status_code == 200 and r.json()["setup_policy_config"]["toolingRule"] == "hard"


# --- real Postgres ---------------------------------------------------------------------------------------
@pytest.mark.pg
def test_pg_ensure_hook_bulk_round_trip_and_constraints(pg):
    md.ensure_tool_inventory_table()
    md.ensure_tool_inventory_table()  # idempotent
    plant = "ZZTEST_TI_PG"
    try:
        res = md.bulk_apply("tool_inventory", {"plant": plant, "upserts": [_row(tool_id="t1", total_qty=2)]})
        assert res["inserted"] == 1
        rows = md.load_tool_inventory_rows(plant)
        assert rows == [{"tool_id": "T1", "total_qty": 2, "out_of_service_qty": 0, "note": None}]
        listed = md.list_rows("tool_inventory", plant=plant)
        assert {c["column_name"] for c in listed["columns"]} >= {"tool_id", "total_qty", "out_of_service_qty", "note"}
        # typo fix = remove + re-add in one save
        md.bulk_apply("tool_inventory", {"plant": plant, "deletes": [{"tool_id": "T1"}],
                                         "upserts": [_row(tool_id="T10", total_qty=2)]})
        assert [r["tool_id"] for r in md.load_tool_inventory_rows(plant)] == ["T10"]
        # DB-level CHECK still guards direct writes
        with pytest.raises(psycopg.errors.CheckViolation), db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO tool_inventory (plant, tool_id, total_qty, out_of_service_qty)"
                        " VALUES (%s, 'X', 1, 2)", (plant,))
    finally:
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM tool_inventory WHERE plant = %s", (plant,))
            conn.commit()


@pytest.mark.pg
def test_pg_usage_counts_cover_both_columns(pg):
    plant, mach = "ZZTEST_TI_PG2", "ZZTI_MACH"
    with db._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO orders (id, production_order, material_number, machine, plant, prt_01, prt_02)"
                    " VALUES ('zzti1','ZZ1','m',%s,%s,' t1 ','T2'), ('zzti2','ZZ2','m',%s,%s,'T3','t1'),"
                    " ('zzti3','ZZ3','m',%s,%s,'T1','T1')", (mach, plant, mach, plant, mach, plant))
        conn.commit()
    try:
        out = db.tool_usage_counts(plant, ["T1", "T2", "T9"])
        assert out["T1"]["count"] == 3 and out["T1"]["orders"] == ["ZZ1", "ZZ2", "ZZ3"]  # both columns; same order once
        assert out["T2"]["count"] == 1 and out["T9"]["count"] == 0
        assert db.tool_ids_in_use(plant) == ["T1", "T2", "T3"]
    finally:
        with db._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id IN ('zzti1','zzti2','zzti3')")
            conn.commit()
