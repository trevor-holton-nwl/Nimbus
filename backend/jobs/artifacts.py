"""Report artifact convention. PURE (stdlib + backend.csv_util); persistence is data.save_artifact.

A report job returns `JobOutcome.artifact = {sections: [{key, title, columns: [{key, label}], rows: [[cell, ...]]}],
summary: {...}}`. The runner stores it as JSON TEXT in `job_run_artifact` (size capped, rows truncated with a flag),
the run summary carries the row counts per section, and the viewer reads it page by page (`GET .../artifact`).
Rows are lists aligned with `columns` (no per-row keys: a 5 MB artifact stays about 5 MB).
"""
from __future__ import annotations

import csv
import io
import json
import os

from backend.csv_util import CSV_BOM, csv_row

DEFAULT_MAX_BYTES = 5 * 1024 * 1024
PAGE_MAX = 500


def max_bytes() -> int:
    """Total artifact cap (bytes of the stored JSON text); NIMBUS_JOBS_ARTIFACT_MAX_BYTES overrides (tests, ops)."""
    try:
        return max(1024, int(os.environ.get("NIMBUS_JOBS_ARTIFACT_MAX_BYTES", DEFAULT_MAX_BYTES)))
    except ValueError:
        return DEFAULT_MAX_BYTES


def section(key: str, title: str, columns: list, rows: list) -> dict:
    """Build one section; `columns` are keys or (key, label) pairs."""
    cols = [{"key": c, "label": c} if isinstance(c, str) else {"key": c[0], "label": c[1]} for c in columns]
    return {"key": key, "title": title, "columns": cols, "rows": [list(r) for r in rows]}


def _dumps(obj) -> str:
    return json.dumps(obj, default=str, separators=(",", ":"), ensure_ascii=False)


def cap_artifact(artifact: dict, limit: int | None = None) -> tuple[dict, bool]:
    """Return (artifact within `limit` bytes, truncated). Every section gains `row_count` (rows before the cap) and
    `truncated`; rows are cut from the largest section until the JSON text fits; the summary gains
    `truncated: true` and `max_bytes` when anything was cut."""
    limit = limit or max_bytes()
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
    if truncated:
        out["summary"].update({"truncated": True, "max_bytes": limit})
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
