// scheduling/unsaved-dialog.mjs - UnsavedDialog: the "unsaved changes" dialog (#unsaved-modal) the header badge
// (#schedule-unsaved) opens. One table row per unsaved order (Order / Material, Machine, Change chip, Before, After,
// delta); a row click expands it inline (one at a time) to every changed field, the material, the source of the last
// edit, the engine's move note and a "Show on Gantt" button.
//
// The rows are computed lazily on open from `unsaved-diff.mts` (O(dirty) parses, no new retained state) and rendered
// capped at MAX_ROWS. The mount `#unsaved-modal` is a static `.modal-backdrop` in index.html; the dialog body is built
// here with createElement/textContent (never innerHTML) every time it opens. Modal.open/close give the focus trap and
// the focus-return to the badge; Escape and a backdrop click are wired here (Modal handles them only for confirm).
import { Util, Modal } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import { Sandbox } from '../optimization/sandbox.mjs';
import { Persistence } from './persistence.mjs';
import { Selection } from './selection.mjs';
import { Timeline } from './gantt.mjs';
import { unsavedChanges, sortUnsaved, filterUnsaved, formatDeltaMs } from './unsaved-diff.mjs';
import type { UnsavedChange, UnsavedField, UnsavedFieldKey } from './unsaved-diff.mjs';

const MODAL_ID = 'unsaved-modal';
export const MAX_ROWS = 500;

type SortKey = 'move' | 'order' | 'machine';
type RowView = { tr: HTMLElement; detail: HTMLElement; btn: HTMLElement; row: UnsavedChange };

const t = (key: string, params?: Record<string, string | number>): string => Util.t(key, params);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The field whose before/after the table's Before and After columns show, per change kind. */
const KEY_FIELDS: Record<string, UnsavedFieldKey[]> = {
  moved: ['finish', 'start', 'segments'], needs: ['finish', 'start'], machine: ['machine'], runtime: ['runtime'],
  tooling: ['prt1', 'prt2', 'pv'], firm: ['firm'], noref: ['finish', 'machine'],
};

export function fieldLabel(key: UnsavedFieldKey): string { return t(`unsaved.f_${key}`); }

export function formatValue(f: Pick<UnsavedField, 'kind'>, v: unknown): string {
  if (v === null || v === undefined || v === '') return t('unsaved.val_none');
  switch (f.kind) {
    case 'date': return Util.fmtDTPref(v) || t('unsaved.val_none');
    case 'hours': return t('unsaved.val_hours', { count: Math.round(Number(v) * 100) / 100 });
    case 'bool': return v ? t('unsaved.val_yes') : t('unsaved.val_no');
    case 'count': return t('unsaved.val_segments', { count: v as number });
    default: return String(v);
  }
}

function keyField(row: UnsavedChange): UnsavedField | null {
  for (const k of KEY_FIELDS[row.status] ?? []) {
    const f = row.fields.find(x => x.key === k);
    if (f) return f;
  }
  return null;
}

function deltaOf(row: UnsavedChange): { text: string; cls: string; sub?: string } {
  switch (row.status) {
    case 'needs': return { text: t('unsaved.delta_unsched'), cls: 'pos' };
    case 'machine': return { text: t('unsaved.delta_machine'), cls: 'kind', ...(row.deltaMs ? { sub: formatDeltaMs(row.deltaMs) } : {}) };
    case 'firm': return { text: t('unsaved.delta_firm'), cls: 'kind' };
    case 'tooling': return { text: row.fields.some(f => f.key === 'prt1' || f.key === 'prt2') ? t('unsaved.delta_prt') : t('unsaved.delta_pv'), cls: 'kind' };
    case 'moved': case 'runtime':
      return row.deltaMs ? { text: formatDeltaMs(row.deltaMs), cls: row.deltaMs > 0 ? 'pos' : 'neg' } : { text: '—', cls: 'mute' };
    default: return { text: '—', cls: 'mute' };
  }
}

function moveNoteText(row: UnsavedChange): string {
  const n = row.moveNote;
  if (!n) return '';
  return t('ui.insp_system_move', { from: Util.fmtDTReadable(n.from), to: Util.fmtDTReadable(n.to), reason: t(`ui.insp_move_reason_${n.reason}`) });
}

function sourceText(row: UnsavedChange): string {
  const key = `unsaved.src_${row.source ?? 'planner'}`;
  const s = t(key);
  return s === key ? String(row.source) : s;
}

export const UnsavedDialog = {
  _rows: [] as UnsavedChange[],
  _skipped: 0,
  _query: '',
  _sort: 'move' as SortKey,
  _openId: null as string | null,
  _views: new Map<string, RowView>(),
  _escape: null as ((e: KeyboardEvent) => void) | null,
  _els: {} as Record<string, HTMLElement>,

  /** The unsaved orders right now (the badge's own source of truth is `Persistence._dirtyIds`). */
  compute(): { rows: UnsavedChange[]; skipped: string[] } {
    return unsavedChanges(Persistence._dirtyIds, Persistence._savedBaseline, Store.tasks as unknown as Record<string, unknown>, {
      snapshot: task => Persistence._taskEditSnapshot(task as never),
      parseDate: v => Util.parseDate(v as never),
      firmDirtyIds: Persistence._firmDirtyIds,
      dirtySource: Persistence._dirtySource,
      isFirmed: id => Store.isFirmed(id),
    });
  },

  open(): void {
    const { rows, skipped } = UnsavedDialog.compute();
    UnsavedDialog._rows = rows;
    UnsavedDialog._skipped = skipped.length;
    UnsavedDialog._query = '';
    UnsavedDialog._sort = 'move';
    UnsavedDialog._openId = null;
    UnsavedDialog._build();
    UnsavedDialog._renderBody();
    Modal.open(MODAL_ID);
    if (!UnsavedDialog._escape) {
      UnsavedDialog._escape = (e: KeyboardEvent) => {
        const m = document.getElementById(MODAL_ID);
        if (e.key === 'Escape' && m && !m.hidden) { e.preventDefault?.(); UnsavedDialog.close(); }
      };
      document.addEventListener('keydown', UnsavedDialog._escape);
    }
  },

  close(): void {
    if (UnsavedDialog._escape) { document.removeEventListener('keydown', UnsavedDialog._escape); UnsavedDialog._escape = null; }
    Modal.close(MODAL_ID);
  },

  _mount(): HTMLElement {
    let m = document.getElementById(MODAL_ID);
    if (!m) {
      m = el('div', 'modal-backdrop');
      m.id = MODAL_ID;
      m.hidden = true;
      document.body.appendChild(m);
    }
    return m;
  },

  _build(): void {
    const mount = UnsavedDialog._mount();
    const E = UnsavedDialog._els = {} as Record<string, HTMLElement>;
    const dlg = el('div', 'modal unsaved-dlg');
    const head = el('header', 'modal-head');
    const title = el('h3'); title.id = 'unsaved-title'; E.title = title;
    const x = el('button', 'icon-btn sm', '✕'); x.setAttribute('type', 'button'); x.setAttribute('aria-label', t('btn.close'));
    x.addEventListener('click', () => UnsavedDialog.close());
    head.append(title, x);

    const body = el('div', 'modal-body unsaved-body');
    const ctrl = el('div', 'unsaved-ctrl');
    const q = el('input'); q.id = 'unsaved-q'; q.setAttribute('type', 'search'); q.setAttribute('autocomplete', 'off');
    q.setAttribute('placeholder', t('unsaved.filter')); q.setAttribute('aria-label', t('unsaved.filter'));
    q.addEventListener('input', () => { UnsavedDialog._query = q.value; UnsavedDialog._renderBody(); });
    const sort = el('select'); sort.id = 'unsaved-sort'; sort.setAttribute('aria-label', t('unsaved.sort_label'));
    for (const [v, key] of [['move', 'unsaved.sort_move'], ['order', 'unsaved.sort_order'], ['machine', 'unsaved.sort_machine']] as const) {
      const o = el('option', undefined, t(key)); o.setAttribute('value', v); (o as HTMLOptionElement).value = v; sort.appendChild(o);
    }
    (sort as HTMLSelectElement).value = 'move';
    sort.addEventListener('change', () => { UnsavedDialog._sort = (sort as HTMLSelectElement).value as SortKey; UnsavedDialog._renderBody(); });
    ctrl.append(q, sort);

    const banner = el('div', 'unsaved-banner', t('unsaved.whatif')); banner.setAttribute('role', 'note'); banner.hidden = !Sandbox.active; E.banner = banner;
    const skip = el('div', 'unsaved-skipped', UnsavedDialog._skipped ? t('unsaved.skipped_note', { count: UnsavedDialog._skipped }) : ''); skip.hidden = !UnsavedDialog._skipped;

    const wrap = el('div', 'unsaved-tablewrap');
    const table = el('table', 'unsaved-table');
    const thead = el('thead'); const hr = el('tr');
    for (const key of ['col_order', 'col_machine', 'col_change', 'col_before', 'col_after', 'col_delta']) hr.appendChild(el('th', undefined, t(`unsaved.${key}`)));
    const thx = el('th'); const sr = el('span', 'ti-sr-only',t('unsaved.details_for', { id: '' }).trim()); thx.appendChild(sr); hr.appendChild(thx);
    thead.appendChild(hr);
    const tbody = el('tbody'); E.tbody = tbody;
    table.append(thead, tbody);
    const empty = el('div', 'unsaved-empty'); empty.hidden = true; E.empty = empty;
    wrap.append(table, empty);
    body.append(ctrl, banner, skip, wrap);

    const foot = el('footer', 'modal-foot');
    const note = el('span', 'unsaved-foot-note', t('unsaved.foot_note'));
    const cap = el('span', 'unsaved-cap'); E.cap = cap;
    const close = el('button', 'btn btn-ghost', t('btn.close')); close.setAttribute('type', 'button');
    close.addEventListener('click', () => UnsavedDialog.close());
    foot.append(note, cap, close);

    dlg.append(head, body, foot);
    mount.replaceChildren(dlg);
    // A press on the dimmed backdrop (not on the dialog) closes.
    if (!(mount as HTMLElement & { _unsavedWired?: boolean })._unsavedWired) {
      (mount as HTMLElement & { _unsavedWired?: boolean })._unsavedWired = true;
      mount.addEventListener('click', (e: MouseEvent) => { if (e.target === mount) UnsavedDialog.close(); });
    }
  },

  _renderBody(): void {
    const E = UnsavedDialog._els;
    const all = UnsavedDialog._rows;
    const filtered = sortUnsaved(filterUnsaved(all, UnsavedDialog._query), UnsavedDialog._sort);
    const shown = filtered.slice(0, MAX_ROWS);
    E.title.textContent = t('unsaved.title', { count: all.length });
    if (UnsavedDialog._openId && !shown.some(r => r.id === UnsavedDialog._openId)) UnsavedDialog._openId = null;
    UnsavedDialog._views = new Map();
    const frag: HTMLElement[] = [];
    for (const row of shown) frag.push(...UnsavedDialog._rowEls(row));
    E.tbody.replaceChildren(...frag);
    E.empty.hidden = shown.length > 0;
    E.empty.textContent = shown.length ? '' : t(all.length ? 'unsaved.empty_filter' : 'unsaved.empty');
    const more = filtered.length - shown.length;
    E.cap.textContent = filtered.length
      ? t('unsaved.cap', { shown: shown.length, total: filtered.length }) + (more > 0 ? ` · ${t('unsaved.cap_more', { more })}` : '')
      : '';
    if (UnsavedDialog._openId) UnsavedDialog._setOpen(UnsavedDialog._openId, true);
  },

  _rowEls(row: UnsavedChange): HTMLElement[] {
    const tr = el('tr', `unsaved-row${row.status === 'nochange' ? ' muted' : ''}`);
    tr.dataset.id = row.id;
    const ord = el('div', 'unsaved-ord');
    ord.appendChild(el('span', 'unsaved-id', row.id));
    const mat = el('span', 'unsaved-mat');
    mat.title = [row.material, row.materialDescription].filter(Boolean).join(' · ');
    mat.append(el('b', undefined, row.material), el('span', undefined, row.materialDescription));
    ord.appendChild(mat);
    const tdOrd = el('td'); tdOrd.appendChild(ord);
    const tdMachine = el('td', undefined, row.machine);
    const tdChip = el('td'); tdChip.appendChild(el('span', `unsaved-chip ${row.status}`, t(`unsaved.chip_${row.status}`)));
    const kf = keyField(row);
    const noBefore = !kf || kf.before === undefined;
    const tdBefore = el('td', `unsaved-val${noBefore ? ' mute' : ' old'}`, kf && !noBefore ? formatValue(kf, kf.before) : '—');
    const tdAfter = el('td', `unsaved-val${kf ? '' : ' mute'}`, kf ? formatValue(kf, kf.after) : '—');
    const d = deltaOf(row);
    const tdDelta = el('td'); const dl = el('span', `unsaved-delta ${d.cls}`, d.text);
    if (d.sub) dl.appendChild(el('small', undefined, d.sub));
    tdDelta.appendChild(dl);
    const tdBtn = el('td', 'unsaved-exp-cell');
    const btn = el('button', 'unsaved-exp'); btn.setAttribute('type', 'button');
    btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', `unsaved-d-${row.id}`);
    btn.setAttribute('aria-label', t('unsaved.details_for', { id: row.id }));
    tdBtn.appendChild(btn);
    tr.append(tdOrd, tdMachine, tdChip, tdBefore, tdAfter, tdDelta, tdBtn);
    tr.addEventListener('click', () => UnsavedDialog._toggle(row.id));

    const detail = el('tr', 'unsaved-detail'); detail.id = `unsaved-d-${row.id}`; detail.hidden = true;
    UnsavedDialog._views.set(row.id, { tr, detail, btn, row });
    return [tr, detail];
  },

  _toggle(id: string): void {
    UnsavedDialog._setOpen(id, UnsavedDialog._openId !== id);
  },

  /** Accordion: opening one closes the previous; the detail is built on first open. */
  _setOpen(id: string, open: boolean): void {
    const prev = UnsavedDialog._openId;
    if (open && prev && prev !== id) UnsavedDialog._paint(prev, false);
    UnsavedDialog._openId = open ? id : (prev === id ? null : prev);
    UnsavedDialog._paint(id, open);
  },

  _paint(id: string, open: boolean): void {
    const v = UnsavedDialog._views.get(id);
    if (!v) return;
    v.btn.setAttribute('aria-expanded', String(open));
    v.tr.classList.toggle('open', open);
    v.detail.hidden = !open;
    if (open && !v.detail.children.length) {
      const td = el('td'); td.setAttribute('colspan', '7');
      td.appendChild(UnsavedDialog._detail(v.row));
      v.detail.appendChild(td);
    }
  },

  _detail(row: UnsavedChange): HTMLElement {
    const wrap = el('div', 'unsaved-dwrap');
    if (row.status !== 'nochange') {
      const grid = el('div', `unsaved-dfields${row.hasBaseline ? '' : ' single'}`);
      grid.appendChild(el('span', 'unsaved-hd', t('unsaved.head_field')));
      if (row.hasBaseline) {
        grid.append(el('span', 'unsaved-hd', t('unsaved.col_before')), el('span', 'unsaved-hd'), el('span', 'unsaved-hd', t('unsaved.col_after')));
      } else grid.appendChild(el('span', 'unsaved-hd', t('unsaved.head_current')));
      for (const f of row.fields) {
        grid.appendChild(el('span', 'unsaved-lab', fieldLabel(f.key)));
        if (row.hasBaseline) {
          grid.append(el('span', 'unsaved-val old', formatValue(f, f.before)), el('span', 'unsaved-arr', '→'), el('span', 'unsaved-val', formatValue(f, f.after)));
        } else grid.appendChild(el('span', 'unsaved-val', formatValue(f, f.after)));
      }
      wrap.appendChild(grid);
    }
    const meta = el('div', 'unsaved-dmeta');
    const mat = el('span', 'unsaved-src');
    mat.append(el('i', undefined, t('unsaved.lab_material')), el('span', 'unsaved-val', row.material), el('span', undefined, row.materialDescription ? ` · ${row.materialDescription}` : ''));
    const src = el('span', 'unsaved-src');
    src.append(el('i', undefined, t('unsaved.lab_source')), el('span', undefined, sourceText(row)));
    meta.append(mat, src);
    const note = moveNoteText(row);
    if (note) meta.appendChild(el('span', 'unsaved-enote', note));
    if (row.status === 'nochange') meta.appendChild(el('span', 'unsaved-stale', t('unsaved.nochange_note')));
    if (row.status === 'noref') meta.appendChild(el('span', 'unsaved-stale', t('unsaved.noref_note')));
    const go = el('button', 'btn sm', t('unsaved.show_gantt')); go.setAttribute('type', 'button');
    go.addEventListener('click', () => UnsavedDialog.showOnGantt(row.id));
    meta.appendChild(go);
    wrap.appendChild(meta);
    return wrap;
  },

  /** Close, select the order and centre the Gantt on it; an order with no dates (or line) selects and opens the Orders table. */
  showOnGantt(id: string): void {
    UnsavedDialog.close();
    const task = Store.tasks[id];
    if (!task) return;
    Selection.set([id]);
    if (task.start_date && task.end_date && task.MACHINE) {
      Timeline.gotoLineDay(String(task.MACHINE), Util.dayKey(task.start_date), undefined, { taskId: id });
    } else {
      (globalThis as { NIMBUS?: { App?: { gotoGanttSub?(sub: string): void } } }).NIMBUS?.App?.gotoGanttSub?.('orders');
    }
  },

  /** Wire the badge once (application-shell). */
  init(): void {
    const badge = document.getElementById('schedule-unsaved');
    if (!badge || (badge as HTMLElement & { _unsavedWired?: boolean })._unsavedWired) return;
    (badge as HTMLElement & { _unsavedWired?: boolean })._unsavedWired = true;
    badge.addEventListener('click', () => UnsavedDialog.open());
  },
};
