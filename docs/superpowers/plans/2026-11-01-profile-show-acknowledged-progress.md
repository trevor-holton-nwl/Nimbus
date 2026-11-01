# Show acknowledged is a profile setting: progress ledger

Owner decision 2026-11-01. Branch `fix/profile-show-acknowledged` from main 4efc376. Not pushed, not merged, not deployed. Mirrors the `gantt_colors` change (ec9a6bb, 8c36a42, f6d220e, 3e1df2e).

- 5f23c7e  backend: `show_acknowledged` column (migration 2026-11-01-2-alert-profile-show-acknowledged, schema.sql, bootstrap), `validate_show_acknowledged`, `_PROFILE_COLS` index 12, routes; pytest.
- d3305e8  frontend + tests + docs (one commit): types/client/draft, editor checkbox "Include acknowledged alerts" under Colour the Gantt, readers switched to the active profile flag (pane `_gatherState`, `_applyFocus`, insights-ui bell, Gantt `_profileMatchClasses`), page menu keeps only New profile, `am.ack_show` retired, five locales; JS tests.

The `alertsShowAcknowledged` registry entry in `application-shell.mts` stays (harmless; a stored value still round-trips). No User Settings row rendered it.
Owed: browser checks; deploy needs the migration first (`-Only 2026-11-01-2-alert-profile -AllowDestructive`).

Results: build OK; typecheck OK; lint 0 errors (43 warnings, same as baseline); check:static-assets OK; check:legacy-surface OK; npm test legacy 143/143, modules 5867 tests, 5860 pass, 0 fail, 3 skipped. pytest (3 alert-profile files, local Postgres): 70 passed.
