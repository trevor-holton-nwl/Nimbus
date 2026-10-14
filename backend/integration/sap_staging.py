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
from db import finish_echoes  # noqa: F401 -- the one echo rule lives in db.py beside sap_changed_fields

log = logging.getLogger("nimbus.sap")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
def env_int(name: str, default: int, minimum: int) -> int:
    """Integer env knob that can never stop the app booting: unset / blank -> `default`; a value that
    is not an integer -> `default` with a warning; anything below `minimum` -> `minimum`."""
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        log.warning("%s=%r is not an integer; using %s", name, raw, default)
        return default
    if value < minimum:
        log.warning("%s=%r is below the minimum; using %s", name, raw, minimum)
    return max(minimum, value)


VANISH_HOLD_PCT = 0.25                      # more than 25 % of in-horizon orders vanishing -> held
FROZEN_SET_TOLERANCE_PCT = 0.05             # a confirmed apply tolerates this much growth of the reviewed deletion set ...
FROZEN_SET_TOLERANCE_ROWS = 5               # ... or this many rows, whichever is larger
_FROZEN_KEYS_CAP = 5000                     # deletion keys stored in counts at validation
_AUDIT_KEYS_CAP = 200                       # deleted keys written into one admin_audit row
LOADING_TIMEOUT_MIN = env_int("NIMBUS_SAP_STAGING_LOADING_TIMEOUT_MIN", 120, 1)
# The pool's 30 s statement_timeout (db.py) is far too short for a snapshot validate / sweep of tens of
# thousands of rows; this module's own connections raise it. (db.upsert_orders / md.bulk_apply run on their
# own pooled connections and keep the pool default.)
STATEMENT_TIMEOUT_MS = env_int("NIMBUS_SAP_STAGING_STATEMENT_TIMEOUT_MS", 600000, 1000)
SAP_SYSTEM_TZ = os.getenv("NIMBUS_SAP_SYSTEM_TZ", "UTC")
ARCHIVE_RETENTION_DAYS = 30
SENT_RETENTION_DAYS = 30                    # outbound `sent` and `error` rows
DEAD_BATCH_RETENTION_DAYS = 7               # rejected / discarded / superseded batches
APPLY_ORDER = ("stage_material_plants", "stage_production_version",
               "stage_routing_operation", "stage_planned_orders")

_MATERIAL_ID_MAX = 18                       # materials / material_plants.material_id VARCHAR(18)
_PLANT_MAX = 10                             # material_plants.plant VARCHAR(10)
# staging column -> longest value its live target accepts (material_plants.status_pl is VARCHAR(2)).
_MATERIAL_PLANT_MAX_LEN = {"mmsta": 2}
_APPLY_CHUNK = 2000                        # rows per md.bulk_apply call
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
_REFERENCE_BLOCKED = "is referenced by or references other rows"     # md.bulk_apply's FK-violation ValueError
_ZERO_OPEN_REASON = {"code": "zero_open_quantity",
                     "message": "Open quantity is zero; nothing left to produce"}


class BatchNotApplicable(Exception):
    """The batch cannot be validated / applied in its current state. `.detail`
    carries a machine-readable dict for the route layer."""

    def __init__(self, message: str, detail: dict | None = None, *, code: str | None = None):
        super().__init__(message)
        self.detail = dict(detail or {})
        if code:
            self.detail["code"] = code
        self.detail.setdefault("message", message)


class BatchSuperseded(BatchNotApplicable):
    """A newer complete batch exists for the same object + plant (HTTP 409)."""


def _log(level: str, msg: str, **ctx) -> None:
    """Structured event via brain's ring buffer when importable, else logging."""
    try:
        from backend.admin_ops.logbuffer import _log_event
        _log_event(level, "sap_staging", msg, **ctx)
    except Exception:
        exc = ctx.get("exc")
        extra = {k: v for k, v in ctx.items() if k != "exc" and v is not None}
        getattr(log, {"warn": "warning"}.get(level, level), log.info)(
            "%s %s" % (msg, extra) if extra else msg, exc_info=exc if isinstance(exc, BaseException) else None)


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


def sap_system_tz_invalid() -> bool:
    """True when `NIMBUS_SAP_SYSTEM_TZ` does not name a usable IANA zone (unknown or blank). Conversion then
    silently does nothing, which would shift every SAP date by the real zone's offset, so validation warns
    on every batch (`sap_system_tz_invalid`) and planned-order apply / Send to SAP refuse until it is fixed."""
    return _zone(SAP_SYSTEM_TZ) is None


_SAP_SYSTEM_TZ_MSG = ("NIMBUS_SAP_SYSTEM_TZ is not a valid time zone name, so SAP dates and times cannot be "
                      "converted; planned orders and Send to SAP are refused until it is fixed.")
if sap_system_tz_invalid():
    log.warning("%s (NIMBUS_SAP_SYSTEM_TZ=%r)", _SAP_SYSTEM_TZ_MSG, SAP_SYSTEM_TZ)


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


def _int_or_none(v, field: str, *, round_fraction: bool = False) -> int | None:
    """Blank -> None; a finite whole number -> int. inf / NaN / junk and (unless `round_fraction`) a
    fractional value raise ValueError ('... is not a valid integer', mapped to `invalid_int`). Goes through
    `_dec`, so there is no float round trip and no OverflowError."""
    s = _text(v)
    if s is None:
        return None
    try:
        d = _dec(s)
    except ValueError as exc:
        raise ValueError(f"{field!r} is not a valid integer: {v!r}") from exc
    if d is None:
        return None
    if d != d.to_integral_value() and not round_fraction:
        raise ValueError(f"{field!r} is not a valid integer: {v!r}")
    return int(d.to_integral_value())


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
                # Fractions round (documented `lot_size_rounded` warning); inf / NaN never get here (the
                # validator rejects them as invalid_int) but are dropped rather than crashing the batch.
                try:
                    val = _dec(row[col])
                    ival = _int_or_none(val, col, round_fraction=True)
                except ValueError:
                    row[col] = None
                    continue
                if val is not None and val != val.to_integral_value():
                    rounded += 1
                row[col] = ival
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
                finish_time = sr.get("pedti") if "pedti" in amap else None
                row["basic_finish_date"] = sap_to_plant_local(sr.get("pedtr"), finish_time, plant_tz)
                # SAP sent no time (date only): the echo rule compares dates, not minutes. Transient row
                # attribute: never an orders column, never reaches the INSERT.
                row["_finish_date_only"] = _parse_sap_time(finish_time) is None
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
    missing_key, plant_mismatch, unknown_plant, key_too_long, value_too_long:<staging column> (a value
    longer than the VARCHAR(n) it lands in, `_MATERIAL_PLANT_MAX_LEN`), invalid_int (a non-finite or
    non-numeric lot size), duplicate_key."""
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
        else:
            for col, limit in _MATERIAL_PLANT_MAX_LEN.items():
                v = _text(r.get(col))
                if v is not None and len(v) > limit:
                    reason = f"value_too_long:{col}"
                    break
            if reason is None:
                for col in ("minls", "ltinc"):          # lot sizes: a non-finite / non-numeric value is invalid_int
                    try:
                        _int_or_none(r.get(col), col, round_fraction=True)
                    except ValueError:
                        reason = "invalid_int"
                        break
        results.append({"id": r["id"], "reason": reason, "resolved": {"material_id": mat, "plant": pl}})
    return _finalize(results, lambda x: (x["resolved"]["material_id"], x["resolved"]["plant"]))


def validate_planned_order_rows(rows: list[dict], header_plant: str, known_plants: set) -> list[dict]:
    """Row verdicts for a planned-order batch. Reasons: missing_key (incl. an all-zero order number),
    plant_mismatch, unknown_plant, invalid_date (a missing or malformed finish, or a malformed start; a missing
    start is valid), invalid_time, invalid_number,
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
        elif len(mat) > _MATERIAL_ID_MAX or len(pl) > _PLANT_MAX:
            reason = "key_too_long"         # `orders.material_number` is TEXT, but no master row can ever match it
        if reason is None:
            try:
                _parse_sap_date(r.get("psttr"))     # the start is optional: absent is fine, malformed is not
                if _parse_sap_date(r.get("pedtr")) is None:
                    reason = "invalid_date"     # a missing finish (the finish is required, stored as received)
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
    d["plant"] = (d["plant"] or "").strip()       # Mulesoft may pad the header plant; rows are compared trimmed
    for k in ("received_at", "ready_at", "validated_at", "applied_at"):
        d[k] = _iso(d[k])
    # `vanish_keys` (the reviewed deletion keys, up to 5000) stay in the database row for forensics but are
    # not shipped with every header / list response; `held_deletions` serves the live list.
    d["counts"] = {k: v for k, v in (d["counts"] or {}).items() if k != "vanish_keys"}
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
    """The vanish key (backward scheduling OQ26/OQ27): the SAP start as first received, locked against
    echoes. Callers alias `orders` as `o`."""
    return db._SAP_START_RECEIVED_SQL + " <= %s"


def _absent_predicate(column: str, values) -> tuple[str, tuple]:
    """SQL fragment + params for "`column` is not one of `values`". An EMPTY list (a 0-row snapshot) becomes
    plain TRUE instead of relying on how the driver types an empty array for `<> ALL(%s)`."""
    values = sorted(values)
    if not values:
        return "TRUE", ()
    return f"{column} <> ALL(%s)", (values,)


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
        absent_sql, absent_params = _absent_predicate("COALESCE(parent_production_order, production_order)",
                                                      order_numbers)
        cur.execute(
            f"SELECT count(*), count(*) FILTER (WHERE {absent_sql}) FROM orders o WHERE plant = %s AND "
            + _in_horizon_predicate(),
            (*absent_params, plant, bound))
        live, cand = (int(x or 0) for x in cur.fetchone())
        is_held, pct = vanish_gate(live, cand)
        if is_held:
            held.append("vanish_threshold")
            warnings.append({"level": "warn", "code": "vanish_threshold",
                             "msg": (f"{cand} of {live} in-horizon orders ({pct:.0%}) are missing from this "
                                     f"snapshot; more than {VANISH_HOLD_PCT:.0%} needs admin confirmation.")})
    return ({"in_horizon_live": live, "vanish_candidates": cand, "vanish_pct": round(pct, 4),
             "horizon_end_present": visibility_end is not None},
            warnings, held, visibility_end)


def _vanish_candidates(cur, plant: str, order_numbers: set, visibility_end: datetime | None,
                       *, detail: bool = False) -> list:
    """Orders (whole distribution families) that a planned-order apply deletes: in horizon and absent
    from `order_numbers`. Ids only, or detail dicts when `detail`."""
    if visibility_end is None:
        return []
    bound = visibility_end + timedelta(days=1)
    absent_sql, absent_params = _absent_predicate("COALESCE(parent_production_order, production_order)",
                                                  order_numbers)
    cur.execute(
        "SELECT id, parent_production_order FROM orders o WHERE plant = %s AND " + _in_horizon_predicate()
        + f" AND {absent_sql}",
        (plant, bound, *absent_params))
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
        "SELECT o.id, o.production_order, o.material_number, o.machine, o.scheduled_start, o.scheduled_end,"
        " o.manual_firmed, o.firming_indicator, o.parent_production_order, o.planning_status,"
        " o.basic_start_date, o.basic_finish_date, o.run_time, seg.first_start, seg.last_end"
        " FROM orders o " + db._SCHEDULE_SEGMENTS_LATERAL_SQL +
        " WHERE o.plant = %s AND o.id = ANY(%s) ORDER BY o.production_order, o.id", (plant, ids_sorted))
    rows = cur.fetchall()
    cur.execute("SELECT MIN(timezone) FROM plants WHERE plant = %s", (plant,))
    now = db._plant_local_now(cur.fetchone()[0])
    out = []
    for r in rows:
        b = {"planning_status": r[9], "scheduled_start": r[4], "scheduled_end": r[5], "basic_start_date": r[10],
             "basic_finish_date": r[11], "run_time": r[12], "first_start": r[13], "last_end": r[14]}
        # D21: a vanished order is deleted even while running; flag it so the review can say so.
        out.append({"id": r[0], "production_order": r[1], "material_number": r[2], "machine": r[3],
                    "scheduled_start": _iso(r[4]), "scheduled_end": _iso(r[5]), "manual_firmed": bool(r[6]),
                    "firming_indicator": r[7], "parent_production_order": r[8],
                    "running": bool(db._order_is_running(b, now))})
    return out


def _sent_order_numbers(cur, table: str, batch_id) -> set:
    cur.execute(sql.SQL("SELECT DISTINCT production_order FROM {} WHERE batch_id = %s"
                        " AND production_order IS NOT NULL").format(sql.Identifier(table)), (str(batch_id),))
    return {r[0] for r in cur.fetchall()}


def check_batch_complete(source: str | None, expected, actual) -> None:
    """Completeness gate (H2). A Mulesoft batch is only usable when `row_count_expected` was set and equals
    the number of staged rows -- otherwise a half-loaded snapshot would look like a mass deletion. Upload
    batches keep today's behaviour (NIMBUS set the count itself). Raises BatchNotApplicable(incomplete_rows)."""
    if source != "mulesoft":
        return
    if expected is None or int(expected) != int(actual):
        raise BatchNotApplicable(
            f"the batch is incomplete: expected {'no count' if expected is None else expected} rows, "
            f"found {actual}", code="incomplete_rows")


def _stage_row_count(cur, table: str, bid) -> int:
    cur.execute(sql.SQL("SELECT count(*) FROM {} WHERE batch_id = %s").format(sql.Identifier(table)), (str(bid),))
    return int(cur.fetchone()[0])


def should_auto_apply(source: str | None, status: str, apply_mode: str | None) -> bool:
    """Only a clean `validated` Mulesoft batch of an `auto` object is applied by the poll; an Excel/CSV upload
    batch is never auto-applied (D18)."""
    return status == "validated" and apply_mode == "auto" and source != "upload"


def vanish_set_exceeded(stored, current) -> bool:
    """True when the live deletion candidates have grown past what the admin reviewed (M2): more than
    `stored` + max(FROZEN_SET_TOLERANCE_ROWS, FROZEN_SET_TOLERANCE_PCT * stored)."""
    stored, current = int(stored or 0), int(current or 0)
    return current - stored > max(FROZEN_SET_TOLERANCE_ROWS, FROZEN_SET_TOLERANCE_PCT * stored)


# --- master-object (material plant / production version / routing) snapshot deletions ----------------
_MASTER_LABEL = {"stage_material_plants": "material-plant rows", "stage_production_version": "production versions",
                 "stage_routing_operation": "routings"}


def _sent_material_ids(cur, table: str, bid) -> set:
    """Material ids of EVERY row SAP sent (valid or rejected), the protection set of the material-plant
    absent sweep. A row is protected whenever its material resolved (`material_id IS NOT NULL`) -- even a
    `missing_key` row (e.g. a blank plant column): SAP did send that material, and a half-filled row must not
    make the sweep delete the live row. Rows for another / unknown plant and over-long keys stay unprotected.
    (Unlike `_sent_order_numbers`, which takes every order number, and `_sent_routing_keys`, which protects
    the routing group.)"""
    cur.execute(sql.SQL("SELECT DISTINCT material_id FROM {} WHERE batch_id = %s AND material_id IS NOT NULL"
                        " AND row_status IN ('valid','rejected','applied') AND COALESCE(reject_reason, '')"
                        " NOT IN ('plant_mismatch', 'unknown_plant', 'key_too_long')").format(
        sql.Identifier(table)), (str(bid),))
    return {r[0] for r in cur.fetchall()}


def master_vanish_stats(live: set, protect: set) -> tuple[int, list, bool, float]:
    """(live_count, absent_keys_sorted, held, fraction) for a master-object snapshot: `absent` = live keys
    SAP did not send. Held on the same 25 % rule as planned orders (`vanish_gate`)."""
    absent = sorted(live - protect)
    held, pct = vanish_gate(len(live), len(absent))
    return len(live), absent, held, pct


def _master_live_keys(cur, object_key: str, plant: str) -> set:
    if object_key == "stage_material_plants":
        cur.execute("SELECT material_id FROM material_plants WHERE plant = %s", (plant,))
    elif object_key == "stage_production_version":
        cur.execute("SELECT material_id, production_version FROM production_version WHERE plant = %s", (plant,))
    else:
        cur.execute("SELECT DISTINCT material_id, task_list_type, routing_group, group_counter"
                    " FROM routing_operation WHERE plant = %s", (plant,))
    return {tuple(r) for r in cur.fetchall()}


def _master_protect_keys(cur, object_key: str, table: str, bid) -> set:
    if object_key == "stage_material_plants":
        return {(m,) for m in _sent_material_ids(cur, table, bid)}
    sent = _sent_routing_keys(cur, table, bid, object_key)
    if object_key == "stage_production_version":
        return {(k[1], k[2]) for k in sent}
    return {tuple(k[1:5]) for k in sent}


def _master_gate(cur, object_key: str, plant: str, bid, table: str) -> tuple[dict, list[dict], list[str], list[tuple]]:
    """Snapshot-deletion gate for a master-object batch: (counts info, warnings, held codes, absent keys)."""
    live, absent, held, pct = master_vanish_stats(_master_live_keys(cur, object_key, plant),
                                                  _master_protect_keys(cur, object_key, table, bid))
    warnings: list[dict] = []
    codes: list[str] = []
    if held:
        codes.append("vanish_threshold")
        warnings.append({"level": "warn", "code": "vanish_threshold",
                         "msg": (f"{len(absent)} of {live} live {_MASTER_LABEL[object_key]} ({pct:.0%}) are missing "
                                 f"from this snapshot; more than {VANISH_HOLD_PCT:.0%} needs admin confirmation.")})
    return ({"in_horizon_live": live, "vanish_candidates": len(absent), "vanish_pct": round(pct, 4)},
            warnings, codes, absent)


def _key_label(key: tuple) -> str:
    return " / ".join(str(p) for p in key)


def _frozen_vanish(cur, bid) -> dict:
    """The deletion set reviewed at validation, read raw (`_header_dict` hides it): {keys: set | None,
    confirmed: bool}. `keys` is None (= use the live set) for a batch validated before the set was frozen
    or one whose set exceeded `_FROZEN_KEYS_CAP`."""
    cur.execute("SELECT counts->'vanish_keys', counts->>'vanish_keys_complete', counts->>'confirmed_held'"
                " FROM sap_stage_batch WHERE batch_id = %s", (str(bid),))
    row = cur.fetchone()
    if not row:
        return {"keys": None, "confirmed": False}
    keys, complete, confirmed = row
    return {"keys": set(keys) if isinstance(keys, list) and complete == "true" else None,
            "confirmed": confirmed == "true"}


def _regate_deletion(live: int, n: int, confirmed: bool, what: str) -> None:
    """Re-run the 25 % gate on the set about to be deleted; refuse (batch -> error) unless the admin
    confirmed the hold. Runs right before the delete, after the upserts changed the live data."""
    held, pct = vanish_gate(live, n)
    if held and not confirmed:
        raise BatchNotApplicable(
            f"deleting {n} of {live} {what} ({pct:.0%}) now exceeds the {VANISH_HOLD_PCT:.0%} threshold; "
            "re-validate and confirm", code="vanish_threshold")


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
    q = (_HEADER_SELECT + (" WHERE " + " AND ".join(where) if where else "")
         + " ORDER BY received_at DESC, COALESCE(ready_at, received_at) DESC, batch_id DESC LIMIT %s")
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
        try:
            table = _spec(hdr["object_key"])["stage_table"]
        except ValueError:
            # A header whose object_key is not a staging object (hand-edited row): show the header with
            # a warning instead of failing the whole route with a 500.
            hdr["warnings"] = [*hdr["warnings"], {"level": "error", "code": "unknown_object_key",
                                                  "msg": f"Unknown object key {hdr['object_key']!r}."}]
            hdr["row_counts"], hdr["actual_rows"] = {}, 0
            return hdr
        cur.execute(sql.SQL("SELECT row_status, count(*) FROM {} WHERE batch_id = %s GROUP BY row_status")
                    .format(sql.Identifier(table)), (str(bid),))
        counts = {r[0]: int(r[1]) for r in cur.fetchall()}
    hdr["row_counts"] = counts
    hdr["actual_rows"] = sum(counts.values())
    return hdr


_REJECT_TEXT = {
    "missing_key": "A key field is blank.",
    "plant_mismatch": "The row's plant differs from the batch's plant.",
    "unknown_plant": "The plant is not a NIMBUS plant.",
    "duplicate_key": "The same key appears more than once in the batch, so every copy was rejected.",
    "invalid_date": "A date is missing or not readable.",
    "invalid_time": "A time is not readable.",
    "invalid_number": "A quantity is not a valid number.",
    "invalid_int": "A whole-number field has a fractional or non-numeric value.",
    "key_too_long": "A key value is longer than NIMBUS can store.",
    "value_too_long": "A value is longer than the field allows.",
    "deleted_flag": "SAP marked this row as deleted.",
    "rejected_by_validator": "The validation checks rejected this row.",
}


def reject_reason_text(reason) -> str:
    """Plain-English text for a row `reject_reason` (for the CSV export, whose raw code stays machine-readable).
    `value_too_long:<column>` keeps the column; an unrecognised reason is returned as sent."""
    raw = "" if reason is None else str(reason)
    base, _, rest = raw.partition(":")
    text = _REJECT_TEXT.get(base)
    if text is None:
        return raw
    return f"{text} ({rest.strip()})" if rest.strip() else text


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
    """What an apply would delete (live, same predicate as validation): the orders of a planned-order
    batch, or -- for a master-object batch -- the live rows absent from the snapshot as
    `{key, material_id, plant[, production_version | task_list_type, routing_group, group_counter]}`
    (`key` is the display label; capped at 2000)."""
    bid = _as_uuid(batch_id)
    with _pool.connection() as conn, conn.cursor() as cur:
        hdr = _load_header(cur, bid)
        if hdr is None:
            raise KeyError(f"batch {batch_id} not found")
        if hdr["object_key"] in _MASTER_LABEL:
            _info, _w, _codes, absent = _master_gate(cur, hdr["object_key"], hdr["plant"], bid,
                                                     _spec(hdr["object_key"])["stage_table"])
            names = {"stage_material_plants": ("material_id",),
                     "stage_production_version": ("material_id", "production_version"),
                     "stage_routing_operation": ("material_id", "task_list_type", "routing_group",
                                                 "group_counter")}[hdr["object_key"]]
            return [{"key": _key_label(k), "plant": hdr["plant"], **dict(zip(names, k, strict=True))}
                    for k in absent[:2000]]
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


_BATCH_ORDER = "(received_at, COALESCE(ready_at, received_at), batch_id)"     # total order: ties never arbitrary


def supersede_older(cur, object_key: str, plant: str, keep_batch_id, *, source: str | None = None) -> list[str]:
    """Older un-applied (ready / validated / held) batches of the same object + plant -> superseded,
    their rows too. "Older" is the total order (received_at, ready_at, batch_id), so two batches landing in
    the same instant still have exactly one winner. `source` limits it to batches of that source (an Excel
    upload must not supersede a Mulesoft batch). Caller commits."""
    table = _spec(object_key)["stage_table"]
    cur.execute(
        "UPDATE sap_stage_batch SET status = 'superseded' WHERE object_key = %s AND btrim(plant) = %s"
        " AND batch_id <> %s AND status = ANY(%s) AND (%s::text IS NULL OR source = %s::text)"
        f" AND {_BATCH_ORDER} < (SELECT received_at, COALESCE(ready_at, received_at), batch_id"
        " FROM sap_stage_batch WHERE batch_id = %s) RETURNING batch_id",
        (object_key, plant, str(keep_batch_id), list(_LIVE_STATUSES), source, source, str(keep_batch_id)))
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


def _set_statement_timeout(cur, *, local: bool) -> None:
    """Raise this connection's statement_timeout for the staging work (pool default is 30 s). `local` =
    transaction-scoped (validate); otherwise session-scoped (apply, which commits between steps and resets it)."""
    cur.execute(sql.SQL("SET LOCAL statement_timeout = {}" if local else "SET statement_timeout = {}")
                .format(sql.Literal(int(STATEMENT_TIMEOUT_MS))))


def _validate(conn, bid) -> dict:
    with conn.cursor() as cur:
        _set_statement_timeout(cur, local=True)
        hdr = _load_header(cur, bid, lock=True)
        if hdr is None:
            raise KeyError(f"batch {bid} not found")
        if hdr["status"] not in _LIVE_STATUSES:
            raise BatchNotApplicable(f"batch is {hdr['status']} and cannot be validated", {"status": hdr["status"]})
        object_key, plant = hdr["object_key"], hdr["plant"]
        table = _spec(object_key)["stage_table"]
        check_batch_complete(hdr["source"], hdr["row_count_expected"], _stage_row_count(cur, table, bid))
        rows = _fetch_rows(cur, table, bid, ("new", "valid", "rejected"))
        row_plants = {_text(r.get("werks") or r.get("plwrk") or r.get("plant")) for r in rows}
        known = _known_plants(cur, row_plants | {plant})
        if plant not in known:
            # B13: a header naming a plant NIMBUS does not have can never apply; reject it visibly.
            warn = [{"level": "error", "code": "unknown_plant", "msg": f"Unknown plant {plant!r} in the batch header."}]
            cur.execute("UPDATE sap_stage_batch SET status = 'rejected', error = 'unknown_plant', warnings = %s,"
                        " validated_at = now() WHERE batch_id = %s", (Jsonb(warn), str(bid)))
            _log("warn", "SAP staging batch rejected: unknown header plant", batch_id=str(bid),
                 object_key=object_key, plant=plant)
            return {"batch_id": str(bid), "object_key": object_key, "plant": plant, "status": "rejected",
                    "counts": {}, "warnings": warn, "held_reasons": []}

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
        if sap_system_tz_invalid():
            warnings.append({"level": "error", "code": "sap_system_tz_invalid", "msg": _SAP_SYSTEM_TZ_MSG})

        if object_key == "stage_planned_orders":
            sent = {r["resolved"]["production_order"] for r in results if r["resolved"].get("production_order")}
            info, gate_warnings, held, visibility_end = _planned_order_gates(cur, plant, sent)
            counts.update(info)
            warnings += gate_warnings
            # M2 / B2: freeze what the admin reviews. The apply deletes ONLY these ids (intersected with the
            # live candidates), so an order created between review and apply is never deleted unreviewed.
            frozen = _vanish_candidates(cur, plant, sent, visibility_end)
            counts["vanish_keys"] = frozen[:_FROZEN_KEYS_CAP]
            counts["vanish_keys_complete"] = len(frozen) <= _FROZEN_KEYS_CAP
        else:
            if total == 0:
                held.append("empty_snapshot")
                warnings.append({"level": "warn", "code": "empty_snapshot",
                                 "msg": "The snapshot is empty; applying it would remove every unreferenced row."})
            # H4: master-object deletions get the same 25 % hold as planned orders.
            info, gate_warnings, gate_held, absent = _master_gate(cur, object_key, plant, bid, table)
            counts.update(info)
            warnings += gate_warnings
            held += gate_held
            counts["vanish_keys"] = [_key_label(k) for k in absent[:_FROZEN_KEYS_CAP]]
            counts["vanish_keys_complete"] = len(absent) <= _FROZEN_KEYS_CAP

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
def _discard_connection(conn, what: str, exc: Exception) -> None:
    """Unlocking failed: the session may still hold the advisory lock (and a raised statement_timeout), so the
    connection must not go back to the pool. Closing it inside the pool context makes the pool discard it
    (and the server drops the session lock with the session)."""
    _log("error", f"SAP staging: could not release {what}; closing the connection", exc=exc)
    try:
        conn.close()
    except Exception:
        log.exception("could not close the connection after a failed unlock")


def apply_batch(batch_id, *, actor: str, confirm_held: bool = False) -> dict:
    """Apply a validated batch (or a held one with `confirm_held`; an `error` / crashed `applying` batch
    resumes). Raises KeyError (unknown), BatchSuperseded (a newer complete batch exists),
    BatchNotApplicable (wrong state, routing_required, another apply running, threshold re-tripped).
    Any failure inside the step ladder sets status `error` (`error` = '<step>: <message>') and re-raises."""
    bid = _as_uuid(batch_id)
    with _pool.connection() as conn:
        locked, lock_key = False, None
        try:
            with conn.cursor() as cur:
                hdr = _load_header(cur, bid)
                if hdr is None:
                    raise KeyError(f"batch {bid} not found")
                # B3: one apply per OBJECT + PLANT (not per batch): an older batch's apply must never run
                # alongside a newer one's, or its absent-row sweep would delete what the newer one wrote.
                lock_key = f"sap:apply:{hdr['object_key']}:{hdr['plant']}"
                cur.execute("SELECT pg_try_advisory_lock(hashtext(%s))", (lock_key,))
                locked = bool(cur.fetchone()[0])
                if locked:
                    _set_statement_timeout(cur, local=False)
            conn.commit()
            if not locked:
                raise BatchNotApplicable("another apply for this object and plant is running",
                                         {"status": "applying"}, code="apply_in_progress")
            return _apply_locked(conn, bid, actor, confirm_held)
        finally:
            if locked:
                try:
                    conn.rollback()
                    with conn.cursor() as cur:
                        cur.execute("RESET statement_timeout")
                        cur.execute("SELECT pg_advisory_unlock(hashtext(%s))", (lock_key,))
                    conn.commit()
                except Exception as exc:
                    _discard_connection(conn, f"apply lock for batch {bid}", exc)


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
        # "Newer" is the total order (received_at, ready_at, batch_id) (B4). A Mulesoft batch is only
        # overtaken by a newer MULESOFT batch -- an Excel upload never blocks it (B16); an upload is
        # overtaken by any newer batch.
        cur.execute(
            "SELECT batch_id, status FROM sap_stage_batch WHERE object_key = %s AND btrim(plant) = %s AND batch_id <> %s"
            " AND status = ANY(%s) AND (%s <> 'mulesoft' OR source = 'mulesoft')"
            f" AND {_BATCH_ORDER} > (SELECT received_at, COALESCE(ready_at, received_at), batch_id"
            " FROM sap_stage_batch WHERE batch_id = %s)"
            " ORDER BY received_at DESC, COALESCE(ready_at, received_at) DESC, batch_id DESC LIMIT 1",
            (object_key, plant, str(bid), ["ready", "validated", "held", "applying", "applied"],
             hdr["source"], str(bid)))
        newer = cur.fetchone()
        if newer:
            raise BatchSuperseded("a newer complete batch exists for this object and plant",
                                  {"batch_id": str(bid), "newer_batch_id": str(newer[0]), "newer_status": newer[1]})
        # H2: completeness is re-checked here, not only at validation (rows may have changed since).
        check_batch_complete(hdr["source"], hdr["row_count_expected"], _stage_row_count(cur, spec["stage_table"], bid))
        # M1: the gates run on EVERY apply entry, including a resume of an `error` / crashed `applying` batch.
        # A confirmation only counts when the batch really was held at validation.
        confirmed = bool(counts0.get("confirmed_held") or (confirm_held and (status == "held" or counts0.get("held"))))
        if object_key == "stage_planned_orders":
            if sap_system_tz_invalid():
                # A wrong zone would shift every order's dates; refuse before anything is written.
                raise BatchNotApplicable(_SAP_SYSTEM_TZ_MSG, code="sap_system_tz_invalid")
            sent = _sent_order_numbers(cur, spec["stage_table"], bid)
            info, _w, held_codes, _ve = _planned_order_gates(cur, plant, sent)
            if counts0.get("horizon_end_present") is False and info.get("horizon_end_present"):
                # B5: the plant had an unlimited horizon at review (no deletes were shown); one has been set
                # since, so up to 25 % would now be deleted unreviewed.
                raise BatchNotApplicable(
                    "the plant's visibility horizon was set after this batch was reviewed; re-validate",
                    code="revalidate_required")
        else:
            info, _w, held_codes, _absent = _master_gate(cur, object_key, plant, bid, spec["stage_table"])
        if "routing_required" in held_codes:
            raise BatchNotApplicable("routing must be enabled with routings loaded before planned orders apply",
                                     {"code": "routing_required"})
        if "vanish_threshold" in held_codes:
            if not confirmed:
                raise BatchNotApplicable("the vanish threshold is now exceeded; re-validate and confirm",
                                         {"code": "vanish_threshold"})
            # M2: the admin confirmed the deletion set they reviewed; refuse if it has grown since.
            stored = counts0.get("vanish_candidates")
            if stored is not None and vanish_set_exceeded(stored, info.get("vanish_candidates")):
                raise BatchNotApplicable(
                    f"the deletion set grew since it was reviewed ({stored} -> {info.get('vanish_candidates')} "
                    "rows); re-validate and confirm again", code="revalidate_required")
        cur.execute(
            "UPDATE sap_stage_batch SET status = 'applying', error = NULL, counts = counts || %s::jsonb"
            " WHERE batch_id = %s",
            (Jsonb({"step": "start", "confirmed_held": confirmed}),
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
            cur.execute("DELETE FROM sap_stage_batch WHERE object_key = %s AND btrim(plant) = %s"
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


def _mark_rejected_at_apply(conn, table: str, bid, items: list[tuple[int, str]]) -> None:
    """B7: staging rows that were `valid` at validation but could not be built / were rejected by the live
    parser at apply time go back to `rejected` with their reason, so the blanket `valid -> applied` update
    never stamps a row that was not written as `applied`. Logged at warning with the batch id."""
    if not items:
        return
    ids = [int(i) for i, _ in items if i is not None and int(i) >= 0]
    reasons = [r for i, r in items if i is not None and int(i) >= 0]
    if ids:
        with conn.cursor() as cur:
            cur.execute(
                sql.SQL("UPDATE {t} AS s SET row_status = 'rejected', reject_reason = v.rr"
                        " FROM unnest(%s::bigint[], %s::text[]) AS v(id, rr)"
                        " WHERE s.id = v.id AND s.batch_id = %s AND s.row_status = 'valid'").format(
                    t=sql.Identifier(table)), (ids, reasons, str(bid)))
        conn.commit()
    sample = {r for _, r in items}
    _log("warn", "SAP staging apply: rows rejected at apply time", batch_id=str(bid), table=table,
         count=len(items), reasons=sorted(sample)[:10])


def _reject_reason_from_warning(w: dict) -> str:
    return str(w.get("msg", "")).split(":")[0].strip() or "rejected_by_validator"


def _bulk_delete(table: str, keys: list[dict], actor: str, bid=None) -> tuple[list[dict], list[dict]]:
    """Delete rows through md.bulk_apply in chunks; a chunk blocked by a reference
    (`md.bulk_apply`'s FK-violation ValueError, recognised by its message) is returned as 'blocked' so the
    caller can flag it instead and the block is logged with the batch id. Any other ValueError is a real
    failure and propagates. Returns (deleted_keys, blocked_keys)."""
    deleted, blocked = [], []
    for i in range(0, len(keys), 500):
        chunk = keys[i:i + 500]
        try:
            md.bulk_apply(table, {"upserts": [], "deletes": chunk}, actor)
            deleted += chunk
        except ValueError as exc:
            if _REFERENCE_BLOCKED not in str(exc):
                raise
            blocked += chunk
            _log("warn", "SAP staging sweep: delete blocked by a reference; rows will be flagged instead",
                 batch_id=str(bid), table=table, rows=len(chunk), error=str(exc))
    return deleted, blocked


def _drop_unchanged_material_rows(cur, plant: str, rows: list[dict]) -> tuple[list[dict], int]:
    """Drop upsert rows whose mapped columns already equal the live row, so a repeat snapshot rewrites nothing
    (no updated_at / xmin churn, an honest `unchanged` count, and no empty `bulk_apply` audit row).
    Columns a row does not carry (None values were dropped upstream) are not compared."""
    cols = sorted({c for r in rows for c in r if c not in ("material_id", "plant")})
    if not rows or not cols:
        return rows, 0
    cur.execute(
        sql.SQL("SELECT material_id, {c} FROM material_plants WHERE plant = %s AND material_id = ANY(%s)").format(
            c=sql.SQL(", ").join(sql.Identifier(c) for c in cols)),
        (plant, sorted({r["material_id"] for r in rows if r.get("material_id")})))
    live = {r[0]: dict(zip(cols, r[1:], strict=True)) for r in cur.fetchall()}
    keep = []
    for r in rows:
        cur_row = live.get(r.get("material_id"))
        if cur_row is None or any(c in r and r[c] != cur_row[c] for c in cols):
            keep.append(r)
    return keep, len(rows) - len(keep)


def _apply_material_plants(conn, hdr, actor: str, step) -> dict:
    bid, plant = hdr["batch_id"], hdr["plant"]
    table = _spec(hdr["object_key"])["stage_table"]
    with conn.cursor() as cur:
        stage = _fetch_rows(cur, table, bid, ("valid",))
        warnings: list = []
        rows = build_material_plant_rows(stage, None, warnings)
        _append_warnings(cur, bid, warnings)
        # H3: the absent sweep is protected by EVERY material SAP sent (valid rows and rows rejected for
        # a reason other than a bad key), not only the rows that were valid.
        protect = sorted(_sent_material_ids(cur, table, bid))
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
    with conn.cursor() as cur:
        rows, unchanged = _drop_unchanged_material_rows(cur, plant, rows)
    conn.commit()
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
                    (plant, protect))
        absent = [r[0] for r in cur.fetchall()]
        # B2: delete / flag only what the admin reviewed (materials that became absent since are left for
        # the next snapshot); then re-run the 25 % gate on that set.
        frozen = _frozen_vanish(cur, bid)
        if frozen["keys"] is not None:
            absent = [m for m in absent if _key_label((m,)) in frozen["keys"]]
        cur.execute("SELECT count(*) FROM material_plants WHERE plant = %s", (plant,))
        _regate_deletion(int(cur.fetchone()[0]), len(absent), frozen["confirmed"], "material-plant rows")
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
    audit_id = _audit_snapshot_vanish_begin(conn, "material_plants", bid, plant, actor, absent)
    done, blocked = _bulk_delete("material_plants", [{"material_id": m, "plant": plant} for m in unreferenced],
                                 actor, bid)
    deleted = len(done)
    to_flag = sorted(referenced | {k["material_id"] for k in blocked})
    if to_flag:
        with conn.cursor() as cur:
            cur.execute("UPDATE material_plants SET sap_missing_since = COALESCE(sap_missing_since, now())"
                        " WHERE plant = %s AND material_id = ANY(%s)", (plant, to_flag))
            flagged = cur.rowcount or 0
        conn.commit()
    _audit_snapshot_vanish_finish(conn, audit_id, [d["material_id"] for d in done], flagged)
    return {"inserted": inserted, "updated": updated, "unchanged": unchanged, "deleted": deleted,
            "flagged": flagged, "materials_created": created}


def _audit_snapshot_vanish_begin(conn, table_name: str, bid, plant: str, actor: str, planned: list):
    """admin_audit row for a snapshot sweep that deletes or flags master rows (H4), written BEFORE the deletes
    (B11): the deletes run on `md.bulk_apply`'s own connections and commit per chunk, so an audit written
    afterwards would be lost by a crash in between. The planned keys (capped at `_AUDIT_KEYS_CAP`) are the
    evidence; `_audit_snapshot_vanish_finish` fills in what actually happened. Returns the audit id (None when
    there is nothing to sweep). Commits."""
    if not planned:
        return None
    with conn.cursor() as cur:
        cur.execute("INSERT INTO admin_audit (table_name, action, details, user_email)"
                    " VALUES (%s, 'sap_snapshot_vanish', %s, %s) RETURNING id",
                    (table_name, Jsonb({"batch_id": str(bid), "plant": plant, "phase": "planned",
                                        "planned_count": len(planned), "deleted_count": 0, "deleted": [],
                                        "planned": [str(k) for k in planned[:_AUDIT_KEYS_CAP]], "flagged": 0}),
                    actor))
        audit_id = cur.fetchone()[0]
    conn.commit()
    return audit_id


def _audit_snapshot_vanish_finish(conn, audit_id, deleted_keys: list, flagged: int) -> None:
    """Record the outcome on the row `_audit_snapshot_vanish_begin` wrote (deleted keys capped at
    `_AUDIT_KEYS_CAP`). Commits."""
    if audit_id is None:
        return
    with conn.cursor() as cur:
        cur.execute("UPDATE admin_audit SET details = details || %s::jsonb WHERE id = %s",
                    (Jsonb({"phase": "done", "deleted_count": len(deleted_keys),
                            "deleted": [str(k) for k in deleted_keys[:_AUDIT_KEYS_CAP]],
                            "flagged": int(flagged)}), audit_id))
    conn.commit()


def _sent_routing_keys(cur, table: str, bid, object_key: str) -> set:
    """Normalised identities of every routing row SAP sent (valid or rejected, never deleted-flag /
    other-plant rows) -- the protection set for the absent-row sweeps.

    A routing row whose full key is incomplete (`missing_key`, e.g. a blank activity or sequence) still
    protects its routing GROUP -- (material, task list type, routing group, group counter) -- when those four
    parts are present, as `(plant, material, type, group, counter, None, None)`: SAP did send that routing,
    and a half-filled operation must not delete the live one. Production-version rows need their whole key."""
    import backend.routing.ingest as ingest
    cur.execute(sql.SQL("SELECT * FROM {} WHERE batch_id = %s AND row_status IN ('valid','rejected','applied')"
                        " AND COALESCE(reject_reason, '') NOT IN ('deleted_flag', 'plant_mismatch',"
                        " 'unknown_plant')").format(
        sql.Identifier(table)), (str(bid),))
    names = [d.name for d in cur.description]
    keys = set()
    for rec in cur.fetchall():
        r = dict(zip(names, rec, strict=True))
        mat = sap_sync._t_alpha_strip(r.get("material_id"))
        k = _routing_key(object_key, ingest, mat, r)
        if k:
            keys.add(k)
        elif object_key == "stage_routing_operation":
            group = (mat, _text(r.get("task_list_type")), _text(r.get("routing_group")),
                     ingest._zero_pad(r.get("group_counter"), 2))
            if all(group):
                keys.add((_text(r.get("plant")) or "", *group, None, None))
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
    _mark_rejected_at_apply(conn, table, bid, [
        (stage[w["row"]]["id"], _reject_reason_from_warning(w)) for w in rejected_now
        if isinstance(w.get("row"), int) and 0 <= w["row"] < len(stage)])

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
        frozen = _frozen_vanish(cur, bid)                       # B2: only the reviewed set, re-gated
        if frozen["keys"] is not None:
            absent = [r for r in absent if _key_label((r[0], r[1])) in frozen["keys"]]
        _regate_deletion(len(live), len(absent), frozen["confirmed"], "production versions")
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
    audit_id = _audit_snapshot_vanish_begin(conn, "production_version", bid, plant, actor,
                                            [f"{r[0]}/{r[1]}" for r in absent])
    done, blocked = _bulk_delete(
        "production_version",
        [{"plant": plant, "material_id": r[0], "production_version": r[1]} for r in unref], actor, bid)
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
    _audit_snapshot_vanish_finish(conn, audit_id,
                                  [f"{d['material_id']}/{d['production_version']}" for d in done], flagged)

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
    _mark_rejected_at_apply(conn, table, bid, [
        (stage[w["row"]]["id"], _reject_reason_from_warning(w)) for w in rejected_now
        if isinstance(w.get("row"), int) and 0 <= w["row"] < len(stage)])

    step("write")
    inserted = routing_routes.write_operation_groups(groups, actor) if groups else 0

    step("delete_absent")
    # A routing is identified by (material, type, group, counter) within the plant (the PK adds the
    # operation); anything SAP did not send is deleted -- dependent orders go on hold at recompute.
    protected = {(k[1], k[2], k[3], k[4]) for k in sent}
    with conn.cursor() as cur:
        # B2: delete only the routings the admin reviewed (those still absent), re-gated on the live count.
        live = _master_live_keys(cur, "stage_routing_operation", plant)
        frozen = _frozen_vanish(cur, bid)
        absent = sorted(k for k in live if k not in protected)
        if frozen["keys"] is not None:
            absent = [k for k in absent if _key_label(k) in frozen["keys"]]
        _regate_deletion(len(live), len(absent), frozen["confirmed"], "routings")
        deleted = 0
        if absent:
            cur.execute(
                "DELETE FROM routing_operation ro WHERE ro.plant = %s AND (ro.material_id, ro.task_list_type,"
                " ro.routing_group, ro.group_counter) IN (SELECT * FROM unnest("
                "%s::text[], %s::text[], %s::text[], %s::text[]))",
                (plant, [k[0] for k in absent], [k[1] for k in absent], [k[2] for k in absent],
                 [k[3] for k in absent]))
            deleted = cur.rowcount or 0
        if deleted:
            cur.execute("INSERT INTO admin_audit (table_name, action, details, user_email)"
                        " VALUES ('routing_operation', 'sap_staging_absent_delete', %s, %s)",
                        (Jsonb({"plant": plant, "batch_id": bid, "rows_deleted": deleted,
                                "routings": [_key_label(k) for k in absent[:_AUDIT_KEYS_CAP]]}), actor))
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
    _mark_rejected_at_apply(conn, table, bid, problems)         # B7: not built -> rejected, never `applied`
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
                                  resolve_fn=routing_resolver.resolve_orders, sap_tz=SAP_SYSTEM_TZ)
    else:
        result = {"status": "ok", "inserted": 0, "updated": 0, "unchanged": 0}
    if result.get("status") not in (None, "ok"):
        raise RuntimeError(f"orders upsert returned {result.get('status')!r}")

    step("zero_open")
    flagged = 0
    if zero_keys:
        with conn.cursor() as cur:
            # B6: only rows THIS upsert wrote (their upload_batch_id is this upsert's batch, or the stage
            # batch id of the first run of a resumed apply) -- an unchanged re-poll leaves a planner's
            # re-slot of a zero-open order alone -- and never an order that is running right now.
            cur.execute(
                "SELECT o.id, o.plant, o.planning_status, o.scheduled_start, o.scheduled_end,"
                " o.basic_start_date, o.basic_finish_date, o.run_time, seg.first_start, seg.last_end,"
                " (SELECT MIN(p.timezone) FROM plants p WHERE p.plant = o.plant) AS tz"
                " FROM orders o " + db._SCHEDULE_SEGMENTS_LATERAL_SQL +
                " WHERE o.plant = %s AND (o.production_order = ANY(%s)"
                " OR o.parent_production_order = ANY(%s)) AND o.upload_batch_id = ANY(%s::uuid[])"
                " AND (o.planning_status IS DISTINCT FROM 'needs_planning'"
                " OR COALESCE(o.planning_reason->>'code', '') <> 'zero_open_quantity') ORDER BY o.id FOR UPDATE OF o",
                (plant, zero_keys, zero_keys, sorted({str(bid), str(upsert_batch)})))
            names = [d.name for d in cur.description]
            ids = []
            for rec in cur.fetchall():
                b = dict(zip(names, rec, strict=True))
                if not db._order_is_running(b, db._plant_local_now(b["tz"])):
                    ids.append(b["id"])
            if ids:
                cur.execute("DELETE FROM order_schedule_segments WHERE order_id = ANY(%s)", (ids,))
                cur.execute(
                    "UPDATE orders SET planning_status = 'needs_planning', planning_reason = %s,"
                    " scheduled_start = NULL, scheduled_end = NULL, manual_firmed = FALSE,"
                    " runtime_schedule_mismatch = FALSE, placement_exception = NULL, updated_at = NOW()"
                    " WHERE id = ANY(%s)", (Jsonb(_ZERO_OPEN_REASON), ids))
                flagged = len(ids)
        conn.commit()

    step("vanish")
    deleted = archived = 0
    info = {"in_horizon_live": 0, "vanish_candidates": 0}
    with conn.cursor() as cur:
        visibility_end, _frozen = db._horizon_bounds_for_plant(cur, plant)
        ids = _vanish_candidates(cur, plant, sent, visibility_end)
        # B2: delete only what the admin reviewed. Orders created between validation and now (planner, Excel,
        # horizon roll, horizon NULL -> value) are candidates in the live set but were never reviewed; they
        # wait for the next snapshot.
        frozen = _frozen_vanish(cur, bid)
        not_reviewed = 0
        if frozen["keys"] is not None:
            reviewed = [i for i in ids if i in frozen["keys"]]
            not_reviewed = len(ids) - len(reviewed)
            ids = reviewed
        if visibility_end is not None:
            bound = visibility_end + timedelta(days=1)
            cur.execute("SELECT count(*) FROM orders o WHERE plant = %s AND " + _in_horizon_predicate(),
                        (plant, bound))
            info["in_horizon_live"] = int(cur.fetchone()[0])
    conn.commit()
    if not_reviewed:
        _log("warn", "SAP staging apply: orders became deletion candidates after review and were kept",
             batch_id=str(bid), plant=plant, kept=not_reviewed)
        warnings.append({"level": "warn", "code": "vanish_not_reviewed", "count": not_reviewed,
                         "msg": f"{not_reviewed} order(s) became deletion candidates after the review and were "
                                "kept; the next snapshot decides."})
    # Re-run the gate on the set about to be deleted; an unconfirmed trip fails the batch before any delete.
    _regate_deletion(info["in_horizon_live"], len(ids), frozen["confirmed"], "in-horizon orders")
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
                with conn.cursor() as cur:
                    _set_statement_timeout(cur, local=False)     # sweeps / archive deletes on this connection
                conn.commit()
                _poll_locked(conn, actor, out)
            finally:
                if got:
                    try:
                        conn.rollback()
                        with conn.cursor() as cur:
                            cur.execute("RESET statement_timeout")
                            cur.execute("SELECT pg_advisory_unlock(hashtext('sap:staging-poll'))")
                        conn.commit()
                    except Exception as exc:
                        _discard_connection(conn, "the staging poll lock", exc)
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
        _poll_error(out, exc, step="expire_stale_loading")

    try:
        # B13: a `ready` batch whose object_key is not a staging object would otherwise sit forever (the
        # loop below only visits APPLY_ORDER); reject it visibly.
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE sap_stage_batch SET status = 'rejected', error = 'unknown_object_key', warnings = warnings || %s::jsonb"
                " WHERE status = 'ready' AND object_key <> ALL(%s) RETURNING batch_id, object_key",
                (Jsonb([{"level": "error", "code": "unknown_object_key",
                         "msg": "The batch names an object NIMBUS does not stage."}]), list(APPLY_ORDER)))
            bad = cur.fetchall()
        conn.commit()
        for b_id, b_key in bad:
            _log("warn", "SAP staging poll: batch rejected, unknown object key", batch_id=str(b_id), object_key=b_key)
            out["processed"].append({"batch_id": str(b_id), "object_key": b_key, "status": "rejected"})
    except Exception as exc:
        conn.rollback()
        _poll_error(out, exc, step="reject_unknown_object_key")

    for object_key in APPLY_ORDER:
        try:
            table = _spec(object_key)["stage_table"]
            with conn.cursor() as cur:
                cur.execute(
                    sql.SQL("SELECT b.batch_id, btrim(b.plant), b.status, b.source, b.row_count_expected,"
                            " COALESCE(b.ready_at, b.received_at),"
                            " (SELECT count(*) FROM {t} s WHERE s.batch_id = b.batch_id)"
                            " FROM sap_stage_batch b WHERE b.object_key = %s AND b.status IN ('ready','validated')"
                            " ORDER BY btrim(b.plant), b.received_at DESC, COALESCE(b.ready_at, b.received_at) DESC,"
                            " b.batch_id DESC").format(t=sql.Identifier(table)),
                    (object_key,))
                candidates = cur.fetchall()
            conn.commit()
        except Exception as exc:
            conn.rollback()
            _poll_error(out, exc, object_key=object_key)
            continue
        seen_plants: set = set()
        for bid, plant, status, source, expected, ready_at, actual in candidates:
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
                elif result["status"] == "validated":
                    apply_mode = sap_sync.get_config(object_key).get("apply_mode")
                    if should_auto_apply(source, result["status"], apply_mode):
                        applied = apply_batch(bid, actor=actor)
                        out["applied"].append({"batch_id": str(bid), "object_key": object_key, "plant": plant,
                                               "counts": applied.get("counts")})
                    elif apply_mode == "auto":
                        # D18: an Excel/CSV upload is validated but never auto-applied.
                        out["skipped"].append({"batch_id": str(bid), "object_key": object_key, "plant": plant,
                                               "reason": "upload batches are never auto-applied"})
            except BatchNotApplicable as exc:
                conn.rollback()
                out["skipped"].append({"batch_id": str(bid), "object_key": object_key, "reason": str(exc)})
                _log("info", "SAP staging poll: batch not applicable", batch_id=str(bid),
                     object_key=object_key, reason=str(exc))
            except Exception as exc:
                conn.rollback()
                _poll_error(out, exc, batch_id=str(bid), object_key=object_key)

    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM sap_stage_vanished_order WHERE deleted_at < now() - make_interval(days => %s)",
                        (ARCHIVE_RETENTION_DAYS,))
            # B14: `sent` AND every `error` row (requeued retirements and Mulesoft-reported failures) age out;
            # queued_at covers rows that never got a sent_at.
            cur.execute("DELETE FROM sap_stage_planned_order_out WHERE row_status IN ('sent', 'error')"
                        " AND COALESCE(sent_at, queued_at) < now() - make_interval(days => %s)",
                        (SENT_RETENTION_DAYS,))
            cur.execute("DELETE FROM sap_stage_batch WHERE status IN ('rejected','discarded','superseded')"
                        " AND received_at < now() - make_interval(days => %s)", (DEAD_BATCH_RETENTION_DAYS,))
        conn.commit()
    except Exception as exc:
        conn.rollback()
        _poll_error(out, exc, step="sweeps")


def _poll_error(out: dict, exc: Exception, *, batch_id: str | None = None, **ctx) -> None:
    """Record a poll failure: the stored string carries the exception class (`Type: message`), and the event
    is logged with exception info and the batch id when there is one."""
    entry = {**ctx, "error": f"{type(exc).__name__}: {exc}"}
    if batch_id:
        entry["batch_id"] = batch_id
    out["errors"].append(entry)
    _log("error", "SAP staging poll error", exc=exc, batch_id=batch_id, **ctx)


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
        if data_type in ("integer", "bigint", "smallint"):
            return _int_or_none(s, "value")          # whole numbers only; inf / NaN / fractions -> ValueError
        return _dec(s)
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
        log.info("staging upload unreadable (%s): %s", filename, exc)
        raise ValueError("Could not read the file: it is not a valid .xlsx or .csv file.") from exc
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
            # B16: an upload only replaces older UPLOADS; a validated / held Mulesoft batch is left alone.
            supersede_older(cur, object_key, plant, bid, source="upload")
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


def archived_plant(archive_id: int) -> str | None:
    """Plant of one archive row (None when unknown) -- lets the route enforce plant scope before restoring."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT plant FROM sap_stage_vanished_order WHERE id = %s", (int(archive_id),))
        r = cur.fetchone()
    return r[0] if r else None


def restore_archived(archive_id: int, *, actor: str) -> dict:
    """Restore one archived order (KeyError when missing / already restored)."""
    return db.restore_vanished_order(int(archive_id), user_email=actor)


# ---------------------------------------------------------------------------
# Send to SAP -- the outbound queue (NIMBUS -> SAP planned-order import)
# ---------------------------------------------------------------------------
def firm_flag(manual_firmed, firming_indicator, eff_start, frozen_end) -> str:
    """Firm Indicator we send (D10): 'X' when the planner firmed the order, SAP already had it
    firmed, or its effective start lies inside the frozen horizon (`frozen_end` None = no frozen
    firming); blank otherwise. Add-only by construction: an existing SAP 'X' always yields 'X'."""
    if manual_firmed:
        return "X"
    if str(firming_indicator or "").strip().upper() == "X":
        return "X"
    if frozen_end is not None and eff_start is not None and eff_start < frozen_end:
        return "X"
    return ""


def build_outbound_groups(rows: list[dict], frozen_end) -> tuple[list[dict], int, int]:
    """Roll candidate order rows up to one outbound row per planned order (D9 / D17). Pure.

    `rows`: dicts with id, production_order, parent_production_order, material_number, manual_firmed,
    firming_indicator, production_version, planning_status, eff_start, eff_end (naive plant-local).
    A row is a candidate when it has an effective end and is not 'needs_planning'; the rest are
    counted as skipped. Rows group by (parent order or own order number, material): the group's end is
    the latest member end, its firm flag is 'X' when ANY candidate member qualifies (`firm_flag`), its
    version is the smallest non-blank member version (children of one parent carry the same one).
    Only FIRMED planned orders are sent (OQ61, D9): a group whose firm flag would be blank is dropped and
    counted in `skipped_unfirmed` (one per planned order, not per child). An aggregate stays when ANY candidate
    member is firmed, and its end is still the latest end over ALL its candidate members, firmed or not.
    Returns (groups, skipped_no_end, skipped_unfirmed); a group carries `member_ids` (every row of the group, skipped
    members included), `sent_ids` (only the members that had an effective end and were not in Needs
    Planning -- the ones whose sent values are remembered) and `rolled_up` (true when it stands for
    distribution children)."""
    groups: dict[tuple, dict] = {}
    skipped = 0
    for r in rows:
        key = (r.get("parent_production_order") or r["production_order"], r["material_number"])
        g = groups.setdefault(key, {"plnum": key[0], "matnr": key[1], "end": None, "firm": False,
                                    "versions": [], "member_ids": [], "sent_ids": [], "rolled_up": False,
                                    "single_id": r["id"]})
        g["member_ids"].append(r["id"])
        if r.get("parent_production_order"):
            g["rolled_up"] = True
        if r.get("eff_end") is None or r.get("planning_status") == "needs_planning":
            skipped += 1
            continue
        g["sent_ids"].append(r["id"])
        if g["end"] is None or r["eff_end"] > g["end"]:
            g["end"] = r["eff_end"]
        if firm_flag(r.get("manual_firmed"), r.get("firming_indicator"), r.get("eff_start"), frozen_end) == "X":
            g["firm"] = True
        v = _text(r.get("production_version"))
        if v:
            g["versions"].append(v)
    out = []
    skipped_unfirmed = 0
    for g in groups.values():
        if g["end"] is None:
            continue
        if not g["firm"]:                       # OQ61: unfirmed planned orders are not transmitted
            skipped_unfirmed += 1
            continue
        out.append({"plnum": g["plnum"], "matnr": g["matnr"], "end": g["end"],
                    "auffx": "X" if g["firm"] else "", "verid": min(g["versions"]) if g["versions"] else None,
                    "member_ids": g["member_ids"], "sent_ids": g["sent_ids"], "rolled_up": g["rolled_up"],
                    "nimbus_order_id": None if g["rolled_up"] else g["single_id"]})
    return out, skipped, skipped_unfirmed


def _outbound_candidate_rows(cur, plant: str) -> list[dict]:
    cur.execute(
        "SELECT o.id, o.production_order, o.parent_production_order, o.material_number, o.manual_firmed,"
        " o.firming_indicator, o.production_version, o.planning_status,"
        " " + db._EFF_START_SQL + ","          # first segment, else the stored start, else the SAP start
        " " + db._EFF_END_SQL +                # the stored finish: what Send transmits (backward scheduling)
        " FROM orders o " + db._SCHEDULE_SEGMENTS_LATERAL_SQL + " WHERE o.plant = %s ORDER BY o.id", (plant,))
    names = ("id", "production_order", "parent_production_order", "material_number", "manual_firmed",
             "firming_indicator", "production_version", "planning_status", "eff_start", "eff_end")
    return [dict(zip(names, r, strict=True)) for r in cur.fetchall()]


def queue_send_to_sap(plant: str, *, actor: str) -> dict:
    """Queue the plant's schedule for Mulesoft to pick up (one outbound row per planned order).

    Still-`ready` rows from an earlier click are retired first (row_status='error',
    error_text='requeued', so history survives; the poll sweeps them after 30 days). Every
    firmed order of the plant is queued (D9, OQ61: planner-firmed, SAP-firmed or starting inside the frozen
    horizon; the rest are counted in `skipped_unfirmed`); distribution children roll up to their parent
    order with the latest child end (D17); the end is converted plant-local -> SAP system zone
    (D34); the firm flag is add-only (D10). NIMBUS also remembers what it sent on each member order
    (side table `order_sap_sent`, D20) so SAP's echo of that finish is not read as an SAP change. Only member
    orders that were actually sent (they had an effective end) are written, and only when their remembered
    finish / version / firm value differs from the new one. The table is separate from `orders`, so no
    `orders` row is ever written by a Send: xmin (the optimistic-concurrency `base_version`) is untouched
    and a planner's unsaved edit survives the click.
    Everything -- retire, insert, remember, audit -- is one transaction.
    Returns {send_batch_id, queued, skipped_no_end, skipped_unfirmed, firmed, rolled_up_groups}."""
    plant = (plant or "").strip()
    if not plant:
        raise ValueError("plant is required")
    if sap_system_tz_invalid():
        raise ValueError(_SAP_SYSTEM_TZ_MSG)
    send_batch_id = str(uuid.uuid4())
    with _pool.connection() as conn:
        try:
            with conn.cursor() as cur:
                tz = _plant_info(cur, plant)["timezone"]
                _vis, frozen_end = db._horizon_bounds_for_plant(cur, plant)
                groups, skipped, skipped_unfirmed = build_outbound_groups(_outbound_candidate_rows(cur, plant), frozen_end)
                cur.execute("UPDATE sap_stage_planned_order_out SET row_status = 'error', error_text = 'requeued',"
                            " sent_at = now() WHERE plant = %s AND row_status = 'ready'", (plant,))
                firmed = rolled = 0
                for g in groups:
                    pedtr, pedti = plant_local_to_sap(g["end"], tz)
                    cur.execute(
                        "INSERT INTO sap_stage_planned_order_out (send_batch_id, plant, matnr, plwrk, plnum, verid,"
                        " pedtr, pedti, auffx, queued_by, nimbus_order_id)"
                        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                        (send_batch_id, plant, g["matnr"], plant, g["plnum"], g["verid"], pedtr, pedti,
                         g["auffx"], actor, g["nimbus_order_id"]))
                    sent_vals = (g["end"].replace(microsecond=0), g["verid"], g["auffx"] == "X")
                    if g["sent_ids"]:
                        # A2: the remembered values live in the side table order_sap_sent, never on
                        # `orders`, so remembering a send cannot bump an order's xmin (the
                        # optimistic-concurrency base_version) and discard a planner's unsaved edit.
                        # A row is rewritten only when its remembered values actually change.
                        cur.execute(
                            "INSERT INTO order_sap_sent AS s (order_id, plant, sent_finish, sent_version,"
                            " sent_firm, sent_at)"
                            " SELECT oid, %s, %s::timestamp, %s::text, %s::boolean, now()"
                            "   FROM unnest(%s::text[]) AS oid"
                            " ON CONFLICT (order_id) DO UPDATE SET plant = EXCLUDED.plant,"
                            " sent_finish = EXCLUDED.sent_finish, sent_version = EXCLUDED.sent_version,"
                            " sent_firm = EXCLUDED.sent_firm, sent_at = now()"
                            " WHERE (s.sent_finish, s.sent_version, s.sent_firm)"
                            " IS DISTINCT FROM (EXCLUDED.sent_finish, EXCLUDED.sent_version, EXCLUDED.sent_firm)",
                            (plant, *sent_vals, list(g["sent_ids"])))
                    firmed += g["auffx"] == "X"
                    rolled += bool(g["rolled_up"])
                cur.execute(
                    "INSERT INTO admin_audit (table_name, action, details, user_email)"
                    " VALUES ('sap_stage_planned_order_out', 'send_to_sap', %s, %s)",
                    (Jsonb({"plant": plant, "send_batch_id": send_batch_id, "queued": len(groups),
                            "skipped_no_end": skipped, "skipped_unfirmed": skipped_unfirmed,
                            "firmed": firmed}), actor))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    _log("info", "SAP send queued", plant=plant, send_batch_id=send_batch_id, queued=len(groups),
         skipped_no_end=skipped, skipped_unfirmed=skipped_unfirmed, firmed=firmed, user=actor)
    return {"send_batch_id": send_batch_id, "queued": len(groups), "skipped_no_end": skipped,
            "skipped_unfirmed": skipped_unfirmed, "firmed": firmed, "rolled_up_groups": rolled}


def outbound_status(plant: str) -> dict:
    """{ready, sent, error, last_queued_at, last_sent_at} for one plant's outbound table."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FILTER (WHERE row_status = 'ready'), count(*) FILTER (WHERE row_status = 'sent'),"
                    " count(*) FILTER (WHERE row_status = 'error'), max(queued_at), max(sent_at)"
                    " FROM sap_stage_planned_order_out WHERE plant = %s", (plant,))
        ready, sent, error, last_q, last_s = cur.fetchone()
    return {"ready": int(ready or 0), "sent": int(sent or 0), "error": int(error or 0),
            "last_queued_at": _iso(last_q), "last_sent_at": _iso(last_s)}


def outbound_rows(plant: str, *, status: str | None = None, limit: int = 1000) -> list[dict]:
    """Outbound rows of a plant, newest first (optionally one row_status)."""
    where, params = ["plant = %s"], [plant]
    if status:
        where.append("row_status = %s")
        params.append(status)
    params.append(int(limit))
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT id, send_batch_id, plant, matnr, plwrk, plnum, verid, pedtr, pedti, auffx, row_status,"
                    " queued_at, queued_by, sent_at, error_text, nimbus_order_id FROM sap_stage_planned_order_out"
                    " WHERE " + " AND ".join(where) + " ORDER BY queued_at DESC, id DESC LIMIT %s", params)
        names = [d.name for d in cur.description]
        return [{k: (str(v) if k == "send_batch_id" else _iso(v)) for k, v in zip(names, r, strict=True)}
                for r in cur.fetchall()]
