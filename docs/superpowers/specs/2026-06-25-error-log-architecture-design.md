# NIMBUS Error-Log Architecture Enhancement — Design Spec

**Date:** 2026-06-25
**Author:** Error-log architect (Claude) + Trevor Holton
**Status:** Approved for implementation ("go off!")
**Scope guardrail:** *Comprehensive enhancement, strictly non-breaking.* Additive fields, optional params (default-off), new endpoints only. No existing record shape, function signature, or HTTP status semantic changes. Old log readers and external clients must keep working.

---

## 0. Problem (current state, evidence-backed)

- **Backend stack traces never reach the operator buffer.** `_log_event` (`brain.py:272`) never sets `exc_info`; the only traceback is `_req_log.exception()` (`brain.py:190`) on stdout. The Admin Cockpit reads `/logs/backend`, which therefore shows only `str(e)`.
- **Uncaught DB errors collapse to opaque 500.** `master_data.py` writes catch only `ValueError`; an `IntegrityError` falls through to the catch-all `"Internal server error"` (`brain.py:237-242`), constraint name discarded.
- **No request-id correlation.** Backend threads `x-request-id` on responses but never into business events; frontend stores it only inside the message string. Joining a user report to a backend log is timestamp-guessing.
- **Hard failures masquerade as HTTP 200.** Bulk task-date rollback (`brain.py:792`) and maintenance (`brain.py:1341`) return 200 with the failure buried.
- **Silent swallows erase failure classes.** `except Exception: pass` at `brain.py:371/382/407/932`, `master_data.py:167`.
- **Dark paths.** Worker compute failures (`app.js:3531/3637`) and the entire `nimbus-intelligence.js` layer bypass the log.
- **No taxonomy.** Every error is free-text `str(e)` on both tiers — un-aggregatable.

---

## 1. Shared contracts (FIXED — all implementers build against these)

### 1.1 Error-code vocabulary (identical strings on both tiers)

| code | trigger |
|------|---------|
| `db.unique_violation` | psycopg SQLSTATE 23505 |
| `db.fk_violation` | 23503 |
| `db.not_null` | 23502 |
| `db.check_violation` | 23514 |
| `db.lock_timeout` | 57014 (query canceled / statement_timeout) |
| `db.serialization_failure` | 40001 |
| `db.deadlock` | 40P01 |
| `db.error` | any other psycopg.Error |
| `xlsx.parse` | Excel/openpyxl/pandas parse failure |
| `file.not_found` | missing color-wheel / file |
| `file.read` | unreadable/corrupt file |
| `validation` | ValueError / bad request input |
| `worker.compute` | web-worker compute failure |
| `http.network` | fetch threw (network) |
| `http.status` | resolved non-ok response |
| `internal` | uncaught / unknown |

### 1.2 Backend `_log_event` signature (v2, backward compatible)

```python
_log_event(level, category, msg, *, exc=None, error_code=None, **ctx)
```

- When `exc` is provided: pass `exc_info=exc` to the logger so `_JsonFormatter`'s existing `exc` branch (`brain.py:65`) fires; capture `error_type=type(exc).__name__` and the formatted traceback into the **ring-buffer** entry too (not just stdout).
- `error_code`: explicit code, else derived from the psycopg translator when `exc` is a `psycopg.Error`, else omitted.
- `rid`: read from a `contextvars.ContextVar` (set in `request_id_mw`) so every event auto-carries it. Populate the `_JsonFormatter.rid` slot.
- All existing call sites (which pass only positional + `**ctx`) keep working unchanged.

### 1.3 Backend ring-buffer entry shape (v2, additive)

```jsonc
{ "ts", "level"/*info|warn|error*/, "category", "msg",
  "rid"?, "error_code"?, "error_type"?, "exc"? /*traceback str*/,
  "source"? /*"backend"|"frontend"*/, "ctx"? }
```
Unify level vocab (`info|warn|error`) and `ts` (event time) across **both** sinks (ring + JSON line) — fix `_JsonFormatter` to use the NIMBUS level/ts when present. Unify `_warn`'s `context` key → `ctx`.

### 1.4 psycopg error translator (in `db.py`, reused by `master_data.py`)

```python
translate_db_error(exc) -> {
  "error_code", "sqlstate", "constraint_name", "table_name",
  "column_name", "detail", "hint",
  "client_message",   # actionable, safe to show user
  "http_status"       # 409 for 23505/23503; 400 for 23502/23514; 503 for 57014/40001/40P01; 500 else
}
```
Wired via `@api.exception_handler(psycopg.Error)` in `brain.py`. `client_message` examples: `"Duplicate value violates constraint plants_pkey"`, `"Still referenced by rows in material_plants"`, `"Required field missing: plant"`.

### 1.5 Client-facing message policy (FIXED)

- **Known DB errors** → `client_message` from the translator (actionable, no raw SQL/paths).
- **Everything else** → clean message + request-id reference: `"Internal error — ref: <rid>"`. Full detail (traceback, raw `str(e)`) stays in admin logs only.
- Remove raw `{e}` leakage at `brain.py:600/837/988/1040/1132` (replace with policy above).
- Hard-failure bodies (`brain.py:792`, `1341`) keep their HTTP status but **add** `status:'error'` + `error_code` + structured cause.

### 1.6 `POST /logs/frontend` (new sink)

- Body: `{ entries: [ { ts, level, scope, msg, errorCode?, reqId?, stack?, buildId?, sessionId?, plant?, route?, ctx? } ] }`
- Best-effort; validates/caps batch (max 50 entries; truncate long strings, e.g. stack ≤ 8 KB, msg ≤ 2 KB).
- Folds each entry into `_BACKEND_LOG` tagged `source:'frontend'`, `category = scope || 'frontend'`, preserving `rid`/`error_code`/`stack`.
- Returns `{status:'ok', accepted:N}`. No auth (it is a log sink), but size-bounded.

### 1.7 Worker error message contract (`app.js` Compute ↔ `nimbus-worker.js`)

- `nimbus-worker.js` ERROR post: `{ type:'ERROR', error: err.message, stack: err.stack, failingType: <request type>, jobId? }` (`nimbus-worker.js:521`). **No compute-rule changes** — error reporting only.
- `app.js` Compute `onmessage` ERROR handler reads `stack`/`failingType`; `worker.onerror` (`app.js:3531`) builds `{message, filename, lineno, colno}` from the `ErrorEvent` and calls `ErrorLog.error('worker', msg, {...})` **before** flipping `_dead`. The swallowed `recompute().catch` (`app.js:3637`) logs `ErrorLog.warn('worker', 'compute fell back to main thread', {error})`.

### 1.8 Frontend `ErrorLog` record v2 (additive)

`{ts, level, scope, msg, ctx}` → add `reqId, errorCode, stack, buildId, sessionId, plant, route`. All optional. Old viewers/exporters keep working.

---

## 2. Backend work (`brain.py`, `db.py`, `master_data.py`)

1. `contextvars.ContextVar` rid set in `request_id_mw` (`brain.py:184`), read in `_log_event`; feed `_JsonFormatter.rid`.
2. `_log_event` v2 (exc capture → traceback in ring + JSON; error_code; rid).
3. `translate_db_error` in `db.py`; `@api.exception_handler(psycopg.Error)` in `brain.py`.
4. Catch `psycopg.Error` in `master_data.py` write funcs (`bulk_apply`, `add_column`, `drop_column`, `rename_label`, `set_plant_constraints`, labor upserts) → re-raise as enriched / let the handler translate; surface `constraint_name`/`table_name`.
5. Fix silent swallows (`brain.py:371/382/407/932`, `master_data.py:167` → narrow to `UndefinedColumn`) → `_log_event('warn', ..., exc=e)` with filename/plant.
6. Stop folding exc into `msg` (`brain.py:1349/1362`); stop raw `{e}` leak (`brain.py:600/837/988/1040/1132`).
7. Honest body signal on `brain.py:792` (bulk) and `1341` (maintenance) — status unchanged.
8. `GET /logs/backend`: add `?category=`, `?since=` (ISO), free-text `?q=`, offset pagination (keep `?level=`/`?limit=`).
9. `POST /logs/backend/clear`: behind `require_api_key`, record actor (`X-User`/`x-user-email`).
10. `POST /logs/frontend` sink (§1.6).
11. Write a `status='failed'` `upload_audit` row on ingest failure (`db.py:1078-1147`) so failed uploads leave a trail.

## 3. Frontend work (`app.js`, `nimbus-worker.js`, `nimbus-intelligence.js`)

1. `ErrorLog` record v2 (§1.8); central enrichment in `_push` (`app.js:5323`): auto `(new Error()).stack` on error-level, `buildId`(`NIMBUS_BUILD_ID`/`APP_VERSION`), per-load `sessionId`, `Store.selectedPlant`, current tab/route. Reset `_recent` in `clear()` (`app.js:5366`); overflow marker at MAX.
2. `fetchTraced` (`app.js:275`): clone+drain error body on `!ok` (`message||detail`); store `reqId`/`errorCode`/`status`/`url`/`method`/`ms` as **structured ctx fields**, not just in the string.
3. Shared `apiCall`/`parseBackendError` helper; migrate raw-fetch sites (`saveAll` 11042, `_upload` 12068, `_purge` 12125, inspector note, MasterData load 14445) so each gets **both** reqId and parsed body.
4. Worker logging (§1.7).
5. Route `nimbus-intelligence.js` (`:20/349/1029/2146` + bare `catch {}`) through guarded `window.NIMBUS?.ErrorLog?.warn`.
6. Durability: persist ring to IndexedDB (reuse `IntelDB`); batch-ship error-level entries to `/logs/frontend` (non-blocking, fire-and-forget, deduped). Raise diagnostics bundle slice 200→500 (`app.js:13356`).
7. Breadcrumb ring (last N typed `Interaction` events) attached to error entries.
8. Admin viewer upgrades (`app.js:12172/12755/12853`): `reqId` column + click-through correlation between FE/BE panes; filter by `errorCode`/category; surface new server-side backend filters; overflow marker.

## 4. Non-regression strategy

- Additive only; default-off optional params; no signature/shape/status changes to existing paths.
- **Worker discipline:** `nimbus-worker.js` change is error-reporting only — never a `Calendar`/`Alerts` compute rule (CLAUDE.md mirror constraint preserved).
- Perf: FE ship best-effort/batched/non-blocking; `_push` enrichment cheap (Error() only on error-level); backend filtering in-memory; **no** synchronous DB writes added to hot paths.
- Reads `NIMBUS_BUILD_ID`/`APP_VERSION`; does **not** bump them (deploy action).

## 5. Tests (`tests/`, pytest)

- `translate_db_error` SQLSTATE→{code, http_status, client_message} mapping.
- `_log_event` captures `error_type`/traceback into the ring when `exc` passed; rid threads from contextvar.
- `GET /logs/backend` filtering (`category`/`since`/`q`/pagination).
- `POST /logs/frontend` validation/caps + fold into ring with `source:'frontend'`.
- DB-dependent tests guarded/skipped when Postgres unavailable (per local env).
