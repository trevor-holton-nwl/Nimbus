# Admin Ops — pointer

Substantive docs for this domain live at `backend/admin_ops/CLAUDE.md`.

## Logs tab (frontend ring + backend ring)

`admin-ui.mts` Logs: `#admin-log-export-json` calls `ErrorLog.exportJson()`; `#admin-log-user` sets `_logFilter.user` (exact match on `LogEntry.user` in `_getFilteredEntries`, also used by Copy filtered). `#admin-backend-log-user` is created lazily beside `#admin-backend-log-q` and sends `user=` to `GET /logs/backend`.

## Schedule event retention input (2026-10-23)

System Configuration (`admin-ui.mts`) has an order-history retention number input (`#sc-retention-days`, 1-60, default 14) read from and saved in the same `/system-settings` POST as the order-field visibility settings (`schedule_event_retention_days`); the server rejects values outside 1-60 with a 400. Details: `backend/schedule_events/CLAUDE.md`.

## Jobs tab (2026-10-29)

The Admin > Jobs tab (`jobs-model/client/pane/dialog/run-detail.mts`, sub-tab strip beside the others) drives `backend/jobs/`; the run summary carries `steps`, counts and `action_id`. Substantive docs: `backend/jobs/CLAUDE.md`.

- **Control ids are per sub-view** (`jobs-*`, `jobs-runs-*`, `jobs-up-*`): the three views stay in the DOM side by side, so a shared id answered `getElementById` with a hidden copy (pinned by `tests/modules/admin-ops/jobs-pane.test.mjs`). A new job opens as a **proposal** (auto-apply is an explicit admin opt-in), seeded from `GET /jobs/types` `defaults`. The log viewer pages (`limit=2000`, keeps reading while a page is full), the runs poll merges page 1 into loaded pages, the 7-day strip says so when the server's 50-entry cap ends before the week, and Escape / X ask before discarding a dirty form.
- **Deferred:** the plant combobox's ARIA wiring (`aria-activedescendant`, option ids, `aria-controls`) is the same accepted debt as the copies in master-data and distribution; fix all copies together, not just this one.
