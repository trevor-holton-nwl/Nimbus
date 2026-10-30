// admin-ops/unified-log-pane.mts — the Admin Logs sub-tab: one merged timeline over every log source plus a
// context rail ("Related") that fills when a row is selected. Data model and join logic live in
// unified-log.mts (pure); this file owns the fetches, the filter bar, persistence and the DOM.
//
// Lifecycle (the JobsAdmin shape): AdminCockpit._setSub('logs') calls init() once, render() on every entry and
// setActive(true); leaving the sub-tab calls setActive(false). The 30 s poll runs only while active and the
// document is visible. Text is always written with textContent (log text is untrusted).
//
// Caps: each read is bounded server-side (200 backend/audit, 100 events, 50 runs); the merged set is capped at
// MERGE_LIMIT = 2000 newest entries, and the list renders SHOW_FIRST = 500 rows, growing by SHOW_STEP = 200 per
// "Show more" up to the merged set.

import { Util, Toast, ErrorLog } from '../platform/foundation.mjs';
import { Store } from '../platform/store.mjs';
import { Session } from '../security/session.mjs';
import { JobsClient } from './jobs-client.mjs';
import { mkCombobox, allowedPlantList } from './jobs-dialog.mjs';
import {
  fromAudit, fromBackend, fromFrontend, fromJobRun, fromSapRun, fromScheduleEvent, fromUpload,
  filterEntries, mergeEntries, relatedTo, sourceCounts,
} from './unified-log.mjs';
import type {
  UnifiedEntry, LogFilter, LogSource, LogLevel, RelatedGroup, BackendLogEntry, LogEntry,
  AdminAuditLogItem, AdminUploadAuditItem, RecentScheduleEvent, SapInterfaceRun,
} from './unified-log.mjs';

const STORAGE_KEY = 'nimbus.ulog.filter';
const POLL_MS = 30_000;
const SHOW_FIRST = 500;
const SHOW_STEP = 200;
const MERGE_LIMIT = 2000;
const REL_CAP = 10;
const ALL_SOURCES: LogSource[] = ['backend', 'frontend', 'audit', 'upload', 'jobs', 'events', 'sap'];
const LEVELS = ['all', 'error', 'warn', 'info'];
const EXACT_KEYS = ['actionId', 'orderId', 'runId'] as const;
const EXACT_WHY = { actionId: 'ulog.rel_action', orderId: 'ulog.rel_order', runId: 'ulog.rel_run' } as const;

type AdminFetch = <T>(path: string, timeoutMs: number, signal?: AbortSignal) => Promise<T>;

const _defaultFilter = (): LogFilter => ({ level: 'all', sources: new Set<LogSource>(), user: '', plant: '', q: '' });

let _initialized = false;
let _active = false;
let _entries: UnifiedEntry[] = [];
let _bySource: Partial<Record<LogSource, UnifiedEntry[]>> = {};
let _filter: LogFilter = _defaultFilter();
let _selectedKey: string | null = null;
let _expanded = new Set<string>();
let _relAll = new Set<string>();
let _shown = SHOW_FIRST;
let _seq = 0;
let _ctl: AbortController | null = null;
let _poll: ReturnType<typeof setInterval> | null = null;
let _qTimer: ReturnType<typeof setTimeout> | null = null;
let _notices = new Map<LogSource, string>();
let _eventsHidden = false;
let _eventsPlant = '';
let _loaded = false;
let _rowEls = new Map<string, HTMLElement>();

const _el = (id: string): HTMLElement | null => (typeof document === 'undefined' ? null : document.getElementById(id));
const _t = (k: string, a?: Record<string, unknown>): string => Util.t(k, a as Record<string, string | number> | undefined);

function _mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/* ---------------------------------------------------------------------------
   Filter state + persistence
   ------------------------------------------------------------------------- */
function _effFilter(): LogFilter {
  // A source the server cannot serve (events route 404) is not a real filter choice.
  if (!_eventsHidden || !_filter.sources.has('events')) return _filter;
  const s = new Set(_filter.sources); s.delete('events');
  return { ..._filter, sources: s };
}

function _save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ..._filter, sources: [..._filter.sources] }));
  } catch { /* storage blocked: the filter just does not persist */ }
}

function _restore(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const o = JSON.parse(raw) as Partial<Record<keyof LogFilter, unknown>>;
    const f = _defaultFilter();
    if (typeof o.level === 'string' && LEVELS.includes(o.level)) f.level = o.level as LogFilter['level'];
    if (Array.isArray(o.sources)) f.sources = new Set(o.sources.filter((s): s is LogSource => ALL_SOURCES.includes(s as LogSource)));
    if (typeof o.user === 'string') f.user = o.user;
    if (typeof o.plant === 'string') f.plant = o.plant;
    if (typeof o.q === 'string') f.q = o.q;
    for (const k of EXACT_KEYS) if (typeof o[k] === 'string' && o[k]) f[k] = o[k] as string;
    _filter = f;
  } catch { /* unreadable or blocked: keep the defaults */ }
}

const _fetchPlant = (): string => _filter.plant || Store.selectedPlant || '';

function _apply(p: Partial<LogFilter>, syncControls: boolean): void {
  const before = _fetchPlant();
  _filter = { ..._filter, ...p, sources: p.sources ? new Set(p.sources) : _filter.sources };
  _shown = SHOW_FIRST;
  _save();
  if (syncControls) _syncControls();
  _paint();
  if (_fetchPlant() !== before) void render();
}

/* ---------------------------------------------------------------------------
   Fetch
   ------------------------------------------------------------------------- */
const _msg = (e: unknown): string => (e as Error | null)?.message ?? String(e);

async function render(): Promise<void> {
  const seq = ++_seq;
  _ctl?.abort();
  const ctl = new AbortController();
  _ctl = ctl;
  const plant = _fetchPlant();
  _eventsPlant = plant;
  let fetchJson: AdminFetch;
  try {
    const { AdminCockpit } = await import('./admin-ui.mjs');
    fetchJson = (p, ms, s) => AdminCockpit._fetchJson(p, ms, s);
  } catch (e) {
    _notices.set('backend', _msg(e)); _paint(); return;
  }
  const get = <T,>(p: string): Promise<T> => fetchJson<T>(p, 10_000, ctl.signal);
  const jobs: Array<[LogSource, Promise<UnifiedEntry[]>]> = [
    ['backend', get<{ entries?: BackendLogEntry[] }>('/logs/backend?limit=200').then(r => (r.entries ?? []).map(fromBackend))],
    ['frontend', Promise.resolve().then(() => (ErrorLog.entries() as unknown as LogEntry[]).map(fromFrontend))],
    ['audit', get<{ entries?: AdminAuditLogItem[] }>('/audit/log?limit=200').then(r => (r.entries ?? []).map(fromAudit))],
    ['upload', get<{ audit?: AdminUploadAuditItem[] }>('/upload/audit').then(r => (r.audit ?? []).map(fromUpload))],
    ['jobs', JobsClient.runs({ plant, limit: 50 }).then(r => r.items.map(fromJobRun))],
  ];
  if (Session.isAdmin()) {
    jobs.push(['sap', get<{ runs?: SapInterfaceRun[] }>('/sap/interface/runs?limit=50').then(r => (r.runs ?? []).map(fromSapRun))]);
  }
  if (plant) {
    jobs.push(['events', get<{ events?: RecentScheduleEvent[] }>(`/schedule-events/${encodeURIComponent(plant)}/recent?limit=100`)
      .then(r => (r.events ?? []).map(e => fromScheduleEvent(e, plant)))]);
  }
  const settled = await Promise.allSettled(jobs.map(j => j[1]));
  if (seq !== _seq) return;   // a newer render superseded this one
  _loaded = true;
  settled.forEach((res, i) => {
    const src = jobs[i][0];
    if (res.status === 'fulfilled') {
      _bySource[src] = res.value; _notices.delete(src);
      if (src === 'events') _eventsHidden = false;
      return;
    }
    const m = _msg(res.reason);
    if (src === 'events' && /not_found|HTTP 404/.test(m)) { _eventsHidden = true; _bySource.events = []; _notices.delete('events'); return; }
    if ((res.reason as { name?: string } | null)?.name === 'AbortError') return;
    _notices.set(src, m);
  });
  if (!plant) { _bySource.events = []; _eventsHidden = false; }
  if (!Session.isAdmin()) delete _bySource.sap;
  _entries = mergeEntries(Object.values(_bySource) as UnifiedEntry[][], MERGE_LIMIT);
  if (_selectedKey && !_entries.some(e => e.key === _selectedKey)) _selectedKey = null;
  _paint();
}

/* ---------------------------------------------------------------------------
   Controls
   ------------------------------------------------------------------------- */
function _checkboxes(): HTMLInputElement[] {
  const host = _el('ulog-sources');
  return host ? Array.from(host.querySelectorAll<HTMLInputElement>('input[data-src]')) : [];
}

function _syncControls(): void {
  const lvl = _el('ulog-level') as HTMLSelectElement | null; if (lvl) lvl.value = _filter.level;
  const u = _el('ulog-user') as HTMLInputElement | null; if (u) u.value = _filter.user;
  const q = _el('ulog-q') as HTMLInputElement | null; if (q) q.value = _filter.q;
  for (const cb of _checkboxes()) cb.checked = _filter.sources.has(cb.dataset.src as LogSource);
  _mountPlant();
}

function _mountPlant(): void {
  const host = _el('ulog-plant');
  if (!host) return;
  mkCombobox(host, allowedPlantList(), {
    id: 'ulog-plant-input', value: _filter.plant, placeholder: _t('ph.filter_plant'),
    onSelect: v => _apply({ plant: v }, false),
  });
  host.title = _t('ulog.plant_hint');
}

function _bind(): void {
  _el('ulog-refresh')?.addEventListener('click', () => { void render(); });
  _el('ulog-level')?.addEventListener('change', (e: Event) => {
    _apply({ level: (e.target as HTMLSelectElement).value as LogFilter['level'] }, false);
  });
  _el('ulog-user')?.addEventListener('input', (e: Event) => { _apply({ user: (e.target as HTMLInputElement).value.trim() }, false); });
  _el('ulog-q')?.addEventListener('input', (e: Event) => {
    const v = (e.target as HTMLInputElement).value;
    if (_qTimer) clearTimeout(_qTimer);
    _qTimer = setTimeout(() => { _qTimer = null; _apply({ q: v }, false); }, 250);
  });
  for (const cb of _checkboxes()) {
    cb.addEventListener('change', () => {
      const s = new Set(_filter.sources);
      if (cb.checked) s.add(cb.dataset.src as LogSource); else s.delete(cb.dataset.src as LogSource);
      _apply({ sources: s }, false);
    });
  }
  _el('ulog-sources-all')?.addEventListener('click', () => _apply({ sources: new Set(ALL_SOURCES) }, true));
  _el('ulog-sources-none')?.addEventListener('click', () => _apply({ sources: new Set() }, true));
}

/* ---------------------------------------------------------------------------
   Paint: counts, notices, note, list, rail
   ------------------------------------------------------------------------- */
function _filtered(): UnifiedEntry[] { return filterEntries(_entries, _effFilter()); }

function _paintSources(): void {
  const counts = sourceCounts(_entries, _effFilter());
  for (const cb of _checkboxes()) {
    const src = cb.dataset.src as LogSource;
    const label = cb.parentElement as HTMLElement | null;
    if (label) label.hidden = src === 'events' && _eventsHidden;
    const c = label?.querySelector('.ulog-count');
    if (c) c.textContent = String(counts[src] ?? 0);
  }
}

function _paintNotices(): void {
  const host = _el('ulog-notices');
  if (!host) return;
  host.textContent = '';
  for (const [src, m] of _notices) {
    host.appendChild(_mk('span', 'ulog-notice', _t('ulog.source_failed', { source: _t(`ulog.src_${src}`), msg: m })));
  }
  host.hidden = _notices.size === 0;
}

function _paintNote(total: number): void {
  const note = _el('ulog-note');
  if (!note) return;
  const parts = [_t('ulog.showing', { shown: Math.min(_shown, total), total })];
  if (!_eventsHidden && _eventsPlant) parts.push(_t('ulog.events_for_plant', { plant: _eventsPlant }));
  note.textContent = parts.join(' · ');
  for (const k of EXACT_KEYS) {
    const v = _filter[k];
    if (!v) continue;
    const chip = _mk('button', 'btn btn-ghost sm ulog-exact-chip', `${_t(EXACT_WHY[k], { rid: v, id: v, order: v })} ×`);
    chip.type = 'button'; chip.title = _t('ulog.clear_exact'); chip.setAttribute('data-exact-chip', k);
    chip.addEventListener('click', () => setFilter({ [k]: '' }));
    note.appendChild(chip);
  }
}

function _fmtTs(e: UnifiedEntry): string { return e.ts ? Util.fmtDTPref(e.ts) || e.ts : ''; }

function _chip(cls: string, text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = _mk('button', cls, text);
  b.type = 'button'; b.title = title;
  b.addEventListener('click', (ev: Event) => { ev.stopPropagation(); onClick(); });
  return b;
}

function _buildRow(e: UnifiedEntry): HTMLElement {
  const row = _mk('div', `admin-log-row admin-log-${e.level} ulog-row`);
  row.dataset.key = e.key;
  row.setAttribute('tabindex', '0');
  row.setAttribute('role', 'listitem');
  if (e.key === _selectedKey) row.classList.add('is-selected');
  const head = _mk('div', 'admin-log-head ulog-head');
  head.appendChild(_mk('span', 'admin-log-lvl', e.level));
  head.appendChild(_mk('span', 'ulog-src', _t(`ulog.src_${e.source}`)));
  const ts = _mk('span', 'admin-log-ts', _fmtTs(e)); ts.title = e.ts ?? '';
  head.appendChild(ts);
  if (e.user) head.appendChild(_mk('span', 'ulog-user', e.user));
  if (e.plant) head.appendChild(_mk('span', 'ulog-plant', e.plant));
  if (e.rid) head.appendChild(_chip('admin-log-reqid', e.rid, _t('ulog.correlate', { rid: e.rid }), () => setFilter({ q: e.rid as string })));
  if (e.errorCode) head.appendChild(_chip('admin-log-code', e.errorCode, _t('ulog.filter_by_code'), () => setFilter({ q: e.errorCode as string })));
  head.appendChild(_mk('span', 'spacer'));
  const open = _expanded.has(e.key);
  const chev = _mk('button', 'ulog-chevron', open ? '▾' : '▸');
  chev.type = 'button';
  chev.setAttribute('aria-expanded', open ? 'true' : 'false');
  chev.addEventListener('click', (ev: Event) => {
    ev.stopPropagation();
    if (_expanded.has(e.key)) _expanded.delete(e.key); else _expanded.add(e.key);
    _paintList();
  });
  head.appendChild(chev);
  row.appendChild(head);
  row.appendChild(_mk('div', 'admin-log-msg', e.text));
  if (open) row.appendChild(_mk('pre', 'admin-log-ctx ulog-raw', _json(e.raw)));
  row.addEventListener('click', () => select(e.key));
  row.addEventListener('keydown', (ev: KeyboardEvent) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === row) { ev.preventDefault(); select(e.key); }
  });
  return row;
}

function _json(v: unknown): string {
  try { return JSON.stringify(v, null, 2) ?? ''; } catch { return String(v); }
}

function _paintList(): void {
  const list = _el('ulog-list');
  if (!list) return;
  const keep = list.scrollTop;
  list.textContent = '';
  _rowEls = new Map();
  const all = _filtered();
  _paintNote(all.length);
  if (!_loaded) { list.appendChild(_mk('div', 'admin-log-empty', _t('ui.loading'))); return; }
  if (!all.length) { list.appendChild(_mk('div', 'admin-log-empty', _t('ulog.empty'))); return; }
  for (const e of all.slice(0, _shown)) { const r = _buildRow(e); _rowEls.set(e.key, r); list.appendChild(r); }
  if (all.length > _shown) {
    const more = _mk('button', 'btn btn-ghost sm ulog-more', _t('ulog.show_more', { n: Math.min(SHOW_STEP, all.length - _shown) }));
    more.type = 'button';
    more.addEventListener('click', () => { _shown += SHOW_STEP; _paintList(); });
    list.appendChild(more);
  }
  list.scrollTop = keep;
}

function _paint(): void {
  _paintSources();
  _paintNotices();
  _paintList();
  _paintRail();
}

/* ---------------------------------------------------------------------------
   Rail
   ------------------------------------------------------------------------- */
function _filterToGroup(g: RelatedGroup): void {
  if (g.kind === 'user_window') setFilter({ user: g.key });
  else if (g.kind === 'action') setFilter({ actionId: g.key });
  else if (g.kind === 'order') setFilter({ orderId: g.key });
  else if (g.kind === 'run') setFilter({ runId: g.key });
  else setFilter({ q: g.key });
}

function _copyText(text: string, pre: HTMLElement): void {
  const fallback = (): void => {
    try {
      const r = document.createRange(); r.selectNodeContents(pre);
      const s = window.getSelection?.(); s?.removeAllRanges(); s?.addRange(r);
    } catch { /* no selection API */ }
    Toast.show(_t('toast.copy_failed'), 'error');
  };
  try {
    const w = navigator.clipboard?.writeText(text);
    if (!w) { fallback(); return; }
    w.then(() => Toast.show(_t('toast.copied_filtered', { count: 1 }), 'success'), fallback);
  } catch { fallback(); }
}

function _paintRail(): void {
  const body = _el('ulog-rail-body');
  if (!body) return;
  body.textContent = '';
  const sel = _selectedKey ? _entries.find(e => e.key === _selectedKey) : undefined;
  if (!sel) { body.appendChild(_mk('div', 'admin-log-empty ulog-rail-empty', _t('ulog.related_empty'))); return; }
  body.appendChild(_mk('div', `admin-log-msg ulog-rail-sel admin-log-${sel.level}`, sel.text));
  for (const g of relatedTo(sel, _entries)) {
    const det = _mk('details', `ulog-group${g.possible ? ' ulog-possible' : ''}`);
    det.dataset.kind = g.kind;
    det.setAttribute('open', '');
    const sum = _mk('summary', 'ulog-group-sum');
    sum.appendChild(_mk('span', 'ulog-group-why', _t(g.whyKey, { rid: g.key, id: g.key, order: g.key })));
    if (g.kind === 'user_window') sum.appendChild(_mk('span', 'ulog-group-key', g.key));
    sum.appendChild(_mk('span', 'ulog-count', String(g.entries.length)));
    det.appendChild(sum);
    const all = _relAll.has(g.kind);
    for (const e of (all ? g.entries : g.entries.slice(0, REL_CAP))) {
      const b = _mk('button', `ulog-rel-row admin-log-${e.level}`);
      b.type = 'button';
      b.dataset.key = e.key;
      b.appendChild(_mk('span', 'ulog-src', _t(`ulog.src_${e.source}`)));
      b.appendChild(_mk('span', 'admin-log-ts', _fmtTs(e)));
      b.appendChild(_mk('span', 'ulog-rel-text', e.text));
      b.addEventListener('click', () => select(e.key));
      det.appendChild(b);
    }
    if (!all && g.entries.length > REL_CAP) {
      const more = _mk('button', 'btn btn-ghost sm ulog-more', _t('ulog.show_more', { n: g.entries.length - REL_CAP }));
      more.type = 'button';
      more.addEventListener('click', () => { _relAll.add(g.kind); _paintRail(); });
      det.appendChild(more);
    }
    const f = _mk('button', 'btn btn-ghost sm', _t('ulog.filter_to_this'));
    f.type = 'button';
    f.setAttribute('data-rail-filter', g.kind);
    f.addEventListener('click', () => _filterToGroup(g));
    det.appendChild(f);
    body.appendChild(det);
  }
  const raw = _mk('pre', 'ulog-raw', _json(sel.raw));
  const copy = _mk('button', 'btn btn-ghost sm', _t('btn.copy_json'));
  copy.type = 'button';
  copy.addEventListener('click', () => _copyText(raw.textContent ?? '', raw));
  body.appendChild(raw);
  body.appendChild(copy);
}

function select(key: string | null): void {
  if (key === _selectedKey) return;
  _rowEls.get(_selectedKey ?? '')?.classList.remove('is-selected');
  _selectedKey = key;
  _rowEls.get(key ?? '')?.classList.add('is-selected');
  _relAll = new Set();
  _paintRail();
}

/* ---------------------------------------------------------------------------
   Public API
   ------------------------------------------------------------------------- */
function setFilter(partial: Partial<LogFilter>): void { _apply(partial, true); }

function setActive(on: boolean): void {
  _active = on;
  if (_poll) { clearInterval(_poll); _poll = null; }
  if (!on) { _ctl?.abort(); return; }
  _poll = setInterval(() => {
    if (!_active || typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    const tab = document.getElementById('admin-tab');   // the Admin main tab itself must be showing
    if (tab && !tab.classList.contains('active')) return;
    void render();
  }, POLL_MS);
}

function init(): void {
  if (_initialized) return;
  _initialized = true;
  _restore();
  _syncControls();
  _bind();
}

export const UnifiedLogPane = {
  init,
  render,
  setActive,
  setFilter,
  select,
  /** Re-read this browser's ErrorLog ring only (the ErrorLog.subscribe hook): no network. */
  refreshFrontend(): void {
    _bySource.frontend = (ErrorLog.entries() as unknown as LogEntry[]).map(fromFrontend);
    _entries = mergeEntries(Object.values(_bySource) as UnifiedEntry[][], MERGE_LIMIT);
    if (_loaded) _paint();
  },
  /** The list as the planner sees it (every filter applied): what Copy filtered copies. */
  filteredEntries(): UnifiedEntry[] { return _filtered(); },
  _state(): { entries: UnifiedEntry[]; filter: LogFilter; notices: string[]; selectedKey: string | null; polling: boolean; eventsHidden: boolean; shown: number } {
    return {
      entries: _entries, filter: _filter, notices: [..._notices].map(([s, m]) => `${s}: ${m}`),
      selectedKey: _selectedKey, polling: _poll !== null, eventsHidden: _eventsHidden, shown: _shown,
    };
  },
  /** Test seam: back to a clean module state. */
  _reset(): void {
    if (_poll) clearInterval(_poll);
    if (_qTimer) clearTimeout(_qTimer);
    _ctl?.abort();
    _initialized = false; _active = false; _entries = []; _bySource = {}; _filter = _defaultFilter(); _selectedKey = null;
    _expanded = new Set(); _relAll = new Set(); _shown = SHOW_FIRST; _seq++; _ctl = null; _poll = null; _qTimer = null;
    _notices = new Map(); _eventsHidden = false; _eventsPlant = ''; _loaded = false; _rowEls = new Map();
  },
};

export type { LogLevel };
