# Gantt follows the active alert profile: progress ledger

Plan of record: C:\Users\PJ29587\.claude\plans\rosy-puzzling-naur.md. Branch `fix/gantt-profile-colors` from main d6a40df. Not pushed, not merged, not deployed.

- ec9a6bb  1+2 backend: `current()` is the one accessor (view() removed, session pick wins); gantt_colors column, migration 2026-11-01-1, schema.sql, bootstrap, validate_gantt_colors, routes.
- 8c36a42  2+3 frontend: types/client/draft, editor "Colour the Gantt" checkbox, gantt consumer reads profile.gantt_colors, per-user highlight pref UI retired, "New profile..." moved to the page menu, five locales, settings choose clears the session pick.
- f6d220e  5 tests: matches/focus/colors/gantt/pane/editor/shell/locale tests; pytest fixtures and gantt_colors tests.
- (this commit)  4 docs + this ledger.

Results: build OK; typecheck OK; lint 0 errors (43 warnings, none new: the one in a touched file, gantt.mts:1707, predates this change); check:static-assets OK; check:legacy-surface OK; `npm test`: legacy 143/143, modules 5862 tests, 5855 pass, 0 fail, 3 skipped.
pytest (3 alert-profile files, local Postgres, credentials supplied via the process environment only): 65 passed, 0 skipped, including the gantt_colors DB round trip. (An earlier run without credentials: 60 passed, 5 skipped.)
Owed: browser checks (plan Verification 2-5), deploy needs the migration first (`-Only 2026-11-01-1 -AllowDestructive`), memory note update.
