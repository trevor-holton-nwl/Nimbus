// master-data/admin-ui.mjs — Plant, ProdLines, and MasterData (the "Manage
// Data Tables" admin sub-tab UI). Extracted verbatim from
// plant-and-administration.mts (Phase P2 of
// docs/architecture/domain-refactor-plan.md, which split that 11,308-line
// mega-module into 9 domain files) — three non-contiguous source ranges
// combined into this one file per that phase's per-domain grouping.
/* global NIMBUS */
import { Config, Util, ErrorLog, Toast, Modal } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import { Engine } from '../optimization/engine.mjs';
import { CalendarSync } from '../calendar/calendar-sync.mjs';
import { Session } from '../security/session.mjs';
import { Persistence } from '../scheduling/persistence.mjs';
import { AlertsUIAdapter } from '../insights/insights-ui.mjs';
import { PriorityListViewer } from '../priority-lists/viewers.mjs';
import type { NimbusBlock, NimbusPlantBlock, NimbusMasterPlant, NimbusMasterLine, NimbusLineSetting, ConstraintConfig, BufferUnit, PriorityFieldMeta, PriorityListFieldSummary, MissingMasterDataReport, UnknownSetupPolicy } from '../platform/types.mjs';
// Cross-domain seams (see docs/architecture/domain-refactor-plan.md Phase P2
// task brief / report for the full verified cross-reference list):
//   - `SetupAdmin.render` is called from Plant's Settings pane. `SetupAdmin`
//     itself calls `Plant.gotoTab` (reviewMissingPairs' missing-setup review
//     handoff) — an intrinsic two-way reference carried over unchanged from
//     the original single-file module (see setup-admin.mts's own header
//     comment for why this "lazy" ESM cycle is safe).
import { SetupAdmin } from '../setup/setup-admin.mjs';
//   - `CalendarUI` is used by both Plant (plant-block modal save) and
//     ProdLines (line-scoped blackout blocks).
import { CalendarUI } from '../calendar/calendar-admin.mjs';
//   - `PriorityListMapping` is used only by Plant's priority-list upload flow.
import { PriorityListMapping } from '../priority-lists/mapping.mjs';
//   - the injected "am I the visible tab?" getter seam Plant needs (see
//     shell/tab-resolvers.mts).
import { getActiveTabResolvers } from '../shell/tab-resolvers.mjs';

/** Shared "reject non-2xx instead of parsing the error body as data" fetch step.
 *  Without it a 403/500 JSON body (`{"detail": …}`) parses cleanly and takes the
 *  success branch, producing a false success message with blank interpolations.
 *  Used by every priority-list read/write in this file. */
const _okJson = (r: Response) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`));

/** Last-resort mirror of `master_data.RANKABLE_FIELDS` (the backend's single
 *  source of truth, surfaced live via `GET /priority-fields`). Only used when
 *  that fetch has never succeeded in this session — otherwise the Optimization
 *  tab would render completely empty on a transient failure, with no dropzones
 *  and therefore no way to upload anything. `default_label` is intentionally the
 *  backend's own English default; the cards render `Util.t('constraint.<key>')`,
 *  so these labels are never what the user actually sees. Keep the key list in
 *  sync with RANKABLE_FIELDS if a field is added there. */
const _FALLBACK_PRIORITY_FIELDS: PriorityFieldMeta[] = [
  { field_key: 'colorWheel', mp_column: 'color', orders_column: 'color', task_field: 'COLOR', default_label: 'Color' },
  { field_key: 'prt01', mp_column: 'prt_01', orders_column: 'prt_01', task_field: 'PRT_01', default_label: 'PRT01' },
  { field_key: 'prt02', mp_column: 'prt_02', orders_column: 'prt_02', task_field: 'PRT_02', default_label: 'PRT02' },
];

/** Reserved key in `PriorityListFieldSummary.coverage` holding the true
 *  plant-wide roll-up — must match `db.PLANT_TOTAL_COVERAGE_KEY`. NOT `''`:
 *  that key is the "orders with no production line" bucket, so reading it as a
 *  plant total left the ratio silently blank on every plant whose orders all
 *  carry a line. Summing the per-line buckets instead would double-count any
 *  value used on more than one line (they are per-line COUNT(DISTINCT …)). */
const PLANT_TOTAL_COVERAGE_KEY = '__plant_total__';

/* =============================================================================
   PLANT — plant-level calendar UI (working hours, blackouts, lines roster).
   ========================================================================== */
/** One `Plant._pillFps` entry — the two Flatpickr instances backing a single
 *  day's start/end time inputs in the plant working-hours pill row. */
interface PillFpPair {
  start: NimbusVendor.FlatpickrInstance | null;
  end: NimbusVendor.FlatpickrInstance | null;
}

// `interface ConstraintState` lived here until Stage 3 (docs/scheduling_priority.md)
// rebuilt `Plant._renderSettingsPane`'s flat constraint list into a nested
// priority tree. Its working copy is now a `ConstraintConfig[]` (frontend/types.mts)
// straight through — the shape that carries `children` — so a save can no
// longer flatten a stored tree on its way back to the backend.

/** Scheduling Rules density pass (2026-08-21): the per-field "More info" copy
 *  for each `[data-rule-key]` row in `Plant._renderSettingsPane`'s compact
 *  form, keyed by that same `data-rule-key`. Values are locale KEYS, not
 *  translated text — resolved via `Util.t` at right-click time so a live
 *  language switch is picked up with no re-render of this table. `title`
 *  reuses each row's own label key; `help` is the row's former inline
 *  `panel-help-text`/`split-policy-help` paragraph(s), in the order they used
 *  to read top-to-bottom.
 *
 *  Two-section pass (2026-08-21): the `visibilityHorizon`, `horizonRollHour`
 *  and `setupActive` entries were dropped along with their rows — Visibility
 *  Horizon and Setup-Aware Optimization are now maintained through Admin ▸
 *  Manage Data Tables ▸ `plants` (both registered in `column_metadata` by
 *  migrations/2026-08-21-plants-grid-visibility.sql), and
 *  `plants.horizon_roll_hour_utc` has no UI at all any more — it stays at its
 *  NOT NULL DEFAULT 19 (see that migration's comment on why it is deliberately
 *  left out of the grid too). Their locale keys are intentionally KEPT in
 *  frontend/locales/* — `ui.unit_hour_utc` is pinned by
 *  tests/modules/locale-completeness.test.mjs. The visibility-horizon
 *  toasts' backend route (POST /master-data/plants/{plant}/visibility-horizon)
 *  was itself removed 2026-09 as confirmed dead (this same 2026-08-21 pass
 *  had already removed its only frontend caller) — these keys are now purely
 *  historical, kept only because the locale test still pins them, not
 *  because anything live still depends on them. */
const RULE_HELP: Record<string, { title: string; help: string[] }> = {
  alertHorizon:         { title: 'ui.alert_horizon_title',          help: ['ui.alert_horizon_help'] },
  confHorizon:          { title: 'ui.conf_horizon_title',           help: ['ui.conf_horizon_help'] },
  frozenHorizon:        { title: 'ui.frozen_horizon_title',         help: ['ui.frozen_horizon_help'] },
  maxPullForward:       { title: 'ui.max_pull_forward_title',       help: ['ui.max_pull_forward_help'] },
  maxPushForward:       { title: 'ui.max_push_forward_title',       help: ['ui.max_push_forward_help'] },
  minProductiveSegment: { title: 'ui.min_productive_segment_title', help: ['ui.min_productive_segment_help', 'ui.min_productive_segment_help_detail'] },
  splitOrderPolicy:     { title: 'ui.split_order_title',            help: ['ui.split_order_help', 'ui.split_order_policy_help'] },
  unknownSetupPolicy:   { title: 'ui.unknown_setup_title',          help: ['ui.unknown_setup_help'] },
};

export const Plant = {
  _blocksCollapsed: true,
  _rosterCollapsed: true,
  _priorityFields: [] as PriorityFieldMeta[],
  _priorityLists: {} as Record<string, PriorityListFieldSummary>,
  _missingMasterData: null as MissingMasterDataReport | null,
  // Tracked SEPARATELY from _missingMasterData's content, because
  // `_missingMasterData === null` alone cannot distinguish "the exception
  // report failed to load" from "the report loaded and there are zero
  // exceptions" — and the panel renders nothing at all in the zero case, so a
  // silently-failed fetch would read to an admin as a clean bill of health.
  _missingDataOk: false,
  // Non-null when the last Optimization-tab load failed — surfaced as an
  // inline banner so a 403/timeout/500 can't present as an empty tab with no
  // dropzones and no explanation.
  _priorityLoadError: null as string | null,
  _currentPlantTab: 'general',
  // System Settings' inner tab strip (docs/archive/setup_matrix_ui_redesign.md §3.1)
  // — separate from _currentPlantTab, which is the outer General/Optimization/
  // System Settings strip. Defaults to 'rules' so the four simple numeric/
  // dropdown settings are what a visitor sees first, not the Setup Matrix
  // console.
  _currentSettingsSubTab: 'rules' as 'rules' | 'setup',
  _pillFps: null as PillFpPair[] | null,
  _fpBlkStart: null as NimbusVendor.FlatpickrInstance | null,
  _fpBlkEnd: null as NimbusVendor.FlatpickrInstance | null,

  _settingsSubTabVisibility(subTab: 'rules' | 'setup'): { rules: boolean; setup: boolean } {
    return { rules: subTab === 'rules', setup: subTab === 'setup' };
  },

  init(): void {
    Store.subscribe(evt => {
      if (evt.type === 'plant:selected') {
        const onPlantSub = getActiveTabResolvers().currentTab() === 'masterdata'
          && getActiveTabResolvers().currentMasterSub() === 'plant';
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
  _wireStaticHandlers(): void {
    document.querySelectorAll<HTMLElement>('.plant-inner-tabs .sub-subtab[data-plant-tab]').forEach(btn => {
      btn.addEventListener('click', () => Plant.gotoTab(btn.dataset.plantTab));
    });
    document.getElementById('plant-add-block-btn')?.addEventListener('click', () => Plant.openBlockModal());
    document.getElementById('plant-roster-toggle')?.addEventListener('click', () => Plant.toggleRosterList());
    document.getElementById('modal-block-save-btn')?.addEventListener('click', () => CalendarUI.saveBlockFromModal());
    document.getElementById('modal-plant-block-save-btn')?.addEventListener('click', () => Plant.savePlantBlockFromModal());
    document.getElementById('modal-lines-block-save-btn')?.addEventListener('click', () => ProdLines.saveBlockFromModal());

    // Stage 2's two new modals (#modal-priority-mapping, #modal-priority-viewer)
    // were added with inline onclick=/oninput= attributes copied from an older
    // modal's style, which moved CLAUDE.md's tracked static-inline-handler count
    // (the precisely-quantified blocker to switching index.html's CSP meta tag
    // from Report-Only to enforcing) the wrong way, and broke the
    // cq1-legacy-surface contract snapshot. Wired here instead, same pattern as
    // everything above. Both modals are always-present static markup, so a
    // single boot-time wiring is sufficient. `PriorityListViewer` lives in
    // priority-lists/viewers.mjs and is already imported at the top of this
    // file; `PriorityListMapping` is defined below in this same module.
    const mapModal = document.getElementById('modal-priority-mapping');
    // Backdrop click, target-guarded exactly as the inline handler was — only a
    // click on the backdrop itself dismisses, never one that bubbled up from the
    // dialog's own content.
    mapModal?.addEventListener('click', e => {
      if (e.target === mapModal) PriorityListMapping.close();
    });
    document.getElementById('pl-mapping-close-btn')?.addEventListener('click', () => PriorityListMapping.close());
    document.getElementById('pl-mapping-cancel-btn')?.addEventListener('click', () => PriorityListMapping.close());
    document.getElementById('pl-mapping-confirm-btn')?.addEventListener('click', () => PriorityListMapping.confirm());

    const viewModal = document.getElementById('modal-priority-viewer');
    viewModal?.addEventListener('click', e => {
      if (e.target === viewModal) PriorityListViewer.close();
    });
    document.getElementById('pl-viewer-close-x')?.addEventListener('click', () => PriorityListViewer.close());
    document.getElementById('pl-viewer-close-btn')?.addEventListener('click', () => PriorityListViewer.close());
    document.getElementById('pl-viewer-search')?.addEventListener('input', e => {
      PriorityListViewer.search((e.target as HTMLInputElement).value);
    });
  },

  render(): void {
    const plantName = Store.selectedPlant;
    const badge = document.querySelector('#md-master-plant-pane .plant-badge');
    if (badge) badge.textContent = plantName || '—';
    Plant.gotoTab(Plant._currentPlantTab || 'general');
    Plant._renderHours();
    Plant._renderBlocks();
    Plant._renderRoster();
  },

  /** Called by App once `GET /priority-fields` resolves (application-shell.mts),
   *  so a late-arriving registry un-sticks a Scheduling Constraints pane that
   *  rendered against the one-entry `Engine.CONSTRAINT_CATALOG` fallback.
   *
   *  This is not cosmetic. `_renderSettingsPane` is synchronous (R8) and
   *  `renderConstraints`' add-picker gate is
   *  `countConfiguredKeys(consTree) < Engine.CONSTRAINT_CATALOG.length` — with a
   *  1-entry catalog that is false for any plant carrying even its default
   *  `[colorWheel]` seed, so every "+ Add priority" / "+ Add sub-priority"
   *  control renders DISABLED with Color Wheel as its only option. Nothing else
   *  re-rendered the pane, so a slow or failed boot fetch left the tree
   *  permanently unusable for the session with no recovery short of a page
   *  reload. (A comment in App claimed this re-render already happened; it did
   *  not.)
   *
   *  A direct method call rather than a Store event on purpose: `Store.emit`
   *  reaches `Persistence.autosave`'s unfiltered subscriber, and this pane is the
   *  only thing that needs waking — CLAUDE.md's "small public method" resolution
   *  for a reverse-direction need. Guarded so it is a no-op unless that pane is
   *  the one on screen; re-rendering it is otherwise identical to the user
   *  clicking the sub-tab. */
  onPriorityFieldsLoaded(): void {
    const onSettingsPane = getActiveTabResolvers().currentTab() === 'masterdata'
      && getActiveTabResolvers().currentMasterSub() === 'plant'
      && Plant._currentPlantTab === 'settings';
    if (onSettingsPane) Plant._renderSettingsPane();
  },

  gotoTab(tab: string | undefined): void {
    if (!['general', 'optimization', 'settings'].includes(tab!)) return;
    const t = tab!;
    Plant._currentPlantTab = t;
    document.querySelectorAll<HTMLElement>('.plant-inner-tabs .sub-subtab').forEach(b => {
      b.classList.toggle('active', b.dataset.plantTab === t);
    });
    ['general', 'optimization', 'settings'].forEach(tt => {
      const el = document.getElementById(`plant-tab-${tt}`);
      if (el) el.hidden = (tt !== t);
    });
    if (t === 'settings') Plant._renderSettingsPane();
    else if (t === 'optimization') Plant._fetchAndRenderOptimization(Store.selectedPlant);
  },

  toggleBlocksList(): void {
    Plant._blocksCollapsed = !Plant._blocksCollapsed;
    const list = document.getElementById('plant-blocks-list');
    const btn  = document.getElementById('plant-blk-toggle');
    if (list) list.style.display = Plant._blocksCollapsed ? 'none' : '';
    if (btn)  btn.textContent = Plant._blocksCollapsed ? '▼' : '▲';
  },

  toggleRosterList(): void {
    Plant._rosterCollapsed = !Plant._rosterCollapsed;
    const wrap = document.getElementById('plant-roster-wrap');
    const btn  = document.getElementById('plant-roster-toggle');
    if (wrap) wrap.style.display = Plant._rosterCollapsed ? 'none' : '';
    if (btn)  btn.textContent = Plant._rosterCollapsed ? '▼' : '▲';
  },

  _renderHours(): void {
    const body = document.getElementById('plant-hours-body');
    if (!body) return;
    const plantName = Store.selectedPlant;
    if (!plantName) { body.innerHTML = `<p class="plant-no-sel">${Util.t('ui.select_plant_hours')}</p>`; return; }
    Store.ensurePlant(plantName);
    const plant = Store.plants[plantName];

    if (Plant._pillFps) {
      Plant._pillFps.forEach(p => { p.start?.destroy(); p.end?.destroy(); });
    }
    Plant._pillFps = Array(7).fill(null).map(() => ({ start: null, end: null })) as PillFpPair[];
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
      const p = Store.plants[Store.selectedPlant!];
      for (let d = 0; d < 7; d++) {
        const wh = p.workHours[d];
        const onClose = () => Plant._pillSave(d);
        Plant._pillFps![d].start = flatpickr(`#plant-pill-start-${d}`, {
          enableTime: true, noCalendar: true, dateFormat: 'H:i',
          minuteIncrement: 30,
          defaultDate: wh ? Util.hoursToTimeString(wh[0]) : '08:00',
          onClose,
        });
        Plant._pillFps![d].end = flatpickr(`#plant-pill-end-${d}`, {
          enableTime: true, noCalendar: true, dateFormat: 'H:i',
          minuteIncrement: 30,
          defaultDate: wh ? Util.hoursToTimeString(wh[1]) : '17:00',
          onClose,
        });
      }
    });
  },

  _pillClick(d: number): void {
    const pName = Store.selectedPlant;
    if (!pName) return;
    const plant = Store.plants[pName];
    const wh = plant.workHours[d];
    if (!wh) {
      Store.setPlantWorkHours(pName, d, [8, 17], 'pill');
      const changed = new Set<string>();
      for (let i = 0; i < 7; i++) for (const l of Store.clampLinesToPlant(pName, i)) changed.add(l);
      Plant._persistPlantHours(pName, changed);
      Plant._renderHours();
      Toast.show(Util.t('day.sun_enabled', { day: ['day.sun','day.mon','day.tue','day.wed','day.thu','day.fri','day.sat'].map(k => Util.t(k))[d] }), 'success');
      return;
    }
    const pill = document.querySelector(`.line-hours-pill[data-day="${d}"]`);
    if (pill) pill.classList.add('editing');
    Plant._pillFps?.[d]?.start?.open();
  },

  _pillSave(d: number): void {
    const pName = Store.selectedPlant;
    if (!pName) return;
    const pair = Plant._pillFps?.[d];
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
    const changed = new Set<string>();
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
  _persistPlantHours(pName: string | null, changedLines?: Set<string> | string[]): void {
    if (!pName) return;
    CalendarSync.savePlantHours(pName, Store.plants[pName]?.workHours);
    const lines = changedLines
      ? [...changedLines].filter(l => Store.calendars[l] && Store.getPlantForLine(l) === pName)
      : Object.keys(Store.calendars).filter(l => Store.getPlantForLine(l) === pName);
    for (const line of lines) {
      CalendarSync.saveLineHours(pName, line, Store.calendars[line].workHours);
    }
  },

  _pillRightClick(d: number, e: MouseEvent): void {
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

    menu.querySelector('button')!.onclick = () => {
      const _pName = Store.selectedPlant!;
      menu.remove();
      if (wh) {
        Store.setPlantWorkHours(_pName, d, null, 'pill');
        Toast.show(Util.t('day.set_to_off', { day: dayName }), 'success');
      } else {
        Store.setPlantWorkHours(_pName, d, [8, 17], 'pill');
        Toast.show(Util.t('day.sun_enabled', { day: dayName }), 'success');
      }
      const changed = new Set<string>();
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

    const dismiss = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener('mousedown', dismiss); }
    };
    const dismissKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { menu.remove(); document.removeEventListener('keydown', dismissKey); }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', dismiss);
      document.addEventListener('keydown', dismissKey);
    }, 0);
  },

  /** Single-item "More info" context menu, cursor-positioned and
   *  viewport-clamped exactly like `_pillRightClick` above. Used by the
   *  Scheduling Rules pane (`_renderSettingsPane`) for both its compact
   *  `[data-rule-key]` rows and the Scheduling Constraints tree's
   *  `.constraint-row`s, whose inline per-field descriptions were both moved
   *  out of the always-visible flow and behind this menu. `titleText` and
   *  `bodyParas` must already be translated/escaped by the caller — this
   *  helper (and `_showFieldInfoPopover` below) render them as-is. */
  _openFieldInfoMenu(e: MouseEvent, anchorEl: HTMLElement, titleText: string, bodyParas: string[]): void {
    document.querySelector('.pill-ctx-menu')?.remove();

    const menu = document.createElement('div');
    menu.className = 'pill-ctx-menu';
    menu.innerHTML = `<button data-action="more-info">${Util.t('ui.more_info')}</button>`;

    menu.querySelector('button')!.onclick = () => {
      menu.remove();
      Plant._showFieldInfoPopover(anchorEl, titleText, bodyParas);
    };

    menu.style.left = e.clientX + 'px';
    menu.style.top  = e.clientY + 'px';
    document.body.appendChild(menu);

    requestAnimationFrame(() => {
      const r = menu.getBoundingClientRect();
      if (r.right  > window.innerWidth)  menu.style.left = (window.innerWidth  - r.width  - 6) + 'px';
      if (r.bottom > window.innerHeight) menu.style.top  = (window.innerHeight - r.height - 6) + 'px';
    });

    const dismiss = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener('mousedown', dismiss); }
    };
    const dismissKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { menu.remove(); document.removeEventListener('keydown', dismissKey); }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', dismiss);
      document.addEventListener('keydown', dismissKey);
    }, 0);
  },

  /** Anchored info popover: a field-name heading plus its (possibly
   *  multi-paragraph) description, opened from the "More info" menu item
   *  above. Positioned adjacent to the row that was right-clicked, clamped to
   *  the viewport, and dismissed the same way `_pillRightClick`'s menu is —
   *  outside `mousedown` or `Escape` — with only one popover open at a time. */
  _showFieldInfoPopover(anchorEl: HTMLElement, titleText: string, bodyParas: string[]): void {
    document.querySelector('.field-info-popover')?.remove();

    const pop = document.createElement('div');
    pop.className = 'field-info-popover';
    pop.innerHTML = `<h4>${titleText}</h4>${bodyParas.map(p => `<p>${p}</p>`).join('')}`;
    document.body.appendChild(pop);

    const anchorRect = anchorEl.getBoundingClientRect();
    pop.style.left = anchorRect.left + 'px';
    pop.style.top  = (anchorRect.bottom + 6) + 'px';

    requestAnimationFrame(() => {
      const r = pop.getBoundingClientRect();
      if (r.right  > window.innerWidth)  pop.style.left = Math.max(6, window.innerWidth  - r.width  - 6) + 'px';
      if (r.bottom > window.innerHeight) pop.style.top  = Math.max(6, anchorRect.top - r.height - 6) + 'px';
      if (parseFloat(pop.style.top) < 0) pop.style.top = '6px';
    });

    const dismiss = (ev: MouseEvent) => {
      if (!pop.contains(ev.target as Node)) { pop.remove(); document.removeEventListener('mousedown', dismiss); document.removeEventListener('keydown', dismissKey); }
    };
    const dismissKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { pop.remove(); document.removeEventListener('mousedown', dismiss); document.removeEventListener('keydown', dismissKey); }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', dismiss);
      document.addEventListener('keydown', dismissKey);
    }, 0);
  },

  _renderBlocks(): void {
    const list    = document.getElementById('plant-blocks-list');
    const statsEl = document.getElementById('plant-blocks-stats');
    if (!list) return;

    const selectedPlant = Store.selectedPlant;
    const blocks = selectedPlant ? (Store.plantBlocks || [])
      .filter(b => b.plant === selectedPlant).slice() : [];
    blocks.sort((a, b) => (Util.parseDate(a.start)?.getTime() || 0) - (Util.parseDate(b.start)?.getTime() || 0));

    if (statsEl) {
      if (blocks.length) {
        const totalDays = blocks.reduce((acc, b) =>
          acc + Math.ceil(((Util.parseDate(b.end)?.getTime() || 0) - (Util.parseDate(b.start)?.getTime() || 0)) / Config.MS_DAY), 0);
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

  _renderRoster(): void {
    const roster = document.getElementById('plant-lines-roster');
    if (!roster) return;
    const lines = Store.linesForSelectedPlant();
    const countEl = document.getElementById('plant-lines-count');
    if (countEl) countEl.textContent = Util.t('ui.lines_count', {count: lines.length, plural: lines.length !== 1 ? 's' : ''});

    if (!lines.length) {
      roster.innerHTML = `<div class="empty-state">${Util.t('empty.no_machine')}</div>`;
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
            ? `<span style="background:var(--warn,#93610a);color:#fff;font-size:11px;padding:2px 6px;border-radius:4px;">${Util.t('ui.bottleneck')}</span>`
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

    roster.querySelectorAll<HTMLInputElement>('.roster-plgroup-input').forEach(inp => {
      inp.onchange = () => {
        const val = inp.value.trim();
        const line = inp.dataset.line!;
        Store.setLineSetting(line, { plGroup: val }, 'plant-roster');
        NIMBUS!.MasterData!.syncLineSettings!(line, { plGroup: val });
        Toast.show(Util.t('toast.line_settings_updated'), 'success');
      };
    });

    const wrap = document.getElementById('plant-roster-wrap');
    const btn  = document.getElementById('plant-roster-toggle');
    if (wrap) wrap.style.display = Plant._rosterCollapsed ? 'none' : '';
    if (btn)  btn.textContent = Plant._rosterCollapsed ? '▼' : '▲';
  },

  openBlockModal(): void {
    const reasonEl = document.getElementById('plant-blk-reason') as HTMLInputElement | null;
    if (!reasonEl) { ErrorLog.error('ui', 'required DOM element missing: plant-blk-reason'); return; }

    const now = new Date(); now.setMinutes(0, 0, 0);
    const plus1 = new Date(now.getTime() + Config.MS_HOUR);
    if (!Plant._fpBlkStart) {
      Plant._fpBlkStart = Util.fpDatetime('#plant-blk-start');
      Plant._fpBlkEnd   = Util.fpDatetime('#plant-blk-end');
    }
    Plant._fpBlkStart!.setDate(now, false);
    Plant._fpBlkEnd!.setDate(plus1, false);
    reasonEl.value = '';
    Modal.open('modal-plant-block');
  },

  savePlantBlockFromModal(): void {
    const startEl = document.getElementById('plant-blk-start') as HTMLInputElement | null;
    const endEl = document.getElementById('plant-blk-end') as HTMLInputElement | null;
    const reasonEl = document.getElementById('plant-blk-reason') as HTMLInputElement | null;
    if (!startEl || !endEl || !reasonEl) { ErrorLog.error('ui', 'required DOM elements missing for plant blackout modal'); return; }

    const start  = Util.parseDate(startEl.value);
    const end    = Util.parseDate(endEl.value);
    const reason = reasonEl.value.trim() || Util.t('ui.plant_blackout_default');
    if (!start || !end) { Toast.show(Util.t('toast.please_set_start_end'), 'error'); return; }
    if (end <= start)   { Toast.show(Util.t('toast.end_must_be_after_start'), 'error'); return; }
    if (!Store.selectedPlant) { Toast.show(Util.t('toast.select_plant_first'), 'warn'); return; }
    const before = Store.plantBlocks.length;
    Store.addPlantBlock({ plant: Store.selectedPlant, start, end, reason } as NimbusPlantBlock, 'plant');
    if (Store.plantBlocks.length > before) CalendarSync.savePlantBlackoutUpsert(Store.plantBlocks[Store.plantBlocks.length - 1]);
    Modal.close('modal-plant-block');
    Toast.show(Util.t('toast.plant_blackout_added'), 'success');
  },

  removePlantBlock(id: string): void {
    // The rendered list is plant-scoped, but keep the write guard here too:
    // a stale DOM handler must never delete a blackout belonging to another plant.
    const plant = Store.selectedPlant;
    const blk = Store.plantBlocks.find(b => b.id === id && b.plant === plant);
    if (!blk || !plant) return;
    Store.removePlantBlock(id, 'plant');
    CalendarSync.savePlantBlackoutDelete(plant, id);
    Toast.show(Util.t('toast.plant_blackout_removed'), 'success');
  },

  /* ── Optimization Options section ── */

  _fetchAndRenderOptimization(plantName: string | null): void {
    const panel = document.getElementById('plant-opt-panel');
    if (!panel) return;
    const body = panel.querySelector('.panel-body');
    if (!plantName) {
      if (body) body.innerHTML = `<div class="cw-empty-hint">${Util.t('ui.select_plant_for_priority_lists')}</div>`;
      return;
    }
    if (body) body.innerHTML = `<div class="cw-loading"><span class="cw-spin"></span>${Util.t('ui.loading')}</div>`;

    // Util.fetchTraced (not bare fetch) — it auto-injects x-user-email/X-User,
    // which these three reads need for two reasons: GET /priority-lists and
    // GET /master-data/{plant}/missing-master-data resolve the caller's
    // role-scoped allowed-plants list from that header (auth.
    // get_allowed_plants_for_request) — an anonymous request resolves to
    // None/unrestricted, silently bypassing a plant-restricted user's own
    // role_plants scoping — and an r.ok check below needs a real response to
    // check, not a 403 body that parses as if it were valid data.
    // The missing-master-data read is the only optional one of the three (the
    // panel it feeds is supplementary), but its failure must still be
    // DISTINGUISHABLE from a successful empty report — hence the {ok, data}
    // envelope rather than the old `.catch(() => null)`, which collapsed both
    // into the same `null`.
    Promise.all([
      Util.fetchTraced(`${Config.API_BASE}/priority-fields`, { signal: AbortSignal.timeout(6000) }).then(_okJson),
      Util.fetchTraced(`${Config.API_BASE}/priority-lists?plant=${encodeURIComponent(plantName)}`, { signal: AbortSignal.timeout(6000) }).then(_okJson),
      Util.fetchTraced(`${Config.API_BASE}/master-data/${encodeURIComponent(plantName)}/missing-master-data`, { signal: AbortSignal.timeout(6000) })
        .then(_okJson)
        .then((data: MissingMasterDataReport) => ({ ok: true, data }),
              () => ({ ok: false, data: null as MissingMasterDataReport | null })),
    ])
      .then(([fieldsBody, listsBody, missing]) => {
        // Staleness guard. `plantName` is the plant THIS call was issued for;
        // Store.selectedPlant is the live selection. Switching plant A -> B -> A
        // fans out three overlapping Promise.all flights against unkeyed module
        // state, and a late A-response landing after B's render would leave the
        // tab showing A's cards while every wired action closes over the plant
        // the stale render painted — including Delete and Resync Now, the
        // latter running a real UPDATE orders (xmin bump, planner data loss) on
        // the wrong plant, and the line-override combobox offering the CURRENT
        // plant's lines for an upload targeting the stale one. Bail before
        // touching state or the DOM.
        if (plantName !== Store.selectedPlant) return;
        Plant._priorityFields = fieldsBody.fields || [];
        Plant._priorityLists = listsBody.fields || {};
        Plant._missingMasterData = missing.ok ? missing.data : null;
        Plant._missingDataOk = missing.ok;
        Plant._priorityLoadError = null;
        Plant._renderOptimization(plantName);
      })
      .catch((e: Error) => {
        if (plantName !== Store.selectedPlant) return;
        // Do NOT blank the tab. Emptying _priorityFields on any failure left a
        // completely inert panel — no dropzones, no cards, no error, no way to
        // upload anything — a regression from the pre-Stage-2 empty state. The
        // field registry is plant-independent (GET /priority-fields returns the
        // same rows for every plant), so a previously-loaded copy is still
        // valid; only fall back to the static registry when we've never had one.
        if (!Plant._priorityFields.length) Plant._priorityFields = _FALLBACK_PRIORITY_FIELDS.map(f => ({ ...f }));
        Plant._priorityLists = {};
        Plant._missingMasterData = null;
        Plant._missingDataOk = false;
        Plant._priorityLoadError = e?.message || 'unknown';
        ErrorLog.error('plant', `Priority-list load failed for ${plantName}: ${Plant._priorityLoadError}`);
        Plant._renderOptimization(plantName);
      });
  },

  _renderOptimization(plantName: string | null): void {
    const body = document.getElementById('plant-opt-body');
    if (!body) return;
    const relTime = (ts: string | null | undefined): string => {
      if (!ts) return Util.t('ui.unknown_time');
      const diff = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
      if (diff < 120)   return Util.t('ui.just_now');
      if (diff < 3600)  return Util.t('ui.mins_ago', { n: Math.floor(diff / 60) });
      if (diff < 86400) return Util.t('ui.hours_ago', { n: Math.floor(diff / 3600) });
      return Util.t('ui.days_ago', { n: Math.floor(diff / 86400) });
    };

    const fields = Plant._priorityFields || [];
    const lists  = Plant._priorityLists  || {};

    const fieldCardHtml = (f: { field_key: string; default_label: string }): string => {
      const summary = lists[f.field_key] || { plant_wide: null, machine_overrides: [], coverage: {} };
      // Util.t(key, vars?) — no fallback-string param (confirmed at
      // frontend/application-foundation.mts:556-562): it already falls back
      // en -> raw key on a missing translation, which is why Task 14 must
      // land the constraint.* keys in en.js at minimum. f.default_label is
      // the backend's own default (surfaced via GET /priority-fields) and is
      // NOT threaded through Util.t — it exists for API consumers that don't
      // have the locale bundle at all, not as an in-app i18n fallback.
      const label = Util.t(`constraint.${f.field_key}`);
      // The "not yet used in sequencing" badge that used to render here for every
      // non-colorWheel field was removed once Stage 3 wired ALL FOUR registered
      // fields into Engine._sortTerms (docs/scheduling_priority.md Stage 3) — it had
      // become a false statement on the very screen where an admin configures the
      // field. Deliberately removed rather than reworded: whether this card should
      // instead carry a "verify your coverage" caution is a separate copy decision.
      // PLANT_TOTAL_COVERAGE_KEY, not '' — see that constant's comment. The
      // ungrouped backend branch always returns a row for every field (0/0 for
      // a plant with no orders), so gate on distinct_values rather than key
      // presence to avoid rendering a meaningless "0/0 values ranked".
      const cov = summary.coverage[PLANT_TOTAL_COVERAGE_KEY] || null;
      const covHtml = cov && cov.distinct_values > 0
        ? `<div class="pl-coverage"><span class="pl-coverage-num">${cov.ranked_values}/${cov.distinct_values}</span> ${Util.t('ui.values_ranked')}</div>`
        : '';

      let activeOrDrop: string;
      if (summary.plant_wide) {
        const w = summary.plant_wide;
        activeOrDrop = `
          <div class="cw-active-card">
            <div class="cw-active-icon">${f.field_key === 'colorWheel' ? '🎨' : '🔧'}</div>
            <div class="cw-active-info">
              <div class="cw-active-name">${Util.escapeHtml(w.filename || '—')}</div>
              <div class="cw-active-meta">${w.row_count ?? '?'} ${Util.t('ui.values')} &middot; ${relTime(w.uploaded_at)} &middot; ${Util.escapeHtml(w.uploaded_by || 'system')}</div>
              ${covHtml}
            </div>
            <div class="cw-active-actions">
              <button class="btn btn-ghost sm" data-action="preview" data-field="${f.field_key}" data-line="">👁 ${Util.t('btn.preview')}</button>
              <button class="btn btn-ghost sm cw-delete-btn" data-action="delete" data-field="${f.field_key}" data-line="">⌫ ${Util.t('btn.remove')}</button>
            </div>
          </div>
          <div class="cw-dropzone cw-replace-zone" id="plant-pl-dropzone-${f.field_key}" data-field="${f.field_key}" title="${Util.t('ui.drop_to_replace')}">
            <div class="cw-drop-inner">
              <span class="cw-drop-icon">↻</span>
              <span class="cw-drop-text">${Util.t('ui.drop_replace_text')}</span>
              <input type="file" id="plant-pl-file-${f.field_key}" accept=".xlsx,.xls" style="display:none">
            </div>
          </div>`;
      } else {
        activeOrDrop = `
          <div class="cw-dropzone" id="plant-pl-dropzone-${f.field_key}" data-field="${f.field_key}">
            <div class="cw-drop-inner">
              <span class="cw-drop-icon">📂</span>
              <span class="cw-drop-text">${Util.t('ui.drop_list_text', { field: label })}</span>
              <div class="cw-drop-hint">${Util.t('ui.drop_list_hint')}</div>
              <input type="file" id="plant-pl-file-${f.field_key}" accept=".xlsx,.xls" style="display:none">
            </div>
          </div>`;
      }

      const overridesHtml = summary.machine_overrides.map(o => {
        // priority_list_coverage (db.py:2056) computes coverage PER LINE, not
        // just plant-wide — an override row that only ever showed row_count/
        // upload time would silently drop the one number `covHtml` above proves
        // is available and useful (the whole point of N3's per-line breakdown).
        const lineCov = summary.coverage[o.machine] || null;
        const lineCovHtml = lineCov
          ? `<span class="pl-coverage pl-override-coverage">${lineCov.ranked_values}/${lineCov.distinct_values} ${Util.t('ui.values_ranked')}</span>`
          : '';
        return `
        <div class="pl-override-row">
          <span class="pl-override-line">${Util.escapeHtml(o.machine)}</span>
          <span class="pl-override-meta">${o.row_count} ${Util.t('ui.values')} &middot; ${relTime(o.uploaded_at)}</span>
          ${lineCovHtml}
          <button class="btn btn-ghost sm" data-action="preview" data-field="${f.field_key}" data-line="${Util.escapeHtml(o.machine)}">👁</button>
          <button class="btn btn-ghost sm cw-delete-btn" data-action="delete" data-field="${f.field_key}" data-line="${Util.escapeHtml(o.machine)}">⌫</button>
        </div>`;
      }).join('');

      return `
        <div class="pl-field-card" data-field="${f.field_key}">
          <div class="pl-field-card-head">
            <h4>${Util.escapeHtml(label)}</h4>
          </div>
          ${activeOrDrop}
          <div class="pl-overrides">${overridesHtml}</div>
          <div class="pl-add-override" id="pl-add-override-${f.field_key}"></div>
          <div id="plant-pl-status-${f.field_key}" class="admin-status" style="margin-top:8px;"></div>
        </div>`;
    };

    // Visible, persistent inline banner (not a toast that vanishes) — an admin
    // must be able to tell "this plant genuinely has no lists uploaded" from
    // "we couldn't reach the server". `admin-status error` is this file's
    // established error-surfacing class (see _uploadPriorityList's status line).
    const loadErrHtml = Plant._priorityLoadError
      ? `<div class="admin-status error" style="margin-bottom:12px">${Util.escapeHtml(Util.t('ui.priority_lists_load_error', { msg: Plant._priorityLoadError }))}</div>`
      : '';
    // Only claim to know the exception count when the report actually loaded.
    // On failure say so, rather than letting the panel's absence read as "no
    // gaps" (which is exactly what a zero-exception success looks like). Skipped
    // when loadErrHtml is already up — that banner covers the whole-tab failure,
    // so a second one about the sub-report would just be noise.
    const missingErrHtml = (Plant._missingDataOk || Plant._priorityLoadError) ? '' :
      `<div class="admin-status warn" style="margin-top:12px">${Util.escapeHtml(Util.t('ui.mmd_load_error'))}</div>`;

    const missingHtml = Plant._missingDataOk && Plant._missingMasterData && Plant._missingMasterData.unmatched_pairs > 0 ? `
      <div class="pl-mmd-panel">
        <div class="pl-mmd-head">
          <h4>${Util.t('ui.missing_master_data_title')}</h4>
          <button class="btn btn-ghost sm" id="pl-mmd-export">${Util.t('btn.export_csv')}</button>
          <button class="btn btn-primary sm" id="pl-mmd-resync">${Util.t('btn.resync_now')}</button>
        </div>
        <p class="pl-mmd-sub">${Util.t('ui.missing_master_data_sub', { pairs: Plant._missingMasterData.unmatched_pairs, orders: Plant._missingMasterData.unmatched_orders })}</p>
        <div class="pl-mmd-list">
          ${Plant._missingMasterData.exceptions.slice(0, 20).map((e: { material_number: string; order_count: number; reason: string }) => `
            <div class="pl-mmd-row">
              <span class="pl-mmd-material">${Util.escapeHtml(e.material_number)}</span>
              <span class="pl-mmd-count">${e.order_count} ${Util.t('ui.orders')}</span>
              <span class="pl-mmd-reason">${Util.t(`ui.mmd_reason_${e.reason}`)}</span>
            </div>`).join('')}
          ${Plant._missingMasterData.exceptions.length > 20 ? `
            <div class="pl-mmd-more">${Util.t('ui.mmd_more_rows', { n: Plant._missingMasterData.exceptions.length - 20 })}</div>` : ''}
        </div>
      </div>` : '';

    body.innerHTML = loadErrHtml + fields.map(fieldCardHtml).join('') + missingHtml + missingErrHtml;

    // Wire dropzones (one per field) — see Task pattern at the old single-wheel wiring.
    fields.forEach(f => {
      const zone = document.getElementById(`plant-pl-dropzone-${f.field_key}`);
      const fileInput = document.getElementById(`plant-pl-file-${f.field_key}`) as HTMLInputElement | null;
      if (!zone || !fileInput) return;
      zone.onclick = e => { if (e.target !== fileInput) fileInput.click(); };
      fileInput.onchange = () => { if (fileInput.files![0]) Plant._uploadPriorityList(plantName, f.field_key, fileInput.files![0]); };
      zone.ondragover  = e => { e.preventDefault(); zone.classList.add('drag-over'); };
      zone.ondragleave = () => zone.classList.remove('drag-over');
      zone.ondrop = e => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        if (e.dataTransfer!.files.length > 1) {
          Toast.show(Util.t('toast.one_file_at_a_time'), 'warn');
          return;
        }
        const f0 = e.dataTransfer!.files[0];
        if (f0) Plant._uploadPriorityList(plantName, f.field_key, f0);
      };
    });

    // Wire preview/delete buttons.
    body.querySelectorAll<HTMLElement>('[data-action="preview"]').forEach(btn => {
      btn.addEventListener('click', () => PriorityListViewer.open(plantName!, btn.dataset.field!, btn.dataset.line || ''));
    });
    body.querySelectorAll<HTMLElement>('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', () => Plant._confirmDeletePriorityList(plantName!, btn.dataset.field!, btn.dataset.line || ''));
    });

    // Wire "+ add line override" combobox per field (Store.masterData lines for this plant).
    fields.forEach(f => {
      const host = document.getElementById(`pl-add-override-${f.field_key}`);
      if (!host) return;
      host.innerHTML = `<button class="btn btn-ghost sm" data-add-override="${f.field_key}">+ ${Util.t('ui.add_line_override')}</button>`;
      host.querySelector('button')!.addEventListener('click', () => {
        // Store.masterLinesForPlant(), NOT Store.linesForSelectedPlant(): this
        // dropdown feeds a VALIDATED upload. The backend checks the chosen line
        // against master_data.known_line_codes_for_plant(plant), which queries
        // `machine` only — while linesForSelectedPlant() also includes
        // line codes discovered on ORDER rows and in calendars/lineSettings, so
        // it could offer a line that 400s the moment the user picks it. Same
        // master-data-only source the Master Data grids use (see :2461, :2741).
        const lineNames = Store.masterLinesForPlant(plantName)
          .map(l => l.machine)
          .filter((l): l is string => !!l)
          .sort();
        host.innerHTML = `<div class="pl-override-combo"></div><input type="file" id="pl-override-file-${f.field_key}" accept=".xlsx,.xls" style="display:none">`;
        const comboHost = host.querySelector('.pl-override-combo') as HTMLElement;
        _mkCombobox(comboHost, lineNames, {
          placeholder: Util.t('ph.pick_a_line'),
          onSelect: (line: string) => {
            // The combobox's own clear (×) button calls onSelect(''); since
            // _uploadPriorityList only appends the `line` form field when
            // truthy, an empty line here would silently persist PLANT-WIDE
            // (overwriting the existing plant-wide list) while still
            // reporting "uploaded" success — bail instead of opening the
            // file dialog for a cleared/empty selection.
            if (!line) return;
            (document.getElementById(`pl-override-file-${f.field_key}`) as HTMLInputElement).onchange = (e) => {
              const file = (e.target as HTMLInputElement).files![0];
              if (file) Plant._uploadPriorityList(plantName, f.field_key, file, line);
            };
            (document.getElementById(`pl-override-file-${f.field_key}`) as HTMLInputElement).click();
          },
        });
      });
    });

    // Wire missing-master-data panel actions.
    document.getElementById('pl-mmd-export')?.addEventListener('click', () => {
      // GET /master-data/{plant}/missing-master-data is `Depends(require_admin)` —
      // window.open(url) sends no identity header, so the endpoint 403s and
      // the "download" is really a raw JSON error body landing in a new tab.
      // Route through Util.fetchTraced (identity header included) and turn
      // the response into a real file download via a temporary <a>, matching
      // the blob-download pattern already used by Printer.exportCsv /
      // AdminCockpit's diagnostics-bundle export elsewhere in this codebase.
      Util.fetchTraced(`${Config.API_BASE}/master-data/${encodeURIComponent(plantName!)}/missing-master-data?format=csv`)
        .then(r => r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then(blob => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `missing-master-data-${plantName}.csv`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        })
        .catch(e => Toast.show(Util.t('toast.export_failed', { msg: e.message }), 'error'));
    });
    document.getElementById('pl-mmd-resync')?.addEventListener('click', () => Plant._resyncOrderAttributes(plantName!));
  },

  _uploadPriorityList(plantName: string | null, fieldKey: string, file: File, line?: string): void {
    const status = document.getElementById(`plant-pl-status-${fieldKey}`);
    if (status) { status.textContent = Util.t('toast.uploading_file', { name: file.name }); status.className = 'admin-status info'; }

    const post = (extra: Record<string, string> = {}) => {
      const fd = new FormData();
      fd.append('file', file);
      if (line) fd.append('machine', line);
      Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
      return Util.fetchTraced(`${Config.API_BASE}/priority-list/${encodeURIComponent(plantName!)}/${encodeURIComponent(fieldKey)}`, {
        method: 'POST', body: fd,
      }).then(r => r.json());
    };

    const onNetworkError = (e: Error) => {
      if (status) { status.textContent = Util.t('toast.upload_failed', { msg: e.message }); status.className = 'admin-status error'; }
    };

    post().then(body => {
      if (body.status === 'needs_mapping') {
        PriorityListMapping.open(body.headers, body.sample,
          (valueCol: string, rankCol: string) => {
            post({ value_column: valueCol, rank_column: rankCol })
              .then(body2 => Plant._handleUploadResult(plantName, fieldKey, status, body2))
              .catch(onNetworkError);
          },
          // Cancelling the mapping modal ends the upload — clear the
          // "Uploading <file>…" line this function set before the
          // needs_mapping round-trip, which otherwise stayed on the card
          // forever, falsely implying an in-flight upload.
          () => { if (status) { status.textContent = ''; status.className = 'admin-status'; } });
        return;
      }
      Plant._handleUploadResult(plantName, fieldKey, status, body);
    }).catch(onNetworkError);
  },

  _handleUploadResult(plantName: string | null, fieldKey: string, status: HTMLElement | null, body: { status: string; message?: string; detail?: string; row_count?: number; replaced?: boolean }): void {
    // Every field card header resolves its label via Util.t('constraint.' + fieldKey)
    // (see fieldCardHtml above) — toasts/modals must do the same, or a raw
    // camelCase key ("prt01 list uploaded for 5512") leaks through next to
    // polished card copy ("Prod. Resource Tool (01)").
    const label = Util.t(`constraint.${fieldKey}`);
    if (body.status !== 'ok') {
      // Every rejection from this endpoint is a FastAPI HTTPException, whose
      // JSON body is {"detail": "..."}, not {"message": "..."} — reading
      // body.message alone showed "upload failed: unknown" for every real
      // failure (bad file format, unknown field key, empty file).
      const errMsg = body.detail || body.message || 'unknown';
      if (status) { status.textContent = Util.t('toast.upload_failed', { msg: errMsg }); status.className = 'admin-status error'; }
      ErrorLog.error('plant', `Priority list upload failed for ${plantName}/${fieldKey}: ${errMsg}`, body);
      return;
    }
    // Two whole keys, not one key with a {{verb}} placeholder: interpolating the
    // English literal 'uploaded'/'replaced' into a translated sentence produced
    // a mixed-language toast in every non-en locale (de: "…-Liste uploaded für
    // 5512"), and no language can be relied on to keep the verb in the same
    // slot anyway. The ErrorLog line below stays English — it's a developer log,
    // not user-visible copy.
    const key = body.replaced ? 'toast.priority_list_replaced' : 'toast.priority_list_uploaded';
    Toast.show(Util.t(key, { field: label, plant: plantName! }), 'success');
    ErrorLog.info('plant', `Priority list ${body.replaced ? 'replaced' : 'uploaded'} for ${plantName}/${fieldKey}: ${body.row_count} values`);
    Plant._fetchAndRenderOptimization(plantName);
    Persistence.loadPriorityRankMaps(plantName);  // keep Store in sync with what just changed
  },

  async _confirmDeletePriorityList(plantName: string, fieldKey: string, line: string): Promise<void> {
    const label = Util.t(`constraint.${fieldKey}`); // same-resolution rule as _handleUploadResult above
    const ok = await Modal.confirm({ title: Util.t('modal.remove_priority_list', { plant: plantName, field: label }), confirmLabel: Util.t('btn.yes_delete') });
    if (!ok) return;
    const qs = line ? `?machine=${encodeURIComponent(line)}` : '';
    Util.fetchTraced(`${Config.API_BASE}/priority-list/${encodeURIComponent(plantName)}/${encodeURIComponent(fieldKey)}${qs}`, {
      method: 'DELETE',
    })
      .then(r => r.json())
      .then(body => {
        if (body.status !== 'ok' && body.status !== 'not_found') {
          Toast.show(Util.t('toast.delete_failed'), 'error'); return;
        }
        Toast.show(Util.t('toast.priority_list_deleted', { plant: plantName, field: label }), 'success');
        Plant._fetchAndRenderOptimization(plantName);
        Persistence.loadPriorityRankMaps(plantName);  // keep Store in sync with what just changed
      })
      .catch(e => Toast.show(Util.t('toast.delete_failed_msg', { msg: e.message }), 'error'));
  },

  async _resyncOrderAttributes(plantName: string): Promise<void> {
    // Modal.confirm's real opts are {title, message, detail, confirmLabel, tone}
    // (frontend/application-foundation.mts:1289-1291) — its own header comment is
    // stale (documents an old callback-style signature); 'body' is not a field.
    const ok = await Modal.confirm({
      title: Util.t('modal.resync_title', { plant: plantName }),
      message: Util.t('modal.resync_warning'),
      confirmLabel: Util.t('btn.resync_now'),
      tone: 'warn',
    });
    if (!ok) return;
    Util.fetchTraced(`${Config.API_BASE}/master-data/resync-order-attributes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plant: plantName }),
    })
      // _okJson, not a bare r.json(): a 403 (not an admin / plant outside the
      // caller's role_plants) or a 500 still returns parseable JSON, which took
      // the success branch and showed "Resync complete — undefined materials
      // (undefined orders)…" as a green toast. Route it to the existing
      // toast.resync_failed path in .catch instead.
      .then(_okJson)
      .then(body => {
        Toast.show(Util.t('toast.resync_done', { pairs: body.unmatched_pairs, orders: body.unmatched_orders }), 'success');
        Plant._fetchAndRenderOptimization(plantName);
      })
      .catch(e => Toast.show(Util.t('toast.resync_failed', { msg: e.message }), 'error'));
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
  _renderSettingsPane(): void {
    const pane = document.getElementById('plant-tab-settings');
    if (!pane) return;
    const plantName = Store.selectedPlant;
    const plantRow: NimbusMasterPlant | null = Store._state.masterData?.plants?.find(p => p.plant === plantName) ?? null;
    // Values stored as total minutes in DB
    const alertHz = plantRow?.alt_flag_horizon   ?? Store.userSettings.alertHorizonMinutes   ?? 43200;
    const confHz  = plantRow?.conf_score_horizon ?? Store.userSettings.confidenceHorizonMinutes ?? 20160;

    const subTab = Plant._currentSettingsSubTab;
    const subTabVisibility = Plant._settingsSubTabVisibility(subTab);
    pane.innerHTML = `
        <nav class="admin-subtabs settings-inner-tabs" role="tablist">
          <button id="settings-subtab-rules-tab" class="sub-subtab${subTab === 'rules' ? ' active' : ''}" data-settings-subtab="rules" role="tab" aria-selected="${subTab === 'rules'}" aria-controls="settings-subtab-rules">${Util.t('ui.settings_subtab_rules')}</button>
          <button id="settings-subtab-setup-tab" class="sub-subtab${subTab === 'setup' ? ' active' : ''}" data-settings-subtab="setup" role="tab" aria-selected="${subTab === 'setup'}" aria-controls="settings-subtab-setup">${Util.t('ui.settings_subtab_setup')}</button>
        </nav>

      <div class="settings-content-scroll"><div class="cal-container settings-content-container">
        <div id="settings-subtab-rules" role="tabpanel" aria-labelledby="settings-subtab-rules-tab" style="display:${subTabVisibility.rules ? 'flex' : 'none'};flex-direction:column;gap:24px" ${subTabVisibility.rules ? '' : 'hidden'}>

          <!-- Compact SAP-MM03-style form (Scheduling Rules density pass,
               2026-08-21; regrouped into two named sections later the same day).
               The 8 stacked cards this used to be each carried an inline
               description paragraph, forcing a lot of scrolling to reach the
               constraint tree below. Every description now lives behind a
               right-click "More info" popover (see the contextmenu listener +
               RULE_HELP map above) instead of being permanently in the flow.
               Element ids, input types/min/max/step, and current-value
               population are unchanged — only the grouping, the two-per-row
               grid (.sched-rules-grid), and the three removals below.

               Removed from this pane deliberately, NOT relocated within it:
                 * Visibility Horizon      -> Admin ▸ Manage Data Tables ▸ plants
                 * Setup-Aware Optimization -> Admin ▸ Manage Data Tables ▸ plants
                   (both registered in column_metadata by
                    migrations/2026-08-21-plants-grid-visibility.sql; the Setup
                    Matrix header keeps its read-only status chip)
                 * Roll-forward hour (UTC) -> no UI at all. plants.
                   horizon_roll_hour_utc keeps its NOT NULL DEFAULT 19 and is
                   intentionally unregistered in the grid too, so it is now
                   SQL-only. Its POST /master-data/plants/{plant}/visibility-
                   horizon route still accepts it — that route is simply no
                   longer called from the frontend. -->
          <div class="panel">
            <header class="panel-head"><h3>${Util.t('ui.sched_section_horizons')}</h3></header>
            <div class="panel-body">
              <div class="sched-rules-grid">
                <div class="sched-rule-row" data-rule-key="alertHorizon">
                  <label for="sys-alert-horizon-days">${Util.t('ui.alert_horizon_title')}</label>
                  <input type="number" id="sys-alert-horizon-days" class="form-input" min="1" max="60" step="1" placeholder="0">
                  <span class="sched-rule-unit">${Util.t('ui.days')}</span>
                </div>

                <div class="sched-rule-row" data-rule-key="confHorizon">
                  <label for="sys-conf-horizon-days">${Util.t('ui.conf_horizon_title')}</label>
                  <input type="number" id="sys-conf-horizon-days" class="form-input" min="1" step="1" placeholder="0">
                  <span class="sched-rule-unit">${Util.t('ui.days')}</span>
                </div>

                <div class="sched-rule-row" data-rule-key="frozenHorizon">
                  <label for="sys-frozen-horizon-days">${Util.t('ui.frozen_horizon_title')}</label>
                  <input type="number" id="sys-frozen-horizon-days" class="form-input" min="0" step="1" inputmode="numeric" placeholder="${Util.t('ui.frozen_horizon_days_none')}">
                  <span class="sched-rule-unit">${Util.t('ui.days')}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="panel">
            <header class="panel-head"><h3>${Util.t('ui.sched_section_order_rules')}</h3></header>
            <div class="panel-body">
              <div class="sched-rules-grid">
                <div class="sched-rule-row" data-rule-key="maxPullForward">
                  <label for="sys-max-pull-forward-days">${Util.t('ui.max_pull_forward_title')}</label>
                  <input type="number" id="sys-max-pull-forward-days" class="form-input" min="0" step="1" inputmode="numeric" placeholder="${Util.t('ui.max_pull_forward_none')}">
                  <span class="sched-rule-unit">${Util.t('ui.days')}</span>
                </div>

                <div class="sched-rule-row" data-rule-key="maxPushForward">
                  <label for="sys-max-push-forward-days">${Util.t('ui.max_push_forward_title')}</label>
                  <input type="number" id="sys-max-push-forward-days" class="form-input" min="0" step="1" inputmode="numeric" placeholder="${Util.t('ui.max_push_forward_none')}">
                  <span class="sched-rule-unit">${Util.t('ui.days')}</span>
                </div>

                <div class="sched-rule-row" data-rule-key="minProductiveSegment">
                  <label for="sys-min-productive-segment-minutes">${Util.t('ui.min_productive_segment_title')}</label>
                  <input type="number" id="sys-min-productive-segment-minutes" class="form-input" min="1" step="1" inputmode="numeric">
                  <span class="sched-rule-unit">${Util.t('ui.unit_minutes')}</span>
                </div>

                <!-- Spans both grid columns: unlike its numeric siblings this is
                     a select whose longest option ("Allow partial orders across
                     operating intervals") needs roughly 50 characters, so a
                     half-width cell would truncate it. It starts flush left on
                     the row below the Productive Segment Floor row. -->
                <div class="sched-rule-row sched-rule-row--wide" data-rule-key="splitOrderPolicy">
                  <label for="sys-split-order-policy">${Util.t('ui.split_order_title')}</label>
                  <select id="sys-split-order-policy" class="form-input">
                    <option value="never">${Util.t('ui.split_order_opt_never')}</option>
                    <option value="overlong_only">${Util.t('ui.split_order_opt_overlong')}</option>
                    <option value="partial_allowed">${Util.t('ui.split_order_opt_partial')}</option>
                  </select>
                  <span class="sched-rule-unit"></span>
                </div>

                <!-- Wide for the same reason as splitOrderPolicy above: the
                     third option ("Send to Needs Planning until the matrix
                     row exists") needs the full row width. The minutes row
                     below is only shown when the select is set to
                     'plantDefaultMinutes'. -->
                <div class="sched-rule-row sched-rule-row--wide" data-rule-key="unknownSetupPolicy">
                  <label for="sys-unknown-setup-policy">${Util.t('ui.unknown_setup_title')}</label>
                  <select id="sys-unknown-setup-policy" class="form-input">
                    <option value="zero">${Util.t('ui.unknown_setup_opt_zero')}</option>
                    <option value="plantDefaultMinutes">${Util.t('ui.unknown_setup_opt_default')}</option>
                    <option value="excludeFromSearch">${Util.t('ui.unknown_setup_opt_exclude')}</option>
                  </select>
                  <span class="sched-rule-unit"></span>
                </div>
                <div class="sched-rule-row" data-rule-key="unknownSetupPolicy" id="sys-unknown-setup-minutes-row" hidden>
                  <label for="sys-unknown-setup-minutes">${Util.t('ui.unknown_setup_minutes_label')}</label>
                  <input type="number" id="sys-unknown-setup-minutes" class="form-input" min="0" step="1" inputmode="numeric">
                  <span class="sched-rule-unit">${Util.t('ui.unit_minutes')}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="panel">
            <header class="panel-head"><h3>${Util.t('ui.constraints_title')}</h3></header>
            <div class="panel-body">
              <p class="panel-help-text">${Util.t('ui.constraints_sub')}</p>
              <div id="sys-constraints-list" class="constraint-list"></div>
              <!-- Stage 3: the readout that keeps the presentational tree honest.
                   The tree above is nested; the optimizer runs a FLAT ordered key
                   list (Engine.flattenConstraints), so this shows exactly what
                   that collapse produces — including which nodes contribute
                   nothing. See docs/scheduling_priority.md, "Sub-sort model". -->
              <div class="pl-seq-block">
                <div class="pl-seq-title">${Util.t('ui.effective_sequence')}</div>
                <div id="sys-effective-sequence"></div>
              </div>
            </div>
          </div>

        </div>

        <!-- Stage 0 setup truth is maintained beside the plant's scheduling
             policy, never inside a timeline/optimizer flow. It remains
             observation-only until a later stage explicitly enables use. -->
        <div id="settings-subtab-setup" role="tabpanel" aria-labelledby="settings-subtab-setup-tab" style="display:${subTabVisibility.setup ? 'block' : 'none'}" ${subTabVisibility.setup ? '' : 'hidden'}>
          <div id="setup-admin-pane"></div>
        </div>

      </div></div>`;

    pane.querySelectorAll<HTMLButtonElement>('[data-settings-subtab]').forEach(button => button.addEventListener('click', () => {
      const next = button.dataset.settingsSubtab as 'rules' | 'setup';
      if (next === Plant._currentSettingsSubTab) return;
      Plant._currentSettingsSubTab = next;
      Plant._renderSettingsPane();
    }));

    // Scheduling Rules density pass (2026-08-21) — right-click "More info".
    // ONE delegated listener on the whole rules sub-tab, not one per row:
    // `#sys-constraints-list` (holding the `.constraint-row`s below) is
    // rebuilt by renderConstraints() on every toggle/add/remove/reorder, so a
    // per-row listener would need to be re-installed on every one of those
    // re-renders. Delegating from the stable `#settings-subtab-rules`
    // container (rebuilt only when _renderSettingsPane itself re-runs) means
    // this line never has to run again for the lifetime of the pane.
    const rulesSubtabEl = pane.querySelector<HTMLElement>('#settings-subtab-rules');
    rulesSubtabEl?.addEventListener('contextmenu', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const ruleRow = target.closest<HTMLElement>('[data-rule-key]');
      const consRow = target.closest<HTMLElement>('.constraint-row');
      if (!ruleRow && !consRow) return;

      if (ruleRow) {
        const info = RULE_HELP[ruleRow.dataset.ruleKey || ''];
        if (!info) return;
        e.preventDefault();
        Plant._openFieldInfoMenu(e, ruleRow, Util.t(info.title), info.help.map(k => Util.t(k)));
        return;
      }

      // `.constraint-row` — title from the same `_label(key)` helper the row
      // itself renders with; body from Engine._fieldDescriptions, the single
      // source setConstraintCatalog also draws `cat.desc` from. A key with no
      // registered description (e.g. a stored-but-unregistered field) gets no
      // menu at all rather than an empty popover.
      const path = consRow!.dataset.path;
      const hit = path ? _resolvePath(path) : null;
      if (!hit) return;
      const desc = Engine._fieldDescriptions[hit.node.key];
      if (!desc) return;
      e.preventDefault();
      // `Util.escapeHtml()`: a constraint key can be arbitrary JSONB-stored text,
      // and _label() falls back to echoing the raw key when neither the locale nor
      // the catalog recognizes it.
      Plant._openFieldInfoMenu(e, consRow!, Util.escapeHtml(_label(hit.node.key)), [Util.escapeHtml(desc)]);
    });

    const alertDaysInp = pane.querySelector('#sys-alert-horizon-days') as HTMLInputElement;
    const confDaysInp  = pane.querySelector('#sys-conf-horizon-days') as HTMLInputElement;
    const splitPolicySelect = pane.querySelector('#sys-split-order-policy') as HTMLSelectElement;
    const maxPullForwardInp = pane.querySelector('#sys-max-pull-forward-days') as HTMLInputElement;
    const maxPushForwardInp = pane.querySelector('#sys-max-push-forward-days') as HTMLInputElement;
    const minProductiveSegmentInp = pane.querySelector('#sys-min-productive-segment-minutes') as HTMLInputElement;
    const frozenHorizonDaysInp = pane.querySelector('#sys-frozen-horizon-days') as HTMLInputElement;
    const unknownSetupSelect = pane.querySelector('#sys-unknown-setup-policy') as HTMLSelectElement;
    const unknownSetupMinutesRow = pane.querySelector('#sys-unknown-setup-minutes-row') as HTMLElement;
    const unknownSetupMinutesInp = pane.querySelector('#sys-unknown-setup-minutes') as HTMLInputElement;

    alertDaysInp.value = String(Math.max(1, Math.round(alertHz / 1440)));
    confDaysInp.value  = String(Math.max(1, Math.round(confHz  / 1440)));
    const savedSplitPolicy = plantRow?.split_order_policy;
    splitPolicySelect.value = savedSplitPolicy === 'overlong_only' || savedSplitPolicy === 'partial_allowed'
      ? savedSplitPolicy : 'never';
    maxPullForwardInp.value = Number.isInteger(plantRow?.max_pull_forward_days) && (plantRow!.max_pull_forward_days as number) >= 0
      ? String(plantRow!.max_pull_forward_days) : '';
    maxPushForwardInp.value = Number.isInteger(plantRow?.max_push_forward_days) && (plantRow!.max_push_forward_days as number) >= 0
      ? String(plantRow!.max_push_forward_days) : '';
    minProductiveSegmentInp.value = Number.isInteger(plantRow?.min_productive_segment_minutes) && (plantRow!.min_productive_segment_minutes as number) > 0
      ? String(plantRow!.min_productive_segment_minutes) : '30';
    frozenHorizonDaysInp.value = Number.isInteger(plantRow?.frozen_horizon_days) && (plantRow!.frozen_horizon_days as number) >= 0
      ? String(plantRow!.frozen_horizon_days) : '';
    const readUnknownPolicy = (): UnknownSetupPolicy => {
      const v = plantRow?.setup_policy_config?.unknownSetupPolicy;
      return v === 'plantDefaultMinutes' || v === 'excludeFromSearch' ? v : 'zero';
    };
    const readUnknownMinutes = (): number => {
      const v = plantRow?.setup_policy_config?.unknownSetupDefaultMinutes;
      return Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0;
    };
    unknownSetupSelect.value = readUnknownPolicy();
    unknownSetupMinutesInp.value = String(readUnknownMinutes());
    unknownSetupMinutesRow.hidden = unknownSetupSelect.value !== 'plantDefaultMinutes';

    async function _savePlantHorizon(patch: Record<string, number>): Promise<boolean> {
      if (!plantRow) { Toast.show(Util.t('toast.no_plant_selected'), 'warn'); return false; }
      try {
        const r = await Util.fetchTraced(`${Config.API_BASE}/master-data/plants/bulk`, {
          method:  'POST',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify({ upserts: [{ subnetwork: plantRow.subnetwork, plant: plantRow.plant, ...patch }], deletes: [] }),
        });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || `HTTP ${r.status}`); }
        Object.assign(plantRow, patch); // commit to Store only once the write is confirmed
        return true;
      } catch (e) {
        Toast.show(Util.t('toast.horizon_save_failed', { msg: (e as Error).message }), 'error');
        return false;
      }
    }

    function readAlertMinutes(): number {
      const days = Math.max(1, parseInt(alertDaysInp.value, 10) || 1);
      return days * 1440;
    }

    function readConfMinutes(): number {
      const days = Math.max(1, parseInt(confDaysInp.value, 10) || 1);
      return days * 1440;
    }

    async function saveAlert(): Promise<void> {
      const prevMin = plantRow?.alt_flag_horizon ?? Store.userSettings.alertHorizonMinutes ?? 43200;
      const totalMin = readAlertMinutes();
      Store.setUserSettings({ alertHorizonMinutes: totalMin }, 'system-settings');
      const ok = await _savePlantHorizon({ alt_flag_horizon: totalMin });
      if (!ok) {
        Store.setUserSettings({ alertHorizonMinutes: prevMin }, 'system-settings');
        alertDaysInp.value = String(Math.max(1, Math.round(prevMin / 1440)));
      }
      AlertsUIAdapter.renderBell();
      if (document.getElementById('alert-drawer')?.classList.contains('open')) AlertsUIAdapter.renderDrawer();
    }

    async function saveConf(): Promise<void> {
      const prevMin = plantRow?.conf_score_horizon ?? Store.userSettings.confidenceHorizonMinutes ?? 20160;
      const totalMin = readConfMinutes();
      Store.setUserSettings({ confidenceHorizonMinutes: totalMin }, 'system-settings');
      const ok = await _savePlantHorizon({ conf_score_horizon: totalMin });
      if (!ok) {
        Store.setUserSettings({ confidenceHorizonMinutes: prevMin }, 'system-settings');
        confDaysInp.value = String(Math.max(1, Math.round(prevMin / 1440)));
      }
      if (typeof NIMBUS !== 'undefined' && NIMBUS.Confidence?._recomputeDebounced)
        NIMBUS.Confidence._recomputeDebounced();
    }

    alertDaysInp.addEventListener('change', saveAlert);
    confDaysInp.addEventListener('change', saveConf);

    splitPolicySelect.addEventListener('change', async () => {
      if (!plantRow) { Toast.show(Util.t('toast.no_plant_selected'), 'warn'); return; }
      const previous = plantRow.split_order_policy === 'overlong_only' || plantRow.split_order_policy === 'partial_allowed'
        ? plantRow.split_order_policy : 'never';
      const next = splitPolicySelect.value;
      if (!['never', 'overlong_only', 'partial_allowed'].includes(next)) {
        splitPolicySelect.value = previous;
        return;
      }
      splitPolicySelect.disabled = true;
      try {
        const response = await Util.fetchTraced(
          `${Config.API_BASE}/master-data/plants/${encodeURIComponent(plantRow.plant)}/split-order-policy`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
            body: JSON.stringify({ subnetwork: plantRow.subnetwork, split_order_policy: next }),
          },
        );
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.detail || `HTTP ${response.status}`);
        }
        plantRow.split_order_policy = next as 'never' | 'overlong_only' | 'partial_allowed';
        Toast.show(Util.t('ui.split_policy_saved'), 'success');
      } catch (error) {
        splitPolicySelect.value = previous;
        Toast.show(Util.t('ui.split_policy_save_failed', { msg: (error as Error).message }), 'error');
      } finally {
        splitPolicySelect.disabled = false;
      }
    });

    async function saveUnknownSetupPolicy(): Promise<void> {
      if (!plantRow) { Toast.show(Util.t('toast.no_plant_selected'), 'warn'); return; }
      const previousPolicy = readUnknownPolicy(); const previousMinutes = readUnknownMinutes();
      const policy = unknownSetupSelect.value;
      const raw = unknownSetupMinutesInp.value.trim();
      const minutes = raw === '' ? 0 : Number(raw);
      if (!Number.isInteger(minutes) || minutes < 0) {
        unknownSetupMinutesInp.value = String(previousMinutes);
        Toast.show(Util.t('ui.unknown_setup_minutes_invalid'), 'error');
        return;
      }
      unknownSetupMinutesRow.hidden = policy !== 'plantDefaultMinutes';
      unknownSetupSelect.disabled = true; unknownSetupMinutesInp.disabled = true;
      try {
        const response = await Util.fetchTraced(
          `${Config.API_BASE}/master-data/plants/${encodeURIComponent(plantRow.plant)}/unknown-setup-policy`,
          { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
            body: JSON.stringify({ subnetwork: plantRow.subnetwork, unknown_setup_policy: policy, unknown_setup_default_minutes: minutes }) },
        );
        if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.detail || `HTTP ${response.status}`); }
        const saved = await response.json();
        plantRow.setup_policy_config = { ...(plantRow.setup_policy_config ?? {}), ...saved.setup_policy_config };
        Toast.show(Util.t('ui.unknown_setup_saved'), 'success');
      } catch (error) {
        unknownSetupSelect.value = previousPolicy; unknownSetupMinutesInp.value = String(previousMinutes);
        unknownSetupMinutesRow.hidden = previousPolicy !== 'plantDefaultMinutes';
        Toast.show(`${Util.t('ui.unknown_setup_failed')}: ${(error as Error).message}`, 'error');
      } finally { unknownSetupSelect.disabled = false; unknownSetupMinutesInp.disabled = false; }
    }
    unknownSetupSelect.addEventListener('change', saveUnknownSetupPolicy);
    unknownSetupMinutesInp.addEventListener('change', saveUnknownSetupPolicy);

    maxPullForwardInp.addEventListener('change', async () => {
      if (!plantRow) { Toast.show(Util.t('toast.no_plant_selected'), 'warn'); return; }
      const previous = Number.isInteger(plantRow.max_pull_forward_days) && (plantRow.max_pull_forward_days as number) >= 0
        ? plantRow.max_pull_forward_days : null;
      const raw = maxPullForwardInp.value.trim();
      const next = raw === '' ? null : Number(raw);
      if (next !== null && (!Number.isInteger(next) || next < 0)) {
        maxPullForwardInp.value = previous === null ? '' : String(previous);
        Toast.show(Util.t('ui.max_pull_forward_invalid'), 'error');
        return;
      }
      maxPullForwardInp.disabled = true;
      try {
        const response = await Util.fetchTraced(
          `${Config.API_BASE}/master-data/plants/${encodeURIComponent(plantRow.plant)}/max-pull-forward-days`,
          { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
            body: JSON.stringify({ subnetwork: plantRow.subnetwork, max_pull_forward_days: next }) },
        );
        if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.detail || `HTTP ${response.status}`); }
        plantRow.max_pull_forward_days = next;
        Toast.show(Util.t('ui.max_pull_forward_saved'), 'success');
      } catch (error) {
        maxPullForwardInp.value = previous === null ? '' : String(previous);
        Toast.show(`${Util.t('ui.max_pull_forward_failed')}: ${(error as Error).message}`, 'error');
      } finally { maxPullForwardInp.disabled = false; }
    });

    maxPushForwardInp.addEventListener('change', async () => {
      if (!plantRow) { Toast.show(Util.t('toast.no_plant_selected'), 'warn'); return; }
      const previous = Number.isInteger(plantRow.max_push_forward_days) && (plantRow.max_push_forward_days as number) >= 0
        ? plantRow.max_push_forward_days : null;
      const raw = maxPushForwardInp.value.trim();
      const next = raw === '' ? null : Number(raw);
      if (next !== null && (!Number.isInteger(next) || next < 0)) {
        maxPushForwardInp.value = previous === null ? '' : String(previous);
        Toast.show(Util.t('ui.max_push_forward_invalid'), 'error');
        return;
      }
      maxPushForwardInp.disabled = true;
      try {
        const response = await Util.fetchTraced(
          `${Config.API_BASE}/master-data/plants/${encodeURIComponent(plantRow.plant)}/max-push-forward-days`,
          { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
            body: JSON.stringify({ subnetwork: plantRow.subnetwork, max_push_forward_days: next }) },
        );
        if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.detail || `HTTP ${response.status}`); }
        plantRow.max_push_forward_days = next;
        Toast.show(Util.t('ui.max_push_forward_saved'), 'success');
      } catch (error) {
        maxPushForwardInp.value = previous === null ? '' : String(previous);
        Toast.show(`${Util.t('ui.max_push_forward_failed')}: ${(error as Error).message}`, 'error');
      } finally { maxPushForwardInp.disabled = false; }
    });

    // B3 (2026-08-21): min_productive_segment_minutes — same fetch/toast/
    // revert shape as max-pull-forward-days above, but the column is NOT
    // NULL DEFAULT 30 (never null), so an empty/invalid entry reverts rather
    // than clearing to null.
    minProductiveSegmentInp.addEventListener('change', async () => {
      if (!plantRow) { Toast.show(Util.t('toast.no_plant_selected'), 'warn'); return; }
      const previous = Number.isInteger(plantRow.min_productive_segment_minutes) && (plantRow.min_productive_segment_minutes as number) > 0
        ? (plantRow.min_productive_segment_minutes as number) : 30;
      const raw = minProductiveSegmentInp.value.trim();
      const next = Number(raw);
      if (raw === '' || !Number.isInteger(next) || next <= 0) {
        minProductiveSegmentInp.value = String(previous);
        Toast.show(Util.t('ui.min_productive_segment_invalid'), 'error');
        return;
      }
      minProductiveSegmentInp.disabled = true;
      try {
        const response = await Util.fetchTraced(
          `${Config.API_BASE}/master-data/plants/${encodeURIComponent(plantRow.plant)}/min-productive-segment-minutes`,
          { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
            body: JSON.stringify({ subnetwork: plantRow.subnetwork, min_productive_segment_minutes: next }) },
        );
        if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.detail || `HTTP ${response.status}`); }
        plantRow.min_productive_segment_minutes = next;
        Toast.show(Util.t('ui.min_productive_segment_saved'), 'success');
      } catch (error) {
        minProductiveSegmentInp.value = String(previous);
        Toast.show(`${Util.t('ui.min_productive_segment_failed')}: ${(error as Error).message}`, 'error');
      } finally { minProductiveSegmentInp.disabled = false; }
    });

    // C2 (2026-08-20): frozen_horizon_days — same fetch/toast/revert shape as
    // max-pull-forward-days above, but NULL/0 both mean "off" (unlike C1's
    // visibility_horizon_days) — so an explicit "0" is a VALID, non-null save,
    // not normalized away here or server-side (master_data.set_plant_frozen_horizon_days).
    frozenHorizonDaysInp.addEventListener('change', async () => {
      if (!plantRow) { Toast.show(Util.t('toast.no_plant_selected'), 'warn'); return; }
      const previous = Number.isInteger(plantRow.frozen_horizon_days) && (plantRow.frozen_horizon_days as number) >= 0
        ? plantRow.frozen_horizon_days : null;
      const raw = frozenHorizonDaysInp.value.trim();
      const next = raw === '' ? null : Number(raw);
      if (next !== null && (!Number.isInteger(next) || next < 0)) {
        frozenHorizonDaysInp.value = previous === null ? '' : String(previous);
        Toast.show(Util.t('ui.frozen_horizon_days_invalid'), 'error');
        return;
      }
      frozenHorizonDaysInp.disabled = true;
      try {
        const response = await Util.fetchTraced(
          `${Config.API_BASE}/master-data/plants/${encodeURIComponent(plantRow.plant)}/frozen-horizon-days`,
          { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
            body: JSON.stringify({ subnetwork: plantRow.subnetwork, frozen_horizon_days: next }) },
        );
        if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.detail || `HTTP ${response.status}`); }
        plantRow.frozen_horizon_days = next;
        Toast.show(Util.t('ui.frozen_horizon_days_saved'), 'success');
      } catch (error) {
        frozenHorizonDaysInp.value = previous === null ? '' : String(previous);
        Toast.show(`${Util.t('ui.frozen_horizon_days_failed')}: ${(error as Error).message}`, 'error');
      } finally { frozenHorizonDaysInp.disabled = false; }
    });

    // The visibility-horizon pair (C1, 2026-08-20) and the relocated
    // setup-active checkbox (D2, 2026-08-20) both had their change handlers
    // here until the two-section pass (2026-08-21) removed their rows — see the
    // markup comment above for where each setting is maintained now.
    // `SetupAdmin.setSetupActive` is deliberately left in place on SetupAdmin's
    // exported surface even though this was its only caller.

    // --- Scheduling constraints (per-plant PRIORITY TREE) -------------------
    // Stage 3 of docs/scheduling_priority.md rebuilt this from a flat on/off
    // list into an indented tree: a field can be nested under another field to
    // sub-sort within it. Per that doc's "Sub-sort model" decision the tree is
    // presentational — a field nested under a field is mathematically
    // identical to the next key in a lexicographic sort — so
    // Engine.flattenConstraints is the SINGLE source of truth for the collapse
    // (pre-order DFS, disabled subtrees skipped, duplicate keys dropped) and
    // is deliberately NOT reimplemented here. The "Effective sequence" panel
    // below the tree is what keeps the nesting honest rather than a fiction.
    //
    // DATA-LOSS FIX — the reason this block is a rewrite rather than an
    // extension. The flat version rebuilt its in-memory state by mapping over
    // Engine.CONSTRAINT_CATALOG and serialized each node as
    // `{key, enabled, order}` with no `children`. So ANY save from this panel
    // (even an unrelated toggle) silently (a) flattened a stored nested tree
    // and (b) dropped every stored key the local catalog didn't happen to
    // list. Both directions are now tree-shaped end to end: `_cloneTree`
    // preserves whatever shape the backend returned, including unknown keys,
    // and `_serializeTree` emits `children` recursively.
    const consListEl = pane.querySelector('#sys-constraints-list') as HTMLElement | null;
    const seqPanelEl = pane.querySelector('#sys-effective-sequence') as HTMLElement | null;
    // Mirrors master_data._normalize_constraint_tree's own cap: a deeper tree
    // is rejected server-side, so the UI must never offer to build one.
    const MAX_DEPTH = 3;
    let consTree: ConstraintConfig[] = [];
    // null = unknown (the rank-map probe has not succeeded for this plant yet).
    // Only `true` licenses the per-node "no list uploaded" hints below — see
    // applyRankHints; asserting "no list" off a failed probe is exactly what the
    // old `.catch(() => {})` avoided.
    let _ranksLoaded: boolean | null = null;

    // Same escape used elsewhere in this file. Constraint keys are normally
    /** Display label for a constraint key. Locale first (Stage 2 registered
     *  `constraint.<field_key>` for all five locales); Util.t echoes the key
     *  back when there's no entry, in which case the backend registry's own
     *  `default_label` reads far better than a raw `constraint.prtXX`. */
    function _label(key: string): string {
      const s = Util.t(`constraint.${key}`);
      if (s !== `constraint.${key}`) return s;
      return Engine.CONSTRAINT_CATALOG.find(c => c.key === key)?.label || key;
    }

    /** Deep clone of a persisted tree, dropping NOTHING — nested `children`
     *  and keys absent from the local catalog both survive verbatim (see the
     *  DATA-LOSS FIX note above). Each sibling group is sorted by `order` with
     *  the same `?? 99` fallback and stable tie-break Engine.flattenConstraints
     *  uses, so the on-screen order can never disagree with the order the
     *  optimizer walks. */
    function _cloneTree(nodes: ConstraintConfig[]): ConstraintConfig[] {
      return [...nodes]
        .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
        .map(n => {
          const out: ConstraintConfig = {
            key:     String(n.key),
            enabled: !!n.enabled,
            order:   Number.isFinite(n.order) ? n.order! : 99,
          };
          if (Array.isArray(n.children) && n.children.length) out.children = _cloneTree(n.children);
          return out;
        });
    }

    /** Renumber every sibling group's `order` to 1..n in place — the tree
     *  counterpart of the flat version's
     *  `consState.forEach((c, idx) => { c.order = idx + 1; })`. */
    function _renumberTree(nodes: ConstraintConfig[]): void {
      nodes.forEach((n, i) => { n.order = i + 1; if (n.children) _renumberTree(n.children); });
    }

    /** Wire payload for the whole tree: `{key, enabled, order}` PLUS a
     *  recursive `children` array wherever one exists. This is the half the
     *  flat version was missing, and the reason a save used to flatten a
     *  stored tree. Empty `children` arrays (left behind by removing a node's
     *  last child) are omitted rather than persisted as `[]`. */
    function _serializeTree(nodes: ConstraintConfig[]): ConstraintConfig[] {
      return nodes.map(n => {
        const out: ConstraintConfig = { key: n.key, enabled: !!n.enabled, order: n.order ?? 0 };
        if (n.children && n.children.length) out.children = _serializeTree(n.children);
        return out;
      });
    }

    /** Resolve a row's `data-path` ("0.2.1" => consTree[0].children[2].children[1])
     *  to its node, the sibling array holding it, and its index there.
     *  Handlers address nodes by PATH, not by key: the same key may legally
     *  appear more than once in the tree (that's how `PRT01 -> Color` is
     *  expressed, with the repeat marked "(no effect)"), so `data-key` would
     *  be ambiguous and would toggle/move the wrong node. */
    function _resolvePath(path: string): { node: ConstraintConfig; siblings: ConstraintConfig[]; index: number } | null {
      const parts = path.split('.').map(Number);
      let siblings: ConstraintConfig[] = consTree;
      for (let d = 0; d < parts.length; d++) {
        const node = siblings[parts[d]];
        if (!node) return null;
        if (d === parts.length - 1) return { node, siblings, index: parts[d] };
        if (!node.children) return null;
        siblings = node.children;
      }
      return null;
    }

    /** Distinct keys anywhere in the tree — the bound on how large the tree
     *  may grow (one node per registered field, plus any duplicates added
     *  before that bound was reached). */
    function countConfiguredKeys(nodes: ConstraintConfig[]): number {
      const keys = new Set<string>();
      const walk = (ns: ConstraintConfig[]): void => { for (const n of ns) { keys.add(n.key); if (n.children) walk(n.children); } };
      walk(nodes);
      return keys.size;
    }

    function renderEffectiveSequence(): void {
      if (!seqPanelEl) return;
      // flattenConstraints reads the plant's PERSISTED tree
      // (Store.masterData.plants[*].constraints) — the very same source
      // Engine._sortTerms ranks from. That is deliberate: this panel states
      // what the optimizer would do right now, not what an unsaved edit hopes
      // for. saveConstraints() re-renders it the moment a write is confirmed
      // (and reverts the whole tree if the write fails), so it converges
      // within one round trip and can never assert an edit that didn't land.
      const flat = Engine.flattenConstraints(plantName);
      // Which NODES of the tree on screen are the occurrences that actually take
      // effect — computed by Engine's own single tree walk (the very one
      // flattenConstraints runs), keyed by positional path.
      //
      // This replaces a `flat.includes(key) && !seen.has(key)` test that could
      // not distinguish two occurrences of the same key and so credited whichever
      // came FIRST in tree order. With a disabled duplicate ahead of an enabled
      // one — e.g. [prt01(on), colorWheel(OFF), prt02(on), colorWheel(on)],
      // whose real optimizer order is prt01 -> prt02 -> colorWheel — it labelled
      // the switched-OFF row "effective" (right beside its own Off toggle) and
      // the switched-ON row "(no effect)": exactly backwards, in the one panel
      // whose whole job is to tell the truth about the collapse.
      const effectivePaths = Engine.effectiveConstraintPaths(consTree);
      const arrow = ` <span class="pl-seq-arrow">&rarr;</span> `;
      const nodesInTreeOrder: Array<{ key: string; path: string }> = [];
      const collect = (nodes: ConstraintConfig[], prefix: string): void => {
        nodes.forEach((n, i) => {
          const path = prefix ? `${prefix}.${i}` : String(i);
          nodesInTreeOrder.push({ key: n.key, path });
          if (n.children) collect(n.children, path);
        });
      };
      collect(consTree, '');

      if (!nodesInTreeOrder.length) {
        // An empty tree is not necessarily "no constraints": for a plant with
        // nothing stored, flattenConstraints falls back to the catalog default
        // (colorWheel on) and the optimizer really does apply it. Show that
        // fallback rather than claiming nothing is in effect.
        seqPanelEl.innerHTML = flat.length
          ? flat.map(k => `<span class="pl-seq-chip">${Util.escapeHtml(_label(k))}</span>`).join(arrow)
          : `<span class="pl-seq-empty">${Util.escapeHtml(Util.t('ui.no_constraints_configured'))}</span>`;
        return;
      }

      seqPanelEl.innerHTML = nodesInTreeOrder.map(({ key, path }) => {
        // Not effective => this node (or an ancestor) is switched off, or another
        // reachable occurrence of the same key already claimed the slot, or the
        // key is not in the PERSISTED tree yet (an unsaved add — `flat` is the
        // persisted collapse, so a pending edit can never claim to be in force).
        const isEffective = effectivePaths.has(path) && flat.includes(key);
        return `<span class="pl-seq-chip${isEffective ? '' : ' pl-seq-chip-noeffect'}">${Util.escapeHtml(_label(key))}`
             + `${isEffective ? '' : ` <em>(${Util.escapeHtml(Util.t('ui.no_effect'))})</em>`}</span>`;
      }).join(arrow);
    }

    /** The field picker behind "+ Add sub-priority" / "+ Add priority" — a
     *  native <select>, not a button, for two reasons:
     *    1. The user must be able to CHOOSE the field, including one already
     *       used elsewhere in the tree (that's the only way to express
     *       `PRT01 -> Color`); a button auto-picking "the first unused field"
     *       could not build that tree at all.
     *    2. CLAUDE.md's production-scale rule: a plant/line/field list must
     *       never become a bubble/chip selector. A <select> is the shape that
     *       upgrades cleanly to a searchable combobox if the registry grows.
     *  Disabled once every registered field already appears somewhere in the
     *  tree — the tree's own size bound. */
    function _addPicker(cls: string, enabled: boolean, placeholder: string): string {
      const opts = Engine.CONSTRAINT_CATALOG
        .map(c => `<option value="${Util.escapeHtml(c.key)}">${Util.escapeHtml(_label(c.key))}</option>`).join('');
      return `<select class="cons-add ${cls}" ${enabled ? '' : 'disabled'}`
           + ` title="${Util.escapeHtml(enabled ? placeholder : Util.t('ui.all_fields_used'))}">`
           + `<option value="" selected>+ ${Util.escapeHtml(placeholder)}</option>${opts}</select>`;
    }

    function renderConstraints(): void {
      if (!consListEl) return;
      // One node per registered field is the ceiling: past that, every
      // additional node is a guaranteed duplicate, which flattenConstraints
      // drops anyway.
      const canAddAnywhere = countConfiguredKeys(consTree) < Engine.CONSTRAINT_CATALOG.length;

      const renderNode = (node: ConstraintConfig, siblings: ConstraintConfig[], depth: number, path: string): string => {
        // "Enabled but no list uploaded", for EVERY rankable field, not just
        // colorWheel (N11, docs/scheduling_priority.md). Since Stage 3 every
        // enabled node contributes a real sort term, so any of them can be
        // silently inert. Gated on `_ranksLoaded === true` so a failed probe
        // shows nothing rather than asserting "no list", and on node.enabled
        // because a switched-off row's missing list is not a problem to flag.
        const noList = (_ranksLoaded === true && node.enabled && !Engine.hasPriorityRanks(node.key));
        const idx = siblings.indexOf(node);
        // At the deepest allowed level the add-child control is omitted
        // outright rather than rendered disabled — there is no honest tooltip
        // for "this is as deep as the data model goes" that isn't noise on
        // every leaf, and the server would reject the write regardless.
        const canNest = depth + 1 < MAX_DEPTH;
        // Children are rendered as DOM siblings with a left margin, not nested
        // inside the parent row: .constraint-list is a flex column, and a flat
        // row list keeps the per-row querySelector wiring below unambiguous.
        const childrenHtml = (node.children || [])
          .map((c, ci) => renderNode(c, node.children!, depth + 1, `${path}.${ci}`)).join('');
        return `
          <div class="constraint-row" data-path="${path}" data-depth="${depth}" style="margin-left:${depth * 24}px">
            <div class="cons-reorder">
              <button class="cons-up" ${idx === 0 ? 'disabled' : ''} title="${Util.escapeHtml(Util.t('ui.move_up'))}">&#9650;</button>
              <button class="cons-dn" ${idx === siblings.length - 1 ? 'disabled' : ''} title="${Util.escapeHtml(Util.t('ui.move_down'))}">&#9660;</button>
            </div>
            <div class="cons-meta">
              <div class="cons-label">${Util.escapeHtml(_label(node.key))}</div>
              <!-- Scheduling Rules density pass (2026-08-21): the field
                   description that used to render here unconditionally moved
                   to the right-click "More info" popover (see the
                   contextmenu listener above, reading
                   Engine._fieldDescriptions). The "no list uploaded" warning
                   is left in place -- it's an active, actionable alert about
                   THIS row's current state, not reference documentation. -->
              ${noList ? `<div class="cons-desc"><span class="cons-warn">${Util.escapeHtml(Util.t('ui.constraint_no_list'))}</span></div>` : ''}
            </div>
            <label class="cons-toggle">
              <input type="checkbox" ${node.enabled ? 'checked' : ''}>
              <span>${Util.escapeHtml(Util.t(node.enabled ? 'ui.constraint_on' : 'ui.constraint_off'))}</span>
            </label>
            ${canNest ? _addPicker('cons-add-child', canAddAnywhere, Util.t('ui.add_sub_priority')) : ''}
            <button class="btn btn-ghost sm cons-remove" title="${Util.escapeHtml(Util.t('btn.remove'))}">${Util.escapeHtml(Util.t('btn.remove'))}</button>
          </div>
          ${childrenHtml}`;
      };

      // The root-level picker is not optional garnish: without it, removing
      // every row (or opening a plant whose stored tree omits a field) would
      // leave no way to put a field back.
      consListEl.innerHTML = consTree.map((n, i) => renderNode(n, consTree, 0, String(i))).join('')
        + `<div class="constraint-add-row">${_addPicker('cons-add-root', canAddAnywhere, Util.t('ui.add_priority'))}</div>`;

      consListEl.querySelectorAll<HTMLElement>('.constraint-row').forEach(rowEl => {
        const path = rowEl.dataset.path!;
        rowEl.querySelector<HTMLInputElement>('.cons-toggle input')!.addEventListener('change', e => {
          const hit = _resolvePath(path);
          if (hit) hit.node.enabled = (e.target as HTMLInputElement).checked;
          renderConstraints();
          saveConstraints();
        });
        rowEl.querySelector('.cons-up')!.addEventListener('click', () => moveConstraint(path, -1));
        rowEl.querySelector('.cons-dn')!.addEventListener('click', () => moveConstraint(path, +1));
        rowEl.querySelector('.cons-remove')!.addEventListener('click', () => removeConstraint(path));
        rowEl.querySelector<HTMLSelectElement>('.cons-add-child')?.addEventListener('change', e => {
          const sel = e.target as HTMLSelectElement;
          const key = sel.value;
          sel.value = '';  // the picker is a control, not a state holder
          if (key) addConstraint(path, key);
        });
      });
      consListEl.querySelector<HTMLSelectElement>('.cons-add-root')?.addEventListener('change', e => {
        const sel = e.target as HTMLSelectElement;
        const key = sel.value;
        sel.value = '';
        if (key) addConstraint(null, key);
      });

      renderEffectiveSequence();
    }

    /** Reorder within the sibling group only — moving a node between levels is
     *  what the remove/add pair is for. */
    function moveConstraint(path: string, dir: number): void {
      const hit = _resolvePath(path);
      if (!hit) return;
      const j = hit.index + dir;
      if (j < 0 || j >= hit.siblings.length) return;
      [hit.siblings[hit.index], hit.siblings[j]] = [hit.siblings[j], hit.siblings[hit.index]];
      renderConstraints();
      saveConstraints();
    }

    /** Removes the node AND its subtree: those children were sub-sorts *of*
     *  this node, so re-parenting them to the grandparent would silently
     *  rewrite the effective sequence into something the user never asked
     *  for. */
    function removeConstraint(path: string): void {
      const hit = _resolvePath(path);
      if (!hit) return;
      hit.siblings.splice(hit.index, 1);
      renderConstraints();
      saveConstraints();
    }

    /** Append a node — at the root when `parentPath` is null, otherwise as the
     *  last child of that node. Enabled on creation (you added it because you
     *  want it); a child added under a switched-off parent is born inert,
     *  which the parent's own "Ignored" label and the child's "(no effect)"
     *  chip both state plainly, so the parent's state is left alone rather
     *  than silently flipped on. */
    function addConstraint(parentPath: string | null, key: string): void {
      const node: ConstraintConfig = { key, enabled: true, order: 99 };
      if (parentPath === null) {
        consTree.push(node);
      } else {
        const hit = _resolvePath(parentPath);
        if (!hit) return;
        if (!hit.node.children) hit.node.children = [];
        hit.node.children.push(node);
      }
      renderConstraints();
      saveConstraints();
    }

    /** Rebuild the working tree from the last-known-persisted
     *  plantRow.constraints, PRESERVING its shape verbatim — nesting and
     *  unknown keys both survive (the flat version mapped over
     *  Engine.CONSTRAINT_CATALOG instead, which is exactly what destroyed
     *  both). Only a plant that has never been configured falls back to the
     *  catalog, and then seeded with its ENABLED defaults only — the exact
     *  mirror of Engine.flattenConstraints' own never-configured fallback
     *  (`CONSTRAINT_CATALOG.filter(constraintEnabled).map(key)`), so the tree
     *  on screen and the sequence the optimizer runs agree from the very first
     *  render.
     *
     *  The flat version instead seeded ALL catalog keys (with the unused ones
     *  rendered as inert "Ignored" rows). That cannot carry over: with every
     *  registered field already in the tree, `countConfiguredKeys(consTree) <
     *  CONSTRAINT_CATALOG.length` is false on the very first render, so every
     *  "+ Add sub-priority" picker would be born disabled and NO plant could
     *  ever be nested. Seeding only the enabled defaults leaves the unused
     *  fields one pick away in the root "+ Add priority" control instead of
     *  occupying a slot to say they're off.
     *
     *  Shared by init and by saveConstraints' failure path, since
     *  plantRow.constraints is only mutated once a write is confirmed — it is
     *  always the truth to revert to. */
    function rebuildConsTreeFromPersisted(): void {
      const stored: ConstraintConfig[] | null = Array.isArray(plantRow?.constraints) ? plantRow!.constraints! : null;
      consTree = (stored && stored.length)
        ? _cloneTree(stored)
        : Engine.CONSTRAINT_CATALOG
            .filter(cat => Engine.constraintEnabled(plantName, cat.key))
            .map((cat, i) => ({ key: cat.key, enabled: true, order: i + 1 }));
    }

    async function saveConstraints(): Promise<void> {
      if (!plantRow) { Toast.show(Util.t('toast.no_plant_selected'), 'warn'); return; }
      _renumberTree(consTree);
      const payload = _serializeTree(consTree);  // full tree, `children` included
      try {
        const r = await Util.fetchTraced(`${Config.API_BASE}/master-data/plants/${encodeURIComponent(plantRow.plant)}/constraints`, {
          method:  'POST',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify({ subnetwork: plantRow.subnetwork, constraints: payload }),
        });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || `HTTP ${r.status}`); }
        plantRow.constraints = payload;  // commit to Store only once the write is confirmed
        renderEffectiveSequence();       // the persisted tree just changed — re-read it
      } catch (e) {
        Toast.show(Util.t('toast.constraints_save_failed', { msg: (e as Error).message }), 'error');
        rebuildConsTreeFromPersisted();
        renderConstraints();
      }
    }

    (function initConstraints() {
      rebuildConsTreeFromPersisted();
      renderConstraints();
      // Whether each enabled field actually has a list uploaded (hint only — the
      // toggles work regardless, since enabling a field with no list is a
      // harmless no-op: every rank lookup just returns 999999).
      //
      // Stage 3: reads the same Store.priorityRankMaps that Engine._sortTerms
      // ranks from, via the shared Engine.hasPriorityRanks, instead of the old
      // plant-wide-only `GET /color-wheel/{plant}` probe. Two reasons: this hint
      // and OptimizeDialog's badge / pre-Run confirm were two independent
      // readings of "does this plant have a list" that could disagree, and the
      // narrow probe mis-reported a plant configured purely with per-line
      // overrides as having none. `plantName` is Store.selectedPlant (see above),
      // so the shared non-plant-keyed cache is always the right one to read here.
      //
      // One flag for the whole tree, not one per field: `_ranksLoaded` records
      // only whether the CACHE is trustworthy; renderNode then asks
      // Engine.hasPriorityRanks per node, so a field added to the tree later in
      // this same session picks its hint up on the next render with no refetch.
      if (plantName) {
        const applyRankHints = () => {
          if (Persistence._rankMapsPlant !== plantName) return;
          _ranksLoaded = true;
          renderConstraints();
        };
        if (Persistence._rankMapsPlant === plantName) applyRankHints();
        else Persistence.loadPriorityRankMaps(plantName).then(applyRankHints);
      }
    })();
    SetupAdmin.render(pane.querySelector<HTMLElement>('#setup-admin-pane'), plantName);
  },
};

/** `ProdLines._wireNav`'s search input carries a one-time-wiring flag, the same
 *  DOM-custom-property pattern as `Util.wirePasteToCheckboxes`'s `PasteWiredInput`
 *  (application-foundation.mts). */
type LinesNavInput = HTMLInputElement & { _wired?: boolean };

/* =============================================================================
   PRODLINES — per-line settings: capacity buffer, bottleneck, working hours,
   and line-scoped blackout blocks.
   ========================================================================== */
export const ProdLines = {
  _lineSearch: '', // search text for the cross-screen line-filter dropdown (not the selection itself)
  _activeNavLine: null as string | null,
  _delegated: false,
  _fpBlkStart: null as NimbusVendor.FlatpickrInstance | null,
  _fpBlkEnd: null as NimbusVendor.FlatpickrInstance | null,

  render(): void {
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

    // Cross-screen production-line filter (Store.selectedLines) — same
    // selection as the Scheduling Board / Dashboard / Labor Plan pickers.
    // Type-to-filter within the dropdown itself (ProdLines._lineSearch)
    // narrows the checklist, not this nav list directly.
    const lineSel = Store.selectedLines;
    const shownLines = lineSel.size === 0 ? allLines : allLines.filter(l => lineSel.has(l));

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

  _renderDetail(line: string | null): void {
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
        <span class="ld-buffer">
          <span class="ld-buffer-label">SAP Work Center</span>
          <div class="sap-workcenter-combo" id="sap-workcenter-combo-${line}" style="width:140px;"></div>
        </span>
        <span class="ld-buffer">
          <span class="ld-buffer-label">Distribution Weight</span>
          <input type="text" class="input distribution-weight-input" style="width:140px;" value="${(ls.distributionWeight != null ? ls.distributionWeight : '')}" data-line="${line}" placeholder="—" readonly>
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
    ProdLines._initSapWorkcenterCombo(line, ls.sapWorkcenter || '');
  },

  async _initSapWorkcenterCombo(line: string, currentValue: string): Promise<void> {
    const plant = Store.selectedPlant;
    if (!plant) return;

    const comboHost = document.getElementById(`sap-workcenter-combo-${line}`);
    if (!comboHost) return;

    try {
      const resp = await fetch(`${Config.API_BASE}/master-data/sap_workcenter?plant=${encodeURIComponent(plant)}`);
      if (!resp.ok) { ErrorLog.error('master-data', `Failed to fetch work centers: ${resp.status}`); return; }
      const data = (await resp.json()) as MasterDataResponse;
      const wcCodes = data.rows.map(row => (row as any).sap_workcenter as string).filter(Boolean);

      _mkCombobox(comboHost, wcCodes, {
        value: currentValue,
        placeholder: Util.t('ph.select_work_center') || '—',
        onSelect: (wc: string) => { void ProdLines._reassignWorkcenter(line, wc); },
      });
    } catch (err) {
      ErrorLog.error('master-data', `Error initializing SAP work center combobox: ${err}`);
    }
  },

  // aggregate_to_detail.md §4.2 (P2-11b): the pane autosaves on change, so the
  // "how many distributions does this touch" check has to be a dialog fired
  // from the combobox's own onSelect, not a static note beside the field.
  // Reads the machine's CURRENT sap_workcenter straight off Store.lineSettings
  // (not the `currentValue` closed over by _initSapWorkcenterCombo, which goes
  // stale after the pane's first reassignment without a full re-render) so the
  // "reassigned away from" half of the message is always accurate.
  // The check is informational only — §4.2 is explicit that nothing blocks the
  // save itself, so a `total === 0` response, a declined confirm's `false`
  // return, and even a failed/erroring impact check all still write through
  // (a failed check fails OPEN, same as the design's "nothing blocks the save").
  async _reassignWorkcenter(line: string, wc: string): Promise<void> {
    const plant = Store.selectedPlant;
    if (!plant) return;
    const previousWc = Store.lineSettings[line]?.sapWorkcenter || '';

    try {
      const resp = await Util.fetchTraced(
        `${Config.API_BASE}/distribution/${encodeURIComponent(plant)}?machines=${encodeURIComponent(line)}&limit=1`);
      if (resp.ok) {
        const body = await resp.json() as { meta?: { total?: number; scheduled_children?: number } };
        const total = body.meta?.total ?? 0;
        if (total > 0) {
          const scheduledChildren = body.meta?.scheduled_children ?? 0;
          const ok = await Modal.confirm({
            tone: 'warn',
            detail: Util.t('toast.dist_reassign_confirm', {
              n: total, k: scheduledChildren, machine: line, wc: previousWc || '—',
            }),
          });
          if (!ok) return;
        }
      } else {
        ErrorLog.error('master-data', `Failed to check distribution impact for ${line}: ${resp.status}`);
      }
    } catch (err) {
      ErrorLog.error('master-data', `Error checking distribution impact for ${line}: ${err}`);
    }

    Store.setLineSetting(line, { sapWorkcenter: wc || null }, 'prodlines');
    NIMBUS!.MasterData!.syncLineSettings!(line, { sapWorkcenter: wc || null });
    Toast.show(Util.t('toast.line_settings_updated'), 'success');
  },

  _renderNav(allLines: string[], shownLines: string[]): void {
    const nav = document.getElementById('lines-nav');
    if (!nav) return;
    const items = shownLines.map((line) => {
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
    // Cross-screen multi-select filter (Store.selectedLines) replaces the old
    // single free-text substring box — scale mandate (CLAUDE.md Production
    // Scale Roadmap): every plant/line picker must stay filterable via a
    // searchable multi-select, not a bare text box, once plants carry 70+ lines.
    if (!document.getElementById('lines-nav-filter-btn')) {
      nav.innerHTML = `
        <div class="lines-nav-header">
          <div class="lines-nav-title" id="lines-nav-title">Lines &middot; ${allLines.length}</div>
          <div class="lines-nav-filter" id="lines-nav-filter" style="position:relative;">
            <button class="seg-btn lp-group-btn" id="lines-nav-filter-btn" type="button" style="width:100%;">
              <span id="lines-nav-filter-label">All Lines</span><span style="margin-left:4px;font-size:10px;opacity:.7;">▾</span>
            </button>
            <div class="dash-filter-dropdown" id="lines-nav-filter-dropdown" hidden>
              <div class="dash-filter-paste-row">
                <input id="lines-nav-search" class="dash-filter-paste-input" type="text"
                       placeholder="${Util.t('ph.search_lines')}" autocomplete="off" spellcheck="false">
              </div>
              <div class="dash-filter-checklist" id="lines-nav-checklist"></div>
            </div>
          </div>
        </div>
        <div class="lines-nav-list" id="lines-nav-list"></div>`;
    } else {
      const t = document.getElementById('lines-nav-title');
      if (t) t.textContent = `Lines · ${allLines.length}`;
    }
    Util.refreshMultiSelectLabel(
      document.getElementById('lines-nav-filter-label'), document.getElementById('lines-nav-filter-btn'), Store.selectedLines);
    ProdLines._rebuildLineFilterChecklist(allLines);
    const listEl = document.getElementById('lines-nav-list');
    if (listEl) listEl.innerHTML = items || `<div class="lines-nav-empty">${Util.t('ui.no_lines_match')}</div>`;
  },

  // Shared by _renderNav (every render) and the filter dropdown's own search
  // input (live type-to-filter) — same split as GanttFilter's _buildLineDropdown
  // vs. _filterLineSearch.
  _rebuildLineFilterChecklist(allLines: string[]): void {
    const sorted = [...allLines].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    Util.renderLineChecklist(
      document.getElementById('lines-nav-checklist'), sorted, Store.selectedLines, ProdLines._lineSearch,
      (line, checked) => {
        const next = new Set(Store.selectedLines);
        if (checked) next.add(line); else next.delete(line);
        Store.setSelectedLines(next, 'masterdata');
      });
  },

  _wireNav(): void {
    const btn  = document.getElementById('lines-nav-filter-btn') as (HTMLButtonElement & { _wired?: boolean }) | null;
    const drop = document.getElementById('lines-nav-filter-dropdown');
    if (btn && drop && !btn._wired) {
      btn._wired = true;
      // `.lines-nav`/`.lines-nav-header` are `overflow:hidden` (so the line list
      // below scrolls correctly inside this fixed-width sidebar), which clips
      // this dropdown regardless of z-index. Move it to <body> and position it
      // from the button's own rect so it floats above the page like every
      // other line-filter dropdown instead of getting cut off.
      document.body.appendChild(drop);
      drop.classList.add('dash-filter-dropdown-portal');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const opening = drop.hidden;
        drop.hidden = !drop.hidden;
        if (opening) {
          const r = btn.getBoundingClientRect();
          drop.style.top = `${r.bottom + 4}px`;
          drop.style.left = `${r.left}px`;
        }
      });
      document.addEventListener('click', (e: MouseEvent) => {
        if (!drop.hidden && !drop.contains(e.target as Node) && e.target !== btn) drop.hidden = true;
      });
    }
    const search = document.getElementById('lines-nav-search') as LinesNavInput | null;
    if (search && !search._wired) {
      search._wired = true;
      // Reference the captured `search` rather than a `this` parameter — `.oninput`'s
      // lib.dom type is `(this: GlobalEventHandlers, ev: Event) => any`, and
      // GlobalEventHandlers has no `.value`, so a `this: HTMLInputElement` signature
      // isn't assignable to it even though the runtime `this` is always the element.
      search.oninput = function() {
        ProdLines._lineSearch = search.value;
        const allLines = Store.selectedPlant ? Store.linesForSelectedPlant() : CalendarUI._getLines();
        ProdLines._rebuildLineFilterChecklist(allLines);
      };
      Util.wirePasteToCheckboxes(search,
        () => Array.from(document.getElementById('lines-nav-checklist')?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') ?? []));
    }
    const list = document.getElementById('lines-nav-list');
    if (list) {
      list.onclick = (e: MouseEvent) => {
        const item = (e.target as HTMLElement).closest<HTMLElement>('.lines-nav-item');
        if (!item) return;
        const line = item.dataset.line;
        if (!line) return;
        ProdLines._activeNavLine = line;
        list.querySelectorAll<HTMLElement>('.lines-nav-item').forEach((i) =>
          i.classList.toggle('active', i.dataset.line === line));
        ProdLines._renderDetail(line);
      };
    }
  },

  _renderLineBlocks(line: string): string {
    const plant = Store.getPlantForLine(line);
    const lineBlocks = (Store.blocks || [])
      .filter(b => b.line === line && (!b.plant || b.plant === plant))
      .slice().sort((a, b) => (Util.parseDate(a.start)?.getTime() || 0) - (Util.parseDate(b.start)?.getTime() || 0));

    const plantBlocks = (Store.plantBlocks || [])
      .filter(b => !b.plant || b.plant === plant)
      .slice().sort((a, b) => (Util.parseDate(a.start)?.getTime() || 0) - (Util.parseDate(b.start)?.getTime() || 0));

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
        <span class="ico" style="color:var(--warn,#93610a);">■</span>
        <span class="reason">${b.reason || Util.t('ui.plant_blackout_default')}</span>
        <span class="line-tag" style="background:var(--warn-soft,#f8ecd0);color:var(--warn,#93610a);">Plant</span>
        <span class="range" title="${Util.fmtDTReadable(b.start)} → ${Util.fmtDTReadable(b.end)}">${Util.fmtBlockRange(b.start, b.end)}</span>
      </div>`).join('');

    return lineRows + plantRows;
  },

  // Delegated ONCE on the persistent #lines-body container (survives the
  // innerHTML re-renders in _renderDetail), replacing the old per-render
  // _wireInputs that re-bound 6 querySelectorAll loops every edit. Every
  // control carries data-line; .buf-unit-btn also carries data-unit.
  _ensureDelegated(): void {
    if (ProdLines._delegated) return;
    const body = document.getElementById('lines-body');
    if (!body) return;
    ProdLines._delegated = true;

    body.addEventListener('change', (e: Event) => {
      const el = e.target as HTMLInputElement;
      const line = el.dataset && el.dataset.line;
      if (!line) return;
      if (el.classList.contains('line-bottleneck-chk')) {
        Store.setLineSetting(line, { bottleneck: el.checked }, 'prodlines');
        NIMBUS!.MasterData!.syncLineSettings!(line, { bottleneck: el.checked });
        Toast.show(Util.t('toast.line_settings_updated'), 'success');
      } else if (el.classList.contains('line-excl-opt-chk')) {
        Store.setLineSetting(line, { excludeFromOpt: el.checked }, 'prodlines');
        NIMBUS!.MasterData!.syncLineSettings!(line, { excludeFromOpt: el.checked });
        Toast.show(Util.t('toast.line_settings_updated'), 'success');
      } else if (el.classList.contains('buf-pct-input')) {
        const val = Math.max(0, Math.min(100, +el.value || 0));
        Store.setLineSetting(line, { bufferPct: val }, 'prodlines');
        NIMBUS!.MasterData!.syncLineSettings!(line, { bufferPct: val });
        Toast.show(Util.t('toast.buffer_updated'), 'success');
      } else if (el.classList.contains('buf-hrs-input')) {
        const val = Math.max(0, +el.value || 0);
        Store.setLineSetting(line, { bufferHours: val }, 'prodlines');
        NIMBUS!.MasterData!.syncLineSettings!(line, { bufferHours: val });
        Toast.show(Util.t('toast.buffer_updated'), 'success');
      } else if (el.classList.contains('plgroup-input')) {
        const val = el.value.trim();
        Store.setLineSetting(line, { plGroup: val }, 'prodlines');
        NIMBUS!.MasterData!.syncLineSettings!(line, { plGroup: val });
        Toast.show(Util.t('toast.line_settings_updated'), 'success');
      }
    });

    body.addEventListener('click', (e: Event) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.buf-unit-btn');
      if (!btn) return;
      const line = btn.dataset.line;
      if (!line) return;
      const unit = btn.dataset.unit as BufferUnit;
      Store.setLineSetting(line, { bufferUnit: unit }, 'prodlines');
      NIMBUS!.MasterData!.syncLineSettings!(line, { bufferUnit: unit });
      ProdLines._renderDetail(ProdLines._activeNavLine);
    });
  },

  _fmtHour(h: number): string {
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    const ampm = hh < 12 ? 'am' : 'pm';
    const h12  = hh % 12 || 12;
    return mm === 0 ? `${h12}${ampm}` : `${h12}:${String(mm).padStart(2, '0')}${ampm}`;
  },

  openBlockModal(line: string | null): void {
    const lineSel = document.getElementById('lines-blk-line') as HTMLSelectElement | null;
    if (!lineSel) { ErrorLog.error('ui', 'required DOM element missing: lines-blk-line'); return; }
    const reasonEl = document.getElementById('lines-blk-reason') as HTMLInputElement | null;
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
    ProdLines._fpBlkStart!.setDate(now, false);
    ProdLines._fpBlkEnd!.setDate(plus1, false);
    reasonEl.value = '';
    Modal.open('modal-lines-block');
  },

  saveBlockFromModal(): void {
    const lineEl = document.getElementById('lines-blk-line') as HTMLSelectElement | null;
    const startEl = document.getElementById('lines-blk-start') as HTMLInputElement | null;
    const endEl = document.getElementById('lines-blk-end') as HTMLInputElement | null;
    const reasonEl = document.getElementById('lines-blk-reason') as HTMLInputElement | null;
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
    Store.addBlock({ line, plant, start, end, reason } as NimbusBlock, 'prodlines');
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

// -- Local type declarations (this task's MasterData conversion; scoped to
//    this closure-returning IIFE) -------------------------------------------

/** The six tables MasterData's "Manage Data Tables" grid actually renders.
 *  `roles`/`role_plants` are two of `master_data.py`'s eight ALLOWED_TABLES
 *  but are owned by the `Security` module's dedicated roles UI instead (its
 *  own `/master-data/roles`(+`/role_plants`) fetches, not this generic grid
 *  engine) — `Security` stays container-`any`-typed until its own task. */
type MasterDataTable =
  | 'subnetworks' | 'plants' | 'machine'
  | 'materials' | 'material_plants' | 'bom_items' | 'sap_workcenter';

/** `column_metadata` row shape returned alongside every `GET
 *  /master-data/{table}` (master_data.py `_column_meta`/get_table_data). */
interface MasterDataColumn {
  column_name: string;
  display_label: string;
  is_locked: boolean;
  column_order?: number;
}

/** A row in any Manage Data Tables grid. The DDL wizard (`_openAddColumn`)
 *  can add an arbitrary new column to any of the six tables at runtime, and
 *  every table also carries `created_at`/`updated_at` the grid never reads
 *  by name — hence the open index signature, same convention as `NimbusTask`
 *  in types.mts. The generic grid-engine functions below (`_rowKey`,
 *  `_parsePaste`, `_appendRow`, `_markDirty`, …) operate on this base shape
 *  since they read/write columns purely by the dynamic `column_name` string
 *  the table's own `columns` metadata supplies, never by a table-specific
 *  field name. */
interface MasterDataRow {
  [key: string]: unknown;
}

/** `GET /master-data/{table}` response envelope (master_data.py
 *  get_table_data) — not part of the backend's `response_model=` scope (only
 *  the task-date-update endpoint family is, per Phase 4's landed note), so
 *  hand-written locally following that phase's precedent. Not constrained to
 *  `T extends MasterDataRow`: `_save`'s post-write Store refresh reuses this
 *  same envelope typed over `NimbusMasterPlant`/`NimbusMasterLine`
 *  (types.mts) instead of the local `PlantRow`/`ProductionLineRow`, since
 *  that fetch feeds `Store.setMasterData` directly and those domain
 *  interfaces carry no index signature. */
interface MasterDataResponse<T = MasterDataRow> {
  columns: MasterDataColumn[];
  rows: T[];
  meta?: { total: number };
}

/** Per-table client-side edit buffer (`_cache[table]`): the last-loaded
 *  baseline rows plus in-progress edits not yet POSTed to `/bulk`. */
interface MasterDataTableState<T extends MasterDataRow = MasterDataRow> {
  columns: MasterDataColumn[];
  rows: T[];
  /** rowKey -> patch (a shallow-copied-and-mutated row carrying only the edited baseline + changed fields). */
  dirty: Map<string, T>;
  deleted: Set<string>;
  added: T[];
}

/** `machine` row — the one table `MasterData.syncLineSettings`
 *  reads/writes specific named fields on (the rest of the grid engine never
 *  needs more than the base `MasterDataRow` bag). Column names/types per
 *  schema.sql; `bottleneck`/`excl_optimizer` are DB `TEXT` flag columns
 *  ('X' or null), not real booleans. */
interface ProductionLineRow extends MasterDataRow {
  subnetwork: string;
  plant: string;
  machine: string;
  line_key?: string;
  wc_group?: string | null;
  sap_workcenter?: string | null;
  distribution_weight?: number | null;
  bottleneck?: string | null;
  excl_optimizer?: string | null;
  buffer_type?: string | null;
  buffer_percent?: number | null;
  buffer_hours?: number | null;
}

// Per-table row shapes for the other five tables MasterData's grid renders,
// per schema.sql (not part of the backend's `response_model=` scope — only
// the task-date-update endpoint family is, per Phase 4's landed note — so
// hand-written locally, same as ProductionLineRow above). Not every field
// below is read by name anywhere in this generic grid engine (which mostly
// operates on the base `MasterDataRow` bag via each table's own dynamic
// `columns` metadata) — these exist so a future consumer that DOES need a
// specific table's shape (the way `syncLineSettings` needs
// `ProductionLineRow`, or the BOM component picker below needs
// `MaterialPlantRow`) has one ready instead of re-deriving it from schema.sql.

interface SubnetworkRow extends MasterDataRow {
  code: string;
  name: string;
}

interface PlantRow extends MasterDataRow {
  subnetwork: string;
  plant: string;
  alt_flag_horizon?: number;
  conf_score_horizon?: number;
  split_order_policy?: 'never' | 'overlong_only' | 'partial_allowed' | null;
  max_pull_forward_days?: number | null;
  max_push_forward_days?: number | null;
  /** C2 (2026-08-20): nullable whole calendar days of the plant's frozen
   *  horizon; NULL/0 both mean "off" (unlike visibility_horizon_days). */
  frozen_horizon_days?: number | null;
  /** Attached by master_data.py's get_table_data for the 'plants' table only. */
  constraints?: ConstraintConfig[] | null;
  /** plants.setup_active — see NimbusMasterPlant's field of the same name. */
  setup_active?: boolean;
  /** N8 (2026-09): plants.setup_policy_config JSONB sidecar — see
   *  NimbusMasterPlant's field of the same name. */
  setup_policy_config?: { unknownSetupPolicy?: UnknownSetupPolicy; unknownSetupDefaultMinutes?: number } | null;
}

interface MaterialRow extends MasterDataRow {
  material_id: string;
  material_description?: string;
  material_type?: string;
  base_uom?: string;
}

/** Also the shape of the BOM component-picker's `material_plants` fetches
 *  (`_loadBomMaterialsForPlant`, `_bomComponentSelect`) — both only read
 *  `material_id`, but the row carries the rest of the columns below too. */
interface MaterialPlantRow extends MasterDataRow {
  material_id: string;
  plant: string;
  subnetwork?: string;
  status_pl?: string;
  default_production_version?: string;
  min_lot_size?: number;
  incremental_lot_size?: number;
}

interface BomItemRow extends MasterDataRow {
  material_id: string;
  plant: string;
  alternative_bom: string;
  level: number;
  item_number: string;
  component_id: string;
  base_quantity?: number | null;
  item_category?: string;
  assembly?: string;
  component_quantity?: number | null;
  base_unit_of_measure?: string;
  valid_from?: string | null;
  valid_to?: string | null;
  changed_on?: string | null;
  change_number?: string;
}

/** `POST /master-data/{table}/cascade-preview` response (master_data.py) —
 *  counts of dependent rows a delete would also remove (or, for
 *  `material_plants`/`sap_workcenter`, rows that block the delete: RESTRICT
 *  FKs, never CASCADE). `headers` is order_distribution rows referencing a
 *  sap_workcenter. */
interface MasterDataCascadePreview {
  plants?: number;
  machine?: number;
  bom_items?: number;
  headers?: number;
}

/** One informational (non-blocking) finding from a table-specific post-write
 *  check (backend/master_data/models.py `BulkWriteWarning`) — same
 *  `{level, msg}` shape AdminCockpit's `_warningList` already renders
 *  (`frontend/admin-ops/admin-ui.mts`'s `AdminPipelineWarning`), copied here
 *  rather than imported to avoid a new cross-domain edge (§4.1). */
interface MasterDataBulkWarning {
  level?: 'info' | 'warn' | 'error';
  msg?: string;
}

/** `POST /master-data/{table}/bulk` response (master_data.py bulk_apply). */
interface MasterDataBulkResult {
  inserted: number;
  updated: number;
  deleted: number;
  warnings?: MasterDataBulkWarning[];
}

/** bom_items' plant+material scope gate (`_renderBomGate`). */
interface BomFilter {
  plant: string | null;
  material_id: string | null;
}

/** Shape `_loadAndRender` stamps onto a plain `Error` after
 *  `Util.parseBackendError` parses a non-OK response — mirrors
 *  schedule-data.mts's `SaveError` idiom. */
interface MasterDataFetchError extends Error {
  errorCode?: string;
  httpStatus?: number;
}

/** `sap_workcenter` row, as returned by `GET /master-data/sap_workcenter`
 *  (schema.sql §3.1 / aggregate_to_detail.md). Used by the Work Centers
 *  master-data sub-tab (`WorkCenters` below) — a hand-typed row shape,
 *  same convention as `ProductionLineRow`/`PlantRow`/etc. above. */
interface WorkCenterRow extends MasterDataRow {
  plant: string;
  sap_workcenter: string;
  description?: string | null;
  distribution_mode: 'single' | 'distribute';
  default_machine?: string | null;
  max_separation: 'none' | 'hour' | 'day' | 'week';
  review_required: boolean;
  distribute_tooled: boolean;
}

/** `PUT /distribution/{plant}/workcenters/{wc}` response
 *  (backend/distribution/models.py `WorkCenterSaveResult`). */
interface WorkCenterSaveResult {
  plant: string;
  sap_workcenter: string;
  description?: string | null;
  distribution_mode: 'single' | 'distribute';
  default_machine?: string | null;
  max_separation: 'none' | 'hour' | 'day' | 'week';
  review_required: boolean;
  distribute_tooled: boolean;
  weights: Record<string, number | null>;
}

/** The Work Centers tab's client-side staged-edit buffer for the currently
 *  selected work center — mirrors the shape `PUT
 *  /distribution/{plant}/workcenters/{wc}` accepts. `weights` only ever
 *  carries keys for the code's CURRENT member machines (machine.sap_workcenter
 *  === this code); membership itself is never edited here (§4.2, Machines tab). */
interface WorkCenterStaged {
  description: string;
  distribution_mode: 'single' | 'distribute';
  default_machine: string;
  max_separation: 'none' | 'hour' | 'day' | 'week';
  review_required: boolean;
  distribute_tooled: boolean;
  weights: Record<string, number | null>;
}

/** Wire body for `PUT /distribution/{plant}/workcenters/{wc}` — the autosave
 *  write's payload shape, built from a `WorkCenterStaged` snapshot at fire
 *  time (`WorkCenters._autosave`/`_write`). Distinct from `WorkCenterStaged`
 *  only in that the two optional-ish string fields go through `|| null`
 *  instead of staying `''`, matching what the backend model expects. */
interface WorkCenterWritePayload {
  description: string | null;
  distribution_mode: 'single' | 'distribute';
  default_machine: string | null;
  max_separation: 'none' | 'hour' | 'day' | 'week';
  review_required: boolean;
  distribute_tooled: boolean;
  weights: Record<string, number | null>;
}

/** A fully-captured write request — plant/code/payload/members already
 *  resolved from live state, so it can be handed to `WorkCenters._write`
 *  (or parked in `_queued`) without re-reading selection later. Built by
 *  `WorkCenters._buildWrite`. */
interface WorkCenterWriteRequest {
  plant: string;
  code: string;
  payload: WorkCenterWritePayload;
  members: string[];
}

interface ComboboxOpts {
  value?: string;
  placeholder?: string;
  onSelect?: (value: string) => void;
}

// Minimal self-contained searchable combobox — reuses the topbar
// PlantSelector's markup/CSS classes (hps-*) for visual consistency and
// the same type-to-filter/keyboard-nav interaction, but works off a plain
// options array with no Store dependency, so it fits BOM's plant AND
// material pickers (PlantSelector itself is wired one-to-one to
// Store.selectedPlant and the global topbar DOM), as well as Plant's
// priority-list line-override picker (`_renderOptimization` above) — moved
// to true module top-level (out of MasterData's IIFE, where it previously
// lived) so both call sites can reach it as a bare identifier.
function _mkCombobox(containerEl: HTMLElement | null, options: string[], { value = '', placeholder = '', onSelect }: ComboboxOpts = {}): void {
  if (!containerEl) return;
  // Options were previously always DB-backed plant/material names (BOM's two
  // pickers); Task 12 added a third call site whose options list is line
  // names, and the dropdown's own option-row rendering below never escaped
  // `o` in the first place — cheap to close now rather than carry forward.
  containerEl.innerHTML = `
    <div class="hps-combobox md-bom-combobox">
      <input type="text" class="hps-input" placeholder="${Util.escapeHtml(placeholder)}" autocomplete="off" spellcheck="false"
             aria-haspopup="listbox" aria-expanded="false">
      <button type="button" class="hps-clear" hidden>&times;</button>
      <div class="hps-dropdown" role="listbox" hidden></div>
    </div>`;
  const root      = containerEl.querySelector('.hps-combobox') as HTMLElement;
  const input     = root.querySelector('.hps-input') as HTMLInputElement;
  const clearBtn  = root.querySelector('.hps-clear') as HTMLButtonElement;
  const dropdown  = root.querySelector('.hps-dropdown') as HTMLElement;
  let filtered: string[]  = [];
  let activeIdx = -1;
  let open      = false;
  let selected  = value;

  function reflect(): void {
    input.value = selected || '';
    root.classList.toggle('has-value', !!selected);
    clearBtn.hidden = !selected;
  }
  function renderDropdown(query: string): void {
    const q = (query || '').trim().toLowerCase();
    const looksLikeLabel = selected && String(query).trim().toLowerCase() === String(selected).toLowerCase();
    const filterQ = looksLikeLabel ? '' : q;
    filtered = filterQ ? options.filter((o) => String(o).toLowerCase().includes(filterQ)) : options.slice();
    if (!filtered.length) {
      dropdown.innerHTML = `<div class="hps-empty">${options.length ? Util.t('ui.no_matches') : Util.t('ui.no_options')}</div>`;
      activeIdx = -1;
      return;
    }
    dropdown.innerHTML = filtered.map((o, i) =>
      `<div class="hps-option${o === selected ? ' selected' : ''}" role="option" data-idx="${i}">${Util.escapeHtml(o)}</div>`
    ).join('');
    activeIdx = Math.max(0, filtered.indexOf(selected));
    highlight();
    dropdown.querySelectorAll('.hps-option').forEach((el, i) => {
      el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(filtered[i]); });
    });
  }
  function highlight(): void {
    const items = dropdown.querySelectorAll('.hps-option');
    items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
    if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: 'nearest' });
  }
  function openDd()  { dropdown.hidden = false; open = true;  input.setAttribute('aria-expanded', 'true'); }
  function closeDd() { dropdown.hidden = true;  open = false; activeIdx = -1; input.setAttribute('aria-expanded', 'false'); }
  function pick(o: string): void {
    selected = o;
    reflect();
    closeDd();
    input.blur();
    if (onSelect) onSelect(o);
  }

  input.addEventListener('focus', () => { renderDropdown(input.value); openDd(); });
  input.addEventListener('input', () => { renderDropdown(input.value); openDd(); });
  input.addEventListener('keydown', (e) => {
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
  clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
  clearBtn.addEventListener('click', () => { selected = ''; reflect(); if (onSelect) onSelect(''); input.focus(); });
  document.addEventListener('click', (e) => { if (!root.contains(e.target as Node)) closeDd(); });

  reflect();
}

/* =============================================================================
   MASTER DATA — Manage Data Tables admin sub-tab UI (Subnetwork / Plant / Production Line)
   ========================================================================== */
export const MasterData = (() => {
  const API = Config.API_BASE;
  let _activeTable: MasterDataTable = 'subnetworks';
  // Per-table state: { columns, rows, dirty: Map(rowKey→patch), deleted: Set(rowKey), added: [] }
  const _cache: Partial<Record<MasterDataTable, MasterDataTableState>> = {};
  // Bumped on every _loadAndRender call (table switch, discard, save-triggered
  // reload, ...). A response can only mutate `_cache`/render once it belongs to
  // the latest generation — otherwise a slow-resolving fetch for a table the
  // user has since switched away from can overwrite the currently-selected
  // table's grid. Mirrors Persistence.loadSetupSnapshot's `_setupSnapshotRequest`
  // token in frontend/scheduling/persistence.mts.
  let _loadGeneration = 0;

  const TABLE_LABELS: Record<MasterDataTable, string> = {
    subnetworks:      'Subnetworks',
    plants:           'Plants',
    machine: 'Production Lines',
    materials:        'Material',
    material_plants:  'Material Plant',
    bom_items:        'Bill of Materials',
    sap_workcenter:   'Work Centers',
  };

  // KEY_COLS drives primary-key identification per table.
  const KEY_COLS: Record<MasterDataTable, string[]> = {
    subnetworks:      ['code'],
    plants:           ['subnetwork', 'plant'],
    machine: ['subnetwork', 'plant', 'machine'],
    materials:        ['material_id'],
    material_plants:  ['material_id', 'plant'],
    bom_items:        ['material_id', 'plant', 'alternative_bom', 'level', 'item_number', 'component_id'],
    sap_workcenter:   ['plant', 'sap_workcenter'],
  };

  // Tables that need a parent-dropdown for FK columns.
  const FK_SOURCE: Partial<Record<MasterDataTable, Record<string, MasterDataTable>>> = {
    plants:           { subnetwork: 'subnetworks' },
    machine: { subnetwork: 'subnetworks', plant: 'plants' },
    material_plants:  { material_id: 'materials' },
    // bom_items.component_id is deliberately NOT registered here: it needs a
    // plant-scoped option list (material_plants filtered to the row's plant),
    // which the generic _fkSelect (whole-source-table, single-key convention)
    // can't express. See the bom_items special case in _appendRow instead.
  };

  // bom_items requires a plant + material pick before the grid loads (its
  // table is expected to be huge — one row per component per level per
  // material — unlike every other MasterData table, which loads in full).
  let _bomFilter: BomFilter = { plant: null, material_id: null };

  function _rowKey(table: MasterDataTable, row: MasterDataRow): string {
    return KEY_COLS[table].map((k) => String(row[k] ?? '')).join('|');
  }

  function _parsePaste(rawText: string, columns: MasterDataColumn[]): { rows: MasterDataRow[] } {
    const lines = rawText.replace(/\r/g, '').split('\n').filter((l) => l.trim());
    if (!lines.length) return { rows: [] };
    const colNames  = columns.map((c) => c.column_name.toLowerCase());
    const colLabels = columns.map((c) => (c.display_label || c.column_name).toLowerCase());
    const first     = lines[0].split('\t').map((h) => h.trim().toLowerCase());
    const hasHeader = first.some((h) => colNames.includes(h) || colLabels.includes(h));
    let headers: string[], dataLines: string[];
    if (hasHeader) {
      headers   = first.map((h) => {
        const ni = colNames.indexOf(h);
        if (ni >= 0) return columns[ni].column_name;
        const li = colLabels.indexOf(h);
        return li >= 0 ? columns[li].column_name : h;
      });
      dataLines = lines.slice(1);
    } else {
      headers   = columns.map((c) => c.column_name);
      dataLines = lines;
    }
    const rows = dataLines.map((line) => {
      const vals = line.split('\t');
      const row: MasterDataRow = {};
      headers.forEach((h, i) => { row[h] = (vals[i] ?? '').trim(); });
      return row;
    });
    return { rows };
  }

  // -----------------------------------------------------------------------
  // Public entry point
  // -----------------------------------------------------------------------
  function render(): void {
    // Wire inner tabs on first call.
    document.querySelectorAll<HTMLElement>('.md-tab').forEach((b) => {
      b.onclick = () => _setTab(b.dataset.mdTab as MasterDataTable);
    });
    const exportBtn = document.getElementById('md-export-schema-btn');
    if (exportBtn) exportBtn.onclick = _exportSchema;
    _syncTabUI();
    _renderActiveTable();
  }

  function _setTab(table: MasterDataTable): void {
    _activeTable = table;
    _syncTabUI();
    _renderActiveTable();
  }

  function _syncTabUI(): void {
    document.querySelectorAll<HTMLElement>('.md-tab').forEach((b) =>
      b.classList.toggle('active', b.dataset.mdTab === _activeTable));
  }

  // bom_items never loads unscoped (its table is expected to be huge) — show
  // the plant+material picker gate until both are chosen, same as every
  // other tab shows its grid immediately.
  function _renderActiveTable(): void {
    if (_activeTable === 'bom_items' && !(_bomFilter.plant && _bomFilter.material_id)) {
      _renderBomGate();
    } else {
      _loadAndRender(_activeTable);
    }
  }

  // -----------------------------------------------------------------------
  // BOM plant + material scope gate
  // -----------------------------------------------------------------------
  function _renderBomGate(): void {
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

  async function _loadBomMaterialsForPlant(plant: string): Promise<void> {
    const matHost = document.getElementById('md-bom-material-picker');
    if (matHost) matHost.innerHTML = `<div class="md-loading-inline">${Util.t('ui.loading')}</div>`;
    try {
      const data = await Util.fetchTraced(`${API}/master-data/material_plants?${new URLSearchParams({ plant }).toString()}`)
        .then((r) => r.json()) as MasterDataResponse<MaterialPlantRow>;
      const materials = (data.rows || []).map((r) => r.material_id).sort();
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
      ErrorLog.error('master-data', `Failed to load materials for plant ${plant}: ${(e as Error).message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------
  async function _loadAndRender(table: MasterDataTable): Promise<void> {
    const host = document.getElementById('md-host');
    if (!host) return;
    host.innerHTML = `<div class="md-loading">${Util.t('ui.loading')}</div>`;
    // Stale-response guard: capture the generation before the async fetch,
    // and only let this call mutate `_cache`/render if it's still current
    // once the fetch resolves. Without this, quickly switching Manage Data
    // Tables tabs can let a slow-resolving fetch for the PREVIOUSLY selected
    // table overwrite the currently-selected table's rendered grid.
    const generation = ++_loadGeneration;
    const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    // bom_items is the one table that must never load in full — always scope
    // the request to the plant + material the user picked via the gate.
    // Non-null assertions: only reached via _renderActiveTable, which already
    // gated on both being set before calling _loadAndRender('bom_items').
    const qs = table === 'bom_items'
      ? `?${new URLSearchParams({ plant: _bomFilter.plant!, material_id: _bomFilter.material_id! }).toString()}`
      : '';
    try {
      const data = await Util.fetchTraced(`${API}/master-data/${table}${qs}`, { headers: { 'x-request-id': reqId } }).then(async (r) => {
        if (!r.ok) {
          // Surface the backend body instead of discarding it.
          const parsed = await Util.parseBackendError(r);
          const err = new Error(parsed.message) as MasterDataFetchError;
          err.errorCode = parsed.errorCode; err.httpStatus = r.status;
          throw err;
        }
        return r.json() as Promise<MasterDataResponse>;
      });
      if (generation !== _loadGeneration) return; // a newer table switch has since started
      _cache[table] = {
        columns: data.columns,
        rows:    data.rows,
        dirty:   new Map(),
        deleted: new Set(),
        added:   [],
      };
      _renderTable(table);
    } catch (e) {
      if (generation !== _loadGeneration) return; // a newer table switch has since started
      const err = e as MasterDataFetchError;
      host.innerHTML = `<div class="md-empty">Failed to load ${TABLE_LABELS[table]}: ${Util.escapeHtml(err.message)}</div>`;
      ErrorLog.error('master-data', `Load failed for ${table}: ${err.message}`,
        { reqId, table, status: err.httpStatus }, { reqId, errorCode: err.errorCode || 'http.network' });
    }
  }

  // -----------------------------------------------------------------------
  // Table rendering
  // -----------------------------------------------------------------------
  function _renderTable(table: MasterDataTable): void {
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

    // Inline post-write warnings (§4.1) — populated by _save() after a bulk
    // response carries `warnings[]` (currently only the sap_workcenter
    // branch, backend/master_data/routes.py's `_sap_workcenter_bulk_warnings`).
    // Present for every table (not just sap_workcenter) since this is a
    // generic grid engine — it simply stays empty for tables whose bulk
    // response never carries warnings. Cleared on every re-render (host is
    // rebuilt from scratch above), same lifetime as the toolbar itself.
    const bulkWarnHost = document.createElement('div');
    bulkWarnHost.id = 'md-bulk-warnings';
    host.appendChild(bulkWarnHost);

    // -- Table --
    const wrap = document.createElement('div');
    wrap.className = 'md-table-wrap';

    const tbl = document.createElement('table');
    tbl.className = 'md-table';
    tbl.id = `md-tbl-${table}`;

    // Header
    const thead = document.createElement('thead');
    const hRow = document.createElement('tr');
    columns.forEach((col) => {
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
      allRows.forEach((row) => _appendRow(tbody, table, columns, row));
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    host.appendChild(wrap);
  }

  function _appendRow(tbody: HTMLTableSectionElement, table: MasterDataTable, columns: MasterDataColumn[], row: MasterDataRow): void {
    const state = _cache[table]!;
    const key = _rowKey(table, row);
    const isNew = state.added.some((r) => _rowKey(table, r) === key);
    const isDeleted = state.deleted.has(key);
    const isDirty = state.dirty.has(key);
    // Render pending (dirty) values over the saved baseline so an in-progress edit
    // survives a re-render (add/paste/delete all call _renderTable). For added rows
    // the dirty entry IS the added row object, so rowView resolves to the same values.
    const _dirtyPatch = state.dirty.get(key);
    const rowView: MasterDataRow = _dirtyPatch ? { ...row, ..._dirtyPatch } : row;

    const tr = document.createElement('tr');
    tr.dataset.rowKey = key;
    tr.className = [
      isNew     ? 'md-row-new'     : '',
      isDeleted ? 'md-row-deleted' : '',
      isDirty   ? 'md-row-dirty'   : '',
    ].filter(Boolean).join(' ');

    columns.forEach((col) => {
      const td = document.createElement('td');
      td.className = 'md-td';

      // bom_items.component_id: plant-scoped dropdown (material_plants rows
      // for this row's plant), not the generic FK_SOURCE/_fkSelect path —
      // that assumes the source table's LAST key column is the value column
      // (true for material_plants -> 'plant', wrong for what we need: 'material_id').
      if (table === 'bom_items' && col.column_name === 'component_id' && isNew) {
        const rowPlant = rowView.plant != null ? String(rowView.plant) : '';
        td.appendChild(_bomComponentSelect(rowPlant || _bomFilter.plant, rowView.component_id, key));
        tr.appendChild(td);
        return;
      }

      // FK columns get a <select> populated from parent table.
      const fkSources = FK_SOURCE[table] || {};
      const srcTable = fkSources[col.column_name];
      if (srcTable && !isNew) {
        // For existing rows, key columns are read-only.
        if (col.is_locked) {
          td.textContent = String(rowView[col.column_name] ?? '');
        } else {
          td.appendChild(_fkSelect(table, col.column_name, rowView[col.column_name], srcTable, key));
        }
      } else if (srcTable && isNew) {
        td.appendChild(_fkSelect(table, col.column_name, rowView[col.column_name], srcTable, key));
      } else if (col.is_locked && !isNew) {
        // Key columns on saved rows are read-only.
        td.textContent = String(rowView[col.column_name] ?? '');
      } else {
        const cell = document.createElement('div');
        cell.contentEditable = isDeleted ? 'false' : 'true';
        cell.className = 'md-cell';
        cell.textContent = String(rowView[col.column_name] ?? '');
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

  function _fkSelect(table: MasterDataTable, colName: string, value: unknown, sourceTable: MasterDataTable, rowKey: string): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.className = 'input md-fk-select';
    // Populate from cache or fetch.
    const sourceState = _cache[sourceTable];
    const sourceRows = sourceState?.rows ?? [];
    const srcKeys = KEY_COLS[sourceTable];
    // For subnetworks: use 'code'. For plants when in machine: use 'plant'.
    const valCol = srcKeys[srcKeys.length - 1];
    const labelCol = sourceTable === 'subnetworks' ? 'name' : valCol;

    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = Util.t('ui.select_placeholder');
    sel.appendChild(blank);
    const _optLabel = (r: MasterDataRow): string =>
      (r[labelCol] && labelCol !== valCol) ? `${String(r[valCol])} — ${String(r[labelCol])}` : String(r[valCol] ?? '');
    sourceRows.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = String(r[valCol] ?? '');
      opt.textContent = _optLabel(r);
      if (r[valCol] === value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.onchange = () => _markDirty(table, rowKey, colName, sel.value);

    // If source not loaded yet, fetch it.
    if (!sourceState) {
      Util.fetchTraced(`${API}/master-data/${sourceTable}`).then((r) => r.json()).then((data: MasterDataResponse) => {
        _cache[sourceTable] = { columns: data.columns, rows: data.rows, dirty: new Map(), deleted: new Set(), added: [] };
        // Rebuild select options.
        while (sel.options.length > 1) sel.remove(1);
        data.rows.forEach((r) => {
          const opt = document.createElement('option');
          opt.value = String(r[valCol] ?? '');
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
  const _bomComponentOptionsCache: Record<string, string[]> = {};

  // Per-plant memoized machine table state, used only by syncLineSettings.
  // Deliberately separate from _cache['machine'] (which is global/unscoped)
  // to avoid plant-to-plant cache collisions when syncing line settings.
  const _lineSyncMachineCache: Record<string, MasterDataTableState<ProductionLineRow>> = {};

  function _bomComponentSelect(plant: string | null, value: unknown, rowKey: string): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.className = 'input md-fk-select';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = Util.t('ui.select_placeholder');
    sel.appendChild(blank);

    const fill = (materials: string[]): void => {
      while (sel.options.length > 1) sel.remove(1);
      materials.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === value) opt.selected = true;
        sel.appendChild(opt);
      });
    };
    sel.onchange = () => _markDirty('bom_items', rowKey, 'component_id', sel.value);

    if (plant && _bomComponentOptionsCache[plant]) {
      fill(_bomComponentOptionsCache[plant]);
    } else if (plant) {
      Util.fetchTraced(`${API}/master-data/material_plants?${new URLSearchParams({ plant }).toString()}`)
        .then((r) => r.json())
        .then((data: MasterDataResponse<MaterialPlantRow>) => {
          const materials = (data.rows || []).map((r) => r.material_id).sort();
          _bomComponentOptionsCache[plant] = materials;
          fill(materials);
        }).catch(() => {});
    }
    return sel;
  }

  function _markDirty(table: MasterDataTable, rowKey: string, colName: string, value: unknown): void {
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
      const addedRow = (state.added || []).find((r) => _rowKey(table, r) === rowKey);
      patch = addedRow ? addedRow : { ..._getRowByKey(table, rowKey) };
    }
    patch[colName] = value;
    state.dirty.set(rowKey, patch);
    // Update the tr class to show dirty highlight.
    const tr = document.querySelector(`#md-tbody-${table} tr[data-row-key="${CSS.escape(rowKey)}"]`);
    if (tr) tr.classList.add('md-row-dirty');
    _updateSaveBtn(table);
  }

  function _getRowByKey(table: MasterDataTable, key: string): MasterDataRow {
    const state = _cache[table];
    const all = [...(state?.rows ?? []), ...(state?.added ?? [])];
    return all.find((r) => _rowKey(table, r) === key) ?? {};
  }

  function _updateSaveBtn(table: MasterDataTable): void {
    const state = _cache[table];
    if (!state) return;
    const isDirty = state.dirty.size > 0 || state.deleted.size > 0 || state.added.length > 0;
    const saveBtn = document.querySelector('#md-host .btn-primary.sm') as HTMLButtonElement | null;
    if (saveBtn) {
      saveBtn.disabled = !isDirty;
      saveBtn.classList.toggle('md-save-idle', !isDirty);
    }
    // Update dirty badge.
    const badge = document.querySelector('#md-host .md-dirty-badge') as HTMLElement | null;
    if (badge) {
      const n = state.dirty.size + state.deleted.size + state.added.length;
      badge.textContent = `${n} unsaved`;
      badge.hidden = !isDirty;
    }
  }

  function _addRow(table: MasterDataTable): void {
    const state = _cache[table];
    if (!state) return;
    const newRow: MasterDataRow = {};
    state.columns.forEach((c) => { newRow[c.column_name] = ''; });
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
      const firstCell = lastRow?.querySelector('.md-cell') as HTMLElement | null;
      if (firstCell) firstCell.focus();
    }, 50);
  }

  async function _uploadBom(): Promise<void> {
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
          result.warnings.slice(0, 10).forEach((w: { msg: string }) => ErrorLog.warn('master-data', w.msg));
        }
        // Refresh the currently-scoped view so newly uploaded rows for this
        // material+plant show up immediately.
        delete _cache.bom_items;
        if (_activeTable === 'bom_items') _renderActiveTable();
      } catch (e) {
        Toast.show(`${Util.t('toast.bom_upload_failed')}: ${(e as Error).message}`, 'error');
        ErrorLog.error('master-data', `BOM upload failed: ${(e as Error).message}`);
      }
    };
    input.click();
  }

  async function _pasteRows(table: MasterDataTable): Promise<void> {
    let raw: string;
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
    const toAdd: MasterDataRow[]    = [];
    const toUpdate: MasterDataRow[] = [];
    const invalid: MasterDataRow[]  = [];

    rows.forEach((row) => {
      if (keys.find((k) => !row[k])) { invalid.push(row); return; }
      const key = _rowKey(table, row);
      const inSaved    = state.rows.some((r) => _rowKey(table, r) === key);
      const inAdded    = state.added.some((r) => _rowKey(table, r) === key);
      const batchAddIdx = toAdd.findIndex((r) => _rowKey(table, r) === key);
      const batchUpdIdx = toUpdate.findIndex((r) => _rowKey(table, r) === key);
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

    const parts: string[] = [];
    if (toAdd.length)    parts.push(`add ${toAdd.length} new`);
    if (toUpdate.length) parts.push(`update ${toUpdate.length} existing`);
    if (invalid.length)  parts.push(`skip ${invalid.length} invalid`);

    // NOTE: the original call passed `tone: 'info' as any` — ModalConfirmOpts.tone
    // (application-foundation.mts) only ever accepted 'danger'|'warn', so 'info' was
    // never a real option; Modal.confirm's own tone check (`tone === 'warn' ? warn :
    // danger`) already fell through to the same 'danger' button styling for any other
    // value including 'info', so omitting it here changes no runtime behavior.
    const ok = await Modal.confirm({
      title:   'Paste Rows',
      message: `This will ${parts.join(', ')} row(s).`,
      detail:  `Changes appear in the table but won't be saved until you click Save.` +
               (invalid.length ? ` Skipped rows are missing key column(s): ${keys.join(', ')}.` : ''),
    });
    if (!ok) return;

    toAdd.forEach((row) => {
      const full: MasterDataRow = {};
      state.columns.forEach((c) => { full[c.column_name] = row[c.column_name] ?? ''; });
      state.added.push(full);
    });

    toUpdate.forEach((row) => {
      const key = _rowKey(table, row);
      const idx = state.rows.findIndex((r) => _rowKey(table, r) === key);
      if (idx >= 0) {
        Object.assign(state.rows[idx], row);
        state.dirty.set(key, { ...state.rows[idx] });
      } else {
        const ai = state.added.findIndex((r) => _rowKey(table, r) === key);
        if (ai >= 0) Object.assign(state.added[ai], row);
      }
    });

    _renderTable(table);
    Toast.show(invalid.length
      ? Util.t('toast.paste_result_skip', { added: toAdd.length, updated: toUpdate.length, skipped: invalid.length })
      : Util.t('toast.paste_result', { added: toAdd.length, updated: toUpdate.length }), 'success');
  }

  async function _deleteRow(table: MasterDataTable, rowKey: string, tr: HTMLTableRowElement): Promise<void> {
    const state = _cache[table];
    if (!state) return;

    // Build delete payload from the key.
    const keys = KEY_COLS[table];
    const row = _getRowByKey(table, rowKey);
    const deletePayload: MasterDataRow = {};
    keys.forEach((k) => { deletePayload[k] = row[k]; });

    // Get cascade preview for saved rows (not for newly-added rows).
    const isNew = state.added.some((r) => _rowKey(table, r) === rowKey);
    let cascadeDetail = '';

    if (!isNew && (table === 'subnetworks' || table === 'plants' || table === 'material_plants' || table === 'sap_workcenter')) {
      try {
        const preview = await Util.fetchTraced(`${API}/master-data/${table}/cascade-preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deletes: [deletePayload] }),
        }).then(_okJson) as MasterDataCascadePreview;

        if (table === 'sap_workcenter') {
          // Both FKs (machine.sap_workcenter, order_distribution.sap_workcenter)
          // are ON DELETE RESTRICT — this table only ever blocks, never cascades.
          const parts: string[] = [];
          const nMachines = preview.machine ?? 0, nHeaders = preview.headers ?? 0;
          if (nMachines > 0) parts.push(`<strong>${nMachines}</strong> machine${nMachines !== 1 ? 's' : ''}`);
          if (nHeaders > 0)  parts.push(`<strong>${nHeaders}</strong> distribution header${nHeaders !== 1 ? 's' : ''}`);
          if (parts.length) {
            cascadeDetail = `<div class="md-cascade-warn">This is referenced by ${parts.join(' and ')} — reassign or collapse those first.</div>`;
          }
        } else {
          const parts: string[] = [];
          const nPlants = preview.plants ?? 0, nLines = preview.machine ?? 0, nBom = preview.bom_items ?? 0;
          if (nPlants > 0)  parts.push(`<strong>${nPlants}</strong> plant${nPlants !== 1 ? 's' : ''}`);
          if (nLines > 0)   parts.push(`<strong>${nLines}</strong> production line${nLines !== 1 ? 's' : ''}`);
          if (nBom > 0)     parts.push(`<strong>${nBom}</strong> BOM item${nBom !== 1 ? 's' : ''}`);
          if (parts.length) {
            cascadeDetail = table === 'material_plants'
              ? `<div class="md-cascade-warn">This is referenced by ${parts.join(' and ')} — delete those first.</div>`
              : `<div class="md-cascade-warn">This will also permanently delete ${parts.join(' and ')}.</div>`;
          }
        }
      } catch (e) {
        // Fail closed: the true cascade impact is unknown, so never fall through to
        // an ordinary confirm dialog — that's visually indistinguishable from "zero
        // dependents" and could let an admin approve a delete that cascades further
        // than they think. Block the delete entirely instead.
        ErrorLog.error('master-data', `Cascade preview fetch failed for ${table}: ${(e as Error).message}`);
        Toast.show(Util.t('toast.cascade_preview_failed'), 'error');
        return;
      }
    }

    const keyDisplay = keys.map((k) => row[k]).join(' / ');
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
      const idx = state.added.findIndex((r) => _rowKey(table, r) === rowKey);
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
  // Inline post-write warnings block — copies AdminCockpit._warningList's
  // exact DOM/CSS pattern (`frontend/admin-ops/admin-ui.mts:1064-1081`,
  // `.admin-bwarn-list`/`.admin-bwarn-row`/`.admin-bwarn-lvl`/`.admin-bwarn-msg`
  // in styles.css) rather than importing that module, per this repo's
  // small-deliberate-duplication convention (avoids a new master-data ↔
  // admin-ops edge for four lines of DOM). `warnings[]` is the first
  // consumer of a bulk-write warning beyond ErrorLog (§4.1) — this renders
  // it under the grid's toolbar; an empty array clears any prior block.
  function _renderBulkWarnings(warnings: MasterDataBulkWarning[]): void {
    const host = document.getElementById('md-bulk-warnings');
    if (!host) return;
    host.textContent = '';
    if (!warnings.length) return;
    const list = document.createElement('div');
    list.className = 'admin-bwarn-list';
    for (const w of warnings) {
      const row = document.createElement('div');
      row.className = `admin-bwarn-row admin-bwarn-${w.level || 'warn'}`;
      const lvl = document.createElement('span');
      lvl.className = 'admin-bwarn-lvl';
      lvl.textContent = (w.level || 'warn').toUpperCase();
      const msg = document.createElement('span');
      msg.className = 'admin-bwarn-msg';
      msg.textContent = w.msg || '';
      row.appendChild(lvl);
      row.appendChild(msg);
      list.appendChild(row);
    }
    host.appendChild(list);
  }

  async function _save(table: MasterDataTable): Promise<void> {
    const state = _cache[table];
    if (!state) return;
    const keys = KEY_COLS[table];

    // Build upserts from dirty + added.
    const upserts: MasterDataRow[] = [];
    state.dirty.forEach((patch, _key) => { if (!state.deleted.has(_key)) upserts.push(patch); });
    // Plain for..of (not .forEach) so `return` here genuinely aborts _save() —
    // a .forEach callback's `return` only skipped that one row and let the save
    // proceed with the rest, silently persisting everything except the invalid
    // row(s) instead of rejecting the save outright as the toast wording implies.
    for (const row of state.added) {
      // Validate that key columns are filled.
      const missing = keys.filter((k) => !row[k]);
      if (missing.length) {
        Toast.show(Util.t('toast.missing_required_key') + ': ' + missing.join(', '), 'error');
        return;
      }
      // Drop blank non-key cells so the column DEFAULT applies instead of a literal
      // ''. _addRow prefills EVERY column with '', and master_data.bulk_apply inserts
      // whatever keys the row carries — so a cell the admin left blank used to send ''
      // to the column, which fails outright on a NOT NULL column that has a default
      // (sap_workcenter.review_required and distribute_tooled are both BOOLEAN NOT
      // NULL DEFAULT ...). Omitting the key lets Postgres apply the default, which is
      // what makes "create the row now, configure it later" work.
      // Only ADDED rows are stripped: in a dirty patch for an existing row, ''
      // legitimately means "clear this field", so that path must keep sending it.
      const clean: MasterDataRow = {};
      for (const [k, v] of Object.entries(row)) {
        if (v === '' && !keys.includes(k)) continue;
        clean[k] = v;
      }
      upserts.push(clean);
    }

    // Build deletes.
    const deletes: MasterDataRow[] = [];
    state.deleted.forEach((rowKey) => {
      const row = _getRowByKey(table, rowKey);
      const d: MasterDataRow = {};
      keys.forEach((k) => { d[k] = row[k]; });
      deletes.push(d);
    });

    if (!upserts.length && !deletes.length) return;

    // Cascade confirmation for deletes that weren't already confirmed.
    if (deletes.length && (table === 'subnetworks' || table === 'plants' || table === 'material_plants' || table === 'sap_workcenter')) {
      try {
        const preview = await Util.fetchTraced(`${API}/master-data/${table}/cascade-preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deletes }),
        }).then(_okJson) as MasterDataCascadePreview;

        if (table === 'sap_workcenter') {
          // Both FKs (machine.sap_workcenter, order_distribution.sap_workcenter)
          // are ON DELETE RESTRICT — this table only ever blocks, never cascades.
          const nMachines = preview.machine ?? 0, nHeaders = preview.headers ?? 0;
          if (nMachines + nHeaders > 0) {
            const parts: string[] = [];
            if (nMachines > 0) parts.push(`${nMachines} machine${nMachines !== 1 ? 's' : ''}`);
            if (nHeaders > 0)  parts.push(`${nHeaders} distribution header${nHeaders !== 1 ? 's' : ''}`);
            const ok = await Modal.confirm({
              title:         `Cannot delete ${deletes.length} row${deletes.length !== 1 ? 's' : ''}`,
              message:       `This is referenced by ${parts.join(' and ')} — reassign or collapse those first.`,
              confirmLabel:  `OK`,
              tone:          'danger',
            }).then(() => false);
            if (!ok) return;
          }
        } else {
          const nPlants = preview.plants ?? 0, nLines = preview.machine ?? 0, nBom = preview.bom_items ?? 0;
          const total = nPlants + nLines + nBom;
          if (total > 0) {
            const parts: string[] = [];
            if (nPlants > 0) parts.push(`${nPlants} plant${nPlants !== 1 ? 's' : ''}`);
            if (nLines > 0)  parts.push(`${nLines} production line${nLines !== 1 ? 's' : ''}`);
            if (nBom > 0)    parts.push(`${nBom} BOM item${nBom !== 1 ? 's' : ''}`);
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
        }
      } catch (e) {
        // Fail closed: this preview only guards the deletes in this bulk save, but
        // there is no safe way to split them out of the request below — abort the
        // whole save rather than let unverified deletes (which could look like "zero
        // dependents" if we fell through to an ordinary confirm) reach the backend.
        ErrorLog.error('master-data', `Cascade preview fetch failed for ${table}: ${(e as Error).message}`);
        Toast.show(Util.t('toast.cascade_preview_failed'), 'error');
        return;
      }
    }

    try {
      const res = await Util.fetchTraced(`${API}/master-data/${table}/bulk`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ upserts, deletes }),
      }).then((r) => {
        if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); });
        return r.json() as Promise<MasterDataBulkResult>;
      });

      Toast.show(
        Util.t('toast.paste_result', { added: res.inserted, updated: res.updated }) + `, ${res.deleted} deleted`,
        'success'
      );
      delete _cache[table];
      await _loadAndRender(table);
      // `_loadAndRender` → `_renderTable` rebuilds `#md-bulk-warnings` fresh
      // on every call (host.innerHTML = ''), so this has to run AFTER it,
      // not before — the success toast stays the primary signal; this is
      // the informational, non-blocking layer beneath it (§4.1).
      _renderBulkWarnings(res.warnings || []);

      // Refresh master-data in Store so Hierarchy/ProdLines stay in sync.
      Promise.all([
        Util.fetchTraced(`${API}/master-data/plants`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok ? r.json() : null) as Promise<MasterDataResponse<NimbusMasterPlant> | null>,
        Util.fetchTraced(`${API}/master-data/machine`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok ? r.json() : null) as Promise<MasterDataResponse<NimbusMasterLine> | null>,
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
            // This refresh only re-fetches plants/machine (the two tables the
            // Hierarchy/ProdLines consumers below actually need); it is not
            // work-center-specific and has no sap_workcenter rows in scope
            // even when `table === 'sap_workcenter'`. setMasterData replaces
            // the whole object (Store.setMasterData in store.mts), so
            // omitting this field — or passing [] — would silently wipe
            // whatever work-center data persistence.mts's boot-time fetch
            // already populated. Preserve the current in-memory value
            // instead of firing a redundant new /master-data/sap_workcenter
            // request here.
            workcenters: Store.masterData?.workcenters ?? [],
          }, 'master-data-save');
        } else {
          Store.emit({ type: 'master-data-changed', table, source: 'master-data-save' });
        }
      }).catch(() => {
        Store.emit({ type: 'master-data-changed', table, source: 'master-data-save' });
      });
    } catch (e) {
      Toast.show(Util.t('toast.save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('master-data', `Save failed for ${table}: ${(e as Error).message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Filter / search
  // -----------------------------------------------------------------------
  function _applyFilter(table: MasterDataTable, query: string): void {
    const tbody = document.getElementById(`md-tbody-${table}`);
    if (!tbody) return;
    tbody.querySelectorAll('tr').forEach((tr) => {
      const text = (tr.textContent || '').toLowerCase();
      tr.hidden = query ? !text.includes(query) : false;
    });
  }

  // -----------------------------------------------------------------------
  // Column management
  // -----------------------------------------------------------------------
  function _openColMenu(table: MasterDataTable, col: MasterDataColumn, anchor: HTMLElement): void {
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

    const close = (e: MouseEvent): void => { if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  function _openAddColumn(table: MasterDataTable): void {
    (document.getElementById('md-col-name') as HTMLInputElement).value  = '';
    (document.getElementById('md-col-label') as HTMLInputElement).value = '';
    (document.getElementById('md-col-type') as HTMLSelectElement).value  = 'TEXT';
    (document.getElementById('md-col-length') as HTMLInputElement).value = '';
    (document.getElementById('md-col-default') as HTMLInputElement).value = '';
    (document.getElementById('md-col-nullable') as HTMLInputElement).checked = true;
    (document.getElementById('md-addcol-error') as HTMLElement).textContent = '';
    (document.getElementById('md-col-length-row') as HTMLElement).hidden = true;

    const typeSelect = document.getElementById('md-col-type') as HTMLSelectElement;
    typeSelect.onchange = () => {
      (document.getElementById('md-col-length-row') as HTMLElement).hidden = typeSelect.value !== 'NUMERIC';
    };

    (document.getElementById('md-addcol-confirm-btn') as HTMLButtonElement).onclick = async () => {
      const colName  = (document.getElementById('md-col-name') as HTMLInputElement).value.trim();
      const label    = (document.getElementById('md-col-label') as HTMLInputElement).value.trim() || colName;
      const sqlType  = (document.getElementById('md-col-type') as HTMLSelectElement).value;
      const length   = (document.getElementById('md-col-length') as HTMLInputElement).value.trim() || null;
      const nullable = (document.getElementById('md-col-nullable') as HTMLInputElement).checked;
      const def      = (document.getElementById('md-col-default') as HTMLInputElement).value.trim() || null;
      const errEl    = document.getElementById('md-addcol-error') as HTMLElement;

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
        await Util.fetchTraced(`${API}/master-data/${table}/columns`, {
          method:  'POST',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify({ column_name: colName, sql_type: sqlType, length, nullable, default: def, display_label: label }),
        }).then((r) => {
          if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); });
          return r.json();
        });
        Toast.show(Util.t('toast.col_added', { label }), 'success');
        delete _cache[table];
        _loadAndRender(table);
      } catch (e) {
        Toast.show(Util.t('toast.failed_add_col', { msg: (e as Error).message }), 'error');
      }
    };

    Modal.open('md-addcol-modal');
  }

  async function _dropColumn(table: MasterDataTable, col: MasterDataColumn): Promise<void> {
    const confirmed = await Modal.confirm({
      title:         Util.t('modal.drop_column_title', { label: col.display_label }),
      message:       Util.t('modal.drop_column_msg', { name: col.column_name, table: TABLE_LABELS[table] }),
      detail:        `<strong>${Util.t('modal.delete_cannot_undo')}</strong>`,
      confirmLabel:  Util.t('modal.drop_column_confirm'),
      tone:          'danger',
    });
    if (!confirmed) return;

    try {
      await Util.fetchTraced(`${API}/master-data/${table}/columns/${col.column_name}`, {
        method:  'DELETE',
      }).then((r) => {
        if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); });
        return r.json();
      });
      Toast.show(Util.t('toast.column_dropped', { col: col.column_name }), 'success');
      delete _cache[table];
      _loadAndRender(table);
    } catch (e) {
      Toast.show(Util.t('toast.failed_drop_column', { msg: (e as Error).message }), 'error');
    }
  }

  function _openRenameLabel(table: MasterDataTable, col: MasterDataColumn): void {
    const noteEl  = document.getElementById('md-rename-note');
    const inputEl = document.getElementById('md-rename-label-input') as HTMLInputElement;
    if (noteEl)  noteEl.textContent = `Column ID: "${col.column_name}" (unchanged) · Table: ${TABLE_LABELS[table]}`;
    if (inputEl) inputEl.value = col.display_label;

    (document.getElementById('md-rename-confirm-btn') as HTMLButtonElement).onclick = async () => {
      const newLabel = inputEl.value.trim();
      if (!newLabel) return;
      Modal.close('md-renamelabel-modal');
      try {
        await Util.fetchTraced(`${API}/master-data/${table}/columns/${col.column_name}`, {
          method:  'PATCH',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify({ display_label: newLabel }),
        }).then((r) => {
          if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); });
          return r.json();
        });
        Toast.show(Util.t('toast.column_label_updated', { label: newLabel }), 'success');
        delete _cache[table];
        _loadAndRender(table);
      } catch (e) {
        Toast.show(Util.t('toast.failed_rename_label', { msg: (e as Error).message }), 'error');
      }
    };
    Modal.open('md-renamelabel-modal');
  }

  // Pulls the current column state (whichever DB this app is pointed at —
  // local or Azure) back out as idempotent SQL, so drift from the Add/Drop
  // Column wizard (which mutates the live DB directly, with no git record)
  // can be folded back into schema.sql after the fact.
  async function _exportSchema(): Promise<void> {
    const textEl  = document.getElementById('md-schema-export-text') as HTMLTextAreaElement;
    const copyBtn = document.getElementById('md-schema-export-copy-btn') as HTMLButtonElement;
    textEl.value = '…';
    Modal.open('md-schema-export-modal');
    try {
      const data = await Util.fetchTraced(`${API}/master-data/_schema-export`).then((r) => {
        if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); });
        return r.json() as Promise<{ sql?: string }>;
      });
      textEl.value = data.sql || '';
    } catch (e) {
      textEl.value = '';
      Toast.show(Util.t('toast.failed_schema_export', { msg: (e as Error).message }), 'error');
    }
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(textEl.value)
        .then(() => Toast.show(Util.t('toast.schema_copied'), 'success'))
        .catch(() => Toast.show(Util.t('toast.clipboard_denied'), 'error'));
    };
  }

  async function syncLineSettings(line: string, patch: Partial<NimbusLineSetting>): Promise<void> {
    const plant = Store.getPlantForLine(line);
    if (!plant) return;

    if (!_lineSyncMachineCache[plant]) {
      try {
        const data = await Util.fetchTraced(`${API}/master-data/machine?${new URLSearchParams({ plant }).toString()}`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<MasterDataResponse<ProductionLineRow>>;
        });
        _lineSyncMachineCache[plant] = {
          columns: data.columns, rows: data.rows,
          dirty: new Map(), deleted: new Set(), added: [],
        };
      } catch { return; }
    }

    const state = _lineSyncMachineCache[plant]!;
    const rowIdx = state.rows.findIndex((r) => r.machine === line);
    if (rowIdx < 0) return;

    const updatedRow = { ...state.rows[rowIdx] };
    if ('excludeFromOpt' in patch) updatedRow.excl_optimizer  = patch.excludeFromOpt ? 'X' : null;
    if ('bottleneck'     in patch) updatedRow.bottleneck      = patch.bottleneck     ? 'X' : null;
    if ('bufferUnit'     in patch) updatedRow.buffer_type     = patch.bufferUnit === 'pct' ? '%' : 'hrs';
    if ('bufferPct'      in patch) updatedRow.buffer_percent  = patch.bufferPct;
    if ('bufferHours'    in patch) updatedRow.buffer_hours    = patch.bufferHours;
    if ('plGroup'        in patch) updatedRow.wc_group        = patch.plGroup || null;
    if ('sapWorkcenter'  in patch) updatedRow.sap_workcenter  = patch.sapWorkcenter || null;
    if ('distributionWeight' in patch) updatedRow.distribution_weight = patch.distributionWeight ?? null;

    // Update cache row and clear any stale dirty flag so MasterData table stays consistent.
    state.rows[rowIdx] = updatedRow;
    state.dirty.delete(_rowKey('machine', updatedRow));

    try {
      await Util.fetchTraced(`${API}/master-data/machine/bulk`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ upserts: [updatedRow], deletes: [] }),
      }).then((r) => {
        if (!r.ok) return r.json().then((e) => { throw new Error(e.detail || `HTTP ${r.status}`); });
        return r.json();
      });
      if (_activeTable === 'machine') _renderTable('machine');
    } catch (e) {
      ErrorLog.error('prod-lines', `Failed to save line setting: ${(e as Error).message}`);
    }
  }

  return { render, syncLineSettings };
})();

/* =============================================================================
   WORK CENTERS — Master Data › Work Centers sub-tab (§4.3)
   ========================================================================== */

// "More info" popover copy for the two Work Centers checkboxes — same
// RULE_HELP/_openFieldInfoMenu/_showFieldInfoPopover mechanism the Scheduling
// Rules pane uses (this file, `RULE_HELP` above `Plant`), reused directly
// (both live in this module) rather than via a right-click menu: each
// checkbox gets its own small "More info" button instead, since there's no
// existing per-row contextmenu delegation over this pane worth adding.
const WC_INFO_HELP: Record<string, { title: string; help: string[] }> = {
  review_required:   { title: 'ui.wc_review_required_label',   help: ['ui.wc_review_required_help'] },
  distribute_tooled: { title: 'ui.wc_distribute_tooled_label', help: ['ui.wc_distribute_tooled_help'] },
};

function _wcMembers(machines: ProductionLineRow[], code: string): ProductionLineRow[] {
  return machines.filter((m) => m.sap_workcenter === code);
}

// Weight semantics per aggregate_to_detail.md §3.2: if every current
// member's weight is NULL, the split is even; once any member has a real
// weight, NULL members get 0 (not an equal share) — "set the percentages
// you care about" rather than silently creating sliver sub-orders.
function _wcEffectivePercents(memberNames: string[], weights: Record<string, number | null>): Record<string, number> {
  const out: Record<string, number> = {};
  const anySet = memberNames.some((m) => weights[m] != null);
  if (!anySet) {
    const even = memberNames.length ? 100 / memberNames.length : 0;
    memberNames.forEach((m) => { out[m] = even; });
    return out;
  }
  const sum = memberNames.reduce((s, m) => s + (weights[m] ?? 0), 0);
  memberNames.forEach((m) => { out[m] = sum > 0 ? ((weights[m] ?? 0) / sum) * 100 : 0; });
  return out;
}

// Retained not for a per-field dirty *list* (autosave has no such UI — the
// old Save/Discard badge is gone) but as the comparison _maybeFlush uses to
// decide whether a held edit is worth re-attempting.
const WC_SCALAR_FIELDS = ['description', 'distribution_mode', 'default_machine', 'max_separation', 'review_required', 'distribute_tooled'] as const;

function _wcStagedEqual(a: WorkCenterStaged, b: WorkCenterStaged): boolean {
  if (WC_SCALAR_FIELDS.some((f) => a[f] !== b[f])) return false;
  const keys = new Set([...Object.keys(a.weights), ...Object.keys(b.weights)]);
  for (const k of keys) {
    if ((a.weights[k] ?? null) !== (b.weights[k] ?? null)) return false;
  }
  return true;
}

// Shared shape between a persisted WorkCenterRow and a live WorkCenterStaged
// edit buffer. Used both to seed _selectRow's staged copy and — with an
// empty weights map, since none of _wcBlockReason's three rules look at
// weights — to run that same gate against every un-selected sidebar row's
// own saved values, for the sidebar's warning glyph.
function _wcStagedBase(row: WorkCenterRow): WorkCenterStaged {
  return {
    description:       row.description || '',
    distribution_mode: row.distribution_mode,
    default_machine:   row.default_machine || '',
    max_separation:    row.max_separation,
    review_required:   row.review_required,
    distribute_tooled: row.distribute_tooled,
    weights: {},
  };
}

// Client-side mirror of the three PUT /distribution/{plant}/workcenters/{wc}
// pre-flight rules (backend/distribution/data.py:161-172) — see
// WorkCenters._wcBlockReason below for the rules themselves.
type WcBlockReason = 'single_mode_without_default' | 'default_machine_not_member' | 'distribute_mode_thin' | null;

function _wcNoticeText(reason: Exclude<WcBlockReason, null>, memberCount: number): string {
  switch (reason) {
    case 'single_mode_without_default': return Util.t('ui.wc_single_needs_default');
    case 'default_machine_not_member':  return Util.t('ui.wc_default_not_member');
    case 'distribute_mode_thin':
      // Zero members is only fixable from the Machines tab (membership
      // isn't edited here, per WorkCenterStaged's own doc comment) — say so
      // instead of repeating the generic "needs 2+ members" copy a
      // one-member work center would also see.
      return memberCount === 0 ? Util.t('ui.wc_blocked_needs_members') : Util.t('ui.wc_distribute_thin_warning');
  }
}

function _wcNoticesInnerHtml(reason: WcBlockReason, memberCount: number): string {
  if (!reason) return '';
  return `<p class="wc-inline-warn">${Util.escapeHtml(_wcNoticeText(reason, memberCount))}</p>`;
}

export const WorkCenters = {
  _rows: [] as WorkCenterRow[],
  _machines: [] as ProductionLineRow[],
  _search: '',
  _offset: 0,
  _total: 0,
  _loadedPlant: null as string | null,
  _shellPlant: null as string | null, // which plant the current sidebar/search DOM shell was built for — see _renderPane
  _selected: null as string | null,
  _staged: null as WorkCenterStaged | null,
  _baseline: null as WorkCenterStaged | null, // "last known saved state" (autosave repurposing — was dirty-comparison baseline under the old Save/Discard model)
  _dirty: false,      // true from the moment _staged diverges from what's been sent until a write for it is actually dispatched
  _saving: false,     // a PUT is in flight
  _editSeq: 0,        // bumped on every _staged mutation/replacement; lets a slow response detect it's now stale
  _queued: null as WorkCenterWriteRequest | null, // a flushed-but-can't-send-yet write, captured against the row it belonged to — see _flushPending

  // Fires _autosave() ~500ms after the last Description/weight keystroke.
  // Util.debounce (foundation.mts) has no cancel/flush handle, so
  // _flushPending() below can't cancel this timer — it just wins the race by
  // firing _autosave() itself first; _dirty already being false by the time
  // this stale timer fires makes that a harmless no-op.
  _debouncedAutosave: Util.debounce(() => void WorkCenters._autosave(), 500),

  // Called from App._MASTER_SUBS' 'work-centers' entry (application-shell.mts)
  // whenever the sub-tab is activated, and again on 'plant:selected' while it
  // is the visible sub-tab (same wiring Plant/ProdLines use). A genuine plant
  // change does a full reload; re-navigating back to this sub-tab for the
  // SAME plant skips the work-center list/search/paging reload (preserving
  // any in-progress staged edit) but still refreshes the machine roster —
  // the §14.1 runbook's step 2 flow ("assign on Machines tab, set weights
  // here") crosses sub-tabs in one visit, and machine.sap_workcenter
  // membership assigned there wouldn't otherwise show up here until the
  // admin switched plants, which is a real correctness gap for that exact flow.
  async render(): Promise<void> {
    const pane = document.getElementById('md-master-work-centers-pane');
    if (!pane) return;
    const plant = Store.selectedPlant;
    if (!plant) {
      pane.innerHTML = `<div class="md-empty">${Util.t('empty.wc_select_plant')}</div>`;
      return;
    }
    if (plant !== WorkCenters._loadedPlant) {
      // Flush before the reset below discards _selected/_staged/_baseline —
      // otherwise a still-debounced edit on the OLD plant's selected work
      // center is silently dropped, the same hazard _selectRow guards
      // against for a same-plant row switch.
      WorkCenters._flushPending();
      WorkCenters._loadedPlant = plant;
      WorkCenters._selected = null;
      WorkCenters._staged = null;
      WorkCenters._baseline = null;
      WorkCenters._offset = 0;
      WorkCenters._search = '';
      await WorkCenters._loadAll(plant, true);
    } else {
      await WorkCenters._refreshMachines(plant);
    }
    WorkCenters._renderPane();
    // Recovers the one dead end _wcBlockReason creates: a held edit whose
    // gate failed only for a reason that gets fixed elsewhere (e.g. adding a
    // machine to a 0-member distribute work center, on the Machines tab)
    // lands on its own the next time this sub-tab re-renders, rather than
    // needing the admin to re-touch every field.
    WorkCenters._maybeFlush();
  },

  async _refreshMachines(plant: string): Promise<void> {
    try {
      const data = await Util.fetchTraced(`${Config.API_BASE}/master-data/machine?${new URLSearchParams({ plant }).toString()}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<MasterDataResponse<ProductionLineRow>>;
      });
      WorkCenters._machines = data.rows;
    } catch {
      // Best-effort refresh — keep showing the last-known roster rather than
      // erroring out of an otherwise-successful tab render.
    }
  },

  async _loadAll(plant: string, reset: boolean): Promise<void> {
    const API = Config.API_BASE;
    if (reset) WorkCenters._offset = 0;
    try {
      const params = new URLSearchParams({ plant, limit: '50', offset: String(WorkCenters._offset) });
      if (WorkCenters._search) params.set('search', WorkCenters._search);
      const wcFetch = Util.fetchTraced(`${API}/master-data/sap_workcenter?${params.toString()}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<MasterDataResponse<WorkCenterRow>>;
      });
      // Whole-plant machine fetch — bounded by plant (Production Scale
      // Roadmap: ~70+ machines/plant is fine to load in full; never all
      // plants at once). Needed for membership derivation (machine.sap_workcenter),
      // the default-machine combobox, and the New-form shadowed-code check.
      // Only re-fetched on a real reset (plant/search change), not on
      // "Load more" paging through the work-center list — the machine roster
      // doesn't change just because another page of work centers loaded.
      const machFetch = reset
        ? Util.fetchTraced(`${API}/master-data/machine?${new URLSearchParams({ plant }).toString()}`).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json() as Promise<MasterDataResponse<ProductionLineRow>>;
          })
        : null;
      const [wcData, machData] = await Promise.all([wcFetch, machFetch]);
      WorkCenters._rows = reset ? wcData.rows : WorkCenters._rows.concat(wcData.rows);
      WorkCenters._total = wcData.meta?.total ?? WorkCenters._rows.length;
      if (machData) WorkCenters._machines = machData.rows;
    } catch (e) {
      ErrorLog.error('work-centers', `Failed to load work centers: ${(e as Error).message}`);
      Toast.show(Util.t('toast.wc_load_failed'), 'error');
    }
  },

  // Full innerHTML rebuild only when the shell doesn't exist yet or belongs
  // to a different plant (_shellPlant mismatch) — mirrors ProdLines._renderNav's
  // build-once-else-patch idiom (2243-2264). Everything else (search typing,
  // load-more paging, row selection, every field edit) refreshes
  // #wc-list-body/#wc-detail-col surgically via _renderSidebarList/
  // _renderDetailOnly instead. Rebuilding the whole pane on every keystroke
  // used to destroy #wc-search mid-word the instant its 250ms debounce
  // fired — this split is what fixes that. After this split, _renderPane()
  // is reachable only from render() (tab activate / plant switch); nothing
  // else in this file may call it.
  _renderPane(): void {
    const pane = document.getElementById('md-master-work-centers-pane');
    if (!pane) return;
    const plant = Store.selectedPlant;
    const isAdmin = Session.isAdmin();

    if (!document.getElementById('wc-search') || WorkCenters._shellPlant !== plant) {
      WorkCenters._shellPlant = plant;
      pane.innerHTML = `
        <div class="lines-split">
          <div class="lines-nav wc-nav">
            <div class="lines-nav-header">
              <div class="lines-nav-title" id="wc-nav-title"></div>
              <input type="search" id="wc-search" class="input" placeholder="${Util.escapeHtml(Util.t('ph.search_work_centers'))}" value="${Util.escapeHtml(WorkCenters._search)}">
            </div>
            ${isAdmin ? '' : `<p class="panel-hint" style="padding:8px 12px 0;">${Util.escapeHtml(Util.t('ui.wc_admins_edit'))}</p>`}
            <div class="lines-nav-list wc-list-body" id="wc-list-body"></div>
            <button class="btn btn-ghost sm wc-load-more" id="wc-load-more" hidden>${Util.escapeHtml(Util.t('btn.load_more'))}</button>
          </div>
          <div class="cal-scroll">
            <div class="cal-container" id="wc-detail-col"></div>
          </div>
        </div>`;
      WorkCenters._wireShell(pane);
    }

    WorkCenters._renderSidebarList();
    WorkCenters._renderDetailOnly();
  },

  // Wired exactly once per shell build (search/load-more are destroyed and
  // recreated only when _renderPane rebuilds the shell above, so there's no
  // double-binding risk here the way ProdLines' persistent filter dropdown
  // needs a `._wired` guard for).
  _wireShell(pane: HTMLElement): void {
    const search = pane.querySelector<HTMLInputElement>('#wc-search');
    if (search) {
      search.oninput = Util.debounce(() => {
        WorkCenters._search = search.value;
        const plant = Store.selectedPlant;
        if (!plant) return;
        void WorkCenters._loadAll(plant, true).then(() => {
          WorkCenters._renderSidebarList();
          WorkCenters._renderDetailOnly();
        });
      }, 250);
    }

    const loadMore = pane.querySelector<HTMLButtonElement>('#wc-load-more');
    if (loadMore) loadMore.onclick = () => {
      const plant = Store.selectedPlant;
      if (!plant) return;
      WorkCenters._offset += 50;
      void WorkCenters._loadAll(plant, false).then(() => WorkCenters._renderSidebarList());
    };
  },

  // Rebuilds #wc-list-body's rows and the load-more button's visibility.
  // Never touches #wc-search — this is exactly what makes typing in it safe
  // across a debounced reload.
  _renderSidebarList(): void {
    const listBody = document.getElementById('wc-list-body');
    if (!listBody) return;
    const titleEl = document.getElementById('wc-nav-title');
    if (titleEl) titleEl.textContent = `${Util.t('tab.work_centers')} · ${WorkCenters._total}`;

    const rows = WorkCenters._rows;
    const listRows = rows.map((r, i) => {
      const color = Config.COLORS[i % Config.COLORS.length];
      const members = _wcMembers(WorkCenters._machines, r.sap_workcenter).map((m) => m.machine);
      const n = members.length;
      const reason = WorkCenters._wcBlockReason(_wcStagedBase(r), members);
      return `
      <div class="lines-nav-item${r.sap_workcenter === WorkCenters._selected ? ' active' : ''}" data-code="${Util.escapeHtml(r.sap_workcenter)}">
        <span class="line-dot" style="background:${color};display:inline-block;width:7px;height:7px;border-radius:50%;flex-shrink:0;"></span>
        <span class="lines-nav-label">${Util.escapeHtml(r.sap_workcenter)}</span>
        ${n > 0 ? `<span class="wc-member-count" title="${Util.escapeHtml(Util.t('ui.wc_member_count_tip', { n }))}">${n}</span>` : ''}
        ${reason ? `<span class="lines-nav-bottleneck" title="${Util.escapeHtml(_wcNoticeText(reason, n))}">⚠</span>` : ''}
      </div>`;
    }).join('');
    listBody.innerHTML = listRows || `<div class="lines-nav-empty">${Util.escapeHtml(Util.t('empty.no_work_centers'))}</div>`;

    // Delegated click on the list container itself (ProdLines._renderNav/
    // _wireNav's idiom, 2329-2338) — #wc-list-body's own identity survives
    // every call to this method (only the shell rebuild in _renderPane ever
    // replaces the node itself), so one binding here covers every row.
    listBody.onclick = (e: MouseEvent) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('.lines-nav-item');
      if (!item) return;
      const code = item.dataset.code;
      if (code) WorkCenters._selectRow(code);
    };

    const loadMoreBtn = document.getElementById('wc-load-more') as HTMLButtonElement | null;
    if (loadMoreBtn) loadMoreBtn.hidden = rows.length >= WorkCenters._total;
  },

  // Rebuilds only #wc-detail-col. Called on selection change, on a search/
  // load-more refresh, and on a failed write's rollback — never on a
  // successful autosave, which only needs the narrower _refreshNoticesOnly/
  // _refreshSidebarRow surgical updates (see _write).
  _renderDetailOnly(): void {
    const col = document.getElementById('wc-detail-col');
    if (!col) return;
    const isAdmin = Session.isAdmin();
    col.innerHTML = WorkCenters._selected
      ? WorkCenters._detailHtml(isAdmin)
      : `<div class="md-empty">${Util.escapeHtml(Util.t('empty.wc_select_row'))}</div>`;
    if (WorkCenters._selected) WorkCenters._wireDetail(col, isAdmin);
  },

  _detailHtml(isAdmin: boolean): string {
    const staged = WorkCenters._staged;
    const code = WorkCenters._selected;
    if (!staged || !code) return '';

    const members = _wcMembers(WorkCenters._machines, code).map((m) => m.machine);
    const pct = _wcEffectivePercents(members, staged.weights);
    const totalPct = members.reduce((s, m) => s + (pct[m] || 0), 0);
    const evenState = members.every((m) => staged.weights[m] == null);
    const reason = WorkCenters._wcBlockReason(staged, members);

    const gi = WorkCenters._rows.findIndex((r) => r.sap_workcenter === code);
    const color = Config.COLORS[(gi >= 0 ? gi : 0) % Config.COLORS.length];

    const sepOptions = (['none', 'hour', 'day', 'week'] as const).map((v) =>
      `<option value="${v}"${staged.max_separation === v ? ' selected' : ''}>${Util.escapeHtml(Util.t(`ui.wc_max_sep_${v}`))}</option>`).join('');

    const memberRows = members.length ? members.map((m) => {
      const w = staged.weights[m];
      const pctText = pct[m] != null ? pct[m].toFixed(1) + '%' : '—';
      // The `.wc-not-set` span is always emitted (just `hidden` when not
      // applicable) so _refreshMembershipMath can toggle it in place after a
      // weight edit or the Even button, instead of needing a row rebuild.
      const notSetHidden = !(w == null && !evenState);
      return `
      <tr>
        <td class="md-td">${Util.escapeHtml(m)}</td>
        <td class="md-td">${isAdmin
          ? `<input type="number" step="any" min="0" class="input wc-weight-input" data-machine="${Util.escapeHtml(m)}" value="${w == null ? '' : w}" placeholder="${Util.escapeHtml(Util.t('ui.wc_even_placeholder'))}">`
          : (w == null ? '—' : Util.escapeHtml(String(w)))}</td>
        <td class="md-td">
          <span class="wc-pct-cell" data-machine="${Util.escapeHtml(m)}">${pctText}</span>
          <span class="wc-not-set" data-machine="${Util.escapeHtml(m)}"${notSetHidden ? ' hidden' : ''}>${Util.escapeHtml(Util.t('ui.wc_not_set_zero'))}</span>
        </td>
        <td class="md-td">—</td>
      </tr>`;
    }).join('') : `<tr><td class="md-td" colspan="4">${Util.escapeHtml(Util.t('empty.wc_no_members'))}</td></tr>`;

    return `
      <div class="lines-detail">
        <div class="ld-header">
          <span class="line-dot" style="background:${color};width:14px;height:14px;border-radius:50%;display:inline-block;flex-shrink:0;"></span>
          <span class="ld-name">${Util.escapeHtml(code)}</span>
          <span class="plant-badge" style="margin-left:auto;">${Util.escapeHtml(Store.selectedPlant || '—')}</span>
        </div>

        <div class="ld-settings-row">
          <label class="ld-ctrl-label">
            <input type="checkbox" id="wc-review-required" ${staged.review_required ? 'checked' : ''} ${isAdmin ? '' : 'disabled'}>
            ${Util.escapeHtml(Util.t('ui.wc_review_required_label'))}
          </label>
          ${isAdmin ? `<button type="button" class="wc-info-btn" data-info="review_required" title="${Util.escapeHtml(Util.t('ui.more_info'))}">&#9432;</button>` : ''}
          <label class="ld-ctrl-label">
            <input type="checkbox" id="wc-distribute-tooled" ${staged.distribute_tooled ? 'checked' : ''} ${isAdmin ? '' : 'disabled'}>
            ${Util.escapeHtml(Util.t('ui.wc_distribute_tooled_label'))}
          </label>
          ${isAdmin ? `<button type="button" class="wc-info-btn" data-info="distribute_tooled" title="${Util.escapeHtml(Util.t('ui.more_info'))}">&#9432;</button>` : ''}
          <span class="ld-buffer">
            <span class="ld-buffer-label">${Util.escapeHtml(Util.t('col.description'))}</span>
            ${isAdmin ? `<input type="text" class="input" id="wc-desc" style="width:200px;" value="${Util.escapeHtml(staged.description)}">`
                       : `<span class="wc-ro-value">${Util.escapeHtml(staged.description || '—')}</span>`}
          </span>
          <span class="ld-buffer">
            <span class="ld-buffer-label">${Util.escapeHtml(Util.t('col.distribution_mode'))}</span>
            ${isAdmin ? `<select class="input" id="wc-mode" style="width:180px;">
                <option value="distribute"${staged.distribution_mode === 'distribute' ? ' selected' : ''}>${Util.escapeHtml(Util.t('ui.wc_mode_distribute'))}</option>
                <option value="single"${staged.distribution_mode === 'single' ? ' selected' : ''}>${Util.escapeHtml(Util.t('ui.wc_mode_single'))}</option>
              </select>`
                       : `<span class="wc-ro-value">${Util.escapeHtml(Util.t(staged.distribution_mode === 'single' ? 'ui.wc_mode_single' : 'ui.wc_mode_distribute'))}</span>`}
          </span>
          <span class="ld-buffer">
            <span class="ld-buffer-label">${Util.escapeHtml(Util.t('col.default_machine'))}</span>
            ${isAdmin ? `<div id="wc-default-machine-combo" style="width:160px;"></div>`
                       : `<span class="wc-ro-value">${Util.escapeHtml(staged.default_machine || '—')}</span>`}
          </span>
          <span class="ld-buffer">
            <span class="ld-buffer-label">${Util.escapeHtml(Util.t('col.max_separation'))}</span>
            ${isAdmin ? `<select class="input" id="wc-max-sep" style="width:150px;">${sepOptions}</select>`
                       : `<span class="wc-ro-value">${Util.escapeHtml(Util.t(`ui.wc_max_sep_${staged.max_separation}`))}</span>`}
          </span>
        </div>

        <div id="wc-notices">${_wcNoticesInnerHtml(reason, members.length)}</div>

        <div class="ld-section">
          <div class="ld-section-head">
            <span class="ld-section-title">${Util.escapeHtml(Util.t('ui.wc_membership_title'))}</span>
            ${isAdmin ? `<button class="btn btn-ghost sm" id="wc-even-btn">${Util.escapeHtml(Util.t('btn.even'))}</button>` : ''}
          </div>
          <div class="ld-section-body">
            <div class="md-table-wrap">
              <table class="md-table">
                <thead><tr>
                  <th class="md-th">${Util.escapeHtml(Util.t('col.machine'))}</th>
                  <th class="md-th">${Util.escapeHtml(Util.t('col.weight'))}</th>
                  <th class="md-th">${Util.escapeHtml(Util.t('col.effective_pct'))}</th>
                  <th class="md-th">${Util.escapeHtml(Util.t('col.open_distributions'))}</th>
                </tr></thead>
                <tbody id="wc-member-tbody">${memberRows}</tbody>
                <tfoot><tr>
                  <td class="md-td"><strong>${Util.escapeHtml(Util.t('ui.wc_total_row'))}</strong></td>
                  <td class="md-td"></td>
                  <td class="md-td"><strong id="wc-total-pct">${members.length ? totalPct.toFixed(1) + '%' : '—'}</strong></td>
                  <td class="md-td"></td>
                </tr></tfoot>
              </table>
            </div>
            <p class="panel-hint">${Util.escapeHtml(Util.t('ui.wc_assign_hint'))}</p>
          </div>
        </div>
      </div>`;
  },

  // Flushes any still-debounced edit for the PREVIOUSLY selected code (see
  // _flushPending) before overwriting _staged/_baseline for the newly
  // clicked row — otherwise the old row's last keystrokes are simply
  // discarded the instant _staged is replaced below.
  _selectRow(code: string): void {
    if (!code || code === WorkCenters._selected) return;
    WorkCenters._flushPending();

    const row = WorkCenters._rows.find((r) => r.sap_workcenter === code);
    if (!row) return;

    const members = _wcMembers(WorkCenters._machines, code).map((m) => m.machine);
    const weights: Record<string, number | null> = {};
    for (const m of members) {
      const mach = WorkCenters._machines.find((x) => x.machine === m);
      weights[m] = (mach && mach.distribution_weight != null) ? Number(mach.distribution_weight) : null;
    }
    const staged: WorkCenterStaged = { ..._wcStagedBase(row), weights };
    WorkCenters._selected = code;
    WorkCenters._staged   = staged;
    WorkCenters._baseline = { ...staged, weights: { ...weights } };
    WorkCenters._dirty    = false;
    WorkCenters._editSeq++; // discontinuity marker — see _write's rollback guard

    document.querySelectorAll<HTMLElement>('#wc-list-body .lines-nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.code === code);
    });
    WorkCenters._renderDetailOnly();
  },

  // Recomputes only the membership table's % cells, total, and the
  // per-machine "not set" markers (not a full re-render) so typing in a
  // weight input doesn't lose focus/cursor position on every keystroke —
  // the "live % preview" the §14.1 runbook calls for, without the classic
  // full-rebuild-steals-focus bug this codebase has hit before (see
  // CLAUDE.md's drag spring-back history for why stale-index/full-rebuild
  // bugs from over-eager re-renders are taken seriously here).
  _refreshMembershipMath(members: string[]): void {
    const staged = WorkCenters._staged;
    if (!staged) return;
    const pct = _wcEffectivePercents(members, staged.weights);
    const evenState = members.every((m) => staged.weights[m] == null);
    let total = 0;
    for (const m of members) {
      const cell = document.querySelector<HTMLElement>(`.wc-pct-cell[data-machine="${CSS.escape(m)}"]`);
      if (cell) cell.textContent = pct[m] != null ? pct[m].toFixed(1) + '%' : '—';
      const marker = document.querySelector<HTMLElement>(`.wc-not-set[data-machine="${CSS.escape(m)}"]`);
      if (marker) marker.hidden = !(staged.weights[m] == null && !evenState);
      total += pct[m] || 0;
    }
    const totalCell = document.getElementById('wc-total-pct');
    if (totalCell) totalCell.textContent = members.length ? total.toFixed(1) + '%' : '—';
  },

  // Notices-only surgical refresh — replaces the old Save/Discard-era
  // _refreshDirtyOnly (there's no dirty badge or Save button left to enable).
  _refreshNoticesOnly(): void {
    const staged = WorkCenters._staged;
    const code = WorkCenters._selected;
    if (!staged || !code) return;
    const members = _wcMembers(WorkCenters._machines, code).map((m) => m.machine);
    const reason = WorkCenters._wcBlockReason(staged, members);
    const host = document.getElementById('wc-notices');
    if (host) host.innerHTML = _wcNoticesInnerHtml(reason, members.length);
  },

  // Patches one sidebar row's member-count badge and warning glyph in place
  // — used after a successful autosave so the sidebar reflects the new
  // persisted state without a full _renderSidebarList() rebuild (which would
  // also be harmless here, but every other autosave success path is
  // surgical-only by design, so this stays consistent with that).
  _refreshSidebarRow(code: string): void {
    const row = WorkCenters._rows.find((r) => r.sap_workcenter === code);
    const el = document.querySelector<HTMLElement>(`#wc-list-body .lines-nav-item[data-code="${CSS.escape(code)}"]`);
    if (!row || !el) return;
    const members = _wcMembers(WorkCenters._machines, code).map((m) => m.machine);
    const n = members.length;
    const reason = WorkCenters._wcBlockReason(_wcStagedBase(row), members);

    let countEl = el.querySelector<HTMLElement>('.wc-member-count');
    if (n > 0) {
      if (!countEl) {
        countEl = document.createElement('span');
        countEl.className = 'wc-member-count';
        el.appendChild(countEl);
      }
      countEl.textContent = String(n);
      countEl.title = Util.t('ui.wc_member_count_tip', { n });
    } else {
      countEl?.remove();
    }

    let warnEl = el.querySelector<HTMLElement>('.lines-nav-bottleneck');
    if (reason) {
      const text = _wcNoticeText(reason, n);
      if (!warnEl) {
        warnEl = document.createElement('span');
        warnEl.className = 'lines-nav-bottleneck';
        warnEl.textContent = '⚠';
        el.appendChild(warnEl);
      }
      warnEl.title = text;
    } else {
      warnEl?.remove();
    }
  },

  _wireDetail(pane: HTMLElement, isAdmin: boolean): void {
    if (!isAdmin) return;

    const staged = WorkCenters._staged;
    const code = WorkCenters._selected;
    if (!staged || !code) return;
    const members = _wcMembers(WorkCenters._machines, code).map((m) => m.machine);

    const descInp = pane.querySelector<HTMLInputElement>('#wc-desc');
    if (descInp) {
      descInp.oninput = () => {
        staged.description = descInp.value;
        WorkCenters._markDirty();
        WorkCenters._debouncedAutosave();
      };
      // Blur also flushes — "type, then immediately click another row"
      // must not lose the edit to a debounce timer that never gets a
      // chance to fire (see _flushPending).
      descInp.onchange = () => WorkCenters._flushPending();
    }

    const modeSel = pane.querySelector<HTMLSelectElement>('#wc-mode');
    if (modeSel) modeSel.onchange = () => {
      staged.distribution_mode = modeSel.value as 'single' | 'distribute';
      WorkCenters._markDirty();
      // Surgical refresh only, never _renderDetailOnly() — mode never
      // changes membership or the DOM structure around it, just whether
      // _wcBlockReason holds this edit. A full rebuild here would also
      // needlessly tear down and reconstruct the default-machine combobox
      // (_mkCombobox leaks a `document` click listener per construction,
      // ~2824 — fine once per real selection, not worth paying on every
      // mode toggle).
      WorkCenters._refreshNoticesOnly();
      WorkCenters._refreshSidebarRow(code);
      void WorkCenters._autosave();
    };

    const comboHost = pane.querySelector<HTMLElement>('#wc-default-machine-combo');
    if (comboHost) {
      _mkCombobox(comboHost, members, {
        value: staged.default_machine,
        placeholder: Util.t('ph.wc_default_machine'),
        onSelect: (v) => {
          staged.default_machine = v;
          WorkCenters._markDirty();
          // No render call here either, and for a second reason beyond the
          // leak above: this callback runs INSIDE _mkCombobox's own click
          // handling, and its clearBtn calls `input.focus()` right after
          // invoking onSelect (~2823) — rebuilding/destroying this container
          // mid-callback would make that focus() call silently target a
          // detached node.
          WorkCenters._refreshNoticesOnly();
          WorkCenters._refreshSidebarRow(code);
          void WorkCenters._autosave();
        },
      });
    }

    const sepSel = pane.querySelector<HTMLSelectElement>('#wc-max-sep');
    if (sepSel) sepSel.onchange = () => {
      staged.max_separation = sepSel.value as WorkCenterStaged['max_separation'];
      WorkCenters._markDirty();
      WorkCenters._refreshNoticesOnly();
      void WorkCenters._autosave();
    };

    const reviewChk = pane.querySelector<HTMLInputElement>('#wc-review-required');
    if (reviewChk) reviewChk.onchange = () => {
      staged.review_required = reviewChk.checked;
      WorkCenters._markDirty();
      WorkCenters._refreshNoticesOnly();
      void WorkCenters._autosave();
    };

    const toolChk = pane.querySelector<HTMLInputElement>('#wc-distribute-tooled');
    if (toolChk) toolChk.onchange = () => {
      staged.distribute_tooled = toolChk.checked;
      WorkCenters._markDirty();
      WorkCenters._refreshNoticesOnly();
      void WorkCenters._autosave();
    };

    pane.querySelectorAll<HTMLButtonElement>('.wc-info-btn').forEach((btn) => {
      btn.onclick = () => {
        const info = WC_INFO_HELP[btn.dataset.info || ''];
        if (!info) return;
        Plant._showFieldInfoPopover(btn, Util.escapeHtml(Util.t(info.title)), info.help.map((k) => Util.escapeHtml(Util.t(k))));
      };
    });

    pane.querySelectorAll<HTMLInputElement>('.wc-weight-input').forEach((inp) => {
      const machine = inp.dataset.machine || '';
      inp.oninput = () => {
        const raw = inp.value.trim();
        if (raw === '') staged.weights[machine] = null;
        else {
          const n = Number(raw);
          if (Number.isFinite(n)) staged.weights[machine] = n;
        }
        WorkCenters._markDirty();
        WorkCenters._refreshMembershipMath(members);
        WorkCenters._debouncedAutosave();
      };
      inp.onchange = () => {
        // Final validation on blur/Enter — a negative or non-numeric value
        // is rejected and reverted; `oninput` above deliberately tolerates
        // an in-progress partial value (e.g. "-" while typing "-1") without
        // rejecting on every keystroke.
        const raw = inp.value.trim();
        if (raw !== '') {
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) {
            Toast.show(Util.t('toast.wc_invalid_weight'), 'error');
            const prev = staged.weights[machine];
            inp.value = prev == null ? '' : String(prev);
            WorkCenters._refreshMembershipMath(members);
          }
        }
        // Blur also flushes any still-debounced write for the same reason
        // as #wc-desc above.
        WorkCenters._flushPending();
      };
    });

    const evenBtn = pane.querySelector<HTMLButtonElement>('#wc-even-btn');
    if (evenBtn) evenBtn.onclick = () => {
      for (const m of members) staged.weights[m] = null;
      WorkCenters._markDirty();
      pane.querySelectorAll<HTMLInputElement>('.wc-weight-input').forEach((inp) => { inp.value = ''; });
      WorkCenters._refreshMembershipMath(members);
      void WorkCenters._autosave();
    };
  },

  _markDirty(): void {
    WorkCenters._dirty = true;
    WorkCenters._editSeq++;
  },

  // Forces any debounced-but-unsent edit to fire NOW, using whatever is
  // currently selected/staged. Called before _selectRow/render's plant-switch
  // branch overwrite _staged for a different row/plant, and on blur of the
  // debounced Description/weight inputs, so "type, then immediately switch
  // rows/plants" never silently drops the last edit. Util.debounce has no
  // cancel/flush handle, so this can't actually cancel the pending timer —
  // it just wins the race by acting first; _autosave()'s own
  // `if (!WorkCenters._dirty) return;` guard makes that stale timer's
  // eventual, later call a no-op.
  _flushPending(): void {
    if (WorkCenters._saving && WorkCenters._dirty) {
      // A write is already in flight and the caller is about to replace
      // _staged (row or plant switch). Left alone, the trailing retry in
      // _autosave's finally would find _dirty already cleared by the
      // caller (_selectRow/render both do) and silently drop this edit.
      // Capture it as a concrete payload against the CURRENT (about to
      // become old) plant/code instead, so that retry has something to send.
      const q = WorkCenters._buildWrite();
      if (q) { WorkCenters._queued = q; WorkCenters._dirty = false; }
      return;
    }
    void WorkCenters._autosave();
  },

  // Recovers the one dead end _wcBlockReason creates: a distribute-mode work
  // center with 0 members can never pass the gate from THIS pane (membership
  // is only edited on the Machines tab, per WorkCenterStaged's own doc
  // comment). Called after every render() so leaving to add a machine there
  // and coming back lets a held edit land on its own instead of needing the
  // admin to re-touch every field.
  _maybeFlush(): void {
    const staged = WorkCenters._staged;
    const baseline = WorkCenters._baseline;
    const code = WorkCenters._selected;
    if (!staged || !baseline || !code || WorkCenters._saving) return;
    const members = _wcMembers(WorkCenters._machines, code).map((m) => m.machine);
    if (WorkCenters._wcBlockReason(staged, members)) return;
    if (_wcStagedEqual(staged, baseline)) return;
    WorkCenters._dirty = true;
    void WorkCenters._autosave();
  },

  // Client-side pre-flight for the three PUT /distribution/{plant}/workcenters/{wc}
  // rules we can evaluate locally (backend/distribution/data.py:161-172).
  // Autosave fires only when this returns null; otherwise the edit is held
  // and the pane explains what is missing, so we never send a request the
  // route will reject. This is strictly an improvement over the old Save
  // button's own pre-checks, which never covered distribute_mode_thin at
  // all — ticking a checkbox on a 1-member distribute work center used to
  // sail straight through Save and surface a raw 400 as a generic toast.
  // Pure and DOM-free by design (also exercised directly by tests).
  _wcBlockReason(staged: WorkCenterStaged, members: string[]): WcBlockReason {
    if (staged.distribution_mode === 'single' && !staged.default_machine) return 'single_mode_without_default';
    if (staged.default_machine && !members.includes(staged.default_machine)) return 'default_machine_not_member';
    if (staged.distribution_mode === 'distribute' && members.length < 2) return 'distribute_mode_thin';
    return null;
  },

  // Resolves the CURRENT plant/selection/staged into a self-contained write
  // request, or null when there's nothing to send — no plant/code/staged,
  // or _wcBlockReason holds it. Pulled out of _autosave so _flushPending can
  // also capture one on demand (see there) without duplicating the gate
  // check or the payload shape.
  _buildWrite(): WorkCenterWriteRequest | null {
    const plant = Store.selectedPlant;
    const code = WorkCenters._selected;
    const staged = WorkCenters._staged;
    if (!plant || !code || !staged) return null;

    const members = _wcMembers(WorkCenters._machines, code).map((m) => m.machine);
    if (WorkCenters._wcBlockReason(staged, members)) return null;

    // Full current-membership weight set, not just the changed cells — the
    // Even button clears every member to NULL, which only takes effect if
    // every member's key rides along in this payload (backend/distribution/
    // data.py's save_workcenter only UPDATEs the machines present in
    // `weights`, so an omitted member's old weight would otherwise survive).
    const weights: Record<string, number | null> = {};
    for (const m of members) weights[m] = staged.weights[m] ?? null;
    const payload: WorkCenterWritePayload = {
      description:       staged.description || null,
      distribution_mode: staged.distribution_mode,
      default_machine:   staged.default_machine || null,
      max_separation:    staged.max_separation,
      review_required:   staged.review_required,
      distribute_tooled: staged.distribute_tooled,
      weights,
    };
    return { plant, code, payload, members };
  },

  // Entry point every control handler calls after mutating _staged (either
  // directly, for an immediate-fire control, or via _debouncedAutosave).
  // Coalesces concurrent triggers through _saving + the persistent _dirty
  // flag (set by _markDirty, cleared here right before dispatch) instead of
  // a separate "pending" flag — _dirty already means exactly "there's an
  // edit that hasn't been handed to _write yet", which is also exactly what
  // the trailing-retry check in the `finally` below needs.
  async _autosave(): Promise<void> {
    if (WorkCenters._saving) return; // in-flight write's own finally() retries once it settles, since _dirty stays true
    if (!WorkCenters._dirty) return;

    const build = WorkCenters._buildWrite();
    if (!build) {
      // Either no plant/code/staged (nothing to do), or _wcBlockReason held
      // it — in the latter case _dirty stays true so _maybeFlush() retries
      // once the gate clears. _refreshNoticesOnly is a no-op if there's no
      // selection to show a notice for.
      WorkCenters._refreshNoticesOnly();
      return;
    }

    WorkCenters._dirty = false;
    WorkCenters._saving = true;
    const seq = WorkCenters._editSeq;

    try {
      await WorkCenters._write(build.plant, build.code, build.payload, build.members, seq);
    } finally {
      WorkCenters._saving = false;
      const q = WorkCenters._queued;
      if (q) {
        WorkCenters._queued = null;
        // Selection has already moved on by the time a queued write drains
        // (that's exactly why _flushPending queued it instead of just
        // firing), so pass the CURRENT _editSeq here, not an older captured
        // one — _write's `_selected === code` guard is already false for
        // this request either way, so it never re-bases or rolls back
        // `_staged`/`_baseline`; it only persists q's old-row payload and
        // patches `_rows`/`_machines`, which are code-keyed and safe
        // regardless of what's currently selected. Don't "fix" this by
        // capturing an older seq — there's nothing left for it to guard
        // once the row has changed.
        void WorkCenters._write(q.plant, q.code, q.payload, q.members, WorkCenters._editSeq);
      } else if (WorkCenters._dirty) {
        void WorkCenters._autosave();
      }
    }
  },

  // The actual PUT — plant/code/payload/members/seq are all captured by the
  // caller at fire time and never re-read from live selection state in
  // here, because a slow response can land after the user has switched rows
  // or plants (autosave races the user in a way the old single Save button
  // never had to).
  async _write(plant: string, code: string, payload: WorkCenterWritePayload, members: string[], seq: number): Promise<void> {
    // Defensive — autosave is reachable from many more paths now (debounced
    // typing, checkbox/select onchange, _maybeFlush after a re-render) than
    // the single explicit Save button it replaces.
    if (!Session.isAdmin()) return;
    try {
      const res = await Util.fetchTraced(
        `${Config.API_BASE}/distribution/${encodeURIComponent(plant)}/workcenters/${encodeURIComponent(code)}`,
        {
          method:  'PUT',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify(payload),
        },
      ).then(async (r) => {
        if (!r.ok) {
          const e = await r.json().catch(() => ({}) as Record<string, unknown>);
          const detail = (e as { detail?: unknown }).detail;
          const msg = (detail && typeof detail === 'object' && 'message' in detail)
            ? String((detail as { message: unknown }).message)
            : (typeof detail === 'string' ? detail : `HTTP ${r.status}`);
          throw new Error(msg);
        }
        return r.json() as Promise<WorkCenterSaveResult>;
      });

      // Code-keyed and safe unconditionally, even if the selection or plant
      // moved on while this request was in flight.
      const idx = WorkCenters._rows.findIndex((r) => r.sap_workcenter === code);
      if (idx >= 0) {
        WorkCenters._rows[idx] = {
          ...WorkCenters._rows[idx],
          description:       res.description ?? null,
          distribution_mode: res.distribution_mode,
          default_machine:   res.default_machine ?? null,
          max_separation:    res.max_separation,
          review_required:   res.review_required,
          distribute_tooled: res.distribute_tooled,
        };
      }
      for (const m of members) {
        const mach = WorkCenters._machines.find((x) => x.machine === m);
        if (mach) mach.distribution_weight = res.weights[m] ?? null;
      }
      WorkCenters._refreshSidebarRow(code);

      // A slow response landing after a plant/row switch must not touch the
      // live edit buffer for whatever is now selected instead.
      if (WorkCenters._selected !== code || WorkCenters._loadedPlant !== plant) return;

      const savedStaged: WorkCenterStaged = {
        description:       payload.description ?? '',
        distribution_mode: payload.distribution_mode,
        default_machine:   payload.default_machine ?? '',
        max_separation:    payload.max_separation,
        review_required:   payload.review_required,
        distribute_tooled: payload.distribute_tooled,
        weights:           { ...payload.weights },
      };
      WorkCenters._baseline = { ...savedStaged, weights: { ...payload.weights } };
      // Only overwrite the live `_staged` buffer if nothing has edited it
      // since this request was fired — otherwise this response would stomp
      // a newer, still-unsent edit with the snapshot it was built from.
      if (WorkCenters._editSeq === seq) WorkCenters._staged = { ...savedStaged, weights: { ...payload.weights } };

      // Success must NOT trigger _renderDetailOnly()/_renderPane() — a full
      // rebuild here could steal focus/cursor from a Description or weight
      // input the user may already be mid-typing into for the NEXT edit
      // (autosave races typing, unlike the old explicit-Save button). Only
      // the notices paragraph needs to reflect the save.
      WorkCenters._refreshNoticesOnly();
    } catch (e) {
      Toast.show(Util.t('toast.wc_save_failed', { msg: (e as Error).message }), 'error');
      ErrorLog.error('work-centers', `Save failed for ${code}: ${(e as Error).message}`);
      // Roll the edit back to the last known-good save — but only if the
      // user is still on this exact work center AND hasn't edited it again
      // since this request was fired; otherwise leave the newer state
      // alone (the trailing retry in _autosave's finally, or the next
      // debounce tick, will attempt it and roll itself back if it also
      // fails). A failed write is the one case allowed to disturb the
      // detail panel, since the alternative is silently pretending it saved.
      if (WorkCenters._selected === code && WorkCenters._loadedPlant === plant && WorkCenters._editSeq === seq && WorkCenters._baseline) {
        WorkCenters._staged = { ...WorkCenters._baseline, weights: { ...WorkCenters._baseline.weights } };
        WorkCenters._renderDetailOnly();
      }
    }
  },
};
