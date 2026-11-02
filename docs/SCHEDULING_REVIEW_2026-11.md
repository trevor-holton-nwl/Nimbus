# Scheduling folder review, November 2026

Scope: `frontend/scheduling/` and `backend/scheduling/`, reviewed at `71ae538`, implemented on the `scheduling-review-integration` branch (waves merged up to `e00f8b6`). Nothing here has been merged to `main`, pushed or deployed.

Finding IDs (S1-1 ... S10-12) refer to the review batches: S1 Gantt rendering, S2 Gantt clock/zoom, S3 minimap/sidebar/filters, S4 drag and keyboard, S5 orders grid, S6 Inspector, S7 persistence, S8 backend routes, S9 shared catalog/selection, S10 save/conflict flow.

## 1. Context

Ten reviewers each read one batch of the scheduling folders and produced 118 candidate findings. Twenty validators (two independent per batch, static reading only) then tried to disprove every finding.

What "validated 2x" meant:

- Tier 1: both validators confirmed the finding. Implemented.
- Tier 2: both agreed the core is real but narrowed it (smaller impact, or a cost that is unmeasured). Implemented with the corrected scope.
- Disputed or dropped: one validator rejected it, or both rated it negligible. Listed in section 5, not implemented.

Impact grades in this document are the validators' corrected grades, not the reviewers' originals. Several cost and performance claims were downgraded to "real but unmeasured" and were held back until measured (section 4). Validation was static, so planner-visible items were afterwards checked in a real browser where possible (end of section 2); the rest are listed in section 8.

## 2. Shipped

### Wave 1: planner-facing correctness (frontend)

| Findings | What changed | Planner effect, before -> after |
|---|---|---|
| S4-1 | Global key handler skips dropdowns and buttons; Delete/F/arrows/Ctrl+Z only act when the Gantt is the visible tab. | Before: arrows in the Inspector machine dropdown moved the selection, Delete/F acted from a focused dropdown, Ctrl+Z on another tab undid a Gantt move. After: dropdowns work by keyboard, shortcuts act only on the Gantt. |
| S4-7, S9-2 | Arrow navigation follows the visible row order, skips filtered or dimmed orders, scrolls the target into view. | Before: Down from M2 could jump to M10 or a hidden row. After: moves to the row shown below. |
| S9-1 | Shift-click range selects only non-dimmed orders. | Before: bulk Firm/Unschedule could hit orders hidden by the filter. After: selection equals what is highlighted. |
| S4-4 | Multi-drag counts and toasts firmed orders left in place. | Before: silent. After: "N firmed order(s) not moved". |
| S5-3, S6-4 | One shared snapshot-and-push for every manual placement edit (typed finish, run time, plain machine, Override). | Before: Ctrl+Z after a grid or Inspector edit undid an older unrelated action. After: undoes the edit just made, with a localized undo label. |
| S6-2 | Invalid typed finish restores the old cell value. | Before: a mistyped finish blanked the cell while the bar stayed. After: the cell reverts. |
| S6-3, S6-8 | Machine editor preselects the current machine; Enter on an untouched cell cancels; highlight scrolls into view. | Before: Enter without typing reassigned the order to the first machine in the list. After: no change. |
| S6-1 | Derived Inspector rows (start, variance, run time, setup card) patched after a successful Inspector write. | Before: stale until reselect. After: update immediately. |
| S6-6, S10-10 | Inspector ignores note-source and unrelated bulk events and does not re-render while the note field is focused. | Before: the first click after typing a note could be swallowed. After: it lands. |
| S6-14 | Setup Save/Reset buttons disabled in flight; 422 detail arrays formatted. | No double saves; readable error. |
| S5-4 | Prior machine captured before the write. | Latent edge only. |
| S5-1, S5-2 | Alert update emits an empty list for "no change", and the change signature includes severity. | Before: every edit refreshed every grid row and a late warn->err could keep the wrong tint. After: only changed rows refresh, tint follows severity. |
| S5-5, S10-11 | One plant-membership helper used by all grid branches. | Unmapped-line rows refresh after single edits. |

### Wave 2: save and load safety (`persistence.mts`, plus one backend read)

| Findings | What changed | Planner effect, before -> after |
|---|---|---|
| S7-3 | Cache is rejected for another plant. | Before: backend down on plant switch showed the old plant's orders. After: empty or reconnect state. |
| S7-7 | Demo-mode fake-order fallback removed. | Before: random fake orders after a failed load on a fresh login. After: empty board with a 10-minute "can't reach server" notice. |
| S7-4 | Rows the server rejected are refreshed. | Before: a rejected drop stayed on screen and reverted on reload. After: snaps back with the reason toast. |
| S7-5 | An unsaved Unschedule is restored from cache and marked dirty. | Before: reload silently dropped it. After: survives like a drag. |
| S7-6 | `beforeunload` prompt when work is pending. | Browser warns before closing with unsaved edits. |
| S10-2 | Firm, planning status and placement exception included in the "same as sent" check. | Before: a concurrent firm change silently flipped back. After: normal "changed by another planner" toast. |
| S6-7, S10-3 | Note-save failure toasts, retries on next Save, pending note timers flushed on page hide or plant switch. | Before: a failed note looked saved. After: visible warning. |
| S10-1, S10-4, S7-11 | Atomic saves split (owner decision, section 3); handler errors no longer reported as "saved locally". | Stuck "N unsaved" after one stale optimizer row fixed. |
| S7-1 | Generation guard on both hydration blocks. | Fewer wrong-plant events after a fast plant switch. |
| S7-2 | Timeout on `/tasks/refresh`. | A hung conflict refresh no longer wedges edits. |
| S7-14 | Save with nothing dirty sends no request. | Before: Ctrl+S on a clean board said "Saved". After: "Nothing to save". |
| S7-15 | Dirty-source survives What-If discard. | History shows the true source. |
| S7-9, S10-6 | Cache tiers keep dirty rows; cache keyed per plant. | Unsaved edits are not evicted under quota; two tabs on different plants stop clobbering each other. |
| S10-9 | Colour, form size, description, notes and order Y added to the task-versions read and copy-back (backend `db.py`). | After an ingest, a conflict refresh updates colour, form and description without a reload. |

### Wave 3: backend hardening (`routes.py`, `models.py`, small `db.py`)

| Findings | What changed | Effect |
|---|---|---|
| S8-3 | Planning reason typed and size-capped. | One bad saved reason can no longer make `GET /tasks` fail for a whole plant. |
| S8-5, S10-12 | Typed payload for `/task/note`. | Bad request returns 422, not 500. |
| S8-6 | `update_task` returns the real status and error code. | External callers only. |
| S8-7, S10-7 | Length caps (20000 items) on task and id lists; plant filter pushed into the version read; client stops sending blocks/calendars. | Smaller saves; no planner change. |
| S8-8, S10-8 | Diagnostics warnings capped; meta keys whitelisted. | Stops unbounded growth under a persistent merge fault. |
| S8-13 | Id tiebreaker in paged ordering. | External paging only. |
| S8-1 | Fast date parse in the task date update path (timed first). | Faster large Optimize or Jobs apply. |
| S8-9 | Shared bulk-result helper. | None. |

### Wave 4: Gantt clock, filter consistency, display fixes

| Findings | What changed | Planner effect |
|---|---|---|
| S2-1 | Now/Hour/Day/Week use the plant clock. | Planners in another timezone centre on the plant's real now. |
| S3-2 | Minimap now marker and range use the plant clock. | Minimap now line matches the Gantt. |
| S1-1, S1-10, S1-11 | One line-visibility check on every bar patch; 30 s scan seeded from the filtered set; frozen-band ids cleared on plant switch. | With a machine filter, no bars appear for hidden machines after 30 s, Optimize or Firm. |
| S1-12 | 30 s scan only runs while the Gantt is active. | Less background work. |
| S3-1 | Minimap skips Needs Planning alerts. | No shading for days the Gantt shows nothing for. |
| S3-4 | Sidebar uses the same numeric sort. | M2 before M10. |
| S3-8 | Active filter reports colour, form and paste filters. | Intelligence layer sees all filters. |
| S2-6 | Fit uses visible lines only. | Before: Fit with a filter zoomed out too wide. After: fits the visible rows. |
| S2-7 | Zoom highlight cleared after Go To or day stepper. | Toolbar no longer misreports zoom. |
| S1-3 | Order label and blackout reason escaped. | Text like `<b>` in a description renders as text. |
| S4-8 | Hover card uses the localized alert message. | Readable alert text instead of codes. |
| S1-2, S2-2, S3-9 | One-time log warning when gridline or minimap caps, or install retries, give up. | Support gets a log entry. |
| S2-9, S2-5 | Shading waits for the hydrated plant calendar; unchanged window options skipped. | Avoids a possible wrong weekend shade on a 7-day plant. |

### Wave 5: translation sweep and cleanup

Hard-coded English translated across de/es/fr/pt (and en): filter empty states and badge, undo labels, partial-unschedule toast, multi-select summary, Planning window hints, setup editor, print and CSV headers, conflict/save/reload toasts, the "N unsaved" badge, and the optimizer planning reasons (S3-5, S4-6, S9-5, S5-6, S6-12, S7-10, S9-3). Inline colours replaced by tokens so they follow dark mode.

Cleanup with no planner effect: dead Orders code removed (S5-9), note-popover leftovers and dead Inspector branches (S6-11), unused selection members (S9-6), catalog header comments (S9-8). The Admin System Configuration "Inspector" checkboxes are now honoured by the Inspector (S9-4); the run time source checkbox is disabled because that row has no Inspector field.

### Performance fix

The frozen-horizon far edge is now resolved once per rebuild pass instead of per order, firm patches are batched into one update, setup-bar lookup reads a filtered set, the grid selection sync diffs instead of rewriting, closed-day lookups are memoised, a no-op filter scan is skipped and an overtaken queued rebuild is dropped. Setup observation was measured at 0 to 9 ms on plant 1008 and is NOT the bottleneck there.

### Browser-check results

| Check | Result |
|---|---|
| Item drag and the `timechange` event | An item drag emits NO `timechange` event, so the drag-ghost, edge-scroll and calendar-refresh-block code was dead. The drag flag is now set from `onMoving`. |
| Mixed firmed/unfirmed multi-drag | Vis fires one update per id; finding S4-3 dropped. |
| Hidden-line bar leak (S1-1) | Not reproduced at 45 s; the fix stays as defence. |
| Inspector date picker | Fires exactly one change event; S6-5 dropped. |

## 3. Decisions made by the owner

- Atomic saves are SPLIT: optimizer and undo rows go in one atomic request, manual edits in a separate request. One stale optimizer row no longer blocks every later manual Save.
- Demo mode REMOVED (see Wave 2).
- Note version bump accepted and documented: a note save bumps the order's version and can bounce a colleague's unsaved edit of the same order. Only the failure toast was added.
- Requiring `base_version` on bulk update (S8-2) and deleting the dead dependency overlay (S3-3) are both left alone, deferred.
- Drag ghosts and edge auto-scroll are NOT enabled. The owner call is pending.

## 4. Deferred, not done

| Finding | Why |
|---|---|
| S1-6 window grouped background bands | Risky: CLAUDE.md forbids removing the background exemption, and it needs a band-height browser check. |
| S1-9 cache setup observation | Measured at 0 to 9 ms on plant 1008. Re-measure on a setup-active plant first. |
| S4-9, S2-10, S6-9 | Real but low impact and unmeasured. |
| S5-7 and S6-10 | Shared manual-edit pipeline refactor (three copies today). Larger change, bundle with a later undo pass. |
| S4-11 | Extract `_commitMultiDrop`. |
| S7-13 | Master-data hydration helper. |
| S5-10 | Inline `onchange` handlers. |
| S3-3 | Dependency overlay deletion (dead, harmless; owner left it). |
| S8-2 | Require `base_version` on bulk update; unknown external callers could break. |
| S8-11 | Notes side table (needs a migration). |
| S8-10 | Rejected: unauthenticated `GET /tasks` is the documented pilot posture, Entra pending. |
| Drag ghosts / edge scroll | Owner decision pending (section 3). |
| `frontend/types/api-generated.d.mts` | The committed file is far behind the backend (6,665-line diff); `TaskVersionRow` was hand-edited. Regenerate in its own change. |

## 5. Disputed, rejected and corrected findings

- Rejected by both validators: S4-10 (`uninstall` is deliberately partial and never called), S8-10 (documented pilot posture), S9-10 (axis locale set is intentional).
- One rejected, the other negligible: S1-4, S2-4 (equality skip already exists), S2-8 (no throw path), S7-12, S8-12, S10-5 (covered by S7-9).
- Not dead after all: S9-9, the `tool_contention_incomplete` branch is deliberate back-compat.
- Claims corrected: S6-13 print truncation is not silent (a notice shows); the S3-3 overlay has no CPU cost (every path is guarded); S1-2 gridlines vanish at the far-future end, not near today.
- Dropped after browser checks: S4-3 (one update per id) and S6-5 (one change event).

## 6. Behaviour changes worth knowing

- CSV export headers now read Machine / Prod. Order / Material / Description (print keys reused) instead of Line / Production Order / Material Number / Description.
- Every `no_fit_found` planning reason now shows one generic translated sentence (three different English messages are stored).
- The Parent Order and Distribution Letter Inspector defaults changed to on, so the new Inspector gating keeps today's behaviour.
- A Save with nothing dirty sends no request.
- A failed load with no cache shows an empty board with a 10-minute notice instead of fake orders.
- `/task/note` and several write payloads return 422 for malformed input and have size caps (20000 items).

## 7. Test status

- Frontend `npm test`: passing.
- Backend pytest against a local throwaway database: 3018 passed. Six failures also fail on untouched `main`: three routing DB tests, a distribution cap test, a jobs catch-up test, and the schema bootstrap smoke test (migrations-set mismatch naming 2026-11-01-1 and -3).
- `test_scale_shared_state_universe_memory_and_latency` is timing-flaky: it passed once and failed once at 14.4 s against a 12 s limit under load.

## 8. Browser checks still owed

Keyboard and selection
- Shortcuts from dropdowns and from other tabs; arrow navigation across lines.
- Shift-click range with a filter active.
- Firmed-not-moved toast on multi-drag.

Edits and undo
- Undo after each edit type (typed finish, Inspector finish, run time, machine, Override) with the localized label.
- A mistyped finish reverts; Enter in the machine cell keeps the machine.
- Inspector derived rows update after an edit.
- Type a note, then click Firm: the click is not swallowed.
- Failed note save toast and retry (go offline).

Alerts and grid
- Alert tint follows a late warn->err; edits no longer flicker every row.

Save and load
- Empty-board notice when the backend is unreachable with no cache, and recovery.
- Split save (mixed optimizer and manual rows, and a stale optimizer row).
- A rejected drop snaps back; an unsaved Unschedule survives reload.
- Plant switch offline never shows the other plant's orders.
- `beforeunload` prompt.
- Conflict refresh after an ingest updates colour, form and description.

Drag
- Hover card suppressed mid-drag.
- A calendar change from another session during a drag does not spring the bar back, and the refresh runs after the drop.
- Click after drop still centres; Escape mid-drag clears the flag.

Gantt display
- Now/Hour/Day/Week centre on the plant's now for a plant in another timezone; minimap now line matches.
- Machine filter shows no bars for hidden machines after 30 s, Optimize and Firm.
- Fit with a filter fits only visible rows; no zoom button highlighted after Fit or Go To.
- First load of a 7-day plant has no wrong weekend shade.
- Sidebar order M2 before M10; hover card alert text readable.
- An order description containing `<b>` renders as text.

Performance paths
- Line-filter apply pass count dropped (trace).
- Multi-firm patch batching; setup-bar dimming on drag and restore; selection sync grid and Gantt; minimap closed-day shading after a calendar edit.

Translations (de, es, fr, pt)
- Filter dropdowns, undo toasts, multi-select summary, Planning window text, setup card, alert popup, print and CSV headers, persistence toasts, Needs Planning reasons including the new codes, and the Admin System Configuration disabled run time source Inspector checkbox.

## Appendix: Context and learnings

- The live app caches unsaved edits across reloads. Use `NIMBUS.Persistence.reload()` to discard them before a clean test.
- The Chrome automation profile shares the owner's login.
- Compiled `.mjs` files are gitignored, so a fresh worktree must run `npm run build` before `node --test`.
- pytest needs a local Postgres and `NIMBUS_TEST_DB=1`, and refuses the Azure host by design.
- Performance investigation method: monkey-patch `NIMBUS.*` functions to measure inclusive time. PerfMonitor is not on `window.NIMBUS`, and the JS Self-Profiling API is blocked by Document Policy.
- Validators read statically, so cost claims were the weakest part of the review; measure before acting on any "real but unmeasured" item.
