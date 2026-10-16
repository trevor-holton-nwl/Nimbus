// calendar/edit-calendar.mjs — EditCalendar, the per-line/plant working-hours
// modal (14 Flatpickr pickers). Extracted verbatim from schedule-workbench.mts
// (Phase P3 of docs/architecture/domain-refactor-plan.md, which split that
// 10,391-line mega-module into 6 domain files). A single contiguous source
// range — the only one of the six new files that is.
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
import type { WorkHours } from '../platform/types.mjs';

/** EditCalendar.applyPreset's three named quick-pick presets (Weekdays,
 *  Mon-Sat, All 7 Days). */
interface CalendarPreset {
  days: number[];
  s: string;
  e: string;
}

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
  let _plantMode = false;
  let _plantName: string | null = null;

  function open(line: string) {
    _plantMode = false;
    _plantName = null;
    _line = line;
    Store.ensureCalendar(line);
    _renderHeader();
    _initPickers();
    _populate();
    const el = document.getElementById('modal-edit-calendar');
    if (!el) return;
    const copyBtn = el.querySelector<HTMLElement>('.cal-copy-plant-btn');
    if (copyBtn) copyBtn.style.display = '';
    el.hidden = false;
    requestAnimationFrame(() => el.querySelector('.cal-edit-modal')?.classList.add('visible'));
  }

  function openPlant(name: string) {
    _plantMode = true;
    _plantName = name;
    _line = null;
    Store.ensurePlant(name);
    _renderHeader();
    _initPickers();
    _populate();
    const el = document.getElementById('modal-edit-calendar');
    if (!el) return;
    const copyBtn = el.querySelector<HTMLElement>('.cal-copy-plant-btn');
    if (copyBtn) copyBtn.style.display = 'none';
    el.hidden = false;
    requestAnimationFrame(() => el.querySelector('.cal-edit-modal')?.classList.add('visible'));
  }

  function close() {
    const el = document.getElementById('modal-edit-calendar');
    el?.querySelector('.cal-edit-modal')?.classList.remove('visible');
    setTimeout(() => { if (el) el.hidden = true; }, 230);
  }

  function _renderHeader() {
    const nameEl = document.getElementById('cal-edit-line-name');
    const plantEl = document.getElementById('cal-edit-plant-name');
    if (_plantMode) {
      if (nameEl)  nameEl.textContent  = `Plant ${_plantName}`;
      if (plantEl) plantEl.textContent = '';
    } else {
      const plant = Store.getPlantForLine(_line!);
      if (nameEl)  nameEl.textContent  = _line;
      if (plantEl) plantEl.textContent = `Plant ${plant}`;
    }
  }

  function _populate() {
    const wh = _plantMode
      ? Store.plants[_plantName!].workHours
      : Store.calendars[_line!].workHours;
    document.querySelectorAll('.cal-preset-chip').forEach(c => c.classList.remove('active'));
    for (let d = 0; d < 7; d++) {
      const enabled = !!wh[d];
      const tog = document.getElementById(`cal-edit-toggle-${d}`) as HTMLInputElement | null;
      if (tog) tog.checked = enabled;
      _setRowEnabled(d, enabled);
      if (_fp.length === 14) {
        if (enabled) {
          _fp[d * 2]?.setDate(Util.hoursToTimeString(wh[d]![0]), false);
          _fp[d * 2 + 1]?.setDate(Util.hoursToTimeString(wh[d]![1]), false);
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
      badge.textContent = hrs > 0
        ? `${hrs % 1 === 0 ? hrs : hrs.toFixed(1)}h`
        : '—';
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
        _fp[d * 2]?.setDate(Util.hoursToTimeString(ph[d]![0]), false);
        _fp[d * 2 + 1]?.setDate(Util.hoursToTimeString(ph[d]![1]), false);
      }
      _setRowEnabled(d, enabled);
      _refreshBadge(d);
    }
    document.querySelectorAll('.cal-preset-chip').forEach(c => c.classList.remove('active'));
    Toast.show(Util.t('toast.copied_from_plant'), 'success');
  }

  function save() {
    if (!_plantMode && !_line) return;
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
        if (eh <= sh) { Toast.show(Util.t('toast.end_must_be_after_start'), 'error'); return; }
        newWh[d] = [sh, eh];
      } else {
        newWh[d] = null;
      }
    }
    if (_plantMode) {
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

  return { open, openPlant, close, save, onToggle, applyPreset, copyFromPlant };
})();
