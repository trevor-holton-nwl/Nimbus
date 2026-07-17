// plant-and-administration.mjs — CQ-1 plant-and-administration module.
// Owns Plant, production lines, labor planning, Master Data, Bill of
// Materials, SAP Interface, Security, Admin Cockpit, color-wheel
// administration, and plant/line calendar management. Owns no planner
// timeline or application-wide navigation — see application-shell.mjs.
//
// CQ-1 Phase 4 Task 1 moved CalendarUI, Plant, and ProdLines here verbatim
// from app.js, plus Plant._renderSettingsPane (relocated bodily from App —
// see the comment on that method below).
// CQ-1 Phase 4 Task 2 moved MasterData and LaborPlanning here verbatim too.
// Plant's/ProdLines' `MasterData.syncLineSettings(...)` call sites are left
// going through the shared `NIMBUS` binding (`NIMBUS.MasterData.
// syncLineSettings(...)`) rather than simplified to a same-module bare
// reference now that `MasterData` lives in this same file — both forms are
// equivalent at runtime, and Task 2 doesn't require touching Plant/ProdLines'
// code, the same reasoning Phase 3 used for Timeline's/Table's/Dashboard's
// forward references once their targets landed in the same file (see
// docs/architecture/cq1-compatibility-inventory.md). `LaborPlanning`'s
// `App._laborSub`/`App._currentTab` reads became `_activeTabResolvers.
// laborSub()`/`.currentTab()` (the same injected getter seam Task 1
// established for `Plant`). `MasterData`'s one `Store._state.masterData = {
// ...}; Store.rebuildPlantIndex();` write became `Store.setMasterData(...)`
// (the existing public setter added in Phase 2 Task 4), closing `MasterData`'s
// tracked §6 exception for real rather than carrying it forward by
// relocation — see the comment at that call site and
// docs/architecture/cq1-compatibility-inventory.md §6. `LaborPlanning` itself
// still has six direct `Store._state.masterData` *reads* that this task does
// not close (not named in this task's scope; tracked as a new §6 row instead
// of silently dropped — see the inventory). Interface/Security/AdminCockpit
// (Task 3) have not moved yet as of this commit.
/* global NIMBUS */
import { Config, Util, ErrorLog, Toast, Modal } from './application-foundation.mjs';
import { Store, UndoStack } from './schedule-state.mjs';
import { Calendar, Engine, Utilization } from './schedule-services.mjs';
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

/* =============================================================================
   LABOR PLANNING — aggregate-to-line available labor hours planning
   Sub-tabs: Aggregate · Line Plan · Capacity · Exceptions · Inputs
   ========================================================================== */
export const LaborPlanning = (() => {
  // ── State ────────────────────────────────────────────────────────────────
  let _horizonOffset  = 0;         // weeks offset from today's Monday
  let _horizonSpan    = 12;        // number of weeks in view
  let _selectedGroups = new Set(); // empty = all groups; used to scope all sub-tabs
  let _aggrData       = {};        // { [plant]: { [grp]: { [period]: avail_hours } } }
  let _lineData       = {};        // { [plant]: { [line]: { [day]: { avail_hours, source } } } }
  let _groups         = [];        // sorted unique pl_group values for current plant
  let _displayGroups  = [];        // currently rendered subset (respects _selectedGroups filter)
  let _weeks         = [];   // [{ key:'YYYY-Www', label:'MM/DD/YY', monday:Date }]
  let _selRange      = null; // { r0,c0,r1,c1 } lasso rectangle, or null
  let _dragging      = false;
  let _dragAnchor    = null;
  let _fpHorizon     = null; // Flatpickr instance for the date-jump input
  let _cellGrid      = null; // [r][c] -> <td> cache for the Aggregate grid (built per render)
  let _selTds        = new Set(); // currently-highlighted <td>s, for incremental lasso diffing

  // ── Date helpers ─────────────────────────────────────────────────────────
  function _isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / Config.MS_DAY) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }

  function _weekLabel(monday) {
    const m = String(monday.getMonth() + 1).padStart(2, '0');
    const d = String(monday.getDate()).padStart(2, '0');
    const y = String(monday.getFullYear()).slice(-2);
    return `${m}/${d}/${y}`;
  }

  function _computeWeeks() {
    const now    = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7) + _horizonOffset * 7);
    const weeks = [];
    for (let i = 0; i < _horizonSpan; i++) {
      const d = new Date(monday); d.setDate(monday.getDate() + i * 7);
      weeks.push({ key: _isoWeek(d), label: _weekLabel(new Date(d)), monday: new Date(d) });
    }
    return weeks;
  }

  function _isoWeekToMonday(isoKey) {
    const [year, week] = isoKey.split('-W');
    const y = parseInt(year, 10), w = parseInt(week, 10);
    const jan4 = new Date(y, 0, 4);
    const dow  = jan4.getDay() || 7;
    const week1Mon = new Date(jan4); week1Mon.setDate(jan4.getDate() - (dow - 1));
    const monday   = new Date(week1Mon); monday.setDate(week1Mon.getDate() + (w - 1) * 7);
    return monday;
  }

  // ── Backend helpers ───────────────────────────────────────────────────────
  function _subnetwork(plant) {
    return (Store._state.masterData?.plants || []).find(p => p.plant === plant)?.subnetwork || '';
  }

  async function _saveAggregate(subnetwork, plant, cells) {
    try {
      const r = await fetch(`${Config.API_BASE}/labor-plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
        body: JSON.stringify({ subnetwork, plant, cells }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.detail || `HTTP ${r.status}`); }
    } catch (e) {
      Toast.show(`Labor plan save failed: ${e.message}`, 'error');
      ErrorLog.error('labor', `Save aggregate failed: ${e.message}`);
    }
  }

  async function _saveLines(subnetwork, plant, cells) {
    if (!cells.length) return;
    try {
      const r = await fetch(`${Config.API_BASE}/labor-plan/line`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
        body: JSON.stringify({ subnetwork, plant, cells }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.detail || `HTTP ${r.status}`); }
    } catch (e) {
      Toast.show(`Line plan save failed: ${e.message}`, 'error');
      ErrorLog.error('labor', `Save lines failed: ${e.message}`);
    }
  }

  async function _fetchAggregate(plant) {
    if (_aggrData[plant]) return _aggrData[plant];
    try {
      const res = await fetch(`${Config.API_BASE}/labor-plan?plant=${encodeURIComponent(plant)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const map = {};
      (json.rows || []).forEach(r => {
        if (!map[r.pl_group]) map[r.pl_group] = {};
        map[r.pl_group][r.period] = r.avail_hours;
      });
      _aggrData[plant] = map;
      return map;
    } catch (e) {
      ErrorLog.warn('labor', `Fetch aggregate failed for ${plant}: ${e.message}`);
      return {};
    }
  }

  async function _fetchLines(plant, group) {
    const w0 = _weeks[0], wN = _weeks[_weeks.length - 1];
    const from_date = Util.dayKey(w0.monday);
    const toDate    = new Date(wN.monday); toDate.setDate(wN.monday.getDate() + 6);
    const to_date   = Util.dayKey(toDate);
    try {
      let url = `${Config.API_BASE}/labor-plan/line?plant=${encodeURIComponent(plant)}&from_date=${from_date}&to_date=${to_date}`;
      if (group) url += `&group=${encodeURIComponent(group)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!_lineData[plant]) _lineData[plant] = {};
      (json.rows || []).forEach(r => {
        if (!_lineData[plant][r.production_line]) _lineData[plant][r.production_line] = {};
        _lineData[plant][r.production_line][r.day] = { avail_hours: r.avail_hours, source: r.source };
      });
    } catch (e) {
      ErrorLog.warn('labor', `Fetch lines failed: ${e.message}`);
    }
  }

  // ── Disaggregation ───────────────────────────────────────────────────────
  function _disaggregate(plant, group, periodKey, groupHours) {
    const lines = (Store._state.masterData?.lines || [])
      .filter(l => l.plant === plant && l.pl_group === group)
      .map(l => l.production_line);
    if (!lines.length) return [];

    const monday = _isoWeekToMonday(periodKey);
    const openSlots = [];
    lines.forEach(line => {
      for (let d = 0; d < 7; d++) {
        const date = new Date(monday); date.setDate(monday.getDate() + d);
        if (Calendar.effectiveCapacityHours(line, date) > 0)
          openSlots.push({ line, date, dayKey: Util.dayKey(date) });
      }
    });
    if (!openSlots.length) return [];

    const perSlot = Math.max(0, (groupHours || 0)) / openSlots.length;
    const rounded = Math.round(perSlot * 10) / 10;
    return openSlots.map(s => ({ production_line: s.line, day: s.dayKey, avail_hours: rounded, source: 'auto_split' }));
  }

  // ── KPI strip ────────────────────────────────────────────────────────────
  function _renderKPIs(plant) {
    const strip = document.getElementById('labor-kpi-strip');
    if (!strip || !plant) { if (strip) strip.innerHTML = ''; return; }

    const planMap = _aggrData[plant] || {};
    let totalAvail = 0;
    _groups.forEach(g => _weeks.forEach(w => {
      const v = planMap[g]?.[w.key]; if (v != null) totalAvail += v;
    }));

    const horizonStart = _weeks[0]?.monday || new Date();
    const horizonDays  = Math.min(_horizonSpan * 7, 90);
    const matrix = Utilization.computeMatrix(horizonStart, horizonDays);
    const plantLines = (Store._state.masterData?.lines || []).filter(r => r.plant === plant).map(r => r.production_line);
    let totalRequired = 0;
    plantLines.forEach(line => {
      const lm = matrix[line]; if (!lm) return;
      Object.values(lm).forEach(cell => { totalRequired += cell.scheduled || 0; });
    });

    const diff     = totalAvail - totalRequired;
    const headroom = totalAvail > 0 ? Math.round((diff / totalAvail) * 100) : 0;
    const hSev     = headroom < 0 ? 'err' : headroom < 15 ? 'warn' : '';

    let shortfalls = 0;
    plantLines.forEach(line => {
      const lm = matrix[line]; if (!lm) return;
      Object.entries(lm).forEach(([dayKey, cell]) => {
        if (!cell.scheduled) return;
        const ld   = _lineData[plant]?.[line]?.[dayKey];
        const avail = ld?.avail_hours != null ? ld.avail_hours : (cell.effectiveCapacity || 0);
        if (cell.scheduled > avail + 0.05) shortfalls++;
      });
    });

    const fmtH = h => h >= 1000 ? `${(h / 1000).toFixed(1)}k` : h.toFixed(0);
    strip.innerHTML = `
      <div class="lp-kpi-tile">
        <span class="lp-kpi-label">Available</span>
        <span class="lp-kpi-val">${fmtH(totalAvail)}h</span>
        <span class="lp-kpi-sub">${_horizonSpan} wk horizon</span>
      </div>
      <div class="lp-kpi-tile">
        <span class="lp-kpi-label">Required</span>
        <span class="lp-kpi-val">${fmtH(totalRequired)}h</span>
        <span class="lp-kpi-sub">from scheduled orders</span>
      </div>
      <div class="lp-kpi-tile${hSev ? ' lp-kpi-' + hSev : ''}">
        <span class="lp-kpi-label">Headroom</span>
        <span class="lp-kpi-val">${headroom}%</span>
        <span class="lp-kpi-sub">${fmtH(Math.abs(diff))}h ${diff >= 0 ? 'surplus' : 'deficit'}</span>
      </div>
      <div class="lp-kpi-tile${shortfalls > 0 ? ' lp-kpi-err' : ''}">
        <span class="lp-kpi-label">Shortfalls</span>
        <span class="lp-kpi-val">${shortfalls}</span>
        <span class="lp-kpi-sub">line·day cells</span>
      </div>`;
  }

  // Per-edit/paste KPI refresh is debounced (R12): the strip rebuilds an
  // O(lines × days) matrix walk, and labor editing fires per keystroke/cell —
  // coalesce rapid edits into one recompute instead of one-per-keystroke.
  const _renderKPIsDebounced = Util.debounce(_renderKPIs, 350);

  // ── Aggregate sub-tab ────────────────────────────────────────────────────
  function _clearSelection() {
    _selRange = null; _dragging = false; _dragAnchor = null;
    _selTds.forEach(td => td.classList.remove('lp-selected-td'));
    _selTds.clear();
  }

  // Incremental lasso paint: diff the new rectangle against the previously
  // highlighted set so each mousemove only touches cells whose membership
  // changed (O(changed)), instead of clearing + re-querying the whole grid.
  function _renderSelection() {
    const next = new Set();
    if (_selRange && _cellGrid) {
      const { r0, c0, r1, c1 } = _selRange;
      for (let r = r0; r <= r1; r++) {
        const row = _cellGrid[r]; if (!row) continue;
        for (let c = c0; c <= c1; c++) { const td = row[c]; if (td) next.add(td); }
      }
    }
    _selTds.forEach(td => { if (!next.has(td)) td.classList.remove('lp-selected-td'); });
    next.forEach(td => { if (!_selTds.has(td)) td.classList.add('lp-selected-td'); });
    _selTds = next;
  }

  function _updateAggrTotals(grid) {
    const plant = Store.selectedPlant; if (!plant || !_aggrData[plant]) return;
    const tds = grid.querySelectorAll('tbody tr:last-child td');
    _weeks.forEach((w, i) => {
      const total = Object.values(_aggrData[plant]).reduce((sum, p) => sum + (p[w.key] ?? 0), 0);
      if (tds[i + 1]) tds[i + 1].textContent = total > 0 ? total.toFixed(1) : '—';
    });
  }

  function _deleteSelected() {
    if (!_selRange) return;
    const plant = Store.selectedPlant; if (!plant) return;
    if (!_aggrData[plant]) _aggrData[plant] = {};
    const { r0, c0, r1, c1 } = _selRange;
    const cleared = [], prev = [];
    const g = document.getElementById('labor-grid');
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const grp = _displayGroups[r]; const period = _weeks[c]?.key; if (!grp || !period) continue;
      prev.push({ pl_group: grp, period, avail_hours: _aggrData[plant]?.[grp]?.[period] ?? null });
      if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
      delete _aggrData[plant][grp][period];
      cleared.push({ pl_group: grp, period, avail_hours: null });
      const inp = g?.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`);
      if (inp) inp.value = '';
    }
    if (!cleared.length) return;
    if (g) _updateAggrTotals(g);
    _clearSelection();
    const sn = _subnetwork(plant);
    UndoStack.push(`Delete ${cleared.length} labor cell${cleared.length !== 1 ? 's' : ''}`, () => {
      if (!_aggrData[plant]) _aggrData[plant] = {};
      prev.forEach(({ pl_group: grp, period, avail_hours: old }) => {
        if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
        if (old == null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = old;
      });
      const g2 = document.getElementById('labor-grid');
      if (g2) {
        prev.forEach(({ pl_group: grp, period, avail_hours: old }) => {
          const el = g2.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`);
          if (el) el.value = old != null ? old : '';
        });
        _updateAggrTotals(g2);
      }
      _saveAggregate(sn, plant, prev);
    });
    _saveAggregate(sn, plant, cleared);
  }

  function _copySelected() {
    if (!_selRange) return;
    const plant = Store.selectedPlant;
    const { r0, c0, r1, c1 } = _selRange;
    const rows = [];
    for (let r = r0; r <= r1; r++) {
      const cols = [];
      for (let c = c0; c <= c1; c++) {
        const grp = _displayGroups[r]; const period = _weeks[c]?.key;
        const ah = grp && period ? (_aggrData[plant]?.[grp]?.[period] ?? null) : null;
        cols.push(ah != null ? String(ah) : '');
      }
      rows.push(cols.join('\t'));
    }
    const count = (r1 - r0 + 1) * (c1 - c0 + 1);
    navigator.clipboard.writeText(rows.join('\n'))
      .then(() => Toast.show(`Copied ${count} cell${count !== 1 ? 's' : ''}`, 'success'))
      .catch(() => Toast.show('Copy failed — check clipboard permissions', 'error'));
  }

  async function _renderAggregate(plant) {
    const grid = document.getElementById('labor-grid'); if (!grid) return;
    const planMap = await _fetchAggregate(plant);
    _displayGroups = _selectedGroups.size ? _groups.filter(g => _selectedGroups.has(g)) : _groups;
    const totals = {}; _weeks.forEach(w => { totals[w.key] = 0; });
    const groupRows = _displayGroups.map(grp => {
      const cells = _weeks.map(w => {
        const ah = planMap[grp]?.[w.key]; if (ah != null) totals[w.key] += ah;
        return `<td>
          <input type="number" class="lp-cell" data-group="${grp.replace(/"/g,'&quot;')}" data-period="${w.key}" min="0" step="0.5" value="${ah != null ? ah : ''}" placeholder="—">
        </td>`;
      }).join('');
      return `<tr><td>${grp}</td>${cells}</tr>`;
    }).join('');
    const totalCells = _weeks.map(w => {
      const v = totals[w.key];
      return `<td>${v > 0 ? v.toFixed(1) : '—'}</td>`;
    }).join('');
    grid.innerHTML = `
      <div class="lp-card lp-card-scroll">
        <table class="lp-table">
          <thead><tr>
            <th>Group</th>
            ${_weeks.map(w => `<th>${w.label}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${groupRows}
            <tr class="lp-total-row">
              <td>TOTAL</td>${totalCells}
            </tr>
          </tbody>
        </table>
      </div>
      <p class="lp-hint">Ctrl+drag to select · Delete to clear · Ctrl+C to copy · Paste from Excel · Values in hours</p>`;

    // Build [row][col] -> <td> cache so the lasso paint never queries the DOM.
    _cellGrid = _displayGroups.map(grp =>
      _weeks.map(w => grid.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${w.key}"]`)?.closest('td') || null));
    _selTds = new Set();

    const sn = _subnetwork(plant);

    // Lasso drag listeners attach once to the persistent #labor-grid element
    // (innerHTML is replaced on every render but the container is not).
    if (!grid._lpDragWired) {
      grid._lpDragWired = true;
      grid.addEventListener('mousedown', e => {
        if (!e.ctrlKey && !e.metaKey) { if (!e.target.closest('.lp-selected-td')) _clearSelection(); return; }
        const inp = e.target.closest('.lp-cell'); if (!inp) return;
        e.preventDefault();
        const ri = _displayGroups.indexOf(inp.dataset.group), ci = _weeks.findIndex(w => w.key === inp.dataset.period);
        if (ri < 0 || ci < 0) return;
        _dragging = true; _dragAnchor = { row: ri, col: ci };
        _selRange = { r0: ri, c0: ci, r1: ri, c1: ci }; _renderSelection();
      });
      grid.addEventListener('mousemove', e => {
        if (!_dragging) return;
        const td = e.target.closest('td'); if (!td) return;
        const inp = td.querySelector('.lp-cell'); if (!inp) return;
        const ri = _displayGroups.indexOf(inp.dataset.group), ci = _weeks.findIndex(w => w.key === inp.dataset.period);
        if (ri < 0 || ci < 0) return;
        _selRange = { r0: Math.min(_dragAnchor.row, ri), c0: Math.min(_dragAnchor.col, ci), r1: Math.max(_dragAnchor.row, ri), c1: Math.max(_dragAnchor.col, ci) };
        _renderSelection();
      });
    }

    grid.querySelectorAll('.lp-cell').forEach(inp => {
      inp.onchange = async function() {
        const grp = this.dataset.group, period = this.dataset.period;
        const raw = this.value.trim();
        const ah  = raw === '' ? null : Math.max(0, parseFloat(raw) || 0);
        if (ah !== null) this.value = ah;
        const oldAh = _aggrData[plant]?.[grp]?.[period] ?? null;
        if (!_aggrData[plant]) _aggrData[plant] = {};
        if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
        if (ah === null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = ah;
        _updateAggrTotals(grid);
        _renderKPIsDebounced(plant);
        if (ah !== null) {
          const splits = _disaggregate(plant, grp, period, ah);
          if (splits.length) {
            if (!_lineData[plant]) _lineData[plant] = {};
            splits.forEach(c => {
              if (!_lineData[plant][c.production_line]) _lineData[plant][c.production_line] = {};
              _lineData[plant][c.production_line][c.day] = { avail_hours: c.avail_hours, source: c.source };
            });
            _saveLines(sn, plant, splits);
          }
        }
        UndoStack.push(`Labor: ${grp} / ${period}`, () => {
          if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
          if (oldAh == null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = oldAh;
          const el = document.getElementById('labor-grid')?.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`);
          if (el) el.value = oldAh != null ? oldAh : '';
          _updateAggrTotals(document.getElementById('labor-grid'));
          _saveAggregate(sn, plant, [{ pl_group: grp, period, avail_hours: oldAh }]);
        });
        await _saveAggregate(sn, plant, [{ pl_group: grp, period, avail_hours: ah }]);
      };
    });

    const table = grid.querySelector('table');
    if (table) table.addEventListener('paste', async e => {
      const anchor = document.activeElement?.classList.contains('lp-cell') ? document.activeElement : null;
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain'); if (!text) return;
      const clipRows = text.replace(/\r/g, '').split('\n').filter(r => r !== '').map(r => r.split('\t'));
      const cellMatrix = _displayGroups.map(grp => _weeks.map(w => grid.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${w.key}"]`)));
      let anchorRow = 0, anchorCol = 0;
      if (anchor) {
        anchorRow = Math.max(0, _displayGroups.indexOf(anchor.dataset.group));
        anchorCol = Math.max(0, _weeks.findIndex(w => w.key === anchor.dataset.period));
      }
      if (!_aggrData[plant]) _aggrData[plant] = {};
      const changed = [], prev = [], allSplits = [];
      clipRows.forEach((clipCols, r) => {
        clipCols.forEach((val, c) => {
          const ri = anchorRow + r, ci = anchorCol + c;
          if (ri >= _displayGroups.length || ci >= _weeks.length) return;
          const inp = cellMatrix[ri]?.[ci]; if (!inp) return;
          const raw = val.trim().replace(/,/g, '');
          const ah  = raw === '' ? null : parseFloat(raw);
          if (ah !== null && (isNaN(ah) || ah < 0)) return;
          const grp = inp.dataset.group, period = inp.dataset.period;
          prev.push({ pl_group: grp, period, avail_hours: _aggrData[plant]?.[grp]?.[period] ?? null });
          inp.value = ah !== null ? ah : '';
          if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
          if (ah === null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = ah;
          changed.push({ pl_group: grp, period, avail_hours: ah });
          if (ah !== null) allSplits.push(..._disaggregate(plant, grp, period, ah));
        });
      });
      if (!changed.length) return;
      _updateAggrTotals(grid); _renderKPIsDebounced(plant);
      if (allSplits.length) {
        if (!_lineData[plant]) _lineData[plant] = {};
        allSplits.forEach(c => {
          if (!_lineData[plant][c.production_line]) _lineData[plant][c.production_line] = {};
          _lineData[plant][c.production_line][c.day] = { avail_hours: c.avail_hours, source: c.source };
        });
        _saveLines(sn, plant, allSplits);
      }
      UndoStack.push(`Undo paste (${changed.length} labor value${changed.length !== 1 ? 's' : ''})`, () => {
        if (!_aggrData[plant]) _aggrData[plant] = {};
        prev.forEach(({ pl_group: grp, period, avail_hours: old }) => {
          if (!_aggrData[plant][grp]) _aggrData[plant][grp] = {};
          if (old == null) delete _aggrData[plant][grp][period]; else _aggrData[plant][grp][period] = old;
        });
        const g = document.getElementById('labor-grid');
        if (g) {
          prev.forEach(({ pl_group: grp, period, avail_hours: old }) => {
            const el = g.querySelector(`.lp-cell[data-group="${grp.replace(/"/g,'&quot;')}"][data-period="${period}"]`);
            if (el) el.value = old != null ? old : '';
          });
          _updateAggrTotals(g);
        }
        _saveAggregate(sn, plant, prev);
      });
      Toast.show(`Pasted ${changed.length} value${changed.length !== 1 ? 's' : ''}`, 'success');
      await _saveAggregate(sn, plant, changed);
    });
  }

  // ── Line Plan sub-tab ────────────────────────────────────────────────────
  async function _renderLinePlan(plant) {
    const grid = document.getElementById('labor-line-grid'); if (!grid) return;
    // Show all groups unless user has filtered to specific ones
    const visibleGroups = _displayGroups.length ? _displayGroups : _groups;
    const fetchGroup = _selectedGroups.size === 1 ? [..._selectedGroups][0] : null;
    const allLinesMeta = Store.masterLinesForPlant(plant)
      .filter(l => visibleGroups.includes(l.pl_group))
      .sort((a, b) => visibleGroups.indexOf(a.pl_group) - visibleGroups.indexOf(b.pl_group) || a.production_line.localeCompare(b.production_line));
    if (!allLinesMeta.length) {
      grid.innerHTML = `<div class="empty-state" style="padding:40px 0;">${Util.t('empty.no_production_lines_plant')}</div>`; return;
    }
    await _fetchLines(plant, fetchGroup);

    // Build day columns
    const days = [];
    _weeks.forEach(w => {
      for (let d = 0; d < 7; d++) {
        const date = new Date(w.monday); date.setDate(w.monday.getDate() + d);
        days.push({ date, dayKey: Util.dayKey(date), weekKey: w.key });
      }
    });

    const horizonStart = _weeks[0].monday;
    const utilMatrix   = Utilization.computeMatrix(horizonStart, Math.min(_horizonSpan * 7, 84));
    const sn = _subnetwork(plant);

    const isDark = document.body.classList.contains('dark');
    function lerpRGB(a, b, t) {
      const p = h => [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
      const ca = p(a), cb = p(b);
      return `rgb(${Math.round(ca[0]+(cb[0]-ca[0])*t)},${Math.round(ca[1]+(cb[1]-ca[1])*t)},${Math.round(ca[2]+(cb[2]-ca[2])*t)})`;
    }
    const idle = isDark ? '#252730' : '#ede8de', low = isDark ? '#7a5a18' : '#c8a95a',
          mid  = isDark ? '#a8520f' : '#c96a1a', hot = isDark ? '#b32a1f' : '#991b1b';
    function heatBg(ratio) {
      if (ratio <= 0)   return idle;
      if (ratio <= 0.5) return lerpRGB(idle, low, ratio / 0.5);
      if (ratio <= 1.0) return lerpRGB(low, mid, (ratio - 0.5) / 0.5);
      return lerpRGB(mid, hot, Math.min((ratio - 1.0) / 0.25, 1));
    }

    const weekStarts = new Set(_weeks.map(w => Util.dayKey(w.monday)));

    const dayHeaders = days.map(d => {
      const wb = weekStarts.has(d.dayKey) ? 'border-left:2px solid var(--accent-soft);' : '';
      return `<th style="width:52px;min-width:52px;${wb}">${d.date.getMonth()+1}/${d.date.getDate()}</th>`;
    }).join('');

    const showGroupHeaders = visibleGroups.length > 1;
    let lastGroup = null;
    // Memoize calendar capacity per (line|dayKey) for this render pass — the same
    // line/date pair is otherwise recomputed across every row build.
    const _capMemo = new Map();
    const _capFor = (line, date, dayKey) => {
      const k = line + '|' + dayKey;
      let v = _capMemo.get(k);
      if (v === undefined) { v = Calendar.effectiveCapacityHours(line, date); _capMemo.set(k, v); }
      return v;
    };
    const lineRows = allLinesMeta.map(lm => {
      const line = lm.production_line;
      let groupRow = '';
      if (showGroupHeaders && lm.pl_group !== lastGroup) {
        lastGroup = lm.pl_group;
        groupRow = `<tr><td class="lp-group-hdr" colspan="${days.length + 1}">${lm.pl_group}</td></tr>`;
      }
      const cells = days.map(d => {
        const wb   = weekStarts.has(d.dayKey) ? 'border-left:2px solid var(--accent-soft);' : '';
        const ld   = _lineData[plant]?.[line]?.[d.dayKey];
        const calCap = _capFor(line, d.date, d.dayKey);
        const avail  = ld?.avail_hours != null ? ld.avail_hours : calCap;
        const req    = utilMatrix[line]?.[d.dayKey]?.scheduled || 0;
        const ratio  = avail > 0 ? req / avail : (req > 0 ? 2 : 0);
        const bg     = avail === 0 ? 'var(--bg-subtle)' : heatBg(ratio);
        const isOvr  = ld?.source === 'override';
        const title  = `${line} · ${d.dayKey} | Available: ${avail.toFixed(1)}h | Required: ${req.toFixed(1)}h | Cal cap: ${calCap.toFixed(1)}h${isOvr ? ' | Pinned' : ''}`;
        return `<td class="${isOvr ? 'lp-ovr' : ''}" style="${wb}background:${bg};padding:3px 4px;" title="${title}">
          <input type="number" class="lp-line-cell" data-line="${line.replace(/"/g,'&quot;')}" data-day="${d.dayKey}" min="0" step="0.5"
            value="${avail > 0 ? avail : ''}"></td>`;
      }).join('');
      return groupRow + `<tr><td>${line}</td>${cells}</tr>`;
    }).join('');

    grid.innerHTML = `
      <div class="lp-card lp-card-scroll">
        <table class="lp-table">
          <thead><tr><th>Line</th>${dayHeaders}</tr></thead>
          <tbody>${lineRows}</tbody>
        </table>
      </div>`;

    // Sticky group headers: offset by actual thead height so they dock below column headers
    const theadH = grid.querySelector('thead tr')?.offsetHeight || 27;
    grid.querySelectorAll('.lp-group-hdr').forEach(td => { td.style.top = theadH + 'px'; });

    // Delegated handlers on the grid container — one 'change' + one 'contextmenu'
    // listener instead of two per cell (scales to thousands of line-day cells).
    grid.onchange = async function(e) {
      const inp = e.target.closest('.lp-line-cell'); if (!inp) return;
      const line = inp.dataset.line, day = inp.dataset.day;
      const raw  = inp.value.trim();
      const ah   = raw === '' ? null : Math.max(0, parseFloat(raw) || 0);
      if (ah !== null) inp.value = ah;
      if (!_lineData[plant]) _lineData[plant] = {};
      if (!_lineData[plant][line]) _lineData[plant][line] = {};
      const old    = _lineData[plant][line][day];
      const oldAh  = old?.avail_hours ?? null, oldSrc = old?.source ?? 'auto_split';
      const newSrc = ah !== null ? 'override' : 'auto_split';
      if (ah === null) delete _lineData[plant][line][day]; else _lineData[plant][line][day] = { avail_hours: ah, source: 'override' };
      const td = inp.closest('td');
      if (td) td.classList.toggle('lp-ovr', ah !== null);
      UndoStack.push(`Line plan: ${line} / ${day}`, () => {
        if (!_lineData[plant][line]) _lineData[plant][line] = {};
        if (oldAh == null) delete _lineData[plant][line][day]; else _lineData[plant][line][day] = { avail_hours: oldAh, source: oldSrc };
        const el = grid.querySelector(`.lp-line-cell[data-line="${line.replace(/"/g,'&quot;')}"][data-day="${day}"]`);
        if (el) el.value = oldAh != null ? oldAh : '';
        _saveLines(sn, plant, [{ production_line: line, day, avail_hours: oldAh, source: oldSrc }]);
      });
      await _saveLines(sn, plant, [{ production_line: line, day, avail_hours: ah, source: newSrc }]);
    };

    grid.oncontextmenu = function(e) {
      const inp = e.target.closest('.lp-line-cell'); if (!inp) return;
      e.preventDefault();
      const line = inp.dataset.line, day = inp.dataset.day;
      if (_lineData[plant]?.[line]?.[day]?.source !== 'override') return;
      const grp = (Store._state.masterData?.lines || []).find(l => l.production_line === line && l.plant === plant)?.pl_group;
      if (!grp) return;
      const periodKey = _weeks.find(w => {
        for (let d = 0; d < 7; d++) { const dd = new Date(w.monday); dd.setDate(w.monday.getDate() + d); if (Util.dayKey(dd) === day) return true; }
      })?.key;
      if (!periodKey) return;
      const groupHours = _aggrData[plant]?.[grp]?.[periodKey]; if (groupHours == null) return;
      const splits = _disaggregate(plant, grp, periodKey, groupHours);
      const resetCell = splits.find(c => c.production_line === line && c.day === day); if (!resetCell) return;
      _lineData[plant][line][day] = { avail_hours: resetCell.avail_hours, source: 'auto_split' };
      inp.value = resetCell.avail_hours || '';
      inp.closest('td')?.classList.remove('lp-ovr');
      _saveLines(sn, plant, [{ production_line: line, day, avail_hours: resetCell.avail_hours, source: 'auto_split' }]);
      Toast.show(`Reset ${line} · ${day} to even-split`, 'success');
    };
  }

  // ── Capacity sub-tab ─────────────────────────────────────────────────────
  async function _renderCapacity(plant) {
    const container = document.getElementById('labor-capacity-grid'); if (!container) return;
    const scopeGroup = _selectedGroups.size === 1 ? [..._selectedGroups][0] : null;
    await _fetchLines(plant, scopeGroup);
    const lines = Store.masterLinesForPlant(plant)
      .filter(l => !scopeGroup || l.pl_group === scopeGroup)
      .map(l => l.production_line).sort();
    if (!lines.length) { container.innerHTML = `<div class="empty-state" style="padding:40px 0;">${Util.t('empty.no_production_lines_plant')}</div>`; return; }

    const horizonStart = _weeks[0].monday;
    const utilMatrix   = Utilization.computeMatrix(horizonStart, Math.min(_horizonSpan * 7, 84));
    const displayDays  = Math.min(14, _horizonSpan * 7);
    const days = [];
    for (let i = 0; i < displayDays; i++) {
      const d = new Date(horizonStart); d.setDate(horizonStart.getDate() + i);
      days.push({ date: d, dayKey: Util.dayKey(d) });
    }

    const isDark = document.body.classList.contains('dark');
    function lerpRGB(a, b, t) {
      const p = h => [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
      const ca = p(a), cb = p(b);
      return `rgb(${Math.round(ca[0]+(cb[0]-ca[0])*t)},${Math.round(ca[1]+(cb[1]-ca[1])*t)},${Math.round(ca[2]+(cb[2]-ca[2])*t)})`;
    }
    const idle = isDark ? '#252730' : '#ede8de', low = isDark ? '#7a5a18' : '#c8a95a',
          mid  = isDark ? '#a8520f' : '#c96a1a', hot = isDark ? '#b32a1f' : '#991b1b';
    function heatBg(ratio) {
      if (ratio <= 0)   return idle;
      if (ratio <= 0.5) return lerpRGB(idle, low, ratio / 0.5);
      if (ratio <= 1.0) return lerpRGB(low, mid, (ratio - 0.5) / 0.5);
      return lerpRGB(mid, hot, Math.min((ratio - 1.0) / 0.25, 1));
    }
    function heatText(ratio) { return isDark ? (ratio <= 0 ? '#8f909d' : '#fff') : (ratio < 0.45 ? '#3d3628' : '#fff'); }

    const cols = `100px repeat(${days.length}, 1fr)`;
    let html = `<div class="lp-card" style="padding:14px 16px;">
      <p class="lp-cap-note">Req/Avail hours · first ${displayDays} days${scopeGroup ? ' · Group: ' + scopeGroup : ''}</p>
      <div class="lp-hm-wrap"><div class="lp-hm-grid" style="grid-template-columns:${cols}">`;
    html += `<div class="lp-hm-corner"></div>`;
    days.forEach(d => {
      const dow = d.date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
      html += `<div class="lp-hm-head"><span class="lp-hm-dow">${dow}</span><span class="lp-hm-date">${d.date.getMonth()+1}/${d.date.getDate()}</span></div>`;
    });
    lines.forEach((line, li) => {
      const dot = Config.COLORS[li % Config.COLORS.length];
      html += `<div class="lp-hm-label"><span class="lp-hm-dot" style="background:${dot}"></span>${line}</div>`;
      days.forEach(d => {
        const req    = utilMatrix[line]?.[d.dayKey]?.scheduled || 0;
        const ld     = _lineData[plant]?.[line]?.[d.dayKey];
        const calCap = utilMatrix[line]?.[d.dayKey]?.effectiveCapacity || 0;
        const avail  = ld?.avail_hours != null ? ld.avail_hours : calCap;
        const ratio  = avail > 0 ? req / avail : (req > 0 ? 2 : 0);
        const bg     = heatBg(ratio), tc = heatText(ratio);
        const lbl    = avail > 0 ? `${req.toFixed(0)}/${avail.toFixed(0)}` : '—';
        html += `<div class="lp-hm-cell" style="background:${bg};color:${tc};" title="${line} · ${d.dayKey} | Req: ${req.toFixed(1)}h | Avail: ${avail.toFixed(1)}h | ${Math.round(ratio*100)}%">${lbl}</div>`;
      });
    });
    html += `</div></div><div class="lp-hm-legend"><span>idle</span><div class="lp-hm-grad"></div><span>overload</span></div></div>`;
    container.innerHTML = html;
  }

  // ── Exceptions sub-tab ───────────────────────────────────────────────────
  async function _renderExceptions(plant) {
    const container = document.getElementById('labor-exceptions-list'); if (!container) return;
    await _fetchLines(plant, null);
    const lines = (Store._state.masterData?.lines || []).filter(l => l.plant === plant).map(l => l.production_line);
    const horizonStart = _weeks[0].monday;
    const utilMatrix   = Utilization.computeMatrix(horizonStart, Math.min(_horizonSpan * 7, 84));
    const exceptions = [];
    lines.forEach(line => {
      const lm = utilMatrix[line]; if (!lm) return;
      Object.entries(lm).forEach(([dayKey, cell]) => {
        if (!cell.scheduled && !cell.capacity) return;
        const ld    = _lineData[plant]?.[line]?.[dayKey];
        const avail = ld?.avail_hours != null ? ld.avail_hours : (cell.effectiveCapacity || 0);
        const req   = cell.scheduled || 0, calCap = cell.capacity || 0;
        if (req > avail + 0.05 && req > 0)
          exceptions.push({ sev: 'err',  line, day: dayKey, msg: `${req.toFixed(1)}h required, ${avail.toFixed(1)}h available — ${(req - avail).toFixed(1)}h short` });
        else if (avail > calCap + 0.05 && calCap > 0)
          exceptions.push({ sev: 'warn', line, day: dayKey, msg: `${avail.toFixed(1)}h planned exceeds ${calCap.toFixed(1)}h calendar capacity` });
      });
    });
    exceptions.sort((a, b) => (a.sev === 'err' ? -1 : 1) - (b.sev === 'err' ? -1 : 1) || a.day.localeCompare(b.day));

    const badge = document.getElementById('labor-exc-badge');
    if (badge) { badge.textContent = exceptions.length; badge.hidden = exceptions.length === 0; }

    if (!exceptions.length) {
      container.innerHTML = `<div class="empty-state" style="padding:40px 0;">✓ No exceptions in the current horizon.</div>`; return;
    }
    const rows = exceptions.map(ex => `
      <div class="lp-exc-row lp-exc-${ex.sev}">
        <span class="lp-exc-sev">${ex.sev === 'err' ? '▲' : '⚠'}</span>
        <span class="lp-exc-line">${ex.line}</span>
        <span class="lp-exc-day">${ex.day}</span>
        <span class="lp-exc-msg">${ex.msg}</span>
        <button class="btn btn-sm lp-exc-fix" onclick="NIMBUS.App.gotoLaborSub('line-plan')">Line Plan →</button>
      </div>`).join('');
    container.innerHTML = `<div class="lp-exc-summary">${exceptions.length} exception${exceptions.length !== 1 ? 's' : ''}</div><div class="lp-exc-list">${rows}</div>`;
  }

  // ── Inputs sub-tab ───────────────────────────────────────────────────────
  function _renderInputs() {
    const container = document.getElementById('labor-inputs-pane'); if (!container) return;
    container.innerHTML = `
      <div class="lp-inputs-section">
        <h3 class="lp-inputs-title">Disaggregation</h3>
        <div class="lp-input-row">
          <label class="lp-input-label">Default split mode</label>
          <select class="lp-input-sel"><option selected>Even split (equal hours per open day)</option></select>
          <span class="lp-input-hint">Aggregate group/week hours divide evenly across each line's open working days. Right-click any Line Plan cell to reset an override to even-split.</span>
        </div>
      </div>
      <div class="lp-inputs-section">
        <h3 class="lp-inputs-title">Horizon</h3>
        <div class="lp-input-row">
          <label class="lp-input-label">Week span</label>
          <select class="lp-input-sel" onchange="NIMBUS.LaborPlanning.setSpan(+this.value)">
            <option value="4" ${_horizonSpan===4?'selected':''}>4 weeks</option>
            <option value="8" ${_horizonSpan===8?'selected':''}>8 weeks</option>
            <option value="12" ${_horizonSpan===12?'selected':''}>12 weeks</option>
            <option value="16" ${_horizonSpan===16?'selected':''}>16 weeks</option>
          </select>
        </div>
      </div>
      <div class="lp-inputs-section">
        <h3 class="lp-inputs-title">Aggregate ↔ Line reconciliation</h3>
        <p style="font-size:12px;color:var(--fg-mute);margin:0;">When aggregate hours are saved, the system auto-splits to lines via even split across open working days. Overridden line·day cells are pinned (●) and do not re-split until manually reset.</p>
      </div>`;
  }

  // ── Toolbar update ───────────────────────────────────────────────────────
  function _renderToolbar(plant) {
    // Group multi-select button label
    const lbl = document.getElementById('lp-group-label');
    if (lbl) {
      if (_selectedGroups.size === 0)           lbl.textContent = 'All Groups';
      else if (_selectedGroups.size === 1)      lbl.textContent = [..._selectedGroups][0];
      else                                      lbl.textContent = `${_selectedGroups.size} groups`;
    }
    // Rebuild dropdown checkboxes (keeps checked state in sync)
    const drop = document.getElementById('lp-group-dropdown');
    if (drop) {
      drop.innerHTML =
        `<div class="lp-group-scroll">` +
        _groups.map(g => `
          <label class="lp-group-chk-row">
            <input type="checkbox" value="${g.replace(/"/g,'&quot;')}"${_selectedGroups.has(g) ? ' checked' : ''}
              onchange="NIMBUS.LaborPlanning.onGroupToggle(this.value,this.checked)">
            ${g}
          </label>`).join('') +
        `</div>
        <div class="lp-group-chk-footer">
          <button class="btn btn-sm" onclick="NIMBUS.LaborPlanning.clearGroupFilter()">Clear</button>
        </div>`;
    }
    // Flatpickr date-jump: lazily init, then sync to current horizon start
    if (_weeks.length) {
      if (!_fpHorizon) {
        _fpHorizon = flatpickr('#labor-horizon-input', {
          dateFormat: 'M j, Y',
          onChange(dates) {
            if (!dates[0]) return;
            const now = new Date();
            const todayMon = new Date(now);
            todayMon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
            _horizonOffset = Math.round((dates[0] - todayMon) / (7 * Config.MS_DAY));
            render();
          },
        });
      }
      _fpHorizon.setDate(_weeks[0].monday, false);
    }
    const badge = document.getElementById('labor-plant-badge');
    if (badge) badge.textContent = plant || '—';
  }

  // ── Main render ──────────────────────────────────────────────────────────
  async function render() {
    _weeks = _computeWeeks();
    const plant = Store.selectedPlant;
    if (!plant) {
      ['labor-grid','labor-line-grid','labor-capacity-grid','labor-exceptions-list','labor-inputs-pane'].forEach(id => {
        const el = document.getElementById(id); if (el) el.innerHTML = '';
      });
      const grid = document.getElementById('labor-grid');
      if (grid) grid.innerHTML = `<div class="empty-state" style="padding:40px 0;">${Util.t('ui.select_plant_labor')}</div>`;
      document.getElementById('labor-plant-badge')?.setAttribute && (document.getElementById('labor-plant-badge').textContent = '—');
      document.getElementById('labor-kpi-strip') && (document.getElementById('labor-kpi-strip').innerHTML = '');
      return;
    }
    const mdLines = (Store._state.masterData?.lines || []).filter(r => r.plant === plant);
    _groups = [...new Set(mdLines.map(r => r.pl_group).filter(Boolean))].sort();
    if (!_groups.length) {
      const grid = document.getElementById('labor-grid');
      if (grid) grid.innerHTML = `<div class="empty-state" style="padding:40px 0;">${Util.t('empty.no_line_groups_plant')}</div>`;
      return;
    }
    _renderToolbar(plant);
    _renderKPIs(plant);
    const sub = _activeTabResolvers.laborSub() || 'aggregate';
    if (sub === 'aggregate')   await _renderAggregate(plant);
    else if (sub === 'line-plan')  await _renderLinePlan(plant);
    else if (sub === 'capacity')   await _renderCapacity(plant);
    else if (sub === 'exceptions') await _renderExceptions(plant);
    else if (sub === 'inputs')     _renderInputs();
  }

  function _onLPKeyDown(e) {
    if (!_selRange || _activeTabResolvers.currentTab() !== 'labor') return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); _clearSelection(); return; }
    if (e.key === 'Delete' || (e.key === 'Backspace' && !e.target?.classList.contains('lp-cell'))) {
      e.preventDefault(); e.stopImmediatePropagation(); _deleteSelected(); return;
    }
    if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); e.stopImmediatePropagation(); _copySelected(); return; }
  }

  function init() {
    document.addEventListener('keydown', _onLPKeyDown, { capture: true });
    document.addEventListener('mouseup', () => { _dragging = false; });
    Store.subscribe(evt => {
      if ((evt.type === 'plant:selected' || evt.type === 'master-data-changed') && _activeTabResolvers.currentTab() === 'labor') {
        if (evt.type === 'plant:selected') { delete _aggrData[evt.plant]; delete _lineData[evt.plant]; }
        render();
      }
    }, 'Labor');
  }

  return {
    init, render,
    onGroupToggle(group, checked) {
      if (checked) _selectedGroups.add(group); else _selectedGroups.delete(group);
      _renderToolbar(Store.selectedPlant || '');
      const plant = Store.selectedPlant; if (!plant) return;
      const sub = _activeTabResolvers.laborSub();
      if (sub === 'aggregate')       _renderAggregate(plant);
      else if (sub === 'line-plan')  _renderLinePlan(plant);
      else if (sub === 'capacity')   _renderCapacity(plant);
      else if (sub === 'exceptions') _renderExceptions(plant);
    },
    clearGroupFilter() {
      _selectedGroups.clear();
      _renderToolbar(Store.selectedPlant || '');
      const plant = Store.selectedPlant; if (!plant) return;
      const sub = _activeTabResolvers.laborSub();
      if (sub === 'aggregate')       _renderAggregate(plant);
      else if (sub === 'line-plan')  _renderLinePlan(plant);
      else if (sub === 'capacity')   _renderCapacity(plant);
      else if (sub === 'exceptions') _renderExceptions(plant);
    },
    toggleGroupDropdown(e) {
      e?.stopPropagation();
      const drop = document.getElementById('lp-group-dropdown');
      if (!drop) return;
      drop.hidden = !drop.hidden;
      if (!drop.hidden) {
        const close = ev => { if (!drop.contains(ev.target) && ev.target.id !== 'lp-group-btn') { drop.hidden = true; document.removeEventListener('click', close); } };
        setTimeout(() => document.addEventListener('click', close), 0);
      }
    },
    prevHorizon() { _horizonOffset -= _horizonSpan; render(); },
    nextHorizon() { _horizonOffset += _horizonSpan; render(); },
    setSpan(n) {
      _horizonSpan = n;
      const sel = document.getElementById('labor-span-sel'); if (sel) sel.value = n;
      render();
    },
  };
})();

/* =============================================================================
   MASTER DATA — Manage Data Tables admin sub-tab UI (Subnetwork / Plant / Production Line)
   ========================================================================== */
export const MasterData = (() => {
  const API = Config.API_BASE;
  let _activeTable = 'subnetworks';
  // Per-table state: { columns, rows, dirty: Map(rowKey→patch), deleted: Set(rowKey), added: [] }
  const _cache = {};

  const TABLE_LABELS = {
    subnetworks:      'Subnetworks',
    plants:           'Plants',
    production_lines: 'Production Lines',
    materials:        'Material',
    material_plants:  'Material Plant',
    bom_items:        'Bill of Materials',
  };

  // KEY_COLS drives primary-key identification per table.
  const KEY_COLS = {
    subnetworks:      ['code'],
    plants:           ['subnetwork', 'plant'],
    production_lines: ['subnetwork', 'plant', 'production_line'],
    materials:        ['material_id'],
    material_plants:  ['material_id', 'plant'],
    bom_items:        ['material_id', 'plant', 'alternative_bom', 'level', 'item_number', 'component_id'],
  };

  // Tables that need a parent-dropdown for FK columns.
  const FK_SOURCE = {
    plants:           { subnetwork: 'subnetworks' },
    production_lines: { subnetwork: 'subnetworks', plant: 'plants' },
    material_plants:  { material_id: 'materials' },
    // bom_items.component_id is deliberately NOT registered here: it needs a
    // plant-scoped option list (material_plants filtered to the row's plant),
    // which the generic _fkSelect (whole-source-table, single-key convention)
    // can't express. See the bom_items special case in _appendRow instead.
  };

  // bom_items requires a plant + material pick before the grid loads (its
  // table is expected to be huge — one row per component per level per
  // material — unlike every other MasterData table, which loads in full).
  let _bomFilter = { plant: null, material_id: null };

  function _rowKey(table, row) {
    return KEY_COLS[table].map(k => String(row[k] ?? '')).join('|');
  }

  function _parsePaste(rawText, columns) {
    const lines = rawText.replace(/\r/g, '').split('\n').filter(l => l.trim());
    if (!lines.length) return { rows: [] };
    const colNames  = columns.map(c => c.column_name.toLowerCase());
    const colLabels = columns.map(c => (c.display_label || c.column_name).toLowerCase());
    const first     = lines[0].split('\t').map(h => h.trim().toLowerCase());
    const hasHeader = first.some(h => colNames.includes(h) || colLabels.includes(h));
    let headers, dataLines;
    if (hasHeader) {
      headers   = first.map(h => {
        const ni = colNames.indexOf(h);
        if (ni >= 0) return columns[ni].column_name;
        const li = colLabels.indexOf(h);
        return li >= 0 ? columns[li].column_name : h;
      });
      dataLines = lines.slice(1);
    } else {
      headers   = columns.map(c => c.column_name);
      dataLines = lines;
    }
    const rows = dataLines.map(line => {
      const vals = line.split('\t');
      const row  = {};
      headers.forEach((h, i) => { row[h] = (vals[i] ?? '').trim(); });
      return row;
    });
    return { rows };
  }

  // -----------------------------------------------------------------------
  // Public entry point
  // -----------------------------------------------------------------------
  function render() {
    // Wire inner tabs on first call.
    document.querySelectorAll('.md-tab').forEach(b => {
      b.onclick = () => _setTab(b.dataset.mdTab);
    });
    const exportBtn = document.getElementById('md-export-schema-btn');
    if (exportBtn) exportBtn.onclick = _exportSchema;
    _syncTabUI();
    _renderActiveTable();
  }

  function _setTab(table) {
    _activeTable = table;
    _syncTabUI();
    _renderActiveTable();
  }

  function _syncTabUI() {
    document.querySelectorAll('.md-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.mdTab === _activeTable));
  }

  // bom_items never loads unscoped (its table is expected to be huge) — show
  // the plant+material picker gate until both are chosen, same as every
  // other tab shows its grid immediately.
  function _renderActiveTable() {
    if (_activeTable === 'bom_items' && !(_bomFilter.plant && _bomFilter.material_id)) {
      _renderBomGate();
    } else {
      _loadAndRender(_activeTable);
    }
  }

  // -----------------------------------------------------------------------
  // BOM plant + material scope gate
  // -----------------------------------------------------------------------
  function _renderBomGate() {
    const host = document.getElementById('md-host');
    if (!host) return;
    host.innerHTML = `
      <div class="md-bom-gate">
        <p class="md-bom-gate-hint">${Util.t('hint.bom_pick_scope')}</p>
        <div class="md-bom-gate-row">
          <label>${Util.t('ui.plant_label')}</label>
          <div id="md-bom-plant-picker"></div>
        </div>
        <div class="md-bom-gate-row">
          <label>${Util.t('col.material')}</label>
          <div id="md-bom-material-picker"></div>
        </div>
      </div>`;
    const plants = Store.knownPlants ? Store.knownPlants() : [];
    _mkCombobox(document.getElementById('md-bom-plant-picker'), plants, {
      value: _bomFilter.plant || '',
      placeholder: Util.t('ph.select_plant'),
      onSelect: (p) => {
        _bomFilter = { plant: p || null, material_id: null };
        _renderBomGate();
      },
    });
    if (_bomFilter.plant) _loadBomMaterialsForPlant(_bomFilter.plant);
  }

  async function _loadBomMaterialsForPlant(plant) {
    const matHost = document.getElementById('md-bom-material-picker');
    if (matHost) matHost.innerHTML = `<div class="md-loading-inline">${Util.t('ui.loading')}</div>`;
    try {
      const data = await Util.fetchTraced(`${API}/master-data/material_plants?${new URLSearchParams({ plant }).toString()}`)
        .then(r => r.json());
      const materials = (data.rows || []).map(r => r.material_id).sort();
      const host2 = document.getElementById('md-bom-material-picker');
      if (!host2) return; // tab/plant changed again while this was in flight
      _mkCombobox(host2, materials, {
        value: _bomFilter.material_id || '',
        placeholder: Util.t('ph.select_material'),
        onSelect: (m) => {
          _bomFilter.material_id = m || null;
          if (m) _loadAndRender('bom_items');
        },
      });
    } catch (e) {
      if (matHost) matHost.innerHTML = `<div class="md-empty">${Util.t('err.load_materials_failed')}</div>`;
      ErrorLog.error('master-data', `Failed to load materials for plant ${plant}: ${e.message}`);
    }
  }

  // Minimal self-contained searchable combobox — reuses the topbar
  // PlantSelector's markup/CSS classes (hps-*) for visual consistency and
  // the same type-to-filter/keyboard-nav interaction, but works off a plain
  // options array with no Store dependency, so it fits BOM's plant AND
  // material pickers (PlantSelector itself is wired one-to-one to
  // Store.selectedPlant and the global topbar DOM).
  function _mkCombobox(containerEl, options, { value = '', placeholder = '', onSelect } = {}) {
    if (!containerEl) return;
    containerEl.innerHTML = `
      <div class="hps-combobox md-bom-combobox">
        <input type="text" class="hps-input" placeholder="${placeholder}" autocomplete="off" spellcheck="false"
               aria-haspopup="listbox" aria-expanded="false">
        <button type="button" class="hps-clear" hidden>&times;</button>
        <div class="hps-dropdown" role="listbox" hidden></div>
      </div>`;
    const root      = containerEl.querySelector('.hps-combobox');
    const input     = root.querySelector('.hps-input');
    const clearBtn  = root.querySelector('.hps-clear');
    const dropdown  = root.querySelector('.hps-dropdown');
    let filtered  = [];
    let activeIdx = -1;
    let open      = false;
    let selected  = value;

    function reflect() {
      input.value = selected || '';
      root.classList.toggle('has-value', !!selected);
      clearBtn.hidden = !selected;
    }
    function renderDropdown(query) {
      const q = (query || '').trim().toLowerCase();
      const looksLikeLabel = selected && String(query).trim().toLowerCase() === String(selected).toLowerCase();
      const filterQ = looksLikeLabel ? '' : q;
      filtered = filterQ ? options.filter(o => String(o).toLowerCase().includes(filterQ)) : options.slice();
      if (!filtered.length) {
        dropdown.innerHTML = `<div class="hps-empty">${options.length ? Util.t('ui.no_matches') : Util.t('ui.no_options')}</div>`;
        activeIdx = -1;
        return;
      }
      dropdown.innerHTML = filtered.map((o, i) =>
        `<div class="hps-option${o === selected ? ' selected' : ''}" role="option" data-idx="${i}">${o}</div>`
      ).join('');
      activeIdx = Math.max(0, filtered.indexOf(selected));
      highlight();
      dropdown.querySelectorAll('.hps-option').forEach((el, i) => {
        el.addEventListener('mousedown', e => { e.preventDefault(); pick(filtered[i]); });
      });
    }
    function highlight() {
      const items = dropdown.querySelectorAll('.hps-option');
      items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
      if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: 'nearest' });
    }
    function openDd()  { dropdown.hidden = false; open = true;  input.setAttribute('aria-expanded', 'true'); }
    function closeDd() { dropdown.hidden = true;  open = false; activeIdx = -1; input.setAttribute('aria-expanded', 'false'); }
    function pick(o) {
      selected = o;
      reflect();
      closeDd();
      input.blur();
      if (onSelect) onSelect(o);
    }

    input.addEventListener('focus', () => { renderDropdown(input.value); openDd(); });
    input.addEventListener('input', () => { renderDropdown(input.value); openDd(); });
    input.addEventListener('keydown', e => {
      if (!open) {
        if (e.key === 'ArrowDown' || e.key === 'Enter') { renderDropdown(input.value); openDd(); e.preventDefault(); }
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, filtered.length - 1); highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); highlight(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (filtered[activeIdx]) pick(filtered[activeIdx]); }
      else if (e.key === 'Escape') { closeDd(); reflect(); input.blur(); }
    });
    input.addEventListener('blur', () => { setTimeout(() => { closeDd(); reflect(); }, 120); });
    clearBtn.addEventListener('mousedown', e => e.preventDefault());
    clearBtn.addEventListener('click', () => { selected = ''; reflect(); if (onSelect) onSelect(''); input.focus(); });
    document.addEventListener('click', e => { if (!root.contains(e.target)) closeDd(); });

    reflect();
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------
  async function _loadAndRender(table) {
    const host = document.getElementById('md-host');
    if (!host) return;
    host.innerHTML = `<div class="md-loading">${Util.t('ui.loading')}</div>`;
    const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    // bom_items is the one table that must never load in full — always scope
    // the request to the plant + material the user picked via the gate.
    const qs = table === 'bom_items'
      ? `?${new URLSearchParams({ plant: _bomFilter.plant, material_id: _bomFilter.material_id }).toString()}`
      : '';
    try {
      const data = await Util.fetchTraced(`${API}/master-data/${table}${qs}`, { headers: { 'x-request-id': reqId } }).then(async r => {
        if (!r.ok) {
          // Surface the backend body instead of discarding it.
          const parsed = await Util.parseBackendError(r);
          const err = new Error(parsed.message); err.errorCode = parsed.errorCode; err.httpStatus = r.status;
          throw err;
        }
        return r.json();
      });
      _cache[table] = {
        columns: data.columns,
        rows:    data.rows,
        dirty:   new Map(),
        deleted: new Set(),
        added:   [],
      };
      _renderTable(table);
    } catch (e) {
      host.innerHTML = `<div class="md-empty">Failed to load ${TABLE_LABELS[table]}: ${e.message}</div>`;
      ErrorLog.error('master-data', `Load failed for ${table}: ${e.message}`,
        { reqId, table, status: e.httpStatus }, { reqId, errorCode: e.errorCode || 'http.network' });
    }
  }

  // -----------------------------------------------------------------------
  // Table rendering
  // -----------------------------------------------------------------------
  function _renderTable(table) {
    const host = document.getElementById('md-host');
    if (!host) return;
    const state = _cache[table];
    if (!state) return;

    const { columns, rows, dirty, deleted, added } = state;
    const allRows = [...rows, ...added];
    const isDirty = dirty.size > 0 || deleted.size > 0 || added.length > 0;

    host.innerHTML = '';

    if (table === 'bom_items') {
      const scopeBar = document.createElement('div');
      scopeBar.className = 'md-bom-scope-bar';
      scopeBar.innerHTML = `<span>${Util.t('ui.plant_label')}: <strong>${_bomFilter.plant}</strong> &middot; ${Util.t('col.material')}: <strong>${_bomFilter.material_id}</strong></span>`;
      const changeBtn = document.createElement('button');
      changeBtn.className = 'btn btn-ghost sm';
      changeBtn.textContent = Util.t('btn.change_scope');
      changeBtn.onclick = () => {
        _bomFilter = { plant: null, material_id: null };
        delete _cache.bom_items;
        _renderActiveTable();
      };
      scopeBar.appendChild(changeBtn);
      host.appendChild(scopeBar);
    }

    // -- Toolbar --
    const toolbar = document.createElement('div');
    toolbar.className = 'md-toolbar';

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'input md-search';
    searchInput.placeholder = Util.t('ph.search_table', { table: TABLE_LABELS[table] });
    searchInput.oninput = () => _applyFilter(table, searchInput.value.toLowerCase());
    toolbar.appendChild(searchInput);

    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    toolbar.appendChild(spacer);

    if (isDirty) {
      const badge = document.createElement('span');
      badge.className = 'md-dirty-badge';
      const n = dirty.size + deleted.size + added.length;
      badge.textContent = Util.t('ui.unsaved_badge', { count: n });
      toolbar.appendChild(badge);
    }

    const addRowBtn = document.createElement('button');
    addRowBtn.className = 'btn btn-ghost sm';
    addRowBtn.textContent = Util.t('btn.add_row');
    addRowBtn.onclick = () => _addRow(table);
    toolbar.appendChild(addRowBtn);

    const pasteBtn = document.createElement('button');
    pasteBtn.className = 'btn btn-ghost sm';
    pasteBtn.textContent = Util.t('btn.paste_rows');
    pasteBtn.title = Util.t('tip.paste_rows');
    pasteBtn.onclick = () => _pasteRows(table);
    toolbar.appendChild(pasteBtn);

    if (table === 'bom_items') {
      const uploadBtn = document.createElement('button');
      uploadBtn.className = 'btn btn-ghost sm';
      uploadBtn.textContent = Util.t('btn.upload_bom');
      uploadBtn.title = Util.t('tip.upload_bom');
      uploadBtn.onclick = () => _uploadBom();
      toolbar.appendChild(uploadBtn);
    }

    const addColBtn = document.createElement('button');
    addColBtn.className = 'btn btn-ghost sm';
    addColBtn.textContent = Util.t('btn.add_column');
    addColBtn.onclick = () => _openAddColumn(table);
    toolbar.appendChild(addColBtn);

    const discardBtn = document.createElement('button');
    discardBtn.className = 'btn btn-ghost sm';
    discardBtn.textContent = Util.t('btn.discard');
    discardBtn.disabled = !isDirty;
    discardBtn.onclick = () => { delete _cache[table]; _loadAndRender(table); };
    toolbar.appendChild(discardBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = `btn btn-primary sm${isDirty ? '' : ' md-save-idle'}`;
    saveBtn.textContent = Util.t('btn.save');
    saveBtn.disabled = !isDirty;
    saveBtn.onclick = () => _save(table);
    toolbar.appendChild(saveBtn);

    host.appendChild(toolbar);

    // -- Table --
    const wrap = document.createElement('div');
    wrap.className = 'md-table-wrap';

    const tbl = document.createElement('table');
    tbl.className = 'md-table';
    tbl.id = `md-tbl-${table}`;

    // Header
    const thead = document.createElement('thead');
    const hRow = document.createElement('tr');
    columns.forEach(col => {
      const th = document.createElement('th');
      th.className = 'md-th';
      const lbl = document.createElement('span');
      lbl.textContent = col.display_label;
      th.appendChild(lbl);

      // Column action menu (⋮)
      const menuBtn = document.createElement('button');
      menuBtn.className = 'md-col-menu-btn';
      menuBtn.textContent = '⋮';
      menuBtn.title = Util.t('tip.col_options');
      menuBtn.onclick = e => { e.stopPropagation(); _openColMenu(table, col, menuBtn); };
      th.appendChild(menuBtn);

      hRow.appendChild(th);
    });
    // Blank header for delete button column
    hRow.appendChild(document.createElement('th'));
    thead.appendChild(hRow);
    tbl.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    tbody.id = `md-tbody-${table}`;

    if (!allRows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = columns.length + 1;
      td.className = 'md-empty';
      td.textContent = Util.t('empty.table_no_rows', { table: TABLE_LABELS[table] });
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      allRows.forEach(row => _appendRow(tbody, table, columns, row));
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    host.appendChild(wrap);
  }

  function _appendRow(tbody, table, columns, row) {
    const state = _cache[table];
    const key = _rowKey(table, row);
    const isNew = state.added.some(r => _rowKey(table, r) === key);
    const isDeleted = state.deleted.has(key);
    const isDirty = state.dirty.has(key);
    // Render pending (dirty) values over the saved baseline so an in-progress edit
    // survives a re-render (add/paste/delete all call _renderTable). For added rows
    // the dirty entry IS the added row object, so rowView resolves to the same values.
    const _dirtyPatch = state.dirty.get(key);
    const rowView = _dirtyPatch ? { ...row, ..._dirtyPatch } : row;

    const tr = document.createElement('tr');
    tr.dataset.rowKey = key;
    tr.className = [
      isNew     ? 'md-row-new'     : '',
      isDeleted ? 'md-row-deleted' : '',
      isDirty   ? 'md-row-dirty'   : '',
    ].filter(Boolean).join(' ');

    columns.forEach(col => {
      const td = document.createElement('td');
      td.className = 'md-td';

      // bom_items.component_id: plant-scoped dropdown (material_plants rows
      // for this row's plant), not the generic FK_SOURCE/_fkSelect path —
      // that assumes the source table's LAST key column is the value column
      // (true for material_plants -> 'plant', wrong for what we need: 'material_id').
      if (table === 'bom_items' && col.column_name === 'component_id' && isNew) {
        td.appendChild(_bomComponentSelect(rowView.plant || _bomFilter.plant, rowView.component_id, key));
        tr.appendChild(td);
        return;
      }

      // FK columns get a <select> populated from parent table.
      const fkSources = FK_SOURCE[table] || {};
      if (fkSources[col.column_name] && !isNew) {
        // For existing rows, key columns are read-only.
        if (col.is_locked) {
          td.textContent = rowView[col.column_name] ?? '';
        } else {
          td.appendChild(_fkSelect(table, col.column_name, rowView[col.column_name], fkSources[col.column_name], key));
        }
      } else if (fkSources[col.column_name] && isNew) {
        td.appendChild(_fkSelect(table, col.column_name, rowView[col.column_name], fkSources[col.column_name], key));
      } else if (col.is_locked && !isNew) {
        // Key columns on saved rows are read-only.
        td.textContent = rowView[col.column_name] ?? '';
      } else {
        const cell = document.createElement('div');
        cell.contentEditable = isDeleted ? 'false' : 'true';
        cell.className = 'md-cell';
        cell.textContent = rowView[col.column_name] ?? '';
        cell.dataset.col = col.column_name;
        cell.dataset.rowKey = key;
        cell.oninput = () => _markDirty(table, key, col.column_name, cell.textContent);
        td.appendChild(cell);
      }
      tr.appendChild(td);
    });

    // Delete button
    const delTd = document.createElement('td');
    delTd.className = 'md-td md-td-action';
    if (!isDeleted) {
      const delBtn = document.createElement('button');
      delBtn.className = 'icon-btn md-del-btn';
      delBtn.title = Util.t('tip.delete_row');
      delBtn.textContent = '🗑';
      delBtn.onclick = () => _deleteRow(table, key, tr);
      delTd.appendChild(delBtn);
    } else {
      const undoBtn = document.createElement('button');
      undoBtn.className = 'btn btn-ghost sm';
      undoBtn.textContent = Util.t('btn.undo');
      undoBtn.onclick = () => { state.deleted.delete(key); _renderTable(table); };
      delTd.appendChild(undoBtn);
    }
    tr.appendChild(delTd);
    tbody.appendChild(tr);
  }

  function _fkSelect(table, colName, value, sourceTable, rowKey) {
    const sel = document.createElement('select');
    sel.className = 'input md-fk-select';
    // Populate from cache or fetch.
    const sourceState = _cache[sourceTable];
    const sourceRows = sourceState?.rows ?? [];
    const srcKeys = KEY_COLS[sourceTable];
    // For subnetworks: use 'code'. For plants when in production_lines: use 'plant'.
    const valCol = srcKeys[srcKeys.length - 1];
    const labelCol = sourceTable === 'subnetworks' ? 'name' : valCol;

    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = Util.t('ui.select_placeholder');
    sel.appendChild(blank);
    const _optLabel = r => (r[labelCol] && labelCol !== valCol) ? `${r[valCol]} — ${r[labelCol]}` : r[valCol];
    sourceRows.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r[valCol];
      opt.textContent = _optLabel(r);
      if (r[valCol] === value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.onchange = () => _markDirty(table, rowKey, colName, sel.value);

    // If source not loaded yet, fetch it.
    if (!sourceState) {
      fetch(`${API}/master-data/${sourceTable}`).then(r => r.json()).then(data => {
        _cache[sourceTable] = { columns: data.columns, rows: data.rows, dirty: new Map(), deleted: new Set(), added: [] };
        // Rebuild select options.
        while (sel.options.length > 1) sel.remove(1);
        data.rows.forEach(r => {
          const opt = document.createElement('option');
          opt.value = r[valCol];
          opt.textContent = _optLabel(r);
          if (r[valCol] === value) opt.selected = true;
          sel.appendChild(opt);
        });
      }).catch(() => {});
    }
    return sel;
  }

  // Per-plant memoized list of material_ids valid at that plant, used only
  // by the bom_items component_id dropdown. Deliberately separate from
  // _cache['material_plants'] (which may be absent, or scoped to a
  // different plant if that tab was visited) rather than risking either
  // table's cached view corrupting the other's.
  const _bomComponentOptionsCache = {};

  function _bomComponentSelect(plant, value, rowKey) {
    const sel = document.createElement('select');
    sel.className = 'input md-fk-select';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = Util.t('ui.select_placeholder');
    sel.appendChild(blank);

    const fill = (materials) => {
      while (sel.options.length > 1) sel.remove(1);
      materials.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === value) opt.selected = true;
        sel.appendChild(opt);
      });
    };
    sel.onchange = () => _markDirty('bom_items', rowKey, 'component_id', sel.value);

    if (_bomComponentOptionsCache[plant]) {
      fill(_bomComponentOptionsCache[plant]);
    } else if (plant) {
      fetch(`${API}/master-data/material_plants?${new URLSearchParams({ plant }).toString()}`)
        .then(r => r.json())
        .then(data => {
          const materials = (data.rows || []).map(r => r.material_id).sort();
          _bomComponentOptionsCache[plant] = materials;
          fill(materials);
        }).catch(() => {});
    }
    return sel;
  }

  function _markDirty(table, rowKey, colName, value) {
    const state = _cache[table];
    if (!state) return;
    // An existing dirty entry accumulates further edits. For a row's FIRST edit start
    // the patch from a SHALLOW COPY of the live baseline, so the baseline in
    // state.rows is never mutated in place — EXCEPT for newly-added rows, which ARE
    // their own working copy in state.added and are intentionally edited in place
    // (_save reads them from there; copying one would leave the added entry blank and
    // trip the "missing key columns" guard in _save).
    let patch = state.dirty.get(rowKey);
    if (!patch) {
      const addedRow = (state.added || []).find(r => _rowKey(table, r) === rowKey);
      patch = addedRow ? addedRow : { ..._getRowByKey(table, rowKey) };
    }
    patch[colName] = value;
    state.dirty.set(rowKey, patch);
    // Update the tr class to show dirty highlight.
    const tr = document.querySelector(`#md-tbody-${table} tr[data-row-key="${CSS.escape(rowKey)}"]`);
    if (tr) tr.classList.add('md-row-dirty');
    _updateSaveBtn(table);
  }

  function _getRowByKey(table, key) {
    const state = _cache[table];
    const all = [...(state?.rows ?? []), ...(state?.added ?? [])];
    return all.find(r => _rowKey(table, r) === key) ?? {};
  }

  function _updateSaveBtn(table) {
    const state = _cache[table];
    if (!state) return;
    const isDirty = state.dirty.size > 0 || state.deleted.size > 0 || state.added.length > 0;
    const saveBtn = document.querySelector('#md-host .btn-primary.sm');
    if (saveBtn) {
      saveBtn.disabled = !isDirty;
      saveBtn.classList.toggle('md-save-idle', !isDirty);
    }
    // Update dirty badge.
    const badge = document.querySelector('#md-host .md-dirty-badge');
    if (badge) {
      const n = state.dirty.size + state.deleted.size + state.added.length;
      badge.textContent = `${n} unsaved`;
      badge.hidden = !isDirty;
    }
  }

  function _addRow(table) {
    const state = _cache[table];
    if (!state) return;
    const newRow = {};
    state.columns.forEach(c => { newRow[c.column_name] = ''; });
    if (table === 'bom_items') {
      // A new row is always within the currently scoped material+plant —
      // pre-fill so the user isn't retyping the scope on every row.
      newRow.material_id = _bomFilter.material_id || '';
      newRow.plant = _bomFilter.plant || '';
    }
    state.added.push(newRow);
    // Re-render to show the new row (simpler than appending).
    _renderTable(table);
    // Focus first editable cell of the new row.
    setTimeout(() => {
      const tbody = document.getElementById(`md-tbody-${table}`);
      const lastRow = tbody?.lastElementChild;
      const firstCell = lastRow?.querySelector('.md-cell');
      if (firstCell) firstCell.focus();
    }, 50);
  }

  async function _uploadBom() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      try {
        const resp = await Util.fetchTraced(`${API}/bom/upload`, { method: 'POST', body: fd });
        const result = await resp.json();
        if (!resp.ok) throw new Error(result.detail || result.message || Util.t('toast.bom_upload_failed'));
        Toast.show(
          Util.t('toast.bom_upload_done', {
            inserted: result.inserted || 0, updated: result.updated || 0, rejected: result.rejected || 0,
          }),
          result.rejected ? 'warn' : 'success',
        );
        if (result.warnings && result.warnings.length) {
          result.warnings.slice(0, 10).forEach(w => ErrorLog.warn('master-data', w.msg));
        }
        // Refresh the currently-scoped view so newly uploaded rows for this
        // material+plant show up immediately.
        delete _cache.bom_items;
        if (_activeTable === 'bom_items') _renderActiveTable();
      } catch (e) {
        Toast.show(`${Util.t('toast.bom_upload_failed')}: ${e.message}`, 'error');
        ErrorLog.error('master-data', `BOM upload failed: ${e.message}`);
      }
    };
    input.click();
  }

  async function _pasteRows(table) {
    let raw;
    try {
      raw = await navigator.clipboard.readText();
    } catch {
      Toast.show(Util.t('toast.clipboard_denied'), 'error');
      return;
    }
    if (!raw.trim()) { Toast.show(Util.t('toast.clipboard_empty'), 'error'); return; }

    const state = _cache[table];
    if (!state) return;

    const { rows } = _parsePaste(raw, state.columns);
    if (!rows.length) { Toast.show(Util.t('toast.no_rows_paste'), 'error'); return; }

    const keys    = KEY_COLS[table];
    const toAdd   = [];
    const toUpdate = [];
    const invalid  = [];

    rows.forEach(row => {
      if (keys.find(k => !row[k])) { invalid.push(row); return; }
      const key = _rowKey(table, row);
      const inSaved    = state.rows.some(r => _rowKey(table, r) === key);
      const inAdded    = state.added.some(r => _rowKey(table, r) === key);
      const batchAddIdx = toAdd.findIndex(r => _rowKey(table, r) === key);
      const batchUpdIdx = toUpdate.findIndex(r => _rowKey(table, r) === key);
      if      (batchAddIdx >= 0)  toAdd[batchAddIdx]    = row; // last write wins within batch
      else if (batchUpdIdx >= 0)  toUpdate[batchUpdIdx] = row;
      else if (inSaved || inAdded) toUpdate.push(row);
      else                         toAdd.push(row);
    });

    if (!toAdd.length && !toUpdate.length) {
      Toast.show(invalid.length
        ? Util.t('toast.missing_key_rows', { count: invalid.length, keys: keys.join(', ') })
        : Util.t('toast.no_valid_rows'), 'error');
      return;
    }

    const parts = [];
    if (toAdd.length)    parts.push(`add ${toAdd.length} new`);
    if (toUpdate.length) parts.push(`update ${toUpdate.length} existing`);
    if (invalid.length)  parts.push(`skip ${invalid.length} invalid`);

    const ok = await Modal.confirm({
      title:   'Paste Rows',
      message: `This will ${parts.join(', ')} row(s).`,
      detail:  `Changes appear in the table but won't be saved until you click Save.` +
               (invalid.length ? ` Skipped rows are missing key column(s): ${keys.join(', ')}.` : ''),
      tone:    'info',
    });
    if (!ok) return;

    toAdd.forEach(row => {
      const full = {};
      state.columns.forEach(c => { full[c.column_name] = row[c.column_name] ?? ''; });
      state.added.push(full);
    });

    toUpdate.forEach(row => {
      const key = _rowKey(table, row);
      const idx = state.rows.findIndex(r => _rowKey(table, r) === key);
      if (idx >= 0) {
        Object.assign(state.rows[idx], row);
        state.dirty.set(key, { ...state.rows[idx] });
      } else {
        const ai = state.added.findIndex(r => _rowKey(table, r) === key);
        if (ai >= 0) Object.assign(state.added[ai], row);
      }
    });

    _renderTable(table);
    Toast.show(invalid.length
      ? Util.t('toast.paste_result_skip', { added: toAdd.length, updated: toUpdate.length, skipped: invalid.length })
      : Util.t('toast.paste_result', { added: toAdd.length, updated: toUpdate.length }), 'success');
  }

  async function _deleteRow(table, rowKey, tr) {
    const state = _cache[table];
    if (!state) return;

    // Build delete payload from the key.
    const keys = KEY_COLS[table];
    const row = _getRowByKey(table, rowKey);
    const deletePayload = {};
    keys.forEach(k => { deletePayload[k] = row[k]; });

    // Get cascade preview for saved rows (not for newly-added rows).
    const isNew = state.added.some(r => _rowKey(table, r) === rowKey);
    let cascadeDetail = '';

    if (!isNew && (table === 'subnetworks' || table === 'plants' || table === 'material_plants')) {
      try {
        const preview = await fetch(`${API}/master-data/${table}/cascade-preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deletes: [deletePayload] }),
        }).then(r => r.json());

        const parts = [];
        if (preview.plants > 0)           parts.push(`<strong>${preview.plants}</strong> plant${preview.plants !== 1 ? 's' : ''}`);
        if (preview.production_lines > 0)  parts.push(`<strong>${preview.production_lines}</strong> production line${preview.production_lines !== 1 ? 's' : ''}`);
        if (preview.bom_items > 0)          parts.push(`<strong>${preview.bom_items}</strong> BOM item${preview.bom_items !== 1 ? 's' : ''}`);
        if (parts.length) {
          cascadeDetail = table === 'material_plants'
            ? `<div class="md-cascade-warn">This is referenced by ${parts.join(' and ')} — delete those first.</div>`
            : `<div class="md-cascade-warn">This will also permanently delete ${parts.join(' and ')}.</div>`;
        }
      } catch {}
    }

    const keyDisplay = keys.map(k => row[k]).join(' / ');
    const confirmed = await Modal.confirm({
      title:         `Delete "${keyDisplay}"?`,
      message:       `Are you sure you want to delete this ${TABLE_LABELS[table].replace(/s$/, '').toLowerCase()} from the database?`,
      detail:        cascadeDetail || undefined,
      confirmLabel:  'Yes, delete',
      tone:          'danger',
    });
    if (!confirmed) return;

    if (isNew) {
      // Just remove from added array.
      const idx = state.added.findIndex(r => _rowKey(table, r) === rowKey);
      if (idx >= 0) state.added.splice(idx, 1);
      _renderTable(table);
    } else {
      state.deleted.add(rowKey);
      tr.className = 'md-row-deleted';
      _updateSaveBtn(table);
      _renderTable(table);
    }
  }

  // -----------------------------------------------------------------------
  // Save
  // -----------------------------------------------------------------------
  async function _save(table) {
    const state = _cache[table];
    if (!state) return;
    const keys = KEY_COLS[table];

    // Build upserts from dirty + added.
    const upserts = [];
    state.dirty.forEach((patch, _key) => { if (!state.deleted.has(_key)) upserts.push(patch); });
    state.added.forEach(row => {
      // Validate that key columns are filled.
      const missing = keys.filter(k => !row[k]);
      if (missing.length) {
        Toast.show(Util.t('toast.no_plant_selected') + ': ' + missing.join(', '), 'error');
        return;
      }
      upserts.push(row);
    });

    // Build deletes.
    const deletes = [];
    state.deleted.forEach(rowKey => {
      const row = _getRowByKey(table, rowKey);
      const d = {};
      keys.forEach(k => { d[k] = row[k]; });
      deletes.push(d);
    });

    if (!upserts.length && !deletes.length) return;

    // Cascade confirmation for deletes that weren't already confirmed.
    if (deletes.length && (table === 'subnetworks' || table === 'plants' || table === 'material_plants')) {
      try {
        const preview = await fetch(`${API}/master-data/${table}/cascade-preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deletes }),
        }).then(r => r.json());
        const total = (preview.plants || 0) + (preview.production_lines || 0) + (preview.bom_items || 0);
        if (total > 0) {
          const parts = [];
          if (preview.plants > 0)          parts.push(`${preview.plants} plant${preview.plants !== 1 ? 's' : ''}`);
          if (preview.production_lines > 0) parts.push(`${preview.production_lines} production line${preview.production_lines !== 1 ? 's' : ''}`);
          if (preview.bom_items > 0)         parts.push(`${preview.bom_items} BOM item${preview.bom_items !== 1 ? 's' : ''}`);
          const ok = table === 'material_plants'
            ? await Modal.confirm({
                title:         `Cannot delete ${deletes.length} row${deletes.length !== 1 ? 's' : ''}`,
                message:       `This is referenced by ${parts.join(' and ')} — delete those first.`,
                confirmLabel:  `OK`,
                tone:          'danger',
              }).then(() => false)
            : await Modal.confirm({
                title:         `Delete ${deletes.length} row${deletes.length !== 1 ? 's' : ''}?`,
                message:       `This will also permanently delete ${parts.join(' and ')}.`,
                detail:        '<strong>This cannot be undone.</strong>',
                confirmLabel:  `Yes, delete all`,
                tone:          'danger',
              });
          if (!ok) return;
        }
      } catch {}
    }

    try {
      const res = await fetch(`${API}/master-data/${table}/bulk`, {
        method:  'POST',
        headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
        body:    JSON.stringify({ upserts, deletes }),
      }).then(r => {
        if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); });
        return r.json();
      });

      Toast.show(
        Util.t('toast.paste_result', { added: res.inserted, updated: res.updated }) + `, ${res.deleted} deleted`,
        'success'
      );
      delete _cache[table];
      await _loadAndRender(table);

      // Refresh master-data in Store so Hierarchy/ProdLines stay in sync.
      Promise.all([
        fetch(`${API}/master-data/plants`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
        fetch(`${API}/master-data/production_lines`, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null),
      ]).then(([pData, lData]) => {
        if (pData || lData) {
          // Public Store.setMasterData(...) equivalent of the former direct
          // `Store._state.masterData = {...}; Store.rebuildPlantIndex();` write
          // (CQ-1 Phase 4 Task 2 — closes MasterData's tracked §6 exception).
          // It fires its own 'master-data-changed' emit (without the `table`
          // field the old manual emit below carried — unused by any
          // subscriber, confirmed by inspection), so the `table`-carrying
          // emit only needs to fire on the no-op (neither fetch returned
          // rows) branch to preserve the original single-emit-per-call shape.
          Store.setMasterData({
            plants: pData?.rows ?? [],
            lines:  lData?.rows ?? [],
          }, 'master-data-save');
        } else {
          Store.emit({ type: 'master-data-changed', table, source: 'master-data-save' });
        }
      }).catch(() => {
        Store.emit({ type: 'master-data-changed', table, source: 'master-data-save' });
      });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: e.message }), 'error');
      ErrorLog.error('master-data', `Save failed for ${table}: ${e.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Filter / search
  // -----------------------------------------------------------------------
  function _applyFilter(table, query) {
    const tbody = document.getElementById(`md-tbody-${table}`);
    if (!tbody) return;
    tbody.querySelectorAll('tr').forEach(tr => {
      const text = tr.textContent.toLowerCase();
      tr.hidden = query ? !text.includes(query) : false;
    });
  }

  // -----------------------------------------------------------------------
  // Column management
  // -----------------------------------------------------------------------
  function _openColMenu(table, col, anchor) {
    // Close any existing menu.
    document.querySelectorAll('.md-col-menu').forEach(m => m.remove());

    const menu = document.createElement('div');
    menu.className = 'md-col-menu';

    const rename = document.createElement('button');
    rename.className = 'md-col-menu-item';
    rename.textContent = Util.t('btn.rename_label');
    rename.onclick = () => { menu.remove(); _openRenameLabel(table, col); };
    menu.appendChild(rename);

    const drop = document.createElement('button');
    drop.className = 'md-col-menu-item md-col-menu-danger';
    drop.textContent = Util.t('btn.delete_column');
    drop.disabled = col.is_locked;
    drop.title = col.is_locked ? Util.t('tip.key_cols_no_delete') : '';
    drop.onclick = () => { menu.remove(); _dropColumn(table, col); };
    menu.appendChild(drop);

    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.top  = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.left}px`;

    const close = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  function _openAddColumn(table) {
    document.getElementById('md-col-name').value  = '';
    document.getElementById('md-col-label').value = '';
    document.getElementById('md-col-type').value  = 'TEXT';
    document.getElementById('md-col-length').value = '';
    document.getElementById('md-col-default').value = '';
    document.getElementById('md-col-nullable').checked = true;
    document.getElementById('md-addcol-error').textContent = '';
    document.getElementById('md-col-length-row').hidden = true;

    const typeSelect = document.getElementById('md-col-type');
    typeSelect.onchange = () => {
      document.getElementById('md-col-length-row').hidden = typeSelect.value !== 'NUMERIC';
    };

    document.getElementById('md-addcol-confirm-btn').onclick = async () => {
      const colName  = document.getElementById('md-col-name').value.trim();
      const label    = document.getElementById('md-col-label').value.trim() || colName;
      const sqlType  = document.getElementById('md-col-type').value;
      const length   = document.getElementById('md-col-length').value.trim() || null;
      const nullable = document.getElementById('md-col-nullable').checked;
      const def      = document.getElementById('md-col-default').value.trim() || null;
      const errEl    = document.getElementById('md-addcol-error');

      if (!colName) { errEl.textContent = Util.t('ui.column_id_required'); return; }
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(colName)) {
        errEl.textContent = Util.t('ui.column_id_format');
        return;
      }
      if (!nullable && !def) {
        errEl.textContent = Util.t('ui.not_null_requires_default');
        return;
      }

      Modal.close('md-addcol-modal');

      try {
        await fetch(`${API}/master-data/${table}/columns`, {
          method:  'POST',
          headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
          body:    JSON.stringify({ column_name: colName, sql_type: sqlType, length, nullable, default: def, display_label: label }),
        }).then(r => {
          if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); });
          return r.json();
        });
        Toast.show(Util.t('toast.col_added', { label }), 'success');
        delete _cache[table];
        _loadAndRender(table);
      } catch (e) {
        Toast.show(Util.t('toast.failed_add_col', { msg: e.message }), 'error');
      }
    };

    Modal.open('md-addcol-modal');
  }

  async function _dropColumn(table, col) {
    const confirmed = await Modal.confirm({
      title:         Util.t('modal.drop_column_title', { label: col.display_label }),
      message:       Util.t('modal.drop_column_msg', { name: col.column_name, table: TABLE_LABELS[table] }),
      detail:        `<strong>${Util.t('modal.delete_cannot_undo')}</strong>`,
      confirmLabel:  Util.t('modal.drop_column_confirm'),
      tone:          'danger',
    });
    if (!confirmed) return;

    try {
      await fetch(`${API}/master-data/${table}/columns/${col.column_name}`, {
        method:  'DELETE',
        headers: { 'x-user-email': Session.actor() },
      }).then(r => {
        if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); });
        return r.json();
      });
      Toast.show(Util.t('toast.column_dropped', { col: col.column_name }), 'success');
      delete _cache[table];
      _loadAndRender(table);
    } catch (e) {
      Toast.show(Util.t('toast.failed_drop_column', { msg: e.message }), 'error');
    }
  }

  function _openRenameLabel(table, col) {
    const noteEl  = document.getElementById('md-rename-note');
    const inputEl = document.getElementById('md-rename-label-input');
    if (noteEl)  noteEl.textContent = `Column ID: "${col.column_name}" (unchanged) · Table: ${TABLE_LABELS[table]}`;
    if (inputEl) inputEl.value = col.display_label;

    document.getElementById('md-rename-confirm-btn').onclick = async () => {
      const newLabel = inputEl.value.trim();
      if (!newLabel) return;
      Modal.close('md-renamelabel-modal');
      try {
        await fetch(`${API}/master-data/${table}/columns/${col.column_name}`, {
          method:  'PATCH',
          headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
          body:    JSON.stringify({ display_label: newLabel }),
        }).then(r => {
          if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); });
          return r.json();
        });
        Toast.show(Util.t('toast.column_label_updated', { label: newLabel }), 'success');
        delete _cache[table];
        _loadAndRender(table);
      } catch (e) {
        Toast.show(Util.t('toast.failed_rename_label', { msg: e.message }), 'error');
      }
    };
    Modal.open('md-renamelabel-modal');
  }

  // Pulls the current column state (whichever DB this app is pointed at —
  // local or Azure) back out as idempotent SQL, so drift from the Add/Drop
  // Column wizard (which mutates the live DB directly, with no git record)
  // can be folded back into schema.sql after the fact.
  async function _exportSchema() {
    const textEl  = document.getElementById('md-schema-export-text');
    const copyBtn = document.getElementById('md-schema-export-copy-btn');
    textEl.value = '…';
    Modal.open('md-schema-export-modal');
    try {
      const data = await fetch(`${API}/master-data/_schema-export`).then(r => {
        if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); });
        return r.json();
      });
      textEl.value = data.sql || '';
    } catch (e) {
      textEl.value = '';
      Toast.show(Util.t('toast.failed_schema_export', { msg: e.message }), 'error');
    }
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(textEl.value)
        .then(() => Toast.show(Util.t('toast.schema_copied'), 'success'))
        .catch(() => Toast.show(Util.t('toast.clipboard_denied'), 'error'));
    };
  }

  async function syncLineSettings(line, patch) {
    if (!_cache['production_lines']) {
      try {
        const data = await fetch(`${API}/master-data/production_lines`).then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
        _cache['production_lines'] = {
          columns: data.columns, rows: data.rows,
          dirty: new Map(), deleted: new Set(), added: [],
        };
      } catch { return; }
    }

    const state = _cache['production_lines'];
    const rowIdx = state.rows.findIndex(r => r.production_line === line);
    if (rowIdx < 0) return;

    const updatedRow = { ...state.rows[rowIdx] };
    if ('excludeFromOpt' in patch) updatedRow.excl_optimizer  = patch.excludeFromOpt ? 'X' : null;
    if ('bottleneck'     in patch) updatedRow.bottleneck      = patch.bottleneck     ? 'X' : null;
    if ('bufferUnit'     in patch) updatedRow.buffer_type     = patch.bufferUnit === 'pct' ? '%' : 'hrs';
    if ('bufferPct'      in patch) updatedRow.buffer_percent  = patch.bufferPct;
    if ('bufferHours'    in patch) updatedRow.buffer_hours    = patch.bufferHours;
    if ('plGroup'        in patch) updatedRow.pl_group        = patch.plGroup || null;

    // Update cache row and clear any stale dirty flag so MasterData table stays consistent.
    state.rows[rowIdx] = updatedRow;
    state.dirty.delete(_rowKey('production_lines', updatedRow));

    try {
      await fetch(`${API}/master-data/production_lines/bulk`, {
        method:  'POST',
        headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
        body:    JSON.stringify({ upserts: [updatedRow], deletes: [] }),
      }).then(r => {
        if (!r.ok) return r.json().then(e => { throw new Error(e.detail || `HTTP ${r.status}`); });
        return r.json();
      });
      if (_activeTable === 'production_lines') _renderTable('production_lines');
    } catch (e) {
      ErrorLog.error('prod-lines', `Failed to save line setting: ${e.message}`);
    }
  }

  return { render, syncLineSettings };
})();
