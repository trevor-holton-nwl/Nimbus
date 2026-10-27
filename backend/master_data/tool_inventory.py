"""
NIMBUS -- Tool Inventory Excel round trip (parser, review diff, workbook builders).

The per-plant `tool_inventory` table says how many physical copies of each tool id
(PRT 1 / PRT 2) a plant owns. This module is the Excel half of the planner write
path: `parse_tool_inventory_rows` turns sheet rows into the clean shape
`master_data.bulk_apply` writes, `diff_tool_inventory` produces the "review changes"
summary (new / changed old -> new / unchanged) that `dry_run=1` returns, and the two
workbook builders back the template and export downloads. Parsing reuses
`backend/routing/ingest.py`'s sheet reader and header mapper; every per-row rule
(normalisation, strict quantities, duplicates) is the ONE shared validator in
`master_data.py`, so a row means the same thing from Excel, the grid and the admin
path. Nothing here opens a write transaction.

Uploads are upsert-only: a tool missing from the file is left untouched.
"""
import io
import os

from openpyxl import Workbook

import db
import master_data as md
from backend.csv_util import csv_cell
from backend.routing import ingest

# Same knob (and default) as backend/routing/routes.py's upload cap.
MAX_UPLOAD_BYTES = int(os.environ.get("NIMBUS_MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
MAX_UPLOAD_ROWS = md.MAX_TOOL_INVENTORY_OPS
# dry_run result lists are capped so a huge file cannot balloon the review payload.
REVIEW_LIST_CAP = 200
_MAX_LISTED_WARNINGS = 50

# Template header (db.clean-normalised: upper, spaces -> underscores) -> column. English in
# every locale on purpose: the parser matches these, so a translated header would break it.
TOOL_INVENTORY_HEADERS: dict[str, str] = {
    "PLANT": "plant",
    "TOOL_ID": "tool_id",
    "TOTAL_INVENTORY": "total_qty",
    "TOTAL_QTY": "total_qty",
    "OUT_OF_SERVICE": "out_of_service_qty",
    "OUT_OF_SERVICE_QTY": "out_of_service_qty",
    "NOTE": "note",
}
# Each required column may be spelled either way (template header or raw column name).
TOOL_INVENTORY_REQUIRED_HEADERS = (("TOOL_ID",), ("TOTAL_INVENTORY", "TOTAL_QTY"))
SHEET_HEADERS = ("Tool ID", "Total Inventory", "Out of Service", "Note")
SHEET_NAME = "Tool Inventory"
NO_ROW_NOTE = "no inventory row yet"

_HOW_TO = [
    "How to use this tool inventory file",
    "",
    "1. Sheet 'Tool Inventory' has one row per tool id (the Tool 1 / Tool 2 values on your orders) for this plant.",
    "2. Total Inventory is how many copies the plant owns. Out of Service is how many of them cannot be used "
    "right now (repair, lost). Available = Total Inventory minus Out of Service.",
    "3. A tool with no row counts as 1 copy. To mark a tool unavailable set Out of Service equal to Total Inventory "
    "(or Total Inventory to 0).",
    "4. Rows marked 'no inventory row yet' are tools your orders use that have no row. Replace the 1 with the real count.",
    "5. Tool IDs are stored in upper case; 't100' and 'T100' are the same tool. Do not rename the column headers.",
    "6. Uploading only adds and changes tools. A tool missing from the file is left as it is. "
    "To remove a tool, delete its row in Master Data > Tool Inventory.",
    "7. You will see a review (new / changed / unchanged) before anything is saved.",
]


def _unquote(value):
    """Strip ONE leading apostrophe (the formula-injection guard on export prefixes text cells)."""
    if isinstance(value, str) and value.startswith("'"):
        return value[1:]
    return value


def _blank(value) -> bool:
    return value is None or (isinstance(value, float) and value != value) or (isinstance(value, str) and not value.strip())


def parse_tool_inventory_rows(rows: list[dict], plant: str, first_row: int = 2) -> tuple[list[dict], list[dict]]:
    """Validate already-mapped sheet rows (dicts keyed `tool_id`, `total_qty`,
    `out_of_service_qty`, `note`, optionally `plant`) for `plant`. Returns
    `(upserts, rejected)`: clean rows for `bulk_apply`, and `[{row, tool_id, error}]` where
    `row` is the 1-based sheet row (`first_row` is the first data row). Rejection is per row,
    never a whole-file failure. A `plant` cell is ignored when blank or equal to `plant`; a
    different plant rejects the row (a file for another plant must not silently land here).
    A repeat of an earlier tool id after normalisation is rejected -- the first row wins."""
    upserts: list[dict] = []
    rejected: list[dict] = []
    seen: set[str] = set()
    for offset, raw in enumerate(rows):
        row_no = first_row + offset
        if all(_blank(raw.get(k)) for k in ("tool_id", "total_qty", "out_of_service_qty", "note")):
            continue  # an entirely blank line is not a row
        tool_id_raw = _unquote(raw.get("tool_id"))
        label = db._str_id(tool_id_raw)
        sheet_plant = db._str_id(raw.get("plant"))
        if sheet_plant and sheet_plant != plant:
            rejected.append({"row": row_no, "tool_id": label,
                             "error": f"Plant {sheet_plant!r} does not match this plant ({plant!r})"})
            continue
        try:
            clean = md.normalize_tool_inventory_row({
                "tool_id": tool_id_raw,
                "total_qty": raw.get("total_qty"),
                "out_of_service_qty": raw.get("out_of_service_qty"),
                "note": _unquote(raw.get("note")),
            }, plant)
        except ValueError as exc:
            rejected.append({"row": row_no, "tool_id": label, "error": str(exc)})
            continue
        if clean["tool_id"] in seen:
            rejected.append({"row": row_no, "tool_id": clean["tool_id"],
                             "error": "duplicate Tool ID after normalisation (the first row wins)"})
            continue
        seen.add(clean["tool_id"])
        upserts.append(clean)
    return upserts, rejected


def parse_tool_inventory_excel(file_bytes: bytes, plant: str) -> tuple[list[dict], list[dict], list[dict], int]:
    """.xlsx bytes -> `(upserts, rejected, prefix_warnings, data_row_count)`. ValueError (a clean
    400 for the route) for an unreadable file / `.xls`, a missing required column, or too many rows."""
    try:
        # ingest._read_excel_rows requires one exact header each, so the alias-aware
        # required-column check happens here.
        df = ingest._read_excel(file_bytes)
        present = set(df.columns)
        missing = [alts[0] for alts in TOOL_INVENTORY_REQUIRED_HEADERS if not present.intersection(alts)]
        if missing:
            raise ValueError(f"Missing required column(s): {', '.join(missing)}")
        rows, prefix_warnings = ingest.map_row_keys(df.to_dict("records"), TOOL_INVENTORY_HEADERS)
    except ValueError as exc:
        if str(exc).startswith("Missing required column"):
            raise
        raise ValueError("Could not read the file. Upload a .xlsx workbook (not .xls or CSV).") from exc
    except Exception as exc:  # pandas/openpyxl raise assorted types on a corrupt or legacy file
        raise ValueError("Could not read the file. Upload a .xlsx workbook (not .xls or CSV).") from exc
    if len(rows) > MAX_UPLOAD_ROWS:
        raise ValueError(f"At most {MAX_UPLOAD_ROWS} rows per upload (this file has {len(rows)}).")
    upserts, rejected = parse_tool_inventory_rows(rows, plant, first_row=2)
    return upserts, rejected, prefix_warnings, len(rows)


def rejection_warnings(rejected: list[dict]) -> list[dict]:
    """UploadWarning-shaped dicts for the first `_MAX_LISTED_WARNINGS` rejections."""
    out = [{"level": "warn", "row": r["row"],
            "msg": f"Row {r['row']}{' (' + r['tool_id'] + ')' if r['tool_id'] else ''}: {r['error']}"}
           for r in rejected[:_MAX_LISTED_WARNINGS]]
    if len(rejected) > _MAX_LISTED_WARNINGS:
        out.append({"level": "warn", "msg": f"{len(rejected) - _MAX_LISTED_WARNINGS} more rejected row(s) not listed"})
    return out


def _shape(row: dict) -> dict:
    return {"tool_id": row["tool_id"], "total_qty": row["total_qty"],
            "out_of_service_qty": row["out_of_service_qty"], "note": row.get("note")}


def diff_tool_inventory(current: list[dict], upserts: list[dict]) -> dict:
    """The review-changes diff of clean `upserts` against the plant's `current` rows:
    `{new: [row], changed: [{tool_id, before, after}], unchanged: [tool_id]}`, each sorted by
    tool id. Upsert-only, so tools absent from the file never appear."""
    by_id = {r["tool_id"]: _shape(r) for r in current}
    new, changed, unchanged = [], [], []
    for r in sorted(upserts, key=lambda x: x["tool_id"]):
        after = _shape(r)
        before = by_id.get(r["tool_id"])
        if before is None:
            new.append(after)
        elif before != after:
            changed.append({"tool_id": r["tool_id"], "before": before, "after": after})
        else:
            unchanged.append(r["tool_id"])
    return {"new": new, "changed": changed, "unchanged": unchanged}


def template_rows(plant: str) -> list[dict]:
    """Template prefill: the plant's current rows UNION every tool its orders (or material
    PRT defaults) use that has no row yet, those at Total 1 / Out of Service 0 with a note so
    the planner knows they are placeholders for the implicit 1 copy. Sorted by tool id."""
    current = md.load_tool_inventory_rows(plant)
    have = {r["tool_id"] for r in current}
    extra = [{"tool_id": t, "total_qty": 1, "out_of_service_qty": 0, "note": NO_ROW_NOTE}
             for t in db.tool_ids_in_use(plant, include_material_plants=True) if t not in have]
    return sorted(current + extra, key=lambda r: r["tool_id"])


def _build_workbook(rows: list[dict], *, how_to: bool) -> bytes:
    """Data sheet first (so the parser, which reads the first sheet, always finds it); the
    English 'How to use' sheet second and only for the template. Text cells are guarded
    against spreadsheet-formula injection (the parser strips the leading apostrophe back)."""
    wb = Workbook()
    ws = wb.active
    ws.title = SHEET_NAME
    ws.append(list(SHEET_HEADERS))
    for r in rows:
        ws.append([csv_cell(r["tool_id"]), r["total_qty"], r["out_of_service_qty"], csv_cell(r.get("note"))])
    for col, width in zip("ABCD", (28, 18, 16, 48), strict=True):
        ws.column_dimensions[col].width = width
    if how_to:
        help_ws = wb.create_sheet("How to use")
        help_ws.append(["How to use"])
        for line in _HOW_TO[2:]:
            help_ws.append([line])
        help_ws.column_dimensions["A"].width = 110
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def build_template(plant: str) -> bytes:
    return _build_workbook(template_rows(plant), how_to=True)


def build_export(plant: str) -> bytes:
    return _build_workbook(md.load_tool_inventory_rows(plant), how_to=False)
