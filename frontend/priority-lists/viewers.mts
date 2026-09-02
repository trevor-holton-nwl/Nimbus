// priority-lists/viewers.mjs — ColorWheelViewer (modal preview of a plant's
// uploaded color wheel) and PriorityListViewer (generic modal preview of a
// plant's uploaded priority list for prt01/prt02/productionVersion, delegating
// to ColorWheelViewer for the colorWheel field). Extracted verbatim from
// schedule-workbench.mts (Phase P3 of docs/architecture/domain-refactor-plan.md,
// which split that 10,391-line mega-module into 6 domain files).
//
// `ColorWheelEntry`/`ColorWheelResponse` below were declared in the original
// file's "OptimizeDialog/OptimizerPreview local types" header block (Task 7),
// not near ColorWheelViewer itself — but that block's own doc comment said
// they are "Read only by ColorWheelViewer's `_load()` now", and grepping the
// whole original file confirmed neither OptimizeDialog nor OptimizerPreview
// ever referenced them. Relocated here, where they are actually used, rather
// than left duplicated across a spurious edge into optimization/optimize-ui.mjs.
import { Config, Util } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import type { PriorityListEntry, PriorityListResponse } from '../platform/types.mjs';

/** One entry / the overall shape of the `GET /color-wheel/{plant}` response
 *  body. Read only by ColorWheelViewer's `_load()`. `meta` is the
 *  upload-metadata half of the same body. */
interface ColorWheelEntry {
  color: string;
  order_y?: number;
}
interface ColorWheelResponse {
  entries?: ColorWheelEntry[];
  meta?: { filename?: string; row_count?: number };
}

/* =============================================================================
   COLOR WHEEL VIEWER — modal preview of a plant's uploaded color wheel.
   Supports search, sort, expandable rows with task counts per color.
   ========================================================================== */
export const ColorWheelViewer = (() => {
  let _plant: string | null = null;
  let _entries: ColorWheelEntry[] = [];
  let _search  = '';
  let _sort: 'priority' | 'name' = 'priority';

  // Map common color name fragments → hex for the swatch tiles
  const COLOR_MAP: Record<string, string> = {
    RED:'#e74c3c', BLUE:'#3498db', GREEN:'#2ecc71', YELLOW:'#f1c40f',
    ORANGE:'#e67e22', PURPLE:'#9b59b6', PINK:'#e91e8c', WHITE:'#f0ede8',
    BLACK:'#2c3e50', BROWN:'#7a5a2a', GREY:'#95a5a6', GRAY:'#95a5a6',
    SILVER:'#bdc3c7', GOLD:'#b8791a', AMBER:'#b8791a', NAVY:'#1f2d6d',
    TEAL:'#1abc9c', AQUA:'#00bcd4', MAROON:'#8b1a1a', OLIVE:'#6b7a2a',
    BEIGE:'#e8dcc8', TAN:'#d4a96a', CORAL:'#ff6b6b', LIME:'#a8e063',
    SAGE:'#87a96b', SLATE:'#708090', IVORY:'#fffff0', CREAM:'#fffdd0',
  };

  function _resolveColor(name: string): string | null {
    const u = String(name).toUpperCase().trim();
    if (COLOR_MAP[u]) return COLOR_MAP[u];
    for (const [k, v] of Object.entries(COLOR_MAP)) {
      if (u.includes(k)) return v;
    }
    return null;
  }

  function open(plant: string) {
    _plant  = plant;
    _search = '';
    _sort   = 'priority';
    const el = document.getElementById('modal-cw-viewer');
    if (!el) return;
    el.hidden = false;
    // Reset search UI
    const srch = document.getElementById('cw-viewer-search') as HTMLInputElement | null;
    if (srch) srch.value = '';
    const sortBtns = document.querySelectorAll<HTMLElement>('.cw-sort-btn');
    sortBtns.forEach((b) => b.classList.toggle('active', b.dataset.sort === 'priority'));
    requestAnimationFrame(() => el.querySelector('.cw-viewer-modal')?.classList.add('visible'));
    _load();
  }

  function close() {
    const el = document.getElementById('modal-cw-viewer');
    if (!el) return;
    el.querySelector('.cw-viewer-modal')?.classList.remove('visible');
    setTimeout(() => { el.hidden = true; }, 240);
  }

  function _load() {
    const titleEl   = document.getElementById('cw-viewer-plant-name');
    const countEl   = document.getElementById('cw-viewer-count');
    const listEl    = document.getElementById('cw-viewer-list');
    if (titleEl) titleEl.textContent = _plant || '—';
    if (countEl) countEl.textContent = '';
    if (listEl)  listEl.innerHTML    = `<div class="cw-loading"><span class="cw-spin"></span>${Util.t('ui.loading_wheel')}</div>`;

    fetch(`${Config.API_BASE}/color-wheel/${encodeURIComponent(_plant!)}`, { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() as Promise<ColorWheelResponse> : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(body => {
        _entries = body.entries || [];
        // Populate file meta below title
        const metaEl = document.getElementById('cw-viewer-meta');
        const m = body.meta || {};
        if (metaEl) metaEl.textContent = m.filename
          ? `${m.filename} · ${m.row_count ?? _entries.length} colors`
          : `${_entries.length} colors`;
        _render();
      })
      .catch((err: Error) => {
        _entries = [];
        if (listEl) listEl.innerHTML = `<div class="cw-viewer-empty">${Util.t('empty.cw_no_wheel_for_plant', { plant: Util.escapeHtml(_plant) })}</div>`;
        const metaEl = document.getElementById('cw-viewer-meta');
        if (metaEl) metaEl.textContent = err.message.includes('404') ? Util.t('empty.cw_no_file') : err.message;
      });
  }

  function _render() {
    const listEl  = document.getElementById('cw-viewer-list');
    const countEl = document.getElementById('cw-viewer-count');
    if (!listEl) return;

    // Task counts per color for this plant
    const taskCounts: Record<string, number> = {};
    for (const t of Store.tasksArr) {
      if (_plant && Store.getPlantForLine(t.MACHINE) !== _plant) continue;
      const c = Util.norm(t.COLOR);
      if (c && c !== 'NAN') taskCounts[c] = (taskCounts[c] || 0) + 1;
    }

    let data = _entries.slice();
    if (_search) {
      const s = _search.toLowerCase();
      data = data.filter(e => String(e.color || '').toLowerCase().includes(s));
    }
    if (_sort === 'name') {
      data.sort((a, b) => String(a.color || '').localeCompare(String(b.color || '')));
    } else {
      data.sort((a, b) => (a.order_y ?? 999999) - (b.order_y ?? 999999));
    }

    if (countEl) countEl.textContent = `${data.length} color${data.length !== 1 ? 's' : ''}`;

    if (!data.length) {
      listEl.innerHTML = `<div class="cw-viewer-empty">${_search ? Util.t('empty.cw_no_search_match') : Util.t('empty.cw_no_entries')}</div>`;
      return;
    }

    listEl.innerHTML = data.map((e, i) => {
      const hex    = _resolveColor(e.color || '');
      const letter = (String(e.color || '?')[0]).toUpperCase();
      const tc     = taskCounts[Util.norm(e.color || '')] || 0;
      const pri    = e.order_y != null && e.order_y < 999999 ? e.order_y : '—';
      return `<div class="cw-viewer-row">
        <div class="cw-swatch" style="${hex ? `background:${hex}` : 'background:var(--bg-strong)'}" title="${Util.escapeHtml(e.color)}">
          ${!hex ? `<span class="cw-swatch-letter">${Util.escapeHtml(letter)}</span>` : ''}
        </div>
        <div class="cw-row-body">
          <div class="cw-row-name">${Util.escapeHtml(e.color)}</div>
          <div class="cw-row-sub">
            ${Util.t('ui.priority_label')} <strong>${pri}</strong>
            ${tc ? `<span class="cw-row-dot">·</span><span class="cw-row-tasks">${Util.t('ui.active_orders', { count: tc, plural: tc !== 1 ? 's' : '' })}</span>` : ''}
          </div>
        </div>
        <div class="cw-row-rank">#${i + 1}</div>
        <button class="cw-row-expand" onclick="NIMBUS.ColorWheelViewer._toggleExpand(this)">▾</button>
        <div class="cw-row-detail">
          ${tc
            ? `<span class="cw-detail-stat ok">${Util.t('ui.active_orders', { count: tc, plural: tc !== 1 ? 's' : '' })} ${Util.t('ui.on_plant_label')} <strong>${Util.escapeHtml(_plant)}</strong></span>`
            : `<span class="cw-detail-stat mute">${Util.t('ui.no_active_for_color')}</span>`}
        </div>
      </div>`;
    }).join('');
  }

  function _toggleExpand(btn: HTMLElement) {
    const row    = btn.closest('.cw-viewer-row');
    const detail = row?.querySelector('.cw-row-detail');
    if (!detail) return;
    const open = detail.classList.toggle('open');
    btn.textContent = open ? '▴' : '▾';
  }

  function search(val: string) {
    _search = String(val || '').toLowerCase();
    _render();
  }

  function sort(mode: 'priority' | 'name') {
    _sort = mode;
    document.querySelectorAll<HTMLElement>('.cw-sort-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.sort === mode)
    );
    _render();
  }

  return { open, close, search, sort, _toggleExpand };
})();

/* =============================================================================
   PRIORITY LIST VIEWER — generic modal preview of a plant's uploaded
   priority list for a rankable field (prt01/prt02/productionVersion).
   Delegates to ColorWheelViewer for the colorWheel field, which keeps its
   own richer swatch/task-count rendering.
   ========================================================================== */
export const PriorityListViewer = (() => {
  let _plant: string | null = null;
  let _fieldKey: string | null = null;
  let _line = '';
  let _entries: PriorityListEntry[] = [];
  let _search = '';

  // `line` (optional, defaults to '' = plant-wide) — a field card's per-line
  // override rows carry a line, and previewing one without threading it
  // through would always 404-fall-back to the plant-wide list (or "no list"
  // if there isn't one), even though the override upload itself succeeded.
  // The colorWheel delegate to ColorWheelViewer's own richer swatch renderer
  // only applies to the plant-wide case (no line) — ColorWheelViewer.open
  // takes no line param and the legacy /color-wheel/{plant} route it calls
  // only ever reads line=""; a colorWheel line override falls through to
  // this module's own generic value/rank renderer instead, the same path
  // every other field's line override already uses, so the preview actually
  // reflects the override's data instead of silently showing the plant-wide
  // wheel.
  function open(plant: string, fieldKey: string, line: string = '') {
    if (fieldKey === 'colorWheel' && !line) { ColorWheelViewer.open(plant); return; }
    _plant = plant; _fieldKey = fieldKey; _line = line; _search = '';
    const el = document.getElementById('modal-priority-viewer');
    if (!el) return;
    el.hidden = false;
    const srch = document.getElementById('pl-viewer-search') as HTMLInputElement | null;
    if (srch) srch.value = '';
    requestAnimationFrame(() => el.querySelector('.cw-viewer-modal')?.classList.add('visible'));
    _load();
  }

  function close() {
    const el = document.getElementById('modal-priority-viewer');
    if (!el) return;
    el.querySelector('.cw-viewer-modal')?.classList.remove('visible');
    setTimeout(() => { el.hidden = true; }, 240);
  }

  function _load() {
    const labelEl = document.getElementById('pl-viewer-field-label');
    const nameEl  = document.getElementById('pl-viewer-plant-name');
    const listEl  = document.getElementById('pl-viewer-list');
    if (labelEl) labelEl.textContent = _fieldKey ? Util.t(`constraint.${_fieldKey}`) : '—'; // resolved label, not the raw camelCase key — same rule as Plant's toasts/modals
    if (nameEl)  nameEl.textContent  = _plant || '—';
    if (listEl)  listEl.innerHTML    = `<div class="cw-loading"><span class="cw-spin"></span>${Util.t('ui.loading')}</div>`;

    // Util.fetchTraced (not bare fetch) — GET /priority-list/{plant}/{field_key}
    // isn't admin-gated, but it does call _assert_plant_allowed server-side
    // (brain.py:1943) to scope by the caller's role_plants. fetchTraced
    // automatically attaches an x-user-email identity header via
    // Util.setActorResolver (see frontend/platform/foundation.mts). Any
    // residual access-control concern here is about server-side plant-scoping
    // enforcement, not header presence.
    const qs = _line ? `?machine=${encodeURIComponent(_line)}` : '';
    Util.fetchTraced(`${Config.API_BASE}/priority-list/${encodeURIComponent(_plant!)}/${encodeURIComponent(_fieldKey!)}${qs}`,
          { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() as Promise<PriorityListResponse> : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(body => {
        _entries = body.entries || [];
        const metaEl = document.getElementById('pl-viewer-meta');
        const m = body.meta || {};
        // meta.row_count is priority_list.row_count, which brain.
        // _persist_priority_list now stores as len(entries) — the value/rank
        // pairs actually STORED — so it agrees with the list rendered below it
        // and with the field card's "N values". It used to be the uploaded
        // file's raw row count, so a 500-row file with 40 distinct values read
        // "500 values" above a 40-row list.
        if (metaEl) metaEl.textContent = m.filename
          ? `${m.filename} · ${m.row_count ?? _entries.length} values`
          : `${_entries.length} values`;
        _render();
      })
      .catch((err: Error) => {
        _entries = [];
        if (listEl) listEl.innerHTML = `<div class="cw-viewer-empty">${Util.t('empty.pl_no_list_for_plant')}</div>`;
        const metaEl = document.getElementById('pl-viewer-meta');
        if (metaEl) metaEl.textContent = err.message.includes('404') ? Util.t('empty.pl_no_file') : err.message;
      });
  }

  function _render() {
    const listEl = document.getElementById('pl-viewer-list');
    const countEl = document.getElementById('pl-viewer-count');
    if (!listEl) return;
    const q = _search.toLowerCase();
    const data = _entries.filter(e => !q || e.value.toLowerCase().includes(q));
    if (countEl) countEl.textContent = `${data.length} / ${_entries.length}`;
    if (!data.length) {
      listEl.innerHTML = `<div class="cw-viewer-empty">${Util.t('empty.pl_no_matches')}</div>`;
      return;
    }
    listEl.innerHTML = data.map(e => {
      const pri = e.rank < 999999 ? e.rank : '—';
      return `
        <div class="cw-viewer-row">
          <div class="cw-viewer-rank">${Util.escapeHtml(pri)}</div>
          <div class="cw-viewer-name">${Util.escapeHtml(e.value)}</div>
        </div>`;
    }).join('');
  }

  function search(val: string) { _search = String(val || ''); _render(); }

  return { open, close, search };
})();
