# Alert Profiles revamp: progress ledger

- Plan: `C:\Users\PJ29587\.claude\plans\i-want-to-revamp-refactored-bear.md` (rev 3); design doc `docs/superpowers/specs/2026-10-30-alert-profiles-revamp-design.md`
- Branch: `feature/alert-profiles-revamp` (worktree `.claude/worktrees/alert-profiles-revamp`), base commit `00d512c`
- Mockup of record: https://claude.ai/artifact/V5dMeUrzrVwRcWP9vv6QXF (version 6); repo copy `docs/superpowers/specs/assets/2026-10-30-alert-profiles-mockup.html`

Each wave appends its own line below.

W0: design doc + mockup committed (558a6e5)

W1: late category (79c6d88) — late split out of Other into its own seventh category (ALERT_CATEGORY_ORDER, aliases, locales x5, --bar-pm-late stone placeholder, legend, briefing fallback); tests: 962 targeted (960 pass, 2 skipped bench), full modules 5747 (1 unrelated failure: frozen-horizon-rolling)

W2: palette + tokens (0019fc1) — nine-swatch --pal-* tokens in :root and body.dark, --bar-pm-<cat> re-pointed, generic warn ring, categoryColorDecls/applyCategoryColors, minimap per-category colour + _cssVar on body; light sky #30b0ec, sand #bfa57a; tests: 1278 targeted (1276 pass, 2 skipped bench), full modules 5772 (1 unrelated failure: frozen-horizon-rolling)
