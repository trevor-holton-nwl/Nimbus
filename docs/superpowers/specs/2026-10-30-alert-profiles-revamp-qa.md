# Alert Profiles revamp: browser QA script (run after deploy)

Design: `2026-10-30-alert-profiles-revamp-design.md`. Run in a plant with at least one custom profile, once in light and once in dark. Each line: action, then the expected result.

## Owed gates before this script

- Postgres tests (12): `NIMBUS_TEST_DB=1 python -m pytest tests/test_alert_profile_categories.py tests/test_alert_profiles_data.py tests/test_schema_idempotent.py -q` against a local Postgres (never the Azure host).
- Deploy gate dry run (no changes applied): `& "C:\Users\PJ29587\OneDrive - Newell Brands\Documents\AI_ML Testing\Claude\.claude\skills\promote-azure\scripts\apply-migrations.ps1" -DryRun`; read its output, then
- Release-note hazards: (1) rows saved by the new build with `rules: []` (a blank draft, all groups on) match NOTHING on the previous image, so a rollback blanks those profiles; (2) a tab opened before the deploy sends rules only: the server keeps the stored `categories` but replaces the rules, so a pre-deploy tab can silently undo fine-tuning (the version-refresh banner nudges those tabs to reload).
- Deploy: dry run first, then `promote-azure -Only 2026-10-30-2 -AllowDestructive` (migration 2026-10-30-2 adds `alert_profile.categories`).

## A. Profile editor

1. Open Edit rules at 1024 px in de, then es: the seven rows fit, nothing clipped, no horizontal scroll.
2. Repeat at 860, 720 and 360 px: rows reflow (badge wraps under the name), swatch and count stay reachable.
3. Click a colour swatch: the palette popover opens above the modal, the current colour shows a check.
4. In the popover press Tab, then Escape: focus moves through the swatches; Escape closes only the popover, the modal stays open and focus returns to the swatch.
5. Tab to a category switch: a visible focus ring; turn a switch off: the row looks disabled, its count stays.
6. Pick a colour another ON group already wears: the hint says it "shares amber with" (that group's name).
7. Open a profile with a tuned group or more than one rule: Fine-tune is open on load; a fresh profile: Fine-tune is closed; toggle it by hand and switch profiles: your toggle is respected until the next load.
8. Save with a rule that names no group's type: the rules error forces Fine-tune open.
9. Add a no-op rule (nothing narrowed): it is dropped on save and the note says so.
10. Type in a Day from / Day to / Late hours box quickly: the counts and the live date range update once, shortly after you stop (no focus loss, no lag).
11. Read-only profile (not yours): every control disabled, the palette does not open.

## B. Gantt

12. Each profile category fills matching bars in its own colour; an order with two categories takes the most severe, ties go capacity > conflicts > calendar > setup > planning > late > exceptions.
13. A warn order has the amber inner ring, an err order the red ring, for every swatch colour (including slate and stone).
14. Under All alerts: no fills, only error orders show the ring (D8).
15. An acknowledged order shows no ring or fill; turn on Show acknowledged: it returns.
16. In the Monitor press Show on Gantt: a dashed outline appears on those bars, including a firmed bar with no fill; the toolbar chip reads "Outlined: N · Clear".
17. Click Clear in the chip, then repeat and press Escape with nothing selected: the outline goes both times.
18. Drag a filled bar: the drag ghost keeps the fill; split an order: each segment is filled; a distribution child with a profile match is filled.
19. Switch to dark mode: fills, legend swatches and minimap recolour; custom colours stay legible.
20. The minimap shows per-category colours matching the bars.
21. With View as set to another profile: the Gantt keeps the saved default profile's fills (View as is page-only).

## C. Monitor: Matrix

22. In a 70-machine plant open Matrix (Machine lens): the header row and the machine column stay put while scrolling both ways; work-center roll-up rows pin under the header.
23. A work center with quiet machines shows "Show N quiet machines" folded; open it, then reload the lens: folded again. A machine pinned in the global line filter is never folded.
24. Click a cell: the view narrows to that machine and day; click it again: the filter clears exactly those parts.
25. Click a row header, a column header, a work-center roll-up: each narrows by that dimension and toggles off on a second click; the chips row shows one chip per value and Clear removes all.
26. The side list appears with "N in view", Move N and Show on Gantt; it lists at most 80 rows; "Open all N in Inbox" switches to Inbox with the same filter.
27. Day lens: columns are work centers, rows are day buckets. Group lens: rows are the ON categories only.
28. Dark mode: matrix tints and category dots readable.

## D. Monitor: Inbox

29. Facets: choose a work center in Where: its machines list appears (search box above 10 entries); counts in each facet narrow by the other facets only.
30. Type in the search: machine, order, material and tag all match.
31. With about 15,000 alerts: scroll the Inbox smoothly (VirtualList), no blank gaps.
32. Click a row (not a button) or press Enter on it: the detail strip opens below it, no overlap with the next row; Diagnose opens the same strip.
33. Move... on an order alert opens the unchanged Slot dialog; Acknowledge opens the unchanged ack dialog.
34. With View as set to another profile, Show on Gantt outlines only orders inside that viewed profile (the chip may read "M of N outlined").

## E. Top fixes, filter clause, All alerts

35. With a filter on, Top fixes lists only fixes that touch the view, each with an "in view" clause; with none, the scoped empty state; clearing the filter restores the list and "Show 10 more" starts again.
36. Select lines in the global line filter: the "N lines selected" clause shows and is read-only; the matrix uses them as the machine filter.
37. Choose All alerts in the monitor: every alert listed, no fills or colours implied, errors are the only ring on the Gantt.

## F. Fit at 1024 px, de and fr

38. Check the page chrome (title row, controls, summary, chips) and the matrix legend. Longest strings: `am.mx_legend_hint` (fr 96 chars, de 83), `am.search_ph` (fr 49), `am.ack_err_until` (fr 57 in the ack dialog). Expected: no clipping or overflow in the page; the long hint wraps rather than truncates.
39. Long German tags against the 150 px first column of the matrix: truncated with a tooltip, not overlapping the cells.
40. Keyboard: Tab to a matrix cell and press Enter: it applies the same filter as a click (press Enter again: it clears).
41. Dark mode, Inbox: the facet colour dots (What) and severity bars (Where) are readable against the panel background.
42. Open an overflow menu (a row or Top fixes menu) with a Gantt focus outline set and press Escape: the menu closes and the outline stays; press Escape again with no menu: the outline clears. An empty focus set shows no chip.
