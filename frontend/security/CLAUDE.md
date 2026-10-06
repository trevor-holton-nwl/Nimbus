# Security — pointer

Substantive docs for this domain live at `backend/security/CLAUDE.md`.


## Sign-out and shared PCs

`Session.signOut(opts)` clears local planner data (`clearLocalPlannerData()`: `nimbus.state.v3` + quarantines, `nimbus.recentCmds`, `nimbus.patterns.v1`, `nimbus.calendar.pendingDeletes`, sessionStorage; keeps `nimbus.theme`/`nimbus.locale`) and confirms first when the shell-supplied `Persistence.hasPendingWork()` is true (dirty/force/conflicted/firm-dirty ids, queued calendar deletes, What-If active). An **expired** login (12h `Config.SESSION_MAX_AGE_MS`, checked at the boot gate) does the same wipe through `Session.clearExpired()` — session blob plus `clearLocalPlannerData()`, theme/locale kept — but WITHOUT the unsaved-work confirm: the expired session's unsaved work is discarded (owner ruling 2026-10-06). It runs pre-boot, so there is no autosave to cancel. Known gap: unsaved admin-form edits (setup, master data) are not detectable, so sign-out does not warn about them.
