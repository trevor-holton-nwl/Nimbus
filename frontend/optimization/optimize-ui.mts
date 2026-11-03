// optimization/optimize-ui.mjs — OptimizeDialog (time-window & strategy
// picker), OptimizerPreview (before/after KPI preview + apply/discard), and
// SandboxAdapter (What-If mode banner/buttons). Extracted verbatim from
// schedule-workbench.mts (Phase P3 of docs/architecture/domain-refactor-plan.md,
// which split that 10,391-line mega-module into 6 domain files) — two
// non-contiguous source ranges combined into this one file per that phase's
// per-domain grouping.
//
// `ColorWheelEntry`/`ColorWheelResponse` (originally declared in this file's
// "OptimizeDialog/OptimizerPreview local types" header block) moved to
// priority-lists/viewers.mjs instead — the original file's own doc comment on
// that type already said it is "Read only by ColorWheelViewer's `_load()`
// now", so it belongs with ColorWheelViewer, not here; neither OptimizeDialog
// nor OptimizerPreview ever referenced it.
/* global NIMBUS */
import { Config, Util, ErrorLog, PerfMonitor, Toast, Modal } from '../platform/foundation.mjs';
import { Store, UndoStack } from '../platform/store.mjs';
import { Sandbox } from './sandbox.mjs';
import type { StoreEvent } from '../platform/store.mjs';
import { Alerts, scheduleAlertsForPatches } from '../insights/services.mjs';
import { Engine, snapshotSchedule, SETUP_AWARE_NORMAL_BUDGET_MS, SETUP_AWARE_EXHAUSTIVE_BUDGET_MS, effectiveFirmedIdSet, evaluateSchedule } from './engine.mjs';
import { runOptimizerPreview } from './optimizer-worker-client.mjs';
import type { RemoveBacklogResult } from './scheduler-contract.mjs';
import { applyPatchesToSnapshot, boundsWithRunContext, resolveTaskPlant, validateCandidate, validateCandidateForApply, toolingRuleForSnapshot } from './setup-scheduler.mjs';
import type { CandidateDiagnostic, CandidateReason, CandidateResult, EvaluationRequest, SchedulePatch, ScheduleSnapshot } from './setup-scheduler.mjs';
import { confirmToolQueue, toolQueueSummary, raiseToolInventory } from './tool-queue-confirm.mjs';
import { stateForOrder } from '../setup/setup-domain.mjs';
import { Session } from '../security/session.mjs';
import { Persistence } from '../scheduling/persistence.mjs';
import { CalendarSync } from '../calendar/calendar-sync.mjs';
import { seedOptimizerMode, seedOptimizerPreset } from './optimizer-prefs.mjs';
import type { NimbusMasterData, NimbusTask, OptimizerMode, SplitOrderPolicy, SetupSnapshot, SetupStateKey } from '../platform/types.mjs';

/* =============================================================================
   OPTIMIZE DIALOG — time-window & strategy picker for Engine.runAndApply
   ========================================================================== */
// -- Local type declarations (CQ-1 Phase 6 Task 7 conversion; scoped to
//    OptimizeDialog/OptimizerPreview) ----------------------------------------

/** Store.pref('optimizerDefaults') shape — the user's last-used optimizer
 *  settings, seeded back into the dialog on open(). Store.pref() itself
 *  returns `unknown` (an open per-user prefs bag), so this is read via an `as`
 *  cast and defensively validated at each call site (typeof / array-includes
 *  checks) — same precedent as Table's TableGridLayout / _pinnedLines casts
 *  elsewhere in this file. */
interface OptimizerDefaults {
  mode?: string;
  preset?: string;
  respectFirmed?: boolean;
  /** @deprecated pre-rename key, still read as a fallback for presets saved
   *  before the fixed→firmed rename — see the `?? _od.respectFixed` read. */
  respectFixed?: boolean;
  respectCalendar?: boolean;
}

/** Mirrors Engine.runAndApply's opts contract (schedule-services.mts) — built by
 *  run() below and threaded through OptimizerPreview.runWithPreview. Engine.
 *  runAndApply itself takes `opts: Record<string, unknown>` (an open bag it
 *  reads defensively via individual `as` casts), so this needs the same index
 *  signature to stay assignable at that call site — same "known fields + open
 *  bag" shape as NimbusTask (types.mts) / InteractionTraceEntry above. */
interface OptimizationAuditDetails {
  mode: OptimizerMode;
  wheelUsed: boolean;
  taskCount: number;
  scope: 'plant' | 'lines';
  lines: string[] | null;
  activePriorityFields: string[];
  unrankedPriorityFields: string[];
  splitOrderPolicy: SplitOrderPolicy;
  /** Search budget the planner chose (ms) and whether it was the Exhaustive background run. */
  searchBudgetMs?: number;
  exhaustive?: boolean;
}

interface OptimizerRunOptions {
  plant?: string | null;
  lines?: string[] | null;
  startDate?: Date;
  endDate?: Date;
  respectFirmed?: boolean;
  respectCalendar?: boolean;
  auditDetails?: OptimizationAuditDetails;
  /** Primary search budget in ms (Normal 8 s / Exhaustive 3 min); alternates always use the normal budget. */
  searchBudgetMs?: number;
  exhaustive?: boolean;
  [key: string]: unknown;
}

function previewEvaluationRequest(
  mode: OptimizerMode, opts: OptimizerRunOptions, plant: string, deadlineAt: number,
): EvaluationRequest {
  return {
    mode,
    plant: opts.plant ?? plant,
    lines: opts.lines,
    startDate: opts.startDate,
    endDate: opts.endDate,
    respectFirmed: opts.respectFirmed,
    respectCalendar: opts.respectCalendar,
    now: opts.now instanceof Date ? opts.now : undefined,
    runNow: opts.runNow as EvaluationRequest['runNow'],
    runAt: opts.runAt as EvaluationRequest['runAt'],
    planningStart: opts.planningStart as EvaluationRequest['planningStart'],
    placementStart: opts.placementStart as EvaluationRequest['placementStart'],
    deadlineAt,
    searchBudgetMs: opts.searchBudgetMs,
    exhaustive: opts.exhaustive,
  };
}

export const OptimizeDialog = (() => {
  let _mode: OptimizerMode = 'changeover';
  let _preset  = '2w';
  let _start: Date | null   = null;
  let _end: Date | null     = null;
  let _fpStart: NimbusVendor.FlatpickrInstance | null = null;
  let _fpEnd: NimbusVendor.FlatpickrInstance | null   = null;
  let _plant: string | null   = null;
  let _scope: 'plant' | 'lines' = 'plant';
  let _selectedLines = new Set<string>();    // line names when _scope === 'lines'
  let _lineSearch = '';              // current line-list filter text
  let _wheelFetchToken = 0;          // monotonic token to ignore stale responses
  let _startDirty = false;
  let _endDirty = false;
  // Custom window mode. Off (default): the pickers are date-only and the window is the inclusive day range
  // [From 00:00, To+1 00:00). On ("Adjust times"): date+time pickers and raw instants. Reset on every open().
  let _timeMode = false;

  const PRESET_DAYS: Record<string, number> = { '2w': 14 }; // UI only exposes '2w' and 'custom'

  function _initPickers() {
    if (_fpStart) return;
    _fpStart = flatpickr('#opt-from-cal', {
      inline: true, enableTime: _timeMode, minuteIncrement: 1,
      dateFormat: 'Y-m-d\\TH:i',
    });
    _fpEnd = flatpickr('#opt-to-cal', {
      inline: true, enableTime: _timeMode, minuteIncrement: 1,
      dateFormat: 'Y-m-d\\TH:i',
    });
  }

  /** Midnight of d's calendar day (a clone). */
  function _dayStart(d: Date): Date { const r = new Date(d); r.setHours(0, 0, 0, 0); return r; }
  /** Midnight of the day after d's calendar day. setDate (not + MS_DAY) keeps DST days midnight-aligned. */
  function _dayAfter(d: Date): Date { const r = _dayStart(d); r.setDate(r.getDate() + 1); return r; }
  function _isMidnight(d: Date): boolean { return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0; }

  /** The flatpickr option bag differs by mode (enableTime cannot be flipped reliably with set()), so a mode
   *  change destroys both instances and builds them again from the current window. */
  function _rebuildPickers() {
    try { _fpStart?.destroy(); } catch { /* already gone */ }
    try { _fpEnd?.destroy(); } catch { /* already gone */ }
    _fpStart = null;
    _fpEnd = null;
    _initPickers();
    if (_start) (_fpStart as NimbusVendor.FlatpickrInstance | null)?.setDate(_start, false);
    if (_end) (_fpEnd as NimbusVendor.FlatpickrInstance | null)?.setDate(_end, false);
    if (_start) (_fpEnd as NimbusVendor.FlatpickrInstance | null)?.set('minDate', _timeMode ? _start : _dayStart(_start));
  }

  /** Plant scope is owned by the header selector: the dialog shows it read-only
   *  and never changes it. A header plant change closes the dialog (see open()). */
  function _buildPlantSelect() {
    _plant = Store.selectedPlant || null;
    const lbl = document.getElementById('opt-plant-label');
    if (lbl) {
      const text = _plant ? Store.plantLabel(_plant) : Util.t('ui.select_plant_label');
      lbl.textContent = text;
      lbl.title = text;
    }
  }

  function setScope(scope: string) {
    _scope = scope === 'lines' ? 'lines' : 'plant';
    document.querySelectorAll<HTMLElement>('.opt-scope-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.scope === _scope)
    );
    const panel = document.getElementById('opt-lines-panel');
    if (panel) panel.hidden = _scope !== 'lines';
    if (_scope === 'lines') _renderLines();
    if (_mode === 'backlog') _applyBacklogDefaults();
  }

  function _linesForPlant() {
    if (!_plant) return [];
    const set = new Set(Store.linesForSelectedPlant());
    for (const t of Store.tasksByPlant(_plant)) {
      const l = t.MACHINE || 'Unknown';
      set.add(l);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  function _renderLines() {
    const list = document.getElementById('opt-lines-list');
    const count = document.getElementById('opt-lines-count');
    if (!list) return;

    const allLines = _linesForPlant();
    if (!allLines.length) {
      list.innerHTML = `<li class="opt-lines-empty">${Util.t('ui.no_lines_plant')}</li>`;
      if (count) count.textContent = Util.t('ui.lines_selected', { sel: 0, total: 0 });
      return;
    }

    // Count orders per line (scoped to selected plant)
    const orderCounts: Record<string, number> = {};
    for (const t of Store.tasksByPlant(_plant)) {
      const l = t.MACHINE || 'Unknown';
      orderCounts[l] = (orderCounts[l] || 0) + 1;
    }

    const q = _lineSearch.toLowerCase().trim();
    const visible = q ? allLines.filter(l => l.toLowerCase().includes(q)) : allLines;

    if (!visible.length) {
      list.innerHTML = `<li class="opt-lines-empty">${Util.t('ui.no_matches')}</li>`;
    } else {
      list.innerHTML = visible.map((line) => {
        const checked = _selectedLines.has(line) ? 'checked' : '';
        const oc = orderCounts[line] || 0;
        const excluded = (Store.lineSettings[line] || {}).excludeFromOpt;
        const exTag = excluded ? '<span class="opt-line-excluded" title="Globally excluded from optimization">excluded</span>' : '';
        return `<li class="opt-line-row${excluded ? ' is-excluded' : ''}" role="option" aria-selected="${!!checked}">
            <label class="opt-line-label">
              <input type="checkbox" ${checked} data-line="${Util.escapeHtml(line)}">
              <span class="opt-line-name">${Util.escapeHtml(line)}</span>
              ${exTag}
              <span class="opt-line-orders">${oc} order${oc === 1 ? '' : 's'}</span>
            </label>
          </li>`;
      }).join('');
      list.querySelectorAll<HTMLInputElement>('input[data-line]').forEach(input =>
        input.addEventListener('change', () => _onLineToggle(input.dataset.line || '', input.checked)));
    }

    if (count) count.textContent = `${_selectedLines.size} of ${allLines.length} selected`;
  }

  function filterLines(q: string) {
    _lineSearch = q || '';
    _renderLines();
  }

  function selectAllLines(checked: boolean) {
    const allLines = _linesForPlant();
    const q = _lineSearch.toLowerCase().trim();
    const visible = q ? allLines.filter(l => l.toLowerCase().includes(q)) : allLines;
    for (const l of visible) {
      if (checked) _selectedLines.add(l);
      else _selectedLines.delete(l);
    }
    _renderLines();
    if (_mode === 'backlog') _applyBacklogDefaults();
  }

  function _onLineToggle(line: string, checked: boolean) {
    if (checked) _selectedLines.add(line);
    else _selectedLines.delete(line);
    const count = document.getElementById('opt-lines-count');
    const total = _linesForPlant().length;
    if (count) count.textContent = `${_selectedLines.size} of ${total} selected`;
    if (_mode === 'backlog') _applyBacklogDefaults();
  }

  function _backlogNow(): Date {
    const timezone = Store.masterData?.plants?.find(p => p.plant === _plant)?.timezone;
    if (typeof timezone === 'string' && timezone.trim()) {
      try { return Engine._plantWallNow(timezone, Store.serverNow()); }
      catch { /* Run surfaces the configured-timezone error with an actionable message. */ }
    }
    // The engine still blocks this configuration at Run. This local fallback
    // merely gives the planner usable editable fields while they configure the
    // required plant timezone.
    const local = Store.serverNow(); local.setSeconds(0, 0); return local;
  }

  function _addCalendarMonths(date: Date, months: number): Date {
    const result = new Date(date);
    const day = result.getDate();
    result.setDate(1);
    result.setMonth(result.getMonth() + months);
    const last = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
    result.setDate(Math.min(day, last));
    return result;
  }

  function _applyBacklogDefaults() {
    if (!_plant) return;
    const now = _backlogNow();
    const scopedLines = _scope === 'lines' && _selectedLines.size ? _selectedLines : null;
    const tasks = Store.tasksByPlant(_plant).filter(t => !scopedLines || scopedLines.has(t.MACHINE));
    const pastStarts = tasks.map(t => t.start_date).filter((d): d is Date => !!d && d < now);
    const latestEnds = tasks.map(t => t.end_date).filter((d): d is Date => !!d);
    const computedStart = pastStarts.length ? new Date(Math.min(...pastStarts.map(d => d.getTime()))) : now;
    let computedEnd = latestEnds.length
      ? new Date(Math.min(Math.max(...latestEnds.map(d => d.getTime())), _addCalendarMonths(now, 4).getTime()))
      : _addCalendarMonths(now, 4);
    if (computedEnd < computedStart) computedEnd = _addCalendarMonths(computedStart, 4);
    if (!_startDirty) _start = computedStart;
    if (!_endDirty) _end = computedEnd;
    _fpStart?.setDate(_start!, false);
    _fpEnd?.setDate(_end!, false);
    _updateButtons();
    _updateBacklogRuntimeNote(tasks);
  }

  /** OQ56 a: tell the planner how many orders are backlog only because their run time grew (the reconcile
   *  tags those `reversal_forward` / `run_time_grew`). Shown under the strategy hint in Remove Backlog mode. */
  function _backlogRuntimeGrewCount(tasks: ReadonlyArray<NimbusTask>): number {
    return tasks.filter(t => t.derivationIssue?.code === 'reversal_forward' && t.derivationIssue.detail === 'run_time_grew').length;
  }
  function _updateBacklogRuntimeNote(tasks: ReadonlyArray<NimbusTask>) {
    const hint = document.getElementById('opt-strategy-hint');
    if (!hint || _mode !== 'backlog') return;
    const grew = _backlogRuntimeGrewCount(tasks);
    hint.textContent = Util.t('tip.backlog_mode') + (grew ? ' ' + Util.t('ui.opt_backlog_runtime_grew', { count: grew }) : '');
  }

  /** The planner's own Respect-calendar choice while Remove Backlog holds the box forced on (null = not in Backlog).
   *  Backlog needs the calendar for its run, but that must neither be saved as the planner's default nor outlive
   *  the mode: leaving Backlog puts the remembered choice back. */
  let _calendarBeforeBacklog: boolean | null = null;

  function _applyModeOptions() {
    const backlog = _mode === 'backlog';
    const firmed = document.getElementById('opt-chk-firmed') as HTMLInputElement | null;
    const calendar = document.getElementById('opt-chk-calendar') as HTMLInputElement | null;
    if (firmed) firmed.disabled = backlog;
    if (calendar) {
      if (backlog) {
        if (_calendarBeforeBacklog === null) _calendarBeforeBacklog = calendar.checked;
        calendar.checked = true;
      } else if (_calendarBeforeBacklog !== null) {
        calendar.checked = _calendarBeforeBacklog;
        _calendarBeforeBacklog = null;
      }
      calendar.disabled = backlog;
    }
    const firmedLabel = document.getElementById('opt-firmed-label');
    const calendarLabel = document.getElementById('opt-calendar-label');
    if (firmedLabel) firmedLabel.title = backlog ? 'Firmed orders move when reached and remain firmed.' : Util.t('ui.opt_respect_firmed_hint');
    if (calendarLabel) calendarLabel.title = backlog ? 'Calendar adherence is required for Remove Backlog.' : '';
  }

  /** Date-only display applies when the window is whole days (the Custom default); anything else, including
   *  the presets' now-based window and Remove Backlog's computed bounds, shows its time so it stays truthful. */
  function _dateOnlyDisplay(): boolean {
    return !_timeMode && !!_start && !!_end && _isMidnight(_start) && _isMidnight(_end);
  }

  function _displayDate(d: Date) {
    return _dateOnlyDisplay() ? Util._fmtDatePref(d) : Util.fmtDTPref(d);
  }

  /** The To end is exclusive; date mode shows the inclusive picked day. */
  function _displayEnd(d: Date) {
    if (!_dateOnlyDisplay()) return Util.fmtDTPref(d);
    const last = new Date(d);
    last.setDate(last.getDate() - 1);
    return Util._fmtDatePref(last);
  }

  function _updateButtons() {
    const sb = document.getElementById('opt-start-btn');
    const eb = document.getElementById('opt-end-btn');
    if (sb && _start) sb.textContent = _displayDate(_start);
    if (eb && _end) eb.textContent = _displayEnd(_end);
    _updateSummary();
  }

  function _updateSummary() {
    const el = document.getElementById('opt-date-summary');
    if (!el || !_start || !_end) return;
    const days = Math.round((_end.getTime() - _start.getTime()) / Config.MS_DAY);
    el.innerHTML =
      `<span class="opt-date-summary-range">${_displayDate(_start)} → ${_displayEnd(_end)}</span>` +
      `<span class="opt-date-summary-days">&nbsp;· ${days} ${days === 1 ? 'day' : 'days'}</span>`;
  }

  function applyPreset(key: string) {
    const prevPreset = _preset;
    _preset = key;
    document.querySelectorAll<HTMLElement>('.opt-preset-chip').forEach((c) =>
      c.classList.toggle('active', c.dataset.preset === key)
    );
    const row = document.getElementById('opt-date-row');
    if (row) row.classList.toggle('visible', key === 'custom');

    if (key === 'custom') {
      // Choosing Custom from a preset (or with nothing picked yet) starts as today -> today, one whole day,
      // so Run is never blocked on an empty picker. Re-clicking Custom keeps what the planner picked. In time
      // mode the existing instants are kept, as before.
      if (_mode !== 'backlog' && !_timeMode && (!_start || !_end || prevPreset !== 'custom')) {
        const today = Store.plantNow(_plant) ?? Store.serverNow();
        _start = _dayStart(today);
        _end = _dayAfter(today);
        _fpStart?.setDate(_start, false);
        _fpEnd?.setDate(_end, false);
      }
    } else {
      let days: number;
      if (key === 'horizon') {
        // Store._state.masterData direct touch — deliberate, out of scope for this
        // task (see the file header comment above OptimizeDialog).
        const plantRow = Store._state.masterData?.plants?.find(p => p.plant === Store.selectedPlant) ?? null;
        const horizonMinutes = plantRow?.alt_flag_horizon ?? Store.userSettings?.alertHorizonMinutes ?? 20160;
        days = Math.max(1, Math.ceil(horizonMinutes / 1440));
      } else {
        days = PRESET_DAYS[key];
      }
      const now = Store.plantNow(_plant) ?? Store.serverNow();
      now.setSeconds(0, 0);
      _start = new Date(now);
      _end   = new Date(now.getTime() + days * Config.MS_DAY);
      _fpStart?.setDate(_start, false);
      _fpEnd?.setDate(_end, false);
    }
    if (_mode === 'backlog' && key !== 'custom') {
      _startDirty = true;
      _endDirty = true;
    }
    _updateButtons();
  }

  /** The "Adjust times" toggle: on = date+time pickers and raw instants; off = whole-day range again, the
   *  current window re-snapped to day bounds (To's day is the day holding the last instant). */
  function setTimeMode(on: boolean) {
    on = !!on;
    const chk = document.getElementById('opt-chk-times') as HTMLInputElement | null;
    if (chk) chk.checked = on;
    if (on === _timeMode) return;
    _timeMode = on;
    if (!on && _start && _end) {
      const lastDay = new Date(_end.getTime() - 1);
      _start = _dayStart(_start);
      _end = _dayAfter(lastDay);
      if (_end.getTime() <= _start.getTime()) _end = _dayAfter(_start);
    }
    _rebuildPickers();
    _updateButtons();
  }

  function selectMode(mode: OptimizerMode) {
    _mode = mode;
    const sel = document.getElementById('opt-strategy-select') as HTMLSelectElement | null;
    if (sel && sel.value !== mode) sel.value = mode;
    const hint = document.getElementById('opt-strategy-hint');
    if (hint) hint.textContent = Util.t('tip.' + mode + '_mode');
    _applyModeOptions();
    // Remove Backlog is not a search; Run in background only applies to the three setup-aware strategies.
    const bgChk = document.getElementById('opt-chk-background') as HTMLInputElement | null;
    if (bgChk) { bgChk.disabled = mode === 'backlog'; if (mode === 'backlog') bgChk.checked = false; }
    const bgLabel = document.getElementById('opt-background-label');
    if (bgLabel) bgLabel.title = mode === 'backlog' ? 'Remove Backlog is not a search, so it always runs in the foreground.' : '';
    if (mode === 'backlog') _applyBacklogDefaults();
    else _updatePlantBadge();
  }

  /** One-time listener binding for the strategy `<select>` — uses
   *  a guarded-boolean pattern so `open()` can call
   *  this on every open without stacking duplicate `change` listeners. */
  let _strategySelectListenerSet = false;
  function _initStrategySelectListener() {
    if (_strategySelectListenerSet) return;
    _strategySelectListenerSet = true;
    const sel = document.getElementById('opt-strategy-select') as HTMLSelectElement | null;
    sel?.addEventListener('change', () => selectMode(sel.value as OptimizerMode));
    // "Adjust times" toggle: bound here (once) instead of an inline onchange, which would grow the legacy surface.
    const timesChk = document.getElementById('opt-chk-times') as HTMLInputElement | null;
    timesChk?.addEventListener('change', () => setTimeMode(timesChk.checked));
  }

  /** Does this plant have any colorWheel ranks the optimizer could apply?
   *  Delegates to Engine.hasPriorityRanks — the SHARED implementation, so this
   *  and Plant → System Settings' own hints can never drift apart. Reads the
   *  exact same Store.priorityRankMaps that Engine._sortTerms' term factory
   *  reads, and counts per-line overrides as well as the plant-wide list (Stage 3
   *  replaced the old `GET /color-wheel/{plant}` probe, which saw plant-wide
   *  lists only and therefore mis-reported a plant configured purely with
   *  per-line overrides). Callers must have ensured the cache is fresh for
   *  `_plant`.
   *
   *  Now colorWheel-specific for ONE remaining reason: the `wheel_used` field in
   *  the optimization_run audit payload, which existing audit rows are keyed on.
   *  The badge and the pre-Run confirm both moved to the all-fields
   *  Engine.unrankedActiveFields — do not re-point either back here. */
  function _hasColorRanks(): boolean {
    return Engine.hasPriorityRanks('colorWheel');
  }

  function _updatePlantBadge() {
    const plant   = _plant;
    const badgeEl = document.getElementById('opt-wheel-badge');
    const runBtn = document.getElementById('opt-run-btn') as HTMLButtonElement | null;

    if (runBtn) runBtn.disabled = !plant || !!OptimizerPreview._backgroundRun;

    if (!badgeEl) return;
    const setBadge = (state: 'none' | 'loading' | 'active' | 'warn', icon: string, tip: string) => {
      badgeEl.className = `opt-wheel-badge compact ${state}`;
      badgeEl.title = tip;
      badgeEl.innerHTML = `<span class="owb-icon${state === 'loading' ? ' cw-spin' : ''}">${icon}</span>`;
    };

    if (!plant) {
      // Deliberately does NOT clear the rank cache: `_plant` is null only when
      // the dialog found no plant data at all, which says nothing about the
      // plant Store is still loaded for.
      setBadge('none', '⚠', Util.t('ui.opt_badge_no_plant'));
      return;
    }

    if (_mode === 'backlog') {
      setBadge('none', '↪', 'Remove Backlog preserves the existing sequence and does not use priority lists.');
      return;
    }
    setBadge('loading', '', Util.t('ui.opt_badge_checking'));
    const token = ++_wheelFetchToken;

    // Prefetch this plant's priority rank maps so (a) the badge reflects what
    // the optimizer will actually rank on, and (b) run() finds
    // Persistence._rankMapsPlant already fresh and needs no second round-trip
    // on submit — the same "populated by _updatePlantBadge, consumed by run()"
    // role the retired per-plant color→rank cache played. Safe to load into the
    // shared (non-plant-keyed) Store cache from here because `_plant` is always
    // Store.selectedPlant at this point: _buildPlantSelect reads it from the header
    // selector, and a header plant change closes the dialog. Never rejects.
    Persistence.loadPriorityRankMaps(plant).then(() => {
      if (token !== _wheelFetchToken) return; // stale response — ignore
      if (Persistence._rankMapsPlant !== plant) {
        // Fetch resolved non-ok, or threw — cache is empty, not authoritative.
        setBadge('warn', '○', Util.t('ui.opt_badge_check_failed'));
        return;
      }
      // Reports on ALL of the plant's active priority fields, not colorWheel
      // alone: on a plant that sequences by tooling this badge used to sit
      // permanently on the ⚠ "no color wheel" state even with every PRT list
      // loaded, and would now also contradict the (generalized) pre-Run confirm
      // right next to it.
      //
      // Every tooltip goes through Util.t (`ui.opt_badge_*`, all five locales).
      // These strings were the last hardcoded UI text on this dialog: locale
      // keys for the five pre-Stage-3 wordings had in fact been authored and
      // then left unwired, so the badge was interpolating LOCALIZED field names
      // (`constraint.<key>`, below) into an English sentence — a mixed-language
      // tooltip for every non-en user. The field-name interpolation was already
      // right and is kept as-is; only the surrounding sentence moved.
      const active   = Engine.activeConstraintKeys(plant);
      const unranked = Engine.unrankedActiveFields(plant);
      if (!active.length) {
        setBadge('warn', '○', Util.t('ui.opt_badge_none_enabled'));
      } else if (!unranked.length) {
        setBadge('active', '✓', Util.t('ui.opt_badge_lists_loaded', {
          fields: active.map(k => Util.t(`constraint.${k}`)).join(' → '),
        }));
      } else {
        setBadge('warn', '○', Util.t('ui.opt_badge_lists_missing', {
          fields: unranked.map(k => Util.t(`constraint.${k}`)).join(', '),
        }));
      }
    });
  }

  /** Optional preselection from a deep link (the Alert Monitor's "Optimize this window"): the machines and a custom window. */
  interface OpenPrefill { lines?: string[]; startDate?: Date; endDate?: Date }

  /** Apply a prefill on top of the freshly seeded dialog. Unknown lines are ignored; a window needs both ends. */
  function _applyPrefill(prefill: OpenPrefill) {
    const known = new Set(_linesForPlant());
    const wanted = (prefill.lines ?? []).filter(l => known.has(l));
    if (wanted.length) {
      _selectedLines = new Set(wanted);
      setScope('lines');
    }
    const s = prefill.startDate, e = prefill.endDate;
    if (s instanceof Date && e instanceof Date && e.getTime() > s.getTime()) {
      applyPreset('custom');
      _start = new Date(s);
      _end = new Date(e);
      _startDirty = true;
      _endDirty = true;
      // Exact instants are kept. A window that is not whole days needs the time controls to display truthfully.
      if (!_isMidnight(_start) || !_isMidnight(_end)) setTimeMode(true);
      _fpStart?.setDate(_start, false);
      _fpEnd?.setDate(_end, false);
      _updateButtons();
    }
  }

  function open(prefill?: OpenPrefill) {
    // Plant scope is owned by the header selector. The dialog will not open
    // without a plant set there, because the optimizer needs a concrete scope.
    if (!Store.selectedPlant) {
      Toast.show(Util.t('toast.select_plant_before_opt'), 'warn');
      return;
    }
    const el = document.getElementById('modal-optimize');
    if (!el) return;
    if (_closeTimer) { clearTimeout(_closeTimer); _closeTimer = null; }
    el.hidden = false;
    _startDirty = false;
    _endDirty = false;
    // Seed from the user's saved optimizer defaults (pref('optimizerDefaults'))
    // when present, so the dialog opens pre-filled with their preferred strategy,
    // time window, and option toggles. Falls back to the historical defaults
    // (horizon preset / changeover / toolbar checkbox state) otherwise.
    let _od: OptimizerDefaults | null = null;
    try { _od = Store.pref('optimizerDefaults') as OptimizerDefaults | null; } catch {}
    // Sync option checkboxes from the Gantt toolbar's existing chk- elements.
    // P2: dropped the dead `chk-respect-fixed` read here — no such element
    // exists in index.html (confirmed via grep), so it was always null and
    // this mirror never actually ran; the "respect firmed" checkbox is seeded
    // purely from the saved optimizer defaults below.
    const rcEl = document.getElementById('chk-respect-calendar') as HTMLInputElement | null;
    const ofEl = document.getElementById('opt-chk-firmed') as HTMLInputElement | null;
    const ocEl = document.getElementById('opt-chk-calendar') as HTMLInputElement | null;
    _calendarBeforeBacklog = null;   // the boxes are re-seeded below; any forced-on state from a past session is gone
    if (rcEl && ocEl) ocEl.checked = rcEl.checked;
    // Saved defaults override the toolbar mirror when present. Older saved
    // presets used the pre-rename `respectFixed` key — fall back to it.
    if (_od && typeof _od === 'object') {
      const _respectFirmed = (_od.respectFirmed ?? _od.respectFixed);
      if (ofEl && typeof _respectFirmed === 'boolean')      ofEl.checked = _respectFirmed;
      if (ocEl && typeof _od.respectCalendar === 'boolean') ocEl.checked = _od.respectCalendar;
    }
    // "Adjust times" always opens off; a dialog left in time mode gets its date-only pickers back.
    const wasTimeMode = _timeMode;
    _timeMode = false;
    const timesChk = document.getElementById('opt-chk-times') as HTMLInputElement | null;
    if (timesChk) timesChk.checked = false;
    if (wasTimeMode) _rebuildPickers();
    // A From left over from a previous session must not restrict the To picker.
    (_fpEnd as NimbusVendor.FlatpickrInstance | null)?.set('minDate', undefined as unknown as Date);
    _initPickers();
    _buildPlantSelect();
    _initStrategySelectListener();
    _initPlantChangeListener();
    // Only the "safe" no-date presets seed cleanly (custom needs explicit dates).
    const savedPreset = _od?.preset;
    const _seedPreset: string = seedOptimizerPreset(savedPreset);
    applyPreset(_seedPreset);
    const savedMode = _od?.mode;
    // A previously saved unsupported strategy is intentionally normalized to
    // the default changeover strategy.
    const _seedMode: OptimizerMode = seedOptimizerMode(savedMode);
    _startDirty = false;
    _endDirty = false;
    selectMode(_seedMode);
    // Reset the Run button HTML in case a previous session left it in the
    // "Optimizing…" state (e.g., Cancel mid-fetch).
    const runBtn = document.getElementById('opt-run-btn');
    if (runBtn) runBtn.innerHTML = `<span class="opt-run-icon">📈</span>${Util.t('btn.run_optimization')}`;
    // Run in background always opens unticked; the planner opts in per run.
    const bgChkOpen = document.getElementById('opt-chk-background') as HTMLInputElement | null;
    if (bgChkOpen) bgChkOpen.checked = false;
    // A background run holds the optimizer: show that instead of an enabled Run.
    if (runBtn && OptimizerPreview._backgroundRun) {
      (runBtn as HTMLButtonElement).disabled = true;
      runBtn.textContent = Util.t('btn.opt_run_bg_busy');
    }
    _updatePlantBadge();
    // Default scope to whole-plant on each open; clear stale line selection.
    _selectedLines.clear();
    _lineSearch = '';
    const lineSrch = document.getElementById('opt-line-search') as HTMLInputElement | null;
    if (lineSrch) lineSrch.value = '';
    setScope('plant');
    if (prefill) _applyPrefill(prefill);
    requestAnimationFrame(() => el.querySelector('.opt-modal')?.classList.add('visible'));
  }

  /** The dialog is locked to the header plant, so a header plant change while it
   *  is open (background-run "Switch to plant", focus escaping the non-modal
   *  overlay) closes it rather than leaving it scoped to a stale plant. */
  let _plantChangeListenerSet = false;
  function _initPlantChangeListener() {
    if (_plantChangeListenerSet) return;
    _plantChangeListenerSet = true;
    Store.subscribe(evt => {
      if (evt.type !== 'plant:selected') return;
      const el = document.getElementById('modal-optimize');
      if (el && !el.hidden) close(true);
    }, 'OptimizeDialog');
  }

  let _closeTimer: ReturnType<typeof setTimeout> | null = null;

  function close(immediate = false) {
    const el = document.getElementById('modal-optimize');
    if (!el) return;
    if (immediate && _closeTimer) { clearTimeout(_closeTimer); _closeTimer = null; }
    const inner = el.querySelector('.opt-modal');
    inner?.classList.remove('visible');
    if (immediate) {
      // Hide the backdrop element NOW (no 230ms fade). Used when another
      // modal is replacing this one — the heavy blur(12px) backdrop sits at
      // z=3000 and would cover the replacement until the fade completed.
      el.hidden = true;
      return;
    }
    // Kept so open() can cancel it: a reopen inside the fade must not be hidden by this timer.
    if (_closeTimer) clearTimeout(_closeTimer);
    _closeTimer = setTimeout(() => { _closeTimer = null; el.hidden = true; }, 230);
  }

  /** Undo close(true) when a pre-run confirm is cancelled: the dialog comes back with every choice intact (scope, lines,
   *  preset, custom window) instead of being discarded and reseeded by the next open(). */
  function _reshow() {
    const el = document.getElementById('modal-optimize');
    if (!el) return;
    el.hidden = false;
    requestAnimationFrame(() => el.querySelector('.opt-modal')?.classList.add('visible'));
  }

  async function _runImpl() {
    const bgRun = OptimizerPreview._backgroundRun;
    if (bgRun) {
      Toast.show(Util.t('toast.opt_bg_running', { plant: bgRun.plant }), 'warn');
      return;
    }
    // Snapshot the dialog state NOW: run() awaits (rank-map fetch, up to three confirms, the tool inventory) and the
    // dialog's own handlers keep mutating these after close(true), so a later read could see another run's choices.
    const mode = _mode;
    const scope = _scope;
    const selectedLines = Array.from(_selectedLines);
    const winStart = _start;
    const winEnd = _end;
    const plant = _plant;
    if (!plant) {
      Toast.show(Util.t('toast.select_plant_to_opt'), 'warn');
      return;
    }
    if (scope === 'lines' && selectedLines.length === 0) {
      Toast.show(Util.t('toast.select_lines_to_opt'), 'warn');
      return;
    }
    // A From at or after To is refused here, before the dialog closes, rather than as an engine failure afterwards.
    if (winStart && winEnd && winEnd.getTime() <= winStart.getTime()) {
      Toast.show(Util.t('toast.opt_window_invalid'), 'warn');
      return;
    }
    // Senior review U21 (OQ52): a plant with no valid timezone has no clock, so the optimizer refuses to place on it,
    // like the reconcile and manual paths. The dialog's own `liveClock` fallback stays for display defaults only.
    if (!Store.plantNow(plant)) {
      Toast.show(Util.t('toast.optimize_plant_no_timezone', { plant }), 'error', 9000);
      return;
    }
    // Nothing to optimise: say so before the spinner goes up (runWithPreview keeps its own guard for other callers).
    if (!Store.tasksArr.length) {
      Toast.show(Util.t('toast.no_tasks_to_optimise'), 'error');
      return;
    }
    const sfEl = document.getElementById('opt-chk-firmed') as HTMLInputElement | null;
    const scEl = document.getElementById('opt-chk-calendar') as HTMLInputElement | null;
    const bgEl = document.getElementById('opt-chk-background') as HTMLInputElement | null;
    // Exhaustive runs in the background: no preview spinner, the planner keeps working.
    const exhaustive = bgEl?.checked === true && mode !== 'backlog';

    // Remember the chosen strategy/window/options as this user's optimizer
    // defaults so the dialog pre-fills the same way next time (feature: optimizer
    // defaults). Self-service pref — persisted via the debounced PATCH.
    try {
      Session.setPref('optimizerDefaults', {
        mode, preset: _preset,
        respectFirmed:   sfEl?.checked ?? true,
        // In Backlog the box is forced on for the run: save what the planner chose, not the forced value.
        respectCalendar: mode === 'backlog' ? (_calendarBeforeBacklog ?? scEl?.checked ?? true) : (scEl?.checked ?? true),
      });
    } catch {}

    // Immediate visual feedback so the click feels responsive.
    const runBtn = document.getElementById('opt-run-btn') as HTMLButtonElement | null;
    const origRunHTML = runBtn ? runBtn.innerHTML : null;
    const restoreRunBtn = () => {
      if (!runBtn) return;
      runBtn.disabled = !_plant;
      if (origRunHTML !== null) runBtn.innerHTML = origRunHTML;
    };
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.innerHTML = `<span class="opt-run-icon">⏳</span>${Util.t('btn.optimizing')}`;
    }

    // Open the preview dialog with a spinner IMMEDIATELY — before the rank-map
    // freshness fetch below and the config-modal close transition. Otherwise
    // the user stares at a blurry frozen page for ~1–2s with no visible
    // response to their click.
    if (!exhaustive) OptimizerPreview.showLoading(mode, plant);
    // Hide the config modal RIGHT NOW (no 230ms fade). Its backdrop sits at
    // z-index 3000 with blur(12px) and would cover the preview spinner
    // (z=2000) for the entire await + fade duration. Hiding immediately is
    // what makes the spinner actually visible on click.
    close(true);

    // --- Rank-source freshness guard (Stage 3) ---------------------------
    // The Stage 3 replacement for the retired per-plant color→rank cache and
    // its pre-Run fallback fetch. Engine._sortTerms now resolves EVERY priority
    // field's rank straight out of Store.priorityRankMaps, so that cache — not
    // a single color map — is what has to be fresh for this plant before Run. It
    // normally already is (Persistence.load() fetches it on every plant
    // select, and _updatePlantBadge prefetches it on open / plant change), but
    // a Run clicked before that resolves — or after it failed — would
    // otherwise rank EVERY order 999999 on EVERY field: configured, inert and
    // silent. Awaiting here restores the guarantee the deleted fetch provided.
    // Note this replaces the old 1500 ms AbortSignal bound with a 4000 ms
    // race (Phase 2, Pkg D): back then a missing wheel still left a usable
    // ORDER_Y fallback, so cutting the fetch short was cheap; now the ranks
    // are load-bearing, so the fetch is awaited but still BOUNDED rather than
    // waited on forever. On timeout the flow proceeds regardless —
    // loadPriorityRankMaps never rejects, and either way (slow fetch or a
    // failing/non-ok response that returns promptly) the `!ranksFresh` /
    // unrankedActiveFields check and its confirm dialog right below is the
    // real safety net, so ranks are never silently skipped.
    let wheelUsed = false;
    let unrankedFields: string[] = [];
    if (mode !== 'backlog') {
      if (Persistence._rankMapsPlant !== plant) {
        const _rankMapFetchT0 = performance.now();
        // Bound this await so a slow/hung fetch cannot stall the Run click
        // indefinitely; the timer is cleared once the real fetch settles so
        // no stray timer lingers when it wins the race.
        await new Promise<void>(resolve => {
          let done = false;
          const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
          const timer = setTimeout(finish, 4000);
          Persistence.loadPriorityRankMaps(plant).then(finish);
        });
        PerfMonitor.record('Optimize.rankMapFetch', performance.now() - _rankMapFetchT0);
      }
      const ranksFresh = Persistence._rankMapsPlant === plant;
      wheelUsed = ranksFresh && _hasColorRanks();
      unrankedFields = Engine.unrankedActiveFields(plant);
    }

    // Which of this plant's ACTIVE priority fields would rank nothing? Confirm
    // when ANY of them would, not just colorWheel (N11,
    // docs/scheduling_priority.md): since Stage 3 every field in the tree
    // contributes a real sort term, so a plant that sequences purely on
    // prt01/prt02/productionVersion can be just as silently inert as one with a
    // missing wheel — and used to get no warning at all, including when the rank
    // fetch failed outright. A field the plant has switched OFF is not active,
    // so it is not in this list: optimizing without it is intentional, don't nag.
    //
    // unrankedActiveFields reads the same (possibly empty) cache the terms read,
    // so a failed/non-ok fetch surfaces here as "every active field unranked"
    // and needs no separate !ranksFresh branch. That also closes the case where
    // a failed REFETCH wiped the cache while _rankMapsPlant still matched:
    // ranksFresh was true, the old colorWheel probe found nothing, and the run
    // went ahead unranked and unannounced.
    if (unrankedFields.length && (mode === 'changeover' || mode === 'duedate')) {
      const names = unrankedFields.map(k => Util.t(`constraint.${k}`)).join(', ');
      const ok = await Modal.confirm({
        title: Util.t('modal.no_priority_ranks_confirm_msg', { plant, fields: names }),
      });
      if (!ok) { if (!exhaustive) OptimizerPreview.hideLoading(); restoreRunBtn(); _reshow(); return; }
    }

    // Gap C (2026-10-23): Optimize reads Store.plants/calendars, which fall back to the localStorage copy when the
    // plant calendar GET never landed. The reconcile already refuses to derive from an unhydrated calendar
    // (engine.mts, CalendarSync.calendarState); a run that would silently place against stale hours asks first.
    // This is the single entry for both the foreground and the background (exhaustive) run: run() is the only
    // caller of runInBackground. Cancel is the default and leaves the dialog state as it was.
    if (CalendarSync.calendarState(plant) !== 'hydrated') {
      const proceed = await Modal.confirm({
        title: Util.t('modal.opt_calendar_not_loaded_title'),
        message: Util.t('modal.opt_calendar_not_loaded_msg', { plant }),
        confirmLabel: Util.t('btn.opt_run_anyway'),
        tone: 'warn',
      });
      if (!proceed) { if (!exhaustive) OptimizerPreview.hideLoading(); restoreRunBtn(); _reshow(); return; }
    }

    // Tool Inventory (rule Hard only; Remove Backlog ignores the rule): the run must read loaded, current counts.
    if (mode !== 'backlog' && !(await ensureToolInventoryForRun(plant))) {
      if (!exhaustive) OptimizerPreview.hideLoading();
      restoreRunBtn();
      _reshow();
      return;
    }

    // The plant can change while the confirms above were open (the dialog closes on a header plant change, but a run
    // already past close(true) does not): never run against a plant the planner has left.
    if (Store.selectedPlant !== plant) {
      if (!exhaustive) OptimizerPreview.hideLoading();
      restoreRunBtn();
      return;
    }

    const linesScope = (scope === 'lines' && selectedLines.length) ? selectedLines : null;
    const optsForEngine: OptimizerRunOptions = {
      plant,
      lines:           linesScope,
      startDate:       winStart ?? (() => { const d = Store.plantNow(plant) ?? Store.serverNow(); d.setSeconds(0, 0); return d; })(),
      endDate:         winEnd   ?? new Date((Store.plantNow(plant) ?? Store.serverNow()).getTime() + 28 * Config.MS_DAY),
      respectFirmed:   sfEl?.checked ?? true,
      respectCalendar: mode === 'backlog' ? true : (scEl?.checked ?? true),
      runAt:           Store.serverNow(),
      searchBudgetMs:  exhaustive ? SETUP_AWARE_EXHAUSTIVE_BUDGET_MS : SETUP_AWARE_NORMAL_BUDGET_MS,
      exhaustive,
      auditDetails: mode === 'backlog' ? undefined : {
        mode,
        wheelUsed,
        taskCount: Store.tasksArr.length,
        scope,
        lines: linesScope || null,
        activePriorityFields: Engine.activeConstraintKeys(plant),
        unrankedPriorityFields: unrankedFields,
        splitOrderPolicy: Engine.splitOrderPolicyFor(plant),
        searchBudgetMs: exhaustive ? SETUP_AWARE_EXHAUSTIVE_BUDGET_MS : SETUP_AWARE_NORMAL_BUDGET_MS,
        exhaustive,
      },
    };

    if (exhaustive) {
      restoreRunBtn();
      void OptimizerPreview.runInBackground(mode, optsForEngine);
      return;
    }

    // Config modal was already hidden (close(true) above) before the rank-map
    // freshness guard — no second close() needed here.

    // Defer the optimizer run by one frame so the modal-close paint and the
    // heavy subscriber fanout don't fight for the same main-thread tick.
    // Route through OptimizerPreview (C4) — wraps Engine.runAndApply with
    // a pre/post KPI comparison and an apply/discard step.
    requestAnimationFrame(() => setTimeout(() => {
      OptimizerPreview.runWithPreview(mode, optsForEngine);
    }, 0));

  }

  /** Entry point of the Run button. Any exception in the pre-run steps (rank-map fetch, confirms, tool inventory) must
   *  not leave the spinner up and the button stuck on "Optimizing": restore both and log. */
  async function run() {
    const runBtn = document.getElementById('opt-run-btn') as HTMLButtonElement | null;
    const origRunHTML = runBtn ? runBtn.innerHTML : null;
    try {
      await _runImpl();
    } catch (err) {
      OptimizerPreview.hideLoading();
      if (runBtn) {
        runBtn.disabled = !_plant;
        if (origRunHTML !== null) runBtn.innerHTML = origRunHTML;
      }
      _reshow();
      ErrorLog.error('optimize', 'Optimize run failed before the preview started', err);
    }
  }

  function openFromPicker() {
    _initPickers();
    if (_start) _fpStart!.setDate(_start, false);
    Modal.open('modal-opt-from');
  }
  function cancelFromPicker() {
    if (_start) _fpStart?.setDate(_start, false);
    Modal.close('modal-opt-from');
  }
  function commitFrom() {
    const d = _fpStart && _fpStart.selectedDates[0];
    if (d) {
      _start = _timeMode ? new Date(d) : _dayStart(d);
      _startDirty = true;
      // Date mode: the From DAY is the floor, so a same-day To stays selectable.
      if (_fpEnd) _fpEnd.set('minDate', _timeMode ? _start : _dayStart(_start));
      if (!_timeMode && _end && _end.getTime() <= _start.getTime()) _end = _dayAfter(_start);
      _updateButtons();
    }
    Modal.close('modal-opt-from');
  }
  function openToPicker() {
    _initPickers();
    if (_end) _fpEnd!.setDate(_end, false);
    Modal.open('modal-opt-to');
  }
  function cancelToPicker() {
    if (_end) _fpEnd?.setDate(_end, false);
    Modal.close('modal-opt-to');
  }
  function commitTo() {
    const d = _fpEnd && _fpEnd.selectedDates[0];
    if (d) {
      _end = _timeMode ? new Date(d) : _dayAfter(d);
      _endDirty = true;
      if (!_timeMode && _start && _end.getTime() <= _start.getTime()) _end = _dayAfter(_start);
      _updateButtons();
    }
    Modal.close('modal-opt-to');
  }

  return { open, close, run, applyPreset, selectMode, _buildPlantSelect, _updatePlantBadge, setScope, filterLines, selectAllLines, _onLineToggle, openFromPicker, cancelFromPicker, commitFrom, openToPicker, cancelToPicker, commitTo, setTimeMode };
})();

/** Return shape of Util.scheduleKpis — same ReturnType<typeof ...> precedent as
 *  Hierarchy's HierarchyUtilMatrix / Dashboard's DashboardUtilMatrix (Task 4). */
type OptimizerKpis = ReturnType<typeof Util.scheduleKpis>;

/** Zero-filled fallback so pre/post KPI reads never need an intermediate
 *  `{}` — every OptimizerKpis field is a required number. */
const EMPTY_OPTIMIZER_KPIS: OptimizerKpis = { changeovers: 0, span_h: 0, late_count: 0, late_h: 0, peak_util_pct: 0, peak_util_pct_frozen: 0, peak_util_pct_open: 0 };

/** lowerIsBetter's four states — see the comment inside _render() for the full
 *  semantics of each (true/false/'soft'/null). */
type LowerIsBetter = boolean | 'soft' | null;

/** One KPI comparison card in the preview grid. */
interface OptimizerPreviewCard {
  label: string;
  k: keyof OptimizerKpis;
  ico: string;
  fmt: (v: number) => string;
  unit: string;
  lowerIsBetter: LowerIsBetter;
  tip: string;
}

interface PreviewExplanation {
  impact: {
    production: { before: number; after: number };
    setup: { before: number; after: number };
    occupiedHours: { before: number; after: number };
    lateness: { beforeOrders: number; afterOrders: number; beforeHours: number; afterHours: number };
    utilization: { before: number; after: number };
    sequences: { changed: number };
  };
  reasons: Array<{ code: string; message: string; line?: string; taskId?: string; outcome: 'accepted' | 'rejected' }>;
  constraints: string[];
  missingPairs: Array<{ line: string; predecessorOrderId?: string | null; successorOrderId?: string | null; fromState?: string | null; toState?: string | null; reason: string; remedy: string }>;
  missingPairsTotal: number;
  unchangedLines: string[];
  /** Tally of orders actually placed in this candidate without a resolvable
   *  setup transition (no changeover bar) — the never-freeze fallback,
   *  counted from the dedicated `'scheduled-without-setup'` missingEdge
   *  reason, which `placeUnknownTail` emits for a tail-placed order and (since
   *  A1) `candidateForSequence` also emits directly for a known-but-uncovered
   *  transition admitted into the covered-core sequence. Derived from
   *  `candidate.missingEdges` restricted to ids that appear in
   *  `candidate.patches`, so a rejected/unplaced edge never inflates this
   *  count (see `missingPairs` for the full uncovered-transition list). */
  scheduledWithoutSetup: { orders: number; lines: number };
  /** N6 twin of scheduledWithoutSetup for `'initial-state-unknown'` edges whose
   *  successor was actually patched — orders admitted as a line's first order
   *  with no recorded line state. */
  scheduledStateUnrecorded: { orders: number; lines: number };
  /** Placed, user-scheduled orders crossing the window end, held in place
   *  (`CandidateResult.windowEndHeldIds`). They drop out of the scoring. */
  windowEndHeld: { orders: number };
  /** B3: orders in scope for this run (plant + line filter + excludeFromOpt)
   *  that ended up with neither a patch nor a firmed/pinned exemption — i.e.
   *  "not scheduled". Derived by set difference against `candidate.patches`,
   *  never a field threaded through CandidateResult (see runAndApply's own
   *  B3 comment in schedule-services.mts for why: the worst drops produce no
   *  diagnostic object at all, so there is nothing else to collect from). */
  unplacedOrders: { orders: number; lines: number };
  search: { candidateCount: number; method: string; termination: string; runtimeMs: number; limitReached: boolean };
  /** Aggregate prune tally for the whole run (§4.3 docs/archive/OPTIMIZER-PREVIEW.md), bucketed
   *  from candidate.explanation's reason codes. Only genuinely exclusionary codes
   *  count — per-order placement/acceptance log entries (e.g. 'due-date-first-placement')
   *  are not prunes and are excluded, not rolled into 'other'. */
  prunes: { setup: number; firmed: number; capacity: number; other: number; total: number };
}

interface PreviewExplanationInput {
  productionBefore: number;
  productionAfter: number;
  preKpis: OptimizerKpis;
  postKpis: OptimizerKpis;
  /** B3: the run-scoped candidate pool (plant + opts.lines + excludeFromOpt,
   *  using the same plant resolution as B7) that `unplacedOrders` is diffed
   *  against. Omitted only by callers that don't want the tally (none today). */
  unplacedCandidates?: ReadonlyArray<{ id: string; line: string }>;
  /** Firmed/pinned ids — deliberately never moved, so never counted as unplaced. */
  firmedIds?: ReadonlySet<string> | ReadonlyArray<string>;
}

const PREVIEW_REASON_LIMIT = 8;
const PREVIEW_MISSING_PAIR_LIMIT = 12;

/** N6: map a MissingSetupEdge.reason to the planner's remedy. Only the two
 * admitted-at-zero reasons have a remedy; rejection reasons return null. */
export function remedyKeyForEdgeReason(reason: string): 'ui.setup_missing_remedy_state' | 'ui.setup_missing_remedy_row' | null {
  if (reason === 'initial-state-unknown') return 'ui.setup_missing_remedy_state';
  if (reason === 'scheduled-without-setup') return 'ui.setup_missing_remedy_row';
  return null;
}

/** Reason codes that represent a genuine exclusion (order/line left out of the
 *  plan), keyed to the §4.3 prune buckets. Codes not listed here are placement
 *  successes or policy-chooser notes (e.g. 'due-date-first-placement',
 *  'firmed-incoming-setup', 'covered-firmed-boundary-fallback') and must never be
 *  tallied as prunes — see docs/archive/OPTIMIZER-PREVIEW.md §4.3 open question 2. There is
 *  no 'color block' or 'due date' code in this engine today; only setup,
 *  firmed-boundary and capacity-deferral exclusions are ever emitted. */
const PRUNE_BUCKET_BY_CODE: Record<string, 'setup' | 'firmed' | 'capacity' | 'other'> = {
  'rejected-uncovered-transition': 'setup',
  'setup-incompatible': 'setup',
  'setup-sequence-infeasible': 'setup',
  'setup-definition-unavailable': 'setup',
  'spt-sequence-infeasible': 'setup',
  'setup-signature-incompatible': 'setup',
  'override-inactive': 'firmed',
  'firmed-boundary-infeasible': 'firmed',
  'firmed-boundary-fallback-ambiguous': 'firmed',
  'firmed-boundary-invalid': 'firmed',
  'incoming-firmed-setup-infeasible': 'firmed',
  'protected-firmed-boundary-outside-horizon': 'firmed',
  'due-work-unadmitted': 'capacity',
  'trailing-fragment-unadmitted': 'capacity',
  'unknown-setup-tail-unplaced': 'capacity',
  'initial-state-unknown': 'other',
  'firmed-boundary-state-unknown': 'other',
};

function tallyPrunes(explanation: ReadonlyArray<CandidateReason>): PreviewExplanation['prunes'] {
  const prunes = { setup: 0, firmed: 0, capacity: 0, other: 0, total: 0 };
  for (const reason of explanation) {
    const bucket = PRUNE_BUCKET_BY_CODE[reason.code];
    if (!bucket) continue;
    prunes[bucket] += 1;
    prunes.total += 1;
  }
  return prunes;
}

/** Target KPIs a finalist's whyNot sentence is scored against — the same three
 *  targets the verdict banner scores (changeovers, late_count, late_h); span_h
 *  and peak_util_pct are context-only, never part of a finalist's rationale.
 *  `phrase` renders the quantified delta the docs/archive/OPTIMIZER-PREVIEW.md §4.2 example
 *  uses ("one more late order and 65 h more slip"), not just a KPI name. */
const FINALIST_TARGET_KEYS: ReadonlyArray<{
  key: keyof OptimizerKpis;
  phrase: (n: number, worse: boolean) => string;
}> = [
  { key: 'changeovers', phrase: (n, worse) => `${n} ${worse ? 'more' : 'fewer'} changeover${n === 1 ? '' : 's'}` },
  { key: 'late_count', phrase: (n, worse) => `${n} ${worse ? 'more' : 'fewer'} late order${n === 1 ? '' : 's'}` },
  { key: 'late_h', phrase: (n, worse) => `${n.toFixed(1)} h ${worse ? 'more' : 'less'} slip` },
];

/** One-sentence rationale for why an alternate finalist wasn't applied. Compares
 *  only the scored targets against the applied plan — never fabricates a "best
 *  balance" claim, since this is a 2-wide mode-swap comparison, not a true beam
 *  (see docs/archive/OPTIMIZER-PREVIEW.md §6 fallback-tier note). */
function describeFinalistWhyNot(applied: OptimizerKpis, alt: OptimizerKpis): string {
  const worse: string[] = [];
  const better: string[] = [];
  for (const { key, phrase } of FINALIST_TARGET_KEYS) {
    const d = (alt[key] ?? 0) - (applied[key] ?? 0);
    if (Math.abs(d) < 0.05) continue;
    (d > 0 ? worse : better).push(phrase(Math.abs(d), d > 0));
  }
  if (!worse.length && !better.length) return Util.t('ui.opt_pv_plan_pruned_tie');
  if (worse.length && !better.length) return Util.t('ui.opt_pv_plan_pruned_worse', { list: worse.join(' and ') });
  if (better.length && !worse.length) return Util.t('ui.opt_pv_plan_pruned_better', { list: better.join(' and ') });
  return Util.t('ui.opt_pv_plan_pruned_mixed', { better: better.join(' and '), worse: worse.join(' and ') });
}

/** Tool Inventory: the plant's tooling rule plus its inventory rows, as one comparable string. A preview or a finished
 *  background run keeps the value it ran on; a different live value means the tool facts moved under it. Rows are sorted
 *  by tool id so the order the server returned them in never matters; an unloaded inventory is distinct from an empty one.
 *  The inventory part is null while the rule is not Hard: an Off plant never reads the counts, so a count change must not
 *  stale its preview (the rule itself is still part of the string, so flipping Off -> Hard does). */
export function toolFingerprint(masterData: NimbusMasterData | null | undefined, plant: string): string {
  const rule = toolingRuleForSnapshot({ masterData: masterData ?? null } as unknown as ScheduleSnapshot, plant);
  const inventory = masterData?.tool_inventory;
  const rows = rule !== 'hard' || inventory === undefined ? null : inventory
    .filter(row => !row.plant || row.plant === plant)
    .map(row => [String(row.tool_id), row.total_qty, row.out_of_service_qty] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify({ r: rule, i: rows });
}

function liveToolingRule(plant: string): 'off' | 'hard' {
  return toolingRuleForSnapshot({ masterData: Store.masterData ?? null } as unknown as ScheduleSnapshot, plant);
}

/** Optimize start, rule Hard only: make sure this plant's tool inventory is loaded and current before the run reads it.
 *  Not loaded -> one fetch; still not loaded -> ask (Cancel default: every tool would count as 1 copy). Loaded -> a cheap
 *  version probe, and a re-read only when the server's version differs from the one the held rows were read at.
 *  Resolves false when the planner cancelled. Backlog and rule Off never call this. */
export async function ensureToolInventoryForRun(plant: string): Promise<boolean> {
  if (liveToolingRule(plant) !== 'hard') return true;
  if (Store.masterData?.tool_inventory === undefined) {
    await Persistence.refreshToolInventory(plant);
    if (Store.masterData?.tool_inventory === undefined) {
      return Modal.confirm({
        title: Util.t('modal.opt_tool_inventory_not_loaded'),
        confirmLabel: Util.t('btn.opt_run_anyway'),
        tone: 'warn',
      });
    }
    return true;
  }
  await Persistence.ensureToolInventoryCurrent(plant);   // short, non-blocking: on timeout the run proceeds with the held rows
  return true;
}

const PREVIEW_TASK_CHANGE_EVENTS = new Set<StoreEvent['type']>([
  'task:update', 'tasks:bulkUpdate', 'tasks:bulk', 'task:remove',
]);

/** Canonicalize the complete task record so row_version, schedule edits, and
 *  every optimizer input participate in the preview baseline without relying
 *  on object insertion order. Task records are JSON-like data bags; Date gets
 *  an explicit representation because schedule fields are normalized Dates. */
function canonicalTaskBaselineValue(value: unknown): unknown {
  if (value instanceof Date) return { dateMs: value.getTime() };
  if (Array.isArray(value)) return value.map(canonicalTaskBaselineValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalTaskBaselineValue(record[key])]));
  }
  return value;
}

function taskBaseline(tasks: ReadonlyArray<NimbusTask>): Map<string, string> {
  return new Map(tasks.map(task => [String(task.id), JSON.stringify(canonicalTaskBaselineValue(task))]));
}

/* =============================================================================
   OPTIMIZER PREVIEW (C4) — wraps Engine.runAndApply so the planner sees a
   pre/post KPI comparison before committing. Discard reverts to the snapshot;
   Apply pushes an UndoStack entry so Ctrl+Z still works after the fact.
   ========================================================================== */
/** One Plan A/B/C comparison row held in `_finalists`. */
interface OptimizerFinalist { label: string; mode: OptimizerMode; kpis: OptimizerKpis; whyNot: string | null }
interface PreviewBacklogAudit {
  plant: string; lines: string[] | null; from: Date | null; to: Date | null; runAt: Date | null; timezone: string | null;
}
interface PreviewComputeContext {
  signal?: AbortSignal; tick: () => Promise<void>; shouldStop?: () => boolean; runSeq?: number;
  /** Called once Plan A and its explanation are ready, before any alternate
   *  runs, with the result so far (`finalists: null`). Foreground only. */
  onPrimary?: (partial: PreviewResult) => void;
}
/** Everything `computePreview` produces and `present` publishes into OptimizerPreview. */
interface PreviewResult {
  runSeq: number; mode: OptimizerMode; plant: string; opts: OptimizerRunOptions;
  snapshot: NimbusTask[]; taskBaseline: Map<string, string>;
  candidate: CandidateResult; finalists: OptimizerFinalist[] | null;
  preKpis: OptimizerKpis; postKpis: OptimizerKpis; explanation: PreviewExplanation;
  previewDiagnostics: CandidateDiagnostic[]; splitOrderPolicy: SplitOrderPolicy;
  backlogResult: RemoveBacklogResult | null; backlogAudit: PreviewBacklogAudit | null;
  auditDetails: OptimizationAuditDetails | null; syntheticSetup: boolean;
  startedAt: number; runtimeMs: number;
  /** `toolFingerprint` of the plant's tool facts when the run started (compared with the live Store later). */
  toolFingerprint?: string;
}

export const OptimizerPreview = {
  /** The "search hit its limit" note: an exhaustive run must not be told to choose Exhaustive. */
  _limitNoteKey(exhaustive: boolean): string {
    return exhaustive ? 'ui.opt_pv_diag_limit_reached_note_exhaustive' : 'ui.opt_pv_diag_limit_reached_note';
  },

  gapFillSummary(candidate: CandidateResult): string {
    const check = candidate.gapFill;
    if (!check) return '';
    return check.complete
      ? `Capacity check: ${check.placed} more order(s) placed; the rest can't fit without moving scheduled work.`
      : `Capacity check incomplete: ${check.placed} placed, ${check.unchecked} still unchecked.`;
  },

  planningSummary(candidate: CandidateResult, before: ReadonlyArray<NimbusTask>): {
    scheduled: number; needsPlanning: number; newlyQueued: number; protectedExceptions: number; incomplete: boolean;
  } {
    const dispositions = candidate.dispositions ?? [];
    const priorQueue = new Set(before.filter(task => task.planning_status === 'needs_planning').map(task => task.id));
    const queued = dispositions.filter(item => item.status === 'needs_planning');
    const protectedIds = new Set(dispositions.filter(item => item.status === 'protected').map(item => item.id));
    const protectedExceptions = new Set((candidate.validationFindings ?? [])
      .filter(item => item.code !== 'missing_setup' && item.taskId && protectedIds.has(item.taskId)).map(item => item.taskId)).size;
    return { scheduled: dispositions.filter(item => item.status === 'scheduled').length,
      needsPlanning: queued.length, newlyQueued: queued.filter(item => !priorQueue.has(item.id)).length,
      protectedExceptions, incomplete: candidate.searchComplete === false };
  },
  // A detached pre-run copy is needed only if the planner later applies the
  // candidate and wants Ctrl+Z. It is never used to roll a trial back.
  _snapshot: null as NimbusTask[] | null,
  _candidate: null as CandidateResult | null,
  _previewDiagnostics: [] as CandidateDiagnostic[],
  _preKpis:  null as OptimizerKpis | null,
  _postKpis: null as OptimizerKpis | null,
  _mode:     null as OptimizerMode | null,
  _plant:    null as string | null,
  _splitOrderPolicy: 'never' as SplitOrderPolicy,
  _backlogResult: null as RemoveBacklogResult | null,
  _backlogAudit: null as {
    plant: string; lines: string[] | null; from: Date | null; to: Date | null; runAt: Date | null; timezone: string | null;
  } | null,
  _auditDetails: null as OptimizationAuditDetails | null,
  _syntheticSetup: false,
  _explanation: null as PreviewExplanation | null,
  /** KPI vectors for the applied plan and one alternate mode — populated in
   *  runWithPreview BEFORE the single render (spinner-only until done),
   *  wiped in _clear. Patches are never retained. */
  _finalists: null as Array<{ label: string; mode: OptimizerMode; kpis: OptimizerKpis; whyNot: string | null }> | null,
  stale: false,
  _staleReason: null as string | null,
  _staleMessageKey: null as string | null,
  _taskBaseline: null as Map<string, string> | null,
  /** `Store.rev()` at which `_revalidateTaskBaseline` last confirmed the live plant matches `_taskBaseline`; null =
   *  never confirmed. Every Store write bumps rev, so an unchanged rev means an unchanged task set. Cleared whenever
   *  the baseline is replaced or the preview is cleared. */
  _baselineVerifiedRev: null as number | null,
  /** Tool facts (rule + inventory) the open preview ran on; null = unknown (never stales on tool changes). */
  _toolFingerprint: null as string | null,
  _taskWatchUnsubscribe: null as (() => void) | null,
  _applying: false,
  /** True for a result opened from the background-finished popup: when local edits stale it, Apply becomes
   *  "apply what still fits" (`applyPartial`) instead of being disabled. Reset by `_clear`. */
  _partialApplyAllowed: false,
  _applyLabelChanged: false,
  active:    false,  // true while detached candidate details await Apply/Discard
  _abandonGuardInstalled: false,
  /** Phase 2 (Pkg D): monotonic token, incremented at the top of every
   *  runWithPreview call. The deferred Plan B callback captures it at
   *  schedule time and bails silently if it no longer matches (a newer run
   *  started) or the preview is no longer active (applied/discarded/closed). */
  _runSeq: 0,
  /** Cancels the dedicated worker when a preview is superseded, discarded, or
   *  abandoned by the modal. The synchronous fallback remains available when
   *  the browser has no Worker implementation. */
  _workerAbortController: null as AbortController | null,

  /** Open the preview modal with a loading skeleton. Safe to call as soon as
   *  the user clicks Run, before any await/fetch — gives instant feedback so
   *  the user doesn't stare at a blurry frozen page during the wheel fetch
   *  + config-close transition + engine run. */
  showLoading(mode: OptimizerMode, plant: string) {
    OptimizerPreview._installAbandonGuard();
    const body = document.getElementById('opt-preview-body');
    if (body) {
      body.innerHTML =
        '<div class="cw-loading" style="justify-content:center;flex-direction:column;gap:10px;padding:40px 20px;">'
      + '  <div style="display:flex;align-items:center;gap:8px;">'
      + '    <span class="cw-spin"></span>'
      + `    <span style="font-size:14px;color:var(--fg);">${Util.escapeHtml(Util.t('ui.opt_pv_loading_title'))}</span>`
      + '  </div>'
      + `  <div style="font-size:12px;color:var(--fg-mute);">${Util.escapeHtml(Util.t('ui.opt_pv_loading_sub', { mode, plant }))}</div>`
      + '</div>';
    }
    const root = document.getElementById('modal-opt-preview');
    if (root) root.querySelectorAll<HTMLButtonElement>('.modal-foot button').forEach((b) => { b.disabled = true; });
    // Spinner-only until the primary plan AND the alternate comparisons are
    // all done: the .modal card is hidden by this class (see styles.css) and
    // revealed once, after the single full render.
    root?.classList.add('opt-pv-loading');
    Modal.open('modal-opt-preview');
  },

  /** Drop the spinner-only state so the .modal card shows. Idempotent. */
  _endLoadingState() {
    const root = typeof document === 'undefined' ? null : document.getElementById('modal-opt-preview');
    root?.classList.remove('opt-pv-loading');
  },

  /** Close the loading dialog without doing any work. For aborts (e.g. user
   *  cancels the no-color-wheel confirm) so the spinner doesn't linger. */
  hideLoading() {
    OptimizerPreview._endLoadingState();
    Modal.close('modal-opt-preview');
    const root = typeof document === 'undefined' ? null : document.getElementById('modal-opt-preview');
    if (root) root.querySelectorAll<HTMLButtonElement>('.modal-foot .btn-ghost').forEach((b) => { b.disabled = false; });
    OptimizerPreview._syncApplyButton();
  },

  /** Compact presentation facts only: candidate patches never carry a full
   * schedule, and this summary never retains one. */
  summarizeCandidate(candidate: CandidateResult, input: PreviewExplanationInput): PreviewExplanation {
    const rejected = /(?:unavailable|unknown|uncovered|infeasible|missing|disabled|fail)/i;
    const reasons = candidate.explanation.slice(0, PREVIEW_REASON_LIMIT).map(reason => ({
      code: reason.code, message: reason.message, line: reason.line, taskId: reason.taskId,
      outcome: rejected.test(`${reason.code} ${reason.message}`) ? 'rejected' as const : 'accepted' as const,
    }));
    const patchedIds = new Set(candidate.patches.map(patch => String(patch.id)));
    const scheduledWithoutSetupOrders = new Set<string>();
    const scheduledWithoutSetupLines = new Set<string>();
    // 'scheduled-without-setup' (F1) is the single dedicated reason for an
    // order actually placed without a resolvable setup transition — emitted
    // both by `placeUnknownTail` (tail placement) and, since A1, by
    // `candidateForSequence`'s in-sequence admission of a known-but-uncovered
    // transition. Counting this reason instead of the raw
    // 'successor-state-unknown'/'initial-state-unknown' partition edges
    // avoids double-counting a rejected permutation's edge that happens to
    // name the same patched id.
    const stateUnrecordedOrders = new Set<string>();
    const stateUnrecordedLines = new Set<string>();
    for (const edge of candidate.missingEdges) {
      if (!edge.successorOrderId || !patchedIds.has(String(edge.successorOrderId))) continue;
      if (edge.reason === 'scheduled-without-setup') {
        scheduledWithoutSetupOrders.add(String(edge.successorOrderId)); scheduledWithoutSetupLines.add(edge.line);
      } else if (edge.reason === 'initial-state-unknown') {
        stateUnrecordedOrders.add(String(edge.successorOrderId)); stateUnrecordedLines.add(edge.line);
      }
    }
    // B3: derive the unplaced set by difference from candidate.patches, not
    // from a threaded CandidateResult field — see the interface comment on
    // PreviewExplanation.unplacedOrders for why.
    const firmedIdSet = input.firmedIds instanceof Set
      ? input.firmedIds
      : new Set(Array.from(input.firmedIds ?? [], String));
    const unplacedOrderIds = new Set<string>();
    const unplacedLines = new Set<string>();
    for (const candidateTask of input.unplacedCandidates ?? []) {
      if (patchedIds.has(candidateTask.id) || firmedIdSet.has(candidateTask.id)) continue;
      unplacedOrderIds.add(candidateTask.id);
      unplacedLines.add(candidateTask.line);
    }
    return {
      impact: {
        production: { before: input.productionBefore, after: input.productionAfter },
        setup: { before: input.preKpis.changeovers, after: input.postKpis.changeovers },
        occupiedHours: { before: input.preKpis.span_h, after: input.postKpis.span_h },
        lateness: { beforeOrders: input.preKpis.late_count, afterOrders: input.postKpis.late_count, beforeHours: input.preKpis.late_h, afterHours: input.postKpis.late_h },
        utilization: { before: input.preKpis.peak_util_pct, after: input.postKpis.peak_util_pct },
        sequences: { changed: candidate.patches.length },
      },
      reasons,
      constraints: [...new Set(candidate.explanation.map(reason => reason.code))].slice(0, PREVIEW_REASON_LIMIT),
      missingPairs: [],
      missingPairsTotal: 0,
      unchangedLines: [...new Set(candidate.unchangedLines)].slice(0, PREVIEW_REASON_LIMIT),
      scheduledWithoutSetup: { orders: scheduledWithoutSetupOrders.size, lines: scheduledWithoutSetupLines.size },
      scheduledStateUnrecorded: { orders: stateUnrecordedOrders.size, lines: stateUnrecordedLines.size },
      windowEndHeld: { orders: new Set(candidate.windowEndHeldIds ?? []).size },
      unplacedOrders: { orders: unplacedOrderIds.size, lines: unplacedLines.size },
      prunes: tallyPrunes(candidate.explanation),
      search: {
        candidateCount: candidate.diagnostics.candidateCount, method: candidate.diagnostics.method,
        termination: candidate.diagnostics.termination, runtimeMs: candidate.diagnostics.runtimeMs,
        limitReached: candidate.diagnostics.limitReached,
      },
    };
  },

  /** Derive only the state labels needed to review bounded missing edges while
   * the detached snapshot is still in scope. No task list is retained. */
  describeMissingPairs(candidate: CandidateResult, tasks: ReadonlyArray<NimbusTask>, setup: SetupSnapshot | null): { pairs: PreviewExplanation['missingPairs']; total: number } {
    const definition = setup?.definition;
    const byId = new Map(tasks.map(task => [String(task.id), task]));
    const text = (state: SetupStateKey | null | undefined) => state?.map(part => part.value).join(' · ') || null;
    const pairs = candidate.missingEdges.slice(0, PREVIEW_MISSING_PAIR_LIMIT).map(edge => {
      const predecessor = edge.predecessorOrderId ? byId.get(String(edge.predecessorOrderId)) : undefined;
      const successor = edge.successorOrderId ? byId.get(String(edge.successorOrderId)) : undefined;
      const lineState = definition
        ? setup?.machine_states.find(state => state.machine === edge.line && state.signature_version === definition.signature_version)?.state_key
        : null;
      return {
        line: edge.line,
        predecessorOrderId: edge.predecessorOrderId ?? null,
        successorOrderId: edge.successorOrderId ?? null,
        fromState: text(definition && predecessor ? stateForOrder(predecessor, definition) : lineState),
        toState: text(definition && successor ? stateForOrder(successor, definition) : null),
        reason: edge.reason,
        remedy: (() => { const key = remedyKeyForEdgeReason(edge.reason); return key ? Util.t(key) : ''; })(),
      };
    });
    return { pairs, total: candidate.missingEdges.length };
  },

  /** CSV of the tool-blocked list (every entry, not just the 50 shown); each cell goes through Util.csvCell. */
  toolBlockedCsv(
    entries: ReadonlyArray<{ orderId: string; tool: string; available: number; inUse: number; holderIds: readonly string[]; cause?: string }>,
    labelOf: (id: string) => string = id => id,
    linesById: ReadonlyMap<string, string> = new Map(),
  ): string {
    const header = ['order', 'line', 'tool', 'available', 'in_use', 'holders', 'cause'];
    return [header, ...entries.map(entry => [
      labelOf(entry.orderId), linesById.get(String(entry.orderId)) ?? '', entry.tool, entry.available, entry.inUse,
      entry.holderIds.map(labelOf).join(' '), entry.cause === 'cascade' ? 'cascade' : 'tool',
    ])].map(row => row.map(Util.csvCell).join(',')).join('\n');
  },

  missingPairsCsv(pairs: ReadonlyArray<PreviewExplanation['missingPairs'][number]>): string {
    // Util.csvCell: RFC-4180 quoting AND the spreadsheet formula guard (a state/order value
    // starting with = + - @ must not execute when the planner opens the export in Excel).
    const quote = (value: unknown) => Util.csvCell(value);
    return ['Line,Predecessor order,Successor order,From setup state,To setup state,Reason,Remedy', ...pairs.map(pair =>
      [pair.line, pair.predecessorOrderId, pair.successorOrderId, pair.fromState, pair.toState, pair.reason, pair.remedy].map(quote).join(','))].join('\n');
  },

  canApply(): boolean {
    if (!OptimizerPreview.active || OptimizerPreview.stale || !OptimizerPreview._candidate
      || !OptimizerPreview._snapshot || !OptimizerPreview._taskBaseline) return false;
    if (OptimizerPreview._candidate.validationFindings?.some(finding => finding.severity === 'error')) return false;
    return OptimizerPreview._revalidateTaskBaseline();
  },

  /** Partial apply is open only for a background result that local task edits staled; setup writes and
   *  engine re-derivations keep their own banner and still block Apply. */
  _canApplyPartial(): boolean {
    const pv = OptimizerPreview;
    return pv._partialApplyAllowed && pv.stale && pv._staleMessageKey === 'ui.opt_preview_task_stale'
      && pv.active && !!pv._candidate && !!pv._snapshot && !!pv._taskBaseline
      && !pv._candidate.validationFindings?.some(finding => finding.severity === 'error' && !finding.taskId);
  },

  _staleMessage(): string {
    return Util.t(OptimizerPreview._staleMessageKey || 'ui.opt_stale_banner');
  },

  /** Compare the complete preview-plant task set against the detached baseline.
   *  This catches changed fields/versions, additions, plant moves, and removals. */
  _revalidateTaskBaseline(): boolean {
    if (OptimizerPreview.stale) return false;
    const baseline = OptimizerPreview._taskBaseline;
    const plant = OptimizerPreview._plant;
    if (!OptimizerPreview.active || !baseline || !plant) return false;
    const rev = Store.rev();
    if (OptimizerPreview._baselineVerifiedRev === rev) return true;
    const taskCtx = { lineSettings: Store.lineSettings, masterData: Store.masterData };
    const current = taskBaseline(Store.tasksArr.filter(task => resolveTaskPlant(task, taskCtx) === plant));
    let matches = current.size === baseline.size;
    if (matches) {
      for (const [id, value] of baseline) {
        if (current.get(id) !== value) { matches = false; break; }
      }
    }
    if (!matches) OptimizerPreview._markTaskStale('preview-plant task baseline changed');
    else OptimizerPreview._baselineVerifiedRev = rev;
    return matches;
  },

  _startTaskWatch(): void {
    OptimizerPreview._stopTaskWatch();
    OptimizerPreview._taskWatchUnsubscribe = Store.subscribe(event => {
      // Tool Inventory / tooling rule edits (any session's, via the freshness probe too) stale an open preview: the
      // numbers and the Tool-blocked list were computed against the old counts.
      if (event.type === 'master-data-changed') {
        const table = (event as unknown as { table?: string }).table;
        if (OptimizerPreview.active && OptimizerPreview._toolFingerprint !== null && OptimizerPreview._plant
          && (table === 'tool_inventory' || table === 'plants')
          && toolFingerprint(Store.masterData, OptimizerPreview._plant) !== OptimizerPreview._toolFingerprint) {
          OptimizerPreview._markTaskStale('tool inventory or tooling rule changed', 'ui.opt_stale_banner_tooling');
        }
        return;
      }
      if (!OptimizerPreview.active || !OptimizerPreview._taskBaseline
        || !PREVIEW_TASK_CHANGE_EVENTS.has(event.type)) return;
      // Group 26: the engine re-deriving starts (run time changed, calendar landed) under an open preview makes
      // its numbers stale whatever the field-level comparison says; Apply is disabled with its own banner.
      if (event.source === 'engine-runtime-reconcile') {
        const rawIds = (event as unknown as { ids?: unknown }).ids;
        const ids = Array.isArray(rawIds) ? rawIds.map(String) : null;
        if (!ids || ids.some(id => OptimizerPreview._taskBaseline!.has(id))) {
          OptimizerPreview._markTaskStale('engine re-derived starts while the preview was open', 'ui.preview_stale');
          return;
        }
      }
      if (OptimizerPreview._applying && event.source === 'engine') return;
      OptimizerPreview._revalidateTaskBaseline();
    }, 'OptimizerPreview.tasks');
  },

  _stopTaskWatch(): void {
    OptimizerPreview._taskWatchUnsubscribe?.();
    OptimizerPreview._taskWatchUnsubscribe = null;
  },

  _markTaskStale(reason: string, messageKey = 'ui.opt_preview_task_stale'): void {
    if (OptimizerPreview.stale) return;
    OptimizerPreview.stale = true;
    OptimizerPreview._staleReason = reason;
    OptimizerPreview._staleMessageKey = messageKey;
    OptimizerPreview._syncApplyButton();
    if (typeof document !== 'undefined') OptimizerPreview._render();
  },

  /** Single place that decides whether Apply is clickable — always derived
   *  from canApply(), never poked ad hoc. Replaces three separate direct-DOM
   *  writers (showLoading's blanket disable, hideLoading's blanket enable,
   *  markSetupStale's manual disable) that could disagree with each other. */
  _syncApplyButton(): void {
    const button = typeof document === 'undefined' ? null : document.getElementById('opt-preview-apply-btn') as HTMLButtonElement | null;
    if (!button) return;
    const fullApply = OptimizerPreview.canApply();
    const partial = !fullApply && OptimizerPreview._canApplyPartial();
    const applyable = fullApply || partial;
    if (partial) {
      button.textContent = Util.t('ui.opt_pv_apply_fits');
      OptimizerPreview._applyLabelChanged = true;
    } else if (OptimizerPreview._applyLabelChanged) {
      button.textContent = Util.t('btn.opt_pv_apply');
      OptimizerPreview._applyLabelChanged = false;
    }
    button.disabled = !applyable;
    button.title = applyable ? '' : (OptimizerPreview.stale
      ? OptimizerPreview._staleMessage()
      : Util.t('ui.setup_preview_apply_not_ready_title'));
  },

  /** Setup writes make comparison facts stale; they never rerun or apply a
   * candidate. The planner must explicitly run again. */
  markSetupStale(plant: string, kind: string): void {
    if (!OptimizerPreview.active || !OptimizerPreview._candidate || OptimizerPreview._plant !== plant) return;
    OptimizerPreview.stale = true;
    OptimizerPreview._staleReason = `${kind} setup data changed`;
    OptimizerPreview._staleMessageKey = 'ui.opt_stale_banner';
    OptimizerPreview._syncApplyButton();
    if (typeof document !== 'undefined') OptimizerPreview._render();
  },

  /** One-time safety net: the modal's backdrop is wired (like every other modal's)
   *  to close on an outside click, bypassing discard()/apply() entirely (app.js's
   *  boot-time '.modal-backdrop' click handler calls Modal.close() directly). Left
   *  alone, that would leave detached candidate details and `active` stuck true.
   *  Treat any non-apply/discard hide as a discard. */
  _installAbandonGuard() {
    if (OptimizerPreview._abandonGuardInstalled) return;
    OptimizerPreview._abandonGuardInstalled = true;
    const el = document.getElementById('modal-opt-preview');
    if (!el) return;
    new MutationObserver(() => {
      if (el.hidden && OptimizerPreview.active) OptimizerPreview.discard();
    }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
  },

  /** Entry point — call this instead of Engine.runAndApply when you want
   *  the preview UI. Mirrors Engine.runAndApply's signature. */
  runWithPreview(mode: OptimizerMode = 'changeover', opts: OptimizerRunOptions = {}) {
    // Phase 2 (Pkg D): monotonic run token, captured by the deferred Plan B
    // callback below so it can detect a superseding run and bail silently.
    // The guards come first: an early return must not abort the previous run or bump the token, and it must take down
    // the spinner OptimizeDialog.run() already raised.
    if (!Store.tasksArr.length) { OptimizerPreview.hideLoading(); Toast.show(Util.t('toast.no_tasks_to_optimise'), 'error'); return; }
    const plant = opts.plant ?? Store.selectedPlant;
    if (!plant) { OptimizerPreview.hideLoading(); Toast.show(Util.t('toast.select_plant_before_opt'), 'warn'); return; }
    OptimizerPreview._workerAbortController?.abort();
    const workerAbortController = typeof AbortController === 'function' ? new AbortController() : null;
    OptimizerPreview._workerAbortController = workerAbortController;
    const runSeq = ++OptimizerPreview._runSeq;
    OptimizerPreview._previewDiagnostics = [];

    // OptimizeDialog.run() already called showLoading(); only open it here if
    // the dialog is not up, so the body is never rewritten a second time.
    const previewRoot = document.getElementById('modal-opt-preview');
    if (previewRoot?.hidden) OptimizerPreview.showLoading(mode, plant);
    const footBtns: HTMLButtonElement[] = previewRoot
      ? Array.from(previewRoot.querySelectorAll<HTMLButtonElement>('.modal-foot button'))
      : [];
    const body = document.getElementById('opt-preview-body');

    // Double rAF to ensure the loading skeleton actually paints before we
    // block the main thread with the optimizer. Single rAF schedules a frame
    // but synchronous work afterward can still preempt the paint.
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      const _optTotalT0 = performance.now();
      try {
        // The foreground run owns the modal from here: `active` lets
        // apply/discard/abandon (all route through _clear()) be seen by
        // shouldStop below.
        OptimizerPreview.active = true;
        const computed = OptimizerPreview._driveCompute(OptimizerPreview._computeSteps(mode, opts, {
          signal: workerAbortController?.signal,
          // One alt per tick: requestAnimationFrame + setTimeout(0) yields to
          // the event loop (and a paint) so the spinner keeps animating.
          tick: () => new Promise<void>(resolve => requestAnimationFrame(() => { setTimeout(resolve, 0); })),
          // A Store setup write landing mid-way (markStale) would make further
          // alts evaluate against setup data Plan A never saw. Stop comparing
          // and reveal Plan A alone (Apply is blocked by the stale flag anyway).
          shouldStop: () => OptimizerPreview.stale || !OptimizerPreview.active || OptimizerPreview._runSeq !== runSeq,
          runSeq,
          // Publish Plan A's state before the alternates compute (the modal
          // stays spinner-only; the single render still waits for the alts).
          onPrimary: partial => { OptimizerPreview._installPreviewResult(partial); },
        }));
        const result = computed instanceof Promise ? await computed : computed;
        // Race safety: bail silently unless this preview is still the one the
        // user is waiting on. `active` catches apply/discard/abandon;
        // `_runSeq` catches a newer runWithPreview already in flight, so a
        // slow superseded run can never resurrect stale finalists or issue an
        // orphan render.
        if (!OptimizerPreview.active || OptimizerPreview._runSeq !== runSeq) return;
        OptimizerPreview.present(result, { open: true });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          // A newer preview or an explicit discard owns the modal now. Do not
          // replace its state with an obsolete worker cancellation error.
          if (OptimizerPreview._runSeq === runSeq && OptimizerPreview.active) OptimizerPreview._clear();
          return;
        }
        const errMsg = err instanceof Error ? err.message : undefined;
        OptimizerPreview._previewDiagnostics = [{
          level: 'error',
          scope: 'optimize-preview',
          code: 'candidate-evaluation-failed',
          message: errMsg || String(err),
          context: { mode, plant },
        }];
        // Evaluation is detached, so failures leave Store untouched.
        OptimizerPreview._clear(true);
        if (body) {
          body.innerHTML =
            '<div style="padding:24px;text-align:center;color:var(--err);">'
          + `  <div style="font-size:14px;margin-bottom:8px;">${Util.escapeHtml(Util.t('ui.opt_pv_failed_title'))}</div>`
          + `  <div style="font-size:12px;color:var(--fg-mute);">${Util.escapeHtml(errMsg || 'Unknown error')}</div>`
          + '</div>';
        }
        footBtns.forEach((b) => { b.disabled = false; });
        OptimizerPreview._syncApplyButton();
      } finally {
        PerfMonitor.record('Optimize.total', performance.now() - _optTotalT0);
      }
    }));
  },

  /** Compute-only half of a preview run: evaluates the primary plan and every
   *  alternate against a detached snapshot and returns the result. Touches no
   *  OptimizerPreview state and no DOM, so a background run can compute while
   *  the modal is closed; `present()` publishes the result. `tick` is awaited
   *  between alternates; `shouldStop` ends the comparison early, keeping Plan A
   *  alone (foreground: superseded / discarded / stale; background: never). */
  computePreview(mode: OptimizerMode, opts: OptimizerRunOptions, ctx: PreviewComputeContext): Promise<PreviewResult> {
    return (async () => OptimizerPreview._driveCompute(OptimizerPreview._computeSteps(mode, opts, ctx)))();
  },

  /** Run a compute generator, resolving synchronously when it never yields a
   *  promise (sync evaluator, no alternates) and as a Promise otherwise. The
   *  foreground path depends on that: its state must be installed in the same
   *  tick as the evaluation when everything is synchronous. */
  _driveCompute(gen: Generator<Promise<unknown>, PreviewResult, unknown>): PreviewResult | Promise<PreviewResult> {
    const step = (next: () => IteratorResult<Promise<unknown>, PreviewResult>): PreviewResult | Promise<PreviewResult> => {
      const r = next();
      if (r.done) return r.value;
      return r.value.then(
        value => step(() => gen.next(value)),
        err => step(() => gen.throw(err)),
      );
    };
    return step(() => gen.next());
  },

  /** The compute body as a generator: every `yield` hands a promise to the driver. */
  *_computeSteps(
    mode: OptimizerMode,
    opts: OptimizerRunOptions,
    { signal, tick, shouldStop = () => false, runSeq = 0, onPrimary }: PreviewComputeContext,
  ): Generator<Promise<unknown>, PreviewResult, unknown> {
    const startedAt = performance.now();
    const plant = opts.plant ?? Store.selectedPlant;
    if (!plant) throw new Error('computePreview requires a plant');
    // Snapshot every task in the plant — the optimizer may touch any of
    // them transitively (auto-reflow can ripple beyond the chosen window
    // / lines), so the undo snapshot must stay unfiltered. `plant` scopes
    // only calendars (Phase 2, Pkg D clone reduction) — every consumer of
    // this snapshot's `calendars` only ever looks up a line that already
    // passed this same plant's task filter (see snapshotSchedule's doc
    // comment), so no other plant's calendar entries are ever needed here.
    const candidateSnapshot = snapshotSchedule(plant);
    const scopedTasks = candidateSnapshot.tasks.filter(task => resolveTaskPlant(task, candidateSnapshot) === plant);
    const _snapT0 = performance.now();
    // Kept only for the Undo entry if the planner applies.
    const snapshot = structuredClone(scopedTasks);
    const baseline = taskBaseline(snapshot);
    PerfMonitor.record('Optimize.snapshot', performance.now() - _snapT0);

    // KPI inputs are scoped to what the user actually selected on screen 1 —
    // time window and (optionally) a subset of lines. Otherwise the before/after
    // comparison drowns the user's slice in out-of-scope tasks.
    const winStart = opts.startDate ? opts.startDate.getTime() : -Infinity;
    const winEnd   = opts.endDate   ? opts.endDate.getTime()   :  Infinity;
    const lineSet  = (Array.isArray(opts.lines) && opts.lines.length) ? new Set(opts.lines) : null;
    const inScope = (t: NimbusTask): boolean => {
      if (lineSet && !lineSet.has(t.MACHINE)) return false;
      if (t.planning_status === 'needs_planning') return true;
      const s = t.start_date ? t.start_date.getTime() : null;
      if (s == null) return false;
      const e = Util.scheduledEnd(t);
      const eMs = e ? e.getTime() : s;
      return eMs >= winStart && s <= winEnd;
    };

    // Pre-KPIs from the (filtered) snapshot — it IS the current state right now.
    const _preKpiT0 = performance.now();
    const preKpis = Util.scheduleKpis(snapshot.filter(inScope), 14, candidateSnapshot, candidateSnapshot.frozenHorizonEnd);
    PerfMonitor.record('Optimize.preKPIs', performance.now() - _preKpiT0);

    // Evaluate the established placement algorithm against a detached read
    // model. Store changes only if the planner applies this candidate.
    // Phase 2 (Pkg D): the primary run's deadline is now an explicit,
    // once-computed `deadlineAt` rather than letting the engine derive a
    // fresh SETUP_AWARE_DEADLINE_MS window internally — same numeric
    // budget, no behavior change, but the option now exists so the
    // (deferred) alt run below no longer inherits a full fresh one.
    const _evalPrimaryT0 = performance.now();
    const deadlineAt = performance.now() + (opts.searchBudgetMs ?? SETUP_AWARE_NORMAL_BUDGET_MS);
    const primaryEvaluation = runOptimizerPreview({
      runId: `optimizer-preview-${runSeq}-primary`, mode, snapshot: candidateSnapshot,
      request: previewEvaluationRequest(mode, opts, plant, deadlineAt),
    }, {
      signal,
      syncEvaluator: evaluateSchedule,
    });
    const candidate = (primaryEvaluation instanceof Promise ? yield primaryEvaluation : primaryEvaluation) as CandidateResult;
    PerfMonitor.record('Optimize.evaluate.primary', performance.now() - _evalPrimaryT0);
    // A reversed or unparseable window yields no proposal at all: say why instead of rendering an empty plan.
    if (candidate.status === 'invalid_horizon') {
      throw new Error(candidate.explanation[0]?.message || Util.t('toast.opt_window_invalid'));
    }

    // Post-KPIs are calculated from detached patched task values.
    const _applyPatchesT0a = performance.now();
    const postTasks = applyPatchesToSnapshot(candidateSnapshot.tasks, candidate.patches).filter(inScope);
    PerfMonitor.record('Optimize.applyPatches', performance.now() - _applyPatchesT0a);
    const _postKpiT0 = performance.now();
    const postKpis  = Util.scheduleKpis(postTasks, 14, candidateSnapshot, candidateSnapshot.frozenHorizonEnd);
    PerfMonitor.record('Optimize.postKPIs', performance.now() - _postKpiT0);

    const previewDiagnostics = [...candidate.diagnostics.events];
    const capturedValidation = candidate.validationContext;
    const capturedSnapshot = capturedValidation?.snapshot ?? candidateSnapshot;
    const capturedBounds = capturedValidation?.bounds;
    const capturedSetup = capturedBounds?.setup
      ?? (capturedSnapshot.setupSnapshot?.plant === plant ? capturedSnapshot.setupSnapshot : null);
    const capturedSplitPolicy = capturedSnapshot.masterData?.plants?.find(row => row.plant === plant)?.split_order_policy;
    const splitOrderPolicy: SplitOrderPolicy = capturedSplitPolicy === 'overlong_only' || capturedSplitPolicy === 'partial_allowed'
      ? capturedSplitPolicy : 'never';
    const backlogResult = mode === 'backlog' ? candidate.backlogResult ?? null : null;
    const backlogAudit: PreviewBacklogAudit | null = mode === 'backlog' ? {
      plant,
      lines: Array.isArray(opts.lines) ? opts.lines : null,
      from: opts.startDate ?? null,
      to: opts.endDate ?? null,
      runAt: opts.runAt instanceof Date ? opts.runAt : null,
      timezone: candidateSnapshot.masterData?.plants?.find(p => p.plant === plant)?.timezone ?? null,
    } : null;
    const auditDetails = mode === 'backlog' ? null : opts.auditDetails ?? null;
    const syntheticSetup = mode !== 'backlog' && capturedBounds?.setup.synthetic === true;
    // B3: the same run-scoped candidate pool used for the KPI comparison
    // (plant, via `scopedTasks` above using the B7 line→plant fallback,
    // plus opts.lines and excludeFromOpt) — NOT the time-windowed
    // `inScope`, since an order outside the KPI window can still be
    // legitimately "not scheduled" by this run.
    const unplacedCandidates = scopedTasks
      .filter(t => !lineSet || lineSet.has(t.MACHINE))
      .filter(t => !candidateSnapshot.lineSettings[t.MACHINE || '']?.excludeFromOpt)
      .map(t => ({ id: String(t.id), line: t.MACHINE || 'Unknown' }));
    // Explanations must describe the same detached facts that produced the
    // candidate. In particular, never recapture live setup/frozen state or
    // a new wall clock after a worker has returned.
    const runNow = capturedBounds?.runNow ?? capturedBounds?.now
      ?? (opts.runNow ? new Date(opts.runNow as Date | string | number) : opts.startDate ? new Date(opts.startDate) : new Date());
    const explanationFirmedIds = capturedValidation?.snapshot?.firmedIds
      ?? effectiveFirmedIdSet(candidateSnapshot.tasks, candidateSnapshot.firmedIds, runNow, opts.respectFirmed ?? true, candidateSnapshot.frozenHorizonEnd);
    const explanation = OptimizerPreview.summarizeCandidate(candidate, {
      productionBefore: snapshot.filter(inScope).length,
      productionAfter: postTasks.length,
      preKpis,
      postKpis,
      unplacedCandidates,
      firmedIds: explanationFirmedIds,
    });
    const described = OptimizerPreview.describeMissingPairs(
      candidate,
      capturedSnapshot.tasks,
      capturedSetup,
    );
    explanation.missingPairs = described.pairs;
    explanation.missingPairsTotal = described.total;
    const base: PreviewResult = {
      runSeq, mode, plant, opts, snapshot, taskBaseline: baseline,
      candidate, finalists: null,
      preKpis, postKpis, explanation, previewDiagnostics, splitOrderPolicy,
      backlogResult, backlogAudit, auditDetails, syntheticSetup,
      startedAt, runtimeMs: 0,
      // Backlog never reads tool facts, so it carries no fingerprint (never stale on a tool change, no chip).
      toolFingerprint: mode === 'backlog' ? undefined : toolFingerprint(candidateSnapshot.masterData, plant),
    };
    onPrimary?.(base);

    // Alternate-mode KPI vectors — the only data needed for the plan
    // comparison table. Each primary mode can have multiple alternates
    // (e.g. Changeover's alts are SPT and Due Date) — evaluated one at a
    // time with a yield per alt (see the loop below), never in one
    // synchronous pass, so a single alt's up-to-SETUP_AWARE_DEADLINE_MS
    // search can't compound into a multi-alt main-thread freeze. All of
    // them finish before the preview is rendered or revealed.
    const altModeMap: Partial<Record<OptimizerMode, OptimizerMode[]>> = {
      changeover: ['spt', 'duedate'],
      spt: ['changeover', 'duedate'],
      duedate: ['spt', 'changeover'],
    };
    const altModes = altModeMap[mode] ?? [];

    // Compute every alternate BEFORE the first (and only) render, so the
    // popup opens once, fully populated; spinner-only until then. One alt
    // per tick() so the caller's spinner keeps animating.
    const finalists: OptimizerFinalist[] = [
      { label: 'A', mode, kpis: postKpis, whyNot: null },
    ];
    for (let idx = 0; idx < altModes.length; idx++) {
      yield tick();
      if (signal?.aborted) { const e = new Error('Aborted'); e.name = 'AbortError'; throw e; }
      // The foreground's shouldStop covers a superseded/discarded run and a
      // mid-way stale flag: stop comparing and keep Plan A alone (the
      // foreground caller re-checks supersession and bails silently).
      if (shouldStop()) { finalists.length = 1; break; }
      const altMode = altModes[idx];
      try {
        const _evalAltT0 = performance.now();
        const altDeadlineAt = performance.now() + SETUP_AWARE_NORMAL_BUDGET_MS;
        const altEvaluation = runOptimizerPreview({
          runId: `optimizer-preview-${runSeq}-alt-${idx}`, mode: altMode, snapshot: candidateSnapshot,
          request: previewEvaluationRequest(altMode, { ...opts, searchBudgetMs: SETUP_AWARE_NORMAL_BUDGET_MS, exhaustive: false }, plant, altDeadlineAt),
        }, {
          signal,
          syncEvaluator: evaluateSchedule,
        });
        const altCandidate = (altEvaluation instanceof Promise ? yield altEvaluation : altEvaluation) as CandidateResult;
        PerfMonitor.record('Optimize.evaluate.alt', performance.now() - _evalAltT0);
        const _applyPatchesT0b = performance.now();
        const altPostTasks = applyPatchesToSnapshot(candidateSnapshot.tasks, altCandidate.patches).filter(inScope);
        PerfMonitor.record('Optimize.applyPatches', performance.now() - _applyPatchesT0b);
        const altKpis = Util.scheduleKpis(altPostTasks, 14, candidateSnapshot, candidateSnapshot.frozenHorizonEnd);
        finalists.push({
          label: String.fromCharCode(66 + idx), // 'B', 'C', ...
          mode: altMode, kpis: altKpis,
          whyNot: describeFinalistWhyNot(postKpis, altKpis),
        });
      } catch (altErr: unknown) {
        // A cancelled run (newer preview / discard) must not fall through to a render.
        if (altErr instanceof Error && altErr.name === 'AbortError') throw altErr;
        /* this alt failed — omit it; other alts (and Plan A) still show */
      }
      // The await above may have outlived this preview.
      if (shouldStop()) { finalists.length = 1; break; }
    }

    return { ...base, finalists: finalists.length > 1 ? finalists : null, runtimeMs: performance.now() - startedAt };
  },

  /** Publish a computed preview into OptimizerPreview state. With
   *  `open: true` it also reveals the modal (single render); with
   *  `open: false` the state is installed silently (no body write). A result
   *  already installed via `onPrimary` only gains its finalists (the stale
   *  flag, which may have been raised meanwhile, is left alone). */
  present(result: PreviewResult, { open }: { open: boolean }): void {
    if (OptimizerPreview._candidate === result.candidate) OptimizerPreview._finalists = result.finalists;
    else OptimizerPreview._installPreviewResult(result);
    if (!open) return;
    const previewRoot = document.getElementById('modal-opt-preview');
    if (previewRoot?.hidden) OptimizerPreview.showLoading(result.mode, result.plant);
    previewRoot?.querySelectorAll<HTMLButtonElement>('.modal-foot button').forEach((b) => { b.disabled = false; });
    OptimizerPreview._syncApplyButton();
    OptimizerPreview._render();
    OptimizerPreview._endLoadingState();
    previewRoot?.querySelector<HTMLElement>('.modal-head button')?.focus();
  },

  /** Install every field of a (possibly primary-only) result and start the
   *  task watch. Resets the stale flag: the result is fresh by construction. */
  _installPreviewResult(result: PreviewResult): void {
    OptimizerPreview._snapshot = result.snapshot;
    OptimizerPreview._taskBaseline = result.taskBaseline;
    OptimizerPreview._baselineVerifiedRev = null;
    OptimizerPreview._toolFingerprint = result.toolFingerprint ?? null;
    OptimizerPreview._preKpis  = result.preKpis;
    OptimizerPreview._postKpis = result.postKpis;
    OptimizerPreview._candidate = result.candidate;
    OptimizerPreview._previewDiagnostics = result.previewDiagnostics;
    OptimizerPreview._mode     = result.mode;
    OptimizerPreview._plant    = result.plant;
    OptimizerPreview._splitOrderPolicy = result.splitOrderPolicy;
    OptimizerPreview._backlogResult = result.backlogResult;
    OptimizerPreview._backlogAudit = result.backlogAudit;
    OptimizerPreview._auditDetails = result.auditDetails;
    OptimizerPreview._syntheticSetup = result.syntheticSetup;
    OptimizerPreview._explanation = result.explanation;
    OptimizerPreview._finalists = result.finalists;
    OptimizerPreview.stale = false;
    OptimizerPreview._staleReason = null;
    OptimizerPreview._staleMessageKey = null;
    OptimizerPreview.active = true;
    OptimizerPreview._startTaskWatch();
  },

  _render() {
    const body = document.getElementById('opt-preview-body');
    if (!body) return;
    const pre  = OptimizerPreview._preKpis  || EMPTY_OPTIMIZER_KPIS;
    const post = OptimizerPreview._postKpis || EMPTY_OPTIMIZER_KPIS;
    const backlog = OptimizerPreview._backlogResult?.diagnostics ?? null;
    const explanation = OptimizerPreview._explanation;

    // Each card: { label, k, ico, fmt, lowerIsBetter, tip }.
    // lowerIsBetter: true → decrease=better (green), increase=worse (red).
    //                false → increase=better (green), decrease=worse (red).
    //                'soft' → decrease=better (green, counts as KPI win),
    //                         increase=warn (amber, no verdict penalty). Used for
    //                         span and peak utilization where shrinking is desirable
    //                         but growing shouldn't be flagged as a regression.
    //                null → neutral in both directions.
    const cards: OptimizerPreviewCard[] = [
      {
        label: Util.t('ui.opt_pv_card_changeovers'), k: 'changeovers', ico: '&#8635;',
        fmt: (v) => String(v), unit: '', lowerIsBetter: true,
        tip: Util.t('ui.opt_pv_card_changeovers_tip'),
      },
      {
        label: Util.t('ui.opt_pv_card_span'), k: 'span_h', ico: '&#8596;',
        fmt: (v) => v.toFixed(1), unit: 'h', lowerIsBetter: 'soft',
        tip: Util.t('ui.opt_pv_card_span_tip'),
      },
      {
        label: Util.t('ui.opt_pv_card_late'), k: 'late_count', ico: '&#9201;',
        fmt: (v) => String(v), unit: '', lowerIsBetter: true,
        tip: Util.t('ui.opt_pv_card_late_tip'),
      },
      {
        label: Util.t('ui.opt_pv_card_lateness'), k: 'late_h', ico: '&#8721;',
        fmt: (v) => v.toFixed(1), unit: 'h', lowerIsBetter: true,
        tip: Util.t('ui.opt_pv_card_lateness_tip'),
      },
      {
        label: Util.t('ui.opt_pv_card_util_frozen'), k: 'peak_util_pct_frozen', ico: '&#9650;',
        fmt: (v) => String(v), unit: '%', lowerIsBetter: 'soft',
        tip: Util.t('ui.opt_pv_card_util_frozen_tip'),
      },
      {
        label: Util.t('ui.opt_pv_card_util_open'), k: 'peak_util_pct_open', ico: '&#9650;',
        fmt: (v) => String(v), unit: '%', lowerIsBetter: 'soft',
        tip: Util.t('ui.opt_pv_card_util_open_tip'),
      },
    ];

    // Verdict: score against the three targets only (changeovers, late_count, late_h).
    // span_h and peak_util_pct are context — they affect card color but never the verdict.
    const directional = cards.filter(c => c.lowerIsBetter === true);
    let better = 0, worse = 0;
    for (const c of directional) {
      const d = (post[c.k] ?? 0) - (pre[c.k] ?? 0);
      if (Math.abs(d) < 0.05) { continue; }
      if (d < 0) better++;
      else worse++;
    }
    let verdictTone: string, verdictTitle: string, verdictSub: string;
    if (better === 0 && worse === 0) {
      verdictTone = 'neutral';
      verdictTitle = Util.t('ui.opt_pv_verdict_neutral_title');
      verdictSub = Util.t('ui.opt_pv_verdict_neutral_sub');
    } else if (worse === 0) {
      verdictTone = 'better';
      verdictTitle = better === directional.length ? Util.t('ui.opt_pv_verdict_big_win_title') : Util.t('ui.opt_pv_verdict_improved_title');
      verdictSub = Util.t('ui.opt_pv_verdict_better_sub', { better, total: directional.length, targets: directional.length });
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

    const backlogHtml = (() => {
      if (!backlog) return '';
      const rows: Array<[string, string]> = [
        [Util.t('ui.opt_pv_backlog_found'), String(backlog.backlogFound)],
        [Util.t('ui.opt_pv_backlog_moved'), String(backlog.moved)],
        [Util.t('ui.opt_pv_backlog_firmed_moved'), String(backlog.firmedMoved)],
        [Util.t('ui.opt_pv_backlog_frozen_moved'), String(backlog.frozenMoved)],
        [Util.t('ui.opt_pv_backlog_runtime'), `${backlog.movedRuntimeHours.toFixed(1)} h`],
        [Util.t('ui.opt_pv_backlog_largest_delay'), `${backlog.largestDelayMinutes} min`],
      ];
      if (backlog.invalidRuntimeIds.length) rows.push([Util.t('ui.opt_pv_backlog_skipped_runtime'), String(backlog.invalidRuntimeIds.length)]);
      if (backlog.missingStartIds.length) rows.push([Util.t('ui.opt_pv_backlog_skipped_start'), String(backlog.missingStartIds.length)]);
      if (backlog.overlongIds.length) rows.push([Util.t('ui.opt_pv_backlog_overlong'), String(backlog.overlongIds.length)]);
      if (backlog.calendarSearchFailures.length) rows.push([Util.t('ui.opt_pv_backlog_capacity_fail'), String(backlog.calendarSearchFailures.length)]);
      const summary = backlog.backlogFound === 0 && backlog.moved === 0 && !backlog.invalidRuntimeIds.length && !backlog.missingStartIds.length
        ? `<div class="opt-pv-backlog-empty">${Util.escapeHtml(Util.t('ui.opt_pv_backlog_empty'))}</div>`
        : '';
      const boundary = backlog.boundaryConflicts.length
        ? `<div class="opt-pv-backlog-warning">${Util.t('ui.opt_pv_backlog_boundary', { count: backlog.boundaryConflicts.length })}</div>`
        : '';
      return `<section class="opt-pv-backlog"><div class="opt-pv-backlog-title">${Util.escapeHtml(Util.t('ui.opt_pv_backlog_title'))}</div>${summary}<div class="opt-pv-backlog-grid">${rows.map(([label, value]) => `<div><span>${Util.escapeHtml(label)}</span><strong>${Util.escapeHtml(value)}</strong></div>`).join('')}</div>${boundary}</section>`;
    })();

    const modeLabel = OptimizerPreview._mode ? Util.t('us.opt_mode_' + OptimizerPreview._mode) : '';
    const plant = OptimizerPreview._plant || '';
    const splitPolicyLabel: Record<SplitOrderPolicy, string> = {
      never: Util.t('ui.opt_pv_split_none'),
      overlong_only: Util.t('ui.opt_pv_split_overlong'),
      partial_allowed: Util.t('ui.opt_pv_split_partial'),
    };
    const splitPolicy = OptimizerPreview._splitOrderPolicy;
    const stamp = Util._fmtTimePref(new Date());
    const whyHtml = (() => {
      if (!explanation) return '';
      const constraints = explanation.constraints.join(', ') || Util.t('ui.setup_constraints_none');
      const unchangedCount = explanation.unchangedLines.length;
      const finalists = OptimizerPreview._finalists;

      let planTableHtml = '';
      if (finalists) {
        const fmtDelta = (d: number, lb: LowerIsBetter, fmt: (v: number) => string, unit: string): string => {
          if (Math.abs(d) < 0.05) return '';
          const sign = d < 0 ? '−' : '+';
          const cls = lb === true
            ? (d < 0 ? 'opt-pv-plan-delta-ok' : 'opt-pv-plan-delta-err')
            : lb === 'soft'
              ? (d < 0 ? 'opt-pv-plan-delta-ok' : 'opt-pv-plan-delta-warn')
              : 'opt-pv-plan-delta-mute';
          return `<span class="${cls}">${sign}${Util.escapeHtml(fmt(Math.abs(d)))}${Util.escapeHtml(unit)}</span>`;
        };
        const bodyRows = cards.map(c => {
          const preV = pre[c.k] ?? 0;
          const currentCell = `<td class="opt-pv-plan-current">${Util.escapeHtml(c.fmt(preV))}${Util.escapeHtml(c.unit)}</td>`;
          const dataCells = finalists!.map((f, i) => {
            const val = f.kpis[c.k] ?? 0;
            const delta = fmtDelta(val - preV, c.lowerIsBetter, c.fmt, c.unit);
            return i === 0
              ? `<td class="opt-pv-plan-applied-cell"><span class="opt-pv-plan-val-applied">${Util.escapeHtml(c.fmt(val))}${Util.escapeHtml(c.unit)}</span>${delta}</td>`
              : `<td>${Util.escapeHtml(c.fmt(val))}${Util.escapeHtml(c.unit)}${delta}</td>`;
          }).join('');
          return `<tr><th scope="row" title="${Util.escapeHtml(c.tip)}">${Util.escapeHtml(c.label)}</th>${currentCell}${dataCells}</tr>`;
        }).join('');
        const headCells = finalists.map((f, i) => i === 0
          ? `<th class="opt-pv-plan-applied-head"><div>${Util.escapeHtml(Util.t('ui.opt_pv_plan_col_applied'))}</div><div class="opt-pv-plan-col-sub">${Util.escapeHtml(Util.t('us.opt_mode_' + f.mode))}</div></th>`
          : `<th><div>${Util.escapeHtml(Util.t('ui.opt_pv_plan_col_alt', { label: f.label }))}</div><div class="opt-pv-plan-col-sub">${Util.escapeHtml(Util.t('us.opt_mode_' + f.mode))}</div></th>`
        ).join('');
        const verdictCells = finalists.map((f, i) => i === 0
          ? `<td class="opt-pv-plan-applied-cell"><strong>${Util.escapeHtml(Util.t('ui.opt_pv_plan_chosen'))}</strong></td>`
          : `<td><strong>${Util.escapeHtml(f.whyNot || Util.t('ui.opt_pv_plan_pruned'))}</strong></td>`
        ).join('');
        planTableHtml = `<div class="opt-pv-plan-wrap"><table class="opt-pv-plan-table">
          <thead><tr><th></th><th><div>${Util.escapeHtml(Util.t('ui.opt_pv_plan_col_current'))}</div><div class="opt-pv-plan-col-sub">${Util.escapeHtml(Util.t('ui.opt_pv_plan_col_current_sub'))}</div></th>${headCells}</tr></thead>
          <tbody>${bodyRows}</tbody>
          <tfoot class="opt-pv-plan-tfoot"><tr><th scope="row">${Util.escapeHtml(Util.t('ui.opt_pv_plan_verdict_label'))}</th><td>${Util.escapeHtml(Util.t('ui.opt_pv_plan_baseline'))}</td>${verdictCells}</tr></tfoot>
        </table></div>`;
      }

      // §4.3 — aggregate prune tally for the whole run. Only rendered when at
      // least one genuinely exclusionary reason code fired (see tallyPrunes).
      let prunesHtml = '';
      const p = explanation.prunes;
      if (p && p.total > 0) {
        const rows: Array<{ label: string; count: number; warn?: boolean }> = [
          { label: Util.t('ui.opt_pv_prune_setup'), count: p.setup, warn: true },
          { label: Util.t('ui.opt_pv_prune_firmed'), count: p.firmed },
          { label: Util.t('ui.opt_pv_prune_capacity'), count: p.capacity },
          { label: Util.t('ui.opt_pv_prune_other'), count: p.other },
        ].filter(row => row.count > 0).sort((a, b) => b.count - a.count);
        const max = Math.max(...rows.map(row => row.count), 1);
        const barsHtml = rows.map(row => `<div class="opt-pv-prune-row">
          <span class="opt-pv-prune-label">${Util.escapeHtml(row.label)}</span>
          <span class="opt-pv-prune-track"><span class="opt-pv-prune-fill${row.warn ? ' warn' : ''}" style="width:${Math.round((row.count / max) * 100)}%"></span></span>
          <span class="opt-pv-prune-count">${Util.escapeHtml(String(row.count))}</span>
        </div>`).join('');
        prunesHtml = `<div class="opt-pv-prunes">
          <div class="opt-pv-prunes-head">
            <span class="opt-pv-prunes-title">${Util.escapeHtml(Util.t('ui.opt_pv_prunes_title'))}</span>
            <span class="opt-pv-prunes-total">${Util.escapeHtml(Util.t('ui.opt_pv_prunes_total', { count: p.total }))}</span>
          </div>
          ${barsHtml}
          ${p.setup > 0 ? `<p class="opt-pv-prune-footnote">${Util.escapeHtml(Util.t('ui.opt_pv_prune_footnote', { count: p.setup }))}</p>` : ''}
        </div>`;
      }

      return `<details class="opt-pv-section" open>
        <summary class="opt-pv-section-head"><span class="opt-pv-section-title">${Util.escapeHtml(Util.t('ui.opt_pv_why_title'))}</span></summary>
        <div class="opt-pv-section-body">
          ${planTableHtml}
          ${prunesHtml}
          <dl class="opt-pv-meta-list">
            <div><dt>${Util.escapeHtml(Util.t('ui.setup_constraints_label'))}</dt><dd>${Util.escapeHtml(constraints)}</dd></div>
            <div><dt>${Util.escapeHtml(Util.t('ui.opt_pv_lines_changed'))}</dt><dd>${unchangedCount > 0 ? Util.escapeHtml(Util.t('ui.opt_pv_lines_unchanged_count', { count: unchangedCount })) : Util.escapeHtml(Util.t('ui.setup_unchanged_lines_none'))}</dd></div>
            <div><dt>${Util.escapeHtml(Util.t('ui.opt_pv_sequences_changed_label'))}</dt><dd>${Util.escapeHtml(String(explanation.impact.sequences.changed))}</dd></div>
          </dl>
        </div>
      </details>`;
    })();

    const gapsHtml = (() => {
      if (!explanation) return '';
      const pairCount = explanation.missingPairs.length;
      const totalPairs = explanation.missingPairsTotal;
      const isTruncated = totalPairs > pairCount;
      const truncatedNote = isTruncated
        ? `<p class="opt-pv-section-intro">${Util.escapeHtml(Util.t('ui.opt_pv_gaps_truncated', { shown: pairCount, total: totalPairs }))}</p>`
        : '';
      const canReview = (globalThis as unknown as { NIMBUS?: { SetupAdmin?: { canReviewMissingPairs?: (plant: string) => boolean } } }).NIMBUS?.SetupAdmin?.canReviewMissingPairs?.(plant) === true;
      const body = pairCount
        ? `${truncatedNote}<div class="setup-table-wrap"><table class="setup-table"><thead><tr><th>${Util.escapeHtml(Util.t('ui.setup_col_line'))}</th><th>${Util.escapeHtml(Util.t('ui.setup_col_from'))}</th><th>${Util.escapeHtml(Util.t('ui.setup_col_to'))}</th><th>${Util.escapeHtml(Util.t('ui.setup_col_reason'))}</th><th>${Util.escapeHtml(Util.t('ui.setup_col_remedy'))}</th></tr></thead><tbody>${explanation.missingPairs.map(pair => `<tr><td>${Util.escapeHtml(pair.line)}</td><td>${Util.escapeHtml(pair.fromState || '—')}</td><td>${Util.escapeHtml(pair.toState || '—')}</td><td>${Util.escapeHtml(pair.reason)}</td><td>${Util.escapeHtml(pair.remedy || '—')}</td></tr>`).join('')}</tbody></table></div><div class="opt-pv-footer-note">${canReview ? `<button class="btn btn-primary sm" data-opt-review-missing>${Util.escapeHtml(Util.t('btn.opt_fill_setup_matrix'))}</button> ` : ''}<button class="btn btn-ghost sm" data-opt-copy-missing>${Util.escapeHtml(Util.t('btn.setup_copy_missing'))}</button> <button class="btn btn-ghost sm" data-opt-export-missing>${Util.escapeHtml(Util.t('btn.setup_export_missing'))}</button></div>`
        : `<p class="opt-pv-section-empty">${Util.escapeHtml(Util.t('ui.setup_missing_pairs_none'))}</p>`;
      const badge = pairCount ? `<span class="opt-pv-section-badge">${isTruncated ? Util.t('ui.opt_pv_gaps_badge', { count: totalPairs }) : pairCount}</span>` : '';
      return `<details class="opt-pv-section">
        <summary class="opt-pv-section-head"><span class="opt-pv-section-title">${Util.escapeHtml(Util.t('ui.opt_pv_gaps_title'))}</span>${badge}</summary>
        <div class="opt-pv-section-body">
          <p class="opt-pv-section-intro">${Util.escapeHtml(Util.t('ui.opt_pv_gaps_intro'))}</p>
          ${body}
        </div>
      </details>`;
    })();

    const diagHtml = (() => {
      if (!explanation) return '';
      // The search being truncated by a deadline / iteration cap (rather than
      // converging) is the one diagnostic that changes what the planner should
      // do about the result, so it is surfaced on the collapsed summary too.
      const diagSummary = Util.t('ui.opt_pv_diag_summary', {
        method: explanation.search.method,
        count: explanation.search.candidateCount,
        runtime: `${explanation.search.runtimeMs.toFixed(0)} ms`,
      });
      const limitBadge = explanation.search.limitReached
        ? `<span class="opt-pv-section-badge" title="${Util.escapeHtml(Util.t(OptimizerPreview._limitNoteKey(OptimizerPreview._auditDetails?.exhaustive === true)))}">${Util.escapeHtml(Util.t('ui.opt_pv_diag_limit_reached'))}</span>`
        : '';
      const diagEvents = OptimizerPreview._previewDiagnostics.filter(e => e.level === 'error' || e.level === 'warn');
      const eventsHtml = diagEvents.length
        ? `<ul class="opt-pv-diag-events">${diagEvents.map(e => `<li class="opt-pv-diag-event opt-pv-diag-${Util.escapeHtml(e.level)}"><strong>${Util.escapeHtml(e.level.toUpperCase())}</strong> ${Util.escapeHtml(e.message)}</li>`).join('')}</ul>`
        : '';
      // Derived, not stored on `search` — candidateCount / (runtimeMs / 1000),
      // rounded, guarded against divide-by-zero and non-finite candidateCount
      // so a zero/degenerate runtime omits the row rather than rendering
      // NaN/Infinity.
      const { candidateCount, runtimeMs } = explanation.search;
      const rateHtml = runtimeMs > 0 && Number.isFinite(candidateCount)
        ? `<div><dt>${Util.escapeHtml(Util.t('ui.opt_pv_diag_rate'))}</dt><dd>${Util.escapeHtml(String(Math.round(candidateCount / (runtimeMs / 1000))))}</dd></div>`
        : '';
      return `<details class="opt-pv-section">
        <summary class="opt-pv-section-head"><span class="opt-pv-section-title">${Util.escapeHtml(Util.t('ui.opt_pv_diag_title'))}</span><span class="opt-pv-section-summary">${Util.escapeHtml(diagSummary)}</span>${limitBadge}</summary>
        <div class="opt-pv-section-body">
          <dl class="opt-pv-meta-list">
            <div><dt>${Util.escapeHtml(Util.t('ui.setup_search_label'))}</dt><dd>${Util.escapeHtml(explanation.search.method)}</dd></div>
            <div><dt>${Util.escapeHtml(Util.t('ui.opt_pv_diag_candidates'))}</dt><dd>${Util.escapeHtml(String(explanation.search.candidateCount))}</dd></div>
            <div><dt>${Util.escapeHtml(Util.t('ui.opt_pv_diag_termination'))}</dt><dd>${Util.escapeHtml(explanation.search.termination)}</dd></div>
            <div><dt>${Util.escapeHtml(Util.t('ui.opt_pv_diag_runtime'))}</dt><dd>${explanation.search.runtimeMs.toFixed(0)} ms</dd></div>
            <div><dt>${Util.escapeHtml(Util.t('ui.opt_pv_diag_orders_in_scope'))}</dt><dd>${Util.escapeHtml(String(explanation.impact.production.before))} → ${Util.escapeHtml(String(explanation.impact.production.after))}</dd></div>
            ${rateHtml}
          </dl>
          ${explanation.search.limitReached ? `<p class="opt-pv-section-intro opt-pv-diag-limit">${Util.escapeHtml(Util.t(OptimizerPreview._limitNoteKey(OptimizerPreview._auditDetails?.exhaustive === true)))}</p>` : ''}
          ${eventsHtml}
        </div>
      </details>`;
    })();

    const staleHtml = OptimizerPreview.stale
      ? `<div class="opt-pv-stale">${Util.escapeHtml(OptimizerPreview._staleMessage())}</div>`
      : '';

    // Never-freeze fallback banner — orders this candidate actually placed
    // without a resolvable setup transition (no changeover bar). Sits beside
    // the "Why this plan" (unchanged lines) and "Setup gaps" (missingPairs)
    // sections rather than inside either, since it summarizes what got
    // scheduled anyway, not what's still missing from the matrix.
    const scheduledWithoutSetupHtml = (explanation && explanation.scheduledWithoutSetup.orders > 0)
      ? `<div class="opt-pv-backlog-warning">${Util.escapeHtml(Util.t('ui.opt_pv_scheduled_without_setup', {
          orders: explanation.scheduledWithoutSetup.orders,
          lines: explanation.scheduledWithoutSetup.lines,
        }))}</div>`
      : '';

    // N6 twin banner — 'initial-state-unknown' admissions (the line's current
    // setup state was never recorded), invisible in the row-only banner above.
    const scheduledStateUnrecordedHtml = (explanation && explanation.scheduledStateUnrecorded.orders > 0)
      ? `<div class="opt-pv-backlog-warning">${Util.escapeHtml(Util.t('ui.opt_pv_scheduled_state_unrecorded', {
          orders: explanation.scheduledStateUnrecorded.orders,
          lines: explanation.scheduledStateUnrecorded.lines,
        }))}</div>`
      : '';

    // Orders crossing the window end are fixed, not optimized; say so, since
    // they drop out of lateness/instability scoring and Needs Planning.
    const windowEndHeldHtml = (explanation && explanation.windowEndHeld.orders > 0)
      ? `<div class="opt-pv-backlog-warning">${Util.escapeHtml(Util.t('ui.opt_pv_window_end_held', {
          orders: explanation.windowEndHeld.orders,
        }))}</div>`
      : '';

    // Per-card markup
    const cardsHtml = cards.map(c => {
      const preV  = pre[c.k]  ?? 0;
      const postV = post[c.k] ?? 0;
      const d = postV - preV;
      const isInt = Number.isInteger(preV) && Number.isInteger(postV);
      const absD = Math.abs(d);
      const zero = absD < 0.05;

      // Direction class
      let dirCls = 'neutral';
      if (!zero && c.lowerIsBetter !== null) {
        if (c.lowerIsBetter === 'soft') {
          dirCls = d < 0 ? 'better' : 'warn';
        } else {
          const improved = c.lowerIsBetter ? d < 0 : d > 0;
          dirCls = improved ? 'better' : 'worse';
        }
      }

      // Delta number + percent
      const sign = d > 0 ? '+' : (d < 0 ? '−' : '');
      const dNum = isInt ? `${Math.abs(d)}` : absD.toFixed(1);
      const pct = (preV !== 0) ? Math.round((d / preV) * 100) : null;
      const pctStr = (pct !== null && !zero)
        ? ` <span class="opt-pv-pct">(${pct > 0 ? '+' : '−'}${Math.abs(pct)}%)</span>`
        : '';
      const deltaText = zero
        ? `<span class="opt-pv-pill-icon">●</span> ${Util.escapeHtml(Util.t('ui.opt_pv_no_change'))}`
        : `<span class="opt-pv-pill-icon">${dirCls === 'better' ? '▼' : (dirCls === 'worse' || dirCls === 'warn') ? '▲' : '◆'}</span> ${sign}${dNum}${c.unit}${pctStr}`;

      // Bar — visual scale of post vs pre. For neutral/no scale, hide.
      const maxV = Math.max(preV, postV, 0.0001);
      const preW  = Math.max(2, Math.round((preV / maxV) * 100));
      const postW = Math.max(2, Math.round((postV / maxV) * 100));

      return `
        <div class="opt-pv-card opt-pv-card-${dirCls}" data-key="${c.k}">
          <div class="opt-pv-card-head">
            <span class="opt-pv-card-ico">${c.ico}</span>
            <span class="opt-pv-card-label">${Util.escapeHtml(c.label)}</span>
            <span class="opt-pv-card-help" tabindex="0" aria-label="${Util.escapeHtml(Util.t('ui.opt_pv_card_help_aria'))}">
              <span class="opt-pv-help-dot">?</span>
              <span class="opt-pv-tip">${Util.escapeHtml(c.tip)}</span>
            </span>
          </div>
          <div class="opt-pv-card-body">
            <div class="opt-pv-num opt-pv-num-pre">
              <div class="opt-pv-num-lbl">${Util.escapeHtml(Util.t('ui.opt_pv_before_label'))}</div>
              <div class="opt-pv-num-val">${c.fmt(preV)}<span class="opt-pv-num-unit">${c.unit}</span></div>
            </div>
            <div class="opt-pv-arrow">→</div>
            <div class="opt-pv-num opt-pv-num-post">
              <div class="opt-pv-num-lbl">${Util.escapeHtml(Util.t('ui.opt_pv_after_label'))}</div>
              <div class="opt-pv-num-val">${c.fmt(postV)}<span class="opt-pv-num-unit">${c.unit}</span></div>
            </div>
          </div>
          <div class="opt-pv-bars">
            <div class="opt-pv-bar-row"><span class="opt-pv-bar-tag">pre</span><div class="opt-pv-bar"><i class="opt-pv-bar-fill pre" style="width:${preW}%"></i></div></div>
            <div class="opt-pv-bar-row"><span class="opt-pv-bar-tag">post</span><div class="opt-pv-bar"><i class="opt-pv-bar-fill post ${dirCls}" style="width:${postW}%"></i></div></div>
          </div>
          <div class="opt-pv-delta-pill ${dirCls}">${deltaText}</div>
        </div>`;
    }).join('');

    const planning = OptimizerPreview._candidate?.dispositions
      ? OptimizerPreview.planningSummary(OptimizerPreview._candidate, OptimizerPreview._snapshot ?? []) : null;
    const protectedIds = new Set(OptimizerPreview._candidate?.dispositions?.filter(item => item.status === 'protected').map(item => item.id));
    const protectedFindings = (OptimizerPreview._candidate?.validationFindings ?? [])
      .filter(item => item.code !== 'missing_setup' && item.taskId && protectedIds.has(item.taskId));
    const orderLabels = new Map((OptimizerPreview._snapshot ?? []).map(task => [task.id, task.PRODUCTION_ORDER || task.ORDER || task.id]));
    const planningHtml = planning ? `<div class="opt-pv-footer-note" role="status">
      <strong>${planning.scheduled} scheduled · ${planning.needsPlanning} Needs Planning (${planning.newlyQueued} newly queued)</strong>
      ${planning.incomplete ? '<div>Search incomplete — best proposal found within budget.</div>' : ''}
      ${OptimizerPreview._candidate?.gapFill ? `<div>${Util.escapeHtml(OptimizerPreview.gapFillSummary(OptimizerPreview._candidate))}</div>` : ''}
      ${(OptimizerPreview._candidate?.validationFindings ?? []).filter(finding => finding.severity === 'error')
        .map(finding => `<div>${Util.escapeHtml(finding.message)}</div>`).join('')}
    </div>` : '';

    const protectedHtml = protectedFindings.length ? `<details class="opt-pv-section">
      <summary class="opt-pv-section-head"><span class="opt-pv-section-title">Protected orders requiring attention</span><span class="opt-pv-section-badge">${protectedFindings.length}</span></summary>
      <div class="opt-pv-section-body">
        <div>${protectedFindings.length} order(s) have existing protected-schedule conflicts — locked in place, can't be moved.</div>
        <ul>${protectedFindings.slice(0, 50)
          .map(item => `<li>${Util.escapeHtml(String(orderLabels.get(item.taskId!) ?? item.taskId))} · ${Util.escapeHtml(item.line ?? '')}: ${Util.escapeHtml(item.message)}</li>`).join('')}</ul>
        ${protectedFindings.length > 50 ? '<div>Showing the first 50 findings. Review the remaining orders in Orders.</div>' : ''}
      </div>
    </details>` : '';

    // P3a — distribution_separation findings: always severity 'warning', filtered
    // by code (not severity) since other warning-severity codes exist that aren't
    // part of this feature. Never gates Apply (see canApply, which only checks
    // severity === 'error'). One finding per violating sibling-order group.
    const distributionSeparationFindings = (OptimizerPreview._candidate?.validationFindings ?? [])
      .filter(item => item.code === 'distribution_separation');
    const distributionSeparationHtml = distributionSeparationFindings.length ? `<details class="opt-pv-section">
      <summary class="opt-pv-section-head"><span class="opt-pv-section-title">${Util.escapeHtml(Util.t('ui.opt_pv_distribution_separation_head'))}</span><span class="opt-pv-section-badge">${distributionSeparationFindings.length}</span></summary>
      <div class="opt-pv-section-body">
        <ul>${distributionSeparationFindings.slice(0, 50)
          .map(item => `<li>${Util.escapeHtml(item.message)}</li>`).join('')}</ul>
        ${distributionSeparationFindings.length > 50 ? '<div>Showing the first 50 findings. Review the remaining orders in Orders.</div>' : ''}
      </div>
    </details>` : '';
    // Tool Inventory (all of this is empty/absent while the candidate carries no toolBlocked/toolMoved/toolPass).
    const toolBlocked = OptimizerPreview._candidate?.toolBlocked ?? [];
    const toolMovedCount = new Set((OptimizerPreview._candidate?.toolMoved ?? []).map(entry => entry.orderId)).size;
    const toolIncomplete = OptimizerPreview._candidate?.toolPass?.complete === false;
    const linesById = new Map((OptimizerPreview._snapshot ?? []).map(task => [String(task.id), task.MACHINE || '']));
    const labelOf = (id: string): string => String(orderLabels.get(id) ?? id);
    const toolBlockedHtml = toolBlocked.length ? `<details class="opt-pv-section" data-opt-tool-section>
      <summary class="opt-pv-section-head"><span class="opt-pv-section-title">${Util.escapeHtml(Util.t('ui.opt_tool_blocked_title', { n: toolBlocked.length }))}</span><span class="opt-pv-section-badge">${toolBlocked.length}</span></summary>
      <div class="opt-pv-section-body">
        <div><button type="button" class="btn btn-sm" data-opt-tool-export>${Util.escapeHtml(Util.t('ui.opt_tool_export'))}</button></div>
        <table class="opt-pv-tool-table">
          <thead><tr><th>${Util.escapeHtml(Util.t('ui.opt_tool_col_order'))}</th><th>${Util.escapeHtml(Util.t('ui.opt_tool_col_line'))}</th><th>${Util.escapeHtml(Util.t('ui.opt_tool_col_tool'))}</th><th>${Util.escapeHtml(Util.t('ui.opt_tool_col_avail'))}</th><th>${Util.escapeHtml(Util.t('ui.opt_tool_col_holders'))}</th><th></th></tr></thead>
          <tbody>${toolBlocked.slice(0, 50).map(entry => {
            const holders = entry.holderIds.slice(0, 5).map(labelOf).join(', ') + (entry.holderIds.length > 5 ? ` ${Util.t('ui.opt_bg_more', { count: entry.holderIds.length - 5 })}` : '');
            return `<tr${entry.cause === 'cascade' ? ' data-opt-tool-cascade' : ''}><td>${Util.escapeHtml(labelOf(entry.orderId))}${entry.cause === 'cascade' ? `<div class="opt-pv-tool-cascade">${Util.escapeHtml(Util.t('ui.opt_tool_cascade_note'))}</div>` : ''}</td><td>${Util.escapeHtml(linesById.get(String(entry.orderId)) ?? '')}</td><td>${Util.escapeHtml(entry.tool)}</td><td>${entry.available} / ${entry.inUse}</td><td>${Util.escapeHtml(holders)}</td><td><button type="button" class="btn btn-sm" data-opt-tool-raise="${Util.escapeHtml(entry.tool)}">${Util.escapeHtml(Util.t('ui.opt_tool_raise'))}</button></td></tr>`;
          }).join('')}</tbody>
        </table>
        ${toolBlocked.length > 50 ? `<div>${Util.escapeHtml(Util.t('ui.opt_tool_first_50'))}</div>` : ''}
      </div>
    </details>` : '';
    const toolNoteHtml = (toolMovedCount || toolIncomplete) ? `<div class="opt-pv-footer-note" role="status">
      ${toolMovedCount ? `<div>${Util.escapeHtml(Util.t('ui.opt_tool_moved_summary', { n: toolMovedCount }))}</div>` : ''}
      ${toolIncomplete ? `<div>${Util.escapeHtml(Util.t('ui.opt_tool_incomplete'))}</div>` : ''}
    </div>` : '';
    const toolingChipHtml = OptimizerPreview._mode !== 'backlog' && OptimizerPreview._toolFingerprint !== null && (JSON.parse(OptimizerPreview._toolFingerprint) as { r: string }).r === 'hard'
      ? `<div class="opt-pv-chip opt-pv-chip-tooling" title="${Util.escapeHtml(Util.t('ui.opt_pv_chip_tooling_title'))}">${Util.escapeHtml(Util.t('ui.opt_pv_chip_tooling'))}</div>` : '';
    body.innerHTML = `
      <div class="opt-pv-shell">
        <div class="opt-pv-header">
          <div class="opt-pv-chip opt-pv-chip-mode">${Util.escapeHtml(modeLabel)}</div>
          <div class="opt-pv-chip opt-pv-chip-plant" title="${Util.escapeHtml(Util.t('ui.opt_pv_chip_plant_title'))}">${Util.escapeHtml(plant)}</div>
          <div class="opt-pv-chip opt-pv-chip-policy" title="${Util.escapeHtml(Util.t('ui.opt_pv_chip_policy_title'))}">${Util.escapeHtml(splitPolicyLabel[splitPolicy])}</div>
          ${toolingChipHtml}
          <div class="opt-pv-chip opt-pv-chip-time">${Util.escapeHtml(stamp)}</div>
        </div>

        ${staleHtml}
        ${planningHtml}
        ${toolNoteHtml}

        <div class="opt-pv-verdict opt-pv-verdict-${verdictTone}">
          <div class="opt-pv-verdict-icon">${verdictTone === 'better' ? '✓' : verdictTone === 'worse' ? '!' : '◐'}</div>
          <div class="opt-pv-verdict-text">
            <div class="opt-pv-verdict-title">${Util.escapeHtml(verdictTitle)}</div>
            <div class="opt-pv-verdict-sub">${Util.escapeHtml(verdictSub)}</div>
          </div>
          <div class="opt-pv-verdict-score">
            <div class="opt-pv-score-num">${better}<span class="opt-pv-score-of">/${directional.length}</span></div>
            <div class="opt-pv-score-lbl">${Util.escapeHtml(Util.t('ui.opt_pv_kpis_improved_label'))}</div>
          </div>
        </div>

        <div class="opt-pv-grid">${cardsHtml}</div>

        ${backlogHtml}

        ${scheduledWithoutSetupHtml}

        ${scheduledStateUnrecordedHtml}

        ${windowEndHeldHtml}


        <div class="opt-pv-sections">
          ${whyHtml}
          ${gapsHtml}
          ${diagHtml}
          ${protectedHtml}
          ${distributionSeparationHtml}
          ${toolBlockedHtml}
        </div>

        <div class="opt-pv-footer-note">
          ${Util.t('ui.opt_pv_footer_note')}
        </div>
      </div>`;

    body.querySelectorAll<HTMLButtonElement>('[data-opt-tool-raise]').forEach(button => {
      button.addEventListener('click', () => { void OptimizerPreview._raiseInventory(button.dataset.optToolRaise ?? ''); });
    });
    body.querySelector<HTMLButtonElement>('[data-opt-tool-export]')?.addEventListener('click', () => {
      const blob = new Blob(['\uFEFF' + OptimizerPreview.toolBlockedCsv(toolBlocked, labelOf, linesById)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url;
      link.download = `tool-blocked-${OptimizerPreview._plant || 'preview'}.csv`; link.click(); URL.revokeObjectURL(url);
    });
    const missingCsv = () => OptimizerPreview.missingPairsCsv(OptimizerPreview._explanation?.missingPairs || []);
    body.querySelector<HTMLButtonElement>('[data-opt-copy-missing]')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(missingCsv()).catch(() => Toast.show(Util.t('toast.clipboard_denied'), 'error'));
    });
    body.querySelector<HTMLButtonElement>('[data-opt-export-missing]')?.addEventListener('click', () => {
      const blob = new Blob([missingCsv()], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url;
      link.download = `missing-setups-${OptimizerPreview._plant || 'preview'}.csv`; link.click(); URL.revokeObjectURL(url);
    });
    body.querySelector<HTMLButtonElement>('[data-opt-review-missing]')?.addEventListener('click', async () => {
      const setupAdmin = (globalThis as unknown as { NIMBUS?: { SetupAdmin?: { reviewMissingPairs?: (plant: string | null, pairs: PreviewExplanation['missingPairs']) => Promise<boolean> } } }).NIMBUS?.SetupAdmin;
      if (await setupAdmin?.reviewMissingPairs?.(OptimizerPreview._plant, OptimizerPreview._explanation?.missingPairs || [])) OptimizerPreview.discard();
    });
    OptimizerPreview._syncApplyButton();
  },

  async apply(): Promise<void> {
    const snap = OptimizerPreview._snapshot;
    const candidate = OptimizerPreview._candidate;
    const mode = OptimizerPreview._mode;
    const plant = OptimizerPreview._plant;
    if (!snap || !candidate) { Modal.close('modal-opt-preview'); return; }
    // A background result viewed after local edits: Apply becomes "apply what still fits".
    const fullApply = OptimizerPreview.canApply();
    if (!fullApply && OptimizerPreview._canApplyPartial() && plant) {
      await OptimizerPreview._runGuardedCommit(OptimizerPreview.applyPartial({ plant, candidate, snapshot: snap, taskBaseline: OptimizerPreview._taskBaseline! }));
      return;
    }
    if (!fullApply) {
      Toast.show(OptimizerPreview._staleMessage(), 'warn');
      return;
    }
    // One live snapshot per Apply gesture: the stale check below and the prune pass read the same board (nothing awaits between them).
    const liveSnapshot = snapshotSchedule(plant ?? undefined);
    const findings = validateCandidateForApply(candidate, liveSnapshot);
    if (findings.some(finding => finding.severity === 'error')) {
      candidate.validationFindings = findings;
      OptimizerPreview._render();
      OptimizerPreview._syncApplyButton();
      Toast.show('This proposal is no longer valid. Run optimization again before applying.', 'warn');
      return;
    }
    // This is the sole schedule-state commit for a preview candidate.
    // A running order never moves, and the preview may have sat open while one started. Drop
    // those patches at apply time (Remove Backlog is the one run that moves running orders).
    // The running test at Apply uses each order's own plant clock (Store.plantNow via the default now).
    let keptPatches = mode === 'backlog'
      ? candidate.patches
      : candidate.patches.filter(patch => { const live = Store.tasks[String(patch.id)]; return !(live && Engine.isInProgress(live)); });
    const keptSet = new Set<SchedulePatch>(keptPatches);
    const runningSkippedIds = candidate.patches
      .filter(patch => !keptSet.has(patch)).map(patch => String(patch.id));
    // O9: dropping a running order frees its old slot in the plan but not on the live board, so a kept order the
    // proposal placed there would now overlap it. Re-validate the survivors against the live board, only when
    // something was actually dropped and never for Backlog (which legitimately moves running orders).
    let validationDroppedIds: string[] = [];
    if (mode !== 'backlog' && runningSkippedIds.length && plant) {
      const running = new Set(runningSkippedIds);
      const pruned = OptimizerPreview._pruneAgainstLive({
        plant, candidate, snapshot: snap, liveSnapshot,
        shouldDrop: id => running.has(id),
      });
      if (!pruned) {
        OptimizerPreview._render();
        OptimizerPreview._syncApplyButton();
        Toast.show('This proposal is no longer valid. Run optimization again before applying.', 'warn');
        return;
      }
      const survivors = new Set(pruned.kept.map(patch => String(patch.id)));
      keptPatches = candidate.patches.filter(patch => survivors.has(String(patch.id)));
      validationDroppedIds = pruned.dropped.filter(id => !running.has(id));
    }
    const committed = await OptimizerPreview._runGuardedCommit(OptimizerPreview._commitPatches(keptPatches, { ids: runningSkippedIds, reason: 'running' }, snap));
    // Cancel at the tool confirm (or a task edit during it) commits nothing: no "dropped" toast for a plan that was not applied.
    if (committed && validationDroppedIds.length) {
      Toast.show(Util.t('toast.opt_apply_invalid_dropped', { count: validationDroppedIds.length }), 'warn', 7000);
    }
  },

  /** After the planner cancels the tool-queue confirm: make sure the (possibly background-opened) preview is showing. */
  _showPreviewAfterCancel(): void {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('modal-opt-preview');
    // Foreground (the preview never closed): its DOM is intact, so leave it alone, or a rebuild would collapse the open
    // <details> sections and reset the scroll position. Only a hidden modal (the background path) needs opening + rendering.
    if (!el?.hidden) return;
    Modal.open('modal-opt-preview');
    OptimizerPreview._render();
    OptimizerPreview._syncApplyButton();
  },

  /** "Raise inventory" from the preview's Tool-blocked panel. The destination (Master Data) opens behind the modal, so
   *  the preview must close first; closing discards the plan, hence the confirm (Cancel default). */
  async _raiseInventory(tool: string): Promise<void> {
    const plant = OptimizerPreview._plant;
    const previewOpen = OptimizerPreview.active && !!OptimizerPreview._candidate;
    if (previewOpen) {
      const ok = await Modal.confirm({
        title: Util.t('ui.opt_tool_raise'),
        message: Util.t('modal.opt_tool_raise_discard'),
        confirmLabel: Util.t('ui.opt_tool_raise'),
        tone: 'warn',
      });
      if (!ok) return;
      OptimizerPreview._clear();
      Modal.close('modal-opt-preview');
    }
    raiseToolInventory(plant, tool);
    if (previewOpen) Toast.show(Util.t('toast.opt_tool_raise_closed'), 'info', 7000);
  },

  /** Await an apply-tail promise and route a failure to ErrorLog, so it is never silent. */
  async _runGuardedCommit(commit: Promise<unknown>): Promise<boolean> {
    try { return (await commit) !== false; } catch (err) {
      ErrorLog.error('optimizer', `Apply failed: ${err instanceof Error ? err.message : String(err)}`, err);
      // Never leave an installed preview active (task watch running) with no modal to act on it.
      OptimizerPreview._clear();
      Modal.close('modal-opt-preview');
      return false;
    }
  },

  /** Commit a (possibly filtered) set of preview patches: audit, apply, undo
   *  entry, toasts, teardown, and alert recompute. `skipped` carries the ids
   *  dropped before this call and why, so the caller owns the filtering. Resolves true only when the patches were
   *  committed; false when nothing was (no candidate, Cancel at the tool confirm, or a task edited during it). */
  async _commitPatches(
    kept: ReadonlyArray<SchedulePatch>,
    skipped: { ids: string[]; reason: 'running' | 'changed' },
    snapBeforeApply: NimbusTask[],
  ): Promise<boolean> {
    const snap = snapBeforeApply;
    const candidate = OptimizerPreview._candidate;
    const mode = OptimizerPreview._mode;
    const plant = OptimizerPreview._plant;
    const auditDetails = OptimizerPreview._auditDetails;
    if (!candidate) return false;
    // The ONE tool-queue guard: every apply path (Apply, "Apply what still fits", "Apply without preview") ends here, so
    // it confirms, from the KEPT patches only, before anything is audited or committed. Cancel aborts and keeps the
    // preview open and untouched. With no `toolBlocked` on the candidate this is a no-op.
    const toolSummary = toolQueueSummary(candidate, kept);
    // No await when there is nothing to confirm: the commit stays synchronous exactly as before.
    if (toolSummary.queued.length) {
      // The confirm is async and a planner can still edit tasks behind it: remember what the kept patches' orders looked
      // like, and refuse to commit if any of them changed (or vanished) before the answer arrived.
      const before = taskBaseline(kept.map(patch => Store.tasks[String(patch.id)]).filter((task): task is NimbusTask => !!task));
      let confirmed = false;
      try { confirmed = await confirmToolQueue(candidate, kept); } finally {
        if (!confirmed) OptimizerPreview._applying = false;   // Cancel or a thrown confirm: never leave the flag set
      }
      if (!confirmed) {
        OptimizerPreview._showPreviewAfterCancel();
        return false;
      }
      const drifted = kept.some(patch => {
        const id = String(patch.id);
        const live = Store.tasks[id];
        if (!before.has(id)) return !!live;
        return !live || taskBaseline([live]).get(id) !== before.get(id);
      });
      if (drifted) {
        OptimizerPreview._applying = false;
        OptimizerPreview._markTaskStale('a task changed while the tool confirm was open');
        Toast.show(Util.t('ui.opt_preview_task_stale'), 'warn');
        OptimizerPreview._showPreviewAfterCancel();
        return false;
      }
    }
    OptimizerPreview._applying = true;
    if (auditDetails && plant) {
      Util.fetchTraced(`${Config.API_BASE}/audit/log`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': Session.actor() },
        body: JSON.stringify({
          action: 'optimization_run', plant,
          details: {
            mode: auditDetails.mode,
            wheel_used: auditDetails.wheelUsed,
            task_count: auditDetails.taskCount,
            scope: auditDetails.scope,
            lines: auditDetails.lines,
            active_priority_fields: auditDetails.activePriorityFields,
            unranked_priority_fields: auditDetails.unrankedPriorityFields,
            split_order_policy: auditDetails.splitOrderPolicy,
            tooling_rule: OptimizerPreview._toolFingerprint ? (JSON.parse(OptimizerPreview._toolFingerprint) as { r: string }).r : 'off',
            tool_blocked: toolSummary.queued.length,
            tool_moved: toolSummary.moved,
            ...(auditDetails.searchBudgetMs !== undefined ? { search_budget_ms: auditDetails.searchBudgetMs, exhaustive: auditDetails.exhaustive === true } : {}),
          },
        }),
      }).catch(() => {});
    }
    if (mode === 'backlog' && OptimizerPreview._backlogResult && OptimizerPreview._backlogAudit) {
      const audit = OptimizerPreview._backlogAudit;
      const diagnostics = OptimizerPreview._backlogResult.diagnostics;
      Util.fetchTraced(`${Config.API_BASE}/audit/log`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': Session.actor() },
        body: JSON.stringify({
          action: 'optimization_run', plant: audit.plant,
          details: {
            mode: 'backlog', scope: audit.lines ? 'lines' : 'plant', lines: audit.lines,
            from: audit.from?.toISOString() ?? null, to: audit.to?.toISOString() ?? null,
            plant_timezone: audit.timezone, captured_run_at: audit.runAt?.toISOString() ?? null,
            backlog_found: diagnostics.backlogFound, moved: diagnostics.moved, firmed_moved: diagnostics.firmedMoved,
            frozen_moved: diagnostics.frozenMoved,
            invalid_runtime: diagnostics.invalidRuntimeIds.length, missing_start: diagnostics.missingStartIds.length,
            overlong: diagnostics.overlongIds.length, largest_delay_minutes: diagnostics.largestDelayMinutes,
            boundary_conflicts: diagnostics.boundaryConflicts.length,
            applied_with_boundary_conflicts: diagnostics.boundaryConflicts.length > 0,
            split_order_policy: Engine.splitOrderPolicyFor(audit.plant),
          },
        }),
      }).catch(() => {});
    }
    Engine.applySchedulePatches(kept);
    if (skipped.ids.length) {
      if (skipped.reason === 'running') {
        Toast.show(Util.t('toast.opt_apply_running_skipped', { count: skipped.ids.length }), 'warn', 7000);
      } else {
        const shown = skipped.ids.slice(0, 5).join(', ');
        const list = skipped.ids.length > 5 ? `${shown} ${Util.t('ui.opt_bg_more', { count: skipped.ids.length - 5 })}` : shown;
        Toast.show(Util.t('toast.opt_bg_partial_applied', { applied: kept.length, skipped: skipped.ids.length, list }), 'warn', 9000);
      }
    }
    Store.setLastOptimize(new Date(), 'engine');
    const hadDismissed = Alerts.clearDismissed();
    // Push an undo entry so Ctrl+Z restores the pre-optimization state later.
    UndoStack.push(`Optimization (${mode})${plant ? ' · ' + plant : ''}`,
      () => UndoStack.restoreTasks(snap), snap.map(t => t.id));
    Toast.show(Util.t('toast.opt_applied'), 'success');
    // Fire warning toasts — matching the live Engine.runAndApply patterns from schedule-services.mts
    if (OptimizerPreview._explanation) {
      const { scheduledWithoutSetup, unplacedOrders } = OptimizerPreview._explanation;
      if (scheduledWithoutSetup.orders && !OptimizerPreview._syntheticSetup) {
        Toast.show(Util.t('toast.optimize_missing_setup_summary', {
          orders: scheduledWithoutSetup.orders,
          lines: scheduledWithoutSetup.lines,
        }), 'warn');
      }
      if (candidate.dispositions?.some(item => item.status === 'needs_planning')) {
        const count = candidate.dispositions.filter(item => item.status === 'needs_planning').length;
        const toolNote = toolSummary.queued.length ? ` ${Util.t('ui.opt_tool_need_planning_suffix', { n: toolSummary.queued.length })}` : '';
        Toast.show(`${count} order(s) need planning${toolNote}. Review their allowed windows and reasons in Orders.`, 'warn', 7000);
      } else if (unplacedOrders.orders && !candidate.dispositions) {
        Toast.show(Util.t('toast.optimize_orders_left_in_place', {
          orders: unplacedOrders.orders,
          lines: unplacedOrders.lines,
        }), 'warn');
      }
    }
    if (candidate.unchangedLines.length) {
      Toast.show(Util.t('toast.optimize_lines_guarded', { count: candidate.unchangedLines.length }), 'warn');
    }
    OptimizerPreview._clear();
    // The trial is now the committed baseline. Phase 3 (Pkg E): route through
    // Confidence's own debounced scheduler (Util.debounce-wrapped in
    // nimbus-intelligence.js) instead of forcing a synchronous recompute on
    // the click path.
    NIMBUS!.Confidence?._recomputeDebounced?.();
    Modal.close('modal-opt-preview');
    // Phase 3 (Pkg E): scope the recompute to the lines candidate.patches
    // actually touched instead of a full-plant recompute. `snap` is the
    // pre-apply snapshot (candidate patches never change MACHINE, so
    // pre/post-apply line membership match).
    // If any alert was dismissed before this apply, a scoped merge would
    // retain untouched lines' stale (dismissal-filtered) alert lists as-is —
    // those cleared dismissals would never re-surface until some later full
    // recompute. A pending full recompute already wins over a scoped one by
    // design, so force it whenever there was something to clear.
    if (hadDismissed) {
      Alerts.scheduleRecompute();
    } else {
      const byId = new Map(snap.map(t => [String(t.id), t]));
      scheduleAlertsForPatches(candidate.patches, id => byId.get(String(id))?.MACHINE || 'Unknown', id => byId.get(String(id)));
    }
    return true;
  },

  /* ---------------------------------------------------------------------
     BACKGROUND (EXHAUSTIVE) RUN
     The Exhaustive search runs through `computePreview` with no `onPrimary`
     hook, so it touches no preview state and no DOM until the planner opens
     the finish popup and chooses View / Apply / Dismiss.
     --------------------------------------------------------------------- */
  _backgroundRun: null as null | {
    plant: string; mode: OptimizerMode; startedAt: number;
    controller: AbortController | null; result: PreviewResult | null; error: string | null;
  },
  _leaveGuard: null as ((e: BeforeUnloadEvent) => void) | null,
  _bgDoneBound: false,

  async runInBackground(mode: OptimizerMode, opts: OptimizerRunOptions): Promise<void> {
    const plant = opts.plant ?? Store.selectedPlant;
    if (!plant) { Toast.show(Util.t('toast.select_plant_before_opt'), 'warn'); return; }
    if (!Store.tasksArr.length) { Toast.show(Util.t('toast.no_tasks_to_optimise'), 'error'); return; }
    if (opts.exhaustive === true && typeof Worker !== 'function') {
      // Without a Worker the search would run on the page thread for minutes and freeze it.
      Toast.show(Util.t('toast.opt_bg_no_worker'), 'error');
      return;
    }
    if (OptimizerPreview._backgroundRun) {
      Toast.show(Util.t('toast.opt_bg_running', { plant: OptimizerPreview._backgroundRun.plant }), 'warn');
      return;
    }
    const controller = new AbortController();
    OptimizerPreview._backgroundRun = { plant, mode, startedAt: performance.now(), controller, result: null, error: null };
    OptimizerPreview._syncToolbarRunning();
    OptimizerPreview._installLeaveGuard();
    Toast.show(Util.t('toast.opt_bg_started', { plant }), 'info', 6000,
      { label: Util.t('btn.cancel'), run: () => OptimizerPreview.cancelBackground() });
    try {
      const result = await OptimizerPreview.computePreview(mode, { ...opts, plant }, {
        signal: controller.signal,
        tick: () => new Promise<void>(resolve => { setTimeout(resolve, 0); }),
        shouldStop: () => false,
        runSeq: ++OptimizerPreview._runSeq,
      });
      const run = OptimizerPreview._backgroundRun;
      if (!run || run.controller !== controller) return;   // cancelled meanwhile
      run.result = result;
      OptimizerPreview._showBackgroundDone();
    } catch (err) {
      const run = OptimizerPreview._backgroundRun;
      if (!run || run.controller !== controller) return;
      if ((err as Error)?.name === 'AbortError') {
        OptimizerPreview._backgroundRun = null;
        Toast.show(Util.t('toast.opt_bg_cancelled'), 'info');
      } else {
        run.error = String((err as Error)?.message ?? err);
        ErrorLog.error('optimizer', `Exhaustive optimization failed: ${run.error}`, err);
        OptimizerPreview._showBackgroundDone();
      }
    } finally {
      OptimizerPreview._syncToolbarRunning();
      // A superseded run settling late must not strip the guard a newer run installed.
      if (!OptimizerPreview._backgroundComputing()) OptimizerPreview._removeLeaveGuard();
    }
  },

  cancelBackground(): void {
    const run = OptimizerPreview._backgroundRun;
    // Only a computing run can be cancelled; a finished one is dismissed through the popup.
    if (!run || !OptimizerPreview._backgroundComputing()) return;
    run.controller?.abort();
    OptimizerPreview._backgroundRun = null;
    OptimizerPreview._syncToolbarRunning();
    OptimizerPreview._removeLeaveGuard();
    Toast.show(Util.t('toast.opt_bg_cancelled'), 'info');
  },

  /** True while the search is still computing (not yet finished or failed). */
  _backgroundComputing(): boolean {
    const run = OptimizerPreview._backgroundRun;
    return !!run && !run.result && !run.error;
  },

  /** Toolbar Optimize button: pulsing dot + cancel-on-click while a background run computes. */
  _syncToolbarRunning(): void {
    const btn = typeof document === 'undefined' ? null : document.getElementById('btn-optimize') as HTMLButtonElement | null;
    if (!btn) return;
    const running = OptimizerPreview._backgroundComputing();
    // The dialog's Run button follows the same state, so a run finishing while the dialog is open restores it.
    const runBtn = document.getElementById('opt-run-btn') as HTMLButtonElement | null;
    if (runBtn) {
      if (running) {
        runBtn.disabled = true;
        runBtn.textContent = Util.t('btn.opt_run_bg_busy');
      } else if (runBtn.textContent === Util.t('btn.opt_run_bg_busy')) {
        runBtn.disabled = !OptimizerPreview._backgroundRun && !Store.selectedPlant;
        runBtn.innerHTML = `<span class="opt-run-icon">📈</span>${Util.t('btn.run_optimization')}`;
      }
    }
    btn.classList.toggle('is-running', running);
    btn.title = running ? Util.t('btn.opt_run_bg_busy') : Util.t('tip.smart_optimize');
    btn.onclick = running ? () => { void OptimizerPreview._askCancelBackground(); } : () => { OptimizeDialog.open(); };
  },

  async _askCancelBackground(): Promise<void> {
    const run = OptimizerPreview._backgroundRun;
    if (!run || !OptimizerPreview._backgroundComputing()) return;
    const secs = Math.round((performance.now() - run.startedAt) / 1000);
    const elapsed = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const ok = await Modal.confirm({ title: Util.t('modal.opt_bg_cancel_confirm', { plant: run.plant, elapsed }), tone: 'warn' });
    if (ok && OptimizerPreview._backgroundRun === run && OptimizerPreview._backgroundComputing()) OptimizerPreview.cancelBackground();
  },

  /** One beforeunload listener while the search computes: leaving the page would lose it. */
  _installLeaveGuard(): void {
    if (OptimizerPreview._leaveGuard || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const guard = (e: BeforeUnloadEvent): void => {
      if (!OptimizerPreview._backgroundComputing()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    OptimizerPreview._leaveGuard = guard;
    window.addEventListener('beforeunload', guard);
  },

  _removeLeaveGuard(): void {
    const guard = OptimizerPreview._leaveGuard;
    if (!guard) return;
    OptimizerPreview._leaveGuard = null;
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('beforeunload', guard);
  },

  /** Which plant orders no longer match the state the search ran on. */
  _changedSinceBaseline(result: Pick<PreviewResult, 'plant' | 'taskBaseline'>): { changed: string[]; missing: string[] } {
    const changed: string[] = [];
    const missing: string[] = [];
    // Every baseline task, not just the proposed ones: an edit to an unpatched order can still collide with a proposal.
    for (const [id, value] of result.taskBaseline) {
      const live = Store.tasks[id];
      if (!live) missing.push(id);
      else if (taskBaseline([live]).get(id) !== value) changed.push(id);
    }
    // Orders added to the plant since the search ran were never seen by it.
    const scope = { lineSettings: Store.lineSettings, masterData: Store.masterData };
    for (const task of Store.tasksArr) {
      const id = String(task.id);
      if (!result.taskBaseline.has(id) && resolveTaskPlant(task, scope) === result.plant) changed.push(id);
    }
    return { changed, missing };
  },

  /** A finished run whose tool facts (rule + inventory) differ from the live Store: its Tool-blocked list and placements
   *  describe counts that no longer hold. */
  _toolFactsChanged(result: Pick<PreviewResult, 'plant' | 'toolFingerprint'>): boolean {
    return !!result.toolFingerprint && toolFingerprint(Store.masterData, result.plant) !== result.toolFingerprint;
  },

  _renderBackgroundDone(): void {
    const run = OptimizerPreview._backgroundRun;
    const body = typeof document === 'undefined' ? null : document.getElementById('opt-bg-done-body');
    const applyBtn = typeof document === 'undefined' ? null : document.getElementById('opt-bg-apply-btn') as HTMLButtonElement | null;
    const viewBtn = typeof document === 'undefined' ? null : document.getElementById('opt-bg-view-btn') as HTMLButtonElement | null;
    const switchBtn = typeof document === 'undefined' ? null : document.getElementById('opt-bg-switch-btn') as HTMLButtonElement | null;
    if (!run) return;
    if (switchBtn) switchBtn.hidden = true;
    const esc = (value: string): string => Util.escapeHtml(value);
    const warn = (text: string): string => `<div class="opt-pv-stale" style="margin-top:10px;">${esc(text)}</div>`;
    const result = run.result;
    if (!result) {
      if (body) body.innerHTML = warn(Util.t('ui.opt_bg_done_failed', { error: run.error ?? '' }));
      if (applyBtn) applyBtn.disabled = true;
      if (viewBtn) viewBtn.disabled = true;
      return;
    }
    const patches = result.candidate.patches;
    const placed = patches.filter(patch => patch.changes.start_date != null).length;
    const queued = patches.filter(patch => patch.changes.planning_status === 'needs_planning').length;
    const seconds = Math.round(result.runtimeMs / 1000);
    let html = `<p style="margin:0;">${esc(Util.t('ui.opt_bg_done_summary', { plant: result.plant, placed, queued, seconds }))}</p>`;
    if (result.candidate.diagnostics?.limitReached) {
      html += `<p class="opt-strategy-hint">${esc(Util.t(OptimizerPreview._limitNoteKey(result.opts?.exhaustive === true)))}</p>`;
    }
    const { changed, missing } = OptimizerPreview._changedSinceBaseline(result);
    if (changed.length + missing.length > 0) {
      html += warn(Util.t('ui.opt_bg_done_changed', { count: changed.length + missing.length }));
    }
    let blocked = false;
    if (OptimizerPreview._toolFactsChanged(result)) {
      html += warn(Util.t('ui.opt_stale_banner_tooling'));
      blocked = true;
    }
    if (Store.selectedPlant !== result.plant) {
      html += warn(Util.t('ui.opt_bg_done_other_plant', { current: Store.selectedPlant ?? '', plant: result.plant }));
      blocked = true;
      if (switchBtn) {
        switchBtn.hidden = false;
        switchBtn.textContent = Util.t('ui.opt_bg_switch_plant', { plant: result.plant });
      }
    } else if (OptimizerPreview._bgSwitching) {
      blocked = true;   // the plant is selected but its orders have not loaded yet
    }
    if (result.candidate.validationFindings?.some(finding => finding.severity === 'error' && !finding.taskId)) {
      html += warn(Util.t('ui.opt_bg_done_blocked'));
      blocked = true;
    }
    if (body) body.innerHTML = html;
    if (applyBtn) applyBtn.disabled = blocked;
    if (viewBtn) viewBtn.disabled = false;
  },

  _showBackgroundDone(): void {
    OptimizerPreview._installBackgroundDoneGuard();
    OptimizerPreview._renderBackgroundDone();
    Modal.open('modal-opt-background-done');
  },

  /** Binds the finish popup's buttons once. The popup's backdrop carries `data-no-backdrop-close` (honoured by the
   *  shell's boot-time backdrop handler), so only the X button dismisses: an outside click (for example on the plant
   *  selector, to switch to the result's plant) must never discard a finished run. */
  _installBackgroundDoneGuard(): void {
    if (OptimizerPreview._bgDoneBound || typeof document === 'undefined') return;
    const el = document.getElementById('modal-opt-background-done');
    if (!el) return;
    OptimizerPreview._bgDoneBound = true;
    // The popup's buttons are bound here, not with inline handlers (legacy-surface ratchet).
    document.getElementById('opt-bg-close-btn')?.addEventListener('click', () => OptimizerPreview.backgroundDismiss());
    document.getElementById('opt-bg-view-btn')?.addEventListener('click', () => OptimizerPreview.backgroundView());
    document.getElementById('opt-bg-apply-btn')?.addEventListener('click', () => { void OptimizerPreview.backgroundApply(); });
    document.getElementById('opt-bg-switch-btn')?.addEventListener('click', () => { void OptimizerPreview.backgroundSwitchPlant(); });
  },

  /** Set while a plant switch started from the finish popup is loading the result plant's orders: Apply stays
   *  disabled until that plant's `tasks:bulk` arrives, so the apply never validates against another plant's rows. */
  _bgSwitching: false,
  _bgSwitchUnsub: null as (() => void) | null,

  _resetBgSwitch(): void {
    OptimizerPreview._bgSwitchUnsub?.();
    OptimizerPreview._bgSwitchUnsub = null;
    OptimizerPreview._bgSwitching = false;
  },

  async backgroundSwitchPlant(): Promise<void> {
    const run = OptimizerPreview._backgroundRun;
    const result = run?.result;
    if (!run || !result || Store.selectedPlant === result.plant) return;
    // Same unsaved-edits guard as the plant selector; declining keeps the popup and the result as they are.
    if (!(await Persistence.confirmPlantSwitch(result.plant))) return;
    if (OptimizerPreview._backgroundRun !== run) return;
    OptimizerPreview._bgSwitchUnsub?.();
    OptimizerPreview._bgSwitching = true;
    OptimizerPreview._bgSwitchUnsub = Store.subscribe(evt => {
      if (evt.type !== 'tasks:bulk' || Store.selectedPlant !== result.plant) return;
      OptimizerPreview._bgSwitchUnsub?.();
      OptimizerPreview._bgSwitchUnsub = null;
      OptimizerPreview._bgSwitching = false;
      if (OptimizerPreview._backgroundRun === run) OptimizerPreview._renderBackgroundDone();
    }, 'OptimizerPreview.bgSwitch');
    Store.setSelectedPlant(result.plant, 'optimize-background');
    OptimizerPreview._renderBackgroundDone();
  },

  backgroundDismiss(): void {
    OptimizerPreview._backgroundRun = null;
    OptimizerPreview._resetBgSwitch();
    Modal.close('modal-opt-background-done');
    Toast.show(Util.t('toast.opt_discarded'), 'info');
  },

  backgroundView(): void {
    const run = OptimizerPreview._backgroundRun;
    const result = run?.result;
    if (!run || !result) return;
    OptimizerPreview._backgroundRun = null;
    OptimizerPreview._resetBgSwitch();
    Modal.close('modal-opt-background-done');
    OptimizerPreview._partialApplyAllowed = true;
    OptimizerPreview.present(result, { open: true });
    const { changed, missing } = OptimizerPreview._changedSinceBaseline(result);
    if (OptimizerPreview._toolFactsChanged(result)) {
      OptimizerPreview._markTaskStale('tool inventory or tooling rule changed', 'ui.opt_stale_banner_tooling');
    } else if (changed.length + missing.length > 0) {
      OptimizerPreview._markTaskStale('background result predates local edits', 'ui.opt_preview_task_stale');
    }
  },

  async backgroundApply(): Promise<void> {
    const run = OptimizerPreview._backgroundRun;
    const result = run?.result;
    if (!run || !result) return;
    if (Store.selectedPlant !== result.plant) {
      Toast.show(Util.t('toast.opt_bg_other_plant', { plant: result.plant }), 'warn');
      return;
    }
    if (OptimizerPreview._toolFactsChanged(result)) {
      Toast.show(Util.t('ui.opt_stale_banner_tooling'), 'warn');
      OptimizerPreview._renderBackgroundDone();
      return;
    }
    OptimizerPreview._backgroundRun = null;
    OptimizerPreview._resetBgSwitch();
    Modal.close('modal-opt-background-done');
    OptimizerPreview.present(result, { open: false });
    await OptimizerPreview._runGuardedCommit(OptimizerPreview.applyPartial(result));
  },

  /** UI-free: re-validate a preview candidate against the LIVE board and prune what no longer fits. `shouldDrop`
   *  names the orders to drop up front (the caller's own reason: edited, deleted, running); this then drops their
   *  distributed-sub-order families and any kept order whose placement the live board now rejects (a collision
   *  with an order that is not being applied drops the colliding kept patches). Returns the surviving patches and
   *  the dropped ids, or null when the apply cannot be made safe (no validation context, a finding with no
   *  order, an unresolvable collision, or nothing left). Shows no toast and touches no preview state. */
  _pruneAgainstLive(args: {
    plant: string;
    candidate: CandidateResult;
    snapshot: ReadonlyArray<NimbusTask>;
    /** The caller's already-captured live board for this plant (same synchronous gesture); omitted = capture here. */
    liveSnapshot?: ScheduleSnapshot;
    shouldDrop: (id: string, live: NimbusTask | undefined) => boolean;
  }): { kept: SchedulePatch[]; dropped: string[] } | null {
    const { candidate, plant } = args;
    const patches = candidate.patches;
    // Re-validate the kept subset against the LIVE board (live rows, calendars, blackouts), not the compute-time
    // snapshot. Findings on a kept order drop it (and its family). A finding on an order we are not applying is a
    // collision only when the same finding is absent from the live board validated with no patches at all (otherwise it
    // is a pre-existing defect or disposition bookkeeping noise). A collision drops every kept patch on that line whose
    // proposed interval meets the order's live interval or, failing that, the kept patch placed immediately before it
    // (it changed that order's incoming setup); with neither, the result is null. A finding with no order yields null.
    const live = (id: string): NimbusTask | undefined => Store.tasks[id];
    const atCompute = new Map(args.snapshot.map(task => [String(task.id), task]));
    // Distributed sub-orders (siblings sharing PARENT_ORDER, the field distribution_separation groups on) must
    // land together, so one dropped sibling drops its whole family.
    const parentKey = (task: NimbusTask | undefined): string | null =>
      task?.PARENT_ORDER ? `${task.PARENT_ORDER}\u0000${task.MATERIAL_NUMBER ?? ''}` : null;
    const familyOf = new Map<string, string[]>();
    for (const patch of patches) {
      const id = String(patch.id);
      const key = parentKey(atCompute.get(id) ?? live(id));
      if (key) familyOf.set(key, [...(familyOf.get(key) ?? []), id]);
    }
    const drop = new Set<string>();
    const dropWithFamily = (id: string): void => {
      drop.add(id);
      const key = parentKey(atCompute.get(id) ?? live(id));
      if (key) for (const sibling of familyOf.get(key) ?? []) drop.add(sibling);
    };
    for (const patch of patches) {
      const id = String(patch.id);
      if (args.shouldDrop(id, live(id))) dropWithFamily(id);
    }
    const context = candidate.validationContext;
    if (!context) return null;
    const live0 = args.liveSnapshot ?? snapshotSchedule(plant);
    const ms = (value: unknown): number | null => (value instanceof Date ? value.getTime() : null);
    // The message is part of the key: capacity_overlap names both orders, so a NEW overlap that lands on an order which
    // already overlapped another one live is a different finding, not the baseline one.
    const keyOf = (finding: { code: string; taskId?: string | number; message?: string }): string => `${finding.code}|${finding.taskId}|${finding.message ?? ''}`;
    // One run context for the live board, reused by every validation below.
    const liveBounds = boundsWithRunContext(live0, context.bounds);
    const errorsFor = (patchSet: SchedulePatch[]) => {
      const ids = new Set(patchSet.map(patch => String(patch.id)));
      return validateCandidate(live0, liveBounds, {
        ...candidate, patches: patchSet,
        dispositions: candidate.dispositions?.filter(item => ids.has(String(item.id))),
      }).filter(finding => finding.severity === 'error' && finding.code !== 'stale_candidate');
    };
    // Tool Inventory: a `tool_overflow` error names exactly ONE order, and only an order of the KEPT set can be named (the
    // dispositions passed above are the kept patches'), so `dropWithFamily` always resolves it; its message is fixed (holders
    // live in `detail`), so this key stays stable. Dropping a patch reverts the order to its LIVE slot, which can collide with the
    // next kept patch: each pass drops at least one patch (monotone, bounded by the kept count), so the cap below is
    // min(8, kept patches): a chain of N sequential drops resolves while N + 1 passes fit, a longer chain is refused.
    // Lazy and memoised: the no-patch baseline is only consulted for a finding on an order we are not applying.
    let baselineKeysMemo: Set<string> | null = null;
    const baselineKeys = (): Set<string> => baselineKeysMemo ??= new Set(errorsFor([]).map(keyOf));
    let kept: SchedulePatch[] = patches.filter(patch => !drop.has(String(patch.id)));
    const maxPasses = Math.min(8, kept.length);
    for (let pass = 0; pass < maxPasses; pass++) {
      const keptIds = new Set(kept.map(patch => String(patch.id)));
      const findings = errorsFor(kept);
      if (!findings.length) break;
      if (findings.some(finding => !finding.taskId)) return null;
      let dropped = false;
      for (const finding of findings) {
        const id = String(finding.taskId);
        if (keptIds.has(id)) { if (!drop.has(id)) { dropWithFamily(id); dropped = true; } continue; }
        if (finding.code === 'segments' || baselineKeys().has(keyOf(finding))) continue;
        const other = Store.tasks[id];
        const oStart = ms(other?.start_date); const oEnd = ms(other?.end_date);
        const onLine = kept.filter(patch => !drop.has(String(patch.id))
          && String(Store.tasks[String(patch.id)]?.MACHINE) === String(other?.MACHINE));
        const range = (patch: SchedulePatch): [number, number] | null => {
          const a = ms(patch.changes.start_date); const b = ms(patch.changes.end_date);
          return a === null || b === null ? null : [a, b];
        };
        let hits = oStart === null || oEnd === null ? [] : onLine.filter(patch => {
          const r = range(patch);
          return !!r && r[0] < oEnd && oStart < r[1];
        });
        if (!hits.length && oStart !== null) {
          const before = onLine.flatMap(patch => { const r = range(patch); return r && r[1] <= oStart ? [{ patch, end: r[1] }] : []; })
            .sort((a, b) => b.end - a.end)[0];
          if (before) hits = [before.patch];
        }
        if (!hits.length) return null;
        for (const hit of hits) dropWithFamily(String(hit.id));
        dropped = true;
      }
      if (!dropped) break;
      if (pass === maxPasses - 1) return null;
      kept = patches.filter(patch => !drop.has(String(patch.id)));
    }
    if (!kept.length) return null;
    return { kept, dropped: [...drop] };
  },

  /** Apply the part of a result that still matches the live schedule. An order that was edited, deleted, started
   *  running, or whose distributed sub-order siblings were dropped is skipped; everything else is committed as one
   *  Undo entry through `_commitPatches`. */
  async applyPartial(result: Pick<PreviewResult, 'plant' | 'candidate' | 'snapshot' | 'taskBaseline'>): Promise<void> {
    const pv = OptimizerPreview;
    if (Store.selectedPlant !== result.plant) {
      Toast.show(Util.t('toast.opt_bg_other_plant', { plant: result.plant }), 'warn');
      return;
    }
    if (pv._candidate !== result.candidate) pv.present(result as PreviewResult, { open: false });
    const refuse = (): void => {
      Toast.show(Util.t('ui.opt_preview_task_stale'), 'warn');
      pv._clear();
      Modal.close('modal-opt-preview');
    };
    const candidate = result.candidate;
    const plant = result.plant;
    // One live snapshot for the prune pass and the Undo entry (the prune is read-only and nothing writes the Store between them).
    const live0 = snapshotSchedule(plant);
    const pruned = pv._pruneAgainstLive({
      plant, candidate, snapshot: result.snapshot, liveSnapshot: live0,
      shouldDrop: (id, task) => !task || Engine.isInProgress(task) || taskBaseline([task]).get(id) !== result.taskBaseline.get(id),
    });
    if (!pruned) { refuse(); return; }
    const kept = pruned.kept;
    const drop = new Set(pruned.dropped);
    // snapshotSchedule(plant) already holds exactly this plant's tasks, cloned.
    const undoSnapshot = [...live0.tasks];
    pv._applying = true;
    await pv._commitPatches(kept, { ids: [...drop], reason: 'changed' }, undoSnapshot);
  },

  discard() {
    if (OptimizerPreview._candidate) {
      Toast.show(Util.t('toast.opt_discarded'), 'info');
    }
    OptimizerPreview._clear();
    Modal.close('modal-opt-preview');
  },

  _clear(keepPreviewDiagnostics: boolean = false) {
    const workerAbortController = OptimizerPreview._workerAbortController;
    OptimizerPreview._workerAbortController = null;
    workerAbortController?.abort();
    OptimizerPreview._stopTaskWatch();
    OptimizerPreview._snapshot = null;
    OptimizerPreview._taskBaseline = null;
    OptimizerPreview._baselineVerifiedRev = null;
    OptimizerPreview._toolFingerprint = null;
    OptimizerPreview._candidate = null;
    OptimizerPreview._preKpis  = null;
    OptimizerPreview._postKpis = null;
    OptimizerPreview._mode     = null;
    OptimizerPreview._plant    = null;
    OptimizerPreview._splitOrderPolicy = 'never';
    OptimizerPreview._backlogResult = null;
    OptimizerPreview._backlogAudit = null;
    OptimizerPreview._auditDetails = null;
    OptimizerPreview._syntheticSetup = false;
    OptimizerPreview._explanation = null;
    OptimizerPreview._finalists = null;
    OptimizerPreview._endLoadingState();
    OptimizerPreview.stale = false;
    OptimizerPreview._staleReason = null;
    OptimizerPreview._staleMessageKey = null;
    OptimizerPreview._applying = false;
    OptimizerPreview._partialApplyAllowed = false;
    if (!keepPreviewDiagnostics) OptimizerPreview._previewDiagnostics = [];
    OptimizerPreview.active       = false;
  },
};

Persistence.setSetupWriteListener((plant, kind) => OptimizerPreview.markSetupStale(plant, kind));

// -- Local type declaration (originally part of CQ-1 Phase 6 Task 8's
//    combined EditCalendar/ColorWheelViewer/AlertsUIAdapter/SandboxAdapter/
//    Printer type block; relocated here with SandboxAdapter — the only one
//    of those five that uses it) --------------------------------------------

/** The `sandbox:exited` event's `snapshot` payload (schedule-state.mts's
 *  `Sandbox.exit()` return value) — that module keeps `SandboxSnapshot`
 *  un-exported, so this derives the same shape via `ReturnType` instead of
 *  redeclaring a shadow copy, per this phase's own "no un-exported interface,
 *  use ReturnType<typeof …>" precedent. */
type SandboxExitSnapshot = NonNullable<ReturnType<typeof Sandbox.exit>>;

/* =============================================================================
   SANDBOX ADAPTER — thin app.js UI/side-effect layer over the state-only
   `Sandbox` module (state + snapshots now live in schedule-state.mjs). Owns
   the DOM banner/buttons and performs the cross-module side effects that
   used to be inline in Sandbox.exit() (Alerts recompute, Persistence save,
   CalendarSync flush/re-hydrate, Confidence snapshot/restore, Toast
   messages) by subscribing to the `sandbox:entered`/`sandbox:exited`
   (and `sandbox:reverted`, fired by the undo-a-promoted-scenario path)
   events the state module emits. This is new code, not a move — it is the
   thin UI/cross-module layer the design's ownership map calls out as
   belonging to `schedule-workbench.mjs` eventually; for Phase 1 it stays
   here as a boot-wired adapter.
   ========================================================================== */
export const SandboxAdapter = {
  _confSnapshot: null as unknown,
  _lastOptimizeSnapshot: null as Date | null,
  _dismissedSnapshot: null as Set<string> | null,
  _linePlantSnapshot: null as Map<string, string | null> | null,
  // H3c: the unsaved-edit sets as they stood at entry. Discard's wholesale setTasks emits
  // 'tasks:bulk', which App._trackDirty answers by CLEARING both sets — wiping the planner's
  // pre-What-If unsaved edits (and the force flags that opt optimizer/undo rows into atomic
  // save). Restored in _onExited(discard) after that clear has run.
  _dirtySnapshot: null as Set<string> | null,
  _forceSnapshot: null as Set<string> | null,
  _firmDirtySnapshot: null as Set<string> | null,
  _dirtySourceSnapshot: null as Map<string, string> | null,
  _sideEffectSnapshotActive: false,

  init() {
    const banner = document.getElementById('sandbox-banner');
    if (!banner) return;
    banner.innerHTML = `
      <span style="font-size:14px;">🔮</span>
      <strong>${Util.t('ui.what_if_title')}</strong> ${Util.t('ui.what_if_sub')}
      <input class="sb-name" id="sb-scenario-name" placeholder="${Util.t('ph.name_scenario')}" value="${Util.t('ui.what_if_default_name')}">
      <div style="display:flex;gap:6px;margin-left:auto;">
        <button class="btn btn-ghost sm" id="sb-discard-btn">${Util.t('ui.discard_btn')}</button>
        <button class="btn btn-primary sm" id="sb-apply-btn">${Util.t('ui.promote_btn')}</button>
      </div>`;
    document.getElementById('sb-discard-btn')?.addEventListener('click', () => Sandbox.exit(false, 'sandbox-ui'));
    document.getElementById('sb-apply-btn')?.addEventListener('click',  () => Sandbox.exit(true, 'sandbox-ui'));

    Store.subscribe(evt => {
      if (evt.type === 'sandbox:entered') SandboxAdapter._onEntered();
      else if (evt.type === 'sandbox:exited') SandboxAdapter._onExited(evt);
      else if (evt.type === 'sandbox:reverted') SandboxAdapter._onReverted(evt);
    }, 'SandboxAdapter');
  },

  enter() {
    if (Sandbox.active) { Toast.show(Util.t('toast.already_in_sandbox'), 'warn'); return; }
    Sandbox.enter('sandbox-ui');
  },

  _onEntered() {
    // Cancel any live Confidence worker/debounce before the sandbox starts
    // mutating Store. The Confidence module also observes this event directly;
    // this optional seam keeps the adapter safe when boot/test wiring orders
    // the cross-module listeners differently.
    (NIMBUS!.Confidence as { _invalidatePending?(clearSuppressed?: boolean): void } | undefined)?._invalidatePending?.(true);
    // So a discarded what-if session leaves no trace in the confidence tracker,
    // same as a discarded optimizer preview (see OptimizerPreview._confSnapshot).
    // Captured here (not in Sandbox.enter()) at the same logical moment as before —
    // the state module doesn't know about the cross-file Confidence module.
    const confidenceSnapshot = NIMBUS!.Confidence?.snapshot?.() ?? null;
    SandboxAdapter._confSnapshot = confidenceSnapshot === null ? null : Util.clone(confidenceSnapshot);
    const lastOptimize = Store.lastOptimize;
    SandboxAdapter._lastOptimizeSnapshot = lastOptimize ? new Date(lastOptimize) : null;
    SandboxAdapter._dismissedSnapshot = Alerts.snapshotDismissed();
    SandboxAdapter._linePlantSnapshot = new Map(
      Object.keys(Store.calendars).map((line) => [line, Store.getPlantForLine(line)]),
    );
    SandboxAdapter._dirtySnapshot = new Set(Persistence._dirtyIds);
    SandboxAdapter._forceSnapshot = new Set(Persistence._forceIds);
    SandboxAdapter._firmDirtySnapshot = new Set(Persistence._firmDirtyIds);
    SandboxAdapter._dirtySourceSnapshot = new Map(Persistence._dirtySource);
    SandboxAdapter._sideEffectSnapshotActive = true;

    document.body.classList.add('sandbox-mode');
    const banner = document.getElementById('sandbox-banner');
    if (banner) banner.hidden = false;

    document.querySelectorAll<HTMLElement>('.sandbox-btn').forEach((btn) => {
      btn.textContent = Util.t('ui.sandbox_on');
      btn.style.color = 'var(--warn)';
      btn.onclick = null;
    });

    Toast.show(Util.t('toast.what_if_mode'), 'info', 1500);
  },

  _onExited(evt: StoreEvent) {
    const applied = !!evt.applied;
    const snap = evt.snapshot as SandboxExitSnapshot | undefined;
    const affectedPlants = applied ? SandboxAdapter._collectAffectedPlants(snap) : null;
    const capturedLinePlants = applied ? SandboxAdapter._linePlantSnapshot : null;

    if (applied) {
      const scenarioName = (document.getElementById('sb-scenario-name') as HTMLInputElement | null)?.value || 'What-If';
      Toast.show(Util.t('toast.scenario_applied', { name: scenarioName }), 'success');
      // Promotion makes the trial side effects the new live baseline. Clear
      // the pre-sandbox copies before any persistence work can run. A later
      // undo/revert must not accidentally restore these discarded copies.
      SandboxAdapter._clearSideEffectSnapshot();
      // Keep the line->plant map: an undo of this applied scenario (_onReverted) needs
      // it to resolve plants of calendar lines that no longer exist. Cleared there.
      SandboxAdapter._linePlantSnapshot = capturedLinePlants;
    } else {
      if (SandboxAdapter._sideEffectSnapshotActive) {
        // Sandbox.exit(false) restores schedule state while Sandbox.active is
        // still true, so task replacement events can arm Confidence's debounce.
        // Cancel that pending work before restoring the detached baseline; the
        // restored score/history must remain authoritative after the 400ms wait.
        (NIMBUS!.Confidence as {
          _invalidatePending?(clearSuppressed?: boolean): void;
          _suppressNextAlertRefresh?(): void;
        } | undefined)?._invalidatePending?.();
        Store.setLastOptimize(
          SandboxAdapter._lastOptimizeSnapshot ? new Date(SandboxAdapter._lastOptimizeSnapshot) : null,
          'sandbox',
        );
        if (SandboxAdapter._dismissedSnapshot) Alerts.restoreDismissed(SandboxAdapter._dismissedSnapshot);
        if (NIMBUS!.Confidence && SandboxAdapter._confSnapshot) {
          NIMBUS!.Confidence!.restore!(Util.clone(SandboxAdapter._confSnapshot));
        }
      }
      // Put back the pre-What-If unsaved-edit sets (the discard's tasks:bulk cleared them,
      // and any dirty ids the trial added belong to state that no longer exists).
      if (SandboxAdapter._dirtySnapshot && SandboxAdapter._forceSnapshot) {
        Persistence._dirtyIds.clear();
        for (const id of SandboxAdapter._dirtySnapshot) Persistence._dirtyIds.add(id);
        Persistence._forceIds.clear();
        for (const id of SandboxAdapter._forceSnapshot) Persistence._forceIds.add(id);
        Persistence._firmDirtyIds.clear();
        for (const id of SandboxAdapter._firmDirtySnapshot ?? []) Persistence._firmDirtyIds.add(id);
        Persistence._dirtySource.clear();
        for (const [id, src] of SandboxAdapter._dirtySourceSnapshot ?? []) Persistence._dirtySource.set(id, src);
        Persistence._syncUnsaved();
      }
      // RestoreDismissed intentionally has no scheduling behavior of its own:
      // this is the one existing post-discard recompute, and it must see the
      // restored dismissal set above.
      SandboxAdapter._clearSideEffectSnapshot();
      (NIMBUS!.Confidence as {
        _suppressNextAlertRefresh?(): void;
        _scheduleStartupRecompute?(delay?: number): void;
      } | undefined)?._suppressNextAlertRefresh?.();
      (NIMBUS!.Confidence as {
        _scheduleStartupRecompute?(delay?: number): void;
      } | undefined)?._scheduleStartupRecompute?.();
      Alerts.scheduleRecompute();
      Toast.show(Util.t('toast.scenario_discarded'), 'info');
    }

    document.body.classList.remove('sandbox-mode');
    const banner = document.getElementById('sandbox-banner');
    if (banner) banner.hidden = true;

    document.querySelectorAll<HTMLElement>('.sandbox-btn').forEach((btn) => {
      btn.textContent = Util.t('ui.sandbox_off');
      btn.style.color = '';
      btn.onclick = () => SandboxAdapter.enter();
    });

    // Promote is an explicit user action, so persist it (cache + backend) the same
    // way Cmd/Ctrl+S-in-sandbox already does. Runs AFTER teardown (Sandbox.active is
    // now false) so saveAll's own Sandbox.exit(true) call no-ops — no recursion.
    // Without this, "Scenario applied" showed but a reload before a later unrelated
    // save lost the promoted edits (autosave is suppressed during sandbox).
    if (applied) {
      NIMBUS!.Persistence!.saveAll!({ silent: true });
      // Calendar/blackout writes were suppressed during What-If (CalendarSync._post
      // guards on Sandbox.active); push the promoted config now that active=false.
      // Diff the pre-sandbox snapshot to also propagate blackouts DELETED in-session,
      // so a delete-then-promote doesn't resurrect the block on next hydration. (F3)
      // Include every plant touched by the trial, not just the plant selected at
      // promote time: plant selection remains editable while What-If is active.
      if (Store.selectedPlant) affectedPlants?.add(Store.selectedPlant);
      for (const plant of affectedPlants || []) {
        // Store._state.blocks/.plantBlocks direct touch — deliberate, out of scope
        // for this task (see the file header comment above OptimizeDialog).
        const curLine  = new Set(Store._state.blocks.filter((b) => b.plant === plant).map((b) => b.id));
        const curPlant = new Set(Store._state.plantBlocks.filter((b) => b.plant === plant).map((b) => b.id));
        const curPeriods = new Set(Store.getPlantPeriods(plant).map((p) => p.id));
        const removed = {
          line:  (snap?.blocks || []).filter((b) => b.plant === plant && !curLine.has(b.id)).map((b) => b.id),
          plant: (snap?.plantBlocks || []).filter((b) => b.plant === plant && !curPlant.has(b.id)).map((b) => b.id),
          // Dated periods deleted in-session (same reason as blackouts: a promote must not resurrect them).
          periods: (snap?.plants?.[plant]?.periods || []).filter((p) => !curPeriods.has(p.id)).map((p) => p.id),
        };
        CalendarSync.flushPlant(plant, removed, capturedLinePlants || undefined);
      }
      // Promotion changes Store.rev() (UndoStack.push plus sandbox teardown),
      // invalidating any worker request started during the trial. Queue one full
      // post-promote request after all retained side effects are in place.
      Alerts.scheduleRecompute();
    }

    // If a plant-config hydration was dropped because its GET resolved mid-What-If (F2),
    // re-apply it now that Sandbox is inactive. On DISCARD we pull backend truth (the
    // restored snapshot is the pre-hydration cached state); on promote the user's edits
    // were just flushed, so skip to avoid re-clobbering them.
    const deferred = CalendarSync._deferredHydrationPlant;
    CalendarSync._deferredHydrationPlant = null;
    if (deferred && !applied && deferred === Store.selectedPlant) {
      CalendarSync.fetchPlantConfig(deferred);
    }
  },

  // Fired when the user undoes a PROMOTED (applied=true) scenario via UndoStack —
  // Sandbox.exit()'s undo closure (in schedule-state.mjs) restores tasks/firmedIds
  // then emits this instead of calling Alerts/Toast directly (those are cross-module
  // concerns the state module doesn't own). Matches the pre-refactor inline behavior.
  _onReverted(evt?: StoreEvent) {
    // The promoted scenario intentionally kept its side effects. Revert is a
    // schedule undo event, not a request to restore the pre-sandbox metadata;
    // only clear any stale adapter copies before the normal alert refresh.
    // (_linePlantSnapshot is kept until after the flush below, which resolves plants through it.)
    const linePlants = SandboxAdapter._linePlantSnapshot;
    SandboxAdapter._clearSideEffectSnapshot();
    SandboxAdapter._linePlantSnapshot = linePlants;
    // Undo restored the pre-What-If calendar slices in Store, but Promote had already
    // POSTed the promoted ones. Re-sync every plant whose calendar state differs between
    // the promoted slices (evt.promoted) and the restored Store: flushPlant upserts the
    // restored hours/blackouts and deletes blackouts that exist only in the promoted state.
    const promoted = evt?.promoted as SandboxExitSnapshot | undefined;
    if (promoted) {
      for (const plant of SandboxAdapter._collectAffectedPlants(promoted)) {
        const curLine  = new Set(Store.blocks.filter((b) => b.plant === plant).map((b) => b.id));
        const curPlant = new Set(Store.plantBlocks.filter((b) => b.plant === plant).map((b) => b.id));
        const curPeriods = new Set(Store.getPlantPeriods(plant).map((p) => p.id));
        CalendarSync.flushPlant(plant, {
          line:  promoted.blocks.filter((b) => b.plant === plant && !curLine.has(b.id)).map((b) => b.id),
          plant: promoted.plantBlocks.filter((b) => b.plant === plant && !curPlant.has(b.id)).map((b) => b.id),
          periods: (promoted.plants?.[plant]?.periods || []).filter((p) => !curPeriods.has(p.id)).map((p) => p.id),
        });
      }
    }
    SandboxAdapter._linePlantSnapshot = null;
    (NIMBUS!.Confidence as { _invalidatePending?(clearSuppressed?: boolean): void } | undefined)?._invalidatePending?.(true);
    Alerts.scheduleRecompute();
    Toast.show(Util.t('toast.scenario_discarded'), 'info');
  },

  _clearSideEffectSnapshot() {
    SandboxAdapter._confSnapshot = null;
    SandboxAdapter._lastOptimizeSnapshot = null;
    SandboxAdapter._dismissedSnapshot = null;
    SandboxAdapter._linePlantSnapshot = null;
    SandboxAdapter._dirtySnapshot = null;
    SandboxAdapter._forceSnapshot = null;
    SandboxAdapter._firmDirtySnapshot = null;
    SandboxAdapter._dirtySourceSnapshot = null;
    SandboxAdapter._sideEffectSnapshotActive = false;
  },

  _sameSnapshotValue(before: unknown, current: unknown): boolean {
    if (Object.is(before, current)) return true;
    try { return JSON.stringify(before) === JSON.stringify(current); } catch { return false; }
  },

  _collectAffectedPlants(snap: SandboxExitSnapshot | undefined): Set<string> {
    const affected = new Set<string>();
    const add = (plant: unknown): void => {
      if (typeof plant === 'string' && plant) affected.add(plant);
    };

    const beforePlants = snap?.plants || {};
    const currentPlants = Store.plants;
    for (const plant of new Set([...Object.keys(beforePlants), ...Object.keys(currentPlants)])) {
      if (!SandboxAdapter._sameSnapshotValue(beforePlants[plant], currentPlants[plant])) add(plant);
    }

    const beforeCalendars = snap?.calendars || {};
    const currentCalendars = Store.calendars;
    for (const line of new Set([...Object.keys(beforeCalendars), ...Object.keys(currentCalendars)])) {
      if (!SandboxAdapter._sameSnapshotValue(beforeCalendars[line], currentCalendars[line])) {
        add(SandboxAdapter._linePlantSnapshot?.get(line));
        add(Store.getPlantForLine(line));
      }
    }

    const collectChangedBlockPlants = <T extends { id: string; plant?: string | null }>(
      before: T[], current: T[],
    ): void => {
      const beforeById = new Map(before.map(block => [String(block.id), block]));
      const currentById = new Map(current.map(block => [String(block.id), block]));
      for (const id of new Set([...beforeById.keys(), ...currentById.keys()])) {
        const oldBlock = beforeById.get(id);
        const newBlock = currentById.get(id);
        if (!SandboxAdapter._sameSnapshotValue(oldBlock, newBlock)) {
          add(oldBlock?.plant);
          add(newBlock?.plant);
        }
      }
    };
    collectChangedBlockPlants(snap?.blocks || [], Store.blocks);
    collectChangedBlockPlants(snap?.plantBlocks || [], Store.plantBlocks);
    return affected;
  },
};

// State snapshot attached to error-level log entries.
ErrorLog.registerStateProvider('optimization', () => ({
  bgRun: !!OptimizerPreview._backgroundRun,
  plant: OptimizerPreview._backgroundRun?.plant ?? null,
}));
