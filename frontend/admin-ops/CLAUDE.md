# Admin Ops — pointer

Substantive docs for this domain live at `backend/admin_ops/CLAUDE.md`.

## Logs tab (frontend ring + backend ring)

`admin-ui.mts` Logs: `#admin-log-export-json` calls `ErrorLog.exportJson()`; `#admin-log-user` sets `_logFilter.user` (exact match on `LogEntry.user` in `_getFilteredEntries`, also used by Copy filtered). `#admin-backend-log-user` is created lazily beside `#admin-backend-log-q` and sends `user=` to `GET /logs/backend`.
