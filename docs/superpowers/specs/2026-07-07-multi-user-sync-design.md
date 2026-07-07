# NIMBUS Multi-User Sync — Design Spec

**Date:** 2026-07-07

## Context and Problem

An optimize run showed `Engine.runAndApply` at 1233 ms with `Timeline.patchLoop` at 1210 ms —
98% of "engine" time is actually N individual vis-timeline `DataSet.update()` calls running
synchronously in the Store event handler (`app.js` ~6424–6467).

Zooming out from that specific hotspot: NIMBUS must scale to **multiple schedulers concurrently
editing the same plant**, with **near-real-time (seconds) freshness** and **write-through
autosave**. Today there is no sync at all — no polling or push channel exists. Another user's
changes only become visible via save-collision (last-writer-loses) or a manual reload (verified:
`/tasks/refresh` is called only from `saveAll`'s stale-handler path, `app.js:12501`).

**Key decisions:**
- Scope is same-plant concurrent editing.
- Freshness target is seconds, not real-time-sub-second.
- Write-through autosave is required (not just local/localStorage persistence).
- Conflict policy is last-writer-wins + notify — no locking.
- Sandbox (what-if) mode buffers remote changes while active and applies them on exit.
- All users sit behind a corporate proxy that mangles long-lived streams, so the transport is
  **cursor-based polling, not SSE/WebSockets** (memory: `nimbus-deploy-verify-http-cache` — the
  proxy serves pre-roll/cached responses keyed on URL for streaming-shaped traffic).
- The `Timeline.patchLoop` batching fix ships first, ahead of the sync work, because it is the
  rendering-readiness prerequisite for applying batched remote updates efficiently.

## Architecture

Edit → Store (marked dirty) → existing 1.2 s debounce → autosave `POST` (xmin-guarded) → the
same transaction appends a `schedule_events` row → other clients' ~3 s poll picks it up →
`Sync` ingestion → `Store.applyRemote` (no dirty-marking, `source:'remote'`) → a single batched
`tasks:bulkUpdate` → batched `patchLoop`.

Ingestion is transport-agnostic by design — SSE can replace polling later without changing the
Store-side contract.

## Backend

- **New table `schedule_events`:**
  - `id BIGSERIAL PRIMARY KEY` (doubles as the poll cursor)
  - `plant TEXT`
  - `op TEXT` — one of `tasks:update | orders:upsert | orders:purge | calendar | blocks | optimize`
  - `ids TEXT[]`
  - `actor TEXT` (sourced from the `x-user-email` header)
  - `client_id TEXT`
  - `ts TIMESTAMPTZ`
  - Index on `(plant, id)`.
  - No payload is stored — `GET /changes` returns fresh row state read live from the source
    tables, not a serialized snapshot of the event.
- **Event append** happens inside the same transaction as the underlying write, in:
  `db.update_task_dates_bulk`, `upsert_orders`, purge, and the plant-calendar/block write paths.
- **`GET /changes?plant=&since=&client=`** returns
  `{cursor, events[], tasks[fresh rows], calendars_changed}`.
  - Server-side echo filter: excludes events whose `client_id` matches the caller, so a client
    never re-ingests its own writes.
  - Minimal response when nothing changed since `since`.
  - Omitting `since` returns `{cursor}` only — used for bootstrap (a client joining establishes
    its starting cursor without pulling full history).
- **Client identification:** all writes carry an `x-client-id` header — a per-session UUID sent
  via `Util.fetchTraced`.
- **Retention:** prune `schedule_events` rows older than 7 days, run at startup and piggybacked
  onto an existing daily job.
- **Presence (Phase 3):** a Postgres presence table with TTL-based upsert, piggybacked onto the
  existing poll request rather than a separate channel.
- **Migration path:** schema changes for this feature go through the `/promote-azure` guarded
  migration ledger — **never** via a `schema.sql` re-run (re-applying `schema.sql` re-triggers
  its `<= 365`-day horizon ×1440 migration multiplier, which is unrelated but destructive if
  re-run casually).

## Frontend

- **New `Sync` IIFE module**, placed after `Persistence` in the module load order:
  - `Sync.start(plant)` is called on initial plant load and on every plant switch.
  - Polls on a 3 s interval.
  - Polling pauses when the tab is hidden and fires an immediate poll on visibility regain.
  - Includes error backoff on failed polls.
- **`Store.applyRemote(rows)`:** updates Store state for incoming rows **without** marking them
  dirty, then issues one `tasks:bulkUpdate` publish with `{source:'remote'}`. `Persistence`
  ignores this source tag, the same way it already ignores `'refresh'` (see `app.js:15884`).
- **Locally-dirty ids are skipped** on remote apply — a remote update never yanks a task the
  user is mid-drag on. The next autosave's existing stale-handling path resolves the conflict
  deterministically: remote wins, with an attributed toast telling the user whose change won.
- **Sandbox interaction:** while `Sandbox.active`, incoming remote events are buffered rather
  than applied immediately; the UI shows an "N external changes" badge; the buffered batch is
  applied on Sandbox exit.
- **Calendar/blocks events** trigger a `CalendarSync.fetchPlantConfig` re-hydration rather than
  a raw row patch. **Optimize events** trigger a bulk apply plus an attribution banner (who ran
  the optimize).
- **Undo** remains scoped to the local user's own operations only; conflicts between local undo
  and remote state are resolved via the existing stale/reconciliation machinery, not a new
  undo-aware merge.

## Write-through Autosave and Prerequisites

- **Hard blocker, must be fixed first:** the TZ corruption bug. `saveAll` /
  `_apply_task_date_updates` currently shift persisted times by the client's UTC offset for
  non-UTC users (memory: `nimbus-save-timezone-corruption` — discovered 2026-07-06, **not yet
  fixed**, likely affecting all historical scheduling saves). Turning on write-through autosave
  before this is fixed would corrupt scheduled times on every drag and then **propagate that
  corruption to every other connected client via sync** — this must be closed before any
  write-through work proceeds.
- **Partial-save dirty-id clearing** needs verification and likely a fix: `CLAUDE.md` states
  dirty ids are cleared before the persisted-count check, but a prior code read disagreed.
  Verify the live behavior at `app.js:12482–12507` during Phase 1 and correct it if the dirty
  ids are being cleared in a way that lets un-persisted rows silently go unretried.
- **Autosave debounce gains a backend leg:** the existing 1.2 s debounce will additionally POST
  dirty tasks **only** — no `blocks`/`calendars` blob (calendar/block state is owned by
  `CalendarSync` and synced separately). This backend leg saves silently on success and shows a
  toast only on conflict or error. Cmd/Ctrl+S continues to mean "full flush" unchanged.
  `localStorage` remains the crash-recovery net regardless.

## Scale Alignment

Everything in this design is plant-scoped — the poll parameter, the `schedule_events` index —
consistent with `CLAUDE.md`'s 50-plant target-scale roadmap. Worst case at that scale is roughly
50 requests/sec of cheap, indexed, no-change poll responses. If that ever becomes a real cost,
SSE is the documented escape hatch (the ingestion contract is already transport-agnostic).

## Phasing and Roadmap

0. **Render readiness** — batch `Timeline.patchLoop` so batched remote updates (from later
   phases) don't re-trigger the current N-synchronous-`DataSet.update()` cost.
1. **Write-through** — TZ corruption fix, then the partial-save dirty-id fix, then the backend
   autosave leg.
2. **Change feed** — the `schedule_events` migration, event appends on writes, `GET /changes`,
   the `Sync` frontend module, and conflict toasts.
3. **Presence & attribution** — heartbeat, "who's here" indicator, "moved by X" flash on remote
   edits, and the optimize attribution banner.

**Future (beyond Phase 3):** swap the polling transport for SSE if load or latency demands it;
consider soft line claims if collisions remain painful in practice even with last-writer-wins +
notify.

## Out of Scope

Phases 1–3 above are explicitly deferred to their own future implementation plans — this spec
records their shape but does not implement them. Phase 1 must begin with the TZ corruption
investigation and fix before any other write-through work starts.

## Key Reuse Points

Existing infrastructure this design builds on rather than replacing:
- `Util.fetchTraced` — will carry the new `x-client-id` header in addition to its existing
  `x-request-id` tracing.
- The existing xmin/`base_version` optimistic-concurrency machinery and the stale-id resolution
  path.
- `POST /tasks/refresh` reconciliation (last-writer-loses today; reused as part of conflict
  resolution).
- `CalendarSync` hydration, for calendar/block change events.
- `PerfMonitor` marks, for before/after measurement of the `patchLoop` batching fix.
- The `_itemForTask` item builder, reused when constructing batched patches.
- `Persistence`'s dirty-id tracking and its existing `'refresh'`-source ignore behavior, which
  the new `'remote'` source tag piggybacks on.
