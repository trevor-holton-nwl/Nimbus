"""
NIMBUS 2.0 — SAP sync engine (NON-LIVE skeleton).

Transport-agnostic ingestion layer that pulls SAP-shaped records for the six
NIMBUS objects (5 master-data tables + production orders), maps SAP field names
onto NIMBUS columns through a per-object field map, applies SAP value transforms
(ALPHA conversion, DATS/TIMS, packed-decimal trailing-sign, X-flags, …) and
dispatches the mapped rows to the existing persistence layer:

    master objects -> master_data.bulk_apply()
    orders         -> db.upsert_orders()

This is deliberately a SKELETON: the three connectors (file_drop / odata / rfc)
are stubs that read nothing — `extract()` returns `[]` and `test_connection()`
reports the transport is not configured. No SAP call is ever made. The network
libraries (httpx, pyrfc) are imported LAZILY inside method bodies only, never at
module top, so importing this module has zero network-library dependency.

Persistence helpers use the shared Postgres pool exactly like master_data.py
(`from db import _pool`, the `with _pool.connection()` pattern). All SQL is
parameterized; any dynamic identifier is routed through psycopg.sql.Identifier.

CREDENTIALS: connection secrets live only in `source_params` JSONB and are
NEVER logged. The error path records the exception class/message but the
connector implementations must not echo credentials into it.
"""
import contextlib
import logging
from typing import Callable

from psycopg.types.json import Jsonb

# Shared pool + helpers from the existing data layer. Reusing db._str_id keeps
# ALPHA / leading-zero handling identical to the Excel ingest path.
from db import _pool, _str_id
import db
import master_data as md
import server.setup.data as setup_data

# Child of brain.py's `nimbus.*` structured-logging tree (propagates up).
log = logging.getLogger("nimbus.sap")

VERSION = "2026-06-30-b"

# ---------------------------------------------------------------------------
# Object catalog — the six syncable NIMBUS objects.
#   key -> {kind, table, label}
#   kind: "master" (routed to md.bulk_apply) | "orders" (routed to db.upsert_orders)
# ---------------------------------------------------------------------------
SAP_OBJECTS: dict[str, dict] = {
    "subnetworks":      {"kind": "master", "table": "subnetworks",      "label": "Subnetworks"},
    "plants":           {"kind": "master", "table": "plants",           "label": "Plants"},
    "machine":          {"kind": "master", "table": "machine",          "label": "Machines"},
    "materials":        {"kind": "master", "table": "materials",        "label": "Materials"},
    "material_plants":  {"kind": "master", "table": "material_plants",  "label": "Material Plants"},
    "orders":           {"kind": "orders", "table": "orders",           "label": "Production Orders"},
}

# Master-table composite keys — mirrors master_data._KEY_COLUMNS so map_records
# can guarantee the key columns survive mapping for master objects.
_MASTER_KEY_COLUMNS = {
    "subnetworks":      ("code",),
    "plants":           ("subnetwork", "plant"),
    "machine":          ("subnetwork", "plant", "machine"),
    "materials":        ("material_id",),
    "material_plants":  ("material_id", "plant"),
}

# ---------------------------------------------------------------------------
# Transforms — SAP value normalization
# ---------------------------------------------------------------------------
# SAP renders "empty" in several shapes depending on the field type. Any of
# these, after stripping, maps to None (NULL) on the NIMBUS side.
NULL_SENTINELS = {"00000000", "0000-00-00", ""}


def _t_none(value):
    """Passthrough."""
    return value


def _t_alpha(value):
    """ALPHA conversion — SAP zero-padded numeric-ish ID, stripped of the Excel
    float suffix via db._str_id (e.g. '1000261702.0' -> '1000261702')."""
    if value is None:
        return None
    return _str_id(value)


def _t_strip_zeros(value):
    """Strip SAP leading zeros from an external-format ID. '000000123' -> '123';
    a pure-zero / sentinel value collapses to None. Reuses db._str_id first so the
    Excel float suffix is removed before leading-zero stripping."""
    if value is None:
        return None
    s = _str_id(value).strip()
    if s in NULL_SENTINELS:
        return None
    stripped = s.lstrip("0")
    # All-zeros input -> "" after lstrip; treat as null.
    return stripped if stripped != "" else None


def _t_dats(value):
    """SAP DATS ('YYYYMMDD') -> ISO 'YYYY-MM-DD' string. Sentinel -> None.
    Returns the raw value untouched if it is not an 8-digit DATS token (so an
    already-ISO date or a real datetime passes through)."""
    if value is None:
        return None
    s = str(value).strip()
    if s in NULL_SENTINELS:
        return None
    if len(s) == 8 and s.isdigit():
        y, m, d = s[0:4], s[4:6], s[6:8]
        if y == "0000" or m == "00" or d == "00":
            return None
        return f"{y}-{m}-{d}"
    return value


def _t_tims(value):
    """SAP TIMS ('HHMMSS') -> 'HH:MM:SS' string. Sentinel/'000000' -> None.
    Non-TIMS tokens pass through untouched."""
    if value is None:
        return None
    s = str(value).strip()
    if s in NULL_SENTINELS:
        return None
    if len(s) == 6 and s.isdigit():
        return f"{s[0:2]}:{s[2:4]}:{s[4:6]}"
    return value


def _t_decimal(value):
    """SAP packed-decimal external format with a TRAILING sign — '123.45-' is a
    negative number. Returns a float (or None for blank/sentinel). A leading sign
    and thousands separators are also tolerated."""
    if value is None:
        return None
    s = str(value).strip()
    if s in NULL_SENTINELS:
        return None
    neg = False
    if s.endswith("-"):
        neg = True
        s = s[:-1].strip()
    elif s.endswith("+"):
        s = s[:-1].strip()
    elif s.startswith("-"):
        neg = True
        s = s[1:].strip()
    elif s.startswith("+"):
        s = s[1:].strip()
    s = s.replace(",", "")
    if s == "":
        return None
    try:
        val = float(s)
    except (ValueError, TypeError):
        return None
    return -val if neg else val


def _t_uom(value):
    """Unit-of-measure. No SAP UoM dictionary in the skeleton — identity fallback
    (trimmed), sentinel -> None."""
    if value is None:
        return None
    s = str(value).strip()
    if s in NULL_SENTINELS:
        return None
    return s


def _t_bool_x(value):
    """SAP boolean flag: 'X' (any case) / true-ish -> True; '' / sentinel / false-ish
    -> False."""
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    s = str(value).strip().upper()
    if s in NULL_SENTINELS:
        return False
    return s in ("X", "TRUE", "T", "1", "Y", "YES")


TRANSFORMS: dict[str, Callable] = {
    "none":        _t_none,
    "alpha":       _t_alpha,
    "strip_zeros": _t_strip_zeros,
    "dats":        _t_dats,
    "tims":        _t_tims,
    "decimal":     _t_decimal,
    "uom":         _t_uom,
    "bool_x":      _t_bool_x,
}


def apply_transform(name: str, value):
    """Apply a named transform. Unknown name -> passthrough (so a stale field-map
    row never hard-fails an entire sync)."""
    fn = TRANSFORMS.get(name or "none")
    if fn is None:
        log.warning("Unknown SAP transform %r — passing value through", name,
                    extra={"category": "sap_sync"})
        return value
    return fn(value)


# ---------------------------------------------------------------------------
# Field map persistence (sap_field_map)
# ---------------------------------------------------------------------------
def load_field_map(object_key: str) -> list[dict]:
    """Return ALL field-map rows for an object (incl. inactive), ordered by
    field_order then sap_field. Each row: {sap_field, nimbus_column, transform,
    active, field_order}."""
    if object_key not in SAP_OBJECTS:
        raise ValueError(f"Unknown SAP object: {object_key!r}")
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT sap_field, nimbus_column, transform, active, field_order"
            " FROM sap_field_map WHERE object_key = %s"
            " ORDER BY field_order, sap_field",
            (object_key,),
        )
        return [
            {
                "sap_field":     r[0],
                "nimbus_column": r[1],
                "transform":     r[2],
                "active":        r[3],
                "field_order":   r[4],
            }
            for r in cur.fetchall()
        ]


def replace_field_map(object_key: str, mappings: list[dict],
                      user_email: str | None = None) -> dict:
    """Replace the entire field map for an object in ONE transaction
    (delete-all then insert). Each mapping needs at least sap_field + nimbus_column;
    transform defaults to 'none', active to True, field_order to its list position."""
    if object_key not in SAP_OBJECTS:
        raise ValueError(f"Unknown SAP object: {object_key!r}")
    if not isinstance(mappings, list):
        raise ValueError("mappings must be a list")

    clean: list[dict] = []
    for i, m in enumerate(mappings):
        if not isinstance(m, dict):
            raise ValueError("each mapping must be an object")
        sap_field = (m.get("sap_field") or "").strip()
        nimbus_column = (m.get("nimbus_column") or "").strip()
        if not sap_field or not nimbus_column:
            # Skip incomplete rows rather than reject the whole save.
            continue
        transform = (m.get("transform") or "none").strip()
        if transform not in TRANSFORMS:
            raise ValueError(f"Unknown transform {transform!r} for field {sap_field!r}")
        clean.append({
            "sap_field":     sap_field,
            "nimbus_column": nimbus_column,
            "transform":     transform,
            "active":        bool(m.get("active", True)),
            "field_order":   int(m.get("field_order", i)),
        })

    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM sap_field_map WHERE object_key = %s", (object_key,))
        if clean:
            cur.executemany(
                "INSERT INTO sap_field_map"
                " (object_key, sap_field, nimbus_column, transform, active, field_order)"
                " VALUES (%s, %s, %s, %s, %s, %s)",
                [(object_key, c["sap_field"], c["nimbus_column"], c["transform"],
                  c["active"], c["field_order"]) for c in clean],
            )
        conn.commit()
    log.info("Replaced SAP field map for %s (%d rows)", object_key, len(clean),
             extra={"category": "sap_sync", "user": user_email})
    return {"status": "ok", "object_key": object_key, "count": len(clean)}


# ---------------------------------------------------------------------------
# Record mapping
# ---------------------------------------------------------------------------
def map_records(object_key: str, raw_records: list[dict],
                field_map: list[dict] | None = None) -> list[dict]:
    """Map+transform raw SAP records into NIMBUS column dicts.

    For each raw record, every ACTIVE field-map entry whose sap_field is present
    pulls a value, runs it through the named transform, and writes it to the
    target nimbus_column. For master objects the table's key columns are always
    ensured present (added as None when a record didn't carry them) so the
    downstream upsert has a stable shape.
    """
    if object_key not in SAP_OBJECTS:
        raise ValueError(f"Unknown SAP object: {object_key!r}")
    if field_map is None:
        field_map = load_field_map(object_key)
    active_map = [m for m in field_map if m.get("active", True)]

    kind = SAP_OBJECTS[object_key]["kind"]
    key_cols = _MASTER_KEY_COLUMNS.get(object_key, ()) if kind == "master" else ()

    out: list[dict] = []
    for rec in raw_records or []:
        if not isinstance(rec, dict):
            continue
        row: dict = {}
        for m in active_map:
            sap_field = m["sap_field"]
            if sap_field not in rec:
                continue
            row[m["nimbus_column"]] = apply_transform(m.get("transform", "none"),
                                                       rec.get(sap_field))
        # Ensure master key columns exist so bulk_apply sees a consistent shape.
        for kc in key_cols:
            row.setdefault(kc, None)
        out.append(row)
    return out


# ---------------------------------------------------------------------------
# Connectors — transport-agnostic. ALL are non-live STUBS in the skeleton.
# Network libs (httpx, pyrfc) are imported LAZILY inside method bodies only.
# ---------------------------------------------------------------------------
class SapConnector:
    """Base connector. The skeleton base is itself a no-op stub; concrete
    transports subclass it. `params` holds the (possibly secret) source params —
    NEVER log them."""

    transport = "base"

    def __init__(self, params: dict | None = None):
        self.params = params or {}

    def test_connection(self) -> dict:
        return {"ok": False, "detail": f"stub: {self.transport} not configured"}

    def extract(self, object_key: str, since=None) -> list[dict]:
        """Pull raw SAP records since the given watermark. Skeleton: returns []."""
        return []


class FileDropConnector(SapConnector):
    """Reads SAP extract files dropped on a shared/blob path. STUB: returns []."""

    transport = "file_drop"

    def test_connection(self) -> dict:
        return {"ok": False, "detail": "stub: file_drop not configured"}

    def extract(self, object_key: str, since=None) -> list[dict]:
        return []


class ODataConnector(SapConnector):
    """SAP OData / Gateway transport. STUB: returns []. httpx is imported lazily
    inside the method body only (never at module top)."""

    transport = "odata"

    def test_connection(self) -> dict:
        # Lazy import — only touched when a live connector is implemented.
        with contextlib.suppress(ImportError):
            import httpx  # noqa: F401  (lazy; not used in the skeleton)
        return {"ok": False, "detail": "stub: odata not configured"}

    def extract(self, object_key: str, since=None) -> list[dict]:
        with contextlib.suppress(ImportError):
            import httpx  # noqa: F401
        return []


class RfcConnector(SapConnector):
    """SAP RFC/BAPI transport via pyrfc. STUB: returns []. pyrfc is imported
    lazily inside the method body only (never at module top)."""

    transport = "rfc"

    def test_connection(self) -> dict:
        with contextlib.suppress(ImportError):
            import pyrfc  # noqa: F401  (lazy; not used in the skeleton)
        return {"ok": False, "detail": "stub: rfc not configured"}

    def extract(self, object_key: str, since=None) -> list[dict]:
        with contextlib.suppress(ImportError):
            import pyrfc  # noqa: F401
        return []


_CONNECTORS = {
    "file_drop": FileDropConnector,
    "odata":     ODataConnector,
    "rfc":       RfcConnector,
}


def make_connector(transport: str, params: dict | None = None) -> SapConnector:
    """Factory: transport in {file_drop, odata, rfc}. ValueError on unknown."""
    cls = _CONNECTORS.get(transport)
    if cls is None:
        raise ValueError(f"Unknown SAP transport: {transport!r}")
    return cls(params or {})


def test_connection(transport: str, params: dict | None = None) -> dict:
    """Module-level convenience wrapper: build the connector and probe it.
    NEVER logs `params` (may carry secrets)."""
    try:
        return make_connector(transport, params).test_connection()
    except ValueError as e:
        return {"ok": False, "detail": str(e)}


# ---------------------------------------------------------------------------
# Config persistence (sap_sync_config)
# ---------------------------------------------------------------------------
def get_config(object_key: str) -> dict:
    """Return the sync config for an object. If no row exists yet (e.g. seed not
    applied), return a sensible default so callers never crash."""
    if object_key not in SAP_OBJECTS:
        raise ValueError(f"Unknown SAP object: {object_key!r}")
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT object_key, enabled, transport, schedule_cron,"
            " source_params, last_watermark, updated_at"
            " FROM sap_sync_config WHERE object_key = %s",
            (object_key,),
        )
        r = cur.fetchone()
    if not r:
        return {
            "object_key":     object_key,
            "enabled":        False,
            "transport":      "file_drop",
            "schedule_cron":  None,
            "source_params":  {},
            "last_watermark": None,
            "updated_at":     None,
        }
    return {
        "object_key":     r[0],
        "enabled":        r[1],
        "transport":      r[2],
        "schedule_cron":  r[3],
        "source_params":  r[4] or {},
        "last_watermark": r[5],
        "updated_at":     r[6].isoformat() if r[6] else None,
    }


def set_config(object_key: str, *, enabled: bool | None = None,
               transport: str | None = None, schedule_cron: str | None = None,
               source_params: dict | None = None,
               last_watermark: str | None = None) -> dict:
    """Upsert the sync config for an object. Only non-None fields are written;
    `source_params`, when supplied, is MERGED into the existing JSONB (omitted
    keys are preserved, never wiped). Returns the updated config dict."""
    if object_key not in SAP_OBJECTS:
        raise ValueError(f"Unknown SAP object: {object_key!r}")
    if transport is not None and transport not in _CONNECTORS:
        raise ValueError(f"Unknown SAP transport: {transport!r}")

    with _pool.connection() as conn, conn.cursor() as cur:
        # Read current row (locking it) so the merge is atomic.
        cur.execute(
            "SELECT enabled, transport, schedule_cron, source_params, last_watermark"
            " FROM sap_sync_config WHERE object_key = %s FOR UPDATE",
            (object_key,),
        )
        existing = cur.fetchone()
        if existing:
            cur_enabled, cur_transport, cur_cron, cur_params, cur_wm = existing
        else:
            cur_enabled, cur_transport, cur_cron, cur_params, cur_wm = (
                False, "file_drop", None, {}, None,
            )

        new_enabled   = cur_enabled   if enabled is None       else bool(enabled)
        new_transport = cur_transport if transport is None     else transport
        new_cron      = cur_cron      if schedule_cron is None else schedule_cron
        new_wm        = cur_wm        if last_watermark is None else last_watermark
        # Merge source_params (never wipe omitted keys).
        merged_params = dict(cur_params or {})
        if source_params is not None:
            if not isinstance(source_params, dict):
                raise ValueError("source_params must be an object")
            merged_params.update(source_params)

        cur.execute(
            "INSERT INTO sap_sync_config"
            " (object_key, enabled, transport, schedule_cron, source_params, last_watermark, updated_at)"
            " VALUES (%s, %s, %s, %s, %s, %s, NOW())"
            " ON CONFLICT (object_key) DO UPDATE SET"
            "   enabled = EXCLUDED.enabled,"
            "   transport = EXCLUDED.transport,"
            "   schedule_cron = EXCLUDED.schedule_cron,"
            "   source_params = EXCLUDED.source_params,"
            "   last_watermark = EXCLUDED.last_watermark,"
            "   updated_at = NOW()",
            (object_key, new_enabled, new_transport, new_cron,
             Jsonb(merged_params), new_wm),
        )
        conn.commit()
    return get_config(object_key)


def update_watermark(object_key: str, value: str | None) -> dict:
    """Persist the high-water mark (last successfully-synced cursor) for an object."""
    if object_key not in SAP_OBJECTS:
        raise ValueError(f"Unknown SAP object: {object_key!r}")
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO sap_sync_config (object_key, last_watermark, updated_at)"
            " VALUES (%s, %s, NOW())"
            " ON CONFLICT (object_key) DO UPDATE SET"
            "   last_watermark = EXCLUDED.last_watermark, updated_at = NOW()",
            (object_key, value),
        )
        conn.commit()
    return {"object_key": object_key, "last_watermark": value}


def list_enabled_jobs() -> list[dict]:
    """Return objects that are enabled AND have a cron schedule — the set the
    scheduler turns into recurring jobs."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT object_key, transport, schedule_cron, source_params, last_watermark"
            " FROM sap_sync_config"
            " WHERE enabled = TRUE AND schedule_cron IS NOT NULL"
            " ORDER BY object_key",
        )
        return [
            {
                "object_key":     r[0],
                "transport":      r[1],
                "schedule_cron":  r[2],
                "source_params":  r[3] or {},
                "last_watermark": r[4],
            }
            for r in cur.fetchall()
        ]


# ---------------------------------------------------------------------------
# Run-history persistence (sap_sync_run)
# ---------------------------------------------------------------------------
def _run_start(object_key: str, watermark_before: str | None,
               triggered_by: str | None) -> int:
    """Insert a 'running' run row and return its id."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO sap_sync_run"
            " (object_key, status, watermark_before, triggered_by)"
            " VALUES (%s, 'running', %s, %s) RETURNING id",
            (object_key, watermark_before, triggered_by),
        )
        run_id = cur.fetchone()[0]
        conn.commit()
    return int(run_id)


def _run_finish(run_id: int, *, status: str, rows_read: int = 0,
                rows_inserted: int = 0, rows_updated: int = 0,
                rows_failed: int = 0, error: str | None = None,
                watermark_after: str | None = None) -> None:
    """Finalize a run row with counts + terminal status."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE sap_sync_run SET"
            "   ended_at = NOW(), status = %s, rows_read = %s,"
            "   rows_inserted = %s, rows_updated = %s, rows_failed = %s,"
            "   error = %s, watermark_after = %s"
            " WHERE id = %s",
            (status, rows_read, rows_inserted, rows_updated, rows_failed,
             error, watermark_after, run_id),
        )
        conn.commit()


def list_runs(object_key: str | None = None, limit: int = 50) -> list[dict]:
    """Return recent sync runs, newest first, optionally scoped to one object."""
    with _pool.connection() as conn, conn.cursor() as cur:
        if object_key:
            cur.execute(
                "SELECT id, object_key, started_at, ended_at, status, rows_read,"
                " rows_inserted, rows_updated, rows_failed, error,"
                " watermark_before, watermark_after, triggered_by"
                " FROM sap_sync_run WHERE object_key = %s"
                " ORDER BY started_at DESC LIMIT %s",
                (object_key, int(limit)),
            )
        else:
            cur.execute(
                "SELECT id, object_key, started_at, ended_at, status, rows_read,"
                " rows_inserted, rows_updated, rows_failed, error,"
                " watermark_before, watermark_after, triggered_by"
                " FROM sap_sync_run"
                " ORDER BY started_at DESC LIMIT %s",
                (int(limit),),
            )
        return [
            {
                "id":               int(r[0]),
                "object_key":       r[1],
                "started_at":       r[2].isoformat() if r[2] else None,
                "ended_at":         r[3].isoformat() if r[3] else None,
                "status":           r[4],
                "rows_read":        int(r[5]) if r[5] is not None else 0,
                "rows_inserted":    int(r[6]) if r[6] is not None else 0,
                "rows_updated":     int(r[7]) if r[7] is not None else 0,
                "rows_failed":      int(r[8]) if r[8] is not None else 0,
                "error":            r[9],
                "watermark_before": r[10],
                "watermark_after":  r[11],
                "triggered_by":     r[12],
            }
            for r in cur.fetchall()
        ]


# ---------------------------------------------------------------------------
# Sync orchestration
# ---------------------------------------------------------------------------
def sync_object(object_key: str, *, user_email: str | None = None,
                dry_run: bool = False) -> dict:
    """Run a single sync for one object.

    Flow: get_config -> make_connector -> _run_start -> connector.extract ->
    map_records -> (dry_run? skip persist : dispatch by kind) -> _run_finish.

    Dispatch:
      master -> md.bulk_apply(table, {"upserts": rows, "deletes": []}, user_email)
      orders -> db.upsert_orders(rows, source="sap", ...)

    Returns the contract dict. On any error the run row is marked 'error' with
    the message (NEVER credentials) and status 'error' is returned — the
    exception is swallowed so the scheduler/endpoint sees a structured result.
    """
    result = {
        "object_key":    object_key,
        "status":        "ok",
        "rows_read":     0,
        "rows_inserted": 0,
        "rows_updated":  0,
        "rows_failed":   0,
        "error":         None,
        "run_id":        None,
    }
    if object_key not in SAP_OBJECTS:
        result["status"] = "error"
        result["error"] = f"Unknown SAP object: {object_key!r}"
        return result

    kind = SAP_OBJECTS[object_key]["kind"]
    table = SAP_OBJECTS[object_key]["table"]

    cfg = get_config(object_key)
    watermark_before = cfg.get("last_watermark")
    run_id = None
    try:
        run_id = _run_start(object_key, watermark_before, user_email)
        result["run_id"] = run_id

        connector = make_connector(cfg["transport"], cfg.get("source_params") or {})
        raw_records = connector.extract(object_key, since=watermark_before)
        rows_read = len(raw_records)
        result["rows_read"] = rows_read

        mapped = map_records(object_key, raw_records)

        if dry_run:
            _run_finish(run_id, status="ok", rows_read=rows_read,
                        watermark_after=watermark_before)
            return result

        if not mapped:
            # Nothing to persist (expected for the non-live skeleton).
            _run_finish(run_id, status="ok", rows_read=rows_read,
                        watermark_after=watermark_before)
            return result

        if kind == "master":
            apply_res = md.bulk_apply(table, {"upserts": mapped, "deletes": []}, user_email)
            result["rows_inserted"] = int(apply_res.get("inserted", 0))
            result["rows_updated"] = int(apply_res.get("updated", 0))
        else:  # orders
            # Stage 0 observation seam.  Keep this immediately before the
            # shared orders upsert; setup data remains read-only to scheduling.
            setup_data.capture_setup_states_before_schedule_mutation(
                actor=user_email or "system", reason="SAP order replacement"
            )
            apply_res = db.upsert_orders(mapped, source="sap", batch_id=None,
                                         filename=None, raw_row_count=rows_read)
            result["rows_inserted"] = int(apply_res.get("inserted", 0))
            result["rows_updated"] = int(apply_res.get("updated", 0))
            result["rows_failed"] = int(apply_res.get("failed", 0))

        _run_finish(run_id, status="ok", rows_read=rows_read,
                    rows_inserted=result["rows_inserted"],
                    rows_updated=result["rows_updated"],
                    rows_failed=result["rows_failed"],
                    watermark_after=watermark_before)
        return result
    except Exception as e:
        # Record the failure WITHOUT leaking credentials. str(e) is the exception
        # message only; connector implementations must not embed secrets in it.
        msg = f"{type(e).__name__}: {e}"
        result["status"] = "error"
        result["error"] = msg
        log.error("SAP sync failed for %s", object_key,
                  extra={"category": "sap_sync", "user": user_email})
        if run_id is not None:
            try:
                _run_finish(run_id, status="error",
                            rows_read=result["rows_read"], error=msg,
                            watermark_after=watermark_before)
            except Exception:
                log.warning("Failed to record SAP run failure for %s", object_key,
                            extra={"category": "sap_sync"})
        return result
