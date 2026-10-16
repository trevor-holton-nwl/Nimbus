// calendar/calendar-periods-ui.mjs — the Plant > Calendar tab's dated periods:
// the periods list, the timeline strip, and the save/delete flows
// (docs/CALENDAR_PERIODS_DESIGN.md). Pure math lives in calendar-periods.mjs;
// the editor modal is EditCalendar.openPeriod; persistence is
// CalendarSync.savePlantPeriods (pessimistic: the Store changes only after the
// server acknowledges, so a refusal leaves the editor open on the user's input).
//
// Import cycle: edit-calendar.mjs <-> this module. Both directions are used
// only inside function bodies, never at module load, so it is safe. admin-ui.mjs
// is NOT imported here (it imports this module); "is the Calendar tab on screen"
// is answered from the DOM instead.
import { Util, Toast, Modal } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import { CalendarSync } from './calendar-sync.mjs';
import { EditCalendar } from './edit-calendar.mjs';
import { buildPeriodStrip, keyToDate, periodStatus, summarizeWeek } from './calendar-periods.mjs';
import type { PeriodStatus } from './calendar-periods.mjs';
import type { PlantPeriod } from '../platform/types.mjs';

const DAY_KEYS = ['day.sun', 'day.mon', 'day.tue', 'day.wed', 'day.thu', 'day.fri', 'day.sat'];
const BADGE_CLASS: Record<PeriodStatus, string> = { active: 'badge-ok', upcoming: 'badge-info', past: 'badge-muted' };
const STATUS_KEY: Record<PeriodStatus, string> = { active: 'ui.period_active', upcoming: 'ui.period_upcoming', past: 'ui.period_past' };

let _inited = false;
let _saving = false;

function _fmtKey(key: string | null): string {
  return key ? Util._fmtDatePref(keyToDate(key)) : Util.t('ui.no_end_date');
}

function _range(p: PlantPeriod): string {
  return `${_fmtKey(p.validFrom)} → ${_fmtKey(p.validTo)}`;
}

function _sorted(plant: string): PlantPeriod[] {
  return [...Store.getPlantPeriods(plant)].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
}

function _todayKey(plant: string): string {
  return Util.dayKey(Store.plantNow(plant) ?? new Date());
}

function _fmtMonth(date: Date): string {
  try { return new Intl.DateTimeFormat(Util.locale(), { month: 'short' }).format(date); }
  catch { return new Intl.DateTimeFormat('en', { month: 'short' }).format(date); }
}

function _rowHtml(p: PlantPeriod, todayKey: string, dayLabels: string[]): string {
  const status = periodStatus(p, todayKey);
  const summary = summarizeWeek(p.workHours, dayLabels, { closed: Util.t('ui.week_closed'), closedAll: Util.t('ui.week_closed_all') });
  const name = Util.escapeHtml(p.name);
  const id = Util.escapeHtml(p.id);
  const range = Util.escapeHtml(_range(p));
  return `<div class="period-row${status === 'past' ? ' period-row-past' : ''}" data-id="${id}">
    <span class="period-name" title="${name}">${name}</span>
    <span class="line-badge ${BADGE_CLASS[status]}">${Util.escapeHtml(Util.t(STATUS_KEY[status]))}</span>
    <span class="period-range" title="${range}">${range}</span>
    <span class="period-summary" title="${Util.escapeHtml(summary.full)}">${Util.escapeHtml(summary.short)}</span>
    <button type="button" class="btn btn-ghost sm period-edit" data-action="edit-period" data-id="${id}">${Util.escapeHtml(Util.t('btn.edit'))}</button>
    <button type="button" class="icon-btn period-del" data-action="delete-period" data-id="${id}" aria-label="${Util.escapeHtml(Util.t('aria.period_delete', { name: p.name }))}" title="${Util.escapeHtml(Util.t('btn.delete_period'))}">✕</button>
  </div>`;
}

function _stripHtml(periods: PlantPeriod[], todayKey: string): string {
  const strip = buildPeriodStrip(periods, todayKey, { fmtMonth: _fmtMonth });
  const ticks = strip.ticks.map(t =>
    `<span class="period-tick" style="left:${t.leftPct.toFixed(3)}%">${Util.escapeHtml(t.label)}</span>`).join('');
  const byId = new Map(periods.map(p => [p.id, p] as const));
  const segs = strip.segments.map(s => {
    const p = byId.get(s.id)!;
    const title = Util.escapeHtml(`${s.name} (${_range(p)})`);
    const cls = `period-seg period-seg-${s.status}${s.openEnded ? ' period-seg-open' : ''}`;
    return `<button type="button" class="${cls}" data-action="edit-period" data-id="${Util.escapeHtml(s.id)}" style="left:${s.leftPct.toFixed(3)}%;width:${s.widthPct.toFixed(3)}%" title="${title}"><span class="period-seg-label">${Util.escapeHtml(s.name)}</span></button>`;
  }).join('');
  const today = strip.today.leftPct.toFixed(3);
  return `<div class="period-strip">
    <div class="period-ticks" aria-hidden="true">${ticks}</div>
    <div class="period-track">
      ${segs}
      <div class="period-today" style="left:${today}%"></div>
    </div>
    <div class="period-today-row" aria-hidden="true"><span class="period-track-cap">${Util.escapeHtml(Util.t('ui.default_week_legend'))}</span><span class="period-today-tag" style="left:${today}%">${Util.escapeHtml(Util.t('ui.today'))}</span></div>
  </div>`;
}

function _setSaveBusy(busy: boolean) {
  const btn = document.getElementById('cal-edit-save-btn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = busy;
  if (busy) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy');
}

/** Name the other period a refused save collided with (the server returns every id involved). */
function _overlapText(plant: string, selfId: string, ids: string[] | undefined): string {
  const other = (ids ?? []).filter(i => i !== selfId)
    .map(i => Store.getPlantPeriods(plant).find(p => p.id === i)).find(Boolean);
  if (!other) return Util.t('err.period_invalid');
  return Util.t('err.period_overlap', { name: other.name, from: _fmtKey(other.validFrom), to: _fmtKey(other.validTo) });
}

export const CalendarPeriodsUI = {
  /** Wire the two delegated list/timeline listeners and the Add button, once. */
  init(): void {
    if (_inited) return;
    _inited = true;
    const onClick = (ev: Event) => {
      const el = (ev.target as HTMLElement | null)?.closest?.('[data-action]') as HTMLElement | null;
      const id = el?.dataset?.id;
      if (!el || !id) return;
      const action = el.dataset.action;
      if (action === 'edit-period') CalendarPeriodsUI.openModal(id);
      else if (action === 'delete-period') void CalendarPeriodsUI.remove(id);
    };
    document.getElementById('plant-periods-list')?.addEventListener('click', onClick);
    document.getElementById('plant-periods-timeline')?.addEventListener('click', onClick);
    document.getElementById('plant-add-period-btn')?.addEventListener('click', () => CalendarPeriodsUI.openModal());
  },

  render(): void {
    const list = document.getElementById('plant-periods-list');
    const timeline = document.getElementById('plant-periods-timeline');
    const countEl = document.getElementById('plant-periods-count');
    const addBtn = document.getElementById('plant-add-period-btn') as HTMLButtonElement | null;
    if (!list && !timeline) return;
    const plant = Store.selectedPlant;
    if (!plant) {
      const msg = `<p class="plant-no-sel">${Util.escapeHtml(Util.t('ui.select_plant_hours'))}</p>`;
      if (list) list.innerHTML = msg;
      if (timeline) timeline.innerHTML = msg;
      if (countEl) countEl.textContent = '';
      if (addBtn) addBtn.disabled = true;
      return;
    }
    if (addBtn) addBtn.disabled = false;
    const periods = _sorted(plant);
    const todayKey = _todayKey(plant);
    if (countEl) countEl.textContent = Util.t('ui.period_count', { count: periods.length });
    if (list) {
      const dayLabels = DAY_KEYS.map(k => Util.t(k));
      list.innerHTML = periods.length
        ? periods.map(p => _rowHtml(p, todayKey, dayLabels)).join('')
        : `<div class="empty-state">${Util.escapeHtml(Util.t('empty.no_periods'))}</div>`;
    }
    if (timeline) timeline.innerHTML = _stripHtml(periods, todayKey);
  },

  openModal(id?: string): void {
    const plant = Store.selectedPlant;
    if (!plant) return;
    EditCalendar.openPeriod(plant, id);
  },

  /** Persist `period` (insert or replace by id). Resolves true when the server (or What-If) accepted it.
   *  A refusal keeps the editor open and shows the reason inline. CalendarSync already toasts transport
   *  failures, so none is repeated here. */
  async save(period: PlantPeriod, plantArg?: string | null): Promise<boolean> {
    const plant = plantArg ?? Store.selectedPlant;
    if (!plant || _saving) return false;
    _saving = true;
    _setSaveBusy(true);
    try {
      const next = [...Store.getPlantPeriods(plant).filter(p => p.id !== period.id), period];
      const res = await CalendarSync.savePlantPeriods(plant, next);
      if (res.ok) {
        EditCalendar.close();
        Toast.show(Util.t(res.skipped ? 'toast.calendar_whatif_local' : 'toast.period_saved'), res.skipped ? 'info' : 'success');
        CalendarPeriodsUI.render();
        return true;
      }
      if (res.code === 'period_overlap') EditCalendar.setPeriodError('overlap', _overlapText(plant, period.id, res.ids));
      else if (res.code === 'period_dates_invalid') EditCalendar.setPeriodError('to', Util.t('err.period_to_before_from'));
      else if (res.code === 'period_invalid' || res.code === 'period_hours_invalid') EditCalendar.setPeriodError('overlap', Util.t('err.period_invalid'));
      return false;
    } finally {
      _saving = false;
      _setSaveBusy(false);
    }
  },

  async remove(id: string): Promise<boolean> {
    const plant = Store.selectedPlant;
    if (!plant) return false;
    const existing = Store.getPlantPeriods(plant);
    const p = existing.find(x => x.id === id);
    if (!p) return false;
    const confirmed = await Modal.confirm({
      title: Util.t('confirm.delete_period_title'),
      message: Util.t('confirm.delete_period', { name: p.name, from: _fmtKey(p.validFrom), to: _fmtKey(p.validTo) }),
      confirmLabel: Util.t('btn.delete_period'),
      tone: 'danger',
    });
    if (!confirmed) return false;
    const res = await CalendarSync.savePlantPeriods(plant, existing.filter(x => x.id !== id));
    if (res.ok) {
      Toast.show(Util.t(res.skipped ? 'toast.calendar_whatif_local' : 'toast.period_deleted'), res.skipped ? 'info' : 'success');
      CalendarPeriodsUI.render();
      return true;
    }
    // A structured refusal has no inline home here; transport failures were already toasted by CalendarSync.
    if (res.code) Toast.show(Util.t('toast.calendar_save_failed'), 'error');
    return false;
  },
};

// Keep the tab fresh when the Store changes under it (a What-If promote, a calendar refetch, a plant switch).
// Gated on the DOM so it costs nothing while another tab is showing; admin-ui is not imported (cycle).
Store.subscribe(evt => {
  if (evt.type !== 'calendar:change' && evt.type !== 'plant:selected') return;
  if (typeof document === 'undefined') return;
  if (document.getElementById('plant-tab-calendar')?.hidden === false) CalendarPeriodsUI.render();
}, 'CalendarPeriodsUI.sync');
