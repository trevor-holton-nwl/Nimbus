"""Report artifact convention. PURE (stdlib + backend.csv_util); persistence is data.save_artifact.

A report job returns `JobOutcome.artifact = {sections: [{key, title, columns: [{key, label, type}], rows: [[cell, ...]]}],
summary: {...}}`; a column `type` is text | number | date | datetime | bool (date/datetime cells are ISO strings, naive
plant-local wall time unless they carry an offset; bool cells are true/false; the client reads a plain-string column
as text). The runner stores it as JSON TEXT in `job_run_artifact` (size capped, rows truncated with a flag),
the run summary carries the row counts per section, and the viewer reads it page by page (`GET .../artifact`).
Rows are lists aligned with `columns` (no per-row keys: a 5 MB artifact stays about 5 MB).
"""
from __future__ import annotations

import csv
import io
import json
import math
import os
from datetime import date, datetime

from backend.csv_util import CSV_BOM, csv_row

DEFAULT_MAX_BYTES = 5 * 1024 * 1024
PAGE_MAX = 500


def max_bytes() -> int:
    """Total artifact cap (bytes of the stored JSON text); NIMBUS_JOBS_ARTIFACT_MAX_BYTES overrides (tests, ops)."""
    try:
        return max(1024, int(os.environ.get("NIMBUS_JOBS_ARTIFACT_MAX_BYTES", DEFAULT_MAX_BYTES)))
    except ValueError:
        return DEFAULT_MAX_BYTES


COLUMN_TYPES = ("text", "number", "date", "datetime", "bool")


def col(key: str, type: str = "text", label: str | None = None) -> dict:
    """One typed column. `label` defaults to the key (the client translates `jobs.a.col.<key>`)."""
    if type not in COLUMN_TYPES:
        raise ValueError(f"unknown column type {type!r}")
    return {"key": key, "label": label or key, "type": type}


def _column(c) -> dict:
    if isinstance(c, dict):
        return col(c["key"], c.get("type", "text"), c.get("label"))
    if isinstance(c, str):
        return col(c)
    if len(c) == 2:
        return col(c[0], "text", c[1])
    return col(c[0], c[2], c[1])


def section(key: str, title: str, columns: list, rows: list) -> dict:
    """Build one section; `columns` are keys, (key, label) or (key, label, type) tuples, or `col(...)` dicts."""
    return {"key": key, "title": title, "columns": [_column(c) for c in columns], "rows": [list(r) for r in rows]}


def _default(o):
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    return str(o)


def _dumps(obj) -> str:
    return json.dumps(obj, default=_default, separators=(",", ":"), ensure_ascii=False)


def sanitize(obj):
    """NaN / +-inf are not JSON: they become null (a bare NaN token would break the viewer's JSON.parse)."""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize(v) for v in obj]
    return obj


def cap_artifact(artifact: dict, limit: int | None = None) -> tuple[dict, bool]:
    """Return (artifact within `limit` bytes, truncated). Every section gains `row_count` (rows before the cap) and
    `truncated`; rows are cut from the largest section until the JSON text fits; the summary gains
    `truncated: true` and `max_bytes` when anything was cut."""
    limit = limit or max_bytes()
    artifact = sanitize(artifact)
    out = {"sections": [], "summary": dict(artifact.get("summary") or {})}
    for s in artifact.get("sections") or []:
        out["sections"].append({**s, "rows": list(s.get("rows") or []), "row_count": len(s.get("rows") or []),
                                "truncated": False})
    truncated = False
    for _ in range(40):
        size = len(_dumps(out).encode("utf-8"))
        if size <= limit:
            break
        sizes = [len(_dumps(s["rows"]).encode("utf-8")) for s in out["sections"]]
        i = max(range(len(sizes)), key=sizes.__getitem__)
        sec, rows_size = out["sections"][i], sizes[i]
        n = len(sec["rows"])
        if n == 0:
            break                                            # nothing left to cut (columns/summary alone too big)
        fixed = size - rows_size
        keep = int(n * max(0, limit - fixed) / max(1, rows_size) * 0.9)
        sec["rows"] = sec["rows"][: min(keep, n - 1)] if n > 1 else []
        sec["truncated"] = True
        truncated = True
    if len(_dumps(out).encode("utf-8")) > limit:          # the shrink loop ran out of rounds: drop every remaining row
        for sec in out["sections"]:
            if sec["rows"]:
                sec["rows"], sec["truncated"], truncated = [], True, True
    if truncated:
        out["summary"].update({"truncated": True, "max_bytes": limit})
    if len(_dumps(out).encode("utf-8")) > limit:          # columns / summary alone exceed the cap: say so
        out["summary"]["artifact_error"] = "too_large"
    return out, truncated


def section_csv(sec: dict) -> str:
    """One section as CSV text (UTF-8 BOM, spreadsheet-formula guard); only the stored rows."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(csv_row([c.get("label") or c.get("key") for c in sec.get("columns") or []]))
    for r in sec.get("rows") or []:
        w.writerow(csv_row(["" if v is None else v for v in r]))
    return CSV_BOM + buf.getvalue()


def page(sec: dict, offset: int, limit: int) -> dict:
    """The section with `rows` replaced by one page, plus `offset`, `limit`, `rows_stored`."""
    rows = sec.get("rows") or []
    offset = max(0, offset)
    limit = max(1, min(PAGE_MAX, limit))
    return {**sec, "rows": rows[offset: offset + limit], "offset": offset, "limit": limit, "rows_stored": len(rows)}


def row_counts(artifact: dict) -> dict:
    """{section key: rows before the cap} for the run summary."""
    return {s["key"]: int(s.get("row_count", len(s.get("rows") or []))) for s in artifact.get("sections") or []}
