"""
NIMBUS 2.0 -- SAP staging service (poll -> validate -> apply, vanish safeguards, archive).

Design of record: docs/SAP_STAGING_DESIGN.md. SAP data lands in the `sap_stage_*`
tables (written by Mulesoft, or by the Excel/CSV test upload below), is validated
row by row, and is promoted ("applied") into the live tables only under admin
control (`apply_mode`) -- never by this module's import, never by a request that
did not ask for it.

Layout:
  * pure helpers (zone conversion, open quantity, vanish gate, row builders and
    the material-plant / planned-order validators) -- no database;
  * batch lifecycle: list/get/discard, validate_batch, apply_batch, poll_once;
  * Excel/CSV upload into staging (never applies) and the 30-day vanish archive.

Imports follow sap_sync.py: `db`, `master_data`, `sap_sync` at module scope;
the distribution / routing / setup domains are imported lazily inside functions
(they import `db`, so a top-level import here would be circular). Importing this
module never opens a database connection. All SQL is parameterised; dynamic
identifiers (stage table names, from the SAP_OBJECTS catalog) go through
psycopg.sql.Identifier.

Planned-order apply is NOT one transaction: `db.upsert_orders` commits every 500
rows by design, so a batch moves to `applying`, each step is idempotent, the step
name is kept in `counts["step"]`, and on failure the batch becomes `error` and a
second Apply resumes. Vanish deletion only ever runs after every upsert chunk
succeeded.
"""
import io
import logging
import os
import uuid
from datetime import date, datetime, timedelta
from datetime import time as dt_time
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pandas as pd
from psycopg import sql
from psycopg.types.json import Jsonb

import db
import master_data as md
from backend.integration import sap_sync
from db import _pool

log = logging.getLogger("nimbus.sap")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
VANISH_HOLD_PCT = 0.25                      # more than 25 % of in-horizon orders vanishing -> held
LOADING_TIMEOUT_MIN = int(os.getenv("NIMBUS_SAP_STAGING_LOADING_TIMEOUT_MIN", "120"))
SAP_SYSTEM_TZ = os.getenv("NIMBUS_SAP_SYSTEM_TZ", "UTC")
ARCHIVE_RETENTION_DAYS = 30
SENT_RETENTION_DAYS = 30
DEAD_BATCH_RETENTION_DAYS = 7               # rejected / discarded / superseded batches
APPLY_ORDER = ("stage_material_plants", "stage_production_version",
               "stage_routing_operation", "stage_planned_orders")

_MATERIAL_ID_MAX = 18                       # materials / material_plants.material_id VARCHAR(18)
_PLANT_MAX = 10                             # material_plants.plant VARCHAR(10)
_APPLY_CHUNK = 2000                         # rows per md.bulk_apply call
_VALIDATE_WRITE_CHUNK = 20000

_NULL_DATES = frozenset({"", "00000000", "0000-00-00"})
_HOUSEKEEPING_COLS = frozenset({"id", "batch_id", "row_status", "reject_reason", "received_at", "applied_at"})
# Columns NIMBUS resolves at validation (never supplied by SAP / the upload).
_RESOLVED_COLS = {
    "stage_material_plants": ("material_id", "plant"),
    "stage_planned_orders": ("production_order", "material_id", "plant"),
    "stage_production_version": (),
    "stage_routing_operation": (),
}
_HEADER_COLS = ("batch_id", "object_key", "plant", "source", "status", "row_count_expected", "received_at",
                "ready_at", "validated_at", "applied_at", "applied_by", "created_by", "counts", "warnings", "error")
_LIVE_STATUSES = ("ready", "validated", "held")        # un-applied, still-actionable batch states
_ZERO_OPEN_REASON = {"code": "zero_open_quantity",
                     "message": "Open quantity is zero; nothing left to produce"}


class BatchNotApplicable(Exception):
    """The batch cannot be validated / applied in its current state. `.detail`
    carries a machine-readable dict for the route layer."""

    def __init__(self, message: str, detail: dict | None = None):
        super().__init__(message)
        self.detail = dict(detail or {})
        self.detail.setdefault("message", message)


class BatchSuperseded(BatchNotApplicable):
    """A newer complete batch exists for the same object + plant (HTTP 409)."""


def _log(level: str, msg: str, **ctx) -> None:
    """Structured event via brain's ring buffer when importable, else logging."""
    try:
        from backend.admin_ops.logbuffer import _log_event
        _log_event(level, "sap_staging", msg, **ctx)
    except Exception:
        getattr(log, {"warn": "warning"}.get(level, level), log.info)(msg)


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------
def _zone(name: str | None):
    if not name:
        return None
    try:
        return ZoneInfo(str(name))
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return None


def _parse_sap_date(text) -> date | None:
    """'YYYYMMDD' / 'YYYY-MM-DD' (an Excel '... 00:00:00' suffix is tolerated) -> date.
    Sentinels ('', '00000000', '0000-00-00', None) -> None. ValueError when malformed."""
    if text is None:
        return None
    if isinstance(text, datetime):
        return text.date()
    if isinstance(text, date):
        return text
    s = str(text).strip()
    if s in _NULL_DATES or s.lower() == "nan":
        return None
    if len(s) > 10 and s[10] in " T":
        s = s[:10]
    try:
        if len(s) == 8 and s.isdigit():
            return datetime.strptime(s, "%Y%m%d").date()
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError as exc:
        raise ValueError(f"invalid SAP date: {text!r}") from exc


def _parse_sap_time(text) -> dt_time | None:
    """'HHMMSS' / 'HH:MM:SS' / 'HH:MM' -> time. None / '' / '000000' (midnight) -> None, which
    means "date only". ValueError when malformed."""
    if text is None:
        return None
    if isinstance(text, datetime):
        text = text.time()
    if isinstance(text, dt_time):
        return None if text == dt_time.min else text.replace(microsecond=0)
    s = str(text).strip()
    if s == "" or s.lower() == "nan":
        return None
    try:
        if s.isdigit() and len(s) <= 6:
            t = datetime.strptime(s.zfill(6), "%H%M%S").time()
        elif s.count(":") == 2:
            t = datetime.strptime(s, "%H:%M:%S").time()
        elif s.count(":") == 1:
            t = datetime.strptime(s, "%H:%M").time()
        else:
            raise ValueError(s)
    except ValueError as exc:
        raise ValueError(f"invalid SAP time: {text!r}") from exc
    return None if t == dt_time.min else t


def sap_to_plant_local(date_text, time_text, plant_tz: str | None, *,
                       system_tz: str | None = None) -> datetime | None:
    """SAP date + time (SAP system time zone) -> naive plant-local datetime.

    A missing/sentinel date -> None; a missing or '000000' time is a date-only value (midnight, NOT
    zone-converted -- shifting a date-only value across zones would move the date). An unknown or empty
    zone on either side means no conversion. Raises ValueError on malformed input."""
    d = _parse_sap_date(date_text)
    if d is None:
        return None
    t = _parse_sap_time(time_text)
    naive = datetime.combine(d, t or dt_time.min)
    if t is None:
        return naive
    src, dst = _zone(system_tz or SAP_SYSTEM_TZ), _zone(plant_tz)
    if src is None or dst is None:
        return naive
    return naive.replace(tzinfo=src).astimezone(dst).replace(tzinfo=None)


def plant_local_to_sap(dt: datetime, plant_tz: str | None, *,
                       system_tz: str | None = None) -> tuple[date, dt_time]:
    """Inverse of `sap_to_plant_local`: naive plant-local datetime -> (SAP date, SAP time)
    in the SAP system zone (seconds precision). Unknown zone on either side = no conversion."""
    src, dst = _zone(plant_tz), _zone(system_tz or SAP_SYSTEM_TZ)
    if dt.tzinfo is not None:
        out = dt.astimezone(dst) if dst is not None else dt.replace(tzinfo=None)
    elif src is not None and dst is not None:
        out = dt.replace(tzinfo=src).astimezone(dst)
    else:
        out = dt
    out = out.replace(tzinfo=None, microsecond=0)
    return out.date(), out.time()


def _dec(value) -> Decimal | None:
    """Blank -> None; a finite number -> Decimal; anything else ValueError."""
    if value is None:
        return None
    if isinstance(value, Decimal):
        d = value
    else:
        s = str(value).strip()
        if s == "" or s.lower() == "nan":
            return None
        try:
            d = Decimal(s)
        except InvalidOperation as exc:
            raise ValueError(f"invalid number: {value!r}") from exc
    if not d.is_finite():
        raise ValueError(f"invalid number: {value!r}")
    return d


def open_quantity(gsmng, abmng) -> Decimal | None:
    """Open (still to produce) quantity = total - reduced. None when the total is unknown;
    a missing reduced quantity counts as 0."""
    g = _dec(gsmng)
    if g is None:
        return None
    return g - (_dec(abmng) or Decimal(0))


def truncate_subnetwork(v) -> str | None:
    """SAP's 4-character subnetwork -> NIMBUS's 3 (D25)."""
    if v is None:
        return None
    s = str(v).strip()
    return s[:3] or None


def vanish_gate(in_horizon_live: int, candidates: int) -> tuple[bool, float]:
    """(held, fraction). Held when MORE than VANISH_HOLD_PCT of the in-horizon live orders are
    candidates for deletion; no live orders -> never held."""
    if not in_horizon_live or in_horizon_live <= 0:
        return False, 0.0
    pct = candidates / in_horizon_live
    return pct > VANISH_HOLD_PCT, pct


def active_map(object_key: str, field_map: list[dict] | None = None) -> dict[str, tuple[str, str]]:
    """{sap_field (lower case): (nimbus_column, transform)} for the ACTIVE field-map rows of an
    object. `field_map` is injectable (tests); default loads sap_field_map."""
    if field_map is None:
        field_map = sap_sync.load_field_map(object_key)
    return {str(m["sap_field"]).lower(): (m["nimbus_column"], m.get("transform") or "none")
            for m in field_map if m.get("active", True)}


def _text(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _int_or_none(v, field: str) -> int | None:
    s = _text(v)
    if s is None:
        return None
    try:
        return int(float(s))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field!r} is not a valid integer: {v!r}") from exc


def build_material_plant_rows(stage_rows: list[dict], field_map: list[dict] | None = None,
                              warnings: list | None = None) -> list[dict]:
    """Valid material-plant staging rows -> `md.bulk_apply('material_plants')` upsert rows through the
    active field map. alpha_strip already ran at validation (the resolved `material_id` / `plant` win);
    lot sizes are int-cast (a fractional value is rounded and counted in a `lot_size_rounded` warning
    appended to `warnings`); subnetwork is truncated to 3 characters. None values are dropped (except
    the key) so a missing SAP value never overwrites a NOT NULL column with NULL."""
    amap = active_map("stage_material_plants", field_map)
    rounded = 0
    out: list[dict] = []
    for sr in stage_rows:
        row: dict = {}
        for sap_field, (col, tf) in amap.items():
            if sap_field in sr:
                row[col] = sap_sync.apply_transform(tf, sr[sap_field])
        if sr.get("material_id"):
            row["material_id"] = sr["material_id"]
        if sr.get("plant"):
            row["plant"] = sr["plant"]
        if "subnetwork" in row:
            row["subnetwork"] = truncate_subnetwork(row["subnetwork"])
        for col in ("min_lot_size", "incremental_lot_size"):
            if row.get(col) is not None:
                val = float(row[col])
                if val != int(val):
                    rounded += 1
                row[col] = int(round(val))
        if row.get("status_pl") is not None:
            row["status_pl"] = str(row["status_pl"]).strip()
        out.append({k: v for k, v in row.items() if v is not None or k in ("material_id", "plant")})
    if rounded and warnings is not None:
        warnings.append({"level": "warn", "code": "lot_size_rounded", "count": rounded,
                         "msg": f"{rounded} fractional lot size value(s) were rounded to whole numbers."})
    return out


def build_order_rows(stage_rows: list[dict], plant_tz: str | None, field_map: list[dict] | None = None,
                     warnings: list | None = None) -> tuple[list[dict], list[tuple[int, str]]]:
    """Valid planned-order staging rows -> `db.upsert_orders` row dicts.

    Generic columns come from the ACTIVE field-map rows (inactive rows never reach a live column);
    the composite rules live here: start / finish = SAP date + time converted from the SAP system zone
    to `plant_tz`; order_quantity = total - reduced (never below 0); planned_order_initial_quantity =
    total; reduced_quantity = reduced; production_version / sap_production_version mirror the Excel
    path (blank = material default; baseline '' = SAP sent "no version"). A row with open quantity
    <= 0 carries `_zero_open=True` (planning_status is planner-owned and is not an upsert column, so
    apply_batch sets Needs Planning / `zero_open_quantity` in a follow-up UPDATE). Rows carry
    `_stage_row_id`. Date hygiene (`db.apply_order_date_hygiene_rows`) runs last; its warnings land
    in `warnings`. Returns (rows, [(stage_row_id, reason)]) -- reasons for rows that could not be built."""
    amap = active_map("stage_planned_orders", field_map)
    problems: list[tuple[int, str]] = []
    rows: list[dict] = []
    for sr in stage_rows:
        sid = int(sr["id"]) if sr.get("id") is not None else -1
        try:
            row: dict = {}
            for sap_field, (col, tf) in amap.items():
                if sap_field in sr:
                    row[col] = sap_sync.apply_transform(tf, sr[sap_field])
            row.pop("basic_start_time", None)
            row.pop("basic_finish_time", None)
            if "psttr" in amap:
                row["basic_start_date"] = sap_to_plant_local(
                    sr.get("psttr"), sr.get("pstti") if "pstti" in amap else None, plant_tz)
            if "pedtr" in amap:
                row["basic_finish_date"] = sap_to_plant_local(
                    sr.get("pedtr"), sr.get("pedti") if "pedti" in amap else None, plant_tz)
            zero_open = False
            if "gsmng" in amap:
                total = _dec(sr.get("gsmng"))
                reduced = _dec(sr.get("abmng")) if "abmng" in amap else None
                openq = open_quantity(total, reduced)
                if openq is not None:
                    zero_open = openq <= 0
                    row["order_quantity"] = float(max(openq, Decimal(0)))
                    row["planned_order_initial_quantity"] = float(total)
                    row["reduced_quantity"] = float(reduced) if reduced is not None else None
            if "verid" in amap:
                pv = (_text(sr.get("verid")) or "").upper()
                row["production_version"] = pv or None
                row["sap_production_version"] = pv
            for col in ("bom_usage", "bom_alternative"):
                if col in row:
                    row[col] = _int_or_none(row[col], col)
            if "firming_indicator" in row:
                row["firming_indicator"] = _text(row["firming_indicator"])
            if sr.get("production_order"):
                row["production_order"] = sr["production_order"]
            if sr.get("material_id"):
                row["material_number"] = sr["material_id"]
            row["production_order"] = db._str_id(row.get("production_order"))
            row["material_number"] = db._str_id(row.get("material_number"))
            row["machine"] = db._str_id(row.get("machine")) or None
            row["plant"] = db._str_id(sr.get("plant") or row.get("plant")) or None
            row["_stage_row_id"] = sid
            row["_zero_open"] = zero_open
        except ValueError as exc:
            problems.append((sid, "invalid_int" if "integer" in str(exc) else
                             "invalid_time" if "time" in str(exc) else
                             "invalid_date" if "date" in str(exc) else "invalid_number"))
            log.debug("planned-order staging row %s not built: %s", sid, exc)
            continue
        rows.append(row)

    hyg_warnings: list = []
    survivors = db.apply_order_date_hygiene_rows(rows, hyg_warnings)
    kept = {id(r) for r in survivors}
    for r in rows:
        if id(r) not in kept:
            problems.append((r["_stage_row_id"], "invalid_date"))
    if warnings is not None:
        warnings.extend(hyg_warnings)
    return survivors, problems


def zero_open_keys(rows: list[dict]) -> list[str]:
    """Production-order numbers of built order rows whose open quantity is <= 0."""
    return sorted({r["production_order"] for r in rows if r.get("_zero_open") and r.get("production_order")})


# ---------------------------------------------------------------------------
# Pure validators (material plants, planned orders)
# ---------------------------------------------------------------------------
def _finalize(results: list[dict], key_of) -> list[dict]:
    """Reject EVERY row of a duplicated key (`duplicate_key`), then fix row_status."""
    counts: dict = {}
    for r in results:
        if r["reason"] is None:
            counts[key_of(r)] = counts.get(key_of(r), 0) + 1
    for r in results:
        if r["reason"] is None and counts[key_of(r)] > 1:
            r["reason"] = "duplicate_key"
        r["status"] = "valid" if r["reason"] is None else "rejected"
    return results


def validate_material_plant_rows(rows: list[dict], header_plant: str, known_plants: set) -> list[dict]:
    """Row verdicts for a material-plant batch: [{id, status, reason, resolved}]. Reasons:
    missing_key, plant_mismatch, unknown_plant, key_too_long, duplicate_key."""
    results = []
    for r in rows:
        mat = sap_sync._t_alpha_strip(r.get("matnr"))
        pl = _text(r.get("werks"))
        reason = None
        if not mat or not pl:
            reason = "missing_key"
        elif pl != header_plant:
            reason = "plant_mismatch"
        elif pl not in known_plants:
            reason = "unknown_plant"
        elif len(mat) > _MATERIAL_ID_MAX or len(pl) > _PLANT_MAX:
            reason = "key_too_long"
        results.append({"id": r["id"], "reason": reason, "resolved": {"material_id": mat, "plant": pl}})
    return _finalize(results, lambda x: (x["resolved"]["material_id"], x["resolved"]["plant"]))


def validate_planned_order_rows(rows: list[dict], header_plant: str, known_plants: set) -> list[dict]:
    """Row verdicts for a planned-order batch. Reasons: missing_key (incl. an all-zero order number),
    plant_mismatch, unknown_plant, invalid_date (also a missing start), invalid_time, invalid_number,
    invalid_int, duplicate_key. `resolved` always carries what could be resolved, even for a rejected
    row, so the vanish guard can still protect an order SAP did send."""
    results = []
    for r in rows:
        po = sap_sync._t_strip_zeros(r.get("plnum"))
        mat = sap_sync._t_alpha_strip(r.get("matnr"))
        pl = _text(r.get("plwrk"))
        reason = None
        if not po or not mat or not pl:
            reason = "missing_key"
        elif pl != header_plant:
            reason = "plant_mismatch"
        elif pl not in known_plants:
            reason = "unknown_plant"
        if reason is None:
            try:
                if _parse_sap_date(r.get("psttr")) is None:
                    reason = "invalid_date"
                _parse_sap_date(r.get("pedtr"))
            except ValueError:
                reason = "invalid_date"
        if reason is None:
            try:
                _parse_sap_time(r.get("pstti"))
                _parse_sap_time(r.get("pedti"))
            except ValueError:
                reason = "invalid_time"
        if reason is None:
            try:
                total, reduced = _dec(r.get("gsmng")), _dec(r.get("abmng"))
                if total is None or total < 0 or (reduced is not None and reduced < 0):
                    reason = "invalid_number"
            except ValueError:
                reason = "invalid_number"
        if reason is None:
            try:
                _int_or_none(r.get("stlan"), "stlan")
                _int_or_none(r.get("stalt"), "stalt")
            except ValueError:
                reason = "invalid_int"
        results.append({"id": r["id"], "reason": reason,
                        "resolved": {"production_order": po, "material_id": mat, "plant": pl}})
    return _finalize(results, lambda x: (x["resolved"]["production_order"], x["resolved"]["material_id"]))


def _routing_key(object_key: str, ingest, mat: str | None, r: dict) -> tuple | None:
    """Normalised identity of a routing staging row (None when a key part is missing)."""
    pl = _text(r.get("plant"))
    if object_key == "stage_production_version":
        parts = (pl, mat, ingest._zero_pad(r.get("production_version"), 4))
    else:
        parts = (pl, mat, _text(r.get("task_list_type")), _text(r.get("routing_group")),
                 ingest._zero_pad(r.get("group_counter"), 2), ingest._zero_pad(r.get("sequence_no"), 6),
                 ingest._zero_pad(r.get("activity"), 4))
    return parts if all(parts) else None


def _routing_parse_row(r: dict, mat: str | None) -> dict:
    row = {k: v for k, v in r.items() if k not in _HOUSEKEEPING_COLS}
    row["material_id"] = mat
    return row


def _validate_routing_rows(object_key: str, rows: list[dict], header_plant: str, known_plants: set,
                           conn) -> list[dict]:
    """Row verdicts for a routing batch: the pre-checks (missing_key, plant_mismatch, unknown_plant,
    deleted_flag, duplicate_key) then the live routing validators
    (`backend.routing.ingest.parse_*_rows`), whose rejections are mapped back onto staging rows."""
    import backend.routing.ingest as ingest
    results, cands = [], []
    for r in rows:
        mat = sap_sync._t_alpha_strip(r.get("material_id"))
        key = _routing_key(object_key, ingest, mat, r)
        pl = _text(r.get("plant"))
        reason = None
        if key is None:
            reason = "missing_key"
        elif pl != header_plant:
            reason = "plant_mismatch"
        elif pl not in known_plants:
            reason = "unknown_plant"
        elif object_key == "stage_routing_operation" and ingest._to_bool(r.get("deleted")):
            reason = "deleted_flag"
        res = {"id": r["id"], "reason": reason, "resolved": {}, "key": key}
        results.append(res)
        if reason is None:
            cands.append((res, r, mat))
    _finalize(results, lambda x: x["key"])
    cands = [c for c in cands if c[0]["reason"] is None]
    if cands:
        parse_rows = [_routing_parse_row(r, mat) for _, r, mat in cands]
        if object_key == "stage_production_version":
            ops, warns = ingest.parse_production_versions_rows(parse_rows, conn=conn, first_row=0)
            accepted = {(u["plant"], u["material_id"], u["production_version"]) for u in ops["upserts"]}
        else:
            groups, warns = ingest.parse_routing_operations_rows(parse_rows, conn=conn, first_row=0)
            accepted = {(o["plant"], o["material_id"], o["task_list_type"], o["routing_group"],
                         o["group_counter"], o["sequence_no"], o["activity"])
                        for ops_ in groups.values() for o in ops_}
        why = {w["row"]: str(w.get("msg", "")).split(":")[0].strip()
               for w in warns if w.get("level") == "reject" and "row" in w}
        for pos, (res, _r, _m) in enumerate(cands):
            if res["key"] not in accepted:
                res["reason"] = why.get(pos) or "rejected_by_validator"
            res["status"] = "valid" if res["reason"] is None else "rejected"
    return results


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
def _as_uuid(batch_id) -> uuid.UUID:
    try:
        return batch_id if isinstance(batch_id, uuid.UUID) else uuid.UUID(str(batch_id))
    except ValueError as exc:
        raise KeyError(f"batch {batch_id!r} not found") from exc


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


def _header_dict(row) -> dict:
    d = dict(zip(_HEADER_COLS, row, strict=True))
    d["batch_id"] = str(d["batch_id"])
    for k in ("received_at", "ready_at", "validated_at", "applied_at"):
        d[k] = _iso(d[k])
    d["counts"] = d["counts"] or {}
    d["warnings"] = d["warnings"] or []
    return d


_HEADER_SELECT = "SELECT " + ", ".join(_HEADER_COLS) + " FROM sap_stage_batch"


def _load_header(cur, batch_id, lock: bool = False) -> dict | None:
    cur.execute(_HEADER_SELECT + " WHERE batch_id = %s" + (" FOR UPDATE" if lock else ""), (str(batch_id),))
    row = cur.fetchone()
    return _header_dict(row) if row else None


def _spec(object_key: str) -> dict:
    spec = sap_sync.SAP_OBJECTS.get(object_key)
    if not spec or spec.get("kind") != "staging":
        raise ValueError(f"Not a staging object: {object_key!r}")
    return spec


def _fetch_rows(cur, table: str, batch_id, statuses=None) -> list[dict]:
    q = sql.SQL("SELECT * FROM {} WHERE batch_id = %s").format(sql.Identifier(table))
    params: list = [str(batch_id)]
    if statuses:
        q += sql.SQL(" AND row_status = ANY(%s)")
        params.append(list(statuses))
    q += sql.SQL(" ORDER BY id")
    cur.execute(q, params)
    names = [d.name for d in cur.description]
    return [dict(zip(names, r, strict=True)) for r in cur.fetchall()]


def _plant_info(cur, plant: str) -> dict:
    cur.execute("SELECT timezone, routing_runtime_enabled FROM plants WHERE plant = %s LIMIT 1", (plant,))
    r = cur.fetchone()
    return {"timezone": r[0], "routing_enabled": bool(r[1])} if r else {"timezone": None, "routing_enabled": False}


def _known_plants(cur, plants: set) -> set:
    plants = {p for p in plants if p}
    if not plants:
        return set()
    cur.execute("SELECT plant FROM plants WHERE plant = ANY(%s)", (sorted(plants),))
    return {r[0] for r in cur.fetchall()}


def _append_warnings(cur, batch_id, warnings: list) -> None:
    if warnings:
        cur.execute("UPDATE sap_stage_batch SET warnings = warnings || %s::jsonb WHERE batch_id = %s",
                    (Jsonb(warnings), str(batch_id)))


def _write_row_results(cur, table: str, results: list[dict], resolved_cols: tuple) -> None:
    """Set row_status / reject_reason (+ resolved key columns) for every verdict, set-based."""
    for i in range(0, len(results), _VALIDATE_WRITE_CHUNK):
        chunk = results[i:i + _VALIDATE_WRITE_CHUNK]
        params: list = [[r["id"] for r in chunk], [r["status"] for r in chunk], [r["reason"] for r in chunk]]
        sets = sql.SQL("row_status = v.rs, reject_reason = v.rr")
        casts = sql.SQL("%s::bigint[], %s::text[], %s::text[]")
        names = sql.SQL("id, rs, rr")
        for col in resolved_cols:
            params.append([r["resolved"].get(col) for r in chunk])
            sets += sql.SQL(", {c} = v.{c}").format(c=sql.Identifier(col))
            casts += sql.SQL(", %s::text[]")
            names += sql.SQL(", {c}").format(c=sql.Identifier(col))
        cur.execute(
            sql.SQL("UPDATE {t} AS s SET {sets} FROM unnest({casts}) AS v({names}) WHERE s.id = v.id").format(
                t=sql.Identifier(table), sets=sets, casts=casts, names=names),
            params)


def _in_horizon_predicate() -> str:
    return "COALESCE(sap_basic_start_date, basic_start_date) <= %s"


def _planned_order_gates(cur, plant: str, order_numbers: set) -> tuple[dict, list[dict], list[str], datetime | None]:
    """Batch-level checks for a planned-order batch: (info counts, warnings, held codes, visibility_end).
    `order_numbers` is EVERY order number SAP sent (valid or rejected-but-resolvable)."""
    warnings: list[dict] = []
    held: list[str] = []
    info = _plant_info(cur, plant)
    cur.execute("SELECT EXISTS (SELECT 1 FROM routing_operation WHERE plant = %s)", (plant,))
    has_routing = bool(cur.fetchone()[0])
    if not (info["routing_enabled"] and has_routing):
        held.append("routing_required")
        warnings.append({"level": "warn", "code": "routing_required",
                         "msg": ("Routing runtime must be switched on for this plant and routings loaded "
                                 "before planned orders can be applied.")})
    visibility_end, _frozen = db._horizon_bounds_for_plant(cur, plant)
    live = cand = 0
    pct = 0.0
    if visibility_end is None:
        warnings.append({"level": "warn", "code": "horizon_unlimited_no_deletes",
                         "msg": "This plant has an unlimited visibility horizon: orders absent from the "
                                "snapshot are never deleted."})
    else:
        bound = visibility_end + timedelta(days=1)
        cur.execute(
            "SELECT count(*), count(*) FILTER (WHERE COALESCE(parent_production_order, production_order)"
            " <> ALL(%s)) FROM orders WHERE plant = %s AND " + _in_horizon_predicate(),
            (sorted(order_numbers), plant, bound))
        live, cand = (int(x or 0) for x in cur.fetchone())
        is_held, pct = vanish_gate(live, cand)
        if is_held:
            held.append("vanish_threshold")
            warnings.append({"level": "warn", "code": "vanish_threshold",
                             "msg": (f"{cand} of {live} in-horizon orders ({pct:.0%}) are missing from this "
                                     f"snapshot; more than {VANISH_HOLD_PCT:.0%} needs admin confirmation.")})
    return ({"in_horizon_live": live, "vanish_candidates": cand, "vanish_pct": round(pct, 4)},
            warnings, held, visibility_end)


def _vanish_candidates(cur, plant: str, order_numbers: set, visibility_end: datetime | None,
                       *, detail: bool = False) -> list:
    """Orders (whole distribution families) that a planned-order apply deletes: in horizon and absent
    from `order_numbers`. Ids only, or detail dicts when `detail`."""
    if visibility_end is None:
        return []
    bound = visibility_end + timedelta(days=1)
    cur.execute(
        "SELECT id, parent_production_order FROM orders WHERE plant = %s AND " + _in_horizon_predicate()
        + " AND COALESCE(parent_production_order, production_order) <> ALL(%s)",
        (plant, bound, sorted(order_numbers)))
    cand = cur.fetchall()
    ids = {r[0] for r in cand}
    parents = sorted({r[1] for r in cand if r[1]})
    if parents:
        cur.execute("SELECT id FROM orders WHERE plant = %s AND parent_production_order = ANY(%s)",
                    (plant, parents))
        ids |= {r[0] for r in cur.fetchall()}
    ids_sorted = sorted(ids)
    if not detail or not ids_sorted:
        return ids_sorted
    cur.execute(
        "SELECT id, production_order, material_number, machine, scheduled_start, scheduled_end,"
        " manual_firmed, firming_indicator, parent_production_order FROM orders"
        " WHERE plant = %s AND id = ANY(%s) ORDER BY production_order, id", (plant, ids_sorted))
    return [{"id": r[0], "production_order": r[1], "material_number": r[2], "machine": r[3],
             "scheduled_start": _iso(r[4]), "scheduled_end": _iso(r[5]), "manual_firmed": bool(r[6]),
             "firming_indicator": r[7], "parent_production_order": r[8]} for r in cur.fetchall()]


def _sent_order_numbers(cur, table: str, batch_id) -> set:
    cur.execute(sql.SQL("SELECT DISTINCT production_order FROM {} WHERE batch_id = %s"
                        " AND production_order IS NOT NULL").format(sql.Identifier(table)), (str(batch_id),))
    return {r[0] for r in cur.fetchall()}


# ---------------------------------------------------------------------------
# Batch lifecycle -- read side
# ---------------------------------------------------------------------------
def list_batches(*, object_key: str | None = None, plant: str | None = None, status: str | None = None,
                 limit: int = 50, allowed_plants: list[str] | None = None) -> list[dict]:
    """Batch headers, newest first. `allowed_plants` (None = unrestricted) scopes by plant."""
    where, params = [], []
    if object_key:
        where.append("object_key = %s")
        params.append(object_key)
    if plant:
        where.append("plant = %s")
        params.append(plant)
    if status:
        where.append("status = %s")
        params.append(status)
    if allowed_plants is not None:
        where.append("plant = ANY(%s)")
        params.append(list(allowed_plants))
    q = _HEADER_SELECT + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY received_at DESC LIMIT %s"
    params.append(int(limit))
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(q, params)
        return [_header_dict(r) for r in cur.fetchall()]


def get_batch(batch_id) -> dict | None:
    """Header + live per-row-status counts (`row_counts`, `actual_rows`) + warnings; None if unknown."""
    try:
        bid = _as_uuid(batch_id)
    except KeyError:
        return None
    with _pool.connection() as conn, conn.cursor() as cur:
        hdr = _load_header(cur, bid)
        if hdr is None:
            return None
        table = _spec(hdr["object_key"])["stage_table"]
        cur.execute(sql.SQL("SELECT row_status, count(*) FROM {} WHERE batch_id = %s GROUP BY row_status")
                    .format(sql.Identifier(table)), (str(bid),))
        counts = {r[0]: int(r[1]) for r in cur.fetchall()}
    hdr["row_counts"] = counts
    hdr["actual_rows"] = sum(counts.values())
    return hdr


def rejected_rows(batch_id, *, limit: int = 1000) -> list[dict]:
    """Rejected staging rows of a batch (with `reject_reason`) for the drawer / CSV download."""
    bid = _as_uuid(batch_id)
    with _pool.connection() as conn, conn.cursor() as cur:
        hdr = _load_header(cur, bid)
        if hdr is None:
            raise KeyError(f"batch {batch_id} not found")
        table = _spec(hdr["object_key"])["stage_table"]
        cur.execute(sql.SQL("SELECT * FROM {} WHERE batch_id = %s AND row_status = 'rejected'"
                            " ORDER BY id LIMIT %s").format(sql.Identifier(table)), (str(bid), int(limit)))
        names = [d.name for d in cur.description]
        out = []
        for r in cur.fetchall():
            d = dict(zip(names, r, strict=True))
            d["batch_id"] = str(d["batch_id"])
            out.append({k: (_iso(v) if hasattr(v, "isoformat") else (str(v) if isinstance(v, Decimal) else v))
                        for k, v in d.items()})
        return out


def held_deletions(batch_id) -> list[dict]:
    """The orders a planned-order batch would delete (live, same predicate as validation)."""
    bid = _as_uuid(batch_id)
    with _pool.connection() as conn, conn.cursor() as cur:
        hdr = _load_header(cur, bid)
        if hdr is None:
            raise KeyError(f"batch {batch_id} not found")
        if hdr["object_key"] != "stage_planned_orders":
            return []
        visibility_end, _ = db._horizon_bounds_for_plant(cur, hdr["plant"])
        sent = _sent_order_numbers(cur, _spec(hdr["object_key"])["stage_table"], bid)
        return _vanish_candidates(cur, hdr["plant"], sent, visibility_end, detail=True)


def expire_stale_loading(cur) -> int:
    """`loading` batches older than LOADING_TIMEOUT_MIN -> rejected (stale). Caller commits."""
    cur.execute(
        "UPDATE sap_stage_batch SET status = 'rejected', error = 'stale: left in loading past the timeout',"
        " warnings = warnings || %s::jsonb WHERE status = 'loading'"
        " AND received_at < now() - make_interval(mins => %s) RETURNING batch_id",
        (Jsonb([{"level": "warn", "code": "stale_loading", "msg": "Batch never reached ready; rejected as stale."}]),
         LOADING_TIMEOUT_MIN))
    return len(cur.fetchall())


def supersede_older(cur, object_key: str, plant: str, keep_batch_id) -> list[str]:
    """Older un-applied (ready / validated / held) batches of the same object + plant -> superseded,
    their rows too. Caller commits."""
    table = _spec(object_key)["stage_table"]
    cur.execute(
        "UPDATE sap_stage_batch SET status = 'superseded' WHERE object_key = %s AND plant = %s"
        " AND batch_id <> %s AND status = ANY(%s)"
        " AND received_at < (SELECT received_at FROM sap_stage_batch WHERE batch_id = %s) RETURNING batch_id",
        (object_key, plant, str(keep_batch_id), list(_LIVE_STATUSES), str(keep_batch_id)))
    ids = [str(r[0]) for r in cur.fetchall()]
    if ids:
        cur.execute(sql.SQL("UPDATE {} SET row_status = 'superseded' WHERE batch_id = ANY(%s)"
                            " AND row_status IN ('new','valid','rejected')").format(sql.Identifier(table)), (ids,))
    return ids


def discard_batch(batch_id, *, actor: str) -> dict:
    """Admin discard: batch -> discarded, its rows -> superseded. Not allowed while applying / after apply."""
    bid = _as_uuid(batch_id)
    with _pool.connection() as conn, conn.cursor() as cur:
        try:
            hdr = _load_header(cur, bid, lock=True)
            if hdr is None:
                raise KeyError(f"batch {batch_id} not found")
            if hdr["status"] in ("applying", "applied", "discarded"):
                raise BatchNotApplicable(f"batch is {hdr['status']} and cannot be discarded",
                                         {"status": hdr["status"]})
            table = _spec(hdr["object_key"])["stage_table"]
            cur.execute(sql.SQL("UPDATE {} SET row_status = 'superseded' WHERE batch_id = %s"
                                " AND row_status IN ('new','valid','rejected')").format(sql.Identifier(table)),
                        (str(bid),))
            cur.execute("UPDATE sap_stage_batch SET status = 'discarded', warnings = warnings || %s::jsonb"
                        " WHERE batch_id = %s",
                        (Jsonb([{"level": "info", "code": "discarded", "msg": f"Discarded by {actor}."}]), str(bid)))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    _log("info", "SAP staging batch discarded", batch_id=str(bid), user=actor)
    return {"batch_id": str(bid), "status": "discarded"}


# ---------------------------------------------------------------------------
# Validate
# ---------------------------------------------------------------------------
def validate_batch(batch_id, *, conn=None) -> dict:
    """Validate a ready / validated / held batch: per-row verdicts (set-based writes), batch-level
    checks, header status (`validated` | `held` | `rejected`), counts and warnings. Re-runnable.
    With `conn` the caller owns commit/rollback; otherwise a pooled connection is committed here."""
    bid = _as_uuid(batch_id)
    if conn is not None:
        return _validate(conn, bid)
    with _pool.connection() as c:
        try:
            out = _validate(c, bid)
            c.commit()
            return out
        except Exception:
            c.rollback()
            raise


def _validate(conn, bid) -> dict:
    with conn.cursor() as cur:
        hdr = _load_header(cur, bid, lock=True)
        if hdr is None:
            raise KeyError(f"batch {bid} not found")
        if hdr["status"] not in _LIVE_STATUSES:
            raise BatchNotApplicable(f"batch is {hdr['status']} and cannot be validated", {"status": hdr["status"]})
        object_key, plant = hdr["object_key"], hdr["plant"]
        table = _spec(object_key)["stage_table"]
        rows = _fetch_rows(cur, table, bid, ("new", "valid", "rejected"))
        row_plants = {_text(r.get("werks") or r.get("plwrk") or r.get("plant")) for r in rows}
        known = _known_plants(cur, row_plants | {plant})

        if object_key == "stage_material_plants":
            results = validate_material_plant_rows(rows, plant, known)
        elif object_key == "stage_planned_orders":
            results = validate_planned_order_rows(rows, plant, known)
        else:
            results = _validate_routing_rows(object_key, rows, plant, known, conn)

        _write_row_results(cur, table, results, _RESOLVED_COLS[object_key])

        total = len(results)
        valid = sum(1 for r in results if r["status"] == "valid")
        by_reason: dict = {}
        for r in results:
            if r["reason"]:
                by_reason[r["reason"]] = by_reason.get(r["reason"], 0) + 1
        counts = {"total": total, "valid": valid, "rejected": total - valid, "by_reason": by_reason}
        warnings: list[dict] = []
        held: list[str] = []

        if object_key == "stage_planned_orders":
            sent = {r["resolved"]["production_order"] for r in results if r["resolved"].get("production_order")}
            info, gate_warnings, held, _ve = _planned_order_gates(cur, plant, sent)
            counts.update(info)
            warnings += gate_warnings
        elif total == 0:
            held.append("empty_snapshot")
            warnings.append({"level": "warn", "code": "empty_snapshot",
                             "msg": "The snapshot is empty; applying it would remove every unreferenced row."})

        if total > 0 and valid == 0:
            status, error = "rejected", "no valid rows in batch"
        elif held:
            status, error = "held", None
        else:
            status, error = "validated", None
        counts["held"] = bool(held)
        cur.execute(
            "UPDATE sap_stage_batch SET status = %s, counts = %s, warnings = %s, validated_at = now(), error = %s"
            " WHERE batch_id = %s", (status, Jsonb(counts), Jsonb(warnings), error, str(bid)))
    _log("info", "SAP staging batch validated", batch_id=str(bid), object_key=object_key,
         plant=plant, outcome=status)
    return {"batch_id": str(bid), "object_key": object_key, "plant": plant, "status": status,
            "counts": counts, "warnings": warnings, "held_reasons": held}


# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------
def apply_batch(batch_id, *, actor: str, confirm_held: bool = False) -> dict:
    """Apply a validated batch (or a held one with `confirm_held`; an `error` / crashed `applying` batch
    resumes). Raises KeyError (unknown), BatchSuperseded (a newer complete batch exists),
    BatchNotApplicable (wrong state, routing_required, another apply running, threshold re-tripped).
    Any failure inside the step ladder sets status `error` (`error` = '<step>: <message>') and re-raises."""
    bid = _as_uuid(batch_id)
    with _pool.connection() as conn:
        locked = False
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT pg_try_advisory_lock(hashtext(%s))", (f"sap:apply:{bid}",))
                locked = bool(cur.fetchone()[0])
            conn.commit()
            if not locked:
                raise BatchNotApplicable("another apply of this batch is running", {"status": "applying"})
            return _apply_locked(conn, bid, actor, confirm_held)
        finally:
            if locked:
                try:
                    conn.rollback()
                    with conn.cursor() as cur:
                        cur.execute("SELECT pg_advisory_unlock(hashtext(%s))", (f"sap:apply:{bid}",))
                    conn.commit()
                except Exception:
                    log.warning("could not release apply lock for batch %s", bid)


def _apply_locked(conn, bid, actor: str, confirm_held: bool) -> dict:
    with conn.cursor() as cur:
        hdr = _load_header(cur, bid, lock=True)
        if hdr is None:
            raise KeyError(f"batch {bid} not found")
        status, counts0 = hdr["status"], hdr["counts"]
        object_key, plant = hdr["object_key"], hdr["plant"]
        spec = _spec(object_key)
        if status == "held" and not confirm_held:
            raise BatchNotApplicable("batch is held and needs confirmation",
                                     {"status": status, "warnings": hdr["warnings"]})
        if status in ("error", "applying") and counts0.get("held") and not (
                confirm_held or counts0.get("confirmed_held")):
            raise BatchNotApplicable("batch was held and needs confirmation", {"status": status})
        if status not in ("validated", "held", "error", "applying"):
            raise BatchNotApplicable(f"batch is {status} and cannot be applied", {"status": status})
        cur.execute(
            "SELECT batch_id, status FROM sap_stage_batch WHERE object_key = %s AND plant = %s AND batch_id <> %s"
            " AND status = ANY(%s) AND received_at > (SELECT received_at FROM sap_stage_batch WHERE batch_id = %s)"
            " ORDER BY received_at DESC LIMIT 1",
            (object_key, plant, str(bid), ["ready", "validated", "held", "applying", "applied"], str(bid)))
        newer = cur.fetchone()
        if newer:
            raise BatchSuperseded("a newer complete batch exists for this object and plant",
                                  {"batch_id": str(bid), "newer_batch_id": str(newer[0]), "newer_status": newer[1]})
        if object_key == "stage_planned_orders" and status in ("validated", "held"):
            sent = _sent_order_numbers(cur, spec["stage_table"], bid)
            _info, _w, held_codes, _ve = _planned_order_gates(cur, plant, sent)
            if "routing_required" in held_codes:
                raise BatchNotApplicable("routing must be enabled with routings loaded before planned orders apply",
                                         {"code": "routing_required"})
            if "vanish_threshold" in held_codes and not (status == "held" and confirm_held):
                raise BatchNotApplicable("the vanish threshold is now exceeded; re-validate and confirm",
                                         {"code": "vanish_threshold"})
        cur.execute(
            "UPDATE sap_stage_batch SET status = 'applying', error = NULL, counts = counts || %s::jsonb"
            " WHERE batch_id = %s",
            (Jsonb({"step": "start", "confirmed_held": bool(confirm_held or counts0.get("confirmed_held"))}),
             str(bid)))
    conn.commit()

    state = {"step": "start"}

    def step(name: str) -> None:
        state["step"] = name
        with conn.cursor() as c:
            c.execute("UPDATE sap_stage_batch SET counts = counts || %s::jsonb WHERE batch_id = %s",
                      (Jsonb({"step": name}), str(bid)))
        conn.commit()

    try:
        branch = {"stage_material_plants": _apply_material_plants,
                  "stage_production_version": _apply_production_versions,
                  "stage_routing_operation": _apply_routing_operations,
                  "stage_planned_orders": _apply_planned_orders}[object_key]
        result = branch(conn, hdr, actor, step)
        with conn.cursor() as cur:
            cur.execute(sql.SQL("UPDATE {} SET row_status = 'applied', applied_at = now()"
                                " WHERE batch_id = %s AND row_status = 'valid'").format(
                sql.Identifier(spec["stage_table"])), (str(bid),))
            cur.execute("DELETE FROM sap_stage_batch WHERE object_key = %s AND plant = %s"
                        " AND status = 'applied' AND batch_id <> %s", (object_key, plant, str(bid)))
            cur.execute(
                "UPDATE sap_stage_batch SET status = 'applied', applied_at = now(), applied_by = %s, error = NULL,"
                " counts = counts || %s::jsonb WHERE batch_id = %s",
                (actor, Jsonb({**result, "step": "done"}), str(bid)))
        conn.commit()
    except Exception as exc:
        conn.rollback()
        msg = f"{state['step']}: {type(exc).__name__}: {exc}"[:2000]
        try:
            with conn.cursor() as cur:
                cur.execute("UPDATE sap_stage_batch SET status = 'error', error = %s WHERE batch_id = %s",
                            (msg, str(bid)))
            conn.commit()
        except Exception:
            conn.rollback()
            log.exception("could not record apply failure for batch %s", bid)
        _log("error", "SAP staging apply failed", exc=exc, batch_id=str(bid), object_key=object_key, plant=plant)
        raise
    _log("info", "SAP staging batch applied", batch_id=str(bid), object_key=object_key, plant=plant,
         user=actor, outcome="applied")
    return {"batch_id": str(bid), "object_key": object_key, "plant": plant, "status": "applied", "counts": result}


def _bulk_delete(table: str, keys: list[dict], actor: str) -> tuple[list[dict], list[dict]]:
    """Delete rows through md.bulk_apply in chunks; a chunk blocked by a reference (ValueError)
    is returned as 'blocked' so the caller can flag it instead. Returns (deleted_keys, blocked_keys)."""
    deleted, blocked = [], []
    for i in range(0, len(keys), 500):
        chunk = keys[i:i + 500]
        try:
            md.bulk_apply(table, {"upserts": [], "deletes": chunk}, actor)
            deleted += chunk
        except ValueError:
            blocked += chunk
    return deleted, blocked


def _apply_material_plants(conn, hdr, actor: str, step) -> dict:
    bid, plant = hdr["batch_id"], hdr["plant"]
    table = _spec(hdr["object_key"])["stage_table"]
    with conn.cursor() as cur:
        stage = _fetch_rows(cur, table, bid, ("valid",))
        warnings: list = []
        rows = build_material_plant_rows(stage, None, warnings)
        _append_warnings(cur, bid, warnings)
    conn.commit()
    present = sorted({r["material_id"] for r in rows})

    step("create_materials")
    created = 0
    with conn.cursor() as cur:
        if present:
            cur.execute("INSERT INTO materials (material_id) SELECT unnest(%s::text[])"
                        " ON CONFLICT (material_id) DO NOTHING", (present,))
            created = cur.rowcount or 0
    conn.commit()

    step("upsert")
    inserted = updated = 0
    for i in range(0, len(rows), _APPLY_CHUNK):
        res = md.bulk_apply("material_plants", {"upserts": rows[i:i + _APPLY_CHUNK], "deletes": []}, actor)
        inserted += int(res.get("inserted", 0))
        updated += int(res.get("updated", 0))

    step("clear_missing")
    with conn.cursor() as cur:
        if present:
            cur.execute("UPDATE material_plants SET sap_missing_since = NULL WHERE plant = %s"
                        " AND material_id = ANY(%s) AND sap_missing_since IS NOT NULL", (plant, present))
    conn.commit()

    step("absent")
    deleted = flagged = 0
    with conn.cursor() as cur:
        cur.execute("SELECT material_id FROM material_plants WHERE plant = %s AND material_id <> ALL(%s)",
                    (plant, present))
        absent = [r[0] for r in cur.fetchall()]
        referenced: set = set()
        if absent:
            cur.execute(
                "SELECT a.m FROM unnest(%s::text[]) AS a(m) WHERE"
                " EXISTS (SELECT 1 FROM orders o WHERE o.plant = %s AND o.material_number = a.m)"
                " OR EXISTS (SELECT 1 FROM bom_items b WHERE b.plant = %s AND (b.material_id = a.m OR b.component_id = a.m))"
                " OR EXISTS (SELECT 1 FROM production_version p WHERE p.plant = %s AND p.material_id = a.m)"
                " OR EXISTS (SELECT 1 FROM routing_operation r WHERE r.plant = %s AND r.material_id = a.m)",
                (absent, plant, plant, plant, plant))
            referenced = {r[0] for r in cur.fetchall()}
    conn.commit()
    unreferenced = [m for m in absent if m not in referenced]
    done, blocked = _bulk_delete("material_plants", [{"material_id": m, "plant": plant} for m in unreferenced], actor)
    deleted = len(done)
    to_flag = sorted(referenced | {k["material_id"] for k in blocked})
    if to_flag:
        with conn.cursor() as cur:
            cur.execute("UPDATE material_plants SET sap_missing_since = COALESCE(sap_missing_since, now())"
                        " WHERE plant = %s AND material_id = ANY(%s)", (plant, to_flag))
            flagged = cur.rowcount or 0
        conn.commit()
    return {"inserted": inserted, "updated": updated, "deleted": deleted, "flagged": flagged,
            "materials_created": created}


def _sent_routing_keys(cur, table: str, bid, object_key: str) -> set:
    """Normalised identities of every routing row SAP sent (valid or rejected, never deleted-flag /
    missing-key rows) -- the protection set for the absent-row sweeps."""
    import backend.routing.ingest as ingest
    cur.execute(sql.SQL("SELECT * FROM {} WHERE batch_id = %s AND row_status IN ('valid','rejected','applied')"
                        " AND COALESCE(reject_reason, '') NOT IN ('deleted_flag', 'missing_key',"
                        " 'plant_mismatch', 'unknown_plant')").format(
        sql.Identifier(table)), (str(bid),))
    names = [d.name for d in cur.description]
    keys = set()
    for rec in cur.fetchall():
        r = dict(zip(names, rec, strict=True))
        k = _routing_key(object_key, ingest, sap_sync._t_alpha_strip(r.get("material_id")), r)
        if k:
            keys.add(k)
    return keys


def _apply_production_versions(conn, hdr, actor: str, step) -> dict:
    import backend.routing.ingest as ingest
    import backend.routing.resolver as resolver
    import backend.routing.routes as routing_routes
    bid, plant, object_key = hdr["batch_id"], hdr["plant"], hdr["object_key"]
    table = _spec(object_key)["stage_table"]
    with conn.cursor() as cur:
        stage = _fetch_rows(cur, table, bid, ("valid",))
        sent = _sent_routing_keys(cur, table, bid, object_key)
        parse_rows = [_routing_parse_row(r, sap_sync._t_alpha_strip(r.get("material_id"))) for r in stage]
        ops, parse_warnings = ingest.parse_production_versions_rows(parse_rows, conn=conn, first_row=0)
    conn.commit()
    rejected_now = [w for w in parse_warnings if w.get("level") == "reject"]

    step("write")
    res = routing_routes.write_production_versions(ops, actor) if ops["upserts"] else {"inserted": 0, "updated": 0}
    present = [(u["material_id"], u["production_version"]) for u in ops["upserts"]]
    with conn.cursor() as cur:
        if present:
            cur.execute("UPDATE production_version SET sap_missing_since = NULL WHERE plant = %s"
                        " AND sap_missing_since IS NOT NULL AND (material_id, production_version) IN ("
                        " SELECT * FROM unnest(%s::text[], %s::text[]))",
                        (plant, [p[0] for p in present], [p[1] for p in present]))
    conn.commit()

    step("absent")
    deleted = flagged = 0
    with conn.cursor() as cur:
        cur.execute("SELECT material_id, production_version, task_list_type, routing_group, group_counter"
                    " FROM production_version WHERE plant = %s", (plant,))
        live = cur.fetchall()
        absent = [r for r in live if (plant, r[0], r[1]) not in sent]
        order_refs: set = set()
        routing_refs: set = set()
        if absent:
            mats = sorted({r[0] for r in absent})
            cur.execute("SELECT DISTINCT material_number, production_version FROM orders"
                        " WHERE plant = %s AND material_number = ANY(%s) AND production_version IS NOT NULL",
                        (plant, mats))
            order_refs = {(r[0], r[1]) for r in cur.fetchall()}
            cur.execute("SELECT DISTINCT material_id, task_list_type, routing_group, group_counter"
                        " FROM routing_operation WHERE plant = %s AND material_id = ANY(%s)", (plant, mats))
            routing_refs = {tuple(r) for r in cur.fetchall()}
    conn.commit()
    unref, ref = [], []
    for r in absent:
        in_use = (r[0], r[1]) in order_refs or (r[2] is not None and (r[0], r[2], r[3], r[4]) in routing_refs)
        (ref if in_use else unref).append(r)
    done, blocked = _bulk_delete(
        "production_version",
        [{"plant": plant, "material_id": r[0], "production_version": r[1]} for r in unref], actor)
    deleted = len(done)
    flag = [(r[0], r[1]) for r in ref] + [(k["material_id"], k["production_version"]) for k in blocked]
    if flag:
        with conn.cursor() as cur:
            cur.execute("UPDATE production_version SET sap_missing_since = COALESCE(sap_missing_since, now())"
                        " WHERE plant = %s AND (material_id, production_version) IN ("
                        " SELECT * FROM unnest(%s::text[], %s::text[]))",
                        (plant, [f[0] for f in flag], [f[1] for f in flag]))
            flagged = cur.rowcount or 0
        conn.commit()

    step("recompute")
    resolver.recompute_plants([plant])
    return {"inserted": int(res.get("inserted", 0)), "updated": int(res.get("updated", 0)),
            "deleted": deleted, "flagged": flagged, "rejected_at_apply": len(rejected_now)}


def _apply_routing_operations(conn, hdr, actor: str, step) -> dict:
    import backend.routing.ingest as ingest
    import backend.routing.resolver as resolver
    import backend.routing.routes as routing_routes
    bid, plant, object_key = hdr["batch_id"], hdr["plant"], hdr["object_key"]
    table = _spec(object_key)["stage_table"]
    with conn.cursor() as cur:
        stage = _fetch_rows(cur, table, bid, ("valid",))
        sent = _sent_routing_keys(cur, table, bid, object_key)
        parse_rows = [_routing_parse_row(r, sap_sync._t_alpha_strip(r.get("material_id"))) for r in stage]
        groups, parse_warnings = ingest.parse_routing_operations_rows(parse_rows, conn=conn, first_row=0)
    conn.commit()
    rejected_now = [w for w in parse_warnings if w.get("level") == "reject"]

    step("write")
    inserted = routing_routes.write_operation_groups(groups, actor) if groups else 0

    step("delete_absent")
    # A routing is identified by (material, type, group, counter) within the plant (the PK adds the
    # operation); anything SAP did not send is deleted -- dependent orders go on hold at recompute.
    keys = sorted({(k[1], k[2], k[3], k[4]) for k in sent})
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM routing_operation ro WHERE ro.plant = %s AND NOT EXISTS ("
            " SELECT 1 FROM unnest(%s::text[], %s::text[], %s::text[], %s::text[]) AS k(m, t, g, c)"
            " WHERE k.m = ro.material_id AND k.t = ro.task_list_type AND k.g = ro.routing_group"
            " AND k.c = ro.group_counter)",
            (plant, [k[0] for k in keys], [k[1] for k in keys], [k[2] for k in keys], [k[3] for k in keys]))
        deleted = cur.rowcount or 0
        if deleted:
            cur.execute("INSERT INTO admin_audit (table_name, action, details, user_email)"
                        " VALUES ('routing_operation', 'sap_staging_absent_delete', %s, %s)",
                        (Jsonb({"plant": plant, "batch_id": bid, "rows_deleted": deleted}), actor))
    conn.commit()

    step("recompute")
    resolver.recompute_plants([plant])
    return {"inserted": inserted, "deleted": deleted, "rejected_at_apply": len(rejected_now)}


def _apply_planned_orders(conn, hdr, actor: str, step) -> dict:
    import backend.distribution.data as distribution_data
    import backend.routing.resolver as routing_resolver
    import backend.setup.data as setup_data
    bid, plant = hdr["batch_id"], hdr["plant"]
    table = _spec(hdr["object_key"])["stage_table"]
    with conn.cursor() as cur:
        stage = _fetch_rows(cur, table, bid, ("valid",))
        sent = _sent_order_numbers(cur, table, bid)
        tz = _plant_info(cur, plant)["timezone"]
        cur.execute("SELECT EXISTS (SELECT 1 FROM upload_audit WHERE batch_id = %s)", (bid,))
        audit_taken = bool(cur.fetchone()[0])
    conn.commit()
    warnings: list = []
    rows, problems = build_order_rows(stage, tz, None, warnings)
    zero_keys = zero_open_keys(rows)
    for r in rows:
        r.pop("_stage_row_id", None)
        r.pop("_zero_open", None)

    step("setup_capture")
    setup_data.capture_setup_states_before_schedule_mutation(
        actor=actor, reason="SAP staging apply", plants=[plant])

    step("upsert")
    # upload_audit.batch_id is a primary key: a resumed apply must not reuse the stage batch id.
    upsert_batch = str(uuid.uuid4()) if audit_taken else bid
    if rows:
        result = db.upsert_orders(rows, source="sap", batch_id=upsert_batch, raw_row_count=len(stage),
                                  warnings=warnings,
                                  plan_fn=distribution_data.plan, apply_fn=distribution_data.apply,
                                  resolve_fn=routing_resolver.resolve_orders)
    else:
        result = {"status": "ok", "inserted": 0, "updated": 0, "unchanged": 0}
    if result.get("status") not in (None, "ok"):
        raise RuntimeError(f"orders upsert returned {result.get('status')!r}")

    step("zero_open")
    flagged = 0
    if zero_keys:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM orders WHERE plant = %s AND (production_order = ANY(%s)"
                " OR parent_production_order = ANY(%s)) AND (planning_status IS DISTINCT FROM 'needs_planning'"
                " OR COALESCE(planning_reason->>'code', '') <> 'zero_open_quantity') ORDER BY id FOR UPDATE",
                (plant, zero_keys, zero_keys))
            ids = [r[0] for r in cur.fetchall()]
            if ids:
                cur.execute("DELETE FROM order_schedule_segments WHERE order_id = ANY(%s)", (ids,))
                cur.execute(
                    "UPDATE orders SET planning_status = 'needs_planning', planning_reason = %s,"
                    " scheduled_start = NULL, scheduled_end = NULL, manual_firmed = FALSE, updated_at = NOW()"
                    " WHERE id = ANY(%s)", (Jsonb(_ZERO_OPEN_REASON), ids))
                flagged = len(ids)
        conn.commit()

    step("vanish")
    deleted = archived = 0
    info = {"in_horizon_live": 0, "vanish_candidates": 0}
    with conn.cursor() as cur:
        visibility_end, _frozen = db._horizon_bounds_for_plant(cur, plant)
        ids = _vanish_candidates(cur, plant, sent, visibility_end)
        if visibility_end is not None:
            bound = visibility_end + timedelta(days=1)
            cur.execute("SELECT count(*) FROM orders WHERE plant = %s AND " + _in_horizon_predicate(),
                        (plant, bound))
            info["in_horizon_live"] = int(cur.fetchone()[0])
    conn.commit()
    if ids:
        pct = round(len(ids) / info["in_horizon_live"], 4) if info["in_horizon_live"] else 0.0
        purge = db.purge_orders_by_ids(
            plant, ids, user_email=actor, reason="sap_snapshot_vanish", archive_batch_id=bid,
            extra_details={"candidates": len(ids), "in_horizon": info["in_horizon_live"], "pct": pct})
        deleted, archived = int(purge.get("deleted", 0)), int(purge.get("archived", 0))
    with conn.cursor() as cur:
        _append_warnings(cur, bid, [w for w in warnings if w.get("level") != "info"][:50])
    conn.commit()
    return {"inserted": int(result.get("inserted", 0)), "updated": int(result.get("updated", 0)),
            "unchanged": int(result.get("unchanged", 0)), "deleted": deleted, "archived": archived,
            "flagged": flagged, "rows_not_built": len(problems)}


# ---------------------------------------------------------------------------
# Poll
# ---------------------------------------------------------------------------
def poll_once(*, actor: str = "sap-staging-poll") -> dict:
    """One poll pass (advisory-locked, acquire-or-skip): expire stale loading, take each complete `ready`
    batch (newest per object + plant wins, older ones superseded), validate it, apply it when its object
    is in `auto` mode and it validated clean; objects in APPLY_ORDER; then the retention sweeps. Never raises.
    Returns {processed, applied, held, skipped, errors}."""
    out: dict = {"processed": [], "applied": [], "held": [], "skipped": [], "errors": []}
    try:
        with _pool.connection() as conn:
            got = False
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT pg_try_advisory_lock(hashtext('sap:staging-poll'))")
                    got = bool(cur.fetchone()[0])
                conn.commit()
                if not got:
                    out["skipped"].append({"reason": "another poll is running"})
                    return out
                _poll_locked(conn, actor, out)
            finally:
                if got:
                    try:
                        conn.rollback()
                        with conn.cursor() as cur:
                            cur.execute("SELECT pg_advisory_unlock(hashtext('sap:staging-poll'))")
                        conn.commit()
                    except Exception:
                        log.warning("could not release the staging poll lock")
    except Exception as exc:
        out["errors"].append({"error": f"{type(exc).__name__}: {exc}"})
        _log("error", "SAP staging poll failed", exc=exc)
    return out


def _poll_locked(conn, actor: str, out: dict) -> None:
    try:
        with conn.cursor() as cur:
            n = expire_stale_loading(cur)
        conn.commit()
        if n:
            out["processed"].append({"expired_loading": n})
    except Exception as exc:
        conn.rollback()
        out["errors"].append({"step": "expire_stale_loading", "error": str(exc)})

    for object_key in APPLY_ORDER:
        try:
            table = _spec(object_key)["stage_table"]
            with conn.cursor() as cur:
                cur.execute(
                    sql.SQL("SELECT b.batch_id, b.plant, b.status, b.row_count_expected,"
                            " COALESCE(b.ready_at, b.received_at),"
                            " (SELECT count(*) FROM {t} s WHERE s.batch_id = b.batch_id)"
                            " FROM sap_stage_batch b WHERE b.object_key = %s AND b.status IN ('ready','validated')"
                            " ORDER BY b.plant, b.received_at DESC").format(t=sql.Identifier(table)),
                    (object_key,))
                candidates = cur.fetchall()
            conn.commit()
        except Exception as exc:
            conn.rollback()
            out["errors"].append({"object_key": object_key, "error": str(exc)})
            continue
        seen_plants: set = set()
        for bid, plant, status, expected, ready_at, actual in candidates:
            if plant in seen_plants:
                continue            # older than the newest of this plant; superseded below
            try:
                if status == "ready" and (expected is None or int(actual) != int(expected)):
                    age = datetime.now(ready_at.tzinfo) - ready_at
                    if age > timedelta(minutes=LOADING_TIMEOUT_MIN):
                        with conn.cursor() as cur:
                            cur.execute(
                                "UPDATE sap_stage_batch SET status = 'rejected', error = %s,"
                                " warnings = warnings || %s::jsonb WHERE batch_id = %s",
                                (f"incomplete rows: expected {expected}, found {actual}",
                                 Jsonb([{"level": "error", "code": "incomplete_rows",
                                         "msg": f"Expected {expected} rows but found {actual}."}]), str(bid)))
                        conn.commit()
                        out["processed"].append({"batch_id": str(bid), "object_key": object_key,
                                                 "plant": plant, "status": "rejected"})
                    else:
                        out["skipped"].append({"batch_id": str(bid), "object_key": object_key,
                                               "reason": "row count not yet complete"})
                    continue
                seen_plants.add(plant)
                with conn.cursor() as cur:
                    supersede_older(cur, object_key, plant, bid)
                conn.commit()
                result = {"status": status}
                if status == "ready":
                    result = validate_batch(bid)
                out["processed"].append({"batch_id": str(bid), "object_key": object_key, "plant": plant,
                                         "status": result["status"]})
                if result["status"] == "held":
                    out["held"].append({"batch_id": str(bid), "object_key": object_key, "plant": plant})
                elif (result["status"] == "validated"
                      and sap_sync.get_config(object_key).get("apply_mode") == "auto"):
                    applied = apply_batch(bid, actor=actor)
                    out["applied"].append({"batch_id": str(bid), "object_key": object_key, "plant": plant,
                                           "counts": applied.get("counts")})
            except BatchNotApplicable as exc:
                conn.rollback()
                out["skipped"].append({"batch_id": str(bid), "object_key": object_key, "reason": str(exc)})
            except Exception as exc:
                conn.rollback()
                out["errors"].append({"batch_id": str(bid), "object_key": object_key,
                                      "error": f"{type(exc).__name__}: {exc}"})
                _log("error", "SAP staging poll: batch failed", exc=exc, batch_id=str(bid), object_key=object_key)

    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM sap_stage_vanished_order WHERE deleted_at < now() - make_interval(days => %s)",
                        (ARCHIVE_RETENTION_DAYS,))
            cur.execute("DELETE FROM sap_stage_planned_order_out WHERE row_status = 'sent'"
                        " AND sent_at < now() - make_interval(days => %s)", (SENT_RETENTION_DAYS,))
            cur.execute("DELETE FROM sap_stage_batch WHERE status IN ('rejected','discarded','superseded')"
                        " AND received_at < now() - make_interval(days => %s)", (DEAD_BATCH_RETENTION_DAYS,))
        conn.commit()
    except Exception as exc:
        conn.rollback()
        out["errors"].append({"step": "sweeps", "error": str(exc)})


# ---------------------------------------------------------------------------
# Excel / CSV upload into staging (never applies)
# ---------------------------------------------------------------------------
def _coerce_for_column(value, data_type: str):
    """Python value for a stage column of SQL `data_type`; ValueError when it does not fit."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    s = str(value).strip()
    if s == "" or s.lower() in ("nan", "nat", "none"):
        return None
    if data_type in ("numeric", "integer", "bigint", "smallint", "double precision", "real"):
        d = _dec(s)
        return int(d) if data_type in ("integer", "bigint", "smallint") and d is not None else d
    if data_type == "date":
        d = _parse_sap_date(s)
        return d
    if data_type == "boolean":
        return s.upper() in ("X", "TRUE", "T", "1", "Y", "YES")
    return s


def stage_rows_from_upload(object_key: str, plant: str, file_bytes: bytes, filename: str, *, actor: str) -> dict:
    """Excel/CSV with SAP column headers -> a `source='upload'` batch (rows staged, `ready`, then validated).
    NEVER applies. Headers are normalised (`db.clean`, lower-cased); headers that are not columns of the
    stage table are ignored with a warning; rows whose values do not fit their column (bad number / date)
    are skipped with a warning and are not staged. Raises ValueError for an unusable file/object/plant."""
    spec = _spec(object_key)
    plant = (plant or "").strip()
    if not plant:
        raise ValueError("plant is required")
    table = spec["stage_table"]
    try:
        if str(filename or "").lower().endswith(".csv"):
            df = pd.read_csv(io.BytesIO(file_bytes), dtype=str, keep_default_na=False)
        else:
            df = pd.read_excel(io.BytesIO(file_bytes), dtype=str)
    except Exception as exc:
        raise ValueError(f"Could not read the file: {exc}") from exc
    if len(df) == 0:
        raise ValueError("The file has no data rows")
    df = db.clean(df)
    df.columns = [str(c).lower() for c in df.columns]

    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = %s", (table,))
        types = {r[0]: r[1] for r in cur.fetchall()}
        allowed = {c: t for c, t in types.items()
                   if c not in _HOUSEKEEPING_COLS and c not in _RESOLVED_COLS[object_key]}
        warnings: list[dict] = []
        unknown = sorted(c for c in df.columns if c not in allowed)
        if unknown:
            warnings.append({"level": "warn", "code": "unknown_columns",
                             "msg": f"Ignored column(s) that are not part of this staging table: {', '.join(unknown)}"})
        cols = [c for c in df.columns if c in allowed]
        if not cols:
            raise ValueError("None of the file's columns match this staging table")
        staged: list[list] = []
        skipped = 0
        samples: list[str] = []
        for pos, rec in enumerate(df[cols].to_dict("records"), start=2):
            try:
                staged.append([_coerce_for_column(rec[c], allowed[c]) for c in cols])
            except ValueError as exc:
                skipped += 1
                if len(samples) < 5:
                    samples.append(f"row {pos}: {exc}")
        if skipped:
            warnings.append({"level": "warn", "code": "rows_not_staged", "count": skipped,
                             "msg": f"{skipped} row(s) not staged (" + "; ".join(samples) + ")"})
        if not staged:
            raise ValueError("No row could be staged: " + "; ".join(samples))
        try:
            cur.execute("INSERT INTO sap_stage_batch (object_key, plant, source, status, created_by)"
                        " VALUES (%s, %s, 'upload', 'loading', %s) RETURNING batch_id", (object_key, plant, actor))
            bid = cur.fetchone()[0]
            cur.executemany(
                sql.SQL("INSERT INTO {t} (batch_id, {cols}) VALUES (%s, {ph})").format(
                    t=sql.Identifier(table), cols=sql.SQL(", ").join(sql.Identifier(c) for c in cols),
                    ph=sql.SQL(", ").join(sql.Placeholder() * len(cols))),
                [[bid, *vals] for vals in staged])
            cur.execute("UPDATE sap_stage_batch SET status = 'ready', ready_at = now(), row_count_expected = %s,"
                        " warnings = %s WHERE batch_id = %s", (len(staged), Jsonb(warnings), str(bid)))
            supersede_older(cur, object_key, plant, bid)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    validation = validate_batch(bid)
    # Keep the upload's own warnings alongside validation's.
    with _pool.connection() as conn, conn.cursor() as cur:
        _append_warnings(cur, bid, warnings)
        conn.commit()
    _log("info", "SAP staging upload staged", batch_id=str(bid), object_key=object_key, plant=plant,
         user=actor, outcome=validation["status"])
    return {"batch_id": str(bid), "object_key": object_key, "plant": plant, "rows_staged": len(staged),
            "rows_skipped": skipped, "warnings": warnings, "status": validation["status"],
            "validation": validation}


# ---------------------------------------------------------------------------
# Vanish archive
# ---------------------------------------------------------------------------
def list_archived(plant: str, *, limit: int = 200) -> list[dict]:
    """Vanish-deleted orders of a plant (newest first; restored ones carry `restored_at`)."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, batch_id, plant, order_id, order_row->>'production_order', order_row->>'material_number',"
            " order_row->>'machine', deleted_at, deleted_by, restored_at, restored_by"
            " FROM sap_stage_vanished_order WHERE plant = %s ORDER BY deleted_at DESC, id DESC LIMIT %s",
            (plant, int(limit)))
        return [{"id": int(r[0]), "batch_id": str(r[1]) if r[1] else None, "plant": r[2], "order_id": r[3],
                 "production_order": r[4], "material_number": r[5], "machine": r[6],
                 "deleted_at": _iso(r[7]), "deleted_by": r[8], "restored_at": _iso(r[9]), "restored_by": r[10]}
                for r in cur.fetchall()]


def restore_archived(archive_id: int, *, actor: str) -> dict:
    """Restore one archived order (KeyError when missing / already restored)."""
    return db.restore_vanished_order(int(archive_id), user_email=actor)
