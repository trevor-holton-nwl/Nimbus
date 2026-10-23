# Admin Ops — pointer

Substantive docs for this domain live at `backend/admin_ops/CLAUDE.md`.

## Logs tab (frontend ring + backend ring)

`admin-ui.mts` Logs: `#admin-log-export-json` calls `ErrorLog.exportJson()`; `#admin-log-user` sets `_logFilter.user` (exact match on `LogEntry.user` in `_getFilteredEntries`, also used by Copy filtered). `#admin-backend-log-user` is created lazily beside `#admin-backend-log-q` and sends `user=` to `GET /logs/backend`.

## Schedule event retention input (2026-10-23)

System Configuration (`admin-ui.mts`) has an order-history retention number input (`#sc-retention-days`, 1-60, default 14) read from and saved in the same `/system-settings` POST as the order-field visibility settings (`schedule_event_retention_days`); the server rejects values outside 1-60 with a 400. Details: `backend/schedule_events/CLAUDE.md`.
