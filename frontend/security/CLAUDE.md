# Security — pointer

Substantive docs for this domain live at `backend/security/CLAUDE.md`.


## Sign-out and shared PCs

`Session.signOut(opts)` clears local planner data (`clearLocalPlannerData()`: `nimbus.state.v3` + quarantines, `nimbus.recentCmds`, `nimbus.patterns.v1`, `nimbus.calendar.pendingDeletes`, sessionStorage; keeps `nimbus.theme`/`nimbus.locale`) and confirms first when the shell-supplied `Persistence.hasPendingWork()` is true (dirty/force/conflicted/firm-dirty ids, queued calendar deletes, What-If active). Known gap: unsaved admin-form edits (setup, master data) are not detectable, so sign-out does not warn about them.
