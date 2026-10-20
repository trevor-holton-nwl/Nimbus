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
| D7 | Fix from the monitor | Reuse the drawer's actions (Fix: overlap/blackout/overload/tool-conflict; Override: closed/firmed-*; Go To; Dismiss) plus one deep-link action per leverage family. *(my call)* |
| D8 | Fill colour | Amber (`--warn-vivid` #f39c12 / dark #e0a018) with dark-navy text and a 2 px inner ring (red = error, amber = warning). Reason: bars are **not** line-coloured today — standard = blue, firmed = red — so a red fill would masquerade as firmed and the soft tints fail contrast under white labels. *(my call; the only free hue in the bar vocabulary)* |
| D10 | Leverage scope | **All plant alerts**, regardless of the active profile (confidence is plant-level, so the ROI is only meaningful plant-wide). "Show alerts" on a card temporarily bypasses the profile; the focus chip says so. |
| D11 | Profile reach | The active profile **also filters the alert bell count and the drawer** (and the Dashboard alert summary, which shares the same filter). `'__all__'` = unchanged behaviour. The Gantt's red `conflict-order` outline and alert day-cells stay plant-wide so a critical alert is never invisible on the timeline. Drawer footer shows "N hidden by profile X · Show all" as a session override. |
| D12 | Headline ranking metric | **Uncapped impact points** (Σ cleared alerts' base × time weight; error 5 / warning 2; ×1.5 ≤3 d, ×1.25 ≤7 d). Never saturates. The capped score change is shown second ("71 → 78" or "score unchanged — plant is above the 50-point cap"); orders affected is the tie-break. |
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

**Layout** (`#alerts-tab`, shell filled once by `_ensureShell()`): toolbar → KPI strip → scrollable body (`#am-scroll`).

- **Toolbar**: Mono-Eyebrow "PROFILE" + searchable combobox (`.us-combo` pattern copied from `_initDefaultPlantCombo`, shell 712-778; options: All alerts, then the plant's profiles) → writes `alertProfileByPlant`; mono window summary of the active rules; "Manage profiles…" button (opens editor); Gantt-highlight toggle; `seg-btn` group-by (type / machine / day / order / none); sort select (impact / soonest / severity / order); plant badge. `flex-wrap`, wraps below ~1,100 px; min viewport 1,024 px.
- **KPI strip**: five `.kpi-tile` buttons — Matched alerts (`.d` "of N in horizon"), Errors (`.err` when >0), Warnings (`.warn`), Orders affected, Confidence now (click → `Confidence.showBreakdown()`; `.d` "N alerts inside the confidence window"). Tile min 160 px (pt eyebrow "ALERTAS CORRESPONDENTES" ≈ 143 px).
- **High-leverage fixes** panel: top 5 `.am-lev-card`s (expand to the cap), each: family badge, title (`leverage.title.<family>` with vars), mono "N alerts · M orders", confidence `71 → 78` in Mono-KPI with `+7` in `--ok` (or `n/a` + `am.lev_outside_window`; `am.lev_partial_window` when some are outside), method eyebrow, actions: family primary (`.btn-primary.sm`) + "Show alerts" (filters the groups below, shows a focus chip). Skeleton while computing; `am.lev_none` empty copy.
- **Groups**: one `.am-group` card per group (head = `<button aria-expanded>`: sev glyph, label, `badge-err/-warn` counts, mono impact, caret; head actions Go To first / Dismiss N with `Modal.confirm` when N>5). Body: first 40 rows + "Show all N" (no nested virtual scrollers); group-by none → one `VirtualList` (`rowH 56`). Collapse state resets on plant change.
- **Row** (`.am-row`, 56 px, grid `14px minmax(0,1fr) 150px minmax(220px,auto)`): sev glyph · headline (`AlertsUIAdapter.headlineFor`) + message (`Util.alertMessage`, ellipsis + title) · mono meta (order, line, `D+n`) · actions: Go To (ghost), one primary (Fix for fixable types / Override for closed-family with taskId), Dismiss as an `.icon-btn.sm ×`. Same `data-alert-action` vocabulary as the drawer (`focus|fix|override|dismiss`), dispatcher mirrors `_handleAction` (`insights-ui.mts:1253-1280`). Fix/Override disabled with `am.whatif_blocked` while `Sandbox.active`. Width budget: de "📅 Überschreiben" ≈ 128 px + Go to ≈ 70 + icon 24 + gaps → 220 px.
- **Empty states** (`.empty-state`): no plant; profile matched nothing (+ "Show all alerts" button); no alerts at all (`empty.no_active_alerts`).
- **CSS**: new "ALERT MONITOR" block in `styles.css`, `am-`/`ape-` prefixes, tokens only, hairlines, KPI top-border only, no side stripes, no hardcoded colours (so no `body.dark` block except the two new bar tokens).

**Profile editor** (`#modal-alert-profile`, static shell beside `#modal-user-settings`; body/foot rendered at runtime with inline `Util.t`): left rail = the plant's profiles + "New profile"; right form = Name (≤60), rules list (per rule: five category groups with indeterminate header checkbox + type checkboxes named via `headlineFor`; "From day"/"To day" `type=number min=-365 max=365 step=1` (blank = any; negative = days overdue; plain day offsets, not dates, so no Flatpickr; hint `ape.days_hint`); min severity select; remove), "+ Add rule", default ranking select, "Use this profile for plant X" toggle. Footer: Delete (only when creator/admin, `Modal.confirm({tone:'danger'})`), Cancel, Save. Inline `.ape-err` messages from `validateProfile`; server 409 mapped to `ape.err_name_dup` / `ape.err_stale`. Never opened from inside User Settings (single central focus trap).

**User Settings** (workflow pane, `_renderWorkflowPane` 780-876): "Alert profile for plant {{plant}}" combobox (readonly hint when no plant selected) + ghost "Open Alert Monitor" (closes the modal, `App.goto('alerts')`); "Highlight profile matches on the Gantt" toggle.

**Clarity amendments (audit 2026-10-20):**
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
- **C / C2 / C3. Leverage, optimizer cards, acknowledge.** `alert-leverage.mts` (six families, replay through a new worker `LEVERAGE_BATCH` message with a 30 s main-thread fallback), confidence scoring extracted to `nimbus-compute-core.js` (`scoreConfidence`, `alertPoints`, `CONFIDENCE_WEIGHTS`; `Confidence` now calls it), the "Optimize this window" card through `OptimizeDialog.open(prefill)`, and the acknowledge/snooze modal.
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
