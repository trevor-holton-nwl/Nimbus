# NIMBUS workload relief (2026-10-22)

## Context
An Opus deep-dive (plan `are-there-any-new-generic-cook.md`) found that no new worker type is the first move. Two workers already exist (alerts/utilization/leverage `nimbus-worker.ts`, optimizer `optimizer-worker.mts`). The largest waste is: (a) `resolveSetup` called without the resolution index (linear scans per call), (b) an over-coarse utilization cache, (c) the pandas row builder in `GET /tasks`, (d) leverage batches blocking the shared worker. All timings are estimates from reading code; nothing is measured at full scale, hence the `PerfMonitor` timing keys.

## Decided scope
- Wave A (frontend, branch `feature/workload-relief-fe`): timing keys; setup-resolution index in `deriveSetupObservation` and `reconcileRuntimeSchedules`; setup mass-upload validation cache + debounce; worker hygiene 6a/6d/6e; leverage trivia.
- Next: dedicated leverage worker (timeout => stop worker, show quick alerts-removed ranking, never rerun on main thread; sync path only when `Worker` is unavailable), then utilization cache fix + Dashboard filter-after + Labor async.
- Separate backend track for `/tasks` (own branch `feature/workload-relief-be`).
- Out / measure first: optimizer worker KPIs, shared derivation cache, 6b/6c/6f, leverage delta variants, ETag.

## Status ledger
(one line per completed step; append below)

## Deviations / additions
(append below)
- Branch name: `feature/workload-relief-fe` already exists and is checked out in the separate worktree `.claude/worktrees/workload-relief-fe` (same base 4c37368), so it could not be switched to from this worktree. Work was done on `feature/workload-relief-fe-agent` (from 4c37368); the caller should fast-forward `feature/workload-relief-fe` to it.
