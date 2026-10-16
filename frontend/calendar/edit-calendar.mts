// calendar/edit-calendar.mjs — EditCalendar, the per-line/plant working-hours
// modal (14 Flatpickr pickers). Extracted verbatim from schedule-workbench.mts
// (Phase P3 of docs/architecture/domain-refactor-plan.md, which split that
// 10,391-line mega-module into 6 domain files). A single contiguous source
// range — the only one of the six new files that is.
//
// Calendar periods (docs/CALENDAR_PERIODS_DESIGN.md) added a third mode,
// 'period': the same weekly grid edits a dated period's hours, with a Name and
// Valid from / Valid to block above it. `calendar-periods-ui.mjs` owns the
// persistence call; the two modules import each other, which is safe because
// every cross-reference sits inside a function body (never at module load).
//
// `CalendarPreset` below was declared in the original file's combined
// "EditCalendar/ColorWheelViewer/AlertsUIAdapter/SandboxAdapter/Printer local
// types" header block (Task 8); relocated here as the only one of those five
// modules that uses it (`SandboxExitSnapshot`, the block's other type, moved
// to optimization/optimize-ui.mjs with SandboxAdapter instead).
/* global NIMBUS */
import { Util, Toast } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import { Sandbox } from '../optimization/sandbox.mjs';
import { CalendarSync } from './calendar-sync.mjs';
import { CalendarPeriodsUI } from './calendar-periods-ui.mjs';
import { addDaysKey, keyToDate, nextPeriodDefaults, periodWarnings, validatePeriodDraft } from './calendar-periods.mjs';
import type { PeriodDraft, PeriodIssue } from './calendar-periods.mjs';
import type { WorkHours } from '../platform/types.mjs';

/** EditCalendar.applyPreset's three named quick-pick presets (Weekdays,
 *  Mon-Sat, All 7 Days). */
interface CalendarPreset {
  days: number[];
  s: string;
  e: string;
}

type EditMode = 'line' | 'plant' | 'period';
type PeriodField = 'name' | 'from' | 'to' | 'overlap';

/* =============================================================================
   EDIT CALENDAR — per-line working hours modal.
   Opens from the "Edit Calendar" button in each ProdLines accordion.
   Writes to Store.setCalendar() and triggers ProdLines.render() on save.
   DB-ready: Store.calendars[line].workHours = { 0: [h1,h2]|null, ...6 }
   maps to: line_calendar(line_code, day_of_week, is_open, start_hour, end_hour)
   ========================================================================== */
export const EditCalendar = (() => {
  let _line: string | null = null;
  let _fp: NimbusVendor.FlatpickrInstance[] = []; // 14 flatpickr instances: [start0, end0, start1, end1, ..., start6, end6]
  let _mode: EditMode = 'line';
  let _plantName: string | null = null;
  // Period mode state.
  let _periodId: string | null = null;
  let _periodPlant: string | null = null;
  let _periodHours: WorkHours | null = null;
  let _fpPeriod: NimbusVendor.FlatpickrInstance[] = []; // [validFrom, validTo], date-only
  let _periodWired = false;
  let _periodTried = false;   // Save was attempted: validate live from then on
  let _prevTo = '';           // last Valid-to value, restored when "No end date" is unticked

  const PERIOD_INPUT_IDS: Record<PeriodField, string[]> = {
    name: ['cal-period-name'],
    from: ['cal-period-from'],
    to: ['cal-period-to'],
    overlap: ['cal-period-from', 'cal-period-to'],
  };
  const PERIOD_ERR_IDS: Record<PeriodField, string> = {
    name: 'cal-period-name-err',
    from: 'cal-period-from-err',
    to: 'cal-period-to-err',
    overlap: 'cal-period-overlap-err',
  };

  function _show(el: HTMLElement) {
    el.hidden = false;
    requestAnimationFrame(() => el.querySelector('.cal-edit-modal')?.classList.add('visible'));
  }

  function open(line: string) {
    _mode = 'line';
    _plantName = null;
    _periodId = null;
    _line = line;
    Store.ensureCalendar(line);
    _renderHeader();
    _initPickers();
    _populate();
    const el = document.getElementById('modal-edit-calendar');
    if (!el) return;
    _setPeriodMode(false);
    const copyBtn = el.querySelector<HTMLElement>('.cal-copy-plant-btn');
    if (copyBtn) copyBtn.style.display = '';
    _show(el);
  }

  function openPlant(name: string) {
    _mode = 'plant';
    _plantName = name;
    _periodId = null;
    _line = null;
    Store.ensurePlant(name);
    _renderHeader();
    _initPickers();
    _populate();
    const el = document.getElementById('modal-edit-calendar');
    if (!el) return;
    _setPeriodMode(false);
    const copyBtn = el.querySelector<HTMLElement>('.cal-copy-plant-btn');
    if (copyBtn) copyBtn.style.display = 'none';
    _show(el);
  }

  /** Open the editor on one dated period of `plant` (or a new one when `id` is omitted). The
   *  weekly grid edits the period's own hours; a new period starts from the plant default week. */
  function openPeriod(plant: string, id?: string) {
    if (!plant) return;
    Store.ensurePlant(plant);
    const existing = id ? Store.getPlantPeriods(plant).find(p => p.id === id) : undefined;
    if (id && !existing) return; // deleted elsewhere since the row was rendered
    _mode = 'period';
    _periodPlant = plant;
    _periodId = existing ? existing.id : null;
    _plantName = null;
    _line = null;
    _periodTried = false;
    _periodHours = Util.clone(existing ? existing.workHours : Store.plants[plant].workHours);
    _renderHeader();
    _initPickers();
    _populate();
    _initPeriodPickers();
    const todayKey = Util.dayKey(Store.plantNow(plant) ?? new Date());
    const defaults = nextPeriodDefaults(Store.getPlantPeriods(plant), todayKey);
    _fillPeriodFields(
      existing ? existing.name : '',
      existing ? existing.validFrom : defaults.validFrom,
      existing ? existing.validTo : defaults.validTo,
    );
    _clearPeriodErrors();
    const el = document.getElementById('modal-edit-calendar');
    if (!el) return;
    _setPeriodMode(true);
    const copyBtn = el.querySelector<HTMLElement>('.cal-copy-plant-btn');
    if (copyBtn) copyBtn.style.display = 'none';
    _show(el);
    requestAnimationFrame(() => document.getElementById('cal-period-name')?.focus());
  }

  function close() {
    const el = document.getElementById('modal-edit-calendar');
    el?.querySelector('.cal-edit-modal')?.classList.remove('visible');
    setTimeout(() => { if (el) el.hidden = true; }, 230);
  }

  /** Toggle the period-only chrome: the Name/dates block, and the footer button label. */
  function _setPeriodMode(on: boolean) {
    const block = document.getElementById('cal-edit-period-fields');
    if (block) block.hidden = !on;
    const label = document.getElementById('cal-edit-save-label');
    if (label) label.textContent = Util.t(on ? 'btn.save_period' : 'btn.save_changes');
    document.getElementById('cal-edit-close-btn')?.setAttribute('aria-label', Util.t('aria.cal_edit_close'));
  }

  function _renderHeader() {
    const titleEl = document.getElementById('cal-edit-title');
    const nameEl = document.getElementById('cal-edit-line-name');
    const plantEl = document.getElementById('cal-edit-plant-name');
    if (titleEl) titleEl.textContent = Util.t(_mode === 'period' ? 'modal.period_title' : 'modal.edit_calendar');
    if (_mode === 'plant' || _mode === 'period') {
      const plant = _mode === 'plant' ? _plantName : _periodPlant;
      if (nameEl)  nameEl.textContent  = Util.t('ui.cal_plant_label', { name: plant ?? '' });
      if (plantEl) plantEl.textContent = '';
    } else {
      const plant = Store.getPlantForLine(_line!);
      if (nameEl)  nameEl.textContent  = _line;
      if (plantEl) plantEl.textContent = Util.t('ui.cal_plant_label', { name: plant ?? '' });
    }
  }

  /** The picker cannot express 24, so an end-of-day end time is shown as 00:00 (read back by _endHours). */
  function _toTimeString(h: number, isEnd: boolean): string {
    return isEnd && h >= 24 ? '00:00' : Util.hoursToTimeString(h);
  }

  function _currentHours(): WorkHours {
    if (_mode === 'period') return _periodHours!;
    return _mode === 'plant'
      ? Store.plants[_plantName!].workHours
      : Store.calendars[_line!].workHours;
  }

  function _populate() {
    const wh = _currentHours();
    document.querySelectorAll('.cal-preset-chip').forEach(c => c.classList.remove('active'));
    for (let d = 0; d < 7; d++) {
      const enabled = !!wh[d];
      const tog = document.getElementById(`cal-edit-toggle-${d}`) as HTMLInputElement | null;
      if (tog) tog.checked = enabled;
      _setRowEnabled(d, enabled);
      if (_fp.length === 14) {
        if (enabled) {
          _fp[d * 2]?.setDate(_toTimeString(wh[d]![0], false), false);
          _fp[d * 2 + 1]?.setDate(_toTimeString(wh[d]![1], true), false);
        } else {
          // Clear a closed day's pickers so a later toggle-on falls back to the
          // 08:00/17:00 defaults in onToggle, not the last-opened calendar's times.
          _fp[d * 2]?.clear();
          _fp[d * 2 + 1]?.clear();
        }
      }
      _refreshBadge(d);
    }
  }

  /** 00:00 as an end time means end of day (24:00); the picker cannot express 24. */
  function _endHours(t: string): number {
    const h = Util.timeStringToHours(t);
    return h === 0 ? 24 : h;
  }

  function _initPickers() {
    if (_fp.length === 14) return;
    _fp = [];
    for (let d = 0; d < 7; d++) {
      const mkCfg = () => ({
        enableTime: true, noCalendar: true,
        dateFormat: 'H:i', altInput: true, altFormat: 'h:i K',
        minuteIncrement: 30,
        onChange: () => _refreshBadge(d),
      });
      _fp.push(
        flatpickr(`#cal-edit-start-${d}`, mkCfg()),
        flatpickr(`#cal-edit-end-${d}`,   mkCfg())
      );
    }
  }

  function _setRowEnabled(d: number, enabled: boolean) {
    const row = document.getElementById(`cal-edit-row-${d}`);
    row?.classList.toggle('cal-day-off', !enabled);
    // Disable the altInput flatpickr renders (the visible element)
    const startAlt = document.querySelector(`#cal-edit-start-${d} ~ input.flatpickr-input`) as HTMLInputElement | null;
    const endAlt   = document.querySelector(`#cal-edit-end-${d} ~ input.flatpickr-input`) as HTMLInputElement | null;
    [startAlt, endAlt].forEach((inp) => { if (inp) inp.disabled = !enabled; });
  }

  function _refreshBadge(d: number) {
    const badge = document.getElementById(`cal-edit-badge-${d}`);
    if (!badge) return;
    const tog = document.getElementById(`cal-edit-toggle-${d}`) as HTMLInputElement | null;
    if (!tog?.checked) { badge.textContent = '—'; return; }
    const s = _fp[d * 2]?.element?.value;
    const e = _fp[d * 2 + 1]?.element?.value;
    if (s && e) {
      const hrs = _endHours(e) - Util.timeStringToHours(s);
      if (hrs > 0) {
        const h = `${hrs % 1 === 0 ? hrs : hrs.toFixed(1)}h`;
        // A 00:00 end reads as midnight (24:00); say so, since the picker shows 12:00 AM.
        badge.textContent = Util.timeStringToHours(e) === 0 ? `${h} · ${Util.t('ui.cal_to_midnight')}` : h;
      } else {
        badge.textContent = '—';
      }
    } else {
      badge.textContent = '—';
    }
  }

  function onToggle(d: number, checked: boolean) {
    _setRowEnabled(d, checked);
    if (checked && _fp.length === 14) {
      if (!_fp[d * 2]?.element?.value)     _fp[d * 2]?.setDate('08:00', false);
      if (!_fp[d * 2 + 1]?.element?.value) _fp[d * 2 + 1]?.setDate('17:00', false);
    }
    _refreshBadge(d);
  }

  function applyPreset(preset: string) {
    const PRESETS: Record<string, CalendarPreset> = {
      mf:  { days: [1,2,3,4,5],     s: '08:00', e: '17:00' },
      ms:  { days: [1,2,3,4,5,6],   s: '08:00', e: '17:00' },
      all: { days: [0,1,2,3,4,5,6], s: '08:00', e: '17:00' },
    };
    const p = PRESETS[preset];
    if (!p) return;
    document.querySelectorAll<HTMLElement>('.cal-preset-chip')
      .forEach((c) => c.classList.toggle('active', c.dataset.preset === preset));
    for (let d = 0; d < 7; d++) {
      const enabled = p.days.includes(d);
      const tog = document.getElementById(`cal-edit-toggle-${d}`) as HTMLInputElement | null;
      if (tog) tog.checked = enabled;
      if (enabled && _fp.length === 14) {
        _fp[d * 2]?.setDate(p.s, false);
        _fp[d * 2 + 1]?.setDate(p.e, false);
      }
      _setRowEnabled(d, enabled);
      _refreshBadge(d);
    }
  }

  function copyFromPlant() {
    const plant = Store.getPlantForLine(_line!);
    if (!plant) { Toast.show(Util.t('toast.no_plant_assigned_line'), 'warn'); return; }
    Store.ensurePlant(plant);
    const ph = Store.plants[plant].workHours;
    for (let d = 0; d < 7; d++) {
      const enabled = !!ph[d];
      const tog = document.getElementById(`cal-edit-toggle-${d}`) as HTMLInputElement | null;
      if (tog) tog.checked = enabled;
      if (enabled && _fp.length === 14) {
        _fp[d * 2]?.setDate(_toTimeString(ph[d]![0], false), false);
        _fp[d * 2 + 1]?.setDate(_toTimeString(ph[d]![1], true), false);
      }
      _setRowEnabled(d, enabled);
      _refreshBadge(d);
    }
    document.querySelectorAll('.cal-preset-chip').forEach(c => c.classList.remove('active'));
    Toast.show(Util.t('toast.copied_from_plant'), 'success');
  }

  /** Read the 7 day rows into a WorkHours map. Returns null (after an error toast) when a
   *  day ends at or before its start, so the caller aborts the save. */
  function _collectWorkHours(): WorkHours | null {
    const newWh: WorkHours = {};
    for (let d = 0; d < 7; d++) {
      const tog = document.getElementById(`cal-edit-toggle-${d}`) as HTMLInputElement | null;
      if (!tog?.checked) { newWh[d] = null; continue; }
      const s = _fp[d * 2]?.element?.value;
      const e = _fp[d * 2 + 1]?.element?.value;
      if (s && e) {
        const sh = Util.timeStringToHours(s), eh = _endHours(e);
        // Reject degenerate/inverted days client-side so we never diverge from the
        // backend (_clean_work_hours rejects end <= start with a 400).
        if (eh <= sh) { Toast.show(Util.t('toast.end_must_be_after_start'), 'error'); return null; }
        newWh[d] = [sh, eh];
      } else {
        newWh[d] = null;
      }
    }
    return newWh;
  }

  /* ---------------------------------------------------------------------------
     Period mode: Name / Valid from / Valid to
     ------------------------------------------------------------------------ */

  function _visibleInput(id: string): HTMLInputElement | null {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return null;
    // Flatpickr's altInput is the visible control; the original input is hidden behind it.
    const idx = id === 'cal-period-from' ? 0 : id === 'cal-period-to' ? 1 : -1;
    const alt = idx >= 0 ? (_fpPeriod[idx]?.altInput as HTMLInputElement | undefined) : undefined;
    return alt ?? el;
  }

  function _initPeriodPickers() {
    if (_fpPeriod.length !== 2) {
      const mkCfg = () => ({
        dateFormat: 'Y-m-d', altInput: true, altFormat: Util._dateFormatPref(),
        altInputClass: 'input', onChange: () => _onPeriodFieldChange(),
      });
      _fpPeriod = [flatpickr('#cal-period-from', mkCfg()), flatpickr('#cal-period-to', mkCfg())];
    } else {
      // The per-user date format may have changed since the pickers were built.
      for (const fp of _fpPeriod) if (typeof fp.set === 'function') fp.set('altFormat', Util._dateFormatPref());
    }
    _fpPeriod.forEach((fp, i) => {
      (fp.altInput as HTMLInputElement | undefined)?.setAttribute?.('aria-label', Util.t(i === 0 ? 'ui.valid_from' : 'ui.valid_to'));
    });
    if (_periodWired) return;
    _periodWired = true;
    document.getElementById('cal-period-noend')?.addEventListener('change', (ev) => {
      _applyNoEnd((ev.target as HTMLInputElement).checked);
      _onPeriodFieldChange();
    });
    document.getElementById('cal-period-name')?.addEventListener('input', () => _onPeriodFieldChange());
  }

  function _setToDisabled(disabled: boolean) {
    const alt = _visibleInput('cal-period-to');
    if (alt) alt.disabled = disabled;
  }

  /** "No end date" ticked: clear and lock Valid to (remembering it); unticked: restore it. */
  function _applyNoEnd(noEnd: boolean) {
    const toFp = _fpPeriod[1];
    if (noEnd) {
      const cur = toFp?.element?.value;
      if (cur) _prevTo = cur;
      toFp?.clear();
      _setToDisabled(true);
    } else {
      _setToDisabled(false);
      const from = _fpPeriod[0]?.element?.value;
      const restore = _prevTo || (from ? addDaysKey(from, 6) : '');
      if (restore) toFp?.setDate(restore, false);
    }
  }

  function _fillPeriodFields(name: string, from: string, to: string | null) {
    const nameEl = document.getElementById('cal-period-name') as HTMLInputElement | null;
    if (nameEl) nameEl.value = name;
    _fpPeriod[0]?.setDate(from, false);
    const noEnd = document.getElementById('cal-period-noend') as HTMLInputElement | null;
    if (noEnd) noEnd.checked = to === null;
    _prevTo = to ?? addDaysKey(from, 6);
    if (to === null) {
      _fpPeriod[1]?.clear();
      _setToDisabled(true);
    } else {
      _fpPeriod[1]?.setDate(to, false);
      _setToDisabled(false);
    }
  }

  function _readPeriodDraft(workHours: WorkHours): PeriodDraft {
    const name = (document.getElementById('cal-period-name') as HTMLInputElement | null)?.value ?? '';
    const noEnd = !!(document.getElementById('cal-period-noend') as HTMLInputElement | null)?.checked;
    const to = _fpPeriod[1]?.element?.value ?? '';
    return {
      id: _periodId ?? Util.uid('pper'),
      name: name.trim(),
      validFrom: _fpPeriod[0]?.element?.value ?? '',
      validTo: noEnd ? null : to,
      workHours,
    };
  }

  function _fmtKey(key: string | null): string {
    return key ? Util._fmtDatePref(keyToDate(key)) : Util.t('ui.no_end_date');
  }

  function _issueText(issue: PeriodIssue): string {
    const p = issue.params;
    return Util.t(`err.${issue.code}`, p ? { name: p.name, from: _fmtKey(p.from), to: _fmtKey(p.to) } : undefined);
  }

  /** Show (or with null text, clear) one inline error and wire aria-invalid / aria-describedby. */
  function setPeriodError(field: PeriodField, text: string | null) {
    const errEl = document.getElementById(PERIOD_ERR_IDS[field]);
    if (errEl) { errEl.textContent = text ?? ''; errEl.hidden = !text; }
    for (const id of PERIOD_INPUT_IDS[field]) {
      const input = _visibleInput(id);
      if (!input) continue;
      if (text) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', PERIOD_ERR_IDS[field]);
        input.classList?.add('is-invalid');
      } else {
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
        input.classList?.remove('is-invalid');
      }
    }
  }

  function _clearPeriodErrors() {
    (['name', 'from', 'to', 'overlap'] as PeriodField[]).forEach(f => setPeriodError(f, null));
    const warn = document.getElementById('cal-period-closed-warn');
    if (warn) { warn.textContent = ''; warn.hidden = true; }
  }

  /** Validate the draft; shows every issue inline and returns true when it can be saved. */
  function _validatePeriod(workHours: WorkHours): PeriodDraft | null {
    _clearPeriodErrors();
    const draft = _readPeriodDraft(workHours);
    const existing = Store.getPlantPeriods(_periodPlant!);
    const issues = validatePeriodDraft(draft, existing);
    const filtered = issues;
    for (const issue of filtered) setPeriodError(issue.field, _issueText(issue));
    const warn = document.getElementById('cal-period-closed-warn');
    if (warn && !filtered.length) {
      const warnings = periodWarnings(draft);
      if (warnings.length) { warn.textContent = Util.t('warn.period_all_closed_long'); warn.hidden = false; }
    }
    if (filtered.length) {
      const first = filtered[0].field;
      const target = first === 'overlap' ? _visibleInput('cal-period-from') : _visibleInput(PERIOD_INPUT_IDS[first][0]);
      target?.focus?.();
      return null;
    }
    return draft;
  }

  function _onPeriodFieldChange() {
    if (!_periodTried || _mode !== 'period') return;
    const wh = _collectWorkHoursQuiet();
    if (wh) _validatePeriod(wh);
  }

  /** Like _collectWorkHours but silent, for live re-validation while the user is still typing. */
  function _collectWorkHoursQuiet(): WorkHours | null {
    const out: WorkHours = {};
    for (let d = 0; d < 7; d++) {
      const tog = document.getElementById(`cal-edit-toggle-${d}`) as HTMLInputElement | null;
      const s = _fp[d * 2]?.element?.value, e = _fp[d * 2 + 1]?.element?.value;
      if (!tog?.checked || !s || !e) { out[d] = null; continue; }
      out[d] = [Util.timeStringToHours(s), _endHours(e)];
    }
    return out;
  }

  function _savePeriod() {
    _periodTried = true;
    const wh = _collectWorkHours();
    if (!wh) return;
    const draft = _validatePeriod(wh);
    if (!draft) return;
    // Period mode deliberately skips _persistPlantHours / clampLinesToPlant / ProdLines.render:
    // a period never rewrites the plant default or any line calendar.
    void CalendarPeriodsUI.save(draft, _periodPlant);
  }

  function save() {
    if (_mode === 'period') { _savePeriod(); return; }
    if (_mode !== 'plant' && !_line) return;
    const newWh = _collectWorkHours();
    if (!newWh) return;
    if (_mode === 'plant') {
      Store.plants[_plantName!].workHours = newWh;
      const changed = new Set<string>();
      for (let d = 0; d < 7; d++) for (const l of Store.clampLinesToPlant(_plantName!, d)) changed.add(l);
      NIMBUS!.Plant!._persistPlantHours!(_plantName, changed);
      NIMBUS!.Plant!.render!();
      close();
      Toast.show(Util.t(Sandbox.active ? 'toast.calendar_whatif_local' : 'toast.calendar_changes_pending'), 'info');
    } else {
      Store.setCalendar(_line!, newWh, 'edit-calendar');
      const plant = Store.getPlantForLine(_line!) || Store.selectedPlant;
      if (plant) CalendarSync.saveLineHours(plant, _line!, newWh);
      NIMBUS!.ProdLines!.render!();
      close();
      Toast.show(Util.t(Sandbox.active ? 'toast.calendar_whatif_local' : 'toast.calendar_changes_pending'), 'info');
    }
  }

  return { open, openPlant, openPeriod, close, save, onToggle, applyPreset, copyFromPlant, setPeriodError };
})();
