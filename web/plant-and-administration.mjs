// plant-and-administration.mjs — CQ-1 plant-and-administration module.
// Owns Plant, production lines, labor planning, Master Data, Bill of
// Materials, SAP Interface, Security, Admin Cockpit, color-wheel
// administration, and plant/line calendar management. Owns no planner
// timeline or application-wide navigation — see application-shell.mjs.
//
// CQ-1 Phase 4 Task 1 moved CalendarUI, Plant, and ProdLines here verbatim
// from app.js, plus Plant._renderSettingsPane (relocated bodily from App —
// see the comment on that method below). MasterData/LaborPlanning (Task 2)
// and Interface/Security/AdminCockpit (Task 3) have not moved yet as of this
// commit — Plant's/ProdLines' bare `MasterData.syncLineSettings(...)` calls
// are therefore genuine forward references into app.js-resident code that
// hasn't moved into this file yet, rewritten through the shared `NIMBUS`
// binding (`NIMBUS.MasterData.syncLineSettings(...)`), the same idiom
// Phase 3 used for Timeline's/Table's/Dashboard's/Interaction's forward
// references into not-yet-moved modules. Once Task 2 lands `MasterData` in
// this same file, those become ordinary same-module references — no further
// change is needed here when that happens.
/* global NIMBUS */
import { Config, Util, ErrorLog, Toast, Modal } from './application-foundation.mjs';
import { Store } from './schedule-state.mjs';
import { Engine } from './schedule-services.mjs';
import { CalendarSync, Session } from './schedule-data.mjs';
import { AlertsUIAdapter } from './schedule-workbench.mjs';

// Injected getter seam so Plant/LaborPlanning can ask "am I currently the
// visible tab/sub-tab?" without a bare reference to `App` (which lives in
// application-shell.mjs, not this file — see this phase's plan's Architecture
// section, seam #2). Wired once from app.js boot glue immediately after the
// Task 1 bridge destructure. Defaults are no-ops so a call before wiring
// (e.g. in a unit test that imports this module directly) never throws.
let _activeTabResolvers = { currentTab: () => null, currentMasterSub: () => null, laborSub: () => null };

export function setActiveTabResolvers(resolvers) {
  _activeTabResolvers = { ..._activeTabResolvers, ...resolvers };
}

/* =============================================================================
   CALENDAR UI — blackout-block-tab UI remnant.
   CQ-1 Phase 2 Task 1 moved the capacity-math half of the old `Calendar`
   object (workWindow, dailyCapacityHours, effectiveFromCapacity,
   effectiveCapacityHours, isAvailable, nextAvailable, and the private
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

  render() {
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
        ${lines.map(l => `<option value="${l}"${sel === l ? ' selected' : ''}>${l}</option>`).join('')}
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
        <td><div class="line-label"><span class="line-dot" style="background:${color}"></span>${line}</div></td>`;
      for (let d = 0; d < 7; d++) {
        const wh = cal[d];
        const off = !wh;
        html += `<td><div class="hours-cell ${off ? 'off':''}" data-line="${line}" data-day="${d}">
          <input type="text" class="hours-start" value="${off ? '' : Util.hoursToTimeString(wh[0])}">
          <span class="dash">–</span>
          <input type="text" class="hours-end" value="${off ? '' : Util.hoursToTimeString(wh[1])}">
        </div></td>`;
      }
      html += `</tr>`;
    });
    html += `</tbody></table></div>`;

    body.innerHTML = html;

    // Wire line selector
    document.getElementById('cal-line-select').onchange = function() {
      CalendarUI._lineFilter = this.value;
      CalendarUI.render();
    };

    // Wire up inputs
    body.querySelectorAll('.hours-cell').forEach(cell => {
      const line = cell.dataset.line;
      const day  = +cell.dataset.day;
      const inS  = cell.querySelector('.hours-start');
      const inE  = cell.querySelector('.hours-end');
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

  _clearLineFilter() {
    CalendarUI._lineFilter = 'all';
    CalendarUI.render();
  },

  _renderBlocks() {
    const list = document.getElementById('cal-blocks-list');
    if (!list) return;
    const lines     = CalendarUI._getLines();
    const bFilter   = CalendarUI._blockFilter || 'all';
    const allBlocks = Store.blocks.slice().sort((a,b) => Util.parseDate(a.start) - Util.parseDate(b.start));
    const blocks    = bFilter === 'all' ? allBlocks : allBlocks.filter(b => !b.line || b.line === bFilter);

    let html = `<div class="cal-filter-bar">
      <label class="cal-filter-label">${Util.t('ui.filter_label')}</label>
      <select class="cal-filter-select" id="cal-block-filter">
        <option value="all"${bFilter === 'all' ? ' selected' : ''}>${Util.t('ui.all_lines_filter')}</option>
        ${lines.map(l => `<option value="${l}"${bFilter === l ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
      <span class="cal-block-count">${Util.t('ui.blocks_count', {count: blocks.length, plural: blocks.length !== 1 ? 's' : ''})}</span>
    </div>`;

    if (!blocks.length) {
      html += `<div class="empty-state">${bFilter !== 'all' ? Util.t('empty.no_blocks_for_line') : Util.t('empty.no_blackouts_line')}</div>`;
    } else {
      html += blocks.map(b => `
        <div class="block-row" style="padding-left:6px;padding-right:6px;">
          <span class="ico">■</span>
          <span class="reason">${b.reason || Util.t('ui.blackouts_label', {plural: ''})}</span>
          <span class="line-tag">${b.line || Util.t('ui.all_lines_filter')}</span>
          <span class="range" title="${Util.fmtDTReadable(b.start)} → ${Util.fmtDTReadable(b.end)}">${Util.fmtBlockRange(b.start, b.end)}</span>
          <button class="btn btn-ghost sm" style="padding:2px 7px;font-size:14px;" title="${Util.t('tip.remove_block')}" onclick="NIMBUS.CalendarUI.removeBlock('${b.id}')">×</button>
        </div>
      `).join('');
    }

    list.innerHTML = html;

    const blockSelect = document.getElementById('cal-block-filter');
    if (blockSelect) blockSelect.onchange = function() {
      CalendarUI._blockFilter = this.value;
      CalendarUI._renderBlocks();
    };
  },

  removeBlock(id) {
    const blk = Store.blocks.find(b => b.id === id);
    const plant = blk?.plant || Store.selectedPlant;
    Store.removeBlock(id, 'calendar');
    if (plant) CalendarSync.saveLineBlackoutDelete(plant, id);
    Toast.show(Util.t('toast.block_removed'), 'success');
  },

  openBlockModal() {
    const lineSel = document.getElementById('blk-line');
    if (!lineSel) { ErrorLog.error('ui', 'required DOM element missing: blk-line'); return; }
    const reasonEl = document.getElementById('blk-reason');
    if (!reasonEl) { ErrorLog.error('ui', 'required DOM element missing: blk-reason'); return; }

    lineSel.innerHTML = `<option value="">${Util.t('ui.all_lines_filter')}</option>` +
      CalendarUI._getLines().map(l => `<option value="${l}">${l}</option>`).join('');

    const now = new Date(); now.setMinutes(0, 0, 0);
    const plus1 = new Date(now.getTime() + Config.MS_HOUR);
    if (!CalendarUI._fpBlkStart) {
      CalendarUI._fpBlkStart = Util.fpDatetime('#blk-start');
      CalendarUI._fpBlkEnd   = Util.fpDatetime('#blk-end');
    }
    CalendarUI._fpBlkStart.setDate(now, false);
    CalendarUI._fpBlkEnd.setDate(plus1, false);
    reasonEl.value = '';
    Modal.open('modal-block');
  },

  saveBlockFromModal() {
    const line   = document.getElementById('blk-line').value || null;
    const start  = Util.parseDate(document.getElementById('blk-start').value);
    const end    = Util.parseDate(document.getElementById('blk-end').value);
    const reason = document.getElementById('blk-reason').value.trim() || Util.t('ui.blackouts_label', {plural: ''});
    if (!start || !end) { Toast.show(Util.t('toast.please_set_start_end'), 'error'); return; }
    if (end <= start)   { Toast.show(Util.t('toast.end_must_be_after_start'), 'error'); return; }
    // Stamp the block's plant so it persists/scopes per-plant (line:null = all
    // lines in this plant). Requires a plant context.
    const plant = (line ? Store.getPlantForLine(line) : null) || Store.selectedPlant;
    if (!plant) { Toast.show(Util.t('toast.select_plant_first'), 'warn'); return; }
    const before = Store.blocks.length;
    Store.addBlock({ line, plant, start, end, reason }, 'calendar');
    if (Store.blocks.length > before) CalendarSync.saveLineBlackoutUpsert(Store.blocks[Store.blocks.length - 1]);
    Modal.close('modal-block');
    Toast.show(Util.t('toast.block_added'), 'success');
  },

  _getLines() {
    if (Store.selectedPlant) return Store.linesForSelectedPlant();
    // No plant selected yet (e.g. blackout modal opened before plant pick) —
    // fall back to the unscoped view rather than showing nothing.
    const set = new Set();
    Store.tasksArr.forEach(t => set.add(t.PRODUCTION_LINE || 'Unknown'));
    Object.keys(Store.calendars).forEach(l => set.add(l));
    return [...set].sort();
  },
};

/* =============================================================================
   PLANT — plant-level calendar UI (working hours, blackouts, lines roster).
   ========================================================================== */
export const Plant = {
  _blocksCollapsed: true,
  _rosterCollapsed: true,
  _cwMeta: {},           // cached color wheel metadata: { [plant]: {filename, row_count, uploaded_at} }
  _cwLoading: false,     // prevent concurrent fetches
  _currentPlantTab: 'general',

  init() {
    Store.subscribe(evt => {
      if (evt.type === 'plant:selected') {
        const onPlantSub = _activeTabResolvers.currentTab() === 'masterdata'
          && _activeTabResolvers.currentMasterSub() === 'plant';
        if (onPlantSub) {
          Plant.render();
        }
        // Update plant badge in header whenever selection changes
        const badge = document.querySelector('#md-master-plant-pane .plant-badge');
        if (badge) badge.textContent = Store.selectedPlant || '—';
      }
    }, 'Plant');
    Plant._wireStaticHandlers();
  },

  // Converts the static index.html onclick= attributes owned by CalendarUI/
  // Plant/ProdLines to real listeners (CQ-1 Phase 4 Task 1, following the
  // Phase 3 `Interaction._showMultiInspector` precedent). Called once from
  // init() — these are all always-present static elements (tab strip, "+ Add"
  // buttons, modal Save buttons), not re-rendered via innerHTML, so a single
  // boot-time wiring is sufficient. CalendarUI and ProdLines have no init()
  // of their own (ProdLines renders on-demand; CalendarUI's Interfaces list
  // has no init at all), so Plant's is the single boot-time entry point for
  // this whole family's static markup. The modals' "Cancel" buttons
  // (`NIMBUS.Modal.close(...)`) are out of this task's scope — `Modal` is not
  // a module this task moves — and stay as inline onclick attributes.
  _wireStaticHandlers() {
    document.querySelectorAll('.plant-inner-tabs .sub-subtab[data-plant-tab]').forEach(btn => {
      btn.addEventListener('click', () => Plant.gotoTab(btn.dataset.plantTab));
    });
    document.getElementById('plant-add-block-btn')?.addEventListener('click', () => Plant.openBlockModal());
    document.getElementById('plant-roster-toggle')?.addEventListener('click', () => Plant.toggleRosterList());
    document.getElementById('modal-block-save-btn')?.addEventListener('click', () => CalendarUI.saveBlockFromModal());
    document.getElementById('modal-plant-block-save-btn')?.addEventListener('click', () => Plant.savePlantBlockFromModal());
    document.getElementById('modal-lines-block-save-btn')?.addEventListener('click', () => ProdLines.saveBlockFromModal());
  },

  render() {
    const plantName = Store.selectedPlant;
    const badge = document.querySelector('#md-master-plant-pane .plant-badge');
    if (badge) badge.textContent = plantName || '—';
    Plant.gotoTab(Plant._currentPlantTab || 'general');
    Plant._renderHours();
    Plant._renderBlocks();
    Plant._renderRoster();
  },

  gotoTab(tab) {
    if (!['general', 'optimization', 'settings'].includes(tab)) return;
    Plant._currentPlantTab = tab;
    document.querySelectorAll('.plant-inner-tabs .sub-subtab').forEach(b => {
      b.classList.toggle('active', b.dataset.plantTab === tab);
    });
    ['general', 'optimization', 'settings'].forEach(t => {
      const el = document.getElementById(`plant-tab-${t}`);
      if (el) el.hidden = (t !== tab);
    });
    if (tab === 'settings') Plant._renderSettingsPane();
    else if (tab === 'optimization') Plant._fetchAndRenderOptimization(Store.selectedPlant);
  },

  toggleBlocksList() {
    Plant._blocksCollapsed = !Plant._blocksCollapsed;
    const list = document.getElementById('plant-blocks-list');
    const btn  = document.getElementById('plant-blk-toggle');
    if (list) list.style.display = Plant._blocksCollapsed ? 'none' : '';
    if (btn)  btn.textContent = Plant._blocksCollapsed ? '▼' : '▲';
  },

  toggleRosterList() {
    Plant._rosterCollapsed = !Plant._rosterCollapsed;
    const wrap = document.getElementById('plant-roster-wrap');
    const btn  = document.getElementById('plant-roster-toggle');
    if (wrap) wrap.style.display = Plant._rosterCollapsed ? 'none' : '';
    if (btn)  btn.textContent = Plant._rosterCollapsed ? '▼' : '▲';
  },

  _renderHours() {
    const body = document.getElementById('plant-hours-body');
    if (!body) return;
    const plantName = Store.selectedPlant;
    if (!plantName) { body.innerHTML = `<p class="plant-no-sel">${Util.t('ui.select_plant_hours')}</p>`; return; }
    Store.ensurePlant(plantName);
    const plant = Store.plants[plantName];

    if (Plant._pillFps) {
      Plant._pillFps.forEach(p => { p.start?.destroy(); p.end?.destroy(); });
    }
    Plant._pillFps = Array(7).fill(null).map(() => ({ start: null, end: null }));
    const dayLabels = ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => Util.t(k));

    const pillsHtml = [0,1,2,3,4,5,6].map(d => {
      const wh = plant.workHours[d];
      const time = wh ? `${ProdLines._fmtHour(wh[0])}–${ProdLines._fmtHour(wh[1])}` : Util.t('ui.off');
      const hrs = wh ? (() => { const h = wh[1] - wh[0]; return h % 1 === 0 ? `${h}h` : `${h.toFixed(1)}h`; })() : '—';
      return `<div class="line-hours-pill ${wh ? 'on' : 'off'}" data-day="${d}"
        onclick="NIMBUS.Plant._pillClick(${d})"
        oncontextmenu="NIMBUS.Plant._pillRightClick(${d}, event)">
        <span class="lhp-day">${dayLabels[d]}</span>
        <span class="lhp-time">${time}</span>
        <span class="lhp-hrs">${hrs}</span>
        <input id="plant-pill-start-${d}" class="phwi-anchor" readonly>
        <input id="plant-pill-end-${d}"   class="phwi-anchor" readonly>
      </div>`;
    }).join('');

    body.innerHTML = `<div class="line-hours-pills">${pillsHtml}</div>`;

    requestAnimationFrame(() => {
      const p = Store.plants[Store.selectedPlant];
      for (let d = 0; d < 7; d++) {
        const wh = p.workHours[d];
        const onClose = () => Plant._pillSave(d);
        Plant._pillFps[d].start = flatpickr(`#plant-pill-start-${d}`, {
          enableTime: true, noCalendar: true, dateFormat: 'H:i',
          minuteIncrement: 30,
          defaultDate: wh ? Util.hoursToTimeString(wh[0]) : '08:00',
          onClose,
        });
        Plant._pillFps[d].end = flatpickr(`#plant-pill-end-${d}`, {
          enableTime: true, noCalendar: true, dateFormat: 'H:i',
          minuteIncrement: 30,
          defaultDate: wh ? Util.hoursToTimeString(wh[1]) : '17:00',
          onClose,
        });
      }
    });
  },

  _pillClick(d) {
    const pName = Store.selectedPlant;
    if (!pName) return;
    const plant = Store.plants[pName];
    const wh = plant.workHours[d];
    if (!wh) {
      Store.setPlantWorkHours(pName, d, [8, 17], 'pill');
      const changed = new Set();
      for (let i = 0; i < 7; i++) for (const l of Store.clampLinesToPlant(pName, i)) changed.add(l);
      Plant._persistPlantHours(pName, changed);
      Plant._renderHours();
      Toast.show(Util.t('day.sun_enabled', { day: ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => Util.t(k))[d] }), 'success');
      return;
    }
    const pill = document.querySelector(`.line-hours-pill[data-day="${d}"]`);
    if (pill) pill.classList.add('editing');
    Plant._pillFps[d]?.start?.open();
  },

  _pillSave(d) {
    const pName = Store.selectedPlant;
    if (!pName) return;
    const pair = Plant._pillFps[d];
    if (!pair?.start || !pair?.end) return;
    const sv = pair.start.element.value;
    const ev = pair.end.element.value;
    if (!sv || !ev) {
      Store.setPlantWorkHours(pName, d, null, 'pill');
    } else {
      const sh = Util.timeStringToHours(sv), eh = Util.timeStringToHours(ev);
      if (eh <= sh) { Toast.show(Util.t('toast.end_must_be_after_start'), 'error'); return; }
      Store.setPlantWorkHours(pName, d, [sh, eh], 'pill');
    }
    const changed = new Set();
    for (let i = 0; i < 7; i++) for (const l of Store.clampLinesToPlant(pName, i)) changed.add(l);
    Plant._persistPlantHours(pName, changed);
    Plant._renderHours();
    Toast.show(Util.t('toast.plant_hours_updated'), 'success');
  },

  /** Persist a plant's working hours + only the line hours the clamp actually rewrote
   *  (changedLines, a Set/array). Narrowing to changed lines means a concurrent
   *  single-line edit that still fits the new plant window is NOT re-POSTed and so not
   *  clobbered by the plant-hours batch. (F9) Per-line saves are batched into one
   *  /line-hours POST by CalendarSync. Falls back to all in-plant lines if no set given. */
  _persistPlantHours(pName, changedLines) {
    if (!pName) return;
    CalendarSync.savePlantHours(pName, Store.plants[pName]?.workHours);
    const lines = changedLines
      ? [...changedLines].filter(l => Store.calendars[l] && Store.getPlantForLine(l) === pName)
      : Object.keys(Store.calendars).filter(l => Store.getPlantForLine(l) === pName);
    for (const line of lines) {
      CalendarSync.saveLineHours(pName, line, Store.calendars[line].workHours);
    }
  },

  _pillRightClick(d, e) {
    e.preventDefault();
    document.querySelector('.pill-ctx-menu')?.remove();

    const pName = Store.selectedPlant;
    if (!pName) return;
    const plant = Store.plants[pName];
    const wh = plant?.workHours[d];
    const dayName = ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => Util.t(k))[d];

    const menu = document.createElement('div');
    menu.className = 'pill-ctx-menu';
    menu.innerHTML = wh
      ? `<button data-action="off">${Util.t('day.set_off', { day: dayName })}</button>`
      : `<button data-action="on">${Util.t('day.reset_on', { day: dayName })}</button>`;

    menu.querySelector('button').onclick = () => {
      const _pName = Store.selectedPlant;
      menu.remove();
      if (wh) {
        Store.setPlantWorkHours(_pName, d, null, 'pill');
        Toast.show(Util.t('day.set_to_off', { day: dayName }), 'success');
      } else {
        Store.setPlantWorkHours(_pName, d, [8, 17], 'pill');
        Toast.show(Util.t('day.sun_enabled', { day: dayName }), 'success');
      }
      const changed = new Set();
      for (let i = 0; i < 7; i++) for (const l of Store.clampLinesToPlant(_pName, i)) changed.add(l);
      Plant._persistPlantHours(_pName, changed);
      Plant._renderHours();
    };

    menu.style.left = e.clientX + 'px';
    menu.style.top  = e.clientY + 'px';
    document.body.appendChild(menu);

    requestAnimationFrame(() => {
      const r = menu.getBoundingClientRect();
      if (r.right  > window.innerWidth)  menu.style.left = (window.innerWidth  - r.width  - 6) + 'px';
      if (r.bottom > window.innerHeight) menu.style.top  = (window.innerHeight - r.height - 6) + 'px';
    });

    const dismiss = ev => {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', dismiss); }
    };
    const dismissKey = ev => {
      if (ev.key === 'Escape') { menu.remove(); document.removeEventListener('keydown', dismissKey); }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', dismiss);
      document.addEventListener('keydown', dismissKey);
    }, 0);
  },

  _renderBlocks() {
    const list    = document.getElementById('plant-blocks-list');
    const statsEl = document.getElementById('plant-blocks-stats');
    if (!list) return;

    const blocks = (Store.plantBlocks || []).slice()
      .sort((a, b) => Util.parseDate(a.start) - Util.parseDate(b.start));

    if (statsEl) {
      if (blocks.length) {
        const totalDays = blocks.reduce((acc, b) =>
          acc + Math.ceil((Util.parseDate(b.end) - Util.parseDate(b.start)) / Config.MS_DAY), 0);
        const chevron = Plant._blocksCollapsed ? '▼' : '▲';
        statsEl.innerHTML = `<div class="plant-blk-stats" style="display:flex;align-items:center;justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:16px;">
            <div class="plant-blk-stat" style="padding:0 4px;">
              <span class="pbs-val">${blocks.length}</span>
              <span class="pbs-lbl">${Util.t('ui.blackouts_label', {plural: blocks.length !== 1 ? 's' : ''})}</span>
            </div>
            <div class="plant-blk-stats-sep"></div>
            <div class="plant-blk-stat" style="padding:0 4px;">
              <span class="pbs-val">${totalDays}</span>
              <span class="pbs-lbl">${Util.t('ui.days_blocked', {plural: totalDays !== 1 ? 's' : ''})}</span>
            </div>
          </div>
          <button id="plant-blk-toggle" class="btn btn-ghost sm" onclick="NIMBUS.Plant.toggleBlocksList()" title="${Util.t('ui.toggle_list')}" style="font-size:11px;padding:2px 8px;min-width:28px;">${chevron}</button>
        </div>`;
      } else {
        statsEl.innerHTML = '';
      }
    }

    if (!blocks.length) {
      list.innerHTML = `<div class="empty-state">${Util.t('empty.no_plant_blackouts')}</div>`;
      return;
    }

    list.innerHTML = blocks.map(b => `
      <div class="block-row" style="padding-left:6px;padding-right:6px;">
        <span class="ico">■</span>
        <span class="reason">${b.reason || Util.t('ui.blackouts_label', {plural: ''})}</span>
        <span class="range" title="${Util.fmtDTReadable(b.start)} → ${Util.fmtDTReadable(b.end)}">${Util.fmtBlockRange(b.start, b.end)}</span>
        <button class="btn btn-ghost sm" style="padding:2px 7px;font-size:14px;" title="${Util.t('tip.remove_block')}" onclick="NIMBUS.Plant.removePlantBlock('${b.id}')">×</button>
      </div>
    `).join('');
    list.style.display = Plant._blocksCollapsed ? 'none' : '';
  },

  _renderRoster() {
    const roster = document.getElementById('plant-lines-roster');
    if (!roster) return;
    const lines = Store.linesForSelectedPlant();
    const countEl = document.getElementById('plant-lines-count');
    if (countEl) countEl.textContent = Util.t('ui.lines_count', {count: lines.length, plural: lines.length !== 1 ? 's' : ''});

    if (!lines.length) {
      roster.innerHTML = `<div class="empty-state">${Util.t('empty.no_production_lines')}</div>`;
      return;
    }

    const thStyle = 'padding:8px 12px;font-size:12px;font-weight:600;position:sticky;top:0;z-index:2;background:var(--surface,#fff);border-bottom:1px solid var(--border,#e2e8f0);';
    const thStyleBlank = 'padding:8px 12px;position:sticky;top:0;z-index:2;background:var(--surface,#fff);border-bottom:1px solid var(--border,#e2e8f0);';
    const dayLabels = ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => Util.t(k));

    roster.innerHTML = `<table style="width:100%;border-collapse:collapse;">
      <thead><tr style="text-align:left;">
        <th style="${thStyle}">${Util.t('ui.line_label')}</th>
        <th style="${thStyle}">${Util.t('ui.roster_important_flags')}</th>
        <th style="${thStyle}">${Util.t('ui.roster_schedule')}</th>
        <th style="${thStyle}">Production Line Group</th>
        <th style="${thStyleBlank}"></th>
      </tr></thead>
      <tbody>
        ${lines.map((line, li) => {
          const color = Config.COLORS[li % Config.COLORS.length];
          const ls = Store.lineSettings[line] || {};
          const botBadge = ls.bottleneck
            ? `<span style="background:#f59e0b;color:#fff;font-size:11px;padding:2px 6px;border-radius:4px;">${Util.t('ui.bottleneck')}</span>`
            : '';
          const exclBadge = ls.excludeFromOpt
            ? `<span style="background:#6366f1;color:#fff;font-size:11px;padding:2px 6px;border-radius:4px;">${Util.t('ui.excl_optimizer')}</span>`
            : '';
          const cal = Store.calendars[line]?.workHours || {};
          const schedCells = [0,1,2,3,4,5,6].map(d => {
            const wh = cal[d];
            const timeStr = wh ? `${ProdLines._fmtHour(wh[0])}–${ProdLines._fmtHour(wh[1])}` : Util.t('ui.off');
            const timeColor = wh ? '#1e293b' : '#ef4444';
            return `<div style="text-align:center;font-size:11px;line-height:1.4;min-width:56px;">
              <div style="font-weight:600;color:#64748b;">${dayLabels[d]}</div>
              <div style="color:${timeColor};">${timeStr}</div>
            </div>`;
          }).join('');
          const safeId = line.replace(/'/g, "\\'");
          const plgVal = (ls.plGroup || '').replace(/"/g, '&quot;');
          return `<tr style="border-bottom:1px solid var(--border,#f1f5f9);">
            <td style="padding:8px 12px;"><div class="line-label"><span class="line-dot" style="background:${color}"></span>${line}</div></td>
            <td style="padding:8px 12px;">${botBadge}${exclBadge ? ' ' + exclBadge : ''}</td>
            <td style="padding:8px 12px;">
              <div style="display:flex;gap:6px;align-items:flex-start;">${schedCells}</div>
            </td>
            <td style="padding:8px 12px;">
              <input type="text" class="input roster-plgroup-input" style="width:120px;font-size:12px;" value="${plgVal}" data-line="${line}" placeholder="—">
            </td>
            <td style="padding:8px 12px;text-align:right;">
              <button class="btn btn-ghost sm" onclick="NIMBUS.App.goto('masterdata'); NIMBUS.App.gotoMasterSub('lines'); setTimeout(()=>{const el=document.getElementById('line-row-${safeId}');if(el)el.scrollIntoView({behavior:'smooth',block:'center'});},80);">Edit →</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;

    roster.querySelectorAll('.roster-plgroup-input').forEach(inp => {
      inp.onchange = function() {
        const val = this.value.trim();
        Store.setLineSetting(this.dataset.line, { plGroup: val }, 'plant-roster');
        NIMBUS.MasterData.syncLineSettings(this.dataset.line, { plGroup: val });
        Toast.show(Util.t('toast.line_settings_updated'), 'success');
      };
    });

    const wrap = document.getElementById('plant-roster-wrap');
    const btn  = document.getElementById('plant-roster-toggle');
    if (wrap) wrap.style.display = Plant._rosterCollapsed ? 'none' : '';
    if (btn)  btn.textContent = Plant._rosterCollapsed ? '▼' : '▲';
  },

  openBlockModal() {
    const reasonEl = document.getElementById('plant-blk-reason');
    if (!reasonEl) { ErrorLog.error('ui', 'required DOM element missing: plant-blk-reason'); return; }

    const now = new Date(); now.setMinutes(0, 0, 0);
    const plus1 = new Date(now.getTime() + Config.MS_HOUR);
    if (!Plant._fpBlkStart) {
      Plant._fpBlkStart = Util.fpDatetime('#plant-blk-start');
      Plant._fpBlkEnd   = Util.fpDatetime('#plant-blk-end');
    }
    Plant._fpBlkStart.setDate(now, false);
    Plant._fpBlkEnd.setDate(plus1, false);
    reasonEl.value = '';
    Modal.open('modal-plant-block');
  },

  savePlantBlockFromModal() {
    const startEl = document.getElementById('plant-blk-start');
    const endEl = document.getElementById('plant-blk-end');
    const reasonEl = document.getElementById('plant-blk-reason');
    if (!startEl || !endEl || !reasonEl) { ErrorLog.error('ui', 'required DOM elements missing for plant blackout modal'); return; }

    const start  = Util.parseDate(startEl.value);
    const end    = Util.parseDate(endEl.value);
    const reason = reasonEl.value.trim() || Util.t('ui.plant_blackout_default');
    if (!start || !end) { Toast.show(Util.t('toast.please_set_start_end'), 'error'); return; }
    if (end <= start)   { Toast.show(Util.t('toast.end_must_be_after_start'), 'error'); return; }
    if (!Store.selectedPlant) { Toast.show(Util.t('toast.select_plant_first'), 'warn'); return; }
    const before = Store.plantBlocks.length;
    Store.addPlantBlock({ plant: Store.selectedPlant, start, end, reason }, 'plant');
    if (Store.plantBlocks.length > before) CalendarSync.savePlantBlackoutUpsert(Store.plantBlocks[Store.plantBlocks.length - 1]);
    Modal.close('modal-plant-block');
    Toast.show(Util.t('toast.plant_blackout_added'), 'success');
  },

  removePlantBlock(id) {
    const blk = Store.plantBlocks.find(b => b.id === id);
    const plant = blk?.plant || Store.selectedPlant;
    Store.removePlantBlock(id, 'plant');
    if (plant) CalendarSync.savePlantBlackoutDelete(plant, id);
    Toast.show(Util.t('toast.plant_blackout_removed'), 'success');
  },

  /* ── Optimization Options section ── */

  _fetchAndRenderOptimization(plantName) {
    const panel = document.getElementById('plant-opt-panel');
    if (!panel) return;
    // Show spinner while fetching metadata
    const body = panel.querySelector('.panel-body');
    if (body) body.innerHTML = `<div class="cw-loading"><span class="cw-spin"></span>${Util.t('ui.loading')}</div>`;

    fetch(`${Config.API_BASE}/color-wheels`, { signal: AbortSignal.timeout(6000) })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        Plant._cwMeta = data.plants || {};
        Plant._renderOptimization(plantName);
      })
      .catch(() => {
        Plant._cwMeta = {};
        Plant._renderOptimization(plantName);
      });
  },

  _renderOptimization(plantName) {
    const body = document.getElementById('plant-opt-body');
    if (!body) return;
    const wheelInfo = Plant._cwMeta[plantName];
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

    const _relTime = ts => {
      if (!ts) return 'unknown';
      const diff = Math.round((Date.now() - new Date(ts)) / 1000);
      if (diff < 120)   return 'just now';
      if (diff < 3600)  return `${Math.floor(diff/60)}m ago`;
      if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
      return `${Math.floor(diff/86400)}d ago`;
    };

    let html;
    if (wheelInfo) {
      html = `
        <div class="cw-active-card">
          <div class="cw-active-icon">🎨</div>
          <div class="cw-active-info">
            <div class="cw-active-name">${esc(wheelInfo.filename || '—')}</div>
            <div class="cw-active-meta">${wheelInfo.row_count ?? '?'} colors &middot; uploaded ${_relTime(wheelInfo.uploaded_at)} by ${esc(wheelInfo.uploaded_by || 'system')}</div>
          </div>
          <div class="cw-active-actions">
            <button class="btn btn-ghost sm" onclick="NIMBUS.ColorWheelViewer.open('${esc(plantName)}')">👁 Preview</button>
            <button class="btn btn-ghost sm cw-delete-btn" onclick="NIMBUS.Plant._confirmDeleteWheel('${esc(plantName)}')">⌫ Remove</button>
          </div>
        </div>
        <div class="cw-dropzone cw-replace-zone" id="plant-cw-dropzone" title="Drop to replace or click to browse">
          <div class="cw-drop-inner">
            <span class="cw-drop-icon">↻</span>
            <span class="cw-drop-text">Drop new file to replace, or click to browse</span>
            <input type="file" id="plant-cw-file" accept=".xlsx,.xls" style="display:none">
          </div>
        </div>`;
    } else {
      html = `
        <div class="cw-empty-hint">
          No color wheel uploaded yet. Optimization will still run using the global fallback wheel, skipping color-priority ordering if that is also absent.
        </div>
        <div class="cw-dropzone" id="plant-cw-dropzone">
          <div class="cw-drop-inner">
            <span class="cw-drop-icon">📂</span>
            <span class="cw-drop-text">Drag a color wheel here, or click to browse</span>
            <div class="cw-drop-hint">.xlsx · must contain COLOR and ORDER_Y columns</div>
            <input type="file" id="plant-cw-file" accept=".xlsx,.xls" style="display:none">
          </div>
        </div>`;
    }

    html += `<div id="plant-cw-status" class="admin-status" style="margin-top:10px;"></div>`;
    body.innerHTML = html;

    // Wire drag-drop + click
    const zone = document.getElementById('plant-cw-dropzone');
    const fileInput = document.getElementById('plant-cw-file');
    if (zone && fileInput) {
      zone.onclick = e => { if (e.target !== fileInput) fileInput.click(); };
      fileInput.onchange = () => { if (fileInput.files[0]) Plant._uploadWheel(plantName, fileInput.files[0]); };
      zone.ondragover  = e => { e.preventDefault(); zone.classList.add('drag-over'); };
      zone.ondragleave = () => zone.classList.remove('drag-over');
      zone.ondrop = e => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        const f = e.dataTransfer.files[0];
        if (f) Plant._uploadWheel(plantName, f);
      };
    }
  },

  _uploadWheel(plantName, file) {
    const status = document.getElementById('plant-cw-status');
    const zone   = document.getElementById('plant-cw-dropzone');
    if (status) { status.textContent = Util.t('toast.uploading_file', { name: file.name }); status.className = 'admin-status info'; }
    if (zone)   zone.classList.add('uploading');

    const fd = new FormData();
    fd.append('file', file);
    fetch(`${Config.API_BASE}/color-wheel/${encodeURIComponent(plantName)}`, {
      method: 'POST', body: fd,
      headers: { 'X-User': Session.actor() },
    })
      .then(r => r.json())
      .then(body => {
        if (zone) zone.classList.remove('uploading');
        if (body.status !== 'ok') {
          if (status) { status.textContent = Util.t('toast.upload_failed', { msg: body.message || 'unknown' });  status.className = 'admin-status error'; }
          ErrorLog.error('plant', `Color wheel upload failed for ${plantName}: ${body.message}`, body);
          return;
        }
        const verb = body.replaced ? 'replaced' : 'uploaded';
        if (status) { status.textContent = Util.t('ui.color_wheel_status', { verb, count: body.row_count }); status.className = 'admin-status success'; }
        Toast.show(Util.t('toast.color_wheel_verb', { verb, plant: plantName }), 'success');
        ErrorLog.info('plant', `Color wheel ${verb} for ${plantName}: ${body.row_count} colors`);
        Plant._fetchAndRenderOptimization(plantName);
      })
      .catch(e => {
        if (zone) zone.classList.remove('uploading');
        if (status) { status.textContent = Util.t('toast.upload_failed', { msg: e.message }); status.className = 'admin-status error'; }
        ErrorLog.error('plant', `Color wheel upload network error: ${e.message}`);
      });
  },

  async _confirmDeleteWheel(plantName) {
    const ok = await Modal.confirm({ title: Util.t('modal.remove_color_wheel', { plant: plantName }), confirmLabel: Util.t('btn.yes_delete') });
    if (!ok) return;
    fetch(`${Config.API_BASE}/color-wheel/${encodeURIComponent(plantName)}`, {
      method: 'DELETE',
      headers: { 'X-User': Session.actor() },
    })
      .then(r => r.json())
      .then(body => {
        if (body.status !== 'ok' && body.status !== 'not_found') {
          Toast.show(Util.t('toast.delete_failed'), 'error'); return;
        }
        Toast.show(Util.t('toast.color_wheel_deleted', { plant: plantName }), 'success');
        ErrorLog.info('plant', `Color wheel deleted for ${plantName}`);
        Plant._fetchAndRenderOptimization(plantName);
      })
      .catch(e => Toast.show(Util.t('toast.delete_failed_msg', { msg: e.message }), 'error'));
  },

  // Relocated bodily from app.js's `App._renderSettingsPane` (CQ-1 Phase 4
  // Task 1 — see this phase's plan's Architecture section, seam #1). This is
  // per-plant scheduling-constraint UI that only ever renders into Plant's
  // own #plant-tab-settings DOM and is only ever triggered from
  // Plant.gotoTab('settings') above — moving it here eliminates a Plant →
  // App → back-into-Plant's-own-DOM seam rather than carrying it forward.
  // Its one `Store._state.masterData` direct touch is untouched, verbatim —
  // closing that §6 exception is not this task's job (see the compatibility
  // inventory).
  _renderSettingsPane() {
    const pane = document.getElementById('plant-tab-settings');
    if (!pane) return;
    const plantName = Store.selectedPlant;
    const plantRow  = Store._state.masterData?.plants?.find(p => p.plant === plantName) ?? null;
    // Values stored as total minutes in DB
    const alertHz = plantRow?.alt_flag_horizon   ?? Store.userSettings.alertHorizonMinutes   ?? 43200;
    const confHz  = plantRow?.conf_score_horizon ?? Store.userSettings.confidenceHorizonMinutes ?? 20160;

    pane.innerHTML = `
      <div class="cal-scroll"><div class="cal-container">
        <header class="cal-head">
          <div>
            <h2>${Util.t('ui.system_settings_title')}</h2>
            <p class="sub">${Util.t('ui.system_settings_sub', { plant: plantName || 'the selected plant' })}</p>
          </div>
        </header>
        <div style="display:flex;flex-direction:column;gap:24px;padding:8px 0 32px">

          <div class="panel">
            <header class="panel-head"><h3>Alert Horizon</h3></header>
            <div class="panel-body">
              <p style="margin:0 0 12px;font-size:13px;color:var(--fg-mute)">Controls which alerts appear in the header badge and alert drawer. Orders beyond the selected window are hidden to reduce noise. The window rolls with the current clock continuously.</p>
              <div style="display:flex;align-items:center;gap:8px;font-size:13px">
                <span style="min-width:160px">Show alerts within the next</span>
                <input type="number" id="sys-alert-horizon-days" class="form-input" min="1" max="60" step="1"
                       style="width:64px;text-align:right" placeholder="0">
                <span>days</span>
              </div>
            </div>
          </div>

          <div class="panel">
            <header class="panel-head"><h3>Confidence Score Horizon</h3></header>
            <div class="panel-body">
              <p style="margin:0 0 12px;font-size:13px;color:var(--fg-mute)">The rolling window used to compute the schedule confidence score. Shorter windows surface near-term risk more sharply; longer windows give a broader health picture. The window rolls with the current clock continuously.</p>
              <div style="display:flex;align-items:center;gap:8px;font-size:13px">
                <span style="min-width:160px">Score covers the next</span>
                <input type="number" id="sys-conf-horizon-days" class="form-input" min="1" step="1"
                       style="width:64px;text-align:right" placeholder="0">
                <span>days</span>
              </div>
            </div>
          </div>

          <div class="panel">
            <header class="panel-head"><h3>${Util.t('ui.constraints_title')}</h3></header>
            <div class="panel-body">
              <p style="margin:0 0 12px;font-size:13px;color:var(--fg-mute)">${Util.t('ui.constraints_sub')}</p>
              <div id="sys-constraints-list" class="constraint-list"></div>
            </div>
          </div>

        </div>
      </div></div>`;

    const alertDaysInp = pane.querySelector('#sys-alert-horizon-days');
    const confDaysInp  = pane.querySelector('#sys-conf-horizon-days');

    alertDaysInp.value = Math.max(1, Math.round(alertHz / 1440));
    confDaysInp.value  = Math.max(1, Math.round(confHz  / 1440));

    async function _savePlantHorizon(patch) {
      if (!plantRow) { Toast.show(Util.t('toast.no_plant_selected'), 'warn'); return false; }
      try {
        const r = await fetch(`${Config.API_BASE}/master-data/plants/bulk`, {
          method:  'POST',
          headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
          body:    JSON.stringify({ upserts: [{ subnetwork: plantRow.subnetwork, plant: plantRow.plant, ...patch }], deletes: [] }),
        });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || `HTTP ${r.status}`); }
        Object.assign(plantRow, patch); // commit to Store only once the write is confirmed
        return true;
      } catch (e) {
        Toast.show(Util.t('toast.horizon_save_failed', { msg: e.message }), 'error');
        return false;
      }
    }

    function readAlertMinutes() {
      const days = Math.max(1, parseInt(alertDaysInp.value, 10) || 1);
      return days * 1440;
    }

    function readConfMinutes() {
      const days = Math.max(1, parseInt(confDaysInp.value, 10) || 1);
      return days * 1440;
    }

    async function saveAlert() {
      const prevMin = plantRow?.alt_flag_horizon ?? Store.userSettings.alertHorizonMinutes ?? 43200;
      const totalMin = readAlertMinutes();
      Store.setUserSettings({ alertHorizonMinutes: totalMin }, 'system-settings');
      const ok = await _savePlantHorizon({ alt_flag_horizon: totalMin });
      if (!ok) {
        Store.setUserSettings({ alertHorizonMinutes: prevMin }, 'system-settings');
        alertDaysInp.value = Math.max(1, Math.round(prevMin / 1440));
      }
      AlertsUIAdapter.renderBell();
      if (document.getElementById('alert-drawer')?.classList.contains('open')) AlertsUIAdapter.renderDrawer();
    }

    async function saveConf() {
      const prevMin = plantRow?.conf_score_horizon ?? Store.userSettings.confidenceHorizonMinutes ?? 20160;
      const totalMin = readConfMinutes();
      Store.setUserSettings({ confidenceHorizonMinutes: totalMin }, 'system-settings');
      const ok = await _savePlantHorizon({ conf_score_horizon: totalMin });
      if (!ok) {
        Store.setUserSettings({ confidenceHorizonMinutes: prevMin }, 'system-settings');
        confDaysInp.value = Math.max(1, Math.round(prevMin / 1440));
      }
      if (typeof NIMBUS !== 'undefined' && NIMBUS.Confidence?._recomputeDebounced)
        NIMBUS.Confidence._recomputeDebounced();
    }

    alertDaysInp.addEventListener('change', saveAlert);
    confDaysInp.addEventListener('change', saveConf);

    // --- Scheduling constraints (switchable, per-plant) ---------------------
    // Ordered list [{key, enabled, order}] backed by plants.constraints JSONB.
    // Only colorWheel is wired into the optimizer today; the catalog/order/UI
    // are the first step toward a general per-plant constraint registry.
    const consListEl = pane.querySelector('#sys-constraints-list');
    let consState = [];
    let _wheelPresent = null;  // null = unknown until the wheel probe returns

    function renderConstraints() {
      if (!consListEl) return;
      consListEl.innerHTML = consState.map((c, i) => {
        const cat = Engine.CONSTRAINT_CATALOG.find(x => x.key === c.key) || { label: c.key, desc: '' };
        const noWheel = (c.key === 'colorWheel' && _wheelPresent === false);
        return `
          <div class="constraint-row" data-key="${c.key}">
            <div class="cons-reorder">
              <button class="cons-up" ${i === 0 ? 'disabled' : ''} title="${Util.t('ui.move_up')}">▲</button>
              <button class="cons-dn" ${i === consState.length - 1 ? 'disabled' : ''} title="${Util.t('ui.move_down')}">▼</button>
            </div>
            <div class="cons-meta">
              <div class="cons-label">${cat.label}</div>
              <div class="cons-desc">${cat.desc}${noWheel ? ` <span class="cons-warn">${Util.t('ui.constraint_no_wheel')}</span>` : ''}</div>
            </div>
            <label class="cons-toggle">
              <input type="checkbox" ${c.enabled ? 'checked' : ''}>
              <span>${c.enabled ? Util.t('ui.constraint_on') : Util.t('ui.constraint_off')}</span>
            </label>
          </div>`;
      }).join('');

      consListEl.querySelectorAll('.constraint-row').forEach(rowEl => {
        const key = rowEl.dataset.key;
        rowEl.querySelector('.cons-toggle input').addEventListener('change', e => {
          const c = consState.find(x => x.key === key);
          if (c) c.enabled = e.target.checked;
          renderConstraints();
          saveConstraints();
        });
        rowEl.querySelector('.cons-up').addEventListener('click', () => moveConstraint(key, -1));
        rowEl.querySelector('.cons-dn').addEventListener('click', () => moveConstraint(key, +1));
      });
    }

    function moveConstraint(key, dir) {
      const i = consState.findIndex(x => x.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= consState.length) return;
      [consState[i], consState[j]] = [consState[j], consState[i]];
      renderConstraints();
      saveConstraints();
    }

    // Rebuild consState from the last-known-persisted plantRow.constraints
    // (the catalog default fills in any key absent from that persisted list).
    // Shared by init and by saveConstraints' failure path, since plantRow.constraints
    // is only mutated once a write is confirmed — it is always the source of truth to revert to.
    function rebuildConsStateFromPersisted() {
      const stored = Array.isArray(plantRow?.constraints) ? plantRow.constraints : null;
      consState = Engine.CONSTRAINT_CATALOG.map((cat, i) => {
        const s = stored?.find(x => x.key === cat.key);
        return {
          key:     cat.key,
          enabled: s ? !!s.enabled : Engine.constraintEnabled(plantName, cat.key),
          order:   (s && Number.isFinite(s.order)) ? s.order : i + 1,
        };
      }).sort((a, b) => a.order - b.order);
    }

    async function saveConstraints() {
      if (!plantRow) { Toast.show(Util.t('toast.no_plant_selected'), 'warn'); return; }
      consState.forEach((c, idx) => { c.order = idx + 1; });
      const payload = consState.map(c => ({ key: c.key, enabled: c.enabled, order: c.order }));
      try {
        const r = await fetch(`${Config.API_BASE}/master-data/plants/${encodeURIComponent(plantRow.plant)}/constraints`, {
          method:  'POST',
          headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
          body:    JSON.stringify({ subnetwork: plantRow.subnetwork, constraints: payload }),
        });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || `HTTP ${r.status}`); }
        plantRow.constraints = payload;  // commit to Store only once the write is confirmed
      } catch (e) {
        Toast.show(Util.t('toast.constraints_save_failed', { msg: e.message }), 'error');
        rebuildConsStateFromPersisted();
        renderConstraints();
      }
    }

    (function initConstraints() {
      rebuildConsStateFromPersisted();
      renderConstraints();
      // Probe whether a wheel is actually uploaded (hint only — the toggle works
      // regardless, since enabling color with no wheel is a harmless no-op).
      if (plantName) {
        fetch(`${Config.API_BASE}/color-wheel/${encodeURIComponent(plantName)}`, { signal: AbortSignal.timeout(4000) })
          .then(r => r.ok ? r.json() : null)
          .then(b => { _wheelPresent = !!(b && b.entries && b.entries.length); renderConstraints(); })
          .catch(() => {});
      }
    })();
  },
};

/* =============================================================================
   PRODLINES — per-line settings: capacity buffer, bottleneck, working hours,
   and line-scoped blackout blocks.
   ========================================================================== */
export const ProdLines = {
  _lineFilter: '',
  _activeNavLine: null,

  render() {
    const body = document.getElementById('lines-body');
    if (!body) return;
    const allLines = Store.selectedPlant ? Store.linesForSelectedPlant() : CalendarUI._getLines();

    allLines.forEach(l => {
      Store.ensureCalendar(l);
      Store.ensureLineSettings(l);
    });

    const filterBar = document.getElementById('lines-filter-bar');
    if (filterBar) {
      filterBar.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px;font-size:13px;">
          <span style="color:var(--text-muted,#64748b);">Plant</span>
          <span class="plant-badge">${Store.selectedPlant || '—'}</span>
        </div>`;
    }

    const shownLines = !ProdLines._lineFilter
      ? allLines
      : allLines.filter(l => l.toLowerCase().includes(ProdLines._lineFilter.toLowerCase()));

    // Default or reset active line if stale
    if (!ProdLines._activeNavLine || !allLines.includes(ProdLines._activeNavLine)) {
      ProdLines._activeNavLine = allLines[0] || null;
    }

    ProdLines._renderNav(allLines, shownLines);
    ProdLines._wireNav();

    if (!allLines.length) {
      body.innerHTML = `<div class="lines-detail-empty">${Util.t('empty.no_lines_loaded')}</div>`;
      return;
    }

    ProdLines._renderDetail(ProdLines._activeNavLine);
  },

  _renderDetail(line) {
    const body = document.getElementById('lines-body');
    if (!body || !line) {
      if (body) body.innerHTML = `<div class="lines-detail-empty">${Util.t('empty.select_line_configure')}</div>`;
      return;
    }

    const allLines = Store.selectedPlant ? Store.linesForSelectedPlant() : CalendarUI._getLines();
    const gi = allLines.indexOf(line);
    const color = Config.COLORS[gi % Config.COLORS.length];
    const ls = Store.lineSettings[line] || {};
    const cal = Store.calendars[line]?.workHours || {};
    const dayLabels = ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => Util.t(k));

    const hoursPills = [0,1,2,3,4,5,6].map(d => {
      const wh = cal[d];
      const label = dayLabels[d];
      const time = wh ? `${ProdLines._fmtHour(wh[0])}–${ProdLines._fmtHour(wh[1])}` : Util.t('ui.off');
      return `<div class="line-hours-pill ${wh ? 'on' : 'off'}">
        <span class="lhp-day">${label}</span>
        <span class="lhp-time">${time}</span>
      </div>`;
    }).join('');

    body.innerHTML = `<div class="lines-detail">
      <div class="ld-header">
        <span class="line-dot" style="background:${color};width:14px;height:14px;border-radius:50%;display:inline-block;flex-shrink:0;"></span>
        <span class="ld-name">${line}</span>
        <span class="plant-badge" style="margin-left:auto;">${Store.selectedPlant || '—'}</span>
      </div>
      <div class="ld-settings-row">
        <label class="ld-ctrl-label">
          <input type="checkbox" class="line-bottleneck-chk" ${ls.bottleneck ? 'checked' : ''} data-line="${line}">
          ${Util.t('ui.bottleneck')}
        </label>
        <label class="ld-ctrl-label">
          <input type="checkbox" class="line-excl-opt-chk" ${ls.excludeFromOpt ? 'checked' : ''} data-line="${line}">
          ${Util.t('ui.excl_optimizer_full')}
        </label>
        <span class="ld-buffer">
          <span class="ld-buffer-label">${Util.t('ui.buffer_label')}</span>
          <span class="buf-seg">
            <button class="seg-btn buf-unit-btn ${ls.bufferUnit === 'pct' ? 'active' : ''}" data-line="${line}" data-unit="pct">%</button>
            <button class="seg-btn buf-unit-btn ${ls.bufferUnit === 'hours' ? 'active' : ''}" data-line="${line}" data-unit="hours">hrs</button>
          </span>
          <input type="number" class="input buf-pct-input" ${ls.bufferUnit !== 'pct' ? 'style="display:none"' : ''} min="0" max="100" step="1" value="${ls.bufferPct || 0}" data-line="${line}">
          <input type="number" class="input buf-hrs-input" ${ls.bufferUnit !== 'hours' ? 'style="display:none"' : ''} min="0" step="0.25" value="${ls.bufferHours || 0}" data-line="${line}">
        </span>
        <span class="ld-buffer">
          <span class="ld-buffer-label">Production Line Group</span>
          <input type="text" class="input plgroup-input" style="width:140px;" value="${(ls.plGroup||'').replace(/"/g,'&quot;')}" data-line="${line}" placeholder="e.g. PREMIUM">
        </span>
      </div>
      <div class="ld-section">
        <div class="ld-section-head">
          <span class="ld-section-title">${Util.t('ui.working_hours_section')}</span>
          <button class="btn btn-ghost sm" onclick="NIMBUS.EditCalendar.open('${line}')">${Util.t('btn.edit_calendar')}</button>
        </div>
        <div class="ld-section-body">
          <div class="line-hours-pills">${hoursPills}</div>
        </div>
      </div>
      <div class="ld-section">
        <div class="ld-section-head">
          <span class="ld-section-title">${Util.t('ui.line_blackouts_section')}</span>
          <button class="btn btn-ghost sm" onclick="NIMBUS.ProdLines.openBlockModal('${line}')">+ Add</button>
        </div>
        <div class="ld-section-body">
          <div class="line-blocks-list" id="line-blocks-${line}">${ProdLines._renderLineBlocks(line)}</div>
        </div>
      </div>
    </div>`;

    ProdLines._ensureDelegated();
  },

  _renderNav(allLines, shownLines) {
    const nav = document.getElementById('lines-nav');
    if (!nav) return;
    const items = shownLines.map(line => {
      const gi = allLines.indexOf(line);
      const color = Config.COLORS[gi % Config.COLORS.length];
      const ls = Store.lineSettings[line] || {};
      const isActive = ProdLines._activeNavLine === line;
      return `<div class="lines-nav-item${isActive ? ' active' : ''}" data-line="${line}">
        <span class="line-dot" style="background:${color};display:inline-block;width:7px;height:7px;border-radius:50%;flex-shrink:0;"></span>
        <span class="lines-nav-label">${line}</span>
        ${ls.bottleneck ? '<span class="lines-nav-bottleneck" title="Bottleneck">🚧</span>' : ''}
        ${ls.excludeFromOpt ? '<span class="lines-nav-excl-opt" title="Excluded from optimization">🚫</span>' : ''}
      </div>`;
    }).join('');
    if (!document.getElementById('lines-nav-input')) {
      nav.innerHTML = `
        <div class="lines-nav-header">
          <div class="lines-nav-title" id="lines-nav-title">Lines &middot; ${allLines.length}</div>
          <input id="lines-nav-input" class="lines-nav-input" type="text" placeholder="${Util.t('ph.search_lines')}" autocomplete="off" spellcheck="false">
        </div>
        <div class="lines-nav-list" id="lines-nav-list"></div>`;
    } else {
      const t = document.getElementById('lines-nav-title');
      if (t) t.textContent = `Lines · ${allLines.length}`;
      const inp = document.getElementById('lines-nav-input');
      if (inp) inp.value = ProdLines._lineFilter;
    }
    const listEl = document.getElementById('lines-nav-list');
    if (listEl) listEl.innerHTML = items || `<div class="lines-nav-empty">${Util.t('ui.no_lines_match')}</div>`;
  },

  _wireNav() {
    const input = document.getElementById('lines-nav-input');
    if (input && !input._wired) {
      input._wired = true;
      input.oninput = function() {
        ProdLines._lineFilter = this.value;
        ProdLines.render();
      };
    }
    const list = document.getElementById('lines-nav-list');
    if (list) {
      list.onclick = function(e) {
        const item = e.target.closest('.lines-nav-item');
        if (!item) return;
        const line = item.dataset.line;
        ProdLines._activeNavLine = line;
        list.querySelectorAll('.lines-nav-item').forEach(i =>
          i.classList.toggle('active', i.dataset.line === line));
        ProdLines._renderDetail(line);
      };
    }
  },

  _renderLineBlocks(line) {
    const plant = Store.getPlantForLine(line);
    const lineBlocks = (Store.blocks || [])
      .filter(b => b.line === line && (!b.plant || b.plant === plant))
      .slice().sort((a, b) => Util.parseDate(a.start) - Util.parseDate(b.start));

    const plantBlocks = (Store.plantBlocks || [])
      .filter(b => !b.plant || b.plant === plant)
      .slice().sort((a, b) => Util.parseDate(a.start) - Util.parseDate(b.start));

    if (!lineBlocks.length && !plantBlocks.length) {
      return `<div style="font-size:12px;color:var(--text-muted,#888);padding:4px 0;">${Util.t('empty.no_blackouts_this_line')}</div>`;
    }

    const lineRows = lineBlocks.map(b => `
      <div class="block-row">
        <span class="ico">■</span>
        <span class="reason">${b.reason || Util.t('ui.blackouts_label', {plural: ''})}</span>
        <span class="range" title="${Util.fmtDTReadable(b.start)} → ${Util.fmtDTReadable(b.end)}">${Util.fmtBlockRange(b.start, b.end)}</span>
        <button class="btn btn-ghost sm" style="padding:2px 7px;font-size:14px;" title="${Util.t('tip.remove_block')}" onclick="NIMBUS.CalendarUI.removeBlock('${b.id}'); NIMBUS.ProdLines._renderDetail(NIMBUS.ProdLines._activeNavLine);">×</button>
      </div>`).join('');

    const plantRows = plantBlocks.map(b => `
      <div class="block-row" style="opacity:0.75;padding-left:6px;padding-right:6px;">
        <span class="ico" style="color:#d97706;">■</span>
        <span class="reason">${b.reason || Util.t('ui.plant_blackout_default')}</span>
        <span class="line-tag" style="background:#fef3c7;color:#d97706;">Plant</span>
        <span class="range" title="${Util.fmtDTReadable(b.start)} → ${Util.fmtDTReadable(b.end)}">${Util.fmtBlockRange(b.start, b.end)}</span>
      </div>`).join('');

    return lineRows + plantRows;
  },

  // Delegated ONCE on the persistent #lines-body container (survives the
  // innerHTML re-renders in _renderDetail), replacing the old per-render
  // _wireInputs that re-bound 6 querySelectorAll loops every edit. Every
  // control carries data-line; .buf-unit-btn also carries data-unit.
  _ensureDelegated() {
    if (ProdLines._delegated) return;
    const body = document.getElementById('lines-body');
    if (!body) return;
    ProdLines._delegated = true;

    body.addEventListener('change', (e) => {
      const el = e.target;
      const line = el.dataset && el.dataset.line;
      if (!line) return;
      if (el.classList.contains('line-bottleneck-chk')) {
        Store.setLineSetting(line, { bottleneck: el.checked }, 'prodlines');
        NIMBUS.MasterData.syncLineSettings(line, { bottleneck: el.checked });
        Toast.show(Util.t('toast.line_settings_updated'), 'success');
      } else if (el.classList.contains('line-excl-opt-chk')) {
        Store.setLineSetting(line, { excludeFromOpt: el.checked }, 'prodlines');
        NIMBUS.MasterData.syncLineSettings(line, { excludeFromOpt: el.checked });
        Toast.show(Util.t('toast.line_settings_updated'), 'success');
      } else if (el.classList.contains('buf-pct-input')) {
        const val = Math.max(0, Math.min(100, +el.value || 0));
        Store.setLineSetting(line, { bufferPct: val }, 'prodlines');
        NIMBUS.MasterData.syncLineSettings(line, { bufferPct: val });
        Toast.show(Util.t('toast.buffer_updated'), 'success');
      } else if (el.classList.contains('buf-hrs-input')) {
        const val = Math.max(0, +el.value || 0);
        Store.setLineSetting(line, { bufferHours: val }, 'prodlines');
        NIMBUS.MasterData.syncLineSettings(line, { bufferHours: val });
        Toast.show(Util.t('toast.buffer_updated'), 'success');
      } else if (el.classList.contains('plgroup-input')) {
        const val = el.value.trim();
        Store.setLineSetting(line, { plGroup: val }, 'prodlines');
        NIMBUS.MasterData.syncLineSettings(line, { plGroup: val });
        Toast.show(Util.t('toast.line_settings_updated'), 'success');
      }
    });

    body.addEventListener('click', (e) => {
      const btn = e.target.closest('.buf-unit-btn');
      if (!btn) return;
      const line = btn.dataset.line;
      Store.setLineSetting(line, { bufferUnit: btn.dataset.unit }, 'prodlines');
      NIMBUS.MasterData.syncLineSettings(line, { bufferUnit: btn.dataset.unit });
      ProdLines._renderDetail(ProdLines._activeNavLine);
    });
  },

  _fmtHour(h) {
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    const ampm = hh < 12 ? 'am' : 'pm';
    const h12  = hh % 12 || 12;
    return mm === 0 ? `${h12}${ampm}` : `${h12}:${String(mm).padStart(2, '0')}${ampm}`;
  },

  openBlockModal(line) {
    const lineSel = document.getElementById('lines-blk-line');
    if (!lineSel) { ErrorLog.error('ui', 'required DOM element missing: lines-blk-line'); return; }
    const reasonEl = document.getElementById('lines-blk-reason');
    if (!reasonEl) { ErrorLog.error('ui', 'required DOM element missing: lines-blk-reason'); return; }

    lineSel.innerHTML = CalendarUI._getLines()
      .map(l => `<option value="${l}"${l === line ? ' selected' : ''}>${l}</option>`).join('');
    if (line) lineSel.value = line;

    const now = new Date(); now.setMinutes(0, 0, 0);
    const plus1 = new Date(now.getTime() + Config.MS_HOUR);
    if (!ProdLines._fpBlkStart) {
      ProdLines._fpBlkStart = Util.fpDatetime('#lines-blk-start');
      ProdLines._fpBlkEnd   = Util.fpDatetime('#lines-blk-end');
    }
    ProdLines._fpBlkStart.setDate(now, false);
    ProdLines._fpBlkEnd.setDate(plus1, false);
    reasonEl.value = '';
    Modal.open('modal-lines-block');
  },

  saveBlockFromModal() {
    const lineEl = document.getElementById('lines-blk-line');
    const startEl = document.getElementById('lines-blk-start');
    const endEl = document.getElementById('lines-blk-end');
    const reasonEl = document.getElementById('lines-blk-reason');
    if (!lineEl || !startEl || !endEl || !reasonEl) { ErrorLog.error('ui', 'required DOM elements missing for production lines blackout modal'); return; }

    const line   = lineEl.value;
    const start  = Util.parseDate(startEl.value);
    const end    = Util.parseDate(endEl.value);
    const reason = reasonEl.value.trim() || Util.t('ui.blackouts_label', {plural: ''});
    if (!line)          { Toast.show(Util.t('toast.select_a_line'), 'error'); return; }
    if (!start || !end) { Toast.show(Util.t('toast.please_set_start_end'), 'error'); return; }
    if (end <= start)   { Toast.show(Util.t('toast.end_must_be_after_start'), 'error'); return; }
    const plant = Store.getPlantForLine(line) || Store.selectedPlant;
    if (!plant) { Toast.show(Util.t('toast.select_plant_first'), 'warn'); return; }
    const before = Store.blocks.length;
    Store.addBlock({ line, plant, start, end, reason }, 'prodlines');
    if (Store.blocks.length > before) CalendarSync.saveLineBlackoutUpsert(Store.blocks[Store.blocks.length - 1]);
    Modal.close('modal-lines-block');
    Toast.show(Util.t('toast.blackout_added'), 'success');
    ProdLines._renderDetail(ProdLines._activeNavLine);
  },

  // Static onclick= handlers converted to real listeners (CQ-1 Phase 4 Task 1,
  // following the Phase 3 `Interaction._showMultiInspector` precedent) are
  // wired from Plant.init() below via `_wireStaticHandlers()`, since
  // CalendarUI and ProdLines have no boot-time init() of their own — Plant's
  // is the single boot-time entry point for this whole family's static
  // index.html markup (the plant-inner-tabs strip, the plant blackout "+ Add"
  // button, and the three modal Save buttons). See Plant.init() and
  // Plant._wireStaticHandlers().
};
