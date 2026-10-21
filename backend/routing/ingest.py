"""
NIMBUS 2.0 -- Routing / Production Version Excel ingest
(ROUTING_RUNTIME_DESIGN.md §6.1).

Parses+validates+groups only -- the actual DELETE+INSERT / upsert
transaction logic lives in routes.py (§6.2), not here, so this module never
opens a write transaction; it only reads reference tables (plants,
material_plants, sap_workcenter) to validate foreign references before a
row is accepted.

`_zero_pad` is intentionally LOCAL to this file, not lifted into db.py's own
`clean`/`_str_id` helpers: `backend/distribution/data.py`/db.py's own ingest
code doesn't need a routing-specific code-padding helper, and db.py never
imports `backend.*` at module scope (see db.py's own comment beside its
`plan_fn`/`apply_fn` seam, and backend/CLAUDE.md's "db.py and master_data.py
are intentionally NOT split into backend/<domain>/" note) -- a shared home
for this one padding helper isn't worth breaking that one-way-import
convention for.
"""
import datetime
import io
import re

import pandas as pd

import db

# ---------------------------------------------------------------------------
# Header -> column maps (ROUTING_RUNTIME_DESIGN.md §6.1). Headers are
# normalized with db.clean() (upper, spaces -> underscores) before matching.
# Unknown headers are ignored, with a warning listing them.
# ---------------------------------------------------------------------------
PRODUCTION_VERSION_HEADERS: dict[str, str] = {
    "PLANT": "plant",
    "MATERIAL_ID": "material_id",
    "PRODUCTION_VERSION": "production_version",
    "VALID_FROM": "valid_from",
    "VALID_TO": "valid_to",
    "ALTERNATE_BOM": "alternative_bom",  # the one header that doesn't match its column name verbatim
    "BOM_USAGE": "bom_usage",
    "TASK_LIST_TYPE": "task_list_type",
    "ROUTING_GROUP": "routing_group",
    "GROUP_COUNTER": "group_counter",
    "PROCUREMENT_TYPE": "procurement_type",
    "SPECIAL_PROCUREMENT_TYPE": "special_procurement_type",
    "COSTING_LOT_SIZE": "costing_lot_size",
    "SAP_WORKCENTER": "sap_workcenter",
    "PRODUCTION_VERSION_TEXT": "production_version_text",
    "REPETITIVE_MFG": "repetitive_mfg",
    "LOT_SIZE_FROM": "lot_size_from",
    "LOT_SIZE_TO": "lot_size_to",
}
PRODUCTION_VERSION_KEY_HEADERS = ("PLANT", "MATERIAL_ID", "PRODUCTION_VERSION")
PRODUCTION_VERSION_NUMERIC = frozenset({"costing_lot_size", "lot_size_from", "lot_size_to"})
PRODUCTION_VERSION_BOOLEAN = frozenset({"repetitive_mfg"})
# Zero-padded per §4 item 3: production version (4), group counter (2).
PRODUCTION_VERSION_ZERO_PAD = {"production_version": 4, "group_counter": 2}

ROUTING_OPERATION_HEADERS: dict[str, str] = {
    "PLANT": "plant",
    "MATERIAL_ID": "material_id",
    "TASK_LIST_TYPE": "task_list_type",
    "ROUTING_GROUP": "routing_group",
    "GROUP_COUNTER": "group_counter",
    "SEQUENCE_NO": "sequence_no",
    "ACTIVITY": "activity",
    "SAP_WORKCENTER": "sap_workcenter",
    "WORKCENTER_CATEGORY": "workcenter_category",
    "BASE_QUANTITY": "base_quantity",
    "CONTROL_KEY": "control_key",
    "OPERATION_TEXT": "operation_text",
    "OPERATION_UNIT": "operation_unit",
    "ACTIVITY_TYPE_MACHINE": "activity_type_machine",
    "STD_VALUE_MACHINE": "std_value_machine",
    "STD_VALUE_UNIT_MACHINE": "std_value_unit_machine",
    "ACTIVITY_TYPE_LABOR": "activity_type_labor",
    "STD_VALUE_LABOR": "std_value_labor",
    "STD_VALUE_UNIT_LABOR": "std_value_unit_labor",
    "REQUIRED_OVERLAP": "required_overlap",
    "OPTIONAL_OVERLAP": "optional_overlap",
    "REQUIRED_SPLIT": "required_split",
    "FIELD_KEY": "field_key",
    "NUM_SPLITS": "num_splits",
    "TASK_LIST_TEXT": "task_list_text",
    "SEQUENCE_CATEGORY": "sequence_category",
    "SEQUENCE_TEXT": "sequence_text",
    "NUM_EMPLOYEES": "num_employees",
    "SETUP_GROUP_CATEGORY": "setup_group_category",
    "SETUP_GROUP_KEY": "setup_group_key",
    "DELETED": "deleted",
    "HEADER_STATUS": "header_status",
    "HEADER_VALID_FROM": "header_valid_from",
    "HEADER_VALID_TO": "header_valid_to",
}
ROUTING_OPERATION_KEY_HEADERS = (
    "PLANT", "MATERIAL_ID", "TASK_LIST_TYPE", "ROUTING_GROUP",
    "GROUP_COUNTER", "SEQUENCE_NO", "ACTIVITY",
)
ROUTING_OPERATION_NUMERIC = frozenset({"base_quantity", "std_value_machine", "std_value_labor", "num_employees"})
ROUTING_OPERATION_INTEGER = frozenset({"num_splits"})
ROUTING_OPERATION_BOOLEAN = frozenset({"deleted", "required_overlap", "optional_overlap", "required_split"})
# Zero-padded per §4 item 3: operation/activity number (4), sequence (6),
# group counter (2, same rule as production_version's).
ROUTING_OPERATION_ZERO_PAD = {"activity": 4, "sequence_no": 6, "group_counter": 2}

_TRUTHY = frozenset({"X", "TRUE", "1", "YES", "Y", "T"})
_MAX_LISTED_WARNINGS = 50


def _zero_pad(value, width: int) -> str:
    """Left-pad a routing/production-version code column to `width`
    characters with '0' so a spreadsheet's numeric coercion (which drops
    leading zeros, e.g. group_counter '01' -> 1) never creates a mismatched
    key (ROUTING_RUNTIME_DESIGN.md §4 item 3). Strips the Excel float
    suffix first ('1.0' -> '1'), same shape as db._str_id but kept local to
    this file (see module docstring)."""
    if value is None:
        return ""
    s = str(value).strip()
    if s.endswith(".0") and s[:-2].lstrip("-").isdigit():
        s = s[:-2]
    if not s or s.lower() == "nan":
        return ""
    return s.zfill(width)


def _clean_str(value) -> str:
    """Blank-safe stringify for a plain-text cell -- NaN/None -> ''."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    s = str(value).strip()
    return "" if s.lower() == "nan" else s


_ISO_DATE_RE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$")
_US_DATE_RE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")


def normalize_date_cell(value) -> str | None:
    """A pasted date cell -> 'YYYY-MM-DD' (None for a blank cell). Accepts ISO
    (a trailing time part is dropped), M/D/YYYY and MM/DD/YYYY, and date/
    datetime objects; raises ValueError for anything else or an impossible
    calendar date (02/30/2026). Pure calendar arithmetic, no timezone."""
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.strftime("%Y-%m-%d")
    s = _clean_str(value)
    if not s:
        return None
    m = _ISO_DATE_RE.match(s)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    else:
        m = _US_DATE_RE.match(s)
        if not m:
            raise ValueError(f"{s!r} is not a valid date (use MM/DD/YYYY)")
        mo, d, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try:
        return datetime.date(y, mo, d).isoformat()
    except ValueError:
        raise ValueError(f"{s!r} is not a valid date (use MM/DD/YYYY)") from None


def _to_bool(value) -> bool:
    """Lenient SAP-flag-style boolean read: 'X'/'TRUE'/'1'/'YES'/'Y'/'T'
    (case-insensitive) -> True; blank or anything else -> False. Every
    destination boolean column here is NOT NULL DEFAULT FALSE, so a blank
    cell correctly defaults to False rather than NULL."""
    s = _clean_str(value).upper()
    return s in _TRUTHY


def _to_numeric(value, field: str) -> float | None:
    """Blank -> None; otherwise a parseable number, else raises ValueError
    naming the offending field (caller turns this into a per-row reject,
    never a whole-file failure -- ROUTING_RUNTIME_DESIGN.md §6.1)."""
    s = _clean_str(value)
    if not s:
        return None
    try:
        return float(s)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field!r} is not a valid number: {value!r}") from exc


def _to_int(value, field: str) -> int | None:
    s = _clean_str(value)
    if not s:
        return None
    try:
        return int(float(s))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field!r} is not a valid integer: {value!r}") from exc


def _read_excel(file_bytes: bytes) -> pd.DataFrame:
    df = pd.read_excel(io.BytesIO(file_bytes))
    return db.clean(df)


def _known_plants(cur, plants: set[str]) -> set[str]:
    if not plants:
        return set()
    cur.execute("SELECT plant FROM plants WHERE plant = ANY(%s)", (list(plants),))
    return {r[0] for r in cur.fetchall()}


def _known_material_plants(cur, pairs: set[tuple[str, str]]) -> set[tuple[str, str]]:
    if not pairs:
        return set()
    plant_list = [p for p, _ in pairs]
    material_list = [m for _, m in pairs]
    cur.execute(
        "SELECT plant, material_id FROM material_plants"
        " WHERE (plant, material_id) IN ("
        "   SELECT * FROM UNNEST(%s::text[], %s::text[])"
        " )",
        (plant_list, material_list),
    )
    return {(r[0], r[1]) for r in cur.fetchall()}


def _known_workcenters(cur, pairs: set[tuple[str, str]]) -> set[tuple[str, str]]:
    if not pairs:
        return set()
    plant_list = [p for p, _ in pairs]
    wc_list = [w for _, w in pairs]
    cur.execute(
        "SELECT plant, sap_workcenter FROM sap_workcenter"
        " WHERE (plant, sap_workcenter) IN ("
        "   SELECT * FROM UNNEST(%s::text[], %s::text[])"
        " )",
        (plant_list, wc_list),
    )
    return {(r[0], r[1]) for r in cur.fetchall()}


def _reference_check(row: dict, known_plants: set, known_mp: set, known_wc: set) -> str | None:
    """Returns a rejection reason code, or None if every populated reference
    on this row is known to NIMBUS (ROUTING_RUNTIME_DESIGN.md §6.1/D9)."""
    plant = row.get("plant")
    material_id = row.get("material_id")
    if plant not in known_plants:
        return "unknown_plant"
    if (plant, material_id) not in known_mp:
        return "unknown_material"
    wc = row.get("sap_workcenter")
    if wc and (plant, wc) not in known_wc:
        return "unknown_workcenter"
    return None


def _read_excel_rows(file_bytes: bytes, header_map: dict[str, str],
                     key_headers: tuple[str, ...]) -> tuple[list[dict], list[dict]]:
    """Excel adapter half of the `parse_*_upload` functions: read the sheet,
    require the key headers (ValueError otherwise), map template headers to
    NIMBUS column names, and return `(rows, prefix_warnings)` where the
    warnings hold the unknown-header notice, if any. Only headers present in
    the sheet produce keys, so a row never carries a column the sheet lacked."""
    df = _read_excel(file_bytes)
    headers_present = set(df.columns)
    missing_required = [h for h in key_headers if h not in headers_present]
    if missing_required:
        raise ValueError(f"Missing required column(s): {', '.join(missing_required)}")
    return map_row_keys(df.to_dict("records"), header_map)


def _normalize_header(key) -> str:
    """Same rule as `db.clean()` applies to a DataFrame's column names:
    strip, upper-case, each space -> underscore."""
    return str(key).strip().upper().replace(" ", "_")


def map_row_keys(rows: list[dict], header_map: dict[str, str]) -> tuple[list[dict], list[dict]]:
    """Map each row's keys to NIMBUS column names, shared by the Excel adapter
    and the paste/validate route. A key is normalised like `db.clean()` and
    looked up in `header_map` (template header -> column); failing that it is
    accepted when its lower-case form is already a NIMBUS column name; any
    other key is dropped. Returns `(mapped_rows, warnings)` where `warnings`
    holds one unknown-header notice naming every dropped key across all rows."""
    columns = frozenset(header_map.values())
    resolved: dict = {}
    unknown: set[str] = set()
    for row in rows:
        for key in row:
            if key in resolved:
                continue
            norm = _normalize_header(key)
            if norm in header_map:
                resolved[key] = header_map[norm]
            elif norm.lower() in columns:
                resolved[key] = norm.lower()
            else:
                resolved[key] = None
                unknown.add(norm)
    mapped = [
        {resolved[key]: value for key, value in row.items() if resolved[key] is not None}
        for row in rows
    ]
    warnings: list[dict] = []
    unk = _unknown_headers_warning(unknown, {})
    if unk:
        warnings.append(unk)
    return mapped, warnings


def _unknown_headers_warning(headers_present: set[str], header_map: dict[str, str]) -> dict | None:
    unknown = sorted(h for h in headers_present if h not in header_map)
    if not unknown:
        return None
    return {"level": "warn", "msg": f"Unknown column(s) ignored: {', '.join(unknown)}"}


def parse_production_versions_upload(file_bytes: bytes, conn=None) -> tuple[dict, list[dict]]:
    """Parse a production_version Excel upload into `md.bulk_apply`'s
    `{"upserts": [...], "deletes": []}` shape, plus a list of warnings
    (unknown headers, then up to `_MAX_LISTED_WARNINGS` per-row rejections).

    Validation order per row (ROUTING_RUNTIME_DESIGN.md §6.1): missing PK
    value -> `missing_key`; unparseable numeric field -> `invalid_numeric_
    value`; unknown plant/material/work center -> `unknown_plant`/
    `unknown_material`/`unknown_workcenter`; duplicate key within this file
    -> `duplicate_key`. A rejected row is never included in `upserts` --
    rejection is per-row, never a whole-file failure.
    """
    rows, prefix_warnings = _read_excel_rows(
        file_bytes, PRODUCTION_VERSION_HEADERS, PRODUCTION_VERSION_KEY_HEADERS)
    return parse_production_versions_rows(rows, conn=conn, prefix_warnings=prefix_warnings)


def parse_production_versions_rows(rows: list[dict], conn=None, *, first_row: int = 2,
                                   prefix_warnings: list[dict] | None = None) -> tuple[dict, list[dict]]:
    """Validate already-normalised production_version rows (dicts keyed by
    the NIMBUS column names -- `plant`, `material_id`, `production_version`,
    ...) and return exactly what `parse_production_versions_upload` returns:
    `{"upserts": [...], "deletes": []}` plus warnings. Every validation
    (missing key, numeric/boolean parsing, zero-padding, unknown plant /
    material / work center, duplicate key) lives here so a non-Excel caller
    (the SAP staging path) gets identical behaviour. Keys outside the known
    production_version columns are ignored. `first_row` is the number
    reported for the first row in rejection warnings (2 for Excel: header is
    row 1); `prefix_warnings` are file-level warnings listed before the
    per-row ones (the Excel adapter's unknown-header notice)."""
    warnings: list[dict] = list(prefix_warnings or [])
    known_cols = frozenset(PRODUCTION_VERSION_HEADERS.values())

    # Pass 1: build candidate rows, coercing/validating in isolation (no DB
    # round trip yet) so the reference pre-fetch below only ever needs to
    # cover rows that already passed key-presence/numeric validation.
    candidates: list[tuple[int, dict]] = []
    rejected = 0
    for i, record in enumerate(rows, start=first_row):
        row: dict = {c: record[c] for c in known_cols if c in record}

        plant = _clean_str(row.get("plant"))
        material_id = db._str_id(row.get("material_id"))
        production_version = _zero_pad(row.get("production_version"),
                                       PRODUCTION_VERSION_ZERO_PAD["production_version"])
        if not plant or not material_id or not production_version:
            warnings.append({"level": "reject", "msg": "missing_key: plant/material_id/production_version required", "row": i})
            rejected += 1
            continue

        try:
            for col in PRODUCTION_VERSION_NUMERIC:
                if col in row:
                    row[col] = _to_numeric(row[col], col)
        except ValueError as exc:
            warnings.append({"level": "reject", "msg": f"invalid_numeric_value: {exc}", "row": i})
            rejected += 1
            continue

        for col in PRODUCTION_VERSION_BOOLEAN:
            if col in row:
                row[col] = _to_bool(row[col])
        if "group_counter" in row:
            row["group_counter"] = _zero_pad(row["group_counter"], PRODUCTION_VERSION_ZERO_PAD["group_counter"])
        for col in ("valid_from", "valid_to"):
            if col in row:
                row[col] = _clean_str(row[col]) or None
        for col in ("task_list_type", "routing_group", "alternative_bom", "bom_usage",
                    "procurement_type", "special_procurement_type", "sap_workcenter",
                    "production_version_text"):
            if col in row:
                row[col] = _clean_str(row[col]) or None

        row["plant"] = plant
        row["material_id"] = material_id
        row["production_version"] = production_version
        candidates.append((i, row))

    # Pass 2: one round trip to learn which (plant), (plant, material_id),
    # (plant, sap_workcenter) references are real, then reference-check and
    # duplicate-check every candidate against that set.
    plants_needed = {r["plant"] for _, r in candidates}
    mp_needed = {(r["plant"], r["material_id"]) for _, r in candidates}
    wc_needed = {(r["plant"], r["sap_workcenter"]) for _, r in candidates if r.get("sap_workcenter")}

    def _run(cur):
        return _known_plants(cur, plants_needed), _known_material_plants(cur, mp_needed), _known_workcenters(cur, wc_needed)

    if conn is not None:
        with conn.cursor() as cur:
            known_plants, known_mp, known_wc = _run(cur)
    else:
        with db._pool.connection() as owned_conn, owned_conn.cursor() as cur:
            known_plants, known_mp, known_wc = _run(cur)

    seen_keys: set[tuple] = set()
    upserts: list[dict] = []
    for i, row in candidates:
        reason = _reference_check(row, known_plants, known_mp, known_wc)
        if reason:
            warnings.append({"level": "reject", "msg": f"{reason}: row references data not known to NIMBUS", "row": i})
            rejected += 1
            continue
        key = (row["plant"], row["material_id"], row["production_version"])
        if key in seen_keys:
            warnings.append({"level": "reject", "msg": "duplicate_key: repeats an earlier row's key", "row": i})
            rejected += 1
            continue
        seen_keys.add(key)
        upserts.append(row)

    if len(warnings) > _MAX_LISTED_WARNINGS:
        warnings = warnings[:_MAX_LISTED_WARNINGS] + [
            {"level": "warn", "msg": f"...and {len(warnings) - _MAX_LISTED_WARNINGS} more finding(s), truncated"}
        ]

    return {"upserts": upserts, "deletes": []}, warnings


def parse_routing_operations_upload(file_bytes: bytes, conn=None) -> tuple[dict[tuple, list[dict]], list[dict]]:
    """Parse a routing_operation Excel upload, grouped by the routing key
    `(plant, material_id, task_list_type, routing_group, group_counter)` for
    the scoped-replace transaction routes.py performs (ROUTING_RUNTIME_
    DESIGN.md §6.2) -- this function only parses+validates+groups; the
    actual DELETE+INSERT belongs to routes.py.

    A row whose DELETED flag is set is skipped entirely (never stored, never
    counted as rejected) -- D10/§6.1: it could never count toward run time
    anyway, and `deleted` stays an ordinary admin-editable column for a
    planner to flag directly in the grid later.
    """
    rows, prefix_warnings = _read_excel_rows(
        file_bytes, ROUTING_OPERATION_HEADERS, ROUTING_OPERATION_KEY_HEADERS)
    return parse_routing_operations_rows(rows, conn=conn, prefix_warnings=prefix_warnings)


def parse_routing_operations_rows(rows: list[dict], conn=None, *, first_row: int = 2,
                                  prefix_warnings: list[dict] | None = None
                                  ) -> tuple[dict[tuple, list[dict]], list[dict]]:
    """Validate already-normalised routing_operation rows (dicts keyed by the
    NIMBUS column names) and return exactly what
    `parse_routing_operations_upload` returns: rows grouped by routing key
    `(plant, material_id, task_list_type, routing_group, group_counter)`
    plus warnings. All validation (DELETED skip, missing key, numeric /
    integer / boolean parsing, zero-padding, unknown plant / material / work
    center, duplicate full key) lives here so a non-Excel caller gets
    identical behaviour. Keys outside the known routing_operation columns
    are ignored; `first_row`/`prefix_warnings` as in
    `parse_production_versions_rows`."""
    warnings: list[dict] = list(prefix_warnings or [])
    known_cols = frozenset(ROUTING_OPERATION_HEADERS.values())

    candidates: list[tuple[int, dict]] = []
    rejected = 0
    skipped_deleted = 0
    for i, record in enumerate(rows, start=first_row):
        row: dict = {c: record[c] for c in known_cols if c in record}

        if "deleted" in row and _to_bool(row["deleted"]):
            skipped_deleted += 1
            continue

        plant = _clean_str(row.get("plant"))
        material_id = db._str_id(row.get("material_id"))
        task_list_type = _clean_str(row.get("task_list_type"))
        routing_group = _clean_str(row.get("routing_group"))
        group_counter = _zero_pad(row.get("group_counter"), ROUTING_OPERATION_ZERO_PAD["group_counter"])
        sequence_no = _zero_pad(row.get("sequence_no"), ROUTING_OPERATION_ZERO_PAD["sequence_no"])
        activity = _zero_pad(row.get("activity"), ROUTING_OPERATION_ZERO_PAD["activity"])
        if not (plant and material_id and task_list_type and routing_group
                and group_counter and sequence_no and activity):
            warnings.append({"level": "reject", "msg": "missing_key: plant/material_id/task_list_type/"
                                                       "routing_group/group_counter/sequence_no/activity required",
                             "row": i})
            rejected += 1
            continue

        try:
            for col in ROUTING_OPERATION_NUMERIC:
                if col in row:
                    row[col] = _to_numeric(row[col], col)
            for col in ROUTING_OPERATION_INTEGER:
                if col in row:
                    row[col] = _to_int(row[col], col)
        except ValueError as exc:
            warnings.append({"level": "reject", "msg": f"invalid_numeric_value: {exc}", "row": i})
            rejected += 1
            continue

        for col in ROUTING_OPERATION_BOOLEAN:
            if col in row:
                row[col] = _to_bool(row[col])
        for col in ("header_valid_from", "header_valid_to"):
            if col in row:
                row[col] = _clean_str(row[col]) or None
        for col in ("sap_workcenter", "workcenter_category", "control_key", "operation_text",
                    "operation_unit", "activity_type_machine", "std_value_unit_machine",
                    "activity_type_labor", "std_value_unit_labor", "field_key", "task_list_text",
                    "sequence_category", "sequence_text", "setup_group_category", "setup_group_key",
                    "header_status"):
            if col in row:
                row[col] = _clean_str(row[col]) or None
        if not row.get("sequence_category"):
            row["sequence_category"] = "0"

        row["plant"] = plant
        row["material_id"] = material_id
        row["task_list_type"] = task_list_type
        row["routing_group"] = routing_group
        row["group_counter"] = group_counter
        row["sequence_no"] = sequence_no
        row["activity"] = activity
        candidates.append((i, row))

    plants_needed = {r["plant"] for _, r in candidates}
    mp_needed = {(r["plant"], r["material_id"]) for _, r in candidates}
    wc_needed = {(r["plant"], r["sap_workcenter"]) for _, r in candidates if r.get("sap_workcenter")}

    def _run(cur):
        return _known_plants(cur, plants_needed), _known_material_plants(cur, mp_needed), _known_workcenters(cur, wc_needed)

    if conn is not None:
        with conn.cursor() as cur:
            known_plants, known_mp, known_wc = _run(cur)
    else:
        with db._pool.connection() as owned_conn, owned_conn.cursor() as cur:
            known_plants, known_mp, known_wc = _run(cur)

    seen_keys: set[tuple] = set()
    groups: dict[tuple, list[dict]] = {}
    for i, row in candidates:
        reason = _reference_check(row, known_plants, known_mp, known_wc)
        if reason:
            warnings.append({"level": "reject", "msg": f"{reason}: row references data not known to NIMBUS", "row": i})
            rejected += 1
            continue
        full_key = (row["plant"], row["material_id"], row["task_list_type"], row["routing_group"],
                   row["group_counter"], row["sequence_no"], row["activity"])
        if full_key in seen_keys:
            warnings.append({"level": "reject", "msg": "duplicate_key: repeats an earlier row's key", "row": i})
            rejected += 1
            continue
        seen_keys.add(full_key)
        routing_key = (row["plant"], row["material_id"], row["task_list_type"],
                      row["routing_group"], row["group_counter"])
        groups.setdefault(routing_key, []).append(row)

    if skipped_deleted:
        warnings.append({"level": "info", "msg": f"{skipped_deleted} row(s) skipped: DELETED flag set"})
    if len(warnings) > _MAX_LISTED_WARNINGS:
        warnings = warnings[:_MAX_LISTED_WARNINGS] + [
            {"level": "warn", "msg": f"...and {len(warnings) - _MAX_LISTED_WARNINGS} more finding(s), truncated"}
        ]

    return groups, warnings
