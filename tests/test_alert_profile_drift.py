"""Drift guards (static, no DB): server ALERT_TYPES vs the frontend, and the runtime DDL vs schema.sql."""
import inspect
import re
from pathlib import Path

from backend.alert_profiles import data as ap

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_PROFILES = ROOT / "frontend" / "insights" / "alert-profiles.mts"
SCHEMA_SQL = ROOT / "schema.sql"

# AlertType members that exist in the frontend union but never fire (FIRING_ALERT_TYPES filters them out).
NEVER_FIRING = {"near-capacity", "line_no_calendar"}


def _frontend_firing_types() -> set[str]:
    """FIRING_ALERT_TYPES is derived (`Object.values(ALERT_CATEGORIES).flat().filter(...)`), so rebuild it from the
    ALERT_CATEGORIES literal and the filter's excluded names, and assert the derivation is still what we assume."""
    src = FRONTEND_PROFILES.read_text(encoding="utf-8")
    block = re.search(r"export const ALERT_CATEGORIES[^=]*=\s*\{(.*?)\n\};", src, re.S)
    assert block, "ALERT_CATEGORIES literal not found"
    types = set(re.findall(r"'([A-Za-z_-]+)'", block.group(1)))
    fire = re.search(r"export const FIRING_ALERT_TYPES[^=]*=\s*(.*?);", src, re.S)
    assert fire, "FIRING_ALERT_TYPES not found"
    assert "Object.values(ALERT_CATEGORIES).flat()" in fire.group(1), "FIRING_ALERT_TYPES is no longer derived from ALERT_CATEGORIES"
    assert set(re.findall(r"t !== '([A-Za-z_-]+)'", fire.group(1))) == NEVER_FIRING
    return types - NEVER_FIRING


def test_alert_types_match_the_frontend_firing_types():
    assert _frontend_firing_types() == set(ap.ALERT_TYPES)


# --------------------------------------------------------------------------- DDL parity

def _balanced(text: str, open_idx: int) -> str:
    """The text between the parenthesis at `open_idx` and its match."""
    depth = 0
    for i in range(open_idx, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return text[open_idx + 1:i]
    raise AssertionError("unbalanced parentheses")


def _split_top_level(body: str) -> list[str]:
    parts, depth, cur = [], 0, []
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    parts.append("".join(cur))
    return [p.strip() for p in parts if p.strip()]


def _columns(sql: str) -> dict[str, set[str]]:
    """{table: column names} from CREATE TABLE IF NOT EXISTS blocks plus ALTER TABLE ... ADD COLUMN IF NOT EXISTS."""
    out: dict[str, set[str]] = {}
    for m in re.finditer(r"CREATE TABLE IF NOT EXISTS (alert_profile|alert_ack)\s*\(", sql):
        cols = out.setdefault(m.group(1), set())
        for item in _split_top_level(_balanced(sql, m.end() - 1)):
            word = item.split()[0].upper()
            if word not in ("CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"):
                cols.add(item.split()[0].lower())
    for m in re.finditer(r"ALTER TABLE (alert_profile|alert_ack) ADD COLUMN IF NOT EXISTS (\w+)", sql):
        out.setdefault(m.group(1), set()).add(m.group(2).lower())
    return out


def test_runtime_ddl_columns_match_schema_sql():
    runtime = _columns(inspect.getsource(ap.ensure_alert_profile_tables))
    schema = _columns(SCHEMA_SQL.read_text(encoding="utf-8"))
    assert set(runtime) == {"alert_profile", "alert_ack"} == set(schema)
    for table in runtime:
        assert runtime[table] == schema[table], f"{table}: runtime DDL and schema.sql columns differ"
    # sanity: the parser really saw the table definitions, not an empty set on both sides
    assert {"id", "plant", "rules", "categories", "gantt_colors", "show_acknowledged"} <= runtime["alert_profile"]
    assert {"plant", "alert_id", "acknowledged_by", "reason", "until", "created_at"} == runtime["alert_ack"]
