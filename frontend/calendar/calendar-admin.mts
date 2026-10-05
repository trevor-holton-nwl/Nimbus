// calendar/calendar-admin.mjs — plant/line blackout-block calendar UI.
// Extracted verbatim from plant-and-administration.mts (Phase P2 of
// docs/architecture/domain-refactor-plan.md, which split that 11,308-line
// mega-module into 9 domain files).
import { Config, Util, ErrorLog, Toast, Modal } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import { CalendarSync } from './calendar-sync.mjs';
import { getActiveTabResolvers } from '../shell/tab-resolvers.mjs';
import type { NimbusBlock } from '../platform/types.mjs';

/* =============================================================================
   CALENDAR UI — blackout-block-tab UI remnant.
   CQ-1 Phase 2 Task 1 moved the capacity-math half of the old `Calendar`
   object (workWindow, dailyCapacityHours, effectiveFromCapacity,
   effectiveCapacityHours, nextAvailable, and the private
   _beginRun/_endRun/_indexBlocks/_dayWindow/_indexCapacityBlocks/
   _overlapsBlock helpers) into schedule-services.mjs, where it is imported
   below as `Calendar` (see the bridge destructure at the top of this IIFE).
   Only the calendar tab's render/blackout-block UI stayed here, renamed
   from `Calendar` to `CalendarUI` (verbatim bodies) so the bare name
   `Calendar` is free for the imported capacity-math module.
   ========================================================================== */
export const CalendarUI = {
  _lineFilter: 'all',
  _blockFilter: 'all',
  _fpBlkStart: null as NimbusVendor.FlatpickrInstance | null,
  _fpBlkEnd: null as NimbusVendor.FlatpickrInstance | null,

  render(): void {
    const body = document.getElementById('cal-hours-body');
    if (!body) return;
    const lines = CalendarUI._getLines();
    lines.forEach(l => Store.ensureCalendar(l));

    const sel = CalendarUI._lineFilter || 'all';
    const shownLines = sel === 'all' ? lines : lines.filter(l => l === sel);

    const dayLabels = ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => Util.t(k));

    let html = `<div class="cal-filter-bar">
      <label class="cal-filter-label">${Util.t('ui.cal_filter_line')}</label>
      <select class="cal-filter-select" id="cal-line-select">
        <option value="all"${sel === 'all' ? ' selected' : ''}>${Util.t('ui.all_lines_count', {count: lines.length})}</option>
        ${lines.map(l => {
          const safeLine = Util.escapeHtml(l);
          return `<option value="${safeLine}"${sel === l ? ' selected' : ''}>${safeLine}</option>`;
        }).join('')}
      </select>
      ${sel !== 'all' ? `<button class="cal-filter-clear" onclick="NIMBUS.CalendarUI._clearLineFilter()">${Util.t('btn.show_all')}</button>` : ''}
    </div>`;

    html += `<div class="hours-tbl-wrap"><table class="hours-tbl">
      <thead><tr>
        <th class="col-head">${Util.t('ui.line_label')}</th>
        ${dayLabels.map(d => `<th class="col-head">${d}</th>`).join('')}
      </tr></thead>
      <tbody>`;

    shownLines.forEach((line) => {
      const li = lines.indexOf(line);
      const color = Config.COLORS[li % Config.COLORS.length];
      const cal = Store.calendars[line].workHours;
      html += `<tr>
        <td><div class="line-label"><span class="line-dot" style="background:${color}"></span>${Util.escapeHtml(line)}</div></td>`;
      for (let d = 0; d < 7; d++) {
        const wh = cal[d];
        const off = !wh;
        html += `<td><div class="hours-cell ${off ? 'off':''}" data-line="${Util.escapeHtml(line)}" data-day="${d}">
          <input type="text" class="hours-start" value="${off ? '' : Util.hoursToTimeString(wh![0])}">
          <span class="dash">–</span>
          <input type="text" class="hours-end" value="${off ? '' : Util.hoursToTimeString(wh![1])}">
        </div></td>`;
      }
      html += `</tr>`;
    });
    html += `</tbody></table></div>`;

    body.innerHTML = html;

    // Wire line selector
    const lineSelectEl = document.getElementById('cal-line-select') as HTMLSelectElement;
    lineSelectEl.onchange = () => {
      CalendarUI._lineFilter = lineSelectEl.value;
      CalendarUI.render();
    };

    // Wire up inputs
    body.querySelectorAll<HTMLElement>('.hours-cell').forEach(cell => {
      const line = cell.dataset.line!;
      const day  = +cell.dataset.day!;
      const inS  = cell.querySelector<HTMLInputElement>('.hours-start')!;
      const inE  = cell.querySelector<HTMLInputElement>('.hours-end')!;
      const upd = () => {
        const vs = inS.value, ve = inE.value;
        const cal = Store.calendars[line].workHours;
        if (!vs || !ve) { cal[day] = null; cell.classList.add('off'); }
        else {
          cal[day] = [Util.timeStringToHours(vs), Util.timeStringToHours(ve)];
          cell.classList.remove('off');
        }
        Store.emit({ type: 'calendar:change', line, source: 'calendar' });
        Toast.show(Util.t('toast.calendar_updated'), 'success');
      };
      flatpickr(inS, { enableTime: true, noCalendar: true, dateFormat: 'H:i', altInput: true, altFormat: 'h:i K', onChange: upd });
      flatpickr(inE, { enableTime: true, noCalendar: true, dateFormat: 'H:i', altInput: true, altFormat: 'h:i K', onChange: upd });
    });

    CalendarUI._renderBlocks();
  },

  _clearLineFilter(): void {
    CalendarUI._lineFilter = 'all';
    CalendarUI.render();
  },

  _renderBlocks(): void {
    const list = document.getElementById('cal-blocks-list');
    if (!list) return;
    const lines     = CalendarUI._getLines();
    const bFilter   = CalendarUI._blockFilter || 'all';
    const allBlocks = Store.blocks.slice().sort((a,b) => (Util.parseDate(a.start)?.getTime() || 0) - (Util.parseDate(b.start)?.getTime() || 0));
    const blocks    = bFilter === 'all' ? allBlocks : allBlocks.filter(b => !b.line || b.line === bFilter);

    let html = `<div class="cal-filter-bar">
      <label class="cal-filter-label">${Util.t('ui.filter_label')}</label>
      <select class="cal-filter-select" id="cal-block-filter">
        <option value="all"${bFilter === 'all' ? ' selected' : ''}>${Util.t('ui.all_lines_filter')}</option>
        ${lines.map(l => {
          const safeLine = Util.escapeHtml(l);
          return `<option value="${safeLine}"${bFilter === l ? ' selected' : ''}>${safeLine}</option>`;
        }).join('')}
      </select>
      <span class="cal-block-count">${Util.t('ui.blocks_count', {count: blocks.length, plural: blocks.length !== 1 ? 's' : ''})}</span>
    </div>`;

    if (!blocks.length) {
      html += `<div class="empty-state">${bFilter !== 'all' ? Util.t('empty.no_blocks_for_line') : Util.t('empty.no_blackouts_line')}</div>`;
    } else {
      html += blocks.map(b => `
        <div class="block-row" style="padding-left:6px;padding-right:6px;">
          <span class="ico">■</span>
          <span class="reason">${Util.escapeHtml(b.reason) || Util.t('ui.blackouts_label', {plural: ''})}</span>
          <span class="line-tag">${Util.escapeHtml(b.line) || Util.t('ui.all_lines_filter')}</span>
          <span class="range" title="${Util.fmtDTReadable(b.start)} → ${Util.fmtDTReadable(b.end)}">${Util.fmtBlockRange(b.start, b.end)}</span>
          <button class="btn btn-ghost sm" style="padding:2px 7px;font-size:14px;" title="${Util.t('tip.remove_block')}" data-block-id="${Util.escapeHtml(b.id)}">×</button>
        </div>
      `).join('');
    }

    list.innerHTML = html;

    // Wire block-filter select
    const blockSelect = document.getElementById('cal-block-filter') as HTMLSelectElement | null;
    if (blockSelect) blockSelect.onchange = () => {
      CalendarUI._blockFilter = blockSelect.value;
      CalendarUI._renderBlocks();
    };

    // Wire one delegated remove-block handler. Assignment replaces the prior
    // handler when the persistent list is re-rendered, so refreshes cannot
    // multiply persistence/toast side effects for a single click.
    list.onclick = (e: Event) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('button[data-block-id]') as HTMLButtonElement | null;
      if (btn) {
        const blockId = btn.dataset.blockId;
        if (blockId) CalendarUI.removeBlock(blockId);
      }
    };
  },

  removeBlock(id: string): void {
    const blk = Store.blocks.find(b => b.id === id);
    const plant = blk?.plant || Store.selectedPlant;
    Store.removeBlock(id, 'calendar');
    if (plant) CalendarSync.saveLineBlackoutDelete(plant, id);
    Toast.show(Util.t('toast.block_removed'), 'success');
  },

  openBlockModal(): void {
    const lineSel = document.getElementById('blk-line') as HTMLSelectElement | null;
    if (!lineSel) { ErrorLog.error('ui', 'required DOM element missing: blk-line'); return; }
    const reasonEl = document.getElementById('blk-reason') as HTMLInputElement | null;
    if (!reasonEl) { ErrorLog.error('ui', 'required DOM element missing: blk-reason'); return; }

    lineSel.innerHTML = `<option value="">${Util.t('ui.all_lines_filter')}</option>` +
      CalendarUI._getLines().map(l => {
        const safeLine = Util.escapeHtml(l);
        return `<option value="${safeLine}">${safeLine}</option>`;
      }).join('');

    const now = new Date(); now.setMinutes(0, 0, 0);
    const plus1 = new Date(now.getTime() + Config.MS_HOUR);
    if (!CalendarUI._fpBlkStart) {
      CalendarUI._fpBlkStart = Util.fpDatetime('#blk-start');
      CalendarUI._fpBlkEnd   = Util.fpDatetime('#blk-end');
    }
    CalendarUI._fpBlkStart!.setDate(now, false);
    CalendarUI._fpBlkEnd!.setDate(plus1, false);
    reasonEl.value = '';
    Modal.open('modal-block');
  },

  saveBlockFromModal(): void {
    const line   = (document.getElementById('blk-line') as HTMLSelectElement).value || null;
    const start  = Util.parseDate((document.getElementById('blk-start') as HTMLInputElement).value);
    const end    = Util.parseDate((document.getElementById('blk-end') as HTMLInputElement).value);
    const reason = (document.getElementById('blk-reason') as HTMLInputElement).value.trim() || Util.t('ui.blackouts_label', {plural: ''});
    if (!start || !end) { Toast.show(Util.t('toast.please_set_start_end'), 'error'); return; }
    if (end <= start)   { Toast.show(Util.t('toast.end_must_be_after_start'), 'error'); return; }
    // Stamp the block's plant so it persists/scopes per-plant (line:null = all
    // lines in this plant). Requires a plant context.
    const plant = (line ? Store.getPlantForLine(line) : null) || Store.selectedPlant;
    if (!plant) { Toast.show(Util.t('toast.select_plant_first'), 'warn'); return; }
    const before = Store.blocks.length;
    Store.addBlock({ line, plant, start, end, reason } as NimbusBlock, 'calendar');
    if (Store.blocks.length > before) CalendarSync.saveLineBlackoutUpsert(Store.blocks[Store.blocks.length - 1]);
    Modal.close('modal-block');
    Toast.show(Util.t('toast.block_added'), 'success');
  },

  _getLines(): string[] {
    if (Store.selectedPlant) return Store.linesForSelectedPlant();
    // No plant selected yet (e.g. blackout modal opened before plant pick) —
    // fall back to the unscoped view rather than showing nothing.
    const set = new Set<string>();
    Store.tasksArr.forEach(t => set.add(t.MACHINE || 'Unknown'));
    Object.keys(Store.calendars).forEach(l => set.add(l));
    return [...set].sort();
  },
};

// Wholesale calendar replacement is used by What-If discard and backend
// hydration. Keep the visible calendar pane in sync with those state changes,
// but avoid rendering hidden panes (and avoid doing work before the shell has
// wired its active-tab resolver).
Store.subscribe(evt => {
  if (evt.type !== 'calendar:change' && evt.type !== 'blocks:change' && evt.type !== 'plantBlocks:change') return;
  const tabs = getActiveTabResolvers();
  if (tabs.currentTab() !== 'masterdata' || tabs.currentMasterSub() !== 'plant') return;
  if (typeof document !== 'undefined' && document.getElementById('cal-hours-body')) CalendarUI.render();
}, 'CalendarUI.sync');
