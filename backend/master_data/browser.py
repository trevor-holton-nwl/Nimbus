"""
NIMBUS 2.0 — Admin universal table browser (Workstream E).

A read-only, catalog-driven browser over every table in the `public` schema,
sibling to db.py / master_data.py / setup_data.py. It composes two patterns
that exist elsewhere in this codebase but have never been combined:

  * Per-request (never cached) catalog discovery — unlike
    `db._get_maint_table_allowlist`, which is a lazy process-global cache
    that never sees a table created after startup.
  * `psycopg.sql.Identifier`-based dynamic SQL — unlike
    `master_data.ALLOWED_TABLES`, which is a hardcoded frozenset.

Every table/column name used to build a query here is validated, on THIS
call, against a fresh `information_schema`/`pg_constraint` read — never
against a hardcoded list, never against a cached one. That per-request
freshness is the actual security property this module rests on: an
Identifier-wrapped name is only as safe as the set it was checked against.

Deliberately unscoped by plant (OD-E2, see brain.py route comments) and
deliberately read-only (OD-E3): no function in this module ever
constructs an INSERT/UPDATE/DELETE or DDL statement. That is what makes
catalog-wide, cross-plant access an acceptable trade for this one surface.
"""
import csv
import io
import logging
from collections.abc import Iterator

from psycopg import sql

from backend.csv_util import CSV_BOM, csv_row, us_date_row
from db import _pool

log = logging.getLogger("nimbus.admin_tables")

# ---------------------------------------------------------------------------
# "Internal" flagging — NOT an exclusion list. Every one of these still
# appears in list_tables()'s output; they are just marked internal=True so
# the frontend can visually de-emphasize them. Exact names plus a couple of
# naming-pattern families (SAP sync's tables).
# ---------------------------------------------------------------------------
_INTERNAL_EXACT = frozenset({"schema_migrations", "admin_audit", "column_metadata", "sap_field_map"})
_INTERNAL_PREFIXES = ("sap_sync_", "sap_stage_")

# OD-E1: streaming CSV export soft cap. Not a hard error — export.csv keeps
# working past this many rows, it just truncates and tells the caller where
# to resume (see stream_csv_rows).
EXPORT_ROW_CAP = 250_000

# Marker line appended to a truncated CSV export. A client must treat any
# line starting with this prefix as "not a data row" and can resume the
# export by re-requesting with ?offset=<resume_offset from this line>.
TRUNCATION_MARKER_PREFIX = "# NIMBUS_TRUNCATED"


class UnknownTable(ValueError):
    """Requested table is not in this request's fresh catalog listing."""


class UnknownColumn(ValueError):
    """Requested filter column is not a real column of the requested table."""


def _is_internal(table_name: str) -> bool:
    return table_name in _INTERNAL_EXACT or any(table_name.startswith(p) for p in _INTERNAL_PREFIXES)


# ---------------------------------------------------------------------------
# Fresh-per-call catalog discovery
# ---------------------------------------------------------------------------
def _known_tables(cur) -> set[str]:
    """Every base table in `public`, read fresh on this call. This is the
    ONLY thing that makes it safe to wrap a caller-supplied table name in
    sql.Identifier below — it is checked against exactly this set, fetched
    on this request, never a module-level cache."""
    cur.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
    )
    return {r[0] for r in cur.fetchall()}


def _row_count_estimates(cur) -> dict[str, int]:
    """Approximate row count per table from pg_stat_user_tables.n_live_tup —
    deliberately NOT a COUNT(*) per table (that would be an O(tables) full
    scan on every single listing call, which does not scale at 50+ plants'
    worth of tables). Left-joined against information_schema.tables by the
    caller so a table with no stats-collector row yet (freshly created,
    never analyzed) still shows up, just with an approximate count of 0."""
    cur.execute("SELECT relname, n_live_tup FROM pg_stat_user_tables")
    return {r[0]: int(r[1] or 0) for r in cur.fetchall()}


def _pk_columns_all(cur, table: str | None = None) -> dict[str, list[str]]:
    """Primary-key column names per table, in key order. One query for the
    whole catalog (or one table, via `table`) — never per-table N+1 when
    listing the full catalog. Uses pg_constraint/pg_attribute directly
    (not information_schema's tc/kcu join) — for a *composite* key this is
    unambiguous, where a naive kcu-only join risks reordering columns."""
    query = """
        SELECT c.relname AS table_name, a.attname AS column_name, k.ord
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        WHERE con.contype = 'p' AND n.nspname = 'public'
    """
    params: list = []
    if table is not None:
        query += " AND c.relname = %s"
        params.append(table)
    query += " ORDER BY table_name, k.ord"
    cur.execute(query, params)
    result: dict[str, list[str]] = {}
    for table_name, column_name, _ord in cur.fetchall():
        result.setdefault(table_name, []).append(column_name)
    return result


def _fk_columns_all(cur, table: str | None = None) -> dict[str, list[dict]]:
    """Foreign-key column names per table (+ referenced table/column), in
    key order. Zips `conkey`/`confkey` element-wise via `unnest(a, b)` so a
    *composite* FK (e.g. machine's (subnetwork, plant) -> plants(subnetwork,
    plant)) pairs each referencing column with its correct referenced
    column — the classic footgun here is joining
    information_schema.key_column_usage to constraint_column_usage on
    constraint_name alone, which silently cross-products every referencing
    column against every referenced column for a composite FK."""
    query = """
        SELECT c.relname AS table_name, a.attname AS column_name,
               rc.relname AS ref_table, ra.attname AS ref_column, k.ord
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_class rc ON rc.oid = con.confrelid
        JOIN unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, fattnum, ord) ON true
        JOIN pg_attribute a  ON a.attrelid = con.conrelid  AND a.attnum = k.attnum
        JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.fattnum
        WHERE con.contype = 'f' AND n.nspname = 'public'
    """
    params: list = []
    if table is not None:
        query += " AND c.relname = %s"
        params.append(table)
    query += " ORDER BY table_name, k.ord"
    cur.execute(query, params)
    result: dict[str, list[dict]] = {}
    for table_name, column_name, ref_table, ref_column, _ord in cur.fetchall():
        result.setdefault(table_name, []).append(
            {"column": column_name, "ref_table": ref_table, "ref_column": ref_column}
        )
    return result


def _columns_for_table(cur, table: str) -> list[dict]:
    """Every physical column of `table`, in ordinal position — unlike
    master_data._column_meta, this is NOT gated by column_metadata
    registration (a brand-new or unregistered table has no column_metadata
    rows at all, and this browser must show it anyway)."""
    cur.execute(
        """
        SELECT column_name, data_type, is_nullable, ordinal_position
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = %s
        ORDER BY ordinal_position
        """,
        (table,),
    )
    return [
        {"name": r[0], "sql_type": r[1], "is_nullable": r[2] == "YES", "ordinal_position": r[3]}
        for r in cur.fetchall()
    ]


def list_tables() -> list[dict]:
    """Catalog listing for GET /admin/tables. Fresh on every call — no
    memoization anywhere in this function. Returns one dict per table:
        {table, approx_row_count, internal, pk_columns, fk_columns}
    where fk_columns is a list of {column, ref_table, ref_column}.
    """
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
        )
        table_names = [r[0] for r in cur.fetchall()]
        row_counts = _row_count_estimates(cur)
        pk_map = _pk_columns_all(cur)
        fk_map = _fk_columns_all(cur)

    return [
        {
            "table": name,
            "approx_row_count": row_counts.get(name, 0),
            "internal": _is_internal(name),
            "pk_columns": pk_map.get(name, []),
            "fk_columns": fk_map.get(name, []),
        }
        for name in table_names
    ]


# ---------------------------------------------------------------------------
# Safe dynamic SQL — validation + composition shared by fetch_rows and the
# CSV export path.
# ---------------------------------------------------------------------------
def _normalize_filters(filters: dict[str, list[str]] | None) -> dict[str, list[str]]:
    """An empty value list for a column means "no filter on that column" —
    NEVER a degenerate WHERE col IN () that would match nothing. Columns
    with no values are dropped entirely before any SQL is built."""
    if not filters:
        return {}
    return {col: list(values) for col, values in filters.items() if values}


def _validate_and_describe(cur, table: str) -> tuple[list[dict], list[str]]:
    """Validate `table` against THIS call's fresh catalog, then return its
    column metadata (each flagged is_pk/is_fk, FKs carrying ref_table/
    ref_column) plus the plain column-name list. Raises UnknownTable if the
    name isn't a real table right now."""
    if table not in _known_tables(cur):
        raise UnknownTable(f"Unknown table: {table!r}")
    columns = _columns_for_table(cur, table)
    pk_cols = set(_pk_columns_all(cur, table).get(table, []))
    fk_list = _fk_columns_all(cur, table).get(table, [])
    fk_by_col = {f["column"]: f for f in fk_list}
    for col in columns:
        col["is_pk"] = col["name"] in pk_cols
        fk = fk_by_col.get(col["name"])
        col["is_fk"] = fk is not None
        col["ref_table"] = fk["ref_table"] if fk else None
        col["ref_column"] = fk["ref_column"] if fk else None
    return columns, [c["name"] for c in columns]


def _build_where(active_filters: dict[str, list[str]], valid_columns: set[str]) -> tuple["sql.Composable", list]:
    """Identifier-wrap every filter column, parameter-placeholder every
    filter value, multi-value via IN (...). Raises UnknownColumn if a
    filter names something that isn't actually a column of this table —
    validated against `valid_columns`, itself fetched fresh moments ago."""
    unknown = [c for c in active_filters if c not in valid_columns]
    if unknown:
        raise UnknownColumn(f"Unknown column(s) for filter on this table: {unknown!r}")
    where_parts = []
    params: list = []
    for col, values in active_filters.items():
        where_parts.append(
            sql.SQL("{col} IN ({placeholders})").format(
                col=sql.Identifier(col),
                placeholders=sql.SQL(", ").join(sql.Placeholder() for _ in values),
            )
        )
        params.extend(values)
    where_sql = (sql.SQL(" WHERE ") + sql.SQL(" AND ").join(where_parts)) if where_parts else sql.SQL("")
    return where_sql, params


def validate_table_and_filters(table: str, filters: dict[str, list[str]] | None = None) -> None:
    """Cheap up-front validation (table exists, filter columns are real)
    used by the export route to fail with a normal 404/400 BEFORE
    committing to a StreamingResponse — once streaming starts, HTTP status
    can no longer change."""
    active_filters = _normalize_filters(filters)
    with _pool.connection() as conn, conn.cursor() as cur:
        if table not in _known_tables(cur):
            raise UnknownTable(f"Unknown table: {table!r}")
        col_names = {c["name"] for c in _columns_for_table(cur, table)}
        unknown = [c for c in active_filters if c not in col_names]
        if unknown:
            raise UnknownColumn(f"Unknown column(s) for filter on this table: {unknown!r}")


def fetch_rows(table: str, *, limit: int, offset: int,
               filters: dict[str, list[str]] | None = None) -> dict:
    """
    Safe, paginated `SELECT` against `table` (re-validated against the
    catalog fresh on this call) for GET /admin/tables/{table}.

    `filters`: {column_name: [value, ...]}. Multi-value via `IN (...)`; an
    empty list for a column means no filter on it (see _normalize_filters).
    A value with no matching row is not an error — it simply contributes no
    rows to the result, which is IN (...)'s ordinary semantics.

    Returns {"columns": [...], "rows": [...], "meta": {"total", "limit", "offset"}}
    where each column dict is {name, sql_type, is_nullable, ordinal_position,
    is_pk, is_fk, ref_table, ref_column} and `meta.total` is the full
    filtered row count ignoring limit/offset (mirrors GET /tasks).
    """
    active_filters = _normalize_filters(filters)
    with _pool.connection() as conn, conn.cursor() as cur:
        columns, col_names = _validate_and_describe(cur, table)
        where_sql, params = _build_where(active_filters, set(col_names))

        pk_cols = [c["name"] for c in columns if c["is_pk"]]
        order_cols = pk_cols or col_names[:1]
        order_sql = (
            sql.SQL(" ORDER BY ") + sql.SQL(", ").join(sql.Identifier(c) for c in order_cols)
            if order_cols else sql.SQL("")
        )

        select_idents = sql.SQL(", ").join(sql.Identifier(c) for c in col_names)
        query = (
            sql.SQL("SELECT {cols} FROM {tbl}").format(cols=select_idents, tbl=sql.Identifier(table))
            + where_sql + order_sql
            + sql.SQL(" LIMIT %s OFFSET %s")
        )
        cur.execute(query, [*params, limit, offset])
        rows = [dict(zip(col_names, r, strict=True)) for r in cur.fetchall()]

        count_query = sql.SQL("SELECT COUNT(*) FROM {tbl}").format(tbl=sql.Identifier(table)) + where_sql
        cur.execute(count_query, params)
        total = int(cur.fetchone()[0])

    return {
        "columns": columns,
        "rows": rows,
        "meta": {"total": total, "limit": limit, "offset": offset},
    }


def stream_csv_rows(table: str, *, filters: dict[str, list[str]] | None = None,
                     offset: int = 0, row_cap: int = EXPORT_ROW_CAP) -> Iterator[str]:
    """
    Generator of CSV text chunks for GET /admin/tables/{table}/export.csv.
    Streams via psycopg's `Cursor.stream()` (a real server-side portal —
    rows are pulled from Postgres incrementally, the full result set is
    never materialized in this process) so a multi-hundred-thousand-row
    table doesn't balloon memory.

    Truncation signaling (OD-E1): if more than `row_cap` rows match, the
    stream stops after exactly `row_cap` data rows and appends one final
    line:
        # NIMBUS_TRUNCATED,resume_offset=<N>,rows_written=<row_cap>
    A client MUST treat any line starting with TRUNCATION_MARKER_PREFIX
    ("# NIMBUS_TRUNCATED") as a truncation signal, not a data row, and may
    resume by re-requesting this export with ?offset=<resume_offset>. This
    is a real streaming response, so unlike a response header, the caller
    cannot know up front whether the cap will be hit — the marker row is
    the only place that fact can be communicated once the body has started.
    An export that does NOT hit the cap has no trailing marker at all.

    Caller is expected to have already called validate_table_and_filters()
    so a bad table/column name surfaces as a normal HTTP error rather than
    a truncated-looking CSV stream.
    """
    active_filters = _normalize_filters(filters)
    with _pool.connection() as conn, conn.cursor() as cur:
        columns, col_names = _validate_and_describe(cur, table)
        where_sql, params = _build_where(active_filters, set(col_names))

        pk_cols = [c["name"] for c in columns if c["is_pk"]]
        order_cols = pk_cols or col_names[:1]
        order_sql = (
            sql.SQL(" ORDER BY ") + sql.SQL(", ").join(sql.Identifier(c) for c in order_cols)
            if order_cols else sql.SQL("")
        )
        select_idents = sql.SQL(", ").join(sql.Identifier(c) for c in col_names)
        query = (
            sql.SQL("SELECT {cols} FROM {tbl}").format(cols=select_idents, tbl=sql.Identifier(table))
            + where_sql + order_sql
            + sql.SQL(" OFFSET %s")
        )

        buf = io.StringIO()
        writer = csv.writer(buf)

        def _flush() -> str:
            value = buf.getvalue()
            buf.seek(0)
            buf.truncate(0)
            return value

        buf.write(CSV_BOM)
        writer.writerow(csv_row(col_names))
        yield _flush()

        written = 0
        truncated = False
        for row in cur.stream(query, [*params, offset]):
            if written >= row_cap:
                truncated = True
                break
            writer.writerow(csv_row(us_date_row(row)))
            yield _flush()
            written += 1

        if truncated:
            yield f"{TRUNCATION_MARKER_PREFIX},resume_offset={offset + written},rows_written={written}\r\n"
