# Alert Monitor — design spec

Status: design settled 2026-10-20. Builder check, code-anchor verification and a product audit done; the owner answered D1–D19. Section D2 below is the bell/drawer part; lettered sections are design, "D#" rows are decisions.

## Context

Planners find NIMBUS alerts hard to digest. Everyone sees the value, but 31 alert types across a plant, shown as one flat drawer list filtered only by plant and an upper horizon bound, produce fatigue. Different people care about different slices (a scheduler may only care about overlaps in days 8–30; a planning lead about structural gaps). Nobody can see what an alert *costs* or which single fix would clear the most of them.

Goal: an **Alert Monitor** page (hamburger menu, beneath Labor Plan) where
1. users define named, **plant-shared alert profiles** made of rules (alert types + relative day window + min severity), pick one in User Settings, and get a tailored view;
2. alerts are grouped, sorted and ranked by impact so the largest hitters come first;
3. **high-leverage fixes** are surfaced with a computed ROI: "define setup pair Blue→Red on Line 3 → 6 alerts clear, confidence 71→78";
4. users triage and fix from the page using the existing Fix / Override / Go To / Dismiss actions plus one deep-link action per fix family;
5. orders matching the active profile are visually called out on the Gantt with a changed fill, toggleable.

Primary user: the daily scheduler (works alerts roughly weekly). Planning leads / master-data owners use the same page via their own profile.

## Decisions settled with the owner (don't re-ask)

| # | Decision | Owner's answer |
|---|---|---|
| D1 | Scope | Work the alerts that exist now. Predictive content limited to "fix X and these N existing alerts go away", grounded in scheduled orders. No speculative alerts for setup pairs that could someday exist. |
| D2 | Confidence ROI | A goal. Numbers must come from the affected orders; a tight band (5–10%) is acceptable, a 0–10% band is not. Finding: the score is deterministic, so we **compute the exact delta** by replaying the alert engine. |
| D3 | Profiles | **Shared per plant from day one** (named, plant-scoped rows, selectable in user settings). |
| D4 | Leverage families (v1) | Missing setup pairs; calendar-day conflicts (closed/blackout grouped by line+day); routing/material gaps (needs-planning orders with unknown run time grouped by material + production version). Missing order attributes: not in v1. |
| D5 | Gantt treatment | Changed **fill** on matching orders (owner's preference); outline is the fallback only if fill proves unsafe in the browser check. Toggleable per user. |
| D6 | Profile shape | A profile is a **list of rules**, each rule = alert types + its own day window + min severity. |
| D7 | Fix from the monitor | *Superseded by rev 2 (2026-10-20) — see below.* (The Dismiss part: the monitor has no Dismiss; Acknowledge is the only verb.) Reuse the drawer's actions (Fix: overlap/blackout/overload/tool-conflict; Override: closed/firmed-*; Go To; Dismiss) plus one deep-link action per leverage family. *(my call)* |
| D8 | Fill colour | Amber (`--warn-vivid` #f39c12 / dark #e0a018) with dark-navy text and a 2 px inner ring (red = error, amber = warning). Reason: bars are **not** line-coloured today — standard = blue, firmed = red — so a red fill would masquerade as firmed and the soft tints fail contrast under white labels. *(my call; the only free hue in the bar vocabulary)* |
| D10 | Leverage scope | **All plant alerts**, regardless of the active profile (confidence is plant-level, so the ROI is only meaningful plant-wide). "Show alerts" on a card temporarily bypasses the profile; the focus chip says so. |
| D11 | Profile reach | The active profile **also filters the alert bell count and the drawer** (and the Dashboard alert summary, which shares the same filter). `'__all__'` = unchanged behaviour. The Gantt's red `conflict-order` outline and alert day-cells stay plant-wide so a critical alert is never invisible on the timeline. Drawer footer shows "N hidden by profile X · Show all" as a session override. |
| D12 | Headline ranking metric | *Superseded by rev 2 (2026-10-20) — see below.* (The UI expression: points are no longer displayed; the metric survives as internal ranking only.) **Uncapped impact points** (Σ cleared alerts' base × time weight; error 5 / warning 2; ×1.5 ≤3 d, ×1.25 ≤7 d). Never saturates. The capped score change is shown second ("71 → 78" or "score unchanged — plant is above the 50-point cap"); orders affected is the tie-break. |
| D13 | Gantt colour | **One fill colour per alert category** (Capacity, Scheduling conflicts, Calendar, Setup, Other) — five fixed tokens chosen for contrast against the blue/red bars and colour-vision safety; an order matching several categories takes the most severe one; legend lists all five. Supersedes D8's single amber. |
| D14 | Extra rule fields | **Lateness threshold only** (alerts whose order is more than N hours late / N days overdue). Machine subset, order attributes and firm status were offered and declined for v1. |
| D15 | Window anchor | **Due date when the order has one**, else the alert time (line/day alerts, plant alerts). Needs-planning holds due in 20 days land on day 20, not day 0. |
| D16 | Optimizer fix card | **Yes, action only**: "Re-sequence Line X, days A–B" opens the Optimize dialog prefilled. Owner's concern: at a saturated line the run does nothing and the alert stays forever → the card shows the window's capacity headroom up front; when headroom ≤ 0 it says "optimizing cannot clear overloads here — N h over capacity" and leads with Diagnose instead; after any optimize run the card refreshes with "N alerts remain". |
| D17 | Acknowledge / Snooze | **Yes, in v1**: persisted per plant + alert, with reason and until-date, visible to others as "acknowledged by X until D". Acknowledged alerts keep counting toward confidence (default); the monitor and drawer hide them behind a "Show acknowledged" toggle. |
| D18 | Starter profiles | **Start empty** — only "All alerts" until someone creates a profile. |
| D19 | Admin-only fixes | **Show with hand-off**: cards whose action needs admin rights (routing upload, Manage Data edits such as SAP work-center mapping or plant time zone, line hours, setup matrix without write permission) stay visible to everyone, marked "admin fix", with "Copy summary for owner" (material / lines / orders / points at stake) to the clipboard. |
| D9 | Confidence replay honesty | For setup pairs the replay reports the real after-score even when it is **lower** (new setup time can create overload / setup-violated alerts). For the other two families the delta is "formula with those alerts removed" and is labelled so. Alerts outside the 14-day confidence window are counted and stated: "6 alerts clear · confidence 71→71 (all outside the confidence window)". *(my call)* |

## Facts that shape the design (verified in code 2026-10-20)

- All alerts are computed client-side by `computeAlerts` (`frontend/nimbus-compute-core.js:604-1305`), in the worker (`Compute.alerts`) or main thread (`Alerts._recomputeSync`, `frontend/insights/services.mts`). No backend alert endpoint. Alert shape (`frontend/nimbus-compute-core.d.ts:25-48`): `{id, sev:'err'|'warn', type, msg, msgKey?, msgVars?, taskId?, peerId?, line, time: Date, ...}`; no plant field.
- `alert.time` meaning per type: conflicting interval start for per-order alerts; planned finish for `late`; noon of the day for `overload`/`closed` (no taskId); "now" for `runtime-unknown`, `pv-lot-size`, `runtime-schedule-mismatch`, `plant_no_timezone`.
- `setup-uncovered` is de-duplicated per (line, pairKey): N orders needing one missing pair on one line = **one** alert (`compute-core.js:1281-1292`).
- Today's filters: plant + upper horizon bound (`plants.alt_flag_horizon`, `AlertsUIAdapter._visibleAlerts`, `frontend/insights/insights-ui.mts:1606-1615`). No lower bound, no type/severity filter. Dismissals are session-only (`Alerts._dismissed`).
- Confidence (`Confidence._recompute`, `frontend/nimbus-intelligence.js:1629-1710`): per plant, `100 − min(50, round(Σ base×tw)) − min(20, round(1.5 × overloaded line-days))`, base err=5 / warn=2, tw = 1.5 (≤3 d), 1.25 (≤7 d), else 1.0; window `[plantNow, plantNow + (plants.conf_score_horizon ?? userSettings.confidenceHorizonMinutes ?? 20160 min))`. Classic script; not pure (reads Store, writes badge). Ingredients are pure and main-thread callable: `deriveSetupObservation(setup, tasks, lines?, availability?)` (`frontend/optimization/engine.mts:532`), `NimbusComputeCore.computeAlerts(payload)`, `computeUtilization(payload)` (`compute-core.js:604, 1312`); payload builder `_snap()` (`services.mts:206-264`). `ensureCalendar/ensurePlant` mutate inputs → pass clones.
- Setup snapshot: `Store.setupSnapshot` (`SetupSnapshot`, `frontend/platform/types.mts:416-449`; rows `{machine, signature_version, from_key, to_key, setup_min}`); `resolveSetup` precedence occurrence > line row > plant row (`frontend/setup/setup-domain.mts:306-409`). Deep link that exists: `SetupAdmin.reviewMissingPairs(plant, pairs)` (`frontend/setup/setup-admin.mts:537-563`, cap 12, needs matrix-write permission). Single-line sparse upsert exists: `POST /setup/{plant}/matrix/import` with non-empty `machine`.
- Gantt: `Timeline._itemForTask(t)` (`frontend/scheduling/gantt.mts:826-861`) builds `className` from scratch (`order-firmed|order-standard`, `conflict-order`, `goto-target`, `dimmed`, `dist-child`); any class not derived there is lost on rebuild. Batched className-only update pattern: `GanttFilter._doApply` (3394-3415), `_setGotoClassIds` (782-796). Fill CSS: `.vis-item.order-standard { background: var(--bar-standard) }` / `.order-firmed` (`styles.css:1211-1215`; tokens 108-109, dark 5613-5614). Never set `position/top/height` on `.vis-item`. Minimap `navBarStyle` (1968-1974) needs a branch for any new class. Legend rows are static `li.lg-k` in `index.html:2603-2612` with `legend.*_t/_d` keys pinned by the locale test.
- Per-user settings = JSON blob; `Settings.CATALOG` (`frontend/shell/application-shell.mts:170-206`); `Session.setPref` optimistic + 600 ms debounced PATCH; `Store.pref(key)` resolves user → role default → default. `Store.emit()` bumps `_rev` (invalidates Utilization memo, re-triggers Confidence) — do not add a Store event for derived UI state.
- Tab plumbing mirror points: `TopLevelTab` (`types.mts:512`), nav + panel in `index.html` (2211-2213, 1591-1660), `application-shell.mts` `_landingTabDefs` 420-429 / `_updateSectionLabel` 1946 / `_firstAccessibleTab` 2339 / `_paneScrollTargets` 2362 / `goto` 2432-2505 / `_gotoLanding` 2618, `DEFAULT_PAGE_ACCESS` (`frontend/security/session.mts:131`), `_pageAccessDefs` (`frontend/security/security-admin.mts:640-657`), `PAGE_ACCESS_KEYS` (`master_data.py:2093`). Lazy-init precedent: `DistributionPane` (`_wired`, `_active`, `setActive(false)` from the shell).
- Router template `backend/labor/routes.py`; DB helper style `db.ensure_priority_list_table` (`db.py:4900-4922`); migrations `migrations/YYYY-MM-DD-N-slug.sql` mirrored in `schema.sql`, additive `IF NOT EXISTS`; the promote script blocks files containing ALTER/DROP/DELETE/UPDATE/TRUNCATE/RENAME tokens unless `-AllowDestructive`.
- Locale test (`tests/modules/locale-completeness.test.mjs`): every new en key must exist in all 5 locales (ratchet `MISSING_KEY_BASELINE` must not grow); every `AlertType` needs `alert.type.<type>`.

---

## Design

### A. Data model + backend — new domain `backend/alert_profiles/`

**Migration** `migrations/2026-10-20-2-alert-profiles.sql` (mirrored in `schema.sql`; contains no destructive tokens, not even in comments):

```sql
CREATE TABLE IF NOT EXISTS alert_profile (
    id          TEXT PRIMARY KEY,                 -- uuid4 hex, server-generated
    plant       TEXT NOT NULL,                    -- no FK (cascade clause would trip the destructive filter); scoping via _assert_plant_allowed
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    rules       JSONB NOT NULL DEFAULT '[]'::jsonb,
    ranking     TEXT NOT NULL DEFAULT 'impact' CHECK (ranking IN ('impact','time','severity','orders')),
    created_by  TEXT, updated_by TEXT,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_alert_profile_rules CHECK (jsonb_typeof(rules) = 'array'),
    CONSTRAINT uq_alert_profile_plant_name UNIQUE (plant, name)
);
CREATE INDEX IF NOT EXISTS idx_alert_profile_plant ON alert_profile(plant, name);
```

Rule element: `{"types": [AlertType...] | null, "dayFrom": int|null, "dayTo": int|null, "minSev": "warn"|"err"|null, "minLateHours": number|null}`.

**`backend/alert_profiles/data.py`** (pattern: `backend/setup/data.py` — `from db import _pool`, `Jsonb`): `ensure_alert_profile_table()` (called in `brain.py` lifespan beside `ensure_priority_list_table`), `validate_rules(rules)` (≥1 rule, ≤20; `types` null or non-empty ⊆ the `AlertType` literals mirrored as `ALERT_TYPES` (read the union from `types.mts`; it currently has 32 literals incl. the no-longer-emitted `line_no_calendar`); ints or null for days in **−365..365** (negatives = overdue; same bounds on server, pure module and editor), `dayFrom ≤ dayTo`; `minSev` ∈ {None,'warn','err'}), `validate_ranking`, `list_alert_profiles(plant)`, `get_alert_profile(id)`, `create_alert_profile(...)`, `update_alert_profile(id, ..., expected_updated_at)` (SELECT … FOR UPDATE; stale → `ValueError`), `delete_alert_profile(id, actor)`, `class DuplicateName(ValueError)`. Each write also inserts an `admin_audit` row (`table_name='alert_profile'`, details `{plant,id,name,…}`), same statement shape as `db.py:2001-2004`.

**`backend/alert_profiles/routes.py`** (template `backend/labor/routes.py`), registered in `brain.py` (import ~83-93, `include_router` ~799-809; root CLAUDE.md "eleven routers" → twelve):

| Route | Auth | Behaviour |
|---|---|---|
| `GET /alert-profiles?plant=` | `Depends(auth.get_allowed_plants_for_request)` + `md._assert_plant_allowed` | 400 no plant, 403 out of scope → `{plant, profiles:[…]}` |
| `POST /alert-profiles` | `require_authenticated` + plant check on body | 400 validation, 409 duplicate name; actor from `x-user-email` |
| `PUT /alert-profiles/{id}` | authenticated + plant check on the stored row | 404; 403 unless `actor == created_by` (case-insensitive) or `auth.get_user_role(actor)=='admin'`; 409 stale (`expected_updated_at`) / duplicate |
| `DELETE /alert-profiles/{id}?plant=` | same as PUT | `{deleted:true, id}` |

Permission model: any authenticated user with plant access may **create**; only the creator or an admin may **edit/delete**.

**Settings** (`Settings.CATALOG`, workflow category):
- `alertProfileByPlant: Record<plant, profileId | '__all__'> | null` — resolution per plant: `user[plant] ?? roleDefaults[plant] ?? '__all__'`; an id not in the plant's list silently resolves to `'__all__'` (toast once per session). Role default is settable through `roles.settings` (no Roles-tab UI in v1, same gap as `permissions.setup_scheduler`).
- `alertProfileGanttHighlight: boolean` (default true).
- `alertMonitorView: {groupBy, sort} | null`.

Built-in **All alerts** pseudo-profile: id `'__all__'`, one rule `{types:null, dayFrom:null, dayTo:null}`, `builtIn:true`, never a row.

### B. Rule semantics + matching — new pure module `frontend/insights/alert-profiles.mts`

No Store/DOM imports (so Gantt, monitor and node tests share it).

- Anchor (D15): `anchorTime(alert, task) = dueDateInstant(task.original_end_date) when the alert has a taskId and the task has a due date; else alert.time`. (`dueDateInstant` is the compute-core helper used by the `late` rule — expose it on the core or port it.) An alert with neither matches a rule only when both bounds are null. The row's date column shows the anchor used, with a tooltip naming it ("due date" / "conflict time").
- Lateness threshold (D14): optional `minLateHours: number|null` per rule; matches when `Util.latenessHours(task) ≥ minLateHours` (alerts without a task never match a rule that sets it). Editor shows it as "Only orders more than [N] hours late" (blank = any).
- Window: plant-local calendar days relative to `plantToday = startOfDay(Store.plantNow(plant))`, inclusive: `[plantToday + dayFrom, plantToday + dayTo + 1)` via `new Date(y, m, d+n)` arithmetic (DST-safe). Day 0 = today; null = unbounded; negatives allowed (overdue).
- `ruleMatches(alert, rule, plantToday)`, `profileMatches(alert, profile, plantToday)` (OR over rules), `filterByProfile(alerts, profile, plantToday)`, `alertDayOffset(alert, plantToday)`, `validateProfile(draft, existing)` → i18n error keys (mirrors server rules + name uniqueness per plant, 1–60 chars, identical-rule check), `resolveActiveProfileId(plant, userSettings, roleDefaults, available)`.
- `ALERT_CATEGORIES`: hoisted `CAT_MAP` (`insights-ui.mts:1384-1403`) with a fifth `setup` group for the setup-diagnostic types; `insights-ui.mts` is re-pointed at it (behaviour-preserving).
- Ranking: `impactPoints(alert, horizonStart, horizonMinutes)` using `NimbusComputeCore.CONFIDENCE_WEIGHTS` (0 outside the window); `compareAlerts(ranking)` for `impact | time | severity | orders`; `groupAlerts(alerts, by: 'type'|'line'|'day'|'order', plantToday)` → `{key, alerts, impact, orderIds}[]`.
- The monitor applies the **profile window**, not `alt_flag_horizon` (that stays the drawer/Gantt bound). Footer note when the profile window extends past the plant horizon.

### C. Leverage engine — `frontend/insights/alert-leverage.mts` + confidence extraction

**C.1 Confidence extraction** (`frontend/nimbus-compute-core.js` + `.d.ts`; the UMD global is the one surface reachable from the classic `nimbus-intelligence.js`, ESM modules, the worker and node tests): `scoreConfidence({alerts, matrix?|overloadedLineDays?, horizonStart, horizonMinutes}) → {score, alertPenalty, utilPenalty, overloadedLineDays}`, `countOverloadedLineDays(matrix)`, `CONFIDENCE_WEIGHTS`. Exact port of `Confidence._recompute` lines 1654-1709; `_recompute` and `showBreakdown` then call it so badge and monitor can never disagree. Parity test pins caps, tw bands at exactly 3.0/7.0 days, `time === horizonEnd` excluded.

**C.2 `pairKey` on setup alerts**: add `pairKey: diagnostic.pairKey` to the alert objects emitted at `compute-core.js:1281-1295` (+ `.d.ts`). Verified: no test deepEquals a whole setup alert object, so this is safe. (Emitted id is `${type}-${key}` with key `[type, scope||line||'Unknown', pairKey||'unknown'].join('|')`, i.e. the type appears twice; don't parse ids — use the new field.)

**C.3 Contract**

```ts
type LeverageFamily = 'setup-pair' | 'calendar-day' | 'routing-gap';
interface LeverageItem {
  family; key; titleKey; titleVars: Record<string,string|number>;
  alertIds: string[]; orderIds: string[]; lines: string[];
  confidenceBefore: number; confidenceAfter: number | null;   // null while a replay is pending or needs minutes
  method: 'replay' | 'removal'; outsideConfidenceWindowCount: number;
  requiresMinutes?: boolean; assumedMinutes?: number|null; minutesSource?: 'plantDefault'|'user'|null; capped?: boolean;
  action: { kind: 'open-setup-matrix', plant, pairs } | { kind: 'goto-line-day', line, dayKey, fixableAlertIds } | { kind: 'open-routing-pv', material, pv };
}
groupLeverage(input): LeverageItem[]                       // sync, bounded; every item gets a removal-method delta immediately
analyzeLeverage(input, runner): Promise<LeverageItem[]>    // upgrades setup-pair items to method:'replay'; cap 20 replays by alert count
```

Two-phase on purpose: cards paint at once with the removal number, then setup-pair cards update to the replayed number (card shows `am.lev_method_replay` / `…_removal` eyebrow).

**Input set (D10):** `groupLeverage`/`analyzeLeverage` receive the **plant-wide** alert list (`Store.alerts` ∩ plant lines, dismissed already excluded), never the profile-filtered list, so `confidenceBefore` equals the badge score and the KPI tile. The pane's "Show alerts" sets `_focusAlertIds` and renders those alerts even when the profile would hide them; the focus chip reads `am.focus_chip_outside` when any of them fall outside the profile.

**C.4 Family: missing setup pairs.** Baseline `deriveSetupObservation(setupSnapshot, tasks, lines, ctx)`; group `setup-uncovered` diagnostics by `pairKey` plant-wide (lines[], orderIds[] from successors); skip keys with an `unknown` half. Minutes: if `masterPlant.setup_policy_config.unknownSetupPolicy === 'plantDefaultMinutes'` and default > 0 → replay with it (`minutesSource:'plantDefault'`); else `requiresMinutes:true`, removal method, and the card offers a minutes input that triggers one replay (`minutesSource:'user'`). Hypothetical snapshot = `structuredClone(setupSnapshot)` + `plant_rows.push({machine:'', signature_version, from_key, to_key, setup_min})` (resolves as covered because `stateForOrder` and `pairKey` preserve `definition.fields` order). Replay = `deriveSetupObservation(hypo…)` → `computeAlerts({...base, setup})` + `computeUtilization({...base, setup})` → `scoreConfidence`. Action: `SetupAdmin.reviewMissingPairs(plant, pairs)` (`frontend/setup/setup-admin.mts:537`, `pairs: {line, predecessorOrderId?, successorOrderId?, fromState?, toState?, reason, remedy?}[]`, cap 12; permission-gated — hide the button when `canReviewMissingPairs(plant)` is false and show "Go To" instead). **`SetupAdmin` is not on the `NIMBUS` global** (only on the boot-time `__NIMBUS_PLANT_ADMIN` bridge, which `app.js` never destructures) — the pane imports it directly from `../setup/setup-admin.mjs` (lazily inside the action handler; no reverse edge exists, so no cycle).

**C.4b Additional cheap groupings (same card shape, removal method):** `tool-conflict` grouped by tool (`msgVars.tool`) — one tool drives several conflicts; `initial-state-unknown` + `current-state-diverged` grouped by line — recording one machine state clears all (action: Go To → Inspector mounts `SetupAdmin.mountStateEditor`, `orders.mts:2394`). `plant_no_timezone` is not a card: it blocks every derivation for the plant, so render it as a pinned banner at the top of the page.

**C.4c Impact on every row.** Each alert row shows its own uncapped weighted points (base × time weight; "0 · outside window" when outside the confidence window), orders affected (1 + peer; for `overload`/`closed` derive the orders on that line+day the way `showForCell` does via `Utilization.minutesByDay`), and lateness hours (`msgVars.hours` on `late`, else `Util.latenessHours(task)`, `foundation.mts:782`). The group head sums them.

**C.4d Dismiss distorts the score.** `computeAlerts` drops dismissed ids, and Confidence reads `Store.alerts`, so dismissing raises the badge. Leverage and the Confidence tile use the same (dismissed-filtered) `Store.alerts` as the badge for consistency; the group "Dismiss N" confirm text states "hidden for this session; the confidence score will rise accordingly".

**C.4e Setup-pair card for non-writers.** `reviewAction()` (`setup-admin.mts:506`) already returns `'copy-export'` for users without matrix-write permission and `missingPairsCsv` exists — the card offers "Copy for setup owner" instead of hiding the action. Card also states when `setup_active` is off for the plant (the alert is then a warning and the pair changes no scheduling).

**C.5 Family: calendar-day conflicts.** Group `closed`, `blackout`, `firmed-closed` by `${line}|${dayKey(time)}`; removal method. Title must match the action: `leverage.title.calendar-day` = "{{n}} orders on closed time — {{line}}, {{day}}" (not "Open line on day": there is no single-day line exception in the calendar model and line hours/periods are admin-only). Actions: "Fix movable" → `Alerts.applyFix(id)` for each `blackout` alert in the group; "Diagnose" → `AlertsUIAdapter.showForCell(line, dayKey)` (`insights-ui.mts:1337`, works from any tab); "Edit line hours" → `EditCalendar.open(line)` (`frontend/calendar/edit-calendar.mts:78`, exists today; admin-only writes, so label it); "Go To" → `Timeline.gotoLineDay`.

**C.6 Family: routing/material gaps — group by the failure reason, not material+PV.** The resolver records 8 failure reasons (`backend/routing/resolver.py:254-256`) and each has a different fix: `workcenter_unmapped` is per machine (mapping one machine to its SAP work center clears every hold on it — the biggest lever in this family); `pv_missing` has no production version at all; `no_routing` / `pv_not_found` / `pv_expired` / `no_operation_at_workcenter` are routing-upload problems; `no_machine` is an order problem. The reason is stored in the DB but the API's `PlanningReason` model (`backend/scheduling/models.py:33`) keeps only `{code, message}` — **add `step` to that model** (additive; `tests/test_task_response_models.py` pins the field set, update it) and to `NimbusTask.planning_reason`. Grouping key: `step` first, then within a step: machine for `workcenter_unmapped`, material for `pv_missing`, material|PV for the routing-upload reasons. Read task fields from `Store.tasks`, **not** the snapshot tasks (`_stripPriorityFields`, `services.mts:201-204`, drops `PRODUCTION_VERSION`). Removal method, with the caveat stated on the card that scheduling the released orders adds load (the owner's "once these orders are scheduled"). Actions per step: `workcenter_unmapped` → `App.gotoMasterSub('work-centers')`; routing-upload reasons → `gotoMasterSub('routing-pv')` with a new public `MaterialGrids.setQuickFilter(which, text)` (the current `#md-rpv-quick` listener attaches only in `onGridReady`, `material-grids.mts:807-815`, so dispatching an `input` event right after `gotoMasterSub` can miss) — that grid is read-only and the real fix is an admin routing upload, so the card says "admin: upload routing"; `pv_missing` → Manage Data (admin) — card says so; `no_machine` → "Open these N orders in the table". Action: `App.goto('masterdata')` → `App.gotoMasterSub('routing-pv')` → set `#md-rpv-quick` value to the material and dispatch an `input` event (the quick filter applies only through its listener; confirmed).

**C.7 Execution.** `frontend/nimbus-worker.ts` gains `LEVERAGE_BATCH` (`{base, variants:[{key, setup}]}` → `[{key, alerts, matrix}]`): extend the message union (:44-46), the if-chain (:51-57) and the protocol header comment (:20-29). `services.mts`: `_snap()` today derives `setup` internally via `deriveSetupObservation(Store.setupSnapshot, …)` (:214, :247) — refactor into `buildPlantSnapshot(plant, {setupObservation?})` so the engine can pass a hypothetical observation; `_snap()` delegates. Widen `_post`'s union (`'ALERTS' | 'UTILIZATION'`, :181), add `Compute.leverageBatch`, plus a sync fallback when the worker is dead. `Confidence._recompute` can call `NimbusComputeCore` directly: compute-core is a classic script loaded at `index.html:3430` before `app-entry.mjs` injects `nimbus-intelligence.js`. Runs only while the monitor tab is active; debounce 400 ms after `alerts:change` / `tasks:bulk*` / setup-snapshot / calendar events; `Store.rev()` captured and stale results dropped; one in-flight analysis; skipped while `Sandbox.active` or `OptimizerPreview.active` (same guard as Confidence). Budget: full batch ≤ ~500 ms off-thread at a 70-line plant; lower `replayCap` if exceeded.

### C2. Optimizer fix cards (D16)

Group `overlap`, `late`, `overload`, `setup-violated` alerts by line × contiguous day window (merge adjacent conflict days; cap window at 14 days). For each: points in window, orders, and **headroom** = Σ(effectiveCapacity − scheduled) over the window from the baseline utilization matrix (`Utilization.computeMatrix` / `Compute.utilization`). Card title `leverage.title.optimize-window` "Re-sequence {{line}}, {{from}} – {{to}}"; body shows points, orders, headroom (`am.lev_headroom` "{{h}} h free in this window" or `am.lev_no_headroom` "{{h}} h over capacity — optimizing cannot clear overloads here"). Primary action: `OptimizeDialog.open({ lines:[line], startDate, endDate })` — **`OptimizeDialog.open()` takes no prefill today (`optimize-ui.mts:485`); add an optional options argument** that preselects lines and the custom window. When headroom ≤ 0 the primary becomes Diagnose (`showForCell` on the worst day) and Optimize moves to a secondary button. After `optimizer:applied` / `alerts:change`, the card re-evaluates and shows `am.lev_remaining` "{{n}} alerts remain". Method: none (no score prediction; the card shows points at stake, not a delta).

### C3. Acknowledge / Snooze (D17)

**Table** (same migration file): `alert_ack(plant TEXT NOT NULL, alert_id TEXT NOT NULL, acknowledged_by TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', until TIMESTAMP NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW(), PRIMARY KEY (plant, alert_id))`. Alert ids are deterministic from content (`ovl-<prev>-<cur>`, `late-<taskId>`, `closed-<line>-<day>`, …), so they survive recompute; when the underlying conflict changes the id changes and the ack naturally expires. Expired rows (`until < now`) are ignored on read and purged lazily on write.

**Routes** (`backend/alert_profiles/routes.py`, same auth pattern): `GET /alert-acks?plant=` → `{acks:[…]}` (active only); `POST /alert-acks` `{plant, alert_id, reason, until}` (authenticated + plant check; upsert; actor from header); `DELETE /alert-acks/{plant}/{alert_id}` (acknowledger or admin). `admin_audit` rows on write.

**Client**: `frontend/insights/alert-acks-client.mts` (load on `plant:selected`, cache, own `subscribe`). Store does not change; `Alerts` keeps computing everything. UI: `AlertProfileMatches` exposes `acked: Map<alertId, Ack>`; the monitor rows, drawer rows and Dashboard summary render an "ack" badge ("acknowledged by X until D", `alert.acked_by`) and hide acked alerts unless the "Show acknowledged" toggle (per-user pref `alertsShowAcknowledged`, default false) is on; the bell count excludes acked alerts. Confidence is **unchanged** (acked alerts still count) — stated in the Acknowledge dialog. Row action "Acknowledge…" opens a small `Modal` with reason (required, ≤200) and until (Flatpickr date, default +7 d, "no end" option); "Dismiss" (session-only) remains as the lightweight option. Tests: route tests + pg round trip; client/UI tests for hide/show toggle and bell count.

### D. Frontend page — new domain `frontend/alert-monitor/`

Files: `alert-monitor-pane.mts` (`AlertMonitorPane` — `init()/render()/setActive()`, DOM, subscriptions, delegated actions; DistributionPane shape), `alert-monitor-model.mts` (pure: KPI summary, row-action eligibility, HTML builders with injected `t`), `alert-profile-editor.mts` (modal), `CLAUDE.md`. Shared pieces in `frontend/insights/`: `alert-profiles.mts` (B), `alert-leverage.mts` (C), `alert-profile-client.mts` (fetch + per-plant cache + own `subscribe()` fanout — **no Store event**, to avoid `_rev` bumps), `alert-profile-matches.mts` (E). Rationale: `insights-ui.mts` is already 1,670 lines; Distribution is the newest-page precedent; the Gantt already imports from `insights/`, so reading the matched set from there adds no new domain edge. The pane reaches `Timeline`/`Table`/`App`/`AlertsUIAdapter`/`Confidence` via the ambient `NIMBUS` global (typed in `frontend/types/nimbus-global.d.mts`: `AlertsUIAdapter.focus` :116, `Table._openOverrideModalForId` :83, `Selection.set` :76, `Confidence` :98-103 — add `_score` and `showBreakdown` there), imports `Alerts` from `insights/services.mjs` and `SetupAdmin` from `setup/setup-admin.mjs`; the shell imports `AlertMonitorPane` directly (no `app.js` bridge). `deriveSetupObservation` is imported lazily inside function bodies (documented engine↔services loop).

**Layout** — *Superseded by rev 2 (2026-10-20) — see below.* (`#alerts-tab`, shell filled once by `_ensureShell()`): toolbar → KPI strip → scrollable body (`#am-scroll`).

- **Toolbar** — *Superseded by rev 2 (2026-10-20) — see below.* Mono-Eyebrow "PROFILE" + searchable combobox (`.us-combo` pattern copied from `_initDefaultPlantCombo`, shell 712-778; options: All alerts, then the plant's profiles) → writes `alertProfileByPlant`; mono window summary of the active rules; "Manage profiles…" button (opens editor); Gantt-highlight toggle; `seg-btn` group-by (type / machine / day / order / none); sort select (impact / soonest / severity / order); plant badge. `flex-wrap`, wraps below ~1,100 px; min viewport 1,024 px.
- **KPI strip** — *Superseded by rev 2 (2026-10-20) — see below.* five `.kpi-tile` buttons — Matched alerts (`.d` "of N in horizon"), Errors (`.err` when >0), Warnings (`.warn`), Orders affected, Confidence now (click → `Confidence.showBreakdown()`; `.d` "N alerts inside the confidence window"). Tile min 160 px (pt eyebrow "ALERTAS CORRESPONDENTES" ≈ 143 px).
- **High-leverage fixes** panel — *Superseded by rev 2 (2026-10-20) — see below.* top 5 `.am-lev-card`s (expand to the cap), each: family badge, title (`leverage.title.<family>` with vars), mono "N alerts · M orders", confidence `71 → 78` in Mono-KPI with `+7` in `--ok` (or `n/a` + `am.lev_outside_window`; `am.lev_partial_window` when some are outside), method eyebrow, actions: family primary (`.btn-primary.sm`) + "Show alerts" (filters the groups below, shows a focus chip). Skeleton while computing; `am.lev_none` empty copy.
- **Groups** — *Superseded by rev 2 (2026-10-20) — see below.* one `.am-group` card per group (head = `<button aria-expanded>`: sev glyph, label, `badge-err/-warn` counts, mono impact, caret; head actions Go To first / Dismiss N with `Modal.confirm` when N>5). Body: first 40 rows + "Show all N" (no nested virtual scrollers); group-by none → one `VirtualList` (`rowH 56`). Collapse state resets on plant change.
- **Row** — *Superseded by rev 2 (2026-10-20) — see below.* (`.am-row`, 56 px, grid `14px minmax(0,1fr) 150px minmax(220px,auto)`): sev glyph · headline (`AlertsUIAdapter.headlineFor`) + message (`Util.alertMessage`, ellipsis + title) · mono meta (order, line, `D+n`) · actions: Go To (ghost), one primary (Fix for fixable types / Override for closed-family with taskId), Dismiss as an `.icon-btn.sm ×`. Same `data-alert-action` vocabulary as the drawer (`focus|fix|override|dismiss`), dispatcher mirrors `_handleAction` (`insights-ui.mts:1253-1280`). Fix/Override disabled with `am.whatif_blocked` while `Sandbox.active`. Width budget: de "📅 Überschreiben" ≈ 128 px + Go to ≈ 70 + icon 24 + gaps → 220 px.
- **Empty states** (`.empty-state`): no plant; profile matched nothing (+ "Show all alerts" button); no alerts at all (`empty.no_active_alerts`).
- **CSS**: new "ALERT MONITOR" block in `styles.css`, `am-`/`ape-` prefixes, tokens only, hairlines, KPI top-border only, no side stripes, no hardcoded colours (so no `body.dark` block except the two new bar tokens).

**Profile editor** (`#modal-alert-profile`, static shell beside `#modal-user-settings`; body/foot rendered at runtime with inline `Util.t`): left rail = the plant's profiles + "New profile"; right form = Name (≤60), rules list (per rule: five category groups with indeterminate header checkbox + type checkboxes named via `headlineFor`; "From day"/"To day" `type=number min=-365 max=365 step=1` (blank = any; negative = days overdue; plain day offsets, not dates, so no Flatpickr; hint `ape.days_hint`); min severity select; remove), "+ Add rule", default ranking select, "Use this profile for plant X" toggle. Footer: Delete (only when creator/admin, `Modal.confirm({tone:'danger'})`), Cancel, Save. Inline `.ape-err` messages from `validateProfile`; server 409 mapped to `ape.err_name_dup` / `ape.err_stale`. Never opened from inside User Settings (single central focus trap).

**User Settings** (workflow pane, `_renderWorkflowPane` 780-876): "Alert profile for plant {{plant}}" combobox (readonly hint when no plant selected) + ghost "Open Alert Monitor" (closes the modal, `App.goto('alerts')`); "Highlight profile matches on the Gantt" toggle.

**Clarity amendments (audit 2026-10-20):** *Superseded by rev 2 (2026-10-20) — see below* for the wording, sort-precedence, group-by and KPI-tile bullets; the rest stand.
- Wording: method eyebrows read "exact" (replay) / "estimate" (removal), not "replayed"/"alerts removed". Score changes are "points" (0–100 scale), never "%". Relative days render as a date plus "in 9 days" / "3 days overdue", not bare `D+9`. Ranking value `orders` is labelled "Orders affected" (not "Order number").
- Sort precedence: the profile's `ranking` is the default; once the user changes the sort on the page it is stored in `alertMonitorView.sort` per profile id and wins for that profile.
- Group-by gains **Category** (the five `ALERT_CATEGORIES`) — the "high-level cards" grouping the owner described — alongside type / machine / day / order / none.
- Editor: show a live date range next to the day inputs ("D8–30 = Oct 28 – Nov 19 at this plant") and a live "matches N alerts now" count while editing; hide alert types that can never fire (`near-capacity`, `line_no_calendar`) from the type picker and the validation list.
- Per-type help: new `alert.help.<type>` one-liner ("what this means / usual fix") shown under the headline on hover/expand, for all 30 firing types in 5 locales — also mitigates that `overlap`, `overload`, `closed`, `blackout`, the firmed types, `runtime-unknown`, `pv-lot-size` and every setup diagnostic carry English-only `msg` today.
- Diagnose affordance per row: line+day alerts → `AlertsUIAdapter.showForCell(line, dayKey)`; order alerts → an inline expander showing due date, planned finish, lateness, run time + source (`Inspector._formatRuntimeBasis` pattern), firm status, setup from→to, and the `planning_reason` when present.
- Empty state for a user with no profiles: "All alerts" + fix cards + a "Create a profile" prompt (not only on the nothing-matches state).
- Session "View as" vs "Make default": the toolbar combobox switches the view for this session only; an explicit "Make my default for this plant" writes `alertProfileByPlant` (which drives the bell/drawer/Gantt). Prevents a quick look silently re-colouring the Gantt.
- Profile Duplicate and "Copy to plants…" (multi-select of plants the user can access) in the editor rail — storage stays per plant (D3).
- When a fix card's "Show alerts" focus is active, the Gantt highlight follows the focused set rather than the profile (so the two never contradict).
- Orders table: add a `'profile'` value to `TableStatusFilter` (`orders.mts:53`, alongside `conflict`/`atrisk`) so the grid can show profile matches too.
- KPI tile "of N in horizon" → "of N in plant horizon ({{days}} d)"; the monitor applies the **profile window** only, the bell/drawer apply plant horizon **and** profile — both numbers are labelled so they can differ without confusing.
- Every card and group gets "Open these N orders in the table": set the PO/Material paste filter (`#tbl-flt-pomat-textarea`), call `Table._onPoMatApply()`, then `App.gotoGanttSub('orders')` — there is no scroll-to-row API, so the paste filter is the stand-in.
- Cards whose fix needs admin rights (routing upload, Manage Data, line hours, plant time zone) say "admin fix" and offer a copy-to-clipboard summary for hand-off.

### D2. Bell, drawer and Dashboard summary follow the profile (D11)

- `AlertsUIAdapter._visibleAlerts()` (`insights-ui.mts:1606-1615`) gains one step after the plant/horizon filters: when `AlertProfileMatches.current().profileId !== '__all__'` and no session override is active, keep only ids in `current().alertIds`. The bell badge (`renderBell`), drawer (`renderDrawer`) and `Dashboard._renderAlertSummary` all go through this function, so they follow automatically. `insights-ui.mts` subscribes to `AlertProfileMatches.subscribe` to re-render the bell/drawer on a profile change (the shell already re-renders them on `alerts:change`).
- Drawer footer: alongside the existing `alert.horizon_hidden_duration` note, add `alert.profile_hidden` ("{{n}} more hidden by profile {{name}}") with a `btn.show_all`-style link that sets a session-only `AlertsUIAdapter._profileOverride = true` (cleared on plant change) and re-renders; the footer then reads `alert.profile_override_on` ("Showing all alerts · Back to profile").
- Not filtered: the Gantt `conflict-order` outline / `_conflictIds()`, alert day-cells, `Store.alertsByTask()` consumers in the Orders table (`status: conflict/atrisk` filters), `NeedsEngine` (command palette) and `Confidence` — these are plant-wide truth by design. Record this boundary in `frontend/insights/CLAUDE.md`.
- Tests: `tests/modules/insights/insights-ui.test.mjs` — `_visibleAlerts` with a stubbed matched set hides non-matching ids, `'__all__'` leaves the list unchanged, override restores it, bell count follows; Dashboard summary parity.

### E. Gantt integration

- **Producer** `frontend/insights/alert-profile-matches.mts`: `AlertProfileMatches.init()` at boot (always-on, independent of the tab); subscribes `alerts:change` (120 ms debounce), `plant:selected`, `settings:change` (recompute only if `alertProfileByPlant` or the toggle actually changed), and the client's fanout. `current(): {plant, profileId, alertIds, taskIds, sevByTask (worst sev), rev}`; `subscribe(fn)` own fanout. "All alerts" ⇒ empty set (nothing highlighted).
- **Consumer** `gantt.mts`: in `_itemForTask` after the `dimmed` push: `profile-match profile-match-<sev>` when the task is in the set and the pref is on (re-derived on every rebuild like `goto-target`). `_applyProfileMatchClasses()` = the className-only diff pattern (`GanttFilter._doApply`) bracketed by `_suppressEvents`, wired in `Timeline.init` via `AlertProfileMatches.subscribe` and on the toggle; skipped when the Gantt is hidden. `navBarStyle` (1968-1974) gets a `profile-match` branch above `order-firmed`. Never `position/top/height`.
- **Classes** (D13): `profile-match profile-match-<category> profile-match-<sev>` where category ∈ `capacity | conflicts | calendar | setup | exceptions` is the most severe matching category (err beats warn; tie → the category order above). `AlertProfileMatches.current().categoryByTask` provides it.
- **CSS**: five fill tokens beside `--bar-standard` (light / dark), each distinct from bar blue `#1f5fbf` and firmed red `#b02a20`, saturated-not-neon, ≥4.5:1 with their text colour, and separable under deuteranopia/protanopia — candidate set (implementer validates with the dataviz palette checker before committing): capacity `#d97706` amber / fg navy; conflicts `#7c3aed` violet / fg white; calendar `#0f766e` teal / fg white; setup `#be185d` magenta / fg white; exceptions `#6b7280` slate / fg white. `.vis-item.vis-range.profile-match-<cat> { background/border-color: var(--bar-pm-<cat>) !important; color: var(--bar-pm-<cat>-fg) !important }`; severity ring `.profile-match-err { box-shadow: inset 0 0 0 2px var(--err) }` / `-warn` `var(--warn-vivid)`; placed after `.dist-sibling` and before `.goto-target` so the goto ring still wins; `.profile-match.split-order-segment` composes the white keyline + ring. Firmed matches keep the 🔒 glyph. `navBarStyle` gets one `profile-match` branch (single neutral minimap colour). **Fallback** (only if the browser check shows drag ghosts or selection misreading the fill): drop background/color, keep a 3 px inset ring in the category colour; TS unchanged.
- **Legend**: five `li.lg-k` rows after `dist_sibling` (`.lg-pm-<cat>` swatches), keys `legend.pm_<cat>_t/_d` plus one shared `legend.pm_ring_d` explaining the severity ring; added to the legend REQUIRED list in the locale test. Also a tiny category legend in the monitor toolbar.

### E2. Go-fix matrix (per alert type → destination → entry point)

| Alert type | Fix destination | Entry point (exists unless noted) |
|---|---|---|
| overlap | Move order / re-sequence line | `Alerts.applyFix`; Go To; optimizer card (see Q-optimizer) |
| tool-conflict | Move; select both orders; tool assignment | `applyFix`; `Selection.set([taskId, peerId])` (focus selects only taskId today — extend); Material-Plant grid `prt_01/prt_02` editable (`material-grids.mts:262`, quick filter `#md-mp-quick`) |
| distribution-separation | Distribution board, parent detail | `App.gotoGanttSub('distribution')`; opening one parent: **none** (`_openDetail` private) → add `DistributionPane.openParent(parentId)` |
| overload | Optimize line-day; diagnose | `applyFix` (runs changeover optimizer); `showForCell` |
| closed | Diagnose; line calendar | `showForCell`; `EditCalendar.open(line)` (admin writes) |
| blackout | Move order; the blackout itself | `applyFix`; plant blackout: `App.goto('masterdata')`→`gotoMasterSub('plant')`→`Plant.gotoTab('calendar')`→`Plant._revealBlocks(ids)` (block id must be derived from the overlap; `admin-ui.mts:417`); line blackout: `ProdLines.openBlockModal(line)` |
| firmed-closed / firmed-out-of-hours | Override; line calendar | `Table._openOverrideModalForId`; `EditCalendar.open(line)` |
| finish_moved_earlier / no_operating_window | Calendar | `EditCalendar.open(line)` / `openPeriod`; Go To |
| runtime-schedule-mismatch | Re-derive | Go To + inline diagnose; plant-wide `POST /routing/{plant}/recompute` (admin) |
| setup-violated | Re-sequence; matrix minutes | Go To; optimizer card |
| setup-uncovered | Setup matrix | `SetupAdmin.reviewMissingPairs`; non-writers: copy-export |
| initial-state-unknown / current-state-diverged | Machine-state editor | Go To → Inspector `SetupAdmin.mountStateEditor` (`orders.mts:2394`) |
| override-inactive / setup_override_orphaned | Override editor | Go To → `Inspector._showSetupOverrideEditor` (`orders.mts:2425`) |
| predecessor-/successor-state-unknown | Order attributes (colour/PRT) | Material-Plant grid (`#md-mp-quick`) — cheap link even though "missing attributes" is not a leverage family (D4) |
| runtime-unknown | Depends on `planning_reason.step` | see C.6 |
| pv-lot-size | Lot-size master data | routing-pv grid (read-only) / Manage Data (admin) |
| late / reversal_forward | Re-sequence by due date; Override | Override; optimizer card (due-date mode) |
| pull_floor_crossed / frozen_window_crossed | Plant order rules | `Plant.gotoTab('settings')` (Order Rules, `admin-ui.mts:1349+`) |
| plant_no_timezone | Plant time zone | Manage Data `plants` (admin) — pinned banner, not a card |
| placement_exception / run_time_zero / no_anchor / derivation_issue | The order | Go To → Inspector; `run_time_zero` → Orders run-time edit |
| near-capacity / line_no_calendar | — | never fire; hidden |

### F. Wiring, i18n, docs

- Tab key `alerts`, panel `#alerts-tab`, label `tab.alerts` "Alert Monitor", nav order `home, gantt, labor, alerts, masterdata, admin`. Mirror points: `TopLevelTab`; `index.html` button after Labor Plan + section after `#labor-tab`; shell `_landingTabDefs`, `_updateSectionLabel` map, `_firstAccessibleTab`, `_paneScrollTargets` → `#am-scroll`, `goto` leave (`AlertMonitorPane.setActive(false)`) and enter (`init(); render(); rAF → _restoreScroll`), `_gotoLanding` validTabs; `DEFAULT_PAGE_ACCESS.alerts = true`; `_pageAccessDefs`/`_defaultPageAccess`; `PAGE_ACCESS_KEYS`; `App.init` → `AlertProfileMatches.init()`. Grep `tests/modules/application-shell.test.mjs`, `tests/contracts/cq1-legacy-surface.json`, `tests/test_*.py` for pinned tab/page-access lists before editing.
- i18n: `tab.alerts`, `am.*`, `ape.*`, `leverage.title.*` / `leverage.action.*`, `toast.alert_profile_*`, `us.alert_*`, `legend.profile_match_*` — full English list in **Appendix: i18n keys** below; all five locales move together with real translations (follow the existing glossary: es "pedido", fr "commande", de "festgeschrieben"); new REQUIRED block + placeholder-parity assertion in `locale-completeness.test.mjs`.
- Docs: `backend/alert_profiles/CLAUDE.md` (substantive), `frontend/alert-monitor/CLAUDE.md`, root CLAUDE.md domain row + router count, `frontend/insights/CLAUDE.md` (new modules, no-Store-event decision, stale line numbers fixed), `frontend/scheduling/CLAUDE.md` (profile-match class + amber rationale), `frontend/shell/CLAUDE.md` tab list. Deferred items → `docs/MIGRATION.md` or this spec, not a plan file.

### G. Tests

Backend: `tests/test_alert_profiles.py` — route tests with `dependency_overrides` (template `tests/test_labor_plan.py:13-19`): 400/403/404/409 paths, validation cases, creator/admin/non-creator edit rules, stale `expected_updated_at`; `@pytest.mark.pg` CRUD round trip + UNIQUE + `admin_audit` rows with cleanup. `tests/test_schema_idempotent.py` must still pass; extend any `PAGE_ACCESS_KEYS` assertion.

Frontend (`node --test`, compiled `.mjs`): `tests/modules/insights/alert-profiles.test.mjs` (null bounds, inclusive day boundaries at 00:00 / 23:59:59.999 / next 00:00, negatives, minSev, OR of rules, no-time alerts, validation parity, ranking comparators, `resolveActiveProfileId`); `alert-leverage.test.mjs` (grouping per family, `outsideConfidenceWindowCount`, removal delta == `scoreConfidence` on the reduced set, pairKey parse, hypothetical row resolves covered, **replay sign tests**: fixture A after > before, fixture B with oversized minutes after < before and still reported, cap 20 + `capped`, `requiresMinutes` path); `confidence-score.test.mjs` (formula parity, caps, bands, window edges; keep `confidence-lifecycle.test.mjs` green); `alert-profile-matches.test.mjs`; `tests/modules/alert-monitor/*.test.mjs` (model, editor validation/`canDeleteProfile`, pane: empty state, row builder escapes HTML, Fix/Override eligibility, inactive tab suppresses render, stale-rev results dropped); `gantt.test.mjs` additions (`_itemForTask` classes with pref on/off; `_applyProfileMatchClasses` updates only changed items inside `_suppressEvents`); `application-shell.test.mjs` / `security/*` (tab order, landing defs, CATALOG keys, `DEFAULT_PAGE_ACCESS`); `services.test.mjs` (Compute key set now includes `leverageBatch` — update the pinned list deliberately); `locale-completeness.test.mjs`.

---

## Appendix: i18n keys (English)

> v1 list. 37 keys were removed in rev 2 (see the rev-2 "Removed locale keys" list); the keys shown below that are in that list no longer exist.

```
tab.alerts: Alert Monitor
am.profile_label: PROFILE · am.profile_all: All alerts · am.manage_profiles: Manage profiles… · am.profile_ph: Search profiles… · am.profile_none: No profiles for this plant yet
am.window_rule: {{types}} · D{{from}}–{{to}} · {{sev}} · am.window_any_days: any day · am.window_sev_any: all severities · am.window_sev_warn: warnings and errors · am.window_sev_err: errors only · am.window_all: Showing every alert in the horizon
am.gantt_highlight: Highlight on Gantt
am.group_by: GROUP · am.group_type: Type · am.group_line: Machine · am.group_day: Day · am.group_order: Order · am.group_none: None
am.sort: SORT · am.sort_impact: Largest impact first · am.sort_time: Soonest first · am.sort_severity: Severity · am.sort_orders: Order number
am.kpi_matched: MATCHED ALERTS · am.kpi_matched_of: of {{total}} in horizon · am.kpi_errors: ERRORS · am.kpi_warnings: WARNINGS · am.kpi_orders: ORDERS AFFECTED · am.kpi_confidence: CONFIDENCE NOW · am.kpi_confidence_sub: {{n}} alerts inside the confidence window
am.leverage_title: High-leverage fixes · am.leverage_hint: Fixes that clear the most alerts, ranked by confidence gain
am.lev_alerts: {{n}} alerts · {{m}} orders · am.lev_conf: Confidence {{before}} → {{after}} · am.lev_conf_na: Confidence n/a · am.lev_outside_window: outside the confidence window · am.lev_partial_window: {{n}} of these alerts are outside the confidence window
am.lev_method_replay: replayed · am.lev_method_removal: alerts removed · am.lev_needs_minutes: Enter setup minutes to replay · am.lev_minutes_ph: minutes · am.lev_show_alerts: Show alerts · am.lev_computing: Working out the best fixes… · am.lev_none: No single fix clears more than one alert right now · am.lev_show_more: Show all fixes
am.focus_chip: Showing {{n}} alerts for: {{title}} · am.focus_chip_outside: Showing {{n}} alerts for: {{title}} ({{k}} outside your profile) · am.focus_clear: Show all
alert.profile_hidden: {{n}} more hidden by profile {{name}} · alert.profile_show_all: Show all · alert.profile_override_on: Showing all alerts · alert.profile_back: Back to profile
am.group_dismiss_n: Dismiss {{n}} · am.group_dismiss_confirm: Dismiss all {{n}} alerts in this group for this session? · am.show_all_n: Show all {{n}} · am.day_rel: D{{n}} · am.whatif_blocked: Not available while What-If is active
am.empty_no_plant: Select a plant to monitor its alerts · am.empty_no_match_title: Nothing matches this profile · am.empty_no_match_msg: {{total}} alerts are in the horizon but none match "{{name}}". · am.empty_switch_all: Show all alerts
am.profile_missing: Your saved alert profile for this plant no longer exists; showing all alerts
leverage.title.setup-pair: Define setup pair {{from}} → {{to}} ({{lines}}) · leverage.title.calendar-day: Open {{line}} on {{day}} · leverage.title.routing-gap: Add a routing for {{material}} {{pv}}
leverage.action.setup-pair: Open setup matrix · leverage.action.calendar-day: Fix movable orders · leverage.action.routing-gap: Open routing
ape.title_new: New alert profile · ape.title_edit: Edit alert profile · ape.name: Name · ape.name_ph: e.g. Overlaps next month · ape.rules: Rules · ape.rule_n: Rule {{n}} · ape.add_rule: Add rule · ape.remove_rule: Remove rule · ape.types: Alert types
ape.cat_capacity: Capacity · ape.cat_conflicts: Scheduling conflicts · ape.cat_calendar: Calendar · ape.cat_setup: Setup · ape.cat_exceptions: Other · ape.select_category: Select all in {{cat}}
ape.day_from: From day · ape.day_to: To day · ape.days_hint: Days from today at the plant, inclusive. Negative = overdue. Leave blank for any.
ape.min_sev: Minimum severity · ape.sev_any: Any · ape.sev_warn: Warnings and errors · ape.sev_err: Errors only · ape.ranking: Default ranking · ape.set_mine: Use this profile for plant {{plant}} · ape.new_profile: New profile
ape.err_name_required: Enter a name · ape.err_name_dup: Another profile in this plant has this name · ape.err_no_rules: Add at least one rule · ape.err_rule_no_types: Pick at least one alert type · ape.err_days_range: Days must be whole numbers from −365 to 365 · ape.err_days_order: "From day" must not be after "To day" · ape.err_rule_dup: Two rules are identical · ape.err_stale: Someone else changed this profile — reopen it
ape.delete_confirm_title: Delete profile · ape.delete_confirm_msg: Delete "{{name}}" for everyone in plant {{plant}}? Users who selected it fall back to All alerts.
toast.alert_profile_saved: Profile "{{name}}" saved · toast.alert_profile_deleted: Profile deleted · toast.alert_profiles_load_failed: Could not load alert profiles
us.alert_profile_for: Alert profile for plant {{plant}} · us.alert_profile_no_plant: Select a plant first · us.alert_profile_hint: The Alert Monitor opens tailored to this profile and the Gantt highlights its orders. · us.alert_profile_manage: Open Alert Monitor
us.alert_gantt_highlight: Highlight profile matches on the Gantt · us.alert_gantt_highlight_hint: Bars are coloured by alert category with a red or amber inner ring for severity. Off shows the standard colors.
legend.pm_capacity_t / _conflicts_t / _calendar_t / _setup_t / _exceptions_t (the five category names, e.g. "Capacity alert", "Other alert") with matching `_d` lines ("This order has a capacity alert your active profile is tracking.") · legend.pm_ring_d: Inner ring: red = error, amber = warning. (These superseded the single-colour `legend.profile_match_*` pair, which was dropped.)
```

Reused existing keys: `btn.go_to`, `btn.fix_it`, `btn.override`, `btn.dismiss`, `btn.save`, `btn.cancel`, `btn.delete`, `btn.close`, `empty.no_active_alerts`, `tip.fix_alert`, `toast.select_plant_first`, `ui.plant_label`, `us.no_matches`, every `alert.type.*`.

## Deferred

Per-rule highlight colours (v1 is per category); machine-subset / order-attribute / firm-status rule fields (declined for v1); starter profiles (declined); optimizer cards with predicted score (preview replay per window); showing non-alert Needs-Planning holds (`overlong_never`, `run_time_over_cap`, `planner_unscheduled`) — out of scope under D1; Roles-tab UI for role-default profiles; calendar deep link to a line+day (`EditCalendar.openForLineDay`); routing-table prefilter API; persisted dismissals / snoozes; "missing order attributes" leverage family; one-click "define pair" via `POST /setup/{plant}/matrix/import` (sparse upsert exists; needs minutes UX + permission).

## Appendix: Context + things learned along the way

- **Bars are not line-coloured.** On the Gantt today a standard order is blue (`--bar-standard`) and a firmed order is red (`--bar-firmed`); colour does not encode the line. That is why the profile-match fill uses its own hue per category (D8, D13) rather than a red or line colour that would read as "firmed".
- **Confidence caps at 50.** The alert penalty is `min(50, round(Σ base×tw))`, so a plant with many alerts can sit at the cap and a fix may show "score unchanged". That is why the headline ranking metric is uncapped impact points (D12) and the capped delta is shown second.
- **`setup-uncovered` dedups per line + pair.** N orders needing one missing pair on one line produce one alert, so alert counts understate the orders affected; leverage cards report both alerts and orders.
- **`SetupAdmin` is not on the `NIMBUS` global.** It is reachable only through the boot-time `__NIMBUS_PLANT_ADMIN` bridge that `app.js` never destructures, so the pane imports `../setup/setup-admin.mjs` directly (lazily, inside the action handler).
- **`PlanningReason` drops `step`.** The resolver stores the failure step in the database, but the API's `PlanningReason` model keeps only `{code, message}`; the routing-gap family needs `step`, so it is added additively to the model, its test pin, and `NimbusTask.planning_reason`.
- Related: `Store.emit()` bumps `_rev`, so derived UI state (profile matches, profile client) uses its own `subscribe()` fanout and never a Store event; dismissals are session-only and distort the confidence score, so the Dismiss-N confirm text says so.

## Shipped vs deferred (2026-10-20)

Written at the end of the build (18 reviewed tasks on `feature/alert-monitor`). Where this section and the design text above disagree, this section describes the code.

### What shipped, per section

- **A. Data model + backend.** `backend/alert_profiles/` (`data.py`, `routes.py`) as the twelfth router, tables `alert_profile` and `alert_ack` (migration `2026-10-20-2-alert-profiles.sql`, mirrored in `schema.sql`), creator-or-admin edit rights, optimistic concurrency, naive-local `until`. `PlanningReason` gained `step`.
- **B. Rule semantics.** `frontend/insights/alert-profiles.mts` (matching, ranking, grouping, `validateProfile`, shared Fix/Override/calendar type sets), the always-on `alert-profile-matches.mts` producer with its own fanout, the two API clients over `plant-lru.mts`.
- **C / C2 / C3. Leverage, optimizer cards, acknowledge.** `alert-leverage.mts` (six families, replay through a new worker `LEVERAGE_BATCH` message on a dedicated short-lived worker with a 30 s cutoff; as of 2026-10-23 a timeout stops the worker and keeps the quick ranking instead of rerunning on the main thread), confidence scoring extracted to `nimbus-compute-core.js` (`scoreConfidence`, `alertPoints`, `CONFIDENCE_WEIGHTS`; `Confidence` now calls it), the "Optimize this window" card through `OptimizeDialog.open(prefill)`, and the acknowledge/snooze modal.
- **D / D2. The page and the followers.** `frontend/alert-monitor/` (pane, model, profile editor, ack modal); the bell, drawer, Dashboard summary and `dismissVisible` follow the profile and acknowledgements through `AlertsUIAdapter._visibleAlerts`; Gantt outlines, day cells, `alertsByTask` consumers, NeedsEngine and Confidence stay plant-wide.
- **E / E2. Gantt and go-fix.** Category fills with a severity ring, legend entries, minimap tone, the Orders-table `'profile'` status filter; every alert type's Fix / Override / Go To / Diagnose destination, plus deep links (`MaterialGrids.setQuickFilter`, `EditCalendar.open`, `SetupAdmin`, `OptimizeDialog.open(prefill)`, `DistributionPane.openParent` exists but is not yet called).
- **F / G. Wiring, i18n, docs, tests.** The `alerts` tab in every mirror point, four settings keys, the User Settings profile rows, strings in all five locales with a completeness test block, the CLAUDE.md network (`frontend/alert-monitor/` substantive), tests under `tests/modules/alert-monitor/`, `tests/modules/insights/`, `tests/test_alert_profiles*.py`.

### Rulings that changed the design during the build

- **Locale key names follow the engine.** The leverage title keys are `leverage.title.setup-pair | calendar-day | tool | machine-state | optimize-window | routing-gap.<code>` with the variables the engine emits; the appendix's `routing-gap-wc` / `-pv` variants were dropped (one source of truth, no dead keys).
- **`requiresMinutes` items carry a removal score**, but the UI renders them as "enter minutes" and never shows that score as a prediction; one replay runs only after the user enters minutes.
- **Headroom is in hours** (no `/60`), and **`adminOnly` is true for `workcenter_unmapped`** (writing work centers is admin-only) and the routing steps, false for `no_machine`. Setup groups read `snapshotBase.setup.diagnostics`; only replays derive.
- **Palette changed after the checker.** The dataviz palette checker rejected the spec's candidate fills; shipped (identical light and dark): capacity `#e0a800`, conflicts `#8750f0`, calendar `#14b8a6`, setup `#c8359a`, exceptions `#78716c` (neutral grey for "Other"). The fill (not the ring fallback) shipped; the ring and selection are composed through `--pm-inner` / `--pm-ring`, and the warn ring turns dark on the amber fill.
- **Orders affected = distinct `taskId ∪ peerId`** (an overlap or tool conflict affects both orders), in the KPI strip and group sums.
- **The `'profile'` Orders-table filter is disabled under All alerts** (it would be a silent empty table) and falls back to the default status on a switch.
- **The minimap profile tone is `--accent` with a keyline**, not `--warn` (semantic-colour rule).
- **Flatpickr `minDate: 'today'` in the ack modal is the browser's today**, not the plant's; recorded below as open.
- **`validateProfile` enforces the server's limits** (name length, rule count, `minSev`, rule shape) with `ape.err_name_long`, `ape.err_too_many_rules`, `ape.err_min_sev`.
- **The drawer's `dismissVisible` dismisses only what the drawer lists**, and the Dismiss-N confirm says dismissals are session-only and distort the confidence score.
- **The `--bar-pm-*` tokens are defined once, by the Gantt task.** The page task did not define them; its category legend swatches stayed unstyled until the Gantt task landed, which also owns the palette validation (one definition, one place).
- **`NimbusTask.planning_reason` gained `step?: string | null`** in `types.mts` (and `compute-core.d.ts`), so the client type is honest before the leverage engine reads it; the server side is `PlanningReason.step`.
- **The "Amber" ruling:** `us.alert_gantt_highlight_hint` was reworded to describe category colours plus the severity ring, the `legend.profile_match_*` pair was dropped in favour of `legend.pm_*`, and this spec's appendix was aligned.
- Process notes: `SetupAdmin` is imported lazily by the pane (not on the `NIMBUS` global); the shared type sets moved into `alert-profiles.mts` after the drawer and monitor models were found declaring the same lists twice.

### Deferred (from the design, verbatim)

Per-rule highlight colours (v1 is per category); machine-subset / order-attribute / firm-status rule fields (declined for v1); starter profiles (declined); optimizer cards with predicted score (preview replay per window); showing non-alert Needs-Planning holds (`overlong_never`, `run_time_over_cap`, `planner_unscheduled`) — out of scope under D1; Roles-tab UI for role-default profiles; calendar deep link to a line+day (`EditCalendar.openForLineDay`); routing-table prefilter API; persisted dismissals / snoozes; "missing order attributes" leverage family; one-click "define pair" via `POST /setup/{plant}/matrix/import` (sparse upsert exists; needs minutes UX + permission).

### Open after the build (reviewer minors not fixed; final-fix-wave candidates marked)

- **Profile editor (final-fix-wave).** Rail switch / New / Duplicate / Copy silently discard unsaved edits (needs a dirty check and `Modal.confirm`); a non-409 save or delete failure shows the stale-edit text (use a generic failure key); no test for the category header toggle or `data-indet`; `MAX_NAME = 60` duplicates the validator's limit; Escape can close the editor while a confirm is up or a save is running.
- **Acknowledge (final-fix-wave).** Flatpickr `minDate` should be `Util.dayKey(Util.plantToday(plant))`; the plant-wide boundary test covers `_conflictIds` and `alertsByTask` only (day cells, NeedsEngine and Confidence rest on grep and the doc); `footer.onclick` is reassigned every render.
- **Leverage page.** `confidenceBefore` uses the plant-line-filtered alerts while the badge uses all `Store.alerts`; `DistributionPane.openParent` has no caller and its `_pendingParent` never expires; `resetView` relies on `plant:selected` to clear the Gantt focus; `_levForcePaint` relies on `_paint` staying synchronous; `Math.ceil` of minutes has no epsilon guard; a `replayWithMinutes` early return on an already-replayed item is unreachable from the UI; on a worker timeout the `_pending` entry for that message id is not deleted.
- **Page and model.** `_bannerHtml` scans all `Store.alerts` for `plant_no_timezone` without plant scoping; `'JetBrains Mono'` is hardcoded in CSS (check for a mono token) and one rule uses the id selector `#am-make-default`; "(∞ d)" shows when a plant has no alert horizon; Go To lacks an `aria-label`; the late-hours regex is loose; the no-task / no-cell Diagnose branch is untested; the status dropdown is rebuilt on every producer notification.
- **Gantt.** The grey exceptions fill against dark `--bar-standard` is the weakest pair (hue-carried); `.dist-sibling`'s `!important` shadow hides the ring on a profile-matched sibling of the selected order; the legend's ring-explainer row reuses a setup swatch; the classes are applied while the Gantt is hidden (cheap). Browser checks owed: drag ghosts, split segments, lane rows, selection stacking, dark mode.
- **Backend.** The `stale` mapping keys off the exact `ValueError` message (a `StaleProfile` subclass would be sturdier); `brain.py`'s `_ADMIN_WRITE_OPERATIONS` map is not extended, so these writes miss the in-memory backend log (the durable `admin_audit` rows are written); ack DELETE lists all active acks (O(n)) and cannot tell expired from missing; `description` is unbounded; `until` is a naive `TIMESTAMP` compared with `NOW()`; the pg-backed data tests were skipped for lack of a local Postgres and must be run with `NIMBUS_TEST_DB=1`.
- **i18n.** `alert.help.closed` says "a day or hour" but the rule fires only for a zero-capacity day (all five locales); German terminology drift (Rüst- vs Umrüst-, "gelb" for the warning ring, "Warnung" used for alert); fr/pt KPI eyebrows (~200 px) wrap in a 160 px tile at 1,024 px, and the German/Portuguese widths were unmeasured.
- **Browser checks owed overall.** Pane, Optimize prefill and grid quick-filter handoff, editor and ack modal inside the focus trap (Flatpickr altInput), VirtualList positioning and the five-column grid at narrow widths, fr/pt widths, dark mode.

## UI overhaul — rev 2 (2026-10-20)

Written after the overhaul shipped on `feature/alert-monitor`. Where this section and the v1 layout text above disagree, this section describes the code. Backend tables, profile matching, the leverage engine and its replay, acknowledgement semantics, the Gantt fill and the bell/drawer/Dashboard filtering are unchanged; the overhaul replaces the page's toolbar, KPI strip, leverage cards, group heads and rows, adds one shared primitive (`OverflowMenu`) and one additive route (`POST /alert-acks/bulk`).

### Owner decisions (settled; don't re-ask)

| # | Decision | Answer |
|---|---|---|
| U1 | Page top | **Title row + one summary line.** A real page title, the plant, the profile picker and a ⋯ menu in one row; beneath it one sentence ("42 alerts match · 12 errors · 18 orders affected · Plant confidence 71"). No KPI tiles. |
| U2 | Fix line | **Counts, plus the confidence change when it is computed exactly.** "Clears 6 alerts on 4 orders · Confidence 71 → 78"; the confidence clause appears only for a replayed fix whose score changes; otherwise counts only. |
| U3 | Sort | **One switch next to Group by.** "Default ranking" leaves the profile editor. (Its labels were reworded by U5-8.) |
| U4 | Row actions | **Two visible plus a ⋯ menu.** Go to always, Fix or Override when the alert has one; Diagnose and Acknowledge live in the ⋯ menu. |
| U5 | Scheduler-review amendments (all accepted) | (1) the profile's day window appears in the summary line; (2) rows are prefixed with the line; (3) default group-by is **Machine**; (4) a group head gets **Move N orders**; (5) admin-only fixes sit **below a "Needs an admin" divider**; (6) **Acknowledge is the only "make it go away" verb on this page**: Dismiss leaves the monitor (it stays in the drawer) and a group head gets "Acknowledge N…"; (7) "Plant confidence 71"; (8) the switch reads **Priority / Date**. |
| U6 | Profile creation | Users create and edit profiles **on this page**: "+ New profile…" is the last option of the picker and an **Edit** button sits beside it ("View rules" for non-creators, who get the read-only form as in v1). "Manage profiles…" is gone. Create = any user with plant access; edit/delete = creator or admin (the v1 rule, unchanged); profiles stay plant-shared (D3). After a create from the picker the page views the new profile. |

The "audit" amendment that the confidence score is never hidden when a fix lowers it (D9) stands: a lower after-score is shown.

### Vocabulary rule (binding)

Never user-visible on this page: "points", "pts", "exact", "estimate", "outside the confidence window", "cap". Ranking is internal: `impactPoints`, `compareAlerts('impact')`, `groupAlerts` ordering, `LeverageItem.points` and the engine's sort, the replay cap ordering and `_scoreWithout` stay as internal ranking and are never rendered. The only numbers shown are counts, dates and relative days, and the confidence score (0–100). A test in `tests/modules/locale-completeness.test.mjs` ("Alert Monitor vocabulary gate") fails if any English `am.*` or `leverage.*` value matches `points`, `pts`, `exact(ly)`, `estimate(d)`.

### Page header (replaces the toolbar and the KPI strip)

`.am-head` has three rows.

1. **Title row.** `h2.am-title` ("Alert Monitor", key `tab.alerts`), the plant badge, then the `.us-combo` profile combobox, an Edit button, the default-status control and a ⋯ page menu. The combobox lists All alerts, the plant's profiles and a final "+ New profile…" option (sentinel `NEW_PROFILE_ID = '__new__'`). `choose()` intercepts the sentinel before `_chooseProfile` (it opens the editor with `fromPicker: true`), and `_chooseProfile` itself rejects any id that is not in `_comboOptions()`, so the sentinel and stale ids never become the view. The viewed option shows its `windowSummary` as a muted second line, and the input carries it as `aria-description`. The Edit button is hidden under All alerts and with no plant; its label is "Edit" for an admin or the creator (`canDeleteProfile`) and "View rules" otherwise. The default control is the muted "Your default" text when the viewed profile is the user's resolved default, else a "Set as default" button (the one control that writes `alertProfileByPlant`). The ⋯ page menu is an `OverflowMenu` of two checkbox items, "Highlight on Gantt" (`alertProfileGanttHighlight`) and "Show acknowledged" (`alertsShowAcknowledged`); the manage-profiles button and the toggle chips of v1 are gone.
2. **Summary line** (`.am-summary`). One sentence built by the model's `summaryLine`: the first clause is the profile-window sentence (`am.summary_window`, used when every rule of the viewed profile has the same set `dayFrom` and `dayTo`, found by `profileWindow`), else `am.summary_profile`, `am.summary_all` under All alerts, or the focus-chip text while a fix's "Show alerts" focus is active. Then the error, warning and orders-affected clauses (a zero count is omitted; exactly 1 uses the `_one` key, including the singular leads `am.summary_*_one`), then a `button.am-summary-conf` "Plant confidence N" that opens the Confidence breakdown. Counts are over the alerts the list shows (profile-filtered, acknowledged excluded unless asked; the focus set in focus mode); "orders affected" is the distinct `taskId ∪ peerId` set.
3. **Controls row.** A "Group by" `<select class="input">` (Machine, Day, Type, Category, Order, None; `MONITOR_GROUP_BYS`, default `DEFAULT_GROUP_BY = 'line'`) and a "Sort by" switch of two `seg-btn`s, Priority and Date (`MONITOR_SORTS = ['impact', 'time']`).

Persistence: `alertMonitorView[profileId] = { groupBy?, sort? }`. `_persistView` writes only the key the user changed, so the other keeps following its default. `viewFor` reads a stored `groupBy` as-is when it is a known value (saved views keep theirs), else Machine; the sort is the stored `time` or `impact`, with stored `severity` / `orders` (earlier builds) coerced to `impact`, and with nothing stored `profile.ranking === 'time'` gives `time`, anything else `impact`. The profile banner and the zero-profiles "Create a profile" prompt stay under the header. *Superseded by rev 3 (2026-10-20) — see below: the Overview band's What panel carries a five-category legend of counts.* The five-swatch category legend is gone from the page (the Gantt legend carries the colours).

### Top fixes (replaces the card grid)

`section.panel.am-fixes` with a `panel-head` (`h3` "Top fixes" and the hint "Across all alerts at this plant, not only this profile. Biggest first."). It renders whenever the plant has alerts (`scopedCount > 0`), including when the profile matches nothing; the fixes always work on all of the plant's alerts (D10). While the first pass runs it shows a skeleton, and `am.lev_none` when computed with no items. Built by `fixesSectionHtml` / `fixRowHtml` / `fixLineParts`; sizes `LEV_TOP_N = 5`, `LEV_STEP = 10`, `LEV_MAX_RENDER = 50`.

- **Partition first, then slice.** A non-admin viewer's ranked main list is the items that are not `adminOnly`, sliced to the first 5; "Show 10 more" adds 10 per click up to 50 rendered (a 636-row DOM once froze the page). Admin-only items for a non-admin go under a collapsed disclosure button "Needs an admin (N)" (`am-fix-divider`, `aria-expanded` / `aria-controls`), rendered whenever that list is non-empty; opened, its rows carry no rank number and are capped at 50. An admin sees one list and no divider. The disclosure resets with the plant.
- **Row.** A rank number, the title (with a "needs an admin" badge on admin-only items), a muted second line, one primary button and a ⋯ menu. The second line reads "Clears N alerts on M orders" (singular variants `am.fix_clears_one*`), then optional clauses: the **confidence clause** "Confidence before → after" only when the item was replayed (`method === 'replay'`), is not a `requiresMinutes` item and the after-score differs from the before-score; **a lower after-score is shown too** (D9), with its delta in the error colour; "no headroom" for an optimize-window with no free hours; "N alerts remain" after a fix was attempted from the page. A `requiresMinutes` row shows an inline "Setup minutes" box and a Replay button instead of a prediction. Free hours and the setup-tracking-off note are in the row tooltip.
- **One primary action, the rest in the ⋯ menu.** `levActions` returns `{ primary, menu }`. For an admin-only fix viewed by a non-admin the primary is "Copy summary for owner" and the admin deep link (tagged "admin fix") moves to the head of the menu. Menu items run through the same `_onLevAction` as the buttons.

### Groups and rows

- *Superseded by rev 3 (2026-10-20) — see below: "the whole group" is now the whole group of the narrowed set; every group action acts on what the Overview band's narrow leaves.* **Group head** (`.am-ghead`, 36 px): the caret and severity glyph with the label and the error/warning count badges (one toggle button), then **Move N orders** and a ⋯ menu. No totals block and no column-caption row any more. "Move N orders" shows at 2 or more movable orders; the movable types are `overlap`, `blackout`, `tool-conflict` (`MOVABLE_ALERT_TYPES`) and N counts **distinct orders**, not alerts (`groupCounts.movableOrders`). The ⋯ menu offers Go to (the first alert that can), Move N orders (also for a single order), "Open these N orders in the table", and "Acknowledge N…" (the group's not-yet-acknowledged alerts, the whole group and not only the rendered rows).
- *Superseded by rev 3 (2026-10-20) — see below: "each movable alert of the whole group" now means the narrowed set's group.* **Move N orders algorithm.** Blocked under What-If. Above 5 orders (`GROUP_MOVE_CONFIRM_ABOVE`) it asks first. It then runs `Alerts.applyFix(id, { quiet: true })` on each movable alert of the whole group in list order, skipping an alert that has left `Store.alerts` and any alert whose `taskId` or `peerId` names an order already moved (that alert describes a position that no longer exists). An order counts as moved when its alert id has left `Store.alerts` after the fix. The loop runs in try/catch/finally: an error shows one error toast, and the finally always shows one summary toast ("N orders moved", a warning when 0), repaints and focuses the group head. Undo is one entry per order and `UndoStack.MAX = 10` keeps only the last 10, so the confirm text (`am.group_fix_confirm`) says "Undo keeps the last 10 moves" rather than promising every move can be undone (see Deferred).
- **Bulk acknowledge.** `AlertAckModal.open({ plant, alertIds })` (title "Acknowledge N alerts", `am.ack_title_n`) calls `AlertAcksClient.acknowledgeMany(plant, ids, reason, until)`, which splits the ids into sequential `/alert-acks/bulk` POSTs of at most 500 (the route's cap), then does one forced refetch and one `_notify`. Each chunk is one transaction with one `admin_audit` row; a failed chunk counts its ids as `failed` and the next chunk still runs (so `am.ack_bulk_partial` is reachable only through chunk failures), and the call throws only when every chunk failed. The ids are sorted before the INSERT so overlapping bulk acks lock rows in one order. A single alert keeps the old one-id path.
- **No Dismiss on this page.** The row dispatcher's vocabulary is `focus | fix | override | diagnose | ack | unack`; `Alerts.dismiss` and the drawer are untouched.
- **Row** (`.am-row`, `ROW_H = 44`, grid `14px minmax(0, 1fr) 240px auto`: glyph, message, when, actions). One line: a severity glyph; a mono prefix then the message `Util.alertMessage`; the "when" column; the actions. The prefix is the non-empty parts of `[line, orderNo]` joined with " · ", minus the part the active grouping already says (the line under Machine, the order under Order) and minus the line when the message already names it (`msgLine`); with nothing left the prefix and its separator are omitted (`rowPrefix`). The headline and the `alert.help.<type>` sentence are in the row tooltip; the message has its own `title`. The **when column is 240 px** on one mono line (a short weekday/day/month label, then "in 3 days" or "N days overdue" in the error colour; the exact date and time are in its tooltip): 170 px was too narrow for any localised overdue string, and the longest measured (Portuguese) is about 238 px. The **actions column is a fixed width** (`.am-acts`: 240 px, 136 px below 1,200 px, `auto` at 720 px and below) so the grid track, and therefore the when column, lines up across every row (a per-row `auto` track had misaligned it). Actions: Go to always, Fix or Override when the alert has one (the label collapses to the glyph below 1,200 px, the `aria-label` and `title` keep the text), and a ⋯ menu (Go to, Fix or Override, Diagnose, Acknowledge… or Remove acknowledgement). Fix and Override are `aria-disabled` with the `am.whatif_blocked` hint under What-If. The inline Diagnose panel keeps its fields and gains the type's help sentence as its first line. The 40-row cap with "Show all N" and the group-by-None `VirtualList` path (`ROW_H` plus `DIAG_H` under an open panel) are unchanged. Below 720 px the when column is hidden.
- **Focus return.** After Fix, Diagnose and Remove acknowledgement the pane repaints and then focuses the row's trigger (found by `data-ovf-key`), else the next row's, else the previous row's, else the group head (the removal waits for its request). Acknowledge and Override first refocus the live trigger, so the modal's own focus return lands on it. The Fix-list ⋯ trigger, "Show 10 more" and the admin disclosure restore focus the same way after their repaint.

### `OverflowMenu` (platform primitive)

`frontend/platform/overflow-menu.mts`: `OverflowMenu.open(anchor, items, opts?: { align?: 'end'; key?: string }) → { close() }`, `closeAll()`, `isOpen()`, `reconcile()`. `MenuItem = { id, label, onSelect, disabled?, checked?, danger?, hint?, data? }` is a discriminated union (a plain item's `onSelect(item)`; a checkbox item's `onSelect(next, item)`); `data` becomes `data-*` attributes (camelCase to kebab-case) so a page's one delegated handler can serve menu items and buttons. The menu is one `div.ovf-menu[role=menu]` at a time, appended to `document.body` and `position: fixed` (z-index 1500); checkbox items are `role=menuitemcheckbox` and stay open. Keys: ArrowUp/Down (wrap, skip disabled), Home/End, Enter/Space, Escape; it closes on outside click, scroll, resize and after a plain select, and focus returns to the anchor (which carries `aria-haspopup` / `aria-expanded`). **The repaint contract:** `open()` writes `data-ovf-key` on the trigger when `opts.key` is given, but a page that replaces its `innerHTML` must also **render `data-ovf-key` in its own trigger templates** (the consumers do: `data-ovf-key` on the row, group, fix and page ⋯ buttons), and must call **`reconcile()` after each repaint**: it closes a menu whose anchor is disconnected and hands focus to the new trigger with the same key. The Alert Monitor calls it as the last step of `_paint`. The pure exports `menuPosition` and `menuKeyNav` are tested without a DOM; the DOM glue is tested with the shared mini-DOM `tests/modules/helpers/dom-stub.mjs`.

### Profile editor

The "Default ranking" select and its draft field are gone. `profileFromDraft(draft, existing?)` sends `ranking: 'impact'` for a new profile and passes an existing profile's `ranking` through unchanged on edit (the server default and its four values are kept; there is no migration). `AlertProfileEditor.open({ plant, profileId?, fromPicker? })`: with `fromPicker`, a successful create makes `AlertProfileMatches.setSessionProfile(newId)` so the page views what was just made (an edit re-selects only when it is the profile the page is viewing). The Edit button and the zero-profiles prompt open it without `fromPicker`. "Use this profile as my default" still takes priority and clears the session override instead.

### Backend: bulk acknowledge

`POST /alert-acks/bulk` `{ plant, alert_ids: [1..500 strings], reason, until? }` → `{ acks, count }`. Same plant check and `require_authenticated` actor as the single route; 400 for an empty, over-long or non-string id list, a missing or over-long reason, or a bad `until`; 403 for a plant outside the user's scope. One transaction: purge the plant's expired acks, upsert every id (duplicates collapse), return the active acks, write one `admin_audit` row (`alert_ack` / `ack`, the deduplicated count and the first 50 ids). The single-ack route and the tables are untouched; no migration.

### Compatibility

- `alertMonitorView` keeps its shape `{ groupBy?, sort? }`. Stored `sort` values `severity` and `orders` are coerced to `impact` **at read time** (`viewFor`); stored data is not migrated and a stored `groupBy` is honoured as-is.
- Profiles keep their `ranking` column and API field; the page no longer shows it and the editor passes it through, so existing `time` profiles still default to the Date sort for a user who has not chosen.
- `Alerts.applyFix` gained only the optional `{ quiet }` flag (it suppresses the movable branch's per-order toasts); existing callers are unchanged.

### Removed locale keys

37 keys were deleted from all five locales and from the completeness test's key list after a per-key consumer grep found none: `am.col_points`, `am.col_orders`, `am.col_late`, `am.points_outside`, `am.points_outside_tip`, `am.lev_points`, `am.lev_score`, `am.lev_score_capped`, `am.lev_method_exact`, `am.lev_method_estimate`, `am.lev_outside_window`, `am.lev_partial_window`, `am.lev_conf_na`, `am.lev_conf`, `am.lev_alerts`, `am.lev_show_more`, `am.lev_needs_minutes`, `am.lev_minutes_ph`, `am.sort_severity`, `am.sort_orders`, `am.kpi_matched`, `am.kpi_matched_of`, `am.kpi_errors`, `am.kpi_warnings`, `am.kpi_orders`, `am.kpi_confidence`, `am.kpi_confidence_sub`, `am.profile_label`, `am.sort`, `am.leverage_title`, `am.leverage_hint`, `am.day_rel`, `ape.ranking`, `am.make_default`, `am.manage_profiles`, `am.group_dismiss_n`, `am.group_dismiss_confirm`. **`am.window_all` was kept** (it was on the planned list): `windowSummary` still returns it for the All alerts option (the picker's muted second line and `aria-description`), and its value passes the vocabulary gate. Added after the final review: `am.group_fix_n_one` ("Move 1 order") and `am.lev_remaining_one`; `am.group_fix_confirm` was reworded ("Undo keeps the last 10 moves"). Added: 38 `am.*` keys for the new header, fix list and bulk acknowledge, three singular summary leads (`am.summary_window_one`, `am.summary_profile_one`, `am.summary_all_one`), and rewords of `am.sort_impact` (Priority), `am.sort_time` (Date) and `am.group_by`.

### Deferred (rev 2)

`am.profile_missing` toast still unwired (a v1 gap); Diagnose for line/day alerts remains a cell jump; virtualising the fix list beyond 50; per-user column/density preferences; a German wording review of the whole `am.*` set (owner-owed); a "N dismissed in the drawer · Restore" note on the monitor (alerts dismissed or fixed in the drawer are absent here with no explanation); a single undo entry for "Move N orders" (currently one per order, and only the last 10 stay undoable because of `UndoStack.MAX`); "new since your last visit" (needs a persisted per-user seen-set).

Review-deferred minors still open after the rev-2 fix wave (none changes a settled decision):

- Enter in the profile picker with no matches is inert until ArrowDown (`_comboActive` is -1).
- Focus mode states its text twice: the summary lead is replaced by the chip text and the chip below renders it again; "Showing 1 alerts for" (`am.focus_chip`) and "Show all" have no singular form.
- A sticky session override survives a self-edit in the profile editor; Duplicate resets the ranking to impact; the editor hand-back has test gaps.
- A `title` tooltip on the fix row shadows the anchor tooltip (T23 M2); a Replay with nothing to replay is a silent no-op (T23 M5).
- The vocabulary test is English-only, and the builder "never says points" tests use a key-echo `t`, so only the locale gate really protects the wording (T23 M7, final M13).
- The partial-ack path (`am.ack_bulk_partial`) is reachable only through chunk failures; the bulk route still has no per-id length bound and does not check ids against the plant (as the single route); the past-`until`, duplicate-id, purge and audit-cap cases have no tests.
- The summary's confidence can lag the badge by a point (`Confidence._recomputeDebounced` is 400 ms, the pane paints at 150 ms and has no hook on score changes).
- "Move N orders": per-id `Store.alerts` scans, one synchronous `alerts:change` and `Engine.autoReflow` per order, silent refusals (firmed, no slot) so "0 orders moved" gives no cause, and `_moveGroup` is re-entrant while its confirm is pending (no `_moving` guard).
- Row-menu Diagnose on a line or day alert moves focus back to the ⋯ trigger after opening the cell briefing; three copies of "find the trigger by key and focus it" (`_refocusKey`, `OverflowMenu.reconcile`, the head/show-more focus helpers) may drift.
- Browser checks owed to the owner (the browser QA pass was skipped by ruling): the new header at 1,024 px in fr/pt, the 1,200 px breakpoint, dark mode, ⋯ menu placement, and the pinned "+ New profile…" footer inside the picker. Browser checks of the new header, 44 px rows and ⋯ menu placement (fr/pt at 1,024 px, the 1,200 px breakpoint, dark mode) are still owed to the manual QA pass.

## Overview band — rev 3 (2026-10-20)

Written after the band shipped on `feature/alert-monitor` (Tasks 28-31, commits bcad30f through 63dd623). The owner liked rev 2 and asked for "interactive cards or visuals or charts ... a pop of display and charting". Rev 2 removed KPI number tiles (U1), so the visuals are **filters you can see**: every bar is a button that narrows the list below it. No chart library is loaded; the band is DOM bars, CSS grid and two small SVGs (the gauge and the sparkline). Backend, profile matching, the leverage engine, acknowledgements, the Gantt, the bell/drawer/Dashboard, the summary line, Top fixes content and ranking, and the groups/rows markup are unchanged; the pref is one more settings-blob key, so there is no route or migration.

### Owner decisions (settled; don't re-ask)

| # | Decision | Answer |
|---|---|---|
| V1 | Visuals | **All four**: When (horizon bars), Where (machine bars), What (category strip and legend), Confidence (dial, session trend, top-fix marker). **Superseded (2026-10-20, see "Overview band - rev-3 follow-up" at the end): the Confidence card is removed; three panels remain.** |
| V2 | Placement | A **collapsible band** under the controls row, above Top fixes; the collapse state is remembered per user (`alertMonitorOverview`: `'collapsed'`, anything else open). |
| V3 | Click | **Narrows the list with a chip** ("Showing 9 of 42", one removable chip per dimension, plus Clear); AND across the three dimensions; clicking the selected bar again clears it; group-by is untouched; non-selected bars dim. |
| V4 | Data scope | **The alerts the page lists** (viewed profile, minus acknowledged unless shown; the focus set in focus mode), counted **before** narrowing so the other bars stay clickable. The summary line is unchanged and Top fixes stay plant-wide (D10). |

The Confidence dial is a gauge sitting next to filters, not a KPI tile, so U1 stands.

### The four visuals

Built by the pure module `frontend/alert-monitor/alert-monitor-overview.mts` (no DOM, no Store; translation and date formatting are injected through `OverviewViewDeps`); the pane wires it.

- **When.** One column per plant day from today, between an Overdue bucket and a Later bucket. The column count is the alert horizon in days widened to cover the profile window, clamped to 1-60 (`horizonDays`); day keys come from `plantToday + offset` (local-date construction, so daylight-saving safe) via the exported `dayKeyOf`. A bar stacks warnings on top of errors, its height is relative to the tallest day (the buckets use `min(100, ...)` of it), and a day with none is a disabled 2 px stub. The profile's day window is a shaded band behind the columns, clamped to the rendered columns (nothing is shaded for an empty window). Tick labels sit every 7 columns up to 28 columns and every 14 above; the date is also in each bar's `title` / `aria-label`. A Today line and label mark column 0.
- **Where.** One row per line (key `a.line || 'none'`, shown as "Unassigned"), sorted by alert count then name, an error/warning two-colour track, the count and an overload dot when the line has an `overload` alert. The top 8 show; "+N more" expands to at most 24 (`OV_LINES_TOP`, `OV_LINES_MAX`); a selected line outside the shown rows stays pinned so it is never hidden.
- **What.** A proportional strip of the five alert categories (`categoryOf`: capacity, conflicts, calendar, setup, exceptions; fills `--bar-pm-*`) and a legend of all five, zeros shown but disabled. The strip is `aria-hidden` and out of the tab order; the legend rows are the accessible path.
- **Confidence.** A gauge of the plant confidence (tier colours at 60 and 40, the same tiers as the breakdown), a **ghost marker** for the first fix in the viewer's main Top fixes list (`ghost: number | null`, the already-rounded after-score; only for a replayed fix that is not `requiresMinutes` and whose rounded score differs; a lower score is shown too), and a sparkline of the session history (`NIMBUS.Confidence._history`, bucket-averaged to at most 40 points, nothing under two points). The whole panel is one button that opens the Confidence breakdown. A null score omits the panel (no "not computed" key); the grid then drops to three columns.

When the band is collapsed the header shows one strip line ("Alerts N · Overdue M") and the body is `hidden`.

### Narrowing semantics

- `Narrow = { day?, line?, category? }` is **transient pane state** (`_narrow`): never persisted, never a Store event, never in `_gatherState` (the band is paint-only). It resets on a plant change, on a change of viewed profile, and on `setFocus` / `clearFocus`. It **survives a paint where the band is hidden** (any empty state) and is re-pruned on the next non-empty paint, so a transient empty list does not lose it; `pruneNarrow` drops any dimension whose value has no alerts in the unnarrowed set.
- The visuals count the **unnarrowed** listed set (V4). Top fixes ignore the narrow. The summary line, banner and focus chip keep `s.listed`.
- A day narrow takes a day key, `overdue` or `later`. **Undated alerts** (no due date and no time) count in the total, Where and What, never in When, and any day narrow excludes them.
- **Group actions act on the narrowed set.** `_renderGroups` sorts and groups the narrowed list, so a group head's "Move N orders", "Acknowledge N...", Go to, "Open these N orders in the table" and the ⋯ menus all work on what the rows show; a narrow that leaves nothing tears down the VirtualList, clears the group map and writes `am.ov_narrow_empty` into `#am-groups` (the chip row carries Clear). With a day narrow and Group by Day the result is one group; no special case.
- Controls: `data-am-narrow="dim:value"` (split at the first colon, a line name may contain colons) on every bar and legend row; chip removal `data-am-narrow-clear`; actions `ov-toggle`, `ov-lines-more`, `ov-conf`, `clear-narrow`. After a click the pane repaints and refocuses the control that took its place, found by attribute match over the live nodes (never an attribute selector; a line name may contain spaces or quotes): the same bar, else the chip's Clear, else the band toggle; a bar inside a hidden ancestor or an `aria-hidden="true"` ancestor (the What strip) is skipped, so a category click lands on the legend row. A band repaint that is not a click keeps focus on the same `data-am-narrow` / `data-am-action` control when focus was inside the band. Every `data-am-narrow` control carries `aria-pressed="true"` (selected) or `"false"`; the disabled zero-count stubs and zero legend rows carry none. The "Showing n of N" announcement comes from a persistent visually hidden live region in the shell (`#am-narrow-status`, `.am-sr-only`, `role=status`), not from the chip row. Under a focus set the band has no profile-window shading (`window: null`).

### Rulings (orchestrator, 2026-10-20)

1. Undated alerts: counted in the total, Where and What; absent from When; excluded by any day narrow. No hint.
2. *Superseded by the rev-3 fix wave: a per-call memo now exists.* The first ruling was "no memo", from a bench with a stubbed due path (6.2 ms). The real-path bench (`NIMBUS_BENCH=1`, real `Util.dueInstant` and compute core, 15,000 alerts over 70 lines, 3,000 tasks) measured `overviewData` at 46 ms, so `overviewData` and `applyNarrow` each build a per-call `Map<task, due>` (`_memoAnchor`): `overviewData` about 18-21 ms, `applyNarrow` about 1 ms for three dimensions and about 8 ms for a day alone (was 23 ms). `_setHtml` also skips unchanged HTML.
3. The visuals follow the viewed profile (V4); Overdue and Later may look large under All alerts and that is accepted.
4. Odd windows (`from` at or beyond the column count, or `to` below 0): the shading clamps to the rendered columns; nothing is shaded if empty.
5. Up to 60 day columns (about 5 px bars at 1,024 px) are accepted.
6. **Wrap is a container query on the band, not the viewport.** `.am-overview` is `container: am-ov / inline-size`; the band drops to two columns under 936 px of band width (When and Confidence span both, Confidence centred) and one column under 560 px. The 936 px figure is the four-column grid (`minmax(300px, 1fr) 230px 220px 150px` plus three 12 px gaps); a 900 px viewport has about 852 px of content, so the planned 900 px viewport breakpoint would have overflowed. The When columns are equal width (CSS cannot give the two buckets a fixed 64 px because the markup emits only `--cols`).
7. The category strip is `aria-hidden` and out of the tab order; the legend is the accessible path.
8. Group actions follow the narrowed set (above).

### Width budget (content 976 px at a 1,024 px viewport)

Measured by character-count figures only (10 px mono caps with tracking about 6.4 px per character, 11 px sans about 6 px per character); no browser was available. At 1,024 the grid is When 340, Where 230, What 220, Confidence 150 (When inner 314; a 14-day chart column about 19.6 px). The What legend name column is 144 px (194 inner, minus 8 row padding, 8 swatch, two 6 px gaps and a 22 px count minimum). Every longest string fits except Spanish (about 156 px) and French (about 150 px) category names, which ellipsize; Portuguese (about 144 px) is borderline. The `title` carries the full name. Width-critical translations: de Overdue "Überfällig" (64 px of the 64 budget), fr Today "Aujourd’hui", fr Later "Plus tard", de "+N weitere", eyebrows of 9 characters in de/es/fr/pt.

### Styling and accessibility

Tokens only (`--err`, `--warn`, `--bar-pm-*` with `-fg`, `--accent-wash`, `--bg-elev`, `--line`); hairline borders; no gradients, side stripes or glass; transitions only `var(--t-fast)` on opacity/background, none under reduced motion. The four panels are separate bordered cards (`div.am-ov-panel`, not a `.panel`). No ancestor of the bars clips: the four panels are `div.am-ov-panel` inside `section.am-overview`, neither of which carries `.panel` or any `overflow` rule (`.am-scroll`, the page scroller, is `overflow: auto`). Selection and focus outlines are still inset (`outline-offset: -2px`) so they never bleed past the bar edges. The profile-window band is absolutely positioned inside the chart (out of the grid flow), its left and width computed from `--c1`, `--c2` and `--cols`. Every `data-am-narrow` control carries `aria-pressed="true"` when selected and `"false"` otherwise (the disabled zero stubs and zero legend rows carry none), replacing the earlier "only on the selected control". The Confidence dial's `aria-label` (and the button `title`) include the ghost text when a ghost is present. Stacking is `.am-ov-bar { display: flex; flex-direction: column }` (the markup emits warn before err, so errors sit at the base; never `column-reverse`). The in-segment category count hides under 22 px by a container query on the segment. Contrast of each `-fg` on its fill in dark mode is 4.73:1 or better, so no token changed.

### Tests

`tests/modules/alert-monitor/`: `alert-monitor-overview.test.mjs` (data, narrowing, SVG math, builders), `alert-monitor-overview-pane.test.mjs` (wiring, chip, focus, group actions on the narrowed set, ghost and history), `alert-monitor-overview-css.test.mjs` (a static gate over the `.am-ov*` block of `styles.css`: tokens only, every emitted class styled, container breakpoints), and the `[bench]` line in `alert-monitor-bench.test.mjs`. 27 `am.ov_*` keys in all five locales.

### Narrow visibility fix (2026-10-20)

A browser check showed a chart click narrowed the list but the chip and list sat about 400 px below the fold, so nothing appeared to happen. Fixed: `#am-narrow-chip` moved into the sticky `.am-head` controls row beside Group by / Sort by (`.am-controls .am-narrow-chip`, flex, wraps, pills still truncate at 240 px); a click that activates a narrow (not one that clears) calls `#am-groups.scrollIntoView({block: 'nearest'})`, `behavior: 'auto'` under `prefers-reduced-motion`, with `preventScroll` on the refocus so focus is not stolen; the What stripe segments are now keyboard-operable buttons (no `tabindex=-1`, strip no longer `aria-hidden`, `role=group` labelled "What"), refocus lands on the same kind of control (segment or legend row) that took the click. Top fixes stays plant-wide. Browser check still owed: chip fit at 1,024 px in de/es/fr/pt, scroll feel, duplicate tab stops (strip plus legend) for category.

### Deferred (rev 3, with the rev-2 list standing)

Weekly aggregation above 28 day columns; narrowing by order; persisted narrow state; a Where split by category colour instead of severity; the rev-2 deferred list.

Review-deferred minors still open:

- Resolved in the fix wave: the shared exported predicate `fixConfidenceChanged` (model) now serves both `fixLineParts` and the dial ghost (`_confGhost`), comparing rounded scores, so a fractional-only change (70.6 to 71.4) shows no clause on either.
- The `_levRun` test proves "no repaint", not "`overviewData` uncalled" (a structural guarantee is deferred).
- fr "Plus tard" could collide with the last day tick label on long horizons; the Later tick label is now hidden at 21 or more day columns by a `:has(> :nth-child(21))` rule (it keeps its `title` and `aria-label`). The browser check of the other column counts remains owed.
- What legend name column: 144 px; es (about 156 px) and fr (about 150 px) names ellipsize and pt is borderline (the `title` carries the full name).
- Where name column against real machine names (owner browser check).
- de `am.ov_strip` "Warnungen" ambiguity and pt "Atrasados" gender (owner language review).
- Roving tabindex and arrow keys for the day bars, and `role=group` labels on the panels.
- Real-browser check of duplicate-control refocus (the mini-DOM never parses `innerHTML`, so the pane tests use hand-built nodes).
- `overviewData` Date allocation in the day binning (about 19 ms at 15k alerts, noisy run to run): a future optimisation.
- The Confidence panel does not repaint itself when `_history` grows between paints; it picks the new points up on the next paint.
- Five emitted hook classes have no rule of their own (`am-ov-what`, `am-ov-col-overdue`, `am-ov-col-later`, `am-ov-bucket`, `is-today`); the gate test lists them.
- **No browser pass was run by the agents** (owner-owed, as in rev 2): tick collision on long horizons, `container-type` on a `<button>`, band/bar alignment, Today label clearance, the 936 and 560 px wraps, de/es/fr/pt widths at 1,024 px, dark mode.

## Overview band - rev-3 follow-up (2026-10-20): drop the Confidence card, fill the When chart, label every day

Owner screenshots showed the When bars using about 45 percent of the card height and the Confidence card mostly empty. The card repeated the plant confidence already shown by the header "Plant confidence N" link and the top-bar chip (all three opened the same breakdown); its only extras were a session sparkline (a flat line while the score is unchanged) and the top-fix "ghost" marker.

### Owner decisions (settled; don't re-ask)

| # | Decision | Answer |
|---|---|---|
| F1 | Confidence card | **Removed. Supersedes V1.** The header "Plant confidence N" link (`am-summary-conf`) and the top-bar chip stay; `NIMBUS.Confidence._history` stays (the top bar uses it). |
| F2 | Top-fix ghost marker | **Dropped with the card** (`_confGhost`, `am.ov_conf_after*`). The Top fixes section remains the place for "Confidence 71 -> 78". |
| F3 | When bars | **Grow to fill the card height** (a flexible chart row, 84 px of bar at the least; the card is as tall as the Where panel). |
| F4 | Day labels | **Every day bar except Later is labelled**: short weekday over day-of-month number, the month on the first label and where it changes; today emphasised; Overdue and Later keep their bucket labels. |

### What changed

- Grid: `minmax(300px, 1fr) 230px 220px`, two columns below 936 px of band width and one below 560 px (unchanged breakpoints, re-derived: 936 is where the When chart is 436 px wide, 936 - 230 - 220 - 24 - 26; below it When takes a full row, so its chart is 500 px or wider again). The 774 px three-column minimum was rejected: it would leave a 274 px chart.
- `confidenceHtml`, the arc / sparkline math (`arcPoint`, `arcPath`, `arcTick`, `confTier`, `sparkPath`), the `ov-conf` action and `DayBar.labelTick` are deleted; `OverviewViewDeps.fmtTick` now returns `{wd, day, mo}`.
- Tick markup: `span.am-ov-tick.am-ov-tick-day` holds `.am-ov-wd`, `.am-ov-dn`, `.am-ov-mo`; a bucket tick holds `.am-ov-bl` on a fourth grid row that no day label ever uses, so Overdue (left-aligned, running right) and Later (right-aligned, running left) cannot collide with a day label whatever the language.
- Thinning: `tickStride(cols) = ceil(15 x cols / 436)` (1 up to 29 columns, 2 up to 58, 3 beyond), exported with its two constants; skipped columns keep an empty tick so the grid stays aligned. The first label drops its month when the next label is a month change (no "Oct" touching "Nov").
- The weekday hides itself by CSS when one label's slot is under 26 px (`font-size: clamp(0px, calc((100cqw * var(--s) / var(--cols) - 26px) * 1000), 10px)` on a `container-type: inline-size` ticks row), leaving the day number.

### Measurements the label format rests on (JetBrains Mono, 10 px, 0.6 em advance; a live-DOM prototype of the real markup and `styles.css` over 5 languages, 58 cases)

- Day number, two digits: 12.8 px. Weekday at 10 px: 18 px for a 3-character name (en, es "mié"), 12 px for de, **24 px for the fr / pt 4-character names ("lun.", "seg.")**. Month ("janv." the widest): 30 px, shown on at most two labels that are never adjacent.
- Bucket labels at 10 px uppercase with letter-spacing: Overdue 44.8 (en), 64 (de "Überfällig"), 51.2 (es), 57.6 (fr and pt); Later 32 (en), 38.4 (de, pt), 44.8 (es), 57.6 (fr). A cell is 37.6 px at 16 days in a 677 px chart, so every bucket label overflows its cell; the fourth row is what makes that safe. Overdue plus Later together (at most about 120 px) fit any chart of 436 px or more.
- Chart width and cell width: 1,176 px band (1,280 viewport) chart 677 px: 16 days 37.6 px, 21 days 29.4 px, 60 days 10.9 px (stride 3, so 32.7 px of slot). 936 px band: chart 437 px, 16 days 24.3 px (weekday hidden, day numbers only). 1,000 px band: 501 px, 21 days 21.8 px (weekday hidden), fr 16 days 27.8 px (weekday shown). 560 px band: chart 535 px, 16 days 29.7 px, 21 days 23.3 px (weekday hidden), 30 days stride 2.
- Bars: at a 1,176 px band with the Where panel at 8 rows the chart is 147 px tall and the tallest bar 133 px (was fixed at 84 px); percentage bar heights resolve against the flex-sized grid track in Chrome. In the 560-935 px two-column layout the When card is not stretched by Where, so the chart keeps its 98 px floor (84 px of bar).
- Collision / overflow check in the prototype (every visible label's text range against every other, and against the chart edges): zero overlaps and zero labels outside the chart in all 58 cases, including Today on the 31st (month names Oct / Nov adjacent) and a 30 Jan / 30 Dec start.

### Deferred / not done

- `am.ov_conf`, `am.ov_conf_aria`, `am.ov_conf_after`, `am.ov_conf_after_aria` stay in the five locale files (and in the locale-completeness required list) as unused keys; removing them is a mechanical follow-up.
- The weekday visibility threshold is language-agnostic (26 px covers the 24 px fr / pt names); an en / de / es-only threshold of about 20 px would keep weekdays on at the 936-1,000 px widths.
- Browser checks owed on the real page (the prototype used synthetic alerts and the real CSS): the band in the live app at 1,280 / 1,024 / 900 px, dark mode, and the header "Plant confidence" link and top-bar chip still opening the breakdown (their code is untouched).
- The stride assumes a 436 px chart; between 560 and 935 px band width a 62-column chart (535 px at the narrowest) is always wider than that, so only the three-column band sets the floor.
