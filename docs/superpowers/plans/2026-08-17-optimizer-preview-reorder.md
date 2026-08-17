# Optimizer Preview Reorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorder `OptimizerPreview._render()`'s modal body to verdict + KPI cards first, then three collapsed sections (Why this candidate / Missing setup times / Search diagnostics) at the bottom; delete the duplicate "Candidate explanation" impact grid; move hardcoded English into `en.js`; drop the count-up animation; make Apply's disabled state derive from `canApply()` everywhere instead of ad hoc DOM pokes; and fix `var(--danger)` → `var(--err)`.

**Architecture:** All changes are localized to `OptimizerPreview` in `web/schedule-workbench.mts` (the `_render()` method and its three small siblings `showLoading`/`hideLoading`/`markSetupStale`), plus `web/locales/en.js` for extracted strings. No engine or `CandidateResult` changes are needed for the verdict banner, KPI cards, "Missing setup times", or "Search diagnostics" sections — those already have backing data (`SearchDiagnostics`, `MissingSetupEdge` in `web/setup-scheduler.mts`). The mockup's runner-up/plan-comparison table ("Why this candidate" 's Current/Applied/Alt B/Alt C columns with pruned-by-reason counts) has **no backing data today** — `CandidateResult` (`web/setup-scheduler.mts:393-402`) carries only the single applied candidate, not runner-up finalists or a pruned-by-reason breakdown. Per the user's explicit instruction, this plan builds the "Why this candidate" section's skeleton using data that already exists (the existing reasons/impact summary) and explicitly does **not** attempt the multi-column comparison table or prune-reason bars, since that requires engine work out of this plan's scope.

**Tech Stack:** TypeScript (`.mts`, compiled by `tsc`), vanilla-JS IIFE module (`OptimizerPreview` object literal), existing `.opt-pv-*` CSS in `web/index.html`.

**Spec:** `Optimizer Preview Redesign.dc.html` (visual/interaction target — a throwaway prototype; do not copy its markup or its `support.js` runtime). This plan's code is authored directly against the real `OptimizerPreview` module read at `web/schedule-workbench.mts:7439-8118`.

## Global Constraints

- Keep the verdict banner and KPI cards **exactly as they are today** (markup, classes, computation) — only their position in the DOM moves.
- `OptimizerPreview.canApply()` (`web/schedule-workbench.mts:7598`) is the **single source of truth** for whether Apply is clickable. Every place that currently disables/enables the Apply button directly (`markSetupStale`'s `.modal-foot .btn-primary` query, `hideLoading`'s blanket re-enable of all `.modal-foot button`, `runWithPreview`'s `footBtns.forEach(b => b.disabled = false)`) must instead call one shared helper that reads `canApply()`.
- All new/extracted strings go through `Util.t()` / `web/locales/en.js`.
- `var(--danger, #c0392b)` → `var(--err)` (the token already used everywhere else in this module's CSS, e.g. `.opt-pv-verdict-worse::before { background: var(--err); }` at `web/index.html:570`).
- The root-level scratch files (`Optimizer Preview Redesign.dc.html`, and the unrelated `plant-and-administration.mts`/`en.js`/`styles.css` copies from the paired Setup Matrix task) are prototype/reference material only — never copy their markup, only their visual/interaction intent.

---

### Task 1: Centralize Apply's enabled state on `canApply()`

**Files:**
- Modify: `web/schedule-workbench.mts` (`showLoading` at line 7511, `hideLoading` at 7531, `markSetupStale` at 7602, `runWithPreview` at 7629)
- Modify: `web/index.html` (add an `id` to the Apply button, line 2575)

**Interfaces:**
- Produces: `OptimizerPreview._syncApplyButton(): void` — reads `OptimizerPreview.canApply()` and sets the Apply button's `disabled`/`title` accordingly. Every other function that touches Apply's enabled state calls this instead of setting `disabled` itself.
- Consumes: `OptimizerPreview.canApply()` (unchanged, line 7598), `OptimizerPreview.stale`, `OptimizerPreview._staleReason`.

This directly fixes the two named bugs: (1) `markSetupStale` today pokes `.modal-foot .btn-primary` — fragile selector coupling and duplicate disabled-state logic; (2) `hideLoading` unconditionally re-enables every `.modal-foot` button, which would wrongly re-enable Apply if called while `stale` is true. Centralizing on `canApply()` makes both impossible by construction.

- [ ] **Step 1: Add the `id` to the Apply button**

In `web/index.html` at line 2575:

```html
      <button class="btn btn-primary" id="opt-preview-apply-btn" onclick="NIMBUS.OptimizerPreview.apply()">✓ Apply changes</button>
```

- [ ] **Step 2: Add `_syncApplyButton` to `OptimizerPreview`**

In `web/schedule-workbench.mts`, add near `canApply()` (line 7598):

```typescript
  /** Single place that decides whether Apply is clickable — always derived
   *  from canApply(), never poked ad hoc. Replaces three separate direct-DOM
   *  writers (showLoading's blanket disable, hideLoading's blanket enable,
   *  markSetupStale's manual disable) that could disagree with each other. */
  _syncApplyButton(): void {
    const button = typeof document === 'undefined' ? null : document.getElementById('opt-preview-apply-btn') as HTMLButtonElement | null;
    if (!button) return;
    const applyable = OptimizerPreview.canApply();
    button.disabled = !applyable;
    button.title = applyable ? '' : (OptimizerPreview.stale
      ? Util.t('ui.setup_preview_apply_stale_title')
      : Util.t('ui.setup_preview_apply_not_ready_title'));
  },
```

- [ ] **Step 3: Replace the three direct writers**

`showLoading` (line 7511-7527) — the loop that disables every `.modal-foot button` stays for Discard too (both buttons should be disabled while loading), but drop the manual Apply special-casing since `_syncApplyButton` will be called right after loading completes or fails:

Keep `showLoading` as-is (it disables both buttons during the loading skeleton, which is correct — nothing is applyable yet).

`hideLoading` (line 7531-7535) — replace:

```typescript
  hideLoading() {
    Modal.close('modal-opt-preview');
    const root = typeof document === 'undefined' ? null : document.getElementById('modal-opt-preview');
    if (root) root.querySelectorAll<HTMLButtonElement>('.modal-foot .btn-ghost').forEach((b) => { b.disabled = false; });
    OptimizerPreview._syncApplyButton();
  },
```

(Discard is unconditionally safe to re-enable — it only reads `.btn-ghost` now, leaving Apply's state to `_syncApplyButton`.)

`markSetupStale` (line 7602-7610) — replace:

```typescript
  markSetupStale(plant: string, kind: string): void {
    if (!OptimizerPreview.active || !OptimizerPreview._candidate || OptimizerPreview._plant !== plant) return;
    OptimizerPreview.stale = true;
    OptimizerPreview._staleReason = `${kind} setup data changed`;
    OptimizerPreview._syncApplyButton();
    if (typeof document !== 'undefined') OptimizerPreview._render();
  },
```

`runWithPreview` (line 7629-7754) — the two `footBtns.forEach((b) => { b.disabled = false; })` calls (success path line 7730, catch path line 7750) both currently blanket-enable Apply even on a run that produced a stale/inapplicable state. Replace both with:

```typescript
        footBtns.forEach((b) => { b.disabled = false; });
        OptimizerPreview._syncApplyButton();
        OptimizerPreview._render();
```

and in the catch block:

```typescript
        footBtns.forEach((b) => { b.disabled = false; });
        OptimizerPreview._syncApplyButton();
```

(`footBtns` still includes both Discard and Apply; setting `disabled = false` on both first and then immediately correcting Apply via `_syncApplyButton()` keeps Discard's simple "always enabled once the run finishes" behavior while Apply's is derived.)

- [ ] **Step 4: Also call `_syncApplyButton` at the end of `_render()`**

At the very end of `_render()` (after the existing event-wiring block, before the closing `},` at line 8024), add:

```typescript
    OptimizerPreview._syncApplyButton();
```

so the button state is always freshly derived after any repaint (e.g. the collapsible-section toggles added in Task 3, which call `_render()`).

- [ ] **Step 5: en.js keys**

```javascript
  'ui.setup_preview_apply_stale_title':      'Setup data changed. Run optimization again before applying.',
  'ui.setup_preview_apply_not_ready_title':  'No candidate is ready to apply yet.',
```

- [ ] **Step 6: Compile and manually verify**

Run: `npm run build`
Manual check: run an optimizer preview, confirm Apply is enabled; while the modal is open, trigger a setup-data write elsewhere (e.g. edit a Setup Matrix cell and Save in another tab/pane) and confirm Apply becomes disabled with the stale tooltip; close and reopen the loading state (re-run) and confirm Apply re-enables once the new candidate lands.

- [ ] **Step 7: Commit**

```bash
git add web/schedule-workbench.mts web/index.html web/locales/en.js
git commit -m "fix: derive Optimizer Preview Apply button state from canApply() everywhere"
```

---

### Task 2: Fix `var(--danger)` → `var(--err)`

**Files:**
- Modify: `web/schedule-workbench.mts` (line 7745, inside `runWithPreview`'s catch block)

- [ ] **Step 1: Replace the inline style**

At `web/schedule-workbench.mts:7745`:

```typescript
            '<div style="padding:24px;text-align:center;color:var(--danger,#c0392b);">'
```

becomes:

```typescript
            '<div style="padding:24px;text-align:center;color:var(--err);">'
```

- [ ] **Step 2: Compile and verify**

Run: `npm run build`
Manual check: force an optimizer evaluation error (e.g. temporarily throw inside `evaluateSchedule` in a scratch edit, or select a plant with no tasks after bypassing the earlier guard) and confirm the "Optimization failed" text renders in the theme's error red in both light and dark mode, not a hardcoded `#c0392b`. Revert any scratch edit used only to trigger the error path.

- [ ] **Step 3: Commit**

```bash
git add web/schedule-workbench.mts
git commit -m "fix: use --err token instead of hardcoded --danger fallback in optimizer preview error state"
```

---

### Task 3: Move hardcoded English into en.js

**Files:**
- Modify: `web/schedule-workbench.mts` (`showLoading` 7511-7523, `_render()`'s `backlogHtml`/`explanationHtml`/verdict text/footer note, various)
- Modify: `web/locales/en.js`

**Interfaces:**
- Consumes: `Util.t()` (already used extensively elsewhere in this same method — follow the exact call convention already visible at e.g. line 7885 `Util.t('ui.setup_col_line')`).

- [ ] **Step 1: Catalog every hardcoded English string in scope**

In `web/schedule-workbench.mts`, the following literals inside `OptimizerPreview` are hardcoded today and must move to `en.js` (line numbers as of the pre-Task-1 read; re-check after Tasks 1-2 shift lines slightly):
- `showLoading`: `'Calculating optimization impact…'`, `` `Running ${mode} on ${plant}` `` (7519, 7521)
- `_render()` verdict block: `'No measurable change'` / `'The optimizer ran but the KPIs are unchanged within tolerance.'`, `'Big win — every KPI improved'` / `'Schedule improved'`, `` `${better} of ${directional.length} optimization KPIs moved in your favor with no regressions.` ``, `'Schedule regressed'` / `` `${worse} of ${directional.length} optimization KPIs got worse. Discard is probably the call.` ``, `'Net improvement, with trade-offs'` / `` `${better} KPI${better===1?'':'s'} improved, ${worse} regressed. Review before applying.` ``, `'Net regression'` / `` `${worse} KPI${worse===1?'':'s'} got worse, ${better} improved. Discard recommended.` `` (7817-7834)
- Card labels/tips (`cards` array, 7773-7799): `'Changeovers'`, `'Schedule span'`, `'Late orders'`, `'Cumulative lateness'`, `'Peak line utilization'`, and each `tip` string
- `backlogHtml`: `'Backlogged orders found'`, `'Orders moved'`, `'Fixed orders moved'`, `'Moved backlog runtime'`, `'Largest delay'`, `'Skipped invalid runtime'`, `'Skipped missing start'`, `'Continuous overlong exceptions'`, `'Calendar capacity failures'`, `'No eligible backlog was found in this window; the schedule is unchanged.'`, `'Remove Backlog results'`, `'Boundary conflicts:'`, `' moved order(s) overlap protected work after To. Apply remains available so you can repair that period manually.'` (7842-7859)
- `splitPolicyLabel` map: `'No splitting'`, `'Split overlong only'`, `'Partial orders allowed'` (7864-7868)
- Footer note: `` `<strong>Apply</strong> commits the candidate schedule (still undoable via Ctrl+Z). <strong>Discard</strong> drops this candidate without changing the current schedule.` `` (7986)
- `'Optimization failed'` (error path, 7746)
- Modal chrome in `web/index.html:2567`: `'Optimization impact preview'`, `'↶ Discard'`, `'✓ Apply changes'`

- [ ] **Step 2: Add en.js keys**

```javascript
  'ui.opt_pv_loading_title':          'Calculating optimization impact…',
  'ui.opt_pv_loading_sub':            'Running {{mode}} on {{plant}}',
  'ui.opt_pv_verdict_neutral_title':  'No measurable change',
  'ui.opt_pv_verdict_neutral_sub':    'The optimizer ran but the KPIs are unchanged within tolerance.',
  'ui.opt_pv_verdict_big_win_title':  'Big win — every KPI improved',
  'ui.opt_pv_verdict_improved_title': 'Schedule improved',
  'ui.opt_pv_verdict_better_sub':     '{{better}} of {{total}} optimization KPIs moved in your favor with no regressions.',
  'ui.opt_pv_verdict_regressed_title': 'Schedule regressed',
  'ui.opt_pv_verdict_all_worse_sub':  '{{worse}} of {{total}} optimization KPIs got worse. Discard is probably the call.',
  'ui.opt_pv_verdict_tradeoffs_title': 'Net improvement, with trade-offs',
  'ui.opt_pv_verdict_tradeoffs_sub':  '{{better}} KPI{{betterPlural}} improved, {{worse}} regressed. Review before applying.',
  'ui.opt_pv_verdict_net_regression_title': 'Net regression',
  'ui.opt_pv_verdict_net_regression_sub':   '{{worse}} KPI{{worsePlural}} got worse, {{better}} improved. Discard recommended.',
  'ui.opt_pv_card_changeovers':        'Changeovers',
  'ui.opt_pv_card_changeovers_tip':    'Adjacent orders on the same line that differ in COLOR or FORM_SIZE. Each one costs cleanout/setup time, so fewer is better.',
  'ui.opt_pv_card_span':               'Schedule span',
  'ui.opt_pv_card_span_tip':           'Total clock time from the earliest order start to the latest order finish, across the selected window and lines.',
  'ui.opt_pv_card_late':               'Late orders',
  'ui.opt_pv_card_late_tip':           'Count of orders whose scheduled finish lands AFTER the SAP planning date. Equal-weight headcount — a 1-hour slip and a 40-hour slip each count as one.',
  'ui.opt_pv_card_lateness':           'Cumulative lateness',
  'ui.opt_pv_card_lateness_tip':       'Sum of due-date slip across every late order, in hours. Captures severity, not just count: ten orders slipping 1 h = 10 h; one order slipping 40 h = 40 h. Lower is better.',
  'ui.opt_pv_card_util':               'Peak line utilization',
  'ui.opt_pv_card_util_tip':           'Highest single-line single-day utilization in the 14-day horizon. High is good for throughput; over 100% means overbooked vs Calendar capacity.',
  'ui.opt_pv_backlog_found':           'Backlogged orders found',
  'ui.opt_pv_backlog_moved':           'Orders moved',
  'ui.opt_pv_backlog_fixed_moved':     'Fixed orders moved',
  'ui.opt_pv_backlog_runtime':         'Moved backlog runtime',
  'ui.opt_pv_backlog_largest_delay':   'Largest delay',
  'ui.opt_pv_backlog_skipped_runtime': 'Skipped invalid runtime',
  'ui.opt_pv_backlog_skipped_start':   'Skipped missing start',
  'ui.opt_pv_backlog_overlong':        'Continuous overlong exceptions',
  'ui.opt_pv_backlog_capacity_fail':   'Calendar capacity failures',
  'ui.opt_pv_backlog_empty':           'No eligible backlog was found in this window; the schedule is unchanged.',
  'ui.opt_pv_backlog_title':           'Remove Backlog results',
  'ui.opt_pv_backlog_boundary':        '<strong>Boundary conflicts:</strong> {{count}} moved order(s) overlap protected work after To. Apply remains available so you can repair that period manually.',
  'ui.opt_pv_split_none':              'No splitting',
  'ui.opt_pv_split_overlong':          'Split overlong only',
  'ui.opt_pv_split_partial':           'Partial orders allowed',
  'ui.opt_pv_footer_note':             '<strong>Apply</strong> commits the candidate schedule (still undoable via Ctrl+Z). <strong>Discard</strong> drops this candidate without changing the current schedule.',
  'ui.opt_pv_failed_title':            'Optimization failed',
  'ui.opt_pv_modal_title':             'Optimization impact preview',
  'btn.opt_pv_discard':                '↶ Discard',
  'btn.opt_pv_apply':                  '✓ Apply changes',
  'ui.opt_pv_why_title':               'Why this candidate',
  'ui.opt_pv_why_intro':               'The optimizer evaluated this run and picked the candidate below.',
  'ui.opt_pv_gaps_title':              'Missing setup times',
  'ui.opt_pv_gaps_intro':              'The optimizer could not evaluate these transitions because no setup time is recorded for them. Filling them in may produce a better candidate on the next run.',
  'ui.opt_pv_diag_title':              'Search diagnostics',
```

- [ ] **Step 3: Replace the literals**

In `showLoading`:

```typescript
      + `    <span style="font-size:14px;color:var(--fg);">${esc(Util.t('ui.opt_pv_loading_title'))}</span>`
      + '  </div>'
      + `  <div style="font-size:12px;color:var(--fg-mute);">${esc(Util.t('ui.opt_pv_loading_sub', { mode, plant }))}</div>`
```

(`esc` isn't in scope inside `showLoading` today since it's defined locally inside `_render()` — hoist the existing `esc` helper (currently a local `const` at the top of `_render()`, line 7837) to a module-level `const` near the top of the `OptimizerPreview` object's file so every method can share it, rather than duplicating it.)

In the verdict block, replace the four `if`/`else if` branches' string literals with `Util.t()` calls, e.g.:

```typescript
    if (better === 0 && worse === 0) {
      verdictTone = 'neutral';
      verdictTitle = Util.t('ui.opt_pv_verdict_neutral_title');
      verdictSub = Util.t('ui.opt_pv_verdict_neutral_sub');
    } else if (worse === 0) {
      verdictTone = 'better';
      verdictTitle = better === directional.length ? Util.t('ui.opt_pv_verdict_big_win_title') : Util.t('ui.opt_pv_verdict_improved_title');
      verdictSub = Util.t('ui.opt_pv_verdict_better_sub', { better, total: directional.length });
    } else if (better === 0) {
      verdictTone = 'worse';
      verdictTitle = Util.t('ui.opt_pv_verdict_regressed_title');
      verdictSub = Util.t('ui.opt_pv_verdict_all_worse_sub', { worse, total: directional.length });
    } else if (better >= worse) {
      verdictTone = 'better';
      verdictTitle = Util.t('ui.opt_pv_verdict_tradeoffs_title');
      verdictSub = Util.t('ui.opt_pv_verdict_tradeoffs_sub', { better, betterPlural: better === 1 ? '' : 's', worse });
    } else {
      verdictTone = 'worse';
      verdictTitle = Util.t('ui.opt_pv_verdict_net_regression_title');
      verdictSub = Util.t('ui.opt_pv_verdict_net_regression_sub', { worse, worsePlural: worse === 1 ? '' : 's', better });
    }
```

In the `cards` array, replace each `label`/`tip` literal with the matching `Util.t()` call (evaluated once per `_render()` call, same as today — `cards` is rebuilt fresh each render, so this is a direct substitution, not a structural change):

```typescript
      { label: Util.t('ui.opt_pv_card_changeovers'), k: 'changeovers', ico: '🔁', fmt: (v) => String(v), unit: '', lowerIsBetter: true, tip: Util.t('ui.opt_pv_card_changeovers_tip') },
      { label: Util.t('ui.opt_pv_card_span'), k: 'span_h', ico: '↔', fmt: (v) => v.toFixed(1), unit: 'h', lowerIsBetter: 'soft', tip: Util.t('ui.opt_pv_card_span_tip') },
      { label: Util.t('ui.opt_pv_card_late'), k: 'late_count', ico: '⏰', fmt: (v) => String(v), unit: '', lowerIsBetter: true, tip: Util.t('ui.opt_pv_card_late_tip') },
      { label: Util.t('ui.opt_pv_card_lateness'), k: 'late_h', ico: '⛌', fmt: (v) => v.toFixed(1), unit: 'h', lowerIsBetter: true, tip: Util.t('ui.opt_pv_card_lateness_tip') },
      { label: Util.t('ui.opt_pv_card_util'), k: 'peak_util_pct', ico: '▲', fmt: (v) => String(v), unit: '%', lowerIsBetter: 'soft', tip: Util.t('ui.opt_pv_card_util_tip') },
```

In `backlogHtml`, replace the `rows` array's labels and the summary/title/boundary strings similarly (straightforward literal-to-`Util.t()` swap; the row array becomes `[[Util.t('ui.opt_pv_backlog_found'), ...], ...]`, etc.).

In `splitPolicyLabel`, replace the map's three values with `Util.t()` calls.

Replace the footer note and `'Optimization failed'` literal likewise.

In `web/index.html:2567,2574,2575`:

```html
      <h3>${'{{ handled via a small inline i18n bridge below }}'}</h3>
```

Since this is static HTML (not run through `Util.t()` at render time the way the JS-built modal body is), use the existing pattern this file already follows for static-HTML i18n: check how neighboring static modal headers in `index.html` localize their `<h3>` (search for `data-i18n` attribute usage nearby) and apply the same attribute here — e.g. `<h3 data-i18n="ui.opt_pv_modal_title">Optimization impact preview</h3>`, `<button ... data-i18n="btn.opt_pv_discard">↶ Discard</button>`, `<button ... data-i18n="btn.opt_pv_apply">✓ Apply changes</button>` — matching whatever mechanism (`data-i18n` attribute swapped at boot, or a direct template) the codebase already uses for static index.html chrome. If no such mechanism exists for `.modal-head`/`.modal-foot` static text elsewhere in `index.html`, leave these three strings as the one deliberate exception (static shell chrome, not dynamically rendered) and note that in the commit message rather than inventing a new i18n mechanism for three strings.

- [ ] **Step 4: Compile and verify**

Run: `npm run build`
Manual check: run an optimizer preview end to end, confirm every string that was previously hardcoded now renders identically (same English text, since `en.js` values match the originals verbatim) — this is a refactor, not a copy change, so a visual diff against the pre-change screenshot should show zero difference.

- [ ] **Step 5: Commit**

```bash
git add web/schedule-workbench.mts web/locales/en.js web/index.html
git commit -m "refactor: move Optimizer Preview's hardcoded English into en.js"
```

---

### Task 4: Reorder sections, delete the duplicate impact grid, add three collapsed disclosures

**Files:**
- Modify: `web/schedule-workbench.mts` (`_render()`, replacing the `explanationHtml` IIFE and the final `body.innerHTML` template)
- Modify: `web/index.html` (add `.opt-pv-section*` CSS)
- Modify: `web/locales/en.js` (keys added in Task 3 already cover section titles/intros)

**Interfaces:**
- Consumes: `explanation: PreviewExplanation | null` (existing, `web/schedule-workbench.mts:7454-7468`), `OptimizerPreview._previewDiagnostics`, `verdictTone`/`verdictTitle`/`verdictSub`/`better`/`directional` (existing local variables in `_render()`), `cardsHtml` (existing).
- Produces: three collapsible `<details>`-based sections replacing the single `explanationHtml` block: "Why this candidate" (built from `explanation.reasons`/`explanation.impact`, **without** re-stating the KPI cards — the mockup's duplicate impact grid is deleted entirely, not relocated), "Missing setup times" (from `explanation.missingPairs`, reusing the existing table markup/copy/export/review wiring verbatim), "Search diagnostics" (from `explanation.search`).

Per this plan's Architecture section, the mockup's multi-column "Current / Applied / Alt B / Alt C" plan-comparison table and its prune-reason bar chart require `CandidateResult` to carry runner-up finalists and pruned-by-reason counts, which it does not today (`web/setup-scheduler.mts:393-402`). This task builds "Why this candidate" as a single-column summary of the applied candidate's accepted/rejected reasons and impact deltas (data that already exists via `explanation.reasons`/`explanation.impact`) and explicitly leaves the comparison table out, per the user's own fallback instruction.

- [ ] **Step 1: Use `<details>`/`<summary>` for the three collapsed sections**

Native `<details>` gives free keyboard/ARIA disclosure semantics and avoids re-implementing the mockup's custom caret/open-state JS — a better fit for this codebase's "no new interaction machinery unless needed" bias. Replace the entire `explanationHtml` IIFE (`web/schedule-workbench.mts:7871-7891`) with:

```typescript
    const whyHtml = (() => {
      if (!explanation) return '';
      const reasons = explanation.reasons.length
        ? `<ul class="opt-pv-reasons">${explanation.reasons.map(reason => `<li><strong>${esc(reason.outcome)}</strong> ${esc(reason.message)}</li>`).join('')}</ul>`
        : `<p class="opt-pv-section-empty">${esc(Util.t('ui.setup_reasons_none'))}</p>`;
      const constraints = explanation.constraints.join(', ') || Util.t('ui.setup_constraints_none');
      const unchangedLines = explanation.unchangedLines.join(', ') || Util.t('ui.setup_unchanged_lines_none');
      return `<details class="opt-pv-section" open>
        <summary class="opt-pv-section-head"><span class="opt-pv-section-title">${esc(Util.t('ui.opt_pv_why_title'))}</span></summary>
        <div class="opt-pv-section-body">
          <p class="opt-pv-section-intro">${esc(Util.t('ui.opt_pv_why_intro'))}</p>
          ${reasons}
          <dl class="opt-pv-meta-list">
            <div><dt>${esc(Util.t('ui.setup_constraints_label'))}</dt><dd>${esc(constraints)}</dd></div>
            <div><dt>${esc(Util.t('ui.setup_unchanged_lines_label'))}</dt><dd>${esc(unchangedLines)}</dd></div>
            <div><dt>${esc(Util.t('ui.setup_search_label'))}</dt><dd>${esc(String(explanation.impact.sequences.changed))}</dd></div>
          </dl>
        </div>
      </details>`;
    })();

    const gapsHtml = (() => {
      if (!explanation) return '';
      const canReview = (globalThis as unknown as { NIMBUS?: { SetupAdmin?: { canReviewMissingPairs?: (plant: string) => boolean } } }).NIMBUS?.SetupAdmin?.canReviewMissingPairs?.(plant) === true;
      const body = explanation.missingPairs.length
        ? `<div class="setup-table-wrap"><table class="setup-table"><thead><tr><th>${esc(Util.t('ui.setup_col_line'))}</th><th>${esc(Util.t('ui.setup_col_from'))}</th><th>${esc(Util.t('ui.setup_col_to'))}</th><th>${esc(Util.t('ui.setup_col_reason'))}</th></tr></thead><tbody>${explanation.missingPairs.map(pair => `<tr><td>${esc(pair.line)}</td><td>${esc(pair.fromState || '—')}</td><td>${esc(pair.toState || '—')}</td><td>${esc(pair.reason)}</td></tr>`).join('')}</tbody></table></div><div class="opt-pv-footer-note"><button class="btn btn-ghost sm" data-opt-copy-missing>${esc(Util.t('btn.setup_copy_missing'))}</button> <button class="btn btn-ghost sm" data-opt-export-missing>${esc(Util.t('btn.setup_export_missing'))}</button>${canReview ? ` <button class="btn btn-ghost sm" data-opt-review-missing>${esc(Util.t('ui.setup_review_missing_title'))}</button>` : ''}</div>`
        : `<p class="opt-pv-section-empty">${esc(Util.t('ui.setup_missing_pairs_none'))}</p>`;
      const badge = explanation.missingPairs.length ? `<span class="opt-pv-section-badge">${explanation.missingPairs.length}</span>` : '';
      return `<details class="opt-pv-section">
        <summary class="opt-pv-section-head"><span class="opt-pv-section-title">${esc(Util.t('ui.opt_pv_gaps_title'))}</span>${badge}</summary>
        <div class="opt-pv-section-body">
          <p class="opt-pv-section-intro">${esc(Util.t('ui.opt_pv_gaps_intro'))}</p>
          ${body}
        </div>
      </details>`;
    })();

    const diagHtml = (() => {
      if (!explanation) return '';
      return `<details class="opt-pv-section">
        <summary class="opt-pv-section-head"><span class="opt-pv-section-title">${esc(Util.t('ui.opt_pv_diag_title'))}</span></summary>
        <div class="opt-pv-section-body">
          <dl class="opt-pv-meta-list">
            <div><dt>${esc(Util.t('ui.setup_search_label'))}</dt><dd>${esc(explanation.search.method)}</dd></div>
            <div><dt>Candidates</dt><dd>${esc(String(explanation.search.candidateCount))}</dd></div>
            <div><dt>Termination</dt><dd>${esc(explanation.search.termination)}</dd></div>
            <div><dt>Runtime</dt><dd>${explanation.search.runtimeMs.toFixed(0)} ms</dd></div>
          </dl>
        </div>
      </details>`;
    })();
```

("Candidates"/"Termination"/"Runtime" reuse the existing untranslated pattern already present for these exact three labels elsewhere in this file — if `en.js` keys for them already exist under a different name, prefer those; otherwise add `ui.opt_pv_diag_candidates`/`ui.opt_pv_diag_termination`/`ui.opt_pv_diag_runtime` alongside Task 3's keys rather than leaving new hardcoded strings, since Task 3's whole point is zero new hardcoded English.)

- [ ] **Step 2: Reorder the final template**

Replace the `body.innerHTML` assignment (`web/schedule-workbench.mts:7958-7988`) so verdict + cards come first, backlog stays where it is (it's mode-specific context, not part of the reordered trio), and the three new collapsed sections replace `explanationHtml`:

```typescript
    body.innerHTML = `
      <div class="opt-pv-shell">
        <div class="opt-pv-header">
          <div class="opt-pv-chip opt-pv-chip-mode">${esc(modeLabel)}</div>
          <div class="opt-pv-chip opt-pv-chip-plant" title="Plant scope">📍 ${esc(plant)}</div>
          <div class="opt-pv-chip opt-pv-chip-policy" title="Plant-level split-order allocation policy">${esc(splitPolicyLabel[splitPolicy])}</div>
          <div class="opt-pv-chip opt-pv-chip-time">⏱ ${esc(stamp)}</div>
        </div>

        ${backlogHtml}

        <div class="opt-pv-verdict opt-pv-verdict-${verdictTone}">
          <div class="opt-pv-verdict-icon">${verdictTone === 'better' ? '✓' : verdictTone === 'worse' ? '!' : '◐'}</div>
          <div class="opt-pv-verdict-text">
            <div class="opt-pv-verdict-title">${esc(verdictTitle)}</div>
            <div class="opt-pv-verdict-sub">${esc(verdictSub)}</div>
          </div>
          <div class="opt-pv-verdict-score">
            <div class="opt-pv-score-num">${better}<span class="opt-pv-score-of">/${directional.length}</span></div>
            <div class="opt-pv-score-lbl">KPIs improved</div>
          </div>
        </div>

        <div class="opt-pv-grid">${cardsHtml}</div>

        <div class="opt-pv-sections">
          ${whyHtml}
          ${gapsHtml}
          ${diagHtml}
        </div>

        <div class="opt-pv-footer-note">${Util.t('ui.opt_pv_footer_note')}</div>
      </div>`;
```

Note `${Util.t('ui.opt_pv_footer_note')}` is deliberately **not** `esc()`-wrapped since its value legitimately contains `<strong>` tags (matching the original literal at line 7986) — every other `Util.t()` call in this template wraps plain text and stays `esc()`-wrapped; this is the one exception, and it's safe because the string is a fixed `en.js` literal, not user input.

- [ ] **Step 3: Delete the count-up animation**

Remove the `requestAnimationFrame` counter-animation block entirely (`web/schedule-workbench.mts:7990-8010`, from `// Counter animation...` through its closing `});`). The `cardsHtml` template (built earlier in `_render()`, untouched) already renders the final `postV` value directly via `c.fmt(postV)` in `.opt-pv-num-val` — removing the animation just means that value is what's shown from the first paint, with no follow-up DOM write. Confirm `data-target`/`data-fmt`/`data-unit` attributes on `.opt-pv-num-post` (still present in `cardsHtml`, line 7945) become dead now that nothing reads them; leave them in place only if another part of the codebase reads them (grep for `data-target` under `web/` before deciding) — if nothing else reads them, remove those three attributes from the `cardsHtml` template too, since dead data-attributes are exactly the kind of unused code this task should not leave behind.

- [ ] **Step 4: CSS for the collapsed sections**

In `web/index.html`, after the existing `.opt-pv-footer-note` rules (line 838-848):

```css
.opt-pv-sections { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
.opt-pv-section { border-top: 1px solid var(--line); }
.opt-pv-section:first-child { border-top: 0; }
.opt-pv-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; cursor: pointer; list-style: none; background: var(--bg-elev); color: var(--fg-mute); }
.opt-pv-section-head::-webkit-details-marker { display: none; }
.opt-pv-section[open] > .opt-pv-section-head { background: var(--bg-subtle); }
.opt-pv-section-title { font: 600 10px/1.2 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }
.opt-pv-section-badge { font: 600 9px/1.5 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; color: var(--warn); background: var(--warn-soft); border-radius: 3px; padding: 1px 6px; }
.opt-pv-section-body { padding: 12px; border-top: 1px solid var(--line); background: var(--bg-elev); }
.opt-pv-section-intro { margin: 0 0 10px; font-size: 11.5px; color: var(--fg-mute); max-width: 78ch; }
.opt-pv-section-empty { margin: 0; font-size: 12px; color: var(--fg-mute); }
.opt-pv-reasons { margin: 0 0 10px; padding-left: 18px; font-size: 12px; }
.opt-pv-meta-list { display: flex; flex-wrap: wrap; gap: 6px 24px; margin: 0; }
.opt-pv-meta-list > div { display: flex; gap: 10px; }
.opt-pv-meta-list dt { font: 600 9px/1.7 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; color: var(--fg-faint); }
.opt-pv-meta-list dd { margin: 0; font-family: var(--font-mono); font-size: 11.5px; }
body.dark .opt-pv-section-head { background: var(--bg-strong); }
body.dark .opt-pv-section[open] > .opt-pv-section-head { background: var(--bg-elev); }
```

- [ ] **Step 5: Compile and manually verify**

Run: `npm run build`
Manual check: run an optimizer preview. Confirm order top-to-bottom is: header chips → (backlog panel if `mode === 'backlog'`) → verdict banner → KPI cards → the three collapsed sections (Why this candidate open by default, Missing setup times and Search diagnostics collapsed) → footer note. Confirm the old "Candidate explanation" grid (Production orders/Setup changeovers/Occupied time/... restating the cards) is gone. Confirm the After numbers on each KPI card show their final value immediately with no animated count-up. Confirm the missing-setup-times section's Copy/Export/"Fill these in" buttons still work (wiring at `web/schedule-workbench.mts:8011-8023` is untouched — just re-point its `body.querySelector` calls, which already query by `data-opt-*` attribute and don't care about DOM position).

- [ ] **Step 6: Commit**

```bash
git add web/schedule-workbench.mts web/index.html web/locales/en.js
git commit -m "refactor: reorder Optimizer Preview to verdict+cards first, collapsed sections last; delete duplicate impact grid; drop count-up animation"
```

---

### Task 4a: Verify no other code depends on removed structure

**Files:**
- Read-only check: `web/schedule-workbench.mts`, `web/nimbus-intelligence.js` (per CLAUDE.md, `Confidence.init` monkey-patches `Alerts.recompute`, not `OptimizerPreview._render` — but verify)

- [ ] **Step 1: Grep for external references to the removed classes/structure**

Run: `grep -rn "opt-pv-backlog-grid\|explanationHtml\|opt-pv-num-post\[data-target\]" web/`

Expected: only the `_render()` method itself references `opt-pv-backlog-grid`-shaped markup (used by the still-present `backlogHtml`, which is untouched — only `explanationHtml`'s duplicate grid was deleted, not the backlog one). If any other file references `.opt-pv-backlog-grid` expecting the *explanation* section's specific rows (Production orders/Setup changeovers/etc.), it will break — confirm there are none (this markup is only ever queried by `_render()`'s own subsequent DOM wiring, which this plan's Task 4 Step 2 already accounts for).

- [ ] **Step 2: Run the existing JS test suite**

Run: `npm test` (or whatever the project's configured JS test command is — check `package.json`'s `scripts.test`)
Expected: PASS (no test currently exercises `OptimizerPreview._render()`'s HTML structure directly, per this module's lack of dedicated JS unit tests found during research — confirm this assumption holds rather than assuming it silently).

- [ ] **Step 3: Commit (only if fixes were needed)**

```bash
git add -A
git commit -m "fix: update references to Optimizer Preview markup after reorder"
```

(Skip this commit if Step 1/2 found nothing to fix.)

---

### Task 5: Cleanup scratch files

This task is **shared** with the paired Setup Matrix plan (`docs/superpowers/plans/2026-08-17-setup-matrix-list-view.md`, Task 5) — run it only once, after both plans are complete, since it deletes both mockups and both plans' root scratch files together. Do not duplicate the deletion here if the other plan's Task 5 already ran.
