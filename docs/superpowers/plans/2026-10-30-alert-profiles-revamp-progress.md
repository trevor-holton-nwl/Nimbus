# Alert Profiles revamp: progress ledger

- Plan: `C:\Users\PJ29587\.claude\plans\i-want-to-revamp-refactored-bear.md` (rev 3); design doc `docs/superpowers/specs/2026-10-30-alert-profiles-revamp-design.md`
- Branch: `feature/alert-profiles-revamp` (worktree `.claude/worktrees/alert-profiles-revamp`), base commit `00d512c`
- Mockup of record: https://claude.ai/artifact/V5dMeUrzrVwRcWP9vv6QXF (version 6); repo copy `docs/superpowers/specs/assets/2026-10-30-alert-profiles-mockup.html`

Each wave appends its own line below.

W0: design doc + mockup committed (558a6e5)

W1: late category (79c6d88) — late split out of Other into its own seventh category (ALERT_CATEGORY_ORDER, aliases, locales x5, --bar-pm-late stone placeholder, legend, briefing fallback); tests: 962 targeted (960 pass, 2 skipped bench), full modules 5747 (1 unrelated failure: frozen-horizon-rolling)

W2: palette + tokens (0019fc1) — nine-swatch --pal-* tokens in :root and body.dark, --bar-pm-<cat> re-pointed, generic warn ring, categoryColorDecls/applyCategoryColors, minimap per-category colour + _cssVar on body; light sky #30b0ec, sand #bfa57a; tests: 1278 targeted (1276 pass, 2 skipped bench), full modules 5772 (1 unrelated failure: frozen-horizon-rolling)

W3: stored categories + matching rule — alert_profile.categories JSONB (migration 2026-10-30-2, schema.sql, bootstrap), validate_categories / validate_rules(allow_empty), _UNSET null-revert, routes pass-through; effectiveCategories / ruleAppliesTo (category-level) / profileMatches / profileCategoryCounts, validateProfile categories, profileWindow / windowSummary category-aware; tests: 250 targeted frontend pass (property test 2,000+ cases vs the old predicate), 56 backend non-DB pass; backend DB tests NOT RUN: local Postgres port open but no credentials available to the agent (pg tests auto-skipped)
W4: focus outline replaces ambient conflict outline (pending commit) - AlertProfileMatchSet gains orderIds/focusIds (focus = requested ∩ orderIds, minus fully acked; applied to current() and view(); fills stay ambient), focusTaskIds(); D8 err-only sevByTask under __all__ plus ring-only classes; Timeline conflict-order path deleted, alert-focus (2px dashed --fg) via _itemForTask/_applyProfileMatchClasses, navBarStyle focus, lane keyline, Gantt Outlined chip + Escape clear, legend/locales x5, docs, rev-4 note; tests: 498 targeted + 1401 module glob pass except 1 known DST failure
W5: two-tier profile editor - seven group rows (shared switch + focus-visible/disabled, badge, count from one profileCategoryCounts pass, swatch + OverflowMenu palette at z 2100), collapsed Fine-tune (day presets, Errors only warn->null, group types, late hours, Off/inert lines, auto-open precedence), no-op/duplicate rule drop on save, categories carried by Duplicate/Copy/save/_revalidate, validateProfile extra-key shape error, windowSummary all-ON whole-horizon sentence, 35 ape.* keys x5 added and 4 removed; 544 targeted tests pass; browser checks (1024/860/720/360 de+es, popover Tab/Escape) owed.
